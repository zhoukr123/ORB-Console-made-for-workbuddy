import test from "node:test";
import assert from "node:assert/strict";
import { createStateWriter, RANK, STATE_WRITERS, TERMINAL } from "../stateWriters.mjs";

test("写者表登记完整，每条都有 owner / via / rule", () => {
  assert.ok(STATE_WRITERS.length >= 6);
  for (const w of STATE_WRITERS) {
    assert.ok(w.owner && w.via && w.rule, "写者表字段必须齐");
  }
  assert.ok(STATE_WRITERS.some((w) => w.via.includes("settleJobTicket")));
  assert.ok(STATE_WRITERS.some((w) => w.owner === "createStateWriter.commit"));
});

test("RANK 与 ticketStore 口径一致：error > stopping > ready", () => {
  assert.ok(RANK.failed > RANK.ready);
  assert.ok(RANK.stopped > RANK.failed);
  assert.ok(RANK.aborted > RANK.failed);
  assert.equal(RANK.ready, RANK.done);
  for (const s of TERMINAL) assert.ok(RANK[s] >= RANK.failed || s === "done");
});

test("降级写入被拒：failed → ready 不允许", () => {
  const w = createStateWriter({ now: () => 1 });
  assert.equal(w.commit("t1", "running").ok, true);
  assert.equal(w.commit("t1", "failed", { cause: "err" }).ok, true);
  const r = w.commit("t1", "ready", { cause: "迟到的回调" });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "terminal-to-success", "迟到的成功回调要能一眼认出来");
  assert.equal(w.get("t1").status, "failed");
});

test("终态不许回写成成功，也不许重复结算", () => {
  const w = createStateWriter({ now: () => 1 });
  w.commit("t1", "done");
  assert.equal(w.commit("t1", "done").reason, "duplicate-terminal");
  const w2 = createStateWriter({ now: () => 1 });
  w2.commit("t2", "stopped");
  assert.equal(w2.commit("t2", "done").reason, "terminal-to-success");
});

test("rev 单调递增，onCommit 只收到被接受的提交", () => {
  const seen = [];
  const w = createStateWriter({ now: () => 1, onCommit: (r) => seen.push(r.status) });
  w.commit("t1", "running");
  w.commit("t1", "done");
  w.commit("t1", "ready");
  assert.equal(w.get("t1").rev, 2);
  assert.deepEqual(seen, ["running", "done"]);
  assert.equal(w.stats().rejected, 1);
});

test("10 万次随机翻转：失败态出现后终态永远不为 ready", () => {
  const w = createStateWriter({ now: () => 1 });
  const states = ["queued", "running", "ready", "done", "failed", "blocked", "stopped", "aborted", "dropped"];
  let seed = 20261104;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let sawFailure = false;
  for (let i = 0; i < 100000; i++) {
    w.commit("stress", states[Math.floor(rnd() * states.length)], { cause: "stress", epoch: 1 });
    const cur = w.get("stress").status;
    if (TERMINAL.has(cur) && cur !== "done") sawFailure = true;
    if (sawFailure) assert.notEqual(cur, "ready", `第 ${i} 次翻转把失败态盖成了 ready`);
  }
  assert.equal(w.stats().tracked, 1);
});
