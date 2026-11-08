#!/usr/bin/env node
/* 生成 docs/expertBook.md —— 专家契约的唯一文档副本。
 * 与 gen-capabilities-doc 同一套逻辑：文档由代码生成、单测逐字比对。
 * 理由也一样：这份表写错了，运维会按错的档位去理解"为什么它被拒"。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toMarkdown, DEFAULT_BOOK } from "../expertContract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "..", "docs", "expertBook.md");

const md = toMarkdown(DEFAULT_BOOK);
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  let cur = "";
  try { cur = fs.readFileSync(OUT, "utf8"); } catch { cur = ""; }
  if (cur === md) {
    console.log(`EXPERT_OK  文档与契约一致（${Object.keys(DEFAULT_BOOK.experts).length} 个专家）`);
    process.exit(0);
  }
  console.error(`EXPERT_DRIFT  文档与契约不一致：${OUT}`);
  console.error("  跑 `node orb/tools/gen-expertbook-doc.mjs` 重新生成。");
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md, "utf8");
console.log(`EXPERT_WROTE  ${OUT}（${Object.keys(DEFAULT_BOOK.experts).length} 个专家）`);
