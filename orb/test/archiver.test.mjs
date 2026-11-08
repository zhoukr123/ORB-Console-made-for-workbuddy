/* archiver 单测：manifest 不存绝对路径 / L4 只留引用 / 同卷 rename / 跨卷退 copy /
 * frozen 快照 / hardlink 纪律 / logs.jsonl / 写盘失败收敛。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createArchiver } from "../archiver.mjs";

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orb-arch-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// 模拟跨卷：renameSync 抛 EXDEV，其余委托真实 fs
function renameThrowFs() {
  return new Proxy(fs, {
    get(t, k) {
      if (k === "renameSync") {
        return () => { const e = new Error("EXDEV cross-volume"); e.code = "EXDEV"; throw e; };
      }
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}
// 模拟写失败：writeFileSync 抛错，其余委托真实 fs
function writeThrowFs() {
  return new Proxy(fs, {
    get(t, k) {
      if (k === "writeFileSync") return () => { throw new Error("EACCES"); };
      const v = t[k];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

test("writeManifest/readManifest：绝不存绝对路径、坏路径容错", () => {
  const root = tmp();
  const ar = createArchiver({ root, now: () => 1000 });
  const entries = [
    { kind: "text", rel: "a/b.txt", size: 3, sha: "abc", conversationId: "c1", epoch: 1 },
    { kind: "text", rel: "C:/Users/me/secret.txt", abs: "D:/abs/root/x.txt", sha: "dead" },
  ];
  const w = ar.writeManifest("snap", entries, { root: "D:/abs/root", note: "ok", nested: { a: 1 } });
  assert.equal(w.ok, true);
  const raw = fs.readFileSync(w.path, "utf8");
  assert.ok(!raw.includes("D:/abs/root"));
  assert.ok(!raw.includes("C:/Users/me"));
  assert.ok(!/[A-Za-z]:[\\/]/.test(raw), "manifest 内容不得含盘符绝对路径");
  const doc = ar.readManifest(path.join(root, "snap"));
  assert.ok(doc);
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.entries[1].rel, undefined, "绝对 rel 被清洗掉");
  assert.equal(doc.entries[1].abs, undefined, "abs 不在白名单");
  assert.equal(doc.root, undefined, "绝对 root 被清洗掉");
  assert.equal(doc.nested, undefined, "对象 meta 不落地");
  assert.equal(ar.readManifest(path.join(root, "nope")), null);
});

test("L4 原始媒体只留引用、不落任何副本；普通文本 copy 并算 sha/size", () => {
  const root = tmp();
  const ar = createArchiver({ root, now: () => 1000 });
  const media = path.join(root, "orig.mp4");
  fs.writeFileSync(media, "RAWVIDEO");
  const session = { conversationId: "c9", day: "2026-01-02", dir: "2026-01-02/c9", epoch: 7, sessionEndAt: 1000 };
  const r = ar.archive({
    session,
    entries: [
      { kind: "text", rel: "notes/a.txt", content: "hello", epoch: 7 },
      { kind: "media", rel: "raw/clip.mp4", abs: media, layer: "L4" },
    ],
    logs: [{ level: "info", msg: "x" }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.copied, 1);
  assert.equal(r.skipped, 1);
  assert.ok(Array.isArray(r.errors));
  assert.equal(fs.readFileSync(path.join(root, "2026-01-02", "c9", "notes", "a.txt"), "utf8"), "hello");
  assert.equal(fs.existsSync(path.join(root, "2026-01-02", "c9", "raw", "clip.mp4")), false, "L4 不落副本");

  const doc = ar.readManifest(path.join(root, "2026-01-02", "c9"));
  const l4 = doc.entries.find((e) => e.link === "none");
  assert.ok(l4);
  assert.equal(l4.link, "none");
  assert.ok(l4.ref);
  assert.equal(typeof l4.expiresAt, "number");
  assert.equal(l4.sha, undefined, "L4 不算 sha");
  assert.equal(l4.size, undefined, "L4 不落 size");
  const norm = doc.entries.find((e) => e.rel === "notes/a.txt");
  assert.equal(norm.sha, createHash("sha256").update("hello", "utf8").digest("hex"));
  assert.equal(norm.size, 5);
  assert.equal(ar.stats().referenced, 1);
  assert.equal(ar.stats().copied, 1);
});

test("同卷 rename：.pending/<cid> → YYYY-MM-DD/<cid> 整目录搬移", () => {
  const root = tmp();
  const ar = createArchiver({ root, now: () => 1000 });
  const cid = "cRename";
  const pending = path.join(root, ".pending", cid);
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, "staged.txt"), "STAGED");
  const session = { conversationId: cid, day: "2026-01-02", dir: "2026-01-02/cRename", epoch: 1, sessionEndAt: 1000 };
  const r = ar.archive({ session, entries: [], logs: "line1\n" });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(pending), false, "同卷 rename 后 .pending 消失");
  assert.equal(fs.readFileSync(path.join(root, "2026-01-02", "cRename", "staged.txt"), "utf8"), "STAGED");
  assert.equal(fs.existsSync(path.join(root, "2026-01-02", "cRename", "manifest.json")), true);
  assert.equal(ar.readManifest(path.join(root, "2026-01-02", "cRename")).crossVolume, false);
});

test("跨卷失败退化 copy，并记进 manifest（crossVolume=true）", () => {
  const root = tmp();
  const pending = path.join(root, ".pending", "cX");
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, "staged.txt"), "STAGED-X");
  const ar = createArchiver({ root, now: () => 1000, fs: renameThrowFs() });
  const session = { conversationId: "cX", day: "2026-01-02", dir: "2026-01-02/cX" };
  const r = ar.archive({ session, entries: [], logs: [] });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(root, "2026-01-02", "cX", "staged.txt"), "utf8"), "STAGED-X");
  const doc = ar.readManifest(path.join(root, "2026-01-02", "cX"));
  assert.equal(doc.crossVolume, true);
  assert.equal(doc.degraded, "copy");
});

test("interrupted 会话目录标只读快照（manifest.frozen=true）", () => {
  const root = tmp();
  const ar = createArchiver({ root, now: () => 1000 });
  const session = {
    conversationId: "cFrozen", day: "2026-01-02", dir: "2026-01-02/cFrozen",
    interrupted: true, frozen: true,
  };
  const r = ar.archive({ session, entries: [{ kind: "text", rel: "a.txt", content: "x" }] });
  assert.equal(r.ok, true);
  assert.equal(ar.readManifest(path.join(root, "2026-01-02", "cFrozen")).frozen, true);
});

test("显式 hardlink 标 link:'hardlink'；L4 永远 link:'none' 绝不硬链接", () => {
  const root = tmp();
  const src = path.join(root, "src.bin");
  fs.writeFileSync(src, "DATA");
  const ar = createArchiver({ root, now: () => 1000, linkMode: "hardlink" });
  const session = { conversationId: "cHL", day: "2026-01-02", dir: "2026-01-02/cHL" };
  const r = ar.archive({
    session,
    entries: [
      { kind: "bin", rel: "a.bin", abs: src },
      { kind: "media", rel: "raw/m.mp4", abs: src, layer: "L4" },
    ],
  });
  assert.equal(r.ok, true);
  const doc = ar.readManifest(path.join(root, "2026-01-02", "cHL"));
  assert.equal(doc.entries.find((e) => e.rel === "a.bin").link, "hardlink");
  const l4 = doc.entries.find((e) => e.link === "none");
  assert.equal(l4.link, "none");
  assert.equal(fs.existsSync(path.join(root, "2026-01-02", "cHL", "raw", "m.mp4")), false, "L4 绝不硬链接/落副本");
});

test("manifest 字段齐全且绝不存绝对路径；logs.jsonl 同目录；stats 计数", () => {
  const root = tmp();
  const ar = createArchiver({ root, now: () => 1000 });
  const session = { conversationId: "cM", day: "2026-01-02", dir: "2026-01-02/cM", epoch: 3, sessionEndAt: 999 };
  const r = ar.archive({
    session,
    entries: [{ kind: "srt", rel: "sub/a.srt", content: "sub", epoch: 3 }],
    logs: [{ category: "task", msg: "x" }],
  });
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(path.join(root, "2026-01-02", "cM", "logs.jsonl")), true);
  const raw = fs.readFileSync(r.manifestPath, "utf8");
  assert.ok(!/[A-Za-z]:[\\/]/.test(raw), "manifest 内容绝不存绝对路径");
  const doc = ar.readManifest(path.join(root, "2026-01-02", "cM"));
  const e = doc.entries[0];
  for (const k of ["kind", "rel", "epoch", "conversationId", "size", "sha", "createdAt", "sessionEndAt"]) {
    assert.ok(k in e, `缺字段 ${k}`);
  }
  assert.equal(e.abs, undefined);
  assert.equal(e.sessionEndAt, 999);
  assert.equal(e.conversationId, "cM");
  assert.deepEqual(Object.keys(ar.stats()).sort(), ["archived", "copied", "errors", "referenced"].sort());
  assert.equal(ar.stats().archived, 1);
});

test("写盘失败收敛成返回值，不抛不崩", () => {
  const root = tmp();
  const ar = createArchiver({ root, now: () => 1000, fs: writeThrowFs() });
  const w = ar.writeManifest("snap", [{ kind: "text", rel: "a.txt" }], {});
  assert.equal(w.ok, false);
  assert.ok(w.error);
  const session = { conversationId: "cBad", day: "2026-01-02", dir: "2026-01-02/cBad" };
  const r = ar.archive({ session, entries: [{ kind: "text", rel: "a.txt", content: "x" }], logs: [] });
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.errors));
  assert.ok(r.errors.length >= 1);
});
