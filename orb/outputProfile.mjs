/* 输出配置：七键 profile 的默认值、归一、校验与派生工具。纯函数，零 IO。 */
import { createHash } from "node:crypto";

/* 前 10 项是既有格式，顺序固定（有单测锁着）；末尾 3 项是 Office 三件套。
   docx/xlsx/pptx 全是 OOXML（zip + xml），由 exporter 内置的 toZip 生成，零三方依赖。 */
export const FORMATS = [
  "md", "vtt", "lrc", "txt", "csv", "tsv", "html", "pdf", "zip", "db",
  "docx", "xlsx", "pptx",
];

const INCLUDE_KEYS = ["media", "frames", "rawLog", "transcript"];
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const asBool = (v, d) => (typeof v === "boolean" ? v : d);

export const DEFAULT_PROFILE = {
  formats: ["md"],
  dest: "",
  nameTemplate: "{title}-{epoch}.{ext}",
  retentionDays: 30,
  include: { media: true, frames: true, rawLog: false, transcript: true },
  redact: true,
  autoOpen: false,
};

export function normalizeProfile(input = {}) {
  const i = input && typeof input === "object" ? input : {};

  let formats = DEFAULT_PROFILE.formats.slice();
  if (Array.isArray(i.formats)) {
    // 只保留 FORMATS 子集、按 FORMATS 顺序、天然去重
    const kept = FORMATS.filter((f) => i.formats.includes(f));
    if (kept.length) formats = kept;
  }

  const inc = i.include && typeof i.include === "object" ? i.include : {};
  const include = {};
  for (const k of INCLUDE_KEYS) include[k] = asBool(inc[k], DEFAULT_PROFILE.include[k]);

  const rd = Number(i.retentionDays);
  return {
    formats,
    dest: typeof i.dest === "string" ? i.dest : DEFAULT_PROFILE.dest,
    nameTemplate: typeof i.nameTemplate === "string" && i.nameTemplate
      ? i.nameTemplate : DEFAULT_PROFILE.nameTemplate,
    retentionDays: Number.isFinite(rd) && rd >= 0 ? rd : DEFAULT_PROFILE.retentionDays,
    include,
    redact: asBool(i.redact, DEFAULT_PROFILE.redact),
    autoOpen: asBool(i.autoOpen, DEFAULT_PROFILE.autoOpen),
  };
}

export function validateProfile(p) {
  const errors = [];
  const x = p && typeof p === "object" ? p : {};

  if (!Array.isArray(x.formats)) errors.push("formats 必须是数组");
  else {
    if (x.formats.length === 0) errors.push("formats 不能为空");
    for (const f of x.formats) if (!FORMATS.includes(f)) errors.push(`未知格式: ${f}`);
  }

  const rd = x.retentionDays;
  if (typeof rd !== "number" || !Number.isFinite(rd) || rd < 0) {
    errors.push("retentionDays 必须是 >= 0 的数");
  }

  if (typeof x.nameTemplate !== "string" || !x.nameTemplate) {
    errors.push("nameTemplate 必须是非空字符串");
  } else if (/[\\/]/.test(x.nameTemplate)) {
    errors.push("nameTemplate 不允许路径分隔符");
  }

  if (typeof x.redact !== "boolean") errors.push("redact 必须是 boolean");
  if (typeof x.autoOpen !== "boolean") errors.push("autoOpen 必须是 boolean");

  if (x.dest != null && typeof x.dest !== "string") errors.push("dest 必须是字符串");
  if (x.include != null) {
    if (typeof x.include !== "object") errors.push("include 必须是对象");
    else for (const k of INCLUDE_KEYS) {
      if (k in x.include && typeof x.include[k] !== "boolean") errors.push(`include.${k} 必须是 boolean`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/* 占位符替换后整体做安全文件名处理，杜绝路径分隔符与穿越。 */
export function resolveName(template, ctx = {}) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const vals = {
    epoch: c.epoch ?? 0,
    ext: c.ext ?? "",
    title: c.title ?? "output",
    date: c.date ?? "",
    seq: c.seq ?? 0,
  };
  let s = String(template ?? DEFAULT_PROFILE.nameTemplate);
  s = s.replace(/\{(epoch|ext|title|date|seq)\}/g, (_, k) => String(vals[k]));
  s = s.replace(/\{[^}]*\}/g, ""); // 未知占位符直接丢弃
  return safeFilename(s);
}

function safeFilename(s) {
  let out = String(s ?? "");
  out = out.replace(/[\\/]+/g, "_");                 // 路径分隔符
  out = out.replace(/[<>:"|?*\x00-\x1f]/g, "");      // Windows 非法字符 + 控制字符
  out = out.replace(/\.\.+/g, ".");                  // 折叠连续点，防 ".."
  out = out.replace(/^[\s.]+/, "").replace(/[\s.]+$/, "").trim();
  if (!out) out = "output";
  if (out.length > 180) out = out.slice(0, 180);
  // Windows 保留设备名兜底
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(out)) out = "_" + out;
  return out;
}

export function retentionCutoff(profile, nowMs) {
  const days = Number(profile && profile.retentionDays);
  const t = Number(nowMs);
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(t)) return null;
  return t - days * 86400000;
}

export function shouldInclude(profile, part) {
  if (!INCLUDE_KEYS.includes(part)) return false;
  const inc = profile && typeof profile === "object" ? profile.include : null;
  if (!inc || typeof inc !== "object") return DEFAULT_PROFILE.include[part];
  return inc[part] !== false;
}

/* 一律返回不含原值的摘要：sha256 前 10 位 + 长度 + 分类，确定性、绝不回传原文。 */
export function redactValue(v) {
  const s = v == null ? "" : String(v);
  const h = createHash("sha256").update(s, "utf8").digest("hex").slice(0, 10);
  return `[redact:${classify(s)}:${h}:len=${s.length}]`;
}

function classify(s) {
  if (/^(?:[A-Za-z]:[\\/]|\/|~\/|\.{1,2}[\\/])/.test(s) || /[\\/]/.test(s)) return "path";
  if (/^(?:sk-|Bearer\s|ghp_|xox[baprs]-)/i.test(s) ||
      /(?:token|api[_-]?key|password|secret|credential|authorization)/i.test(s)) return "credential";
  return "text";
}
