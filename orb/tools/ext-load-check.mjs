/**
 * #198 扩展加载验收器（静态/加载前）。
 *
 * 只做「加载前能不能验的」：包完整性、MV3 配置、gate 接线、红线静态断言，
 * 并给出 Chrome 加载步骤与真机验收清单。
 * 明确不做：不加载扩展、不连接 Chrome、不改用户浏览器状态、不跑真机端到端。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 默认候选目录，可用环境变量 ORB_EXT_DIR 或 --dir= 覆盖，避免写死单一绝对路径。 */
export const EXT_DIR_CANDIDATES = Object.freeze([
  process.env.ORB_EXT_DIR || "",
  "D:/WorkBuddy 附属文件夹/项目记录/2026-09-28-00-45-13/wb_ext_027",
  path.join(ROOT, "browser-extension"),
].filter(Boolean));

export const REQUIRED_FILES = Object.freeze([
  "manifest.json", "background.js", "action_gate.js", "site_api.js", "popup.html", "popup.js", "popup.css",
]);
export const REQUIRED_ICONS = Object.freeze(["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]);
export const VERIFIED_SITE_KEYS = Object.freeze(["bilibili.com", "taobao.com", "jd.com", "eastmoney.com"]);
export const GATE_EXPORTS = Object.freeze(["gate", "assertVisionDecisionOnly", "fiveStageVerify", "claimDone"]);
export const FORBIDDEN_PATTERNS = Object.freeze([
  [/\bfetch\s*\(/, "fetch("],
  [/XMLHttpRequest/, "XMLHttpRequest"],
  [/\beval\s*\(/, "eval("],
  [/api_call_register/, "api_call_register"],
]);

export function resolveExtDir(explicit = "", { fsImpl = fs, pathImpl = path } = {}) {
  const pool = explicit ? [explicit] : EXT_DIR_CANDIDATES;
  for (const d of pool) if (d && fsImpl.existsSync(pathImpl.join(d, "manifest.json"))) return d;
  return explicit || EXT_DIR_CANDIDATES[0] || "";
}

export function checkExtension({ dir = "", fsImpl = fs, pathImpl = path } = {}) {
  const extDir = resolveExtDir(dir, { fsImpl, pathImpl });
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: String(detail ?? "") });
  const read = (f) => { try { return fsImpl.readFileSync(pathImpl.join(extDir, f), "utf8"); } catch { return null; } };

  add("扩展目录可定位", !!extDir && fsImpl.existsSync(extDir), extDir || "(未找到，请设 ORB_EXT_DIR 或 --dir=)");
  if (!extDir || !fsImpl.existsSync(extDir)) {
    return { ok: false, dir: extDir, checks, passed: 0, failed: checks.length, loadSteps: loadSteps(extDir), runtimeChecklist: runtimeChecklist() };
  }

  for (const f of REQUIRED_FILES) add(`必需文件 ${f}`, read(f) !== null, f);
  for (const i of REQUIRED_ICONS) add(`图标 ${i}`, fsImpl.existsSync(pathImpl.join(extDir, "icons", i)), "icons/" + i);

  let manifest = null;
  try { manifest = JSON.parse(read("manifest.json")); } catch (e) { manifest = null; add("manifest.json 可解析", false, String(e?.message ?? e)); }
  if (manifest) {
    add("manifest_version = 3", manifest.manifest_version === 3, String(manifest.manifest_version));
    add("background.service_worker 指向 background.js", manifest.background?.service_worker === "background.js", String(manifest.background?.service_worker));
    add("background.type = module", manifest.background?.type === "module", String(manifest.background?.type));
  }

  const gateSrc = read("action_gate.js") || "";
  const bgSrc = read("background.js") || "";
  for (const fn of GATE_EXPORTS) add(`action_gate 导出 ${fn}`, new RegExp(`export function ${fn}\\b`).test(gateSrc), fn);
  add("action_gate 挂载 globalThis.ActionGate", /globalThis\.ActionGate\s*=/.test(gateSrc), "globalThis.ActionGate");
  add("background 静态 import gate", /import\s*\{[^}]*\bgate\b[^}]*\}\s*from\s*["']\.\/action_gate\.js["']/.test(bgSrc), "import { gate, ... }");
  add("background DOM CUA 分派处调用 gate(", /\bgate\s*\(/.test(bgSrc), "gate(");
  add("background 视觉档断言 assertVisionDecisionOnly", /assertVisionDecisionOnly\s*\(/.test(bgSrc), "assertVisionDecisionOnly(");

  for (const [re, label] of FORBIDDEN_PATTERNS) {
    add(`action_gate 红线：不含 ${label}`, !re.test(gateSrc), label);
  }
  for (const site of VERIFIED_SITE_KEYS) {
    add(`SITE_RULES 已核实站点 ${site}`, gateSrc.includes(`"${site}"`), site);
  }

  /* 11-07 B1：api 通道执行层。闸门仍不发网络，取数只许走白名单执行层。 */
  const apiSrc = read("site_api.js") || "";
  add("site_api 导出端点白名单与执行函数",
    /export const API_ENDPOINTS/.test(apiSrc) && /export async function fetchSiteData/.test(apiSrc),
    "API_ENDPOINTS / fetchSiteData");
  add("site_api 默认零外发：enabled !== true 即拒", /enabled !== true/.test(apiSrc), "enabled !== true");
  add("site_api 内置 SSRF 防护", /export function isSafeUrl/.test(apiSrc) && /169\.254\.169\.254/.test(apiSrc), "isSafeUrl");
  add("site_api 红线：不注册 API 调用、不按任意 URL 取数",
    !/api_call_register/.test(apiSrc) && !/fetch\s*\(\s*(?:params|input|url)\b/.test(apiSrc),
    "白名单外 URL 一律拒绝");
  add("background 分派 site_api.fetch / site_api.status",
    /case "site_api\.fetch":/.test(bgSrc) && /case "site_api\.status":/.test(bgSrc), "两个 case");

  return {
    ok: checks.every((c) => c.ok),
    dir: extDir,
    checks,
    passed: checks.filter((c) => c.ok).length,
    failed: checks.filter((c) => !c.ok).length,
    loadSteps: loadSteps(extDir),
    runtimeChecklist: runtimeChecklist(),
    note: "加载前静态验收：不加载扩展、不连 Chrome、不改浏览器状态。真机端到端仍需人工执行下方清单。",
  };
}

export function loadSteps(extDir) {
  return [
    "打开 Chrome，地址栏输入 chrome://extensions 并回车",
    "右上角开启「开发者模式」",
    "点「加载已解压的扩展程序」，选择目录：" + extDir,
    "确认扩展卡片出现且无「错误」按钮；有错误先点开看 service worker 日志",
    "点扩展图标打开 popup，确认能正常渲染",
    "按下方真机验收清单逐条执行，任何一条失败都不要标记为通过",
  ];
}

export function runtimeChecklist() {
  return [
    "B 站搜索：走已核实的 api/dom 通道，回读标题非空",
    "淘宝/京东：gate 返回允许且通道与 SITE_RULES 一致",
    "未登记站点：只走 channel:url 通用搜索模板，不出现 DOM 选择器",
    "视觉档：传入坐标决策应被 assertVisionDecisionOnly 拒掉",
    "gate 拒绝：消息层收敛为 {ok:false,error}，service worker 不崩、不裸抛",
    "急停：桥侧 STOP 生效后扩展侧不再派发新的 DOM CUA 动作",
  ];
}

export function toMarkdown(r) {
  const L = ["# 扩展加载前静态验收报告", "", `- 扩展目录：\`${r.dir || "(未定位)"}\``,
    `- 结论：**${r.ok ? "PASS" : "FAIL"}**（通过 ${r.passed} / 失败 ${r.failed}）`, "",
    r.note, "", "## 检查项", ""];
  for (const c of r.checks) L.push(`- ${c.ok ? "✔ PASS" : "✘ FAIL"} **${c.name}** — ${c.detail}`);
  L.push("", "## Chrome 加载步骤", "");
  r.loadSteps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
  L.push("", "## 真机端到端验收清单（本工具未执行）", "");
  for (const c of r.runtimeChecklist) L.push(`- [ ] ${c}`);
  return L.join("\n") + "\n";
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const a = process.argv.find((x) => x.startsWith("--dir="));
  const r = checkExtension({ dir: a ? a.slice(6) : "" });
  process.stdout.write(toMarkdown(r));
  if (!r.ok) process.exitCode = 1;
}
