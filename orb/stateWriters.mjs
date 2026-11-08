/**
 * 状态单一写者（新增通道用）。
 *
 * 既有 ticketStore.transition 已有 CAS + RANK 单调性，本模块**不替换**它——
 * 动那条路径会动到急停结算语义，风险远大于收益。这里做两件事：
 *  ① 把「谁有权写任务状态」显式列成一张表，新增通道必须挂到表上；
 *  ② 给 observe / 导出 / 归档等新增通道提供同一个单调提交器，并压测
 *     「10 万次并发翻转终态不为 ready」。
 */
export const RANK = Object.freeze({
  queued: 0, running: 1, idle: 1, ready: 2, done: 2,
  failed: 3, blocked: 3, dropped: 4, stopped: 4, aborted: 4,
});
export const SUCCESS_STATES = new Set(["done", "ready"]);
export const TERMINAL = new Set(["done", "failed", "dropped", "stopped", "aborted"]);

/** 写者表：任何新增的状态写入口都必须登记在这里。 */
export const STATE_WRITERS = Object.freeze([
  { owner: "ticketStore.transition", via: "bridge/settleJobTicket", scope: "工单终态", rule: "CAS + RANK，done 不给 allowStale" },
  { owner: "ticketStore.openTicket", via: "bridge/startJob", scope: "工单创建", rule: "开局带当前 epoch" },
  { owner: "ticketStore.bumpEpoch", via: "bridge/doStop", scope: "全量作废", rule: "世代号唯一来源" },
  { owner: "ticketStore.resumeTicket", via: "POST /api/tickets?action=resume", scope: "恢复", rule: "不回退 epoch" },
  { owner: "jobs.set", via: "bridge/runBody / abortJob / doStop", scope: "面板任务镜像", rule: "只镜像，不反向覆盖工单" },
  { owner: "createStateWriter.commit", via: "新增通道（observe / 导出 / 归档）", scope: "新通道状态", rule: "RANK 单调，终态不得回写 success" },
  /* 11-07：策略变更优雅收敛使用独立 policyEpoch，与急停的 STOP.epoch 完全正交。
   * 登记在这里是为了让「谁能改任务相关状态」仍然只有一张表可查。 */
  { owner: "policyTransition.commit", via: "POST /api/ops policy.commit", scope: "策略世代", rule: "仅在 draining 全清后才 +1；绝不调用 bumpEpoch / doStop" },
  { owner: "policyTransition.rollback", via: "POST /api/ops policy.rollback", scope: "策略回退", rule: "policyEpoch 不变，history 追加 rolled_back" },
  { owner: "dreamConsolidator.consolidate", via: "POST /api/ops dream.consolidate", scope: "离线记忆整理", rule: "仅空闲时跑；不可信输入不进记忆；只作候选不建 Ticket" },
  { owner: "memoryBudget.setMode", via: "POST /api/ops memory.setMode", scope: "记忆预算档位", rule: "普通模式零开销；Max 才启用动态预算，受 HARD_CAP 约束" },
  { owner: "createArtifactGate.accept", via: "POST /api/ops artifact.accept", scope: "插件生成物收据", rule: "三段式验收全过后才签 receipt；restart-required 不算成功" },
]);

export function createStateWriter(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const onCommit = typeof opts.onCommit === "function" ? opts.onCommit : null;
  const rows = new Map();
  let rejected = 0;
  let commits = 0;

  function get(id) {
    const r = rows.get(String(id));
    return r ? { ...r, history: undefined } : null;
  }

  /** 单调提交：等级低于当前状态一律拒；终态不许回写成成功。 */
  function commit(id, to, o = {}) {
    const key = String(id);
    const cur = rows.get(key);
    const from = cur ? cur.status : "queued";
    const toRank = RANK[to] ?? 1;
    const fromRank = RANK[from] ?? 0;
    const rec = { id: key, status: to, rev: (cur?.rev || 0) + 1, epoch: o.epoch ?? cur?.epoch ?? 0, cause: String(o.cause || ""), at: now() };

    /* 判定顺序有讲究：更专门的拒因要先于通用的 RANK 降级，
       否则 stopped → done 会被笼统报成 rank-down，排查时分不清是不是迟到回调。 */
    if (cur && from === to && TERMINAL.has(from)) {
      rejected++;
      return { ok: false, from, to, reason: "duplicate-terminal", reasonText: "终态重复结算" };
    }
    if (cur && TERMINAL.has(from) && SUCCESS_STATES.has(to)) {
      rejected++;
      return { ok: false, from, to, reason: "terminal-to-success", reasonText: `${from} 终态不许回写成 ${to}` };
    }
    if (cur && toRank < fromRank) {
      rejected++;
      return { ok: false, from, to, reason: "rank-down", reasonText: `${from} → ${to} 不允许降级` };
    }
    rows.set(key, rec);
    commits++;
    if (onCommit) { try { onCommit(rec); } catch {} }
    return { ok: true, from, to, rev: rec.rev, record: rec };
  }

  function stats() { return { commits, rejected, tracked: rows.size, writers: STATE_WRITERS.length }; }
  function snapshot() { return [...rows.values()].map((r) => ({ ...r })); }

  return { commit, get, stats, snapshot };
}
