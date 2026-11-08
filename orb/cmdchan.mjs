// 命令通道（Command Channel）
// ───────────────────────────────────────────────────────────────────────────
// 设计目标：把「写文件 + 启动进程 + 用指定程序打开」这一套不依赖 GUI 的逻辑，
// 做成 ORB 控制台里与「前台 GUI 通道（windows-mcp）」并列的执行通道。
//
// 关键性质：本通道**不碰鼠标/键盘/剪贴板/窗口焦点**这些全局单例，
// 因此不需要 GUI 令牌，可以和前台 GUI 任务并行，也不会互相抢焦点。
// 这正是它相比「逐键敲进记事本」的 GUI 模拟最划算的地方。
//
// 安全边界（硬，不可绕过）：
//   1. 启动一律用 spawn 的「数组参数」形式——**绝不经过 shell**——杜绝命令注入。
//   2. 拒绝一切 shell / 脚本宿主（cmd/powershell/bash/node/python…），
//      它们必须走既有 PowerShell / CLI 通道，那里有完整的危险确认。
//   3. 文件写入强制 UTF-8（Windows 默认写中文会乱码）。
//   4. 是否「启动前需确认」由上层（bridge /api/cmd）按现有 DANGER 规则决定；
//      本模块只负责安全执行，不自己拍板。

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

// shell / 脚本宿主：命令通道一律拒绝，逼回既有通道（那里有完整危险确认）。
const SHELL_LIKE = new Set([
  "cmd.exe", "cmd", "powershell.exe", "powershell", "pwsh.exe", "pwsh",
  "bash", "sh", "zsh", "wscript.exe", "wscript", "cscript.exe", "cscript",
  "node.exe", "node", "python.exe", "python", "python3", "perl.exe", "perl",
  "ruby.exe", "ruby", "java.exe", "java",
]);

// 已知「打开即用」的安全程序（默认无需确认）。其余显式程序仍允许，但上层可配置为需确认。
const SAFE_VIEWERS = new Set([
  "notepad.exe", "notepad", "write.exe",
  "mspaint.exe", "mspaint",
  "explorer.exe", "explorer",
]);

/** 程序分类：shell=应拒绝；viewer=安全；app=显式程序（允许，可被 DANGER 配置为需确认）；empty=空。 */
export function classifyApp(app) {
  const base = path.basename(String(app || "")).toLowerCase();
  if (!base) return "empty";
  if (SHELL_LIKE.has(base)) return "shell";
  if (SAFE_VIEWERS.has(base)) return "viewer";
  return "app";
}

/** 把「用某程序打开某文件」归一化成 spawn 规格。
 *  不指定程序 → 用系统默认关联打开（explorer 等效双击，不经 shell）。 */
export function buildOpenWith(app, filePath) {
  if (app && String(app).trim()) {
    return { command: String(app).trim(), args: filePath ? [filePath] : [] };
  }
  return { command: "explorer.exe", args: filePath ? [filePath] : [] };
}

/** 把上层传入的 /api/cmd body 归一化成 { write?, spec? }。 */
export function normalizeCmdOp(body = {}) {
  let write = null;
  if (body.write && body.write.filePath) {
    write = {
      filePath: body.write.filePath,
      content: body.write.content ?? "",
      encoding: body.write.encoding || "utf8",
    };
  }
  let spec = null;
  if (body.launch && body.launch.command) {
    spec = {
      command: body.launch.command,
      args: Array.isArray(body.launch.args) ? body.launch.args : [],
    };
  } else if (body.openWith) {
    spec = buildOpenWith(body.openWith.app, body.openWith.filePath);
  }
  return { write, spec };
}

/** 写文本文件：强制 UTF-8 防中文乱码；父目录缺失自动创建。 */
export async function writeTextFile({ filePath, content, encoding = "utf8" }) {
  if (!filePath) throw new Error("writeTextFile: filePath 必填");
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const enc = encoding === "utf8" ? "utf8" : encoding;
  await fs.writeFile(filePath, content ?? "", enc);
  return { path: filePath, bytes: Buffer.byteLength(content ?? "", enc) };
}

/** stat 的安全版：不存在/无权限一律返回 null，不抛。 */
async function statSafe(p) {
  try { return await fs.stat(p); } catch { return null; }
}

/** 复制文件/目录。**默认拒绝覆盖**；要覆盖必须显式 overwrite:true（会被硬闸拦截确认）。 */
export async function copyEntry({ from, to, overwrite = false }) {
  const f = String(from || "").trim();
  const t = String(to || "").trim();
  if (!f || !t) throw new Error("copy: from / to 必填");
  if (path.resolve(f) === path.resolve(t)) throw new Error("copy: from 与 to 指向同一路径");
  if (!(await statSafe(f))) throw new Error(`copy: 源不存在：${f}`);
  if (!overwrite && (await statSafe(t))) throw new Error(`copy: 目标已存在，拒绝覆盖（需覆盖请显式 overwrite:true）：${t}`);
  await fs.mkdir(path.dirname(t), { recursive: true });
  // fs.cp 支持目录递归；force/errorOnExist 与 overwrite 对齐
  await fs.cp(f, t, { recursive: true, force: !!overwrite, errorOnExist: !overwrite });
  return { from: f, to: t, overwrite: !!overwrite };
}

/** 移动/重命名。同卷走 rename（原子），跨卷 EXDEV 回落到"复制后删源"。 */
export async function moveEntry({ from, to, overwrite = false }) {
  const f = String(from || "").trim();
  const t = String(to || "").trim();
  if (!f || !t) throw new Error("move: from / to 必填");
  if (path.resolve(f) === path.resolve(t)) throw new Error("move: from 与 to 指向同一路径");
  if (!(await statSafe(f))) throw new Error(`move: 源不存在：${f}`);
  const dst = await statSafe(t);
  if (dst && !overwrite) throw new Error(`move: 目标已存在，拒绝覆盖（需覆盖请显式 overwrite:true）：${t}`);
  await fs.mkdir(path.dirname(t), { recursive: true });
  if (dst && overwrite) await fs.rm(t, { recursive: true, force: true });
  try {
    await fs.rename(f, t);
  } catch (e) {
    if (e && e.code === "EXDEV") {
      await fs.cp(f, t, { recursive: true, force: !!overwrite });
      await fs.rm(f, { recursive: true, force: true });
    } else {
      throw e;
    }
  }
  return { from: f, to: t, overwrite: !!overwrite };
}

/** 重命名 = 同一实现（同目录改名的特例），语义上源会消失，仍由上层硬闸确认。 */
export async function renameEntry({ from, to, overwrite = false }) {
  return moveEntry({ from, to, overwrite });
}

/** 启动程序：数组形式 spawn（不经 shell）；拒绝 shell/脚本宿主。 */
export async function launchApp(spec) {
  if (!spec || !spec.command) throw new Error("launchApp: command 必填");
  const cls = classifyApp(spec.command);
  if (cls === "shell") {
    throw new Error(
      "命令通道拒绝启动 shell/脚本宿主（" + path.basename(spec.command) +
      "），请改走 PowerShell/CLI 通道");
  }
  const args = Array.isArray(spec.args) ? spec.args : [];
  // detached:true + stdio:"ignore" + unref → 启动的程序独立于 bridge 存活，不被桥重启连累。
  const child = spawn(spec.command, args, {
    stdio: "ignore",
    windowsHide: true,
    detached: true,
  });
  const pid = child.pid;
  child.on("error", () => { /* ENOENT 等：调用方以 pid 为空判断 */ });
  if (typeof child.unref === "function") child.unref();
  return { pid: pid ?? null, command: spec.command, args };
}

/** 编排：写文件 → 文件操作（复制/移动/重命名）→ 启动程序。各项可选，至少一项。 */
export async function runCommandOp(body = {}) {
  const hasFileOp = !!(body.copy || body.move || body.rename);
  if (!body.write && !body.launch && !body.openWith && !hasFileOp) {
    throw new Error("命令通道需要 write / openWith / launch / copy / move / rename 至少一项");
  }
  const { write, spec } = normalizeCmdOp(body);
  const out = { written: null, copied: null, moved: null, renamed: null, launched: null };
  if (write) out.written = await writeTextFile(write);
  if (body.copy) out.copied = await copyEntry(body.copy);
  if (body.move) out.moved = await moveEntry(body.move);
  if (body.rename) out.renamed = await renameEntry(body.rename);
  if (spec) out.launched = await launchApp(spec);
  return out;
}
