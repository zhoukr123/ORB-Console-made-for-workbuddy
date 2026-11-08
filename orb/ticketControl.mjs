/* 工单急停 / 引导：global 暂停只挡新工单，在跑的 isBlocked 永远 false。
 * steer 追加指令在 step 边界 join，不即时打断；alert 按三元组去重。
 * 严禁合并连续 click/wait/type：本模块不提供任何批量 GUI 动作合并能力
 * （会吃掉危险确认中断点 / 破坏急停响应粒度 / 模糊回滚边界）。
 * 写盘失败收敛、不抛不崩。 */
import * as fsDefault from "node:fs";
import path from "node:path";

export function createTicketControl(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  const fs = o.fs || fsDefault;
  const fileOf = typeof o.file === "function" ? o.file : () => (o.file || null);

  const paused = { ticket: false, global: false };
  const steers = new Map();      // ticketId -> [{ text, at }]
  const alertKeys = new Set();
  const audit = [];              // 待落盘记录
  let flushed = 0;
  let alertsCount = 0;
  let duplicatesCount = 0;

  function rec(type, extra) {
    audit.push({ ts: now(), type, ...extra });
  }

  function normScope(scope) {
    return scope === "ticket" || scope === "global" ? scope : null;
  }

  function pause(scope) {
    const s = normScope(scope);
    if (!s) return { ok: false, reason: "bad-scope" };
    paused[s] = true;
    rec("pause", { scope: s });
    return { ok: true, scope: s, paused: true };
  }

  function resume(scope) {
    const s = normScope(scope);
    if (!s) return { ok: false, reason: "bad-scope" };
    paused[s] = false;
    rec("resume", { scope: s });
    return { ok: true, scope: s, paused: false };
  }

  /* isNew=false（在跑）永远 false；global 暂停挡所有新工单。 */
  function isBlocked(scope, o2 = {}) {
    const a = o2 && typeof o2 === "object" ? o2 : {};
    const isNew = a.isNew !== false;
    if (!isNew) return false;
    const s = normScope(scope);
    return !!(paused.global || (s && paused[s]));
  }

  function steer(ticketId, text) {
    const id = String(ticketId ?? "");
    const arr = steers.get(id) || [];
    arr.push({ text: String(text ?? ""), at: now() });
    steers.set(id, arr);
    rec("steer", { ticketId: id, text: String(text ?? "") });
    return { ok: true, pending: true };
  }

  function applyStep(ticketId, stepIdx) {
    const id = String(ticketId ?? "");
    const arr = steers.get(id) || [];
    const applied = arr.map((x) => x.text);
    steers.delete(id);
    rec("applyStep", { ticketId: id, stepIdx, applied });
    return { ok: true, applied, atStep: stepIdx };
  }

  function humanCorrection(ticketId, text) {
    const id = String(ticketId ?? "");
    rec("human_correction", { ticketId: id, text: String(text ?? "") });
    return { ok: true, type: "human_correction" };
  }

  /* ---------------- 三种控制事件（纠正 / 停止 / 换思路） ----------------
   *
   * 为什么要统一成一个入口：这三件事在"人"这边是同一个动作——
   * 「我看出来它要跑偏了，我要插手」。分成三条互不相干的接口，
   * 执行层就会各自实现一遍优先级，最后一定出现"点了停止但纠正还在往下灌"。
   *
   * 所以这里只产出一个**带 effect 的事件**，effect 说明执行层该怎么处理：
   *   correct → 在下一个 step 边界追加这条要求（不即时打断，避免半截状态）
   *   stop    → 立刻收尾（正在跑的那一步允许自然结束，但不再开新步）
   *   rethink → 丢掉剩余计划，用这条提示重排；已经产出的中间结果保留可查
   *
   * 三者都不抛异常：控制指令本身失败最忌讳把执行器带崩。
   */
  const CONTROL_KINDS = Object.freeze({
    correct: { effect: "append-at-step", needsText: true },
    stop: { effect: "abort-now", needsText: false },
    rethink: { effect: "replan", needsText: true },
  });

  const controls = new Map();    // ticketId -> [{ seq, kind, text, at, effect }]
  let controlSeq = 0;

  function control(ticketId, kind, payload) {
    const meta = CONTROL_KINDS[kind];
    if (!meta) return { ok: false, error: "kind 只能是 correct / stop / rethink" };
    const id = String(ticketId ?? "");
    if (!id) return { ok: false, error: "缺 ticketId" };
    const text = String((payload && payload.text) ?? "").trim();
    if (meta.needsText && !text) return { ok: false, error: `${kind} 必须带一句话说明要改成什么` };

    const ev = {
      seq: ++controlSeq,
      ticketId: id,
      kind,
      text: meta.needsText ? text.slice(0, 2000) : "",
      effect: meta.effect,
      at: now(),
    };
    const arr = controls.get(id) || [];
    arr.push(ev);
    // 单工单最多留 50 条：控制事件的用途是复盘，不是留档全文。
    if (arr.length > 50) arr.shift();
    controls.set(id, arr);

    rec("control", { ticketId: id, kind, text: ev.text, effect: ev.effect, seq: ev.seq });

    /* correct 与 steer 是同一件事的两种叫法：都必须在 step 边界合流。
     * 这里顺手往 steers 里塞一份，执行层不必为"纠正"再写一条取数路径。 */
    if (kind === "correct") {
      const s = steers.get(id) || [];
      s.push({ text, at: ev.at });
      steers.set(id, s);
    }
    return { ok: true, event: ev };
  }

  /** 某单的控制事件（新的在前），用于面板下钻。 */
  function events(ticketId, limit = 20) {
    const id = String(ticketId ?? "");
    const n = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 20;
    const arr = controls.get(id) || [];
    return n === 0 ? [] : arr.slice(-n).reverse();
  }

  /** 最近一次控制事件（执行层每步开头问一句"有没有人插手"）。 */
  function lastControl(ticketId) {
    const arr = controls.get(String(ticketId ?? "")) || [];
    return arr.length ? arr[arr.length - 1] : null;
  }

  function alert(ticketId, reason, epoch) {
    const id = String(ticketId ?? "");
    const r = String(reason ?? "");
    const e = epoch == null ? 0 : epoch;
    const key = JSON.stringify([id, r, e]);
    if (alertKeys.has(key)) {
      duplicatesCount++;
      rec("alert-duplicate", { ticketId: id, reason: r, epoch: e });
      return { ok: true, duplicate: true };
    }
    alertKeys.add(key);
    alertsCount++;
    rec("alert", { ticketId: id, reason: r, epoch: e });
    return { ok: true, duplicate: false };
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
    } catch { /* 写盘失败收敛，不抛；下次可重试 */ }
    return { ok: true, appended: pending.length };
  }

  function stats() {
    let pendingSteers = 0;
    for (const arr of steers.values()) pendingSteers += arr.length;
    return {
      paused: paused.ticket || paused.global,
      pendingSteers,
      alerts: alertsCount,
      duplicates: duplicatesCount,
      controls: controlSeq,
    };
  }

  return { pause, resume, isBlocked, steer, applyStep, humanCorrection, alert, control, events, lastControl, stats, flush };
}
