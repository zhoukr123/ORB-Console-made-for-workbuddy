/* refBinding.mjs 单测：11-07 增量简报 §1「ref 版本绑定」的契约。
 * 核心是四元组 (平台, 快照 id, ref, 工具版本) 缺一不可，
 * 以及「平台不支持 / 快照过期 / 版本漂移」三类失败不能再糊成 STALE_REF。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ELEMENT_REF_SCHEMA_VERSION, AGENT_DESKTOP_VERSION, REF_BINDING_ERRORS, AGENT_DESKTOP_LIMITS,
  bindRefVersion, validateRefBinding, refBindingExtra, capabilityManifestEntry,
  classifyAgentDesktopError,
} from "../refBinding.mjs";
import {
  ACTION_ERROR_CODES, classifyActionError, normalizeElementRef,
  normalizeElementRefWithBinding, checkRefBinding,
} from "../anchorResolver.mjs";

const GOOD_CTX = { platform: "windows", snapshotId: "snap-42", toolVersion: "1.2.0" };

test("版本常量与四元组 schema 版本", () => {
  assert.equal(ELEMENT_REF_SCHEMA_VERSION, 2);
  assert.equal(AGENT_DESKTOP_VERSION.verified, "1.1.0");
  assert.equal(AGENT_DESKTOP_VERSION.current, "1.2.0");
  assert.equal(AGENT_DESKTOP_VERSION.cAbiMajor, 7);
  assert.equal(AGENT_DESKTOP_VERSION.protocol, "json-envelope-2.6");
  assert.equal(AGENT_DESKTOP_LIMITS.length, 7, "auxfirst 七条限制必须全部登记");
  assert.ok(Object.isFrozen(REF_BINDING_ERRORS));
});

test("bindRefVersion：四元组齐全，缺字段留 null 不补零", () => {
  const b = bindRefVersion("win>确定", GOOD_CTX);
  assert.deepEqual(b, {
    platform: "windows", snapshotId: "snap-42", ref: "win>确定",
    toolVersion: "1.2.0", schemaVersion: 2,
  });
  const partial = bindRefVersion("r", { platform: "windows" });
  assert.equal(partial.snapshotId, null);
  assert.equal(partial.toolVersion, null);
  assert.equal(partial.schemaVersion, 2);
});

test("validateRefBinding：完整一致才放行", () => {
  const b = bindRefVersion("r", GOOD_CTX);
  assert.deepEqual(validateRefBinding(b, GOOD_CTX), { ok: true, code: "ok", reason: "四元组一致，ref 仍有效" });
});

test("validateRefBinding：五类失败各自有独立错误码", () => {
  const b = bindRefVersion("r", GOOD_CTX);
  assert.equal(validateRefBinding({}, GOOD_CTX).code, REF_BINDING_ERRORS.STALE_REF);
  assert.equal(validateRefBinding(bindRefVersion("r", { snapshotId: "s", toolVersion: "1" }), GOOD_CTX).code,
    REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED);
  assert.equal(validateRefBinding(b, { ...GOOD_CTX, platform: "linux" }).code,
    REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED);
  assert.equal(validateRefBinding(b, { ...GOOD_CTX, snapshotSurface: false }).code,
    REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED);
  assert.equal(validateRefBinding(b, { ...GOOD_CTX, snapshotId: "snap-43" }).code,
    REF_BINDING_ERRORS.SNAPSHOT_MISMATCH);
  assert.equal(validateRefBinding(b, { ...GOOD_CTX, toolVersion: "1.1.0" }).code,
    REF_BINDING_ERRORS.TOOL_VERSION_MISMATCH);
  assert.equal(validateRefBinding(b, { ...GOOD_CTX, ambiguous: true }).code,
    REF_BINDING_ERRORS.AMBIGUOUS_TARGET);
});

test("validateRefBinding：requireToolVersion=false 只放宽版本，其它仍严查", () => {
  const b = bindRefVersion("r", { platform: "windows", snapshotId: "s" });
  assert.equal(validateRefBinding(b, { platform: "windows", snapshotId: "s" }, { requireToolVersion: false }).ok, true);
  assert.equal(validateRefBinding(b, { platform: "windows", snapshotId: "t" }, { requireToolVersion: false }).code,
    REF_BINDING_ERRORS.SNAPSHOT_MISMATCH);
});

test("classifyAgentDesktopError：三类新错误能从文本识别，普通文本不误判", () => {
  assert.equal(classifyAgentDesktopError("PLATFORM_NOT_SUPPORTED"), REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED);
  assert.equal(classifyAgentDesktopError("无快照表面，无法取树"), REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED);
  assert.equal(classifyAgentDesktopError("SNAPSHOT_MISMATCH"), REF_BINDING_ERRORS.SNAPSHOT_MISMATCH);
  assert.equal(classifyAgentDesktopError("工具版本漂移"), REF_BINDING_ERRORS.TOOL_VERSION_MISMATCH);
  assert.equal(classifyAgentDesktopError("stale ref"), null);
  assert.equal(classifyAgentDesktopError(""), null);
});

test("anchorResolver：新错误码接入且不破坏旧分类", () => {
  assert.equal(ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED, "PLATFORM_NOT_SUPPORTED");
  assert.equal(ACTION_ERROR_CODES.SNAPSHOT_MISMATCH, "SNAPSHOT_MISMATCH");
  assert.equal(ACTION_ERROR_CODES.TOOL_VERSION_MISMATCH, "TOOL_VERSION_MISMATCH");
  assert.equal(classifyActionError("PLATFORM_NOT_SUPPORTED"), ACTION_ERROR_CODES.PLATFORM_NOT_SUPPORTED);
  /* 旧用例回归：权限 / 窗口 / 多匹配 / stale 仍按原口径 */
  assert.equal(classifyActionError("Access is denied (EACCES)"), ACTION_ERROR_CODES.PERM_DENIED);
  assert.equal(classifyActionError("multiple controls match 确定"), ACTION_ERROR_CODES.AMBIGUOUS_TARGET);
  assert.equal(classifyActionError("element not found: stale ref"), ACTION_ERROR_CODES.STALE_REF);
  assert.equal(classifyActionError("窗口 未找到，无法点击"), ACTION_ERROR_CODES.WINDOW_GONE);
  assert.equal(classifyActionError("some weird failure"), ACTION_ERROR_CODES.UNKNOWN);
  assert.equal(classifyActionError("click failed", { hadRef: true }), ACTION_ERROR_CODES.STALE_REF);
});

test("normalizeElementRefWithBinding：附加四元组，旧 normalize 形状不变", () => {
  const hit = { x: 10, y: 20, ref: "win>确定", score: 0.9 };
  const plain = normalizeElementRef(hit, "tree");
  assert.deepEqual(Object.keys(plain).sort(), ["backend", "ref", "score", "x", "y"]);

  const bound = normalizeElementRefWithBinding(hit, "tree", GOOD_CTX);
  assert.equal(bound.refSchemaVersion, 2);
  assert.deepEqual(bound.refBinding, bindRefVersion("win>确定", GOOD_CTX));
  assert.equal(checkRefBinding(bound, GOOD_CTX).ok, true);
  assert.equal(checkRefBinding(bound, { ...GOOD_CTX, snapshotId: "snap-99" }).code,
    REF_BINDING_ERRORS.SNAPSHOT_MISMATCH);
  assert.equal(normalizeElementRefWithBinding({ ref: "r" }, "tree", GOOD_CTX), null, "坐标非法仍返回 null");
});

test("capabilityManifestEntry：工具版本写进 manifest，冻结不可篡改", () => {
  const e = capabilityManifestEntry("windows", "Snapshot", "1.2.0", { platform: "windows" });
  assert.deepEqual(JSON.parse(JSON.stringify(e)), {
    server: "windows", tool: "Snapshot", toolVersion: "1.2.0",
    platform: "windows", schemaVersion: 2,
  });
  assert.ok(Object.isFrozen(e));
});
