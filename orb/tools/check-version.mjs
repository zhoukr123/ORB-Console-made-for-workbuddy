#!/usr/bin/env node
/* 版本一致性闸门（S1）。
 *
 * 单一真相源 = `orb/pack.cjs` 里的 `const VERSION = 'x.y.z'`。
 * 其余四处（两个 package.json、AGENTS.md、ROADMAP.md）必须与之对齐，
 * 否则视为漂移直接失败 —— 这正是 P0-1（AGENTS.md 写 v1.4.1、orb/package.json 写 1.0.1）的根因。
 *
 * 不在「派生」层面改所有文件（风险高、易误伤构建/安装器读取 package.json 的逻辑），
 * 而是用门禁把漂移拦在发布前：改了一处忘了同步另一处，verify-all 立刻红。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const pack = read("orb/pack.cjs");
const m = pack.match(/const\s+VERSION\s*=\s*["']([^"']+)["']/);
if (!m) { console.error("✗ 找不到 pack.cjs 里的 VERSION 常量"); process.exit(1); }
const V = m[1];

const issues = [];
const json = (p) => JSON.parse(read(p));

const desktop = json("orb/desktop/package.json");
if (desktop.version !== V) issues.push(`orb/desktop/package.json 写 ${desktop.version}，应为 ${V}`);

const orb = json("orb/package.json");
if (orb.version !== V) issues.push(`orb/package.json 写 ${orb.version}，应为 ${V}`);

const agents = read("AGENTS.md");
if (!new RegExp(`当前版本：\`?v?${V}`).test(agents)) issues.push(`AGENTS.md 未声明当前版本 v${V}`);

const road = read("ROADMAP.md");
if (!new RegExp(`当前代码\\s*\\*\\*v?${V}\\*\\*`).test(road)) issues.push(`ROADMAP.md 未声明当前代码 v${V}`);

if (issues.length) {
  console.error("✗ 版本不一致：");
  for (const i of issues) console.error("  - " + i);
  process.exit(1);
}
console.log(`VERSION_CONSISTENT ${V}`);
