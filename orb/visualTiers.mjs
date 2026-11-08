/* 视觉档位选择 + 可取消预读 + 双路健康预探测。
 * 严禁合并连续 click/wait/type：合并会吃掉危险确认中断点、破坏急停响应粒度、模糊回滚边界——
 * 因此本模块只导出「档位 / 预读 / 探测」纯机制，绝不导出任何批量执行 GUI 动作的函数，
 * 也不提供把 click/wait/type 合并成一步的能力；每次点击/等待/输入都必须独立可中断。 */
export const TIERS = Object.freeze({ fast: 8, normal: 12, deep: 20 });

export const NO_BATCH_ACTIONS =
  "禁止合并连续 click/wait/type：合并会吃掉危险确认中断点、破坏急停响应粒度、模糊回滚边界；" +
  "本模块不导出任何批量执行 GUI 动作的函数，也不提供该能力。";

const RECOVERABLE = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAGAIN", "EPIPE",
  "ENOTFOUND", "EAI_AGAIN", "ETIME", "EHOSTUNREACH", "ENETUNREACH",
]);
const HEAVY_KINDS = new Set(["deep", "audit", "verify", "inspect", "complex", "research", "full", "vision"]);
const LIGHT_KINDS = new Set(["fast", "quick", "simple", "chat", "lookup", "ping"]);

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function isRecoverable(e) {
  if (!e) return false;
  if (e.fatal === true || e.recoverable === false) return false;
  if (e.recoverable === true) return true;
  if (typeof e.code === "string" && RECOVERABLE.has(e.code)) return true;
  return true;   // 默认按可恢复处理，但只降级一次
}

export function createVisualTiers(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  const probe = typeof o.probe === "function" ? o.probe : null;
  const ttlMs = num(o.ttlMs, 30000);
  const epochFn = typeof o.epoch === "function" ? o.epoch : () => 0;
  /* 换档回调（2026-11-05 新增）：本模块不自己记账，只把"换了"这件事交出去。
   * 为什么不在这里存历史：换档的账要跟路由/模式放在同一本里才能对着看
   * （见 upgrade.mjs），各存一份又会出现"两边数字对不上"。 */
  const onTrans = typeof o.onTransition === "function" ? o.onTransition : null;

  let epochOverride = null;
  const cache = new Map();       // kind -> { value, expiresAt, epoch, cancelled }
  const cancelled = new Set();   // 一次性取消标记
  const lastTier = new Map();    // kind -> 上一次选中的档位（用于识别"换档"）
  let picks = 0, preloads = 0, hits = 0, misses = 0, expired = 0, cancelledCount = 0;

  function curEpoch() {
    return epochOverride !== null ? epochOverride : epochFn();
  }

  /* 延迟越高越需要更深的视觉档以保证一次做对；复杂任务至少 deep，轻量任务 fast。 */
  function pick(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    picks++;
    const t = num(a.ttftP95, num(a.ttftP50, 0));
    let tier = t <= 1000 ? "fast" : t <= 3000 ? "normal" : "deep";
    const kind = String(a.taskKind ?? "").toLowerCase();
    let cause = t > 3000 ? "ttft-high" : (t <= 1000 ? "ttft-low" : "ttft-mid");
    if (HEAVY_KINDS.has(kind)) { tier = "deep"; cause = "task-heavy"; }
    else if (LIGHT_KINDS.has(kind)) { tier = "fast"; cause = "task-light"; }

    /* 只有"换了档"才上报。每选一次都上报会把账本淹掉 ——
     * 而换档才是要解释的那件事。按 kind 分开记，是因为 fast/quick 与 vision 的
     * 上一次档位本来就不该相同，按全局记会天天报"换档"。 */
    const bucket = kind || "*";
    const prev = lastTier.get(bucket);
    if (onTrans && prev && prev !== tier) {
      try {
        onTrans({ ladder: "visual", from: prev, to: tier, cause, epoch: curEpoch(), kind: bucket });
      } catch { /* 上报失败不能影响选档本身 */ }
    }
    lastTier.set(bucket, tier);
    return tier;
  }

  /* 纯读预加载：ttlMs 失效、epoch 失效、可一次性取消；read 必须是函数。 */
  function preload(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const kind = String(a.kind ?? "default");
    const read = a.read;
    preloads++;
    if (typeof read !== "function") {
      return { ok: false, value: null, expiresAt: 0, cancelled: false, reason: "bad-read" };
    }
    const e = a.epoch != null ? a.epoch : curEpoch();
    if (cancelled.has(kind)) {
      cancelled.delete(kind);
      cancelledCount++;
      return { ok: false, value: null, expiresAt: 0, cancelled: true };
    }
    const hit = cache.get(kind);
    if (hit && !hit.cancelled) {
      if (now() < hit.expiresAt && hit.epoch === e) {
        hits++;
        return { ok: true, value: hit.value, expiresAt: hit.expiresAt, cancelled: false };
      }
      if (now() >= hit.expiresAt) expired++;
      cache.delete(kind);
      misses++;
    } else {
      misses++;
    }
    let value;
    try { value = read(); }
    catch (err) {
      return { ok: false, value: null, expiresAt: 0, cancelled: false, reason: String(err?.message || err) };
    }
    const expiresAt = now() + ttlMs;
    cache.set(kind, { value, expiresAt, epoch: e, cancelled: false });
    return { ok: true, value, expiresAt, cancelled: false };
  }

  /* 清某档缓存并置一次性取消标记；下一次同档 preload 返回 cancelled:true。 */
  function cancel(kind) {
    const k = String(kind ?? "default");
    cache.delete(k);
    cancelled.add(k);
    return { ok: true, kind: k };
  }

  /* 清全量缓存；带 epoch 时同时切换当前纪元，使旧纪元缓存失效。 */
  function invalidate(epoch) {
    const cleared = cache.size;
    cache.clear();
    cancelled.clear();
    if (epoch !== undefined && epoch !== null) epochOverride = epoch;
    return { ok: true, cleared };
  }

  /* 双路健康预探测：主路失败且为可恢复错误时，仅降级到备路一次。 */
  function healthProbe(primary, backup) {
    const pfn = typeof primary === "function" ? primary : probe;
    const bfn = typeof backup === "function" ? backup : probe;
    const call = (fn) => {
      if (typeof fn !== "function") return { ok: false, recoverable: false };
      try {
        const r = fn();
        if (r === false || (r && typeof r === "object" && r.ok === false)) {
          return { ok: false, recoverable: true };
        }
        return { ok: true, value: r };
      } catch (e) {
        return { ok: false, recoverable: isRecoverable(e) };
      }
    };
    const p = call(pfn);
    if (p.ok) return { ok: true, via: "primary", degraded: false };
    if (!p.recoverable) return { ok: false, via: "none", degraded: false };
    if (onTrans) {
      /* 主路失败→备路：这就是一次真实的降级，必须记下来。
       * cause 用具体错误码而不是"failed"，否则三个月后只看到"降过级"却不知道为什么。 */
      try { onTrans({ ladder: "channel", from: "primary", to: "backup", cause: "primary-failed", epoch: curEpoch(), kind: "health" }); } catch {}
    }
    const b = call(bfn);
    if (b.ok) return { ok: true, via: "backup", degraded: true };
    return { ok: false, via: "none", degraded: true };
  }

  function stats() {
    return { picks, preloads, hits, misses, expired, cancelled: cancelledCount };
  }

  return { pick, preload, cancel, invalidate, healthProbe, stats };
}
