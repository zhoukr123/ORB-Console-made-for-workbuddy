/* ---------------- 配方版本（wfRecipeVersions） ----------------
 *
 * 删除已有回收站（wfTrash），但「改坏」没有回头路 —— 录制覆盖、AI 重写、
 * 自愈回写都会静默替换配方内容。本模块给配方加版本号：
 * 每次保存前留一份只读快照，可列出、可比对、可回滚。
 *
 * 布局：<dir>/<safeName>/<rev>.json
 *   { rev, at, note, source, steps, body }
 * body 存原始配方文本（不是解析后的对象），回滚可以一字不差地还原。
 *
 * 上限：每条配方保留 maxPerName 个版本，超出丢最老的（当前版本永不丢）。
 */

import fsDefault from "node:fs";
import path from "node:path";

const RE_REV = /^(\d+)\.json$/;
const DEFAULT_MAX = 30;

/* 保留 Unicode 字母与数字：中文配方名不能全被替换成下划线，否则不同名字会撞同一目录。
   连续点折叠、去掉首尾点与横线 —— 防 `..` 片段和隐藏文件。 */
function safeName(s) {
  const t = String(s || "")
    .replace(/[^\p{L}\p{N}_.-]/gu, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 100);
  return t || "_";
}

export function createRecipeVersions(opts = {}) {
  const fs = opts.fs || fsDefault;
  const dir = String(opts.dir || "");
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const maxPerName = Math.max(1, Number(opts.maxPerName) || DEFAULT_MAX);

  if (!dir) throw new Error("recipeVersions: dir 必填");

  const dirOf = (name) => path.join(dir, safeName(name));

  function list(name) {
    const d = dirOf(name);
    let names = [];
    try { names = fs.readdirSync(d); } catch { return []; }
    const out = [];
    for (const f of names) {
      const m = RE_REV.exec(f);
      if (!m) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
        out.push({
          rev: Number(m[1]),
          at: Number(j.at) || 0,
          bytes: typeof j.body === "string" ? j.body.length : 0,
          steps: Number(j.steps) || 0,
          note: String(j.note || ""),
          source: String(j.source || ""),
        });
      } catch { /* 损坏的版本文件跳过，不让它拖垮列表 */ }
    }
    out.sort((a, b) => b.rev - a.rev);
    return out;
  }

  function save(name, body, meta = {}) {
    const text = String(body ?? "");
    if (!text) return { ok: false, error: "空内容不建版本" };
    const cur = list(name);
    const rev = (cur.length ? cur[0].rev : 0) + 1;
    const rec = {
      rev,
      at: now(),
      note: String(meta.note || ""),
      source: String(meta.source || ""),
      steps: Number(meta.steps) || 0,
      body: text,
    };
    try {
      fs.mkdirSync(dirOf(name), { recursive: true });
      fs.writeFileSync(path.join(dirOf(name), `${rev}.json`), JSON.stringify(rec), "utf8");
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
    prune(name);
    return { ok: true, rev };
  }

  function get(name, rev) {
    const r = Number(rev);
    if (!Number.isFinite(r) || r <= 0) return null;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dirOf(name), `${Math.floor(r)}.json`), "utf8"));
      return { rev: Number(j.rev) || Math.floor(r), at: Number(j.at) || 0, note: String(j.note || ""),
        source: String(j.source || ""), steps: Number(j.steps) || 0, body: String(j.body || "") };
    } catch { return null; }
  }

  /** 最近一个版本（保存前的当前内容）。回滚时用它做「回滚前再留一版」。 */
  function latest(name) {
    const all = list(name);
    return all.length ? get(name, all[0].rev) : null;
  }

  function rollback(name, rev) {
    const v = get(name, rev);
    if (!v) return { ok: false, error: "版本不存在" };
    let parsed;
    try { parsed = JSON.parse(v.body); } catch { return { ok: false, error: "该版本内容已损坏，拒绝回滚" }; }
    if (!parsed || typeof parsed !== "object") return { ok: false, error: "该版本不是有效配方" };
    return { ok: true, rev: v.rev, body: v.body, parsed, at: v.at };
  }

  function prune(name) {
    const all = list(name);
    if (all.length <= maxPerName) return { ok: true, removed: 0 };
    const drop = all.slice(maxPerName);
    let removed = 0;
    for (const it of drop) {
      try { fs.unlinkSync(path.join(dirOf(name), `${it.rev}.json`)); removed++; } catch { /* 单个失败不影响其余 */ }
    }
    return { ok: true, removed };
  }

  /** 结构化比对：字段变化 + 逐步差异。不引三方 diff 库。 */
  function diff(name, revA, revB) {
    const A = get(name, revA);
    const B = get(name, revB);
    if (!A) return { ok: false, error: `版本 ${revA} 不存在` };
    if (!B) return { ok: false, error: `版本 ${revB} 不存在` };
    let pa, pb;
    try { pa = JSON.parse(A.body); } catch { return { ok: false, error: `版本 ${revA} 内容损坏` }; }
    try { pb = JSON.parse(B.body); } catch { return { ok: false, error: `版本 ${revB} 内容损坏` }; }

    const changes = [];
    for (const k of ["name", "goal", "escalate", "gap", "agentBudget", "outcome", "graph"]) {
      const x = JSON.stringify(pa?.[k] ?? null);
      const y = JSON.stringify(pb?.[k] ?? null);
      if (x !== y) changes.push({ field: k, from: pa?.[k] ?? null, to: pb?.[k] ?? null });
    }

    const sa = Array.isArray(pa?.steps) ? pa.steps : [];
    const sb = Array.isArray(pb?.steps) ? pb.steps : [];
    const stepChanges = [];
    const n = Math.max(sa.length, sb.length);
    for (let i = 0; i < n; i++) {
      const x = JSON.stringify(sa[i] ?? null);
      const y = JSON.stringify(sb[i] ?? null);
      if (x !== y) {
        stepChanges.push({
          index: i,
          from: summarizeStep(sa[i]),
          to: summarizeStep(sb[i]),
        });
      }
    }
    if (sa.length !== sb.length) {
      changes.push({ field: "steps.length", from: sa.length, to: sb.length });
    }
    return {
      ok: true,
      from: { rev: A.rev, at: A.at },
      to: { rev: B.rev, at: B.at },
      changes,
      stepChanges: stepChanges.slice(0, 50),
      totalStepChanges: stepChanges.length,
    };
  }

  function stats() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return { recipes: 0, versions: 0 }; }
    let versions = 0;
    for (const n of names) versions += list(n).length;
    return { recipes: names.length, versions, maxPerName };
  }

  return { save, list, get, latest, rollback, prune, diff, stats, dirOf };
}

function summarizeStep(s) {
  if (!s || typeof s !== "object") return null;
  return {
    type: s.type || "action",
    tool: s.tool || "",
    server: s.server || "",
    anchor: (s.args && s.args.anchor) || "",
  };
}

export default { createRecipeVersions };
