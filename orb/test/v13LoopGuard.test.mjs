/* S4 / V-13 / C-07 降级纪律单测：锁住「脱离视觉循环」三条红线。
 *   ① 降级信号命中时 enterVisual 恒为 false（明确不接回 runVision()）；
 *   ② 自属 Electron 界面 / 无快照表面 / ref 失效 / 覆盖不足 / 预算耗尽各有正式错误状态；
 *   ③ 未注入 degradation 时 createAnchorResolver 行为完全不变（存量回放不受影响）。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideDegradation, createVisualLoopBudget, isSelfElectronWindow,
  DEGRADATION_CODES, DEGRADE_TO, V13_THRESHOLDS, V13_METRICS,
} from "../v13LoopGuard.mjs";
import { createAnchorResolver } from "../anchorResolver.mjs";

/* ---------- 降级裁决 ---------- */
test("无降级信号 → 允许视觉；降级时 enterVisual 恒为 false", () => {
  const ok = decideDegradation({});
  assert.equal(ok.enterVisual, true);
  assert.equal(ok.degrade, false);
  const deg = decideDegradation({ selfElectron: true });
  assert.equal(deg.enterVisual, false, "降级绝不接回视觉循环");
  assert.equal(deg.degrade, true);
  assert.ok(deg.degradeTo !== "visual" && deg.degradeTo !== null);
});

test("① 自属 Electron 界面 → A11Y_DEGRADED，走 window 降级，不进视觉循环（验收 #4）", () => {
  const d = decideDegradation({ selfElectron: true });
  assert.equal(d.code, DEGRADATION_CODES.SELF_ELECTRON);
  assert.equal(d.degradeTo, DEGRADE_TO.WINDOW);
  assert.match(d.reason, /不进视觉循环/);
});

test("② 无快照表面 → PLATFORM_NOT_SUPPORTED，降级交人工", () => {
  const a = decideDegradation({ platformUnsupported: true });
  const b = decideDegradation({ snapshotSurface: false });
  assert.equal(a.code, DEGRADATION_CODES.PLATFORM_UNSUPPORTED);
  assert.equal(b.code, DEGRADATION_CODES.PLATFORM_UNSUPPORTED);
  assert.equal(a.degradeTo, DEGRADE_TO.HUMAN);
});

test("③ ref 失效 → STALE_REF 重抓快照、同名 → AMBIGUOUS_TARGET，都不误点不转视觉", () => {
  const stale = decideDegradation({ refBindingCheck: { ok: false, code: "STALE_REF" } });
  assert.equal(stale.code, DEGRADATION_CODES.STALE_REF);
  assert.equal(stale.reSnapshot, true);
  assert.equal(stale.enterVisual, false);
  const ambig = decideDegradation({ refBindingCheck: { ok: false, code: "AMBIGUOUS_TARGET" } });
  assert.equal(ambig.code, DEGRADATION_CODES.AMBIGUOUS_TARGET);
  assert.equal(ambig.reSnapshot, true);
});

test("④ 关键控件覆盖低于阈值 → 降级；达标 → 放行", () => {
  const thr = V13_THRESHOLDS[V13_METRICS.KEY_CONTROL_COVERAGE];
  const low = decideDegradation({ keyControlCoverage: thr - 0.01 });
  assert.equal(low.code, DEGRADATION_CODES.LOW_COVERAGE);
  assert.equal(low.enterVisual, false);
  assert.equal(decideDegradation({ keyControlCoverage: thr }).degrade, false);
});

test("⑤ 视觉循环预算耗尽 → VISUAL_LOOP_EXHAUSTED（独立刹车）", () => {
  const d = decideDegradation({ visualAttempts: 3 }, { maxVisualAttempts: 3 });
  assert.equal(d.code, DEGRADATION_CODES.LOOP_EXHAUSTED);
  assert.equal(d.enterVisual, false);
  assert.equal(decideDegradation({ visualAttempts: 2 }, { maxVisualAttempts: 3 }).degrade, false);
});

test("优先级：自属界面 > 平台 > ref > 覆盖 > 预算（越硬的红线越先判）", () => {
  const d = decideDegradation({
    selfElectron: true, platformUnsupported: true,
    refBindingCheck: { ok: false, code: "STALE_REF" },
    keyControlCoverage: 0, visualAttempts: 99,
  });
  assert.equal(d.code, DEGRADATION_CODES.SELF_ELECTRON);
});

/* ---------- 视觉循环预算 ---------- */
test("createVisualLoopBudget：take 累计、exhausted、reset", () => {
  const b = createVisualLoopBudget(2);
  assert.equal(b.remaining(), 2);
  b.take();
  assert.equal(b.remaining(), 1);
  assert.equal(b.exhausted(), false);
  b.take();
  assert.equal(b.exhausted(), true);
  b.reset();
  assert.equal(b.used(), 0);
  assert.equal(b.exhausted(), false);
  assert.equal(b.cap(), 2);
});

/* ---------- 自属界面识别 ---------- */
test("isSelfElectronWindow：识别 ORB 自属窗口，放行普通应用", () => {
  assert.equal(isSelfElectronWindow("ORB 控制台"), true);
  assert.equal(isSelfElectronWindow("ORB 面板 - 设置"), true);
  assert.equal(isSelfElectronWindow("悬浮球"), true);
  assert.equal(isSelfElectronWindow(""), false);
  assert.equal(isSelfElectronWindow("记事本"), false);
  assert.equal(isSelfElectronWindow(null), false);
  assert.equal(isSelfElectronWindow("自定义窗口", [/自定义/]), true);
});

/* ---------- 与 anchorResolver 集成：降级时跳过视觉档 ---------- */
function stepWithVisualCrop() {
  // 一个必走 ③ 视觉档的 step（无 tree/text/window，只有录制坐标 + visualCrop）
  return { server: "windows", tool: "Click", args: { loc: [100, 100], anchor: "某按钮" },
    visualCrop: "AAAA", win: { title: "ORB 控制台" } };
}

test("createAnchorResolver：未注入 degradation → 仍会调用视觉档（存量行为不变）", async () => {
  let visualCalled = false;
  const resolve = createAnchorResolver({
    anchorByVisual: async () => { visualCalled = true; return { x: 1, y: 2, ref: "visual:template" }; },
  });
  const r = await resolve(stepWithVisualCrop());
  assert.equal(visualCalled, true);
  assert.equal(r.conf, "visual");
  assert.equal(r.element.degradation, undefined, "未降级时不得新增字段");
});

test("createAnchorResolver：降级命中 → 跳过视觉档、element 带 degradation、onLoopExit 触发", async () => {
  let visualCalled = false;
  const exits = [];
  const resolve = createAnchorResolver({
    anchorByVisual: async () => { visualCalled = true; return { x: 1, y: 2 }; },
    degradation: (step) => ({ selfElectron: isSelfElectronWindow(step.win?.title), visualAttempts: 0 }),
    onLoopExit: (e) => exits.push(e),
  });
  const r = await resolve(stepWithVisualCrop());
  assert.equal(visualCalled, false, "降级时绝不调用视觉档 = 不接回 runVision()");
  assert.notEqual(r.conf, "visual");
  assert.equal(r.element.degradation.code, DEGRADATION_CODES.SELF_ELECTRON);
  assert.equal(r.element.degradation.degradeTo, DEGRADE_TO.WINDOW);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, DEGRADATION_CODES.SELF_ELECTRON);
});

test("createAnchorResolver：tree 命中时也带 degradation 标记（桥可读到，不误升级）", async () => {
  const resolve = createAnchorResolver({
    anchorByTree: async () => ({ x: 5, y: 6, ref: "sig" }),
    anchorByVisual: async () => ({ x: 1, y: 2 }),
    degradation: () => ({ selfElectron: true }),
  });
  const r = await resolve(stepWithVisualCrop());
  assert.equal(r.conf, "tree");
  assert.equal(r.element.degradation.code, DEGRADATION_CODES.SELF_ELECTRON);
});
