/* I-11 mark_as_temp 与 I-15 导出段串联：exporter.mjs 新增能力的单测。
 * 运行：node --test orb/test/markTempExport.test.mjs
 * 只测 exporter.mjs（不碰 bridge/pack/其它 test），全部为纯函数/静态断言，不写磁盘。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildSource, createExporter,
  EXPORT_SECTIONS, sectionToggle, markTempDisposition, evidenceSection,
} from "../exporter.mjs";
import { FORMATS } from "../outputProfile.mjs";

/* 同一段文本含 | / 换行 / 反引号，但不含 , \t ; —— 便于 csv 原样读回比对。 */
const TEXT = "表头|含反引号`代码`\n第二行|管道|符";

/* ---------- 1. md 正文转义 vs csv 不受影响 ---------- */
test("md 正文的 | / 换行 / 反引号被转义，csv 原样保留（同一段文本两种 buildSource 比对）", () => {
  const md = buildSource(TEXT, { format: "md", title: "T" });
  const csv = buildSource(TEXT, { format: "csv", title: "T" });
  assert.equal(md.ok, true, md.error || "");
  assert.equal(csv.ok, true, csv.error || "");

  const mdBody = md.source.sections[0].body;
  assert.ok(mdBody.includes("\\|"), "管道符应被转义为 \\|");
  assert.ok(mdBody.includes("\\`"), "反引号应被转义");
  assert.ok(!mdBody.includes("\n"), "换行不应以裸换行进入 md 正文");
  assert.ok(!mdBody.includes("\r"), "不应残留 CR");

  const csvText = JSON.stringify(csv.source);
  assert.ok(csvText.includes("|"), "csv 里管道符仍是原字符");
  assert.ok(csvText.includes("`"), "csv 里反引号仍是原字符");
  assert.ok(!csvText.includes("\\|"), "csv 不该出现 md 的管道转义");
  assert.ok(!csvText.includes("\\`"), "csv 不该出现 md 的反引号转义");

  // 真正渲染出的 markdown 也带转义，转义发生在正文而非渲染后补刀
  const rendered = createExporter().toMarkdown(md.source);
  assert.ok(rendered.includes("\\|"), "落盘的 md 正文应带转义后的管道符");
});

/* ---------- 2. 命名段：冻结 + 开关 ---------- */
test("EXPORT_SECTIONS 冻结、含 report/evidence/skill 三段且各带说明", () => {
  assert.ok(Object.isFrozen(EXPORT_SECTIONS), "登记表必须冻结");
  for (const name of ["report", "evidence", "skill"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(EXPORT_SECTIONS, name), `缺段 ${name}`);
    const def = EXPORT_SECTIONS[name];
    assert.equal(typeof def.description, "string");
    assert.ok(def.description.length > 0, `${name} 必须有说明`);
    assert.ok(Object.isFrozen(def), `${name} 段定义也应冻结`);
  }
});

test("sectionToggle 按名字开关：纯函数、返回冻结状态、不改入参", () => {
  const all = sectionToggle();
  assert.deepEqual({ ...all }, { report: true, evidence: true, skill: true });
  assert.ok(Object.isFrozen(all));

  const off = sectionToggle(null, { report: false, skill: false });
  assert.equal(off.report, false);
  assert.equal(off.evidence, true);
  assert.equal(off.skill, false);

  const flipped = sectionToggle(off, "evidence");
  assert.equal(flipped.evidence, false, "字符串按名字翻转");
  assert.equal(off.evidence, true, "入参状态不可被修改");

  const byArray = sectionToggle(["report", "skill"]);
  assert.equal(byArray.report, false);
  assert.equal(byArray.skill, false);
  assert.equal(byArray.evidence, true);

  const unknown = sectionToggle({ bogus: false });
  assert.deepEqual({ ...unknown }, { report: true, evidence: true, skill: true }, "未知段名忽略");
});

test("buildSource 的命名段字段是可选的：缺省逐键不变，opt-in 才追加", () => {
  const plain = buildSource("正文内容", { format: "md", title: "" });
  assert.deepEqual(Object.keys(plain.source), ["title", "sections"], "缺省不附带任何新字段");
  assert.deepEqual(plain.source.sections, [{ heading: "正文", body: "正文内容" }]);

  const opt = buildSource("正文内容", { format: "md", title: "", namedSections: true });
  assert.ok(Object.prototype.hasOwnProperty.call(opt.source, "availableSections"));
  assert.ok(opt.source.availableSections.includes("evidence"));
  assert.deepEqual({ ...opt.source.sectionsEnabled }, { report: true, evidence: true, skill: true });
  assert.equal(opt.source.title, "导出", "旧键仍在且不变");
  assert.deepEqual(opt.source.sections, [{ heading: "正文", body: "正文内容" }], "旧键仍在且不变");

  const viaToggle = buildSource("正文内容", {
    format: "md", title: "", sections: sectionToggle(null, { evidence: false }),
  });
  assert.equal(viaToggle.source.sectionsEnabled.evidence, false);
});

/* ---------- 3. 既有 13 种格式 smoke + 形状不被破坏 ---------- */
const SAMPLE = {
  md: "正文", vtt: "00:01.0 一句", lrc: "00:01.0 一句", txt: "正文",
  csv: "a,b\n1,2\n", tsv: "a\tb\n1\t2\n", html: "<b>x</b>",
  pdf: "<b>x</b>", zip: "正文", db: "a\n1\n",
  docx: "# 标题\n正文", xlsx: "名称,数量\n中文,1\n", pptx: "第一页\n要点甲\n\n第二页\n要点乙",
};

test("buildSource 原有 13 种格式仍全部 ok:true，新增字段不破坏原有形状", () => {
  assert.equal(FORMATS.length, 13);
  assert.deepEqual(Object.keys(SAMPLE).sort(), [...FORMATS].sort(), "样本覆盖全部格式");
  for (const f of FORMATS) {
    const r = buildSource(SAMPLE[f], { format: f, title: "t" });
    assert.equal(r.ok, true, `${f} 应能解释：${r.error || ""}`);
    assert.ok("source" in r, `${f} 应给出 source`);
  }
  // 抽查几个被既有测试 deepEqual 锁死的形状，确认未被新字段污染
  assert.deepEqual(buildSource("# 标题\n正文", { format: "docx", title: "周报" }).source,
    { title: "周报", body: "# 标题\n正文" });
  assert.deepEqual(buildSource("<b>粗</b>", { format: "html", title: "日报" }).source,
    { title: "日报", body: "<b>粗</b>" });
  assert.deepEqual(buildSource("a,b\n1,2\n", { format: "xlsx" }).source,
    [["a", "b"], ["1", "2"]]);
  assert.deepEqual(buildSource("内容", { format: "zip", title: "周报" }).source,
    [{ name: "周报.md", content: "内容" }]);
});

/* ---------- 4. markTempDisposition ---------- */
test("markTempDisposition：temp=true 拒持久化并记拒因，temp=false 允许持久化", () => {
  const hot = markTempDisposition({ record: { text: "不该被回传" }, temp: true });
  assert.equal(hot.persist, false);
  assert.equal(hot.disposition, "discard");
  assert.equal(typeof hot.reason, "string");
  assert.ok(hot.reason.length > 0, "必须带一条拒因");
  assert.ok("at" in hot);
  assert.ok(!JSON.stringify(hot).includes("不该被回传"), "不得回传 record 内容");

  const keep = markTempDisposition({ temp: false });
  assert.equal(keep.persist, true);
  assert.equal(keep.disposition, "persist");

  const custom = markTempDisposition({ temp: true, reason: "R1", at: 123 });
  assert.equal(custom.reason, "R1");
  assert.equal(custom.at, 123);
  assert.deepEqual(Object.keys(custom).sort(), ["at", "disposition", "persist", "reason"]);
});

/* ---------- 5. evidenceSection ---------- */
test("evidenceSection：UNVERIFIED: 与 trust!==trusted 单列，绝不提升为结论", () => {
  const a = evidenceSection("UNVERIFIED: 网页说 X");
  assert.equal(a.name, "evidence");
  assert.equal(typeof a.heading, "string");
  assert.equal(typeof a.body, "string");
  assert.ok(a.body.includes("[DATA]"), "内容只作数据，不作结论");
  assert.equal(a.trusted, false);
  assert.equal(a.conclusion, null, "绝不产出结论");
  assert.equal(a.unverified.length, 1);
  assert.match(a.unverified[0].text, /UNVERIFIED:/);
  assert.equal(a.unverified[0].dataOnly, true);

  const b = evidenceSection("来自 OCR 的台词", { trust: "ocr" });
  assert.equal(b.unverified.length, 1, "trust!==trusted 也要单列");
  assert.equal(b.conclusion, null);

  const c = evidenceSection("普通内容", { trust: "trusted" });
  assert.equal(c.unverified.length, 0);
  assert.equal(c.conclusion, null, "即便 trusted 也不提升为结论");
  assert.equal(c.trusted, false);

  const d = evidenceSection("UNVERIFIED: 甲\n普通乙\nUNVERIFIED: 丙", { trust: "trusted" });
  assert.equal(d.unverified.length, 2, "多行里只把 UNVERIFIED: 前缀行单列");
  assert.ok(!d.body.includes("结论："), "正文不写成结论句");
});

/* ---------- 6. 静态断言 ----------
 * 注意：exporter.mjs 本就有「原子落盘」职责（4 处既有 writeFile，属于 run/toZip 等），
 * 本任务不新增任何落盘调用；这里锁定「新增纯函数区段」不含任何写入字样，
 * 并确认全文件没有会话历史写入。断言字符串只在测试文件里拼接，不种进被测源码。 */
test("静态断言：真实 import mdEscape；新增纯函数区无落盘/历史写入字样", () => {
  const src = fs.readFileSync(new URL("../exporter.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("from " + '"./mdEscape.mjs"'), "必须含 from \"./mdEscape.mjs\"");
  assert.match(src, /import\s*\{[^}]*\}\s*from\s*"\.\/mdEscape\.mjs"\s*;/, "必须是真实 import 语句");

  const anchor = src.indexOf("export const EXPORT_SECTIONS");
  assert.ok(anchor > 0, "找得到新增纯函数区段");
  const tail = src.slice(anchor);
  for (const bad of [
    "write" + "File", "write" + "FileSync", "append" + "File",
    "会话" + "历史", "session" + "History",
  ]) {
    assert.ok(!tail.includes(bad), `新增纯函数区不得出现 ${bad}`);
  }
  assert.ok(!src.includes("会话" + "历史"), "全文件不得出现会话历史写入字样");
  // 既有 4 处原子落盘调用不变：证明本任务没有新增任何 writeFile 写入
  assert.equal((src.match(new RegExp("write" + "File", "g")) || []).length, 4,
    "不得新增任何落盘调用");
});
