/* 报告A §五 P1 单测：剪贴板兜底 + 客户端唤起 + 深链白名单「机制」。
 * 锁的红线（报告 §六 / §4.2）：
 *   ① 编译期深链表必须为空；运行时登记必须带完整实测证据；
 *   ② 登记后不自动生效 —— 默认解析 resolveAppAction 绝不消费运行时表；
 *   ③ 客户端唤起只认实测登记的 exe，无参数、不拼搜索词、不猜路径；
 *   ④ 微信/QQ/企业微信没有实测 exe → 只写剪贴板 + 如实提示，不模拟点击；
 *   ⑤ 桥侧 /api/app-launch 只接受 appId，拒绝任何路径/命令注入；
 *   ⑥ fire-and-forget：不等待窗口，也不谎报「已打开」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEEP_LINKS, FORBIDDEN_SCHEMES, registerDeepLink, resolveDeepLink,
  deepLinkAudit, LAUNCH_EVIDENCE, planClientLaunch, wantsClient,
  resolveClientAction, resolveAppAction,
} from "../appIntent.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const INTENT = fs.readFileSync(path.join(ROOT, "appIntent.mjs"), "utf8");
const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");
const PANEL = fs.readFileSync(path.join(ROOT, "desktop", "panel.html"), "utf8");

const VERIFIED = {
  verified: true,
  verifiedAt: "2026-11-06",
  probe: "Start-Process 'qklink://search?keyword=orbprobe'",
  result: "实测唤起并落到搜索结果页，参数 keyword 生效",
  template: "qklink://search?keyword={keyword}",
  params: ["keyword"],
};

test("P1 起点：编译期深链表仍是冻结空表，运行时 0 条", () => {
  assert.equal(Object.keys(DEEP_LINKS).length, 0);
  assert.ok(Object.isFrozen(DEEP_LINKS));
  const a = deepLinkAudit();
  assert.equal(a.compiledCount, 0);
  assert.equal(a.runtimeCount, 0);
  assert.equal(a.defaultPathUsesRuntime, false);
  assert.ok(FORBIDDEN_SCHEMES.includes("bilibili://"));
  assert.ok(FORBIDDEN_SCHEMES.includes("zhihu://"));
});

test("登记机制：未登记应用 / 缺证据 / 未标实测 一律拒绝，且不入表", () => {
  assert.equal(registerDeepLink("不存在的软件", VERIFIED).reasonCode, "unknown-app");
  for (const k of ["verifiedAt", "probe", "result", "template", "params"]) {
    const bad = { ...VERIFIED, [k]: "" };
    const r = registerDeepLink("quark", bad);
    assert.equal(r.reasonCode, "missing-evidence", k);
    assert.ok(r.missing.includes(k), k);
  }
  const notVerified = { ...VERIFIED, verified: "yes" };
  assert.equal(registerDeepLink("quark", notVerified).reasonCode, "not-verified");
  assert.equal(deepLinkAudit().runtimeCount, 0, "拒绝的登记不许污染表");
});

test("登记机制：报告 §2.1 点名不存在的移动端 scheme 直接拉黑", () => {
  const r = registerDeepLink("bilibili", { ...VERIFIED, template: "bilibili://search?keyword={keyword}" });
  assert.equal(r.reasonCode, "forbidden-scheme");
  assert.equal(r.scheme, "bilibili://");
  assert.equal(deepLinkAudit().runtimeCount, 0);
});

test("登记机制：模板必须带搜索语义占位符，否则拒绝", () => {
  const r = registerDeepLink("quark", { ...VERIFIED, template: "qklink://home" });
  assert.equal(r.reasonCode, "no-keyword-placeholder");
  assert.equal(deepLinkAudit().runtimeCount, 0);
});

test("登记机制：完整实测证据才放行；resolveDeepLink 带回证据且 URL 编码正确", () => {
  const r = registerDeepLink("quark", VERIFIED);
  assert.equal(r.ok, true);
  assert.equal(deepLinkAudit().runtimeCount, 1);
  assert.deepEqual(deepLinkAudit().runtimeIds, ["quark"]);
  const d = resolveDeepLink("quark", "固态硬盘 1T");
  assert.equal(d.ok, true);
  assert.equal(d.transport, "deeplink");
  assert.equal(d.url, "qklink://search?keyword=" + encodeURIComponent("固态硬盘 1T"));
  assert.equal(d.evidence.probe, VERIFIED.probe);
  assert.equal(resolveDeepLink("wechat", "张三").reasonCode, "no-verified-deeplink");
});

test("关键红线：运行时登记后，默认解析路径绝不产出 deeplink", () => {
  const r = resolveAppAction("用夸克搜一下固态硬盘");
  assert.equal(r.transport, "web");
  assert.ok(!("deeplink" in r));
  assert.ok(!/qklink:\/\//.test(r.url));
  /* 静态锁：resolveAppAction 函数体里不许出现运行时表的名字 */
  const seg = INTENT.slice(INTENT.indexOf("export function resolveAppAction"), INTENT.indexOf("export function canDirectOpen"));
  assert.ok(!seg.includes("RUNTIME_DEEP_LINKS"), "默认解析不许查运行时深链表");
  assert.ok(!seg.includes("resolveDeepLink"));
});

test("客户端唤起白名单：只登记实测过的 exe，微信/QQ/企微一律不猜路径", () => {
  assert.deepEqual(Object.keys(LAUNCH_EVIDENCE), ["bilibili"]);
  assert.ok(Object.isFrozen(LAUNCH_EVIDENCE));
  for (const id of ["wechat", "qq", "wecom", "zhihu", "douyin"]) {
    assert.ok(!(id in LAUNCH_EVIDENCE), id);
  }
  const b = LAUNCH_EVIDENCE.bilibili;
  assert.deepEqual([...b.args], [], "报告 §2.2：带参数被 Node CLI 拒绝，只能无参数唤起");
  assert.match(b.evidence, /§2\.2/);
});

test("planClientLaunch：只认 appId，表外返回固定降级码与不猜的提示", () => {
  const bad = planClientLaunch("wechat");
  assert.equal(bad.ok, false);
  assert.equal(bad.reasonCode, "no-verified-launch");
  assert.equal(bad.exe, "");
  assert.match(bad.hint, /手动打开/);
  assert.equal(planClientLaunch("../Windows/System32/cmd.exe").reasonCode, "no-verified-launch");
  const ok = planClientLaunch("bilibili");
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, "exe");
  assert.deepEqual(ok.args, []);
  assert.equal(ok.launchMode, "fire-and-forget");
  assert.match(ok.exe, /\.exe$/);
});

test("wantsClient：只有显式说「用客户端」才算，不能由「只有客户端」反推", () => {
  for (const t of ["用客户端搜一下XX", "在客户端里搜XX", "打开客户端搜XX", "客户端搜XX"]) {
    assert.equal(wantsClient(t), true, t);
  }
  for (const t of ["用微信搜一下张三", "打开哔哩哔哩搜一下XX", "搜一下固态硬盘", ""]) {
    assert.equal(wantsClient(t), false, t);
  }
});

test("resolveClientAction：没提客户端返回 null；提了 B站 → 无参数唤起 + 干净关键词", () => {
  assert.equal(resolveClientAction("打开哔哩哔哩搜一下XX"), null);
  const r = resolveClientAction("用客户端在B站搜一下 固态硬盘");
  assert.equal(r.transport, "client_launch");
  assert.equal(r.app, "bilibili");
  assert.equal(r.confidence, 0.9);
  assert.equal(r.launch.ok, true);
  assert.deepEqual(r.launch.args, []);
  assert.equal(r.clipboard, "固态硬盘");
  assert.ok(!r.clipboard.includes("客户端") && !r.clipboard.includes("B站"));
  assert.match(r.reason, /不模拟点击/);
});

test("resolveClientAction：微信只有剪贴板兜底，不伪造 exe、不拼 scheme", () => {
  const r = resolveClientAction("用微信客户端搜一下张三");
  assert.equal(r.app, "wechat");
  assert.equal(r.transport, "clipboard");
  assert.equal(r.launch.ok, false);
  assert.equal(r.launch.exe, "");
  assert.equal(r.clipboard, "张三");
  assert.equal(r.confidence, 0.6);
  assert.match(r.reason, /不猜路径/);
});

test("桥契约：/api/app-launch 只接受 appId，拒绝路径/命令注入，spawn 无参数", () => {
  assert.match(BRIDGE, /req\.method === "POST" && url\.pathname === "\/api\/app-launch"/);
  assert.match(BRIDGE, /\["exe", "path", "command", "cmd", "args", "argv", "filePath", "url"\]/);
  assert.match(BRIDGE, /app-launch 只接受 appId/);
  assert.match(BRIDGE, /spawn\(p\.exe, p\.args, \{ detached: true, stdio: "ignore"/);
  assert.match(BRIDGE, /fsSync\.existsSync\(p\.exe\)/);
  assert.match(BRIDGE, /exe-not-found/);
  assert.match(BRIDGE, /不等待窗口出现，也不谎报已打开/);
  const pub = BRIDGE.match(/const PUBLIC_PATHS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(pub && !pub[1].includes("app-launch"), "唤起接口不能免鉴权");
});

test("桥契约：/api/app-matrix 暴露 clientAction / 深链审计 / 可唤起清单", () => {
  assert.match(BRIDGE, /schemaVersion: 2/);
  assert.match(BRIDGE, /clientAction = probe \? resolveClientAction\(probe\)/);
  assert.match(BRIDGE, /deepLinkAudit: deepLinkAudit\(\)/);
  assert.match(BRIDGE, /launchable: Object\.keys\(LAUNCH_EVIDENCE\)/);
  assert.match(BRIDGE, /\.\.\.\(clientAction \? \{ clientAction \} : \{\}\)/);
});

test("面板契约：显式客户端分支只发 appId、写剪贴板、不模拟点击、不谎报", () => {
  const seg = PANEL.slice(PANEL.indexOf("应用意图（报告A"), PANEL.indexOf("确定性网页指令直接执行"));
  assert.match(seg, /post\('\/api\/app-launch', \{ appId: ca\.app \}\)/);
  assert.match(seg, /ca\.transport === 'client_launch'/);
  assert.match(seg, /ca\.transport === 'clipboard'/);
  assert.match(seg, /writeClipboard\(ca\.clipboard \|\| ca\.keyword\)/);
  assert.match(seg, /不模拟点击/);
  /* 渲染层不许自己拉起进程，也不许拼 exe / scheme */
  assert.ok(!/\bspawn\s*\(|execFile\s*\(|shell\.openPath\s*\(/.test(seg));
  assert.ok(!/\.exe\b|bilibili:\/\//.test(seg), "面板不该出现路径或 scheme 字面量");
  assert.match(seg, /不等待窗口出现/);
});
