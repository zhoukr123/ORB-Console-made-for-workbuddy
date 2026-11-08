/* events 单测：no-session / 限流(间隔+每秒) / UIA 退化 / 脱敏转义 / oversize /
 * flush 幂等 + events.jsonl 跨实例按行解析 + stats。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEventRecorder, REASON_CODES } from "../events.mjs";

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orb-events-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("reasonCode 枚举 + 未 start 时 record 返回 no-session", () => {
  assert.deepEqual(REASON_CODES, ["ok", "throttled", "no-session", "degraded-ui", "oversize"]);
  const ev = createEventRecorder({ now: () => 1000 });
  assert.deepEqual(ev.record({ type: "click" }), { ok: false, reasonCode: "no-session" });
});

test("限流：同一时刻间隔 < sampleMs 返回 throttled", () => {
  let T = 1000;
  const ev = createEventRecorder({ now: () => T, sampleMs: 100, maxPerSec: 20 });
  ev.start("s1");
  const r1 = ev.record({ type: "click", uiTree: {} });
  assert.equal(r1.ok, true);
  assert.equal(r1.reasonCode, "ok");
  const r2 = ev.record({ type: "click", uiTree: {} });
  assert.equal(r2.ok, false);
  assert.equal(r2.reasonCode, "throttled");
  assert.equal(ev.stats().throttled, 1);
});

test("限流：同一秒窗口超过 maxPerSec 返回 throttled", () => {
  let T = 1000;
  const ev = createEventRecorder({ now: () => T, sampleMs: 10, maxPerSec: 3 });
  ev.start("s1");
  const codes = [];
  for (let i = 0; i < 4; i++) {
    T = 1000 + i * 10;
    codes.push(ev.record({ type: "c", uiTree: {} }).reasonCode);
  }
  assert.deepEqual(codes, ["ok", "ok", "ok", "throttled"]);
  assert.ok(ev.stats().throttled >= 1);
});

test("UIA 退化：uiTree 为 null → click{x,y}+windowTitle、reasonCode=degraded-ui、标 degraded", () => {
  let T = 1000;
  const file = path.join(tmp(), "events.jsonl");
  const ev = createEventRecorder({ now: () => T, sampleMs: 0, maxPerSec: 20, file });
  ev.start("sess");
  const r = ev.record({ type: "click", uiTree: null, windowTitle: "Win", x: 5, y: 9, text: "hi" });
  assert.equal(r.ok, true);
  assert.equal(r.reasonCode, "degraded-ui");
  ev.flush();
  const rows = ev.read({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].degraded, true);
  assert.deepEqual(rows[0].click, { x: 5, y: 9 });
  assert.equal(rows[0].windowTitle, "Win");
  assert.equal(ev.stats().degraded, 1);
});

test("不可信文本脱敏转义后写入，凭据不进日志", () => {
  let T = 1000;
  const ev = createEventRecorder({ now: () => T, sampleMs: 0, maxPerSec: 20 });
  ev.start("s");
  ev.record({
    type: "c", uiTree: {},
    windowTitle: "token=SECRET123 <script>alert(1)</script>",
    text: "见 https://evil.com/x 与 Bearer abc123",
    focus: "ok",
  });
  const raw = JSON.stringify(ev.read({ limit: 10 }));
  assert.ok(!raw.includes("SECRET123"));
  assert.ok(!raw.includes("<script>"));
  assert.ok(!raw.includes("https://evil.com"));
  assert.ok(!raw.includes("Bearer abc123"));
  assert.ok(raw.includes("&lt;script&gt;"));
  assert.ok(raw.includes("[credential]"));
  assert.ok(raw.includes("[link]"));
});

test("超大事件返回 oversize，不落地", () => {
  let T = 1000;
  const ev = createEventRecorder({ now: () => T, sampleMs: 0, maxPerSec: 20 });
  ev.start("s");
  const r = ev.record({ type: "c", uiTree: {}, text: "X".repeat(10000) });
  assert.equal(r.ok, false);
  assert.equal(r.reasonCode, "oversize");
  assert.equal(ev.stats().recorded, 0);
});

test("flush 幂等 + read since/limit + events.jsonl 跨实例按行解析 + stats", () => {
  let T = 1000;
  const file = path.join(tmp(), "e.jsonl");
  const ev = createEventRecorder({ now: () => T, sampleMs: 0, maxPerSec: 20, file });
  ev.start("s1");
  ev.record({ type: "a", uiTree: {} });
  T = 1001; ev.record({ type: "b", uiTree: {} });
  T = 1002; ev.record({ type: "c", uiTree: {} });
  const f1 = ev.flush();
  assert.equal(f1.appended, 3);
  assert.equal(ev.flush().appended, 0, "幂等");
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 3);
  assert.equal(ev.read({ limit: 100 }).length, 3);
  assert.equal(ev.read({ since: 1001, limit: 100 }).length, 2);
  assert.equal(ev.read({ limit: 0 }).length, 0);
  // 新实例启动即从 events.jsonl 载入
  const ev2 = createEventRecorder({ now: () => 2000, sampleMs: 0, maxPerSec: 20, file });
  assert.equal(ev2.read({ limit: 100 }).length, 3, "按行解析既有 events.jsonl");
  assert.equal(ev.stats().recorded, 3);
  assert.equal(ev.stats().sessions, 1);
  assert.deepEqual(Object.keys(ev.stats()).sort(),
    ["recorded", "throttled", "degraded", "sessions"].sort());
});
