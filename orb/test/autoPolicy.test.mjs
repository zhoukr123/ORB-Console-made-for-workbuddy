import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy, decideTransition, DEFAULT_THRESHOLDS } from "../autoPolicy.mjs";

const run = (o = {}) => ({
  status: "ok", layer: "interval", startedAt: 1000, endedAt: 2000,
  takeovers: 0, anchorFallbacks: 0, verifyFailed: 0, ...o,
});
const clean = (n, o = {}) => Array.from({ length: n }, (_, i) =>
  run({ startedAt: (i + 1) * 1000, endedAt: (i + 1) * 1000 + 500, ...o }));

test("样本不足 → observe，理由写明差多少", () => {
  const e = evaluatePolicy(clean(3));
  assert.equal(e.recommendation, "observe");
  assert.match(e.reason, /样本不足/);
  assert.equal(e.metrics.samples, 3);
});

test("连续 5 次零退化 + 有自动点火样本 → 升 auto", () => {
  const e = evaluatePolicy(clean(5));
  assert.equal(e.recommendation, "auto");
  assert.equal(e.metrics.autoFires, 5);
  assert.equal(e.metrics.maxTakeovers, 0);
});

test("只有人工回放样本也能升（否则 observe 不执行就永远攒不够数据）", () => {
  const e = evaluatePolicy(clean(5, { layer: "manual" }));
  assert.equal(e.recommendation, "auto");
  assert.equal(e.metrics.autoFires, 0);
  assert.match(e.reason, /自动点火 0 次/);
});

test("连续 2 次失败 → 立即降级", () => {
  const e = evaluatePolicy([
    run({ status: "failed", startedAt: 9000, endedAt: 9100 }),
    run({ status: "failed", startedAt: 8000, endedAt: 8100 }),
    ...clean(5),
  ]);
  assert.equal(e.failStreak, 2);
  assert.equal(e.recommendation, "observe");
  assert.equal(e.degraded, true);
  assert.match(e.reason, /连续 2 次失败/);
});

test("效果验证未通过 → 观察，不给 auto", () => {
  const e = evaluatePolicy(clean(5, { verifyFailed: 1 }));
  assert.equal(e.recommendation, "observe");
  assert.match(e.reason, /效果验证/);
});

test("接管达到阈值 / 锚定失守 / 超时，各自都挡住升级", () => {
  assert.match(evaluatePolicy(clean(5, { takeovers: 2 })).reason, /接管/);
  assert.match(evaluatePolicy(clean(5, { anchorFallbacks: 1 })).reason, /锚定/);
  assert.match(evaluatePolicy(clean(5, { endedAt: 999999 })).reason, /超预算/);
  for (const r of [clean(5, { takeovers: 2 }), clean(5, { anchorFallbacks: 1 }), clean(5, { endedAt: 999999 })]) {
    assert.equal(evaluatePolicy(r).recommendation, "observe");
  }
});

test("skipped / interrupted 不算样本，不污染判据", () => {
  const e = evaluatePolicy([...clean(5), run({ status: "skipped" }), run({ status: "interrupted" })]);
  assert.equal(e.metrics.samples, 5);
  assert.equal(e.recommendation, "auto");
});

test("阈值可覆盖（更严格的窗口）", () => {
  const e = evaluatePolicy(clean(3), { thresholds: { sampleSize: 3 } });
  assert.equal(e.recommendation, "auto");
  assert.equal(e.thresholds.sampleSize, 3);
  assert.equal(DEFAULT_THRESHOLDS.sampleSize, 5);
});

test("decideTransition：观察→自动 与 自动→观察 两个方向都成立", () => {
  const up = evaluatePolicy(clean(5));
  assert.deepEqual(decideTransition({}, up, "observe"), { change: true, mode: "auto", reason: up.reason });
  const down = evaluatePolicy([run({ status: "failed" }), run({ status: "failed" })]);
  assert.equal(decideTransition({}, down, "auto").mode, "observe");
});

test("人工锁定后系统不改决定；同 mode 不产生无谓变更", () => {
  const up = evaluatePolicy(clean(5));
  assert.equal(decideTransition({ modeLocked: true }, up, "observe").change, false);
  assert.equal(decideTransition({}, up, "auto").change, false);
});

test("尚有失败记录时不自动升级，但降级不受此限", () => {
  const e = { recommendation: "auto", reason: "", failStreak: 1 };
  assert.equal(decideTransition({}, e, "observe").change, false);
  const d = { recommendation: "observe", reason: "连续 2 次失败", failStreak: 2 };
  assert.equal(decideTransition({}, d, "auto").change, true);
});

test("空输入 / 脏输入不抛，收敛到 observe", () => {
  for (const v of [undefined, null, [], [null, 3, "x"], {}]) {
    const e = evaluatePolicy(v);
    assert.equal(e.recommendation, "observe");
  }
});
