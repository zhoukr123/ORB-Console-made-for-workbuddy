import test from "node:test";
import assert from "node:assert/strict";
import { suggestOutcomes, buildOutcome, describeSuggestion, KNOWN_KINDS } from "../outcomeSuggest.mjs";

const WIN = { title: "记事本 - 新建文本文档.txt" };
const step = (o = {}) => ({ server: "windows", tool: "Click", args: {}, win: WIN, ...o });

test("窗口标题占多数 → 建议 window_state，置信度高", () => {
  const wf = { steps: [step(), step(), step(), step({ win: null })] };
  const r = suggestOutcomes(wf);
  const w = r.candidates.find((c) => c.kind === "window_state");
  assert.ok(w, "应给出窗口判据");
  assert.equal(w.postcondition.titleIncludes, WIN.title);
  assert.equal(w.confidence, "high");
  assert.equal(w.source, "step.win.title");
});

test("窗口占比不足一半 → 置信度降为 medium（仍给，但标注不确定）", () => {
  /* 三个窗口各 2 步：最多数的那个也只占 1/3，说明没有任何窗口是「收尾目标」。 */
  const a = { title: "窗口甲" }, b = { title: "窗口乙" }, c = { title: "窗口丙" };
  const wf = { steps: [step({ win: a }), step({ win: a }), step({ win: b }),
    step({ win: b }), step({ win: c }), step({ win: c })] };
  const r = suggestOutcomes(wf);
  const w = r.candidates.find((x) => x.kind === "window_state");
  assert.equal(w.confidence, "medium");
  assert.match(w.why, /占比/);
});

test("路径类参数 → 建议 data_readback（exists + minBytes）", () => {
  const wf = { steps: [
    step({ server: "windows", tool: "Type", args: { path: "D:\\导出\\月度报表.xlsx" }, win: null }),
  ] };
  const r = suggestOutcomes(wf);
  const d = r.candidates.find((c) => c.kind === "data_readback");
  assert.ok(d);
  assert.deepEqual(d.postcondition, {
    kind: "data_readback", path: "D:\\导出\\月度报表.xlsx", exists: true, minBytes: 1,
  });
  assert.equal(d.confidence, "medium");
});

test("只读动作里的路径不建议回读（读一个文件不会产生产物）", () => {
  const wf = { steps: [
    step({ server: "windows", tool: "Snapshot", args: { path: "D:\\a\\b.txt" }, win: null }),
  ] };
  const r = suggestOutcomes(wf);
  assert.equal(r.candidates.some((c) => c.kind === "data_readback"), false);
  assert.ok(r.notes.some((n) => n.includes("没有从会改界面的动作")));
});

test("注入 isReadOnly 后按注入口径判断，而不是内置兜底表", () => {
  const wf = { steps: [
    step({ server: "windows", tool: "SaveAs", args: { path: "D:\\x\\y.pdf" }, win: null }),
  ] };
  assert.equal(suggestOutcomes(wf).candidates.some((c) => c.kind === "data_readback"), true);
  const ro = suggestOutcomes(wf, { isReadOnly: () => true });
  assert.equal(ro.candidates.some((c) => c.kind === "data_readback"), false);
});

test("路径含变量 → 降为 low 并提示改成固定路径", () => {
  const wf = { steps: [
    step({ args: { path: "D:\\{{日期}}\\报表.xlsx" }, win: null }),
  ] };
  const d = suggestOutcomes(wf).candidates.find((c) => c.kind === "data_readback");
  assert.equal(d.confidence, "low");
  assert.match(d.why, /含变量/);
});

test("目录名不建议回读（无扩展名 → 目录存在几乎恒真，没有判别力）", () => {
  const wf = { steps: [step({ args: { path: "D:\\导出目录" }, win: null })] };
  assert.equal(suggestOutcomes(wf).candidates.some((c) => c.kind === "data_readback"), false);
});

test("什么都没有 → 兜底 effect_evidence，且明确说明它弱", () => {
  const r = suggestOutcomes({ steps: [step({ win: null })] });
  assert.equal(r.candidates.length, 1);
  assert.deepEqual(r.candidates[0].postcondition, { kind: "effect_evidence" });
  assert.equal(r.candidates[0].confidence, "low");
  assert.match(r.candidates[0].why, /无法确认改成了什么/);
});

test("已有判据 → 不给建议，防止盖掉用户写好的", () => {
  const r = suggestOutcomes({ steps: [step()], outcome: { postconditions: [{ kind: "tree_state", text: "完成" }] } });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.existing, 1);
  assert.match(r.notes[0], /不再给建议/);
});

test("空配方 / 非法入参不崩，并说明没东西可分析", () => {
  for (const wf of [null, {}, { steps: [] }, { steps: "x" }]) {
    const r = suggestOutcomes(wf);
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.candidates));
  }
  assert.match(suggestOutcomes(null).notes.join(), /没有可分析的动作步骤/);
});

test("候选上限：路径最多 3 条，总数不超过 4", () => {
  const steps = [];
  for (let i = 0; i < 6; i++) steps.push(step({ args: { path: `D:\\出\\f${i}.txt` }, win: null }));
  const r = suggestOutcomes({ steps });
  assert.equal(r.candidates.filter((c) => c.kind === "data_readback").length, 3);
  assert.ok(r.candidates.length <= 4);
  /* 窗口 + 3 条回读恰好撑满上限：再加规则也不会溢出。 */
  const withWin = suggestOutcomes({ steps: steps.map((s) => ({ ...s, win: WIN })) });
  assert.equal(withWin.candidates.length, 4);
  assert.equal(withWin.candidates[0].kind, "window_state");
});

test("同一个路径重复出现只建议一次", () => {
  const p = "D:\\出\\same.txt";
  const r = suggestOutcomes({ steps: [step({ args: { path: p }, win: null }), step({ args: { file: p }, win: null })] });
  assert.equal(r.candidates.filter((c) => c.kind === "data_readback").length, 1);
});

test("编排图里 step 节点自带的步骤也会被分析", () => {
  const wf = {
    steps: [],
    graph: { nodes: [{ id: "a", kind: "step", steps: [step({ args: { path: "E:\\x\\out.csv" }, win: null })] }], edges: [] },
  };
  const r = suggestOutcomes(wf);
  assert.equal(r.candidates[0].postcondition.path, "E:\\x\\out.csv");
});

test("UNC 路径也认（\\\\server\\share\\a.xlsx）", () => {
  const r = suggestOutcomes({ steps: [step({ args: { path: "\\\\nas\\share\\a.xlsx" }, win: null })] });
  assert.equal(r.candidates[0].postcondition.path, "\\\\nas\\share\\a.xlsx");
});

test("buildOutcome 只取 postconditions，过滤非法条目、尊重上限", () => {
  const cands = [
    { postcondition: { kind: "window_state", titleIncludes: "甲" } },
    { postcondition: null },
    { postcondition: { kind: 1 } },
    { postcondition: { kind: "effect_evidence" } },
  ];
  assert.deepEqual(buildOutcome(cands), {
    postconditions: [{ kind: "window_state", titleIncludes: "甲" }, { kind: "effect_evidence" }],
  });
  assert.equal(buildOutcome(cands, { max: 1 }).postconditions.length, 1);
  assert.deepEqual(buildOutcome(null), { postconditions: [] });
});

test("describeSuggestion 输出置信度与理由，可直接给面板用", () => {
  const txt = describeSuggestion(suggestOutcomes({ steps: [step()] }));
  assert.match(txt, /^\[高\]/);
  assert.match(txt, /收尾时它应当还在/);
  assert.equal(describeSuggestion(null), "");
});

test("buildOutcome 按白名单过滤：拼错的 kind 一律丢弃，不留给运行时变永远需复核", () => {
  const out = buildOutcome([
    { postcondition: { kind: "tree_state", text: "完成" } },
    { postcondition: { kind: "checkpoint_readback", path: "x" } },
    { postcondition: { kind: "data_readback", path: "D://a//b.txt" } },
  ]);
  assert.deepEqual(out.postconditions.map((p) => p.kind), ["tree_state", "data_readback"]);
  assert.ok(KNOWN_KINDS.includes("effect_evidence"));
});
