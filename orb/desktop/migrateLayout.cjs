"use strict";
/**
 * 存储结构迁移：旧形 artifacts/<day>/sessions/<cid>/<kind>/... → 新形 <kind>/<day>/...
 * 纯 fs 模块，不依赖 electron，可被 storage.js（应用内「搬过来」按钮）与
 * tools/migrate-legacy.mjs（命令行 / 离线脚本）共用。
 *
 * 设计原则（与用户长期规矩一致）：
 *   · 默认「只复制不删除」——源文件一律保留，少删一个目录的收益远大于多占空间；
 *   · 文件名已存在就跳过，不覆盖目标侧现有成果；
 *   · 登记表 rel 旧形 → 新形改写，并把 rootKey 重算为新根，避免迁移后全部显示「存储根已换」；
 *   · 同 id 去重，重复跑幂等。
 */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const layoutImpl = require("./artifactLayout.cjs");
const KINDS = layoutImpl.KINDS;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_DEPTH = 24;
const SCAN_LIMIT = 20000;
const MIGRATE_LIMIT = 20000;

function rootKeyOf(root) {
  return createHash("sha256").update(String(root ?? "")).digest("hex").slice(0, 16);
}

function safeSeg(v) {
  return String(v ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
}

/* 递归拷贝（用于搬迁）。逐条 try/catch —— 单个文件失败不能让整批回滚。 */
function copyTree(srcDir, dstDir, res, depth) {
  if (depth > MAX_DEPTH) { res.errors.push(srcDir + "：目录层级过深，已跳过"); return; }
  let entries = [];
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); }
  catch (e) { res.errors.push(srcDir + "：" + (e && e.message || e)); return; }
  try { fs.mkdirSync(dstDir, { recursive: true }); }
  catch (e) { res.errors.push(dstDir + "：" + (e && e.message || e)); return; }

  for (const e of entries) {
    if (res.moved + res.skipped >= MIGRATE_LIMIT) { res.truncated = true; res.errors.push("超出单次搬迁上限，已中断"); return; }
    if (e.name === ".tmp") continue;
    if (e.name.endsWith(".part")) continue;
    const s = path.join(srcDir, e.name);
    const d = path.join(dstDir, e.name);
    try {
      if (e.isDirectory()) {
        copyTree(s, d, res, depth + 1);
      } else if (e.isFile()) {
        if (fs.existsSync(d)) { res.skipped += 1; continue; }
        fs.copyFileSync(s, d);
        res.moved += 1;
        try { res.bytes += fs.statSync(d).size; } catch { /* 大小不重要 */ }
      }
    } catch (err) {
      res.ok = false;
      res.errors.push(s + "：" + (err && err.message || err));
    }
  }
}

/**
 * 把旧形 artifacts 树摊平进新形类别目录。
 * srcArtifactsDir 形如 <root>/artifacts；遍历 <day>/sessions/<cid>/<kind>/<rest...>，
 * 把每个文件落到 toRoot/<kind>/<day>/<rest...>。rest 可能含子目录（如 vidx 的 media/frames）。
 */
function flattenArtifacts(srcArtifactsDir, toRoot, res) {
  let days;
  try { days = fs.readdirSync(srcArtifactsDir, { withFileTypes: true }); }
  catch { return; }
  for (const dEnt of days) {
    if (!dEnt.isDirectory() || !DAY_RE.test(dEnt.name)) continue;
    const sessionsDir = path.join(srcArtifactsDir, dEnt.name, "sessions");
    let cids;
    try { cids = fs.readdirSync(sessionsDir, { withFileTypes: true }); }
    catch { continue; }
    for (const cEnt of cids) {
      if (!cEnt.isDirectory()) continue;
      for (const k of KINDS) {
        const srcKind = path.join(sessionsDir, cEnt.name, k);
        if (!fs.existsSync(srcKind)) continue;
        const dstKind = path.join(toRoot, k, dEnt.name);   // 去掉 sessions/<cid> 那层
        copyTree(srcKind, dstKind, res, 0);
      }
    }
  }
}

/**
 * 旧顶层分类目录（recordings/screenshots/vidx/exports/archive/misc）可能也残留历史文件
 * （旧结构里这些是占位，但以防万一），原样合进新根对应类别目录下。
 */
function mergeTopKinds(fromRoot, toRoot, res) {
  for (const k of KINDS) {
    const src = path.join(fromRoot, k);
    if (!fs.existsSync(src)) continue;
    copyTree(src, path.join(toRoot, k), res, 0);
  }
}

/* rel 旧形 → 新形：<day>/sessions/<cid>/<kind>/<rest> → <kind>/<day>/<rest>。 */
function rewriteRelToNew(rel) {
  const segs = String(rel || "").split("/").filter(Boolean);
  if (segs.length >= 4 && DAY_RE.test(segs[0]) && segs[1] === "sessions") {
    const [, , , kind, ...rest] = segs;
    if (KINDS.includes(kind)) return [kind, segs[0], ...rest].join("/");
  }
  return rel;
}

/**
 * 把 fromGovDir 的登记表条目改写后写回 toRoot/governance，按 id 去重、覆盖式重写。
 * 旧形 rel 改写成新形，rootKey 重算为 toRoot 指纹。
 *
 * 目录约定（与线上 artifactStore 一致）：目录用带短横的 ISO 日期 governance/<YYYY-MM-DD>，
 * 文件名用紧凑日期 artifacts.<YYYYMMDD>.jsonl。dayTagOf 必须返回【带短横】的 ISO 日期，
 * 否则改写后的条目会落进 governance/<YYYYMMDD>（无短横）——那是运行时根本不读的目录，
 * 既看不见又会和原带短横目录里的旧形条目并存，导致面板重复 / 解析失败。
 *
 * 每条登记写回它「原本的日期文件」并按 id 去重，覆盖式重写（已去重），保证幂等、
 * 不残留旧形条目、不会写进无短横的错目录。
 */
function migrateRegistry(fromGovDir, toRoot, res) {
  const newKey = rootKeyOf(toRoot);
  const byId = new Map();

  // 返回带短横的 ISO 日期（YYYY-MM-DD）；失敗返回 null。绝不用「今天」。
  function dayTagOf(e, fileDt) {
    const ts = Number(e.createdAt);
    if (Number.isFinite(ts) && ts > 0) {
      const d = new Date(ts).toISOString().slice(0, 10);
      if (DAY_RE.test(d)) return d;
    }
    for (const s of String(e.rel || "").split("/")) {
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    }
    if (fileDt && /^\d{8}$/.test(fileDt)) {
      return `${fileDt.slice(0, 4)}-${fileDt.slice(4, 6)}-${fileDt.slice(6, 8)}`;
    }
    return null;
  }

  function loadDir(govDir, depth) {
    if (depth > 3) return;   // 登记表只嵌套一层（governance/<dayTag>/），加护栏防意外深递归
    let entries;
    try { entries = fs.readdirSync(govDir, { withFileTypes: true }); }
    catch { return; }
    const dirBase = path.basename(govDir);
    const dirIsDashed = DAY_RE.test(dirBase);
    for (const ent of entries) {
      if (ent.isDirectory()) { loadDir(path.join(govDir, ent.name), depth + 1); continue; }
      const name = ent.name;
      if (!name.startsWith("artifacts.") || !name.endsWith(".jsonl")) continue;
      const fm = name.match(/^artifacts\.(\d{8})\.jsonl$/);
      const fileDt = fm ? fm[1] : "unknown";
      let txt;
      try { txt = fs.readFileSync(path.join(govDir, name), "utf8"); } catch { continue; }
      for (const ln of txt.split("\n")) {
        if (!ln.trim()) continue;
        let e;
        try { e = JSON.parse(ln); } catch { continue; }
        if (!e || !e.id) continue;
        const transformed = byId.has(e.id) ? byId.get(e.id) : { ...e };
        transformed.rel = rewriteRelToNew(e.rel);   // 旧形→新形（已新形则原样）
        transformed.rootKey = newKey;                // 重算为新根指纹
        // 写回目录：源目录若是带短横日期就用它；否则按条目内容推导（带短横）。
        transformed.__dt = (dirIsDashed ? dirBase : dayTagOf(e, fileDt)) || "unknown";
        byId.set(e.id, transformed);
      }
    }
  }

  loadDir(fromGovDir, 0);
  if (path.resolve(fromGovDir) !== path.resolve(toRoot, "governance")) loadDir(path.join(toRoot, "governance"), 0);

  // 按「带短横日期目录」归组写回，文件名用紧凑日期，覆盖式重写（已按 id 去重）。
  const groups = new Map();
  for (const e of byId.values()) {
    const dt = e.__dt && DAY_RE.test(e.__dt) ? e.__dt : "unknown";
    const tag = dt === "unknown" ? "unknown" : dt.replace(/-/g, "");
    const fp = path.join(toRoot, "governance", dt, `artifacts.${tag}.jsonl`);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(e);
  }
  for (const [fp, list] of groups) {
    const dir = path.dirname(fp);
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { res.errors.push(dir + "：" + (e && e.message || e)); continue; }
    const out = list.map((e) => { const { __dt, ...rest } = e; return JSON.stringify(rest); }).join("\n") + "\n";
    try { fs.writeFileSync(fp, out, "utf8"); }
    catch (e) { res.errors.push(fp + "：" + (e && e.message || e)); res.ok = false; }
  }
}

/**
 * 把一个旧根（或自身）迁移到 toRoot。
 * @param {string} fromRoot 源根（老结构所在；自身摊平可传与 toRoot 相同）
 * @param {string} toRoot   目标根（新结构）
 * @returns {{ok, from, to, moved, skipped, bytes, errors[], note, truncated}}
 */
function migrateRoot(fromRoot, toRoot, opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const res = { ok: true, from: fromRoot, to: toRoot, moved: 0, skipped: 0, bytes: 0, errors: [], note: null, truncated: false };
  fromRoot = path.resolve(String(fromRoot || ""));
  toRoot = path.resolve(String(toRoot || ""));

  // 目标子目录先建
  try { fs.mkdirSync(path.join(toRoot, "governance"), { recursive: true }); } catch {}

  // 1) 旧顶层分类目录残留 → 合进新根
  mergeTopKinds(fromRoot, toRoot, res);
  // 2) 旧 artifacts 树 → 摊平
  flattenArtifacts(path.join(fromRoot, "artifacts"), toRoot, res);
  // 3) 旧 artifacts 树（无论来自旧根还是当前根自身）都摊平进新形类别目录。
  //    源是 toRoot/artifacts，目标是 toRoot/<kind>，不是同一目录，不存在自我嵌套。
  flattenArtifacts(path.join(toRoot, "artifacts"), toRoot, res);
  // 4) 登记表改写 + 去重合并
  try { migrateRegistry(path.join(fromRoot, "governance"), toRoot, res); }
  catch (e) { res.ok = false; res.errors.push("registry: " + (e && e.message || e)); }
  if (path.resolve(fromRoot) !== path.resolve(toRoot)) {
    try { migrateRegistry(path.join(toRoot, "governance"), toRoot, res); } catch (e) { res.ok = false; res.errors.push("registry: " + (e && e.message || e)); }
  }
  return res;
}

module.exports = { migrateRoot, rewriteRelToNew, rootKeyOf, flattenArtifacts, safeSeg, MAX_DEPTH, SCAN_LIMIT, MIGRATE_LIMIT };
