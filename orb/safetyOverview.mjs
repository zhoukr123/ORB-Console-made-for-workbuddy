/**
 * 安全子菜单的只读概览。
 *
 * 用户要求这一块「只展示状态，不放任何数值」：不放百分比、不放次数、不放秒数，
 * 也不放任何可调参数控件。所以这里把治理层的计数器统一翻译成状态词，
 * 并且**返回值里不允许出现 number / boolean**——单测会递归检查这一点。
 * 面板只做 textContent，连图标都不摆，版面压到最窄。
 *
 * 数据来源全是内存计数器，零 IO、零子进程，切到安全页时读一次即可。
 */
const txt = (v) => String(v ?? "").trim();
const has = (v) => !!v;

export function safetyOverview(src = {}) {
  const o = src && typeof src === "object" ? src : {};
  const team = o.team || {};
  const affect = o.affect || {};
  const review = o.lastReview || null;
  const plugins = Array.isArray(o.plugins) ? o.plugins : [];
  const tiers = o.tiers || {};
  const tierId = txt(o.tier || "standard");

  /* 审查命中率：只回答「有没有命中」，不显示百分比。 */
  let hitRateText = "暂无记录";
  if (review && typeof review === "object") {
    const kept = review.counts && review.counts.kept;
    hitRateText = has(kept) ? "有命中" : "无命中";
  } else if (has(team.reviews)) {
    hitRateText = "已完成审查";
  }

  /* 被抑制候选数：只看有没有，不显示个数。 */
  const suppressed = has(affect.blocked)
    || !!(review && review.counts && review.counts.rejected);
  const suppressedText = suppressed ? "有" : "无";

  /* 熔断记录：门控的 burst 拦截即一次熔断。 */
  const byGate = affect.byGate || {};
  const breakerText = has(byGate.burst) ? "有记录" : "无记录";

  const tier = tiers[tierId] || null;
  const tierText = tier ? txt(tier.name) : "标准";

  const pluginRows = plugins.map((p) => ({
    name: txt(p.name || p.id || "未命名插件"),
    enabledText: p.enabled === false ? "停用" : "启用",
  }));

  return {
    enabledText: o.reviewAuto === false ? "关闭" : "开启",
    hitRateText,
    suppressedText,
    breakerText,
    tierText,
    plugins: pluginRows,
  };
}

/** 递归检查「没有任何数值/布尔」——供单测与调用方自检。 */
export function containsNumeric(v) {
  if (typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.some(containsNumeric);
  if (v && typeof v === "object") return Object.values(v).some(containsNumeric);
  return false;
}

/** 面板直接用的标签顺序，避免前端再抄一份字段名。 */
export const OVERVIEW_LABELS = Object.freeze([
  Object.freeze({ key: "enabledText", label: "当前是否开启" }),
  Object.freeze({ key: "hitRateText", label: "审查命中率" }),
  Object.freeze({ key: "suppressedText", label: "被抑制候选数" }),
  Object.freeze({ key: "breakerText", label: "熔断记录" }),
  Object.freeze({ key: "tierText", label: "当前档位" }),
]);

export default { safetyOverview, containsNumeric, OVERVIEW_LABELS };
