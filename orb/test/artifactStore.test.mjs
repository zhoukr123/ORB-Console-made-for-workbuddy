/* artifactStore 单测：产物登记、状态判定、防穿越 resolve、manifest 不存绝对路径。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createArtifactStore, ALLOWED_EXT, DENIED_FILES } from "../artifactStore.mjs";

const dirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-art-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("常量：扩展名白名单与内部状态黑名单", () => {
  assert.ok(ALLOWED_EXT.includes("mp4"));
  assert.ok(ALLOWED_EXT.includes("db"));
  assert.ok(ALLOWED_EXT.includes("vtt"));
  assert.ok(DENIED_FILES.includes(".bridge.json"));
  assert.ok(DENIED_FILES.includes("vault"));
  assert.ok(DENIED_FILES.includes("memory.json"));
});

test("resolve：../../.bridge.json 被拒绝（防穿越 + 黑名单）", () => {
  const store = createArtifactStore({ dir: tmp(), now: () => 1000 });
  const r = store.resolve("D:/safe/root", "media", "../../.bridge.json");
  assert.equal(r.ok, false);
  assert.equal(r.abs, null);
  // register 同样拒绝这种相对路径
  assert.equal(store.register({ conversationId: "c", epoch: 1, rel: "../../.bridge.json" }).ok, false);
});

test("resolve：绝对路径 / 盘符 / 反斜杠 / 黑名单段 / 非法扩展名一律拒", () => {
  const store = createArtifactStore({ dir: tmp(), now: () => 1000 });
  const bad = [
    ["media", "../secret.txt"],
    ["media", "/abs/x.png"],
    ["media", "C:/Windows/x.png"],
    ["media", "vault/x.json"],
    ["media", ".bridge.json"],
    ["media", "audit/log.jsonl"],
    ["media", "x.exe"],
    ["media", "frames\\x.png"],
  ];
  for (const [kind, rel] of bad) {
    assert.equal(store.resolve("D:/r", kind, rel).ok, false, `应拒绝: ${rel}`);
  }
});

test("resolve：合法相对路径返回 root 内的绝对路径", () => {
  const root = tmp();
  const store = createArtifactStore({ dir: root, now: () => 1000 });
  const r = store.resolve(root, "frames", "frames/a.png");
  assert.equal(r.ok, true);
  assert.equal(r.abs, path.resolve(root, "frames", "a.png"));
  assert.equal(store.resolve(root, "bad/kind", "frames/a.png").ok, false, "kind 含路径分隔符也拒");
});

test("register：按天追加 jsonl、重复 id 不重复登记、list/byConversation", () => {
  const dir = tmp();
  const store = createArtifactStore({ dir, now: () => 1000 });
  const base = {
    conversationId: "c1", epoch: 1, ticketId: "t1", kind: "media",
    rel: "clips/a.mp4", ext: "mp4", size: 123, sha: "deadbeef", createdAt: 1000,
  };
  const r1 = store.register(base);
  assert.equal(r1.ok, true);
  assert.ok(r1.id);
  const r2 = store.register({ ...base });
  assert.equal(r2.ok, true);
  assert.equal(r2.id, r1.id);
  assert.equal(r2.duplicate, true);
  const file = path.join(dir, "artifacts.19700101.jsonl");
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 1, "重复 id 不重复登记");

  store.register({ ...base, rel: "clips/b.mp4" });
  assert.equal(store.list().length, 2);
  assert.equal(store.byConversation("c1").length, 2);
  assert.equal(store.byConversation("other").length, 0);
  assert.equal(store.list({ conversationId: "c1", limit: 1 }).length, 1);
  assert.equal(store.stats().registered, 2);
  assert.ok(store.stats().files >= 1);
});

test("status：五种状态分支按优先级判定", () => {
  const store = createArtifactStore({ dir: tmp(), now: () => 1000 });
  assert.equal(store.status({ status: "ok" }), "ok");
  assert.equal(store.status({ status: "ok" }, { rootChanged: true }), "rootChanged");
  assert.equal(store.status({ status: "ok" }, { mediaExpired: true }), "expired");
  assert.equal(store.status({ status: "interrupted" }), "interrupted");
  assert.equal(store.status({ status: "missing" }), "missing");
  assert.equal(store.status(null), "missing");
});

test("writeManifest/readManifest：绝不存绝对路径、坏路径容错", () => {
  const dir = tmp();
  const store = createArtifactStore({ dir, now: () => 1000 });
  const entries = [
    { id: "a1", rel: "clips/a.mp4", ext: "mp4", conversationId: "c1" },
    { id: "a2", rel: "C:/Users/me/secret.txt", abs: "D:/abs/root/clips/x.png" },
  ];
  const w = store.writeManifest(dir, entries, { root: "D:/abs/root", note: "ok", nested: { a: 1 } });
  assert.equal(w.ok, true);
  const raw = fs.readFileSync(path.join(dir, "manifest.json"), "utf8");
  assert.ok(!raw.includes("D:/abs/root"));
  assert.ok(!raw.includes("C:/Users/me"));
  const doc = store.readManifest(dir);
  assert.equal(doc.entries.length, 2);
  assert.equal(doc.entries[1].rel, undefined, "绝对 rel 被清洗掉");
  assert.equal(doc.meta.root, undefined, "绝对 root 被清洗掉");
  assert.equal(doc.meta.nested, undefined, "meta 只存标量");
  assert.equal(store.readManifest(path.join(dir, "nope")), null, "不存在返回 null");
});
