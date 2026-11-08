/* 影子路由观测 UI 的静态契约测试。
   panel.html 是内联脚本，不能直接 import，只能按文本契约校验。
   桥侧 action 名一律从 bridge.mjs 动态提取，绝不硬编码猜测的名字。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const panel = fs.readFileSync(path.join(root, 'desktop', 'panel.html'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'bridge.mjs'), 'utf8');

/* 从桥侧 /api/ops 的 switch 里抓真实 action 名，作为唯一可信来源。 */
const bridgeActions = new Set(
  [...bridge.matchAll(/case\s+"([A-Za-z0-9_.]+)"\s*:/g)].map((m) => m[1])
);

/* 只取本次新增的两块（HTML 卡片 + JS 逻辑），红线断言不误伤历史代码。 */
const addedBlocks = [...panel.matchAll(/SHADOW_OBSERVE_BEGIN([\s\S]*?)SHADOW_OBSERVE_END/g)].map((m) => m[1]);
const added = addedBlocks.join('\n');

/* 指标占位：<span ... id="shadowXxx">初始文本</span> */
const metricSpans = [...added.matchAll(/<span\b[^>]*\bid="(shadow[A-Za-z0-9]+)"[^>]*>([^<]*)<\/span>/g)];

test('① 存在 shadow 前缀卡片容器与至少 4 个指标占位', () => {
  assert.match(panel, /id="shadow[^"]*"/, '缺少 shadow 前缀的 DOM id');
  assert.match(panel, /id="shadowObserveCard"/, '缺少影子路由观测卡片容器');
  assert.ok(addedBlocks.length >= 2, '新增片段标记应至少覆盖 HTML 与 JS 两块');
  const placeholders = metricSpans.filter((m) => /—/.test(m[2]));
  assert.ok(placeholders.length >= 4, `指标占位不足 4 个，实际 ${placeholders.length}`);
});

test('② post(/api/ops) 用的 action 全部来自桥侧真实 action 集合', () => {
  assert.ok(bridgeActions.size > 10, '桥侧 action 提取失败（集合过小）');
  const used = [...added.matchAll(
    /post\(\s*['"]\/api\/ops['"][\s\S]{0,300}?\baction\s*:\s*['"]([^'"]+)['"]/g
  )].map((m) => m[1]);
  assert.ok(used.length > 0, '新增片段里没有 post(/api/ops) 取数或标注调用');
  for (const a of used) {
    assert.ok(bridgeActions.has(a), `action "${a}" 不存在于 bridge.mjs 的 case 列表`);
  }
});

test('③ 标注按钮调用真实 action 或明确显示「待接线」，二选一成立', () => {
  /* 不硬编码具体名字：从桥侧集合里找 recordHuman 系动作，再看面板是否真的 post 了它。 */
  const humanActions = [...bridgeActions].filter((a) => /recordHuman/i.test(a));
  const realWired = humanActions.some((a) => added.includes(a))
    && /post\(\s*['"]\/api\/ops['"]/.test(added);
  const pending = /待接线/.test(added) && /桥侧无入口/.test(added);
  assert.ok(realWired || pending,
    '标注既没接桥侧真实 action，也没标明「待接线（桥侧无入口）」');
});

test('④ 面板出现 maybeEscalateToVision 与新增计数标识符，且升级路径里有计数', () => {
  assert.match(panel, /function maybeEscalateToVision\s*\(/, '找不到 maybeEscalateToVision 定义');
  assert.match(panel, /shadowEscalateCount/, '缺少本会话 ESCALATE 累计标识符');
  const at = panel.indexOf('function maybeEscalateToVision');
  const fnBody = panel.slice(at, at + 1200);
  assert.match(fnBody, /shadowEscalateCount\s*\+\+/, '升级路径里没有加计数');
});

test('⑤ 红线：无 sub-1000ms 轮询、无 spawn/任务派发字样、指标占位不写死 0%', () => {
  assert.doesNotMatch(added, /setInterval\s*\([^)]*,\s*[0-9]{1,3}\s*\)/, '新增片段含 sub-1000ms 定时轮询');
  assert.doesNotMatch(added, /setInterval/, '新增片段不应另起定时器（须复用现有刷新节奏）');
  assert.doesNotMatch(added, /spawn|dispatch|派发|派单|planTask|runTask|submitTask/i, '新增片段含任务派发字样');
  assert.doesNotMatch(added, /0\s*%/, '新增片段把指标写死成 0%');
  for (const m of metricSpans) {
    assert.doesNotMatch(m[2], /0\s*%/, `指标 ${m[1]} 的占位写死了 0%`);
  }
});
