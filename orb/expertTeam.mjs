/**
 * 专家团模式 = 任务分配机制（orchestrator-workers），**不是**审查/复核机制。
 *
 * 参考 Anthropic《Building effective agents》的 orchestrator-workers 工作流，以及
 * 2025-2026 年生产实践里收敛出来的几条硬约束：
 *   1. 用户只与 lead（分配者）对话；worker 没有对话入口，永不直接接收用户输入。
 *   2. lead 在运行时决定子任务，产出结构化 plan：id / brief / successCriterion / budget；
 *      子任务不是提前写死的流水线。
 *   3. worker 上下文隔离：只拿自己那一份 brief，不拿兄弟 worker 的结果、不互相协调。
 *   4. worker 只回传压缩结果；汇总（aggregate）由 lead 单独做，不是字符串拼接。
 *   5. effort scaling：按任务复杂度决定 worker 数，简单问题不付 fan-out 成本。
 *   6. 用户通过 lead 的 steer 影响「worker 的工作」与「lead 自己的计划」。
 *
 * 本模块只管状态，不碰网络/文件/子进程 —— 真实派发由 bridge 接现有 /api/dispatch
 * 通道完成，状态从真实 job 回读，所以卡片不是摆设。
 */
export const LEAD = Object.freeze({
  id: "lead", name: "分配者",
  role: "拆解任务、分派、汇总；用户唯一的对话对象",
});

/* 工作者按职责专门化。顺序固定，decompose 按序取用。 */
export const WORKER_ROLES = Object.freeze([
  Object.freeze({ id: "survey", name: "梳理", duty: "读材料、理清范围与约束" }),
  Object.freeze({ id: "build", name: "执行", duty: "完成主体工作，产出可交付结果" }),
  Object.freeze({ id: "check", name: "校验", duty: "按成功判据核对，指出缺口与冲突" }),
  Object.freeze({ id: "pack", name: "汇编", duty: "把结果整理成可直接使用的形式" }),
]);

export const WORKER_STATUS = Object.freeze(["queued", "running", "done", "failed", "blocked"]);

const str = (v, cap = 4000) => String(v ?? "").trim().slice(0, cap);
const nowOf = (o) => (typeof o.now === "function" ? o.now() : Date.now());

/* 显式分项优先：编号 / 分号 / 换行。切不出来就按复杂度由 lead 自己拆维度。 */
function explicitParts(text) {
  return str(text)
    .split(/\n+|[；;]+|(?:\s*[（(]?\d+[)）]?[.、]\s*)/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 600);
}

function complexityOf(text, parts) {
  const t = str(text);
  let score = parts.length >= 4 ? 3 : parts.length >= 2 ? 2 : 0;
  if (/(分别|同时|并行|多个|各|逐|一一|以及|另外|还要)/.test(t)) score++;
  if (/(文件|代码|模块|资料|网页|报告|表格|数据)/.test(t)) score++;
  if (t.length > 160) score++;
  if (score >= 4) return 4;
  if (score >= 2) return 3;
  if (/(改|写|做|生成|整理|查|分析|实现|排查)/.test(t)) return 2;
  return 1;
}

/* lead 自己拆维度：没有显式分项时，按职责给出互不重叠的 brief。 */
function defaultBriefs(subject, n) {
  const s = str(subject, 300);
  const all = [
    `围绕「${s}」梳理范围、已有材料与硬约束；只回报要点，不要展开全文。`,
    `围绕「${s}」完成主体工作，给出可执行/可交付的结果。`,
    `围绕「${s}」按成功判据逐条核对，只指出缺口、冲突与证据不足处。`,
    `把「${s}」的产出整理成一份可直接使用的精简清单。`,
  ];
  return all.slice(0, n);
}

function criterionOf(brief, role) {
  if (role === "check") return "列出缺口/冲突，并说明依据；没有问题也要明确写「无」";
  if (role === "survey") return "给出不超过一屏的要点清单，标明不确定处";
  if (role === "pack") return "产出一页内的结构化清单，不含过程废话";
  return "交出可验证的结果，并附一句「做到什么程度」";
}

export function createExpertTeam(opts = {}) {
  const now = () => nowOf(opts);
  let enabled = false;
  let run = null;
  let seq = 0;
  let steersTotal = 0;
  let runsTotal = 0;

  function enable(on) {
    enabled = on === true;
    if (!enabled && run) { run.phase = "stopped"; run.stoppedAt = now(); }
    return { ok: true, enabled };
  }

  /* lead 拆解：产出结构化 plan。worker 只拿自己的 brief + criterion + budget，
     绝不把 subject 原文或兄弟的 brief 塞进去（上下文隔离）。 */
  function decompose(text) {
    const subject = str(text, 300) || "未命名任务";
    const parts = explicitParts(text);
    const n = complexityOf(text, parts);
    const briefs = parts.length >= 2 ? parts.slice(0, 4) : defaultBriefs(subject, n);
    const count = Math.max(1, Math.min(WORKER_ROLES.length, briefs.length));
    const workers = [];
    for (let i = 0; i < count; i++) {
      const role = WORKER_ROLES[i];
      workers.push({
        id: `w${i + 1}`,
        roleId: role.id,
        name: role.name,
        brief: str(briefs[i], 600),
        criterion: criterionOf(briefs[i], role.id),
        budget: count >= 4 ? "紧凑" : "常规",
        status: "queued",
        jobId: "",
        steps: [],
        steers: [],
        result: "",
        error: "",
        startedAt: 0,
        finishedAt: 0,
      });
    }
    return {
      count,
      workers,
      /* effort scaling 的口径是 lead 的判断，不是硬编码的常量表。 */
      effort: count === 1 ? "单工作者（任务不可拆或太简单）"
        : count <= 3 ? "中等拆解" : "完整拆解",
      subject,
    };
  }

  function start(o = {}) {
    if (!enabled) return { ok: false, error: "专家团模式未开启" };
    const text = str(o.text || o.subject || "", 8000);
    if (!text) return { ok: false, error: "没有任务内容" };
    const plan = decompose(text);
    seq++;
    run = {
      id: `team-${now()}-${seq}`,
      subject: plan.subject,
      phase: "planning",
      createdAt: now(),
      stoppedAt: 0,
      effort: plan.effort,
      lead: { id: LEAD.id, name: LEAD.name, steers: [], notes: [] },
      workers: plan.workers,
      summary: "",
      conflicts: [],
      gaps: [],
    };
    runsTotal++;
    return { ok: true, runId: run.id, plan: publicRun() };
  }

  function current() { return run; }

  function workerOf(id) {
    return run ? run.workers.find((w) => w.id === String(id || "")) || null : null;
  }

  function attachJob(id, jobId) {
    const w = workerOf(id);
    if (!w) return { ok: false, error: "没有这个工作者" };
    w.jobId = str(jobId, 120);
    w.status = "running";
    w.startedAt = now();
    w.steps.push({ at: now(), title: "已派发", note: "分配者把这份子任务交给后台通道", state: "running" });
    if (run) run.phase = "running";
    return { ok: true, workerId: w.id, jobId: w.jobId };
  }

  /* 工作流程 = 一串可展开看的步骤。状态推进只由真实 job 回读驱动，不自己编进度。 */
  function step(id, o = {}) {
    const w = workerOf(id);
    if (!w) return { ok: false, error: "没有这个工作者" };
    const s = { at: now(), title: str(o.title, 80) || "步骤", note: str(o.note, 400), state: str(o.state, 20) || "running" };
    /* 同一状态连续重复不刷屏：轮询每 1.5s 一次，进度没变就别往流程里灌水。 */
    const last = w.steps[w.steps.length - 1];
    if (last && last.title === s.title && last.note === s.note && last.state === s.state) {
      return { ok: true, duplicate: true };
    }
    w.steps.push(s);
    if (w.steps.length > 60) w.steps.shift();
    return { ok: true, steps: w.steps.length };
  }

  /* worker 只回传压缩结果，绝不回传完整轨迹。 */
  function complete(id, o = {}) {
    const w = workerOf(id);
    if (!w) return { ok: false, error: "没有这个工作者" };
    const ok = o.ok !== false;
    w.status = ok ? "done" : "failed";
    w.result = str(o.result, 1200);
    w.error = ok ? "" : str(o.error || o.result, 400);
    w.finishedAt = now();
    w.steps.push({ at: now(), title: ok ? "已回传结果" : "执行失败", note: w.result || w.error || "无", state: w.status });
    return { ok: true, workerId: w.id, status: w.status };
  }

  /**
   * 用户开口的唯一入口：话只说给 lead。
   * lead 判断这句话是「改自己的计划」还是「转给某个 worker」；
   * 无论哪种，worker 收到的都是一条结构化指令，不是和用户的一段对话。
   */
  function steer(o = {}) {
    if (!run) return { ok: false, error: "当前没有进行中的任务" };
    const text = str(o.text, 2000);
    if (!text) return { ok: false, error: "空指令" };
    steersTotal++;
    const rec = { at: now(), text, targets: [] };
    run.lead.steers.push(rec);

    const target = o.workerId ? workerOf(o.workerId) : guessTarget(text, run.workers);
    const replan = /(重来|重新|换个|换种|重排|改计划|拆法|别这么|停下)/.test(text);
    if (replan) {
      run.lead.notes.push({ at: now(), text: "分配者按用户意见调整拆解/汇总口径" });
      rec.targets.push("lead");
    }
    if (target) {
      /* 关键：这里写的是「指令」，不是把用户原话开一段对话给 worker。 */
      target.steers.push({ at: now(), text, from: "lead" });
      target.steps.push({ at: now(), title: "分配者转来指令", note: text, state: "running" });
      rec.targets.push(target.id);
    } else if (!replan) {
      run.lead.notes.push({ at: now(), text: "分配者记下这条意见，用于汇总时取舍" });
      rec.targets.push("lead");
    }
    return { ok: true, targets: rec.targets, workerId: target ? target.id : "", leadNoted: rec.targets.includes("lead") };
  }

  /* 点名识别：工作者名 / w1 / 第 N 个 / 角色名。识别不到就归 lead。 */
  function guessTarget(text, workers) {
    const t = String(text);
    const byId = t.match(/\bw([1-9])\b/i);
    if (byId) return workers.find((w) => w.id.toLowerCase() === `w${byId[1]}`) || null;
    const nth = t.match(/第\s*([一二三四1-4])\s*(个|位|项)/);
    if (nth) {
      const map = { "一": 0, "二": 1, "三": 2, "四": 3, "1": 0, "2": 1, "3": 2, "4": 3 };
      return workers[map[nth[1]]] || null;
    }
    for (const w of workers) {
      if (t.includes(w.name) || t.includes(w.roleId)) return w;
    }
    return null;
  }

  /* aggregate 是推理式汇总的占位契约：不拼接、如实列出缺口/冲突。
     bridge 把 worker 的压缩结果交给 lead 模型后，用 finish() 回填最终答案。 */
  function aggregate() {
    if (!run) return { ok: false, error: "当前没有进行中的任务" };
    const done = run.workers.filter((w) => w.status === "done");
    const pending = run.workers.filter((w) => w.status !== "done");
    run.gaps = pending.map((w) => `${w.name}：${w.status === "failed" ? "执行失败" : "尚未回传结果"}`);
    run.conflicts = [];
    let yes = 0, no = 0;
    for (const w of done) {
      if (/(不可行|做不到|失败|不支持|没有找到)/.test(w.result)) no++;
      if (/(可行|已完成|通过|没问题|已找到)/.test(w.result)) yes++;
    }
    if (yes && no) run.conflicts.push("工作者结论不一致，需要分配者裁定");
    return {
      ok: true, ready: pending.length === 0,
      gaps: run.gaps.slice(), conflicts: run.conflicts.slice(),
      results: done.map((w) => ({ workerId: w.id, name: w.name, result: w.result })),
    };
  }

  function finish(summary) {
    if (!run) return { ok: false, error: "当前没有进行中的任务" };
    run.summary = str(summary, 4000);
    run.phase = "done";
    return { ok: true, summary: run.summary };
  }

  function stop() {
    if (!run) return { ok: true, stopped: false };
    run.phase = "stopped";
    run.stoppedAt = now();
    return { ok: true, stopped: true, runId: run.id };
  }

  /* 面板要的是紧凑状态：不回传完整轨迹，展开某张卡片时再单独取 steps。 */
  function publicRun() {
    if (!run) return null;
    return {
      id: run.id, subject: run.subject, phase: run.phase,
      createdAt: run.createdAt, effort: run.effort,
      lead: { id: run.lead.id, name: run.lead.name, steers: run.lead.steers.length },
      workers: run.workers.map((w) => ({
        id: w.id, name: w.name, roleId: w.roleId, brief: w.brief,
        criterion: w.criterion, budget: w.budget, status: w.status,
        jobId: w.jobId, stepCount: w.steps.length, steers: w.steers.length,
        result: w.result, error: w.error,
      })),
      summary: run.summary,
      gaps: run.gaps.slice(), conflicts: run.conflicts.slice(),
    };
  }

  function workerDetail(id) {
    const w = workerOf(id);
    if (!w) return { ok: false, error: "没有这个工作者" };
    return {
      ok: true,
      worker: { ...w, steps: w.steps.slice(), steers: w.steers.slice() },
    };
  }

  function stats() {
    return {
      enabled, active: !!run && (run.phase === "planning" || run.phase === "running"),
      phase: run ? run.phase : "idle",
      runs: runsTotal, steers: steersTotal,
      workers: run ? run.workers.length : 0,
    };
  }

  return {
    enable, enabled: () => enabled, start, stop, steer,
    attachJob, step, complete, aggregate, finish,
    status: publicRun, workerDetail, stats, decompose,
  };
}

export default { createExpertTeam, LEAD, WORKER_ROLES, WORKER_STATUS };
