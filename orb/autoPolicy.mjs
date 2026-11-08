/* ---------------- 自动化升降级判据（autoPolicy） ----------------
 *
 * 方案 §3.4：ORB 自带锚定三道防线、智能接管与 verifyEffect，所以「这条菜谱值不值得
 * 自动跑」不该只看成功率，而要看**确定性执行有没有退化成视觉摸索**。
 *
 *  升 auto   连续 N 次 ok，且 takeovers / anchorFallbacks / verifyFailed 全为 0
 *  降 observe 连续 2 次 failed，或最近一次出现 verifyFailed>0 / takeovers>=2
 *
 * 与云端引擎的差别：它们只能给成功率；ORB 因为自带抗迁移与接管能力，
 * 能把「界面漂移」量化成判据。observe 阶段的**人工回放也算样本** ——
 * 用户手动验证得越干净，越有资格升 auto；不需要为了攒数据去冒险自动点火。
 *
 * 纯模块：不读写文件、不碰全局状态，全部输入通过参数注入，便于单测。
 */
export const MODES = Object.freeze(["observe", "auto"]);

export const DEFAULT_THRESHOLDS = Object.freeze({
  sampleSize: 5,          // 升 auto 需要的连续干净运行次数
  failStreak: 2,          // 连续失败多少次立即降级
  maxTakeovers: 2,        // 单次运行接管达到此数即视为退化
  maxDurationMs: 120000,  // 单次超时（代理成本上限，避免把慢任务当稳定任务）
});

/* 只把「真正跑过」的运行算样本：skipped / interrupted / needs_review 既不算成功也不算失败。
   口径直接复用 OutcomeGate 的 isSample —— 两处各写一份 Set 的话，将来加一档状态
   必然漂移：判定那边说"这不算样本"，取样这边还在拿它算成功率。 */
import { isSample } from "./autoOutcome.mjs";

export function evaluatePolicy(runs = [], opts = {}) {
  const th = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const all = (Array.isArray(runs) ? runs : [])
    .filter((r) => r && isSample(String(r.status || "")))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

  const recent = all.slice(0, Math.max(th.sampleSize, th.failStreak));
  const metrics = {
    samples: all.length,
    ok: all.filter((r) => r.status === "ok").length,
    failed: all.filter((r) => r.status === "failed").length,
    maxTakeovers: recent.reduce((m, r) => Math.max(m, Number(r.takeovers) || 0), 0),
    maxAnchorFallbacks: recent.reduce((m, r) => Math.max(m, Number(r.anchorFallbacks) || 0), 0),
    verifyFailures: recent.reduce((n, r) => n + (Number(r.verifyFailed) || 0), 0),
    maxDurationMs: recent.reduce((m, r) => Math.max(m, Math.max(0, (r.endedAt || 0) - (r.startedAt || 0))), 0),
    autoFires: all.filter((r) => r.layer && r.layer !== "manual").length,
  };

  /* 尾部连续失败：只看最近若干条，从新往旧数。 */
  let failStreak = 0;
  for (const r of all) {
    if (r.status !== "failed") break;
    failStreak++;
  }

  let recommendation = "observe";
  let reason = "";
  if (failStreak >= th.failStreak) {
    reason = `连续 ${failStreak} 次失败`;
  } else if (metrics.verifyFailures > 0) {
    reason = `最近 ${th.sampleSize} 次有 ${metrics.verifyFailures} 次效果验证未通过`;
  } else if (metrics.maxTakeovers >= th.maxTakeovers) {
    reason = `单次接管达 ${metrics.maxTakeovers} 次，确定性已退化`;
  } else if (metrics.maxAnchorFallbacks > 0) {
    reason = `锚定三道防线失守 ${metrics.maxAnchorFallbacks} 次`;
  } else if (metrics.maxDurationMs > th.maxDurationMs) {
    reason = `单次耗时 ${Math.round(metrics.maxDurationMs / 1000)}s 超预算`;
  } else {
    const tail = all.slice(0, th.sampleSize);
    const clean = tail.length >= th.sampleSize && tail.every((r) => r.status === "ok");
    if (clean) {
      /* 人工回放也算样本，否则 observe「只记录不执行」就永远攒不够数据、永远升不了 auto。
         语义是：用户手动验证得够干净，系统才有资格替他自动点火。 */
      recommendation = "auto";
      reason = `连续 ${th.sampleSize} 次零退化成功（其中自动点火 ${metrics.autoFires} 次）`;
    } else if (recent.length < th.sampleSize) {
      reason = `样本不足（${recent.length}/${th.sampleSize}）`;
    } else {
      reason = "最近窗口内仍有失败";
    }
  }

  return { recommendation, reason, metrics, failStreak,
    thresholds: { ...th }, degraded: recommendation === "observe" && failStreak > 0 };
}

/**
 * 该不该改触发器的 mode。返回 { change, mode, reason } 或 { change:false }。
 * modeLocked：人手动设过的不再被自动改（Bainbridge：别让系统替人收回决定权）。
 */
export function decideTransition(trigger, evaluation, currentMode) {
  const t = trigger || {};
  if (t.modeLocked) return { change: false, reason: "人工锁定" };
  const cur = MODES.includes(currentMode) ? currentMode : "observe";
  const want = evaluation.recommendation;
  if (want === cur) return { change: false, reason: evaluation.reason };
  /* 升级比降级保守：只有在没有失败、没有退化、样本够时才自动升。 */
  if (want === "auto" && evaluation.failStreak > 0) {
    return { change: false, reason: "尚有失败记录，不自动升级" };
  }
  return { change: true, mode: want, reason: evaluation.reason };
}
