/* ---------------- 工单存储（ticketStore） ----------------
 *
 * 为什么要有它：bridge 里原来只有一张 `jobs` Map —— 它在内存里、进程退出即消失、
 * 而且**没有版本号**。面板侧另有一套 `runningJobs` 计数、vidx 还有第三套 `job` 对象。
 * 三套"任务在跑"的真相互不校验，于是 2026-10 出现过两次同一类事故：
 *   任务已经 failed，最后一条迟到的 `ready` 把它覆写回"成功"，面板显示正常、实际白跑。
 *
 * 这里用三条硬约束把这类 bug 从结构上挡掉，而不是靠"记得判一下"：
 *
 *   ① **单一写者**：所有变更只走 mutate()，外部拿不到内部对象（返回的都是快照）。
 *   ② **乐观并发（CAS）**：每次 transition 带 expectRev，rev 不匹配就拒绝，
 *      迟到的写入再也覆盖不了新状态。
 *   ③ **状态优先级**：终态（failed/stopped/aborted/dropped）不会被 running/ready
 *      覆盖；要重开必须显式 resume()，且会同时抬升 epoch。
 *
 * epoch（世代号）是急停语义的核心：
 *   急停不是"把当前任务停下来"这一件事，而是"让**所有旧世代的工作**都失效"。
 *   任务开工时记下开工时的 epoch，之后每次写状态/派活前比对，
 *   epoch 不一致就是陈旧任务 —— 哪怕它的回调晚到了十分钟，也只能被丢弃。
 *
 * 保留期（retention）：SuperAgent 原型被自己列为已知缺陷的就是"没有删除机制，
 * trigger/disposition/decision/outbox 等表无界增长"。这里第一天就带 TTL + 上限，
 * 因为一个每天几十条任务的桌面端，一年后就是十万条，读盘/广播都会遭殃。
 */

import fs from "node:fs";
import path from "node:path";

/** 终态：一旦进入就不允许被普通流转覆盖。 */
export const TERMINAL = new Set(["done", "failed", "dropped", "stopped", "aborted"]);

/** "成功类"状态。旧世代的任务永远不许写成这两个 —— see transition ②。 */
const SUCCESS_STATES = new Set(["done", "ready"]);

/* 状态优先级。数字只用于比较：**新状态的等级低于旧状态 = 拒绝**。
 *   running 0 < ready 2 → 迟到的 ready 不能盖掉 failed(3)
 * 注意 done 与 ready 同级：两者都是"正常完成"，先到先得，不做互相覆盖。 */
const RANK = {
  queued: 0,
  running: 1,
  idle: 1,
  ready: 2,
  done: 2,
  failed: 3,
  blocked: 3,
  dropped: 4,
  stopped: 4,
  aborted: 4,
};

const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;   // 终态工单留 7 天，够回溯一周的故障
const DEFAULT_MAX = 300;                       // 上限：超出后按"最老的终态"淘汰
const SAVE_DEBOUNCE_MS = 400;

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function createTicketStore(opts = {}) {
  const dir = opts.dir || process.cwd();
  const file = path.join(dir, opts.file || "tickets.json");
  const now = opts.now || Date.now;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const maxTickets = opts.maxTickets ?? DEFAULT_MAX;
  const log = opts.log || (() => {});
  const onChange = opts.onChange || (() => {});

  /** 磁盘结构。version 只增不减，读到更高版本直接拒绝启动（见 load）。 */
  const state = { version: 1, seq: 0, epoch: 0, savedAt: 0, tickets: {} };
  let saveTimer = null;
  let dirty = false;
  let closed = false;

  /* ---------- 读盘 ---------- */
  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!raw || typeof raw !== "object") return;
      if (Number(raw.version) > state.version) {
        // 版本比本程序新：宁可空跑也不能用旧逻辑去写坏新结构。
        log(`[tickets] ${file} 的 schema 版本 ${raw.version} 高于本程序 ${state.version}，改为只读空库`);
        return;
      }
      state.seq = Number(raw.seq) || 0;
      state.epoch = Number(raw.epoch) || 0;
      state.savedAt = Number(raw.savedAt) || 0;
      const t = raw.tickets && typeof raw.tickets === "object" ? raw.tickets : {};
      for (const [id, v] of Object.entries(t)) {
        if (v && typeof v === "object") state.tickets[id] = v;
      }
      // 读盘后立刻剪一次：上次崩溃前可能已经超期。
      prune({ persist: false, quiet: true });
    } catch (err) {
      if (err && err.code !== "ENOENT") log(`[tickets] 读盘失败（按空库继续）：${err.message}`);
    }
  }

  /* ---------- 原子落盘 ----------
   * 先写 .part 再 rename：Windows 上 rename 同卷是原子替换，
   * 中途断电最坏是留下一个 .part，而不是把 tickets.json 写成半截 JSON。 */
  function saveNow() {
    if (closed) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      state.savedAt = now();
      const tmp = `${file}.part`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      try {
        fs.renameSync(tmp, file);
      } catch {
        // 目标被占用（杀软/编辑器）时 rename 会 EPERM：退化成覆盖写，别丢数据。
        fs.writeFileSync(file, JSON.stringify(state));
        try { fs.unlinkSync(tmp); } catch {}
      }
      dirty = false;
    } catch (err) {
      log(`[tickets] 落盘失败：${err.message}`);
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer || closed) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (dirty) saveNow();
    }, SAVE_DEBOUNCE_MS);
    if (saveTimer.unref) saveTimer.unref();
  }

  /* ---------- 唯一写入口 ----------
   * 所有 mutator 都在这里串行执行。JS 单线程本身不会真并发，
   * 但"读-判断-写"跨了 await 就会。所以这里强制同步：不返回 Promise、不接受回调。
   */
  function mutate(fn) {
    const out = fn(state);
    /* 这里**不能**用 "state.tickets 引用变没变" 判断是否有改动：
     * 所有写操作都是往同一个对象里塞键值，引用永远不变，等于永远不落盘、
     * 永远不剪枝 —— 保留期形同虚设，重启即丢最近状态。
     * 进到这里的一定是 mutator，无条件剪枝 + 落盘，代价是每轮一次同步 JSON，
     * 对一个桌面端（每秒个位数变更）完全可接受，换来的是"不会静默丢数据"。 */
    prune({ persist: false, quiet: true });
    scheduleSave();
    try { onChange(snapshotMeta()); } catch {}
    return out;
  }

  function snapshotMeta() {
    return { epoch: state.epoch, seq: state.seq, total: Object.keys(state.tickets).length };
  }

  /* ---------- 保留期 ---------- */
  function prune(o = {}) {
    const t = now();
    const all = Object.values(state.tickets);
    let removed = 0;

    for (const tk of all) {
      if (!TERMINAL.has(tk.status)) continue;
      const endedAt = Number(tk.endedAt) || Number(tk.updatedAt) || 0;
      if (endedAt && t - endedAt > ttlMs) {
        delete state.tickets[tk.id];
        removed++;
      }
    }

    const left = Object.values(state.tickets);
    if (left.length > maxTickets) {
      // 只淘汰终态，且先砍最老的；**绝不淘汰在跑的**（那会让面板查不到活任务）。
      const victims = left
        .filter((x) => TERMINAL.has(x.status))
        .sort((a, b) => (a.endedAt || a.updatedAt || 0) - (b.endedAt || b.updatedAt || 0));
      let need = left.length - maxTickets;
      for (const v of victims) {
        if (need <= 0) break;
        delete state.tickets[v.id];
        removed++;
        need--;
      }
    }

    if (removed && o.persist !== false) scheduleSave();
    if (removed && !o.quiet) log(`[tickets] 保留期回收 ${removed} 条`);
    return removed;
  }

  /* ---------- 公开 API ---------- */

  /** 开一张工单。epoch 取**开工瞬间**的世代号，之后一切判断都以它为准。 */
  function openTicket(input = {}) {
    return mutate(() => {
      let id = String(input.id || `t${++state.seq}`);
      /* 撞 id 时**绝不覆盖**。这不是理论风险：bridge 重启后 jobSeq 从 0 重数，
       * 第一次测试就撞出了 "job-1"，把上一次运行的历史工单整条盖掉 ——
       * 轨迹、成本、结论全没了，而面板上看起来一切正常。
       * 这里退化成带序号的 id，宁可名字难看，也不能丢历史。 */
      if (state.tickets[id]) {
        const base = id;
        let n = 1;
        while (state.tickets[`${base}#${n}`]) n++;
        id = `${base}#${n}`;
        log(`[tickets] id 冲突（${base}），改用 ${id}`);
      }
      const t = now();
      const ticket = {
        id,
        epoch: state.epoch,
        title: String(input.title || "").slice(0, 200),
        kind: String(input.kind || "task"),        // task | vision | job | record
        source: String(input.source || "panel"),   // panel | trigger | expert | api
        status: "running",
        rev: 1,
        createdAt: t,
        updatedAt: t,
        endedAt: 0,
        reason: "",
        expertId: input.expertId ? String(input.expertId) : "",
        parentId: input.parentId ? String(input.parentId) : "",
        meta: input.meta && typeof input.meta === "object" ? clone(input.meta) : {},
      };
      state.tickets[id] = ticket;
      return clone(ticket);
    });
  }

  /**
   * 状态流转。返回 { ok, ticket } 或 { ok:false, code, ... }。
   * code 取值：not-found | stale-rev | illegal | stale-epoch
   */
  function transition(id, to, o = {}) {
    return mutate(() => {
      const cur = state.tickets[String(id)];
      if (!cur) return { ok: false, code: "not-found", id: String(id) };

      // ① CAS：调用方必须带着它读到的 rev，否则就是"迟到的写入"。
      if (o.expectRev != null && Number(o.expectRev) !== Number(cur.rev)) {
        return { ok: false, code: "stale-rev", id: cur.id, rev: cur.rev, want: o.expectRev };
      }

      /* ② 陈旧世代：急停之后，旧世代的回调一律不收。
       *    唯一例外是 allowStale —— 但它只放开"往下收"的终态（stopped/failed/
       *    aborted…）：不放开的话，被急停打断的工单永远停在 running，
       *    summary().open 一直不为零，面板上就是"什么都没跑却显示在跑"。
       *    成功类状态（done/ready）永远不给过：旧世代跑完的结果若能借结算
       *    写成成功，等于急停根本没停住。 */
      if (o.enforceEpoch !== false && Number(cur.epoch) < state.epoch) {
        const closing = o.allowStale === true && !SUCCESS_STATES.has(String(to));
        if (!closing) {
          return { ok: false, code: "stale-epoch", id: cur.id, epoch: cur.epoch, current: state.epoch };
        }
      }

      // ③ 优先级：不许用低等级覆盖高等级（failed 不被 ready 盖掉）。
      const from = RANK[cur.status] ?? 1;
      const toRank = RANK[to] ?? 1;
      if (toRank < from && !o.force) {
        return { ok: false, code: "illegal", id: cur.id, from: cur.status, to };
      }
      // 终态之间互不覆盖，除非显式 force（例如人工把 aborted 改判为 dropped）。
      if (TERMINAL.has(cur.status) && TERMINAL.has(to) && cur.status !== to && !o.force) {
        return { ok: false, code: "illegal", id: cur.id, from: cur.status, to };
      }

      const t = now();
      const next = { ...cur, status: String(to), rev: Number(cur.rev) + 1, updatedAt: t };
      if (o.reason) next.reason = String(o.reason).slice(0, 300);
      if (TERMINAL.has(to)) next.endedAt = t;
      if (o.patch && typeof o.patch === "object") next.meta = { ...(cur.meta || {}), ...clone(o.patch) };
      if (o.expertId) next.expertId = String(o.expertId);
      state.tickets[cur.id] = next;
      return { ok: true, ticket: clone(next) };
    });
  }

  /** 抬升世代。急停调用：之后所有旧 epoch 的工单都被视为陈旧。 */
  function bumpEpoch(reason) {
    return mutate(() => {
      state.epoch = Number(state.epoch) + 1;
      const t = now();
      let staled = 0;
      for (const tk of Object.values(state.tickets)) {
        if (TERMINAL.has(tk.status)) continue;
        tk.stale = true;
        tk.staleReason = String(reason || "").slice(0, 120);
        tk.rev = Number(tk.rev) + 1;
        tk.updatedAt = t;
        staled++;
      }
      return { epoch: state.epoch, staled };
    });
  }

  /**
   * 显式重开工单：只允许人工/恢复路径调用。
   * 它会**抬升该工单自己的 epoch**，从而让所有还在飞的旧回调失效 ——
   * 这是"恢复"最容易被忽略的一半：恢复不是把开关拨回去，而是换一代。
   */
  function resumeTicket(id, o = {}) {
    return mutate(() => {
      const cur = state.tickets[String(id)];
      if (!cur) return { ok: false, code: "not-found", id: String(id) };
      /* 急停时工单并**不会**变成终态 —— 它只是被标了 stale（状态仍是 running）。
       * 所以"能不能恢复"必须同时认两件事：已经结束的，或者被急停判陈旧的。
       * 只认终态会导致最常见的场景（急停后恢复刚才那单）直接报 illegal。 */
      if (!TERMINAL.has(cur.status) && !cur.stale && !o.force) {
        return { ok: false, code: "illegal", id: cur.id, from: cur.status, to: "running" };
      }
      const t = now();
      const next = {
        ...cur,
        status: "running",
        rev: Number(cur.rev) + 1,
        epoch: state.epoch,          // 跟随当前世代，而不是自己再 +1
        stale: false,
        staleReason: "",
        endedAt: 0,
        updatedAt: t,
        resumes: Number(cur.resumes || 0) + 1,
      };
      state.tickets[cur.id] = next;
      return { ok: true, ticket: clone(next) };
    });
  }

  const get = (id) => clone(state.tickets[String(id)] || null);

  /**
   * 一次性收尾"本进程之前遗留的非终态工单"。
   *
   * 为什么必须有：进程被杀/断电/崩溃时，工单表里会留下 status=running 的条目。
   * 它们**永远不会再被任何回调结算**（产生它们的进程已经没了），而 `prune()`
   * 只淘汰终态，于是这些幽灵会一直计入 summary().open —— 面板上就是
   * "明明什么都没跑，却显示有 1 个任务在跑"，而且越积越多。
   *
   * 判定依据不需要猜：这个方法只应在**启动时**调用，那一刻内存里没有任何在跑
   * 任务，所以任何非终态条目必然是幽灵。改成 aborted 而不是 done，是为了不去
   * 伪造成功。allowStale 必须给：它们多半同时是旧世代的。
   */
  function reapDangling(reason) {
    return mutate(() => {
      const t = now();
      let reaped = 0;
      for (const tk of Object.values(state.tickets)) {
        if (TERMINAL.has(tk.status)) continue;
        const next = {
          ...tk,
          status: "aborted",
          rev: Number(tk.rev) + 1,
          updatedAt: t,
          endedAt: t,
          stale: true,
          staleReason: String(reason || "进程重启时未结算").slice(0, 120),
          reason: String(reason || "进程重启时未结算").slice(0, 300),
        };
        state.tickets[tk.id] = next;
        reaped++;
      }
      return { reaped };
    });
  }

  function list(o = {}) {
    let all = Object.values(state.tickets);
    if (o.status) all = all.filter((x) => x.status === o.status);
    if (o.open) all = all.filter((x) => !TERMINAL.has(x.status));
    all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const limit = Math.max(1, Math.min(Number(o.limit) || 50, 200));
    return all.slice(0, limit).map(clone);
  }

  function summary() {
    const all = Object.values(state.tickets);
    const byStatus = {};
    let open = 0;
    let stale = 0;
    for (const t of all) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      if (!TERMINAL.has(t.status)) open++;
      if (t.stale) stale++;
    }
    return {
      epoch: state.epoch, total: all.length, open, stale, byStatus,
      oldestOpenAt: all.filter((x) => !TERMINAL.has(x.status)).reduce((m, x) => Math.min(m || Infinity, x.createdAt), 0) || 0,
    };
  }

  function close() {
    closed = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (dirty) saveNow();
  }

  load();

  return {
    file, openTicket, transition, bumpEpoch, resumeTicket, prune,
    get, list, summary, close, flush: saveNow, reapDangling,
    get epoch() { return state.epoch; },
  };
}
