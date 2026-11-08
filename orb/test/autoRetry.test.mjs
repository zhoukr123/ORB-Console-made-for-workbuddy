import test from "node:test";
import assert from "node:assert/strict";
import {
  RISK, DEFAULT_RETRY, riskOf, classifyRetryability,
  backoffMs, shouldRetry, stepIdemKey, argsFingerprint,
} from "../autoRetry.mjs";

test("riskOf：只读优先，其次可撤销，其余不可逆", () => {
  assert.equal(riskOf({ readOnly: true, revocable: true }), RISK.READONLY);
  assert.equal(riskOf({ readOnly: false, revocable: true }), RISK.REVERSIBLE);
  assert.equal(riskOf({}), RISK.IRREVERSIBLE);
});

test("只读 + STALE_REF 可重试", () => {
  const r = classifyRetryability({ code: "STALE_REF", risk: RISK.READONLY });
  assert.equal(r.retryable, true);
});

test("可撤销 + AMBIGUOUS_TARGET 可重试", () => {
  assert.equal(classifyRetryability({ code: "AMBIGUOUS_TARGET", risk: RISK.REVERSIBLE }).retryable, true);
});

test("不可逆动作一律不重试（哪怕错误码可重试）", () => {
  const r = classifyRetryability({ code: "STALE_REF", risk: RISK.IRREVERSIBLE });
  assert.equal(r.retryable, false);
  assert.match(r.reason, /不可逆/);
});

test("PERM_DENIED 不重试", () => {
  const r = classifyRetryability({ code: "PERM_DENIED", risk: RISK.READONLY });
  assert.equal(r.retryable, false);
  assert.match(r.reason, /权限|急停/);
});

test("平台/版本绑定类失败不重试", () => {
  for (const code of ["PLATFORM_NOT_SUPPORTED", "SNAPSHOT_MISMATCH", "TOOL_VERSION_MISMATCH"]) {
    assert.equal(classifyRetryability({ code, risk: RISK.READONLY }).retryable, false, code);
  }
});

test("从错误文本自动分类：带 ref 的失败按 STALE_REF 处理", () => {
  const r = classifyRetryability({ errorText: "元素已失效", hadRef: true, risk: RISK.READONLY });
  assert.equal(r.code, "STALE_REF");
  assert.equal(r.retryable, true);
});

test("backoffMs 指数退避并封顶（jitter:none 保留可复算的纯指数）", () => {
  const plain = { jitter: "none" };
  assert.equal(backoffMs(0, plain), 300);
  assert.equal(backoffMs(1, plain), 600);
  assert.equal(backoffMs(2, plain), 1200);
  assert.equal(backoffMs(9, plain), DEFAULT_RETRY.maxMs);
});

test("backoffMs 默认 Full Jitter：落在 [地板, 指数封顶] 区间内", () => {
  /* 注入 rnd 让断言可复算：0 → 地板，1 → 指数封顶，0.5 → 一半。 */
  assert.equal(backoffMs(2, {}, { rnd: () => 0 }), DEFAULT_RETRY.floorMs);
  assert.equal(backoffMs(2, {}, { rnd: () => 1 }), 1200);
  assert.equal(backoffMs(2, {}, { rnd: () => 0.5 }), 600);
  /* 封顶之后抖动上限也不再超 maxMs。 */
  assert.equal(backoffMs(9, {}, { rnd: () => 1 }), DEFAULT_RETRY.maxMs);
  /* 抖动下限不能高过封顶（否则会出现"越退越快"）。 */
  assert.equal(backoffMs(0, { baseMs: 20, floorMs: 500 }, { rnd: () => 0 }), 20);
});

test("backoffMs 抖动真的在变：同一档两次一般不同，且都不越界", () => {
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const v = backoffMs(3);
    assert.ok(v >= DEFAULT_RETRY.floorMs && v <= 2400);
    seen.add(v);
  }
  assert.ok(seen.size > 1, "40 次全一样说明根本没抖动");
});

test("backoffMs 注入坏 rnd 不崩，退成封顶值", () => {
  assert.equal(backoffMs(1, {}, { rnd: () => NaN }), 600);
  /* 不是函数就当没注入，走真随机 —— 只断言不越界，不假装它等于某个值。 */
  const v = backoffMs(1, {}, { rnd: "x" });
  assert.ok(v >= DEFAULT_RETRY.floorMs && v <= 600, String(v));
});

test("shouldRetry：达上限后不再重试", () => {
  assert.equal(shouldRetry({ code: "STALE_REF", risk: RISK.READONLY, attempt: 0 }).retry, true);
  assert.equal(shouldRetry({ code: "STALE_REF", risk: RISK.READONLY, attempt: 1 }).retry, true);
  const third = shouldRetry({ code: "STALE_REF", risk: RISK.READONLY, attempt: 2 });
  assert.equal(third.retry, false);
  assert.match(third.reason, /上限/);
});

test("shouldRetry 支持自定义策略", () => {
  const r = shouldRetry({ code: "STALE_REF", risk: RISK.READONLY, attempt: 1, policy: { maxAttempts: 1 } });
  assert.equal(r.retry, false);
});

test("stepIdemKey 与参数键序无关，同一步稳定复算", () => {
  const a = stepIdemKey({ runId: "wr-1", stepNo: 3, server: "desktop", tool: "click", args: { x: 1, y: 2 } });
  const b = stepIdemKey({ runId: "wr-1", stepNo: 3, server: "desktop", tool: "click", args: { y: 2, x: 1 } });
  assert.equal(a, b);
});

test("不同步 / 不同参数得到不同键", () => {
  const base = { runId: "wr-1", stepNo: 3, server: "desktop", tool: "click", args: { x: 1 } };
  assert.notEqual(stepIdemKey(base), stepIdemKey({ ...base, stepNo: 4 }));
  assert.notEqual(stepIdemKey(base), stepIdemKey({ ...base, args: { x: 2 } }));
  assert.notEqual(stepIdemKey(base), stepIdemKey({ ...base, runId: "wr-2" }));
});

test("argsFingerprint：null 与空对象可区分，嵌套键序无关", () => {
  assert.notEqual(argsFingerprint(null), argsFingerprint({}));
  assert.equal(argsFingerprint({ a: { x: 1, y: 2 } }), argsFingerprint({ a: { y: 2, x: 1 } }));
});
