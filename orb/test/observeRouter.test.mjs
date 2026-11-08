/* observeRouter 单测：不建单 / 两档强度 / 被拒有 disposition / 样本不足不开自动 / flush 幂等。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createObserveRouter, REASON_CODES } from "../observeRouter.mjs";

const dirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-obs-"));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const mk = (o = {}) => createObserveRouter({ now: () => 1000, ...o });

test("API 契约：仅暴露六个方法，assess 只返回判定字段、绝不建单", () => {
  const r = mk();
  assert.deepEqual(Object.keys(r).sort(), ["assess", "recordHuman", "stats", "canEnableAuto", "flush", "rows"].sort());
  const res = r.assess({ source: "user", ruleId: "R1" });
  assert.deepEqual(Object.keys(res).sort(), ["routeAttemptId", "ruleId", "decision", "wouldAccept", "confidence", "reasonCode"].sort());
  assert.equal(typeof res.wouldAccept, "boolean");
  assert.equal(res.ticketId, undefined);
  assert.equal(res.ticket, undefined);
  assert.equal(res.action, undefined);
  // 所有行都是纯判定记录，没有任何建单/执行字段
  for (const row of r.rows()) {
    assert.equal(row.ticketId, undefined);
    assert.equal(row.action, undefined);
    assert.equal(row.executed, undefined);
  }
});

test("两档强度 + 系统自身事件直接丢弃", () => {
  const r = mk();
  const explicit = r.assess({ source: "user" });
  const inferred = r.assess({ source: "trigger" });
  const self = r.assess({ source: "system" });
  assert.equal(explicit.decision, "accept");
  assert.equal(explicit.wouldAccept, true);
  assert.equal(explicit.reasonCode, "explicit-request");
  assert.equal(inferred.decision, "ignore");
  assert.equal(inferred.wouldAccept, false);
  assert.equal(inferred.reasonCode, "inferred-candidate");
  assert.equal(self.decision, "filtered");
  assert.equal(self.reasonCode, "self-event");
  assert.equal(self.wouldAccept, false);
});

test("每个被拒事件都有 disposition(带 reasonCode)，accept 无", () => {
  const r = mk();
  r.assess({ source: "user" });                       // accept
  r.assess({ source: "trigger" });                    // ignore
  r.assess({ source: "system" });                     // filtered
  r.assess({ source: "user", key: "dup" });           // accept
  r.assess({ source: "user", key: "dup" });           // duplicate
  r.assess({ source: "user", overBudget: true });     // over-budget
  r.assess({ source: "user", confidence: 0.1 });      // low-confidence
  r.assess({ source: "meteor" });                     // unsupported
  const rows = r.rows();
  const rejected = rows.filter((x) => x.decision !== "accept");
  assert.ok(rejected.length >= 6);
  for (const row of rejected) {
    assert.ok(row.disposition, `被拒事件必须有 disposition: ${row.reasonCode}`);
    assert.equal(row.disposition.rejected, true);
    assert.equal(row.disposition.reasonCode, row.reasonCode);
  }
  for (const row of rows.filter((x) => x.decision === "accept")) {
    assert.equal(row.disposition, null);
  }
});

test("reasonCode 固定枚举全部可达", () => {
  const r = mk();
  const codes = new Set();
  codes.add(r.assess({ source: "system" }).reasonCode);            // self-event
  codes.add(r.assess({ source: "user", key: "k" }).reasonCode);    // explicit-request
  codes.add(r.assess({ source: "user", key: "k" }).reasonCode);    // duplicate
  codes.add(r.assess({ source: "user", overBudget: true }).reasonCode); // over-budget
  codes.add(r.assess({ source: "user", confidence: 0.1 }).reasonCode);  // low-confidence
  codes.add(r.assess({ source: "meteor" }).reasonCode);            // unsupported
  codes.add(r.assess({ source: "trigger" }).reasonCode);           // inferred-candidate
  for (const c of REASON_CODES) assert.ok(codes.has(c), `缺少 reasonCode: ${c}`);
});

test("样本不足 canEnableAuto=false；达标且命中率够才 true", () => {
  const r = mk({ minSamples: 3, hitThreshold: 0.6 });
  // 未标注：样本不足
  const e1 = r.assess({ source: "user" });
  r.recordHuman({ routeAttemptId: e1.routeAttemptId, shouldCreateTicket: true, accepted: true });
  assert.equal(r.canEnableAuto().ok, false);
  assert.match(r.canEnableAuto().reason, /样本不足/);

  const e2 = r.assess({ source: "user" });
  const e3 = r.assess({ source: "user" });
  r.recordHuman({ routeAttemptId: e2.routeAttemptId, shouldCreateTicket: true, accepted: true });
  r.recordHuman({ routeAttemptId: e3.routeAttemptId, shouldCreateTicket: true, accepted: true });
  assert.equal(r.stats().samples, 3);
  assert.equal(r.stats().hitRate, 1);
  assert.equal(r.canEnableAuto().ok, true);
});

test("命中率不足 canEnableAuto=false", () => {
  const r = mk({ minSamples: 2, hitThreshold: 0.9 });
  for (let i = 0; i < 2; i++) {
    const e = r.assess({ source: "user" }); // wouldAccept=true
    r.recordHuman({ routeAttemptId: e.routeAttemptId, shouldCreateTicket: false }); // 真值冲突
  }
  assert.equal(r.stats().hitRate, 0);
  const c = r.canEnableAuto();
  assert.equal(c.ok, false);
  assert.match(c.reason, /命中率不足/);
});

test("recordHuman 更新 stats，flush 幂等 JSONL 追加", () => {
  const file = path.join(tmp(), "observe.jsonl");
  const r = mk({ fs, file });
  const e = r.assess({ source: "user", owner: "bot" });
  assert.equal(r.recordHuman({ routeAttemptId: e.routeAttemptId, correctOwner: "alice", shouldCreateTicket: true, accepted: true }).ok, true);
  assert.equal(r.recordHuman({ routeAttemptId: "nope" }).ok, false);
  const s = r.stats();
  assert.equal(s.samples, 1);
  assert.equal(s.misrouteRate, 1); // owner=bot vs correctOwner=alice

  assert.equal(r.flush().appended, 1);
  assert.equal(r.flush().appended, 0);
  const raw = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(raw.length, 1);
  const row = JSON.parse(raw[0]);
  assert.equal(row.human.correctOwner, "alice");
});
