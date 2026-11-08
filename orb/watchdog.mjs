/* ---------------- 本地看门狗（watchdog） ----------------
 *
 * 与原型的差别先说清楚：SuperAgent 的 Watchdog 是**主回路之外**的独立 Session，
 * 靠定时消息驱动、能热更新规则。这里没有云端、也没有第二个 Session，
 * 所以只做它最有价值的那一半：**判"有没有实质进展"，而不是判"进程还活着"**。
 *
 * 为什么"进程活着"不是指标：
 *   视觉循环卡在一个模态弹窗上时，进程 100% 健康、CPU 很低、日志照写，
 *   但连续 20 分钟没有任何状态变化。按存活判，它永远是好的。
 *
 * 三条克制：
 *   ① **只报告，不动手**（默认）。熔断需要显式打开 allowAbort，因为
 *      "自动把用户的任务杀掉"比"任务卡住"更难解释。
 *   ② **绝不碰人工停掉的东西**。用户按了急停，看门狗再把它拉起来是最坏的行为 ——
 *      它只看开着的工单，终态一律不碰。
 *   ③ **同类错误反复才算故障**。偶发一次失败不值得报警，同一句报错出现 3 次
 *      才是"在同一个坑里打转"。
 */

const DEFAULT_STALE_MS = 8 * 60 * 1000;
const DEFAULT_REPEAT_N = 3;

export function createWatchdog(opts = {}) {
  const tickets = opts.tickets;
  const trajectory = opts.trajectory || null;
  const now = opts.now || Date.now;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const repeatN = opts.repeatN ?? DEFAULT_REPEAT_N;
  const allowAbort = opts.allowAbort === true;
  const onAlert = opts.onAlert || (() => {});
  const log = opts.log || (() => {});

  let timer = null;
  let last = { at: 0, checked: 0, stalled: [], repeating: [], acted: [] };
  let alerts = 0;

  /**
   * 跑一轮。返回本轮结论；不抛异常（看门狗自己挂掉就没人看门了）。
   */
  function tick(scope = {}) {
    const out = { at: now(), checked: 0, stalled: [], repeating: [], acted: [] };
    if (!tickets) return out;

    let open = [];
    try { open = tickets.list({ open: true, limit: 200 }); } catch (err) { log(`[watchdog] 取工单失败：${err.message}`); return out; }

    for (const t of open) {
      out.checked++;

      /* "最后活动时间"优先取轨迹的最后一条，而不是工单的 updatedAt：
       * 工单只在状态流转时更新，而跑飞的任务恰恰是"状态不变但一直在动"或
       * "状态不变也不动"。轨迹是唯一能区分这两者的地方。 */
      let lastAt = Number(t.updatedAt) || Number(t.createdAt) || 0;
      if (trajectory) {
        try {
          const cp = trajectory.checkpoint(t.id);
          if (cp && cp.lastAt > lastAt) lastAt = cp.lastAt;
        } catch {}
      }
      const idle = now() - lastAt;

      if (idle > staleMs) {
        out.stalled.push({
          ticketId: t.id,
          title: t.title,
          status: t.status,
          idleMs: idle,
          epoch: t.epoch,
          reason: `已 ${Math.round(idle / 1000)}s 无实质进展（阈值 ${Math.round(staleMs / 1000)}s）`,
        });
      }

      // 同类错误反复：只在有轨迹时判，且只看最近 20 条里的 error。
      if (trajectory) {
        try {
          const rows = trajectory.read(t.id, 40).filter((r) => r.type === "error" || r.ok === false);
          const counts = new Map();
          for (const r of rows) {
            const key = String(r.message || r.error || "").slice(0, 120);
            if (!key) continue;
            counts.set(key, (counts.get(key) || 0) + 1);
          }
          for (const [msg, n] of counts) {
            if (n >= repeatN) out.repeating.push({ ticketId: t.id, message: msg, count: n });
          }
        } catch {}
      }
    }

    // 报告（默认不动手）。动作留成数组，面板可以逐条"采纳"。
    for (const s of out.stalled) {
      out.acted.push({ ticketId: s.ticketId, suggestion: allowAbort ? "abort" : "report", done: false });
      alerts++;
      try { onAlert({ kind: "stalled", ...s }); } catch {}
    }
    for (const r of out.repeating) {
      alerts++;
      try { onAlert({ kind: "repeating", ...r }); } catch {}
    }

    last = out;
    return out;
  }

  function start(intervalMs = 60000) {
    if (timer) return { ok: true, already: true };
    timer = setInterval(() => {
      try {
        const r = tick();
        // 无异常就不打日志：看门狗最忌讳每分钟刷一行"一切正常"。
        if (r.stalled.length || r.repeating.length) {
          log(`[watchdog] 停滞 ${r.stalled.length} 单 / 反复报错 ${r.repeating.length} 单`);
        }
      } catch (err) {
        log(`[watchdog] 本轮异常：${err?.message ?? err}`);
      }
    }, Math.max(5000, Number(intervalMs) || 60000));
    if (timer.unref) timer.unref();
    return { ok: true, intervalMs };
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    return { ok: true };
  }

  function status() {
    return {
      running: !!timer,
      staleMs, repeatN, allowAbort, alerts,
      lastAt: last.at,
      stalled: last.stalled.length,
      repeating: last.repeating.length,
      // 明细只在 status 里给最近一轮，避免状态流每 1.5s 带一堆数组。
      detail: { stalled: last.stalled.slice(0, 5), repeating: last.repeating.slice(0, 5) },
    };
  }

  return { tick, start, stop, status };
}
