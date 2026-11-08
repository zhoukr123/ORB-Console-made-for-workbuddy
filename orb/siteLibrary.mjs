/* 本地站点库：把「用户自己的浏览痕迹」变成最快的站名 → 官网解析器。
 *
 * 为什么值得单独做一层（2026-11-06 结论）：
 *   通用的"名称 → 官网"解析不存在 100% 方案 —— 连商业化的 name-to-domain API
 *   在 2000 个名字的横评里也只到 71–96%，它们的做法是"给证据 + 给置信度 + 不确定就弃权"。
 *   而用户自己访问过的站点没有这个问题：他打开过中南大学，书签/历史里就有确切地址。
 *   这一层是零猜测的：命中就是命中，没命中就往下走，绝不"猜一个像的"。
 *
 * 数据源（只读，全部本机）：
 *   · Chrome / Edge 书签（Bookmarks，JSON，最可信：用户亲手存的）
 *   · Chrome / Edge 历史（History，SQLite；数据库被浏览器独占，先复制再读）
 *
 * 隐私：只读标题、URL、访问次数，不上传、不写日志（日志只记条数）。
 */
import fs from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

const CHROME_EPOCH_OFFSET = 11644473600000; // 1601-01-01 → 1970-01-01（毫秒）

const BROWSER_ROOTS = [
  () => path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
  () => path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data"),
  () => path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data"),
];

/* 这些站不是"目标官网"，命中它们等于没命中（用户查的是某个单位，不是搜索引擎/百科/跳转中继）。
 * 尤其 link./passport./login. 这类子域：标题常常就是"知乎 - 安全中心"，按标题匹配会以为是官网，
 * 实际点进去是一个跳转页。 */
const NOT_TARGET = /(^|\.)(baidu\.com|bing\.com|google\.[a-z.]+|sogou\.com|so\.com)$|^(?:baike|zhidao|wenku|baijiahao)\.baidu\.com$|^(?:www\.)?(?:wikipedia\.org|douban\.com)$|^(?:link|links|redirect|go|out|jump|click|url|login|passport|account|sso|auth|sec|safe)\./i;

function profileDirs(root) {
  const out = [];
  let names = [];
  try { names = fsSync.readdirSync(root); } catch { return out; }
  for (const name of names) {
    if (name !== "Default" && !/^Profile \d+$/.test(name)) continue;
    const dir = path.join(root, name);
    try { if (!fsSync.statSync(dir).isDirectory()) continue; } catch { continue; }
    out.push(dir);
  }
  return out;
}

/* 站点名的归一化：去掉"官网/网站/首页"这类意图词，只留实体名。 */
export function normalizeSiteName(raw) {
  let s = String(raw == null ? "" : raw).trim();
  s = s.replace(/^(?:帮我|请|麻烦你?|给我)\s*/, "");
  s = s.replace(/^在\s*(?:谷歌浏览器|谷歌|chrome|edge|火狐|firefox|浏览器|bing|必应|google)\s*(?:里|中|上)?\s*/i, "");
  s = s.replace(/^(?:打开|访问|进入|跳转到?|导航到?|带我到|前往)\s*/i, "");
  s = s.replace(/(?:的)?(?:官方网站|官网|网站|首页|网页|页面|站点|网址)\s*$/i, "");
  return s.trim().slice(0, 40);
}

/* 标题里的"站点后缀"：多数首页标题是「站名 - 一句话」「站名_官方」这种形式。 */
function titleHead(title) {
  return String(title || "").trim().replace(/[\s\-_|·:：,，（(].*$/, "").trim();
}

/* 从 URL 取"首页地址"：只要站点根，不帶路径和参数。 */
function originOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return "";
    return u.origin + "/";
  } catch { return ""; }
}

export function createSiteLibrary({ dir, log = () => {} } = {}) {
  const learnFile = dir ? path.join(dir, "site-library.json") : "";
  const indexFile = dir ? path.join(dir, "site-library-index.json") : "";
  const INDEX_TTL_MS = 30 * 60 * 1000;   // 历史不会秒变，半小时重建一次足够
  let index = null;                       // [{ name, url, origin, weight, source }]
  let builtAt = 0;
  let learned = new Map();                // 确认过的解析结果：name → { url, at, hits }
  let learning = false;

  function loadLearned() {
    if (!learnFile) return;
    try {
      const raw = JSON.parse(fsSync.readFileSync(learnFile, "utf8"));
      const now = Date.now();
      for (const [k, v] of Object.entries(raw || {})) {
        if (v && v.url && now - (v.at || 0) < 180 * 24 * 3600 * 1000) learned.set(k, v);
      }
    } catch { /* 没有就是空库 */ }
  }

  function saveLearned() {
    if (!learnFile) return;
    /* 只存最近 400 条，避免文件无限长。 */
    const entries = [...learned.entries()]
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, 400);
    try {
      fsSync.mkdirSync(dir, { recursive: true });
      fsSync.writeFileSync(learnFile, JSON.stringify(Object.fromEntries(entries), null, 0));
    } catch (err) { log("[site-lib] 学习库写入失败：", err?.message ?? err); }
  }

  function addEntry(list, name, url, weight, source) {
    const origin = originOf(url);
    if (!origin || !name) return;
    if (NOT_TARGET.test(new URL(url).hostname)) return;
    list.push({ name: String(name).trim(), url, origin, weight, source });
  }

  function readBookmarks(file, out) {
    let raw = null;
    try { raw = JSON.parse(fsSync.readFileSync(file, "utf8")); } catch { return; }
    const walk = (node) => {
      if (!node) return;
      if (node.type === "url" && node.url) addEntry(out, node.name, node.url, 60, "bookmark");
      for (const child of node.children || []) walk(child);
    };
    walk(raw.roots && raw.roots.bookmark_bar);
    walk(raw.roots && raw.roots.other);
    walk(raw.roots && raw.roots.synced);
  }

  async function readHistory(file, out) {
    if (!dir) return;
    let tmp = "";
    try {
      fsSync.mkdirSync(dir, { recursive: true });
      tmp = path.join(dir, `.hist-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sqlite`);
      fsSync.copyFileSync(file, tmp);     // 浏览器独占数据库，只能复制一份读
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(tmp, { readOnly: true });
      try {
        const stmt = db.prepare(
          "SELECT url, title, visit_count, last_visit_time FROM urls " +
          "WHERE title IS NOT NULL AND title <> '' ORDER BY last_visit_time DESC LIMIT 8000");
        /* Chrome 的时间戳是 int64 微秒，默认按 Number 读会抛
           "Value is too large to be represented as a JavaScript number" ——
           必须显式按 BigInt 读，再自己降成秒级毫秒（1.3e13 远在 2^53 内，转换无损）。 */
        stmt.setReadBigInts(true);
        const rows = stmt.all();
        for (const r of rows) {
          const title = String(r.title || "").trim();
          if (!title) continue;
          const visits = Number(r.visit_count) || 1;
          const seen = Number(r.last_visit_time) / 1000 - CHROME_EPOCH_OFFSET;
          const fresh = Date.now() - seen < 90 * 24 * 3600 * 1000 ? 15 : 0;
          const w = Math.min(30, Math.round(Math.log2(visits + 1) * 6)) + fresh;
          addEntry(out, title, r.url, w, "history");
        }
      } finally {
        try { db.close(); } catch { /* 关不掉就算了 */ }
      }
    } catch (err) {
      log("[site-lib] 读历史失败：", err?.message ?? err);
    } finally {
      if (tmp) { try { fsSync.unlinkSync(tmp); } catch { /* 临时文件清理失败不致命 */ } }
    }
  }

  async function build() {
    const list = [];
    for (const makeRoot of BROWSER_ROOTS) {
      const root = makeRoot();
      if (!root || !fsSync.existsSync(root)) continue;
      for (const p of profileDirs(root)) {
        readBookmarks(path.join(p, "Bookmarks"), list);
        await readHistory(path.join(p, "History"), list);
      }
    }
    index = list;
    builtAt = Date.now();
    log(`[site-lib] 建立索引 ${list.length} 条（书签+历史）`);
    if (indexFile) {
      try {
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(indexFile, JSON.stringify({ at: builtAt, n: list.length }));
      } catch { /* 只是统计用 */ }
    }
  }

  async function ensureIndex() {
    if (index && Date.now() - builtAt < INDEX_TTL_MS) return;
    await build();
  }

  /* 命中判定：只有"能确认是同一个实体"才返回，而且要求落在站点根。
   * 返回的 confidence 是给上层做闸门用的 —— 低于 0.8 的，上层不该直接跳转。 */
  async function lookup(rawName) {
    const name = normalizeSiteName(rawName);
    if (!name || name.length < 2) return null;
    const now = Date.now();

    /* 1) 学习库优先：这是上一次真实打开过的地址，几乎不会错。 */
    const hit = learned.get(name);
    if (hit && hit.url) return { url: hit.url, confidence: 0.99, source: "learned", title: "" };

    await ensureIndex();
    if (!index || !index.length) return null;

    let best = null, bestScore = -1e9;
    const ascii = /^[a-z0-9.-]+$/i.test(name);
    for (const e of index) {
      const head = titleHead(e.name);
      const title = e.name.trim();
      /* "站名 + 官网/首页"这种后缀等于没后缀；"站名 + 研究生招生网"则是另一个站。
         实测反例：历史里「华南理工大学研究生招生网」曾把"华南理工大学官网"解析到 yz.scut.edu.cn。 */
      const tail = title.startsWith(name) ? title.slice(name.length) : "";
      const tailClean = tail
        .replace(/^[\s\-_|·:：,，]+/, "")
        .replace(/(?:官方网站|官网|网站|首页|主页|门户|网页)$/, "")
        .trim();
      let s = -1e9;
      if (head === name || title === name) s = 100;
      else if (title.startsWith(name) && tailClean === "") s = 66;
      else if (title.startsWith(name)) s = 30;
      else if (title.includes(name)) s = 22;
      else if (ascii && new URL(e.url).hostname.replace(/^www\./, "").startsWith(name)) s = 70;
      if (s < 0) continue;
      /* 首页比内页更像"官网"；内页（文章、视频页）即使标题命中也不该当官网。 */
      if (e.origin === e.url) s += 18;
      else if (e.url.length < e.origin.length + 24) s += 4;
      else s -= 25;
      s += Math.min(22, e.weight);
      if (s > bestScore) { bestScore = s; best = e; }
    }
    if (!best || bestScore < 80) return null;
    const conf = bestScore >= 118 ? 0.95 : bestScore >= 95 ? 0.88 : 0.82;
    if (conf < 0.8) return null;   // 只在有把握时用本地库，其余交给通用解析
    return { url: best.origin, confidence: conf, source: best.source, title: best.name };
  }

  function learn(rawName, url) {
    const name = normalizeSiteName(rawName);
    const origin = originOf(url);
    if (!name || !origin) return;
    const prev = learned.get(name);
    learned.set(name, { url: origin, at: Date.now(), hits: (prev && prev.hits ? prev.hits : 0) + 1 });
    saveLearned();
  }

  function stats() {
    return { indexed: index ? index.length : 0, builtAt, learned: learned.size };
  }

  loadLearned();
  return { lookup, learn, stats, _build: build };
}
