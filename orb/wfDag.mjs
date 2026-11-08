/* ---------------- 受限编排（wfDag） ----------------
 *
 * 只解决「多个任务的先后与依赖」，刻意不做三件事：
 *   ① 不并行 —— 桌面 GUI 是独占资源，两条自动化同时点会抢焦点、互相打乱。
 *   ② 不做状态机/长期等待 —— 人工节点只做「闸门」：没批准就 fail-closed，不挂着等。
 *   ③ 不让节点内再嵌图 —— 子流程通过 subflow 节点引用另一条配方，不递归展开。
 *
 * 节点 kind：
 *   step      普通动作节点，按配方的 steps 执行（默认，兼容老配方）
 *   subflow   引用另一条配方，串行执行完再继续
 *   approval  人工批准闸门，未批准则整条运行落 needs_review
 *   if        条件分支，cond 为真走 then 节点，否则走 else 节点
 *
 * 图结构：{ nodes: [{id, kind, ...}], edges: [{from, to}] }
 */

export const NODE_KINDS = Object.freeze(["step", "subflow", "approval", "if"]);
export const MAX_NODES = 200;
export const MAX_EDGES = 600;

/** 补默认值，不修改入参。 */
export function normalizeGraph(graph) {
  const g = graph && typeof graph === "object" ? graph : {};
  const nodes = (Array.isArray(g.nodes) ? g.nodes : []).map((n, i) => ({
    ...(n && typeof n === "object" ? n : {}),
    id: String(n?.id || `n${i + 1}`),
    kind: NODE_KINDS.includes(String(n?.kind || "step")) ? String(n?.kind || "step") : "step",
  }));
  const edges = (Array.isArray(g.edges) ? g.edges : []).map((e) => ({
    from: String(e?.from || ""),
    to: String(e?.to || ""),
  })).filter((e) => e.from && e.to);
  return { ...g, nodes, edges };
}

/** 拓扑排序（Kahn）。有环时返回环上残留的节点，便于报错。 */
export function topoOrder(graph) {
  const g = normalizeGraph(graph);
  const indeg = new Map();
  const adj = new Map();
  for (const n of g.nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of g.edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    adj.get(e.from).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }
  const queue = [...indeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const nx of adj.get(id) || []) {
      indeg.set(nx, indeg.get(nx) - 1);
      if (indeg.get(nx) === 0) queue.push(nx);
    }
  }
  if (order.length !== g.nodes.length) {
    const stuck = [...indeg.entries()].filter(([, v]) => v > 0).map(([k]) => k);
    return { ok: false, reason: `编排图存在环：${stuck.slice(0, 6).join(" → ")}`, order, cycle: stuck };
  }
  return { ok: true, order };
}

/** 校验：结构、引用、环、节点类型、必要字段。 */
export function validateGraph(graph) {
  const errors = [];
  const warnings = [];
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return { ok: false, errors: ["graph 必须是对象"], warnings, order: [] };
  }

  const g = normalizeGraph(graph);
  if (!g.nodes.length) errors.push("nodes 为空");
  if (g.nodes.length > MAX_NODES) errors.push(`节点数 ${g.nodes.length} 超过上限 ${MAX_NODES}`);
  if (g.edges.length > MAX_EDGES) errors.push(`边数 ${g.edges.length} 超过上限 ${MAX_EDGES}`);

  const seen = new Set();
  for (const n of g.nodes) {
    if (seen.has(n.id)) errors.push(`节点 id 重复：${n.id}`);
    seen.add(n.id);
    const raw = (Array.isArray(graph.nodes) ? graph.nodes : []).find((x) => String(x?.id || "") === n.id);
    if (raw && raw.kind && !NODE_KINDS.includes(String(raw.kind))) {
      errors.push(`节点 ${n.id} 的 kind 不支持：${raw.kind}（可用：${NODE_KINDS.join(" / ")}）`);
    }
    if (n.kind === "subflow" && !String(n.workflow || "")) {
      errors.push(`子流程节点 ${n.id} 缺少 workflow`);
    }
    if (n.kind === "approval") {
      if (!String(n.ask || "")) warnings.push(`人工节点 ${n.id} 未写 ask，批准卡信息量不足`);
      if (String(n.onMissing || "") === "continue") {
        warnings.push(`人工节点 ${n.id} 设为 onMissing=continue，将绕过批准直接继续`);
      }
    }
    if (n.kind === "if" && !String(n.cond || "")) {
      errors.push(`条件节点 ${n.id} 缺少 cond`);
    }
  }

  for (const e of g.edges) {
    if (!seen.has(e.from)) errors.push(`边引用了不存在的节点（from）：${e.from}`);
    if (!seen.has(e.to)) errors.push(`边引用了不存在的节点（to）：${e.to}`);
  }

  const topo = topoOrder(g);
  if (!topo.ok) errors.push(topo.reason);

  /* 孤立节点不算错，但值得提示：多半是漏连线。 */
  if (g.nodes.length > 1) {
    const linked = new Set();
    for (const e of g.edges) { linked.add(e.from); linked.add(e.to); }
    const lonely = g.nodes.filter((n) => !linked.has(n.id)).map((n) => n.id);
    if (lonely.length) warnings.push(`存在未连线节点：${lonely.slice(0, 8).join(", ")}`);
  }

  return { ok: errors.length === 0, errors, warnings, order: topo.order || [] };
}

/**
 * 生成执行序列：拓扑序 + 条件分支展开。
 * 返回 [{ id, kind, node }]，调用方按序执行；条件分支的 then/else 只保留命中的一支。
 */
export function planOrder(graph, env = {}) {
  const v = validateGraph(graph);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings, plan: [] };
  const g = normalizeGraph(graph);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const plan = [];
  for (const id of v.order) {
    const n = byId.get(id);
    if (!n) continue;
    if (n.kind === "if") {
      const hit = evalCond(n.cond, env);
      const branch = hit ? n.then : n.else;
      plan.push({ id: n.id, kind: "if", node: n, taken: branch || null, conditionMet: hit, skipped: !branch });
      continue;
    }
    plan.push({ id: n.id, kind: n.kind, node: n });
  }
  return { ok: true, plan, warnings: v.warnings };
}

/**
 * 极简条件求值：只支持 {{var}} 与 truthy 判断，不 eval 任意代码。
 * 这是刻意的 —— 编排图来自配方文件，不能变成远程代码执行入口。
 */
export function evalCond(cond, env = {}) {
  const s = String(cond ?? "").trim();
  if (!s) return false;
  const m = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/.exec(s);
  if (m) {
    const val = readPath(env, m[1]);
    return truthy(val);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  /* 其余一律当「未满足」：宁可跳过分支，也不猜。 */
  return false;
}

function readPath(obj, dotted) {
  let cur = obj;
  for (const k of String(dotted).split(".")) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function truthy(v) {
  if (v === false || v === null || v === undefined) return false;
  if (v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export default {
  NODE_KINDS,
  MAX_NODES,
  MAX_EDGES,
  normalizeGraph,
  topoOrder,
  validateGraph,
  planOrder,
  evalCond,
};
