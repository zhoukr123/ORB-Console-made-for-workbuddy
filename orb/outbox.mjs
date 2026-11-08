/* ---------------- 发件箱（outbox） ----------------
 *
 * 解决的问题：急停/结束后要通知面板与用户，但"通知"在一次网络/SSE 写里既可能失败，
 * 也可能因为重连被**重复触发**。原实现是"想起来就 push 一下"，
 * 于是同一件事可能推两遍（用户看到两条"已停止"），也可能一遍都没推出去（以为停了，其实没）。
 *
 * 三条规则（抄自 SuperAgent 原型，但这里没上数据库，用的是原子落盘的 JSON）：
 *   ① **幂等键**：消息 id = ticketId|kind|dedupe。同一个键只允许存在一行；
 *      已 sent / 正在 pending 的再 enqueue 一律返回 duplicate，不重发。
 *   ② **落盘先于发送**：intent 先写盘再调 send。崩在中间，重启后还能续。
 *   ③ **失败退避**：5s 起、翻倍、封顶 300s（与原型的 reply effect 同参），
 *      超过 maxAttempts 记 failed —— 失败是**可查的状态**，不是静默丢失。
 *
 * 为什么并发固定为 1：同一会话的消息必须保序（"已停止"不能晚于"正在停止"到），
 * 并发会让顺序取决于谁的网络快。原型把 reply effect 的并发也钉死为 1，同一个理由。
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_TTL_MS = 3 * 24 * 3600 * 1000;
const DEFAULT_MAX_ROWS = 500;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_CAP_MS = 300000;

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/* 稳定序列化：payload 的键序不应影响去重。
 * 否则 {a:1,b:2} 与 {b:2,a:1} 会得到两个不同的 dedupe，去重失效。 */
function stableStringify(v) {
  if (v == null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

/** 幂等键：显式 dedupe 优先，否则用 payload 的稳定哈希（长度 12 的 FNV-1a 十六进制）。 */
export function dedupeKeyOf(kind, dedupe, payload) {
  if (dedupe != null && dedupe !== "") return String(dedupe).slice(0, 80);
  const s = `${kind}:${stableStringify(payload)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return `h${h.toString(16).padStart(8, "0")}`;
}

export function createOutbox(opts = {}) {
  const send = opts.send;
  if (typeof send !== "function") throw new Error("createOutbox 需要 send 函数");
  const dir = opts.dir || process.cwd();
  const file = path.join(dir, opts.file || "outbox.json");
  const now = opts.now || Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  const maxAttempts = opts.maxAttempts ?? 12;
  const log = opts.log || (() => {});

  const state = { version: 1, seq: 0, rows: {} };
  let saveTimer = null;
  let dirty = false;
  let pumping = false;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || Number(raw.version) > state.version) return;
      state.seq = Number(raw.seq) || 0;
      const rows = raw.rows && typeof raw.rows === "object" ? raw.rows : {};
      for (const [id, r] of Object.entries(rows)) if (r && typeof r === "object") state.rows[id] = r;
      prune({ persist: false });
    } catch (err) {
      if (err && err.code !== "ENOENT") log(`[outbox] 读盘失败（按空箱继续）：${err.message}`);
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
    } catch (err) {
      log(`[outbox] 落盘失败：${err.message}`);
    }
  }
  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; if (dirty) saveNow(); }, 400);
    if (saveTimer.unref) saveTimer.unref();
  }

  /* 保留期：已终结的行留 3 天（够查"为什么没发出去"），超过上限先砍最老的终结行。
     pending 行不砍 —— 砍了就真丢了。 */
  function prune(o = {}) {
    const t = now();
    let removed = 0;
    for (const r of Object.values(state.rows)) {
      if (r.status === "pending") continue;
      if (t - (r.endedAt || r.createdAt || 0) > ttlMs) { delete state.rows[r.id]; removed++; }
    }
    const left = Object.values(state.rows);
    if (left.length > maxRows) {
      const victims = left.filter((r) => r.status !== "pending")
        .sort((a, b) => (a.endedAt || a.createdAt) - (b.endedAt || b.createdAt));
      let need = left.length - maxRows;
      for (const v of victims) { if (need <= 0) break; delete state.rows[v.id]; removed++; need--; }
    }
    if (removed && o.persist !== false) scheduleSave();
    return removed;
  }

  /**
   * 入箱。返回 { ok, id, duplicate }。
   * 关键：**同一 id 已存在就绝不复用新 payload 覆盖** —— 覆盖等于把"已发出去的那条"
   * 悄悄改成新内容，用户会以为收到了两次不同的消息。
   */
  function enqueue(input = {}) {
    const kind = String(input.kind || "notice");
    const ticketId = input.ticketId ? String(input.ticketId) : "";
    const dk = dedupeKeyOf(kind, input.dedupe, input.payload);
    const id = `${ticketId || "-"}|${kind}|${dk}`;

    const exist = state.rows[id];
    if (exist) {
      // 重复入箱：不改内容，只把"被要求过几次"记下来，便于排查"是不是有循环重发"。
      exist.tries = Number(exist.tries || 0);
      exist.duplicates = Number(exist.duplicates || 0) + 1;
      scheduleSave();
      return { ok: true, id, duplicate: true, status: exist.status };
    }

    const t = now();
    state.rows[id] = {
      id, ticketId, kind, dedupe: dk,
      payload: clone(input.payload ?? null),
      status: "pending",
      createdAt: t,
      updatedAt: t,
      endedAt: 0,
      attempts: 0,
      nextAt: t,
      lastError: "",
      tries: 0,
      duplicates: 0,
    };
    state.seq++;
    prune({ persist: false });
    saveNow();                       // ② 落盘先于发送：先有 intent，再谈投递
    return { ok: true, id, duplicate: false, status: "pending" };
  }

  /** 同一工单是否有更早的 pending 行（orderture：不许后发先至）。 */
  function behind(ticketId) {
    const t = now();
    return Object.values(state.rows)
      .filter((r) => r.ticketId === String(ticketId) && r.status === "pending" && r.nextAt <= t)
      .sort((a, b) => a.createdAt - b.createdAt)[0] || null;
  }

  function nextDue() {
    const t = now();
    const due = Object.values(state.rows).filter((r) => r.status === "pending" && r.nextAt <= t);
    if (!due.length) return null;
    due.sort((a, b) => a.createdAt - b.createdAt);   // ③ 严格先进先出
    return due[0];
  }

  /**
   * 抽干一次。并发 1；返回 { sent, retried, failed, skipped }。
   * 不抛异常：单个消息失败不该让整轮中断。
   */
  async function pump() {
    if (pumping) return { sent: 0, retried: 0, failed: 0, skipped: 0, busy: true };
    pumping = true;
    const out = { sent: 0, retried: 0, failed: 0, skipped: 0 };
    try {
      for (let guard = 0; guard < 200; guard++) {
        const row = nextDue();
        if (!row) break;
        // 保序：同一工单前面还有未到期的行，就跳过这一条 —— 但只有同一工单才等，
        // 别的工单不该被一条坏消息拖住。
        const ahead = Object.values(state.rows).some(
          (r) => r.id !== row.id && r.ticketId === row.ticketId && r.status === "pending" && r.createdAt < row.createdAt
        );
        if (ahead) { out.skipped++; row.nextAt = now() + 1000; continue; }

        row.attempts = Number(row.attempts || 0) + 1;
        row.updatedAt = now();
        try {
          await send(clone(row));
          row.status = "sent";
          row.endedAt = now();
          row.lastError = "";
          out.sent++;
        } catch (err) {
          row.lastError = String(err?.message ?? err).slice(0, 300);
          const permanent = err && err.permanent === true;
          if (permanent || row.attempts >= maxAttempts) {
            row.status = "failed";
            row.endedAt = now();
            out.failed++;
          } else {
            const wait = Math.min(BACKOFF_BASE_MS * 2 ** (row.attempts - 1), BACKOFF_CAP_MS);
            row.nextAt = now() + wait;
            out.retried++;
          }
        }
      }
      scheduleSave();
      return out;
    } finally {
      pumping = false;
    }
  }

  /** 立刻重试某条（面板"重发"按钮用），不受退避限制。 */
  function retry(id) {
    const r = state.rows[String(id)];
    if (!r) return { ok: false, code: "not-found" };
    if (r.status === "sent") return { ok: false, code: "already-sent" };
    r.status = "pending";
    r.nextAt = now();
    r.attempts = 0;
    r.endedAt = 0;
    scheduleSave();
    return { ok: true };
  }

  function drop(id, reason) {
    const r = state.rows[String(id)];
    if (!r) return { ok: false, code: "not-found" };
    r.status = "dropped";
    r.endedAt = now();
    r.lastError = String(reason || "手动丢弃").slice(0, 300);
    scheduleSave();
    return { ok: true };
  }

  function list(o = {}) {
    let rows = Object.values(state.rows);
    if (o.status) rows = rows.filter((r) => r.status === o.status);
    if (o.ticketId) rows = rows.filter((r) => r.ticketId === String(o.ticketId));
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const limit = Math.max(1, Math.min(Number(o.limit) || 50, 200));
    return rows.slice(0, limit).map(clone);
  }

  function stats() {
    const rows = Object.values(state.rows);
    const by = {};
    for (const r of rows) by[r.status] = (by[r.status] || 0) + 1;
    return {
      total: rows.length,
      pending: by.pending || 0,
      sent: by.sent || 0,
      failed: by.failed || 0,
      dropped: by.dropped || 0,
      duplicateHits: rows.reduce((a, r) => a + Number(r.duplicates || 0), 0),
      failing: rows.filter((r) => r.status === "failed").map((r) => ({ id: r.id, error: r.lastError })),
    };
  }

  function close() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (dirty || Object.values(state.rows).some((r) => r.status === "pending")) saveNow();
  }

  load();

  return { file, enqueue, pump, behind, retry, drop, list, stats, prune, close, flush: saveNow };
}
