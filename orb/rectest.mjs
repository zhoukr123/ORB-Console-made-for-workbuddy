/* ---------------- 录屏模块实机验证（rectest） ----------------
 *
 * 分两层，因为这两类问题的发现成本差一个数量级：
 *
 *   **静态层**（默认跑，秒级）：文件在不在、打包清单有没有漏、MP4 结不结构完整、
 *   recbar 的 IPC 契约有没有被改坏。这些都属于"改了一行、发布版炸掉"的类型。
 *
 *   **实机层**（--live）：真拉起 Electron，走 **产品同一条** cap-native 链路
 *   录 3 秒区域视频、收尾、校验 moov/时长。DXGI 拿不到帧、MF 编码器起不来、
 *   helper 退出时没写 moov —— 这三类只有真机才暴露，mock 一条都测不出来。
 *
 * 用法：
 *   node orb/rectest.mjs           静态检查
 *   node orb/rectest.mjs --live    静态 + 实机（会短暂弹出一个 Electron 进程）
 *   node orb/rectest.mjs --json    只输出 JSON（给上层脚本消费）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DESKTOP = path.join(HERE, "desktop");

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const JSON_ONLY = args.includes("--json");

const results = [];
const ok = (name, detail = "") => results.push({ level: "ok", name, detail });
const bad = (name, detail = "") => results.push({ level: "bad", name, detail });
const warn = (name, detail = "") => results.push({ level: "warn", name, detail });
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const line = (s) => (JSON_ONLY ? "" : console.log(s));

/* ================= 静态层 ================= */

function staticChecks() {
  /* ① 原生组件：缺失不致命（面板会回落 MediaRecorder），但发布版就白丢原生 mp4，
   *    而且只有真去录一段才看得出来 —— 所以这里必须报。 */
  const exe = path.join(HERE, "native", "dist", "orb-cap.exe");
  if (exists(exe) && fs.statSync(exe).size > 100000) ok("原生组件 orb-cap.exe", Math.round(fs.statSync(exe).size / 1024) + " KB");
  else bad("原生组件 orb-cap.exe", "缺失或体积异常：" + exe);

  /* ② 打包清单：录屏链路的文件漏一个 = 发布版静默失效，开发态完全正常。 */
  const pack = fs.readFileSync(path.join(HERE, "pack.cjs"), "utf8");
  const need = ["cap-native.js", "mp4finalize.js", "recbar.html", "recbar-preload.js", "region.html", "region-preload.js", "storage.js", "attach-probe.js"];
  const missing = need.filter((f) => !pack.includes(`'${f}'`));
  check(missing.length === 0, "打包清单包含录屏/附件链路", missing.length ? "缺：" + missing.join(", ") : need.length + " 项齐全");

  /* ③ IPC 契约：面板与主进程用字符串通道对接，改一边漏一边不会编译报错，
   *    只会表现为"点了没反应"。这里从两侧同时抓，缺哪边都能指出来。 */
  const mainSrc = fs.readFileSync(path.join(DESKTOP, "main.js"), "utf8");
  const preloadSrc = fs.readFileSync(path.join(DESKTOP, "preload.js"), "utf8");
  const panelSrc = fs.readFileSync(path.join(DESKTOP, "panel.html"), "utf8");
  const preloadNeed = ["capNativeStart", "capNativeStop", "capNativeCmd", "onRecCmd", "sendRecBarEvent", "pickAttachments", "onAttachProbed"];
  const pMiss = preloadNeed.filter((k) => !preloadSrc.includes(k));
  check(pMiss.length === 0, "preload 暴露录屏/附件方法", pMiss.length ? "缺：" + pMiss.join(", ") : preloadNeed.length + " 项齐全");

  const mainNeed = ["cap-native-start", "cap-native-stop", "cap-native-cmd", "cap-open", "cap-chunk", "cap-close", "rec-cmd-to-bar", "rec-bar-cmd", "attach-probe"];
  const mMiss = mainNeed.filter((k) => !mainSrc.includes(k));
  check(mMiss.length === 0, "主进程注册 IPC 通道", mMiss.length ? "缺：" + mMiss.join(", ") : mainNeed.length + " 项齐全");

  const panelNeed = ["capNativeStart", "capNativeStop", "onRecCmd", "capRegionPick", "CaptureController"];
  const panMiss = panelNeed.filter((k) => !panelSrc.includes(k));
  check(panMiss.length === 0, "面板引用录屏链路", panMiss.length ? "缺：" + panMiss.join(", ") : panelNeed.length + " 项齐全");

  /* ④ 控制条契约：recbar 通过 preload 的 5 个方法通信，少一个等于按钮失灵。 */
  const barPre = fs.readFileSync(path.join(DESKTOP, "recbar-preload.js"), "utf8");
  const barNeed = ["sendBarCmd", "onRecEvent", "onRecCfg", "setClickThrough", "onRecHover"];
  const bMiss = barNeed.filter((k) => !barPre.includes(k));
  check(bMiss.length === 0, "控制条 preload 契约", bMiss.length ? "缺：" + bMiss.join(", ") : barNeed.length + " 项齐全");

  /* ⑤ 真实产物结构校验：拿最近一段录屏（或任意 mp4）走一遍 mp4finalize。
   *    这是唯一能验证"moov 写全了没有"的静态手段。 */
  const mp4finalize = require(path.join(DESKTOP, "mp4finalize.js"));
  const dirs = [path.join(ROOT, "recordings"), path.join(DESKTOP, "..", "..", "recordings")];
  let sample = null;
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const files = fs.readdirSync(d).filter((f) => f.toLowerCase().endsWith(".mp4"));
    if (!files.length) continue;
    const withStat = files.map((f) => ({ f: path.join(d, f), t: fs.statSync(path.join(d, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    sample = withStat[0].f;
    break;
  }
  if (!sample) {
    warn("MP4 结构校验", "recordings/ 下没有 mp4，跳过（先随便录一段再跑）");
  } else {
    const info = mp4finalize.inspectFile(sample);
    const name = path.basename(sample);
    if (info.ok) ok("MP4 结构校验", `${name}：ftyp+moov 齐全，时长 ${(info.durationMs / 1000).toFixed(1)}s，${Math.round(info.size / 1024 / 1024)}MB`);
    else bad("MP4 结构校验", `${name}：${info.error || "结构不完整"}`);
    if (info.durationMs === 0) warn("MP4 时长字段", "mvhd.duration 为 0（播放器会显示 0 秒，需要 patchDuration）");
  }

  /* ⑥ 录制目录可写：不可写的时候产品表现是"点了录制没反应"，日志里才有 EACCES。 */
  try {
    const t = path.join(ROOT, "recordings", `.rectest-${Date.now()}.tmp`);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, "x");
    fs.unlinkSync(t);
    ok("录制目录可写", path.dirname(t));
  } catch (e) {
    bad("录制目录可写", e.message);
  }
}

/* ================= 实机层 ================= */

async function liveCheck() {
  const electron = path.join(DESKTOP, "node_modules", "electron", "dist", "electron.exe");
  if (!exists(electron)) {
    bad("实机验证：Electron 不可用", "找不到 " + electron);
    return;
  }
  const reportPath = path.join(ROOT, "cache", `rectest-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  try { fs.unlinkSync(reportPath); } catch {}

  const env = { ...process.env, ORB_RECTEST: reportPath };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ORB_NO_PROTECT;          // 自检要看真实成品，别把自家窗口排除逻辑关掉

  line("  · 拉起 Electron（约 8~15 秒）…");
  const child = spawn(electron, [DESKTOP], { cwd: DESKTOP, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d.toString(); });
  child.stderr.on("data", (d) => { out += d.toString(); });

  const deadline = Date.now() + 60000;
  let report = null;
  while (Date.now() < deadline) {
    await sleep(500);
    if (exists(reportPath)) {
      try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); } catch {}
      if (report) break;
    }
    if (child.exitCode != null && child.exitCode !== 0) break;
  }
  try { child.kill(); } catch {}

  if (!report) {
    bad("实机验证：未产出报告", `60 秒内没有生成 ${reportPath}\n${out.slice(-800)}`);
    return;
  }

  line("  · 步骤：" + report.steps.join(" → "));
  check(report.ok === true, "实机：录制并收尾成功", report.error || `${report.size} 字节 / ${report.ms}ms`);
  if (report.inspect) {
    check(report.inspect.ok === true, "实机：成片结构合法",
      `ftyp=${report.inspect.hasFtyp} moov=${report.inspect.hasMoov} 时长=${report.inspect.durationMs}ms`);
  } else {
    bad("实机：成片结构合法", "没有 inspect 结果（很可能没落盘）");
  }
  if (report.size) check(report.size > 1024, "实机：文件非空", report.size + " 字节");
  if (report.patched) {
    check(report.patched.ok === true, "实机：时长回填", `patched=${report.patched.patched} 原因=${report.patched.reason || "-"}`);
  }
  /* 关键回归点：3 秒的片子，实际帧数应接近 30fps × 3s。
   * 这里只用 stop() 回报的时长做一次"量级检查"，不追求精确 —— 目的是发现
   * "DXGI 复制根本没跑（拿到 0 帧）"这种整段失效。 */
  if (report.ms) check(report.ms > 1500, "实机：实际录制时长合理", report.ms + "ms（期望 ≈3000ms）");
  if (report.file && exists(report.file)) ok("实机：产物路径可访问", report.file);
  else bad("实机：产物路径可访问", report.file || "(空)");
}

/* ================= 主流程 ================= */

line("== ORB 录屏模块自检 ==");
line("[静态层]");
staticChecks();

if (LIVE) {
  line("[实机层]");
  await liveCheck();
}

const bads = results.filter((r) => r.level === "bad");
const warns = results.filter((r) => r.level === "warn");
const oks = results.filter((r) => r.level === "ok");

if (JSON_ONLY) {
  console.log(JSON.stringify({ ok: bads.length === 0, results }, null, 2));
} else {
  for (const r of results) {
    const mark = r.level === "ok" ? "✓" : (r.level === "warn" ? "⚠" : "✗");
    line(`  ${mark} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  line("");
  line(`通过 ${oks.length} · 失败 ${bads.length} · 环境受限 ${warns.length}`);
}
process.exit(bads.length ? 1 : 0);
