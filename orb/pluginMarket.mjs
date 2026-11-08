/* pluginMarket.mjs — WorkBuddy 插件市场的只读索引（离线、真实数据）
 *
 * 数据来源（本机磁盘，不联网、不猜）：
 *   %USERPROFILE%\.workbuddy\plugins\known_marketplaces.json     已知市场清单
 *   <installLocation>/.codebuddy-plugin/marketplace.json         每个市场收录的插件
 *
 * 本机常见 6 个市场、合计 600+ 条收录，且每条 source 指向的插件目录**就在本机**，
 * 所以「搜索市场」和「从市场安装」用的是同一份真实数据，不需要伪造条目。
 *
 * 设计纪律：
 *  - 只读：本模块不写任何文件，安装动作由桥侧调 pluginHost.register 完成。
 *  - 容错：某个市场清单缺失/损坏只跳过该市场并存一条 warning，不整体失败。
 *  - 有界：SKILL.md 只读前 4000 字，避免把大文件塞进注册表。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const PLUGIN_ROOT = path.join(os.homedir(), ".workbuddy", "plugins");

const MARKET_CANDS = [
  ".codebuddy-plugin/marketplace.json",
  "marketplace.json",
  ".claude-plugin/marketplace.json",
];
export const MANIFEST_CANDS = [
  "plugin.json",
  ".codebuddy-plugin/plugin.json",
  ".workbuddy-plugin/plugin.json",
  ".claude-plugin/plugin.json",
];

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}
function exists(p) {
  try { fs.accessSync(p); return true; } catch (e) { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/** id 必须 ^[a-z0-9][a-z0-9-]{0,31}$（与 pluginHost 同一规则，这里不 import 以免循环） */
export function safeId(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 32 ? s.slice(0, 32) : s;
}

function authorName(a) {
  if (!a) return "";
  if (typeof a === "string") return a;
  return String(a.name || a.url || "");
}

/** 把一条市场收录归一成界面/搜索能直接用的形状 */
function normalizeEntry(plugin, mkt) {
  const name = String(plugin.name || "").trim();
  if (!name) return null;

  /* source 可能是相对路径字符串，也可能是 {source:"github", repo:...} 这类远端描述。
     远端的我们装不了（要联网拉包），照样列出但标 hasSource:false —— 只读不装，不假装。 */
  let rel = "";
  let hasSource = false;
  if (typeof plugin.source === "string") {
    rel = plugin.source;
    hasSource = true;
  } else if (plugin.source && typeof plugin.source === "object") {
    rel = String(plugin.source.path || plugin.source.url || plugin.source.repo || "");
    hasSource = false;
  }
  const dir = rel ? path.resolve(mkt.dir, rel) : "";
  if (hasSource && dir && !isDir(dir)) hasSource = false;

  return {
    key: mkt.name + ":" + name,
    name,
    id: safeId(name),
    version: String(plugin.version || ""),
    description: String(plugin.description || plugin.description_zh || ""),
    descriptionEn: String(plugin.description_en || ""),
    category: String(plugin.category || ""),
    author: authorName(plugin.author),
    homepage: String(plugin.homepage || plugin.repository || ""),
    license: String(plugin.license || ""),
    marketplace: mkt.name,
    marketplaceDesc: mkt.description,
    dir: hasSource ? dir : "",
    hasSource,
  };
}

/**
 * 扫全部已知市场。
 * @param {{ root?: string }} [opts]
 * @returns {{ ok:boolean, root:string, marketplaces:Array, plugins:Array, warnings:string[], scannedAt:number }}
 */
export function scanMarket(opts = {}) {
  const root = opts.root || PLUGIN_ROOT;
  const warnings = [];
  const marketplaces = [];
  const plugins = [];

  const knownPath = path.join(root, "known_marketplaces.json");
  const known = readJson(knownPath);
  if (!known || typeof known !== "object") {
    return { ok: false, root, marketplaces: [], plugins: [], warnings: ["known_marketplaces.json 不可读"], scannedAt: Date.now() };
  }

  for (const [name, m] of Object.entries(known)) {
    if (!m || typeof m !== "object") continue;
    const dir = m.installLocation || path.join(root, "marketplaces", name);
    const mktFile = MARKET_CANDS.map((c) => path.join(dir, c)).find(exists);
    const meta = {
      name,
      description: String(m.description || ""),
      dir,
      type: String(m.type || ""),
      isBuiltIn: Boolean(m.isBuiltIn),
      lastUpdated: String(m.lastUpdated || ""),
      count: 0,
      ok: false,
    };
    marketplaces.push(meta);

    if (!mktFile) {
      warnings.push(`市场 ${name} 无 marketplace.json（已跳过）`);
      continue;
    }
    const j = readJson(mktFile);
    if (!j || !Array.isArray(j.plugins)) {
      warnings.push(`市场 ${name} 清单不可解析（已跳过）`);
      continue;
    }
    meta.ok = true;
    meta.description = String(j.description || meta.description || "");
    for (const p of j.plugins) {
      const e = normalizeEntry(p, meta);
      if (!e) continue;
      plugins.push(e);
      meta.count++;
    }
  }

  return { ok: true, root, marketplaces, plugins, warnings, scannedAt: Date.now() };
}

/* ------------------------------------------------------------------ *
 * 搜索：名字 > 分类 > 描述，命中越靠前越像用户想找的
 * ------------------------------------------------------------------ */

function scoreOf(e, q) {
  const n = e.name.toLowerCase();
  const d = e.description.toLowerCase();
  const c = e.category.toLowerCase();
  if (n === q) return 100;
  if (n.startsWith(q)) return 85;
  if (n.includes(q)) return 70;
  if (e.id.includes(q)) return 62;
  if (c.includes(q)) return 45;
  if (d.includes(q)) return 32;
  if (e.marketplace.toLowerCase().includes(q)) return 18;
  return 0;
}

/**
 * @param {Array} plugins scanMarket().plugins
 * @param {{ q?:string, marketplace?:string, limit?:number }} [opt]
 */
export function searchMarket(plugins, opt = {}) {
  const q = String(opt.q || "").trim().toLowerCase();
  const mkt = String(opt.marketplace || "");
  const limit = Math.max(1, Math.min(Number(opt.limit) || 60, 500));

  let pool = plugins;
  if (mkt) pool = pool.filter((e) => e.marketplace === mkt);

  if (!q) {
    /* 无关键词：先给能装在本机的（hasSource），再按名字排 */
    const sorted = pool.slice().sort((a, b) => {
      if (a.hasSource !== b.hasSource) return a.hasSource ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { total: sorted.length, items: sorted.slice(0, limit) };
  }

  const hits = [];
  for (const e of pool) {
    const s = scoreOf(e, q);
    if (s > 0) hits.push({ e, s });
  }
  hits.sort((a, b) => (b.s - a.s) || a.e.name.localeCompare(b.e.name));
  return { total: hits.length, items: hits.slice(0, limit).map((h) => h.e) };
}

/* ------------------------------------------------------------------ *
 * 读取一个市场插件的源码目录 → 喂给 ingestPlugin 的材料
 * ------------------------------------------------------------------ */

export function readSource(dir) {
  if (!dir || !isDir(dir)) return { ok: false, error: "source-missing", dir: dir || "" };

  const manifestPath = MANIFEST_CANDS.map((c) => path.join(dir, c)).find(exists);
  const manifest = manifestPath ? readJson(manifestPath) : null;
  if (!manifestPath || !manifest) return { ok: false, error: "manifest-unreadable", dir };

  /* 市场插件常把 MCP 服务写在同目录的 mcp.json 里（顶层 mcpServers 只是路径）。
     这里就地解析成对象，适配器不必碰文件系统，也能拿到真实的服务名。 */
  if (manifest.mcpServers && typeof manifest.mcpServers === "string") {
    const inline = readJson(path.resolve(dir, manifest.mcpServers));
    if (inline && typeof inline === "object") {
      manifest.mcpServers = inline.mcpServers && typeof inline.mcpServers === "object" ? inline.mcpServers : inline;
    } else {
      delete manifest.mcpServers;
    }
  }

  /* SKILL.md：根目录优先，其次 skills/<name>/SKILL.md */
  let skillMd = "";
  const skillRoot = path.join(dir, "SKILL.md");
  if (exists(skillRoot)) {
    skillMd = readHead(skillRoot);
  } else {
    const skillsDir = path.join(dir, "skills");
    if (isDir(skillsDir)) {
      let names = [];
      try { names = fs.readdirSync(skillsDir); } catch (e) { names = []; }
      for (const n of names) {
        const f = path.join(skillsDir, n, "SKILL.md");
        if (exists(f)) { skillMd = readHead(f); break; }
      }
    }
  }

  let hasScripts = isDir(path.join(dir, "scripts"));
  if (!hasScripts && isDir(path.join(dir, "skills"))) {
    try {
      hasScripts = fs.readdirSync(path.join(dir, "skills")).some((n) => isDir(path.join(dir, "skills", n, "scripts")));
    } catch (e) { hasScripts = false; }
  }

  return { ok: true, dir, manifestPath, manifest, skillMd, hasScripts };
}

function readHead(p, max = 4000) {
  try {
    const s = fs.readFileSync(p, "utf8");
    return s.length > max ? s.slice(0, max) : s;
  } catch (e) {
    return "";
  }
}
