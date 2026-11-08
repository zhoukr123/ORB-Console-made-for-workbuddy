/* 意图解析 · 规范化预处理 + 词表别名（2026-11-07 第 4 轮）
 *
 * 目的：把「输入形状」的差异挡在解析之前，让文法只面对一种干净的写法。
 *   · 零宽字符 / 全角空格 / 连续空格 → 归一（否则「\u200b前两条」认不出数量）；
 *   · 全角数字、繁体数量单位 → 识别（「前５条」「前兩條」都是一个意思）；
 *   · 繁简与常见同义说法 → 收进词表（加一行就能扩，不改解析逻辑）。
 * 判据同时包含「不能过度归一」：全角标点是用户原文，剥了就是篡改查询词。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProduceIntent, normalizeText, toHalfWidth, INTENT_VERBS, ACTIONS, orchestratorSchema,
} from "../searchOrchestrator.mjs";

test("规范化：零宽字符与全角空格被清掉，全角标点保持原样", () => {
  assert.equal(normalizeText("\u200b搜一下\u200b ORB"), "搜一下 ORB");
  assert.equal(normalizeText("搜一下\u3000ORB\u3000记到文档"), "搜一下 ORB 记到文档");
  assert.equal(normalizeText("搜一下   ORB   记到文档"), "搜一下 ORB 记到文档");
  /* 全角逗号属于用户原文，不许在规范化阶段改成半角。 */
  assert.equal(normalizeText("「V4，正式版」"), "「V4，正式版」");
  assert.equal(normalizeText("\ufeff"), "");
  assert.equal(normalizeText(null), "");
});

test("规范化：零宽字符夹在数量词里也照样认出数量", () => {
  const r = parseProduceIntent("搜一下\u200bORB 前\u200b两条 记到文档");
  assert.equal(r.ok, true);
  assert.equal(r.query, "ORB");
  assert.equal(r.count, 2);
});

test("全角数字：前５条 = 前5条（但不许改写查询词里的全角字符）", () => {
  const r = parseProduceIntent("搜一下 ORB 前５条结果写入文档");
  assert.equal(r.ok, true);
  assert.equal(r.count, 5);
  assert.equal(r.query, "ORB");

  const q = parseProduceIntent("搜一下 ＯＲＢ ５Ｇ 记到文档");
  assert.equal(q.ok, true);
  assert.equal(q.query, "ＯＲＢ ５Ｇ", "查询词里的全角字符是用户原文，不做归一");
  assert.equal(toHalfWidth("ＯＲＢ５Ｇ"), "ORB5G");
});

test("繁体输入：动词 / 目标词 / 数量单位都在词表里", () => {
  for (const [text, query, count, sink] of [
    ["搜尋 ORB 前兩條 記到文檔", "ORB", 2, "doc"],
    ["幫我查詢 DeepSeek 存到檔案", "DeepSeek", 0, "doc"],
    ["搜一下 ORB 複製到剪貼簿", "ORB", 0, "clipboard"],
    ["搜一下 ORB 前兩個 貼到黏貼板", "ORB", 2, "clipboard"],
    ["搜一下 ORB 彙總成清單", "ORB", 0, "doc"],
  ]) {
    const r = parseProduceIntent(text);
    assert.equal(r.ok, true, text);
    assert.equal(r.query, query, text);
    assert.equal(r.count, count, text);
    assert.equal(r.sink, sink, text);
  }
});

test("词表别名不引入重复，也不让短词抢走长词的落点", () => {
  for (const k of Object.keys(INTENT_VERBS)) {
    assert.equal(new Set(INTENT_VERBS[k]).size, INTENT_VERBS[k].length, k);
  }
  for (const a of Object.values(ACTIONS)) {
    assert.equal(new Set(a.targets).size, a.targets.length, a.id);
  }
  /* 「剪贴板」必须在「粘贴」之前命中，否则同一句话会被分到别的落点。 */
  assert.equal(parseProduceIntent("搜一下 X 复制到剪贴板粘贴").sink, "clipboard");
  assert.equal(parseProduceIntent("搜一下 X 存到剪贴板文件").sink, "clipboard");
});

test("schema 里的粗筛词集覆盖全部别名（面板据此构造粗筛，不会漏问）", () => {
  const s = orchestratorSchema();
  const coarse = new Set([
    ...s.coarse.search, ...s.coarse.produce, ...s.coarse.targets,
  ]);
  for (const w of INTENT_VERBS.search) assert.ok(coarse.has(w), `粗筛缺检索动词：${w}`);
  for (const w of INTENT_VERBS.produce) assert.ok(coarse.has(w), `粗筛缺产物动词：${w}`);
  for (const a of Object.values(ACTIONS)) {
    for (const w of a.targets) assert.ok(coarse.has(w), `粗筛缺目标词：${w}`);
  }
});

test("多行输入在规范化之前就被拒（不能靠归一空格掩盖换行）", () => {
  assert.equal(parseProduceIntent("搜一下 ORB\n记到文档").ok, false);
  assert.equal(parseProduceIntent("搜一下 ORB\r\n记到文档").ok, false);
  /* 零宽字符不算换行：去掉之后仍然是一行，应当通过。 */
  assert.equal(parseProduceIntent("搜一下 ORB\u200b 记到文档").ok, true);
});
