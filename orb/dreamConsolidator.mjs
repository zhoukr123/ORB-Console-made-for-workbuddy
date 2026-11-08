/*
 * Dream 记忆整理层（桥侧纯逻辑，可单测）
 *
 * 背景：Anthropic《The components of agent memory》「Dreaming」——
 * 在空闲时段离线复盘历史日志，修正错误记忆、构建关联、提升高价值记忆层级
 * 并预加载、按任务定向组织、补齐知识缺口。本层不改动模型权重，
 * 也不等同于会话摘要压缩；实时写入的记忆可能当时就错或随后过时，
 * 会在后续会话被反复调用导致失败，因此需要离线整理与控量预加载。
 *
 * 设计约定：
 * - 纯模块：不依赖任何 ORB 现有模块，不读写磁盘，时间源与配额经 opts 注入。
 * - 每次 consolidate 以本批 entries 为全量素材重建内存，流程固定为
 *   collect → dedupe → correct → index → preload。
 * - 红线：不可信输入一律剔除；浮起只作候选、不创建工单或派发字段；
 *   预加载受硬配额约束，溢出进入 deferred；纠错必须有证据，
 *   无证据只标 UNVERIFIED: 前缀，绝不冒充已核验；没把握的结论单列 UNVERIFIED: 行。
 * - consolidate 返回的 stats 为本次运行计数；stats() 里的 corrected / unverified
 *   为当前内存中的条目数（随 verify 变化）；indexed 与 size 均指倒排索引键数。
 * - chars 缺省按 text.length 计算，文本被改写后按新文本重算。
 */

export const UNVERIFIED_PREFIX = "UNVERIFIED:";

export const TRUST_LEVELS = Object.freeze({
  trusted: "trusted",
  untrusted: "untrusted",
  unverified: "unverified",
});

export const CONSOLIDATION_PHASES = Object.freeze({
  collect: "collect",
  dedupe: "dedupe",
  correct: "correct",
  index: "index",
  preload: "preload",
});

export const DEFAULT_QUOTA = Object.freeze({
  maxPreload: 8,
  maxChars: 2400,
  minScore: 0.6,
});

const PHASE_ORDER = Object.values(CONSOLIDATION_PHASES);
const DEDUPE_THRESHOLD = 0.8;
const COPY_FIELDS = [
  "id",
  "text",
  "tag",
  "topic",
  "score",
  "trust",
  "evidence",
  "desired",
  "chars",
];

const clone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const finiteInt = (value, fallback) =>
  Number.isFinite(Number(value))
    ? Math.max(0, Math.floor(Number(value)))
    : fallback;

const bigrams = (text) => {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
};

const stripUnverified = (text) =>
  typeof text === "string" && text.startsWith(UNVERIFIED_PREFIX)
    ? text.slice(UNVERIFIED_PREFIX.length).replace(/^\s+/, "")
    : text;

const buildIndex = (list) => {
  const idx = Object.create(null);
  for (const e of list) {
    const keys = [];
    if (e.tag !== undefined && e.tag !== null && String(e.tag).length > 0) {
      keys.push(String(e.tag));
    }
    if (e.topic !== undefined && e.topic !== null && String(e.topic).length > 0) {
      keys.push(String(e.topic));
    }
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(idx, key)) idx[key] = [];
      if (!idx[key].includes(e.id)) idx[key].push(e.id);
    }
  }
  return idx;
};

const selectPreload = (list, quota) => {
  const pool = [...list].sort((x, y) => y.score - x.score);
  const items = [];
  const deferred = [];
  let usedChars = 0;
  for (const e of pool) {
    if (e.score < quota.minScore) {
      deferred.push(e);
      continue;
    }
    if (
      items.length >= quota.maxPreload ||
      usedChars + e.chars > quota.maxChars
    ) {
      deferred.push(e);
      continue;
    }
    items.push(e);
    usedChars += e.chars;
  }
  return { items, deferred, usedChars };
};

export function similarity(a = "", b = "") {
  const s1 = typeof a === "string" ? a : "";
  const s2 = typeof b === "string" ? b : "";
  if (s1 === s2) return 1;
  if (s1.length < 2 || s2.length < 2) return 0;
  const g1 = bigrams(s1);
  const g2 = bigrams(s2);
  let inter = 0;
  for (const g of g1) if (g2.has(g)) inter += 1;
  const union = g1.size + g2.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function isEligible(entry = {}) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, reason: "not-an-object" };
  }
  if (entry.untrusted === true) return { ok: false, reason: "untrusted" };
  if (
    entry.trust === undefined ||
    entry.trust === null ||
    entry.trust === ""
  ) {
    return { ok: false, reason: "missing-trust" };
  }
  if (entry.trust !== TRUST_LEVELS.trusted) {
    return { ok: false, reason: "trust-not-trusted" };
  }
  if (typeof entry.text !== "string" || entry.text.trim().length === 0) {
    return { ok: false, reason: "empty-text" };
  }
  return { ok: true, reason: "ok" };
}

export function createDreamConsolidator(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const quotaOverride =
    opts.quota && typeof opts.quota === "object" && !Array.isArray(opts.quota)
      ? opts.quota
      : {};
  const quotaFor = typeof opts.quotaFor === "function" ? opts.quotaFor : null;
  let idSeq = 0;

  let memory = [];
  let index = Object.create(null);
  let preload = [];
  let deferred = [];
  let runs = 0;
  let lastRunAt = null;

  const resolveQuota = (mode) => {
    const fromFn = quotaFor ? quotaFor(mode) : null;
    const extra =
      fromFn && typeof fromFn === "object" && !Array.isArray(fromFn)
        ? fromFn
        : {};
    const merged = { ...DEFAULT_QUOTA, ...quotaOverride, ...extra };
    return {
      maxPreload: finiteInt(merged.maxPreload, DEFAULT_QUOTA.maxPreload),
      maxChars: finiteInt(merged.maxChars, DEFAULT_QUOTA.maxChars),
      minScore: Number.isFinite(Number(merged.minScore))
        ? Number(merged.minScore)
        : DEFAULT_QUOTA.minScore,
    };
  };

  function stats() {
    return {
      runs,
      lastRunAt,
      memorySize: memory.length,
      indexSize: Object.keys(index).length,
      corrected: memory.filter((e) => e.corrected === true).length,
      unverified: memory.filter(
        (e) =>
          typeof e.text === "string" && e.text.startsWith(UNVERIFIED_PREFIX),
      ).length,
      deferred: deferred.length,
    };
  }

  const consolidate = (entries = [], ctx = {}) => {
    if (!Array.isArray(entries)) return { ok: false, code: "bad-input" };
    if (ctx && ctx.idle === false) {
      return { ok: false, code: "not-idle", stats: stats() };
    }

    const quota = resolveQuota(ctx ? ctx.mode : undefined);
    const at = now();
    const s = {
      collected: 0,
      trusted: 0,
      rejected: 0,
      deduped: 0,
      corrected: 0,
      unverified: 0,
      indexed: 0,
      preloaded: 0,
      deferred: 0,
    };

    // collect
    const candidates = [];
    s.collected = entries.length;
    for (const raw of entries) {
      if (!isEligible(raw).ok) {
        s.rejected += 1;
        continue;
      }
      s.trusted += 1;
      const picked = {};
      for (const key of COPY_FIELDS) {
        if (raw[key] !== undefined) picked[key] = raw[key];
      }
      const e = clone(picked);
      e.text = raw.text;
      e.id = raw.id !== undefined && raw.id !== null ? raw.id : `auto-${++idSeq}`;
      e.score =
        typeof raw.score === "number" && Number.isFinite(raw.score)
          ? Math.min(1, Math.max(0, raw.score))
          : 0;
      e.chars =
        typeof raw.chars === "number" && Number.isFinite(raw.chars)
          ? Math.max(0, raw.chars)
          : raw.text.length;
      candidates.push(e);
    }

    // dedupe
    const kept = [];
    for (const e of candidates) {
      let hit = -1;
      for (let j = 0; j < kept.length; j += 1) {
        if (similarity(e.text, kept[j].text) >= DEDUPE_THRESHOLD) {
          hit = j;
          break;
        }
      }
      if (hit === -1) {
        kept.push(e);
      } else {
        s.deduped += 1;
        if (e.score > kept[hit].score) kept[hit] = e;
      }
    }

    // correct
    for (const e of kept) {
      const desired = e.desired;
      const hasDesired =
        typeof desired === "string" && desired.trim().length > 0;
      if (!hasDesired) continue;
      const hasEvidence =
        typeof e.evidence === "string" && e.evidence.trim().length > 0;
      if (hasEvidence) {
        e.text = desired;
        e.chars = desired.length;
        e.corrected = true;
        s.corrected += 1;
      } else {
        e.text = `${UNVERIFIED_PREFIX} ${e.text}`;
        e.chars = e.text.length;
        s.unverified += 1;
      }
    }

    // index
    index = buildIndex(kept);
    s.indexed = Object.keys(index).length;

    // preload
    const sel = selectPreload(kept, quota);
    preload = sel.items;
    deferred = sel.deferred;
    s.preloaded = preload.length;
    s.deferred = deferred.length;

    memory = kept;
    runs += 1;
    lastRunAt = at;

    const report = [
      "[dream] 离线复盘：仅整理记忆，不改动模型权重，不做会话摘要压缩",
      `[collect] 采集 ${s.collected} 条，可信 ${s.trusted} 条，剔除 ${s.rejected} 条`,
      `[dedupe] 合并重复 ${s.deduped} 条`,
      `[correct] 有证据纠错 ${s.corrected} 条，待核验 ${s.unverified} 条`,
      `[index] 重建倒排索引 ${s.indexed} 个键`,
      `[preload] 预加载 ${s.preloaded} 条（上限 ${quota.maxPreload} 条 / ${quota.maxChars} 字符，最低分 ${quota.minScore}），延迟 ${s.deferred} 条`,
    ];
    for (const e of memory) {
      if (
        typeof e.text === "string" &&
        e.text.startsWith(UNVERIFIED_PREFIX)
      ) {
        report.push(`${UNVERIFIED_PREFIX} ${e.id} ${e.text}`);
      }
    }
    if (s.unverified > 0) {
      report.push(
        `[gap] ${s.unverified} 条结论缺证据，已单列 UNVERIFIED: 行，未冒充已核验`,
      );
    }

    return {
      ok: true,
      phases: PHASE_ORDER.slice(),
      stats: s,
      memory: clone(memory),
      index: clone(index),
      preload: clone(preload),
      deferred: clone(deferred),
      report,
      at,
    };
  };

  const verify = (id, evidence) => {
    if (typeof evidence !== "string" || evidence.trim().length === 0) {
      return { ok: false, code: "evidence-required" };
    }
    const target = memory.find((e) => e.id === id);
    if (!target) return { ok: false, code: "not-found" };
    if (
      typeof target.text === "string" &&
      target.text.startsWith(UNVERIFIED_PREFIX)
    ) {
      target.text = stripUnverified(target.text);
      target.chars = target.text.length;
    }
    target.verified = true;
    return { ok: true, id, text: target.text, verified: true };
  };

  const rebuildIndex = () => {
    index = buildIndex(memory);
    return { ok: true, index: clone(index), size: Object.keys(index).length };
  };

  const preloadFor = (topic, mode) => {
    const quota = resolveQuota(mode);
    const key = String(topic);
    const candidates = memory.filter(
      (e) =>
        String(e.topic ?? "") === key || String(e.tag ?? "") === key,
    );
    const sel = selectPreload(candidates, quota);
    return {
      ok: true,
      items: clone(sel.items),
      usedChars: sel.usedChars,
      quota: { ...quota },
    };
  };

  const snapshot = () => clone({ memory, index, preload, deferred });

  return { consolidate, verify, rebuildIndex, preloadFor, stats, snapshot };
}
