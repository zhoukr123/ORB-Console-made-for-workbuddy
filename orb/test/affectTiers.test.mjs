/* 开口门控三档：安静 / 标准 / 及时。
 * 依据 When2Talk 的 Immediate / Delayed / Silent 与「价值必须高于打断成本」；
 * 六层护栏常开、不可关，可调的只有档位；用户看不到任何数值参数。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createAffectGate, SPEAK_TIERS, SPEAK_TIER_IDS, inferTierFromText, DEFAULT_SPEAK_TIER } from "../affectGate.mjs";

let clock = 1_000_000;
const mk = () => createAffectGate({ now: () => clock });
const OK = { kind: "reminder", urgency: "normal", confidence: 0.9 };

test("恰好三档：安静 / 标准 / 及时，且每档护栏都还开着", () => {
  assert.deepEqual(SPEAK_TIER_IDS, ["quiet", "standard", "prompt"]);
  assert.deepEqual(SPEAK_TIER_IDS.map((k) => SPEAK_TIERS[k].name), ["安静", "标准", "及时"]);
  assert.equal(DEFAULT_SPEAK_TIER, "standard");
  for (const id of SPEAK_TIER_IDS) {
    const p = SPEAK_TIERS[id].params;
    assert.ok(p.cooldownMs > 0, `${id} 不能关冷却`);
    assert.ok(p.presentWindowMs > 0, `${id} 不能关在场静默`);
    assert.ok(p.burstMax >= 1, `${id} 不能关熔断`);
    assert.ok(p.burstWindowMs > 0, `${id} 不能关熔断窗口`);
    assert.ok(p.minConfidence > 0 && p.minConfidence <= 1, `${id} 置信度门槛必须在 (0,1]`);
  }
});

test("inferTierFromText：用户明确表态才推断，识别不到返回 null", () => {
  assert.equal(inferTierFromText("别烦我，我自己弄").tier, "quiet");
  assert.equal(inferTierFromText("安静点，先别提醒").tier, "quiet");
  assert.equal(inferTierFromText("有进展就马上告诉我，别漏").tier, "prompt");
  assert.equal(inferTierFromText("照常就好").tier, "standard");
  assert.equal(inferTierFromText("帮我把这份表整理一下"), null);
  assert.equal(inferTierFromText(""), null);
});

test("setTier 换的是松紧，不是开关：安静更严、及时更松", () => {
  /* 同样「刚操作过 60 秒」，标准档仍算在场，及时档已放行，安静档仍拦。 */
  const std = mk();
  assert.equal(std.evaluate({ ...OK, userActiveAt: clock - 60_000 }).pass, false);
  const prompt = mk(); prompt.setTier("prompt");
  assert.equal(prompt.evaluate({ ...OK, userActiveAt: clock - 60_000 }).pass, true);
  const quiet = mk(); quiet.setTier("quiet");
  assert.equal(quiet.evaluate({ ...OK, userActiveAt: clock - 60_000 }).pass, false);
  assert.equal(quiet.evaluate({ ...OK, confidence: 0.7 }).pass, false, "安静档置信度门槛更高");
  assert.equal(std.evaluate({ ...OK, confidence: 0.7 }).pass, true);
});

test("tierHint 只影响这一次判定，不改全局档位", () => {
  const g = mk();
  assert.equal(g.tier(), "standard");
  assert.equal(g.evaluate({ ...OK, userActiveAt: clock - 60_000, tierHint: "prompt" }).pass, true);
  assert.equal(g.tier(), "standard");
  assert.equal(g.evaluate({ ...OK, userActiveAt: clock - 60_000 }).pass, false);
});

test("Agent 从用户原话推理档位：说「别烦我」就当场安静下来", () => {
  const g = mk();
  assert.equal(g.evaluate({ ...OK, userActiveAt: clock - 60_000, userText: "别烦我" }).pass, false);
  assert.equal(g.tier(), "standard", "推理不改全局设置");
  assert.equal(g.evaluate({ ...OK, userActiveAt: clock - 60_000, userText: "有进展马上告诉我" }).pass, true);
});

test("用户原话的推理优先于 hint；「照常」撤回临时表态回落到全局档", () => {
  const g = mk();
  g.setTier("quiet");
  /* 全局安静 + 提示及时，但用户原话要求少开口 → 当场仍按安静判。 */
  assert.equal(g.evaluate({ ...OK, userActiveAt: clock - 60_000, tierHint: "prompt", userText: "别烦我" }).pass, false);
  assert.equal(g.tier(), "quiet", "推理不改全局档位");
  /* 说「照常」不应把全局安静强行改成标准，应回落全局。 */
  assert.equal(g.evaluate({ ...OK, userActiveAt: clock - 60_000, userText: "照常就好" }).pass, false);
  /* 明确及时的表态仍然能临时压过全局安静。 */
  const g2 = mk();
  g2.setTier("quiet");
  assert.equal(g2.evaluate({ ...OK, userActiveAt: clock - 60_000, userText: "有进展马上告诉我" }).pass, true);
  assert.equal(g2.tier(), "quiet");
});

test("三档都不能越过决策直通 / 急停 / 在场 / 熔断这几层硬护栏", () => {
  for (const id of SPEAK_TIER_IDS) {
    const g = mk(); g.setTier(id);
    assert.equal(g.evaluate({ ...OK, decisionRequired: true, stopped: true, userActiveAt: clock }).pass, true,
      `${id}: 决策必需永远直通`);
    assert.equal(g.evaluate({ ...OK, stopped: true }).blockedBy, "stopped", `${id}: 急停仍抑制`);
    assert.equal(g.evaluate({ ...OK, userActiveAt: clock }).blockedBy, "user-present", `${id}: 正在操作仍让位`);
  }
});

test("setTier 拒绝不存在的档位；stats 暴露当前档位名", () => {
  const g = mk();
  assert.equal(g.setTier("turbo").ok, false);
  assert.equal(g.tier(), "standard");
  assert.equal(g.setTier("quiet").ok, true);
  assert.equal(g.stats().tier, "quiet");
  assert.equal(g.options().minConfidence, 0.8, "档位确实落到护栏参数上");
});

test("reset 不清掉档位：用户选的档不该因为清空记录就回默认", () => {
  const g = mk();
  g.setTier("quiet");
  g.evaluate(OK);
  g.reset();
  assert.equal(g.tier(), "quiet");
  assert.equal(g.options().minConfidence, 0.8);
});
