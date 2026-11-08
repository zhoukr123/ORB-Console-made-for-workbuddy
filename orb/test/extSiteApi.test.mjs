/**
 * ORB 侧交叉契约：扩展 site_api.js 与桥 hostDataApi.mjs 的端点白名单必须完全一致，
 * 且 B1 接线后闸门红线、扩展加载验收都不能退化。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
import { resolveExtDir } from "../tools/ext-load-check.mjs";
import { checkExtension } from "../tools/ext-load-check.mjs";
import { API_ENDPOINTS as HOST_ENDPOINTS } from "../hostDataApi.mjs";

const EXT = resolveExtDir();
const extRead = (f) => fs.readFileSync(path.join(EXT, f), "utf8");
const extApi = await import(pathToFileURL(path.join(EXT, "site_api.js")).href);

test("扩展与桥侧端点白名单逐字段一致，防止两份配置漂移", () => {
  const a = Object.keys(extApi.API_ENDPOINTS).sort();
  const b = Object.keys(HOST_ENDPOINTS).sort();
  assert.deepEqual(a, b);
  for (const k of a) {
    assert.equal(extApi.API_ENDPOINTS[k].url, HOST_ENDPOINTS[k].url, k + ".url");
    assert.deepEqual([...extApi.API_ENDPOINTS[k].params], [...HOST_ENDPOINTS[k].params], k + ".params");
    assert.equal(extApi.API_ENDPOINTS[k].pick, HOST_ENDPOINTS[k].pick, k + ".pick");
    /* 分块解包的规则也要一致：只比 url/pick 会漏掉"同一地址、不同取数口径"。 */
    assert.deepEqual(
      extApi.API_ENDPOINTS[k].pickBlock ? { ...extApi.API_ENDPOINTS[k].pickBlock } : null,
      HOST_ENDPOINTS[k].pickBlock ? { ...HOST_ENDPOINTS[k].pickBlock } : null,
      k + ".pickBlock",
    );
    assert.equal(extApi.API_ENDPOINTS[k].label, HOST_ENDPOINTS[k].label, k + ".label");
  }
  /* B 站旧地址已 412，两边都不许再写回去 */
  assert.equal(/search\/type/.test(extApi.API_ENDPOINTS["bilibili.com/search_uploader"].url), false);
});

test("扩展侧默认零外发：不带 enabled 返回 disabled，status 默认值也是 false", async () => {
  let called = 0;
  const r = await extApi.fetchSiteData(
    { site: "bilibili.com", action: "search_uploader" },
    { fetchImpl: async () => { called += 1; throw new Error("must not fetch"); } },
  );
  assert.equal(r.code, "disabled");
  assert.equal(called, 0);
  assert.equal(extApi.siteApiStatus().enabled, false);
});

test("扩展侧 SSRF 防护覆盖桥侧同款禁例", () => {
  for (const u of [
    "http://api.bilibili.com/x", "https://127.0.0.1/x", "https://10.0.0.1/x",
    "https://169.254.169.254/latest/meta-data", "https://api.bilibili.com:8443/x",
  ]) assert.equal(extApi.isSafeUrl(u), false, u);
});

test("B1 接线静态契约：dispatch 有分派、闸门仍无网络、enabled 严格判定", () => {
  const bg = extRead("background.js");
  const gate = extRead("action_gate.js");
  const api = extRead("site_api.js");
  assert.match(bg, /import\s*\{[^}]*fetchSiteData[^}]*\}\s*from\s*["']\.\/site_api\.js["']/);
  assert.match(bg, /case "site_api\.fetch":/);
  assert.match(bg, /case "site_api\.status":/);
  assert.match(bg, /enabled: params\.enabled === true/);
  assert.match(api, /enabled !== true/);
  assert.equal(/\bfetch\s*\(/.test(gate), false, "action_gate.js 必须保持纯逻辑");
  assert.equal(/api_call_register/.test(api), false);
});

test("B1 落地后扩展加载验收仍全绿，且新模块被覆盖", () => {
  const r = checkExtension();
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.ok(r.checks.some((c) => c.name.includes("site_api.js")));
  assert.ok(r.checks.some((c) => c.name.includes("site_api.fetch") && c.ok));
  assert.ok(r.checks.some((c) => c.name.includes("默认零外发") && c.ok));
  assert.ok(r.passed >= 30);
});
