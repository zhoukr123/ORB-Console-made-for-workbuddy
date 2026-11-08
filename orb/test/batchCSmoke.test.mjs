/* 批次C · 离线端到端冒烟（报告 §7 第 10 项「必须成对验收」）。
 *
 * 全程零外发：provider 的 fetch 用内存 mock 注入，凭据是测试假值，
 * 绝不读本机凭据库、绝不发真实请求。
 * 证明的是「意图 → provider → L4 → 编排 → 产物」这条链路真的通，
 * 而不是「只加了个 /api/search 没人消费 results[]」的空头功能。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCredentialProvider } from "../searchCredentials.mjs";
import { createSearchProvider } from "../searchProvider.mjs";
import { normalizeL4 } from "../searchL4.mjs";
import { buildSearchDoc, parseSearchToDocIntent } from "../searchOrchestrator.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");

function fixtureResults(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    title: `结果标题${i + 1}`,
    url: `https://example.org/a/${i + 1}`,
    snippet: `结果摘要${i + 1}`,
    source: "example.org",
  }));
}

function mockFetch(results, counter) {
  return async () => {
    counter.calls++;
    return { status: 200, ok: true, json: async () => ({ results }) };
  };
}

test("离线全链路：搜一下 X 然后记到文档 → 产物含 3 条，视觉调用 0 次", async () => {
  const counter = { calls: 0 };
  const creds = createCredentialProvider({
    enabled: true, source: "env",
    env: { ORB_SEARCH_API_KEY: "FAKE-TEST-KEY-NOT-A-REAL-CREDENTIAL" },
  });
  const provider = createSearchProvider({
    enabled: creds.describe().enabled,
    apiKey: creds.resolve().apiKey,
    fetchImpl: mockFetch(fixtureResults(3), counter),
  });

  const intent = parseSearchToDocIntent("搜一下 ORB 结构化检索 然后记到文档");
  assert.equal(intent.ok, true);

  const raw = await provider.search(intent.query);
  assert.equal(raw.ok, true);
  assert.equal(raw.results.length, 3);

  const l4 = normalizeL4(raw);
  assert.equal(l4.schemaVersion, 2);
  assert.equal(l4.ok, true);

  const doc = buildSearchDoc(intent.query, l4);
  assert.equal(doc.ok, true);
  assert.equal(doc.entries.length, 3);
  assert.match(doc.markdown, /结果标题1/);
  assert.match(doc.markdown, /https:\/\/example\.org\/a\/1/);
  assert.match(doc.markdown, /结果摘要1/);
  assert.equal(doc.zeroVlm, true);
  assert.equal(doc.vlmCalls, 0);
  assert.equal(doc.silent, true);
  /* 只发了这一次（且是内存 mock），没有任何真实网络访问。 */
  assert.equal(counter.calls, 1);
});

test("默认 inert 口径：provider 不发请求，整条链路如实降级为 0 条", async () => {
  const counter = { calls: 0 };
  const creds = createCredentialProvider({ enabled: false, env: { ORB_SEARCH_API_KEY: "SHOULD-NOT-BE-READ" } });
  const provider = createSearchProvider({
    enabled: creds.describe().enabled,
    apiKey: creds.resolve().apiKey,
    fetchImpl: mockFetch(fixtureResults(3), counter),
  });
  const raw = await provider.search("ORB 结构化检索");
  const l4 = normalizeL4(raw);
  const doc = buildSearchDoc("ORB 结构化检索", l4);
  assert.equal(raw.reasonCode, "provider-disabled");
  assert.equal(l4.reasonCode, "not_available");
  assert.equal(doc.ok, false);
  assert.equal(doc.entries.length, 0);
  assert.equal(doc.markdown, "");
  assert.equal(doc.zeroVlm, true);
  assert.equal(counter.calls, 0, "零外发的硬判据：fetch 一次都不许调");
});

test("fixture 模式产物显式标注非真实检索，不冒充能力可用", () => {
  const doc = buildSearchDoc("X", { ok: true, results: fixtureResults(3) }, { fixture: true });
  assert.equal(doc.ok, true);
  assert.equal(doc.fixture, true);
  assert.match(doc.markdown, /非真实检索/);
  assert.match(doc.markdown, /离线 fixture/);
});

test("桥侧编排段：不抓屏、不调 VLM、不回落视觉循环", () => {
  const start = BRIDGE.indexOf('url.pathname === "/api/search/to-doc"');
  /* 只截到下一个端点注释开始，别把后面端点的护栏注释算进来。 */
  const end = BRIDGE.indexOf("/* ---------------- 浏览器扩展通道", start);
  assert.ok(start > 0 && end > start);
  const seg = BRIDGE.slice(start, end);
  /* 查的是「调用形态」而非字符串：注释里说明护栏提到这些词是允许的。 */
  assert.ok(!/\brunVision\s*\(/.test(seg), "不许真的调视觉循环");
  assert.ok(!/\bgrabScreen\s*\(/.test(seg), "不许真的抓屏");
  assert.ok(!/\/api\/vlm["']/.test(seg), "不许真的调 VLM 端点");
});

test("桥侧编排段：急停 / 域名授权 / 产物登记 / fixture 标注都接上了", () => {
  const start = BRIDGE.indexOf('url.pathname === "/api/search/to-doc"');
  /* 终点收在 to-clipboard 之前：那一段有自己的闸门，混进来会让断言失去指向性。 */
  const end = BRIDGE.indexOf('url.pathname === "/api/search/to-clipboard"', start);
  assert.ok(start > 0 && end > start, "找不到 to-doc 段");
  const seg = BRIDGE.slice(start, end);
  assert.match(seg, /STOP\.on/, "检索类不进急停豁免");
  assert.match(seg, /authorizeDomain\(b\.url, SEARCH_ALLOWED_HOSTS\)/);
  assert.match(seg, /SEARCH_OFFLINE_FIXTURE && Array\.isArray\(b\.fixtureResults\)/);
  assert.match(seg, /registerArtifact\(\{/);
  assert.match(seg, /realResults:\s*!fixture/);
  /* 条数可配之后调用变成了多行形态，这里只锁「fixture 与 maxEntries 都传进去了」。 */
  assert.match(seg, /buildSearchDoc\(query, l4, \{[\s\S]{0,160}?fixture/);
  assert.match(seg, /maxEntries:/);
  /* 文件名由代码生成，绝不接受请求体里的路径。 */
  assert.ok(!/b\.(outPath|path|fileName)\b/.test(seg));
});

test("桥侧剪贴板段：共用同一条闸门，但不落盘、不登记产物", () => {
  const start = BRIDGE.indexOf('url.pathname === "/api/search/to-clipboard"');
  const end = BRIDGE.indexOf("/* ---------------- 浏览器扩展通道", start);
  assert.ok(start > 0 && end > start, "找不到 to-clipboard 段");
  const seg = BRIDGE.slice(start, end);
  assert.match(seg, /STOP\.on/, "检索类不进急停豁免");
  assert.match(seg, /buildSearchDoc\(query, l4, \{/, "闸门复用同一份编排，不另写一套");
  assert.ok(!/registerArtifact\(/.test(seg), "剪贴板落点不产生产物，不该登记");
  assert.ok(!/writeFileSync|mkdirSync/.test(seg), "剪贴板落点不落盘");
  /* 一个 HTTP 服务不该有系统副作用：写剪贴板只能由主进程做。
     只查「调剪贴板 API」的形态（先剥注释）—— 注释说明与路由名 to-clipboard 不算。 */
  const code = seg.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/clipboard\s*\./.test(code), "桥不调剪贴板 API");
  assert.ok(!/writeText\s*\(/.test(code), "桥不写剪贴板");
  assert.ok(!/from\s+["']electron["']/.test(code), "桥不引 electron");
  assert.match(seg, /realResults:\s*!fixture/);
});

test("/api/search/status 暴露可证伪的凭据来源状态", () => {
  assert.match(BRIDGE, /credentials:\s*searchCredentials\.describe\(\)/);
  assert.match(BRIDGE, /offlineFixtureEnabled:\s*SEARCH_OFFLINE_FIXTURE/);
  assert.match(BRIDGE, /orchestrator:\s*orchestratorSchema\(\)/);
});
