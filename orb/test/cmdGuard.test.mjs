import test from "node:test";
import assert from "node:assert/strict";
import { createCommandGate } from "../cmdGuard.mjs";

test("急停期间一律 409 且不签发 capability", () => {
  const g = createCommandGate({ isStopped: () => true, epochOf: () => 7 });
  const r = g.check({ write: { filePath: "D:/a.txt", content: "x" } });
  assert.equal(r.ok, false);
  assert.equal(r.httpStatus, 409);
  assert.equal(r.body.stopped, true);
  assert.equal(r.body.epoch, 7);
  assert.equal(g.stats().admitted, 0);
  assert.equal(g.stats().denied, 1);
});

test("正常状态签发 capability，带当代世代号", () => {
  const g = createCommandGate({ isStopped: () => false, epochOf: () => 2 });
  const r = g.check({ launch: { command: "notepad.exe" } });
  assert.equal(r.ok, true);
  assert.equal(r.epoch, 2);
  assert.equal(r.cap.epoch, 2);
  assert.equal(r.cap.scope, "command-channel");
  assert.equal(g.verify(r.cap), true);
});

test("签发后急停换代 → verify 为 false（结果不采纳）", () => {
  let stopped = false;
  let e = 1;
  const g = createCommandGate({ isStopped: () => stopped, epochOf: () => e });
  const r = g.check({});
  stopped = true; e = 2;
  assert.equal(g.verify(r.cap), false);
  assert.equal(g.check({}).httpStatus, 409);
  assert.equal(g.stats().staleAfter, 1);
});

test("onEpochAdvanced 清掉旧代签发", () => {
  let e = 1;
  const g = createCommandGate({ isStopped: () => false, epochOf: () => e });
  g.check({}); g.check({});
  assert.equal(g.clock.stats().issued, 2);
  e = 2;
  assert.equal(g.onEpochAdvanced(), 2);
  assert.equal(g.clock.stats().issued, 0);
});

test("stats 汇总可查询", () => {
  const g = createCommandGate({ isStopped: () => false, epochOf: () => 1 });
  g.check({}); g.check({});
  const s = g.stats();
  assert.equal(s.admitted, 2);
  assert.equal(s.denied, 0);
  assert.equal(s.clock.epoch, 1);
});
