/**
 * #197 旧 artifacts 退役器。
 *
 * 纪律（与个人文件安全规范一致）：
 *  1. 默认 dry-run，绝不删除；只有显式 --confirm 才进入执行分支。
 *  2. 执行前先把整棵旧目录完整备份到 archive/，并确认备份成功。
 *  3. 删除走 Windows 回收站，不使用系统级强制删除命令。
 *  4. 每批最多 10 个文件，逐批校验，任一批失败立即停。
 *  5. 只有「新根下存在同名且 SHA256 一致」的文件才进入可删集合。
 *
 * 纯逻辑函数全部导出，可注入 fs / remover 供单测使用；CLI 只在 IS_MAIN 时运行。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const MAX_BATCH = 10;
export const LEGACY_DIRNAME = "artifacts";
export const RETIRE_ERRORS = Object.freeze({
  NO_CONFIRM: "no-confirm",
  UNSAFE_FILES: "unsafe-files",
  BACKUP_FAILED: "backup-failed",
  BATCH_FAILED: "batch-failed",
});

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function walk(dir, fsImpl, pathImpl, out = []) {
  let names;
  try { names = fsImpl.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const full = pathImpl.join(dir, name);
    let st;
    try { st = fsImpl.statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, fsImpl, pathImpl, out);
    else if (st.isFile()) out.push(full);
  }
  return out;
}

/** 只读扫描旧目录，返回逐文件的绝对路径 / 相对路径 / 大小 / 哈希。 */
export function scanLegacy(root, { fsImpl = fs, pathImpl = path } = {}) {
  const legacyRoot = pathImpl.join(root, LEGACY_DIRNAME);
  const files = walk(legacyRoot, fsImpl, pathImpl).map((full) => {
    const buf = fsImpl.readFileSync(full);
    return {
      full,
      rel: pathImpl.relative(root, full).split(pathImpl.sep).join("/"),
      size: buf.length,
      sha256: sha256(buf),
    };
  });
  return { root, legacyRoot, exists: fsImpl.existsSync(legacyRoot), files };
}

/**
 * 在新根下找同名且哈希一致的副本。
 * 只在 6 个 kind 目录内递归收集（产物形状是 <kind>/<day>/<product>，帧图会再深一层
 * 落进 <product>_frames/ 或 vidx/<day>/<job>/frames/），不递归 legacy root 本身。
 * 同名不同哈希一律判为不安全。
 */
export function matchCopies(scan, { fsImpl = fs, pathImpl = path, kinds = [] } = {}) {
  const byName = new Map();
  for (const kind of kinds) {
    const kindDir = pathImpl.join(scan.root, kind);
    for (const full of walk(kindDir, fsImpl, pathImpl)) {
      const name = pathImpl.basename(full);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(full);
    }
  }
  const safe = [];
  const unsafe = [];
  for (const f of scan.files) {
    const name = pathImpl.basename(f.full);
    const candidates = byName.get(name) || [];
    let hit = null;
    for (const c of candidates) {
      try {
        if (sha256(fsImpl.readFileSync(c)) === f.sha256) { hit = c; break; }
      } catch { /* 读不到就当没命中 */ }
    }
    const row = { ...f, copy: hit };
    (hit ? safe : unsafe).push(row);
  }
  return { safe, unsafe, totalBytes: scan.files.reduce((n, f) => n + f.size, 0) };
}

/** Windows 回收站删除；路径经 UTF-16LE EncodedCommand 传入，避免中文路径编码损坏。 */
export function recycleBinRemover(file) {
  const ps = [
    "Add-Type -AssemblyName Microsoft.VisualBasic;",
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(",
    `'${String(file).replace(/'/g, "''")}',`,
    "'OnlyErrorDialogs', 'SendToRecycleBin')",
  ].join(" ");
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    stdio: "pipe", windowsHide: true,
  });
}

/**
 * 生成退役计划 / 执行退役。confirm 为 false 时任何写操作都不会发生。
 * remover 可注入，便于单测断言「零调用」。
 */
export function planRetirement(root, opts = {}) {
  const { fsImpl = fs, pathImpl = path, kinds = [], confirm = false,
    remover = recycleBinRemover, backupDir = null, now = Date.now() } = opts;
  const scan = scanLegacy(root, { fsImpl, pathImpl });
  const matched = matchCopies(scan, { fsImpl, pathImpl, kinds });
  const plan = {
    ok: true,
    dryRun: !confirm,
    root,
    legacyRoot: scan.legacyRoot,
    exists: scan.exists,
    files: scan.files.length,
    totalBytes: matched.totalBytes,
    safe: matched.safe,
    unsafe: matched.unsafe,
    backupDir: backupDir || pathImpl.join(root, "archive", `legacy-artifacts-${now}`),
    batches: 0,
    removed: 0,
    code: "ok",
    note: "",
  };
  if (!confirm) {
    plan.note = "dry-run：未做任何写操作。确认后加 --confirm 才执行备份与回收站删除。";
    return plan;
  }
  if (matched.unsafe.length) {
    plan.ok = false;
    plan.code = RETIRE_ERRORS.UNSAFE_FILES;
    plan.note = "存在同名不一致或缺副本的文件，一律不删，先人工核对。";
    return plan;
  }
  // 先完整备份，再逐批改回收站。
  try {
    fsImpl.mkdirSync(plan.backupDir, { recursive: true });
    for (const f of matched.safe) {
      const dest = pathImpl.join(plan.backupDir, f.rel);
      fsImpl.mkdirSync(pathImpl.dirname(dest), { recursive: true });
      fsImpl.writeFileSync(dest, fsImpl.readFileSync(f.full));
      if (sha256(fsImpl.readFileSync(dest)) !== f.sha256) throw new Error("backup hash mismatch: " + f.rel);
    }
  } catch (e) {
    plan.ok = false;
    plan.code = RETIRE_ERRORS.BACKUP_FAILED;
    plan.note = String(e?.message ?? e);
    return plan;
  }
  for (let i = 0; i < matched.safe.length; i += MAX_BATCH) {
    const batch = matched.safe.slice(i, i + MAX_BATCH);
    try {
      for (const f of batch) remover(f.full);
      for (const f of batch) {
        if (fsImpl.existsSync(f.full)) throw new Error("still exists: " + f.rel);
      }
      plan.batches += 1;
      plan.removed += batch.length;
    } catch (e) {
      plan.ok = false;
      plan.code = RETIRE_ERRORS.BATCH_FAILED;
      plan.note = `第 ${plan.batches + 1} 批失败，已停止：${String(e?.message ?? e)}`;
      return plan;
    }
  }
  plan.note = "已备份并通过回收站删除；可从备份目录或回收站恢复。";
  return plan;
}

export function toMarkdown(plan) {
  const L = ["# 旧 artifacts 退役报告", "", `- 存储根：\`${plan.root}\``,
    `- 旧目录：\`${plan.legacyRoot}\`（${plan.exists ? "存在" : "不存在"}）`,
    `- 文件数：${plan.files}，合计 ${plan.totalBytes} bytes`,
    `- 可删（同名 SHA256 一致）：**${plan.safe.length}**；拒删：**${plan.unsafe.length}**`,
    `- 模式：**${plan.dryRun ? "dry-run（未做任何写操作）" : "已执行"}**`,
    `- 备份目录：\`${plan.backupDir}\``, "", "## 结论", "",
    `- 状态：\`${plan.code}\` — ${plan.note}`];
  if (plan.unsafe.length) {
    L.push("", "## 拒删清单（必须先人工核对）", "");
    for (const f of plan.unsafe) L.push(`- \`${f.rel}\` — ${f.size} bytes，${f.copy ? "同名但哈希不一致" : "新根下无同名副本"}`);
  }
  if (plan.safe.length) {
    L.push("", "## 可删清单（前 20 条）", "");
    for (const f of plan.safe.slice(0, 20)) L.push(`- \`${f.rel}\` → \`${f.copy}\``);
    if (plan.safe.length > 20) L.push(`- …另有 ${plan.safe.length - 20} 条`);
  }
  return L.join("\n") + "\n";
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith("--")) || "D:/workbuddy_ORB控制台/ORB存储";
  const confirm = args.includes("--confirm");
  const kinds = ["recordings", "screenshots", "vidx", "exports", "archive", "misc"];
  const plan = planRetirement(root, { confirm, kinds });
  process.stdout.write(toMarkdown(plan) + "\n");
  if (confirm && !plan.ok) process.exitCode = 1;
}
