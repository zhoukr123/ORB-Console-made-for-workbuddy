/**
 * E2E 脚本自身回归：IS_MAIN 守卫、报告格式、断言集合自洽、缺依赖时优雅失败。
 * 不启动浏览器 —— 用 fake worker 直接在 Node 里跑同一套 SW 断言逻辑。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "tools/ext-e2e.mjs"), "utf8");

import { resolveExtDir } from "../tools/ext-load-check.mjs";
import {
  assertionsInWorker, runExtE2E, resolveChrome, toMarkdown, CHROME_CANDIDATES,
} from "../tools/ext-e2e.mjs";

const EXT = resolveExtDir();

test("IS_MAIN 守卫：被单测 import 时不启动浏览器、不 process.exit", () => {
  assert.match(SRC, /const IS_MAIN = process\.argv\[1\]/);
  assert.match(SRC, /if \(IS_MAIN\)/);
  assert.equal(/\bprocess\.exit\s*\(/.test(SRC), false);
});

test("静态契约：独立 profile / pipe / enableExtensions / 不真打站点", () => {
  assert.match(SRC, /pipe: true/);
  assert.match(SRC, /enableExtensions: \[extDir\]/);
  assert.match(SRC, /mkdtempSync/);
  assert.match(SRC, /rmSync\(profile/);
  assert.ok(!SRC.includes("AppData/Local/Google/Chrome/User Data"), "不得指向用户真实 profile");
  assert.ok(!/page\.goto\(|https:\/\/www\.bilibili\.com|https:\/\/s\.taobao\.com/.test(SRC),
    "不真打站点，取数走注入 fixture");
  assert.match(SRC, /fetchImpl: (?:okFetch|countingFetch|badFetch)/);
});

test("缺扩展目录 / 缺 Chrome 时优雅失败，不抛异常", async () => {
  const a = await runExtE2E({ extDir: "", puppeteerImpl: {} });
  assert.equal(a.ok, false);
  assert.match(a.error, /扩展目录未定位/);
  const b = await runExtE2E({ extDir: EXT, chromePath: "", puppeteerImpl: {} });
  assert.equal(b.ok, false);
  assert.match(b.error, /未找到 Chrome/);
});

test("resolveChrome 候选真实存在时才返回，且不返回用户数据目录", () => {
  const p = resolveChrome();
  assert.ok(p === "" || fs.existsSync(p));
  assert.ok(CHROME_CANDIDATES.every((c) => !c.includes("User Data")));
});

test("SW 断言集合在 fake worker 里自洽：全部通过且覆盖 gate 与 site_api", async () => {
  const prevGate = globalThis.ActionGate;
  const prevApi = globalThis.SiteApi;
  try {
    // 两个扩展模块 import 时会自行挂载到 globalThis，等价于真实 SW 环境。
    await import(pathToFileURL(path.join(EXT, "action_gate.js")).href);
    await import(pathToFileURL(path.join(EXT, "site_api.js")).href);
    const fakeWorker = { evaluate: async (fn) => fn() };
    const checks = await assertionsInWorker(fakeWorker);
    assert.ok(checks.length >= 14, "断言数量 " + checks.length);
    const bad = checks.filter((c) => !c.ok);
    assert.deepEqual(bad, [], JSON.stringify(bad));
    assert.ok(checks.some((c) => c.name.includes("零网络调用")));
    assert.ok(checks.some((c) => c.name.includes("视觉档拒绝坐标")));
    assert.ok(checks.some((c) => c.name.includes("fixture 取数成功")));
  } finally {
    globalThis.ActionGate = prevGate;
    globalThis.SiteApi = prevApi;
  }
});

test("报告格式：PASS/FAIL、检查项、未覆盖清单都在", () => {
  const md = toMarkdown({
    ok: false, passed: 1, failed: 1, extensionId: "abc", chromePath: "C:/chrome.exe",
    extDir: EXT, error: "boom",
    checks: [{ name: "示例", ok: true, detail: "ok" }, { name: "坏项", ok: false, detail: "no" }],
    note: "独立临时 profile",
  });
  assert.match(md, /结论：\*\*FAIL\*\*/);
  assert.match(md, /✔ PASS \*\*示例\*\*/);
  assert.match(md, /✘ FAIL \*\*坏项\*\*/);
  assert.match(md, /未覆盖（需人工 smoke）/);
  assert.match(md, /错误：boom/);
});
