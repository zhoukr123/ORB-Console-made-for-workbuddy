import test from "node:test";
import assert from "node:assert/strict";
import {
  NODE_KINDS, MAX_NODES, normalizeGraph, topoOrder, validateGraph, planOrder, evalCond,
} from "../wfDag.mjs";

const lin = () => ({
  nodes: [{ id: "a", kind: "step" }, { id: "b", kind: "step" }, { id: "c", kind: "subflow", workflow: "子配方" }],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
});

test("线性图拓扑序正确", () => {
  const r = topoOrder(lin());
  assert.equal(r.ok, true);
  assert.deepEqual(r.order, ["a", "b", "c"]);
});

test("分叉图：同一层按队列顺序展开，仍是合法拓扑序", () => {
  const g = {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
    edges: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }],
  };
  const r = topoOrder(g);
  assert.equal(r.ok, true);
  assert.deepEqual(r.order, ["a", "b", "c", "d"]);
});

test("环检测：自环与两点环都拦住", () => {
  assert.equal(topoOrder({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "a" }] }).ok, false);
  const two = topoOrder({ nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] });
  assert.equal(two.ok, false);
  assert.match(two.reason, /环/);
});

test("validateGraph：重复 id / 悬空边 / 缺 workflow / 缺 cond", () => {
  const dup = validateGraph({ nodes: [{ id: "a" }, { id: "a" }], edges: [] });
  assert.equal(dup.ok, false);
  assert.ok(dup.errors.some((e) => e.includes("重复")));

  const dangling = validateGraph({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "zzz" }] });
  assert.equal(dangling.ok, false);
  assert.ok(dangling.errors.some((e) => e.includes("不存在")));

  const noWf = validateGraph({ nodes: [{ id: "s", kind: "subflow" }], edges: [] });
  assert.equal(noWf.ok, false);
  assert.ok(noWf.errors.some((e) => e.includes("workflow")));

  const noCond = validateGraph({ nodes: [{ id: "i", kind: "if" }], edges: [] });
  assert.equal(noCond.ok, false);
  assert.ok(noCond.errors.some((e) => e.includes("cond")));
});

test("approval 缺 ask 是警告不是错误；onMissing=continue 会提示", () => {
  const v = validateGraph({ nodes: [{ id: "g", kind: "approval" }], edges: [] });
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.includes("ask")));

  const v2 = validateGraph({ nodes: [{ id: "g", kind: "approval", ask: "确认", onMissing: "continue" }], edges: [] });
  assert.ok(v2.warnings.some((w) => w.includes("继续")));
});

test("未知 kind 报错，并列出可用类型", () => {
  const v = validateGraph({ nodes: [{ id: "a", kind: "parallel" }], edges: [] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("parallel")));
});

test("节点数超上限报错", () => {
  const nodes = Array.from({ length: MAX_NODES + 1 }, (_, i) => ({ id: `n${i}` }));
  const v = validateGraph({ nodes, edges: [] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("上限")));
});

test("孤立节点给警告（多半是漏连线）", () => {
  const v = validateGraph({ nodes: [{ id: "a" }, { id: "b" }], edges: [] });
  assert.equal(v.ok, true);
  assert.ok(v.warnings.some((w) => w.includes("未连线")));
});

test("planOrder：无条件节点按拓扑序全部计划执行", () => {
  const p = planOrder(lin());
  assert.equal(p.ok, true);
  assert.deepEqual(p.plan.map((x) => x.id), ["a", "b", "c"]);
  assert.equal(p.plan[2].kind, "subflow");
});

test("planOrder：条件节点只保留命中分支，未命中标 skipped", () => {
  const g = {
    nodes: [
      { id: "a" },
      { id: "i", kind: "if", cond: "{{flag}}", then: "t1", else: "t2" },
      { id: "t1" }, { id: "t2" },
    ],
    edges: [{ from: "a", to: "i" }, { from: "i", to: "t2" }],
  };
  const hit = planOrder(g, { flag: true });
  assert.equal(hit.ok, true);
  assert.equal(hit.plan.find((x) => x.id === "i").taken, "t1");
  assert.equal(hit.plan.find((x) => x.id === "i").conditionMet, true);

  const miss = planOrder(g, { flag: false });
  assert.equal(miss.plan.find((x) => x.id === "i").taken, "t2");
});

test("planOrder：非法图直接返回错误，不给半截计划", () => {
  const p = planOrder({ nodes: [{ id: "a" }], edges: [{ from: "a", to: "a" }] });
  assert.equal(p.ok, false);
  assert.deepEqual(p.plan, []);
});

test("evalCond 只认 {{var}} 与 true/false，不执行任意代码", () => {
  assert.equal(evalCond("{{flag}}", { flag: true }), true);
  assert.equal(evalCond("{{a.b}}", { a: { b: 1 } }), true);
  assert.equal(evalCond("{{a.b}}", { a: { b: 0 } }), false);
  assert.equal(evalCond("true"), true);
  assert.equal(evalCond("false"), false);
  assert.equal(evalCond("1+1===2"), false);
  assert.equal(evalCond("process.exit(1)"), false);
  assert.equal(evalCond(""), false);
});

test("normalizeGraph 补默认 kind 与 id，且不修改入参", () => {
  const src = { nodes: [{ tool: "click" }, { kind: "approval", ask: "x" }], edges: [] };
  const g = normalizeGraph(src);
  assert.equal(g.nodes[0].kind, "step");
  assert.equal(g.nodes[0].id, "n1");
  assert.equal(g.nodes[1].kind, "approval");
  assert.deepEqual(NODE_KINDS, ["step", "subflow", "approval", "if"]);
  assert.equal(src.nodes[0].id, undefined);
});

test("非对象入参不崩", () => {
  assert.equal(validateGraph(null).ok, false);
  assert.equal(validateGraph([]).ok, false);
  assert.equal(validateGraph("x").ok, false);
});
