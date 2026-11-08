/* affectGate 单测：六项门控的顺序与边界 / 记录与统计 / 参数热调 / 异常入参。
 * 时间全部走注入的假 now()，不依赖真实等待。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createAffectGate, GATES } from "../affectGate.mjs";

/* 可变时钟：now 返回闭包变量，advance 推进它。 */
function make(opts = {}) {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  return { gate: createAffectGate({ now: clock.now, ...opts }), clock };
}

const OK = { confidence: 0.9, urgency: "normal" };
const gateOf = (r, id) => r.gates.find((g) => g.id === id);

test("GATES 元数据：六项、order 1..6 连续、id 唯一", () => {
  assert.equal(GATES.length, 6);
  assert.deepEqual(GATES.map((g) => g.order), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(GATES.map((g) => g.id)).size, 6);
  for (const g of GATES) assert.ok(g.name && g.name.length > 0);
  assert.deepEqual(GATES.map((g) => g.id), [
    "decision-required", "stopped", "user-present", "cooldown", "confidence", "burst",
  ]);
});

test("全放行时返回契约字段，ctx 回显关键输入", () => {
  const { gate, clock } = make();
  const r = gate.evaluate({ ...OK, kind: "reminder", urgency: "high" });
  assert.deepEqual(Object.keys(r).sort(), ["ok", "pass", "blockedBy", "escalate", "gates", "ctx", "at"].sort());
  assert.equal(r.ok, true);
  assert.equal(r.pass, true);
  assert.equal(r.blockedBy, null);
  assert.equal(r.at, clock.now());
  assert.deepEqual(r.ctx, { kind: "reminder", urgency: "high", confidence: 0.9 });
  assert.equal(r.gates.length, 6, "六项都要给结论");
  assert.ok(r.gates.every((g) => typeof g.reason === "string" && g.reason.length > 0));
});

test("决策必需直通：stopped + 冷却中 + 置信度 0 也放行，并跳过其余五项", () => {
  const { gate, clock } = make({ cooldownMs: 180_000 });
  gate.evaluate(OK); // 先制造一次「刚说过话」
  clock.advance(1000);
  const r = gate.evaluate({
    decisionRequired: true,
    stopped: true,
    confidence: 0,
    lastSpokeAt: clock.now(),
    userActiveAt: clock.now(),
    urgency: "low",
  });
  assert.equal(r.pass, true);
  assert.equal(r.blockedBy, null);
  assert.equal(r.gates.length, 6);
  assert.ok(r.gates.every((g) => g.pass), "六项都应为跳过/通过");
  assert.equal(gateOf(r, "decision-required").reason.includes("直通"), true);
  for (const id of ["stopped", "user-present", "cooldown", "confidence", "burst"]) {
    assert.ok(gateOf(r, id).reason.includes("跳过"), `${id} 应标为跳过`);
  }
  assert.equal(r.escalate, false, "低紧急度不升级");
});

test("急停态抑制：非决策必需时被 stopped 拦下", () => {
  const { gate } = make();
  const r = gate.evaluate({ ...OK, stopped: true });
  assert.equal(r.pass, false);
  assert.equal(r.blockedBy, "stopped");
  assert.equal(gateOf(r, "stopped").pass, false);
});

test("用户在场静默：最近操作距今不足 90s 拦下", () => {
  const { gate, clock } = make();
  const r = gate.evaluate({ ...OK, userActiveAt: clock.now() - 1000 });
  assert.equal(r.pass, false);
  assert.equal(r.blockedBy, "user-present");
  assert.equal(gateOf(r, "user-present").pass, false);
  assert.ok(gateOf(r, "user-present").reason.includes("静默窗"));
});

test("冷却窗口：距上次主动开口不足 180s 拦下", () => {
  const { gate, clock } = make();
  const first = gate.evaluate(OK);
  assert.equal(first.pass, true);
  clock.advance(60_000);
  const r = gate.evaluate(OK);
  assert.equal(r.pass, false);
  assert.equal(r.blockedBy, "cooldown");
  assert.ok(gateOf(r, "cooldown").reason.includes("还差"));
});

test("冷却边界：差值恰好等于 cooldownMs 放行", () => {
  const { gate, clock } = make();
  assert.equal(gate.evaluate(OK).pass, true);
  clock.advance(180_000);
  const r = gate.evaluate(OK);
  assert.equal(r.pass, true, "刚好到期就该能说话");
  assert.equal(r.blockedBy, null);
});

test("用户在场边界：差值恰好等于 presentWindowMs 放行", () => {
  const { gate, clock } = make();
  const r = gate.evaluate({ ...OK, userActiveAt: clock.now() - 90_000 });
  assert.equal(r.pass, true);
  assert.equal(gateOf(r, "user-present").pass, true);
});

test("置信度阈值：0.59 拦下、0.60 放行（默认阈值 0.6）", () => {
  const { gate } = make();
  assert.equal(gate.options().minConfidence, 0.6);
  const low = gate.evaluate({ confidence: 0.59 });
  assert.equal(low.pass, false);
  assert.equal(low.blockedBy, "confidence");

  const { gate: g2 } = make();
  const edge = g2.evaluate({ confidence: 0.6 });
  assert.equal(edge.pass, true);
  assert.equal(gateOf(edge, "confidence").pass, true);
});

test("置信度缺失按 0 处理，宁可不打扰", () => {
  const { gate } = make();
  const r = gate.evaluate({ urgency: "normal" });
  assert.equal(r.ctx.confidence, 0);
  assert.equal(r.pass, false);
  assert.equal(r.blockedBy, "confidence");
});

test("连续打扰熔断：窗口内第 4 次主动开口被拦（cooldown 置 0 以隔离变量）", () => {
  const { gate, clock } = make({ cooldownMs: 0 });
  for (let i = 0; i < 3; i++) {
    assert.equal(gate.evaluate(OK).pass, true, `第 ${i + 1} 次应放行`);
    clock.advance(1000);
  }
  const r = gate.evaluate(OK);
  assert.equal(r.pass, false);
  assert.equal(r.blockedBy, "burst");
  assert.equal(gateOf(r, "burst").pass, false);
  assert.ok(gateOf(r, "burst").reason.includes("上限 3"));
});

test("熔断窗口外重新计数：超过 burstWindowMs 的旧开口不算", () => {
  const { gate, clock } = make({ cooldownMs: 0, burstMax: 2 });
  gate.evaluate(OK);
  gate.evaluate(OK); // 已 2 次，再开口会被熔断
  clock.advance(300_000); // 旧记录刚好滑出窗口
  const r = gate.evaluate(OK);
  assert.equal(r.pass, true);
});

test("escalate 只是紧急度提示，不能越过门控", () => {
  const { gate, clock } = make();
  const hot = gate.evaluate({ confidence: 0.9, urgency: "high" });
  assert.equal(hot.pass, true);
  assert.equal(hot.escalate, true);

  const weak = gate.evaluate({ confidence: 0.5, urgency: "high" });
  assert.equal(weak.pass, false);
  assert.equal(weak.escalate, false, "没把握时不能借紧急度提前呈现");

  const { gate: g2, clock: c2 } = make();
  const busy = g2.evaluate({ confidence: 0.9, urgency: "high", userActiveAt: c2.now() - 1000 });
  assert.equal(busy.pass, false);
  assert.equal(busy.blockedBy, "user-present");
  assert.equal(busy.escalate, false, "用户正在操作时同样不得越权");
  void clock;
});

test("ctx.lastSpokeAt 优先于内部记录，可跨进程续接冷却", () => {
  const { gate, clock } = make();
  const fresh = gate.evaluate({ ...OK, lastSpokeAt: clock.now() - 1000 });
  assert.equal(fresh.blockedBy, "cooldown", "内部无记录时用外部时间");

  const { gate: g2, clock: c2 } = make();
  g2.evaluate(OK);
  c2.advance(10_000);
  const override = g2.evaluate({ ...OK, lastSpokeAt: c2.now() - 999_999 });
  assert.equal(override.pass, true, "外部时间显式给定时不采信内部记录");
});

test("stats：byGate 计数与 passRate 计算正确", () => {
  const { gate } = make({ cooldownMs: 0 });
  gate.evaluate(OK);                                  // 放行
  gate.evaluate({ confidence: 0.1 });                 // confidence 拦
  gate.evaluate({ ...OK, stopped: true });            // stopped 拦

  const s = gate.stats();
  assert.equal(s.ok, true);
  assert.equal(s.total, 3);
  assert.equal(s.passed, 1);
  assert.equal(s.blocked, 2);
  assert.equal(s.byGate.confidence, 1);
  assert.equal(s.byGate.stopped, 1);
  assert.equal(s.byGate.cooldown, 0);
  assert.equal(s.byGate.burst, 0);
  assert.equal(s.passRate, 0.3333);
  assert.equal(typeof s.lastAt, "number");
  assert.equal(Object.keys(s.byGate).length, 6, "六项都应有计数位");
});

test("records：新的在前、limit 生效、total 为缓冲内条数", () => {
  const { gate } = make({ cooldownMs: 0, burstMax: 999 });
  for (let i = 0; i < 5; i++) gate.evaluate({ ...OK, kind: `k${i}` });

  const all = gate.records();
  assert.equal(all.ok, true);
  assert.equal(all.total, 5);
  assert.equal(all.rows.length, 5);
  assert.equal(all.rows[0].kind, "k4");
  assert.equal(all.rows[4].kind, "k0");

  const page = gate.records({ limit: 2 });
  assert.equal(page.total, 5, "limit 只影响返回条数");
  assert.deepEqual(page.rows.map((r) => r.kind), ["k4", "k3"]);
  assert.deepEqual(Object.keys(page.rows[0]).sort(), ["at", "pass", "blockedBy", "kind", "urgency"].sort());

  assert.deepEqual(gate.records({ limit: 0 }).rows, []);
  assert.equal(gate.records({ limit: "x" }).rows.length, 5, "非法 limit 退回默认值");
});

test("环形缓冲上限 200：累计计数不丢，可查记录被截断", () => {
  const { gate } = make({ cooldownMs: 0, burstMax: 999 });
  for (let i = 0; i < 250; i++) gate.evaluate(OK);
  assert.equal(gate.stats().total, 250);
  const rec = gate.records({ limit: 500 });
  assert.equal(rec.total, 200);
  assert.equal(rec.rows.length, 200);
});

test("setOptions：非法值被忽略且不生效，合法值立即生效", () => {
  const { gate } = make();
  const defaults = gate.options();
  assert.deepEqual(defaults, {
    presentWindowMs: 90_000, cooldownMs: 180_000, minConfidence: 0.6, burstWindowMs: 300_000, burstMax: 3,
  });

  const bad = gate.setOptions({ presentWindowMs: -1, minConfidence: 2, burstMax: "4", cooldownMs: NaN });
  assert.equal(bad.ok, false);
  assert.ok(bad.error.includes("presentWindowMs"));
  assert.ok(bad.error.includes("minConfidence"));
  assert.ok(bad.error.includes("burstMax"));
  assert.ok(bad.error.includes("cooldownMs"));
  assert.deepEqual(gate.options(), defaults, "非法值一个都不能落库");

  assert.equal(gate.setOptions(null).ok, false);
  assert.equal(gate.setOptions("x").ok, false);

  const good = gate.setOptions({ presentWindowMs: 1000, minConfidence: 0.2, burstMax: 5 });
  assert.equal(good.ok, true);
  assert.equal(good.options.presentWindowMs, 1000);
  assert.equal(gate.options().minConfidence, 0.2);

  // 生效验证：静默窗收缩到 1s 后，500ms 前的操作仍算在场。
  const { gate: g2, clock } = make({ presentWindowMs: 1000 });
  assert.equal(g2.evaluate({ ...OK, userActiveAt: clock.now() - 500 }).pass, false);
});

test("reset：清空记录与统计，但保留调好的参数", () => {
  const { gate } = make({ cooldownMs: 0 });
  gate.setOptions({ presentWindowMs: 5000 });
  gate.evaluate(OK);
  gate.evaluate({ confidence: 0.1 });
  assert.equal(gate.stats().total, 2);

  assert.equal(gate.reset().ok, true);
  const s = gate.stats();
  assert.equal(s.total, 0);
  assert.equal(s.passed, 0);
  assert.equal(s.blocked, 0);
  assert.equal(s.passRate, 0);
  assert.equal(s.lastAt, null);
  assert.deepEqual(Object.values(s.byGate), [0, 0, 0, 0, 0, 0]);
  assert.equal(gate.records().total, 0);
  assert.equal(gate.options().presentWindowMs, 5000, "参数不该被 reset 冲掉");
});

test("非法入参不抛异常：返回 ok:false，且不污染统计", () => {
  const { gate } = make();
  for (const bad of [null, undefined, "ctx", 42, true]) {
    let r;
    assert.doesNotThrow(() => { r = gate.evaluate(bad); }, `不得抛异常: ${String(bad)}`);
    assert.equal(r.ok, false);
    assert.equal(r.pass, false);
    assert.equal(r.blockedBy, "invalid-input");
    assert.equal(r.gates.length, 6);
    assert.ok(r.gates.every((g) => g.reason.length > 0));
  }
  assert.equal(gate.stats().total, 0, "非法调用不进审计");
  assert.equal(gate.records().total, 0);
});
