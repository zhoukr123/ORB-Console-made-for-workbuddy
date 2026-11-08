import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWfTrash } from "../wfTrash.mjs";

function fixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orb-wftrash-"));
  const dir = path.join(root, "workflows");
  const trashDir = path.join(root, "workflows-trash");
  fs.mkdirSync(dir, { recursive: true });
  const io = opts.fs || fs;
  const t = createWfTrash({ dir, trashDir, fs: io, now: opts.now });
  const write = (name, steps = 3) =>
    fs.writeFileSync(path.join(dir, name + ".json"), JSON.stringify({ name, steps: new Array(steps).fill({}) }));
  return { root, dir, trashDir, t, write, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("删除 = 移入回收站，原目录不再有该文件（wfList 不会看见它）", () => {
  const f = fixture();
  try {
    f.write("wf_a", 12);
    const r = f.t.remove("wf_a");
    assert.equal(r.ok, true);
    assert.equal(r.steps, 12);
    assert.equal(fs.existsSync(path.join(f.dir, "wf_a.json")), false);
    assert.equal(fs.existsSync(path.join(f.trashDir, r.trashId)), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.trashDir, r.trashId), "utf8")).steps.length, 12);
  } finally { f.cleanup(); }
});

test("撤销可完整恢复，内容一字不差", () => {
  const f = fixture();
  try {
    f.write("wf_a", 7);
    const before = fs.readFileSync(path.join(f.dir, "wf_a.json"), "utf8");
    const r = f.t.remove("wf_a");
    const back = f.t.restore(r.trashId);
    assert.equal(back.ok, true);
    assert.equal(back.name, "wf_a");
    assert.equal(fs.readFileSync(path.join(f.dir, "wf_a.json"), "utf8"), before);
    assert.equal(fs.existsSync(path.join(f.trashDir, r.trashId)), false);
  } finally { f.cleanup(); }
});

test("同名已存在时拒绝恢复，绝不覆盖用户新录的内容", () => {
  const f = fixture();
  try {
    f.write("wf_a", 7);
    const r = f.t.remove("wf_a");
    f.write("wf_a", 2);                  // 删完又录了一条同名
    const back = f.t.restore(r.trashId);
    assert.equal(back.ok, false);
    assert.match(back.error, /已存在同名自动化/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, "wf_a.json"), "utf8")).steps.length, 2);
    assert.equal(fs.existsSync(path.join(f.trashDir, r.trashId)), true);  // 旧条目仍留着
  } finally { f.cleanup(); }
});

test("非法 trashId 一律拒绝（含路径穿越）", () => {
  const f = fixture();
  try {
    for (const tid of ["../workflows/wf_a.json", "..\\x.json", "/etc/passwd.json", "a/b.json", "", null]) {
      const r = f.t.restore(tid);
      assert.equal(r.ok, false, `应拒绝 ${tid}`);
    }
  } finally { f.cleanup(); }
});

test("删除不存在的 / 重复删除：明确报错，不制造空回收站条目", () => {
  const f = fixture();
  try {
    assert.equal(f.t.remove("nope").ok, false);
    f.write("wf_a");
    assert.equal(f.t.remove("wf_a").ok, true);
    assert.equal(f.t.remove("wf_a").ok, false);
    assert.equal(fs.readdirSync(f.trashDir).length, 1);
  } finally { f.cleanup(); }
});

test("同一毫秒连删同名，不互相覆盖（回收站条目各自独立）", () => {
  const f = fixture({ now: () => 1700000000000 });
  try {
    f.write("wf_a", 1);
    const r1 = f.t.remove("wf_a");
    f.write("wf_a", 2);
    const r2 = f.t.remove("wf_a");
    assert.notEqual(r1.trashId, r2.trashId);
    assert.equal(fs.readdirSync(f.trashDir).length, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.trashDir, r1.trashId), "utf8")).steps.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.trashDir, r2.trashId), "utf8")).steps.length, 2);
  } finally { f.cleanup(); }
});

test("EXDEV（跨卷）时退化为 copy + unlink", () => {
  const real = fs;
  const wrapped = Object.create(real);
  wrapped.renameSync = () => { const e = new Error("cross-device"); e.code = "EXDEV"; throw e; };
  const f = fixture({ fs: wrapped });
  try {
    f.write("wf_a", 4);
    const r = f.t.remove("wf_a");
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(path.join(f.dir, "wf_a.json")), false);
    assert.equal(fs.existsSync(path.join(f.trashDir, r.trashId)), true);
  } finally { f.cleanup(); }
});

test("内容损坏的自动化仍可移走，但恢复时如实拒绝", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.dir, "bad.json"), "{ 这不是 json");
    const r = f.t.remove("bad");
    assert.equal(r.ok, true);
    assert.equal(r.steps, 0);
    assert.equal(f.t.restore(r.trashId).ok, false);
  } finally { f.cleanup(); }
});

test("回收站列表：字段齐全、按删除时间倒序、损坏条目如实列出", () => {
  const f = fixture();
  try {
    f.write("wf_a", 4);
    const r = f.t.remove("wf_a");
    fs.writeFileSync(path.join(f.trashDir, "broken.json"), "{ 坏文件");
    const items = f.t.list();
    assert.equal(items.length, 2);
    const good = items.find((x) => x.trashId === r.trashId);
    assert.equal(good.name, "wf_a");
    assert.equal(good.steps, 4);
    assert.equal(good.damaged, false);
    assert.equal(items.find((x) => x.trashId === "broken.json").damaged, true);
  } finally { f.cleanup(); }
});

test("sweep 按 TTL 清理过期条目，保留新的", () => {
  const f = fixture();
  try {
    f.write("wf_old", 1); f.write("wf_new", 1);
    const old = f.t.remove("wf_old");
    const fresh = f.t.remove("wf_new");
    const oldPath = path.join(f.trashDir, old.trashId);
    const stale = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    fs.utimesSync(oldPath, stale, stale);
    const r = f.t.sweep({ ttlMs: 30 * 24 * 3600 * 1000 });
    assert.ok(r.removed.includes(old.trashId));
    assert.equal(fs.existsSync(path.join(f.trashDir, fresh.trashId)), true);
  } finally { f.cleanup(); }
});

test("sweep 超上限时按最老淘汰，且不会误删损坏条目之外的东西", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 5; i++) { f.write("wf_" + i, 1); f.t.remove("wf_" + i); }
    assert.equal(f.t.list().length, 5);
    const r = f.t.sweep({ max: 2, ttlMs: 999999999999 });
    assert.equal(r.removed.length, 3);
    assert.equal(f.t.list().length, 2);
  } finally { f.cleanup(); }
});

test("恢复条目里的 name 会被安全化，不会写出目录之外的路径", () => {
  const f = fixture();
  try {
    f.write("wf_a");
    const r = f.t.remove("wf_a");
    const p = path.join(f.trashDir, r.trashId);
    fs.writeFileSync(p, JSON.stringify({ name: "../../evil", steps: [] }));
    const back = f.t.restore(r.trashId);
    assert.equal(back.ok, true);
    assert.equal(back.name, ".._.._evil");
    assert.equal(fs.existsSync(path.join(f.dir, ".._.._evil.json")), true);
    assert.equal(fs.existsSync(path.join(f.root, "evil.json")), false);
  } finally { f.cleanup(); }
});
