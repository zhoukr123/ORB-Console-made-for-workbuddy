/* 治理层测试：轨迹 / 看门狗 / Worker 池。
 * 运行：node --test orb/test/governance.test.mjs
 *
 * 这三个模块的共同点是"有时间行为"，所以全部用**注入时钟 + 手动推进**，
 * 不用真实 sleep —— 否则 CI 上要么慢要么随机失败。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createTrajectory } from "../trajectory.mjs";
import { createWatchdog } from "../watchdog.mjs";
import { createWorkerPool } from "../workerPool.mjs";
import { createGuiLock } from "../guiLock.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orb-gov-"));
const tick = () => new Promise((r) => setImmediate(r));

/* ============================ trajectory ============================ */

test("轨迹：追加可回读，坏行不拖垮整份", () => {
  const dir = tmp();
  const tr = createTrajectory({ dir, now: () => 1000 });
  tr.append("t1", { type: "step", name: "a" });
  tr.append("t1", { type: "step", name: "b" });
  const rows = tr.read("t1");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].name, "b");

  // 手工塞一行坏 JSON：只应坏这一行
  fs.appendFileSync(tr.fileOf("t1"), "{oops\n");
  const rows2 = tr.read("t1");
  assert.equal(rows2.length, 3);
  assert.equal(rows2[2].type, "corrupt");
});

test("轨迹：检查点只认轨迹，不另存一份", () => {
  const tr = createTrajectory({ dir: tmp(), now: () => 2000 });
  tr.append("t", { type: "step", name: "open" });
  tr.append("t", { type: "file.write", path: "C:/a.txt" });     // 副作用
  tr.append("t", { type: "artifact", path: "C:/out.mp4" });
  tr.append("t", { type: "error", message: "boom" });

  const cp = tr.checkpoint("t");
  assert.equal(cp.steps, 1);
  assert.equal(cp.sideEffects.length, 1, "file.write 应被识别为已产生外部后果");
  assert.equal(cp.sideEffects[0].target, "C:/a.txt");
  assert.equal(cp.artifacts.length, 1);
  assert.equal(cp.errors.length, 1);
  assert.match(cp.note, /不能整体重放/);
});

test("轨迹：没有外部副作用时明确说可整体重放", () => {
  const tr = createTrajectory({ dir: tmp() });
  tr.append("t", { type: "step", name: "open" });
  assert.match(tr.checkpoint("t").note, /可整体重放/);
  assert.equal(tr.checkpoint("nope"), null);
});

/* ============================ watchdog ============================ */

const fakeTickets = (list) => ({ list: () => list });

test("看门狗：长时间无进展要报，正常推进不报", () => {
  let clock = 100_000;
  const tickets = fakeTickets([
    { id: "a", title: "卡住的", status: "running", createdAt: 0, updatedAt: 0, epoch: 1 },
    { id: "b", title: "正常的", status: "running", createdAt: 0, updatedAt: clock - 1000, epoch: 1 },
  ]);
  const alerts = [];
  const wd = createWatchdog({
    tickets, now: () => clock, staleMs: 60_000,
    onAlert: (a) => alerts.push(a),
  });

  const r = wd.tick();
  assert.equal(r.checked, 2);
  assert.deepEqual(r.stalled.map((x) => x.ticketId), ["a"]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "stalled");
  // 默认不动手：只给建议，不杀任务
  assert.equal(r.acted[0].suggestion, "report");
  assert.equal(wd.status().allowAbort, false);
});

test("看门狗：轨迹更新时间优先于工单字段", () => {
  let clock = 100_000;
  const tickets = fakeTickets([{ id: "a", status: "running", createdAt: 0, updatedAt: 0, epoch: 1 }]);
  // 工单字段很旧，但轨迹刚刚还有动作 → 不算卡住
  const trajectory = { checkpoint: () => ({ lastAt: clock - 500 }), read: () => [] };
  const wd = createWatchdog({ tickets, trajectory, now: () => clock, staleMs: 60_000 });
  assert.equal(wd.tick().stalled.length, 0);
});

test("看门狗：同一错误反复才算故障", () => {
  const clock = 100_000;
  const tickets = fakeTickets([{ id: "a", status: "running", createdAt: clock - 10, updatedAt: clock, epoch: 1 }]);
  const rows = [
    { type: "error", message: "ECONNREFUSED" },
    { type: "error", message: "ECONNREFUSED" },
    { type: "error", message: "ECONNREFUSED" },
    { type: "error", message: "偶发一次" },
  ];
  const trajectory = { checkpoint: () => null, read: () => rows };
  const wd = createWatchdog({ tickets, trajectory, now: () => clock, repeatN: 3 });
  const r = wd.tick();
  assert.equal(r.repeating.length, 1);
  assert.equal(r.repeating[0].count, 3);
  assert.equal(r.repeating[0].message, "ECONNREFUSED");
});

test("看门狗：开关与手动 tick 不抛", () => {
  const wd = createWatchdog({ tickets: fakeTickets([]), now: () => 1 });
  assert.equal(wd.start(5000).ok, true);
  assert.equal(wd.status().running, true);
  assert.equal(wd.stop().ok, true);
  assert.equal(wd.status().running, false);
  assert.equal(wd.tick().checked, 0);
});

/* ============================ workerPool ============================ */

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test("Worker 池：默认 1 个槽，串行执行", async () => {
  const pool = createWorkerPool({ maxWorkers: 1, now: () => 1 });
  const gates = [deferred(), deferred()];
  const order = [];
  for (let i = 0; i < 2; i++) {
    pool.submit({
      id: "w" + i, kind: "job", priority: "background",
      run: async () => { order.push("start" + i); await gates[i].promise; order.push("end" + i); },
    });
  }
  await tick(); await tick();
  assert.deepEqual(order, ["start0"], "第二个必须排队");
  assert.equal(pool.status().queued, 1);

  gates[0].resolve();
  await tick(); await tick(); await tick();
  assert.deepEqual(order, ["start0", "end0", "start1"]);
  gates[1].resolve();
  await tick(); await tick();
  assert.equal(pool.status().running, 0);
});

test("Worker 池：人类请求优先（可多占一个槽）", async () => {
  const pool = createWorkerPool({ maxWorkers: 1, now: () => 1 });
  const gate = deferred();
  const order = [];
  pool.submit({ id: "bg1", priority: "background", run: async () => { order.push("bg1"); await gate.promise; } });
  pool.submit({ id: "bg2", priority: "background", run: async () => { order.push("bg2"); } });
  pool.submit({ id: "human", priority: "human", run: async () => { order.push("human"); } });
  await tick(); await tick(); await tick();

  /* 人类请求不排队：它插到队首，所以先于两个后台任务开跑。
   * 这正是原型的做法 —— 用户敲的那句不该被十个后台任务堵住。
   * 注意后台任务 bg1 此时可能还没占到槽（它排在 human 后面），
   * 所以这里断的是"顺序"而不是"并发数"：human 一定在 bg1 之前。 */
  assert.deepEqual(order, ["human", "bg1"]);
  assert.equal(pool.status().queueHead[0].id, "bg2", "后台任务继续排队");

  gate.resolve();
  await tick(); await tick(); await tick();
  assert.deepEqual(order, ["human", "bg1", "bg2"]);
});

test("Worker 池：GUI 任务无论几个槽都硬串行，且必须持锁", async () => {
  const lock = createGuiLock({ now: () => 1 });
  const pool = createWorkerPool({ maxWorkers: 4, lock, now: () => 1 });
  const gates = [deferred(), deferred()];
  let concurrentExclusive = 0;
  let maxConcurrent = 0;

  for (let i = 0; i < 2; i++) {
    pool.submit({
      id: "g" + i, kind: "vision", exclusive: true,
      run: async () => {
        concurrentExclusive++;
        maxConcurrent = Math.max(maxConcurrent, concurrentExclusive);
        await gates[i].promise;
        concurrentExclusive--;
      },
    });
  }
  await tick(); await tick();
  assert.equal(maxConcurrent, 1, "同一时刻只允许一个 GUI 任务");
  assert.equal(lock.status().locked, true, "GUI 任务应持锁");

  gates[0].resolve();
  await tick(); await tick(); await tick();
  assert.equal(maxConcurrent, 1);
  gates[1].resolve();
  await tick(); await tick(); await tick();
  assert.equal(lock.status().locked, false, "跑完必须交还");
});

test("Worker 池：急停清队且不再接单，恢复后继续", async () => {
  const pool = createWorkerPool({ maxWorkers: 1, now: () => 1 });
  const gate = deferred();
  pool.submit({ id: "a", run: async () => { await gate.promise; } });
  await tick(); await tick();
  pool.submit({ id: "b", run: async () => {} });
  pool.submit({ id: "c", run: async () => {} });

  const h = pool.halt("急停");
  assert.deepEqual(h.dropped, ["b", "c"]);
  assert.equal(pool.submit({ id: "d", run: async () => {} }).code, "halted");

  gate.resolve();
  await tick(); await tick(); await tick();
  assert.equal(pool.status().running, 0);

  pool.resume();
  const r = pool.submit({ id: "e", run: async () => {} });
  assert.equal(r.ok, true);
});

test("Worker 池：队列满要如实报，不静默丢", async () => {
  const pool = createWorkerPool({ maxWorkers: 1, maxQueue: 1, now: () => 1 });
  const gate = deferred();
  pool.submit({ id: "a", run: async () => { await gate.promise; } });
  await tick(); await tick();               // 让 a 真正开跑，队列空出来
  const second = pool.submit({ id: "b", run: async () => {} });
  assert.equal(second.ok, true, "队列还有位置时应成功");
  const third = pool.submit({ id: "c", run: async () => {} });
  assert.equal(third.ok, false);
  assert.equal(third.code, "full");
  gate.resolve();
});
