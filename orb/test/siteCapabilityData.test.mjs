/* 站点能力数据表单测：数据诚实性 + 红线守卫 + 静态契约。
 * 直接 import 数据模块，并用 fs.readFileSync 读原始 CSV 做逐行交叉验证。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DATA_SOURCE,
  CATEGORIES,
  TIERS,
  VERIFIED_SITES,
  DEEP_ADAPTED_SITES,
  SITE_ENTRIES,
  SITE_STATS,
  classify,
  lookupSite,
  buildCapabilityTable,
  assertNoInventedSelectors,
} from "../siteCapabilityData.mjs";

const CSV_PATH = "D:/WorkBuddy 附属文件夹/项目记录/2026-09-28-00-45-13/china-top1000-websites.csv";
const VERIFIED_DOMAINS = ["bilibili.com", "taobao.com", "jd.com", "eastmoney.com"];
const ENTRY_KEYS = ["rank", "domain", "category", "tier", "verified", "channel", "note"];

// 与生成口径一致：按 CSV 原始行取 rank<=226，域名保留原始字符串（去首尾空白）。
function csvTop226() {
  const lines = readFileSync(CSV_PATH, "utf8").split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const comma = line.indexOf(",");
    const rank = parseInt(line.slice(0, comma), 10);
    if (rank > 226) break;
    rows.push({ rank, domain: line.slice(comma + 1).trim() });
  }
  return rows;
}

const CSV_ROWS = csvTop226();

test("1. SITE_ENTRIES：226 条、rank 1..226 连续不重复、逐行与 CSV 完全一致", () => {
  assert.equal(CSV_ROWS.length, 226, "CSV 前 226 行应为 226 条");
  assert.equal(SITE_ENTRIES.length, 226, "应内联 226 条真实域名");
  const seen = new Set();
  for (let i = 0; i < 226; i++) {
    const e = SITE_ENTRIES[i];
    for (const k of ENTRY_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(e, k), "第 " + (i + 1) + " 条缺字段 " + k);
    }
    assert.equal(e.rank, i + 1, "rank 应连续于 index " + i);
    assert.equal(e.rank, CSV_ROWS[i].rank, "rank 应与 CSV 一致于 index " + i);
    assert.equal(e.domain, CSV_ROWS[i].domain, "域名须与 CSV 第 " + (i + 1) + " 行逐字一致");
    assert.ok(!seen.has(e.domain), "不应有重复域名: " + e.domain);
    seen.add(e.domain);
    // 生成时分类与运行时 classify 必须一致（同一份 CATS 规则）
    assert.equal(e.category, classify(e.domain), "品类应与 classify 一致: " + e.domain);
    assert.ok([TIERS.LIGHT, TIERS.DEEP, TIERS.SKIP].includes(e.tier), "tier 应合法: " + e.domain);
    if (e.verified !== true) {
      assert.equal(e.verified, false, "未核实条目须显式标 verified:false");
      assert.ok(e.note.includes("仅品类登记，未核实选择器"), "note 须明确未核实选择器: " + e.domain);
    }
  }
  // 4 个已核实站点确实在榜内且 tier/verified 正确
  for (const d of VERIFIED_DOMAINS) {
    const e = SITE_ENTRIES.find((x) => x.domain === d);
    assert.ok(e, "已核实站点应在 SITE_ENTRIES: " + d);
    assert.equal(e.tier, TIERS.DEEP);
    assert.equal(e.verified, true);
  }
});

test("2. SITE_STATS 自洽：total/分层/verified/deepCandidates/deepVerified", () => {
  assert.equal(SITE_STATS.total, 226);
  assert.equal(SITE_STATS.light + SITE_STATS.deep + SITE_STATS.skip, 226);
  assert.equal(SITE_STATS.verified, 4);
  assert.equal(SITE_STATS.deepVerified, 4);
  assert.ok(SITE_STATS.deepCandidates >= SITE_STATS.deepVerified, "估算候选数应 >= 已核实数");
  assert.ok(SITE_STATS.deepCandidates > SITE_STATS.deepVerified, "估算与已核实应 honest 区分");
  // 与实际条目逐项交叉核对
  assert.equal(SITE_ENTRIES.filter((e) => e.tier === "light").length, SITE_STATS.light);
  assert.equal(SITE_ENTRIES.filter((e) => e.tier === "deep").length, SITE_STATS.deep);
  assert.equal(SITE_ENTRIES.filter((e) => e.tier === "skip").length, SITE_STATS.skip);
  assert.equal(SITE_ENTRIES.filter((e) => e.verified === true).length, SITE_STATS.verified);
  const catSum = Object.values(SITE_STATS.byCategory).reduce((a, b) => a + b, 0);
  assert.equal(catSum, 226, "byCategory 合计应 = 226");
  const realCat = {};
  for (const e of SITE_ENTRIES) realCat[e.category] = (realCat[e.category] || 0) + 1;
  assert.deepEqual(SITE_STATS.byCategory, realCat, "byCategory 应与条目分布一致");
});

test("3. classify：影音/媒体命中、长尾兜底返回「其他/品牌/长尾」", () => {
  assert.equal(classify("bilibili.com"), "影音/媒体");
  assert.equal(classify("unknown-brand-xyz.com"), "其他/品牌/长尾");
  assert.equal(classify("unknown-brand-xyz.com"), CATEGORIES.OTHER);
  // 大小写与 www 前缀不影响分类
  assert.equal(classify("WWW.Bilibili.COM"), "影音/媒体");
});

test("4. lookupSite：支持大小写 + www 前缀，未登记返回 null", () => {
  const e = lookupSite("WWW.Bilibili.COM");
  assert.ok(e, "WWW.Bilibili.COM 应命中");
  assert.equal(e.domain, "bilibili.com");
  assert.equal(lookupSite("BILIBILI.COM").domain, "bilibili.com");
  assert.equal(lookupSite("www.baidu.com").domain, "baidu.com");
  assert.equal(lookupSite("Taobao.com").domain, "taobao.com");
  assert.equal(lookupSite("not-in-list-12345.com"), null);
  assert.equal(lookupSite(""), null);
});

test("5. buildCapabilityTable：不含 skip 站点，4 个已核实站点保留原真实动作", () => {
  const table = buildCapabilityTable();
  const skipDomains = SITE_ENTRIES.filter((e) => e.tier === TIERS.SKIP).map((e) => e.domain);
  assert.ok(skipDomains.length > 0, "应存在 skip 站点");
  for (const d of skipDomains) {
    assert.ok(!(d in table), "skip 站点不应进能力表: " + d);
  }
  const deepCount = Object.keys(DEEP_ADAPTED_SITES).length;
  const deepInEntries = Object.keys(DEEP_ADAPTED_SITES).filter((d) => SITE_ENTRIES.some((e) => e.domain === d));
  const netAdded = deepCount - deepInEntries.length; // 已在 226 内的站点只覆盖、不净增
  assert.equal(Object.keys(table).length, 226 - skipDomains.length + netAdded, "表条目数 = 226 - skip + 净增深度适配");
  // 深度适配站点已并入能力表且标为已核实
  for (const d of Object.keys(DEEP_ADAPTED_SITES)) {
    assert.ok(d in table, "深度适配站点应在表: " + d);
    assert.equal(table[d].verified, true, d + " 应已核实");
    assert.equal(table[d].deepAdapted, true, d + " 应标记 deepAdapted");
  }
  for (const d of VERIFIED_DOMAINS) {
    assert.ok(d in table, "已核实站点应在表: " + d);
    const entry = table[d];
    assert.equal(entry.verified, true);
    assert.equal(entry.category, VERIFIED_SITES[d].category);
    assert.equal(entry.fallback, VERIFIED_SITES[d].fallback);
    assert.deepEqual(entry.actions, VERIFIED_SITES[d].actions, d + " 动作须原样保留");
  }
  // 每个站点形状与 SITE_CAPABILITIES 一致
  for (const entry of Object.values(table)) {
    for (const k of ["category", "actions", "fallback"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, k), "表条目缺字段 " + k);
    }
    assert.equal(typeof entry.actions, "object");
  }
});

test("6. assertNoInventedSelectors：真实表 ok；伪造 selector 假表 ok:false 且列出 bad", () => {
  const real = assertNoInventedSelectors(buildCapabilityTable());
  assert.equal(real.ok, true, "真实能力表不应含编造选择器: " + JSON.stringify(real.bad));
  assert.deepEqual(real.bad, []);

  const fake = {
    "fake.com": {
      verified: false,
      category: "电商",
      actions: {
        x: { channel: "url", selector: ".invented", pattern: "https://x/{kw}" },
      },
      fallback: "vision",
    },
  };
  const r = assertNoInventedSelectors(fake);
  assert.equal(r.ok, false);
  assert.ok(r.bad.length > 0, "应列出 bad 项");
  assert.ok(r.bad.some((b) => b.includes("selector")), "bad 应列出 selector 字段");
  // endpoint 同样被拒
  const fake2 = { a: { verified: false, actions: { y: { channel: "api", endpoint: "api.x.com/get" } } } };
  assert.equal(assertNoInventedSelectors(fake2).ok, false);
  // verified:true 条目允许真实动作
  assert.equal(assertNoInventedSelectors({ b: { verified: true, actions: { z: { channel: "dom", selector: ".real" } } } }).ok, true);
});

test("7. 全表：未核实条目 actions 无 selector/endpoint，channel 只允许 url", () => {
  const table = buildCapabilityTable();
  let lightCount = 0;
  for (const [site, entry] of Object.entries(table)) {
    if (entry.verified === true) continue; // 4 个已核实站点除外
    lightCount++;
    assert.equal(entry.verified, false, site + " 应为未核实");
    const actions = entry.actions || {};
    assert.ok("search" in actions, site + " 应至少含一个 search 动作");
    for (const [action, spec] of Object.entries(actions)) {
      assert.ok(!Object.prototype.hasOwnProperty.call(spec, "selector"), site + "/" + action + " 不应有 selector");
      assert.ok(!Object.prototype.hasOwnProperty.call(spec, "endpoint"), site + "/" + action + " 不应有 endpoint");
      assert.equal(spec.channel, "url", site + "/" + action + " channel 只允许 url");
      assert.equal(typeof spec.pattern, "string", site + "/" + action + " 应有通用 URL 模板");
      assert.ok(!spec.pattern.includes("document.querySelector"), site + " 模板不应含 DOM 注入");
      assert.equal(typeof spec.verify, "string", site + "/" + action + " 应有可观察 verify 信号");
    }
  }
  // 深度适配把部分原 unverified 站点（在 226 内者）翻成已核实，故 lightCount = SITE_STATS.light − 这些站点数
  const deepInEntries = Object.keys(DEEP_ADAPTED_SITES).filter((d) => SITE_ENTRIES.some((e) => e.domain === d));
  assert.equal(lightCount, SITE_STATS.light - deepInEntries.length, "未核实表条目数 = light − 在 226 内的深度适配站点");
});

test("8. 静态契约：源码无 DOM 注入字样、import 语句为零", () => {
  const src = readFileSync(new URL("../siteCapabilityData.mjs", import.meta.url), "utf8");
  // 断言用的禁词用拼接构造，确保这些断言字符串本身不出现在被测源码里
  const banned = [
    "chrome" + ".scripting",
    "document" + ".querySelector",
    "document" + ".getElementById",
  ];
  for (const b of banned) {
    assert.ok(!src.includes(b), "源码不应含 DOM 注入字样: " + b);
  }
  assert.ok(!/(^|\n)\s*import\b/m.test(src), "源码不应含 import 语句");
  assert.ok(!/\bimport\b/.test(src), "源码不应出现 import 字样");
  assert.equal(DATA_SOURCE, "china-top1000-websites.csv#rank<=226");
  // 品类常量与 CATS 名称一致
  assert.equal(CATEGORIES.OTHER, "其他/品牌/长尾");
  assert.equal(Object.keys(VERIFIED_SITES).length, 4);
});

test("9. DEEP_ADAPTED_SITES：独立深度适配层，5 站、已核实、零编造选择器、含 L2 api 与 L1 extract", () => {
  const domains = Object.keys(DEEP_ADAPTED_SITES);
  assert.equal(domains.length, 5, "应含 5 个深度适配站点");
  const channels = new Set();
  for (const d of domains) {
    const def = DEEP_ADAPTED_SITES[d];
    assert.equal(def.verified, true, d + " 应已核实");
    assert.ok(def.note && def.note.length > 2, d + " 应有实证注记");
    for (const [action, spec] of Object.entries(def.actions)) {
      channels.add(spec.channel);
      // 红线：深度适配层同样不得编造 DOM 选择器或站内 endpoint（api 通道允许 endpoint 声明）
      if (spec.channel !== "api" && spec.channel !== "extract") {
        assert.ok(!("selector" in spec), d + "/" + action + " 不应有 selector");
      }
      if (spec.channel === "api") assert.ok(spec.endpoint, d + "/" + action + " api 应有 endpoint");
    }
  }
  assert.ok(channels.has("api"), "应含 L2 api 通道");
  assert.ok(channels.has("extract"), "应含 L1 extract 通道");
  // 与 buildCapabilityTable 合并后，这些站点的动作应与声明一致
  const table = buildCapabilityTable();
  for (const d of domains) {
    assert.equal(table[d].verified, true);
    for (const a of Object.keys(DEEP_ADAPTED_SITES[d].actions)) {
      assert.equal(table[d].actions[a].channel, DEEP_ADAPTED_SITES[d].actions[a].channel, d + "/" + a + " 通道应一致");
    }
  }
});
