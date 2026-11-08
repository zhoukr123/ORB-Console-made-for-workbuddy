/* ---------------- 判据归纳建议（outcomeSuggest） ----------------
 *
 * 为什么需要它：OutcomeGate 判了 ok / failed / needs_review 三档，但**配方不声明
 * `outcome.postconditions` 就只能拿到弱证据**（"界面指纹变了"），或者干脆落
 * needs_review。结果是：想让它自动跑，用户必须自己手写判据 —— 而绝大多数人
 * 不知道该写什么。这一层就是从已有配方里把"其实已经知道的信息"读出来，
 * 给出可直接用的候选判据。
 *
 * 只做静态推导，不跑界面：
 *   · 步骤里录下的窗口标题 → window_state（标题包含）
 *   · 会改界面的动作里带的文件路径 → data_readback（存在 + 非空）
 *   · 兜底 → effect_evidence（只能证明"界面变了"）
 *
 * 刻意保守：
 *   · 从不猜路径。取不到真实路径就不建议 data_readback，绝不拼一个像模像样的假路径。
 *   · 路径里带 {{变量}} 的降为 low —— 运行时才知道落在哪，静态建议容易误导。
 *   · 建议只是"候选"，落不落盘由调用方决定；本模块不写文件、不碰全局。
 */

const MAX_CANDIDATES = 4;
const MAX_READBACK = 3;

/* 能落进配方 outcome 的判据种类。白名单而不是"kind 是字符串就算" ——
   写错一个 kind（比如 checkpoint_readback）会让整条运行永远 needs_review
   （未知判据拿不到观测），而用户只会看到"老是需复核"，查不出是拼写。 */
export const KNOWN_KINDS = Object.freeze(["tree_state", "window_state", "data_readback", "effect_evidence"]);

/* 兜底只读表：调用方没注入 isReadOnly 时用它。
   与 capabilityRegistry 的口径一致，但这里只用于"要不要建议回读"，
   不影响任何执行/治理判断 —— 判据建议猜错最多是条没用的建议，不是安全问题。 */
const FALLBACK_READONLY = new Set([
  "Snapshot", "Screenshot", "DisplayInventory", "Process", "subtitle", "ocr",
]);

const RE_WIN_PATH = /^[A-Za-z]:[\\/][^<>:"|?*\n\r]{1,180}$/;
const RE_UNC_PATH = /^\\\\[^\\<>:"|?*\n\r]+\\[^<>:"|?*\n\r]{1,180}$/;
const RE_HAS_EXT = /\.[A-Za-z0-9]{1,8}$/;
const RE_VAR = /\{\{|\$\{/;

/* 步骤里可能存路径的字段名。宁可多列几个键，也不去模糊匹配所有字符串值 ——
   逐个键取是确定的，猜字符串会挑出菜单文字、提示语这类假路径。 */
const PATH_KEYS = ["path", "file", "filepath", "fileName", "filename", "savePath", "target", "dst", "dest", "output"];

/**
 * 归纳候选判据。
 * @param {object} wf 配方（steps / graph / outcome）
 * @param {object} opts { isReadOnly?(server, tool) => boolean }
 * @returns {{ ok:boolean, candidates:Array, notes:string[], existing:number }}
 */
export function suggestOutcomes(wf, opts = {}) {
  const w = wf && typeof wf === "object" ? wf : {};
  const isReadOnly = typeof opts.isReadOnly === "function" ? opts.isReadOnly : defaultReadOnly;
  const notes = [];
  const existing = Array.isArray(w?.outcome?.postconditions) ? w.outcome.postconditions.length : 0;
  if (existing > 0) {
    /* 已经有判据就不再建议 —— 覆盖用户写好的东西是这里最不该做的事。 */
    return { ok: true, candidates: [], notes: ["配方已声明 " + existing + " 条判据，不再给建议（避免盖掉你写好的）"], existing };
  }

  const steps = collectActions(w);

  const candidates = [];
  if (!steps.length) {
    notes.push("配方里没有可分析的动作步骤");
  }

  /* ---- 一、窗口状态：录制时存下的窗口标题是最可靠的一条线索 ---- */
  const titles = new Map();
  for (const s of steps) {
    const t = String((s && s.win && s.win.title) || "").trim();
    if (t.length >= 2) titles.set(t, (titles.get(t) || 0) + 1);
  }
  if (titles.size) {
    const [best, n] = [...titles.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = n / steps.length;
    candidates.push({
      kind: "window_state",
      postcondition: { kind: "window_state", titleIncludes: best },
      confidence: share >= 0.5 ? "high" : "medium",
      source: "step.win.title",
      why: share >= 0.5
        ? `${Math.round(share * 100)}% 的步骤都录自这个窗口「${best}」，收尾时它应当还在`
        : `有 ${n} 步录自窗口「${best}」，但占比只有 ${Math.round(share * 100)}%，不一定是收尾目标`,
    });
  } else {
    notes.push("步骤里没有窗口信息（老配方），无法建议窗口判据");
  }

  /* ---- 二、文件回读：会改界面的动作带的路径，最可能产生可核对的产物 ---- */
  let readback = 0;
  const seenPath = new Set();
  for (const s of steps) {
    if (readback >= MAX_READBACK) break;
    const server = String(s.server || "");
    const tool = String(s.tool || "");
    if (isReadOnly(server, tool)) continue;      // 只读动作不产生文件
    const args = s.args && typeof s.args === "object" ? s.args : {};
    for (const key of PATH_KEYS) {
      const raw = args[key];
      if (typeof raw !== "string") continue;
      const p = raw.trim();
      if (!p || seenPath.has(p)) continue;
      if (!(RE_WIN_PATH.test(p) || RE_UNC_PATH.test(p))) continue;
      if (!RE_HAS_EXT.test(p)) continue;         // 目录名排除：目录存在几乎恒真，没有判别力
      seenPath.add(p);
      const variable = RE_VAR.test(p);
      candidates.push({
        kind: "data_readback",
        postcondition: { kind: "data_readback", path: p, exists: true, minBytes: 1 },
        confidence: variable ? "low" : "medium",
        source: `step.args.${key}`,
        why: variable
          ? `路径「${p}」含变量，运行时才确定落在哪；建议改成固定路径后再用`
          : `「${tool}」会动这个文件；回读它存在且非空，比"界面变了"硬得多`,
      });
      readback++;
      break;                                     // 一步只取一个路径
    }
  }
  if (!readback && steps.length) {
    notes.push("没有从会改界面的动作里找到具体文件路径（可能这步只改界面、不落文件）");
  }

  /* ---- 三、兜底：什么都归纳不出来时，至少能声明"必须观察到变化" ---- */
  if (!candidates.length) {
    candidates.push({
      kind: "effect_evidence",
      postcondition: { kind: "effect_evidence" },
      confidence: "low",
      source: "fallback",
      why: "只能证明整条运行确实改变了界面；比没有判据强，但仍然无法确认改成了什么",
    });
  }

  const out = candidates.slice(0, MAX_CANDIDATES);
  if (candidates.length > out.length) {
    notes.push(`候选 ${candidates.length} 条，只保留前 ${MAX_CANDIDATES} 条（判据过多会互相打架、也难排查）`);
  }
  return { ok: true, candidates: out, notes, existing: 0 };
}

/** 把候选拼成可直接写进配方的 outcome 段。只取 postconditions，不动其它字段。 */
export function buildOutcome(candidates, opts = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((c) => (c && c.postcondition) || null)
    /* 白名单过滤：未知 kind 一律丢弃，而不是留给运行时变成"永远拿不到观测"。 */
    .filter((p) => p && typeof p === "object" && KNOWN_KINDS.includes(String(p.kind || "")));
  const max = Math.max(1, Number(opts.max) || MAX_CANDIDATES);
  return { postconditions: list.slice(0, max) };
}

/** 纯文本摘要，给面板/日志直接用，避免各处再写一遍措辞。 */
export function describeSuggestion(s) {
  const conf = { high: "高", medium: "中", low: "低" };
  const list = Array.isArray(s && s.candidates) ? s.candidates : [];
  return list.map((c) => `[${conf[c && c.confidence] || (c && c.confidence) || "?"}] ${(c && c.why) || ""}`).join("\n");
}

/* ---------------- 内部 ---------------- */

/** 收集所有"真会调工具"的动作：普通步骤 + 编排图里 step 节点自带/继承的步骤。 */
function collectActions(wf) {
  const out = [];
  const push = (s) => { if (s && typeof s === "object" && s.tool) out.push(s); };

  for (const s of Array.isArray(wf.steps) ? wf.steps : []) push(s);

  const nodes = Array.isArray(wf?.graph?.nodes) ? wf.graph.nodes : [];
  for (const n of nodes) {
    if (!n || String(n.kind || "step") !== "step") continue;
    const body = Array.isArray(n.steps) ? n.steps : [];
    for (const s of body) push(s);
  }
  return out;
}

function defaultReadOnly(server, tool) {
  if (FALLBACK_READONLY.has(String(tool || ""))) return true;
  return false;
}

export default { suggestOutcomes, buildOutcome, describeSuggestion };
