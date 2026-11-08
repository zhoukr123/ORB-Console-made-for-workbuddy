/* API 通道开关的静态契约：界面 / 扩展 / 桥 / 打包四处必须对得上。
 *
 * 为什么用静态断言而不是只跑单测：这条链是跨进程的（扩展页 → SW → native host
 * → 桥），任何一环名字写错都不会在单测里报错，只会在用户点开关时静默失效。
 * 这里把"名字对得上"钉死，配合 apiChannel/browserProvider 的行为单测补语义。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const POPUP_HTML = "browser-extension/popup.html";
const POPUP_JS = "browser-extension/popup.js";
const BG_JS = "browser-extension/background.js";
const BRIDGE = "bridge.mjs";
const PACK = "pack.cjs";

test("popup 里有开关控件，且是独立文件加载的脚本（无内联脚本 / 无内联事件）", () => {
  const html = read(POPUP_HTML);
  assert.match(html, /<input[^>]+type="checkbox"[^>]+id="apich"/, "缺少开关控件");
  assert.match(html, /<script src="popup\.js"><\/script>/);
  assert.equal(/<script(?![^>]*\bsrc=)/.test(html), false, "MV3 不允许内联 <script>");
  assert.equal(/\son[a-z]+\s*=\s*["']/i.test(html), false, "不要内联事件处理器");
});

test("popup 说明了开启后的效果与关闭后的退路（用户要求的说明）", () => {
  const html = read(POPUP_HTML);
  for (const kw of ["已登记端点", "Cookie", "视觉兜底", "https:443", "错误码"]) {
    assert.ok(html.includes(kw), `说明文案缺少关键事实：${kw}`);
  }
  assert.match(html, /关闭后（默认）/, "必须写清默认是关");
  assert.match(html, /桥未连接时开关不可用/, "桥不在时要说明开关无效，不能假装能用");
});

test("popup.js 只发意图、不本地存权威值", () => {
  const js = read(POPUP_JS);
  assert.match(js, /type:\s*['"]orb\.apiChannel\.set['"]/);
  assert.equal(/chrome\.storage[^\n]*apiChannel/i.test(js), false, "开关权威值不能存在扩展侧");
  assert.match(js, /disabled\s*=\s*true/, "离线/未知状态要禁用开关");
  assert.match(js, /lastApi/, "提交失败要能回滚界面");
});

test("background 收开关消息、转发 settings、并处理 settings_ack", () => {
  const js = read(BG_JS);
  assert.match(js, /message\.type === ['"]orb\.apiChannel\.set['"]/);
  assert.match(js, /type:\s*['"]settings['"],\s*api_channel_enabled/);
  assert.match(js, /case ['"]settings_ack['"]/);
  assert.match(js, /api_channel:\s*apiChannelSnapshot\(\)/, "status 快照要带开关状态");
  assert.match(js, /typeof msg\.api_channel_enabled === 'boolean'/, "hello_ack 要读桥回带的真值");
});

test("桥侧强制：开关关时 gov.host.fetch 直接拒绝，不再看调用方的 enabled", () => {
  const src = read(BRIDGE);
  const idx = src.indexOf('case "gov.host.fetch"');
  assert.ok(idx > 0);
  const block = src.slice(idx, idx + 900);
  assert.match(block, /if \(!apiChannel\.isEnabled\(\)\)/, "缺少开关判定");
  assert.match(block, /USER_DISABLED/, "拒绝必须带明确错误码");
  assert.equal(/b\.enabled === true \? govHost/.test(block), false, "旧的按调用方参数放行必须撤掉");
});

test("桥侧强制：api 通道的执行计划同样受开关控制", () => {
  const src = read(BRIDGE);
  const idx = src.indexOf('case "gov.plan.run"');
  assert.ok(idx > 0);
  const block = src.slice(idx, idx + 900);
  assert.match(block, /apiChannel\.isEnabled\(\)/);
  assert.match(block, /host_data_api/);
});

test("桥侧暴露状态与写入口（供控制台/面板共用同一份状态）", () => {
  const src = read(BRIDGE);
  assert.match(src, /case "api\.channel\.status"/);
  assert.match(src, /case "api\.channel\.set"/);
  assert.match(src, /api_channel:\s*apiChannel\.status\(\)/, "/api/browser/status 要回带状态");
  assert.match(src, /import \{ createApiChannel, USER_DISABLED \} from "\.\/apiChannel\.mjs"/);
});

test("打包清单必须包含新模块，否则便携版运行期才报 ERR_MODULE_NOT_FOUND", () => {
  assert.match(read(PACK), /'apiChannel\.mjs'/);
});

test("扩展侧不 import 桥模块（跨边界只能走消息，不能共享代码）", () => {
  for (const f of [POPUP_JS, BG_JS]) {
    const src = read(f);
    assert.equal(/from\s+['"][^'"]*apiChannel\.mjs['"]/.test(src), false, `${f} 不应直接 import 宿主模块`);
  }
});

test("端点数与端点名由桥回带，页面里不写死（扩白名单时文案自动跟随）", () => {
  const html = read(POPUP_HTML);
  assert.equal(/2 个已登记端点/.test(html), false, "数量不能硬编码在页面里");
  assert.match(html, /id="apicount"/);
  assert.match(html, /id="apinames"/);
  const js = read(POPUP_JS);
  assert.match(js, /\$\('apicount'\)\.textContent/);
  assert.match(js, /\$\('apinames'\)\.textContent/);
  assert.match(read(BRIDGE), /api_channel_endpoints:\s*govHost\.listEndpoints\(\)/, "桥要回带端点清单");
});

test("开关默认值三处一致：模块默认关 / hello_ack 不猜 / 界面写默认关", () => {
  const mod = read("apiChannel.mjs");
  assert.match(mod, /enabled: false/);
  const html = read(POPUP_HTML);
  assert.match(html, /关闭后（默认）/);
  assert.match(read(POPUP_JS), /零外发（默认）/, "界面状态文案要写明默认零外发");
  assert.match(read(BG_JS), /enabled: false, known: false/);
});
