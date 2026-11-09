#!/usr/bin/env node
/* 生成安装清单 install-manifest.json（方案 S6，代码侧部分）。
 *
 * 用法：
 *   node orb/tools/make-manifest.mjs <构建目录> [--zip=xxx.zip] [--channel=release|internal-debug]
 *                                   [--stamp=202611090632] [--build-id=xxx]
 *
 * 落盘内容：版本（单一真相源 pack.cjs 的 VERSION）、不可变 buildId、组件分组哈希、
 * 体积评估、签名声明（**不伪造签名**：无证书时如实 status=unsigned，另附签名占位结构），
 * 供 verify-manifest.mjs 复算与「签名/来源/新鲜度分列判定」。
 *
 * 代码签名 crypto 步骤（signtool / 证书链 / RFC3161 时间戳）属外部证书流程，
 * 由发布流程在拿到证书后填 signature 字段；本脚本只产出结构完整、可校验的清单。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_SCHEMA_VERSION, ZIP_TARGET_BYTES, componentGroupOf, summarizeComponents, evaluateSize,
} from "../releaseManifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** 从单一真相源 pack.cjs 读 VERSION（与 check-version.mjs 同源）。可注入便于单测。 */
export function readVersion(root = ROOT) {
  const src = fs.readFileSync(path.join(root, "orb", "pack.cjs"), "utf8");
  const m = src.match(/const\s+VERSION\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error("找不到 pack.cjs 里的 VERSION 常量");
  return m[1];
}

/** 从随包扩展 background.js 读 BUILD 戳（与 bridge 的 readBundledExtBuild 同源）。 */
export function readBundledBuild(dir) {
  const candidates = [
    path.join(dir, "resources", "app", "browser-extension", "background.js"),
    path.join(dir, "resources", "app", "browser-extension", "manifest.json"),
  ];
  for (const f of candidates) {
    try {
      const t = fs.readFileSync(f, "utf8");
      const m = t.match(/const\s+BUILD\s*=\s*["']([^"']+)["']/);
      if (m && m[1]) return m[1];
    } catch {}
  }
  return null;
}

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

/** 递归列出文件（排除清单自身）。返回 [{path(相对, / 分隔), size, sha256}]。可注入 fs 供单测。 */
export function scanFiles(dir, { fs: io = fs, skip = new Set(["install-manifest.json"]) } = {}) {
  const out = [];
  function walk(abs, rel) {
    let ents = [];
    try { ents = io.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.has(e.name) && !rel) continue;
      const a = path.join(abs, e.name);
      if (e.isDirectory()) walk(a, r);
      else if (e.isFile()) {
        try {
          const buf = io.readFileSync(a);
          out.push({ path: r, size: buf.length, sha256: sha256(buf) });
        } catch {}
      }
    }
  }
  walk(dir, "");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * 构造清单对象（纯逻辑，接受已扫好的文件列表，便于单测锁定结构）。
 * buildId 不可变：由 version + stamp + 所有文件哈希拼出的内容摘要决定，同样内容必得同样 id。
 */
export function buildManifest({ files, version, stamp, bundledBuild, zipBytes = null, channel = "release", now = Date.now(), signature = null }) {
  const contentDigest = sha256(Buffer.from(files.map((f) => `${f.path}:${f.sha256}`).join("\n")));
  const buildId = `${version}-${stamp || "dev"}-${contentDigest.slice(0, 12)}`;
  const groups = summarizeComponents(files.map((f) => ({ path: f.path, size: f.size, group: componentGroupOf(f.path) })));
  const size = evaluateSize(groups, { zipBytes });
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    version,
    buildId,
    stamp: String(stamp || ""),
    channel,
    generatedAt: new Date(now).toISOString(),
    bundledBuild,                       // 扩展 BUILD 戳（新鲜度列比对用）
    /* 签名：默认如实未签名。外部签名流程填入 status/timestamp/certChain/algorithm 后，
     * verify-manifest 会走「已签名但过期 / 签名有效」的分列判定。 */
    signature: signature || {
      status: "unsigned",
      algorithm: null,
      signedAt: null,
      timestamp: null,
      certChain: [],
      note: "未签名：代码签名证书采购与 signtool/RFC3161 属发布外部流程，清单不伪造签名",
    },
    components: groups,
    size,
    zipTargetBytes: ZIP_TARGET_BYTES,
    files,                              // 逐文件哈希，verify 复算防篡改
  };
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const argv = process.argv.slice(2);
  const dirArg = argv.find((a) => !a.startsWith("--"));
  if (!dirArg) { console.error("用法: node make-manifest.mjs <构建目录> [--zip=..] [--channel=..] [--stamp=..]"); process.exit(1); }
  const dir = path.resolve(dirArg);
  if (!fs.existsSync(dir)) { console.error("✗ 构建目录不存在:", dir); process.exit(1); }
  const argOf = (k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
  const zipArg = argOf("zip", null);
  const zipBytes = zipArg && fs.existsSync(path.resolve(zipArg)) ? fs.statSync(path.resolve(zipArg)).size : null;
  const channel = argOf("channel", "release");
  const stamp = argOf("stamp", path.basename(dir).match(/(\d{12})$/)?.[1] || "");
  /* --out= 让清单可以写成「与 zip/exe 并列的独立发布资产」而非塞进构建目录：
   * 生成时 zip 体积已知、且不改动 zip 内容（哈希针对 OUT 目录 = zip 解压后的确切内容）。 */
  const outArg = argOf("out", null);
  const version = readVersion(ROOT);
  const files = scanFiles(dir);
  const manifest = buildManifest({ files, version, stamp, bundledBuild: readBundledBuild(dir), zipBytes, channel });
  const outPath = outArg ? path.resolve(outArg) : path.join(dir, "install-manifest.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const s = manifest.size;
  console.log(`MANIFEST_WROTE ${outPath}`);
  console.log(`  version=${manifest.version} buildId=${manifest.buildId} files=${files.length}`);
  console.log(`  zipBytes=${s.zipBytes ?? "null"} target=${s.targetBytes} overTarget=${s.overTarget}`);
  console.log(`  pythonRuntime=${(s.pythonRuntimeBytes / 1048576).toFixed(1)}MB ratio=${s.pythonRuntimeRatio} → 外置后估算 ${s.projectedWithoutPython == null ? "n/a" : (s.projectedWithoutPython / 1048576).toFixed(1) + "MB"} 达标=${s.meetsTargetAfterExternalizingPython}`);
  console.log(`  signature=${manifest.signature.status}（未签名如实标注，签名属外部证书流程）`);
}

export default { readVersion, readBundledBuild, scanFiles, buildManifest };
