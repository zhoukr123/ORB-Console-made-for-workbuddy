/* ---------------- 自由路由（FreeTier） ----------------
 *
 * 桌面动作（"用 X 打开 Y" / "运行 X" / "写文件"）的**通道选择层**：
 *   · 优先走【命令通道】（cmdchan：文件 + 进程，不碰鼠标/键盘/剪贴板/窗口焦点，
 *     不占 GUI 独占锁，可与 GUI 任务并行）；
 *   · 命令通道走不通时，**自动回落到【GUI 模拟通道】**（windows-mcp 真实桌面自动化，
 *     经 GUI 独占锁串行化，避免和别的键鼠操作打架）。
 *
 * 为什么单独成文件、且把 cmd/gui 都做成注入：
 *   bridge 是 5700 行的单体，GUI 的实现细节（callTool 调哪个工具、参数长啥样）
 *   不该渗进路由逻辑；路由只关心"先试命令、失败再试 GUI"。
 *   依赖注入后，单测里用假 cmd / 假 gui 就能把两条分支都覆盖，不依赖真桌面。
 *
 * 不在这里做的事：
 *   · 危险操作闸门（DANGER_TOOLS / waitApproval）留在调用方（/api/act）统一处理，
 *     与 /api/cmd 同机制，避免两套闸门逻辑漂移。
 *   · 意图的"自然语言理解"只做最轻量的正则（parseOpenIntent），
 *     复杂语义交给上层 agent，这里只认结构化 intent 或「用 X 打开 Y」这类固定句式。
 */

import { runCommandOp, normalizeCmdOp } from "./cmdchan.mjs";

/** 归一化 intent：补全缺省字段、统一大小写、把 args 规整成数组。 */
export function normalizeIntent(intent) {
  if (!intent || typeof intent !== "object") return null;
  const op = String(intent.op || "").toLowerCase();
  const out = {
    op,
    app: String(intent.app || "").trim(),
    command: String(intent.command || "").trim(),
    filePath: String(intent.filePath || "").trim(),
    content: intent.content == null ? "" : String(intent.content),
    encoding: String(intent.encoding || "utf8").trim() || "utf8",
    from: String(intent.from || "").trim(),
    to: String(intent.to || "").trim(),
    overwrite: intent.overwrite === true,
    args: [],
  };
  if (intent.args != null) {
    out.args = Array.isArray(intent.args)
      ? intent.args.map(String)
      : [String(intent.args)];
  }
  // "open" 且给了 app 没给 command：command 默认等于 app
  if (op === "open" && !out.command && out.app) out.command = out.app;
  // "launch" 且给了 app 没给 command：command 默认等于 app
  if (op === "launch" && !out.command && out.app) out.command = out.app;
  return out;
}

/**
 * 极轻量意图解析：把「用 X 打开 Y」「打开 Y」「运行 X」这类固定句式翻成结构化 intent。
 * 返回 null 表示识别不出——调用方据此报错，不去瞎猜。
 * 复杂语义（"帮我把刚下的报告用 Excel 打开"）交给上层 agent 预处理成结构化 intent。
 */
/* 动作词表：[词, 是否"运行"类]。用 indexOf 定位而不是惰性正则 ——
   正则版在长文本上会因"每个 用/打开 都展开一次"而 O(n²)（实测 20KB 要 57ms）。 */
const OPEN_VERBS = [["打开", false], ["开启", false], ["运行", true], ["启动", true]];

export function parseOpenIntent(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  // 找最早出现的动作词（线性）
  let verb = "";
  let at = -1;
  let isRun = false;
  for (const [v, run] of OPEN_VERBS) {
    const i = t.indexOf(v);
    if (i >= 0 && (at < 0 || i < at)) { at = i; verb = v; isRun = run; }
  }
  if (at < 0) return null;

  /* 只取动作词附近的窗口：app 名紧贴动作词之前，路径/命令紧跟其后。
     窗口化保证任何长度输入都是**常数级**成本，不会随文本变长而变慢。 */
  const before = t.slice(Math.max(0, at - 200), at).trim();
  let after = t.slice(at + verb.length, at + verb.length + 400).trim();

  // "用 X" 前缀（在动作词之前）
  let app = "";
  const mPre = before.match(/用\s*(.+)$/);
  if (mPre) app = mPre[1].trim();

  // 尾部 "用 X"（如「打开 Y 用 X」）
  let appTrail = "";
  const mTrail = after.match(/\s+用\s+(.+)$/);
  if (mTrail) {
    appTrail = mTrail[1].trim();
    after = after.slice(0, mTrail.index).trim();
  }

  if (isRun) {
    if (app) return after ? { op: "launch", command: app, args: [after] } : { op: "launch", command: app, args: [] };
    if (!after) return null;
    return { op: "launch", command: after };
  }

  // open
  if (!after) return null;
  return { op: "open", app: app || appTrail, filePath: after };
}

/**
 * 把结构化 intent 翻成 cmdchan 的操作体（给 runCommandOp 吃）。
 * 三种基础动作：
 *   write  → { write: { filePath, content, encoding } }
 *   open   → { openWith: { app, filePath } }（app 为空 = 用系统默认关联打开）
 *   launch → { launch: { command, args } }
 */
export function intentToCmdOp(intent) {
  const it = normalizeIntent(intent);
  if (!it) throw new Error("intentToCmdOp: 无法识别的 intent");
  if (it.op === "write") {
    if (!it.filePath) throw new Error("write 意图需要 filePath");
    return { write: { filePath: it.filePath, content: it.content, encoding: it.encoding } };
  }
  if (it.op === "open") {
    if (it.app && it.filePath) return { openWith: { app: it.app, filePath: it.filePath } };
    if (it.filePath) return { openWith: { app: "", filePath: it.filePath } }; // 默认关联
    if (it.app) return { launch: { command: it.app, args: [] } };
  }
  if (it.op === "launch") {
    if (!it.command) throw new Error("launch 意图需要 command/app");
    return { launch: { command: it.command, args: it.args || [] } };
  }
  if (it.op === "copy" || it.op === "move" || it.op === "rename") {
    if (!it.from || !it.to) throw new Error(`${it.op} 意图需要 from / to`);
    return { [it.op]: { from: it.from, to: it.to, overwrite: !!it.overwrite } };
  }
  throw new Error("intentToCmdOp: 不支持的意图 " + JSON.stringify(it));
}

/**
 * 创建自由路由实例。
 * @param {object} opts
 * @param {object} [opts.cmd]   命令通道适配器，默认 cmdchan 的 { runCommandOp, normalizeCmdOp }
 * @param {function} [opts.gui]  GUI 模拟适配器：async (intent) => result，命令通道失败时被调
 * @param {object} [opts.guiLock] 可选 GUI 独占锁；有则 GUI 回退在 withLock 内执行
 * @param {function} [opts.log]   日志
 */
export function createFreeTier(opts = {}) {
  const log = opts.log || (() => {});
  const cmd = opts.cmd || { runCommandOp, normalizeCmdOp };
  const gui = typeof opts.gui === "function" ? opts.gui : null;
  const guiLock = opts.guiLock || null;

  /**
   * 主入口：给定 intent（对象）或意图文本，先试命令通道，失败回落 GUI。
   * @returns {Promise<{via:'command'|'gui', intent:object, result:any, commandError?:string}>}
   * @throws 命令通道与 GUI 均失败时，抛出合并了两条错误信息的 Error
   */
  async function route(intentOrText, o = {}) {
    let intent = typeof intentOrText === "string"
      ? parseOpenIntent(intentOrText)
      : normalizeIntent(intentOrText);
    if (!intent) {
      throw new Error("无法识别的意图：" + (typeof intentOrText === "string" ? intentOrText : JSON.stringify(intentOrText)));
    }

    // ① 优先：命令通道（文件 + 进程，无 GUI 副作用）
    let cmdErr = null;
    try {
      const op = normalizeCmdOp(intentToCmdOp(intent));
      const result = await cmd.runCommandOp(op);
      log(`[freetier] 命令通道成功：${intent.op} → ${intent.app || intent.command || intent.filePath}`);
      return { via: "command", intent, result };
    } catch (e) {
      cmdErr = e;
      log(`[freetier] 命令通道失败，准备回落 GUI：${e?.message ?? e}`);
    }

    // ② 回落：GUI 模拟通道（真实桌面自动化，需 GUI 独占锁）
    if (!gui) {
      throw new Error(`命令通道失败且无 GUI 回退可用：${cmdErr?.message ?? cmdErr}`);
    }
    try {
      const run = () => gui(intent);
      const result = guiLock ? await guiLock.withLock("freetier", run) : await run();
      return {
        via: "gui",
        intent,
        result,
        commandError: String(cmdErr?.message ?? cmdErr),
      };
    } catch (guiErr) {
      throw new Error(
        `命令通道与 GUI 模拟均失败：命令通道=${cmdErr?.message ?? cmdErr}；GUI=${guiErr?.message ?? guiErr}`,
      );
    }
  }

  return { route, parseOpenIntent, intentToCmdOp, normalizeIntent };
}
