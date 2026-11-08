/* 外部检索 REST 的可测试逻辑层：默认关闭、凭证绝不外泄、失败绝不静默回落到截图/视觉循环。
 * 只取 snippet/summary，请求体 need_content 恒为 false，避免正文 token 膨胀。
 * 对外结果遵循统一 schema，search 永远不抛异常（失败一律降级返回）。零 npm 依赖。
 *
 * 2026-11-06：厂商差异收敛到 searchProviderAdapters.mjs。默认 adapter 仍是 deepseek，
 * 请求/响应形状与既有 19 条单测完全一致；换 provider 只改 adapter，不动本文件的护栏。 */
import { getAdapter, DEFAULT_ADAPTER_ID } from "./searchProviderAdapters.mjs";

export const SEARCH_SCHEMA_VERSION = 1;

const PROVIDER = "external-rest";
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 50;
const MAX_QUERY_LEN = 128;
const SNIPPET_MAX = 500;

function toStr(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : String(v);
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

/* 把 apiKey 从任何对外文本里抹掉，防御上游回显或异常信息夹带凭证。 */
function scrub(s, key) {
  if (!key || !s) return s;
  return s.split(key).join("[redacted]");
}

function isHttpUrl(u) {
  if (!u) return false;
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:";
  } catch {
    return false;
  }
}

function hostOf(u) {
  try {
    return new URL(u).hostname || PROVIDER;
  } catch {
    return PROVIDER;
  }
}

function isAbortError(err) {
  const name = err && typeof err.name === "string" ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = err && typeof err.message === "string" ? err.message : "";
  return /abort|timed?\s*out|timeout/i.test(msg);
}

function is2xx(status) {
  return status >= 200 && status < 300;
}

/* 优先用 AbortSignal.timeout；老环境退到等价的 AbortController + 定时器（unref 不阻塞退出）。 */
function makeTimeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      return AbortSignal.timeout(ms);
    }
  } catch {
    // 落到下面的等价实现
  }
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms);
  if (t && typeof t.unref === "function") t.unref();
  return ctrl.signal;
}

function respStatus(resp) {
  if (!resp || typeof resp !== "object") return 0;
  const s = Number(resp.status);
  if (Number.isFinite(s) && s > 0) return s;
  return resp.ok === true ? 200 : 0;
}

export function createSearchProvider(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};

  /* 默认关闭且只认字面 true，杜绝配置误开导致偷偷发请求。 */
  const enabled = o.enabled === true;
  /* 未登记 / 拼错的 provider 一律回落到 deepseek，绝不猜一个「看起来可用」的。 */
  const adapter = getAdapter(o.adapter) || getAdapter(DEFAULT_ADAPTER_ID);
  const endpoint = typeof o.endpoint === "string" && o.endpoint ? o.endpoint : adapter.endpoint;
  const apiKey = typeof o.apiKey === "string" ? o.apiKey : "";
  const hasKey = apiKey.trim().length > 0;
  /* 可选「模型 / 引擎」名：由主进程启动桥时注入 ORB_SEARCH_MODEL。
     deepseek 检索端点没有这一项，会如实忽略；不进 config（既有五键契约不动）。 */
  const model = typeof o.model === "string" ? o.model.trim().slice(0, 120) : "";

  const t = Number(o.timeoutMs);
  const timeoutMs = Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;

  const m = Number(o.maxResults);
  const maxResults = Number.isFinite(m) && m >= 1
    ? Math.min(MAX_RESULTS_CAP, Math.floor(m)) : DEFAULT_MAX_RESULTS;

  const clock = typeof o.clock === "function" ? o.clock : Date.now;
  const fetchImpl = typeof o.fetchImpl === "function"
    ? o.fetchImpl
    : (typeof globalThis.fetch === "function"
        ? globalThis.fetch
        : async function () { throw new Error("fetch unavailable"); });

  let requests = 0;
  let succeeded = 0;
  let failed = 0;
  const byReason = Object.create(null);

  function safeClock() {
    try {
      const v = Number(clock());
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  function elapsed(started) {
    const d = safeClock() - started;
    return Number.isFinite(d) && d >= 0 ? d : 0;
  }

  /* 统一 schema：字段固定，noVisionFallback 恒为 true，绝不携带错误文本或凭证。 */
  function result(ok, results, degraded, reasonCode, started) {
    return {
      ok,
      results,
      degraded,
      reasonCode,
      provider: PROVIDER,
      elapsedMs: elapsed(started),
      noVisionFallback: true,
      schemaVersion: SEARCH_SCHEMA_VERSION,
    };
  }

  function failCounted(code, started) {
    failed++;
    byReason[code] = (byReason[code] || 0) + 1;
    return result(false, [], true, code, started);
  }

  function failFromThrown(err, started) {
    return failCounted(isAbortError(err) ? "timeout" : "http-error", started);
  }

  function normalizeItem(item) {
    if (!item || typeof item !== "object") return null;
    const url = typeof item.url === "string" ? item.url.trim() : "";
    if (!isHttpUrl(url)) return null;
    const title = scrub(toStr(item.title), apiKey);
    let snip = typeof item.snippet === "string" && item.snippet.length
      ? item.snippet : toStr(item.summary);
    snip = clip(scrub(snip, apiKey), SNIPPET_MAX);
    const src = toStr(item.source).trim();
    /* source 是「来源名」：厂商给了就过一遍脱敏；没给就回退 url 的 host。
       注意 host 不能再过 scrub —— 它是从已解析 URL 里取的主机名、本身不含路径或参数，
       而 scrub 的 URL 正则会把它打成 [link]，真实跑 AnySearch 时 www.yzsj.net
       就这么变成过「[link]」（2026-11-06 实测发现）。 */
    const source = src ? scrub(src, apiKey) : hostOf(url);
    return { title, url: scrub(url, apiKey), snippet: snip, source };
  }

  function normalizeAll(raw) {
    const out = [];
    for (const item of raw) {
      const r = normalizeItem(item);
      if (r) out.push(r);
      if (out.length >= maxResults) break;
    }
    return out;
  }

  function doFetch(q, signal) {
    return fetchImpl(endpoint, {
      method: "POST",
      /* 请求头与请求体由 adapter 生成；key 只在这里进 header，绝不进 body 或返回值。 */
      headers: adapter.headers(apiKey),
      /* 各厂商自己的形状；deepseek 恒带 need_content:false，避免正文 token 膨胀。 */
      body: JSON.stringify(adapter.buildBody(q, maxResults, model)),
      signal,
    });
  }

  async function search(query, ctx = {}) {
    const started = safeClock();

    /* 守卫分支：绝不发请求，也不计入 stats。ctx 预留给调用方（预算/追踪），当前不参与判定。 */
    if (!enabled) return result(false, [], true, "provider-disabled", started);
    /* 只有 anonymous=true 的 adapter（AnySearch / 自定义）允许无 key：
       官方文档写明该端点 API key 可选，不填时按匿名免费额度调用。
       其余厂商无 key 一律 no-credential，绝不裸发一个没有鉴权的请求。 */
    if (!hasKey && adapter.anonymous !== true) return result(false, [], true, "no-credential", started);
    /* 非字符串、纯空白或原始长度超 128 都视为坏 query；长度按原始串判定。 */
    const q = typeof query === "string" ? query : "";
    if (q.trim().length === 0 || q.length > MAX_QUERY_LEN) {
      return result(false, [], true, "bad-query", started);
    }

    /* 来到这里表示将真实发出一次搜索。 */
    requests++;
    try {
      const signal = makeTimeoutSignal(timeoutMs);
      let resp;
      try {
        resp = await doFetch(q, signal);
      } catch (err) {
        if (signal && signal.aborted) return failCounted("timeout", started);
        return failFromThrown(err, started);
      }
      if (signal && signal.aborted) return failCounted("timeout", started);

      const status = respStatus(resp);
      if (status === 429) return failCounted("rate-limited", started);
      if (!is2xx(status)) return failCounted("http-error", started);

      let payload;
      try {
        payload = await resp.json();
      } catch (err) {
        if (isAbortError(err)) return failCounted("timeout", started);
        return failCounted("bad-json", started);
      }

      /* adapter 把厂商响应统一投影成 {title,url,snippet,source}[]；
         形状不对 / 空数组都走同一条 empty-results 降级，绝不编造。 */
      const raw = adapter.parse(payload);
      if (!raw.length) return failCounted("empty-results", started);

      const results = normalizeAll(raw);
      succeeded++;
      return result(true, results, false, "", started);
    } catch {
      /* 兜底：任何未预期异常都降级且计数一致，绝不向外抛出，也不实现任何视觉回落。 */
      return failCounted("http-error", started);
    }
  }

  function stats() {
    return { requests, succeeded, failed, byReason: { ...byReason } };
  }

  /* 只暴露脱敏配置，绝不返回 apiKey，也不新增字段（既有契约锁定为五键）。
     厂商差异只体现在请求体/响应解析，不进 config；桥侧 /api/search/status 另报
     当前 provider 与可选清单，避免同一信息两处维护。 */
  function config() {
    return { enabled, endpoint, timeoutMs, maxResults, hasKey };
  }

  return { search, stats, config };
}
