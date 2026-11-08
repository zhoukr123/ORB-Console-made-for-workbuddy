/* ---------------- 回放前预检（wfPreflight） ----------------
 *
 * 为什么要这个：桌面动作不可逆。等真跑到第 5 步才发现锚点失效，前 4 步已经点完了 ——
 * 这是最贵的一类失败。预检把「哪几步可能失效」提前到动手之前说清楚。
 *
 * 对标与**诚实的边界**（不写清楚就是假装）：
 *   · Playwright 的 actionability 有四类检查 —— Visible / Stable / Receives Events /
 *     Enabled，而且是在**每个动作之前**实时检查，不是开局查一次。
 *   · 我们一次快照最多只能做「元素能否解析到」（≈ Playwright 的 element attached）。
 *     Visible 勉强能靠「节点在不在树里」近似，但 UIA 会把隐藏控件也放进树，不精确；
 *     Stable / Receives Events 做不了 —— windows-mcp 的快照不带 z-order、遮挡、动画帧信息，
 *     硬做只能编。所以这里**只报能确证的**，做不了的明确标成「查不出来」。
 *   · n8n 是四道门：validate（静态结构）→ verify connections（引用完整性）→
 *     test（真跑一次）→ activate。前两道纯静态，正是本模块的 ① 层。
 *
 * 因此预检分两层，severity 刻意不同：
 *
 *   ① **静态自洽**（不需要界面）—— 缺工具名、循环体空、子流程引用不存在的配方、
 *      编排图有环或悬空边。这类是**必然失败**，severity = block，预检直接劝停。
 *
 *   ② **快照核对**（拿一次快照）—— 锚点在当前界面上找不找得到。这类**只能是 warn**：
 *      前面的步骤可能把界面切到别处（第 1 步才打开应用、第 3 步才点进那个页面），
 *      开局一次快照看不到中途状态。判成 block 就会天天误报，误报几次大家就把预检关了 ——
 *      那还不如不做。
 *
 * 不做什么：不预演、不模拟、不自动改锚点。预检只负责说清楚哪里可能挂，改由人决定。
 */

import {
  ANCHORABLE, primaryPoint, parseSnapshotTree, pruneSnapshotTree,
  matchTreeNode, buildTreeSelector,
} from "./anchorResolver.mjs";
import { validateGraph } from "./wfDag.mjs";

export const PREFLIGHT = Object.freeze({
  OK: "ok",                       // 能解析到 / 无事
  STATIC: "static_error",         // 静态自洽问题（必然失败）
  ANCHOR_BROKEN: "anchor_broken", // 录下来的控件身份在当前界面找不到
  WINDOW_MISSING: "window_missing",// 目标窗口不在当前快照里
  UNVERIFIABLE: "unverifiable",   // 查不出来（纯坐标 / 坐标附近无控件 / 子流程未展开）
  SKIPPED: "skipped",             // 不涉及界面锚点（变量赋值 / 键盘输入等）
});

export const SEVERITY = Object.freeze({
  BLOCK: "block",   // 必然失败，劝停
  WARN: "warn",     // 按当前界面看会挂，但中途状态未知（可能前面的步骤正好把它点开）
  INFO: "info",     // 提示，不影响判定
});

/* 窗口标题归一化：快照里的窗口名常带「- 未命名」「* 已修改」这类后缀，
   严格相等会大面积误报"窗口不见了"，所以退一步用包含匹配。 */
function normTitle(s) {
  return String(s == null ? "" : s).replace(/\s+/g, "").toLowerCase();
}

/** 快照里出现过的窗口名（去重，保序）。 */
export function snapshotWindows(root) {
  const out = [];
  const seen = new Set();
  (function walk(n) {
    if (n && n.elementType === "window") {
      const name = String(n.name || "");
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    }
    (n && n.children || []).forEach(walk);
  })(root);
  return out;
}

/** 某个窗口标题在快照里的状态：present / missing / unknown（快照里一个窗口都没有，判不了）。 */
export function windowState(title, windows) {
  const t = normTitle(title);
  if (!t) return "unknown";
  if (!windows || !windows.length) return "unknown";
  for (const w of windows) {
    const n = normTitle(w);
    if (!n) continue;
    if (n === t || n.includes(t) || t.includes(n)) return "present";
  }
  return "missing";
}

/* 锚点 sig 是「窗口 > 祖先 > 控件」的长串，直接显示会撑爆面板，截个尾巴够认人。 */
function shortRef(ref) {
  const s = String(ref || "");
  const parts = s.split(">").map((x) => x.trim()).filter(Boolean);
  const tail = parts.slice(-2).join(" > ");
  return tail.length > 60 ? tail.slice(0, 57) + "…" : (tail || s);
}

function labelOf(prefix, i) {
  const base = `第 ${i + 1} 步`;
  return prefix ? `${prefix} · ${base}` : base;
}

function listOf(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * 回放前预检。纯函数：快照文本由调用方抓，配方由调用方给，不碰 IO、不碰桌面。
 *
 * @param {object} wf 配方（线性 steps 或 graph）
 * @param {string|null} snapshotText 当前控件树文本；null/空 = 只做静态检查
 * @param {object} opts
 *   fromIndex   只核对从第 N 步（0 基）起的顶层步 —— 续跑时前面那些步不会重跑，查它们没意义
 *   workflows   现有配方名集合（数组 / Set / 对象数组），用来校验 subflow 引用是否还在
 *   maxDist     坐标重定位的容差（默认与 anchorResolver 一致：120）
 * @returns {{ok:boolean, hasSnapshot:boolean, findings:Array, blocked:Array, suspects:Array,
 *            total:number, checked:number, windows:string[]}}
 */
export function preflight(wf, snapshotText, opts = {}) {
  const w = wf && typeof wf === "object" ? wf : {};
  const findings = [];
  const push = (f) => findings.push(Object.assign(
    { severity: SEVERITY.WARN, state: PREFLIGHT.OK, index: -1, path: "", tool: "", weak: false },
    f,
  ));

  const known = opts.workflows == null
    ? null
    : new Set(Array.from(opts.workflows, (x) => String(typeof x === "string" ? x : (x && x.name) || "")));

  const graphMode = !!(w.graph && typeof w.graph === "object");
  const steps = listOf(w.steps);
  const fromIndex = Math.max(0, Math.floor(Number(opts.fromIndex) || 0));
  const maxDist = Number(opts.maxDist) > 0 ? Number(opts.maxDist) : 120;

  /* ============================ ① 静态自洽 ============================ */
  function checkSubflowRef(name, label, index) {
    const target = String(name || "").trim();
    if (!target) {
      push({ severity: SEVERITY.BLOCK, state: PREFLIGHT.STATIC, index, label,
        reason: "子流程节点没写要调用哪条配方，回放时必然报错" });
      return;
    }
    if (known && !known.has(target)) {
      push({ severity: SEVERITY.BLOCK, state: PREFLIGHT.STATIC, index, label,
        reason: `引用的子流程「${target}」已经不存在了（可能被删或改名）` });
    }
  }

  /* topIdx：把嵌套步的问题归到它所属的顶层步号上（面板按顶层步定位）；
     isTop=true 时用本步自己的下标。 */
  function walkStatic(list, prefix, topIdx, depth, isTop) {
    if (depth > 8) {
      push({ severity: SEVERITY.BLOCK, state: PREFLIGHT.STATIC, index: topIdx,
        label: prefix || "整条配方", reason: "嵌套层数超过 8 层，回放时会被深度上限截断" });
      return;
    }
    list.forEach((s, i) => {
      const label = labelOf(prefix, i);
      const idx = isTop ? i : topIdx;
      if (!s || typeof s !== "object" || Array.isArray(s)) {
        push({ severity: SEVERITY.BLOCK, state: PREFLIGHT.STATIC, index: idx, label,
          reason: "这一项不是对象，回放时会当成空步骤跳过（多半是手工改坏了）" });
        return;
      }
      const t = String(s.type || "action");
      if (t === "set") return;                       // 纯变量赋值，不碰界面
      if (t === "loop") {
        const body = listOf(s.body);
        if (!body.length) {
          push({ severity: SEVERITY.BLOCK, state: PREFLIGHT.STATIC, index: idx, label,
            reason: "循环体是空的，这个循环什么也不做" });
        } else {
          walkStatic(body, `${label}（循环体）`, idx, depth + 1, false);
        }
        return;
      }
      if (t === "if") {
        const thens = listOf(s.then);
        const elses = listOf(s.else);
        if (!thens.length && !elses.length) {
          push({ severity: SEVERITY.WARN, state: PREFLIGHT.STATIC, index: idx, label,
            reason: "if 的两个分支都是空的，这个判断等于没写" });
        }
        walkStatic(thens, `${label}（then）`, idx, depth + 1, false);
        walkStatic(elses, `${label}（else）`, idx, depth + 1, false);
        return;
      }
      if (t === "subflow") { checkSubflowRef(s.workflow, label, idx); return; }
      // 普通动作
      if (!String(s.tool || "").trim()) {
        push({ severity: SEVERITY.BLOCK, state: PREFLIGHT.STATIC, index: idx, label,
          reason: "没有工具名，回放时无法调用任何动作" });
        return;
      }
      if (!String(s.server || "").trim()) {
        push({ severity: SEVERITY.INFO, state: PREFLIGHT.STATIC, index: idx, label,
          reason: "没写目标通道（server），回放时大概率落到默认通道，且风险档会被判成不可逆（不重试）" });
      }
      if (s.treeRef !== undefined && s.treeRef !== null && !String(s.treeRef).trim()) {
        push({ severity: SEVERITY.WARN, state: PREFLIGHT.STATIC, index: idx, label,
          reason: "treeRef 是空字符串，等于没存控件身份，回放只能靠坐标" });
      }
    });
  }

  if (graphMode) {
    const v = validateGraph(w.graph);
    for (const e of listOf(v.errors)) {
      push({ severity: SEVERITY.BLOCK, state: PREFLIGHT.STATIC, label: "编排图", reason: e });
    }
    for (const e of listOf(v.warnings)) {
      push({ severity: SEVERITY.INFO, state: PREFLIGHT.STATIC, label: "编排图", reason: e });
    }
    const nodes = listOf(w.graph.nodes);
    if (!nodes.length && !steps.length) {
      push({ severity: SEVERITY.BLOCK, state: PREFLIGHT.STATIC, label: "整条配方",
        reason: "编排图没有节点，配方也没有步骤，跑起来什么都不会发生" });
    }
    for (const n of nodes) {
      const id = String((n && n.id) || "(无名)");
      if (n && n.kind === "subflow") checkSubflowRef(n.workflow, `节点 ${id}`, -1);
      /* 节点自带 steps 的查自己的；共用全局 steps 的留到下面统查一次，避免重复报错。 */
      if (n && Array.isArray(n.steps) && n.steps.length) walkStatic(n.steps, `节点 ${id}`, -1, 1, false);
    }
    walkStatic(steps, "", -1, 1, true);
  } else {
    if (!steps.length) {
      push({ severity: SEVERITY.BLOCK, state: PREFLIGHT.STATIC, label: "整条配方", reason: "配方没有任何步骤" });
    }
    walkStatic(steps, "", -1, 1, true);
  }

  /* ============================ ② 快照核对 ============================ */
  const text = String(snapshotText == null ? "" : snapshotText);
  const hasSnapshot = !!text.trim();
  const root = hasSnapshot ? (pruneSnapshotTree(parseSnapshotTree(text)) || null) : null;
  const windows = root ? snapshotWindows(root) : [];
  let checked = 0;

  function checkAnchorStep(s, label, index) {
    const tool = `${s.server || ""}|${s.tool || ""}`;
    const winTitle = s.win && s.win.title ? String(s.win.title) : "";

    // 窗口先于锚点判：窗口都没了，锚点必然找不到，但处置完全不同（重开窗口 vs 重录）。
    if (winTitle) {
      const ws = windowState(winTitle, windows);
      if (ws === "missing") {
        push({ severity: SEVERITY.WARN, state: PREFLIGHT.WINDOW_MISSING, index, label, tool,
          reason: `目标窗口「${winTitle}」不在当前界面里（若前面的步骤会打开它，可以忽略这条）` });
        return;                       // 已定性，不再叠一条 anchor_broken
      }
    }

    if (!ANCHORABLE.has(tool)) {
      push({ severity: SEVERITY.INFO, state: PREFLIGHT.SKIPPED, index, label, tool,
        reason: "不是点击/滚动类动作，没有锚点可查" });
      return;
    }

    checked++;
    if (s.treeRef && String(s.treeRef).trim()) {
      const hit = matchTreeNode(root, { sig: String(s.treeRef) });
      if (hit) {
        push({ severity: SEVERITY.INFO, state: PREFLIGHT.OK, index, label, tool,
          reason: `能解析到（当前在 ${hit.x},${hit.y}）`, at: [hit.x, hit.y] });
      } else {
        push({ severity: SEVERITY.WARN, state: PREFLIGHT.ANCHOR_BROKEN, index, label, tool,
          reason: `录下来的控件「${shortRef(s.treeRef)}」在当前界面找不到 —— 改名 / 改版 / 对应页面还没打开` });
      }
      return;
    }

    // 没有控件身份，只有录制坐标：只能查"那个位置附近还有没有可点控件"，查不出"是不是同一个"。
    const pp = primaryPoint(s);
    if (!pp) {
      push({ severity: SEVERITY.INFO, state: PREFLIGHT.UNVERIFIABLE, index, label, tool,
        reason: "既没有控件身份也没有坐标，无从预检" });
      return;
    }
    const sel = buildTreeSelector(root, pp[0], pp[1], winTitle, maxDist);
    const hit = sel ? matchTreeNode(root, sel) : null;
    if (hit) {
      push({ severity: SEVERITY.INFO, state: PREFLIGHT.OK, index, label, tool, weak: true,
        reason: `只有录制坐标，附近有可点控件（${hit.x},${hit.y}），但无法确认是不是原来那个`,
        at: [hit.x, hit.y] });
    } else {
      push({ severity: SEVERITY.INFO, state: PREFLIGHT.UNVERIFIABLE, index, label, tool,
        reason: `只有录制坐标 ${pp[0]},${pp[1]}，该位置附近没有可识别控件 —— 可能点到空白，也可能本来就是画布类区域` });
    }
  }

  /* topIdx / isTop 语义同 walkStatic：嵌套步的问题归到所属顶层步号，
     fromIndex 只对顶层生效（续跑时前面那些步不会重跑，查它们没意义）。 */
  function walkSnapshot(list, prefix, topIdx, depth, isTop) {
    if (!hasSnapshot || depth > 8) return;
    list.forEach((s, i) => {
      if (!s || typeof s !== "object" || Array.isArray(s)) return;
      const label = labelOf(prefix, i);
      const idx = isTop ? i : topIdx;
      if (isTop && i < fromIndex) return;
      const t = String(s.type || "action");
      if (t === "set") return;
      if (t === "loop") { walkSnapshot(listOf(s.body), `${label}（循环体）`, idx, depth + 1, false); return; }
      if (t === "if") {
        walkSnapshot(listOf(s.then), `${label}（then）`, idx, depth + 1, false);
        walkSnapshot(listOf(s.else), `${label}（else）`, idx, depth + 1, false);
        return;
      }
      if (t === "subflow") {
        /* 子流程不展开：那是另一条配方的界面假设，用当前快照去核对它只会得出错误结论。 */
        push({ severity: SEVERITY.INFO, state: PREFLIGHT.UNVERIFIABLE, index: idx, label,
          tool: "subflow", reason: `子流程「${String(s.workflow || "")}」的内部步骤未展开预检（要用它自己的界面状态核对）` });
        return;
      }
      checkAnchorStep(s, label, idx);
    });
  }

  if (graphMode) {
    const nodes = listOf(w.graph.nodes);
    for (const n of nodes) {
      const id = String((n && n.id) || "(无名)");
      const body = n && Array.isArray(n.steps) && n.steps.length ? n.steps : steps;
      walkSnapshot(body, `节点 ${id}`, -1, 1, false);
    }
  } else {
    walkSnapshot(steps, "", -1, 1, true);
  }

  /* 排序：block 在 warn 前，同severity 里按步号。面板直接按这个顺序显示。 */
  const rank = { block: 0, warn: 1, info: 2 };
  findings.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9)
    || (a.index < 0 ? 0 : a.index) - (b.index < 0 ? 0 : b.index));

  const blocked = findings.filter((f) => f.severity === SEVERITY.BLOCK);
  const suspects = findings.filter((f) => f.severity === SEVERITY.WARN);

  return {
    ok: blocked.length === 0,
    hasSnapshot,
    total: graphMode ? listOf(w.graph.nodes).length : steps.length,
    checked,
    windows,
    findings,
    blocked,
    suspects,
    counts: {
      block: blocked.length,
      warn: suspects.length,
      info: findings.length - blocked.length - suspects.length,
    },
  };
}

/** 一句话结论，给面板标题和日志用。 */
export function summarizePreflight(r) {
  if (!r) return "预检没有结果";
  if (r.blocked.length) {
    return `预检不通过：${r.blocked.length} 个必然失败的问题（${r.blocked.slice(0, 3).map((f) => f.label).join("、")}${r.blocked.length > 3 ? " 等" : ""}）`;
  }
  if (!r.hasSnapshot) {
    return `结构检查通过（未抓界面快照，锚点未核对）${r.suspects.length ? `；另有 ${r.suspects.length} 条提示` : ""}`;
  }
  if (r.suspects.length) {
    const labels = r.suspects.slice(0, 4).map((f) => f.label).join("、");
    return `按当前界面看有 ${r.suspects.length} 步可能失效（${labels}${r.suspects.length > 4 ? " 等" : ""}）；共核对 ${r.checked} 步锚点`;
  }
  return `预检通过：共核对 ${r.checked} 步锚点，当前界面都能解析到`;
}

export default { PREFLIGHT, SEVERITY, preflight, summarizePreflight, snapshotWindows, windowState };
