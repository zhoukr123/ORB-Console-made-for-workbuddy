/**
 * 能力时钟：给「一次副作用」签发 capability，执行前后校验是否仍属当代。
 *
 * 关键约束：世代号**不在本模块里另存一份**。历史上 STOP.epoch 与
 * ticketStore.epoch 各数各的，导致所有跨代比较失效；这里一律通过
 * epochOf() 读唯一来源（bridge 传 () => STOP.epoch）。
 */
export function createEpochClock(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const epochOf = typeof opts.epochOf === "function" ? opts.epochOf : () => 0;
  const issued = new Map();
  const retired = new Set();
  let seq = 0;
  let rejected = 0;

  function current() { return Number(epochOf() || 0); }

  function issue(scope = "generic") {
    const id = `cap-${++seq}-${now()}`;
    const token = { id, epoch: current(), scope, issuedAt: now() };
    issued.set(id, token);
    return token;
  }

  function isCurrent(token) {
    if (!token || typeof token !== "object" || !token.id) return false;
    if (retired.has(token.id)) return false;
    if (Number(token.epoch) !== current()) return false;
    return issued.get(token.id) === token;
  }

  function retire(token, reason = "") {
    if (!token || !token.id) return false;
    retired.add(token.id);
    issued.delete(token.id);
    return true;
  }

  /** 执行前后各校验一次；执行期间急停则「结果不采纳」。 */
  async function guard(token, fn) {
    if (!isCurrent(token)) {
      rejected++;
      return { ok: false, stale: true, error: "能力已过期（epoch 已前进或被撤销）" };
    }
    let value;
    try {
      value = await fn();
    } catch (e) {
      // 执行体自身报错交给调用方，不算过期。
      throw e;
    }
    if (!isCurrent(token)) {
      rejected++;
      return { ok: false, stale: true, error: "执行期间急停，结果不采纳" };
    }
    return { ok: true, value };
  }

  /** 急停后调用：把旧代签发的 capability 一次性清掉。 */
  function onEpochAdvanced() {
    const cur = current();
    let dropped = 0;
    for (const [id, t] of issued) {
      if (Number(t.epoch) !== cur) { issued.delete(id); dropped++; }
    }
    return dropped;
  }

  function stats() {
    return { epoch: current(), issued: issued.size, retired: retired.size, rejected };
  }

  return { current, issue, isCurrent, retire, guard, onEpochAdvanced, stats };
}
