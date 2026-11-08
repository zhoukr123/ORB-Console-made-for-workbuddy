/* 安全子菜单只读概览：只出状态词，一个数值/布尔都不许漏到界面上。 */
import test from "node:test";
import assert from "node:assert/strict";
import { safetyOverview, containsNumeric, OVERVIEW_LABELS } from "../safetyOverview.mjs";

const TIERS = {
  quiet: { name: "安静" }, standard: { name: "标准" }, prompt: { name: "及时" },
};

test("六项展示齐全，字段名与面板标签顺序一致", () => {
  const v = safetyOverview({ tiers: TIERS });
  assert.deepEqual(Object.keys(v), ["enabledText", "hitRateText", "suppressedText", "breakerText", "tierText", "plugins"]);
  assert.deepEqual(OVERVIEW_LABELS.map((x) => x.label),
    ["当前是否开启", "审查命中率", "被抑制候选数", "熔断记录", "当前档位"]);
  for (const { key } of OVERVIEW_LABELS) assert.equal(typeof v[key], "string");
});

test("任何输入下都不泄漏数值或布尔（用户明确要求不放任何数值）", () => {
  const cases = [
    {},
    { reviewAuto: true, team: { reviews: 12 }, affect: { blocked: 7, byGate: { burst: 3 } }, lastReview: { counts: { kept: 4, rejected: 2 } }, tier: "quiet", tiers: TIERS, plugins: [{ name: "正则流水线", enabled: true }] },
    { reviewAuto: false, affect: { blocked: 0, byGate: {} }, tier: "prompt", tiers: TIERS, plugins: [{ name: "二维码", enabled: false }] },
    { team: null, affect: null, plugins: null, tiers: null },
  ];
  for (const c of cases) {
    const v = safetyOverview(c);
    assert.equal(containsNumeric(v), false, JSON.stringify(v));
    assert.ok(!/\d/.test(JSON.stringify(v)), "连字符串里也不该出现数字: " + JSON.stringify(v));
  }
});

test("审查命中率 / 被抑制候选 / 熔断记录都翻译成状态词", () => {
  const v = safetyOverview({
    reviewAuto: true,
    team: { reviews: 3 },
    affect: { blocked: 2, byGate: { burst: 1 } },
    lastReview: { counts: { kept: 1, rejected: 2 } },
    tier: "quiet", tiers: TIERS,
  });
  assert.equal(v.enabledText, "开启");
  assert.equal(v.hitRateText, "有命中");
  assert.equal(v.suppressedText, "有");
  assert.equal(v.breakerText, "有记录");
  assert.equal(v.tierText, "安静");
});

test("没有记录时如实写「暂无记录 / 无 / 无记录」，不补零", () => {
  const v = safetyOverview({ reviewAuto: false, tiers: TIERS });
  assert.equal(v.enabledText, "关闭");
  assert.equal(v.hitRateText, "暂无记录");
  assert.equal(v.suppressedText, "无");
  assert.equal(v.breakerText, "无记录");
  assert.equal(v.tierText, "标准");
  assert.deepEqual(v.plugins, []);
});

test("插件启停清单只有名字和「启用/停用」", () => {
  const v = safetyOverview({
    tiers: TIERS,
    plugins: [{ name: "正则流水线", enabled: true }, { name: "二维码", enabled: false }],
  });
  assert.deepEqual(v.plugins, [
    { name: "正则流水线", enabledText: "启用" },
    { name: "二维码", enabledText: "停用" },
  ]);
});

test("containsNumeric 能抓到嵌套里的数字/布尔", () => {
  assert.equal(containsNumeric({ a: "x" }), false);
  assert.equal(containsNumeric({ a: [{ b: "x" }] }), false);
  assert.equal(containsNumeric({ a: { b: 1 } }), true);
  assert.equal(containsNumeric({ a: true }), true);
});
