/* I-17 产物浮层：rel 形状、四类失效态、预览边界。
 * 这些规则必须锁死 —— 一旦放松，主进程就可能按面板给的路径打开产物树外的文件。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  productRel, inferRel, statusOf, viewRow, viewRows, truncatePreview,
  rootKeyOf, dayFromTs, isPreviewable, isMedia, STATUSES, STATUS_META,
} from "../artifactView.mjs";

const entry = (o = {}) => ({
  id: "a_0123456789abcdef0123", conversationId: "c-1", epoch: 1, ticketId: "t1",
  kind: "exports", rel: "exports/2026-11-05/out.md",
  ext: "md", size: 123, sha: "", createdAt: 1_700_000_000_000, status: "ok",
  ...o,
});

test("productRel: 固定形状 <kind>/<day>/<name>（扁平化，无会话层）", () => {
  const p = productRel("2026-11-05", "c-1", "exports", "report.md");
  assert.equal(p.ok, true);
  assert.equal(p.rel, "exports/2026-11-05/report.md");
  assert.equal(p.ext, "md");
  assert.ok(!p.rel.startsWith("/"), "绝不能是绝对路径");
});

test("productRel: 传入完整路径也只取最后一段，不构造嵌套目录", () => {
  const p = productRel("2026-11-05", "c-1", "exports", "a/b/report.md");
  assert.equal(p.rel, "exports/2026-11-05/report.md");
});

test("productRel: 非法 day / cid / kind / 隐藏文件 / 穿越 / 扩展名一律拒绝", () => {
  assert.equal(productRel("2026/11/05", "c-1", "exports", "a.md").ok, false);
  assert.equal(productRel("2026-11-05", "..", "exports", "a.md").ok, false);
  assert.equal(productRel("2026-11-05", "c-1", "artifacts", "a.md").ok, false);
  assert.equal(productRel("2026-11-05", "c-1", "exports", ".bridge.json").ok, false);
  assert.equal(productRel("2026-11-05", "c-1", "exports", "..\\secret.md").ok, false);
  assert.equal(productRel("2026-11-05", "c-1", "exports", "a.exe").ok, false);
  assert.equal(productRel("2026-11-05", "c-1", "exports", "").ok, false);
});

test("inferRel: 老登记表只有裸文件名时按创建时间补出扁平形状", () => {
  const e = entry({ rel: "out.md", createdAt: Date.UTC(2026, 10, 5, 2, 0, 0) });
  const rel = inferRel(e, { day: "2026-11-05", cid: "c-1" });
  assert.equal(rel, "exports/2026-11-05/out.md");
});

test("inferRel: 已经是完整 rel（新形/旧形）就原样返回，不二次拼接", () => {
  // 新形
  const e = entry();
  assert.equal(inferRel(e, { day: "2026-11-05" }), e.rel);
  // 旧形：<day>/sessions/<cid>/<kind>/<name> 仍原样返回，交给 resolveSafe 双形态兼容
  const old = entry({ rel: "2026-11-05/sessions/c-1/exports/out.md" });
  assert.equal(inferRel(old, { day: "2026-11-05" }), old.rel);
});

test("dayFromTs: 固定 UTC+8，不跟宿主时区跑", () => {
  assert.equal(dayFromTs(Date.UTC(2026, 10, 4, 17, 30, 0)), "2026-11-05");
  assert.equal(dayFromTs(Date.UTC(2026, 10, 5, 2, 0, 0)), "2026-11-05");
});

test("statusOf: 正常 / 文件缺失 / 会话中断", () => {
  assert.equal(statusOf(entry(), { exists: true }), "ok");
  assert.equal(statusOf(entry(), { exists: false }), "missing");
  assert.equal(statusOf(entry({ status: "interrupted" }), { exists: true }), "interrupted");
  assert.equal(statusOf(entry({ status: "expired" }), { exists: true }), "expired");
  assert.equal(statusOf(null, { exists: true }), "missing");
});

test("statusOf: 换根优先于文件缺失，否则用户看不到真正原因", () => {
  const e = entry({ rootKey: "oldroot" });
  const st = statusOf(e, { exists: false, currentRootKey: "newroot" });
  assert.equal(st, "rootChanged");
  assert.equal(STATUS_META[st].label, "存储根已换");
});

test("statusOf: 超保留期的媒体判 expired，非媒体不受影响", () => {
  const now = 1_800_000_000_000;
  const keep = 30 * 24 * 3600 * 1000;
  assert.equal(statusOf(entry({ ext: "mp4" }), { exists: true, now, mediaRetentionMs: keep }), "expired");
  assert.equal(statusOf(entry({ ext: "md" }), { exists: true, now, mediaRetentionMs: keep }), "ok");
  assert.equal(statusOf(entry({ ext: "mp4", createdAt: now - 1000 }), { exists: true, now, mediaRetentionMs: keep }), "ok");
});

test("四类失效态都在 STATUSES 里且各有中文说明", () => {
  for (const s of ["missing", "rootChanged", "interrupted", "expired"]) {
    assert.ok(STATUSES.includes(s));
    assert.ok(STATUS_META[s].label && STATUS_META[s].hint);
  }
});

test("viewRow: 失效态一律不给预览、不给定位", () => {
  const ok = viewRow(entry(), { exists: true });
  assert.equal(ok.previewable, true);
  assert.equal(ok.locatable, true);
  const gone = viewRow(entry(), { exists: false });
  assert.equal(gone.status, "missing");
  assert.equal(gone.previewable, false);
  assert.equal(gone.locatable, false);
  const bin = viewRow(entry({ ext: "pdf" }), { exists: true });
  assert.equal(bin.previewable, false);
});

test("viewRows: since 过滤 + 按时间正序", () => {
  const a = entry({ id: "a_1", createdAt: 100 });
  const b = entry({ id: "a_2", createdAt: 300 });
  const c = entry({ id: "a_3", createdAt: 200 });
  const rows = viewRows([b, a, c], { exists: true, since: 200 });
  assert.deepEqual(rows.map((r) => r.id), ["a_3", "a_2"]);
  assert.equal(viewRows([a, b, c], { exists: true }).length, 3);
});

test("truncatePreview: 超长必须截断并回报原文长度，短文本原样", () => {
  const short = truncatePreview("abc", 10);
  assert.deepEqual(short, { text: "abc", truncated: false, chars: 3 });
  const long = truncatePreview("x".repeat(100), 10);
  assert.equal(long.text.length, 10);
  assert.equal(long.truncated, true);
  assert.equal(long.chars, 100);
});

test("rootKeyOf: 稳定且不会把绝对路径写进登记表", () => {
  const k = rootKeyOf("D:/some/secret/root");
  assert.equal(k, rootKeyOf("D:/some/secret/root"));
  assert.equal(k.length, 16);
  assert.ok(!k.includes("/") && !k.includes(":"));
  assert.notEqual(k, rootKeyOf("D:/another/root"));
});

test("格式分类：文本可预览、媒体有保留期", () => {
  assert.equal(isPreviewable("md"), true);
  assert.equal(isPreviewable("HTML"), true);
  assert.equal(isPreviewable("pdf"), false);
  assert.equal(isMedia("mp4"), true);
  assert.equal(isMedia("md"), false);
});
