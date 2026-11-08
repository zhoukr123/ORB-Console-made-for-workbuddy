/* 报告B §7 批次A 第5、6项：纪律层纯函数 + 全链路接线契约。
 * 「没有冒烟的项不算完成」：这里既有可跑的纯函数判定，
 * 也有对 bridge / panel / voice.js / costLedger 真实接线的静态锁。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNTRUSTED_SOURCES, isUntrustedSource,
  SEARCH_LIKE_KEYS, isSearchLike, searchExemptAudit,
  authorizeDomain, isPrivateHost,
  DEGRADE_CODES, classifyDegrade, degradeRecord,
  structuredMarker, V12_CONTRACT,
} from "../batchA.mjs";
import { createCostLedger } from "../costLedger.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");
const PANEL = fs.readFileSync(path.join(ROOT, "desktop", "panel.html"), "utf8");
const VOICE = fs.readFileSync(path.join(ROOT, "desktop", "voice.js"), "utf8");
const LEDGER = fs.readFileSync(path.join(ROOT, "costLedger.mjs"), "utf8");

test("V-11：三入口来源标签固定，表外来源一律拒", () => {
  assert.deepEqual([...UNTRUSTED_SOURCES], ["transcript", "ocr", "webpage"]);
  assert.ok(Object.isFrozen(UNTRUSTED_SOURCES));
  for (const s of UNTRUSTED_SOURCES) assert.equal(isUntrustedSource(s), true, s);
  for (const s of ["", "user", "system", null, undefined]) assert.equal(isUntrustedSource(s), false, String(s));
});

test("V-10：检索类一律不进急停豁免（点名锁定，防将来静默破防）", () => {
  const a = searchExemptAudit();
  assert.equal(a.ok, true);
  assert.deepEqual(a.violated, []);
  assert.ok(SEARCH_LIKE_KEYS.includes("windows|Scrape"));
  assert.ok(SEARCH_LIKE_KEYS.includes("browser|dom.get_text"));
  assert.equal(isSearchLike("windows", "Scrape"), true);
  assert.equal(isSearchLike("orb", "ocr"), false);
  assert.equal(a.capabilityCount, 6, "能力清单仍是 6 条只读查询");
  assert.match(a.note, /登记只读不等于登记豁免/);
});

test("V-10：域名授权默认 fail-closed，非白名单给 requires_user_authorization", () => {
  assert.equal(authorizeDomain("").reasonCode, "no-url", "纯 query 检索不涉及域名");
  const noAllow = authorizeDomain("https://example.com/a?b=1", []);
  assert.equal(noAllow.ok, false);
  assert.equal(noAllow.reasonCode, "requires_user_authorization");
  assert.equal(noAllow.degraded, true);
  assert.equal(noAllow.noVisionFallback, true);
  assert.equal(noAllow.host, "example.com");

  const ok = authorizeDomain("https://example.com/x", ["example.com"]);
  assert.equal(ok.ok, true);
  assert.equal(ok.reasonCode, "authorized");
  assert.equal(authorizeDomain("https://api.example.com/x", ["example.com"]).ok, true, "子域跟随白名单");
  assert.equal(authorizeDomain("https://evil.com/x", ["example.com"]).ok, false);

  assert.equal(authorizeDomain("http://example.com", ["example.com"]).why, "只允许 https");
  assert.equal(authorizeDomain("not a url", ["example.com"]).reasonCode, "requires_user_authorization");
  for (const h of ["127.0.0.1", "localhost", "10.1.2.3", "192.168.1.1", "172.20.0.1", "169.254.169.254", "metadata.google.internal"]) {
    assert.equal(isPrivateHost(h), true, h);
    assert.equal(authorizeDomain(`https://${h}/x`, [h]).ok, false, h);
  }
  assert.equal(isPrivateHost("example.com"), false);
});

test("V-01：四类架构降级码与映射完全确定", () => {
  assert.deepEqual(Object.keys(DEGRADE_CODES).sort(),
    ["compile-failed", "needs-pixel-semantics", "tool-indeterminate", "tree-incomplete"].sort());
  assert.equal(classifyDegrade("gui-intent"), "needs-pixel-semantics");
  assert.equal(classifyDegrade("bad-shape"), "compile-failed");
  assert.equal(classifyDegrade("no-whitelist-match"), "compile-failed");
  assert.equal(classifyDegrade("tool-indeterminate"), "tool-indeterminate");
  assert.equal(classifyDegrade("tree-incomplete"), "tree-incomplete");
  assert.equal(classifyDegrade("没见过的"), "compile-failed");
  const d = degradeRecord("gui-intent");
  assert.equal(d.degraded, true);
  assert.equal(d.reasonCode, "needs-pixel-semantics");
  assert.equal(d.stage, "v01-compile");
  assert.equal(d.zeroVlm, false, "降级单不许记成零 VLM");
  assert.equal(d.noVisionFallback, false, "降级到视觉时不能谎称「没回落」");
});

test("一致性：面板 V01_DEGRADE_MAP 与 batchA.classifyDegrade 逐字一致", () => {
  const seg = PANEL.slice(PANEL.indexOf("const V01_DEGRADE_MAP"), PANEL.indexOf("function v01Degrade"));
  const pairs = [...seg.matchAll(/'([^']+)':\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
  assert.equal(pairs.length, 5, "映射表应有 5 行");
  for (const [from, to] of pairs) {
    assert.equal(classifyDegrade(from), to, `${from} 的映射漂移`);
    assert.ok(to in DEGRADE_CODES, `${to} 不是登记过的架构原因码`);
  }
});

test("V-09：结构化标记显式记 0 次 VLM，并带人类优先名额", () => {
  const m = structuredMarker("search-and-compose");
  assert.equal(m.route, "structured");
  assert.equal(m.ruleId, "v01:search-and-compose");
  assert.equal(m.zeroVlm, true);
  assert.equal(m.vlmCalls, 0);
  assert.equal(m.priority, "human");
  assert.ok(Object.isFrozen(m));
  assert.equal(structuredMarker("compare").ruleId, "v01:compare");
});

test("V-12：三条架构契约都有明确底座与接线声明", () => {
  assert.equal(V12_CONTRACT.humanPriority.key, "human");
  assert.match(V12_CONTRACT.humanPriority.base, /capacityFor/);
  assert.match(V12_CONTRACT.silentBackfill.base, /silent/);
  assert.match(V12_CONTRACT.statusEvents.wiredBy, /已接线/);
});

test("V-09 冒烟：costLedger 能把结构化 0 次 VLM 单与普通单分开报", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-batcha-"));
  const ledger = createCostLedger({ dir, now: () => 1000 });
  const a = ledger.recordText("t1", "结构化直达", { route: "structured", ruleId: "v01:compose", zeroVlm: true, vlmCalls: 0 });
  const b = ledger.recordText("t1", "普通后台", { route: "back" });
  assert.equal(a.zeroVlm, true);
  assert.equal(a.vlmCalls, 0);
  assert.equal(b.zeroVlm, false, "普通单不许冒充零 VLM");
  assert.equal(b.vlmCalls, null, "「没记」不许被当成「0 次」");
  const t = ledger.totals();
  assert.equal(t.zeroVlmCalls, 1);
  assert.equal(t.zeroVlmVlmCalls, 0);
  const routes = ledger.byRoute();
  assert.ok(routes.some((r) => r.route === "structured" && r.zeroVlmCalls === 1));
  assert.ok(routes.some((r) => r.route === "back" && r.zeroVlmCalls === 0));
});

test("桥契约：V-11 三入口与 V-10 域名授权都已接线", () => {
  assert.match(BRIDGE, /guarded: textGate\.guard\(String\(r\.text \|\| ""\), "ocr"\)/, "OCR 入口");
  assert.match(BRIDGE, /\(\(key === "windows" && tool === "Scrape"\) \|\| tool === "dom\.get_text"\)/, "Scrape / 网页正文入口");
  assert.match(BRIDGE, /untrusted: textGate\.guard\(toolTextOf\(r\), "webpage"\)/);
  assert.match(BRIDGE, /case "textgate\.guard"/, "ASR / 统一闸门入口");
  assert.match(BRIDGE, /isUntrustedSource\(src\)/);
  assert.match(BRIDGE, /authorizeDomain\(b\.url, SEARCH_ALLOWED_HOSTS\)/);
  assert.match(BRIDGE, /reasonCode: "requires_user_authorization"/);
  assert.match(BRIDGE, /ORB_SEARCH_HOSTS/);
  const pub = BRIDGE.match(/const PUBLIC_PATHS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(pub && !pub[1].includes("search"), "/api/search 不可免鉴权");
});

test("桥契约：V-01 降级审计 / V-09 零 VLM / V-12 人类优先都进了热路径", () => {
  assert.match(BRIDGE, /case "v01\.degrade": out\.data = noteV01Degrade\(b\)/);
  assert.match(BRIDGE, /case "v01\.degrades"/);
  assert.match(BRIDGE, /case "batchA\.audit"/);
  assert.match(BRIDGE, /zeroVlm: body\.zeroVlm === true/);
  assert.match(BRIDGE, /priority: body\.priority === "human" \? "human" : undefined/);
  assert.match(BRIDGE, /zeroVlm: next\.zeroVlm === true/);
  assert.match(BRIDGE, /\[已过不可信文本闸门\]/);
});

test("面板契约：ASR 过闸、结构化标记、显式降级、静默回填都接了", () => {
  assert.match(VOICE, /input\.dataset\.orbAsrText = input\.value/, "ASR 原文标记");
  assert.match(PANEL, /async function guardTranscript\(/);
  assert.match(PANEL, /source: 'transcript'/);
  assert.match(PANEL, /window\.__orbV01\.structured\(sc\.kind\)/);
  assert.match(PANEL, /silentResult: true/);
  assert.match(PANEL, /action: 'v01\.degrade'/);
  assert.match(PANEL, /guarded: o\.guarded === true/);
  assert.match(PANEL, /priority: o\.marker\.priority/);
  assert.match(PANEL, /node\.dataset\.silentResult = '1'/);
  assert.match(PANEL, /onTaskDone\(\{ silent: node\.dataset\.silentResult === '1', job: j \}\)/,
    "成功收尾必须带 job 快照，供统一定闸看见中止/错误信号（#144）");
  assert.match(PANEL, /if \(o\.silent\) \{ statDone\+\+; return; \}/, "静默回填必须真的短路播报");
});

test("账本契约：零 VLM 字段只在 /api/cost 侧，不进安全页", () => {
  assert.match(LEDGER, /zeroVlm: usage\.zeroVlm === true/);
  assert.match(LEDGER, /vlmCalls: usage\.zeroVlm === true \? 0 : null/);
  assert.match(LEDGER, /zeroVlmCalls: 0, zeroVlmVlmCalls: 0/);
  assert.ok(!PANEL.includes("zeroVlmCalls"), "面板不得新开数值展示区（报告 §5）");
});
