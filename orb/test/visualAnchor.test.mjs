/* 视觉锚定后端单测（方案 C 的 C0/C1）。
 * 覆盖：
 *   · cosineSim 基本性质；
 *   · decodePng 往返；
 *   · C0 模板匹配：精确裁剪块能定位、无关块不过阈值（纯 JS NCC）；
 *   · captureVisualCrop 录制期存 crop；非锚定步不抓；
 *   · createVisualAnchor：C0 命中、C0 失败→C1（注入 stub）、两级都失败→null。
 * 全部不依赖真实屏幕 / CLIP 模型（clip 用 stub 注入）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  cosineSim, decodePng, templateMatch, captureVisualCrop, createVisualAnchor,
} from "../visualAnchor.mjs";

/* ---------- 合成图工具 ---------- */
function makeScreen(w, h, patch) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // 背景：有纹理的伪随机（保证 variance 不为 0）
      let r = (x * 7 + y * 13) % 180;
      let g = (x * 11 + y * 5) % 180;
      let b = (x * 3 + y * 17) % 180;
      if (patch && x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h) {
        // 目标块：8px 棋盘黑/白（强对比、独特纹理）
        const on = ((Math.floor((x - patch.x) / 8) + Math.floor((y - patch.y) / 8)) % 2) === 0;
        r = g = b = on ? 250 : 5;
      }
      png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
    }
  }
  return png;
}

function cropFrom(png, x, y, w, h) {  const out = new PNG({ width: w, height: h });
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const s = ((y + j) * png.width + (x + i)) * 4;
      const d = (j * w + i) * 4;
      out.data[d] = png.data[s]; out.data[d + 1] = png.data[s + 1];
      out.data[d + 2] = png.data[s + 2]; out.data[d + 3] = 255;
    }
  }
  return out;
}

const toBuf = (png) => PNG.sync.write(png);

/* 纯色块：方差为 0 → NCC 恒失败，用来确定性地制造"C0 未命中"。 */
function solidCrop(w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    png.data[p] = 128; png.data[p + 1] = 128; png.data[p + 2] = 128; png.data[p + 3] = 255;
  }
  return toBuf(png);
}
const NOHIT_CROP = solidCrop(40, 40);

/* 300x200 屏，目标块 40x40 放在 (120,80) */
const SCREEN = makeScreen(300, 200, { x: 120, y: 80, w: 40, h: 40 });
const CROP = cropFrom(SCREEN, 120, 80, 40, 40);
const SCREEN_BUF = toBuf(SCREEN);
const CROP_BUF = toBuf(CROP);

/* ---------- 纯函数 ---------- */
test("cosineSim：相同为 1、正交为 0、长度不符为 0", () => {
  assert.ok(Math.abs(cosineSim([1, 0, 0], [1, 0, 0]) - 1) < 1e-9);
  assert.equal(cosineSim([1, 0], [0, 1]), 0);
  assert.equal(cosineSim([1, 2], [1, 2, 3]), 0);
});

test("decodePng：往返尺寸一致", () => {
  const d = decodePng(CROP_BUF);
  assert.equal(d.width, 40);
  assert.equal(d.height, 40);
  assert.equal(d.data.length, 40 * 40 * 4);
});

/* ---------- C0 模板匹配 ---------- */
test("templateMatch：精确裁剪块 → 定位到目标中心 (140,100)", () => {
  const r = templateMatch(SCREEN_BUF, CROP_BUF, { threshold: 0.8 });
  assert.ok(r && !r.belowThreshold, "应命中");
  assert.ok(Math.abs(r.x - 140) <= 2, `x≈140，实际 ${r.x}`);
  assert.ok(Math.abs(r.y - 100) <= 2, `y≈100，实际 ${r.y}`);
  assert.ok(r.score > 0.9, `score 应很高，实际 ${r.score}`);
});

test("templateMatch：无关块（随机噪声）→ 不达阈值", () => {
  // 真·无关：随机噪声，与周期背景/棋盘块都不相干
  const png = new PNG({ width: 40, height: 40 });
  for (let i = 0; i < 40 * 40; i++) {
    const p = i * 4;
    png.data[p] = (Math.random() * 255) | 0;
    png.data[p + 1] = (Math.random() * 255) | 0;
    png.data[p + 2] = (Math.random() * 255) | 0;
    png.data[p + 3] = 255;
  }
  const r = templateMatch(SCREEN_BUF, toBuf(png), { threshold: 0.85 });
  assert.ok(!r || r.belowThreshold || r.score < 0.85, `不应高置信命中，实际 ${r && r.score}`);
});

/* ---------- 录制期 crop ---------- */
test("captureVisualCrop：锚定步以录制点为中心抓 80x80 crop 存 base64", async () => {
  const step = { server: "windows", tool: "Click", args: { loc: [150, 100] } };
  const shot = async () => toBuf(makeScreen(80, 80));
  await captureVisualCrop(step, shot, { half: 40 });
  assert.ok(typeof step.visualCrop === "string" && step.visualCrop.length > 0);
  const d = decodePng(Buffer.from(step.visualCrop, "base64"));
  assert.equal(d.width, 80);
});

test("captureVisualCrop：非锚定步（键盘）不抓 crop", async () => {
  const step = { server: "windows", tool: "Keyboard", args: { text: "hi" } };
  await captureVisualCrop(step, async () => toBuf(makeScreen(80, 80)));
  assert.equal(step.visualCrop, undefined);
});

/* ---------- 回放期视觉锚定 ---------- */
test("createVisualAnchor：C0 命中即返回 visual:template，不唤醒 CLIP", async () => {
  let clipCalled = false;
  const clip = { match: async () => { clipCalled = true; return null; } };
  const av = createVisualAnchor({ screenshotRegion: async () => SCREEN_BUF, clip });
  const step = { server: "windows", tool: "Click", args: { loc: [140, 100] }, visualCrop: CROP_BUF.toString("base64") };
  const hit = await av(step);
  assert.ok(hit, "应命中");
  assert.equal(hit.ref, "visual:template");
  assert.ok(Math.abs(hit.x - 140) <= 2);
  assert.equal(clipCalled, false, "C0 命中不应调用 CLIP");
});

test("createVisualAnchor：C0 失败 → C1 stub 命中 visual:clip", async () => {
  const clip = { match: async () => ({ x: 50, y: 60, score: 0.9 }) };
  const av = createVisualAnchor({ screenshotRegion: async () => SCREEN_BUF, clip });
  const step = { server: "windows", tool: "Click", args: { loc: [140, 100] }, visualCrop: NOHIT_CROP.toString("base64") };
  const hit = await av(step);
  assert.ok(hit);
  assert.equal(hit.ref, "visual:clip");
  assert.equal(hit.x, 50);
  assert.equal(hit.y, 60);
});

test("createVisualAnchor：两级都失败 → null（交上层兜底）", async () => {
  const clip = { match: async () => null };
  const av = createVisualAnchor({ screenshotRegion: async () => SCREEN_BUF, clip });
  const step = { server: "windows", tool: "Click", args: { loc: [140, 100] }, visualCrop: NOHIT_CROP.toString("base64") };
  assert.equal(await av(step), null);
});

test("createVisualAnchor：无 visualCrop / 无坐标 → 直接 null（不截图）", async () => {
  let shot = 0;
  const av = createVisualAnchor({ screenshotRegion: async () => { shot++; return SCREEN_BUF; }, clip: { match: async () => null } });
  assert.equal(await av({ server: "windows", tool: "Click", args: { loc: [10, 10] } }), null);
  assert.equal(await av({ server: "windows", tool: "Click", args: {}, visualCrop: CROP_BUF.toString("base64") }), null);
  assert.equal(shot, 0, "缺 crop 或坐标时不应截图");
});
