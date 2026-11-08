import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copyEntry, moveEntry, renameEntry, runCommandOp } from "../cmdchan.mjs";

/* 文件操作用真实临时目录验证（在 os.tmpdir 下，不碰用户文件）。 */
async function tmpDir(tag) {
  return fs.mkdtemp(path.join(os.tmpdir(), `orb-cmdchan-${tag}-`));
}

test("copy: 基本复制", async () => {
  const dir = await tmpDir("copy");
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  await fs.writeFile(a, "hello", "utf8");
  const r = await copyEntry({ from: a, to: b });
  assert.equal(r.from, a);
  assert.equal(await fs.readFile(b, "utf8"), "hello");
  assert.equal(await fs.readFile(a, "utf8"), "hello", "源应保留");
  await fs.rm(dir, { recursive: true, force: true });
});

test("copy: 目标已存在且未开覆盖 → 拒绝", async () => {
  const dir = await tmpDir("copy-ow");
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  await fs.writeFile(a, "A", "utf8");
  await fs.writeFile(b, "B", "utf8");
  await assert.rejects(() => copyEntry({ from: a, to: b }), /目标已存在/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("copy: overwrite:true 覆盖成功", async () => {
  const dir = await tmpDir("copy-force");
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  await fs.writeFile(a, "A", "utf8");
  await fs.writeFile(b, "B", "utf8");
  await copyEntry({ from: a, to: b, overwrite: true });
  assert.equal(await fs.readFile(b, "utf8"), "A");
  await fs.rm(dir, { recursive: true, force: true });
});

test("copy: 源不存在 → 拒绝", async () => {
  const dir = await tmpDir("copy-miss");
  await assert.rejects(
    () => copyEntry({ from: path.join(dir, "nope.txt"), to: path.join(dir, "x.txt") }),
    /源不存在/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("move: 移动后源消失、目标存在", async () => {
  const dir = await tmpDir("move");
  const a = path.join(dir, "a.txt");
  const c = path.join(dir, "c.txt");
  await fs.writeFile(a, "hi", "utf8");
  await moveEntry({ from: a, to: c });
  assert.equal(await fs.readFile(c, "utf8"), "hi");
  await assert.rejects(() => fs.stat(a), "源应已消失");
  await fs.rm(dir, { recursive: true, force: true });
});

test("move: 源不存在 → 拒绝", async () => {
  const dir = await tmpDir("move-miss");
  await assert.rejects(
    () => moveEntry({ from: path.join(dir, "nope.txt"), to: path.join(dir, "x.txt") }),
    /源不存在/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("rename: 同目录改名", async () => {
  const dir = await tmpDir("rename");
  const a = path.join(dir, "old.txt");
  const b = path.join(dir, "new.txt");
  await fs.writeFile(a, "z", "utf8");
  await renameEntry({ from: a, to: b });
  assert.equal(await fs.readFile(b, "utf8"), "z");
  await assert.rejects(() => fs.stat(a));
  await fs.rm(dir, { recursive: true, force: true });
});

test("runCommandOp: copy 走通", async () => {
  const dir = await tmpDir("op-copy");
  const a = path.join(dir, "a.txt");
  const b = path.join(dir, "b.txt");
  await fs.writeFile(a, "1", "utf8");
  const out = await runCommandOp({ copy: { from: a, to: b } });
  assert.ok(out.copied);
  assert.equal(await fs.readFile(b, "utf8"), "1");
  await fs.rm(dir, { recursive: true, force: true });
});

test("runCommandOp: 空操作仍报错", async () => {
  await assert.rejects(() => runCommandOp({}), /至少一项/);
});
