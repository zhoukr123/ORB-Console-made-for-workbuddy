/* 命令通道单元测试（纯内存 / 文件系统，无 GUI 副作用）。
 * 运行：node --test orb/test/cmdchan.test.mjs
 *
 * 默认不弹任何窗口：真实启动程序被 ORB_CMDCHAN_LAUNCH_TEST=1 隔离，
 * 只有在显式开启时才真起一个 explorer 验证「用默认程序打开」能拿到 pid。 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  classifyApp, buildOpenWith, normalizeCmdOp,
  writeTextFile, launchApp, runCommandOp,
} from "../cmdchan.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orb-cmdchan-"));

test("classifyApp：shell 必被识别拒绝", () => {
  assert.equal(classifyApp("cmd.exe"), "shell");
  assert.equal(classifyApp("powershell"), "shell");
  assert.equal(classifyApp("C:\\Windows\\System32\\cmd.exe"), "shell");
  assert.equal(classifyApp(""), "empty");
});

test("classifyApp：已知查看器与安全程序", () => {
  assert.equal(classifyApp("notepad.exe"), "viewer");
  assert.equal(classifyApp("explorer.exe"), "viewer");
  assert.equal(classifyApp("D:\\foo\\bar.exe"), "app");
});

test("buildOpenWith：指定程序 → command + [file]", () => {
  assert.deepEqual(buildOpenWith("notepad.exe", "x.txt"), { command: "notepad.exe", args: ["x.txt"] });
  assert.deepEqual(buildOpenWith("", "x.txt"), { command: "explorer.exe", args: ["x.txt"] });
  assert.deepEqual(buildOpenWith(null, null), { command: "explorer.exe", args: [] });
});

test("normalizeCmdOp：launch / openWith / write 三种形态", () => {
  assert.deepEqual(
    normalizeCmdOp({ launch: { command: "foo.exe", args: ["a", "b"] } }),
    { write: null, spec: { command: "foo.exe", args: ["a", "b"] } });
  assert.deepEqual(
    normalizeCmdOp({ openWith: { app: "notepad.exe", filePath: "x.txt" } }),
    { write: null, spec: { command: "notepad.exe", args: ["x.txt"] } });
  assert.deepEqual(
    normalizeCmdOp({ write: { filePath: "x.txt", content: "hi" } }),
    { write: { filePath: "x.txt", content: "hi", encoding: "utf8" }, spec: null });
});

test("writeTextFile：强制 UTF-8，中文不乱码，自动建目录", async () => {
  const dir = tmp();
  const p = path.join(dir, "sub", "笔记.txt");
  const r = await writeTextFile({ filePath: p, content: "你好，ORB 命令通道" });
  assert.equal(r.path, p);
  assert.equal(Buffer.byteLength("你好，ORB 命令通道", "utf8"), r.bytes);
  assert.equal(fs.readFileSync(p, "utf8"), "你好，ORB 命令通道");
});

test("launchApp：拒绝 shell", async () => {
  await assert.rejects(
    () => launchApp({ command: "cmd.exe", args: ["/c", "echo"] }),
    /拒绝启动 shell/);
});

test("runCommandOp：空操作报错", async () => {
  await assert.rejects(() => runCommandOp({}), /至少一项/);
});

test("runCommandOp：写文件 + 拒绝 shell 启动，写仍成功", async () => {
  const dir = tmp();
  const p = path.join(dir, "f.txt");
  await assert.rejects(
    () => runCommandOp({ write: { filePath: p, content: "x" }, launch: { command: "cmd.exe" } }),
    /拒绝启动 shell/);
  // 写文件这一步不回滚、已落盘
  assert.equal(fs.readFileSync(p, "utf8"), "x");
});

// 仅在显式开启时真起程序，避免默认跑测试时弹出窗口。
if (process.env.ORB_CMDCHAN_LAUNCH_TEST === "1") {
  test("launchApp：用默认关联打开文件能拿到 pid（真实）", async () => {
    const dir = tmp();
    const p = path.join(dir, "open.txt");
    fs.writeFileSync(p, "launch test");
    const r = await launchApp({ command: "explorer.exe", args: [p] });
    assert.ok(Number.isInteger(r.pid) && r.pid > 0, "应返回有效 pid");
  });
}
