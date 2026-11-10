/* P0 轻治理纪律：代价路由 / 证据标注 / 协作红线 / 家规。
 *
 * 对应《综合性方案》§4.4 与 §6 P0：prompt + 确定性工具双轨。
 * 设计原则：断言一律 fail-closed；判定纯函数、可逐字测试；不做 LLM 法官。
 *
 * 与 ORB 既有能力的关系：
 *   - 代价路由不重造分类器，复用语义档位 TIERS（semanticRouter.mjs 的 direct/front/vision/back 是另一维度，
 *     这里只做「协作代价」这一档，二者不冲突）。
 *   - 红线复用 ORB 五条边界（权限/副作用/数据/隐蔽/对抗）的语义，不重复实现 cmdGuard。
 */

export const EVIDENCE_TAGS = Object.freeze(["已核实", "推断", "未知"]);

/* ── 1. 代价分级路由 ──────────────────────────────────────────────
 * 输出：solo（单干） / team（轻量团队） / team_seal（团队 + 独立复核）
 * 判据确定性：错了代价小 → 单干；代价大 → 上团队/独立复核。
 * 注意：team_seal 只是"建议档"，真正能否启用仍由 governanceCore.isTierAEnabled(mode) 卡住。
 */
export const COST_LEVELS = Object.freeze({ low: 0, medium: 1, high: 2 });

export function routeByCost({ reversible = true, blastRadius = "local", uncertainty = "low", cost = "low", mode = "normal" } = {}) {
  const c = COST_LEVELS[cost] ?? 0;
  const wide = blastRadius === "external" || blastRadius === "cross_site" || blastRadius === "global";
  const risky = reversible === false || wide || uncertainty === "high" || c >= 2;

  // 小事：无论什么档位都不上团队，token 不增（方案验收标准 1）
  if (!risky && c === 0 && reversible !== false) return "solo";

  // 高代价：建议独立复核，但只有 team_max 真的允许
  const wantsSeal = (reversible === false && wide) || c >= 2 || uncertainty === "high";
  if (wantsSeal) {
    // 这里 import 会造成循环，故用传入的 mode 字符串直接判；语义与 core 一致。
    return mode === "team_max" ? "team_seal" : "team";
  }
  return "team";
}

/* ── 2. 证据标注 ──────────────────────────────────────────────────
 * 每条结论必须带标签；复核闸（若开）只认「已核实」且带依据。
 */
export function tagEvidence(claim, { level = "推断", basis = "" } = {}) {
  if (!EVIDENCE_TAGS.includes(level)) return { ok: false, error: "bad-tag" };
  const text = String(claim ?? "").trim();
  if (!text) return { ok: false, error: "empty-claim" };
  if (level === "已核实" && !String(basis).trim()) {
    return { ok: false, error: "verified-needs-basis" }; // 装"已核实"却无依据 = 复核判据之一
  }
  return { ok: true, claim: text, level, basis: String(basis).trim() };
}

/** 复核闸的证据准入：只认带依据的「已核实」。 */
export function admissibleForSeal(items) {
  if (!Array.isArray(items)) return { ok: false, error: "bad-input", admissible: [] };
  const admissible = items.filter(
    (x) => x && x.ok === true && x.level === "已核实" && String(x.basis || "").trim()
  );
  return {
    ok: admissible.length > 0,
    admissible,
    rejected: items.length - admissible.length,
  };
}

/* ── 3. 协作红线 ──────────────────────────────────────────────────
 * fail-closed：任何一条命中即拒，且给出拒因码（沿用 ORB disposition 习惯）。
 */
export const RED_LINES = Object.freeze({
  irreversible_without_confirm: "不可逆动作缺人工确认",
  claim_without_evidence: "声称完成但无验证证据",
  role_breach: "越出角色边界",
  permission: "权限边界",
  side_effect: "副作用边界",
  data: "数据边界",
  covert: "隐蔽边界",
  adversarial: "对抗边界",
});

export function checkRedLine(action = {}) {
  const reasons = [];
  const {
    irreversible = false, humanConfirmed = false,
    claimedDone = false, verified = false,
    role = "", touched = [],
  } = action;

  if (irreversible && !humanConfirmed) reasons.push("irreversible_without_confirm");
  if (claimedDone && !verified) reasons.push("claim_without_evidence");
  if (role && Array.isArray(touched) && touched.length && touched.some((t) => !isWithinRole(role, t))) {
    reasons.push("role_breach");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    reasonsText: reasons.map((r) => RED_LINES[r] || r),
  };
}

const ROLE_SCOPE = Object.freeze({
  survey: ["read", "material", "scope"],
  build: ["write", "code", "artifact"],
  check: ["verify", "test", "evidence"],
  pack: ["assemble", "format", "report"],
});

function isWithinRole(role, scope) {
  const allowed = ROLE_SCOPE[role];
  if (!allowed) return false;
  return allowed.some((a) => String(scope).includes(a));
}

/* ── 4. 家规 / 身份纪律 ───────────────────────────────────────────
 * 队友命名唯一、称呼即门牌、broadcast 昂贵须走文件信道。
 */
export function checkHouseRule(roster = {}, { addressed = "", broadcastUsed = false } = {}) {
  const names = Object.keys(roster);
  const problems = [];
  if (new Set(names).size !== names.length) problems.push("duplicate-name");
  if (names.some((n) => !/^[a-z][a-z0-9-]{1,31}$/.test(n))) problems.push("bad-name-format");
  if (addressed && !names.includes(addressed)) problems.push("wrong-doorplate");
  if (broadcastUsed) problems.push("broadcast-is-expensive");
  return { ok: problems.length === 0, problems };
}

/** 可注入到专家团 system prompt 的条款文本（P0 的 prompt 轨）。 */
export const INJECTABLE_DISCIPLINE = Object.freeze([
  "【代价路由】错了代价小就单干，别拉团队；代价大才上团队并申请独立复核。",
  "【证据标注】每条结论标注 已核实 / 推断 / 未知；标「已核实」必须附依据，否则视为「推断」。",
  "【亲测验收】声称完成 = 真跑过验证；没跑就如实说没做，不许谎报。",
  "【协作红线】不可逆动作须人工确认；没做出的别说；各守角色边界不越界。",
  "【家规】队友命名唯一、称呼即门牌；broadcast 很贵，用共享文件当唯一真相源。",
  "【诚实降级】任一断言失败或超预算，如实报告并降级，不绕过闸门。",
]);

export default {
  EVIDENCE_TAGS, COST_LEVELS, routeByCost, tagEvidence, admissibleForSeal,
  RED_LINES, checkRedLine, checkHouseRule, INJECTABLE_DISCIPLINE,
};
