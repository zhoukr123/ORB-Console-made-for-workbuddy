/* ---------------- 成本账本（costLedger） ----------------
 *
 * 为什么它不是"优化项"而是"判据项"：
 * 后面三件事全都得先有钱的数才能决策 ——
 *   · ASR 常驻保活：占 2.1GB 显存换几秒等待，值不值？
 *   · 视觉档位：多走一步换多少 token？
 *   · 要不要开 N 个后台 Worker：并发是"近似线性放大上下文与缓存成本"，
 *     没有 per-ticket 账单，就是拿账单赌感觉。
 *
 * 一条铁律：**估算值必须显式标记**。
 * ORB 走的是 CLI 桥，不是直连模型 API，usage 未必回吐。拿不到真实 token 时
 * 只能按字符数估，此时 estimated=true 一路带到底、进汇总也不洗白。
 * 让估算值冒充实测值，比没有账本更糟 —— 那会得出"优化有效"的假结论。
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_TTL_MS = 30 * 24 * 3600 * 1000;
const DEFAULT_MAX_ROWS = 5000;

/* 单价（USD / 百万 token）。**只作为默认值**，可在构造时覆盖。
 * 数值取自 2026-11 公开报价，用途是"相对比较"而不是"精确对账"：
 * 我们真正要回答的是"这一换值不值"，量级对就够。 */
export const DEFAULT_PRICING = {
  "deepseek-v4-pro": { in: 1.32, out: 3.96, cached: 0.132 },
  "deepseek-v4": { in: 0.28, out: 0.42, cached: 0.028 },
  default: { in: 1.32, out: 3.96, cached: 0.132 },
};

/** 粗估 token：中文约 1.5 字符/token，英文约 4 字符/token，混排取 2.2。
 *  误差 ±30%，所以只能用于估算（estimated=true）。 */
export function estimateTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x2e80 && c <= 0x9fff) cjk++;
  }
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function createCostLedger(opts = {}) {
  const dir = opts.dir || process.cwd();
  const file = path.join(dir, opts.file || "cost-ledger.json");
  const now = opts.now || Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const pricing = { ...DEFAULT_PRICING, ...(opts.pricing || {}) };
  const log = opts.log || (() => {});

  const state = { version: 1, seq: 0, rows: [], budgets: {} };
  let saveTimer = null;
  let dirty = false;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || Number(raw.version) > state.version) return;
      state.seq = Number(raw.seq) || 0;
      state.rows = Array.isArray(raw.rows) ? raw.rows.filter((r) => r && typeof r === "object") : [];
      state.budgets = (raw.budgets && typeof raw.budgets === "object") ? raw.budgets : {};
    } catch (err) {
      if (err && err.code !== "ENOENT") log(`[cost] 读盘失败（按空账继续）：${err.message}`);
    }
  }
  function saveNow() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.part`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      try { fs.renameSync(tmp, file); } catch {
        fs.writeFileSync(file, JSON.stringify(state));
        try { fs.unlinkSync(tmp); } catch {}
      }
      dirty = false;
    } catch (err) { log(`[cost] 落盘失败：${err.message}`); }
  }
  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) saveNow(); }, 600);
    if (saveTimer.unref) saveTimer.unref();
  }

  function priceOf(model) {
    const key = String(model || "").toLowerCase();
    if (pricing[key]) return pricing[key];
    // 前缀匹配：deepseek-v4-pro-1102 这类带日期的型号要能命中 deepseek-v4-pro
    const hit = Object.keys(pricing).find((k) => k !== "default" && key.startsWith(k));
    return hit ? pricing[hit] : pricing.default;
  }

  function prune() {
    const t = now();
    const before = state.rows.length;
    state.rows = state.rows.filter((r) => t - (r.at || 0) <= ttlMs);
    if (state.rows.length > maxRows) state.rows = state.rows.slice(-maxRows);
    if (state.rows.length !== before) scheduleSave();
  }

  /**
   * 记一笔。字段全部可缺省，缺哪个就按 0 算，但会把 estimated 透传。
   * 返回落账后的行（含算出来的 costUSD）。
   */
  function record(ticketId, usage = {}) {
    const model = String(usage.model || "default");
    const p = priceOf(model);
    const prompt = Math.max(0, Number(usage.promptTokens) || 0);
    const completion = Math.max(0, Number(usage.completionTokens) || 0);
    const cached = Math.max(0, Math.min(Number(usage.cachedTokens) || 0, prompt));
    const billablePrompt = Math.max(0, prompt - cached);

    const costUSD =
      (billablePrompt / 1e6) * p.in +
      (completion / 1e6) * p.out +
      (cached / 1e6) * p.cached;

    const row = {
      id: `c${++state.seq}`,
      ticketId: ticketId ? String(ticketId) : "",
      /* ---- 归因三元组 ----
       * routeAttemptId：**同一单第几次路由尝试**。一次任务可能先走 Fast Path 失败、
       *   再降级走 Slow Path，这两笔必须能分开 —— 否则"误派发一次花了多少钱"
       *   永远算不出来，而这正是开并发之前唯一能拦住"线性放大账单"的判据。
       * ruleId：命中的是哪条规则/哪个专家。为 0 说明是兜底单路。
       * route：最终走的通道（直接回答 / 视觉 / 后台 / 命令）。 */
      routeAttemptId: usage.routeAttemptId ? String(usage.routeAttemptId).slice(0, 64) : "",
      ruleId: usage.ruleId ? String(usage.ruleId).slice(0, 64) : "",
      route: usage.route ? String(usage.route).slice(0, 32) : "",
      model,
      promptTokens: prompt,
      completionTokens: completion,
      cachedTokens: cached,
      totalTokens: prompt + completion,
      costUSD: Number(costUSD.toFixed(6)),
      // 关键：只要有任何一项是估出来的，整笔就标 estimated。
      estimated: usage.estimated === true || usage.estimated == null,
      /* 报告B V-09：结构化命中单（V-01 白名单句型）根本不进视觉循环，
         必须显式记成 0 次 VLM，才能把「12 步→0 步」和「普通后台」分开报。
         非结构化单不写这两个字段（null），绝不把「没记」当成「0 次」。 */
      zeroVlm: usage.zeroVlm === true,
      vlmCalls: usage.zeroVlm === true ? 0 : null,
      degraded: usage.degraded === true,
      degradeReasonCode: usage.degradeReasonCode ? String(usage.degradeReasonCode).slice(0, 48) : "",
      at: now(),
      note: usage.note ? String(usage.note).slice(0, 200) : "",
    };
    state.rows.push(row);
    prune();
    scheduleSave();
    /* 预算判定跟着这一笔走：调用方拿到 exceeded 就能立刻停手，
       不必再来问一次 —— 少一次往返，也少一个"问的瞬间又花了一笔"的窗口。 */
    const budget = budgetStatus(row.ticketId);
    return { ...clone(row), budgetExceeded: budget.exceeded, budget };
  }

  /** 便捷入口：拿不到 usage 时，直接给文本按字符估。 */
  function recordText(ticketId, text, o = {}) {
    const t = estimateTokens(text);
    return record(ticketId, {
      model: o.model,
      promptTokens: o.promptTokens ?? t,
      completionTokens: o.completionTokens ?? 0,
      cachedTokens: o.cachedTokens ?? 0,
      estimated: true,
      note: o.note || "由文本长度估算",
      routeAttemptId: o.routeAttemptId,
      ruleId: o.ruleId,
      route: o.route,
      zeroVlm: o.zeroVlm,
      vlmCalls: o.vlmCalls,
      degraded: o.degraded,
      degradeReasonCode: o.degradeReasonCode,
    });
  }

  function summary(ticketId) {
    const rows = state.rows.filter((r) => r.ticketId === String(ticketId));
    return aggregate(rows, ticketId ? String(ticketId) : "*");
  }

  function totals() {
    return aggregate(state.rows, "*");
  }

  function aggregate(rows, scope) {
    const out = {
      scope, calls: rows.length, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
      totalTokens: 0, costUSD: 0, estimatedCalls: 0, models: {},
      /* 结构化直达单的数量与其 VLM 调用数（恒 0）。这两个数只进 /api/cost
         与工单下钻，不进安全页（报告 §5）。 */
      zeroVlmCalls: 0, zeroVlmVlmCalls: 0,
    };
    for (const r of rows) {
      if (r.zeroVlm === true) { out.zeroVlmCalls++; out.zeroVlmVlmCalls += Number(r.vlmCalls) || 0; }
      out.promptTokens += r.promptTokens;
      out.completionTokens += r.completionTokens;
      out.cachedTokens += r.cachedTokens;
      out.totalTokens += r.totalTokens;
      out.costUSD += r.costUSD;
      if (r.estimated) out.estimatedCalls++;
      const m = out.models[r.model] || (out.models[r.model] = { calls: 0, tokens: 0, costUSD: 0 });
      m.calls++; m.tokens += r.totalTokens; m.costUSD += r.costUSD;
    }
    out.costUSD = Number(out.costUSD.toFixed(6));
    out.cacheHitRate = out.promptTokens ? Number((out.cachedTokens / out.promptTokens).toFixed(4)) : 0;
    out.mixed = out.estimatedCalls > 0 && out.estimatedCalls < out.calls;
    out.allEstimated = out.calls > 0 && out.estimatedCalls === out.calls;
    return out;
  }

  /** 按工单分组的总览：面板"这一单花了多少"直接用。 */
  function byTicket(limit = 50) {
    const groups = new Map();
    for (const r of state.rows) {
      const k = r.ticketId || "(未归属)";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return [...groups.entries()]
      .map(([k, rows]) => aggregate(rows, k))
      .sort((a, b) => b.costUSD - a.costUSD)
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  /* ---------- 路由归因 ----------
   * 这一节存在的唯一理由：回答"哪条规则/哪次路由尝试在花钱"。
   * 没有它，开并发就只能看到总账变贵，却说不出贵在哪个决定上。 */
  function byRoute(limit = 50) {
    const groups = new Map();
    for (const r of state.rows) {
      const key = (r.route || "(未标注)") + "|" + (r.ruleId || "(兜底)");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return [...groups.entries()]
      .map(([k, rows]) => {
        const a = aggregate(rows, k);
        const [route, rule] = k.split("|");
        return { route, ruleId: rule, ...a, avgCostUSD: rows.length ? Number((a.costUSD / rows.length).toFixed(6)) : 0 };
      })
      .sort((x, y) => y.costUSD - x.costUSD)
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  /** 同一条工单里第几次路由尝试的明细（按 attempt 升序）。 */
  function attempts(ticketId) {
    const id = String(ticketId || "");
    const rows = state.rows.filter((r) => r.ticketId === id);
    const groups = new Map();
    for (const r of rows) {
      const k = r.routeAttemptId || "1";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return [...groups.entries()]
      .map(([k, rs]) => ({ attempt: k, ...aggregate(rs, k) }))
      .sort((a, b) => String(a.attempt).localeCompare(String(b.attempt), "en", { numeric: true }));
  }

  /* ---------- 工单预算 ----------
   * 只做"记账侧"：判断超没超、还差多少。**不替调用方决定停不停** ——
   * 停手是执行层的权力，账本只负责把数给准。0 或缺省表示不限。 */
  function setBudget(ticketId, usd) {
    const id = String(ticketId || "");
    if (!id) return { ok: false, error: "缺少 ticketId" };
    const v = Number(usd);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: "预算必须是非负数（0 = 不限）" };
    if (v === 0) delete state.budgets[id];
    else state.budgets[id] = Number(v.toFixed(6));
    scheduleSave();
    return { ok: true, ticketId: id, limitUSD: v === 0 ? 0 : state.budgets[id], unlimited: v === 0 };
  }

  function budgetStatus(ticketId) {
    const id = String(ticketId || "");
    const limit = Number(state.budgets[id] || 0);
    let spent = 0;
    for (const r of state.rows) if (r.ticketId === id) spent += r.costUSD;
    spent = Number(spent.toFixed(6));
    return {
      ticketId: id,
      limitUSD: limit,
      spentUSD: spent,
      leftUSD: limit > 0 ? Number(Math.max(0, limit - spent).toFixed(6)) : null,
      exceeded: limit > 0 && spent > limit,
      unlimited: !(limit > 0),
    };
  }

  function list(o = {}) {
    let rows = state.rows;
    if (o.ticketId) rows = rows.filter((r) => r.ticketId === String(o.ticketId));
    rows = rows.slice(-(Math.max(1, Math.min(Number(o.limit) || 50, 500)))).reverse();
    return rows.map(clone);
  }

  function close() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (dirty) saveNow();
  }

  load();

  return {
    file, record, recordText, summary, totals, byTicket, byRoute, attempts,
    setBudget, budgetStatus, budgets: () => ({ ...state.budgets }),
    list, priceOf, prune, close, flush: saveNow,
  };
}
