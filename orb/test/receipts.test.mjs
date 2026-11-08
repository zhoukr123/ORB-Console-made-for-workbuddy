/* receipts 单测：幂等键绝不重复发 / settle / get·byKey / 内存归属 interruption /
 * stats / flush 幂等。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReceipts } from "../receipts.mjs";

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orb-receipt-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("issue：同一 idempotencyKey 重复调用返回同一 receiptId 且绝不重复发", () => {
  const rc = createReceipts({ now: () => 1000 });
  const a = rc.issue({ ticketId: "t1", effect: "click", idempotencyKey: "k1" });
  assert.equal(a.duplicate, false);
  assert.equal(typeof a.generation, "number");
  assert.ok(a.receiptId);
  const b = rc.issue({ ticketId: "t1", effect: "click", idempotencyKey: "k1" });
  assert.equal(b.duplicate, true);
  assert.equal(b.receiptId, a.receiptId, "重复调用返回同一收据");
  assert.equal(b.generation, a.generation);
  assert.equal(rc.stats().issued, 1, "只发一次");
  assert.equal(rc.stats().duplicates, 1);
});

test("issue：不同键生成不同收据与递增 generation", () => {
  const rc = createReceipts({ now: () => 1000 });
  const a = rc.issue({ idempotencyKey: "k1" });
  const b = rc.issue({ idempotencyKey: "k2" });
  assert.notEqual(a.receiptId, b.receiptId);
  assert.ok(b.generation > a.generation);
  assert.equal(rc.stats().issued, 2);
});

test("settle：落 ok/result，重复 settle 不重复计数，未知收据不崩", () => {
  const rc = createReceipts({ now: () => 1000 });
  const a = rc.issue({ idempotencyKey: "k1" });
  const s = rc.settle(a.receiptId, { ok: true, result: { id: 7 } });
  assert.equal(s.ok, true);
  assert.equal(s.receipt.settled, true);
  assert.equal(s.receipt.ok, true);
  assert.deepEqual(s.receipt.result, { id: 7 });
  assert.equal(rc.stats().settled, 1);
  rc.settle(a.receiptId, { ok: false, result: "again" });
  assert.equal(rc.stats().settled, 1, "重复 settle 不重复计数");
  assert.deepEqual(rc.settle("nope", {}), { ok: false, receipt: null });
});

test("get / byKey 返回收据副本，未知返回 null", () => {
  const rc = createReceipts({ now: () => 1000 });
  const a = rc.issue({ idempotencyKey: "k1", ticketId: "t9" });
  assert.equal(rc.get(a.receiptId).ticketId, "t9");
  assert.equal(rc.byKey("k1").receiptId, a.receiptId);
  assert.equal(rc.byKey("nope"), null);
  assert.equal(rc.get("nope"), null);
});

test("memoryOwnership：snake_case 字段 + worker 交接标 interruption", () => {
  const rc = createReceipts({ now: () => 1000 });
  const m1 = rc.memoryOwnership({ workerId: "w1", ticketId: "t1", epoch: 2, version: 3 });
  assert.deepEqual(m1, { worker_id: "w1", ticket_id: "t1", epoch: 2, version: 3 });
  assert.equal(m1.interruption, undefined);
  const m2 = rc.memoryOwnership({ workerId: "w2", ticketId: "t1", epoch: 2, version: 4 });
  assert.equal(m2.interruption, true, "worker 变更即交接中断");
  const m3 = rc.memoryOwnership({ workerId: "w3", ticketId: "t2", epoch: 1, version: 1, interruption: true });
  assert.equal(m3.interruption, true, "显式中断也标注");
});

test("stats 固定四键 + flush 幂等", () => {
  const file = path.join(tmp(), "r.jsonl");
  const rc = createReceipts({ now: () => 1000, file });
  const a = rc.issue({ idempotencyKey: "k1" });
  rc.issue({ idempotencyKey: "k2" });
  rc.settle(a.receiptId, { ok: true, result: null });
  const st = rc.stats();
  assert.deepEqual(Object.keys(st).sort(),
    ["issued", "settled", "duplicates", "pending", "generation", "keys", "max"].sort());
  assert.equal(st.issued, 2);
  assert.equal(st.settled, 1);
  assert.equal(st.pending, 1);
  assert.equal(st.duplicates, 0);
  assert.ok(rc.flush().appended >= 1);
  assert.equal(rc.flush().appended, 0, "幂等");
});

/* ---------------- 跨进程幂等（2026-11-05 新增） ----------------
 * 这组测的是"进程重启后幂等还在不在"。内存态的实现全都能过前 6 条，
 * 却会在重启后把同一件事做第二遍 —— 那正是这套东西存在的理由。
 */
test("load: 重启后已结算的 key 仍判为重复，并能取回上次结果", () => {
  const snap = path.join(tmp(), "receipts.jsonl");
  const a = createReceipts({ now: () => 1000, snapshot: snap });
  const r1 = a.issue({ idempotencyKey: "send#1", ticketId: "t1" });
  assert.equal(r1.duplicate, false);
  a.settle(r1.receiptId, { ok: true, result: { jobId: "job-7" } });

  const b = createReceipts({ now: () => 2000, snapshot: snap });
  const l = b.load();
  assert.equal(l.loaded, 1);
  const again = b.issue({ idempotencyKey: "send#1", ticketId: "t1" });
  assert.equal(again.duplicate, true);
  assert.equal(again.existing.settled, true);
  assert.deepEqual(again.existing.result, { jobId: "job-7" });
  assert.equal(b.stats().generation, 1, "generation 要接着历史往下走，不能归零");
});

test("load: 未结算的收据不被恢复（宁可重做一次，也不能吞掉真实重试）", () => {
  const snap = path.join(tmp(), "receipts2.jsonl");
  const a = createReceipts({ now: () => 1000, snapshot: snap });
  a.issue({ idempotencyKey: "send#2", ticketId: "t1" });   // 只发不结算
  a.save();

  const b = createReceipts({ now: () => 2000, snapshot: snap });
  assert.equal(b.load().loaded, 0, "未结算的不能恢复");
  assert.equal(b.byKey("send#2"), null);
  assert.equal(b.issue({ idempotencyKey: "send#2" }).duplicate, false, "重启后应当可以重做");
});

test("generation 续接：重启后再发新收据，id 不撞车", () => {
  const snap = path.join(tmp(), "receipts3.jsonl");
  const a = createReceipts({ now: () => 1000, snapshot: snap });
  const r1 = a.issue({ idempotencyKey: "k1" });
  a.settle(r1.receiptId, { ok: true });
  const b = createReceipts({ now: () => 2000, snapshot: snap });
  b.load();
  const r2 = b.issue({ idempotencyKey: "k2" });
  assert.equal(r2.generation, 2);
  assert.notEqual(r2.receiptId, r1.receiptId);
});

test("prune: 只丢最老的已结算收据，未结算的一条都不丢", () => {
  const c = createReceipts({ now: () => 1000, max: 2 });
  const a = c.issue({ idempotencyKey: "a" });
  const b = c.issue({ idempotencyKey: "b" });   // 两条都不结算
  c.prune();
  assert.equal(c.stats().pending, 2, "全都没结算时 prune 不能动");
  c.settle(a.receiptId, { ok: true });
  c.settle(b.receiptId, { ok: true });
  c.issue({ idempotencyKey: "c" });             // 已超上限（2）
  c.settle(c.byKey("c").receiptId, { ok: true });
  c.prune();
  assert.equal(c.stats().keys <= 3, true);
  assert.equal(c.byKey("a"), null, "最老的已结算收据被清掉");
});

test("重复提交但上一次还没结算 → existing.settled=false（调用方应拒绝并行再开一份）", () => {
  const c = createReceipts({ now: () => 1000 });
  c.issue({ idempotencyKey: "inflight" });
  const again = c.issue({ idempotencyKey: "inflight" });
  assert.equal(again.duplicate, true);
  assert.equal(again.existing.settled, false);
});

test("审计队列有上限：落盘后裁剪，不会随运行时长无界增长", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orb-rcpt-audit-"));
  const file = path.join(root, "audit.jsonl");
  try {
    const c = createReceipts({ file: () => file, now: () => 1000 });
    for (let i = 0; i < 25000; i++) c.issue({ idempotencyKey: "k" + i });
    const f = c.flush();
    /* 硬上限 20000：flush 一次最多把这么多条落盘，多出来的更老的已被丢弃。 */
    assert.ok(f.appended <= 20000, "一次 flush 落盘 " + f.appended + " 条，超出硬上限");
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(lines.length, f.appended);
    /* 再 flush 一次不应重复写：裁剪后 flushed 与 audit.length 对齐。 */
    assert.equal(c.flush().appended, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
