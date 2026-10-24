/* ---------------- Snipaste 调用接口（第一档：不自研，调本机 Snipaste） ----------------
 * 为什么是「调用」而不是「自己做」：Snipaste 是成熟的商业免费软件（闭源），
 * 框选/标注/贴图这套交互自研成本极高且体验追不上。第一档方案的边界：
 *   ORB 只做三件事 —— 检测装没装、唤起它、把截图落到 ORB 的「截屏分区」。
 *   框选体验完全交给 Snipaste，用户原有的使用习惯不变。
 *
 * 关键事实全部来自本机 2.11.3 二进制内嵌帮助与实测，不是猜的：
 *   ① CLI 子命令（snip 等）**只在 Snipaste 已后台运行时生效**（帮助原话：
 *      "except for commands marked with a `*`, the commands will only be
 *      effective if Snipaste is already running"）。所以必须两步走：
 *      先确保进程在，再发 `snip`；直接对冷实例发命令会静默失败。
 *   ② `-o FILE_NAME` 在免费版可用（帮助里加粗的是 PRO 限定项：ocr_clipboard /
 *      no-auto-save / silent；FILE_NAME / quick-save 不在其列）。
 *      "Support using variables" —— 但 ORB 自己算时间戳传绝对路径更稳，
 *      不依赖 Snipaste 的变量语法。
 *   ②b ⚠️⚠️ **命令里绝不能带 `-o`**（2026-10-24 实测纠正，代价很大）：
 *      带 `-o` = 走「无人值守输出」路径 —— 选区一确定就立刻存盘退出，
 *      **标注工具栏整个被绕开**（用户实测：框选完直接保存、没有工具栏，
 *      "二次截取"也用不了）。而 `--hold`（本意是「等用户标注完再退出」）
 *      **是 PRO 专属功能** —— 二进制内嵌更新日志原文：
 *      "v2.11 … [PRO] New command line option: `--hold`, enabling annotation
 *      before saving when snipping with specified output."
 *      免费个人版**静默忽略**它，于是 `-o FILE` 退化成纯自动保存。
 *      （官方 CLI 文档里根本没列 `--hold`，正好印证它是未公开的 PRO 项。）
 *      → 所以 ORB 现在发的是**裸 `snip`**：与用户按 F1 完全同一条路径。
 *
 *   ②c ★ 裸 `snip` 的完整实测行为（本机 Snipaste 2.11.3，2026-10-24 全流程）：
 *      ① 框选松手 → 出现 427×33 的**标注工具栏**（13 个按钮：矩形/箭头/铅笔/
 *         高亮/橡皮/马赛克/文本/吸管/撤销/重做/删除/复制/贴图），
 *         可改选区、划线、二次裁剪 —— 用户要的「二次截取后显示工具栏」达成。
 *      ② 此刻剪贴板**是空的** —— Snipaste 不自动复制，等用户点「复制」。
 *      ③ 点「复制」→ Snipaste 全部可见窗口消失 + **剪贴板写入 PNG**。
 *      ⇒ 产物走剪贴板，由 main.js 监听剪贴板变化落盘（见 main.js 的
 *         watchSnipClipboard），并用「剪贴板出现新图」作为完成信号。
 *      ④ 用户放弃（Esc / 关掉 Snipaste）→ 剪贴板始终无新图 → 判取消，不落盘。
 *
 *   ②d ★ Snipaste 的窗口形态（2026-10-24 用窗口枚举器逐个查证）：
 *      这条不是给 Snipaste 调用用的，是给 main.js 判断「用户是不是正在
 *      截屏」用的（判据返工过三次，见 orb-foreground.c 的 enum_snip 注释）。
 *      实测（干净启动 vs 框选中 vs 标注栏在）：
 *        · `Snipper - Snipaste`  全屏     class Qt624QWindowToolSaveBits
 *          ← **框选浮层**。⚠️ 它的 hwnd 在**冷启动时就存在**（空闲时是 1×1
 *            且 IsWindowVisible=0），框选时同一个 hwnd 变成全屏可见。
 *            所以「hwnd 集合有没有变化」这种判据是错的。
 *        · `Snipaste`             169×221  class Qt624QWindowToolSaveBits
 *          ← **主面板**（用户点托盘图标弹出的那个），与截屏会话无关，
 *            但它**一直可见** —— 早期判据把它算进去，导致"正在截屏"恒为真。
 *        · 标注工具栏            427×33   class Qt624QWindowIcon
 *          ← 框选完成后弹出的那条，类名与上面两个**不同**。
 *      结论：判据 = 存在属于 Snipaste 的可见顶层窗口，且**排除主面板**
 *      （标题 "Snipaste" 且类名带 ToolSaveBits）。
 *      空闲 → false；框选中 → true；标注栏在 → true；按 Esc 后 → false。
 *      调用方靠 **true → false 的跳变**判断用户取消，不是靠绝对值。
 *
 *   ③ 文件名带空格没关系：spawn 不走 shell，argv 原样传递，不需要引号转义。
 *   ④ 安装形态两种都要认：Microsoft Store 版（%LOCALAPPDATA%\Microsoft\WindowsApps
 *      下的应用执行别名，0 字节重解析点）与桌面版（Program Files / 用户目录）。
 *   ⑤ **Store 别名不能用 existsSync 判存在**（本机实测 2026-10-22，血泪坑）：
 *      别名是 IO_REPARSE_TAG_APPEXECLINK 重解析点，fs.statSync 跟随它会解析到
 *      ACL 保护的 C:\Program Files\WindowsApps\...\Snipaste.exe → EACCES →
 *      existsSync 返回 false（而 accessSync(X_OK) 却能过，同一文件两种结论，别信前者）。
 *      但 spawn 走 CreateProcess，内核的 appexec 链接处理能正常拉起它。
 *      所以安装探测必须分层：标准路径 existsSync（桌面版）→ where.exe（PATH 搜索，
 *      能解析别名）→ 注册表 App Paths → 运行中进程路径（WMI）。注册表/进程拿到的是
 *      WindowsApps 真实路径，普通用户 spawn 它会 EACCES，要先换算成别名再启动。
 *
 * 截图落点：<存储根>/screenshots（storage.pathOf('screenshots')）。
 * 这样即使用户把存储根改到 D 盘，截图也跟着走，不散在 Snipaste 自己的目录里。
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");

/* 宿主上下文（由 main.js 注入，理由同 storage.js：避免 require 环）。 */
let ctx = {
  getState: () => ({}),
  pathOf: () => "",
  log: () => {},
};

function init(next) {
  if (!next || typeof next !== "object") return;
  ctx = {
    getState: typeof next.getState === "function" ? next.getState : ctx.getState,
    pathOf: typeof next.pathOf === "function" ? next.pathOf : ctx.pathOf,
    log: typeof next.log === "function" ? next.log : ctx.log,
  };
}

function note(...args) {
  try { ctx.log("[snipaste]", ...args); } catch { /* 日志绝不能反咬调用方 */ }
}

function errText(e) {
  return (e && e.message) ? e.message : String(e);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* 最近一次成功唤起截屏的时刻。划词监听要靠它避开"截屏进行中"的窗口期：
   截屏框选同样是「拖拽 + 松手」，会被划词当成一次文本选中，而划词注入的
   Ctrl+C 在 Snipaste 里等于「复制并退出」—— 用户正在标注的截屏会被按死。
   主进程用 launchedRecently(ms) 判断，这里只负责记时间。 */
let lastLaunchAt = 0;

/** 刚刚（ms 毫秒内）唤起过截屏？ */
function launchedRecently(ms) {
  return lastLaunchAt > 0 && (Date.now() - lastLaunchAt) < (ms || 8000);
}

/** 已知安装位置（桌面版标准落点）。Store 别名也在列表里，但存在性不能靠 existsSync 判（见头部 ⑤）。 */
function candidates() {
  const local = process.env.LOCALAPPDATA || "";
  const out = [];
  if (local) out.push({ file: path.join(local, "Microsoft", "WindowsApps", "Snipaste.exe"), source: "store" });
  out.push({ file: path.join(process.env.ProgramW6432 || "C:\\Program Files", "Snipaste", "Snipaste.exe"), source: "desktop" });
  out.push({ file: path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Snipaste", "Snipaste.exe"), source: "desktop" });
  if (local) out.push({ file: path.join(local, "Snipaste", "Snipaste.exe"), source: "desktop" });
  return out;
}

/** 快径：标准桌面位置里找真实存在的可执行文件。Store 别名在这里会误判为不存在（EACCES），靠后面的层补。 */
function findInstall() {
  for (const c of candidates()) {
    try {
      if (fs.existsSync(c.file) && fs.statSync(c.file).isFile()) return c;
    } catch { /* 单个候选读不了就继续看下一个 */ }
  }
  return null;
}

/** 跑一个短命探针命令，绝不抛。windowsHide + 超时，探针失败只当「没查到」。 */
function runTool(file, args, timeout = 4000) {
  return new Promise((resolve) => {
    try {
      execFile(
        file, args,
        { windowsHide: true, timeout, maxBuffer: 1 << 20 },
        (err, stdout) => resolve({ ok: !err, stdout: String(stdout || "") })
      );
    } catch { resolve({ ok: false, stdout: "" }); }
  });
}

/** where.exe 走 PATH 搜索 —— 能解析 WindowsApps 应用执行别名（本机主力形态）。 */
async function whereSnipaste() {
  const r = await runTool("where", ["Snipaste"]);
  if (!r.ok) return "";
  for (const line of r.stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (/snipaste\.exe$/i.test(t)) return t;
  }
  return "";
}

/** 注册表 HKCU\...\App Paths\Snipaste.exe（桌面安装器会写；Store 版有时也有）。 */
async function regSnipaste() {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Snipaste.exe";
  const r = await runTool("reg", ["query", key, "/ve"]);
  if (!r.ok) return "";
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i);
    if (m && /snipaste\.exe$/i.test(m[1].trim())) return m[1].trim();
  }
  return "";
}

/** 已经在跑 → 问 WMI 要进程真实路径（Store 版拿到的是 ACL 保护路径，只能证明"装了"）。 */
async function procPath() {
  const ps = "Get-CimInstance Win32_Process -Filter \"name='Snipaste.exe'\" | Select-Object -First 1 -ExpandProperty ExecutablePath";
  const r = await runTool("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], 6000);
  if (!r.ok) return "";
  const t = r.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => /snipaste\.exe$/i.test(s));
  return t || "";
}

/** WindowsApps 真实路径 → 应用执行别名：普通用户唯一 spawn 得动的形态。 */
function toAlias(p) {
  const local = process.env.LOCALAPPDATA || "";
  const alias = local ? path.join(local, "Microsoft", "WindowsApps", "Snipaste.exe") : p;
  return /[\\/]WindowsApps[\\/][^\\/]+[\\/]Snipaste\.exe$/i.test(p) ? alias : p;
}

/**
 * 分层找 Snipaste，任一命中即算装了。返回 { file, source, running? } ——
 * file 一定是「能 spawn 的形态」；全都空手返回 null。
 *   ① 标准桌面位置 existsSync（快径，桌面版）
 *   ② where.exe（PATH，认 Store 别名）
 *   ③ 注册表 App Paths（含把真实路径换算成别名）
 *   ④ 运行中进程路径（WMI，只证明"装了"）
 */
async function resolveInstall() {
  const fast = findInstall();
  if (fast) return fast;
  const w = await whereSnipaste();
  if (w) return { file: w, source: /WindowsApps/i.test(w) ? "store-alias" : "desktop" };
  const r = await regSnipaste();
  if (r) return { file: toAlias(r), source: /WindowsApps/i.test(r) ? "store-alias" : "desktop" };
  const p = await procPath();
  if (p) return { file: toAlias(p), source: /WindowsApps/i.test(p) ? "store-alias" : "process", running: true };
  return null;
}

/** 进程是否在跑。tasklist 查不到一律当「没跑」—— 宁可多重一次启动，也不能误报成在跑。 */
function isRunning() {  return new Promise((resolve) => {
    execFile(
      "tasklist",
      ["/FI", "IMAGENAME eq Snipaste.exe", "/NH"],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(/snipaste\.exe/i.test(String(stdout || "")));
      }
    );
  });
}

/** 时间戳文件名：snip_20261022_194500.png。同秒多张时加 -2/-3 序号，绝不互相覆盖。 */
function snipFile(dir, d = new Date()) {  const p = (n) => String(n).padStart(2, "0");
  const base = `snip_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let name = base + ".png";
  for (let i = 2; i <= 999; i++) {
    if (!fs.existsSync(path.join(dir, name))) break;
    name = `${base}-${i}.png`;
  }
  return path.join(dir, name);
}

/**
 * 检测 Snipaste 安装 / 运行状态。给设置页状态行和首跑引导卡用。
 * @returns {{ok: boolean, installed: boolean, running: boolean, path: string, source: string}}
 */
async function detect() {
  const inst = await resolveInstall();
  if (!inst) return { ok: true, installed: false, running: false, path: "", source: "" };
  const running = inst.running === true ? true : await isRunning();
  return { ok: true, installed: true, running, path: inst.file, source: inst.source };
}

/**
 * 唤起 Snipaste 框选。
 *
 * ⚠️ 命令是**裸 `snip`**，不带 `-o`、不带 `--hold`（原因见文件头 ②b）：
 *    带 `-o` 会走无人值守输出路径，标注工具栏被整个绕开（免费版没有
 *    `--hold` 兜底），二次截取 / 改选区 / 划线全用不了。
 *    裸 `snip` 与用户按 F1 是同一条路径，标注工具栏正常出现。
 *
 * 产物走剪贴板（Snipaste 框选松手即复制），落盘由 main.js 监听剪贴板完成
 * （见 main.js 的 watchSnipClipboard）。
 *
 * @returns {Promise<{ok: boolean, launched: boolean, file: string, reason: string}>}
 */
async function runSnip() {
  const inst = await resolveInstall();
  if (!inst) return { ok: false, launched: false, file: "", reason: "not-installed" };

  if (!(await isRunning())) {
    /* 冷启动：无参拉起（已在跑也无非是激活一次，单实例应用自己会去重）。
       然后轮询等它就绪 —— Store 版首次冷启可能要点把秒。 */
    try {
      const boot = spawn(inst.file, [], { detached: true, stdio: "ignore", windowsHide: true });
      boot.on("error", (e) => note("冷启动失败:", errText(e)));
      boot.unref();
    } catch (e) {
      return { ok: false, launched: false, file: "", reason: "launch-failed: " + errText(e) };
    }
    const deadline = Date.now() + 6000;
    for (;;) {
      await sleep(200);
      if (await isRunning()) break;
      if (Date.now() >= deadline) return { ok: false, launched: false, file: "", reason: "start-timeout" };
    }
    await sleep(400);   // 进程在 ≠ 托盘/CLI 通道就绪，再给一口喘息
  }

  /* 截图分区此刻就要在（用户可能刚改过存储根）。 */
  let dir = "";
  try { dir = ctx.pathOf("screenshots") || ""; } catch { dir = ""; }
  if (!dir) return { ok: false, launched: false, file: "", reason: "no-screenshots-dir" };
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    return { ok: false, launched: false, file: "", reason: "mkdir-failed: " + errText(e) };
  }

  try {
    /* 裸 `snip`：进入框选，选区确定后走 Snipaste 原本的交互流程 ——
       标注工具栏出现，可改选区 / 划线 / 二次裁剪，最后点复制。
       ⚠️ 不要加 `-o`：那会让它变成无人值守自动保存，标注工具栏不出现
       （免费版没有 `--hold`，加了不起作用）。详见文件头 ②b。
       命令进程只是把指令转给已在跑的实例，自己很快退出，所以不等它。 */
    const cli = spawn(inst.file, ["snip"], { stdio: "ignore", windowsHide: true });
    cli.on("error", (e) => note("snip 命令发送失败:", errText(e)));
    cli.unref();
  } catch (e) {
    return { ok: false, launched: false, file: "", reason: "snip-failed: " + errText(e) };
  }

  note("已唤起 snip（裸命令，走交互流程，产物走剪贴板）");
  lastLaunchAt = Date.now();   // 划词监听据此避开截屏期（见 launchedRecently 上的注释）
  return { ok: true, launched: true, file: "", reason: "" };
}

module.exports = {
  init,
  detect,
  runSnip,
  launchedRecently,
  /* 落盘文件名由 main.js 生成（它负责监听剪贴板并写文件），
     但命名规则留在本模块：截图区的文件名规范只此一处。 */
  snipFile,
};
