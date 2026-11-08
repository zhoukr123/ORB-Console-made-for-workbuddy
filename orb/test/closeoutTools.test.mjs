/**
 * 11-07 收尾四工具回归：#197 退役器 / #199 核实器 / #200 自检 / #198 扩展验收。
 * 全部用 os.tmpdir() 下自建临时目录或纯函数，绝不触碰用户个人文件。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const KINDS = ["recordings", "screenshots", "vidx", "exports", "archive", "misc"];

import {
  planRetirement, scanLegacy, matchCopies, toMarkdown as retireMd,
  MAX_BATCH, RETIRE_ERRORS,
} from "../tools/retire-legacy-artifacts.mjs";
import {
  buildVerificationQueue, submitVerification, applyVerifications,
  EVIDENCE_TEMPLATE, toMarkdown as queueMd, VERIFY_CODES,
} from "../tools/site-verify-entry.mjs";
import { runSelfCheck, VISUAL_ONLY, toMarkdown as selfCheckMd } from "../tools/post-restart-selfcheck.mjs";
import { checkExtension, loadSteps, runtimeChecklist, toMarkdown as extMd } from "../tools/ext-load-check.mjs";
import { SITE_ENTRIES, buildCapabilityTable, assertNoInventedSelectors } from "../siteCapabilityData.mjs";

const tmpRoots = [];
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orb-closeout-"));
  tmpRoots.push(root);
  return root;
}
function put(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}
function fakeRemover(trashDir) {
  const calls = [];
  return {
    calls,
    fn: (file) => {
      calls.push(file);
      fs.mkdirSync(trashDir, { recursive: true });
      fs.renameSync(file, path.join(trashDir, path.basename(file) + "-" + calls.length));
    },
  };
}

test.after(() => {
  for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

/* ---------- #197 退役器 ---------- */
function fixture(seed = "same") {
  const root = makeRoot();
  put(root, "artifacts/2026-11-07/sessions/c1/exports/a.md", "MD-" + seed);
  put(root, "artifacts/2026-11-07/sessions/c1/exports/frames/b.jpg", "JPG-" + seed);
  put(root, "exports/2026-11-07/a.md", "MD-" + seed);
  put(root, "vidx/2026-11-07/job/frames/b.jpg", "JPG-" + seed);
  return root;
}

test("#197 递归扫描能命中第三层 _frames 副本（回归：旧版只扫两层漏 12 张帧图）", () => {
  const root = fixture();
  const scan = scanLegacy(root);
  const m = matchCopies(scan, { kinds: KINDS });
  assert.equal(scan.files.length, 2);
  assert.equal(m.safe.length, 2);
  assert.equal(m.unsafe.length, 0);
  assert.ok(m.safe.every((f) => f.copy && f.copy.includes("vidx") || f.copy.includes("exports")));
});

test("#197 dry-run 零写操作：不备份、不调 remover", () => {
  const root = fixture();
  const { calls, fn } = fakeRemover(path.join(root, "trash"));
  const plan = planRetirement(root, { kinds: KINDS, confirm: false, remover: fn,
    backupDir: path.join(root, "archive", "bak"), now: 1 });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.code, "ok");
  assert.equal(plan.safe.length, 2);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(plan.backupDir), false, "dry-run 不能创建备份目录");
  assert.match(retireMd(plan), /dry-run/);
});

test("#197 副本哈希不一致 → 拒删，即使 confirm 也不动任何文件", () => {
  const root = fixture();
  put(root, "vidx/2026-11-07/job/frames/b.jpg", "TAMPERED");
  const { calls, fn } = fakeRemover(path.join(root, "trash"));
  const plan = planRetirement(root, { kinds: KINDS, confirm: true, remover: fn,
    backupDir: path.join(root, "archive", "bak"), now: 2 });
  assert.equal(plan.ok, false);
  assert.equal(plan.code, RETIRE_ERRORS.UNSAFE_FILES);
  assert.equal(plan.unsafe.length, 1);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(plan.backupDir), false);
});

test("#197 confirm 才执行：先备份、逐批 ≤10、走注入 remover、原文件消失", () => {
  const root = makeRoot();
  for (let i = 0; i < 23; i++) {
    const name = "f" + String(i).padStart(2, "0") + ".bin";
    put(root, "artifacts/2026-11-07/sessions/c1/exports/" + name, "X" + i);
    put(root, "exports/2026-11-07/" + name, "X" + i);
  }
  const { calls, fn } = fakeRemover(path.join(root, "trash"));
  const plan = planRetirement(root, { kinds: KINDS, confirm: true, remover: fn,
    backupDir: path.join(root, "archive", "bak"), now: 3 });
  assert.equal(plan.ok, true, plan.note);
  assert.equal(plan.removed, 23);
  assert.equal(plan.batches, Math.ceil(23 / MAX_BATCH));
  assert.equal(calls.length, 23);
  assert.equal(fs.readdirSync(path.join(root, "archive", "bak")).length > 0, true);
  assert.equal(scanLegacy(root).files.length, 0, "旧目录文件应已全部移走");
});

test("#197 备份失败 → 中止，remover 零调用", () => {
  const root = fixture();
  const broken = Object.create(fs);
  broken.writeFileSync = () => { throw new Error("disk full"); };
  const { calls, fn } = fakeRemover(path.join(root, "trash"));
  const plan = planRetirement(root, { kinds: KINDS, confirm: true, remover: fn,
    fsImpl: broken, backupDir: path.join(root, "archive", "bak"), now: 4 });
  assert.equal(plan.code, RETIRE_ERRORS.BACKUP_FAILED);
  assert.equal(calls.length, 0);
});

test("#197 静态红线：不递归删存储根、不用 rm -rf / del /F", () => {
  const src = read("tools/retire-legacy-artifacts.mjs");
  assert.ok(!/rm\s+-rf|\/S\s+\/Q|del\s+\/F/i.test(src));
  assert.ok(!/rmSync\s*\(\s*root|rmdirSync\s*\(\s*root/.test(src));
  assert.match(src, /SendToRecycleBin/);
  assert.match(src, /MAX_BATCH\s*=\s*10/);
  assert.match(src, /confirm\s*=\s*false/);
});

/* ---------- #199 核实器 ---------- */
const GOOD_EV = { method: "dom", observedAt: "2026-11-07 20:40 GMT+8", sample: "回读标题非空", verifiedBy: "Chrome 131" };
const P0_FIRST = "qq.com";

test("#199 队列按品类规则实得，且与旧估算 39 的差异如实保留", () => {
  const q = buildVerificationQueue();
  assert.equal(q.p0.length, 38);
  assert.equal(q.p1.length, 31);
  assert.equal(q.total, 69);
  assert.equal(q.estimated, 39);
  assert.equal(q.verifiedNow, 4);
  assert.match(q.note, /差异如实保留/);
  assert.ok(q.p0.every((e) => !SITE_ENTRIES.find((s) => s.domain === e.domain)?.verified));
  assert.ok(queueMd(q).includes("P0 优先"));
});

test("#199 无证据 → 强制降级 url，actions 里绝不出现 selector/endpoint", () => {
  const r = submitVerification({ domain: P0_FIRST, selector: "#invented", endpoint: "/api/fake" }, SITE_ENTRIES);
  assert.equal(r.code, VERIFY_CODES.INSUFFICIENT);
  assert.equal(r.downgraded, true);
  assert.equal(r.entry.verified, false);
  const spec = r.entry.actions.search;
  assert.equal(spec.channel, "url");
  assert.equal(Object.hasOwn(spec, "selector"), false);
  assert.equal(Object.hasOwn(spec, "endpoint"), false);
});

test("#199 证据缺任一字段 / method 非法 → 同样降级", () => {
  const partial = { ...GOOD_EV }; delete partial.verifiedBy;
  assert.equal(submitVerification({ domain: P0_FIRST, selector: "#x", evidence: partial }, SITE_ENTRIES).downgraded, true);
  const badMethod = { ...GOOD_EV, method: "guess" };
  assert.equal(submitVerification({ domain: P0_FIRST, selector: "#x", evidence: badMethod }, SITE_ENTRIES).downgraded, true);
});

test("#199 证据齐备才允许 verified:true 并保留真实 selector", () => {
  const r = submitVerification({ domain: P0_FIRST, selector: ".real-result", evidence: GOOD_EV }, SITE_ENTRIES);
  assert.equal(r.code, VERIFY_CODES.OK);
  assert.equal(r.entry.verified, true);
  assert.equal(r.entry.actions.search.selector, ".real-result");
  assert.equal(r.evidence.verifiedBy, "Chrome 131");
});

test("#199 未知域名 / 跳过品类都明确拒绝", () => {
  assert.equal(submitVerification({ domain: "not-in-list.example" }, SITE_ENTRIES).code, VERIFY_CODES.UNKNOWN_SITE);
  const skip = SITE_ENTRIES.find((e) => e.tier === "skip");
  assert.equal(submitVerification({ domain: skip.domain, evidence: GOOD_EV }, SITE_ENTRIES).code, VERIFY_CODES.SKIPPED);
});

test("#199 合并只收 approved，且整体过 assertNoInventedSelectors", () => {
  const bad = submitVerification({ domain: P0_FIRST, selector: "#x" }, SITE_ENTRIES);
  const good = submitVerification({ domain: P0_FIRST, selector: ".real", evidence: GOOD_EV }, SITE_ENTRIES);
  const r = applyVerifications(buildCapabilityTable(), [bad, good]);
  assert.equal(r.ok, true);
  assert.equal(r.applied, 1);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.audit.ok, true);
  assert.equal(r.table[P0_FIRST].verified, true);
});

test("#199 编造选择器会被既有守门抓出；模板字段齐备", () => {
  const forged = buildCapabilityTable();
  forged["baidu.com"].actions.search.selector = ".invented";
  assert.equal(assertNoInventedSelectors(forged).ok, false);
  assert.deepEqual(Object.keys(EVIDENCE_TEMPLATE.evidence), ["method", "observedAt", "sample", "verifiedBy"]);
});

test("#199 静态红线：核实器不写回真相源", () => {
  const src = read("tools/site-verify-entry.mjs");
  assert.ok(!/writeFileSync|appendFileSync|writeFile\(/.test(src));
  assert.match(src, /assertNoInventedSelectors/);
});

/* ---------- #200 自检 ---------- */
test("#200 真实环境自检：全绿，桥未启动记 SKIP 不计失败", async () => {
  const r = await runSelfCheck({ probeBridge: false });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 1);
  assert.ok(r.passed >= 20);
  assert.equal(r.visualOnly.length, 4);
  assert.deepEqual(VISUAL_ONLY.length, 4);
  assert.match(selfCheckMd(r), /仍需人眼确认/);
});

test("#200 探桥失败记 SKIP，成功记 PASS", async () => {
  const down = await runSelfCheck({ probeBridge: true, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.ok, true);
  const bridge = down.checks.find((c) => c.name.includes("桥 19387"));
  assert.equal(bridge.skip, true);
  const up = await runSelfCheck({ probeBridge: true, fetchImpl: async () => ({ ok: true, status: 200 }) });
  const bridge2 = up.checks.find((c) => c.name.includes("桥 19387"));
  assert.equal(bridge2.ok, true);
  assert.equal(bridge2.skip, false);
});

/* ---------- #198 扩展加载验收 ---------- */
test("#198 真实扩展包加载前验收 30 项全绿，且明确不代跑真机", () => {
  const r = checkExtension();
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.failed, 0);
  assert.ok(r.passed >= 30);
  assert.equal(loadSteps(r.dir).length, 6);
  assert.equal(runtimeChecklist().length, 6);
  assert.match(extMd(r), /本工具未执行/);
});

test("#198 缺文件 / 红线被破坏都能判 FAIL", () => {
  const empty = makeRoot();
  const r1 = checkExtension({ dir: empty });
  assert.equal(r1.ok, false);
  assert.ok(r1.failed > 0);

  const src = read("tools/ext-load-check.mjs");
  assert.ok(!/Start-Process|load-extension|LaunchOptions/.test(src));
  assert.match(src, /不加载扩展/);
});

test("#198 合成包：注入 fetch( 会被红线抓出", () => {
  const d = makeRoot();
  put(d, "manifest.json", JSON.stringify({ manifest_version: 3, background: { service_worker: "background.js", type: "module" } }));
  for (const f of ["background.js", "popup.html", "popup.js", "popup.css"]) put(d, f, "// stub");
  for (const i of ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]) put(d, "icons/" + i, "x");
  const gateOk = [
    "export function gate(){}", "export function assertVisionDecisionOnly(){}",
    "export function fiveStageVerify(){}", "export function claimDone(){}",
    "globalThis.ActionGate = gate;",
    '"bilibili.com":1, "taobao.com":1, "jd.com":1, "eastmoney.com":1,',
  ].join("\n");
  const bgOk = 'import { gate, assertVisionDecisionOnly } from "./action_gate.js"; gate({}); assertVisionDecisionOnly({}); switch(m){ case "site_api.fetch": break; case "site_api.status": break; }';
  const apiStub = [
    "export const API_ENDPOINTS = {};",
    "export function isSafeUrl(u){ return !u.includes('169.254.169.254'); }",
    "export async function fetchSiteData(o){ if(o.enabled !== true) return { ok:false }; }",
  ].join("\n");
  put(d, "action_gate.js", gateOk);
  put(d, "background.js", bgOk);
  put(d, "site_api.js", apiStub);
  assert.equal(checkExtension({ dir: d }).ok, true);
  put(d, "action_gate.js", gateOk + "\nfetch('https://example.com');\n");
  const bad = checkExtension({ dir: d });
  assert.equal(bad.ok, false);
  assert.ok(bad.checks.some((c) => c.name.includes("不含 fetch(") && !c.ok));
});
