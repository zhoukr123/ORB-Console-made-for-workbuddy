/* 大附件采样计划测试。
 *
 * 这组守的是两件事：
 *   ① 计划不能比整份还贵（出现过一次：混用"帧"和"秒"两个单位，算出 98k > 54k）；
 *   ② 超上限时必须**说出来**，不能悄悄截断 —— "悄悄只读前 200 页"比"明确告诉你只读了 200 页"糟得多。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { planFor, verdictOf, kindOf, RATES, CAPS } from "../attachPlan.mjs";

test("kindOf: 按 mime 优先，其次扩展名，猜不出返回 unknown", () => {
  assert.equal(kindOf("a.bin", "application/pdf"), "pdf");
  assert.equal(kindOf("x.PNG"), "image");
  assert.equal(kindOf("run.log"), "text");
  assert.equal(kindOf("mystery"), "unknown");
  assert.equal(kindOf("", ""), "unknown");
});

test("planFor: 缺体积/页数/时长时明确失败，不瞎编", () => {
  const p = planFor({ name: "a.bin" });
  assert.equal(p.ok, false);
  assert.match(p.error, /算不出/);
});

test("planFor: 小文件不采样，plan === full", () => {
  const p = planFor({ name: "a.txt", bytes: 4096 });
  assert.equal(p.ok, true);
  assert.equal(p.overCap, false);
  assert.equal(p.plan.tokens, p.full.tokens);
  assert.deepEqual(p.warnings, []);
});

test("planFor: 1GB 文本被采样，且计划远小于整份", () => {
  const p = planFor({ name: "big.log", bytes: 1024 ** 3 });
  assert.equal(p.kind, "text");
  assert.equal(p.overCap, true);
  assert.ok(p.plan.tokens <= p.full.tokens, "计划不能比整份还贵");
  assert.ok(p.plan.tokens <= Math.ceil((CAPS.text_chars / RATES.chars_per_token) * 1.2));
  assert.ok(p.warnings.length >= 1, "截断必须说出来");
  assert.match(p.warnings.join(" "), /只读/);
});

test("planFor: PDF 按页采样，页数直接给时以页数为准", () => {
  const p = planFor({ name: "a.pdf", bytes: 80 * 1024 * 1024, meta: { pages: 1400 } });
  assert.equal(p.kind, "pdf");
  assert.equal(p.plan.total, 1400);
  assert.equal(p.plan.take, CAPS.pdf_pages);
  assert.equal(p.plan.unit, "page");
  assert.ok(p.plan.tokens <= p.full.tokens);
});

test("planFor: 视频的单位是帧不是秒，计划不超整份（回归：曾经算出 98k > 54k）", () => {
  const p = planFor({ name: "v.mp4", bytes: 900 * 1024 * 1024, meta: { durationSec: 1800 } });
  assert.equal(p.kind, "video");
  assert.equal(p.plan.unit, "frame");
  assert.ok(p.plan.take <= CAPS.video_frames);
  assert.ok(p.plan.tokens <= p.full.tokens, `计划 ${p.plan.tokens} 超过了整份 ${p.full.tokens}`);
});

test("planFor: 大图长边被缩到上限，且提示「再大也会被模型缩放」", () => {
  const p = planFor({ name: "s.png", bytes: 3 * 1024 * 1024, meta: { width: 6000, height: 4000 } });
  assert.equal(p.kind, "image");
  assert.equal(p.plan.take, CAPS.image_side);
  assert.ok(p.plan.tokens < p.full.tokens);
  assert.match(p.warnings.join(" "), /缩放/);
});

test("planFor: 音频按秒截断并说明后面进不了上下文", () => {
  const p = planFor({ name: "a.mp3", bytes: 128 * 1024 * 1024, meta: { durationSec: 7200 } });
  assert.equal(p.kind, "audio");
  assert.equal(p.plan.take, CAPS.audio_sec);
  assert.match(p.warnings.join(" "), /只转写前/);
});

test("planFor: 压缩包/未知类型带 uncertain 提示（数字不能当承诺）", () => {
  const z = planFor({ name: "pkg.zip", bytes: 50 * 1024 * 1024 });
  assert.equal(z.kind, "archive");
  assert.match(z.warnings.join(" "), /压缩包/);
  const u = planFor({ name: "mystery", bytes: 1024 });
  assert.equal(u.kind, "unknown");
  assert.match(u.warnings.join(" "), /未知类型/);
});

test("planFor: 任何输入的 plan 都不超过 full（全类型横扫）", () => {
  const cases = [
    { name: "a.txt", bytes: 1e9 },
    { name: "a.pdf", bytes: 1e8, meta: { pages: 5000 } },
    { name: "a.png", bytes: 1e7, meta: { width: 12000, height: 9000 } },
    { name: "a.mp3", bytes: 1e9, meta: { durationSec: 100000 } },
    { name: "a.mp4", bytes: 1e9, meta: { durationSec: 100000 } },
    { name: "a.zip", bytes: 1e9 },
  ];
  for (const c of cases) {
    const p = planFor(c);
    assert.equal(p.ok, true, c.name);
    assert.ok(p.plan.tokens <= p.full.tokens,
      `${c.name}: 计划 ${p.plan.tokens} 超过整份 ${p.full.tokens}`);
  }
});

test("verdictOf: 整份读不起时说整份，而不是只报采样价", () => {
  const p = planFor({ name: "big.log", bytes: 1024 ** 3 });
  const v = verdictOf(p);
  assert.equal(v.level, "warn");
  assert.match(v.text, /不能整读/);
  assert.match(v.text, /不足 1%|%/);
});

test("verdictOf: 算不出来时不要给一个假的「可以直接读」", () => {
  const v = verdictOf(planFor({ name: "a.bin" }));
  assert.equal(v.level, "unknown");
});

test("planFor 是纯函数：同样输入两次结果完全相同", () => {
  const a = planFor({ name: "a.pdf", bytes: 12e6, meta: { pages: 300 } });
  const b = planFor({ name: "a.pdf", bytes: 12e6, meta: { pages: 300 } });
  assert.deepEqual(a, b);
});
