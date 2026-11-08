/* visualTiers 单测：常量 / 无批量 GUI 导出 / 三档 pick / epoch 失效与取消 /
 * ttl 失效 / 双路健康预探测降级一次 / stats。 */
import test from "node:test";
import assert from "node:assert/strict";
import { TIERS, NO_BATCH_ACTIONS, createVisualTiers } from "../visualTiers.mjs";

test("常量：TIERS 三档与 NO_BATCH_ACTIONS 明确禁止合并", () => {
  assert.deepEqual(TIERS, { fast: 8, normal: 12, deep: 20 });
  assert.equal(typeof NO_BATCH_ACTIONS, "string");
  assert.match(NO_BATCH_ACTIONS, /click/);
  assert.match(NO_BATCH_ACTIONS, /wait/);
  assert.match(NO_BATCH_ACTIONS, /type/);
  assert.match(NO_BATCH_ACTIONS, /禁止合并|不合并/);
  assert.match(NO_BATCH_ACTIONS, /危险确认|急停|回滚/);
});

test("断言模块没有批量 GUI 动作导出：唯一函数导出是 createVisualTiers", async () => {
  const mod = await import("../visualTiers.mjs");
  const names = Object.keys(mod).sort();
  assert.deepEqual(names, ["NO_BATCH_ACTIONS", "TIERS", "createVisualTiers"].sort());
  const fns = names.filter((n) => typeof mod[n] === "function");
  assert.deepEqual(fns, ["createVisualTiers"], "不得导出批量执行 click/wait/type 的函数");
});

test("pick：按 ttftP95 三档 + taskKind 强制 deep/fast", () => {
  const vt = createVisualTiers({ now: () => 1000 });
  assert.equal(vt.pick({ ttftP95: 500, taskKind: "normal" }), "fast");
  assert.equal(vt.pick({ ttftP95: 2000 }), "normal");
  assert.equal(vt.pick({ ttftP95: 5000 }), "deep");
  assert.equal(vt.pick({ ttftP95: 100, taskKind: "complex" }), "deep");
  assert.equal(vt.pick({ ttftP95: 9000, taskKind: "quick" }), "fast");
  assert.equal(vt.pick({ ttftP50: 800 }), "fast");
  assert.equal(vt.stats().picks, 6);
});

test("preload：纯读缓存命中 / ttl 失效重读 / read 必须是函数", () => {
  let T = 1000;
  const vt = createVisualTiers({ now: () => T, ttlMs: 100, epoch: () => 0 });
  let calls = 0;
  const read = () => ++calls;
  const p1 = vt.preload({ kind: "a", read });
  assert.equal(p1.ok, true);
  assert.equal(p1.value, 1);
  assert.equal(p1.expiresAt, 1100);
  assert.equal(p1.cancelled, false);
  const p2 = vt.preload({ kind: "a", read });
  assert.equal(p2.ok, true);
  assert.equal(p2.value, 1, "命中缓存不重读");
  assert.equal(calls, 1);
  T = 1200;   // 过 ttl
  const p3 = vt.preload({ kind: "a", read });
  assert.equal(p3.ok, true);
  assert.equal(p3.value, 2, "ttl 失效后重读");
  assert.equal(calls, 2);
  assert.equal(vt.stats().hits, 1);
  assert.equal(vt.stats().expired, 1);
  const bad = vt.preload({ kind: "b", read: "not-a-fn" });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "bad-read");
});

test("epoch 失效：显式 epoch 变化与 opts.epoch() 变化均使缓存失效", () => {
  let T = 1000;
  let E = 0;
  const vt = createVisualTiers({ now: () => T, ttlMs: 1000, epoch: () => E });
  let calls = 0;
  const read = () => ++calls;
  vt.preload({ kind: "k", read, epoch: 1 });       // miss
  vt.preload({ kind: "k", read, epoch: 1 });       // hit
  const p = vt.preload({ kind: "k", read, epoch: 2 }); // epoch 不同 → miss
  assert.equal(p.value, 2);
  assert.equal(calls, 2);
  E = 1;                                            // opts.epoch() 变化
  vt.preload({ kind: "z", read });                  // 新 kind
  const before = calls;
  E = 2;
  vt.preload({ kind: "z", read });                  // 当前 epoch 变 → 失效重读
  assert.equal(calls, before + 1);
});

test("cancel 一次性取消 + invalidate 清缓存", () => {
  let T = 1000;
  const vt = createVisualTiers({ now: () => T, ttlMs: 1000 });
  let calls = 0;
  const read = () => ++calls;
  vt.preload({ kind: "k", read });
  assert.equal(vt.cancel("k").ok, true);
  const p = vt.preload({ kind: "k", read });
  assert.equal(p.ok, false);
  assert.equal(p.cancelled, true);
  assert.equal(calls, 1, "取消不触发 read");
  const p2 = vt.preload({ kind: "k", read });
  assert.equal(p2.ok, true, "一次性取消后重新可读");
  assert.equal(p2.value, 2);
  assert.ok(vt.stats().cancelled >= 1);

  const inv = vt.invalidate(7);
  assert.equal(inv.ok, true);
  assert.ok(inv.cleared >= 1);
  vt.preload({ kind: "k", read });   // 缓存被清 → 重读
  assert.equal(calls, 3);
});

test("healthProbe：主路成功 / 可恢复错误降级备路一次 / 双失败 / 致命错误不降级", () => {
  const vt = createVisualTiers({ now: () => 1000 });
  assert.deepEqual(vt.healthProbe(() => true, () => false), { ok: true, via: "primary", degraded: false });
  const recErr = Object.assign(new Error("reset"), { code: "ECONNRESET" });
  assert.deepEqual(vt.healthProbe(() => { throw recErr; }, () => true), { ok: true, via: "backup", degraded: true });
  assert.deepEqual(vt.healthProbe(() => false, () => false), { ok: false, via: "none", degraded: true });
  const fatal = Object.assign(new Error("fatal"), { fatal: true });
  assert.deepEqual(vt.healthProbe(() => { throw fatal; }, () => true), { ok: false, via: "none", degraded: false });
  // probe 作为缺省探测器兜底
  const withProbe = createVisualTiers({ now: () => 1000, probe: () => true });
  assert.deepEqual(withProbe.healthProbe(null, null), { ok: true, via: "primary", degraded: false });
});

test("stats 返回固定六键", () => {
  const vt = createVisualTiers({ now: () => 1000 });
  vt.pick({ ttftP95: 1 });
  vt.preload({ kind: "k", read: () => 1 });
  assert.deepEqual(Object.keys(vt.stats()).sort(),
    ["picks", "preloads", "hits", "misses", "expired", "cancelled"].sort());
});
