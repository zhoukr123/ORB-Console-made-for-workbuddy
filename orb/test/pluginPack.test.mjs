/* pluginPack.test.mjs — 拖拽安装的后端：拆包、净化、落盘
 *
 * 这一层收到的全是不可信字节，所以测的重点不是"能解开"，而是
 * 「解不开时是否老实说」「路径越界时是否整条丢弃」「炸弹是否在 inflate 阶段就被挡住」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  PACK_LIMITS,
  safeRelPath,
  looksLikeZip,
  readZip,
  unpackTo,
  packHash,
  locateRoot,
  synthesizeSkillManifest,
} from "../pluginPack.mjs";

/* ---------- 最小 zip 写入器（只为了造测试样本；生产代码里没有写 zip 的需求） ---------- */
function makeZip(files, opt = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(String(f.path), "utf8");
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), "utf8");
    const method = opt.deflate ? 8 : 0;
    const data = opt.deflate ? zlib.deflateRawSync(raw) : raw;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(f.declaredSize != null ? f.declaredSize : raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(f.declaredSize != null ? f.declaredSize : raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    chunks.push(local, nameBuf, data);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cenBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cenBuf, eocd]);
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orb-pack-" + tag + "-"));
}

/* ---------- 路径净化 ---------- */

test("safeRelPath 全部拒绝：绝对路径 / 目录穿越 / 盘符 / 非法字符", () => {
  const bad = [
    "../evil.json",
    "a/../../evil.json",
    "/etc/passwd",
    "C:\\Windows\\x.dll",
    "c:/x",
    "a\\..\\b",
    "a/b\u0000c",
    "a/co:n.txt",
    "",
    "   ",
    "./",
  ];
  for (const b of bad) assert.equal(safeRelPath(b), "", "应拒绝：" + JSON.stringify(b));
});

test("safeRelPath 放行正常相对路径，并把反斜杠归一成正斜杠", () => {
  assert.equal(safeRelPath("plugin.json"), "plugin.json");
  assert.equal(safeRelPath("a\\b\\c.txt"), "a/b/c.txt");
  assert.equal(safeRelPath("./skills/x/SKILL.md"), "skills/x/SKILL.md");
  assert.equal(safeRelPath("a//b.txt"), "a/b.txt");
});

/* ---------- 解压 ---------- */

test("readZip 读 store 与 deflate 两种压缩方式", () => {
  for (const deflate of [false, true]) {
    const buf = makeZip(
      [
        { path: "plugin.json", data: '{"name":"demo"}' },
        { path: "skills/demo/SKILL.md", data: "# Demo\n做一件事" },
      ],
      { deflate },
    );
    const r = readZip(buf);
    assert.equal(r.ok, true, "deflate=" + deflate);
    const byName = Object.fromEntries(r.entries.map((e) => [e.path, e.data.toString("utf8")]));
    assert.equal(byName["plugin.json"], '{"name":"demo"}');
    assert.equal(byName["skills/demo/SKILL.md"], "# Demo\n做一件事");
  }
});

test("readZip 跳过 __MACOSX / .DS_Store / 目录条目", () => {
  const buf = makeZip([
    { path: "plugin.json", data: "{}" },
    { path: "__MACOSX/._plugin.json", data: "junk" },
    { path: ".DS_Store", data: "junk" },
    { path: "skills/", data: "" },
  ]);
  const r = readZip(buf);
  assert.equal(r.ok, true);
  assert.deepEqual(r.entries.map((e) => e.path), ["plugin.json"]);
});

test("readZip 对坏输入老实报错，不假装成功", () => {
  assert.equal(readZip(Buffer.from("not a zip at all, really")).error, "zip-no-eocd");
  assert.equal(readZip(Buffer.alloc(4)).error, "zip-too-small");
});

test("readZip 认出 zip64 占位符并明确拒绝", () => {
  const buf = makeZip([{ path: "plugin.json", data: "{}" }]);
  /* 把中央目录条目数改成 0xFFFF：真实包不可能有这么多文件，见到就当 zip64 */
  buf.writeUInt16LE(0xffff, buf.length - 12);
  assert.equal(readZip(buf).error, "zip64-unsupported");
});

test("单文件超限：按中央目录声明的尺寸直接跳过，不解压", () => {
  const buf = makeZip([{ path: "big.bin", data: "x", declaredSize: PACK_LIMITS.maxFileBytes + 1 }]);
  const r = readZip(buf);
  assert.equal(r.ok, false, "只剩一个超大条目 → 没有可用条目");
  assert.ok(r.warnings.some((w) => w.includes("单文件超过")), r.warnings.join("|"));
});

test("looksLikeZip 认魔数，不认扩展名", () => {
  const buf = makeZip([{ path: "a.json", data: "{}" }]);
  assert.equal(looksLikeZip(buf), true);
  assert.equal(looksLikeZip(Buffer.from("{\"a\":1}")), false);
});

/* ---------- 落盘与本目录越界 ---------- */

test("unpackTo 写在 root 内；越界与非法路径整条丢弃并记 warning", () => {
  const root = path.join(tmpdir("unpack"), "pkg");
  const r = unpackTo(root, [
    { path: "plugin.json", data: Buffer.from("{}") },
    { path: "skills/a/SKILL.md", data: Buffer.from("# A") },
    { path: "../escape.txt", data: Buffer.from("nope") },
    { path: "/abs.txt", data: Buffer.from("nope") },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.written.sort(), ["plugin.json", "skills/a/SKILL.md"].sort());
  assert.equal(r.warnings.length, 2);
  assert.equal(fs.existsSync(path.join(root, "skills", "a", "SKILL.md")), true);
  /* 关键断言：跑出去的文件一个都不能存在 */
  assert.equal(fs.existsSync(path.join(path.dirname(root), "escape.txt")), false);
  assert.equal(fs.existsSync("/abs.txt"), false);
});

test("packHash 同内容同哈希、内容变则哈希变", () => {
  const a = [{ path: "plugin.json", data: Buffer.from("{}") }];
  const b = [{ path: "plugin.json", data: Buffer.from("{}") }];
  const c = [{ path: "plugin.json", data: Buffer.from("{ }") }];
  assert.equal(packHash(a), packHash(b));
  assert.notEqual(packHash(a), packHash(c));
  /* 顺序不同不影响 */
  const d = [
    { path: "a.json", data: Buffer.from("1") },
    { path: "b.json", data: Buffer.from("2") },
  ];
  assert.equal(packHash(d), packHash(d.slice().reverse()));
});

/* ---------- 形态归一 ---------- */

test("locateRoot 会走进外面套的那层目录", () => {
  const root = tmpdir("wrap");
  fs.mkdirSync(path.join(root, "my-plugin", "skills"), { recursive: true });
  fs.writeFileSync(path.join(root, "my-plugin", "plugin.json"), "{}");
  assert.equal(locateRoot(root), path.join(root, "my-plugin"));
});

test("locateRoot 认根目录已就位，不多走一层", () => {
  const root = tmpdir("flat");
  fs.writeFileSync(path.join(root, "plugin.json"), "{}");
  fs.mkdirSync(path.join(root, "skills"));
  assert.equal(locateRoot(root), root);
});

test("locateRoot 把唯一的 json 认成清单（用户拖的文件可能不叫 plugin.json）", () => {
  const root = tmpdir("single");
  fs.writeFileSync(path.join(root, "my-demo.json"), '{"name":"my-demo"}');
  const dir = locateRoot(root);
  assert.equal(dir, root);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8")).name, "my-demo");
});

test("locateRoot 目录里乱七八糟时不做猜测", () => {
  const root = tmpdir("mess");
  fs.mkdirSync(path.join(root, "a"));
  fs.mkdirSync(path.join(root, "b"));
  assert.equal(locateRoot(root), root);
});

/* ---------- 单 SKILL.md ---------- */

test("synthesizeSkillManifest 从 SKILL.md 抽名字与摘要", () => {
  const root = tmpdir("skill");
  fs.writeFileSync(path.join(root, "SKILL.md"), "# PDF 处理\n\n读取、总结 PDF。\n");
  const m = synthesizeSkillManifest(root);
  assert.equal(m.name, "PDF 处理");
  assert.equal(m.category, "skill");
  assert.ok(m.description.includes("读取"));
  assert.equal(m.__synthesized, true);
});

test("没有 SKILL.md 时不合成清单（不凭空造插件）", () => {
  assert.equal(synthesizeSkillManifest(tmpdir("noskill")), null);
});
