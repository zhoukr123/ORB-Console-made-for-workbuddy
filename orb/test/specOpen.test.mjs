/* 不拆句的投机开页（任务 #40）。
 *
 * 锁住的是「零副作用」这条底线：query 只来自已有 plan、只生成搜索引擎 URL、
 * 整句仍完整派后台、不新增派发、不弹系统浏览器。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = fs.readFileSync(path.join(ROOT, "desktop", "panel.html"), "utf8");

const START = "/* ==== SPECOPEN_START ==== */";
const END = "/* ==== SPECOPEN_END ==== */";
const from = PANEL.indexOf(START);
const to = PANEL.indexOf(END, from);
assert.ok(from >= 0, "找不到 SPECOPEN_START");
assert.ok(to > from, "找不到 SPECOPEN_END");
const block = PANEL.slice(from, to);
assert.ok(block.includes("function specOpenPlan"), "抽取段不含 specOpenPlan");

const { specOpenPlan, SPEC_OPEN_MAX_QUERY } = new Function(
  block + "; return { specOpenPlan, SPEC_OPEN_MAX_QUERY };"
)();

test("桥文法命中 → 只生成搜索引擎 URL，query 被编码", () => {
  const text = "搜索 transformer 论文并做总结写成 txt";
  const rec = { text, plan: { ok: true, query: "transformer 论文", sink: "doc" } };
  const s = specOpenPlan(text, rec);
  assert.ok(s);
  assert.equal(s.query, "transformer 论文");
  assert.equal(s.url, "https://cn.bing.com/search?q=" + encodeURIComponent("transformer 论文"));
  assert.ok(s.url.startsWith("https://cn.bing.com/search?q="), "绝不解析站名/域名");
});

test("文本不匹配 → null（上一句的 plan 绝不能用到下一句）", () => {
  const rec = { text: "搜 A 并总结", plan: { ok: true, query: "A" } };
  assert.equal(specOpenPlan("搜 B 并总结", rec), null);
  assert.equal(specOpenPlan("搜 A 并总结 ", rec), null);
});

test("plan 不可用 / 空 query / 超长 query 一律跳过，不猜", () => {
  const text = "搜论文做总结";
  for (const plan of [
    null,
    { ok: false, query: "论文" },
    { query: "论文" },
    { ok: true },
    { ok: true, query: "   " },
    { ok: true, query: "x".repeat(SPEC_OPEN_MAX_QUERY + 1) },
  ]) {
    assert.equal(specOpenPlan(text, { text, plan }), null, "应跳过：" + JSON.stringify(plan));
  }
  assert.equal(specOpenPlan(text, null), null);
});

test("query 里带 URL 也只当搜索词，不会被当作目标站点打开", () => {
  const text = "搜 https://arxiv.org/abs/1234 并总结";
  const s = specOpenPlan(text, { text, plan: { ok: true, query: "https://arxiv.org/abs/1234" } });
  assert.ok(s);
  assert.ok(s.url.startsWith("https://cn.bing.com/search?q="));
  assert.ok(!s.url.includes("arxiv.org/abs") || s.url.includes("%2F"), "斜杠必须被编码");
});

test("接线：整句仍完整派后台、投机开页不阻塞、不额外发 plan 请求", () => {
  assert.match(PANEL, /async function quickWebOpen\(url, opts\)/, "quickWebOpen 必须接 opts");
  assert.match(PANEL, /if \(channelOnly\) return 'fail'/, "通道离线不许弹系统浏览器");
  assert.match(PANEL, /quickWebOpen\(s\.url, \{ quiet: true, channelOnly: true \}\)\.catch/,
    "投机开页必须 quiet + channelOnly + 不 await");
  assert.match(PANEL, /try \{ maybeSpecOpen\(text\); \} catch \{\}\s*\n\s*await runBack\(task, \{ prefetchText: text \}\)/,
    "投机开页必须在完整派发之前，且派发参数不变");
  assert.equal((PANEL.match(/post\('\/api\/search\/plan', \{ text \}\)/g) || []).length, 1,
    "不得新增 /api/search/plan 请求（打字期预取会灌满 intentMiss 日志）");
  assert.match(PANEL, /lastSearchPlan = \{ text: String\(text\), plan: plan \|\| null \}/,
    "plan 结果必须被复用");
  assert.equal((PANEL.match(/idempotencyKey: idemForSend\(taskText\)/g) || []).length, 1,
    "幂等键仍是一次用户意图一个");
});
