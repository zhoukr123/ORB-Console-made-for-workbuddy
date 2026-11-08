import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAutoTrace } from "../autoTrace.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "orb-trace-"));
}

test("begin / step / end 写入后能按运行读回", () => {
  const dir = tmpDir();
  const T = createAutoTrace({ dir });
  T.begin("wr-1", { workflow: "月度报表", layer: "interval" });
  T.step("wr-1", { tool: "click", ok: true, ms: 12 });
  T.step("wr-1", { tool: "type", ok: false, error: "STALE_REF" });
  T.end("wr-1", { verdict: "failed" });

  const rows = T.read("wr-1");
  assert.equal(rows.length, 4);
  assert.equal(rows[0].t, "begin");
  assert.equal(rows[0].workflow, "月度报表");
  assert.equal(rows[1].n, 1);
  assert.equal(rows[2].ok, false);
  assert.equal(rows[3].t, "end");
  assert.equal(rows[3].verdict, "failed");
});

test("每运行步数上限：超出后拒绝写入但仍可读已写部分", () => {
  const dir = tmpDir();
  const T = createAutoTrace({ dir, maxStepsPerRun: 3 });
  T.begin("wr-2");
  assert.equal(T.step("wr-2", { i: 1 }).ok, true);
  assert.equal(T.step("wr-2", { i: 2 }).ok, true);
  assert.equal(T.step("wr-2", { i: 3 }).ok, true);
  const over = T.step("wr-2", { i: 4 });
  assert.equal(over.ok, false);
  assert.equal(over.code, "trace-limit");
  assert.equal(T.read("wr-2").filter((r) => r.t === "step").length, 3);
});

test("超过 maxRuns 时淘汰最老的运行文件", () => {
  const dir = tmpDir();
  const T = createAutoTrace({ dir, maxRuns: 2 });
  T.begin("wr-a");
  T.begin("wr-b");
  T.begin("wr-c");
  assert.deepEqual(T.listRuns(), ["wr-c", "wr-b"]);
  assert.equal(fs.existsSync(T.fileOf("wr-a")), false);
  assert.equal(fs.existsSync(T.fileOf("wr-b")), true);
});

test("读不存在的运行返回空数组，不抛", () => {
  const T = createAutoTrace({ dir: tmpDir() });
  assert.deepEqual(T.read("nope"), []);
});

test("sweep 按 TTL 清理，保留新的", () => {
  const dir = tmpDir();
  const T = createAutoTrace({ dir });
  T.begin("wr-3");
  const f = T.fileOf("wr-3");
  const old = Date.now() - 10 * 24 * 3600 * 1000;
  fs.utimesSync(f, old / 1000, old / 1000);
  const r = T.sweep(7 * 24 * 3600 * 1000);
  assert.equal(r.removed, 1);
  assert.equal(fs.existsSync(f), false);
});

test("大对象与循环引用不会写进轨迹", () => {
  const dir = tmpDir();
  const T = createAutoTrace({ dir });
  const big = { nested: { deep: { deeper: 1 } } };
  big.self = big;
  T.begin("wr-4", { meta: big, list: [1, 2, 3], note: "x".repeat(1000) });
  const rows = T.read("wr-4");
  assert.equal(rows[0].meta, "[obj]");
  assert.equal(rows[0].list.length, 3);
  assert.equal(rows[0].note.length, 300);
});

test("runId 里的路径字符被安全化，不会写出目录之外", () => {
  const dir = tmpDir();
  const T = createAutoTrace({ dir });
  T.begin("../../evil");
  const f = T.fileOf("../../evil");
  assert.equal(path.dirname(f), dir);
  assert.ok(!f.includes(".."));
});

test("缺 dir 直接报错（防止静默写到当前目录）", () => {
  assert.throws(() => createAutoTrace({}), /dir 必填/);
});

test("stats 统计运行数与步数", () => {
  const dir = tmpDir();
  const T = createAutoTrace({ dir });
  T.begin("wr-5");
  T.step("wr-5", { a: 1 });
  T.step("wr-5", { a: 2 });
  const s = T.stats();
  assert.equal(s.runs, 1);
  assert.equal(s.steps, 2);
});
