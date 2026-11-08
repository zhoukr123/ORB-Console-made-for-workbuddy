/* pdf-page.js 单测：扫描件首页取图。
 *
 * 重点不是"能跑"，而是三条容易悄悄错掉的判定：
 *   ① DCTDecode 必须**逐字节**透传（重新编码一次就是二次压缩，字会糊）；
 *   ② PNG 预测器还原必须正确（错了图还在，只是花屏 —— 最难发现的一种错）；
 *   ③ 解不了的编码必须**如实报错**，不能返回一张空白图让视觉模型去猜。
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

/* 用 fileURLToPath 而不是手工切 pathname：仓库路径含中文，
   手工切的版本会带 %E4%B8%AD 这种百分号编码，fs 一律 ENOENT。 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pdfPage = require(path.resolve(HERE, "..", "desktop", "pdf-page.js"));

function pdfOf(objs) {
  // 解析器靠字典特征扫对象，不读 xref —— 这里只拼出结构上像样的对象即可
  let body = "%PDF-1.4\n";
  objs.forEach((o, i) => { body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  return Buffer.from(body + "trailer\n<</Root 1 0 R>>\n%%EOF\n", "latin1");
}

function imgObj(dict, data) {
  return `<</Type/XObject/Subtype/Image/${dict}/Length ${data.length}>>\nstream\n${data.toString("latin1")}\nendstream`;
}

function ihdr(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG 魔数不对");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
  };
}

test("pdf-page：DCTDecode 的 JPEG 原样透传，不重新编码", () => {
  // 任意一段"以 SOI 开头、以 EOI 结尾"的字节，模拟嵌入的 JPEG
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
  const pdf = pdfOf([imgObj("Width 800/Height 600/ColorSpace/DeviceRGB/Filter/DCTDecode", jpeg)]);
  const r = pdfPage.extractFirstImage(pdf);
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/jpeg");
  assert.equal(r.width, 800);
  assert.equal(r.height, 600);
  assert.ok(r.data.equals(jpeg), "字节被改写了 —— 说明中间又编了一次码");
});

test("pdf-page：FlateDecode 灰度图解出来是合法 PNG", () => {
  const raw = Buffer.from([0, 64, 128, 255]);          // 2×2 DeviceGray
  const data = zlib.deflateSync(raw);
  const pdf = pdfOf([imgObj("Width 2/Height 2/ColorSpace/DeviceGray/BitsPerComponent 8/Filter/FlateDecode", data)]);
  const r = pdfPage.extractFirstImage(pdf);
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/png");
  const h = ihdr(r.data);
  assert.equal(h.width, 2);
  assert.equal(h.height, 2);
  assert.equal(h.colorType, 0, "灰度图应该是 colorType 0");
  assert.equal(h.bitDepth, 8);
});

test("pdf-page：FlateDecode 的 RGB 图 colorType 是 2", () => {
  const raw = Buffer.alloc(4 * 3 * 3, 200);             // 4×3 RGB
  const pdf = pdfOf([imgObj("Width 4/Height 3/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/FlateDecode", zlib.deflateSync(raw))]);
  const r = pdfPage.extractFirstImage(pdf);
  assert.equal(r.ok, true);
  assert.equal(ihdr(r.data).colorType, 2);
});

test("pdf-page：PNG 预测器（15）逐行还原正确", () => {
  /* 4×2 灰度，手工按 filter=2(Up) 编码：
     第 1 行 = 原值（prev 全 0），第 2 行 = 原值 - 上一行。 */
  const w = 4, h = 2, bpp = 1;
  const top = Buffer.from([10, 20, 30, 40]);
  const bottom = Buffer.from([11, 22, 33, 44]);
  const enc = Buffer.alloc((w * bpp + 1) * h);
  enc[0] = 2; top.copy(enc, 1);
  enc[w * bpp + 1] = 2;
  for (let i = 0; i < w * bpp; i++) enc[w * bpp + 2 + i] = (bottom[i] - top[i]) & 0xff;
  const out = pdfPage.undoPngPredictor(enc, w, h, bpp);
  assert.ok(out);
  assert.deepEqual([...out], [...top, ...bottom]);
});

test("pdf-page：TIFF 预测器（2）横向差分还原正确", () => {
  const raw = Buffer.from([10, 15, 20]);   // 递增差分 → 原值 10, 10, 10
  const out = pdfPage.undoTiffPredictor(raw, 3, 1, 1);
  assert.deepEqual([...out], [10, 25, 45]);
});

test("pdf-page：JBIG2 解不了就如实说，不返回空白图", () => {
  const pdf = pdfOf([imgObj("Width 2480/Height 3508/ColorSpace/DeviceGray/Filter/JBIG2Decode", Buffer.from([0, 1, 2, 3]))]);
  const r = pdfPage.extractFirstImage(pdf);
  assert.equal(r.ok, false);
  assert.match(r.note, /OCR|JBIG2/);
});

test("pdf-page：没有图片对象时说清楚，而不是给个空串", () => {
  const r = pdfPage.extractFirstImage(pdfOf([]));
  assert.equal(r.ok, false);
  assert.match(r.note, /没有图片/);
});

test("pdf-page：多图时优先取面积最大的那张（正文，不是 logo）", () => {
  const small = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const big = Buffer.from([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
  const pdf = pdfOf([
    imgObj("Width 40/Height 40/ColorSpace/DeviceRGB/Filter/DCTDecode", small),
    imgObj("Width 2480/Height 3508/ColorSpace/DeviceRGB/Filter/DCTDecode", big),
  ]);
  const r = pdfPage.extractFirstImage(pdf);
  assert.equal(r.ok, true);
  assert.equal(r.width, 2480);
  assert.ok(r.data.equals(big));
});

test("pdf-page：文件不存在时回 ok:false + 原因", async () => {
  const r = await pdfPage.toDataUrl(path.join(os.tmpdir(), "orb-nope-" + Date.now() + ".pdf"));
  assert.equal(r.ok, false);
  assert.match(r.note, /读不到/);
});

test("pdf-page：toDataUrl 产出的 data URL 能被 base64 解回原字节", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0x03, 0xff, 0xd9]);
  const f = path.join(os.tmpdir(), "orb-pdfpage-" + process.pid + ".pdf");
  fs.writeFileSync(f, pdfOf([imgObj("Width 10/Height 10/ColorSpace/DeviceRGB/Filter/DCTDecode", jpeg)]));
  try {
    const r = await pdfPage.toDataUrl(f);
    assert.equal(r.ok, true);
    assert.ok(r.dataUrl.startsWith("data:image/jpeg;base64,"));
    const back = Buffer.from(r.dataUrl.split(",")[1], "base64");
    assert.ok(back.equals(jpeg));
  } finally {
    fs.unlinkSync(f);
  }
});
