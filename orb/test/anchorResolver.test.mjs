/* 确定性锚定解析单测（方案 A1 / B 的护栏）。
 * 覆盖：① 三档坐标锚定（text/window/absolute/none）行为不变；
 *       ② 控件树解析 + 结构化选择器生成 + 重抓树匹配（A1 核心）；
 *       ③ 机器可读错误分类（B 核心）。
 * 全部用 mock deps，不碰真实桌面 / OCR / Windows API。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ANCHORABLE, primaryPoint, addDeltaToArgs, classifyActionError, decideEscalation, ACTION_ERROR_CODES,
  parseSnapshotTree, buildTreeSelector, matchTreeNode, pruneSnapshotTree, resolveTreeNode, preferSnapshotRef, createAnchorResolver, createTreeCache,
  normalizeElementRef, ELEMENT_BACKENDS, treeFingerprint, verifyEffect,
} from "../anchorResolver.mjs";

/* 一段贴近 windows-mcp 真实输出的 Snapshot 文本样例。 */
const SAMPLE = [
  "desktop",
  "├── window \"记事本\"",
  "│   ├── Pane \"工具栏\"",
  "│   │   ├── 100,200 Button \"保存\"",
  "│   │   └── 300,200 Button \"打开\"",
  "│   └── 500,500 Edit \"文本区\"",
  "└── window \"计算器\"",
  "    ├── 800,800 Button \"1\"",
  "    └── 820,800 Button \"+\"",
].join("\n");

/* ---------------- ① 现有三档行为基线 ---------------- */
test("primaryPoint 取主坐标：loc 优先于 x,y", () => {
  assert.deepEqual(primaryPoint({ args: { loc: [10, 20] } }), [10, 20]);
  assert.deepEqual(primaryPoint({ args: { x: 3, y: 4 } }), [3, 4]);
  assert.equal(primaryPoint({ args: {} }), null);
});

test("addDeltaToArgs 同时作用于 loc / x,y / 拖动 x2,y2", () => {
  const a = { loc: [1, 1], x: 2, y: 3, x2: 4, y2: 5 };
  addDeltaToArgs(a, 10, -2);
  assert.deepEqual(a, { loc: [11, -1], x: 12, y: 1, x2: 14, y2: 3 });
});

test("resolveAnchor：②文字锚定命中 → conf=text", async () => {
  const r = createAnchorResolver({
    anchorByText: () => ({ x: 111, y: 222 }),
    findWinRectByTitle: () => [0, 0, 800, 600],
  });
  const out = await r({ server: "windows", tool: "Click", args: { loc: [1, 1], anchor: "确定" }, win: { title: "X", off: [1, 1] } });
  assert.equal(out.conf, "text");
  assert.deepEqual(out.args.loc, [111, 222]);
  assert.ok(!("anchor" in out.args));
});

test("resolveAnchor：③窗口相对命中 → conf=window", async () => {
  const r = createAnchorResolver({
    anchorByText: () => null,
    findWinRectByTitle: () => [100, 50, 800, 600],
  });
  const out = await r({ server: "windows", tool: "Click", args: { loc: [1, 1] }, win: { title: "X", off: [10, 20] } });
  assert.equal(out.conf, "window");
  assert.deepEqual(out.args.loc, [100 + 10, 50 + 20]);
});

test("resolveAnchor：④既无锚点又无窗口 → conf=none（正常录制路径）", async () => {
  const r = createAnchorResolver({ anchorByText: () => null, findWinRectByTitle: () => null });
  const out = await r({ server: "windows", tool: "Click", args: { loc: [5, 6] } });
  assert.equal(out.conf, "none");
  assert.deepEqual(out.args.loc, [5, 6]);
});

test("resolveAnchor：④有锚点但全失手 → conf=absolute（真降级，应触发视觉升级）", async () => {
  const r = createAnchorResolver({ anchorByText: () => null, findWinRectByTitle: () => null });
  const out = await r({ server: "windows", tool: "Click", args: { loc: [5, 6], anchor: "确定" } });
  assert.equal(out.conf, "absolute");
});

test("resolveAnchor：非锚定工具直接走坐标兜底，不调任何解析器", async () => {
  let textCalled = false, treeCalled = false;
  const r = createAnchorResolver({
    anchorByText: () => { textCalled = true; return null; },
    anchorByTree: () => { treeCalled = true; return null; },
    findWinRectByTitle: () => null,
  });
  const out = await r({ server: "windows", tool: "Keyboard", args: { text: "a" } });
  assert.equal(out.conf, "none");
  assert.equal(textCalled, false);
  assert.equal(treeCalled, false);
});

/* ---------------- ② 方案 A1：控件树结构化锚定 ---------------- */
test("parseSnapshotTree：还原层级与坐标（缩进 / 窗口名透传）", () => {
  const root = parseSnapshotTree(SAMPLE);
  assert.equal(root.elementType, "desktop");
  // 两个窗口
  const wins = root.children.filter((c) => c.elementType === "window");
  assert.equal(wins.length, 2);
  const notepad = wins.find((w) => w.name === "记事本");
  assert.equal(notepad.windowName, "记事本");
  // 记事本下的「保存」按钮：windowName 应从父窗口透传
  const save = notepad.children.flatMap((c) => c.children).find((n) => n.name === "保存");
  assert.ok(save, "应找到『保存』按钮");
  assert.equal(save.elementType, "interactive");
  assert.equal(save.windowName, "记事本");
  assert.deepEqual([save.x, save.y], [100, 200]);
});

/* ---------------- ⑤ 方案 C：控件树裁剪 ---------------- */
test("pruneSnapshotTree：交互/窗口全保留，纯结构叶子被丢弃", () => {
  const root = parseSnapshotTree(SAMPLE);
  const pruned = pruneSnapshotTree(root);
  // 全部交互节点原样保留
  const inter = [];
  (function walk(n) { (n.children || []).forEach((c) => { if (c.elementType === "interactive") inter.push(c); walk(c); }); })(pruned);
  assert.equal(inter.length, 5, "保存/打开/文本区/1/+ 全部保留");
  // 窗口保留
  assert.equal(pruned.children.filter((c) => c.elementType === "window").length, 2);
  // 工具栏 Pane 有交互后代 → 保留
  const tool = pruned.children[0].children.find((c) => c.name === "工具栏");
  assert.ok(tool, "有交互后代的结构节点应保留");
});

test("pruneSnapshotTree：无交互后代的纯结构叶子被砍掉", () => {
  const s = ["desktop", "├── window \"X\"", "│   ├── Pane \"空容器\"", "│   └── 100,100 Button \"确定\""].join("\n");
  const pruned = pruneSnapshotTree(parseSnapshotTree(s));
  const win = pruned.children[0];
  assert.equal(win.name, "X");
  // 空容器 Pane 无交互后代 → 不在裁剪后的树里
  assert.equal(win.children.length, 1);
  assert.equal(win.children[0].name, "确定");
});

test("pruneSnapshotTree：裁剪后锚定结果不变（行为零变化）", () => {
  const root = parseSnapshotTree(SAMPLE);
  const pruned = pruneSnapshotTree(root);
  const sel = buildTreeSelector(root, 100, 200, "记事本");
  const hitFull = matchTreeNode(root, sel);
  const hitPruned = matchTreeNode(pruned, sel);
  assert.ok(hitFull && hitPruned);
  assert.deepEqual([hitFull.x, hitFull.y], [hitPruned.x, hitPruned.y]);
});

/* ---------------- ⑥ 方案 E：Agent 工具策略（结构化优先于视觉） ---------------- */
test("preferSnapshotRef：验证码/画布/图片类一律走视觉", () => {
  for (const t of ["输入验证码", "drag the captcha slider", "识别这张图片里的字", "在画布 canvas 上画一条线"]) {
    const r = preferSnapshotRef(t, { hasTree: true });
    assert.equal(r.mode, "vision", t);
  }
});

test("preferSnapshotRef：有稳定控件树 → 优先结构化（即便 hasTree 为真）", () => {
  const r = preferSnapshotRef("点击保存按钮", { hasTree: true });
  assert.equal(r.mode, "structured");
});

test("preferSnapshotRef：无控件树且非视觉任务 → 退回视觉兜底", () => {
  const r = preferSnapshotRef("点击保存按钮", { hasTree: false });
  assert.equal(r.mode, "vision");
  assert.match(r.reason, /退回视觉/);
});

/* ---------------- ⑦ 录制即定身份（treeRef 优先 + 旧方案兜底） ---------------- */
test("resolveTreeNode：录制期 treeRef 优先，坐标不准也能命中", () => {
  const root = parseSnapshotTree(SAMPLE);
  const sel = buildTreeSelector(root, 100, 200, "记事本");
  // 录制坐标故意给到很远的地方，证明命中靠 treeRef 而不是坐标
  const hit = resolveTreeNode(root, { treeRef: sel.sig, args: { loc: [9999, 9999] } });
  assert.ok(hit);
  assert.deepEqual([hit.x, hit.y], [100, 200]);
});

test("resolveTreeNode：treeRef 改名失效 → 回退旧方案（按坐标重定位）", () => {
  const root = parseSnapshotTree(SAMPLE);
  const hit = resolveTreeNode(root, { treeRef: "window|X > Button|不存在的按钮", args: { loc: [300, 200] } });
  assert.ok(hit, "旧方案兜底应命中 300,200 附近的『打开』");
  assert.deepEqual([hit.x, hit.y], [300, 200]);
});

test("resolveTreeNode：无 treeRef → 走旧方案（坐标重建选择器）", () => {
  const root = parseSnapshotTree(SAMPLE);
  const hit = resolveTreeNode(root, { args: { loc: [500, 500] } });
  assert.ok(hit);
  assert.deepEqual([hit.x, hit.y], [500, 500]);
});

test("resolveTreeNode：无根 / 无坐标 → null（不硬匹配）", () => {
  assert.equal(resolveTreeNode(null, { args: { loc: [1, 1] } }), null);
  assert.equal(resolveTreeNode(parseSnapshotTree(SAMPLE), { args: {} }), null);
});

test("buildTreeSelector：点中心附近 → 生成稳定 sig（含 window + 祖先路径）", () => {
  const root = parseSnapshotTree(SAMPLE);
  const sel = buildTreeSelector(root, 102, 198, "记事本");
  assert.ok(sel, "应匹配到『保存』附近节点");
  assert.equal(sel.name, "保存");
  assert.equal(sel.windowName, "记事本");
  // sig 必须包含 window 名与祖先 structural 的 controlType|name
  assert.ok(sel.sig.includes("记事本"));
  assert.ok(sel.sig.includes("Pane|工具栏"));
  assert.ok(sel.sig.includes("Button|保存"));
  assert.ok(sel.sig.startsWith("记事本 > "));
});

test("buildTreeSelector：偏离超过阈值 → 返回 null（宁可回退坐标，不硬匹配）", () => {
  const root = parseSnapshotTree(SAMPLE);
  assert.equal(buildTreeSelector(root, 9000, 9000, "记事本"), null);
});

test("matchTreeNode：同一棵树 + sig → 命中当前中心坐标", () => {
  const root = parseSnapshotTree(SAMPLE);
  const sel = buildTreeSelector(root, 102, 198, "记事本");
  const hit = matchTreeNode(root, sel);
  assert.ok(hit);
  assert.deepEqual([hit.x, hit.y], [100, 200]);
  assert.equal(hit.ref, sel.sig);
});

test("matchTreeNode：窗口被拖动后中心变了，但只要 sig 还在就仍命中（抗迁移）", () => {
  // 模拟重抓：窗口整体右移 +500，但结构与名字不变
  const moved = SAMPLE.replace("100,200 Button \"保存\"", "600,200 Button \"保存\"")
                       .replace("300,200 Button \"打开\"", "800,200 Button \"打开\"");
  const root2 = parseSnapshotTree(moved);
  const sel = buildTreeSelector(parseSnapshotTree(SAMPLE), 102, 198, "记事本");
  const hit = matchTreeNode(root2, sel);
  assert.ok(hit, "结构不变应仍能定位");
  assert.deepEqual([hit.x, hit.y], [600, 200]); // 用新坐标，不是旧的 100
});

test("matchTreeNode：结构变了（按钮改名） → 返回 null（绝不近似）", () => {
  const changed = SAMPLE.replace("Button \"保存\"", "Button \"另存为\"");
  const root2 = parseSnapshotTree(changed);
  const sel = buildTreeSelector(parseSnapshotTree(SAMPLE), 102, 198, "记事本");
  assert.equal(matchTreeNode(root2, sel), null);
});

test("resolveAnchor：①树锚定命中 → conf=tree，且不调用 OCR", async () => {
  const captured = { step: null };
  const r = createAnchorResolver({
    anchorByTree: (step) => { captured.step = step; return { x: 640, y: 480, ref: "记事本 > Pane|工具栏 > Button|保存" }; },
    anchorByText: () => { throw new Error("OCR 不应被调用"); },
    findWinRectByTitle: () => null,
  });
  const out = await r({ server: "windows", tool: "Click", args: { loc: [1, 1], anchor: "保存" }, win: { title: "记事本", off: [1, 1] } });
  assert.equal(out.conf, "tree");
  assert.deepEqual(out.args.loc, [640, 480]);
  assert.equal(out.ref, "记事本 > Pane|工具栏 > Button|保存");
});

test("resolveAnchor：树锚定失败 → 自动落到文字/坐标档（不阻断）", async () => {
  const r = createAnchorResolver({
    anchorByTree: () => null,
    anchorByText: () => ({ x: 11, y: 22 }),
    findWinRectByTitle: () => null,
  });
  const out = await r({ server: "windows", tool: "Click", args: { loc: [1, 1], anchor: "确定" }, win: { title: "X", off: [1, 1] } });
  assert.equal(out.conf, "text"); // 树失败后走到 OCR
});

/* ---------------- ③ 方案 B：机器可读错误分类 ---------------- */
test("classifyActionError：按错误文本归到稳定 code", () => {
  assert.equal(classifyActionError("Access is denied (EACCES)"), ACTION_ERROR_CODES.PERM_DENIED);
  assert.equal(classifyActionError("窗口 未找到，无法点击"), ACTION_ERROR_CODES.WINDOW_GONE);
  assert.equal(classifyActionError("multiple controls match 确定"), ACTION_ERROR_CODES.AMBIGUOUS_TARGET);
  assert.equal(classifyActionError("element not found: stale ref"), ACTION_ERROR_CODES.STALE_REF);
  assert.equal(classifyActionError(""), ACTION_ERROR_CODES.UNKNOWN);
  assert.equal(classifyActionError("some weird failure"), ACTION_ERROR_CODES.UNKNOWN);
});

test("classifyActionError：带 ref 却失败、且不是明确类别 → 默认 STALE_REF", () => {
  assert.equal(classifyActionError("click failed", { hadRef: true }), ACTION_ERROR_CODES.STALE_REF);
  // 不带 ref 的未知失败保持 UNKNOWN（不误伤为可重试）
  assert.equal(classifyActionError("click failed", { hadRef: false }), ACTION_ERROR_CODES.UNKNOWN);
});

/* ---------------- ④ 方案 B：错误码 → 升级处置映射 ---------------- */
test("decideEscalation：PERM_DENIED 永远硬停，不升级视觉", () => {
  for (const esc of ["off", "stop", "once", "agent"]) {
    assert.equal(decideEscalation(ACTION_ERROR_CODES.PERM_DENIED, { escalate: esc }), "hard-stop");
  }
});

test("decideEscalation：可恢复码 + escalate∈{agent,once} → takeover（含 UNKNOWN）", () => {
  for (const code of [ACTION_ERROR_CODES.STALE_REF, ACTION_ERROR_CODES.WINDOW_GONE,
                      ACTION_ERROR_CODES.AMBIGUOUS_TARGET, ACTION_ERROR_CODES.UNKNOWN]) {
    assert.equal(decideEscalation(code, { escalate: "agent" }), "takeover");
    assert.equal(decideEscalation(code, { escalate: "once" }), "takeover");
  }
});

test("decideEscalation：off/stop 且非权限错误 → 原样抛出（throw）", () => {
  for (const code of [ACTION_ERROR_CODES.STALE_REF, ACTION_ERROR_CODES.WINDOW_GONE,
                      ACTION_ERROR_CODES.AMBIGUOUS_TARGET, ACTION_ERROR_CODES.UNKNOWN]) {
    assert.equal(decideEscalation(code, { escalate: "off" }), "throw");
    assert.equal(decideEscalation(code, { escalate: "stop" }), "throw");
  }
});

test("runNode 失败路径：真实工具错误按 code 走对处置（策略映射自洽）", () => {
  // 仅验证「分类→决策」链路自洽，不依赖真实桌面：
  //   PERM_DENIED + agent  → hard-stop（绝不重试视觉）
  //   STALE_REF  + once    → takeover（交接管层）
  //   UNKNOWN    + off     → throw（原样上抛）
  assert.equal(decideEscalation(classifyActionError("Access is denied (EACCES)"), { escalate: "agent" }), "hard-stop");
  assert.equal(decideEscalation(classifyActionError("element not found: stale ref"), { escalate: "once" }), "takeover");
  assert.equal(decideEscalation(classifyActionError("some weird failure"), { escalate: "off" }), "throw");
});

test("ANCHORABLE 含既有单点/区域动作，不含键盘", () => {
  for (const t of ["windows|Click", "windows|Move", "orb|long_press", "orb|scroll_at"]) assert.ok(ANCHORABLE.has(t), t);
  assert.ok(!ANCHORABLE.has("windows|Keyboard"));
});

// ── 控件树抓取短时复用（性能优化，纯函数可单测）──
test("createTreeCache：未写入 / 过期 → get 返回 null（绝不误命中陈旧树）", () => {
  const c = createTreeCache(300);
  assert.equal(c.get(1000), null, "没 set 过应返回 null");
  c.set("tree-A", 1000);
  assert.equal(c.get(1250), "tree-A", "窗口内应命中");
  assert.equal(c.get(1301), null, "超过 300ms 应作废，避免 stale 误命中");
});

test("createTreeCache：set 新值覆盖旧值，窗口从新值起算", () => {
  const c = createTreeCache(300);
  c.set("old", 1000);
  c.set("new", 1200);
  assert.equal(c.get(1499), "new");      // 距 new 仅 299ms
  assert.equal(c.get(1501), null);       // 距 new 超 300ms → 作废
});

test("createTreeCache：clear 立即使后续 get 返回 null", () => {
  const c = createTreeCache(300);
  c.set("tree", 1000);
  assert.equal(c.get(1100), "tree");
  c.clear();
  assert.equal(c.get(1101), null);
});

// ── D 地基：统一 ElementRef schema ──
test("normalizeElementRef：坐标非法→null；合法→统一 schema", () => {
  assert.equal(normalizeElementRef({ x: NaN, y: 1 }, "tree"), null);
  const r = normalizeElementRef({ x: 10, y: 20, ref: "sig", score: 0.9 }, "visual");
  assert.deepEqual(r, { x: 10, y: 20, backend: "visual", ref: "sig", score: 0.9 });
});

test("ELEMENT_BACKENDS：顺序即优先级，tree 最前、absolute 最后", () => {
  const names = ELEMENT_BACKENDS.map((b) => b.name);
  assert.equal(names[0], "tree");
  assert.equal(names[names.length - 1], "absolute");
  assert.ok(names.includes("visual"));
});

test("resolveAnchor：各后端命中都带统一 element（backend 正确）", async () => {
  let r = createAnchorResolver({ anchorByTree: async () => ({ x: 1, y: 2, ref: "S" }), anchorByText: () => null });
  let out = await r({ server: "windows", tool: "Click", args: { loc: [0, 0] } });
  assert.equal(out.conf, "tree");
  assert.equal(out.element.backend, "tree");
  assert.deepEqual([out.element.x, out.element.y], [1, 2]);

  r = createAnchorResolver({ anchorByText: async () => ({ x: 3, y: 4 }), findWinRectByTitle: () => null });
  out = await r({ server: "windows", tool: "Click", args: { loc: [0, 0], anchor: "保存" } });
  assert.equal(out.conf, "text");
  assert.equal(out.element.backend, "text");

  r = createAnchorResolver({ anchorByText: () => null, anchorByVisual: async () => ({ x: 5, y: 6, ref: "visual:template", score: 0.9 }), findWinRectByTitle: () => null });
  out = await r({ server: "windows", tool: "Click", args: { loc: [0, 0] } });
  assert.equal(out.conf, "visual");
  assert.equal(out.element.backend, "visual");
  assert.equal(out.element.score, 0.9);

  r = createAnchorResolver({ anchorByText: () => null, findWinRectByTitle: () => null });
  out = await r({ server: "windows", tool: "Click", args: { loc: [7, 8], anchor: "x" } });
  assert.equal(out.conf, "absolute");
  assert.equal(out.element.backend, "absolute");
  assert.deepEqual([out.element.x, out.element.y], [7, 8]);
});

// ── E：verify 环（纯函数）──
test("treeFingerprint：同树同指纹、异树异指纹", () => {
  const a = "desktop\n├── window \"记事本\"\n│   └── 100,200 Button \"保存\"";
  const b = "desktop\n├── window \"记事本\"\n│   └── 100,200 Button \"另存为\"";
  assert.equal(treeFingerprint(a), treeFingerprint(a));
  assert.notEqual(treeFingerprint(a), treeFingerprint(b));
});

test("verifyEffect：变→生效、未变且 mutating→未生效、只读/无 after→不误判", () => {
  const a = "desktop\n├── window \"W\"\n│   └── 100,200 Button \"A\"";
  const b = "desktop\n├── window \"W\"\n│   └── 100,200 Button \"B\"";
  assert.equal(verifyEffect({ beforeText: a, afterText: b, mutating: true }).ok, true);
  const same = verifyEffect({ beforeText: a, afterText: a, mutating: true });
  assert.equal(same.ok, false);
  assert.equal(same.changed, false);
  assert.equal(verifyEffect({ beforeText: a, afterText: a, mutating: false }).ok, true);
  assert.equal(verifyEffect({ beforeText: a, afterText: "", mutating: true }).ok, true);
});
