/* V-01「脱离视觉循环」窄版确定性路由单测。
 *
 * 沿用 tts-queue.test.mjs 的惯例：面板是单文件内联脚本、没有模块边界，
 * 直接 import 不了。这里按 V01_START / V01_END 两个注释标记把 V01 段原样
 * 抽出来，丢进 new Function 里独立跑。
 * 标记一旦被改动 / 抽空，下面会**明确 assert 失败**，绝不静默测了个空。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PANEL = path.join(import.meta.dirname, "..", "desktop", "panel.html");
const src = fs.readFileSync(PANEL, "utf8");

const START = "/* ==== V01_START ==== */";
const END = "/* ==== V01_END ==== */";
const from = src.indexOf(START);
const to = src.indexOf(END, from);
assert.ok(from >= 0, "找不到 V01_START 标记 " + START);
assert.ok(to > from, "找不到 V01_END 标记 " + END);
const block = src.slice(from, to + END.length);
/* 防「测了个空」：抽取段必须真的含编译函数，且 window 暴露必须被 typeof 包住
   （node 里没有 window，裸引用会让 new Function 直接抛 ReferenceError）。 */
assert.ok(block.includes("function compileStructured"), "抽取段为空或不含 compileStructured");
assert.ok(
  /if\s*\(\s*typeof window\s*!==\s*['"]undefined['"]\s*\)/.test(block),
  "window.__orbV01 暴露必须包在 if (typeof window !== 'undefined') 里",
);

/** 每次造一个全新作用域：v01Stats 也随之归零，测试之间不互相污染。 */
function makeEnv() {
  return new Function(block + "; return { compileStructured, v01StatsGet, v01Degrade, v01Structured, V01_DEGRADE_MAP };")();
}
const EMPTY_STATS = { hit: 0, miss: 0, byReason: {}, degraded: 0, byDegradedReason: {}, zeroVlmTasks: 0 };

/* taskText 的固定骨架，逐字比对用（编译结果必须完全确定）。 */
const HEAD = "【结构化任务 · 确定性编译】\n";
const S3 = "取不到的字段标「待确认」，不要编造";
const S4 = "无可用检索结果时返回 degraded + reasonCode，绝不回落到截图或视觉循环";

test("START/END 抽取成功且 V01 段可在无 window 环境独立加载", () => {
  assert.ok(block.length > 500, "抽取段过短，疑似测了个空");
  const env = makeEnv();
  assert.equal(typeof env.compileStructured, "function");
  assert.equal(typeof env.v01StatsGet, "function");
  assert.deepEqual(env.v01StatsGet(), EMPTY_STATS);
});

test("报告B §10.2 / V-09：V01 段暴露降级与零 VLM 埋点入口", () => {
  const env = makeEnv();
  assert.equal(typeof env.v01Degrade, "function");
  assert.equal(typeof env.v01Structured, "function");
  assert.equal(Object.keys(env.V01_DEGRADE_MAP).length, 5);
});

test("三种白名单句型命中：steps/taskText 非空，steps 为 2-4 条中文短句", () => {
  const { compileStructured: compile } = makeEnv();
  const cases = [
    ["搜一下 2026 年 AI 趋势 然后记到文档", "search-and-compose"],
    ["搜索 杭州天气 并整理成表格", "search-and-compose"],
    ["查一下 竞品价格 汇总成清单", "search-and-compose"],
    ["检索 论文 做成报告", "search-and-compose"],
    ["把 这份名单 整理成清单", "compose"],
    ["将 季度数据 整理成表格", "compose"],
    ["对比 A 和 B 整理成表格", "compare"],
    ["比较 甲方案 与 乙方案 做成报告", "compare"],
  ];
  for (const [text, kind] of cases) {
    const r = compile(text);
    assert.equal(r.ok, true, "应命中：" + text);
    assert.equal(r.reasonCode, "whitelist-hit", text);
    assert.equal(r.kind, kind, text);
    assert.equal(typeof r.query, "string", text);
    assert.ok(r.query.length > 0, text);
    assert.equal(typeof r.deliverable, "string", text);
    assert.ok(r.deliverable.length > 0, text);
    assert.ok(Array.isArray(r.plan.steps), text);
    assert.ok(r.plan.steps.length >= 2 && r.plan.steps.length <= 4, "steps 需 2-4 条：" + text);
    for (const st of r.plan.steps) {
      assert.equal(typeof st, "string", text);
      assert.ok(st.length > 0, text);
    }
    assert.equal(typeof r.plan.taskText, "string", text);
    assert.ok(r.plan.taskText.length > 0, text);
  }
});

test("大小写不敏感、允许前后空格", () => {
  const { compileStructured: compile } = makeEnv();
  assert.equal(compile("  搜索 天气 并整理成表格  ").ok, true);
  assert.equal(compile("搜索 天气 并整理成 EXCEL").deliverable, "EXCEL");
  assert.equal(compile("对比 A VS B 做成报告").kind, "compare");
});

test("taskText 为完全确定性的固定拼接（三种 kind 逐字比对）", () => {
  const { compileStructured: compile } = makeEnv();

  assert.equal(
    compile("搜索 天气 并整理成表格").plan.taskText,
    HEAD
      + "1. 检索：天气（只取标题/链接/摘要，need_content=false）\n"
      + "2. 整理为 表格，每条保留来源链接\n"
      + "3. " + S3 + "\n"
      + "4. " + S4,
  );

  /* compose：省略第 1 步「检索」，后续步骤重新编号。 */
  assert.equal(
    compile("把 这份名单 整理成清单").plan.taskText,
    HEAD
      + "1. 整理为 清单，每条保留来源链接\n"
      + "2. " + S3 + "\n"
      + "3. " + S4,
  );

  /* compare：第 1 步写「对比：<a> 与 <b>」。 */
  assert.equal(
    compile("对比 A 和 B 整理成表格").plan.taskText,
    HEAD
      + "1. 对比：A 与 B\n"
      + "2. 整理为 表格，每条保留来源链接\n"
      + "3. " + S3 + "\n"
      + "4. " + S4,
  );
});

test("GUI 意图词 / 多步 GUI 连接词一律被拦（reasonCode='gui-intent'）", () => {
  const { compileStructured: compile } = makeEnv();
  const sentences = [
    "帮我点击屏幕上的按钮然后记到文档",
    "搜索 价格 然后点击按钮 整理成表格",
    "搜一下 资料 然后打开窗口 记到文档",
    "把 数据 整理成表格 并且点击确定",
    "对比 A 和 B 整理成表格 再截图",
    "登录系统后搜索资料整理成报告",
    "检索 数据 做成报告，帮我操作一下界面",
    "搜索 价格 记到文档 并且输入账号",
  ];
  for (const s of sentences) {
    const r = compile(s);
    assert.equal(r.ok, false, "GUI 句不得命中：" + s);
    assert.equal(r.reasonCode, "gui-intent", s);
  }
});

test("普通句子未命中（reasonCode='no-whitelist-match'）", () => {
  const { compileStructured: compile } = makeEnv();
  for (const s of ["今天天气不错", "帮我写一首诗", "讲个笑话", "总结一下会议要点"]) {
    const r = compile(s);
    assert.equal(r.ok, false, s);
    assert.equal(r.reasonCode, "no-whitelist-match", s);
  }
});

test("空捕获 / 超长 / 含换行 / 空串 → bad-shape", () => {
  const { compileStructured: compile } = makeEnv();
  /* 「把」后两个空格：正则回溯后 query 捕获为纯空格，trim 为空。 */
  assert.equal(compile("把  整理成表格").reasonCode, "bad-shape");
  assert.equal(compile("搜索 " + "长".repeat(121) + " 并整理成表格").reasonCode, "bad-shape");
  assert.equal(compile("搜索 价格\n并整理成表格").reasonCode, "bad-shape");
  assert.equal(compile("   ").reasonCode, "bad-shape");
});

test("纯函数：同一输入重复调用结果完全一致", () => {
  const { compileStructured: compile } = makeEnv();
  const inputs = [
    "搜索 天气 并整理成表格",
    "把 名单 整理成清单",
    "对比 A 和 B 整理成表格",
    "帮我点击按钮",
    "把  整理成表格",
    "今天天气不错",
    "  搜索 天气 并整理成 excel  ",
  ];
  for (const s of inputs) {
    const a = JSON.stringify(compile(s));
    const b = JSON.stringify(compile(s));
    const c = JSON.stringify(compile(s));
    assert.equal(a, b, "第 2 次结果漂移：" + s);
    assert.equal(b, c, "第 3 次结果漂移：" + s);
  }
});

test("统计 hit/miss 按 reasonCode 正确累加，快照为深拷贝", () => {
  const { compileStructured: compile, v01StatsGet: stats } = makeEnv();
  assert.deepEqual(stats(), EMPTY_STATS);

  assert.equal(compile("搜索 天气 并整理成表格").ok, true);
  assert.equal(stats().hit, 1);
  assert.equal(stats().byReason["whitelist-hit"], 1);

  compile("帮我点击按钮");     // gui-intent
  compile("今天天气不错");     // no-whitelist-match
  compile("把  整理成表格");   // bad-shape
  const s = stats();
  assert.equal(s.hit, 1);
  assert.equal(s.miss, 3);
  assert.equal(s.byReason["whitelist-hit"], 1);
  assert.equal(s.byReason["gui-intent"], 1);
  assert.equal(s.byReason["no-whitelist-match"], 1);
  assert.equal(s.byReason["bad-shape"], 1);

  /* 快照必须可随意改而不污染内部计数。 */
  const snap = stats();
  snap.hit = 999;
  snap.byReason["gui-intent"] = 999;
  assert.equal(stats().hit, 1);
  assert.equal(stats().byReason["gui-intent"], 1);
});

test("命中结果只有否定式回落护栏，绝不 ok:true 却带 gui-intent", () => {
  const { compileStructured: compile } = makeEnv();
  const hits = [
    "搜索 天气 并整理成表格",
    "把 名单 整理成清单",
    "对比 A 和 B 做成报告",
  ];
  for (const s of hits) {
    const r = compile(s);
    assert.equal(r.ok, true);
    assert.equal(r.reasonCode, "whitelist-hit");
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes("gui-intent"), "命中结果不得含 gui-intent");
    const text = r.plan.taskText;
    assert.equal((text.match(/回落/g) || []).length, 1, "回落指令只能出现一次（否定护栏）");
    assert.ok(text.includes("绝不回落到截图或视觉循环"), "必须是「绝不回落」的否定护栏");
    for (const st of r.plan.steps) {
      assert.ok(!/截图|视觉循环/.test(st), "steps 不得含截图/视觉循环字样：" + st);
    }
  }

  /* 跨全部输入：任何 ok:true 都不得携带 gui-intent，也不得是别的 reasonCode。 */
  const all = [
    ...hits,
    "帮我点击按钮",
    "搜索 价格 然后点击确定 整理成表格",
    "搜一下 资料 然后打开窗口 记到文档",
    "今天天气不错",
    "把  整理成表格",
    "  搜索 天气 并整理成 excel  ",
  ];
  for (const s of all) {
    const r = compile(s);
    if (r.ok) {
      assert.equal(r.reasonCode, "whitelist-hit", "ok:true 却非 whitelist-hit：" + s);
      assert.ok(!JSON.stringify(r).includes("gui-intent"), "ok:true 却带 gui-intent：" + s);
    }
  }
});

/* 报告B §7 第6项：回落从隐式失败变成显式可审计分支。 */
test("回落显式记 degraded + 四类架构 reasonCode，未知原因兜底为编译失败", () => {
  const env = makeEnv();
  const a = env.v01Degrade("gui-intent");
  assert.equal(a.degraded, true);
  assert.equal(a.reasonCode, "needs-pixel-semantics");
  assert.equal(a.stage, "v01-compile");
  assert.equal(a.v01Reason, "gui-intent");
  assert.equal(a.zeroVlm, false);
  assert.equal(env.v01Degrade("bad-shape").reasonCode, "compile-failed");
  assert.equal(env.v01Degrade("no-whitelist-match").reasonCode, "compile-failed");
  assert.equal(env.v01Degrade("tool-indeterminate").reasonCode, "tool-indeterminate");
  assert.equal(env.v01Degrade("tree-incomplete").reasonCode, "tree-incomplete");
  assert.equal(env.v01Degrade("没见过的原因").reasonCode, "compile-failed");
  const s = env.v01StatsGet();
  assert.equal(s.degraded, 6);
  assert.equal(s.byDegradedReason["needs-pixel-semantics"], 1);
  assert.equal(s.byDegradedReason["compile-failed"], 3);
  assert.equal(s.zeroVlmTasks, 0, "降级单不许记成零 VLM 单");
});

test("结构化命中单显式记 0 次 VLM + 人类优先名额", () => {
  const env = makeEnv();
  const m = env.v01Structured("search-and-compose");
  assert.equal(m.route, "structured");
  assert.equal(m.ruleId, "v01:search-and-compose");
  assert.equal(m.zeroVlm, true);
  assert.equal(m.vlmCalls, 0);
  assert.equal(m.priority, "human");
  assert.equal(env.v01StatsGet().zeroVlmTasks, 1);
});
