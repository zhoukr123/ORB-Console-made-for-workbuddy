#!/usr/bin/env node
/* 存储结构迁移到扁平化布局（一次性工具，可反复跑，幂等）。
 *
 * 旧结构：<root>/artifacts/<day>/sessions/<cid>/<kind>/...
 * 新结构：<root>/<kind>/<day>/<product>   （扁平两层，类别目录即真实落点，无 artifacts 容器）
 *
 * 本工具调用 desktop/migrateLayout.cjs（与应用内「搬过来」按钮同一份实现）：
 *   · 把旧 artifacts 树摊平进 <root>/<kind>/<day>/<rest...>，去掉 sessions/<cid> 层；
 *   · 旧顶层分类目录（recordings/screenshots/vidx/...）残留文件合进新根对应类别；
 *   · 改写登记表 rel 旧形→新形（<day>/sessions/<cid>/<kind>/<rest> → <kind>/<day>/<rest>），
 *     并重算 rootKey 为新根指纹，避免迁移后全部显示「存储根已换」；按 id 去重。
 * 原则（与用户长期规矩一致）：只复制不删除；同名跳过；幂等（重复跑无副作用）。
 *
 * 用法：
 *   node tools/migrate-legacy.mjs                 # 预览（不改动任何文件）
 *   node tools/migrate-legacy.mjs --apply         # 原地迁移（from=to=当前存储根）
 *   node tools/migrate-legacy.mjs --root "D:\ORB存储" --apply
 *   node tools/migrate-legacy.mjs --from OLD --to NEW --apply   # 跨根迁移
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { migrateRoot } = require("../desktop/migrateLayout.cjs");
const { KINDS } = require("../desktop/artifactLayout.cjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const rootArg = pick("--root");
const fromArg = pick("--from");
const toArg = pick("--to");

function pick(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

/* 默认存储根：--root > --to > 开发态 DATA_ROOT（项目根） */
const ROOT = path.resolve(rootArg || toArg || path.join(HERE, "..", ".."));
const fromRoot = path.resolve(fromArg || rootArg || ROOT);
const toRoot = path.resolve(toArg || rootArg || ROOT);

function countFiles(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
      else if (e.isFile()) n++;
    }
  } catch {}
  return n;
}

function countRegistry(govDir) {
  let n = 0;
  function walk(dir, depth) {
    if (depth > 3) return;
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.name.startsWith("artifacts.") || !e.name.endsWith(".jsonl")) continue;
      for (const ln of fs.readFileSync(full, "utf8").split("\n")) if (ln.trim()) n++;
    }
  }
  walk(govDir, 0);
  return n;
}

/* 轻量预览：统计旧 artifacts 树里的「天/文件数」与登记表条目数。 */
function parsePlan() {
  const out = { days: 0, files: 0, crossRoot: fromRoot !== toRoot };
  const art = path.join(fromRoot, "artifacts");
  try {
    for (const dn of fs.readdirSync(art)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dn)) continue;
      const sessDir = path.join(art, dn, "sessions");
      let cids = [];
      try {
        cids = fs.readdirSync(sessDir, { withFileTypes: true })
          .filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {}
      let f = 0;
      for (const c of cids) {
        for (const k of KINDS) f += countFiles(path.join(sessDir, c, k));
      }
      if (cids.length) { out.days++; out.files += f; }
    }
  } catch {}
  out.registry = countRegistry(path.join(fromRoot, "governance"));
  return out;
}

console.log("存储根（源）：" + fromRoot);
console.log("存储根（目标）：" + toRoot + (fromRoot === toRoot ? "  （原地迁移）" : "  （跨根迁移）"));

const plan = parsePlan();
console.log(`\n预览：旧 artifacts 树含 ${plan.days} 个日期、约 ${plan.files} 个产物文件；` +
  `登记表条目约 ${plan.registry} 条（rel 旧形→新形改写、rootKey 重算）。`);
console.log("目标形状：<root>/<kind>/<day>/<product>（kind ∈ " + KINDS.join(", ") + "）");

if (!APPLY) {
  console.log("\n[预览模式] 未改动任何文件。确认无误后加 --apply 执行（复制，不删除原件）。");
  process.exit(0);
}

console.log("\n开始迁移（只复制不删除，不会触碰任何源文件）…");
const res = migrateRoot(fromRoot, toRoot, {});
console.log("迁移结果：");
console.log("  · 复制文件：" + res.moved);
console.log("  · 跳过（已存在）：" + res.skipped);
console.log("  · 迁移字节数：" + res.bytes);
console.log("  · 是否截断（超出单次上限）：" + (res.truncated ? "是" : "否"));
if (res.errors && res.errors.length) {
  console.log("  · 错误 " + res.errors.length + " 条：");
  for (const e of res.errors.slice(0, 20)) console.log("    - " + e);
} else {
  console.log("  · 错误：无");
}
console.log("\n完成。原文件全部保留在原位置；核对无误后，可自行删除旧的 artifacts/ 目录。");
process.exitCode = res.ok ? 0 : 1;
