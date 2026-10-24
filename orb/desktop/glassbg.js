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
 * 所以剩下唯一一条路：desktopCapturer 截整屏 → 裁出窗口背后的矩形 →
 * 缩放到窗口大小 → 交渲染层垫在卡片/纱底背后，由页面既有的 backdrop-filter
 * （页内模糊，可用）糊成磨砂面。t3/t4 的玻璃糊的是页内背景板/用户图片，本来就对，不抓。
 *
 * 【方案四（2026-10-23 落地）：用 setContentProtection 把「藏窗」这一步彻底删掉】
 * docs/_protect_probe.js 实测：Electron 44 / Win11 上 win.setContentProtection(true)
 * 是 WDA_EXCLUDEFROMCAPTURE 语义 —— 同一窗口区域，开启前截到纯红 (253,2,2)，
 * 开启后截到背后的桌面 (249,249,249)，即窗口**从截图里消失**，不是黑块。
 * 于是因果链变成：
 *   主进程给三个窗口调 setContentProtection → 抓图天然不含自身
 *   → 不必再 setOpacity(0) 藏窗 → 没有那 430ms 白闪 → 可见态也能放心刷新。
 * 一举解决三件事：① 旧路径藏窗期间的错位/黑边；② 刷新时的闪屏；③ 底图里
 * 出现自己导致的"模糊再模糊"递归与拖影。代价是三个窗口都无法被用户用系统
 * 截图工具/录屏软件拍到（对 ORB 这种"自己的窗口本来就不该进录像"的工具正是要点：
 * 录制时面板已隐藏，控制条与球也不该出现在录出来的画面里）。
 *
 * 刷新策略（现在抓取不闪了，所以能把"新鲜度"补回来）：
 *   · 隐藏态：轮询 15s + 隐藏事件即抓 + 开窗前申报首抓
 *   · 可见态：也参与轮询 15s + 每次 show 先抓一张（以前这两条都不敢做，因为要闪）
 *   · full 模式：拖动全程零重截（只发位移帧），停稳 600ms 后补一张最新桌面
 * 成本只剩 getSources 那 ~370ms 的 CPU（软捕获，与尺寸无关）；模糊下这点陈旧
 * 本来也看不出来，所以 15s 是"够用又不浪费"的档位。
 * 只有渲染层明确申报要（glass-bg-want）时才抓 —— 非玻璃态零开销零闪烁。
 */

const { desktopCapturer, screen } = require("electron");

/* 宿主上下文（由 main.js 注入，理由同 storage.js：避免 require 环）。 */
let ctx = {
  log: () => {},
  /* 抓桌面底图前后的「临时排除截图」钩子，由 main.js 注入（它负责 setContentProtection）。
     平时 ORB 自己的窗口可以被正常截图；只有抓底图的那一瞬间临时排除，
     否则底图里含自己，模糊之后是「模糊再模糊」的鬼影。详见 captureBehind。 */
  beforeShot: () => {},
  afterShot: () => {},
};
function init(next) {
  if (!next || typeof next !== "object") return;
  ctx.log = typeof next.log === "function" ? next.log : ctx.log;
  ctx.beforeShot = typeof next.beforeShot === "function" ? next.beforeShot : ctx.beforeShot;
  ctx.afterShot = typeof next.afterShot === "function" ? next.afterShot : ctx.afterShot;
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
/* 藏窗兜底开关（默认关）。因果链见文件头「方案四」：主进程给三个窗口都调了
   win.setContentProtection(true)，本机（Win11 + Electron 44）实测是
   WDA_EXCLUDEFROMCAPTURE 语义 —— 窗口**从截图里消失**（开启前截到纯红 253,2,2，
   开启后截到背后桌面 249,249,249，探针 docs/_protect_probe.js）。所以：
     setContentProtection → 抓图不含自身 → 无需藏窗 → 刷新不闪 → 可见态也能放心刷新。
   若将来换平台该方法失效（底图里出现自身 → 递归模糊），把下面这个常量改成 true
   即恢复「藏窗 60ms → 抓 → 恢复」的兜底路径，其余代码不用动。 */
const CAPTURE_HIDE_FALLBACK = false;
const CAPTURE_HIDE_MS = 60;   // 藏窗后等合成器落实的时间（只在兜底路径生效）
const DEBOUNCE_MS = 250;  // 移动/缩放停稳后再抓（crop 模式）
const SETTLE_REFRESH_MS = 600;  // full 模式：拖拽停稳这么久后补抓一张最新桌面
const POLL_MS = 15000;    // 轮询：桌面内容会变，抓着补（隐藏态/可见态都补，理由见 ensurePoll）
const POS_THROTTLE_MS = 16;  // full 模式位移流节流：一帧一次，别再密（IPC 高频路径）
const DRAG_IDLE_MS = 250;    // 位移静默这么久算一次拖拽结束（只用于打摘要日志）
const MAX_THUMB = 1920;   // 整屏缩略图**宽度**上限（高度等比压）。实测 getSources 固定
                          // ~370ms 与尺寸无关（禁 GPU 软捕获路径的固有成本），所以这一条
                          // 不为速度、只为省内存：模糊（≥8px）会掩盖分辨率损失。
/* 刷新策略（改之前先读文件头「方案四」）：
 *   不藏窗 ⇒ 每次抓取不再有 ~430ms 白闪 ⇒ 刷新变成"免费"的，于是策略可以收紧：
 *     · 隐藏态：轮询（POLL_MS）+ 隐藏事件即抓 + 开窗前申报首抓（照旧，本来就免费）
 *     · 可见态：也参与轮询 + 每次 show 先抓一张（以前这两条都不敢做，因为要闪）
 *     · full 模式：拖动全程仍零重截（跟手不变），停稳 SETTLE_REFRESH_MS 后补一张
 *   成本就剩 getSources 那 ~370ms 的 CPU（与尺寸无关），15s 一次、肉眼不可见。
 *   full 模式（面板/录制条）另一条不变：一张**整屏**底图对桌面静止时窗口的任意
 *   位置都成立 —— 拖动只发 16ms 节流的位移帧（{kind:"pos",x,y}），渲染层改
 *   background-position 平移即可。这才是原来「裁窗口块」方案 0.4s 滞后 + 拖完闪
 *   一下的病根：那个方案的底图只对抓取那一刻的窗口位置成立，只能停稳后重抓。
 *   换屏仍必须重抓（DPI 与屏内容都变了）。 */

const watched = new Map();   // win.id -> entry
let pollTimer = null;

function ensurePoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    for (const entry of watched.values()) {
      if (!entry.want) continue;
      const w = entry.win;
      if (!w || w.isDestroyed()) continue;
      /* 可见态也参与轮询：方案四之后抓取不再藏窗、不再闪，所以"可见时别抓"
         这条老限制可以撤掉了 —— 撤掉之后桌面换了壁纸/内容，底图 15s 内自愈。
         成本只剩 getSources 的 ~370ms CPU（软捕获，与尺寸无关），15s 一次、
         窗口上完全看不出来。若哪天在低端机上感到卡顿，把 POLL_MS 提到 20000 即可。 */
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

/**
 * 给一个窗口挂上背景抓取。channel = 主进程往该窗口渲染层发底图的通道名。
 * opts.mode：
 *   "full"（面板 + 录制条）—— 整屏 JPEG + 位移流：拖动只发 {kind:"pos",x,y}，不重截。
 *     底图对桌面静止时窗口的任意位置都成立，所以拖动可以零重截地跟手；
 *     只有换屏（DPI/内容变）、拖拽停稳、以及轮询补新鲜度时才真抓。
 *   "crop"（默认值，旧方案）—— 裁窗口块 PNG，移动/缩放停稳后重截。慢半拍且
 *     底图只对抓取那一刻的窗口位置成立，正是黑边/错位的病根；当前没有窗口用它，
 *     留着只为兼容（老版本渲染层 + 新主进程混跑时仍能出图）。
 */
function watch(win, channel, opts) {
  if (!win || (win.isDestroyed && win.isDestroyed())) return null;
  const id = win.id;
  const mode = (opts && opts.mode === "full") ? "full" : "crop";
  const old = watched.get(id);
  if (old) {
    old.win = win;
    if (channel) old.channel = channel;
    old.mode = mode;
    return old;
  }
  const entry = {
    win, channel: channel || "glass:bg", mode, want: false, busy: false, timer: null, lastShot: 0,
    /* full 模式位移流的状态：节流计时器、上次发帧时刻、上次所在屏、拖拽摘要计数 */
    posTimer: null, lastPosAt: 0, lastDisplayId: null, dragFrames: 0, dragIdleTimer: null,
    /* full 模式停稳补抓的计时器（拖完 SETTLE_REFRESH_MS 后补一张最新桌面） */
    settleTimer: null,
  };
  watched.set(id, entry);
  win.on("move", () => {
    /* full：只发位移帧（16ms 节流），绝不 schedule 补抓 —— 拖动结束时不再闪那一下。
       crop：维持停稳 250ms 后重截（裁出来的窗口块只对抓取时的位置成立）。 */
    if (entry.mode === "full") onMoveFull(entry);
    else schedule(entry);
  });
  win.on("resize", () => {
    /* 整屏底图与窗口尺寸无关，full 模式缩放不用重截（位移流照旧按 move 走） */
    if (entry.mode === "full") return;
    schedule(entry);
  });
  win.on("restore", () => {
    if (entry.mode === "full") return;   // 同 resize：位置靠 move 帧，内容靠轮询/停稳补抓
    schedule(entry, 120);
  });
  /* 隐藏即补抓（零闪烁），以及显示后也补抓一张 —— 方案四之后可见态抓取同样
     不闪（窗口已排除在截图之外），所以"开窗前先抓一张新的"变成免费的好事：
     用户每次打开面板看到的都是刚拍的桌面，而不是上一轮的旧图。 */
  win.on("hide", () => schedule(entry, 60));
  win.on("show", () => schedule(entry, 120));
  win.on("closed", () => {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.posTimer) clearTimeout(entry.posTimer);
    if (entry.dragIdleTimer) clearTimeout(entry.dragIdleTimer);
    if (entry.settleTimer) clearTimeout(entry.settleTimer);
    watched.delete(id);
    maybeStopPoll();
  });
  ensurePoll();
  return entry;
}

/**
 * full 模式的 move 处理：换屏重抓，其余只发节流的位移帧。
 * 换屏必须重抓 —— disp 的 bounds/size/scaleFactor 全变了，旧整屏图与新屏对不上，
 * 平移量再准也是错的。方案四之后换屏重抓也不再闪（窗口已排除在截图之外），
 * 所以这一下是完全无感的正确重抓时机。
 */
function onMoveFull(entry) {
  const win = entry.win;
  if (!win || (win.isDestroyed && win.isDestroyed())) return;
  if (!entry.want) return;
  let disp = null;
  try { disp = screen.getDisplayMatching(win.getBounds()); } catch { /* 拿不到屏就只发位移帧 */ }
  if (disp && entry.lastDisplayId != null && String(disp.id) !== String(entry.lastDisplayId)) {
    entry.lastDisplayId = disp.id;
    refresh(entry);
    return;
  }
  const now = Date.now();
  const wait = POS_THROTTLE_MS - (now - entry.lastPosAt);
  if (wait <= 0) {
    entry.lastPosAt = now;
    pushPos(entry);
  } else if (!entry.posTimer) {
    /* 尾随一帧：拖动停止时最后那一下位置也要发出去，否则底图停在倒数第二帧 */
    entry.posTimer = setTimeout(() => {
      entry.posTimer = null;
      entry.lastPosAt = Date.now();
      pushPos(entry);
    }, wait);
  }
}

/** 发一帧窗口 DIP 位置。载荷只许 {kind,x,y} 三个字段 —— IPC 高频路径禁带大对象。 */
function pushPos(entry) {
  const win = entry.win;
  if (!entry.want || !win || (win.isDestroyed && win.isDestroyed())) return;
  if (!win.webContents || win.webContents.isDestroyed()) return;
  let b = null;
  try { b = win.getBounds(); } catch { return; }
  try {
    win.webContents.send(entry.channel, { kind: "pos", x: b.x, y: b.y });
  } catch {
    /* 渲染层正在重载，丢一帧无妨 —— 下一次 move 会再发 */
    return;
  }
  entry.dragFrames += 1;
  /* 拖拽摘要：静默 DRAG_IDLE_MS 视为一次拖拽结束，打一条日志供 QA 从 orb.log 验
     「拖动只发了位移帧、没有重截」。 */
  if (entry.dragIdleTimer) clearTimeout(entry.dragIdleTimer);
  entry.dragIdleTimer = setTimeout(() => {
    entry.dragIdleTimer = null;
    if (entry.dragFrames > 0) {
      note(`拖动位移 ${entry.dragFrames} 帧（节流 ${POS_THROTTLE_MS}ms），未重截`);
      entry.dragFrames = 0;
    }
  }, DRAG_IDLE_MS);
  if (typeof entry.dragIdleTimer.unref === "function") entry.dragIdleTimer.unref();
  /* 停稳补抓：拖动过程仍然零重截（跟手度不变），停稳 SETTLE_REFRESH_MS 后补一张
     **最新**桌面。不藏窗了，这一下完全无感；换来的是"拖到新位置后底图与桌面重新
     严格一致"—— 拖动途中另有窗口在上面开合、壁纸换了这类变化也能自愈。 */
  if (entry.settleTimer) clearTimeout(entry.settleTimer);
  entry.settleTimer = setTimeout(() => {
    entry.settleTimer = null;
    if (entry.want) refresh(entry);
  }, SETTLE_REFRESH_MS);
  if (typeof entry.settleTimer.unref === "function") entry.settleTimer.unref();
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
    const shot = await captureBehind(win, entry.mode);
    if (shot && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send(entry.channel, shot);
      entry.lastShot = Date.now();
      /* 记住这次抓的屏：full 模式拖动时据此判断「有没有换屏」，换了才重抓 */
      try { entry.lastDisplayId = screen.getDisplayMatching(win.getBounds()).id; } catch { /* 窗口可能刚被销毁 */ }
    }
  } catch (e) {
    note("抓取失败:", errText(e));
  } finally {
    entry.busy = false;
  }
}

async function captureBehind(win, mode) {
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
  /* 方案四：窗口已通过 setContentProtection 排除在系统截图之外，所以**永远直接抓**。
     原来那条「先 setOpacity(0) 藏窗、等 60ms、抓完再恢复」的分支正是那 430ms 白闪
     的全部来源，现在一点也换不回来 —— 抓到的东西本来就一样（不含自身）。
     仅当 CAPTURE_HIDE_FALLBACK 打开（某平台 put 失效时的手动开关）才走藏窗。 */
  const hide = CAPTURE_HIDE_FALLBACK && wasVisible;
  if (hide) {
    try { win.setOpacity(0); } catch { /* 窗口可能刚好被销毁 */ }
    await sleep(CAPTURE_HIDE_MS);   // 等合成器把"窗口消失"落实，否则拍到的还有自己
  }
  let sources = null;
  /* 抓桌面底图这一瞬间，ORB 自己的窗口必须临时排除在截图之外 ——
     否则底图里含自己，模糊之后是"模糊再模糊"的鬼影。
     beforeShot/afterShot 由 main.js 注入（它负责 setContentProtection）。
     getSources 本身要跑 ~370ms，所以排除必须**跨越整个 await**，
     不能在 await 之前就恢复。 */
  try { if (ctx.beforeShot) ctx.beforeShot(); } catch { /* 排除失败也要继续抓 */ }
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: tw, height: th },
    });
  } finally {
    if (hide) {
      try { win.setOpacity(1); } catch { /* 窗口可能刚好被销毁 */ }
    }
    try { if (ctx.afterShot) ctx.afterShot(); } catch { /* 恢复失败不影响抓图结果 */ }
  }
  const costMs = Date.now() - t0;
  if (!sources || !sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  /* ---- full：整屏底图，不裁不缩 ----
     渲染层按 disp（DIP 尺寸）铺满整屏、再按窗口位移平移。整屏图对桌面静止时
     窗口的任意位置都成立，所以拖动只需位移帧；换屏 / 拖拽停稳 / 轮询补新鲜度才重抓。
     JPEG(80) 而非 PNG：整屏 1080p 的 PNG 动辄几 MB，每次抓取还要 base64 过 IPC，
     PNG 的压缩率在这里没有收益（模糊会把压块糊掉大半）。 */
  if (mode === "full") {
    const jpg = img.toJPEG(80);
    note(`整屏底图：屏 ${disp.size.width}x${disp.size.height}@${sf}（缩略图 ${tw}x${th}），${hide ? "藏窗兜底" : "直抓"} ${costMs}ms，JPEG ${(jpg.length / 1024).toFixed(0)}KB`);
    return {
      kind: "shot",
      mode: "full",
      img: jpg.toString("base64"),
      mime: "image/jpeg",
      /* disp：显示器 DIP 矩形 + 缩放比；at：抓取时的窗口 DIP 位置（先对齐一帧用） */
      disp: { x: disp.bounds.x, y: disp.bounds.y, w: disp.size.width, h: disp.size.height, sf },
      at: { x: b.x, y: b.y },
    };
  }
  /* ---- crop（兼容路径，当前没有窗口用它）：窗口矩形（DIP）→ 缩略图像素 ----
     缩略图被 kThumb 等比压过，按比例换算。 */
  const size = img.getSize();
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
  note(`抓取完成：屏 ${disp.size.width}x${disp.size.height}@${sf}（缩略图 ${tw}x${th}），窗 ${b.width}x${b.height}，${hide ? "藏窗兜底" : "直抓"} ${costMs}ms，PNG ${(png.length / 1024).toFixed(0)}KB`);
  return { kind: "shot", mode: "crop", w: b.width, h: b.height, png: png.toString("base64") };
}

function stopAll() {
  for (const entry of watched.values()) {
    if (entry.timer) clearTimeout(entry.timer);
    /* full 模式的三个计时器一起收掉：漏一个，退出时还会对着已销毁的窗口发一帧 */
    if (entry.posTimer) clearTimeout(entry.posTimer);
    if (entry.dragIdleTimer) clearTimeout(entry.dragIdleTimer);
    if (entry.settleTimer) clearTimeout(entry.settleTimer);
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
