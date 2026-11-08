#!/usr/bin/env node
/* 一键全量验收（verify-all）。
 *
 * 之前六个检查全靠手敲 `node tools/xxx`，问题不是麻烦，是**漏跑**：
 * 改一处只跑单测、忘了跑打包闭包，等发布出去才发现新模块没进清单。
 * 所以这里把验收口径固化成一条命令，顺序也固定下来 —— 越便宜、越容易失败的排前面。
 *
 * 用法：
 *   node orb/tools/verify-all.mjs              # 全套（含 Electron 面板运行时冒烟）
 *   node orb/tools/verify-all.mjs --no-runtime # 跳过 Electron（没装/没显示环境时用）
 *   node orb/tools/verify-all.mjs --only test,pack
 * 退出码 0 = 全过；1 = 有失败（会打印是哪一步、最后 30 行输出）。
 *
 * 刻意不做的事：不自动修、不自动重试。哪一步红了就停在那一步的输出上，
 * 「自动重试直到绿」只会把偶发问题藏起来。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ORB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const noRuntime = argv.includes("--no-runtime");
const onlyArg = (argv.find((a) => a.startsWith("--only")) || "").split("=")[1]
  || (argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : "");
const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim()).filter(Boolean)) : null;

/* name 用短名（--only 里写它）；label 是给人看的中文说明。 */
const STEPS = [
  { name: "test", label: "单元测试（全部 *.test.mjs）", cmd: process.execPath, args: ["--test", "test/*.test.mjs"], mustMatch: /^\s*[ℹ#]\s*fail 0\s*$/m },
  { name: "pack", label: "打包闭包（清单 ↔ 实际依赖）", cmd: process.execPath, args: ["tools/check-pack-closure.mjs"], mustMatch: /PACK_CLOSURE OK/ },
  { name: "panel", label: "面板静态自检（语法 / id / 硬编码色）", cmd: process.execPath, args: ["tools/check-panel.mjs"], mustMatch: /PANEL_OK/ },
  { name: "registry", label: "注册表文档与源码一致", cmd: process.execPath, args: ["tools/gen-registry-doc.mjs", "--check"], mustMatch: /REG_OK/ },
  { name: "caps", label: "急停豁免清单文档一致", cmd: process.execPath, args: ["tools/gen-capabilities-doc.mjs", "--check"], mustMatch: /CAP_OK/ },
  { name: "smoke", label: "自动化 API 冒烟（真起桥）", cmd: process.execPath, args: ["tools/smoke-automation-api.mjs"], mustMatch: /SMOKE pass=\d+ fail=0/ },
  /* 接线审计：跨 4 层的每一处「少一行」，静态扫一遍就能拦住。
     --strict 会在遇到审查过的冗余面时失败，发布门禁用默认模式即可。 */
  { name: "wiring", label: "接线审计（preload↔主进程↔桥↔ops）", cmd: process.execPath, args: ["tools/wiring-audit.mjs"], mustMatch: /WIRING_AUDIT_OK/ },
  { name: "memory", label: "记忆引擎接线冒烟（临时目录真跑）", cmd: process.execPath, args: ["tools/memory-wiring-smoke.mjs"], mustMatch: /MEMORY_WIRING_SMOKE_OK/ },
  { name: "runtime", label: "面板运行时冒烟（真起 Electron）", cmd: process.execPath, args: ["tools/panel-runtime-smoke.cjs"], mustMatch: /PANEL_RUNTIME_OK/, skip: noRuntime, skipWhy: "--no-runtime" },
];

function run(step) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const cp = spawn(step.cmd, step.args, {
      cwd: ORB,
      /* 子进程的彩色输出在管道里只是乱码，一律关掉，靠 mustMatch 判成败。 */
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
      shell: false,
    });
    let out = "";
    cp.stdout.on("data", (b) => { out += b.toString(); });
    cp.stderr.on("data", (b) => { out += b.toString(); });
    cp.on("error", (e) => resolve({ code: -1, out: out + "\n" + String(e?.message ?? e), ms: Date.now() - t0 }));
    cp.on("close", (code) => resolve({ code, out, ms: Date.now() - t0 }));
  });
}

const tail = (s, n = 30) => s.split(/\r?\n/).filter(Boolean).slice(-n).join("\n");

const results = [];
for (const step of STEPS) {
  if (only && !only.has(step.name)) continue;
  if (step.skip) {
    results.push({ ...step, ok: true, skipped: true, ms: 0 });
    console.log(`SKIP  ${step.label}（${step.skipWhy}）`);
    continue;
  }
  process.stdout.write(`RUN   ${step.label} … `);
  const r = await run(step);
  /* 双条件：退出码 0 **且**出现预期标记。只看退出码会漏掉"脚本自己吞了异常还退出 0"
     这种（这类脚本里本就有 catch 分支），只看标记会漏掉最后才崩的情况。 */
  const ok = r.code === 0 && step.mustMatch.test(r.out);
  results.push({ ...step, ok, ms: r.ms, out: r.out });
  console.log(ok ? `OK (${(r.ms / 1000).toFixed(1)}s)` : `FAIL (exit ${r.code}, ${(r.ms / 1000).toFixed(1)}s)`);
  if (!ok) {
    console.log("------ 最后 30 行输出 ------");
    console.log(tail(r.out));
    console.log("---------------------------");
  }
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
const total = results.reduce((a, r) => a + r.ms, 0);
console.log("");
console.log(`共 ${results.length - skipped.length} 项：通过 ${results.length - skipped.length - failed.length}`
  + `，失败 ${failed.length}${skipped.length ? `，跳过 ${skipped.length}` : ""}，用时 ${(total / 1000).toFixed(1)}s`);
if (failed.length) {
  console.log("失败项：" + failed.map((r) => r.name).join(", "));
  process.exit(1);
}
console.log("VERIFY_ALL OK");
