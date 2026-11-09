/* V-13 / C-07 落地：五项指标 + 降级阈值 + 记录表（纯模块，可单测）。
 *
 * 背景：《脱离视觉循环》把"锚定靠不靠谱"拆成五个可验收指标，并给每类应用/窗口建一张
 * 「应用/版本/控件类型 → a11y 覆盖 → 自动/人工 → 失败模式」记录表。阈值写进 anchorResolver /
 * refBinding（验收总纲 #4：V-13 实机报告给出五项指标与降级阈值）。
 *
 * 五项指标（方案原文）：
 *   ① 树获取成功率     treeFetchSuccessRate   —— 快照尝试里能解析出树的比例（需多次采样）
 *   ② 关键控件语义覆盖 keyControlCoverage     —— 关键交互控件里有可用语义身份（name+controlType）的比例
 *   ③ ref 稳定性       refStability           —— 结构化选择器 sig 在重快照间保持稳定（需前后采样）
 *   ④ 操作前后状态变化 prePostStateChangeRate —— 会改界面的动作真正改变树指纹的比例
 *   ⑤ 危险确认元素可见 dangerConfirmVisibility —— 破坏性确认控件（删除/永久/确认）能被树识别的比例
 *
 * 诚实口径：单次快照只能算出 ②③⑤；①④ 必须跨多次采样，没样本就返回 null，绝不补零编造。
 */

export const V13_METRICS = Object.freeze({
  TREE_FETCH_SUCCESS: "treeFetchSuccessRate",
  KEY_CONTROL_COVERAGE: "keyControlCoverage",
  REF_STABILITY: "refStability",
  PRE_POST_STATE_CHANGE: "prePostStateChangeRate",
  DANGER_CONFIRM_VISIBILITY: "dangerConfirmVisibility",
});

/* 降级阈值：任一项低于阈值 → 该场景判定为"应走降级（结构化/窗口兜底，不进视觉循环）"。
 * 数值来自方案验收总纲 #4 与 V-13 实机报告口径，集中放这里便于单测与将来校准。 */
export const V13_THRESHOLDS = Object.freeze({
  treeFetchSuccessRate: 0.95,        // 快照成功率不低于 95%
  keyControlCoverage: 0.80,          // 关键控件语义覆盖不低于 80%
  refStability: 0.90,                // ref 稳定性不低于 90%
  prePostStateChangeRate: 0.60,      // 会改界面的动作至少 60% 真正生效
  dangerConfirmVisibility: 0.99,     // 危险确认元素几乎必须可见（漏判=误点风险）
});

/* 危险确认类标签：命中即视为"破坏性确认控件"，漏识别会直接导致误点。 */
export const DANGER_LABEL_RE =
  /(删除|永久|确认|清空|format|delete|remove|purge|reset|wipe|danger|discard)/i;

/* 单次树能直接算出的指标（②③⑤）。treeText 用于 ⑤ 的破坏性确认探测。 */
export function computeTreeMetrics(coverage, { treeText = "" } = {}) {
  const c = coverage || {};
  const actionable = Number(c.actionableNodes) || 0;
  const withIdentity = Number(c.withAction) || Number(c.withCoordinates) || 0;
  const keyControlCoverage = actionable > 0 ? withIdentity / actionable : (actionable === 0 ? null : 0);

  const dangerVisible = DANGER_LABEL_RE.test(String(treeText || ""));

  return {
    // ① 需多次采样
    [V13_METRICS.TREE_FETCH_SUCCESS]: null,
    // ② 关键控件语义覆盖
    [V13_METRICS.KEY_CONTROL_COVERAGE]: keyControlCoverage == null ? null : Number(keyControlCoverage.toFixed(4)),
    // ③ 需前后采样
    [V13_METRICS.REF_STABILITY]: null,
    // ④ 需前后采样
    [V13_METRICS.PRE_POST_STATE_CHANGE]: null,
    // ⑤ 危险确认元素可见（这里给"是否探测到"，比例由多次采样累计）
    [V13_METRICS.DANGER_CONFIRM_VISIBILITY]: dangerVisible ? 1 : (treeText ? 0 : null),
  };
}

/* 把单次指标对照阈值判 pass/fail；null（缺样本）一律判为 undetermined，不误伤也不谎称通过。 */
export function evaluateMetric(metric, value, threshold = V13_THRESHOLDS[metric]) {
  if (value == null) return { metric, value: null, threshold, status: "undetermined" };
  const ok = value >= threshold;
  return { metric, value, threshold, status: ok ? "pass" : "fail" };
}

/**
 * 记录表：按 (app|version|controlType) 分组，累计 a11y 覆盖、自动/人工、失败模式。
 * 可累计跨采样指标（成功率/稳定性/前后变化），用于生成 V-13 实机报告矩阵。
 */
export function createV13RecordingTable() {
  const rows = new Map(); // key -> { app, version, controlType, samples, fetchOk, refStable, prePostChanged, fails:Map }

  function keyOf(app, version, controlType) {
    return `${app || "?"}|${version || "?"}|${controlType || "*"}`;
  }

  return {
    record(sample = {}) {
      const k = keyOf(sample.app, sample.version, sample.controlType);
      const r = rows.get(k) || {
        app: sample.app || "?", version: sample.version || "?", controlType: sample.controlType || "*",
        samples: 0, fetchOk: 0, refStable: 0, prePostChanged: 0,
        mode: sample.mode || "auto",
        fails: new Map(),
      };
      r.samples++;
      if (sample.treeFetched !== false) r.fetchOk++;
      if (sample.refStable === true) r.refStable++;
      if (sample.prePostChanged === true) r.prePostChanged++;
      const fm = String(sample.failureMode || "").slice(0, 80);
      if (fm) r.fails.set(fm, (r.fails.get(fm) || 0) + 1);
      rows.set(k, r);
      return r;
    },

    /** 汇总每个分组的五项指标（跨采样项有样本才出数），并对照阈值给 verdict。 */
    evaluate({ thresholds = V13_THRESHOLDS } = {}) {
      const out = [];
      for (const r of rows.values()) {
        const treeFetchSuccessRate = r.samples ? r.fetchOk / r.samples : null;
        const refStability = r.samples ? r.refStable / r.samples : null;
        const prePostStateChangeRate = r.samples ? r.prePostChanged / r.samples : null;
        // 覆盖 / 危险可见 由最近一次 coverage 样本带入；这里用存储的 lastCoverage。
        const keyControlCoverage = r.lastKeyCoverage ?? null;
        const dangerConfirmVisibility = r.lastDangerVisible == null ? null : (r.lastDangerVisible ? 1 : 0);

        const metrics = {
          [V13_METRICS.TREE_FETCH_SUCCESS]: treeFetchSuccessRate,
          [V13_METRICS.KEY_CONTROL_COVERAGE]: keyControlCoverage,
          [V13_METRICS.REF_STABILITY]: refStability,
          [V13_METRICS.PRE_POST_STATE_CHANGE]: prePostStateChangeRate,
          [V13_METRICS.DANGER_CONFIRM_VISIBILITY]: dangerConfirmVisibility,
        };
        const evaluated = Object.values(V13_METRICS).map((m) => evaluateMetric(m, metrics[m], thresholds[m]));
        const failed = evaluated.filter((e) => e.status === "fail");
        out.push({
          app: r.app, version: r.version, controlType: r.controlType, mode: r.mode,
          samples: r.samples,
          metrics,
          evaluated,
          verdict: failed.length ? "degrade" : "ok",
          reasons: failed.map((e) => `${e.metric}=${e.value} < ${e.threshold}`),
          topFailures: [...r.fails.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, n]) => ({ mode: m, count: n })),
        });
      }
      return out;
    },

    /** 把最后一次单树指标（computeTreeMetrics 的结果）绑到对应分组，供 evaluate 取覆盖/危险项。 */
    attachTreeMetrics(app, version, controlType, metrics = {}) {
      const k = keyOf(app, version, controlType);
      const r = rows.get(k) || this.record({ app, version, controlType });
      r.lastKeyCoverage = metrics[V13_METRICS.KEY_CONTROL_COVERAGE] ?? r.lastKeyCoverage ?? null;
      r.lastDangerVisible = metrics[V13_METRICS.DANGER_CONFIRM_VISIBILITY] == null
        ? r.lastDangerVisible : metrics[V13_METRICS.DANGER_CONFIRM_VISIBILITY] === 1;
      rows.set(k, r);
      return r;
    },

    rows: () => [...rows.values()],
    size: () => rows.size,
  };
}

export default {
  V13_METRICS, V13_THRESHOLDS, DANGER_LABEL_RE,
  computeTreeMetrics, evaluateMetric, createV13RecordingTable,
};
