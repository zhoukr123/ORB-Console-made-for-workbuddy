/* 多子句组合 + 低置信澄清（2026-11-07 第 5 步）
 *
 * 真实输入很少是「一个动词 + 一个查询 + 一个目标」的教科书句子，更常见的是：
 *   搜一下 X，然后把前三条复制到剪贴板      （数量在后一个子句）
 *   复制到剪贴板：搜一下 X                  （产物动词在前）
 *   搜一下 A 记到文档，搜一下 B 复制到剪贴板（一句话两个任务）
 * 这一层的判据：
 *   · 跨子句的数量/落点能继承，查询词只取自己那个子句；
 *   · 一句话两个任务时，执行第一个但**标记低置信**，不许假装两个都做了；
 *   · 只有一个任务、一个落点时，confidence 必须是 high（不许狼来了）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseProduceIntent, splitClauses, orchestratorSchema } from "../searchOrchestrator.mjs";

test("数量写在后一个子句：查询取子句一，条数取子句二", () => {
  for (const [text, query, count, sink] of [
    ["搜一下 长沙天气，然后把前三条复制到剪贴板", "长沙天气", 3, "clipboard"],
    ["搜一下 ORB，前两条记到文档", "ORB", 2, "doc"],
    ["搜一下 DeepSeek V4，再整理成文档", "DeepSeek V4", 0, "doc"],
    ["搜一下 考研分数线，前5条结果写入文件", "考研分数线", 5, "doc"],
  ]) {
    const r = parseProduceIntent(text);
    assert.equal(r.ok, true, text);
    assert.equal(r.query, query, text);
    assert.equal(r.count, count, text);
    assert.equal(r.sink, sink, text);
    assert.equal(r.confidence, "high", text);
    assert.equal(r.clarify, null, text);
  }
});

test("产物动词在前、检索动词在后（倒序句）", () => {
  for (const [text, query, sink] of [
    ["复制到剪贴板：搜一下 长沙天气", "长沙天气", "clipboard"],
    ["记到文档：检索 ORB 前三条", "ORB", "doc"],
  ]) {
    const r = parseProduceIntent(text);
    assert.equal(r.ok, true, text);
    assert.equal(r.query, query, text);
    assert.equal(r.sink, sink, text);
  }
});

test("三个子句叠噪声：查询依然只取检索动词那一段", () => {
  const text = "帮我搜一下 长沙 天气，然后 再 把 前三条 复制到剪贴板，最后打开记事本";
  const r = parseProduceIntent(text);
  assert.equal(r.ok, true);
  assert.equal(r.query, "长沙 天气");
  assert.equal(r.count, 3);
  assert.equal(r.sink, "clipboard");
});

test("一句话两个任务：执行第一个，但如实标低置信", () => {
  const r = parseProduceIntent("搜一下 A 记到文档，搜一下 B 复制到剪贴板");
  assert.equal(r.ok, true);
  assert.equal(r.query, "A", "只取第一个任务的查询词");
  assert.equal(r.confidence, "low");
  assert.equal(r.clarify.reason, "multiple-requests");
  assert.equal(r.clarify.count, 2);
});

test("一句话两个落点：按最后说的做，同时标低置信", () => {
  const r = parseProduceIntent("搜一下 X 整理成文档 并复制到剪贴板");
  assert.equal(r.ok, true);
  assert.equal(r.query, "X");
  assert.equal(r.sink, "clipboard", "靠后的落点是最新意图");
  assert.equal(r.confidence, "low");
  assert.equal(r.clarify.reason, "multiple-sinks");
  assert.deepEqual([...r.clarify.actions].sort(), ["search-to-clipboard", "search-to-doc"]);
});

test("同一子句里的两个检索动词不算两个任务（「ORB 检索」是真查询词）", () => {
  const r = parseProduceIntent("搜一下 ORB 检索 然后记到文档");
  assert.equal(r.ok, true);
  assert.equal(r.query, "ORB 检索");
  assert.equal(r.confidence, "high", "同子句内的动词字面不是第二个任务");
});

test("低置信只在真有歧义时出现，不许狼来了", () => {
  const highConfidence = [
    "搜一下 ORB 前三条记到文档",
    "检索 结构化结果 写入文档",
    "把 DeepSeek V4 的前两条搜索结果整理成文档",
    "帮我查找 长沙 天气 存到文件",
    "找找 考研分数线 整理成文档",
    "搜一下 长沙天气，把前两条复制到剪贴板",
  ];
  for (const t of highConfidence) {
    const r = parseProduceIntent(t);
    assert.equal(r.ok, true, t);
    assert.equal(r.confidence, "high", t);
  }
});

test("schema 暴露可解释的 clarify reason，面板据此补说明", () => {
  const s = orchestratorSchema();
  assert.deepEqual([...s.clarifyReasons].sort(), ["multiple-requests", "multiple-sinks"]);
  /* 只列原因码，不带任何分数：分数解释不了，也测不了。 */
  assert.ok(!("confidence" in s));
});

test("分句粒度：三子句切成三段，标点不进子句", () => {
  const cls = splitClauses("搜一下 A，然后把前三条复制到剪贴板，最后打开记事本");
  assert.equal(cls.length, 3);
  assert.ok(cls.every((c) => !/[，,]/.test(c.text)));
});
