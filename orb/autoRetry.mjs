/* ---------------- 失败分类与有限重试（autoRetry） ----------------
 *
 * 云端引擎可以无条件重试；桌面 GUI 不行 —— 点「提交」已经发生了，重跑就是再提交一次。
 * 所以这里只有三条放行条件，缺一不重试：
 *   ① 错误码属于「界面漂移」一族（STALE_REF / AMBIGUOUS_TARGET / WINDOW_GONE / UNKNOWN）
 *   ② 该动作可逆（只读，或登记在 revocable 集合里）
 *   ③ 未达次数上限
 *
 * PERM_DENIED / 急停拒绝一律不重试（沿用 runNode 既有红线）。
 * 不可逆动作一律不重试，无论错误码是什么。
 *
 * 纯函数模块：不碰 IO，不做 sleep，退避时长只算不执行，由调用方决定是否等待。
 */

import { ACTION_ERROR_CODES, classifyActionError } from "./anchorResolver.mjs";

export const RISK = Object.freeze({
  READONLY: "readonly",
  REVERSIBLE: "reversible",
  IRREVERSIBLE: "irreversible",
});

export const DEFAULT_RETRY = Object.freeze({
  maxAttempts: 2,   // 含首次执行
  baseMs: 300,
  maxMs: 2000,
  floorMs: 50,      // 抖动的下限，见 backoffMs 里那段说明
  jitter: "full",   // full = AWS Full Jitter；none = 纯指数（要可复算的场合才用）
});

const RETRYABLE_CODES = Object.freeze(new Set([
  ACTION_ERROR_CODES.STALE_REF,
  ACTION_ERROR_CODES.AMBIGUOUS_TARGET,
  ACTION_ERROR_CODES.WINDOW_GONE,
  ACTION_ERROR_CODES.UNKNOWN,
]));

/** 动作风险等级。调用方从 capabilityRegistry 注入 readOnly / revocable。 */
export function riskOf(input = {}) {
  if (input.readOnly === true) return RISK.READONLY;
  if (input.revocable === true) return RISK.REVERSIBLE;
  return RISK.IRREVERSIBLE;
}

/** 给定错误文本与动作风险，判断能不能重试。 */
export function classifyRetryability(input = {}) {
  const code = String(input.code || classifyActionError(String(input.errorText || ""), {
    hadRef: input.hadRef === true,
  }));
  const risk = input.risk || RISK.IRREVERSIBLE;

  if (code === ACTION_ERROR_CODES.PERM_DENIED) {
    return { retryable: false, code, risk, reason: "权限/急停拒绝，不重试" };
  }
  if (code === ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED
    || code === ACTION_ERROR_CODES.SNAPSHOT_MISMATCH
    || code === ACTION_ERROR_CODES.TOOL_VERSION_MISMATCH) {
    return { retryable: false, code, risk, reason: "平台/版本绑定类失败，重试无意义" };
  }
  if (risk === RISK.IRREVERSIBLE) {
    return { retryable: false, code, risk, reason: "不可逆动作，宁可不做" };
  }
  if (!RETRYABLE_CODES.has(code)) {
    return { retryable: false, code, risk, reason: `错误码 ${code} 不在可重试集合` };
  }
  return { retryable: true, code, risk, reason: `可重试（${risk} / ${code}）` };
}

/**
 * 指数退避 + Full Jitter。attempt 从 0 起（第一次失败后调用传 0）。
 *
 * 为什么加抖动：纯指数退避的间隔是**确定**的，界面还没重绘完 / 目标进程还没起来时，
 * 每次都在同一个时刻再撞一次同一堵墙，退避就白退了。AWS 那篇讲退避的文章实测结论是
 * 「不抖动」在几种策略里最差（the clear loser），推荐 sleep = random(0, min(cap, base*2^n))。
 *
 * 两处刻意的偏离，都在这里写清楚：
 *   ① 加了 floorMs 地板。AWS 的 Full Jitter 允许退到 0 —— 云端请求 0 延迟重试无所谓，
 *      桌面动作 0 延迟等于"立刻再点一次"，那正好是重试要避免的。所以下限给 50ms。
 *   ② jitter:"none" 保留纯指数。需要可复算的场合（日志核对、测试断言）用它，
 *      默认是 full —— 不留这个口子的话，测试只能断言区间，出问题时连"到底等了多久"都查不了。
 *
 * opts.rnd 可注入，测试用。
 */
export function backoffMs(attempt, policy = {}, opts = {}) {
  const p = { ...DEFAULT_RETRY, ...(policy || {}) };
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const cap = Math.min(p.maxMs, p.baseMs * Math.pow(2, n));
  if (String(p.jitter || "full") === "none") return cap;
  const floor = Math.min(Number(p.floorMs) > 0 ? Number(p.floorMs) : 0, cap);
  const rnd = typeof opts.rnd === "function" ? opts.rnd : Math.random;
  const raw = Number(rnd());
  const r = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;   // 注入坏了就退成封顶值
  return Math.max(floor, Math.round(r * cap));
}

/**
 * 综合决策。
 * attempt 已经执行过几次（首次执行后为 1）。
 */
export function shouldRetry(input = {}) {
  const p = { ...DEFAULT_RETRY, ...(input.policy || {}) };
  const cls = classifyRetryability(input);
  if (!cls.retryable) return { retry: false, ...cls };
  const done = Math.max(0, Number(input.attempt) || 0);
  if (done >= p.maxAttempts) {
    return { retry: false, ...cls, reason: `已达上限 ${p.maxAttempts} 次` };
  }
  return { retry: true, delayMs: backoffMs(done - 1, p, { rnd: input.rnd }), ...cls };
}

/**
 * 动作级幂等键。
 * 刻意不用「时间」和「随机数」—— 同一次运行的同一步必须稳定复算出同一个键，
 * 否则 receipts 的 byKey 永远命不中，幂等就是摆设。
 * 用 runId + 步号 + 动作 + 参数指纹，重放同一条配方不会误命中别的步。
 */
export function stepIdemKey(input = {}) {
  const runId = String(input.runId || "");
  const stepNo = String(input.stepNo ?? "");
  const server = String(input.server || "");
  const tool = String(input.tool || "");
  return `${runId}|${stepNo}|${server}|${tool}|${argsFingerprint(input.args)}`;
}

/** FNV-1a 32 位，稳定、无依赖。只用于去重指纹，不用于安全用途。 */
export function argsFingerprint(args) {
  let s;
  try {
    s = stableStringify(args);
  } catch {
    s = String(args);
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 键序稳定的序列化：{a:1,b:2} 与 {b:2,a:1} 必须得到同一指纹。 */
function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? String(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

export default {
  RISK,
  DEFAULT_RETRY,
  riskOf,
  classifyRetryability,
  backoffMs,
  shouldRetry,
  stepIdemKey,
  argsFingerprint,
};
