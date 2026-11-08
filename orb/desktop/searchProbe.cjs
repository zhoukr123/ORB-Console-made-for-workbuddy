/* 检索工具「测试」按钮的纯逻辑（2026-11-06）。
 *
 * 边界：只做「拿 adapter + 发一次请求 + 把结果翻译成结论」，
 * 不 require electron / fs / vault，不读环境变量，因此可以在 node:test 里真跑。
 * 主进程负责提供 key（从 vault 读）与 adapter 模块（动态 import ESM 注册表）。
 *
 * 凭据红线：key 只作为入参出现，绝不进返回值、绝不进日志、绝不进 URL。
 * 返回体只带结论与首几条标题，不回传原始响应（可能很大，也可能含账号信息）。
 */
"use strict";

function str(v) {
  return typeof v === "string" ? v : (v == null ? "" : String(v));
}

function clip(v, n) {
  return str(v).slice(0, n);
}

/* 少数服务商会在错误信息里回显 Authorization（或 key 片段）。
 * detail 是要显示到面板上的，所以这里必须把 key 抹掉再返回 —— 否则
 * 「测试失败」会把凭据送到界面上，比不回传原始响应更糟。 */
function redact(text, key) {
  const s = str(text);
  const k = str(key).trim();
  if (k.length < 8) return s;
  return s.split(k).join("***");
}

/**
 * @param {object} opts
 * @param {object} opts.adapter      来自 searchProviderAdapters.mjs 的 adapter
 * @param {string} [opts.key]        API Key；匿名档可为空
 * @param {string} [opts.endpoint]   覆盖端点（自定义服务商用）
 * @param {string} [opts.model]      模型 / 引擎档位
 * @param {string} [opts.query]      测试用的 query
 * @param {number} [opts.count]      要几条（默认 3）
 * @param {number} [opts.timeoutMs]  默认 15000
 * @param {Function} [opts.fetchImpl] 测试注入用
 */
async function probe(opts = {}) {
  const adapter = opts.adapter;
  if (!adapter || typeof adapter.buildBody !== "function" || typeof adapter.parse !== "function") {
    return { ok: false, reasonCode: "adapter-missing", detail: "适配器不可用" };
  }

  const key = str(opts.key).trim();
  /* 与 searchProvider.mjs 同一条守卫：只有匿名档允许没有 key 就发。 */
  if (!key && adapter.anonymous !== true) {
    return { ok: false, reasonCode: "no-credential", detail: "这个服务商需要 API Key，先填一个再测试" };
  }

  const endpoint = str(opts.endpoint || adapter.endpoint);
  let u;
  try { u = new URL(endpoint); } catch { return { ok: false, reasonCode: "bad-endpoint", detail: "端点不是合法 URL" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reasonCode: "bad-endpoint", detail: "端点只允许 http(s)" };
  }

  const fetchImpl = typeof opts.fetchImpl === "function" ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    return { ok: false, reasonCode: "no-fetch", detail: "当前运行环境没有 fetch" };
  }

  const query = str(opts.query) || "ORB 检索工具连通性测试";
  const count = Math.max(1, Number(opts.count) || 3);
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 15000);
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const r = await fetchImpl(endpoint, {
      method: "POST",
      headers: adapter.headers(key),
      body: JSON.stringify(adapter.buildBody(query, count, opts.model)),
      signal: ac.signal,
    });
    const text = await r.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* 非 JSON：按状态码判 */ }
    const rows = payload ? (adapter.parse(payload) || []) : [];
    const elapsedMs = Date.now() - started;
    const notice = redact(
      payload && typeof payload === "object"
        ? clip(
          payload.message || payload.msg
          || (payload.error && (payload.error.message || payload.error)) || "",
          160,
        )
        : clip(text, 160),
      key,
    );

    if (!r.ok) {
      return {
        ok: false, provider: adapter.id, httpStatus: r.status, elapsedMs,
        reasonCode: "http-" + r.status, detail: notice || ("HTTP " + r.status),
      };
    }
    if (!rows.length) {
      return {
        ok: false, provider: adapter.id, httpStatus: r.status, elapsedMs,
        reasonCode: "empty-results", detail: notice || "请求成功但没解析出结果（响应形状可能不匹配）",
      };
    }
    return {
      ok: true, provider: adapter.id, httpStatus: r.status, elapsedMs, count: rows.length,
      sample: rows.slice(0, 3).map((x) => ({
        title: clip(x && x.title, 80),
        url: clip(x && x.url, 200),
      })),
    };
  } catch (e) {
    const aborted = !!e && (e.name === "AbortError" || /abort/i.test(str(e.message)));
    return {
      ok: false, provider: adapter.id, elapsedMs: Date.now() - started,
      reasonCode: aborted ? "timeout" : "network",
      detail: aborted ? "请求超时" : redact(clip((e && e.message) || e, 160), key),
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { probe };
