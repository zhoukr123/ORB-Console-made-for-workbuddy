/* 回放前预检单测（wfPreflight）。
 * 全部喂文本快照 + 内存配方，不碰真实桌面。
 * 重点锁三件事：
 *   ① 静态硬伤判 block、快照核对只判 warn —— 误报一次就会被人关掉；
 *   ② 查不出来的一律明说（unverifiable），不猜；
 *   ③ 嵌套（loop / if）、编排图、续跑起点这些边界不重复报、不漏报。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { preflight, summarizePreflight, snapshotWindows, windowState, PREFLIGHT, SEVERITY } from "../wfPreflight.mjs";
import { parseSnapshotTree, pruneSnapshotTree } from "../anchorResolver.mjs";

const SAMPLE = [
  "desktop",
  '├── window "记事本"',
  '│   ├── Pane "工具栏"',
  '│   │   ├── 100,200 Button "保存"',
  '│   │   └── 300,200 Button "打开"',
  '│   └── 500,500 Edit "文本区"',
  '└── window "计算器"',
  '    ├── 800,800 Button "1"',
  '    └── 820,800 Button "+"',
].join("\n");

const SAVE_REF = "记事本 > Window|记事本 > Pane|工具栏 > Button|保存";
const GONE_REF = "记事本 > Window|记事本 > Pane|工具栏 > Button|不存在";

const root = () => pruneSnapshotTree(parseSnapshotTree(SAMPLE));
const click = (extra = {}) => Object.assign({ server: "windows", tool: "Click", args: { loc: [100, 200] } }, extra);
const states = (r) => r.findings.map((f) => f.state);
const byLabel = (r, s) => r.findings.filter((f) => f.label.includes(s));

/* ---------------- 快照小工具 ---------------- */
test("snapshotWindows 收集窗口名并去重", () => {
  assert.deepEqual(snapshotWindows(root()), ["记事本", "计算器"]);
});

test("windowState：完全相同 / 带后缀 / 空格大小写 / 缺失 / 快照无窗口", () => {
  const ws = ["记事本 - 未命名", "计算器"];
  assert.equal(windowState("记事本 - 未命名", ws), "present");
  assert.equal(windowState("记事本", ws), "present");            // 后缀差异不该误报
  assert.equal(windowState(" 计算器 ", ws), "present");
  assert.equal(windowState("画图", ws), "missing");
  assert.equal(windowState("记事本", []), "unknown");            // 判不了就说判不了
  assert.equal(windowState("", ws), "unknown");
});

/* ---------------- 静态自洽：必然失败才 block ---------------- */
test("空配方 → block，ok=false", () => {
  const r = preflight({ name: "空", steps: [] }, SAMPLE);
  assert.equal(r.ok, false);
  assert.equal(r.blocked.length, 1);
  assert.match(r.blocked[0].reason, /没有任何步骤/);
});

test("步骤不是对象 → block", () => {
  const r = preflight({ steps: [null] }, SAMPLE);
  assert.equal(r.ok, false);
  assert.match(r.blocked[0].reason, /不是对象/);
});

test("缺工具名 → block；缺 server 只是 info（不劝停）", () => {
  const noTool = preflight({ steps: [{ args: {} }] }, null);
  assert.equal(noTool.ok, false);
  assert.match(noTool.blocked[0].reason, /没有工具名/);

  const noServer = preflight({ steps: [{ tool: "Click", args: {} }] }, null);
  assert.equal(noServer.ok, true);
  assert.equal(noServer.counts.info, 1);
  assert.match(noServer.findings[0].reason, /目标通道/);
});

test("循环体为空 → block；if 两分支皆空 → warn 但不劝停", () => {
  const l = preflight({ steps: [{ type: "loop", body: [] }] }, null);
  assert.equal(l.ok, false);
  assert.match(l.blocked[0].reason, /循环体是空的/);

  const i = preflight({ steps: [{ type: "if", when: "x", then: [], else: [] }] }, null);
  assert.equal(i.ok, true);
  assert.equal(i.suspects.length, 1);
  assert.match(i.suspects[0].reason, /两个分支都是空的/);
});

test("set 步骤不参与界面核对，也不报问题", () => {
  const r = preflight({ steps: [{ type: "set", name: "a", value: 1 }] }, SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.findings.length, 0);
  assert.equal(r.checked, 0);
});

test("子流程引用不存在的配方 → block（需给 workflows）；不给名单就不瞎判", () => {
  const wf = { steps: [{ type: "subflow", workflow: "收尾" }] };
  const strict = preflight(wf, null, { workflows: ["准备", "主流程"] });
  assert.equal(strict.ok, false);
  assert.match(strict.blocked[0].reason, /已经不存在/);

  const loose = preflight(wf, null);
  assert.equal(loose.ok, true);

  const hit = preflight(wf, null, { workflows: [{ name: "收尾" }] });
  assert.equal(hit.ok, true);
});

test("子流程没写 workflow → block", () => {
  const r = preflight({ steps: [{ type: "subflow" }] }, null);
  assert.equal(r.ok, false);
  assert.match(r.blocked[0].reason, /没写要调用哪条配方/);
});

test("嵌套超过 8 层 → block（回放会被深度上限截断）", () => {
  let s = { server: "windows", tool: "Click", args: { loc: [1, 1] } };
  for (let i = 0; i < 10; i++) s = { type: "loop", body: [s] };
  const r = preflight({ steps: [s] }, null);
  assert.equal(r.ok, false);
  assert.ok(r.blocked.some((f) => /嵌套层数超过/.test(f.reason)));
});

/* ---------------- 快照核对：只 warn，绝不 block ---------------- */
test("treeRef 能解析 → ok + checked 计数", () => {
  const r = preflight({ steps: [click({ treeRef: SAVE_REF })] }, SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.checked, 1);
  assert.equal(r.findings[0].state, PREFLIGHT.OK);
  assert.deepEqual(r.findings[0].at, [100, 200]);
});

test("treeRef 解析不到 → warn，但 ok 仍为 true（中途界面未知）", () => {
  const r = preflight({ steps: [click({ treeRef: GONE_REF })] }, SAMPLE);
  assert.equal(r.ok, true);
  assert.equal(r.suspects.length, 1);
  assert.equal(r.suspects[0].state, PREFLIGHT.ANCHOR_BROKEN);
  assert.match(r.suspects[0].reason, /找不到/);
  assert.match(r.suspects[0].reason, /保存|不存在/);
});

test("目标窗口不在快照 → window_missing，且不再叠一条 anchor_broken", () => {
  const r = preflight({ steps: [click({ treeRef: GONE_REF, win: { title: "画图", off: [1, 1] } })] }, SAMPLE);
  assert.equal(r.suspects.length, 1);
  assert.equal(r.suspects[0].state, PREFLIGHT.WINDOW_MISSING);
  assert.match(r.suspects[0].reason, /画图/);
});

test("窗口名带「- 未命名」后缀也能匹配，不误报", () => {
  const r = preflight({ steps: [click({ treeRef: SAVE_REF, win: { title: "记事本 - 未命名", off: [1, 1] } })] }, SAMPLE);
  assert.equal(r.suspects.length, 0);
  assert.equal(r.findings[0].state, PREFLIGHT.OK);
});

test("只有录制坐标：附近有控件 → ok 但标 weak；附近没控件 → unverifiable", () => {
  const near = preflight({ steps: [click({ args: { loc: [102, 203] } })] }, SAMPLE);
  assert.equal(near.findings[0].state, PREFLIGHT.OK);
  assert.equal(near.findings[0].weak, true);
  assert.match(near.findings[0].reason, /无法确认/);

  const far = preflight({ steps: [click({ args: { loc: [20, 20] } })] }, SAMPLE);
  assert.equal(far.findings[0].state, PREFLIGHT.UNVERIFIABLE);
  assert.equal(far.ok, true);                        // 查不出来不等于会失败
  assert.equal(far.suspects.length, 0);
});

test("既无 treeRef 也无坐标 → unverifiable", () => {
  const r = preflight({ steps: [{ server: "windows", tool: "Click", args: {} }] }, SAMPLE);
  assert.equal(r.findings[0].state, PREFLIGHT.UNVERIFIABLE);
});

test("键盘/输入类动作 → skipped（没有锚点可查）", () => {
  const r = preflight({ steps: [{ server: "windows", tool: "Type", args: { text: "hi" } }] }, SAMPLE);
  assert.equal(r.findings[0].state, PREFLIGHT.SKIPPED);
  assert.equal(r.checked, 0);
});

test("没有快照时只做静态检查，不误报失效", () => {
  const r = preflight({ steps: [click({ treeRef: GONE_REF })] }, null);
  assert.equal(r.hasSnapshot, false);
  assert.equal(r.findings.length, 0);
  assert.equal(r.ok, true);
  assert.match(summarizePreflight(r), /未抓界面快照/);
});

/* ---------------- 嵌套与图 ---------------- */
test("循环体里的失效步能被查到，label 带「循环体」且继承顶层步号", () => {
  const wf = {
    steps: [
      click({ treeRef: SAVE_REF }),
      { type: "loop", times: 2, body: [click({ treeRef: GONE_REF })] },
    ],
  };
  const r = preflight(wf, SAMPLE);
  assert.equal(r.suspects.length, 1);
  assert.match(r.suspects[0].label, /第 2 步（循环体）\s*·\s*第 1 步/);
  assert.equal(r.suspects[0].index, 1);
});

test("if 的 then / else 两支都核，label 能区分", () => {
  const wf = {
    steps: [{ type: "if", when: "a", then: [click({ treeRef: GONE_REF })], else: [click({ treeRef: GONE_REF })] }],
  };
  const r = preflight(wf, SAMPLE);
  assert.equal(r.suspects.length, 2);
  assert.ok(byLabel(r, "then").length === 1);
  assert.ok(byLabel(r, "else").length === 1);
});

test("子流程步骤不展开，明说未预检", () => {
  const r = preflight({ steps: [{ type: "subflow", workflow: "收尾" }] }, SAMPLE, { workflows: ["收尾"] });
  assert.equal(r.ok, true);
  assert.equal(r.findings[0].state, PREFLIGHT.UNVERIFIABLE);
  assert.match(r.findings[0].reason, /未展开预检/);
});

test("编排图配方：静态错误走 validateGraph 判 block", () => {
  const graph = {
    nodes: [{ id: "a", kind: "step" }, { id: "b", kind: "step" }],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }],
  };
  const r = preflight({ name: "图", graph, steps: [click({ treeRef: SAVE_REF })] }, SAMPLE);
  assert.equal(r.ok, false);
  assert.ok(r.blocked.some((f) => /环/.test(f.reason)));
});

test("编排图节点自带 steps 的，按节点分别核对", () => {
  const graph = { nodes: [{ id: "n1", kind: "step", steps: [click({ treeRef: GONE_REF })] }], edges: [] };
  const r = preflight({ graph, steps: [] }, SAMPLE);
  assert.equal(r.suspects.length, 1);
  assert.match(r.suspects[0].label, /节点 n1/);
});

/* ---------------- 续跑起点与汇总 ---------------- */
test("fromIndex 跳过前面的顶层步（续跑时那些步不会重跑）", () => {
  const wf = {
    steps: [
      click({ treeRef: GONE_REF }),
      click({ treeRef: GONE_REF }),
      click({ treeRef: GONE_REF }),
    ],
  };
  const all = preflight(wf, SAMPLE);
  assert.equal(all.suspects.length, 3);
  assert.equal(all.checked, 3);

  const from2 = preflight(wf, SAMPLE, { fromIndex: 2 });
  assert.equal(from2.suspects.length, 1);
  assert.equal(from2.suspects[0].index, 2);
  assert.equal(from2.checked, 1);
});

test("block 排在 warn 前面，面板照顺序显示即可", () => {
  const wf = { steps: [click({ treeRef: GONE_REF }), { args: {} }] };
  const r = preflight(wf, SAMPLE);
  assert.equal(r.findings[0].severity, SEVERITY.BLOCK);
  assert.equal(r.findings[1].severity, SEVERITY.WARN);
});

test("summarizePreflight 三种结论各说各的", () => {
  const bad = preflight({ steps: [] }, SAMPLE);
  assert.match(summarizePreflight(bad), /预检不通过/);

  const warn = preflight({ steps: [click({ treeRef: GONE_REF })] }, SAMPLE);
  assert.match(summarizePreflight(warn), /可能失效/);
  assert.match(summarizePreflight(warn), /核对 1 步/);

  const good = preflight({ steps: [click({ treeRef: SAVE_REF })] }, SAMPLE);
  assert.match(summarizePreflight(good), /预检通过/);

  assert.equal(summarizePreflight(null), "预检没有结果");
});

test("非法入参不崩：null 配方 / undefined 快照", () => {
  const r = preflight(null, undefined);
  assert.equal(r.ok, false);                       // 没有任何步骤，本来就是硬伤
  assert.equal(r.hasSnapshot, false);
  assert.deepEqual(r.windows, []);
  assert.equal(states(r).includes(PREFLIGHT.ANCHOR_BROKEN), false);
});
