/* ---------------- MP4 收尾（校验 + 补时长） ----------------
 * MediaRecorder 直出 MP4（video/mp4;codecs="avc1.42E01E"）已经是合法文件，
 * 只有一个例外：**中途停止**（用户提前按停、拖拽窗口、进程被打断）时，
 * 分片复用器往往来不及回填 moov/mvhd 里的 duration —— file-tolerant 是能播，
 * 但 Windows 资源管理器、PotPlayer、剪映这类按 mvhd 读时长的软件会显示 0 秒，
 * 进度条拖不动。这里做的就是在**缺失时**补上这一个字段。
 *
 * 原则：
 *   - 不改已有值。已有 duration 的一律原样放过，避免把对的值改错。
 *   - 只改 mvhd 的那 4/8 个字节。整个文件重排既慢又危险（录屏动辄几百 MB）。
 *   - 只读草案：所有解析按 offset 步进读，不把整个文件读进内存。
 */

const fs = require("node:fs");

/* 顶层 / moov 子层最多认多少个 box。
 * 长录制的分片 MP4 会有成千上万个 moof/mdat 对，全记下来既没意义又费内存；
 * 这里只为了诊断和找 moov，超了就截断并在返回值里标记 complete=false。 */
const MAX_TOP_BOXES = 512;
const MAX_CHILD_BOXES = 256;

/* mvhd 头部最多读这么多字节。注意这些偏移都是**相对 box 起始**（含 8 字节 box 头）：
 * payload = version(1)+flags(3) + creation + modification + timescale + duration
 *   v0: creation(4) modification(4)  → timescale 在 payload 偏移 12、box 偏移 20；duration 在 box 偏移 24
 *   v1: creation(8) modification(8)  → timescale 在 box 偏移 28；duration(8) 在 box 偏移 32
 * 所以 v1 要读到第 40 字节才够。 */
const MVHD_HEAD = 40;

/* mvhd.duration 的两个哨兵值：0xFFFFFFFF(v0) / 0xFFFFFFFFFFFFFFFF(v1)
   在规范里表示「时长未知」，等同于缺失，同样需要补。 */
const SENTINEL_V0 = 0xffffffff;
const SENTINEL_V1 = BigInt("0xFFFFFFFFFFFFFFFF");
const MAX_U32 = BigInt(0xffffffff);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function errText(e) {
  return (e && e.message) ? e.message : String(e);
}

/** 统一的「读一段字节」抽象：Buffer 和文件描述符各实现一份，后面所有解析共用一套逻辑。 */
function bufferReader(buf) {
  return (off, len) => {
    const start = Math.max(0, Math.min(off, buf.length));
    const end = Math.max(start, Math.min(off + len, buf.length));
    return buf.subarray(start, end);
  };
}

function fdReader(fd) {
  return (off, len) => {
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      let n = 0;
      try { n = fs.readSync(fd, buf, got, len - got, off + got); } catch { break; }
      if (n <= 0) break;
      got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
  };
}

/**
 * 按 ISO-BMFF 逐 box 走一遍。
 * 三种 size 形态都必须处理：
 *   size > 1      常规；size == 1  真正的长度在后面的 64 位 largesize；
 *   size == 0     这个 box 一直延伸到容器末尾（最后一个 box 的常见写法）。
 * @param {(off: number, len: number) => Buffer} read
 * @param {number} start
 * @param {number} end
 * @param {number} maxBoxes
 */
function walkBoxes(read, start, end, maxBoxes) {
  const boxes = [];
  let off = start;
  let complete = true;
  while (off + 8 <= end && boxes.length < maxBoxes) {
    const h = read(off, 16);
    if (h.length < 8) { complete = false; break; }
    let size = h.readUInt32BE(0);
    const type = h.toString("latin1", 4, 8);
    let headerSize = 8;
    if (size === 1) {
      if (h.length < 16) { complete = false; break; }
      const big = h.readBigUInt64BE(8);
      size = big > MAX_SAFE ? Number.MAX_SAFE_INTEGER : Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < headerSize) { complete = false; break; }   // 头部自相矛盾：后面没法信任了
    if (off + size > end) {
      boxes.push({ type, offset: off, size: end - off, headerSize, partial: true });
      complete = false;
      break;
    }
    boxes.push({ type, offset: off, size, headerSize });
    off += size;
  }
  if (off !== end) complete = false;
  return { boxes, complete };
}

/**
 * 在 moov 的直接子层里找 mvhd，并解出 timescale / duration 以及它们的**绝对偏移**。
 * 绝对偏移是关键：后面补写要靠它精确定位那几个字节。
 * @returns {object|null}
 */
function findMvhd(read, topBoxes) {
  const moov = topBoxes.find((b) => b.type === "moov");
  if (!moov) return null;
  const start = moov.offset + moov.headerSize;
  const end = moov.offset + moov.size;
  const { boxes } = walkBoxes(read, start, end, MAX_CHILD_BOXES);
  const mvhd = boxes.find((b) => b.type === "mvhd");
  if (!mvhd) return null;
  const head = read(mvhd.offset, Math.min(mvhd.size, MVHD_HEAD));
  if (head.length < 24) return null;
  // hdr = box 头长度（8 或 16），下面所有偏移都以「payload 相对 box 头」为准，
  // 最后再统一加上 hdr 得到绝对偏移 —— 这样读和写永远落在同一处。
  const hdr = mvhd.headerSize;
  const version = head.readUInt8(hdr);
  // payload = version(1)+flags(3) + creation + modification + timescale + duration
  //   v0: timescale 在 payload 偏移 12、duration 在 16
  //   v1: timescale 在 payload 偏移 20、duration(8) 在 24
  if (version === 1) {
    if (head.length < hdr + 32) return null;
    const timescale = head.readUInt32BE(hdr + 20);
    const raw = head.readBigUInt64BE(hdr + 24);
    return {
      offset: mvhd.offset,
      headerSize: hdr,
      version: 1,
      timescale,
      duration: Number(raw > MAX_SAFE ? MAX_SAFE : raw),
      rawDuration: raw,
      fieldOffset: mvhd.offset + hdr + 24,
      fieldSize: 8,
    };
  }
  const timescale = head.readUInt32BE(hdr + 12);
  const raw = BigInt(head.readUInt32BE(hdr + 16));
  return {
    offset: mvhd.offset,
    headerSize: hdr,
    version: 0,
    timescale,
    duration: Number(raw),
    rawDuration: raw,
    fieldOffset: mvhd.offset + hdr + 16,
    fieldSize: 4,
  };
}

/** 已知 timescale/duration 时换算毫秒；timescale 为 0 会除出 Infinity，必须挡掉。 */
function toMs(duration, timescale) {
  const ts = Number(timescale) || 0;
  const du = Number(duration) || 0;
  if (!ts || !du) return 0;
  return Math.round((du / ts) * 1000);
}

/**
 * 生成统一的返回结构（成功也要带上完整字段，调用方不必判空）。
 * @param {Array} boxes
 * @param {boolean} hasFtyp
 * @param {object|null} mvhd
 * @param {object} extra
 */
function summarize(boxes, hasFtyp, mvhd, extra) {
  const out = {
    ok: false,
    hasFtyp,
    complete: false,
    boxes,
    hasMoov: false,
    mvhdVersion: mvhd ? mvhd.version : null,
    timescale: mvhd ? mvhd.timescale : 0,
    durationMs: mvhd ? toMs(mvhd.duration, mvhd.timescale) : 0,
    mvhdDuration: mvhd ? mvhd.duration : 0,
    error: null,
  };
  Object.assign(out, extra || {});
  out.complete = !!extra?.complete;
  out.hasMoov = !!boxes.find((b) => b.type === "moov");
  // 「合法 MP4」的最低门槛：首 box 是 ftyp 且能找到 moov（没有 moov 的 MP4 无法 seek）
  out.ok = out.hasFtyp && out.hasMoov;
  // 调用方自带的明确错误优先（例如"入参不是字节数据"），不能被通用描述盖掉
  if (!out.error) {
    if (!out.hasFtyp) out.error = "缺少 ftyp（可能不是 MP4，或文件被截断）";
    else if (!out.hasMoov) out.error = "缺少 moov（未正常收尾）";
  }
  return out;
}

/**
 * 从内存中的字节里读 MP4 头部信息。
 * 渲染层拿到第一个分片就可以先探一把 —— 早点发现 mime 不对，总比录了十分钟才发现强。
 * @param {Buffer|ArrayBuffer|Uint8Array} buf
 * @returns {{ok: boolean, hasFtyp: boolean, hasMoov: boolean, complete: boolean,
 *            boxes: Array, mvhdVersion: number|null, timescale: number,
 *            durationMs: number, mvhdDuration: number, error: string|null}}
 */
function inspect(buf) {
  let b = buf;
  if (!Buffer.isBuffer(b)) {
    if (b instanceof ArrayBuffer) b = Buffer.from(new Uint8Array(b));
    else if (ArrayBuffer.isView(b)) b = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    else return summarize([], false, null, { error: "入参不是字节数据" });
  }
  if (b.length < 8) return summarize([], false, null, { error: "数据不足 8 字节" });
  const read = bufferReader(b);
  const { boxes, complete } = walkBoxes(read, 0, b.length, MAX_TOP_BOXES);
  const hasFtyp = boxes.length > 0 && boxes[0].type === "ftyp";
  let mvhd = null;
  try { mvhd = findMvhd(read, boxes); } catch (e) { /* moov 损坏：按“找不到”处理 */ }
  return summarize(boxes, hasFtyp, mvhd, { complete, size: b.length });
}

/**
 * 直接读文件分析（不把整个文件读进内存）。
 * @param {string} file
 * @returns {object} 与 inspect() 同构，额外带 size
 */
function inspectFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size < 8) {
      fs.closeSync(fd);
      return summarize([], false, null, { size, complete: false, error: "文件不足 8 字节" });
    }
    const read = fdReader(fd);
    const { boxes, complete } = walkBoxes(read, 0, size, MAX_TOP_BOXES);
    const hasFtyp = boxes.length > 0 && boxes[0].type === "ftyp";
    let mvhd = null;
    try { mvhd = findMvhd(read, boxes); } catch { /* 同上 */ }
    const out = summarize(boxes, hasFtyp, mvhd, { complete, size });
    return out;
  } catch (e) {
    return summarize([], false, null, { size: 0, complete: false, error: errText(e) });
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关不掉就算了 */ } }
  }
}

/**
 * 补齐 mvhd.duration。
 * **只在缺失（0 或哨兵值）时写**；已有有效值直接返回 patched:false。
 * 做法是打开同一个 fd，按偏移 writeSync 覆盖那 4/8 个字节 ——
 * 不重写文件、不动其它 box，几百 MB 的录屏也是常数耗时。
 * @param {string} file MP4 文件路径
 * @param {number} ms 实际录制时长（毫秒）
 * @returns {{ok: boolean, patched: boolean, file: string, version: number|null,
 *            timescale: number, durationMs: number, reason: string|null, error: string|null}}
 */
function patchDuration(file, ms) {
  const base = { ok: false, patched: false, file, version: null, timescale: 0, durationMs: 0, reason: null, error: null };
  if (typeof file !== "string" || !file) return { ...base, error: "文件路径为空" };
  const want = Number(ms);
  if (!isFinite(want) || want <= 0) return { ...base, error: "时长无效：" + String(ms) };

  let fd = null;
  try {
    fd = fs.openSync(file, "r+");
    const size = fs.fstatSync(fd).size;
    if (size < 8) { fs.closeSync(fd); fd = null; return { ...base, error: "文件不足 8 字节" }; }
    const read = fdReader(fd);
    const { boxes } = walkBoxes(read, 0, size, MAX_TOP_BOXES);
    const mvhd = findMvhd(read, boxes);
    if (!mvhd) { fs.closeSync(fd); fd = null; return { ...base, error: "未找到 mvhd，无法补写时长" }; }

    const missing = mvhd.rawDuration === 0n
      || mvhd.rawDuration === BigInt(SENTINEL_V0)
      || mvhd.rawDuration === SENTINEL_V1;
    if (!missing) {
      fs.closeSync(fd); fd = null;
      return { ...base, ok: true, patched: false, version: mvhd.version, timescale: mvhd.timescale,
        durationMs: toMs(mvhd.duration, mvhd.timescale), reason: "已有有效时长，未改动" };
    }
    if (!mvhd.timescale) { fs.closeSync(fd); fd = null; return { ...base, error: "timescale 为 0，无法换算时长" }; }

    // duration = 毫秒 × timescale / 1000，四舍五入到最近的刻度
    const raw = BigInt(Math.round((want * mvhd.timescale) / 1000));
    if (raw < 0n) { fs.closeSync(fd); fd = null; return { ...base, error: "时长为负数" }; }
    let payload;
    if (mvhd.fieldSize === 8) {
      payload = Buffer.alloc(8);
      payload.writeBigUInt64BE(raw > SENTINEL_V1 ? SENTINEL_V1 : raw, 0);
    } else {
      payload = Buffer.alloc(4);
      payload.writeUInt32BE(Number(raw > MAX_U32 ? MAX_U32 : raw), 0);
    }
    let written = 0;
    while (written < payload.length) {
      written += fs.writeSync(fd, payload, written, payload.length - written, mvhd.fieldOffset + written);
    }
    // 落盘：接下来会 rename / 交给播放器打开，缓冲没刷下去的话，极端情况能读到旧值
    try { fs.fsyncSync(fd); } catch { /* 某些挂载不支持 fsync，容忍 */ }
    fs.closeSync(fd); fd = null;

    const newRaw = mvhd.fieldSize === 8 ? Number(raw > SENTINEL_V1 ? SENTINEL_V1 : raw) : Number(raw > MAX_U32 ? MAX_U32 : raw);
    return { ok: true, patched: true, file, version: mvhd.version, timescale: mvhd.timescale,
      durationMs: toMs(newRaw, mvhd.timescale), reason: "已补写 mvhd.duration", error: null };
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    return { ...base, error: errText(e) };
  }
}

module.exports = {
  inspect,
  inspectFile,
  patchDuration,
};
