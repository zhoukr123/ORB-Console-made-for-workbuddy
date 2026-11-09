/* V-13 / C-07 降级纪律 + 视觉循环预算（纯模块，可单测）。
 *
 * 方案 S4 的硬约束（原文）：
 *   「阈值写进 anchorResolver / refBinding；STALE_REF / AMBIGUOUS_TARGET 落成正式错误状态
 *     （调用前快照校验、失败后重抓）；**明确不接回 runVision()**」
 *   「护栏 6：V-13 / C-07 降级纪律」「a11y:degraded 不回流视觉（降级终点是网页/人工）」
 *   验收总纲 #4：Electron 自身界面走降级且不进视觉循环。
 *
 * 一句话：**降级就是降级，绝不因为"树/OCR 找不到"又偷偷回到"反复截图 → 视觉模型猜坐标"的循环**。
 * 视觉循环是 token 黑洞，也是 Knight Capital 式"进程活着但没在推进"的温床。
 *
 * 本模块零副作用、零 import（除 v13Metrics 的阈值），全部判定是纯函数，便于单测锁行为。
 */
import { V13_THRESHOLDS, V13_METRICS } from "./v13Metrics.mjs";

export { V13_THRESHOLDS, V13_METRICS };

/** 降级处置的正式错误状态（与 refBinding.mjs / anchorResolver.mjs 的错误码对齐）。 */
export const DEGRADATION_CODES = Object.freeze({
  SELF_ELECTRON: "A11Y_DEGRADED",              // 自属 Electron 界面：UIA 读不到，走降级
  PLATFORM_UNSUPPORTED: "PLATFORM_NOT_SUPPORTED", // 无快照表面
  STALE_REF: "STALE_REF",                       // ref 失效
  AMBIGUOUS_TARGET: "AMBIGUOUS_TARGET",         // 同名多控件
  LOW_COVERAGE: "A11Y_LOW_COVERAGE",            // 关键控件语义覆盖低于阈值
  LOOP_EXHAUSTED: "VISUAL_LOOP_EXHAUSTED",      // 视觉循环预算耗尽
  NONE: null,
});

/** 降级终点：结构化/窗口/绝对坐标/人工，唯独没有 'visual'。 */
export const DEGRADE_TO = Object.freeze({
  STRUCTURED: "structured",
  WINDOW: "window",
  ABSOLUTE: "absolute",
  HUMAN: "human",
});

/**
 * 降级纪律裁决（纯函数）。输入"现场信号"，输出"要不要进视觉循环 + 怎么降级"。
 *
 * signals:
 *   selfElectron        {boolean} 目标是 ORB 自属 Electron 界面（main.js 默认不开无障碍树）
 *   platformUnsupported {boolean} 平台无 a11y 快照表面
 *   snapshotSurface     {boolean} refBinding 口径的快照表面（false 视为不支持）
 *   refBindingCheck     {object}  checkRefBinding 的返回（{ok, code}）；失败按其 code 处置
 *   keyControlCoverage  {number}  V-13 关键控件语义覆盖（0..1）
 *   visualAttempts      {number}  已用掉的视觉循环轮数
 *   maxVisualAttempts   {number}  视觉循环预算上限（默认取 opts）
 *
 * 返回：
 *   { enterVisual, degrade, code, reason, degradeTo, reSnapshot }
 *   · enterVisual=true  仅当没有任何降级信号且预算未耗尽
 *   · degrade=true 时 enterVisual 恒为 false —— 这就是「不接回 runVision()」
 *   · reSnapshot=true 表示 STALE_REF/AMBIGUOUS_TARGET 应先重抓快照再结构化重定位，而非点旧坐标
 */
export function decideDegradation(signals = {}, opts = {}) {
  const s = signals || {};
  const thresholds = opts.thresholds || V13_THRESHOLDS;
  const maxAttempts = Number.isFinite(opts.maxVisualAttempts) ? opts.maxVisualAttempts : 3;
  const ok = {
    enterVisual: true, degrade: false, code: DEGRADATION_CODES.NONE,
    reason: "无降级信号，允许结构化/视觉锚定", degradeTo: null, reSnapshot: false,
  };

  // ① 自属 Electron 界面：UIA 读不到，视觉模型也读不到语义，绝不进视觉循环。
  if (s.selfElectron === true) {
    return {
      enterVisual: false, degrade: true, code: DEGRADATION_CODES.SELF_ELECTRON,
      reason: "自属 Electron 界面默认无无障碍树：走结构化/窗口降级，不进视觉循环（验收 #4）",
      degradeTo: DEGRADE_TO.WINDOW, reSnapshot: false,
    };
  }

  // ② 平台无快照表面：结构化与视觉都不可靠，直接降级 + 交人工。
  if (s.platformUnsupported === true || s.snapshotSurface === false) {
    return {
      enterVisual: false, degrade: true, code: DEGRADATION_CODES.PLATFORM_UNSUPPORTED,
      reason: "无 a11y 快照表面：降级到绝对坐标/人工，不进视觉循环",
      degradeTo: DEGRADE_TO.HUMAN, reSnapshot: false,
    };
  }

  // ③ ref 绑定失败：落成正式错误状态，先重抓快照再结构化重定位，绝不点旧坐标、绝不转视觉。
  const chk = s.refBindingCheck;
  if (chk && chk.ok === false) {
    const isStale = chk.code === "STALE_REF" || chk.code === "SNAPSHOT_MISMATCH" || chk.code === "TOOL_VERSION_MISMATCH";
    const isAmbig = chk.code === "AMBIGUOUS_TARGET";
    if (isStale || isAmbig) {
      return {
        enterVisual: false, degrade: true,
        code: isAmbig ? DEGRADATION_CODES.AMBIGUOUS_TARGET : DEGRADATION_CODES.STALE_REF,
        reason: `ref 绑定失败（${chk.code}）：重抓快照后结构化重定位，不误点、不接回视觉`,
        degradeTo: DEGRADE_TO.STRUCTURED, reSnapshot: true,
      };
    }
    // 其它绑定失败（PLATFORM_NOT_SUPPORTED 等）已在 ② 覆盖；这里保守降级但不重抓。
    return {
      enterVisual: false, degrade: true, code: chk.code || DEGRADATION_CODES.STALE_REF,
      reason: `ref 绑定失败（${chk.code}）：降级，不进视觉循环`,
      degradeTo: DEGRADE_TO.ABSOLUTE, reSnapshot: false,
    };
  }

  // ④ 关键控件语义覆盖低于 V-13 阈值：树不可信，降级不烧视觉。
  const cov = s.keyControlCoverage;
  if (Number.isFinite(cov) && cov < thresholds[V13_METRICS.KEY_CONTROL_COVERAGE]) {
    return {
      enterVisual: false, degrade: true, code: DEGRADATION_CODES.LOW_COVERAGE,
      reason: `关键控件语义覆盖 ${cov} < 阈值 ${thresholds[V13_METRICS.KEY_CONTROL_COVERAGE]}：降级，不进视觉循环`,
      degradeTo: DEGRADE_TO.WINDOW, reSnapshot: false,
    };
  }

  // ⑤ 视觉循环预算耗尽：这是"脱离"的另一半 —— 就算前面都放行，也不允许无限截图。
  const used = Number(s.visualAttempts) || 0;
  if (used >= maxAttempts) {
    return {
      enterVisual: false, degrade: true, code: DEGRADATION_CODES.LOOP_EXHAUSTED,
      reason: `视觉循环已用 ${used}/${maxAttempts} 轮：脱离循环，降级/交人工（独立刹车）`,
      degradeTo: DEGRADE_TO.HUMAN, reSnapshot: false,
    };
  }

  return ok;
}

/**
 * 视觉循环预算（有界计数器，纯工厂）。bridge 的 takeover 每进入一轮记一次，
 * 超过上限后 decideDegradation 会强制脱离。reset() 供新的一次回放清零。
 */
export function createVisualLoopBudget(maxAttempts = 3) {
  let used = 0;
  const cap = Math.max(0, Number(maxAttempts) || 0);
  return {
    take() { used++; return used; },
    used: () => used,
    remaining: () => Math.max(0, cap - used),
    exhausted: () => used >= cap,
    reset() { used = 0; },
    cap: () => cap,
  };
}

/** 判断一个窗口标题是否是 ORB 自属 Electron 界面（纯函数，供 bridge 注入现场判定）。 */
const SELF_TITLES = [
  /ORB\s*控制台/i, /ORB\s*Console/i, /ORB\s*面板/i, /ORB\s*Panel/i,
  /悬浮球/i, /划词工具条/i, /实时字幕/i, /首跑向导/i, /ORB\s*设置/i,
];
export function isSelfElectronWindow(title, extraPatterns = []) {
  const t = String(title || "").trim();
  if (!t) return false;
  return [...SELF_TITLES, ...(extraPatterns || [])].some((re) => re instanceof RegExp ? re.test(t) : t.includes(String(re)));
}

export default {
  DEGRADATION_CODES, DEGRADE_TO, V13_THRESHOLDS, V13_METRICS,
  decideDegradation, createVisualLoopBudget, isSelfElectronWindow,
};
