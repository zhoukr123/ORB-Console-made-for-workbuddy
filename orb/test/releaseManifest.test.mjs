/* S6 安装清单单测：分列判定 + 组件分组 + 体积评估 + 防篡改/版本漂移 + 生成器/校验器往返。
 * 验收 #3 的核心：把「已签名但过期」与「未签名但内部调试」分别判定，互不污染。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  MANIFEST_SCHEMA_VERSION, ZIP_TARGET_BYTES, COMPONENT_GROUPS,
  componentGroupOf, summarizeComponents, evaluateSize,
  classifySignature, classifySource, classifyFreshness, assessTrust,
} from "../releaseManifest.mjs";
import { buildManifest, scanFiles } from "../tools/make-manifest.mjs";
import { verifyManifest } from "../tools/verify-manifest.mjs";

/* ---------- 组件分组 ---------- */
test("componentGroupOf：五个攻击面 + Python 运行时 + 其它都能正确归类", () => {
  assert.equal(componentGroupOf("ORB 控制台.exe"), "main-process");
  assert.equal(componentGroupOf("resources/desktop/main.js"), "main-process");
  assert.equal(componentGroupOf("resources/app/bridge.mjs"), "renderer-bridge");
  assert.equal(componentGroupOf("resources/app/panel.html"), "renderer-bridge");
  assert.equal(componentGroupOf("resources/app/browser-extension/background.js"), "browser-exec");
  assert.equal(componentGroupOf("resources/node_modules/@huggingface/transformers/x.js"), "model-deps");
  assert.equal(componentGroupOf("resources/app/visualAnchor.mjs"), "optional-vision");
  assert.equal(componentGroupOf("resources/runtime/python/python.exe"), "python-runtime");
  assert.equal(componentGroupOf("locales/zh-CN.pak"), "main-process");
  assert.equal(componentGroupOf("使用说明.md"), "other");
});

test("COMPONENT_GROUPS 七个分组、id 唯一", () => {
  assert.equal(COMPONENT_GROUPS.length, 7);
  assert.equal(new Set(COMPONENT_GROUPS.map((g) => g.id)).size, 7);
});

test("summarizeComponents：按 path 重新判组并累计文件数与字节", () => {
  const rows = summarizeComponents([
    { path: "main.js", size: 10 },
    { path: "resources/app/bridge.mjs", size: 20 },
    { path: "resources/runtime/python/python.exe", size: 70 },
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId["renderer-bridge"].bytes, 20);
  assert.equal(byId["python-runtime"].bytes, 70);
  assert.equal(byId["renderer-bridge"].files, 1);
});

/* ---------- 体积评估 ---------- */
test("evaluateSize：如实报 current/外置后估算/是否达标；zipBytes 缺失不补零", () => {
  const groups = [
    { id: "main-process", bytes: 50 }, { id: "python-runtime", bytes: 50 }, { id: "other", bytes: 0 },
  ];
  const r = evaluateSize(groups, { zipBytes: 100 });
  assert.equal(r.pythonRuntimeRatio, 0.5);
  assert.equal(r.projectedWithoutPython, 50);
  assert.equal(r.meetsTargetAfterExternalizingPython, true);
  assert.ok(/Python/.test(r.recommendation));
  const noZip = evaluateSize(groups, { zipBytes: null });
  assert.equal(noZip.zipBytes, null);
  assert.equal(noZip.projectedWithoutPython, null);
  assert.equal(noZip.overTarget, null);
});

test("evaluateSize：超 200MB 目标时 overTarget=true", () => {
  const r = evaluateSize([{ id: "other", bytes: 1 }], { zipBytes: ZIP_TARGET_BYTES + 1 });
  assert.equal(r.overTarget, true);
});

/* ---------- 签名列 ---------- */
test("classifySignature：已签名且证书有效 → signed-valid", () => {
  const now = 1_000_000;
  const r = classifySignature({ status: "signed", certChain: [{ notBefore: 0, notAfter: now + 1000 }], timestamp: now - 10 }, { now });
  assert.equal(r.status, "signed-valid");
});

test("classifySignature 验收#3：已签名但过期（有时间戳）→ signed-expired，不是篡改、不是 stale", () => {
  const now = 1_000_000;
  const r = classifySignature({
    status: "signed",
    certChain: [{ notBefore: 0, notAfter: now - 1000 }],
    timestamp: now - 2000,   // 签署时证书还有效
  }, { now });
  assert.equal(r.status, "signed-expired");
  assert.match(r.note, /不是篡改/);
  const trust = assessTrust({
    signature: { status: "signed", certChain: [{ notBefore: 0, notAfter: now - 1000 }], timestamp: now - 2000 },
    buildId: "b1", channel: "release",
  }, { now, expectedBuildId: "b1" });
  assert.equal(trust.cases.signedButExpired, true);
  assert.equal(trust.columns.freshness.status, "fresh", "证书过期不得污染新鲜度列");
  assert.equal(trust.canCreateTarget, true);
  assert.notEqual(trust.verdict, "reject");
});

test("classifySignature：证书过期且无时间戳 → signed-notimestamp（与『已签名但过期』分列）", () => {
  const now = 1_000_000;
  const r = classifySignature({ status: "signed", certChain: [{ notBefore: 0, notAfter: now - 1 }], timestamp: null }, { now });
  assert.equal(r.status, "signed-notimestamp");
});

test("classifySignature：哈希不符 → tampered；无证书链不伪造结论 → unavailable；未签名 → unsigned", () => {
  assert.equal(classifySignature({ contentHashOK: false }).status, "tampered");
  assert.equal(classifySignature({ status: "signed", certChain: [] }).status, "unavailable");
  assert.equal(classifySignature({ status: "unsigned" }).status, "unsigned");
});

/* ---------- 来源 / 新鲜度 / 三列裁决 ---------- */
test("classifySource：release / internal-debug / unknown", () => {
  assert.equal(classifySource({ channel: "release" }).status, "official-release");
  assert.equal(classifySource({}, { channel: "internal-debug" }).status, "internal-debug");
  assert.equal(classifySource({}).status, "unknown");
});

test("验收#3：未签名但内部调试 ≠ 发布版缺签（不报『正式版未签名』警告）", () => {
  const debug = assessTrust({ signature: { status: "unsigned" }, channel: "internal-debug", buildId: "b1" }, { expectedBuildId: "b1" });
  assert.equal(debug.cases.unsignedInternalDebug, true);
  assert.ok(!debug.reasons.some((r) => r.includes("正式发布版未签名")), "调试构建不该被当成发布版缺签");
  const release = assessTrust({ signature: { status: "unsigned" }, channel: "release", buildId: "b1" }, { expectedBuildId: "b1" });
  assert.ok(release.reasons.some((r) => r.includes("正式发布版未签名")));
});

test("classifyFreshness：buildId 不匹配 → stale，拒绝创建新目标但保留恢复路径", () => {
  const r = classifyFreshness({ buildId: "old" }, { expectedBuildId: "new" });
  assert.equal(r.status, "stale");
  const t = assessTrust({ buildId: "old", signature: { status: "unsigned" }, channel: "release" }, { expectedBuildId: "new" });
  assert.equal(t.canCreateTarget, false);
  assert.equal(t.recoveryPath, true, "安全中间态任务仍可恢复");
  assert.equal(t.verdict, "degrade");
});

/* ---------- 生成器 / 校验器往返 ---------- */
function tmpFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orb-manifest-"));
  const dir = path.join(root, "build");
  fs.mkdirSync(path.join(dir, "resources", "app", "browser-extension"), { recursive: true });
  fs.mkdirSync(path.join(dir, "resources", "runtime", "python"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ORB 控制台.exe"), "EXE");
  fs.writeFileSync(path.join(dir, "resources", "app", "bridge.mjs"), "BRIDGE");
  fs.writeFileSync(path.join(dir, "resources", "app", "browser-extension", "background.js"),
    "const BUILD = '2026-11-09T0130';\n");
  fs.writeFileSync(path.join(dir, "resources", "runtime", "python", "python.exe"), "PY".repeat(100));
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("buildManifest：buildId 由内容哈希决定（同内容必相同、改内容必变）、bundledBuild 可读", () => {
  const files = [
    { path: "resources/app/bridge.mjs", size: 6, sha256: "aaa" },
    { path: "resources/app/browser-extension/background.js", size: 30, sha256: "bbb" },
  ];
  const a = buildManifest({ files, version: "1.5.0", stamp: "202611090632", bundledBuild: "2026-11-09T0130", now: 1 });
  const b = buildManifest({ files, version: "1.5.0", stamp: "202611090632", bundledBuild: "2026-11-09T0130", now: 999 });
  assert.equal(a.buildId, b.buildId, "buildId 不受生成时间影响（不可变）");
  assert.equal(a.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(a.bundledBuild, "2026-11-09T0130");
  assert.equal(a.signature.status, "unsigned", "无证书时如实未签名，不伪造");
  assert.equal(a.components.length, 7);
  const c = buildManifest({ files: [...files, { path: "x.mjs", size: 1, sha256: "ccc" }], version: "1.5.0", stamp: "202611090632" });
  assert.notEqual(a.buildId, c.buildId, "内容变了 buildId 必须变");
});

test("scanFiles：递归列出真实目录、排除清单自身、路径用 / 分隔、sha256 正确", () => {
  const f = tmpFixture();
  try {
    const rows = scanFiles(f.dir);
    assert.ok(rows.length >= 4);
    const bridge = rows.find((r) => r.path === "resources/app/bridge.mjs");
    assert.ok(bridge);
    assert.equal(bridge.sha256, crypto.createHash("sha256").update("BRIDGE").digest("hex"));
    assert.ok(rows.every((r) => !r.path.includes("\\")));
    // 写入清单自身后应被排除
    fs.writeFileSync(path.join(f.dir, "install-manifest.json"), "{}");
    assert.equal(scanFiles(f.dir).some((r) => r.path === "install-manifest.json"), false);
  } finally { f.cleanup(); }
});

test("verifyManifest 往返：PASS + 篡改 / 版本漂移 / buildId 不匹配 / 多文件 都能抓出", () => {
  const f = tmpFixture();
  try {
    const files = scanFiles(f.dir);
    const manifest = buildManifest({ files, version: "1.5.0", stamp: "202611090632",
      bundledBuild: "2026-11-09T0130", channel: "internal-debug", zipBytes: 1000 });
    fs.writeFileSync(path.join(f.dir, "install-manifest.json"), JSON.stringify(manifest, null, 2));

    const clean = verifyManifest(f.dir, { version: "1.5.0", expectedBuildId: manifest.buildId, channel: "internal-debug" });
    assert.equal(clean.ok, true, JSON.stringify(clean.checks.filter((c) => !c.ok)));
    assert.equal(clean.trust.cases.unsignedInternalDebug, true);

    // 版本漂移
    const drift = verifyManifest(f.dir, { version: "9.9.9", expectedBuildId: manifest.buildId });
    assert.equal(drift.ok, false);
    assert.equal(drift.checks[0].ok, false, "版本门禁应拦");

    // buildId 不匹配 → 新鲜度 stale → 拒绝创建新目标
    const stale = verifyManifest(f.dir, { version: "1.5.0", expectedBuildId: "DIFFERENT" });
    assert.equal(stale.trust.columns.freshness.status, "stale");
    assert.equal(stale.trust.canCreateTarget, false);
    assert.equal(stale.ok, false);

    // 多出未登记文件
    fs.writeFileSync(path.join(f.dir, "resources", "app", "injected.mjs"), "INJECT");
    const extra = verifyManifest(f.dir, { version: "1.5.0", expectedBuildId: manifest.buildId });
    assert.equal(extra.ok, false);
    assert.ok(extra.extra.includes("resources/app/injected.mjs"));
    fs.rmSync(path.join(f.dir, "resources", "app", "injected.mjs"));

    // 篡改文件
    fs.writeFileSync(path.join(f.dir, "resources", "app", "bridge.mjs"), "TAMPERED");
    const tampered = verifyManifest(f.dir, { version: "1.5.0", expectedBuildId: manifest.buildId });
    assert.equal(tampered.ok, false);
    assert.equal(tampered.checks.find((c) => c.name.includes("哈希")).ok, false);
    assert.ok(tampered.changed.length >= 1);
  } finally { f.cleanup(); }
});

test("verifyManifest：清单缺失 → reject 且不抛", () => {
  const f = tmpFixture();
  try {
    const r = verifyManifest(f.dir, { version: "1.5.0" });
    assert.equal(r.ok, false);
    assert.equal(r.checks[0].ok, false);
  } finally { f.cleanup(); }
});
