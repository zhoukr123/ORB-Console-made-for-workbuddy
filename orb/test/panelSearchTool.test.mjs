/* 设置 › 通道 › 检索工具：面板结构与接线防漂移静态测试。
 *
 * 判据来自用户的明确要求：
 *   ① 后台 Agent 上移到浏览器通道上方；
 *   ② 检索工具作为**独立新栏目**放在浏览器通道下方（不是塞进浏览器通道里）；
 *   ③ AnySearch 排服务商第一位（用户 2026-11-06 21:54 起要求选项标签不带额度宣传）；
 *   ④ 或：不限制服务商名称，允许用户自行填入（自定义名称 + 端点）。
 * 再加一层安全判据：明文 Key 只在主进程，面板/preload 都拿不到；
 * 桥仍只认启动期环境变量，没有开任何运行时配置端点。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const PANEL = read("desktop/panel.html");
const MAIN = read("desktop/main.js");
const PRELOAD = read("desktop/preload.js");
const VAULT = read("desktop/vault.js");
const CONFIG = read("desktop/searchToolConfig.cjs");
const PACK = read("pack.cjs");
const BRIDGE = read("bridge.mjs");
const PROVIDER = read("searchProvider.mjs");
const PROBE = read("desktop/searchProbe.cjs");

function chanPane() {
  const from = PANEL.indexOf('<div class="setpane" data-pane="chan">');
  const to = PANEL.indexOf('<div class="slothead">划词工具条', from);
  assert.ok(from >= 0 && to > from, "找不到「设置 › 通道」面板区间");
  return PANEL.slice(from, to);
}

test("顺序：前台 → 后台 Agent → 浏览器通道 → 检索工具（独立栏目）", () => {
  const pane = chanPane();
  const iFront = pane.indexOf("前台通道");
  const iAgent = pane.indexOf("后台 Agent（WorkBuddy CLI）");
  const iBrowser = pane.indexOf('<div class="slotbox" id="browser-chan-box">');
  const iTool = pane.indexOf('<div class="slotbox" id="search-tool-box">');
  assert.ok(iFront >= 0 && iAgent >= 0 && iBrowser >= 0 && iTool >= 0, "四个栏目都要在通道面板里");
  assert.ok(iFront < iAgent, "前台通道仍应排第一");
  assert.ok(iAgent < iBrowser, "后台 Agent 必须在浏览器通道上方");
  assert.ok(iBrowser < iTool, "检索工具必须在浏览器通道下方");

  const between = pane.slice(iBrowser, iTool);
  assert.match(between, /\n {6}<\/div>\s*\n/, "浏览器通道 slotbox 必须先闭合");
  assert.ok(!between.includes('id="search-tool-box"'), "检索工具不得嵌在浏览器通道内部");
});

test("新栏目控件齐全，API Key 输入框是 password 且默认关闭说明在案", () => {
  const pane = chanPane();
  for (const id of [
    "st-provider", "st-model", "st-model-hint", "st-key", "st-keystate",
    "st-paste", "st-enable", "st-save", "st-clear", "st-refresh", "st-test", "st-state", "st-msg",
    "st-custom-name", "st-endpoint", "st-custom-field", "st-endpoint-field",
  ]) {
    assert.ok(pane.includes(`id="${id}"`), `检索工具栏目缺少控件 ${id}`);
  }
  assert.match(pane, /<input id="st-key" type="password"/);
  assert.match(pane, /<select id="st-provider"/);
  assert.match(pane, /结构化搜索|独立于浏览器通道/);
  assert.match(pane, /保存后需重启 ORB 控制台生效/);
  assert.match(pane, /不读取本机 dsh 凭据库/);
  assert.match(pane, /零外发、零计费/);
  for (const provider of ["anysearch", "deepseek", "zhipu", "baidu", "custom"]) {
    assert.ok(pane.includes(`value="${provider}"`), `缺少服务商 ${provider}`);
  }
  assert.match(PANEL, /function stInit\(\)/);
  assert.match(PANEL, /stInit\(\);/);
  assert.match(PANEL, /window\.orb\.searchToolSet/);
  assert.match(PANEL, /window\.orb\.searchToolGet/);
  assert.match(PANEL, /window\.orb\.searchToolClear/);
  assert.match(PANEL, /api\('\/api\/search\/status'\)/, "要复核桥侧真实状态");
});

test("AnySearch 排服务商第一位，且选项标签不再夹带额度宣传", () => {
  const pane = chanPane();
  const selStart = pane.indexOf('<select id="st-provider"');
  const selEnd = pane.indexOf('</select>', selStart + 1);
  assert.ok(selStart >= 0 && selEnd > selStart, "找不到服务商下拉");
  const sel = pane.slice(selStart, selEnd);
  const first = sel.match(/<option value="([^"]+)"/);
  assert.ok(first, "下拉里必须有 option");
  assert.equal(first[1], "anysearch", "用户要求把 AnySearch 放第一位");

  /* 用户 2026-11-06 明确要求：免 Key / 额度 / 模型项这类说明「完全没必要」。
     选项标签必须只有服务商名，别再夹带任何额度数字或承诺。 */
  const label = (sel.match(/<option value="anysearch">([^<]*)<\/option>/) || [])[1] || "";
  assert.equal(label.trim(), "AnySearch", "选项标签只能是服务商名");
  for (const banned of ["每日免费", "2000", "免 Key", "匿名", "次/天", "QPS"]) {
    assert.ok(!pane.includes(banned), `栏目里不应再出现额度/免 Key 宣传：${banned}`);
  }
  assert.match(PANEL, /ks\.textContent = v\.hasKey \? \('已保存 ' \+ \(v\.keyMask \|\| '••••'\)\) : '未保存'/,
    "Key 状态只如实说保存没保存");
});

test("测试按钮：与视觉模型同一套入口，真发一次请求但不把 Key 交给桥", () => {
  const pane = chanPane();
  assert.match(pane, /<button id="st-test"[^>]*>测试<\/button>/);
  assert.match(PANEL, /async function stTest\(\)/);
  assert.match(PANEL, /window\.orb\.searchToolTest\(\)/);
  assert.match(PANEL, /先点「启用」再测试/, "未启用必须拦下，避免误花额度");
  /* 测试必须经主进程：桥只认启动期环境变量，拿它测等于测旧配置。 */
  assert.match(MAIN, /safeHandle\("search-tool-test"/);
  assert.match(MAIN, /vault\.getSearchKey\(\)/);
  assert.match(MAIN, /searchProbe\.probe\(/);
  /* 具体探测逻辑抽在 searchProbe.cjs（纯 CJS，可被 node:test 真跑）。 */
  assert.match(PROBE, /adapter\.anonymous !== true/, "没有 key 时只有匿名档放行");
  assert.match(PROBE, /new AbortController\(\)/, "测试必须有超时");
  assert.match(PROBE, /sample: rows\.slice\(0, 3\)/);
  assert.match(PROBE, /function redact\(/, "服务商回显 key 时必须抹掉再回给面板");
  assert.ok(!/Authorization\s*[:=]\s*["'`]?Bearer\s*\+?\s*key/.test(PROBE), "不许在这里拼死 key");
  assert.match(PRELOAD, /searchToolTest:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("search-tool-test"\)/);
  assert.ok(!/\/api\/search\/test/.test(BRIDGE), "测试不许新增桥端点（那会逼着 key 进 HTTP）");
});

test("自定义服务商：名称与端点由用户填，并真的接到主进程配置", () => {
  const pane = chanPane();
  assert.match(pane, /自定义服务商…/);
  assert.match(pane, /自行填写，仅作标识/);
  assert.match(pane, /仅 http\(s\)/);
  assert.match(PANEL, /customName: cn \? cn\.value\.trim\(\) : ''/);
  assert.match(PANEL, /endpoint: ep \? ep\.value\.trim\(\) : ''/);
  assert.match(PANEL, /st-custom-field/, "自定义字段要能被切换显隐");
  assert.match(CONFIG, /function safeName\(/, "名称要过控制字符清洗");
  assert.match(CONFIG, /ANONYMOUS_PROVIDERS/, "匿名档集合要在配置层有单一真相源");
});

test("明文 Key 不进渲染层：preload 只有三条脱敏通道，面板不读 key", () => {
  assert.match(PRELOAD, /searchToolGet:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("search-tool-get"\)/);
  assert.match(PRELOAD, /searchToolSet:\s*\(patch\)\s*=>\s*ipcRenderer\.invoke\("search-tool-set", patch\)/);
  assert.match(PRELOAD, /searchToolClear:/);
  assert.ok(!/getSearchKey|get-vision-key/.test(PRELOAD.slice(PRELOAD.indexOf("searchToolGet"), PRELOAD.indexOf("searchToolGet") + 400)));
  assert.ok(!/getSearchKey/.test(PANEL), "面板不得读取检索 key 明文");
  assert.ok(!/apiKey:\s*KEY|apiKey\s*=\s*await/.test(PANEL), "面板不得持有明文 key");
});

test("主进程：三条 IPC 只回脱敏视图，启动桥时由 vault 注入环境变量", () => {
  for (const h of ["search-tool-get", "search-tool-set", "search-tool-clear"]) {
    assert.match(MAIN, new RegExp(`safeHandle\\("${h}"`), `缺少 ${h}`);
  }
  assert.match(MAIN, /function searchToolView\(\)/);
  assert.match(MAIN, /searchTool\.publicView\(/);
  assert.match(MAIN, /\.\.\.searchTool\.bridgeEnv\(/);
  assert.match(MAIN, /vault\.getSearchKey\(\)/);
  assert.match(MAIN, /vault\.setSearchKey\(/);
  assert.match(MAIN, /restartRequired:\s*true/, "必须如实提示重启才生效");
  assert.match(MAIN, /不删配置文件/, "清除时写 enabled:false 压住残留开关");
  assert.match(MAIN, /require\("\.\/searchToolConfig\.cjs"\)/);
  assert.match(MAIN, /provider: searchTool\.DEFAULT_PROVIDER/, "清除时回落到置顶默认档");
});

test("vault：检索 Key 是独立密文字段，读改写不会把它抹掉", () => {
  assert.match(VAULT, /function getSearchKey\(\)/);
  assert.match(VAULT, /function setSearchKey\(key\)/);
  assert.match(VAULT, /search:\s*typeof o\.search === "string"/, "read() 必须带回 search 字段");
  assert.match(VAULT, /search:\s*""/, "empty() 也要有该字段");
  assert.match(VAULT, /getSearchKey,\s*\n\s*hasSearchKey,\s*\n\s*setSearchKey,/);
});

test("配置模块与打包清单：纯 CJS、登记进 APP_FILES、注释明确不落 key", () => {
  assert.match(PACK, /'searchToolConfig\.cjs'/);
  assert.match(CONFIG, /API Key 永远不写进配置文件/);
  assert.match(CONFIG, /function bridgeEnv\(/);
  assert.match(CONFIG, /Object\.freeze\(\['anysearch', 'deepseek', 'zhipu', 'baidu', 'custom'\]\)/);
});

test("桥仍只认启动期环境变量：支持 MODEL，但没有运行时配置端点", () => {
  assert.match(BRIDGE, /model:\s*process\.env\.ORB_SEARCH_MODEL/);
  assert.match(BRIDGE, /凭证绝不来自请求体/);
  assert.match(BRIDGE, /启动本进程时/);
  assert.ok(!/\/api\/search\/config/.test(BRIDGE), "不许开运行时配置端点");
  assert.match(PROVIDER, /adapter\.buildBody\(q, maxResults, model\)/, "模型名要真的传到 adapter");
  assert.match(PROVIDER, /adapter\.anonymous !== true/, "只有匿名档允许无 key 发请求");
});
