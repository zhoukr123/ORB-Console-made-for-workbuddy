/* ref 版本绑定（11-07 增量简报 §1）：agent-desktop v1.1.0 已证实、当前 v1.2.0。
 *
 * 破坏性变更后 ref 语义按平台与版本分化，因此封装层必须把
 * (平台, 快照 id, ref, 工具版本) 作为一个整体存，而不是只存一个 sig 字符串。
 * 否则 Windows/Linux 旧快照 ref 与同名多控件会被误当成有效身份。
 *
 * 与 anchorResolver.mjs 的关系：那边负责「怎么找到元素」，这里负责「这个身份
 * 现在还算不算数」。纯逻辑、零 import，所有外部信息靠参数传入。
 */

export const ELEMENT_REF_SCHEMA_VERSION = 2;

/** 桌面能力声明的默认工具版本（agent-desktop changelog 口径，可被调用方覆盖）。 */
export const AGENT_DESKTOP_VERSION = Object.freeze({
  verified: "1.1.0",
  releasedAt: "2026-11-03",
  current: "1.2.0",
  currentReleasedAt: "2026-11-05",
  protocol: "json-envelope-2.6",
  cAbiMajor: 7,
});

export const REF_BINDING_ERRORS = Object.freeze({
  PLATFORM_NOT_SUPPORTED: "PLATFORM_NOT_SUPPORTED",   // 无快照表面 / 平台不支持
  SNAPSHOT_MISMATCH: "SNAPSHOT_MISMATCH",             // 快照 id 变了，ref 必须重取
  TOOL_VERSION_MISMATCH: "TOOL_VERSION_MISMATCH",     // 工具/CLI 版本漂移
  AMBIGUOUS_TARGET: "AMBIGUOUS_TARGET",               // 同名多控件，定位不唯一
  STALE_REF: "STALE_REF",                             // ref 本身失效
});

/** auxfirst 评测列出的七条限制，作为验收清单；不在这里"修好"，只确保不被忘掉。 */
export const AGENT_DESKTOP_LIMITS = Object.freeze([
  "所有动作同一个温度：不要按动作类型臆测可靠性差异",
  "没有审批面，只有确认提示：找到元素 ≠ 有权操作元素，两层必须拆开",
  "cursor 是标签不是身份：不可当作稳定引用",
  "trace 是日志不是收据：不能拿日志当验收凭证",
  "屏幕文本是注入向量：一律过 textGate，不进记忆、不提权",
  "监督吞吐未经验证：不得据此设 SLO",
  "默认不抢鼠标，真动键鼠需显式 headed；4 个 hold 类命令无守护进程时拒绝执行",
]);

const str = (v, cap = 512) => String(v ?? "").trim().slice(0, cap);

/** 由调用现场构造四元组绑定。缺字段不补零、不猜，原样留空由 validate 判定。 */
export function bindRefVersion(ref, ctx = {}) {
  return {
    platform: str(ctx.platform) || null,
    snapshotId: str(ctx.snapshotId) || null,
    ref: str(ref) || null,
    toolVersion: str(ctx.toolVersion) || null,
    schemaVersion: ELEMENT_REF_SCHEMA_VERSION,
  };
}

/** 校验一个绑定在「当前现场」是否仍然成立。返回固定错误码，不抛异常。 */
export function validateRefBinding(binding = {}, current = {}, opts = {}) {
  const b = binding || {};
  const c = current || {};
  const needVersion = opts.requireToolVersion !== false;

  if (!b.ref) return { ok: false, code: REF_BINDING_ERRORS.STALE_REF, reason: "绑定里没有 ref" };
  if (!b.platform) return { ok: false, code: REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED, reason: "绑定里没有平台标识" };
  if (c.platform && String(c.platform) !== String(b.platform)) {
    return { ok: false, code: REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED, reason: "平台与绑定时不同" };
  }
  if (c.platformUnsupported === true || c.snapshotSurface === false) {
    return { ok: false, code: REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED, reason: "当前平台无快照表面" };
  }
  if (!b.snapshotId || (c.snapshotId && String(c.snapshotId) !== String(b.snapshotId))) {
    return { ok: false, code: REF_BINDING_ERRORS.SNAPSHOT_MISMATCH, reason: "快照 id 缺失或已变化，ref 必须重取" };
  }
  if (needVersion && (!b.toolVersion || (c.toolVersion && String(c.toolVersion) !== String(b.toolVersion)))) {
    return { ok: false, code: REF_BINDING_ERRORS.TOOL_VERSION_MISMATCH, reason: "工具版本缺失或已漂移" };
  }
  if (c.ambiguous === true) {
    return { ok: false, code: REF_BINDING_ERRORS.AMBIGUOUS_TARGET, reason: "同名多控件，定位不唯一" };
  }
  return { ok: true, code: "ok", reason: "四元组一致，ref 仍有效" };
}

/** 生成可直接传给 normalizeElementRef(hit, backend, extra) 的附加字段。 */
export function refBindingExtra(ref, ctx = {}) {
  return { refBinding: bindRefVersion(ref, ctx), refSchemaVersion: ELEMENT_REF_SCHEMA_VERSION };
}

/** capability manifest 里的一条工具声明：把工具版本显式带上，供版本漂移校验。 */
export function capabilityManifestEntry(server, tool, toolVersion, extra = {}) {
  const e = {
    server: str(server), tool: str(tool),
    toolVersion: str(toolVersion) || null,
    platform: str(extra.platform) || null,
    schemaVersion: ELEMENT_REF_SCHEMA_VERSION,
  };
  return Object.freeze(e);
}

/** 把 agent-desktop 的「无快照表面」等文本归到新错误码；供 classifyActionError 复用。 */
export function classifyAgentDesktopError(text) {
  const s = String(text ?? "");
  if (!s) return null;
  if (/PLATFORM_NOT_SUPPORTED|platform[ _-]?not[ _-]?supported|无快照表面|不支持该平台|no snapshot surface/i.test(s))
    return REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED;
  if (/SNAPSHOT_MISMATCH|snapshot[ _-]?id[ _-]?mismatch|快照.{0,4}(不一致|已变化)/i.test(s))
    return REF_BINDING_ERRORS.SNAPSHOT_MISMATCH;
  if (/TOOL_VERSION_MISMATCH|tool[ _-]?version[ _-]?mismatch|工具版本漂移/i.test(s))
    return REF_BINDING_ERRORS.TOOL_VERSION_MISMATCH;
  return null;
}

export default {
  ELEMENT_REF_SCHEMA_VERSION, AGENT_DESKTOP_VERSION, REF_BINDING_ERRORS, AGENT_DESKTOP_LIMITS,
  bindRefVersion, validateRefBinding, refBindingExtra, capabilityManifestEntry, classifyAgentDesktopError,
};
