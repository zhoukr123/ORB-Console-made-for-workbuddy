/* schema 约束兜底（2026-11-07 第 4 步）
 *
 * 这一层的价值不在「能问模型」，而在「问了也编不出东西」：
 *   · 只在 no-whitelist-match 触发（刻意拒绝的场景不兜底）；
 *   · action 必须落在动作表里，sink 由表决定；
 *   · query 必须是原句里已有的片段（子串校验）—— 模型只能划重点，不能造内容；
 *   · 任何不合规 → 返回 null，调用方保持原拒绝（fail-closed）。
 * 另判据：默认关（不外呼）、命中缓存不重复外呼、失败不写负缓存。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createIntentFallback, needsFallback, validateIntentResult, extractJson,
  buildIntentSystemPrompt, buildIntentUserPrompt, FALLBACK_CACHE_MAX,
} from "../intentFallback.mjs";
import { ACTIONS } from "../searchOrchestrator.mjs";

const TEXT = "帮我搜一下长沙天气，把结果整理到我的备忘录里";

test("触发条件：只兜「文法没认出来」，刻意拒绝的不兜", () => {
  assert.equal(needsFallback({ ok: false, reasonCode: "no-whitelist-match" }), true);
  assert.equal(needsFallback({ ok: false, reasonCode: "unsupported-format" }), false);
  assert.equal(needsFallback({ ok: false, reasonCode: "bad-query" }), false);
  assert.equal(needsFallback({ ok: true, query: "x" }), false);
  assert.equal(needsFallback(null), false);
});

test("校验：action 必须在动作表里，sink 由表决定而不用模型给的", () => {
  const ok = validateIntentResult(TEXT, { action: "search-to-doc", query: "长沙天气", count: 2 });
  assert.equal(ok.ok, true);
  assert.equal(ok.sink, ACTIONS["search-to-doc"].sink);
  assert.equal(ok.format, ACTIONS["search-to-doc"].formats[0]);
  assert.equal(ok.via, "llm");
  assert.equal(ok.zeroVlm, true);

  assert.equal(validateIntentResult(TEXT, { action: "search-to-calendar", query: "长沙天气" }), null);
  assert.equal(validateIntentResult(TEXT, { action: null, query: "长沙天气" }), null);
  assert.equal(validateIntentResult(TEXT, null), null);
  /* 模型自报 sink 也没用：落点只认动作表。 */
  const s = validateIntentResult(TEXT, { action: "search-to-doc", sink: "clipboard", query: "长沙天气" });
  assert.equal(s.sink, "doc");
});

test("校验：query 必须是原句子串，编造 / 改写 / 翻译一律拒", () => {
  /* 原句里确实有「长沙天气」 */
  assert.ok(validateIntentResult(TEXT, { action: "search-to-doc", query: "长沙天气" }));
  /* 空白差异不算编造 */
  assert.ok(validateIntentResult("搜一下 长沙 天气 记到文档", { action: "search-to-doc", query: "长沙天气" }));
  /* 补全 / 翻译 / 换个更"专业"的说法 → 都不是原句片段 */
  assert.equal(validateIntentResult(TEXT, { action: "search-to-doc", query: "长沙天气预报" }), null);
  assert.equal(validateIntentResult(TEXT, { action: "search-to-doc", query: "Changsha weather" }), null);
  assert.equal(validateIntentResult(TEXT, { action: "search-to-doc", query: "" }), null);
  assert.equal(validateIntentResult(TEXT, { action: "search-to-doc", query: "长沙\n天气" }), null);
  assert.equal(validateIntentResult(TEXT, { action: "search-to-doc", query: "长".repeat(200) }), null);
});

test("校验：count 夹在 0..上限，非法值当没说", () => {
  /* 上限是 MAX_DOC_ENTRIES_LIMIT（10），不是默认的 3 条：默认值只在 count=0 时由下游补。 */
  assert.equal(validateIntentResult(TEXT, { action: "search-to-doc", query: "长沙天气", count: 99 }).count, 10);
  assert.equal(validateIntentResult(TEXT, { action: "search-to-doc", query: "长沙天气", count: -1 }).count, 0);
  assert.equal(validateIntentResult(TEXT, { action: "search-to-doc", query: "长沙天气", count: "两条" }).count, 0);
  assert.equal(validateIntentResult(TEXT, { action: "search-to-doc", query: "长沙天气", count: 1.9 }).count, 1);
});

test("JSON 提取：容忍代码块与前后废话", () => {
  assert.deepEqual(extractJson('```json\n{"action":null}\n```'), { action: null });
  assert.deepEqual(extractJson('好的：{"action":"search-to-doc"} 以上'), { action: "search-to-doc" });
  assert.equal(extractJson("没有 JSON"), null);
  assert.equal(extractJson("{坏掉的}"), null);
});

test("默认关：不 enabled 就绝不外呼", async () => {
  let calls = 0;
  const fb = createIntentFallback({ llm: async () => { calls++; return "{}"; } });
  assert.equal(fb.enabled, false);
  assert.equal(await fb.resolve(TEXT), null);
  assert.equal(calls, 0);
});

test("一次外呼 + 命中缓存：同一句话不重复问模型，负缓存也算命中", async () => {
  let calls = 0;
  const fb = createIntentFallback({
    enabled: true,
    llm: async () => { calls++; return '{"action":"search-to-doc","query":"长沙天气","count":2}'; },
  });
  const a = await fb.resolve(TEXT);
  assert.equal(a.ok, true);
  assert.equal(a.query, "长沙天气");
  const b = await fb.resolve(TEXT);
  assert.equal(b.ok, true);
  assert.equal(calls, 1, "第二次必须命中缓存");
  assert.equal(fb.stat.calls, 1);
  assert.equal(fb.stat.hits, 1);

  /* 负缓存：模型说「不是这类任务」，同一句也不再问 */
  let negCalls = 0;
  const fb2 = createIntentFallback({
    enabled: true,
    llm: async () => { negCalls++; return '{"action":null}'; },
  });
  assert.equal(await fb2.resolve(TEXT), null);
  assert.equal(await fb2.resolve(TEXT), null);
  assert.equal(negCalls, 1);
  assert.equal(fb2.stat.negHits, 1);
});

test("模型报错不写负缓存：网络抖动不该让同一句话永久失效", async () => {
  let calls = 0;
  const fb = createIntentFallback({
    enabled: true,
    llm: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
      return '{"action":"search-to-doc","query":"长沙天气"}';
    },
  });
  assert.equal(await fb.resolve(TEXT), null, "第一次失败 → 保持原拒绝");
  const second = await fb.resolve(TEXT);
  assert.equal(second.ok, true, "第二次必须重试并成功");
  assert.equal(calls, 2);
  assert.equal(fb.stat.errors, 1);
});

test("缓存有上限，不会随会话无限增长", async () => {
  const fb = createIntentFallback({
    enabled: true,
    llm: async () => '{"action":"search-to-doc","query":"长沙天气"}',
  });
  for (let i = 0; i < FALLBACK_CACHE_MAX + 20; i++) {
    await fb.resolve(TEXT + " " + i);
  }
  assert.ok(fb.size <= FALLBACK_CACHE_MAX, `缓存 ${fb.size} 超过上限`);
});

test("提示词把可选项与硬约束写死，且不含任何凭据", () => {
  const sys = buildIntentSystemPrompt();
  for (const id of Object.keys(ACTIONS)) assert.ok(sys.includes(id), id);
  assert.match(sys, /原样摘出/);
  assert.match(sys, /不许改写/);
  assert.match(sys, /不要猜/);
  assert.ok(!/apiKey|token|bearer/i.test(sys));
  assert.equal(buildIntentUserPrompt(TEXT), "原句：" + TEXT);
  assert.ok(buildIntentUserPrompt("x".repeat(999)).length <= 220, "原句过长要截断");
});
