/* P3 · 亲测验收 Lite + 五段验收引擎。
 *
 * 对应《综合性方案》§3.4 / §4.4(4) / §5 桥接③ / §6 P3。
 *
 * 核心：声称完成 = 确定性工具真跑过，不用 LLM 法官。
 * 五段：launch → ready → action_delivery → verification → cleanup。
 * 任一段失败即 fail-closed，且必须如实报告，不许谎报成功。
 *
 * 与 ORB 既有能力对齐：验收判据用 URL 变化 / DOM 状态 / 数据回读 / headless 点击
 * 这四类确定性信号（对应 wb_ext_027 的 dom_cua 与 /api/call 的回读）。
 */

export const STAGES = Object.freeze(["launch", "ready", "action_delivery", "verification", "cleanup"]);

/** 每段的确定性判据。all 表示必须全部满足；any 表示任一即可。 */
export const STAGE_CHECKS = Object.freeze({
  launch:          Object.freeze(["url_changed", "page_opened"]),
  ready:           Object.freeze(["dom_ready", "selector_present"]),
  action_delivery: Object.freeze(["action_dispatched", "no_coordinate_used"]),
  verification:    Object.freeze(["data_readback", "state_matches"]),
  cleanup:         Object.freeze(["no_residue", "lock_released"]),
});

/** 四类确定性信号，拒绝「看起来像成功」的非证据输入。 */
export const VERIFY_SIGNALS = Object.freeze({
  url_change: "URL 变化（前后 URL 逐字比对）",
  dom_state: "DOM 状态（选择器存在/文本回读）",
  data_readback: "数据回读（API 返回值非空且匹配）",
  headless_click: "headless 点击（真点过，非视觉点坐标）",
});

/**
 * 单段验收。observed 是该段实际观测到的信号集合。
 * 缺任一条即失败，返回缺口清单（供修复台 appendRepair 消费）。
 */
export function checkStage(stage, observed = []) {
  if (!STAGES.includes(stage)) return { ok: false, error: "unknown-stage", missing: [] };
  const need = STAGE_CHECKS[stage];
  const got = new Set(Array.isArray(observed) ? observed : []);
  const missing = need.filter((x) => !got.has(x));
  return {
    ok: missing.length === 0,
    stage,
    required: need.slice(),
    observed: [...got],
    missing,
    reason: missing.length ? `缺确定性信号：${missing.join(", ")}` : "五段判据齐备",
  };
}

/** 全流程验收：任一段失败即整体失败，且停在第一处失败（不掩盖后续缺口）。 */
export function verifyLite(evidence = {}) {
  const results = [];
  for (const s of STAGES) {
    const r = checkStage(s, evidence[s]);
    results.push(r);
    if (!r.ok) {
      return {
        ok: false, stage: s, missing: r.missing, results,
        verdict: "fail-closed",
        report: `第 ${STAGES.indexOf(s) + 1}/5 段「${s}」未通过：${r.reason}；如实报告，不谎报成功`,
      };
    }
  }
  return {
    ok: true, stage: "cleanup", missing: [], results,
    verdict: "pass",
    report: "五段验收全通过：launch/ready/action_delivery/verification/cleanup 均有确定性证据",
  };
}

/** 「没做出的别说」：把声称完成与验收结果对齐。 */
export function claimDone({ claimed = false, evidence = {}, humanNote = "" } = {}) {
  const v = verifyLite(evidence);
  if (!claimed) return { ok: true, honest: true, statement: "未声称完成", verify: v };
  if (!v.ok) {
    return {
      ok: false, honest: false, verify: v,
      statement: `声称完成但五段验收未过（${v.stage}）；必须如实降级：${String(humanNote).trim() || v.report}`,
      redLine: "claim_without_evidence",
    };
  }
  return { ok: true, honest: true, verify: v, statement: "声称完成，且有确定性验收证据" };
}

export const INJECTABLE_VERIFY_RULE = Object.freeze([
  "声称完成 = 五段验收（launch/ready/action_delivery/verification/cleanup）真跑过。",
  "验收只用确定性工具：URL 变化 / DOM 状态 / 数据回读 / headless 点击，不用 LLM 法官。",
  "任一段缺证据即 fail-closed，停在第一处失败并如实报告，不许谎报成功。",
  "缺口写进修复台，返工后重跑全部五段，不跳过。",
]);

export default {
  STAGES, STAGE_CHECKS, VERIFY_SIGNALS, checkStage, verifyLite, claimDone, INJECTABLE_VERIFY_RULE,
};
