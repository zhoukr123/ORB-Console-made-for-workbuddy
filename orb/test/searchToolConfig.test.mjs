/* 设置 › 通道 › 检索工具：配置护栏单测。
 * 全部用临时目录 + 假 key，零真实凭据、零外发、零 electron 依赖。
 * 2026-11-06 晚：AnySearch 置顶、自定义名称、免 Key 匿名档。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const C = require("../desktop/searchToolConfig.cjs");
const { ADAPTER_IDS } = await import(new URL("../searchProviderAdapters.mjs", import.meta.url));

const KEY = "FAKE-USER-APPLIED-KEY-1234";
const INERT = { enabled: false, provider: "anysearch", model: "", endpoint: "", customName: "" };

function tmpFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-search-tool-"));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } });
  return path.join(dir, "search-tool.json");
}

test("默认 inert：不配置就是关闭 + AnySearch 置顶", () => {
  assert.deepEqual(C.normalize({}, {}), INERT);
  assert.equal(C.DEFAULT_PROVIDER, "anysearch");
  assert.deepEqual([...C.PROVIDERS], ["anysearch", "deepseek", "zhipu", "baidu", "custom"]);
  assert.equal(C.PROVIDERS[0], "anysearch", "用户要求免费额度最大的选项排第一");
});

test("服务商白名单与 bridge 适配器注册表完全一致（防两边漂移）", () => {
  assert.deepEqual([...C.PROVIDERS], [...ADAPTER_IDS]);
  assert.equal(C.normalize({ provider: "NOPE" }, {}).provider, "anysearch");
  assert.equal(C.normalize({ provider: "  ZHIPU  " }, {}).provider, "zhipu");
  assert.equal(C.normalize({ provider: "Baidu" }, {}).provider, "baidu");
  assert.equal(C.normalize({ provider: "custom" }, {}).provider, "custom");
});

test("enabled 只认字面 true，配置写 '1' / 1 / 'true' 都不会偷偷打开外发", () => {
  for (const v of ["1", 1, "true", null, undefined, {}, []]) {
    assert.equal(C.normalize({ enabled: v }, {}).enabled, false, String(v));
  }
  assert.equal(C.normalize({ enabled: true }, {}).enabled, true);
  assert.equal(C.normalize({ provider: "baidu" }, { enabled: true }).enabled, true);
  assert.equal(C.normalize({ enabled: false }, { enabled: true }).enabled, false);
});

test("端点协议闸：只放行 http(s)，坏 URL / 非 http 协议一律清空", () => {
  assert.equal(C.safeEndpoint("javascript:alert(1)"), "");
  assert.equal(C.safeEndpoint("file:///C:/x"), "");
  assert.equal(C.safeEndpoint("not a url"), "");
  assert.equal(C.safeEndpoint("ftp://example.org"), "");
  assert.equal(C.safeEndpoint("  https://example.org/v2/search  "), "https://example.org/v2/search");
  assert.equal(C.safeEndpoint("https://x" + "a".repeat(500)).length <= C.MAX_ENDPOINT_LEN, true);
});

test("自定义名称：不限制填什么，但去控制字符、限长，绝不参与 URL 拼接", () => {
  assert.equal(C.safeName("  自建 SearXNG  "), "自建 SearXNG");
  assert.equal(C.safeName("A\nB\tC\u0000D"), "A B C D");
  assert.ok(C.safeName("X".repeat(200)).length <= C.MAX_NAME_LEN);
  assert.equal(C.normalize({ provider: "custom", customName: "公司内部检索" }, {}).customName, "公司内部检索");
});

test("配置文件只写五个非敏感字段：误传 apiKey 也会被丢弃", (t) => {
  const f = tmpFile(t);
  const c = C.writeConfig(f, {
    enabled: true, provider: "baidu", model: "ernie", apiKey: KEY, password: "x",
  });
  assert.deepEqual(c, { enabled: true, provider: "baidu", model: "ernie", endpoint: "", customName: "" });
  const raw = fs.readFileSync(f, "utf8");
  assert.ok(!raw.includes(KEY), "key 绝不能落盘到配置文件");
  assert.ok(!raw.includes("apiKey"));
  assert.ok(!raw.includes("password"));
  assert.deepEqual(C.readConfig(f), c);
});

test("读坏 JSON / 文件不存在都回落 inert，不抛到面板", (t) => {
  const f = tmpFile(t);
  assert.deepEqual(C.readConfig(f), INERT);
  fs.writeFileSync(f, "{half json", "utf8");
  assert.deepEqual(C.readConfig(f), INERT);
});

test("面板只读视图只有掩码，绝不含完整 key 或 apiKey 字段", () => {
  const v = C.publicView(
    { enabled: true, provider: "zhipu", model: "search_pro" },
    { apiKey: KEY, hasKey: true, encrypted: true, configured: true },
  );
  assert.equal(v.hasKey, true);
  assert.equal(v.keyMask, "••••1234");
  assert.equal(v.effective, true);
  assert.ok(!JSON.stringify(v).includes(KEY), "完整 key 不得出现在面板视图里");
  assert.ok(!("apiKey" in v));
  assert.deepEqual(v.providers, ["anysearch", "deepseek", "zhipu", "baidu", "custom"]);

  const off = C.publicView({ enabled: false }, { apiKey: KEY, hasKey: true });
  assert.equal(off.effective, false);
  const noKey = C.publicView({ enabled: true }, { apiKey: "", hasKey: false });
  assert.equal(noKey.keyMask, "");
  assert.equal(noKey.effective, true, "默认 AnySearch 支持匿名，无 key 也算有效");
  assert.equal(noKey.anonymous, true);
});

test("bridgeEnv：从没配置过 → 返回空对象，不越权覆盖用户手工环境变量", () => {
  assert.deepEqual(C.bridgeEnv({ enabled: true }, KEY, false), {});
  assert.deepEqual(C.bridgeEnv({ enabled: true }, KEY, undefined), {});
});

test("bridgeEnv：配置过但关闭 / 没 key 且非匿名档 → 显式 inert", () => {
  const off = C.bridgeEnv({ enabled: false, provider: "baidu", model: "" }, KEY, true);
  assert.equal(off.ORB_SEARCH_ENABLED, "0");
  assert.equal(off.ORB_SEARCH_CREDENTIAL_SOURCE, "inert");
  assert.equal(off.ORB_SEARCH_API_KEY, "");

  const noKey = C.bridgeEnv({ enabled: true, provider: "baidu" }, "", true);
  assert.equal(noKey.ORB_SEARCH_ENABLED, "0");
  assert.equal(noKey.ORB_SEARCH_API_KEY, "");
});

test("bridgeEnv：显式启用 + 有 key 才注入完整四项与可选端点", () => {
  const e = C.bridgeEnv(
    { enabled: true, provider: "zhipu", model: "search_std", endpoint: "https://example.org/v4" },
    KEY, true,
  );
  assert.equal(e.ORB_SEARCH_ENABLED, "1");
  assert.equal(e.ORB_SEARCH_CREDENTIAL_SOURCE, "env");
  assert.equal(e.ORB_SEARCH_API_KEY, KEY);
  assert.equal(e.ORB_SEARCH_PROVIDER, "zhipu");
  assert.equal(e.ORB_SEARCH_MODEL, "search_std");
  assert.equal(e.ORB_SEARCH_ENDPOINT, "https://example.org/v4");
  assert.ok(!("ORB_SEARCH_ENDPOINT" in C.bridgeEnv({ enabled: true, provider: "baidu" }, KEY, true)));
});

test("bridgeEnv：匿名档无需 key 也能启用，但凭据来源必须是 inert", () => {
  for (const provider of ["anysearch", "custom"]) {
    const e = C.bridgeEnv({ enabled: true, provider }, "", true);
    assert.equal(e.ORB_SEARCH_ENABLED, "1", provider);
    assert.equal(e.ORB_SEARCH_CREDENTIAL_SOURCE, "inert", provider + " 匿名不读任何凭据");
    assert.equal(e.ORB_SEARCH_API_KEY, "", provider);
    assert.equal(e.ORB_SEARCH_PROVIDER, provider);
  }
  /* 匿名档关掉时仍必须强制 inert */
  const off = C.bridgeEnv({ enabled: false, provider: "anysearch" }, "", true);
  assert.equal(off.ORB_SEARCH_ENABLED, "0");
  /* 匿名档填了 key 就走正常 env 来源 */
  const keyed = C.bridgeEnv({ enabled: true, provider: "anysearch" }, KEY, true);
  assert.equal(keyed.ORB_SEARCH_CREDENTIAL_SOURCE, "env");
  assert.equal(keyed.ORB_SEARCH_API_KEY, KEY);
});

test("bridgeEnv：自定义端点会注入，但名称只是标签、不进环境变量", () => {
  const e = C.bridgeEnv({
    enabled: true, provider: "custom", customName: "公司内部检索",
    endpoint: "https://intra.example.org/v1/search",
  }, "", true);
  assert.equal(e.ORB_SEARCH_ENDPOINT, "https://intra.example.org/v1/search");
  assert.ok(!JSON.stringify(e).includes("公司内部检索"), "名称不进桥环境变量");
  assert.equal(e.ORB_SEARCH_PROVIDER, "custom");
});

test("hasConfigFile：写入前 false，写入后 true", (t) => {
  const f = tmpFile(t);
  assert.equal(C.hasConfigFile(f), false);
  C.writeConfig(f, { enabled: false });
  assert.equal(C.hasConfigFile(f), true);
});
