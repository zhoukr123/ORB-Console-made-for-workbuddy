/* 报告B §7 批次B 第8项：V-06 **L4 契约层**。
 *
 * 只做契约，不接 provider、不发任何网络请求、不回落视觉。
 * 报告保留项：统一 schema + `not_available` + `reasonCode` + 开窗原语。
 * 现有 searchProvider.mjs 是 provider 内部 schema v1（自带分级拒因），
 * 这一层在 /api/search 边界把它规范化成对外 L4 v2：
 *   · 「能力不可用」(默认关闭 / 无凭据) 统一成 not_available，
 *     原始原因放 detail，避免对外泄露配置细节或凭据；
 *   · 业务失败一律 degraded:true + 固定 reasonCode，且不回落截图/视觉；
 *   · 字段集合固定，缺的补默认值，多的不透传（形状本身就是契约）。
 */
export const L4_SCHEMA_VERSION = 2;

export const L4_FIELDS = Object.freeze([
  "ok", "available", "results", "degraded", "reasonCode", "detail",
  "provider", "elapsedMs", "noVisionFallback", "schemaVersion",
]);

export const L4_REASON_CODES = Object.freeze({
  NOT_AVAILABLE: "not_available",
  BAD_QUERY: "bad-query",
  STOPPED: "stopped",
  REQUIRES_USER_AUTHORIZATION: "requires_user_authorization",
  TIMEOUT: "timeout",
  RATE_LIMITED: "rate-limited",
  HTTP_ERROR: "http-error",
  BAD_JSON: "bad-json",
  EMPTY_RESULTS: "empty-results",
});

/* provider 内部拒因 → 对外统一「能力不可用」。不放进 L4_REASON_CODES，
 * 免得有人误把它们当成对外契约的一部分。 */
const UNAVAILABLE_INTERNAL = Object.freeze([
  "provider-disabled", "no-credential", "not_available",
]);

function str(v, fallback = "") {
  const s = typeof v === "string" ? v : (v == null ? "" : String(v));
  return s || fallback;
}

/** 把任意 provider / 守卫分支的返回规范化成 L4 固定形状。 */
export function normalizeL4(r = {}, fallback = {}) {
  const src = r && typeof r === "object" ? r : {};
  const rawReason = str(src.reasonCode);
  const unavailable = UNAVAILABLE_INTERNAL.includes(rawReason) || src.available === false;
  const ok = src.ok === true && !unavailable;
  const reasonCode = ok ? "" : (unavailable ? L4_REASON_CODES.NOT_AVAILABLE : (rawReason || "unknown"));
  const results = Array.isArray(src.results) ? src.results : [];
  const elapsed = Number(src.elapsedMs);
  return {
    ok,
    available: !unavailable,
    results,
    degraded: src.degraded === true || !ok,
    reasonCode,
    /* 只在「能力不可用且内部原因确实存在差异」时留 detail；不含凭据、不含原始错误文本。 */
    detail: unavailable && rawReason && rawReason !== reasonCode
      ? rawReason
      : str(src.detail).slice(0, 64),
    provider: str(src.provider, str(fallback.provider, "external-rest")).slice(0, 64),
    elapsedMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0,
    noVisionFallback: true,
    schemaVersion: L4_SCHEMA_VERSION,
  };
}

/** 构造「能力不可用」的 L4 响应。 */
export function l4Unavailable(detail = "", extra = {}) {
  return normalizeL4({
    ...(extra && typeof extra === "object" ? extra : {}),
    ok: false, results: [], degraded: true, reasonCode: "not_available", detail,
  });
}

/** 给 /api/search/schema 用：只读契约自检，不暴露任何配置或凭据。 */
export function l4Schema() {
  return {
    schemaVersion: L4_SCHEMA_VERSION,
    fields: [...L4_FIELDS],
    reasonCodes: Object.values(L4_REASON_CODES),
    unavailableInternalCodes: [...UNAVAILABLE_INTERNAL],
    noVisionFallback: true,
    note: "L4 只上契约不接 provider；能力不可用统一 not_available，原始原因放 detail",
  };
}

export default { L4_SCHEMA_VERSION, L4_FIELDS, L4_REASON_CODES, normalizeL4, l4Unavailable, l4Schema };
