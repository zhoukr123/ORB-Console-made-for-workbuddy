/* V-13 / C-07 五项指标 + 降级阈值单测。
 * 锁住三条：① 缺样本不补零（null）；② 阈值判定可单测；③ 记录表按 (app|version|controlType) 聚合且失败模式如实累计。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  V13_METRICS, V13_THRESHOLDS, DANGER_LABEL_RE,
  computeTreeMetrics, evaluateMetric, createV13RecordingTable,
} from "../v13Metrics.mjs";

test("V13_METRICS 恰好五项，阈值齐备且都在 (0,1]", () => {
  const metrics = Object.values(V13_METRICS);
  assert.equal(metrics.length, 5);
  for (const m of metrics) {
    assert.ok(V13_THRESHOLDS[m] > 0 && V13_THRESHOLDS[m] <= 1, `${m} 阈值应在 (0,1]`);
  }
});

test("computeTreeMetrics：单次树只算 ②③⑤，①④ 需采样恒为 null（不补零）", () => {
  const r = computeTreeMetrics({ actionableNodes: 10, withAction: 8, withCoordinates: 10 },
    { treeText: 'button "确认删除"  [action: click]' });
  assert.equal(r[V13_METRICS.TREE_FETCH_SUCCESS], null);
  assert.equal(r[V13_METRICS.REF_STABILITY], null);
  assert.equal(r[V13_METRICS.PRE_POST_STATE_CHANGE], null);
  assert.equal(r[V13_METRICS.KEY_CONTROL_COVERAGE], 0.8);
  assert.equal(r[V13_METRICS.DANGER_CONFIRM_VISIBILITY], 1);
});

test("computeTreeMetrics：无危险确认元素 → 0；空树 → 覆盖 null 不编 1", () => {
  const r = computeTreeMetrics({ actionableNodes: 4, withAction: 4 }, { treeText: 'button "返回"' });
  assert.equal(r[V13_METRICS.DANGER_CONFIRM_VISIBILITY], 0);
  const empty = computeTreeMetrics({ actionableNodes: 0, withAction: 0 }, { treeText: "" });
  assert.equal(empty[V13_METRICS.KEY_CONTROL_COVERAGE], null);
  assert.equal(empty[V13_METRICS.DANGER_CONFIRM_VISIBILITY], null);
});

test("DANGER_LABEL_RE 覆盖中英破坏性确认词", () => {
  for (const s of ["删除", "永久删除", "确认", "清空回收站", "Delete", "format", "purge"]) assert.match(s, DANGER_LABEL_RE);
  assert.doesNotMatch("返回", DANGER_LABEL_RE);
});

test("evaluateMetric：pass / fail / undetermined 三态，null 绝不误判为通过", () => {
  assert.equal(evaluateMetric(V13_METRICS.KEY_CONTROL_COVERAGE, 0.9).status, "pass");
  assert.equal(evaluateMetric(V13_METRICS.KEY_CONTROL_COVERAGE, 0.5).status, "fail");
  assert.equal(evaluateMetric(V13_METRICS.REF_STABILITY, null).status, "undetermined");
});

test("记录表：按 (app|version|controlType) 聚合，跨采样指标有样本才出数", () => {
  const t = createV13RecordingTable();
  t.record({ app: "电子应用A", version: "1.2", controlType: "Button", treeFetched: true, refStable: true, prePostChanged: false, mode: "auto" });
  t.record({ app: "电子应用A", version: "1.2", controlType: "Button", treeFetched: false, refStable: true, prePostChanged: true, mode: "auto", failureMode: "SNAPSHOT_MISMATCH" });
  t.attachTreeMetrics("电子应用A", "1.2", "Button",
    computeTreeMetrics({ actionableNodes: 10, withAction: 7 }, { treeText: 'btn "确认"' }));
  assert.equal(t.size(), 1, "同 app|version|controlType 应合并为一行");
  const [row] = t.evaluate();
  assert.equal(row.samples, 2);
  assert.equal(row.metrics[V13_METRICS.TREE_FETCH_SUCCESS], 0.5, "1/2 快照成功");
  assert.equal(row.metrics[V13_METRICS.REF_STABILITY], 1);
  assert.equal(row.metrics[V13_METRICS.PRE_POST_STATE_CHANGE], 0.5);
  assert.equal(row.metrics[V13_METRICS.KEY_CONTROL_COVERAGE], 0.7);
});

test("记录表 verdict：任一项低于阈值判 degrade，reasons 指名道姓", () => {
  const t = createV13RecordingTable();
  t.record({ app: "E", version: "1", controlType: "Pane", treeFetched: false, refStable: false, prePostChanged: false, mode: "manual", failureMode: "PLATFORM_NOT_SUPPORTED" });
  t.attachTreeMetrics("E", "1", "Pane", computeTreeMetrics({ actionableNodes: 10, withAction: 2 }, { treeText: 'pane "x"' }));
  const [row] = t.evaluate();
  assert.equal(row.verdict, "degrade");
  assert.ok(row.reasons.some((r) => r.includes("treeFetchSuccessRate")));
  assert.ok(row.reasons.some((r) => r.includes("keyControlCoverage")));
  assert.equal(row.topFailures[0].mode, "PLATFORM_NOT_SUPPORTED");
});

test("记录表 verdict：全部达标判 ok，undetermined 不算 fail", () => {
  const t = createV13RecordingTable();
  t.record({ app: "E", version: "1", controlType: "Button", treeFetched: true, refStable: true, prePostChanged: true, mode: "auto" });
  t.attachTreeMetrics("E", "1", "Button", computeTreeMetrics({ actionableNodes: 10, withAction: 10 }, { treeText: 'btn "删除"' }));
  const [row] = t.evaluate();
  assert.equal(row.verdict, "ok");
  assert.deepEqual(row.reasons, []);
});
