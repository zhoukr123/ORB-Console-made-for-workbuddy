/* 执行桥接层：把治理层决策翻译成两条执行通道的真实指令形态。
 *
 * 对应《综合性方案》§5 四个桥接闭环。补齐的是"接线"，不是重造执行能力：
 *   - 软件自动化通道：ORB /api/call 的 body {server, tool, args}（bridge.mjs:6298 实证形态）
 *   - 浏览器自动化通道：wb_ext_027 的 dispatch(method, params)（background.js:1607 实证形态，
 *     导航方法为 tab.goto / params.url，见 background.js:1586）
 *
 * 红线在此强制：浏览器一律优先 dom_cua（node_id 定位），
 * 视觉档只允许输出决策，绝不生成 cua.click 这类坐标指令。
 */
import { actionGate, SITE_CAPABILITIES, assertVisionDecisionOnly } from "./p2SiteAdapter.mjs";
import { routeByCost } from "./p0Discipline.mjs";
import { isTierAEnabled } from "./governanceCore.mjs";
import { API_ENDPOINTS } from "./hostDataApi.mjs";

/** 软件自动化：A 口径（URL query 直开）→ /api/call 形态。 */
export function toDesktopCall({ url, expertId, ticketId } = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) {
    return { ok: false, error: "protocol-gate", reason: "协议闸只放行 http/https" };
  }
  return {
    ok: true,
    channel: "software_automation",
    endpoint: "/api/call",
    body: {
      server: "system", tool: "open_external",
      args: { url: String(url) },
      ...(expertId ? { expertId } : {}),
      ...(ticketId ? { ticketId } : {}),
    },
    mode: "A_url_query",
  };
}

/** 浏览器自动化：capability 命中的结构化动作 → 扩展 dispatch 形态。 */
export function toBrowserCall({ site, action, nodeId, params = {}, confidence = 1 } = {}) {
  const gate = actionGate({ site, action, confidence });
  if (!gate.allowed) return { ok: false, error: "gate-denied", gate };

  // 视觉档：只回决策，不生成任何坐标指令
  if (gate.channel === "vision") {
    const v = assertVisionDecisionOnly(params);
    if (!v.ok) return { ok: false, error: "vision-red-line", bad: v.bad };
    return {
      ok: true, channel: "browser_automation", mode: "vision_decision_only",
      decision: { escalate: true, from: gate.plan?.escalateFrom || "structured", ...params },
      gate, forbid: gate.deny,
    };
  }

  const spec = gate.plan || {};
  // 实证：wb_ext_027 的 dispatch 方法表无任何网络请求方法（无 fetch/http），
  // 所以 capability 里的 api 通道不能伪装成扩展指令 —— 交给宿主侧 hostDataApi 执行。
  if (gate.channel === "api") {
    const key = `${site}/${action}`;
    const spec = API_ENDPOINTS[key];
    if (!spec) {
      return {
        ok: false, error: "api-endpoint-not-implemented", key,
        reason: "该 api 动作尚未登记宿主端点，如实拒绝，不伪造成功",
      };
    }
    return {
      ok: true,
      channel: "host_data_api",
      mode: "structured_api_via_host",
      host: {
        endpoint: spec.url,
        via: "hostDataApi.fetchSiteData（宿主侧 GET，非扩展 dispatch）",
        call: { site, action, params: params || {} },
      },
      verify: spec.verify || null,
      gate,
      limitation: "扩展本身不提供网络方法，此通道由宿主侧 hostDataApi 承接（已实现）",
    };
  }

  if (gate.channel === "extract") {
    return {
      ok: true,
      channel: "browser_automation",
      mode: "structured_extract",
      dispatch: { method: "dom.extract", params: { ...params } },
      verify: spec.verify || "页面结构化字段回读非空",
      gate,
      limitation: "抽取在已打开页面内完成，零外发、零凭据、只读",
    };
  }

  let method;
  if (gate.channel === "url") method = "tab.goto";                 // background.js:1586 实证
  else method = "dom_cua.click";                                   // dom 定位，node_id 而非坐标

  const args = { ...params };
  // url 通道：capability 的 pattern 是 {kw}/{bvid} 模板，须渲染成真实 URL，否则 tab.goto 收不到 url
  if (method === "tab.goto") {
    if (spec.pattern) {
      const missing = [];
      const url = String(spec.pattern).replace(/\{(\w+)\}/g, (_, k) => {
        if (params[k] == null || params[k] === "") { missing.push(k); return ""; }
        return encodeURIComponent(String(params[k]));
      });
      if (missing.length) return { ok: false, error: "missing-url-param", missing };
      args.url = url;
      delete args.pattern;
    } else if (!args.url) {
      return { ok: false, error: "url-required", reason: "tab.goto 必须有 url" };
    }
    if (!/^https?:\/\//i.test(args.url)) return { ok: false, error: "protocol-gate" };
  }
  // dom 类动作强制 node_id；缺了就拒绝，不许退化成坐标点击
  if (method === "dom_cua.click") {
    if (!nodeId) return { ok: false, error: "node-id-required", reason: "禁止无 node_id 的点击（防退化成视觉点坐标）" };
    args.node_id = nodeId;
  }
  if (spec.selector) args.selector = spec.selector;
  if (spec.endpoint && gate.channel !== "api") args.endpoint = spec.endpoint;

  return {
    ok: true,
    channel: "browser_automation",
    mode: `structured_${gate.channel}`,
    dispatch: { method, params: args },
    verify: spec.verify || null,
    gate,
  };
}

/** 完整链路决策：代价路由 → 选通道 → 是否需独立复核 → 生成指令。 */
export function planExecution({ mode = "normal", task = {}, site, action, nodeId, url, confidence = 1 } = {}) {
  const route = routeByCost({ ...task, mode });
  const needsSeal = route === "team_seal" && isTierAEnabled(mode);
  const desktop = url ? toDesktopCall({ url, ticketId: task.ticketId }) : null;
  const browser = site && action
    ? toBrowserCall({ site, action, nodeId, confidence, params: task.params || {} })
    : null;

  const blockedReasons = [];
  if (desktop && !desktop.ok) blockedReasons.push(`desktop:${desktop.error}`);
  if (browser && !browser.ok) blockedReasons.push(`browser:${browser.error}`);

  return {
    mode, route, needsSeal, desktop, browser,
    ok: blockedReasons.length === 0,
    blockedReasons,
    sites: site && SITE_CAPABILITIES[site] ? SITE_CAPABILITIES[site].category : "通用兜底",
  };
}

/**
 * 真正执行 planExecution 的结果（当前只对 host_data_api 提供实现）。
 * 其余通道是"交给 ORB / 扩展执行"的指令形态，本函数不假装自己点得动。
 */
export async function runPlan(plan, { hostApi } = {}) {
  if (!plan || !plan.ok) return { ok: false, error: "bad-plan" };
  const results = [];
  if (plan.desktop) results.push({ channel: "software_automation", ready: plan.desktop.ok, call: plan.desktop });
  if (plan.browser) {
    const b = plan.browser;
    if (b.channel === "host_data_api") {
      if (!hostApi || typeof hostApi.fetchSiteData !== "function") {
        return { ok: false, error: "host-api-missing", reason: "api 通道需要 hostApi 实例" };
      }
      const r = await hostApi.fetchSiteData(b.host.call);
      results.push({ channel: "host_data_api", ready: r.ok, result: r });
      if (!r.ok) return { ok: false, error: r.code, results };
    } else {
      results.push({ channel: "browser_automation", ready: b.ok, call: b });
    }
  }
  return { ok: true, results };
}

export default { toDesktopCall, toBrowserCall, planExecution, runPlan };
