/* 日志总线：枚举校验 + 白名单 + 脱敏转义 + 限流 + 按天分类 jsonl 轮转。
 * 写失败一律被吞掉并收敛，绝不因日志拖垮主流程。
 * 日志与产物同处按日期分层的目录树（dirFor），绝不写进 audit/。 */
import * as fsDefault from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { redactValue } from "./outputProfile.mjs";

export const CATEGORIES = ["task", "trigger", "tool", "gui", "media", "memory", "persona", "safety", "cost", "artifact", "plugin", "system"];
export const LEVELS = ["debug", "info", "warn", "error", "audit"];
export const RETENTION_DAYS = { debug: 7, info: 30, warn: 30, error: 90, audit: 30 };

const ZEROS = "0".repeat(64);
const safeId = (v) => String(v ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
/* 任何含独立 audit 段的路径都拒绝落地：结构化日志绝不进 audit/。 */
const isAuditDir = (p) => /(^|[\\/])audit([\\/]|$)/i.test(String(p));
const isSpoolDir = (p) => String(p).split(/[\\/]+/).pop().toLowerCase() === "spool";
const normalizeDay = (d) => String(d ?? "").replace(/-/g, "");
/* dayFor/dayOf 一律输出 YYYY-MM-DD；内部 dayTag 的无横线写法在此统一回转。 */
function dashedDay(d) {
  const s = normalizeDay(d);
  return s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : String(d ?? "");
}

export function createLogBus(opts = {}) {
  const dir = opts.dir || path.join(os.tmpdir(), "orb-logbus");
  const fs = opts.fs || fsDefault;
  const now = opts.now || Date.now;
  const maxLineBytes = Number(opts.maxLineBytes) || 4096;
  const ratePerSec = Number(opts.ratePerSec) || 200;
  const epochFn = typeof opts.epoch === "function" ? opts.epoch : () => 0;
  const hasDirFor = typeof opts.dirFor === "function";
  /* 固定 UTC+8，不依赖宿主 TZ。 */
  const dayOfFn = typeof opts.dayOf === "function" ? opts.dayOf
    : (t) => new Date(Number(t) + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const dayOf = (t) => dashedDay(dayOfFn(t));
  const dayTag = (t) => normalizeDay(dayOf(t)).slice(0, 8);
  let minLevel = LEVELS.includes(opts.minLevel) ? opts.minLevel : "debug";
  let redactPaths = opts.redactPaths !== false;
  const chainOpt = opts.chain;
  const chainEnabled = !!chainOpt;
  const chainCfg = chainOpt && typeof chainOpt === "object" ? chainOpt : {};

  const mem = [];                 // 进程内权威副本，供 query
  const files = new Set();
  const streams = new Map();
  const failed = new Set();
  const knownDirs = new Set();     // 本进程用过的按天目录，供 cleanup / loadExisting 发现
  const knownDays = new Set();
  let closed = false;
  let written = 0;
  let rejected = 0;
  let spooled = 0;                // 累计从 spool 待发队列回放成功的记录数
  let winStart = -Infinity;
  let winCount = 0;
  let lastErr = null;
  let chainState = null;          // { sequence, lastHash, day }

  /* 不可信文本：凭据/路径片段 → 摘要，外链/指令文本中和，最后统一 HTML 转义。
   * redactPaths=false 时仅跳过路径 mask，凭据/Bearer/sk-/外链/HTML/指令注入中和一律保留。 */
  function sanitize(text) {
    let s = String(text ?? "");
    const mask = (m) => redactValue(m);
    // 外链先整体中和，避免其中的 //host/path 被下面的路径规则误伤
    s = s.replace(/https?:\/\/[^\s<>"']+/gi, "[link]");
    s = s.replace(/\bwww\.[^\s<>"']+/gi, "[link]");
    s = s.replace(/\bBearer\s+[A-Za-z0-9._\-+/=]+/gi, mask);
    s = s.replace(/\bsk-[A-Za-z0-9_\-]{6,}/gi, mask);
    s = s.replace(/(?:api[_-]?key|token|password|passwd|secret|credential)\s*[=:]\s*["']?[^\s"'<>]+/gi, mask);
    if (redactPaths) {
      s = s.replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, mask);                 // Windows 路径
      s = s.replace(/(?<![\w])\/(?:[^\s"'<>]+\/)+[^\s"'<>]+/g, mask);    // POSIX 路径
    }
    s = s.replace(/<\|\s*[^>]*\|>/g, (m) => `[tag]${m.replace(/[<>|]/g, "")}[/tag]`);
    s = s.replace(/\[\/?INST\]/gi, "[tag]INST[/tag]");
    s = s.replace(/ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions?/gi, "[instruction-neutralized]");
    s = s.replace(/忽略(?:之前|以上|上面|所有|前面|先前).{0,8}(?:指令|提示|要求|规则)/g, "[instruction-neutralized]");
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* 二分找最大 message 长度，使整行 JSON 字节数 <= maxLineBytes。 */
  function fitLine(row) {
    const full = JSON.stringify(row);
    if (Buffer.byteLength(full, "utf8") <= maxLineBytes) return full;
    let lo = 0, hi = row.message.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const line = JSON.stringify({ ...row, message: row.message.slice(0, mid) });
      if (Buffer.byteLength(line, "utf8") <= maxLineBytes) lo = mid; else hi = mid - 1;
    }
    return JSON.stringify({ ...row, message: row.message.slice(0, lo) });
  }

  function rateOk(t) {
    if (t - winStart >= 1000) { winStart = t; winCount = 0; }
    if (winCount >= ratePerSec) return false;
    winCount++;
    return true;
  }

  /* minLevel 阈值：低于阈值直接拒，但 audit / error 永不拦截（急停/危险必须留痕）。 */
  function levelFiltered(level) {
    if (level === "audit" || level === "error") return false;
    const mi = LEVELS.indexOf(minLevel);
    const li = LEVELS.indexOf(level);
    return mi > 0 && li < mi;
  }

  function dirForDay(day, category) {
    const d = dashedDay(day);
    knownDays.add(d);
    let target;
    if (hasDirFor) {
      try { target = opts.dirFor(d, category); } catch { target = null; }
      target = target ? String(target) : null;
    } else target = dir;
    if (!target || isAuditDir(target)) return null;
    knownDirs.add(target);
    return target;
  }

  function ensureDir(file) {
    if (isAuditDir(file)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return true;
  }

  function streamFor(file) {
    let st = streams.get(file);
    if (st && !st.destroyed && !st.errored) return st;
    st = fs.createWriteStream(file, { flags: "a", encoding: "utf8" });
    // 关键：error 必须挂监听，写失败只标记、不抛、不影响主流程
    st.on("error", (err) => { failed.add(file); lastErr = err; });
    streams.set(file, st);
    files.add(path.basename(file));
    return st;
  }

  function endStream(st) {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      st.once("finish", fin);
      st.once("error", fin);
      try { st.end(); } catch { fin(); }
      const timer = setTimeout(fin, 1000);
      if (timer.unref) timer.unref();
    });
  }

  /* 原子写：.part + rename，供链状态与 cleanup 重写复用。 */
  function atomicWrite(file, text) {
    if (isAuditDir(file)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const part = file + ".part";
    fs.writeFileSync(part, text, "utf8");
    fs.renameSync(part, file);
    return true;
  }

  function chainStateFile(day) {
    const f = typeof chainCfg.stateFile === "function" ? chainCfg.stateFile(day)
      : typeof chainCfg.stateFile === "string" ? chainCfg.stateFile : null;
    return f ? String(f) : path.join(dirForDay(day, undefined) || dir, "chain-state.json");
  }

  function chainManifestFile(day) {
    const f = typeof chainCfg.manifestFile === "function" ? chainCfg.manifestFile(day)
      : typeof chainCfg.manifestFile === "string" ? chainCfg.manifestFile : null;
    return f ? String(f) : path.join(dirForDay(day, undefined) || dir, "manifest.jsonl");
  }

  function getChain() {
    if (chainState) return chainState;
    let st = { sequence: 0, lastHash: ZEROS, day: dayOf(now()) };
    try {
      const f = chainStateFile(st.day);
      if (f && !isAuditDir(f) && fs.existsSync(f)) {
        const p = JSON.parse(fs.readFileSync(f, "utf8"));
        if (p && Number.isFinite(p.sequence) && typeof p.lastHash === "string") {
          st = { sequence: p.sequence, lastHash: p.lastHash, day: p.day || st.day };
        }
      }
    } catch {}
    chainState = st;
    return st;
  }

  function chainHash(prevHash, row, seq) {
    const payload = { ts: row.ts, category: row.category, level: row.level, epoch: row.epoch, message: row.message, seq };
    return createHash("sha256").update(prevHash + "\n" + JSON.stringify(payload), "utf8").digest("hex");
  }

  /* 链状态 {sequence,lastHash,day} 原子落盘，并给每条链记录追加一行 manifest。 */
  function persistChain(info, hash, row) {
    const st = chainState || (chainState = { sequence: 0, lastHash: ZEROS, day: info.day });
    st.sequence = info.seq;
    st.lastHash = hash;
    st.day = info.day;
    try { atomicWrite(chainStateFile(info.day), JSON.stringify({ sequence: st.sequence, lastHash: st.lastHash, day: st.day }) + "\n"); } catch {}
    try {
      const mf = chainManifestFile(info.day);
      if (mf && !isAuditDir(mf)) {
        fs.mkdirSync(path.dirname(mf), { recursive: true });
        fs.appendFileSync(mf, JSON.stringify({
          ts: row.ts, category: row.category, level: row.level,
          seq: info.seq, prevHash: info.prevHash, hash,
        }) + "\n", "utf8");
        files.add(path.basename(mf));
      }
    } catch {}
  }

  /* 收集要扫描的按天日志目录。没传 dirFor 时退化为单目录 dir。 */
  function collectScanDirs() {
    const out = new Set();
    if (!hasDirFor) { out.add(dir); return out; }
    for (const d of [...knownDirs]) out.add(d);
    const cur = dayOf(now());
    for (const cat of CATEGORIES) {
      const d = dirForDay(cur, cat);
      if (d) out.add(d);
    }
    // 从公共父层枚举同类日期目录，覆盖重启后本进程尚未写过的旧日志。
    try {
      const base = dirForDay(cur, "system") || dir;
      const root = path.dirname(path.dirname(base));
      for (const name of fs.readdirSync(root)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
        for (const cat of CATEGORIES) {
          const d = dirForDay(name, cat);
          if (d) out.add(d);
        }
        const d0 = dirForDay(name, undefined);
        if (d0) out.add(d0);
      }
    } catch {}
    return out;
  }

  function collectDays() {
    const days = new Set();
    const cur = dayOf(now());
    days.add(cur);
    for (const d of knownDays) days.add(d);
    try {
      const base = dirForDay(cur, "system") || dir;
      const root = path.dirname(path.dirname(base));
      for (const name of fs.readdirSync(root)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(name)) days.add(name);
      }
    } catch {}
    return days;
  }

  function spoolDirOf(day) {
    let sd = null;
    if (typeof opts.spoolDirFor === "function") {
      try { sd = opts.spoolDirFor(day); } catch { sd = null; }
      sd = sd ? String(sd) : null;
    } else {
      sd = path.join(dirForDay(day, "system") || dir, "spool");
    }
    if (!sd || isAuditDir(sd)) return null;
    return sd;
  }

  function loadExisting() {
    try {
      for (const d of collectScanDirs()) {
        if (!d || isAuditDir(d) || isSpoolDir(d)) continue;
        let names;
        try { names = fs.readdirSync(d); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith(".jsonl")) continue;
          if (name === "manifest.jsonl" || name.endsWith(".done") || name.endsWith(".part")) continue;
          files.add(name);
          let txt;
          try { txt = fs.readFileSync(path.join(d, name), "utf8"); } catch { continue; }
          for (const ln of txt.split("\n")) {
            if (!ln.trim()) continue;
            try { const r = JSON.parse(ln); if (r && typeof r === "object" && r.category) mem.push(r); } catch {}
          }
        }
      }
    } catch {}
  }

  function write(rec, internal) {
    const replaying = !!(internal && internal.replay);
    if (closed) return { ok: false, reason: "closed" };
    const r = rec && typeof rec === "object" ? rec : {};
    if (!CATEGORIES.includes(r.category)) { rejected++; return { ok: false, reason: "invalid category" }; }
    if (!LEVELS.includes(r.level)) { rejected++; return { ok: false, reason: "invalid level" }; }
    if (!replaying && levelFiltered(r.level)) { rejected++; return { ok: false, reason: "level-filtered" }; }
    const t = now();
    if (!replaying && !rateOk(t)) { rejected++; return { ok: false, reason: "rate-limited" }; }

    const day = dayOf(t);
    const tag = normalizeDay(day).slice(0, 8);
    knownDays.add(day);

    // 字段白名单：只取下列键，任何自由路径 / result 全文 / 凭据字段一律不落地
    const base = {
      ts: t, category: r.category, level: r.level, epoch: epochFn(),
      message: sanitize(r.message),
    };
    if (r.sessionId) base.sessionId = safeId(r.sessionId);
    if (r.ticketId) base.ticketId = safeId(r.ticketId);

    const chained = chainEnabled && (r.level === "audit" || r.category === "safety");
    let info = null;
    let row = base;
    if (chained) {
      const st = getChain();
      info = { seq: st.sequence + 1, prevHash: st.lastHash, day };
      // 占位 hash 与真实 hash 同为 64 字符，故 fitLine 预留的字节数精确，写入行仍 <= maxLineBytes
      row = { ...base, seq: info.seq, prevHash: info.prevHash, hash: ZEROS };
    }
    const line = fitLine(row);
    let finalRow;
    try { finalRow = JSON.parse(line); } catch { finalRow = row; }
    if (chained) {
      const hash = chainHash(info.prevHash, finalRow, info.seq);
      finalRow.hash = hash;
      persistChain(info, hash, finalRow);
    }
    const finalLine = JSON.stringify(finalRow);

    const target = dirForDay(day, r.category);
    if (target) {
      const file = path.join(target, `${tag}.${r.category}.jsonl`);
      try { if (ensureDir(file)) streamFor(file).write(finalLine + "\n"); }
      catch (e) { lastErr = e; /* 写失败不影响主流程 */ }
    }

    mem.push(finalRow);
    written++;
    return { ok: true };
  }

  /* 带外写：独立同步 append，不经过任何缓冲，close 后仍可单独调用。
   * chain 开启时与常规日志走同一条哈希链，并追加一行 manifest。 */
  function stopSafe(reason) {
    try {
      const t = now();
      const day = dayOf(t);
      const target = dirForDay(day, "safety");
      if (!target) return { ok: false };
      ensureDir(path.join(target, "safety.stop"));
      const file = path.join(target, "safety.stop");
      const base = { ts: t, category: "safety", level: "audit", stop: true, message: sanitize(reason) };
      let row = base;
      if (chainEnabled) {
        base.epoch = epochFn();
        const st = getChain();
        const info = { seq: st.sequence + 1, prevHash: st.lastHash, day };
        row = { ...base, seq: info.seq, prevHash: info.prevHash, hash: ZEROS };
        const hash = chainHash(info.prevHash, row, info.seq);
        row.hash = hash;
        persistChain(info, hash, row);
      }
      fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
      files.add("safety.stop");
      return { ok: true };
    } catch { return { ok: false }; }
  }

  function query(o = {}) {
    let rows = mem.slice();
    if (o.category) rows = rows.filter((r) => r.category === o.category);
    if (o.level) rows = rows.filter((r) => r.level === o.level);
    if (o.since != null) rows = rows.filter((r) => (r.ts || 0) >= o.since);
    rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    let lim = o.limit == null ? 100 : Number(o.limit);
    if (!Number.isFinite(lim)) lim = 100;
    lim = Math.max(0, Math.min(lim, 10000));
    if (lim === 0) return [];
    return rows.slice(-lim).map((r) => ({ ...r }));
  }

  async function flush() {
    const list = [...streams.values()];
    streams.clear();
    for (const st of list) await endStream(st);
    return { ok: true };
  }

  async function close() {
    if (closed) return { ok: true };
    await flush();
    closed = true;
    return { ok: true };
  }

  /* overrideDays 是「面板上那个保留天数下拉」的显式覆盖：
   * 用户主动选了 7/30/90，就按这个天数统一清；不传则回落到按级别分级。
   * 无论哪种，audit / safety 都不自动删（急停与安全留痕不可被保留策略吃掉）。 */
  function isExpired(row, t, overrideDays) {
    if (row.level === "audit" || row.category === "safety") return false;
    const od = Number(overrideDays);
    const days = Number.isFinite(od) && od > 0 ? od : RETENTION_DAYS[row.level];
    if (!Number.isFinite(days)) return false;
    const ts = Number(row.ts);
    if (!Number.isFinite(ts)) return false;
    return ts < t - days * 86400000;
  }

  /* 按级别保留期清理：逐行解析、过滤过期行、.part + rename 原子重写。
   * audit / safety / safety.stop / manifest.jsonl / chain-state.json / spool/ 一律不碰。 */
  function cleanup(nowTs, opts) {
    let scanned = 0, removed = 0, filesN = 0, failedN = 0;
    const t = nowTs != null && Number.isFinite(Number(nowTs)) ? Number(nowTs) : now();
    const overrideDays = opts && typeof opts === "object" ? Number(opts.days) : NaN;
    const seen = new Set();
    try {
      for (const d of collectScanDirs()) {
        if (!d || isAuditDir(d) || isSpoolDir(d) || seen.has(d)) continue;
        seen.add(d);
        let names;
        try { names = fs.readdirSync(d); } catch { continue; }
        for (const name of names) {
          if (!name.endsWith(".jsonl")) continue;
          if (name === "manifest.jsonl" || name === "chain-state.json") continue;
          if (name.endsWith(".done") || name.endsWith(".part")) continue;
          const file = path.join(d, name);
          let txt;
          try { txt = fs.readFileSync(file, "utf8"); } catch { failedN++; continue; }
          const kept = [];
          let removedHere = 0;
          for (const ln of txt.split("\n")) {
            if (!ln.trim()) continue;
            scanned++;
            let row;
            try { row = JSON.parse(ln); } catch { kept.push(ln); continue; }
            if (!row || typeof row !== "object") { kept.push(ln); continue; }
            if (isExpired(row, t, overrideDays)) { removedHere++; removed++; continue; }
            kept.push(ln);
          }
          if (removedHere === 0) continue;
          try {
            const st = streams.get(file);
            if (st) { try { st.end(); } catch {} streams.delete(file); }
            const part = file + ".part";
            fs.writeFileSync(part, kept.length ? kept.join("\n") + "\n" : "", "utf8");
            fs.renameSync(part, file);
            filesN++;
          } catch { failedN++; }
        }
      }
    } catch { failedN++; }
    return { ok: failedN === 0, scanned, removed, files: filesN, failed: failedN };
  }

  /* 回放 spool 待发队列：逐行 JSON.parse 后喂 write()，整文件处理完改名 <name>.done。
   * 写回走正常日志目录，绝不再次落进 spool；回放期间绕过 minLevel 与限流。 */
  function replaySpool(o = {}) {
    let filesN = 0, writtenN = 0, failedN = 0;
    const extra = o && typeof o === "object" ? o.days : null;
    const days = collectDays();
    if (Array.isArray(extra)) for (const d of extra) days.add(dashedDay(d));
    else if (typeof extra === "string") days.add(dashedDay(extra));
    const seen = new Set();
    try {
      for (const day of days) {
        const sd = spoolDirOf(day);
        if (!sd || seen.has(sd)) continue;
        seen.add(sd);
        let names;
        try { names = fs.readdirSync(sd); } catch { continue; }
        for (const name of names.filter((n) =>
          n.endsWith(".jsonl") && !n.endsWith(".done") && n !== "manifest.jsonl" &&
          !/^\d{8}\.[a-z]+\.jsonl$/.test(n))) {
          const file = path.join(sd, name);
          let txt;
          try { txt = fs.readFileSync(file, "utf8"); } catch { failedN++; continue; }
          filesN++;
          for (const ln of txt.split("\n")) {
            if (!ln.trim()) continue;
            let rec;
            try { rec = JSON.parse(ln); } catch { failedN++; continue; }
            const r = write(rec, { replay: true });
            if (r && r.ok) { writtenN++; spooled++; } else failedN++;
          }
          try { fs.renameSync(file, file + ".done"); } catch { failedN++; }
        }
      }
    } catch { failedN++; }
    return { ok: failedN === 0, files: filesN, written: writtenN, failed: failedN };
  }

  function setMinLevel(l) { if (LEVELS.includes(l)) minLevel = l; return minLevel; }
  function setRedactPaths(b) { if (typeof b === "boolean") redactPaths = b; return redactPaths; }
  function chainStats() {
    const st = chainEnabled ? (chainState || { sequence: 0, lastHash: ZEROS, day: dayOf(now()) })
      : { sequence: 0, lastHash: ZEROS, day: dayOf(now()) };
    return { sequence: st.sequence, lastHash: st.lastHash, day: st.day, enabled: chainEnabled };
  }
  function stats() {
    return { written, rejected, files: files.size, minLevel, redactPaths, spooled };
  }

  loadExisting();
  return {
    write, query, flush, close, stats, stopSafe, redact: sanitize,
    cleanup, replaySpool, setMinLevel, setRedactPaths, chainStats,
  };
}
