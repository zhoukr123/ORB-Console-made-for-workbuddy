/* ---------------- 断点续跑（wfCheckpoint） ----------------
 *
 * 补的是「跑到第 5 步挂了，重跑就得从第 1 步再来」这个洞。听着像个功能，
 * 实际是**安全功能**：桌面 GUI 的动作不可逆，从第 1 步重跑等于把已经做过的
 * 「提交 / 删除 / 发送」再做一遍。所以续跑的难点从来不是"怎么接着跑"，
 * 而是"凭什么确定前面那些步真的做完了"。
 *
 * 三条纪律，缺一不可：
 *
 *   ① **只认已确认的边界**。断点记的是「最后一个确认成功的顶层步」，
 *      而不是"跑到了第几步"。调用方必须用 receipts 核对最后一步已结算，
 *      对不上就拒绝续跑 —— 状态不明时，重做比不做危险。
 *
 *   ② **含控制流的配方不给续跑**。loop / if / subflow / graph 的中断点可能
 *      落在循环体内部，而顶层索引只能表达「整个 loop 步未完成」；从那里续跑
 *      会把整个循环重跑一遍。循环体里若藏着不可逆动作，就是重复提交。
 *      录制产出的线性宏覆盖了绝大多数真实用法，先只支持它。
 *
 *   ③ **配方改过就不认旧断点**。原来只比步数，步数一样但内容改了就查不出来 ——
 *      这正是 Temporal 讲的非确定性来源：代码变了、还有在跑的历史。
 *      现在存一份**内容指纹**（stepsDigest）并逐字比对，改一个坐标也算改过。
 *
 * 存储：<dir>/<配方名>.json，一个配方一个断点（后写覆盖）。
 * 断点本来就是"这条配方最新可用的位置"，留历史只会让人不知道该信哪个。
 */

import fsDefault from "node:fs";
import path from "node:path";
import { argsFingerprint } from "./autoRetry.mjs";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/* 会让顶层索引失效的节点类型。loop / if 的 body 在同一个顶层步里被多次执行，
   中断点可能落在 body 中间 —— 那种位置无法用顶层索引表达。 */
const CONTROL_FLOW_TYPES = new Set(["loop", "if", "subflow"]);

export const RESUME_BLOCK = Object.freeze({
  NO_WORKFLOW: "no_workflow",
  NO_CHECKPOINT: "no_checkpoint",
  HAS_CONTROL_FLOW: "has_control_flow",
  GRAPH_RECIPE: "graph_recipe",
  RECIPE_CHANGED: "recipe_changed",
  INDEX_ZERO: "index_zero",
  INDEX_OUT_OF_RANGE: "index_out_of_range",
  STALE: "stale",
});

/* 保留 Unicode 字母与数字（中文配方名不能全变下划线），折叠连续点、去首尾点横线，
   防 `..` 片段与跨目录写入。与 autoTrace / wfRecipeVersions 同一套规则。 */
function safeName(s) {
  const t = String(s || "")
    .replace(/[^\p{L}\p{N}_.-]/gu, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[.\-]+|[.\-]+$/g, "")
    .slice(0, 100);
  return t || "_";
}

/**
 * 配方内容指纹。只回答「配方改没改」，不是安全用途，用现成的稳定指纹函数即可。
 * 为什么不能只比步数：步数一样、内容变了的配方多得是（改了坐标、换了锚点、调了等待），
 * 那种情况下断点索引看着"对得上"，续跑却会从错的地方接上。Temporal 把这类问题归到
 * 非确定性：代码变更遇上未完成的历史，重放就会走岔。做法一样 —— 比内容，不比形状。
 */
export function recipeDigest(wfOrSteps) {
  const steps = Array.isArray(wfOrSteps) ? wfOrSteps : (wfOrSteps && wfOrSteps.steps);
  try {
    return argsFingerprint(Array.isArray(steps) ? steps : []);
  } catch {
    return "";   // 算不出来就返回空 —— 上层会当成"无法核对内容"而收紧，不会误放行
  }
}

/**
 * 这条配方能不能用顶层索引续跑。
 * 纯判断，不看断点 —— 面板要提前告诉用户「这条不支持续跑」，而不是等点了才报错。
 */
export function isLinearRecipe(wf) {
  const w = wf && typeof wf === "object" ? wf : null;
  if (!w) return { ok: false, code: RESUME_BLOCK.NO_WORKFLOW, reason: "配方为空" };
  if (w.graph && typeof w.graph === "object") {
    return { ok: false, code: RESUME_BLOCK.GRAPH_RECIPE, reason: "编排图配方（节点内可能多次执行同一段）不支持续跑" };
  }
  const steps = Array.isArray(w.steps) ? w.steps : [];
  const bad = steps.find((s) => s && CONTROL_FLOW_TYPES.has(String(s.type || "")));
  if (bad) {
    const t = String(bad.type);
    return {
      ok: false,
      code: RESUME_BLOCK.HAS_CONTROL_FLOW,
      reason: `含 ${t} 节点：中断可能落在循环/分支内部，从顶层步续跑会把整段重跑一遍`,
    };
  }
  return { ok: true, code: "", reason: "" };
}

/**
 * 续跑安全门。纯函数：断点记录由调用方传入，是否已结算由调用方核对后置入 opts。
 * @param {object} wf 配方
 * @param {object|null} cp 断点记录
 * @param {object} opts { now, maxAgeMs, lastSettled }
 *   lastSettled：调用方核对 receipts 的结果。false = 断点前那步状态不明 → 拒绝。
 *   不传视为"未核对"，同样拒绝 —— 默认收紧，不默认放行。
 */
export function canResume(wf, cp, opts = {}) {
  const linear = isLinearRecipe(wf);
  if (!linear.ok) return { ok: false, code: linear.code, reason: linear.reason };
  const w = wf;
  const steps = Array.isArray(w.steps) ? w.steps : [];
  if (!steps.length) return { ok: false, code: RESUME_BLOCK.NO_WORKFLOW, reason: "配方没有步骤" };
  if (!cp || typeof cp !== "object") {
    return { ok: false, code: RESUME_BLOCK.NO_CHECKPOINT, reason: "没有断点记录" };
  }

  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const maxAge = Number(opts.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : DEFAULT_MAX_AGE_MS;
  if (now() - (Number(cp.at) || 0) > maxAge) {
    return { ok: false, code: RESUME_BLOCK.STALE, reason: "断点已过期（超过保留期），界面状态多半早就变了" };
  }

  const total = Number(cp.total) || 0;
  if (total && total !== steps.length) {
    return {
      ok: false, code: RESUME_BLOCK.RECIPE_CHANGED,
      reason: `配方改过了（断点记录 ${total} 步，现在 ${steps.length} 步），旧索引不可信`,
    };
  }

  const next = Number(cp.nextIndex);
  if (!Number.isFinite(next) || next <= 0) {
    return { ok: false, code: RESUME_BLOCK.INDEX_ZERO, reason: "断点在第 0 步，等于从头跑，不叫续跑" };
  }
  if (next >= steps.length) {
    return {
      ok: false, code: RESUME_BLOCK.INDEX_OUT_OF_RANGE,
      reason: `断点在第 ${next} 步，已到/超过末尾（共 ${steps.length} 步），没有剩余步骤`,
    };
  }

  /* 步数一样不算"没改过"。内容指纹对不上就认为改过 —— 宁可让人从头跑一遍，
     也别从"看着对得上、其实是另一步"的位置接上去。 */
  const want = String(cp.stepsDigest || "");
  if (!want) {
    return {
      ok: false, code: RESUME_BLOCK.RECIPE_CHANGED,
      reason: "断点里没有内容指纹（旧版断点），无法确认配方没被改过 —— 从头跑更安全",
    };
  }
  const got = recipeDigest(steps);
  if (!got || got !== want) {
    return {
      ok: false, code: RESUME_BLOCK.RECIPE_CHANGED,
      reason: "配方内容变过了（步数可能一样，但有步骤被改过），断点索引不再可信",
    };
  }

  /* 状态不明就不续：宁可让人从头确认一遍，也不赌"那步大概做完了"。 */
  if (opts.lastSettled !== true) {
    return {
      ok: false, code: "state_unconfirmed",
      reason: "断点前那一步没有已结算的执行收据，无法确认它真的做完了 —— 重做可能重复提交",
    };
  }

  return { ok: true, code: "", reason: `可从第 ${next + 1} 步继续（共 ${steps.length} 步）`, nextIndex: next };
}

export function createCheckpoints(opts = {}) {
  const fs = opts.fs || fsDefault;
  const dir = String(opts.dir || "");
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const maxAgeMs = Number(opts.maxAgeMs) > 0 ? Number(opts.maxAgeMs) : DEFAULT_MAX_AGE_MS;

  if (!dir) throw new Error("wfCheckpoint: dir 必填");

  const fileOf = (name) => path.join(dir, `${safeName(name)}.json`);

  /** 原子写：断电不能留半截断点 —— 半截 JSON 读不出来，会被当成"没有断点"。
      读不出来时把它当成明确没有，比"文件在但内容坏掉"更可预期。 */
  function save(runId, rec = {}) {
    const wf = String(rec.workflow || "");
    if (!wf) return { ok: false, error: "workflow 必填" };
    const next = Number(rec.nextIndex);
    if (!Number.isFinite(next) || next < 0) return { ok: false, error: "nextIndex 必须是 >=0 的数字" };
    const body = {
      workflow: wf,
      runId: String(runId || ""),
      nextIndex: Math.floor(next),
      total: Number(rec.total) || 0,
      stepsDigest: String(rec.stepsDigest || ""),
      vars: rec.vars && typeof rec.vars === "object" ? rec.vars : {},
      lastIdem: String(rec.lastIdem || ""),
      reason: String(rec.reason || ""),
      at: now(),
    };
    const f = fileOf(wf);
    const tmp = f + ".tmp";
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(body), "utf8");
      fs.renameSync(tmp, f);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* 清不掉就算了，下次覆盖 */ }
      return { ok: false, error: String(err?.message ?? err) };
    }
    return { ok: true, checkpoint: body };
  }

  function get(name) {
    try {
      const j = JSON.parse(fs.readFileSync(fileOf(name), "utf8"));
      if (!j || typeof j !== "object") return null;
      return {
        workflow: String(j.workflow || name),
        runId: String(j.runId || ""),
        nextIndex: Number(j.nextIndex) || 0,
        total: Number(j.total) || 0,
        stepsDigest: String(j.stepsDigest || ""),
        vars: j.vars && typeof j.vars === "object" ? j.vars : {},
        lastIdem: String(j.lastIdem || ""),
        reason: String(j.reason || ""),
        at: Number(j.at) || 0,
      };
    } catch { return null; }
  }

  function clear(name) {
    try { fs.unlinkSync(fileOf(name)); return { ok: true }; }
    catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
  }

  function list() {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const out = [];
    for (const f of names) {
      if (!f.endsWith(".json")) continue;
      const rec = get(f.slice(0, -5));
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /** 清掉过期断点。不主动删"看起来没用"的 —— 断点是失败后的救命记录。 */
  function sweep() {
    let removed = 0;
    for (const rec of list()) {
      if (now() - rec.at > maxAgeMs) {
        if (clear(rec.workflow).ok) removed++;
      }
    }
    return { ok: true, removed };
  }

  function stats() {
    const all = list();
    return { total: all.length, maxAgeMs };
  }

  return { save, get, clear, list, sweep, stats, fileOf };
}

export default { RESUME_BLOCK, isLinearRecipe, canResume, recipeDigest, createCheckpoints };
