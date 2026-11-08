/* 报告B §7 批次B 第8项 V-06 L4 契约单测。
 * 只验契约层，不接 provider、不发真实网络请求（provider 用 fetchImpl 注入）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  L4_SCHEMA_VERSION, L4_FIELDS, L4_REASON_CODES,
  normalizeL4, l4Unavailable, l4Schema,
} from "../searchL4.mjs";
import { createSearchProvider } from "../searchProvider.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");

test("统一 schema：字段集合固定，多余字段一律不透传", () => {
  const r = normalizeL4({
    ok: false, results: [], degraded: true, reasonCode: "bad-query",
    apiKey: "SECRET-SHOULD-NOT-LEAK", rawError: "Bearer SECRET-SHOULD-NOT-LEAK",
    host: "example.com", why: "内部细节", extra: 1,
  });
  assert.deepEqual(Object.keys(r).sort(), [...L4_FIELDS].sort());
  assert.equal(r.schemaVersion, L4_SCHEMA_VERSION);
  assert.equal(r.noVisionFallback, true);
  assert.ok(!JSON.stringify(r).includes("SECRET-SHOULD-NOT-LEAK"), "不许夹带凭据");
  assert.ok(!("host" in r) && !("extra" in r));
});

test("not_available：能力不可用的三种内部原因统一收敛，原始原因放 detail", () => {
  for (const internal of ["provider-disabled", "no-credential", "not_available"]) {
    const r = normalizeL4({ ok: false, results: [], degraded: true, reasonCode: internal });
    assert.equal(r.reasonCode, L4_REASON_CODES.NOT_AVAILABLE, internal);
    assert.equal(r.available, false, internal);
    assert.equal(r.ok, false, internal);
    assert.equal(r.degraded, true, internal);
    if (internal !== "not_available") assert.equal(r.detail, internal);
  }
  assert.equal(normalizeL4({ available: false, ok: true }).reasonCode, "not_available",
    "显式 available:false 也不许谎报成功");
});

test("业务性失败保留各自 reasonCode，且 degraded 恒为 true", () => {
  for (const code of ["bad-query", "stopped", "requires_user_authorization",
                      "timeout", "rate-limited", "http-error", "bad-json", "empty-results"]) {
    const r = normalizeL4({ ok: false, results: [], degraded: true, reasonCode: code });
    assert.equal(r.reasonCode, code);
    assert.equal(r.available, true, code + " 不该被当成能力不可用");
    assert.equal(r.degraded, true);
    assert.equal(r.ok, false);
  }
});

test("成功结果：ok:true / degraded:false / reasonCode 空 / results 原样保留", () => {
  const rows = [{ title: "A", url: "https://a.com", snippet: "s", source: "a.com" }];
  const r = normalizeL4({ ok: true, results: rows, degraded: false, reasonCode: "", elapsedMs: 12 });
  assert.equal(r.ok, true);
  assert.equal(r.available, true);
  assert.equal(r.degraded, false);
  assert.equal(r.reasonCode, "");
  assert.deepEqual(r.results, rows);
  assert.equal(r.elapsedMs, 12);
  assert.equal(normalizeL4({ elapsedMs: -1 }).elapsedMs, 0, "负耗时不许外传");
  assert.equal(normalizeL4({ elapsedMs: "abc" }).elapsedMs, 0);
});

test("l4Unavailable / l4Schema：构造与自检都不带配置或凭据", () => {
  const u = l4Unavailable("provider-disabled");
  assert.equal(u.reasonCode, "not_available");
  assert.equal(u.detail, "provider-disabled");
  const s = l4Schema();
  assert.equal(s.schemaVersion, L4_SCHEMA_VERSION);
  assert.deepEqual(s.fields, [...L4_FIELDS]);
  assert.ok(s.reasonCodes.includes("not_available"));
  assert.equal(s.noVisionFallback, true);
  assert.ok(!JSON.stringify(s).includes("apiKey"));
});

test("联调：默认关闭的 provider → L4 not_available；成功 provider → L4 ok", async () => {
  const off = createSearchProvider({ enabled: false, fetchImpl: async () => { throw new Error("不该发请求"); } });
  const raw = await off.search("天气", {});
  assert.equal(raw.reasonCode, "provider-disabled", "provider 内部仍是 v1 细粒度拒因");
  assert.equal(raw.schemaVersion, 1);
  const l4 = normalizeL4(raw);
  assert.equal(l4.reasonCode, "not_available");
  assert.equal(l4.available, false);
  assert.equal(l4.schemaVersion, 2);
  assert.equal(off.stats().requests, 0, "默认关闭绝不发请求");

  const on = createSearchProvider({
    enabled: true, apiKey: "k",
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ results: [
      { url: "https://example.com/a", title: "标题", snippet: "摘要" },
    ] }) }),
  });
  const okL4 = normalizeL4(await on.search("天气", {}));
  assert.equal(okL4.ok, true);
  assert.equal(okL4.available, true);
  assert.equal(okL4.results.length, 1);
  assert.equal(okL4.noVisionFallback, true);
});

test("桥契约：/api/search 全部分支统一过 L4，业务失败不再回 4xx", () => {
  assert.match(BRIDGE, /normalizeL4\(r\)/);
  assert.equal((BRIDGE.match(/normalizeL4\(/g) || []).length >= 4, true,
    "授权失败 / bad-query / stopped / provider 结果 四个分支都要过 L4");
  assert.match(BRIDGE, /reasonCode: "bad-query", elapsedMs: 0/);
  assert.match(BRIDGE, /pathname === "\/api\/search\/schema"/);
  assert.match(BRIDGE, /l4Schema\(\)/);
  assert.ok(!/send\(res, 400, \{ ok: false, degraded: true, reasonCode: "bad-query"/.test(BRIDGE),
    "业务失败不许再回 400");
  const pub = BRIDGE.match(/const PUBLIC_PATHS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(pub && !pub[1].includes("search"), "schema 自检也不该免鉴权");
});
