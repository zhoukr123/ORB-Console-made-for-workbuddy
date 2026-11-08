/* artifactLayout 单测：扁平化产物树 / 日志树 / 治理树 三棵平级树，按 UTC+8 日期分目录。
 * 硬约束（改布局前先看这几条断言）：
 *   ① 录屏/截屏/看视频/导出/归档/杂项 全部直接铺在 <root>/<kind>/<day>/ 下（扁平两层，无会话层、无 artifacts 容器）；
 *   ② 日志**不在**产物树里，独立在 <root>/logs/<day>/；
 *   ③ 治理流同样独立在 <root>/governance/<day>/；
 *   ④ 三棵树都绝不写 audit/。
 *   ⑤ 旧结构 <root>/artifacts/<day>/sessions/<cid>/<kind>/... 仅作只读兼容（resolveSafe 双形态）。
 * 覆盖：跨午夜归结束日、safeId、路径层级、kind 白名单、resolveSafe 双形态防穿越、
 *       ensureDay/ensureSession 幂等、paths 快照、listDays 倒序、setRoot、
 *       listProducts 聚合、describe、ESM 转发。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import layoutDefault, { dayOf, safeId, KINDS, createLayout } from "../artifactLayout.mjs";
import { createSessionManager } from "../session.mjs";

const require = createRequire(import.meta.url);
const cjs = require("../desktop/artifactLayout.cjs");

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orb-layout-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const T = Date.UTC(2026, 0, 1, 16, 10, 0);   // 上海 2026-01-02 00:10
const FIXED_DAY = "2026-01-02";
const shanghaiDay = (utcMs) => new Date(utcMs + 8 * 3600 * 1000).toISOString().slice(0, 10);

test("dayOf 固定 UTC+8：跨午夜归结束日，与 session.dayTag 语义一致", () => {
  const startTs = Date.UTC(2026, 0, 1, 15, 50, 0);   // 上海 01-01 23:50
  const endTs = Date.UTC(2026, 0, 1, 16, 10, 0);     // 上海 01-02 00:10
  assert.equal(shanghaiDay(startTs), "2026-01-01");
  assert.equal(shanghaiDay(endTs), "2026-01-02");
  assert.equal(dayOf(startTs), "2026-01-01");
  assert.equal(dayOf(endTs), "2026-01-02");
  assert.match(dayOf(endTs), /^\d{4}-\d{2}-\d{2}$/);

  const mgr = createSessionManager({ root: tmp(), now: () => T });
  assert.equal(dayOf(startTs), mgr.dayOf(startTs), "必须与 session.mjs 的 dayOf 逐字一致");
  assert.equal(dayOf(endTs), mgr.dayOf(endTs));

  const L = createLayout({ root: tmp(), now: () => T });
  assert.equal(L.day(startTs), "2026-01-01");
  assert.equal(L.day(endTs), "2026-01-02");
  assert.equal(L.day(), FIXED_DAY, "day(ts?) 省略时取 dayOf(now())");
});

test("dayOf：ts 非法时用 now（函数/数字）或 Date.now()", () => {
  assert.equal(dayOf(undefined, () => T), FIXED_DAY);
  assert.equal(dayOf(null, () => T), FIXED_DAY);
  assert.equal(dayOf("", () => T), FIXED_DAY);
  assert.equal(dayOf(NaN, () => T), FIXED_DAY);
  assert.equal(dayOf("abc", () => T), FIXED_DAY);
  assert.equal(dayOf(Infinity, T), FIXED_DAY, "now 允许传数字");
  assert.equal(dayOf(undefined, T), FIXED_DAY);
  assert.match(dayOf(undefined), /^\d{4}-\d{2}-\d{2}$/, "无 now 时退化到 Date.now() 不抛");
});

test("safeId：白名单字符保留、非法剥离、64 截断、空返回空串", () => {
  assert.equal(safeId("c-123:abc.def"), "c-123:abc.def");
  assert.equal(safeId("a/b\\c d@e"), "abcde");
  assert.equal(safeId(""), "");
  assert.equal(safeId(null), "");
  assert.equal(safeId(undefined), "");
  assert.equal(safeId("   "), "");
  assert.equal(safeId("中文🙂"), "");
  assert.equal(safeId(12345), "12345");
  const long = "x".repeat(100);
  assert.equal(safeId(long), "x".repeat(64));
  assert.equal(safeId(long).length, 64);
});

test("路径层级正确、全为绝对路径、扁平化：类别目录即真实落点", () => {
  const root = tmp();
  const L = createLayout({ root, now: () => T });
  const d = "2026-01-02";
  const A = path.join(root, "artifacts");
  // kindDir 现在直接返回 <root>/<kind>/<day>，无 sessions/cid 层
  assert.equal(L.kindDir("recordings", "c-1", d), path.join(root, "recordings", d));
  assert.equal(L.kindDir("recordings", "c-1", d), L.kindDayDir("recordings", d), "cid 被忽略");
  assert.equal(L.dayMiscDir(d), path.join(root, "misc", d), "日级杂项 = <root>/misc/<day>");

  /* 旧结构只读路径仍返回历史形状 */
  const D = path.join(A, d);
  assert.equal(L.artifactsRoot(), A);
  assert.equal(L.dayDir(d), D);
  assert.equal(L.sessionsDir(d), path.join(D, "sessions"));
  assert.equal(L.sessionDir("c-1", d), path.join(D, "sessions", "c-1"));
  assert.equal(L.sessionDir("", d), path.join(D, "sessions", "local"), "cid 空用 local");
  assert.equal(L.sessionDir(null, d), path.join(D, "sessions", "local"));
  assert.equal(L.sessionDir("..", d), path.join(D, "sessions", "local"), "纯点 cid 不得上跳");
  const evil = L.sessionDir("../../etc/passwd", d);
  assert.ok(evil.startsWith(L.sessionsDir(d)), "cid 过滤后必须是单个段，不能穿越");

  /* 日志树 / 治理树：与产物树平级，绝不嵌在 artifacts/ 下 */
  const LOGS = path.join(root, "logs", d);
  const GOV = path.join(root, "governance", d);
  assert.equal(L.logsRoot(), path.join(root, "logs"));
  assert.equal(L.govRoot(), path.join(root, "governance"));
  assert.equal(L.logsDir(d), LOGS);
  assert.equal(L.logFile("app", d), path.join(LOGS, "app.jsonl"));
  assert.equal(L.govDir(d), GOV);
  assert.equal(L.govFile("policy", d), path.join(GOV, "policy.jsonl"));
  assert.equal(L.spoolDir(d), path.join(LOGS, "spool"));
  assert.equal(L.safetyFile(d), path.join(LOGS, "safety.stop"));
  assert.equal(L.manifestFile(d), path.join(LOGS, "manifest.jsonl"));
  assert.equal(L.chainStateFile(d), path.join(LOGS, "chain-state.json"));

  const all = [
    L.artifactsRoot(), L.dayDir(d), L.sessionsDir(d), L.sessionDir("c-1", d),
    L.kindDir("vidx", "c-1", d), L.logsDir(d), L.logFile("app", d),
    L.govDir(d), L.govFile("policy", d), L.spoolDir(d), L.safetyFile(d),
    L.manifestFile(d), L.chainStateFile(d),
  ];
  for (const p of all) assert.ok(path.isAbsolute(p), `${p} 必须是绝对路径`);

  assert.equal(L.kindDayDir("recordings", d), L.kindDayDir("recordings", FIXED_DAY), "省略 day 取当天");
  assert.equal(L.logsDir(), path.join(root, "logs", FIXED_DAY));
  assert.equal(L.dayDir("bad"), L.dayDir(FIXED_DAY), "非法 day 回退当天");
  assert.equal(L.sessionsDir("2026/01/02"), L.sessionsDir(FIXED_DAY));

  /* 核心不变量：日志/治理都不在产物树下（用户要求「除日志文件外」），也都不碰 audit/ */
  for (const p of [L.logsDir(d), L.spoolDir(d), L.safetyFile(d), L.manifestFile(d),
                   L.chainStateFile(d), L.govDir(d), L.govFile("policy", d)]) {
    assert.ok(!p.startsWith(L.artifactsRoot()), `${p} 不该在产物树里`);
    assert.ok(!p.includes(`${path.sep}audit${path.sep}`) && !p.endsWith(`${path.sep}audit`),
      `${p} 不该碰 audit/`);
  }
  /* 反过来：六类产物必须落在 <root>/<kind>/<day> 下（扁平、无会话层） */
  for (const k of KINDS) {
    const p = L.kindDir(k, "c-1", d);
    assert.equal(p, L.kindDayDir(k, d), `${k} 必须在 <root>/${k}/${d} 下`);
    assert.ok(!p.startsWith(L.artifactsRoot()), `${k} 不该回到 artifacts 容器`);
  }
});

test("KINDS 白名单：未知类型 kindDir 返回 null", () => {
  const L = createLayout({ root: tmp(), now: () => T });
  const d = "2026-01-02";
  assert.deepEqual(KINDS, ["recordings", "screenshots", "vidx", "exports", "archive", "misc"]);
  for (const k of KINDS) assert.ok(L.kindDir(k, "c-1", d));
  assert.equal(L.kindDir("unknown", "c-1", d), null);
  assert.equal(L.kindDir("../../evil", "c-1", d), null);
  assert.equal(L.kindDir(null, "c-1", d), null);
});

test("resolveSafe 双形态：拒绝穿越/绝对路径/盘符/空字节；接受新形与旧形 rel", () => {
  const L = createLayout({ root: tmp(), now: () => T });
  assert.equal(L.resolveSafe("../etc/passwd"), null);
  assert.equal(L.resolveSafe("recordings/../etc"), null);
  assert.equal(L.resolveSafe("/etc/passwd"), null);
  assert.equal(L.resolveSafe("C:/Windows/win.ini"), null);
  assert.equal(L.resolveSafe("D:\\x"), null);
  assert.equal(L.resolveSafe("recordings/C:/x"), null, "中段盘符也拒绝");
  assert.equal(L.resolveSafe("bad-day/recordings/x"), null);
  assert.equal(L.resolveSafe("recordings/2026-1-2/x"), null);
  assert.equal(L.resolveSafe("recordings/2026-01-02/\u0000x"), null);
  assert.equal(L.resolveSafe(""), null);
  assert.equal(L.resolveSafe(null), null);

  /* 新形：首段是类别 → 落在存储根下 */
  const okNew = L.resolveSafe("recordings/2026-01-02/a.mp4");
  assert.equal(okNew, path.join(L.root(), "recordings", "2026-01-02", "a.mp4"));
  assert.ok(path.isAbsolute(okNew));

  /* 旧形：首段是日期 → 落在 artifactsRoot 下 */
  const okOld = L.resolveSafe("2026-01-02/sessions/c-1/recordings/a.mp4");
  assert.equal(okOld, path.join(L.artifactsRoot(), "2026-01-02", "sessions", "c-1", "recordings", "a.mp4"));

  /* 首段既不是日期也不是类别 → 非法 */
  assert.equal(L.resolveSafe("2026-01-02"), path.join(L.artifactsRoot(), "2026-01-02"));
  assert.equal(L.resolveSafe("misc/2026-01-02"), path.join(L.root(), "misc", "2026-01-02"));
});

test("ensureDay 幂等、建六个类别目录 + logs/spool/gov（共 9 项）、不建会话层、不创建 audit/", () => {
  const root = tmp();
  const L = createLayout({ root, now: () => T });
  const d = "2026-01-02";
  const r1 = L.ensureDay(d);
  assert.equal(r1.ok, true);
  assert.equal(r1.day, d);
  assert.equal(r1.dirs.length, KINDS.length + 3, "六类 + logs + spool + gov");
  assert.deepEqual(r1.failed, []);
  for (const dir of r1.dirs) assert.ok(fs.existsSync(dir), `${dir} 应已创建`);
  assert.deepEqual(new Set(r1.dirs), new Set([
    ...KINDS.map((k) => L.kindDayDir(k, d)),
    L.logsDir(d), L.spoolDir(d), L.govDir(d),
  ]));
  assert.ok(!fs.existsSync(path.join(root, "artifacts")), "扁平化不创建 artifacts 容器");
  assert.ok(!fs.existsSync(path.join(root, "audit")), "绝不创建 audit/");
  assert.ok(!fs.existsSync(path.join(root, d)), "ensureDay 不得在存储根下建根级 <YYYY-MM-DD> 日期目录");
  assert.ok(
    !fs.readdirSync(root).some((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)),
    "存储根下只允许类别目录 / logs / governance，不允许根级日期目录"
  );

  const r2 = L.ensureDay(d);
  assert.equal(r2.ok, true, "第二次仍成功（幂等）");
  assert.deepEqual(r2.dirs, r1.dirs);
  assert.deepEqual(r2.failed, []);
});

test("mkdir/readdir 失败收敛不抛，ensureDay 返回 ok:false 与 failed 列表", () => {
  const broken = {
    mkdirSync() { throw new Error("EACCES"); },
    readdirSync() { throw new Error("EACCES"); },
    statSync() { throw new Error("EACCES"); },
  };
  const L = createLayout({ root: tmp(), now: () => T, fs: broken });
  assert.equal(L.ensure(L.kindDayDir("recordings", "2026-01-02")), false);
  const r = L.ensureDay("2026-01-02");
  assert.equal(r.ok, false);
  assert.equal(r.dirs.length, 0);
  assert.equal(r.failed.length, KINDS.length + 3);
  assert.deepEqual(L.listDays(), []);
  assert.deepEqual(L.listProducts("2026-01-02"), []);
  assert.equal(L.describe().exists, false);
});

test("listDays 倒序且只认严格 YYYY-MM-DD 目录（新旧结构取并集）", () => {
  const root = tmp();
  const L = createLayout({ root, now: () => T });
  for (const n of ["2026-01-01", "2026-01-02", "2026-01-03", "not-a-day", "2026-1-2", "backup"]) {
    fs.mkdirSync(path.join(L.artifactsRoot(), n), { recursive: true });
  }
  // 新结构：某类别下的日期目录也算
  fs.mkdirSync(L.kindDayDir("recordings", "2026-01-05"), { recursive: true });
  fs.writeFileSync(path.join(L.artifactsRoot(), "2026-01-04"), "x");  // 同名文件非目录，排除
  assert.deepEqual(L.listDays(), ["2026-01-05", "2026-01-03", "2026-01-02", "2026-01-01"]);
});

test("setRoot 后所有路径随之切换", () => {
  const r1 = tmp();
  const r2 = tmp();
  const L = createLayout({ root: r1, now: () => T });
  const before = L.kindDayDir("recordings", "2026-01-02");
  assert.ok(before.startsWith(r1));
  L.setRoot(r2);
  const after = L.kindDayDir("recordings", "2026-01-02");
  assert.ok(after.startsWith(r2));
  assert.ok(!after.startsWith(r1));
  assert.equal(L.root(), path.resolve(r2));
  assert.equal(L.artifactsRoot(), path.join(r2, "artifacts"));
  assert.equal(L.legacy().audit, path.join(r2, "audit"));
});

test("listProducts 按 kind 聚合 files/bytes，扁平两层无会话层", () => {
  const root = tmp();
  const L = createLayout({ root, now: () => T });
  const d = "2026-01-02";
  const k1 = L.kindDir("recordings", "c-1", d);   // = <root>/recordings/<d>
  fs.mkdirSync(k1, { recursive: true });
  fs.writeFileSync(path.join(k1, "a.mp4"), "12345");   // 5
  fs.writeFileSync(path.join(k1, "b.mp4"), "123");     // 3
  fs.mkdirSync(path.join(k1, "nested"), { recursive: true });
  fs.writeFileSync(path.join(k1, "nested", "c.mp4"), "1234567"); // 7

  const k2 = L.kindDir("screenshots", "c-2", d);  // = <root>/screenshots/<d>
  fs.mkdirSync(k2, { recursive: true });
  fs.writeFileSync(path.join(k2, "s.png"), "abcdefgh"); // 8

  const list = L.listProducts(d);
  const byKind = Object.fromEntries(list.map((p) => [p.kind, p]));
  assert.ok(byKind.recordings && byKind.screenshots);
  assert.equal(byKind.recordings.dir, k1);
  assert.equal(byKind.recordings.files, 3);
  assert.equal(byKind.recordings.bytes, 15);
  assert.equal(byKind.screenshots.dir, k2);
  assert.equal(byKind.screenshots.files, 1);
  assert.equal(byKind.screenshots.bytes, 8);
  assert.deepEqual(L.listProducts("1999-01-01"), []);
});

test("legacy() 只读兼容；describe() 结构完整且 exists 跟随目录创建", () => {
  const root = tmp();
  const L = createLayout({ root, now: () => T });
  const lg = L.legacy();
  assert.deepEqual(Object.keys(lg).sort(),
    ["artifacts", "audit", "recordings", "screenshots", "vidx"].sort());
  assert.equal(lg.recordings, path.join(root, "recordings"));
  assert.equal(lg.screenshots, path.join(root, "screenshots"));
  assert.equal(lg.vidx, path.join(root, "vidx"));
  assert.equal(lg.artifacts, L.artifactsRoot());
  assert.equal(lg.audit, path.join(root, "audit"));

  const desc = L.describe();
  assert.deepEqual(Object.keys(desc).sort(),
    ["root", "day", "artifactsRoot", "logsRoot", "govRoot", "dayDir", "dayMiscDir",
     "logsDir", "govDir", "productKinds", "days", "products", "legacy", "exists"].sort());
  assert.equal(desc.root, path.resolve(root));
  assert.equal(desc.day, FIXED_DAY);
  assert.equal(desc.dayDir, L.dayDir(FIXED_DAY));
  assert.equal(desc.exists, true, "存储根目录已存在（dirExists(rootAbs)）");
  L.ensureDay();
  assert.equal(L.describe().exists, true);
  assert.equal(L.describe().products.length, KINDS.length, "ensureDay 后六类产物目录都可见");
});

test("ensureSession 一次建全六类产物目录，扁平落在 <root>/<kind>/<day>", () => {
  const root = tmp();
  const L = createLayout({ root, now: () => T });
  const d = "2026-01-02";
  const r = L.ensureSession("c-9", d);
  assert.equal(r.ok, true);
  assert.equal(r.cid, "c-9");
  assert.equal(r.dirs.length, KINDS.length, "六类产物目录（cid 只决定标签，不影响落点）");
  for (const k of KINDS) {
    const p = L.kindDir(k, "c-9", d);
    assert.ok(fs.existsSync(p), `${k} 应已创建`);
    assert.equal(p, L.kindDayDir(k, d), `${k} 必须落在 <root>/${k}/${d}`);
  }
  assert.ok(!fs.existsSync(path.join(root, "artifacts")), "扁平化不创建 artifacts 容器");
  assert.ok(!fs.existsSync(path.join(root, "logs")), "建会话产物不该顺手建日志树");
  assert.ok(!fs.existsSync(path.join(root, "audit")), "绝不创建 audit/");
  const r2 = L.ensureSession("c-9", d);
  assert.equal(r2.ok, true, "幂等");
  assert.deepEqual(r2.dirs, r.dirs);
});

test("paths() 给出固定路径全表：六类产物在 <root>/<kind>/<day>、日志与治理在树外", () => {
  const root = tmp();
  const L = createLayout({ root, now: () => T });
  const d = "2026-01-02";
  const p = L.paths("c-1", d);
  for (const k of KINDS) assert.equal(p[k], L.kindDir(k, "c-1", d), `${k} 必须对齐 kindDir`);
  assert.equal(p.artifactsRoot, L.artifactsRoot());
  assert.equal(p.logsRoot, path.join(root, "logs"));
  assert.equal(p.govRoot, path.join(root, "governance"));
  assert.equal(p.logsDir, path.join(root, "logs", d));
  assert.equal(p.dayMiscDir, path.join(root, "misc", d));
  assert.equal(p.sessionDir, L.sessionDir("c-1", d));
  assert.equal(p.day, d, "day 是标签不是路径");
  for (const [k, v] of Object.entries(p)) {
    if (k === "day") continue;
    assert.ok(typeof v === "string" && path.isAbsolute(v), `${k} 必须是绝对路径`);
  }
  // 换个 root，全表整体跟随，形状不变
  const r2 = tmp();
  L.setRoot(r2);
  const q = L.paths("c-1", d);
  for (const k of Object.keys(p)) {
    assert.equal(q[k], p[k].replace(path.resolve(root), path.resolve(r2)), `${k} 应只换前缀`);
  }
});

test("ESM 转发导出齐全且与 CJS 实现同源", () => {
  assert.equal(typeof dayOf, "function");
  assert.equal(typeof safeId, "function");
  assert.equal(Array.isArray(KINDS), true);
  assert.equal(typeof createLayout, "function");
  assert.equal(layoutDefault.dayOf, dayOf);
  assert.equal(layoutDefault.safeId, safeId);
  assert.equal(layoutDefault.KINDS, KINDS);
  assert.equal(layoutDefault.createLayout, createLayout);
  assert.equal(cjs.dayOf, dayOf, "ESM 与 CJS 是同一份实现");
  assert.equal(cjs.safeId, safeId);
  assert.equal(cjs.createLayout, createLayout);
  assert.deepEqual(cjs.KINDS, KINDS);
  assert.deepEqual(Object.keys(cjs).sort(),
    ["dayOf", "safeId", "KINDS", "createLayout"].sort());
});
