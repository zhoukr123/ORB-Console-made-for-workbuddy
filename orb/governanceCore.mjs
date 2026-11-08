/* 治理总闸：四档矩阵的唯一真相源。
 *
 * 对应《综合性方案-自动化与专家团治理革新.md》§4.1 / §4.2。
 * 这里只做确定性判定，不碰网络/文件/子进程 —— 与 ORB 既有模块的风格一致。
 *
 * 硬约束（用户指定，不许被"优化"掉）：
 *   Tier A（封驳评审 + 多 agent 带上下文）严格绑定 team && max。
 *   Tier B（轻治理）绑定 team（不论 max）。
 *   没团队 = 没有任何团队治理，Max 只放大单 agent 并行强度。
 */

export const TIERS = Object.freeze({
  A: Object.freeze(["multi_agent_full_context", "seal_review"]),
  B: Object.freeze(["cost_routing", "file_channel", "evidence_tag", "verify_lite", "red_line", "house_rule"]),
});

export const MODES = Object.freeze({
  normal:       Object.freeze({ team: false, max: false, label: "普通（默认）" }),
  normal_max:   Object.freeze({ team: false, max: true,  label: "普通 + Max" }),
  team_lite:    Object.freeze({ team: true,  max: false, label: "专家团（轻量）" }),
  team_max:     Object.freeze({ team: true,  max: true,  label: "专家团 + Max（满血）" }),
});

/** 由两个正交开关解析档位。参数只认严格布尔，避免 truthy 误判。 */
export function resolveMode({ teamMode, maxMode } = {}) {
  const team = teamMode === true;
  const max = maxMode === true;
  if (!team && !max) return "normal";
  if (!team && max) return "normal_max";
  if (team && !max) return "team_lite";
  return "team_max";
}

/**
 * 该档位启用的治理层。Tier A 只在 team_max 出现，其余一律为空。
 * 返回冻结数组，调用方不得就地改写。
 */
export function enabledGovernance(mode) {
  const m = MODES[mode];
  if (!m) return Object.freeze([]);
  if (!m.team) return Object.freeze([]);
  return m.max
    ? Object.freeze([...TIERS.A, ...TIERS.B])
    : Object.freeze([...TIERS.B]);
}

/** Tier A 总闸。P2 的封驳 / context bag 注入前必须先过这一道。 */
export function isTierAEnabled(mode) {
  return mode === "team_max";
}

/** Tier B 总闸。所有团队档位都开。 */
export function isTierBEnabled(mode) {
  return mode === "team_lite" || mode === "team_max";
}

/** 供面板/日志回显，确定性文本，不参与裁决。 */
export function describeMode(mode) {
  const m = MODES[mode];
  if (!m) return "未知档位";
  const gov = enabledGovernance(mode);
  return `${m.label}｜治理层：${gov.length ? gov.join(", ") : "无"}`;
}

export default { TIERS, MODES, resolveMode, enabledGovernance, isTierAEnabled, isTierBEnabled, describeMode };
