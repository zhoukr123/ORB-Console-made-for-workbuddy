import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFreeTier,
  parseOpenIntent,
  intentToCmdOp,
  normalizeIntent,
} from "../freetier.mjs";

/* 一组不依赖真桌面的单测：用假 cmd / 假 gui / 假 guiLock 把两条分支与失败路径都覆盖。 */

test("parseOpenIntent: 用 X 打开 Y", () => {
  const it = parseOpenIntent("用 notepad 打开 D:/a.txt");
  assert.equal(it.op, "open");
  assert.equal(it.app, "notepad");
  assert.equal(it.filePath, "D:/a.txt");
});

test("parseOpenIntent: 打开 Y（无 app → 默认关联）", () => {
  const it = parseOpenIntent("打开 D:/报告.pdf");
  assert.equal(it.op, "open");
  assert.equal(it.filePath, "D:/报告.pdf");
  assert.equal(it.app, "");
});

test("parseOpenIntent: 运行 X", () => {
  const it = parseOpenIntent("运行 notepad");
  assert.equal(it.op, "launch");
  assert.equal(it.command, "notepad");
});

test("parseOpenIntent: 识别不出返回 null", () => {
  assert.equal(parseOpenIntent("今天天气不错"), null);
  assert.equal(parseOpenIntent(""), null);
});

test("intentToCmdOp: open → openWith", () => {
  const op = intentToCmdOp({ op: "open", app: "notepad", filePath: "a.txt" });
  assert.deepEqual(op, { openWith: { app: "notepad", filePath: "a.txt" } });
});

test("intentToCmdOp: open（无 app）→ openWith 空 app", () => {
  const op = intentToCmdOp({ op: "open", filePath: "a.pdf" });
  assert.deepEqual(op, { openWith: { app: "", filePath: "a.pdf" } });
});

test("intentToCmdOp: launch → launch", () => {
  const op = intentToCmdOp({ op: "launch", command: "notepad", args: ["a.txt"] });
  assert.deepEqual(op, { launch: { command: "notepad", args: ["a.txt"] } });
});

test("intentToCmdOp: write → write", () => {
  const op = intentToCmdOp({ op: "write", filePath: "a.txt", content: "hi", encoding: "utf8" });
  assert.deepEqual(op, { write: { filePath: "a.txt", content: "hi", encoding: "utf8" } });
});

test("route: 优先走命令通道，成功时不碰 GUI", async () => {
  let guiCalls = 0;
  const cmd = {
    runCommandOp: async (op) => ({ ok: true, op }),
    normalizeCmdOp: (b) => ({ spec: null }),
  };
  const gui = async () => { guiCalls++; return { gui: true }; };
  const ft = createFreeTier({ cmd, gui });

  const r = await ft.route({ op: "open", app: "notepad", filePath: "a.txt" });
  assert.equal(r.via, "command");
  assert.equal(guiCalls, 0, "GUI 不应被调用");
  assert.ok(r.result && r.result.ok);
});

test("route: 命令通道失败 → 自动回落 GUI", async () => {
  let guiCalls = [];
  const cmd = {
    runCommandOp: async () => { throw new Error("命令通道炸了"); },
    normalizeCmdOp: (b) => ({ spec: null }),
  };
  const gui = async (it) => { guiCalls.push(it); return { gui: true }; };
  const ft = createFreeTier({ cmd, gui });

  const r = await ft.route({ op: "open", app: "notepad", filePath: "a.txt" });
  assert.equal(r.via, "gui");
  assert.equal(guiCalls.length, 1);
  assert.equal(guiCalls[0].app, "notepad");
  assert.match(r.commandError, /命令通道炸了/);
});

test("route: 命令与 GUI 都失败 → 抛出合并错误", async () => {
  const cmd = {
    runCommandOp: async () => { throw new Error("cmdErr"); },
    normalizeCmdOp: (b) => ({ spec: null }),
  };
  const gui = async () => { throw new Error("guiErr"); };
  const ft = createFreeTier({ cmd, gui });

  await assert.rejects(
    () => ft.route({ op: "open", app: "x", filePath: "y" }),
    /命令通道与 GUI 模拟均失败.*cmdErr.*guiErr/,
  );
});

test("route: 无 GUI 适配器时，命令失败直接抛命令错误", async () => {
  const cmd = {
    runCommandOp: async () => { throw new Error("cmdErr"); },
    normalizeCmdOp: (b) => ({ spec: null }),
  };
  const ft = createFreeTier({ cmd }); // 不传 gui
  await assert.rejects(
    () => ft.route({ op: "launch", command: "x" }),
    /无 GUI 回退可用.*cmdErr/,
  );
});

test("route: GUI 回退在 guiLock.withLock 内执行", async () => {
  let lockOwner = null;
  const fakeLock = {
    withLock: async (owner, fn) => { lockOwner = owner; return fn("tok"); },
  };
  const cmd = {
    runCommandOp: async () => { throw new Error("fail"); },
    normalizeCmdOp: (b) => ({ spec: null }),
  };
  const gui = async () => ({ gui: true });
  const ft = createFreeTier({ cmd, gui, guiLock: fakeLock });

  const r = await ft.route({ op: "launch", command: "notepad" });
  assert.equal(r.via, "gui");
  assert.equal(lockOwner, "freetier");
});

test("route: 文本意图也能路由（经 parseOpenIntent）", async () => {
  const cmd = {
    runCommandOp: async (op) => ({ ok: true, op }),
    normalizeCmdOp: (b) => ({ spec: null }),
  };
  const ft = createFreeTier({ cmd });
  const r = await ft.route("用 notepad 打开 a.txt");
  assert.equal(r.via, "command");
  assert.equal(r.intent.app, "notepad");
  assert.equal(r.intent.filePath, "a.txt");
});

test("normalizeIntent: 兜底与 cmd 默认", () => {
  const it = normalizeIntent({ op: "open", app: "x" });
  assert.equal(it.command, "x", "open 的 command 默认等于 app");
  assert.deepEqual(it.args, []);
  assert.equal(normalizeIntent(null), null);
  assert.equal(normalizeIntent("不是对象"), null);
});
