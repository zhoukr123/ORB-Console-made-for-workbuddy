/* 报告B §7 批次A 第 5、6 项 —— 纪律层纯函数（单一真相源）。
 *
 * 这一层**不重造底座**：textGate / costLedger / capabilityRegistry / workerPool
 * 都已实装，缺的是「统一的判定口径 + 可证伪的埋点形状」。
 * 所有导出都是纯函数或冻结常量；bridge.mjs 持实例接线，
 * panel.html 只消费字段、不复制判定逻辑（一致性由 batchA.test.mjs 静态锁住）。
 *
 * 对应报告：
 *   §7 第5项  V-11 三入口 / V-09 零 VLM / V-10 检索不进豁免 + 域名授权
 *   §7 第6项  V-01 回落 degraded+reasonCode / V-12 三条架构契约
 *   §10.2     「把降级从隐式失败变成显式分支」
 */
import { isStopExempt, CAPABILITIES } from "./capabilityRegistry.mjs";

/* ───────── V-11：三入口的唯一合法来源标签 ───────── */
export const UNTRUSTED_SOURCES = Object.freeze(["transcript", "ocr", "webpage"]);

export function isUntrustedSource(source) {
  return UNTRUSTED_SOURCES.includes(String(source || ""));
}

/* ───────── V-10：检索一律不进急停豁免 ─────────
 * capabilityRegistry 的判定本来就是「未登记一律 false」（fail-closed），
 * 这里把「检索类」点名成一份可测清单，防止将来有人往 CAPABILITIES
 * 加一行 search 就静默破防。登记 readOnly ≠ 登记 stopExempt。 */
export const SEARCH_LIKE_KEYS = Object.freeze([
  "windows|Scrape", "windows|Search",
  "browser|dom.get_text", "browser|dom.get_page_text", "browser|tab.goto",
  "workbuddy|workbuddy_search",
]);

export function isSearchLike(server, tool) {
  return SEARCH_LIKE_KEYS.includes(`${server}|${tool}`);
}

export function searchExemptAudit() {
  const violated = SEARCH_LIKE_KEYS.filter((k) => {
    const [server, tool] = k.split("|");
    return isStopExempt(server, tool);
  });
  return {
    checkedKeys: [...SEARCH_LIKE_KEYS],
    violated,
    ok: violated.length === 0,
    capabilityCount: CAPABILITIES.length,
    note: "检索类一律不进急停豁免；登记只读不等于登记豁免",
  };
}

/* ───────── V-10：非白名单域名必须显式授权 ─────────
 * 默认空白名单 = 带 url 的请求一律拒绝（fail-closed）。
 * 放行名单由环境显式注入（bridge 的 ORB_SEARCH_HOSTS），代码里不硬塞站点。 */
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|\[::1\]|0\.|metadata\.|169\.|172\.(1[6-9]|2\d|3[01])\.)/i;

export function isPrivateHost(host) {
  return PRIVATE_HOST.test(String(host || "").toLowerCase());
}

export function authorizeDomain(url, allowedHosts = []) {
  const raw = String(url || "").trim();
  if (!raw) {
    /* 没带 url 就是纯 query 检索，不涉及域名授权。 */
    return { ok: true, reasonCode: "no-url", host: "", noVisionFallback: true };
  }
  let u;
  try { u = new URL(raw); } catch {
    return { ok: false, degraded: true, reasonCode: "requires_user_authorization", host: "", noVisionFallback: true, why: "不是合法 URL" };
  }
  const host = String(u.hostname || "").toLowerCase();
  const allow = (Array.isArray(allowedHosts) ? allowedHosts : [])
    .map((h) => String(h || "").trim().toLowerCase()).filter(Boolean);
  const hit = allow.some((h) => host === h || host.endsWith("." + h));
  const safe = u.protocol === "https:" && !isPrivateHost(host) && hit;
  if (!safe) {
    return {
      ok: false, degraded: true, reasonCode: "requires_user_authorization",
      host, noVisionFallback: true,
      why: u.protocol !== "https:" ? "只允许 https" : isPrivateHost(host) ? "内网/本机地址禁止" : "域名不在授权白名单",
    };
  }
  return { ok: true, degraded: false, reasonCode: "authorized", host, noVisionFallback: true };
}

/* ───────── V-01 回落：四类架构原因码（§10.2） ─────────
 * compileStructured 内部给的是形状判定（gui-intent / bad-shape / no-whitelist-match），
 * 这里统一映射到架构层原因码，回落路径必须带 degraded:true + reasonCode。 */
export const DEGRADE_CODES = Object.freeze({
  "compile-failed": "编译失败",
  "tool-indeterminate": "工具返回不可判定",
  "tree-incomplete": "树残缺",
  "needs-pixel-semantics": "真需像素语义",
});

const V01_TO_DEGRADE = Object.freeze({
  "gui-intent": "needs-pixel-semantics",
  "bad-shape": "compile-failed",
  "no-whitelist-match": "compile-failed",
  "tool-indeterminate": "tool-indeterminate",
  "tree-incomplete": "tree-incomplete",
  "needs-pixel-semantics": "needs-pixel-semantics",
});

export function classifyDegrade(v01Reason) {
  return V01_TO_DEGRADE[String(v01Reason || "")] || "compile-failed";
}

export function degradeRecord(v01Reason, stage = "v01-compile") {
  return Object.freeze({
    degraded: true,
    reasonCode: classifyDegrade(v01Reason),
    stage,
    v01Reason: String(v01Reason || ""),
    zeroVlm: false,
    noVisionFallback: false,
  });
}

/* ───────── V-09：结构化命中单的零 VLM 标记 ─────────
 * 带上它，costLedger.byRoute() 才能把「12 步→0 步 / 0 次 VLM」
 * 与「普通后台」分开报，报告 §6 的收益口径才可证伪。
 * 同时带 priority:'human'（V-12 人类优先名额的接线声明）。 */
export function structuredMarker(kind, guarded = null) {
  return Object.freeze({
    route: "structured",
    ruleId: "v01:" + String(kind || "unknown").slice(0, 48),
    zeroVlm: true,
    vlmCalls: 0,
    priority: "human",
    ...(guarded && typeof guarded === "object" ? { guarded } : {}),
  });
}

/* ───────── V-12：三条架构契约的现状声明 ─────────
 * 状态事件本就已接线，这里只做「不重复建设」的显式记录。 */
export const V12_CONTRACT = Object.freeze({
  humanPriority: Object.freeze({
    key: "human",
    base: "workerPool.PRIORITY.human + capacityFor 溢出 1 槽",
    wiredBy: "POST /api/dispatch priority",
  }),
  silentBackfill: Object.freeze({
    base: "onTaskDone({silent:true}) 短路播报，只更新统计",
    wiredBy: "runBack silentResult → job final",
  }),
  statusEvents: Object.freeze({
    base: "/api/events SSE + pushJobPartial/Final + /api/status",
    wiredBy: "已接线，无需重复建设",
  }),
});

export default {
  UNTRUSTED_SOURCES, isUntrustedSource,
  SEARCH_LIKE_KEYS, isSearchLike, searchExemptAudit,
  authorizeDomain, isPrivateHost,
  DEGRADE_CODES, classifyDegrade, degradeRecord,
  structuredMarker, V12_CONTRACT,
};
