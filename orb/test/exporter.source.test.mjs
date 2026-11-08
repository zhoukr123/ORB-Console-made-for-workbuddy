/* buildSource 单测：一段文本 → 全部格式各自的源结构（含 Office 三件套）。
 * 重点覆盖「会静默出错」的地方：引号内换行、重名表头、列比表头多、
 * 时间码缺失（必须报错而不是编时间）。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSource, createExporter, CSV_BOM } from "../exporter.mjs";
import { FORMATS } from "../outputProfile.mjs";

/* 每种格式都喂它**能解释**的内容（vtt/lrc 必须带时间码，这是硬要求不是巧合）。 */
const SAMPLE = {
  md: "正文", vtt: "00:01.0 一句", lrc: "00:01.0 一句", txt: "正文",
  csv: "a,b\n1,2\n", tsv: "a\tb\n1\t2\n", html: "<b>x</b>",
  pdf: "<b>x</b>", zip: "正文", db: "a\n1\n",
  docx: "# 标题\n正文", xlsx: "名称,数量\n中文,1\n", pptx: "第一页\n要点甲\n\n第二页\n要点乙",
};

test("全部格式都有对应的解释规则，没有漏网的", () => {
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...FORMATS].sort(), "样本必须覆盖全部格式");
  for (const f of FORMATS) {
    const r = buildSource(SAMPLE[f], { format: f, title: "t" });
    assert.equal(r.ok, true, `${f} 应当能解释：${r.error || ""}`);
    assert.ok("source" in r, `${f} 应当给出 source`);
  }
});

test("未知格式与空内容如实报错", () => {
  assert.equal(buildSource("x", { format: "bogus" }).ok, false);
  assert.match(buildSource("x", { format: "bogus" }).error, /不支持/);
  assert.equal(buildSource("   \n\t ", { format: "txt" }).ok, false);
  assert.match(buildSource("", { format: "txt" }).error, /没有可导出/);
});

test("docx 拿到 {title, body}，xlsx 拿到二维表，pptx 空行分页", () => {
  assert.deepEqual(buildSource("# 标题\n正文", { format: "docx", title: "周报" }).source,
    { title: "周报", body: "# 标题\n正文" });
  assert.deepEqual(buildSource("a,b\n1,2\n", { format: "xlsx" }).source,
    [["a", "b"], ["1", "2"]]);
  const p = buildSource("第一页\n要点甲\n\n第二页\n要点乙", { format: "pptx", title: "T" });
  assert.equal(p.ok, true);
  assert.equal(p.source.title, "T");
  assert.equal(p.source.slides.length, 2);
  assert.deepEqual(p.source.slides[0], { title: "第一页", bullets: ["要点甲"] });
  assert.deepEqual(p.source.slides[1], { title: "第二页", bullets: ["要点乙"] });
});

test("txt 原样返回，不做任何加工", () => {
  const r = buildSource("第一行\n  第二行  \n", { format: "txt" });
  assert.equal(r.source, "第一行\n  第二行  \n");
});

test("md 包成 title + sections，标题缺省为「导出」", () => {
  const r = buildSource("正文内容", { format: "md", title: "" });
  assert.equal(r.source.title, "导出");
  assert.deepEqual(r.source.sections, [{ heading: "正文", body: "正文内容" }]);
});

test("html 与 pdf 都拿到 {title, body}", () => {
  for (const f of ["html", "pdf"]) {
    const r = buildSource("<b>粗</b>", { format: f, title: "日报" });
    assert.deepEqual(r.source, { title: "日报", body: "<b>粗</b>" });
  }
});

test("csv 自动识别逗号分隔，首行当表头", () => {
  const r = buildSource("name,age\n张三,30\n李四,25\n", { format: "csv" });
  assert.deepEqual(r.source, [{ name: "张三", age: "30" }, { name: "李四", age: "25" }]);
});

test("tsv 自动识别制表符（不按逗号切）", () => {
  const r = buildSource("a\tb\n1,2\t3\n", { format: "tsv" });
  assert.deepEqual(r.source, [{ a: "1,2", b: "3" }]);
});

test("分号分隔也能识别", () => {
  const r = buildSource("x;y\n1;2\n", { format: "csv" });
  assert.deepEqual(r.source, [{ x: "1", y: "2" }]);
});

test("双引号转义与引号内换行/逗号不被切碎", () => {
  const r = buildSource('k,v\n"含,逗号","第一行\n第二行"\n"说 ""引号""","z"\n', { format: "csv" });
  assert.equal(r.source.length, 2);
  assert.equal(r.source[0].k, "含,逗号");
  assert.equal(r.source[0].v, "第一行\n第二行");
  assert.equal(r.source[1].k, '说 "引号"');
});

test("重名表头加序号，列比表头多的按 col{n} 补齐而不是丢掉", () => {
  const r = buildSource("a,a\n1,2\n3,4,5\n", { format: "csv" });
  assert.deepEqual(Object.keys(r.source[0]), ["a", "a(2)"]);
  assert.deepEqual(r.source[1], { a: "3", "a(2)": "4", col3: "5" });
});

test("空表头列按 col{n} 命名", () => {
  const r = buildSource("a,,c\n1,2,3\n", { format: "csv" });
  assert.deepEqual(Object.keys(r.source[0]), ["a", "col2", "c"]);
});

test("只有表头没有数据行 → 报错，不产出空表", () => {
  const r = buildSource("a,b\n", { format: "csv" });
  assert.equal(r.ok, false);
  assert.match(r.error, /没有数据行/);
});

test("vtt 解析 00:01.5 这种简写，并自动用下一段起点补 end", () => {
  const r = buildSource("00:01.5 第一句\n00:05 第二句\n00:09.25 第三句\n", { format: "vtt" });
  assert.equal(r.source.length, 3);
  assert.deepEqual(r.source.map((s) => s.start), [1.5, 5, 9.25]);
  assert.equal(r.source[0].end, 5);           // 下一段起点
  assert.equal(r.source[2].end, 12.25);       // 末段补 3 秒
  assert.equal(r.source[0].text, "第一句");
});

test("vtt 认 00:00:01,500 与 [00:01] 两种写法，也认显式 --> 结束时间", () => {
  const a = buildSource("00:00:01,500 甲\n[00:03] 乙\n", { format: "vtt" });
  assert.deepEqual(a.source.map((s) => s.start), [1.5, 3]);
  const b = buildSource("00:01.0 --> 00:04.0 丙\n", { format: "vtt" });
  assert.equal(b.source[0].end, 4);
});

test("vtt 跳过 WEBVTT 头与纯序号行", () => {
  const r = buildSource("WEBVTT\n\n1\n00:01.0 甲\n2\n00:02.0 乙\n", { format: "vtt" });
  assert.deepEqual(r.source.map((s) => s.text), ["甲", "乙"]);
});

test("lrc 与 vtt 共用同一套时间码解析", () => {
  const r = buildSource("00:02.00 歌词\n", { format: "lrc" });
  assert.equal(r.source[0].start, 2);
  assert.equal(r.source[0].text, "歌词");
});

test("没有时间码时如实报错，绝不编造时间轴", () => {
  const r = buildSource("第一句\n第二句\n", { format: "vtt" });
  assert.equal(r.ok, false);
  assert.match(r.error, /时间码/);
  assert.equal(buildSource("随便一句", { format: "lrc" }).ok, false);
});

test("zip 包成单文件，文件名取标题", () => {
  const r = buildSource("内容", { format: "zip", title: "周报" });
  assert.deepEqual(r.source, [{ name: "周报.md", content: "内容" }]);
});

test("db 与 csv 共用表格解释，拿到的是行数组", () => {
  const r = buildSource("id,v\n1,a\n", { format: "db" });
  assert.deepEqual(r.source, [{ id: "1", v: "a" }]);
});

test("CRLF 文本不会多出空行，也不会把 \\r 带进单元格", () => {
  const r = buildSource("a,b\r\n1,2\r\n", { format: "csv" });
  assert.equal(r.source.length, 1);
  assert.equal(r.source[0].b, "2");
});

test("落盘的 csv/tsv 带 BOM（Excel 开中文不乱码），toCsv 本身仍不带", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-bom-"));
  const ex = createExporter({ now: () => 1700000000000 });
  try {
    assert.notEqual(ex.toCsv([{ a: "中" }])[0], CSV_BOM, "纯函数层不加 BOM");
    for (const fmt of ["csv", "tsv"]) {
      const built = buildSource("名称,数量\n中文,1\n", { format: fmt, title: "bom" });
      assert.equal(built.ok, true);
      const out = path.join(dir, `bom.${fmt}`);
      const r = await ex.run({ format: fmt, source: built.source, outPath: out });
      assert.equal(r.ok, true, r.error);
      const text = fs.readFileSync(out, "utf8");
      assert.equal(text[0], CSV_BOM, `${fmt} 落盘文件应以 BOM 开头`);
      assert.ok(text.includes("中文"), `${fmt} 中文没丢`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
