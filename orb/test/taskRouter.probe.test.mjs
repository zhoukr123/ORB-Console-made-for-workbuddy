import { test } from "node:test";
import assert from "node:assert/strict";
import { probeCommandable, planTaskProbed } from "../taskRouter.mjs";

/* 假探测器：which/exists 按测试用例返回，不碰真机。 */
function fakeProber({ whichMap = {}, existsSet = [] } = {}) {
  const exists = new Set(existsSet);
  return {
    which: async (n) => whichMap[n] || "",
    exists: async (p) => exists.has(p),
    isDir: () => false,
  };
}

test("launch：程序存在 → 命令化（rule 带 +probe）", async () => {
  const c = await probeCommandable("运行 notepad", fakeProber({ whichMap: { notepad: "C:/n/notepad.exe" } }));
  assert.equal(c.commandable, true);
  assert.equal(c.probed, true);
  assert.match(c.rule, /\+probe$/);
  assert.equal(c.probe.which, "C:/n/notepad.exe");
});

test("launch：程序不存在 → 判给视觉", async () => {
  const c = await probeCommandable("运行 notepad", fakeProber());
  assert.equal(c.commandable, false);
  assert.equal(c.intent, null);
});

test("open：文件存在 → 命令化", async () => {
  const c = await probeCommandable("打开 D:/a.txt", fakeProber({ existsSet: ["D:/a.txt"] }));
  assert.equal(c.commandable, true);
  assert.equal(c.probe.fileExists, true);
});

test("open：文件不存在 → 判给视觉", async () => {
  const c = await probeCommandable("打开 D:/missing.txt", fakeProber({ existsSet: [] }));
  assert.equal(c.commandable, false);
});

test("open：中文程序名走别名（记事本→notepad）后复核通过", async () => {
  const c = await probeCommandable(
    "用记事本打开 D:/a.txt",
    fakeProber({ whichMap: { notepad: "C:/n/notepad.exe" }, existsSet: ["D:/a.txt"] }),
  );
  assert.equal(c.commandable, true);
  assert.equal(c.intent.app, "notepad", "别名应把 app 归一到 notepad");
});

test("open：中文程序名无法解析时保留原判定（不误杀）", async () => {
  // "某某软件" 不在别名表、也不像 ASCII 程序 → appSkipped，保留命令化判定
  const c = await probeCommandable("用某某软件打开 D:/a.txt", fakeProber({ existsSet: ["D:/a.txt"] }));
  assert.equal(c.commandable, true);
  assert.equal(c.probe.appSkipped, true);
});

test("write：根存在 → 命令化", async () => {
  const c = await probeCommandable("把 hello 写入 D:/a.txt", fakeProber({ existsSet: ["D:/", "D:\\"] }));
  assert.equal(c.commandable, true);
});

test("write：根不存在 → 判给视觉", async () => {
  const c = await probeCommandable("把 hello 写入 D:/a.txt", fakeProber({ existsSet: [] }));
  assert.equal(c.commandable, false);
});

test("cli-explicit：git 存在 → 命令化，rule=cli-explicit+probe", async () => {
  const c = await probeCommandable("git status", fakeProber({ whichMap: { git: "C:/g/git.exe" } }));
  assert.equal(c.commandable, true);
  assert.equal(c.rule, "cli-explicit+probe");
  assert.equal(c.intent.op, "launch");
  assert.deepEqual(c.intent.args, ["status"]);
});

test("cli-explicit：git 不存在 → 判给视觉", async () => {
  const c = await probeCommandable("git status", fakeProber());
  assert.equal(c.commandable, false);
});

test("非候选（点击按钮）→ 不探测，probed=false", async () => {
  const c = await probeCommandable("点击登录按钮", fakeProber());
  assert.equal(c.commandable, false);
  assert.equal(c.probed, false);
  assert.equal(c.probe, null);
});

test("没有探测器 → 保留正则判定，probed=false", async () => {
  const c = await probeCommandable("运行 notepad", null);
  assert.equal(c.commandable, true, "无探测器时沿用正则高置信");
  assert.equal(c.probed, false);
});

test("探测器抛错 → 不阻断，保留正则判定并记录 error", async () => {
  const bad = { which: async () => { throw new Error("boom"); }, exists: async () => false };
  const c = await probeCommandable("运行 notepad", bad);
  assert.equal(c.commandable, true, "探测出错不误杀");
  assert.match(c.probe.error, /boom/);
});

test("planTaskProbed：可命令化 → via=command，并带 probe 明细", async () => {
  const p = await planTaskProbed("运行 notepad", fakeProber({ whichMap: { notepad: "C:/n/notepad.exe" } }));
  assert.equal(p.via, "command");
  assert.equal(p.probed, true);
  assert.ok(p.probe);
});
