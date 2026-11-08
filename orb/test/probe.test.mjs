import { test } from "node:test";
import assert from "node:assert/strict";
import { createProber } from "../probe.mjs";

/* 探测器全部依赖注入，不碰真机：用假 execFile / 假 fs。 */

test("which: 绝对路径直接判存在，不走子进程", async () => {
  const p = createProber({
    fs: { existsSync: (x) => x === "C:/Windows/notepad.exe" },
    execFile: () => { throw new Error("不应调用 exec"); },
  });
  assert.equal(await p.which("C:/Windows/notepad.exe"), "C:/Windows/notepad.exe");
  assert.equal(await p.which("C:/nope.exe"), "");
});

test("which: 裸名走 where/which，优先返回 .exe", async () => {
  let calls = 0;
  const p = createProber({
    execFile: (cmd, args, opts, cb) => { calls++; cb(null, "C:\\a\\notepad.cmd\nC:\\b\\notepad.exe\n"); },
  });
  assert.equal(await p.which("notepad"), "C:\\b\\notepad.exe");
  assert.equal(calls, 1);
});

test("which: 找不到返回空串", async () => {
  const p = createProber({ execFile: (cmd, args, opts, cb) => cb(new Error("not found"), "") });
  assert.equal(await p.which("nope"), "");
});

test("which: TTL 内命中缓存，只查一次", async () => {
  let calls = 0;
  const p = createProber({
    execFile: (cmd, args, opts, cb) => { calls++; cb(null, "C:\\git.exe\n"); },
  });
  await p.which("git");
  await p.which("git");
  assert.equal(calls, 1, "第二次应命中缓存");
});

test("exists: 透传 fs.existsSync", async () => {
  const p = createProber({ fs: { existsSync: (x) => x === "D:/a.txt" } });
  assert.equal(await p.exists("D:/a.txt"), true);
  assert.equal(await p.exists("D:/b.txt"), false);
});
