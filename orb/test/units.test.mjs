/* 单元测试：五个基础模块。
 * 运行：node --test orb/test/units.test.mjs
 *
 * 这些用例只测**契约**（谁能在什么条件下写什么），不测实现细节：
 * 后面 bridge 接线时可以随手改内部结构，只要契约还在，这些用例就该一直是绿的。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTicketStore } from "../ticketStore.mjs";
import { createOutbox } from "../outbox.mjs";
import { createCostLedger, estimateTokens } from "../costLedger.mjs";
import { createGuiLock } from "../guiLock.mjs";
import { createDispatcher, keywords } from "../dispatcher.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orb-unit-"));

/* ============================ ticketStore ============================ */

test("ticketStore：正常流转与 CAS", () => {
  const store = createTicketStore({ dir: tmp(), now: () => 1000 });
  const t = store.openTicket({ title: "跑个后台任务", kind: "job" });
  assert.equal(t.status, "running");
  assert.equal(t.rev, 1);
  assert.equal(t.epoch, 0);

  const r1 = store.transition(t.id, "done", { expectRev: t.rev });
  assert.equal(r1.ok, true);
  assert.equal(r1.ticket.rev, 2);

  // 迟到的写入：rev 已过期，必须拒绝（这就是"后写覆盖"的结构性修复）
  const r2 = store.transition(t.id, "failed", { expectRev: 1 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "stale-rev");
});

test("ticketStore：failed 不会被迟到的 ready 覆盖", () => {
  const store = createTicketStore({ dir: tmp() });
  const t = store.openTicket({ title: "x" });
  const failed = store.transition(t.id, "failed", { expectRev: t.rev, reason: "boom" });
  assert.equal(failed.ok, true);

  const late = store.transition(t.id, "ready", { expectRev: failed.ticket.rev });
  assert.equal(late.ok, false);
  assert.equal(late.code, "illegal");
  assert.equal(store.get(t.id).status, "failed");
});

test("ticketStore：急停抬升世代后，旧工单一律拒写", () => {
  const store = createTicketStore({ dir: tmp() });
  const a = store.openTicket({ title: "a" });
  const b = store.openTicket({ title: "b" });

  const bumped = store.bumpEpoch("手动急停");
  assert.equal(bumped.epoch, 1);
  assert.equal(bumped.staled, 2);

  const old = store.transition(a.id, "done", { expectRev: store.get(a.id).rev });
  assert.equal(old.ok, false);
  assert.equal(old.code, "stale-epoch");

  // 新世代的工单照常
  const c = store.openTicket({ title: "c" });
  assert.equal(c.epoch, 1);
  assert.equal(store.transition(c.id, "done", { expectRev: c.rev }).ok, true);

  // 恢复旧工单：清 stale、跟随当前世代
  const resumed = store.resumeTicket(b.id);
  assert.equal(resumed.ok, true);
  assert.equal(resumed.ticket.status, "running");
  assert.equal(resumed.ticket.stale, false);
  assert.equal(resumed.ticket.epoch, 1);
});

test("ticketStore：被急停打断的旧工单能被标成 stopped（否则永远 show 在跑）", () => {
  const store = createTicketStore({ dir: tmp() });
  const a = store.openTicket({ title: "跑到一半被刹车" });
  store.bumpEpoch("手动急停");

  // 不给 allowStale：旧世代一律拒，包括"往下收"的终态 —— 这正是 bug 的形态
  const denied = store.transition(a.id, "stopped", { expectRev: store.get(a.id).rev });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "stale-epoch");

  // 给 allowStale：允许收尾，但绝不允许写成 done
  const done = store.transition(a.id, "done", { expectRev: store.get(a.id).rev, allowStale: true });
  assert.equal(done.ok, false, "旧世代跑完的结果不许借结算写成成功");

  const stopped = store.transition(a.id, "stopped", {
    expectRev: store.get(a.id).rev, allowStale: true, reason: "急停",
  });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.ticket.status, "stopped");
  assert.equal(store.summary().open, 0, "收尾后不该还有在跑计数");
});

test("ticketStore：启动时收尾上一进程遗留的幽灵工单", () => {
  const store = createTicketStore({ dir: tmp() });
  const ghost = store.openTicket({ title: "上次被 kill 掉的" });
  const finished = store.openTicket({ title: "正常结束的" });
  store.transition(finished.id, "done", { expectRev: finished.rev });
  store.bumpEpoch("上次急停");
  assert.ok(store.summary().open >= 1);

  const r = store.reapDangling("进程重启时未结算");
  assert.equal(r.reaped, 1, "只收尾非终态那条");
  assert.equal(store.get(ghost.id).status, "aborted", "不能伪造成 done");
  assert.equal(store.get(finished.id).status, "done", "终态不许被改写");
  assert.equal(store.summary().open, 0);
});

test("ticketStore：保留期与上限不会砍掉在跑的工单", () => {
  let clock = 0;
  const store = createTicketStore({ dir: tmp(), now: () => clock, maxTickets: 3, ttlMs: 1000 });
  const running = store.openTicket({ title: "长跑" });
  for (let i = 0; i < 6; i++) {
    const t = store.openTicket({ title: `t${i}` });
    clock += 10;
    store.transition(t.id, "done", { expectRev: t.rev });
  }
  assert.equal(store.get(running.id).status, "running", "在跑的工单必须留着");
  assert.ok(store.list({ limit: 200 }).length <= 3);

  clock += 5000;
  store.prune();
  assert.ok(store.get(running.id), "在跑的不受 TTL 影响");
});

test("ticketStore：落盘可回读", () => {
  const dir = tmp();
  const s1 = createTicketStore({ dir });
  const t = s1.openTicket({ title: "持久化" });
  s1.transition(t.id, "done", { expectRev: t.rev });
  s1.flush();
  s1.close();

  const s2 = createTicketStore({ dir });
  const back = s2.get(t.id);
  assert.equal(back.status, "done");
  assert.equal(back.title, "持久化");
});

/* ============================ outbox ============================ */

test("outbox：同一幂等键只发一次", async () => {
  const sent = [];
  const ob = createOutbox({ dir: tmp(), send: async (row) => { sent.push(row); } });

  const a = ob.enqueue({ ticketId: "t1", kind: "stopped", dedupe: "stop-1", payload: { epoch: 1 } });
  const b = ob.enqueue({ ticketId: "t1", kind: "stopped", dedupe: "stop-1", payload: { epoch: 1 } });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);

  const r = await ob.pump();
  assert.equal(r.sent, 1);
  assert.equal(sent.length, 1);

  // 已发过的再入箱仍然不能重发
  const c = ob.enqueue({ ticketId: "t1", kind: "stopped", dedupe: "stop-1", payload: { epoch: 1 } });
  assert.equal(c.duplicate, true);
  await ob.pump();
  assert.equal(sent.length, 1);
});

test("outbox：失败退避并在超过上限后记 failed", async () => {
  let clock = 1000;
  let calls = 0;
  const ob = createOutbox({
    dir: tmp(), now: () => clock, maxAttempts: 3,
    send: async () => { calls++; throw new Error("channel down"); },
  });
  ob.enqueue({ ticketId: "t", kind: "notice", dedupe: "k", payload: {} });

  await ob.pump();
  assert.equal(calls, 1);
  assert.equal(ob.stats().pending, 1, "第一次失败应回到 pending 等退避");

  // 退避期未到：不该再打
  await ob.pump();
  assert.equal(calls, 1);

  clock += 10000;
  await ob.pump();
  clock += 10000;
  await ob.pump();
  assert.equal(calls, 3);
  const st = ob.stats();
  assert.equal(st.failed, 1);
  assert.match(st.failing[0].error, /channel down/);
});

test("outbox：同一工单保序", async () => {
  const order = [];
  const ob = createOutbox({ dir: tmp(), now: () => 1000, send: async (r) => { order.push(r.dedupe); } });
  ob.enqueue({ ticketId: "t", kind: "a", dedupe: "first", payload: {} });
  ob.enqueue({ ticketId: "t", kind: "b", dedupe: "second", payload: {} });
  await ob.pump();
  assert.deepEqual(order, ["first", "second"]);
});

/* ============================ costLedger ============================ */

test("costLedger：按单价算钱并标 estimated", () => {
  const ledger = createCostLedger({ dir: tmp(), now: () => 1000 });
  const r = ledger.record("t1", { model: "deepseek-v4-pro", promptTokens: 1e6, completionTokens: 1e6, cachedTokens: 0 });
  assert.equal(r.estimated, true, "没显式声明就是估算");
  assert.equal(r.costUSD, 5.28);       // 1.32 + 3.96
  assert.equal(r.totalTokens, 2e6);

  const real = ledger.record("t1", { model: "deepseek-v4-pro", promptTokens: 100, completionTokens: 50, estimated: false });
  assert.equal(real.estimated, false);

  const s = ledger.summary("t1");
  assert.equal(s.calls, 2);
  assert.equal(s.estimatedCalls, 1);
  assert.equal(s.mixed, true);
});

test("costLedger：缓存命中走缓存价", () => {
  const ledger = createCostLedger({ dir: tmp() });
  const r = ledger.record("t", { model: "deepseek-v4-pro", promptTokens: 1e6, cachedTokens: 1e6, completionTokens: 0 });
  assert.equal(r.costUSD, 0.132);
  assert.equal(ledger.summary("t").cacheHitRate, 1);
});

test("costLedger：token 估算对中英文都不为 0", () => {
  assert.ok(estimateTokens("这是一段中文文本，用来估算 token 数。") > 0);
  assert.ok(estimateTokens("hello world this is english") > 0);
  assert.equal(estimateTokens(""), 0);
});

/* ---- 路由归因与工单预算（I-09 后半截）----
 * 没有这层，开并发只能看到总账变贵，却说不出贵在哪个决定上。 */
test("costLedger：routeAttemptId / ruleId / route 一路带到行上", () => {
  const ledger = createCostLedger({ dir: tmp() });
  const r = ledger.record("t1", {
    model: "deepseek-v4", promptTokens: 100, completionTokens: 10,
    routeAttemptId: "t1#2", ruleId: "expert:video", route: "vision",
  });
  assert.equal(r.routeAttemptId, "t1#2");
  assert.equal(r.ruleId, "expert:video");
  assert.equal(r.route, "vision");
  /* 不传时是空串，不是 undefined —— 面板拼表格时不用再做空值分支 */
  const r2 = ledger.record("t1", { model: "deepseek-v4" });
  assert.equal(r2.routeAttemptId, "");
  assert.equal(r2.ruleId, "");
});

test("costLedger：同一次任务的两次路由尝试能分开算", () => {
  const ledger = createCostLedger({ dir: tmp() });
  ledger.record("t2", { model: "deepseek-v4", promptTokens: 1e6, routeAttemptId: "a1", ruleId: "fastpath", route: "direct" });
  ledger.record("t2", { model: "deepseek-v4", promptTokens: 2e6, routeAttemptId: "a2", ruleId: "slowpath", route: "back" });
  const at = ledger.attempts("t2");
  assert.equal(at.length, 2);
  assert.deepEqual(at.map((x) => x.attempt), ["a1", "a2"]);
  assert.ok(at[0].costUSD < at[1].costUSD, "第二次尝试花得更多应能看出来");
});

test("costLedger：byRoute 按 规则+通道 聚合，能量出哪条规则最贵", () => {
  const ledger = createCostLedger({ dir: tmp() });
  ledger.record("t3", { model: "deepseek-v4", promptTokens: 1e6, ruleId: "cheap", route: "direct" });
  ledger.record("t3", { model: "deepseek-v4-pro", promptTokens: 1e6, ruleId: "expensive", route: "vision" });
  const rows = ledger.byRoute();
  assert.equal(rows[0].ruleId, "expensive", "贵的排前面");
  assert.ok(rows[0].costUSD > rows[1].costUSD);
  assert.ok(Number.isFinite(rows[0].avgCostUSD));
});

test("costLedger：工单预算超了就给 exceeded，不替调用方做决定", () => {
  const ledger = createCostLedger({ dir: tmp() });
  assert.equal(ledger.setBudget("t4", -1).ok, false, "负数预算要拒绝");
  /* deepseek-v4 输入价 0.28/M：1e5 token ≈ 0.028 美元，5e6 ≈ 1.4 美元 */
  assert.equal(ledger.setBudget("t4", 0.5).ok, true);
  const r1 = ledger.record("t4", { model: "deepseek-v4", promptTokens: 1e5 });
  assert.equal(r1.budgetExceeded, false, "第一笔还没超");
  const r2 = ledger.record("t4", { model: "deepseek-v4", promptTokens: 5e6 });
  assert.equal(r2.budgetExceeded, true, "超了要立刻告诉调用方");
  assert.equal(r2.budget.leftUSD, 0);
  const st = ledger.budgetStatus("t4");
  assert.equal(st.limitUSD, 0.5);
  assert.ok(st.spentUSD > 0.5);
  /* 0 = 取消上限 */
  assert.equal(ledger.setBudget("t4", 0).unlimited, true);
  assert.equal(ledger.budgetStatus("t4").exceeded, false);
});

test("costLedger：预算随账本一起落盘并读回", () => {
  const dir = tmp();
  const a = createCostLedger({ dir });
  a.setBudget("t5", 2);
  a.record("t5", { model: "deepseek-v4", promptTokens: 1000 });
  a.flush();
  const b = createCostLedger({ dir });
  assert.equal(b.budgetStatus("t5").limitUSD, 2, "重启后预算还在");
  assert.ok(b.budgetStatus("t5").spentUSD > 0, "重启后花销还在");
});

/* ============================ guiLock ============================ */

test("guiLock：独占、重入、交还", () => {
  const lock = createGuiLock({ now: () => 1000 });
  const a = lock.acquire({ owner: "worker-1" });
  assert.equal(a.ok, true);

  const b = lock.acquire({ owner: "worker-2" });
  assert.equal(b.ok, false);
  assert.equal(b.code, "busy");

  // 同一 owner 重入 = 续租，不是冲突（视觉循环每步都会重新拿）
  const again = lock.acquire({ owner: "worker-1" });
  assert.equal(again.ok, true);
  assert.equal(again.token, a.token);

  assert.equal(lock.release(a.token, "done").ok, true);
  assert.equal(lock.acquire({ owner: "worker-2" }).ok, true);
});

test("guiLock：租约过期自动释放", () => {
  let clock = 1000;
  const lock = createGuiLock({ now: () => clock, defaultTtlMs: 500 });
  const a = lock.acquire({ owner: "w" });
  clock += 600;
  const st = lock.status();
  assert.equal(st.locked, false);
  assert.equal(st.stats.expiries, 1);
  assert.equal(lock.release(a.token).code, "idle");
});

test("guiLock：持有超时强制释放，防止整段任务握着锁", () => {
  let clock = 1000;
  const lock = createGuiLock({ now: () => clock, defaultTtlMs: 10000, maxHoldMs: 15000 });
  const a = lock.acquire({ owner: "w" });
  clock += 12000;
  const r1 = lock.renew(a.token);
  assert.equal(r1.ok, true);
  clock += 5000;                      // 累计 17000 > maxHold 15000
  const r2 = lock.renew(a.token);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, "max-hold-exceeded");
  assert.equal(lock.status().locked, false);
});

test("guiLock：用户输入无条件让路，急停后旧锁作废", () => {
  const lock = createGuiLock({ now: () => 1000 });
  lock.acquire({ owner: "vision" });
  const y = lock.yieldByUser("物理鼠标");
  assert.equal(y.yielded, true);
  assert.equal(lock.status().locked, false);

  lock.acquire({ owner: "vision" });
  const e = lock.setEpoch(1);
  assert.equal(e.dropped, "vision");
  const stale = lock.acquire({ owner: "vision", epoch: 0 });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale-epoch");
  assert.equal(lock.acquire({ owner: "vision", epoch: 1 }).ok, true);
});

test("guiLock：withLock 拿不到就不执行", async () => {
  const lock = createGuiLock({ now: () => 1000 });
  lock.acquire({ owner: "other" });
  let ran = false;
  const r = await lock.withLock("w", async () => { ran = true; });
  assert.equal(r.ok, false);
  assert.equal(ran, false);
});

/* ============================ dispatcher ============================ */

test("dispatcher：没有专家时退回单路，行为与改造前一致", () => {
  const d = createDispatcher();
  const p = d.route({ text: "帮我看下这个目录", routeHint: "back" });
  assert.equal(p.dispatcher, "fallback");
  assert.equal(p.assignments.length, 1);
  assert.equal(p.assignments[0].route, "workbuddy");
  assert.equal(p.dryRun, true, "默认只决策不执行");
});

test("dispatcher：关键词专家命中并用它的 plan", () => {
  const d = createDispatcher({ threshold: 0.3 });
  d.register({
    id: "video", name: "视频解析专家", kind: "expert", route: "workbuddy",
    match: keywords(["视频", "录屏", "截帧"]),
    plan: (ctx) => ({ assignments: [{ id: "a1", role: "video-parse", prompt: `解析：${ctx.text}` }] }),
  });
  const p = d.route({ text: "把这个视频的台词整理一下" });
  assert.equal(p.dispatcher, "expert");
  assert.equal(p.expertId, "video");
  assert.equal(p.assignments[0].role, "video-parse");
  assert.match(p.assignments[0].prompt, /台词/);

  // 分数不够就退回 fallback，专家不能"什么都能接"
  const q = d.route({ text: "今天天气怎么样" });
  assert.equal(q.dispatcher, "fallback");
});

test("dispatcher：专家团模式产出多份任务，并按依赖折批", () => {
  const d = createDispatcher({ threshold: 0.2 });
  d.register({
    id: "team-qa", name: "质检专家团", kind: "dispatcher", policy: "parallel",
    match: () => 0.9,
    plan: () => ({
      assignments: [
        { id: "scan", role: "scan" },
        { id: "test", role: "test", dependsOn: ["scan"] },
        { id: "review", role: "review", dependsOn: ["scan", "test"] },
        { id: "docs", role: "docs", dependsOn: ["scan"] },
      ],
    }),
  });
  const p = d.route({ text: "跑一遍质检" });
  assert.equal(p.dispatcher, "team");
  assert.equal(p.policy, "parallel");
  assert.equal(p.assignments.length, 4);

  const b = d.batches(p.assignments);
  assert.equal(b.ok, true);
  assert.deepEqual(b.batches.map((l) => l.map((a) => a.id)), [["scan"], ["test", "docs"], ["review"]]);
});

test("dispatcher：依赖成环/缺依赖要报错，不能静默跑错顺序", () => {
  const d = createDispatcher();
  const cyc = d.batches([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }]);
  assert.equal(cyc.ok, false);
  assert.equal(cyc.code, "cycle");

  const miss = d.batches([{ id: "a", dependsOn: ["nope"] }]);
  assert.equal(miss.ok, false);
  assert.equal(miss.code, "missing-dep");
});

test("dispatcher：计划超上限被截断，不整体失败", () => {
  const d = createDispatcher({ threshold: 0.1, maxFanout: 2 });
  d.register({ id: "big", kind: "team", match: () => 1, plan: () => ({ assignments: [{}, {}, {}, {}] }) });
  const p = d.route({ text: "x" });
  assert.equal(p.assignments.length, 2);
});

test("dispatcher：match 抛错不拖垮派发", () => {
  const d = createDispatcher({ threshold: 0.1 });
  d.register({ id: "bad", kind: "expert", match: () => { throw new Error("boom"); } });
  const p = d.route({ text: "随便" });
  assert.equal(p.dispatcher, "fallback");
});

test("dispatcher：重复 id 注册直接拒绝", () => {
  const d = createDispatcher();
  d.register({ id: "x", kind: "expert", match: () => 0.5 });
  assert.throws(() => d.register({ id: "x", kind: "expert" }), /重复/);
});
