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
 *
 * S5（2026-11-09）从"超时"升为"生命周期控制"：
 *   recipe 声明「预期完成事件 / 最大静默期 / 里程碑 / 探测方式」，看门狗监听
 *   **预期完成事件有没有出现**，而不是拿命令数/纯心跳当内部验收阈值。
 *   连续两个采样周期未见预期事件 → 进入 absent，先只读探活，再按幂等性、
 *   外部副作用、凭证作用域给出降级/重试/交还人工的**建议**（不自动重跑）。
 *   验收 #6：静默不结束且不报错的 recipe 触发「预期完成事件缺失」告警；
 *   进程 200 / a11y 非空不单独算完成；人工停止项永不被拉起。
 */

const DEFAULT_STALE_MS = 8 * 60 * 1000;
const DEFAULT_REPEAT_N = 3;
const DEFAULT_MAX_SILENCE_MS = 8 * 60 * 1000;   // 预期完成事件应在多久内出现
const DEFAULT_ABSENT_AFTER = 2;                  // 连续几个采样周期未见 → absent

/* 归一化 recipe 声明的预期事件契约。字段多别名兼容（驼峰 / 下划线）。纯函数、可单测。 */
export function normalizeExpectedContract(raw = {}) {
  const c = (raw && typeof raw === "object") ? raw : {};
  const evs = c.expectedEvents ?? c.expected_event_schema ?? c.expectedEvent ?? c.expected_event;
  let expectedEvents;
  if (Array.isArray(evs)) expectedEvents = evs.map((x) => typeof x === "string" ? x : String(x?.name || x?.event || x?.type || "")).filter(Boolean);
  else if (typeof evs === "string") expectedEvents = evs ? [evs] : [];
  else if (evs && typeof evs === "object") expectedEvents = [String(evs.name || evs.event || "")].filter(Boolean);
  else expectedEvents = [];
  // 空声明回落到缺省「配方跑完应落 recipe.done」，而不是拒绝 —— recipe 写 expectedEvents:[]
  // 只表示"用默认"，不该让整条生命周期控制失效。
  if (!expectedEvents.length) expectedEvents = ["recipe.done"];
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    expectedEvents,
    maxSilenceMs: num(c.maxSilenceMs ?? c.max_silence_ms, DEFAULT_MAX_SILENCE_MS),
    absentAfter: num(c.absentAfter ?? c.absent_after_samples, DEFAULT_ABSENT_AFTER),
    milestones: Array.isArray(c.milestones) ? c.milestones.map(String) : [],
    probe: String(c.probe ?? c.probeMethod ?? "read-only-liveness"),
    idempotent: c.idempotent === true,
    sideEffects: String(c.sideEffects ?? c.side_effects ?? "unknown"),
    credentialScope: String(c.credentialScope ?? c.credential_scope ?? "local"),
    label: String(c.label ?? c.title ?? "").slice(0, 120),
  };
}

/** 轨迹里是否出现了预期完成事件。命中 name 或 type，且 ok!==false。纯函数、可单测。 */
export function hasExpectedEvent(rows, contract) {
  const want = new Set((contract && contract.expectedEvents) || []);
  if (!want.size) return false;
  return (Array.isArray(rows) ? rows : []).some((r) =>
    r && r.ok !== false && (want.has(String(r.name)) || want.has(String(r.type))));
}

/**
 * absent 后的处置建议（纯函数）。三条红线：
 *   · 只读探活显示进程已不在 → 交还人工（不重跑）
 *   · 涉及外部副作用/外部凭证 → 交还人工（绝不自动推进）
 *   · 幂等且无外部副作用 → 建议人工确认后重试（autoRerun 恒为 false）
 *   其余 → 建议降级到只读/结构化路径（也是建议，不动手）。
 */
export function decideAbsentAction(contract = {}, probe = {}) {
  const c = contract || {};
  const p = probe || {};
  if (p.alive === false) {
    return { action: "handoff", autoRerun: false, reason: "只读探活显示进程已不在，交还人工（绝不自动重跑/拉起）" };
  }
  const external = /external|cross|remote|外|跨/i.test(String(c.sideEffects)) || /external|remote|外|跨/i.test(String(c.credentialScope));
  if (external) {
    return { action: "handoff", autoRerun: false, reason: "涉及外部副作用/外部凭证作用域，绝不自动重试或推进，交还人工" };
  }
  if (c.idempotent === true && /^(none|无|false)$/i.test(String(c.sideEffects))) {
    return { action: "retry", autoRerun: false, reason: "幂等且无外部副作用：建议人工确认后重试（看门狗不自动重跑）" };
  }
  return { action: "degrade", autoRerun: false, reason: "预期完成事件缺失：建议降级到只读/结构化路径并交人复核（不自动重跑）" };
}

export function createWatchdog(opts = {}) {
  const tickets = opts.tickets;
  const trajectory = opts.trajectory || null;
  const now = opts.now || Date.now;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const repeatN = opts.repeatN ?? DEFAULT_REPEAT_N;
  const allowAbort = opts.allowAbort === true;
  const onAlert = opts.onAlert || (() => {});
  const log = opts.log || (() => {});
  /* 只读探活：由调用方注入（例如查进程/端口/a11y 是否非空）。默认不触碰任何进程，
   * 返回 alive:null 表示"没探"，绝不把 alive 当成"完成"的证据。 */
  const probeLiveness = typeof opts.probeLiveness === "function" ? opts.probeLiveness : null;

  let timer = null;
  let last = { at: 0, checked: 0, stalled: [], repeating: [], absent: [], acted: [] };
  let alerts = 0;
  /* ticketId -> 运行中的预期事件契约状态（内存态，随进程；不落盘）。 */
  const contracts = new Map();

  function safeProbe(ticketId) {
    if (!probeLiveness) return { alive: null, readOnly: true, note: "未注入探活实现（默认只读、不触碰进程）" };
    try {
      const r = probeLiveness(ticketId);
      return r && typeof r === "object" ? { ...r, readOnly: true } : { alive: null, readOnly: true, note: "探活未返回结构化结果" };
    } catch (e) {
      return { alive: null, readOnly: true, note: `探活异常：${e?.message ?? e}` };
    }
  }

  /** 声明一张工单的预期完成事件契约（recipe 点火时调用）。可覆盖更新。 */
  function declare(ticketId, rawContract = {}) {
    const id = String(ticketId || "");
    if (!id) return { ok: false, error: "ticketId 必填" };
    const c = normalizeExpectedContract(rawContract);
    if (!c.expectedEvents.length) return { ok: false, error: "expectedEvents 不能为空" };
    contracts.set(id, { ...c, declaredAt: now(), missSamples: 0, absent: false, lastEventAt: 0 });
    return { ok: true, ticketId: id, contract: c };
  }

  /** 撤销契约（recipe 正常结束/人工停止时调用），返回是否真的删了。 */
  function clear(ticketId) {
    return contracts.delete(String(ticketId || ""));
  }

  function listContracts() {
    const out = [];
    for (const [id, c] of contracts) out.push({ ticketId: id, ...c });
    return out;
  }

  /**
   * 跑一轮。返回本轮结论；不抛异常（看门狗自己挂掉就没人看门了）。
   */
  function tick(scope = {}) {
    const out = { at: now(), checked: 0, stalled: [], repeating: [], absent: [], acted: [] };
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

    /* S5 缺席检测：只认"预期完成事件有没有出现"，不认进程存活/HTTP 200/a11y 非空。
     * 终态（含人工 stopped）工单的契约一律就地清除，绝不拉起、绝不重跑。 */
    if (contracts.size) {
      const openIds = new Set(open.map((t) => String(t.id)));
      for (const [id, c] of [...contracts]) {
        if (!openIds.has(id)) { contracts.delete(id); continue; }  // 人工停止/已结束 → 撤销
        if (!trajectory) continue;                                  // 无轨迹无法判缺席，不误报
        let rows = [];
        try { rows = trajectory.read(id, 80); } catch { continue; }
        if (hasExpectedEvent(rows, c)) {                             // 预期事件已出现 → 复位
          c.missSamples = 0; c.absent = false; c.lastEventAt = now();
          continue;
        }
        // 最大静默期门禁：声明后还没到"该出现"的时间，不算缺席采样。
        const since = now() - c.declaredAt;
        if (since < c.maxSilenceMs) { c.missSamples = 0; continue; }
        c.missSamples++;
        if (c.missSamples >= c.absentAfter && !c.absent) {
          c.absent = true;
          const probe = safeProbe(id);
          const decision = decideAbsentAction(c, probe);
          const t = open.find((x) => String(x.id) === id);
          const rec = {
            ticketId: id, title: (t && t.title) || c.label || "", status: (t && t.status) || "",
            expectedEvents: c.expectedEvents, milestones: c.milestones,
            missSamples: c.missSamples, silenceMs: since, probe, decision,
            reason: `连续 ${c.missSamples} 个采样周期未见预期完成事件 [${c.expectedEvents.join(", ")}]（最大静默期 ${Math.round(c.maxSilenceMs / 1000)}s）`,
          };
          out.absent.push(rec);
          // 只报告，不动手：suggestion 是建议，autoRerun 恒 false，done 恒 false。
          out.acted.push({ ticketId: id, suggestion: decision.action, done: false, autoRerun: false, kind: "absent" });
          alerts++;
          try { onAlert({ kind: "absent", ...rec }); } catch {}
        }
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
        if (r.stalled.length || r.repeating.length || r.absent.length) {
          log(`[watchdog] 停滞 ${r.stalled.length} 单 / 反复报错 ${r.repeating.length} 单 / 预期事件缺失 ${r.absent.length} 单`);
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
      absent: last.absent.length,
      declared: contracts.size,
      /* S5 状态行：声明中的契约 + 最近一轮缺席明细，供 /api/status 与面板展示。 */
      contracts: listContracts().map(({ ticketId, expectedEvents, maxSilenceMs, absent, missSamples }) =>
        ({ ticketId, expectedEvents, maxSilenceMs, absent, missSamples })),
      // 明细只在 status 里给最近一轮，避免状态流每 1.5s 带一堆数组。
      detail: { stalled: last.stalled.slice(0, 5), repeating: last.repeating.slice(0, 5), absent: last.absent.slice(0, 5) },
    };
  }

  return { tick, start, stop, status, declare, clear, listContracts };
}
