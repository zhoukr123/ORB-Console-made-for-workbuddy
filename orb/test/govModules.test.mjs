/* 迁入后自检（接线前冒烟）：不依赖 bridge.mjs、不启服务、不发网络。
 * 仅从 ../xxx.mjs 直接 import，验证 9 个模块平铺进 ORB 主源码后仍可用。
 * 断言以各模块真实导出名/返回形状为准，不弱化模块本身。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TIERS, resolveMode, enabledGovernance, isTierAEnabled } from "../governanceCore.mjs";
import { tagEvidence, checkRedLine } from "../p0Discipline.mjs";
import { SITE_CAPABILITIES, actionGate, assertVisionDecisionOnly } from "../p2SiteAdapter.mjs";
import { STAGES, verifyLite, claimDone } from "../p3VerifyLite.mjs";
import { API_ENDPOINTS, createHostDataApi } from "../hostDataApi.mjs";
import { toDesktopCall, toBrowserCall } from "../executionBridge.mjs";
import { createFileChannel } from "../p1FileChannel.mjs";
import { SECTIONS, render } from "../injectable.mjs";

const GOV_FILES = Object.freeze([
  "governanceCore.mjs", "p0Discipline.mjs", "p1FileChannel.mjs",
  "p2SiteAdapter.mjs", "p2SealReview.mjs", "p3VerifyLite.mjs",
  "hostDataApi.mjs", "executionBridge.mjs", "injectable.mjs",
]);

const orbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("1 governanceCore 四档矩阵与 Tier 闸门", () => {
  assert.equal(resolveMode({ teamMode: false, maxMode: false }), "normal");
  assert.equal(resolveMode({ teamMode: false, maxMode: true }), "normal_max");
  assert.equal(resolveMode({ teamMode: true, maxMode: false }), "team_lite");
  assert.equal(resolveMode({ teamMode: true, maxMode: true }), "team_max");
  const gov = enabledGovernance("team_max");
  assert.ok(TIERS.A.every((t) => gov.includes(t)), "team_max 应含全部 Tier A");
  assert.ok(TIERS.B.every((t) => gov.includes(t)), "team_max 应含全部 Tier B");
  assert.equal(isTierAEnabled("team_lite"), false);
});

test("2 p0Discipline 证据标注与协作红线", () => {
  assert.equal(tagEvidence("").error, "empty-claim");
  assert.equal(tagEvidence("   ").ok, false);
  assert.equal(tagEvidence("有结论", { level: "已核实" }).error, "verified-needs-basis");
  assert.equal(checkRedLine({ claimedDone: true, verified: false }).ok, false);
});

test("3 p2SiteAdapter 站点闸门与视觉红线", () => {
  const gate = actionGate({ site: "not-registered.example", action: "search" });
  assert.equal(gate.channel, "vision", "未登记站点应走 vision 兜底");
  assert.ok(gate.deny.includes("硬编码选择器"));
  // 真实实现返回 {ok:false,...} 对象，而非布尔 false（与任务描述的差异，按实现调整）
  assert.equal(assertVisionDecisionOnly({ x: 1, y: 2 }).ok, false);
  assert.ok(Object.keys(SITE_CAPABILITIES).length >= 4);
});

test("4 p3VerifyLite 五段验收 fail-closed", () => {
  assert.equal(STAGES.length, 5);
  const v = verifyLite({});
  assert.equal(v.ok, false);
  assert.equal(v.verdict, "fail-closed");
  assert.equal(claimDone({ claimed: true, evidence: {} }).honest, false);
});

test("5 hostDataApi 禁用即不触网", async () => {
  let called = false;
  const api = createHostDataApi({
    enabled: false,
    fetchImpl: () => { called = true; throw new Error("fetchImpl 不应被调用"); },
  });
  const r = await api.fetchSiteData({ site: "bilibili.com", action: "search_uploader", params: { keyword: "x" } });
  assert.equal(r.code, "disabled");
  assert.equal(called, false, "enabled:false 时不得调用 fetchImpl");
  assert.ok(Object.keys(API_ENDPOINTS).length >= 2);
});

test("6 executionBridge 协议闸与 nodeId 闸", () => {
  const desk = toDesktopCall({ url: "javascript:alert(1)" });
  assert.equal(desk.ok, false);
  assert.equal(desk.error, "protocol-gate");
  // capability 表：bilibili.com/read_meta 登记为 dom 通道，dom 点击强制 node_id
  const browser = toBrowserCall({ site: "bilibili.com", action: "read_meta" });
  assert.equal(browser.ok, false);
  assert.equal(browser.error, "node-id-required");
});

test("7 p1FileChannel dir-required 与 CAS 冲突", () => {
  assert.throws(() => createFileChannel({}), /dir-required/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "govmods-"));
  try {
    const ch = createFileChannel({ dir });
    const first = ch.commit({ phase: "work" }, 0);
    assert.equal(first.ok, true);
    const second = ch.commit({ phase: "again" }, 0); // 同 expectedRev 二次提交
    assert.equal(second.ok, false);
    assert.equal(second.error, "rev-conflict");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("8 injectable render 条款汇总", () => {
  const out = render();
  assert.ok(typeof out === "string" && out.length > 0);
  assert.ok(SECTIONS.every((s) => out.includes(s.title)), "应含全部 SECTIONS 标题");
});

test("9 静态契约：无绝对路径 + 懒加载 team.mjs", () => {
  const forbidden = "D:/workbuddy_ORB控制台";
  for (const f of GOV_FILES) {
    const txt = fs.readFileSync(path.join(orbDir, f), "utf8");
    assert.ok(!txt.includes(forbidden), `${f} 不应含绝对路径`);
    assert.ok(!/D:[/\\]/.test(txt), `${f} 不应含 D: 盘符绝对路径`);
  }
  const seal = fs.readFileSync(path.join(orbDir, "p2SealReview.mjs"), "utf8");
  assert.ok(
    seal.includes('new URL("./team.mjs", import.meta.url)'),
    "p2SealReview 必须以相对 URL 动态导入 team.mjs"
  );
});
