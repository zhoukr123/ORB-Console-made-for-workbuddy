/* P1 文件化机间信道：派工包 / 当前状态 / 修复台 三件套。
 *
 * 对应《综合性方案》§4.4(2) 与 §6 P1。
 * 目标：共享文件是唯一真相源，替代 broadcast 刷屏（每 broadcast = N 条消息）。
 *
 * 与 ORB 既有约定对齐：
 *   - 单一写者：所有状态变更只走 commit 一个入口（stateWriters.mjs 的纪律）。
 *   - CAS / rev：拒绝后写覆盖（旧 rev 的迟到写入一律拒收，呼应 epoch/CAS 语义）。
 *   - 原子写：tmp → rename，不留下半截文件。
 *   - 唯一真相源：readAll 每次从磁盘读，不做内存缓存（缓存就是第二份真相）。
 */
import fsDefault from "node:fs";
import path from "node:path";

export const CHANNEL_FILES = Object.freeze({
  dispatch: "dispatch.json",
  status: "status.json",
  repair: "repair.jsonl",
});

const str = (v, cap = 4000) => String(v ?? "").trim().slice(0, cap);

export function createFileChannel({ dir, fs = fsDefault, now = Date.now } = {}) {
  if (!dir || typeof dir !== "string") throw new Error("dir-required");
  const p = (name) => path.join(dir, name);

  function atomicWrite(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, file);
  }

  function readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  }

  function readAll() {
    const status = readJson(p(CHANNEL_FILES.status), { rev: 0, phase: "init" });
    const dispatch = readJson(p(CHANNEL_FILES.dispatch), null);
    let repairs = [];
    try {
      repairs = fs.readFileSync(p(CHANNEL_FILES.repair), "utf8")
        .split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { /* 修复台还不存在 = 空，不是错误 */ }
    return { rev: status.rev ?? 0, status, dispatch, repairs };
  }

  /** 单一写者 + CAS。expectedRev 传入时，与磁盘 rev 不等即拒（后写覆盖防护）。 */
  function commit(patch = {}, expectedRev) {
    const cur = readJson(p(CHANNEL_FILES.status), { rev: 0, phase: "init" });
    const curRev = cur.rev ?? 0;
    if (typeof expectedRev === "number" && expectedRev !== curRev) {
      return { ok: false, error: "rev-conflict", currentRev: curRev, expectedRev };
    }
    const next = { ...cur, ...patch, rev: curRev + 1, updatedAt: now() };
    atomicWrite(p(CHANNEL_FILES.status), JSON.stringify(next, null, 2) + "\n");
    return { ok: true, rev: next.rev };
  }

  /** 派工包：只在 CAS 通过后才落盘，避免两个 lead 各写一份真相。 */
  function writeDispatch(packet, expectedRev) {
    if (!packet || typeof packet !== "object") return { ok: false, error: "bad-packet" };
    const r = commit({ phase: "dispatched", dispatchAt: now() }, expectedRev);
    if (!r.ok) return r;
    const body = { rev: r.rev, subject: str(packet.subject, 500), packets: Array.isArray(packet.packets) ? packet.packets : [] };
    atomicWrite(p(CHANNEL_FILES.dispatch), JSON.stringify(body, null, 2) + "\n");
    return { ok: true, rev: r.rev, file: CHANNEL_FILES.dispatch };
  }

  function writeStatus(patch, expectedRev) {
    return commit(patch, expectedRev);
  }

  /** 修复台 append-only：一条一行，失败/返工记录不许被覆盖。 */
  function appendRepair(entry, expectedRev) {
    const r = commit({ lastRepairAt: now() }, expectedRev);
    if (!r.ok) return r;
    const line = JSON.stringify({ rev: r.rev, at: now(), ...entry }) + "\n";
    fs.appendFileSync(p(CHANNEL_FILES.repair), line, "utf8");
    return { ok: true, rev: r.rev, file: CHANNEL_FILES.repair };
  }

  /** 为什么不用 broadcast：N 个队友 = N 条消息，文件信道 = 1 次写 + 各自读。 */
  function broadcastCost(messages, members) {
    const m = Math.max(1, Number(members) || 1);
    const n = Math.max(0, Number(messages) || 0);
    return { broadcastMessages: n * m, fileWrites: n, saved: n * m - n };
  }

  return { readAll, commit, writeDispatch, writeStatus, appendRepair, broadcastCost };
}

export const INJECTABLE_CHANNEL_RULE = Object.freeze([
  "共享文件（派工包/当前状态/修复台）是唯一真相源，别在聊天里各存一份。",
  "状态变更只走单一写入口，带 rev 版本号；旧 rev 的迟到写入一律拒收。",
  "broadcast 很贵：N 个队友 = N 条消息；改用文件写入 + 各自读取。",
  "修复台 append-only，失败与返工记录不许被覆盖或删除。",
]);

export default { CHANNEL_FILES, createFileChannel, INJECTABLE_CHANNEL_RULE };
