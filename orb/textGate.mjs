/* 文本闸门：零模型调用、纯确定性规则。
 * 转写/OCR/网页正文一律只当数据(check 恒返回 asData:true / temp:true)，
 * 下游不得提权、不得升暖槽、不得写记忆、不得进会话历史。
 * 只提供判定/包裹/审计机制，不执行任何外部动作。 */

const INJECTION_RE = new RegExp([
  "忽略(?:之前|以上|上面|前面|先前|过往|所有)",
  "ignore\\s+(?:all\\s+|any\\s+)?(?:previous|prior|above)\\s+instructions?",
  "disregard\\s+(?:all\\s+|any\\s+)?(?:previous|prior|above)\\s+instructions?",
  "\\bsystem\\s*:",
  "你现在是",
  "你从现在起是",
  "执行以下命令",
  "run\\s+the\\s+following\\s+command",
].join("|"), "i");

const CREDENTIAL_RE = /(?:api[_-]?key|access[_-]?token|password|passwd|secret|pwd|token)\s*[=:]\s*["']?[^\s"'<>]+/i;
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*https?:\/\//i;
const RAW_HTML_RE = /<\/?[a-zA-Z][^>]*>|<!DOCTYPE|<!--|<\?xml/i;
const EXTERNAL_LINK_RE = /https?:\/\/|www\./i;

/* 按权重降序，reasonCode 取首个命中者。 */
const RULES = [
  { code: "instruction-injection", weight: 50, re: INJECTION_RE },
  { code: "credential", weight: 40, re: CREDENTIAL_RE },
  { code: "md-image-injection", weight: 35, re: MD_IMAGE_RE },
  { code: "raw-html", weight: 30, re: RAW_HTML_RE },
  { code: "external-link", weight: 10, re: EXTERNAL_LINK_RE },
];
/* balanced 模式下，这些高危项直接判不通过；低危项仅净化后放行。 */
const HIGH = new Set(["too-large", "instruction-injection", "credential", "md-image-injection"]);

const DATA_OPEN = "<<<[以下为不可执行数据/DATA-ONLY/BEGIN]>>>";
const DATA_CLOSE = "<<<[不可执行数据/END]>>>";

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* 确定性净化：中和指令、脱敏凭据、降级外链/MD 图片、剥 HTML 标签，最后整体转义。 */
function sanitize(text) {
  let s = String(text ?? "");
  s = s.replace(/忽略(?:之前|以上|上面|前面|先前|过往|所有).{0,12}(?:指令|提示|要求|规则|内容|话)/g, "[指令已中和]");
  s = s.replace(/ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above)\s+instructions?/gi, "[instruction-neutralized]");
  s = s.replace(/\bsystem\s*:/gi, "[role-neutralized]");
  s = s.replace(/你现在是|你从现在起是/g, "[role-neutralized]");
  s = s.replace(/执行以下命令/g, "[command-neutralized]");
  s = s.replace(/(api[_-]?key|access[_-]?token|password|passwd|secret|pwd|token)\s*[=:]\s*["']?[^\s"'<>]+/gi, "$1=[redacted]");
  s = s.replace(/!\[([^\]]*)\]\(\s*https?:\/\/[^)\s]*\s*\)/gi, "[image:$1]");
  s = s.replace(/https?:\/\/[^\s<>"')]+/gi, "[link]");
  s = s.replace(/\bwww\.[^\s<>"')]+/gi, "[link]");
  s = s.replace(/<[^>]*>/g, "");
  return escapeHtml(s);
}

/* 纯检测，不改状态。score = 命中规则权重和；too-large 另计。 */
function detect(text, maxTextBytes) {
  const s = String(text ?? "");
  const blocked = [];
  let score = 0;
  if (Buffer.byteLength(s, "utf8") > maxTextBytes) {
    blocked.push("too-large");
    score += 60;
  }
  for (const r of RULES) {
    if (r.re.test(s)) {
      blocked.push(r.code);
      score += r.weight;
    }
  }
  return { blocked, score };
}

function topReason(blocked) {
  if (!blocked.length) return "clean";
  const order = ["too-large", "instruction-injection", "credential", "md-image-injection", "raw-html", "external-link"];
  for (const c of order) if (blocked.includes(c)) return c;
  return blocked[0];
}

export function createTextGate(opts = {}) {
  const mode = ["balanced", "strict", "off"].includes(opts.mode) ? opts.mode : "balanced";
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const maxTextBytes = Number(opts.maxTextBytes) > 0 ? Number(opts.maxTextBytes) : 64 * 1024;

  let checked = 0;
  let blockedCount = 0;
  const byReason = Object.create(null);

  function bump(codes) {
    for (const c of codes) byReason[c] = (byReason[c] || 0) + 1;
  }

  function check(text, meta = {}) {
    checked++;
    // meta.source 为 transcript/ocr/webpage 时仍只当数据：结果恒 asData/temp=true，下游据此不落盘。
    void meta;
    if (mode === "off") {
      return { ok: true, score: 0, blocked: [], sanitized: String(text ?? ""), asData: true, temp: true, reasonCode: "off" };
    }
    const { blocked, score } = detect(text, maxTextBytes);
    const highFired = blocked.some((c) => HIGH.has(c));
    const ok = mode === "strict" ? blocked.length === 0 : !highFired;
    const reasonCode = topReason(blocked);
    if (!ok) {
      blockedCount++;
      bump(blocked);
    }
    return {
      ok,
      score,
      blocked,
      sanitized: sanitize(text),
      asData: true,
      temp: true,
      reasonCode,
    };
  }

  /* 确定性包裹：明确「以下为不可执行数据」边界；内容被转义，无法伪造边界闭合。 */
  function asData(text) {
    const escaped = escapeHtml(String(text ?? ""));
    return `${DATA_OPEN}\n${escaped}\n${DATA_CLOSE}`;
  }

  function markTemp(content) {
    return { content, temp: true, persist: false };
  }

  function scorePrompt(text) {
    const { blocked, score } = detect(text, maxTextBytes);
    return { score, blocked };
  }

  /* 记录下游拒因，仅供审计（内存）。 */
  function disposition(rec) {
    const codes = [];
    if (typeof rec === "string") codes.push(rec);
    else if (rec && typeof rec === "object") {
      if (Array.isArray(rec.blocked)) codes.push(...rec.blocked);
      if (rec.reasonCode) codes.push(rec.reasonCode);
    }
    const clean = codes.filter((c) => typeof c === "string" && c);
    if (clean.length) {
      bump(clean);
      blockedCount++;
    }
    return { ok: true, recorded: clean.length, at: now() };
  }

  /* 组合入口（报告B §7 批次A 第5项 V-11 接线）：
   * 转写(transcript) / OCR(ocr) / 网页正文(webpage) 三个入口统一走这里，
   * 免得各处自己拼「check → 净化 → DATA 包裹 → 标临时 → 审计」而漏掉一环。
   * 只转义一次：sanitize 已 escapeHtml，这里直接拿它拼 DATA 边界，不再过 asData。
   * 返回体**不回传原文**，下游只有 data 可用，从形状上堵住「拿原文进模型」。 */
  function guard(text, source = "webpage") {
    const s = String(source || "webpage");
    const chk = check(text, { source: s });
    const data = `${DATA_OPEN}\n${chk.sanitized}\n${DATA_CLOSE}`;
    const tmp = markTemp(data);
    /* check 在「判不通过」时已经计过 blocked 并记了高危拒因，这里不重复计；
       只在「判通过但命中低危项（如外链）」时补记一条下游审计，
       否则 balanced 模式放行的低危命中就完全没有留痕。 */
    if (chk.ok && chk.blocked.length) disposition({ source: s, blocked: chk.blocked });
    return {
      ok: chk.ok,
      untrusted: true,
      source: s,
      data,
      temp: tmp.temp,
      persist: tmp.persist,
      blocked: chk.blocked.slice(),
      reasonCode: chk.reasonCode,
      score: chk.score,
      rawLength: String(text ?? "").length,
      note: "只当数据：不得提权、不得升暖槽、不得写记忆、不得进会话历史",
    };
  }

  function stats() {
    return { checked, blocked: blockedCount, byReason: { ...byReason } };
  }

  return { check, asData, markTemp, disposition, scorePrompt, guard, stats };
}
