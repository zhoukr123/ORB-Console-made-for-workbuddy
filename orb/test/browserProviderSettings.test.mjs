/* browserProvider 的 settings 通道：开关消息转发、hello_ack 回带真值。
 * 只测 provider 这一层（状态源在 apiChannel.mjs，另有单测）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserProvider } from "../browserProvider.mjs";

const HELLO = {
  type: "provider_hello",
  protocol: 1,
  extension_id: "ext-id",
  extension_version: "1.2.3",
  browser_family: "chromium",
};

function harness(opts = {}) {
  return createBrowserProvider({ clock: () => 1000, epoch: "E", ...opts });
}

test("未注入设置回调：hello_ack 不带该字段，settings 消息被忽略", async () => {
  const p = harness();
  const ack = await p.handle({ ...HELLO });
  assert.equal(ack.type, "provider_hello_ack");
  assert.equal("api_channel_enabled" in ack, false, "不能凭空给默认值");
  const r = await p.handle({ type: "settings", api_channel_enabled: true });
  assert.equal(r, null);
});

test("hello_ack 回带状态源的真值（离线的默认关 / 磁盘上的开）", async () => {
  let enabled = false;
  const p = harness({ settingsSnapshot: () => ({ api_channel_enabled: enabled }) });
  const a = await p.handle({ ...HELLO });
  assert.equal(a.api_channel_enabled, false);

  enabled = true;
  const b = await p.handle({ ...HELLO });
  assert.equal(b.api_channel_enabled, true);
});

test("状态源抛异常时回带字段直接省略，不把异常泄给扩展", async () => {
  const p = harness({ settingsSnapshot: () => { throw new Error("boom"); } });
  const a = await p.handle({ ...HELLO });
  assert.equal(a.type, "provider_hello_ack");
  assert.equal("api_channel_enabled" in a, false);
});

test("拨开关：转发给状态源并回 ack 真值", async () => {
  let enabled = false;
  const calls = [];
  const p = harness({
    settingsSnapshot: () => ({ api_channel_enabled: enabled }),
    onSettings: (patch) => { calls.push(patch); enabled = patch.api_channel_enabled === true; return { ok: true, persisted: true }; },
  });
  const r = await p.handle({ type: "settings", api_channel_enabled: true });
  assert.equal(r.type, "settings_ack");
  assert.equal(r.accepted, true);
  assert.equal(r.persisted, true);
  assert.equal(r.api_channel_enabled, true);
  assert.deepEqual(calls, [{ api_channel_enabled: true }]);

  const off = await p.handle({ type: "settings", api_channel_enabled: false });
  assert.equal(off.api_channel_enabled, false);
});

test("状态源拒绝时不谎报 accepted", async () => {
  const p = harness({
    settingsSnapshot: () => ({ api_channel_enabled: false }),
    onSettings: () => ({ ok: false, reason: "disk-readonly" }),
  });
  const r = await p.handle({ type: "settings", api_channel_enabled: true });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "disk-readonly");
  assert.equal(r.api_channel_enabled, false, "回带当前真值，不是用户想要的值");
});

test("落盘失败：accepted 仍为真但 persisted:false 且带 warning", async () => {
  const p = harness({
    settingsSnapshot: () => ({ api_channel_enabled: true }),
    onSettings: () => ({ ok: true, persisted: false, warning: "重启后会退回关闭" }),
  });
  const r = await p.handle({ type: "settings", api_channel_enabled: true });
  assert.equal(r.accepted, true);
  assert.equal(r.persisted, false);
  assert.match(r.warning, /重启后/);
});

test("非法入参不采纳也不抛异常（缺字段 / 字符串 / null）", async () => {
  const p = harness({
    settingsSnapshot: () => ({ api_channel_enabled: false }),
    onSettings: () => ({ ok: true, persisted: true }),
  });
  for (const bad of [{ type: "settings" }, { type: "settings", api_channel_enabled: "true" }, { type: "settings", api_channel_enabled: null }]) {
    assert.equal(await p.handle(bad), null);
  }
});

test("急停期间仍然允许改开关（急停管执行，不管治理配置）", async () => {
  let enabled = false;
  const p = harness({
    settingsSnapshot: () => ({ api_channel_enabled: enabled }),
    onSettings: (patch) => { enabled = patch.api_channel_enabled === true; return { ok: true, persisted: true }; },
  });
  await p.handle({ ...HELLO });
  p.closeAll("stopped");
  assert.equal(p.isStopped(), true);
  const r = await p.handle({ type: "settings", api_channel_enabled: true });
  assert.equal(r.accepted, true);
  assert.equal(r.api_channel_enabled, true);
});

test("空对象 / 数组输入不崩（顶层兜底）", async () => {
  const p = harness({ settingsSnapshot: () => ({ api_channel_enabled: false }) });
  assert.equal(await p.handle({}), null);
  assert.equal(await p.handle([]), null);
  assert.equal(await p.handle(null), null);
});
