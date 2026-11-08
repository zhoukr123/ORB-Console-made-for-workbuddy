/* ---------------- 任务 → 通道 分类器（taskRouter） ----------------
 *
 * 目的：在「视觉模型循环」启动之前，先判断这个任务的**最终目标**能不能用
 * 命令通道（文件 + 进程）直接完成。能就短路走命令，省掉一整轮截图→推理→点击；
 * 不能才进视觉循环。
 *
 * 设计取向（与 ORB 其它治理模块一致）：
 *   · **宁可漏判，不可误判**。误判的代价是"一个本该点界面才能完成的任务被错误地
 *     当成命令执行了"，可能什么都没发生或打开了错的东西；漏判只是退回原来的视觉
 *     路径，行为与改造前一致。所以只有**高置信**（0.9）才返回 commandable。
 *   · **凡含界面交互信号，一律交给视觉**（点击/拖拽/截图/在弹窗里…）——
 *     这些天然需要看屏幕，命令通道表达不了。
 *   · 纯规则、可解释：每条结果都带 rule/reason，便于复盘"为什么这单走了命令/视觉"。
 *
 * 与 freetier 的分工：
 *   · taskRouter —— 决策：这活能不能命令化（输出 intent + 置信度）
 *   · freetier   —— 执行：把 intent 先试命令通道、失败回落 GUI 模拟
 *   bridge 里的顺序是：classifyCommandable → 能命令化 → freeTier.route。
 */

import path from "node:path";
import { parseOpenIntent } from "./freetier.mjs";

/** 高置信阈值：只有达到它才允许"自动改走命令通道"。 */
export const HIGH_CONFIDENCE = 0.9;
/** 中置信：识别出来了，但目标不够具体（例如"打开设置"），只做提示、不自动执行。 */
export const MID_CONFIDENCE = 0.6;

/** 界面交互信号：命中任意一个，就认为这块必须看屏幕，让给视觉循环。 */
const UI_SIGNALS = /(点击|单击|双击|右键|左键|拖[拽动]|框选|截图|屏幕|滚动|悬停|鼠标|键盘|输入框|输入栏|弹窗|对话框|菜单里|勾选|选中|按钮|下拉|选项卡)/;

/** 看起来像一个程序名（ASCII 可执行名，不含中文）。 */
function looksLikeProgram(s) {
  const v = String(s || "").trim();
  if (!v) return false;
  return /^[\w.\-/\\]+(?:\.exe)?$/i.test(v);
}

/** 看起来像一个文件/目录路径（带分隔符或扩展名）。 */
function looksLikePath(s) {
  const v = String(s || "").trim();
  if (!v) return false;
  return /[\\/]/.test(v) || /\.\w{1,8}$/.test(v);
}

/** 常见中文程序名 → 真实可执行名。探测时先过这层，避免「记事本」这类
 *  中文名 which 不到就被误判成"不能命令化"。 */
const APP_ALIASES = {
  记事本: "notepad",
  写字板: "write",
  计算器: "calc",
  画图: "mspaint",
  资源管理器: "explorer",
  浏览器: "msedge",
  终端: "wt",
};

/* 显式 CLI 前缀：文本以这些**非 shell 宿主**的命令名开头，直接当 launch 处理，
   再由探测确认这个命令真的存在。刻意排除 node/python/py/npx/pip —— 它们是
   解释器/脚本宿主，cmdchan 会拒绝启动，纳进来只会白跑一次再回落。 */
const CLI_PREFIX = /^(git|npm|pnpm|yarn|curl|wget|docker|kubectl|ffmpeg|7z|tar|gradle|mvn|cargo)\b/i;

/* 写入分隔词，**长的在前**，避免 "保存为"/"保存到" 被 "存为" 之类先命中。
   用 indexOf 线性扫描而不是正则：惰性量词 + `$` 锚 + 多个可选组在"没有分隔词"
   的长文本上会 O(n²) 回溯（实测 8KB 要 78ms，属 ReDoS 隐患）。 */
const WRITE_SEPS = ["保存为", "保存到", "写入", "写到", "存为", "存到"];

/**
 * 「把 <内容> 写入/保存到 <路径>」 → write intent。
 * 内容与路径都允许包在引号/书名号里。**线性扫描，无正则回溯。**
 */
function parseWriteIntent(text) {
  const t = String(text || "");
  if (!t) return null;

  // 取**最靠前**出现的分隔词
  let sep = "";
  let at = -1;
  for (const s of WRITE_SEPS) {
    const i = t.indexOf(s);
    if (i >= 0 && (at < 0 || i < at)) { at = i; sep = s; }
  }
  if (at < 0) return null;

  let left = t.slice(0, at).trim();
  let right = t.slice(at + sep.length).trim();

  // 左侧：去「把/将」前缀 + 包住内容的引号/书名号
  left = left.replace(/^(?:把|将)\s*/, "").trim();
  left = left.replace(/^[「"“']/, "").replace(/[」"”']$/, "").trim();

  // 右侧：去「文件/路径/到」前缀 + 起始引号，再取到第一个空白前的 token 作路径
  right = right.replace(/^(?:文件|路径|到)\s*/, "").trim();
  right = right.replace(/^[「"“']/, "");
  const filePath = (right.match(/^[^\s「」"“”']+/) || [""])[0].trim();

  const content = left;
  if (!content || !filePath) return null;
  return { op: "write", content, filePath };
}

/* 文件操作动词与方向词。线性扫描（indexOf），避免正则回溯。 */
const FILEOP_VERBS = [["复制", "copy"], ["拷贝", "copy"], ["移动", "move"], ["重命名", "rename"], ["改名", "rename"]];
const FILEOP_DIRS = ["到", "为", "成", "至"];

function stripQuotes(s) {
  return String(s || "").trim().replace(/^[「"“']/, "").replace(/[」"”']$/, "").trim();
}

/** 「把 A 复制/移动/重命名 到/为 B」 → {op, from, to, overwrite, danger}。 */
function parseFileOpIntent(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  let verb = "";
  let op = "";
  let at = -1;
  for (const [v, o] of FILEOP_VERBS) {
    const i = t.indexOf(v);
    if (i >= 0 && (at < 0 || i < at)) { at = i; verb = v; op = o; }
  }
  if (at < 0) return null;

  const before = t.slice(0, at).replace(/^\s*(?:把|将)\s*/, "").trim();
  let after = t.slice(at + verb.length).trim();

  // 方向词前缀（「把 A 复制【到】 B」）
  for (const d of FILEOP_DIRS) {
    if (after.startsWith(d)) { after = after.slice(d.length).trim(); break; }
  }

  let from = "";
  let to = "";
  if (before) {
    from = before;
    to = after;
  } else {
    // 「复制 A【到】B」：在 after 里找第一个方向词
    let di = -1;
    let D = "";
    for (const d of FILEOP_DIRS) {
      const i = after.indexOf(d);
      if (i > 0 && (di < 0 || i < di)) { di = i; D = d; }
    }
    if (di < 0) return null;
    from = after.slice(0, di).trim();
    to = after.slice(di + D.length).trim();
  }

  from = stripQuotes(from);
  to = stripQuotes(to);
  if (!from || !to) return null;

  const overwrite = /覆[盖写]|强行|force/i.test(t);
  // danger：移动/重命名会让源消失，复制覆盖会毁目标 —— 与 cmdDanger 的硬闸口径一致
  return { op, from, to, overwrite, danger: op === "move" || op === "rename" || (op === "copy" && overwrite) };
}

/**
 * 分类：这段任务描述能否用命令通道完成？
 * @returns {{commandable:boolean, confidence:number, intent:object|null, reason:string, rule:string}}
 *   commandable 为 true 时 intent 一定是可执行的命令 intent。
 */
export function classifyCommandable(text) {
  const t = String(text || "").trim();
  if (!t) return { commandable: false, confidence: 0, intent: null, reason: "空任务", rule: "" };

  // ① 含界面交互信号 → 必须视觉，别多嘴
  if (UI_SIGNALS.test(t)) {
    return { commandable: false, confidence: 0, intent: null, reason: "含界面交互动作，需视觉", rule: "ui-signal" };
  }

  // ①b 显式 CLI 命令（git/npm/curl…）→ 当 launch；是否真能跑交给探测复核
  if (CLI_PREFIX.test(t)) {
    const m = t.match(/^(\S+)\s*(.*)$/);
    if (m) {
      const bin = path.basename(m[1]);
      const args = m[2] ? m[2].split(/\s+/).filter(Boolean) : [];
      return {
        commandable: true, confidence: HIGH_CONFIDENCE,
        intent: { op: "launch", command: bin, args },
        reason: `显式 CLI：${bin}`, rule: "cli-explicit",
      };
    }
  }

  // ①c 文件操作（复制/移动/重命名）：两端都像路径才高置信；move/rename 标 danger
  const fo = parseFileOpIntent(t);
  if (fo) {
    const conf = (looksLikePath(fo.from) && looksLikePath(fo.to)) ? HIGH_CONFIDENCE : MID_CONFIDENCE;
    return {
      commandable: conf >= HIGH_CONFIDENCE,
      confidence: conf,
      intent: { op: fo.op, from: fo.from, to: fo.to, overwrite: fo.overwrite, danger: fo.danger },
      reason: conf >= HIGH_CONFIDENCE ? `${fo.op} 路径明确，可命令化` : "文件操作路径不够具体，交视觉",
      rule: "fileop",
    };
  }

  // ② 写文件（明确路径才高置信）
  const w = parseWriteIntent(t);
  if (w) {
    const conf = looksLikePath(w.filePath) ? HIGH_CONFIDENCE : MID_CONFIDENCE;
    return {
      commandable: conf >= HIGH_CONFIDENCE,
      confidence: conf,
      intent: w,
      reason: conf >= HIGH_CONFIDENCE ? "写文件可命令化" : "写入目标路径不明确",
      rule: "write",
    };
  }

  // ③ 打开 / 运行（复用 freetier 的解析）
  const oi = parseOpenIntent(t);
  if (oi) {
    let conf = MID_CONFIDENCE;
    if (oi.op === "launch") {
      conf = looksLikeProgram(oi.command) ? HIGH_CONFIDENCE : MID_CONFIDENCE;
    } else if (oi.op === "open") {
      conf = looksLikePath(oi.filePath) ? HIGH_CONFIDENCE : MID_CONFIDENCE;
    }
    return {
      commandable: conf >= HIGH_CONFIDENCE,
      confidence: conf,
      intent: oi,
      reason: conf >= HIGH_CONFIDENCE ? "打开/运行目标明确，可命令化" : "打开目标不够具体（可能是设置项/界面），交视觉",
      rule: "open-launch",
    };
  }

  // ④ 没命中任何命令化规则
  return { commandable: false, confidence: 0, intent: null, reason: "未命中命令化规则，交视觉", rule: "" };
}

/**
 * 计划（不会执行任何东西）：这单走命令还是走视觉，为什么。
 * @returns {{ok:true, text:string, via:'command'|'vision', confidence:number, intent:object|null, reason:string, rule:string}}
 */
export function planTask(text) {
  const c = classifyCommandable(text);
  return {
    ok: true,
    text: String(text || ""),
    via: c.commandable ? "command" : "vision",
    confidence: c.confidence,
    intent: c.intent,
    reason: c.reason,
    rule: c.rule,
  };
}

/**
 * 探测式复核：正则先做零成本预筛，**只有候选才去查环境**（which/exists）。
 * 探测只读、失败一律回落视觉（保守）；探测本身出错则不阻断（宁可漏判不误杀）。
 * @param {string} text
 * @param {object} prober  createProber() 的实例（可注入假实现）
 * @returns {Promise<{commandable:boolean, confidence:number, intent:object|null, reason:string, rule:string, probed:boolean, probe:object|null}>}
 */
export async function probeCommandable(text, prober) {
  const base = classifyCommandable(text);
  if (!base.commandable || !prober) return { ...base, probed: false, probe: null };

  const it = { ...base.intent };
  const probe = {};
  let ok = true;
  let reason = base.reason;

  try {
    if (it.op === "launch") {
      const target = looksLikeProgram(it.command) ? it.command : "";
      const p = target ? await prober.which(target) : "";
      probe.which = p || "";
      if (!p) { ok = false; reason = `命令「${it.command}」在 PATH 中找不到`; }
      else reason = `命令「${it.command}」可用：${p}`;
    } else if (it.op === "open") {
      /* 程序：ASCII/路径才 which；中文名先过别名，过不了就视为"无法直接复核"，
         保留原判定（避免「记事本」这类中文名 which 不到被误杀）。 */
      if (it.app) {
        const alias = APP_ALIASES[it.app] || it.app;
        if (looksLikeProgram(alias)) {
          const p = await prober.which(alias);
          probe.app = p || "";
          if (!p) { ok = false; reason = `程序「${it.app}」找不到（试过 ${alias}）`; }
          else { it.app = alias; reason = `程序「${it.app}」可用：${p}`; }
        } else {
          probe.appSkipped = true;
          reason = `程序名「${it.app}」无法直接解析，保留原判定`;
        }
      }
      if (it.filePath) {
        const e = await prober.exists(it.filePath);
        probe.fileExists = e;
        if (!e && ok) { ok = false; reason = `目标文件不存在：${it.filePath}`; }
      } else if (ok && !it.app) {
        ok = false; reason = "没有可打开的文件或程序";
      }
    } else if (it.op === "write") {
      /* 写入会递归建目录，所以只校验盘符/根是否存在（防 Z: 这类幽灵盘）。 */
      const root = path.parse(it.filePath).root;
      const re = root ? await prober.exists(root) : true;
      probe.rootExists = re;
      if (!re) { ok = false; reason = `目标盘/根不存在：${root}`; }
      else reason = `可写入：${it.filePath}`;
    } else if (it.op === "copy" || it.op === "move" || it.op === "rename") {
      const srcOk = await prober.exists(it.from);
      probe.fromExists = srcOk;
      if (!srcOk) { ok = false; reason = `源不存在：${it.from}`; }
      // 目标父目录会递归建，只校验盘符/根
      const root = path.parse(it.to).root;
      const re = root ? await prober.exists(root) : true;
      probe.rootExists = re;
      if (!re && ok) { ok = false; reason = `目标盘/根不存在：${root}`; }
      // 未开启覆盖时，目标已存在 → 执行必失败，提前判给视觉
      if (ok && !it.overwrite) {
        const dst = await prober.exists(it.to);
        probe.toExists = dst;
        if (dst) { ok = false; reason = `目标已存在且未开启覆盖：${it.to}`; }
      }
      if (ok) reason = `${it.op} 可执行：${it.from} → ${it.to}`;
    }
  } catch (e) {
    probe.error = String(e?.message ?? e);
  }

  return {
    ...base,
    commandable: ok && base.commandable,
    confidence: ok ? Math.max(base.confidence, 0.95) : 0,
    intent: ok ? it : null,
    reason,
    rule: base.rule + "+probe",
    probed: true,
    probe,
  };
}

/** planTask 的探测版：先预筛、再探测，返回最终"命令/视觉"计划。 */
export async function planTaskProbed(text, prober) {
  const c = await probeCommandable(text, prober);
  return {
    ok: true,
    text: String(text || ""),
    via: c.commandable ? "command" : "vision",
    confidence: c.confidence,
    intent: c.intent,
    reason: c.reason,
    rule: c.rule,
    probed: !!c.probed,
    probe: c.probe ?? null,
  };
}
