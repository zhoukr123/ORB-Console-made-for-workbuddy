#!/usr/bin/env node
/* 专家团模式 / 开口三档 / 安全页只读概览 —— 端到端冒烟。
 *
 * 起一个独立端口 + 临时存储根的桥，真走一遍：
 *   开关 → 分配者拆解 → 每个 worker 绑真实 jobId → 展开看工作流程
 *   → 用户只对分配者说话（steer）→ 工作者结果回读 → 分配者收口汇总
 *   → 三档护栏 / Agent 从用户原话推理 / 安全页无数值 / 自动复核开关真拦。
 *
 * 刻意把 ORB_WB_CLI 指向不存在的文件：worker 通道会立刻失败，
 * 既能验证「失败也如实回传、不假装在跑」，又不会真去 spawn 一次模型调用。
 * 绝不碰生产 .bridge.json / 生产产物树。
 *
 * 用法：node tools/team-mode-smoke.mjs
 * 退出码 0 = 全部通过。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PANEL = path.join(ROOT, "desktop", "panel.html");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orb-team-smoke-"));
const PORT = 19800 + Math.floor(Math.random() * 400);
const TOKEN = "team-smoke-" + Date.now().toString(36);
const API = `http://127.0.0.1:${PORT}`;

let bad = 0;
const ok = (m) => console.log("  ✓ " + m);
const fail = (m) => { bad++; console.log("  ✗ " + m); };
const check = (cond, m) => cond ? ok(m) : fail(m);

const env = {
  ...process.env,
  ORB_PORT: String(PORT),
  ORB_TOKEN: TOKEN,
  ORB_TOKEN_FILE: path.join(tmp, ".bridge.json"),
  ORB_DATA_DIR: tmp,
  ORB_STORAGE_ROOT: tmp,
  ORB_ASR_AUTOSTART: "0",
  ORB_ENABLE_DSH: "0",
  ORB_WB_DAEMON: "0",
  /* 故意不存在：让 workbuddy_execute 立刻失败，不真的跑模型。 */
  ORB_WB_CLI: path.join(tmp, "no-such-cli.exe"),
};
const child = spawn(process.execPath, [path.join(ROOT, "bridge.mjs")], {
  env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += String(d).slice(0, 4000); });

async function req(p, init = {}) {
  const headers = { "X-Orb-Token": TOKEN, ...(init.headers || {}) };
  const r = await fetch(API + p, { ...init, headers, signal: AbortSignal.timeout(8000) });
  return r.json();
}
const post = (p, body) => req(p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const ops = (action, extra = {}) => post("/api/ops", { action, ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await req("/api/status"); if (r && r.ok) return true; } catch {}
    await sleep(250);
  }
  return false;
}
async function until(fn, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(250);
  }
  return null;
}

try {
  check(await waitUp(), `桥在 ${PORT} 上起来了（独立端口 / 临时存储根）`);

  /* ---------- 1. 面板结构：开关位置、不再有审查独立页 ---------- */
  const html = fs.readFileSync(PANEL, "utf8");
  const iRec = html.indexOf('id="rec"');
  const iTeam = html.indexOf('id="teamModeBtn"');
  const iStop = html.indexOf('id="stopBtn"');
  check(iRec > 0 && iTeam > iRec && iStop > iTeam, "顶栏顺序：录操作 → 专家团模式 → 急停");
  check(!/data-pane="team"/.test(html), "旧的「专家团」设置独立页已移除");
  for (const pane of ["plugin", "router", "telemetry"]) {
    check(!new RegExp(`data-pane="${pane}"`).test(html), `没有给${pane}单独设置页`);
  }
  check(/id="safOvRows"/.test(html) && /id="speakTiers"/.test(html), "安全页只读状态区 / 个性页三档开关都在");
  check(!/id="teamMask"/.test(html), "带图标与数值的旧审查大浮层已清掉");

  /* ---------- 2. 开关 → 拆解 → 真实 worker ---------- */
  let st = await req("/api/team/status");
  check(st.ok === true && st.enabled === false, "专家团模式默认关闭");
  check(st.lead && st.lead.name === "分配者", "用户唯一对话对象是分配者");

  const on = await post("/api/team/mode", { on: true });
  check(on.ok === true && on.enabled === true, "点开关后真的开启（桥侧状态变化，不是本地假亮）");

  const started = await post("/api/team/start", {
    text: "甲：整理登录页的现状；乙：把改动写成一页清单",
  });
  check(started.ok === true && started.dispatched >= 2, `分配者真的拆出并派发 ${started.dispatched} 个子任务`);
  const run = started.run || {};
  const ws = run.workers || [];
  check(ws.length >= 2, "卡片列表里有多个工作者");
  check(ws.every((w) => !!w.jobId), "每个工作者都绑了真实后台 jobId（不是摆设卡片）");
  check(ws.every((w) => !!w.brief && !!w.criterion), "每张卡片都有子任务与成功判据");
  check(run.subject && run.effort, `分配者给出任务主题与拆解力度：${run.effort}`);

  /* 上下文隔离：worker 只拿自己的 brief，不塞兄弟的子任务。 */
  const d1 = await req("/api/team/worker?id=w1");
  const d2 = await req("/api/team/worker?id=w2");
  check(d1.ok === true && d2.ok === true, "点开卡片能取回该工作者的工作流程");
  check(Array.isArray(d1.worker.steps) && d1.worker.steps.some((s) => /已派发/.test(s.title)),
    "工作流程里有真实「已派发」步骤");
  check(d1.worker.brief !== d2.worker.brief, "两个工作者的子任务不相同（上下文隔离）");
  check(!JSON.stringify(d1.worker).includes(d2.worker.brief), "w1 的工作流程里没有 w2 的 brief");

  /* ---------- 3. 用户只对分配者说话 ---------- */
  const steer = await post("/api/team/steer", { text: "第二个别删已有注释" });
  check(steer.ok === true && (steer.targets || []).includes("w2"), "点名第二个 → 分配者把指令转给 w2");
  const d2b = await req("/api/team/worker?id=w2");
  const got = (d2b.worker.steers || []).find((s) => /已有注释/.test(s.text));
  check(!!got && got.from === "lead", "w2 收到的是「分配者转来的指令」，不是和用户的一段对话");
  const leadSteer = await post("/api/team/steer", { text: "换个拆法重来一次" });
  check((leadSteer.targets || []).includes("lead"), "要求重排时分配者改自己的计划");

  /* ---------- 4. 工作者结果回读 → 分配者收口 ---------- */
  const done = await until(async () => {
    const s = await req("/api/team/status");
    return s.run && s.run.phase === "done" ? s.run : null;
  });
  check(!!done, "所有工作者回传后，这一轮真的收口（phase 不再是永远 running）");
  if (done) {
    check(typeof done.summary === "string" && done.summary.includes("任务："), "分配者给出最终汇总，不是空白");
    check(done.summary.includes("缺口") || done.summary.includes("·"), "汇总如实列出结果 / 缺口，不编造结论");
    check((done.workers || []).every((w) => w.status === "done" || w.status === "failed"),
      "工作者状态全部落到终态（失败的也如实标失败）");
  }

  /* ---------- 5. 开口门控三档 + Agent 从原话推理 ---------- */
  await ops("affect.reset");
  const tier = await ops("affect.setTier", { tier: "quiet" });
  check(tier.ok === true && tier.data.tier === "quiet", "个性页能切到「安静」档，桥侧真的换档");
  const status = await ops("affect.status");
  check(status.data.tiers && Object.keys(status.data.tiers).length === 3, "对外恰好三档，没有任何数值参数入口");
  const setBad = await ops("affect.set", { cooldownMs: 0 });
  check(setBad.ok === false, "旧的参数调整入口被拒（用户碰不到冷却/阈值）");

  const now = Date.now();
  const evalBase = {
    kind: "reminder", urgency: "normal", confidence: 0.9, userActiveAt: now - 60_000,
  };
  await ops("affect.reset");
  const inferredPrompt = await ops("affect.evaluate", {
    ctx: { ...evalBase, userText: "有进展马上告诉我" },
  });
  check(inferredPrompt.data.pass === true, "用户说「有进展马上告诉我」→ Agent 当场推理为及时档并放行");

  await ops("affect.reset");
  const quietDefault = await ops("affect.evaluate", { ctx: { ...evalBase } });
  check(quietDefault.data.pass === false, "没有表态时按全局「安静」档，仍按住不开口");

  await ops("affect.reset");
  const inferWins = await ops("affect.evaluate", {
    ctx: { ...evalBase, tierHint: "prompt", userText: "别烦我" },
  });
  check(inferWins.data.pass === false, "用户原话的推理优先于调用方 hint（否则推理通道是空头）");

  await ops("affect.reset");
  const backToGlobal = await ops("affect.evaluate", {
    ctx: { ...evalBase, userText: "照常就好" },
  });
  check(backToGlobal.data.pass === false, "说「照常」回落到全局档，不强行覆盖用户设置");

  /* ---------- 6. 安全页只读概览 ---------- */
  const ov = await ops("safety.overview");
  const v = ov && ov.data && ov.data.overview;
  check(!!v, "安全页能取到只读概览");
  if (v) {
    const keys = ["enabledText", "hitRateText", "suppressedText", "breakerText", "tierText"];
    check(keys.every((k) => typeof v[k] === "string" && v[k]), "六项里前五项都是状态词（开启/有无命中/有无/有无记录/档位）");
    check(Array.isArray(v.plugins) && v.plugins.length >= 1, "第六项插件启停清单有真实插件");
    check(!/\d/.test(JSON.stringify(v)), "整个返回值里没有任何数值（用户明确要求）");
    check(!/number|boolean/.test(JSON.stringify(v).toLowerCase()), "也没有布尔值泄漏");
  }

  /* ---------- 7. 自动复核开关真拦 ---------- */
  const off = await ops("review.auto", { on: false });
  check(off.ok === true && off.data.enabled === false, "把自动复核关掉后桥侧状态是关闭");
  const blocked = await ops("team.collectReview", { light: true, auto: true });
  check(blocked.ok === false, "关闭后自动复核真的不再执行（不是只改了个显示）");
  const manual = await ops("team.collectReview", { light: true });
  check(manual.ok === true, "手动发起的复核仍可用，排查时不被误锁");
  await ops("review.auto", { on: true });
  const ov2 = await ops("safety.overview");
  check(ov2.data.overview.enabledText === "开启", "重新打开后安全页状态跟着变");

  /* ---------- 8. 关开关真的停 ---------- */
  const off2 = await post("/api/team/mode", { on: false });
  check(off2.ok === true && off2.enabled === false, "再点一次关闭，桥侧确实关了");
  const after = await post("/api/team/start", { text: "还有一件事" });
  check(after.ok === false, "关闭状态下不再派新子任务");
} catch (e) {
  fail("冒烟异常：" + String((e && e.stack) || e));
  if (stderr) console.log("  bridge stderr(尾部): " + stderr.slice(-1200));
} finally {
  try { child.kill("SIGTERM"); } catch {}
  await sleep(300);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, `.children-${PORT}.json`), { force: true }); } catch {}
}

console.log(bad ? `TEAM_SMOKE_FAIL (${bad})` : "TEAM_SMOKE_OK");
process.exit(bad ? 1 : 0);
