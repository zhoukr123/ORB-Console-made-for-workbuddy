/* span 单测：常量 / 线性插值 / 空样本 / 六指标互不替代 / flush 幂等 JSONL。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSpanCollector, METRICS } from "../span.mjs";

const dirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-span-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/* 可控时钟：t 可变，便于精确控制 e2eMs。 */
function clocked(opts = {}) {
  const state = { t: 0 };
  const sc = createSpanCollector({ now: () => state.t, ...opts });
  return { sc, state };
}

test("METRICS：六项齐全，e2eMs 与 eventToTaskMs 同时存在", () => {
  assert.equal(METRICS.length, 6);
  assert.deepEqual(METRICS, [
    "eventToTaskMs", "queueMs", "e2eMs", "costPerEffectiveWork", "misrouteRate", "interruptCost",
  ]);
  assert.ok(METRICS.includes("e2eMs"));
  assert.ok(METRICS.includes("eventToTaskMs"));
});

test("start/mark/finish：返回 {ok,durationMs}，重复 finish/已完成 mark 均失败", () => {
  const { sc, state } = clocked();
  state.t = 100;
  const id = sc.start({ name: "task", ticketId: "t1", epoch: 7, labels: { a: 1 } });
  assert.equal(typeof id, "string");
  assert.equal(sc.mark(id, "firstToken", 130), true);
  state.t = 250;
  const r = sc.finish(id, { ok: true, tokens: 10, costUSD: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.durationMs, 150);
  assert.equal(sc.finish(id, { ok: true }).ok, false, "重复 finish 返回 ok:false");
  assert.equal(sc.mark(id, "late", 300), false);
  const row = sc.rows().find((x) => x.spanId === id);
  assert.equal(row.labels.a, 1);
  assert.equal(row.marks.length, 1);
});

test("percentiles：线性插值 p50/p95/p99，样本 0 时全 0", () => {
  const { sc } = clocked();
  assert.deepEqual(sc.percentiles("latencyMs"), { p50: 0, p95: 0, p99: 0, count: 0, failRate: 0 });
  for (const v of [10, 20, 30, 40]) {
    const id = sc.start({ name: "n" });
    sc.finish(id, { ok: true, latencyMs: v });
  }
  const p = sc.percentiles("latencyMs");
  assert.equal(p.count, 4);
  assert.equal(p.p50, 25);       // 20 + (30-20)*0.5
  assert.equal(p.p95, 38.5);     // 30 + (40-30)*0.85
  assert.ok(Math.abs(p.p99 - 39.7) < 1e-9);
  assert.equal(p.failRate, 0);
});

test("percentiles：failRate 按 ok===false 的样本占比", () => {
  const { sc } = clocked();
  const mk = (v, ok) => { const id = sc.start({ name: "n" }); sc.finish(id, { ok, v }); };
  mk(1, true); mk(2, false); mk(3, false); mk(4, true);
  const p = sc.percentiles("v");
  assert.equal(p.count, 4);
  assert.equal(p.failRate, 0.5);
});

test("sixMetrics：e2eMs 与 eventToTaskMs 独立保留，样本齐全时 complete=true", () => {
  const { sc, state } = clocked();
  state.t = 0;
  const id = sc.start({ name: "n" });
  state.t = 100;
  sc.finish(id, {
    ok: true, eventToTaskMs: 20, queueMs: 5, tokens: 100, costUSD: 2,
    interruptCost: 3, misroute: false, ttftMs: 18,
  });
  const m = sc.sixMetrics();
  assert.equal(m.eventToTaskMs, 20);
  assert.equal(m.e2eMs, 100);
  assert.notEqual(m.eventToTaskMs, m.e2eMs, "两者互不替代");
  assert.equal(m.queueMs, 5);
  assert.ok(Math.abs(m.costPerEffectiveWork - 0.02) < 1e-9);
  assert.equal(m.interruptCost, 3);
  assert.equal(m.misrouteRate, 0);
  assert.equal(m.samples, 1);
  assert.equal(m.complete, true);
});

test("sixMetrics：样本不足明确 complete=false，绝不补假样本", () => {
  const { sc } = clocked();
  const m = sc.sixMetrics();
  assert.equal(m.samples, 0);
  assert.equal(m.complete, false);
  for (const k of METRICS) assert.equal(m[k], 0, `${k} 无样本应为 0 而非伪造`);
});

test("flush：幂等按 JSONL 追加；file=null 只留内存", () => {
  const file = path.join(tmp(), "spans.jsonl");
  const { sc } = clocked({ fs, file });
  for (let i = 0; i < 3; i++) {
    const id = sc.start({ name: `n${i}` });
    sc.finish(id, { ok: true, latencyMs: i });
  }
  const r1 = sc.flush();
  const r2 = sc.flush();
  assert.equal(r1.appended, 3);
  assert.equal(r2.appended, 0, "第二次幂等不重复写");
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  for (const ln of lines) assert.doesNotThrow(() => JSON.parse(ln));

  const mem = clocked();
  assert.equal(mem.sc.flush().appended, 0);
  assert.equal(mem.sc.rows().length, 0);
});
