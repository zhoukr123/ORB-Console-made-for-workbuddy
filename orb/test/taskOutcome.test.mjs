/* 任务终态判定 + 运行条/耗时/急停接线的回归单测。
 *
 * 沿用 structuredCompile.test.mjs 的惯例：panel.html 是单文件内联脚本、没有模块边界，
 * 直接 import 不了。判定逻辑按 OUTCOME_START / OUTCOME_END 两个注释标记原样抽出来，
 * 丢进 new Function 里独立跑；接线部分用源码静态契约锁住，防止哪天被"顺手重构"掉。
 *
 * 背景（2026-11-07 用户反馈）：按下急停后，系统消息「已急停」下面仍然出现
 * 傲娇人格的完成台词「好了好了，拿去，别指望我夸你」。根因是成功判定只看作业
 * 快照里的否定标记，而急停是另一条链路上的全局状态，从来没进过判定。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PANEL = path.join(import.meta.dirname, "..", "desktop", "panel.html");
const src = fs.readFileSync(PANEL, "utf8");
/* 2026-11-08：4028 行 <style> 已物理切到同目录 panel.css。
   JS 抽取段与 DOM 契约仍只认 panel.html（混进样式文本会污染标记定位），
   只有 CSS 规则类断言需要连外链样式一起看。 */
const CSS = fs.readFileSync(path.join(import.meta.dirname, "..", "desktop", "panel.css"), "utf8");

const START = "/* ==== OUTCOME_START ==== */";
const END = "/* ==== OUTCOME_END ==== */";
const from = src.indexOf("/* ==== OUTCOME_START ====");
const to = src.indexOf(END, from);
assert.ok(from >= 0, "找不到 OUTCOME_START 标记");
assert.ok(to > from, "找不到 OUTCOME_END 标记");
const block = src.slice(from, to + END.length);
assert.ok(block.includes("function classifyTaskOutcome"), "抽取段为空或不含 classifyTaskOutcome");

function makeEnv() {
  return new Function(block + "; return { OUTCOME, ABORT_WINDOW_MS, classifyTaskOutcome, outcomeAllowsSuccess, outcomeIsAbort };")();
}
const { OUTCOME, ABORT_WINDOW_MS, classifyTaskOutcome, outcomeAllowsSuccess, outcomeIsAbort } = makeEnv();
const NOW = 1_800_000_000_000;
const ctx = (extra) => Object.assign({ now: NOW, stopOn: false, abortedAt: 0 }, extra || {});

/* ---------- 1. 判定段本身：纯函数三态 ---------- */

test("抽取段可在无 window 环境独立加载，且三态常量固定", () => {
  const env = makeEnv();
  assert.equal(typeof env.classifyTaskOutcome, "function");
  assert.deepEqual(env.OUTCOME, { OK: "ok", ABORT: "abort", FAIL: "fail" });
  assert.equal(env.ABORT_WINDOW_MS, 15000);
});

test("成功只有一种：done 且没有任何否定信号", () => {
  for (const st of ["done", "success", "ok", "completed", "", undefined]) {
    assert.equal(classifyTaskOutcome({ status: st }, ctx()), OUTCOME.OK, "status=" + st);
  }
  assert.equal(outcomeAllowsSuccess(OUTCOME.OK), true);
  assert.equal(outcomeAllowsSuccess(OUTCOME.ABORT), false);
  assert.equal(outcomeAllowsSuccess(OUTCOME.FAIL), false);
});

test("作业自带中止标记：aborted / stopped / stale 一律 abort，且优先于 done", () => {
  for (const key of ["aborted", "stopped", "stale"]) {
    const j = { status: "done", [key]: true };
    assert.equal(classifyTaskOutcome(j, ctx()), OUTCOME.ABORT, key);
    assert.equal(outcomeIsAbort(classifyTaskOutcome(j, ctx())), true, key);
  }
});

test("全局急停态：即便作业回吐 status:done 也不许按成功收尾", () => {
  assert.equal(classifyTaskOutcome({ status: "done" }, ctx({ stopOn: true })), OUTCOME.ABORT);
  // 这正是用户截图那条：「已急停」+ 完成台词
  assert.equal(outcomeAllowsSuccess(classifyTaskOutcome({ status: "done" }, ctx({ stopOn: true }))), false);
});

test("急停后 15s 内到达的迟到结果仍按 abort；窗口外恢复为正常判定", () => {
  const at = NOW - 3000;
  assert.equal(classifyTaskOutcome({ status: "done" }, ctx({ abortedAt: at })), OUTCOME.ABORT);
  assert.equal(classifyTaskOutcome({ status: "done" }, ctx({ abortedAt: at, now: NOW + ABORT_WINDOW_MS + 1 })), OUTCOME.OK);
  // 时间戳在未来（时钟回拨）不算中止，避免永久卡死在 abort
  assert.equal(classifyTaskOutcome({ status: "done" }, ctx({ abortedAt: NOW + 9999 })), OUTCOME.OK);
});

test("视觉循环被中断：显式 visionAbort 压过 out.ok", () => {
  assert.equal(classifyTaskOutcome({ status: "done" }, ctx({ visionAbort: true })), OUTCOME.ABORT);
});

test("失败信号：error / failed / 取消态 / deny / notDone / 无结果", () => {
  for (const st of ["error", "failed", "cancelled", "canceled"]) {
    assert.equal(classifyTaskOutcome({ status: st }, ctx()), OUTCOME.FAIL, st);
  }
  assert.equal(classifyTaskOutcome({}, ctx({ error: "boom" })), OUTCOME.FAIL);
  assert.equal(classifyTaskOutcome({}, ctx({ deny: true })), OUTCOME.FAIL);
  assert.equal(classifyTaskOutcome({}, ctx({ notDone: true })), OUTCOME.FAIL);
  assert.equal(classifyTaskOutcome({}, ctx({ hasResult: false })), OUTCOME.FAIL);
});

test("未知状态一律按未成功兜住，不认识就等于不能报成功", () => {
  assert.equal(classifyTaskOutcome({ status: "running" }, ctx()), OUTCOME.FAIL);
  assert.equal(classifyTaskOutcome({ status: "whatever" }, ctx()), OUTCOME.FAIL);
  assert.equal(classifyTaskOutcome(null, ctx()), OUTCOME.OK, "空作业按旧桥契约放行，由调用方补结果判定");
});

test("优先级 abort > fail > ok：同时带 error 与急停仍判 abort", () => {
  assert.equal(classifyTaskOutcome({ status: "error", stopped: true }, ctx()), OUTCOME.ABORT);
  assert.equal(classifyTaskOutcome({ status: "error" }, ctx({ stopOn: true })), OUTCOME.ABORT);
  assert.equal(classifyTaskOutcome({ status: "error" }, ctx()), OUTCOME.FAIL);
});

/* ---------- 2. 接线契约：静态锁住，防被顺手改掉 ---------- */

/** 取两个标记之间的源码（带行号无关的纯文本切片）。 */
function sliceBetween(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  assert.ok(i >= 0, "找不到 " + a);
  assert.ok(j > i, "找不到 " + b);
  return src.slice(i, j);
}

test("#143 运行条在输入框下方：#liveBar 位于 .compose 内、#input 之后，且顶栏下已无它", () => {
  const compose = sliceBetween('<div class="compose">', '<div class="mask"');
  const iInput = compose.indexOf('id="input"');
  const iBar = compose.indexOf('id="liveBar"');
  assert.ok(iInput >= 0, "compose 里应有输入框");
  assert.ok(iBar > iInput, "#liveBar 必须排在 #input 之后（输入框下方）");
  // 顶栏与 .strip 之间不应再有运行条
  const headerToStrip = sliceBetween("</header>", '<div class="strip">');
  assert.ok(!headerToStrip.includes('id="liveBar"'), "运行条不该还留在顶栏下方");
  assert.ok(CSS.includes(".compose #liveBar"), "应有嵌入 compose 后的几何覆盖样式");
});

test("#145 运行条耗时由本地 1s 心跳推进，不依赖状态帧到达", () => {
  const live = sliceBetween("let lastLive = null", "function fmtTok(");
  assert.ok(/function renderLiveBar\(/.test(live), "应有独立的渲染函数");
  assert.ok(/function startLiveTick\(/.test(live), "应有本地心跳");
  assert.ok(/setInterval\([\s\S]{0,160}?, 1000\)/.test(live), "心跳间隔必须是 1 秒");
  assert.ok(/startLiveTick\(\)/.test(live) && /stopLiveTick\(\)/.test(live), "applyLive 要按活跃态启停心跳");
  assert.ok(/personaTick\(L\)/.test(live), "过程播报仍留在 applyLive，不能被每秒重画调用");
  assert.ok(!/personaTick/.test(live.slice(0, live.indexOf("function applyLive"))),
    "renderLiveBar / 心跳里不得调 personaTick（否则每秒会说一句）");
});

test("#145 气泡里「生成中 · N 秒」也由本地心跳推进", () => {
  const tick = sliceBetween("function startElapsedTick()", "const STREAM_CAP");
  assert.ok(/生成中 · /.test(tick), "应处理生成中状态文案");
  assert.ok(/replace\(\/·\\s\*\\d\+\\s\*秒\//.test(tick) || /replace\(.*秒/.test(tick),
    "应只替换秒数，保留字数与首字耗时");
  assert.ok(/setInterval\([\s\S]{0,2000}?, 1000\)/.test(tick), "仍是 1 秒心跳");
});

test("#144 所有成功入口都经过统一定闸", () => {
  const done = sliceBetween("function onTaskDone(o)", "function onTaskFail()");
  assert.ok(/classifyTaskOutcome\(/.test(done), "onTaskDone 必须先过统一判定");
  assert.ok(/outcomeAllowsSuccess\(/.test(done), "必须按判定结果决定是否允许成功收尾");
  assert.ok(/onTaskAborted\(/.test(done), "不成功时要走中性收尾");
  assert.ok(done.indexOf("classifyTaskOutcome") < done.indexOf("reviewRun"),
    "判定必须在任何成功副作用（复核/台词）之前");
});

test("#144 急停跳变会掐掉已排队/在播的成功台词，并记下中止时刻", () => {
  const stop = sliceBetween("function renderStop(s)", "/* 单独查一次急停状态");
  assert.ok(/const wasOn = stopOn/.test(stop), "必须检测 false→true 跳变");
  assert.ok(/markTaskAbort\(/.test(stop), "跳变时要做现场清理");
  const mark = sliceBetween("function markTaskAbort(reason)", "function onTaskAborted(");
  assert.ok(/ttsStop\(\)/.test(mark), "必须掐掉 TTS 队列与在播音频");
  assert.ok(/pbLines = null/.test(mark), "必须作废迟到的 AI 完成台词");
  assert.ok(/taskAbortedAt = Date\.now\(\)/.test(mark), "必须记中止时刻供迟到结果判定");
});

test("#144 中止/失败的统计按未成功处理，且不播完成台词", () => {
  const ab = sliceBetween("function onTaskAborted(outcome)", "function onTaskDone(o)");
  assert.ok(/statFail\+\+/.test(ab), "统计上判失败（用户要求）");
  assert.ok(/statDone = 0/.test(ab), "连胜计数必须归零");
  assert.ok(!/speakSituation\(/.test(ab) && !/personaFinish\(/.test(ab), "不得播任何台词");
  assert.ok(/ttsStop\(\)/.test(ab), "仍要掐掉已排队的完成台词");
});

test("#144 后台 poll 与视觉循环两条收尾链路都接进判定", () => {
  assert.ok(src.includes("onTaskDone({ silent: node.dataset.silentResult === '1', job: j })"),
    "poll 成功收尾要带 job 快照");
  assert.ok(/if \(visionAbort\) \{[\s\S]{0,200}?out\.aborted = true/.test(src),
    "视觉循环中断要显式落进 out");
  assert.ok(/if \(out\.aborted\) \{\s*onTaskAborted\(OUTCOME\.ABORT\)/.test(src),
    "视觉循环中断要走中性收尾，不能落到 onTaskDone");
  assert.ok(/const ocDone = classifyTaskOutcome\(j, taskOutcomeCtx\(\)\)/.test(src),
    "写「后台完成」气泡之前必须再过一次判定");
  assert.ok(/if \(!outcomeAllowsSuccess\(ocDone\)\)[\s\S]{0,400}?onTaskAborted\(ocDone\)/.test(src),
    "判定不通过时气泡要改成中止文案，不能仍显示「后台完成」");
  assert.ok(/onTaskAborted\(OUTCOME\.ABORT\);\s*\n\s*return;/.test(src),
    "poll 的 aborted/stopped/stale 分支要统一收尾");
});

test("#144 静默消费者也按同一口径拒绝急停/错误结果", () => {
  const silent = sliceBetween("const handler = silentHandlers.get(id);", "setRunning(-1);");
  assert.ok(/classifyTaskOutcome\(j, taskOutcomeCtx\(\)\)/.test(silent),
    "静默分支必须用同一判定，不能只枚举 j.stopped/aborted/stale");
});
