import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWfRunLedger } from "../wfRunLedger.mjs";

function fixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orb-wfruns-"));
  const file = path.join(root, "wf-runs.jsonl");
  let clock = opts.t0 || 1700000000000;
  const now = () => clock;
  const mk = (o = {}) => createWfRunLedger({
    file, now, newId: () => "abcd", maxRuns: opts.maxRuns || 500, ...o,
  });
  return { root, file, mk, now: () => clock, tick: (ms) => { clock += ms; },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const ev = (o = {}) => ({ triggerId: "t1", workflow: "wf_a", source: "trigger",
  layer: "interval", escalate: "once", dedupeKey: "t1|interval|1", epoch: 3, ...o });

test("一次点火 = 一条 running → 一条 ok，字段带上下文", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const b = L.begin(ev({ ticketId: "tk-1" }));
    assert.equal(b.ok, true);
    assert.equal(b.run.status, "running");
    assert.equal(b.run.layer, "interval");
    assert.equal(b.run.escalate, "once");
    assert.equal(b.run.epoch, 3);
    assert.equal(b.run.ticketId, "tk-1");
    const done = L.finish(b.run.runId, { ok: true, steps: 7, takeovers: 2, anchorFallbacks: 1 });
    assert.equal(done.status, "ok");
    assert.equal(done.steps, 7);
    assert.equal(done.takeovers, 2);          // 回放质量字段进账本
    assert.ok(done.endedAt >= done.startedAt);
    assert.equal(L.stats().running, 0);
  } finally { f.cleanup(); }
});

test("同一事件重复投递：跳过并留 duplicate 收据，不产生第二次运行", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const a = L.begin(ev());
    L.finish(a.run.runId, { ok: true });
    const b = L.begin(ev());
    assert.equal(b.ok, false);
    assert.equal(b.code, "duplicate");
    assert.equal(b.run.status, "skipped");
    assert.equal(L.list().filter((r) => r.status === "ok").length, 1);
  } finally { f.cleanup(); }
});

test("单飞：同一 triggerId 在跑时跳过新事件，且不取消旧运行（GUI 不能掐半途）", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const a = L.begin(ev({ dedupeKey: "k1" }));
    const b = L.begin(ev({ dedupeKey: "k2" }));
    assert.equal(b.ok, false);
    assert.equal(b.code, "inflight");
    assert.equal(b.run.detail.inflightRunId, a.run.runId);
    assert.equal(L.get(a.run.runId).status, "running");   // 旧运行没被动过
    assert.equal(L.stats().inflight, 1);
    L.finish(a.run.runId, { ok: true });
    assert.equal(L.stats().inflight, 0);
    assert.equal(L.begin(ev({ dedupeKey: "k3" })).ok, true);
  } finally { f.cleanup(); }
});

test("不同 triggerId 互不影响（单飞按触发器分组，不是全局锁）", () => {
  const f = fixture();
  try {
    const L = f.mk();
    L.begin(ev({ triggerId: "t1", dedupeKey: "k1" }));
    const b = L.begin(ev({ triggerId: "t2", dedupeKey: "k2" }));
    assert.equal(b.ok, true);
    assert.equal(L.stats().inflight, 2);
  } finally { f.cleanup(); }
});

test("冷却窗口内跳过；窗口过后放行；skipped 不计入冷却", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const a = L.begin(ev({ cooldownMs: 5000, dedupeKey: "k1" }));
    L.finish(a.run.runId, { ok: true });          // 先结算，否则先命中单飞而非冷却
    const r1 = L.begin(ev({ cooldownMs: 5000, dedupeKey: "k2" }));
    assert.equal(r1.code, "cooldown");
    f.tick(6000);                                 // skipped 不刷新冷却起点
    const r2 = L.begin(ev({ cooldownMs: 5000, dedupeKey: "k3" }));
    assert.equal(r2.ok, true);
  } finally { f.cleanup(); }
});

test("安全闸门拦下也留痕（急停/能力清单/危险确认）", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const b = L.begin(ev({ blockedBy: "stopped", dedupeKey: "gate-1" }));
    assert.equal(b.ok, false);
    assert.equal(b.run.status, "skipped");
    assert.equal(b.run.reasonCode, "stopped");
    assert.equal(b.run.detail.gate, "stopped");
  } finally { f.cleanup(); }
});

test("重启收尸：遗留 running 变 interrupted，不伪造成功", () => {
  const f = fixture();
  try {
    const A = f.mk();
    const a = A.begin(ev({ dedupeKey: "k1" }));
    const b = A.begin(ev({ triggerId: "t2", dedupeKey: "k2" }));
    A.finish(b.run.runId, { ok: true });
    const B = f.mk();
    assert.equal(B.get(a.run.runId).status, "interrupted");
    assert.equal(B.get(a.run.runId).reasonCode, "reaped");
    assert.equal(B.get(b.run.runId).status, "ok");
    assert.equal(B.stats().inflight, 0);
    assert.ok(B.begin(ev({ triggerId: "t1", dedupeKey: "k9" })).ok);  // 单飞占位已释放
  } finally { f.cleanup(); }
});

test("急停 abortAll：在跑的全部 interrupted，并带当前 epoch", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const a = L.begin(ev({ epoch: 3, dedupeKey: "k1" }));
    const b = L.begin(ev({ triggerId: "t2", epoch: 3, dedupeKey: "k2" }));
    assert.equal(L.abortAll("手动急停", 4), 2);
    assert.equal(L.get(a.run.runId).status, "interrupted");
    assert.equal(L.get(a.run.runId).epoch, 4);
    assert.equal(L.get(b.run.runId).reasonCode, "stopped");
    assert.equal(L.stats().running, 0);
  } finally { f.cleanup(); }
});

test("dedupe 索引跨重启保留（滚动窗口，不是内存标志）", () => {
  const f = fixture();
  try {
    const A = f.mk();
    A.begin(ev({ dedupeKey: "k1" }));
    const B = f.mk();
    assert.equal(B.begin(ev({ dedupeKey: "k1" })).code, "duplicate");
  } finally { f.cleanup(); }
});

test("超上限自动压缩，文件仍是完整 JSONL", () => {
  const f = fixture({ maxRuns: 5 });
  try {
    const L = f.mk();
    for (let i = 0; i < 12; i++) {
      const r = L.begin(ev({ dedupeKey: "k" + i }));
      L.finish(r.run.runId, { ok: true });
    }
    assert.ok(L.stats().total <= 5);
    const lines = fs.readFileSync(f.file, "utf8").trim().split("\n");
    for (const ln of lines) assert.doesNotThrow(() => JSON.parse(ln));
    assert.equal(f.mk().stats().total, L.stats().total);   // 压缩后可读回
  } finally { f.cleanup(); }
});

test("落盘失败不阻断运行（内存态仍一致）", () => {
  const f = fixture();
  try {
    const broken = Object.create(fs);
    broken.appendFileSync = () => { throw new Error("EACCES"); };
    const L = f.mk({ fs: broken });
    const b = L.begin(ev());
    assert.equal(b.ok, true);
    assert.equal(L.finish(b.run.runId, { ok: true }).status, "ok");
  } finally { f.cleanup(); }
});

test("独立判定字段必须落盘：verdict / evidenceLevel / retries 不能被白名单丢掉", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const b = L.begin(ev());
    const done = L.finish(b.run.runId, {
      ok: true, status: "needs_review", steps: 7,
      verdict: "needs_review", evidenceLevel: "none", retries: 3,
      reasonCode: "no_spec",
    });
    assert.equal(done.status, "needs_review");
    assert.equal(done.verdict, "needs_review");
    assert.equal(done.evidenceLevel, "none");
    assert.equal(done.retries, 3);
    /* 重启后再读一遍：落盘丢字段是最难查的一类（内存对、文件不对）。 */
    const again = f.mk().list({ limit: 10 })[0];
    assert.equal(again.verdict, "needs_review");
    assert.equal(again.retries, 3);
  } finally { f.cleanup(); }
});

test("needs_review 不进 auto 样本：isSample 口径与判据一致", () => {
  const f = fixture();
  try {
    const L = f.mk();
    for (const st of ["ok", "needs_review", "failed"]) {
      const b = L.begin(ev({ dedupeKey: "k-" + st }));
      L.finish(b.run.runId, { ok: st === "ok", status: st });
    }
    const all = L.list({ limit: 10 });
    assert.equal(all.length, 3);
    assert.equal(all.filter((r) => r.status === "needs_review").length, 1);
  } finally { f.cleanup(); }
});

/* ---------------- 复核闭环（needs_review 的出口） ----------------
 * 这几项守的是一条红线：**复核不改判**。
 * 人看过 ≠ 系统有证据。用复核覆盖 verdict，autoPolicy 就会把人主观判断
 * 当成零退化样本，等于绕回这轮改造一开始要拆掉的自证循环。 */

function nr(f) {
  const L = f.mk();
  const b = L.begin(ev({ dedupeKey: "nr-" + Math.random().toString(36).slice(2) }));
  L.finish(b.run.runId, { ok: false, status: "needs_review", verdict: "needs_review",
    evidenceLevel: "none", reasonCode: "no_spec" });
  return { L, runId: b.run.runId };
}

test("markReviewed：记录谁看过、怎么认，但不碰 status / verdict", () => {
  const f = fixture();
  try {
    const { L, runId } = nr(f);
    const r = L.markReviewed(runId, { by: "张三", verdict: "accepted", note: "确认过了" });
    assert.equal(r.ok, true);
    assert.equal(r.run.reviewedBy, "张三");
    assert.equal(r.run.reviewVerdict, "accepted");
    assert.equal(r.run.reviewNote, "确认过了");
    assert.ok(r.run.reviewedAt > 0);
    /* 关键：判定没被改写 */
    assert.equal(r.run.status, "needs_review");
    assert.equal(r.run.verdict, "needs_review");
    assert.equal(r.run.reviewedOnVerdict, "needs_review");
  } finally { f.cleanup(); }
});

test("markReviewed 拒绝非法结论 / 不存在的运行 / 还在跑的运行", () => {
  const f = fixture();
  try {
    const L = f.mk();
    assert.equal(L.markReviewed("wr-nope", {}).ok, false);
    const b = L.begin(ev({ dedupeKey: "k-run" }));
    assert.equal(L.markReviewed(b.run.runId, {}).ok, false, "running 不能复核");
    L.finish(b.run.runId, { ok: false, status: "needs_review" });
    const bad = L.markReviewed(b.run.runId, { verdict: "looks-fine" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /accepted/);
  } finally { f.cleanup(); }
});

test("复核结果落盘：重启后 reviewedAt 还在", () => {
  const f = fixture();
  try {
    const { L, runId } = nr(f);
    L.markReviewed(runId, { by: "u", verdict: "ignored", note: "噪音" });
    const again = f.mk().get(runId);
    assert.ok(again.reviewedAt > 0);
    assert.equal(again.reviewVerdict, "ignored");
    assert.equal(again.status, "needs_review", "重启后判定也不能被复核改写");
  } finally { f.cleanup(); }
});

test("reviewQueue：只列待复核；pending 计数随复核下降", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const b = L.begin(ev({ dedupeKey: "q" + i, triggerId: "t" + i }));
      L.finish(b.run.runId, { ok: false, status: "needs_review" });
      ids.push(b.run.runId);
    }
    /* 一条 ok 的运行不该出现在队列里 */
    const okRun = L.begin(ev({ dedupeKey: "okrun", triggerId: "tok" }));
    L.finish(okRun.run.runId, { ok: true, status: "ok", verdict: "ok" });

    let q = L.reviewQueue({});
    assert.equal(q.total, 3);
    assert.equal(q.pending, 3);
    assert.equal(q.items.length, 3);
    assert.ok(q.items.every((r) => r.status === "needs_review" && !r.reviewedAt));

    L.markReviewed(ids[0], { verdict: "accepted" });
    q = L.reviewQueue({});
    assert.equal(q.pending, 2);
    assert.equal(q.reviewed, 1);
    assert.equal(q.items.length, 2);
    assert.equal(L.stats().pendingReview, 2);
    assert.equal(L.stats().reviewed, 1);

    /* scope=all 能看到复核过的那条 */
    assert.equal(L.reviewQueue({ scope: "all" }).items.length, 3);
  } finally { f.cleanup(); }
});

test("list 支持 reviewState 筛选，且不把 ok / failed 算成已复核", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const a = L.begin(ev({ dedupeKey: "a", triggerId: "ta" }));
    L.finish(a.run.runId, { ok: false, status: "needs_review" });
    const b = L.begin(ev({ dedupeKey: "b", triggerId: "tb" }));
    L.finish(b.run.runId, { ok: true, status: "ok" });
    L.markReviewed(a.run.runId, { verdict: "accepted" });

    assert.equal(L.list({ reviewState: "pending", limit: 10 }).length, 0);
    assert.equal(L.list({ reviewState: "reviewed", limit: 10 }).length, 1);
    assert.equal(L.list({ reviewState: "reviewed", limit: 10 })[0].runId, a.run.runId);
  } finally { f.cleanup(); }
});

test("unreview 撤销复核：字段全部清掉，可再复核一次", () => {
  const f = fixture();
  try {
    const { L, runId } = nr(f);
    L.markReviewed(runId, { verdict: "accepted" });
    assert.equal(L.unreview(runId).ok, true);
    const r = L.get(runId);
    assert.equal(r.reviewedAt, undefined);
    assert.equal(r.reviewVerdict, undefined);
    assert.equal(L.reviewQueue({}).pending, 1);
    assert.equal(L.unreview(runId).ok, false, "没有复核记录时撤销要拒绝");
  } finally { f.cleanup(); }
});

/* ---- S5：recipe 声明「预期完成事件契约」进运行账本 ---- */
test("S5 begin 带 expectedEvent：字段入库、结算后仍可查、未声明不写字段", () => {
  const f = fixture();
  try {
    const L = f.mk();
    const declared = {
      expectedEvents: ["recipe.done"], maxSilenceMs: 90000, absentAfter: 2,
      milestones: ["phase1"], probe: "read-only-liveness",
      idempotent: true, sideEffects: "none", credentialScope: "local",
      // 越界字段不应被原样塞进 jsonl
      junk: { nested: "should-not-appear" },
    };
    const b = L.begin(ev({ ticketId: "tk-s5", expectedEvent: declared }));
    assert.equal(b.ok, true);
    assert.deepEqual(b.run.expectedEvent.expectedEvents, ["recipe.done"]);
    assert.equal(b.run.expectedEvent.maxSilenceMs, 90000);
    assert.deepEqual(b.run.expectedEvent.milestones, ["phase1"]);
    assert.equal(b.run.expectedEvent.idempotent, true);
    assert.equal(b.run.expectedEvent.junk, undefined, "白名单外的字段不入账");
    // 结算（ok）后 expectedEvent 不丢 —— 事后复盘能看到当初声明了什么
    const done = L.finish(b.run.runId, { ok: true, steps: 3 });
    assert.equal(done.expectedEvent.expectedEvents[0], "recipe.done");
    // 落盘后重载仍在
    const L2 = f.mk();
    assert.equal(L2.get(b.run.runId).expectedEvent.maxSilenceMs, 90000);
    // 未声明的运行记录不带该字段（存量形状不变）
    const b2 = L.begin(ev({ triggerId: "t2", dedupeKey: "t2|x|2" }));
    assert.equal(b2.run.expectedEvent, undefined);
  } finally { f.cleanup(); }
});
