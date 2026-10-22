/* ---------------- 桌面模糊背景（自合成） ----------------
 * 【为什么必须自己抓 —— 三个探针实测（2026-10-22），勿凭直觉改回"等等看"】
 *  ① 透明窗里 backdrop-filter 采不到桌面：桌面是 DWM 在页面渲染面之后才合成上去的，
 *     页面渲染面里窗后那片区域是透明的。探针 docs/_glass_rt_probe.js 实测：
 *     压在桌面文字上的 A 区高频能量 0.063、不带 blur 的 B 区 0.084（一样平），
 *     而同页内对照 C 区 3.466 —— blur 本身没坏，是它身后只有透明。
 *     用户看到"直接透出桌面文字"就是这么来的：DWM 把透明渲染面原样叠在桌上。
 *  ② 开 GPU 救不了：GLASS_PROBE_GPU=1 对照组数据一字不差。
 *  ③ 原生三条全死：SetWindowCompositionAttribute(acrylic) 在 Win11 build 26300 上
 *     返回成功但零效果；Electron backgroundMaterial:'acrylic' 把透明区渲染成不透
 *     白面（实测 253/253/253 平色）、'mica' 直接搞崩进程；DwmSetWindowAttribute
 *     (DWMWA_SYSTEMBACKDROP_TYPE) v0–4 同样只有白面或无效（docs/_dwmsbt_probe.js）。
 * 所以剩下唯一一条路：藏窗 → desktopCapturer 截整屏 → 裁出窗口背后的矩形 →
 * 缩放到窗口大小 → PNG 交渲染层垫在卡片/纱底背后，由页面既有的 backdrop-filter
 * （页内模糊，可用）糊成磨砂面。t3/t4 的玻璃糊的是页内背景板/用户图片，本来就对，不抓。
 *
 * 刷新策略（核心约束：可见态每抓一次都要藏窗闪 ~430ms —— getSources 固定 ~370ms，
 * 与缩略图尺寸无关，是禁 GPU 软捕获路径的固有成本）：
 *   · 隐藏态：轮询兜底 15s + 隐藏事件即抓 + 开窗前申报首抓 —— 窗口不参与桌面合成，
 *     不用藏不用等，**零闪烁**。面板平时就是收起的，绝大多数抓取都走这条。
 *   · 可见态：只在移动/缩放停稳 250ms 后（不对齐会露馅）、切显示器、设置页手动
 *     「刷新背景」时抓 —— 每次闪一下，但都发生在用户主动操作的那一刻。
 *   · 可见态不轮询：模糊下的陈旧几乎看不出来，不值得为它每分钟闪一次。
 * 只有渲染层明确申报要（glass-bg-want）时才抓 —— 非玻璃态零开销零闪烁。
 */

const { desktopCapturer, screen } = require("electron");

/* 宿主上下文（由 main.js 注入，理由同 storage.js：避免 require 环）。 */
let ctx = { log: () => {} };
function init(next) {
  if (!next || typeof next !== "object") return;
  ctx.log = typeof next.log === "function" ? next.log : ctx.log;
}

function note(...args) {
  try { ctx.log("[glassbg]", ...args); } catch { /* 日志绝不能反咬调用方 */ }
}
function errText(e) {
  return (e && e.message) ? e.message : String(e);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---- 可调参数（都在这儿，别散）---- */
const HIDE_MS = 60;       // 藏窗后等合成器落实的时间（这就是闪烁窗口期，能短尽量短）
const DEBOUNCE_MS = 250;  // 移动/缩放停稳后再抓
const POLL_MS = 15000;    // 隐藏态轮询：桌面内容会变，趁着面板看不见抓紧补抓
const MAX_THUMB = 1920;   // 整屏缩略图**宽度**上限（高度等比压）。实测 getSources 固定
                          // ~370ms 与尺寸无关（禁 GPU 软捕获路径的固有成本），所以这一条
                          // 不为速度、只为省内存：模糊（≥8px）会掩盖分辨率损失。
/* 闪烁预算（重要，改刷新策略前先读）：
 *   getSources 实测固定 ~370ms（尺寸无关），所以「窗口可见时」每抓一次都要藏窗
 *   闪一下 ~430ms。对策是**尽量在窗口隐藏时抓** —— 隐藏态根本不用藏窗、不用等，
 *   零闪烁。于是策略切成：
 *     · 隐藏态：轮询兜底（POLL_MS）+ 隐藏事件即抓 + 开窗前的申报首抓 —— 全免费
 *     · 可见态：只在**移动/缩放停稳**（不对齐会露馅）、切显示器、手动刷新时抓
 *       —— 每次闪一下，但都是用户主动操作的那一刻
 *     · 可见态不轮询：模糊下的陈旧几乎看不出来，不值得为它每分钟闪一次
 */

const watched = new Map();   // win.id -> entry
let pollTimer = null;

function ensurePoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    for (const entry of watched.values()) {
      if (!entry.want) continue;
      const w = entry.win;
      if (!w || w.isDestroyed()) continue;
      /* 只补抓**隐藏态**：可见时每抓一次都要藏窗闪 ~430ms，不干。
         隐藏态抓取零成本（窗口本来就不参与桌面合成）。 */
      if (w.isVisible && w.isVisible()) continue;
      refresh(entry);
    }
  }, POLL_MS);
  if (typeof pollTimer.unref === "function") pollTimer.unref();
}
function maybeStopPoll() {
  if (pollTimer && watched.size === 0) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** 给一个窗口挂上背景抓取。channel = 主进程往该窗口渲染层发底图的通道名。 */
function watch(win, channel) {
  if (!win || (win.isDestroyed && win.isDestroyed())) return null;
  const id = win.id;
  const old = watched.get(id);
  if (old) {
    old.win = win;
    if (channel) old.channel = channel;
    return old;
  }
  const entry = { win, channel: channel || "glass:bg", want: false, busy: false, timer: null, lastShot: 0 };
  watched.set(id, entry);
  win.on("move", () => schedule(entry));
  win.on("resize", () => schedule(entry));
  win.on("restore", () => schedule(entry, 120));
  /* 隐藏即补抓（零闪烁），以及显示后不抓 —— 开窗时背景已是刚抓好的。
     注意没有 'show' 监听：可见态每抓一次都要藏窗闪 ~430ms，而隐藏态轮询
     已经保证了新鲜度，没必要在用户眼前闪。 */
  win.on("hide", () => schedule(entry, 60));
  win.on("closed", () => {
    if (entry.timer) clearTimeout(entry.timer);
    watched.delete(id);
    maybeStopPoll();
  });
  ensurePoll();
  return entry;
}

function schedule(entry, delay) {
  if (!entry.want) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    refresh(entry);
  }, delay || DEBOUNCE_MS);
}

/** 渲染层申报要不要模糊背景。关 → 立刻停止抓取（不再闪）；开 → 补抓一张。 */
function want(win, on) {
  const entry = watched.get(win && win.id);
  if (!entry) return;
  entry.want = !!on;
  if (!on) {
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    return;
  }
  refresh(entry);
}

/** 手动刷新（设置页按钮）。同样尊重 want —— 玻璃没开就没有可刷新的东西。 */
function refreshNow(win) {
  const entry = watched.get(win && win.id);
  if (entry) refresh(entry);
}

/** 显示器热插拔 / 分辨率 / DPI 变更：所有申报了的窗口全部重抓
    （缩放比变了，旧底图与桌面不再对齐）。 */
function refreshAllWanted() {
  for (const entry of watched.values()) {
    if (entry.want) refresh(entry);
  }
}

async function refresh(entry) {
  const win = entry.win;
  if (!win || win.isDestroyed()) return;
  if (entry.busy) return;                                  // 上一次还没抓完，不叠
  if (win.isMinimized && win.isMinimized()) return;
  /* 隐藏态不跳过：隐藏态抓取零闪烁，正是补抓的好时机（见文件头"闪烁预算"） */
  entry.busy = true;
  try {
    const shot = await captureBehind(win);
    if (shot && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(entry.channel, shot);
      entry.lastShot = Date.now();
    }
  } catch (e) {
    note("抓取失败:", errText(e));
  } finally {
    entry.busy = false;
  }
}

async function captureBehind(win) {
  const b = win.getBounds();
  if (!b || b.width < 8 || b.height < 8) return null;
  const disp = screen.getDisplayMatching(b);
  const sf = disp.scaleFactor || 1;
  /* 缩略图按宽度上限等比压（高度跟着缩，保持屏幕宽高比，否则裁剪矩形算不对） */
  const physW = Math.max(2, Math.round(disp.size.width * sf));
  const physH = Math.max(2, Math.round(disp.size.height * sf));
  const kThumb = Math.min(1, MAX_THUMB / physW);
  const tw = Math.max(2, Math.round(physW * kThumb));
  const th = Math.max(2, Math.round(physH * kThumb));
  const wasVisible = !!(win.isVisible && win.isVisible());
  const t0 = Date.now();
  let sources = null;
  if (wasVisible) {
    /* 藏窗：只动透明度，不碰焦点与层级（setOpacity 不激活窗口）。
       不藏的话整屏截图会把我们自己的半透明卡片一起拍进去 —— 下一次抓到的就是
       "模糊再模糊"的递归，拖动时还会拖影。 */
    win.setOpacity(0);
    try {
      await sleep(HIDE_MS);   // 等合成器把"窗口消失"落实，否则拍到的还有自己
      sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: tw, height: th },
      });
    } finally {
      try { win.setOpacity(1); } catch { /* 窗口可能刚好被销毁 */ }
    }
  } else {
    /* 窗口本来就不可见：不用藏、不用等，直接抓，零闪烁 */
    sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: tw, height: th },
    });
  }
  const costMs = Date.now() - t0;
  if (!sources || !sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  /* 窗口矩形（DIP）→ 缩略图像素。缩略图被 kThumb 等比压过，按比例换算。 */
  const kx = size.width / physW;
  const ky = size.height / physH;
  let x = Math.round((b.x - disp.bounds.x) * sf * kx);
  let y = Math.round((b.y - disp.bounds.y) * sf * ky);
  let w = Math.round(b.width * sf * kx);
  let h = Math.round(b.height * sf * ky);
  /* 跨屏 / 越界钳制：窗口横跨两个屏时只取能得到的那半，别让 crop 抛 */
  x = Math.max(0, Math.min(x, size.width - 2));
  y = Math.max(0, Math.min(y, size.height - 2));
  w = Math.max(2, Math.min(w, size.width - x));
  h = Math.max(2, Math.min(h, size.height - y));
  const cropped = img.crop({ x, y, width: w, height: h });
  const scaled = (w === b.width && h === b.height)
    ? cropped
    : cropped.resize({ width: b.width, height: b.height }, { quality: "good" });
  const png = scaled.toPNG();
  note(`抓取完成：屏 ${disp.size.width}x${disp.size.height}@${sf}（缩略图 ${tw}x${th}），窗 ${b.width}x${b.height}，${wasVisible ? "藏窗" : "隐藏态"} ${costMs}ms，PNG ${(png.length / 1024).toFixed(0)}KB`);
  return { w: b.width, h: b.height, png: png.toString("base64") };
}

function stopAll() {
  for (const entry of watched.values()) {
    if (entry.timer) clearTimeout(entry.timer);
  }
  watched.clear();
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = {
  init,
  watch,
  want,
  refreshNow,
  refreshAllWanted,
  stopAll,
};
