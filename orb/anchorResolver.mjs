/* ---------------- anchorResolver（确定性锚定解析，可单测） ----------------
 *
 * 从 bridge.mjs 里把「抗迁移锚定」的逻辑抽出来，成为一份**不依赖 OCR / Windows API /
 * 截图**的纯模块。理由：
 *   ① 原 resolveAnchor 直接调 anchorByText（截图+OCR）和 findWinRectByTitle（Windows API），
 *      单测必须真跑桌面才能覆盖，等于没法测；
 *   ② 方案 A（控件树优先锚定）和方案 B（机器可读错误分类）都需要在同一份纯逻辑上迭代，
 *      抽出来才能给它们写单测、锁行为。
 *
 * 设计：本模块只放「纯函数 + 一个用注入依赖组装的 resolveAnchor」。OCR、Windows 查询、
 * Snapshot 抓取这些有副作用的事，由调用方（bridge）以 deps 形式注入。
 * 这样单测用 mock deps 即可覆盖全部分支，不碰真实桌面。
 *
 * 坐标体系：与 windows-mcp 一致，物理像素（bridge.mjs:1190 已说明）。
 *
 * 11-07 增量简报 §1：ref 版本绑定四元组移到 refBinding.mjs，这里只做装配与复用，
 * 保持「纯模块 + 注入依赖」的形态，不引入任何桌面 API。
 */
import {
  REF_BINDING_ERRORS, ELEMENT_REF_SCHEMA_VERSION, AGENT_DESKTOP_LIMITS,
  bindRefVersion, validateRefBinding, refBindingExtra, classifyAgentDesktopError,
} from "./refBinding.mjs";

export { REF_BINDING_ERRORS, ELEMENT_REF_SCHEMA_VERSION, AGENT_DESKTOP_LIMITS,
  bindRefVersion, validateRefBinding, refBindingExtra, classifyAgentDesktopError };

/* S4 / V-13 / C-07：降级阈值与「脱离视觉循环」纪律的单一来源。
 * 方案原文要求「阈值写进 anchorResolver / refBinding」，故从此处再导出，
 * 调用方只需认 anchorResolver 一处。纯函数，零副作用。 */
import { decideDegradation, DEGRADATION_CODES, DEGRADE_TO, isSelfElectronWindow } from "./v13LoopGuard.mjs";
export { V13_THRESHOLDS, V13_METRICS } from "./v13Metrics.mjs";
export { decideDegradation, DEGRADATION_CODES, DEGRADE_TO, isSelfElectronWindow };

/* 可锚定的工具：单点/区域类动作才需要抗迁移，键盘类不需要。 */
export const ANCHORABLE = new Set([
  "windows|Click", "windows|Move",
  "orb|long_press", "orb|mouse_press", "orb|move_to", "orb|scroll_at", "orb|cursor_position",
]);

/** 取步骤的「主坐标点」（绝对坐标，未变换）。 */
export function primaryPoint(step) {
  const a = (step && step.args) || {};
  if (Array.isArray(a.loc)) return [Number(a.loc[0]) || 0, Number(a.loc[1]) || 0];
  if (a.x !== undefined) return [Number(a.x) || 0, Number(a.y) || 0];
  return null;
}

/** 把一个位移应用到 args 的所有坐标字段（loc / x,y / 含 x2,y2 的拖动）。 */
export function addDeltaToArgs(args, dx, dy) {
  const o = args || {};
  if (Array.isArray(o.loc)) o.loc = [o.loc[0] + dx, o.loc[1] + dy];
  if (o.x !== undefined) o.x += dx;
  if (o.y !== undefined) o.y += dy;
  if (o.x2 !== undefined) o.x2 += dx;
  if (o.y2 !== undefined) o.y2 += dy;
  return o;
}

/* ============================ 方案 B：机器可读错误分类 ============================
 * 现状是 ESCALATABLE_ERR 正则吞错误串（bridge.mjs:7404），再靠 once 模式请视觉救一次。
 * 这里把桌面动作失败映射成结构化错误码，升级策略就能数据驱动、可单测，而不是拼英文串。
 * 注意：这是「分类器」，不是「断言」——它只根据错误文本给出最可能的 code，
 *       调用方仍要结合实际动作结果（ref 是否还在树里等）决定升级路径。
 */
export const ACTION_ERROR_CODES = Object.freeze({
  STALE_REF: "STALE_REF",                 // 界面变了，元素不在原处（需 re-Snapshot / 重录）
  AMBIGUOUS_TARGET: "AMBIGUOUS_TARGET",   // 多个候选，定位不唯一（需视觉或人确认）
  WINDOW_GONE: "WINDOW_GONE",             // 目标窗口没了（按标题重开 / 放弃）
  PERM_DENIED: "PERM_DENIED",             // 权限/急停拒绝（绝不再重试，交人）
  UNKNOWN: "UNKNOWN",                     // 兜不住的，保守当未知处理
  /* 11-07：agent-desktop v1.1.0 破坏性变更带来的三类新失败，
   * 单独成码，避免把「平台不支持 / 快照过期 / 版本漂移」全糊成 STALE_REF。 */
  PLATFORM_NOT_SUPPORTED: REF_BINDING_ERRORS.PLATFORM_NOT_SUPPORTED,
  SNAPSHOT_MISMATCH: REF_BINDING_ERRORS.SNAPSHOT_MISMATCH,
  TOOL_VERSION_MISMATCH: REF_BINDING_ERRORS.TOOL_VERSION_MISMATCH,
});

/** 把一段错误文本归到某个错误码。hadRef=true 表示这一步原本带了稳定选择器。 */
export function classifyActionError(text, { hadRef = false } = {}) {
  const s = String(text == null ? "" : text);
  if (!s) return ACTION_ERROR_CODES.UNKNOWN;
  /* 11-07：先判版本绑定类失败，它们的处置与「界面变了」不同（不能靠 re-Snapshot 修）。 */
  const bound = classifyAgentDesktopError(s);
  if (bound) return bound;
  const low = s.toLowerCase();
  // 顺序有讲究：越「不可逆/需人」的越先判，避免被笼统词误伤。
  if (/(permission|denied|权限|拒绝|access[ _-]?denied|eacces|eperm|not authorized|未授权)/i.test(s))
    return ACTION_ERROR_CODES.PERM_DENIED;
  if (/(window|窗口).{0,6}(gone|not found|未找到|消失|关闭)|找不到.{0,6}窗口|WINDOW_GONE/i.test(s))
    return ACTION_ERROR_CODES.WINDOW_GONE;
  if (/(ambiguous|multiple.{0,30}match|多个.{0,6}(匹配|结果)|不明确|定位不唯一|AMBIGUOUS)/i.test(s))
    return ACTION_ERROR_CODES.AMBIGUOUS_TARGET;
  if (/(stale|元素.{0,4}不在|ref.{0,4}(invalid|gone|失效)|元素丢失|STALE|找不到.{0,4}该(控件|元素|按钮))/i.test(s))
    return ACTION_ERROR_CODES.STALE_REF;
  // 带 ref 却失败、又不是上面明确的，默认按 STALE 处理（最贴近「界面变了」的语义）。
  if (hadRef) return ACTION_ERROR_CODES.STALE_REF;
  return ACTION_ERROR_CODES.UNKNOWN;
}

/**
 * 把分类后的错误码映射到升级处置（纯函数，可单测）。
 *   'hard-stop' —— PERM_DENIED：绝不重试/升级，直接交人
 *   'takeover'  —— 自动化配了 escalate∈{agent,once}：交接管层按视觉推进（覆盖其余所有码）
 *   'throw'     —— 其余（off/stop 且非权限错误）：原样抛出，由上层捕获上报
 * 注意：agent/once 是用户显式「界面变了就救」的开关，故 UNKNOWN 也走 takeover，
 *       而不是默默失败 —— 这与旧的「conf==='absolute' 才接管」比更稳。
 */
export function decideEscalation(code, { escalate = "off" } = {}) {
  if (code === ACTION_ERROR_CODES.PERM_DENIED) return "hard-stop";
  if (escalate === "agent" || escalate === "once") return "takeover";
  return "throw";
}

/* ============================ 方案 A1：控件树结构化锚定 ============================
 * windows-mcp 的 Snapshot 输出每个节点：control_type / element_type / name / window_name /
 * center(x,y) / bounding_box(left,top,right,bottom,width,height) / children（缩进层级）。
 * 它**不**暴露 automation_id / runtime_id 这类稳定 id（tree/service.py 取了但没写进对外 JSON），
 * 所以这里用「name + control_type + 祖先路径 + window_name」构造一个 ORB 侧的结构化选择器，
 * 作为 immutable ref 的近似。改名不失效的真·ref 需给 windows-mcp 打补丁（暴露 automation_id），
 * 记方案 A2，不在本模块。
 */

const NODE_RE = {
  // 交互/可滚动节点：  123,456 Button "确定"  [action: click]
  interactive: /^(\d+),(\d+)\s+([A-Za-z]+)\s+"([^"]*)"/,
  // 窗口：  window "记事本"
  window: /^window\s+"([^"]*)"/,
  // 结构/桌面容器：  Pane "工具栏"   或  desktop
  structural: /^([A-Za-z]+)\s+"([^"]*)"/,
};

/** 把 Snapshot 的文本树解析成嵌套结构。纯函数，单测可直接喂样例文本。
 *  返回根节点：{ controlType, elementType, name, windowName, x, y, bbox, children, depth } */
export function parseSnapshotTree(text) {
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  const root = { controlType: "Desktop", elementType: "desktop", name: "desktop", children: [], depth: -1 };
  const stack = [root];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    // 去掉树形前缀：├── / └── / │   / 空格
    const content = raw.replace(/^[│\s]*[├└]──\s*/, "").replace(/^[│\s]+/, "").trim();
    if (!content) continue;
    let node = null;
    let m;
    if ((m = NODE_RE.interactive.exec(content))) {
      const x = Number(m[1]), y = Number(m[2]);
      node = { controlType: m[3], elementType: "interactive", name: m[4], x, y, bbox: { left: x, top: y, right: x, bottom: y, width: 0, height: 0 }, children: [] };
    } else if ((m = NODE_RE.window.exec(content))) {
      node = { controlType: "Window", elementType: "window", name: m[1], windowName: m[1], children: [] };
    } else if (content === "desktop") {
      continue; // 根已存在
    } else if ((m = NODE_RE.structural.exec(content))) {
      node = { controlType: m[1], elementType: "structural", name: m[2], children: [] };
    } else {
      continue;
    }
    // 缩进层级 = 连接符前「│   」/「    」四字符组的个数；根 desktop 已在循环外，
    // 其余节点 level = groups + 1（首层窗口 groups=0 → level 1）。
    const lead = raw.search(/[├└]/);
    const indent = lead >= 0 ? raw.slice(0, lead).length / 4 : 0;
    node.depth = indent + 1;
    // 弹出栈里深度 >= 当前节点深度的（它们是同级或已处理完的更深层，不是祖先）。
    // 注意用 node.depth（=groups+1），不是 groups：用 groups 会把上一层也弹掉。
    while (stack.length > 1 && stack[stack.length - 1].depth >= node.depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) {
      // 把 window 的 windowName 往下透传给子孙（Snapshot 文本里子孙不带 window 名）
      if (node.elementType === "window") {
        const tagWin = (n) => { n.windowName = node.name; n.children.forEach(tagWin); };
        tagWin(node);
      } else if (parent.windowName) {
        node.windowName = parent.windowName;
      }
      parent.children.push(node);
    }
    stack.push(node);
  }
  return root;
}

/** 给定一个点 (x,y) 与窗口名，从解析树里找到中心最接近该点、且是交互/可滚动的节点，
 *  构造可持久化的结构化选择器。找不到返回 null。
 *  注意：Snapshot 文本只给中心坐标（不给宽高），所以录制时按「最近中心」匹配，
 *  而非「点落在 bbox 内」（bbox 在文本格式里是零面积）。阈值给得宽，因为录制点击
 *  通常就在元素中心附近，但难免有几像素偏移。 */
export function buildTreeSelector(root, x, y, windowName, maxDist = 120) {
  let best = null, bestD = maxDist;
  const walk = (n) => {
    if ((n.elementType === "interactive" || n.elementType === "scrollable") && n.x != null) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bestD) { bestD = d; best = n; }
    }
    n.children.forEach(walk);
  };
  walk(root);
  if (!best) return null;
  // 祖先路径：从根到 best 的父，逐级 controlType+name
  const path = [];
  (function collect(n, chain) {
    for (const c of n.children) {
      if (c === best) { path.push(...chain); return true; }
      if (collect(c, [...chain, { controlType: c.controlType, name: c.name }])) return true;
    }
    return false;
  })(root, []);
  return {
    windowName: best.windowName || windowName || "",
    controlType: best.controlType,
    name: best.name,
    ancestorPath: path,
    sig: [best.windowName || windowName || "", ...path.map((p) => `${p.controlType}|${p.name}`), `${best.controlType}|${best.name}`].join(" > "),
  };
}

/** 用选择器在（重新抓取的）解析树里定位节点，返回其 {x,y} 中心；找不到返回 null。
 *  匹配严格按 sig（window + 祖先路径 + controlType + name），一条不对就放弃，
 *  绝不「近似点最近的」——近似是 OCR 文字锚定的老毛病，这里刻意不做。 */
export function matchTreeNode(root, selector) {
  if (!root || !selector || !selector.sig) return null;
  let found = null;
  const walk = (n, chain) => {
    if (found) return;
    const here = [...chain, { controlType: n.controlType, name: n.name }];
    const sig = [n.windowName || "", ...here.map((p) => `${p.controlType}|${p.name}`)].join(" > ");
    if (sig === selector.sig && (n.elementType === "interactive" || n.elementType === "scrollable")) {
      found = n; return;
    }
    n.children.forEach((c) => walk(c, here));
  };
  // 从根的直接子节点开始累计 chain（根 Desktop 是合成节点，不进 sig，与 buildTreeSelector 对齐）
  root.children.forEach((c) => walk(c, []));
  if (!found) return null;
  // 优先用 center，否则用 bbox 中心
  const x = found.x != null ? found.x : (found.bbox ? (found.bbox.left + found.bbox.right) / 2 : null);
  const y = found.y != null ? found.y : (found.bbox ? (found.bbox.top + found.bbox.bottom) / 2 : null);
  if (x == null || y == null) return null;
  return { x: Math.round(x), y: Math.round(y), ref: selector.sig };
}

/* ============================ 方案 C：控件树裁剪（降 token / 提速） ============================
 * windows-mcp 的 Snapshot 没有 region/bounds 参数（tools/snapshot.py 实测：仅
 * use_vision / use_dom / use_ui_tree / reference_lines / display 五类开关），
 * 服务端无法按区域裁剪，只能全量返回。bridge 侧已有 READ_CACHE（300ms）兜住反复轮询，
 * 这里再把解析树「砍结构叶子」，进一步缩小后续匹配 / 序列化体积。
 *
 * 保留规则（与 buildTreeSelector / matchTreeNode 的消费方式严格对齐）：
 *   · window       —— 永远保留（选择器 sig 以 window_name 开头）
 *   · interactive  —— 永远保留（点击 / 滚动目标，且是唯一有坐标的节点）
 *   · structural   —— 仅当它「有被保留的后代」时保留（即交互节点的祖先路径，保证 sig 链路不断）
 *   · 其余纯结构叶子 —— 丢弃
 * 纯函数，不修改入参。裁剪后所有 interactive / window 节点原样保留，
 * 故 buildTreeSelector 选中的最近交互节点、matchTreeNode 走的 sig 链路都不变 —— 行为零变化。 */
export function pruneSnapshotTree(root) {
  if (!root || !Array.isArray(root.children)) return root;
  function keep(node) {
    const interesting = node.elementType === "interactive" || node.elementType === "window";
    const kids = (node.children || []).map(keep).filter(Boolean);
    if (interesting || kids.length > 0) return Object.assign({}, node, { children: kids });
    return null; // 纯结构叶子（无交互后代）→ 丢弃
  }
  const pruned = keep(root);
  return pruned || root;
}

/* ============================ 方案 E：Agent 工具策略（结构化优先于视觉） ============================
 * 桌面 Agent 的两类「看屏幕」手段：
 *   · Snapshot + 控件树 ref  —— 结构化、可定位、抗改名/改版（方案 A1 的底座）；
 *   · Screenshot + 视觉模型  —— 像素级，能认验证码/画布/图片，但贵且脆。
 * 报告主张：有稳定控件树时**优先**走结构化，只有验证码/画布/图片这类「树里没有的东西」
 * 才退回视觉。这里把这条硬偏好做成纯函数，便于单测，也便于在接管/路由时统一裁决。 */
const VISUAL_ONLY_RE = /(验证码|captcha|滑块|拼图|点选|画布|canvas|截图|图片|图像|二维码|ocr|识别|照片|头像|图表|二维码)/i;

export function preferSnapshotRef(taskText, { hasTree = false } = {}) {
  const t = String(taskText || "").toLowerCase();
  if (VISUAL_ONLY_RE.test(t)) {
    return { mode: "vision", reason: "图像/验证码类任务只能靠视觉（控件树里没有这类目标）" };
  }
  if (hasTree) {
    return { mode: "structured", reason: "有稳定控件树，优先 Snapshot + ref（结构化、可定位、抗改名）" };
  }
  return { mode: "vision", reason: "无稳定控件树可用，退回视觉兜底" };
}

/**
 * 在一棵（已解析、已裁剪的）控件树上，为某一步找当前中心坐标。纯函数，可单测。
 * 优先级：
 *   ① step.treeRef —— 录制期就存下来的结构化身份，直接按 sig 精确匹配。
 *      这是「录制即定身份」优化的核心：不依赖回放期录制坐标是否还准，也不依赖 OCR。
 *   ② 按录制坐标找最近的交互节点，现建选择器再匹配（旧的 A1 行为，兼容存量自动化）。
 * 返回 {x,y,ref} 或 null。绝不近似：sig 对不上就返回 null，交给上层落 OCR/坐标。
 */
export function resolveTreeNode(root, step, { maxDist = 120 } = {}) {
  if (!root) return null;
  // ① 录制期结构化身份
  if (step && step.treeRef) {
    const hit = matchTreeNode(root, { sig: String(step.treeRef) });
    if (hit) return hit;
    // treeRef 没命中说明界面真的变了（改名/改版）→ 继续用坐标做一次重定位
  }
  // ② 回放期按录制坐标重定位
  const pp = primaryPoint(step);
  if (!pp) return null;
  const winName = step && step.win && step.win.title;
  const sel = buildTreeSelector(root, pp[0], pp[1], winName, maxDist);
  if (!sel) return null;
  return matchTreeNode(root, sel);
}

/* ============================ 控件树抓取的短时复用（性能优化，零正确性风险） ============================
 * 为什么单独做一个、不用「按写操作失效」的通用读缓存：
 *   · 锚定只拿树结构去 matchTreeNode。陈旧树最坏只会让 matchTreeNode 命中失败
 *     → 上层退回 OCR/坐标兜底，**绝不会点到错位控件**（matchTreeNode 锁了"绝不近似"）。
 *   · 而「打字 / 填表的连续字段」这类动作不改变控件树结构，按写失效会把这些合并机会
 *     也清掉，反而错失"同一窗口里连点/连填"的省抓取收益。
 *   · 所以这里只做**纯时间窗**（默认 300ms）：窗口内连发的锚定共享一次 Snapshot，
 *     超出窗口或界面真变了就重新抓。纯函数、可单测。 */
export function createTreeCache(ttlMs = 300) {
  let ts = 0;
  let txt = null;
  return {
    get(now = Date.now()) {
      if (txt == null) return null;
      if (now - ts >= ttlMs) { txt = null; return null; } // 过期即作废，避免 stale 误命中
      return txt;
    },
    set(v, now = Date.now()) { txt = v; ts = now; },
    clear() { txt = null; ts = 0; },
  };
}

/* ============================ D 地基：统一元素引用 schema + 后端能力表 ============================
 * 这是"分层可插拔"的地基：所有后端（树/文字/视觉/窗口/绝对）都产出一个统一的 ElementRef，
 * 上层（编排、诊断、verify 环）只看这个 schema，不关心是哪个后端产出 —— 加后端不用改上层。
 * ElementRef = { x, y, backend, ref, score }：
 *   backend  ∈ 'tree'|'text'|'visual'|'window'|'absolute'|'none'
 *   ref      稳定身份（树 sig / 视觉 ref），可能为 null
 *   score    原始匹配分（树/文字通常无，视觉有），可能为 null
 */
export const ELEMENT_BACKENDS = [
  { name: "tree", cost: 1, note: "控件树结构化匹配（抗改名/改版）" },
  { name: "text", cost: 2, note: "OCR 文字锚定" },
  { name: "visual", cost: 3, note: "视觉锚定（C0 模板 / C1 CLIP），不依赖树与文字" },
  { name: "window", cost: 2, note: "窗口相对坐标（窗口被拖动也能跟）" },
  { name: "absolute", cost: 0, note: "录制绝对坐标（兜底，最不可信）" },
];

/** 把任一后端命中的 {x,y,ref?,score?} 归一化成 ElementRef；坐标非法返回 null。 */
export function normalizeElementRef(hit, backend, extra = {}) {
  const x = hit ? Number(hit.x) : NaN;
  const y = hit ? Number(hit.y) : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x, y,
    backend,
    ref: (hit && hit.ref) || null,
    score: (hit && Number.isFinite(hit.score)) ? hit.score : null,
    ...extra,
  };
}

/** 11-07：带四元组绑定的归一化。ctx 至少给 platform / snapshotId / toolVersion，
 * 缺失字段不补零，留给 checkRefBinding 判为对应错误码。 */
export function normalizeElementRefWithBinding(hit, backend, ctx = {}, extra = {}) {
  return normalizeElementRef(hit, backend, {
    ...refBindingExtra((hit && hit.ref) || null, ctx),
    ...extra,
  });
}

/** 11-07：动作执行前核对 ref 身份是否仍然成立。失败即停止，不再拿旧 ref 硬点。 */
export function checkRefBinding(elementRef, current = {}, opts = {}) {
  const binding = elementRef && (elementRef.refBinding || bindRefVersion(elementRef.ref, current));
  return validateRefBinding(binding, current, opts);
}

/* ============================ E：ground-act-verify 的 verify 环（纯函数，可单测） ============================
 * 只做"动作有没有生效"的客观判断，不猜。取动作前后的控件树文本，比较结构指纹：
 *   · 指纹变了 → 认为动作生效（ok=true, changed=true）
 *   · 指纹没变 → 对"会改变界面"的动作判 ok=false（可能没点中/没输进去），供上层重锚/接管
 * 只读动作、或界面本就不变的动作不该判失败，所以由调用方用 mutating 控制。
 * 拿不到动作后快照时**不误判失败**（ok=true）——宁可不报，也不乱报。
 */
export function treeFingerprint(snapshotText) {
  if (!snapshotText) return "0|0";
  const root = parseSnapshotTree(snapshotText);
  const pruned = pruneSnapshotTree(root) || root;
  let nodes = 0;
  const names = [];
  (function walk(n) {
    if (!n) return;
    nodes++;
    if (n.name) names.push(`${n.controlType || ""}:${n.name}`);
    (n.children || []).forEach(walk);
  })(pruned);
  const s = nodes + "|" + names.join("|");
  let h = 0x811c9dc5;                       // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${nodes}|${h.toString(16)}`;
}

export function verifyEffect({ beforeText, afterText, mutating = true } = {}) {
  const before = treeFingerprint(beforeText);
  const after = treeFingerprint(afterText);
  const changed = before !== after;
  if (!mutating) return { ok: true, changed, reason: "只读/不改界面的动作，不判失败" };
  if (!afterText) return { ok: true, changed: false, reason: "拿不到动作后快照，无法判定（不误判失败）" };
  if (changed) return { ok: true, changed: true, reason: "控件树指纹变化，动作已生效" };
  return { ok: false, changed: false, reason: "控件树指纹未变，动作可能未生效" };
}

/* ============================ 组装：可注入依赖的 resolveAnchor ============================
 * deps（均由 bridge 注入，含副作用）：
 *   anchorByText(step)   -> {x,y}|null   原 OCR 文字锚定
 *   anchorByTree(step)   -> {x,y,ref}|null  见 bridge 内实现（抓 Snapshot → parse → match）
 *   findWinRectByTitle(t) -> [x,y,w,h]|null
 * 返回 { args, conf, ref }，conf ∈ 'tree' | 'text' | 'window' | 'absolute' | 'none'。
 *   'tree'/'text'/'window' 视为高可信，上层**不**应触发视觉升级；
 *   'absolute' 才是真降级（锚点没找到，落到录制坐标），'none' 是本来就没配锚点。
 */
export function createAnchorResolver(deps = {}) {
  const anchorByText = deps.anchorByText || (() => null);
  const anchorByTree = deps.anchorByTree || null;
  const anchorByVisual = deps.anchorByVisual || null;
  const findWinRectByTitle = deps.findWinRectByTitle || (() => null);
  /* S4：降级纪律是 opt-in。degradation(step) 返回现场信号（自属界面/平台能力/ref 校验/
   * 覆盖度/已用视觉轮数），由 bridge 注入。不传时行为与改造前**完全一致**（不破坏存量回放）。 */
  const degradation = typeof deps.degradation === "function" ? deps.degradation : null;
  const onLoopExit = typeof deps.onLoopExit === "function" ? deps.onLoopExit : null;

  return async function resolveAnchor(step) {
    const a = (step && step.args) || {};
    const args = JSON.parse(JSON.stringify(a)); // 克隆，避免回放多次后位移被反复叠加
    const tool = `${step && step.server}|${step && step.tool}`;
    const hadAnchor = !!(a.anchor && String(a.anchor).trim());

    // S4：先裁决降级纪律。命中时**绝不再走视觉档（③）**，也就不会触发上层 runVision()/takeover。
    let deg = null;
    if (degradation) {
      try { deg = decideDegradation(degradation(step) || {}); } catch { deg = null; }
    }
    const skipVisual = !!(deg && deg.degrade && !deg.enterVisual);
    if (skipVisual && onLoopExit) { try { onLoopExit({ step, code: deg.code, reason: deg.reason, degradeTo: deg.degradeTo }); } catch {} }
    // 把降级结论挂在 element 上，桥据此决定是否进入智能接管（视觉循环）。
    // 只在**真的降级**时加字段，未降级时原样返回，绝不改动存量返回结构（不破坏既有断言）。
    const withDeg = (element) => (element && deg && deg.degrade) ? { ...element, degradation: {
      code: deg.code, reason: deg.reason, degradeTo: deg.degradeTo, reSnapshot: deg.reSnapshot,
    } } : element;

    // ① 控件树锚定（方案 A1，首选）：结构化匹配，绕开 OCR 启发式
    if (ANCHORABLE.has(tool) && anchorByTree) {
      try {
        const t = await anchorByTree(step);
        if (t && Number.isFinite(t.x) && Number.isFinite(t.y)) {
          if (Array.isArray(args.loc)) args.loc = [t.x, t.y];
          else if (args.x !== undefined) { args.x = t.x; args.y = t.y; }
          delete args.anchor;
          return { args, conf: "tree", ref: t.ref || null, element: withDeg(normalizeElementRef({ x: t.x, y: t.y, ref: t.ref }, "tree")) };
        }
      } catch { /* 树锚定失败，落到后面的坐标档，不阻断 */ }
    }

    // ② 文字锚定（OCR）：界面改版也常能活，但依赖截图+识别
    if (ANCHORABLE.has(tool) && args.anchor) {
      const pt = await anchorByText(step);
      if (pt) {
        if (Array.isArray(args.loc)) args.loc = [pt.x, pt.y];
        else { args.x = pt.x; args.y = pt.y; }
        delete args.anchor;
        return { args, conf: "text", element: withDeg(normalizeElementRef({ x: pt.x, y: pt.y }, "text")) };
      }
    }

    // ③ 视觉锚定（C0 模板匹配 + C1 CLIP embedding）：不依赖控件树、不依赖文字，
    //    能应对"控件树缺失 / 改名 / 无文字图标"这类前两档会失手的情况。
    //    C0 命中即返回；C0 未命中才上 C1（C1 贵，仅必要时唤醒）。
    //    S4 降级纪律：命中降级裁决时**跳过视觉档**，这就是「明确不接回 runVision()」。
    if (anchorByVisual && !skipVisual) {
      const v = await anchorByVisual(step);
      if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) {
        if (Array.isArray(args.loc)) args.loc = [v.x, v.y];
        else if (args.x !== undefined) { args.x = v.x; args.y = v.y; }
        delete args.anchor;
        return { args, conf: "visual", ref: v.ref || null, element: withDeg(normalizeElementRef({ x: v.x, y: v.y, ref: v.ref, score: v.score }, "visual")) };
      }
    }

    // ④ 窗口相对坐标：窗口被拖动/换位置也能跟得上
    if (step && step.win && step.win.title && Array.isArray(step.win.off)) {
      const r = await findWinRectByTitle(step.win.title);
      if (r) {
        const pp = primaryPoint(step);
        if (pp) {
          const dx = r[0] + step.win.off[0] - pp[0];
          const dy = r[1] + step.win.off[1] - pp[1];
          addDeltaToArgs(args, dx, dy);
          delete args.anchor;
          return { args, conf: "window", element: withDeg(normalizeElementRef({ x: pp[0] + dx, y: pp[1] + dy }, "window")) };
        }
      }
    }

    // ⑤ 兜底：原样（录制时的绝对坐标）
    delete args.anchor;
    {
      const pp0 = primaryPoint(step);
      const element = pp0 ? withDeg(normalizeElementRef({ x: pp0[0], y: pp0[1] }, hadAnchor ? "absolute" : "none")) : null;
      return { args, conf: hadAnchor ? "absolute" : "none", element };
    }
  };
}

export default { ANCHORABLE, primaryPoint, addDeltaToArgs, classifyActionError, ACTION_ERROR_CODES, parseSnapshotTree, buildTreeSelector, matchTreeNode, createAnchorResolver, createTreeCache, ELEMENT_BACKENDS, normalizeElementRef, treeFingerprint, verifyEffect,
  decideDegradation, DEGRADATION_CODES, DEGRADE_TO, isSelfElectronWindow };
