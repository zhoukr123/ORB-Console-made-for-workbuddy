/* ticketControl 单测：global 暂停只挡新工单 / 在跑不受影响 / steer 在 step 边界注入 /
 * 人工纠偏 / 告警三元组去重 / flush 幂等 / stats。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTicketControl } from "../ticketControl.mjs";

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orb-ticket-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("global 暂停只挡新工单；在跑的 isNew=false 永远 false", () => {
  const tc = createTicketControl({ now: () => 1000 });
  assert.equal(tc.isBlocked("global", { isNew: true }), false);
  tc.pause("global");
  assert.equal(tc.isBlocked("global", { isNew: true }), true);
  assert.equal(tc.isBlocked("ticket", { isNew: true }), true, "global 暂停挡所有新工单");
  assert.equal(tc.isBlocked("global", { isNew: false }), false, "在跑的不受影响");
  assert.equal(tc.isBlocked("ticket", { isNew: false }), false);
  tc.resume("global");
  assert.equal(tc.isBlocked("global", { isNew: true }), false);
});

test("ticket 作用域暂停 + 默认 isNew=true + 非法 scope 拒绝 + file=null flush 幂等", () => {
  const tc = createTicketControl({ now: () => 1000 });
  tc.pause("ticket");
  assert.equal(tc.isBlocked("ticket"), true);
  assert.equal(tc.isBlocked("ticket", {}), true);
  assert.equal(tc.isBlocked("global", { isNew: true }), false, "ticket 暂停不影响 global 新工单");
  assert.equal(tc.isBlocked("ticket", { isNew: false }), false);
  assert.equal(tc.pause("bogus").ok, false);
  assert.equal(tc.resume("bogus").ok, false);
  assert.deepEqual(tc.flush(), { ok: true, appended: 0 });
  assert.deepEqual(tc.flush(), { ok: true, appended: 0 });
});

test("steer 追加指令 pending:true，applyStep 在 step 边界一次性注入", () => {
  const tc = createTicketControl({ now: () => 1000 });
  assert.deepEqual(tc.steer("t1", "A"), { ok: true, pending: true });
  tc.steer("t1", "B");
  assert.equal(tc.stats().pendingSteers, 2);
  const r = tc.applyStep("t1", 3);
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, ["A", "B"]);
  assert.equal(r.atStep, 3);
  assert.equal(tc.stats().pendingSteers, 0);
  assert.deepEqual(tc.applyStep("t1", 4).applied, [], "已注入清空后可再次调用");
});

test("humanCorrection 返回固定 type", () => {
  const tc = createTicketControl({ now: () => 1000 });
  assert.deepEqual(tc.humanCorrection("t1", "改成 X"), { ok: true, type: "human_correction" });
});

test("alert 按 (ticket_id, reason, epoch) 三元组去重", () => {
  const tc = createTicketControl({ now: () => 1000 });
  assert.deepEqual(tc.alert("t1", "over-budget", 1), { ok: true, duplicate: false });
  assert.deepEqual(tc.alert("t1", "over-budget", 1), { ok: true, duplicate: true });
  assert.deepEqual(tc.alert("t1", "over-budget", 2), { ok: true, duplicate: false }, "epoch 不同不去重");
  assert.deepEqual(tc.alert("t2", "over-budget", 1), { ok: true, duplicate: false }, "ticket 不同不去重");
  assert.deepEqual(tc.alert("t1", "other", 1), { ok: true, duplicate: false }, "reason 不同不去重");
  assert.equal(tc.stats().alerts, 4);
  assert.equal(tc.stats().duplicates, 1);
});

test("flush 幂等写入 + stats.paused 与 pendingSteers", () => {
  const file = path.join(tmp(), "ctl.jsonl");
  const tc = createTicketControl({ now: () => 1000, file });
  tc.pause("global");
  tc.steer("t1", "A");
  tc.alert("t1", "r", 1);
  tc.humanCorrection("t1", "fix");
  const f1 = tc.flush();
  assert.ok(f1.appended >= 4);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").length;
  assert.equal(tc.flush().appended, 0, "幂等，不重复追加");
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, lines);
  assert.equal(tc.stats().paused, true);
  assert.equal(tc.stats().pendingSteers, 1);
  assert.deepEqual(Object.keys(tc.stats()).sort(),
    ["paused", "pendingSteers", "alerts", "duplicates", "controls"].sort());
});

/* ---------------- 三种控制事件（纠正 / 停止 / 换思路） ----------------
 * 这组测的是"人插手"的语义：kind 非法要拒、缺说明要拒、
 * 纠正必须同时进 steers（否则执行层会漏掉一条）、事件顺序新的在前。
 */
test("control: 三种 kind 各有固定 effect，非法 kind 被拒", () => {
  const tc = createTicketControl({ now: () => 1000 });
  assert.equal(tc.control("t1", "correct", { text: "改成 X" }).event.effect, "append-at-step");
  assert.equal(tc.control("t1", "stop", {}).event.effect, "abort-now");
  assert.equal(tc.control("t1", "rethink", { text: "换个方案" }).event.effect, "replan");
  const bad = tc.control("t1", "reboot", { text: "x" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /correct \/ stop \/ rethink/);
});

test("control: correct / rethink 缺说明直接拒（空指令等于没插手）", () => {
  const tc = createTicketControl({ now: () => 1000 });
  assert.equal(tc.control("t1", "correct", { text: "   " }).ok, false);
  assert.equal(tc.control("t1", "rethink", {}).ok, false);
  assert.equal(tc.control("t1", "stop", {}).ok, true, "stop 不需要说明");
  assert.equal(tc.control("", "stop", {}).ok, false, "缺 ticketId 要拒");
});

test("control: 纠正同时进 steers，在 step 边界被注入一次", () => {
  const tc = createTicketControl({ now: () => 1000 });
  tc.control("t1", "correct", { text: "别删那个文件" });
  assert.equal(tc.stats().pendingSteers, 1, "纠正必须同时排进 steer 队列");
  assert.deepEqual(tc.applyStep("t1", 2).applied, ["别删那个文件"]);
  assert.equal(tc.stats().pendingSteers, 0);
});

test("control: events 新的在前，且按工单隔离", () => {
  const tc = createTicketControl({ now: () => 1000 });
  tc.control("t1", "correct", { text: "A" });
  tc.control("t1", "rethink", { text: "B" });
  tc.control("t2", "stop", {});
  const e1 = tc.events("t1");
  assert.equal(e1.length, 2);
  assert.equal(e1[0].text, "B", "最新的一条在最前");
  assert.equal(e1[1].text, "A");
  assert.equal(tc.events("t2").length, 1);
  assert.deepEqual(tc.events("nope"), []);
});

test("control: lastControl 给执行层每步开头问一句", () => {
  const tc = createTicketControl({ now: () => 1000 });
  assert.equal(tc.lastControl("t1"), null);
  tc.control("t1", "stop", {});
  assert.equal(tc.lastControl("t1").kind, "stop");
});

test("control: 单工单最多留 50 条（控制事件是复盘用，不是留档全文）", () => {
  const tc = createTicketControl({ now: () => 1000 });
  for (let i = 0; i < 60; i++) tc.control("t1", "correct", { text: "c" + i });
  const e = tc.events("t1", 100);
  assert.equal(e.length, 50);
  assert.equal(e[0].text, "c59");
  assert.equal(tc.stats().controls, 60, "累计计数不受环形缓冲影响");
});

test("control: 超长说明被截断到 2000 字符", () => {
  const tc = createTicketControl({ now: () => 1000 });
  const long = "字".repeat(5000);
  const r = tc.control("t1", "correct", { text: long });
  assert.equal(r.event.text.length, 2000);
});

test("control 落进审计流（flush 能看到 control 记录）", () => {
  const file = path.join(tmp(), "ctl2.jsonl");
  const tc = createTicketControl({ now: () => 1000, file });
  tc.control("t1", "rethink", { text: "换思路" });
  tc.flush();
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const c = rows.find((r) => r.type === "control");
  assert.ok(c, "审计流里必须有 control 记录");
  assert.equal(c.kind, "rethink");
  assert.equal(c.effect, "replan");
});
