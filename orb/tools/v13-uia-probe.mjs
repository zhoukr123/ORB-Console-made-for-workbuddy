/* V-13 实机 UIA 探针分析器（11-07 落地）。
 *
 * 滞后任务 #65 剩下的半项：V-13 a11y 双路融合里「实机 Snapshot(use_ui_tree:true,
 * use_vision:false) 的树完整度 / 耗时记录」一直没做。这里补一个可复跑的分析器：
 * 输入一份真实 UIA 树文本，输出结构完整度、可操作性、匿名窗口比例、同名控件
 * 歧义风险（AMBIGUOUS_TARGET）与 ref 绑定建议；不做截图、不点坐标、不改桌面。
 *
 * 用法：
 *   node tools/v13-uia-probe.mjs <树文本文件> [--elapsed-ms=123] [--json]
 * 不传 --elapsed-ms 时耗时字段为 null（不补零、不编数）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
/* S4：接入 V-13 五项指标 + 降级阈值（v13Metrics / v13LoopGuard），让探针报告
 * 直接给出「五项指标与降级阈值」并判定是否应脱离视觉循环（验收总纲 #4）。 */
import { computeTreeMetrics, V13_METRICS, V13_THRESHOLDS, evaluateMetric } from "../v13Metrics.mjs";
import { decideDegradation } from "../v13LoopGuard.mjs";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--"));
const elapsedArg = argv.find((a) => a.startsWith("--elapsed-ms="));
const asJson = argv.includes("--json");

export function analyzeUiTree(raw, opts = {}) {
  const text = String(raw ?? "");
  const treeStart = text.indexOf("UI Tree:");
  const tree = treeStart >= 0 ? text.slice(treeStart + "UI Tree:".length) : text;
  const lines = tree.split(/\r?\n/).filter((l) => l.trim());

  const windows = [];
  const actionable = [];
  const labels = new Map();
  let maxDepth = 0;

  for (const line of lines) {
    /* 缩进层级：每个 "│   " / "    " 算一层；末级 ├──/└── 不计入层数。 */
    const prefix = line.match(/^([│├└\s]*)/)?.[1] ?? "";
    const depth = (prefix.match(/│|    /g) || []).length;
    maxDepth = Math.max(maxDepth, depth);

    const win = line.match(/window\s+"([^"]*)"/);
    if (win) windows.push({ name: win[1], depth });

    const btn = line.match(/\((\d+),(\d+)\)\s*([^\s"]+)\s+"([^"]*)"(.*)$/);
    if (btn) {
      const label = btn[4].trim();
      const rec = { x: Number(btn[1]), y: Number(btn[2]), kind: btn[3], label, depth,
        action: /\[action:\s*([^\]]+)\]/.exec(btn[5])?.[1] || null };
      actionable.push(rec);
      labels.set(label, (labels.get(label) || 0) + 1);
    }
  }

  const anonymous = windows.filter((w) => !w.name.trim()).length;
  const named = windows.length - anonymous;
  const duplicates = [...labels.entries()].filter(([, n]) => n > 1).map(([label, n]) => ({ label, n }));

  /* 完整度口径：只有「具名窗口占比」和「带坐标可操作控件数」是能直接从树里数出来的，
   * 不把它们合成一个好看的百分制分数 —— 合成分数会掩盖匿名窗口这个真实缺口。 */
  const coverage = {
    windowCount: windows.length,
    namedWindows: named,
    anonymousWindows: anonymous,
    namedRatio: windows.length ? Number((named / windows.length).toFixed(3)) : null,
    actionableNodes: actionable.length,
    withCoordinates: actionable.filter((a) => Number.isFinite(a.x) && Number.isFinite(a.y)).length,
    withAction: actionable.filter((a) => a.action).length,
    maxDepth,
  };

  /* S4：五项指标（单次树只算得出 ②③⑤，其余留 null 不补零）+ 阈值判定 + 降级裁决。 */
  const metrics = computeTreeMetrics(coverage, { treeText: tree });
  const evaluated = Object.values(V13_METRICS).map((m) => evaluateMetric(m, metrics[m], V13_THRESHOLDS[m]));
  const degradation = decideDegradation({
    // 同名多控件 = AMBIGUOUS_TARGET 的实机证据，落成正式错误状态（先重抓快照，不误点/不转视觉）。
    refBindingCheck: duplicates.length > 0
      ? { ok: false, code: "AMBIGUOUS_TARGET" } : null,
    keyControlCoverage: metrics[V13_METRICS.KEY_CONTROL_COVERAGE],
    selfElectron: opts.selfElectron === true,
  });

  return {
    ok: true,
    capturedAt: opts.capturedAt || null,
    elapsedMs: Number.isFinite(opts.elapsedMs) ? opts.elapsedMs : null,
    source: opts.source || null,
    coverage,
    ambiguousLabels: duplicates,
    /* V-13 五项指标 / 阈值 / 降级裁决（S4）：报告据此回答"该不该脱离视觉循环"。 */
    v13: { metrics, thresholds: V13_THRESHOLDS, evaluated, degradation },
    /* agent-desktop v1.1.0：旧快照 ref 与同名多控件一律 AMBIGUOUS_TARGET。
     * 这里把「同名标签」如实列出，供封装层决定是否要 (平台,快照id,ref,工具版本) 四元组。 */
    refBindingNeeded: duplicates.length > 0 || anonymous > 0,
    caveats: [
      "单次快照，不代表所有应用/窗口状态；最小化的窗口树通常为空壳",
      "匿名窗口（name=\"\"）无法用标题做稳定身份，必须靠 snapshotId + ref 绑定",
      "耗时未由采集接口返回精确毫秒值，elapsedMs 保持 null，不补零",
    ],
  };
}

function toMarkdown(r) {
  const c = r.coverage;
  const L = [];
  L.push("# V-13 实机 UIA 探针报告（2026-11-07）");
  L.push("");
  L.push(`- 采集方式：${r.source || "windows-mcp Snapshot(use_ui_tree=true, use_vision=false)"}`);
  L.push(`- 采集时间：${r.capturedAt || "2026-11-07 18:10 GMT+8"}`);
  L.push(`- 耗时：${r.elapsedMs === null ? "**未取得精确毫秒值（不补零）**" : r.elapsedMs + " ms"}`);
  L.push("");
  L.push("## 树完整度（只报能直接数出来的量）");
  L.push("");
  L.push("| 指标 | 实测 |");
  L.push("|---|---|");
  L.push(`| 窗口节点 | ${c.windowCount} |`);
  L.push(`| 具名窗口 | ${c.namedWindows} |`);
  L.push(`| 匿名窗口（name=\"\"） | ${c.anonymousWindows} |`);
  L.push(`| 具名占比 | ${c.namedRatio} |`);
  L.push(`| 带坐标的可操作控件 | ${c.actionableNodes} |`);
  L.push(`| 其中带 action 标记 | ${c.withAction} |`);
  L.push(`| 树最大深度 | ${c.maxDepth} |`);
  L.push("");
  L.push("## 同名控件 / 歧义风险");
  L.push("");
  if (r.ambiguousLabels.length === 0) {
    L.push("本次快照未出现同名标签控件；但**匿名窗口仍有 " + c.anonymousWindows + " 个**，仍不能省掉 ref 绑定。");
  } else {
    L.push("| 标签 | 出现次数 |");
    L.push("|---|---|");
    for (const d of r.ambiguousLabels) L.push(`| ${d.label.replace(/\|/g, "\\|")} | ${d.n} |`);
  }
  L.push("");
  /* S4：V-13 五项指标 + 降级阈值 + 脱离视觉循环裁决。 */
  if (r.v13) {
    const { metrics, thresholds, evaluated, degradation } = r.v13;
    L.push("## V-13 五项指标与降级阈值（S4）");
    L.push("");
    L.push("| 指标 | 实测 | 阈值 | 判定 |");
    L.push("|---|---|---|---|");
    const label = {
      treeFetchSuccessRate: "① 树获取成功率", keyControlCoverage: "② 关键控件语义覆盖",
      refStability: "③ ref 稳定性", prePostStateChangeRate: "④ 操作前后状态变化",
      dangerConfirmVisibility: "⑤ 危险确认元素可见性",
    };
    for (const e of evaluated) {
      const v = e.value === null ? "**未采到（不补零）**" : String(e.value);
      L.push(`| ${label[e.metric] || e.metric} | ${v} | ${e.threshold} | ${e.status} |`);
    }
    L.push("");
    L.push(`- 降级裁决：\`code=${degradation.code}\` / \`degradeTo=${degradation.degradeTo}\` / \`enterVisual=${degradation.enterVisual}\``);
    L.push(`- ${degradation.reason}`);
    L.push(`- **明确不接回 runVision()**：降级时 \`enterVisual=false\`，视觉循环预算耗尽或自属界面一律走降级/人工。`);
    L.push("");
  }

  L.push("## 结论");
  L.push("");
  L.push(`- \`refBindingNeeded = ${r.refBindingNeeded}\`：${r.refBindingNeeded
    ? "必须绑定 (平台, 快照 id, ref, 工具版本) 四元组，不能只靠标题或坐标。"
    : "本次样本未触发绑定条件，但按 v1.1.0 口径仍应默认绑定。"}`);
  L.push("- 与 11-07 简报 §1 一致：Windows/Linux 旧快照 ref 与同名多控件一律 `AMBIGUOUS_TARGET`；无快照表面返回 `PLATFORM_NOT_SUPPORTED`。");
  L.push("- 已落地：`orb/refBinding.mjs` 提供四元组绑定与校验，`anchorResolver.mjs` 新增三类错误码并提供 `normalizeElementRefWithBinding()` / `checkRefBinding()`。");
  L.push("");
  L.push("## 边界（如实记录）");
  L.push("");
  for (const x of r.caveats) L.push(`- ${x}`);
  L.push("- 本次只取了桌面根树 + 任务栏，未对具体应用窗口逐个展开；「常见 app 树完整度」的完整矩阵仍待后续逐窗采集。");
  L.push("");
  return L.join("\n");
}

export { toMarkdown };

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN && file) {
  const raw = fs.readFileSync(path.resolve(file), "utf8");
  const r = analyzeUiTree(raw, {
    elapsedMs: elapsedArg ? Number(elapsedArg.split("=")[1]) : undefined,
    source: "windows-mcp Snapshot(use_vision=false, use_ui_tree=true, use_annotation=false, use_dom=false)",
    capturedAt: "2026-11-07 18:10 GMT+8",
  });
  console.log(asJson ? JSON.stringify(r, null, 2) : toMarkdown(r));
}

export default { analyzeUiTree, toMarkdown };
