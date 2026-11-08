/* apiChannel.mjs 单测：开关语义、归一、落盘失败不撒谎。
 * 用注入的 load/save，不碰真实磁盘。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createApiChannel, normalizeState, defaultState, USER_DISABLED } from "../apiChannel.mjs";

function memStore(initial = null) {
  let raw = initial;
  const writes = [];
  return {
    load: () => raw,
    save: (s) => { raw = JSON.parse(JSON.stringify(s)); writes.push(raw); return { ok: true }; },
    writes,
  };
}

test("默认是关的：没记录、没落盘通道也不能开", () => {
  const ch = createApiChannel({ load: () => null });
  assert.equal(ch.isEnabled(), false);
  assert.equal(ch.status().denyCode, USER_DISABLED);
  assert.equal(ch.guard().allowed, false);
  assert.equal(ch.guard().code, USER_DISABLED);
});

test("归一：垃圾输入一律退默认关，字符串 \"true\" 不算开", () => {
  for (const bad of [null, undefined, 42, "on", [], {}, { enabled: "true" }, { enabled: 1 }]) {
    const s = normalizeState(bad);
    assert.equal(s.enabled, false, `输入 ${JSON.stringify(bad)} 应归一为关`);
  }
  const good = normalizeState({ enabled: true, updatedAt: 1700000000000, updatedBy: "popup", rev: 3 });
  assert.deepEqual(good, { enabled: true, updatedAt: 1700000000000, updatedBy: "popup", rev: 3 });
});

test("归一：非法 updatedBy 不写进状态，rev 取非负整数", () => {
  const s = normalizeState({ enabled: true, updatedBy: "<script>", rev: -5 });
  assert.equal(s.updatedBy, "unknown");
  assert.equal(s.rev, 0);
});

test("开启会落盘并递增 rev，来源记为 popup", () => {
  const store = memStore();
  const ch = createApiChannel({ load: store.load, save: store.save, clock: () => 1700000000000 });
  const r = ch.setEnabled(true, { by: "popup" });
  assert.equal(r.ok, true);
  assert.equal(r.persisted, true);
  assert.equal(r.enabled, true);
  assert.equal(r.rev, 1);
  assert.equal(r.updatedBy, "popup");
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].enabled, true);
  assert.equal(ch.isEnabled(), true);
});

test("重复拨到同一值不重复写盘（幂等）", () => {
  const store = memStore();
  const ch = createApiChannel({ load: store.load, save: store.save });
  ch.setEnabled(true, { by: "popup" });
  const again = ch.setEnabled(true, { by: "popup" });
  assert.equal(again.unchanged, true);
  assert.equal(store.writes.length, 1);
  assert.equal(again.rev, 1);
});

test("落盘抛异常：内存生效但如实报 persisted:false + warning", () => {
  const ch = createApiChannel({
    load: () => null,
    save: () => { throw new Error("EACCES: permission denied"); },
  });
  const r = ch.setEnabled(true, { by: "popup" });
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false);
  assert.match(r.warning, /EACCES|写入失败/);
  assert.equal(ch.isEnabled(), true, "本次运行仍生效");
});

test("落盘返回 ok:false 也当失败处理，不谎报成功", () => {
  const ch = createApiChannel({ load: () => null, save: () => ({ ok: false, warning: "磁盘只读" }) });
  const r = ch.setEnabled(true, { by: "panel" });
  assert.equal(r.persisted, false);
  assert.match(r.warning, /只读/);
});

test("没有落盘通道时明确说重启会退回关闭", () => {
  const ch = createApiChannel({ load: () => null });
  const r = ch.setEnabled(true);
  assert.equal(r.persisted, false);
  assert.match(r.warning, /重启后/);
});

test("从磁盘读到 enabled:true 时按开处理", () => {
  const ch = createApiChannel({ load: () => ({ enabled: true, rev: 2, updatedBy: "panel" }) });
  assert.equal(ch.isEnabled(), true);
  assert.equal(ch.guard().allowed, true);
  assert.equal(ch.status().denyCode, "");
});

test("load 抛异常不崩，退回默认关", () => {
  const ch = createApiChannel({ load: () => { throw new Error("bad json"); } });
  assert.equal(ch.isEnabled(), false);
  assert.deepEqual(ch.snapshot(), defaultState());
});

test("关回去也落盘，rev 继续递增", () => {
  const store = memStore({ enabled: true, rev: 4, updatedBy: "popup" });
  const ch = createApiChannel({ load: store.load, save: store.save });
  assert.equal(ch.isEnabled(), true);
  const r = ch.setEnabled(false, { by: "popup" });
  assert.equal(r.enabled, false);
  assert.equal(r.rev, 5);
  assert.equal(store.writes.length, 1);
});

test("status 是快照：外部改动不影响内部状态", () => {
  const ch = createApiChannel({ load: () => null });
  const s = ch.status();
  s.enabled = true;
  assert.equal(ch.isEnabled(), false);
});
