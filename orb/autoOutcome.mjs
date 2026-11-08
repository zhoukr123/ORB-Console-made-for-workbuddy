/* ---------------- 独立结果判定（autoOutcome / OutcomeGate） ----------------
 *
 * 背景：wfPlay 原先「runSteps 没抛异常」就返回 ok:true，而 autoPolicy 又拿这个 ok
 * 当「零退化成功」样本 —— 升降级判据的地基是自证的。本模块把「这次到底成没成」
 * 从执行者手里拿走，只看观测物。
 *
 * 三类结论，与 v2 方案一致：
 *   ok           有正向证据
 *   failed       有反证
 *   needs_review 拿不到证据（默认落这里，绝不因为「没报错」判成功）
 *
 * 证据强度：
 *   strong  配方声明了 postconditions 且命中/落空
 *   weak    未声明判据，但整条运行确实改变了界面指纹
 *   none    什么都没拿到
 *
 * 纯函数模块：不读文件、不碰全局，探测结果全部由调用方注入，便于单测。
 */

export const VERDICT = Object.freeze({
  OK: "ok",
  FAILED: "failed",
  NEEDS_REVIEW: "needs_review",
});

export const EVIDENCE_LEVEL = Object.freeze({
  STRONG: "strong",
  WEAK: "weak",
  NONE: "none",
});

export const OUTCOME_SIGNALS = Object.freeze({
  tree_state: "控件树状态（节点/文本存在）",
  window_state: "窗口状态（标题/前台窗口）",
  data_readback: "数据回读（文件存在/大小/mtime）",
  effect_evidence: "效果证据（动作前后指纹变化）",
});

export const REASON = Object.freeze({
  POSTCONDITION_MET: "postcondition_met",
  POSTCONDITION_UNMET: "postcondition_unmet",
  EVIDENCE_MISSING: "evidence_missing",
  EFFECT_NOT_OBSERVED: "effect_not_observed",
  READONLY_READBACK: "readonly_readback",
  NO_SPEC: "no_spec",
  SELF_CLAIM_ONLY: "self_claim_only",
  UNKNOWN_CONDITION: "unknown_condition",
});

const MAX_CONDITIONS = 20;

/** 从配方读判据。老配方没有 outcome 段时返回空 spec（行为不劣化）。 */
export function buildSpec(wf) {
  const src = wf && typeof wf === "object" ? wf.outcome : null;
  if (!src || typeof src !== "object") {
    return { postconditions: [], invariants: [], requireEvidence: false };
  }
  const pcs = Array.isArray(src.postconditions) ? src.postconditions : [];
  return {
    postconditions: pcs
      .filter((p) => p && typeof p === "object" && typeof p.kind === "string")
      .slice(0, MAX_CONDITIONS),
    invariants: Array.isArray(src.invariants)
      ? src.invariants.filter((s) => typeof s === "string").slice(0, MAX_CONDITIONS)
      : [],
    requireEvidence: src.requireEvidence === true,
  };
}

/** 单条判据 → { observed: true|false|null, detail }。null = 拿不到观测，不当作失败。 */
export function checkPostcondition(pc, evidence = {}) {
  const kind = String(pc.kind || "");

  if (kind === "tree_state") {
    const t = evidence.tree;
    if (!t || typeof t.text !== "string") return { observed: null, detail: "拿不到控件树" };
    if (pc.text != null && String(pc.text) !== "") {
      const hit = t.text.includes(String(pc.text));
      return { observed: hit, detail: `控件树${hit ? "包含" : "不包含"}「${pc.text}」` };
    }
    return { observed: t.text.length > 0, detail: "控件树非空" };
  }

  if (kind === "window_state") {
    const w = evidence.window;
    if (!w || typeof w.title !== "string" || !w.title) {
      return { observed: null, detail: "拿不到窗口信息" };
    }
    if (pc.titleIncludes != null && String(pc.titleIncludes) !== "") {
      const hit = w.title.includes(String(pc.titleIncludes));
      return { observed: hit, detail: `窗口标题${hit ? "包含" : "不含"}「${pc.titleIncludes}」` };
    }
    return { observed: true, detail: `当前窗口「${w.title}」` };
  }

  if (kind === "data_readback") {
    const key = String(pc.path || "");
    const r = evidence.readback && key ? evidence.readback[key] : null;
    if (!r || typeof r.exists !== "boolean") return { observed: null, detail: "没有回读结果" };
    if (pc.exists === false) return { observed: r.exists === false, detail: "应不存在" };
    if (!r.exists) return { observed: false, detail: "文件不存在" };
    if (pc.minBytes != null && !(Number(r.bytes) >= Number(pc.minBytes))) {
      return { observed: false, detail: `大小 ${r.bytes} < ${pc.minBytes}` };
    }
    if (pc.mtimeAfter != null && !(Number(r.mtime) >= Number(pc.mtimeAfter))) {
      return { observed: false, detail: "mtime 未更新" };
    }
    return { observed: true, detail: "文件回读通过" };
  }

  if (kind === "effect_evidence") {
    const e = evidence.effect;
    if (!e || typeof e.changed !== "boolean") return { observed: null, detail: "没有效果证据" };
    return { observed: e.changed === true, detail: e.changed ? "前后指纹有变化" : "前后指纹一致" };
  }

  return { observed: null, detail: `未知判据「${kind}」`, unknown: true };
}

/**
 * 判定主函数。
 * 输入：{ spec, evidence, quality, selfClaim }
 *   quality  = wfPlay 的 ctx.q（verifyFailed / anchorFallbacks / ...）
 *   selfClaim = ctx.finished（模型自述达成）—— 只能当 needs_review 的输入，绝不单独判 ok
 */
export function judge(input = {}) {
  const spec = input.spec && typeof input.spec === "object" ? input.spec : { postconditions: [] };
  const evidence = input.evidence && typeof input.evidence === "object" ? input.evidence : {};
  const q = input.quality && typeof input.quality === "object" ? input.quality : {};
  const selfClaim = input.selfClaim === true;

  const rows = [];
  let anyFalse = false;
  let anyUnknown = false;
  let anyTrue = 0;

  for (const pc of spec.postconditions || []) {
    const r = checkPostcondition(pc, evidence);
    rows.push({ signal: String(pc.kind || ""), observed: r.observed, detail: r.detail, expected: pc });
    if (r.observed === false) anyFalse = true;
    else if (r.observed === null) anyUnknown = true;
    else anyTrue++;
  }

  const verifyFailed = Number(q.verifyFailed) || 0;
  const anchorFallbacks = Number(q.anchorFallbacks) || 0;
  const effect = evidence.effect && typeof evidence.effect === "object" ? evidence.effect : null;

  /* 一、配方声明了判据：以判据为准。 */
  if ((spec.postconditions || []).length > 0) {
    if (anyFalse) {
      return make(VERDICT.FAILED, EVIDENCE_LEVEL.STRONG, REASON.POSTCONDITION_UNMET, rows, selfClaim);
    }
    if (anyUnknown) {
      return make(VERDICT.NEEDS_REVIEW, EVIDENCE_LEVEL.NONE, REASON.EVIDENCE_MISSING, rows, selfClaim);
    }
    if (anyTrue > 0) {
      return make(VERDICT.OK, EVIDENCE_LEVEL.STRONG, REASON.POSTCONDITION_MET, rows, selfClaim);
    }
    return make(VERDICT.NEEDS_REVIEW, EVIDENCE_LEVEL.NONE, REASON.EVIDENCE_MISSING, rows, selfClaim);
  }

  /* 二、没有判据：只接受明确反证或弱正向证据。 */
  if (verifyFailed > 0 || anchorFallbacks > 0) {
    rows.push({
      signal: "effect_evidence",
      observed: false,
      detail: `退化计数：verifyFailed=${verifyFailed} anchorFallbacks=${anchorFallbacks}`,
    });
    return make(VERDICT.FAILED, EVIDENCE_LEVEL.STRONG, REASON.EFFECT_NOT_OBSERVED, rows, selfClaim);
  }

  if (effect && effect.changed === true) {
    rows.push({
      signal: "effect_evidence",
      observed: true,
      detail: "整条运行改变了界面指纹（弱证据：未声明判据）",
    });
    return make(VERDICT.OK, EVIDENCE_LEVEL.WEAK, REASON.NO_SPEC, rows, selfClaim);
  }

  /* 三、纯只读配方：没有副作用可观测，判据退到「工具确实回了数据」。
     这不是自证 —— readbackCount 是工具返回值的实测条数，不是执行器或模型的说法。
     没有这一步，所有只读配方都会永远落 needs_review，样本永远攒不够。 */
  if (input.readonly === true) {
    const n = Number(evidence.readbackCount) || 0;
    rows.push({ signal: "data_readback", observed: n > 0, detail: `只读运行，实测回读 ${n} 次` });
    if (n > 0) return make(VERDICT.OK, EVIDENCE_LEVEL.WEAK, REASON.READONLY_READBACK, rows, selfClaim);
    return make(VERDICT.NEEDS_REVIEW, EVIDENCE_LEVEL.NONE, REASON.EVIDENCE_MISSING, rows, selfClaim);
  }

  rows.push({
    signal: "effect_evidence",
    observed: effect ? effect.changed === true : null,
    detail: effect ? "前后指纹一致，没有任何可观测效果" : "没有效果证据",
  });
  return make(
    VERDICT.NEEDS_REVIEW,
    EVIDENCE_LEVEL.NONE,
    selfClaim ? REASON.SELF_CLAIM_ONLY : REASON.NO_SPEC,
    rows,
    selfClaim,
  );
}

function make(verdict, evidenceLevel, outcomeReasonCode, rows, selfClaim) {
  return {
    verdict,
    evidenceLevel,
    outcomeReasonCode,
    evidence: rows.slice(0, 24),
    independent: true,               // 判据只读观测物，不读执行者推理
    modelUsed: false,                // 目前全部是非模型判据
    selfClaimed: selfClaim,          // 如实记录「模型自述过达成」，但不据此判 ok
    at: Date.now(),
  };
}

/** verdict → wfRunLedger 的 status。needs_review 单独成一档，不进升降级样本。 */
export function toRunStatus(verdict) {
  if (verdict === VERDICT.OK) return "ok";
  if (verdict === VERDICT.FAILED) return "failed";
  return "needs_review";
}

/** 是否可作为自动升降级的样本：needs_review 不算成功也不算失败。 */
export function isSample(verdict) {
  return verdict === VERDICT.OK || verdict === VERDICT.FAILED;
}

export default {
  VERDICT,
  EVIDENCE_LEVEL,
  OUTCOME_SIGNALS,
  REASON,
  buildSpec,
  checkPostcondition,
  judge,
  toRunStatus,
  isSample,
};
