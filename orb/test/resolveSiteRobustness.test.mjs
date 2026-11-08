/* 官网解析器健壮性回归（2026-11-08 事故驱动）。
 *
 * 事故链（orb.log 实录）：
 *   ① cn.bing.com / www.bing.com 串行各 1.8s，双双超时 → 「抖音官网」被打回搜索页；
 *   ② 「抖音网页版官网」解析出 www.douyin.com，却被"霸屏站"规则误杀 ——
 *      因为 siteCore 只剥了「官网」留下「网页版」，douyin.com 的标题
 *      「抖音 - 记录美好生活」不以「抖音网页版」开头，selfTitled 判不出来。
 *
 * siteCore / siteSpamDomain / fetchSiteRss 都是 bridge.mjs 内部函数（不导出），
 * 这里用"抽函数体 + new Function"的方式做功能级验证，静态断言只锁结构。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BRIDGE = fs.readFileSync(path.join(import.meta.dirname, "..", "bridge.mjs"), "utf8");

/* 按 AST 平衡截函数体 —— 不引第三方解析器，站点级括号配平对这几个函数够用。 */
function extractFn(name) {
  const start = BRIDGE.indexOf("function " + name + "(");
  assert.ok(start >= 0, "找不到 function " + name);
  let i = BRIDGE.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (; i < BRIDGE.length; i++) {
    const c = BRIDGE[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  assert.ok(end > start, name + " 函数体不完整");
  return BRIDGE.slice(start, end);
}

test("siteCore 循环剥后缀：「抖音网页版官网」必须归一到「抖音」", () => {
  const siteCore = new Function("return " + extractFn("siteCore"))();
  assert.equal(siteCore("抖音网页版官网"), "抖音", "连环后缀必须剥干净，否则霸屏规则会误杀真官网");
  assert.equal(siteCore("抖音官网"), "抖音");
  assert.equal(siteCore("微信官网下载"), "微信");
  assert.equal(siteCore("湖南大学官网"), "湖南大学");
  /* 反向：不能剥过头 —— "平台"是站名的一部分 */
  assert.equal(siteCore("国家政务服务平台"), "国家政务服务平台");
  assert.equal(siteCore("淘宝"), "淘宝");
});

test("fetchSiteRss 必须并行竞速，超时上限 3 秒（串行 1.8s 双超时事故）", () => {
  assert.match(BRIDGE, /const SITE_RSS_TIMEOUT_MS = 3000;/);
  assert.match(BRIDGE, /AbortSignal\.timeout\(SITE_RSS_TIMEOUT_MS\)/, "超时值不许再写死字面量");
  const seg = BRIDGE.slice(
    BRIDGE.indexOf("async function fetchSiteRss("),
    BRIDGE.indexOf("function pickSite")
  );
  assert.match(seg, /for \(const host of SITE_RSS_HOSTS\)/, "两个 host 要并发发起");
  assert.ok(
    !/for \(const host of SITE_RSS_HOSTS\) \{\s*\n\s*try \{/.test(seg),
    "不允许退回串行 await —— 那正是双超时打回搜索页的旧实现"
  );
});

test("siteSpamDomain 的 selfTitled 必须认「core 比 title 长」的自指（douyin 误杀回归）", () => {
  const seg = BRIDGE.slice(
    BRIDGE.indexOf("function siteSpamDomain"),
    BRIDGE.indexOf("/* Bing 的 RSS 接口会偶发")
  );
  assert.match(seg, /core\.startsWith\(t\)/, "title「抖音」短于 core「抖音网页版」时也该算自指");
});
