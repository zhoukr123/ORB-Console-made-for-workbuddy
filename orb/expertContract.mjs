/* 专家契约（expertBook）：把"这个专家能做什么"从散落的代码变成一份可校验的声明。
 *
 * 解决的是三类具体事故，不是抽象洁癖：
 *   ① **只读专家偷偷动手**：一个本该"只看不改"的评审视角，如果它能拿到
 *      会写盘的执行通道，那它给出的"没问题"就没有任何意义 —— 因为它自己改过了。
 *      所以 actionScope 由 arbiter 强制，越权请求在派发口就被剥掉，不是靠自觉。
 *   ② **嵌套无限深**：专家拆任务再交给专家，不加深度上限就是一个能把自己
 *      撑爆的递归。maxNestedDepth 写进契约，超过就拒。
 *   ③ **检查点缺失**：动手前该有 freeze（把当前状态钉住），做完该有 check
 *      （对着钉住的状态核一遍）。这两步不写进契约，就一定会在赶工时被跳过。
 *
 * 设计取舍：
 *   · 默认值是**最保守**的那一档（只读、嵌套 0、检查点齐全），
 *     放宽必须显式写在覆盖文件里 —— 默认宽的东西没人会去收紧。
 *   · 覆盖文件是 JSON（DATA_DIR/expertBook.json），因为它要能被用户改；
 *     但解析失败**绝不降级成"没有契约"**，而是整份退回默认并报出原因：
 *     "读不懂你的契约所以全部放开"是最危险的失败方式。
 *   · 所有判定都是纯函数，不碰 fs（load 时才碰）。测试用内存对象就能重放。
 */
import * as fsDefault from "node:fs";
import path from "node:path";

/* 「只许观察」的默认契约。注意 scope 的语义是**上限**，不是"只能做这些"：
 * read-only 表示一次写操作都不许提；observe+read 之外的能力必须显式授予。 */
export const DEFAULT_CONTRACT = Object.freeze({
  actionScope: "read-only",     // read-only | propose | execute
  maxNestedDepth: 0,            // 0 = 不许再往下派
  checkpoints: Object.freeze(["freeze", "check"]),
});

export const SCOPES = Object.freeze(["read-only", "propose", "execute"]);

/* 每个内置专家在契约里的默认档位：
 * 五个评审视角都是"只许看"—— 它们的产出是发现（finding），不是动作。
 * 需要动手的场合由主链路执行，不由评审视角代劳。 */
export const DEFAULT_BOOK = Object.freeze({
  version: 1,
  experts: Object.freeze({
    arch: { actionScope: "read-only", maxNestedDepth: 0, checkpoints: ["freeze", "check"] },
    sec: { actionScope: "read-only", maxNestedDepth: 0, checkpoints: ["freeze", "check"] },
    ux: { actionScope: "read-only", maxNestedDepth: 0, checkpoints: ["freeze", "check"] },
    perf: { actionScope: "read-only", maxNestedDepth: 0, checkpoints: ["freeze", "check"] },
    correct: { actionScope: "read-only", maxNestedDepth: 0, checkpoints: ["freeze", "check"] },
    "core-team": { actionScope: "read-only", maxNestedDepth: 1, checkpoints: ["freeze", "check"] },
  }),
});

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** 规范化一个专家的契图片段：非法值一律落回默认，并记下被忽略的字段。 */
export function normalizeContract(raw, base = DEFAULT_CONTRACT) {
  const o = isObj(raw) ? raw : {};
  const scope = SCOPES.includes(o.actionScope) ? o.actionScope : base.actionScope;
  const depth = Number.isInteger(o.maxNestedDepth) && o.maxNestedDepth >= 0
    ? Math.min(o.maxNestedDepth, 5)
    : base.maxNestedDepth;
  const cps = Array.isArray(o.checkpoints)
    ? o.checkpoints.map((x) => String(x)).filter((x) => x === "freeze" || x === "check")
    : [...base.checkpoints];
  /* freeze/check 是"动手前后"这一对，缺一个就没有意义：
   * 只有 check 没有 freeze，核的时候已经没得比了；反之钉住了不核，钉它干什么。 */
  const checkpoints = cps.length ? [...new Set(cps)] : [...base.checkpoints];
  return { actionScope: scope, maxNestedDepth: depth, checkpoints };
}

/**
 * 仲裁：专家提一个动作，能不能提。
 * @param {object} contract 该专家的契约（已 normalize）
 * @param {object} ask { tool, readOnly, nestedDepth }
 * @returns {{allow:boolean, reason:string}}
 *
 * 只读专家提写操作 → 拒。理由字符串写死，便于日志与测试对齐 ——
 * 这类拒绝必须能在日志里一眼 grep 到，否则"为什么没执行"永远查不清。
 */
export function arbitrate(contract, ask = {}) {
  const c = normalizeContract(contract);
  const a = isObj(ask) ? ask : {};
  const tool = String(a.tool ?? "");
  const readOnly = a.readOnly === true;

  if (c.actionScope === "read-only" && !readOnly) {
    return { allow: false, reason: "scope-read-only", detail: `只读专家不得调用写操作（${tool || "未知工具"}）` };
  }
  const depth = Number.isInteger(a.nestedDepth) && a.nestedDepth >= 0 ? a.nestedDepth : 0;
  if (depth > c.maxNestedDepth) {
    return { allow: false, reason: "nested-too-deep", detail: `嵌套 ${depth} 层超过上限 ${c.maxNestedDepth}` };
  }
  /* execute 档也必须先 freeze：没有"钉住现状"这一步，后面的结果无法归因
   * 到底是专家做的还是本来就这样。propose 档不要求 —— 它只是提建议。 */
  if (c.actionScope === "execute" && !c.checkpoints.includes("freeze")) {
    return { allow: false, reason: "missing-freeze", detail: "可执行档必须先 freeze 现状才能动手" };
  }
  return { allow: true, reason: "ok", detail: "" };
}

export function createExpertBook(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const fs = o.fs || fsDefault;
  const fileOf = typeof o.file === "function" ? o.file : () => (o.file || null);

  let book = { version: DEFAULT_BOOK.version, experts: { ...DEFAULT_BOOK.experts } };
  let source = "default";
  let warning = "";

  /** 读覆盖文件。读不到/读不懂**都退回默认**，并把原因留在 warning 里。 */
  function load() {
    const f = fileOf();
    book = { version: DEFAULT_BOOK.version, experts: { ...DEFAULT_BOOK.experts } };
    source = "default";
    warning = "";
    if (!f) return { ok: true, source, experts: Object.keys(book.experts).length };
    let raw = "";
    try { raw = fs.readFileSync(f, "utf8"); } catch (e) {
      // 文件不存在是正常情况（还没配过），不是错误。
      if (e && e.code !== "ENOENT") warning = `读取失败：${e.message}`;
      return { ok: !warning, source, warning, experts: Object.keys(book.experts).length };
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      /* 解析失败必须说出来。悄悄退回默认会让人以为"我配的生效了"。 */
      warning = `expertBook.json 解析失败（${e.message}），已整份退回默认契约`;
      return { ok: false, source, warning, experts: Object.keys(book.experts).length };
    }
    if (!isObj(parsed) || !isObj(parsed.experts)) {
      warning = "expertBook.json 结构不对（需要 { experts: {...} }），已整份退回默认契约";
      return { ok: false, source, warning, experts: Object.keys(book.experts).length };
    }
    const merged = { ...book.experts };
    for (const [id, c] of Object.entries(parsed.experts)) {
      if (!id) continue;
      merged[id] = normalizeContract(c, merged[id] || DEFAULT_CONTRACT);
    }
    book = { version: Number(parsed.version) || DEFAULT_BOOK.version, experts: merged };
    source = "file";
    return { ok: true, source, experts: Object.keys(merged).length };
  }

  function get(expertId) {
    const id = String(expertId ?? "");
    return normalizeContract(book.experts[id], DEFAULT_CONTRACT);
  }

  function has(expertId) {
    return Object.prototype.hasOwnProperty.call(book.experts, String(expertId ?? ""));
  }

  function list() {
    return Object.entries(book.experts).map(([id, c]) => ({ expertId: id, ...normalizeContract(c) }));
  }

  /* 只读专家集合：给桥做"派发口拦截"用，避免每次调用都查一遍表。 */
  function readOnlySet() {
    const s = new Set();
    for (const [id, c] of Object.entries(book.experts)) {
      if (normalizeContract(c).actionScope === "read-only") s.add(id);
    }
    return s;
  }

  function stats() {
    const rows = list();
    return {
      version: book.version,
      source,
      warning,
      experts: rows.length,
      readOnly: rows.filter((r) => r.actionScope === "read-only").length,
      maxDepth: rows.reduce((m, r) => Math.max(m, r.maxNestedDepth), 0),
    };
  }

  return { load, get, has, list, readOnlySet, stats, file: fileOf };
}

/** 生成文档表格（确定性，供单测与 docs/expertBook.md 逐字比对）。 */
export function toMarkdown(book = DEFAULT_BOOK) {
  const rows = Object.entries(book.experts).map(([id, c]) => {
    const n = normalizeContract(c);
    return `| \`${id}\` | ${n.actionScope} | ${n.maxNestedDepth} | ${n.checkpoints.join(" / ") || "—"} |`;
  });
  return [
    "# 专家契约（自动生成，勿手改）",
    "",
    "> 由 `orb/expertContract.mjs` 生成。要改契约请改 `orb/expertContract.mjs` 的 `DEFAULT_BOOK`",
    "> 或在 `expertBook.json` 里覆盖（运行目录下），然后跑 `node orb/tools/gen-expertbook-doc.mjs`。",
    "",
    "| 专家 | 动作范围 | 嵌套上限 | 检查点 |",
    "|---|---|---:|---|",
    ...rows,
    "",
    "## 三档动作范围的含义",
    "",
    "- `read-only`：只许观察与提发现。任何写操作在派发口就被拒（`scope-read-only`）。",
    "- `propose`：可以提方案与候选动作，但不能自己执行。",
    "- `execute`：可以执行，但**必须先 freeze**（钉住现状），否则拒绝（`missing-freeze`）。",
    "",
    "默认档位一律是最保守的一档。放宽必须显式写在覆盖文件里 ——",
    "默认宽的东西没人会去收紧，而这类放宽的代价是「专家自己改过了，所以它说没问题」。",
    "",
  ].join("\n");
}

/** 覆盖文件路径（桥在启动时用）。放运行目录下，随用户配置走。 */
export function defaultBookPath(dataDir) {
  return path.join(String(dataDir || "."), "expertBook.json");
}
