/* 打包技能包：手写 zip（stored 不压缩，文件都很小，压缩收益可忽略）。
   顺便解析自己写出的中央目录做结构自校验。
   运行：node docs/skill/_pack.js   零外部依赖 */
const fs = require("fs");
const path = require("path");

const SRC = "D:/workbuddy_ORB控制台/docs/skill/orb-bridge";
const OUT = "D:/workbuddy_ORB控制台/docs/skill/orb-bridge.zip";

/* ---------- CRC32 ---------- */
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

/* ---------- 收集文件 ---------- */
function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = base ? base + "/" + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ full, rel });
  }
  return out;
}
const files = walk(SRC, "");

/* ---------- 写 zip ---------- */
const chunks = [];
const central = [];
let offset = 0;
const DOS_TIME = 0;                      // 1980-01-01 00:00，固定值，避免依赖时钟
const DOS_DATE = 0x0021;

for (const f of files) {
  const data = fs.readFileSync(f.full);
  const nameBuf = Buffer.from(f.rel, "utf8");
  const crc = crc32(data);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);               // version needed
  lh.writeUInt16LE(0x0800, 6);           // flags: UTF-8 名称
  lh.writeUInt16LE(0, 8);                // method: stored
  lh.writeUInt16LE(DOS_TIME, 10);
  lh.writeUInt16LE(DOS_DATE, 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);     // compressed size
  lh.writeUInt32LE(data.length, 22);     // uncompressed size
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);               // extra len

  chunks.push(lh, nameBuf, data);
  offset += lh.length + nameBuf.length + data.length;

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);               // version made by
  cd.writeUInt16LE(20, 6);               // version needed
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(DOS_TIME, 12);
  cd.writeUInt16LE(DOS_DATE, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);               // disk start
  cd.writeUInt16LE(0, 36);               // internal attrs
  cd.writeUInt32LE(0, 38);               // external attrs
  cd.writeUInt32LE(offset - (30 + nameBuf.length + data.length), 42); // rel offset
  central.push(Buffer.concat([cd, nameBuf]));
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

fs.writeFileSync(OUT, Buffer.concat([...chunks, cdBuf, eocd]));

/* ---------- 自校验：重新解析中央目录 ---------- */
const buf = fs.readFileSync(OUT);
let eocdAt = -1;
for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
  if (buf.readUInt32LE(i) === 0x06054b50) { eocdAt = i; break; }
}
if (eocdAt < 0) { console.error("FAIL: 找不到 EOCD"); process.exit(1); }
const total = buf.readUInt16LE(eocdAt + 10);
let off = buf.readUInt32LE(eocdAt + 16);
const names = [];
for (let n = 0; n < total; n++) {
  if (buf.readUInt32LE(off) !== 0x02014b50) { console.error("FAIL: 中央目录签名异常 @", off); process.exit(1); }
  const nameLen = buf.readUInt16LE(off + 28);
  const extraLen = buf.readUInt16LE(off + 30);
  const commentLen = buf.readUInt16LE(off + 32);
  names.push(buf.toString("utf8", off + 46, off + 46 + nameLen));
  off += 46 + nameLen + extraLen + commentLen;
}

console.log("zip:", OUT);
console.log("大小:", Math.round(buf.length / 1024), "KB ·", total, "项");
names.forEach((n) => console.log("   ", n));

const hasSkill = names.includes("SKILL.md");
const hasIcon = names.includes("assets/icon.png");
const hasApi = names.includes("references/api.md");
const stray = names.filter((n) => n.indexOf("/") > 0 && !/^(references|assets)\//.test(n));
console.log("");
console.log("SKILL.md 在根目录      :", hasSkill ? "PASS" : "FAIL");
console.log("assets/icon.png        :", hasIcon ? "PASS" : "FAIL");
console.log("references/api.md      :", hasApi ? "PASS" : "FAIL");
console.log("无多余顶层目录         :", stray.length === 0 ? "PASS" : "FAIL -> " + stray.join(", "));
if (!hasSkill || !hasIcon || !hasApi || stray.length) { console.error("\n结构不合格，别上传。"); process.exit(1); }
console.log("\n全部通过，可以上传。");
