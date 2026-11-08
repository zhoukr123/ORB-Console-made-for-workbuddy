import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  UNVERIFIED_PREFIX,
  TRUST_LEVELS,
  CONSOLIDATION_PHASES,
  DEFAULT_QUOTA,
  isEligible,
  similarity,
  createDreamConsolidator,
} from "../dreamConsolidator.mjs";

const mixedEntries = () => [
  { id: "a1", text: "记忆A", tag: "t1", score: 0.9, trust: "trusted" },
  { id: "a2", text: "记忆A", tag: "t1", score: 0.5, trust: "trusted" },
  {
    id: "b1",
    text: "事实B已过时",
    tag: "t2",
    score: 0.8,
    trust: "trusted",
    desired: "事实B已修正",
    evidence: "log#42",
  },
  {
    id: "c1",
    text: "结论C待核验",
    tag: "t3",
    score: 0.7,
    trust: "trusted",
    desired: "结论C新版",
  },
  { id: "d1", text: "独立条目D", tag: "t4", score: 0.65, trust: "trusted" },
  { id: "x1", text: "恶意注入", trust: "untrusted", score: 1 },
  { id: "x2", text: "未标信任", score: 0.99 },
  { id: "x3", text: "", trust: "trusted", score: 0.99 },
  { id: "e1", text: "低分条目E", tag: "t5", score: 0.3, trust: "trusted" },
  {
    id: "e2",
    text: "条目F",
    tag: "t6",
    score: 0.95,
    trust: "trusted",
    untrusted: true,
  },
];

// 每个 i 生成两个互不相同的汉字，保证两字符 bigram 全不相同、不会触发去重
const highValueEntries = (n = 20) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    text:
      String.fromCharCode(0x4e00 + i) +
      String.fromCharCode(0x4e00 + 1000 + i),
    tag: "bulk",
    topic: "bulk",
    score: 1 - i * 0.01,
    trust: "trusted",
  }));

test("0. 常量导出形状与冻结", () => {
  assert.equal(UNVERIFIED_PREFIX, "UNVERIFIED:");
  assert.equal(TRUST_LEVELS.trusted, "trusted");
  assert.equal(TRUST_LEVELS.untrusted, "untrusted");
  assert.equal(TRUST_LEVELS.unverified, "unverified");
  assert.ok(Object.isFrozen(TRUST_LEVELS));
  assert.ok(Object.isFrozen(CONSOLIDATION_PHASES));
  assert.ok(Object.isFrozen(DEFAULT_QUOTA));
  assert.deepEqual(Object.values(CONSOLIDATION_PHASES), [
    "collect",
    "dedupe",
    "correct",
    "index",
    "preload",
  ]);
  assert.deepEqual(DEFAULT_QUOTA, {
    maxPreload: 8,
    maxChars: 2400,
    minScore: 0.6,
  });
});

test("1a. isEligible 拒绝 untrusted / 空 text / 缺 trust", () => {
  assert.equal(
    isEligible({ text: "x", trust: "trusted", untrusted: true }).ok,
    false,
  );
  assert.equal(
    isEligible({ text: "x", trust: "trusted", untrusted: true }).reason,
    "untrusted",
  );
  assert.equal(isEligible({ text: "x", trust: "untrusted" }).ok, false);
  assert.equal(isEligible({ text: "x", trust: "unverified" }).ok, false);
  assert.equal(isEligible({ text: "", trust: "trusted" }).reason, "empty-text");
  assert.equal(isEligible({ text: "   ", trust: "trusted" }).ok, false);
  assert.equal(isEligible({ text: "x" }).reason, "missing-trust");
  assert.equal(isEligible().ok, false);
  assert.equal(isEligible(null).reason, "not-an-object");
  assert.equal(isEligible({ text: "x", trust: "trusted" }).ok, true);
  assert.equal(
    isEligible({ text: "x", trust: "trusted", untrusted: false }).ok,
    true,
  );
});

test("1b. similarity 为 bigram Jaccard，0..1", () => {
  assert.equal(similarity("记忆整理", "记忆整理"), 1);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("abcd", "wxyz"), 0);
  assert.equal(similarity("a", "b"), 0);
  assert.equal(similarity("记忆整理", "记忆整埋"), 0.5);
  assert.equal(similarity("记忆整理", "记忆整"), 2 / 3);
  assert.equal(similarity("记忆整理", "天气很好"), 0);
  for (const v of [
    similarity("记忆整理", "记忆整埋"),
    similarity("记忆整理", "记忆整"),
  ]) {
    assert.ok(v >= 0 && v <= 1);
  }
});

test("2. consolidate 五阶段顺序、stats 计数准确、不改动入参", () => {
  const c = createDreamConsolidator({ now: () => 1234 });
  const input = mixedEntries();
  const r = c.consolidate(input);

  assert.equal(r.ok, true);
  assert.deepEqual(r.phases, [
    "collect",
    "dedupe",
    "correct",
    "index",
    "preload",
  ]);
  assert.equal(r.at, 1234);
  assert.deepEqual(r.stats, {
    collected: 10,
    trusted: 6,
    rejected: 4,
    deduped: 1,
    corrected: 1,
    unverified: 1,
    indexed: 5,
    preloaded: 4,
    deferred: 1,
  });
  assert.deepEqual(c.stats(), {
    runs: 1,
    lastRunAt: 1234,
    memorySize: 5,
    indexSize: 5,
    corrected: 1,
    unverified: 1,
    deferred: 1,
  });
  assert.ok(r.report.some((line) => line.startsWith(UNVERIFIED_PREFIX)));
  assert.equal(input[2].text, "事实B已过时");
  assert.equal(input[3].text, "结论C待核验");
  assert.equal(input[2].corrected, undefined);
});

test("3. 不可信条目绝不出现在 memory / preload / index / deferred", () => {
  const r = createDreamConsolidator().consolidate(mixedEntries());
  const badIds = ["x1", "x2", "x3", "e2"];
  const allIds = [
    ...r.memory.map((e) => e.id),
    ...r.preload.map((e) => e.id),
    ...r.deferred.map((e) => e.id),
    ...Object.values(r.index).flat(),
  ];
  for (const id of badIds) assert.ok(!allIds.includes(id), `${id} 不应出现`);

  const texts = [...r.memory, ...r.preload, ...r.deferred]
    .map((e) => e.text)
    .join("|");
  for (const t of ["恶意注入", "未标信任", "条目F"]) {
    assert.ok(!texts.includes(t), `${t} 不应出现`);
  }
  for (const e of r.memory) {
    assert.equal(isEligible(e).ok, true);
    assert.equal(e.untrusted, undefined);
  }
});

test("4. 去重保留高分 / 有证据才改写 / 无证据生成 UNVERIFIED: 前缀", () => {
  const r = createDreamConsolidator().consolidate(mixedEntries());
  const byId = Object.fromEntries(r.memory.map((e) => [e.id, e]));

  assert.ok(byId.a1);
  assert.equal(byId.a2, undefined);
  assert.equal(byId.a1.score, 0.9);

  assert.equal(byId.b1.text, "事实B已修正");
  assert.equal(byId.b1.corrected, true);
  assert.notEqual(byId.b1.verified, true);

  assert.ok(byId.c1.text.startsWith(UNVERIFIED_PREFIX));
  assert.ok(byId.c1.text.includes("结论C待核验"));
  assert.notEqual(byId.c1.verified, true);
  assert.notEqual(byId.c1.corrected, true);
});

test("5. verify 无证据被拒 / 成功后去掉前缀并标 verified", () => {
  const c = createDreamConsolidator({ now: () => 1 });
  c.consolidate(mixedEntries());

  assert.deepEqual(c.verify("c1", ""), {
    ok: false,
    code: "evidence-required",
  });
  assert.equal(c.verify("c1", "   ").code, "evidence-required");
  assert.equal(c.verify("c1", undefined).code, "evidence-required");
  assert.deepEqual(c.verify("nope", "外部证据"), {
    ok: false,
    code: "not-found",
  });
  assert.equal(c.stats().unverified, 1);

  const v = c.verify("c1", "外部核验通过");
  assert.equal(v.ok, true);
  assert.equal(v.verified, true);
  assert.equal(v.text, "结论C待核验");

  const e = c.snapshot().memory.find((x) => x.id === "c1");
  assert.equal(e.text, "结论C待核验");
  assert.equal(e.verified, true);
  assert.ok(!e.text.startsWith(UNVERIFIED_PREFIX));
  assert.equal(c.stats().unverified, 0);
});

test("6a. 预加载硬配额：前 maxPreload 进 preload，其余进 deferred", () => {
  const r = createDreamConsolidator().consolidate(highValueEntries(20));
  assert.equal(r.stats.trusted, 20);
  assert.equal(r.stats.deduped, 0);
  assert.equal(r.stats.preloaded, DEFAULT_QUOTA.maxPreload);
  assert.equal(r.stats.deferred, 20 - DEFAULT_QUOTA.maxPreload);
  assert.deepEqual(
    r.preload.map((e) => e.id),
    Array.from({ length: DEFAULT_QUOTA.maxPreload }, (_, i) => `p${i}`),
  );
  assert.equal(r.preload.length + r.deferred.length, 20);
  const used = r.preload.reduce((sum, e) => sum + e.chars, 0);
  assert.ok(used <= DEFAULT_QUOTA.maxChars);
  const picked = new Set(r.preload.map((e) => e.id));
  for (const e of r.deferred) assert.ok(!picked.has(e.id));
});

test("6b. maxChars 也是硬上限，溢出进 deferred", () => {
  const r = createDreamConsolidator({
    quota: { maxPreload: 20, maxChars: 5, minScore: 0 },
  }).consolidate(highValueEntries(20));
  const used = r.preload.reduce((sum, e) => sum + e.chars, 0);
  assert.ok(used <= 5);
  assert.equal(r.preload.length, 2);
  assert.equal(r.stats.preloaded + r.stats.deferred, 20);
});

test("6c. 低于 minScore 不进预加载", () => {
  const r = createDreamConsolidator({ quota: { minScore: 0.95 } }).consolidate(
    highValueEntries(20),
  );
  assert.ok(r.preload.every((e) => e.score >= 0.95));
  assert.ok(r.deferred.some((e) => e.score < 0.95));
});

test("7. ctx.idle===false 返回 not-idle 且不改动内存；非数组返回 bad-input", () => {
  const c = createDreamConsolidator({ now: () => 7 });
  c.consolidate([
    { id: "keep", text: "保留记忆", tag: "k", score: 0.9, trust: "trusted" },
  ]);
  const before = c.snapshot();

  const r = c.consolidate(mixedEntries(), { idle: false });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not-idle");
  assert.ok(r.stats);
  assert.deepEqual(c.snapshot(), before);
  assert.equal(c.stats().runs, 1);
  assert.equal(c.stats().lastRunAt, 7);

  for (const bad of ["nope", null, {}, 42, true]) {
    const out = c.consolidate(bad);
    assert.equal(out.ok, false);
    assert.equal(out.code, "bad-input");
  }
  assert.deepEqual(c.snapshot(), before);
  assert.equal(c.stats().runs, 1);
});

test("8. snapshot 与 consolidate 返回值均为拷贝，外部污染不了内部", () => {
  const c = createDreamConsolidator();
  const r = c.consolidate(mixedEntries());

  r.memory[0].text = "改返回值";
  r.preload.length = 0;
  r.index.t1.push("via-return");

  const snap = c.snapshot();
  snap.memory[0].text = "外部篡改";
  snap.memory.push({ id: "injected", text: "注入", trust: "trusted" });
  snap.index.t1.push("injected");
  snap.index.injected = ["injected"];
  snap.preload.length = 0;
  snap.deferred.push({ id: "injected2" });

  const after = c.snapshot();
  assert.equal(after.memory.length, 5);
  assert.notEqual(after.memory[0].text, "外部篡改");
  assert.notEqual(after.memory[0].text, "改返回值");
  assert.ok(!after.index.t1.includes("injected"));
  assert.ok(!after.index.t1.includes("via-return"));
  assert.equal(after.index.injected, undefined);
  assert.equal(after.preload.length, 4);
  assert.equal(after.deferred.length, 1);
});

test("9. 静态契约：零 import 语句、源码无禁词、结果无派发类字段", () => {
  const src = readFileSync(
    new URL("../dreamConsolidator.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(!src.includes("spawn"));
  assert.ok(!src.includes("dispatch"));
  assert.ok(!src.includes("createTicket"));
  assert.equal((src.match(/^\s*import\b/gm) || []).length, 0);
  assert.equal((src.match(/\brequire\s*\(/g) || []).length, 0);

  const forbiddenKeys = ["ticket", "spawn", "dispatch"];
  const collectKeys = (value, keys = []) => {
    if (Array.isArray(value)) {
      for (const v of value) collectKeys(v, keys);
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        keys.push(k);
        collectKeys(v, keys);
      }
    }
    return keys;
  };

  const c = createDreamConsolidator();
  const keys = [
    ...collectKeys(c.consolidate(mixedEntries())),
    ...collectKeys(c.snapshot()),
    ...collectKeys(c.preloadFor("t1")),
    ...collectKeys(c.rebuildIndex()),
    ...collectKeys(c.verify("c1", "外部证据")),
  ];
  for (const k of forbiddenKeys) {
    assert.ok(!keys.includes(k), `结果不应含 ${k} 字段`);
  }
});

test("10. rebuildIndex / preloadFor / quotaFor 按模式配额", () => {
  const c = createDreamConsolidator({ now: () => 99 });
  c.consolidate(mixedEntries());

  const ri = c.rebuildIndex();
  assert.equal(ri.ok, true);
  assert.equal(ri.size, 5);
  assert.deepEqual(ri.index.t3, ["c1"]);
  ri.index.t3.push("外部");
  assert.deepEqual(c.snapshot().index.t3, ["c1"]);

  const pf = c.preloadFor("t3");
  assert.equal(pf.ok, true);
  assert.equal(pf.items.length, 1);
  assert.equal(pf.items[0].id, "c1");
  assert.ok(pf.usedChars <= pf.quota.maxChars);
  assert.deepEqual(c.preloadFor("不存在").items, []);

  const byMode = createDreamConsolidator({
    quotaFor: (mode) =>
      mode === "max" ? { maxPreload: 2 } : { maxPreload: 1 },
  });
  assert.equal(
    byMode.consolidate(highValueEntries(20), { mode: "max" }).stats.preloaded,
    2,
  );
  assert.equal(
    byMode.consolidate(highValueEntries(20), { mode: "normal" }).stats
      .preloaded,
    1,
  );
});
