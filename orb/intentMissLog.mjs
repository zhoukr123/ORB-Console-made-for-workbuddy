/* 意图未命中日志（2026-11-07 · 数据驱动扩词表）
 *
 * 确定性文法最大的风险不是「认错」，而是「认不出却没人知道」：用户说了一句本该走
 * 快速通道的话，解析器静静退回 Agent，用户等了几秒，没人记录 —— 词表就永远停在
 * 当初写它的那几十个词上。
 *
 * 这个模块只做一件事：把「没认出来的原句 + 原因码」按归一化后的同形聚合起来，
 * 让「该往词表里加什么」变成一个能查的数据问题，而不是靠猜。
 *
 * 边界（写死在实现里，不靠调用方自觉）：
 *   · 纯内存，不落盘、不外发 —— 这是用户的输入原文；
 *   · 环形缓冲有上限，满了淘汰最久未出现的，进程重启即清空；
 *   · 只记原句的截断副本（≤ 120 字）与归一化 key，不记任何上下文；
 *   · 同形聚合：`搜一下 X 然后画张图` 与 `搜一下 X，然后画张图` 归到一条，计数累加。
 */

export const MAX_MISS_ENTRIES = 200;
export const MAX_MISS_TEXT = 120;

/* 归一化 key：与解析器的规范化保持一致，另外去掉标点与所有空白、折叠大小写。
 * 为什么连空白都去掉：`搜一下 X 然后画张图` 与 `搜一下 X，然后画张图` 是同一个人
 * 同一个意思的不同打字方式，只有归到一条，计数才有意义（原句仍按原样保留在 text 里）。 */
export function missKey(text) {
  return String(text ?? "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .toLowerCase()
    .replace(/[，,。.；;！!？?：:、\u201C\u201D\u2018\u2019（）()【】\[\]「」『』《》]/g, "")
    .replace(/\s+/g, "");
}

/**
 * 建一个 miss 记录器。默认参数即可直接用；测试里可传入自己的上限。
 * 返回的对象是「一个进程一份」的实例，不含 IO。
 */
export function createMissLog(opts = {}) {
  const cap = Math.max(1, Number(opts.cap) || MAX_MISS_ENTRIES);
  /** key → { key, text, reasonCode, count, firstAt, lastAt } */
  const map = new Map();
  let total = 0;

  function record(text, reasonCode, now = Date.now()) {
    const raw = String(text ?? "").trim();
    if (!raw) return null;
    const key = missKey(raw);
    if (!key) return null;
    total++;
    const prev = map.get(key);
    if (prev) {
      prev.count++;
      prev.lastAt = now;
      /* 原因码可能变化（先 bad-query 后 no-whitelist-match）：以最新一次为准。 */
      if (reasonCode) prev.reasonCode = String(reasonCode);
      return prev;
    }
    const item = {
      key,
      text: raw.slice(0, MAX_MISS_TEXT),
      reasonCode: String(reasonCode || ""),
      count: 1,
      firstAt: now,
      lastAt: now,
    };
    map.set(key, item);
    /* 满了就淘汰「最不重要」的一条：先看出现次数，再看最后一次出现时间。
       只按时间淘汰会把反复出现的那句（正是最该扩词的）先挤掉。 */
    if (map.size > cap) {
      let victimKey = null;
      let victimCount = Infinity;
      let victimAt = Infinity;
      for (const [k, v] of map) {
        if (v.count < victimCount || (v.count === victimCount && v.lastAt < victimAt)) {
          victimCount = v.count; victimAt = v.lastAt; victimKey = k;
        }
      }
      if (victimKey) map.delete(victimKey);
    }
    return item;
  }

  function list(opt = {}) {
    const limit = Math.max(1, Number(opt.limit) || 50);
    return [...map.values()]
      .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
      .slice(0, limit)
      .map((v) => ({ ...v }));
  }

  function stats() {
    const byReason = {};
    for (const v of map.values()) {
      byReason[v.reasonCode || "unknown"] = (byReason[v.reasonCode || "unknown"] || 0) + v.count;
    }
    return { total, unique: map.size, cap, byReason };
  }

  function clear() { map.clear(); total = 0; }

  return { record, list, stats, clear, cap };
}

/* 桥接进程里共用的一份。纯内存、无副作用，import 即建。 */
export const missLog = createMissLog();

export default { MAX_MISS_ENTRIES, MAX_MISS_TEXT, missKey, createMissLog, missLog };
