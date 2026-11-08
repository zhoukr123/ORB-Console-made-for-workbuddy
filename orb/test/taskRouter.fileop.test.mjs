import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommandable, probeCommandable } from "../taskRouter.mjs";
import { intentToCmdOp } from "../freetier.mjs";

function fakeProber({ whichMap = {}, existsSet = [] } = {}) {
  const exists = new Set(existsSet);
  return {
    which: async (n) => whichMap[n] || "",
    exists: async (p) => exists.has(p),
    isDir: () => false,
  };
}

test("复制：两端路径明确 → 命令化，danger=false", () => {
  const c = classifyCommandable("把 D:/a.txt 复制到 D:/b.txt");
  assert.equal(c.commandable, true);
  assert.equal(c.intent.op, "copy");
  assert.equal(c.intent.from, "D:/a.txt");
  assert.equal(c.intent.to, "D:/b.txt");
  assert.equal(c.intent.danger, false);
});

test("移动 → danger=true", () => {
  const m = classifyCommandable("把 D:/a.txt 移动到 D:/b.txt");
  assert.equal(m.commandable, true);
  assert.equal(m.intent.op, "move");
  assert.equal(m.intent.danger, true);
});

test("重命名 → danger=true", () => {
  const r = classifyCommandable("把 D:/a.txt 重命名为 D:/b.txt");
  assert.equal(r.commandable, true);
  assert.equal(r.intent.op, "rename");
  assert.equal(r.intent.danger, true);
});

test("复制 + 覆盖 → overwrite=true, danger=true", () => {
  const c = classifyCommandable("把 D:/a.txt 复制到 D:/b.txt 覆盖");
  assert.equal(c.intent.op, "copy");
  assert.equal(c.intent.overwrite, true);
  assert.equal(c.intent.danger, true);
});

test("路径不明确（报告→归档）→ 交视觉", () => {
  assert.equal(classifyCommandable("把报告复制到归档").commandable, false);
});

test("probe copy：源存在、根存在、目标不存在 → 命令化", async () => {
  const c = await probeCommandable(
    "把 D:/a.txt 复制到 D:/b.txt",
    fakeProber({ existsSet: ["D:/a.txt", "D:/"] }),
  );
  assert.equal(c.commandable, true);
  assert.equal(c.probe.fromExists, true);
});

test("probe copy：源不存在 → 视觉", async () => {
  const c = await probeCommandable(
    "把 D:/a.txt 复制到 D:/b.txt",
    fakeProber({ existsSet: ["D:/"] }),
  );
  assert.equal(c.commandable, false);
});

test("probe copy：目标已存在且未开覆盖 → 视觉", async () => {
  const c = await probeCommandable(
    "把 D:/a.txt 复制到 D:/b.txt",
    fakeProber({ existsSet: ["D:/a.txt", "D:/", "D:/b.txt"] }),
  );
  assert.equal(c.commandable, false);
});

test("probe move：danger 标记透传", async () => {
  const c = await probeCommandable(
    "把 D:/a.txt 移动到 D:/b.txt",
    fakeProber({ existsSet: ["D:/a.txt", "D:/"] }),
  );
  assert.equal(c.commandable, true);
  assert.equal(c.intent.danger, true);
});

test("intentToCmdOp: copy 结构正确", () => {
  const op = intentToCmdOp({ op: "copy", from: "D:/a", to: "D:/b", overwrite: false });
  assert.deepEqual(op, { copy: { from: "D:/a", to: "D:/b", overwrite: false } });
});
