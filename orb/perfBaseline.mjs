/* 性能基线：只生成 20×3 采样计划与采集/统计机制，不产生任何结果。
 * 样本不足 complete=false、missing 逐条列出，绝不补假数据、不推算不存在的样本。
 * report 同时给出 TTFT 与 e2e，明确「两者同降才算真缩短」。
 * fs/now 经 opts 注入；写盘为尽力而为的审计日志，失败绝不影响主流程。 */
import * as fsDefault from "node:fs";
import path from "node:path";

const TASK_COUNT = 20;
const RULE = "两者同降才算真缩短：仅当 TTFT 与 e2e 同时下降才算真正缩短；TTFT 降而 e2e 不变只是感知收益。";

function quantile(sorted, p) {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const idx = (n - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
const pct = (arr) => ({
  p50: quantile(arr, 0.5), p95: quantile(arr, 0.95), p99: quantile(arr, 0.99),
});

export function createBaseline(opts = {}) {
  const fs = opts.fs || fsDefault;
  const fileOf = typeof opts.file === "function" ? opts.file : () => (opts.file || null);
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const repeat = Number(opts.repeat) > 0 ? Number(opts.repeat) : 3;

  let planDoc = null;                  // { planId, tasks:[{taskId, repeat, ...}], repeat }
  const results = new Map();           // "taskId#runIndex" -> metrics 副本
  let seq = 0;

  /* 只生成采样计划；不预填任何指标、不产生任何结果。 */
  function plan(tasks) {
    const list = Array.isArray(tasks) ? tasks : [];
    const out = [];
    for (let i = 0; i < TASK_COUNT; i++) {
      const raw = list[i];
      let obj;
      if (raw && typeof raw === "object") obj = { ...raw };
      else if (typeof raw === "string" && raw) obj = { taskId: raw };
      else obj = {};
      const taskId = typeof obj.taskId === "string" && obj.taskId
        ? obj.taskId : `task-${String(i + 1).padStart(2, "0")}`;
      out.push({ ...obj, taskId, repeat });
    }
    const planId = `plan-${now()}-${++seq}`;
    planDoc = { planId, tasks: out, repeat };
    return {
      planId,
      tasks: out.map((t) => ({ ...t })),
      note: `仅生成 ${TASK_COUNT}×${repeat} 采样计划，不产生任何结果；须同时采集 TTFT 与 e2e。${RULE} 缺样本绝不补假数据。`,
    };
  }

  function appendAudit(rec) {
    const f = fileOf();
    if (!f) return;
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.appendFileSync(f, JSON.stringify(rec) + "\n", "utf8");
    } catch { /* 写盘失败绝不影响主流程 */ }
  }

  function record(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    if (!planDoc) return { ok: false, reason: "no-plan" };
    if (a.planId != null && a.planId !== planDoc.planId) return { ok: false, reason: "plan-mismatch" };
    const task = planDoc.tasks.find((t) => t.taskId === a.taskId);
    if (!task) return { ok: false, reason: "unknown-task" };
    const i = Number(a.runIndex);
    if (!Number.isInteger(i) || i < 0 || i >= repeat) return { ok: false, reason: "bad-runIndex" };
    const metrics = a.metrics && typeof a.metrics === "object" ? { ...a.metrics } : {};
    results.set(`${task.taskId}#${i}`, metrics);
    appendAudit({ planId: planDoc.planId, taskId: task.taskId, runIndex: i, metrics, at: now() });
    return { ok: true };
  }

  function coverage() {
    if (!planDoc) return { done: 0, total: 0, ratio: 0 };
    const total = planDoc.tasks.length * repeat;
    let done = 0;
    for (const t of planDoc.tasks) {
      for (let i = 0; i < repeat; i++) if (results.has(`${t.taskId}#${i}`)) done++;
    }
    return { done, total, ratio: total ? done / total : 0 };
  }

  function report() {
    const cov = coverage();
    if (!planDoc) {
      return {
        complete: false,
        coverage: cov,
        byTask: {},
        missing: ["no-plan"],
        warning: `未生成采样计划：complete=false，不补任何假数据。${RULE}`,
      };
    }

    const byTask = {};
    const missing = [];
    for (const t of planDoc.tasks) {
      const tid = t.taskId;
      const e2eVals = [];
      const ttftVals = [];
      let count = 0;
      let fail = 0;
      for (let i = 0; i < repeat; i++) {
        const key = `${tid}#${i}`;
        const m = results.get(key);
        if (!m) { missing.push(key); continue; }
        count++;
        const e = Number(m.e2eMs);
        const f = Number(m.ttftMs);
        if (m.e2eMs != null && Number.isFinite(e)) e2eVals.push(e);
        if (m.ttftMs != null && Number.isFinite(f)) ttftVals.push(f);
        if (m.ok === false) fail++;
      }
      e2eVals.sort((a, b) => a - b);
      ttftVals.sort((a, b) => a - b);
      const e2e = pct(e2eVals);
      const ttft = pct(ttftVals);
      // 顶层 p50/p95/p99/count/failRate 取 e2e；另给出 ttft 与 e2e 两套，绝不互相替代。
      byTask[tid] = {
        p50: e2e.p50, p95: e2e.p95, p99: e2e.p99, count,
        failRate: count ? fail / count : 0,
        ttft: { ...ttft, count: ttftVals.length },
        e2e: { ...e2e, count: e2eVals.length },
      };
    }

    const complete = cov.total > 0 && cov.done === cov.total;
    const warning = complete
      ? `采样完成。${RULE}`
      : `样本不足(未完成)：${cov.done}/${cov.total}，missing 逐条列出；绝不补假数据、不推算不存在的样本。${RULE}`;
    return { complete, coverage: cov, byTask, missing, warning };
  }

  return { plan, record, report, coverage };
}
