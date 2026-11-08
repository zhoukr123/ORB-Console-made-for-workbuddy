/**
 * 命令通道准入闸门（纯逻辑，便于单测；bridge 直接调用）。
 * 补的是方案 §7「可终止」的缺口：/api/cmd、/api/act、takeover 短路
 * 原先都没有急停检查，能绕过 callToolRaw 里那个唯一的检查点。
 */
import { createEpochClock } from "./epoch.mjs";

export function createCommandGate(opts = {}) {
  const isStopped = typeof opts.isStopped === "function" ? opts.isStopped : () => false;
  const epochOf = typeof opts.epochOf === "function" ? opts.epochOf : () => 0;
  const clock = opts.clock || createEpochClock({ epochOf });
  let admitted = 0;
  let denied = 0;
  let staleAfter = 0;

  /** 入口检查：急停一律 409 且不签发 capability。 */
  function check(body = {}) {
    if (isStopped()) {
      denied++;
      return {
        ok: false,
        httpStatus: 409,
        body: {
          ok: false, stopped: true, epoch: epochOf(),
          error: `已被急停（第 ${epochOf()} 代），命令通道不再新建操作`,
        },
      };
    }
    const cap = clock.issue("command-channel");
    admitted++;
    return { ok: true, cap, epoch: epochOf() };
  }

  /** 执行前后复核：执行期间换代则结果不采纳。 */
  function verify(cap) {
    const ok = clock.isCurrent(cap);
    if (!ok) staleAfter++;
    return ok;
  }

  function onEpochAdvanced() { return clock.onEpochAdvanced(); }
  function stats() { return { admitted, denied, staleAfter, clock: clock.stats() }; }

  return { check, verify, onEpochAdvanced, stats, clock };
}
