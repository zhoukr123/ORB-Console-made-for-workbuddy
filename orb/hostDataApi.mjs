/* API 通道宿主侧实现：补齐《综合性方案》§3.2 的唯一功能缺口。
 *
 * 背景：wb_ext_027 v0.2.7 的 dispatch 方法表**无任何网络请求方法**，
 * 所以 B站 / 东财 / 腾讯 / 新浪 / GitHub / Open-Meteo 的数据 API 直取不能在扩展内跑，
 * 必须由宿主承接。
 *
 * 端点清单来源（L2 单一真源）：
 *   - 优先读取同目录 api-endpoints.json（verify-endpoints 工具会回写 verified / last_verified）；
 *   - 读不到时回退 INLINE_ENDPOINTS（仅 2 个核心端点），保证降级可用。
 *
 * 约定沿用 ORB searchProvider.mjs：
 *   - enabled === true 才启用（默认关，杜绝配置误开偷偷发请求）
 *   - fetchImpl 可注入（测试不真发网络）
 *   - 固定错误码 + 超时 + 上限
 *
 * 安全红线（与扩展侧 site_api.js 镜像逐字段交叉断言一致）：
 *   - endpoint 只认登记白名单，禁止任意 URL（SSRF）
 *   - 只准 https、禁 loopback/内网/元数据/非443端口
 *   - 仅透传登记参数名，杜绝参数走私/凭据注入
 *   - 未核实端点一律失败关闭（endpoint-unverified），对抗端点腐烂
 *   - 响应体有大小上限，解析失败不谎报成功
 *   - GBK 等编码按声明解码；delimited 文本按声明规则抽取，绝不把原始脏字符串当 JSON
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SITE_CAPABILITIES } from "./p2SiteAdapter.mjs";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;

/** 内联兜底：仅 2 个核心端点。JSON 读不到时的安全快照（verify 工具只写 JSON，不写这里）。 */
const INLINE_ENDPOINTS = Object.freeze({
  endpoints: {
    "bilibili.com/search_uploader": {
      url: "https://api.bilibili.com/x/web-interface/search/all/v2",
      method: "GET", params: ["keyword"], channel: "api",
      label: "B 站 UP 主搜索", category: "影音/媒体", verified: true, last_verified: "2026-11-07",
      upstreamCode: { field: "code", ok: 0 },
      response: { kind: "json", pick: "data.result", pickBlock: { matchKey: "result_type", matchValue: "bili_user", dataField: "data" } },
    },
    "eastmoney.com/read_quote": {
      url: "https://push2.eastmoney.com/api/qt/stock/get",
      method: "GET", params: ["secid", "fields"], channel: "api",
      label: "东方财富行情", category: "金融/投资", verified: true, last_verified: "2026-11-07",
      response: { kind: "json", pick: "data" },
    },
  },
  defaults: {
    timeoutMs: DEFAULT_TIMEOUT_MS, maxBytes: MAX_BYTES, encoding: "utf-8",
    headers: { Accept: "application/json", "User-Agent": "ORB-HostDataApi/1.0" },
  },
});

/** 把声明式端点（来自 JSON 或内联）归一化成内部 spec。
 * 关键点：把 response.pick / response.pickBlock 摊平到顶层，
 * 以便与扩展侧 site_api.js 镜像的 url/params/pick/pickBlock/label 交叉断言一致。 */
function normalize(raw = {}) {
  const defaults = raw.defaults || INLINE_ENDPOINTS.defaults;
  const out = {};
  for (const [key, e] of Object.entries(raw.endpoints || {})) {
    const resp = e.response || {};
    const isDelimited = resp.kind === "delimited";
    out[key] = Object.freeze({
      url: e.url,
      method: (e.method || "GET").toUpperCase(),
      params: Object.freeze([...(e.params || [])]),
      channel: e.channel || "api",
      label: e.label || key,
      category: e.category || "",
      verified: e.verified === true,
      lastVerified: e.last_verified || null,
      encoding: e.encoding || defaults.encoding || "utf-8",
      headers: e.headers ? Object.assign({}, defaults.headers, e.headers) : Object.assign({}, defaults.headers),
      kind: isDelimited ? "delimited" : "json",
      // 交叉断言需要顶层 pick/pickBlock：delimited 端点置 null（扩展镜像同样置 null）
      pick: isDelimited ? null : (resp.pick ?? ""),
      pickBlock: isDelimited ? null : (resp.pickBlock ? Object.freeze(resp.pickBlock) : null),
      delimited: isDelimited ? Object.freeze({
        extract: resp.extract || null,
        delimiter: resp.delimiter || "",
        fields: Object.freeze(resp.fields || {}),
        numeric: Object.freeze(resp.numeric || []),
      }) : null,
      upstreamCode: e.upstreamCode ? Object.freeze(e.upstreamCode) : null,
    });
  }
  return Object.freeze(out);
}

function loadEndpoints() {
  try {
    const p = fileURLToPath(new URL("./api-endpoints.json", import.meta.url));
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return normalize(raw);
  } catch {
    return normalize(INLINE_ENDPOINTS);
  }
}

/** 声明式端点白名单（L2 单一真源经加载归一化后的内部形态）。key = "site/action"。 */
export const API_ENDPOINTS = loadEndpoints();

/** 端点清单（key + 人话名 + 核实状态），给桥的状态接口与扩展面板消费。 */
export function listEndpoints() {
  return Object.keys(API_ENDPOINTS).map((key) => ({
    key,
    label: API_ENDPOINTS[key].label,
    category: API_ENDPOINTS[key].category,
    verified: API_ENDPOINTS[key].verified,
    last_verified: API_ENDPOINTS[key].lastVerified,
  }));
}

function isSafeUrl(u) {
  let p;
  try { p = new URL(u); } catch { return false; }
  if (p.protocol !== "https:") return false;
  if (p.username || p.password) return false;
  const h = p.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return false;
  if (h === "169.254.169.254" || h.endsWith(".internal") || h.endsWith(".local")) return false;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (p.port && p.port !== "443") return false;
  return true;
}

function pickPath(obj, path) {
  let cur = obj;
  for (const seg of String(path || "").split(".").filter(Boolean)) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function createHostDataApi({
  enabled = false,
  fetchImpl = typeof globalThis.fetch === "function" ? globalThis.fetch : null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_BYTES,
  clock = Date.now,
} = {}) {
  const enabledOn = enabled === true;
  const t = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  const cap = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_BYTES;
  const stats = { calls: 0, succeeded: 0, failed: 0, byReason: Object.create(null) };

  function fail(code, started) {
    stats.failed++;
    stats.byReason[code] = (stats.byReason[code] || 0) + 1;
    return { ok: false, code, data: null, evidence: null, elapsedMs: clock() - started };
  }

  /** 按 capability 的 api 通道取数。site/action 必须命中白名单且已核实。 */
  async function fetchSiteData({ site, action, params = {} } = {}) {
    const started = clock();
    stats.calls++;
    if (!enabledOn) return fail("disabled", started);
    if (typeof fetchImpl !== "function") return fail("no-fetch", started);

    const key = `${site}/${action}`;
    const spec = API_ENDPOINTS[key];
    const capEntry = SITE_CAPABILITIES[site];
    if (!spec || !capEntry || capEntry.actions[action]?.channel !== "api") {
      return fail("endpoint-not-allowlisted", started);
    }
    // 未核实端点一律失败关闭：端点腐烂（开始要 Cookie / 改形状 / 403）后自动降级，绝不以空/错数据冒充成功
    if (spec.verified !== true) return fail("endpoint-unverified", started);
    if (!isSafeUrl(spec.url)) return fail("unsafe-endpoint", started);
    // capability 表里的 endpoint 可能是裸域名，先补 https 再解析；解析不了按字符串包含比对，绝不抛异常
    const capRaw = String(capEntry.actions[action].endpoint || "");
    if (capRaw) {
      let capHost = "";
      try { capHost = new URL(capRaw.includes("://") ? capRaw : `https://${capRaw}`).hostname; }
      catch { capHost = capRaw.split("/")[0].split(":")[0]; }
      if (capHost && !spec.url.includes(capHost)) return fail("endpoint-mismatch", started);
    }

    // 先把声明 URL 中的 {param} 模板占位符替换为实参（腾讯 q={code} / 新浪 list={code} /
    // GitHub {user}/{kw}/{n} / Open-Meteo {lat}/{lon}）。这一步缺了会让 {code} 原样发给上游，
    // 表现为「端点腐烂式失败」：腾讯/新浪拿到错误符号、GitHub get_user/Open-Meteo 直接 404/400。
    let urlStr = spec.url;
    for (const k of spec.params) {
      if (params[k] != null) {
        urlStr = urlStr.replace(new RegExp("\\{" + k + "\\}", "g"), encodeURIComponent(String(params[k])));
      }
    }
    // 仍残留未填充的模板占位符 → 参数缺失，直接失败，不拿脏 URL 发请求
    if (/\{[a-zA-Z_][\w-]*\}/.test(urlStr)) return fail("missing-param", started);

    // 非模板参数（如东财 secid/fields）走 query string
    const u = new URL(urlStr);
    for (const k of spec.params) {
      if (params[k] != null && !spec.url.includes(`{${k}}`)) {
        u.searchParams.set(k, String(params[k]));
      }
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), t);
    try {
      const res = await fetchImpl(u.toString(), {
        method: spec.method,
        signal: ctrl.signal,
        headers: Object.assign({ Accept: "application/json" }, spec.headers),
      });
      if (!res || res.ok !== true) return fail("http-error", started);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > cap) return fail("oversize", started);
      // 按声明编码解码（GBK 等），而非默认 UTF-8，避免中文乱码/截断
      const text = new TextDecoder(spec.encoding || "utf-8").decode(buf);

      // —— delimited 文本型（腾讯/新浪行情）：绝不当 JSON 解析 ——
      if (spec.kind === "delimited") {
        let val = text;
        if (spec.delimited.extract) {
          const m = new RegExp(spec.delimited.extract).exec(text);
          if (!m) return fail("empty-data", started);
          val = m[1] != null ? m[1] : m[0];
        }
        const parts = val.split(spec.delimited.delimiter);
        const out = {};
        for (const [k, idx] of Object.entries(spec.delimited.fields)) {
          let v = parts[idx];
          if (v == null) { out[k] = null; continue; }
          if (spec.delimited.numeric && spec.delimited.numeric.includes(k)) v = Number(v);
          out[k] = v;
        }
        if (Object.keys(out).length === 0) return fail("empty-data", started);
        stats.succeeded++;
        return {
          ok: true, code: "ok", data: out,
          evidence: { level: "已核实", basis: `宿主 GET ${u.origin}${u.pathname} 回读非空格分结构(${spec.encoding})` },
          url: u.toString(), elapsedMs: clock() - started,
        };
      }

      // —— JSON 型（B站/东财/GitHub/Open-Meteo）——
      let json;
      try { json = JSON.parse(text); } catch { return fail("bad-json", started); }
      /* 上游用 200 包着业务错误码（如 {"code":-412}）时必须当失败，
         否则会拿空数组冒充"查到了但没结果"。仅当声明了 upstreamCode 才检查。 */
      if (spec.upstreamCode && typeof json[spec.upstreamCode.field] === "number" && json[spec.upstreamCode.field] !== spec.upstreamCode.ok) {
        return fail("upstream-code:" + json[spec.upstreamCode.field], started);
      }
      let picked = pickPath(json, spec.pick);
      if (spec.pickBlock && Array.isArray(picked)) {
        const b = picked.find((x) => x && x[spec.pickBlock.matchKey] === spec.pickBlock.matchValue);
        picked = b ? b[spec.pickBlock.dataField] : null;
      }
      if (picked == null) return fail("empty-data", started);

      stats.succeeded++;
      return {
        ok: true, code: "ok", data: picked,
        evidence: { level: "已核实", basis: `宿主 GET ${u.origin}${u.pathname} 回读非空` },
        url: u.toString(),
        elapsedMs: clock() - started,
      };
    } catch (err) {
      return fail(err && err.name === "AbortError" ? "timeout" : "network-error", started);
    } finally {
      clearTimeout(timer);
    }
  }

  function getStats() { return { ...stats, byReason: { ...stats.byReason } }; }
  return { fetchSiteData, getStats, get enabled() { return enabledOn; } };
}

export default { API_ENDPOINTS, createHostDataApi };
