/* session 单测：跨午夜归结束日、stop 标 interrupted + 冻结、生命周期 / idle / stats。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionManager } from "../session.mjs";

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orb-session-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const shanghaiDay = (utcMs) => new Date(utcMs + 8 * 3600 * 1000).toISOString().slice(0, 10);

test("dayOf：固定 UTC+8，不依赖宿主 TZ；跨午夜结束时刻归新的一天", () => {
  const mgr = createSessionManager({ root: tmp(), now: () => 0 });
  const startTs = Date.UTC(2026, 0, 1, 15, 50, 0);   // 上海 2026-01-01 23:50
  const endTs = Date.UTC(2026, 0, 1, 16, 10, 0);     // 上海 2026-01-02 00:10
  assert.equal(shanghaiDay(startTs), "2026-01-01");
  assert.equal(shanghaiDay(endTs), "2026-01-02");
  assert.equal(mgr.dayOf(startTs), "2026-01-01");
  assert.equal(mgr.dayOf(endTs), "2026-01-02");
  assert.match(mgr.dayOf(endTs), /^\d{4}-\d{2}-\d{2}$/);
});

test("跨午夜 23:50 → 00:10 会话全部归 00:10 那天（按 sessionEndAt）", () => {
  let T = Date.UTC(2026, 0, 1, 15, 50, 0);
  const finalized = [];
  const root = tmp();
  const mgr = createSessionManager({
    root, now: () => T, onFinalize: (r) => finalized.push(r),
  });
  const s = mgr.start({});
  assert.equal(mgr.current().conversationId, s.conversationId);

  T = Date.UTC(2026, 0, 1, 16, 10, 0);   // 跨到次日 00:10（上海）
  const f = mgr.finalize("explicit");
  assert.equal(f.ok, true);
  assert.equal(f.sessionEndAt, T);
  assert.equal(f.day, "2026-01-02", "结束日必须归 00:10 那天");
  assert.equal(f.dir, `2026-01-02/${s.conversationId}`);
  assert.ok(!path.isAbsolute(f.dir), "dir 必须相对、不含盘符");
  assert.equal(f.interrupted, false);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].day, "2026-01-02");
});

test("会话 ID 不含路径分隔符 / start·current·touch", () => {
  let T = 1000;
  const mgr = createSessionManager({ root: tmp(), now: () => T, idleMs: 5000 });
  const a = mgr.start({ user: "u1" });
  assert.deepEqual(Object.keys(a).sort(), ["conversationId", "startedAt", "epoch"].sort());
  assert.ok(!/[\\/]/.test(a.conversationId), "id 不得含 / 或 \\");
  assert.equal(a.startedAt, 1000);
  assert.equal(mgr.current().epoch, a.epoch);
  assert.equal(mgr.current().meta.user, "u1");
  T = 2000;
  const t = mgr.touch();
  assert.equal(t.ok, true);
  assert.equal(t.lastActiveAt, 2000);
  assert.equal(mgr.current().lastActiveAt, 2000);
});

test("stop 必须标 interrupted:true，且该组冻结为只读快照", () => {
  let T = 1000;
  const finalized = [];
  const mgr = createSessionManager({
    root: tmp(), now: () => T, onFinalize: (r) => finalized.push(r),
  });
  mgr.start({});
  const f = mgr.finalize("stop");
  assert.equal(f.interrupted, true);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0].interrupted, true);
  assert.equal(finalized[0].frozen, true, "interrupted 会话冻结为只读快照");
  assert.equal(mgr.current(), null, "finalize 后无活动会话");
  assert.equal(mgr.stats().interrupted, 1);
});

test("finalize 无活动会话返回 no-active-session；其它 reason 不标 interrupted", () => {
  let T = 1000;
  const mgr = createSessionManager({ root: tmp(), now: () => T });
  const none = mgr.finalize("explicit");
  assert.deepEqual(none, { ok: false, reason: "no-active-session" });
  mgr.start({});
  assert.equal(mgr.finalize("before-quit").interrupted, false);
  mgr.start({});
  assert.equal(mgr.finalize("idle").interrupted, false);
  assert.equal(mgr.stats().interrupted, 0);
});

test("finalize 绝不创建磁盘目录：存储根下不得出现根级 <YYYY-MM-DD> 空壳", () => {
  const root = tmp();
  const T = Date.UTC(2026, 10, 8, 8, 0, 0);   // 上海 2026-11-08 16:00
  const mgr = createSessionManager({ root, now: () => T });
  mgr.start({});
  const f = mgr.finalize("explicit");
  assert.equal(f.ok, true);
  assert.equal(f.day, "2026-11-08");
  assert.equal(f.dir, `2026-11-08/${f.conversationId}`, "dir 仍是相对逻辑路径，不代表要建目录");

  const entries = fs.readdirSync(root);
  assert.ok(
    !entries.some((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)),
    `存储根下不允许出现根级日期目录，实际：${entries.join(", ") || "(空)"}`
  );
  assert.deepEqual(entries, [], "session.mjs 不建任何磁盘目录，目录由 artifactLayout.ensureDay() 统一建");

  // startNew / idleCheck 两条收尾路径同样不得建目录
  mgr.start({});
  mgr.startNew({ n: 2 });
  const mgr2 = createSessionManager({ root, now: () => T, idleMs: 0 });
  mgr2.start({});
  assert.equal(mgr2.idleCheck().ok, true);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("startNew 先 finalize(new-session) 再 start；idleCheck 超时自动收尾", () => {
  let T = 1000;
  const mgr = createSessionManager({ root: tmp(), now: () => T, idleMs: 3000 });
  const first = mgr.start({ n: 1 });
  const second = mgr.startNew({ n: 2 });
  assert.notEqual(second.conversationId, first.conversationId);
  assert.equal(mgr.current().meta.n, 2);
  assert.equal(mgr.stats().totalFinalized, 1);

  const notIdle = mgr.idleCheck();
  assert.deepEqual(notIdle, { ok: false, reason: "not-idle" });
  T = 1000 + 3000;   // 恰好达到 idleMs
  const idle = mgr.idleCheck();
  assert.equal(idle.ok, true);
  assert.equal(idle.reason, undefined);
  assert.equal(mgr.current(), null);
  assert.equal(mgr.stats().totalFinalized, 2);
  assert.equal(mgr.stats().active, false);
  assert.deepEqual(mgr.idleCheck(), { ok: false, reason: "not-idle" });
});
