/**
 * #199 深度站点「带证据」核实录入器。
 *
 * 背景：SITE_STATS.deepCandidates = 39 是 11-07 的估算值，siteCapabilityData.mjs 里
 * 真实 tier:"deep" 只有 4 个且均已核实。本模块不编造任何 selector / endpoint，
 * 只把「估算」变成一份真实的、可按站带证据录入的候选队列。
 *
 * 红线：
 *  - evidence 四要素不齐 → 强制降级 channel:"url"，剥离 selector/endpoint。
 *  - 产出是待审条目，绝不写回 siteCapabilityData.mjs（真相源只能人工改）。
 *  - 合并结果必须过 assertNoInventedSelectors()，守门不过即整体拒绝。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SITE_ENTRIES, SITE_STATS, VERIFIED_SITES, TIERS,
  assertNoInventedSelectors,
} from "../siteCapabilityData.mjs";

export const P0_CATEGORIES = Object.freeze(["电商/购物", "金融/投资", "影音/媒体"]);
export const P1_CATEGORIES = Object.freeze(["社区/社交", "搜索/门户/新闻", "旅游/出行"]);
export const EVIDENCE_FIELDS = Object.freeze(["method", "observedAt", "sample", "verifiedBy"]);
export const EVIDENCE_METHODS = Object.freeze(["dom", "api", "url"]);
export const VERIFY_CODES = Object.freeze({
  OK: "approved",
  INSUFFICIENT: "insufficient-evidence",
  UNKNOWN_SITE: "unknown-site",
  SKIPPED: "skipped-site",
  GATE_REJECTED: "gate-rejected",
});

/** 真实候选队列：排除 skip 与已核实，按优先级 + rank 排序。 */
export function buildVerificationQueue(entries = SITE_ENTRIES) {
  const p0 = [];
  const p1 = [];
  for (const e of entries) {
    if (e.tier === TIERS.SKIP || e.verified === true) continue;
    const row = { rank: e.rank, domain: e.domain, category: e.category, priority: "" };
    if (P0_CATEGORIES.includes(e.category)) { row.priority = "P0"; p0.push(row); }
    else if (P1_CATEGORIES.includes(e.category)) { row.priority = "P1"; p1.push(row); }
  }
  const byRank = (a, b) => a.rank - b.rank;
  p0.sort(byRank);
  p1.sort(byRank);
  return {
    p0, p1, total: p0.length + p1.length,
    estimated: SITE_STATS.deepCandidates,
    verifiedNow: Object.keys(VERIFIED_SITES).length,
    note: `旧估算 deepCandidates=${SITE_STATS.deepCandidates} 只作单时点口径；本队列按品类规则实得 ${p0.length + p1.length} 条（P0 ${p0.length} / P1 ${p1.length}），差异如实保留，不回改估算值。`,
  };
}

function normalizeDomain(domain) {
  return String(domain || "").trim().toLowerCase().replace(/^www\./, "");
}

function hasEvidence(ev) {
  if (!ev || typeof ev !== "object") return false;
  for (const k of EVIDENCE_FIELDS) {
    const v = ev[k];
    if (typeof v !== "string" || v.trim().length === 0) return false;
  }
  return EVIDENCE_METHODS.includes(String(ev.method).trim().toLowerCase());
}

/**
 * 录入一条核实结果。证据不齐时绝不静默接受 selector/endpoint，
 * 而是强制降级成 url 通用模板并明确返回降级码。
 */
export function submitVerification(input = {}, entries = SITE_ENTRIES) {
  const domain = normalizeDomain(input.domain);
  const site = entries.find((e) => normalizeDomain(e.domain) === domain);
  if (!site) return { ok: false, code: VERIFY_CODES.UNKNOWN_SITE, domain, note: "域名不在 226 条榜单里" };
  if (site.tier === TIERS.SKIP) return { ok: false, code: VERIFY_CODES.SKIPPED, domain, note: "跳过品类不接受核实" };

  const ev = input.evidence || {};
  if (!hasEvidence(ev)) {
    return {
      ok: true,
      code: VERIFY_CODES.INSUFFICIENT,
      domain,
      downgraded: true,
      entry: {
        category: site.category,
        actions: { search: { channel: "url", pattern: "https://www.baidu.com/s?wd={kw}%20site:{domain}", verify: "URL 变化 + 页面就绪" } },
        fallback: "vision",
        verified: false,
        note: "证据不全，已强制降级为通用 URL 通道；未写入 selector/endpoint",
      },
      note: `evidence 需齐备 ${EVIDENCE_FIELDS.join("/")} 且 method ∈ ${EVIDENCE_METHODS.join("/")}；本次缺证据，selector/endpoint 已剥离。`,
    };
  }

  const method = String(ev.method).trim().toLowerCase();
  const action = { channel: method, verify: String(ev.sample).trim().slice(0, 300) };
  if (method === "dom" && input.selector) action.selector = String(input.selector).trim().slice(0, 200);
  if (method === "api" && input.endpoint) action.endpoint = String(input.endpoint).trim().slice(0, 300);
  if (method === "url" && input.pattern) action.pattern = String(input.pattern).trim().slice(0, 300);
  return {
    ok: true,
    code: VERIFY_CODES.OK,
    domain,
    downgraded: false,
    evidence: {
      method, observedAt: String(ev.observedAt).trim().slice(0, 60),
      sample: String(ev.sample).trim().slice(0, 300),
      verifiedBy: String(ev.verifiedBy).trim().slice(0, 80),
    },
    entry: {
      category: site.category,
      actions: { [String(input.action || "search").trim().slice(0, 60)]: action },
      fallback: "vision",
      verified: true,
      note: `核实于 ${String(ev.observedAt).trim()}，证据：${String(ev.sample).trim().slice(0, 120)}`,
    },
    note: "证据齐备，条目仅作为待审结果产出；需人工合并进真相源后才生效。",
  };
}

/** 把待审条目合并进能力表并过守门。绝不写文件。 */
export function applyVerifications(table = {}, submissions = []) {
  const next = JSON.parse(JSON.stringify(table || {}));
  let applied = 0;
  const rejected = [];
  for (const s of submissions) {
    if (!s || !s.ok || s.code !== VERIFY_CODES.OK || !s.entry) { rejected.push(s?.domain || "(unknown)"); continue; }
    next[s.domain] = s.entry;
    applied += 1;
  }
  const audit = assertNoInventedSelectors(next);
  return {
    ok: audit.ok,
    code: audit.ok ? "ok" : VERIFY_CODES.GATE_REJECTED,
    applied, rejected, table: next,
    audit,
    note: "纯函数产出，未写回 siteCapabilityData.mjs；合并前请人工复核证据。",
  };
}

export const EVIDENCE_TEMPLATE = Object.freeze({
  domain: "example.com",
  action: "search",
  selector: "", endpoint: "", pattern: "",
  evidence: {
    method: "dom | api | url",
    observedAt: "YYYY-MM-DD HH:mm GMT+8",
    sample: "实际观测：选择器命中并回读到什么 / 接口返回什么字段",
    verifiedBy: "核实人 + 使用的浏览器版本",
  },
});

export function toMarkdown(queue) {
  const L = ["# 深度站点待核实队列", "", queue.note, "",
    `- 已核实深度站：**${queue.verifiedNow}**（${Object.keys(VERIFIED_SITES).join(" / ")}）`,
    `- 待核实：**${queue.total}** 条（P0 ${queue.p0.length} / P1 ${queue.p1.length}）`, "",
    "## P0 优先（电商 / 金融 / 影音）", ""];
  for (const e of queue.p0) L.push(`${e.rank}. \`${e.domain}\` — ${e.category}`);
  L.push("", "## P1 次优先（社交 / 门户 / 出行）", "");
  for (const e of queue.p1) L.push(`${e.rank}. \`${e.domain}\` — ${e.category}`);
  L.push("", "## 录入纪律", "",
    "- 单测守门：`assertNoInventedSelectors()`，未核实条目出现 `selector`/`endpoint` 即判失败。",
    "- 证据四要素不齐 → 自动降级 `channel:url`，不写选择器。",
    "- 本工具不写回真相源，产出仅供人工合并。");
  return L.join("\n") + "\n";
}

const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  if (process.argv.includes("--template")) {
    process.stdout.write(JSON.stringify(EVIDENCE_TEMPLATE, null, 2) + "\n");
  } else {
    process.stdout.write(toMarkdown(buildVerificationQueue()));
  }
}
