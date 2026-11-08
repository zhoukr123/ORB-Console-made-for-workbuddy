/* ---------------- 界面证据候选（outcomeEvidence） ----------------
 *
 * 补的是「tree_state 判据没法自动建议」这个缺口。
 *
 * 为什么之前不给 tree_state 建议：它要的是"界面上得出现某段字"，
 * 而**哪段字算成功**只有人知道。机器硬猜（取最长的新增行 / 取带"成功"字样的行）
 * 会在多数界面上猜错，而猜错的判据比没有判据更糟 —— 它会把每次运行都判成失败，
 * 用户看到的是"永远需复核"，还查不出原因。
 *
 * 所以这里换了个分工：
 *   · 机器负责**取证**：把上次运行前后控件树的差异算出来，滤掉没有判别力的行，
 *     清洗掉每次都会变的片段（ref 编号 / 坐标 / 长 hex），留下"稳定且新增"的文本行；
 *   · 人负责**判断**：从候选里勾一条，它才变成 tree_state 判据。
 *
 * 一句话：机器不猜"哪行是成功提示"，只回答"这次运行新出现了这些行"。
 *
 * 过滤的四类噪音（它们成功失败都会出现，写进判据毫无判别力）：
 *   ① 纯数字 / 纯符号 / 时间戳 / 日期
 *   ② 路径与 URL（是数据不是结论）
 *   ③ 万用按钮文字（确定 / 取消 / 关闭 / 是 / 否）
 *   ④ 清洗后过短或过长的片段
 */

const DEFAULT_MAX = 8;
const MIN_LEN = 2;
const MAX_LEN = 60;

/* 每次运行都会变、但和"成没成"无关的片段。留着它们，判据会随界面编号漂移。 */
const VOLATILE = [
  /\[\s*[\w-]*ref[\w-]*\s*=\s*\d+\s*\]/gi,   // [ref=12] / [refId=3]
  /\[\s*\d+\s*\]/g,                          // [12]
  /\(\s*-?\d{1,5}\s*,\s*-?\d{1,5}\s*\)/g,    // (120, 340) 坐标
  /\b[0-9a-f]{8,}\b/gi,                      // 长 hex（句柄 / 临时 id）
];

/* 无判别力的整行。判定顺序有意义：先按时间去，再按"是数据不是结论"去。 */
const NOISE = [
  /^[\s\d:：.,，%°+\-—–/\\|·、()（）[\]【】<>《》]+$/,
  /^\d{1,2}:\d{2}(:\d{2})?$/,
  /^\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}/,
  /^(https?:\/\/|www\.)/i,
  /^([A-Za-z]:[\\/]|\\\\|\/[\w.-]+\/)/,
  /^(确定|取消|关闭|是|否|好的|OK|Ok|ok|Cancel|Close|Yes|No)$/,
];

/** 去掉每次都会变的片段，再收掉多余空白。 */
export function stabilize(line) {
  let s = String(line == null ? "" : line);
  for (const re of VOLATILE) s = s.replace(re, " ");
  return s.replace(/\s{2,}/g, " ").trim();
}

function isNoise(s) {
  if (!s) return true;
  for (const re of NOISE) if (re.test(s)) return true;
  return false;
}

function toLines(txt) {
  if (typeof txt !== "string" || !txt) return [];
  return txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * 上次运行前后控件树的差异 → 可作为 tree_state 判据的候选行。
 * @param {string} before 运行前的控件树文本
 * @param {string} after  运行后的控件树文本
 * @param {object} opts { max }
 * @returns {{ ok:boolean, lines:Array<{text:string, raw:string, why:string}>, added:number, kept:number, reason:string }}
 */
export function diffLines(before, after, opts = {}) {
  const max = Math.max(1, Number(opts.max) || DEFAULT_MAX);
  const b = toLines(before);
  const a = toLines(after);
  if (!a.length) {
    return { ok: false, lines: [], added: 0, kept: 0, reason: "没有运行后的控件树（抓不到就无从取证）" };
  }
  /* 没有 before 也能做，但语义变了：这时"新增"等于"整棵树的内容"，
     候选会非常多且含大量本来就存在的东西 —— 所以明确标出来，让人知道它不精确。 */
  const hasBefore = b.length > 0;
  const seenBefore = new Set(b);
  const seenNew = new Set();
  const lines = [];
  let added = 0;

  for (const raw of a) {
    if (seenBefore.has(raw)) continue;
    const text = stabilize(raw);
    if (!text || seenNew.has(text)) continue;
    seenNew.add(text);
    added++;
    if (isNoise(text)) continue;
    if (text.length < MIN_LEN || text.length > MAX_LEN) continue;
    lines.push({ text, raw: raw.slice(0, 200), why: hasBefore ? "运行后新出现的行" : "运行后有这一行（没有运行前基线）" });
    if (lines.length >= max) break;
  }

  const reason = !added
    ? "这次运行前后控件树没有新增行 —— 可能界面没变，也可能这个应用不暴露控件树"
    : `${added} 行新增，其中 ${lines.length} 行有判别力，可勾选作为 tree_state 判据`;
  return { ok: true, lines, added, kept: lines.length, reason };
}

export default { stabilize, diffLines };
