import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCheckpoints, canResume, isLinearRecipe, recipeDigest, RESUME_BLOCK } from "../wfCheckpoint.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orb-wfcp-"));
  let clock = 1700000000000;
  const now = () => clock;
  const mk = (o = {}) => createCheckpoints({ dir: root, now, ...o });
  return { root, mk, now, tick: (ms) => { clock += ms; },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const linear = (n) => ({ name: "wf", steps: Array.from({ length: n }, (_, i) => ({ server: "windows", tool: "Click", args: { i } })) });

test("save / get 还原字段，一个配方一个断点（后写覆盖）", () => {
  const f = fixture();
  try {
    const c = f.mk();
    assert.equal(c.save("wr-1", { workflow: "月度报表", nextIndex: 2, total: 5, vars: { a: 1 }, lastIdem: "k2", reason: "失败" }).ok, true);
    f.tick(50);
    assert.equal(c.save("wr-2", { workflow: "月度报表", nextIndex: 4, total: 5 }).ok, true);
    const got = c.get("月度报表");
    assert.equal(got.nextIndex, 4);
    assert.equal(got.runId, "wr-2");
    assert.equal(c.list().length, 1, "同名只该留一条");
  } finally { f.cleanup(); }
});

test("clear 后 get 返回 null；不存在时 clear 不抛", () => {
  const f = fixture();
  try {
    const c = f.mk();
    c.save("wr-1", { workflow: "甲", nextIndex: 1, total: 3 });
    assert.equal(c.clear("甲").ok, true);
    assert.equal(c.get("甲"), null);
    assert.equal(c.clear("从没存过").ok, false);
  } finally { f.cleanup(); }
});

test("save 参数校验：缺 workflow / nextIndex 非法一律拒绝", () => {
  const f = fixture();
  try {
    const c = f.mk();
    assert.equal(c.save("wr", {}).ok, false);
    assert.equal(c.save("wr", { workflow: "甲", nextIndex: -1 }).ok, false);
    assert.equal(c.save("wr", { workflow: "甲", nextIndex: "x" }).ok, false);
    assert.equal(c.save("wr", { workflow: "甲", nextIndex: 0 }).ok, true, "0 合法：记录第一步都还没完成");
  } finally { f.cleanup(); }
});

test("配方名做路径安全化：中文保留，不写出目录", () => {
  const f = fixture();
  try {
    const c = f.mk();
    c.save("wr", { workflow: "../../逃出去", nextIndex: 1, total: 3 });
    const files = fs.readdirSync(f.root);
    assert.equal(files.length, 1);
    assert.ok(!files[0].includes(".."), "文件名不能含 ..");
    assert.ok(c.get("../../逃出去"), "安全化后仍能按原名取回");
  } finally { f.cleanup(); }
});

test("isLinearRecipe：线性配方可续；loop / if / subflow / graph 一律不可", () => {
  assert.equal(isLinearRecipe(linear(3)).ok, true);
  for (const t of ["loop", "if", "subflow"]) {
    const r = isLinearRecipe({ steps: [{ server: "windows", tool: "Click" }, { type: t }] });
    assert.equal(r.ok, false, t + " 必须被拒");
    assert.equal(r.code, RESUME_BLOCK.HAS_CONTROL_FLOW);
    assert.match(r.reason, new RegExp(t));
  }
  const g = isLinearRecipe({ steps: [], graph: { nodes: [], edges: [] } });
  assert.equal(g.code, RESUME_BLOCK.GRAPH_RECIPE);
  assert.equal(isLinearRecipe(null).ok, false);
});

test("canResume 正常路径：线性配方 + 断点在中间 + 上一步已结算 + 内容没变", () => {
  const wf = linear(5);
  const cp = { workflow: "wf", nextIndex: 2, total: 5, stepsDigest: recipeDigest(wf.steps), at: Date.now() };
  const r = canResume(wf, cp, { lastSettled: true });
  assert.equal(r.ok, true);
  assert.equal(r.nextIndex, 2);
  assert.match(r.reason, /第 3 步/);
});

test("canResume：上一步没结算 → 拒绝（状态不明就不续）", () => {
  const wf = linear(5);
  const cp = { nextIndex: 2, total: 5, stepsDigest: recipeDigest(wf.steps), at: Date.now() };
  assert.equal(canResume(wf, cp, { lastSettled: false }).code, "state_unconfirmed");
  /* 不传也算未核对：默认收紧，不默认放行。 */
  assert.equal(canResume(wf, cp, {}).code, "state_unconfirmed");
});

test("canResume：配方改过（步数对不上）→ 拒绝，旧索引不可信", () => {
  const r = canResume(linear(6), { nextIndex: 2, total: 5, at: Date.now() }, { lastSettled: true });
  assert.equal(r.code, RESUME_BLOCK.RECIPE_CHANGED);
  assert.match(r.reason, /改过/);
});

test("canResume：断点在第 0 步 / 已到末尾 → 拒绝", () => {
  assert.equal(canResume(linear(5), { nextIndex: 0, total: 5, at: Date.now() }, { lastSettled: true }).code, RESUME_BLOCK.INDEX_ZERO);
  assert.equal(canResume(linear(5), { nextIndex: 5, total: 5, at: Date.now() }, { lastSettled: true }).code, RESUME_BLOCK.INDEX_OUT_OF_RANGE);
});

test("canResume：断点过期 → 拒绝", () => {
  const f = fixture();
  try {
    const cp = { nextIndex: 2, total: 5, at: f.now() - 8 * 24 * 3600 * 1000 };
    const r = canResume(linear(5), cp, { now: f.now, lastSettled: true });
    assert.equal(r.code, RESUME_BLOCK.STALE);
  } finally { f.cleanup(); }
});

test("canResume：没有断点 → 明确报 none，而不是崩", () => {
  for (const cp of [null, undefined, "x"]) {
    assert.equal(canResume(linear(3), cp, { lastSettled: true }).code, RESUME_BLOCK.NO_CHECKPOINT);
  }
});

test("canResume 优先级：控制流先于断点校验（哪怕断点本身也过期）", () => {
  const wf = { steps: [{ type: "loop" }, { server: "w", tool: "Click" }] };
  const r = canResume(wf, { nextIndex: 1, total: 2, at: 0 }, { lastSettled: true });
  assert.equal(r.code, RESUME_BLOCK.HAS_CONTROL_FLOW);
});

test("sweep 清过期断点，保留新的", () => {
  const f = fixture();
  try {
    const c = f.mk();
    c.save("old", { workflow: "旧", nextIndex: 1, total: 3 });
    f.tick(8 * 24 * 3600 * 1000);
    c.save("new", { workflow: "新", nextIndex: 1, total: 3 });
    const r = c.sweep();
    assert.equal(r.removed, 1);
    assert.equal(c.get("旧"), null);
    assert.ok(c.get("新"));
    assert.deepEqual(c.stats().total, 1);
  } finally { f.cleanup(); }
});

test("损坏的断点文件读不出来当没有，不抛", () => {
  const f = fixture();
  try {
    const c = f.mk();
    c.save("wr", { workflow: "甲", nextIndex: 1, total: 3 });
    fs.writeFileSync(c.fileOf("甲"), "{坏掉", "utf8");
    assert.equal(c.get("甲"), null);
    assert.deepEqual(c.list(), []);
  } finally { f.cleanup(); }
});

test("缺 dir 直接报错（不静默写到当前目录）", () => {
  assert.throws(() => createCheckpoints({}), /dir 必填/);
});

/* ---------------- 内容指纹（对标 Temporal determinism） ----------------
 * 只比步数会漏掉「步数没变但某步被改过」，那种情况下续跑会从错的位置接上。
 * 这组用例锁的就是这个缺口。 */
test("save / get 往返保内容指纹", () => {
  const f = fixture();
  try {
    const c = f.mk();
    const wf = linear(3);
    c.save("wr", { workflow: "甲", nextIndex: 1, total: 3, stepsDigest: recipeDigest(wf.steps) });
    assert.equal(c.get("甲").stepsDigest, recipeDigest(wf.steps));
  } finally { f.cleanup(); }
});

test("步数相同但内容改过（只改一个坐标）→ 拒绝续跑", () => {
  const before = linear(5);
  const after = JSON.parse(JSON.stringify(before));
  after.steps[2].args.i = 999;                     // 步数没变，内容变了
  assert.equal(after.steps.length, before.steps.length);
  const cp = { nextIndex: 2, total: 5, stepsDigest: recipeDigest(before.steps), at: Date.now() };
  const r = canResume(after, cp, { lastSettled: true });
  assert.equal(r.code, RESUME_BLOCK.RECIPE_CHANGED);
  assert.match(r.reason, /内容变过/);
});

test("步骤顺序换了也算改过（指纹对顺序敏感）", () => {
  const a = linear(2);
  const b = { steps: [a.steps[1], a.steps[0]] };
  const cp = { nextIndex: 1, total: 2, stepsDigest: recipeDigest(a.steps), at: Date.now() };
  assert.equal(canResume(b, cp, { lastSettled: true }).code, RESUME_BLOCK.RECIPE_CHANGED);
});

test("旧断点没有内容指纹 → 拒绝（宁可从头跑，不赌）", () => {
  const wf = linear(5);
  const r = canResume(wf, { nextIndex: 2, total: 5, at: Date.now() }, { lastSettled: true });
  assert.equal(r.code, RESUME_BLOCK.RECIPE_CHANGED);
  assert.match(r.reason, /没有内容指纹/);
});

test("recipeDigest：同样内容稳定复算，空/非法入参不抛", () => {
  const wf = linear(3);
  assert.equal(recipeDigest(wf), recipeDigest(wf.steps));
  assert.equal(recipeDigest(wf), recipeDigest(JSON.parse(JSON.stringify(wf))));
  assert.notEqual(recipeDigest(wf.steps), recipeDigest(linear(4).steps));
  /* 传入 null 时按「空步骤表」算，仍然给一个稳定的指纹 —— 不返回空串，
     否则 canResume 的 `!got` 会把"空配方"误判成"算不出来"。 */
  assert.equal(typeof recipeDigest(null), "string");
  assert.equal(recipeDigest(null), recipeDigest([]));
});
