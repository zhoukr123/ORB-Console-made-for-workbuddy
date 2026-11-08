"use strict";
/**
 * 不可信多模态输入 → 永久保留 .md 的唯一净化入口。
 * desktop/*.js 是 CommonJS，orb/*.mjs 是 ESM；实现只保留这一份，
 * ESM 侧用 createRequire 引用（orb/mdEscape.mjs），避免两份逻辑漂移。
 */
const MAX_LEN = 20000;
const FRAME_RE = /^frames\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp)$/i;
const FM_KEYS = ["key", "epoch", "generatedAt", "source", "revision"];

function toText(v) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  // 控制字符（含 NUL / ANSI 转义）能骗过渲染器与终端，直接去掉。
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function stripSecrets(s) {
  return toText(s)
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|authorization)\b\s*[:=]\s*["']?[^\s"',;)}\]]+/gi, "$1: [REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(sk|pk)-[A-Za-z0-9]{16,}\b/g, "[REDACTED]");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 行内安全文本：禁 raw HTML、禁 Markdown 链接/图片语法、无换行。 */
function escapeInline(v) {
  const raw = stripSecrets(toText(v)).slice(0, MAX_LEN).replace(/\r?\n/g, " ");
  // 顺序有讲究：先实体化 HTML，再转义反斜杠，最后转义 Markdown 元字符。
  return escapeHtml(raw).replace(/\\/g, "\\\\").replace(/([`*_\[\]()#!|~])/g, "\\$1");
}

/** 不可信长文本一律进代码块；三反引号替换掉，防止提前闭合围栏。 */
function escapeBlock(v) {
  const raw = stripSecrets(toText(v)).slice(0, MAX_LEN).replace(/```/g, "\u02cb\u02cb\u02cb");
  return "```text\n" + raw + "\n```";
}

function safeTitle(v) {
  return escapeInline(toText(v).slice(0, 200));
}

/** 外链转纯文本：先剥掉 [text](url) / ![](url)，再做行内转义。 */
function safeLink(v) {
  const raw = stripSecrets(toText(v)).slice(0, MAX_LEN).replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  return escapeInline(raw);
}

/** 图片只允许 frames/ 下的本地相对路径，其余一律返回空串。 */
function frameRef(v) {
  const s = toText(v).replace(/\\/g, "/").trim();
  if (s.indexOf("..") >= 0 || !FRAME_RE.test(s)) return "";
  return s;
}

/** front-matter 只收白名单键，值统一 JSON 字符串，杜绝换行注入与 YAML 类型混淆。 */
function frontMatter(o = {}) {
  const lines = ["---"];
  for (const k of FM_KEYS) {
    if (o[k] == null) continue;
    lines.push(k + ": " + JSON.stringify(String(o[k])));
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * 确定性拼装唯一源格式。sections[].trusted=true 才允许行内渲染，
 * 其余（ASR 台词、模型 why、视频标题、网页正文）一律进代码块。
 */
function buildSourceDoc(opts = {}) {
  const L = [];
  L.push(frontMatter(opts).trimEnd());
  L.push("");
  L.push("# " + safeTitle(opts.title || opts.key || "ORB 产物"));
  L.push("");
  const meta = Array.isArray(opts.meta) ? opts.meta : Object.entries(opts.meta || {});
  for (const pair of meta) {
    const k = Array.isArray(pair) ? pair[0] : "";
    const v = Array.isArray(pair) ? pair[1] : "";
    L.push("- " + safeTitle(k) + "：" + escapeInline(v));
  }
  L.push("");
  for (const s of (opts.sections || [])) {
    L.push("## " + safeTitle(s.title || ""));
    L.push("");
    L.push(s.trusted ? escapeInline(s.body) : escapeBlock(s.body));
    L.push("");
  }
  L.push("> 由 ORB 确定性拼接；不可信输入已转义，禁用 raw HTML、外链与凭据。");
  return L.join("\n") + "\n";
}

module.exports = {
  MAX_LEN, FRAME_RE, FM_KEYS,
  toText, stripSecrets, escapeHtml, escapeInline, escapeBlock,
  safeTitle, safeLink, frameRef, frontMatter, buildSourceDoc,
};
