/* 语气三槽（personaSlots）：给五个性格再叠一层"此刻该用什么温度说话"。
 *
 * 为什么不是"再写五套台词"：五个性格 × 五种情绪状态 = 25 套语料，
 * 没人维护得动，最后一定变成同一套话来回说。这里换一种做法：
 * 性格决定"是谁在说"，槽位决定"这次用多热的口吻"。
 * 两件事正交，语料只需按性格写一份，槽位只改**语速/音高/句式偏好**。
 *
 * 三个槽：
 *   warm  暖 —— 刚失败过、深夜、连续被夸。这时候讲效率是没人听的。
 *   neutral 中 —— 默认。绝大多数时间在这一档，所以它必须最省事。
 *   cool  冷 —— 用户连续成功、在赶工、开着 Max。废话少一点，别抢时间。
 *
 * 关键设计：**带滞回**。槽位如果每次判定都随输入抖动，声音会忽快忽慢，
 * 听感上比一直用一个温度更糟。所以换槽有最小间隔，且"回暖"比"转冷"更难
 * （坏心情容易进去，不容易出来 —— 这也是真实对话里的样子）。
 */
export const SLOTS = Object.freeze({
  warm: Object.freeze({ id: "warm", name: "温和", rate: 0.97, pitch: 1.03, minHoldMs: 90_000 }),
  neutral: Object.freeze({ id: "neutral", name: "平常", rate: 1.0, pitch: 1.0, minHoldMs: 60_000 }),
  cool: Object.freeze({ id: "cool", name: "利落", rate: 1.03, pitch: 0.98, minHoldMs: 60_000 }),
});

/* 判定顺序即优先级：先看"人怎么样了"，再看"机器忙不忙"。
 * 顺序反了会出现"用户在深夜连着失败，AI 却因为开着 Max 而说话很利落"这种串味。 */
const ORDER = Object.freeze(["warm", "cool", "neutral"]);

function num(v, d) {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

/**
 * 只算"该去哪个槽"，不管滞回。纯函数，便于单测。
 * @param {{hour?:number, failStreak?:number, doneStreak?:number, maxMode?:boolean, stopped?:boolean, idleMin?:number}} ctx
 */
export function targetSlot(ctx = {}) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const hour = num(c.hour, 12);
  const fail = num(c.failStreak, 0);
  const done = num(c.doneStreak, 0);

  /* 深夜 → 暖。深夜的孤独感不是靠"信息密度"解决的。 */
  if (hour >= 23 || hour < 6) return { slot: "warm", reason: "深夜" };
  /* 连着失败 ≥2 次 → 暖。这时候任何效率话术都像在催。 */
  if (fail >= 2) return { slot: "warm", reason: `连续失败 ${fail} 次` };
  /* 急停 / 正在收尾 → 冷。出事的时候要短句。 */
  if (c.stopped === true) return { slot: "cool", reason: "急停中" };
  /* 连着一串成功、或开着 Max 赶工 → 冷。 */
  if (done >= 3) return { slot: "cool", reason: `连续完成 ${done} 次` };
  if (c.maxMode === true) return { slot: "cool", reason: "Max 模式" };
  return { slot: "neutral", reason: "常态" };
}

export function createPersonaSlots(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  let slot = SLOTS.neutral.id;
  let since = now();
  let reason = "常态";
  const history = [];
  let flips = 0, held = 0;

  /**
   * 判定并（可能）换槽。
   * @returns {{slot:string, name:string, rate:number, pitch:number, changed:boolean, reason:string, heldBy:string}}
   */
  function update(ctx = {}) {
    const t = targetSlot(ctx);
    const hold = SLOTS[slot].minHoldMs;
    const age = now() - since;
    const r = { ...SLOTS[slot] };

    if (t.slot === slot) {
      reason = t.reason;
      return { slot, name: r.name, rate: r.rate, pitch: r.pitch, changed: false, reason, heldBy: "" };
    }

    /* 滞回：刚换过槽，且要去的不是"更急"的方向（暖），就先按住。
     * 为什么暖可以破例：用户刚失败时如果还在"利落"档里说话，
     * 那一句会显得很不合时宜 —— 这种时候听觉一致性得让人。 */
    const urgent = t.slot === "warm" && ORDER.indexOf(t.slot) < ORDER.indexOf(slot);
    if (age < hold && !urgent) {
      held++;
      return { slot, name: r.name, rate: r.rate, pitch: r.pitch, changed: false, reason, heldBy: t.slot };
    }

    flips++;
    slot = t.slot;
    since = now();
    reason = t.reason;
    history.push({ at: since, slot, reason });
    if (history.length > 50) history.shift();
    const n = SLOTS[slot];
    return { slot, name: n.name, rate: n.rate, pitch: n.pitch, changed: true, reason, heldBy: "" };
  }

  function stats() {
    return { slot, name: SLOTS[slot].name, reason, since, flips, held, recent: history.slice(-10) };
  }

  function reset() {
    slot = SLOTS.neutral.id; since = now(); reason = "常态"; flips = 0; held = 0; history.length = 0;
    return { ok: true };
  }

  return { update, stats, reset, target: targetSlot };
}
