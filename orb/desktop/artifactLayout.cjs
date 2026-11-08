"use strict";
/**
 * 目录布局：唯一实现（CJS）。desktop/*.js 是 CommonJS，orb/*.mjs 是 ESM，
 * ESM 侧用 createRequire 引用（orb/artifactLayout.mjs），避免两份逻辑漂移。
 *
 * 【硬约定 — 改这里之前先看清楚】
 *   产物 = 录屏 / 截屏 / 看视频 / 导出 / 归档 / 杂项，**全部**直接铺在存储根下，
 *   按类别按日期，扁平两层：
 *     <root>/<kind>/<YYYY-MM-DD>/<product>
 *   kind ∈ {recordings, screenshots, vidx, exports, archive, misc}。
 *   类别目录（recordings/、screenshots/、vidx/、exports/…）就是真实落点，
 *   打开它就能看到按日期分好的产物，不再有「占位空目录」与「套了好几层会话目录」。
 *
 *   日志文件**不在**产物树里（用户明确要求「除日志文件外」）。日志与治理流各自独立成树，
 *   只按日期分（不按会话分），与产物物理隔离：
 *     <root>/logs/<YYYY-MM-DD>/       {<category>.jsonl, spool/, safety.stop, manifest.jsonl, chain-state.json}
 *     <root>/governance/<YYYY-MM-DD>/ {spans,events,receipts,ticket-control,baseline}.jsonl
 *   audit/ 仅作为 legacy() 的只读路径返回，绝不创建、绝不写入。
 *
 *   旧结构 <root>/artifacts/<YYYY-MM-DD>/sessions/<cid>/<kind>/... 仅作**只读兼容**：
 *   resolveSafe 保留双形态解析（首段是日期 = 旧形，首段是类别 = 新形），旧登记表里的
 *   rel 仍能定位到旧目录；新写入一律走新形。
 *
 *   路径形状固定：root 只从 storage.resolveRoot() 来（用户可在设置里换根），
 *   换根只改前缀，不改下面任何一级的名字。固定 UTC+8，day 省略一律取当天。
 */
const path = require("node:path");
const fsDefault = require("node:fs");

const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;   // 固定 UTC+8，不依赖宿主 TZ
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/* 会话级产物类型。前五类是具名功能，misc 是兜底：任何「不是录屏/截屏/看视频/导出/归档」
 * 当天生成的文件都进 misc，绝不再散落到存储根或项目根目录。 */
const KINDS = ["recordings", "screenshots", "vidx", "exports", "archive", "misc"];

/* 去掉所有非 [A-Za-z0-9_.:-] 字符，最长 64；用于 cid / category / name 防目录穿越。 */
function safeId(v) {
  return String(v ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
}

/* 把 now 归一成毫秒数：支持 () => Number、有限数字，否则 Date.now()。 */
function resolveNow(now) {
  if (typeof now === "function") {
    try {
      const v = Number(now());
      if (Number.isFinite(v)) return v;
    } catch { /* 注入的 now 抛错时回落到真实时间 */ }
    return Date.now();
  }
  if (now != null) {
    const v = Number(now);
    if (Number.isFinite(v)) return v;
  }
  return Date.now();
}

/**
 * dayOf(ts, now) → "YYYY-MM-DD"，固定 UTC+8（ts + 8h 后 toISOString().slice(0,10)）。
 * 与 orb/session.mjs 的 dayTag 语义一致：跨午夜归结束日（传结束时刻）。
 * ts 非法（非数字/空/NaN/Infinity/产生非法 Date）时用 now 或 Date.now()。
 */
function dayOf(ts, now) {
  const n = resolveNow(now);
  let base;
  if (typeof ts === "number" && Number.isFinite(ts)) base = ts;
  else if (typeof ts === "string" && ts.trim() !== "" && Number.isFinite(Number(ts))) base = Number(ts);
  else base = n;
  let d = null;
  try { d = new Date(base + SHANGHAI_OFFSET_MS); } catch { d = null; }
  if (!d || isNaN(d.getTime())) d = new Date(n + SHANGHAI_OFFSET_MS);
  if (isNaN(d.getTime())) d = new Date(SHANGHAI_OFFSET_MS);   // 极端兜底：epoch（UTC+8）
  return d.toISOString().slice(0, 10);
}

function createLayout(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const fs = o.fs || fsDefault;
  const now = typeof o.now === "function" ? o.now : Date.now;
  let rootAbs = path.resolve(String(o.root ?? "."));

  /* day 参数严格校验，非法（含省略）一律回退当天；now() 只在回退时求值一次。 */
  function resolveDay(d) {
    const s = d == null ? "" : String(d);
    return DAY_RE.test(s) ? s : dayOf(now(), now);
  }
  function today() { return dayOf(now(), now); }

  /* ---- 路径层：全部基于 rootAbs，返回绝对路径 ---- */
  function root() { return rootAbs; }
  function setRoot(r) {
    rootAbs = path.resolve(String(r ?? "."));
    return rootAbs;
  }
  function day(ts) { return ts == null ? today() : dayOf(ts, now); }

  /* 旧结构根目录：<root>/artifacts/<day>/sessions/<cid>/... 的容器，仅作只读兼容。 */
  function artifactsRoot() { return path.join(rootAbs, "artifacts"); }
  /* 日志树与治理树：与产物树**平级的兄弟目录**，绝不嵌在 artifacts/ 下。
     产物目录要能整体交付/打包，里面混进 jsonl 日志就不干净了。 */
  function logsRoot() { return path.join(rootAbs, "logs"); }
  function govRoot() { return path.join(rootAbs, "governance"); }

  /* 扁平化：类别目录直接是存储根下的真实落点。 */
  function kindRoot(kind) { return path.join(rootAbs, kind); }
  /* 某类别某天的目录：<root>/<kind>/<day>/。这就是产物的直接容器（去掉了会话层）。 */
  function kindDayDir(kind, d) { return path.join(kindRoot(kind), resolveDay(d)); }
  /* 某类产物的写入目录。cid 参数仅为兼容旧调用方签名保留，扁平化后产物不再按会话归集，
   * 该参数被忽略。返回前不创建目录（调用方写文件前由 ensure 兜底）。 */
  function kindDir(kind, cid, d) {
    if (!KINDS.includes(kind)) return null;
    return kindDayDir(kind, d);
  }
  function logsDir(d) { return path.join(logsRoot(), resolveDay(d)); }
  function logFile(category, d) {
    return path.join(logsDir(d), safeId(category) + ".jsonl");
  }
  function govDir(d) { return path.join(govRoot(), resolveDay(d)); }
  function govFile(name, d) {
    return path.join(govDir(d), safeId(name) + ".jsonl");
  }
  function spoolDir(d) { return path.join(logsDir(d), "spool"); }
  function safetyFile(d) { return path.join(logsDir(d), "safety.stop"); }
  function manifestFile(d) { return path.join(logsDir(d), "manifest.jsonl"); }
  function chainStateFile(d) { return path.join(logsDir(d), "chain-state.json"); }

  /* 日级 misc：当天生成、但**不属于任何会话**的文件（例如自检报告、验收截图、
     一次性导出）。扁平化后 misc 也是一个类别目录：<root>/misc/<day>/。 */
  function dayMiscDir(d) { return kindDayDir("misc", d); }

  /* 旧结构只读路径：<root>/<day>/sessions/<cid>/... 与 <root>/artifacts。
     仅供读取历史产物，绝不创建、绝不写入。 */
  function dayDir(d) { return path.join(artifactsRoot(), resolveDay(d)); }
  function sessionsDir(d) { return path.join(artifactsRoot(), resolveDay(d), "sessions"); }
  function sessionDir(cid, d) {
    const id = safeId(cid);
    // safeId 保留点号，纯点段（"." / ".."）仍会被 path.join 当成上跳，需一并回退。
    const seg = id && !/^\.+$/.test(id) ? id : "local";
    return path.join(artifactsRoot(), resolveDay(d), "sessions", seg);
  }

  /* 旧顶层路径，仅供只读兼容；绝不创建、绝不写入（尤其 audit）。 */
  function legacy() {
    return {
      recordings: path.join(rootAbs, "recordings"),
      screenshots: path.join(rootAbs, "screenshots"),
      vidx: path.join(rootAbs, "vidx"),
      artifacts: path.join(rootAbs, "artifacts"),
      audit: path.join(rootAbs, "audit"),
    };
  }

  /* ---- 目录创建：失败一律收敛，不抛 ---- */
  function ensure(dir) {
    try { fs.mkdirSync(dir, { recursive: true }); return true; }
    catch { return false; }
  }
  /* 建公共层：六个类别目录（recordings/screenshots/vidx/exports/archive/misc 当天）
     加 logs/spool/gov。不建会话层（扁平化后已无会话层）。
     dirs = 成功确保的目录，failed = 失败目录，ok = 无失败。幂等。 */
  function ensureDay(d) {
    const day = resolveDay(d);
    const targets = [
      ...KINDS.map((k) => kindDayDir(k, day)),
      logsDir(day), spoolDir(day), govDir(day),
    ];
    const dirs = [];
    const failed = [];
    for (const t of targets) {
      if (ensure(t)) dirs.push(t); else failed.push(t);
    }
    return { ok: failed.length === 0, day, dirs, failed };
  }

  /* 一次性把「某会话在某天的六类产物目录」全建出来（扁平化后只是按类别建当天目录）。
     录屏/截屏/看视频开始前调它，保证产物树形状从第一秒就是完整的。 */
  function ensureSession(cid, d) {
    const day = resolveDay(d);
    const dirs = [];
    const failed = [];
    const targets = KINDS.map((k) => kindDir(k, cid, day));
    for (const t of targets) {
      if (!t) continue;
      if (ensure(t)) dirs.push(t); else failed.push(t);
    }
    return { ok: failed.length === 0, day, cid: String(safeId(cid) || "local"), dirs, failed };
  }

  /* 固定路径快照：把「这一刻生效的全部路径」一次给全，调用方不再自己拼字符串。
     面板显示、启动自检、日志落点全用这一份，避免各处各拼一份然后对不上。 */
  function paths(cid, d) {
    const day = resolveDay(d);
    const out = {
      root: root(), day,
      artifactsRoot: artifactsRoot(), logsRoot: logsRoot(), govRoot: govRoot(),
      /* 旧结构只读路径，方便读取历史产物 */
      dayDir: dayDir(day), sessionsDir: sessionsDir(day), sessionDir: sessionDir(cid, day),
      dayMiscDir: dayMiscDir(day),
      logsDir: logsDir(day), govDir: govDir(day),
      spoolDir: spoolDir(day), safetyFile: safetyFile(day),
      manifestFile: manifestFile(day), chainStateFile: chainStateFile(day),
    };
    for (const k of KINDS) out[k] = kindDir(k, cid, day);
    return out;
  }

  /* ---- 安全解析相对路径 → 绝对路径 ----
   * 双形态兼容：
   *   旧形 <day>/sessions/<cid>/<kind>/<name...>   首段是日期，落在 artifactsRoot 下；
   *   新形 <kind>/<day>/<name...>                 首段是类别（KINDS），落在 root 下。
   * 两类都做防穿越 / 防绝对路径 / 防盘符 / 防控制字符。 */
  function resolveSafe(rel) {
    const s = rel == null ? "" : String(rel);
    if (!s) return null;
    if (/[\x00-\x1f\x7f]/.test(s)) return null;          // 空字节 / 控制字符
    if (s.includes("\\")) return null;                      // 反斜杠 / UNC
    if (s.startsWith("/") || path.isAbsolute(s) || /^[A-Za-z]:/.test(s)) return null; // 绝对路径 / 盘符
    if (s.includes("..")) return null;                      // 目录穿越
    const segs = s.split("/").filter(Boolean);
    if (!segs.length) return null;
    if (segs.some((g) => /^[A-Za-z]:/.test(g))) return null; // 中段盘符

    // 旧形：首段是日期
    if (DAY_RE.test(segs[0])) {
      const base = artifactsRoot();
      const abs = path.resolve(base, ...segs);
      if (abs !== base && !abs.startsWith(base + path.sep)) return null;
      return abs;
    }
    // 新形：首段是类别且第二段是日期
    if (KINDS.includes(segs[0]) && segs.length >= 2 && DAY_RE.test(segs[1])) {
      const base = rootAbs;
      const abs = path.resolve(base, ...segs);
      if (abs !== base && !abs.startsWith(base + path.sep)) return null;
      return abs;
    }
    return null;   // 首段既不是日期也不是已知类别 → 非法 rel
  }

  /* ---- 只读枚举：所有 readdir/stat 失败都收敛 ---- */
  function readEntries(dir) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const raw of names || []) {
      const name = typeof raw === "string" ? raw : (raw && raw.name);
      if (typeof name !== "string" || !name) continue;
      const full = path.join(dir, name);
      let isDir = false;
      let size = 0;
      if (raw && typeof raw === "object" && typeof raw.isDirectory === "function") isDir = raw.isDirectory();
      try {
        const st = fs.statSync(full);
        if (st) {
          if (typeof st.isDirectory === "function") isDir = st.isDirectory();
          size = Number(st.size) || 0;
        }
      } catch { /* stat 不可用/失败时按名称降级处理 */ }
      out.push({ name, full, isDir, size });
    }
    return out;
  }
  function statTree(dir) {
    let files = 0, bytes = 0;
    for (const e of readEntries(dir)) {
      if (e.isDir) {
        const s = statTree(e.full);
        files += s.files; bytes += s.bytes;
      } else {
        files++; bytes += e.size;
      }
    }
    return { files, bytes };
  }
  function looseFiles(dir) {
    let files = 0, bytes = 0;
    for (const e of readEntries(dir)) {
      if (!e.isDir) { files++; bytes += e.size; }
    }
    return { files, bytes };
  }
  function dirExists(dir) {
    try { fs.readdirSync(dir); return true; } catch { return false; }
  }

  /* 有哪些「天」曾经产生过产物：合并旧 artifacts/<day> 与新 <kind>/<day> 取并集。
   * 倒序返回（YYYY-MM-DD 零填充，字典序倒序 = 日期倒序）。 */
  function listDays() {
    const set = new Set();
    // 旧结构：artifacts/<day>
    try {
      for (const name of fs.readdirSync(artifactsRoot())) {
        if (!DAY_RE.test(name)) continue;
        try { if (fs.statSync(path.join(artifactsRoot(), name)).isDirectory()) set.add(name); } catch {}
      }
    } catch {}
    // 新结构：每个类别下的 <day> 子目录
    for (const k of KINDS) {
      const kr = kindRoot(k);
      let names;
      try { names = fs.readdirSync(kr); } catch { continue; }
      for (const name of names) {
        if (!DAY_RE.test(name)) continue;
        try { if (fs.statSync(path.join(kr, name)).isDirectory()) set.add(name); } catch {}
      }
    }
    return [...set].sort().reverse();
  }

  /* 扁平化后按类别枚举某天的产物目录，统计 files/bytes。
   * 返回 [{kind, day, dir, files, bytes}]，无内容则跳过该类别。 */
  function listProducts(d) {
    const day = resolveDay(d);
    const out = [];
    for (const k of KINDS) {
      const dir = kindDayDir(k, day);
      if (!dirExists(dir)) continue;
      const s = statTree(dir);
      out.push({ kind: k, day, dir, files: s.files, bytes: s.bytes });
    }
    return out;
  }

  function describe() {
    const day = resolveDay();
    return {
      root: root(),
      day,
      artifactsRoot: artifactsRoot(),
      logsRoot: logsRoot(),
      govRoot: govRoot(),
      dayDir: dayDir(day),
      dayMiscDir: dayMiscDir(day),
      logsDir: logsDir(day),
      govDir: govDir(day),
      productKinds: KINDS.slice(),
      days: listDays(),
      products: listProducts(day),
      legacy: legacy(),
      exists: dirExists(rootAbs),
    };
  }

  return {
    root, setRoot, day,
    artifactsRoot, logsRoot, govRoot,
    kindRoot, kindDayDir, kindDir,
    dayDir, sessionsDir, sessionDir, dayMiscDir,
    logsDir, logFile, govDir, govFile, spoolDir,
    safetyFile, manifestFile, chainStateFile,
    ensure, ensureDay, ensureSession, paths, legacy, resolveSafe,
    listDays, listProducts, describe,
  };
}

module.exports = { dayOf, safeId, KINDS, createLayout };
