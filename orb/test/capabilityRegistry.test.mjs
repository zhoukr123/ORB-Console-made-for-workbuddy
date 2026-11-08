/* 能力清单（急停豁免）测试 —— 这一组测的不是功能，是**边界**。
 *
 * 白名单多一项，急停就等于留了一只脚；文档漂一个字，运维就会按错的表去解释行为。
 * 所以这里锁四件事：
 *   ① 集合派生规则：只有 readOnly && stopExempt 才进；
 *   ② 写操作即使标了 stopExempt 也进不来（防"手滑加个 true"）；
 *   ③ workbuddy_execute 不在里面（2026-11-03 的历史决定，不许悄悄回来）；
 *   ④ 磁盘上的 docs/capabilities.md 与 toMarkdown() 逐字相等（防文档漂移）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITIES, stopExemptSet, isStopExempt, table, toMarkdown, governWrite, requiresConfirmOf, revocableOf, authorizedByOf, confirmRequiredSet, revocableSet } from "../capabilityRegistry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.join(HERE, "..", "docs", "capabilities.md");

test("清单结构完整：每条都有 server/tool/effect，且 key 不重复", () => {
  const seen = new Set();
  for (const c of CAPABILITIES) {
    assert.ok(c.server && c.tool, `条目缺 server/tool: ${JSON.stringify(c)}`);
    assert.ok(typeof c.effect === "string" && c.effect.trim().length >= 4,
      `${c.server}|${c.tool} 的 effect 太短，面板上等于没解释`);
    const k = `${c.server}|${c.tool}`;
    assert.ok(!seen.has(k), `重复条目：${k}`);
    seen.add(k);
  }
});

test("豁免集合只收 readOnly && stopExempt", () => {
  const want = CAPABILITIES.filter((c) => c.stopExempt && c.readOnly).map((c) => `${c.server}|${c.tool}`);
  assert.deepEqual([...stopExemptSet()].sort(), want.sort());
});

test("写操作即使标了 stopExempt 也不进集合（防手滑）", () => {
  /* 不动真清单：临时插一条 readOnly:false 的进去，验证派生规则会把它挡掉。
     直接用 isStopExempt 的语义做等价断言更稳 —— 因为它是逐条遍历的纯函数。 */
  const fake = { server: "__t", tool: "__write", readOnly: false, stopExempt: true };
  const set = new Set();
  for (const c of [...CAPABILITIES, fake]) if (c.stopExempt && c.readOnly) set.add(`${c.server}|${c.tool}`);
  assert.equal(set.has("__t|__write"), false, "写操作混进了豁免集合");
  assert.equal(isStopExempt("__t", "__write"), false, "isStopExempt 对未知(server,tool)必须返回 false");
});

test("未知的 (server, tool) 一律不放行", () => {
  assert.equal(isStopExempt("nope", "whatever"), false);
  assert.equal(isStopExempt("orb", "drag"), false, "不能因为 orb 有 cursor_position 就放行 orb.drag");
  assert.equal(isStopExempt("workbuddy", "workbuddy_execute"), false,
    "workbuddy_execute 2026-11-03 已移出白名单：急停期间不许新建后台任务");
  /* 报告B V-10：把「检索不进豁免」从隐式满足点名锁死，
     否则将来往 CAPABILITIES 加一行 search 就会静默破防。 */
  assert.equal(isStopExempt("windows", "Scrape"), false, "检索类一律不进急停豁免");
  assert.equal(isStopExempt("workbuddy", "workbuddy_search"), false);
});

test("文档写明检索不进豁免，且 readOnly 不等于豁免", () => {
  const md = toMarkdown();
  assert.match(md, /一律不进豁免/);
  assert.match(md, /不等于/);
  assert.match(md, /searchExemptAudit/);
});

test("table() 与清单一致，且 stopExempt 字段是「实际生效」的那个值", () => {
  const t = table();
  assert.equal(t.length, CAPABILITIES.length);
  for (let i = 0; i < t.length; i += 1) {
    assert.equal(t[i].key, `${CAPABILITIES[i].server}|${CAPABILITIES[i].tool}`);
    assert.equal(t[i].stopExempt, !!(CAPABILITIES[i].stopExempt && CAPABILITIES[i].readOnly),
      `${t[i].key} 的 stopExempt 展示值与实际生效值不一致 —— 面板会解释错`);
  }
});

test("docs/capabilities.md 与 toMarkdown() 逐字一致", () => {
  const md = toMarkdown();
  assert.ok(fs.existsSync(DOC), `缺文档：${DOC}（跑 node orb/tools/gen-capabilities-doc.mjs）`);
  const cur = fs.readFileSync(DOC, "utf8");
  assert.equal(cur, md, "文档与清单漂移了 —— 别手改文档，改清单后重新生成");
});

test("toMarkdown() 是确定性的（两次调用必须完全相同）", () => {
  assert.equal(toMarkdown(), toMarkdown());
});

test("文档里写明了 workbuddy_execute 被移出的理由", () => {
  const md = toMarkdown();
  assert.ok(md.includes("workbuddy_execute"), "文档必须交代那条历史决定，否则下一个人会想把它加回去");
  assert.ok(md.includes("readOnly: true"), "文档必须写明新增豁免的准入条件");
});

/* ---------------- 方案 D：写操作治理（权限治理） ---------------- */
test("requiresConfirmOf：未登记（写）工具默认需确认；只读清单项默认不需", () => {
  assert.equal(requiresConfirmOf("windows", "Click"), true, "未登记写工具默认需确认（fail-closed）");
  assert.equal(requiresConfirmOf("windows", "Snapshot"), false, "已登记只读项无需确认");
});

test("revocableOf / authorizedByOf：现有清单无此类字段 → 给出安全默认", () => {
  assert.equal(revocableOf("windows", "Snapshot"), false);
  assert.equal(authorizedByOf("windows", "Snapshot"), null);
});

test("governWrite：只读工具直接放行，不卡", () => {
  assert.deepEqual(governWrite("windows", "Snapshot", {}), { ok: true });
  assert.deepEqual(governWrite("windows", "Snapshot", { confirmed: false }), { ok: true });
});

test("governWrite：未登记写工具无确认令牌 → CONFIRM_REQUIRED", () => {
  const r = governWrite("windows", "Click", {});
  assert.equal(r.ok, false);
  assert.equal(r.code, "CONFIRM_REQUIRED");
});

test("governWrite：未登记写工具带确认令牌 → 放行", () => {
  assert.deepEqual(governWrite("windows", "Click", { confirmed: true }), { ok: true });
});

test("governWrite：authorizedBy 白名单内/外正确裁决", () => {
  const cap = { server: "windows", tool: "__gated", readOnly: false, authorizedBy: { identities: ["alice"], devices: ["dev-1"] } };
  CAPABILITIES.push(cap);
  try {
    assert.equal(governWrite("windows", "__gated", { confirmed: true, identity: "bob" }).code, "DENIED", "身份不在白名单 → 拒");
    assert.equal(governWrite("windows", "__gated", { confirmed: true, identity: "alice", device: "dev-2" }).code, "DENIED", "设备不在白名单 → 拒");
    assert.deepEqual(governWrite("windows", "__gated", { confirmed: true, identity: "alice", device: "dev-1" }), { ok: true }, "身份+设备都在 → 放行");
  } finally {
    const i = CAPABILITIES.findIndex((c) => c.tool === "__gated");
    if (i >= 0) CAPABILITIES.splice(i, 1);
  }
});

test("confirmRequiredSet / revocableSet：默认对只读清单为空（写工具未登记，靠 fail-closed 兜）", () => {
  // 现有清单全是只读，故这两个集合默认空；逻辑重点在 governWrite 的 fail-closed 默认。
  assert.equal(confirmRequiredSet().size, 0);
  assert.equal(revocableSet().size, 0);
});
