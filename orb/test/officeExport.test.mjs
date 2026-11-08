/* Office 三件套（docx/xlsx/pptx）端到端单测。
 * 不依赖 python / 任何三方库：toZip 打的是 store 模式 ZIP，这里用 Node 直接读回
 * central directory，逐个部件校验内容，确保生成的是「能被 Office 打开」的 OOXML，
 * 而不是只看着像 XML 的一堆字符串。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildSource, createExporter } from "../exporter.mjs";
import { FORMATS } from "../outputProfile.mjs";
import { ALLOWED_EXT } from "../artifactStore.mjs";

/* 读回 store ZIP：EOCD → central directory → local header → 数据区。 */
function unzipStore(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, "必须找得到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central directory 头合法");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const size = buf.readUInt32LE(p + 24);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, "local header 头合法");
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    out[name] = buf.slice(dataStart, dataStart + size).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-office-"));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function exportTo(fmt, text, title, dir) {
  const built = buildSource(text, { format: fmt, title });
  assert.equal(built.ok, true, `${fmt} buildSource: ${built.error || ""}`);
  const out = path.join(dir, `out.${fmt}`);
  const r = await createExporter().run({ format: fmt, source: built.source, outPath: out });
  assert.equal(r.ok, true, `${fmt} run: ${r.error || ""}`);
  assert.ok(r.bytes > 100, `${fmt} 不该是空文件`);
  const buf = fs.readFileSync(out);
  assert.equal(buf.slice(0, 2).toString("latin1"), "PK", `${fmt} 必须是 ZIP 容器`);
  return { parts: unzipStore(buf), buf, out };
}

test("产物登记白名单覆盖 Office 扩展名，格式清单唯一来源是 FORMATS", () => {
  for (const e of ["docx", "xlsx", "pptx"]) assert.ok(ALLOWED_EXT.includes(e), `允许登记 .${e}`);
  /* 2026-11-08：面板的「导出与交付」栏目撤了 —— 交付形式改由 agent 按内容自选（默认 .md），
     不再维护第二份格式清单，也就没有"两份清单对不上"这个坑。
     这条断言留下是为了防止有人把清单写回面板：两份必然漂移，
     而用户只会看到"说支持十种，怎么只出来九种"。 */
  assert.ok(FORMATS.includes("md") && FORMATS.includes("docx") && FORMATS.includes("pdf"),
    "FORMATS 至少覆盖 md / docx / pdf");
  const html = fs.readFileSync(new URL("../desktop/panel.html", import.meta.url), "utf8");
  assert.ok(!/const EXP_FORMATS/.test(html),
    "面板不该再维护第二份格式清单（唯一来源是 outputProfile.FORMATS）");
});

test("docx：三件最小部件齐全，正文/中文/Markdown 标题不丢，尖括号已转义", async () => {
  await withTmp(async (dir) => {
    const { parts } = await exportTo("docx",
      "# 内容提要\n上下文的真正开源：dsh-context 与 DeepSeek Harness\n<script>alert(1)</script> & A<B",
      "视频提要", dir);
    assert.ok(Object.keys(parts).includes("[Content_Types].xml"));
    assert.ok(Object.keys(parts).includes("_rels/.rels"));
    assert.ok(parts["[Content_Types].xml"].includes("wordprocessingml.document.main+xml"));
    assert.ok(parts["_rels/.rels"].includes("officeDocument"));
    const doc = parts["word/document.xml"];
    assert.ok(doc.includes("视频提要"), "标题进文档");
    assert.ok(doc.includes("dsh-context 与 DeepSeek Harness"), "中文正文不丢");
    assert.ok(doc.includes("<w:b/>"), "# 标题映射成加粗");
    assert.ok(doc.includes("&lt;script&gt;") && !doc.includes("<script>"), "尖括号必须转义");
    assert.ok(doc.includes("&amp;"), "& 必须转义");
    assert.ok(doc.includes("<w:sectPr>"), "有节属性，Word 才不判损坏");
  });
});

test("xlsx：workbook/rels/sheet 齐全，数值写成数值单元格，中文用 inlineStr", async () => {
  await withTmp(async (dir) => {
    const { parts } = await exportTo("xlsx", "名称,数量\n中文,1\n第二行,2.5\n", "表", dir);
    assert.ok(parts["xl/workbook.xml"].includes('<sheet name="Sheet1"'));
    assert.ok(parts["xl/_rels/workbook.xml.rels"].includes("worksheets/sheet1.xml"));
    const sheet = parts["xl/worksheets/sheet1.xml"];
    assert.ok(sheet.includes("名称") && sheet.includes("中文"), "中文表头/单元格不丢");
    assert.ok(sheet.includes('<c r="B2"><v>1</v></c>'), "整数写成数值单元格");
    assert.ok(sheet.includes('<c r="B3"><v>2.5</v></c>'), "小数写成数值单元格");
    assert.ok(sheet.includes('t="inlineStr"'), "文本走 inlineStr");
    assert.ok(!sheet.includes("sharedStrings"), "不该引用不存在的 sharedStrings");
  });
});

test("pptx：母版/版式/主题/各页与 rels 齐全，空行正确分页", async () => {
  await withTmp(async (dir) => {
    const { parts } = await exportTo("pptx", "第一页\n要点甲\n要点乙\n\n第二页\n要点丙", "汇报", dir);
    for (const f of [
      "[Content_Types].xml", "_rels/.rels", "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels", "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideMasters/_rels/slideMaster1.xml.rels", "ppt/slideLayouts/slideLayout1.xml",
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels", "ppt/theme/theme1.xml",
      "ppt/slides/slide1.xml", "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide1.xml.rels", "ppt/slides/_rels/slide2.xml.rels",
    ]) assert.ok(parts[f] !== undefined, `缺部件 ${f}`);
    assert.ok(parts["ppt/presentation.xml"].includes("p:sldMasterId"), "挂了母版");
    assert.equal((parts["ppt/presentation.xml"].match(/<p:sldId /g) || []).length, 2, "两页");
    assert.ok(parts["[Content_Types].xml"].includes("/ppt/slides/slide2.xml"), "每页都有 Override");
    assert.ok(parts["ppt/slides/slide1.xml"].includes("第一页"));
    assert.ok(parts["ppt/slides/slide1.xml"].includes("要点乙"), "要点不丢");
    assert.ok(parts["ppt/slides/slide2.xml"].includes("第二页"));
    assert.ok(parts["ppt/theme/theme1.xml"].includes("a:clrScheme"), "主题色表齐全");
  });
});

test("docx 能被 python-docx 真正打开（本机没装该库则跳过）", async () => {
  await withTmp(async (dir) => {
    const { out } = await exportTo("docx", "# 标题\n一段中文正文", "兼容性", dir);
    const py = ["python", "python3", "py"].find((bin) => {
      const r = spawnSync(bin, ["-c", "import docx"], { encoding: "utf8" });
      return !r.error && r.status === 0;
    });
    if (!py) return;   // 无 python-docx 的环境不阻断主流程
    const r = spawnSync(py, ["-c",
      "import sys, docx; d=docx.Document(sys.argv[1]); print('|'.join(p.text for p in d.paragraphs))", out],
      { encoding: "utf8" });
    assert.equal(r.status, 0, `python-docx 打不开生成的 docx：${r.stderr || ""}`);
    assert.ok((r.stdout || "").includes("一段中文正文"), "Word 里读得到正文");
    assert.ok((r.stdout || "").includes("标题"), "Word 里读得到标题");
  });
});
