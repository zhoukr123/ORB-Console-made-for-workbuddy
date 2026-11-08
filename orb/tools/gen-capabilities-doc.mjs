#!/usr/bin/env node
/* 生成 docs/capabilities.md —— 急停豁免清单的唯一文档副本。
 *
 * 为什么要有这个脚本：只要文档是手写的，它迟早会和代码不一致；
 * 而这份文档描述的是"急停期间什么东西还能动"，写错的代价不是难看，是危险。
 * 所以文档不由人写，由清单生成，单测再逐字比对 —— 手改文档会直接测挂。
 *
 * 用法：
 *   node orb/tools/gen-capabilities-doc.mjs        # 写入/覆盖
 *   node orb/tools/gen-capabilities-doc.mjs --check # 只比对，不写（CI 用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toMarkdown, CAPABILITIES, stopExemptSet } from "../capabilityRegistry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "docs", "capabilities.md");

const md = toMarkdown();
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  let cur = "";
  try { cur = fs.readFileSync(OUT, "utf8"); } catch { cur = ""; }
  if (cur === md) {
    console.log(`CAP_OK  文档与清单一致（${CAPABILITIES.length} 条，豁免 ${stopExemptSet().size} 条）`);
    process.exit(0);
  }
  console.error(`CAP_DRIFT  文档与清单不一致：${OUT}`);
  console.error("  跑 `node orb/tools/gen-capabilities-doc.mjs` 重新生成。");
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md, "utf8");
console.log(`CAP_WROTE  ${OUT}（${CAPABILITIES.length} 条，豁免 ${stopExemptSet().size} 条）`);
