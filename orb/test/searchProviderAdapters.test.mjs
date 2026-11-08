/* 批次C · 多 provider 适配器单测。
 * 全部用内存 mock fetch，零真实外发、零凭据读取。
 * 判据：各家的请求/响应形状各自正确、坏形状不编造、key 不漏、桥确实接上了。
 * 2026-11-06 晚扩展：AnySearch 置顶 + 免 Key 匿名档 + 自定义服务商。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADAPTERS, ADAPTER_IDS, DEFAULT_ADAPTER_ID, getAdapter, listAdapters,
} from "../searchProviderAdapters.mjs";
import { createSearchProvider } from "../searchProvider.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");
const PACK = fs.readFileSync(path.join(ROOT, "pack.cjs"), "utf8");

const KEY = "FAKE-USER-APPLIED-KEY";

function mockFetch(payload, rec) {
  return async (url, init) => {
    rec.url = url;
    rec.headers = init.headers;
    rec.body = JSON.parse(init.body);
    return { status: 200, ok: true, json: async () => payload };
  };
}

const PAYLOADS = {
  anysearch: {
    code: 0, message: "success",
    data: {
      results: [1, 2, 3].map((i) => ({
        title: `A标题${i}`, url: `https://example.org/a${i}`, snippet: `A摘要${i}`,
      })),
    },
  },
  deepseek: {
    results: [1, 2, 3].map((i) => ({
      title: `D标题${i}`, url: `https://example.org/d${i}`, snippet: `D摘要${i}`, source: "example.org",
    })),
  },
  zhipu: {
    search_result: [1, 2, 3].map((i) => ({
      title: `Z标题${i}`, link: `https://example.org/z${i}`, content: `Z摘要${i}`, media: "示例站",
    })),
  },
  baidu: {
    references: [1, 2, 3].map((i) => ({
      id: i, title: `B标题${i}`, url: `https://example.org/b${i}`,
      content: `B摘要${i}`, website: "示例站", type: "web",
    })),
  },
  custom: {
    code: 0,
    data: {
      results: [1, 2, 3].map((i) => ({
        title: `C标题${i}`, url: `https://example.org/c${i}`, snippet: `C摘要${i}`, source: "示例站",
      })),
    },
  },
};

test("注册表：AnySearch 排第一位，桥的默认仍回落 deepseek（不改既有行为）", () => {
  assert.deepEqual([...ADAPTER_IDS], ["anysearch", "deepseek", "zhipu", "baidu", "custom"]);
  assert.equal(ADAPTER_IDS[0], "anysearch", "用户要求把免费额度最大的选项放第一位");
  assert.equal(DEFAULT_ADAPTER_ID, "deepseek", "桥侧 fallback 保持既有实现，保护 19 条旧单测");
  assert.equal(getAdapter("nope"), null);
  assert.equal(getAdapter("ZHIPU").id, "zhipu");
  assert.equal(getAdapter(undefined), null);
  assert.equal(getAdapter("CUSTOM").id, "custom");
});

test("请求体形状：deepseek / zhipu / baidu 各按官方文档生成", () => {
  const d = ADAPTERS.deepseek.buildBody("X", 5);
  assert.deepEqual(d, { query: "X", count: 5, need_content: false });

  const z = ADAPTERS.zhipu.buildBody("X", 5);
  assert.equal(z.search_query, "X");
  assert.equal(z.search_engine, "search_std");
  assert.equal(z.count, 5);
  assert.equal(z.search_intent, false);

  const b = ADAPTERS.baidu.buildBody("X", 5);
  assert.deepEqual(b.messages, [{ role: "user", content: "X" }]);
  assert.equal(b.search_source, "baidu_search_v2");
  assert.deepEqual(b.resource_type_filter, [{ type: "web", top_k: 5 }]);
  /* 纯检索专用端点：既无 model 也无 stream，协议层面不产生模型费用 */
  assert.ok(!("model" in b));
  assert.ok(!("stream" in b));
  assert.equal(ADAPTERS.baidu.endpoint,
    "https://qianfan.baidubce.com/v2/ai_search/web_search");
  /* web_search standard 版网页 top_k 上限 50 */
  assert.equal(ADAPTERS.baidu.buildBody("X", 99).resource_type_filter[0].top_k, 50);
});

test("响应投影：五家都统一成 title / url / snippet / source", () => {
  for (const [id, payload] of Object.entries(PAYLOADS)) {
    const rows = ADAPTERS[id].parse(payload);
    assert.equal(rows.length, 3, id);
    for (const r of rows) {
      assert.equal(typeof r.title, "string", id);
      assert.ok(r.url.startsWith("https://example.org/"), id);
      assert.equal(typeof r.snippet, "string", id);
      assert.equal(typeof r.source, "string", id);
    }
  }
  assert.equal(ADAPTERS.zhipu.parse(PAYLOADS.zhipu)[0].url, "https://example.org/z1");
  assert.equal(ADAPTERS.zhipu.parse(PAYLOADS.zhipu)[0].snippet, "Z摘要1");
  assert.equal(ADAPTERS.baidu.parse(PAYLOADS.baidu)[0].snippet, "B摘要1");
});

test("坏形状一律返回空，不编造结果", () => {
  for (const id of ADAPTER_IDS) {
    for (const bad of [null, undefined, {}, { results: null }, "x", 42, { search_result: [null, 1] }]) {
      assert.deepEqual(ADAPTERS[id].parse(bad), [], `${id} / ${String(bad)}`);
    }
  }
});

test("凭据只进 Authorization 头，绝不进请求体或自检输出", () => {
  for (const id of ADAPTER_IDS) {
    const a = ADAPTERS[id];
    const h = a.headers(KEY);
    assert.equal(h.Authorization, "Bearer " + KEY, id);
    assert.equal(h["Content-Type"], "application/json");
    assert.ok(!JSON.stringify(a.buildBody("X", 3)).includes(KEY));
  }
  const dumped = JSON.stringify(listAdapters());
  assert.ok(!dumped.includes(KEY));
  assert.ok(!dumped.includes("apiKey"));
  for (const row of listAdapters()) {
    assert.ok(row.id && row.label && row.endpoint && row.docs && row.quotaNote && row.verified);
  }
});

test("verified 如实标注：既有实现 existing-code、已实测 live-verified、仅核文档 docs-only、自定义 user-supplied", () => {
  assert.equal(ADAPTERS.deepseek.verified, "existing-code");
  /* AnySearch 2026-11-06 已真实调用（匿名档 3 条），不再是 docs-only。 */
  assert.equal(ADAPTERS.anysearch.verified, "live-verified");
  for (const id of ["zhipu", "baidu"]) {
    assert.equal(ADAPTERS[id].verified, "docs-only", id);
  }
  assert.equal(ADAPTERS.custom.verified, "user-supplied");
  const byId = Object.fromEntries(listAdapters().map((r) => [r.id, r]));
  assert.equal(byId.anysearch.anonymous, true);
  assert.equal(byId.custom.anonymous, true);
  assert.equal(byId.baidu.anonymous, false);
});

test("端到端 × 5：mock fetch 下拿到 3 条统一结果，且 config 五键契约不变", async () => {
  for (const id of ADAPTER_IDS) {
    const rec = {};
    const p = createSearchProvider({
      enabled: true, apiKey: KEY, adapter: id,
      fetchImpl: mockFetch(PAYLOADS[id], rec),
    });
    const r = await p.search("ORB 检索");
    assert.equal(r.ok, true, id);
    assert.equal(r.results.length, 3, id);
    /* 厂商选择用「真的打到了哪个端点 + 自检里的端点」验证，不靠新增 config 字段 */
    assert.equal(rec.url, ADAPTERS[id].endpoint, id + " 真的打到了该厂商端点");
    assert.equal(p.config().endpoint, ADAPTERS[id].endpoint, id);
    assert.deepEqual(Object.keys(p.config()).sort(),
      ["enabled", "endpoint", "hasKey", "maxResults", "timeoutMs"].sort(),
      id + " 切换厂商不改变既有 config 契约");
    assert.ok(rec.url.startsWith("https://"), id);
    assert.equal(rec.headers.Authorization, "Bearer " + KEY, id);
    assert.ok(!JSON.stringify(rec.body).includes(KEY), id);
    assert.equal(r.results[0].title, {
      anysearch: "A标题1", deepseek: "D标题1", zhipu: "Z标题1",
      baidu: "B标题1", custom: "C标题1",
    }[id], id);
  }
});

test("未知 provider 回落 deepseek，且默认 inert 依旧零外发", async () => {
  let calls = 0;
  const p = createSearchProvider({
    enabled: true, apiKey: KEY, adapter: "does-not-exist",
    fetchImpl: async (u, i) => {
      calls++;
      assert.match(String(i.body), /need_content":false/, "回落 deepseek 的请求形状");
      return { status: 200, json: async () => PAYLOADS.deepseek };
    },
  });
  assert.equal(p.config().endpoint, ADAPTERS.deepseek.endpoint, "未知 provider 回落到 deepseek 端点");
  const r = await p.search("X");
  assert.equal(r.ok, true);
  assert.equal(calls, 1);

  let inertCalls = 0;
  const q = createSearchProvider({
    enabled: false, apiKey: "", adapter: "zhipu",
    fetchImpl: async () => { inertCalls++; return { status: 200, json: async () => ({}) }; },
  });
  const r2 = await q.search("X");
  assert.equal(r2.reasonCode, "provider-disabled");
  assert.equal(inertCalls, 0);
});

test("桥已接 provider 选择，且新模块进了打包清单", () => {
  assert.match(BRIDGE, /ORB_SEARCH_PROVIDER/);
  assert.match(BRIDGE, /adapter:\s*searchAdapter\.id/);
  assert.match(BRIDGE, /availableProviders:\s*\[\.\.\.ADAPTER_IDS\]/);
  assert.match(BRIDGE, /adapters:\s*listAdapters\(\)/);
  assert.match(PACK, /'searchProviderAdapters\.mjs'/);
});

test("可选模型 / 引擎：只有 zhipu 生效，deepseek 与 baidu 端点都无模型项", () => {
  assert.deepEqual(ADAPTERS.deepseek.buildBody("X", 3, "whatever"), {
    query: "X", count: 3, need_content: false,
  });
  assert.equal(ADAPTERS.zhipu.buildBody("X", 3).search_engine, "search_std");
  assert.equal(ADAPTERS.zhipu.buildBody("X", 3, "search_pro").search_engine, "search_pro");
  assert.ok(!("model" in ADAPTERS.baidu.buildBody("X", 3)));
  assert.ok(!("model" in ADAPTERS.baidu.buildBody("X", 3, "ernie-4.0")));
});

test("百度免费额度文案按官方文档区分两条产品线，不把 100 次/天安到 web_search 上", () => {
  const q = ADAPTERS.baidu.quotaNote;
  assert.match(q, /每月免费 1500 次/);
  assert.match(q, /约 50 次\/天/);
  assert.match(q, /¥0\.036\/次/);
  assert.match(q, /智能搜索生成高性能版/);
  assert.match(q, /100 次\/天/);
  assert.match(q, /ORB 不调用/);
  assert.ok(!/口径不一|两处口径/.test(q), "官方文档已澄清为两条独立产品线，不得再写成未决冲突");
  assert.match(q, /开通后付费/, "控制台前置条件必须如实告知");
  assert.match(q, /纯检索不调模型/);
  assert.equal(ADAPTERS.baidu.verified, "docs-only", "未真实调用前不许宣称可用");
});

test("模型名经 createSearchProvider 真进请求体，且不污染五键 config 契约", async () => {
  for (const [id, pick] of [
    ["zhipu", (b) => b.search_engine],
  ]) {
    const rec = {};
    const p = createSearchProvider({
      enabled: true, apiKey: KEY, adapter: id, model: "MY-ENGINE",
      fetchImpl: mockFetch(PAYLOADS[id], rec),
    });
    const r = await p.search("X");
    assert.equal(r.ok, true, id);
    assert.equal(pick(rec.body), "MY-ENGINE", id);
    assert.deepEqual(Object.keys(p.config()).sort(),
      ["enabled", "endpoint", "hasKey", "maxResults", "timeoutMs"].sort(), id);
    assert.ok(!JSON.stringify(p.config()).includes(KEY), id);
  }
  /* 百度纯检索端点：即使传了 model，也不得混进请求体产生模型费用 */
  const bRec = {};
  const bp = createSearchProvider({
    enabled: true, apiKey: KEY, adapter: "baidu", model: "MY-ENGINE",
    fetchImpl: mockFetch(PAYLOADS.baidu, bRec),
  });
  assert.equal((await bp.search("X")).ok, true);
  assert.ok(!("model" in bRec.body));
  assert.equal(bRec.url, ADAPTERS.baidu.endpoint);
});

test("百度 Reference 同时给 snippet 与 content 时优先取 snippet，缺则回落 content", () => {
  const rows = ADAPTERS.baidu.parse({ references: [
    { title: "T1", url: "https://example.org/a", snippet: "短摘要", content: "长内容" },
    { title: "T2", url: "https://example.org/b", content: "仅 content" },
  ] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].snippet, "短摘要");
  assert.equal(rows[1].snippet, "仅 content");
});

test("AnySearch：官方形状、max_results 上限 10、无 Key 匿名省略 Authorization", () => {
  const a = ADAPTERS.anysearch;
  assert.equal(a.endpoint, "https://api.anysearch.com/v1/search");
  assert.equal(a.anonymous, true);
  assert.deepEqual(a.buildBody("X", 5), { query: "X", max_results: 5 });
  assert.equal(a.buildBody("X", 99).max_results, 10, "官方 Range 1–10，不悄悄放大");
  const h = a.headers("");
  assert.ok(!("Authorization" in h), "匿名时完全省略 Authorization，不能发空 Bearer");
  assert.equal(h["Content-Type"], "application/json");
  assert.equal(a.headers(KEY).Authorization, "Bearer " + KEY);
  assert.deepEqual(a.parse({ code: -1, data: { results: PAYLOADS.anysearch.data.results } }), [],
    "业务错误码不为 0 时必须返回空，不能把错误响应当结果");
  assert.equal(a.parse(PAYLOADS.anysearch).length, 3);
  assert.equal(a.parse(PAYLOADS.anysearch)[0].source, "",
    "响应没有 source 字段就留空，让下游 hostOf(url) 兜底，不伪造来源名");
});

test("匿名档才允许无 Key 发请求，其余厂商依旧 no-credential", async () => {
  for (const id of ["anysearch", "custom"]) {
    let calls = 0;
    const p = createSearchProvider({
      enabled: true, apiKey: "", adapter: id,
      fetchImpl: async (u, i) => {
        calls++;
        assert.ok(!("Authorization" in i.headers), id + " 匿名请求不得带 Authorization");
        return { status: 200, json: async () => PAYLOADS[id] };
      },
    });
    const r = await p.search("X");
    assert.equal(r.ok, true, id);
    assert.equal(calls, 1, id);
  }
  let blocked = 0;
  const p2 = createSearchProvider({
    enabled: true, apiKey: "", adapter: "baidu",
    fetchImpl: async () => { blocked++; return { status: 200, json: async () => ({}) }; },
  });
  const r2 = await p2.search("X");
  assert.equal(r2.reasonCode, "no-credential");
  assert.equal(blocked, 0, "非匿名档绝不裸发请求");
});

test("自定义服务商：四种常见响应壳兼容，形状对不上不编造", () => {
  const a = ADAPTERS.custom;
  assert.equal(a.verified, "user-supplied");
  assert.equal(a.anonymous, true);
  for (const p of [
    { results: [{ title: "T", url: "https://example.org/x", snippet: "S" }] },
    { data: { results: [{ title: "T", url: "https://example.org/x", content: "S" }] } },
    { references: [{ title: "T", url: "https://example.org/x", content: "S", website: "W" }] },
    { search_result: [{ title: "T", link: "https://example.org/x", content: "S", media: "M" }] },
  ]) {
    const rows = a.parse(p);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].url, "https://example.org/x");
    assert.ok(rows[0].snippet);
  }
  assert.deepEqual(a.parse({ code: 402, data: { results: [{}] } }), []);
  assert.deepEqual(a.parse({ data: {} }), []);
});
