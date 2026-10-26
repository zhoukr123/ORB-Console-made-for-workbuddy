/* ---------------- 原生录屏 helper 的唯一入口（Stage 2） ----------------
 * 把 orb/native/dist/orb-cap.exe 包成一个 Promise 化的模块，主进程只跟它打交道。
 * 为什么单独一个文件而不是塞进 main.js：helper 有进程生命周期（启动/回执/收尾/
 * 意外退出）和自己的行协议，混进 main.js 会让那 3000 行更难读，也没法被自检脚本
 * 直接 require 做单元测试（docs/_cap_native_unit.js 就是这么测的）。
 *
 * 协议（与 orb-cap.c 一一对应，改一边必须改另一边）：
 *   启动 → "ready <w> <h> <fps>"        ← 在这之后主进程才开始计时
 *   每秒 → "frame <n>"                   ← 不是每帧，最多一行/秒
 *   回执 → "ok" / "paused" / "resumed"   ← 每条命令必回一条
 *   收尾 → "done <bytes> <elapsedMs>"    正常收尾；尺寸变化时再多 "<w> <h>" 两个字段
 *   取消 → "aborted"                     半成品已删
 *   致命 → "err <hrHex> <说明>"          随后进程以非 0 退出
 *
 * 设计约定（踩过的坑写在这儿，别改回去）：
 *   ① **err 是致命的**：它代表"这段录制完了"，主进程据此回退 VP9；
 *      未知输出行只记日志，绝不影响调用方 —— 否则一个多余的空行就能把录制判死。
 *   ② 所有在途 Promise 都必须被结算：进程退出/报错时立刻 reject，
 *      绝不能让调用方挂到超时（面板会卡在"准备中"）。
 *   ③ 进程退出分两种：`state.done`（正常收尾）与意外退出（触发 'exit' 事件，
 *      由主进程转成用户可见的提示）。abort 也不算意外。
 *   ④ 退出应用时先 `stdin.end()` 让 helper 走 EOF→stop 优雅收尾，
 *      3 秒后才硬杀 —— 直接 kill 会留下没有 moov 的坏文件。
 * --------------------------------------------------------------- */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/* exe 定位沿用 main.js 找 orb-foreground.exe 的写法：开发态是
   orb/native/dist/，打包态 resources/native/dist/（pack.cjs 拷过去），
   两种情况下 __dirname/../native/dist 都成立。ORB_CAP_EXE 只用于排查。 */
const EXE = process.env.ORB_CAP_EXE
  || path.join(__dirname, "..", "native", "dist", "orb-cap.exe");

const READY_MS = 10000;   // 等 ready 的上限（桌面复制初始化实测 <300ms，10s 是兜底）
const CMD_MS = 5000;      // 单条命令等回执
const STOP_MS = 30000;    // Finalize 要写 moov；27MB / 60s 实测 <300ms，30s 兜底
const ABORT_MS = 10000;
const KILL_GRACE_MS = 3000;   // 退出应用：先 EOF 让它自己收尾，这么久还没走才硬杀

/* 宿主日志（由 main.js 注入，避免 require 环，理由同 glassbg.js / storage.js） */
let ctx = { log: () => {} };
function init(next) {
  if (next && typeof next === "object" && typeof next.log === "function") ctx.log = next.log;
}
function note(...args) {
  try { ctx.log("[cap-native]", ...args); } catch { /* 日志绝不能反咬调用方 */ }
}
function errText(e) {
  return (e && e.message) ? e.message : String(e);
}

/* 单飞：同一时刻只允许一个 helper（多录制并发在 v1 不支持，也不该被静默允许多开） */
let child = null;
let state = null;          // 当前会话的累积状态（路径、尺寸、字节、是否正常收尾…）
let pending = null;        // 在途请求 { kind, resolve, reject, timer }
const listeners = { frame: [], done: [], err: [], exit: [] };

function on(event, cb) {
  const box = listeners[event];
  if (!box || typeof cb !== "function") return () => {};
  box.push(cb);
  return () => {
    const i = box.indexOf(cb);
    if (i >= 0) box.splice(i, 1);
  };
}
function fire(event, payload) {
  const box = listeners[event];
  if (!box) return;
  for (const cb of box.slice()) {
    try { cb(payload); } catch (e) { note("监听器异常:", event, errText(e)); }
  }
}

function available() {
  try { return fs.existsSync(EXE); } catch { return false; }
}
function exePath() { return EXE; }
function currentPath() { return state ? state.path : ""; }
function isRunning() { return !!child; }
/** 最近一次会话的退出情况（自检/排障用：正常收尾时不会触发 'exit' 事件，
    但测试要断言"进程退出码 0"，所以单独给一个只读快照）。 */
function lastExit() {
  if (!state) return null;
  return { code: state.code, exited: !!state.exited, done: !!state.done,
           aborted: !!state.aborted, errCode: state.errCode || "", errMsg: state.errMsg || "",
           path: state.path, bytes: state.bytes, ms: state.ms };
}

/* ---------------- 在途请求结算 ---------------- */
/** 结算指定类型的在途请求。类型不匹配就什么都不做（并发保护）。 */
function settle(kind, ok, payload) {
  if (!pending || pending.kind !== kind) return false;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  if (ok) p.resolve(payload);
  else p.reject(payload);
  return true;
}
/** 把**任何**在途请求判失败（进程没了/报错了，绝不能让调用方挂着）。 */
function settleAny(error) {
  if (!pending) return;
  const p = pending;
  pending = null;
  clearTimeout(p.timer);
  p.reject(error);
}
/** 收掉 helper 进程、断开在途状态。why 只用于日志。 */
function killChild(why) {
  const c = child;
  if (!c) return;
  try { if (why) note("清理编码器进程：", why); } catch { /* 记不了就算了 */ }
  try { c.kill(); } catch { /* 已经退了 */ }
  if (child === c) child = null;
}
function waitFor(kind, ms, label) {
  if (pending) {
    return Promise.reject(new Error("上一条命令还没结束：" + pending.kind));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending && pending.kind === kind) pending = null;
      /* 超时不能只清 pending：helper 还在跑就会继续写文件、抱着输出句柄不放，
         之后回来的 "done" 也没人接收，下一次 start 还会误报"已有一段录制在跑"。
         所以超时一律顺手把进程收掉。 */
      killChild("等待 " + (label || kind) + " 超时");
      reject(new Error("等待 " + (label || kind) + " 超时（" + ms + "ms）"));
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
    pending = { kind, resolve, reject, timer };
  });
}

/* ---------------- 输出行解析 ---------------- */
function onLine(raw) {
  const line = String(raw || "").replace(/\r$/, "");
  if (!line) return;
  const parts = line.split(/\s+/);
  const head = parts[0];

  if (head === "ready") {
    const w = Number(parts[1]) || 0;
    const h = Number(parts[2]) || 0;
    const fps = Number(parts[3]) || 0;
    if (state) { state.w = w; state.h = h; state.fps = fps; }
    note("就绪：", w + "x" + h + "@" + fps);
    settle("ready", true, { w, h, fps });
    return;
  }
  if (head === "frame") {
    const n = Number(parts[1]) || 0;
    if (state) state.frames = n;
    fire("frame", { n });
    return;
  }
  if (head === "ok" || head === "paused" || head === "resumed") {
    settle("cmd", true, { ok: true, line });
    return;
  }
  if (head === "done") {
    const bytes = Number(parts[1]) || 0;
    const ms = Number(parts[2]) || 0;
    /* 尺寸变化时多两个字段：那是**下一段该用的新尺寸**（当前文件仍是旧尺寸） */
    const w = parts.length >= 5 ? (Number(parts[3]) || 0) : 0;
    const h = parts.length >= 5 ? (Number(parts[4]) || 0) : 0;
    if (state) {
      state.done = true;
      state.bytes = bytes;
      state.ms = ms;
      state.outW = w;
      state.outH = h;
    }
    const payload = {
      ok: true,
      path: state ? state.path : "",
      bytes,
      ms,
      w: w || (state ? state.w : 0),
      h: h || (state ? state.h : 0),
    };
    note("收尾：", bytes, "bytes /", ms, "ms", w && h ? "（换尺寸 → " + w + "x" + h + "）" : "");
    fire("done", payload);
    settle("stop", true, payload);
    return;
  }
  if (head === "aborted") {
    if (state) state.aborted = true;
    note("已取消并删除半成品");
    fire("done", { ok: true, aborted: true });
    settle("abort", true, { ok: true });
    return;
  }
  if (head === "err") {
    const code = parts[1] || "0";
    const msg = parts.slice(2).join(" ") || "未知错误";
    if (state) { state.errCode = code; state.errMsg = msg; }
    note("致命错误：", code, msg);
    fire("err", { code, msg });
    settleAny(new Error("原生编码器报错（" + code + "）：" + msg));
    return;
  }
  /* 不认识的行：只记日志。协议外的噪音不能影响调用方状态机。 */
  note("未知输出行（忽略）：", line);
}

/* ---------------- 子进程挂载 ---------------- */
function attach(c) {
  let buf = "";
  c.stdout.setEncoding("utf8");
  c.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { onLine(line); } catch (e) { note("行解析异常:", errText(e)); }
    }
    /* 防御性：极端情况下（协议被改坏）别让缓冲无限长 */
    if (buf.length > 8192) buf = buf.slice(-1024);
  });
  c.stderr.setEncoding("utf8");
  c.stderr.on("data", (chunk) => {
    const s = String(chunk || "").trim();
    if (s) note("stderr:", s);
  });
  c.on("error", (e) => {
    note("spawn 失败:", errText(e));
    settleAny(new Error("无法启动原生编码器：" + errText(e)));
    child = null;
  });
  c.on("exit", (code, signal) => {
    const ok = !!(state && (state.done || state.aborted));
    if (state) { state.exited = true; state.code = code; }
    note("进程退出 code=" + code + (signal ? " signal=" + signal : "") + (ok ? "（正常）" : "（未收尾）"));
    /* 在途请求一律结算：调用方不能挂在超时上 */
    if (pending) {
      settleAny(new Error(
        "编码器进程已退出（code=" + code + "）" +
        (state && state.errMsg ? "：" + state.errMsg : "")
      ));
    }
    child = null;
    if (!ok) fire("exit", { code, signal, path: state ? state.path : "" });
  });
}

/* ---------------- 对外 API ---------------- */
const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  const i = Math.round(n);
  return Math.min(hi, Math.max(lo, i));
};

/**
 * 启动一段原生录制。
 * @param {{outPath:string, fps?:number, bitrate?:number, display?:number}} opts
 * @returns {Promise<{w:number,h:number,fps:number}>} ready 行的尺寸与帧率
 */
async function start(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  if (!available()) throw new Error("原生录屏组件不存在：" + EXE);
  if (child) throw new Error("已经有一段原生录制在运行");

  const outPath = String(o.outPath || "");
  if (!outPath) throw new Error("缺少输出路径（outPath）");
  const fps = clampInt(o.fps, 1, 120, 30);
  const bitrate = clampInt(o.bitrate, 100000, 200000000, 6000000);
  const display = clampInt(o.display, 0, 15, 0);   // v1 只支持 0，helper 会拒

  const args = [
    "--out", outPath,
    "--fps", String(fps),
    "--bitrate", String(bitrate),
    "--display", String(display),
  ];

  /* 每次开录重置会话状态与监听残留（监听不重置：主进程是常驻绑定的） */
  state = {
    path: outPath, fps, w: 0, h: 0, outW: 0, outH: 0,
    bytes: 0, ms: 0, frames: 0,
    done: false, aborted: false, exited: false, code: null, errCode: "", errMsg: "",
  };

  let c;
  try {
    c = spawn(EXE, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    state = null;
    throw new Error("无法启动原生编码器：" + errText(e));
  }
  child = c;
  /* stdin 的 'error' 必须有监听：helper 意外先退出时，往已断的管道写会触发
     EPIPE —— 没有监听者就升级成未捕获异常，而调用方那边只是"一直等着"。
     这里把它当成一次失败，让在途请求立刻 settle。 */
  try {
    c.stdin.on("error", (e) => settleAny(new Error("与编码器的管道断开：" + errText(e))));
  } catch { /* 极端情况下 stdin 已不可用，忽略 */ }
  note("启动：", EXE, "→", outPath, "(" + fps + "fps / " + bitrate + ")");

  const ready = waitFor("ready", READY_MS, "ready");
  attach(c);

  try {
    return await ready;
  } catch (e) {
    /* 起不来（组件坏 / 屏幕被独占 / 超时）：杀干净，别留一个占着输出文件的僵尸进程 */
    note("启动失败，清理进程：", errText(e));
    try { c.kill(); } catch { /* 已经退了 */ }
    if (child === c) child = null;
    throw e;
  }
}

/** pause / resume：等对应回执。 */
async function cmd(name) {
  const c0 = String(name || "");
  if (c0 !== "pause" && c0 !== "resume") throw new Error("不支持的原生命令：" + c0);
  if (!child) throw new Error("没有正在运行的原生录制");
  const wait = waitFor("cmd", CMD_MS, c0 === "pause" ? "paused" : "resumed");
  try {
    child.stdin.write(c0 + "\n");
  } catch (e) {
    settleAny(new Error("发送 " + c0 + " 失败：" + errText(e)));
  }
  return wait;
}

/** 收尾并落盘：等 done。带新尺寸时 w/h 是新尺寸（下一段该用）。 */
async function stop() {
  if (!child) throw new Error("没有正在运行的原生录制");
  const wait = waitFor("stop", STOP_MS, "done");
  try {
    child.stdin.write("stop\n");
  } catch (e) {
    settleAny(new Error("发送 stop 失败：" + errText(e)));
  }
  return wait;
}

/** 取消：等 aborted（helper 会自己删半成品）。没在跑就幂等返回。 */
async function abort() {
  if (!child) return { ok: true };
  const wait = waitFor("abort", ABORT_MS, "aborted");
  if (state) state.aborted = true;
  try {
    child.stdin.write("abort\n");
  } catch (e) {
    settleAny(new Error("发送 abort 失败：" + errText(e)));
  }
  return wait;
}

/**
 * 退出应用时调用：先关 stdin，让 helper 走 EOF→stop 优雅收尾（写完整 moov），
 * KILL_GRACE_MS 后还没走才硬杀。直接 kill 会留下打不开的 mp4。
 */
function shutdown() {
  const c = child;
  if (!c) return;
  child = null;
  note("应用退出：通知编码器收尾");
  try { c.stdin.end(); } catch { /* 管道已断 */ }
  const t = setTimeout(() => {
    try { c.kill(); } catch { /* 已经退了 */ }
  }, KILL_GRACE_MS);
  if (typeof t.unref === "function") t.unref();
}

module.exports = {
  init,
  available,
  exePath,
  currentPath,
  isRunning,
  lastExit,
  start,
  cmd,
  stop,
  abort,
  shutdown,
  on,
};
