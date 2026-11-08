/* 语气三槽测试。这组守两件事：
 *   ① 判定优先级（人才是第一位，机器忙不忙是第二位）；
 *   ② 滞回（声音不能忽快忽慢），以及"暖"可以破例。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SLOTS, targetSlot, createPersonaSlots } from "../personaSlots.mjs";

test("targetSlot: 深夜优先于一切（哪怕连续成功 + Max）", () => {
  assert.equal(targetSlot({ hour: 2, doneStreak: 9, maxMode: true }).slot, "warm");
  assert.equal(targetSlot({ hour: 23, failStreak: 0 }).slot, "warm");
  assert.equal(targetSlot({ hour: 5 }).slot, "warm");
});

test("targetSlot: 连续失败 ≥2 → 暖；1 次还不至于", () => {
  assert.equal(targetSlot({ hour: 14, failStreak: 1 }).slot, "neutral");
  assert.equal(targetSlot({ hour: 14, failStreak: 2 }).slot, "warm");
});

test("targetSlot: 人没事时才看机器：急停 > 连续成功 > Max", () => {
  assert.equal(targetSlot({ hour: 14, stopped: true }).slot, "cool");
  assert.equal(targetSlot({ hour: 14, doneStreak: 3 }).slot, "cool");
  assert.equal(targetSlot({ hour: 14, maxMode: true }).slot, "cool");
  assert.equal(targetSlot({ hour: 14, doneStreak: 2, maxMode: true }).slot, "cool");
});

test("targetSlot: 都没有就是常态中档", () => {
  assert.equal(targetSlot({ hour: 14 }).slot, "neutral");
  assert.equal(targetSlot({}).slot, "neutral", "空入参不能崩，也不能瞎猜一个槽");
});

test("三个槽都有可用的语速/音高倍率（都别离 1 太远）", () => {
  for (const s of Object.values(SLOTS)) {
    assert.ok(s.rate > 0.9 && s.rate < 1.1, `${s.id} rate 偏离过大`);
    assert.ok(s.pitch > 0.9 && s.pitch < 1.1, `${s.id} pitch 偏离过大`);
    assert.ok(s.minHoldMs >= 30000, `${s.id} 最小保持时间太短，会抖`);
  }
});

test("滞回：刚换过槽就不许马上再换（避免忽快忽慢）", () => {
  let t = 0;
  const p = createPersonaSlots({ now: () => t });
  t = 100_000;
  const a = p.update({ hour: 2 });            // → warm（深夜）
  assert.equal(a.changed, true);
  assert.equal(a.slot, "warm");
  // 立刻转回常态 → 被按住（回暖容易、回常态要等）
  t = 110_000;
  const b = p.update({ hour: 14 });
  assert.equal(b.changed, false);
  assert.equal(b.slot, "warm");
  assert.equal(b.heldBy, "neutral");
});

test("暖可以破例：刚切到利落，用户立刻失败了，应当马上转暖", () => {
  let t = 0;
  const p = createPersonaSlots({ now: () => t });
  t = 100_000;
  p.update({ hour: 14, maxMode: true });     // → cool
  t = 110_000;
  const r = p.update({ hour: 14, failStreak: 3 });
  assert.equal(r.changed, true, "失败后的转暖不该被滞回挡住");
  assert.equal(r.slot, "warm");
  assert.match(r.reason, /连续失败/);
});

test("保持时间为 0 时可以连续换槽（滞回不是死锁）", () => {
  let t = 0;
  const p = createPersonaSlots({ now: () => t });
  t = 10 * 60_000;
  p.update({ hour: 14, stopped: true });
  t = 20 * 60_000;
  const r = p.update({ hour: 14 });
  assert.equal(r.changed, true);
  assert.equal(r.slot, "neutral");
});

test("stats 记下原因与次数，reset 能回到常态", () => {
  let t = 0;
  const p = createPersonaSlots({ now: () => t });
  t = 100_000;
  p.update({ hour: 2 });
  const s = p.stats();
  assert.equal(s.slot, "warm");
  assert.equal(s.flips, 1);
  assert.match(s.reason, /深夜/);
  p.reset();
  assert.equal(p.stats().slot, "neutral");
  assert.equal(p.stats().flips, 0);
});

test("rate/pitch 随槽位变化（面板据此调语速音高）", () => {
  let t = 0;
  const p = createPersonaSlots({ now: () => t });
  t = 100_000;
  const warm = p.update({ hour: 2 });
  assert.ok(warm.rate < 1, "暖槽应当略慢");
  assert.ok(warm.pitch > 1, "暖槽应当略高");
});
