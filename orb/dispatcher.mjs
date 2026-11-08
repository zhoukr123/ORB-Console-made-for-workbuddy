/* ---------------- 任务派发器（dispatcher） ----------------
 *
 * 这是给"以后要多 Agent / 派发者专家团"预留的接口层，**今晚不改变现有行为**：
 * 没有注册任何专家时，route() 退回原来的单路派发（routeHint 原样透传），
 * 与改造前完全一致；注册了专家也只做"决策"，真正执行仍由 bridge 一处统一发起。
 *
 * 为什么把决策与执行分开：
 *   现有面板的 autoRoute() 是**纯正则**、在渲染层、三档（front/vision/back）。
 *   要在它上面长出专家团，会变成"面板里判断一次 + 桥里再判断一次"，两套真相。
 *   所以这里把决策收成一个纯函数式接口：输入上下文、输出**计划**，
 *   计划是数据（可序列化、可记录、可 dry-run、可回放），执行方只认计划。
 *
 * 一个"专家"的形状（最小契约，够用且不锁死未来）：
 *   {
 *     id: "video",                     // 唯一
 *     name: "视频解析专家",
 *     kind: "expert" | "team" | "dispatcher",
 *     match(ctx) -> 0..1 | {score, reason},   // 纯函数：只读 ctx，不许有副作用
 *     plan(ctx) -> { assignments: [...] },    // 可选；不给就按默认单任务产出
 *     members: [expertId...],          // kind=team/dispatcher 时有效
 *     policy: "serial" | "parallel",   // team 的执行策略，默认 serial
 *     route: "workbuddy" | "vision" | "front", // 计划里 assignment 的默认去向
 *   }
 *
 * assignment 的形状：
 *   { expertId, role, prompt, dependsOn: [assignmentId...], parallelGroup }
 *   —— 这是为"派发者把一个大任务拆成几份、并行跑、再汇总"准备的。
 *      dependsOn 是**唯一的时序表达**，不引入第二套 DAG 语法。
 */

const KINDS = new Set(["expert", "team", "dispatcher"]);

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** 关键词匹配器：命中越多分越高，但**不抢**显式 match 的优先级（分数封顶）。
 *  打分用 hits/(hits+1) 而不是 hits/词表长度：
 *  后者会随着词表变长而稀释 —— 加一个同义词就能把原本命中的专家打到阈值以下，
 *  属于"改配置把功能改坏"的隐形坑。这里保证**任何单词命中都有稳定底分**。 */
export function keywords(words, o = {}) {
  const list = (Array.isArray(words) ? words : [words]).filter(Boolean).map(String);
  const weight = Number(o.weight) || 0.6;
  return (ctx) => {
    const text = String(ctx?.text || "");
    if (!text || !list.length) return 0;
    let hit = 0;
    for (const w of list) if (text.includes(w)) hit++;
    if (!hit) return 0;
    return clamp01(weight * (hit / (hit + 1)));
  };
}

function validate(expert) {
  if (!expert || typeof expert !== "object") throw new Error("专家必须是对象");
  const id = String(expert.id || "").trim();
  if (!id) throw new Error("专家缺少 id");
  if (!KINDS.has(expert.kind || "expert")) throw new Error(`专家 ${id} 的 kind 非法：${expert.kind}`);
  if (expert.match != null && typeof expert.match !== "function") throw new Error(`专家 ${id} 的 match 必须是函数`);
  if (expert.plan != null && typeof expert.plan !== "function") throw new Error(`专家 ${id} 的 plan 必须是函数`);
  return { ...expert, id, kind: expert.kind || "expert" };
}

export function createDispatcher(opts = {}) {
  const log = opts.log || (() => {});
  const maxFanout = Math.max(1, Math.min(Number(opts.maxFanout) || 4, 16));
  /** 低于这个分就不认，避免"什么都能匹配上"的专家把默认路径吃掉。 */
  const threshold = Number(opts.threshold ?? 0.35);

  /** id -> expert。Map 保序，注册顺序即同分时的优先级（先注册者优先）。 */
  const experts = new Map();
  /** fallback：没命中任何专家时用的"通用执行"，不是专家，不参与打分。 */
  const fallback = opts.fallback === undefined
    ? { id: "default", route: "workbuddy", role: "executor" }
    : opts.fallback;

  for (const e of opts.experts || []) register(e);

  function register(expert) {
    const e = validate(expert);
    if (experts.has(e.id)) throw new Error(`专家 id 重复：${e.id}`);
    experts.set(e.id, e);
    return describeOne(e);
  }

  function unregister(id) {
    return experts.delete(String(id));
  }

  function get(id) {
    return experts.get(String(id)) || null;
  }

  function describeOne(e) {
    return {
      id: e.id, name: e.name || e.id, kind: e.kind,
      route: e.route || fallback?.route || "workbuddy",
      members: Array.isArray(e.members) ? [...e.members] : [],
      policy: e.policy || "serial",
      hasMatch: typeof e.match === "function",
      hasPlan: typeof e.plan === "function",
    };
  }

  function list() {
    // 只读快照：外部改不到内部对象，避免面板侧顺手 patch 造成两套真相。
    return [...experts.values()].map(describeOne);
  }

  /** 规范化上下文：调用方可以只给 text，其余给默认值。 */
  function normalizeContext(ctx = {}) {
    return {
      text: String(ctx.text || ""),
      routeHint: String(ctx.routeHint || "auto"),     // 面板 autoRoute 的输出：front|vision|back|auto
      attachments: Array.isArray(ctx.attachments) ? ctx.attachments : [],
      ticketId: ctx.ticketId ? String(ctx.ticketId) : "",
      epoch: Number(ctx.epoch) || 0,
      // 预算/容量这类"运行约束"放在 ctx 里，专家可以据此降级，但不能自己改。
      budget: ctx.budget && typeof ctx.budget === "object" ? { ...ctx.budget } : null,
      hints: ctx.hints && typeof ctx.hints === "object" ? { ...ctx.hints } : {},
    };
  }

  /**
   * 打分并选出最高者。同分时**先注册者优先**（Map 保序），
   * 而不是随便挑一个 —— 可复现比"更聪明"重要，出问题才能复盘。
   */
  function scoreAll(c) {
    const scored = [];
    for (const e of experts.values()) {
      let raw = 0;
      let reason = "";
      try {
        raw = typeof e.match === "function" ? e.match(c) : 0;
      } catch (err) {
        // 专家的 match 抛错不能拖垮派发：记一笔、当 0 分。
        log(`[dispatch] 专家 ${e.id} 的 match 抛错：${err.message}`);
        raw = 0;
      }
      if (raw && typeof raw === "object") {
        reason = String(raw.reason || "");
        raw = raw.score;
      }
      const score = clamp01(raw);
      if (score > 0) scored.push({ expert: e, score, reason });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  function defaultAssignments(c, expert) {
    const route = (expert && expert.route) || fallback?.route || "workbuddy";
    return [{
      id: "a1",
      expertId: (expert && expert.id) || fallback?.id || "default",
      role: (expert && expert.role) || fallback?.role || "executor",
      prompt: c.text,
      route,
      dependsOn: [],
      parallelGroup: 0,
    }];
  }

  function normalizeAssignments(raw, c, expert) {
    const arr = Array.isArray(raw) ? raw : [];
    if (!arr.length) return defaultAssignments(c, expert);
    if (arr.length > maxFanout) {
      // 砍到上限而不是报错：派发者多给几份不该让整个请求失败。
      log(`[dispatch] 计划含 ${arr.length} 份任务，超过上限 ${maxFanout}，已截断`);
    }
    return arr.slice(0, maxFanout).map((a, i) => ({
      id: String(a.id || `a${i + 1}`),
      expertId: String(a.expertId || (expert && expert.id) || "default"),
      role: String(a.role || "executor"),
      prompt: String(a.prompt == null ? c.text : a.prompt),
      route: String(a.route || (expert && expert.route) || "workbuddy"),
      dependsOn: Array.isArray(a.dependsOn) ? a.dependsOn.map(String) : [],
      parallelGroup: Number.isFinite(a.parallelGroup) ? Number(a.parallelGroup) : i,
    }));
  }

  /**
   * 主入口：给上下文，出一个**计划**。
   * dryRun 默认 true —— 今晚只做决策，不动执行；bridge 侧要真正执行时显式传 false。
   */
  function route(ctx = {}, o = {}) {
    const c = normalizeContext(ctx);
    const scored = scoreAll(c);

    let expert = null;
    let score = 0;
    let reason = "";
    if (scored.length && scored[0].score >= threshold) {
      expert = scored[0].expert;
      score = scored[0].score;
      reason = scored[0].reason || `匹配度 ${score.toFixed(2)}`;
    }

    let assignments;
    if (expert && typeof expert.plan === "function") {
      try {
        const p = expert.plan(c) || {};
        assignments = normalizeAssignments(p.assignments, c, expert);
      } catch (err) {
        log(`[dispatch] 专家 ${expert.id} 的 plan 抛错，退回默认：${err.message}`);
        assignments = defaultAssignments(c, expert);
      }
    } else {
      assignments = defaultAssignments(c, expert);
    }

    const isTeam = !!expert && (expert.kind === "team" || expert.kind === "dispatcher");
    const plan = {
      ok: true,
      dryRun: o.dryRun !== false,
      dispatcher: expert ? (isTeam ? "team" : "expert") : "fallback",
      expertId: expert ? expert.id : (fallback?.id || "default"),
      expertName: expert ? (expert.name || expert.id) : "通用执行",
      score: Number(score.toFixed(3)),
      reason: expert ? reason : (c.text ? "无专家命中，走单路默认" : "空任务"),
      policy: isTeam ? (expert.policy || "serial") : "serial",
      // 派发者是"谁在分活"：专家团模式下等于 expertId；
      // 单路模式下就是 fallback —— 这个字段是给面板显示"这单归谁"用的。
      dispatcherNote: isTeam ? `由 ${expert.name || expert.id} 分派 ${assignments.length} 份` : "单路执行",
      routeHint: c.routeHint,
      assignments,
      candidates: scored.slice(0, 5).map((s) => ({ id: s.expert.id, score: Number(s.score.toFixed(3)) })),
      at: Date.now(),
    };
    return plan;
  }

  /**
   * 把 assignments 按 dependsOn 折成"可并行的批次"。
   * 没有 dependsOn 的都在第 0 批；有依赖的必须等所有前置完成。
   * 有环 → 返回 { ok:false, code:'cycle' }，**不静默降级**（静默会把顺序跑错）。
   */
  function batches(assignments) {
    const list = Array.isArray(assignments) ? assignments : [];
    const byId = new Map(list.map((a) => [a.id, a]));
    for (const a of list) {
      for (const d of a.dependsOn || []) {
        if (!byId.has(d)) return { ok: false, code: "missing-dep", id: a.id, dep: d };
      }
    }
    const done = new Set();
    const out = [];
    let guard = 0;
    while (done.size < list.length) {
      if (++guard > list.length + 2) return { ok: false, code: "cycle" };
      const layer = list.filter((a) => !done.has(a.id) && (a.dependsOn || []).every((d) => done.has(d)));
      if (!layer.length) return { ok: false, code: "cycle" };
      out.push(layer);
      for (const a of layer) done.add(a.id);
    }
    return { ok: true, batches: out };
  }

  return { register, unregister, get, list, route, batches, normalizeContext, describe: list,
    get threshold() { return threshold; }, get maxFanout() { return maxFanout; } };
}
