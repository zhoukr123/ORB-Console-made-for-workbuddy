/* ---------------- 逐步执行轨迹（autoTrace） ----------------
 *
 * wfRunLedger 记的是「运行级」：这次算几号、归谁、跑完没有。
 * 本模块记的是「步级」：第几步、什么动作、花了多久、成功还是降级、为什么失败。
 * 两者合起来才够回答「跑到哪一步断的、怎么接着跑」。
 *
 * 存储：<dir>/<runId>.jsonl，一个运行一个文件 —— 按运行查是最高频的用法，
 * 不必扫全表；也便于按 TTL 单独清理。
 *
 * 上限：每运行最多 maxStepsPerRun 步（防一条失控自动化写出百万行），
 * 目录最多保留 maxRuns 个运行文件（超出按最老淘汰）。
 */

import fsDefault from "node:fs";
import path from "node:path";

const DEFAULT_MAX_STEPS = 500;
const DEFAULT_MAX_RUNS = 300;
const DEFAULT_TTL = 7 * 24 * 3600 * 1000;

/* 保留 Unicode 字母与数字：中文配方名不能全被替换成下划线，否则不同名字会撞同一目录。
   连续点折叠成下划线、去掉首尾的点与横线 —— 防 `..` 片段和隐藏文件。 */
function safeId(s) {
  const t = String(s || "")
    .replace(/[^\p{L}\p{N}_.-]/gu, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 80);
  return t || "_";
}

export function createAutoTrace(opts = {}) {
  const fs = opts.fs || fsDefault;
  const dir = String(opts.dir || "");
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const maxStepsPerRun = Math.max(1, Number(opts.maxStepsPerRun) || DEFAULT_MAX_STEPS);
  const maxRuns = Math.max(1, Number(opts.maxRuns) || DEFAULT_MAX_RUNS);

  if (!dir) throw new Error("autoTrace: dir 必填");

  const counts = new Map();   // runId -> 已写步数
  const order = [];           // runId 出现顺序（最老在前）

  function fileOf(runId) {
    return path.join(dir, `${safeId(runId)}.jsonl`);
  }

  function remember(runId) {
    if (counts.has(runId)) return;
    counts.set(runId, 0);
    order.push(runId);
    while (order.length > maxRuns) {
      const old = order.shift();
      counts.delete(old);
      try { fs.unlinkSync(fileOf(old)); } catch { /* 文件可能已被外部清掉 */ }
    }
  }

  function append(runId, obj) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(fileOf(runId), JSON.stringify(obj) + "\n", "utf8");
      return true;
    } catch {
      /* 轨迹写不进去不能拖垮执行：轨迹是观测，不是执行前提。 */
      return false;
    }
  }

  function begin(runId, meta = {}) {
    const id = String(runId || "");
    if (!id) return { ok: false, error: "runId 必填" };
    remember(id);
    append(id, { t: "begin", at: now(), ...sanitize(meta) });
    return { ok: true };
  }

  function step(runId, entry = {}) {
    const id = String(runId || "");
    if (!id) return { ok: false, error: "runId 必填" };
    remember(id);
    const n = counts.get(id) || 0;
    if (n >= maxStepsPerRun) return { ok: false, code: "trace-limit" };
    counts.set(id, n + 1);
    append(id, { t: "step", at: now(), n: n + 1, ...sanitize(entry) });
    return { ok: true, n: n + 1 };
  }

  function end(runId, summary = {}) {
    const id = String(runId || "");
    if (!id) return { ok: false, error: "runId 必填" };
    remember(id);
    append(id, { t: "end", at: now(), ...sanitize(summary) });
    return { ok: true };
  }

  function read(runId, limit = 500) {
    const lim = Math.max(1, Math.min(Number(limit) || 500, 2000));
    let txt = "";
    try { txt = fs.readFileSync(fileOf(runId), "utf8"); } catch { return []; }
    const out = [];
    for (const line of txt.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* 半行忽略 */ }
    }
    return out.slice(-lim);
  }

  function listRuns() {
    return [...order].reverse();
  }

  function sweep(ttlMs = DEFAULT_TTL) {
    let removed = 0;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return { ok: true, removed: 0 }; }
    for (const f of names) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      try {
        if (now() - fs.statSync(p).mtimeMs > ttlMs) { fs.unlinkSync(p); removed++; }
      } catch { /* 单个失败不影响其余 */ }
    }
    return { ok: true, removed };
  }

  function stats() {
    let steps = 0;
    for (const v of counts.values()) steps += v;
    return { runs: counts.size, steps, maxStepsPerRun, maxRuns };
  }

  return { begin, step, end, read, listRuns, sweep, stats, fileOf };
}

/** 只保留可 JSON 化的浅字段，避免把大对象/循环引用写进轨迹。 */
function sanitize(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const t = typeof v;
    if (t === "string") out[k] = v.slice(0, 300);
    else if (t === "number" || t === "boolean") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.slice(0, 12).map((x) => (typeof x === "object" ? "[obj]" : String(x).slice(0, 60)));
    else if (t === "object") out[k] = "[obj]";
  }
  return out;
}

export default { createAutoTrace };
