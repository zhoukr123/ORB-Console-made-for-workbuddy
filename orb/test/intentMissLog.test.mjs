/* 意图未命中日志（2026-11-07 第 3 步）
 * 判据：能聚合、有上限、不丢高频、可清空；原句按原样保留（供人工看），计数按归一化 key 走。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createMissLog, missKey, MAX_MISS_TEXT } from "../intentMissLog.mjs";

test("同形归一：只差标点/空格的同一句话算一条，计数累加", () => {
  assert.equal(missKey("搜一下 X 然后画张图"), missKey("搜一下 X，然后画张图"));
  assert.equal(missKey("搜一下 长沙 天气"), missKey("搜一下长沙天气"));
  const log = createMissLog();
  log.record("搜一下 X 然后画张图", "no-whitelist-match");
  log.record("搜一下 X，然后画张图", "no-whitelist-match");
  const [item] = log.list();
  assert.equal(item.count, 2);
  assert.equal(item.reasonCode, "no-whitelist-match");
  assert.equal(log.stats().unique, 1);
  assert.equal(log.stats().total, 2);
});

test("原句超过上限被截断，空文本不记", () => {
  const log = createMissLog();
  log.record("啊".repeat(500), "bad-query");
  log.record("   ", "bad-query");
  log.record("", "bad-query");
  const items = log.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].text.length, MAX_MISS_TEXT);
});

test("超限淘汰：先淘汰低频，再淘汰更早的（高频句子不许被挤掉）", () => {
  const log = createMissLog({ cap: 2 });
  log.record("高频句 A", "no-whitelist-match");
  log.record("高频句 A", "no-whitelist-match");
  log.record("低频句 B", "no-whitelist-match");
  log.record("低频句 C", "no-whitelist-match");
  const texts = log.list().map((v) => v.text);
  assert.ok(texts.includes("高频句 A"), "高频句子必须留下");
  assert.equal(log.list().length, 2);
});

test("原因码以最新一次为准（同一句先 bad-query 后认出来又被拒）", () => {
  const log = createMissLog();
  log.record("搜一下 X 存到购物车", "bad-query");
  log.record("搜一下 X 存到购物车", "no-whitelist-match");
  assert.equal(log.list()[0].reasonCode, "no-whitelist-match");
  assert.equal(log.list()[0].count, 2);
});

test("列表按次数倒序；stats 按原因码汇总；clear 全部清空", () => {
  const log = createMissLog();
  log.record("A 句 写文档", "no-whitelist-match");
  log.record("B 句 写文档", "no-whitelist-match");
  log.record("B 句 写文档", "no-whitelist-match");
  log.record("C 句", "bad-query");
  assert.equal(log.list()[0].text, "B 句 写文档");
  const s = log.stats();
  assert.equal(s.byReason["no-whitelist-match"], 3);
  assert.equal(s.byReason["bad-query"], 1);
  log.clear();
  assert.equal(log.stats().total, 0);
  assert.equal(log.list().length, 0);
});

test("记录项带 firstAt / lastAt，且不包含任何上下文或凭据字段", () => {
  const log = createMissLog();
  log.record("搜一下 key=SECRET 记到文档", "no-whitelist-match");
  const [item] = log.list();
  assert.ok(item.firstAt > 0 && item.lastAt >= item.firstAt);
  /* 只允许这六个字段：不夹带会话 id、窗口标题、剪贴板内容之类的东西。 */
  assert.deepEqual(
    Object.keys(item).sort(),
    ["count", "firstAt", "key", "lastAt", "reasonCode", "text"],
  );
});
