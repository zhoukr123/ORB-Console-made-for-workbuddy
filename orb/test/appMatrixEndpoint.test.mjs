/* /api/app-matrix 与面板分支的契约测试（静态，不起桥）。
 * 锁三件事：
 *   ① 接口在 bridge.mjs 里、走统一 token 鉴权（不进 PUBLIC_PATHS）；
 *   ② 响应字段形状与 appIntent 的纯函数输出逐字对齐；
 *   ③ 面板分支真的消费了 probe，且没有复制第二份能力表。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appMatrix, APP_COUNT, DEEP_LINKS, CONFIDENCE_GATE, resolveAppAction } from "../appIntent.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");
const PANEL = fs.readFileSync(path.join(ROOT, "desktop", "panel.html"), "utf8");

test("接口已注册为 GET /api/app-matrix，且未进 PUBLIC_PATHS", () => {
  assert.match(BRIDGE, /req\.method === "GET" && url\.pathname === "\/api\/app-matrix"/);
  const pub = BRIDGE.match(/const PUBLIC_PATHS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(pub, "找不到 PUBLIC_PATHS");
  assert.ok(!pub[1].includes("app-matrix"), "自检接口不该免鉴权");
});

test("接口响应字段与 appIntent 纯函数对齐", () => {
  assert.match(BRIDGE, /count: rows\.length/);
  assert.match(BRIDGE, /appCount: APP_COUNT/);
  assert.match(BRIDGE, /confidenceGate: CONFIDENCE_GATE/);
  assert.match(BRIDGE, /deepLinks: DEEP_LINKS/);
  const rows = appMatrix();
  assert.equal(rows.length, APP_COUNT);
  assert.equal(CONFIDENCE_GATE, 0.8);
  assert.equal(Object.keys(DEEP_LINKS).length, 0);
});

test("接口支持 q 探针，返回体就是 resolveAppAction 的结果", () => {
  assert.match(BRIDGE, /searchParams\.get\("q"\)/);
  assert.match(BRIDGE, /probe: resolveAppAction\(probe\)/);
  const r = resolveAppAction("用微信搜一下张三");
  assert.equal(r.transport, "clipboard");
  assert.equal(r.confidence, 0.6);
});

test("面板分支消费 /api/app-matrix?q=，且本地没有第二份能力表", () => {
  assert.match(PANEL, /\/api\/app-matrix\?q=/);
  assert.match(PANEL, /m && m\.probe/);
  assert.match(PANEL, /ai\.confidence >= 0\.8/);
  assert.ok(PANEL.includes("i.test(ai.url)"), "面板分支必须做 http(s) 协议闸");
  // 面板不得内联复制 webSearch URL 表（否则就成了第二份真相）
  assert.ok(!PANEL.includes("search.bilibili.com/all?keyword="), "面板不该复制能力表 URL");
});

test("面板剪贴板兜底不模拟点击、不 spawn 客户端", () => {
  const seg = PANEL.slice(PANEL.indexOf("应用意图（报告A"), PANEL.indexOf("确定性网页指令直接执行"));
  assert.match(seg, /writeClipboard/);
  assert.match(seg, /不模拟点击/);
  // 只查实际调用，不查注释文字（注释里会提到这些词）
  assert.ok(!/\bspawn\s*\(|execFile\s*\(|shell\.openPath\s*\(/.test(seg), "不该在渲染层拉起任意 exe");
});

test("面板异常时静默落回常规快速路，不阻塞用户", () => {
  const seg = PANEL.slice(PANEL.indexOf("应用意图（报告A"), PANEL.indexOf("确定性网页指令直接执行"));
  assert.match(seg, /catch \{ \/\* 桥不在线就静默落回常规快速路/);
});

/* 2026-11-08：搜索 + 进入官网的复合指令。桥负责给干净关键词，面板负责落地。 */
test("接口带回复合网页指令 landing，且不伪装成应用搜索", () => {
  assert.match(BRIDGE, /landing: resolveWebLanding\(probe\)/);
  const r = resolveAppAction("在夸克浏览器中搜索湖南大学并进入其官网");
  assert.equal(r.transport, "none");
  assert.equal(r.app, null);
  assert.equal(r.webLanding.keyword, "湖南大学");
  assert.equal(r.webLanding.siteQuery, "湖南大学官网");
});

test("面板消费 landing：先解析官网、过 0.8 闸门，退路是干净搜索页", () => {
  assert.match(PANEL, /const wl = m && m\.landing/);
  assert.match(PANEL, /\/api\/resolve-site\?q=' \+ encodeURIComponent\(wl\.siteQuery \|\| wl\.keyword\)/);
  assert.match(PANEL, /conf >= 0\.8/);
  assert.match(PANEL, /quickWebOpen\(wl\.searchUrl\)/);
  assert.match(PANEL, /没有下发到指定浏览器的通道/, "必须如实说明不是夸克客户端");
});
