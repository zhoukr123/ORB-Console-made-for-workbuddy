/* ---------------- GUI 独占锁（guiLock） ----------------
 *
 * 桌面 Agent 与"改代码的 Agent"最根本的差别：鼠标、键盘、剪贴板、前台窗口、
 * 输入法、DPI 缩放，全是**全局单例且不可撤销**。两个 Worker 同时点击不是"变慢"，
 * 是互相把对方的窗口切走 —— 一次误点落在"删除"按钮上就没有回滚。
 *
 * 所以这里刻意**不做通用仲裁器**（谁先谁后、优先级、公平队列、优雅交接），
 * 只做一把带租约的独占锁。理由：
 *   · 通用仲裁器要处理"用户自己动了鼠标怎么办""持有者崩了怎么回收"
 *     "两个 Worker 交替抢焦点" —— 每一条都是长尾，而参考实现为零
 *     （SuperAgent 原型的 Worker 各在独立目录改代码，没有 GUI 概念）。
 *   · 桌面端真正需要的只有一句话：**同一时刻只允许一个东西动键鼠，动完立刻交还。**
 *
 * 三条约束：
 *   ① **租约（lease）**：锁会自己过期。持有者崩溃/卡死时不需要任何人来回收，
 *      到期自动失效 —— 这比"检测心跳"简单得多，也可靠得多。
 *   ② **不可跨步持有**：ttl 默认 20 秒，上限 120 秒。禁止"整段任务一直握着锁"。
 *   ③ **用户物理输入无条件让路**：yieldByUser() 一调，当前锁立刻作废。
 *      这是桌面端特有的边界：屏幕的主人是用户，不是 Agent。
 */

const DEFAULT_TTL_MS = 20000;
const DEFAULT_MAX_HOLD_MS = 120000;

let seq = 0;

export function createGuiLock(opts = {}) {
  const now = opts.now || Date.now;
  const defaultTtlMs = opts.defaultTtlMs ?? DEFAULT_TTL_MS;
  const maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  const log = opts.log || (() => {});
  const onChange = opts.onChange || (() => {});

  /** 当前持有者。null = 空闲。 */
  let holder = null;
  /** 全局急停世代：锁必须绑定它，急停后旧锁自动失效。 */
  let epoch = Number(opts.epoch) || 0;

  const stats = { acquires: 0, denied: 0, renews: 0, releases: 0, expiries: 0, yields: 0, forced: 0 };

  function expireIfNeeded(quiet = false) {
    if (!holder) return false;
    if (now() <= holder.expiresAt) return false;
    const h = holder;
    holder = null;
    stats.expiries++;
    if (!quiet) log(`[gui] 租约到期自动释放：owner=${h.owner}`);
    onChange(status());
    return true;
  }

  function status() {
    expireIfNeeded(true);
    return {
      locked: !!holder,
      epoch,
      holder: holder ? {
        owner: holder.owner, token: holder.token, since: holder.since,
        expiresAt: holder.expiresAt, holdMs: now() - holder.since, meta: holder.meta,
      } : null,
      stats: { ...stats },
    };
  }

  /**
   * 申请锁。
   * @returns {{ok:true, token:string, expiresAt:number, epoch:number}}
   *        | {{ok:false, code:'busy'|'stale-epoch'|'bad-ttl', holder?:object}}
   */
  function acquire(o = {}) {
    expireIfNeeded();

    // 急停后旧世代的申请一律拒：否则"停"只是停住了循环，锁还会被旧任务拿到。
    const reqEpoch = o.epoch == null ? epoch : Number(o.epoch);
    if (reqEpoch < epoch) {
      stats.denied++;
      return { ok: false, code: "stale-epoch", epoch, want: reqEpoch };
    }

    if (holder) {
      // 同一 owner 重入：续租而不是排队。视觉循环每一步都会重新拿锁，
      // 如果重入算冲突，它自己就会把自己卡住。
      if (holder.owner === String(o.owner)) {
        return renew(holder.token, o.ttlMs);
      }
      stats.denied++;
      return { ok: false, code: "busy", holder: { owner: holder.owner, expiresAt: holder.expiresAt, holdMs: now() - holder.since } };
    }

    const ttl = Math.min(Math.max(Number(o.ttlMs) || defaultTtlMs, 500), maxHoldMs);
    const t = now();
    holder = {
      token: `g${++seq}-${Math.random().toString(36).slice(2, 8)}`,
      owner: String(o.owner || "anonymous"),
      since: t,
      expiresAt: t + ttl,
      ttl,
      epoch,
      meta: o.meta && typeof o.meta === "object" ? { ...o.meta } : {},
      renews: 0,
    };
    stats.acquires++;
    onChange(status());
    return { ok: true, token: holder.token, expiresAt: holder.expiresAt, epoch };
  }

  /** 续租。总持有时间超过 maxHoldMs 就拒绝 —— 这是"不可跨步持有"的硬闸。 */
  function renew(token, ttlMs) {
    if (!holder || holder.token !== token) return { ok: false, code: "not-holder" };
    const t = now();
    if (t - holder.since > maxHoldMs) {
      const h = holder;
      holder = null;
      stats.expiries++;
      onChange(status());
      log(`[gui] 持有超时强制释放：owner=${h.owner} holdMs=${t - h.since}`);
      return { ok: false, code: "max-hold-exceeded", holder: { owner: h.owner, holdMs: t - h.since } };
    }
    holder.ttl = Math.min(Math.max(Number(ttlMs) || holder.ttl || defaultTtlMs, 500), maxHoldMs);
    holder.expiresAt = t + holder.ttl;
    holder.renews++;
    stats.renews++;
    return { ok: true, token, expiresAt: holder.expiresAt, renews: holder.renews };
  }

  /** 交还。reason 会进日志/审计，便于回答"这次为什么被放掉"。 */
  function release(token, reason) {
    if (!holder) return { ok: false, code: "idle" };
    if (token && holder.token !== token) return { ok: false, code: "not-holder" };
    const h = holder;
    holder = null;
    stats.releases++;
    onChange(status());
    return { ok: true, released: { owner: h.owner, holdMs: now() - h.since, reason: reason || "" } };
  }

  /**
   * 用户物理输入触发：无条件让路。
   * 注意它**不区分是谁触发的** —— 哪怕锁是当前视觉任务自己正在用的，
   * 只要检测到真人动了键鼠，就让。误让一次的代价是多等一拍；
   * 不让的代价是用户正在打字时被 Agent 抢走焦点。
   */
  function yieldByUser(reason) {
    if (!holder) return { ok: true, yielded: false };
    const h = holder;
    holder = null;
    stats.yields++;
    onChange(status());
    log(`[gui] 用户输入抢占，已让出：owner=${h.owner}（${reason || "user-input"}）`);
    return { ok: true, yielded: true, owner: h.owner };
  }

  /** 人工强制释放（面板按钮）。与 yield 的区别只在计数口径，行为一致。 */
  function forceRelease(reason) {
    if (!holder) return { ok: false, code: "idle" };
    const h = holder;
    holder = null;
    stats.forced++;
    onChange(status());
    return { ok: true, released: { owner: h.owner, reason: reason || "force" } };
  }

  /** 抬升世代：急停时调用，当前锁立即作废。 */
  function setEpoch(n) {
    epoch = Number(n) || epoch;
    if (holder && holder.epoch < epoch) {
      const h = holder;
      holder = null;
      onChange(status());
      return { ok: true, dropped: h.owner, epoch };
    }
    return { ok: true, dropped: null, epoch };
  }

  /**
   * 包一层"拿到锁才执行"。拿不到直接返回 null，不排队 ——
   * 视觉步骤宁可跳过也不要等（等 = 用户看着屏幕不动，比不做更糟）。
   */
  async function withLock(owner, fn, o = {}) {
    const got = acquire({ owner, ttlMs: o.ttlMs, epoch: o.epoch, meta: o.meta });
    if (!got.ok) return { ok: false, code: got.code, holder: got.holder };
    try {
      const value = await fn(got.token);
      return { ok: true, value };
    } finally {
      // 只放自己那把：如果期间被 yield/过期，token 已经对不上了，release 会返回 not-holder。
      release(got.token, o.reason || "done");
    }
  }

  return { acquire, renew, release, yieldByUser, forceRelease, setEpoch, status, withLock,
    get epoch() { return epoch; } };
}
