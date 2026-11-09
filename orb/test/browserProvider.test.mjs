/* browserProvider 单测：全程注入 clock / onCommand，不发网络、不碰文件、零 npm 依赖。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createBrowserProvider,
  BROWSER_METHODS,
  BROWSER_PROTOCOL_VERSION,
} from "../browserProvider.mjs";

const HELLO = {
  type: "provider_hello",
  protocol: 1,
  extension_id: "ext-id",
  extension_version: "1.2.3",
  browser_family: "chromium",
};

/* 可变时钟：state.now 直接改写即可驱动租约过期，无需真实等待。 */
function harness(opts = {}) {
  const state = { now: 1000 };
  const p = createBrowserProvider({
    clock: () => state.now,
    epoch: "E",
    leaseTtlMs: 30_000,
    maxInflight: 8,
    maxChannels: 4,
    ...opts,
  });
  return { p, state };
}

const hello = (h) => h.p.handle({ ...HELLO });
const open = (h, ce = "ch-1", extra = {}) =>
  h.p.handle({ type: "channel_open", channel_epoch: ce, ...extra });
const cmd = (ce, cid, method, params = {}) =>
  ({ type: "command", channel_epoch: ce, command_id: cid, method, params });

test("导出签名：BROWSER_METHODS 白名单冻结、分组正确、API 齐全", () => {
  assert.equal(BROWSER_PROTOCOL_VERSION, 1);
  assert.equal(typeof createBrowserProvider, "function");
  assert.ok(Object.isFrozen(BROWSER_METHODS));
  assert.ok(Object.isFrozen(BROWSER_METHODS.read));
  assert.ok(Object.isFrozen(BROWSER_METHODS.write));
  assert.deepEqual(BROWSER_METHODS.read, [
    "dom.get_visible_dom", "dom.get_text", "dom.get_page_text", "dom.get_attributes",
    "tab.list", "tab.url", "tab.title", "browser.info",
  ]);
  assert.deepEqual(BROWSER_METHODS.write, [
    "dom.click", "dom.type", "dom.scroll",
    "tab.open",  // 2026-11-05 新增：显式开新页，归 write（有副作用，必须 confirm）
    "tab.goto",
    "tab.back", "tab.forward", "tab.reload", "tab.focus",
  ]);
  assert.deepEqual(BROWSER_METHODS.deniedPrefixes, ["cua.", "cookie."]);
  assert.deepEqual(BROWSER_METHODS.deniedExact, ["eval", "upload", "submit", "script.execute"]);
  const api = createBrowserProvider();
  for (const k of ["handle", "closeAll", "drain", "stats", "config", "isStopped", "reopen", "ownTab", "command"]) {
    assert.equal(typeof api[k], "function", k);
  }
});

test("provider_hello 回 ack：字段固定、epoch 可注入；二次 hello 换代并作废旧 channel", async () => {
  const h = harness();
  const ack = await hello(h);
  assert.deepEqual(Object.keys(ack).sort(),
    ["lease_ttl_ms", "protocol", "provider_epoch", "provider_instance_id", "type"].sort());
  assert.equal(ack.type, "provider_hello_ack");
  assert.equal(ack.protocol, 1);
  assert.equal(ack.provider_epoch, "E");
  assert.equal(ack.lease_ttl_ms, 30_000);
  assert.equal(typeof ack.provider_instance_id, "string");
  assert.equal(h.p.stats().hellos, 1);

  await open(h);
  assert.equal(h.p.stats().channels, 1);
  const ack2 = await hello(h);
  assert.notEqual(ack2.provider_epoch, ack.provider_epoch, "每次 hello 前进一代");
  assert.equal(ack2.provider_instance_id, ack.provider_instance_id, "实例 id 不变");
  assert.equal(h.p.stats().hellos, 2);
  assert.equal(h.p.stats().channels, 0, "旧 channel 被作废");
  const r = await h.p.handle(cmd("ch-1", "c1", "tab.list"));
  assert.equal(r.error.code, "epoch-mismatch");
});

test("protocol !== 1：hello 回 null，后续 command 一律 protocol-mismatch", async () => {
  for (const proto of [2, 0, "1", null, undefined]) {
    const h = harness();
    assert.equal(await h.p.handle({ ...HELLO, protocol: proto }), null);
    await open(h);
    const r = await h.p.handle(cmd("ch-1", "c1", "tab.list"));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "protocol-mismatch");
    assert.equal(r.error.retryable, false);
    assert.equal(r.error.outcome, "not_started");
    assert.equal(h.p.stats().byReason["protocol-mismatch"], 1);
    assert.equal(h.p.stats().hellos, 0);
  }
});

test("坏消息（null/非对象/缺字段/类型错/未知 type）永不抛，一律返回 null", async () => {
  const h = harness();
  const bads = [
    null, undefined, 0, 1.5, "x", true, [], [1, 2],
    {}, { type: "unknown" }, { type: 7 },
    { type: "provider_hello" },
    { type: "channel_open" }, { type: "channel_open", channel_epoch: 5 },
    { type: "channel_renew", channel_epoch: "ch-1" },
    { type: "channel_renew", channel_epoch: "ch-1", lease_deadline_ms: "x" },
    { type: "cancel" }, { type: "cancel", channel_epoch: "ch-1" },
    { type: "channel_close" },
    { type: "command" }, { type: "command", channel_epoch: "ch-1" },
  ];
  for (const b of bads) {
    assert.equal(await h.p.handle(b), null, JSON.stringify(b));
  }
  assert.equal(h.p.stats().commands, 0, "坏消息不计入 commands");
});

test("注入的 clock 抛异常也不会让 handle 崩", async () => {
  const h = harness({ clock: () => { throw new Error("clock boom"); } });
  assert.equal((await hello(h)).type, "provider_hello_ack");
  assert.equal(await open(h), null);
  assert.equal((await h.p.handle(cmd("ch-1", "c1", "tab.list"))).ok, true);
});

test("channel_open 成功回 null；重复 epoch 回 channel_closed(channel_epoch_reused)", async () => {
  const h = harness();
  await hello(h);
  assert.equal(await open(h, "ch-1"), null);
  assert.equal(h.p.stats().channels, 1);
  assert.deepEqual(await open(h, "ch-1"),
    { type: "channel_closed", channel_epoch: "ch-1", reason: "channel_epoch_reused" });
  assert.equal(h.p.stats().channels, 1);
});

test("channel_renew 成功回 null 并延长租约；channel_close 回 ack cleaned:true", async () => {
  const h = harness({ leaseTtlMs: 1000 });
  await hello(h);
  await open(h);
  assert.equal(await h.p.handle({ type: "channel_renew", channel_epoch: "ch-1", lease_deadline_ms: 999999 }), null);
  h.state.now = 500000; /* 已超过原 deadline(2000)，但 renew 后仍有效 */
  assert.equal((await h.p.handle(cmd("ch-1", "c1", "tab.list"))).ok, true);
  assert.deepEqual(await h.p.handle({ type: "channel_close", channel_epoch: "ch-1" }),
    { type: "channel_close_ack", channel_epoch: "ch-1", cleaned: true });
  assert.equal(h.p.stats().channels, 0);
  assert.equal((await h.p.handle(cmd("ch-1", "c2", "tab.list"))).error.code, "epoch-mismatch");
});

test("channel_renew 对不存在 / 已过期 channel 回 channel_closed(channel_expired)", async () => {
  const h = harness({ leaseTtlMs: 1000 });
  await hello(h);
  assert.deepEqual(
    await h.p.handle({ type: "channel_renew", channel_epoch: "ghost", lease_deadline_ms: 999999 }),
    { type: "channel_closed", channel_epoch: "ghost", reason: "channel_expired" });
  await open(h);
  h.state.now = 5000;
  assert.deepEqual(
    await h.p.handle({ type: "channel_renew", channel_epoch: "ch-1", lease_deadline_ms: 999999 }),
    { type: "channel_closed", channel_epoch: "ch-1", reason: "channel_expired" });
});

test("租约过期：clock 推进后自动清 channel，command 回 channel-expired 且 pending 有 channel_closed", async () => {
  const h = harness({ leaseTtlMs: 1000 });
  await hello(h);
  await open(h);
  assert.equal(h.p.stats().channels, 1);
  h.state.now = 2001; /* deadline = 1000 + 1000 = 2000 */
  const r = await h.p.handle(cmd("ch-1", "c1", "tab.list"));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "channel-expired");
  assert.equal(h.p.stats().channels, 0);
  assert.deepEqual(h.p.drain(),
    [{ type: "channel_closed", channel_epoch: "ch-1", reason: "channel_expired" }]);
});

test("drain() 惰性触发过期清理，并返回且清空 pending", async () => {
  const h = harness({ leaseTtlMs: 1000 });
  await hello(h);
  await open(h);
  h.state.now = 3000;
  assert.deepEqual(h.p.drain(),
    [{ type: "channel_closed", channel_epoch: "ch-1", reason: "channel_expired" }]);
  assert.equal(h.p.stats().channels, 0);
  assert.deepEqual(h.p.drain(), []);
});

test("command 的 channel_epoch 未 open 回 epoch-mismatch，字段形状固定", async () => {
  const h = harness();
  await hello(h);
  const r = await h.p.handle(cmd("ch-X", "c1", "tab.list"));
  assert.deepEqual(Object.keys(r).sort(), ["command_id", "error", "ok", "type"].sort());
  assert.equal(r.type, "provider_result");
  assert.equal(r.command_id, "c1");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "epoch-mismatch");
  assert.equal(r.error.retryable, false);
  assert.equal(r.error.outcome, "not_started");
  assert.deepEqual(Object.keys(r.error).sort(), ["code", "message", "outcome", "retryable"].sort());
});

test("只读方法全部放行：结果来自 onCommand，ctx 携带 epoch/command_id", async () => {
  const calls = [];
  const h = harness({
    onCommand: async (method, params, ctx) => {
      calls.push({ method, params, ctx });
      return "R:" + method;
    },
  });
  await hello(h);
  await open(h);
  for (const [i, m] of BROWSER_METHODS.read.entries()) {
    const r = await h.p.handle(cmd("ch-1", "r" + i, m, { q: i }));
    assert.deepEqual(r, { type: "provider_result", command_id: "r" + i, ok: true, result: "R:" + m });
  }
  assert.equal(calls.length, BROWSER_METHODS.read.length);
  assert.equal(calls[0].method, BROWSER_METHODS.read[0]);
  assert.deepEqual(calls[0].params, { q: 0 });
  assert.equal(calls[0].ctx.channel_epoch, "ch-1");
  assert.equal(calls[0].ctx.command_id, "r0");
  assert.equal(h.p.stats().succeeded, BROWSER_METHODS.read.length);
});

test("onCommand 缺省返回 null", async () => {
  const h = harness();
  await hello(h);
  await open(h);
  assert.deepEqual(await h.p.handle(cmd("ch-1", "c1", "browser.info")),
    { type: "provider_result", command_id: "c1", ok: true, result: null });
});

test("写方法未 confirm===true 一律拦：confirmation-required / retryable:false / outcome:not_started", async () => {
  let called = 0;
  const h = harness({ onCommand: async () => { called += 1; return "x"; } });
  await hello(h);
  await open(h);
  for (const [i, m] of BROWSER_METHODS.write.entries()) {
    const r = await h.p.handle(cmd("ch-1", "w" + i, m, { confirm: 1 }));
    assert.equal(r.ok, false, m);
    assert.equal(r.error.code, "confirmation-required", m);
    assert.equal(r.error.retryable, false, m);
    assert.equal(r.error.outcome, "not_started", m);
  }
  assert.equal((await h.p.handle(cmd("ch-1", "w-empty", "dom.click", {}))).error.code,
    "confirmation-required");
  assert.equal(called, 0, "被拦时 onCommand 绝不执行");
});

test("写方法带 confirm:true 全部放行并拿到 onCommand 结果", async () => {
  const h = harness({ onCommand: async (m) => "W:" + m });
  await hello(h);
  await open(h);
  for (const [i, m] of BROWSER_METHODS.write.entries()) {
    const r = await h.p.handle(cmd("ch-1", "ok" + i, m, { confirm: true }));
    assert.equal(r.ok, true, m);
    assert.equal(r.result, "W:" + m);
  }
});

test("禁用方法（cua.*/cookie.*/eval/upload/submit/script.execute/未知）一律 method-denied 且绝不执行", async () => {
  let called = 0;
  const h = harness({ onCommand: async () => { called += 1; return "x"; } });
  await hello(h);
  await open(h);
  const denied = [
    "cua.click", "cua.move", "cookie.get", "cookie.setAll",
    "eval", "eval.anything", "upload", "upload.file", "submit", "submit.form",
    "script.execute", "script.execute.foo",
    "dom.executeScript", "tab.close", "fetch", "window.__proto__",
  ];
  for (const [i, m] of denied.entries()) {
    const r = await h.p.handle(cmd("ch-1", "d" + i, m, { confirm: true }));
    assert.equal(r.ok, false, m);
    assert.equal(r.error.code, "method-denied", m);
  }
  assert.equal(called, 0);
  assert.equal(h.p.stats().byReason["method-denied"], denied.length);
});

test("tab 所有权：未登记回 tab-not-owned，ownTab 登记后放行", async () => {
  const h = harness({ onCommand: async () => "ok" });
  await hello(h);
  await open(h);
  assert.equal((await h.p.handle(cmd("ch-1", "c1", "dom.get_text", { tabId: 42 }))).error.code,
    "tab-not-owned");
  assert.equal(h.p.ownTab("ch-1", 42), true);
  assert.equal((await h.p.handle(cmd("ch-1", "c2", "dom.get_text", { tabId: 42 }))).ok, true);
  assert.equal((await h.p.handle(cmd("ch-1", "c3", "dom.get_text", { tabId: "42" }))).ok, true,
    "数字 / 字符串归一化");
  assert.equal((await h.p.handle(cmd("ch-1", "c4", "dom.get_text", { tabId: 43 }))).error.code,
    "tab-not-owned");
  assert.equal((await h.p.handle(cmd("ch-1", "c5", "tab.list", {}))).ok, true,
    "无 tabId 不受所有权约束");
  assert.equal(h.p.ownTab("ghost", 9), false, "无效 epoch 登记失败");
});

test("channel_open 的 session_id 自动登记为 ownedTab", async () => {
  const h = harness({ onCommand: async () => "ok" });
  await hello(h);
  assert.equal(await open(h, "ch-1", { session_id: "tab-9" }), null);
  assert.equal((await h.p.handle(cmd("ch-1", "c1", "tab.url", { tabId: "tab-9" }))).ok, true);
  assert.equal((await h.p.handle(cmd("ch-1", "c2", "tab.url", { tabId: "other" }))).error.code,
    "tab-not-owned");
});

test("inflight 超过 maxInflight 回 resource-exhausted / retryable:true / outcome:not_started", async () => {
  const resolvers = [];
  const h = harness({
    maxInflight: 2,
    onCommand: () => new Promise((resolve) => { resolvers.push(resolve); }),
  });
  await hello(h);
  await open(h);
  const p1 = h.p.handle(cmd("ch-1", "c1", "tab.list"));
  const p2 = h.p.handle(cmd("ch-1", "c2", "tab.list"));
  assert.equal(h.p.stats().inflight, 2);
  const r3 = await h.p.handle(cmd("ch-1", "c3", "tab.list"));
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, "resource-exhausted");
  assert.equal(r3.error.retryable, true);
  assert.equal(r3.error.outcome, "not_started");
  assert.equal(h.p.stats().inflight, 2);
  for (const resolve of resolvers) resolve("done");
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(h.p.stats().inflight, 0);
});

test("同一 command_id 重复回 duplicate-command", async () => {
  const h = harness({ onCommand: async () => "v" });
  await hello(h);
  await open(h);
  assert.equal((await h.p.handle(cmd("ch-1", "same", "tab.list"))).ok, true);
  const r2 = await h.p.handle(cmd("ch-1", "same", "tab.list"));
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, "duplicate-command");
  assert.equal(h.p.stats().failed, 1);
});

test("被 guard 拒绝的 command_id 不占重放集合：带 confirm 用同 id 重试可成功", async () => {
  const h = harness({ onCommand: async () => "clicked" });
  await hello(h);
  await open(h);
  assert.equal((await h.p.handle(cmd("ch-1", "c1", "dom.click", {}))).error.code,
    "confirmation-required");
  const r2 = await h.p.handle(cmd("ch-1", "c1", "dom.click", { confirm: true }));
  assert.equal(r2.ok, true);
  assert.equal(r2.result, "clicked");
});

test("cancel 标记命令后该 command_id 的结果回 cancelled", async () => {
  const h = harness({ onCommand: async () => "v" });
  await hello(h);
  await open(h);
  assert.equal(await h.p.handle({ type: "cancel", channel_epoch: "ch-1", command_id: "c1" }), null);
  const r = await h.p.handle(cmd("ch-1", "c1", "tab.list"));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "cancelled");
  assert.equal(h.p.stats().byReason.cancelled, 1);
});

test("执行期间 cancel：结果不采纳，回 cancelled 且释放 inflight", async () => {
  let resolveFn;
  const h = harness({ onCommand: () => new Promise((resolve) => { resolveFn = resolve; }) });
  await hello(h);
  await open(h);
  const pending = h.p.handle(cmd("ch-1", "c1", "tab.list"));
  assert.equal(h.p.stats().inflight, 1);
  assert.equal(await h.p.handle({ type: "cancel", channel_epoch: "ch-1", command_id: "c1" }), null);
  assert.equal(h.p.stats().inflight, 0, "cancel 释放 inflight 槽位");
  resolveFn("should-not-be-used");
  const r = await pending;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "cancelled");
  assert.equal(h.p.stats().failed, 1);
});

test("closeAll：清 channel/inflight，pending 每 channel 一条 channel_close，stopped 期间 command 回 stopped", async () => {
  const h = harness();
  await hello(h);
  await open(h, "ch-1");
  await open(h, "ch-2");
  assert.equal(h.p.stats().channels, 2);
  assert.equal(h.p.closeAll("e-stop"), 2);
  assert.equal(h.p.isStopped(), true);
  assert.equal(h.p.stats().stopped, true);
  assert.equal(h.p.stats().channels, 0);
  assert.equal(h.p.stats().inflight, 0);
  const pending = h.p.drain();
  assert.equal(pending.length, 2);
  assert.deepEqual(new Set(pending.map((x) => x.channel_epoch)), new Set(["ch-1", "ch-2"]));
  for (const msg of pending) {
    assert.deepEqual(Object.keys(msg).sort(), ["channel_epoch", "reason", "type"].sort());
    assert.equal(msg.type, "channel_close");
    assert.equal(msg.reason, "e-stop");
  }
  assert.deepEqual(h.p.drain(), []);
  assert.equal((await h.p.handle(cmd("ch-1", "c1", "tab.list"))).error.code, "stopped");
});

test("reopen() 解除急停后恢复：重新 open channel 并执行命令", async () => {
  const h = harness();
  await hello(h);
  await open(h, "ch-1");
  h.p.closeAll("stop");
  assert.equal((await h.p.handle(cmd("ch-1", "c1", "tab.list"))).error.code, "stopped");
  assert.equal(h.p.reopen(), true);
  assert.equal(h.p.isStopped(), false);
  assert.equal(h.p.stats().stopped, false);
  /* 旧 epoch 已用过，必须换新的 */
  assert.deepEqual(await open(h, "ch-1"),
    { type: "channel_closed", channel_epoch: "ch-1", reason: "channel_epoch_reused" });
  assert.equal(await open(h, "ch-2"), null);
  assert.equal((await h.p.handle(cmd("ch-2", "c2", "tab.list"))).ok, true);
});

test("stopped 期间 channel_open 被拒，不新建 channel", async () => {
  const h = harness();
  await hello(h);
  await open(h, "ch-1");
  h.p.closeAll("stop");
  assert.deepEqual(await open(h, "ch-2"),
    { type: "channel_closed", channel_epoch: "ch-2", reason: "stopped" });
  assert.equal(h.p.stats().channels, 0);
});

test("channel_open 超过 maxChannels 回 channel_closed(resource-exhausted)", async () => {
  const h = harness({ maxChannels: 1 });
  await hello(h);
  assert.equal(await open(h, "ch-1"), null);
  assert.deepEqual(await open(h, "ch-2"),
    { type: "channel_closed", channel_epoch: "ch-2", reason: "resource-exhausted" });
  assert.equal(h.p.stats().channels, 1);
});

test("onCommand 抛异常回 command-failed / outcome:failed，且异常信息不外泄", async () => {
  const h = harness({ onCommand: async () => { throw new Error("boom SECRET-DETAIL"); } });
  await hello(h);
  await open(h);
  const r = await h.p.handle(cmd("ch-1", "c1", "tab.list"));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "command-failed");
  assert.equal(r.error.outcome, "failed");
  assert.equal(r.error.retryable, false);
  assert.ok(!JSON.stringify(r).includes("SECRET-DETAIL"));
  assert.equal(h.p.stats().failed, 1);
  assert.equal(h.p.stats().inflight, 0);
});

test("stats 字段固定、commands === succeeded+failed、byReason 为失败分布快照", async () => {
  const h = harness({ onCommand: async () => "v" });
  await hello(h);
  await open(h);
  await h.p.handle(cmd("ch-1", "c1", "tab.list"));
  await h.p.handle(cmd("ch-1", "c2", "eval"));
  const s = h.p.stats();
  assert.deepEqual(Object.keys(s).sort(),
    ["byReason", "channels", "commands", "failed", "hellos", "inflight", "ownedTabs", "stopped", "succeeded",
      // S3（#33）扩展新鲜度：随包 build / 扩展上报 build / 是否过期，桥侧比对后下发面板。
      "bundledBuild", "extensionBuild", "buildStale"].sort());
  // ownedTabs 只回规模数字，绝不回 tabId（前端不需要可枚举的标签清单）
  assert.equal(typeof s.ownedTabs, "number");
  assert.ok(Number.isInteger(s.ownedTabs) && s.ownedTabs >= 0);
  assert.equal(Object.keys(s).some((k) => /tabId|tabIds/i.test(k)), false);
  assert.equal(s.hellos, 1);
  assert.equal(s.commands, 2);
  assert.equal(s.succeeded, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.commands, s.succeeded + s.failed);
  assert.equal(s.byReason["method-denied"], 1);
  assert.equal(s.channels, 1);
  assert.equal(s.inflight, 0);
  assert.equal(s.stopped, false);
  const snap = h.p.stats();
  await h.p.handle(cmd("ch-1", "c3", "tab.title"));
  assert.equal(snap.commands, 2, "stats 是调用时快照");
  assert.equal(h.p.stats().commands, 3);
});

test("config 脱敏：不含 onCommand / 不含注入的凭据字段 / 字段固定", async () => {
  const SECRET = "SUPER-SECRET-TOKEN-xyz";
  const h = harness({ apiKey: SECRET, onCommand: async () => "v" });
  const c = h.p.config();
  assert.deepEqual(Object.keys(c).sort(),
    ["leaseTtlMs", "maxChannels", "maxInflight", "protocol", "providerEpoch", "providerInstanceId",
      // S3（#33）扩展新鲜度三字段，config 也需下发（面板据 buildStale 提示重新加载扩展）。
      "bundledBuild", "extensionBuild", "buildStale"].sort());
  assert.equal(c.protocol, 1);
  assert.equal(c.leaseTtlMs, 30_000);
  assert.equal(c.maxInflight, 8);
  assert.equal(c.maxChannels, 4);
  assert.ok(!("onCommand" in c));
  assert.ok(!("apiKey" in c));
  const blob = JSON.stringify(c) + JSON.stringify(h.p.stats()) + JSON.stringify(await hello(h));
  assert.ok(!blob.includes(SECRET), "任何凭据都不外泄");
  assert.ok(!blob.includes("onCommand"), "onCommand 不外泄");
});

/* ---------------- S3（#33）扩展新鲜度：桥侧比对 build ---------------- */
test("S3 buildStale：匹配不告警、旧版告警、老扩展不带 build 不误报", async () => {
  const BUNDLED = "2026-11-09T0130";
  // ① 上报 build 与随包一致 → 不 stale
  const h1 = harness({ bundledBuild: BUNDLED });
  await h1.p.handle({ ...HELLO, build: BUNDLED });
  assert.equal(h1.p.stats().extensionBuild, BUNDLED);
  assert.equal(h1.p.stats().buildStale, false);
  // ② 浏览器里跑的是旧副本 → stale，面板据此提示「重新加载扩展」
  const h2 = harness({ bundledBuild: BUNDLED });
  await h2.p.handle({ ...HELLO, build: "2026-11-08T0900" });
  assert.equal(h2.p.config().buildStale, true);
  // ③ 老扩展不带 build → 不误报（单源无漂移，没数据就不下结论）
  const h3 = harness({ bundledBuild: BUNDLED });
  await h3.p.handle({ ...HELLO });
  assert.equal(h3.p.stats().extensionBuild, null);
  assert.equal(h3.p.stats().buildStale, false);
});

/* ---------------- 桥侧主动下发 command() 入队（2026-11-08） ---------------- */

test("command() 读方法入队：返回 ok+command_id，drain 出一条 command 消息，形状与扩展自发一致", async () => {
  const h = harness();
  await hello(h);
  await open(h);
  const r = h.p.command("tab.list", {});
  assert.equal(r.ok, true);
  assert.equal(typeof r.command_id, "string");
  assert.equal(r.channel_epoch, "ch-1");
  const drained = h.p.drain();
  assert.equal(drained.length, 1);
  assert.deepEqual(drained[0], {
    type: "command", channel_epoch: "ch-1", command_id: r.command_id, method: "tab.list", params: {},
  });
});

test("command() 写方法带 confirm:true 入队成功", async () => {
  const h = harness();
  await hello(h);
  await open(h);
  const r = h.p.command("tab.open", { url: "https://example.com", confirm: true });
  assert.equal(r.ok, true);
  const drained = h.p.drain();
  assert.equal(drained.length, 1);
  assert.equal(drained[0].method, "tab.open");
  assert.equal(drained[0].params.url, "https://example.com");
  assert.equal(drained[0].params.confirm, true);
});

test("command() 写方法未 confirm 入队失败：confirmation-required，不污染 pending", async () => {
  const h = harness();
  await hello(h);
  await open(h);
  const r = h.p.command("tab.open", { url: "https://example.com" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "confirmation-required");
  assert.deepEqual(h.p.drain(), []);
});

test("command() 禁用方法入队失败：method-denied", async () => {
  const h = harness();
  await hello(h);
  await open(h);
  const r = h.p.command("eval", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "method-denied");
  assert.deepEqual(h.p.drain(), []);
});

test("command() 无活跃通道入队失败：no-channel", async () => {
  const h = harness();
  await hello(h);
  /* 不 open 任何 channel */
  const r = h.p.command("tab.list", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "no-channel");
  assert.deepEqual(h.p.drain(), []);
});

test("command() 接受调用方提供的 commandId，并原样出现在入队消息里", async () => {
  const h = harness();
  await hello(h);
  await open(h);
  const r = h.p.command("browser.info", {}, { commandId: "br-fixed-1" });
  assert.equal(r.ok, true);
  assert.equal(r.command_id, "br-fixed-1");
  assert.deepEqual(h.p.drain(), [{
    type: "command", channel_epoch: "ch-1", command_id: "br-fixed-1", method: "browser.info", params: {},
  }]);
});

test("command() 与自发命令共享同一活跃通道：扩展收到后同样走授权 / 执行流程", async () => {
  const calls = [];
  const h = harness({ onCommand: async (m, p, ctx) => { calls.push(ctx.command_id); return "ok"; } });
  await hello(h);
  await open(h);
  /* 桥下发一条 tab.list */
  const r = h.p.command("tab.list", {});
  assert.equal(r.ok, true);
  /* 模拟宿主把该 command 转交扩展，扩展重新派发（换新 command_id）到桥 */
  const relayed = await h.p.handle({
    type: "command", channel_epoch: "ch-1", command_id: "ext-xyz", method: "tab.list", params: {},
  });
  assert.equal(relayed.ok, true, "桥对重派发的命令照常授权");
  assert.ok(calls.includes("ext-xyz"));
});

/* ------------------------------------------------------------------ *
 * 多宿主归属投递（2026-11-09 真机事故驱动）
 *
 * 现象：Chrome 与夸克都装了扩展时，面板下发的 tab.open 稳定超时，
 * 桥侧计数 commands 一直为 0（扩展根本没把命令回投）。
 * 根因：pending 是全局单队列，两个宿主各自 1s 轮询，谁先轮到谁取走整条；
 * 取走的一方若没有该 channel_epoch 的连接，扩展 dispatchCommand 走到 canSend()
 * 静默丢弃，桥只能等到超时。
 * 修法：channel_open 转发时带 instance，provider 记住归属，drain 按归属投递。
 * 这几条锁住「不抢别人的消息」，同时锁住「老宿主不带 instance 仍能收全量」。
 * ------------------------------------------------------------------ */

test("drain(instance) 只交付归属本宿主的命令，别人的一条都不给", async () => {
  const h = harness();
  await h.p.handle({ ...HELLO }, { instance: "host-A" });
  await h.p.handle({ type: "channel_open", channel_epoch: "ch-A" }, { instance: "host-A" });
  await h.p.handle({ type: "channel_open", channel_epoch: "ch-B" }, { instance: "host-B" });

  h.p.command("tab.open", { url: "https://a.example/", confirm: true });
  const got = h.p.drain("host-A");
  assert.equal(got.length, 1, "归属 host-A 的命令只能由 host-A 取走");
  assert.equal(got[0].channel_epoch, "ch-A");
  assert.deepEqual(h.p.drain("host-B"), [], "host-B 不应拿到别人的命令");
});

test("drain(instance) 不丢别的宿主的消息：错峰轮询后仍能被自己的宿主取到", async () => {
  const h = harness();
  await h.p.handle({ ...HELLO }, { instance: "host-A" });
  await h.p.handle({ type: "channel_open", channel_epoch: "ch-A" }, { instance: "host-A" });
  await h.p.handle({ type: "channel_open", channel_epoch: "ch-B" }, { instance: "host-B" });

  h.p.command("tab.list", {});         // 目标通道是 ch-A（第一条活跃通道）
  assert.deepEqual(h.p.drain("host-B"), [], "host-B 抢不到");
  const a = h.p.drain("host-A");
  assert.equal(a.length, 1, "host-B 抢过一次之后，host-A 仍然收得到");
  assert.equal(a[0].method, "tab.list");
});

test("老宿主不带 instance：drain() 维持全量取走，不被新逻辑饿死", async () => {
  const h = harness();
  await h.p.handle({ ...HELLO }, { instance: "host-A" });
  await h.p.handle({ type: "channel_open", channel_epoch: "ch-A" }, { instance: "host-A" });
  h.p.command("tab.list", {});
  const all = h.p.drain();
  assert.equal(all.length, 1);
  assert.deepEqual(h.p.drain("host-A"), []);
});

test("归属未知的残留消息：一个租约周期内保留，过后丢弃，队列不无界增长", async () => {
  const h = harness();
  await h.p.handle({ ...HELLO }, { instance: "host-A" });
  await h.p.handle({ type: "channel_open", channel_epoch: "ch-A" }, { instance: "host-A" });
  h.p.command("tab.list", {});
  /* channel 过期 → 归属被清（cleanupChannel），消息变成归属未知 */
  h.state.now += 30_001;
  h.p.drain("host-B");
  /* 宽限期内还在（再取一次 host-B 仍拿不到，但也没被丢） */
  assert.deepEqual(h.p.drain("host-B"), []);
  h.state.now += 60_000;
  h.p.drain("host-B");
  assert.deepEqual(h.p.drain("host-B"), [], "超过宽限期后不再占位");
  assert.ok(true);
});
