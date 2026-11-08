/* ---------------- 工单轨迹（trajectory） ----------------
 *
 * 解决的问题不是"记日志"，而是**恢复**。
 * 现在的控制台只有"任务在跑/跑完了"，没有"跑到第几步、做过哪些不可逆的事"。
 * 于是任何一次中断，用户只能重跑整件事 —— 重跑又会把已经点过的按钮再点一遍。
 *
 * 这里落的是**可恢复检查点**要的三样东西：
 *   ① steps：做过哪些步骤（有序，带时间）；
 *   ② sideEffects：哪些动作**已经产生外部后果**（发过消息、改过文件、点过提交）。
 *      恢复时先读它，才知道哪些绝对不能重放；
 *   ③ artifacts：产出了什么（路径/URL），恢复时先看东西还在不在。
 *
 * 为什么用 JSONL 而不是写进 tickets.json：
 *   · 轨迹是**追加**的，工单是**覆盖**的，混在一起会让 tickets.json 每次变更都变大；
 *   · 一行坏了只坏一行，不会让整张工单读不出来（JSON 数组坏一个字符就全废）。
 *
 * 为什么必须带轮转：
 *   SuperAgent 原型被自己列为缺陷的正是"没有删除机制，表无界增长"。
 *   一个跑视觉循环的任务十几分钟就能写几百行，不封顶的话几天就是几十 MB。
 *   这里按"单文件行数上限 + 目录总 TTL"两道闸，超了就砍最老的。
 */

import fs from "node:fs";
import path from "node:path";

const MAX_LINES = 2000;        // 单工单轨迹上限，超出后保留最近一半
const KEEP_MS = 7 * 24 * 3600 * 1000;

const safeName = (id) => String(id || "unknown").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);

/** 只有这些类型的动作会产生"外部后果"，恢复时必须先查。 */
const SIDE_EFFECT_TYPES = new Set([
  "file.write", "file.delete", "shell.run", "gui.click", "gui.type",
  "message.send", "pr.submit", "clipboard.set", "record.save",
]);

export function createTrajectory(opts = {}) {
  const dir = opts.dir || path.join(process.cwd(), "trail");
  const now = opts.now || Date.now;
  const maxLines = opts.maxLines ?? MAX_LINES;
  const keepMs = opts.keepMs ?? KEEP_MS;
  const log = opts.log || (() => {});

  function fileOf(ticketId) {
    return path.join(dir, `${safeName(ticketId)}.jsonl`);
  }

  function ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  }

  /**
   * 追加一条。永不抛异常 —— 轨迹写失败不能让任务本身失败。
   * 返回 true/false 只为可测性。
   */
  function append(ticketId, event = {}) {
    if (!ticketId) return false;
    try {
      ensureDir();
      const row = { at: now(), ...event, type: String(event.type || "event") };
      if (SIDE_EFFECT_TYPES.has(row.type)) row.sideEffect = true;
      const line = JSON.stringify(row);
      const f = fileOf(ticketId);
      fs.appendFileSync(f, `${line}\n`);

      // 行数封顶：只在明显超限时整文件重写（每行都 stat 一次太贵）。
      const st = fs.statSync(f);
      if (st.size > 512 * 1024) rotate(f);
      return true;
    } catch (err) {
      log(`[trail] 写入失败 ${ticketId}: ${err.message}`);
      return false;
    }
  }

  function rotate(f) {
    try {
      const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
      if (lines.length <= maxLines) return;
      const kept = lines.slice(-Math.floor(maxLines / 2));
      const tmp = `${f}.part`;
      fs.writeFileSync(tmp, `${kept.join("\n")}\n`);
      fs.renameSync(tmp, f);
    } catch (err) {
      log(`[trail] 轮转失败：${err.message}`);
    }
  }

  /** 读最近 limit 条（按时间正序返回，便于面板从头渲染）。 */
  function read(ticketId, limit = 200) {
    try {
      const f = fileOf(ticketId);
      const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
      const n = Math.max(1, Math.min(Number(limit) || 200, maxLines));
      return lines.slice(-n).map((l) => {
        try { return JSON.parse(l); } catch { return { type: "corrupt", raw: l.slice(0, 200) }; }
      });
    } catch (err) {
      if (err.code !== "ENOENT") log(`[trail] 读取失败 ${ticketId}: ${err.message}`);
      return [];
    }
  }

  /**
   * 从轨迹推导检查点。**不做额外存储** —— 轨迹是真相，检查点是它的投影。
   * 两份存储一定会漂移，这种漂移在"恢复"这种场景下代价最高。
   */
  function checkpoint(ticketId) {
    const rows = read(ticketId, maxLines);
    if (!rows.length) return null;
    const steps = [];
    const sideEffects = [];
    const artifacts = [];
    let last = null;
    let firstAt = 0;
    for (const r of rows) {
      if (!firstAt) firstAt = r.at || 0;
      last = r;
      if (r.type === "step" || r.type === "phase") steps.push({ at: r.at, name: r.name || r.phase || "", ok: r.ok !== false });
      if (r.sideEffect) sideEffects.push({ at: r.at, type: r.type, target: r.target || r.path || "", undoable: r.undoable === true });
      if (r.type === "artifact" && (r.path || r.url)) artifacts.push({ at: r.at, path: r.path || "", url: r.url || "" });
    }
    const failed = rows.filter((r) => r.ok === false || r.type === "error");
    return {
      ticketId: String(ticketId),
      firstAt,
      lastAt: last?.at || 0,
      events: rows.length,
      steps: steps.length,
      lastStep: steps.length ? steps[steps.length - 1] : null,
      // 恢复时最该看的一条：有没有"已经做出去了"的动作。
      sideEffects,
      artifacts,
      errors: failed.slice(-5).map((r) => ({ at: r.at, message: String(r.message || r.error || "").slice(0, 200) })),
      resumable: true,
      note: sideEffects.length
        ? `有 ${sideEffects.length} 个已产生外部后果的动作，恢复前必须逐条确认，不能整体重放`
        : "没有记录到外部副作用，恢复可整体重放",
    };
  }

  /** 目录级保留期：按 mtime 删过期的轨迹文件。由 watchdog 定时调用。 */
  function sweep() {
    let removed = 0;
    try {
      const t = now();
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const f = path.join(dir, name);
        try {
          const st = fs.statSync(f);
          if (t - st.mtimeMs > keepMs) { fs.unlinkSync(f); removed++; }
        } catch {}
      }
    } catch (err) {
      if (err.code !== "ENOENT") log(`[trail] 清扫失败：${err.message}`);
    }
    return removed;
  }

  function stats() {
    let files = 0;
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        files++;
        try { bytes += fs.statSync(path.join(dir, name)).size; } catch {}
      }
    } catch {}
    return { dir, files, bytes };
  }

  return { dir, append, read, checkpoint, sweep, stats, fileOf };
}
