/* 检索工具「测试」按钮的探测逻辑（desktop/searchProbe.cjs）。
 *
 * 这些是**行为测试**：真跑 probe()，用假 adapter / 假 fetch 覆盖每条降级分支。
 * 判据：① 没 key 且非匿名档必须一次都不发；② 任何异常都要如实给 reasonCode，
 *      不许把失败说成成功；③ 返回值里绝不能出现 key 明文。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ADAPTERS } from "../searchProviderAdapters.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { probe } = require(path.join(ROOT, "desktop", "searchProbe.cjs"));

/** 假响应：只实现 probe 用到的那几个成员。 */
function res(status, body, ok) {
  return {
    ok: ok === undefined ? status >= 200 && status < 300 : ok,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function recorder(response) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return response; };
  fn.calls = calls;
  return fn;
}

const KEY = "sk-test-should-never-leak";

test("匿名档没有 key 也放行，且完全省略 Authorization 头", async () => {
  const fetchImpl = recorder(res(200, { code: 0, data: { results: [
    { title: "首条", url: "https://example.com/a", snippet: "a" },
    { title: "次条", url: "https://example.com/b", snippet: "b" },
  ] } }));
  const r = await probe({ adapter: ADAPTERS.anysearch, key: "", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(!("Authorization" in fetchImpl.calls[0].init.headers), "无 key 时不许发空 Bearer");
});

test("非匿名档没有 key：一次都不发，如实 no-credential", async () => {
  const fetchImpl = recorder(res(200, { results: [] }));
  for (const id of ["deepseek", "zhipu", "baidu"]) {
    const r = await probe({ adapter: ADAPTERS[id], key: "", fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, "no-credential", id + " 应该拦在发送之前");
  }
  assert.equal(fetchImpl.calls.length, 0, "被拦下时绝不能已经发出去");
});

test("有 key 时按 adapter 的 headers() 发 Bearer", async () => {
  const fetchImpl = recorder(res(200, { results: [{ title: "t", url: "https://e.com/x" }] }));
  await probe({ adapter: ADAPTERS.deepseek, key: KEY, fetchImpl });
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, "Bearer " + KEY);
});

test("端点协议闸：ftp / 非法 URL 都在发送前拒绝", async () => {
  const fetchImpl = recorder(res(200, {}));
  const a = await probe({ adapter: ADAPTERS.anysearch, endpoint: "ftp://example.com/x", fetchImpl });
  assert.equal(a.reasonCode, "bad-endpoint");
  const b = await probe({ adapter: ADAPTERS.anysearch, endpoint: "不是 URL", fetchImpl });
  assert.equal(b.reasonCode, "bad-endpoint");
  assert.equal(fetchImpl.calls.length, 0);
});

test("端点覆盖生效（自定义服务商填的地址真的被用上）", async () => {
  const fetchImpl = recorder(res(200, { results: [{ title: "t", url: "https://e.com/x" }] }));
  await probe({ adapter: ADAPTERS.custom, endpoint: "https://my.host/v1/search", key: "", fetchImpl });
  assert.equal(fetchImpl.calls[0].url, "https://my.host/v1/search");
});

test("HTTP 失败：reasonCode 带状态码，detail 取服务商的 message", async () => {
  const fetchImpl = recorder(res(401, { message: "invalid api key" }));
  const r = await probe({ adapter: ADAPTERS.deepseek, key: KEY, fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "http-401");
  assert.equal(r.httpStatus, 401);
  assert.match(r.detail, /invalid api key/);
});

test("请求成功但形状对不上：empty-results，不编造结果", async () => {
  const fetchImpl = recorder(res(200, { hello: "world" }));
  const r = await probe({ adapter: ADAPTERS.anysearch, key: "", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "empty-results");
});

test("成功：只回前三条标题与链接，不回传原始响应", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    title: "标题" + i, url: "https://e.com/" + i, snippet: "x".repeat(50),
  }));
  const fetchImpl = recorder(res(200, { code: 0, data: { results: rows } }));
  const r = await probe({ adapter: ADAPTERS.anysearch, key: "", fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.count, 5);
  assert.equal(r.sample.length, 3);
  assert.deepEqual(Object.keys(r.sample[0]).sort(), ["title", "url"]);
  assert.ok(!JSON.stringify(r).includes("x".repeat(50)), "不许把 snippet/原始响应整包回传");
});

test("超时与网络错误各自映射到 timeout / network", async () => {
  const abortErr = new Error("The operation was aborted");
  abortErr.name = "AbortError";
  const a = await probe({ adapter: ADAPTERS.anysearch, key: "", fetchImpl: async () => { throw abortErr; } });
  assert.equal(a.reasonCode, "timeout");

  const b = await probe({ adapter: ADAPTERS.anysearch, key: "", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.equal(b.reasonCode, "network");
  assert.match(b.detail, /ECONNRESET/);
});

test("模型 / 引擎参数真的透传给 adapter（智谱 search_engine）", async () => {
  const fetchImpl = recorder(res(200, { search_result: [{ title: "t", link: "https://e.com/x", content: "c" }] }));
  await probe({ adapter: ADAPTERS.zhipu, key: KEY, model: "search_pro", fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.search_engine, "search_pro");
});

test("返回值里绝不出现 key 明文（含失败分支）", async () => {
  const okFetch = recorder(res(200, { results: [{ title: "t", url: "https://e.com/x" }] }));
  const failFetch = recorder(res(500, { message: KEY }));
  for (const fetchImpl of [okFetch, failFetch]) {
    const r = await probe({ adapter: ADAPTERS.deepseek, key: KEY, fetchImpl });
    assert.ok(!JSON.stringify(r).includes(KEY), "any branch must not echo the key");
  }
});

test("adapter 不可用 / 环境没有 fetch：如实报错，不抛", async () => {
  const a = await probe({ adapter: null });
  assert.equal(a.reasonCode, "adapter-missing");
  const saved = globalThis.fetch;
  try {
    globalThis.fetch = undefined;
    const b = await probe({ adapter: ADAPTERS.anysearch, key: "" });
    assert.equal(b.reasonCode, "no-fetch");
  } finally {
    globalThis.fetch = saved;
  }
});

test("HTTP 429 单独映射成 http-429（限流与鉴权失败必须分开报）", async () => {
  const fetchImpl = recorder(res(429, { message: "rate limit exceeded" }));
  const r = await probe({ adapter: ADAPTERS.anysearch, key: "", fetchImpl });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "http-429");
  assert.equal(r.httpStatus, 429);
});

test("真超时：本地慢服务 + 1s 上限，如实报 timeout 而不是 network", async () => {
  const http = await import("node:http");
  const srv = http.createServer((_req, res) => {
    setTimeout(() => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"code":0,"data":{"results":[]}}'); }, 1500);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  try {
    const t0 = Date.now();
    const r = await probe({
      adapter: ADAPTERS.anysearch, key: "",
      endpoint: "http://127.0.0.1:" + port + "/v1/search",
      timeoutMs: 1000,
    });
    const cost = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.reasonCode, "timeout");
    assert.ok(cost < 1400, "必须在超时上限附近返回，实测 " + cost + "ms");
  } finally {
    srv.close();
  }
});
