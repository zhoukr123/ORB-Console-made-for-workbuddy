/* pluginArtifactGate.mjs — ORB 生成物「纯逻辑验收闸门」
 *
 * 背景：11-07 增量简报 §3.3 DeepSeek Harness「Creator Mode」三段式提示词纪律
 *   —— 做什么(what) / 入口在哪(entry) / 如何验收(how) —— 以及简报对 ORB 的
 *   警告：「模型自由造工具」是高风险入口，生成物不得直接注册进 /api/call。
 *
 * 本模块是「纯逻辑闸门」：不引入、不引用、不依赖任何 ORB 模块或运行时，仅用语言
 *   内置能力做同步校验、声明式验收编排与静态源码检查。它不改动 pluginHost.mjs、
 *   bridge.mjs、pack.cjs 等任何现有文件，也不做任何接线；接线由主 agent 统一做。
 *
 * 关键纪律：
 *   - restart-required 仅代表「配置已保存、尚未激活」，一律不算成功；必须重启同
 *     profile 后经 reverify() 复验通过，才允许签发 receipt。
 *   - 失败必须回到安装结果、运行时状态与错误日志排查，绝不视为安装成功。
 *   - api_call_register 是硬红线：一律拒，即便带了 ctx.approvedBy。
 *   - receipt 仅在 spec.how 全部实跑（runner 注入）通过后才签发。
 *
 * 错误码归属（便于单测锁定）：
 *   bad-artifact           对象 / id 不合法
 *   bad-origin             origin.kind 非法
 *   missing-origin-hash    generated / imported 缺 origin.sourceHash
 *   missing-acceptance     三段验收整体缺失（无 spec 或三段全无）
 *   incomplete-acceptance  三段验收不完整（what / how 缺失或畸变）
 *   bad-entry              entry 段缺失或畸变（「入口在哪」是独立硬要求）
 *   dangerous-capability   危险能力未批准，或命中 api_call_register 硬红线
 *   epoch-required         generated 缺 epoch / 与当前世代不一致
 *   acceptance-failed      实跑验收有假值 / 抛错 / 未注入 runner
 *   restart-required       待重启，不算成功
 *   restart-not-reverified 未重启或非同 profile 却想复验
 *   not-allowlisted        id 不在 ctx.allowlist
 *
 * 所有对外返回的对象 / 数组均为新建副本，不泄漏内部可变引用。
 */

export const ARTIFACT_ORIGINS = Object.freeze({
  BUILTIN: "builtin",
  GENERATED: "generated",
  IMPORTED: "imported",
});

export const ACCEPTANCE_SECTIONS = Object.freeze(["what", "entry", "how"]);

export const GATE_CODES = Object.freeze({
  BAD_ARTIFACT: "bad-artifact",
  BAD_ORIGIN: "bad-origin",
  MISSING_ORIGIN_HASH: "missing-origin-hash",
  MISSING_ACCEPTANCE: "missing-acceptance",
  INCOMPLETE_ACCEPTANCE: "incomplete-acceptance",
  BAD_ENTRY: "bad-entry",
  DANGEROUS_CAPABILITY: "dangerous-capability",
  EPOCH_REQUIRED: "epoch-required",
  ACCEPTANCE_FAILED: "acceptance-failed",
  RESTART_REQUIRED: "restart-required",
  RESTART_NOT_REVERIFIED: "restart-not-reverified",
  NOT_ALLOWLISTED: "not-allowlisted",
});

const DANGEROUS_CAPABILITIES = Object.freeze([
  "network",
  "filesystem_write",
  "shell",
  "api_call_register",
]);
const HARD_REDLINE = "api_call_register";
const NEEDS_HASH = Object.freeze([
  ARTIFACT_ORIGINS.GENERATED,
  ARTIFACT_ORIGINS.IMPORTED,
]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function isHowCase(c) {
  return (
    isPlainObject(c) &&
    isNonEmptyString(c.name) &&
    Object.prototype.hasOwnProperty.call(c, "expect")
  );
}

function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (v instanceof Set) return Array.from(v);
  if (typeof v === "string") return [v]; // 字符串形态也不得绕过能力检查
  return [];
}

export function createArtifactGate(opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const runner = typeof options.runner === "function" ? options.runner : null;
  const epochProvider =
    typeof options.epochProvider === "function" ? options.epochProvider : null;

  // 单调递增计数器，仅通过 stats() 以快照形式对外暴露。
  const state = { validated: 0, accepted: 0, failed: 0, restartPending: 0 };

  function failure(checks, reasons, code, needsRestart = false) {
    state.failed += 1;
    if (code === GATE_CODES.RESTART_REQUIRED) state.restartPending += 1;
    return {
      ok: false,
      code,
      checks: { ...checks },
      needsRestart,
      reasons: reasons.slice(),
    };
  }

  function validate(artifact = {}, ctx = {}) {
    state.validated += 1;
    const c = ctx && typeof ctx === "object" ? ctx : {};
    const reasons = [];
    const checks = {
      what: false,
      entry: false,
      how: false,
      origin: false,
      capabilities: false,
      epoch: false,
    };

    const obj = isPlainObject(artifact) ? artifact : null;
    const id = obj ? obj.id : undefined;
    const spec = obj ? obj.spec : undefined;
    const specOk = isPlainObject(spec);
    const origin = obj ? obj.origin : undefined;
    const originObj = isPlainObject(origin) ? origin : null;
    const originKind =
      typeof origin === "string" ? origin : originObj ? origin.kind : undefined;

    // 三段验收：做什么 / 入口在哪 / 如何验收（每项含 name + expect）
    checks.what = specOk && isNonEmptyString(spec.what);
    checks.entry = specOk && isNonEmptyString(spec.entry);
    checks.how =
      specOk &&
      Array.isArray(spec.how) &&
      spec.how.length > 0 &&
      spec.how.every(isHowCase);

    // 来源
    const kindOk =
      isNonEmptyString(originKind) &&
      Object.values(ARTIFACT_ORIGINS).includes(originKind);
    checks.origin = kindOk;

    const needsHash = NEEDS_HASH.includes(originKind);
    const hasHash = Boolean(originObj && isNonEmptyString(originObj.sourceHash));

    // 世代：仅 generated 强制；注入 epochProvider 时须与当前世代一致
    const epoch = obj ? obj.epoch : undefined;
    const hasEpoch = typeof epoch === "number" && Number.isFinite(epoch);
    let epochOk = true;
    if (originKind === ARTIFACT_ORIGINS.GENERATED) {
      epochOk = hasEpoch;
      if (epochOk && epochProvider && epochProvider() !== epoch) epochOk = false;
    }
    checks.epoch = epochOk;

    // 能力：声明式审批 + 硬红线
    const caps = toArray(obj ? obj.capabilities : undefined);
    const hasRedline = caps.includes(HARD_REDLINE);
    const hasDangerous = caps.some((x) => DANGEROUS_CAPABILITIES.includes(x));
    const approved = Boolean(c.approvedBy);
    const capsOk = !hasRedline && (!hasDangerous || approved);
    checks.capabilities = capsOk;

    // 白名单
    const allowlist = c.allowlist;
    let allowlisted = true;
    if (allowlist instanceof Set) allowlisted = allowlist.has(id);
    else if (Array.isArray(allowlist)) allowlisted = allowlist.includes(id);

    const restart = obj ? obj.restartRequired === true : false;
    const sectionCount = [checks.what, checks.entry, checks.how].filter(Boolean)
      .length;
    const acceptanceFull = sectionCount === ACCEPTANCE_SECTIONS.length;
    const acceptanceGone = !specOk || sectionCount === 0;

    // 判定：前者优先；checks 已完整反映各项真实结果。
    if (!obj || !isNonEmptyString(id)) {
      reasons.push("artifact 必须是对象且含非空字符串 id");
      return failure(checks, reasons, GATE_CODES.BAD_ARTIFACT);
    }
    if (!kindOk) {
      reasons.push("origin.kind 必须是 builtin / generated / imported 之一");
      return failure(checks, reasons, GATE_CODES.BAD_ORIGIN);
    }
    if (needsHash && !hasHash) {
      reasons.push("generated / imported 必须带非空 origin.sourceHash");
      return failure(checks, reasons, GATE_CODES.MISSING_ORIGIN_HASH);
    }
    if (acceptanceGone) {
      reasons.push("三段验收（what / entry / how）整体缺失");
      return failure(checks, reasons, GATE_CODES.MISSING_ACCEPTANCE);
    }
    if (!checks.entry) {
      reasons.push("entry 段缺失或畸变：入口在哪未声明");
      return failure(checks, reasons, GATE_CODES.BAD_ENTRY);
    }
    if (!acceptanceFull) {
      reasons.push("三段验收不完整：what / how 缺失或畸变");
      return failure(checks, reasons, GATE_CODES.INCOMPLETE_ACCEPTANCE);
    }
    if (!capsOk) {
      reasons.push(
        hasRedline
          ? "硬红线：生成物不得携带 api_call_register（不得直接注册进 /api/call）"
          : "危险能力需显式 ctx.approvedBy 审批后才放行",
      );
      return failure(checks, reasons, GATE_CODES.DANGEROUS_CAPABILITY);
    }
    if (!epochOk) {
      reasons.push("generated 必须带与当前世代一致的 epoch");
      return failure(checks, reasons, GATE_CODES.EPOCH_REQUIRED);
    }
    if (!allowlisted) {
      reasons.push("artifact.id 不在 ctx.allowlist 内");
      return failure(checks, reasons, GATE_CODES.NOT_ALLOWLISTED);
    }
    if (restart) {
      reasons.push("配置已保存未激活：需重启同 profile 后 reverify 复验");
      return failure(checks, reasons, GATE_CODES.RESTART_REQUIRED, true);
    }

    return {
      ok: true,
      checks: { ...checks },
      needsRestart: false,
      reasons: [],
    };
  }

  async function accept(artifact, ctx = {}) {
    const v = validate(artifact, ctx);
    if (!v.ok) return v; // 透传校验失败，不实跑、不签发 receipt

    const cases = artifact.spec.how;
    const failed = [];
    if (runner) {
      for (const item of cases) {
        const name = item.name;
        try {
          const passed = await runner({ name, expect: item.expect, artifact });
          if (!passed) failed.push(name);
        } catch (_err) {
          failed.push(name);
        }
      }
    } else {
      // 未注入 runner：无法实跑，绝不视为验收通过、绝不签发 receipt
      for (const item of cases) failed.push(item.name);
    }

    if (failed.length > 0) {
      state.failed += 1;
      return {
        ok: false,
        code: GATE_CODES.ACCEPTANCE_FAILED,
        failed: failed.slice(),
        reasons: runner
          ? ["声明式验收未全部通过"]
          : ["未注入 runner，无法实跑验收用例"],
      };
    }

    state.accepted += 1;
    const origin = artifact.origin;
    const originSnapshot = isPlainObject(origin)
      ? { ...origin }
      : typeof origin === "string"
        ? origin
        : null;
    const receipt = {
      id: artifact.id,
      origin: originSnapshot,
      epoch: typeof artifact.epoch === "number" ? artifact.epoch : null,
      acceptedAt: now(),
      checksCount: cases.length,
      verified: true,
    };
    return { ok: true, receipt };
  }

  async function reverify(artifact, ctx = {}) {
    const c = ctx && typeof ctx === "object" ? ctx : {};
    if (c.restarted !== true || c.profileSame !== true) {
      state.failed += 1;
      return {
        ok: false,
        code: GATE_CODES.RESTART_NOT_REVERIFIED,
        reasons: ["必须重启且保持同一 profile 后才能复验"],
      };
    }
    const result = await accept(artifact, c);
    if (!result.ok) return result;
    return { ok: true, reverified: true, receipt: result.receipt };
  }

  function assertNoApiCallRegistration(bridgeSource) {
    const src = typeof bridgeSource === "string" ? bridgeSource : "";
    const bad = [];
    const callRe = /\/api\/call/gi;
    const regRe = /(?:plugin|callTool|register)/i;
    let m;
    while ((m = callRe.exec(src)) !== null) {
      const start = Math.max(0, m.index - 160);
      const end = Math.min(src.length, m.index + m[0].length + 160);
      const window = src.slice(start, end);
      if (regRe.test(window)) {
        bad.push(window.replace(/\s+/g, " ").trim().slice(0, 240));
      }
    }
    return { ok: bad.length === 0, bad };
  }

  function stats() {
    return { ...state };
  }

  return {
    validate,
    accept,
    reverify,
    assertNoApiCallRegistration,
    stats,
  };
}
