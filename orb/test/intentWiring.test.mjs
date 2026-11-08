/* 意图闭环接线（2026-11-07 第 3/4/5 步）：静态防漂移。
 *
 * 这一层没有可单测的纯逻辑，最容易出的错是「模块写好了，端点没接」或「接了但默认就外呼」。
 * 所以判据直接钉在源码接线形状上：
 *   · /api/search/misses 存在，且三个解析端点共用 parseForSink（不许各自演化第二套判定）；
 *   · 兜底默认关（ORB_INTENT_LLM 必须显式为 "1"），且有自定义模型才可能外呼；
 *   · 两个新模块都进了打包清单（漏登记 = 便携版启动即崩）；
 *   · 面板只按 sink 分派 + 显示低置信说明，不自己判定、不持有开关。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const BRIDGE = read("bridge.mjs");
const PANEL = read("desktop/panel.html");
const PACK = read("pack.cjs");

test("miss 只读端点存在，且支持清空", () => {
  assert.ok(BRIDGE.includes('"/api/search/misses"'), "缺 /api/search/misses 端点");
  const at = BRIDGE.indexOf('"/api/search/misses"');
  const seg = BRIDGE.slice(at, at + 700);
  assert.match(seg, /missLog\.stats\(\)/);
  assert.match(seg, /missLog\.list\(/);
  assert.match(seg, /b\.clear === true/);
});

test("三个解析端点共用 parseForSink，不许各自演化第二套判定", () => {
  assert.match(BRIDGE, /async function parseForSink\(text, sink\)/);
  assert.match(BRIDGE, /parseForSink\(text, null\)/, "/api/search/plan 未走统一入口");
  assert.match(BRIDGE, /parseForSink\(intentText, "doc"\)/, "to-doc 未走统一入口");
  assert.match(BRIDGE, /parseForSink\(intentText, "clipboard"\)/, "to-clipboard 未走统一入口");
});

test("三个端点都在未命中时记录 miss（否则闭环等于没接）", () => {
  const calls = BRIDGE.split("recordIntentMiss(").length - 1;
  assert.ok(calls >= 4, `recordIntentMiss 只出现 ${calls} 次（定义 1 + 调用 ≥3）`);
});

test("兜底默认关：必须显式 ORB_INTENT_LLM=1 才可能外呼", () => {
  assert.match(BRIDGE, /enabled:\s*process\.env\.ORB_INTENT_LLM === "1"/);
  /* 没有自定义模型就当作不可用：不报错、不外呼。 */
  assert.match(BRIDGE, /no-custom-model/);
});

test("两个新模块都进了便携版打包清单", () => {
  assert.match(PACK, /'intentMissLog\.mjs'/);
  assert.match(PACK, /'intentFallback\.mjs'/);
});

test("面板只按 sink 分派，低置信只做说明，不自己判定也不持开关", () => {
  assert.match(PANEL, /plan\.confidence === 'low'/);
  assert.match(PANEL, /function clarifyHint\(c\)/);
  assert.match(PANEL, /if \(sink === 'doc'\) return await runSearchToDoc\(text, hint\)/);
  assert.ok(!PANEL.includes("ORB_INTENT_LLM"), "面板不该持有兜底开关");
  /* 说明文案必须是「我做了什么」，不是「可能怎样」。 */
  assert.match(PANEL, /两个任务，这次只做了第一个/);
});
