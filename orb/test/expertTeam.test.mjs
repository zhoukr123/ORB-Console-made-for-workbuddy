/* 专家团模式 = orchestrator-workers 任务分配（不是审查）。
 * 重点锁住「用户只与分配者对话」「worker 上下文隔离」「worker 只回传压缩结果」。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createExpertTeam, LEAD, WORKER_ROLES, WORKER_STATUS } from "../expertTeam.mjs";

const mk = (opts = {}) => createExpertTeam({ now: () => 1_700_000_000_000, ...opts });
const on = () => { const t = mk(); t.enable(true); return t; };

test("未开启时不能派任务，开启后才可以", () => {
  const t = mk();
  assert.equal(t.start({ text: "做个东西" }).ok, false);
  t.enable(true);
  assert.equal(t.enabled(), true);
  assert.equal(t.start({ text: "做个东西" }).ok, true);
});

test("start 产出结构化 plan：每个 worker 都有 brief / 成功判据 / 预算", () => {
  const t = on();
  const r = t.start({ text: "整理季度报告" });
  const w = r.plan.workers;
  assert.ok(w.length >= 1 && w.length <= WORKER_ROLES.length);
  for (const x of w) {
    assert.ok(x.brief && x.criterion && x.budget);
    assert.equal(x.status, "queued");
    assert.ok(WORKER_STATUS.includes(x.status));
  }
  assert.equal(r.plan.lead.id, LEAD.id);
});

test("worker 上下文隔离：brief 不含兄弟的 brief，也不把整段原文塞给每个人", () => {
  const t = on();
  const text = "甲：把登录页改好；乙：把接口文档补上；丙：核对回归用例；丁：整理发布清单";
  const r = t.start({ text });
  const ws = r.plan.workers;
  assert.ok(ws.length >= 2, "显式分项应该被拆开");
  assert.notEqual(ws[0].brief, ws[1].brief);
  for (const w of ws) {
    assert.ok(w.brief.length < text.length, "worker 不该拿到整段原文");
    for (const other of ws) {
      if (other === w) continue;
      assert.ok(!w.brief.includes(other.brief), "worker 不该看到兄弟的 brief");
    }
  }
});

test("effort scaling：简单任务不付 fan-out 成本，复杂任务才铺开", () => {
  const simple = on().decompose("你好");
  const complex = on().decompose("分别检查多个模块的代码、资料与报告，同时整理数据表并逐项核对，另外还要出一份汇总说明");
  assert.equal(simple.count, 1);
  assert.ok(complex.count >= 3);
  assert.notEqual(simple.effort, complex.effort);
});

test("用户开口只进 lead；点名 worker 时 worker 收到的是 lead 转来的指令，不是对话", () => {
  const t = on();
  t.start({ text: "甲：改登录页；乙：补文档" });
  const r = t.steer({ text: "第二个别删已有注释" });
  assert.equal(r.ok, true);
  assert.ok(r.targets.includes("w2"));
  const d = t.workerDetail("w2");
  assert.equal(d.ok, true);
  assert.equal(d.worker.steers.length, 1);
  assert.equal(d.worker.steers[0].from, "lead");
  assert.equal(d.worker.steers[0].text, "第二个别删已有注释");
  assert.equal(t.status().lead.steers, 1, "每一句都先记在分配者名下");
});

test("没点名时归 lead，不擅自分给 worker", () => {
  const t = on();
  t.start({ text: "甲：改登录页；乙：补文档" });
  const r = t.steer({ text: "整体风格稳一点" });
  assert.deepEqual(r.targets, ["lead"]);
  assert.equal(t.workerDetail("w1").worker.steers.length, 0);
});

test("重来/换方案会记到分配者的计划调整，而不是伪装成给 worker 的新任务", () => {
  const t = on();
  t.start({ text: "甲：改登录页；乙：补文档" });
  const r = t.steer({ text: "重来，换个拆法" });
  assert.ok(r.targets.includes("lead"));
  assert.equal(t.workerDetail("w1").worker.steps.length, 0);
});

test("真实 job 回读驱动状态与工作流程，卡片不是摆设", () => {
  const t = on();
  t.start({ text: "甲：改登录页；乙：补文档" });
  assert.equal(t.attachJob("w1", "job-7").ok, true);
  assert.equal(t.status().workers[0].status, "running");
  assert.equal(t.status().workers[0].jobId, "job-7");
  t.step("w1", { title: "读文件", note: "打开 login 页", state: "running" });
  t.step("w1", { title: "读文件", note: "打开 login 页", state: "running" });
  assert.equal(t.workerDetail("w1").worker.steps.length, 2, "重复步骤不灌水");
  t.complete("w1", { ok: true, result: "已改完，登录页现在走新校验" });
  assert.equal(t.status().workers[0].status, "done");
  assert.equal(t.status().workers[0].result, "已改完，登录页现在走新校验");
});

test("attachJob / complete 对不存在的 worker fail-closed", () => {
  const t = on();
  t.start({ text: "做个东西" });
  assert.equal(t.attachJob("w99", "job-x").ok, false);
  assert.equal(t.complete("w99", { ok: true }).ok, false);
  assert.equal(t.workerDetail("w99").ok, false);
});

test("aggregate 如实列缺口与冲突，不把 worker 结果硬拼成一段", () => {
  const t = on();
  t.start({ text: "甲：查资料；乙：核对" });
  t.attachJob("w1", "j1"); t.attachJob("w2", "j2");
  t.complete("w1", { ok: true, result: "可行，已完成" });
  const a = t.aggregate();
  assert.equal(a.ready, false);
  assert.ok(a.gaps.length === 1);
  assert.equal(typeof a.results[0].result, "string");
  assert.ok(!a.results[0].result.includes("核对"), "汇总不夹带未完成 worker 的内容");
  t.complete("w2", { ok: true, result: "做不到，缺少依据" });
  const b = t.aggregate();
  assert.equal(b.ready, true);
  assert.ok(b.conflicts.length >= 1, "结论相反应由分配者裁定，不能并列输出");
});

test("finish / stop / stats 收尾", () => {
  const t = on();
  assert.equal(t.finish("汇总").ok, false);
  t.start({ text: "做个东西" });
  assert.equal(t.finish("汇总完成").summary, "汇总完成");
  assert.equal(t.status().phase, "done");
  assert.equal(t.stop().stopped, true);
  assert.equal(t.status().phase, "stopped");
  const s = t.stats();
  assert.equal(s.runs, 1);
  assert.equal(s.enabled, true);
  assert.equal(s.active, false);
});
