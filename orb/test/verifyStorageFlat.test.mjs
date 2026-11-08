/* 验收工具单测：#131 存储根 / 扁平化产物浮层验证器本身也要可回归。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyStorage } from "../tools/verify-storage-flat.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-verify131-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function buildRoot(dir) {
  const root = path.join(dir, "ORB存储");
  for (const k of ["recordings", "screenshots", "vidx", "exports", "archive", "misc"]) {
    fs.mkdirSync(path.join(root, k, "2026-11-07"), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "exports/2026-11-07/交付.md"), "# 交付\n", "utf8");
  const state = path.join(dir, "orb-state.json");
  fs.writeFileSync(state, JSON.stringify({ storageRoot: root }), "utf8");
  return { root, state };
}

test("合成的扁平存储根全部检查通过", () => withTmp((dir) => {
  const { state } = buildRoot(dir);
  const r = verifyStorage({ statePath: state });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.equal(r.flatFiles, 1);
  assert.equal(r.samples[0].rel, "exports/2026-11-07/交付.md");
  assert.ok(r.checks.some((c) => c.name.includes("productRel") && c.ok));
  assert.ok(r.checks.some((c) => c.name.includes("viewRow") && c.ok));
  assert.equal(r.legacy.present, false);
}));

test("扁平目录里出现旧 sessions 层级时验证必须失败", () => withTmp((dir) => {
  const { root, state } = buildRoot(dir);
  fs.mkdirSync(path.join(root, "exports/2026-11-07/sessions"), { recursive: true });
  const r = verifyStorage({ statePath: state });
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((c) => c.name.includes("旧 sessions") && !c.ok));
}));

test("登记表残留旧形 rel 会被抓出来", () => withTmp((dir) => {
  const { root, state } = buildRoot(dir);
  const g = path.join(root, "governance/2026-11-07");
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, "artifacts.20261107.jsonl"),
    JSON.stringify({ id: "a", rel: "2026-11-07/sessions/c1/exports/old.md" }) + "\n", "utf8");
  const r = verifyStorage({ statePath: state });
  assert.equal(r.governance.oldRel, 1);
  assert.equal(r.ok, false);
}));

test("缺状态文件时不抛异常，如实回失败", () => withTmp((dir) => {
  const r = verifyStorage({ statePath: path.join(dir, "nope.json") });
  assert.equal(r.ok, false);
  assert.ok(r.checks[0].name.includes("读取"));
}));

test("验收工具源码不写用户文件、不重启控制台", () => {
  const src = fs.readFileSync(path.join(ROOT, "tools/verify-storage-flat.mjs"), "utf8");
  assert.ok(!/spawn\(|execFile\(|child_process/.test(src));
  assert.ok(!/writeFileSync/.test(src), "验证器只能读，不能写存储根");
  assert.match(src, /不重启/);
});
