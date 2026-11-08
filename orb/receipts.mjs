/* 效果收据：幂等键绝不重复发、settle 落结果、内存归属带 interruption。
 * 严禁合并连续 click/wait/type：本模块不提供任何批量 GUI 动作合并能力
 * （会吃掉危险确认中断点 / 破坏急停响应粒度 / 模糊回滚边界）。
 * 写盘失败收敛、不抛不崩。
 *
 * 2026-11-05 补的两件事（原来只有内存态，等于幂等只在"这一次进程"里有效）：
 *   ① **落盘**：收据是"这件事已经做过"的证据，进程一重启就丢，幂等就名存实亡。
 *      所以 settle 之后写快照，启动时读回；恢复时只信 settled 的，
 *      未 settle 的丢掉（那些是"发出去了但没有结果"，当没做才不会吞掉真实重试）。
 *   ② **按 key 复算**：byKey 返回已结算的结果，让调用方在重复提交时能
 *      直接把上次的产物还回去，而不是再执行一遍。
 *
 * generation 的语义没变：每次**成功发出**一张收据就 +1，重复提交不涨。
 * 它同时是"这件事第几次真的做了"的序号 —— 排查时靠它对上日志。
 */
import * as fsDefault from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function createReceipts(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const fs = o.fs || fsDefault;
  const now = typeof o.now === "function" ? o.now : Date.now;
  const fileOf = typeof o.file === "function" ? o.file : () => (o.file || null);
  /* 快照文件单独一个：审计流是 append-only 的流水，快照是"当前有效索引"。
     混在一起会让恢复逻辑必须重放全部历史 —— 那个成本随运行时长线性增长。 */
  const snapOf = typeof o.snapshot === "function" ? o.snapshot : () => (o.snapshot || null);
  const MAX_RECEIPTS = Number.isFinite(o.max) && o.max > 0 ? Math.trunc(o.max) : 2000;
  /* 审计队列上限。落盘成功后在 flush 里裁剪到 MAX_AUDIT；这里再兜一层硬上限，
     防的是「文件一直写不进去，但事件还在源源不断进来」那种情况下的无界增长。 */
  const MAX_AUDIT = 5000;
  const MAX_AUDIT_HARD = 20000;

  const receipts = new Map();   // receiptId -> receipt
  const byKeyMap = new Map();   // idempotencyKey -> receiptId
  const owners = new Map();     // ticketId -> workerId（用于交接检测）
  let generation = 0;
  let issued = 0, settled = 0, duplicates = 0;
  const audit = [];
  let flushed = 0;

  function rec(type, extra) {
    audit.push({ ts: now(), type, ...extra });
    if (audit.length > MAX_AUDIT_HARD) {
      const drop = audit.length - MAX_AUDIT_HARD;
      audit.splice(0, drop);
      flushed = Math.max(0, flushed - drop);
    }
  }

  const copy = (r) => (r ? { ...r } : null);

  /* 恢复：只信 settled。原因写在文件头 —— 未结算的收据若被当成"做过了"，
     真实的重试会被误判为重复而永久跳过，那是最难查的一类丢活。 */
  function load() {
    const f = snapOf();
    if (!f) return { ok: true, loaded: 0 };
    let raw = "";
    try { raw = fs.readFileSync(f, "utf8"); } catch { return { ok: true, loaded: 0 }; }
    let n = 0, maxGen = 0;
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let r;
      try { r = JSON.parse(s); } catch { continue; }
      if (!r || !r.receiptId || r.settled !== true) continue;
      receipts.set(r.receiptId, r);
      if (r.idempotencyKey) byKeyMap.set(r.idempotencyKey, r.receiptId);
      if (Number(r.generation) > maxGen) maxGen = Number(r.generation);
      n++;
    }
    /* generation 必须接着上次的数往上走：归零会让新收据的 id 与历史撞车，
       而 id 撞车意味着"这张收据到底是哪一次的"永久说不清。 */
    generation = maxGen;
    issued = n;
    settled = n;
    return { ok: true, loaded: n, generation };
  }

  function save() {
    const f = snapOf();
    if (!f) return { ok: true, written: 0 };
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const body = [...receipts.values()].map((r) => JSON.stringify(r)).join("\n");
      /* .part + rename：中途断电时宁可保留上一版快照，也不要留半个文件。 */
      fs.writeFileSync(f + ".part", body ? body + "\n" : "", "utf8");
      fs.renameSync(f + ".part", f);
    } catch { return { ok: false, written: 0 }; }
    return { ok: true, written: receipts.size };
  }

  /** 超上限时丢最老的**已结算**收据。未结算的一条都不能丢 —— 那是"正在做"。 */
  function prune(max = MAX_RECEIPTS) {
    if (receipts.size <= max) return { ok: true, removed: 0 };
    const rows = [...receipts.values()].sort((a, b) => a.generation - b.generation);
    let removed = 0;
    for (const r of rows) {
      if (receipts.size <= max) break;
      if (!r.settled) continue;
      receipts.delete(r.receiptId);
      if (byKeyMap.get(r.idempotencyKey) === r.receiptId) byKeyMap.delete(r.idempotencyKey);
      removed++;
    }
    return { ok: true, removed };
  }

  function issue(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const key = String(a.idempotencyKey ?? "");
    if (byKeyMap.has(key)) {
      duplicates++;
      const rid = byKeyMap.get(key);
      const prev = receipts.get(rid);
      rec("issue-duplicate", { idempotencyKey: key, receiptId: rid });
      /* existing 把上次的结果一并给出去：调用方据此直接返回旧产物，
         不必再执行一遍。duplicate 但 existing.settled=false 表示
         "上一次还没跑完"——那种情况要**拒绝**重复提交，而不是并行再开一份。 */
      return {
        generation: prev.generation,
        receiptId: rid,
        duplicate: true,
        existing: { settled: !!prev.settled, ok: prev.ok, result: prev.result },
      };
    }
    generation++;
    const hash = createHash("sha256").update(key + "#" + generation, "utf8").digest("hex").slice(0, 12);
    const receiptId = `r-${generation}-${hash}`;
    const r = {
      receiptId,
      generation,
      idempotencyKey: key,
      ticketId: String(a.ticketId ?? ""),
      effect: a.effect ?? null,
      ok: null,
      result: null,
      settled: false,
      issuedAt: now(),
      settledAt: null,
    };
    receipts.set(receiptId, r);
    byKeyMap.set(key, receiptId);
    issued++;
    rec("issue", { receiptId, idempotencyKey: key, ticketId: r.ticketId });
    return { generation, receiptId, duplicate: false };
  }

  function settle(receiptId, arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const r = receipts.get(String(receiptId));
    if (!r) return { ok: false, receipt: null };
    if (!r.settled) {
      r.ok = a.ok === true;
      r.result = a.result ?? null;
      r.settled = true;
      r.settledAt = now();
      settled++;
      rec("settle", { receiptId: r.receiptId, ok: r.ok });
      save();                    // 结算即落盘：幂等要跨进程生效，就不能等退出时才写
      prune();
    }
    return { ok: true, receipt: copy(r) };
  }

  function get(receiptId) {
    return copy(receipts.get(String(receiptId)));
  }

  function byKey(key) {
    const rid = byKeyMap.get(String(key));
    return rid ? copy(receipts.get(rid)) : null;
  }

  /* 内存归属：worker 变更（交接）或显式中断时标 interruption:true。 */
  function memoryOwnership(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const worker = String(a.workerId ?? "");
    const ticket = String(a.ticketId ?? "");
    const epoch = a.epoch ?? 0;
    const version = a.version ?? 0;
    const prev = owners.get(ticket);
    const handover = prev !== undefined && prev !== worker;
    owners.set(ticket, worker);
    const out = { worker_id: worker, ticket_id: ticket, epoch, version };
    if (a.interruption === true || handover) out.interruption = true;
    rec("memoryOwnership", { ...out });
    return out;
  }

  function flush() {
    const f = fileOf();
    if (!f) return { ok: true, appended: 0 };
    if (flushed >= audit.length) return { ok: true, appended: 0 };
    const pending = audit.slice(flushed);
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, pending.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
      flushed = audit.length;
      /* 审计队列必须有上限。原先它只前进不回收：不断 issue 而从不裁剪，
         长时间跑会一路涨（一条 30 步自动化每步 2 条 = 一次 60 条）。
         裁剪只丢**已经落过盘**的前缀，pending 一条都不动。 */
      if (audit.length > MAX_AUDIT) {
        audit.splice(0, audit.length - MAX_AUDIT);
        flushed = audit.length;
      }
    } catch { /* 写盘失败收敛 */ }
    return { ok: true, appended: pending.length };
  }

  function stats() {
    let pending = 0;
    for (const r of receipts.values()) if (!r.settled) pending++;
    return { issued, settled, duplicates, pending, generation, keys: byKeyMap.size, max: MAX_RECEIPTS };
  }

  return { issue, settle, get, byKey, memoryOwnership, load, save, prune, stats, flush };
}
