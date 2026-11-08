/**
 * #200 重启后一键自检。
 *
 * 把「重启控制台后目视确认」里能自动化的部分全部自动化，只把真正需要人眼的
 * 像素项留给人工。不启动 GUI、不重启控制台、不发网络请求（--probe 才可选探桥）。
 *
 * 复用 verify-storage-flat.mjs 的 16 项数据链路验证，避免重复实现。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyStorage } from "./verify-storage-flat.mjs";
import { scanLegacy, matchCopies } from "./retire-legacy-artifacts.mjs";
import { checkClosure } from "./check-pack-closure.mjs";
import { FORMATS } from "../outputProfile.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KINDS = ["recordings", "screenshots", "vidx", "exports", "archive", "misc"];

/** 必须人眼确认、脚本无法替代的部分（诚实列出，不假装覆盖）。 */
export const VISUAL_ONLY = Object.freeze([
  "产物浮层的实际渲染：卡片位置、动效、图标、深浅主题配色",
  "输入框下方运行条的实时秒数与流式文字刷新",
  "安全页影子路由观测卡片在真实数据下的排布",
  "成功/中止/失败三类收尾的台词与音效是否符合预期",
]);

export async function runSelfCheck(opts = {}) {
  const {
    statePath = path.join(ROOT, "desktop/.orbdata/orb-state.json"),
    rootOverride = null,
    fsImpl = fs,
    probeBridge = false,
    fetchImpl = globalThis.fetch,
  } = opts;
  const checks = [];
  const add = (name, ok, detail, skip = false) => checks.push({ name, ok: !!ok, skip, detail: String(detail ?? "") });

  let storage;
  try {
    storage = verifyStorage({ statePath, fsImpl, pathImpl: path });
    for (const c of storage.checks) add("存储/浮层数据链路 · " + c.name, c.ok, c.detail);
  } catch (e) {
    add("存储/浮层数据链路", false, String(e?.message ?? e));
    storage = { ok: false, storageRoot: null, caveats: [] };
  }
  const root = rootOverride || storage.storageRoot;

  /* 导出格式：13 种，且 Office 三件套必须在位。 */
  const office = ["docx", "xlsx", "pptx"];
  add("导出格式清单 13 种", FORMATS.length === 13, FORMATS.join(","));
  add("Office 三件套已登记", office.every((f) => FORMATS.includes(f)), office.join(","));

  /* 便携版打包闭包：漏一个叶子模块发布版就会 ERR_MODULE_NOT_FOUND。 */
  try {
    const c = checkClosure();
    add("打包闭包无漏登记", c.ok, `清单 ${c.listed} / 可达 ${c.reachable} / 依赖边 ${c.edges}` +
      (c.missing.length ? " / 缺失: " + c.missing.join(",") : ""));
  } catch (e) { add("打包闭包无漏登记", false, String(e?.message ?? e)); }

  /* 旧 artifacts 退役状态：只读 dry-run，不删。 */
  if (root && fsImpl.existsSync(root)) {
    try {
      const scan = scanLegacy(root, { fsImpl, pathImpl: path });
      const m = matchCopies(scan, { fsImpl, pathImpl: path, kinds: KINDS });
      add("旧 artifacts 副本核对", m.unsafe.length === 0,
        `${scan.files.length} 个文件 / 可删 ${m.safe.length} / 拒删 ${m.unsafe.length}（未执行删除）`);
    } catch (e) { add("旧 artifacts 副本核对", false, String(e?.message ?? e)); }
  } else {
    add("旧 artifacts 副本核对", false, "存储根不可用，跳过核对");
  }

  /* 桥存活探测：控制台可能本来就没开，不通只记 SKIP，不算失败。 */
  if (probeBridge && typeof fetchImpl === "function") {
    try {
      const r = await fetchImpl("http://127.0.0.1:19387/api/status", { signal: AbortSignal.timeout(1500) });
      add("桥 19387 可达", !!r.ok, "HTTP " + r.status);
      if (typeof r.body?.cancel === "function") await r.body.cancel().catch(() => {});
    } catch (e) {
      add("桥 19387 可达", true, "未启动，记为 SKIP：" + String(e?.message ?? e), true);
    }
  } else {
    add("桥 19387 可达", true, "未探测（加 --probe 才探）；控制台当前可未启动", true);
  }

  const effective = checks.filter((c) => !c.skip);
  return {
    ok: effective.every((c) => c.ok),
    checks,
    passed: effective.filter((c) => c.ok).length,
    failed: effective.filter((c) => !c.ok).length,
    skipped: checks.filter((c) => c.skip).length,
    visualOnly: [...VISUAL_ONLY],
    storageRoot: root,
    note: "自检不启动 GUI、不重启控制台、不改任何用户文件。",
  };
}

export function toMarkdown(r) {
  const L = ["# 重启后一键自检报告", "", `- 存储根：\`${r.storageRoot || "(未配置)"}\``,
    `- 结论：**${r.ok ? "PASS" : "FAIL"}**（通过 ${r.passed} / 失败 ${r.failed} / 跳过 ${r.skipped}）`,
    "", r.note, "", "## 检查项", ""];
  for (const c of r.checks) L.push(`- ${c.skip ? "⏭ SKIP" : c.ok ? "✔ PASS" : "✘ FAIL"} **${c.name}** — ${c.detail}`);
  L.push("", "## 仍需人眼确认（脚本无法替代）", "");
  for (const v of r.visualOnly) L.push(`- [ ] ${v}`);
  return L.join("\n") + "\n";
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  runSelfCheck({ probeBridge: process.argv.includes("--probe") }).then((r) => {
    process.stdout.write(toMarkdown(r));
    if (!r.ok) process.exitCode = 1;
  });
}
