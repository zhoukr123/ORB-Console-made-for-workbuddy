/* perfBaseline 单测：只生成计划 / 样本不足未完成 / TTFT+e2e 并存 / 审计写盘容错。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBaseline } from "../perfBaseline.mjs";

const dirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-base-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("plan：只生成 20×3 采样计划，绝不产生任何结果", () => {
  const b = createBaseline({ now: () => 1 });
  const p = b.plan();
  assert.equal(typeof p.planId, "string");
  assert.ok(p.note.includes("不产生任何结果"));
  assert.equal(p.tasks.length, 20);
  for (const t of p.tasks) {
    assert.equal(typeof t.taskId, "string");
    assert.equal(t.repeat, 3);
  }
  const cov = b.coverage();
  assert.deepEqual(cov, { done: 0, total: 60, ratio: 0 });
  const rep = b.report();
  assert.equal(rep.complete, false);
  assert.equal(rep.missing.length, 60);
  assert.equal(Object.keys(rep.byTask).length, 20);
  for (const tid of Object.keys(rep.byTask)) {
    assert.equal(rep.byTask[tid].count, 0);
    assert.equal(rep.byTask[tid].p50, 0, "无样本为真实 0，绝不补假数据");
  }
});

test("样本不足：report().complete===false 且 missing 非空", () => {
  const b = createBaseline({ now: () => 1 });
  const p = b.plan();
  for (let i = 0; i < 3; i++) {
    b.record({ planId: p.planId, taskId: "task-01", runIndex: i, metrics: { ttftMs: 10, e2eMs: 100, ok: true } });
  }
  const rep = b.report();
  assert.equal(rep.complete, false);
  assert.ok(rep.missing.length > 0, "必须逐条列出缺失样本");
  assert.equal(rep.missing.length, 57);
  assert.equal(rep.coverage.done, 3);
  assert.match(rep.warning, /样本不足/);
});

test("record 校验：no-plan / unknown-task / bad-runIndex / plan-mismatch", () => {
  const b = createBaseline({ now: () => 1 });
  assert.equal(b.record({ taskId: "task-01", runIndex: 0, metrics: {} }).ok, false);
  const p = b.plan();
  assert.equal(b.record({ planId: p.planId, taskId: "nope", runIndex: 0, metrics: {} }).ok, false);
  assert.equal(b.record({ planId: p.planId, taskId: "task-01", runIndex: 3, metrics: {} }).ok, false);
  assert.equal(b.record({ planId: "wrong", taskId: "task-01", runIndex: 0, metrics: {} }).ok, false);
  assert.equal(b.record({ planId: p.planId, taskId: "task-01", runIndex: 0, metrics: { ttftMs: 1, e2eMs: 2, ok: true } }).ok, true);
});

test("全部采样后 complete=true，report 同时给 TTFT 与 e2e（互不替代）", () => {
  const b = createBaseline({ now: () => 1 });
  const p = b.plan();
  for (let j = 0; j < 20; j++) {
    for (let i = 0; i < 3; i++) {
      const n = j * 3 + i + 1;
      b.record({
        planId: p.planId, taskId: `task-${String(j + 1).padStart(2, "0")}`, runIndex: i,
        metrics: { ttftMs: n * 10, e2eMs: n * 100, steps: n, tokens: n, costUSD: n, ok: !(j === 0 && i === 0) },
      });
    }
  }
  const rep = b.report();
  assert.equal(rep.complete, true);
  assert.equal(rep.coverage.done, 60);
  assert.equal(rep.coverage.ratio, 1);
  assert.equal(rep.missing.length, 0);
  assert.match(rep.warning, /两者同降/);
  const t1 = rep.byTask["task-01"];
  assert.equal(t1.count, 3);
  assert.equal(t1.p50, 200);                    // 顶层 p50 取 e2e
  assert.ok(Math.abs(t1.failRate - 1 / 3) < 1e-9);
  // TTFT 与 e2e 两套独立存在
  assert.deepEqual(Object.keys(t1.ttft).sort(), ["count", "p50", "p95", "p99"]);
  assert.deepEqual(Object.keys(t1.e2e).sort(), ["count", "p50", "p95", "p99"]);
  assert.equal(t1.ttft.p50, 20);
  assert.equal(t1.e2e.p50, 200);
  assert.notEqual(t1.ttft.p50, t1.e2e.p50, "两者不互相替代");
});

test("plan(tasks)：自定义 taskId 保留、不足 20 补齐、repeat 可注入", () => {
  const b = createBaseline({ now: () => 1, repeat: 2 });
  const p = b.plan([{ taskId: "alpha", label: "A" }, "beta"]);
  assert.equal(p.tasks.length, 20);
  assert.equal(p.tasks[0].taskId, "alpha");
  assert.equal(p.tasks[0].label, "A");
  assert.equal(p.tasks[0].repeat, 2);
  assert.equal(p.tasks[1].taskId, "beta");
  assert.equal(b.coverage().total, 40);
});

test("file 审计日志追加；写盘失败不影响主流程", () => {
  const file = path.join(tmp(), "baseline.jsonl");
  const b = createBaseline({ fs, file, now: () => 1 });
  const p = b.plan();
  assert.equal(b.record({ planId: p.planId, taskId: "task-01", runIndex: 0, metrics: { ttftMs: 1, e2eMs: 2, ok: true } }).ok, true);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).taskId, "task-01");

  // 父路径是普通文件 → mkdir 必然失败，但 record 仍成功
  const blocker = path.join(tmp(), "blocker");
  fs.writeFileSync(blocker, "x", "utf8");
  const bad = createBaseline({ fs, file: path.join(blocker, "sub", "audit.jsonl"), now: () => 1 });
  const p2 = bad.plan();
  assert.equal(bad.record({ planId: p2.planId, taskId: "task-01", runIndex: 0, metrics: {} }).ok, true);
});
