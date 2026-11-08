/* Affect Gate：只回答一个问题——「ORB 此刻该不该主动开口」。
 *
 * 设计取舍：
 * - 不做情绪模块。情绪状态既无法验证，也兑现不了方案 §7 的验收口径
 *   （「总开口次数不增加；连续打断 5 分钟内主动开口 = 0，但需决策仍弹」）。
 *   所以这里只做门控：把「该不该说话」收敛成一个可测、可回放的布尔判定。
 * - 六项按优先级排列，靠前的先短路；但六项都给出结论，
 *   面板才能解释「为什么它没说话」，而不是只看到一个冷冰冰的 false。
 * - 判定与记录分离：evaluate 只有一条环形缓冲的副作用，方便单测与事后归因。
 * - 任何入参都不抛异常。门控本身不能成为新的故障源——
 *   它一旦崩了，上层要么静默失败（该说的没说），要么放开闸门（变成打扰）。
 */

/* 元数据对外只读：面板与测试都按这份顺序解释 blockedBy。 */
export const GATES = Object.freeze([
  Object.freeze({ id: "decision-required", name: "决策必需直通", order: 1 }),
  Object.freeze({ id: "stopped", name: "急停态抑制", order: 2 }),
  Object.freeze({ id: "user-present", name: "用户在场静默", order: 3 }),
  Object.freeze({ id: "cooldown", name: "冷却窗口", order: 4 }),
  Object.freeze({ id: "confidence", name: "置信度阈值", order: 5 }),
  Object.freeze({ id: "burst", name: "连续打扰熔断", order: 6 }),
]);

const DEFAULTS = Object.freeze({
  presentWindowMs: 90_000,
  cooldownMs: 180_000,
  minConfidence: 0.6,
  burstWindowMs: 300_000,
  burstMax: 3,
});

/**
 * 开口频率三档。对外的只有档位名，不给用户任何数值参数入口。
 * 依据：When2Talk（VR 车内主动语音研究，41 人被试）把主动开口收敛成
 * Immediate / Delayed / Silent 三选，情境敏感策略比「事件一来就说」显著更得体、
 * 打断感明显更低；价值必须高于打断成本，且冷却 / 频次上限 / 静默时段 /
 * 让位给正在进行的对话这四层护栏常开、不可关闭 —— 可调的只有「偏向哪一档」。
 *   安静 → 偏 Silent；标准 → 偏 Delayed；及时 → 偏 Immediate。
 * 三档都保留 DEFAULTS 里的护栏（burstMax >= 1、冷却 > 0），不是把门控关掉。
 */
export const SPEAK_TIERS = Object.freeze({
  quiet: Object.freeze({
    id: "quiet", name: "安静", hint: "少开口，只在确实值得打断时才说",
    params: Object.freeze({ presentWindowMs: 240_000, cooldownMs: 600_000, minConfidence: 0.8, burstWindowMs: 300_000, burstMax: 1 }),
  }),
  standard: Object.freeze({
    id: "standard", name: "标准", hint: "按情境判断，能等就等一会儿再说",
    params: Object.freeze({ ...DEFAULTS }),
  }),
  prompt: Object.freeze({
    id: "prompt", name: "及时", hint: "有进展就说，少等",
    params: Object.freeze({ presentWindowMs: 30_000, cooldownMs: 60_000, minConfidence: 0.45, burstWindowMs: 300_000, burstMax: 5 }),
  }),
});
export const SPEAK_TIER_IDS = Object.freeze(Object.keys(SPEAK_TIERS));
export const DEFAULT_SPEAK_TIER = "standard";

/**
 * 从用户说的话里推断「这次该按哪一档」。只影响判定，不改全局档位，
 * 也不产生任何数值参数 —— Agent 的推理结果就是一个档位名。
 * 识别不到返回 null，调用方按当前档位走。
 */
export function inferTierFromText(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (/(别烦|安静|别吵|少说|闭嘴|不要提醒|别打扰|我自己来|先别|不用管我|静一静|安静点)/.test(t)) {
    return { tier: "quiet", reason: "用户明确要求少开口" };
  }
  if (/(随时|及时|马上告诉我|有进展就说|别漏|及时提醒|立刻说|第一时间|多提醒|盯着点)/.test(t)) {
    return { tier: "prompt", reason: "用户明确要求及时告知" };
  }
  if (/(正常就好|照常|一般就行|标准|按平常|不用特别)/.test(t)) {
    return { tier: "standard", reason: "用户要求回到常规" };
  }
  return null;
}

/* 缓冲上限 200：够回看最近一轮工作，又不至于把内存交给一条长跑的会话。 */
const MAX_RECORDS = 200;
const URGENCIES = new Set(["low", "normal", "high"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isConf = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isCount = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;

/* 缺省置信度按 0 处理：宁可少说一句，也不要在没把握时插话。 */
function normConfidence(v) {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function normUrgency(v) {
  return URGENCIES.has(v) ? v : "normal";
}

function normKind(v) {
  return typeof v === "string" && v ? v : "unspecified";
}

function fmt(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms)}ms` : "未知";
}

export function createAffectGate(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const opt = { ...DEFAULTS };
  // 构造期只接受合法值，非法值直接退回默认，避免带病启动。
  for (const key of Object.keys(DEFAULTS)) {
    if (key === "minConfidence" ? isConf(opts[key]) : key === "burstMax" ? isCount(opts[key]) : isNum(opts[key])) {
      opt[key] = opts[key];
    }
  }

  let buf = [];
  let total = 0;
  let passed = 0;
  let blocked = 0;
  let lastAt = null;
  let tier = DEFAULT_SPEAK_TIER;
  const byGate = Object.create(null);
  for (const g of GATES) byGate[g.id] = 0;

  /* 本次判定用哪套参数：用户**原话**里明确表态的优先（Agent 的当场推理），
     其次才是调用方给的 tierHint，都没有就用当前全局档位/在线参数。
     「照常 / 标准」这类话表示撤回临时表态，回落到全局档，而不是强行覆盖它。
     护栏始终存在，档位只改松紧。 */
  function paramsFor(ctx) {
    const inferred = ctx && ctx.userText ? inferTierFromText(ctx.userText) : null;
    if (inferred && inferred.tier !== "standard" && SPEAK_TIERS[inferred.tier]) {
      return SPEAK_TIERS[inferred.tier].params;
    }
    const hint = ctx && typeof ctx.tierHint === "string" ? ctx.tierHint : "";
    if (SPEAK_TIERS[hint]) return SPEAK_TIERS[hint].params;
    return opt;
  }

  function setTier(id) {
    if (!SPEAK_TIERS[id]) return { ok: false, error: "没有这一档", tier };
    const r = setOptions({ ...SPEAK_TIERS[id].params });
    if (r.ok === false) return { ok: false, error: r.error, tier };
    tier = id;
    return { ok: true, tier, name: SPEAK_TIERS[id].name, options: { ...opt } };
  }

  /* 外部显式给的 lastSpokeAt 优先；否则回看内部记录里最近一次放行。
     外部的那个用于跨进程/重启续接冷却，内部的是本进程的真相。 */
  function resolveLastSpoke(ctx) {
    if (isNum(ctx.lastSpokeAt)) return ctx.lastSpokeAt;
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].pass) return buf[i].at;
    }
    return null;
  }

  function countBurst(at, p) {
    let n = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      const rec = buf[i];
      // 记录按时间递增，越界即可停；相等视作「刚出窗口」，与冷却的边界口径一致。
      if (at - rec.at >= p.burstWindowMs) break;
      if (rec.pass) n++;
    }
    return n;
  }

  function remember(rec) {
    buf.push(rec);
    // 上限 200，shift 的 O(n) 在这里可忽略，换来的是无游标、无空洞的简单实现。
    if (buf.length > MAX_RECORDS) buf.shift();
  }

  function invalid(at, why) {
    return {
      ok: false,
      error: why,
      pass: false,
      blockedBy: "invalid-input",
      escalate: false,
      // 仍然给满六项，调用方不必为异常路径写第二套取值逻辑。
      gates: GATES.map((g) => ({ id: g.id, name: g.name, pass: false, reason: "入参非法，未参与判定" })),
      ctx: { kind: "unspecified", urgency: "normal", confidence: 0 },
      at,
    };
  }

  function evaluate(ctx) {
    const at = now();
    if (!ctx || typeof ctx !== "object") return invalid(at, "ctx 必须是对象");
    /* 档位只影响「这一句该不该开口」的松紧，六项护栏一项都没被关掉。 */
    const p = paramsFor(ctx);

    const decisionRequired = ctx.decisionRequired === true;
    const stopped = ctx.stopped === true;
    const confidence = normConfidence(ctx.confidence);
    const urgency = normUrgency(ctx.urgency);
    const kind = normKind(ctx.kind);
    const lastSpokeAt = resolveLastSpoke(ctx);

    const gates = [];

    if (decisionRequired) {
      // 用户必须被问到的事，任何冷却都不该挡；其余五项直接判跳过。
      for (const g of GATES) {
        gates.push({
          id: g.id,
          name: g.name,
          pass: true,
          reason: g.id === "decision-required" ? "决策必需，直通" : "决策直通，本项跳过",
        });
      }
    } else {
      // 该项是旁路而非拦截：未命中就让位给后续门控，因此恒判通过，
      // 否则它会抢走 blockedBy，把真正的拦因（冷却/置信度…）盖掉。
      gates.push({ id: "decision-required", name: "决策必需直通", pass: true, reason: "非决策必需，让位给后续门控" });

      gates.push({
        id: "stopped",
        name: "急停态抑制",
        pass: !stopped,
        reason: stopped ? "急停中，只保留决策类开口" : "未急停",
      });

      // 用户在场：最近一次操作距今不足窗口，视为正在用机器，不插话。
      const personActive = isNum(ctx.userActiveAt) ? at - ctx.userActiveAt : null;
      const presentBlocked = personActive !== null && personActive < p.presentWindowMs;
      gates.push({
        id: "user-present",
        name: "用户在场静默",
        pass: !presentBlocked,
        reason: personActive === null
          ? "无在场信号"
          : presentBlocked
            ? `最后一次操作在 ${fmt(personActive)} 前，未满静默窗 ${fmt(p.presentWindowMs)}`
            : `最后一次操作在 ${fmt(personActive)} 前，已过静默窗`,
      });

      // 冷却只约束「主动」开口；差值恰好等于窗口即视作到期，避免边界上多拦一次。
      const sinceSpoke = lastSpokeAt === null ? null : at - lastSpokeAt;
      const cooldownBlocked = sinceSpoke !== null && sinceSpoke < p.cooldownMs;
      gates.push({
        id: "cooldown",
        name: "冷却窗口",
        pass: !cooldownBlocked,
        reason: sinceSpoke === null
          ? "无最近开口记录"
          : cooldownBlocked
            ? `距上次开口 ${fmt(sinceSpoke)}，未满冷却 ${fmt(p.cooldownMs)}（还差 ${fmt(p.cooldownMs - sinceSpoke)}）`
            : `距上次开口 ${fmt(sinceSpoke)}，已满冷却 ${fmt(p.cooldownMs)}`,
      });

      const confBlocked = confidence < p.minConfidence;
      gates.push({
        id: "confidence",
        name: "置信度阈值",
        pass: !confBlocked,
        reason: confBlocked
          ? `置信度 ${confidence} 低于阈值 ${p.minConfidence}`
          : `置信度 ${confidence} 达到阈值 ${p.minConfidence}`,
      });

      const burst = countBurst(at, p);
      const burstBlocked = burst >= p.burstMax;
      gates.push({
        id: "burst",
        name: "连续打扰熔断",
        pass: !burstBlocked,
        reason: burstBlocked
          ? `${fmt(p.burstWindowMs)} 内已主动开口 ${burst} 次，达到上限 ${p.burstMax}`
          : `${fmt(p.burstWindowMs)} 内已主动开口 ${burst} 次，未达上限 ${p.burstMax}`,
      });
    }

    const firstFail = gates.find((g) => !g.pass) || null;
    const pass = firstFail === null;
    // escalate 只是「够紧急」的提示，不能越过任何一项门控——
    // 否则高强度打扰恰好会砸在用户正在操作或刚被喊过的时候。
    const escalate = pass && urgency === "high" && confidence >= p.minConfidence;

    total++;
    if (pass) passed++; else { blocked++; byGate[firstFail.id]++; }
    lastAt = at;
    remember({ at, pass, blockedBy: firstFail ? firstFail.id : null, kind, urgency });

    return {
      ok: true,
      pass,
      blockedBy: firstFail ? firstFail.id : null,
      escalate,
      gates,
      ctx: { kind, urgency, confidence },
      at,
    };
  }

  /* 新的在前：排查时先看最近一次「为什么没说话」。total 是缓冲内的条数，
     stats().total 才是累计判定次数。 */
  function records({ limit = 50 } = {}) {
    const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 50;
    const rows = n === 0 ? [] : buf.slice(-n).reverse();
    return { ok: true, rows, total: buf.length };
  }

  function stats() {
    return {
      ok: true,
      total,
      passed,
      blocked,
      tier,
      byGate: { ...byGate },
      // 保留四位：面板要的是稳定展示，不是浮点尾数。
      passRate: total ? Math.round((passed / total) * 10000) / 10000 : 0,
      lastAt,
    };
  }

  /* 非法值忽略而非抛错：门控被上层在线调参，调用方不该为了改一个窗口而写 try/catch。 */
  function setOptions(patch) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return { ok: false, error: "patch 必须是对象", options: { ...opt } };
    }
    const ignored = [];
    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in patch)) continue;
      const v = patch[key];
      const good = key === "minConfidence" ? isConf(v) : key === "burstMax" ? isCount(v) : isNum(v);
      if (good) opt[key] = v;
      else ignored.push(key);
    }
    if (ignored.length) {
      return { ok: false, error: `非法值已忽略：${ignored.join("、")}`, ignored, options: { ...opt } };
    }
    return { ok: true, options: { ...opt } };
  }

  return {
    evaluate,
    records,
    stats,
    setOptions,
    setTier,
    tier: () => tier,
    inferTier: inferTierFromText,
    options: () => ({ ...opt }),
    // 参数保留：调好的窗口不该因为清空记录被重置。
    reset: () => { buf = []; total = 0; passed = 0; blocked = 0; lastAt = null; for (const g of GATES) byGate[g.id] = 0; return { ok: true }; },
  };
}
