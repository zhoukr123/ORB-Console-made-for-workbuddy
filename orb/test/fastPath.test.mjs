/* fastPath 单测：1GB/录屏音轨不进模型输入 / 枚举 / 去重复用 / 共享预算 / probe 注入。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFastPath, REASON_CODES } from "../fastPath.mjs";

const GB = 1024 * 1024 * 1024;

test("REASON_CODES：七个固定枚举", () => {
  assert.deepEqual([...REASON_CODES].sort(), [
    "admitted", "too-large", "unsupported-type", "already-indexed",
    "duplicate-hash", "budget-exhausted", "missing-meta",
  ].sort());
});

test("1GB 附件不进模型输入：仅给 header/时长/哈希/采样窗口，token 与大小无关", () => {
  const fp = createFastPath({ now: () => 1000 });
  const r = fp.screen({
    path: "big.bin", size: GB, mime: "text/plain", mtimeMs: 123,
    header: { durationMs: 120000, bytes: 48 }, indexed: false, contentHash: "h-1gb",
  });
  assert.equal(r.admitted, false);
  assert.equal(r.reasonCode, "too-large");
  assert.ok(r.estimatedTokens <= 256, "只能是 header 级 token，绝不等于 1GB/4");
  assert.ok(r.estimatedTokens < GB / 4);
  assert.equal(r.samplingWindow.enabled, true);
  assert.equal(r.samplingWindow.durationMs, 120000);
  assert.equal(r.samplingWindow.header.bytes, 48);
  assert.equal(r.contentHash, "h-1gb");
  assert.equal(r.budget.remaining, 100000);
});

test("录屏音轨不进模型输入：audio/video 一律 unsupported-type", () => {
  const fp = createFastPath({ now: () => 1 });
  const a = fp.screen({ size: 1024, mime: "audio/wav", contentHash: "aud1" });
  const v = fp.screen({ size: 1024, mime: "video/mp4", contentHash: "vid1" });
  assert.equal(a.admitted, false);
  assert.equal(a.reasonCode, "unsupported-type");
  assert.equal(v.admitted, false);
  assert.equal(v.reasonCode, "unsupported-type");
  // 即便体积达到 1GB，音轨仍被拒（不会进入模型输入）
  const big = fp.screen({ size: GB, mime: "audio/mpeg", contentHash: "aud-big" });
  assert.equal(big.admitted, false);
});

test("小文件正常准入，estimatedTokens 有上限", () => {
  const fp = createFastPath({ now: () => 1 });
  const r = fp.screen({ size: 100, mime: "text/plain", contentHash: "s1" });
  assert.equal(r.admitted, true);
  assert.equal(r.reasonCode, "admitted");
  assert.ok(r.estimatedTokens > 0 && r.estimatedTokens <= 8192);
  assert.equal(r.samplingWindow.enabled, false);
});

test("已索引复用 / 重复哈希直接拒 / 缺元数据", () => {
  const fp = createFastPath({ now: () => 1 });
  assert.equal(fp.screen({ size: 50, mime: "text/plain", contentHash: "idx", indexed: true }).reasonCode, "already-indexed");
  assert.equal(fp.screen({ size: 50, mime: "text/plain", contentHash: "dup" }).reasonCode, "admitted");
  assert.equal(fp.screen({ size: 50, mime: "text/plain", contentHash: "dup" }).reasonCode, "duplicate-hash");
  assert.equal(fp.screen({ path: "x" }).reasonCode, "missing-meta");
});

test("charge：多个 Trigger 共享同一采样预算", () => {
  const fp = createFastPath({ budget: { maxTokens: 100 }, now: () => 1 });
  assert.equal(fp.remaining("A"), 100);
  assert.deepEqual(fp.charge("A", 30), { ok: true, remaining: 70 });
  assert.deepEqual(fp.charge("B", 30), { ok: true, remaining: 40 }, "B 从同一池扣减");
  assert.equal(fp.charge("C", 50).ok, false, "超出共享余额被拒");
  assert.equal(fp.remaining("C"), 40);
  assert.equal(fp.charge("A", -1).ok, false);
});

test("perKeyMax 限制 + 预算耗尽使 screen 报 budget-exhausted", () => {
  const fp = createFastPath({ budget: { maxTokens: 100, perKeyMax: 60 }, now: () => 1 });
  assert.equal(fp.charge("A", 40).ok, true);
  assert.equal(fp.charge("A", 30).ok, false, "单 key 超 60 被拒");
  assert.equal(fp.remaining("A"), 20);
  assert.equal(fp.charge("B", 60).ok, true);
  assert.equal(fp.remaining("B"), 0, "共享池已空");

  const r = fp.screen({ size: 100, mime: "text/plain", contentHash: "after-empty" });
  assert.equal(r.reasonCode, "budget-exhausted");
  assert.equal(r.admitted, false);
});

test("probe 注入补元数据、抛错不影响主流程、stats 计数", () => {
  const fp = createFastPath({
    now: () => 1,
    probe: (m) => {
      if (m.path === "throw") throw new Error("probe fail");
      return { size: 100, mime: "text/plain", contentHash: `hash-${m.path}` };
    },
  });
  const ok = fp.screen({ path: "a" });
  assert.equal(ok.reasonCode, "admitted");
  assert.equal(ok.contentHash, "hash-a");
  assert.equal(fp.screen({ path: "throw" }).reasonCode, "missing-meta", "探针抛错不崩");

  const s = fp.stats();
  assert.equal(s.screened, 2);
  assert.equal(s.admitted, 1);
  assert.equal(s.rejected, 1);
  assert.equal(s.byReason["admitted"], 1);
  assert.equal(s.byReason["missing-meta"], 1);
});
