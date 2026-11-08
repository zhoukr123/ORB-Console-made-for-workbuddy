import { test } from "node:test";
import assert from "node:assert/strict";
import { commandChannelArgs, hardDangerOp } from "../cmdDanger.mjs";

/* 硬闸是"危险难拦截"的最后一道，纯函数、必须钉死。 */

test("commandChannelArgs: move 归一", () => {
  const a = commandChannelArgs({ move: { from: "D:/a", to: "D:/b" } });
  assert.equal(a.op, "move");
  assert.equal(a.from, "D:/a");
  assert.equal(a.to, "D:/b");
  assert.equal(a.overwrite, "false");
});

test("commandChannelArgs: copy overwrite 归一为字符串 true", () => {
  const a = commandChannelArgs({ copy: { from: "D:/a", to: "D:/b", overwrite: true } });
  assert.equal(a.op, "copy");
  assert.equal(a.overwrite, "true");
});

test("hardDangerOp: move / rename 永远需确认", () => {
  assert.notEqual(hardDangerOp({ op: "move" }), "");
  assert.notEqual(hardDangerOp({ op: "rename" }), "");
});

test("hardDangerOp: copy+overwrite 需确认，非覆盖 copy 放行", () => {
  assert.notEqual(hardDangerOp({ op: "copy", overwrite: "true" }), "");
  assert.equal(hardDangerOp({ op: "copy", overwrite: "false" }), "");
});

test("hardDangerOp: write / launch / openWith 不在硬闸（走可配置 DANGER）", () => {
  assert.equal(hardDangerOp({ op: "write", path: "D:/a.txt" }), "");
  assert.equal(hardDangerOp({ op: "launch", command: "notepad" }), "");
  assert.equal(hardDangerOp({ op: "openWith", command: "notepad" }), "");
});
