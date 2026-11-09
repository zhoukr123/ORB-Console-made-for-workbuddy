#!/usr/bin/env node
/* 校验安装清单（方案 S6）：复算哈希防篡改、核对版本、签名/来源/新鲜度分列判定。
 *
 * 用法：
 *   node orb/tools/verify-manifest.mjs <构建目录> [--expected-build-id=xxx] [--channel=..] [--json]
 *
 * 退出码：0 = 通过/仅警告；1 = 拒绝（哈希不符 / 版本漂移 / 新鲜度失效需拒绝创建新目标）。
 * 注意：签名过期 / 内部调试未签名是**分列判定**，不因它们把 verdict 直接打成 reject。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessTrust } from "../releaseManifest.mjs";
import { readVersion, scanFiles } from "./make-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 核心校验（纯逻辑，注入 fs 便于单测）。
 * 返回 { ok, reject, checks, trust, manifest }。
 */
export function verifyManifest(dir, opts = {}) {
  const io = opts.fs || fs;
  // manifestPath 显式指定独立发布资产；否则按约定在构建目录内找 install-manifest.json。
  const mPath = opts.manifestPath || path.join(dir, "install-manifest.json");
  let manifest;
  try { manifest = JSON.parse(io.readFileSync(mPath, "utf8")); }
  catch (e) { return { ok: false, reject: true, checks: [{ name: "清单可读", ok: false, detail: e.message }], trust: null, manifest: null }; }

  const checks = [];
  let expectedVersion;
  try { expectedVersion = opts.version || readVersion(ROOT); } catch (e) { expectedVersion = null; }
  checks.push({ name: "版本与单一真相源一致", ok: !!expectedVersion && manifest.version === expectedVersion,
    detail: `清单 ${manifest.version} / pack.cjs ${expectedVersion}` });
  checks.push({ name: "schemaVersion 受支持", ok: manifest.schemaVersion === 1, detail: String(manifest.schemaVersion) });

  // 逐文件复算哈希：缺失 / 多出 / 内容变更都算篡改。
  const actual = new Map(scanFiles(dir, { fs: io }).map((f) => [f.path, f.sha256]));
  const declared = new Map((manifest.files || []).map((f) => [f.path, f.sha256]));
  const missing = [...declared.keys()].filter((p) => !actual.has(p));
  const changed = [...declared.keys()].filter((p) => actual.has(p) && actual.get(p) !== declared.get(p));
  // 排除清单自身后多出来的文件（新增未登记组件）
  const extra = [...actual.keys()].filter((p) => !declared.has(p) && p !== "install-manifest.json");
  const hashOk = missing.length === 0 && changed.length === 0 && extra.length === 0;
  checks.push({ name: "组件哈希复算一致（防篡改）", ok: hashOk,
    detail: `missing=${missing.length} changed=${changed.length} extra=${extra.length}` +
      (changed.length ? ` · 首个变更 ${changed[0]}` : "") });

  const trust = assessTrust(manifest, {
    expectedBuildId: opts.expectedBuildId,
    channel: opts.channel,
    now: opts.now,
  });
  // 「已签名但过期」与「未签名但内部调试」单独列为可读结论，不混进 hash 判定。
  checks.push({ name: "签名列", ok: trust.columns.signature.status !== "tampered", detail: `${trust.columns.signature.status}：${trust.columns.signature.note}` });
  checks.push({ name: "来源列", ok: true, detail: `${trust.columns.source.status}：${trust.columns.source.note}` });
  checks.push({ name: "新鲜度列", ok: trust.columns.freshness.status !== "stale", detail: `${trust.columns.freshness.status}：${trust.columns.freshness.note}` });

  const versionOk = checks[0].ok;
  const reject = !hashOk || !versionOk || trust.columns.freshness.status === "stale" || trust.verdict === "reject";
  return { ok: !reject, reject, checks, trust, manifest,
    changed, missing, extra };
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  const dirArg = argv.find((a) => !a.startsWith("--"));
  if (!dirArg) { console.error("用法: node verify-manifest.mjs <构建目录> [--expected-build-id=..] [--channel=..] [--json]"); process.exit(1); }
  const argOf = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const asJson = argv.includes("--json");
  const mp = argOf("manifest", undefined);
  const r = verifyManifest(path.resolve(dirArg), {
    expectedBuildId: argOf("expected-build-id", undefined),
    channel: argOf("channel", undefined),
    manifestPath: mp ? path.resolve(mp) : undefined,
  });
  if (asJson) {
    console.log(JSON.stringify({ ok: r.ok, reject: r.reject, checks: r.checks,
      canCreateTarget: r.trust?.canCreateTarget, cases: r.trust?.cases, reasons: r.trust?.reasons }, null, 2));
  } else {
    for (const c of r.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"} ${c.name} · ${c.detail}`);
    if (r.trust) {
      console.log(`  verdict=${r.trust.verdict} canCreateTarget=${r.trust.canCreateTarget} recoveryPath=${r.trust.recoveryPath}`);
      if (r.trust.cases.signedButExpired) console.log("  ↳ 「已签名但过期」：签名有效但证书过期，不判篡改/不判新鲜度失效");
      if (r.trust.cases.unsignedInternalDebug) console.log("  ↳ 「未签名但内部调试」：预期内，不等于发布版缺签");
      for (const x of r.trust.reasons) console.log("  ! " + x);
    }
    console.log(r.ok ? "MANIFEST_VERIFY_OK" : "MANIFEST_VERIFY_REJECT");
  }
  process.exit(r.ok ? 0 : 1);
}

export default { verifyManifest };
