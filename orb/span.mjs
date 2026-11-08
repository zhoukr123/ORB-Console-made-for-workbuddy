/* Span 采集器：只提供打点/统计机制，样本不足在 sixMetrics().complete 明确为 false，绝不补假样本。
 * 依赖全部经 opts 注入；写盘失败一律吞掉，绝不影响主流程。 */
import * as fsDefault from "node:fs";
import path from "node:path";

export const METRICS = [
  "eventToTaskMs", "queueMs", "e2eMs",
  "costPerEffectiveWork", "misrouteRate", "interruptCost",
];

const NUMERIC_METRICS = ["eventToTaskMs", "queueMs", "e2eMs", "costPerEffectiveWork", "interruptCost"];
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/* 线性插值分位数：sorted 已升序；count=0 时全 0。 */
function quantile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/* eventToTask / queue 优先取显式值，否则取首个同名 mark 相对 start 的偏移。 */
const FIRST_MARK_ALIASES = {
  eventToTaskMs: ["eventToTask", "firstToken", "taskStart", "firstAction", "ttft"],
  queueMs: ["dequeue", "queueEnd", "queueStart"],
};
function firstMarkAt(span, names) {
  for (const n of names) {
    const m = span.marks.find((x) => x.name === n);
    if (m) return m.at;
  }
  return undefined;
}

export function createSpanCollector(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const fs = opts.fs || fsDefault;
  const fileOf = typeof opts.file === "function" ? opts.file : () => (opts.file || null);
  const maxRows = Number(opts.maxRows) > 0 ? Number(opts.maxRows) : 5000;

  const spans = new Map();        // spanId -> span 记录
  const flushed = new Set();      // 已落盘的 spanId，保证 flush 幂等
  let seq = 0;

  const nextId = () => `sp-${++seq}-${now()}`;

  /* 由已完成的 span 派生各命名指标；缺失返回 undefined，绝不臆造。 */
  function derive(span) {
    const info = span.finishInfo || {};
    const d = {};
    d.e2eMs = Math.max(0, span.finishAt - span.startAt);

    let v = finite(info.eventToTaskMs);
    if (v === undefined) {
      const t = firstMarkAt(span, FIRST_MARK_ALIASES.eventToTaskMs);
      if (t !== undefined) v = t - span.startAt;
    }
    if (v !== undefined) d.eventToTaskMs = v;

    v = finite(info.queueMs);
    if (v === undefined) {
      const t = firstMarkAt(span, FIRST_MARK_ALIASES.queueMs);
      if (t !== undefined) v = t - span.startAt;
    }
    if (v !== undefined) d.queueMs = v;

    const tokens = finite(info.tokens);
    const costUSD = finite(info.costUSD);
    // 仅成功且有效 token>0 才计 costPerEffectiveWork；失败样本不补、不推算。
    if (info.ok === true && costUSD !== undefined && tokens !== undefined && tokens > 0) {
      d.costPerEffectiveWork = costUSD / tokens;
    }

    v = finite(info.interruptCost);
    if (v === undefined) v = finite(info.interrupts);
    if (v !== undefined) d.interruptCost = v;

    let misroute;
    if (info.misroute === true || info.misroute === false) misroute = info.misroute;
    else if (span.labels && typeof span.labels.misroute === "boolean") misroute = span.labels.misroute;
    d.misroute = misroute; // undefined 表示无该标注
    return d;
  }

  /* 完成时的样本表：派生指标 + finishInfo 里的任意数值字段 + 各 mark 相对 start 的耗时。 */
  function buildSamples(span, derived) {
    const s = {};
    for (const k of NUMERIC_METRICS) {
      if (derived[k] !== undefined) s[k] = derived[k];
    }
    const info = span.finishInfo || {};
    for (const [k, v] of Object.entries(info)) {
      if (finite(v) !== undefined && s[k] === undefined) s[k] = v;
    }
    for (const m of span.marks) {
      const key = `mark:${m.name}`;
      if (s[key] === undefined) s[key] = m.at - span.startAt;
    }
    return s;
  }

  function snapshot(span) {
    return {
      spanId: span.spanId,
      name: span.name,
      ticketId: span.ticketId,
      epoch: span.epoch,
      labels: { ...(span.labels || {}) },
      startAt: span.startAt,
      finishAt: span.finishAt,
      marks: span.marks.map((m) => ({ name: m.name, at: m.at })),
      finishInfo: span.finishInfo ? { ...span.finishInfo } : null,
      samples: span.samples ? { ...span.samples } : null,
    };
  }

  /* 内存上限：超出时淘汰最早的已完成 span，防止无界增长。 */
  function evict() {
    while (spans.size > maxRows) {
      let victim = null;
      for (const [id, sp] of spans) {
        if (sp.finishAt !== null) { victim = id; break; }
      }
      if (victim === null) break; // 全是进行中的 span，不淘汰
      spans.delete(victim);
    }
  }

  function start(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const t = now();
    const spanId = nextId();
    spans.set(spanId, {
      spanId,
      name: a.name ?? "",
      ticketId: a.ticketId ?? null,
      epoch: a.epoch ?? 0,
      labels: a.labels && typeof a.labels === "object" ? { ...a.labels } : {},
      startAt: t,
      finishAt: null,
      marks: [],
      finishInfo: null,
      samples: null,
    });
    evict();
    return spanId;
  }

  function mark(spanId, name, at) {
    const sp = spans.get(spanId);
    if (!sp || sp.finishAt !== null || name == null) return false;
    const t = finite(at) !== undefined ? at : now();
    sp.marks.push({ name: String(name), at: t });
    return true;
  }

  function finish(spanId, info = {}) {
    const sp = spans.get(spanId);
    if (!sp || sp.finishAt !== null) return { ok: false, durationMs: 0 };
    const payload = info && typeof info === "object" ? info : {};
    const t = now();
    sp.finishAt = t;
    sp.finishInfo = { ...payload };
    const derived = derive(sp);
    sp.samples = buildSamples(sp, derived);
    sp.misroute = derived.misroute;
    return { ok: true, durationMs: Math.max(0, t - sp.startAt) };
  }

  function percentiles(name) {
    const vals = [];
    let failed = 0;
    for (const sp of spans.values()) {
      if (sp.finishAt === null || !sp.samples) continue;
      const v = sp.samples[name];
      if (finite(v) === undefined) continue;
      vals.push(v);
      if (sp.finishInfo && sp.finishInfo.ok === false) failed++;
    }
    vals.sort((a, b) => a - b);
    const count = vals.length;
    return {
      p50: quantile(vals, 0.5),
      p95: quantile(vals, 0.95),
      p99: quantile(vals, 0.99),
      count,
      failRate: count ? failed / count : 0,
    };
  }

  function sixMetrics() {
    const out = {};
    let complete = true;
    for (const k of NUMERIC_METRICS) {
      const p = percentiles(k);
      out[k] = p.count > 0 ? p.p50 : 0;
      if (p.count === 0) complete = false;
    }
    // misrouteRate：仅在有真实 misroute 标注的已完成 span 上统计，无标注不补。
    let defined = 0;
    let misrouted = 0;
    for (const sp of spans.values()) {
      if (sp.finishAt === null) continue;
      if (sp.misroute === true || sp.misroute === false) {
        defined++;
        if (sp.misroute) misrouted++;
      }
    }
    out.misrouteRate = defined ? misrouted / defined : 0;
    if (defined === 0) complete = false;

    let finished = 0;
    for (const sp of spans.values()) if (sp.finishAt !== null) finished++;
    out.samples = finished;
    // complete：六个指标都必须有真实样本；任一缺失即明确「未完成」。
    out.complete = complete;
    return out;
  }

  function rows() {
    const out = [];
    for (const sp of spans.values()) out.push(snapshot(sp));
    return out;
  }

  function stats() {
    let finished = 0;
    let marks = 0;
    for (const sp of spans.values()) {
      if (sp.finishAt !== null) finished++;
      marks += sp.marks.length;
    }
    const samplesByMetric = {};
    for (const k of METRICS) samplesByMetric[k] = percentiles(k).count;
    let misrouteDefined = 0;
    let misrouted = 0;
    for (const sp of spans.values()) {
      if (sp.finishAt === null) continue;
      if (sp.misroute === true || sp.misroute === false) {
        misrouteDefined++;
        if (sp.misroute) misrouted++;
      }
    }
    samplesByMetric.misrouteRate = misrouteDefined;
    return {
      total: spans.size,
      finished,
      open: spans.size - finished,
      marks,
      flushed: flushed.size,
      samplesByMetric,
      misrouteDefined,
      misrouted,
    };
  }

  function flush() {
    const f = fileOf();
    if (!f) return { ok: true, appended: 0 };
    const pending = [];
    let chunk = "";
    for (const sp of spans.values()) {
      if (sp.finishAt === null || flushed.has(sp.spanId)) continue;
      pending.push(sp.spanId);
      chunk += JSON.stringify(snapshot(sp)) + "\n";
    }
    if (!pending.length) return { ok: true, appended: 0 };
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, chunk, "utf8");
      for (const id of pending) flushed.add(id); // 仅成功后标记，失败可重试
    } catch {
      // 写盘失败绝不影响主流程，也不标记 flushed，下次 flush 可再试。
    }
    return { ok: true, appended: pending.length };
  }

  return { start, mark, finish, percentiles, sixMetrics, flush, rows, stats };
}
