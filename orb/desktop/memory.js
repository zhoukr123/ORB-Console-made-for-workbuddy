/* ---------------- 长期记忆引擎（仿 dsh-meow-memory 思路，适配 ORB 控制台）----------------
 * 参考：Phant0Meow/dsh-meow-memory（MIT）。我们照搬其「七层语义模型 + BM25×艾宾浩斯
 * 关键词召回」的核心算法（纯 JS、零原生模块、可解释），但把存储层从 SQLite 换成
 * JSON 文件 —— 因为 ORB 是 Electron 44 / Node 20，没有内置 node:sqlite，且打包配置
 * npmRebuild:false，引入 better-sqlite3 会踩原生模块坑。个人记忆库量级（几百条），
 * JSON + 进程内索引完全够用，写入即落盘。
 *
 * 七层（照搬 meow 的语义分层，字段做了精简以适配前端派任务场景）：
 *   soul   AI 自身人格/身份
 *   user   用户基本信息与偏好
 *   project 项目信息（project 字段锚定具体项目）
 *   fact   原子事实
 *   lesson 错误与教训（corrected 标记）
 *   topic  进行中的话题（goal 目标句）
 *   rules  设计原则与行为准则（project 空 = 全局准则）
 *
 * 写入双路径（解决 ORB 没有 LLM tool calling 的问题，参考 HuntwrGPT / memory-pet）：
 *   ① 手动 —— 面板「记忆管理」表单（选层 / 填内容 / 重要性 / 删除）
 *   ② 自动 —— 任务完成后让模型把结果摘要成记忆回写（第二阶段，并入 dream）
 *
 * 注入点：panel 的 runBack() 派发后台任务前，调 window.orb.memoryRecall(text)
 * 把召回的「长期记忆块」拼进 task 文本，让底层 AI 这次派发带上历史上下文。
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/* ============== 数据模型 ============== */

const LEVELS = Object.freeze([
  "soul", "user", "project", "fact", "lesson", "topic", "rules",
]);

const LEVEL_LABELS = {
  soul: "AI 自身",
  user: "关于你",
  project: "项目",
  fact: "原子事实",
  lesson: "错误与教训",
  topic: "话题",
  rules: "设计原则与行为准则",
};

const PROJECT_SUBCATEGORIES = ["overview", "structure", "decisions", "quotes", "ops", "todo"];

/** 时间前缀 id：base36(毫秒,9位) + '-' + 26 位随机 = 36 字符，id 排序 ≈ 创建顺序。 */
function newId(now = Date.now()) {
  const t = now.toString(36).padStart(9, "0");
  return t + "-" + randomUUID().replace(/-/g, "").slice(0, 26);
}

/* ============== 分词与检索（移植自 meow bm25.ts，纯 JS 零依赖）============== */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\u30fc]/u;
const WORD = /[\p{L}\p{N}]/u;

function classify(cp) {
  if (CJK.test(cp)) return "cjk";
  if (WORD.test(cp)) return "word";
  return "skip";
}

/**
 * 分词：CJK 连续段相邻 bigram（中文稳定零依赖）+ 字母数字整词 + NFKC 归一化；
 * 标点/符号/emoji 跳过。lang='en' 时额外小写化（中文场景无需 Porter 词干，
 * 如需完整英文检索可在此补停用词+Porter，但 ORB 是中文控制台，暂不引入）。
 */
function tokenize(text, lang = "zh") {
  if (!text) return [];
  const cps = Array.from(String(text).normalize("NFKC"));
  const out = [];
  let i = 0;
  while (i < cps.length) {
    const cls = classify(cps[i]);
    if (cls === "skip") { i++; continue; }
    let j = i + 1;
    while (j < cps.length && classify(cps[j]) === cls) j++;
    const run = cps.slice(i, j);
    if (cls === "cjk") {
      if (run.length >= 2) {
        for (let k = 0; k + 1 < run.length; k++) out.push(run[k] + run[k + 1]);
      }
    } else {
      out.push(run.join("").toLowerCase());
    }
    i = j;
  }
  return out;
}

/** 艾宾浩斯复习间隔分桶（年龄天数 → 权重）。记忆按 updated_at 算年龄。 */
function recencyWeight(ageMs) {
  const days = ageMs / 86_400_000;
  if (days < 1) return 1.0;
  if (days < 2) return 0.9;
  if (days < 4) return 0.8;
  if (days < 7) return 0.65;
  if (days < 15) return 0.5;
  if (days < 30) return 0.35;
  if (days < 60) return 0.25;
  if (days < 180) return 0.15;
  return 0.08;
}

function docText(d) {
  return [d.title ?? "", d.content, ...(d.keywords || [])].join(" ");
}

/**
 * BM25 × 近期权重检索。importance≥3 或原始分 ≥0.85×本轮最高分的条目豁免衰减。
 * docs: {id, level, title, content, keywords, importance, updated_at}[]
 */
function search(query, docsIn, opts = {}) {
  /* docs 两种形状都接受：扁平数组，或 getAll() 的分层结果 {level: rows[]}。
     不加这层归一，调用方顺手写 search(q, getAll()) 就会在 docs.map 处抛
     "docs.map is not a function" —— 形状不匹配却在运行期才炸，很难查。 */
  const docs = Array.isArray(docsIn)
    ? docsIn
    : (docsIn && typeof docsIn === "object" ? Object.values(docsIn).flat() : []);
  const k = opts.k ?? 5;
  const now = opts.now === undefined ? Date.now() : opts.now;
  const q = tokenize(query);
  if (q.length === 0 || docs.length === 0) return [];
  const n = docs.length;
  const docToks = docs.map((d) => tokenize(docText(d)));
  const avgdl = docToks.reduce((s, t) => s + t.length, 0) / n || 1;
  const df = new Map();
  const tf = [];
  for (const toks of docToks) {
    const m = new Map();
    const seen = new Set();
    for (const t of toks) {
      m.set(t, (m.get(t) ?? 0) + 1);
      if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) ?? 0) + 1); }
    }
    tf.push(m);
  }
  const k1 = 1.5, b = 0.75;
  const raw = docs.map((_, di) => {
    let s = 0;
    const len = docToks[di].length;
    for (const term of q) {
      const f = tf[di].get(term);
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgdl)));
    }
    return s;
  });
  const maxRaw = Math.max(...raw);
  const hits = [];
  for (let di = 0; di < docs.length; di++) {
    if (raw[di] <= 0) continue;
    let w = 1;
    if (now !== null && docs[di].importance < 3 && !(raw[di] >= 0.85 * maxRaw)) {
      w = recencyWeight(now - docs[di].updated_at);
    }
    hits.push({
      id: docs[di].id, level: docs[di].level, title: docs[di].title,
      content: docs[di].content, importance: docs[di].importance,
      updated_at: docs[di].updated_at, score: raw[di] * w,
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

/**
 * 关键词命中打分（派任务召回专用）：
 *   score = 交集分 × 覆盖率 × 艾宾浩斯(updated_at) × importance 权重 × title 加成
 */
function keywordHitScore(query, docs, opts = {}) {
  const k = opts.k ?? 4;
  const now = opts.now === undefined ? Date.now() : opts.now;
  const q = tokenize(query);
  if (q.length === 0 || docs.length === 0) return [];
  const qTf = new Map();
  for (const t of q) qTf.set(t, (qTf.get(t) ?? 0) + 1);
  const n = docs.length;
  const docToks = docs.map((d) => tokenize([d.content, d.title ?? ""].join(" ")));
  const df = new Map();
  const tf = [];
  for (const toks of docToks) {
    const m = new Map();
    const seen = new Set();
    for (const t of toks) {
      m.set(t, (m.get(t) ?? 0) + 1);
      if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) ?? 0) + 1); }
    }
    tf.push(m);
  }
  const idf = (t) => Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
  const raw = docs.map((_, di) => {
    let s = 0;
    for (const [t, f] of qTf) if (tf[di].has(t)) s += idf(t) * f;
    return s;
  });
  const maxRaw = Math.max(...raw);
  const out = [];
  for (let di = 0; di < docs.length; di++) {
    if (raw[di] <= 0) continue;
    const len = docToks[di].length;
    let overlap = 0;
    for (const t of qTf.keys()) if (tf[di].has(t)) overlap++;
    const coverage = len > 0 ? overlap / len : 0;
    let w = 1;
    if (now !== null && docs[di].importance < 3 && !(raw[di] >= 0.85 * maxRaw)) {
      w = recencyWeight(now - docs[di].updated_at);
    }
    const impW = 1 + (docs[di].importance - 1) * 0.25;
    const titleHit = tokenize(docs[di].title ?? "").some((t) => qTf.has(t));
    out.push({
      id: docs[di].id, level: docs[di].level, title: docs[di].title,
      content: docs[di].content, importance: docs[di].importance,
      updated_at: docs[di].updated_at,
      score: raw[di] * coverage * w * impW * (titleHit ? 1.2 : 1),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, k);
}

function tfVector(toks) {
  const m = new Map();
  for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  if (na === 0 || nb === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const [k, v] of small) { const w = big.get(k); if (w) dot += v * w; }
  return dot / Math.sqrt(na * nb);
}

/** 余弦相似度查重（写入去重 / 冲突检测用）。 */
function findSimilar(target, docs, k = 5) {
  const targetVec = tfVector(tokenize(target));
  if (targetVec.size === 0) return [];
  const scored = [];
  for (const d of docs) {
    const s = cosine(targetVec, tfVector(tokenize(docText(d))));
    if (s <= 0) continue;
    scored.push({ id: d.id, level: d.level, title: d.title, content: d.content, similarity: Math.round(s * 1000) / 1000 });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, k);
}

/* ============== project 锚定（精简自 meow，单语言版）============== */

/** 是否全局适用：null / 空串 = 全局（ORB 单语言，不需要 multi-language 全局标记）。 */
function isGlobal(field) {
  return field === null || field === undefined || String(field).trim() === "";
}
/** project 字段是否覆盖某项目名（全局适用任何项目）。 */
function projectCovers(field, name) {
  if (isGlobal(field)) return true;
  return String(field).split(",").map((s) => s.trim()).filter(Boolean).includes(name);
}

/* ============== 存储层（JSON 文件 + 进程内索引 + 防抖落盘）============== */

let ctx = { dataRoot: "", getState: () => ({}), setState: () => {}, log: () => {} };
const store = { rows: emptyRows(), dir: "", file: "", timer: null };

function emptyRows() {
  return { soul: [], user: [], project: [], fact: [], lesson: [], topic: [], rules: [] };
}

function note(...a) { try { ctx.log("[memory]", ...a); } catch {} }

function autoKeywords(entry) {
  const toks = tokenize([entry.content, entry.title || ""].join(" "));
  return [...new Set(toks)].slice(0, 16);
}

function load() {
  try {
    if (!store.file || !fs.existsSync(store.file)) { store.rows = emptyRows(); return; }
    const raw = fs.readFileSync(store.file, "utf8");
    const data = JSON.parse(raw);
    const rows = emptyRows();
    if (data && data.rows) {
      for (const lv of LEVELS) {
        if (Array.isArray(data.rows[lv])) rows[lv] = data.rows[lv];
      }
    }
    store.rows = rows;
    note("load:", count(), "条记忆");
  } catch (e) {
    // 文件损坏 / 解析失败：宁可开空库也不让主进程崩
    note("load 失败，开空库:", (e && e.message) || String(e));
    store.rows = emptyRows();
  }
}

function flush() {
  store.timer = null;
  if (!store.file) return;
  try {
    fs.mkdirSync(store.dir, { recursive: true });
    const tmp = store.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, rows: store.rows }, null, 0));
    fs.renameSync(tmp, store.file); // 原子替换，避免写到一半崩成半个 JSON
  } catch (e) {
    note("flush 失败:", (e && e.message) || String(e));
  }
}

function markDirty() {
  if (store.timer) clearTimeout(store.timer);
  store.timer = setTimeout(flush, 300);
}

function count() {
  let n = 0;
  for (const lv of LEVELS) n += store.rows[lv].length;
  return n;
}

/* ============== CRUD ============== */

function insert(entry) {
  if (!entry || !LEVELS.includes(entry.level)) throw new Error("invalid level");
  if (!entry.content || !String(entry.content).trim()) throw new Error("content 不能为空");
  const now = Date.now();
  const row = {
    id: entry.id || newId(now),
    level: entry.level,
    title: entry.title ?? null,
    content: String(entry.content),
    importance: Math.max(1, Math.min(4, Number(entry.importance) || 1)),
    keywords: Array.isArray(entry.keywords) && entry.keywords.length
      ? entry.keywords : autoKeywords(entry),
    status: entry.status || "active",
    corrected: Number(entry.corrected) || 0,
    project: entry.project ?? null,
    subcategory: entry.subcategory ?? null,
    goal: entry.goal ?? null,
    source: entry.source || "manual",
    created_at: entry.created_at ?? now,
    updated_at: entry.updated_at ?? now,
    last_accessed_at: null,
  };
  store.rows[entry.level].push(row);
  markDirty();
  return row;
}

function findById(id) {
  for (const lv of LEVELS) {
    const r = store.rows[lv].find((x) => x.id === id);
    if (r) return { row: r, level: lv };
  }
  return undefined;
}

function update(id, patch) {
  const found = findById(id);
  if (!found) return false;
  const { row, level } = found;
  if (patch.content !== undefined) row.content = String(patch.content);
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.importance !== undefined) row.importance = Math.max(1, Math.min(4, Number(patch.importance) || 1));
  if (patch.keywords !== undefined) row.keywords = patch.keywords;
  else if (patch.content !== undefined) row.keywords = autoKeywords(row);
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.project !== undefined) row.project = patch.project;
  if (patch.subcategory !== undefined && level === "project") row.subcategory = patch.subcategory;
  if (patch.goal !== undefined && level === "topic") row.goal = patch.goal;
  if (patch.corrected !== undefined && level === "lesson") row.corrected = Number(patch.corrected) || 0;
  row.updated_at = Date.now();
  markDirty();
  return true;
}

function remove(id) {
  for (const lv of LEVELS) {
    const i = store.rows[lv].findIndex((x) => x.id === id);
    if (i >= 0) { store.rows[lv].splice(i, 1); markDirty(); return true; }
  }
  return false;
}

function list(level, opts = {}) {
  if (!LEVELS.includes(level)) return [];
  let rows = store.rows[level].slice();
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts.project !== undefined) rows = rows.filter((r) => projectCovers(r.project, opts.project));
  return rows.sort((a, b) => b.updated_at - a.updated_at);
}

function getAll() {
  const out = {};
  for (const lv of LEVELS) out[lv] = store.rows[lv].slice();
  return out;
}

/** 只给活跃条目（已归档的压缩源不进 UI、不进去重池）。 */
function getAllActive() {
  const out = {};
  for (const lv of LEVELS) out[lv] = store.rows[lv].filter((r) => r.status === "active");
  return out;
}

/* stats 里 total/每层条数一律只数 active：归档条目还留在文件里可回溯，
   但不应算进「记忆库还有多少条」，否则压缩完数字不变、用户会以为没生效。 */
function stats() {
  const out = { levels: {}, archived: 0 };
  let total = 0;
  let chars = 0;
  for (const lv of LEVELS) {
    const rows = store.rows[lv];
    const act = rows.filter((r) => r.status === "active");
    const ch = act.reduce((s, r) => s + String(r.content || "").length, 0);
    out[lv] = act.length;
    out.levels[lv] = { count: act.length, chars: ch, archived: rows.length - act.length };
    out.archived += rows.length - act.length;
    total += act.length;
    chars += ch;
  }
  out.total = total;
  out.allTotal = count();
  out.chars = chars;
  return out;
}

/* ============== 容量治理：压缩 / 归档 ============== */

/* 可压缩的层：fact / lesson / topic / project 是"会越长越多"的存货；
   rules / user / soul 是"约束"，合并有丢失风险，一律不自动压（用户可手动删）。 */
const COMPACTABLE = Object.freeze(["fact", "lesson", "topic", "project"]);

/**
 * 挑压缩候选：低重要度、久未更新、单条内容长的先压。
 * 分批上限两道闸（条数 + 总字数），避免一次塞爆 prompt。
 */
function compactCandidates(level, opts = {}) {
  if (!COMPACTABLE.includes(level)) return [];
  const maxN = Math.max(2, opts.max || 18);
  const maxChars = Math.max(800, opts.maxChars || 9000);
  const rows = store.rows[level].filter((r) => r.status === "active");
  const sorted = rows.slice().sort((a, b) =>
    ((a.importance || 1) - (b.importance || 1)) ||
    ((a.updated_at || 0) - (b.updated_at || 0)) ||
    (String(b.content || "").length - String(a.content || "").length)
  );
  const out = [];
  let chars = 0;
  for (const r of sorted) {
    if (out.length >= maxN) break;
    const len = String(r.content || "").length;
    if (out.length && chars + len > maxChars) break;
    out.push(r);
    chars += len;
  }
  /* 少于 3 条不值得压：模型合并 2 条常常只是换个说法，白花一次调用。 */
  return out.length >= 3 ? out : [];
}

/**
 * 归档（压缩后把原文退休）。不删除：文件里留着可回溯，
 * 但 status 一变就不再参与召回、不再算进预算，成本归零。
 */
function archiveMany(ids, meta = {}) {
  const set = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
  if (!set.size) return 0;
  const now = Date.now();
  let n = 0;
  for (const lv of LEVELS) {
    for (const r of store.rows[lv]) {
      if (!set.has(r.id) || r.status !== "active") continue;
      r.status = "archived";
      r.archived_at = now;
      r.archived_reason = meta.reason || "compact";
      if (Array.isArray(meta.into) && meta.into.length) r.merged_into = meta.into.slice(0, 20);
      n++;
    }
  }
  if (n) markDirty();
  return n;
}

/** 物理清掉太老的归档（默认 90 天），文件别无限长。返回清掉条数。 */
function pruneArchived(maxAgeMs = 90 * 86_400_000) {
  const cut = Date.now() - maxAgeMs;
  let n = 0;
  for (const lv of LEVELS) {
    const keep = [];
    for (const r of store.rows[lv]) {
      if (r.status === "archived" && (r.archived_at || 0) < cut) { n++; continue; }
      keep.push(r);
    }
    store.rows[lv] = keep;
  }
  if (n) markDirty();
  return n;
}

/**
 * 召回：拼一个「长期记忆块」文本，供注入派发任务的 task。
 * 策略（仿 meow，但适配 ORB「每次派发=独立任务」）：
 *   - user / soul 全量（量少，常驻）
 *   - rules 全局 + 当前 project
 *   - fact/lesson/topic 按任务文本关键词命中 topK（全局 + 当前 project 锚定）
 * 空库或 query 为空返回 ''（调用方据此决定是否拼接）。
 */
/** 常驻注入（user/soul/rules）的字符预算。超了就按 importance→更新时间 丢尾，并明确告知。
 *  1200 字 ≈ 600 token：小规则集（十几条）天然在预算内不受影响，大规则集封顶。 */
const ALWAYS_BUDGET = 1200;

/** importance 高 → 更新近 优先；这样预算不够时留下的是"重要且还在用"的。 */
function sortAlways(rows) {
  return rows.slice().sort((a, b) =>
    ((b.importance || 1) - (a.importance || 1)) ||
    ((Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
  );
}

function recall(query, opts = {}) {
  const project = opts.project || null;
  const topK = opts.topK || 4;
  if (!query || !String(query).trim()) return "";
  const all = getAll();
  const budget = Number.isFinite(opts.maxAlways) ? Math.max(200, opts.maxAlways) : ALWAYS_BUDGET;

  /* 常驻三层：按预算逐条填，超了丢 importance 最低的，并留一行说明（别让模型以为"就这些"）。 */
  const alwaysGroups = [
    { label: LEVEL_LABELS.user, rows: sortAlways(all.user.filter((r) => r.status === "active")) },
    { label: LEVEL_LABELS.soul, rows: sortAlways(all.soul.filter((r) => r.status === "active")) },
    {
      label: LEVEL_LABELS.rules,
      rows: sortAlways(all.rules.filter(
        (r) => r.status === "active" && (isGlobal(r.project) || projectCovers(r.project, project))
      )),
    },
  ];
  const parts = [];
  let used = 0;
  let dropped = 0;
  for (const g of alwaysGroups) {
    const kept = [];
    for (const r of g.rows) {
      const line = "- " + r.content;
      if (used + line.length + 1 > budget) { dropped++; continue; }
      used += line.length + 1;
      kept.push(line);
    }
    if (kept.length) parts.push(`■ ${g.label}\n` + kept.join("\n"));
  }
  if (dropped) parts.push(`（另有 ${dropped} 条长期记忆因篇幅未注入，可在记忆管理里提升重要性优先带上）`);

  const hitPool = [...all.fact, ...all.lesson, ...all.topic].filter(
    (r) => r.status === "active" && (isGlobal(r.project) || !project || projectCovers(r.project, project))
  );
  const hits = keywordHitScore(query, hitPool, { k: topK });
  /* 命中即"用过"：last_accessed_at / access_count 这两个字段原来只有 insert 时写一次 null、
     之后再没维护过 —— 于是"哪条真被用上过"完全无从判断，压缩只能按时间瞎猜。
     这里补上记录（每次派发最多写 4 条，走 300ms 防抖落盘，成本可忽略）。 */
  const nowTs = Date.now();
  let touched = false;
  for (const h of hits) {
    const f = findById(h.id);
    if (!f) continue;
    f.row.last_accessed_at = nowTs;
    f.row.access_count = (Number(f.row.access_count) || 0) + 1;
    touched = true;
  }
  if (touched) markDirty();
  if (hits.length) {
    parts.push("■ 相关记忆（按本次任务检索）\n" + hits.map((h) => `- ${h.content}`).join("\n"));
  }

  if (!parts.length) return "";
  return "[长期记忆 · ORB 控制台]\n" + parts.join("\n");
}

/* ============== 初始化（照 storage 的注入模式，避免 require 环）============== */

function init(next) {
  if (!next || typeof next !== "object") return;
  ctx = {
    dataRoot: typeof next.dataRoot === "string" ? next.dataRoot : ctx.dataRoot,
    getState: typeof next.getState === "function" ? next.getState : ctx.getState,
    setState: typeof next.setState === "function" ? next.setState : ctx.setState,
    log: typeof next.log === "function" ? next.log : ctx.log,
  };
  store.dir = path.join(ctx.dataRoot || process.cwd(), "memory");
  store.file = path.join(store.dir, "memory.json");
  load();
}

module.exports = {
  LEVELS, LEVEL_LABELS, PROJECT_SUBCATEGORIES, COMPACTABLE,
  init, recall, insert, update, remove, findById, list, getAll, getAllActive, stats,
  compactCandidates, archiveMany, pruneArchived,
  tokenize, search, keywordHitScore, findSimilar, isGlobal, projectCovers,
  flush,
};
