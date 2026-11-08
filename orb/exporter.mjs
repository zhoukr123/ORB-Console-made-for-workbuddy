/* 导出器：各格式纯函数 + 原子落盘。零三方依赖，fs/时间均可通过 opts 注入。 */
import * as fsp from "node:fs/promises";
import * as syncFsDefault from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import {
  FORMATS, DEFAULT_PROFILE, normalizeProfile, resolveName,
} from "./outputProfile.mjs";
/* md 正文的标题/行内文本统一过这里的净化（真实 import，不是注释里的字符串）。 */
import { escapeInline, safeTitle } from "./mdEscape.mjs";

export const CSV_BOM = "\uFEFF";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const dayTag = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");

/* store 模式 ZIP 的 CRC32（查表法）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(ms) {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}
function safeZipName(name) {
  let s = String(name ?? "file").replace(/\\/g, "/");
  s = s.split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
  return s || "file";
}
const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* ============ OOXML（docx / xlsx / pptx）零依赖生成 ============
 * 三种 Office 文件本质都是「一个 store 模式的 ZIP + 若干 XML 部件」，
 * 已有的 toZip(files) 正好能打，所以这里只负责拼 XML，不引入任何三方库，
 * 也不依赖本机 Python / 打包态里根本不存在的 openpyxl、python-pptx。
 *
 * 生成的是最小但结构完整的 OOXML：rels、Content_Types、master/layout/theme 一应俱全，
 * Word / Excel / PowerPoint 能直接打开，不会弹「需要修复」。 */
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/* XML 1.0 不允许多数控制字符（Tab/LF/CR 除外），正文里混进 \x00 会让 Office 直接判文件损坏。 */
const xmlText = (v) => esc(v).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
const PKG_REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const NS_PPT = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const RT = {
  doc: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  slideMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
  slideLayout: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
  slide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
  worksheet: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
};
const CT = {
  docxMain: "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
  xlsxBook: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
  xlsxSheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
  pptxPres: "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
  pptxSlide: "application/vnd.openxmlformats-officedocument.presentationml.slide+xml",
  pptxMaster: "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml",
  pptxLayout: "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml",
  theme: "application/vnd.openxmlformats-officedocument.theme+xml",
};

function pkgContentTypes(overrides) {
  return XML_DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + overrides.map((o) => `<Override PartName="${o.part}" ContentType="${o.type}"/>`).join("")
    + '</Types>';
}
function pkgRels(items) {
  return XML_DECL + `<Relationships ${PKG_REL_NS}>`
    + items.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlText(r.target)}"/>`).join("")
    + '</Relationships>';
}

/* Excel 列名：1→A、26→Z、27→AA。 */
function colName(n) {
  let s = "";
  let x = Math.max(1, Number(n) || 1);
  while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
  return s;
}

/* Word 段落：Markdown 的 #/##/### 映射成加粗大字号，其余按行成段。 */
function docxParagraphs(body) {
  return String(body ?? "").split(/\r?\n/).map((line) => {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      const sz = h[1].length === 1 ? 36 : h[1].length === 2 ? 30 : 26;
      return `<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>`
        + `<w:r><w:rPr><w:b/><w:sz w:val="${sz}"/></w:rPr>`
        + `<w:t xml:space="preserve">${xmlText(h[2])}</w:t></w:r></w:p>`;
    }
    return `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>`
      + `<w:r><w:t xml:space="preserve">${xmlText(line)}</w:t></w:r></w:p>`;
  }).join("");
}

/* PPT 各页/母版/版式都要这段基础 spTree，抽一份避免四处漂移。 */
const SP_TREE_BASE = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
  + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
  + '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const CLR_MAP_ATTRS = 'accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" '
  + 'accent5="accent5" accent6="accent6" bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" '
  + 'hlink="hlink" folHlink="folHlink"';

/* 精简但合规的主题：clrScheme 12 色 + major/minor 字体 + 各 3 项样式列表。 */
const PPTX_THEME = XML_DECL
  + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="ORB"><a:themeElements>'
  + '<a:clrScheme name="ORB">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
  + '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
  + '</a:clrScheme>'
  + '<a:fontScheme name="ORB"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="ORB">'
  + '<a:fillStyleLst>'
  + '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  + '<a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill>'
  + '<a:solidFill><a:schemeClr val="phClr"><a:shade val="70000"/></a:schemeClr></a:solidFill>'
  + '</a:fillStyleLst>'
  + '<a:lnStyleLst>'
  + '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
  + '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
  + '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
  + '</a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>'
  + '<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  + '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>'
  + '<a:solidFill><a:schemeClr val="phClr"><a:shade val="90000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst>'
  + '</a:fmtScheme></a:themeElements></a:theme>';

/* 一张幻灯片：标题框 + 正文要点框（16:9，9144000×5143500 EMU）。 */
function pptxSlideXml(slide) {
  const s = slide && typeof slide === "object" ? slide : { title: String(slide ?? "") };
  const title = String(s.title ?? "");
  const bullets = (Array.isArray(s.bullets) ? s.bullets : []).slice(0, 12);
  const titleSp = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1000000"/></a:xfrm>'
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
    + '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="3200" b="1"/>'
    + `<a:t>${xmlText(title)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const paras = bullets.map((b) => `<a:p><a:r><a:rPr lang="zh-CN" sz="1800"/>`
    + `<a:t>${xmlText(b)}</a:t></a:r></a:p>`).join("");
  const bodySp = '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="457200" y="1400000"/><a:ext cx="8229600" cy="3400000"/></a:xfrm>'
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
    + `<p:txBody><a:bodyPr/><a:lstStyle/>${paras || '<a:p/>'}</p:txBody></p:sp>`;
  return XML_DECL + `<p:sld ${NS_PPT}><p:cSld><p:spTree>${SP_TREE_BASE}${titleSp}${bodySp}</p:spTree></p:cSld>`
    + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

/* ============ 源结构推断 ============
 * 面板/调用方只给「一段文本 + 一个目标格式」，格式决定这段文本怎么解释。
 * 解释规则集中在这一处，面板不重复实现 —— 否则两边对同一段文本的理解迟早分叉。
 *
 * 规则（全部确定性，读一遍就能预测结果）：
 *   txt          → 原字符串
 *   md           → { title, sections:[{heading:'正文', body}] }
 *   html / pdf   → { title, body }
 *   csv/tsv/db   → 表格行数组（自动识别 , / \t / ; 三种分隔符，支持双引号转义与换行）
 *   vtt/lrc      → 时间轴段数组（必须能解析出时间码，否则如实报错，绝不编时间）
 *   zip          → 单文件 [{name, content}]
 *   docx         → { title, body }（#/##/### 映射成 Word 加粗标题）
 *   xlsx         → 二维表格行（沿用 csv 的分隔符识别；纯叙事则每行一个单元格）
 *   pptx         → { title, slides:[{title,bullets}] }（空行分段，一段一页）
 *
 * 为什么不给 vtt 猜时间码：字幕的每一秒都会影响观感。猜出来的时间轴
 * 看起来"是那么回事"，实际上是把用户没说过的话硬塞进时间线里。
 * 宁可直接告诉他需要什么形状。
 */

/* 带引号与内嵌换行的分隔符解析：手写状态机，比正则可靠（正则处理 "" 转义很容易错）。 */
function splitDelimited(text, delim) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }   // "" → 一个字面双引号
        else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === "") { quoted = true; continue; }  // 只有单元格开头才算引号
    if (c === delim) { row.push(cell); cell = ""; continue; }
    if (c === "\r") { continue; }                                // CRLF 的 CR 直接丢掉
    if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += c;
  }
  row.push(cell);
  rows.push(row);
  // 末尾空行（文本以换行结尾）不算一行数据
  while (rows.length && rows[rows.length - 1].every((x) => x === "")) rows.pop();
  return rows;
}

function detectDelim(text) {
  const head = String(text ?? "").split(/\r?\n/, 1)[0] || "";
  const count = (ch) => {
    let n = 0;
    let q = false;
    for (const c of head) {
      if (c === '"') q = !q;
      else if (!q && c === ch) n++;
    }
    return n;
  };
  const cands = [[",", count(",")], ["\t", count("\t")], [";", count(";")]];
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0][1] > 0 ? cands[0][0] : ",";
}

/* 首行当表头；重名加后缀、多出的列按 col{n} 命名 —— 丢数据比名字难看严重得多。 */
function rowsFromDelimited(text, delim) {
  const grid = splitDelimited(text, delim);
  if (!grid.length) return { ok: false, error: "内容为空，没有可导出的表格行" };
  const header = grid[0].map((h, i) => {
    const base = String(h ?? "").trim() || `col${i + 1}`;
    return base;
  });
  const seen = new Map();
  const names = header.map((h) => {
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h}(${n})`;
  });
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const line = grid[r];
    const o = {};
    for (let i = 0; i < Math.max(names.length, line.length); i++) {
      o[names[i] || `col${i + 1}`] = line[i] ?? "";
    }
    rows.push(o);
  }
  if (!rows.length) return { ok: false, error: "只有表头，没有数据行" };
  return { ok: true, rows };
}

/* 认这几种行首时间码：
 *   00:01:02.500 / 00:01:02,500 / 01:02.5 / [01:02] / 01:02
 * 可选后半段 "--> 00:01:05.000"。剩下的是文本。 */
const TS_RE = /^\s*\[?(\d{1,2}:\d{1,2}(?::\d{1,2})?(?:[.,]\d{1,3})?)\]?\s*(?:-->\s*(\d{1,2}:\d{1,2}(?::\d{1,2})?(?:[.,]\d{1,3})?)\s*)?(.*)$/;

function parseTimeCode(s) {
  const parts = String(s).replace(",", ".").split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const sec = nums.length === 3
    ? nums[0] * 3600 + nums[1] * 60 + nums[2]
    : nums[0] * 60 + nums[1];
  return Number.isFinite(sec) ? sec : null;
}

function segmentsFromText(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^WEBVTT/i.test(line.trim())) continue;
    if (/^\d+$/.test(line.trim())) continue;            // 纯序号行（SRT 常见）
    const m = TS_RE.exec(line);
    if (!m) continue;
    const start = parseTimeCode(m[1]);
    if (start == null) continue;
    const body = String(m[3] ?? "").trim();
    if (!body) continue;
    const end = m[2] ? parseTimeCode(m[2]) : null;
    out.push({ start, end: end != null && end > start ? end : null, text: body });
  }
  if (!out.length) {
    return {
      ok: false,
      error: "没有解析到时间码。字幕请写成「00:01.5 这一句台词」一行一句（也支持 00:00:01,500 与 [00:01] 写法）",
    };
  }
  // 没写结束时间的：用下一段的起点，末段补 3 秒（这是唯一的推断，已在面板说明）
  for (let i = 0; i < out.length; i++) {
    if (out[i].end == null) {
      const next = out[i + 1];
      out[i].end = next && next.start > out[i].start ? next.start : out[i].start + 3;
    }
  }
  return { ok: true, segments: out };
}

/**
 * 把一段文本按目标格式解释成 exporter.run 需要的样子。
 * @returns {{ok:true,source:any}|{ok:false,error:string}}
 */
export function buildSource(text, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const format = String(o.format || "txt");
  const title = String(o.title ?? "").trim() || "导出";
  const raw = String(text ?? "");
  if (!raw.trim()) return { ok: false, error: "内容为空，没有可导出的东西" };

  switch (format) {
    case "txt":
      return { ok: true, source: raw };
    case "md": {
      /* 仅 md/markdown 类正文过 mdEscape：标题用 safeTitle，标题行与正文用
       * escapeInline（| / 换行 / 反引号 / MD 元字符一律中和，表格单元格不会被撑破）。
       * csv/tsv/html/pdf 等其它格式完全不走这里，保持原有样子。 */
      const source = {
        title: safeTitle(title),
        sections: [{ heading: escapeInline("正文"), body: escapeInline(raw) }],
      };
      /* 可选：只有调用方显式给出命名段配置时才附加新字段；缺省时 source 与旧版逐键一致。 */
      if (o.namedSections === true || o.sections !== undefined) {
        source.availableSections = SECTION_NAMES;
        source.sectionsEnabled = sectionToggle(undefined, o.sections);
      }
      return { ok: true, source };
    }
    case "html":
    case "pdf":
      return { ok: true, source: { title, body: raw } };
    case "csv":
    case "tsv":
    case "db": {
      const r = rowsFromDelimited(raw, detectDelim(raw));
      if (!r.ok) return r;
      return { ok: true, source: r.rows };
    }
    case "vtt":
    case "lrc": {
      const r = segmentsFromText(raw);
      if (!r.ok) return r;
      return { ok: true, source: r.segments };
    }
    case "zip": {
      /* 单文件打包：正文落在 <标题>.md 里。zip 的 source 是文件列表，
         用户给一段文本时只能这么解释 —— 想打多文件请走 /api/export 的 source。 */
      return { ok: true, source: [{ name: `${title}.md`, content: raw }] };
    }
    case "docx":
      /* Word：整段文本进正文，#/##/### 会在 toDocx 里映射成加粗标题。 */
      return { ok: true, source: { title, body: raw } };
    case "xlsx": {
      /* Excel：沿用 csv 的分隔符识别（, / \t / ;），拿二维表；纯叙事则每行一个单元格。 */
      const grid = splitDelimited(raw, detectDelim(raw));
      if (!grid.length) return { ok: false, error: "内容为空，没有可导出的表格行" };
      return { ok: true, source: grid };
    }
    case "pptx": {
      /* PPT：空行分段，每段一页；段内首行作标题，其余行作要点（最多 12 行/页）。 */
      const blocks = raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
      const slides = (blocks.length ? blocks : [raw.trim()]).map((b) => {
        const lines = b.split(/\r?\n/)
          .map((l) => l.replace(/^\s*#{1,3}\s+/, "").replace(/^\s*[-*]\s+/, "").trim())
          .filter(Boolean);
        return { title: lines[0] || title, bullets: lines.slice(1, 12) };
      });
      return { ok: true, source: { title, slides } };
    }
    default:
      return { ok: false, error: `不支持的目标格式：${format}` };
  }
}

function isSafeFrame(p) {
  const s = String(p ?? "").trim();
  if (!s || !s.startsWith("frames/")) return false;      // 只允许 frames/ 本地相对路径
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return false; // 协议（http/data/file/js…）
  if (s.startsWith("//") || s.includes("..") || s.includes("\\")) return false;
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s)) return false;
  return true;
}

export function createExporter(opts = {}) {
  const fs = opts.fs || fsp;
  const syncFs = opts.syncFs || syncFsDefault;
  const now = opts.now || Date.now;
  const runFile = typeof opts.runFile === "function" ? opts.runFile : null;
  const profile = normalizeProfile(opts.profile ?? DEFAULT_PROFILE);
  const defaultEpoch = Number(opts.epoch) || 0;

  function fmtTime(sec) {
    let s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const ss = Math.floor(s);
    const ms = Math.min(999, Math.round((s - ss) * 1000));
    const pad = (n, l = 2) => String(n).padStart(l, "0");
    return `${pad(h)}:${pad(m)}:${pad(ss)}.${pad(ms, 3)}`;
  }

  function toVtt(segments) {
    const lines = ["WEBVTT", ""];
    (Array.isArray(segments) ? segments : []).forEach((seg, i) => {
      const text = esc(seg?.text);
      lines.push(String(i + 1), `${fmtTime(seg?.start)} --> ${fmtTime(seg?.end)}`, text, "");
    });
    return lines.join("\n");
  }

  function toLrc(segments) {
    const body = (Array.isArray(segments) ? segments : []).map((seg) => {
      const s = Math.max(0, Number(seg?.start) || 0);
      const m = Math.floor(s / 60);
      return `[${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(2).padStart(5, "0")}]${String(seg?.text ?? "")}`;
    }).join("\n");
    return body ? body + "\n" : "";
  }

  function toDelimited(rows, delim) {
    const rs = (Array.isArray(rows) ? rows : []).map((r) =>
      r && typeof r === "object" ? r : { value: r });
    const keys = [];
    for (const r of rs) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r")
        ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const out = [keys.map(cell).join(delim)];
    for (const r of rs) out.push(keys.map((k) => cell(r[k])).join(delim));
    return out.join("\r\n") + "\r\n";
  }
  const toCsv = (rows) => toDelimited(rows, ",");
  const toTsv = (rows) => toDelimited(rows, "\t");

  function toHtml({ title = "", body = "", frames = [] } = {}) {
    const imgs = (Array.isArray(frames) ? frames : [])
      .map((f) => (typeof f === "string" ? f : f?.src ?? f?.path ?? ""))
      .filter(isSafeFrame)
      .map((p) => `<figure><img src="${esc(p)}" alt=""></figure>`)
      .join("\n");
    return [
      "<!doctype html>", '<html lang="zh">', "<head>", '<meta charset="utf-8">',
      `<title>${esc(title)}</title>`,
      "<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.6}pre{white-space:pre-wrap;word-break:break-word}img{max-width:100%}</style>",
      "</head>", "<body>", `<h1>${esc(title)}</h1>`,
      `<pre class="body">${esc(body)}</pre>`, imgs, "</body>", "</html>", "",
    ].join("\n");
  }

  function toMarkdown({ title = "", meta = {}, sections = [] } = {}) {
    const m = meta && typeof meta === "object" ? meta : {};
    const fmVal = (v) => JSON.stringify(v == null ? "" : String(v));
    const fm = [
      "---",
      `key: ${fmVal(m.key)}`,
      `epoch: ${fmVal(m.epoch)}`,
      `generatedAt: ${fmVal(m.generatedAt ?? new Date(now()).toISOString())}`,
      `source: ${fmVal(m.source)}`,
      `revision: ${fmVal(m.revision)}`,
      "---", "",
    ].join("\n");
    const secs = (Array.isArray(sections) ? sections : []).map((sec) => {
      if (sec == null) return "";
      if (typeof sec === "string") return sec;
      const h = sec.heading ?? sec.title ?? "";
      const b = sec.body ?? sec.text ?? sec.content ?? "";
      return (h ? `## ${h}\n\n` : "") + (Array.isArray(b) ? b.join("\n") : String(b));
    });
    return fm + (title ? `# ${title}\n\n` : "") + secs.join("\n\n") + "\n";
  }

  function render(format, source) {
    switch (format) {
      case "vtt": return toVtt(source);
      case "lrc": return toLrc(source);
      /* csv/tsv 在「落盘这一层」加 BOM。toCsv() 本身保持纯净（单测锁着这个契约），
         但导出的文件是给 Excel 看的 —— 没有 BOM，Windows 上的中文就是一堆乱码。
         这是「纯函数」和「给人用的文件」之间的差别，放在 render 正好。 */
      case "csv": return CSV_BOM + toCsv(source);
      case "tsv": return CSV_BOM + toTsv(source);
      case "html": return toHtml(source || {});
      case "md": return toMarkdown(source || {});
      case "txt": return typeof source === "string" ? source
        : Array.isArray(source) ? source.map((x) => String(x)).join("\n")
        : JSON.stringify(source ?? "");
      default: return "";
    }
  }

  /* tmp + rename 原子写（异步），失败收敛为返回值，绝不抛。 */
  async function writeAtomic(outPath, content) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
    try {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      const part = `${outPath}.part`;
      await fs.writeFile(part, buf);
      try { await fs.rename(part, outPath); }
      catch { await fs.writeFile(outPath, buf); try { await fs.unlink(part); } catch {} }
      return { ok: true, path: outPath, bytes: buf.length, sha: sha256(buf) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), path: outPath, bytes: 0, sha: null };
    }
  }

  /* ZIP 用同步原子写，二进制一次成形。 */
  function writeSyncAtomic(outPath, buf) {
    try {
      syncFs.mkdirSync(path.dirname(outPath), { recursive: true });
      const part = `${outPath}.part`;
      syncFs.writeFileSync(part, buf);
      try { syncFs.renameSync(part, outPath); }
      catch { syncFs.writeFileSync(outPath, buf); try { syncFs.unlinkSync(part); } catch {} }
      return { ok: true, path: outPath, bytes: buf.length, sha: sha256(buf) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), path: outPath, bytes: 0, sha: null };
    }
  }

  /* 纯 Node 内置 store ZIP：local header + central directory + EOCD + CRC32。 */
  function toZip(files, outPath) {
    const { time, date } = dosDateTime(now());
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of (Array.isArray(files) ? files : [])) {
      const nameBuf = Buffer.from(safeZipName(f?.name), "utf8");
      const data = Buffer.isBuffer(f?.content) ? f.content : Buffer.from(String(f?.content ?? ""), "utf8");
      const crc = crc32(data);

      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);          // version needed
      lh.writeUInt16LE(0x0800, 6);      // UTF-8 文件名标志
      lh.writeUInt16LE(0, 8);           // store
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(data.length, 18);
      lh.writeUInt32LE(data.length, 22);
      lh.writeUInt16LE(nameBuf.length, 26);
      lh.writeUInt16LE(0, 28);
      parts.push(lh, nameBuf, data);

      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(0, 10);
      ch.writeUInt16LE(time, 12);
      ch.writeUInt16LE(date, 14);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(data.length, 20);
      ch.writeUInt32LE(data.length, 24);
      ch.writeUInt16LE(nameBuf.length, 28);
      ch.writeUInt16LE(0, 30);          // extra
      ch.writeUInt16LE(0, 32);          // comment
      ch.writeUInt16LE(0, 34);          // disk
      ch.writeUInt16LE(0, 36);          // internal attrs
      ch.writeUInt32LE(0, 38);          // external attrs
      ch.writeUInt32LE(offset, 42);     // local header offset
      central.push(Buffer.concat([ch, nameBuf]));

      offset += lh.length + nameBuf.length + data.length;
    }
    const cdBuf = Buffer.concat(central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return writeSyncAtomic(outPath, Buffer.concat([...parts, cdBuf, eocd]));
  }

  /* ---------- Office 三件套：拼 OOXML 部件 → 复用 toZip 落盘 ---------- */
  function toDocx(source, outPath) {
    const s = source && typeof source === "object" ? source : {};
    const title = String(s.title ?? "导出");
    const body = typeof source === "string" ? source : String(s.body ?? "");
    const titleP = `<w:p><w:pPr><w:spacing w:after="240"/></w:pPr><w:r>`
      + `<w:rPr><w:b/><w:sz w:val="40"/></w:rPr>`
      + `<w:t xml:space="preserve">${xmlText(title)}</w:t></w:r></w:p>`;
    const documentXml = XML_DECL
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + `<w:body>${titleP}${docxParagraphs(body)}`
      + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
      + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
      + 'w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>';
    return toZip([
      { name: "[Content_Types].xml", content: pkgContentTypes([
        { part: "/word/document.xml", type: CT.docxMain },
      ]) },
      { name: "_rels/.rels", content: pkgRels([
        { id: "rId1", type: RT.doc, target: "word/document.xml" },
      ]) },
      { name: "word/document.xml", content: documentXml },
    ], outPath);
  }

  function toXlsx(source, outPath) {
    const raw = Array.isArray(source) ? source : [[String(source ?? "")]];
    const grid = raw.length ? raw : [[""]];
    const rowsXml = grid.map((row, ri) => {
      const cells = (Array.isArray(row) ? row : Object.values(row || {})).map((v, ci) => {
        const ref = `${colName(ci + 1)}${ri + 1}`;
        const t = String(v ?? "");
        // 纯数字写成数值单元格，Excel 打开后能直接求和；其余用 inlineStr，省掉 sharedStrings。
        if (/^-?\d{1,15}(?:\.\d{1,6})?$/.test(t)) return `<c r="${ref}"><v>${t}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlText(t)}</t></is></c>`;
      }).join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join("");
    const sheetXml = XML_DECL
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<sheetData>${rowsXml}</sheetData></worksheet>`;
    const bookXml = XML_DECL
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
    return toZip([
      { name: "[Content_Types].xml", content: pkgContentTypes([
        { part: "/xl/workbook.xml", type: CT.xlsxBook },
        { part: "/xl/worksheets/sheet1.xml", type: CT.xlsxSheet },
      ]) },
      { name: "_rels/.rels", content: pkgRels([
        { id: "rId1", type: RT.doc, target: "xl/workbook.xml" },
      ]) },
      { name: "xl/workbook.xml", content: bookXml },
      { name: "xl/_rels/workbook.xml.rels", content: pkgRels([
        { id: "rId1", type: RT.worksheet, target: "worksheets/sheet1.xml" },
      ]) },
      { name: "xl/worksheets/sheet1.xml", content: sheetXml },
    ], outPath);
  }

  function toPptx(source, outPath) {
    const s = source && typeof source === "object" ? source : {};
    const title = String(s.title ?? "导出");
    let slides = (Array.isArray(s.slides) && s.slides.length) ? s.slides.slice(0, 200) : [{ title, bullets: [] }];

    const themeRid = `rId${2 + slides.length}`;
    const presXml = XML_DECL + `<p:presentation ${NS_PPT}>`
      + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
      + `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${2 + i}"/>`).join("")}</p:sldIdLst>`
      + '<p:sldSz cx="9144000" cy="5143500" type="screen16x9"/>'
      + '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>';
    const masterXml = XML_DECL + `<p:sldMaster ${NS_PPT}>`
      + `<p:cSld><p:spTree>${SP_TREE_BASE}</p:spTree></p:cSld>`
      + `<p:clrMap ${CLR_MAP_ATTRS}/>`
      + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
      + '</p:sldMaster>';
    const layoutXml = XML_DECL + `<p:sldLayout ${NS_PPT} type="blank" preserve="1">`
      + `<p:cSld name="Blank"><p:spTree>${SP_TREE_BASE}</p:spTree></p:cSld>`
      + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

    const files = [
      { name: "[Content_Types].xml", content: pkgContentTypes([
        { part: "/ppt/presentation.xml", type: CT.pptxPres },
        { part: "/ppt/slideMasters/slideMaster1.xml", type: CT.pptxMaster },
        { part: "/ppt/slideLayouts/slideLayout1.xml", type: CT.pptxLayout },
        { part: "/ppt/theme/theme1.xml", type: CT.theme },
        ...slides.map((_, i) => ({ part: `/ppt/slides/slide${i + 1}.xml`, type: CT.pptxSlide })),
      ]) },
      { name: "_rels/.rels", content: pkgRels([
        { id: "rId1", type: RT.doc, target: "ppt/presentation.xml" },
      ]) },
      { name: "ppt/presentation.xml", content: presXml },
      { name: "ppt/_rels/presentation.xml.rels", content: pkgRels([
        { id: "rId1", type: RT.slideMaster, target: "slideMasters/slideMaster1.xml" },
        ...slides.map((_, i) => ({ id: `rId${2 + i}`, type: RT.slide, target: `slides/slide${i + 1}.xml` })),
        { id: themeRid, type: RT.theme, target: "theme/theme1.xml" },
      ]) },
      { name: "ppt/slideMasters/slideMaster1.xml", content: masterXml },
      { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", content: pkgRels([
        { id: "rId1", type: RT.slideLayout, target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: RT.theme, target: "../theme/theme1.xml" },
      ]) },
      { name: "ppt/slideLayouts/slideLayout1.xml", content: layoutXml },
      { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", content: pkgRels([
        { id: "rId1", type: RT.slideMaster, target: "../slideMasters/slideMaster1.xml" },
      ]) },
      { name: "ppt/theme/theme1.xml", content: PPTX_THEME },
    ];
    slides.forEach((sl, i) => {
      const n = i + 1;
      files.push({ name: `ppt/slides/slide${n}.xml`, content: pptxSlideXml(sl) });
      files.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, content: pkgRels([
        { id: "rId1", type: RT.slideLayout, target: "../slideLayouts/slideLayout1.xml" },
      ]) });
    });
    return toZip(files, outPath);
  }

  /* 动态加载 node:sqlite；不可用或写失败一律返回 {ok:false,error}，不抛。 */
  async function toDb(rows, outPath) {
    let sqlite;
    try { sqlite = await import("node:sqlite"); }
    catch (e) { return { ok: false, error: `node:sqlite 不可用: ${e?.message || e}`, path: outPath }; }
    if (!sqlite || typeof sqlite.DatabaseSync !== "function") {
      return { ok: false, error: "node:sqlite 缺少 DatabaseSync", path: outPath };
    }
    try {
      syncFs.mkdirSync(path.dirname(outPath), { recursive: true });
      try { syncFs.unlinkSync(outPath); } catch {}
      const db = new sqlite.DatabaseSync(outPath);
      try {
        db.exec("CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
        const ins = db.prepare("INSERT INTO snapshot (data) VALUES (?)");
        for (const r of (Array.isArray(rows) ? rows : [])) ins.run(JSON.stringify(r ?? null));
      } finally { db.close(); }
      const buf = syncFs.readFileSync(outPath);
      return { ok: true, path: outPath, bytes: buf.length, sha: sha256(buf) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e), path: outPath, bytes: 0, sha: null };
    }
  }

  /* PDF 计划：bridge 侧只能给「渲染什么」，落盘必须由主进程的 webContents.printToPDF 完成。
     fileName 由这里算好，面板原样转交即可 —— 渲染层不碰任何路径拼接。 */
  function pdfPlan(html, outPath) {
    return {
      delegated: "main-renderer",
      channel: "artifact-render-pdf",
      html,
      outPath,
      fileName: path.basename(String(outPath || "export.pdf")),
      reason: "bridge 跑在 ELECTRON_RUN_AS_NODE=1 下，拿不到 Electron 打印/导出 PDF API，必须委托主渲染进程执行",
    };
  }

  async function run({ format, source, outPath, epoch } = {}) {
    const finalEpoch = Number(epoch) || defaultEpoch;
    let dest = outPath;
    if (!dest) {
      // 未给路径时只落到系统临时目录，绝不写项目真实数据目录
      dest = path.join(os.tmpdir(), resolveName(profile.nameTemplate, {
        epoch: finalEpoch, ext: format, title: "export", date: dayTag(now()), seq: 0,
      }));
    }
    if (!FORMATS.includes(format)) {
      return { ok: false, error: `unknown format: ${format}`, path: dest, bytes: 0, sha: null, format, epoch: finalEpoch };
    }

    // 注入 runFile 时优先委托；委托失败再回退内置实现，保证内置始终可用。
    if (runFile) {
      try {
        const content = ["pdf", "zip", "db", "docx", "xlsx", "pptx"].includes(format)
          ? null : render(format, source);
        const r = await runFile({ format, source, outPath: dest, epoch: finalEpoch, content });
        if (r && r.ok) {
          return {
            ok: true, path: r.path || dest, bytes: Number(r.bytes) || 0,
            sha: r.sha ?? null, format, epoch: finalEpoch, delegated: true,
          };
        }
      } catch { /* 回退内置 */ }
    }

    if (format === "pdf") {
      const html = typeof source === "string" ? source : toHtml(source || {});
      /* pending: 文件此刻**还不存在**，只是拿到了渲染计划。
         调用方必须把 plan 交给主进程落地，落地成功才算真的导出成功。 */
      return {
        ok: true, pending: true, path: dest, bytes: 0, sha: null, format, epoch: finalEpoch,
        delegated: "main-renderer", plan: pdfPlan(html, dest),
      };
    }
    if (format === "zip") {
      return { ...toZip(Array.isArray(source) ? source : [], dest), format, epoch: finalEpoch };
    }
    /* Office 三件套是二进制 OOXML（zip 包），不能走 render() 的文本路径。 */
    if (format === "docx") {
      return { ...toDocx(source, dest), format, epoch: finalEpoch };
    }
    if (format === "xlsx") {
      return { ...toXlsx(source, dest), format, epoch: finalEpoch };
    }
    if (format === "pptx") {
      return { ...toPptx(source, dest), format, epoch: finalEpoch };
    }
    if (format === "db") {
      return { ...(await toDb(Array.isArray(source) ? source : [], dest)), format, epoch: finalEpoch };
    }
    return { ...(await writeAtomic(dest, render(format, source))), format, epoch: finalEpoch };
  }

  return {
    run, toVtt, toCsv, toHtml, toMarkdown, toZip, toDb,
    toDocx, toXlsx, toPptx, pdfPlan, buildSource, formats: FORMATS,
  };
}

/* ============ 命名段与临时内容判定（纯函数，无任何 IO） ============ */

/* 冻结的命名段登记表：调用方按名字开关，段义集中在这里，别处不再复制。 */
export const EXPORT_SECTIONS = Object.freeze({
  report: Object.freeze({
    name: "report",
    description: "报告正文：结论与摘要",
  }),
  evidence: Object.freeze({
    name: "evidence",
    description: "证据段：不可信输入只当数据，绝不提升为结论",
  }),
  skill: Object.freeze({
    name: "skill",
    description: "技能段：可复用的操作步骤与方法",
  }),
});

const SECTION_NAMES = Object.freeze(Object.keys(EXPORT_SECTIONS));

/**
 * 按名字开关命名段。纯函数：返回新的冻结状态，不改入参。
 * current 为当前开关状态（缺省全开）；changes 支持
 *   字符串（翻转单段）/ 数组（翻转多段）/ 对象（{name:true|false} 按名字设置）。
 * 只认 EXPORT_SECTIONS 里的名字，未知名字忽略。
 */
export function sectionToggle(current, changes) {
  if (changes === undefined) { changes = current; current = null; }
  const state = {};
  for (const name of SECTION_NAMES) {
    state[name] = current && typeof current[name] === "boolean" ? current[name] : true;
  }
  const flip = (name) => {
    if (SECTION_NAMES.includes(name)) state[name] = !state[name];
  };
  if (typeof changes === "string") flip(changes);
  else if (Array.isArray(changes)) changes.forEach(flip);
  else if (changes && typeof changes === "object") {
    for (const [name, on] of Object.entries(changes)) {
      if (SECTION_NAMES.includes(name)) state[name] = !!on;
    }
  }
  return Object.freeze(state);
}

/**
 * 临时内容处置判定。纯函数：只返回判定，不触发任何外部动作。
 * temp===true 时 persist:false 并记一条拒因；否则 persist:true。
 * 返回体不回传 record 内容，从形状上保证不持久化、不落盘；at 可注入以便确定性测试。
 */
export function markTempDisposition(input = {}) {
  const o = input && typeof input === "object" ? input : {};
  const temp = o.temp === true;
  const rec = o.record && typeof o.record === "object" ? o.record : null;
  const inherited = rec && (rec.reasonCode ?? rec.reason);
  const reason = String(o.reason ?? inherited ?? (temp
    ? "temp-mark: 临时内容仅内存判定，不持久化"
    : "ok: 常规内容允许持久化"));
  const at = o.at !== undefined ? o.at
    : (typeof o.now === "function" ? o.now() : (o.now !== undefined ? o.now : Date.now()));
  return {
    persist: !temp,
    disposition: temp ? "discard" : "persist",
    reason,
    at,
  };
}

/**
 * 把一段文本包成 evidence 命名段：不可信输入只当数据，绝不提升为结论。
 * 本地纯逻辑（不依赖 textGate）：含 UNVERIFIED: 前缀、或 trust!==trusted 的
 * 条目单列进 unverified，整段恒 trusted:false / conclusion:null，可直接喂给 toMarkdown。
 */
export function evidenceSection(text, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const trust = o.trust === undefined ? "untrusted" : String(o.trust);
  const unverified = [];
  const data = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const flagged = /^\s*UNVERIFIED:/i.test(line) || trust !== "trusted";
    const item = { text: line, dataOnly: true, trust: flagged ? "unverified" : trust };
    data.push(item);
    if (flagged) unverified.push(item);
  }
  return {
    name: "evidence",
    heading: EXPORT_SECTIONS.evidence.description,
    trusted: false,
    asData: true,
    conclusion: null,
    unverified,
    body: data.map((d) => `- [DATA] ${d.text}`).join("\n"),
  };
}
