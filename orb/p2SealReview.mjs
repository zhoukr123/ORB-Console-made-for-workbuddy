/* P2 · Tier A 重治理：独立复核评审 + 多 agent 带上下文。
 *
 * 对应《综合性方案》§4.3 / §5 桥接② / §6 P2。
 *
 * 复用声明：评审裁决**不重造**，直接用 ORB 既有 orb/team.mjs 的 createTeam().review()
 *   —— 它已实现 pass/warn/block、needsHuman、冲突不自动裁决、evidence 归档。
 *   本模块只在其上叠加「独立复核否决 + 打回重写」语义与验收标准判据。
 *
 * 硬约束：mode !== "team_max" 一律不进评审（Tier A 严格绑定 团队 && Max）。
 */
import { isTierAEnabled } from "./governanceCore.mjs";
import { admissibleForSeal } from "./p0Discipline.mjs";

/** 复核否决判据（帖子红线 + 方案 §2.2）。 */
export const SEAL_GROUNDS = Object.freeze({
  missing_criteria: "缺可验证验收标准",
  direction_risk: "方向风险",
  redline_conflict: "红线冲突",
  insufficient_evidence: "证据不足（标推断却装已核实）",
});

const str = (v, cap = 4000) => String(v ?? "").trim().slice(0, cap);

/**
 * @param {object} o
 * @param {string} o.mode          governanceCore.resolveMode 的结果
 * @param {Function} [o.teamFactory] 返回 createTeam 实例的工厂；默认惰性加载 ORB team.mjs
 * @param {Function} [o.now]
 */
export function createSealReview({ mode, teamFactory, now = Date.now } = {}) {
  let team = null;
  let teamErr = null;

  async function getTeam() {
    if (team) return team;
    if (teamErr) throw teamErr;
    try {
      const factory = teamFactory || defaultTeamFactory;
      team = await factory();
      if (!team || typeof team.review !== "function") throw new Error("bad-team");
      return team;
    } catch (e) {
      teamErr = e;
      throw e;
    }
  }

  /** 拟案 → 评审 → 执行 三节点。评审不过 = 打回，绝不迁就结果改验收标准。 */
  async function reviewPlan(plan = {}, findings = []) {
    // 总闸：非 team_max 直接拒绝，连评审都不启动（成本不增）
    if (!isTierAEnabled(mode)) {
      return { ok: false, error: "tier-a-disabled", mode, stage: "gate" };
    }
    const criteria = Array.isArray(plan.acceptanceCriteria) ? plan.acceptanceCriteria.filter((x) => str(x)) : [];
    if (!str(plan.subject) || criteria.length === 0) {
      return { ok: false, error: SEAL_GROUNDS.missing_criteria, stage: "propose", grounds: ["missing_criteria"] };
    }

    // 证据准入：独立复核只认带依据的「已核实」
    const ev = admissibleForSeal(plan.evidence || []);
    if (plan.evidence && plan.evidence.length && !ev.ok) {
      return { ok: false, error: SEAL_GROUNDS.insufficient_evidence, stage: "propose", grounds: ["insufficient_evidence"] };
    }

    let t;
    try { t = await getTeam(); }
    catch (e) { return { ok: false, error: "team-unavailable", detail: String(e.message || e), stage: "review" }; }

    const rv = t.review({ subject: str(plan.subject), findings, ticketId: plan.ticketId, epoch: plan.epoch });
    if (!rv || rv.ok !== true) return { ok: false, error: "review-failed", stage: "review" };

    const grounds = [];
    if (rv.verdict === "block") grounds.push("direction_risk");
    if (rv.needsHuman) grounds.push("direction_risk");
    // 安全视角的 block 级发现 = 红线冲突
    if (rv.ranked.some((f) => f.expertId === "sec" && f.severity === "block")) grounds.push("redline_conflict");

    const passed = grounds.length === 0 && rv.verdict === "pass";
    return {
      ok: true,
      passed,
      verdict: rv.verdict,
      needsHuman: !!rv.needsHuman,
      grounds: [...new Set(grounds)].map((g) => SEAL_GROUNDS[g]),
      stage: passed ? "execute" : "rewrite",
      action: passed ? "放行，交执行方执行" : "打回拟案方重写，不得改验收标准迁就结果",
      criteriaLocked: criteria.slice(),  // 验收标准锁死，评审后不得改
      at: now(),
      raw: { counts: rv.counts, rejected: rv.rejected, conflicts: rv.conflicts },
    };
  }

  return { reviewPlan, get _mode() { return mode; } };
}

/** 默认惰性加载 ORB 仓库的 team.mjs；路径不存在时由调用方注入 teamFactory。 */
export async function defaultTeamFactory() {
  const mod = await import(new URL("./team.mjs", import.meta.url).href);
  return mod.createTeam({});
}

/* ── 多 agent 带上下文（多角色分工模型 / context bag）────────────────────
 * 满血档：每个 worker 拿完整任务上下文（需求/红线/派工包/他人交付/验收标准）。
 * 轻量档：worker 只看自己那格 brief（与 expertTeam.mjs 现有「上下文隔离」一致）。
 * 角色边界仍保留：上下文全给 ≠ 可以越权动手（P0 红线 role_breach 仍拦）。
 */
export function buildContextBag({ mode, subject, redLines = [], packets = [], deliverables = [], acceptanceCriteria = [] } = {}) {
  const full = isTierAEnabled(mode);
  const shared = {
    subject: str(subject, 800),
    redLines: redLines.slice(),
    acceptanceCriteria: acceptanceCriteria.slice(),
  };
  return packets.map((p) => {
    const own = { role: p.role, brief: str(p.brief, 600) };
    if (!full) return { mode, ...own };  // 轻量档：最小切片，token 不增
    return {
      mode,
      ...own,
      ...shared,
      otherDeliverables: deliverables.filter((d) => d.role !== p.role).slice(),
      note: "上下文全给，但角色边界不解除",
    };
  });
}

export const INJECTABLE_SEAL_RULE = Object.freeze([
  "【Tier A 总闸】独立复核评审与全量上下文只在「专家团 + Max」同时开启时启用。",
  "【分段制衡】拟案须带可验证验收标准 → 独立复核有实权否决 → 过审才交执行。",
  "【不迁就】评审未过就打回重写，严禁改验收标准迁就结果。",
  "【证据准入】独立复核只认带依据的「已核实」；标「推断」却装「已核实」直接打回。",
  "【满血上下文】每个专家携带需求/红线/派工包/他人交付，但仍各守角色边界。",
]);

export default { createSealReview, buildContextBag, defaultTeamFactory, SEAL_GROUNDS, INJECTABLE_SEAL_RULE };
