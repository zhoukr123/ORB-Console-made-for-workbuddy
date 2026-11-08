/* ---------------- Worker 池（workerPool） ----------------
 *
 * 这是"5-1 N 个后台 Worker"的宿主，但**默认 maxWorkers = 1**：
 * 也就是装上了闸门、闸门先关着。原因是并发是放大器不是优化本身 ——
 * 没有基线数据就开 N 个 Worker，只会把一次派错放大成 N 个同时出错，
 * 账单还近似线性翻倍。
 *
 * 四条约束（前三条抄原型，第四条是桌面端独有）：
 *   ① **人类请求优先**，并且允许**超一个槽**：用户敲的那句不能被十个后台任务堵在后面。
 *   ② **GUI 任务硬串行**：鼠标/键盘/焦点/剪贴板是全局单例，跟 maxWorkers 无关 ——
 *      哪怕配了 8 个槽，同一时刻也只允许一个任务动键鼠。
 *   ③ **急停即清队**：halt() 之后队列清空、不再启动新任务，恢复要显式 resume()。
 *   ④ **拿不到 GUI 锁就让位重排**，不是失败。视觉步骤宁可晚 500ms，也不要抢焦点。
 */

const PRIORITY = { human: 0, trigger: 1, background: 2 };

export function createWorkerPool(opts = {}) {
  const now = opts.now || Date.now;
  const maxQueue = opts.maxQueue ?? 20;
  const lock = opts.lock || null;
  const log = opts.log || (() => {});
  const onChange = opts.onChange || (() => {});

  let maxWorkers = Math.max(1, Math.min(Number(opts.maxWorkers) || 1, 8));
  let halted = false;
  let haltReason = "";
  let seq = 0;
  let pumping = false;
  const queue = [];        // 待跑：按 priority 再按入队时间
  const running = new Map(); // id -> {task, startedAt, slot}

  const isAlive = () => !halted;

  function normalize(task = {}) {
    const pr = typeof task.priority === "number"
      ? task.priority
      : (PRIORITY[task.priority] ?? PRIORITY.background);
    return {
      id: String(task.id || `w${++seq}`),
      kind: String(task.kind || "job"),
      priority: Math.max(0, Math.min(9, pr)),
      exclusive: task.exclusive === true,   // 需要动键鼠/焦点
      run: typeof task.run === "function" ? task.run : null,
      onAbort: typeof task.onAbort === "function" ? task.onAbort : null,
      enqueuedAt: now(),
      attempts: 0,
      meta: task.meta && typeof task.meta === "object" ? { ...task.meta } : {},
    };
  }

  /**
   * 入队。返回 { ok, id, queued, position } 或 { ok:false, code }。
   * 注意：**满队时人类请求也拒**（返回 code:'full'）而不是静默丢 ——
   * 调用方要能把"没排上"如实告诉用户。
   */
  function submit(task = {}) {
    if (halted) return { ok: false, code: "halted", reason: haltReason };
    const t = normalize(task);
    if (!t.run) return { ok: false, code: "no-runner" };
    if (queue.length >= maxQueue) return { ok: false, code: "full", queued: queue.length };
    if (running.has(t.id)) return { ok: false, code: "dup" };

    // 插入排序：优先级小的在前；同优先级按入队时间（FIFO）。
    let at = queue.length;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].priority > t.priority) { at = i; break; }
    }
    queue.splice(at, 0, t);
    onChange(status());
    // 入队即尝试泵一次，不必等下一个定时器。
    Promise.resolve().then(() => pump());
    return { ok: true, id: t.id, queued: queue.length, position: at };
  }

  /** 允许的并发数上限：人类请求可以多拿一个槽（且只多一个）。 */
  function capacityFor(head) {
    const overflow = head && head.priority === PRIORITY.human ? 1 : 0;
    return maxWorkers + overflow;
  }

  async function pump() {
    if (pumping || halted) return { ok: true, started: 0 };
    pumping = true;
    let started = 0;
    try {
      for (let guard = 0; guard < 32; guard++) {
        const head = queue[0];
        if (!head) break;
        if (running.size >= capacityFor(head)) break;

        // GUI 独占：与 maxWorkers 无关，同一时刻只允许一条在跑。
        if (head.exclusive && [...running.values()].some((r) => r.task.exclusive)) break;

        // 需要 GUI 的，先拿锁；拿不到就挪到队尾等下一轮（不算失败，不消耗重试）。
        if (head.exclusive && lock) {
          const got = lock.acquire({ owner: `pool:${head.id}`, ttlMs: 20000, meta: { kind: head.kind } });
          if (!got.ok) {
            head.attempts++;
            queue.shift();
            queue.push(head);
            setTimeout(() => { Promise.resolve().then(() => pump()); }, 500);
            break;
          }
          head._lockToken = got.token;
        }

        queue.shift();
        running.set(head.id, { task: head, startedAt: now(), slot: running.size });
        started++;
        onChange(status());

        // 不 await：池要能继续派下一个（真并发）；单条的结果由它自己汇报。
        Promise.resolve()
          .then(() => head.run({ id: head.id, priority: head.priority, meta: head.meta }))
          .then((result) => ({ ok: true, result }))
          .catch((err) => ({ ok: false, error: String(err?.message ?? err) }))
          .then((r) => {
            if (head._lockToken && lock) { try { lock.release(head._lockToken, "pool-done"); } catch {} }
            head._lockToken = "";
            running.delete(head.id);
            onChange(status());
            Promise.resolve().then(() => pump());
            return r;
          });
      }
    } catch (err) {
      log(`[pool] 泵异常：${err?.message ?? err}`);
    } finally {
      pumping = false;
    }
    return { ok: true, started };
  }

  /** 停单条：在队列里就摘掉；在跑就交给它的 onAbort（真正的进程杀在 bridge 侧）。 */
  function abort(id) {
    const key = String(id);
    const qi = queue.findIndex((t) => t.id === key);
    if (qi >= 0) {
      const [t] = queue.splice(qi, 1);
      onChange(status());
      return { ok: true, where: "queue", id: t.id };
    }
    const r = running.get(key);
    if (!r) return { ok: false, code: "not-found" };
    try { r.task.onAbort?.(); } catch (err) { log(`[pool] onAbort 抛错：${err?.message ?? err}`); }
    if (r.task._lockToken && lock) { try { lock.release(r.task._lockToken, "pool-abort"); } catch {} }
    running.delete(key);
    onChange(status());
    return { ok: true, where: "running", id: key };
  }

  /** 急停：清队 + 不再接新单。**不杀在跑的** —— 那由 doStop 的 killActiveProcs 统一做，
   *  两处都杀会重复 taskkill，还会让"杀了几个"的计数对不上。 */
  function halt(reason) {
    halted = true;
    haltReason = String(reason || "急停");
    const dropped = queue.splice(0, queue.length).map((t) => t.id);
    onChange(status());
    return { ok: true, dropped };
  }

  function resume() {
    halted = false;
    haltReason = "";
    onChange(status());
    Promise.resolve().then(() => pump());
    return { ok: true };
  }

  function setMaxWorkers(n) {
    maxWorkers = Math.max(1, Math.min(Number(n) || 1, 8));
    onChange(status());
    Promise.resolve().then(() => pump());
    return { ok: true, maxWorkers };
  }

  function status() {
    return {
      halted, haltReason, maxWorkers,
      running: running.size,
      queued: queue.length,
      slots: [...running.entries()].map(([id, r]) => ({
        id, kind: r.task.kind, exclusive: r.task.exclusive,
        priority: r.task.priority, ms: now() - r.startedAt,
      })),
      queueHead: queue.slice(0, 5).map((t) => ({ id: t.id, kind: t.kind, priority: t.priority, waitedMs: now() - t.enqueuedAt })),
      // 给面板的判据：满载且排队久 = 该考虑加槽了（但先看成本账本）。
      saturated: queue.length > 0 && running.size >= maxWorkers,
    };
  }

  return { submit, pump, abort, halt, resume, setMaxWorkers, status,
    get maxWorkers() { return maxWorkers; }, get halted() { return halted; } };
}
