/* V-13 实机 UIA 探针分析器单测：锁住「不补零、不编数」的诚实口径。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeUiTree, toMarkdown } from "../tools/v13-uia-probe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = "D:/WorkBuddy 附属文件夹/项目记录/2026-09-28-00-45-13/落地/V-13实机UIA快照-2026-11-07.txt";

const SAMPLE = `UI Tree:
desktop
├── window "任务栏"
│   └── 窗格 "任务栏"
│       ├── (10,20) 按钮 "确定"  [action: click]
│       └── (30,40) 按钮 "确定"  [action: click]
├── window ""
└── window "设置"
`;

test("能从树里数出窗口 / 匿名窗口 / 可操作控件", () => {
  const r = analyzeUiTree(SAMPLE);
  assert.equal(r.coverage.windowCount, 3);
  assert.equal(r.coverage.namedWindows, 2);
  assert.equal(r.coverage.anonymousWindows, 1);
  assert.equal(r.coverage.actionableNodes, 2);
  assert.equal(r.coverage.withCoordinates, 2);
  assert.equal(r.coverage.withAction, 2);
  assert.equal(r.coverage.namedRatio, 0.667);
});

test("同名标签触发 AMBIGUOUS_TARGET 风险，要求 ref 绑定", () => {
  const r = analyzeUiTree(SAMPLE);
  assert.deepEqual(r.ambiguousLabels, [{ label: "确定", n: 2 }]);
  assert.equal(r.refBindingNeeded, true);
});

test("耗时缺省为 null，不补零；显式给值时才回填", () => {
  assert.equal(analyzeUiTree(SAMPLE).elapsedMs, null);
  assert.equal(analyzeUiTree(SAMPLE, { elapsedMs: 123 }).elapsedMs, 123);
  assert.equal(analyzeUiTree(SAMPLE, { elapsedMs: NaN }).elapsedMs, null);
});

test("空树不崩、不生成假分数", () => {
  const r = analyzeUiTree("UI Tree:\n");
  assert.equal(r.coverage.windowCount, 0);
  assert.equal(r.coverage.namedRatio, null);
  assert.equal(r.coverage.actionableNodes, 0);
});

test("Markdown 报告如实写出「未取得精确毫秒值」，不写 0 ms", () => {
  const md = toMarkdown(analyzeUiTree(SAMPLE));
  assert.match(md, /未取得精确毫秒值/);
  assert.ok(!md.includes("0 ms"));
  assert.match(md, /匿名窗口/);
});

test("真实快照存档存在且分析结果是实证而非占位", () => {
  if (!fs.existsSync(SNAP)) return; // 快照是本机产物，换机器允许缺失
  const r = analyzeUiTree(fs.readFileSync(SNAP, "utf8"));
  assert.ok(r.coverage.windowCount >= 10, "真实树至少应有 10 个窗口节点");
  assert.ok(r.coverage.actionableNodes >= 20, "任务栏应能取到 20+ 个可操作控件");
  assert.ok(r.coverage.anonymousWindows > 0, "真实桌面必然有匿名窗口，这正是 ref 绑定的必要性证据");
  assert.equal(r.refBindingNeeded, true);
  assert.equal(r.elapsedMs, null, "没拿到精确耗时就必须留 null");
});

test("分析器不碰桌面：源码里没有任何点击 / 截图 / 子进程调用", () => {
  const src = fs.readFileSync(path.join(ROOT, "tools/v13-uia-probe.mjs"), "utf8");
  assert.ok(!/child_process|spawn\(|execFile\(/.test(src));
  assert.ok(!/screenshot|Click\(|clickAt|mouse_press/.test(src));
});
