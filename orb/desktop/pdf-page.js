/* ---------------- PDF 首页转图片（给视觉模型看） ----------------
 *
 * 用途：Max 模式下，探针判定「抽不出文本（大概是扫描件）」的 PDF，
 * 自动把**第一页**转成一张图片交给视觉模型读字。不引入任何三方依赖。
 *
 * 为什么不是"渲染 PDF"：真正渲染需要 PDFium / pdf.js，几十 MB。
 * 而扫描件的每一页本来就是**一张图片对象**（`/Subtype /Image`），
 * 文字在像素里 —— 直接把那张图取出来就是最忠实的"渲染结果"，
 * 顺带还绕开了字体、矢量、透明混合这些坑。
 *
 * 支持的解码路径（按覆盖率排序）：
 *   ① DCTDecode  → 流本身就是一张完整 JPEG，原样返回（手机拍照转 PDF 最常见）
 *   ② FlateDecode + 8bit + DeviceGray/RGB → 解压（含 PNG 预测器）后重新封成 PNG
 *   ③ 其它（JBIG2 / CCITT G4 / JPX）→ 如实返回失败原因，不猜
 *
 * 明确不做的事：
 *   · 不 OCR（没有模型，也不该在这一层做）
 *   · 不转第 2 页以后（用户要的是"这份文件大概讲什么"，首页足够；
 *     转全部页会把一次附件解析变成几十次模型调用）
 *   · 不缩放大图（重采样要写插值，收益低；超限就如实说"太大"）
 */

const fs = require("node:fs/promises");
const zlib = require("node:zlib");

const MAX_PIXELS = 16 * 1024 * 1024;   // 1600 万像素，够 A4@300dpi（2480×3508）
const MAX_BYTES = 12 * 1024 * 1024;    // 转出来的图超过 12MB 就不往回传了
const MAX_READ = 128 * 1024 * 1024;    // 只读前 128MB：图片对象在 xref 之前，够用

/* ---------------- PNG 封装 ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把裸像素（每像素 1 或 3 字节）封成 PNG。 */
function pngFromRaw(raw, width, height, channels) {
  const stride = width * channels;
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rows[y * (stride + 1)] = 0;   // 过滤器 None：不折腾预测器，压缩率低一点但绝对不会错
    raw.copy(rows, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;                                   // bit depth
  ihdr[9] = channels === 1 ? 0 : 2;              // 0=Gray 2=RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;      // deflate / 无过滤 / 不隔行
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** PNG 预测器（Predictor >= 10）：每行开头一个过滤器字节，逐行还原。 */
function undoPngPredictor(data, width, height, bpp) {
  const rowLen = width * bpp;
  const need = (rowLen + 1) * height;
  if (data.length < need) return null;
  const out = Buffer.alloc(rowLen * height);
  let prev = Buffer.alloc(rowLen);
  for (let y = 0; y < height; y++) {
    const base = y * (rowLen + 1);
    const ft = data[base];
    const cur = Buffer.alloc(rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = data[base + 1 + i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * rowLen);
    prev = cur;
  }
  return out;
}

/** TIFF 预测器（Predictor 2）：横向差分，没有过滤器字节。 */
function undoTiffPredictor(data, width, height, bpp) {
  const rowLen = width * bpp;
  if (data.length < rowLen * height) return null;
  const out = Buffer.from(data.subarray(0, rowLen * height));
  for (let y = 0; y < height; y++) {
    for (let i = bpp; i < rowLen; i++) {
      out[y * rowLen + i] = (out[y * rowLen + i] + out[y * rowLen + i - bpp]) & 0xff;
    }
  }
  return out;
}

/* ---------------- PDF 对象扫描 ---------------- */

/* PDF 字典里键和值之间**不强制有空格**：紧凑生成的 PDF 会把
   `/ColorSpace/DeviceGray` 写在一起。这里必须用 \s* —— 早先写成 \s+
   的版本，遇到这种文件会直接判成"色彩空间未知"，然后安静地跳过整张图。 */
function dictValue(dict, key) {
  const m = dict.match(new RegExp("\\/" + key + "\\s*(\\/[A-Za-z0-9.#+-]+|[\\d.]+|\\[[^\\]]*\\])"));
  return m ? m[1] : "";
}

/** 把 PDF 里所有图片对象扫出来（不解析 xref，靠字典特征定位）。 */
function collectImages(s) {
  const out = [];
  const re = /\/Subtype\s*\/Image\b/g;
  let m;
  while ((m = re.exec(s))) {
    const open = s.lastIndexOf("<<", m.index);
    if (open < 0) continue;
    const close = s.indexOf(">>", m.index);
    if (close < 0) continue;
    const dict = s.slice(open, close + 2);
    const streamAt = s.indexOf("stream", close);
    if (streamAt < 0 || streamAt - close > 240) continue;   // 这个字典后面没跟着流，不是图片对象
    let p = streamAt + 6;
    if (s[p] === "\r") p++;
    if (s[p] === "\n") p++;
    const lm = dict.match(/\/Length\s+(\d+)/);
    let end = lm ? p + Number(lm[1]) : -1;
    if (end < 0 || end > s.length || !/^\s*endstream/.test(s.slice(end, end + 24))) {
      const e = s.indexOf("endstream", p);
      if (e < 0) continue;
      end = e;
      while (end > p && (s[end - 1] === "\n" || s[end - 1] === "\r")) end--;
    }
    const filter = (dict.match(/\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/) || [, ""])[1];
    out.push({
      dict, filter,
      width: Number(dictValue(dict, "Width")) || 0,
      height: Number(dictValue(dict, "Height")) || 0,
      bpc: Number(dictValue(dict, "BitsPerComponent")) || 8,
      cs: dictValue(dict, "ColorSpace").replace("/", ""),
      predictor: Number((dict.match(/\/Predictor\s+(\d+)/) || [, 0])[1]) || 0,
      start: p, end,
    });
  }
  return out;
}

/* ---------------- 主逻辑 ---------------- */

/**
 * 从 PDF 里取出「最像正文的那张图」。
 * 返回 { ok, mime, data(Buffer), width, height, note }
 */
function extractFirstImage(buf) {
  const s = buf.toString("latin1");
  const imgs = collectImages(s);
  if (!imgs.length) return { ok: false, note: "这份 PDF 里没有图片对象（可能是纯矢量/纯文本）" };

  /* 按面积从大到小试：扫描件正文一定是整页那张图，页眉 logo 面积小得多。
     解码失败的（JBIG2/CCITT）跳过，继续看下一张，而不是直接放弃。 */
  const tries = imgs
    .map((im) => ({ ...im, area: (im.width || 0) * (im.height || 0) }))
    .sort((a, b) => b.area - a.area);

  const notes = [];
  for (const im of tries) {
    if (!im.width || !im.height) { notes.push("图片缺宽高"); continue; }
    if (im.area > MAX_PIXELS) { notes.push(`${im.width}×${im.height} 超过上限`); continue; }
    const raw = buf.subarray(im.start, im.end);

    /* ① DCTDecode：流就是 JPEG，直接可用 */
    if (/DCTDecode/.test(im.filter)) {
      if (raw.length < 4 || raw[0] !== 0xff || raw[1] !== 0xd8) { notes.push("JPEG 流头不对"); continue; }
      if (raw.length > MAX_BYTES) { notes.push(`JPEG ${Math.round(raw.length / 1048576)}MB 过大`); continue; }
      return { ok: true, mime: "image/jpeg", data: raw, width: im.width, height: im.height, note: "" };
    }

    /* ② FlateDecode + 8bit + Gray/RGB：解压后重封 PNG */
    if (/FlateDecode/.test(im.filter)) {
      const channels = im.cs === "DeviceGray" ? 1 : (im.cs === "DeviceRGB" ? 3 : 0);
      if (!channels) { notes.push(`色彩空间 ${im.cs || "未知"} 暂不支持`); continue; }
      if (im.bpc !== 8) { notes.push(`${im.bpc}bit 采样暂不支持`); continue; }
      let data;
      try { data = zlib.inflateSync(raw); } catch { notes.push("解压失败"); continue; }
      const bpp = channels;
      let pixels = data;
      if (im.predictor === 2) pixels = undoTiffPredictor(data, im.width, im.height, bpp);
      else if (im.predictor >= 10) pixels = undoPngPredictor(data, im.width, im.height, bpp);
      if (!pixels) { notes.push("预测器还原失败"); continue; }
      const need = im.width * im.height * bpp;
      if (pixels.length < need) { notes.push("像素数据不完整"); continue; }
      const png = pngFromRaw(pixels.subarray(0, need), im.width, im.height, channels);
      if (png.length > MAX_BYTES) { notes.push(`PNG ${Math.round(png.length / 1048576)}MB 过大`); continue; }
      return { ok: true, mime: "image/png", data: png, width: im.width, height: im.height, note: "" };
    }

    const f = im.filter.replace(/[[\]\/]/g, "") || "未知编码";
    notes.push(`${f} 需要 OCR`);
  }
  return { ok: false, note: "取不出可用的页面图（" + (notes.slice(0, 2).join("；") || "未知原因") + "）" };
}

/** 读文件 → 抽出首页图 → 转 data URL。返回结构可直接喂给视觉模型。 */
async function toDataUrl(filePath) {
  let st;
  try { st = await fs.stat(filePath); } catch { return { ok: false, note: "文件读不到（可能已被删除或无权限）" }; }
  if (!st.isFile()) return { ok: false, note: "不是一个文件" };

  let buf;
  try {
    if (st.size <= MAX_READ) {
      buf = await fs.readFile(filePath);
    } else {
      /* 超大文件只读头部：图片对象在 xref 之前，页数极多时才可能落到后面。
         读不到就给明确原因，不要静默返回空图。 */
      const fh = await fs.open(filePath, "r");
      try {
        buf = Buffer.alloc(MAX_READ);
        await fh.read(buf, 0, MAX_READ, 0);
      } finally { await fh.close(); }
    }
  } catch (e) {
    return { ok: false, note: `读取失败：${e.message}` };
  }

  const r = extractFirstImage(buf);
  if (!r.ok) return { ok: false, note: r.note };
  return {
    ok: true,
    dataUrl: `data:${r.mime};base64,${r.data.toString("base64")}`,
    width: r.width,
    height: r.height,
    bytes: r.data.length,
    mime: r.mime,
    note: "",
  };
}

module.exports = { toDataUrl, extractFirstImage, pngFromRaw, undoPngPredictor, undoTiffPredictor };
