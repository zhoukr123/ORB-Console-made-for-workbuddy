/* P2 · 站点适配器：capability 表 + actionGate 闸门 + 通用兜底。
 *
 * 对应《综合性方案》§3.4 / §5 桥接② / §6 P2。
 * 红线：结构化优先；置信不足才升视觉；视觉只决策、绝不点坐标。
 *
 * 与 ORB 既有 siteLibrary.mjs 的关系：那个解决「名称 → 官网」的解析；
 * 本表解决「该站点哪个动作能结构化执行」，二者正交，不重复。
 *
 * 2026-11-07 规模化：从 4 个样例扩到 china-top1000-websites.csv 前 226 站真实域名。
 * 真相源移到 siteCapabilityData.mjs（内联 226 条，打包自包含）；这里只做装配。
 * 红线不变：只有 4 个已核实站点带 api/dom 动作，其余一律 channel:"url" 的通用
 * 搜索模板 + verified:false，绝不生成未核实的 DOM 选择器或站内 API 端点。
 */
import { buildCapabilityTable, SITE_STATS, DEEP_ADAPTED_SITES } from "./siteCapabilityData.mjs";

export const CHANNELS = Object.freeze({
  url: "URL query 直开结果页（A 口径）",
  api: "站点数据 API 直取（B/F2）",
  dom: "自有窗口 DOM 选择器（B/F3）",
  synthetic: "合成输入（B/F4）",
  extract: "页面内通用结构化抽取（L1，零外发）",
  vision: "视觉建闸（只决策，不点坐标）",
  no_go: "不可结构化，拒绝",
});

/** capability 表：站点 → 动作 → 可执行通道与验收判据。
 * 由 siteCapabilityData.mjs 生成：226 站真实域名，4 个已核实深度站点原样保留。 */
export const SITE_CAPABILITIES = Object.freeze(buildCapabilityTable());
export { SITE_STATS, DEEP_ADAPTED_SITES };

export const GENERIC_FALLBACK = Object.freeze({
  channel: "vision",
  note: "未登记站点：只做通用兜底（打开结果页 + 视觉决策），不猜 DOM 选择器",
  forbid: ["硬编码选择器", "视觉点坐标", "不可逆动作"],
});

const STRUCTURED = new Set(["url", "api", "dom", "synthetic"]);
export const CONFIDENCE_THRESHOLD = 0.75;

/**
 * actionGate：动作执行前的闸门。
 * @returns {{allowed:boolean, channel:string, reason:string, plan?:object, deny?:string[]}}
 */
export function actionGate({ site, action, confidence = 1, claimedChannel } = {}) {
  // L1 页面内通用抽取：对任意站点可用、零外发、只决策不点坐标，故不受站点注册限制。
  // 这是豁免「未登记站点只走兜底」的红線例外——因为它不取数、不点坐标、不外发任何凭据。
  if (action === "extract_page") {
    if (claimedChannel && claimedChannel !== "extract" && STRUCTURED.has(claimedChannel)) {
      return { allowed: false, channel: "no_go", reason: "声明通道与 extract_page 不符", deny: ["不得绕过 actionGate"] };
    }
    return {
      allowed: true, channel: "extract",
      reason: "L1 通用抽取：页面内只读结构化数据，零外发",
      plan: { channel: "extract", verify: "页面结构化字段（JSON-LD/meta/表格）回读非空" },
      forbid: ["视觉点坐标", "外发凭据"],
    };
  }

  const entry = SITE_CAPABILITIES[String(site || "").trim()];
  if (!entry) {
    return {
      allowed: true, channel: "vision", reason: "站点未登记，走通用兜底",
      plan: { ...GENERIC_FALLBACK }, deny: GENERIC_FALLBACK.forbid.slice(),
    };
  }
  const spec = entry.actions[action];
  if (!spec) {
    return { allowed: false, channel: "no_go", reason: "该站点未登记此动作", deny: ["未登记动作不得盲试"] };
  }

  // 调用方不得自称用了更强的通道（防绕过闸门）
  if (claimedChannel && claimedChannel !== spec.channel && STRUCTURED.has(claimedChannel)) {
    return { allowed: false, channel: "no_go", reason: "声明通道与 capability 表不符", deny: ["不得绕过 actionGate"] };
  }

  if (spec.channel === "no_go") {
    return { allowed: false, channel: "no_go", reason: "C 口径：客户端内不可结构化", deny: ["桌面客户端内直控"] };
  }

  // 结构化置信不足 → 升视觉建闸（仍只决策）
  if (typeof confidence === "number" && confidence < CONFIDENCE_THRESHOLD) {
    return {
      allowed: true, channel: "vision", reason: `结构化置信 ${confidence} < ${CONFIDENCE_THRESHOLD}，升视觉决策`,
      plan: { ...spec, escalateFrom: spec.channel, forbid: ["视觉点坐标"] },
      deny: ["视觉点坐标"],
    };
  }

  return { allowed: true, channel: spec.channel, reason: `capability 命中：${entry.category}/${action}`, plan: { ...spec } };
}

/** 视觉建闸的核心断言：视觉只允许输出决策，不得携带坐标。 */
export function assertVisionDecisionOnly(decision = {}) {
  const bad = [];
  for (const k of ["x", "y", "coordinates", "point", "clickAt", "bbox"]) {
    if (decision[k] != null) bad.push(k);
  }
  if (Array.isArray(decision.clicks) && decision.clicks.length) bad.push("clicks");
  return {
    ok: bad.length === 0,
    bad,
    reason: bad.length ? "视觉输出含坐标/点击，违反「只决策不点坐标」红线" : "纯决策，交由确定性 DOM 选择器落点",
  };
}

export const INJECTABLE_ADAPTER_RULE = Object.freeze([
  "动作执行前先查 capability 表；未登记站点只走通用兜底，不猜 DOM 选择器。",
  "结构化通道优先（url/api/dom/synthetic）；置信不足才升视觉建闸。",
  "视觉只做决策、绝不输出坐标或点击；落点一律交给确定性 DOM 选择器。",
  "桌面客户端内直控（C 口径）一律 no_go，改走网页版 + 适配器。",
]);

export default {
  CHANNELS, SITE_CAPABILITIES, GENERIC_FALLBACK, CONFIDENCE_THRESHOLD,
  actionGate, assertVisionDecisionOnly, INJECTABLE_ADAPTER_RULE,
};
