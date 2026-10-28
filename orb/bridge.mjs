import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { resolvePython, windowsMcpArgs, windowsMcpEnv, matchProcKind, hasWindowsMcp } from "./runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 可写目录。**定义必须靠前**：confFlag / writeConfFlag 在模块顶层就会被调用
   （第 300 行上下的 WB_DAEMON 等常量），如果 DATA_DIR 定义在文件中间，
   那几处会撞上 const 的暂时性死区（TDZ）直接 ReferenceError。
   ⚠️ HERE（装目录）在打包态是 Program Files 下的 resources/ —— **不可写**。
   凡是运行时会写的东西（用户级配置、日志、临时文件）都必须落这里。 */
const DATA_DIR = process.env.ORB_DATA_DIR || path.join(HERE, "..");
const PORT = Number(process.env.ORB_PORT || 19387);

/** 统一日志（桌面端从 bridge 的 stdout/stderr 抓取）。带标签的调用方把标签作为首参传入。 */
function log(...args) {
  console.log(...args);
}

/* ---------------- 兜底 ----------------
 * 这个进程一死，ORB 的全部能力（前台自动化 / 后台 AI / 语音 / 字幕）一起没，
 * 而 main.js 只是记一行日志、并不会把它拉起来（历史上表现为"整个控制台点不动"）。
 * 所以两类致命异常都必须在这里兜住：
 *   · uncaughtException —— Node 默认直接终结进程。最典型的来源就是 spawn 出来的
 *     子进程发 'error' 事件（ENOENT）时没有监听者，EventEmitter 会把它升级成抛出。
 *   · unhandledRejection —— Node 15+ 同样默认致命。
 * 语义是"记下来、继续跑"：本地服务宁可带伤运行，也不能整体消失。
 */
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err?.stack ?? String(err));
});
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection:", (err && err.stack) || String(err));
});

/*
 * 访问令牌。
 *
 * 为什么必须有：这个 bridge 能执行任意 PowerShell、控制鼠标键盘。
 * 如果只靠 Access-Control-Allow-Origin:* 而不鉴权，那么用户浏览的**任意网页**
 * 都能 fetch('http://127.0.0.1:19387/api/call', ...) 来遥控这台机器 —— 等于远程代码执行。
 * 所以每个请求都要带 X-Orb-Token，令牌在启动时随机生成并写进 .bridge.json，
 * 只有本机的 Electron 主进程会读到它再转交给面板。
 *
 * ORB_TOKEN_FILE 可覆盖路径：单测会 spawn 真 bridge，不设的话它会**覆盖生产
 * .bridge.json**（把端口/令牌写成测试端口的），用户下次开控制台就会连错地方。
 * 踩过一次，所以这里开一个注入口，测试一律指向 cache/ 下的临时文件。
 */
const TOKEN_FILE = process.env.ORB_TOKEN_FILE || path.join(HERE, ".bridge.json");
const TOKEN = process.env.ORB_TOKEN || randomUUID();
// 仅这两个放行：存活探测、以及 daemon 的结果回调（回调方没有我们的令牌，
// 但它必须命中一个已知的 runId 才会被采纳，其余一律忽略）。
const PUBLIC_PATHS = new Set(["/api/health", "/api/wb-callback"]);

// Node 可执行文件定位顺序：ORB_NODE 环境变量 → 版本目录里最新可用版本 → 交给 PATH 解析。
// 不要硬编码 versions/<版本>-<构建号>：WorkBuddy 升级会换目录名（22.22.2-3 → 22.22.2-6），
// 硬编码会直接导致 spawn ENOENT，bridge 起不来，ORB 全部功能失效。
function resolveNodeExe() {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const cands = [];
  if (process.env.ORB_NODE) cands.push(process.env.ORB_NODE);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const base = path.join(home, ".workbuddy", "binaries", "node", "versions");
  try {
    for (const d of fsSync.readdirSync(base).sort().reverse()) cands.push(path.join(base, d, exe));
  } catch {}
  for (const p of cands) { try { if (p && fsSync.existsSync(p)) return p; } catch {} }
  return "node";
}
const NODE_EXE = resolveNodeExe();

/* ---- 外部依赖定位（三级解析，零硬编码）----
 * 这些组件属于宿主 WorkBuddy，装在 ~/.workbuddy/ 下。原来写死了本机用户名，
 * 打包到别的机器上必挂。现在统一三级解析：
 *   ① 环境变量（ORB_WB_HOME / ORB_VENV / ORB_BASE_PY / ORB_DSH_MCP / ORB_WB_CLI）
 *   ② 当前用户目录下的标准位置（%USERPROFILE%\.workbuddy\...）—— 换机器/换用户都对
 *   ③ 旧式 C:\Users\<用户名>\.workbuddy 兜底 —— 按当前用户推导，不写死任何用户名
 * 找不到时返回原路径，由调用方的 existsSync 检查去报错，不在这里抛。 */
const WB_HOME = process.env.ORB_WB_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || "", ".workbuddy");
const LEGACY_HOME = process.env.ORB_WB_LEGACY_HOME
  || path.join("C:\\Users", process.env.USERNAME || "", ".workbuddy");
/* 在标准位置和旧位置里找第一个存在的；都没有就返回标准位置（让上层报"找不到"） */
function pickFirst(rel, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  const a = path.join(WB_HOME, rel);
  if (fsSync.existsSync(a)) return a;
  const b = path.join(LEGACY_HOME, rel);
  if (fsSync.existsSync(b)) return b;
  return a;
}

/* ---- 前台通道运行时（windows-mcp 的宿主）----
 * 全部走 orb/runtime.mjs 这个**单一真相源**，解析顺序：
 *   ORB_PY_EXE → 随包 resources/runtime/python/python.exe → ORB_BASE_PY → PATH → 不可用
 * 随包自带 embeddable CPython + 精简 site-packages（构建见 orb/native/build-runtime.ps1），
 * 所以干净机上（没装 Python、没装 WorkBuddy）前台通道也能直接起来。
 *
 * 旧行为保留在哪：下面三个名字仍然导出，供 repairFront() 那条**遗留 venv 修复路径**使用
 * （只有当解释器来自 WorkBuddy 的 venv 时才有意义；随包运行时是不可重建的，见 repairFront）。 */
const PY = resolvePython();
const BASE_PY = PY.ok ? PY.exe : "";                       // 供遗留修复路径当"基础解释器"
const VENV_DIR = PY.ok ? PY.dir : "";                      // 解释器所在目录
const VENV_PY = PY.ok ? PY.exe : "";                       // 随包运行时本身就是"那个 python"
// 阿里源实测可用；清华源对该 venv 返回 403，官方源走本机代理会 502（仅遗留修复路径用到）
const PIP_INDEX = "https://mirrors.aliyun.com/pypi/simple";
/* 前台通道的可执行文件 = 我们 spawn 的那个解释器（`-m windows_mcp` 而非 windows-mcp.exe） */
const WINDOWS_MCP = PY.ok ? PY.exe : "";
const DSH_MCP = process.env.ORB_DSH_MCP
  || pickFirst(path.join("tools", "dsh-mcp", "dist", "index.js"), "ORB_DSH_MCP");

/* ─────────── 后台 Agent CLI（CodeBuddy Code）定位 ───────────
 *
 * CodeBuddy Code CLI 是**腾讯专有软件**。开源版：
 *   · 不随仓库分发、不随发布物打包 codebuddy.exe（再分发即侵权）；
 *   · 不再兜底到任何本机绝对路径（那等于把作者机器的目录写进公共仓库，
 *     换一台机器 100% 失效，而且泄漏个人目录结构）。
 *
 * 解析顺序：
 *   ① ORB_WB_CLI 环境变量 —— 手动指向 codebuddy.exe 的全路径
 *   ② orb/local.conf 里的 wbCli —— **自用机的本地覆盖**（该文件已进 .gitignore，
 *      既不入库也不随包，所以"自用那份后台通道照常可用、发布那份路径干净"两全）
 *   ③ 系统 PATH —— Windows 用 `where codebuddy`，其它平台用 `which codebuddy`
 *   ④ 都没有 → { found:false }，由上层给出「请安装并登录」的中文提示
 *
 * 契约：**任何情况下都不抛异常、不崩溃**。后台通道不可用只影响后台任务，
 * 前台自动化 / 原生输入 / 视觉 / 语音全部照常。
 */
const WB_CLI_NAME = "codebuddy";
/** 结果缓存 30 秒：面板 5 秒轮询一次 /api/status，不能每次都去 spawn 一个 where */
const WB_CLI_CACHE_MS = 30_000;
/** @type {{at:number, value:{found:boolean, source:string, path:string, fileName:string, hint:string}|null}} */
let wbCliCache = { at: 0, value: null };
/**
 * 登录态（**不猜凭据路径、不做联网探测**，只记录最近一次真实调用的结果）：
 *   "unknown"         —— 从未成功调用过，也没被判过未登录
 *   "ok"              —— 最近一次后台调用成功
 *   "not-logged-in"   —— 最近一次后台调用被 CLI 判为未登录/未授权
 */
let wbCliAuth = "unknown";

/** 未安装：面向用户的「现象 → 怎么做」两段式文案 */
const CLI_HINT_MISSING = "未检测到 CodeBuddy CLI，后台任务不可用。"
  + "请自行安装 CodeBuddy CLI 并完成一次登录/注册（它是专有软件，本项目不随包分发）；"
  + "若已安装但不在 PATH 中，可设置环境变量 ORB_WB_CLI 指向 codebuddy.exe。"
  + "详见「使用说明 → 九、常见问题 · 后台通道」。";
/** 已安装但未登录：与「没装」严格区分，避免用户装好了还以为没装上 */
const CLI_HINT_LOGIN = "CodeBuddy CLI 已安装但尚未登录：请直接运行 codebuddy，"
  + "按提示选择登录方式并在浏览器完成认证（首次使用会引导完成注册）；"
  + "已登录过的可在会话内输入 /login 重新登录、/logout 退出，再重试后台任务。";

/**
 * 读取本地覆盖配置 `orb/local.conf`（JSON，形如 {"wbCli": "..."}）。
 *
 * 为什么要有它：自用机上 CLI 装在某个不打算公开的目录里（比如不在 PATH 中），
 * 直接写进代码/文档等于把私有路径带进开源仓库。放到 local.conf 里则永远不会入库 ——
 * 该文件已在 .gitignore 中排除，**也不在 pack.cjs 的打包清单里**。
 * 发布版没有这个文件 → 走 PATH 检测 + 优雅降级。
 *
 * 读不到、格式坏、不是对象 → 一律返回空对象，绝不抛。
 */
function readLocalConf() {
  try {
    const j = JSON.parse(fsSync.readFileSync(path.join(HERE, "local.conf"), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** 在系统 PATH 里找 codebuddy。找不到返回空串（不抛异常）。 */
function whichCodebuddy() {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFile(cmd, [WB_CLI_NAME], {
      timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err || !stdout) return resolve("");
      const lines = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return resolve("");
      // Windows 的 where 会按 PATHEXT 一次返回 .exe/.cmd/.bat 等；优先原生可执行文件，
      // 其次才是脚本包装（两者都能起进程，但 .exe 少了 cmd 层，信号/退出码更准）。
      const exe = lines.find((l) => /\.exe$/i.test(l));
      resolve(exe || lines[0]);
    });
  });
}

/**
 * 解析后台 CLI 位置。
 * @param {boolean} refresh 为 true 时强制重查（用户装完 CLI 点「重新检测」，无需重启）。
 * @returns {Promise<{found:boolean, source:string, path:string, fileName:string, hint:string}>}
 */
async function resolveWbCli(refresh = false) {
  const now = Date.now();
  if (!refresh && wbCliCache.value && now - wbCliCache.at < WB_CLI_CACHE_MS) {
    return wbCliCache.value;
  }
  let value = { found: false, source: "none", path: "", fileName: "", hint: CLI_HINT_MISSING };
  // 显式指定：环境变量优先，其次本地覆盖文件（自用机专用，不入库）
  const fromEnv = (process.env.ORB_WB_CLI || "").trim();
  const fromConf = String(readLocalConf().wbCli || "").trim();
  const explicit = fromEnv || fromConf;
  const src = fromEnv ? "env" : "local-conf";
  if (explicit) {
    let exists = false;
    try { exists = fsSync.existsSync(explicit); } catch { exists = false; }
    value = exists
      ? { found: true, source: src, path: explicit, fileName: path.basename(explicit), hint: "" }
      : {
        found: false,
        source: src + "-missing",
        path: explicit,
        fileName: path.basename(explicit),
        hint: (fromEnv
          ? "环境变量 ORB_WB_CLI 指向的文件不存在："
          : "本地配置 orb/local.conf 的 wbCli 指向的文件不存在：")
          + explicit
          + "。请改成 codebuddy 可执行文件（Windows 下通常为 codebuddy.exe）的真实完整路径。",
      };
  } else {
    const onPath = await whichCodebuddy();
    if (onPath) {
      value = { found: true, source: "path", path: onPath, fileName: path.basename(onPath), hint: "" };
    }
  }
  wbCliCache = { at: now, value };
  return value;
}

/** /api/status 与 /api/wb-cli 共用的对外形态（路径脱敏：只暴露文件名，不暴露完整目录） */
function cliStatusPayload(cli) {
  const c = cli || { found: false, source: "none", path: "", fileName: "", hint: CLI_HINT_MISSING };
  return {
    found: !!c.found,
    source: c.source || "none",
    fileName: c.fileName || "",
    auth: wbCliAuth,
    // 已安装但最近一次被判未登录 → 给登录文案；否则给未安装文案；都没问题就空串
    hint: !c.found ? (c.hint || CLI_HINT_MISSING)
      : (wbCliAuth === "not-logged-in" ? CLI_HINT_LOGIN : ""),
  };
}

/*
 * 传给 codebuddy 子进程的环境变量。
 *
 * 桌面端 WorkBuddy 启动时会把自身服务端口写进环境变量：
 *   SERVER__PORT=<桌面端口>
 *   CODEBUDDY_SERVICE_PROXY_URL=http://127.0.0.1:<桌面端口>/...
 * 若 orb 是从桌面端派生的终端里启动的，就会继承这两个变量；codebuddy 子进程随后会
 * 试图绑定「桌面已占用的同一个端口」→ EADDRINUSE 未捕获异常秒退。
 * 这里显式剔除，确保子进程用自己的端口（与 spawnOnce 的 --port 双保险）。
 */
function cleanCliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.SERVER__PORT;
  delete env.CODEBUDDY_SERVICE_PROXY_URL;
  return env;
}

/*
 * 速度开关。
 *
 * 后台慢的两个主因：
 *   1) 每次派发都是冷启动（147MB 原生进程 + 加载产品配置 / 插件 / MCP / 工具集），
 *      这是「每次开一个完整 agent」的固有开销，只能靠降低推理强度来补；
 *   2) 默认模型 hy4-preview 带推理，会先吐 reasoning token 再回答。
 *
 * 想更快就设 ORB_WB_MODEL（如 fast-model / hy3 / deepseek-v4.1-flash）；
 * ORB_WB_EFFORT 默认 low 以减少推理开销；ORB_WB_MAX_TURNS 兜住失控的多轮任务。
 */
const WB_MODEL = (process.env.ORB_WB_MODEL || "").trim();
const WB_EFFORT = (process.env.ORB_WB_EFFORT || "low").trim();
const WB_MAX_TURNS = (process.env.ORB_WB_MAX_TURNS || "").trim();

/* ---------- 常驻 daemon（可选，用来消掉冷启动） ----------
 *
 * 开启：ORB_WB_DAEMON=1
 *
 * 为什么默认不开（实测结论，2026-09-29）：
 *   POST /api/v1/runs      → {"data":{"runId":"…","status":"accepted"}}   能派发
 *   GET  /api/v1/runs/:id  → {"data":{"runId":"…","active":false}}        没有结果文本
 *   GET  /api/v1/runs/:id/stream → RUN_NOT_FOUND "already completed"     结果已丢弃
 * 即结果**拿不回来**，唯一途径是请求体里的 callback.url，
 * 而回调报文的字段名官方未文档化。
 * 因此做成可选：回调来了就用；没来 / 超时一律回落到 `-p` 子进程（现有可用路径），
 * 并把每次回调的原始报文追加到 wb-callback.log，便于确认字段后固化解析。
 */
/* 开关有两个来源，任一为真即启用：
 *   1) 环境变量 ORB_WB_DAEMON=1（走 .cmd 启动时有效）
 *   2) bridge.conf 里 {"daemon": true}
 * 之所以还要看文件：桌面的 .lnk 直接拉起 electron，拿不到 .cmd 里 set 的环境变量。 */
/** 用户级配置（DATA_DIR 下），没有就退回随包那份（HERE，只读）。 */
function confFileForWrite() { return path.join(DATA_DIR, "bridge.conf"); }
function confFlag(name, dflt = false) {
  /* 读的顺序反过来：用户级优先，随包的当默认值。
     打包态装目录只读 —— 只认 HERE 的话，用户在设置里改的开关写不进去也读不回来。 */
  for (const f of [confFileForWrite(), path.join(HERE, "bridge.conf")]) {
    try {
      const j = JSON.parse(fsSync.readFileSync(f, "utf8"));
      if (j && name in j) return !!j[name];
    } catch { /* 这一份没有/坏了，看下一份 */ }
  }
  return dflt;
}

/**
 * 原子写 JSON：先写 .tmp，再 rename 到目标。
 * 直接写目标文件时，进程被强杀 / 断电会把文件截成半个 JSON —— 而所有读取点
 * 都是 `try { JSON.parse } catch { 回默认值 }`，于是**危险工具清单、白名单、
 * 触发器、积分累计（allTime）**会无声归零，用户还以为自己从来没设置过。
 * 同一分区内的 rename 是原子的：要么拿到新文件，要么还是旧文件，不存在中间态。
 */
function writeJsonAtomic(file, obj, pretty = 2) {
  const text = JSON.stringify(obj, null, pretty) + "\n";
  const tmp = file + ".tmp";
  try { fsSync.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* 目录已存在 */ }
  fsSync.writeFileSync(tmp, text, "utf8");
  fsSync.renameSync(tmp, file);
}

/** 写回 bridge.conf 的某个布尔开关（保留其它字段与注释），供控制台 UI 切换。 */
function writeConfFlag(name, value) {
  /* 写到 DATA_DIR，不是装目录：打包态 HERE 在 Program Files 下不可写，
     写那里会让「设置里切换开关」静默失败（release 版表现为开关永远不变）。 */
  const file = confFileForWrite();
  let j = {};
  try { j = JSON.parse(fsSync.readFileSync(file, "utf8")) || {}; } catch {
    /* 用户级那份还没有：以随包那份为底，第一次写的时候顺手搬到可写目录 */
    try { j = JSON.parse(fsSync.readFileSync(path.join(HERE, "bridge.conf"), "utf8")) || {}; } catch { /* 容忍缺失/损坏 */ }
  }
  j[name] = !!value;
  try { writeJsonAtomic(file, j); } catch (e) { log("[conf] 写配置失败:", e?.message ?? e); }
}

// 可变：控制台 UI 可在运行时切换（无需重启 ORB）。
let WB_DAEMON = process.env.ORB_WB_DAEMON === "1" || confFlag("daemon", false);
const WB_DAEMON_PORT = Number(process.env.ORB_WB_PORT || 19090);
// daemon 单次等待上限（等一次 run 的回调往返）。
// 调小可让「daemon 没成」时更快回落到 -p 子进程，代价是长任务更容易走回落。
const WB_DAEMON_WAIT = Number(process.env.ORB_WB_DAEMON_WAIT || 90000);
const pendingRuns = new Map();
let daemonProc = null;

const daemonBase = () => `http://127.0.0.1:${WB_DAEMON_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function daemonHealth() {
  try {
    const r = await fetch(daemonBase() + "/api/v1/health", {
      headers: { "X-CodeBuddy-Request": "1" },
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.data?.status === "ok";
  } catch { return false; }
}

/** spawn 失败是**异步**报的：spawn() 本身总是同步成功，ENOENT 走 'error' 事件。
 *  没有监听者时 EventEmitter 会把它升级成抛出，整个 bridge 立刻没了。
 *  这里统一记录，并让等待循环提前放弃（否则每次调用都白等 40 秒）。 */
let daemonSpawnErr = "";
async function ensureDaemon() {
  if (await daemonHealth()) return true;
  // CLI 不在就别试着拉进程了：spawn 一个不存在的 exe 只会得到 ENOENT 与一堆噪音日志。
  const cli = await resolveWbCli();
  if (!cli.found) { log("[wb-daemon] 跳过：", cli.hint || CLI_HINT_MISSING); return false; }
  try {
    if (daemonProc && daemonProc.exitCode === null) {
      // 已有实例正在起（并发调用）：直接进等待循环，
      // 再 spawn 一个会把上一个的引用顶掉 —— 那个进程就再也管不着了。
    } else {
      daemonSpawnErr = "";
      daemonProc = spawn(cli.path, ["--serve", "--port", String(WB_DAEMON_PORT)], {
        env: cleanCliEnv({ CODEBUDDY_GATEWAY_AUTH: "none" }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        cwd: process.env.ORB_WB_CWD || path.join(HERE, ".."),
      });
      daemonProc.stdout.on("data", (d) => log("[wb-daemon]", String(d).trim()));
      daemonProc.stderr.on("data", (d) => log("[wb-daemon:err]", String(d).trim()));
      daemonProc.on("error", (e) => {
        daemonSpawnErr = String(e?.message ?? e);
        log("[wb-daemon] 启动异常:", daemonSpawnErr, "→", cli.path);
        daemonProc = null;
      });
      daemonProc.on("exit", (c) => { log("[wb-daemon] 退出 code =", c); daemonProc = null; });
      /* 必须进台账 + 活动进程表：漏登记的后果是"急停停不掉它"，而且 bridge 被强杀后
         reapStaleChildren 按台账回收时也看不见它 —— 那就是一个永久孤儿。 */
      try { if (daemonProc.pid) registerChild(daemonProc.pid, "daemon"); } catch {}
      try { trackProc(daemonProc); } catch {}
    }
  } catch (err) {
    log("[wb-daemon] 启动失败:", err?.message ?? err);
    return false;
  }
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (daemonSpawnErr) { daemonSpawnErr = ""; return false; }   // 起不来就别干等
    if (await daemonHealth()) { log("[wb-daemon] 就绪:", daemonBase()); return true; }
  }
  return false;
}

/** 回调字段名未知，按常见键名逐层找第一个非空文本。 */
function extractCallbackText(v, depth = 0) {
  if (!v || depth > 6) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const t = extractCallbackText(v[i], depth + 1);
      if (t) return t;
    }
    return "";
  }
  if (typeof v === "object") {
    const keys = ["text", "result", "content", "message", "output", "reply", "answer"];
    for (const k of keys) if (typeof v[k] === "string" && v[k].trim()) return v[k].trim();
    for (const k of [...keys, "data", "payload"]) {
      const t = extractCallbackText(v[k], depth + 1);
      if (t) return t;
    }
    for (const k of Object.keys(v)) {
      const t = extractCallbackText(v[k], depth + 1);
      if (t) return t;
    }
  }
  return "";
}

/* ---------- 后台 daemon（HTTP --serve，best-effort 兜底） ----------
 *
 * 实测结论（2026-09-29，对照多轮探针）：
 *   · ACP（`--acp`）：`initialize` 握手正常，但 `session/new` **永远不回**
 *     （即便显式 --port、即便用空目录 cwd 也 120s 零响应；ACP 又没有 auth/login
 *     方法，疑似鉴权死锁）。这条路在本 CLI 构建里不可用。
 *   · HTTP `--serve`：能接受 run（POST /api/v1/runs 返回 runId），但 run 始终
 *     active:false、回调**不来**、stream 报 already completed —— agent 引擎没真正执行。
 *   · 两条 daemon 路线都依赖登录态，且都会因 codebuddy 默认去绑 58449 端口、
 *     与正在运行的 WorkBuddy 桌面端冲突（EADDRINUSE 未捕获）而崩坏。
 *
 * 因此：默认且可靠的路径是 `spawnOnce`（-p 子进程，必须带 --port 避开 58449）。
 * 下面的 HTTP daemon 仅作 WB_DAEMON=1 时的 best-effort 兜底——派发成功就等回调，
 * 没来/超时一律回落到 -p 子进程，并把每次回调原始报文追加到 wb-callback.log。
 */
async function daemonRun(task, timeoutMs, model) {
  if (!(await ensureDaemon())) return null;
  const runId = randomUUID();
  const waitMs = Math.min(timeoutMs, WB_DAEMON_WAIT);
  const done = new Promise((resolve, reject) => {
    /* 超时定时器必须在**结算时也清掉**。
       原来是裸 setTimeout + 直接 resolve：回调先到的话，那个定时器会一直挂到
       waitMs（最长 90s）才空转一次 —— 每派发一次后台任务就多一个吊着的定时器。 */
    const timer = setTimeout(() => {
      if (pendingRuns.delete(runId)) {
        reject(new Error(`后台任务在 ${Math.round(waitMs / 1000)}s 内未收到回调`));
      }
    }, waitMs);
    pendingRuns.set(runId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
  try {
    const r = await fetch(daemonBase() + "/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CodeBuddy-Request": "1" },
      body: JSON.stringify({
        id: runId, type: "message", version: "1.0",
        source: {
          platform: "generic",
          sender: { id: "orb", name: "Orb" },
          conversation: { id: runId, type: "direct" },
        },
        payload: { text: task },
        timeoutMs,
        ...(model ? { model } : {}),
        callback: { url: `http://127.0.0.1:${PORT}/api/wb-callback` },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.error) throw new Error(`${j.error.code || "ERROR"}: ${j.error.message || ""}`);
    if (!j?.data?.runId) throw new Error("daemon 未返回 runId");
  } catch (err) {
    pendingRuns.delete(runId);
    log("[wb-daemon] 派发失败:", err?.message ?? err);
    return null;
  }
  return await done;
}

/*
 * DSH（DeepSeek Harness）通道 —— **历史遗留，开源版默认不注册**（见 SERVERS）。
 *
 * 为什么不注册：
 *   ① 面板早已不走 dsh（后台改走 CodeBuddy CLI），它是死功能；
 *   ② 它依赖某个具体用户家目录下的凭据与 node_modules，开源携带别人家目录
 *      既不体面，在别人机器上也永远起不来，只会白占一个 node 进程。
 * 需要它时显式设 ORB_ENABLE_DSH=1 才会注册。
 *
 * 家目录不再硬编码：默认取「当前用户」的 ~/.workbuddy/orb-dsh，可用 DSH_HOME 覆盖。
 */
const DSH_HOME = process.env.DSH_HOME || path.join(WB_HOME, "orb-dsh");
const DSH_ROOT = process.env.DSH_ROOT
  || path.join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "node_modules", "@deepseek-ai", "dsh");

/** 从凭据文件读 key 注入环境。dsh-mcp 启动时硬性要求 DEEPSEEK_API_KEY，没有就直接退出。 */
function credentialFromHome(name) {
  if (process.env[name]) return process.env[name];
  try {
    const txt = readFileSync(path.join(DSH_HOME, ".credentials.yaml"), "utf8");
    const m = txt.match(new RegExp(name + ":\\s*([A-Za-z0-9._\\-]{16,})"));
    return m ? m[1] : "";
  } catch {
    return "";
  }
}
const DSH_API_KEY = credentialFromHome("DEEPSEEK_API_KEY");
const DSH_CSCS_KEY = credentialFromHome("CSCS_API_KEY");

const CALL_TIMEOUT_MS = Number(process.env.ORB_CALL_TIMEOUT || 120000);
const JOB_TIMEOUT_MS = Number(process.env.ORB_JOB_TIMEOUT || 1800000);
const MAX_JOBS = 60;

/*
 * 本地伪服务 "orb"。
 *
 * 为什么需要它：windows-mcp 只有 Click（等价 down+up 连发），
 * 没有把按下和抬起拆开的能力，所以「长按」「按住拖动」做不了。
 * native/orb-input.exe 用 Win32 SendInput 补齐，这里把它包装成
 * 与 MCP 一致的工具面，界面无需区分来源。
 *
 * 坐标系与 windows-mcp 的 loc 一致（物理像素）。
 */
const ORB_INPUT = process.env.ORB_INPUT_EXE
  || path.join(HERE, "native", "dist", "orb-input.exe");

function runOrbInput(argv, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(ORB_INPUT, argv.map(String), { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || "").trim();
          return reject(new Error(`orb-input 执行失败：${detail || err.code}`));
        }
        const text = String(stdout || "").trim();
        resolve({
          content: [{ type: "text", text: text || "ok" }],
          isError: false,
        });
      });
  });
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

const LOCAL_TOOLS = {
  long_press: (a) => {
    const ms = clampInt(a.durationMs ?? a.duration, 1, 60000, 800);
    // 超时必须大于时长本身，否则 60 秒的长按会先撞 30 秒默认超时被误杀。
    return runOrbInput(["longpress",
      clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0),
      ms, a.button ?? "left"], ms + 15000);
  },
  mouse_press: (a) => runOrbInput([
    "press", clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0), a.button ?? "left",
  ]),
  mouse_release: (a) => runOrbInput(["release", a.button ?? "left"]),
  drag: (a) => {
    const ms = clampInt(a.durationMs, 0, 20000, 400);
    return runOrbInput([
      "drag",
      clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0),
      clampInt(a.x2, -100000, 100000, 0), clampInt(a.y2, -100000, 100000, 0),
      ms, a.button ?? "left"], ms + 15000);
  },
  move_to: (a) => runOrbInput([
    "move", clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0),
  ]),
  cursor_position: () => runOrbInput(["cursor"]),
  scroll_at: (a) => runOrbInput([
    "scroll", clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0),
    a.direction ?? "down", clampInt(a.clicks, 1, 100, 3),
  ]),
};

const ORB_TOOL_LIST = Object.keys(LOCAL_TOOLS);

/*
 * WorkBuddy 后台轨道。
 *
 * 原先后台派给 DeepSeek Harness（dsh-mcp），现改为直接调用 WorkBuddy 自带的
 * headless Agent CLI（CodeBuddy Code）。它就是 WorkBuddy 本体在用的那个 agent，
 * 模型 / 账号沿用 ~/.workbuddy 的配置，无需另配 key。
 *
 * 一次性执行：codebuddy -p "<task>" --output-format text
 *   （不要用 json —— 那是整段会话流水，不是回答正文）
 */
const WORKBUDDY_TOOLS = {
  // 包一层 metered：这次调用新产生的会话才算到 ORB 头上（详见 readCredits 的注释）
  workbuddy_execute: (a, timeoutMs) =>
    metered(() => runWorkbuddy(String(a?.task ?? ""), timeoutMs, String(a?.model ?? ""))),
  /* 人格台词批量生成（B + E 的措辞来源）。
     不进 metered：它本身就是「额外消耗」那一块，面板会单独标注成本，
     不该和「会话记账」混在一起。失败一律返回 {ok:false}，不抛。 */
  persona_bundle: (a) => runPersonaBundle(a),
};

/*
 * 后台可选模型清单（供面板下拉用）。
 *
 * 这些都是 CodeBuddy CLI `--model` 支持的取值，调用走 CLI 的登录态，
 * 不需要任何 API key —— 与「视觉」槽那种要自己填 baseUrl + key 的路子是两回事。
 * 注意：WorkBuddy 云服务的免密钥通道（/.cloud/llm/chat/completions）**不能用**：
 * Origin 校验过不了，且明令禁止把它做成可被别的应用调用的代理。
 *
 * credit = 积分消耗倍率的**参考值**（2026-10-25 整理自 WorkBuddy 客户端模型菜单，
 *   格式 "×N[ · 活动标签]"）。倍率随活动（限免/夜间折扣/订阅优先）漂移，
 *   CLI 只吐模型 ID 不吐倍率，所以这里只能是带日期的参考 —— 面板上已注明
 *   "以 WorkBuddy 客户端显示为准"。新模型先上线、倍率后公布的，credit 留空，
 *   绝不编数。
 *
 * 运行时以 /api/wb-models 的**实时解析**为准（见 fetchLiveWbModels）：CLI 的
 * --model 帮助文本永远列着当前真支持的清单；本表在 CLI 不可用时兜底，
 * 并给实时清单补 label/credit 元数据。
 */
const WB_MODEL_LIST = [
  { id: "", label: "默认（跟随 CLI）", credit: "" },
  /* 模式档：快速 / 均衡 / 极致 三个 CLI 别名，倍率为模式级参考值 */
  { id: "fast-model", label: "fast-model", credit: "快速档 ×0.21" },
  { id: "balanced-model", label: "balanced-model", credit: "均衡档 ×0.65" },
  { id: "deep-model", label: "deep-model", credit: "极致档 ×1.20" },
  { id: "hy4-preview", label: "hy4-preview", credit: "均衡默认 ×0.29 · 夜间免费" },
  { id: "hy3", label: "hy3", credit: "限时免费 ×0.00" },
  { id: "hy3-x", label: "hy3-x", credit: "" },
  { id: "step-5-preview", label: "step-5-preview", credit: "独家限免 ×0.00" },
  { id: "space-bunny", label: "space-bunny", credit: "×0.08" },
  { id: "deepseek-v4.1-flash", label: "deepseek-v4.1-flash", credit: "×0.11 · 夜间折扣" },
  { id: "deepseek-v4-pro", label: "deepseek-v4-pro", credit: "" },
  { id: "glm-5.3", label: "glm-5.3", credit: "×0.69 · 订阅优先" },
  { id: "glm-5.3-flash", label: "glm-5.3-flash", credit: "×0.08" },
  { id: "glm-5.2", label: "glm-5.2", credit: "×0.79 · 夜间折扣" },
  { id: "glm-5.1", label: "glm-5.1", credit: "×0.79" },
  { id: "glm-5v-turbo", label: "glm-5v-turbo", credit: "×0.95" },
  { id: "minimax-m3.1-flash", label: "minimax-m3.1-flash", credit: "" },
  { id: "minimax-m3", label: "minimax-m3", credit: "×0.25" },
  { id: "kimi-k3.1-pro", label: "kimi-k3.1-pro", credit: "" },
  { id: "kimi-k3-1", label: "kimi-k3-1", credit: "×1.62" },
  { id: "kimi-k2.8-preview", label: "kimi-k2.8-preview", credit: "" },
  { id: "mimo-v2.6-pro", label: "mimo-v2.6-pro", credit: "" },
  { id: "custom-local:Qwen3.5", label: "自定义 · Qwen3.5（本地）", credit: "自付额度" },
  { id: "custom-local:glm-5.3", label: "自定义 · glm-5.3（本地）", credit: "自付额度" },
  { id: "custom-local:GLM 5.3-flash", label: "自定义 · GLM 5.3-flash（本地）", credit: "自付额度" },
];

/* 模型清单缓存：解析一次要 spawn CLI --help（约 1s），面板可能反复拉，缓存 5 分钟。
   面板的「更新」钮带 ?refresh=1 强制重拉。 */
const WB_MODELS_CACHE_MS = 5 * 60 * 1000;
/* 强制刷新的最小间隔：面板那个「更新」钮可以连点，而 force 会绕过缓存 ——
   不去重的话每点一次就 spawn 一个 ~147MB 的 codebuddy --help（各带 8s 超时），
   连点几下就有好几个 CLI 在后台同时跑。 */
const WB_MODELS_MIN_REFRESH_MS = 10 * 1000;
/** @type {{at:number, value:{models:Array, source:string, at:number}|null}} */
let wbModelsCache = { at: 0, value: null };
let wbModelsInflight = null;   // 在途的强制刷新（连点复用同一个 Promise）

/**
 * 从 CodeBuddy CLI 的 --help 里解析**实时**模型清单。
 * 真源：--model 选项说明里的 "Currently supported: (a, b, c...)"。
 * 没装 / 超时 / 解析失败 → null（调用方回落静态表）。任何情况下不抛。
 */
function fetchLiveWbModels() {
  return resolveWbCli(false).then((cli) => new Promise((resolve) => {
    if (!cli.found) return resolve(null);
    execFile(cli.path, ["--help"], { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const text = String(stdout || "");
        const m = text.match(/Currently supported:\s*\(([^)]+)\)/);
        if (!m) return resolve(null);
        /* 按逗号切：id 里允许冒号与空格（custom-local:GLM 5.3-flash） */
        const ids = m[1].split(",").map((s) => s.trim()).filter(Boolean);
        resolve(ids.length ? ids : null);
      });
  }));
}

/**
 * 合并实时 ID 与静态元数据（label / credit），产出下拉 payload。
 * CLI 临时少列的内置项也会并上（标 source 仍为 cli，面板无所谓）。
 * 全程不抛：任何一步失败都回落静态表。
 */
async function wbModelsPayload(force = false) {
  const now = Date.now();
  if (!force && wbModelsCache.value && now - wbModelsCache.at < WB_MODELS_CACHE_MS) {
    return wbModelsCache.value;
  }
  if (force) {
    if (wbModelsInflight) return wbModelsInflight;                       // 连点：复用在途的那次
    if (wbModelsCache.value && now - wbModelsCache.at < WB_MODELS_MIN_REFRESH_MS) {
      return wbModelsCache.value;                                        // 10 秒内重复点：直接给缓存
    }
    wbModelsInflight = wbModelsBuild(now).finally(() => { wbModelsInflight = null; });
    return wbModelsInflight;
  }
  return wbModelsBuild(now);
}
async function wbModelsBuild(now) {
  const meta = new Map(WB_MODEL_LIST.map((x) => [x.id, x]));
  let models = null;
  try {
    const live = await fetchLiveWbModels();
    if (live) {
      const rows = live.map((id) => {
        const k = meta.get(id);
        return { id, label: k ? k.label : id, credit: k ? (k.credit || "") : "" };
      });
      const seen = new Set(live);
      const extras = WB_MODEL_LIST.filter((x) => !seen.has(x.id)).map((x) => ({ ...x }));
      /* ""（默认·跟随 CLI）是纯静态项：必须钉在首位。HTML select 默认选中
         第一个选项，把它甩到末尾等于把用户的默认模型悄悄换成第一个真模型。 */
      const di = extras.findIndex((x) => x.id === "");
      const def = di >= 0 ? extras.splice(di, 1)[0] : null;
      models = def ? [def, ...rows, ...extras] : [...rows, ...extras];
    }
  } catch { /* 回落静态 */ }
  const value = models
    ? { models, source: "cli", at: now }
    : { models: WB_MODEL_LIST.map((x) => ({ ...x })), source: "static", at: now };
  wbModelsCache = { at: now, value };
  return value;
}
const WORKBUDDY_TOOL_LIST = Object.keys(WORKBUDDY_TOOLS);

/**
 * 从 CLI 输出里取「回答正文」。
 * - text 格式：本身就是正文，原样返回。
 * - 若仍是 JSON：可能是 {result} 对象，也可能是整段会话数组 ——
 *   数组绝不能整段回显（否则面板会刷一大坨 JSON），
 *   优先取 type==="result" 的 result，其次取最后一条 assistant 的 output_text。
 */
function extractAnswer(out) {
  const raw = String(out || "").trim();
  if (!raw) return "";
  let j = null;
  try { j = JSON.parse(raw); } catch { return raw; }          // 非 JSON → 就是正文
  if (typeof j === "string") return j;
  if (j && typeof j.result === "string") return j.result;
  if (j && typeof j.text === "string") return j.text;
  if (Array.isArray(j)) {
    for (let i = j.length - 1; i >= 0; i--) {
      const m = j[i];
      if (m && m.type === "result" && typeof m.result === "string") return m.result;
      if (m && m.type === "message" && m.role === "assistant" && Array.isArray(m.content)) {
        const t = m.content
          .filter((c) => c && (c.type === "output_text" || c.type === "text"))
          .map((c) => c.text ?? c.output_text ?? "")
          .join("").trim();
        if (t) return t;
      }
    }
    return raw.slice(0, 2000) + "\n\n（未能从会话流水里解析出正文，已截断显示）";
  }
  return typeof j === "object" ? JSON.stringify(j).slice(0, 4000) : raw;
}

async function runWorkbuddy(task, timeoutMs = JOB_TIMEOUT_MS, model = "") {
  // 前置校验：CLI 不在就直接给「去安装」的中文提示，绝不 spawn 一个不存在的可执行文件。
  // 这里是后台派发的唯一入口（面板 /api/call → WORKBUDDY_TOOLS.workbuddy_execute），
  // 放在最前面可以让「没装」和「没登录」走两条完全不同的文案。
  const cli = await resolveWbCli();
  if (!cli.found) throw new Error(cli.hint || CLI_HINT_MISSING);

  // 常驻 daemon 优先（可选开启，见 WB_DAEMON 处的实测说明）；
  // 拿不到结果就回落到一次性子进程 —— 保证后台始终有可用路径。
  if (WB_DAEMON) {
    try {
      const text = await daemonRun(task, timeoutMs, model);
      if (text) return { content: [{ type: "text", text }], isError: false };
    } catch (err) {
      log("[wb-daemon] 回落到一次性子进程：", err?.message ?? err);
    }
  }
  /* 进度可见：把普通后台任务也挂进 LIVE（面板每 5 秒轮询 /api/status 就能读到）。
     total=0 时面板不画步数，只显示「最近一个工具 · 已用几秒」。
     只有 LIVE 空闲时才接管，免得和正在跑的工作流回放抢同一个槽。 */
  const ownLive = !LIVE.active;
  if (ownLive) liveStart("workbuddy", String(task || "").replace(/\s+/g, " ").slice(0, 24), 0, "后台任务");
  try {
    /* 默认走流式：能拿到 tool_use 才能做过程播报。
       ORB_WB_TEXT=1 可整体退回旧的纯文本路径（排障用，行为与历史完全一致）。 */
    const r = process.env.ORB_WB_TEXT === "1"
      ? await spawnOnce(task, timeoutMs, model)
      : await spawnOnceStream(task, timeoutMs, model);
    if (ownLive) liveEnd(true);
    return r;
  } catch (e) {
    if (ownLive) liveEnd(false, String((e && e.message) || e).slice(0, 120));
    throw e;
  }
}

/** 流式版一次性执行：--output-format stream-json。
 *
 *  正文怎么取：**把所有 assistant 事件的 text 拼起来**。这是最稳的一条 ——
 *  不依赖 result 事件里叫什么字段，也不受 CLI 版本改动影响；万一哪天
 *  事件形状变了，只要还有 assistant 文本就有内容，不会把整个后台通道弄哑。
 *  真要出问题，用 ORB_WB_TEXT=1 一键退回 spawnOnce。
 *
 *  顺带把每个 tool_use 的名字写进 LIVE.lastTool，供面板做过程播报。
 */
function spawnOnceStream(task, timeoutMs, model, cliPath = "") {
  return new Promise(async (resolve, reject) => {
    if (!task.trim()) return reject(new Error("workbuddy_execute 需要一个 task 参数"));
    const cli = await resolveWbCli();
    if (!cli.found) return reject(new Error(cli.hint || CLI_HINT_MISSING));
    const cliExe = cliPath || cli.path;
    const port = await freePort();
    const viaNode = /\.(m?js)$/i.test(cliExe);
    const file = viaNode ? NODE_EXE : cliExe;
    const argv = [
      ...(viaNode ? [cliExe] : []),
      "-p", task,
      "--port", String(port),
      "--output-format", "stream-json",
      // 后台无人值守，不能卡在权限确认上
      "--permission-mode", "bypassPermissions",
      ...((model || WB_MODEL).trim() ? ["--model", (model || WB_MODEL).trim()] : []),
      ...(WB_EFFORT ? ["--effort", WB_EFFORT] : []),
      ...(WB_MAX_TURNS ? ["--max-turns", WB_MAX_TURNS] : []),
    ];

    let child;
    try {
      child = spawn(file, argv, {
        windowsHide: true,
        env: cleanCliEnv(),
        cwd: process.env.ORB_WB_CWD || path.join(HERE, ".."),
      });
    } catch (e) {
      return reject(e);
    }
    trackProc(child);
    registerChild(child.pid, "cli");

    const MAX_BYTES = 8 * 1024 * 1024;   // 与旧 execFile 的 maxBuffer 对齐
    let text = "";
    let stderr = "";
    let bytes = 0;
    let buf = "";
    let done = false;
    let timedOut = false;
    let toolSeen = 0;

    /* execFile 的 timeout 只杀父进程，孙进程会成孤儿；这里自己计时 + 树杀 */
    const timer = setTimeout(() => { timedOut = true; killProcTree(child); }, timeoutMs);

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const out = text.trim();
      if (out) {
        wbCliAuth = "ok";
        return resolve({ content: [{ type: "text", text: extractAnswer(out) }], isError: false });
      }
      const detail = String(stderr || (err && err.message) || "").trim();
      if (/Authentication required|Please use \/login|not logged in|unauthorized/i.test(detail)) {
        wbCliAuth = "not-logged-in";
        return reject(new Error(CLI_HINT_LOGIN));
      }
      if (timedOut) return reject(new Error("CodeBuddy CLI 超时（" + Math.round(timeoutMs / 1000) + " 秒）"));
      return reject(new Error(`CodeBuddy CLI 无输出：${detail || "exit " + ((err && err.code) ?? "?")}`));
    };

    const onLine = (line) => {
      const s = line.trim();
      if (!s || s.charCodeAt(0) !== 123) return;      // 只吃 JSON 行
      let ev;
      try { ev = JSON.parse(s); } catch { return; }
      if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
        for (const c of ev.message.content) {
          if (!c) continue;
          if (c.type === "text" && typeof c.text === "string") text += c.text;
          else if (c.type === "tool_use" && c.name) {
            toolSeen += 1;
            if (LIVE.active) liveStep(toolSeen, String(c.name));
          }
        }
      } else if (ev.type === "result" && ev.is_error && Array.isArray(ev.errors)) {
        stderr += ev.errors.join("\n") + "\n";
      }
    };

    child.stdout.on("data", (d) => {
      bytes += d.length;
      if (bytes > MAX_BYTES) { try { killProcTree(child); } catch {} return; }
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code, sig) => {
      if (buf) { onLine(buf); buf = ""; }
      finish(sig || code ? { code, signal: sig } : null);
    });
  });
}

/* ---------------- 人格台词批量生成（B + E 的措辞来源） ----------------
 * 一次调用拿到整轮要用的台词：过程三句 + 成功一句 + 失败一句。
 * 成本等同「结尾现编一次」，却能让整个过程都有这个人自己的说法 ——
 * 这是比「每句现调一次」便宜一个数量级的关键。
 *
 * 分工铁律：**事实由面板给，模型只负责措辞**。它不知道任务里发生了什么，
 * 所以过程句只能用泛化动作，不许出现具体文件名或行号（那些由 E 的规则层补）。
 * 任何失败都返回 {ok:false}，由面板退回预定台词，绝不抛给调用方。
 */
const PERSONA_TASK_MAX = 200;

function buildPersonaPrompt(a) {
  const spec = a && a.spec && typeof a.spec === "object" ? a.spec : {};
  const L = [];
  L.push("你现在只需要「说话」：不要调用任何工具、不要执行任务、不要读文件。");
  L.push("");
  L.push("[当前人格] " + String(spec.name || "元气开心果"));
  if (spec.mechanism) L.push("[性格内核] " + String(spec.mechanism));
  L.push("[语言规则] " + String(spec.rules || "句长 10~18 字；口语；不啰嗦。"));
  L.push("[禁止] " + String(spec.bans || "不讽刺、不说教、不自贬。"));
  if (Array.isArray(spec.samples) && spec.samples.length) {
    L.push("[说话方式参考，不要照抄] " + spec.samples.join(" ／ "));
  }
  L.push("");
  L.push("[本次任务] " + String((a && a.task) || "").slice(0, PERSONA_TASK_MAX));
  L.push("");
  L.push("一次生成四段，严格按下面的 JSON 输出，不要解释、不要代码块：");
  L.push('{"steps":["…","…","…"],"done":"…","fail":"…"}');
  L.push("steps：任务执行中说的三句，每句不超过 18 字，只说「正在做的事」；不知道具体文件名就不要编；");
  L.push("done：成功后收尾一句；");
  L.push("fail：失败后一句 —— 先承认这确实让人挫败，再给一个具体的小肯定；禁止说「没事」「小问题」「别想太多」。");
  return L.join("\n");
}

function parsePersonaJson(raw) {
  const s = String(raw || "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  let o;
  try { o = JSON.parse(s.slice(i, j + 1)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const arr = Array.isArray(o.steps) ? o.steps : [];
  const steps = arr
    .filter((x) => typeof x === "string" && x.trim())
    .slice(0, 4)
    .map((x) => x.trim().slice(0, 60));
  const done = typeof o.done === "string" ? o.done.trim().slice(0, 80) : "";
  const fail = typeof o.fail === "string" ? o.fail.trim().slice(0, 80) : "";
  if (!steps.length && !done && !fail) return null;
  return { steps, done, fail };
}

/** 调用户自己填的 OpenAI 兼容接口。只用于台词，不接管主任务。 */
async function callCustomChat(custom, sys, usr, timeoutMs) {
  const base = String(custom.baseUrl || "").replace(/\/+$/, "");
  if (!base || !custom.key || !custom.model) throw new Error("自定义模型配置不完整");
  const url = /\/chat\/completions$/i.test(base) ? base : base + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + custom.key },
    body: JSON.stringify({
      model: custom.model,
      temperature: 0.75,
      max_tokens: 500,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let t = "";
    try { t = (await res.text()).slice(0, 160); } catch {}
    throw new Error("HTTP " + res.status + (t ? " " + t : ""));
  }
  const j = await res.json();
  const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof t !== "string" || !t.trim()) throw new Error("自定义模型返回空内容");
  return t;
}

/** 读主进程写入的自定义模型配置（路径由 main.js 通过 ORB_CM_FILE 注入）。
 *  走文件而不是走参数：明文 key 因此永远不进渲染层、也不经过本地 HTTP。 */
function readCustomModel() {
  const f = process.env.ORB_CM_FILE;
  if (!f) return null;
  try {
    const o = JSON.parse(fsSync.readFileSync(f, "utf8")) || {};
    if (!o.baseUrl || !o.key || !o.model) return null;
    return {
      baseUrl: String(o.baseUrl),
      key: String(o.key),
      model: String(o.model),
      name: String(o.name || ""),
    };
  } catch {
    return null;
  }
}

async function runPersonaBundle(a) {
  const t0 = Date.now();
  const sys = "你是一个只会说话的桌面伙伴角色。严格遵守给定人格的语言规则，只输出要求的 JSON。";
  const usr = buildPersonaPrompt(a);
  const custom = readCustomModel() || (a && a.custom && typeof a.custom === "object" ? a.custom : null);

  /* 1) 自定义模型优先：更快、不占 CLI 会话额度 */
  if (custom && custom.baseUrl && custom.key && custom.model) {
    try {
      const p = parsePersonaJson(await callCustomChat(custom, sys, usr, 9000));
      if (p) return Object.assign({ ok: true, src: "custom", ms: Date.now() - t0 }, p);
      return { ok: false, error: "自定义模型输出不是可解析的 JSON", src: "custom", ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200), src: "custom", ms: Date.now() - t0 };
    }
  }

  /* 2) 退回 CLI。中文不能走 argv（Windows 下会被按 GBK 转码弄坏），
     所以整段要求写进临时文件，用 --system-prompt-file 传。
     cwd 指向临时目录：避免 CLI 读到项目 AGENTS.md 把人格盖掉。 */
  const cli = await resolveWbCli();
  if (!cli.found) return { ok: false, error: cli.hint || CLI_HINT_MISSING, src: "cli", ms: Date.now() - t0 };
  const tmpDir = process.env.TEMP || process.env.TMP || HERE;
  const tmp = path.join(tmpDir, "orb-persona-" + process.pid + "-" + t0 + ".txt");
  try {
    fsSync.writeFileSync(tmp, usr, "utf8");
  } catch (e) {
    return { ok: false, error: "写临时提示文件失败：" + String((e && e.message) || e), src: "cli", ms: Date.now() - t0 };
  }
  try {
    const port = await freePort();
    const text = await new Promise((resolve, reject) => {
      const child = execFile(
        cli.path,
        [
          "-p", "按系统提示的要求生成四段台词 JSON。",
          "--port", String(port),
          "--output-format", "text",
          "--system-prompt-file", tmp,
          "--permission-mode", "bypassPermissions",
          ...((WB_MODEL || "").trim() ? ["--model", WB_MODEL.trim()] : []),
        ],
        { timeout: 25000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: cleanCliEnv(), cwd: tmpDir },
        (err, stdout) => {
          const out = String(stdout || "").trim();
          if (out) return resolve(out);
          return reject(new Error(String((err && err.message) || "CLI 无输出").slice(0, 160)));
        },
      );
      trackProc(child);
    });
    const p = parsePersonaJson(text);
    if (p) return Object.assign({ ok: true, src: "cli", ms: Date.now() - t0 }, p);
    return { ok: false, error: "输出不是可解析的 JSON", src: "cli", ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200), src: "cli", ms: Date.now() - t0 };
  } finally {
    try { fsSync.unlinkSync(tmp); } catch {}
  }
}

/** 找一个当前空闲的本地端口，避免 codebuddy 默认去绑 58449 与正在运行的
 *  WorkBuddy 桌面端冲突（冲突会导致 -p / ACP / --serve 全部卡死）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function spawnOnce(task, timeoutMs, model, cliPath = "") {
  if (!task.trim()) throw new Error("workbuddy_execute 需要一个 task 参数");

  // 兜底：正常路径上 runWorkbuddy 已经校验过；这里再查一次，防止将来有人
  // 直接调 spawnOnce 时拉起一个不存在的可执行文件。
  const cli = await resolveWbCli();
  if (!cli.found) throw new Error(cli.hint || CLI_HINT_MISSING);
  const cliExe = cliPath || cli.path;

  // 关键：显式指定一个空闲端口。codebuddy 启动时总会尝试绑一个内部 HTTP 服务，
  // 默认端口 58449 正被用户运行的 WorkBuddy 桌面端占用，撞上 EADDRINUSE 会让整个
  // 进程卡死（表现为 -p 无输出、ACP session/new 永不回、--serve 的 run 不执行）。
  // 指定 --port 后该冲突消失，进程能正常跑完。
  const port = await freePort();

  // CLI 是原生 .exe 就直接执行；若被覆盖成 .js/.mjs 脚本则用 node 起。
  const viaNode = /\.(m?js)$/i.test(cliExe);
  const file = viaNode ? NODE_EXE : cliExe;
  const argv = [
    ...(viaNode ? [cliExe] : []),
    "-p", task,
    "--port", String(port),
    // 必须用 text：json 输出是「整段会话流水」（含 reasoning / snapshot / 各轮 message），
    // 直接回显那个数组的话，面板会刷出一大坨 JSON 而不是回答正文。
    "--output-format", "text",
    // 后台无人值守，不能卡在权限确认上；与 dsh 轨道的「直接干活」语义对齐。
    "--permission-mode", "bypassPermissions",
    // 单次指定的 model 优先，其次才用环境变量里的默认值
    ...((model || WB_MODEL).trim() ? ["--model", (model || WB_MODEL).trim()] : []),
    ...(WB_EFFORT ? ["--effort", WB_EFFORT] : []),
    ...(WB_MAX_TURNS ? ["--max-turns", WB_MAX_TURNS] : []),
  ];

  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      argv,
      {
        timeout: timeoutMs,
        // 8MB：输出是纯正文（AI 回复 / 命令结果），64MB 纯属给 maxBuffer 事件
        // 留出把整个进程内存顶爆的空间；真超了 8MB 本来就该判失败而不是硬吞。
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        // 剔除桌面端注入的端口变量，避免子进程抢桌面端口（见 cleanCliEnv 注释）
        env: cleanCliEnv(),
        cwd: process.env.ORB_WB_CWD || path.join(HERE, ".."),
      },
      (err, stdout, stderr) => {
        /* execFile 的 timeout 只 TerminateProcess **父进程** —— CLI 拉起的孙进程会
           变孤儿继续跑。所以在这里补一刀树杀。
           ⚠️ 不能改用"超时 + 500ms 的定时器"：timeout 一到 exit 立刻就来了
           （实测 timeoutMs+16ms），定时器会先被 exit 清掉，等于什么都没做。 */
        if (err && (err.killed || err.signal)) killProcTree(child);
        // CLI 非零退出时也可能已在 stdout 里产出结果，优先取 stdout。
        const out = String(stdout || "").trim();
        if (!out) {
          const detail = String(stderr || err?.message || "").trim();
          // 未登录是最常见的失败：直接把「怎么修」给到面板，而不是只回一句英文报错。
          // 这里与「没装 CLI」是两种状态，文案必须严格区分，否则用户装好了还以为没装上。
          if (/Authentication required|Please use \/login|not logged in|unauthorized/i.test(detail)) {
            wbCliAuth = "not-logged-in";
            return reject(new Error(CLI_HINT_LOGIN));
          }
          return reject(new Error(`CodeBuddy CLI 无输出：${detail}`));
        }
        wbCliAuth = "ok";   // 真实调用成功过一次，登录态才算确认
        resolve({ content: [{ type: "text", text: extractAnswer(out) }], isError: false });
      },
    );
    trackProc(child);   // 登记进活动表：急停时连它一起杀（后台 AI 任务就靠这个能停住）
    registerChild(child.pid, "cli");
  });
}


const SERVERS = {
  windows: {
    label: "windows-mcp",
    // 随包运行时没有 pip / venv，也不该在用户机器上跑 pip，所以改成 `-m windows_mcp`
    // 直接加载已随包装好的包：零安装、零网络（参数与环境变量都由 runtime.mjs 统一给）。
    command: WINDOWS_MCP,
    args: windowsMcpArgs(),
    // 遥测三道闸 + pillow 截图后端都在这里（详见 runtime.mjs 的 windowsMcpEnv 注释）
    env: windowsMcpEnv(),
  },
  // WorkBuddy 后台：非 MCP，而是直接拉起 CodeBuddy CLI（见 runWorkbuddy）。
  workbuddy: { label: "workbuddy", kind: "cli" },
};

/* dsh 通道**默认不注册**：它是历史遗留通道，面板早已不走它（后台改走 CodeBuddy CLI），
 * 且依赖某个具体用户家目录下的凭据与 node_modules —— 开源携带别人家目录既不体面，
 * 在别人机器上也永远起不来，只会白占一个常驻 node 进程。
 * 需要它时设环境变量 ORB_ENABLE_DSH=1 显式开启。 */
if (process.env.ORB_ENABLE_DSH === "1") {
  SERVERS.dsh = {
    label: "dsh",
    // lazy：**不参与 /api/status 的预热连接**。
    // status 会遍历所有 SERVER 去 listTools，不标记 lazy 就会每次开面板白拉起一个进程。
    // 标记后只有真正 /api/call 到 dsh 时才连接。
    lazy: true,
    command: NODE_EXE,
    args: [DSH_MCP],
    env: {
      ...process.env,
      DSH_ROOT,
      DSH_HOME,
      // dsh-mcp 启动时硬性检查这个变量，没有就直接报错退出。
      // 值从 .credentials.yaml 读，不硬编码在代码里。
      ...(DSH_API_KEY ? { DEEPSEEK_API_KEY: DSH_API_KEY } : {}),
      ...(DSH_CSCS_KEY ? { CSCS_API_KEY: DSH_CSCS_KEY } : {}),
    },
  };
}

const sessions = new Map();
const connecting = new Map();
/* 连接失败退避：key -> 最早重试时间戳。
 * 面板每 5 秒轮询一次 /api/status，如果某个 MCP server 起不来，
 * 没有退避就会变成"每 5 秒重连一次、每次卡满超时"，CPU 白烧还把 status 拖慢。 */
const SESSION_BACKOFF_MS = 30_000;
const sessionBackoff = new Map();

function isBroken(err) {
  const m = String(err?.message ?? err);
  return /closed|ECONNRESET|EPIPE|not connected|socket hang up|terminated/i.test(m);
}

/**
 * 销毁某个 server 的会话：先从 map 摘掉，再真正 close 掉 client/transport。
 * 只 delete 不 close 会让 MCP 子进程变成孤儿进程，越堆越多，
 * 最终表现为整台机器"用久了就卡死"。
 */
function disposeSession(key) {
  const s = sessions.get(key);
  sessionBackoff.delete(key);   // 主动断开就清退避，让下次调用能立刻重连
  if (!s) return;
  sessions.delete(key);
  try { s.client?.close?.(); } catch {}
  try { s.transport?.close?.(); } catch {}
}

/** 所有会话统一收尾（进程退出时调用，避免留下孤儿 MCP 子进程） */
function disposeAllSessions() {
  for (const key of [...sessions.keys()]) disposeSession(key);
}

/* ══════════ 子进程台账：防止孤儿堆积 ══════════
 * 问题：bridge 被**强杀**（taskkill /F、崩溃、任务管理器结束进程）时收不到 SIGTERM，
 *   shutdown() 根本来不及跑，它拉起的 MCP / ASR 子进程就留在系统里变成孤儿。
 *   实测这台机器上挂着 3 份 windows-mcp（每份 153MB）+ 1 份 dsh-mcp，全都没父进程。
 * 解法：拉起的每个子进程都记进台账；下次 bridge 启动时先按台账清一遍。
 *   台账按**端口**命名 —— 同机跑多个 bridge（离线单测就是）时互不误伤。 */
/* 落 DATA_DIR：装目录在打包态可能不可写，台账写不进去 = 孤儿回收失效。
   读时回退旧位置（HERE），老版本升级上来不会把已有台账当成没有。 */
const CHILD_REG = path.join(DATA_DIR, `.children-${PORT}.json`);
const CHILD_REG_OLD = path.join(HERE, `.children-${PORT}.json`);

function readChildReg() {
  /* 先读 DATA_DIR 的新位置，再回退装目录的旧位置：老版本升级上来时
     不能把已经存在的台账当成"没有"（那会让上一批孤儿无人回收）。 */
  for (const f of [CHILD_REG, CHILD_REG_OLD]) {
    try {
      const a = JSON.parse(fsSync.readFileSync(f, "utf8"));
      if (Array.isArray(a)) return a;
    } catch { /* 这一份没有/坏了，看下一份 */ }
  }
  return [];
}
function writeChildReg(arr) {
  try { writeJsonAtomic(CHILD_REG, arr.slice(-60), 0); } catch { /* ignore */ }
}
function registerChild(pid, kind) {
  if (!pid) return;
  const a = readChildReg().filter((x) => x && x.pid !== pid);
  // owner 记下是谁拉起的：回收时靠它区分「孤儿」和「另一个控制台实例正在用的」。
  // 没有这个字段时，同机开两个控制台，后启动的会把前一个的 ASR / windows-mcp 一起杀掉。
  a.push({ pid, kind: kind || "child", at: Date.now(), owner: process.pid });
  writeChildReg(a);
}

/* 台账里记的是 PID，而 **PID 会被系统回收再利用**：
   跨一次重启、或者上一次 ORB 已经是很久以前的事，台账里那个号完全可能
   已经属于某个别的程序。原来的实现是拿出来就 taskkill /F，那是在赌博。
   所以杀之前先做两道核对：记录时间不能太老、进程名必须和 kind 对得上。 */
/* ⚠️ 前台通道改成 `python -m windows_mcp` 之后，它的映像名变成了 python.exe，
   和 ASR / 实时字幕**一模一样**。再按映像名核对，就会把上一个实例的 ASR
   当成前台孤儿杀掉（本项目以前真踩过这个坑）。
   所以改成按**命令行子串**识别（规则表在 runtime.mjs 的 PROC_KIND_MATCHERS）。
   KIND_IMAGES 只保留给「拿不到命令行」时的兜底粗筛：此时宁可放过，不妄杀。 */
const KIND_IMAGES = {
  windows: ["python.exe", "python", "windows-mcp.exe"],
  dsh: ["node.exe"],
  cli: ["codebuddy.exe"],
  asr: ["python.exe", "python"],
  rt: ["python.exe", "python"],
};
const REAP_MAX_AGE_MS = 7 * 86400000;

/** 一次拿到 PID -> { name, cmd }（Windows 走 CIM 取命令行；拿不到就只回映像名）。 */
function pidInfoMap() {
  return new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | "
      + "Select-Object ProcessId,Name,CommandLine | "
      + "ConvertTo-Csv -NoTypeInformation",
    ], { timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (_err, stdout) => {
      const m = new Map();
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const cols = line.match(/"[^"]*"/g);
        if (!cols || cols.length < 3) continue;
        const pid = Number(cols[0].replace(/"/g, ""));
        const name = cols[1].replace(/"/g, "").toLowerCase();
        const cmd = cols[2].replace(/^"|"$/g, "");
        if (Number.isFinite(pid)) m.set(pid, { name, cmd });
      }
      resolve(m);
    });
  });
}

/** 一次 tasklist 拿到本机 pid -> 进程名（拿不到时返回空表，调用方据此放弃回收） */
function pidImageMap() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FO", "CSV", "/NH"], {
      timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }, (_err, stdout) => {
      const m = new Map();
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const cols = line.match(/"[^"]*"/g);
        if (!cols || cols.length < 2) continue;
        const name = cols[0].slice(1, -1).toLowerCase();
        const pid = Number(cols[1].slice(1, -1));
        if (name && Number.isFinite(pid)) m.set(pid, name);
      }
      resolve(m);
    });
  });
}

/** PID 是否还活着（优先复用已拿到的 tasklist 名单；非 Windows 用 signal 0 探） */
function pidAlive(pid, images) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (images) return images.has(p);
  try { process.kill(p, 0); return true; } catch { return false; }
}

/** 清掉上一次遗留的子进程：**只杀台账里记过、且核对无误的 PID**。 */
async function reapStaleChildren() {
  const a = readChildReg();
  if (!a.length) return 0;
  const now = Date.now();
  // 优先取带命令行的名单（前台/ASR 现在都是 python.exe，只能靠命令行区分）；
  // PowerShell 拿不到就退回到只看映像名的粗名单。
  let infos = process.platform === "win32" ? await pidInfoMap() : null;
  let images = infos && infos.size
    ? new Map([...infos].map(([pid, v]) => [pid, v.name]))
    : (process.platform === "win32" ? await pidImageMap() : null);
  if (infos && !infos.size) infos = null;      // 空表等同没拿到，交给粗筛
  if (images && !images.size) {
    // 拿不到进程名单就什么都别杀：认不出身份的 PID 一律放过，孤儿下次再清
    log("[gc] 无法获取进程名单，跳过本次回收");
    return 0;
  }
  const killed = [];
  const skipped = [];
  // taskkill 改成 await：原来是 fire-and-forget，杀完立刻接 asrEnsure 时，
  // 旧服务的端口可能还没释放、health 也还响应得过来，于是"以为还在跑"就不拉新的，
  // 紧接着旧进程真死了 → 面板显示服务未运行。
  const killPid = (pid) => new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 8000 }, () => resolve());
    } else {
      try { process.kill(pid, "SIGKILL"); } catch { /* 早就没了 */ }
      resolve();
    }
  });
  for (const x of a) {
    if (!x || !x.pid) continue;
    // ① 太老的记录不认：那是若干天/若干次重启以前的事，PID 早就换了主人
    if (!Number.isFinite(x.at) || now - x.at > REAP_MAX_AGE_MS) continue;
    // ② 身份核对：有命令行就按命令行子串严格判断（python.exe 之间才能分辨清楚）；
    //    只有拿不到命令行时才退回映像名粗筛。
    if (images) {
      const name = images.get(Number(x.pid));
      const want = KIND_IMAGES[x.kind];
      if (!name || (want && !want.includes(name))) continue;
      if (infos) {
        const cmd = infos.get(Number(x.pid))?.cmd || "";
        const verdict = matchProcKind(cmd, x.kind);
        // verdict 为 null = 认不出（没规则 / 没命令行）→ 放过，不赌
        if (verdict === false) continue;
      }
    }
    // ③ owner 还活着、且不是自己 → 是**另一个控制台实例**正在用的，跳过。
    //    实测踩过：两个窗口同时开着，后启动的这个把前一个的 ASR 杀了，
    //    前一个面板上"识别服务"和前台通道同时变成未运行，且查不出原因。
    if (x.owner && Number(x.owner) !== process.pid && pidAlive(x.owner, images)) {
      skipped.push(`${x.kind}#${x.pid}(属 #${x.owner})`);
      continue;
    }
    await killPid(Number(x.pid));
    killed.push(`${x.kind}#${x.pid}`);
  }
  // 只清掉自己这条线：被跳过的条目还要留着，等它 owner 死了再回收
  writeChildReg(a.filter((x) => skipped.some((s) => s.startsWith(`${x.kind}#${x.pid}(`))));
  log(`[gc] 回收遗留子进程 ${killed.length}/${a.length} 个：${killed.join(", ") || "(无需回收)"}`
    + (skipped.length ? `；跳过 ${skipped.length} 个（其他实例在用）：${skipped.join(", ")}` : ""));
  return killed.length;
}

/** 从 MCP transport 里挖出子进程 PID（SDK 内部属性，取不到就算了） */
function transportPid(t) {
  return t?._process?.pid ?? t?.process?.pid ?? t?.child?.pid ?? 0;
}

/* ---------------- 前台通道自检 / 修复 ----------------
 * 症状：面板里 windows-mcp 显示「连接失败」，截图/点击/键盘全不可用。
 *
 * 两种根因（**现在要分开看**）：
 *   A. 随包运行时（orb/runtime/python）缺失或没带上 —— 发布包不完整 / 开发态没构建。
 *      这种情况**不可自动修复**：随包运行时是构建期产物，用户机器上既没 pip 也不该联网。
 *      只能提示重新下载完整安装包（或开发态跑 build-runtime.ps1）。
 *   B. 解释器来自系统（ORB_PY_EXE / ORB_BASE_PY / PATH），里面没装 windows-mcp。
 *      这种情况**可以自动修复**：沿用原来的 venv + pip 安装路径。
 */

/** 解释器在不在 */
function venvPythonOk() {
  try { return !!VENV_PY && fsSync.existsSync(VENV_PY); } catch { return false; }
}
/** 基础 Python 在不在（遗留 venv 修复路径的前提） */
function basePythonOk() {
  try { return !!BASE_PY && fsSync.existsSync(BASE_PY); } catch { return false; }
}
/** 前台通道自检结果，供 /api/status 和设置面板显示 */
function frontHealth() {
  const py = resolvePython();
  const exe = py.ok;                       // 现在"那个可执行文件"就是解释器本身
  const pkg = py.ok && hasWindowsMcp(py);  // 解释器在，但包没装 → missing-exe
  const base = basePythonOk();
  const connected = sessions.has("windows");
  let state = "ok";
  if (!exe) state = "missing-venv";        // 连解释器都没有
  else if (!pkg) state = "missing-exe";    // 有解释器，没装 windows-mcp
  else if (!connected) state = "not-connected";
  return {
    state,
    exe: py.exe,
    exeExists: exe,
    venvExists: py.ok,
    basePythonExists: base,
    connected,
    packageExists: pkg,
    // 随包运行时是构建期产物，**不可在用户机器上重建**；
    // 只有解释器来自系统（env / base-py / path）时才走 pip 修复。
    repairable: py.ok && py.source !== "bundled" && base,
    source: py.source,
    hint: py.ok ? "" : py.hint,
  };
}

/** 轻量重连：只重置会话，不动运行时。
 *  「组件都在、只是 MCP 会话断了」（not-connected）时这一步就足够，毫秒级见效，
 *  而且**对随包运行时同样有效** —— 这是发布包用户唯一够得着的「修复」。
 *  注意必须走 disposeSession：session 对象没有 close 方法，只删 map 引用
 *  会把 windows-mcp 子进程留成孤儿（见 afterInstall 里的同款注释）。 */
function reconnectFront(steps) {
  const push = (s) => { steps.push(s); log("[repair]", s); };
  try {
    disposeSession("windows");
    connecting.delete("windows");
    sessionBackoff.delete("windows");
  } catch { /* ignore */ }
  push("已重置前台连接，下次调用会自动重连");
  return { ok: true, mode: "reconnect", steps, health: frontHealth() };
}

/** 执行修复。三档，按真实状态分流，别让用户陪跑：
 *  ① 组件在、只是会话断（not-connected）→ 轻量重连（任何运行时来源都走这条，
 *     不为这点事去跑 10-15 分钟的 pip）；
 *  ② 随包运行时缺东西（解释器 / windows-mcp 不在）→ 拒绝：构建期产物不可重建，
 *     只能重新下载完整安装包（或开发态重跑 build-runtime.ps1）；
 *  ③ 解释器来自系统且没装 windows-mcp → 重建 venv + pip 安装（遗留修复路径，
 *     开发态 / WorkBuddy venv 被更新清掉的场景）。 */
function repairFront() {
  return new Promise((resolve) => {
    const steps = [];
    const push = (s) => { steps.push(s); log("[repair]", s); };

    const py = resolvePython();
    const pkg = py.ok && hasWindowsMcp(py);
    const connected = sessions.has("windows");

    if (py.ok && pkg && !connected) {
      push("组件已就位、会话未连上：走轻量重连（不重装）");
      resolve(reconnectFront(steps));
      return;
    }

    if (py.ok && py.source === "bundled") {
      /* 用的是随包运行时且缺东西：它是构建期产物，里面没有 pip、也不该在用户机器上
         联网装包。这里明确说"不能修"并给出可执行建议，而不是去跑一次注定失败的 pip。 */
      push("当前使用随包运行时（构建期产物），不支持在线修复");
      resolve({
        ok: false,
        error: "前台通道使用随包运行时，无法在线修复；"
          + "若持续不可用，说明发布包不完整，请重新下载完整的 ORB 控制台安装包。"
          + "（开发态请运行 orb\\native\\build-runtime.ps1 重新构建运行时。）",
        steps,
        health: frontHealth(),
      });
      return;
    }

    if (!basePythonOk()) {
      resolve({ ok: false, error: "基础 Python 不存在，无法自动修复。请在 WorkBuddy 里跑一次任务重建环境，或用 ORB_PY_EXE 指向一个 python.exe。", steps });
      return;
    }

    const run = (cmd, args, cb) => {
      // 关键：剔除代理环境变量。
      // WorkBuddy 会注入 http_proxy=127.0.0.1:xxxx，pip 走这个代理访问 pypi 会 502；
      // 直连（阿里云源）反而通。用 env 覆盖比传 "--proxy ''" 更稳（后者会被当成空值参数）。
      const env = { ...process.env };
      for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
        delete env[k];
      }
      // 超时给足 20 分钟：实测冷装 windows-mcp 要拉 90+ 个包（含 pillow/numpy/pywin32
      // 等大轮子），慢的时候能跑 12 分钟以上。给小了会中途被杀、留下半成品 venv。
      execFile(cmd, args, { timeout: 1_200_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env },
        (err, stdout, stderr) => cb(err, String(stdout || ""), String(stderr || "")));
    };

    const afterInstall = () => {
      if (!hasWindowsMcp(py)) {
        resolve({ ok: false, error: "安装完成但仍未找到 windows_mcp 包", steps });
        return;
      }
      // 断开旧的坏 session，让下一次 /api/call 或 /api/status 重新连接
      try {
        /* 原来写的是 `sessions.get("windows").close()`。session 对象是
           { client, transport, tools }，**没有 close 方法** —— typeof 检查恒为 false，
           于是只删掉了 map 里的引用，windows-mcp 子进程原封不动地活着变成孤儿。
           修复流程本身反而制造孤儿进程，必须走 disposeSession。 */
        disposeSession("windows");
        connecting.delete("windows");
        sessionBackoff.delete("windows");
      } catch { /* ignore */ }
      push("已重置前台连接，下次调用会自动重连");
      resolve({ ok: true, steps, health: frontHealth() });
    };

    const install = () => {
      push("安装 windows-mcp（阿里云源）...");
      run(VENV_PY, ["-m", "pip", "install", "--upgrade", "--no-cache-dir",
        "-i", PIP_INDEX, "windows-mcp"], (err, out, errOut) => {
        if (!err) { push("安装成功"); afterInstall(); return; }
        push("阿里源失败，改用官方源重试...");
        run(VENV_PY, ["-m", "pip", "install", "--upgrade", "--no-cache-dir",
          "-i", "https://pypi.org/simple", "windows-mcp"], (e2, o2, e2Out) => {
          if (e2) {
            resolve({ ok: false, error: "两个源都安装失败：" + (errOut || err.message).slice(-500), steps });
            return;
          }
          push("安装成功（官方源）");
          afterInstall();
        });
      });
    };

    if (venvPythonOk()) {
      push("venv 已存在，跳过创建");
      install();
    } else {
      push("重建虚拟环境...");
      run(BASE_PY, ["-m", "venv", VENV_DIR], (err, out, errOut) => {
        if (err) {
          resolve({ ok: false, error: "重建 venv 失败：" + (errOut || err.message).slice(-500), steps });
          return;
        }
        push("venv 已重建");
        install();
      });
    }
  });
}

/* ---------------- 工作流录制 / 回放 ----------------
 * 目标：把「录一遍 → 一键重放」做出来，固定流程不再消耗 AI 调用。
 * 落盘：<控制台>/workflows/<名称>.json
 * 录制原理：录制期间拦截每一次 /api/call，把 (tool, args) 原样记下来；
 *          回放时按序重放，中间留出间隔（UI 需要时间响应）。
 * 说明：只读工具（Snapshot/Screenshot）默认也录，但可按 skipRead 跳过，
 *      避免回放时因"多看一眼"把节奏拖慢。
 */
/* 工作流目录跟着 DATA_DIR 走：桥与面板共用同一处，
   避免「桥写包内、面板读 APPDATA」分叉（DATA_DIR 的定义见文件头部）。 */
const WORKFLOW_DIR = path.join(DATA_DIR, "workflows");
const READ_TOOLS_FOR_REC = new Set(["Snapshot", "Screenshot", "DisplayInventory", "Process"]);

const REC = { on: false, name: "", steps: [], startedAt: 0, pendingWinCaps: [] };

/**
 * 去重兜底：抑制窗口之外偶尔还是会有"ORB 自己发起的操作被钩子又记一遍"。
 * 判据很明确 —— 相邻两步内容相同，且前一步是 wfCapture 记的、后一步是钩子记的。
 * 用户**真的**连点两次不会误删（clicks 不同，args 就不相同）。
 */
function dedupeRecSteps(steps) {
  const out = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (prev && s.hook && !prev.hook && prev.tool === s.tool
        && JSON.stringify(prev.args) === JSON.stringify(s.args)) {
      continue;
    }
    out.push(s);
  }
  if (out.length !== steps.length) {
    console.log(`[rec] 去重：${steps.length} → ${out.length} 步`);
  }
  return out.map(({ hook, ...rest }) => rest);   // hook 只是内部标记，不落盘
}

/* 全局鼠标钩子：懒加载 + 失败即降级（false 表示"确认不可用"，别反复重试）。 */
let MOUSE_HOOK = null;
async function getMouseHook() {
  if (MOUSE_HOOK !== null) return MOUSE_HOOK || null;
  try {
    MOUSE_HOOK = await import("./mousehook.mjs");
  } catch (e) {
    MOUSE_HOOK = false;
    log("[hook] 模块不可用：", (e && e.message) || e);
  }
  return MOUSE_HOOK || null;
}

function wfSafeName(s) {
  return String(s || "workflow").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "workflow";
}
function wfFile(name) {
  return path.join(WORKFLOW_DIR, wfSafeName(name) + ".json");
}
function wfList() {
  try {
    return fsSync.readdirSync(WORKFLOW_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const j = JSON.parse(fsSync.readFileSync(path.join(WORKFLOW_DIR, f), "utf8"));
          return { name: j.name, steps: (j.steps || []).length, savedAt: j.savedAt };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

/** 录制中：把一次工具调用追加进步骤表 */
function wfCapture(server, tool, args) {
  if (!REC.on) return;
  REC.steps.push({
    server, tool,
    args: args ?? {},
    wait: 0,                       // 回放时该步之前额外等待(ms)，MVP 先留 0
  });
}

/* ---------------- 任务编排执行器 ----------------
 * 让工作流会判断、会循环、能带参数。节点类型：
 *   action（默认，兼容老工作流）/ set（变量赋值）/ loop（次数或条件）/ if（then-else）
 * 字符串里写 {{变量名}} 会被插值替换。
 * **两道防跑飞保险**：嵌套深度上限、while 循环最大轮数上限 ——
 * 编排最容易出的灾难就是"条件永远成立 → 无限循环把机器跑满"。
 */
const MAX_DEPTH = 8;
const MAX_WHILE = 500;

/* ---------------- 急停（Kill Switch） ----------------
 * 自动化跑飞时唯一能救命的东西。设计取向：**宁可误停，不可漏停**。
 *  · 检查点放在"每一步之前"，所以最多再多走一步就停下
 *  · 急停时**连触发器一起卸掉** —— 否则定时/文件触发器还会继续点火
 *  · 停下后必须**手动恢复**：避免条件重新满足就自己又跑起来（那才是真灾难）
 */
const STOP = { on: false, at: 0, reason: "" };

/* 在跑的子进程登记表。
 * 为什么需要：急停只把 JS 层的循环停下来，但**已经 spawn 出去的子进程还在跑**
 * （最典型的是后台 AI 的 CodeBuddy CLI），那才是真正失控的东西。
 * Windows 上必须用 taskkill /T 连同**子进程树**杀 —— CLI 会拉起孙进程，
 * 只 kill 父进程的话孙进程会变孤儿继续跑。 */
const activeProcs = new Set();

function trackProc(p) {
  if (!p || typeof p.once !== "function") return p;
  activeProcs.add(p);
  const done = () => activeProcs.delete(p);
  p.once("exit", done);
  p.once("error", done);
  return p;
}

/** 杀**进程树**：Windows 上只 kill 父进程，CLI 拉起的孙进程会变孤儿继续跑。 */
function killProcTree(p) {
  if (!p || !p.pid) return;
  try {
    if (process.platform === "win32") execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], () => {});
    else p.kill("SIGKILL");
  } catch { /* 已经退了 */ }
}
function killActiveProcs() {
  let n = 0;
  for (const p of activeProcs) {
    try {
      if (process.platform === "win32" && p.pid) {
        execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], () => {});
      } else {
        p.kill("SIGKILL");
      }
      n++;
    } catch {}
  }
  activeProcs.clear();
  return n;
}

/* 注：原先这里有个 checkStop()，只在 runSteps 里被调用一次，
 * 导致急停拦不住单次工具调用。检查逻辑已内联到 callToolRaw 入口，
 * 那里能一次性覆盖回放 / 单次 / 后台 / 危险确认四条路径。 */

/* 在途的 MCP 调用计数：key -> 数量。
 * 为什么需要它：MCP 工具（比如一条跑很久的 PowerShell、一次大范围 Snapshot）
 * 是在 **MCP server 子进程内部**执行的，bridge 这边只是 await，kill 不到它。
 * 唯一能真正中断的办法是**把连接断掉** —— stdio 一关，子进程收到 EOF 退出，
 * 卡在 callTool 上的 Promise 立刻 reject，工作流也就停下来了。
 * 但断连代价不小（下次调用要重连、要几秒），所以**只在确实有在途调用时才断**。 */
const inflightMcp = new Map();
const inflightTotal = () => [...inflightMcp.values()].reduce((a, b) => a + b, 0);

/** 急停时中断正在跑的 MCP 调用：断连接 → 子进程 EOF 退出 → Promise reject。
 *  返回断掉的 server 名单，供面板显示"停掉了什么"。 */
function killInflightMcp() {
  const busy = [...inflightMcp.keys()];
  if (!busy.length) return [];
  // 先把 PID 抓出来（dispose 之后 transport 上的引用就没了）
  const pids = [];
  for (const key of busy) {
    const t = sessions.get(key)?.transport;
    const pid = t?._process?.pid ?? t?.process?.pid ?? t?.child?.pid;
    if (pid) pids.push(pid);
    disposeSession(key);   // 会 close client + transport
  }
  // MCP server 可能自己还拉起过孙进程，close 不保证全清干净 —— 补一刀。
  // 原来每个 PID 起一个 taskkill 进程：急停时常见 3~5 个在途调用，
  // 等于在最不该卡的时候连开 3~5 个进程。taskkill 支持一次喂多个 /PID，合并成一次。
  if (pids.length) {
    const args = [];
    for (const pid of pids) args.push("/PID", String(pid));
    args.push("/T", "/F");
    try { execFile("taskkill", args, { timeout: 8000 }, () => {}); } catch { /* ignore */ }
  }
  console.log("[stop] 中断在途 MCP 调用：", busy.join(", "), pids.length ? `（taskkill ${pids.join(",")}）` : "");
  return busy;
}

function doStop(reason) {
  STOP.on = true;
  STOP.at = Date.now();
  STOP.reason = reason || "手动急停";
  console.log(`[stop] 急停生效：${STOP.reason}`);
  try { disarmTriggers(); } catch {}
  const killed = killActiveProcs();     // 关键：连正在跑的子进程一起干掉
  console.log(`[stop] 已终止 ${killed} 个在跑的子进程`);
  // MCP 内部的长任务：没有在途调用就不动它，避免误触后每次操作都要重连
  const mcpCut = killInflightMcp();
  return { on: STOP.on, at: STOP.at, reason: STOP.reason, killed, mcpCut };
}

function doResume() {
  STOP.on = false;
  STOP.reason = "";
  console.log("[stop] 已恢复");
  try { armTriggers(); } catch {}
  return { on: STOP.on };
}

/* ---------------- 执行审计日志 ----------------
 * 记录"谁、何时、做了什么、结果如何"。出问题能回溯，也是合规的基础。
 * 落盘 <控制台>/audit/YYYY-MM-DD.jsonl（按天分文件、追加写）。
 * 只记**摘要**，不存 result 全文 —— 否则一条截图就能写出几 MB。
 */
const AUDIT_DIR = path.join(DATA_DIR, "audit");
const AUDIT_KEEP_DAYS = 30;
const AUDIT_MEM_MAX = 500;
const AUDIT_MEM = [];          // 内存里留最近若干条，面板查询用（不必读磁盘）
let auditStream = null;
let auditDay = "";

function auditDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function audit(rec) {
  const full = Object.assign({
    ts: Date.now(),
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  }, rec);
  AUDIT_MEM.push(full);
  if (AUDIT_MEM.length > AUDIT_MEM_MAX) AUDIT_MEM.splice(0, AUDIT_MEM.length - AUDIT_MEM_MAX);
  try {
    const day = auditDayKey();
    if (day !== auditDay) {
      if (auditStream) { try { auditStream.end(); } catch {} }
      fsSync.mkdirSync(AUDIT_DIR, { recursive: true });
      auditStream = fsSync.createWriteStream(path.join(AUDIT_DIR, day + ".jsonl"), { flags: "a" });
      // 磁盘满 / 目录变只读时流会抛 'error'：没有监听者就升级成未捕获异常，
      // 一条审计日志写不上去，结果把整个 bridge 带崩。
      auditStream.on("error", (e) => {
        console.log("[audit] 写入失败，本次审计跳过：", e?.message ?? e);
      });
      auditDay = day;
    }
    auditStream.write(JSON.stringify(full) + "\n");
  } catch { /* 审计写失败不能影响主流程 */ }
}

/** 清理超过保留期的审计文件（启动时跑一次） */
function auditCleanup() {
  try {
    const cutoff = Date.now() - AUDIT_KEEP_DAYS * 86400000;
    for (const f of fsSync.readdirSync(AUDIT_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      const t = new Date(f.replace(".jsonl", "") + "T00:00:00").getTime();
      if (Number.isFinite(t) && t < cutoff) {
        try { fsSync.unlinkSync(path.join(AUDIT_DIR, f)); } catch {}
      }
    }
  } catch {}
}

/* ---------------- 执行状态（AI 步骤可视化） ----------------
 * 让"正在跑什么"看得见，而不是黑盒等待。
 * 面板轮询 /api/live 拿这个，渲染成一条进度。 */
const LIVE = {
  active: false, kind: "", name: "", step: 0, total: 0,
  lastTool: "", note: "", startedAt: 0, finishedAt: 0, ok: null,
  /* 智能接管请求。非 null 时说明回放正卡在某一步等视觉层接手，
     面板轮询 /api/status 看到这个字段就去跑 runVision，跑完回调 /api/agent-done。
     为什么绕这一圈：视觉模型的密钥存在主进程（main.js 的 get-vision-key），
     bridge 是独立 Node 进程，拿不到 —— 所以它只能「把活儿挂出去等回答」。 */
  pendingAgent: null,
};

function liveStart(kind, name, total, note) {
  LIVE.active = true; LIVE.kind = kind; LIVE.name = name || "";
  LIVE.step = 0; LIVE.total = total || 0; LIVE.note = note || "";
  LIVE.lastTool = ""; LIVE.startedAt = Date.now(); LIVE.ok = null; LIVE.finishedAt = 0;
  audit({ source: kind, event: "start", name: LIVE.name, total: LIVE.total });
}

function liveStep(i, tool) {
  LIVE.step = i;
  if (tool) LIVE.lastTool = tool;
}

function liveEnd(ok, note) {
  LIVE.active = false; LIVE.ok = !!ok;
  LIVE.finishedAt = Date.now();
  LIVE.pendingAgent = null;          // 回放结束必须清掉，否则面板会一直以为有活儿要接手
  if (note) LIVE.note = note;
  audit({
    source: LIVE.kind || "job", event: "end", name: LIVE.name,
    ok: LIVE.ok, ms: LIVE.finishedAt - LIVE.startedAt, note: LIVE.note,
  });
}

/* ---------------- 智能接管：bridge ⇄ 面板握手 ----------------
 * 一次接管 = 挂出请求 → 阻塞等面板回答。阻塞是必须的：
 * 回放正在半路停下，后面每步都依赖「现在屏幕处于什么状态」，
 * 不能放它继续跑。所以用 promise 挂起，且**必须有超时**——
 * 面板被用户收起时轮询会停，没人接这个活儿，不超时就永远卡死。 */
const WAITER = { agent: null };    // { resolve, reject, timer }
const AGENT_WAIT_MS = 180000;      // 单轮接管最长等 3 分钟（含模型往返）

function askPanelForAgent(payload, timeoutMs = AGENT_WAIT_MS) {
  return new Promise((resolve, reject) => {
    if (WAITER.agent) {             // 上一轮没结算：先拒掉，否则两个 resolve 抢同一个 promise
      try { clearTimeout(WAITER.agent.timer); WAITER.agent.reject(new Error("被新的接管请求覆盖")); } catch { /* ignore */ }
      WAITER.agent = null;
    }
    const timer = setTimeout(() => {
      WAITER.agent = null;
      LIVE.pendingAgent = null;
      reject(new Error(`接管等待超时（${Math.round(timeoutMs / 1000)}s 无回应）`
        + `——面板可能已收起，或视觉模型还没配置`));
    }, timeoutMs);
    WAITER.agent = { resolve, reject, timer };
    LIVE.pendingAgent = payload;
    log(`[agent] 挂出接管请求：第 ${payload.stepNo}/${payload.totalNo} 步，本批 ${payload.batch} 步`);
  });
}

/** 面板回报后结算挂起的 promise。返回是否真的有人等着（没人等就说明超时已过，丢弃即可）。 */
function settleAgent(payload) {
  LIVE.pendingAgent = null;
  const w = WAITER.agent;
  WAITER.agent = null;
  if (!w) return false;
  clearTimeout(w.timer);
  if (payload && payload.ok === false) w.reject(new Error(String(payload.error || "面板接管失败").slice(0, 300)));
  else w.resolve(payload || {});
  return true;
}

/* ---------------- 危险操作确认 ----------------
 * 与急停互补：急停是「事后踩刹车」，这里是「事前拦一下」。
 * 命中 DANGER_TOOLS 的操作会**挂起**等人确认；**无人确认就超时拒绝**——
 * 安全默认必须是"拒绝"，绝不能因为没人管就自动放行。
 */
/* 危险清单改成**可配置**（原来是硬编码的 Set，想加一个得改源码再重启）。
 *
 * 两类规则：
 *   tools  —— 整个工具都危险（命中即拦）
 *   args   —— 只在参数匹配时危险（比如 FileSystem 只有 delete 才拦，
 *              read/list 不该每次都打扰人）
 * 依然**故意不做正则**：正则写歪会把危险命令一起放行，那还不如每次点一下。 */
// ORB_DANGER_FILE 同样只给离线单测用
const DANGER_FILE = process.env.ORB_DANGER_FILE || path.join(DATA_DIR, "danger-tools.json");
const DANGER_DEFAULTS = {
  tools: ["PowerShell"],
  args: { FileSystem: [{ mode: "delete" }] },
};
let DANGER = structuredClone(DANGER_DEFAULTS);
const DANGER_TOOLS = new Set(DANGER.tools);   // 兼容老代码：只放"整工具危险"的那部分

function loadDanger() {
  try {
    const j = JSON.parse(fsSync.readFileSync(DANGER_FILE, "utf8"));
    DANGER.tools = Array.isArray(j?.tools) ? j.tools.map(String) : [...DANGER_DEFAULTS.tools];
    DANGER.args = (j && typeof j.args === "object" && j.args) ? j.args : structuredClone(DANGER_DEFAULTS.args);
  } catch {
    DANGER = structuredClone(DANGER_DEFAULTS);
  }
  DANGER_TOOLS.clear();
  for (const t of DANGER.tools) DANGER_TOOLS.add(t);
}

function saveDanger() {
  try { writeJsonAtomic(DANGER_FILE, DANGER); } catch {}
}

loadDanger();

/** 参数规则命中了吗：任一规则的所有字段都对上才算命中。 */
function dangerByArgs(tool, args) {
  const rules = DANGER.args?.[tool];
  if (!Array.isArray(rules) || !args) return false;
  return rules.some((r) =>
    r && typeof r === "object" &&
    Object.keys(r).every((k) => String(args[k] ?? "").toLowerCase() === String(r[k]).toLowerCase()));
}
const CONFIRM_TIMEOUT_MS = 60000;
const approvals = new Map();                    // id -> { id, server, tool, args, at, timer, resolve }
let confirmSeq = 0;

/* 危险操作白名单：把"反复执行、你信得过"的命令记下来，避免每次都要点确认。
 * 只支持 prefix（前缀）/ exact（完全相同）两种匹配 —— 故意不做正则，
 * 因为正则写歪了会把危险命令一起放行，那还不如每次点一下。 */
const WHITELIST_FILE = process.env.ORB_WHITELIST_FILE || path.join(DATA_DIR, "approvals.json");
/* prefix 模式下存多少字。原来只取 120 —— 一条稍长的命令被截断后，
   后面换了个参数就匹配不上了（"同意过"却还要再问一次），形同虚设。
   这里放宽到 1000，并在存之前做一次提示：真超过 1000 字的命令建议用 exact。 */
const WL_PREFIX_MAX = 1000;
let whiteList = [];

function loadWhiteList() {
  try {
    const arr = JSON.parse(fsSync.readFileSync(WHITELIST_FILE, "utf8"));
    whiteList = Array.isArray(arr) ? arr : [];
  } catch { whiteList = []; }
}

function saveWhiteList() {
  try { writeJsonAtomic(WHITELIST_FILE, whiteList); } catch {}
}

function cmdOf(args) {
  if (!args) return "";
  return String(args.command ?? args.script ?? args.text ?? args.path ?? "").trim();
}

function isWhitelisted(tool, args) {
  const cmd = cmdOf(args);
  if (!cmd) return false;
  return whiteList.some((w) => {
    if (!w || !w.pattern) return false;
    if (w.tool && w.tool !== tool) return false;
    return w.mode === "exact" ? cmd === w.pattern : cmd.startsWith(w.pattern);
  });
}

loadWhiteList();

function isDangerous(server, tool, args) {
  if (server !== "windows") return false;
  if (DANGER_TOOLS.has(tool)) return true;
  return dangerByArgs(tool, args);   // 例如 FileSystem 只有 delete 才拦，read/list 不该打扰用户
}

function listPending() {
  return [...approvals.values()].map((a) => ({ id: a.id, tool: a.tool, args: a.args, at: a.at }));
}

function resolveApproval(id, allow, reason, remember) {
  const a = approvals.get(id);
  if (!a) return false;
  clearTimeout(a.timer);
  approvals.delete(id);

  // 「允许并记住」：把这条命令写进白名单
  if (allow && remember) {
    const cmd = cmdOf(a.args);
    if (cmd) {
      // 默认 exact（完全相同才放行）最安全；prefix 需要显式指定
      const mode = remember === "prefix" ? "prefix" : "exact";
      const pattern = mode === "prefix" ? cmd.slice(0, WL_PREFIX_MAX) : cmd;
      if (mode === "prefix" && cmd.length > WL_PREFIX_MAX) {
        console.log(`[whitelist] 提示：命令超过 ${WL_PREFIX_MAX} 字，前缀只存了前 ${WL_PREFIX_MAX} 字；` +
          '之后参数一变就匹配不上，这种情况建议用「exact」。');
      }
      if (!isWhitelisted(a.tool, a.args)) {
        whiteList.push({ tool: a.tool, mode, pattern, addedAt: Date.now() });
        saveWhiteList();
        console.log(`[whitelist] 新增 ${mode}：${pattern.slice(0, 60)}`);
      }
    }
  }

  a.resolve({ allow: !!allow, reason: reason || (allow ? "已允许" : "已拒绝") });
  return true;
}

function waitApproval(server, tool, args) {
  const id = "c" + (++confirmSeq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      approvals.delete(id);
      console.log(`[confirm] ${id} 超时未确认，按拒绝处理`);
      resolve({ allow: false, reason: "超时未确认（安全默认：拒绝）" });
    }, CONFIRM_TIMEOUT_MS);
    approvals.set(id, { id, server, tool, args, at: Date.now(), timer, resolve });
    console.log(`[confirm] 等待确认：${tool} ${JSON.stringify(args).slice(0, 120)}`);
  });
}

function interp(v, ctx) {
  if (typeof v === "string") {
    return v.replace(/\{\{(\w+)\}\}/g, (_, k) => (ctx.vars[k] === undefined ? "" : String(ctx.vars[k])));
  }
  if (Array.isArray(v)) return v.map((x) => interp(x, ctx));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = interp(v[k], ctx);
    return o;
  }
  return v;
}

/** 条件求值：支持「变量条件」和「工具条件」两种 */
async function evalWhen(when, ctx) {
  if (!when) return true;

  if (when.var) {
    const val = ctx.vars[when.var];
    if ("equals" in when) return String(val) === String(interp(when.equals, ctx));
    if ("contains" in when) return String(val ?? "").includes(String(interp(when.contains, ctx)));
    return !!val;
  }

  // 工具条件：调一次工具，拿它的文本结果做判断（如 Snapshot 里有没有"稍后再说"）
  if (when.tool) {
    const r = await callTool(when.server || "windows", when.tool, interp(when.args || {}, ctx), CALL_TIMEOUT_MS);
    const text = typeof r === "string" ? r : JSON.stringify(r ?? "");
    if ("contains" in when) return text.includes(String(when.contains));
    if ("notContains" in when) return !text.includes(String(when.notContains));
    return !!text;
  }
  return true;
}

async function runSteps(steps, ctx, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`嵌套层数超过上限（${MAX_DEPTH}）`);
  const list = steps || [];
  let i = 0;
  while (i < list.length) {
    // 急停检查已下沉到 callToolRaw 入口（覆盖全部调用路径），此处不再重复。
    /* 智能体判定最终目标已达成：整条流程收工。
       只 return 不够 —— 嵌套层返回只能结束本层，父层循环还会跑下一轮。 */
    if (ctx.finished) return;
    const sig = await runNode(list[i], ctx, depth);
    if (sig && sig.downgraded) {
      /* 这一步「配了锚点却找不到」——界面变了。交给接管层处理：
         它会让视觉智能体推进几小步，再探一次是否已回到原轨道。 */
      const back = await takeover(list, i, ctx);
      if (back === null) {
        throw new Error(`第 ${ctx.step} 步「${sig.anchor || sig.tool}」定位失败，智能接管也没能回到原流程`);
      }
      if (back === "fallback") {
        /* once 模式没救回来：退回录制坐标把这一步做掉，同时把策略降级，
           否则同一步会反复触发接管，一路卡在这里。 */
        log(`[agent] 单点救援未果，第 ${ctx.step} 步改用录制坐标继续`);
        ctx.escalate = "off";
        continue;                       // 不 i++，重跑这一步
      }
      i = back;
      continue;
    }
    i++;
  }
}

async function runNode(s, ctx, depth) {
  if (!s || typeof s !== "object") return null;
  const type = s.type || "action";

  if (type === "set") {
    ctx.vars[s.name] = interp(s.value, ctx);
    return null;
  }

  if (type === "loop") {
    const saveI = ctx.vars.i;
    const saveScopes = ctx.scopes;
    /* scope 栈要复制一层再压：直接用原数组的话，兄弟节点会互相踩，
       而且 pop 之后外面那层的引用就断了。 */
    ctx.scopes = (ctx.scopes || []).slice();
    if (s.while) {
      /* while 型不需要轮次对齐 —— 它的退出条件是每轮重算的，
         接管把剩下的干完了，条件自然变 false，循环自己就停了。 */
      let n = 0;
      ctx.scopes.push({ kind: "while", iter: () => n, jumpTo: () => false, pending: null });
      while (n < MAX_WHILE && (await evalWhen(s.while, ctx))) {
        if (ctx.finished) break;
        ctx.vars.i = n;
        await runSteps(s.body, ctx, depth + 1);
        n++;
      }
      if (n >= MAX_WHILE) console.log(`[wf] while 达到上限 ${MAX_WHILE}，已强制停止`);
      ctx.scopes.pop();
    } else {
      const times = Math.max(0, Number(interp(s.times ?? 1, ctx)) || 0);
      let n = 0;
      const mark = s.mark || null;
      const since = Number(ctx.startedAt) || 0;
      const scope = {
        kind: "times", total: times, mark, pending: null, since,
        /* 每轮几次标记动作：用户手填 > 静态数循环体 > 1。
           静态数是主来源 —— 答案本来就写在 body 里，不用问人，也不用示范。 */
        markPerRound: (mark && Number(mark.perRound) > 0)
          ? Number(mark.perRound)
          : Math.max(1, countMarkInSteps(s.body, mark) || 1),
        lastRoundCount: 0,          // 上一轮实测点了几次，用来覆盖静态数
        iter: () => n,
        /* 只能往前跳，且不能超过总轮数。
           倒退等于把已经做过的事重做一遍（可能重复提交），一律拒绝；
           跳到 times 则表示全部做完，循环会自然退出。 */
        jumpTo: (v) => {
          if (!canJump(n, v, times)) return false;
          scope.pending = v;
          return true;
        },
      };
      ctx.scopes.push(scope);
      // 取原始次数（不除 perRound）：perRound 传 1 让 countMarks 直接返回条数
      const rawCount = () => (mark
        ? countMarks(AUDIT_MEM, since, Object.assign({}, mark, { perRound: 1 }))
        : null);
      while (n < times) {
        if (ctx.finished) break;
        ctx.vars.i = n;
        scope.pending = null;
        const rawBefore = rawCount();
        await runSteps(s.body, ctx, depth + 1);
        /* 实测本轮点了几次。循环体里有分支时静态数会偏，
           用实测值覆盖，下一轮自动收敛；0 次说明这轮没走那条路，不覆盖。 */
        const rawAfter = rawCount();
        if (rawBefore !== null && rawAfter !== null && rawAfter > rawBefore) {
          scope.lastRoundCount = rawAfter - rawBefore;
        }
        // 接管对齐过轮次 → 直接跳到目标轮，不能再 +1（否则白跑一轮）
        n = (scope.pending === null) ? n + 1 : scope.pending;
      }
      ctx.scopes.pop();
    }
    ctx.scopes = saveScopes;   // 还原，避免嵌套循环互相污染
    ctx.vars.i = saveI;
    return null;
  }

  if (type === "if") {
    const hit = await evalWhen(s.when, ctx);
    await runSteps(hit ? s.then : s.else, ctx, depth + 1);
    return null;
  }

  // 默认：普通动作（老工作流的步骤没有 type，走这里）
  ctx.step = (ctx.step || 0) + 1;
  liveStep(ctx.step, s.tool);
  // 抗迁移：先按窗口锚定 / 文字锚定 / 兜底重算坐标，再回放
  const { args: actArgs, conf } = await resolveAnchor(s);
  ctx.lastConf = conf;

  if (conf === "absolute") {
    /* 配了锚点却落到录制坐标 = 真降级，界面上那个文字找不到了。
       三种处置由工作流的 escalate 决定。 */
    if (ctx.escalate === "stop") {
      throw new Error(`第 ${ctx.step} 步「${(s.args && s.args.anchor) || s.tool}」在界面上找不到，已按「遇到意外就停」停下`);
    }
    /* 嵌套层（loop / if 的 body）现在也接管，但只在**同一层**回归：
       失守发生在 body 里，就让智能体在 body 里顶，回到 body 的某一步继续。
       父层的循环次数、分支选择、迭代变量完全不受影响 —— 这是 UiPath
       Retry Scope 的作用域语义，也是唯一不会搞乱控制流的接法。 */
    if (ctx.escalate === "agent" || ctx.escalate === "once") {
      return { downgraded: true, conf, tool: s.tool, anchor: (s.args && s.args.anchor) || "" };
    }
  }

  await callTool(s.server, s.tool, interp(actArgs, ctx), s.timeoutMs ?? CALL_TIMEOUT_MS);
  if (ctx.gap) await sleep(ctx.gap);
  return null;
}

/** 回放：支持编排节点；失败立即停并汇报 */
async function wfPlay(name, opts = {}) {
  const file = wfFile(name);
  let wf;
  try { wf = JSON.parse(fsSync.readFileSync(file, "utf8")); }
  catch { throw new Error(`读不到工作流：${name}`); }

  const gap = Number(opts.gap ?? wf.gap ?? 700);
  /* escalate：界面变了怎么办。
     off   —— 老行为，直接按录制坐标点下去（默认，不改变既有工作流的语义）
     stop  —— 立刻停并报错（宁可不做，也不乱点）
     once  —— 先问一次视觉模型，救不回来再用录制坐标顶上
     agent —— 交给视觉智能体分几小步推进，每批停下探一次是否回到原轨道 */
  const escalate = ["off", "stop", "once", "agent"].includes(wf.escalate) ? wf.escalate : "off";
  const ctx = {
    vars: Object.assign({}, wf.vars || {}),
    gap,
    goal: String(wf.goal || ""),          // 给智能体看的最终目标，接管时原样拼进提示词
    escalate,
    agentBudget: Number(wf.agentBudget) || 0,
    lastConf: "none",
    startedAt: Date.now(),                // 轮次推定的时间基线：只数这次运行之后的动作
    scopes: [],                           // 循环作用域栈：接管靠它知道「在哪一层、第几轮」
    finished: false,                      // 智能体判定最终目标已达成 → 整条流程收工
  };

  let steps = wf.steps || [];
  if (opts.skipRead) {
    // 只跳过顶层的只读动作；编排节点原样保留
    steps = steps.filter((s) => !(s.type === undefined && READ_TOOLS_FOR_REC.has(s.tool)));
  }

  // 标记来源 + 推送实时状态（面板靠这个显示进度，不再是黑盒等待）
  const prevSource = CURRENT_SOURCE;
  CURRENT_SOURCE = opts.source || "workflow";
  ctx.step = 0;
  liveStart(CURRENT_SOURCE, wf.name || name, steps.length, "回放工作流");
  try {
    await runSteps(steps, ctx, 0);
    liveEnd(true);
    return {
      ok: true, total: steps.length, stoppedAt: null, results: [], vars: ctx.vars,
      // finished：智能体在接管时判定「最终目标已达成」，整条流程提前收工（不是失败）
      finished: !!ctx.finished,
    };
  } catch (err) {
    const msg = String(err?.message ?? err);
    liveEnd(false, msg);
    return { ok: false, total: steps.length, stoppedAt: -1, error: msg, vars: ctx.vars };
  } finally {
    CURRENT_SOURCE = prevSource;
  }
}

(async () => { try { fsSync.mkdirSync(WORKFLOW_DIR, { recursive: true }); } catch {} })();

/* ---------------- 触发器 ----------------
 * 让工作流"自己跑"，不必有人守着点。
 * 分工：定时 / 文件变化在 bridge（Node 能力）；**热键在 main.js**——
 * globalShortcut 是 Electron 的 API，bridge 进程里没有。
 * 落盘 <控制台>/triggers.json，重启后自动重新武装。
 */
const TRIGGER_FILE = process.env.ORB_TRIGGER_FILE || path.join(DATA_DIR, "triggers.json");
let triggers = [];
const triggerHandles = new Map();   // id -> Interval / FSWatcher

/**
 * 触发器 id 去重。
 * 两条路会产生重复 id：
 *   ① 面板在同一毫秒内连续新建（id = "t" + Date.now().toString(36)）；
 *   ② triggers.json 手工编辑时漏写 id（全是 undefined）。
 * 重复 id 的后果很实在：armTriggers 拿 id 当句柄表的 key，
 * 后一条把前一条的句柄覆盖掉 —— 前一个 setInterval / FSWatcher 既泄漏、
 * 又再也没法被 disarmTriggers 摘掉（触发器"关不掉"就是从这儿来的）。
 */
function ensureTriggerIds() {
  const seen = new Set();
  let changed = false;
  for (const t of triggers) {
    if (!t || typeof t !== "object") continue;
    if (!t.id || seen.has(String(t.id))) {
      t.id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      changed = true;
    }
    seen.add(String(t.id));
  }
  if (changed) saveTriggers();
}

function loadTriggers() {
  try {
    const arr = JSON.parse(fsSync.readFileSync(TRIGGER_FILE, "utf8"));
    triggers = Array.isArray(arr) ? arr : [];
  } catch { triggers = []; }
  ensureTriggerIds();
}

function saveTriggers() {
  try { writeJsonAtomic(TRIGGER_FILE, triggers); } catch {}
}

function disarmTriggers() {
  for (const h of triggerHandles.values()) {
    try { h.close?.(); } catch {}
    try { clearInterval(h); } catch {}
  }
  triggerHandles.clear();
}

async function fireTrigger(t, reason) {
  try {
    if (STOP.on) { console.log(`[trigger] ${t.id} 跳过：当前处于急停状态`); return; }
    console.log(`[trigger] ${t.id} → ${t.workflow}（${reason}）`);
    await wfPlay(t.workflow, { gap: t.gap, source: "trigger" });
    console.log(`[trigger] ${t.id} 执行完成`);
  } catch (err) {
    console.log(`[trigger] ${t.id} 执行失败：${err?.message ?? err}`);
  }
}

/** 按当前配置重新武装所有触发器（启动时 / 改配置后调用） */
function armTriggers() {
  disarmTriggers();
  ensureTriggerIds();
  triggers.forEach((t, i) => {
    if (!t || t.enabled === false) return;
    /* 句柄 key 带序号：即使 id 还撞（文件被外部改过），每条也各有独立句柄，
       不会再出现"后一条覆盖前一条、前一条永远关不掉也清不掉"。 */
    const hkey = `${t.id}#${i}`;
    if (t.type === "interval") {
      // 下限 1 分钟：防手滑写 0 把机器跑满；1 分钟起允许用户精细调度
      const ms = Math.max(1, Number(t.minutes || 10)) * 60000;
      triggerHandles.set(hkey, setInterval(() => fireTrigger(t, "interval"), ms));
    } else if (t.type === "file") {
      try {
        const w = fsSync.watch(t.path, { persistent: true }, (ev) => fireTrigger(t, "file:" + ev));
        // 目录被删 / 盘符掉线时 watcher 会抛 'error'，没有监听者就升级成未捕获异常
        w.on("error", (e) => console.log(`[trigger] 文件监听出错 ${t.path}：${e?.message ?? e}`));
        triggerHandles.set(hkey, w);
      } catch (err) {
        console.log(`[trigger] 文件监听失败 ${t.path}：${err?.message ?? err}`);
      }
    }
    // hotkey 类型不在此处理：交给 main.js 的 globalShortcut
  });
  console.log(`[trigger] 已武装 ${triggerHandles.size} 个（配置共 ${triggers.length} 条）`);
}

loadTriggers();
setTimeout(() => { try { armTriggers(); } catch (e) { console.log("[trigger] 武装失败", e?.message); } }, 2000);

// 审计日志保留 30 天：启动后清一次过期文件
setTimeout(() => { try { auditCleanup(); } catch {} }, 3000);

/* 只读结果短时缓存（提速）。
 * 轮询场景里同一个 Snapshot 会被反复调用，每次都走完整 MCP 往返很浪费。
 * 只缓存**确认无副作用**的只读工具，且任何写操作后立刻整体失效，
 * 保证「点一下再看」永远拿到新画面。 */
const READ_CACHE = new Map();
const READ_CACHE_MS = 300;
const READ_ONLY_TOOLS = new Set([
  "windows|Snapshot",
  "windows|DisplayInventory",
]);

async function openSession(key) {
  const def = SERVERS[key];
  const transport = new StdioClientTransport({
    command: def.command,
    args: def.args,
    env: def.env ?? process.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "orb-console", version: "1.0.0" });

  const drop = () => {
    if (sessions.get(key)?.client === client) {
      sessions.delete(key);
      try { client.close?.(); } catch {}
    }
  };
  try { transport.onclose = drop; } catch {}
  try { client.onclose = drop; } catch {}

  await client.connect(transport);
  const { tools } = await client.listTools();
  const session = {
    client,
    transport,
    tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
  };
  sessions.set(key, session);
  registerChild(transportPid(transport), key);   // 记进台账，供下次启动回收
  return session;
}

async function getSession(key, retry = true) {
  if (!SERVERS[key]) throw new Error(`unknown server: ${key}`);
  const live = sessions.get(key);
  if (live && live.client) {
    /* 僵死会话自愈（兜底，实测当前 SDK 下极少触发）：
     * 子进程死了但会话还躺 map 里时，/api/status 会误报在线、调用表现异常。
     * 主力恢复其实在另外两处——① SDK 的 transport.onclose 会调 drop 摘掉会话；
     * ② callToolRaw 里 isBroken(err) 命中（"Not connected"/"Connection closed"）也会
     * disposeSession。这两条都实测有效（杀子进程后：在途调用 5s 内报 Connection
     * closed，空闲会话 4ms 报 Not connected，下一次调用 4s 重连成功）。
     * 这里的 PID 探活覆盖的是 SDK 兜不住的 exotic 场景：子进程没了、但 'close'
     * 事件迟迟不触发（例如它的孙进程继承了 stdout 管道把管道占着），此时 SDK
     * 不会清 _process、也不会调 onclose，只有 kill(pid,0) 能发现它死了。
     * 注意：SDK 在 'close' 里会顺手把 _process 置 undefined，所以正常情况下
     * （'close' 正常触发）这个探活反而拿不到 PID——这是已知的，不是 bug。 */
    const pid = transportPid(live.transport);
    if (pid > 0 && !pidAlive(pid)) {
      log(`[session] ${key} 的子进程 PID ${pid} 已不在，销毁僵死会话并重连`);
      disposeSession(key);
    } else {
      return live;
    }
  }

  if (!connecting.has(key)) {
    connecting.set(key, openSession(key).finally(() => connecting.delete(key)));
  }
  try {
    return await connecting.get(key);
  } catch (err) {
    connecting.delete(key);
    if (retry) {
      await new Promise((r) => setTimeout(r, 800));
      return getSession(key, false);
    }
    throw err;
  }
}

/* 急停豁免名单：这些调用即使在急停状态下也放行。
 *
 * 为什么必须豁免：
 *   ① 「恢复」本身就是一次工具调用 —— 如果急停把所有调用都拦死，
 *      就再也回不来了，只能杀进程重启。这是把刹车焊死。
 *   ② 只读的「看一眼」类操作不会改变电脑状态，急停时禁掉它们没有安全收益，
 *      反而让人没法确认"到底停了没"。
 *
 * 豁免的粒度是 (server, tool)，不是整个 server ——
 * 不能因为 orb 有 cursor_position 就把 orb 的 drag 也放行。
 */
const STOP_EXEMPT = new Set([
  "orb|cursor_position",     // 只读：看鼠标在哪
  "orb|ocr",                // 只读：截屏取词
  "orb|subtitle",           // 只读：查实时字幕状态（启停仍受拦）
  "windows|Screenshot",     // 只读：截屏
  "windows|Snapshot",       // 只读：看屏幕
  "windows|DisplayInventory", // 只读：显示器信息
  "workbuddy|workbuddy_execute", // 后台派活：不操作本机鼠标键盘
]);
function stopExempt(key, tool) {
  return STOP_EXEMPT.has(`${key}|${tool}`);
}

async function callToolRaw(key, tool, args, timeoutMs) {
  /* 急停检查点：放在 callToolRaw 的入口，一次覆盖全部四条路 ——
   *   回放（runSteps → callTool）、单次调用（/api/call → callTool）、
   *   后台任务（startJob → callTool）、危险确认（WaitFor → callTool）。
   *
   * 之前 checkStop() 只在 runSteps 里调过一次，导致急停只拦得住"工作流回放"，
   * 而面板上任何一个工具按钮、以及直接打 /api/call 都能绕过 —— 急停形同虚设。
   */
  if (STOP.on && !stopExempt(key, tool)) {
    throw new Error(`已被急停（${STOP.reason || "手动"}），${key}.${tool} 被拦下`);
  }

  // 本地伪服务：不经过 MCP，直接调原生工具
  if (key === "orb") {
    const fn = LOCAL_TOOLS[tool];
    if (!fn) throw new Error(`orb 没有工具 ${tool}（可用：${ORB_TOOL_LIST.join(", ")}）`);
    return fn(args ?? {});
  }

  // WorkBuddy 后台：也不经 MCP，直接拉起 CodeBuddy CLI
  if (key === "workbuddy") {
    const fn = WORKBUDDY_TOOLS[tool];
    if (!fn) throw new Error(`workbuddy 没有工具 ${tool}（可用：${WORKBUDDY_TOOL_LIST.join(", ")}）`);
    return fn(args ?? {}, timeoutMs);
  }

  // 危险操作：挂起等人确认；超时按拒绝处理（绝不自动放行）。
  // 命中白名单的（你明确信得过的命令）直接放行，不再反复打扰。
  if (isDangerous(key, tool, args) && !isWhitelisted(tool, args)) {
    const r = await waitApproval(key, tool, args);
    if (!r.allow) throw new Error(`危险操作被拒绝：${tool} —— ${r.reason}`);
  }

  let session;
  try {
    session = await getSession(key);
  } catch (err) {
    throw new Error(`连接 ${SERVERS[key]?.label ?? key} 失败：${err?.message ?? err}`);
  }

  let timer;
  // 记「在途调用」：急停时只有确实有调用卡在 MCP 里，才值得把连接断掉。
  // 没有在途调用就保持连接，避免误触急停后每次操作都要重连（慢好几秒）。
  inflightMcp.set(key, (inflightMcp.get(key) || 0) + 1);
  /* 录制时屏蔽鼠标钩子：这次操作是 ORB 自己发起的（会产生真实鼠标事件），
     已经由 wfCapture 记过一遍，再让钩子记一次就重复了。 */
  const mh = REC.on ? await getMouseHook() : null;
  if (mh) mh.suppressMouseHook(true);
  try {
    return await Promise.race([
      session.client.callTool({ name: tool, arguments: args ?? {} }),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`工具 ${tool} 超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    // 断连 **或超时** 都说明这个 session 已不可信：必须关掉重建。
    // 只处理断连的话，被卡住的 client 会被后续请求反复复用，
    // 表现为"卡一次之后所有调用都超时"，只能重启整个 ORB 才能恢复。
    if (isBroken(err) || /超时/.test(String(err?.message ?? err))) disposeSession(key);
    throw err;
  } finally {
    clearTimeout(timer);
    const n = (inflightMcp.get(key) || 0) - 1;
    if (n <= 0) inflightMcp.delete(key); else inflightMcp.set(key, n);
    // 解除抑制要**晚一点**：MCP 里的真实点击可能在调用返回后才落到系统里，
    // 立刻解除会把这次操作又记一遍。
    if (mh) setTimeout(() => mh.suppressMouseHook(false), 250);
  }
}

/* 审计包装：所有工具调用都从这里过，统一记录「谁/何时/做了什么/结果/耗时」。
 * CURRENT_SOURCE 由上层设置（workflow / trigger / ai / api），用来回溯是谁触发的。 */
let CURRENT_SOURCE = "api";

function auditArgs(args) {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch { return "(无法序列化)"; }
}

async function callTool(key, tool, args, timeoutMs) {
  const t0 = Date.now();
  try {
    const r = await callToolRaw(key, tool, args, timeoutMs);
    audit({ source: CURRENT_SOURCE, server: key, tool, args: auditArgs(args), ok: true, ms: Date.now() - t0 });
    return r;
  } catch (err) {
    audit({
      source: CURRENT_SOURCE, server: key, tool, args: auditArgs(args),
      ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 200),
    });
    throw err;
  }
}

const jobs = new Map();
let jobSeq = 0;

/* ---------------- 任务结果裁剪 ----------------
 * MCP 工具的返回值里常带整张屏幕截图（base64，单张 1~3MB），而 jobs 表最多留
 * MAX_JOBS 条 —— 峰值能到 100MB+ 且 GC 不掉。
 * 策略（与面板侧约定）：超过 512KB 就不把原文留在内存里，只削出一段文字摘要，
 * 并在 **job 顶层**置 truncated: true；面板见到这个标志会补一句
 * 「结果过大已省略，以上仅为开头部分」。
 * 内存从 MB 级降到 KB 级，用户也不至于只看一句「已省略」以为任务白跑。 */
const JOB_RESULT_MAX = 512 * 1024;   // 超过这个体积就不留在内存里
const JOB_TEXT_KEEP = 2000;          // 摘要保留的字符数

function jobResultSize(r) {
  try { return JSON.stringify(r).length; } catch { return JOB_RESULT_MAX; }
}

/** 返回 { result, truncated }：超限时 result 被削成一段文字摘要 */
function trimJobResult(r) {
  if (jobResultSize(r) <= JOB_RESULT_MAX) return { result: r, truncated: false };
  const parts = (r && r.content) || [];
  let text = parts
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  if (!text) {
    /* 没有文字（纯截图之类）时给一句能自解释的话，
       别让用户以为任务跑了几分钟却什么都没产出。 */
    text = `（本次返回的是非文本内容，共 ${parts.length} 项，因体积过大未回传）`;
  } else if (text.length > JOB_TEXT_KEEP) {
    text = text.slice(0, JOB_TEXT_KEEP);
  }
  return {
    result: { content: [{ type: "text", text }], trimmed: true },
    truncated: true,
  };
}

function startJob(key, tool, args, timeoutMs) {
  const id = String(++jobSeq);
  jobs.set(id, { id, server: key, tool, status: "running", startedAt: Date.now() });
  /* 原来的淘汰条件是 `find(status !== "running")`，找不到就 break：
     60 个全是 running 时 jobs 再也不淘汰，而每条 result 是工具的**完整返回**
     （一张截图就几 MB）—— 内存只涨不降。这里保证上限一定生效。
     另外被淘汰的 job 跑完后不许再写回来：原代码 `if (cur)` 之外没有别的闸门，
     淘汰后又复活出一个没有 id / server / tool 的残对象，把表越撑越大。 */
  while (jobs.size > MAX_JOBS) {
    const keys = [...jobs.keys()];
    const victim = keys.find((k) => jobs.get(k).status !== "running") || keys[0];
    if (!victim || victim === id) break;
    jobs.delete(victim);
  }
  (async () => {
    try {
      const raw = await callTool(key, tool, args, timeoutMs ?? JOB_TIMEOUT_MS);
      const { result, truncated } = trimJobResult(raw);
      const cur = jobs.get(id);
      if (cur) jobs.set(id, { ...cur, status: "done", finishedAt: Date.now(), result, truncated });
    } catch (err) {
      const cur = jobs.get(id);
      if (cur) jobs.set(id, { ...cur, status: "error", finishedAt: Date.now(), error: String(err?.message ?? err) });
    }
  })();
  return id;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // X-Orb-Token 必须在这里放行：带自定义头的请求会先发 OPTIONS 预检，
  // 预检不通过的话浏览器根本不会发出真正的请求（表现为所有 POST 直接失败）。
  "Access-Control-Allow-Headers": "Content-Type, X-Orb-Token",
};

function send(res, code, body) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...CORS,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 8 * 1024 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

/* ---------- OCR（截屏取词）：走 Windows 自带 OCR 引擎，离线、免安装、不限流 ---------- */

const OCR_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $m = $asTaskGeneric.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null
$path = '__PATH__'
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('__LANG__')))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw '本机没有可用的 OCR 语言（需在系统语言里装中文/英文 OCR）' }
$r = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
$r.Text
`;

/** 对 PNG 缓冲做 OCR，返回识别到的文字。 */
function ocrPng(buf, lang = "zh-Hans-CN") {
  return new Promise((resolve, reject) => {
    /* 临时图必须落 DATA_DIR：HERE 在打包态是 Program Files 下的 resources/，
       写不进去 —— 表现为 OCR 恒失败并只剩一句"写临时图片失败"。 */
    const tmpDir = path.join(DATA_DIR, "tmp");
    try { fsSync.mkdirSync(tmpDir, { recursive: true }); } catch { /* 已存在 */ }
    const tmp = path.join(tmpDir, `.ocr-${Date.now()}-${process.pid}.png`);
    try {
      fsSync.writeFileSync(tmp, buf);
    } catch (e) {
      return reject(new Error("写临时图片失败：" + e.message));
    }
    const script = OCR_PS.replace("__PATH__", tmp).replace("__LANG__", lang);
    const b64 = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
      { timeout: 40000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fsSync.unlinkSync(tmp); } catch {}
        if (err) {
          return reject(new Error(String(stderr || err.message || "").trim().slice(0, 300) || "OCR 失败"));
        }
        resolve(String(stdout || "").replace(/^\uFEFF/, "").trim());
      }
    );
  });
}

/* ---------- 抗迁移：窗口锚定 / 文字锚定 / 落空兜底 ----------
 * 录制得到的点击都是「绝对屏幕坐标」。窗口一旦被拖动 / 缩放 / 重排，
 * 原来的按钮就不在那个点了 —— 这就是「按钮迁移」导致工作流失效的根因。
 *
 * 三道防线（统一在 resolveAnchor 里串行裁决）：
 *   1) 窗口相对坐标：录制时把「点落在哪个窗口、相对窗口左上角的偏移」记下来；
 *      回放时按窗口现在的左上角重新算出绝对坐标。窗口挪了也能点准。
 *   2) 文字锚定：用户在编辑器给某一步写上「锚定文字」（如"确定"），
 *      回放时对该窗口截图 OCR，找到这段文字就点它中心。按钮改名不碍事，
 *      只要文字还在就能点。
 *   3) 落空兜底：上述都失败（窗口找不到 / 文字没认出）时，退回录制时的
 *      绝对坐标，至少按原样试一次，而不是整步作废。
 */

const WIN_AT_POINT_PS = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class WAP{
 [DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(int x,int y);
 [DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint ga);
 [DllImport("user32.dll")]public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 public struct RECT{public int L,T,R,B;}
}
"@
$h=[WAP]::WindowFromPoint([int]__X__,[int]__Y__)
if($h-eq[IntPtr]::Zero){'NONE';exit}
$h=[WAP]::GetAncestor($h,2)
if($h-eq[IntPtr]::Zero){'NONE';exit}
$len=[WAP]::GetWindowTextLength($h)
$sb=New-Object System.Text.StringBuilder($len+1)
[WAP]::GetWindowText($h,$sb,$len+1)|Out-Null
$r=New-Object WAP+RECT
[WAP]::GetWindowRect($h,[ref]$r)|Out-Null
$ox=[int]__X__-$r.L
$oy=[int]__Y__-$r.T
($sb.ToString())+'|'+($r.L)+','+($r.T)+','+($r.R-$r.L)+','+($r.B-$r.T)+'|'+$ox+','+$oy
`;

const WIN_BY_TITLE_PS = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class WFT{
 [DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc e,IntPtr l);
 [DllImport("user32.dll")]public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 public struct RECT{public int L,T,R,B;}
}
"@
$t=__TITLE__
$t=[System.Management.Automation.WildcardPattern]::Escape($t)
$script:m=$null
$p=[WFT+EnumProc]{param($h,$l)
 if(-not [WFT]::IsWindowVisible($h)){return $true}
 $len=[WFT]::GetWindowTextLength($h)
 if($len-le 0){return $true}
 $sb=New-Object System.Text.StringBuilder($len+1)
 [WFT]::GetWindowText($h,$sb,$len+1)|Out-Null
 if($sb.ToString()-like "*$t*"){
  $rr=New-Object WFT+RECT
  [WFT]::GetWindowRect($h,[ref]$rr)|Out-Null
  $script:m=(($rr.L)+','+($rr.T)+','+($rr.R-$rr.L)+','+($rr.B-$rr.T))
  return $false
 }
 return $true
}
[WFT]::EnumWindows($p,[IntPtr]::Zero)|Out-Null
$script:m
`;

const OCR_WORDS_PS = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime|Out-Null
$asTaskGeneric=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name-eq 'AsTask'-and$_.GetParameters().Count-eq 1-and$_.GetParameters()[0].ParameterType.Name-eq 'IAsyncOperation\`1'})[0]
function Await($op,$t){$m=$asTaskGeneric.MakeGenericMethod($t);$task=$m.Invoke($null,@($op));$task.Wait(-1)|Out-Null;$task.Result}
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]|Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]|Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]|Out-Null
$path='__PATH__'
$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path))([Windows.Storage.StorageFile])
$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read))([Windows.Storage.Streams.IRandomAccessStream])
$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))([Windows.Graphics.Imaging.BitmapDecoder])
$bmp=Await ($decoder.GetSoftwareBitmapAsync())([Windows.Graphics.Imaging.SoftwareBitmap])
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('__LANG__')))
if(-not $engine){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
if(-not $engine){throw '本机没有可用的 OCR 语言'}
$r=Await ($engine.RecognizeAsync($bmp))([Windows.Media.Ocr.OcrResult])
$lines=@()
foreach($line in $r.Lines){foreach($w in $line.Words){$b=$w.BoundingRect;$lines+=(($w.Text)+'|'+($b.X)+','+($b.Y)+','+($b.Width)+','+($b.Height))}}
$lines-join [char]10
`;

const SHOT_PS = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$x=[int]__X__;$y=[int]__Y__;$w=[int]__W__;$h=[int]__H__
if($w-le 0){$w=10}if($h-le 0){$h=10}
$bmp=New-Object System.Drawing.Bitmap($w,$h)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x,$y,0,0,$bmp.Size)
$bmp.Save('__PATH__',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose()
'OK'
`;

/* 虚拟桌面范围 + 前台窗口标题，一次 PowerShell 拿全。
   用虚拟桌面（76~79）而不是主屏（0/1）：目标窗口很可能被拖到副屏上，
   只截主屏会让「锚点明明在屏幕上却探不到」，从而白白多跑一轮接管。
   DPI 提示：这个进程是 DPI-unaware 的，取到的是逻辑尺寸，
   但 CopyFromScreen 用的也是逻辑坐标，两者一致，所以截图范围不会错。
   归一化后的小数由系统缩放，不影响「文字在不在」这个判断。 */
const SCREEN_PS = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class SFG{
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")]public static extern int GetSystemMetrics(int i);
}
"@
$h=[SFG]::GetForegroundWindow()
$len=[SFG]::GetWindowTextLength($h)
$sb=New-Object System.Text.StringBuilder($len+1)
[SFG]::GetWindowText($h,$sb,$len+1)|Out-Null
$vx=[SFG]::GetSystemMetrics(76)
$vy=[SFG]::GetSystemMetrics(77)
$vw=[SFG]::GetSystemMetrics(78)
$vh=[SFG]::GetSystemMetrics(79)
if($vw-le 0){$vx=0;$vy=0;$vw=[SFG]::GetSystemMetrics(0);$vh=[SFG]::GetSystemMetrics(1)}
($vx.ToString()+','+$vy.ToString()+','+$vw.ToString()+','+$vh.ToString()+'|'+$sb.ToString())
`;

/** 跑一段 PowerShell（UTF-16LE 编码走 -EncodedCommand），返回 stdout。 */
function psRun(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(script, "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || "").trim().slice(0, 300) || "PowerShell 失败"));
        resolve(String(stdout || ""));
      });
  });
}

/** 录制时：取某点的「所在窗口」信息（标题 + 矩形 + 相对左上角偏移）。 */
async function captureWinAt(x, y) {
  try {
    const out = await psRun(WIN_AT_POINT_PS.replace("__X__", String(Math.round(x))).replace("__Y__", String(Math.round(y))));
    const s = (out || "").trim();
    if (!s || s === "NONE") return null;
    const parts = s.split("|");
    if (parts.length < 3) return null;
    const rect = parts[1].split(",").map(Number);
    const off = parts[2].split(",").map(Number);
    if (rect.length !== 4 || off.length !== 2 || rect.some(isNaN) || off.some(isNaN)) return null;
    return { title: parts[0] || "", rect, off };
  } catch (e) {
    console.log("[anchor] 录制取窗口失败:", e?.message ?? e);
    return null;
  }
}

/** 回放时：按标题（子串）找可见窗口当前矩形。找不到返回 null（触发兜底）。 */
async function findWinRectByTitle(title) {
  if (!title) return null;
  try {
    const out = (await psRun(WIN_BY_TITLE_PS.replace("__TITLE__", title))).trim();
    if (!out || out === "NONE") return null;
    const r = out.split(",").map(Number);
    if (r.length !== 4 || r.some(isNaN)) return null;
    return r;
  } catch (e) {
    console.log("[anchor] 找窗口失败:", e?.message ?? e);
    return null;
  }
}

/** 截图指定区域为 PNG 缓冲（GDI，离线）。 */
async function screenshotRegion(x, y, w, h) {
  const tmpDir = path.join(DATA_DIR, "tmp");
  try { fsSync.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const tmp = path.join(tmpDir, `.shot-${Date.now()}-${process.pid}.png`);
  const script = SHOT_PS
    .replace("__X__", String(Math.round(x))).replace("__Y__", String(Math.round(y)))
    .replace("__W__", String(Math.round(w))).replace("__H__", String(Math.round(h)))
    .replace("__PATH__", tmp);
  try {
    await psRun(script, 20000);
    return fsSync.readFileSync(tmp);
  } catch (e) {
    console.log("[anchor] 截图失败:", e?.message ?? e);
    return null;
  } finally {
    try { fsSync.unlinkSync(tmp); } catch {}
  }
}

/** OCR 取词框：返回 [{text,x,y,w,h}]（坐标相对截图左上角）。 */
async function ocrWords(buf, lang = "zh-Hans-CN") {
  if (!buf) return [];
  const tmpDir = path.join(DATA_DIR, "tmp");
  try { fsSync.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const tmp = path.join(tmpDir, `.ocw-${Date.now()}-${process.pid}.png`);
  try { fsSync.writeFileSync(tmp, buf); } catch (e) { return []; }
  const script = OCR_WORDS_PS.replace("__PATH__", tmp).replace("__LANG__", lang);
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
      { timeout: 40000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        try { fsSync.unlinkSync(tmp); } catch {}
        if (err) { console.log("[anchor] OCR 失败:", err?.message ?? err); return resolve([]); }
        const words = [];
        for (const line of String(stdout || "").split("\n")) {
          const i = line.lastIndexOf("|");
          if (i < 0) continue;
          const text = line.slice(0, i);
          const box = line.slice(i + 1).split(",").map(Number);
          if (box.length === 4 && box.every((n) => !isNaN(n))) words.push({ text, x: box[0], y: box[1], w: box[2], h: box[3] });
        }
        resolve(words);
      });
  });
}

/** 单点工具集合：这些工具的坐标是「一个点」，可以用文字锚定直接覆盖。 */
const ANCHORABLE = new Set([
  "windows|Click", "windows|Move",
  "orb|long_press", "orb|mouse_press", "orb|move_to", "orb|scroll_at", "orb|cursor_position",
]);

/** 取步骤的「主坐标点」（绝对坐标，未变换）。 */
function primaryPoint(step) {
  const a = step.args || {};
  if (Array.isArray(a.loc)) return [Number(a.loc[0]) || 0, Number(a.loc[1]) || 0];
  if (a.x !== undefined) return [Number(a.x) || 0, Number(a.y) || 0];
  return null;
}

/** 把一个位移应用到 args 的所有坐标字段（loc / x,y / 含 x2,y2 的拖动）。 */
function addDeltaToArgs(args, dx, dy) {
  if (Array.isArray(args.loc)) args.loc = [args.loc[0] + dx, args.loc[1] + dy];
  if (args.x !== undefined) args.x += dx;
  if (args.y !== undefined) args.y += dy;
  if (args.x2 !== undefined) args.x2 += dx;
  if (args.y2 !== undefined) args.y2 += dy;
}

/** 文字锚定：对目标窗口截图 OCR，找锚定文字中心。找不到返回 null。 */
async function anchorByText(step) {
  const a = step.args || {};
  if (!a.anchor) return null;
  const target = String(a.anchor).trim().toLowerCase();
  if (!target) return null;
  try {
    let rx = 0, ry = 0, rw = 0, rh = 0;
    if (step.win && step.win.title) {
      const r = await findWinRectByTitle(step.win.title);
      if (r) { rx = r[0]; ry = r[1]; rw = r[2]; rh = r[3]; }
    }
    if (!rw || !rh) {                       // 没窗口信息就裁一小块围住录制点
      const pp = primaryPoint(step);
      if (!pp) return null;
      rx = Math.max(0, pp[0] - 200); ry = Math.max(0, pp[1] - 100); rw = 400; rh = 200;
    }
    const buf = await screenshotRegion(rx, ry, rw, rh);
    const words = await ocrWords(buf, "zh-Hans-CN");
    const pp = primaryPoint(step);
    let best = null, bestD = Infinity;
    for (const w of words) {
      if (w.text.toLowerCase().includes(target)) {
        const cx = w.x + w.w / 2, cy = w.y + w.h / 2;     // 相对截图
        const d = pp ? Math.hypot(cx - (pp[0] - rx), cy - (pp[1] - ry)) : 0;
        if (d < bestD) { bestD = d; best = { x: rx + cx, y: ry + cy }; }
      }
    }
    if (best) { console.log(`[anchor] 文字「${a.anchor}」命中 (${best.x},${best.y})`); return best; }
    console.log(`[anchor] 文字「${a.anchor}」未识别，转兜底`);
  } catch (e) {
    console.log("[anchor] 文字锚定异常:", e?.message ?? e);
  }
  return null;
}

/**
 * 统一裁决抗迁移策略，返回 { args, conf }（不改动原 step）。
 * 顺序：① 文字锚定 → ② 窗口相对坐标 → ③ 绝对坐标兜底。
 *
 * conf 记录「这次定位到底有多可信」，上层据此决定要不要升级到视觉层：
 *   text     文字锚定命中 —— 最可信，界面改版也常能活
 *   window   窗口相对命中 —— 可信，窗口被拖动/换位置也跟得上
 *   absolute 配了锚点却落到录制坐标 —— ⚠️ **真降级**，说明锚点没找到
 *   none     本来就没配锚点，只有录制坐标 —— 正常路径，不算降级
 *
 * absolute 与 none 必须分开：只有 absolute 才值得叫视觉模型。
 * 混成一个「兜底」的话，没配锚点的步骤每步都会触发升级，成本和延迟直接崩。
 */
async function resolveAnchor(step) {
  const a = step.args || {};
  const args = JSON.parse(JSON.stringify(a));   // 克隆，避免回放多次后位移被反复叠加
  const tool = `${step.server}|${step.tool}`;
  const hadAnchor = !!(a.anchor && String(a.anchor).trim());

  // ① 文字锚定（仅单点工具）
  if (ANCHORABLE.has(tool) && args.anchor) {
    const pt = await anchorByText(step);
    if (pt) {
      if (Array.isArray(args.loc)) args.loc = [pt.x, pt.y];
      else { args.x = pt.x; args.y = pt.y; }
      delete args.anchor;
      return { args, conf: "text" };
    }
  }

  // ② 窗口相对坐标
  if (step.win && step.win.title && Array.isArray(step.win.off)) {
    const r = await findWinRectByTitle(step.win.title);
    if (r) {
      const pp = primaryPoint(step);             // 用原始绝对点算位移
      if (pp) {
        const dx = r[0] + step.win.off[0] - pp[0];
        const dy = r[1] + step.win.off[1] - pp[1];
        addDeltaToArgs(args, dx, dy);
        console.log(`[anchor] 窗口相对重定位（${step.win.title}）Δ=${dx},${dy}`);
        delete args.anchor;
        return { args, conf: "window" };
      }
    } else {
      console.log(`[anchor] 窗口「${step.win.title}」未找到，退回绝对坐标（兜底）`);
    }
  }

  // ③ 兜底：原样（即录制时的绝对坐标）
  delete args.anchor;
  return { args, conf: hadAnchor ? "absolute" : "none" };
}

/* ---------------- 回归探测 + 智能接管 ----------------
 * 这两块是「录制一遍，正常情况下纯回放，界面变了才请模型帮忙」的核心。
 * 关键判断都写在各自注释里，因为这里的每一处取舍都是拿事故换的。
 */

/** 取虚拟桌面范围 + 当前前台窗口标题。失败返回 null。 */
async function screenAndForeground() {
  try {
    const out = String((await psRun(SCREEN_PS, 10000)) || "");
    const i = out.indexOf("|");
    if (i < 0) return null;
    const box = out.slice(0, i).split(",").map(Number);
    if (box.length !== 4 || box.some(isNaN) || !box[2] || !box[3]) return null;
    return { x: box[0], y: box[1], w: box[2], h: box[3], title: out.slice(i + 1).trim() };
  } catch (e) {
    console.log("[probe] 取屏幕信息失败:", e?.message ?? e);
    return null;
  }
}

/**
 * 把逐词 OCR 结果合并成「行」，行内按 x 排序后直接拼接。
 *
 * 两件事都必须做：
 *   ① 合并 —— WinRT OCR 会把「确定」切成「确」「定」两个独立词，
 *      不合并的话锚点文字哪怕就在屏幕正中间也永远匹配不上。
 *   ② 行内重排 —— 同一行文字的 y 会有一两个像素的基线抖动，
 *      直接按 y 排序会把「确(100) 定(102) 取消(101)」排成「确取消定」，
 *      于是 "确定" 这个词在屏幕上是断开的，匹配照样失败。
 *      （这个 bug 是单测抓出来的，肉眼评审看不出来。）
 */
function ocrLines(words) {
  const sorted = (words || []).slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rows = [];
  for (const w of sorted) {
    const last = rows[rows.length - 1];
    const tol = Math.max(6, (w.h || 12) * 0.6);       // 行高的一半内算同一行
    // 已按 y 升序，同一行的词必然连续，所以只跟最后一个桶比就够；
    // baseY 用均值而不是首词的 y，否则一行内 y 慢慢爬升时后半截会被切成新行。
    if (last && Math.abs(w.y - last.baseY) <= tol) {
      last.items.push(w);
      last.baseY = (last.baseY * (last.items.length - 1) + w.y) / last.items.length;
    } else {
      rows.push({ baseY: w.y, items: [w] });
    }
  }
  return rows.map((r) => r.items
    .sort((a, b) => a.x - b.x)
    .map((w) => w.text)
    .join("")
    .toLowerCase());
}

/**
 * 回归探测：判断「现在这块屏幕对应原流程的第几步」。
 *
 * 为什么不问智能体「你干到第几步了」：模型没有步骤计数的内部状态，
 * 只是在看屏幕猜，而且倾向于给一个看起来合理的数字。拿它去对齐重放，
 * 等于把「点错位置」换成「跳错步骤」——后者难查得多。
 * 所以这里只认客观证据：屏幕上的文字、前台窗口标题。
 *
 * 返回 { resumeAt, via } 或 null（未回归）。
 */
/**
 * 纯判定：给定「剩余步骤 + 屏幕上的文字行 + 前台窗口标题」，算出回归点。
 * 单独抽出来是为了能脱离 PowerShell 单测 —— 这段逻辑判错了比慢更难发现：
 * 它不报错，只是让流程从错的地方接着跑。
 *
 * lines 已经过 ocrLines 合并（行内无分隔），所以「确 定」能匹配「确定」。
 */
function pickResumePoint(rest, lines, foregroundTitle, from) {
  const onScreen = (s) => {
    const t = String(s || "").trim().toLowerCase();
    if (!t) return false;
    return lines.some((l) => l.includes(t));
  };

  // ① 文字锚点：按序号从小到大扫，第一个命中的就是断点。
  // 不能按屏幕位置扫——第 6 步和第 9 步都叫「确定」时，按位置会命中错的那个；
  // 按序号取最小才符合「流程往前走」的语义。命中即停，不收集全部：
  // 收全部再取最靠后的，会把智能体多干的那几步误判成「还没干」。
  for (let i = 0; i < rest.length; i++) {
    const s = rest[i] || {};
    const a = s.args && s.args.anchor;
    if (!a || !ANCHORABLE.has(`${s.server}|${s.tool}`)) continue;   // 没配锚点 → 探测里隐形
    if (!onScreen(a)) continue;
    /* 隐形步骤不能被跨过：中间夹着没配锚点的步骤就拒绝回归。
       因为无法确认那一步到底做没做——跳过去可能漏动作或做两遍。
       宁可多跑一轮智能体，也不能跳步。 */
    const skipped = rest.slice(0, i).some((x) => !(x && x.args && x.args.anchor));
    if (skipped) {
      console.log(`[probe] 第 ${from + i + 1} 步命中「${a}」，但中间有未配锚点的步骤，拒绝回归`);
      continue;
    }
    console.log(`[probe] 回归点 = 第 ${from + i + 1} 步（文字「${a}」在屏幕上）`);
    return { resumeAt: from + i, via: "anchor" };
  }

  // ② 窗口标题：文字全对不上时退一步，看前台窗口是不是某一步的目标窗口
  if (foregroundTitle) {
    const ft = String(foregroundTitle).toLowerCase();
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i] && rest[i].win && rest[i].win.title;
      if (w && ft.includes(String(w).toLowerCase())) {
        console.log(`[probe] 窗口命中：前台「${foregroundTitle}」≈ 第 ${from + i + 1} 步`);
        return { resumeAt: from + i, via: "window" };
      }
    }
  }

  return null;
}

async function probeAnchors(steps, from) {
  const rest = (steps || []).slice(from);
  if (!rest.length) return null;

  const scr = await screenAndForeground();
  if (!scr) return null;

  let words = [];
  try {
    /* 超宽桌面（双 4K 拼接能到 7680）直接跳过文字探测：
       这种图 OCR 要么超时要么糊成一团，拿它做判断比不做还糟。
       跳过之后上层会继续交给智能体，慢一点但不会判错。 */
    if (scr.w > 6000 || scr.h > 6000) {
      console.log(`[probe] 桌面 ${scr.w}x${scr.h} 过大，跳过文字探测`);
    } else {
      const buf = await screenshotRegion(scr.x, scr.y, scr.w, scr.h);
      if (buf) words = await ocrWords(buf, "zh-Hans-CN");
    }
  } catch (e) {
    console.log("[probe] 全屏 OCR 失败:", e?.message ?? e);
  }

  return pickResumePoint(rest, ocrLines(words), scr.title, from);
}

/** 把剩余步骤压成可读清单，给接管时的智能体当上下文。
 *  它必须知道「本来打算干什么」，否则只能盯着当前画面瞎猜下一步。 */
function summarizeSteps(steps, limit = 8) {
  const out = [];
  const list = steps || [];
  list.slice(0, limit).forEach((s, i) => {
    const t = (s && s.type) || "action";
    if (t !== "action") { out.push(`${i + 1}. [${t}] 编排节点`); return; }
    const a = (s && s.args) || {};
    const bits = [];
    if (a.anchor) bits.push(`目标「${a.anchor}」`);
    if (a.text) bits.push(`输入「${String(a.text).slice(0, 24)}」`);
    if (a.keys) bits.push(`按键 ${Array.isArray(a.keys) ? a.keys.join("+") : a.keys}`);
    if (Array.isArray(a.loc)) bits.push(`录制坐标 ${a.loc[0]},${a.loc[1]}`);
    out.push(`${i + 1}. ${(s && s.tool) || "?"} ${bits.join(" ")}`.trim());
  });
  if (list.length > limit) out.push(`… 还有 ${list.length - limit} 步未列出`);
  return out.join("\n");
}

const AGENT_BATCH = 3;          // 每轮让智能体推进几步就停下重新探测
const AGENT_MAX_STEPS = 15;     // 一次接管累计最多借给它多少步
const AGENT_MAX_ROUNDS = 5;     // 一次回放最多允许「接管→回归」来回几趟

/* ---------------- 轮次推定 ----------------
 * 嵌套循环里失守时，光知道「回到子单元第几步」不够 —— 还得知道「回到第几轮」。
 * 三个来源，按可信度从硬到软。都做成纯函数，因为判错了不会报错，
 * 只会让循环多跑一轮或少跑一轮（重复提交 / 漏提交），这种错最难查。
 */

/**
 * 校验模型自报的轮次有没有自证。
 * 规则：evidence 里必须真的出现那个数字。
 *
 * 为什么不能只信 roundSeen：模型没有轮次计数器，它就是看屏幕猜，
 * 而且倾向于给一个「看起来合理」的数。但让它把原文抄下来，
 * 它就很难既编数字又编出处 —— 这是最便宜的防幻觉手段。
 */
function verifyRoundClaim(seen, evidence) {
  const n = Number(seen);
  // 必须是正整数：小数（3.5 条）和负数都不该出现在轮次计数里，直接判为无效
  if (!Number.isInteger(n) || n < 0 || n > 100000) return null;
  const ev = String(evidence || "").trim();
  if (ev.length < 2) return null;
  // 数字必须以「独立数字」的形式出现：前面不能紧贴别的数字，后面同理。
  // 否则 "已处理 30 条" 会把 3 也判成命中。
  const re = new RegExp(`(^|\\D)0*${n}(\\D|$)`);
  if (!re.test(ev)) return null;
  return Math.floor(n);
}

/**
 * 数「轮次标记动作」被成功执行了几次。
 * 数据源是审计表 —— callTool 每调一次工具就写一条，所以这里零成本，
 * 不用额外埋点。传 entries 而不是直接读全局，是为了能单测。
 *
 * perRound：每轮对应几次该动作（默认 1）。这一项故意留给用户配，
 * 因为「点了 3 次提交 ≠ 完成了 3 轮」——有一次点了没生效时，
 * 只有用户知道该按几次算一轮。程序不该假装能自动推断。
 */
function countMarks(entries, since, mark, perOverride) {
  if (!mark || typeof mark !== "object") return null;
  const tool = String(mark.tool || "Click");
  const anchor = String(mark.anchor || "").toLowerCase();
  // perOverride 用来传「每轮几次」：优先实测值，其次静态数，最后用户手填
  const per = Math.max(1, Number(perOverride) || Number(mark.perRound) || 1);
  let n = 0;
  for (const e of entries || []) {
    if (Number(e.ts) < since) continue;         // 只看本次运行
    if (!e.ok) continue;                        // 调用就直接失败的不能算
    if (String(e.tool) !== tool) continue;
    if (anchor && !String(e.args || "").toLowerCase().includes(anchor)) continue;
    n++;
  }
  return Math.floor(n / per);
}

/**
 * 数「循环体里这个标记动作出现了几次」——也就是每轮应该点几次。
 *
 * 为什么直接数而不问用户：循环体是静态的步骤数组，答案本来就写在里面。
 * 让用户再填一遍「每轮几次」纯属重复劳动，而且他会填错。
 *
 * if 的两支用 max 不是相加：分支只会走一支。
 * loop 的 body 递归进去，但只算一次（内层循环的重复次数不叠乘 ——
 * 标记动作基本都是「提交」这种收尾动作，不会藏在内层循环里；
 * 叠乘反而会在嵌套循环下炸出离谱的分母）。
 */
function countMarkInSteps(body, mark) {
  if (!mark || typeof mark !== "object") return 0;
  const tool = String(mark.tool || "Click");
  const anchor = String(mark.anchor || "").toLowerCase();
  const hit = (s) => {
    if (String(s.tool) !== tool) return false;
    if (!anchor) return true;
    let t = "";
    try { t = JSON.stringify(s.args || {}); } catch { t = ""; }
    return t.toLowerCase().includes(anchor);
  };
  let n = 0;
  for (const s of body || []) {
    if (!s || typeof s !== "object") continue;
    const t = s.type || "action";
    if (t === "action") { if (hit(s)) n++; continue; }
    if (t === "loop") { n += countMarkInSteps(s.body, mark); continue; }
    if (t === "if") { n += Math.max(countMarkInSteps(s.then, mark), countMarkInSteps(s.else, mark)); continue; }
  }
  return n;
}

/**
 * 步骤签名：用来判断「这两段录制是不是同一个循环体的重复」。
 * 关键是把坐标按 40px 量化后收进签名 —— 不收的话，所有纯点击的签名都是
 * `Click|{}`，任何两段都会「看起来一样」；量化后同一位置的重复才算相同，
 * 不同位置的点击不会混为一谈。
 */
function stepSig(s) {
  const a = (s && s.args) || {};
  const keep = {};
  for (const k of ["anchor", "text", "keys", "shortcut", "button", "clicks", "direction", "wheel_times", "durationMs"]) {
    if (a[k] !== undefined) keep[k] = a[k];
  }
  const q = (v) => Math.round(Number(v) / 40) || 0;
  if (Array.isArray(a.loc)) keep.loc = [q(a.loc[0]), q(a.loc[1])];
  else if (a.x !== undefined) keep.xy = [q(a.x), q(a.y)];
  return `${(s && s.type) || "action"}:${(s && s.tool) || ""}:${JSON.stringify(keep)}`;
}

/** 比较 arr[a..a+len) 与 arr[b..b+len) 是否逐位相同 */
function sameRange(arr, a, b, len) {
  for (let i = 0; i < len; i++) if (arr[a + i] !== arr[b + i]) return false;
  return true;
}

/**
 * 检测录制产物里有没有「同一段操作重复了 k 次」。
 *
 * 录制是平的：用户实际处理了 3 条数据，录下来就是 3 段一模一样的步骤，
 * 工作流里却看不出一丝「循环」的意思。这个函数把那段找出来，
 * 让面板能问一句「要不要折叠成重复 3 次的循环」。
 *
 * 只认**完全相同**的重复。每轮输入内容不同（读第 1/2/3 行数据填进去）
 * 时签名就不相等，检测会失败 —— 那是「参数化录制」该管的事，不在这。
 *
 * 返回 { count, unitLen, start, tail } 或 null。
 */
function detectRepeat(steps) {
  const list = (steps || []).filter((s) => s && typeof s === "object");
  const n = list.length;
  if (n < 4) return null;                      // 至少两轮、每轮两步，否则不值得折

  const arr = list.map(stepSig);
  // 全是同一个签名（比如连点四下同一处）说明根本没有「一段操作」，
  // 折成循环只会变成「循环点 4 次」，没有意义
  if (new Set(arr).size < 2) return null;

  let best = null;
  // 开头可能有一两个一次性步骤（打开软件、点菜单），所以起点允许偏移
  for (let start = 0; start < Math.min(3, n); start++) {
    const room = n - start;
    /* 单元至少两步：单步重复不是循环。
       「连点两次保存」在录制里到处都是，按循环处理纯属误报 ——
       真需要连点 N 次，用户直接多录几下就行，折成「循环 1 步」反而更难改。 */
    for (let L = 2; L <= Math.floor(room / 2); L++) {
      let k = 1;
      while (start + (k + 1) * L <= n && sameRange(arr, start, start + k * L, L)) k++;
      if (k < 2) continue;
      const covered = k * L;
      if (!best || covered > best.covered) {
        best = { count: k, unitLen: L, start, covered, tail: n - start - covered };
      }
    }
  }
  if (!best) return null;
  // 覆盖不到一半就不提 —— 说明只是零散地撞了几次，不是真循环
  if (best.covered < n * 0.5) return null;
  return { count: best.count, unitLen: best.unitLen, start: best.start, tail: best.tail };
}

/**
 * 三轮推定，返回「已完成的轮数」（= 下一轮应有的索引），拿不到返回 null。
 *   ① 模型自证 —— 有原文，最可信
 *   ② 审计动作计数 —— 客观但可能虚高
 * ③（纯自报无原文）不走这里，在调用方就被 verifyRoundClaim 挡掉了。
 * 两者冲突时信 ①（它有原文），但记日志，方便事后对账。
 */
function deduceRound(res, scope, entries, since) {
  if (!scope || scope.kind !== "times") return null;
  const byClaim = verifyRoundClaim(res && res.roundSeen, res && res.roundEvidence);
  /* perRound 优先用「上一轮实测值」：循环体里有分支时静态数不准
     （有的轮次走复核分支多点一次），实测能自动收敛。
     第一轮还没有实测值，退回静态数。 */
  const per = Number(scope.lastRoundCount) > 0
    ? Number(scope.lastRoundCount)
    : Number(scope.markPerRound) || 1;
  const byMark = scope.mark ? countMarks(entries, since, scope.mark, per) : null;

  if (byClaim !== null && byMark !== null && byClaim !== byMark) {
    log(`[round] 自证 ${byClaim} 与动作计数 ${byMark}（每轮按 ${per} 次算）不一致，采信自证（有原文）`);
  }
  if (byClaim !== null) return byClaim;
  if (byMark !== null) return byMark;
  return null;
}

/** 给智能体看的「你现在在哪一层」。null = 顶层线性流程。 */
function scopeInfo(ctx) {
  const st = (ctx && ctx.scopes) || [];
  const top = st[st.length - 1];
  if (!top) return null;
  return {
    depth: st.length,
    kind: top.kind,
    round: top.iter() + 1,
    total: top.kind === "times" ? top.total : 0,
  };
}

/**
 * 循环游标能不能跳到 to（to = 已完成轮数，也是下一轮应有的索引）。
 * 只允许往前：倒退等于把已经做过的事重做一遍，可能重复提交。
 * to === total 表示全部做完，允许 —— 循环会自然退出。
 * 抽成纯函数只为一件事：这段判断一旦写错，后果是重复提交或漏提交，
 * 现场看不出来，必须能单独测。
 */
function canJump(from, to, total) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(total)) return false;
  return to > from && to <= total;
}

/**
 * 轮次对齐：把「已经做到第几轮」写回当前循环的游标。
 * 只对 times 型有意义 —— while 型靠条件决定要不要继续，改游标没用
 * （它的条件每轮都会重算，接管把剩下的干完了，条件自然就 false 了）。
 */
function alignRound(res, ctx) {
  const st = (ctx && ctx.scopes) || [];
  const scope = st[st.length - 1];
  if (!scope || scope.kind !== "times") return;
  const done = deduceRound(res, scope, AUDIT_MEM, Number(scope.since) || Number(ctx.startedAt) || 0);
  if (done === null) {
    log("[round] 拿不到可信轮次，游标不动");
    return;
  }
  const before = scope.iter();
  if (scope.jumpTo(done)) {
    log(`[round] 轮次对齐：第 ${before + 1} 轮 → 已完成 ${done} 轮，下一轮从第 ${done + 1} 轮开始`);
  } else {
    // 倒退或越界：宁可不动。倒退会把已经做过的事重做一遍。
    log(`[round] 推定已完成 ${done} 轮（当前第 ${before + 1} 轮 / 共 ${scope.total} 轮），不可用，游标不动`);
  }
}

/**
 * 预算式智能接管：分批推进，每批停下就探一次「是否已回到原轨道」。
 *
 * 分批而不是「让它一路跑到结束」，理由很硬：跑过头的步骤没法回退
 * （比如已经点了提交），只有每批都停下来探一次，才可能及早抓回确定性轨道。
 *
 * 返回：可继续的步骤索引；'fallback' 表示 once 模式没救回来（用录制坐标顶上）；
 *       null 表示放弃。
 */
async function takeover(steps, from, ctx) {
  const list = steps || [];
  const once = ctx.escalate === "once";

  /* 全局次数守卫：回归之后又在下游失守，会再一次进来。
     不设上限的话，一条到处都失守的流程会不停「接管→回归→再失守」，
     token 烧光了还停不下来。 */
  ctx.agentRuns = (Number(ctx.agentRuns) || 0) + 1;
  if (ctx.agentRuns > AGENT_MAX_ROUNDS) {
    log(`[agent] 本次回放已接管 ${ctx.agentRuns - 1} 次，达到上限，不再接管`);
    return once ? "fallback" : null;
  }

  const budget = once ? 1 : Math.max(1, Math.min(AGENT_MAX_STEPS, Number(ctx.agentBudget) || AGENT_MAX_STEPS));
  let used = 0;

  while (used < budget) {
    const batch = Math.min(AGENT_BATCH, budget - used);
    let res;
    try {
      res = await askPanelForAgent({
        stepNo: from + 1,
        totalNo: list.length,
        goal: String(ctx.goal || "").trim(),
        batch,
        remain: summarizeSteps(list.slice(from)),
        conf: ctx.lastConf || "absolute",
        // 嵌套结构里必须告诉它「你在哪一层、第几轮」，否则它会把这轮当成唯一的一轮
        scope: scopeInfo(ctx),
      });
    } catch (e) {
      log("[agent] 接管失败：", e?.message ?? e);
      return once ? "fallback" : null;
    }

    // 面板回报用了多少步。用 max(1,…) 保证一定推进计数，否则失败回报 0 步会死循环。
    const did = Math.max(1, Number(res.steps) || 1);
    used += did;

    /* 整条流程结束 —— 只认 finished。
       done 的含义是「这一批做完了」，finished 才是「最终目标达成了」。
       混为一谈会让接管在第一批就收工，后面所有步骤静默丢掉。
       置 ctx.finished 而不是只 return：嵌套层返回只能结束本层，
       父层的循环还会照样跑下一轮。 */
    if (res.done && res.finished) {
      ctx.finished = true;
      log("[agent] 智能体判定最终目标已达成，整条流程结束");
      return list.length;
    }

    // 先看屏幕证据（客观，优先）
    const back = await probeAnchors(list, from);
    if (back && back.resumeAt > from) {
      alignRound(res, ctx);
      log(`[agent] 回归轨道：从第 ${back.resumeAt + 1} 步继续（依据 ${back.via}）`);
      return back.resumeAt;
    }

    /* 屏幕证据说「没往前走」。最常见的原因是：按钮点完还留在原处，
       于是 from 那一步的锚点一直在，探测永远原地打转。
       这时用智能体自报的进度做**交叉验证**：只有它说的那一步的目标
       确实出现在屏幕上（说明它真走到了那儿），才采信这个数字。
       自报不能单独用 —— 模型没有步骤计数器，那个数字是猜的。

       编号基准要小心：智能体看到的是 summarizeSteps 给的那份清单，
       编号从 1 起、对应 from 开头。所以全局索引 = from + 自报 - 1。
       （第一版忘了 −1，导致自报永远对不上，被探测一路否掉。） */
    const claim = from + Number(res.resumeAt) - 1;
    if (Number.isFinite(claim) && claim > from && claim < list.length) {
      const at = await probeAnchors(list, claim);
      if (at && at.resumeAt === claim) {
        alignRound(res, ctx);
        log(`[agent] 采信自报进度：第 ${claim + 1} 步（探测已确认该步目标在屏幕上）`);
        return claim;
      }
      log(`[agent] 自报第 ${claim + 1} 步，但探测不认（该步目标没出现），继续推进`);
    }

    if (back) log(`[agent] 探测仍指向第 ${from + 1} 步，视为未推进`);
    log(`[agent] 本轮推进 ${did} 步仍未回归（已用 ${used}/${budget}）`);
  }

  log(`[agent] 接管累计 ${used} 步仍未回归，放弃`);
  return once ? "fallback" : null;
}

/* ---------- ASR 服务（本地 Whisper）：进程管理 + CPU/GPU 切换 ---------- */

/* ASR 目录双路径探测（DESIGN §5.1）：
     打包态 <APP_ROOT>/resources/asr（pack.cjs 随包复制源码四件套）
     开发态 <项目根>/asr
   ORB_ASR_DIR 可强制覆盖（§6.2 环境变量约定）。 */
const APP_ROOT = path.resolve(HERE, "..");
/** 取第一个存在的路径；都没有就返回最后一个（让上层 existsSync 去报"找不到"） */
function firstExisting(paths) {
  for (const p of paths) { try { if (p && fsSync.existsSync(p)) return p; } catch { /* ignore */ } }
  return paths[paths.length - 1] || "";
}
const ASR_DIR = process.env.ORB_ASR_DIR
  || firstExisting([path.join(APP_ROOT, "resources", "asr"), path.resolve(HERE, "..", "asr")]);
const ASR_SCRIPT = path.join(ASR_DIR, "asr_server.py");
const ASR_CONF = path.join(ASR_DIR, "asr.conf");
/* 解释器优先级（DESIGN §5.1）：
     ① asr/venv/Scripts/python.exe —— 用户一键安装（prepare.ps1）建的独立 venv，
        依赖（faster-whisper 等）全在里面，与前台通道的运行时互不污染；
     ② 随包嵌入 python（runtime.mjs 解析）—— 只是保底：没有 fastapi/faster-whisper，
        asr_server 起不来，由 /health 超时把真实状态报给面板，不会崩。
   PYTHONPATH 指向用户自管的 asr/site-packages（可选，给不想建 venv 的人留的口）。 */
function asrVenvPy() { return path.join(ASR_DIR, "venv", "Scripts", "python.exe"); }
function asrPython() {
  const venv = asrVenvPy();
  if (fsSync.existsSync(venv)) return venv;
  const rt = resolvePython();
  return rt.ok && rt.exe ? rt.exe : venv;
}
/** 用户是否已完成一键安装（venv 就绪）—— 自启门槛与"需要安装"提示都看它 */
function asrInstalled() { return fsSync.existsSync(asrVenvPy()); }
/** 模型权重是否已下载（small ≈ 480MB，download_model.py 落到 models/<name>） */
function asrModelDownloaded() {
  const name = String(readAsrConf().model || "small");
  return fsSync.existsSync(path.join(ASR_DIR, "models", name, "model.bin"));
}
/** 本地已下全权重的模型名列表（面板显示"已下载：small / medium"）；
 *  服务在跑时以 /health 的 modelsAvailable 为准，没跑就自己扫 models/ 目录。 */
function asrModelsAvailable() {
  const base = path.join(ASR_DIR, "models");
  let names = [];
  try {
    names = fsSync.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fsSync.existsSync(path.join(base, d.name, "model.bin")))
      .map((d) => d.name)
      .sort();
  } catch { /* models/ 不存在（没装）就是空列表 */ }
  return names;
}
/** 可追加下载的模型权重（name → HF repo）。
 *  small 由一键安装（prepare.ps1）负责；medium 等额外模型走 /api/asr/model，
 *  供首跑向导的「可选组件」勾选后下载（≈1.5GB，默认不勾）。 */
const ASR_MODEL_REPOS = {
  small: "Systran/faster-whisper-small",
  medium: "Systran/faster-whisper-medium",
};
/* ASR 自动启动开关：ORB_ASR_AUTOSTART=0 可关掉。
 * 正常不用设；主要是给单测用 —— 测试会 spawn 真 bridge，
 * 若这时自动拉起 Whisper（small 模型 + GPU），又慢又会和用户当前会话抢显存。
 * 另外 asr.conf 里 autostart:false 可单独关自动启动（只保留手动/按需拉起）。 */
const ASR_AUTOSTART = !/^(0|false|no)$/i.test(String(process.env.ORB_ASR_AUTOSTART ?? "").trim());
const ASR_PORT = Number(process.env.ORB_ASR_PORT || 19876);
const ASR_BASE = `http://127.0.0.1:${ASR_PORT}`;

function readAsrConf() {
  try { return JSON.parse(fsSync.readFileSync(ASR_CONF, "utf8")) || {}; } catch { return {}; }
}
function writeAsrConf(patch) {
  const next = { ...readAsrConf(), ...patch };
  try { writeJsonAtomic(ASR_CONF, next); } catch (e) { log("[asr] 写配置失败:", e.message); }
  return next;
}
async function asrHealth(timeoutMs = 2500) {
  try {
    const r = await fetch(ASR_BASE + "/health", { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
let asrProc = null;
/** spawn 的失败是异步的（'error' 事件），必须有监听者，否则整个 bridge 被带走。 */
let asrSpawnErr = "";
/** 一键安装（prepare.ps1）的进行态：{running, proc, lines, step, percent, ok, error, startedAt} */
let asrPrepare = null;
function asrSpawn() {
  // 已有实例在跑就别再起一个：新引用会把旧的顶掉，那个进程从此再没人管
  if (asrProc && asrProc.exitCode === null) return;
  const conf = readAsrConf();
  // device/compute 原样透传：conf 里可以是 auto，由 asr_server 的 resolve_device_compute
  // 按实际硬件定，不可用时回落 cpu/int8 并写回 conf（DESIGN §5.3）
  const dev = String(conf.device || "auto");
  const env = cleanCliEnv({
    ORB_ASR_DEVICE: dev,
    ORB_ASR_COMPUTE: String(conf.compute || "auto"),
    ...(conf.model ? { ORB_ASR_MODEL_NAME: String(conf.model) } : {}),
    // 中文路径 / 中文日志不能变乱码；不在用户机上写 __pycache__（安装目录可能只读）
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
  });
  // 用户自管的 asr/site-packages（可选保底，见 asrPython 注释）
  const extraSite = path.join(ASR_DIR, "site-packages");
  if (fsSync.existsSync(extraSite)) env.PYTHONPATH = extraSite;
  asrSpawnErr = "";
  asrProc = spawn(asrPython(), [ASR_SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: ASR_DIR });
  asrProc.stdout.on("data", (d) => log("[asr]", String(d).trim()));
  asrProc.stderr.on("data", (d) => log("[asr:err]", String(d).trim()));
  asrProc.on("error", (e) => {
    asrSpawnErr = String(e?.message ?? e);
    log("[asr] 启动异常:", asrSpawnErr, "→", asrPython());
    asrProc = null;
  });
  asrProc.on("exit", (c) => { log("[asr] 退出 code =", c); asrProc = null; });
  if (asrProc) registerChild(asrProc.pid, "asr");
}
/* ══════════ ASR 空闲回收 ══════════
 * Whisper 常驻要 ~238MB 内存 + 约 2.1GB 显存（GPU 模式还会让独显一直醒着），
 * 但绝大多数时间没人用。所以：按需加载 + 空闲 N 分钟自动停。
 * 注意只在**当前会话没有正在用的语音功能**时回收（rtProc 在跑就跳过）。
 *
 * 默认 5 分钟（原 10 分钟）：实测闲置 10 分钟太久，那 2.1GB 显存和白占的 238MB
 * 内存会一直压着。5 分钟的代价是"隔几分钟就说一句"时会反复启停——每次要重新
 * 加载模型，有几秒到几十秒的等待。嫌烦就用 ORB_ASR_IDLE_MS 调大（毫秒），
 * 设成很大的值等于关闭自动回收。 */
const ASR_IDLE_MS = Number(process.env.ORB_ASR_IDLE_MS || 5 * 60 * 1000);
let asrLastUse = 0;
let asrReaper = null;

function asrTouch() { asrLastUse = Date.now(); }

function startAsrIdleReaper() {
  if (asrReaper) return;
  asrReaper = setInterval(async () => {
    if (!asrLastUse) return;
    if (Date.now() - asrLastUse < ASR_IDLE_MS) return;
    if (rtProc) return;                       // 实时字幕还在跑，别停
    // 不是自己拉起的就别停：很可能是另一个控制台实例正在用的，
    // asrStop() 会按端口找 PID 强杀，一杀就把别人那份也带走了。
    if (!asrProc) { asrLastUse = 0; return; }
    log(`[asr] 空闲超过 ${Math.round(ASR_IDLE_MS / 60000)} 分钟，停掉释放内存/显存`);
    asrLastUse = 0;
    try { await asrStop(); } catch (e) { log("[asr] 空闲回收失败:", e?.message ?? e); }
  }, 60000);
  asrReaper.unref?.();     // 别因为这个定时器把进程吊住不退出
}

async function asrEnsure(timeoutMs = 90000) {
  asrTouch();
  if (await asrHealth()) return true;
  try { asrSpawn(); } catch (e) { log("[asr] 启动失败:", e?.message ?? e); return false; }
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    await sleep(1000);
    // 解释器/脚本压根不在（asr\venv 没建）时立刻放弃，
    // 否则每次「切换识别设备」都要干等 90 秒才报错。
    if (asrSpawnErr) { asrSpawnErr = ""; return false; }
    if (await asrHealth()) return true;
  }
  return false;
}
async function asrStop() {
  if (asrProc) {
    try { asrProc.kill(); } catch { /* ignore */ }
    asrProc = null;
  } else {
    // 不是本进程拉起的（例如启动器先起的）：按端口找 PID 杀掉
    try {
      const out = await new Promise((res) => execFile("netstat", ["-ano"], (e, so) => res(e ? "" : so)));
      const line = String(out).split("\n").find((l) => l.includes(":" + ASR_PORT) && l.includes("LISTENING"));
      const pid = line && line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) await new Promise((res) => execFile("taskkill", ["/PID", pid, "/F"], () => res()));
    } catch { /* ignore */ }
  }
  for (let i = 0; i < 25; i++) {
    if (!(await asrHealth(600))) return;
    await sleep(300);
  }
}

/* ---------- 实时字幕服务（回环采集 -> 实时上屏）---------- */

const RT_SCRIPT = path.join(ASR_DIR, "subtitle_rt.py");
const RT_PORT = Number(process.env.ORB_RT_PORT || 19879);

async function rtHealth(timeoutMs = 2000) {
  try {
    const r = await fetch(`http://127.0.0.1:${RT_PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
let rtProc = null;
let rtSpawnErr = "";
function rtStart() {
  // 只判 rtProc 非空不够：进程已经退出但事件还没到时 rtProc 仍是旧对象，
  // 这里会被"以为还在跑"挡住，字幕就再也起不来。按 exitCode 判活。
  if (rtProc && rtProc.exitCode === null) return;
  rtSpawnErr = "";
  rtProc = spawn(asrPython(), [RT_SCRIPT], {
    env: cleanCliEnv({
      ORB_ASR_ENDPOINT: "http://127.0.0.1:19876/v1/audio/transcriptions",
      /* 字幕落盘目录：跟会话历史/工作流一样进 DATA_DIR（开发态是项目根，
         打包态由 main.js 用 ORB_DATA_DIR 传 %APPDATA%\ORB 控制台 下来）。
         ⚠️ subtitle_rt.py 里原来写死了开发机的私有路径 ——
         那是开发机的私有路径，开源后必须去掉；留 ORB_RT_SRT_DIR 环境变量作覆盖口。 */
      ORB_RT_SRT_DIR: process.env.ORB_RT_SRT_DIR || path.join(DATA_DIR, ".cache", "实时字幕"),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: ASR_DIR,
  });
  rtProc.stdout.on("data", (d) => log("[rt]", String(d).trim()));
  rtProc.stderr.on("data", (d) => log("[rt:err]", String(d).trim()));
  rtProc.on("error", (e) => {
    rtSpawnErr = String(e?.message ?? e);
    log("[rt] 启动异常:", rtSpawnErr, "→", asrPython());
    rtProc = null;
  });
  rtProc.on("exit", (c) => { log("[rt] 退出 code =", c); rtProc = null; });
  if (rtProc) registerChild(rtProc.pid, "rt");
}
async function rtStop() {
  if (rtProc) {
    try { rtProc.kill(); } catch { /* ignore */ }
    rtProc = null;
  } else {
    try {
      const out = await new Promise((res) => execFile("netstat", ["-ano"], (e, so) => res(e ? "" : so)));
      const line = String(out).split("\n").find((l) => l.includes(":" + RT_PORT) && l.includes("LISTENING"));
      const pid = line && line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) await new Promise((res) => execFile("taskkill", ["/PID", pid, "/F"], () => res()));
    } catch { /* ignore */ }
  }
  for (let i = 0; i < 15; i++) {
    if (!(await rtHealth(500))) return;
    await sleep(300);
  }
}
function rtOpenBrowser() {
  try {
    execFile("cmd", ["/c", "start", "", `http://127.0.0.1:${RT_PORT}`], { windowsHide: true }, () => {});
  } catch { /* ignore */ }
}

/* ══════════ 积分 / 额度 ══════════
   WorkBuddy 把每条消息的真实积分消耗写进 ~/.workbuddy/workbuddy.db 的
   session_usage.credit_json（{ 消息ID: 积分 }）。

   ★ 关键取舍：不能"取最新那个会话"就完事 —— 那样显示的是用户正在交谈的那个
     WorkBuddy 对话的消耗，而不是 ORB 控制台自己花掉的。
     所以这里做「归因」：只有 ORB 派发出去的后台任务（CLI 一次性执行，每次新建会话）
     才计入。做法是在 spawnOnce 前后各快照一次 session 表：
       · 派发期间**新出现**的会话 → 认定是这次任务建的，整段计入；
       · 之前就存在的会话（比如用户正在用的 WorkBuddy 对话）→ 一律不计，
         哪怕它在增长也不算，避免把别人的账算到 ORB 头上。
     之后每次 /api/credits 只补记"已认领会话"的新增，不再认领新会话。
   只读、不写、不联网。 */
// ORB_WB_DB 只用于离线单测（指向一份造出来的库），正常运行时不设。
const WB_DB = process.env.ORB_WB_DB || (() => {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return home ? path.join(home, ".workbuddy", "workbuddy.db") : "";
})();
// ORB_CREDITS_FILE 同样只给单测用（避免单测把真实累计值写脏）
const CREDITS_FILE = process.env.ORB_CREDITS_FILE || path.join(DATA_DIR, "credits.json");
const CREDITS_FILE_OLD = path.join(HERE, "credits.json");

/** 本次 ORB 运行期间，控制台自己花掉的积分（进程重启即归零，符合"这次"的语义）。 */
const orbCredits = { total: 0, tasks: 0, last: 0, running: 0, since: Date.now() };
/** 已被认定属于 ORB 的会话 id；只有它们的后续增长才会继续计入。 */
const orbSessions = new Set();
/** 累计（跨 ORB 重启，落盘到 credits.json）。 */
let creditsAllTime = 0;
try {
  for (const f of [CREDITS_FILE, CREDITS_FILE_OLD]) {
    try {
      const v = Number(JSON.parse(fsSync.readFileSync(f, "utf8")).allTime) || 0;
      if (v) { creditsAllTime = v; break; }   // 累计值不可逆，旧位置有就接着用
    } catch { /* 这一份没有/坏了 */ }
  }
} catch { /* 首次运行没有文件 */ }
let creditsBase = null;   // 上一次快照：session_id -> 累计积分

function saveCreditsAllTime() {
  try { writeJsonAtomic(CREDITS_FILE, { allTime: Math.round(creditsAllTime * 100) / 100, updatedAt: Date.now() }, 1); } catch { /* ignore */ }
}

/** 快照：读一次 session_usage，返回 Map<sessionId, 该会话累计积分>。 */
async function snapCredits() {
  const m = new Map();
  if (!WB_DB || !fsSync.existsSync(WB_DB)) return m;
  let db = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(WB_DB, { readOnly: true });
    for (const r of db.prepare("select session_id, credit_json from session_usage").all()) {
      let v = 0;
      try {
        const o = JSON.parse(r.credit_json || "{}") || {};
        for (const k of Object.keys(o)) if (typeof o[k] === "number") v += o[k];
      } catch { /* ignore */ }
      m.set(String(r.session_id), v);
    }
  } catch { /* 库被锁/不存在就当空快照，绝不影响主流程 */ }
  finally { try { db?.close(); } catch { /* ignore */ } }
  return m;
}

/** 用最新快照推进账本。allowNew=true 时才认领新会话（只在派发任务期间开）。 */
async function pumpCredits(allowNew, before) {
  const now = await snapCredits();
  if (!now.size) { creditsBase = now; return 0; }
  const prev = before || creditsBase;
  let add = 0;
  if (prev) {
    for (const [id, v] of now) {
      if (!prev.has(id)) {
        if (allowNew) { orbSessions.add(id); add += v; }     // 派发期间冒出来的 → 这次任务建的
      } else if (orbSessions.has(id)) {
        const d = v - prev.get(id);
        if (d > 0) add += d;                                  // 已认领会话继续跑，继续计
      }
    }
  } else if (allowNew) {
    // 首次快照：不认领任何东西（否则一上来就会把用户正在聊的会话算进来）
  }
  creditsBase = now;
  if (add > 0) {
    orbCredits.total = Math.round((orbCredits.total + add) * 100) / 100;
    creditsAllTime = Math.round((creditsAllTime + add) * 100) / 100;
    saveCreditsAllTime();
  }
  return add;
}

/** 给 spawnOnce 包一层"电表"：只把派发期间新建的会话算到 ORB 头上。 */
async function metered(fn) {
  const before = await snapCredits();
  orbCredits.running++;
  try { return await fn(); }
  finally {
    orbCredits.running--;
    // CLI 退出后记账可能还有几十毫秒才落盘，等一会儿再结算
    await new Promise((r) => setTimeout(r, 400));
    const add = await pumpCredits(true, before);
    orbCredits.tasks++;
    orbCredits.last = Math.round(add * 100) / 100;
    log("[credits] 本次派发计入", orbCredits.last, "累计", orbCredits.total);
  }
}

async function readCredits() {
  await pumpCredits(false, null);          // 补记已认领会话的增长
  const data = {
    ok: true,
    scope: "orb",                          // 只统计控制台自己派发的任务
    credits: orbCredits.total,
    tasks: orbCredits.tasks,
    last: orbCredits.last,
    running: orbCredits.running,
    allTime: Math.round(creditsAllTime * 100) / 100,
    since: orbCredits.since,
    sessions: orbSessions.size,
    model: WB_MODEL || "",
    db: !!creditsBase,
  };
  return data;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // 鉴权：预检请求（OPTIONS）不带自定义头，必须放行且不泄露任何信息；
  // 其余 /api/* 一律要令牌。
  if (url.pathname.startsWith("/api/") && !PUBLIC_PATHS.has(url.pathname)) {
    if (req.headers["x-orb-token"] !== TOKEN) {
      send(res, 401, { ok: false, error: "缺少或错误的 X-Orb-Token" });
      return;
    }
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await fs.readFile(path.join(HERE, "orb.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, { ok: true, uptime: process.uptime(), jobs: jobs.size });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    // 后台 CLI 检测：结果缓存 30s（resolveWbCli），所以 5 秒一次的轮询不会反复 spawn where。
    // 不隐藏这条通道：灯变灰 + hover 文案，用户才知道「有这功能，但要自己装」。
    const cliNow = await resolveWbCli();
    const out = {
      orb: { ok: true, label: "orb-native", tools: ORB_TOOL_LIST },
    };
    for (const key of Object.keys(SERVERS)) {
      const def = SERVERS[key];
      if (def.kind === "cli") {
        out[key] = {
          // CLI 没找到就置灰（ok:false）：面板据此把后台灯画成灰，并给出安装提示
          ok: !!cliNow.found,
          label: def.label,
          tools: WORKBUDDY_TOOL_LIST,
          cli: cliStatusPayload(cliNow),
        };
        continue;
      }
      // lazy 的服务不在这里预热：面板根本不显示它，拉起来只是白占内存（见 SERVERS.dsh 注释）
      if (def.lazy && !sessions.has(key)) {
        out[key] = { ok: true, label: def.label, tools: [], lazy: true };
        continue;
      }
      // 连接失败后退避：这个接口每 5 秒被轮询一次，坏掉的 server 会变成
      // "每 5 秒重连一次、每次都超时"，白烧 CPU 还拖慢整个 status 响应。
      if (sessionBackoff.has(key)) {
        const left = sessionBackoff.get(key) - Date.now();
        if (left > 0) {
          out[key] = { ok: false, label: def.label, error: "连接失败，稍后重试", retryInMs: left };
          continue;
        }
        sessionBackoff.delete(key);
      }
      try {
        const s = await getSession(key);
        out[key] = { ok: true, label: def.label, tools: s.tools.map((t) => t.name) };
        sessionBackoff.delete(key);
      } catch (err) {
        sessionBackoff.set(key, Date.now() + SESSION_BACKOFF_MS);
        out[key] = { ok: false, label: def.label, error: String(err?.message ?? err) };
      }
    }
    // 顺带带上面板轮询需要的三样，把原来的 3 个轮询（live/confirm/stop）合并成这一次请求
    out.ok = true;
    out.live = LIVE;
    out.stop = { on: STOP.on, reason: STOP.reason };
    out.pending = listPending();
    out.dangerous = [...DANGER_TOOLS];
    out.dangerRules = { tools: [...DANGER.tools], args: DANGER.args };
    // 前台通道健康度：面板据此显示「一键修复」按钮（windows 挂了才有意义）
    out.frontHealth = frontHealth();
    // 后台 CLI 状态（与 out.workbuddy.cli 同源，面板读这一份即可，不必再发一次请求）
    out.cli = cliStatusPayload(cliNow);
    // 本地识别摘要：只做文件系统检查、不探测端口（这个接口 5 秒轮询一次，别添延迟）；
    // 运行中与否 / 生效设备走 /api/asr。
    out.asr = { installed: asrInstalled(), modelDownloaded: asrModelDownloaded(), running: !!asrProc };
    send(res, 200, out);
    return;
  }

  /* ── 后台 CLI（CodeBuddy Code）检测状态 ──
   * GET  /api/wb-cli            —— 读缓存（30s）
   * GET  /api/wb-cli?refresh=1  —— 强制重查
   * POST /api/wb-cli            —— 强制重查（等价于 refresh=1）
   * 用途：用户装完 CLI 后在设置里点「重新检测」，**无需重启 ORB** 就能让后台通道变绿。 */
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/wb-cli") {
    const refresh = req.method === "POST" || url.searchParams.get("refresh") === "1";
    send(res, 200, { ok: true, cli: cliStatusPayload(await resolveWbCli(refresh)) });
    return;
  }

  /* ── 积分/额度：直接读 WorkBuddy 本地库 ~/.workbuddy/workbuddy.db（只读，拿不到就降级）
     数据来源是 WorkBuddy 自己写的 session_usage.credit_json（每条消息的真实积分消耗）。 */
  if (req.method === "GET" && url.pathname === "/api/credits") {
    send(res, 200, await readCredits());
    return;
  }

  /* 后台可选模型清单（面板下拉用）。默认走 CLI --help 实时解析（缓存 5 分钟）；
     ?refresh=1 强制重拉（面板「更新」钮）。CLI 不可用才回落内置静态表。 */
  if (req.method === "GET" && url.pathname === "/api/wb-models") {
    const force = url.searchParams.get("refresh") === "1";
    wbModelsPayload(force)
      .then((p) => send(res, 200, p))
      .catch(() => send(res, 200, { models: WB_MODEL_LIST, source: "static", at: Date.now() }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tools") {
    const key = url.searchParams.get("server");
    // orb 原生轨道不是 MCP session，直接回本地工具表（与 /api/status 保持一致，避免 unknown server: orb）
    if (key === "orb") {
      send(res, 200, { tools: ORB_TOOL_LIST.map((name) => ({ name, description: "" })) });
      return;
    }
    if (SERVERS[key]?.kind === "cli") {
      send(res, 200, { tools: WORKBUDDY_TOOL_LIST.map((name) => ({ name, description: "" })) });
      return;
    }
    const s = await getSession(key);
    send(res, 200, { tools: s.tools });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    const body = await readBody(req);
    const ck = body.server + "|" + body.tool;
    const isRead = READ_ONLY_TOOLS.has(ck);
    try {
      if (isRead) {
        const hit = READ_CACHE.get(ck);
        if (hit && Date.now() - hit.t < READ_CACHE_MS) {
          wfCapture(body.server, body.tool, body.args);   // 录制时缓存命中也要记，保持序列完整
          send(res, 200, { ok: true, result: hit.v, cached: true });
          return;
        }
      }
      const result = await callTool(body.server, body.tool, body.args, body.timeoutMs ?? CALL_TIMEOUT_MS);
      if (isRead) READ_CACHE.set(ck, { t: Date.now(), v: result });
      else READ_CACHE.clear();   // 任何写操作后立刻失效，避免读到过期画面
      wfCapture(body.server, body.tool, body.args);
      send(res, 200, { ok: true, result });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 工作流：录制 / 停止 / 状态 / 列表 / 回放 */
  if (req.method === "POST" && url.pathname === "/api/wf") {
    const body = await readBody(req);
    try {
      switch (body.action) {
        case "rec-start": {
          REC.on = true;
          REC.name = body.name || ("workflow_" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
          REC.steps = [];
          REC.pendingWinCaps = [];       // 抗迁移：清空上一次的窗口抓取队列
          REC.startedAt = Date.now();
          /* 挂上全局鼠标钩子：这样"你手动在别的软件里点的/拖的/滚的"也能录进来。
             挂不上（缺模块 / 权限 / 杀软）就静默降级，面板的 F9 打点仍在。 */
          let hook = false;
          try {
            const m = await getMouseHook();
            if (m) {
              const r = m.startMouseHook({
                exclude: Array.isArray(body.exclude) ? body.exclude : [],
                onStep: (s) => {
                  if (!REC.on) return;
                  /* holdMs 是钩子对「按住维持」的实测时长。
                     不直接用 wait（那是步与步之间的自然间隔），
                     而是单独记下来，面板编辑时能显示「这一按维持了多久」。
                     回放侧不必特殊处理——press/release 本来就是两步。 */
                  const step = {
                    server: s.server, tool: s.tool, args: s.args,
                    wait: s.wait || 0, note: s.note || "", hook: true,
                  };
                  if (s.holdMs) step.holdMs = s.holdMs;
                  REC.steps.push(step);
                  /* 抗迁移：异步抓「点落在哪个窗口」，抓到了就把 step.win 挂上。
                     不影响录制节奏（fire-and-forget），rec-stop 会等它们收尾。 */
                  const pp = primaryPoint(step);
                  if (pp) {
                    const p = captureWinAt(pp[0], pp[1])
                      .then((anchor) => { if (anchor) step.win = anchor; })
                      .catch(() => {});
                    REC.pendingWinCaps.push(p);
                  }
                },
              });
              hook = !!(r && r.ok);
              if (!hook && r) log("[hook] 未挂载：", r.error);
            }
          } catch (e) {
            log("[hook] 挂载异常：", (e && e.message) || e);
          }
          send(res, 200, { ok: true, recording: true, name: REC.name, hook });
          break;
        }

        /* 手动打点：只**记录**、不执行。
           录制时用户按一下打点热键，面板读出当前鼠标坐标发过来。
           注意不能顺手真的点一下 —— 用户自己已经点过了，
           这里再点一次等于把动作做两遍。 */
        case "rec-step": {
          if (!REC.on) { send(res, 200, { ok: false, error: "当前没有在录制" }); break; }
          const tool = String(body.tool || "Click");
          const server = String(body.server || "windows");
          const step = { server, tool, args: body.args ?? {}, wait: 0 };
          REC.steps.push(step);
          const pp = primaryPoint(step);
          if (pp) {
            const p = captureWinAt(pp[0], pp[1])
              .then((anchor) => { if (anchor) step.win = anchor; })
              .catch(() => {});
            REC.pendingWinCaps.push(p);
          }
          console.log(`[rec] 打点 +1（${tool} ${JSON.stringify(body.args ?? {})}），共 ${REC.steps.length} 步`);
          send(res, 200, { ok: true, steps: REC.steps.length });
          break;
        }

        case "rec-stop": {
          REC.on = false;
          // 先卸钩子，再结算步骤 —— 否则卸载瞬间的事件会漏进正在保存的数组
          try { const m = await getMouseHook(); if (m) m.stopMouseHook(); } catch { /* ignore */ }
          // 抗迁移：等窗口锚定抓取收尾，避免保存时 step.win 还没挂上
          try { await Promise.allSettled(REC.pendingWinCaps || []); } catch { /* ignore */ }
          REC.pendingWinCaps = [];
          const name = REC.name;
          const steps = dedupeRecSteps(REC.steps);
          if (!steps.length) {
            send(res, 200, { ok: false, error: "没有录到任何操作" });
            break;
          }
          /* 与 /api/wf 的 save 一致走原子写：录制产物正是最容易被强杀打断的
             那类写入，写坏一半 = 用户录了半天的工作流打不开。 */
          writeJsonAtomic(wfFile(name), { name, savedAt: Date.now(), gap: 700, steps });
          REC.steps = [];
          /* 顺带看一眼录制里有没有「同一段操作重复了 k 次」。
             只提示、不改结构 —— 用户录 3 段不一定是想循环，
             也可能就是三份内容不同的表。检测失败不影响录制结果。 */
          let repeatHint = null;
          try { repeatHint = detectRepeat(steps); } catch { /* 忽略 */ }
          send(res, 200, { ok: true, name, steps: steps.length, repeatHint });
          break;
        }

        case "status":
          send(res, 200, { ok: true, recording: REC.on, name: REC.name, steps: REC.steps.length });
          break;

        case "list":
          send(res, 200, { ok: true, workflows: wfList() });
          break;

        case "get": {
          try {
            const wf = JSON.parse(fsSync.readFileSync(wfFile(body.name), "utf8"));
            send(res, 200, { ok: true, workflow: wf });
          } catch (e) {
            send(res, 200, { ok: false, error: "读不到：" + (e?.message ?? e) });
          }
          break;
        }

        case "save": {
          const wf = Object.assign({}, body.workflow || {});
          wf.name = wf.name || body.name;
          if (!wf.name) { send(res, 200, { ok: false, error: "缺少工作流名称" }); break; }
          try {
            fsSync.mkdirSync(WORKFLOW_DIR, { recursive: true });
            writeJsonAtomic(wfFile(wf.name), wf);
            send(res, 200, { ok: true, name: wf.name, steps: (wf.steps || []).length });
          } catch (e) {
            send(res, 200, { ok: false, error: "保存失败：" + (e?.message ?? e) });
          }
          break;
        }

        case "play":
          send(res, 200, { ok: true, result: await wfPlay(body.name, body) });
          break;

        case "delete":
          try { fsSync.unlinkSync(wfFile(body.name)); send(res, 200, { ok: true }); }
          catch (e) { send(res, 200, { ok: false, error: "删除失败：" + (e?.message ?? e) }); }
          break;

        default:
          send(res, 200, { ok: false, error: "未知 action：" + body.action });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 触发器：定时 / 文件变化（热键由 main.js 注册，不在此列） */
  if (req.method === "POST" && url.pathname === "/api/triggers") {
    const body = await readBody(req);
    try {
      switch (body.action) {
        case "list":
          send(res, 200, { ok: true, triggers });
          break;

        case "add": {
          const t = Object.assign({}, body.trigger || {});
          if (!t.workflow) { send(res, 200, { ok: false, error: "缺少 workflow" }); break; }
          t.id = t.id || ("t" + Date.now().toString(36));
          t.enabled = t.enabled !== false;
          triggers.push(t);
          saveTriggers();
          armTriggers();
          send(res, 200, { ok: true, trigger: t });
          break;
        }

        case "remove":
          triggers = triggers.filter((x) => x.id !== body.id);
          saveTriggers();
          armTriggers();
          send(res, 200, { ok: true });
          break;

        case "toggle": {
          const t = triggers.find((x) => x.id === body.id);
          if (t) { t.enabled = !t.enabled; saveTriggers(); armTriggers(); }
          send(res, 200, { ok: true, trigger: t || null });
          break;
        }

        case "reload":
          loadTriggers();
          armTriggers();
          send(res, 200, { ok: true, armed: triggerHandles.size });
          break;

        default:
          send(res, 200, { ok: false, error: "未知 action：" + body.action });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 急停开关：自动化跑飞时救命用。GET 也支持，方便热键/外部脚本直接打。 */
  if (url.pathname === "/api/stop") {
    try {
      let action = "status", reason = "";
      if (req.method === "POST") {
        const body = await readBody(req);
        action = body.action || "status";
        reason = body.reason || "";
      } else {
        const q = url.searchParams.get("action");
        if (q) action = q;
      }
      if (action === "stop") send(res, 200, { ok: true, stop: doStop(reason) });
      else if (action === "resume") send(res, 200, { ok: true, stop: doResume() });
      else send(res, 200, { ok: true, stop: { on: STOP.on, at: STOP.at, reason: STOP.reason } });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 危险操作确认：面板轮询 pending 列表，用户点允许/拒绝 */
  if (url.pathname === "/api/confirm") {
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        const done = resolveApproval(body.id, !!body.allow, body.reason, body.remember);
        send(res, 200, { ok: done, error: done ? undefined : "确认项不存在或已超时" });
      } else {
        send(res, 200, {
          ok: true, pending: listPending(),
          dangerous: [...DANGER_TOOLS], whitelist: whiteList,
          dangerRules: { tools: [...DANGER.tools], args: DANGER.args },
        });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 全局鼠标钩子状态：面板据此决定"要不要教用户按 F9" */
  if (req.method === "GET" && url.pathname === "/api/hook") {
    try {
      const m = await getMouseHook();
      send(res, 200, Object.assign({ ok: true }, m ? m.hookState() : { available: false, error: "模块未加载" }));
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 前台通道自检 / 一键修复 */
  if (url.pathname === "/api/repair") {
    try {
      if (req.method === "GET") {
        send(res, 200, { ok: true, health: frontHealth() });
        return;
      }
      if (req.method === "POST") {
        log("[repair] 收到前台通道修复请求");
        const r = await repairFront();
        send(res, 200, r);
        return;
      }
      send(res, 405, { ok: false, error: "method not allowed" });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 危险清单管理：读 / 写 danger-tools.json */
  if (url.pathname === "/api/danger") {
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        if (Array.isArray(body.tools)) DANGER.tools = body.tools.map(String).filter(Boolean);
        if (body.args && typeof body.args === "object") DANGER.args = body.args;
        DANGER_TOOLS.clear();
        for (const t of DANGER.tools) DANGER_TOOLS.add(t);
        saveDanger();
        console.log("[danger] 清单更新：tools =", DANGER.tools.join(", ") || "(空)");
      }
      send(res, 200, { ok: true, tools: [...DANGER.tools], args: DANGER.args, defaults: structuredClone(DANGER_DEFAULTS) });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 危险操作白名单管理 */
  if (url.pathname === "/api/whitelist") {
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        if (body.action === "add") {
          const pattern = String(body.pattern || "").trim();
          if (!pattern) { send(res, 200, { ok: false, error: "缺少 pattern" }); return; }
          const mode = body.mode === "prefix" ? "prefix" : "exact";
          const tool = body.tool || "PowerShell";
          if (!whiteList.some((w) => w.tool === tool && w.mode === mode && w.pattern === pattern)) {
            whiteList.push({ tool, mode, pattern, addedAt: Date.now() });
            saveWhiteList();
          }
          send(res, 200, { ok: true, whitelist: whiteList });
        } else if (body.action === "remove") {
          whiteList = whiteList.filter((w) => !(w.pattern === body.pattern && w.mode === body.mode));
          saveWhiteList();
          send(res, 200, { ok: true, whitelist: whiteList });
        } else {
          send(res, 200, { ok: true, whitelist: whiteList });
        }
      } else {
        send(res, 200, { ok: true, whitelist: whiteList });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 智能接管回报：面板跑完一轮视觉会话后回到这里，结算挂起的 promise。
     没人在等（超时已过 / 两轮撞车）就返回 stale，让面板知道这一轮白跑了，
     不必再重试——重试只会把已经走远的流程再拉回来一次。 */
  if (req.method === "POST" && url.pathname === "/api/agent-done") {
    const body = await readBody(req);
    const ok = settleAgent(body);
    if (!ok) log("[agent] 收到迟到的接管回报，已丢弃");
    send(res, 200, { ok: true, stale: !ok });
    return;
  }

  /* 执行状态（AI 步骤可视化）+ 执行审计日志 */
  if (url.pathname === "/api/live" || url.pathname === "/api/audit") {
    try {
      if (url.pathname === "/api/live") {
        send(res, 200, {
          ok: true,
          live: LIVE,
          stop: { on: STOP.on, reason: STOP.reason },
        });
      } else {
        const limit = Math.max(1, Math.min(AUDIT_MEM_MAX, Number(url.searchParams.get("limit") || 100)));
        send(res, 200, { ok: true, entries: AUDIT_MEM.slice(-limit).reverse() });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /*
   * 视觉模型代理。
   *
   * 为什么必须放在这里：面板是 file:// 页面，浏览器会把对
   * https://api.deepseek.com 之类的请求当作跨域，而这些 API 都不发
   * Access-Control-Allow-Origin，渲染进程直接被 CORS 拦死。
   * Node 侧 fetch 没有这个限制，所以由 bridge 代发。
   *
   * 密钥只在本进程内存里过一遍，不落盘、不写日志。
   */
  if (req.method === "POST" && url.pathname === "/api/vlm") {
    const body = await readBody(req);
    const baseUrl = String(body.baseUrl || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    const model = String(body.model || "").trim();
    if (!baseUrl || !model) {
      send(res, 200, { ok: false, error: "缺少 baseUrl 或 model" });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Number(body.timeoutMs) || 180000);
    const started = Date.now();
    try {
      const r = await fetch(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: body.messages ?? [],
          max_tokens: Number(body.maxTokens) || 1024,
          temperature: body.temperature === undefined ? 0 : body.temperature,
          // 厂商私有参数透传。典型用途：Qwen3.5 是 hybrid-thinking 模型，
          // 默认会先吐思考过程，污染 JSON 解析，需要 enable_thinking:false。
          ...(body.extra && typeof body.extra === "object" ? body.extra : {}),
        }),
        signal: ctrl.signal,
      });
      const text = await r.text();
      send(res, 200, {
        ok: r.ok,
        status: r.status,
        ms: Date.now() - started,
        body: text.slice(0, 400000),
      });
    } catch (err) {
      send(res, 200, { ok: false, status: 0, error: String(err?.message ?? err) });
    } finally {
      clearTimeout(t);
    }
    return;
  }

  /* 列出该端点可用模型，方便用户找对视觉模型的名字。
     预置里的模型名可能过时，用它查真实清单最靠谱。 */
  if (req.method === "POST" && url.pathname === "/api/vlm/models") {
    const body = await readBody(req);
    const baseUrl = String(body.baseUrl || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    if (!baseUrl) {
      send(res, 200, { ok: false, error: "缺少 baseUrl" });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: ctrl.signal,
      });
      const text = await r.text();
      let ids = [];
      if (r.ok) {
        try {
          const j = JSON.parse(text);
          ids = (j.data || j.models || [])
            .map((m) => m.id || m.name || m.model)
            .filter(Boolean);
        } catch {}
      }
      send(res, 200, { ok: r.ok, status: r.status, ids, body: r.ok ? "" : text.slice(0, 400) });
    } catch (err) {
      send(res, 200, { ok: false, status: 0, error: String(err?.message ?? err) });
    } finally {
      clearTimeout(t);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dispatch") {    const body = await readBody(req);
    const id = startJob(
      body.server ?? "workbuddy",
      body.tool ?? "workbuddy_execute",
      body.args ?? {},
      body.timeoutMs ?? JOB_TIMEOUT_MS
    );
    send(res, 200, { ok: true, jobId: id });
    return;
  }

  /* 常驻 daemon 的结果回调（免令牌：回调方拿不到 X-Orb-Token）。
     命中已知 runId 才算数，其余忽略；原始报文一律落盘便于确认字段。 */
  if (req.method === "POST" && url.pathname === "/api/wb-callback") {
    const body = await readBody(req);
    try {
      /* ① 落 DATA_DIR（装目录不可写，写那里等于日志永远丢）；
         ② 无上限追加会把磁盘慢慢吃掉（每次后台回调都存一份原始报文），
            超过 1MB 就砍掉前半段，只留最近的。 */
      const f = path.join(DATA_DIR, "wb-callback.log");
      try {
        const st = fsSync.statSync(f);
        if (st.size > 1024 * 1024) {
          const old = fsSync.readFileSync(f, "utf8");
          fsSync.writeFileSync(f, old.slice(Math.floor(old.length / 2)));
        }
      } catch { /* 还没有这个文件，下面 append 会建出来 */ }
      fsSync.appendFileSync(f, JSON.stringify({ at: new Date().toISOString(), body }) + "\n");
    } catch { /* 落盘失败不影响主流程 */ }
    const id = String(body?.runId || body?.id || body?.data?.runId || "");
    const entry = id && pendingRuns.get(id);
    if (entry) {
      pendingRuns.delete(id);
      entry.resolve(extractCallbackText(body) || "(回调里没找到正文，原始报文见 wb-callback.log)");
    } else {
      log("[wb-callback] 收到未匹配的回调 runId =", id || "(缺失)");
    }
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/job/")) {
    const id = url.pathname.split("/").pop();
    const job = jobs.get(id);
    if (!job) {
      /* 淘汰上限生效后（见 startJob），**正在跑的 job 也可能被挤掉**。
         原来只回一句 "job not found"，调用方完全分不清是"id 写错了"
         还是"被挤掉了"，排查时只能干瞪眼。给个能自解释的文案。 */
      send(res, 404, { ok: false, error: `job ${id} 不存在或已被淘汰（最多保留 ${MAX_JOBS} 条）` });
      return;
    }
    send(res, 200, { ok: true, job });
    return;
  }

  /* 热启动（常驻 daemon）开关：读状态 / 运行时切换。改完立即生效，无需重启 ORB。 */
  if (req.method === "GET" && url.pathname === "/api/wb-daemon") {
    send(res, 200, {
      ok: true,
      enabled: WB_DAEMON,
      port: WB_DAEMON_PORT,
      running: !!daemonProc,
      healthy: WB_DAEMON ? await daemonHealth() : false,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wb-daemon") {
    const { enabled } = await readBody(req);
    WB_DAEMON = !!enabled;
    try {
      writeConfFlag("daemon", WB_DAEMON);
    } catch (err) {
      send(res, 200, { ok: false, error: "写入 bridge.conf 失败：" + String(err?.message ?? err) });
      return;
    }
    if (!WB_DAEMON) {
      try { daemonProc && daemonProc.kill(); } catch { /* ignore */ }
      daemonProc = null;
      log("[wb-daemon] 已关闭热启动；后台改用 -p 子进程");
      send(res, 200, { ok: true, enabled: false, running: false });
      return;
    }
    log("[wb-daemon] 已开启热启动；随后台任务按需启动常驻服务");
    // 预热放后台，接口立即返回，避免面板卡住（ensureDaemon 最长等 40s）。
    ensureDaemon().then((ok) => log("[wb-daemon] 预热", ok ? "就绪" : "未成功")).catch(() => {});
    send(res, 200, { ok: true, enabled: true, running: !!daemonProc });
    return;
  }

  /* 截屏取词：截图（或面板传入 dataUrl）→ Windows 自带 OCR → 文字。离线、免安装、不限流。 */
  if (req.method === "POST" && url.pathname === "/api/ocr") {
    const body = await readBody(req);
    try {
      let png;
      if (body.dataUrl) {
        png = Buffer.from(String(body.dataUrl).split(",")[1] || "", "base64");
      } else {
        const r = await callTool("windows", "Screenshot", {}, 60000);
        const img = ((r && r.content) || []).find((c) => c.type === "image");
        png = Buffer.from((img && img.data) || "", "base64");
      }
      if (!png || !png.length) {
        send(res, 200, { ok: false, error: "没有拿到图像（截图失败）" });
        return;
      }
      const text = await ocrPng(png, String(body.lang || "zh-Hans-CN"));
      send(res, 200, { ok: true, text });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 本地语音识别服务：查询状态 / 切换 CPU-GPU（改 asr.conf 并重启服务） */
  if (req.method === "GET" && url.pathname === "/api/asr") {
    const conf = readAsrConf();
    const h = await asrHealth();
    const installed = asrInstalled();
    const modelOk = asrModelDownloaded();
    const eff = (h && h.effective) || null;
    send(res, 200, {
      ok: true,
      // 就绪度三态：装没装（venv）/ 权重下没下 / 服务跑没跑
      installed,
      modelDownloaded: modelOk,
      // 已下载的模型清单：面板显示"已下载：small / medium"（服务在跑用它的 /health，没跑自己扫目录）
      modelsAvailable: (h && h.modelsAvailable) || asrModelsAvailable(),
      needDownload: !installed || !modelOk,
      ready: !!(h && h.ready !== false),
      running: !!h, health: !!h, owned: !!asrProc,
      model: (h && h.model) || String(conf.model || "small"),
      // 实际生效值：/health 的 effective 优先（asr_server 回落 CPU 后写回过 conf，两者一致）
      device: (h && h.device) || String(conf.device || "auto"),
      compute: (h && h.compute) || String(conf.compute || "auto"),
      // 期望值 vs 生效值：面板据此显示"GPU 不可用，已回落 CPU/int8"
      requested: { device: String(conf.device || "auto"), compute: String(conf.compute || "auto") },
      effective: eff,
      fellBack: !!(eff && eff.fellBack),
      note: eff && eff.reason ? String(eff.reason) : "",
      dir: ASR_DIR,
      autostart: conf.autostart !== false,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/asr") {
    const body = await readBody(req);
    // 没装本地识别就别折腾：写 conf / 重启都无从谈起，直接引导一键安装
    if (!asrInstalled() || !asrModelDownloaded()) {
      send(res, 200, {
        ok: false, needDownload: true,
        error: "还没安装本地识别。请先点「安装本地离线识别」（约 700 MB），装完即可离线转写；不装也能用浏览器引擎语音。",
      });
      return;
    }
    const prev = readAsrConf();
    const patch = {};
    if (body.device) patch.device = String(body.device);
    if (body.compute) patch.compute = String(body.compute);
    if (body.model) patch.model = String(body.model);
    writeAsrConf(patch);
    log("[asr] 切换:", JSON.stringify(patch));
    await asrStop();
    let ok = await asrEnsure(90000);
    let note = "";
    if (!ok) {
      // 失败自动回滚：别让语音服务卡在「起不来」的配置上
      writeAsrConf(prev);
      await asrStop();
      ok = await asrEnsure(90000);
      note = "新配置启动失败，已回滚到 " + (prev.device || "auto") + "/" + (prev.compute || "auto");
      log("[asr] 回滚:", note);
    }
    const h = await asrHealth();
    const eff = (h && h.effective) || null;
    send(res, 200, {
      ok, reverted: !!note, error: ok ? undefined : (note || "服务未就绪（见 bridge 日志）"),
      // running 必须给：面板靠它决定按钮显示"启动"还是"重启"。
      // 原来只给 health，面板读 running 永远是 undefined → 按钮文案永远停在"启动"。
      running: !!h, health: !!h,
      modelsAvailable: (h && h.modelsAvailable) || asrModelsAvailable(),
      model: (h && h.model) || readAsrConf().model || "small",
      device: (h && h.device) || readAsrConf().device || "auto",
      compute: (h && h.compute) || readAsrConf().compute || "auto",
      requested: { device: String(prev.device || "auto"), compute: String(prev.compute || "auto") },
      effective: eff,
      fellBack: !!(eff && eff.fellBack),
      note: eff && eff.reason ? String(eff.reason) : "",
    });
    return;
  }

  /* ── 本地识别一键安装（DESIGN §5.2 / §14.3）──
   * POST /api/asr/prepare           拉起 asr/prepare.ps1（幂等，重跑会接着装）
   * GET  /api/asr/prepare-progress  轮询进度：bridge 缓冲脚本输出的 [orb-asr] 行
   * 安装是**显式按钮触发**，不在启动路径上阻塞 UI（§15.6）；失败也不影响浏览器引擎语音。
   * 脚本输出行格式：[orb-asr] <step> <percent> <message> */
  if (req.method === "POST" && url.pathname === "/api/asr/prepare") {
    if (asrPrepare && asrPrepare.running) {
      send(res, 200, { ok: false, running: true, error: "正在安装中，请稍候（进度可轮询 /api/asr/prepare-progress）" });
      return;
    }
    const script = path.join(ASR_DIR, "prepare.ps1");
    if (!fsSync.existsSync(script)) {
      send(res, 200, { ok: false, error: "找不到安装脚本：" + script + "（发布版应随包附带 resources/asr/prepare.ps1）" });
      return;
    }
    const proc = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-AsrDir", ASR_DIR,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: ASR_DIR });
    asrPrepare = {
      running: true, proc, lines: [], step: "pick", percent: 0,
      ok: false, error: "", startedAt: Date.now(), code: null,
    };
    const onOut = (d) => {
      for (const raw of String(d).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        asrPrepare.lines.push(line);
        if (asrPrepare.lines.length > 200) asrPrepare.lines.shift();
        const m = line.match(/^\[orb-asr\]\s+(\w+)\s+(\d+)(?:\s+(.*))?$/);
        if (m) { asrPrepare.step = m[1]; asrPrepare.percent = Number(m[2]) || 0; }
        log("[asr-prep]", line);
      }
    };
    proc.stdout.on("data", onOut);
    proc.stderr.on("data", onOut);
    proc.on("error", (e) => {
      asrPrepare.running = false;
      asrPrepare.ok = false;
      asrPrepare.error = String(e?.message ?? e);
      log("[asr-prep] 启动异常:", asrPrepare.error);
    });
    proc.on("exit", (code) => {
      asrPrepare.running = false;
      asrPrepare.code = code;
      asrPrepare.ok = code === 0;
      if (code !== 0 && !asrPrepare.error) {
        asrPrepare.error = "安装脚本退出码 " + code + "（详见上方日志；下载支持断点续传，可直接重试）";
      }
      log("[asr-prep] 结束，退出码", code);
    });
    if (proc) registerChild(proc.pid, "asr-prep");
    send(res, 200, { ok: true, started: true, running: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/asr/prepare-progress") {
    const p = asrPrepare;
    send(res, 200, {
      ok: true,
      running: !!(p && p.running),
      started: !!p,
      step: p ? p.step : "",
      percent: p ? p.percent : 0,
      success: p ? !!p.ok : false,
      error: p ? p.error : "",
      lines: p ? p.lines.slice(-40) : [],
      elapsedMs: p ? Date.now() - p.startedAt : 0,
    });
    return;
  }

  /* 追加下载某个模型权重（首跑「可选组件」用，例如 medium ≈1.5GB）：
     直接用 asr/venv 里的 python 跑 download_model.py <repo> models/<name>。
     进度并入 asrPrepare 单槽 —— 与一键安装互斥（同一时刻只跑一个），
     面板轮询 /api/asr/prepare-progress 即可看到（download_model.py 的输出行
     本身就是 [orb-asr] model <pct> …，解析规则现成）。
     ⚠️ medium 依赖 venv + 依赖：没装过先走 /api/asr/prepare，这里只做「追加」。 */
  if (req.method === "POST" && url.pathname === "/api/asr/model") {
    const body = await readBody(req);
    const name = String((body && body.name) || "").trim();
    const repo = ASR_MODEL_REPOS[name];
    if (!repo) {
      send(res, 200, { ok: false, error: "不支持的模型名：" + (name || "(空)") + "（可用：" + Object.keys(ASR_MODEL_REPOS).join(" / ") + "）" });
      return;
    }
    if (asrPrepare && asrPrepare.running) {
      send(res, 200, { ok: false, running: true, error: "正在安装中，请稍候（进度可轮询 /api/asr/prepare-progress）" });
      return;
    }
    if (!asrInstalled()) {
      send(res, 200, {
        ok: false, needInstall: true,
        error: "还没安装本地识别（venv / 依赖未就绪）：请先完成「安装本地离线识别」，再来下 " + name + " 权重。",
      });
      return;
    }
    const dest = path.join(ASR_DIR, "models", name);
    const proc = spawn(asrVenvPy(), [path.join(ASR_DIR, "download_model.py"), repo, dest],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: ASR_DIR });
    asrPrepare = {
      running: true, proc, lines: [], step: "model", percent: 0,
      ok: false, error: "", startedAt: Date.now(), code: null, model: name,
    };
    const onOut = (d) => {
      for (const raw of String(d).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        asrPrepare.lines.push(line);
        if (asrPrepare.lines.length > 200) asrPrepare.lines.shift();
        const m = line.match(/^\[orb-asr\]\s+(\w+)\s+(\d+)(?:\s+(.*))?$/);
        if (m) { asrPrepare.step = m[1]; asrPrepare.percent = Number(m[2]) || 0; }
        log("[asr-model]", line);
      }
    };
    proc.stdout.on("data", onOut);
    proc.stderr.on("data", onOut);
    proc.on("error", (e) => {
      asrPrepare.running = false;
      asrPrepare.ok = false;
      asrPrepare.error = String(e?.message ?? e);
      log("[asr-model] 启动异常:", asrPrepare.error);
    });
    proc.on("exit", (code) => {
      asrPrepare.running = false;
      asrPrepare.code = code;
      asrPrepare.ok = code === 0;
      if (code !== 0 && !asrPrepare.error) {
        asrPrepare.error = "下载脚本退出码 " + code + "（支持断点续传，可直接重试）";
      }
      log("[asr-model] 结束，退出码", code);
    });
    if (proc) registerChild(proc.pid, "asr-model");
    send(res, 200, { ok: true, started: true, running: true, model: name, dest });
    return;
  }

  /* 实时字幕：查状态 / 一键启动（自动打开字幕页面）/ 停止 */
  if (req.method === "GET" && url.pathname === "/api/rt") {
    const h = await rtHealth();
    send(res, 200, { ok: true, running: !!h, port: RT_PORT, owned: !!rtProc });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/rt") {
    const body = await readBody(req);
    if (body.stop) {
      await rtStop();
      send(res, 200, { ok: true, running: false });
      return;
    }
    let h = await rtHealth();
    if (!h) {
      rtStart();
      let up = false;
      let err = "";
      for (let i = 0; i < 20; i++) {
        await sleep(400);
        if (rtSpawnErr) { err = rtSpawnErr; rtSpawnErr = ""; break; }   // 起不来就别空转 8 秒
        if ((h = await rtHealth(600))) { up = true; break; }
      }
      if (!up) {
        send(res, 200, { ok: false, error: "实时字幕服务启动失败（见 bridge 日志）" + (err ? "：" + err : "") });
        return;
      }
    }
    if (body.open !== false) rtOpenBrowser();
    send(res, 200, { ok: true, running: true, url: `http://127.0.0.1:${RT_PORT}` });
    return;
  }

  /* 优雅停机（给 Electron 主进程退出前调用）。
     Windows 上父进程对我们的 kill() 是 TerminateProcess —— 本进程被瞬间抹掉，
     shutdown() 根本来不及跑，MCP / CLI / ASR / 字幕进程就全成了孤儿。
     主进程退出前先打这个接口，子进程树才能收干净。带令牌，外部网页调不动。 */
  if (req.method === "POST" && url.pathname === "/api/shutdown") {
    send(res, 200, { ok: true });
    setTimeout(() => { shutdown(); }, 60);
    return;
  }

  send(res, 404, { ok: false, error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    send(res, 500, { ok: false, error: String(err?.message ?? err) });
  });
});

server.on("error", (err) => {
  console.error("server error:", err.message);
  /* 端口被占 = 已经有一个实例在服务。留在本进程只会拼出"端口通 + 令牌被我们
     改过"这个最糟的组合（主进程全线 401），不如干脆退出让旧实例继续干。 */
  if (err && err.code === "EADDRINUSE") {
    console.error("端口", PORT, "已被占用：已有 bridge 实例在跑，本进程退出");
    process.exit(1);
  }
});

async function shutdown() {
  /* 收尾必须覆盖**所有**被我们拉起来的东西。
     原来只管 daemon / asr / rt：正在跑的 CodeBuddy CLI（activeProcs 里记着）
     和各 MCP server 子进程（sessions）全留给了系统 —— 那正是孤儿进程的主要来源，
     用户说的"电脑负担"很大一块就来自这里。 */
  try { disarmTriggers(); } catch {}
  try { clearInterval(asrReaper); asrReaper = null; } catch {}
  killActiveProcs();
  try { daemonProc && daemonProc.kill(); } catch {}
  try { asrProc && asrProc.kill(); } catch {}
  try { rtProc && rtProc.kill(); } catch {}
  disposeAllSessions();
  // 干净退出后不该再留台账：下次启动会拿这批已不存在的 PID 去做回收核对
  try { writeChildReg([]); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 令牌文件必须在 listen **之前**写好：主进程的策略是「等端口通 -> 读文件」，
// 若端口先通而文件还是上一个实例的旧令牌，鉴权就会全线 401。
//
// 但这条规则有个副作用：第二个实例启动时会先把**新**令牌写进文件，然后才发现
// 端口被旧实例占着 —— 主进程于是拿着新令牌去问旧实例，全线 401，而旧实例的
// 令牌从此没人知道。所以写之前先探测：上一个实例还活着就什么都不写、直接退出。
function existingBridgeAlive() {
  try {
    const j = JSON.parse(fsSync.readFileSync(TOKEN_FILE, "utf8"));
    const pid = Number(j && j.pid);
    if (!pid || pid === process.pid) return false;
    try { process.kill(pid, 0); } catch { return false; }   // 信号 0：只探测存在性，不发信号
    /* pid 存在还不够：pid 会被系统复用，一个"恰好拿到旧 pid"的无关进程会让我
       们误判桥还活着而退出 —— 那结果是整个控制台无桥可用。所以再比对端口：
       记录的端口不是当前这个，就说明那份令牌不是同一套配置留下的。 */
    return Number(j.port) === PORT;
  } catch { return false; }
}
if (existingBridgeAlive()) {
  console.error(`已有 bridge 实例在跑（见 ${TOKEN_FILE}）：本进程退出，避免覆盖它的令牌`);
  process.exit(0);
}
try {
  writeJsonAtomic(TOKEN_FILE, { port: PORT, token: TOKEN, pid: process.pid });
} catch (e) {
  console.error("写入令牌文件失败:", e.message);
}

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`orb console ready: http://127.0.0.1:${PORT}`);
  /* 先把上一次强杀留下的子进程清掉，避免孤儿越堆越多（见 reapStaleChildren）。
     必须 **await**：ASR 的启动决策要基于"回收之后"的真实状态，
     否则旧 ASR 还半死不活地占着端口，asrEnsure 会误判"已经在跑"而不拉新的。 */
  try { await reapStaleChildren(); } catch (e) { log("[gc] 清理失败:", e?.message ?? e); }

  /* ── ASR 启动策略（单一归属，只由 bridge 管）──
   * 曾经的三个机制互相打架，导致面板**永远**显示"服务未运行"：
   *   ① .cmd 启动器也会起一份 ASR，且先 `netstat` 查 19876 再决定起不起；
   *   ② 旧 ASR 还活着 → .cmd 判定"已在运行" → 跳过启动；
   *   ③ 紧接着 reapStaleChildren 把旧 ASR 当孤儿杀掉；
   *   ④ 而 bridge 是懒加载的，不会主动拉 → 最后没人起 ASR。
   * 现在 .cmd 不再管 ASR，规则收敛成一条（DESIGN §5.2）：
   *   一键安装就绪（asr/venv 存在）才自启；没装 → 保持懒加载，
   *   不白占 238MB 内存 + 2.1GB 显存。没装时语音走浏览器引擎，功能不残。
   *   asr.conf 的 autostart:false 可单独关自动启动（只保留手动/按需拉起）。
   * 拉起来后会由空闲回收器在 5 分钟无人用时停掉，所以不会一直占着。
   * （ORB_ASR_AUTOSTART=0 可整个关掉，供单测 / 手动排查用。） */
  const asrAutoOn = ASR_AUTOSTART && readAsrConf().autostart !== false;
  if (asrAutoOn && asrInstalled()) {
    log("[asr] 检测到本地识别环境（venv 就绪），启动识别服务…");
    asrEnsure(120000)
      .then((ok) => log("[asr] 启动", ok ? "就绪" : "失败（详见上方日志）"))
      .catch((e) => log("[asr] 启动异常:", e?.message ?? e));
  } else if (asrAutoOn) {
    log("[asr] 未安装本地识别（asr/venv 不存在），保持懒加载；需要离线识别可在面板一键安装");
  }
  startAsrIdleReaper();
});
