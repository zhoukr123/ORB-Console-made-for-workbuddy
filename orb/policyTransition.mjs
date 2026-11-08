/* 策略换代纯逻辑状态机：先投递收敛通知，待在途 ticket 完成 checkpoint 或干净回滚并静默后再提交换代；自维护 policyEpoch，与带外急停完全正交，全程不触发即时终止动作。
 * 纯逻辑模块：不依赖任何 ORB 运行时、不读写全局状态；所有公开返回均为深拷贝快照，stopLike 恒为 false。 */

export const POLICY_CHANGE_KINDS = Object.freeze({
  RULE: "rule",
  CAPABILITY: "capability",
  ROSTER: "roster",
  PROMPT: "prompt",
});

export const POLICY_PHASES = Object.freeze({
  PROPOSED: "proposed",
  DRAINING: "draining",
  CHECKPOINTED: "checkpointed",
  COMMITTED: "committed",
  ROLLED_BACK: "rolled_back",
  REJECTED: "rejected",
});

export const POLICY_ERRORS = Object.freeze({
  INVALID_ID: "invalid-id",
  INVALID_KIND: "invalid-kind",
  INVALID_TICKETS: "invalid-tickets",
  DUPLICATE_ID: "duplicate-id",
  ACTIVE_CHANGE_IN_FLIGHT: "active-change-in-flight",
  NO_ACTIVE_CHANGE: "no-active-change",
  UNKNOWN_TICKET: "unknown-ticket",
  BAD_OUTCOME: "bad-outcome",
  TICKETS_STILL_ACTIVE: "tickets-still-active",
});

// 收敛对象里禁止出现的字段名片段（统一小写比较）：覆盖 epoch 家族、kill、abort 及各类 stop 字段。
const FORBIDDEN_FRAGMENTS = Object.freeze(["epoch", "kill", "abort", "stop"]);

function deepCopy(value) {
  if (Array.isArray(value)) return value.map(deepCopy);
  if (value && typeof value === "object") {
    if (value instanceof Date) return new Date(value.getTime());
    const out = {};
    for (const key of Object.keys(value)) out[key] = deepCopy(value[key]);
    return out;
  }
  return value;
}

function buildNotices(change) {
  const src = change && typeof change === "object" ? change : {};
  const tickets = Array.isArray(src.tickets) ? src.tickets : [];
  const changeId = typeof src.id === "string" ? src.id : null;
  return tickets.map((ticketId) => ({
    ticketId,
    type: "policy-change-notice",
    changeId,
    ask: "checkpoint",
  }));
}

export function assertSeparateFromStop(change) {
  const bad = [];
  if (change && typeof change === "object") {
    for (const key of Object.keys(change)) {
      const lower = key.toLowerCase();
      if (FORBIDDEN_FRAGMENTS.some((frag) => lower.includes(frag))) bad.push(key);
    }
  }
  return { ok: bad.length === 0, bad: bad.slice() };
}

export function drainPlan(change) {
  const src = change && typeof change === "object" ? change : {};
  const changeId = typeof src.id === "string" ? src.id : null;
  return { changeId, notices: buildNotices(src), allowHardStop: false };
}

export function createPolicyTransition(opts = {}) {
  const options = opts && typeof opts === "object" ? opts : {};
  const { now = Date.now, notify = null, onCheckpoint = null, onRollback = null } = options;

  let policyEpoch = 0;
  let active = null;
  let draining = [];
  let pending = [];
  let history = [];
  const seenIds = new Set();
  const snapshots = new Map();
  const outcomes = new Map();

  let proposed = 0;
  let committed = 0;
  let rolledBack = 0;
  let rejected = 0;
  let checkpointsCount = 0;

  const stamp = () => (typeof now === "function" ? now() : Date.now());
  const readyToCommit = () => active !== null && draining.length === 0;

  function failure(code, extra) {
    const out = { ok: false, code };
    if (extra && typeof extra === "object") {
      for (const key of Object.keys(extra)) out[key] = deepCopy(extra[key]);
    }
    return out;
  }

  function pushHistory(recordPhase, extra) {
    const rec = {
      changeId: active ? active.id : null,
      kind: active ? active.kind : null,
      phase: recordPhase,
      policyEpoch,
      tickets: active && Array.isArray(active.tickets) ? active.tickets.slice() : [],
      snapshots: deepCopy(Object.fromEntries(snapshots)),
      outcomes: deepCopy(Object.fromEntries(outcomes)),
      at: stamp(),
    };
    if (extra && typeof extra === "object") {
      for (const key of Object.keys(extra)) rec[key] = deepCopy(extra[key]);
    }
    history.push(rec);
  }

  function clearActive() {
    active = null;
    draining = [];
    pending = [];
    snapshots.clear();
    outcomes.clear();
  }

  return {
    state() {
      return {
        policyEpoch,
        active: deepCopy(active),
        pending: pending.slice(),
        draining: draining.slice(),
        history: deepCopy(history),
      };
    },

    propose(change = {}) {
      const src = change && typeof change === "object" ? change : {};
      if (typeof src.id !== "string" || src.id.trim() === "") return failure(POLICY_ERRORS.INVALID_ID);
      if (!Object.values(POLICY_CHANGE_KINDS).includes(src.kind)) return failure(POLICY_ERRORS.INVALID_KIND);
      if (!Array.isArray(src.tickets)) return failure(POLICY_ERRORS.INVALID_TICKETS);
      if (seenIds.has(src.id)) return failure(POLICY_ERRORS.DUPLICATE_ID);
      if (active !== null) return failure(POLICY_ERRORS.ACTIVE_CHANGE_IN_FLIGHT);

      const stored = deepCopy(src);
      active = stored;
      draining = Array.isArray(stored.tickets) ? stored.tickets.slice() : [];
      pending = Array.isArray(stored.tickets) ? stored.tickets.slice() : [];
      seenIds.add(stored.id);
      proposed += 1;

      const notifications = buildNotices(stored);
      if (typeof notify === "function") notify(deepCopy(notifications));

      return {
        ok: true,
        change: deepCopy(active),
        phase: POLICY_PHASES.PROPOSED,
        notifications,
        stopLike: false,
      };
    },

    checkpoint(ticketId, snapshot = null) {
      if (active === null) return failure(POLICY_ERRORS.NO_ACTIVE_CHANGE);
      const tickets = Array.isArray(active.tickets) ? active.tickets : [];
      if (!tickets.includes(ticketId)) return failure(POLICY_ERRORS.UNKNOWN_TICKET);
      if (pending.includes(ticketId)) {
        pending = pending.filter((t) => t !== ticketId);
        checkpointsCount += 1;
      }
      snapshots.set(ticketId, deepCopy(snapshot));
      if (typeof onCheckpoint === "function") onCheckpoint(ticketId, deepCopy(snapshot));
      return { ok: true, ticketId, phase: POLICY_PHASES.CHECKPOINTED, remaining: draining.slice() };
    },

    quiesce(ticketId, outcome = "clean") {
      if (outcome !== "clean" && outcome !== "rolled-back") return failure(POLICY_ERRORS.BAD_OUTCOME);
      if (active === null) return failure(POLICY_ERRORS.NO_ACTIVE_CHANGE);
      if (!draining.includes(ticketId)) return failure(POLICY_ERRORS.UNKNOWN_TICKET);
      draining = draining.filter((t) => t !== ticketId);
      pending = pending.filter((t) => t !== ticketId);
      outcomes.set(ticketId, outcome);
      return { ok: true, ticketId, remaining: draining.slice(), readyToCommit: readyToCommit() };
    },

    commit() {
      if (active === null) return failure(POLICY_ERRORS.NO_ACTIVE_CHANGE);
      if (draining.length > 0) return failure(POLICY_ERRORS.TICKETS_STILL_ACTIVE, { remaining: draining.slice() });
      policyEpoch += 1;
      committed += 1;
      pushHistory(POLICY_PHASES.COMMITTED);
      clearActive();
      return { ok: true, policyEpoch, phase: POLICY_PHASES.COMMITTED, stopLike: false };
    },

    rollback(reason = "") {
      if (active === null) return failure(POLICY_ERRORS.NO_ACTIVE_CHANGE);
      if (typeof onRollback === "function") onRollback(reason);
      rolledBack += 1;
      pushHistory(POLICY_PHASES.ROLLED_BACK, { reason });
      clearActive();
      return { ok: true, phase: POLICY_PHASES.ROLLED_BACK, reason, policyEpoch };
    },

    reject(reason = "") {
      if (active === null) return failure(POLICY_ERRORS.NO_ACTIVE_CHANGE);
      rejected += 1;
      pushHistory(POLICY_PHASES.REJECTED, { reason });
      clearActive();
      return { ok: true, phase: POLICY_PHASES.REJECTED, reason, policyEpoch };
    },

    isStopLike() {
      return false;
    },

    stats() {
      return {
        policyEpoch,
        proposed,
        committed,
        rolledBack,
        rejected,
        checkpoints: checkpointsCount,
        active: active !== null,
      };
    },
  };
}
