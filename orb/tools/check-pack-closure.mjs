/* 打包闭包校验：从 bridge.mjs 出发，算出所有本地 .mjs 的传递依赖，
 * 与 pack.cjs 的 BRIDGE_LOCAL 清单做差集。
 *
 * 为什么需要这个：pack.cjs 自带的审计只反推 bridge.mjs 的**直接**依赖，
 * 而「已打包模块又 import 了另一个模块」这种间接依赖，开发态永远正常，
 * 便携版运行时才 ERR_MODULE_NOT_FOUND（11-07 的 refBinding / siteCapabilityData /
 * pluginArtifactGate 就是这类）。这条工具把闭包算全，把事故前移到开发态。
 *
 * 用法：node tools/check-pack-closure.mjs [--json]；有任何缺失退出码 1。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

function bridgeLocalList() {
  const src = fs.readFileSync(path.join(ROOT, "pack.cjs"), "utf8");
  const a = src.indexOf("const BRIDGE_LOCAL = [");
  const b = src.indexOf("\n];", a);
  const block = src.slice(a, b);
  return [...block.matchAll(/'([^']+\.mjs)'/g)].map((m) => m[1]);
}

function localImports(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return [];
  const src = fs.readFileSync(p, "utf8");
  const out = new Set();
  for (const m of src.matchAll(/from\s+["']\.\/([\w.\-/]+\.mjs)["']/g)) out.add(m[1]);
  for (const m of src.matchAll(/import\(\s*["']\.\/([\w.\-/]+\.mjs)["']\s*\)/g)) out.add(m[1]);
  /* new URL("./team.mjs", import.meta.url) 形态的动态导入也要算 */
  for (const m of src.matchAll(/new URL\(\s*["']\.\/([\w.\-/]+\.mjs)["']/g)) out.add(m[1]);
  return [...out];
}

export function checkClosure() {
  const listed = bridgeLocalList();
  const listedSet = new Set(listed);
  const seen = new Set();
  const queue = ["bridge.mjs"];
  const edges = [];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of localImports(f)) {
      edges.push({ from: f, to: dep });
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  const missing = [...seen].filter((f) => f !== "bridge.mjs" && !listedSet.has(f)).sort();
  const missingFiles = listed.filter((f) => !fs.existsSync(path.join(ROOT, f))).sort();
  const duplicates = listed.filter((f, i) => listed.indexOf(f) !== i);
  return {
    ok: missing.length === 0 && missingFiles.length === 0 && duplicates.length === 0,
    listed: listed.length,
    reachable: seen.size - 1,
    edges: edges.length,
    missing, missingFiles, duplicates: [...new Set(duplicates)],
  };
}

/* 面板侧闭包：panel.html 这类页面用 `src=` / `href=` 引本地 css/js，
 * 这些引用**不在 bridge.mjs 的 import 图里**，闭包算法天生看不到。
 * 2026-11-09 就是这么漏掉 pluginSettings.js 的：开发态文件就在旁边，
 * 发布版「设置 › 插件」页会永远停在"读取中"，而且不报错。
 *
 * 判据：被 <script src> / <link href> 引用的本地文件，必须出现在
 * pack.cjs 的 APP_FILES 里，或落在 APP_DIRS 某个目录下。
 */
function appFilesList() {
  const src = fs.readFileSync(path.join(ROOT, "pack.cjs"), "utf8");
  const a = src.indexOf("const APP_FILES = [");
  const b = src.indexOf("\n];", a);
  const block = src.slice(a, b);
  const files = [...block.matchAll(/'([\w.\-/]+)'/g)].map((m) => m[1]);
  const da = src.indexOf("const APP_DIRS = [");
  const db = src.indexOf("];", da);
  const dirs = da < 0 ? [] : [...src.slice(da, db).matchAll(/'([\w.\-/]+)'/g)].map((m) => m[1]);
  return { files, dirs };
}

export function checkAppAssets() {
  const { files, dirs } = appFilesList();
  const set = new Set(files);
  const refs = [];
  for (const f of files.filter((x) => /\.html?$/i.test(x))) {
    const abs = path.join(ROOT, "desktop", f);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, "utf8");
    for (const m of src.matchAll(/(?:src|href)\s*=\s*["']([^"'#?]+)["']/g)) {
      const ref = m[1].trim();
      if (!ref || /^[a-z]+:/i.test(ref) || ref.startsWith("//") || ref.startsWith("data:")) continue;
      refs.push({ html: f, ref: ref.replace(/^\.\//, "") });
    }
  }
  const missing = [...new Set(refs
    .filter(({ ref }) => {
      if (set.has(ref)) return false;
      if (dirs.some((d) => ref.startsWith(d + "/"))) return false;
      return fs.existsSync(path.join(ROOT, "desktop", ref));   // 只报"文件真在、却没登记"
    })
    .map(({ html, ref }) => html + " → " + ref))].sort();
  return { ok: missing.length === 0, checked: refs.length, missing };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkClosure();
  const a = checkAppAssets();
  if (asJson) console.log(JSON.stringify({ ...r, assets: a }, null, 2));
  else {
    console.log(`PACK_CLOSURE ${r.ok ? "OK" : "FAIL"}  清单 ${r.listed} / 可达 ${r.reachable} / 依赖边 ${r.edges}`);
    if (r.missing.length) console.log("  漏登记（会被便携版运行时打脸）：", r.missing.join(", "));
    if (r.missingFiles.length) console.log("  清单里但文件不存在：", r.missingFiles.join(", "));
    if (r.duplicates.length) console.log("  清单重复项：", r.duplicates.join(", "));
    console.log(`PACK_ASSETS ${a.ok ? "OK" : "FAIL"}  页面引用 ${a.checked} 条`);
    if (a.missing.length) console.log("  HTML 引用了、却没进包：", a.missing.join(", "));
  }
  process.exit(r.ok && a.ok ? 0 : 1);
}

export default { checkClosure, checkAppAssets };
