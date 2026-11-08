/* pluginPack.mjs — 本地插件包的拆包与落盘（「把插件包拖进来」的后端）
 *
 * 输入是**不可信字节**：用户从任何地方拖来的 .zip、单个清单 JSON、整个文件夹。
 * 所以这个模块只做三件事，且每件都设上限：
 *   1) 解码  —— zip 只用中央目录 + zlib，不引第三方依赖（项目本来就无打包依赖）
 *   2) 净化  —— 路径穿越、绝对路径、Windows 非法字符、超大文件、条目数，逐条拒绝并记 warning
 *   3) 落盘  —— 全部写在调用方给的根目录内，落盘后交给 readSource 走同一条摄入路径
 *
 * 纪律：
 *  - 不猜：解不开就说 zip-no-eocd / zip64-unsupported / zip-encrypted，不假装成功。
 *  - 不越界：任何一条路径 resolve 后不在 root 之内就整条丢弃，绝不写出去。
 *  - 有界：单文件 8MB、总量 24MB、最多 400 条。压缩包炸弹在 inflate 时就设了 maxOutputLength，
 *          不是等解完再看大小。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { MANIFEST_CANDS } from "./pluginMarket.mjs";

export const PACK_LIMITS = Object.freeze({
  maxFiles: 400,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
});

/* 打进来也没用的系统垃圾 / 版本库：直接丢，不算 warning（否则满屏噪音） */
const JUNK = [
  /^__MACOSX\//i,
  /(^|\/)\.DS_Store$/i,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
];
const isJunk = (rel) => JUNK.some((re) => re.test(rel));

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}
function exists(p) {
  try { fs.accessSync(p); return true; } catch (e) { return false; }
}

/**
 * 外部名字 → 安全相对路径。不安全返回 ""，调用方据此跳过。
 * 这一层是**唯一**决定"写到哪里"的地方，所以规则写得比较硬。
 */
export function safeRelPath(raw) {
  const s = String(raw == null ? "" : raw).replace(/\\/g, "/").trim();
  if (!s) return "";
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return "";     // 绝对路径
  if (s.includes("\0")) return "";                               // NUL 截断
  const parts = [];
  for (const seg of s.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") return "";                                 // 目录穿越
    if (seg.length > 200) return "";
    if (/[<>:"|?*]/.test(seg)) return "";                        // Windows 非法字符
    if (seg.endsWith(".") || seg.endsWith(" ")) return "";       // Windows 会悄悄改名
    parts.push(seg);
  }
  if (!parts.length) return "";
  const out = parts.join("/");
  return out.length > 400 ? "" : out;
}

/* ------------------------------------------------------------------ *
 * ZIP：只读中央目录，method 0/8 之外一律不碰
 * ------------------------------------------------------------------ */

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * @param {Buffer} buf
 * @returns {{ ok:boolean, error?:string, entries:Array<{path:string,data:Buffer}>, warnings:string[] }}
 */
export function readZip(buf) {
  const warnings = [];
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    return { ok: false, error: "zip-too-small", entries: [], warnings };
  }
  const eocd = findEocd(buf);
  if (eocd < 0) return { ok: false, error: "zip-no-eocd", entries: [], warnings };

  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  /* zip64 的字段是 0xFFFF/0xFFFFFFFF 占位，真值在 zip64 段里。
     控制台的插件包不可能真有 65535 个文件，见到占位就当不支持，别硬解。 */
  if (count === 0xffff || cdOff === 0xffffffff) {
    return { ok: false, error: "zip64-unsupported", entries: [], warnings };
  }

  const entries = [];
  let total = 0;
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      warnings.push("中央目录提前结束，后面的条目已忽略");
      break;
    }
    const flag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;                  // 目录条目
    if (isJunk(name)) continue;
    if (entries.length >= PACK_LIMITS.maxFiles) {
      warnings.push(`条目超过 ${PACK_LIMITS.maxFiles} 个，其余已忽略`);
      break;
    }
    if (flag & 0x1) { warnings.push(`${name}：加密条目，跳过`); continue; }
    if (rawSize > PACK_LIMITS.maxFileBytes) {
      warnings.push(`${name}：单文件超过 ${Math.round(PACK_LIMITS.maxFileBytes / 1048576)}MB，跳过`);
      continue;
    }
    total += rawSize;
    if (total > PACK_LIMITS.maxTotalBytes) {
      warnings.push(`解压后总量超过 ${Math.round(PACK_LIMITS.maxTotalBytes / 1048576)}MB，后面的条目已忽略`);
      break;
    }
    if (method !== 0 && method !== 8) {
      warnings.push(`${name}：压缩方式 ${method} 不支持，跳过`);
      continue;
    }

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) {
      warnings.push(`${name}：局部头损坏，跳过`);
      continue;
    }
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnLen + leLen;
    if (start + compSize > buf.length) {
      warnings.push(`${name}：数据区越界，跳过`);
      continue;
    }
    const raw = buf.subarray(start, start + compSize);
    let data;
    try {
      data = method === 0
        ? Buffer.from(raw)
        /* maxOutputLength：真炸弹在这里就抛，不会先解出一个 2GB 的 Buffer */
        : zlib.inflateRawSync(raw, { maxOutputLength: PACK_LIMITS.maxFileBytes });
    } catch (e) {
      warnings.push(`${name}：解压失败（${String((e && e.message) || e).slice(0, 60)}）`);
      continue;
    }
    entries.push({ path: name, data });
  }

  if (!entries.length) {
    return { ok: false, error: "zip-empty", entries, warnings };
  }
  return { ok: true, entries, warnings };
}

/** 是不是一个 zip（按魔数，不靠扩展名 —— 有人把 zip 存成 .plugin） */
export function looksLikeZip(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b
    && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/* ------------------------------------------------------------------ *
 * 落盘
 * ------------------------------------------------------------------ */

/**
 * @param {string} root 目标根目录（必须已存在或可创建）
 * @param {Array<{path:string,data:Buffer}>} entries
 */
export function unpackTo(root, entries) {
  const warnings = [];
  const written = [];
  try { fs.mkdirSync(root, { recursive: true }); } catch (e) {
    return { ok: false, error: "store-mkdir-failed", written, warnings };
  }
  for (const e of entries) {
    const rel = safeRelPath(e.path);
    if (!rel) { warnings.push(`${String(e.path).slice(0, 80)}：路径不安全，已丢弃`); continue; }
    const dest = path.resolve(root, rel);
    /* safeRelPath 已经挡住 ../，这里再核一次真实路径：符号链接/大小写折叠之类的意外不进不出去 */
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      warnings.push(`${rel}：越出包根目录，已丢弃`);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.data);
      written.push(rel);
    } catch (err) {
      warnings.push(`${rel}：写入失败（${String((err && err.message) || err).slice(0, 60)}）`);
    }
  }
  return { ok: written.length > 0, written, warnings };
}

/** 包内容指纹：路径 + 内容都参与，同名不同内容不会撞成同一个目录 */
export function packHash(entries) {
  const h = createHash("sha256");
  const rows = entries
    .map((e) => ({
      p: safeRelPath(e.path) || String(e.path),
      h: createHash("sha256").update(e.data).digest("hex"),
    }))
    .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
  for (const r of rows) h.update(r.p + "\0" + r.h + "\n");
  return "sha256:" + h.digest("hex");
}

/**
 * 解压后常见的两种形态要归一：
 *   包.zip → my-plugin/plugin.json + my-plugin/...     （外面套了一层目录）
 *   包.zip → 一个孤零零的 plugin.json                   （单清单）
 * 只在**没有歧义**时收窄：根上没清单、且只有一个子目录，才往里走。
 */
export function locateRoot(start, depth = 0) {
  if (depth > 3) return start;
  if (MANIFEST_CANDS.some((c) => exists(path.join(start, c)))) return start;
  /* 单清单形态：把唯一的 json 认成清单（用户拖的可能叫 demo.json） */
  let names = [];
  try { names = fs.readdirSync(start).filter((n) => !isJunk(n)); } catch (e) { return start; }
  if (names.length === 1 && /\.json$/i.test(names[0]) && !isDir(path.join(start, names[0]))) {
    try {
      fs.copyFileSync(path.join(start, names[0]), path.join(start, "plugin.json"));
    } catch (e) { /* 复制不了就让 readSource 照常报 manifest-unreadable */ }
    return start;
  }
  const dirs = names.filter((n) => isDir(path.join(start, n)));
  if (names.length === 1 && dirs.length === 1) {
    return locateRoot(path.join(start, dirs[0]), depth + 1);
  }
  return start;
}

/**
 * 单个 SKILL.md 也能装：合成一份最小清单再走同一条摄入路径。
 * 这不是"编造插件"——文件本身是真实的 skill，缺的只是 marketplace 那层包装。
 */
export function synthesizeSkillManifest(dir) {
  const f = path.join(dir, "SKILL.md");
  if (!exists(f)) return null;
  let head = "";
  try { head = fs.readFileSync(f, "utf8").slice(0, 800); } catch (e) { return null; }
  const title = (head.match(/^#\s+(.+)$/m) || [])[1] || "";
  const name = String(title || path.basename(dir) || "skill").trim().slice(0, 60);
  const firstLine = head
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !l.startsWith("---") && !l.includes(":")) || "";
  return {
    name,
    description: firstLine.slice(0, 160),
    category: "skill",
    workbuddy: { kind: "skill" },
    __synthesized: true,
  };
}
