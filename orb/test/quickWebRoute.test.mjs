/* 「确定性网页指令」快速路的判据测试（2026-11-06 事故驱动）。
 *
 * 事故：用户说「搜一下 DeepSeek Super Agent 将返回的第一条结果中的内容原样复制至记事本」，
 * 面板把它整句当成搜索词塞进 Bing —— 因为旧判据只看连接词（然后/并且），
 * 而这句话没有连接词，却明显是两步（搜索 + 复制到记事本）。
 *
 * 沿 structuredCompile.test.mjs 的惯例：按 QUICKWEB_START / QUICKWEB_END 抽段，
 * 丢进 new Function 独立跑。标记被改动就 assert 失败，绝不静默测了个空。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PANEL = path.join(import.meta.dirname, "..", "desktop", "panel.html");
const src = fs.readFileSync(PANEL, "utf8");

const START = "/* ==== QUICKWEB_START ==== */";
const END = "/* ==== QUICKWEB_END ==== */";
const from = src.indexOf(START);
const to = src.indexOf(END, from);
assert.ok(from >= 0, "找不到 QUICKWEB_START");
assert.ok(to > from, "找不到 QUICKWEB_END");
const block = src.slice(from, to);
assert.ok(block.includes("function parseQuickWeb"), "抽取段不含 parseQuickWeb");
assert.ok(block.includes("QUICK_WEB_SECOND_ACT"), "抽取段不含第二动作判据");

const env = new Function(block + "; return { parseQuickWeb, quickWebClean, quickWebUrl };")();

test("事故原句：带「复制至记事本」的多步任务不进快速路", () => {
  const s = "搜一下 DeepSeek Super Agent 将返回的第一条结果中的内容原样复制至记事本";
  assert.equal(env.parseQuickWeb(s), null, "整句塞进搜索引擎等于什么也没做");
  /* 同类：提取 / 保存 / 前三条 / 剪贴板，都该被拦住。 */
  for (const m of [
    "搜一下 长沙天气 提取第一条",
    "搜索 湖南大学 官网 保存下来",
    "搜一下 考研分数线 前三条",
    "搜一下 报价 复制到剪贴板",
  ]) {
    assert.equal(env.parseQuickWeb(m), null, "应判为多步：" + m);
  }
});

test("单纯的搜索/打开仍然走快速路（不许因为修 bug 把正常路径也堵死）", () => {
  assert.deepEqual(env.parseQuickWeb("搜一下 DeepSeek V4 发布"), { kind: "search", v: "DeepSeek V4 发布" });
  assert.deepEqual(env.parseQuickWeb("打开湖南大学官网"), { kind: "open", v: "湖南大学官网" });
  assert.deepEqual(env.parseQuickWeb("在 Chrome 打开湖南大学官网"), { kind: "open", v: "湖南大学官网" });
});

test("连接词判据仍然生效（两种判据是并存，不是替换）", () => {
  assert.equal(env.parseQuickWeb("打开湖南大学官网然后搜索招生"), null);
  assert.equal(env.parseQuickWeb("搜索 DeepSeek 顺便打开官网"), null);
});

test("研究型搜索不进快速路（既有护栏没被破坏）", () => {
  assert.equal(env.parseQuickWeb("搜索 DeepSeek V4 并做对比分析"), null);
  assert.equal(env.parseQuickWeb("总结一下 湖南大学 官网"), null);
});

test("URL 生成：域名直开，站名走搜索", () => {
  assert.equal(env.quickWebUrl({ kind: "open", v: "hunan.edu.cn" }), "https://hunan.edu.cn");
  assert.equal(env.quickWebUrl({ kind: "open", v: "https://a.com/x" }), "https://a.com/x");
  assert.match(env.quickWebUrl({ kind: "search", v: "湖南大学" }), /^https:\/\/cn\.bing\.com\/search\?q=/);
});

/* 2026-11-08 事故：用户说「帮我在夸克浏览器中搜索湖南大学并进入其官网」，
   桥侧抢跑成「用夸克搜」，关键词被拼成「浏览器 湖南大学并进入其官网」。
   这里锁桥不在线时的退化路径：至少给出干净搜索词，不许脏 query。 */
test("事故句：浏览器状语剥掉，第二步动作不塞进搜索词", () => {
  assert.deepEqual(
    env.parseQuickWeb("帮我在夸克浏览器中搜索湖南大学并进入其官网"),
    { kind: "search", v: "湖南大学", landing: true }
  );
  /* 单步版本：只剩干净关键词 */
  assert.deepEqual(env.parseQuickWeb("在夸克浏览器中搜索 湖南大学"), { kind: "search", v: "湖南大学" });
  assert.deepEqual(env.parseQuickWeb("用Chrome搜一下 湖南大学"), { kind: "search", v: "湖南大学" });
});

test("落地补语不误伤「打开官网」这种一步到位的指令", () => {
  assert.deepEqual(env.parseQuickWeb("打开湖南大学官网"), { kind: "open", v: "湖南大学官网" });
  assert.deepEqual(env.parseQuickWeb("在夸克浏览器中打开湖南大学官网"), { kind: "open", v: "湖南大学官网" });
});
