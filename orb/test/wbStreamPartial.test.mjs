/* 后台 CLI 真流式（--include-partial-messages）的回归单测。
 *
 * bridge.mjs 是主程序、import 会起服务，不能直接在测试里引。沿用
 * structuredCompile.test.mjs 的惯例：按 WB_PARTIAL_START / WB_PARTIAL_END 注释标记
 * 把纯状态机原样抽出来，丢进 new Function 独立跑；接线部分用源码静态契约锁住。
 *
 * 背景（2026-11-07 用户反馈）：「未实现真正的流式输出，而是每隔一段时间输出一份内容」。
 * 根因：stream-json 不带 --include-partial-messages 时，只在**整条 assistant 消息写完**
 * 才吐一行；再叠加 350ms 的 sink 节流，观感就是隔十几秒蹦一整段。
 *
 * 本机实测（codebuddy.exe --help）确认支持：
 *   --verbose / --output-format stream-json / --include-partial-messages
 *   （后者注明 "Output raw SSE incremental messages ... only works with --output-format stream-json"）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const BRIDGE = path.join(import.meta.dirname, "..", "bridge.mjs");
const src = fs.readFileSync(BRIDGE, "utf8");

const START = "/* ==== WB_PARTIAL_START ====";
const END = "/* ==== WB_PARTIAL_END ==== */";
const from = src.indexOf(START);
const to = src.indexOf(END, from);
assert.ok(from >= 0, "找不到 WB_PARTIAL_START 标记");
assert.ok(to > from, "找不到 WB_PARTIAL_END 标记");
const block = src.slice(from, to + END.length);
assert.ok(block.includes("function applyStreamEvent"), "抽取段为空或不含 applyStreamEvent");

function makeEnv() {
  return new Function(block + "; return { applyStreamEvent, commitStreamPreview };")();
}
const { applyStreamEvent, commitStreamPreview } = makeEnv();
const empty = () => ({ text: "", preview: "", partialSeen: false });
/** 依次喂事件，返回最终状态与每一步的结果。 */
function feed(events) {
  let st = empty();
  const steps = [];
  for (const ev of events) {
    const r = applyStreamEvent(st, ev);
    steps.push(r);
    st = { text: r.text, preview: r.preview, partialSeen: r.partialSeen };
  }
  return { st, steps };
}
const delta = (text) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const assistant = (text, tools = []) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }, ...tools.map((name) => ({ type: "tool_use", name }))] },
});
/** 面板每一帧实际看到的文本。 */
const shown = (st) => st.text + st.preview;

/* ---------- 1. 状态机：增量、提交、不重复 ---------- */

test("抽取段可在无 Node 全局的环境独立加载", () => {
  const env = makeEnv();
  assert.equal(typeof env.applyStreamEvent, "function");
  assert.equal(typeof env.commitStreamPreview, "function");
  assert.ok(block.length > 1000, "抽取段过短，疑似测了个空");
});

test("三种增量外壳都能取到文字，逐 token 推进预览", () => {
  const cases = [
    delta("你"),
    { type: "content_block_delta", delta: { type: "text_delta", text: "好" } },
    { type: "text_delta", text: "呀" },
    { type: "stream_event", delta: { type: "text_delta", text: "！" } },  // 没带 .event 的包装
    { type: "content_block_delta", delta: { text: "…" } },               // 老实现不写 delta.type
  ];
  const { st, steps } = feed(cases);
  assert.deepEqual(steps.map((r) => r.chunk), ["你", "好", "呀", "！", "…"]);
  assert.equal(shown(st), "你好呀！…");
  assert.equal(st.text, "", "预览不能提前进最终答案，否则完整消息到达时会翻倍");
  assert.equal(st.partialSeen, true);
});

test("工具参数 / 思考增量 / 无关事件都不进正文", () => {
  const evs = [
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{\"cmd\":" } } },
    { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "让我想想" } },
    { type: "message_start", message: {} },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "system", subtype: "status" },
    null,
    "not-an-object",
  ];
  const { st, steps } = feed(evs);
  assert.equal(shown(st), "");
  assert.ok(steps.every((r) => r.chunk === "" && !r.committed));
});

test("核心契约：完整消息到达后提交整段、清预览，答案不翻倍也不回退", () => {
  const before = feed([delta("你"), delta("好")]).st;
  assert.equal(shown(before), "你好");
  const r = applyStreamEvent(before, assistant("你好", ["Bash"]));
  assert.equal(r.committed, true, "提交帧必须强制推一次 sink，别被节流吞掉");
  assert.equal(r.text, "你好");
  assert.equal(r.preview, "");
  assert.equal(r.partialSeen, false);
  assert.equal(shown(r), "你好", "面板前后看到的文本必须连续");
  assert.deepEqual(r.toolUses, ["Bash"]);
});

test("增量与完整消息文字不完全一致时，以完整消息为准（不丢字、不重复）", () => {
  const before = feed([delta("你"), delta("好")]).st;
  const r = applyStreamEvent(before, assistant("你好，世界"));
  assert.equal(r.text, "你好，世界");
  assert.equal(r.preview, "");
  assert.equal(shown(r), "你好，世界");
});

test("多轮：每轮独立预览、独立提交，第二轮不把第一轮的字再算一遍", () => {
  const evs = [
    delta("第一"), delta("轮"), assistant("第一轮"),
    delta("第二"), delta("轮"), assistant("第二轮"),
  ];
  const { st, steps } = feed(evs);
  assert.equal(st.text, "第一轮第二轮");
  assert.equal(st.preview, "");
  assert.equal(steps.filter((r) => r.committed).length, 2);
  assert.deepEqual(steps.filter((r) => r.chunk).map((r) => r.chunk), ["第一", "轮", "第二", "轮"]);
});

test("commitStreamPreview：只给增量不给完整消息时，收尾兜底不交空答案", () => {
  const st = feed([delta("只"), delta("有"), delta("增量")]).st;
  const c = commitStreamPreview(st);
  assert.equal(c.text, "只有增量");
  assert.equal(c.preview, "");
  assert.equal(c.partialSeen, false);
  // 已经正常提交过的不该被二次追加
  const doneSt = feed([delta("你"), delta("好"), assistant("你好")]).st;
  assert.equal(commitStreamPreview(doneSt).text, "你好");
});

test("result 事件带出用量与错误，assistant 上的占位 usage 不被误记", () => {
  const r = applyStreamEvent(empty(), {
    type: "result", usage: { input_tokens: 12, output_tokens: 3 },
    is_error: true, errors: ["boom"],
  });
  assert.equal(r.isResult, true);
  assert.deepEqual(r.usage, { input_tokens: 12, output_tokens: 3 });
  assert.deepEqual(r.errors, ["boom"]);
  const a = applyStreamEvent(empty(), assistant("正文"));
  assert.equal(a.isResult, false);
  assert.equal(a.usage, null);
});

test("没有增量能力时（旧 CLI）：只有完整消息，行为与历史完全一致", () => {
  const { st, steps } = feed([assistant("整段答案")]);
  assert.equal(st.text, "整段答案");
  assert.equal(st.preview, "");
  assert.equal(st.partialSeen, false);
  assert.equal(steps[0].committed, true);
  assert.equal(steps[0].chunk, "");
});

/* ---------- 2. 接线契约：静态锁住，防被顺手改回去 ---------- */

function sliceBetween(a, b) {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i);
  assert.ok(i >= 0, "找不到 " + a);
  assert.ok(j > i, "找不到 " + b);
  return src.slice(i, j);
}

test("能力探测：一次 --help 同时判两个参数，探到不支持才停用", () => {
  const probe = sliceBetween("let appendPromptSupport = null;", "/* ---------------- 接口级拒绝");
  assert.ok(/partialSupport = \/--include-partial-messages\//.test(probe), "必须探测增量参数");
  assert.ok(/ORB_WB_NO_PARTIAL/.test(probe), "必须留一键回退开关");
  assert.ok(/partialSupport !== false/.test(probe), "未知按支持处理，探测失败不能反过来关掉功能");
  assert.ok(/setTimeout\(probeCliFlags,/.test(src), "启动时必须真的跑这次探测");
});

test("spawn 参数：带 --include-partial-messages 与 --verbose，且可探测式关闭", () => {
  const spawn = sliceBetween("function spawnOnceStream(", "let child;");
  assert.ok(/--output-format", "stream-json"/.test(spawn));
  assert.ok(/cliWantsPartial\(\) \? \["--include-partial-messages", "--verbose"\]/.test(spawn),
    "必须按能力探测结果追加增量参数");
});

test("sink 推的是 text + preview，且增量节流降到 100ms", () => {
  const spawn = sliceBetween("const MAX_BYTES =", "const timer = setTimeout");
  assert.ok(/cliWantsPartial\(\) \? 100 : 350/.test(spawn), "增量模式必须比旧的 350ms 更密");
  assert.ok(/sink\(text \+ preview\)/.test(spawn), "预览必须进推送，否则流式看不见");
  assert.ok(/const commitPreview = \(\) => \{[\s\S]{0,300}?commitStreamPreview/.test(spawn),
    "收尾兜底要走同一个纯函数");
});

test("解析回调接进状态机，收尾先 commitPreview 再推最后一帧", () => {
  const spawn = sliceBetween("const onLine = (line) =>", "/* ---------------- 后台 CLI 预热");
  assert.ok(/applyStreamEvent\(\{ text, preview, partialSeen \}, ev\)/.test(spawn));
  assert.ok(/r\.chunk/.test(spawn) && /r\.committed/.test(spawn), "增量帧与提交帧都要有对应副作用");
  assert.ok(/r\.toolUses/.test(spawn), "工具名仍要喂给 liveStep 做过程播报");
  assert.ok(/commitPreview\(\);[\s\S]{0,200}?sinkPush\(true\)/.test(spawn),
    "close 里必须先兜底提交再推最后一帧");
  assert.ok(/MAX_BYTES = 32 \* 1024 \* 1024/.test(src),
    "增量事件元数据量大，8MB 上限会把长回答误杀");
});

test("两种回退开关齐全：NO_PARTIAL 退消息级，ORB_WB_TEXT 退纯文本", () => {
  assert.ok(/ORB_WB_NO_PARTIAL/.test(src));
  assert.ok(/ORB_WB_TEXT === "1"/.test(src));
});
