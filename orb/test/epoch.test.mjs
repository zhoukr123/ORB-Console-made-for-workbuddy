import test from "node:test";
import assert from "node:assert/strict";
import { createEpochClock } from "../epoch.mjs";

test("世代号只读唯一来源，模块内不另存一份", () => {
  let e = 3;
  const c = createEpochClock({ epochOf: () => e, now: () => 100 });
  const t = c.issue("command-channel");
  assert.equal(t.epoch, 3);
  assert.equal(c.isCurrent(t), true);
  e = 4;
  assert.equal(c.current(), 4);
  assert.equal(c.isCurrent(t), false, "旧代 capability 立刻失效");
});

test("retire 主动撤销后 isCurrent 为 false", () => {
  const c = createEpochClock({ epochOf: () => 1 });
  const t = c.issue();
  assert.equal(c.retire(t, "取消"), true);
  assert.equal(c.isCurrent(t), false);
  assert.equal(c.retire(null), false);
});

test("guard：当代执行返回 ok", async () => {
  const c = createEpochClock({ epochOf: () => 1 });
  const r = await c.guard(c.issue(), async () => 42);
  assert.deepEqual(r, { ok: true, value: 42 });
});

test("guard：执行期间换代 → 结果不采纳", async () => {
  let e = 1;
  const c = createEpochClock({ epochOf: () => e });
  const r = await c.guard(c.issue(), async () => { e = 2; return "done"; });
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  assert.equal(c.stats().rejected, 1);
});

test("guard：执行体自身报错原样抛出，不算过期", async () => {
  const c = createEpochClock({ epochOf: () => 1 });
  await assert.rejects(() => c.guard(c.issue(), async () => { throw new Error("boom"); }), /boom/);
});

test("onEpochAdvanced 一次性清掉旧代签发", () => {
  let e = 1;
  const c = createEpochClock({ epochOf: () => e });
  c.issue("a"); c.issue("b");
  assert.equal(c.stats().issued, 2);
  e = 2;
  assert.equal(c.onEpochAdvanced(), 2);
  assert.equal(c.stats().issued, 0);
});

test("非法 token 一律拒绝", () => {
  const c = createEpochClock({ epochOf: () => 1 });
  for (const t of [null, undefined, {}, { id: "x", epoch: 1 }]) assert.equal(c.isCurrent(t), false);
});
