import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUDGET_MODES,
  MEMORY_TIERS,
  BASE_BUDGET,
  HARD_CAP,
  budgetFor,
  createMemoryBudget,
} from "../memoryBudget.mjs";

function entry(id, tier, opts = {}) {
  return {
    id,
    tier,
    text: "x".repeat(10),
    score: 0.5,
    trust: "trusted",
    verified: true,
    ...opts,
  };
}

test("1 普通模式零开销：不读取用量入参，observe 不记录任何样本", () => {
  const trap = {};
  Object.defineProperty(trap, "usage", {
    enumerable: true,
    get() { throw new Error("普通模式不应读取 usage"); },
  });
  Object.defineProperty(trap, "tierPressure", {
    enumerable: true,
    get() { throw new Error("普通模式不应读取 tierPressure"); },
  });
  Object.defineProperty(trap, "freeChars", {
    enumerable: true,
    get() { throw new Error("普通模式不应读取 freeChars"); },
  });

  const r = budgetFor("normal", trap);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "normal");
  assert.equal(r.enabled, false);
  assert.equal(r.source, "base");
  assert.equal(r.chars, BASE_BUDGET.chars);
  assert.deepEqual(r.tiers, { always: 8, working: 12, archived: 0 });
  assert.equal(budgetFor("normal", trap).source, "base");

  const inst = createMemoryBudget({ mode: "normal" });
  assert.deepEqual(inst.observe(0.9), { ok: true, recorded: false });
  assert.equal(inst.stats().samples, 0);
  assert.equal(inst.allocate([entry("a", "always")]).ok, true);
  assert.equal(inst.stats().samples, 0);
});

test("2 Max 模式动态放大且每一项都不超硬上限", () => {
  const r = budgetFor("max", {
    usage: 1e9,
    tierPressure: { always: 1e9, working: 1e9, archive: 1e9 },
    freeChars: 1e9,
  });
  assert.equal(r.ok, true);
  assert.equal(r.enabled, true);
  assert.equal(r.source, "dynamic");
  assert.ok(r.chars <= HARD_CAP.chars);
  assert.ok(r.tiers.always <= HARD_CAP.always);
  assert.ok(r.tiers.working <= HARD_CAP.working);
  assert.ok(r.tiers.archived <= BASE_BUDGET.archived);
  // 极大信号应恰好顶到硬上限。
  assert.equal(r.chars, HARD_CAP.chars);
  assert.equal(r.tiers.always, HARD_CAP.always);
  assert.equal(r.tiers.working, HARD_CAP.working);
  assert.equal(r.tiers.archived, 0);
  // 无用量入参时也不报错，且启用即有基础扩容。
  const plain = budgetFor("max");
  assert.equal(plain.enabled, true);
  assert.ok(plain.chars > BASE_BUDGET.chars);
  assert.ok(plain.chars <= HARD_CAP.chars);
});

test("3 未知 mode 拒绝；所有返回数字字段均为整数", () => {
  assert.deepEqual(budgetFor("turbo"), { ok: false, code: "bad-mode" });
  assert.deepEqual(budgetFor("MAX"), { ok: false, code: "bad-mode" });
  assert.deepEqual(budgetFor(""), { ok: false, code: "bad-mode" });

  for (const r of [budgetFor("normal"), budgetFor("max"), budgetFor("max", { usage: 0.73 })]) {
    assert.equal(Number.isInteger(r.chars), true);
    assert.equal(Number.isInteger(r.tiers.always), true);
    assert.equal(Number.isInteger(r.tiers.working), true);
    assert.equal(Number.isInteger(r.tiers.archived), true);
  }
});

test("4 不可信条目一律剔除，只计入 rejected.untrusted", () => {
  const inst = createMemoryBudget({ mode: "normal" });
  const r = inst.allocate([
    entry("a", "always"),
    entry("bad1", "always", { trust: "guest" }),
    entry("bad2", "working", { untrusted: true }),
    entry("bad3", "working", { trust: undefined }),
    entry("b", "working"),
  ]);
  // bad3 缺 trust（非 "trusted"），按契约同样不可信。
  assert.equal(r.rejected.untrusted, 3);
  const ids = [...r.selected, ...r.deferred].map((e) => e.id);
  assert.ok(!ids.includes("bad1"));
  assert.ok(!ids.includes("bad2"));
  assert.ok(!ids.includes("bad3"));
  assert.ok(ids.includes("a"));
  assert.ok(ids.includes("b"));
  assert.ok(r.report.filter((x) => x.action === "rejected").every((x) => x.reason === "untrusted"));
});

test("5 超预算条目进 deferred 且 text 完整不截断；各层限额分别生效", () => {
  const inst = createMemoryBudget({ mode: "normal" });
  const longText = "L".repeat(50);
  const entries = [];
  for (let i = 0; i < 9; i++) entries.push(entry(`a${i}`, "always", { score: i }));
  for (let i = 0; i < 13; i++) entries.push(entry(`w${i}`, "working", { score: i }));
  entries.push(entry("long", "always", { text: longText, score: 99 }));

  const r = inst.allocate(entries);
  assert.equal(r.selected.filter((e) => e.tier === "always").length, BASE_BUDGET.always);
  assert.equal(r.selected.filter((e) => e.tier === "working").length, BASE_BUDGET.working);
  assert.ok(r.deferred.filter((e) => e.tier === "always").length >= 1);
  assert.ok(r.deferred.filter((e) => e.tier === "working").length >= 1);
  for (const e of r.deferred) {
    assert.equal(e.text.length, 10, "deferred 文本必须保持完整，不得被截断");
  }
  assert.ok(r.selected.some((e) => e.id === "long" && e.text === longText));

  // 单条就超过该层字符上限：完整进 deferred，并计入 overCap。
  const huge = "H".repeat(900);
  const r2 = inst.allocate([entry("huge", "always", { text: huge })]);
  assert.equal(r2.selected.length, 0);
  assert.equal(r2.deferred.length, 1);
  assert.equal(r2.deferred[0].text, huge);
  assert.ok(r2.rejected.overCap >= 1);
});

test("6 未验证条目不占 always 配额，只能进 working/deferred 且 report 单列", () => {
  const inst = createMemoryBudget({ mode: "normal" });
  const entries = [];
  for (let i = 0; i < BASE_BUDGET.always; i++) entries.push(entry(`a${i}`, "always", { score: 1 }));
  entries.push(entry("uv1", "always", { verified: false, score: 1 }));
  entries.push(entry("uv2", "always", { text: "UNVERIFIED: hello", score: 1 }));

  const r = inst.allocate(entries);
  const selectedAlways = r.report.filter((x) => x.action === "selected" && x.effectiveTier === "always");
  assert.equal(selectedAlways.length, BASE_BUDGET.always, "always 配额应被已验证条目占满");
  assert.ok(selectedAlways.every((x) => String(x.id).startsWith("a")));

  const uvReport = r.report.filter((x) => x.unverified);
  assert.equal(uvReport.length, 2, "report 应单列两条未验证记录");
  assert.ok(uvReport.every((x) => x.effectiveTier !== "always"));
  assert.ok(uvReport.some((x) => x.action === "selected" && x.effectiveTier === "working"));
  assert.equal(r.rejected.unverified, 2);
  assert.ok(r.selected.some((e) => e.id === "uv1"), "未验证条目应降级进 working 而非被丢弃");
});

test("7 setMode 切换后预算随之变化，Max 比普通模式选得多", () => {
  const inst = createMemoryBudget({ mode: "normal" });
  const entries = [];
  for (let i = 0; i < 20; i++) entries.push(entry(`a${i}`, "always", { score: i }));

  const n = inst.allocate(entries);
  assert.equal(n.enabled, false);
  assert.equal(n.budget.source, "base");

  const set = inst.setMode("max");
  assert.equal(set.ok, true);
  assert.equal(set.mode, "max");
  assert.equal(set.budget.enabled, true);
  assert.equal(set.budget.source, "dynamic");
  assert.ok(set.budget.chars > n.budget.chars);

  const m = inst.allocate(entries);
  assert.equal(m.budget.chars, set.budget.chars);
  assert.ok(m.selected.length > n.selected.length, `${m.selected.length} > ${n.selected.length}`);

  assert.equal(inst.setMode("ultra").ok, false);
  assert.equal(inst.stats().mode, "max");
});

test("8 snapshot 深拷贝不可污染内部，stats 计数单调递增", () => {
  let t = 1000;
  const inst = createMemoryBudget({ now: () => t, mode: "max" });
  const s0 = inst.stats();
  inst.observe(0.5);
  t = 2000;
  inst.allocate([entry("a", "always")]);
  const s1 = inst.stats();
  assert.ok(s1.samples >= s0.samples);
  assert.ok(s1.allocations >= s0.allocations);
  assert.ok(s1.selected >= s0.selected);
  assert.ok(s1.lastAt >= s0.lastAt);

  const snap = inst.snapshot();
  snap.samples.push(12345);
  snap.quota.injected = { deep: true };
  snap.budget.chars = -1;
  snap.budget.tiers.always = -1;
  snap.selected = -1;
  const snap2 = inst.snapshot();
  assert.equal(snap2.samples.length, s1.samples);
  assert.equal(snap2.quota.injected, undefined);
  assert.ok(snap2.budget.chars > 0);
  assert.ok(snap2.budget.tiers.always > 0);
  assert.equal(snap2.selected, s1.selected);
  assert.equal(inst.stats().samples, s1.samples);

  t = 3000;
  inst.allocate([entry("b", "always", { trust: "guest" })]);
  const s2 = inst.stats();
  for (const k of ["samples", "allocations", "selected", "deferred", "untrusted", "lastAt"]) {
    assert.ok(s2[k] >= s1[k], `${k} 应单调递增`);
  }
});

test("9 静态契约：被测源码零依赖语句且不引用既有记忆实现", () => {
  const src = readFileSync(new URL("../memoryBudget.mjs", import.meta.url), "utf8");
  assert.equal(/\bimport\b/.test(src), false, "被测源码不应出现 import 语句");
  assert.equal(/\brequire\s*\(/.test(src), false, "被测源码不应出现 require 调用");
  assert.equal(src.includes("desktop/memory.js"), false);

  assert.deepEqual(Object.keys(BUDGET_MODES).sort(), ["max", "normal"]);
  assert.deepEqual(Object.keys(MEMORY_TIERS).sort(), ["always", "archive", "working"]);
  for (const t of Object.values(MEMORY_TIERS)) assert.equal(typeof t.weight, "number");
  for (const obj of [BUDGET_MODES, MEMORY_TIERS, BASE_BUDGET, HARD_CAP]) {
    assert.equal(Object.isFrozen(obj), true);
  }
});
