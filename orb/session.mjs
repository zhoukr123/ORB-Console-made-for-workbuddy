/* 会话生命周期：起止 / lastActive / 跨午夜归结束日 / stop 冻结只读快照。
 * 状态一律在内存维护；本模块不创建任何磁盘目录 —— 目录的唯一实现是
 * desktop/artifactLayout.cjs 的 ensureDay()（桥启动时调用，建 <root>/<kind>/<day>、
 * <root>/logs/<day>、<root>/governance/<day>）。
 * 历史坑：这里曾经 mkdirSync(path.join(root, day))，在存储根下留下
 * <root>/<YYYY-MM-DD>/ 空壳（用户明确要求以后不再出现）。已删除，不得恢复。
 * 严禁合并连续 click/wait/type：本模块只管会话边界，不提供任何批量 GUI 动作合并能力，
 * 以免吃掉危险确认中断点 / 破坏急停响应粒度 / 模糊回滚边界。 */
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;   // 固定 UTC+8，不依赖宿主 TZ
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/* 按 ts 的上海本地日算 YYYY-MM-DD；finalize 只认结束时刻，故跨午夜全归结束那天。 */
function dayTag(ts, fallback) {
  const t = Number(ts);
  const base = Number.isFinite(t) ? t : Number(fallback) || 0;
  let d;
  try { d = new Date(base + SHANGHAI_OFFSET_MS); } catch { d = new Date(SHANGHAI_OFFSET_MS); }
  if (isNaN(d.getTime())) d = new Date(SHANGHAI_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

export function createSessionManager(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  /* o.root 仅为兼容既有调用方（bridge.mjs 仍传 root: ARTIFACTS_DIR）保留，
     本模块不再据此创建任何目录；目录一律由 artifactLayout.ensureDay() 负责。 */
  const idleMs = num(o.idleMs, DEFAULT_IDLE_MS);
  const onFinalize = typeof o.onFinalize === "function" ? o.onFinalize : null;

  let active = null;          // 当前会话对象
  let seq = 0;                // 单调递增，保证 id 无路径分隔符且唯一
  let totalFinalized = 0;
  let interruptedCount = 0;

  const safeId = (v) => String(v ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);

  function snapshot(s) {
    return {
      conversationId: s.conversationId,
      startedAt: s.startedAt,
      epoch: s.epoch,
      lastActiveAt: s.lastActiveAt,
      meta: { ...(s.meta || {}) },
      interrupted: s.interrupted,
      frozen: s.frozen,
    };
  }

  function start(meta) {
    const t = now();
    const m = meta && typeof meta === "object" ? { ...meta } : {};
    seq++;
    const conversationId = safeId(`c-${t}-${seq}`) || `c-${seq}`;
    active = {
      conversationId,
      startedAt: t,
      epoch: seq,
      lastActiveAt: t,
      meta: m,
      interrupted: false,
      frozen: false,
    };
    return { conversationId, startedAt: t, epoch: seq };
  }

  function current() {
    return active ? snapshot(active) : null;
  }

  function touch() {
    if (!active) return { ok: false, reason: "no-active-session" };
    active.lastActiveAt = now();
    return { ok: true, lastActiveAt: active.lastActiveAt };
  }

  function finalize(reason) {
    if (!active) return { ok: false, reason: "no-active-session" };
    const s = active;
    const r = String(reason ?? "explicit");
    const t = now();
    const day = dayTag(t, t);
    const interrupted = r === "stop" || s.interrupted === true;
    const frozen = interrupted;            // stop / interrupted → 只读快照
    const dir = `${day}/${s.conversationId}`;   // 相对路径，不含盘符

    const record = {
      conversationId: s.conversationId,
      sessionEndAt: t,
      day,
      dir,
      interrupted,
      frozen,
      epoch: s.epoch,
      reason: r,
      startedAt: s.startedAt,
      meta: { ...(s.meta || {}) },
    };
    totalFinalized++;
    if (interrupted) interruptedCount++;
    active = null;
    if (onFinalize) {
      try { onFinalize({ ...record }); } catch { /* 回调失败不影响主流程 */ }
    }
    return {
      ok: true,
      conversationId: s.conversationId,
      sessionEndAt: t,
      day,
      dir,
      interrupted,
    };
  }

  function startNew(meta) {
    finalize("new-session");  // 无活动会话时返回 no-active，忽略即可
    return start(meta);
  }

  function dayOf(ts) {
    return dayTag(ts, now());
  }

  function idleCheck() {
    if (!active) return { ok: false, reason: "not-idle" };
    const t = now();
    if (t - active.lastActiveAt >= idleMs) return finalize("idle");
    return { ok: false, reason: "not-idle" };
  }

  function stats() {
    return {
      active: active !== null,
      totalFinalized,
      interrupted: interruptedCount,
    };
  }

  return { start, current, touch, finalize, startNew, dayOf, idleCheck, stats };
}
