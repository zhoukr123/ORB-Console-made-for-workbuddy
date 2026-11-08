/* ---------------- 环境探测器（probe） ----------------
 *
 * 给「命令化判定」用的只读探针：任务到底能不能用命令通道做，先看环境再说，
 * 而不是靠正则猜。三件事：
 *   · which(name)  —— 可执行文件解析（绝对路径直接看；否则走 where/which）
 *   · exists(p)    —— 文件/目录在不在
 *   · isDir(p)     —— 是不是目录
 *
 * 三条硬约束（桌面 Agent 的探针不能反过来拖垮体验）：
 *   ① **只读**：绝不启动目标程序、绝不写盘。只查"在不在"，不"试试看"。
 *   ② **有超时**：where/which 走子进程，必须带 timeout（默认 800ms），
 *      卡住就返回查找失败，绝不无限等。
 *   ③ **有缓存**：同一个命令名在 TTL（默认 60s）内只查一次 —— 面板可能反复
 *      问 /api/plan，不能每次都 spawn 一个 where。
 *
 * 依赖注入（execFile/fs/now 可替换），所以单测不需要真机环境。
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT = Number(process.env.ORB_PROBE_TIMEOUT || 800);
const DEFAULT_TTL = Number(process.env.ORB_PROBE_CACHE_MS || 60000);

export function createProber(opts = {}) {
  const exec = typeof opts.execFile === "function" ? opts.execFile : execFile;
  const fsx = opts.fs || fs;
  const now = opts.now || Date.now;
  const log = opts.log || (() => {});
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const cacheTtlMs = opts.cacheTtlMs ?? DEFAULT_TTL;
  const cache = new Map();          // key -> { at, value }

  function existsSync(p) {
    try { return !!p && fsx.existsSync(p); } catch { return false; }
  }

  function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheTtlMs) return Promise.resolve(hit.value);
    return Promise.resolve()
      .then(fn)
      .then((v) => { cache.set(key, { at: now(), value: v }); return v; })
      .catch((e) => { log("[probe] 查询失败:", e?.message ?? e); return ""; });
  }

  /** 解析可执行文件位置。绝对/带分隔符的路径直接判存在；否则 where/which。 */
  function which(name) {
    const n = String(name || "").trim();
    if (!n) return Promise.resolve("");
    if (path.isAbsolute(n) || /[\\/]/.test(n)) return Promise.resolve(existsSync(n) ? n : "");
    return cached("which:" + n.toLowerCase(), () => new Promise((resolve) => {
      const cmd = process.platform === "win32" ? "where" : "which";
      try {
        exec(cmd, [n], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
          if (err || !stdout) return resolve("");
          const lines = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          // Windows 的 where 会按 PATHEXT 返回多行；优先原生 .exe
          resolve(lines.find((l) => /\.exe$/i.test(l)) || lines[0] || "");
        });
      } catch { resolve(""); }
    }));
  }

  function exists(p) {
    const s = String(p || "");
    if (!s) return Promise.resolve(false);
    return cached("exists:" + (process.platform === "win32" ? s.toLowerCase() : s), () => existsSync(s));
  }

  function isDir(p) {
    try { return !!p && fsx.statSync(p).isDirectory(); } catch { return false; }
  }

  return {
    which, exists, isDir, existsSync,
    stats: () => ({ size: cache.size }),
    clearCache: () => cache.clear(),
  };
}
