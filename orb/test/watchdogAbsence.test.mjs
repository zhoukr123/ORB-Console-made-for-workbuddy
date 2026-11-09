/* S5 缺席检测单测：把"从超时升为生命周期控制"的行为锁死。
 * 覆盖验收 #6：静默不结束且不报错的 recipe 触发「预期完成事件缺失」告警；
 * 进程 200 / a11y 非空不单独算完成；人工停止项永不被拉起；不自动重跑。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createWatchdog, normalizeExpectedContract, hasExpectedEvent, decideAbsentAction,
} from "../watchdog.mjs";

/* ---------- 纯函数 ---------- */
test("normalizeExpectedContract：别名兼容、缺省 recipe.done、字段合理", () => {
  const a = normalizeExpectedContract();
  assert.deepEqual(a.expectedEvents, ["recipe.done"]);
  assert.equal(a.absentAfter, 2);
  assert.ok(a.maxSilenceMs > 0);
  const b = normalizeExpectedContract({
    expected_event_schema: ["job.done", "job.failed"], max_silence_ms: 5000,
    milestones: ["phase1"], idempotent: true, side_effects: "none", credential_scope: "local",
  });
  assert.deepEqual(b.expectedEvents, ["job.done", "job.failed"]);
  assert.equal(b.maxSilenceMs, 5000);
  assert.deepEqual(b.milestones, ["phase1"]);
  assert.equal(b.idempotent, true);
});

test("hasExpectedEvent：命中 name/type，ok:false 不算完成", () => {
  const c = normalizeExpectedContract({ expectedEvents: ["recipe.done"] });
  assert.equal(hasExpectedEvent([{ type: "step", name: "recipe.start" }], c), false);
  assert.equal(hasExpectedEvent([{ type: "step", name: "recipe.done", ok: true }], c), true);
  assert.equal(hasExpectedEvent([{ type: "recipe.done" }], c), true, "type 命中也算");
  assert.equal(hasExpectedEvent([{ type: "step", name: "recipe.done", ok: false }], c), false, "失败不算完成");
});

test("decideAbsentAction：外部副作用/进程已死 → 交还人工；幂等无副作用 → 建议人工重试；autoRerun 恒 false", () => {
  assert.equal(decideAbsentAction({}, { alive: false }).action, "handoff");
  assert.equal(decideAbsentAction({ sideEffects: "external" }, { alive: true }).action, "handoff");
  assert.equal(decideAbsentAction({ credentialScope: "external" }, { alive: true }).action, "handoff");
  assert.equal(decideAbsentAction({ idempotent: true, sideEffects: "none" }, { alive: true }).action, "retry");
  assert.equal(decideAbsentAction({}, { alive: true }).action, "degrade");
  for (const c of [{}, { sideEffects: "external" }, { idempotent: true, sideEffects: "none" }]) {
    for (const p of [{ alive: true }, { alive: false }, { alive: null }]) {
      assert.equal(decideAbsentAction(c, p).autoRerun, false, "绝不自动重跑");
    }
  }
});

/* ---------- 装配夹具 ---------- */
function fixture(contractRows = []) {
  let clock = 1_000_000;
  const ticket = { id: "T1", title: "静默配方", status: "running", epoch: "E", updatedAt: clock, createdAt: clock };
  let openTickets = [ticket];
  const tickets = { list: () => openTickets.map((t) => ({ ...t })) };
  const trajectory = {
    checkpoint: () => ({ lastAt: clock }),   // 一直"活着"，进程 200 / a11y 非空都不算完成
    read: () => contractRows,
  };
  const alerts = [];
  const wd = createWatchdog({ tickets, trajectory, now: () => clock, staleMs: 999_999_999,
    onAlert: (a) => alerts.push(a),
    probeLiveness: () => ({ alive: true, note: "mock 只读探活" }) });
  return {
    wd, alerts,
    advance: (ms) => { clock += ms; },
    setRows: (r) => { contractRows.splice(0, contractRows.length, ...r); },
    stopTicket: () => { openTickets = []; },   // 模拟人工停止 → 从 open 列表移除
    clock: () => clock,
  };
}

test("缺席检测：最大静默期内不报；连续两个采样周期未见预期事件 → absent", () => {
  const f = fixture();
  f.wd.declare("T1", { expectedEvents: ["recipe.done"], maxSilenceMs: 60_000, absentAfter: 2 });
  const t0 = f.clock();
  // 未到最大静默期：不报
  f.advance(30_000);
  let r = f.wd.tick();
  assert.equal(r.absent.length, 0);
  // 超过静默期，第 1 个采样周期：还没到 2 次，不报
  f.advance(31_000);   // now - t0 = 61s > 60s
  r = f.wd.tick();
  assert.equal(r.absent.length, 0, "第 1 个采样周期不报");
  // 第 2 个连续采样周期：报 absent
  f.advance(60_000);
  r = f.wd.tick();
  assert.equal(r.absent.length, 1);
  assert.equal(r.absent[0].decision.action, "degrade");
  assert.equal(r.absent[0].probe.alive, true, "先只读探活");
  assert.match(r.absent[0].reason, /未见预期完成事件/);
  assert.equal(f.alerts.filter((a) => a.kind === "absent").length, 1, "只报一次，不刷屏");
  assert.equal(r.acted.find((a) => a.kind === "absent").autoRerun, false);
});

test("预期事件已出现 → 复位，不误报（静默但确实跑完了）", () => {
  const f = fixture();
  f.wd.declare("T1", { expectedEvents: ["recipe.done"], maxSilenceMs: 1000, absentAfter: 2 });
  f.setRows([{ type: "step", name: "recipe.done", ok: true }]);
  f.advance(5000);
  const r = f.wd.tick();
  assert.equal(r.absent.length, 0, "预期完成事件在，就不是缺席");
  assert.equal(f.wd.status().contracts[0].absent, false);
});

test("人工停止项永不被拉起：终态工单的契约就地清除、不产生 absent", () => {
  const f = fixture();
  f.wd.declare("T1", { expectedEvents: ["recipe.done"], maxSilenceMs: 1000, absentAfter: 1 });
  f.stopTicket();
  f.advance(5000);
  const r = f.wd.tick();
  assert.equal(r.absent.length, 0);
  assert.equal(f.wd.status().declared, 0, "终态契约被撤销");
});

test("HTTP 200 / a11y 非空 / 进程活着 都不单独算完成：轨迹无预期事件照样报 absent", () => {
  const f = fixture([{ type: "step", name: "still.alive.heartbeat", ok: true }]);
  f.wd.declare("T1", { expectedEvents: ["recipe.done"], maxSilenceMs: 1000, absentAfter: 2 });
  f.advance(5000);
  f.wd.tick();
  f.advance(5000);
  const r = f.wd.tick();
  assert.equal(r.absent.length, 1, "光有心跳/存活证据不构成完成");
});

test("clear() 撤销契约后不再检测；status 状态行带 declared/absent/contracts", () => {
  const f = fixture();
  f.wd.declare("T1", { expectedEvents: ["recipe.done"], maxSilenceMs: 1000, absentAfter: 1 });
  assert.equal(f.wd.status().declared, 1);
  assert.ok(Array.isArray(f.wd.status().contracts));
  assert.equal("absent" in f.wd.status(), true);
  assert.equal(f.wd.clear("T1"), true);
  f.advance(5000);
  assert.equal(f.wd.tick().absent.length, 0);
  assert.equal(f.wd.status().declared, 0);
});

test("declare 校验：空 ticketId / 空 expectedEvents 拒绝", () => {
  const f = fixture();
  assert.equal(f.wd.declare("", {}).ok, false);
  assert.equal(f.wd.declare("T1", { expectedEvents: [] }).ok, true, "空数组回落到缺省 recipe.done");
});
