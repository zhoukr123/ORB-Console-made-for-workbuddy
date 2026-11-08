/**
 * #198 真机 Chrome 端到端验收（B1 配套）。
 *
 * 用 puppeteer-core 驱动本机 Chrome，在**独立临时 profile** 里通过 CDP
 * Extensions.loadUnpacked 加载 wb_ext_027，拿到 MV3 service worker，
 * 一次性在 SW 内跑完所有断言（避免 30s 空闲挂起打断多次 evaluate）。
 *
 * 明确边界：
 *  - 不碰用户正在使用的 Chrome profile，不修改浏览器状态，跑完清理临时 profile。
 *  - 不真打 B站/淘宝：api 通道用注入 fixture 验证，符合 E2E 通行做法；
 *    真站登录态 / 验证码 / 页面改版仍需人工 smoke，本脚本不假装覆盖。
 *  - dispatch 接线由 ext-load-check.mjs 的静态契约保证，SW 内只验模块行为。
 *
 * 用法：node tools/ext-e2e.mjs [--headed] [--json]
 * 路径可用 ORB_CHROME_PATH / ORB_EXT_DIR 覆盖。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExtDir } from "./ext-load-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CHROME_CANDIDATES = Object.freeze([
  process.env.ORB_CHROME_PATH || "",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean));

export function resolveChrome(explicit = "") {
  const pool = explicit ? [explicit] : CHROME_CANDIDATES;
  for (const p of pool) if (p && fs.existsSync(p)) return p;
  return "";
}

/** 在 SW 内一次性跑完的断言集合。函数体内不得引用外部闭包。 */
export async function assertionsInWorker(worker) {
  return await worker.evaluate(async () => {
    const out = [];
    const ck = (name, ok, detail) => out.push({ name, ok: !!ok, detail: String(detail ?? "") });
    const Gate = globalThis.ActionGate;
    const Api = globalThis.SiteApi;

    ck("service worker 已加载且两个模块挂载", !!Gate && !!Api,
      "ActionGate=" + !!Gate + " SiteApi=" + !!Api);
    if (!Gate || !Api) return out;

    const bili = Gate.gate({ site: "bilibili.com", action: "search_uploader" });
    ck("B站 search_uploader 命中 api 通道", bili.allowed === true && bili.channel === "api",
      "allowed=" + bili.allowed + " channel=" + bili.channel);
    const em = Gate.gate({ site: "eastmoney.com", action: "read_quote" });
    ck("东财 read_quote 命中 api 通道", em.allowed === true && em.channel === "api", em.channel);
    const tb = Gate.gate({ site: "taobao.com", action: "search_product" });
    ck("淘宝 search_product 只走 url 通道", tb.allowed === true && tb.channel === "url", tb.channel);
    const jd = Gate.gate({ site: "jd.com", action: "read_price" });
    ck("京东 read_price 命中已核实 dom 通道", jd.allowed === true && jd.channel === "dom", jd.channel);

    const unknown = Gate.gate({ site: "never-registered.example", action: "search" });
    const unknownPlan = JSON.stringify(unknown.plan || {});
    ck("未登记站点只走 vision 兜底且不猜选择器",
      unknown.channel === "vision" && !unknownPlan.includes("selector") && !unknownPlan.includes("endpoint"),
      "channel=" + unknown.channel);

    const vision = Gate.assertVisionDecisionOnly({ x: 100, y: 200, click: true });
    ck("视觉档拒绝坐标与点击决策", vision.ok === false, "ok=" + vision.ok);
    // 必须用「已登记站点 + 已登记动作」才能走到 claimedChannel 校验：
    // 未登记站点会在兜底分支提前返回 vision（本身已是最保守行为，不需要再判 spoof）。
    const spoof = Gate.gate({ site: "bilibili.com", action: "open_video", claimedChannel: "api" });
    ck("自称更强结构化通道被闸门拒绝", spoof.allowed === false && spoof.channel === "no_go",
      "allowed=" + spoof.allowed + " channel=" + spoof.channel);
    const low = Gate.gate({ site: "bilibili.com", action: "search_uploader", confidence: 0.3 });
    ck("低置信度自动升视觉决策", low.allowed === true && low.channel === "vision", "channel=" + low.channel);

    ck("五段验收与诚实声明函数可用",
      typeof Gate.fiveStageVerify === "function" && typeof Gate.claimDone === "function",
      "fiveStageVerify / claimDone");

    const status = Api.siteApiStatus();
    ck("site_api 默认是关闭的（零外发）", status.enabled === false && status.defaultEnabled === false,
      "enabled=" + status.enabled);

    let defaultCalls = 0;
    const countingFetch = async () => { defaultCalls += 1; throw new Error("must not fetch"); };
    const noOptIn = await Api.fetchSiteData(
      { site: "bilibili.com", action: "search_uploader" },
      { fetchImpl: countingFetch },
    );
    ck("未显式 enabled 时返回 disabled 且零网络调用",
      noOptIn.code === "disabled" && defaultCalls === 0,
      "code=" + noOptIn.code + " calls=" + defaultCalls);

    let allowlistCalls = 0;
    const badFetch = async () => { allowlistCalls += 1; throw new Error("must not fetch"); };
    const notListed = await Api.fetchSiteData(
      { site: "evil.example", action: "search_uploader", enabled: true },
      { fetchImpl: badFetch },
    );
    ck("白名单外端点一律拒绝且零网络调用",
      notListed.code === "endpoint-not-allowlisted" && allowlistCalls === 0,
      "code=" + notListed.code + " calls=" + allowlistCalls);

    /* all/v2 的真实形状：result 是分块数组，bili_user 块里才是条目。
       fixture 必须照真实形状写，否则解析规则一改就测不出来。 */
    const fixture = {
      code: 0,
      data: {
        result: [
          { result_type: "video", data: [{ bvid: "BV1fixture" }] },
          { result_type: "bili_user", data: [{ mid: 42, uname: "fixture-user" }] },
        ],
      },
    };
    const okFetch = async () => ({ ok: true, text: async () => JSON.stringify(fixture) });
    const got = await Api.fetchSiteData(
      { site: "bilibili.com", action: "search_uploader", enabled: true, params: { keyword: "fixture" } },
      { fetchImpl: okFetch },
    );
    ck("显式 enabled + fixture 取数成功并带回读证据",
      got.ok === true && got.code === "ok" && got.data && got.data[0].mid === 42 && !!got.evidence,
      "code=" + got.code + " mid=" + (got.data && got.data[0] && got.data[0].mid));

    const ssrf = ["https://127.0.0.1/x", "https://10.0.0.1/x", "https://169.254.169.254/x", "http://example.com/x"];
    ck("SSRF 防护在真实 SW 环境生效", ssrf.every((u) => Api.isSafeUrl(u) === false),
      ssrf.length + " 个禁例全部拒绝");

    return out;
  });
}

/**
 * 跑一次完整 E2E。puppeteer 由调用方注入（便于单测与便携版缺 devDeps 时优雅失败）。
 */
export async function runExtE2E(opts = {}) {
  const {
    extDir = resolveExtDir(),
    chromePath = resolveChrome(opts.chromeExplicit || ""),
    headless = opts.headless !== false,
    puppeteerImpl = null,
    fsImpl = fs,
    pathImpl = path,
    osImpl = os,
  } = opts;
  const result = {
    ok: false, checks: [], passed: 0, failed: 0,
    extensionId: null, chromePath, extDir, error: null,
    note: "独立临时 profile；不碰用户 Chrome、不改浏览器状态、不真打站点。",
  };
  const add = (name, ok, detail) => result.checks.push({ name, ok: !!ok, detail: String(detail ?? "") });

  if (!extDir || !fsImpl.existsSync(extDir)) { result.error = "扩展目录未定位，请设 ORB_EXT_DIR"; return result; }
  if (!chromePath) { result.error = "未找到 Chrome，请设 ORB_CHROME_PATH"; return result; }

  let puppeteer = puppeteerImpl;
  if (!puppeteer) {
    try { puppeteer = (await import("puppeteer-core")).default; }
    catch (e) { result.error = "puppeteer-core 未安装：" + String(e?.message ?? e); return result; }
  }

  const profile = fsImpl.mkdtempSync(pathImpl.join(osImpl.tmpdir(), "orb-ext-e2e-"));
  let browser = null;
  try {
    browser = await puppeteer.launch({
      executablePath: chromePath,
      headless,
      pipe: true,                       // enableExtensions 传路径数组时必须用 pipe
      enableExtensions: [extDir],       // CDP Extensions.loadUnpacked，非命令行 flags
      userDataDir: profile,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
    const target = await browser.waitForTarget(
      (t) => t.type() === "service_worker" && t.url().endsWith("background.js"),
      { timeout: 20000 },
    );
    result.extensionId = new URL(target.url()).hostname;
    add("真机 Chrome 加载扩展并注册 MV3 service worker", !!result.extensionId, result.extensionId);

    const worker = await target.worker();
    if (!worker) throw new Error("service worker target 没有 worker 句柄");
    for (const c of await assertionsInWorker(worker)) add(c.name, c.ok, c.detail);
    add("gate 拒绝路径未导致 service worker 崩溃", true, "整轮 evaluate 正常返回");
  } catch (e) {
    result.error = String(e?.message ?? e);
    add("E2E 执行", false, result.error);
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
    try { fsImpl.rmSync(profile, { recursive: true, force: true }); } catch {}
  }

  result.passed = result.checks.filter((c) => c.ok).length;
  result.failed = result.checks.filter((c) => !c.ok).length;
  result.ok = !result.error && result.failed === 0 && result.passed > 0;
  return result;
}

export function toMarkdown(r) {
  const L = ["# 真机 Chrome 扩展 E2E 报告", "",
    `- 扩展目录：\`${r.extDir}\``,
    `- Chrome：\`${r.chromePath || "(未定位)"}\``,
    `- 扩展 ID：\`${r.extensionId || "(未加载)"}\``,
    `- 结论：**${r.ok ? "PASS" : "FAIL"}**（通过 ${r.passed} / 失败 ${r.failed}）`, "",
    r.note, "", "## 检查项", ""];
  if (r.error) L.push(`- 错误：${r.error}`, "");
  for (const c of r.checks) L.push(`- ${c.ok ? "✔ PASS" : "✘ FAIL"} **${c.name}** — ${c.detail}`);
  L.push("", "## 未覆盖（需人工 smoke）", "",
    "- B站 / 淘宝真站：登录态、验证码、反自动化检测、页面改版",
    "- 急停后扩展侧不再派发新 DOM CUA 动作（需桥侧配合）",
    "- popup 交互、工具栏点击、权限弹窗等浏览器 UI");
  return L.join("\n") + "\n";
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const r = await runExtE2E({ headless: !process.argv.includes("--headed") });
  process.stdout.write(process.argv.includes("--json") ? JSON.stringify(r, null, 2) + "\n" : toMarkdown(r));
  if (!r.ok) process.exitCode = 1;
}
