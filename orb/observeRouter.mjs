/* Observe 路由：只记录判定，绝不建 Ticket、绝不执行任何动作。
 * 每个被拒事件都落 disposition(带 reasonCode)；系统自身事件直接丢弃。
 * 两档强度：explicit-request(用户本机会话) / inferred-candidate(触发器/文件变化/定时)。
 * 依赖经 opts 注入；写盘失败绝不影响主流程。 */
import * as fsDefault from "node:fs";
import path from "node:path";

export const REASON_CODES = [
  "self-event", "duplicate", "over-budget", "low-confidence",
  "unsupported", "explicit-request", "inferred-candidate",
];

const SELF_SOURCES = new Set(["system", "self", "internal", "orb"]);
const EXPLICIT_SOURCES = new Set(["user", "local-session", "explicit", "human", "me", "chat"]);
const INFERRED_SOURCES = new Set(["trigger", "file-change", "timer", "schedule", "watcher", "cron", "poll", "inferred", "filewatch"]);
const LOW_CONFIDENCE = 0.4;

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function norm(event) {
  const e = event && typeof event === "object" ? event : {};
  const source = String(e.source ?? e.origin ?? e.from ?? "");
  const self = e.self === true || e.originator === "self" || SELF_SOURCES.has(source);
  const strengthValid = e.strength === "explicit-request" || e.strength === "inferred-candidate";
  const explicit = strengthValid ? e.strength === "explicit-request" : EXPLICIT_SOURCES.has(source) || e.explicit === true;
  const inferred = strengthValid ? e.strength === "inferred-candidate" : INFERRED_SOURCES.has(source);
  const supported = self || strengthValid || explicit || inferred;
  return {
    source,
    self,
    explicit,
    supported,
    strength: explicit ? "explicit-request" : "inferred-candidate",
    ruleId: typeof e.ruleId === "string" && e.ruleId ? e.ruleId : "default",
    key: e.key != null ? String(e.key) : (e.contentHash != null ? String(e.contentHash) : null),
    confidence: e.confidence,
    overBudget: e.overBudget === true || e.budgetOk === false || e.over_budget === true,
    owner: String(e.owner ?? e.assignee ?? ""),
  };
}

export function createObserveRouter(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const fs = opts.fs || fsDefault;
  const fileOf = typeof opts.file === "function" ? opts.file : () => (opts.file || null);
  const hitThreshold = num(opts.hitThreshold, 0.7);
  const minSamples = Number(opts.minSamples) > 0 ? Number(opts.minSamples) : 30;
  const maxRows = Number(opts.maxRows) > 0 ? Number(opts.maxRows) : 5000;

  const rowsArr = [];          // 每行即一条判定记录（含 disposition）
  const seen = new Set();      // dedup key
  const flushed = new Set();   // 已落盘的 routeAttemptId
  let seq = 0;

  const nextId = () => `ra-${++seq}-${now()}`;

  function evict() {
    while (rowsArr.length > maxRows) rowsArr.shift();
  }

  /* 生成行：被拒(ignore/filtered)必带 disposition；accept 不带。 */
  function pushRow(base, rejected, ts) {
    const row = {
      ...base,
      disposition: rejected ? { at: ts, reasonCode: base.reasonCode, rejected: true } : null,
      human: null,
    };
    rowsArr.push(row);
    evict();
    return {
      routeAttemptId: row.routeAttemptId,
      ruleId: row.ruleId,
      decision: row.decision,
      wouldAccept: row.wouldAccept,
      confidence: row.confidence,
      reasonCode: row.reasonCode,
    };
  }

  function assess(event) {
    const e = norm(event);
    const routeAttemptId = nextId();
    const ts = now();
    const base = {
      routeAttemptId, ruleId: e.ruleId, ts,
      source: e.source, strength: e.strength, owner: e.owner,
      decision: "filtered", wouldAccept: false, confidence: 0, reasonCode: "self-event",
    };

    // 1) 系统自身事件：直接丢弃，仅留 disposition
    if (e.self) {
      base.reasonCode = "self-event";
      base.strength = "self-event";
      return pushRow(base, true, ts);
    }
    // 2) 重复内容：直接拒
    if (e.key && seen.has(e.key)) {
      base.decision = "ignore";
      base.reasonCode = "duplicate";
      base.strength = "duplicate";
      return pushRow(base, true, ts);
    }
    // 3) 不支持的事件类型
    if (!e.supported) {
      base.reasonCode = "unsupported";
      base.strength = "unsupported";
      return pushRow(base, true, ts);
    }

    // 候选事件：登记 dedup key（后续相同事件即 duplicate）
    if (e.key) seen.add(e.key);

    const confidence = clamp01(num(e.confidence, e.explicit ? 0.9 : 0.5));
    base.confidence = confidence;

    if (e.overBudget) {
      base.decision = "ignore";
      base.reasonCode = "over-budget";
    } else if (confidence < LOW_CONFIDENCE) {
      base.decision = "filtered";
      base.reasonCode = "low-confidence";
    } else if (e.explicit) {
      // 显式请求：记录「本会接受」，但绝不建单、绝不执行。
      base.decision = "accept";
      base.wouldAccept = true;
      base.reasonCode = "explicit-request";
    } else {
      // 推断候选：一律不自动接受，只记录判定供人工标注。
      base.decision = "ignore";
      base.reasonCode = "inferred-candidate";
    }
    return pushRow(base, base.decision !== "accept", ts);
  }

  function recordHuman(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const row = rowsArr.find((r) => r.routeAttemptId === a.routeAttemptId);
    if (!row) return { ok: false };
    row.human = {
      correctOwner: a.correctOwner ?? null,
      shouldCreateTicket: a.shouldCreateTicket === true,
      accepted: a.accepted === true,
      at: now(),
    };
    return { ok: true };
  }

  /* samples = 已人工标注的判定数；hit = 预判(wouldAccept) 与人工真值(shouldCreateTicket) 一致。 */
  function stats() {
    let samples = 0;
    let hits = 0;
    let falseTriggers = 0;
    let misroutes = 0;
    for (const r of rowsArr) {
      if (!r.human) continue;
      samples++;
      const truth = r.human.shouldCreateTicket;
      if (r.wouldAccept === truth) hits++;
      if (r.wouldAccept === true && truth === false) falseTriggers++;
      if (truth === true && r.human.correctOwner && r.owner && r.human.correctOwner !== r.owner) misroutes++;
    }
    return {
      samples,
      hitRate: samples ? hits / samples : 0,
      falseTriggerRate: samples ? falseTriggers / samples : 0,
      misrouteRate: samples ? misroutes / samples : 0,
    };
  }

  function canEnableAuto() {
    const s = stats();
    if (s.samples < minSamples) return { ok: false, reason: `样本不足: ${s.samples}/${minSamples}` };
    if (s.hitRate < hitThreshold) return { ok: false, reason: `命中率不足: ${s.hitRate.toFixed(3)}/${hitThreshold}` };
    return { ok: true, reason: "ok" };
  }

  function rows() {
    return rowsArr.map((r) => ({
      ...r,
      disposition: r.disposition ? { ...r.disposition } : null,
      human: r.human ? { ...r.human } : null,
    }));
  }

  function flush() {
    const f = fileOf();
    if (!f) return { ok: true, appended: 0 };
    const pending = [];
    let chunk = "";
    for (const r of rowsArr) {
      if (flushed.has(r.routeAttemptId)) continue;
      pending.push(r.routeAttemptId);
      chunk += JSON.stringify(r) + "\n";
    }
    if (!pending.length) return { ok: true, appended: 0 };
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, chunk, "utf8");
      for (const id of pending) flushed.add(id);
    } catch {
      // 写盘失败绝不影响主流程；未标记 flushed，下次可重试。
    }
    return { ok: true, appended: pending.length };
  }

  return { assess, recordHuman, stats, canEnableAuto, flush, rows };
}
