#!/usr/bin/env node
/* 生成 docs/registry.md —— 注册表自述文档。
 *
 * 解决的问题：orb/ 下有 47 个模块、若干状态写入器、若干指标名、一份能力清单。
 * 这些东西每加一个就要在文档里补一行，而"补一行"永远会被忘。
 * 于是文档不由人写：扫源码结构 + 读清单，生成一份确定性的自述。
 *
 * 确定性要求（和 gen-capabilities-doc.mjs 一样）：
 *   同样的源码必须生成同样的字节——排序全部显式指定，不依赖 readdir 顺序，
 *   不带时间戳、不带绝对路径、不带机器名。否则单测没法逐字比对，
 *   "漂移检测"就变成了"每天都会红的噪音"。
 *
 * 用法：
 *   node orb/tools/gen-registry-doc.mjs          # 写入
 *   node orb/tools/gen-registry-doc.mjs --check  # 只比对（CI / 验收用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, stopExemptSet } from "../capabilityRegistry.mjs";
import { STATE_WRITERS } from "../stateWriters.mjs";
import { METRICS } from "../span.mjs";
import { CATEGORIES, LEVELS } from "../logBus.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const OUT = path.join(ROOT, "docs", "registry.md");

/* 只扫 orb 根目录的 .mjs，不进 desktop/ 与 node_modules：
 * 前者是 CJS 主进程（另一套约定），后者不是我们的代码。 */
function listModules() {
  const names = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".mjs"))
    .map((d) => d.name)
    .sort();  // 显式排序：readdir 顺序在不同文件系统上不保证稳定
  return names;
}

/* 从文件头注释里取"这个模块是干什么的"：
 * 取 `/*` 之后第一行有实际内容的文字。
 * 有些模块的头部首行是装饰线（`------ 命令通道危险判定 ------`），
 * 把首尾的 -/=/* 剥掉后剩下的才是正文；剥完为空就看下一行。
 * 拿不到就返回空字符串 —— 生成的文档里会显示「（无头部说明）」：
 * 空着能被人看见，编一句解释看不见。 */
function headNote(src) {
  const m = /^\/\*([\s\S]*?)\*\//.exec(src);
  if (!m) return "";
  const lines = m[1].split("\n").map((l) => l.replace(/^\s*\*?\s?/, "").trimEnd());
  for (const raw of lines) {
    const t = raw.trim().replace(/^[-=*\s]+/, "").replace(/[-=*\s]+$/, "").trim();
    if (t) return t.replace(/\s+/g, " ");
  }
  return "";
}

/* 导出名：三种写法都认。
 *   export const X / export function X / export async function X / export class X
 *   export { a, b as c }
 * 提取"导出名"而不是"全部标识符"，是为了让文档能回答
 * 「这个模块对外的面到底有多大」—— 面越大越难改，这是个有用的信号。 */
function exportNames(src) {
  const out = new Set();
  const re = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  const re2 = /^export\s*\{([^}]*)\}/gm;
  while ((m = re2.exec(src))) {
    for (const part of m[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const as = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(seg);
      out.add(as ? as[1] : seg.split(/\s+/)[0]);
    }
  }
  return [...out].sort();
}

function build() {
  const rows = listModules().map((name) => {
    const src = fs.readFileSync(path.join(ROOT, name), "utf8");
    return { name, note: headNote(src), exports: exportNames(src) };
  });

  const L = [];
  L.push("# ORB 注册表自述（自动生成，勿手改）");
  L.push("");
  L.push("> 由 `orb/tools/gen-registry-doc.mjs` 从源码结构生成。");
  L.push("> 要改内容请改源码；改完跑 `node orb/tools/gen-registry-doc.mjs` 重新生成。");
  L.push("> 单测 `test/registryDoc.test.mjs` 会校验本文件与源码一致 —— 手改会直接测挂。");
  L.push("");

  L.push("## 一、桥侧模块（orb/*.mjs）");
  L.push("");
  L.push(`共 ${rows.length} 个。按文件名排序，不按重要性 —— 排序规则一旦掺入主观判断就会天天变。`);
  L.push("");
  L.push("**故意不记行数**：行数每次修 bug 都变，把它放进文档等于让「漂移检测」")
  L.push("每次提交都红一次，红到最后就没人看了。");
  L.push("这里只记**结构**：有哪些模块、各自对外露了什么、头部怎么自述的。");
  L.push("这三样只在真的增删模块或改导出时才会变 —— 那时文档确实该跟着变。");
  L.push("");
  L.push("| 模块 | 它是什么 | 对外导出 |");
  L.push("|---|---|---|");
  for (const r of rows) {
    const ex = r.exports.length ? r.exports.join("` `") : "";
    L.push(`| \`${r.name}\` | ${r.note || "（无头部说明）"} | ${ex ? "`" + ex + "`" : "—"} |`);
  }
  L.push("");

  L.push("## 二、急停豁免能力（安全边界）");
  L.push("");
  L.push(`清单在 \`orb/capabilityRegistry.mjs\`，共 ${CAPABILITIES.length} 条，其中 ${stopExemptSet().size} 条在急停期间放行。`);
  L.push("完整说明见 [`capabilities.md`](./capabilities.md)（同样自动生成）。");
  L.push("");
  L.push("| server | tool | 急停放行 | 它到底做了什么 |");
  L.push("|---|---|---|---|");
  for (const c of CAPABILITIES) {
    L.push(`| ${c.server} | ${c.tool} | ${(c.stopExempt && c.readOnly) ? "是" : "否"} | ${c.effect || ""} |`);
  }
  L.push("");

  L.push("## 三、状态写入器（STATE_WRITERS）");
  L.push("");
  L.push("这些位置是**允许写任务状态**的地方。清单外的代码直接改 status 就是越权，");
  L.push("`stateWriters.mjs` 的等级规则（RANK）会挡住「降级回写」。");
  L.push("");
  L.push("| 名字 | 说明 |");
  L.push("|---|---|");
  for (const w of STATE_WRITERS) {
    /* 写者表的真实字段是 owner / via / scope / rule（2026-11-07 修正）。
     * 旧版取 w.id || w.name、w.note || w.label，全是 undefined，
     * 生成出来整节是 `?` 与空说明 —— 一张「谁有权写状态」的表全是问号等于没有表。 */
    const name = w.owner || w.id || w.name || "?";
    const desc = [w.scope, w.via, w.rule].filter(Boolean).map((s) => String(s).replace(/\|/g, "\\|")).join("；");
    L.push(`| \`${name}\` | ${desc} |`);
  }
  L.push("");

  L.push("## 四、指标（METRICS）");
  L.push("");
  L.push(`共 ${METRICS.length} 个。名字进这里是契约：改名字等于改监控面板的查询。`);
  L.push("");
  L.push("| 指标 | 类型 | 说明 |");
  L.push("|---|---|---|");
  for (const m of METRICS) {
    /* METRICS 是字符串数组（span.mjs），不是对象数组；旧版用 m.name 全是 undefined。 */
    const name = typeof m === "string" ? m : (m.name || m.id || "?");
    const kind = typeof m === "string" ? "" : (m.kind || m.type || "");
    const desc = typeof m === "string" ? "" : (m.note || m.desc || "");
    L.push(`| \`${name}\` | ${kind} | ${desc} |`);
  }
  L.push("");

  L.push("## 五、日志分类与级别");
  L.push("");
  L.push(`分类（${CATEGORIES.length}）：${CATEGORIES.map((c) => "`" + (c.id || c) + "`").join("、")}`);
  L.push("");
  L.push(`级别（${LEVELS.length}）：${LEVELS.map((l) => "`" + (l.id || l) + "`").join("、")}`);
  L.push("");
  L.push("新增分类必须同步面板的筛选项，否则日志会写进去但没人看得到。");
  L.push("");

  return L.join("\n");
}

const md = build();
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  let cur = "";
  try { cur = fs.readFileSync(OUT, "utf8"); } catch { cur = ""; }
  if (cur === md) {
    console.log(`REG_OK  注册表文档与源码一致（${listModules().length} 个模块）`);
    process.exit(0);
  }
  console.error(`REG_DRIFT  注册表文档与源码不一致：${OUT}`);
  console.error("  跑 `node orb/tools/gen-registry-doc.mjs` 重新生成。");
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, md, "utf8");
console.log(`REG_WROTE  ${OUT}（${listModules().length} 个模块，${CAPABILITIES.length} 条能力，${METRICS.length} 个指标）`);
