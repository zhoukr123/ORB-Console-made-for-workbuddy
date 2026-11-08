/* ============================================================
 * I-08 动态记忆预算
 *
 * 纯逻辑模块：不依赖仓库内任何既有实现，不访问磁盘，不引入外部依赖，
 * 可被任意一侧直接调用而不产生副作用。
 *
 * 设计目标：普通模式「零开销」——直接沿用固定基线，不读取上下文用量、
 * 不做任何动态计算；只有 Max 模式才启用动态放大，且每个维度都被硬上限
 * 夹住，避免预加载过量占用上下文 token 而拉低指令遵循度。
 *
 * 单位约定：
 *  - BASE_BUDGET.chars / HARD_CAP.chars 是「总字符预算」；
 *  - BASE_BUDGET.always / working / archived 以及 HARD_CAP 同名字段是
 *    各层「条目数配额」（archived 恒为 0，归档层不参与预加载）；
 *  - MEMORY_TIERS 的权重用于把总字符预算拆成各层字符上限；
 *  - 条目的层名为 always / working / archive，配额键为 archived，
 *    两者在 allocate 内做显式映射，不混用。
 *  - trust 必须显式等于 "trusted" 才视为可信；verified === false 或
 *    文本以 "UNVERIFIED:" 开头的条目视为未验证。
 *  - 所有返回的数字均为整数；返回对象一律为新建副本，外部改动不污染内部。
 * ============================================================ */

export const BUDGET_MODES = Object.freeze({
  normal: "normal",
  max: "max",
});

export const MEMORY_TIERS = Object.freeze({
  always: Object.freeze({ id: "always", weight: 3 }),
  working: Object.freeze({ id: "working", weight: 2 }),
  archive: Object.freeze({ id: "archive", weight: 0 }),
});

export const BASE_BUDGET = Object.freeze({ chars: 1200, always: 8, working: 12, archived: 0 });
export const HARD_CAP = Object.freeze({ chars: 6000, always: 24, working: 48 });

const KNOWN_MODES = Object.freeze(Object.values(BUDGET_MODES));

// 各维度放大后的上限：归档层不参与放大，恒等于基线 0。
const CAPS = Object.freeze({
  chars: HARD_CAP.chars,
  always: HARD_CAP.always,
  working: HARD_CAP.working,
  archived: BASE_BUDGET.archived,
});

const TIER_ORDER = Object.freeze({ always: 0, working: 1, archive: 2 });

// Max 模式一旦启用即给的基础扩容比例，再由用量信号推进到硬上限。
const ENABLE_GAIN = 0.35;

function isKnownMode(mode) {
  return KNOWN_MODES.includes(mode);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp01(v) {
  const n = num(v);
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function clampInt(v, lo, hi) {
  const n = Math.round(num(v));
  return n < lo ? lo : n > hi ? hi : n;
}

// 候选压力归一到 0..1：数字视为总量，对象按各层相加。
function pressureSignal(tp) {
  if (tp == null) return 0;
  let total;
  if (typeof tp === "object") {
    total = 0;
    for (const v of Object.values(tp)) total += num(v);
  } else {
    total = num(tp);
  }
  return clamp01(total / (HARD_CAP.always + HARD_CAP.working));
}

function baseResult() {
  return {
    ok: true,
    mode: BUDGET_MODES.normal,
    enabled: false,
    chars: BASE_BUDGET.chars,
    tiers: {
      always: BASE_BUDGET.always,
      working: BASE_BUDGET.working,
      archived: BASE_BUDGET.archived,
    },
    source: "base",
  };
}

export function budgetFor(mode = BUDGET_MODES.normal, opts = {}) {
  // 普通模式：立刻返回固定基线副本，绝不触碰 opts，保证零开销。
  if (mode === BUDGET_MODES.normal) {
    return baseResult();
  }
  // 未知模式：同样不触碰 opts。
  if (mode !== BUDGET_MODES.max) {
    return { ok: false, code: "bad-mode" };
  }

  // 只有走到这里（Max 模式）才会读取用量相关入参并做动态计算。
  const o = opts && typeof opts === "object" ? opts : {};
  const u = clamp01(o.usage);
  const p = pressureSignal(o.tierPressure);
  const f = clamp01(num(o.freeChars) / HARD_CAP.chars);
  const signal = clamp01(0.5 * u + 0.3 * p + 0.2 * f);
  const gain = ENABLE_GAIN + (1 - ENABLE_GAIN) * signal; // 恒在 0.35..1

  const grow = (baseVal, capVal) =>
    clampInt(baseVal + (capVal - baseVal) * gain, baseVal, capVal);

  return {
    ok: true,
    mode: BUDGET_MODES.max,
    enabled: true,
    chars: grow(BASE_BUDGET.chars, CAPS.chars),
    tiers: {
      always: grow(BASE_BUDGET.always, CAPS.always),
      working: grow(BASE_BUDGET.working, CAPS.working),
      archived: CAPS.archived,
    },
    source: "dynamic",
  };
}

function deepClonePlain(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(deepClonePlain);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClonePlain(v[k]);
  return out;
}

export function createMemoryBudget(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  let mode = isKnownMode(o.mode) ? o.mode : BUDGET_MODES.normal;
  const quota = deepClonePlain(o.quota && typeof o.quota === "object" ? o.quota : {});
  const samples = [];
  let usage = 0;
  let allocations = 0;
  let totalSelected = 0;
  let totalDeferred = 0;
  let totalUntrusted = 0;
  let lastAt = now();

  function currentBudget() {
    if (mode === BUDGET_MODES.max) {
      return budgetFor(mode, { usage, ...quota });
    }
    // 普通模式不带任何用量入参。
    return budgetFor(mode);
  }

  return {
    setMode(next) {
      if (!isKnownMode(next)) {
        return { ok: false, mode: next, code: "bad-mode" };
      }
      mode = next;
      lastAt = now();
      return { ok: true, mode, budget: currentBudget() };
    },

    observe(u) {
      // 普通模式不做任何记录，连入参都不读取。
      if (mode !== BUDGET_MODES.max) {
        return { ok: true, recorded: false };
      }
      const sample = clamp01(u);
      samples.push(sample);
      usage = samples.reduce((a, b) => a + b, 0) / samples.length;
      lastAt = now();
      return { ok: true, recorded: true };
    },

    allocate(entries = [], ctx = {}) {
      void ctx; // 预留的调用上下文，当前预算只由 mode / observe / quota 决定。
      const budget = currentBudget();
      const list = Array.isArray(entries) ? entries : [];
      const at = now();

      const tierCap = {
        always: budget.tiers.always,
        working: budget.tiers.working,
        archive: budget.tiers.archived,
      };
      const wA = MEMORY_TIERS.always.weight;
      const wW = MEMORY_TIERS.working.weight;
      const wR = MEMORY_TIERS.archive.weight;
      const wTotal = wA + wW + wR;
      const charCap = {
        always: wTotal ? Math.floor((budget.chars * wA) / wTotal) : 0,
        working: wTotal ? Math.floor((budget.chars * wW) / wTotal) : 0,
        archive: wTotal ? Math.floor((budget.chars * wR) / wTotal) : 0,
      };

      const rejected = { untrusted: 0, overCap: 0, unverified: 0 };
      const report = [];
      const candidates = [];

      list.forEach((entry, index) => {
        const e = entry && typeof entry === "object" ? entry : { text: entry };
        const copy = { ...e };
        const text = typeof e.text === "string" ? e.text : String(e.text ?? "");
        const id = e.id ?? null;

        // 不可信条目一律剔除：既不进 selected，也不进 deferred。
        if (e.trust !== "trusted" || e.untrusted === true) {
          rejected.untrusted += 1;
          report.push({
            id,
            tier: e.tier ?? null,
            effectiveTier: null,
            action: "rejected",
            reason: "untrusted",
            unverified: false,
            chars: text.length,
          });
          return;
        }

        const unverified = e.verified === false || text.startsWith("UNVERIFIED:");
        const originalTier = e.tier ?? null;
        let effectiveTier = originalTier;
        if (effectiveTier !== "always" && effectiveTier !== "working" && effectiveTier !== "archive") {
          effectiveTier = "working";
        }
        if (unverified) {
          rejected.unverified += 1;
          // 未验证条目不占 always 预加载配额，只能降到 working。
          if (effectiveTier === "always") effectiveTier = "working";
        }

        candidates.push({
          copy,
          id,
          text,
          originalTier,
          effectiveTier,
          unverified,
          index,
          score: num(e.score),
        });
      });

      // 层内按 score 降序，同分保持输入顺序；跨层按固定层序保证确定性。
      candidates.sort((a, b) => {
        const byTier = TIER_ORDER[a.effectiveTier] - TIER_ORDER[b.effectiveTier];
        if (byTier !== 0) return byTier;
        return b.score - a.score || a.index - b.index;
      });

      const selected = [];
      const deferred = [];
      const countUsed = { always: 0, working: 0, archive: 0 };
      const charUsed = { always: 0, working: 0, archive: 0 };
      let usedChars = 0;

      const rep = (c, action, reason) => ({
        id: c.id,
        tier: c.originalTier,
        effectiveTier: c.effectiveTier,
        action,
        reason,
        unverified: c.unverified,
        chars: c.text.length,
      });

      for (const c of candidates) {
        const t = c.effectiveTier;
        const len = c.text.length;

        // 单条已超过该层字符上限或总字符上限：注定放不下，完整保留进 deferred。
        if (len > budget.chars || len > charCap[t]) {
          deferred.push(c.copy);
          rejected.overCap += 1;
          report.push(rep(c, "deferred", "over-cap"));
          continue;
        }

        // 放不下不丢弃、不截断文本，只是延后。
        if (
          countUsed[t] >= tierCap[t] ||
          charUsed[t] + len > charCap[t] ||
          usedChars + len > budget.chars
        ) {
          deferred.push(c.copy);
          report.push(rep(c, "deferred", "budget-full"));
          continue;
        }

        selected.push(c.copy);
        countUsed[t] += 1;
        charUsed[t] += len;
        usedChars += len;
        report.push(rep(c, "selected", "in-budget"));
      }

      allocations += 1;
      totalSelected += selected.length;
      totalDeferred += deferred.length;
      totalUntrusted += rejected.untrusted;
      lastAt = at;

      return {
        ok: true,
        mode,
        enabled: budget.enabled,
        usedChars,
        budget,
        selected,
        deferred,
        rejected,
        report,
        at,
      };
    },

    stats() {
      return {
        mode,
        samples: samples.length,
        allocations,
        selected: totalSelected,
        deferred: totalDeferred,
        untrusted: totalUntrusted,
        lastAt,
      };
    },

    snapshot() {
      return {
        mode,
        samples: samples.slice(),
        allocations,
        selected: totalSelected,
        deferred: totalDeferred,
        untrusted: totalUntrusted,
        lastAt,
        usage,
        quota: deepClonePlain(quota),
        budget: currentBudget(),
      };
    },
  };
}
