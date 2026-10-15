/*
 * 前台通道运行时（windows-mcp 的宿主）——**单一真相源**。
 *
 * 为什么要有它：原来前台通道依赖 WorkBuddy 的 venv（~/.workbuddy/binaries/python/envs/default），
 * 干净机上没有 WorkBuddy 就完全起不来。现在改为**随包自带**一个 embeddable CPython +
 * 精简 site-packages（构建脚本见 orb/native/build-runtime.ps1，产物在 orb/runtime/python）。
 *
 * 解析顺序（与后台 CLI 的 local.conf 机制同一套思路：环境变量 → 随包 → 用户指定 → PATH）：
 *   ① ORB_PY_EXE       —— 手动指向某个 python.exe
 *   ② 随包运行时        —— <HERE>/runtime/python/python.exe（开发态是 orb/runtime/python）
 *   ③ ORB_BASE_PY      —— 手动指向的备用解释器（沿用旧变量名，老用户不用改）
 *   ④ 系统 PATH        —— where python / which python3
 *   ⑤ 都没有 → { ok:false }
 *
 * 契约：**绝不抛异常、绝不写死本机路径**。解析失败只影响前台通道，
 * 原生输入 / 视觉 / 后台 / 语音全部照常。
 */
import fsSync from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 随包运行时目录（构建产物，.gitignore 排除；由 pack.cjs 打进 resources/runtime/python） */
export const RUNTIME_DIR = path.join(HERE, "runtime", "python");
/** 随包解释器（Windows 下是 python.exe） */
export const RUNTIME_PY = path.join(RUNTIME_DIR, "python.exe");

const PY_NAME = process.platform === "win32" ? "python.exe" : "python3";

/** 结果缓存 30s：面板 5 秒轮询一次 /api/status，不能每次都去 spawn 一个 where */
const CACHE_MS = 30_000;
/** @type {{at:number, value:{ok:boolean, source:string, exe:string, dir:string, fileName:string, hint:string}|null}} */
let cache = { at: 0, value: null };

const HINT_MISSING = "未找到可用的 Python 解释器，前台通道（截图 / 点击 / 键盘）不可用。"
  + "发布版自带运行时，若仍报这个错说明包不完整，请重新下载完整安装包；"
  + "开发态请先运行 orb\\native\\build-runtime.ps1 构建运行时，或用 ORB_PY_EXE 指向一个 python.exe。";

/** 在系统 PATH 里找 python。找不到返回空串（不抛异常）。 */
function whichPython() {
  for (const name of (process.platform === "win32" ? ["python", "python3"] : ["python3", "python"])) {
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const out = execFileSync(cmd, [name], {
        timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024,
        encoding: "utf8",
      });
      const lines = String(out || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length) return lines.find((l) => /python/i.test(l)) || lines[0];
    } catch { /* 这个命令/这个名字找不到，试下一个 */ }
  }
  return "";
}

function exists(p) {
  try { return !!p && fsSync.existsSync(p); } catch { return false; }
}

/**
 * 解析前台通道要用的 Python 解释器。
 * @param {boolean} refresh 为 true 时强制重查。
 * @returns {{ok:boolean, source:string, exe:string, dir:string, fileName:string, hint:string}}
 */
export function resolvePython(refresh = false) {
  const now = Date.now();
  if (!refresh && cache.value && now - cache.at < CACHE_MS) return cache.value;

  const miss = { ok: false, source: "none", exe: "", dir: "", fileName: "", hint: HINT_MISSING };
  const steps = [
    ["env", (process.env.ORB_PY_EXE || "").trim()],
    ["bundled", RUNTIME_PY],
    ["base-py", (process.env.ORB_BASE_PY || "").trim()],
  ];
  for (const [source, p] of steps) {
    if (!p) continue;
    if (!exists(p)) continue;
    const value = {
      ok: true, source, exe: p, dir: path.dirname(p), fileName: path.basename(p), hint: "",
    };
    cache = { at: now, value };
    return value;
  }
  const onPath = whichPython();
  const value = onPath
    ? { ok: true, source: "path", exe: onPath, dir: path.dirname(onPath), fileName: path.basename(onPath), hint: "" }
    : miss;
  cache = { at: now, value };
  return value;
}

/**
 * 启动 windows-mcp 的参数。
 *
 * 为什么从 `windows-mcp.exe` 改成 `python -m windows_mcp`：
 *   随包的是 embeddable Python，里面没有 pip、没有 venv，也不该在用户机器上跑 pip。
 *   `-m` 直接加载已随包装好的包，零安装、零网络。
 */
export function windowsMcpArgs() {
  return ["-m", "windows_mcp", "serve", "--transport", "stdio", "--exclude-tools", "Registry"];
}

/**
 * 传给 windows-mcp 子进程的环境变量 —— **遥测三道闸，主次不能颠倒**。
 *
 *   ① ANONYMIZED_TELEMETRY=false —— windows_mcp/__main__.py 的 lifespan 读到 false
 *      就**根本不构造** PostHogAnalytics（最彻底）。
 *   ② POSTHOG_API_KEY="" —— 即使 ① 失效，analytics.py 的 `if not self.API_KEY`
 *      成立时 client 保持 None，所有 capture 被跳过。
 *
 *      ⚠️ 必须显式给**空串**：Windows 上 `set VAR=` 是删除变量而不是置空，
 *      变量一旦不存在，`os.environ.get(key, "phc_...")` 就会**回落硬编码的 key**，
 *      遥测反而被打开。Node 的 spawn env 传空串是有效的（已实测 repr 为 ''）。
 *   ③ posthog 是 no-op stub —— 前两道都漏了也不可能发出站流量。
 *
 * 另外强制 pillow 截图后端：dxcam 会拖进 numpy（约 55MB）且我们没装它。
 *
 * @param {Record<string,string>} extra 需要额外覆盖的变量（放在最后，优先级最高）
 */
export function windowsMcpEnv(extra = {}) {
  return {
    ...process.env,
    ANONYMIZED_TELEMETRY: "false",
    POSTHOG_API_KEY: "",
    WINDOWS_MCP_SCREENSHOT_BACKEND: "pillow",
    ...extra,
  };
}

/**
 * 进程识别表：按**命令行子串**判断某个 PID 是不是我们拉起的那一类子进程。
 *
 * 为什么不能再看映像名：改成 `python -m windows_mcp` 之后，前台通道的映像名变成
 * python.exe，**和 ASR / 实时字幕一模一样**。原来的 KIND_IMAGES 按名字核对，
 * 会把上一个实例的 ASR 误判成前台孤儿杀掉（这正是本项目以前踩过的坑）。
 *
 * 匹配优先级按列表顺序；命中即认定。
 */
export const PROC_KIND_MATCHERS = {
  windows: ["windows_mcp"],
  dsh: ["dsh-mcp", "dsh_mcp"],
  cli: ["codebuddy"],
  asr: ["asr_server.py"],
  rt: ["subtitle_rt.py", "subtitle-rt"],
};

/**
 * 按命令行判断某个 PID 的类别。
 * @param {string} cmdLine 进程完整命令行（拿不到时传空串，返回 null 表示"认不出"）
 * @param {string} kind    台账里记的 kind
 * @returns {boolean|null} true=对得上，false=对不上，null=认不出（调用方应放过）
 */
export function matchProcKind(cmdLine, kind) {
  const pats = PROC_KIND_MATCHERS[kind];
  if (!pats || !pats.length) return null;      // 没登记过匹配规则的 kind，不妄下判断
  if (!cmdLine) return null;                   // 拿不到命令行，宁可放过
  const lower = String(cmdLine).toLowerCase();
  return pats.some((p) => lower.includes(String(p).toLowerCase()));
}

/** 给定解释器，其 site-packages 里有没有 windows_mcp 包（判断"装了没"） */
export function hasWindowsMcp(py) {
  const p = py || resolvePython();
  if (!p || !p.ok || !p.dir) return false;
  for (const rel of [
    path.join("Lib", "site-packages", "windows_mcp"),
    path.join("lib", `python3.13`, "site-packages", "windows_mcp"),
  ]) {
    if (exists(path.join(p.dir, rel))) return true;
  }
  return false;
}
