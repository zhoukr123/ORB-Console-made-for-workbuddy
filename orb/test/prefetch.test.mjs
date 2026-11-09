/* 派发前置预取（任务 #38 / #39）。
 *
 * 沿 quickWebRoute.test.mjs 惯例：按 PREFETCH_START / PREFETCH_END 抽段，
 * 丢进 new Function 独立跑。标记被改动就 assert 失败，绝不静默测了个空。
 *
 * 锁住的不变式只有一条：**预取永远是增强项，不是派发的前置依赖**。
 * 命中则更快，未命中/失败/超时一律回落到原有现查行为。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = fs.readFileSync(path.join(ROOT, "desktop", "panel.html"), "utf8");

const START = "/* ==== PREFETCH_START ==== */";
const END = "/* ==== PREFETCH_END ==== */";
const from = PANEL.indexOf(START);
const to = PANEL.indexOf(END, from);
assert.ok(from >= 0, "找不到 PREFETCH_START");
assert.ok(to > from, "找不到 PREFETCH_END");
const block = PANEL.slice(from, to);
assert.ok(block.includes("function createPrefetcher"), "抽取段不含 createPrefetcher");
assert.ok(block.includes("Promise.allSettled"), "抽取段必须 allSettled，失败不得阻断");

const { createPrefetcher, prefetchKey } = new Function(
  block + "; return { createPrefetcher, prefetchKey, PREFETCH_DEBOUNCE_MS };"
)();

function harness(opts = {}) {
  let t = 1000;
  let seq = 0;
  let warmCount = 0;
  const timers = new Map();
  const p = createPrefetcher({
    now: () => t,
    schedule: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    cancel: (id) => timers.delete(id),
    warm: () => { warmCount++; },
    tasks: opts.tasks || { memory: async (k) => "mem:" + k },
    debounceMs: 320,
    ttlMs: 60000,
    warmEveryMs: 60000,
  });
  return {
    p,
    timers,
    get warmCount() { return warmCount; },
    setTime: (v) => { t = v; },
    flush: () => {
      const pending = [...timers.entries()];
      timers.clear();
      for (const [, x] of pending) x.fn();
    },
  };
}

test("抽取段自包含：不引用面板全局也能构造", () => {
  const h = harness();
  assert.equal(typeof h.p.note, "function");
  assert.equal(typeof h.p.peek, "function");
  assert.equal(prefetchKey("  搜论文  "), "搜论文");
  assert.equal(prefetchKey("x".repeat(4001)), "", "超长文本不预取");
  assert.equal(prefetchKey(null), "");
});

test("note 立刻预热 CLI 且按 60s 节流，不等 debounce", () => {
  const h = harness();
  assert.equal(h.p.note("搜论文"), true);
  assert.equal(h.warmCount, 1, "第一个字就该热 CLI");
  h.p.note("搜论文做总结");
  assert.equal(h.warmCount, 1, "节流窗口内不重复发预热请求");
  h.setTime(1000 + 60000);
  h.p.note("搜论文做总结写成txt");
  assert.equal(h.warmCount, 2);
});

test("debounce：连续输入只跑最后一份，旧定时器被取消", () => {
  const calls = [];
  const h = harness({ tasks: { memory: async (k) => { calls.push(k); return "m:" + k; } } });
  h.p.note("搜");
  h.p.note("搜论文");
  h.p.note("搜论文做总结");
  assert.equal(h.timers.size, 1, "只留一个待触发定时器");
  h.flush();
  assert.deepEqual(calls, ["搜论文做总结"]);
});

test("peek 精确 key 命中，结果结构与 runBack 期待一致", async () => {
  const h = harness();
  h.p.note("搜论文做总结");
  h.flush();
  const hit = h.p.peek("搜论文做总结");
  assert.ok(hit, "同文本应命中预取");
  assert.deepEqual(await hit, { memory: "mem:搜论文做总结" });
  assert.equal(h.p.peek("搜论文"), null, "不同文本绝不误命中");
  assert.equal(h.p.peek("  搜论文做总结  "), hit, "trim 后同文本仍命中");
});

test("TTL 过期后 peek 返回 null（回落现查）", () => {
  const h = harness();
  h.p.note("搜论文");
  h.flush();
  h.setTime(1000 + 60001);
  assert.equal(h.p.peek("搜论文"), null);
});

test("任一路预取失败降级为 null，不抛、不阻断", async () => {
  const h = harness({
    tasks: {
      memory: async () => { throw new Error("记忆库挂了"); },
      plan: async () => ({ ok: true, query: "论文" }),
      boom: () => { throw new Error("同步抛错"); },
    },
  });
  h.p.note("搜论文");
  h.flush();
  const hit = h.p.peek("搜论文");
  assert.ok(hit);
  assert.deepEqual(await hit, {
    memory: null,
    plan: { ok: true, query: "论文" },
    boom: null,
  });
});

test("空文本不预取；reset 清掉缓存与待触发定时器", () => {
  const h = harness();
  assert.equal(h.p.note("   "), false);
  assert.equal(h.timers.size, 0);
  h.p.note("搜论文");
  h.p.reset();
  assert.equal(h.timers.size, 0);
  h.p.note("搜论文");
  h.flush();
  h.p.reset();
  assert.equal(h.p.peek("搜论文"), null);
});

test("warm 可独立调用（覆盖语音/快捷键未经过输入框 focus 的入口）", () => {
  const h = harness();
  assert.equal(h.p.warm(), true);
  assert.equal(h.p.warm(), false, "重复调用被节流");
  assert.equal(h.warmCount, 1);
});
