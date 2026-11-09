/* ---------------- 自动化运行账本（wfRunLedger） ----------------
 *
 * 成熟自动化引擎的最小内核，不是编排器：
 *   n8n        execution.id + static data 去重 + 并发上限 + executions 表
 *   Node-RED   msg._msgid 追踪 + context 持久化 + flows.json
 *   Temporal   一个 workflowId 同时只允许一个 running execution + Event History
 *   GHA        run_id + concurrency group + cancel-in-progress
 *   Activepieces step checkpoint + run log
 *
 * 它们形态差别很大，但都先回答同一组问题：这次点火算第几号运行、归哪条触发器、
 * 是不是重复事件、上一轮跑完没有、崩了之后还剩几个"在跑"的幽灵。
 * ORB 原先 fireTrigger() 直接 wfPlay()，这五个问题一个都答不了。
 *
 * 为什么不需要数据库/Redis：n8n 的 regular mode 本身就是单进程 + SQLite，
 * Node-RED 更是单 Node.js 进程 + 文件。bridge 是单线程 JS，begin() 全程同步、
 * 没有 await 间隙，"检查 + 占位"天然就是原子 claim —— 不需要唯一约束去防并发竞争。
 *
 * 三条与云端引擎刻意不同的判断：
 *   ① 同一 triggerId 在跑时**跳过新事件并留 skipped 收据，不取消旧运行**。
 *      GitHub Actions 的 cancel-in-progress 适合无状态 CI；桌面 GUI 回放会抢鼠标/焦点，
 *      掐断半途会留下未提交编辑和孤立窗口，属于"撕半途工作"。
 *   ② 幂等键**不用 runId**（n8n 明确警告：execution.id 每次重试都变），
 *      由调用方从事件本身算稳定指纹（triggerId + 时间桶 / 文件 mtime）。
 *   ③ 不做 exactly-once 承诺。本地事务保证"不会重复点火"，
 *      外发副作用是否有回执由渠道自己负责。
 */
import fsDefault from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_MAX_RUNS = 500;
const DEFAULT_MAX_DEDUPE = 2000;
const DEFAULT_DEDUPE_TTL = 72 * 3600 * 1000;

const ACTIVE = new Set(["running"]);

export function createWfRunLedger(opts = {}) {
  const fs = opts.fs || fsDefault;
  const file = String(opts.file || "");
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const log = opts.log || (() => {});
  const maxRuns = Number(opts.maxRuns) || DEFAULT_MAX_RUNS;
  const maxDedupe = Number(opts.maxDedupe) || DEFAULT_MAX_DEDUPE;
  const dedupeTtl = Number(opts.dedupeTtlMs) || DEFAULT_DEDUPE_TTL;
  const newId = opts.newId || (() => randomUUID().slice(0, 8));

  if (!file) throw new Error("wfRunLedger: file 必填");

  const runs = new Map();          // runId -> run（权威内存态）
  const seen = new Map();          // dedupeKey -> lastAt（滚动窗口）
  const inflight = new Map();      // triggerId -> runId
  let seq = 0;

  /* ---------- 落盘 ---------- */
  function append(run) {
    runs.set(run.runId, run);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(run) + "\n", "utf8");
    } catch (err) {
      /* 写盘失败不阻断运行：内存态仍然正确，下次启动会按未结算收尸。 */
      log(`[wf-runs] 落盘失败：${err.message}`);
    }
  }

  /* 追加写会无限增长。超上限时把内存里保留的 run 一次性原子重写，
     先 .part 再 rename，避免中途断电留下半截 JSONL。 */
  function compact() {
    if (runs.size <= maxRuns) return;
    const keep = [...runs.values()]
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
      .slice(-maxRuns);
    runs.clear();
    for (const r of keep) runs.set(r.runId, r);
    try {
      const tmp = `${file}.part`;
      fs.writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      fs.renameSync(tmp, file);
    } catch (err) { log(`[wf-runs] 压缩失败：${err.message}`); }
  }

  function pruneSeen() {
    const t = now();
    for (const [k, at] of seen) if (t - at > dedupeTtl) seen.delete(k);
    if (seen.size > maxDedupe) {
      const oldest = [...seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, seen.size - maxDedupe);
      for (const [k] of oldest) seen.delete(k);
    }
  }

  /* 启动时收尸：上次进程没来得及结算的 running 一律 interrupt。
     不标成 failed，因为我们不知道它到底跑到哪 —— 不伪造结论。 */
  function reapDangling(reason = "进程重启时未结算") {
    let n = 0;
    for (const r of [...runs.values()]) {
      if (r.status !== "running") continue;
      append({ ...r, status: "interrupted", endedAt: now(), reasonCode: "reaped", error: reason });
      n++;
    }
    inflight.clear();
    return n;
  }

  function load() {
    try {
      const txt = fs.readFileSync(file, "utf8");
      for (const ln of txt.split("\n")) {
        if (!ln.trim()) continue;
        try {
          const r = JSON.parse(ln);
          if (!r || !r.runId) continue;
          runs.set(r.runId, r);                       // 后写覆盖先写 = 结算覆盖了开工
          if (r.dedupeKey) seen.set(r.dedupeKey, r.startedAt || now());
          const n = Number(String(r.runId).split("-").pop());
          if (Number.isFinite(n) && n > seq) seq = n;
        } catch {}
      }
    } catch (err) {
      if (err && err.code !== "ENOENT") log(`[wf-runs] 读盘失败（按空账本继续）：${err.message}`);
    }
    const reaped = reapDangling();
    compact();
    return { reaped };
  }

  /** 同步原子 claim：检查 + 占位之间没有任何 await，单线程下不可能被插入第二次。 */
  function begin(input = {}) {
    const t = now();
    const triggerId = String(input.triggerId || "");
    const workflow = String(input.workflow || "");
    const source = String(input.source || "trigger");
    const dedupeKey = String(input.dedupeKey || "");
    const cooldownMs = Math.max(0, Number(input.cooldownMs) || 0);
    const epoch = Number(input.epoch) || 0;
    /* S5：recipe 声明的「预期完成事件契约」。存进运行账本 = 生命周期控制的真相源，
     * watchdog 据此监听"预期事件有没有出现"。不传就不写该字段（存量运行形状不变）。
     * 只挑必要字段落盘，避免把任意对象塞进 jsonl。 */
    const ee = input.expectedEvent && typeof input.expectedEvent === "object" ? input.expectedEvent : null;
    const expectedEvent = ee ? {
      expectedEvents: Array.isArray(ee.expectedEvents) ? ee.expectedEvents.map(String).slice(0, 20) : undefined,
      maxSilenceMs: Number.isFinite(Number(ee.maxSilenceMs)) ? Number(ee.maxSilenceMs) : undefined,
      absentAfter: Number.isFinite(Number(ee.absentAfter)) ? Number(ee.absentAfter) : undefined,
      milestones: Array.isArray(ee.milestones) ? ee.milestones.map(String).slice(0, 40) : undefined,
      probe: ee.probe != null ? String(ee.probe).slice(0, 60) : undefined,
      idempotent: ee.idempotent === true,
      sideEffects: ee.sideEffects != null ? String(ee.sideEffects).slice(0, 40) : undefined,
      credentialScope: ee.credentialScope != null ? String(ee.credentialScope).slice(0, 40) : undefined,
    } : null;

    pruneSeen();
    let skipCode = "";
    let detail = null;

    if (dedupeKey && seen.has(dedupeKey)) {
      skipCode = "duplicate";
      detail = { lastAt: seen.get(dedupeKey) };
    } else if (triggerId && inflight.has(triggerId)) {
      skipCode = "inflight";                        // 不取消旧运行，见文件头判断 ①
      detail = { inflightRunId: inflight.get(triggerId) };
    } else if (cooldownMs > 0 && triggerId) {
      const last = lastStartedAt(triggerId, t);
      if (last >= 0 && t - last < cooldownMs) {
        skipCode = "cooldown";
        detail = { lastAt: last };
      }
    }

    /* 安全闸门由调用方裁决（STOP.on / 能力清单 / 危险确认），账本只负责留痕：
       被拦下的点火也必须有一条收据，否则「为什么没跑」永远查不到。 */
    if (!skipCode && input.blockedBy) {
      skipCode = String(input.blockedBy);
      detail = { gate: String(input.blockedBy) };
    }

    const runId = `wr-${++seq}-${newId()}`;
    const base = {
      runId, triggerId, workflow, source,
      eventId: String(input.eventId || ""), dedupeKey,
      startedAt: t, endedAt: 0, epoch,
      status: skipCode ? "skipped" : "running",
      reasonCode: skipCode || "", steps: 0, error: "",
      /* ORB 独有的执行上下文：哪一层点火、哪一档升级策略、归哪张工单。
         云端引擎没有这些字段，但少了它们就无法判断「这条菜谱值不值得升 auto」。 */
      layer: String(input.layer || source),
      escalate: String(input.escalate || ""),
      policyEpoch: Number(input.policyEpoch) || 0,
      ticketId: String(input.ticketId || ""),
      // S5：只在声明了契约时挂字段，避免污染存量运行记录（append 会把 undefined 自动丢掉）。
      ...(expectedEvent ? { expectedEvent } : {}),
    };
    if (skipCode) {
      base.detail = detail || {};
      append(base);
      compact();
      return { ok: false, code: skipCode, run: { ...base } };
    }

    if (dedupeKey) seen.set(dedupeKey, t);
    if (triggerId) inflight.set(triggerId, runId);
    append(base);
    compact();
    return { ok: true, run: { ...base } };
  }

  /* 冷却只按**同一条触发器真正开跑过**的时间算；skipped / interrupted 不算数。 */
  function lastStartedAt(triggerId, t) {
    let last = -1;
    for (const r of runs.values()) {
      if (r.triggerId !== triggerId) continue;
      if (r.status === "skipped" || r.status === "interrupted") continue;
      const at = r.startedAt || 0;
      if (at > last && at <= t) last = at;
    }
    return last;
  }

  /* 回放质量字段：由 wfPlay 的 ctx 回传，衡量「确定性执行有没有退化成视觉摸索」。
     takeovers 多 / anchorFallbacks 多 = 界面漂移严重，observe 阶段就不该升 auto。
     2026-11-08 增加三项：retries（有限重试次数）、verdict / evidenceLevel（独立判定的
     结论与证据强度）。不定白名单里就会在落盘时被静默丢掉 —— 现象是「面板上看不到判定」，
     而账本里也查不出来，属于最难查的一类。 */
  const QUALITY_FIELDS = [
    "takeovers", "anchorFallbacks", "verifyFailed", "degradedReason", "skippedRead", "finishedEarly",
    "retries", "verdict", "evidenceLevel",
  ];

  function finish(runId, patch = {}) {
    const cur = runs.get(String(runId));
    if (!cur) return null;
    const next = {
      ...cur,
      status: String(patch.status || (patch.ok === false ? "failed" : "ok")),
      reasonCode: String(patch.reasonCode || ""),
      steps: Math.max(0, Number(patch.steps) || 0),
      error: String(patch.error || "").slice(0, 300),
      endedAt: now(),
      detail: undefined,
    };
    delete next.detail;
    for (const k of QUALITY_FIELDS) {
      if (patch[k] !== undefined) next[k] = typeof patch[k] === "number" ? patch[k] : String(patch[k]).slice(0, 120);
    }
    append(next);
    if (cur.triggerId && inflight.get(cur.triggerId) === cur.runId) inflight.delete(cur.triggerId);
    return { ...next };
  }

  /** 急停：带外把所有在跑的运行标 interrupted，并清空单飞占位。 */
  function abortAll(reason = "急停", epoch = 0) {
    let n = 0;
    for (const r of [...runs.values()]) {
      if (!ACTIVE.has(r.status)) continue;
      append({ ...r, status: "interrupted", endedAt: now(), epoch: epoch || r.epoch,
        reasonCode: "stopped", error: String(reason).slice(0, 200) });
      n++;
    }
    inflight.clear();
    return n;
  }

  /* ---------------- 复核（needs_review 的闭环） ----------------
   *
   * 这里的红线：**复核不改判**。
   *   `status` / `verdict` 保持原样，只追加"谁在什么时候看过、看完怎么认"。
   * 理由和 needs_review 本身的定义一致 —— 它表达的是"系统没拿到足够证据"，
   * 而"人看过了，觉得没问题"是一句人的判断，不能反过来变成系统的证据。
   * 一旦用复核结果覆盖 verdict，autoPolicy 就会拿人的主观判断当零退化样本，
   * 那就绕回了这轮改造一开始要拆掉的那个自证循环。
   *
   * 允许的结论只三档，且都有明确语义：
   *   accepted —— 结果符合预期（但系统仍然没有证据，下次还是会 needs_review）
   *   rejected —— 确实失败了（人判的，不写进 verdict，只作复核记录）
   *   ignored  —— 本次不追了（噪音 / 探测环境问题）
   */
  const REVIEW_VERDICTS = new Set(["accepted", "rejected", "ignored"]);

  function markReviewed(runId, arg = {}) {
    const cur = runs.get(String(runId));
    if (!cur) return { ok: false, error: "运行不存在：" + runId };
    if (cur.status === "running") return { ok: false, error: "这次运行还没结束，不能复核" };
    const v = String(arg.verdict || "accepted");
    if (!REVIEW_VERDICTS.has(v)) {
      return { ok: false, error: `复核结论只能是 accepted / rejected / ignored，收到 ${v}` };
    }
    const next = {
      ...cur,
      reviewedAt: now(),
      reviewedBy: String(arg.by || "user").slice(0, 60),
      reviewVerdict: v,
      reviewNote: String(arg.note || "").slice(0, 300),
      /* 记下复核当时的判定，方便将来回答"这条复核是在什么结论上做的"。
         不覆盖 verdict —— 见上面那段。 */
      reviewedOnVerdict: String(cur.verdict || cur.status || ""),
    };
    append(next);
    return { ok: true, run: { ...next } };
  }

  /** 撤销复核（点错了要能退回来）。 */
  function unreview(runId) {
    const cur = runs.get(String(runId));
    if (!cur) return { ok: false, error: "运行不存在：" + runId };
    if (!cur.reviewedAt) return { ok: false, error: "这次运行没有复核记录" };
    const next = { ...cur };
    for (const k of ["reviewedAt", "reviewedBy", "reviewVerdict", "reviewNote", "reviewedOnVerdict"]) delete next[k];
    append(next);
    return { ok: true, run: { ...next } };
  }

  /**
   * 待复核队列：只列"系统判了 needs_review 且还没人看过"的运行。
   * 这是"闭环"和"只有入口"的分界线 —— 没有它，用户永远不知道还剩几条没看。
   */
  function reviewQueue(o = {}) {
    const all = [...runs.values()].filter((r) => r.status === "needs_review");
    const pending = all.filter((r) => !r.reviewedAt);
    const reviewed = all.filter((r) => !!r.reviewedAt);
    const rows = (String(o.scope || "pending") === "all" ? all : pending)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const lim = Math.max(1, Math.min(Number(o.limit) || 50, 500));
    return {
      total: all.length, pending: pending.length, reviewed: reviewed.length,
      items: rows.slice(0, lim).map((r) => ({ ...r })),
    };
  }

  function list(o = {}) {
    let all = [...runs.values()];
    if (o.triggerId) all = all.filter((r) => r.triggerId === String(o.triggerId));
    if (o.status) all = all.filter((r) => r.status === String(o.status));
    /* reviewState：pending = 待复核；reviewed = 已复核。只对 needs_review 有意义，
       所以其它状态的运行一律不参与这个筛选（而不是被算成"已复核"）。 */
    if (o.reviewState === "pending") all = all.filter((r) => r.status === "needs_review" && !r.reviewedAt);
    else if (o.reviewState === "reviewed") all = all.filter((r) => !!r.reviewedAt);
    all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    const lim = Math.max(1, Math.min(Number(o.limit) || 50, 500));
    return all.slice(0, lim).map((r) => ({ ...r }));
  }

  /** 某条自动化最近一次运行（列表页直接显示「上次：成功 12s」，不必另做轮询）。 */
  function lastFor(workflow) {
    const name = String(workflow || "");
    let best = null;
    for (const r of runs.values()) {
      if (r.workflow !== name || r.status === "running") continue;
      if (!best || (r.startedAt || 0) > (best.startedAt || 0)) best = r;
    }
    if (!best) return null;
    return { runId: best.runId, status: best.status, layer: best.layer,
      at: best.startedAt, durationMs: Math.max(0, (best.endedAt || 0) - (best.startedAt || 0)),
      takeovers: best.takeovers || 0, reasonCode: best.reasonCode || "" };
  }

  function stats() {
    const byStatus = {};
    let running = 0;
    let pendingReview = 0;
    let reviewed = 0;
    for (const r of runs.values()) {
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      if (ACTIVE.has(r.status)) running++;
      if (r.status === "needs_review") {
        if (r.reviewedAt) reviewed++;
        else pendingReview++;
      }
    }
    return { total: runs.size, running, inflight: inflight.size, dedupe: seen.size,
      byStatus, pendingReview, reviewed };
  }

  load();

  return { begin, finish, abortAll, reapDangling, list, lastFor, stats,
    markReviewed, unreview, reviewQueue, REVIEW_VERDICTS,
    get: (id) => { const r = runs.get(String(id)); return r ? { ...r } : null; } };
}
