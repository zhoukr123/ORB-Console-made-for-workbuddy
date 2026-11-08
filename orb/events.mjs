/* 事件记录：采样/限流、UIA 退化、脱敏转义、凭据不进日志、events.jsonl 幂等 flush。
 * 严禁合并连续 click/wait/type：每个事件单独记录、单独可中断，本模块不提供任何批量
 * GUI 动作合并能力（会吃掉危险确认中断点 / 破坏急停响应粒度 / 模糊回滚边界）。
 * 写盘失败收敛、不抛不崩。 */
import * as fsDefault from "node:fs";
import path from "node:path";

export const REASON_CODES = Object.freeze(["ok", "throttled", "no-session", "degraded-ui", "oversize"]);
const MAX_EVENT_BYTES = 8192;

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/* 不可信文本：凭据/外链/角色标签中和 + HTML 转义，绝不回传原文。 */
function sanitize(v) {
  let s = String(v ?? "");
  s = s.replace(/https?:\/\/[^\s<>"']+/gi, "[link]");
  s = s.replace(/\bwww\.[^\s<>"']+/gi, "[link]");
  s = s.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, "[credential]");
  s = s.replace(/\bsk-[A-Za-z0-9_\-]{6,}/gi, "[credential]");
  s = s.replace(/(?:api[_-]?key|token|password|passwd|secret|credential|authorization)\s*[=:]\s*["']?[^\s"'<>]+/gi, "[credential]");
  s = s.replace(/<\|\s*[^>]*\|>/g, "[tag]");
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const safeToken = (v) => String(v ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);

/* 原始 UIA 树绝不落盘，只留确定性摘要。 */
function hashUi(v) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return `ui-${(h >>> 0).toString(16)}`;
  } catch { return "ui-unknown"; }
}

export function createEventRecorder(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const fs = o.fs || fsDefault;
  const now = typeof o.now === "function" ? o.now : Date.now;
  const fileOf = typeof o.file === "function" ? o.file : () => (o.file || null);
  const sampleMs = num(o.sampleMs, 100);
  const maxPerSec = Math.max(1, Math.floor(num(o.maxPerSec, 20)));

  const mem = [];              // 权威副本（已落盘 + 未落盘）
  const flushedIds = new Set();
  let seq = 0;
  let sessionId = null;
  let lastAt = -Infinity;
  let winStart = -Infinity;
  let winCount = 0;
  let recorded = 0, throttled = 0, degraded = 0, sessions = 0;

  function parseFile() {
    const rows = [];
    const f = fileOf();
    if (!f) return rows;
    try {
      const txt = fs.readFileSync(f, "utf8");
      for (const ln of txt.split("\n")) {
        if (!ln.trim()) continue;
        try { const r = JSON.parse(ln); if (r && typeof r === "object") rows.push(r); } catch {}
      }
    } catch {}
    return rows;
  }

  // 启动时载入既有 events.jsonl，使 read 跨实例可见
  for (const r of parseFile()) {
    mem.push(r);
    flushedIds.add(r.id);
    if (num(r.id, 0) > seq) seq = num(r.id, 0);
  }

  function start(sid) {
    sessionId = safeToken(sid) || `s-${now()}`;
    sessions++;
    lastAt = -Infinity;
    winStart = now();
    winCount = 0;
    return { ok: true, sessionId };
  }

  function record(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    if (!sessionId) return { ok: false, reasonCode: "no-session" };
    const t = now();
    if (t - lastAt < sampleMs) { throttled++; return { ok: false, reasonCode: "throttled" }; }
    if (t - winStart >= 1000) { winStart = t; winCount = 0; }
    if (winCount >= maxPerSec) { throttled++; return { ok: false, reasonCode: "throttled" }; }

    const x = num(a.x, 0);
    const y = num(a.y, 0);
    const hasUi = a.uiTree !== null && a.uiTree !== undefined;
    const row = {
      id: ++seq,
      ts: t,
      sessionId,
      type: safeToken(a.type || "event"),
      windowTitle: sanitize(a.windowTitle),
      focus: sanitize(a.focus),
      x, y,
      text: sanitize(a.text),
      degraded: false,
      uiTreeHash: hasUi ? hashUi(a.uiTree) : null,
    };
    if (!hasUi) {
      // UIA 拿不到：退化为 click:{x,y} + windowTitle，标 degraded
      row.degraded = true;
      row.click = { x, y };
    }
    if (Buffer.byteLength(JSON.stringify(row), "utf8") > MAX_EVENT_BYTES) {
      return { ok: false, reasonCode: "oversize" };
    }
    lastAt = t;
    winCount++;
    recorded++;
    mem.push(row);
    if (!hasUi) degraded++;
    return { ok: true, reasonCode: hasUi ? "ok" : "degraded-ui" };
  }

  function read(o2 = {}) {
    const a = o2 && typeof o2 === "object" ? o2 : {};
    const since = num(a.since, 0);
    let lim = a.limit == null ? 100 : Math.max(0, Math.floor(num(a.limit, 100)));
    const seen = new Set();
    const out = [];
    // 1) events.jsonl 按行解析
    for (const r of parseFile()) {
      if (r.id != null && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
    // 2) 合并未落盘的内存行（按 id 去重）
    for (const r of mem) {
      if (r.id != null && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
    }
    let rows = out.filter((r) => num(r.ts, 0) >= since);
    rows.sort((p, q) => (num(p.ts, 0) - num(q.ts, 0)) || (num(p.id, 0) - num(q.id, 0)));
    if (lim === 0) return [];
    return rows.slice(-lim).map((r) => ({ ...r }));
  }

  function flush() {
    const f = fileOf();
    if (!f) return { ok: true, appended: 0 };
    const pending = mem.filter((r) => !flushedIds.has(r.id));
    if (!pending.length) return { ok: true, appended: 0 };
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, pending.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      for (const r of pending) flushedIds.add(r.id);
    } catch { /* 写盘失败收敛，不标记 flushed，下次可重试 */ }
    return { ok: true, appended: pending.length };
  }

  function stats() {
    return { recorded, throttled, degraded, sessions };
  }

  return { start, record, read, flush, stats };
}
