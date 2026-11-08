import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  POLICY_CHANGE_KINDS,
  POLICY_PHASES,
  POLICY_ERRORS,
  createPolicyTransition,
  assertSeparateFromStop,
  drainPlan,
} from "../policyTransition.mjs";

const mk = (opts) => createPolicyTransition(opts);
const base = (over = {}) => ({ id: "chg-1", kind: "rule", tickets: ["t1", "t2"], ...over });

function bad(change, code) {
  const r = mk().propose(change);
  assert.equal(r.ok, false);
  assert.equal(r.code, code);
}

// 1. 枚举与四档 kind / 各类校验错误码
test("枚举冻结且 rule / capability / roster / prompt 四档均可 propose", () => {
  assert.ok(Object.isFrozen(POLICY_CHANGE_KINDS));
  assert.ok(Object.isFrozen(POLICY_PHASES));
  assert.ok(Object.isFrozen(POLICY_ERRORS));
  for (const kind of ["rule", "capability", "roster", "prompt"]) {
    assert.ok(Object.values(POLICY_CHANGE_KINDS).includes(kind));
    const r = mk().propose(base({ id: `kind-${kind}`, kind, tickets: [] }));
    assert.equal(r.ok, true);
    assert.equal(r.phase, "proposed");
  }
});

test("缺 id / 缺 kind / bad tickets / 非法值 → 对应错误码", () => {
  bad({ kind: "rule", tickets: [] }, "invalid-id");
  bad({ id: "x", tickets: [] }, "invalid-kind");
  bad({ id: "x", kind: "rule", tickets: "nope" }, "invalid-tickets");
  bad({ id: "x", kind: "rule" }, "invalid-tickets");
  bad({ id: "   ", kind: "rule", tickets: [] }, "invalid-id");
  bad({ id: "x", kind: "bogus", tickets: [] }, "invalid-kind");
});

test("同 id 重复 → duplicate-id", () => {
  const t = mk();
  assert.equal(t.propose(base({ id: "dup" })).ok, true);
  const r = t.propose(base({ id: "dup", kind: "prompt" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "duplicate-id");
  assert.equal(t.state().policyEpoch, 0);
});

test("已有 active 时新 id → active-change-in-flight", () => {
  const t = mk();
  assert.equal(t.propose(base({ id: "c1" })).ok, true);
  const r = t.propose(base({ id: "c2" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "active-change-in-flight");
  assert.equal(t.state().policyEpoch, 0);
});

// 2. 核心契约：策略变更不是急停
test("核心契约：propose 不动 policyEpoch / 通知无 kill / isStopLike false / assertSeparateFromStop 抓 kill", () => {
  const t = mk();
  const before = t.state().policyEpoch;
  assert.equal(before, 0);

  const change = base({ id: "core", tickets: ["a", "b"] });
  const res = t.propose(change);
  assert.equal(res.ok, true);
  assert.equal(res.phase, "proposed");
  assert.equal(res.stopLike, false);
  assert.equal(t.state().policyEpoch, before);
  assert.equal(t.stats().policyEpoch, 0);

  assert.equal(res.notifications.length, 2);
  const serialized = JSON.stringify(res.notifications);
  assert.ok(!serialized.includes("kill"));
  assert.ok(!serialized.includes("hardStop"));
  for (const n of res.notifications) {
    assert.equal(n.type, "policy-change-notice");
    assert.equal(n.ask, "checkpoint");
    assert.equal(n.changeId, "core");
    assert.ok(!("kill" in n));
    assert.ok(!("hardStop" in n));
    assert.ok(!("abortAll" in n));
  }
  assert.equal(t.isStopLike(), false);

  const clean = assertSeparateFromStop(change);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.bad, []);
  const dirty = assertSeparateFromStop({ ...change, kill: true });
  assert.equal(dirty.ok, false);
  assert.ok(dirty.bad.includes("kill"));

  const plan = drainPlan(change);
  assert.equal(plan.changeId, "core");
  assert.equal(plan.allowHardStop, false);
  assert.equal(plan.notices.length, 2);
  assert.equal(plan.notices[0].ask, "checkpoint");
});

// 3. 多 ticket 收敛：readyToCommit 只在最后一个 quiesce 后为真
test("多 ticket 收敛：逐个 checkpoint / quiesce，最后一个才 readyToCommit", () => {
  const t = mk();
  assert.equal(t.propose(base({ id: "multi", tickets: ["a", "b", "c"] })).ok, true);

  const cpA = t.checkpoint("a", { q: 1 });
  assert.equal(cpA.ok, true);
  assert.equal(cpA.phase, "checkpointed");
  const qA = t.quiesce("a", "clean");
  assert.equal(qA.ok, true);
  assert.equal(qA.readyToCommit, false);
  assert.deepEqual(qA.remaining, ["b", "c"]);

  assert.equal(t.checkpoint("b", { q: 2 }).ok, true);
  const qB = t.quiesce("b");
  assert.equal(qB.readyToCommit, false);
  assert.deepEqual(qB.remaining, ["c"]);

  // 干净回滚路径：不 checkpoint，直接静默
  const qC = t.quiesce("c", "rolled-back");
  assert.equal(qC.ok, true);
  assert.equal(qC.readyToCommit, true);
  assert.deepEqual(qC.remaining, []);
  assert.equal(t.state().draining.length, 0);
  assert.equal(t.state().pending.length, 0);
});

// 4. 未收敛就 commit 必须被拒
test("未收敛 commit → tickets-still-active", () => {
  const t = mk();
  t.propose(base({ id: "still", tickets: ["a", "b"] }));
  assert.equal(t.quiesce("a").readyToCommit, false);
  const r = t.commit();
  assert.equal(r.ok, false);
  assert.equal(r.code, "tickets-still-active");
  assert.deepEqual(r.remaining, ["b"]);
  assert.equal(t.state().policyEpoch, 0);
  assert.equal(t.stats().committed, 0);
  assert.equal(t.stats().active, true);
});

// 5. commit 后 epoch+1 / active 清空 / history 记到 / 计数单调
test("commit：epoch+1、active 清空、history 记到，且 commit 不影响其它计数", () => {
  const t = mk();
  t.propose(base({ id: "g1", tickets: ["a"] }));
  t.checkpoint("a", { x: 1 });
  t.quiesce("a");
  const c1 = t.commit();
  assert.equal(c1.ok, true);
  assert.equal(c1.policyEpoch, 1);
  assert.equal(c1.phase, "committed");
  assert.equal(c1.stopLike, false);

  const s1 = t.state();
  assert.equal(s1.policyEpoch, 1);
  assert.equal(s1.active, null);
  assert.equal(s1.draining.length, 0);
  assert.equal(s1.history.length, 1);
  assert.equal(s1.history[0].phase, "committed");
  assert.equal(s1.history[0].policyEpoch, 1);
  assert.equal(s1.history[0].changeId, "g1");

  const st1 = t.stats();
  assert.equal(st1.proposed, 1);
  assert.equal(st1.committed, 1);
  assert.equal(st1.rolledBack, 0);
  assert.equal(st1.rejected, 0);
  assert.equal(st1.checkpoints, 1);
  assert.equal(st1.active, false);

  // 空 tickets 也可直接换代；再 commit 一次，计数继续单调递增且不被重置
  t.propose(base({ id: "g2", kind: "prompt", tickets: [] }));
  const c2 = t.commit();
  assert.equal(c2.ok, true);
  assert.equal(c2.policyEpoch, 2);
  const st2 = t.stats();
  assert.equal(st2.proposed, 2);
  assert.equal(st2.committed, 2);
  assert.equal(st2.rolledBack, 0);
  assert.equal(st2.rejected, 0);
  assert.equal(st2.checkpoints, 1);
  assert.equal(t.state().history.length, 2);
});

// 6. rollback / reject 不递增 epoch
test("rollback / reject 均不递增 policyEpoch，并记入对应 phase", () => {
  const t1 = mk();
  t1.propose(base({ id: "rb" }));
  const r1 = t1.rollback("准入回退");
  assert.equal(r1.ok, true);
  assert.equal(r1.phase, "rolled_back");
  assert.equal(r1.reason, "准入回退");
  assert.equal(r1.policyEpoch, 0);
  assert.equal(t1.state().active, null);
  assert.equal(t1.state().policyEpoch, 0);
  assert.equal(t1.state().history[0].phase, "rolled_back");
  assert.equal(t1.stats().rolledBack, 1);
  assert.equal(t1.stats().committed, 0);

  const t2 = mk();
  t2.propose(base({ id: "rj" }));
  const r2 = t2.reject("准入不通过");
  assert.equal(r2.ok, true);
  assert.equal(r2.phase, "rejected");
  assert.equal(r2.reason, "准入不通过");
  assert.equal(r2.policyEpoch, 0);
  assert.equal(t2.state().policyEpoch, 0);
  assert.equal(t2.state().history[0].phase, "rejected");
  assert.equal(t2.stats().rejected, 1);
  assert.equal(t2.stats().committed, 0);
});

// 7. state() 深拷贝快照不可被外部污染
test("state() 返回深拷贝快照，外部改动不污染内部", () => {
  const t = mk();
  t.propose(base({ id: "snap", tickets: ["a", "b"], payload: { deep: { v: 1 } } }));
  t.checkpoint("a", { s: 1 });

  const s = t.state();
  s.policyEpoch = 999;
  s.active.id = "hacked";
  s.active.payload.deep.v = 999;
  s.pending.push("X");
  s.draining.push("X");
  s.history.push({ fake: true });

  const s2 = t.state();
  assert.equal(s2.policyEpoch, 0);
  assert.equal(s2.active.id, "snap");
  assert.equal(s2.active.payload.deep.v, 1);
  assert.deepEqual(s2.pending, ["b"]);
  assert.deepEqual(s2.draining, ["a", "b"]);
  assert.equal(s2.history.length, 0);
});

// 附加：注入钩子仅作纯记录
test("注入的 now / notify / onCheckpoint / onRollback 仅作纯记录被调用", () => {
  const log = { notices: null, cps: [], rbs: [] };
  const t = createPolicyTransition({
    now: () => 777,
    notify: (n) => { log.notices = n; },
    onCheckpoint: (id, snap) => { log.cps.push([id, snap]); },
    onRollback: (reason) => { log.rbs.push(reason); },
  });
  t.propose(base({ id: "hook", tickets: ["a"] }));
  assert.equal(log.notices.length, 1);
  assert.equal(log.notices[0].ask, "checkpoint");
  t.checkpoint("a", { q: 9 });
  assert.equal(log.cps.length, 1);
  assert.equal(log.cps[0][0], "a");
  assert.deepEqual(log.cps[0][1], { q: 9 });
  t.rollback("why");
  assert.equal(log.rbs.length, 1);
  assert.equal(log.rbs[0], "why");
  assert.equal(t.state().history[0].at, 777);
});

// 附加：边界错误码
test("no-active / bad-outcome / unknown-ticket 边界", () => {
  const t = mk();
  assert.equal(t.checkpoint("x").code, "no-active-change");
  assert.equal(t.quiesce("x").code, "no-active-change");
  assert.equal(t.commit().code, "no-active-change");
  t.propose(base({ id: "edge", tickets: ["a"] }));
  assert.equal(t.quiesce("a", "nuke").code, "bad-outcome");
  assert.equal(t.checkpoint("zzz").code, "unknown-ticket");
  assert.equal(t.quiesce("zzz").code, "unknown-ticket");
  assert.equal(POLICY_ERRORS.TICKETS_STILL_ACTIVE, "tickets-still-active");
  assert.equal(POLICY_PHASES.ROLLED_BACK, "rolled_back");
});

// 8. 源码静态契约：禁用字符串与 import 语句
test("源码静态契约：不含 bumpEpoch / doStop / STOP.epoch，且 import 语句为零", () => {
  const src = fs.readFileSync(new URL("../policyTransition.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("bumpEpoch"));
  assert.ok(!src.includes("doStop"));
  assert.ok(!src.includes("STOP.epoch"));
  assert.equal((src.match(/\bimport\b/g) || []).length, 0);
  assert.equal((src.match(/^\s*import\s/gm) || []).length, 0);
  assert.ok(/\bexport\b/.test(src), "仍是导出的 ES module");
});
