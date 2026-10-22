const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, session,
  globalShortcut, clipboard, shell, dialog, desktopCapturer,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { spawn, execFile } = require("node:child_process");
/* 长期文件存储（录屏 / 历史 / 截图）与 MP4 收尾逻辑单独成文件：
   main.js 已经两千行，这两块的职责边界很清晰（磁盘目录管理、字节级容器修补），
   拆出去既能单测，也让面板相关改动不必再动主流程。 */
const storage = require("./storage");
const mp4finalize = require("./mp4finalize");
/* Snipaste 调用接口（截屏功能走它：检测 / 唤起 / 落盘到截屏分区）。 */
const snipaste = require("./snipaste");
/* 桌面模糊背景：藏窗抓桌面实拍，垫给玻璃态面板与录制条（原因见文件头）。 */
const glassbg = require("./glassbg");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");
/* 限制渲染进程的 V8 老生代上限。默认值是按物理内存自动算的（这台机器上很大），
   面板万一泄漏就会一路涨到几个 G 才暴露；压到 512MB 既够用（历史/消息都是小对象），
   又能让异常增长尽早暴露成 OOM 而不是悄悄吃内存。 */
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=512");
try {
  app.setPath("userData", path.join(__dirname, ".orbdata"));
} catch {}

/* ---------------- 可写数据根（打包关键） ----------------
 * 开发态：__dirname = <项目根>/orb/desktop，可写数据散在项目根（history/ triggers.json 等）。
 * 打包后：__dirname 在只读的 app.asar 里，任何写操作都会 ENOENT/EPERM。
 * 所以统一一个 DATA_ROOT：
 *   - 打包态 → %APPDATA%/ORB 控制台（标准用户数据目录，可写、可备份、卸载可留）
 *   - 开发态 → 项目根（保持现状，不迁移）
 * 只读资源（页面、图标、使用说明）仍从 __dirname 取，electron-builder 会一并打进包里。 */
const DATA_ROOT = app.isPackaged
  ? path.join(app.getPath("appData"), "ORB 控制台")
  : path.join(__dirname, "..", "..");
try { fs.mkdirSync(DATA_ROOT, { recursive: true }); } catch {}
try {
  if (app.isPackaged) app.setPath("userData", path.join(DATA_ROOT, ".orbdata"));
} catch {}

/* 把 DATA_ROOT 交给 storage 模块当默认根。
 * 走注入而不是让 storage 自己 require("../main")：那会形成 require 环，
 * 两边拿到的都是还没初始化完的半成品模块对象。 */
storage.init({
  dataRoot: DATA_ROOT,
  getState: () => state,
  setState: (patch) => saveState(patch),
  log: (...a) => log(...a),
});

/* Snipaste 模块只需要「读 state」和「问 storage 要截屏目录」两件事。 */
snipaste.init({
  getState: () => state,
  pathOf: (kind) => storage.pathOf(kind),
  log: (...a) => log(...a),
});

/* 桌面模糊背景（磨砂玻璃的实拍来源）：按窗口挂载，渲染层申报要不要。
   为什么必须自己抓桌面见 glassbg.js 头注（三个探针实测：透明窗里
   backdrop-filter 采不到桌面、开 GPU 无效、原生 acrylic 三条路全死）。 */
glassbg.init({ log: (...a) => log(...a) });

/* 打包态：把随包附带的使用说明释放到数据目录（DATA_ROOT 可写，用户也能自己改） */
function ensureBundledExtras() {
  if (!app.isPackaged) return;
  /* 两份东西要从包里种子到数据目录：
     ① 使用说明.md —— 桥/面板读的是 DATA_ROOT 下的那一份
     ② workflows/*.json —— 桥的工作流目录是 DATA_DIR/workflows，
        打包态 DATA_DIR = APPDATA，不种子的话用户一个示例工作流都看不到 */
  const seeds = [
    { src: path.join(process.resourcesPath, "extras", GUIDE_NAME), dst: path.join(DATA_ROOT, GUIDE_NAME), dir: false },
    { src: path.join(process.resourcesPath, "extras", "workflows"), dst: path.join(DATA_ROOT, "workflows"), dir: true },
  ];
  for (const s of seeds) {
    try {
      if (s.dir) {
        if (!fs.existsSync(s.src)) continue;
        fs.mkdirSync(s.dst, { recursive: true });
        for (const f of fs.readdirSync(s.src)) {
          if (!f.endsWith(".json")) continue;
          const to = path.join(s.dst, f);
          if (!fs.existsSync(to)) fs.copyFileSync(path.join(s.src, f), to);
        }
      } else if (fs.existsSync(s.src) && !fs.existsSync(s.dst)) {
        fs.copyFileSync(s.src, s.dst);
      }
    } catch { /* 种子失败不影响启动：说明和工作流都只是可选项 */ }
  }
}

// 动态定位 Node：ORB_NODE → versions 目录里最新可用版本 → PATH。
// 硬编码 versions/<版本>-<构建号> 会在 WorkBuddy 升级后失效（曾致 bridge spawn ENOENT）。
function resolveNodeExe() {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const cands = [];
  if (process.env.ORB_NODE) cands.push(process.env.ORB_NODE);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const base = path.join(home, ".workbuddy", "binaries", "node", "versions");
  try {
    for (const d of fs.readdirSync(base).sort().reverse()) cands.push(path.join(base, d, exe));
  } catch {}
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch {} }
  /* 打包态兜底：用户机上没有 WorkBuddy 的 node，也不该要求人家装 Node。
     直接用应用自带的 Electron 当 Node 用（spawn 时带 ELECTRON_RUN_AS_NODE=1），零额外体积。 */
  if (app.isPackaged) return process.execPath;
  return "node";
}
const NODE_EXE = resolveNodeExe();
const BRIDGE = path.join(__dirname, "..", "bridge.mjs");
/* 令牌文件位置必须与 bridge.mjs 的 TOKEN_FILE 保持同一条判定逻辑：
   桥那边是 `process.env.ORB_TOKEN_FILE || path.join(HERE, ".bridge.json")`（见 bridge.mjs:50）。
   这里原先只有硬编码的 `../.bridge.json`，于是单测把桥的令牌指到别处后，
   主进程仍从固定路径读 → 桥起来了但面板全线 401，且查不出原因。
   两边必须同时认这个环境变量，缺一边就会分叉。 */
const TOKEN_FILE =
  process.env.ORB_TOKEN_FILE || path.join(__dirname, "..", ".bridge.json");
const PORT = Number(process.env.ORB_PORT || 19387);

/* ---------------- 兜底与日志 ----------------
 * "奇怪的 bug" 大多死于两件事：异常被静默吞掉、事发时没有现场。
 * 这里把主进程的未捕获异常全部记下来，并落一份日志文件，事后可查。
 */
let logPath = null;
/** 单个参数转文字。JSON.stringify 遇到循环引用 / BigInt 会抛异常，
 *  而 log() 被 IPC handler、子进程 data 回调调用 —— 一抛就把调用方一起带崩。 */
function logArg(a) {
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

/* 落盘改成批量。
 * 原来每调一次 log() 就 appendFileSync 一次 —— 这是**同步**磁盘 I/O，
 * 直接堵在主进程事件循环上。高频点（鼠标每次进出悬浮球、每次划词、
 * bridge 的每一行 stdout）都会触发，磁盘写入量也随之放大。
 * 现在攒够 LOG_FLUSH_LINES 行、或距上次落盘超过 LOG_FLUSH_MS 就整批写一次。
 * 退出路径（before-quit / will-quit）会强制 flush，保证日志不丢。 */
const LOG_FLUSH_LINES = 256;
const LOG_FLUSH_MS = 2000;
let logBuf = [];
let logFlushTimer = null;

function flushLog() {
  if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
  const batch = logBuf;
  logBuf = [];
  if (!batch.length || !logPath) return;
  try {
    const fs2 = require("node:fs");
    // 必须先建目录：userData 目录在首次写状态前可能还不存在。
    fs2.mkdirSync(path.dirname(logPath), { recursive: true });
    // 不能直接 statSync——文件首次不存在时会抛 ENOENT，把后面的写入一起吞掉。
    if (fs2.existsSync(logPath) && fs2.statSync(logPath).size > 2 * 1024 * 1024) {
      fs2.writeFileSync(logPath, "");
    }
    fs2.appendFileSync(logPath, batch.join("\n") + "\n");
  } catch {}
}

function log(...args) {
  // 整段包 try/catch：日志是"最后的记录手段"，绝不能自己再抛出任何东西。
  try {
    const line = `[${new Date().toISOString()}] ${args.map(logArg).join(" ")}`;
    try { console.log(line); } catch {}
    if (logPath) {
      logBuf.push(line);
      if (logBuf.length >= LOG_FLUSH_LINES) flushLog();
      else if (!logFlushTimer) logFlushTimer = setTimeout(flushLog, LOG_FLUSH_MS);
    }
  } catch {}
}

process.on("uncaughtException", (e) => log("[fatal] uncaughtException:", e?.stack || String(e)));
process.on("unhandledRejection", (e) => log("[fatal] unhandledRejection:", e?.stack || String(e)));

/**
 * ipcMain.handle 的统一兜底包装。
 * 面板侧是 `await invoke(...)` —— handler 里只要抛异常（典型：窗口刚被销毁、
 * 剪贴板被别的进程占用、磁盘只读），调用方就永远等不到回包，
 * 表现为"点了没反应，之后这个按钮一直转圈"。
 * 这里把所有异常收敛成 fallback 值：功能退化，但绝不让某一步永久挂起。
 */
function safeHandle(channel, fn, fallback = null) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      try { log("[ipc] " + channel + " 异常:", (err && err.stack) || String(err)); } catch {}
      return typeof fallback === "function" ? fallback() : fallback;
    }
  });
}

/* ---------------- 单实例锁 ----------------
 * 没有它的话，启动两次就会出现两颗悬浮球、两个面板、两套全局快捷键，
 * 而且第二个实例的托盘图标会覆盖第一个 —— 行为完全错乱。
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // 抢锁失败：本进程立刻退出，绝不能再往下建托盘 / 悬浮球，
  // 否则会残留第二个「点了没反应」的托盘图标。
  app.quit();
} else {
  app.on("second-instance", () => {
    log("[app] 检测到第二个实例，聚焦已有窗口");
    if (panel) openPanel();
    else if (ball) { ball.show(); ball.focus(); }
  });
}

/** 读取 bridge 写入的令牌（端口一通就立刻读，失败时短重试） */
async function readBridgeToken(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (j && j.token) return j.token;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return "";
}

const BALL = 72;
const SLIVER = 16;
const PANEL_W = 400;
const PANEL_H = 600;
const DOCK_RATIO = 0.2;
const AVATAR_MAX = 2 * 1024 * 1024;

let ball, panel, tray, borderWin, bridgeProc;
/* 悬浮录屏控制条（T05）。懒创建：平时不占窗口，第一次开始录制才建。
 * pendingRecEvents 是关键 —— 窗口 loadFile 到 did-finish-load 之间有一段时间，
 * 用户在这期间按下「暂停」的话事件不能丢，否则控制条会显示成"还在录"而实际已暂停。 */
let recbarWin = null;
let recbarReady = false;
const pendingRecEvents = [];
let docked = null;
let drag = null;
let hoverOpenTimer = null;
let closeTimer = null;
let ballHover = false;
let panelHover = false;
let lastDockAt = 0;
let observing = 0;
let borderTimer = null;
let prefillQueue = [];
let noticeQueue = [];
let lastSelection = null;
let bridgeToken = "";
// 渲染进程可请求「先别折叠」：例如打开设置面板时，用户必然要离开去别处复制内容
let holdOpen = false;

const VISION_PRESETS = {
  hunyuan: { label: "混元 TokenHub（腾讯云）", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", model: "hunyuan-turbos-vision" },
  hunyuanT1: { label: "混元 T1 Vision（深度推理）", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", model: "hunyuan-t1-vision" },
  qwen:    { label: "Qwen 3.5（百炼）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3.5-plus", extra: { enable_thinking: false } },
  qwenVL:  { label: "Qwen3-VL（百炼，专用视觉）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen3-vl-plus", extra: { enable_thinking: false } },
  zhipu:   { label: "智谱 GLM-4V", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4v-plus" },
  openai:  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" },
  selftest:{ label: "自检（不调用外部接口）", baseUrl: "http://127.0.0.1:19387", model: "__selftest__" },
  custom:  { label: "自定义", baseUrl: "", model: "" },
};

function makeSlot(provider) {
  const p = VISION_PRESETS[provider] || VISION_PRESETS.custom;
  return {
    provider,
    baseUrl: p.baseUrl || "",
    model: p.model || "",
    apiKey: "",
    extra: p.extra ? { ...p.extra } : {},
  };
}

const state = {
  x: null, y: null, docked: null, pinned: false,
  coordMode: "pixel", border: true, avatar: null,
  autoSelect: true, autoSelectClipboard: true,
  // 视觉决策循环：主力 + 备选，主力失败自动切备选。
  // apiKey 只存在本机 .orbdata 下，不上传任何地方。
  vision: {
    primary: makeSlot("hunyuan"),
    backup: makeSlot("qwen"),
    maxSteps: 12,
  },
  // 语音输入与识别模块。
  // 主界面用的是 WorkBuddy 云端 ASR（daemon 内 asr:speechToTextStream →
  // ${endpoint}/clientcap/v2/asr/stream，需要 WorkBuddy 账号鉴权），
  // ORB 作为独立 Electron 应用拿不到那份鉴权，所以改为可插拔的识别引擎：
  //   - auto：   本地 Whisper 就绪 → 用本地（离线、免 Key）；否则**静默**回落浏览器引擎，
  //              只在 UI 上标一行"当前用浏览器引擎"（DESIGN §5.4）
  //   - browser：浏览器内置 Web Speech API（零配置，依赖 Chromium 语音服务，需联网）
  //   - whisper：OpenAI 兼容的 /audio/transcriptions 端点，录音经主进程代理 POST，绕开页面 CSP
  // 无论哪种引擎，UX 都和主界面一致：麦克风按钮 → 录音 → 实时把转写文本灌进输入框。
  voice: {
    engine: "auto",           // "auto" | "browser" | "whisper"
    endpoint: "",
    apiKey: "",
    model: "whisper-1",
    lang: "zh-CN",
  },
  /* 首跑向导是否已经看过（渲染层看完一次后经 set-wizard-done 送回来）。
   * 落在这里就是落在 orb-state.json 里，和 pinned / voice / vision 同级。
   * firstRun 不另外存：每次启动从 envWizardDone 反算，避免两份标记对不上。 */
  envWizardDone: false,
  firstRun: false,
  /* 截屏引导卡（Snipaste）是否已经读过。没装 Snipaste 的机器首启会弹一次，
   * 渲染层点「我知道了 / 去官网」后经 snip-guide-done 置位。 */
  snipGuideDone: false,
  /* 长期文件的存储根。留空 = 用默认位置（storage.resolveRoot() 回退 DATA_ROOT）。
   * 一旦用户改过，录屏 / 会话历史 / 截图三个子目录就都跟着它走。 */
  storageRoot: "",
  /* 换存储根之前的旧值。保留它是为了两件事：
   *   ① storage-migrate 靠它才知道从哪儿搬；
   *   ② 用户改错了还能看出来自己原来用的是哪儿。
   * 搬迁完成后会被清空，避免设置面板一直提示「有旧数据待搬迁」。 */
  storageRootPrev: "",
  /* 最近一次成功落盘的录屏，形如 { path, bytes, ms, mime }。
   * 面板拿它可以做「上次录的在哪儿」的直达入口，不必自己再翻目录。 */
  lastRecording: null,
  /* 悬浮录屏控制条（recbar.html）的偏好，设置 › 录屏 里改。
   *   recSkin        'light' 灰白纱（默认）| 'dark' 深纱（实时字幕同款配方）
   *   recEnergy      true 开始录制 2.6s 无操作自动收成细能量条，悬停展开
   *   recBorderColor '' 跟随皮肤默认描边；'#rrggbb' 用户自选描边色
   * 和主题（orb.theme 存渲染层 localStorage）**不是一回事**：主题跟着面板走，
   * 这三项只描述悬浮条长什么样，所以落在这里由主进程统一转发。 */
  recSkin: "light",
  recEnergy: true,
  recBorderColor: "",
  /* 实时字幕窗（subtitle.html）：与悬浮条同一套皮肤逻辑，默认深纱 ——
     字幕要压在视频上，深底不抢画面。 */
  subSkin: "dark",
  subBorderColor: "",
  /* 主题自选：交互键 + 运行态高亮的换色（不含红绿黄状态色，也不含品牌紫）。
   *   themeAccent 每套主题一个 '#rrggbb' 或 ''（默认）
   *   themeGrad   极光（t3）的渐变搭配 id，'' = 默认极光
   *   themeImage  自定义主题（t4）的整窗背景图路径，落 userData 下 */
  themeAccent: { t1: "", t2: "", t3: "", t4: "" },
  themeGrad: "",
  /* 自定义渐变（themeGrad === "custom" 时生效）：色带上选的起点/终点两个 hex */
  themeGradCustom: { c1: "", c2: "" },
  /* 毛玻璃：每套主题各一份。t3（极光）恒 true —— 玻璃+彩板是它的本体，
     不进开关；另外三套默认关，开了就是"面板与浮层透出并模糊桌面"。 */
  themeGlass: { t1: false, t2: false, t3: true, t4: false },
  themeImage: "",
};
/* 主题 id 全集（面板 localStorage 与这里必须一致；t4 = 自定义图片主题） */
const THEME_IDS = ["t1", "t2", "t3", "t4"];
/* 极光渐变搭配 id（前端 T3_GRADS 的同名清单，主进程只做白名单校验） */
const T3_GRAD_IDS = ["candy", "mint", "aurora", "golden", "rose", "emerald"];

/** 兼容早期的扁平结构（provider/baseUrl/... 直接在 vision 下） */
function normalizeVision(v) {
  if (!v || typeof v !== "object") return null;
  if (v.primary && v.backup) {
    return {
      primary: { ...makeSlot("custom"), ...v.primary },
      backup: { ...makeSlot("custom"), ...v.backup },
      maxSteps: Math.max(1, Math.min(40, Number(v.maxSteps) || 12)),
    };
  }
  if (v.baseUrl || v.model) {
    return {
      primary: { provider: v.provider || "custom", baseUrl: v.baseUrl || "", model: v.model || "", apiKey: v.apiKey || "", extra: v.extra || {} },
      backup: makeSlot("qwen"),
      maxSteps: Math.max(1, Math.min(40, Number(v.maxSteps) || 12)),
    };
  }
  return null;
}

const stateFile = () => path.join(app.getPath("userData"), "orb-state.json");

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
    const v = normalizeVision(raw.vision);
    Object.assign(state, raw);
    if (v) state.vision = v;
    normalizeRecPrefs();
    normalizeThemePrefs();
  } catch {}
}
/* 老配置文件里没有录屏偏好这三项；也防手改orb-state.json 时写进奇怪的值 ——
   归一化放在加载后统一做一次，比在每个读取点判空可靠。 */
function normalizeRecPrefs() {
  state.recSkin = state.recSkin === "dark" ? "dark" : "light";
  state.recEnergy = state.recEnergy !== false;
  state.recBorderColor = /^#[0-9a-fA-F]{6}$/.test(String(state.recBorderColor || ""))
    ? String(state.recBorderColor).toLowerCase()
    : "";
}
/* 主题自选与字幕窗偏好的归一化：同样只做"加载后一次"，形状不对就回默认值。 */
function normalizeThemePrefs() {
  state.subSkin = state.subSkin === "light" ? "light" : "dark";
  state.subBorderColor = /^#[0-9a-fA-F]{6}$/.test(String(state.subBorderColor || ""))
    ? String(state.subBorderColor).toLowerCase()
    : "";
  const acc = state.themeAccent && typeof state.themeAccent === "object" ? state.themeAccent : {};
  state.themeAccent = {};
  for (const t of THEME_IDS) {
    const c = String(acc[t] || "").toLowerCase();
    state.themeAccent[t] = /^#[0-9a-f]{6}$/.test(c) ? c : "";
  }
  state.themeGrad = (state.themeGrad === "custom" || T3_GRAD_IDS.includes(state.themeGrad)) ? state.themeGrad : "";
  const gc = state.themeGradCustom && typeof state.themeGradCustom === "object" ? state.themeGradCustom : {};
  const ghex = (v) => { const s = String(v || "").toLowerCase(); return /^#[0-9a-f]{6}$/.test(s) ? s : ""; };
  state.themeGradCustom = { c1: ghex(gc.c1), c2: ghex(gc.c2) };
  /* 选了自定义档却拿不出两个合法端点 → 退回默认渐变，别把界面留在空态 */
  if (state.themeGrad === "custom" && !(state.themeGradCustom.c1 && state.themeGradCustom.c2)) state.themeGrad = "";
  /* 毛玻璃：形状不对就按默认重建；极光恒开，外部改不动 */
  const gl = state.themeGlass && typeof state.themeGlass === "object" ? state.themeGlass : {};
  state.themeGlass = {};
  for (const t of THEME_IDS) state.themeGlass[t] = t === "t3" ? true : !!gl[t];
  state.themeImage = typeof state.themeImage === "string" ? state.themeImage : "";
}
function themePrefsPayload() {
  return {
    accent: { ...state.themeAccent },
    grad: state.themeGrad,
    gradCustom: { ...state.themeGradCustom },
    glass: { ...state.themeGlass },
    themeImage: themeImageDataUrl(),
  };
}
function saveState(patch) {
  Object.assign(state, patch || {});
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state));
  } catch {}
}

function displayOf(bounds) {
  return screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
}

function waitForBridge(retries = 40) {
  return new Promise((resolve) => {
    const tick = (n) => {
      const s = net.connect(PORT, "127.0.0.1");
      // 必须设超时：连上一个"接受连接但永远不响应"的端口时，connect / error
      // 都不触发，socket 会一直挂着，这条探测链也就永久悬在那儿。
      s.setTimeout(1500);
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        try { s.destroy(); } catch {}
        if (ok) return resolve(true);
        if (n <= 0) return resolve(false);
        setTimeout(() => tick(n - 1), 500);
      };
      s.on("connect", () => finish(true));
      s.on("timeout", () => finish(false));
      s.on("error", () => finish(false));
    };
    tick(retries);
  });
}

/** 把矩形夹进最近的显示器工作区：拔掉外接屏 / 改分辨率后，
 *  上次保存的坐标可能整个落在屏幕外 —— 悬浮球跑到看不见的地方等于应用不可用。 */
function clampToWorkArea(x, y, w, h) {
  try {
    const d = screen.getDisplayNearestPoint({ x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 });
    const wa = d.workArea;
    return {
      x: Math.round(Math.max(wa.x, Math.min(x, wa.x + wa.width - w))),
      y: Math.round(Math.max(wa.y, Math.min(y, wa.y + wa.height - h))),
    };
  } catch {
    return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
  }
}

/* ---------------- 悬浮球 ---------------- */

function createBall() {
  const wa = screen.getPrimaryDisplay().workArea;
  const dx = wa.x + wa.width - BALL - 24;
  const dy = wa.y + Math.round(wa.height * 0.6);
  // 存档坐标只校验了 isFinite：拔掉副屏 / 换分辨率后它完全可能落在所有屏幕之外，
  // 悬浮球建在看不见的地方，用户除了删存档没有任何办法把它弄回来。
  const p = (Number.isFinite(state.x) && Number.isFinite(state.y))
    ? clampToWorkArea(state.x, state.y, BALL, BALL)
    : { x: dx, y: dy };

  ball = new BrowserWindow({
    x: p.x, y: p.y, width: BALL, height: BALL,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  ball.loadFile(path.join(__dirname, "ball.html"));
  ball.setAlwaysOnTop(true, "screen-saver");
  ball.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  ball.webContents.on("console-message", (e) => log(`[ball:${e.level}] ${e.message}`));
  ball.on("closed", () => { ball = null; });
  ball.webContents.once("did-finish-load", () => {
    log("[ball-bounds]", JSON.stringify(ball.getBounds()));
  });
}

function dock(side) {
  if (!ball) return;
  const b = ball.getBounds();
  const wa = displayOf(b).workArea;
  docked = side;
  lastDockAt = Date.now();
  const x = side === "left" ? wa.x : wa.x + wa.width - SLIVER;
  ball.setBounds({ x, y: b.y, width: SLIVER, height: BALL });
  saveState({ docked: side, x: b.x, y: b.y });
  ball.webContents.send("dock-state", side);
}

function undock() {
  if (!ball || !docked) return;
  const b = ball.getBounds();
  const wa = displayOf(b).workArea;
  const side = docked;
  docked = null;
  const x = side === "left" ? wa.x : wa.x + wa.width - BALL;
  ball.setBounds({ x, y: b.y, width: BALL, height: BALL });
  saveState({ docked: null, x, y: b.y });
  ball.webContents.send("dock-state", null);
}

function beginDrag() {
  if (!ball) return;
  /* 上一次拖拽如果没收到 drag-end（页面重载、右键菜单、鼠标在窗口外松开），
     drag 还挂着、16ms 定时器还在跑。这里必须先收表再起新的，
     否则每漏一次 drag-end 就多一个 62fps 的常驻定时器。 */
  stopDragTimer();
  drag = null;
  if (docked) undock();
  drag = {
    cursor: screen.getCursorScreenPoint(),
    bounds: ball.getBounds(),
    moved: false,
    /* 30ms ≈ 33fps。原来 16ms（62fps）每一帧都是三连 IPC
       （getCursorScreenPoint + getBounds + setPosition），主进程 IPC 量减半，
       而拖拽跟手度完全无差别。 */
    timer: setInterval(dragTick, 30),
  };
}

/** 只收定时器、不触发"单击"语义（避免把一次异常收尾当成点击打开面板） */
function stopDragTimer() {
  if (drag && drag.timer) clearInterval(drag.timer);
}

function dragTick() {
  if (!drag) return;
  // 球没了（窗口被关/重建）就立刻收表：原来的 `return` 会让这个 16ms 定时器永远空转下去。
  if (!ball || ball.isDestroyed()) { stopDragTimer(); drag = null; return; }
  const p = screen.getCursorScreenPoint();
  const dx = p.x - drag.cursor.x;
  const dy = p.y - drag.cursor.y;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
  const nx = drag.bounds.x + dx;
  const ny = drag.bounds.y + dy;
  const b = ball.getBounds();
  if (b.x === nx && b.y === ny) return;
  ball.setPosition(nx, ny);
}

function endDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  const moved = drag.moved;
  drag = null;
  log("[drag-end] moved=" + moved);
  if (!moved) { onBallClick(); return; }
  settleBall();
}

function settleBall() {
  if (!ball) return;
  const b = ball.getBounds();
  const wa = displayOf(b).workArea;

  const offLeft = wa.x - b.x;
  const offRight = (b.x + b.width) - (wa.x + wa.width);

  if (offLeft >= BALL * DOCK_RATIO) return dock("left");
  if (offRight >= BALL * DOCK_RATIO) return dock("right");

  const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - BALL));
  let x = b.x;
  if (x - wa.x < 10) x = wa.x;
  if (wa.x + wa.width - (x + BALL) < 10) x = wa.x + wa.width - BALL;

  ball.setBounds({ x: Math.round(x), y: Math.round(y), width: BALL, height: BALL });
  saveState({ x: Math.round(x), y: Math.round(y), docked: null });
}

/* ---------------- 面板 ---------------- */

function panelBounds() {
  const anchor = ball ? ball.getBounds() : null;
  const disp = anchor ? displayOf(anchor) : screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const minY = wa.y + 8;
  const maxY = wa.y + wa.height - PANEL_H - 8;

  let y;
  let fallback = false;
  if (!anchor) {
    y = wa.y + 40;
  } else {
    const above = anchor.y - PANEL_H - 12;
    const below = anchor.y + anchor.height + 12;
    if (above >= minY) y = above;
    else if (below <= maxY) y = below;
    else { y = minY; fallback = true; }
  }

  let x;
  if (!anchor) {
    x = wa.x + wa.width - PANEL_W - 24;
  } else if (fallback) {
    // 上下都放不下，面板会压住球 —— 改到球的侧面，保证球完全可见
    const left = anchor.x - PANEL_W - 12;
    const right = anchor.x + anchor.width + 12;
    if (left >= wa.x + 8) x = left;
    else if (right + PANEL_W <= wa.x + wa.width - 8) x = right;
    else x = anchor.x + anchor.width / 2 - PANEL_W / 2;
  } else {
    x = anchor.x + anchor.width / 2 - PANEL_W / 2;
  }
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - PANEL_W - 8));
  return { x: Math.round(x), y: Math.round(y), width: PANEL_W, height: PANEL_H };
}

function createPanel() {
  panel = new BrowserWindow({
    ...panelBounds(),
    frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      // 拼写检查会加载字典 + 起后台线程，这个界面里一个输入框都不需要它
      spellcheck: false,
      // 初始值 false：面板一出来就要跟手。**但不再是一成不变** ——
      // 原来是永久 false，导致面板收起后渲染进程照样全速跑、定时器一个不落，
      // 白烧 CPU。现在跟着可见性切（见下面的 show/hide 监听）。
      backgroundThrottling: false,
    },
  });
  /* 面板可见 = 不节流（视觉循环要跟手）；收起 = 立刻恢复节流（省 CPU）。
     这个开关运行时可以改，不必重建窗口。 */
  panel.on("show", () => { try { panel.webContents.setBackgroundThrottling(false); } catch {} });
  panel.on("hide", () => { try { panel.webContents.setBackgroundThrottling(true); } catch {} });
  panel.loadFile(path.join(__dirname, "panel.html"));
  /* 桌面模糊底图：面板玻璃态（t1/t2）时要抓桌面实拍。挂载即可，
     抓不抓由渲染层的 glass-bg-want 说了算（非玻璃态零开销）。 */
  glassbg.watch(panel, "glass:bg");
  panel.webContents.on("console-message", (e) => log(`[panel:${e.level}] ${e.message}`));
  panel.webContents.on("render-process-gone", (_e, d) => log("[panel] gone:", d.reason));
  panel.setAlwaysOnTop(true, "screen-saver");
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panel.on("closed", () => {
    panel = null;
    /* 面板没了，控制条就没有存在的意义：隐藏而不是销毁，下次录制还能直接复用。
     * 同时按录制态决定要不要清临时分片 —— 面板被强关时 cap-close 永远不会来，
     * recordings 下会留下一个再也没人认领的 .part，越攒越多。 */
    try {
      if (recbarWin && !recbarWin.isDestroyed()) recbarWin.hide();
      if (capSessions.size > 0) {
        log("[cap] 面板已关闭，正在录制，清理临时分片");
        purgeRecordingParts();
      }
    } catch (e) {
      log("[recbar] 面板关闭收尾失败:", (e && e.message) || String(e));
    }
  });
}

function sendToPanel(channel, payload) {
  if (panel && !panel.isDestroyed()) panel.webContents.send(channel, payload);
}
function sendToBall(channel, payload) {
  if (ball && !ball.isDestroyed()) ball.webContents.send(channel, payload);
}
function sendToBar(channel, payload) {
  if (recbarWin && !recbarWin.isDestroyed()) {
    try { recbarWin.webContents.send(channel, payload); return true; } catch { /* 窗口正在销毁 */ }
  }
  return false;
}

/* ---------------- 悬浮录屏控制条 ----------------
 * 录制一开始面板就会隐藏，控制键必须有个自己的家：一个 240×54 的
 * 无边框置顶小窗，钉在屏幕顶部水平居中。窗口是 transparent 的 ——
 * 纱质皮肤（灰白纱 / 深纱）必须先有透明窗才成立，圆角与底衫由
 * recbar.html 的 .skin 自己画。拖拽走 -webkit-app-region，
 * 老方案"透明窗拖拽边缘失效"的那类问题在固定尺寸 + 不缩放的窗口上不存在。
 */
function recbarBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 240, h = 54;
  /* 紧贴屏幕上端（横向仍居中）：控制条要像浏览器标签条那样压在顶边，
     不要悬在屏幕中间 —— 离顶越远，越容易挡住被录软件的标题栏/标签页。
     留 2px 是给页面里那圈投影一点呼吸，别被裁掉。 */
  return { x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + 2), width: w, height: h };
}

/* 控制条偏好快照。控制条是懒创建 + 可能反复销毁的小窗，所以偏好不存它本地：
   统一由主进程持有（state），窗口就绪时补推一次（did-finish-load）。 */
function recCfg() {
  return { skin: state.recSkin, energy: state.recEnergy, borderColor: state.recBorderColor || "" };
}
function sendRecCfg() {
  sendToBar("rec:cfg", recCfg());
}

function createRecBar() {
  if (recbarWin && !recbarWin.isDestroyed()) return recbarWin;
  try {
    recbarWin = new BrowserWindow({
      ...recbarBounds(),
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      hasShadow: false,
      /* transparent + 全透明底色：底衫由页面的 .skin 画（见文件头注释）。
         投影也画在页面里（--pill-shadow），不走窗口原生阴影。 */
      transparent: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "recbar-preload.js"),
        contextIsolation: true,
        spellcheck: false,
        /* 控制条常驻可见，但保险起见关掉节流 ——
           计时器万一被节流，秒数会越走越慢，而用户没有任何办法察觉。 */
        backgroundThrottling: false,
      },
    });
    recbarReady = false;
    recbarWin.loadFile(path.join(__dirname, "recbar.html"));
    /* 录制条的纱（α.82）在透明窗里同样采不到桌面，一并挂上实拍抓取 */
    glassbg.watch(recbarWin, "recbar:glass-bg");
    recbarWin.webContents.on("console-message", (e) => log(`[recbar:${e.level}] ${e.message}`));
    recbarWin.webContents.on("render-process-gone", (_e, d) => log("[recbar] gone:", d.reason));
    recbarWin.on("closed", () => {
      recbarWin = null; recbarReady = false; pendingRecEvents.length = 0;
      stopRecbarHoverWatch(); recbarPassthru = false;   // 窗口都没了，光标监视必须跟着停
    });
    recbarWin.webContents.once("did-finish-load", () => {
      recbarReady = true;
      /* 把窗口就绪前攒下的事件按序补发。顺序不能乱：
         pause 先于 resume 到达时，乱序会让计时器从"暂停态"直接跳到"续走态"。 */
      const queued = pendingRecEvents.splice(0, pendingRecEvents.length);
      for (const p of queued) sendToBar("rec:event", p);
      /* 偏好也要补推：窗口可能是上一轮录制建的，用户之后改过皮肤/描边，
         不推的话那条窗还挂着旧配方。 */
      sendRecCfg();
    });
    return recbarWin;
  } catch (e) {
    /* 创建失败（极端情况：显示驱动异常 / 内存不足）不能让录制功能一起挂 ——
       控制条只是个操作界面，主进程的落盘链路不依赖它。 */
    log("[recbar] 创建失败:", (e && e.message) || String(e));
    recbarWin = null;
    recbarReady = false;
    return null;
  }
}

/** 向控制条广播一个事件；窗口没就绪就先入队，等 did-finish-load 后补发。 */
function emitRecEvent(payload) {
  if (recbarWin && !recbarWin.isDestroyed() && recbarReady) {
    sendToBar("rec:event", payload);
  } else {
    pendingRecEvents.push(payload);
    /* 队列上限：万一 did-finish-load 一直不来（页面脚本崩了），
       不能让数组无限长。保留最早的一个 start，其它新的覆盖式跟进。 */
    if (pendingRecEvents.length > 32) pendingRecEvents.splice(1, pendingRecEvents.length - 32);
  }
}

/** 清理录制残留的临时分片。只删 .part —— 成品 mp4 一个字节都不碰。 */
function purgeRecordingParts() {
  /* 先把还开着的句柄关掉：Windows 上删不掉被占用的文件，
     不先 close 的话这一趟大概率白跑。会话本身一并作废 —— 面板都没了，
     录制不可能继续，留着句柄只会让 .part 永远删不掉。 */
  try {
    for (const id of Array.from(capSessions.keys())) capDrop(id, false);
  } catch { /* 收尾路径不抛 */ }

  /* 两处都要扫：
   *  ① recordings/ 顶层 —— 按约定清理的位置（别的写入路径也可能落在这一层）；
   *  ② recordings/.tmp/ —— 本实现真正写分片的地方（见 cap-open）。
   * 都不递归：screenshots / history 与其它用户文件一概不碰。 */
  for (const dir of [storage.pathOf("recordings"), storage.pathOf("tmp")]) {
    try {
      if (!dir || !fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".part")) continue;
        try { fs.unlinkSync(path.join(dir, name)); }
        catch (e) { log("[cap] 删除残留分片失败:", name, (e && e.message) || String(e)); }
      }
    } catch (e) {
      log("[cap] 清理 .part 失败:", dir, (e && e.message) || String(e));
    }
  }
}

/**
 * 启动期（面板还没建出来）产生的提示先排队，面板一打开就补发。
 * 没有它的话，bridge 起不来这类致命问题在 UI 上完全静默 ——
 * 用户只会觉得"什么都点不动"，而日志在 .orbdata 里没人看。
 */
function pushNotice(text) {
  noticeQueue.push(String(text));
  if (panel && !panel.isDestroyed() && panel.isVisible()) flushNotices();
}
function flushNotices() {
  const queued = noticeQueue;
  noticeQueue = [];
  for (const text of queued) sendToPanel("notice", text);
}

function openPanel() {
  clearTimeout(hoverOpenTimer);
  startTrack();
  if (!panel) createPanel();
  panel.setBounds(panelBounds());
  panel.show();
  panel.focus();
  panelHover = false;
  log("[open-panel]", JSON.stringify(panel.getBounds()));
  sendToBall("panel-state", true);
  const queued = prefillQueue;
  prefillQueue = [];
  for (const text of queued) sendToPanel("prefill", text);
  flushNotices();
}

function closePanel() {
  clearTimeout(closeTimer);
  panelHover = false;
  if (!panel || !panel.isVisible()) return;
  log("[close-panel]");
  panel.hide();
  sendToBall("panel-state", false);
  if (!ballHover && !panelHover) stopTrack();
}

function togglePanel() {
  if (panel && panel.isVisible()) closePanel();
  else openPanel();
}

/**
 * 单击悬浮球。对齐原版 Orb 的语义：
 *  - 面板没开 → 打开（临时态，鼠标移开自动折叠）
 *  - 已开但未固定 → 固定（钉住）
 *  - 已开且已固定 → 取消固定，随后鼠标移开自动折叠
 * 显式开合请用 Ctrl+Space。
 */
function onBallClick() {
  const visible = panel && panel.isVisible();
  if (!visible) { openPanel(); return; }
  if (!state.pinned) {
    saveState({ pinned: true });
    sendToPanel("pin-state", true);
    sendToPanel("notice", "面板已固定，鼠标移开不会折叠。再点一次球体或按 Ctrl+Space 收起。");
    cancelClose();
  } else {
    saveState({ pinned: false });
    sendToPanel("pin-state", false);
    scheduleClose(300);
  }
}

function scheduleClose(delay = 500) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (state.pinned || panelHover || ballHover || drag || holdOpen) return;
    closePanel();
  }, delay);
}

function cancelClose() {
  clearTimeout(closeTimer);
}

/* ---------------- 划词工具条 ---------------- */

let toolbar;
/* 工具条是懒创建的：第一次划词时才建窗口。
   页面（toolbar.html）里的 onSelectionText 监听要到 did-finish-load 之后才挂上，
   这时候 send 过去消息会被直接丢掉 —— 表现为"第一次划词弹出的工具条点了没反应"
   （text 还是空串）。所以先把文本存起来，等页面就绪再补发。 */
let toolbarReady = false;
let pendingToolbarText = null;

function flushToolbarText() {
  if (toolbarReady && pendingToolbarText !== null && toolbar && !toolbar.isDestroyed()) {
    toolbar.webContents.send("selection-text", pendingToolbarText);
    pendingToolbarText = null;
  }
}

function createToolbar() {
  toolbar = new BrowserWindow({
    width: 216, height: 44, show: false, frame: false, transparent: true,
    resizable: false, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  toolbar.loadFile(path.join(__dirname, "toolbar.html"));
  toolbar.setAlwaysOnTop(true, "screen-saver");
  toolbar.webContents.once("did-finish-load", () => {
    toolbarReady = true;
    flushToolbarText();
  });
  toolbar.on("blur", () => toolbar && toolbar.hide());
  toolbar.on("closed", () => { toolbar = null; toolbarReady = false; pendingToolbarText = null; });
}

async function bridgeCall(tool, args, timeoutMs = 30000, retried = false) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/call`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orb-Token": bridgeToken },
      body: JSON.stringify({ server: "windows", tool, args }),
      signal: ctrl.signal,
    });
    /* 401 = 令牌失效（桥被重启过）。重读一次令牌再试 ——
       否则"划词取词"会一直静默失败，用户只知道"有时候不弹"。 */
    if (r.status === 401 && !retried) {
      const fresh = bridgeTokenSync();
      if (fresh && fresh !== bridgeToken) {
        bridgeToken = fresh;
        return await bridgeCall(tool, args, timeoutMs, true);
      }
    }
    // 桥可能返回空体/非 JSON（崩溃中），r.json() 一抛就把调用方带进 catch，
    // 症状是"取词失败"却查不到原因。统一收敛成结构化错误。
    return await r.json().catch(() => ({ ok: false, error: "桥返回了非 JSON 响应" }));
  } finally {
    clearTimeout(t);
  }
}

async function captureSelection() {
  const before = clipboard.readText();
  await bridgeCall("Shortcut", { shortcut: "ctrl+c" }, 8000).catch(() => {});
  await new Promise((r) => setTimeout(r, 320));
  const text = clipboard.readText();
  /* 没有新选区时必须返回空串。
     原来是 `text || before` —— Ctrl+C 没取到东西时剪贴板没变，text === before，
     于是把**上一次复制的内容**当成"这次选中的文字"塞给面板/工具条。 */
  return text && text !== before ? text : "";
}

/**
 * 划词自动弹出的取词降级路径。
 *
 * 浏览器 / 原生应用由 UIA 直接读选区，不碰剪贴板。
 * Electron 应用默认不开启无障碍树，UIA 读不到 —— 只能模拟 Ctrl+C。
 * 这里会先备份剪贴板文字，读完立刻还原；如果剪贴板里是图片等无法还原的
 * 内容，就不做这次降级，避免悄悄弄丢用户的东西。
 */
async function clipboardSelection() {
  const hadText = clipboard.readText();
  let hadImage = false;
  try { hadImage = !clipboard.readImage().isEmpty(); } catch {}

  if (!hadText && hadImage) return null;   // 无法还原，宁可不取

  await bridgeCall("Shortcut", { shortcut: "ctrl+c" }, 8000).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const text = clipboard.readText();

  if (hadText && text !== hadText) {
    try { clipboard.writeText(hadText); } catch {}
  }
  return text && text !== hadText ? text : null;
}

/* ---------------- 划词监听（常驻） ---------------- */

/*
 * 原生优先，PowerShell 兜底。
 *
 * 原生（native/dist/orb-selection.exe）：
 *   · 常驻一个 ~160KB 的原生进程，16ms 轮询（PowerShell 版是 60ms）
 *   · UIA 直读，不走 .NET 互操作；不再有 Add-Type 的 1~2 秒启动期
 *   · 不再常驻一个 powershell.exe（连带 .NET 运行时，几十 MB 不放）
 *   · 事件格式与 selection-watch.ps1 逐字节一致，handleWatchEvent 不用改
 *
 * 回退是硬要求：exe 不存在 / spawn 报错 / 连续崩溃超过上限，
 * 都会自动退回 PowerShell，功能不中断。
 */
const ORB_SELECTION = process.env.ORB_SELECTION_EXE
  || path.join(__dirname, "..", "native", "dist", "orb-selection.exe");
const WATCH_MAX_RESTARTS = 5;    // 单条路径连续崩溃重启上限

let watchProc = null;
let watchMode = null;            // "native" | "ps"
let watchBuf = "";
let watchStopped = false;
let watchRestarts = 0;

function stopSelectionWatch() {
  watchStopped = true;
  if (!watchProc) return;
  try { watchProc.kill(); } catch {}
  watchProc = null;
  watchMode = null;
  watchBuf = "";
}

/**
 * 公共部分：挂 stdout 行解析 + 崩溃自动重启。
 * 原生与 PowerShell 两条路只有 spawn 方式不同，其余完全共用。
 */
function attachWatchProc(p, mode) {
  watchMode = mode;
  p.stdout.on("data", (d) => {
    watchBuf += d.toString("utf8");
    let i;
    while ((i = watchBuf.indexOf("\n")) >= 0) {
      const line = watchBuf.slice(0, i).trim();
      watchBuf = watchBuf.slice(i + 1);
      if (line.startsWith("{")) handleWatchEvent(line);
    }
  });
  p.stderr.on("data", () => {});

  // 稳定跑满 20 秒就认为这次启动成功，把重启计数清零，
  // 避免"偶发崩一次"被累积成"连续失败 5 次"而永久停摆。
  const stabTimer = setTimeout(() => {
    if (watchProc === p && p.exitCode === null) watchRestarts = 0;
  }, 20000);

  p.on("exit", (code) => {
    clearTimeout(stabTimer);
    if (watchProc === p) { watchProc = null; watchMode = null; }
    watchBuf = "";
    // 崩溃自动重启：划词是常驻能力，进程悄悄挂掉会让功能静默失效，
    // 用户只会觉得"有时候不弹"，事后完全查不出来。
    if (watchStopped || !state.autoSelect) return;
    if (watchRestarts >= WATCH_MAX_RESTARTS) {
      if (mode === "native") {
        // 原生这条走不通了，换 PowerShell 顶上，别让功能整个消失
        log("[watch] 原生监听器连续崩溃超过", WATCH_MAX_RESTARTS, "次，退回 PowerShell");
        watchRestarts = 0;
        startPsWatch();
      } else {
        log("[watch] 连续重启失败", WATCH_MAX_RESTARTS, "次，停止重试。请检查 selection-watch.ps1");
      }
      return;
    }
    watchRestarts += 1;
    const delay = 1000 * watchRestarts;
    log(`[watch] 意外退出(code=${code}, mode=${mode})，${delay}ms 后第 ${watchRestarts} 次重启`);
    setTimeout(() => {
      if (watchStopped || !state.autoSelect) return;
      if (mode === "native") startNativeWatch(); else startPsWatch();
    }, delay);
  });
}

function startNativeWatch() {
  if (watchProc) return true;
  if (!fs.existsSync(ORB_SELECTION)) {
    log("[watch] 原生监听器不存在，走 PowerShell 回退：", ORB_SELECTION);
    return false;
  }
  let p;
  try {
    p = spawn(ORB_SELECTION, ["--serve"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
  } catch (e) {
    log("[watch] 原生监听器启动失败，走 PowerShell 回退：", (e && e.message) || String(e));
    return false;
  }
  watchStopped = false;
  attachWatchProc(p, "native");
  watchProc = p;
  log("[watch] 划词监听已启动（原生）");
  return true;
}

function startPsWatch() {
  if (watchProc) return;
  watchStopped = false;
  const ps1 = path.join(__dirname, "selection-watch.ps1");
  let b64;
  try {
    b64 = Buffer.from(fs.readFileSync(ps1, "utf8"), "utf16le").toString("base64");
  } catch (e) {
    log("[watch] 读取脚本失败:", e.message);
    return;
  }
  let p;
  try {
    p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64], {
      windowsHide: true,
    });
  } catch (e) {
    log("[watch] PowerShell 监听器启动失败：", (e && e.message) || String(e));
    return;
  }
  attachWatchProc(p, "ps");
  watchProc = p;
  log("[watch] 划词监听已启动（PowerShell 回退）");
}

function startSelectionWatch() {
  if (watchProc || !state.autoSelect) return;
  if (startNativeWatch()) return;
  startPsWatch();
}

function overOurWindow(point) {
  return [ball, panel, toolbar, borderWin]
    .filter((w) => w && !w.isDestroyed() && w.isVisible())
    .some((w) => {
      const b = w.getBounds();
      return point.x >= b.x && point.x <= b.x + b.width && point.y >= b.y && point.y <= b.y + b.height;
    });
}

async function handleWatchEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type !== "select") return;
  log("[watch] select", ev.text ? "uia=" + JSON.stringify(String(ev.text).slice(0, 26)) : "(uia 无文字)");

  // 坐标空间不一（脚本是 DPI-unaware，拿到的可能不是 DIP），
  // 统一改用 Electron 自己的光标位置，保证与窗口定位同一坐标系。
  const point = screen.getCursorScreenPoint();
  if (overOurWindow(point)) return;

  let text = ev.text;
  if (!text) {
    // UIA 读不到（Chromium / Electron 默认不开无障碍树，如网页 / Office / 微信）。
    // 走剪贴板降级：模拟 Ctrl+C 取词，读完立即还原剪贴板。
    if (!state.autoSelectClipboard) return;
    // 但终端里 Ctrl+C 会「中断当前进程」——前台是控制台类窗口就跳过，避免误伤。
    // 类名由常驻的划词监听进程随事件带出（ev.cls），不再另起 PowerShell（那要 2~3 秒）。
    if (isConsoleClass(ev.cls)) {
      log("[watch] 前台是控制台窗口，跳过 Ctrl+C 取词");
      return;
    }
    text = await clipboardSelection();
    log("[watch] Ctrl+C 取词:", text ? "OK " + JSON.stringify(String(text).slice(0, 24)) : "无文字");
  }
  if (!text) return;
  text = String(text).trim();
  if (!text) return;

  lastSelection = { text, at: Date.now() };
  showToolbar(text, point);
}

function showToolbar(text, point) {
  if (!toolbar) createToolbar();
  const disp = screen.getDisplayNearestPoint(point);
  const wa = disp.workArea;
  const w = 216, h = 44;
  const x = Math.max(wa.x + 4, Math.min(point.x - w / 2, wa.x + wa.width - w - 4));
  const y = Math.max(wa.y + 4, Math.min(point.y + 18, wa.y + wa.height - h - 4));
  toolbar.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  if (!toolbar.isVisible()) toolbar.showInactive();
  pendingToolbarText = text;
  flushToolbarText();
}

/** 手动热键路径（Ctrl+Alt+S），自动弹出不可用时作为兜底。 */
async function showSelectionToolbar() {
  const point = screen.getCursorScreenPoint();
  const text = (await captureSelection()).trim();
  if (!text) {
    openPanel();
    sendToPanel("notice", "没取到选中文字——先选中一段文本，再按 Ctrl+Alt+S。");
    return;
  }
  lastSelection = { text, at: Date.now() };
  showToolbar(text, point);
}

/* ---------------- 实时字幕悬浮窗 ---------------- */

let subWin = null;
// 字幕长连接状态见 subStream（SSE，取代原来的 subPoll 定时器）
const SUBTITLE_RT_PORT = 19879;

function createSubtitleWin() {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = 680, h = 132;
  subWin = new BrowserWindow({
    width: w, height: h, show: false, frame: false, transparent: true,
    resizable: true, alwaysOnTop: true, skipTaskbar: true, hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  subWin.loadFile(path.join(__dirname, "subtitle.html"));
  subWin.setAlwaysOnTop(true, "screen-saver");
  // 默认贴在屏幕下方居中——播放器一般就在这个区域
  subWin.setPosition(Math.round(wa.x + (wa.width - w) / 2), Math.round(wa.y + wa.height - h - 36));
  // 窗口被关掉必须停表：原来只置 null，500ms 的轮询会一直打到字幕服务上。
  subWin.on("closed", () => { subWin = null; stopSubtitleStream(); });
  /* 皮肤 / 自选描边补推：字幕窗也是懒创建 + 反复开关的小窗，
     偏好不在它本地存，就绪时由主进程推一次（与控制条同一套路）。 */
  subWin.webContents.once("did-finish-load", sendSubCfg);
}

/* 字幕窗偏好（皮肤 + 描边色）。默认深纱：字幕压在视频上，深底不抢画面。 */
function subCfg() {
  return { skin: state.subSkin, borderColor: state.subBorderColor || "" };
}
function sendSubCfg() {
  if (!subWin || subWin.isDestroyed()) return;
  try { subWin.webContents.send("sub:cfg", subCfg()); } catch { /* 窗口正在销毁 */ }
}

/* ══════════ 实时字幕：SSE 长连接（原为 900ms 轮询 /lines） ══════════
 * 为什么换：字幕是"来了就显示"的场景，轮询绝大多数请求是空跑，而且延迟最多
 * 有一个轮询周期。改成读服务端的 /events SSE 流后，有句子才收包，延迟接近实时。
 *
 * 实现要点：
 *   · fetch + ReadableStream 手工解析 SSE 帧（以空行分隔，":" 开头是心跳注释）
 *   · 断线自动重连，退避 1s → 2s → 4s，封顶 8s；服务没起时安静重试，不刷错误
 *   · stop 时 abort；窗口关掉/隐藏时也停，不白占一条连接
 */
const SUB_SSE_URL = () => `http://127.0.0.1:${SUBTITLE_RT_PORT}/events`;
let subStream = null;      // { ctrl, reader, timer, stopped, backoff }

function stopSubtitleStream() {
  const s = subStream;
  subStream = null;
  if (!s) return;
  s.stopped = true;
  clearTimeout(s.timer);
  try { s.ctrl && s.ctrl.abort(); } catch {}
  // reader 不主动 cancel：abort 会让底层读取以错误结束，由下面的 catch 收尾
}

function subSend(items, partial) {
  if (!subWin || subWin.isDestroyed() || !subWin.isVisible()) return;
  try {
    subWin.webContents.send("subtitle-lines", items || [], partial || "");
  } catch { /* 窗口正在销毁 */ }
}

async function pumpSubtitleStream() {
  const s = subStream;
  if (!s || s.stopped) return;
  const dec = new TextDecoder();
  let buf = "";
  try {
    const res = await fetch(SUB_SSE_URL(), {
      signal: s.ctrl.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    s.backoff = 1000;                       // 连上了就把退避重置
    const reader = res.body.getReader();
    s.reader = reader;
    for (;;) {
      const { value, done } = await reader.read();
      if (done || s.stopped) break;
      buf += dec.decode(value, { stream: true });
      // SSE 帧以空行分隔；一次 read 可能含多帧或半帧，都要缓冲着切
      let sep;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const dataLines = frame.split("\n").filter((l) => l.startsWith("data:"));
        if (!dataLines.length) continue;     // 纯注释帧（心跳）
        try {
          const d = JSON.parse(dataLines.map((l) => l.slice(5).trim()).join("\n"));
          subSend(d.items, d.partial);
        } catch { /* 半包/坏包，丢掉等下一帧 */ }
      }
    }
  } catch (e) {
    if (s.stopped || (e && e.name === "AbortError")) return;
    // 服务没起 / 连接被断：安静重试，不往界面抛错误
  }
  if (s.stopped) return;
  s.timer = setTimeout(pumpSubtitleStream, s.backoff);
  s.backoff = Math.min(s.backoff * 2, 8000);
}

function startSubtitleStream() {
  stopSubtitleStream();
  subStream = {
    ctrl: new AbortController(), reader: null, timer: null,
    stopped: false, backoff: 1000,
  };
  pumpSubtitleStream();
}

safeHandle("subtitle-show", async () => {
  if (!subWin || subWin.isDestroyed()) createSubtitleWin();
  if (!subWin.isVisible()) subWin.showInactive();
  startSubtitleStream();
  return true;
}, true);
safeHandle("subtitle-hide", async () => {
  stopSubtitleStream();
  if (subWin && !subWin.isDestroyed() && subWin.isVisible()) subWin.hide();
  return true;
}, true);

/* ---------------- 观察边框 ---------------- */

function psEncoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

const PS_FOREGROUND = `
Add-Type -Namespace W -Name U -MemberDefinition @"
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@
$h = [W.U]::GetForegroundWindow()
$r = New-Object W.U+RECT
[void][W.U]::GetWindowRect($h, [ref]$r)
Write-Output ("{0},{1},{2},{3}" -f $r.Left, $r.Top, $r.Right, $r.Bottom)
`;

/**
 * 回退路径：PowerShell。
 * 保留它是硬要求 —— 原生模块一旦缺失/崩溃，观察边框不能跟着一起失效。
 * 正因为 powershell.exe 是 DPI-unaware 的，GetWindowRect 返回的是逻辑坐标，
 * 可以直接喂给 setBounds；原生模块也照这个语义实现（见 orb-foreground.c 顶部注释）。
 */
function psForegroundRect() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", psEncoded(PS_FOREGROUND)],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout).trim().match(/(-?\d+),(-?\d+),(-?\d+),(-?\d+)/);
        if (!m) return resolve(null);
        resolve({ left: +m[1], top: +m[2], right: +m[3], bottom: +m[4], source: "ps" });
      }
    );
  });
}

/* ══════════ 前台窗口探针：常驻原生进程（主路径） ══════════
 *
 * 为什么换成原生：powershell 路径每次都要 spawn 一个 powershell.exe 并
 * 现场 Add-Type 编译 P/Invoke，**实测 1.38 秒/次**（见 PERF 报告），
 * 而观察边框的刷新周期是 500ms —— 也就是每个周期都在烧一个核，
 * 上一次还没回来下一次又出发（并发闸只是不让它们叠加，开销并不会消失）。
 *
 * 换成 native/dist/orb-foreground.exe 之后：
 *   · 整个进程生命周期只 spawn 一次，之后走 stdin/stdout 行协议
 *   · **实测 0.2 ms/次**，约 6900 倍提速，且完全不再创建进程
 *
 * 回退是硬要求，以下任一情况都会自动退回 PowerShell，功能不中断：
 *   ① exe 不存在　② spawn 报 error　③ 进程启动后没在 1.5s 内就绪
 *   ④ 单次请求 2s 无应答　⑤ 进程崩溃（自动重启，超过 3 次则永久退回并在日志写明）
 */
const ORB_FOREGROUND = process.env.ORB_FOREGROUND_EXE
  || path.join(__dirname, "..", "native", "dist", "orb-foreground.exe");
const FG_READY_MS = 1500;      // 启动后等就绪的上限
const FG_REQ_MS = 2000;        // 单次 fg 请求无应答即判超时
const FG_MAX_RESTARTS = 3;     // 连续崩溃重启上限，超了就永久走 PowerShell

let fgProc = null;
let fgReady = false;
let fgBroken = false;          // true = 永久退回 PowerShell（避免反复徒劳地重启）
let fgRestarts = 0;
let fgBuf = "";
let fgPending = null;          // 当前在途请求 { settle }
let fgSpawnAt = 0;             // 本次进程启动时刻，用来算"就绪宽限期"

/** 进程没了：清干净状态，并把在途请求结算掉（绝不能让调用方挂着） */
function fgDrop() {
  const p = fgPending;
  fgPending = null;
  fgProc = null;
  fgReady = false;
  fgBuf = "";
  if (p) p.settle(null);
}

/** 从 stdout 缓冲里切出完整的行并分派 */
function fgDrain() {
  let i;
  while ((i = fgBuf.indexOf("\n")) >= 0) {
    const line = fgBuf.slice(0, i).trim();
    fgBuf = fgBuf.slice(i + 1);
    if (!line) continue;
    let j = null;
    try { j = JSON.parse(line); } catch { continue; }   // 半行/杂行直接丢
    if (j && j.ready) { fgReady = true; continue; }
    if (fgPending) { const p = fgPending; fgPending = null; p.settle(j); }
  }
}

/** 确保常驻进程在跑。返回 false 表示"本路径不可用，调用方请走 PowerShell" */
function fgEnsure() {
  if (fgBroken) return false;
  if (fgProc) return true;
  if (!fs.existsSync(ORB_FOREGROUND)) {
    fgBroken = true;
    log("[fg] 原生探针不存在，永久走 PowerShell 回退：", ORB_FOREGROUND);
    return false;
  }
  try {
    fgProc = spawn(ORB_FOREGROUND, ["--serve"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
  } catch (e) {
    fgBroken = true;
    log("[fg] 原生探针启动失败，永久走 PowerShell 回退：", (e && e.message) || String(e));
    return false;
  }
  fgReady = false;
  fgBuf = "";
  try { fgProc.stdout.setEncoding("utf8"); } catch {}
  fgProc.stdout.on("data", (c) => { fgBuf += c; fgDrain(); });
  fgProc.stderr.on("data", (d) => log("[fg:err]", String(d).trim()));
  fgProc.on("error", (e) => { log("[fg] 进程异常：", (e && e.message) || String(e)); fgDrop(); });
  fgProc.on("exit", (code) => {
    log("[fg] 进程退出 code =", code);
    fgDrop();
    if (fgRestarts < FG_MAX_RESTARTS) {
      fgRestarts++;
      log("[fg] 自动重启（第", fgRestarts, "/", FG_MAX_RESTARTS, "次）");
      fgEnsure();
    } else {
      fgBroken = true;
      log("[fg] 连续崩溃超过", FG_MAX_RESTARTS, "次，永久走 PowerShell 回退（观察边框功能不受影响）");
    }
  });
  return true;
}

/** 走原生进程查一次前台窗口；拿不到就给 null，由调用方去回退 */
function nativeForegroundRect() {
  return new Promise((resolve) => {
    if (!fgEnsure() || !fgReady) return resolve(null);
    // 上一请求若还挂着（对端卡住），直接判掉，避免 Promise 永久悬着
    if (fgPending) { const p = fgPending; fgPending = null; p.settle(null); }
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (fgPending && fgPending.settle === settle) fgPending = null;
      resolve(v);
    };
    const timer = setTimeout(() => settle(null), FG_REQ_MS);
    fgPending = { settle };
    try { fgProc.stdin.write('{"cmd":"fg"}\n'); } catch (e) { settle(null); }
  });
}

/** 对外唯一入口：原生优先，失败自动回退 PowerShell */
async function foregroundRect() {
  const n = await nativeForegroundRect();
  if (n && n.ok && Array.isArray(n.rect) && n.rect.length === 4) {
    return {
      left: n.rect[0], top: n.rect[1], right: n.rect[2], bottom: n.rect[3],
      source: "native", exe: n.exe, pid: n.pid,
    };
  }
  return psForegroundRect();
}

/** 退出时收掉常驻进程：先礼貌 quit，来不及就 kill（will-quit 里会兜底） */
function fgStop() {
  if (!fgProc) return;
  try {
    fgProc.stdin.write('{"cmd":"quit"}\n');
    fgProc.stdin.end();
  } catch {}
  const p = fgProc;
  fgProc = null;
  setTimeout(() => { try { p && p.kill(); } catch {} }, 800);
}

/**
 * 控制台类窗口：终端里 Ctrl+C 会「中断当前进程」，划词的 Ctrl+C 降级必须避开。
 * 类名由常驻的划词监听进程随事件一并带出（ev.cls），无需再另起 PowerShell（那要 2~3 秒）。
 */
const CONSOLE_CLASSES = [
  "ConsoleWindowClass",              // 传统 conhost：cmd / powershell
  "CASCADIA_HOSTING_WINDOW_CLASS",   // Windows Terminal
  "mintty",                          // Git Bash / MSYS2
  "PseudoConsoleWindow",
];
function isConsoleClass(cls) {
  const c = String(cls || "");
  return CONSOLE_CLASSES.some((x) => c === x || c.startsWith(x));
}

function createBorder() {
  borderWin = new BrowserWindow({
    width: 300, height: 200, show: false, frame: false, transparent: true,
    resizable: false, movable: false, focusable: false, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#00000000",
    webPreferences: { contextIsolation: true },
  });
  borderWin.loadFile(path.join(__dirname, "border.html"));
  borderWin.setAlwaysOnTop(true, "screen-saver");
  borderWin.setIgnoreMouseEvents(true, { forward: true });
  borderWin.on("closed", () => { borderWin = null; });
  log("[border] window created");
}

async function updateBorder() {
  if (!borderWin || borderWin.isDestroyed()) return;
  const target = lastForeign;
  if (!target || target.right - target.left < 80 || target.bottom - target.top < 60) {
    if (borderWin.isVisible()) log("[border] hide — 无目标");
    borderWin.hide();
    return;
  }
  // PowerShell 进程是 DPI-unaware 的，GetWindowRect 返回的已是逻辑坐标，
  // 与 Electron 的 DIP 同一坐标系，不要再除 scaleFactor。
  let box = {
    x: Math.round(target.left) - 3,
    y: Math.round(target.top) - 3,
    width: Math.round(target.right - target.left) + 6,
    height: Math.round(target.bottom - target.top) + 6,
  };

  // 最大化窗口的矩形会超出屏幕，直接画会被裁掉 —— 夹进屏幕范围里，
  // 这样边框至少能贴着屏幕边缘显示出来。
  const d = screen.getDisplayNearestPoint({
    x: Math.round((box.x + box.width / 2)),
    y: Math.round((box.y + box.height / 2)),
  });
  const db = d.bounds;
  const right = Math.min(box.x + box.width, db.x + db.width);
  const bottom = Math.min(box.y + box.height, db.y + db.height);
  box = {
    x: Math.max(box.x, db.x),
    y: Math.max(box.y, db.y),
    width: Math.max(40, right - Math.max(box.x, db.x)),
    height: Math.max(40, bottom - Math.max(box.y, db.y)),
  };
  borderWin.setBounds(box);
  if (!borderWin.isVisible()) {
    borderWin.showInactive();
    log("[border] show", JSON.stringify(box));
  }
}

/* 追踪「用户真正在用的那个窗口」。
   点我们自己的面板会让焦点变成面板，所以不能只看当前前景窗口，
   必须记住最近一个不属于我们的前景窗口。
   只在用户开始接触悬浮球/面板时开启，避免持续空转 PowerShell。 */
let tracker = null;
let lastForeign = null;

function isOurs(rect) {
  const mine = [ball, panel, toolbar, borderWin]
    .filter((w) => w && !w.isDestroyed())
    .map((w) => w.getBounds());
  return mine.some((m) =>
    Math.abs(m.x - rect.left) < 12 &&
    Math.abs(m.y - rect.top) < 12 &&
    Math.abs(m.width - (rect.right - rect.left)) < 24);
}

/* foregroundRect 是一次 PowerShell（Add-Type 编译 + 启动）通常要 1~3 秒，
   而 startTrack 的周期是 500~1000ms。没有并发闸的话会叠出一串 PowerShell 进程，
   机器越用越卡，且后面的结果还可能比前面的旧。 */
let pollingForeground = false;
async function pollForeground() {
  if (pollingForeground) return;
  pollingForeground = true;
  try {
    const rect = await foregroundRect();
    if (!rect) return;
    if (isOurs(rect)) return;
    lastForeign = rect;
  } finally {
    pollingForeground = false;
  }
}

/* observing === 0 时根本不需要追前台窗口：观察边框只在执行动作时才用，
   而边框窗口此时是隐藏的。面板开着、鼠标划过就白追一次，纯浪费
   （早年每次追都要起一个 PowerShell；现在换了原生探针虽然单次只要 0.2ms，
   但没边框可画时连这次都不该发生）。 */
function startTrack() {
  if (observing <= 0) return;
  if (tracker || !state.border) return;
  pollForeground();
  const period = observing > 0 ? 500 : 1000;
  tracker = setInterval(pollForeground, period);
}

function stopTrack() {
  if (observing > 0) return;
  clearInterval(tracker);
  tracker = null;
}

function startObserve() {
  if (!state.border) return;
  observing += 1;
  if (observing > 1) return;
  if (!borderWin) createBorder();
  clearInterval(tracker);
  tracker = null;
  startTrack();
  updateBorder();
  // 800ms：边框只是描出目标窗口的位置，500ms 看不出跟手差别
  borderTimer = setInterval(updateBorder, 800);
}

function stopObserve() {
  observing = Math.max(0, observing - 1);
  if (observing > 0) return;
  clearInterval(borderTimer);
  borderTimer = null;
  if (borderWin && !borderWin.isDestroyed()) borderWin.hide();
  stopTrack();
}

/** 强制撤下观察态（用户把「操作时显示观察边框」关掉时用）。
 *  不走计数：面板那边可能还停在"观察中"，这里一律归零，
 *  否则 500ms 的 updateBorder 与 PowerShell 追踪会一直空转下去。 */
function stopObserveAll() {
  observing = 0;
  clearInterval(borderTimer);
  borderTimer = null;
  if (borderWin && !borderWin.isDestroyed()) borderWin.hide();
  stopTrack();
}

/* ---------------- 头像 ---------------- */

function avatarDataUrl() {
  if (!state.avatar) return null;
  try {
    const buf = fs.readFileSync(state.avatar);
    const ext = path.extname(state.avatar).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

async function pickAvatar() {
  const r = await dialog.showOpenDialog({
    title: "选择悬浮球头像",
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths.length) return;
  const src = r.filePaths[0];
  let size = 0;
  try { size = fs.statSync(src).size; } catch { return; }
  if (size > AVATAR_MAX) {
    sendToPanel("notice", `图片 ${(size / 1024 / 1024).toFixed(1)}MB，超过 2MB 上限。`);
    openPanel();
    return;
  }
  const ext = path.extname(src).toLowerCase();
  const dest = path.join(app.getPath("userData"), "avatar" + ext);
  try {
    fs.copyFileSync(src, dest);
  } catch (e) {
    sendToPanel("notice", "头像保存失败：" + e.message);
    return;
  }
  saveState({ avatar: dest });
  const url = avatarDataUrl();
  sendToBall("avatar", url);
  sendToPanel("avatar", url);
  sendToPanel("notice", "头像已更换。");
}

/* ---------------- 菜单 ---------------- */

/* ---------------- 自定义主题背景图（t4） ----------------
 * 与头像同一套路：系统对话框选图 → 拷进 userData → 路径落 state →
 * data URL 推给面板（面板只用它画背景，不碰文件系统）。
 * 上限比头像宽（4MB）：头像只有 32px，背景图要铺满整窗。 */
const THEME_IMG_MAX = 4 * 1024 * 1024;

function themeImageDataUrl() {
  if (!state.themeImage) return "";
  try {
    const buf = fs.readFileSync(state.themeImage);
    const ext = path.extname(state.themeImage).slice(1).toLowerCase();
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return "";
  }
}

async function pickThemeImage() {
  const r = await dialog.showOpenDialog({
    title: "选择主题背景图片",
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths.length) return { ok: true, url: themeImageDataUrl(), canceled: true };
  const src = r.filePaths[0];
  let size = 0;
  try { size = fs.statSync(src).size; } catch { return { ok: false, error: "读取图片失败" }; }
  if (size > THEME_IMG_MAX) {
    sendToPanel("notice", `图片 ${(size / 1024 / 1024).toFixed(1)}MB，超过 4MB 上限。`);
    openPanel();
    return { ok: false, error: "图片超过 4MB 上限" };
  }
  const ext = path.extname(src).toLowerCase();
  const dest = path.join(app.getPath("userData"), "theme-bg" + ext);
  try {
    fs.copyFileSync(src, dest);
  } catch (e) {
    return { ok: false, error: "保存失败：" + e.message };
  }
  saveState({ themeImage: dest });
  return { ok: true, url: themeImageDataUrl() };
}

function clearThemeImage() {
  const prev = state.themeImage;
  saveState({ themeImage: "" });
  if (prev) { try { fs.unlinkSync(prev); } catch { /* 文件不在了也无妨 */ } }
  return { ok: true };
}

/* ---------------- 菜单 ---------------- */

/* ---------------- 剪贴板可用性 ----------------
 * 用户反馈"填 API Key 时没法粘贴"。实测 Ctrl+V 本身是通的，问题出在：
 *   1) Electron 默认**没有右键菜单**——右键点输入框选"粘贴"什么都不会发生，
 *      很多人就是靠右键粘贴的，体感就是"粘贴用不了"；
 *   2) 面板未固定时鼠标一移开就自动折叠，用户去别处复制 key 时面板已经关了。
 * 这里把两条路都补齐，并显式建一份带编辑角色的应用菜单兜底快捷键。
 */

function buildEditMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "pasteAndMatchStyle", label: "粘贴为纯文本" },
        { role: "delete", label: "删除" },
        { type: "separator" },
        { role: "selectAll", label: "全选" },
      ],
    },
    { label: "窗口", submenu: [{ role: "minimize", label: "最小化" }, { role: "close", label: "关闭" }] },
  ]));
}

/** 给窗口挂上右键编辑菜单（输入框/选中文字时才有内容） */
function attachEditContextMenu(win) {
  win.webContents.on("context-menu", (_e, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { type: "separator" },
        { role: "selectAll", label: "全选" },
      );
    } else if (params.selectionText) {
      items.push({ role: "copy", label: "复制" }, { type: "separator" }, { role: "selectAll", label: "全选" });
    }
    if (!items.length) return;
    Menu.buildFromTemplate(items).popup({ window: win });
  });
}

function buildTray() {
  // 重建前必须先销毁旧托盘：否则每次调用都会多出一个图标，
  // 而旧图标的 JS 引用被覆盖后再也收不到事件 ——
  // 表现就是「状态栏出现两个图标，其中一个点了没反应」。
  if (tray && !tray.isDestroyed()) { tray.destroy(); tray = null; }
  const iconPath = path.join(__dirname, "icon.png");
  tray = new Tray(fs.existsSync(iconPath) ? iconPath : path.join(__dirname, "..", "icon.png"));
  tray.setToolTip("Orb 控制台");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开面板", click: () => openPanel() },
    { label: "划词自动弹出", type: "checkbox", checked: state.autoSelect,
      click: (i) => {
        saveState({ autoSelect: i.checked });
        if (i.checked) startSelectionWatch();
        else { stopSelectionWatch(); if (toolbar && !toolbar.isDestroyed()) toolbar.hide(); }
        buildTray();
      } },
    { type: "separator" },
    { label: "打开控制台页面", click: () => shell.openExternal(`http://127.0.0.1:${PORT}`) },
    { type: "separator" },
    { label: "退出 Orb", click: () => app.quit() },
  ]));
  tray.on("click", () => togglePanel());
}

function showContextMenu() {
  if (!ball) return;
  const menu = Menu.buildFromTemplate([
    { label: "打开面板", click: () => openPanel() },
    { label: "语音输入", click: () => {
        if (!panel || !panel.isVisible()) openPanel();
        sendToPanel("voice-start");
      } },
    { label: "固定面板", type: "checkbox", checked: state.pinned, click: (i) => {
        saveState({ pinned: i.checked });
        sendToPanel("pin-state", i.checked);
        if (!i.checked) scheduleClose(300);
      } },
    { type: "separator" },
    { label: "更换头像…", click: () => pickAvatar() },
    { label: "坐标编码", submenu: [
        { label: "像素", type: "radio", checked: state.coordMode === "pixel",
          click: () => { saveState({ coordMode: "pixel" }); sendToPanel("coord-mode", "pixel"); } },
        { label: "千分比 (0-1000)", type: "radio", checked: state.coordMode === "permille",
          click: () => { saveState({ coordMode: "permille" }); sendToPanel("coord-mode", "permille"); } },
      ] },
    { label: "操作时显示观察边框", type: "checkbox", checked: state.border,
      click: (i) => {
        saveState({ border: i.checked });
        sendToPanel("border-mode", i.checked);
        // 关掉就要真的停：否则已开着的 borderTimer / tracker 会继续空转
        if (!i.checked) stopObserveAll();
      } },
    { label: "划词自动弹出", type: "checkbox", checked: state.autoSelect,
      click: (i) => {
        saveState({ autoSelect: i.checked });
        if (i.checked) {
          startSelectionWatch();
        } else {
          stopSelectionWatch();
          if (toolbar && !toolbar.isDestroyed()) toolbar.hide();
        }
      } },
    { type: "separator" },
    { label: "其它应用也用 Ctrl+C 取词（已自动避开终端窗口）", type: "checkbox", checked: state.autoSelectClipboard,
      click: (i) => saveState({ autoSelectClipboard: i.checked }) },
    { label: "划词工具条 — 手动触发 (Ctrl+Alt+S)", click: () => showSelectionToolbar() },
    { label: "打开控制台页面", click: () => shell.openExternal(`http://127.0.0.1:${PORT}`) },
    { type: "separator" },
    { label: "退出 Orb", click: () => app.quit() },
  ]);
  menu.popup({ window: ball });
}

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(async () => {
  // 没抢到单实例锁的进程不建任何 UI（它马上会退出）。
  if (!gotSingleInstanceLock) return;
  loadState();
  /* 三个长期子目录要在任何读写之前就位。
   * 放在 loadState() 之后是有讲究的：storage 要按 state.storageRoot 算路径，
   * 早一步的话就只能看到默认值，历史又会写回老位置去。 */
  try {
    const sd = storage.ensureSubdirs();
    if (!sd.ok) log("[storage] 子目录建立失败:", sd.error);
    purgeStaleParts();
  } catch (e) {
    log("[storage] 初始化异常:", (e && e.message) || String(e));
  }
  // 是否首次运行：以「首跑向导有没有看完」为准。同样的语义 main 这边只算一次，
  // 后面 get-state 直接把这个结果发给渲染层，不做二次推断。
  state.firstRun = !state.envWizardDone;
  logPath = path.join(app.getPath("userData"), "orb.log");
  log("[app] 启动，日志:", logPath);

  /* ---------------- 麦克风权限 ----------------
   * 语音输入需要音频采集权限。我们的窗口都是本地 file:// 页面，
   * 没有这一行，getUserMedia / Web Speech API 的权限请求会被直接拒绝，
   * 麦克风按钮点了也没反应。统一放行媒体权限即可。
   */
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      if (permission === "media" || permission === "microphone" || permission === "geolocation") {
        return callback(true);
      }
      return callback(false);
    });
  } catch (e) {
    log("[app] 设置麦克风权限处理器失败:", e.message);
  }

  const alive = await waitForBridge(1);
  if (!alive) {
    bridgeProc = spawn(NODE_EXE, [BRIDGE], {
      stdio: ["ignore", "pipe", "pipe"],
      /* ELECTRON_RUN_AS_NODE=1：打包态 NODE_EXE 就是本应用的 electron.exe，
         这个变量让它退化成纯 Node 来跑 bridge.mjs；开发态是真正的 node.exe，忽略该变量。
         ORB_DATA_DIR：让桥和面板共用同一处数据目录（打包态 = %APPDATA%/ORB 控制台），
         否则桥会写进包内、面板从 APPDATA 读，两边分叉。 */
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: "1",
        ORB_DATA_DIR: DATA_ROOT,
      }),
    });
    bridgeProc.stdout.on("data", (d) => log("[bridge]", String(d).trim()));
    bridgeProc.stderr.on("data", (d) => log("[bridge:err]", String(d).trim()));
    /* 必须有 error 监听：spawn 失败（NODE_EXE / bridge.mjs 不在）时 Node 会抛
       'error' 事件，无人监听就升级成未捕获异常。加上之后至少能落日志、告诉用户。 */
    bridgeProc.on("error", (e) => {
      log("[bridge] 启动失败：", (e && e.message) || String(e));
      pushNotice(`本地桥接服务启动失败（${(e && e.code) || "spawn error"}）：${(e && e.message) || e}。控制台功能暂不可用，请看 .orbdata/orb.log。`);
    });
    /* 桥退出 = ORB 所有能力一起失效。用户已明确不要自动重启，
       所以必须让用户**知道**，不能静默失效成一个"看起来还活着"的控制台。
       去重：退出时会先收到一次 quit 指令的响应，只提示一次。 */
    let bridgeDeathNoticed = false;
    bridgeProc.on("exit", (code) => {
      log("[bridge] 退出，code =", code);
      if (bridgeDeathNoticed) return;
      bridgeDeathNoticed = true;
      pushNotice(
        `本地桥接服务已断开（退出码 ${code}），ORB 的全部功能暂时失效。请重启 ORB 控制台恢复；详情见 .orbdata/orb.log。`
      );
    });
    const up = await waitForBridge(60);
    if (!up) {
      log("[bridge] 端口始终未通");
      pushNotice(`本地桥接服务没有起来（端口 ${PORT} 无响应）。请检查 ${BRIDGE} 是否可用，详情见 .orbdata/orb.log。`);
    }
  }
  bridgeToken = await readBridgeToken();
  log("[bridge] 已获取访问令牌:", bridgeToken ? "是" : "否（接口会拒绝请求）");

  buildTray();
  createBall();
  createPanel();
  buildEditMenu();
  attachEditContextMenu(ball);
  attachEditContextMenu(panel);

  if (state.docked) dock(state.docked);
  sendToBall("avatar", avatarDataUrl());
  startSelectionWatch();

  // 触发器里的「热键」类型：globalShortcut 只能在这里注册（bridge 没有这个 API）
  armHotkeyTriggers();

  /* 快捷键从配置读（原来全硬编码，跟别的软件冲突就没法改） */
  const hk = loadHotkeys();
  const reg = (acc, fn) => { if (!acc) return false; try { return globalShortcut.register(acc, fn); } catch { return false; } };

  reg(hk.panel, () => togglePanel());
  reg(hk.selection, () => showSelectionToolbar());
  reg(hk.clipboard, async () => {
    const text = clipboard.readText();
    if (panel && panel.isVisible()) sendToPanel("prefill", text);
    else { prefillQueue.push(text); openPanel(); }
  });

  /* 急停热键：自动化跑飞时随手能按到的那一下。
     只绑「停」——恢复必须在面板里手动点，否则误触一下就恢复等于没停。 */
  const stopNow = () => {
    const token = bridgeTokenSync();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Orb-Token"] = token;
    fetch(`http://127.0.0.1:${PORT}/api/stop`, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "stop", reason: "热键急停" }),
    }).catch(() => {});
    try { openPanel(); } catch {}          // 把面板亮出来，让用户看到急停状态
  };
  reg(hk.stop, stopNow);
  if (hk.stop2) reg(hk.stop2, stopNow);

  /* 录制打点热键（默认 F9）：把"当前鼠标位置点一下"记进正在录制的工作流。
     全局鼠标钩子需要原生模块（SetWindowsHookEx / uiohook），本机 csc 被安全策略拦、
     npm 也拉不到包，所以改用这条"用户主动打点"的路子 —— 反而更可控，
     不会把误触和无关点击也录进去。录制没开时按了不做任何事。 */
  reg(hk.recordMark, () => sendToPanel("record-mark", Date.now()));
});

/* ---------------- 热键触发器 ----------------
 * 读 <控制台>/triggers.json 中 type=hotkey 的条目，按键触发时调 bridge 回放工作流。
 * 注册失败（热键被别的软件占用）只告警，不影响其它触发器。
 */
const TRIGGER_FILE = path.join(DATA_ROOT, "triggers.json");
let hotkeyRegistered = [];

/* ---------------- 快捷键配置 ----------------
 * 原来全是硬编码，跟输入法/别的软件冲突就没法改。
 * 读 <控制台>/hotkeys.json，缺项用默认值补齐。
 * **急停键有保底**：即使配置里被清空也回落到默认 —— "停不下来"才是真危险。
 */
const HOTKEY_FILE = path.join(DATA_ROOT, "hotkeys.json");
const HOTKEY_DEFAULTS = {
  panel: "Control+Space",
  selection: "Control+Alt+S",
  clipboard: "Control+Alt+G",
  stop: "Control+Alt+Backspace",
  stop2: "Control+Alt+E",
  // 录制打点：鼠标停在目标上按一下，就把"当前坐标点一次"记进工作流。
  // 用它来补上"手动鼠标操作录不进去"这个缺口（全局鼠标钩子需要原生模块，本机不可用）。
  recordMark: "F9",
};

function loadHotkeys() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(HOTKEY_FILE, "utf8")) || {}; } catch { cfg = {}; }
  const out = Object.assign({}, HOTKEY_DEFAULTS, cfg);
  if (!out.stop) out.stop = HOTKEY_DEFAULTS.stop;   // 急停保底
  return out;
}

function bridgeTokenSync() {
  try {
    // 必须走 TOKEN_FILE（认 ORB_TOKEN_FILE），不能在这里再拼一次路径 ——
    // 两处判定一旦分叉，桥换令牌后这里读到的就是旧文件。
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).token || "";
  } catch { return ""; }
}

function armHotkeyTriggers() {
  for (const acc of hotkeyRegistered) { try { globalShortcut.unregister(acc); } catch {} }
  hotkeyRegistered = [];

  let list = [];
  try { list = JSON.parse(fs.readFileSync(TRIGGER_FILE, "utf8")) || []; } catch { list = []; }

  for (const t of list) {
    if (t.type !== "hotkey" || t.enabled === false || !t.accelerator) continue;
    try {
      const ok = globalShortcut.register(t.accelerator, () => {
        const token = bridgeTokenSync();
        const headers = { "Content-Type": "application/json" };
        if (token) headers["X-Orb-Token"] = token;
        fetch(`http://127.0.0.1:${PORT}/api/wf`, {
          method: "POST",
          headers,
          body: JSON.stringify({ action: "play", name: t.workflow }),
        }).catch(() => {});
      });
      if (ok) hotkeyRegistered.push(t.accelerator);
      else console.warn("[trigger] 热键被占用，跳过：", t.accelerator);
    } catch (err) {
      console.warn("[trigger] 热键注册失败", t.accelerator, err && err.message);
    }
  }
  console.log("[trigger] 热键已注册:", hotkeyRegistered.join(", ") || "无");
}

/**
 * 优雅停桥。
 * Windows 上 child.kill() 走的是 TerminateProcess —— 桥进程被瞬间抹掉，
 * 它自己拉起来的 MCP server / CodeBuddy CLI / ASR / 实时字幕一个都收不掉，
 * 全留在系统里变成孤儿（"用久了电脑就卡"主要就是这一批）。
 * 所以先请桥自己收尾，留一点时间，再兜底强杀。
 */
function stopBridge() {
  return new Promise((resolve) => {
    if (!bridgeProc) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { bridgeProc && bridgeProc.kill(); } catch {}
      resolve();
    };
    const hardTimer = setTimeout(finish, 2500);          // 硬上限：绝不能把退出流程吊死
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 1200);
    fetch(`http://127.0.0.1:${PORT}/api/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orb-Token": bridgeTokenSync() || bridgeToken },
      body: "{}",
      signal: ctrl.signal,
    }).catch(() => {}).finally(() => {
      clearTimeout(abortTimer);
      // 给桥 800ms 收完子进程，再补一刀
      setTimeout(() => { clearTimeout(hardTimer); finish(); }, 800);
    });
  });
}

let bridgeStopping = false;
app.on("before-quit", (e) => {
  if (bridgeStopping || !bridgeProc) return;
  bridgeStopping = true;
  e.preventDefault();
  stopBridge().finally(() => app.quit());
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  /* 录制会话必须在这里收尾：面板崩溃或被强制关闭时，cap-close 永远不会被调用，
     句柄一直挂着会让 .part 文件删不掉，下次启动还会在磁盘上留一层垃圾。 */
  try {
    for (const id of Array.from(capSessions.keys())) capDrop(id, true);
  } catch { /* 退出路径上的清理不允许再抛 */ }
  /* 控制条用 destroy 而不是 close：退出时不需要走它的 unload/closed 流程，
     close 会等渲染进程回一次消息，白拖慢退出。 */
  try { if (recbarWin && !recbarWin.isDestroyed()) recbarWin.destroy(); } catch { /* ignore */ }
  recbarWin = null;
  clearInterval(borderTimer); borderTimer = null;
  stopSubtitleStream();
  clearInterval(tracker); tracker = null;
  clearTimeout(hoverOpenTimer); hoverOpenTimer = null;
  clearTimeout(closeTimer); closeTimer = null;
  stopDragTimer(); drag = null;
  stopSelectionWatch();
  try { bridgeProc && bridgeProc.kill(); } catch {}
});
app.on("window-all-closed", () => {});

/* ---------------- IPC ---------------- */

ipcMain.on("drag-begin", () => beginDrag());
ipcMain.on("drag-end", () => endDrag());
ipcMain.on("ball-click", () => onBallClick());
ipcMain.on("ball-context", () => showContextMenu());
ipcMain.on("hover", (_e, on) => {
  const fromBall = ball && _e.sender === ball.webContents;
  /* 只在状态**真的翻转**时才记日志。
     原来每次 mouseenter / mouseleave 都打一条 —— 鼠标扫过一下悬浮球
     就是两条日志，全是噪声。翻转时记一次已经足够排查。 */
  if ((fromBall ? ballHover : panelHover) !== !!on) log("[hover]", fromBall ? "ball" : "panel", on);
  if (fromBall) {
    ballHover = !!on;
  } else {
    panelHover = !!on;
  }
  if (on) {
    cancelClose();
    startTrack();
    if (ballHover && !panelHover && !(panel && panel.isVisible())) {
      clearTimeout(hoverOpenTimer);
      hoverOpenTimer = setTimeout(() => {
        if (ballHover && !(panel && panel.isVisible())) openPanel();
      }, 300);
    }
  } else {
    scheduleClose();
    if (!ballHover && !panelHover && !(panel && panel.isVisible())) stopTrack();
  }
});
ipcMain.on("undock", () => {
  if (Date.now() - lastDockAt < 600) return;
  undock();
});
ipcMain.on("hold", (_e, v) => {
  holdOpen = !!v;
  if (holdOpen) { cancelClose(); log("[panel] 进入保持状态（编辑设置中，不自动折叠）"); }
  else scheduleClose(400);
});
ipcMain.on("panel-open", () => openPanel());
ipcMain.on("panel-close", () => closePanel());
ipcMain.on("voice-start", () => {
  if (!panel || !panel.isVisible()) openPanel();
  sendToPanel("voice-start");
});
ipcMain.on("pin", (_e, v) => { saveState({ pinned: !!v }); if (!v) scheduleClose(300); });
ipcMain.on("busy", (_e, v) => sendToBall("busy", !!v));
ipcMain.on("observe", (_e, on) => (on ? startObserve() : stopObserve()));
ipcMain.on("open-external", (_e, url) => shell.openExternal(url));

/* 桌面模糊背景（磨砂玻璃）：渲染层按玻璃态申报要不要；主进程据此决定抓不抓。
   发送方 → 窗口 → glassbg 条目（每条各自记着回传通道，面板与录制条互不串图）。 */
ipcMain.on("glass-bg-want", (e, on) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) glassbg.want(win, !!on);
});
ipcMain.on("glass-bg-refresh", (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) glassbg.refreshNow(win);
});
/* 显示器热插拔 / 分辨率 / DPI 变更：模糊底图与桌面的对齐关系变了，全部重抓。
   ⚠️ 必须包在 whenReady 里：`screen` 模块在 app ready 之前**不可访问**，放在模块顶层
   会同步抛异常，导致它下面的所有 safeHandle 一个都注册不上 —— 面板 get-state 全废、
   按键全死、三条通道看起来"全部崩溃"（2026-10-22 实际踩过一次）。
   同理：以后任何在模块顶层碰 screen / BrowserWindow / 其它 ready-gated 模块的代码，
   一律要挪进 whenReady 回调。 */
app.whenReady().then(() => {
  screen.on("display-metrics-changed", () => glassbg.refreshAllWanted());
});

/* 使用说明：项目根目录下的「使用说明.md」。
   用 shell.openPath 走系统默认程序（一般是记事本/VSCode），
   比 openExternal 直接开浏览器更合适 —— .md 在浏览器里会变成下载。
   找不到文件时返回 false，让面板如实提示，而不是静默失败。 */
const GUIDE_NAME = "使用说明.md";
ensureBundledExtras();   // 随包附带文件释放（要等 GUIDE_NAME 声明之后才能调）
function guidePath() {
  // __dirname = <项目根>/orb/desktop，说明文件放在**项目根**，所以要往上两级。
  // （之前写成一级，指到了 orb/ 下面，所以「打开使用说明」一直报失败。）
  return path.join(DATA_ROOT, GUIDE_NAME);
}
safeHandle("open-guide", async () => {
  const p = guidePath();
  if (!fs.existsSync(p)) return false;
  const err = await shell.openPath(p);
  return !err;                      // openPath 成功返回空串，失败返回错误描述
}, false);
safeHandle("open-guide-dir", async () => {
  const p = guidePath();
  if (!fs.existsSync(p)) return false;
  shell.showItemInFolder(p);
  return true;
}, false);
/* 打开 CodeBuddy CLI 登录脚本。
 * 用户要求"设置里直达，不用去桌面找"。
 * 桌面上的 codebuddy-login.cmd 已移除（纯转发器，冗余），直接指向项目根那份真脚本。
 * 保留桌面版作为兜底（万一又被放回桌面也能用）。
 * 用 shell.openPath 而不是 openExternal：.cmd 是本地文件，openPath 直接
 * 交给系统默认处理器，且能拿到失败原因（返回空串=成功）。
 *
 * 打包态：上面两份都不存在（仓库根那份不在 APP_FILES 里，桌面那份是本机遗留），
 * 于是**运行时生成一份到 DATA_ROOT**（打包态 = %APPDATA%/ORB 控制台，可写）。
 * 为什么不把它塞进打包清单：脚本内容只调 `codebuddy`，不带任何本机路径，
 * 运行时生成既省一份随包文件，也保证发布包里不可能出现作者机器的私有目录。
 * 开发态不生成（DATA_ROOT 就是项目根，写进去会污染仓库工作区），未找到就返回 false。 */
safeHandle("open-cli-login", async () => {
  const root = path.resolve(__dirname, "..", "..");
  const cands = [
    path.join(root, "codebuddy-login.cmd"),
    path.join(require("os").homedir(), "Desktop", "codebuddy-login.cmd"),
  ];
  for (const p of cands) {
    if (!fs.existsSync(p)) continue;
    const err = await shell.openPath(p);
    return !err;
  }
  if (!app.isPackaged) return false;
  const gen = path.join(DATA_ROOT, "codebuddy-login.cmd");
  try {
    fs.writeFileSync(gen, [
      "@echo off",
      "chcp 65001 >nul",
      "title CodeBuddy CLI - 登录（ORB 后台 Agent）",
      "set \"SERVER__PORT=\"",
      "set \"CODEBUDDY_SERVICE_PROXY_URL=\"",
      "set \"ELECTRON_RUN_AS_NODE=\"",
      "echo 正在启动 CodeBuddy CLI 的交互式登录…",
      "echo 运行后按提示选择登录方式（国内站 / 国际站 / 企业域 / 腾讯 iOA），",
      "echo 浏览器会自动打开官方登录页完成认证；会话内输入 /login 可重登、/logout 退出。",
      "echo.",
      "echo 若提示「不是内部或外部命令」，说明还没装 CLI 或它不在 PATH 中：",
      "echo   1) 安装：npm install -g @tencent-ai/codebuddy-code  （需 Node.js 18.20+）",
      "echo      或 PowerShell 执行 irm https://www.codebuddy.cn/cli/install.ps1 ^| iex",
      "echo      文档：https://www.codebuddy.cn/docs/cli/quickstart",
      "echo   2) 或设置环境变量 ORB_WB_CLI 指向 codebuddy.exe",
      "echo.",
      "codebuddy",
      "echo.",
      "echo CLI 已退出（退出码 %ERRORLEVEL%）。",
      "echo 登录成功后回到 ORB，设置 → 通道 → 「重新检测」，再发一次后台任务即可。",
      "echo.",
      "pause",
      "",
    ].join("\r\n"), "utf8");
  } catch {
    return false;
  }
  const err = await shell.openPath(gen);
  return !err;
}, false);
// 面板改完触发器配置后，让主进程重新注册热键
ipcMain.on("trigger-reload", () => { try { armHotkeyTriggers(); } catch {} });
ipcMain.on("toolbar-hide", () => toolbar && toolbar.hide());
ipcMain.on("toolbar-action", (_e, action, text) => {
  if (toolbar) toolbar.hide();
  if (action === "search") {
    shell.openExternal("https://www.bing.com/search?q=" + encodeURIComponent(text));
    return;
  }
  const payload = action === "translate" ? `把下面这段翻译成中文，只给译文：\n${text}` : text;
  if (panel && panel.isVisible()) {
    sendToPanel("prefill", payload);
    sendToPanel("focus-route", action === "translate" ? "back" : "auto");
  } else {
    prefillQueue.push(payload);
    openPanel();
  }
});

/* ---------------- 会话历史落盘 ----------------
 * 需求：历史记录存到「控制台目录」下一级的独立文件夹，不再只躺在 localStorage 里。
 * 目录：<存储根>/history/conversations.json
 * 读写都做容错：目录不存在自动建，文件损坏/缺失一律回退空数组，绝不让面板因此打不开。
 */
/* 目录必须对**当前存储根**求值，而不是模块加载时算一次锁死：
 * ① 原来写死 DATA_ROOT/history，打包后指向只读的 app.asar 目录，写盘直接 EPERM，
 *    会话历史就永远只躺在 localStorage（「使用说明」当初踩过同一个坑）；
 * ② 用户在设置面板改了存储根之后，历史应该跟着新根走，
 *    写成模块级常量会导致整个进程生命周期里都用改之前算好的那个路径。 */
const historyFile = () => path.join(storage.pathOf("history"), "conversations.json");

safeHandle("history-load", () => {
  try {
    const raw = fs.readFileSync(historyFile(), "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];   // 首次运行 / 文件损坏都走这里
  }
}, []);

safeHandle("history-save", (_e, data) => {
  try {
    // 目录可能被用户手动删了，或者刚换过存储根 —— 每次写之前补建一次
    fs.mkdirSync(storage.pathOf("history"), { recursive: true });
    const arr = Array.isArray(data) ? data : [];
    /* 先写临时文件再 rename：直接 overwrite 时进程被杀会留下截断的 JSON，
       下次 load 解析失败 → 整个历史列表凭空消失。rename 在同一卷内是原子的。 */
    const file = historyFile();
    // 后缀统一用 .part：搬迁逻辑会跳过这种半成品文件
    const tmp = file + ".part";
    fs.writeFileSync(tmp, JSON.stringify(arr, null, 2), "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    // 落盘失败不能影响面板使用：localStorage 仍是保底
    try { log("[history] 保存失败:", (err && err.message) || String(err)); } catch {}
    return false;
  }
}, false);

/* ---------------- 长期文件的存储根目录 ----------------
 * 面板「设置 → 存储」用这一组通道。
 * 渲染层拿不到 fs / shell（contextIsolation + 白名单桥），所有路径解析、
 * 可写性探测、搬迁都在主进程做；面板只负责把用户选的目录递过来。
 */
safeHandle("storage-get", () => {
  const s = storage.stat();
  return {
    ok: s.ok,
    root: s.root,
    isDefault: s.isDefault,          // true = 用的是默认位置
    rootExists: s.rootExists,        // 移动硬盘拔了会让这里变 false
    free: s.free,
    total: s.total,
    dirs: s.dirs,                    // { recordings|history|screenshots: {path, exists, files, bytes} }
    prev: typeof state.storageRootPrev === "string" ? state.storageRootPrev : "",
    lastRecording: state.lastRecording || null,
    error: s.error || null,
  };
}, () => ({ ok: false, root: storage.resolveRoot(), dirs: {}, free: 0, total: 0, error: "存储信息读取失败（详见 .orbdata/orb.log）" }));

safeHandle("storage-pick", async () => {
  // 挂在面板窗口上（而不是任意弹一个系统窗口）：面板是置顶的无边框窗口，
  // 不指定父窗口时选择框可能被它盖住，用户会以为没反应。
  const win = panel && !panel.isDestroyed() ? panel : undefined;
  const r = await dialog.showOpenDialog(win, {
    title: "选择录屏与历史的存储目录",
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true, dir: "" };
  return { ok: true, canceled: false, dir: r.filePaths[0] };
}, () => ({ ok: false, canceled: true, dir: "" }));

safeHandle("storage-set", (_e, dir) => {
  /* 顺序：先改_STATE_再建子目录。反过来的话，万一新根不可用，
     旧 state 没动，但新根下已经被建出空目录，用户会看到一个半吊子结果。 */
  const r = storage.setRoot(dir);
  if (!r.ok) {
    return { ok: false, root: r.root, prev: r.prev, changed: false, needMigrate: false, error: r.reason || "设置失败" };
  }
  const sub = storage.ensureSubdirs();
  return {
    ok: true,
    root: r.root,
    prev: r.prev,
    changed: r.changed,
    needMigrate: r.needMigrate,     // 旧目录里有东西 → 面板据此提示"要不要搬过去"
    dirs: sub.dirs,
    error: sub.ok ? null : (sub.error || null),
  };
}, () => ({ ok: false, changed: false, needMigrate: false, error: "设置存储目录失败（详见 .orbdata/orb.log）" }));

safeHandle("storage-migrate", () => {
  const r = storage.migrate();
  return {
    ok: r.ok,
    from: r.from,
    to: r.to,
    moved: r.moved,
    skipped: r.skipped,
    bytes: r.bytes,
    errors: r.errors,
    note: r.note || null,
  };
}, () => ({ ok: false, moved: 0, skipped: 0, bytes: 0, errors: ["搬迁失败（详见 .orbdata/orb.log）"], note: null }));

safeHandle("storage-open", async (_e, kind) => storage.openSubdir(kind), () => ({ ok: false, path: null, error: "打开目录失败" }));

/* ---------------- Snipaste（截屏） ----------------
 * 三条通道都只做「一件具体的事」，不暴露 fs、不暴露通用 spawn：
 *   snip-detect     装没装 / 在不在跑（设置页状态行、首跑引导卡、聚焦重查都用它）
 *   snip-run        唤起框选；截图直落 <存储根>/screenshots，不回传图片字节
 *   snip-guide-done 首跑引导卡「知道了」落盘，同一台机器不再弹第二次
 * 唤起逻辑（两步式、-o 落盘）的依据写在 snipaste.js 顶部注释。 */
safeHandle("snip-detect", async () => {
  try { return await snipaste.detect(); }
  catch (e) { return { ok: false, installed: false, running: false, path: "", source: "" }; }
}, () => ({ ok: false, installed: false, running: false, path: "", source: "" }));

safeHandle("snip-run", async () => {
  try { return await snipaste.runSnip(); }
  catch (e) { return { ok: false, launched: false, file: "", reason: "exception: " + String((e && e.message) || e) }; }
}, () => ({ ok: false, launched: false, file: "", reason: "唤起失败（详见 .orbdata/orb.log）" }));

safeHandle("snip-guide-done", (_e, done) => {
  if (done === true) saveState({ snipGuideDone: true });
  return !!state.snipGuideDone;
}, false);

/* ---------------- 屏幕录制 ----------------
 * 分工是有硬约束的：getUserMedia / MediaRecorder 只能在渲染进程跑
 * （要页面级的桌面源授权，主进程拿不到 media stream），
 * 所以编码交给 panel.html；主进程负责它擅长的部分 ——
 * 开句柄、追加写、rename 收尾、补 MP4 时长。
 *
 * 分片经 IPC 传 ArrayBuffer 而不是 base64：后者要多出 1/3 体积，
 * 而且每片都要做一次字符串编解码，长录制时这部分开销是纯浪费。
 */
const CAP_MAX_SESSIONS = 3;               // 并行会话上限：多了说明有会话没被正常关闭
const CAP_STALE_MS = 2 * 60 * 60 * 1000;  // 超过 2 小时还没关的会话一律视为泄漏
const capSessions = new Map();            // sessionId -> { fd, file, bytes, chunks, startedAt, mime }

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 时间戳文件名：用户不输入名字时用它，按修改时间排序就是按录制先后排序。 */
function recStamp(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 同秒多次录制时不能互相覆盖 —— 宁可加序号，也不能让用户找不到一分钟前录的东西。 */
function uniqueFile(dir, base, ext) {
  let name = base + ext;
  for (let i = 2; i <= 999; i++) {
    if (!fs.existsSync(path.join(dir, name))) break;
    name = `${base}-${i}${ext}`;
  }
  return path.join(dir, name);
}

/**
 * 按实际 mime 决定扩展名。
 * 这条是硬规则：**webm 绝不能存成 .mp4**。机器不支持 H.264 时 MediaRecorder
 * 会回落到 webm，文件名骗人只会让播放器报一堆莫名其妙的错。
 */
function recExt(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("webm")) return ".webm";
  if (m.includes("matroska") || m.includes("mkv")) return ".mkv";
  return ".bin";
}

/** IPC 传过来的可能是 ArrayBuffer / Uint8Array / Buffer，统一成 Buffer（复制一份，避免底层缓冲被复用）。 */
function toBuffer(data) {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (typeof data === "string") return Buffer.from(data, "base64");
  return Buffer.alloc(0);
}

/** 关句柄并（可选）删临时文件。任何一步失败都不能往外抛 —— 清理走的是"尽力而为"语义。 */
function capDrop(sessionId, removeTmp = true) {
  const s = capSessions.get(sessionId);
  if (!s) return { file: null, bytes: 0, removed: false };
  capSessions.delete(sessionId);
  try { if (typeof s.fd === "number") fs.closeSync(s.fd); } catch { /* 句柄可能已经失效 */ }
  let removed = false;
  if (removeTmp && s.file) {
    try { if (fs.existsSync(s.file)) { fs.unlinkSync(s.file); removed = true; } } catch { /* 删不掉：至少句柄关了 */ }
  }
  return { file: s.file, bytes: s.bytes, removed };
}

/** 超过 2 小时还开着的会话，八成是渲染层崩过。趁下次开录把它们收掉，别占着句柄和磁盘。 */
function capSweepStale(now = Date.now()) {
  for (const [id, s] of Array.from(capSessions.entries())) {
    if (now - (s.startedAt || now) < CAP_STALE_MS) continue;
    log("[cap] 清理超时会话:", id);
    capDrop(id, true);
  }
}

/** 崩溃残留的 .part 文件不会被任何会话认领，启动时顺手清掉超过一天的。 */
function purgeStaleParts() {
  const dir = storage.pathOf("tmp");
  const deadline = Date.now() - 24 * 60 * 60 * 1000;
  try {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".part")) continue;
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).mtimeMs < deadline) fs.unlinkSync(full);
      } catch { /* 正在被占用就下次再说 */ }
    }
  } catch { /* 临时目录读不了不影响启动 */ }
}

safeHandle("cap-sources", async () => {
  /* types 必须显式给：不带 types 时 Electron 会连音频源一起枚举，
     屏幕/窗口列表里混进一堆看不见的东西，面板展示会很乱。 */
  const srcs = await desktopCapturer.getSources({ types: ["screen", "window"] });
  return {
    ok: true,
    sources: srcs.map((s) => ({
      id: s.id,
      name: s.name,
      displayId: s.display_id,
      // 面板要按类型分流展示（屏幕 / 窗口），id 前缀是最可靠的判据
      kind: String(s.id || "").startsWith("window:") ? "window" : "screen",
    })),
  };
}, () => ({ ok: false, sources: [], error: "获取屏幕源失败（详见 .orbdata/orb.log）" }));

safeHandle("cap-open", (_e, opts) => {
  const o = opts && typeof opts === "object" ? opts : {};
  capSweepStale();
  // 已达上限：宁可明确失败，也不要让多个未关闭的会话静默堆积磁盘写入
  if (capSessions.size >= CAP_MAX_SESSIONS) {
    return { ok: false, sessionId: "", error: `同时进行的录制不能超过 ${CAP_MAX_SESSIONS} 个` };
  }
  const dir = storage.pathOf("tmp");
  const id = `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, sessionId: "", error: "临时目录不可用：" + ((e && e.message) || String(e)) };
  }
  let fd = -1;
  const file = path.join(dir, `${id}.part`);
  try {
    fd = fs.openSync(file, "w");
  } catch (e) {
    return { ok: false, sessionId: "", error: "创建临时文件失败：" + ((e && e.message) || String(e)) };
  }
  capSessions.set(id, {
    fd,
    file,
    bytes: 0,
    chunks: 0,
    startedAt: Date.now(),
    mime: typeof o.mime === "string" ? o.mime : "",
    sourceId: typeof o.sourceId === "string" ? o.sourceId : "",
  });
  log("[cap] 开始录制:", id, "mime =", String(o.mime || "").slice(0, 64));
  return { ok: true, sessionId: id, file, mime: o.mime || "" };
}, () => ({ ok: false, sessionId: "", error: "开始录制失败（详见 .orbdata/orb.log）" }));

safeHandle("cap-chunk", (_e, sessionId, data) => {
  const s = capSessions.get(sessionId);
  if (!s) return { ok: false, bytes: 0, chunks: 0, error: "录制会话不存在或已结束" };
  const buf = toBuffer(data);
  if (!buf.length) return { ok: false, bytes: s.bytes, chunks: s.chunks, error: "分片为空" };
  try {
    let written = 0;
    // writeSync 允许部分写入（磁盘满、信号中断都会），必须循环补齐，
    // 否则一个分片少几个字节，整个 MP4 的 box 长度就全部错位了。
    while (written < buf.length) {
      written += fs.writeSync(s.fd, buf, written, buf.length - written, null);
    }
    s.bytes += written;
    s.chunks += 1;
    return { ok: true, bytes: s.bytes, chunks: s.chunks, received: written };
  } catch (e) {
    return { ok: false, bytes: s.bytes, chunks: s.chunks, error: "写入失败：" + ((e && e.message) || String(e)) };
  }
}, () => ({ ok: false, bytes: 0, chunks: 0, error: "分片写入失败（详见 .orbdata/orb.log）" }));

safeHandle("cap-close", (_e, sessionId, opts) => {
  const s = capSessions.get(sessionId);
  if (!s) return { ok: false, path: "", error: "录制会话不存在或已结束" };
  const o = opts && typeof opts === "object" ? opts : {};
  capSessions.delete(sessionId);
  let size = s.bytes;
  try { fs.closeSync(s.fd); } catch { /* 已经关了 */ }
  try { size = fs.statSync(s.file).size; } catch { /* 用内存里累计的值兜底 */ }

  // 空文件 / 只有几十字节 → 不是有效录制，直接丢掉，别在目录里留垃圾
  if (!size || size < 1024) {
    const dropped = capDrop(sessionId, true);
    log("[cap] 内容过短已丢弃:", sessionId, "bytes =", size);
    return { ok: false, path: "", bytes: size, error: "录制内容为空或过短，已丢弃" + (dropped.removed ? "" : "（临时文件清理失败）") };
  }

  const ms = Number.isFinite(Number(o.ms)) && Number(o.ms) > 0
    ? Number(o.ms)
    : Date.now() - s.startedAt;
  const ext = recExt(s.mime);
  const baseName = typeof o.name === "string" && o.name.trim() ? o.name.trim() : "录屏-" + recStamp();
  const dir = storage.pathOf("recordings");
  const target = uniqueFile(dir, baseName, ext);
  let viaCopy = false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    try {
      // 同一个存储根里（临时目录就在 recordings/.tmp 下），rename 是原子操作
      fs.renameSync(s.file, target);
    } catch (e) {
      // 跨卷 / 被杀软占用导致 rename 失败：退化成复制。慢一点，但内容不会丢。
      fs.copyFileSync(s.file, target);
      viaCopy = true;
      try { fs.unlinkSync(s.file); } catch { /* 删不掉就留给下次全量清理 */ }
    }
  } catch (e) {
    log("[cap] 落盘失败:", sessionId, (e && e.message) || String(e));
    return { ok: false, path: "", bytes: size, ms, error: "写入目标目录失败：" + ((e && e.message) || String(e)) };
  }

  const out = {
    ok: true,
    path: target,
    bytes: size,
    ms,
    mime: s.mime || "",
    ext,
    viaCopy,                         // true = rename 失败退回了复制；只影响速度，不影响可用性
    valid: false,
    durationMs: 0,
    patched: false,
    error: null,
  };
  /* 只有真正的 MP4 才走容器收尾：给 webm 文件跑 MP4 解析器毫无意义，
     反过来如果用户机器不支持 H.264 而回落了 webm，这里的 ext 也不会是 .mp4。 */
  if (ext === ".mp4") {
    try {
      const ins = mp4finalize.inspectFile(target);
      out.valid = !!ins.ok;
      if (!ins.ok) out.error = "MP4 结构不完整：" + (ins.error || "未知原因");
      if (ins.ok) {
        // MediaRecorder 中途停止时常常不写 mvhd.duration —— 缺了它，
        // 资源管理器/PotPlayer 会显示 0 秒、进度条拖不动。只在缺失时补。
        const patch = mp4finalize.patchDuration(target, ms);
        // patch 失败时它的 durationMs 是 0，自然回落到 inspect 读到的值
        out.durationMs = Number(patch.durationMs) || Number(ins.durationMs) || 0;
        out.patched = !!patch.patched;
      } else {
        out.durationMs = ins.durationMs || 0;
      }
    } catch (e) {
      // 收尾失败不影响文件本身：前面 rename 已经成功，用户可以自己在播放器里打开
      out.error = "MP4 收尾检查失败：" + ((e && e.message) || String(e));
    }
  } else {
    out.valid = true;   // 非 MP4 不做容器校验，交给将来的 webm 处理
  }

  saveState({ lastRecording: { path: target, bytes: size, ms, mime: s.mime || "" } });
  log("[cap] 录制完成:", target, size, "bytes /", ms, "ms");
  return out;
}, () => ({ ok: false, path: "", bytes: 0, ms: 0, error: "结束录制失败（详见 .orbdata/orb.log）" }));

safeHandle("cap-abort", (_e, sessionId) => {
  const s = capSessions.get(sessionId);
  if (!s) return { ok: true, removed: false, note: "会话不存在（可能已经结束）" };
  const dropped = capDrop(sessionId, true);
  log("[cap] 放弃录制:", sessionId);
  return { ok: true, removed: dropped.removed, note: dropped.removed ? "已删除临时文件" : "临时文件清理失败" };
}, () => ({ ok: false, removed: false, error: "放弃录制失败（详见 .orbdata/orb.log）" }));

/* ---------------- 悬浮录屏控制条的事件转发 ----------------
 * 三方协议（通道名已定死，任何一侧改名都会静默失效，改名前先打招呼）：
 *   面板 → 主 : rec-cmd-to-bar  { type: 'start' | 'pause' | 'resume' | 'stop' }
 *   控制条 → 主: rec-bar-cmd     'pause' | 'resume' | 'finish' | 'abort'
 *   主 → 面板 : rec:cmd         'pause' | 'resume' | 'finish' | 'abort'
 *   主 → 控制条: rec:event      { type: 'start' | 'pause' | 'resume' | 'stop' }
 * 注意方向不对称：面板说的是"我想要暂停/继续"，控制条回的是"用户点了完成"。
 * 语义不同名（pause/finish vs resume/abort）就是为了不让两边混淆。
 */

/* 面板 → 主进程 → 控制条 */
ipcMain.on("rec-cmd-to-bar", (_e, payload) => {
  const type = payload && payload.type;
  try {
    if (type === "start") {
      /* 懒创建 + 显示。先 showInactive 再 show：showInactive 不抢焦点，
         否则刚开始录制用户的键盘焦点就被从小软件上拽走了。
         之后再补一次 setAlwaysOnTop(true)：全屏应用会把普通置顶窗盖掉，
         录制全屏游戏/视频时控制条不能消失。 */
      const win = createRecBar();
      if (!win) return;
      emitRecEvent(payload);
      /* 偏好补推一次：窗口可能是上一轮录制建的（隐藏但没销毁），
         用户中途改过皮肤 / 描边 / 能量条开关，这里确保拿的是最新值。 */
      sendRecCfg();
      try {
        /* 每轮开始都把位置拉回屏幕顶端：控制条可拖拽，上一轮被拖到屏幕中间
           的话，这一轮不该继续留在那儿（用户报的就是"跑到屏幕中间去了"）。 */
        win.setBounds(recbarBounds());
        /* 穿透态必须复位：上一轮若停在收起态就被隐藏，ignore-mouse-events
           会一直挂着，这一轮一显示出来就点不动。 */
        resetRecbarInteractive(win);
        win.showInactive();
        win.show();
        win.setAlwaysOnTop(true);
      } catch (e) { log("[recbar] 显示失败:", (e && e.message) || String(e)); }
    } else if (type === "pause" || type === "resume") {
      // 控制条没建（理论上 start 之后一定在）就丢掉：事件没有意义
      if (!recbarWin || recbarWin.isDestroyed()) return;
      emitRecEvent(payload);
    } else if (type === "stop") {
      resetRecbarInteractive(recbarWin);
      try { if (recbarWin && !recbarWin.isDestroyed()) recbarWin.hide(); } catch { /* 已经没了 */ }
    } else {
      log("[recbar] 未知事件类型:", String(type));
    }
  } catch (e) {
    log("[recbar] 转发事件失败:", (e && e.message) || String(e));
  }
});

/* 控制条 → 主进程 → 面板 */
ipcMain.on("rec-bar-cmd", (_e, cmd) => {
  const c = String(cmd || "");
  try {
    if (c !== "pause" && c !== "resume" && c !== "finish" && c !== "abort") {
      log("[recbar] 未知命令:", c);
      return;
    }
    // 面板没了（被强关 / 崩溃）：控制条再挂着只会让用户点一个没反应的按钮
    if (!panel || panel.isDestroyed()) {
      resetRecbarInteractive(recbarWin);
      try { if (recbarWin && !recbarWin.isDestroyed()) recbarWin.hide(); } catch { /* ignore */ }
      return;
    }
    sendToPanel("rec:cmd", c);
  } catch (e) {
    log("[recbar] 转发命令失败:", (e && e.message) || String(e));
  }
});

/* 控制条 → 主进程：能量条收起时切"点击穿透"。
   细条只被看见、不被挡住 —— 否则屏幕顶部的一条小条会吃掉背后的
   最大化按钮 / 浏览器标签页。

   ⚠️ 2026-10-22 修（用户报「自动缩起后悬停无法展开、按钮点不到」）：
   原方案靠 `setIgnoreMouseEvents(true, { forward: true })` 把 mousemove 转发
   给页面，页面再用坐标判定悬停。但 Windows 下这个转发并不可靠 —— 穿透态里
   页面常常一个鼠标事件都收不到，于是永远展不开，三个按钮彻底点不到。
   现在改由**主进程**在穿透期间盯着光标：定时取 screen.getCursorScreenPoint()
   与控制条矩形比对，进/出各广播一次 `rec:hover`，页面据此展开或收回。
   这样"收起时不挡背后"与"悬停能展开、按钮能点"两头都成立，且不依赖
   forward 的平台实现差异（页面里那条 mousemove 判定保留作 macOS 的快路径）。 */
const REC_HIT = { x0: 16, x1: 224, y0: 0, y1: 34 };   // 与 recbar.html 的 HIT 保持一致
const REC_HOVER_PAD = 8;                              // 判定区外扩，别让人正正好好对准
let recbarPassthru = false;
let recbarHoverTimer = null;
let recbarHoverInside = false;
function stopRecbarHoverWatch() {
  if (recbarHoverTimer) { clearInterval(recbarHoverTimer); recbarHoverTimer = null; }
  recbarHoverInside = false;
}
function startRecbarHoverWatch() {
  if (recbarHoverTimer) return;
  recbarHoverInside = false;
  recbarHoverTimer = setInterval(() => {
    try {
      if (!recbarPassthru || !recbarWin || recbarWin.isDestroyed()) { stopRecbarHoverWatch(); return; }
      const b = recbarWin.getBounds();
      const p = screen.getCursorScreenPoint();
      const inside = p.x >= b.x + REC_HIT.x0 - REC_HOVER_PAD && p.x <= b.x + REC_HIT.x1 + REC_HOVER_PAD
                  && p.y >= b.y + REC_HIT.y0 - REC_HOVER_PAD && p.y <= b.y + REC_HIT.y1 + REC_HOVER_PAD;
      if (inside === recbarHoverInside) return;   // 只在跨越边界时广播一次
      recbarHoverInside = inside;
      sendToBar("rec:hover", { inside: inside });
    } catch (e) {
      /* 光标/窗口查询偶尔会失败（显示器热插拔、窗口正在销毁）：
         停掉监视，别把异常每 140ms 刷一次日志 */
      stopRecbarHoverWatch();
      log("[recbar] 悬停监视异常，已停止:", (e && e.message) || String(e));
    }
  }, 140);
}
ipcMain.on("rec-bar-passthru", (_e, on) => {
  try {
    if (!recbarWin || recbarWin.isDestroyed()) return;
    /* 关穿透时不带 options：回到普通可交互窗口 */
    if (on) {
      recbarWin.setIgnoreMouseEvents(true, { forward: true });
      recbarPassthru = true;
      startRecbarHoverWatch();
    } else {
      recbarPassthru = false;
      stopRecbarHoverWatch();
      recbarWin.setIgnoreMouseEvents(false);
    }
  } catch (e) {
    log("[recbar] 切换点击穿透失败:", (e && e.message) || String(e));
  }
});
/* 穿透必须跟着"不再显示"一起复位：否则上一轮录制停在收起态就隐藏了窗口，
   下一轮 show() 出来时 ignore-mouse-events 还挂着 → 一上来就点不动。 */
function resetRecbarInteractive(win) {
  recbarPassthru = false;
  stopRecbarHoverWatch();
  try { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(false); } catch { /* 已销毁 */ }
}

/* ---------- 控制条偏好（皮肤 / 能量条 / 自选描边色） ----------
 * 一处校验、一处落盘、一处推给控制条。渲染层（设置 › 录屏）只发patch，
 * 不自己判断默认值 —— 默认口径必须和主进程一致，否则会出现
 * "面板显示灰白纱、控制条画深纱"这种两侧对不上的情况。 */
safeHandle("set-rectheme", (_e, patch) => {
  const p = patch || {};
  const skin = p.skin === "dark" ? "dark" : (p.skin === "light" ? "light" : state.recSkin);
  const energy = typeof p.energy === "boolean" ? p.energy : state.recEnergy;
  const borderRaw = typeof p.borderColor === "string" ? p.borderColor.trim().toLowerCase() : "";
  const borderColor = borderRaw === "" || /^#[0-9a-f]{6}$/.test(borderRaw) ? borderRaw : (state.recBorderColor || "");
  normalizeRecPrefs();
  const next = { recSkin: skin, recEnergy: energy, recBorderColor: borderColor };
  saveState(next);
  if (recbarWin && !recbarWin.isDestroyed()) sendRecCfg();   // 控制条活着就当场生效
  return { ok: true, rec: recCfg() };
}, { ok: false, error: "保存悬浮条偏好失败" });

/* ---------- 实时字幕窗偏好（皮肤 + 描边色） ---------- */
safeHandle("set-sub-theme", (_e, patch) => {
  const p = patch || {};
  const skin = p.skin === "light" ? "light" : (p.skin === "dark" ? "dark" : state.subSkin);
  const borderRaw = typeof p.borderColor === "string" ? p.borderColor.trim().toLowerCase() : "";
  const borderColor = borderRaw === "" || /^#[0-9a-f]{6}$/.test(borderRaw) ? borderRaw : (state.subBorderColor || "");
  normalizeThemePrefs();
  saveState({ subSkin: skin, subBorderColor: borderColor });
  sendSubCfg();                       // 字幕窗开着就当场生效
  return { ok: true, sub: subCfg() };
}, { ok: false, error: "保存字幕窗偏好失败" });

/* ---------- 主题自选：交互色 / 渐变搭配 / 自定义背景图 ----------
 * 一处校验、一处落盘。渲染层（设置 › 外观）只发 patch，默认值口径以这里为准，
 * 否则会出现"面板显示默认、实际套了别的"这类两侧对不上。 */
safeHandle("set-theme-accent", (_e, patch) => {
  const p = patch || {};
  normalizeThemePrefs();
  if (typeof p.grad === "string") {
    state.themeGrad = (p.grad === "custom" || T3_GRAD_IDS.includes(p.grad)) ? p.grad : "";
  }
  /* 自定义渐变两端：随 patch 一起校验。端点不合法时若正选着自定义档，一并退回默认 */
  if (p.gradCustom && typeof p.gradCustom === "object") {
    const ghex = (v) => { const s = String(v || "").trim().toLowerCase(); return /^#[0-9a-f]{6}$/.test(s) ? s : ""; };
    const c1 = ghex(p.gradCustom.c1), c2 = ghex(p.gradCustom.c2);
    if (c1 && c2) state.themeGradCustom = { c1, c2 };
    else if (state.themeGrad === "custom") state.themeGrad = "";
  }
  /* 毛玻璃：只改指定主题那一份；极光不接受这个开关（它自带玻璃） */
  if (typeof p.glass === "boolean") {
    const t = THEME_IDS.includes(p.theme) ? p.theme : "t2";
    if (t !== "t3") state.themeGlass[t] = p.glass;
  }
  if (typeof p.accentColor === "string") {
    const t = THEME_IDS.includes(p.theme) ? p.theme : "t2";
    const c = p.accentColor.trim().toLowerCase();
    state.themeAccent[t] = (c === "" || /^#[0-9a-f]{6}$/.test(c)) ? c : (state.themeAccent[t] || "");
  }
  saveState({});
  return { ok: true, prefs: themePrefsPayload() };
}, { ok: false, error: "保存主题偏好失败" });

/* 自定义主题背景图：对话框在主进程（渲染层没有文件系统权限），
 * 选完直接回 data URL，面板拿它当 --theme-image 用。 */
safeHandle("pick-theme-image", async () => {
  try { return await pickThemeImage(); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}, { ok: false, error: "选择图片失败" });
safeHandle("clear-theme-image", () => clearThemeImage(), { ok: false, error: "清除背景图失败" });

ipcMain.handle("get-state", () => ({
  pinned: state.pinned,
  coordMode: state.coordMode,
  border: state.border,
  avatar: avatarDataUrl(),
  /* 悬浮控制条偏好：设置 › 录屏 里的皮肤 / 能量条 / 自选描边色 */
  rec: recCfg(),
  /* 实时字幕窗偏好：皮肤 + 自选描边色（默认深纱） */
  sub: subCfg(),
  /* 主题自选：每套主题的交互色、极光渐变搭配 id、自定义渐变两端、自定义主题背景图 */
  themeAccent: { ...state.themeAccent },
  themeGrad: state.themeGrad,
  themeGradCustom: { ...state.themeGradCustom },
  themeGlass: { ...state.themeGlass },
  themeImage: themeImageDataUrl(),
  voice: {
    engine: state.voice?.engine ?? "auto",
    endpoint: state.voice?.endpoint ?? "",
    model: state.voice?.model ?? "whisper-1",
    lang: state.voice?.lang ?? "zh-CN",
    hasKey: !!(state.voice?.apiKey),
  },
  vision: {
    maxSteps: state.vision?.maxSteps ?? 12,
    primary: slotInfo(state.vision?.primary),
    backup: slotInfo(state.vision?.backup),
  },
  visionPresets: VISION_PRESETS,
  /* 首跑向导：firstRun 由 envWizardDone 反算；渲染层据此决定要不要自动弹一次，
     看完之后调用 set-wizard-done 把 envWizardDone 落盘。 */
  firstRun: !!state.firstRun,
  envWizardDone: !!state.envWizardDone,
  /* 截屏引导卡（第一档）：没装 Snipaste 时首启弹一次，看完 snip-guide-done 落盘。
     和 envWizardDone 同一个套路：主进程落盘为准，localStorage 只是保底。 */
  snipGuideDone: !!state.snipGuideDone,
  display: (() => {
    const d = screen.getPrimaryDisplay();
    return { width: d.size.width * d.scaleFactor, height: d.size.height * d.scaleFactor, scale: d.scaleFactor };
  })(),
  workspace: path.join(__dirname, "..", ".."),
}));

function slotInfo(s) {
  return {
    provider: s?.provider ?? "custom",
    baseUrl: s?.baseUrl ?? "",
    model: s?.model ?? "",
    hasKey: !!(s?.apiKey),
  };
}

/* 密钥单独走通道：只在需要发起请求时取。slot 为 "primary" | "backup" */
safeHandle("get-vision-key", (_e, slot) => state.vision?.[slot || "primary"]?.apiKey ?? "", "");

/* 首跑向导「已看过」标记落盘。
 * 走专属通道，不搭 set-vision 的顺风车：把 UI 标记混进视觉配置的写入语义里既别扭，
 * 又依赖对方归一化的细节（set-vision 将来一改就可能悄悄失效）。多一条白名单通道
 * 代价很小，语义清晰更值钱。 */
safeHandle("set-wizard-done", (_e, done) => {
  if (done === true) saveState({ envWizardDone: true, firstRun: false });
  return !!state.envWizardDone;
}, false);

safeHandle("set-vision", (_e, patch) => {
  const next = {
    primary: { ...(state.vision?.primary || makeSlot("custom")) },
    backup: { ...(state.vision?.backup || makeSlot("custom")) },
    maxSteps: Math.max(1, Math.min(40, Number(patch?.maxSteps ?? state.vision?.maxSteps) || 12)),
  };

  for (const slot of ["primary", "backup"]) {
    const p = patch?.[slot];
    // 非对象（字符串 / null）展开后会污染出 "0"、"1"… 这类键并写进存档
    if (!p || typeof p !== "object") continue;
    const merged = { ...next[slot], ...p };

    // 换服务商时，把该预设的默认地址/模型/额外参数带上（除非本次显式改了）
    const preset = VISION_PRESETS[merged.provider];
    if (preset && merged.provider !== "custom") {
      if (!("baseUrl" in p)) merged.baseUrl = preset.baseUrl;
      if (!("model" in p)) merged.model = preset.model;
      if (!("extra" in p)) merged.extra = preset.extra ? { ...preset.extra } : {};
    }
    if (merged.apiKey === null) delete merged.apiKey;   // 传 null 表示保持原值
    next[slot] = merged;
  }

  saveState({ vision: next });
  return {
    ok: true,
    vision: { maxSteps: next.maxSteps, primary: slotInfo(next.primary), backup: slotInfo(next.backup) },
  };
}, () => ({ ok: false, error: "视觉设置保存失败（详见 .orbdata/orb.log）" }));
safeHandle("bridge-token", () => {
  /* 桥每次启动都会换令牌。原来只在启动时读一次就缓存住 ——
     桥中途被重启（手动 / 崩溃后由 start.cmd 拉起）之后，
     面板拿到的还是旧令牌，所有 /api/* 全线 401，只能重启 ORB 才恢复。 */
  const fresh = bridgeTokenSync();
  if (fresh) bridgeToken = fresh;
  return bridgeToken;
}, "");
safeHandle("cursor", () => {
  const p = screen.getCursorScreenPoint();
  const d = screen.getPrimaryDisplay();
  const w = Math.max(1, d.size.width * d.scaleFactor);
  const h = Math.max(1, d.size.height * d.scaleFactor);
  return {
    x: p.x, y: p.y,
    permilleX: Math.round((p.x / w) * 1000),
    permilleY: Math.round((p.y / h) * 1000),
  };
}, { x: 0, y: 0, permilleX: 0, permilleY: 0 });
safeHandle("clipboard-read", () => clipboard.readText(), "");
safeHandle("clipboard-write", (_e, text) => { clipboard.writeText(String(text ?? "")); return true; }, false);

/* 录制时要用：把 ORB 自己的窗口矩形交给 bridge，
   全局钩子据此排除"用户点的是 ORB 面板/悬浮球"的情况 ——
   否则录"打开某软件"时，前半段全是点我们自己面板的动作。 */
safeHandle("orb-bounds", () => {
  const out = [];
  for (const w of [ball, panel]) {
    try { if (w && !w.isDestroyed() && w.isVisible()) out.push(w.getBounds()); } catch { /* ignore */ }
  }
  return out;
}, []);

/* ---------------- 语音识别 ---------------- */

safeHandle("set-voice", (_e, patch) => {
  const cur = state.voice || { engine: "auto", endpoint: "", apiKey: "", model: "whisper-1", lang: "zh-CN" };
  // patch 必须是对象：渲染层万一传了字符串/null，展开后会污染出 "0"、"1"… 这种键
  const next = { ...cur, ...(patch && typeof patch === "object" ? patch : {}) };
  if (next.apiKey === null) delete next.apiKey;   // 传 null 表示保持原 Key 不变
  saveState({ voice: next });
  return {
    ok: true,
    voice: {
      engine: next.engine, endpoint: next.endpoint, model: next.model, lang: next.lang,
      hasKey: !!(next.apiKey),
    },
  };
}, () => ({ ok: false, error: "语音设置保存失败（详见 .orbdata/orb.log）" }));

/**
 * 录音 → ASR 的代理：面板把音频(base64)和端点发过来，主进程代为发起 HTTP 请求。
 * 这样录音文件的 POST 走主进程、不受面板 CSP(connect-src 仅放行 127.0.0.1:19387) 限制，
 * 也能用主进程自带的 fetch/FormData/Blob。接口形态对齐 OpenAI /audio/transcriptions。
 */
ipcMain.handle("asr-transcribe", async (_e, { endpoint, apiKey, model, audioB64, mime } = {}) => {
  if (!endpoint) return { ok: false, error: "未配置语音识别端点" };
  try {
    const buf = Buffer.from(audioB64 || "", "base64");
    if (!buf.length) return { ok: false, error: "音频数据为空" };
    const ext = /webm/.test(mime || "") ? "webm" : /mp4|m4a/.test(mime || "") ? "mp4" : "wav";
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime || "audio/webm" }), "audio." + ext);
    if (model) form.append("model", model);
    const headers = {};
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    let r;
    try {
      r = await fetch(endpoint, { method: "POST", headers, body: form, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, error: "ASR HTTP " + r.status + "：" + txt.slice(0, 200) };
    }
    const j = await r.json().catch(() => ({}));
    const text = j.text || j.transcript || (Array.isArray(j.results) ? j.results.map((x) => x.text || x.transcript || "").join("") : "");
    return { ok: true, text: String(text || "") };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

/**
 * 本地 Whisper 状态查询（GET /api/asr 的主进程代理）。
 * 用途：语音引擎=auto 时，voice.js 靠它决定走本地还是浏览器 —— 本地就绪
 * （installed + modelDownloaded + running）就用本地，否则静默回落浏览器。
 * 与 asr-transcribe 同一套路：主进程带令牌代发，渲染层不碰请求头。
 */
ipcMain.handle("asr-status", async () => {
  try {
    const token = bridgeTokenSync();
    const headers = {};
    if (token) headers["X-Orb-Token"] = token;
    const r = await fetch(`http://127.0.0.1:${PORT}/api/asr`, { headers });
    if (!r.ok) return { ok: false, error: "bridge HTTP " + r.status };
    const j = await r.json();
    return { ok: true, ...j };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});
