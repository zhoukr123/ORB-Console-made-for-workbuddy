import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommandable, planTask } from "../taskRouter.mjs";

/* 纯规则分类器，不依赖桌面；只验证"能不能命令化"的判定，不执行任何动作。 */

test("用 X 打开 Y（路径明确）→ 命令化", () => {
  const c = classifyCommandable("用 notepad 打开 D:/a.txt");
  assert.equal(c.commandable, true);
  assert.equal(c.rule, "open-launch");
  assert.equal(c.intent.app, "notepad");
  assert.equal(c.intent.filePath, "D:/a.txt");
  assert.ok(c.confidence >= 0.9);
});

test("打开 <路径带扩展名> → 命令化", () => {
  const c = classifyCommandable("打开 D:/报告.pdf");
  assert.equal(c.commandable, true);
  assert.equal(c.intent.filePath, "D:/报告.pdf");
});

test("运行 <程序名> → 命令化", () => {
  const c = classifyCommandable("运行 notepad");
  assert.equal(c.commandable, true);
  assert.equal(c.intent.op, "launch");
  assert.equal(c.intent.command, "notepad");
});

test("把 内容 写入 路径 → 命令化（含引号内容）", () => {
  const c = classifyCommandable("把「你好」保存到 C:/b.txt");
  assert.equal(c.commandable, true);
  assert.equal(c.rule, "write");
  assert.equal(c.intent.content, "你好");
  assert.equal(c.intent.filePath, "C:/b.txt");
});

test("含界面交互信号 → 一律交给视觉（即便内容像命令）", () => {
  assert.equal(classifyCommandable("点击打开按钮 D:/a.txt").commandable, false);
  assert.equal(classifyCommandable("在弹窗里输入文件名").commandable, false);
  assert.equal(classifyCommandable("拖拽文件到回收站").commandable, false);
});

test("打开 <模糊目标> → 不命令化（交视觉）", () => {
  const c = classifyCommandable("打开设置");
  assert.equal(c.commandable, false);
  assert.equal(c.confidence < 0.9, true);
});

test("运行 <中文名> → 不命令化（不像程序名）", () => {
  assert.equal(classifyCommandable("运行 设置").commandable, false);
});

test("普通闲话 → 不命令化", () => {
  assert.equal(classifyCommandable("今天天气不错").commandable, false);
  assert.equal(classifyCommandable("").commandable, false);
});

test("planTask：可命令化 → via=command", () => {
  const p = planTask("用 notepad 打开 D:/a.txt");
  assert.equal(p.via, "command");
  assert.equal(p.ok, true);
  assert.ok(p.intent);
  assert.ok(p.confidence >= 0.9);
});

test("planTask：需视觉 → via=vision 且不带 intent", () => {
  const p = planTask("点击登录按钮");
  assert.equal(p.via, "vision");
  assert.equal(p.intent, null);
  assert.equal(p.rule, "ui-signal");
});
