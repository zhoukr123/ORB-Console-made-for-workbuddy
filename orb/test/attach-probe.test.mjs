/* 附件探针测试：用真实文件 + 现场合成的 zip 容器验证。
 * 运行：node --test orb/test/attach-probe.test.mjs
 *
 * 为什么要自己造 docx/xlsx：仓库里没有这两种文件，而它们是**最常被丢进来的**
 * 附件类型。合成的 zip 用 method=0（存储），刚好也覆盖"不压缩"这条分支。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const probeMod = require("../desktop/attach-probe.js");
const { probe, probeMany, summarize } = probeMod;

/* 必须用 fileURLToPath：仓库路径里有中文，new URL().pathname 会给出
 * 百分号编码的 %E6%8E%A7...，fs 直接 ENOENT —— 表现是"所有文件都读不到"，
 * 而探针本身其实是对的。第一版就踩在这里。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orb-probe-"));

/* ---------------- 最小 zip 写入（存储模式，不压缩） ---------------- */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);            // method 0 = stored
    local.writeUInt32LE(0, 14);           // crc（读取端不校验）
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

test("文本：读得到字数与摘要", async () => {
  const r = await probe(path.join(ROOT, "README.md"));
  assert.equal(r.kind, "text");
  assert.equal(r.readable, true);
  assert.ok(r.chars > 0, "应估算出字数");
  assert.ok(r.excerpt.length > 0);
  assert.ok(summarize(r).includes("字"));
});

test("图片：读出真实尺寸", async () => {
  const r = await probe(path.join(ROOT, "orb", "icon.png"));
  assert.equal(r.kind, "image");
  assert.equal(r.readable, true);
  assert.ok(r.meta.width > 0 && r.meta.height > 0, "应读出宽高");
  assert.equal(r.meta.format, "png");
});

test("PDF：页数与文本抽取（真实 1.4MB 文件）", async () => {
  const f = path.join(ROOT, "docs", "ORB-Console-Pitch-v1.4.2.pdf");
  if (!fs.existsSync(f)) return;      // 文件被清掉就跳过，不误报
  const r = await probe(f);
  assert.equal(r.kind, "pdf");
  assert.ok(r.meta.pages > 0, "页数应大于 0");
  // 文本能不能抽出来取决于是否扫描件，但"抽不出要能解释"这一点必须成立
  if (!r.excerpt) assert.ok(/扫描件|加密|抽不出/.test(r.note), "抽不出文本时必须给出原因：" + r.note);
});

test("DOCX：从 zip 里取正文并数字数", async () => {
  const f = path.join(tmp(), "a.docx");
  fs.writeFileSync(f, makeZip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>第一段：验收用文本</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>",
  }));
  const r = await probe(f);
  assert.equal(r.kind, "docx");
  assert.equal(r.readable, true);
  assert.ok(r.chars > 0);
  assert.match(r.excerpt, /第一段/);
  assert.ok(r.meta.paragraphs >= 2, "段落数应被统计");
});

test("XLSX：数工作表与共享字符串", async () => {
  const f = path.join(tmp(), "b.xlsx");
  fs.writeFileSync(f, makeZip({
    "xl/workbook.xml": "<workbook/>",
    "xl/sharedStrings.xml": "<sst><si><t>姓名</t></si><si><t>金额</t></si><si><t>备注</t></si></sst>",
    "xl/worksheets/sheet1.xml": "<worksheet/>",
    "xl/worksheets/sheet2.xml": "<worksheet/>",
  }));
  const r = await probe(f);
  assert.equal(r.kind, "xlsx");
  assert.equal(r.meta.sheets, 2);
  assert.equal(r.meta.sharedStrings, 3);
  assert.match(r.excerpt, /姓名/);
});

test("PPTX：数页数", async () => {
  const f = path.join(tmp(), "c.pptx");
  fs.writeFileSync(f, makeZip({
    "ppt/slides/slide1.xml": "<p:sld/>",
    "ppt/slides/slide2.xml": "<p:sld/>",
    "ppt/slides/slide3.xml": "<p:sld/>",
  }));
  const r = await probe(f);
  assert.equal(r.kind, "pptx");
  assert.equal(r.meta.slides, 3);
});

test("视频：能读时长就说时长，读不到要说明原因", async () => {
  const cands = ["recordings/录屏-20261028-195948.mp4", "../镜11-主题小样.mp4"];
  const f = cands.map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p));
  if (!f) return;
  const r = await probe(f);
  assert.equal(r.kind, "video");
  if (r.meta.durationMs) assert.ok(r.meta.durationMs > 0);
  else assert.match(r.note, /时长未知/, "读不到时长必须解释（moov 在尾部）");
});

test("不存在的文件：如实说明，不抛异常", async () => {
  const r = await probe(path.join(tmp(), "nope.pdf"));
  assert.equal(r.readable, false);
  assert.match(r.note, /读不到/);
});

test("批量：顺序与数量稳定", async () => {
  const dir = tmp();
  const files = ["1.txt", "2.txt", "3.txt"].map((n) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, "内容 " + n);
    return p;
  });
  const r = await probeMany(files);
  assert.equal(r.length, 3);
  assert.deepEqual(r.map((x) => path.basename(x.path)), ["1.txt", "2.txt", "3.txt"]);
});
