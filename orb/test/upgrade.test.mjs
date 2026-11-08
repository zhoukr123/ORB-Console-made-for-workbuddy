/* 升级器测试：守的是"换档这件事必须解释得清"。
 * 三条硬规则：表外转移拒绝、降级必须带原因、旧世代转移作废。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createUpgrade, LADDERS } from "../upgrade.mjs";

const mk = (epoch = 0) => createUpgrade({ now: () => 1000, epoch: () => epoch });

test("合法升级/降级都记一条，带方向与原因", () => {
  const u = mk(3);
  const up = u.transition("visual", "fast", "deep", { cause: "task-heavy", epoch: 3 });
  assert.equal(up.ok, true);
  assert.equal(up.dir, "up");
  assert.equal(up.cause, "task-heavy");
  const down = u.transition("visual", "deep", "normal", { cause: "latency-recovered", epoch: 3 });
  assert.equal(down.dir, "down");
  const s = u.stats();
  assert.equal(s.total, 2);
  assert.equal(s.up, 1);
  assert.equal(s.down, 1);
  assert.equal(s.rejected, 0);
});

test("表外转移被拒（拼错档位名不能静默生效）", () => {
  const u = mk(0);
  assert.equal(u.transition("visual", "fast", "max", { cause: "x" }).reason, "unknown-state");
  assert.equal(u.transition("nope", "fast", "deep", { cause: "x" }).reason, "unknown-ladder");
  /* channel 没有 primary→none 这条 */
  assert.equal(u.transition("channel", "primary", "none", { cause: "x" }).reason, "illegal-transition");
  assert.equal(u.stats().rejected, 3);
  assert.equal(u.stats().total, 0);
});

test("降级必须带原因：不带就拒，且不入账", () => {
  const u = mk(0);
  const r = u.transition("visual", "deep", "fast", {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing-cause");
  assert.equal(u.stats().total, 0);
  assert.equal(u.last("visual"), null);
});

test("升级不带原因也允许（往安全/更稳的方向走不需要解释）", () => {
  const u = mk(0);
  const r = u.transition("visual", "fast", "deep", {});
  assert.equal(r.ok, true);
  assert.equal(r.dir, "up");
});

test("同档位不算转移，返回 noop 且不记账", () => {
  const u = mk(0);
  const r = u.transition("visual", "fast", "fast", { cause: "retry" });
  assert.equal(r.ok, true);
  assert.equal(r.noop, true);
  assert.equal(u.stats().total, 0);
});

test("旧世代转移作废（急停之后迟到的回调不许把状态改回去）", () => {
  const u = mk(5);
  const r = u.transition("visual", "deep", "fast", { cause: "late-callback", epoch: 4 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "stale-epoch");
  assert.equal(r.current, 5);
  assert.equal(u.stats().stale, 1);
  assert.equal(u.stats().total, 0);
});

test("显式更高的 epoch 允许（预置下一次世代）", () => {
  const u = mk(5);
  const r = u.transition("mode", "normal", "max", { cause: "pre-arm", epoch: 6 });
  assert.equal(r.ok, true);
  assert.equal(r.epoch, 6);
});

test("history 新的在前，按阶梯过滤", () => {
  const u = mk(0);
  u.transition("visual", "fast", "normal", { cause: "a" });
  u.transition("visual", "normal", "deep", { cause: "b" });
  u.transition("mode", "normal", "max", { cause: "c" });
  const all = u.history({ limit: 10 });
  assert.equal(all.length, 3);
  assert.equal(all[0].ladder, "mode");
  const v = u.history({ ladder: "visual", limit: 10 });
  assert.equal(v.length, 2);
  assert.equal(v[0].to, "deep");
});

test("last 给「现在是为什么在这一档」", () => {
  const u = mk(0);
  assert.equal(u.last("visual"), null);
  u.transition("visual", "fast", "deep", { cause: "task-heavy" });
  assert.equal(u.last("visual").cause, "task-heavy");
});

test("环形上限 200：超过就丢最老的，但 total 照涨", () => {
  const u = mk(0);
  for (let i = 0; i < 220; i++) {
    u.transition("visual", i % 2 === 0 ? "fast" : "deep", i % 2 === 0 ? "deep" : "fast", { cause: "c" + i });
  }
  assert.equal(u.stats().total, 220);
  assert.equal(u.history({ limit: 1000 }).length, 200);
});

test("每条阶梯的关键路径都通（转移表没有断头路）", () => {
  const u = mk(0);
  /* 不是"首档到末档"都要通：channel 的 primary→none 就是**故意**不允许的
     （主路坏了必须先落到备路，跳过备路直达 none 是错误状态）。
     所以这里只点检各阶梯真正要走的那一步。 */
  const must = [
    ["visual", "fast", "deep"],
    ["visual", "deep", "fast"],
    ["route", "command", "vision"],
    ["route", "vision", "command"],
    ["channel", "primary", "backup"],
    ["channel", "backup", "none"],
    ["mode", "normal", "max"],
    ["mode", "max", "normal"],
  ];
  for (const [ladder, from, to] of must) {
    const r = u.transition(ladder, from, to, { cause: "probe" });
    assert.equal(r.ok, true, `${ladder}: ${from} → ${to} 走不通`);
  }
  /* 跳过备路直达 none 必须被拒 */
  const skip = u.transition("channel", "primary", "none", { cause: "x" });
  assert.equal(skip.ok, false, "primary→none 必须走不通（得先落到备路）");
});
