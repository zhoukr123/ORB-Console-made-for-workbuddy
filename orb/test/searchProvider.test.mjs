/* searchProvider 单测：全程注入假 fetchImpl，不发真实网络，零 npm 依赖。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSearchProvider, SEARCH_SCHEMA_VERSION } from "../searchProvider.mjs";

/* 仅为单元测试构造的假凭证，绝非真实 API key。 */
const KEY = "FAKE-KEY-FOR-UNIT-TEST-ONLY-xyz";

function resp(status, payload, opts = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (opts.badJson) throw new SyntaxError("invalid json");
      return payload;
    },
  };
}

function okPayload(results) {
  return { results };
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

/* 记录所有请求的假 fetch；handler 可在测试过程中被替换以驱动不同分支。 */
function recordingFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

function makeProvider(fetchImpl, overrides = {}) {
  return createSearchProvider(Object.assign({
    enabled: true,
    apiKey: KEY,
    timeoutMs: 100,
    fetchImpl,
  }, overrides));
}

const SCHEMA_KEYS = [
  "ok", "results", "degraded", "reasonCode", "provider",
  "elapsedMs", "noVisionFallback", "schemaVersion",
];

test("导出的 schema 版本为 1", () => {
  assert.equal(SEARCH_SCHEMA_VERSION, 1);
});

test("默认关闭：绝不发请求，返回 provider-disabled 且不计数", async () => {
  const rec = recordingFetch(() => resp(200, okPayload([])));
  const p = createSearchProvider({ fetchImpl: rec.fn });
  const r = await p.search("hello");
  assert.equal(r.ok, false);
  assert.equal(r.degraded, true);
  assert.equal(r.reasonCode, "provider-disabled");
  assert.deepEqual(r.results, []);
  assert.equal(r.noVisionFallback, true);
  assert.equal(r.schemaVersion, 1);
  assert.equal(rec.calls.length, 0, "禁用时绝不发请求");
  assert.deepEqual(p.stats(), { requests: 0, succeeded: 0, failed: 0, byReason: {} });
  assert.equal(p.config().enabled, false);
});

test("无 credential：空 key / 纯空白 key 都绝不发请求，返回 no-credential", async () => {
  for (const key of ["", "   "]) {
    const rec = recordingFetch(() => resp(200, okPayload([])));
    const p = createSearchProvider({ enabled: true, apiKey: key, timeoutMs: 100, fetchImpl: rec.fn });
    const r = await p.search("hello");
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, "no-credential");
    assert.equal(r.noVisionFallback, true);
    assert.equal(rec.calls.length, 0, "无凭证时绝不发请求");
    assert.deepEqual(p.stats(), { requests: 0, succeeded: 0, failed: 0, byReason: {} });
    assert.equal(p.config().hasKey, false);
  }
});

test("坏 query：空 / 超 128 字符 / 非字符串都绝不发请求，返回 bad-query", async () => {
  const badQueries = ["", "   ", "x".repeat(129), 123, null, undefined, {}, Symbol("q")];
  for (const q of badQueries) {
    const rec = recordingFetch(() => resp(200, okPayload([])));
    const p = makeProvider(rec.fn);
    const r = await p.search(q);
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, "bad-query");
    assert.equal(r.noVisionFallback, true);
    assert.equal(rec.calls.length, 0, "坏 query 绝不发请求");
    assert.equal(p.stats().requests, 0);
  }
});

test("成功：规范化结果 + 请求体 need_content:false + 鉴权头 + 超时信号 + schema 形状", async () => {
  const payload = okPayload([
    { title: "T1", url: "https://a.example/x", snippet: "S1", source: "site-a" },
    { title: "T2", url: "http://b.example/y", snippet: "S2" },
  ]);
  const rec = recordingFetch(() => resp(200, payload));
  const p = makeProvider(rec.fn);
  const r = await p.search("hello", { requestId: "t1" });

  assert.equal(r.ok, true);
  assert.equal(r.degraded, false);
  assert.equal(r.reasonCode, "");
  assert.equal(r.schemaVersion, 1);
  assert.equal(typeof r.provider, "string");
  assert.equal(typeof r.elapsedMs, "number");
  assert.equal(r.noVisionFallback, true);
  assert.deepEqual(Object.keys(r).sort(), SCHEMA_KEYS.slice().sort(), "结果字段固定为 8 键");

  assert.equal(r.results.length, 2);
  assert.deepEqual(Object.keys(r.results[0]).sort(), ["title", "url", "snippet", "source"].sort());
  assert.deepEqual(r.results[0], {
    title: "T1", url: "https://a.example/x", snippet: "S1", source: "site-a",
  });
  assert.deepEqual(r.results[1], {
    title: "T2", url: "http://b.example/y", snippet: "S2", source: "b.example",
  }, "source 缺失时退到 url 的 hostname");

  assert.equal(rec.calls.length, 1);
  const init = rec.calls[0].init;
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), { query: "hello", count: 5, need_content: false });
  assert.equal(init.headers["Authorization"], "Bearer " + KEY);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.ok(init.signal, "必须携带超时信号");
  assert.equal(typeof init.signal.addEventListener, "function");
  assert.equal(typeof init.signal.aborted, "boolean");
});

test("url 非 http(s) 的条目被丢弃（ftp / javascript / 相对路径 / 缺失）", async () => {
  const payload = okPayload([
    { title: "good", url: "https://good.example/p", snippet: "ok", source: "g" },
    { title: "ftp", url: "ftp://bad.example/f", snippet: "x" },
    { title: "js", url: "javascript:alert(1)", snippet: "x" },
    { title: "relative", url: "/no-scheme", snippet: "x" },
    { title: "missing" },
  ]);
  const rec = recordingFetch(() => resp(200, payload));
  const p = makeProvider(rec.fn);
  const r = await p.search("q");
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].url, "https://good.example/p");
});

test("snippet 缺失退到 summary，且 snippet/summary 都截断到 500 字", async () => {
  const long = "x".repeat(700);
  const payload = okPayload([
    { title: "A", url: "https://a.example", summary: long },
    { title: "B", url: "https://b.example", snippet: "", summary: "fallback-summary" },
    { title: "C", url: "https://c.example", snippet: "has-snippet", summary: "ignored" },
    { title: "D", url: "https://d.example", snippet: "y".repeat(600) },
  ]);
  const rec = recordingFetch(() => resp(200, payload));
  const p = makeProvider(rec.fn);
  const r = await p.search("q");
  assert.equal(r.ok, true);
  assert.equal(r.results[0].snippet, "x".repeat(500), "summary 退路被截断到 500");
  assert.equal(r.results[1].snippet, "fallback-summary", "空 snippet 也退到 summary");
  assert.equal(r.results[2].snippet, "has-snippet", "有 snippet 时忽略 summary");
  assert.equal(r.results[3].snippet, "y".repeat(500), "显式 snippet 同样受 500 上限约束");
});

test("超时：AbortError 分级为 timeout，且带 noVisionFallback", async () => {
  const rec = recordingFetch(() => Promise.reject(abortError()));
  const p = makeProvider(rec.fn, { timeoutMs: 50 });
  const r = await p.search("q");
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "timeout");
  assert.equal(r.degraded, true);
  assert.equal(r.noVisionFallback, true);
  assert.deepEqual(r.results, []);
});

test("超时：信号到期触发 abort（验证 AbortSignal.timeout 等价超时接线）", async () => {
  const p = createSearchProvider({
    enabled: true,
    apiKey: KEY,
    timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      const s = init.signal;
      const onAbort = () => reject(abortError());
      if (s && s.aborted) return onAbort();
      if (s && typeof s.addEventListener === "function") {
        s.addEventListener("abort", onAbort, { once: true });
      } else {
        reject(new Error("no signal"));
      }
    }),
  });
  const r = await p.search("q");
  assert.equal(r.reasonCode, "timeout");
  assert.equal(r.noVisionFallback, true);
});

test("429 分级为 rate-limited", async () => {
  const rec = recordingFetch(() => resp(429, okPayload([])));
  const p = makeProvider(rec.fn);
  const r = await p.search("q");
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "rate-limited");
  assert.equal(r.noVisionFallback, true);
  assert.deepEqual(p.stats().byReason, { "rate-limited": 1 });
});

test("其它非 2xx 分级为 http-error", async () => {
  for (const status of [400, 500, 503]) {
    const rec = recordingFetch(() => resp(status, okPayload([])));
    const p = makeProvider(rec.fn);
    const r = await p.search("q");
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, "http-error");
    assert.equal(r.noVisionFallback, true);
  }
});

test("fetchImpl 抛普通异常降级为 http-error，且 search 永远不抛", async () => {
  const rec = recordingFetch(() => { throw new Error("network down"); });
  const p = makeProvider(rec.fn);
  const r = await p.search("q");
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "http-error");
  assert.equal(r.noVisionFallback, true);
});

test("bad-json：json 解析失败分级为 bad-json", async () => {
  const rec = recordingFetch(() => resp(200, null, { badJson: true }));
  const p = makeProvider(rec.fn);
  const r = await p.search("q");
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "bad-json");
  assert.equal(r.noVisionFallback, true);
});

test("empty-results：200 但 results 为空 / 缺失 / 非数组", async () => {
  const payloads = [okPayload([]), {}, { results: null }, { results: "nope" }];
  for (const payload of payloads) {
    const rec = recordingFetch(() => resp(200, payload));
    const p = makeProvider(rec.fn);
    const r = await p.search("q");
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, "empty-results");
    assert.equal(r.noVisionFallback, true);
    assert.deepEqual(r.results, []);
  }
});

test("任何失败都带 noVisionFallback:true / degraded:true / ok:false", async () => {
  const scenarios = [
    () => resp(429, {}),
    () => resp(500, {}),
    () => resp(200, null, { badJson: true }),
    () => resp(200, okPayload([])),
    () => Promise.reject(abortError()),
    () => Promise.reject(new Error("boom")),
  ];
  for (const handler of scenarios) {
    const rec = recordingFetch(handler);
    const p = makeProvider(rec.fn);
    const r = await p.search("q");
    assert.equal(r.ok, false);
    assert.equal(r.degraded, true);
    assert.equal(r.noVisionFallback, true, "失败绝不静默回落到视觉循环");
    assert.equal(r.schemaVersion, 1);
  }
});

test("apiKey 不泄漏：返回值 / config / stats 序列化后均不含 key，且不含 error 文本字段", async () => {
  const rec = recordingFetch(() => resp(200, okPayload([
    { title: "leak " + KEY, url: "https://a.example/" + KEY, snippet: "body " + KEY, source: "src " + KEY },
  ])));
  const p = makeProvider(rec.fn);
  const r = await p.search("q");
  const blob = JSON.stringify({ result: r, config: p.config(), stats: p.stats() });
  assert.ok(!blob.includes(KEY), "apiKey 绝不出现在任何对外输出");
  assert.ok(!("apiKey" in r));
  assert.ok(!("apiKey" in p.config()));
  assert.ok(!("error" in r) && !("message" in r), "不回传任何错误文本");

  /* 异常信息里夹带 key 也不能外泄。 */
  const p2 = createSearchProvider({
    enabled: true,
    apiKey: KEY,
    timeoutMs: 100,
    fetchImpl: () => Promise.reject(new Error("boom " + KEY)),
  });
  const r2 = await p2.search("q");
  assert.equal(r2.reasonCode, "http-error");
  assert.ok(!JSON.stringify(r2).includes(KEY), "错误信息必须脱敏");
});

test("stats 计数：守卫不计数，成功/失败按真实请求累计，byReason 为失败分布快照", async () => {
  let handler = () => resp(200, okPayload([
    { title: "t", url: "https://a.example", snippet: "s" },
  ]));
  const rec = recordingFetch((url, init) => handler(url, init));
  const p = makeProvider(rec.fn);

  await p.search("");
  assert.deepEqual(p.stats(), { requests: 0, succeeded: 0, failed: 0, byReason: {} }, "守卫分支不计数");

  await p.search("q1");
  let s = p.stats();
  assert.equal(s.requests, 1);
  assert.equal(s.succeeded, 1);
  assert.equal(s.failed, 0);
  assert.deepEqual(s.byReason, {});

  handler = () => resp(429, {});
  await p.search("q2");
  handler = () => resp(500, {});
  await p.search("q3");
  handler = () => Promise.reject(abortError());
  await p.search("q4");
  handler = () => resp(200, null, { badJson: true });
  await p.search("q5");
  handler = () => resp(200, okPayload([]));
  await p.search("q6");

  s = p.stats();
  assert.equal(s.requests, 6);
  assert.equal(s.succeeded, 1);
  assert.equal(s.failed, 5);
  assert.equal(s.requests, s.succeeded + s.failed);
  assert.deepEqual(s.byReason, {
    "rate-limited": 1,
    "http-error": 1,
    timeout: 1,
    "bad-json": 1,
    "empty-results": 1,
  });

  const snap = p.stats();
  await p.search("q7");
  assert.equal(snap.requests, 6, "stats 是调用时快照");
  assert.equal(p.stats().requests, 7);
});

test("config 形状：仅五键，hasKey 为 boolean，不含 apiKey，含默认值与上限", () => {
  const p = createSearchProvider({
    enabled: true,
    apiKey: KEY,
    timeoutMs: 1234,
    maxResults: 7,
    endpoint: "https://custom.example/search",
  });
  const c = p.config();
  assert.deepEqual(Object.keys(c).sort(),
    ["enabled", "endpoint", "hasKey", "maxResults", "timeoutMs"].sort());
  assert.equal(c.enabled, true);
  assert.equal(c.endpoint, "https://custom.example/search");
  assert.equal(c.timeoutMs, 1234);
  assert.equal(c.maxResults, 7);
  assert.equal(c.hasKey, true);
  assert.ok(!("apiKey" in c));
  assert.ok(!JSON.stringify(c).includes(KEY));

  assert.deepEqual(createSearchProvider().config(), {
    enabled: false,
    endpoint: "https://api.deepseek.com/v1/tools/search",
    timeoutMs: 15000,
    maxResults: 5,
    hasKey: false,
  });
  assert.equal(createSearchProvider({ maxResults: 999 }).config().maxResults, 50, "maxResults 上限 50");
});

test("clock 可注入：elapsedMs 由注入时钟决定", async () => {
  let now = 1000;
  const rec = recordingFetch(() => { now = 1042; return resp(200, okPayload([
    { title: "t", url: "https://a.example", snippet: "s" },
  ])); });
  const p = createSearchProvider({
    enabled: true,
    apiKey: KEY,
    timeoutMs: 100,
    clock: () => now,
    fetchImpl: rec.fn,
  });
  const r = await p.search("q");
  assert.equal(r.ok, true);
  assert.equal(r.elapsedMs, 42);
});

test("source 兜底用 host，且不会被打成 [link]（实测 www 域名曾丢失来源）", async () => {
  const rec = recordingFetch(() => resp(200, okPayload([
    { title: "a", url: "https://www.yzsj.net/detail_1.html", snippet: "s" },
    { title: "b", url: "https://wallstreetcn.com/articles/1", snippet: "s" },
    { title: "c", url: "https://e.com/x", snippet: "s", source: "https://evil.example/z" },
  ])));
  const p = makeProvider(rec.fn);
  const r = await p.search("q");
  assert.equal(r.ok, true);
  assert.equal(r.results[0].source, "www.yzsj.net", "host 不能再过 URL 脱敏");
  assert.equal(r.results[1].source, "wallstreetcn.com");
  assert.equal(r.results[2].source, "https://evil.example/z",
    "provider 只做脱敏不做外链降级；外链降级由编排层文本闸门负责");
});
