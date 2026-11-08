/* 意图解析 · 分句 + 跨度截取（2026-11-07 第三轮）
 *
 * 这一轮换掉了「一次非贪婪捕获 + 最多 4 轮剥尾巴」的实现。旧实现的问题不是某一处写错，
 * 而是结构上靠循环收敛：剥一轮又冒出新的尾巴，超过 4 轮就漏；修一处换一处。
 * 现在的判据：查询词由「最近边界」一次截出，因此
 *   · 子句切得开（括号内的标点不算切点）；
 *   · 边界认得准（数量词 / 产物动词 / 标点 / 子句尾）；
 *   · 不再需要循环，叠加噪声多少次都一次剥净；
 *   · 真词不误伤（「合并」「再保险」「前3条数据」）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseProduceIntent, splitClauses, firstRealSearchVerb,
  INTENT_VERBS, ACTIONS,
} from "../searchOrchestrator.mjs";

/* ---------------- 分句 ---------------- */

test("分句：括号内的标点不算切点，括号外的标点一定切", () => {
  const a = splitClauses("搜索一下「V4，正式版」然后写入文件");
  assert.equal(a.length, 1, "「」里的逗号不许切开");
  assert.equal(a[0].text, "搜索一下「V4，正式版」然后写入文件");

  const b = splitClauses("搜一下 A，然后记到文档");
  assert.deepEqual(b.map((c) => c.text), ["搜一下 A", "然后记到文档"]);
  /* 下标要能用：跨度截取靠它定位 */
  assert.equal(b[1].start, 6);
  assert.equal(b[0].start, 0);
});

test("分句：括号不配对时不当作括号，照常按下标切分", () => {
  const r = splitClauses("搜一下 A（未闭合，记到文档");
  assert.equal(r.length, 2, "只出现左括号不该把整句吞成一个子句");
});

/* ---------------- 检索动词识别 ---------------- */

test("「搜索结果 / 检索结果」里的动词不是检索动作（倒装句的关键）", () => {
  assert.equal(firstRealSearchVerb("把 X 的前两条搜索结果整理成文档"), null);
  assert.equal(firstRealSearchVerb("把 X 的检索结果 存到文件"), null);
  const m = firstRealSearchVerb("检索 结构化结果 写入文档");
  assert.ok(m && m.index === 0, "正常句仍认「检索」");
});

/* ---------------- 旧实现在这里会漏 ---------------- */

test("叠加噪声（然后 + 再 + 把）一次剥净，不靠循环收敛", () => {
  /* 旧实现 4 轮上限：这条在 3~4 轮之间收敛，再多一层就漏。 */
  const r = parseProduceIntent("搜一下 长沙 天气 然后 再 把 前三条 复制到剪贴板");
  assert.equal(r.ok, true);
  assert.equal(r.query, "长沙 天气");
  assert.equal(r.count, 3);
  assert.equal(r.sink, "clipboard");

  /* 四层叠加（然后 + 再 + 把 + 的），旧实现必漏，现在一次截断。 */
  const r2 = parseProduceIntent("搜一下 长沙天气 然后 再 把 前两条的 搜索结果 复制到剪贴板");
  assert.equal(r2.ok, true);
  assert.equal(r2.query, "长沙天气");
  assert.equal(r2.count, 2);
});

test("查询词里含产物动词字面时，取最右边那个当真正的产物动词", () => {
  const r = parseProduceIntent("搜一下 生成式 AI 记到文档");
  assert.equal(r.ok, true, "旧实现把「生成」当产物动词，query 为空直接判死");
  assert.equal(r.query, "生成式 AI");
  assert.equal(r.sink, "doc");
});

test("真词不误伤：合并 / 再保险 / 目的 / 内容", () => {
  for (const [text, query] of [
    ["搜一下 合并 记到文档", "合并"],
    ["搜一下 再保险 定义 记到文档", "再保险 定义"],
    ["搜一下 目的 记到文档", "目的"],
    ["搜一下 内容运营 记到文档", "内容运营"],
  ]) {
    const r = parseProduceIntent(text);
    assert.equal(r.ok, true, text);
    assert.equal(r.query, query, text);
  }
});

test("「前N条」若属于查询词，就不当条数要求", () => {
  const r = parseProduceIntent("搜一下 前3条数据 分析 记到文档");
  assert.equal(r.ok, true);
  assert.equal(r.count, 0, "「前3条数据」是查询词的一部分");
  assert.match(r.query, /前3条数据/);
});

test("倒装 + 数量 + 结果，三个都不许残留", () => {
  for (const [text, query, count] of [
    ["把 DeepSeek V4 的前两条搜索结果整理成文档", "DeepSeek V4", 2],
    ["把 ORB 的搜索结果整理成文档", "ORB", 0],
    ["把 ORB 的检索结果 存到文件", "ORB", 0],
  ]) {
    const r = parseProduceIntent(text);
    assert.equal(r.ok, true, text);
    assert.equal(r.query, query, text);
    assert.equal(r.count, count, text);
  }
});

test("产物动词在前、检索动词在后（倒序句）也能切出查询", () => {
  const r = parseProduceIntent("复制到剪贴板：搜一下 长沙天气");
  assert.equal(r.ok, true);
  assert.equal(r.query, "长沙天气");
  assert.equal(r.sink, "clipboard");
});

/* ---------------- 生成样本：语法组合全覆盖 ---------------- */

test("生成样本：礼貌词 × 动词 × 连接词 × 数量 × 产物动词 × 目标，query 一律干净", () => {
  const polites = ["", "帮我", "麻烦你"];
  const verbs = ["搜一下", "搜索", "查找"];
  const queries = ["ORB", "DeepSeek V4", "长沙 天气"];
  const joins = [" ", "，", " 然后", "，然后把"];
  const counts = ["", "前两条", "前3条"];
  const prods = ["记到", "写入", "整理成"];
  const targets = ["文档", "笔记", "文件"];
  let n = 0;
  for (const p of polites) for (const v of verbs) for (const q of queries)
    for (const j of joins) for (const c of counts) for (const pd of prods) for (const tg of targets) {
      const text = `${p}${v} ${q}${j}${c ? c + " " : ""}${pd}${tg}`;
      const r = parseProduceIntent(text);
      assert.equal(r.ok, true, text);
      assert.equal(r.query, q, text);
      assert.equal(r.count, c === "前两条" ? 2 : c === "前3条" ? 3 : 0, text);
      assert.equal(r.sink, "doc", text);
      n++;
    }
  assert.ok(n >= 900, `样本量 ${n} 太小，覆盖不到组合`);
});

test("生成样本：剪贴板落点同样干净（目标词长优先，不被短词抢走）", () => {
  for (const text of [
    "搜一下 ORB 复制到剪贴板",
    "搜一下 ORB 前两条复制到剪贴板",
    "帮我搜一下 ORB，然后把前3条复制到剪贴板",
    "搜一下 ORB 贴到粘贴板",
    "搜一下 ORB 存到剪贴板",
  ]) {
    const r = parseProduceIntent(text);
    assert.equal(r.ok, true, text);
    assert.equal(r.query, "ORB", text);
    assert.equal(r.sink, "clipboard", text);
  }
});

/* ---------------- 词表与动作表的一致性 ---------------- */

test("词表：动词都是非空字符串且不重复；目标词长优先匹配", () => {
  for (const k of Object.keys(INTENT_VERBS)) {
    const arr = INTENT_VERBS[k];
    assert.ok(arr.length > 0, k);
    assert.equal(new Set(arr).size, arr.length, `${k} 有重复词`);
    assert.ok(arr.every((w) => typeof w === "string" && w.trim() === w && w.length > 0), k);
  }
  for (const a of Object.values(ACTIONS)) {
    assert.ok(a.targets.every((w) => w.trim() === w && w.length > 0), a.id);
  }
  /* 「剪贴板」必须优先于「粘贴」被匹配到，否则同一句话会被分流到别的落点。 */
  const r = parseProduceIntent("搜一下 X 复制到剪贴板粘贴");
  assert.equal(r.sink, "clipboard");
});
