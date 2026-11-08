/* semanticRouter 单测：四档命中 / 视觉优先 / 只读 observe / 拒绝 auto /
 * savesTime 恒 false / 统计与样本 / 非法入参 / 判定确定性。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createSemanticRouter, TIERS } from "../semanticRouter.mjs";

const mk = (o = {}) => createSemanticRouter({ now: () => 1000, ...o });

test("API 契约：导出四档 TIERS，实例只暴露五个方法", () => {
  assert.deepEqual(TIERS, ["direct", "front", "vision", "back"]);
  const r = mk();
  assert.deepEqual(Object.keys(r).sort(), ["classify", "mode", "samples", "setMode", "stats"].sort());
});

test("direct 档：明确的文件读取指令走确定性档", () => {
  const r = mk();
  const res = r.classify("读一下这个文件的内容");
  assert.equal(res.ok, true);
  assert.equal(res.tier, "direct");
  assert.ok(res.tags.includes("文件操作"));
  assert.equal(res.savesCredits, true);
  assert.match(res.reason, /确定性/);
});

test("direct 档：纯计算也走确定性档", () => {
  const r = mk();
  const res = r.classify("计算 37 乘以 19 等于多少");
  assert.equal(res.tier, "direct");
  assert.ok(res.tags.includes("纯计算"));
});

test("vision 档：看屏幕/点击类指令必须落到视觉档", () => {
  const r = mk();
  const res = r.classify("帮我看一下屏幕右下角的按钮");
  assert.equal(res.tier, "vision");
  assert.ok(res.tags.includes("看屏幕"));
  assert.equal(res.savesCredits, false);
  assert.match(res.reason, /视觉/);
});

test("back 档：纯文本总结走后台档", () => {
  const r = mk();
  const res = r.classify("把这段会议记录总结成三条要点");
  assert.equal(res.tier, "back");
  assert.ok(res.tags.includes("总结"));
  assert.equal(res.savesCredits, false);
});

test("front 档：没有明确特征时落到通用前台", () => {
  const r = mk();
  const res = r.classify("帮我安排一下周三的行程");
  assert.equal(res.tier, "front");
  assert.deepEqual(res.tags, []);
  assert.ok(res.score < 0.5, "默认档置信度应偏低");
});

test("视觉优先级高于确定性：同句命中两类时仍判 vision", () => {
  const r = mk();
  const text = "截图后保存这个文件";
  // 先确认这句确实同时命中两类特征
  assert.equal(/截图/.test(text), true);
  assert.equal(/(保存)(一下|下)?(这个|那个|这份|该)?(文件|文件夹|目录|路径)/.test(text), true);
  const res = r.classify(text);
  assert.equal(res.tier, "vision");
  assert.ok(res.tags.includes("截图"));
  assert.ok(res.score <= 0.86, "存在冲突特征时应降权，不允许满分");
});

test("只读模式：默认 observe，classify 只给建议", () => {
  const r = mk();
  assert.equal(r.mode(), "observe");
  const res = r.classify("生成一段产品文案");
  assert.equal(res.ok, true);
  assert.equal(res.tier, "back");
  // 结果里只有建议字段，没有任何调度指令
  assert.equal(res.action, undefined);
  assert.equal(res.dispatch, undefined);
  assert.equal(res.execute, undefined);
});

test("setMode 拒绝 auto；off 后不再产出建议", () => {
  const r = mk();
  const auto = r.setMode("auto");
  assert.equal(auto.ok, false);
  assert.equal(auto.error, "auto-not-allowed");
  assert.equal(r.mode(), "observe", "被拒后模式不得改变");

  assert.equal(r.setMode("nope").ok, false);
  assert.equal(r.mode(), "observe");

  assert.equal(r.setMode("off").ok, true);
  assert.equal(r.mode(), "off");
  const off = r.classify("读一下这个文件的内容");
  assert.equal(off.ok, false);
  assert.equal(off.error, "router-off");
  assert.equal(r.stats().total, 0, "关闭态不记样本");
});

test("savesTime 恒为 false，savesCredits 仅在 direct 为 true", () => {
  const r = mk();
  const texts = [
    "读一下这个文件的内容",
    "帮我看一下屏幕上的窗口",
    "把这段话总结一下",
    "帮我安排一下周三的行程",
  ];
  const seen = new Set();
  for (const t of texts) {
    const res = r.classify(t);
    assert.equal(res.savesTime, false, `"${t}" 的 savesTime 必须为 false`);
    assert.equal(res.savesCredits, res.tier === "direct");
    seen.add(res.tier);
  }
  assert.equal(seen.size, 4, "四条样例应覆盖四个档位");
});

test("stats 按档计数，observedCreditsSaved 恒为 0", () => {
  const r = mk();
  r.classify("读一下这个文件的内容");
  r.classify("列出这个目录的文件");
  r.classify("帮我看一下屏幕上的窗口");
  const s = r.stats();
  assert.equal(s.ok, true);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byTier, { direct: 2, front: 0, vision: 1, back: 0 });
  assert.equal(s.observedCreditsSaved, 0, "观察模式没有真的省下积分");
  assert.match(s.note, /积分/);
  assert.match(s.note, /不.*时间|不是时间/);
});

test("samples 新的在前，且受 limit 约束", () => {
  const r = mk();
  r.classify("第一条：读一下这个文件的内容");
  r.classify("第二条：把这段话总结一下");
  r.classify("第三条：帮我看一下屏幕上的窗口");
  const all = r.samples();
  assert.equal(all.ok, true);
  assert.equal(all.count, 3);
  assert.match(all.samples[0].text, /第三条/);
  assert.match(all.samples[2].text, /第一条/);

  const one = r.samples({ limit: 1 });
  assert.equal(one.count, 1);
  assert.match(one.samples[0].text, /第三条/);
});

test("非法入参不抛，一律返回 ok:false", () => {
  const r = mk();
  for (const bad of [null, undefined, 123, {}, [], true, () => {}]) {
    const res = r.classify(bad);
    assert.equal(res.ok, false);
    assert.equal(res.error, "bad-input");
  }
  assert.equal(r.classify("   ").error, "empty-text");
  assert.equal(r.stats().total, 0, "被拒的入参不计入统计");
  // samples 的非法参数同样不抛
  assert.equal(r.samples({ limit: -3 }).count, 0);
  assert.equal(r.samples(null).ok, true);
});

test("判定确定性：同一输入两次结果完全一致", () => {
  const a = mk();
  const b = mk();
  const text = "先把截图存成 png，再总结一下界面上的按钮";
  assert.equal(JSON.stringify(a.classify(text)), JSON.stringify(b.classify(text)));
  assert.equal(JSON.stringify(a.classify(text)), JSON.stringify(a.classify(text)));
});

test("超长文本截断到 120 字，且不切碎 emoji", () => {
  const r = mk();
  const long = "啊".repeat(200);
  assert.equal(r.classify(long).text.length, 120);
  const emoji = "🙂".repeat(200);
  const res = r.classify(emoji);
  assert.equal(Array.from(res.text).length, 120);
  assert.equal(res.text.includes("\uFFFD"), false);
});
