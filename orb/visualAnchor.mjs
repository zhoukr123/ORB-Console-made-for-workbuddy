/* 视觉锚定后端（方案 C 的 C0 / C1 两档）
 * ──────────────────────────────────────────────────────────────────
 * C0 模板匹配：纯 JS 归一化互相关（与 OpenCV TM_CCOEFF_NORMED 同款算法）。
 *   零原生依赖（只依赖 pngjs 解码），Windows 必能跑；像素级稳定 UI 近乎完美。
 * C1 CLIP 视觉 embedding：@huggingface/transformers 加载 Xenova/clip-vit-base-patch32
 *   （即 ViT-B/32），懒加载 + 失败优雅降级（HF 不通 / 未装 → 自动退回 C0）。
 *   语义级，能应对"改版 / 无文字控件 / 图标"这类模板匹配会失手的情况。
 *
 * 设计约束：
 *   · 模块不 import bridge；所有副作用（截图、模型加载）通过工厂注入，便于单测。
 *   · 两档是级联的：C0 命中即返回；C0 失败才上 C1（C1 贵，只在必要时唤醒）。
 *   · 搜索范围默认以"录制坐标"为中心、searchPad 为半径的小窗口——元素不会瞬移很远，
 *     这样既快又把纯 JS NCC 的计算量压在可控范围。
 */
import { PNG } from "pngjs";
import { primaryPoint, ANCHORABLE } from "./anchorResolver.mjs";

/* ============================ 纯函数 ============================ */

/** 余弦相似度。长度不等或空 → 0。 */
export function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** 解码 PNG buffer → { width, height, data:Uint8Array(RGBA) } */
export function decodePng(buf) {
  const png = PNG.sync.read(buf);
  return { width: png.width, height: png.height, data: png.data };
}

function rgbaToRgb(data) {
  const out = new Uint8Array((data.length / 4) * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    out[j] = data[i]; out[j + 1] = data[i + 1]; out[j + 2] = data[i + 2];
  }
  return out;
}

function encodeRgbPng(rgb, w, h) {
  const png = new PNG({ width: w, height: h });
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    png.data[j] = rgb[i]; png.data[j + 1] = rgb[i + 1]; png.data[j + 2] = rgb[i + 2]; png.data[j + 3] = 255;
  }
  return PNG.sync.write(png);
}

function extractRgba(img, x, y, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    const sRow = (y + j) * img.width + x;
    const dRow = j * w;
    for (let i = 0; i < w; i++) {
      const s = (sRow + i) * 4, d = (dRow + i) * 4;
      out[d] = img.data[s]; out[d + 1] = img.data[s + 1]; out[d + 2] = img.data[s + 2]; out[d + 3] = img.data[s + 3];
    }
  }
  return out;
}

function toGray(img) {
  const { width, height, data } = img;
  const g = new Float32Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    g[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return g;
}

function downscaleGray(gray, w, h, scale) {
  const nw = Math.max(1, Math.round(w * scale));
  const nh = Math.max(1, Math.round(h * scale));
  const out = new Float32Array(nw * nh);
  const fx = w / nw, fy = h / nh;
  // 盒式平均（而非最近邻）：精确同源裁剪块经同样滤波后仍高度一致，NCC 更接近 1，
  // 也避免高频纹理（棋盘/文字）走样导致的误判。
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * fy)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * fx)));
      let sum = 0, cnt = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx < x1; xx++) { sum += gray[row + xx]; cnt++; }
      }
      out[y * nw + x] = sum / cnt;
    }
  }
  return { data: out, w: nw, h: nh };
}

/** TM_CCOEFF_NORMED 等价：在 search 的 [x0..x1]×[y0..y1] 子区域滑窗找最佳位置。 */
function nccRegion(sData, sw, sh, cData, cw, ch, x0, y0, x1, y1) {
  if (cw > sw || ch > sh) return null;
  let cMean = 0;
  for (let i = 0; i < cData.length; i++) cMean += cData[i];
  cMean /= cData.length;
  let cVar = 0;
  for (let i = 0; i < cData.length; i++) { const d = cData[i] - cMean; cVar += d * d; }
  if (cVar === 0) return null;
  const lo = (v, a, b) => Math.max(a, Math.min(b, v));
  const xa = lo(Math.round(x0), 0, sw - cw);
  const ya = lo(Math.round(y0), 0, sh - ch);
  const xb = lo(Math.round(x1), 0, sw - cw);
  const yb = lo(Math.round(y1), 0, sh - ch);
  let best = -Infinity, bx = 0, by = 0;
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      let sMean = 0;
      for (let j = 0; j < ch; j++) {
        const row = (y + j) * sw + x;
        for (let i = 0; i < cw; i++) sMean += sData[row + i];
      }
      sMean /= (cw * ch);
      let num = 0, sVar = 0;
      for (let j = 0; j < ch; j++) {
        const row = (y + j) * sw + x;
        for (let i = 0; i < cw; i++) {
          const sd = sData[row + i] - sMean;
          const cd = cData[j * cw + i] - cMean;
          num += sd * cd;
          sVar += sd * sd;
        }
      }
      if (sVar === 0) continue;
      const score = num / Math.sqrt(sVar * cVar);
      if (score > best) { best = score; bx = x; by = y; }
    }
  }
  return best === -Infinity ? null : { x: bx, y: by, score: best };
}

/**
 * C0 模板匹配。searchBuf / cropBuf 为 PNG。
 * 两段式：① 下采样到 maxDim 做全局粗搜（快）→ ② 在原图邻域用原始像素精修（准）。
 * 精修让"精确同源块"的 NCC 接近 1.0，阈值才能提到 0.85+ 减少误命中。
 * 返回 {x,y,score}（crop 中心在 search 坐标系）或 null（含低于阈值，带 belowThreshold）。
 */
export function templateMatch(searchBuf, cropBuf, { maxDim = 160, threshold = 0.75 } = {}) {
  try {
    const s = decodePng(searchBuf);
    const c = decodePng(cropBuf);
    if (!s || !c) return null;
    const sw = s.width, sh = s.height, cw = c.width, ch = c.height;
    if (cw > sw || ch > sh) return null;
    const sG = toGray(s), cG = toGray(c);
    // 用 search 的缩放比同时缩放 crop，保证两者尺度一致
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    let bx, by, score;
    if (scale < 1) {
      const sD = downscaleGray(sG, sw, sh, scale);
      const cD = downscaleGray(cG, cw, ch, scale);
      const rc = nccRegion(sD.data, sD.w, sD.h, cD.data, cD.w, cD.h, 0, 0, sD.w - cD.w, sD.h - cD.h);
      if (!rc) return null;
      const gx = Math.round(rc.x / scale), gy = Math.round(rc.y / scale);
      // 精修邻域：粗搜误差约 ±1 个下采样格
      const pad = Math.max(2, Math.ceil(1 / scale) + 1);
      const rf = nccRegion(sG, sw, sh, cG, cw, ch, gx - pad, gy - pad, gx + pad, gy + pad);
      if (rf && rf.score >= rc.score) { bx = rf.x; by = rf.y; score = rf.score; }
      else { bx = gx; by = gy; score = rc.score; }
    } else {
      const rf = nccRegion(sG, sw, sh, cG, cw, ch, 0, 0, sw - cw, sh - ch);
      if (!rf) return null;
      bx = rf.x; by = rf.y; score = rf.score;
    }
    const cx = bx + Math.round(cw / 2);
    const cy = by + Math.round(ch / 2);
    if (score < threshold) return { x: cx, y: cy, score, belowThreshold: true };
    return { x: cx, y: cy, score };
  } catch {
    return null;
  }
}

/* ============================ CLIP 视觉 embedding（C1） ============================ */

/**
 * 懒加载的 CLIP 匹配器。模型首次使用时才下载/初始化；任何失败都标记 failed，
 * 之后 match 直接返回 null（调用方退回 C0），不抛不卡。
 */
export function createClipMatcher(modelName = "Xenova/clip-vit-base-patch32") {
  let extractor = null;
  let failed = false;
  let loading = null;

  async function getExtractor() {
    if (extractor) return extractor;
    if (failed) return null;
    if (loading) return loading;
    loading = (async () => {
      try {
        const { pipeline } = await import("@huggingface/transformers");
        const ex = await pipeline("image-feature-extraction", modelName);
        extractor = ex;
        return ex;
      } catch (e) {
        failed = true;
        console.log("[clip] 模型加载失败，视觉档 C1 不可用（退回 C0）：", e?.message ?? e);
        return null;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  /**
   * 在 search 内按网格取候选（crop 尺寸），批量编码后比余弦。
   * 候选数超过 maxCandidates 时优先保留靠近中心的（元素通常不会跑太远）。
   */
  async function match(searchBuf, cropBuf, { gridStep = null, maxCandidates = 12, threshold = 0.24 } = {}) {
    const ex = await getExtractor();
    if (!ex) return null;
    try {
      const s = decodePng(searchBuf);
      const c = decodePng(cropBuf);
      if (!s || !c) return null;
      const cropPng = encodeRgbPng(rgbaToRgb(c.data), c.width, c.height);

      const stepX = gridStep || Math.max(8, Math.round(c.width * 0.5));
      const stepY = gridStep || Math.max(8, Math.round(c.height * 0.5));
      const positions = [];
      for (let y = 0; y + c.height <= s.height; y += stepY) {
        for (let x = 0; x + c.width <= s.width; x += stepX) positions.push([x, y]);
      }
      if (positions.length > maxCandidates) {
        const cx = s.width / 2, cy = s.height / 2;
        positions.sort((a, b) =>
          (Math.hypot(a[0] - cx, a[1] - cy)) - (Math.hypot(b[0] - cx, b[1] - cy)));
        positions.length = maxCandidates;
      }
      if (positions.length === 0) return null;

      const imgs = [cropPng, ...positions.map(([x, y]) =>
        encodeRgbPng(rgbaToRgb(extractRgba(s, x, y, c.width, c.height)), c.width, c.height))];
      const out = await ex(imgs, { pooling: "mean", normalize: true });
      const dim = out.dims[out.dims.length - 1];
      const cropEmb = Array.from(out.data.slice(0, dim));
      let best = null;
      for (let i = 0; i < positions.length; i++) {
        const emb = Array.from(out.data.slice((i + 1) * dim, (i + 2) * dim));
        const sc = cosineSim(cropEmb, emb);
        if (!best || sc > best.score) best = { x: positions[i][0] + c.width / 2, y: positions[i][1] + c.height / 2, score: sc };
      }
      if (!best || best.score < threshold) return null;
      return best;
    } catch (e) {
      console.log("[clip] 匹配失败：", e?.message ?? e);
      return null;
    }
  }

  return { match, getExtractor, isAvailable: () => !!extractor && !failed };
}

/* ============================ 组装：录制 / 回放 ============================ */

/**
 * 录制期：抓一小块"被点元素"的图（以录制坐标为中心、half 为半径），
 * 存成 base64 进 step.visualCrop。回放时 C0/C1 都复用它。失败不影响录制。
 */
export async function captureVisualCrop(step, screenshotRegion, { half = 40 } = {}) {
  try {
    if (!step || !ANCHORABLE.has(`${step.server}|${step.tool}`)) return;
    const pp = primaryPoint(step);
    if (!pp || !screenshotRegion) return;
    const x = Math.max(0, pp[0] - half), y = Math.max(0, pp[1] - half);
    const buf = await screenshotRegion(x, y, half * 2, half * 2);
    if (buf) step.visualCrop = buf.toString("base64");
  } catch { /* 不影响录制 */ }
}

/**
 * 回放期视觉锚定器。screenshotRegion(x,y,w,h) 由 bridge 注入（w=h=0 表示全屏由实现决定）。
 * 返回 {x,y,ref} 或 null（两级都失败 → 交给上层 window/absolute 兜底）。
 */
export function createVisualAnchor({
  screenshotRegion,
  clip = null,
  clipModel = "Xenova/clip-vit-base-patch32",
  searchPad = 320,
  templateThr = 0.78,
  clipThr = 0.24,
  maxCandidates = 12,
} = {}) {
  const clipMatcher = clip || createClipMatcher(clipModel);

  return async function anchorByVisual(step) {
    const b64 = step && step.visualCrop;
    if (!b64 || !screenshotRegion) return null;
    const cropBuf = Buffer.from(b64, "base64");

    // 搜索中心：录制坐标优先；没有坐标就不走视觉档（树/文字/窗口档更合适）
    const pp = (step.args && Array.isArray(step.args.loc)) ? step.args.loc
      : (step.args && step.args.x !== undefined) ? [step.args.x, step.args.y] : null;
    if (!pp) return null;

    const sx = Math.max(0, pp[0] - searchPad);
    const sy = Math.max(0, pp[1] - searchPad);
    const searchBuf = await screenshotRegion(sx, sy, searchPad * 2, searchPad * 2);
    if (!searchBuf) return null;

    // C0 模板匹配（快、确定性）
    const t0 = Date.now();
    const t = templateMatch(searchBuf, cropBuf, { threshold: templateThr });
    if (t && !t.belowThreshold) {
      console.log(`[visual] C0 模板命中 score=${t.score.toFixed(3)} (${Date.now() - t0}ms)`);
      return { x: sx + t.x, y: sy + t.y, ref: "visual:template" };
    }
    // C1 CLIP（贵，仅 C0 未命中时唤醒）
    const c0 = Date.now();
    const r = await clipMatcher.match(searchBuf, cropBuf, { maxCandidates, threshold: clipThr });
    if (r) {
      console.log(`[visual] C1 CLIP 命中 score=${r.score.toFixed(3)} (${Date.now() - c0}ms)`);
      return { x: sx + r.x, y: sy + r.y, ref: "visual:clip" };
    }
    return null;
  };
}
