/* ---------------- 附件即时解析（attach-probe） ----------------
 *
 * 现状（改造前）：附件是**纯引用**——面板把「名称（大小）— 路径」拼进任务文本，
 * 谁都不读文件内容。用户丢一份 30 页 PDF 进来，Agent 收到的只有一行路径，
 * 于是要么自己再花一轮去读（多一次往返），要么干脆读不到（CLI 侧没权限/没工具）。
 *
 * 这里改成：**选完文件立刻在后台探一遍**，把"能一眼看出来的事实"先取出来 ——
 * 页数、字数、尺寸、时长、有没有音轨、第一段摘要。面板拿到就挂个徽标，
 * 同时把摘要并进任务文本。好处是双向的：
 *   · 模型不必为了"这是什么"多跑一轮；
 *   · 用户在选择的那一刻就能看出"这份 PDF 是扫描件、抽不出字"。
 *
 * 三条纪律：
 *   ① **只读、只取头部**。不上传、不拷贝、不改 mtime；文本最多读 8KB，
 *      压缩包只解需要的那一个 entry（不解压整包）。
 *   ② **失败要能解释**。每个文件都带 note：是"加密"、"扫描件"、"格式不支持"
 *      还是"体积过大跳过"，而不是统一一句"解析失败"。
 *   ③ **不阻塞主进程**。全部 async，且单个文件 3 秒超时 —— 选 10 个视频时
 *      不能把面板卡住（用户会以为程序死了）。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const HEAD_BYTES = 8192;             // 文本只读头部：够判断类型 + 取摘要
const EXCERPT_CHARS = 600;           // 摘要长度：面板一行能显示完
const PER_FILE_TIMEOUT = 3000;

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "log", "yml", "yaml",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "go", "rs", "java", "c", "h",
  "cpp", "cs", "sql", "sh", "ps1", "bat", "cmd", "html", "htm", "css", "xml",
  "srt", "vtt", "ini", "conf", "toml",
]);
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const VIDEO_EXT = new Set(["mp4", "mov", "m4v", "mkv", "webm", "avi", "flv", "ts", "wmv"]);
const AUDIO_EXT = new Set(["mp3", "wav", "m4a", "flac", "aac", "ogg", "opus", "wma", "amr"]);
const DOC_EXT = new Set(["pdf", "docx", "xlsx", "pptx"]);

const extOf = (p) => path.extname(String(p || "")).slice(1).toLowerCase();
const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error("解析超时")), ms)),
]);

/* ---------------- 图片尺寸（只读头部几十字节） ---------------- */

function imageSize(buf) {
  // PNG: 8B 签名 + IHDR
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }
  // GIF: "GIF87a"/"GIF89a" + 逻辑屏幕宽高（小端）
  if (buf.length > 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: "gif" };
  }
  // BMP
  if (buf.length > 26 && buf.toString("ascii", 0, 2) === "BM") {
    return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)), format: "bmp" };
  }
  // JPEG: 找 SOF0/1/2
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), format: "jpg" };
      }
      i += 2 + len;
    }
    return { format: "jpg" };
  }
  // WebP: RIFF....WEBP + VP8X
  if (buf.length > 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    if (buf.toString("ascii", 12, 16) === "VP8X") {
      const w = 1 + buf.readUIntLE(24, 3);
      const h = 1 + buf.readUIntLE(27, 3);
      return { width: w, height: h, format: "webp" };
    }
  }
  return { format: extOf("") || "" };
}

/* ---------------- MP4/MOV：读 moov/mvhd 拿时长，读 handler 判有无音轨 ----------------
 * 只走顶层 box：样本表那堆（stbl）一个都不碰，代价是拿不到码率/帧率，
 * 但那不是"该不该把它丢给谁"的判断依据，时长和音轨才是。 */

function mp4Meta(buf, opts = {}) {
  const out = { durationMs: 0, hasAudio: null, brand: "", moovFound: false };
  /* 从 buffer 头部顺序走 box。若给了 scan，先在整段里找 'moov' 再回退 4 字节当起点 ——
   * 用于"moov 在文件尾部"的常见情形（ORB 自己录的片子就是这样，
   * 直接顺序解析会因为起点落在半个 box 中间而立刻 break）。 */
  let off = 0;
  if (opts.scan) {
    const i = buf.indexOf(Buffer.from("moov", "latin1"));
    if (i >= 4) off = i - 4;
  }
  const end = buf.length;
  let guard = 0;
  while (off + 8 <= end && guard++ < 64) {
    const size = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (size < 8 || off + size > end) break;
    if (type === "ftyp") out.brand = buf.toString("ascii", off + 8, off + 12);
    if (type === "moov") {
      out.moovFound = true;
      // 在 moov 里找 mvhd
      let p = off + 8;
      const moovEnd = off + size;
      let g2 = 0;
      while (p + 8 <= moovEnd && g2++ < 32) {
        const s2 = buf.readUInt32BE(p);
        const t2 = buf.toString("ascii", p + 4, p + 8);
        if (s2 < 8 || p + s2 > moovEnd) break;
        if (t2 === "mvhd") {
          const ver = buf[p + 8];
          if (ver === 1) {
            const timescale = buf.readUInt32BE(p + 8 + 4 + 16);
            const dur = Number(buf.readBigUInt64BE(p + 8 + 4 + 20));
            if (timescale) out.durationMs = Math.round((dur / timescale) * 1000);
          } else {
            const timescale = buf.readUInt32BE(p + 8 + 4 + 8);
            const dur = buf.readUInt32BE(p + 8 + 4 + 12);
            if (timescale) out.durationMs = Math.round((dur / timescale) * 1000);
          }
        }
        p += s2;
      }
    }
    off += size;
  }
  /* 音轨判定只在**真读到 moov** 时给结论。
   * 只扫头部 512KB 时，moov（以及它里面的 handler）很可能在文件尾部 ——
   * 这时候说"无音轨"就是编造：录屏明明有声音，面板却告诉用户"无音轨"，
   * 下游就会据此跳过转写。宁可返回 null（不知道）。 */
  if (out.moovFound) {
    const tail = buf.toString("latin1");
    out.hasAudio = tail.includes("soun");
  }
  return out;
}

/* ---------------- 最小 ZIP 读取（docx/xlsx/pptx 都是 zip） ----------------
 * 为什么不用三方库：这个文件会被打包进发布版，多一个依赖就多一条供应链风险，
 * 而我们只需要"按名字取一个 entry 解压"这一件事。 */

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function listZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compSize, rawSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipEntry(buf, entry) {
  if (!entry) return null;
  const lh = entry.localOff;
  if (buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return data.toString("utf8");
  if (entry.method === 8) return zlib.inflateRawSync(data).toString("utf8");
  return null;   // 其他压缩方式（如 zip64/加密）不支持，交给 note 说明
}

const decodeXml = (s) => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<w:p[ >]/g, "\n<w:p ")
  .replace(/<\/(w:p|a:p|row)>/g, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/[ \t\u3000]+/g, " ")
  .replace(/\n{2,}/g, "\n")
  .trim();

/* ---------------- PDF ----------------
 * 只做两件事：数页数、尽量抽一层文本。
 * 抽不出来**不代表文件坏**：扫描件、加密、CID 字体都会抽不出。所以给 confidence，
 * 面板据此显示"扫描件（需 OCR）"而不是"解析失败"。 */

function pdfInfo(buf) {
  const s = buf.toString("latin1");
  let pages = (s.match(/\/Type\s*\/Page[^s]/g) || []).length;
  if (!pages) {
    const m = s.match(/\/Count\s+(\d+)/);
    if (m) pages = Number(m[1]);
  }
  const encrypted = /\/Encrypt\b/.test(s);

  let text = "";
  if (!encrypted) {
    const re = /stream\r?\n/g;
    let hits = 0;
    let m;
    while ((m = re.exec(s)) && hits < 3) {
      const start = m.index + m[0].length;
      const endIdx = s.indexOf("endstream", start);
      if (endIdx < 0) break;
      const chunk = buf.subarray(start, endIdx);
      let out = null;
      try { out = zlib.inflateSync(chunk).toString("latin1"); } catch { continue; }
      hits++;
      const parts = out.match(/\((?:\\.|[^()\\])*\)/g) || [];
      const joined = parts.map((x) => x.slice(1, -1).replace(/\\([()\\])/g, "$1")).join(" ");
      if (joined.trim()) text += `${joined} `;
      if (text.length > EXCERPT_CHARS * 2) break;
    }
  }
  return {
    pages,
    encrypted,
    text: text.replace(/\s+/g, " ").trim(),
    confidence: text.trim().length > 40 ? "medium" : "low",
  };
}

/* ---------------- 主入口 ---------------- */

async function probeOne(filePath) {
  const started = Date.now();
  const name = path.basename(String(filePath || ""));
  const ext = extOf(filePath);
  const base = {
    path: String(filePath || ""), name, ext,
    size: 0, kind: "other", readable: false,
    excerpt: "", chars: 0, meta: {}, note: "", parsedAt: Date.now(), ms: 0,
  };

  let st;
  try { st = await fsp.stat(filePath); }
  catch { return { ...base, note: "文件读不到（可能已被删除或无权限）" }; }
  base.size = st.size;

  if (TEXT_EXT.has(ext)) {
    try {
      const fh = await fsp.open(filePath, "r");
      try {
        const buf = Buffer.alloc(Math.min(HEAD_BYTES, base.size));
        await fh.read(buf, 0, buf.length, 0);
        const text = buf.toString("utf8").replace(/\u0000/g, "");
        base.kind = "text";
        base.readable = true;
        base.chars = base.size <= HEAD_BYTES ? text.length : Math.round((text.length / buf.length) * base.size);
        base.excerpt = text.slice(0, EXCERPT_CHARS).trim();
        base.note = base.size > HEAD_BYTES ? "只读了开头 8KB 估算字数" : "";
      } finally { await fh.close(); }
    } catch (e) { base.note = `读取失败：${e.message}`; }
    base.ms = Date.now() - started;
    return base;
  }

  if (IMG_EXT.has(ext)) {
    try {
      const fh = await fsp.open(filePath, "r");
      try {
        const buf = Buffer.alloc(Math.min(65536, base.size));
        await fh.read(buf, 0, buf.length, 0);
        const dim = imageSize(buf);
        base.kind = "image";
        base.readable = true;
        base.meta = dim;
        base.note = dim.width ? "" : "已识别为图片，但读不出尺寸";
      } finally { await fh.close(); }
    } catch (e) { base.note = `读取失败：${e.message}`; }
    base.ms = Date.now() - started;
    return base;
  }

  if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) {
    // 只看头部 512KB：moov 在文件头（faststart）时够用；在尾部时只报"时长未知"。
    try {
      const fh = await fsp.open(filePath, "r");
      try {
        const buf = Buffer.alloc(Math.min(524288, base.size));
        await fh.read(buf, 0, buf.length, 0);
        let m = mp4Meta(buf);
        /* 头部没找到 moov → 再读尾部 1MB 找一次。
         * 不这么做的话，ORB 自己录的每一段视频都会显示"时长未知"，
         * 而这个字段恰恰是用户判断"要不要让 Agent 看完整段"的依据。 */
        if (!m.moovFound && base.size > buf.length) {
          const tailLen = Math.min(1048576, base.size);
          const tail = Buffer.alloc(tailLen);
          await fh.read(tail, 0, tailLen, base.size - tailLen);
          const m2 = mp4Meta(tail, { scan: true });
          if (m2.moovFound) m = { ...m2, brand: m.brand || m2.brand };
        }
        base.kind = VIDEO_EXT.has(ext) ? "video" : "audio";
        base.readable = true;
        base.meta = m;
        /* 时长/音轨由 meta 承载，note 只在"读不出来"时给解释 ——
         * 否则 chip 上会出现"6s，无音轨，6s，无音轨"这种重复。 */
        base.note = m.durationMs ? "" : "时长未知（moov 不在首尾 1MB 内，完整信息需 vidx 探底）";
      } finally { await fh.close(); }
    } catch (e) { base.note = `读取失败：${e.message}`; }
    base.ms = Date.now() - started;
    return base;
  }

  if (DOC_EXT.has(ext)) {
    try {
      const buf = await fsp.readFile(filePath);
      if (ext === "pdf") {
        const p = pdfInfo(buf);
        base.kind = "pdf";
        base.readable = !p.encrypted;
        base.meta = { pages: p.pages, encrypted: p.encrypted, confidence: p.confidence };
        base.excerpt = p.text.slice(0, EXCERPT_CHARS);
        base.chars = p.text.length;
        base.note = p.encrypted ? "PDF 已加密，抽不出文本"
          : (p.confidence === "low" ? "抽不出文本（大概是扫描件，需要 OCR）" : "");
      } else {
        const entries = listZip(buf);
        if (!entries) { base.note = "不是有效的 zip 容器（文件可能损坏）"; }
        else if (ext === "docx") {
          const doc = readZipEntry(buf, entries.find((e) => e.name === "word/document.xml"));
          const text = decodeXml(doc);
          base.kind = "docx";
          base.readable = !!doc;
          base.chars = text.length;
          base.excerpt = text.slice(0, EXCERPT_CHARS);
          base.meta = { paragraphs: (doc || "").split(/<\/w:p>/).length, entries: entries.length };
          base.note = doc ? `约 ${text.length} 字` : "docx 结构里没找到正文";
        } else if (ext === "xlsx") {
          const ss = readZipEntry(buf, entries.find((e) => e.name === "xl/sharedStrings.xml"));
          const strings = (ss || "").match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
          const text = decodeXml(strings.slice(0, 300).join("\n"));
          const sheets = entries.filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).length;
          base.kind = "xlsx";
          base.readable = !!ss;
          base.chars = text.length;
          base.excerpt = text.slice(0, EXCERPT_CHARS);
          base.meta = { sheets, sharedStrings: strings.length };
          base.note = `${sheets} 个工作表，${strings.length} 条共享字符串（只取前 300 条做预览）`;
        } else {
          const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).length;
          base.kind = "pptx";
          base.readable = true;
          base.meta = { slides };
          base.note = `共 ${slides} 页幻灯片（文本需逐页解析，这里只报页数）`;
        }
      }
    } catch (e) { base.note = `解析失败：${e.message}`; }
    base.ms = Date.now() - started;
    return base;
  }

  base.note = "未识别的格式，只记录大小与路径（交给 Agent 自行判断）";
  base.ms = Date.now() - started;
  return base;
}

/** 入口：单文件（永不抛） */
async function probe(filePath) {
  try {
    return await withTimeout(probeOne(filePath), PER_FILE_TIMEOUT);
  } catch (e) {
    return {
      path: String(filePath || ""), name: path.basename(String(filePath || "")), ext: extOf(filePath),
      size: 0, kind: "other", readable: false, excerpt: "", chars: 0, meta: {},
      note: e.message || "解析失败", parsedAt: Date.now(), ms: PER_FILE_TIMEOUT,
    };
  }
}

/** 入口：批量（并发 3，避免一次选 10 个视频把 IO 打满） */
async function probeMany(filePaths, opts = {}) {
  const list = Array.isArray(filePaths) ? filePaths : [];
  const concurrency = Math.max(1, Math.min(Number(opts.concurrency) || 3, 6));
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      out[idx] = await probe(list[idx]);
    }
  }));
  return out;
}

/** 把探针结果压成一行给人/给模型看的事实，供任务文本使用。 */
function summarize(p) {
  if (!p) return "";
  const bits = [];
  if (p.kind === "pdf" && p.meta?.pages) bits.push(`${p.meta.pages} 页`);
  if (p.meta?.sheets) bits.push(`${p.meta.sheets} 表`);
  if (p.meta?.slides) bits.push(`${p.meta.slides} 页`);
  if (p.meta?.width) bits.push(`${p.meta.width}×${p.meta.height}`);
  if (p.meta?.durationMs) bits.push(`${Math.round(p.meta.durationMs / 1000)}s`);
  if (p.kind === "audio" || p.kind === "video") {
    if (p.meta?.hasAudio === false) bits.push("无音轨");
    if (p.meta?.hasAudio === true) bits.push("有音轨");
  }
  if (p.chars) bits.push(`约 ${p.chars} 字`);
  if (p.note) bits.push(p.note);
  return bits.filter(Boolean).join("，");
}

module.exports = { probe, probeMany, summarize, imageSize, mp4Meta, pdfInfo, listZip, readZipEntry };
