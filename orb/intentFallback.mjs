/* 意图兜底：schema 约束的「只能选、不能造」（2026-11-07）
 *
 * 确定性文法认不出时，只剩两条路：退回 Agent（慢几秒，但永远可用），或者问一次模型。
 * 这里实现第二条，但把它关在三个笼子里：
 *
 *   ① 只在 no-whitelist-match 触发 —— 文法明确认出了但拒绝的（表格、多行、超长）不兜底，
 *      那是刻意拒绝，不是能力不足；
 *   ② 输出只能落在动作表里 —— action 必须是 ACTIONS 的 key，sink 由表决定，
 *      query 必须是原句里已经存在的片段（子串校验）。模型只能"划重点"，不能"编内容"；
 *   ③ 任何一环不合规就放弃（fail-closed）—— 返回 null，调用方保持原来的拒绝。
 *      宁可让用户等 Agent 几秒，也不许把一个编出来的查询词当事实拿去检索。
 *
 * 这个模块不碰网络：llm 是注入进来的一行异步函数。这样它能被完整单测，
 * 也让"用哪个模型 / 走哪个 key"变成调用方的决定，而不是藏在解析层里。
 */
import {
  ACTIONS, MAX_QUERY_LEN, MAX_DOC_ENTRIES_LIMIT, normalizeText,
} from "./searchOrchestrator.mjs";

export const FALLBACK_CACHE_MAX = 128;

const ACTION_IDS = Object.freeze(Object.keys(ACTIONS));

/* 剥掉所有空白后的比较形式：模型常把「长沙 天气」重打成「长沙天气」，
 * 这种差异不算编造；除此之外的任何改动都不接受。 */
function squeeze(s) {
  return normalizeText(s).replace(/\s+/g, "");
}

/** 系统提示：把可选项和输出形状写死，其余一律不许发挥。 */
export function buildIntentSystemPrompt() {
  const actions = Object.values(ACTIONS).map((a) => ({
    action: a.id,
    sink: a.sink,
    targets: [...a.targets],
  }));
  return [
    "你是一个把中文指令解析成 JSON 的解析器。只输出 JSON，不要解释、不要代码块。",
    "任务：判断这句话是不是「先检索、再把结果落到某个产物」的指令；是则给出字段，否则给 null。",
    "硬约束：",
    "1. query 必须是从原句里原样摘出的片段，不许改写、不许补充、不许翻译；",
    "2. action 只能取给定的枚举值，sink 由枚举决定，不要自己编；",
    "3. count 只在用户明确说了条数时填（0 表示没说）；",
    "4. 拿不准就输出 {\"action\":null}，不要猜。",
    "可选项：",
    JSON.stringify(actions),
    '输出形状：{"action":"<枚举值>|null","query":"<原句片段>","count":<整数>}',
  ].join("\n");
}

export function buildIntentUserPrompt(text) {
  return "原句：" + String(text ?? "").slice(0, 200);
}

/** 从模型输出里取 JSON：容忍前面的废话和 ```json 包裹，取第一个 { 到最后一个 }。 */
export function extractJson(raw) {
  const s = String(raw ?? "");
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch { return null; }
}

/**
 * 校验模型输出。任一条件不满足就返回 null（fail-closed）。
 * @param {string} text 用户原句
 * @param {object} obj  模型输出的 JSON
 */
export function validateIntentResult(text, obj) {
  if (!obj || typeof obj !== "object") return null;
  if (obj.action == null) return null;
  const action = ACTIONS[String(obj.action)];
  if (!action) return null;

  const query = normalizeText(String(obj.query ?? "")).trim();
  if (!query || query.length > MAX_QUERY_LEN) return null;
  if (/[\r\n]/.test(query)) return null;
  /* 子串校验：查询词必须是原句里已经有的东西。
   * 这一条同时挡掉「补全」「翻译」「编一个更准确的说法」三种幻觉。 */
  if (!squeeze(text).includes(squeeze(query))) return null;

  const rawCount = Number(obj.count);
  const count = Number.isFinite(rawCount) && rawCount > 0
    ? Math.min(MAX_DOC_ENTRIES_LIMIT, Math.floor(rawCount))
    : 0;

  return {
    ok: true,
    query,
    action: action.id,
    sink: action.sink,
    format: action.formats[0],
    wantDoc: action.sink === "doc",
    count,
    note: "",
    route: "structured",
    via: "llm",
    zeroVlm: true, vlmCalls: 0, silent: true,
  };
}

/**
 * 建兜底器。
 * @param {object} opts
 * @param {(sys:string, usr:string)=>Promise<string>} opts.llm 注入的模型调用
 * @param {boolean} opts.enabled 关掉时不发任何外呼（默认关）
 * @param {number}  opts.cap 缓存条数
 */
export function createIntentFallback(opts = {}) {
  const enabled = opts.enabled === true;
  const llm = typeof opts.llm === "function" ? opts.llm : null;
  const cap = Math.max(1, Number(opts.cap) || FALLBACK_CACHE_MAX);
  /* key → { result | null, at }；null 也要缓存（负缓存），否则同一句认不出的话
     用户每敲一次就多打一次模型，延迟和花钱都翻倍。 */
  const cache = new Map();
  const stat = { calls: 0, hits: 0, negHits: 0, errors: 0, accepted: 0, rejected: 0 };

  function remember(key, result) {
    cache.set(key, { result, at: Date.now() });
    if (cache.size > cap) {
      /* 简单 LRU：Map 的插入顺序即使用顺序，超限删最早的一条。 */
      const first = cache.keys().next();
      if (!first.done) cache.delete(first.value);
    }
  }

  async function resolve(text, now = Date.now()) {
    if (!enabled || !llm) return null;
    const key = squeeze(text);
    if (!key) return null;
    if (cache.has(key)) {
      const hit = cache.get(key);
      /* 命中即刷新顺序（LRU 语义） */
      cache.delete(key);
      cache.set(key, hit);
      if (hit.result) { stat.hits++; return hit.result; }
      stat.negHits++;
      return null;
    }
    stat.calls++;
    let raw = "";
    try {
      raw = await llm(buildIntentSystemPrompt(), buildIntentUserPrompt(text));
    } catch {
      stat.errors++;
      /* 失败不写负缓存：网络抖动不该让同一句话永久失效。 */
      return null;
    }
    const result = validateIntentResult(text, extractJson(raw));
    remember(key, result);
    if (result) stat.accepted++; else stat.rejected++;
    return result;
  }

  return {
    enabled, resolve, stat,
    get size() { return cache.size; },
    clear() { cache.clear(); },
  };
}

/** 该不该兜底：只兜「文法没认出来」这一种。 */
export function needsFallback(parseResult) {
  const rc = parseResult && parseResult.reasonCode;
  return rc === "no-whitelist-match";
}

export default {
  FALLBACK_CACHE_MAX, buildIntentSystemPrompt, buildIntentUserPrompt,
  extractJson, validateIntentResult, createIntentFallback, needsFallback, ACTION_IDS,
};
