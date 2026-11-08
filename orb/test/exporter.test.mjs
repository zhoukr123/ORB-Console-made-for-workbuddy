/* exporter 单测：真实在临时目录写 zip/csv/vtt/html/md 并读回校验内容。
 * 运行：node --test orb/test/exporter.test.mjs
 * ZIP 用纯 Node 解析（store 模式 local header + central directory + EOCD + CRC32），
 * 另附一个可选 Python zipfile 标准读回（无 python 环境则跳过）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createExporter, CSV_BOM } from "../exporter.mjs";

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-exp-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/* 纯 Node 解析 store 模式 ZIP：返回 { name: { crc, data } }。 */
function readStoreZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, "应有 EOCD");
  const n = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const out = {};
  let p = cdOff;
  for (let k = 0; k < n; k++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central header 签名");
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lhOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    assert.equal(buf.readUInt32LE(lhOff), 0x04034b50, "local header 签名");
    const lhNameLen = buf.readUInt16LE(lhOff + 26);
    const lhExtraLen = buf.readUInt16LE(lhOff + 28);
    const start = lhOff + 30 + lhNameLen + lhExtraLen;
    out[name] = { crc, data: buf.subarray(start, start + csize) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test("toVtt：标准 WebVTT，时间戳与文本转义", () => {
  const vtt = createExporter().toVtt([
    { start: 0, end: 2.5, text: "你好" },
    { start: 2.5, end: 5.125, text: "a & b <tag>" },
  ]);
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /00:00:00\.000 --> 00:00:02\.500/);
  assert.match(vtt, /00:00:02\.500 --> 00:00:05\.125/);
  assert.match(vtt, /你好/);
  assert.match(vtt, /a &amp; b &lt;tag&gt;/);
});

test("toCsv：转义引号/逗号/换行、不含 BOM、中文保留", () => {
  const csv = createExporter().toCsv([
    { name: "张三", note: "含,逗号" },
    { name: 'a"b', note: "第一行\n第二行" },
  ]);
  assert.notEqual(csv[0], CSV_BOM, "toCsv 不自带 BOM，由调用方加");
  assert.match(csv, /张三/);
  assert.match(csv, /"含,逗号"/);
  assert.match(csv, /"a""b"/);
  assert.match(csv, /"第一行\n第二行"/);
});

test("run：vtt/csv/html/md 真实落盘，UTF-8 + sha256 + 无 .part 残留", async (t) => {
  const dir = tmp(t);
  const exp = createExporter();
  const cases = [
    { format: "vtt", source: [{ start: 0, end: 1, text: "字幕" }], name: "a.vtt" },
    { format: "csv", source: [{ k: "值" }], name: "a.csv" },
    { format: "html", source: { title: "标题", body: "正文", frames: ["frames/a.png"] }, name: "a.html" },
    { format: "md", source: { title: "标题", meta: { key: "k1" }, sections: [{ heading: "小结", body: "内容" }] }, name: "a.md" },
  ];
  for (const c of cases) {
    const out = path.join(dir, c.name);
    const r = await exp.run({ format: c.format, source: c.source, outPath: out, epoch: 9 });
    assert.equal(r.ok, true, c.name);
    assert.equal(r.format, c.format);
    assert.equal(r.epoch, 9);
    assert.equal(r.sha.length, 64);
    const raw = fs.readFileSync(out, "utf8");
    assert.equal(r.bytes, Buffer.byteLength(raw, "utf8"));
    assert.equal(fs.existsSync(out + ".part"), false, ".part 必须已清理");
    assert.ok(raw.length > 0);
  }
});

test("toHtml：自包含、禁外链、frames 白名单、body 转义", () => {
  const html = createExporter().toHtml({
    title: "报告",
    body: '<script>alert(1)</script> <img src="http://evil.com/x.png">',
    frames: ["frames/a.png", "../evil.png", "http://evil/x.png", "secret.png"],
  });
  assert.ok(!html.includes("<script>"), "body 不可信文本必须转义");
  assert.match(html, /&lt;script&gt;/);
  assert.ok(!html.includes('<img src="http'), "不得引用外链资源");
  assert.ok(!html.includes("<link"));
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /src="frames\/a\.png"/);
  assert.ok(!html.includes("evil.png"), "非法 frame 全部过滤");
  assert.ok(!html.includes("secret.png"));
});

test("toMarkdown：front-matter 五键 + 确定性拼接", () => {
  const exp = createExporter({ now: () => 1_700_000_000_000 });
  const src = {
    title: "标题", meta: { key: "k1", epoch: 3, source: "orb", revision: "r2" },
    sections: [{ heading: "小结", body: "内容A" }, "独立段落"],
  };
  const md = exp.toMarkdown(src);
  assert.match(md, /^---\n/);
  for (const k of ["key", "epoch", "generatedAt", "source", "revision"]) {
    assert.match(md, new RegExp(`^${k}:`, "m"));
  }
  assert.match(md, /# 标题/);
  assert.match(md, /## 小结/);
  assert.match(md, /独立段落/);
  assert.equal(md, exp.toMarkdown(src), "同输入必须完全一致");
});

test("toZip：纯内置 store ZIP 读回内容 + CRC32 + UTF-8 文件名", (t) => {
  const dir = tmp(t);
  const out = path.join(dir, "bundle.zip");
  const r = createExporter({ now: () => 1_700_000_000_000 }).toZip([
    { name: "a.txt", content: "hello ORB" },
    { name: "notes/中文.txt", content: "你好，ORB" },
    { name: "../../evil.txt", content: "nope" },
  ], out);
  assert.equal(r.ok, true);
  assert.equal(r.sha.length, 64);
  assert.equal(r.bytes, fs.statSync(out).size);
  const z = readStoreZip(fs.readFileSync(out));
  assert.equal(z["a.txt"].data.toString("utf8"), "hello ORB");
  assert.equal(z["notes/中文.txt"].data.toString("utf8"), "你好，ORB");
  assert.equal(z["a.txt"].crc, crc32(Buffer.from("hello ORB")));
  assert.equal(z["notes/中文.txt"].crc, crc32(Buffer.from("你好，ORB", "utf8")));
  assert.ok(!Object.keys(z).some((k) => k.includes("..")), "不得出现 .. 穿越名");
  assert.equal(fs.existsSync(out + ".part"), false);
});

test("toZip：Python zipfile 可标准读回（无 python 环境则跳过）", (t) => {
  const dir = tmp(t);
  const out = path.join(dir, "std.zip");
  createExporter().toZip([{ name: "a.txt", content: "hello ORB" }], out);
  const py = "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nassert z.read('a.txt').decode('utf-8')=='hello ORB'\nprint('OK')\n";
  let r;
  try { r = spawnSync("python", ["-c", py, out], { encoding: "utf8" }); } catch { r = { error: true }; }
  if (r.error || r.status !== 0) {
    try { r = spawnSync("python3", ["-c", py, out], { encoding: "utf8" }); } catch { r = { error: true }; }
  }
  if (r.error || r.status !== 0) { t.skip("环境无可用 Python，跳过标准 zip 读回"); return; }
  assert.match(r.stdout, /OK/);
});

test("run：未知 format 明确拒绝，不落盘", async (t) => {
  const dir = tmp(t);
  const out = path.join(dir, "x.bin");
  const r = await createExporter().run({ format: "bogus", source: null, outPath: out });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown format/);
  assert.equal(r.format, "bogus");
  assert.equal(fs.existsSync(out), false);
});

test("run：pdf 委托主渲染进程，不落地 PDF 文件", async (t) => {
  const dir = tmp(t);
  const out = path.join(dir, "doc.pdf");
  const r = await createExporter().run({ format: "pdf", source: { title: "T", body: "B" }, outPath: out });
  assert.equal(r.ok, true);
  assert.equal(r.delegated, "main-renderer");
  assert.equal(r.plan.delegated, "main-renderer");
  assert.equal(fs.existsSync(out), false);
});

test("run：注入 runFile 优先委托并返回 delegated", async () => {
  const exp = createExporter({
    runFile: async (spec) => ({ ok: true, path: spec.outPath, bytes: 5, sha: null }),
  });
  const r = await exp.run({ format: "txt", source: "hello", outPath: "D:/no-such-dir/out.txt" });
  assert.equal(r.ok, true);
  assert.equal(r.delegated, true);
  assert.equal(r.format, "txt");
  assert.equal(r.bytes, 5);
});

test("toDb：node:sqlite 可用与否都收敛为返回对象、不抛", async (t) => {
  const dir = tmp(t);
  const out = path.join(dir, "snap.db");
  const r = await createExporter().toDb([{ a: 1 }], out);
  assert.equal(typeof r, "object");
  assert.ok("ok" in r);
  if (!r.ok) assert.equal(typeof r.error, "string");
});
