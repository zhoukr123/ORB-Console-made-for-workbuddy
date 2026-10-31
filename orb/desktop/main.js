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
const memory = require("./memory");
const mp4finalize = require("./mp4finalize");
/* Snipaste 调用接口（截屏功能走它：检测 / 唤起 / 落盘到截屏分区）。 */
const snipaste = require("./snipaste");
/* 桌面模糊背景：抓桌面实拍垫给玻璃态面板与录制条（原因见文件头）。
   2026-10-23 起窗口自身用 setContentProtection 排除出截图，所以抓图不再需要藏窗。 */
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

/* 长期记忆引擎：与 storage 同根，记忆库落在 <DATA_ROOT>/memory/memory.json。
 * 同样走注入而非 require 环（见 storage 头注）。所有读写经主进程 safeHandle，
 * 渲染进程只通过 preload 白名单的 invoke 调用，绝不直接碰文件。 */
memory.init({
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
   backdrop-filter 采不到桌面、开 GPU 无效、原生 acrylic 三条路全死）。
   beforeShot / afterShot：抓底图那一瞬间临时把自家窗口排除出截图，
   抓完恢复（见 beginShotShield / endShotShield 的引用计数说明）。 */
glassbg.init({
  log: (...a) => log(...a),
  beforeShot: () => beginShotShield(),
  afterShot: () => endShotShield(),
});

/* 原生录屏 helper（Stage 2）：orb/native/dist/orb-cap.exe —— DXGI 复制 + MF 直出
   MP4。这是唯一碰它的地方，行协议的解析全在 cap-native.js 里。
   注意：它只是"更优路径"，MediaRecorder(VP9/WebM) 链路原样保留做兜底。 */
const capNative = require("./cap-native");
capNative.init({ log: (...a) => log(...a) });

/* helper 在录制中意外退出（崩溃 / 被任务管理器杀掉）：提示用户，并让面板把状态机
   复位回 idle。⚠️ 这个文案前缀与 panel.html 里 onNotice 的判断必须保持一致
   （那边据此调用 captureController.nativeHelperGone()），改文案要两边一起改。 */
const CAP_NATIVE_EXIT_PREFIX = "原生编码器意外退出";
capNative.on("exit", (info) => {
  if (!info) return;
  log("[cap-native] 意外退出:", JSON.stringify(info));
  const where = info.path ? "（已写入的部分保留在 " + info.path + "）" : "";
  sendToPanel("notice", CAP_NATIVE_EXIT_PREFIX + "，已保留已写入的部分" + where);
});

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
  /* 录屏 / 截屏期间要不要把控制台真的藏起来（详见「隐藏控制台」那一段注释）。
     录屏默认开：录屏时用户就是要它消失；截屏默认关：面板收起是额外动作，
     有人就喜欢截完还能直接粘贴进对话框。 */
  recHideConsole: true, snipHideConsole: false,
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
  /* 录屏音频来源（设置 › 录屏）：none 不录音频（默认，保持既有行为）；
     system 系统音 / mic 麦克风 / mix 两者混音（软件限幅）。
     与 recSkin 那组同模式：主进程落盘，渲染层只发 patch。
     原生编码管线接入音频后，录屏启动时从这里取值。 */
  recAudio: { source: "none" },
  /* 摄像头小框（设置 › 录屏）：
     shape  圆形 circle / 圆角 round / 方框 square
     ratio  16:9 | 4:3 | 1:1 | custom（用户自定）| free（不约束）
     customRatio 自定长宽比原文（"16:9" 或 "1.78"），仅 ratio=custom 时有效
     bx/by 小框中心点（0~1，相对录制画面）；bw/bh 宽高（0~1，相对画面宽/高）
     归一化口径让面板内的「预览模式」与日后的真实悬浮窗共用同一份配置。 */
  recCam: { enabled: false, shape: "round", ratio: "4:3", customRatio: "", bx: 0.76, by: 0.72, bw: 0.115, bh: 0.15 },
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
    normalizeRecAudio();
    normalizeRecCam();
    normalizeThemePrefs();
    normalizeScalars();
  } catch (e) {
    /* 这里不能静默：文件损坏 = 主题偏好 / 存储根 / 最近录屏全部回默认值，
       用户会以为自己从来没设置过。留一行日志，至少能查到是哪次写坏的。 */
    log("[state] 读取失败，已回默认值:", (e && e.message) || String(e));
  }
}
/* 布尔 / 枚举类的首选项也要收敛：orb-state.json 被手改或被写坏时
   （"pinned":"false"、"border":"0" 这种字符串）会让面板永久钉住 / 自动折叠
   永远关不掉，而在 UI 上改不回来 —— 布尔值只有 true/false 两种，没有"写坏了
   就当没设置"这回事，所以加载时统一按类型收敛。 */
function normalizeScalars() {
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  state.pinned = bool(state.pinned, false);
  state.border = bool(state.border, true);
  state.autoSelect = bool(state.autoSelect, true);
  state.autoSelectClipboard = bool(state.autoSelectClipboard, true);
  state.recHideConsole = bool(state.recHideConsole, true);
  state.snipHideConsole = bool(state.snipHideConsole, false);
  state.envWizardDone = bool(state.envWizardDone, false);
  state.snipGuideDone = bool(state.snipGuideDone, false);
  state.coordMode = state.coordMode === "permille" ? "permille" : "pixel";
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  state.x = num(state.x);
  state.y = num(state.y);
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
/* 录屏音频来源：白名单校验，形状不对回 none（不录音频） */
function normalizeRecAudio() {
  const src = state.recAudio && typeof state.recAudio === "object" ? state.recAudio.source : "";
  state.recAudio = { source: ["none", "system", "mic", "mix"].includes(src) ? src : "none" };
}
/* 摄像头小框：枚举值白名单 + 数值夹取；custom 档拿不出合法比例时退回 free */
function normalizeRecCam() {
  const c = state.recCam && typeof state.recCam === "object" ? state.recCam : {};
  const shape = ["circle", "round", "square"].includes(c.shape) ? c.shape : "round";
  const ratio = ["16:9", "4:3", "1:1", "custom", "free"].includes(c.ratio) ? c.ratio : "4:3";
  const customRatio = typeof c.customRatio === "string" ? c.customRatio.trim().slice(0, 12) : "";
  const f01 = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : d);
  const fSize = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0.05, Math.min(0.6, Number(v))) : d);
  state.recCam = {
    enabled: !!c.enabled,
    shape,
    ratio: ratio === "custom" && !validRatioStr(customRatio) ? "free" : ratio,
    customRatio,
    bx: f01(c.bx, 0.76),
    by: f01(c.by, 0.72),
    bw: fSize(c.bw, 0.115),
    bh: fSize(c.bh, 0.15),
  };
}
/* 长宽比原文合法性："16:9"（两端 > 0）或小数 "1.78"（> 0）；不合法返回空串 */
function validRatioStr(s) {
  const t = String(s || "").trim();
  let m = t.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (m) { const a = Number(m[1]), b = Number(m[2]); return a > 0 && b > 0 ? t : ""; }
  if (/^\d+(?:\.\d+)?$/.test(t) && Number(t) > 0) return t;
  return "";
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
  /* 原子写：先写 .tmp 再 rename。直接写目标文件时，进程被强杀 / 磁盘只读会把
     orb-state.json 截成半个 JSON —— 下次启动 loadState 的 catch 会静默回默认值，
     主题偏好、存储根、最近录屏全丢，用户还不知道发生了什么。
     写失败也不能再吞：至少留一行日志。 */
  try {
    const dir = path.dirname(stateFile());
    fs.mkdirSync(dir, { recursive: true });
    const tmp = stateFile() + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile());
  } catch (e) {
    log("[state] 保存失败:", (e && e.message) || String(e));
  }
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

/* ---------------- 从系统截图里排除自身窗口（毛玻璃底图的干净来源） ----------------
 * 本机实测（docs/_protect_probe.js，Electron 44 / Win11）：setContentProtection(true)
 * 是 WDA_EXCLUDEFROMCAPTURE 语义 —— 同一块窗口区域，开启前截到纯红 (253,2,2)，
 * 开启后截到的是背后的桌面 (249,249,249)，即窗口**从截图里消失**，不是被糊成黑块。
 * 这一个事实带来两处收益（见 glassbg.js 头注）：
 *   ① glassbg 抓桌面时不必再藏窗 —— 藏窗正是那 430ms 白闪的来源，现在彻底没有；
 *   ② 底图里不会出现 ORB 自己，"模糊再模糊"的递归鬼影从根上消失。
 * 所以**三个窗口都要挂**：漏掉任何一个，它就会被拍进别人的玻璃底图。
 * 老版本 / 非 Windows 上没这个方法时不致命（只是底图里会含自身），记一行日志。 */
/* ---------------- 从系统截图里排除自身窗口（按需，非常驻） ----------------
 * 本机实测（docs/_protect_probe.js，Electron 44 / Win11）：setContentProtection(true)
 * 是 WDA_EXCLUDEFROMCAPTURE 语义 —— 同一块窗口区域，开启前截到纯红 (253,2,2)，
 * 开启后截到的是背后的桌面 (249,249,249)，即窗口**从截图里消失**，不是被糊成黑块。
 *
 * ⚠️ 2026-10-24 改为**按需**：早先是三个窗口一创建就常驻排除，副作用是
 *   用户想截 ORB 自己的界面反馈问题、做演示时**根本截不到**（用户实测反馈）。
 *   现在只在真正需要的两个时段开启：
 *     ① 录屏进行中 —— 成片里不能出现 ORB 自己（这是刚需）
 *     ② glassbg 抓桌面底图的那一瞬间 —— 底图不能含 ORB，否则"模糊再模糊"出鬼影
 *   其余时间一律不排除，ORB 界面可以被正常截图 / 录屏 / 共享。
 *
 * ⚠️ 调试逃生开关：ORB_NO_PROTECT=1 启动则彻底不开启（排查 / 录演示用）。
 *    正常启动不要写进任何默认配置或启动脚本。 */
let captureShieldOn = false;   // 录屏期间为 true（glassbg 的临时开关不改写它）
let captureShieldDepth = 0;    // 录屏会话的引用计数（见 setCaptureShield）

function shieldWin(win, tag, on) {
  if (!win || (win.isDestroyed && win.isDestroyed())) return;
  if (process.env.ORB_NO_PROTECT === "1") return;
  try {
    win.setContentProtection(!!on);
  } catch (e) {
    log(`[glassbg] ${tag} ${on ? "开启" : "关闭"}排除截图失败:`, (e && e.message) || String(e));
  }
}

/**
 * 录屏开始 / 结束时调用：整段录制期间把自家窗口从画面里摘掉。
 *
 * ⚠️ recbar（录屏悬浮条）**不参与排除** —— 用户反馈过："开启录屏时截屏，
 * 录屏悬浮窗也会一并隐藏"。WDA_EXCLUDEFROMCAPTURE 是让窗口从**所有**截图里
 * 消失（不是黑块），所以排除它 = 用户按系统截图键时它就没了。
 * 代价是成片里会有一条悬浮条 —— 换来"用户截屏时看得见自己的录屏控制条"，
 * 这个取舍更划算（悬浮条本身很小，且用户知道它在那儿）。
 */
function setShieldState(on) {
  captureShieldOn = !!on;
  shieldWin(ball, "ball", captureShieldOn);
  shieldWin(panel, "panel", captureShieldOn);
  shieldWin(toolbar, "toolbar", captureShieldOn);
  shieldWin(subWin, "subtitle", captureShieldOn);
  shieldWin(borderWin, "border", captureShieldOn);
  log("[glassbg] 截图排除", captureShieldOn ? "已开启（录屏中）" : "已关闭");
}
/**
 * 引用计数，不是布尔开关：cap-* 链路允许 3 个并发会话，原生链路又是独立一条。
 * 布尔开关的话，先结束的那一路会把排除撤掉，仍在录的那一路成片里就出现 ORB 自己。
 * 计数归零才真正恢复可截图。异常路径多调一次 false 只会让计数提前归零
 * （钳在 0），不会把状态锁死 —— 宁可"少排除"，也不能"再也截不到自己的界面"。
 */
function setCaptureShield(on) {
  captureShieldDepth = Math.max(0, captureShieldDepth + (on ? 1 : -1));
  const next = captureShieldDepth > 0;
  if (next === captureShieldOn) return;   // 状态没变就别挨个窗口刷一遍
  setShieldState(next);
}
/** 强制复位（面板被强关 / 退出）：不管计数漂到哪儿，一律恢复可截图。 */
function resetCaptureShield() {
  captureShieldDepth = 0;
  if (captureShieldOn) setShieldState(false);
}

/* ---- glassbg 抓底图那一瞬间的临时排除 ----
 *
 * 底图是**整屏**截图，不是只截窗口那块。所以任何一个自家窗口（悬浮球 / 面板 /
 * 工具条 / 字幕窗 / 观察边框 / 录制条）只要在屏幕任意位置，就会被拍进底图，
 * 模糊之后是"模糊再模糊"的鬼影。必须**一次全排除**，不能只排除被抓的那一个。
 *
 * 引用计数是必须的，不是过度设计：panel 与 recbarWin 都被 watch，而 entry.busy
 * 是**按窗口**粒度的 —— 两个窗口可以并发进 captureBehind，两次 getSources 重叠。
 * 若用布尔开关，先完成的那次会在后一次还在 await 时把排除撤掉，
 * 后一次的底图就会拍到 ORB 自己。计数归零才恢复。
 */
let shotShieldDepth = 0;

/** 抓图前：所有自家窗口临时排除。 */
function beginShotShield() {
  shotShieldDepth += 1;
  if (shotShieldDepth > 1) return;   // 已有一次在抓，别重复设置
  shieldWin(ball, "ball", true);
  shieldWin(panel, "panel", true);
  shieldWin(toolbar, "toolbar", true);
  shieldWin(subWin, "subtitle", true);
  shieldWin(borderWin, "border", true);
  shieldWin(recbarWin, "recbar", true);
  shieldWin(pickWin, "pick", true);   // 取词覆盖层：它压在整屏上，不排除就拍到满屏暗色
}

/** 抓图后：计数减一，归零才恢复到基线状态（录屏中则仍保持排除）。 */
function endShotShield() {
  if (shotShieldDepth > 0) shotShieldDepth -= 1;
  if (shotShieldDepth > 0) return;
  shieldWin(ball, "ball", captureShieldOn);
  shieldWin(panel, "panel", captureShieldOn);
  shieldWin(toolbar, "toolbar", captureShieldOn);
  shieldWin(subWin, "subtitle", captureShieldOn);
  shieldWin(borderWin, "border", captureShieldOn);
  shieldWin(recbarWin, "recbar", captureShieldOn);
  shieldWin(pickWin, "pick", captureShieldOn);
}

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
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      /* 悬浮球的空闲计时是一个 2 分钟的定时器，一旦被判定成"后台页面"，
         Chromium 会把长定时器对齐到分钟级甚至挂起 —— 表现就是空闲动图永远不来。
         这颗球 72px 常驻可见，节流它省不了几个 CPU，却会把整套陪伴动效搞没。 */
      backgroundThrottling: false,
    },
  });
  ball.loadFile(path.join(__dirname, "ball.html"));
  ball.setAlwaysOnTop(true, "screen-saver");
  ball.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  /* 悬浮球也在抓图范围里：不排除的话，它会被拍进面板/录制条的玻璃底图，
     在底图里留一个"跟着球走"的鬼影。 */
  /* 不再常驻排除：只在录屏期间 / 抓底图那一瞬间开（见 setCaptureShield 注释）。
     常驻的代价是用户截不到 ORB 自己的界面。 */
  shieldWin(ball, "ball", false);
  ball.webContents.on("console-message", (e) => log(`[ball:${e.level}] ${e.message}`));
  ball.on("closed", () => { ball = null; });
  ball.webContents.once("did-finish-load", () => {
    log("[ball-bounds]", JSON.stringify(ball.getBounds()));
    pushThemeVars();               // 悬浮球的光晕/投影跟随主题交互色
    /* 动效开关要补推一次：面板报告的那一刻球可能还没加载完，send 过去直接丢，
       结果就是"关了动效但球还在呼吸"。主进程留一份状态，加载完再灌一次。 */
    sendToBall("motion", motionOn);
    /* 个性偏好同理：面板先报、球后加载的话，不补推球就一直按默认人格演，
       用户会以为"选了人格没反应"。 */
    sendToBall("character", Object.assign({}, characterCfg, { gifMeta: animMeta() }));
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
    // 控制台不占任务栏：它是常驻悬浮面板，有托盘图标（左键切换、右键菜单里有
    // 「打开面板 / 控制台页面 / 划词 / 退出」）+ 悬浮球 + 全局快捷键可以唤出。
    // 之前进任务栏是怕"打开后没有应用身份"，但代价是常驻一个任务栏按钮，
    // 而且面板隐藏时按钮还在（容易被误认为程序卡住），与悬浮助手的定位不符。
    icon: path.join(__dirname, "orb-logo.ico"),
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
  panel.on("show", () => {
    try { panel.webContents.setBackgroundThrottling(false); } catch {}
    /* 面板被唤出：通知渲染层跑一次「离开 ≥4 分钟再开」的问候判定。
       不能只靠渲染层的 visibilitychange —— hide()/show() 在部分环境不触发它
       （面板里向导/截图引导都为此加了 700ms 轮询兜底），而主进程的 window
       'show' 事件是可靠的，用它兜住。发送失败（窗口正在销毁）忽略即可。 */
    try { panel.webContents.send("panel-shown"); } catch {}
  });
  panel.on("hide", () => {
    try { panel.webContents.setBackgroundThrottling(true); } catch {}
    /* 记下「收起时刻」：让「离开 ≥4 分钟」从真正收起起算，而不是从最后一次
       键盘/点击算（自动收起前用户可能已悬停阅读一段时间，按操作算会提前弹）。 */
    try { panel.webContents.send("panel-hidden"); } catch {}
  });
  panel.loadFile(path.join(__dirname, "panel.html"));
  /* 桌面模糊底图：面板玻璃态（t1/t2）时要抓桌面实拍。挂载即可，
     抓不抓由渲染层的 glass-bg-want 说了算（非玻璃态零开销）。
     mode:"full" = 整屏底图 + 位移流：拖动时只发 16ms 节流的位移帧、不重截，
     消除旧「裁窗口块」方案拖动 0.4s 滞后 + 拖完闪一下的问题。
     面板自身先排除出截图，所以抓到的桌面里没有 ORB 自己（不必藏窗、不闪）。 */
  shieldWin(panel, "panel", false);   // 同理：按需排除，非常驻
  glassbg.watch(panel, "glass:bg", { mode: "full" });
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
      /* 窗口藏起来了，光标监视也得停：否则它会一直轮询一个看不见的条，
         并在鼠标路过那块区域时给页面发"悬停进入"（页面看不到，但日志会乱）。 */
      stopRecbarHoverWatch(); recbarPassthru = false;
      /* 面板被强关时录制可能还挂着（cap-close 永远不来）—— 强制把"排除截图"
         复位，否则用户此后截屏再也截不到 ORB 自己，只能重启应用。 */
      resetCaptureShield();
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
    /* 先把自己排除出截图，再挂抓取（顺序即因果：抓到的桌面里已经不含这条控制条，
       所以不必藏窗）。控制条贴在屏幕上沿、长驻可见，藏窗闪一下最刺眼。 */
    shieldWin(recbarWin, "recbar", false);   // 同理：按需排除，非常驻
    recbarWin.loadFile(path.join(__dirname, "recbar.html"));
    /* 录制条的纱（α.82）在透明窗里同样采不到桌面，一并挂上实拍抓取。
       full 模式（整屏图 + 位移流）：控制条靠 -webkit-app-region:drag 拖窗口，
       旧 crop 模式要「停稳 250ms 后重截」才跟得上，拖动时底图滞后 0.4s、
       松手还要闪一下；整屏图对桌面静止时窗口的任意位置都成立，所以拖动只发
       {kind:"pos",x,y}（16ms 节流）让渲染层改 background-position 即可，
       全程零重截、零闪烁。只有换屏（DPI/内容变）与停稳补新鲜度才真抓。 */
    glassbg.watch(recbarWin, "recbar:glass-bg", { mode: "full" });
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
  startSnipPoll();   // 面板在 = 可能被截屏打断，开始盯着 Snipaste
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
  /* 不再停掉截屏轮询：改成常驻（见 startSnipPoll 的注释）。
     面板收起后仍要知道"用户是不是在截屏"，否则下一次开面板时
     判据还没热起来，又会出现"一截屏面板就缩回"。 */
  panel.hide();
  sendToBall("panel-state", false);
  if (!ballHover && !panelHover) stopTrack();
}

function togglePanel() {
  /* 录屏中被"真隐藏"了 → 这是**唤回**，不是普通的开合：
     球要跟着回来，而且之后录屏结束不再强行弹开面板。 */
  if (consoleHiddenByRec) { summonConsole(); return; }
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

/* Snipaste 装没装，缓存 60s。
   只有装了才值得在折叠前多等一会儿（见 scheduleClose 的观察窗口），
   没装 Snipaste 的机器行为完全不变 —— 不能为了一个不存在的功能
   让所有人的面板都晚 1.2 秒收起。 */
let snipInstalledCache = { v: null, at: 0 };
async function snipInstalled() {
  const now = Date.now();
  if (snipInstalledCache.v !== null && now - snipInstalledCache.at < 60000) return snipInstalledCache.v;
  let v = false;
  try {
    const r = await snipaste.detect();
    v = !!(r && r.installed);
  } catch { v = false; }
  snipInstalledCache = { v, at: now };
  return v;
}

function scheduleClose(delay = 500) {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (state.pinned || panelHover || ballHover || drag || holdOpen) return;
    if (snippingNow) {
      log("[panel] 截屏进行中，推迟折叠");
      scheduleClose(1200);
      return;
    }
    /* ⚠️ 折叠前先给截屏一个「观察窗口」。
       只查一次是查不准的：实测鼠标离开面板后，Snipaste 的框选浮层要
       约 2 秒才真正拿到前台（进程要起、浮层要铺满屏），而折叠只等 500ms
       —— 判据还没成立，面板已经收了。这在**系统端**唤起时尤其明显
       （没有 ORB 自己的"刚唤起"标记可依赖，只能看前台是谁）。
       所以这里改成：装了 Snipaste 的话，先花 ~1.2s 分几次再看，
       期间 Snipaste 一出现就转保持；始终没出现才收。 */
    snipInstalled().then((installed) => {
      if (!installed) { gracefulClose(); return; }
      let waited = 0;
      const probe = () => {
        if (state.pinned || panelHover || ballHover || drag || holdOpen) return;
        if (snippingNow) {
          log("[panel] 观察到截屏开始，保持面板");
          scheduleClose(1200);
          return;
        }
        waited += 300;
        if (waited < 1200) { setTimeout(probe, 300); return; }
        gracefulClose();
      };
      probe();
    }).catch(() => gracefulClose());
  }, delay);
}

/** 真正收面板前再问一次划词那套判据（它认"最近是否由 ORB 唤起过"），
    两条路互为补充：snippingNow 看前台，这个看 ORB 自己的唤起记录。 */
function gracefulClose() {
  snipBlockWatch()
    .then((snipping) => {
      if (snipping) { log("[panel] 截屏进行中（复查），推迟折叠"); scheduleClose(1200); return; }
      if (state.pinned || panelHover || ballHover || drag || holdOpen) return;
      closePanel();
    })
    .catch(() => closePanel());
}

/* ---------------- 截屏态轮询 ----------------
 * 为什么不能「等要折叠时才查一次前台进程」：
 *   ① nativeForegroundRect 首次调用时常驻探针还没回 ready，直接返回 null；
 *   ② Snipaste 的框选往往刚开始，只查一次很容易落在它拿到前台之前。
 * 两者叠加的结果就是：系统端唤起 Snipaste → 一查不准 → 面板当场收掉，
 * 用户想「再框一次」时控制台已经缩回去了（用户实测反馈）。
 * 改为面板可见期间持续轮询（600ms 一次，只是给常驻探针写一行，开销可忽略），
 * 维护 snippingNow，折叠判定直接读它。 */
let snipPollTimer = null;
let snippingNow = false;
function startSnipPoll() {
  log("[snip] startSnipPoll 被调用，timer=", !!snipPollTimer);
  fgEnsure();
  if (snipPollTimer) return;
  log("[snip] 启动截屏态轮询（常驻）");
  const tick = async () => {
    /* 判据：Snipaste 是否处在截屏会话中（见 nativeSnipping 的注释）。
       ⚠️ 必须重试：探针是**单通道**的，观察边框每 500ms 也在查前台，
       两个查询共用一个 fgPending —— 先到的那个会被后到的 settle(null) 打断，
       于是 snip 查询经常拿到 null（表现为"明明在框选却判定没在截"）。
       多问几次就能绕开这个争用，代价只是几十毫秒。 */
    let byWindow = false;
    for (let i = 0; i < 3; i++) {
      byWindow = await nativeSnipping().catch(() => false);
      if (byWindow) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    /* 前台进程判断只作补充：Snipaste 的浮层常常不抢前台，靠它会漏判。 */
    const fg = byWindow ? null : await nativeForegroundRect().catch(() => null);
    const now = byWindow || !!(fg && fg.exe && /snipaste/i.test(String(fg.exe)));
    if (now !== snippingNow) {
      snippingNow = now;
      log("[snip] 截屏态", now ? "进入（保持面板不折叠）" : "退出");
    }
  };
  tick();
  snipPollTimer = setInterval(tick, 600);
}
function stopSnipPoll() {
  if (snipPollTimer) { clearInterval(snipPollTimer); snipPollTimer = null; }
  snippingNow = false;
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
let panelTheme = 't2';

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
    applyToolbarTheme();
  });
  toolbar.on("blur", () => toolbar && toolbar.hide());
  toolbar.on("closed", () => { toolbar = null; toolbarReady = false; pendingToolbarText = null; });
}

/* 把当前主题同步给划词工具栏（toolbar.html 是独立窗口、自己没有主题系统，
   靠这里给 <html> 打 data-theme 才能跟随面板换肤；面板没报过主题时退回浅色）。
   换肤时面板会经 theme-changed 报新主题名 + 算完的令牌族，这里即时重打/重推。
   executeJavaScript 走 CDP 求值，不受页面 CSP script-src 约束（border.html 无脚本也推得动）。 */
let panelThemeVars = {};
/* 小窗里有一批写法是 `rgba(var(--ac-rgb), .5)` —— 需要一个 "r,g,b" 三元组，
   而面板报上来的 --accent 是 hex。统一在这里算一次，省得每个小窗各写一份 hex 解析
   （写错了不报错、只是颜色静默退回兜底值，正是本项目最烦的一类 bug）。 */
function hexToRgbTriple(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  return ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255);
}
/* 强调色实底上该用白字还是黑字：按 WCAG 相对亮度选对比度高的一支。
   覆盖层的"选中预设/主按钮"是**实底**（不像面板 .chip.sel 是浅底深字），
   写死一个 #10203a 碰上青柠、浅黄这类强调色就整颗钮糊掉。 */
function pickOnColor(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(((n >> 16) & 255) / 255)
    + 0.7152 * lin(((n >> 8) & 255) / 255)
    + 0.0722 * lin((n & 255) / 255);
  return 1.05 / (L + 0.05) >= (L + 0.05) / 0.05 ? "#ffffff" : "#101828";
}
function themeVarsScript() {
  let vars = panelThemeVars;
  const accent = panelThemeVars["--accent"];
  const triple = hexToRgbTriple(accent);
  const on = pickOnColor(accent);
  if (triple) {
    vars = Object.assign({}, panelThemeVars, { "--ac-rgb": triple });
    if (on) vars["--ac-on"] = on;
  }
  return "(() => { const v = " + JSON.stringify(vars) +
    "; for (const k in v) { try { document.documentElement.style.setProperty(k, v[k]); } catch {} } })()";
}
function applyToolbarTheme() {
  if (toolbar && toolbarReady && !toolbar.isDestroyed()) {
    try {
      /* 用 JSON.stringify 传参而不是字符串拼接：主题名来自渲染层，
         拼进可执行源码就是一个注入点（工具条共用面板那份全量 preload 白名单）。 */
      toolbar.webContents.executeJavaScript(
        "document.documentElement.setAttribute('data-theme'," + JSON.stringify(panelTheme) + ");" + themeVarsScript());
    } catch {}
  }
}
/* 令牌族推给所有活着的小窗：悬浮球 / 录制边框 / 字幕窗 / 悬浮控制条 / 录屏选区 / 摄像头摆位。
   这些窗口没有主题系统，只认推进来的 CSS 变量；推不了就保持各自默认（不致命）。
   录屏选区与摄像头摆位是 v1.4.3 新增的两个全屏覆盖层：它们压在桌面上、底色必须恒深
   （浅色 HUD 遇上白窗口就看不见），但**强调色要跟面板同一支**，否则面板是紫、浮层是蓝，
   就是"外来色"。所以这两个只吃 --accent 家族，不吃 --bg/--fg 那套明暗。 */
function pushThemeVars() {
  if (!Object.keys(panelThemeVars).length) return;
  const js = themeVarsScript();
  for (const w of [ball, borderWin, subWin, recbarWin, regionWin, camStageWin]) {
    if (w && !w.isDestroyed()) { try { w.webContents.executeJavaScript(js); } catch {} }
  }
}
ipcMain.on("theme-changed", (_e, name, vars) => {
  /* 主题名只认白名单：它会被拼进 executeJavaScript 推给小窗，
     放任意字符串过去就是把渲染层的输入当成可执行源码。 */
  if (name && THEME_IDS.includes(name)) panelTheme = name;
  if (vars && typeof vars === "object") panelThemeVars = vars;
  applyToolbarTheme();
  pushThemeVars();
});

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
  /* ⚠️ Electron 44 的 clipboard.readText() 返回 **Promise<string>**（不是 string）。
     忘了 await 的话，`before`/`text` 都是 Promise 对象，
     `text !== before` 恒为 true → 把上一个 Promise 当成"选中的文字"返回。 */
  const before = await clipboard.readText();
  await bridgeCall("Shortcut", { shortcut: "ctrl+c" }, 8000).catch(() => {});
  await new Promise((r) => setTimeout(r, 320));
  const text = await clipboard.readText();
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
  /* ⚠️ Electron 44：clipboard.readText() 返回 **Promise<string>**，
     clipboard.has(...) 返回 **Promise<boolean>** —— 都必须 await。
     （readImage 则已被彻底移除：只剩 clear/has/read/readText/write/writeText。） */
  const hadText = await clipboard.readText();
  /* 判断"剪贴板里是不是只有图、没法还原" —— 用 has 探，不真把图读出来。 */
  let hadImage = false;
  try { hadImage = await clipboard.has("image/png"); } catch { /* 读不到就当没有 */ }

  if (!hadText && hadImage) return null;   // 无法还原，宁可不取

  await bridgeCall("Shortcut", { shortcut: "ctrl+c" }, 8000).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const text = await clipboard.readText();

  if (hadText && text !== hadText) {
    try { await clipboard.writeText(hadText); } catch {}
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

/**
 * 截屏进行中？—— 是就别插手划词。
 *
 * Snipaste 的框选和划词是同一个手势（按下 → 拖动 → 松手），会被划词监听当成
 * 一次文本选中；而监听随后注入的 Ctrl+C，在 Snipaste 截屏里等于「复制并退出」。
 * 结果就是：用户框完选区正要标注，截屏被这一下按死，而且走的是剪贴板、
 * 不写 -o 指定的文件（2026-10-23 实测：松手后 0.86s 截屏关闭、截屏目录无新文件）。
 *
 * 两道判据：
 *   ① 前台进程是不是 Snipaste —— 截屏时它的全屏覆盖层在最前面；
 *   ② 刚由我们唤起过截屏 —— 覆盖"覆盖层还没抢到前台"的那几百毫秒。
 * 探针取不到数据时保守一点：20 秒内唤起过就当仍在截屏（够一次正常标注，又不至于
 * 把划词挡太久 —— 探针正常情况下是 0.2ms 常驻的，这条分支只在它坏掉时走）。
 */
async function snipBlockWatch() {
  if (snipaste.launchedRecently(8000)) return true;
  /* 先问"Snipaste 有没有可见窗口"：框选浮层常常不抢前台，
     只看前台进程会漏判（用户框选全程前台都不是 Snipaste）。 */
  if (await nativeSnipping().catch(() => false)) return true;
  const fg = await nativeForegroundRect().catch(() => null);
  if (fg && fg.exe) return /snipaste/i.test(String(fg.exe));
  return snipaste.launchedRecently(20000);
}

async function handleWatchEvent(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type !== "select") return;
  /* 截屏期间整段跳过：不取词、不弹工具条（理由见 snipBlockWatch） */
  if (await snipBlockWatch()) {
    log("[watch] 截屏进行中，跳过划词");
    return;
  }
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
  applyToolbarTheme();
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
     偏好不在它本地存，就绪时由主进程推一次（与控制条同一套路）。
     主题令牌族一并推：字幕的高亮行/描边跟随交互色。 */
  subWin.webContents.once("did-finish-load", () => { sendSubCfg(); pushThemeVars(); });
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
let fgPending = null;          // 当前在途请求 { settle, id }
/* 直连槽：id → settle。**不参与单槽抢占**（见 nativeSnapDirect 的注释）。
 * 截屏基线查询走这条，避免被观察边框/截屏态轮询抢掉。 */
const fgDirect = new Map();
let fgSpawnAt = 0;             // 本次进程启动时刻，用来算"就绪宽限期"
let fgReqId = 0;               // 请求 id 自增：用来识别"孤儿响应"（见 fgDrain）

/** 下一个请求 id。native 端原样带回，JS 侧据此匹配。 */
function fgNextId() {
  fgReqId += 1;
  return fgReqId;
}

/** 发一条命令（带 id），返回该命令的 id。 */
function fgSend(cmd) {
  const id = fgNextId();
  try {
    fgProc.stdin.write(JSON.stringify({ cmd, id }) + "\n");
  } catch (e) {
    /* 写失败由调用方的 settle 处理，这里不抛 */
  }
  return id;
}

/** 进程没了：清干净状态，并把在途请求结算掉（绝不能让调用方挂着） */
function fgDrop() {
  const p = fgPending;
  fgPending = null;
  fgProc = null;
  fgReady = false;
  fgBuf = "";
  /* 直连槽里在途的请求也要结算掉，否则端口换了它们只能等自己的超时 */
  for (const s of Array.from(fgDirect.values())) { try { s(null); } catch { /* 单个失败不影响其它 */ } }
  fgDirect.clear();
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
    /* ⚠️ 握手行只能按「没有 id」来认，绝不能按 j.ready 判（2026-10-29 修）。
     *
     * 探针的 snap / snip 应答**本身就带 ready 字段**：
     *   {"ok":true,"id":1,"snipping":false,"ready":true,"seq":146}
     * 而原生侧只有启动握手那一行是不带 id 的：{"ok":true,"ready":true}。
     * 原来这里写 `if (j && j.ready)` 且排在 id 分派之前 —— 结果是
     * **每一次查询的应答都被当成握手吞掉**，一个都投递不到等待方：
     *   · 截屏基线查询 9 次全撞满 1500ms 超时 → 9×1.5s ≈ 13.5s
     *     → 实测「点下截屏到浮层就绪」14.9 秒，用户体感"点了没反应"；
     *   · 更糟的是基线取不到 → 直接放弃本次截屏，截图根本不落盘；
     *   · nativeSnipping / nativeSnapState 同样永远超时 → "Snipaste
     *     已在框选中"守卫失效、取消判定失效（要等满 180 秒）。
     * 前台窗口查询（fg）的应答**不含 ready**，所以观察边框一直是好的 ——
     * 这也是这个 bug 藏得住、只表现为"截屏慢"的原因。 */
    if (j && j.id === undefined && j.ready) { fgReady = true; continue; }
    /* 直连槽优先：它的 id 一定在自己的表里，按 id 精确交付，不走单槽。 */
    if (j && typeof j.id === "number" && fgDirect.has(j.id)) {
      const s = fgDirect.get(j.id);
      fgDirect.delete(j.id);
      try { s(j); } catch { /* 回调内部异常不影响管道 */ }
      continue;
    }
    if (!fgPending) continue;
    /* ⚠️ 按 id 匹配，不要把**任意**响应行塞给当前占槽者（2026-10-24 修）。
     *
     * 为什么：新查询会抢占旧查询（把旧的 settle(null) 掉），但被抢占那条
     * 请求的**响应行照样会从 stdout 回来**。管道是 FIFO，于是这条"孤儿
     * 响应"会被投递给下一个占槽者 —— 响应错配。
     * 实测错配率 4.7%、最坏连续 2 轮；而"连续 2 轮 snipping=false"正好
     * 是「判用户取消」的阈值 → 一次错配就把正常截图判成取消、丢掉用户的图。
     *
     * 现在：id 对得上才交付；对不上就是孤儿响应，丢弃。
     * （老版本 exe 不回 id —— 那时没有 id 机制，响应内容也不一样，
     *   这里保留"没有 id 字段就按 FIFO 兜底"的兼容分支。） */
    if (typeof j.id === "number" && fgPending.id !== j.id) continue;   // 孤儿响应，丢弃
    const p = fgPending; fgPending = null; p.settle(j);
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
    const id = fgSend("fg");
    fgPending = { settle, id };
  });
}

/* Snipaste 是否正在截屏（框选 / 标注栏）。
 *
 * 判据是「Snipaste 有没有处在截屏会话中」而不是「前台是不是 Snipaste」——
 * 后者根本不成立：Snipaste 的框选浮层不抢前台，实测用户框选全程
 * 前台进程一次都不是 Snipaste（日志里 [snip] 截屏态 一次都没进入）。
 *
 * ⚠️ 这条判据在 native 侧返工过三次（详见 orb-foreground.c 里 enum_snip
 * 的注释）：绝对判据实测都会失效。**现在排除的是 Snipaste 主面板**
 *   （标题 "Snipaste" + class 带 ToolSaveBits）—— 用户点托盘图标弹出的
 *   那个面板与截屏无关，早期版本把它算进去，导致"已在框选中"永远成立。
 *
 * ⚠️ 超时兜底返回 **false**（而不是 true）：这里的用途是
 *   「Snipaste 已经在框选中就别再发一次 snip 命令」（连发会让 Snipaste
 *   状态错乱：标注工具栏不出现、第二次截取直接关闭）。
 *   ⚠️ 但这是**截图功能的唯一入口守卫** —— 返回 true 会让用户**完全截不了图**
 *   （探针刚起来时 fgReady 还是 false）。两害相权：
 *     · 误报 false（其实在框选）→ 重复发 snip → Snipaste 状态错乱，可恢复；
 *     · 误报 true（其实不在框选）→ 截图功能整个不可用。
 *   所以兜底必须是 false。
 *   ⚠️ 但"探针没就绪"和"查过了，确认不在框选中"是两回事 ——
 *     前者返回 false 会让守卫失效（重复发 snip）。
 *     所以调用方**必须先等探针就绪**再查（见 waitFgReady），
 *     别把"没查到"当成"不在框选中"。
 *   复用同一条常驻管道，单次同样是毫秒级。 */
function nativeSnipping() {
  return new Promise((resolve) => {
    if (!fgEnsure() || !fgReady) return resolve(false);
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (fgPending && fgPending.settle === settle) fgPending = null;
      /* fgDrain 递回来的是整行 JSON（{"ok":true,"snipping":true}），不是布尔 */
      resolve(!!(v && v.snipping));
    };
    /* 超时/被打断 → settle(null) → false（兜底，见上） */
    const timer = setTimeout(() => settle(null), FG_REQ_MS);
    if (fgPending) { const p = fgPending; fgPending = null; p.settle(null); }
    const id = fgSend("snip");
    fgPending = { settle, id };
  });
}

/**
 * 等常驻探针就绪（收到过 {"ok":true,"ready":true}）。
 *
 * 为什么需要：nativeSnipping() 在探针未就绪时返回 false（保守兜底），
 * 而它的调用方是「已在框选中就别重复发 snip」的守卫 —— 探针没就绪时
 * 这个 false 会让守卫**失效** → 重复发 snip → Snipaste 状态错乱
 * （标注工具栏不出现、第二次截取直接关闭）。
 * 所以守卫必须**先确保探针就绪**，再问"在不在框选"。
 *
 * 超时 2 秒：探针正常起来是毫秒级；2 秒还没好就当它坏了，
 * 让守卫失效（宁可重复发一次 snip，也不能整个截屏功能不可用）。
 */
function waitFgReady(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (fgEnsure() && fgReady) return resolve(true);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fgReady) { clearInterval(iv); resolve(true); return; }
      if (Date.now() - t0 >= timeoutMs) { clearInterval(iv); resolve(false); }
    }, 50);
  });
}

/**
 * 截屏态 + 剪贴板序列号，**一次往返**取三样。
 *
 * 为什么合并：orb-foreground 是**单通道**管道，观察边框每 500ms 查一次前台、
 * 截屏轮询再查一次，两者共用一个 fgPending —— 后到的会把先到的 settle(null)
 * 打断。查询种类越多，争用越频繁（表现为"明明在框选却判定没在截"）。
 * 截屏流程要的正是这几样，合成一条最省。
 *
 * 返回 { known, snipping, ready, seq }
 *   known=false → 这次没查准（探针还没起来 / 被打断 / 超时）。
 *         ★ 这时 snipping **一律填 true**（"还在框选"），
 *           调用方按"保守地认为还在框选"处理。
 *           ⚠️ 两处 known=false 必须同值：之前一处填 false 一处填 true，
 *             语义不一致 → 取消判定在"探针恰好失败"时会误触发（丢截图）。
 *   snipping = Snipaste 是否处在截屏会话（框选浮层 / 标注栏）中。
 *         ★ 调用方靠 **true → false 的跳变** 判断"用户取消了"，
 *           不靠绝对值。native 侧的判据返工过四次（详见 orb-foreground.c
 *           里 enum_snip 上方的注释）—— 绝对判据（有可见窗口 / hwnd 集合变化 /
 *           黑名单排除）在实测中都会失效。
 *   ready    = Snipaste 的框选浮层窗口**是否存在**（不论可见与否）。
 *         ★ 和 snipping 语义不同，别混用。它用来区分两种"没有截屏态"：
 *           · ready 是 false → 这个 Snipaste 压根没有框选浮层
 *             （版本不同 / 功能被禁用）→ 可以早点放弃本次截屏；
 *           · ready 是 true 但 snipping 是 false → 浮层窗口在但当前不可见
 *             → 可能用户开着贴图窗，也可能浮层还没建出来 → 此时**绝不能**
 *             用"没进过截屏态"去否定用户，只能等剪贴板序列号变化或总超时。
 *           ⚠️ 早期版本这里用的是「Snipaste 有任何可见窗口」（alive），
 *             实测**太宽**：Snipaste 空闲时主面板 169×221 就是常可见的
 *             → alive 恒为 true → "压根没弹框选"的兜底永远不触发
 *             → 面板被锁 180 秒。
 *   seq = Windows 剪贴板序列号（GetClipboardSequenceNumber），**内容被改写就 +1**，
 *         与内容无关 —— 用它判断"剪贴板被写过"比比较图片字节可靠得多：
 *         · 新旧图字节完全相同 → 指纹法失效，序列号照样变；
 *         · 基线读取失败 → 指纹法会把旧图当成本次截图落盘，序列号法没这个问题。
 */
function nativeSnapState() {
  return new Promise((resolve) => {
    /* ⚠️ known=false 时 ready 填 false —— 它表示"没查到"，
       不是"确认没有浮层窗口"。调用方必须先看 known 再用 ready，
       别把"没查到"当成"没有"。 */
    if (!fgEnsure() || !fgReady) return resolve({ known: false, snipping: true, ready: false, seq: -1 });
    let done = false;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (fgPending && fgPending.settle === settle) fgPending = null;
      /* settle(null) = 被打断/超时 → known=false，调用方按"还在框选"保守处理。 */
      if (v === null) return resolve({ known: false, snipping: true, ready: false, seq: -1 });
      resolve({
        known: true,
        snipping: !!(v && v.snipping),
        ready: !!(v && v.ready),
        seq: (v && typeof v.seq === "number") ? v.seq : -1,
      });
    };
    const timer = setTimeout(() => settle(null), FG_REQ_MS);
    if (fgPending) { const p = fgPending; fgPending = null; p.settle(null); }
    const id = fgSend("snap");
    fgPending = { settle, id };
  });
}

/**
 * 同样的 snap 查询，但走**直连槽**（按 id 精确交付，不抢不打断）。
 *
 * 为什么需要：nativeSnapState 是单槽设计 —— 后到的查询会把先到的
 * settle(null) 打断。观察边框（500ms）与截屏态轮询（600ms）同时在跑，
 * 截屏键点下去那一刻，**基线查询几乎必然被别人抢掉**：
 * 响应确实回来了（日志里能看到带 seq 的那一行），但占槽者已经换成
 * 别人的请求 → 按 id 判定成孤儿响应丢弃 → 基线取不到 →
 * 「放弃本次截屏」。用户看到的就是「点了截屏，Snipaste 弹出来了，
 * 但截图没存」。改成直连槽后基线查询独占自己的 id，谁也抢不走。
 *
 * @returns {Promise<object|null>} 原样返回探针应答；超时/探针不可用给 null
 */
function nativeSnapDirect(timeoutMs = 600) {
  return new Promise((resolve) => {
    if (!fgEnsure() || !fgReady) return resolve(null);
    let done = false;
    let id = -1;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fgDirect.delete(id);
      resolve(v || null);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    id = fgSend("snap");
    fgDirect.set(id, settle);
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
  /* 边框无脚本无 preload：令牌族只能由主进程 executeJavaScript 推进来（CDP 求值不受 CSP 约束） */
  borderWin.webContents.once("did-finish-load", () => { pushThemeVars(); log("[border] theme pushed"); });
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

/* ---------------- 附件（加号）：引用语义，不拷贝文件 ----------------
 * 对话框在主进程（渲染层没有 fs 权限），选完只回 {name,path,size}——
 * 文件本身原地不动，面板把路径拼进任务文本，后台 Agent 凭路径读取。
 * ⚠️ 本文件模块顶层不许直接调用 dialog 等 ready-gated API（见文件头事故注释），
 *    所以所有逻辑都收在这些函数体内，由 safeHandle 回调触发。 */
const ATTACH_MAX_SIZE = 100 * 1024 * 1024;   // 单文件 100MB 上限，超过跳过并计数
const ATTACH_PREVIEW_MAX = 4 * 1024 * 1024;  // 缩略图 4MB 上限（与主题背景图一致）
const ATTACH_IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

async function pickAttachments() {
  const r = await dialog.showOpenDialog({
    title: "选择要引用的文件",
    filters: [
      {
        name: "常见格式",
        extensions: [
          "png", "jpg", "jpeg", "gif", "webp", "bmp",
          "mp4", "mov", "webm", "mp3", "wav", "m4a", "flac",
          "pdf", "txt", "md", "doc", "docx", "xls", "xlsx",
          "ppt", "pptx", "csv", "json", "zip",
        ],
      },
      { name: "所有文件", extensions: ["*"] },
    ],
    properties: ["openFile", "multiSelections"],
  });
  /* 取消不是错误：回空列表，面板什么都不做 */
  if (r.canceled || !r.filePaths.length) return { ok: true, files: [], skipped: 0, failed: 0 };
  const files = [];
  /* skipped 与 failed 分开数：一个是「超限」一个是「读不到」，面板要分开提示，
     混在一起会让「文件被删/无权限」也报成「超过 100MB」，文案不精确。 */
  let skipped = 0;
  let failed = 0;
  for (const p of r.filePaths) {
    let size = 0;
    try { size = fs.statSync(p).size; }
    catch { failed++; continue; }
    if (size > ATTACH_MAX_SIZE) { skipped++; continue; }
    files.push({ name: path.basename(p), path: p, size });
  }
  return { ok: true, files, skipped, failed };
}

/* 缩略图：只读图片扩展名且 ≤4MB，转 data URL 回面板；
   非图片 / 超限 / 读失败一律 { ok: false }，面板收到后移除那个 <img>。 */
function attachPreview(p) {
  if (typeof p !== "string" || !p) return { ok: false };
  const ext = path.extname(p).slice(1).toLowerCase();
  if (ATTACH_IMG_EXT.indexOf(ext) < 0) return { ok: false };
  let size = 0;
  try { size = fs.statSync(p).size; } catch { return { ok: false }; }
  if (size > ATTACH_PREVIEW_MAX) return { ok: false };
  try {
    const buf = fs.readFileSync(p);
    const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString("base64")}` };
  } catch {
    return { ok: false };
  }
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
  /* 前台探针在这里就拉起来常驻。
     否则它要等到第一次 nativeForegroundRect() 才 spawn，而那一次必然返回 null
     （探针还没回 ready）——「系统端唤起 Snipaste 时面板别缩回」的判据正是靠它，
     首次不准就等于判不出来，面板当场收掉。 */
  fgEnsure();
  /* ⚠️ startSnipPoll() 必须放在 logPath 赋值**之后**：
     log() 在 logPath 还是 null 时只往控制台打、不落盘，
     放前面会让这里所有 [snip] 日志凭空消失，排查时完全看不到。
     （轮询本身是异步的，所以晚一点启动不影响功能。） */
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
  /* 截屏态轮询：常驻，不等面板打开。必须放在 logPath 赋值之后（见上面的说明）。 */
  startSnipPoll();

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
        /* 自定义模型配置的绝对路径（与 cm-set 写的同一个文件）。
           bridge 自己读它发请求 —— 明文 key 因此不必经过渲染层，也不进 HTTP。 */
        ORB_CM_FILE: cmFile(),
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
    /* ⚠️ Electron 44 的 readText() 返回 Promise —— 必须 await，
       否则塞给面板的是 "[object Promise]"。 */
    const text = await clipboard.readText().catch(() => "");
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
}).catch((e) => {
  /* 启动链是一整条 async：中间任何一步抛了（比如托盘图标缺失导致 new Tray 失败）
     都会让后面全部不执行 —— 应用起来没球、没面板、没快捷键，而日志里只有一行
     unhandledRejection。这里至少把栈打出来。 */
  log("[boot] 启动链失败:", (e && e.stack) || String(e));
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
  /* 原生录屏要最先收：它有自己的文件要 Finalize（写 moov）。这里只做"关 stdin
     让它走 EOF→stop 优雅收尾 + 3s 后兜底 kill"，不阻塞退出 —— 子进程在父进程
     退出后仍会把 mp4 写完。放在早退 return 之前，保证有无桥都会执行。 */
  try { capNative.shutdown(); } catch { /* 退出路径上不允许再抛 */ }
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
  resetCaptureShield();   // 退出前无条件恢复可截图（计数可能已经漂了）
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
  /* 下面两个常驻子进程以前漏在了退出清单里：
     · orb-foreground.exe（划词取类名用的常驻探针）—— 父进程退出 Windows 不会
       自动带走它，反复启停会在后台越积越多；
     · 截屏态轮询（600ms）—— 不停的话 tick 会一直查窗口类名，直到进程真的没了。 */
  stopSnipPoll();
  try { fgStop(); } catch { /* 退出路径上不允许再抛 */ }
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
/* 划词工具条总开关：来自「设置 › 通道」面板拨杆。语义与右键菜单的
   划词自动弹出完全一致 —— 落盘 + 启停监听 + 隐藏已弹出的工具条。 */
/* 录屏 / 截屏「隐藏控制台」开关：语义同 set-autoselect —— 落盘 + 立即生效。
   key 只认 "rec" / "snip" 两个值，其它一律忽略（不给自己留通用写状态的口子）。 */
ipcMain.on("set-hide-console", (_e, key, v) => {
  const on = !!v;
  if (key === "rec") saveState({ recHideConsole: on });
  else if (key === "snip") saveState({ snipHideConsole: on });
  else return;
  log("[hide-console]", key, "=", on);
});
/* 录屏开始 / 结束：面板报过来，由主进程决定到底藏不藏、还还不还。
   返回"是否真的整窗隐藏了"，面板据此改提示文案。 */
safeHandle("rec-hide-console", async (_e, on) => {
  if (on) return { hidden: hideConsoleForRec() };
  return { restored: restoreConsoleAfterRec() };
}, () => ({ hidden: false, restored: false }));
ipcMain.on("set-autoselect", (_e, v) => {
  const on = !!v;
  saveState({ autoSelect: on });
  if (on) startSelectionWatch();
  else { stopSelectionWatch(); if (toolbar && !toolbar.isDestroyed()) toolbar.hide(); }
});
ipcMain.on("busy", (_e, v) => sendToBall("busy", !!v));
/* 动效总开关（面板「外观 › 动效」）。主进程留一份，是因为面板报过来的时候
   悬浮球未必加载完了 —— createBall 的 did-finish-load 里会再补推一次。
   默认 true：面板没报过（旧存档）就按"有动效"走，和面板自身的默认一致。 */
let motionOn = true;
ipcMain.on("motion", (_e, v) => { motionOn = !!v; sendToBall("motion", motionOn); });

/* 个性偏好（设置 › 个性）。和 motion 同一个理由：面板报过来时球可能还没加载完，
   主进程留一份，createBall 的 did-finish-load 里补推。
   白名单化是硬要求 —— 这是渲染层能写的唯一一份"会影响球怎么演"的状态，
   不收窄就等于让面板能往球里塞任意串（球的 DOM 里会用到它）。 */
const PERSONA_IDS = new Set(["off", "gentle", "genki", "joker", "comrade", "guide", "tsundere"]);
const GIF_IDS = new Set(["done", "greet", "loading", "nod", "shy", "sleep", "think"]);
let characterCfg = {
  persona: "gentle",
  gif: { enabled: true, off: [] },
  memory: { enabled: false, project: "", auto: true },
  tts: { enabled: false, offline: true, gen: true },
};
function sanitizeCharacter(raw) {
  const o = (raw && typeof raw === "object") ? raw : {};
  const persona = PERSONA_IDS.has(o.persona) ? o.persona : "gentle";
  const g = (o.gif && typeof o.gif === "object") ? o.gif : {};
  const off = Array.isArray(g.off) ? g.off.filter((x) => GIF_IDS.has(x)) : [];
  const m = (o.memory && typeof o.memory === "object") ? o.memory : {};
  /* 旧版 memory 是 {enabled, source:'project'|'chat'}（读哪个文件），新版是本地记忆库 +
     project 锚（空串 = 全局，非空 = 只取该项目的条目）+ auto 自动写入。
     2026-10-31 之前这里还按 source 非空来卡 enabled，新版面板没有 source 字段，
     结果 enabled 被永久压成 false —— 面板开了、球收到的却是关。现已按新模型校验。 */
  const project = typeof m.project === "string" ? m.project.slice(0, 200) : "";
  const t = (o.tts && typeof o.tts === "object") ? o.tts : {};
  return {
    persona,
    gif: { enabled: g.enabled !== false, off: [...new Set(off)] },
    memory: { enabled: !!m.enabled, project, auto: m.auto !== false },
    /* 球只关心「开没开声音」和「能不能走离线包」，其余 TTS 参数留在面板侧，不必中转。 */
    tts: { enabled: !!t.enabled, offline: t.offline !== false, gen: t.gen !== false },
  };
}
ipcMain.on("character", (_e, cfg) => {
  characterCfg = sanitizeCharacter(cfg);
  sendToBall("character", Object.assign({}, characterCfg, { gifMeta: animMeta() }));
});

/* 动图的真实循环时长：球要「只播一遍」就必须知道一张 GIF 转完一圈是多少毫秒。
   浏览器没有这个 API（currentTime / duration 都不给），所以只读 GIF 的块结构
   把帧延时表算出来 —— 不解码像素，7 张加起来也就几毫秒，结果按路径缓存。 */
const animMetaCache = Object.create(null);
function skipGifSubBlocks(b, p) {
  while (p < b.length) {
    const n = b[p++];
    if (n === 0) return p;
    p += n;
  }
  return p;
}
function readGifMeta(absPath) {
  if (animMetaCache[absPath]) return animMetaCache[absPath];
  let meta = { frames: 0, loopMs: 0 };
  try {
    const b = fs.readFileSync(absPath);
    if (b.length < 14 || b.toString("latin1", 0, 3) !== "GIF") throw new Error("not gif");
    const packed = b[10];
    let p = 13;
    if (packed & 0x80) p += 3 * (1 << ((packed & 0x07) + 1));  // 全局调色板
    let delayCs = 0;
    let frames = 0;
    let total = 0;
    while (p < b.length) {
      const tag = b[p++];
      if (tag === 0x3b) break;                                 // trailer
      if (tag === 0x21) {                                       // 扩展块
        const label = b[p++];
        /* 图形控制扩展：延时两字节小端，单位 1/100 秒 */
        if (label === 0xf9 && b[p] >= 4) delayCs = b[p + 2] | (b[p + 3] << 8);
        p = skipGifSubBlocks(b, p);
        continue;
      }
      if (tag === 0x2c) {                                       // 图像描述符
        const lp = b[p + 8];
        p += 9;
        if (lp & 0x80) p += 3 * (1 << ((lp & 0x07) + 1));        // 局部调色板
        p += 1;                                                 // LZW 最小码长
        p = skipGifSubBlocks(b, p);
        frames += 1;
        /* 0 与 1（=10ms）会被浏览器统一抬到 100ms，这里跟着抬；
           不然算出来的总时长会比实际短一大截，"播一遍"会半路掐断。 */
        total += (delayCs <= 1 ? 10 : delayCs) * 10;
        delayCs = 0;
        continue;
      }
      break;   // 认不出的块就停，别把后面的像素数据当结构读
    }
    meta = { frames, loopMs: total };
  } catch {
    meta = { frames: 0, loopMs: 0 };
  }
  animMetaCache[absPath] = meta;
  return meta;
}
const ANIM_FILES = {
  done: "logo_anim_done_v8.gif",
  greet: "logo_anim_greet_v8.gif",
  loading: "logo_anim_loading_v9.gif",
  nod: "logo_anim_nod_v8.gif",
  shy: "logo_anim_shy_v8.gif",
  sleep: "logo_anim_sleep_v8.gif",
  think: "logo_anim_think_sym_v8.gif",
};
function animMeta() {
  const out = {};
  for (const id of Object.keys(ANIM_FILES)) {
    out[id] = readGifMeta(path.join(__dirname, "anim", ANIM_FILES[id]));
  }
  return out;
}

/* 「发出了一条任务」是独立于 busy 的信号：busy 要等 Agent 真的开始跑才来，
   那时头像已经在"思考"了，点头（收到任务）就只能被吞掉。 */
ipcMain.on("task-sent", () => sendToBall("recv"));
/* 面板指定悬浮球播某张动图（陪伴层的专属行为用）。只转发 id，播放逻辑在球那边。 */
ipcMain.on("gesture", (_e, id) => { if (typeof id === 'string') sendToBall("gesture", id); });
ipcMain.on("observe", (_e, on) => (on ? startObserve() : stopObserve()));
ipcMain.on("open-external", (_e, url) => {
  /* 只放行 http/https：任何拿到 preload 白名单的窗口（面板、划词工具条）都能调
     这个通道，不设协议闸就等于允许拉起 file://、smb:// 或任意自定义协议。
     本应用的外链只有官网 / GitHub / 文档三类，全是 https。 */
  const u = String(url || "");
  let ok = false;
  try {
    const p = new URL(u);
    ok = p.protocol === "http:" || p.protocol === "https:";
  } catch { /* 解析不了就是不合格 */ }
  if (!ok) {
    log("[open-external] 已拒绝非 http(s) 链接:", u.slice(0, 120));
    return;
  }
  shell.openExternal(u);
});

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
 *
 * 关键修复（2026-10-27）：旧实现有俩坑，导致"点开登录脚本窗口闪一下就没了"且根本起不来 CLI：
 *   ① 脚本里裸 call `codebuddy`，但本机 CLI 在 D:\orb-tools\… 且不在 PATH 中
 *      （只有 orb/local.conf 的 wbCli 才指得到）→ 永远找不到，登录脚本成了摆设；
 *   ② shell.openPath 对含中文/空格的路径（%APPDATA%/ORB 控制台/…、项目根的中文目录）
 *      会闪一下就消失（ShellExecute 对 Unicode 路径不稳）。
 *
 * 新实现：
 *   1. 与 bridge.mjs 同源解析 CLI 路径（env ORB_WB_CLI → orb/local.conf 的 wbCli → PATH where）；
 *   2. 把登录脚本生成到 os.tmpdir()（纯 ASCII，规避中文路径闪退），并把解析到的
 *      完整路径烤进脚本（带引号，含空格也不怕）；脚本自带 pause，控制台脚本结束后保持可见；
 *   3. 用 shell.openPath 打开这份 ASCII 路径脚本：它是"打开文件并让其窗口可见"的正确机制。
 *      （曾试过 spawn('cmd.exe','/k') 从 Electron GUI 主进程拉起，结果窗口根本不显示，已回退。） */
/* 异步解析：最后一步要跑 `where`，同步版会把主进程卡住（最坏 5s 超时），
   而它就在点击按钮的这条路上 —— 改成 async，主进程不被阻塞。 */
async function resolveWbCliPath() {
  const envCli = (process.env.ORB_WB_CLI || "").trim();
  if (envCli && fs.existsSync(envCli)) return envCli;
  try {
    const lp = path.join(__dirname, "..", "local.conf");
    if (fs.existsSync(lp)) {
      const j = JSON.parse(fs.readFileSync(lp, "utf8"));
      const c = String((j && j.wbCli) || "").trim();
      if (c && fs.existsSync(c)) return c;
    }
  } catch {}
  try {
    const out = await new Promise((res, rej) => {
      execFile("where", ["codebuddy"], { timeout: 5000, windowsHide: true },
        (e, stdout) => (e ? rej(e) : res(stdout)));
    });
    const lines = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return "";
    const exe = lines.find((l) => /\.exe$/i.test(l));
    return exe || lines[0];
  } catch {}
  return "";
}

safeHandle("open-cli-login", async () => {
  const cli = await resolveWbCliPath();
  const gen = path.join(require("os").tmpdir(), "orb-codebuddy-login.cmd");
  const cliLine = cli
    ? `"${cli}" login`
    : [
        "echo ❌ 未检测到 CodeBuddy CLI。",
        "echo    1) 安装：npm i -g @tencent-ai/codebuddy-code  （需 Node.js 18.20+）",
        "echo       或 PowerShell 执行  irm https://www.codebuddy.cn/cli/install.ps1 | iex",
        "echo    2) 或设置环境变量 ORB_WB_CLI 指向 codebuddy.exe，再点「打开登录脚本」",
        "echo    3) 或在本机 orb/local.conf 写 {\"wbCli\":\"…完整路径…\"}",
      ].join("\r\n");
  const script = [
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
    cliLine,
    "echo.",
    "echo CLI 已退出（退出码 %ERRORLEVEL%）。",
    "echo 登录成功后回到 ORB，设置 → 通道 → 「重新检测」，再发一次后台任务即可。",
    "echo.",
    "pause",
    "",
  ].join("\r\n");
  try {
    fs.writeFileSync(gen, script, "utf8");
  } catch {
    return false;
  }
  // 主路径：shell.openPath —— "打开文件并让其窗口可见"的正确机制（gen 落在 os.tmpdir()
  // 纯 ASCII，规避它对中国/空格路径的闪退；脚本自带 pause，结束后窗口保持可见）。
  // 极少数环境 shell.openPath 会抛异常 / 返回错误串，回退到 spawn('cmd.exe','/k')
  // （不 detached，保证从 GUI 主进程也能弹出可见控制台）。脚本里已清掉
  // ELECTRON_RUN_AS_NODE，防 Electron 型 CLI 以 node 模式秒退。
  let err = "";
  try { err = await shell.openPath(gen); } catch (e) { err = String((e && e.message) || e); }
  if (!err) return true;
  try {
    spawn("cmd.exe", ["/k", `"${gen}"`], { windowsHide: false });
    return true;
  } catch {
    return false;
  }
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
  /* ⚠️ 这里**没有** translate 分支了：划词工具条的「翻译」不再把文字塞进对话框
     （那正是用户抱怨的"只是把选中的文字添加进控制台对话框"），而是走下面这条
     轻量翻译通道，译文直接回给工具条显示成一张可复制的小卡。
     这一支现在只服务「搜索 / 发给 Agent」。 */
  const payload = text;
  if (panel && panel.isVisible()) {
    sendToPanel("prefill", payload);
    sendToPanel("focus-route", "auto");
  } else {
    prefillQueue.push(payload);
    openPanel();
  }
});

/* 划词「翻译」：一条**纯翻译**的旁路 —— 不派任务、不调工具、不碰输入框。
   自定义模型优先，没配就退回后台 CLI（桥里同一个套路，见 bridge 的 runTranslate）。
   工具条拿到译文后把自己变成一张小卡（见 toolbar.html）。 */
safeHandle("toolbar-translate", async (_e, text) => {
  try {
    const token = bridgeTokenSync();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Orb-Token"] = token;
    const r = await fetch(`http://127.0.0.1:${PORT}/api/translate`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: String(text || "").slice(0, 2000) }),
      signal: AbortSignal.timeout(35000),
    });
    const j = await r.json();
    return j && typeof j === "object" ? j : { ok: false, error: "桥返回了非 JSON" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}, () => ({ ok: false, error: "翻译通道不可用（桥没起来）" }));

/* 「打开文件夹」键：弹系统的选文件夹对话框。
 *
 * 以前这个键点下去是 `OPEN_DIR` + 空 value → 落到 state.workspace（控制台
 * 自己的目录），于是它看起来"只能打开控制台所在文件夹"。那是**兜底值**，
 * 不是设定：Agent 说「打开文件夹 D:\xxx」时它会带 value 直达，
 * 但工具栏那颗键从来没有让人选过目录 —— 是漏了，不是有意的。
 *
 * ⚠️ 面板是 screen-saver 级置顶，比系统对话框还高：不先降下来，
 *    选夹窗口会被压在面板后面，看着就像"点了没反应"。 */
safeHandle("pick-dir", async () => {
  const lower = () => { if (panel && !panel.isDestroyed()) { try { panel.setAlwaysOnTop(false); } catch { /* ignore */ } } };
  const raise = () => { if (panel && !panel.isDestroyed()) { try { panel.setAlwaysOnTop(true, "screen-saver"); } catch { /* ignore */ } } };
  lower();
  try {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "选择要打开的文件夹" });
    if (!r || r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, cancelled: true };
    return { ok: true, path: r.filePaths[0] };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    raise();
  }
}, () => ({ ok: false, error: "选文件夹通道不可用" }));

/* 工具条显示译文时要变大：宽度拉到能读一行英文，高度给译文留几行。
   尺寸在**主进程**钳死（渲染层给多少都不信），免得一个坏数值把窗口撑到屏幕外。 */
ipcMain.on("toolbar-resize", (_e, w, h) => {
  if (!toolbar || toolbar.isDestroyed()) return;
  const nw = Math.max(180, Math.min(460, Math.round(Number(w) || 216)));
  const nh = Math.max(44, Math.min(360, Math.round(Number(h) || 44)));
  try { toolbar.setSize(nw, nh); } catch { /* 窗口正在销毁 */ }
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

/* ---------- 长期记忆引擎 IPC ----------
 * 渲染进程（面板）通过这些通道读写记忆库；所有 fs 操作都在主进程内完成，
 * 渲染进程拿不到路径、碰不到原始文件句柄。recall 供派发任务前注入上下文。 */
safeHandle("memory-recall", (_e, query, opts) => memory.recall(query || "", opts || {}));
safeHandle("memory-list", (_e, level, opts) =>
  level ? memory.list(level, opts || {}) : memory.getAllActive());
safeHandle("memory-add", (_e, entry) => {
  const row = memory.insert(entry);
  return { ok: true, row };
}, () => ({ ok: false, error: "写入失败" }));
safeHandle("memory-update", (_e, id, patch) => ({ ok: memory.update(id, patch || {}) }));
safeHandle("memory-remove", (_e, id) => ({ ok: memory.remove(id) }));
safeHandle("memory-stats", () => memory.stats());
/* 压缩：挑候选与归档都放主进程算，渲染层只决定"压不压、拿哪一层"。
   归档而非删除——原文留在 memory.json 里可回溯（status=archived 即退出召回与预算）。 */
safeHandle("memory-compact-plan", (_e, level, opts) => {
  const rows = memory.compactCandidates(level, opts || {});
  return { level, count: rows.length, chars: rows.reduce((s, r) => s + String(r.content || "").length, 0), rows };
}, () => ({ level, count: 0, chars: 0, rows: [], error: "规划失败" }));
safeHandle("memory-archive", (_e, ids, meta) => ({ ok: true, archived: memory.archiveMany(ids, meta || {}) }));
safeHandle("memory-prune", (_e, maxAgeDays) => {
  const days = Number(maxAgeDays) > 0 ? Number(maxAgeDays) : 90;
  return { ok: true, pruned: memory.pruneArchived(days * 86_400_000) };
});



/* ---------------- 录屏 / 截屏期间「隐藏控制台」 ----------------
 * 两条开关（设置 › 通道）：
 *   recHideConsole  录屏开始时把控制台**真的关掉**（不是只从采集里排除）
 *   snipHideConsole 截屏前先把面板收起，别挡着要截的内容
 *
 * 为什么"排除出采集"不够：setContentProtection 只是骗过采集器，窗口本身
 * 还戳在那儿 —— 抢鼠标、抢焦点、用户自己看得见。录屏时用户要的是
 * "控制台消失"，而不是"录出来的视频里没有控制台"。
 *
 * ⚠️ 悬浮录屏控制条（recbar）**不参与隐藏**：它是录制期间暂停 / 取消 /
 *    完成的唯一入口，跟着一起藏起来用户就"停不下来"了。设置项说明里写清楚。
 *
 * ⚠️ 唤回必须留两条路（键 + 鼠），否则"隐藏"就变成"卡死"：
 *    键 = Ctrl+Space（togglePanel 里分流到 summonConsole）
 *    鼠 = 点托盘图标（tray.on("click") 同样走 togglePanel）
 */
let consoleHiddenByRec = false;
let snipPanelHidden = false;

/** 录屏开始：按偏好真隐藏。返回是否真的隐藏了（面板据此改文案）。 */
function hideConsoleForRec() {
  if (!state.recHideConsole) return false;
  if (consoleHiddenByRec) return true;
  consoleHiddenByRec = true;
  for (const w of [panel, ball, toolbar, subWin, borderWin]) {
    if (!w || w.isDestroyed()) continue;
    try { if (w.isVisible()) w.hide(); } catch { /* 正在销毁，跳过 */ }
  }
  log("[rec] 已按偏好隐藏控制台（球 / 面板 / 划词条 / 字幕窗），悬浮控制条保留");
  return true;
}

/** 录屏结束：把藏起来的还回去。 */
function restoreConsoleAfterRec() {
  if (!consoleHiddenByRec) return false;
  consoleHiddenByRec = false;
  try { if (ball && !ball.isDestroyed()) ball.show(); } catch { /* ignore */ }
  /* 面板：录屏开始时它是开着的（用户在面板上点的「录屏」），所以录完要还回去。 */
  try { if (panel && !panel.isDestroyed()) openPanel(); } catch { /* ignore */ }
  log("[rec] 录制结束，控制台已恢复显示");
  return true;
}

/** 键鼠唤回：一旦唤回就视为"控制台回来了"，录屏结束不再强行弹开面板。 */
function summonConsole() {
  if (!consoleHiddenByRec) return false;
  consoleHiddenByRec = false;
  try { if (ball && !ball.isDestroyed()) ball.show(); } catch { /* ignore */ }
  try { if (panel && !panel.isDestroyed()) openPanel(); } catch { /* ignore */ }
  log("[rec] 录制中被唤回，控制台恢复显示");
  return true;
}

/** 截屏前收面板（开关开着才做）。录屏已隐藏时不做 —— 别抢它的状态。 */
function hidePanelForSnip() {
  if (!state.snipHideConsole || consoleHiddenByRec) return;
  if (!panel || panel.isDestroyed() || !panel.isVisible()) return;
  closePanel();
  snipPanelHidden = true;
  log("[snip] 已按偏好收起面板（截屏期间不挡屏幕）");
}

/** 截屏会话结束（落盘 / 取消 / 超时）后把面板还回去。 */
function restorePanelAfterSnip() {
  if (!snipPanelHidden) return;
  snipPanelHidden = false;
  if (consoleHiddenByRec) return;      // 录屏中：面板归录屏那边管
  try { if (panel && !panel.isDestroyed()) openPanel(); } catch { /* ignore */ }
}

/* ---------------- 框选取词（OCR） ----------------
 *
 * 原来「取词」是**整屏截一张 → 全屏 OCR → 把一屏的字全倒进对话框**
 * （用户原话："并没有出现过框选，而是将所有的文字都直接呈现在对话区域"）。
 * 那既慢又脏：整屏 OCR 会把任务栏、别的窗口、ORB 自己的界面文字一起念出来。
 *
 * 现在改成和截屏一样的交互：拖一块区域 → 只识别这块。
 * 流程：铺一块全屏透明覆盖层（pick.html）→ 用户拖框 → 覆盖层退场
 *      → 自家窗口临时排除后抓一次屏 → 按矩形裁出来 → 交本地 OCR。
 *
 * ⚠️ 覆盖层**不截屏、不碰文件**：它只产出"哪块区域"，剩下的都在主进程。
 * ⚠️ 坐标是覆盖层内的 CSS 像素（相对该显示器左上角），裁剪前按 scaleFactor 换算。
 */
let pickWin = null;
let pickResolve = null;
let pickTimer = null;
let pickPhase = "idle";   // "rect" = 等框选 / "confirm" = 等确认 / "idle" = 没有在等
let pickHiddenWins = [];

function createPickWin() {
  if (pickWin && !pickWin.isDestroyed()) return pickWin;
  pickWin = new BrowserWindow({
    show: false, frame: false, transparent: true,
    resizable: false, movable: false, focusable: true, hasShadow: false,
    skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "pick-preload.js"),
    },
  });
  pickWin.setAlwaysOnTop(true, "screen-saver");   // 与球/面板同级，谁在上面不确定 → 期间把它们藏掉
  pickWin.on("closed", () => { pickWin = null; });
  pickWin.loadFile(path.join(__dirname, "pick.html"));
  log("[pick] 取词覆盖层已创建");
  return pickWin;
}

/** 覆盖层还在就把自家窗口藏掉：同级置顶，留在屏幕上会盖住覆盖层，那块就框不了。
 *
 * ⚠️ 必须幂等（2026-10-30 修）：`pickRect` 每转一圈（含「重框」）都会调它，
 * 而原来第一行是 `pickHiddenWins = []` —— 第二圈时窗口**已经隐藏**，
 * `isVisible()` 全为 false → 一条都不记 → 结束时 `restoreAfterPick` 无事可做，
 * 面板/悬浮球永久消失（用户只能去任务管理器杀进程）。已有记录就不重来。 */
function hideForPick() {
  if (pickHiddenWins.length) return;
  for (const w of [panel, ball, toolbar, subWin, borderWin]) {
    if (!w || w.isDestroyed()) continue;
    try { if (w.isVisible()) { pickHiddenWins.push(w); w.hide(); } } catch { /* 正在销毁 */ }
  }
}
function restoreAfterPick() {
  for (const w of pickHiddenWins) {
    if (!w || w.isDestroyed()) continue;
    try { w.show(); } catch { /* ignore */ }
  }
  pickHiddenWins = [];
}

/* 覆盖层是**复用**的（hide 不 destroy），页面里的 phase 会留在上一轮。
   只 hide 不复位的话：上一轮停在 'busy'（"识别中…"）或 'confirm'（旧底图 + 旧框），
   下一次 show 出来就是一团旧的定格画面，鼠标拖框被 `phase !== 'rect'` 挡掉 ——
   用户看到的正是"框选后立即卡住、点什么都没反应"。所以收尾一律复位。 */
function resetPickPage() {
  sendToPick("pick-reset", null);
}

function closePickWin() {
  if (pickWin && !pickWin.isDestroyed()) { try { pickWin.hide(); } catch { /* ignore */ } }
  resetPickPage();
}

function sendToPick(channel, payload) {
  if (pickWin && !pickWin.isDestroyed() && pickWin.webContents && !pickWin.webContents.isDestroyed()) {
    try { pickWin.webContents.send(channel, payload); return true; } catch { /* 正在销毁 */ }
  }
  return false;
}

/** 起一次「等覆盖层回话」的等待，并挂上挂死兜底。 */
function awaitPick(phase) {
  return new Promise((resolve) => {
    const win = createPickWin();
    if (!win || win.isDestroyed()) { resolve(null); return; }
    pickPhase = phase;
    pickResolve = resolve;
    /* 挂死兜底：用户切走了、忘了这层还压在屏幕上 → 60 秒自己撤。
       没有它，整屏会一直盖着一层暗色，看起来就像死机。 */
    clearTimeout(pickTimer);
    pickTimer = setTimeout(() => {
      pickTimer = null;
      if (!pickResolve) return;
      const r = pickResolve; pickResolve = null;
      pickPhase = "idle";
      closePickWin();
      restoreAfterPick();
      r(null);
    }, 60000);
  });
}

/** 阶段一：铺覆盖层，等用户框一块。返回 CSS 像素矩形；取消 / 超时返回 null。 */
function pickRect(disp) {
  hideForPick();
  const win = createPickWin();
  if (!win || win.isDestroyed()) return Promise.resolve(null);
  win.setBounds({ x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height });
  /* 开场先复位一次：万一上一轮是被强杀/异常收尾的，页面可能还停在 busy/confirm，
     那道 `phase !== 'rect'` 会让这一轮的拖框完全没反应。复位是无害的幂等动作。 */
  resetPickPage();
  win.show();
  win.focus();
  return awaitPick("rect");
}

/* 阶段二：把「抓下来的那块图 + 每行文字的框」发回覆盖层，让用户看着确认。
 *
 * 为什么要有这一阶段（2026-10-29 加）：取词最常见的事故不是"没识别出来"，
 * 是**框歪了** —— 多框了一行菜单、少框了半句。以前只能整段重框一次；
 * 现在识别完先把每行文字用荧光框标出来，用户点掉不要的那几块即可。
 *
 * @param {{dataUrl:string,kx:number,ky:number}} shot 抓下来的区域图与缩放比
 * @param {Array<{text:string,x:number,y:number,w:number,h:number}>} boxes 覆盖层窗口坐标（CSS px）
 */
function confirmPick(shot, boxes, fullText) {
  const p = awaitPick("confirm");
  if (!sendToPick("ocr-result", { img: shot.dataUrl, boxes, text: fullText || "" })) {
    // 覆盖层没了（被关 / 创建失败）：别把流程卡死，按"整块都要"走
    clearTimeout(pickTimer); pickTimer = null;
    pickResolve = null; pickPhase = "idle";
    return Promise.resolve({ text: fullText || "" });
  }
  return p;
}

ipcMain.on("pick-done", (_e, msg) => {
  if (!pickResolve) return;
  const r = pickResolve;
  const kind = msg && msg.kind;
  /* 阶段一 → 阶段二**不关窗**：覆盖层还要接着当确认台用，
     关了再开会有一次闪烁，而且位置/状态都得重建。 */
  if (kind === "rect") {
    pickResolve = null;
    pickPhase = "idle";
    /* 这一轮等待结束了，60 秒兜底定时器必须一并撤掉 —— 它到点时 pickResolve 已经
       是 null，只会空转一圈什么都不做，白白吊着一条定时器（早期还让它跟下一轮
       的 timer 抢同一个变量）。 */
    if (pickTimer) { clearTimeout(pickTimer); pickTimer = null; }
    const rect = msg.rect;
    const ok = rect && typeof rect.x === "number" && typeof rect.width === "number";
    r(ok ? rect : null);
    return;
  }
  pickResolve = null;
  pickPhase = "idle";
  if (pickTimer) { clearTimeout(pickTimer); pickTimer = null; }
  closePickWin();
  restoreAfterPick();
  if (kind === "text") r({ text: String((msg && msg.text) || "") });
  else r(null);
});

/* 「重框」：确认台上点的。它**不是一次结束** —— 覆盖层还开着、只是退回框选态，
   所以这里只把"确认"这一轮的等待结束掉（带 redo 标记），让 ocr-pick 再转一圈。
   关窗 / 恢复自家窗口都留给真正结束的那一轮。 */
ipcMain.on("pick-redo", () => {
  if (!pickResolve || pickPhase !== "confirm") return;
  const r = pickResolve;
  pickResolve = null;
  pickPhase = "idle";
  r({ redo: true });
});

/** 抓一次屏，按矩形裁出来。返回 { dataUrl, kx, ky }（kx/ky = 图像像素 ÷ CSS 像素）。 */
async function grabRegion(disp, rect) {
  const sf = disp.scaleFactor || 1;
  const physW = Math.max(2, Math.round(disp.size.width * sf));
  const physH = Math.max(2, Math.round(disp.size.height * sf));
  let sources = null;
  /* 自家窗口（含覆盖层本身）必须临时从截图里消失，否则拍到的是 ORB 自己 */
  beginShotShield();
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: physW, height: physH },
    });
  } finally {
    endShotShield();
  }
  if (!sources || !sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(disp.id)) || sources[0];
  const img = src && src.thumbnail;
  if (!img || img.isEmpty()) return null;
  /* 缩略图的实际像素未必精确等于请求值（Electron 按屏幕比例给），
     所以按**实际尺寸**反推缩放比，别拿 sf 硬乘 —— 那会在多屏不同 DPI 时裁偏。 */
  const size = img.getSize();
  const kx = size.width / Math.max(1, disp.size.width);
  const ky = size.height / Math.max(1, disp.size.height);
  const x = Math.max(0, Math.round(rect.x * kx));
  const y = Math.max(0, Math.round(rect.y * ky));
  const w = Math.max(1, Math.min(size.width - x, Math.round(rect.width * kx)));
  const h = Math.max(1, Math.min(size.height - y, Math.round(rect.height * ky)));
  log(`[pick] 区域 ${rect.width}×${rect.height}@${sf} → 裁 ${w}×${h}（缩略图 ${size.width}×${size.height}）`);
  let dataUrl = "";
  try {
    dataUrl = img.crop({ x, y, width: w, height: h }).toDataURL();
  } catch (e) {
    log("[pick] 裁剪失败:", (e && e.message) || String(e));
    dataUrl = img.toDataURL();   // 退化成整屏：至少还能识别，只是会带上别处的字
  }
  return { dataUrl, kx, ky };
}

/** 主进程代发 OCR（面板不碰令牌）。 */
async function ocrViaBridge(dataUrl) {
  const token = bridgeTokenSync();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Orb-Token"] = token;
  const r = await fetch(`http://127.0.0.1:${PORT}/api/ocr`, {
    method: "POST", headers,
    body: JSON.stringify({ dataUrl }),
    signal: AbortSignal.timeout(45000),
  });
  const j = await r.json();
  return j && typeof j === "object" ? j : { ok: false, error: "桥返回了非 JSON" };
}

safeHandle("ocr-pick", async () => {
  const t0 = Date.now();
  try {
    /* 从**鼠标所在的**那块屏弹覆盖层：多屏时不能在别处弹。 */
    const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    /* 整轮 = 框选 → 抓图 → OCR → 确认；点「重框」就再转一圈（覆盖层始终不关）。 */
    for (;;) {
      const rect = await pickRect(disp);
      if (!rect) { log("[pick] 已取消（框选阶段）"); return { ok: false, cancelled: true }; }
      const shot = await grabRegion(disp, rect);
      if (!shot || !shot.dataUrl) { log("[pick] 失败：桌面捕获没拿到图像"); return { ok: false, error: "没拿到屏幕图像（桌面捕获失败）" }; }
      const done = await ocrOnce(shot, rect);
      if (done.redo) continue;
      log("[pick] 结束 " + (done.ok ? (done.text ? "拿到 " + done.text.length + " 字" : "没认出文字") : "未完成")
        + "，整轮 " + (Date.now() - t0) + "ms");
      return done;
    }
  } catch (e) {
    log("[pick] 异常：" + String((e && e.message) || e));
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    /* ⚠️ 这里必须无条件清场（2026-10-30 修，死锁级）。
     * 覆盖层是**整屏压暗 + screen-saver 级置顶**，而自家窗口（面板 / 悬浮球）
     * 在 `hideForPick` 里被藏掉了。原来只有"用户点了确定/取消"这一条路会
     * `closePickWin() + restoreAfterPick()`；所有提前 return 的分支 ——
     * 截图失败、OCR 一个字没认出来（empty）、任何异常 —— 都直接跑掉，
     * 结果：暗色覆盖层永远压在整屏上、写着"识别中…"、面板也不会回来。
     * 用户感受就是"框完立刻卡死，点什么都没反应"，只能杀进程。
     * （2026-10-29 那次日志停在 `[pick] 区域 …` 之后就再无一行，正是此故。）
     * 放在 finally 里，正常收尾重复调也无害：hide 幂等、restoreAfterPick 清空即空转。 */
    closePickWin();
    restoreAfterPick();
  }
}, () => ({ ok: false, error: "取词通道不可用" }));

/** 一次「抓图 → OCR → 确认」。返回 { ok, text?, dataUrl?, cancelled?, redo? }。 */
async function ocrOnce(shot, rect) {
  const ocr = await ocrViaBridge(shot.dataUrl).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    const text = String((ocr && ocr.text) || "").trim();
    /* 一个字都没认出来：没有可画的框，进确认台只是白点一次 —— 直接告诉用户。 */
    if (!text) return { ok: true, text: "", dataUrl: shot.dataUrl, empty: true };

    /* 行坐标（图像像素）→ 覆盖层窗口坐标（CSS px，相对整屏窗口左上角） */
    const lines = Array.isArray(ocr.lines) ? ocr.lines : [];
    const boxes = lines.map((l) => ({
      text: String(l.text || ""),
      x: rect.x + (Number(l.x) || 0) / shot.kx,
      y: rect.y + (Number(l.y) || 0) / shot.ky,
      w: (Number(l.w) || 1) / shot.kx,
      h: (Number(l.h) || 1) / shot.ky,
    }));
    if (!boxes.length) {   // 老环境没坐标：无从"筛选"，直接整块拿走
      return { ok: true, text, dataUrl: shot.dataUrl };
    }

    const chosen = await confirmPick(shot, boxes, text);
    if (!chosen) return { ok: false, cancelled: true };
    if (chosen.redo) return { redo: true };
    return { ok: true, text: String(chosen.text || "").trim(), dataUrl: shot.dataUrl };
}

/* ---------------- 录屏区域选择（覆盖层） ----------------
 * 与「框选取词」同源（全屏透明覆盖层 + 藏自家窗口 + 挂死兜底），但**窗口不复用、
 * 每轮新建**：region 只有单阶段（框好就走），没有 pick 那种 rect→busy→confirm
 * 的状态机，复用反而要多维护一套复位协议（pick 那几个复用坑见上面的注释）。
 *
 * 产出是**相对主显示器的归一化比例**（0..1），不是像素：
 *   · 面板存进 localStorage，换分辨率 / 改缩放比例后依然指得对地方；
 *   · 真正下发给采集器时再按 scaleFactor 换成物理像素（DXGI 用物理像素）。
 * ⚠️ native 链路只支持主显示器（--display 0），所以覆盖层只铺主屏。
 */
let regionWin = null;
let regionPending = null;      // { resolve, timer, init }
let regionHiddenWins = [];

/** 0..1 的矩形；任何一项不合法就返回 null（= 全屏）。 */
function normalizeRatio(r) {
  if (!r || typeof r !== "object") return null;
  const nums = ["x", "y", "w", "h"].map((k) => Number(r[k]));
  if (!nums.every((v) => Number.isFinite(v))) return null;
  const [x, y, w, h] = nums;
  if (w <= 0 || h <= 0) return null;
  const cx = Math.min(1, Math.max(0, x));
  const cy = Math.min(1, Math.max(0, y));
  return {
    x: cx,
    y: cy,
    w: Math.min(1 - cx, Math.max(0, w)),
    h: Math.min(1 - cy, Math.max(0, h)),
  };
}

/** 比例 → 物理像素矩形（相对主显示器左上角）。null/全屏时返回 null（= 不裁剪）。 */
function ratioToPhysical(ratio) {
  const r = normalizeRatio(ratio);
  if (!r) return null;
  // 全屏不用裁剪：少传一个 --rect，采集器走的就是原路径
  if (r.x <= 0.0001 && r.y <= 0.0001 && r.w >= 0.9999 && r.h >= 0.9999) return null;
  let disp;
  try { disp = screen.getPrimaryDisplay(); } catch { return null; }
  const sf = disp.scaleFactor || 1;
  const pw = disp.size.width * sf;
  const ph = disp.size.height * sf;
  const rect = {
    x: Math.round(r.x * pw),
    y: Math.round(r.y * ph),
    w: Math.round(r.w * pw),
    h: Math.round(r.h * ph),
  };
  if (rect.w < 16 || rect.h < 16) return null;   // 太小的区域没意义，按整屏走
  return rect;
}

/** 藏自家窗口：覆盖层是 screen-saver 级置顶，同级窗口留在上面会盖住覆盖层。幂等。 */
function hideForRegion() {
  if (regionHiddenWins.length) return;
  for (const w of [panel, ball, toolbar, subWin, borderWin, recbarWin]) {
    if (!w || w.isDestroyed()) continue;
    try { if (w.isVisible()) { regionHiddenWins.push(w); w.hide(); } } catch { /* 正在销毁 */ }
  }
}
function restoreAfterRegion() {
  for (const w of regionHiddenWins) {
    if (!w || w.isDestroyed()) continue;
    try { w.show(); } catch { /* ignore */ }
  }
  regionHiddenWins = [];
}

/** 结束一轮选择：清场 + settle。reason 只用于日志。 */
function finishRegion(msg) {
  const pending = regionPending;
  if (!pending) return;
  regionPending = null;
  if (pending.timer) { clearTimeout(pending.timer); pending.timer = null; }
  const win = regionWin;
  regionWin = null;
  if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* ignore */ } }
  restoreAfterRegion();

  const kind = msg && msg.kind;
  if (kind !== "ok") {
    log("[region] 已取消（" + (kind || "no-msg") + "）");
    pending.resolve({ ok: false, cancelled: true });
    return;
  }
  const dipRect = msg && msg.rect;
  const init = pending.init || { dip: { w: 1, h: 1 }, sf: 1 };
  const okRect = dipRect
    && ["x", "y", "w", "h"].every((k) => Number.isFinite(Number(dipRect[k])))
    && Number(dipRect.w) >= 8 && Number(dipRect.h) >= 8;
  if (!okRect) {
    log("[region] 覆盖层回传的矩形不合法，按取消处理");
    pending.resolve({ ok: false, cancelled: true });
    return;
  }
  const dw = Math.max(1, init.dip.w);
  const dh = Math.max(1, init.dip.h);
  const ratio = normalizeRatio({
    x: Number(dipRect.x) / dw,
    y: Number(dipRect.y) / dh,
    w: Number(dipRect.w) / dw,
    h: Number(dipRect.h) / dh,
  });
  log("[region] 选定 " + Math.round(dipRect.w) + "×" + Math.round(dipRect.h)
    + " @ " + Math.round(dipRect.x) + "," + Math.round(dipRect.y)
    + " → 比例 " + (ratio ? (ratio.w * 100).toFixed(1) + "% × " + (ratio.h * 100).toFixed(1) + "%" : "无"));
  pending.resolve({
    ok: true,
    ratio,
    dip: { x: Math.round(dipRect.x), y: Math.round(dipRect.y), w: Math.round(dipRect.w), h: Math.round(dipRect.h) },
    phys: ratioToPhysical(ratio),
    display: { w: dw, h: dh, sf: init.sf },
  });
}

/** 覆盖层加载后主动来取初始状态（invoke，比"创建完再 send"少一个竞态）。 */
safeHandle("region-init", () => {
  const p = regionPending;
  return p ? p.init : { ratio: { x: 0, y: 0, w: 1, h: 1 }, dip: { w: 1, h: 1 }, sf: 1 };
}, () => ({ ratio: { x: 0, y: 0, w: 1, h: 1 }, dip: { w: 1, h: 1 }, sf: 1 }));

ipcMain.on("region-done", (_e, msg) => { finishRegion(msg); });

safeHandle("cap-region-pick", async (_e, opts) => {
  if (regionPending) return { ok: false, error: "已经有一个选区覆盖层在显示了" };
  const o = opts && typeof opts === "object" ? opts : {};
  let disp;
  try { disp = screen.getPrimaryDisplay(); }
  catch (e) { return { ok: false, error: "拿不到主显示器信息：" + ((e && e.message) || String(e)) }; }

  const init = {
    ratio: normalizeRatio(o.ratio) || { x: 0, y: 0, w: 1, h: 1 },
    dip: { w: disp.size.width, h: disp.size.height },
    sf: disp.scaleFactor || 1,
  };

  let win;
  try {
    win = new BrowserWindow({
      show: false, frame: false, transparent: true,
      resizable: false, movable: false, focusable: true, hasShadow: false,
      skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#00000000",
      fullscreenable: false, minimizable: false, maximizable: false,
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, "region-preload.js"),
        backgroundThrottling: false,
      },
    });
  } catch (e) {
    return { ok: false, error: "创建选区窗口失败：" + ((e && e.message) || String(e)) };
  }
  regionWin = win;
  win.on("closed", () => { if (regionWin === win) regionWin = null; });

  /* ⚠️ pending 必须在 loadFile **之前**挂上：页面脚本一加载完就会 invoke
     region-init 来取初始矩形，晚一步设它，取到的就是兜底全屏 ——
     表现是"上次存的左半屏，这次打开覆盖层却是空的"。 */
  const result = new Promise((resolve) => {
    regionPending = {
      resolve,
      init,
      timer: setTimeout(() => {
        /* 挂死兜底：用户切走 / 忘了这层还压着 → 90 秒自己撤。
           没有它，整屏会一直暗着，看起来就是死机（pick 那边踩过同样的坑）。 */
        log("[region] 超时未操作，自动撤下覆盖层");
        finishRegion({ kind: "timeout" });
      }, 90000),
    };
  });

  try {
    win.setBounds(disp.bounds);
    win.setAlwaysOnTop(true, "screen-saver");
    await win.loadFile(path.join(__dirname, "region.html"));
    /* 页面脚本已经跑过一轮（用的是兜底色），这里把主题强调色盖上去。
       executeJavaScript 改的是 <html> 的内联变量，覆盖后整页即时重绘。 */
    pushThemeVars();
  } catch (e) {
    finishRegion({ kind: "loadfail" });
    return { ok: false, error: "选区覆盖层加载失败：" + ((e && e.message) || String(e)) };
  }

  hideForRegion();
  try { win.show(); win.focus(); } catch { /* ignore */ }
  return result;
}, (_e, opts) => ({ ok: false, error: "选区通道不可用" }));

/* ---------------- 摄像头小框 · 全屏摆位 ----------------
 * 与录屏选区（region）同一套覆盖层套路，但**独立一套窗口与"藏了什么"记录**：
 * 两者可能先后被打开，共用一份数组会把对方记下的窗口也恢复成可见。
 *
 * 为什么要有这一层（用户原话："预览模式也类似做嵌入整个屏幕，而不用小窗模拟"）：
 * 面板里那个舞台只有三百多像素宽，要表示 1920 宽的画面只能放大 2.6 倍画示意图 ——
 * 用户看到的尺寸/位置和真实屏幕对不上，也判断不出小框遮住了什么。
 * 铺到真实桌面上、按真实比例画框，才是"所见即成片"。
 */
let camStageWin = null;
let camStagePending = null;
let camStageHiddenWins = [];

function hideForCamStage() {
  if (camStageHiddenWins.length) return;
  for (const w of [panel, ball, toolbar, subWin, borderWin, recbarWin]) {
    if (!w || w.isDestroyed()) continue;
    try { if (w.isVisible()) { camStageHiddenWins.push(w); w.hide(); } } catch { /* 正在销毁 */ }
  }
}
function restoreAfterCamStage() {
  for (const w of camStageHiddenWins) {
    if (!w || w.isDestroyed()) continue;
    try { w.show(); } catch { /* ignore */ }
  }
  camStageHiddenWins = [];
}

function finishCamStage(msg) {
  const pending = camStagePending;
  if (!pending) return;
  camStagePending = null;
  if (pending.timer) { clearTimeout(pending.timer); pending.timer = null; }
  const win = camStageWin;
  camStageWin = null;
  if (win && !win.isDestroyed()) { try { win.destroy(); } catch { /* ignore */ } }
  restoreAfterCamStage();

  const kind = msg && msg.kind;
  if (kind !== "ok") {
    log("[camstage] 已取消（" + (kind || "no-msg") + "）");
    pending.resolve({ ok: false, cancelled: true });
    return;
  }
  const c = msg && msg.cam;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  const geomOk = c && [c.bx, c.by, c.bw, c.bh].every((v) => Number.isFinite(num(v)))
    && num(c.bw) > 0 && num(c.bh) > 0;
  if (!geomOk) {
    log("[camstage] 覆盖层回传的几何不合法，按取消处理");
    pending.resolve({ ok: false, cancelled: true });
    return;
  }
  /* 只做范围夹取，形状/比例的合法性仍交给 set-reccam 那一道（一处口径） */
  const clamp01 = (v) => Math.min(1, Math.max(0, num(v)));
  const size = (v) => Math.min(0.6, Math.max(0.05, num(v)));
  const cam = {
    shape: String(c.shape || "round"),
    ratio: String(c.ratio || "4:3"),
    bx: clamp01(c.bx),
    by: clamp01(c.by),
    bw: size(c.bw),
    bh: size(c.bh),
  };
  log("[camstage] 摆位 " + (Math.round(cam.bw * 1000) / 10) + "% × "
    + (Math.round(cam.bh * 1000) / 10) + "% @ "
    + (Math.round(cam.bx * 1000) / 10) + "," + (Math.round(cam.by * 1000) / 10));
  pending.resolve({ ok: true, cam });
}

safeHandle("cam-stage-init", () => {
  const p = camStagePending;
  return p ? p.init : {
    cam: { shape: "round", ratio: "4:3", customRatio: "", bx: 0.76, by: 0.72, bw: 0.115, bh: 0.15 },
    dip: { w: 1, h: 1 },
    sf: 1,
  };
}, () => ({
  cam: { shape: "round", ratio: "4:3", customRatio: "", bx: 0.76, by: 0.72, bw: 0.115, bh: 0.15 },
  dip: { w: 1, h: 1 },
  sf: 1,
}));

ipcMain.on("cam-stage-done", (_e, msg) => { finishCamStage(msg); });

safeHandle("cam-stage-open", async (_e, opts) => {
  if (camStagePending) return { ok: false, error: "已经有一个摆位层在显示了" };
  const o = opts && typeof opts === "object" ? opts : {};
  let disp;
  try { disp = screen.getPrimaryDisplay(); }
  catch (e) { return { ok: false, error: "拿不到主显示器信息：" + ((e && e.message) || String(e)) }; }

  /* 初始几何由面板给（它才是 camPrefs 的主人）；缺项就按主进程的当前配置兜底 */
  normalizeRecCam();
  const src = (o.cam && typeof o.cam === "object") ? o.cam : state.recCam;
  /* 录制区域（0..1 比例）：面板显式传，摆位层据此决定"框最远能摆到哪"。
     不靠跨窗口读 localStorage —— 那依赖 file:// 同源共享，换个分区或写盘晚一拍就错。
     面板全屏时传的是 {0,0,1,1} 而不是省略，所以这里"有 region 且合法"就一律照传。 */
  const rgIn = (o.region && typeof o.region === "object") ? o.region : null;
  const rgNum = rgIn ? ["x", "y", "w", "h"].map((k) => Number(rgIn[k])) : null;
  const rgOk = !!rgNum && rgNum.every((v) => Number.isFinite(v))
    && rgNum[2] > 0 && rgNum[3] > 0;
  const init = {
    cam: {
      shape: src.shape || state.recCam.shape,
      ratio: src.ratio || state.recCam.ratio,
      customRatio: typeof src.customRatio === "string" ? src.customRatio : state.recCam.customRatio,
      bx: Number.isFinite(Number(src.bx)) ? Number(src.bx) : state.recCam.bx,
      by: Number.isFinite(Number(src.by)) ? Number(src.by) : state.recCam.by,
      bw: Number.isFinite(Number(src.bw)) ? Number(src.bw) : state.recCam.bw,
      bh: Number.isFinite(Number(src.bh)) ? Number(src.bh) : state.recCam.bh,
    },
    dip: { w: disp.size.width, h: disp.size.height },
    sf: disp.scaleFactor || 1,
    region: rgOk
      ? { x: rgNum[0], y: rgNum[1], w: rgNum[2], h: rgNum[3] }
      : null,
  };

  let win;
  try {
    win = new BrowserWindow({
      show: false, frame: false, transparent: true,
      resizable: false, movable: false, focusable: true, hasShadow: false,
      skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#00000000",
      fullscreenable: false, minimizable: false, maximizable: false,
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, "camstage-preload.js"),
        backgroundThrottling: false,
      },
    });
  } catch (e) {
    return { ok: false, error: "创建摆位窗口失败：" + ((e && e.message) || String(e)) };
  }
  camStageWin = win;
  win.on("closed", () => { if (camStageWin === win) camStageWin = null; });

  /* pending 必须先挂：页面一加载完就 invoke cam-stage-init（region 那边踩过这个坑） */
  const result = new Promise((resolve) => {
    camStagePending = {
      resolve,
      init,
      timer: setTimeout(() => {
        log("[camstage] 超时未操作，自动撤下摆位层");
        finishCamStage({ kind: "timeout" });
      }, 180000),
    };
  });

  try {
    win.setBounds(disp.bounds);
    win.setAlwaysOnTop(true, "screen-saver");
    await win.loadFile(path.join(__dirname, "camstage.html"));
    pushThemeVars();
  } catch (e) {
    finishCamStage({ kind: "loadfail" });
    return { ok: false, error: "摆位层加载失败：" + ((e && e.message) || String(e)) };
  }

  hideForCamStage();
  try { win.show(); win.focus(); } catch { /* ignore */ }
  return result;
}, (_e, opts) => ({ ok: false, error: "摆位通道不可用" }));

/* ---------------- Snipaste（截屏） ----------------
 * 三条通道都只做「一件具体的事」，不暴露 fs、不暴露通用 spawn：
 *   snip-detect     装没装 / 在不在跑（设置页状态行、首跑引导卡、聚焦重查都用它）
 *   snip-run        唤起框选；截图落 <存储根>/screenshots，不回传图片字节
 *   snip-guide-done 首跑引导卡「知道了」落盘，同一台机器不再弹第二次
 * 唤起逻辑（两步式、为什么发裸 `snip`）的依据写在 snipaste.js 顶部注释。 */
safeHandle("snip-detect", async () => {
  try { return await snipaste.detect(); }
  catch (e) { return { ok: false, installed: false, running: false, path: "", source: "" }; }
}, () => ({ ok: false, installed: false, running: false, path: "", source: "" }));

safeHandle("snip-run", async () => {
  const t0 = Date.now();
  try {
    /* ⚠️ Snipaste 已经在框选/标注中，就**不要再发一次 snip 命令**。
       实测（用户反馈）：连着发第二次会让 Snipaste 状态错乱 ——
       标注工具栏不出现、第二次截取直接关闭。
       原来这里无脑 spawn，连点两下「截屏」或程序重复调用都会踩到。
       ⚠️ 探针必须**先就绪**再问 —— nativeSnipping() 在探针未就绪时
          返回 false（保守兜底，否则整个截屏功能不可用），
          那个 false 会让本守卫失效 → 重复发 snip → 状态错乱。 */
    /* 700ms 而不是原来的 2000ms：探针正常是毫秒级就绪，真等满 2 秒
       说明它已经坏了 —— 那种情况下守卫失效（多一次重复唤起的概率）
       也比让用户干等两秒划算。这条等待**直接压在"点了截屏到浮层弹出"
       的观感上**，是当初"响应极长"的主要来源之一。 */
    await waitFgReady(700);
    const t1 = Date.now();
    /* ⚠️ 3 次 × 60ms 空转压到 2 次 × 40ms（2026-10-29 改）：
       探针应答是 0.2ms 级，一次查询就够准；多出来的重试是为了防"探针刚好
       抖一下"。而**没在框选**才是常态 —— 那时这 120ms 是纯白等，
       直接叠在"点了截屏到浮层弹出"上。留一次重试（40ms）足够兜住抖动。 */
    let busy = false;
    for (let i = 0; i < 2; i++) {
      busy = await nativeSnipping().catch(() => false);
      if (busy) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    const t2 = Date.now();
    if (busy) {
      log("[snip] Snipaste 已在框选中，不重复唤起（避免状态错乱）");
      return { ok: true, launched: true, file: "", reason: "already-snipping" };
    }
    /* ⚠️ 基线必须在**唤起之前**取（2026-10-24 修）。
     * 基线 = "唤起这一刻剪贴板的状态"，用来判断"之后剪贴板有没有被改写过"。
     * 如果先唤起再取基线：Snipaste 响应很快时（比如它复用了上次的选区）
     * 可能在基线查询到达之前就已经把图写进剪贴板 → 基线取到的是"写完之后"的
     * 序列号 → 之后序列号再不变 → 判定永远不成立 → 截图丢失。 */
    const base = await takeClipSeqBaseline();
    const t3 = Date.now();
    /* 面板挡着屏幕就截不到下面的内容 —— 开关开着时先收起来，会话结束再还回去。 */
    hidePanelForSnip();
    const r = await snipaste.runSnip();
    const t4 = Date.now();
    if (!r || !r.ok) restorePanelAfterSnip();   // 唤起失败：别把面板晾在收起状态
    /* ⚠️ 分段耗时必须打出来（2026-10-29 加）。
       「点截屏到浮层弹出」这条链上有四段：等探针就绪 / 查是否已在框选 /
       取剪贴板基线 / 唤起 Snipaste。之前只有一条总耗时，出问题时根本
       定位不到是哪一段 —— 14.9 秒那次最后是靠算出来的（5×...），不是看出来的。
       现在每段都留痕：+fg就绪 / +查框选 / +取基线 / +唤起。 */
    log("[snip] 分段耗时：等探针 " + (t1 - t0) + "ms，查框选 " + (t2 - t1)
      + "ms，取基线 " + (t3 - t2) + "ms(seq=" + base.seq + ")，唤起 " + (t4 - t3) + "ms");
    /* 产物走剪贴板（裸 snip 的正常行为），所以盯剪贴板而不是盯文件。
       落盘文件名在这里生成 —— 目录此刻就要在（用户可能刚改过存储根）。 */
    if (r && r.ok) {
      const dir = storage.pathOf("screenshots");
      const file = snipaste.snipFile(dir);
      duckForSnip(true);
      watchSnipClipboard(file, base.seq, base.hash);
      log("[snip] 唤起完成，从点下到浮层就绪 " + (Date.now() - t0) + "ms");
      return { ok: true, launched: true, file, reason: "" };
    }
    log("[snip] 唤起失败 " + (Date.now() - t0) + "ms：" + (r && r.reason));
    return r;
  }
  catch (e) { return { ok: false, launched: false, file: "", reason: "exception: " + String((e && e.message) || e) }; }
}, () => ({ ok: false, launched: false, file: "", reason: "唤起失败（详见 .orbdata/orb.log）" }));

/* ---------------- 截屏期间把自家窗口从「最上层」让开 ----------------
 * Snipaste 的框选浮层是它自己的全屏窗口（topmost），而 ORB 的球/面板/字幕窗
 * 都是 screen-saver 级置顶 —— 比 topmost 还高。结果就是：点「截屏」后
 * Snipaste 浮层被 ORB 的窗口压在下面，鼠标一拖就被 ORB 吃掉，根本框不了选区
 * （用户反馈「无法截屏」的真因，不是唤起失败）。
 * 修法：截屏期间把这些窗口降回普通层级，浮层就能正常盖在上面；
 * 截完（落盘 / 取消 / 超时）再恢复 screen-saver。
 * 只改 alwaysOnTop 这一个开关，不动 show/hide —— 面板仍是可见的，
 * 所以「截图时控制台不缩回」那条依然成立。 */
function duckForSnip(on) {
  /* ⚠️ 录屏悬浮条（recbar）**不参与让开**。
     用户反馈：录屏中截屏时，控制条跟着一起被压到 Snipaste 浮层下面，
     像是"消失"了 —— 录屏还在跑，控制条却找不着，没法暂停/结束。
     控制条只有 240×54，压在浮层下会挡住巴掌大一块；
     反过来让它保持在最上层，用户绕开这块区域框选就行，比"控制条消失"划算。 */
  const wins = [ball, panel, toolbar, subWin, borderWin];
  for (const w of wins) {
    if (!w || w.isDestroyed()) continue;
    try {
      /* 第二个参数只在 flag=true 时有意义，降级时传 undefined 即可 */
      if (on) w.setAlwaysOnTop(false);
      else w.setAlwaysOnTop(true, "screen-saver");
    } catch { /* 窗口正在销毁，跳过 */ }
  }
  log("[snip] 自家窗口层级", on ? "已让开（降到普通层）" : "已恢复（screen-saver）");
}

/* ---------------- 截屏期间别让控制台缩回 ----------------
 * Snipaste 是外部进程：runSnip 一 spawn 就返回，渲染层的 withHold 随即解锁，
 * 而用户这时正把鼠标移去框选 —— 面板的「鼠标移开自动折叠」就把整个控制台收了。
 * 现象：点「截屏」→ 控制台消失，截完还得重新唤出。
 *
 * ⚠️ 盯的是**剪贴板**，不是文件（2026-10-24 改）：
 *   原来发的是 `snip --hold -o <文件>`，盯那个文件出现。但 `--hold` 是
 *   **PRO 专属**（Snipaste 二进制内嵌更新日志：「[PRO] New command line
 *   option: --hold」），免费个人版静默忽略它 → `-o` 退化成无人值守自动保存，
 *   标注工具栏整个不出现（用户实测：二次截取后直接保存，没有工具栏）。
 *   现在发裸 `snip`（与按 F1 同一条路径），产物走剪贴板，所以盯剪贴板。
 *
 * ★ 实测事实（本机 Snipaste 2.11.3，2026-10-24 全流程实测）：
 *   · 框选松手 → 出现 427×33 的**标注工具栏**（13 个按钮：矩形/箭头/铅笔/
 *     高亮/橡皮/马赛克/文本/吸管/撤销/重做/删除/复制/贴图），可改选区、
 *     划线、二次裁剪 —— 用户要的「二次截取后显示工具栏」由此满足。
 *   · 此刻剪贴板**是空的** —— Snipaste 不会自动复制，等用户点「复制」。
 *   · 点「复制」→ Snipaste 全部可见窗口消失 + **剪贴板写入 PNG**。
 *   ⇒ 「剪贴板出现图像」就是「用户完成标注并点了复制」的确切信号，
 *     比「Snipaste 有没有可见窗口」更准（工具栏存活与否不作数）。
 *
 * Electron 44 的 clipboard **没有 readImage()**（只剩 clear/has/read/
 * readText/write/writeText），且 read()/has() 返回 Promise，
 * read() 给的是 Array<ClipboardItem>，getType() 给的是 Blob（不是 Buffer）。
 * 实测：外部程序（Snipaste）写进 Windows 系统剪贴板的 PNG，主进程用
 *   await clipboard.read() → item.getType("image/png") → await blob.arrayBuffer()
 * 能原样读到（182KB PNG，校验通过）。
 */
/**
 * 截屏轮询的定时器句柄（模块级全局）。
 *
 * ⚠️ 这个全局只承担**一个**用途：新会话顶掉旧会话。
 *   它**不能**被 finish() 用来清定时器 —— 那是两个不同会话的定时器，
 *   清错会导致新会话的轮询被停掉（面板锁死 + 截图永不落盘）。
 *   finish() 用的是自己闭包里的 pollTimer，详见 watchSnipClipboard。
 */
let snipWatchTimer = null;

/** 顶掉上一个截屏会话的轮询（新会话开始时调用）。 */
function stopSnipWatch() {
  if (snipWatchTimer) {
    clearInterval(snipWatchTimer);
    snipWatchTimer = null;
  }
}

/**
 * 读剪贴板里的图像 → { buf: Buffer }；没有图像返回 null。
 *
 * Electron 44 的正确写法（clipboard.readImage 已被移除）：
 *   const items = await clipboard.read();
 *   const it = items[0];
 *   if (!it || !it.types.includes("image/png")) return null;
 *   const blob = await it.getType("image/png");   // Blob
 *   const buf = Buffer.from(await blob.arrayBuffer());
 *
 * ⚠️ 这里**不**返回内容指纹作为"有没有变化"的判据 —— 判断"剪贴板有没有被
 *    写过"用的是 **Windows 剪贴板序列号**（见 nativeSnapState），
 *    指纹法已被淘汰：用户截的图和旧图字节完全相同时，指纹法永远等不到
 *    变化（用户白截一次）。
 *    但指纹仍有另一个用途：**校验"这张图是不是本次产生的"**
 *    （见 takeClipSeqBaseline 的 baseHash）—— 那是"是不是同一张图"的
 *    问题，与"有没有变化"是两个不同的问题，用指纹是恰当的。
 *
 * @returns {Promise<{buf: Buffer}|null>}
 */
async function readClipboardImage() {
  try {
    const items = await clipboard.read();
    if (!items || !items.length) return null;
    for (const it of items) {
      if (!it || !it.types || !it.types.includes("image/png")) continue;
      const blob = await it.getType("image/png");
      if (!blob) continue;
      const buf = Buffer.from(await blob.arrayBuffer());
      if (!buf || !buf.length) continue;
      return { buf };
    }
  } catch (e) {
    /* 剪贴板被别的进程锁住 / 没有可读格式 —— 当作「没有图」，下一轮再试 */
  }
  return null;
}

/**
 * 剪贴板里当前图片的指纹（长度 + 采样校验和）。
 *
 * 用途只有一个：**校验"落盘的图是不是本次截图产生的"**。
 * 用户在框选期间如果别的程序改了剪贴板（复制了旧图 / 文字），
 * 序列号会变、ORB 会去读图 —— 读到的是**别人的旧图**，
 * 存下来就是存错图（独立审查实测复现）。
 *
 * ⚠️ 为什么不能用指纹判断"有没有变化"：用户两次截同一区域，
 *    字节完全相同 → 指纹法永远等不到变化 → 白截一次。
 *    那是序列号存在的理由。两者用途不同，不冲突。
 */
function bufFingerprint(buf) {
  if (!buf || !buf.length) return "";
  let sum = 0;
  const step = Math.max(1, Math.floor(buf.length / 1024));
  for (let i = 0; i < buf.length; i += step) sum = (sum * 31 + buf[i]) >>> 0;
  return buf.length + ":" + sum;
}

/**
 * 取剪贴板基线（带重试）：**序列号** + **当前图片的指纹**。
 *
 * 为什么必须重试（2026-10-24 独立验证打回来的必现 bug）：
 *   取基线走的是 native 探针，而探针刚 spawn 时还没 ready（等 {"ok":true,
 *   "ready":true}），此时查询会直接返回 {known:false, seq:-1}。
 *   如果拿这个 -1 去当基线，后续每轮的真实序列号都 >= 0，
 *   判定式 `baseSeq >= 0 && st.seq >= 0 && st.seq !== baseSeq` 恒为 false
 *   → **截图永远不落盘**。用户看到的是"复制了但没存下来"。
 *   而"应用刚启动就点截屏"这个时序非常容易命中。
 *
 * 所以：取不到就重试，最多约 3 秒；一直取不到才放弃（放弃也要明确失败，
 * 不能硬撑着往下走）。
 *
 * ⚠️ 指纹是**顺带**取的，取不到不算失败（空串 = 不做校验）——
 *   它只是用来发现"读到的是别人的旧图"，不是主判据。
 *   ⚠️ 指纹必须在**序列号之后**取：先拿到 seq，再读内容。
 *      反过来的话，中间夹着的写入会让 seq 与内容对不上号。
 *
 * @returns {Promise<{seq: number, hash: string}>} seq=-1 表示取不到
 */
async function takeClipSeqBaseline(attempt = 0) {
  /* 走直连槽（不会被观察边框 / 截屏态轮询抢掉），见 nativeSnapDirect 的注释。 */
  const raw = await nativeSnapDirect().catch(() => null);
  const st = raw && typeof raw.seq === "number"
    ? { known: true, seq: raw.seq }
    : { known: false, seq: -1 };
  if (st.known && st.seq >= 0) {
    /* 顺带记下"此刻剪贴板里的图"的指纹，用来识别"读到的其实是旧图" */
    const cur = await readClipboardImage().catch(() => null);
    return { seq: st.seq, hash: cur ? bufFingerprint(cur.buf) : "" };
  }
  /* 重试窗口：8×80ms → 4×60ms。走直连槽之后"取不到"基本只剩"探针真的没起来"
     这一种情况，那种情况下干等只是把"点了没反应"拉长，对用户没任何好处。
     ⚠️ 单次超时也从 1500ms 压到 600ms（见 nativeSnapDirect）—— 探针应答是
        0.2ms 级，600ms 已经是 3000 倍余量；而一旦真超时，每多一次重试就
        多一秒"点了没反应"，这正是当初 14.9 秒的构成方式。 */
  if (attempt < 4) {
    await new Promise((r) => setTimeout(r, 60));
    return takeClipSeqBaseline(attempt + 1);
  }
  log("[snip] 取不到剪贴板序列号基线（native 探针未就绪）");
  /* 序列号没了不代表彻底没救 —— 顺手取一次指纹，让 watchSnipClipboard
     能降级到"剪贴板里出现不同于基线的图"（见那里的 mode === "hash"）。 */
  const cur = await readClipboardImage().catch(() => null);
  return { seq: -1, hash: cur ? bufFingerprint(cur.buf) : "" };
}

/**
 * 「Snipaste 压根没进过截屏态」的宽限期（毫秒）。
 *
 * 为什么需要它：取消判定靠的是 **snipping 的 true → false 跳变**，
 * 而跳变的前提是"先见过 true"。用户框选**极快**时，400ms 的轮询可能
 * 一次都没采到 true —— 这时按 Esc 也判不出取消，只能干等到超时。
 * 加上这条兜底：超过这个时间还从没进过截屏态，就认定"Snipaste 压根
 * 没弹出来"，直接放弃本次截屏（并把面板解锁）。
 *
 * 它同时覆盖了另一种真实故障：Snipaste 冷启动时序问题导致 `snip` 命令
 * 根本没生效（snipaste.js 头部注释①：CLI 子命令只在 Snipaste 已运行时
 * 生效）—— 这时用户看到的就是"点了截屏什么也没发生"。
 *
 * 取值 20 秒：Snipaste 从命令到浮层出现实测在 1 秒内；留足余量
 * （要 > CANCEL_GRACE_MS，否则写图慢的用户会被误杀），
 * 又不至于让用户对着一个什么都没发生的屏幕干等。
 *
 * ⚠️ 这条兜底**只在 alive 也一直是 false 时才用**（见 nativeSnapState 的
 *   alive 字段说明）：用户开着贴图窗/设置窗时 alive 为 true 而 snipping 为
 *   false —— 那不是"Snipaste 没弹出来"，只是判据看不见框选浮层。
 *   这时若拿"没进过截屏态"去放弃，用户点了复制也会被丢掉。
 */
const NO_SESSION_MS = 20000;

/**
 * 判取消前给剪贴板写入留的余量（毫秒）。
 *
 * ⚠️ 为什么是 8 秒而不是 1.5/3 秒 —— 这是独立审查用**真实跨进程写者**
 *    实测出来的（模拟 Snipaste 的写图行为）：
 *      写图耗时 3.0 秒 → 图在 t=3328ms 才可读
 *      写图耗时 6.0 秒 → 图在 t=6172ms 才可读
 *      写图耗时 9.0 秒 → 图在 t=9375ms 才可读
 *    空档 = 「浮层消失」到「剪贴板里有图」，由 PNG 编码耗时 + 剪贴板争用
 *    决定，很容易超过 3 秒。宽限太短 → 用户点了复制却什么都没存下来。
 *
 *    代价是"用户按了 Esc"要等 8 秒才解锁面板 —— 这个可以接受，
 *    而"丢截图"是用户真正无法接受的。
 */
const CANCEL_GRACE_MS = 8000;

/**
 * 盯剪贴板，等本次截图落盘。
 *
 * ★ 完成信号 = **剪贴板序列号变了**（不是"图片内容变了"）。
 *
 * 为什么不比内容（这是本轮踩过的坑，独立验证时被打回来了两次）：
 *   ① 用户截的图和剪贴板里旧图**字节完全相同**（截了同一个区域两次）
 *      → 指纹法永远等不到变化 → 截图卡到超时，用户白截一次。
 *   ② 基线指纹读取失败（比如剪贴板正被别的进程锁住）→ baseStamp="" →
 *      判定退化成"只要有图就算新图" → **旧图被当成本次截图落盘**，
 *      用户没点复制也存了一张，还把真正的截图丢了。
 * 序列号（GetClipboardSequenceNumber）只在**内容被改写**时 +1，与内容无关，
 * 基线是一个整数、读取不会失败，两个坑一起解决。
 *
 * 流程：
 *   唤起前记基线 seq → 轮询 {snipping, alive, seq}
 *        · seq 变了 → 读剪贴板里的图 → 有图就落盘（这就是 Snipaste 的「复制」）
 *        · snipping 从 true 变回 false 且 seq 持续不变 → 用户按了 Esc → 判取消
 *
 * ⚠️ 三条铁律（都是这轮被独立验证打回来的）：
 *   ① 取消判定必须**先见过 snipping=true**（否则 snip 命令刚发出、
 *      Snipaste 还没建浮层的那一刻，绝对值也是 false → 误杀正常流程）。
 *   ② 取消判定必须给剪贴板写入留 **CANCEL_GRACE_MS** 的余量，
 *      且判取消前**再读一次剪贴板**做二次确认（防止"刚写完还没被观察到"）。
 *   ③ **所有 return 分支都必须检查 deadline** —— 探针失联（known=false）
 *      或 snipping 卡住 true 时，180 秒总兜底是唯一的救命绳。
 *      漏掉它 → 轮询永不结束 → duckForSnip(false) 永不执行 →
 *      ORB 的球/面板/字幕窗**永久停在普通层**（不再置顶），面板锁 3 分钟。
 *
 * @param {string} file 落盘目标路径（调用方算好，目录已存在）
 * @param {number} baseSeq 唤起前取的序列号基线（-1 = 未知）
 */
function watchSnipClipboard(file, baseSeqIn, baseHashIn) {
  stopSnipWatch();                    // 顶掉上一个会话的轮询
  const startAt = Date.now();
  const deadline = startAt + 180000;   // 3 分钟总兜底（正常路径都用不到）
  let baseSeq = (typeof baseSeqIn === "number" && baseSeqIn >= 0) ? baseSeqIn : -1;
  /* 基线时刻剪贴板里那张图的指纹。用来识别"读到的是别人的旧图"
     （用户在框选期间别的程序改了剪贴板）。空串 = 不做这项校验。 */
  const baseHash = typeof baseHashIn === "string" ? baseHashIn : "";
  let pollTimer = null;                // ★ 本会话私有的定时器句柄
  let finished = false;                // ★ 本会话的重入保护
  let inflight = false;                // 防重入：查询是异步的
  let seenSnipping = false;            // 见过框选/标注态
  let seenReady = false;               // 见过 Snipaste 的框选浮层窗口存在
  let lastSnippingAt = 0;              // ★ 最后一次观测到 snipping=true 的时刻
  let idleSince = 0;                   // "已退出且 seq 未变"持续了多久（毫秒）
  let noImgRounds = 0;                 // "seq 变了但读不到图"连续几轮

  const finish = (path) => {
    /* ★ 重入保护：finish 可能被两条路径同时触发（tick 里的落盘分支
     *   与异常分支），重复发 snip-done 会让面板的锁定计数错乱。 */
    if (finished) return;
    finished = true;
    /* ★ 只清**自己**的定时器。
     *   之前这里调的是全局 stopSnipWatch()，而全局此刻可能已经指向
     *   **下一个**会话的定时器（用户在本次会话飞行途中又点了一次截屏）
     *   → 把新会话的轮询清掉 → 新会话永不落盘、面板锁死。
     *   这个竞态在独立审查里被仿真确证为必现，不是理论风险。 */
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (snipWatchTimer === pollTimer) snipWatchTimer = null;
    duckForSnip(false);
    log("[snip] 截图落盘 ->", path || "(无)");
    restorePanelAfterSnip();   // 因截屏收起的面板，在这里还回去（录屏中则跳过）
    sendToPanel("snip-done", { file: path || "" });
  };

  /* 基线取不到时的**降级**，不再直接放弃（2026-10-29 改）。
   *
   * 原来这里「剪贴板基线不可用 → 放弃本次截屏」，而基线走的是 native 探针 ——
   * 探针一旦不可用（exe 缺失 / 启动失败 / 被 3 次重启判死），整条截屏链路
   * 就全废了：用户点了截屏、Snipaste 也弹了、辛苦框完点复制，结果一张不存。
   * 实测就是这么丢的（fgDrain 吞应答那次，14.9 秒 + 零落盘）。
   *
   * 降级链：序列号 → 指纹 → 放弃
   *   · seq 不可用但拿到了基线指纹 → 退到「剪贴板里出现一张**不同于基线**的图」
   *     （丢的是"两张图字节完全相同"这种极端情况，比整个功能死掉划算得多）；
   *   · 指纹也没有（连剪贴板都读不出来）→ 那确实没有任何判据可用，才放弃。
   */
  let mode = "seq";                       // seq | hash
  if (baseSeq < 0) {
    if (!baseHash) {
      log("[snip] 剪贴板基线与指纹都取不到，放弃本次截屏");
      setTimeout(() => finish(""), 0);
      return;
    }
    mode = "hash";
    log("[snip] 序列号基线不可用，降级为指纹判定（探针不可用）");
  }
  /* 指纹模式下没有 snipping 可看，取消无从判断 —— 用更短的总时限收场，
     免得面板一直锁着（正常路径 180 秒那条兜底对它是浪费）。 */
  const hardDeadline = mode === "hash" ? startAt + 90000 : deadline;

  const tick = async () => {
    if (inflight) return;
    inflight = true;
    try {
      const st = await nativeSnapState().catch(() => ({ known: false, snipping: true, alive: false, seq: -1 }));

      /* ★ 铁律③：总兜底必须在**每个** return 分支之前检查。
       *   探针失联（known=false 持续）或 snipping 卡住 true 时，
       *   没有别的出口 —— 这个 deadline 是唯一的救命绳。
       *   漏掉它 → 轮询永不结束 → duckForSnip(false) 永不执行 →
       *   ORB 的球/面板/字幕窗**永久停在普通层**（不再置顶），面板锁死。 */
      if (Date.now() >= hardDeadline) {
        log("[snip] 等待截图超时");
        finish("");
        return;
      }

      /* 指纹模式（探针不可用）：不看 snipping，直接盯剪贴板里有没有"新图"。
         baseHash 是唤起前那张图 —— 与它不同才认作本次截图。 */
      if (mode === "hash") {
        const rr = await readClipboardImage().catch(() => null);
        if (rr) {
          if (bufFingerprint(rr.buf) === baseHash) return;   // 还是唤起前那张旧图
          try {
            fs.writeFileSync(file, rr.buf);
            finish(file);
          } catch (e) {
            log("[snip] 剪贴板图片写盘失败:", (e && e.message) || String(e));
            finish("");
          }
        }
        return;
      }

      /* 探针失联 → 保守当"还在框选"，下一轮再说。
         ⚠️ 这里**不能**因为查不准就判取消 —— 探针抖一下就把用户的截图丢掉，
         是比多等几秒糟糕得多的错。 */
      if (!st.known) return;

      if (st.ready) seenReady = true;

      /* 剪贴板被改写过 → 这就是 Snipaste 的「复制」。读图落盘。
         ⚠️ seq 变了但读不到图**不能**就此放弃 —— 这是**常态**，不是异常：
           实测 Snipaste 写一次图，**EmptyClipboard 会先把 seq 推高**，
           然后才 SetClipboardData 把图放进去。于是中间有一整段
           "seq 已变、剪贴板里还没图"的窗口（写图耗时 3/6/9 秒时
           分别长达 1~7 秒）。
         正确做法：**保持基线不变**、下一轮接着读。
         序列号一旦变过就一直变着，直到我们真的把图取出来。 */
      if (st.seq >= 0 && st.seq !== baseSeq) {
        const r = await readClipboardImage();
        if (r) {
          /* ⚠️ 校验"这张图不是基线时就在剪贴板里的旧图"。
             用户框选期间别的程序改了剪贴板（复制了旧图）时，
             seq 会变、但读到的是那张旧图 —— 存下来就是存错图。
             （⚠️ 这与"用指纹判断有没有变化"是两回事：
               用户两次截同一区域时字节相同，指纹法判断"变化"会失效，
               那是序列号存在的理由；这里判断的是"是不是同一张图"。） */
          if (baseHash && bufFingerprint(r.buf) === baseHash) {
            /* 内容与基线一致 → 不是本次新产生的图，继续等 */
            noImgRounds += 1;
            if (noImgRounds > 40) { baseSeq = st.seq; noImgRounds = 0; }
            idleSince = 0;
            return;
          }
          try {
            fs.writeFileSync(file, r.buf);
          } catch (e) {
            log("[snip] 剪贴板图片写盘失败:", (e && e.message) || String(e));
            finish("");
            return;
          }
          finish(file);
          return;
        }
        noImgRounds += 1;
        /* ⚠️ 这里的"放弃"阈值必须**远大于**写图耗时上限。
           之前是 12 轮（≈4.8 秒）—— 遇上写图耗 6 秒/9 秒就正好把
           还没写完的图永久放弃（丢图）。独立审查实测把阈值提到
           40 轮（≈16 秒）才够覆盖最坏情况。
           ⚠️ 但也不能无限等：如果用户复制的是**文字**（不是图），
           seq 也会变、但永远读不到图 → 那要靠这个上限收场。
           两者取兼顾：40 轮 ≈ 16 秒，覆盖 9 秒的写图耗时还有余量。 */
        if (noImgRounds > 40) {
          log("[snip] 剪贴板内容不是图片（seq 变了但读不到图），放弃本次截屏");
          baseSeq = st.seq; noImgRounds = 0;
        }
        idleSince = 0;
        return;
      }
      noImgRounds = 0;

      if (st.snipping) { seenSnipping = true; lastSnippingAt = Date.now(); idleSince = 0; return; }

      /* ★ 取消判定（2026-10-24 重写，独立验证打回两次后定稿）。
       *
       * 判据 = **snipping 从 true 变回 false**（跳变），且剪贴板没被写过。
       * 之前用「有没有可见窗口」当绝对判据，实测会被 Snipaste 的各种窗口
       * 带偏（主面板 169×221、贴图窗、设置窗…）→ 恒 true → 用户按 Esc
       * 判不出取消，只能干等到超时。native 侧已经返工过四次，
       * 详见 orb-foreground.c 里 enum_snip 上方的注释。
       *
       * 为什么靠跳变而不是绝对值 false：snip 命令刚发出、Snipaste 还没建
       * 浮层的那一刻，绝对值也是 false。那时候判取消 = 误杀正常流程。
       * 所以必须**先见过 true**（seenSnipping）才认这个 false 是"用户取消了"。
       */
      if (!seenSnipping) {
        /* ⚠️ 只有「连框选浮层窗口都不存在」才能用 NO_SESSION_MS 兜底放弃。
           ready=true 而 snipping=false = 浮层窗口在但当前不可见 ——
           可能是用户开着贴图窗，也可能是浮层还没建出来。这两种情况下
           若拿"没进过截屏态"去放弃，用户点了复制也会被丢掉
           （这正是独立验证实测复现的丢图路径）。
           所以这种情况只能等剪贴板序列号变化或总超时。 */
        if (!seenReady && Date.now() - startAt >= NO_SESSION_MS) {
          log("[snip] Snipaste 未进入截屏态（可能命令未生效），放弃本次截屏");
          finish("");
        }
        return;
      }
      /* 进过截屏态、现在退出来了，但剪贴板没被写过 —— 用户按了 Esc。
         用**时间**而不是"轮数"来确认：轮数会被查询失败/重入丢掉，
         按时间才稳。 */
      if (!idleSince) { idleSince = Date.now(); return; }
      /* ★ 铁律②：给剪贴板写入留 CANCEL_GRACE_MS 余量。
         Snipaste 窗口消失与剪贴板写入不是同一瞬间 —— 实测写图耗时 3/6/9 秒
         时，图分别要到 t=3328/6172/9375ms 才可读。太短就丢截图。
         这段余量**就是**防丢图的全部机制：宽限期内只要 seq 变了，
         上面那个分支就会接手落盘。
         ⚠️ 起算点是**最后一次见到 snipping=true** 的时刻，不是"首次见 false"。
            二者可以差很远（用户点「复制」→ 浮层消失 → ORB 在几秒后才
            第一次采到 false，此时距浮层消失已经过了好几秒）。
            若从"首次见 false"起算，真正的空档就被算短了 → 误判取消 → 丢图。 */
      const sinceLastSnipping = Date.now() - (lastSnippingAt || startAt);
      if (sinceLastSnipping < CANCEL_GRACE_MS) return;
      if (Date.now() - idleSince < 1500) return;

      /* 到这里 seq 仍然等于基线 —— 剪贴板内容确实**从没被改写过**。
         ⚠️ 这里**故意不再读一次剪贴板**做"二次确认"：
           走到这里说明 seq 没变 → 剪贴板里还是**旧内容**。
           若此刻读出图并落盘，存下来的就是用户之前复制的旧图
           （A-2 类缺陷的翻版：旧图被当成本次截图）。
           真正的"刚写完还没被观察到"由上面的 seq 变化分支负责，
           它每轮轮询都会检查，3000ms 宽限就是给它的观察窗口。 */
      log("[snip] 用户取消了本次框选（Snipaste 已退出且剪贴板未被改写）");
      finish("");
    } catch (e) {
      log("[snip] 截屏轮询异常:", (e && e.message) || String(e));
    } finally {
      inflight = false;
    }
  };

  pollTimer = setInterval(() => { tick().catch(() => {}); }, 400);
  snipWatchTimer = pollTimer;
}

/* ---------------- 设置面板打开时把实时字幕窗让开 ----------------
 * 字幕窗（subWin）是独立窗口、screen-saver 级置顶，面板里的遮罩管不到它。
 * 设置面板一打开，它就浮在设置卡片表面上挡视线。
 * 修法：遮罩期间把它收起来，关掉设置再放回（只恢复"原本可见"的那些，
 * 用户本来就没开字幕时不凭空弹出来）。 */
let sheetOpenNow = false;
let subDucked = false;
function applySheetDuck() {
  if (!subWin || subWin.isDestroyed()) return;
  try {
    if (sheetOpenNow) {
      if (subWin.isVisible()) { subDucked = true; subWin.hide(); }
    } else if (subDucked) {
      subDucked = false;
      subWin.showInactive();
    }
  } catch { /* 窗口正在销毁，忽略 */ }
}
safeHandle("sheet-open", (_e, on) => {
  sheetOpenNow = !!on;
  applySheetDuck();
  return sheetOpenNow;
}, false);

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

/**
 * IPC 传来的名字不能信：既有可能是"我的录屏/2026"这种带分隔符的（拼进路径会
 * 直接写到别的目录，即路径穿越），也可能带 Windows 非法字符（写盘直接 ENOENT）。
 * 统一洗成安全文件名；洗完为空就用调用方给的兜底名。
 */
function safeFileName(name, fallback) {
  const s = String(name == null ? "" : name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, "_")   // 分隔符与非法字符
    .replace(/^\.+/, "")                    // 别以点开头（隐藏文件 / 纯 ".."）
    .replace(/\s+$/, "")                    // 尾部空格在 Windows 上会被静默丢掉
    .trim()
    .slice(0, 80);
  return s || fallback;
}
/** 同秒多次录制时不能互相覆盖 —— 宁可加序号，也不能让用户找不到一分钟前录的东西。 */
function uniqueFile(dir, base, ext) {
  /* basename 兜一层（万一调用方没走 safeFileName），再把结果按 dir 归一化校验：
     算出来的路径必须仍在 dir 里，否则按异常输入处理，落到默认名。 */
  const stem = path.basename(safeFileName(base, "")) || "rec";
  let name = stem + ext;
  for (let i = 2; i <= 999; i++) {
    if (!fs.existsSync(path.join(dir, name))) break;
    name = `${stem}-${i}${ext}`;
  }
  const out = path.join(dir, name);
  const root = path.resolve(dir) + path.sep;
  if (!path.resolve(out).startsWith(root)) return path.join(dir, "rec" + ext);
  return out;
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
    /* 这一路也要把"排除截图"撤回来：会话是被超时回收的，cap-close 永远不会来，
       漏掉就等于用户此后用任何截屏工具都截不到 ORB 自己的界面。 */
    setCaptureShield(false);
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
  /* MediaRecorder 回退链路同样要排除自家窗口，成片里不该有控制台自己。
     与原生链路一致：recbar 不排除（见 setCaptureShield 的注释）。 */
  setCaptureShield(true);
  log("[cap] 开始录制:", id, "mime =", String(o.mime || "").slice(0, 64));
  return { ok: true, sessionId: id, file, mime: o.mime || "" };
}, () => ({ ok: false, sessionId: "", error: "开始录制失败（详见 .orbdata/orb.log）" }));

safeHandle("cap-chunk", async (_e, sessionId, data) => {
  const s = capSessions.get(sessionId);
  if (!s) return { ok: false, bytes: 0, chunks: 0, error: "录制会话不存在或已结束" };
  const buf = toBuffer(data);
  if (!buf.length) return { ok: false, bytes: s.bytes, chunks: s.chunks, error: "分片为空" };
  try {
    let written = 0;
    /* 异步写替代 writeSync：录屏时每个分片都同步卡一次主线程，表现为录制过程中
       整个界面发滞。**顺序必须由 await 串行保证** —— 分片错一个字节，整个 MP4 的
       box 长度就会全部错位，所以这里绝不能改成并发写。 */
    while (written < buf.length) {
      written += await new Promise((res, rej) => {
        // write 也允许部分写入（磁盘满、信号中断都会），必须循环补齐
        fs.write(s.fd, buf, written, buf.length - written, null, (err, n) => (err ? rej(err) : res(n)));
      });
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
  /* 录制结束 → 恢复可截图。放在最前面：后面无论走哪条 return 分支都要恢复，
     漏一条就等于"用户再也截不到自己的界面"。 */
  setCaptureShield(false);
  let size = s.bytes;
  try { fs.closeSync(s.fd); } catch { /* 已经关了 */ }
  try { size = fs.statSync(s.file).size; } catch { /* 用内存里累计的值兜底 */ }

  // 空文件 / 只有几十字节 → 不是有效录制，直接丢掉，别在目录里留垃圾
  if (!size || size < 1024) {
    /* 必须自己删：上面已经 capSessions.delete 过了，capDrop 再按 id 找只会拿到
       undefined、一个字节都不删 —— 于是"录了一秒就停"会在 tmp 里留下一个永远
       没人认领的 .part（只有 24 小时后的启动清理才带走它）。 */
    let removed = false;
    try { fs.unlinkSync(s.file); removed = true; } catch { /* 已经没了 */ }
    log("[cap] 内容过短已丢弃:", sessionId, "bytes =", size, removed ? "" : "（临时文件清理失败）");
    return { ok: false, path: "", bytes: size, error: "录制内容为空或过短，已丢弃" + (removed ? "" : "（临时文件清理失败）") };
  }

  const ms = Number.isFinite(Number(o.ms)) && Number(o.ms) > 0
    ? Number(o.ms)
    : Date.now() - s.startedAt;
  const ext = recExt(s.mime);
  const baseName = safeFileName(
    typeof o.name === "string" ? o.name : "",
    "录屏-" + recStamp()
  );
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
  setCaptureShield(false);   // 放弃录制同样要恢复可截图（原来漏了这一句）
  log("[cap] 放弃录制:", sessionId);
  return { ok: true, removed: dropped.removed, note: dropped.removed ? "已删除临时文件" : "临时文件清理失败" };
}, () => ({ ok: false, removed: false, error: "放弃录制失败（详见 .orbdata/orb.log）" }));

/* ---------------- 原生录屏（Stage 2：orb-cap.exe 直出 MP4） ----------------
 * 与上面的 cap-* 会话链路**完全并行**，互不影响：
 *   · cap-*      渲染进程 MediaRecorder 编码 → 分片写 .part → cap-close 原子 rename
 *   · cap-native-*  原生 exe 自己写一个 .mp4（DXGI 复制 + MF H.264）
 * 面板先试原生，失败（组件缺失 / 被 ORB_CAP=media 禁用 / 启动报错）就**原样**走
 * MediaRecorder —— 兜底是硬要求，任何一处失败都不能让"录屏"这个功能消失。
 * ORB_CAP=native|media|auto（默认 auto）：auto = 有 exe 就用原生，否则 media。
 */
function capMode() {
  const v = String(process.env.ORB_CAP || "auto").trim().toLowerCase();
  return (v === "native" || v === "media") ? v : "auto";
}

safeHandle("cap-native-start", async (_e, opts) => {
  const mode = capMode();
  if (mode === "media") return { ok: false, error: "已按 ORB_CAP=media 禁用原生录制" };
  if (!capNative.available()) {
    return { ok: false, error: "原生录屏组件不存在（native/dist/orb-cap.exe）" };
  }
  const o = opts && typeof opts === "object" ? opts : {};
  /* 区域录制：接受 { rect }（物理像素）或 { ratio }（相对主屏的 0..1 比例）。
     面板给的是 ratio —— 它不知道 DPI，也不该知道；换算只在这一处做。
     ratio 为全屏 / 不合法时返回 null，采集器走原整屏路径。 */
  const rect = (o.rect && typeof o.rect === "object" && Number(o.rect.w) > 0)
    ? o.rect
    : ratioToPhysical(o.ratio);
  const dir = storage.pathOf("recordings");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: "录屏目录不可用：" + ((e && e.message) || String(e)) };
  }
  /* 命名与 MediaRecorder 链路一致（录屏-YYYYMMDD-HHmmss.mp4），同秒冲突自动加序号。
     路径在这里就定死并回给渲染层：即使后面 start 失败，UI 也知道该去哪找残留。 */
  const target = uniqueFile(dir, "录屏-" + recStamp(), ".mp4");
  try {
    /* 录制期间把自家窗口从画面里摘掉 —— 成片里不该出现控制台自己。
       注意 recbar 不在排除名单里（见 setCaptureShield 的注释）。
       必须在 start **之前**打开：DXGI 复制是连续的，晚一帧成片里就有一帧带自己。
       start 失败要在 catch 里撤回来，否则用户永远截不到自己的界面。 */
    setCaptureShield(true);
    let r;
    try {
      r = await capNative.start({
        outPath: target,
        fps: o.fps,
        bitrate: o.bitrate,
        display: o.display,
        rect,
      });
    } catch (e) {
      /* 这里**不要**撤排除：setCaptureShield 现在是引用计数，内层减一次、
         外层 catch 再减一次，会把并发中的另一路录制一起减掉（成片里就出现
         ORB 自己）。撤排除统一交给外层那一次。 */
      throw e;
    }
    log("[cap-native] 开始录制:", target, r.w + "x" + r.h + "@" + r.fps,
      rect ? ("区域 " + rect.x + "," + rect.y + " " + rect.w + "x" + rect.h) : "整屏");
    return { ok: true, mode: "native", w: r.w, h: r.h, fps: r.fps, path: target, rect: rect || null };
  } catch (e) {
    setCaptureShield(false);   // 启动失败要把排除撤回来，否则用户永远截不到自己的界面
    log("[cap-native] 启动失败:", (e && e.message) || String(e));
    return { ok: false, error: (e && e.message) || String(e), path: target };
  }
}, { ok: false, error: "启动原生录制失败（详见 .orbdata/orb.log）" });

/* pause / resume / abort 走这一条：abort 是"取消并存半成品"，和 stop 语义不同 */
safeHandle("cap-native-cmd", async (_e, cmd) => {
  const c = String(cmd || "");
  try {
    if (c === "abort") {
      const r = await capNative.abort();
      setCaptureShield(false);   // 取消录制同样要恢复可截图
      return { ok: !!(r && r.ok) };
    }
    const r = await capNative.cmd(c);
    return { ok: !!(r && r.ok), line: r && r.line };
  } catch (e) {
    log("[cap-native] 命令失败:", c, (e && e.message) || String(e));
    return { ok: false, error: (e && e.message) || String(e) };
  }
}, { ok: false, error: "原生录屏命令失败（详见 .orbdata/orb.log）" });

safeHandle("cap-native-stop", async () => {
  let saved = null;
  try {
    saved = await capNative.stop();
  } catch (e) {
    /* 失败也把 path 带回去：文件可能已经写了一半，UI 要能提示"可能不完整"
       并给用户一个自己去看的位置，而不是只吐一句"保存失败"。 */
    const partial = capNative.currentPath() || "";
    setCaptureShield(false);   // 录制结束，恢复可截图（失败路径同样要恢复）
    log("[cap-native] 收尾失败:", (e && e.message) || String(e));
    return { ok: false, error: (e && e.message) || String(e), path: partial };
  }
  setCaptureShield(false);     // 录制结束 → 恢复可截图
  const out = {
    ok: true,
    mode: "native",
    path: String(saved.path || ""),
    bytes: Number(saved.bytes) || 0,
    ms: Number(saved.ms) || 0,
    w: Number(saved.w) || 0,
    h: Number(saved.h) || 0,
    mime: "video/mp4",
    ext: ".mp4",
    /* 原生链路的 mvhd 由 MF 写全（不像 MediaRecorder 需要事后补），
       所以没有 patched/viaCopy 那些字段，valid 直接为 true。 */
    valid: true,
    durationMs: Number(saved.ms) || 0,
  };
  /* 与 cap-close 一样落一份 lastRecording：面板/托盘下次启动要靠它显示"最近的录屏" */
  saveState({ lastRecording: { path: out.path, bytes: out.bytes, ms: out.ms, mime: out.mime } });
  log("[cap-native] 录制完成:", out.path, out.bytes, "bytes /", out.ms, "ms");
  return out;
}, { ok: false, error: "停止原生录制失败（详见 .orbdata/orb.log）", path: "" });
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
      /* stop 也必须广播给控制条：页面靠这个事件停表 + clearEnergyTimers。
         以前只 hide 不发事件 → 控制条的 tickTimer 250ms 一直走（它那个窗口是
         backgroundThrottling:false，隐藏也不节流），直到窗口销毁都在烧 CPU。 */
      emitRecEvent(payload);
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
  /* 诊断日志（常驻、只在收到命令时各打一行 —— 一次点击两条，不会刷屏）：
     用户报"按钮点了没反应"时，先看这两行在不在 ——
       只有"收到"没有"已转发" → 面板没了 / 命令名不认识；
       两条都没有 → 点击根本没到页面（穿透还挂着 / 窗口被别的窗口盖住）。 */
  log(`[recbar] 收到命令 "${c}"`);
  try {
    if (c !== "pause" && c !== "resume" && c !== "finish" && c !== "abort") {
      log("[recbar] 未知命令:", c);
      return;
    }
    // 面板没了（被强关 / 崩溃）：控制条再挂着只会让用户点一个没反应的按钮
    if (!panel || panel.isDestroyed()) {
      log(`[recbar] 命令 "${c}" 被丢弃：面板不存在`);
      resetRecbarInteractive(recbarWin);
      try { if (recbarWin && !recbarWin.isDestroyed()) recbarWin.hide(); } catch { /* ignore */ }
      return;
    }
    sendToPanel("rec:cmd", c);
    log(`[recbar] 已转发命令 "${c}" → 面板`);
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
   forward 的平台实现差异（页面里那条 mousemove 判定保留作 macOS 的快路径）。

   ⚠️ 2026-10-25 再修（用户报「悬停展开后，之后再也不缩起」）：
   上一版把 `recbarPassthru` 当成了监视的开关 —— 悬停展开时页面会关掉穿透，
   这一步把监视也一起停了，于是"鼠标移开了"这条 inside:false **再也发不出去**，
   页面只剩自己那条 mouseleave（穿透刚关的那一下 Chromium 常常不补发
   mouseover，没有 enter 就没有 leave）→ 条永远停在展开态。
   现在监视的生命周期改由 `recbarHoverArmed` 单独管：只在控制条真正开始/结束时
   起停，穿透的开与关不再影响它；inside 的连续性也因此保住了（收起→展开→移开
   →再收起，全程同一个 inside 状态在跨边界时才广播）。 */
const REC_HIT = { x0: 16, x1: 224, y0: 0, y1: 34 };   // 与 recbar.html 的 HIT 保持一致
const REC_HOVER_PAD = 8;                              // 判定区外扩，别让人正正好好对准
let recbarPassthru = false;
let recbarHoverTimer = null;
let recbarHoverInside = false;
let recbarHoverArmed = false;      // 监视生命周期（≠穿透状态，见上）
let recbarHoverLastSent = 0;       // 上次广播的时间戳（收起态的重复广播要节流）
function stopRecbarHoverWatch() {
  if (recbarHoverTimer) { clearInterval(recbarHoverTimer); recbarHoverTimer = null; }
  recbarHoverInside = false;
  recbarHoverArmed = false;
  recbarHoverLastSent = 0;
}
function startRecbarHoverWatch() {
  recbarHoverArmed = true;
  if (recbarHoverTimer) return;    // 已在跑：inside 保持连续，别重置成 false
  recbarHoverInside = false;
  recbarHoverTimer = setInterval(() => {
    try {
      if (!recbarHoverArmed || !recbarWin || recbarWin.isDestroyed()) { stopRecbarHoverWatch(); return; }
      const b = recbarWin.getBounds();
      const p = screen.getCursorScreenPoint();
      const inside = p.x >= b.x + REC_HIT.x0 - REC_HOVER_PAD && p.x <= b.x + REC_HIT.x1 + REC_HOVER_PAD
                  && p.y >= b.y + REC_HIT.y0 - REC_HOVER_PAD && p.y <= b.y + REC_HIT.y1 + REC_HOVER_PAD;
      if (inside === recbarHoverInside) {
        /* 收起态里允许对"在里面"重复广播（400ms 节流）：鼠标停在细条上微动时
           坐标没跨边界，就永远等不到一次"进入"事件 —— 用户会觉得"放上去没反应"。
           展开态不重复播（没有意义，页面 expand() 本来就是幂等的）。 */
        if (!(recbarPassthru && inside && Date.now() - recbarHoverLastSent > 400)) return;
        recbarHoverLastSent = Date.now();
        sendToBar("rec:hover", { inside: true });
        return;
      }
      recbarHoverInside = inside;
      recbarHoverLastSent = Date.now();
      /* 诊断日志：只在跨越边界时打一行（140ms 轮询的每帧分支里绝不打）。
         这行是"悬停能不能展开"的唯一证据 —— 如果用户报"收回细条后鼠标放上去不动"，
         看它有没有出现：没出现 = 光标判定区没命中（REC_HIT/REC_HOVER_PAD 与窗口位置对不上、
         或穿透压根没开）；出现了但没有展开日志 = 页面侧 expand() 没跑。 */
      log(`[recbar] 悬停 ${inside ? "进入" : "离开"}（光标 ${p.x},${p.y}；窗口 ${b.x},${b.y} ${b.width}x${b.height}；HIT 内=${inside}）`);
      sendToBar("rec:hover", { inside: inside });
    } catch (e) {
      /* 光标/窗口查询偶尔会失败（显示器热插拔、窗口正在销毁）：
         停掉监视，别把异常每 140ms 刷一次日志 */
      stopRecbarHoverWatch();
      log("[recbar] 悬停监视异常，已停止:", (e && e.message) || String(e));
    }
  /* 60ms（原 140ms）：悬停展开要赶在用户"移过去就点"之前完成。
     穿透态的窗口收不到鼠标事件，只能靠这一条轮询把"可交互"还回去；
     140ms 的粒度下人很容易在第一帧就按下 —— 那一下会被穿透吃掉。 */
  }, 60);
}
ipcMain.on("rec-bar-passthru", (_e, on) => {
  try {
    if (!recbarWin || recbarWin.isDestroyed()) {
      /* 窗口没了但渲染层还在申报穿透：记一行，别静默 —— 这种"状态没人接"的情况
         正是按钮点不动的常见来源。 */
      log(`[recbar] 穿透 ${on ? "ON" : "OFF"} 被忽略：控制条窗口不存在`);
      return;
    }
    const b = recbarWin.getBounds();
    /* 关穿透时不带 options：回到普通可交互窗口 */
    if (on) {
      recbarWin.setIgnoreMouseEvents(true, { forward: true });
      recbarPassthru = true;
      startRecbarHoverWatch();
      log(`[recbar] 穿透 ON（窗口已忽略鼠标）${b.x},${b.y} ${b.width}x${b.height}`);
    } else {
      recbarPassthru = false;
      /* 监视**不停**：展开之后还要靠它把"鼠标移开了"送回页面 —— 停了的话
         页面永远收不回去（这就是"悬停打开后再也不缩起"）。开销只是每 60ms
         一次光标坐标查询，录制期间可以忽略。 */
      recbarWin.setIgnoreMouseEvents(false);
      log(`[recbar] 穿透 OFF（窗口恢复可交互，悬停监视继续）${b.x},${b.y} ${b.width}x${b.height}`);
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
  log("[recbar] 交互复位（穿透=false，HIT 监视停）");
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

/* ---------- 录屏音频来源（设置 › 录屏） ----------
 * 与 set-rectheme 同模式：一处校验、一处落盘，渲染层不自己判断默认值。 */
safeHandle("set-recaudio", (_e, patch) => {
  const src = patch && ["none", "system", "mic", "mix"].includes(patch.source) ? patch.source : "none";
  normalizeRecAudio();
  state.recAudio = { source: src };
  saveState({ recAudio: { source: src } });
  return { ok: true, rec: { source: src } };
}, { ok: false, error: "保存录屏音频来源失败" });

/* ---------- 摄像头小框（设置 › 录屏） ----------
 * 形状 / 比例 / 自定义比例 / 归一化摆位一次校验落盘。
 * custom 档必须带合法 customRatio，否则退回 free（不锁比例）。 */
safeHandle("set-reccam", (_e, patch) => {
  const p = patch || {};
  normalizeRecCam();
  const shape = ["circle", "round", "square"].includes(p.shape) ? p.shape : state.recCam.shape;
  let ratio = ["16:9", "4:3", "1:1", "custom", "free"].includes(p.ratio) ? p.ratio : state.recCam.ratio;
  let customRatio = typeof p.customRatio === "string" ? p.customRatio.trim().slice(0, 12) : state.recCam.customRatio;
  customRatio = validRatioStr(customRatio) || (ratio === "custom" ? state.recCam.customRatio : "");
  if (ratio === "custom" && !customRatio) ratio = "free";
  const f01 = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1, Number(v))) : d);
  const fSize = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0.05, Math.min(0.6, Number(v))) : d);
  const next = {
    enabled: typeof p.enabled === "boolean" ? p.enabled : state.recCam.enabled,
    shape,
    ratio,
    customRatio,
    bx: f01(p.bx, state.recCam.bx),
    by: f01(p.by, state.recCam.by),
    bw: fSize(p.bw, state.recCam.bw),
    bh: fSize(p.bh, state.recCam.bh),
  };
  state.recCam = next;
  saveState({ recCam: next });
  return { ok: true, rec: { ...next } };
}, { ok: false, error: "保存摄像头小框设置失败" });

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

/* 附件两条通道：选文件（多选 + 体积上限）+ 图片缩略图 data URL。
   与 pick-theme-image 同一模式：对话框在主进程，渲染层零 fs 权限。 */
safeHandle("attach-pick", async () => {
  try { return await pickAttachments(); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}, { ok: false, error: "选择附件失败" });
safeHandle("attach-preview", (_e, p) => attachPreview(p), { ok: false, error: "读取图片失败" });

ipcMain.handle("get-state", () => ({
  pinned: state.pinned,
  coordMode: state.coordMode,
  border: state.border,
  /* 这两个字段一个读磁盘（头像可能是几 MB 的图）、一个访问 screen ——
     任一个抛了就会让整个 get-state reject，面板拿不到任何初始状态。
     它们都不是关键字段，失败就给空值，别拖垮整帧状态。 */
  avatar: (() => { try { return avatarDataUrl(); } catch { return ""; } })(),
  /* 悬浮控制条偏好：设置 › 录屏 里的皮肤 / 能量条 / 自选描边色 */
  rec: recCfg(),
  /* 录屏音频来源与摄像头小框（设置 › 录屏）：none/system/mic/mix 与形状/比例/摆位 */
  recAudio: { source: state.recAudio.source },
  recCam: { ...state.recCam },
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
    /* 在线语音合成（可选）。Key 明文不下发，只给 hasTtsKey —— 与上面同一口径。 */
    ttsEngine: state.voice?.ttsEngine ?? "browser",
    ttsEndpoint: state.voice?.ttsEndpoint ?? "",
    ttsModel: state.voice?.ttsModel ?? "tts-1",
    ttsFormat: state.voice?.ttsFormat ?? "mp3",
    ttsVoice: state.voice?.ttsVoice ?? "alloy",
    ttsInstruct: state.voice?.ttsInstruct ?? "",
    ttsPersona: state.voice?.ttsPersona ?? {},
    hasTtsKey: !!(state.voice?.ttsApiKey),
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
  /* 划词工具条总开关：面板「设置 › 通道」里的拨杆直接读它、改它 */
  autoSelect: !!state.autoSelect,
  /* 录屏 / 截屏隐藏控制台：面板「设置 › 通道」里的两枚拨杆 */
  recHideConsole: !!state.recHideConsole, snipHideConsole: !!state.snipHideConsole,
  display: (() => {
    try {
      const d = screen.getPrimaryDisplay();
      return { width: d.size.width * d.scaleFactor, height: d.size.height * d.scaleFactor, scale: d.scaleFactor };
    } catch { return { width: 0, height: 0, scale: 1 }; }
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
/* ---------- 自定义模型（人格台词用） ----------
 * 存在 userData/custom-model.json，**只服务于 persona_bundle 这条轻链路**。
 *
 * 为什么不能接管主任务：后台任务要读文件、跑命令、改代码，靠的是 CLI 的
 * 工具编排；一个裸的 OpenAI 兼容接口给不了这些。所以这里的模型只决定
 * 「人格怎么说」，不决定「任务怎么做」。界面上必须写清楚，否则用户会以为
 * 换模型就能让后台换脑子。
 *
 * key 只落本机、只回掩码：面板永远拿不到明文，实际请求由 bridge 直接读文件发。
 */
/* 必须用 function 声明：spawnBridge 在模块更早处就会调它（注入 ORB_CM_FILE），
   写成 const 箭头函数会撞 TDZ —— 那是最典型的「顶层一次 ReferenceError
   静默掐掉后面整段」事故，表现为窗口起了但功能全残。 */
function cmFile() {
  return path.join(app.getPath("userData"), "custom-model.json");
}
const CM_MASK = "••••";

function cmRead() {
  try {
    const o = JSON.parse(fs.readFileSync(cmFile(), "utf8")) || {};
    return {
      name: String(o.name || ""),
      baseUrl: String(o.baseUrl || ""),
      model: String(o.model || ""),
      key: String(o.key || ""),
      /* 缺字段按 true：老配置是在「只用来生成台词」那一版写的，没有这个字段，
         但它对应的接口多半支持 function calling；真不支持的用户可以在弹窗里关掉。 */
      supportsToolCall: o.supportsToolCall !== false,
    };
  } catch {
    return { name: "", baseUrl: "", model: "", key: "", supportsToolCall: true };
  }
}

safeHandle("cm-get", () => {
  const c = cmRead();
  return {
    ok: true,
    name: c.name,
    baseUrl: c.baseUrl,
    model: c.model,
    hasKey: !!c.key,
    keyMask: c.key ? CM_MASK + c.key.slice(-4) : "",
    supportsToolCall: c.supportsToolCall !== false,
  };
}, { ok: false });

safeHandle("cm-set", (_e, patch) => {
  const cur = cmRead();
  const p = patch && typeof patch === "object" ? patch : {};
  const next = {
    name: String(p.name ?? cur.name).slice(0, 40),
    baseUrl: String(p.baseUrl ?? cur.baseUrl).trim().slice(0, 300),
    model: String(p.model ?? cur.model).trim().slice(0, 120),
    /* key 传空 / 不传 = 保持原值。这样「只改模型名」不必重填 key。 */
    key: typeof p.key === "string" && p.key.trim() ? p.key.trim() : cur.key,
    /* 只有显式传 false 才关掉：这个开关决定它能不能接管后台任务 */
    supportsToolCall: p.supportsToolCall === undefined ? cur.supportsToolCall !== false : p.supportsToolCall !== false,
  };
  try {
    fs.mkdirSync(path.dirname(cmFile()), { recursive: true });
    fs.writeFileSync(cmFile(), JSON.stringify(next), "utf8");
    try { fs.chmodSync(cmFile(), 0o600); } catch { /* Windows 下可能不支持，忽略 */ }
    return { ok: true, hasKey: !!next.key, supportsToolCall: next.supportsToolCall };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}, { ok: false });

safeHandle("cm-clear", () => {
  try { fs.unlinkSync(cmFile()); } catch { /* 本来就没有 */ }
  return { ok: true };
}, { ok: false });

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
/* ⚠️ Electron 44 的 readText()/writeText() 都是 **Promise** —— 必须 await，
   否则 IPC 返回的是 Promise 对象（渲染层拿到 "[object Promise]"）。 */
safeHandle("clipboard-read", async () => await clipboard.readText().catch(() => ""), "");
safeHandle("clipboard-write", async (_e, text) => { await clipboard.writeText(String(text ?? "")).catch(() => {}); return true; }, false);

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
  /* 传 null = 保持原 Key 不变。旧版写的是 `delete next.apiKey` —— 但 next 会整体
     写回 state.voice，删键等于**把已存的 Key 抹了**，和注释描述的语义正好相反。
     面板目前只在不改 Key 时"不带该字段"，所以一直没爆；但这是个随时会踩的坑，
     改成还原旧值（等价于"什么都不做"）。 */
  if (next.apiKey === null) next.apiKey = cur.apiKey || "";
  /* 同上：传 null 表示保持原 Key。
     ⚠️ 这里不能 delete —— next 是要整体写回 state.voice 的，删掉键等于把
        已存的 Key 一起抹了（ASR 那条 apiKey 用的是 delete，语义上其实有同样的坑，
        但面板从来不传 null，只在不改 Key 时**不带这个字段**，所以没爆）。
        在线合成这边明确保守：null → 还原成 cur 的值。 */
  if (next.ttsApiKey === null) next.ttsApiKey = cur.ttsApiKey || "";
  saveState({ voice: next });
  return {
    ok: true,
    voice: {
      engine: next.engine, endpoint: next.endpoint, model: next.model, lang: next.lang,
      hasKey: !!(next.apiKey),
      /* Key 本身不回传渲染层，只给一个"存了没有"的布尔 —— 面板靠它显示状态。 */
      hasTtsKey: !!(next.ttsApiKey),
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
  /* 端点要做协议闸：这个通道会把用户的 ASR Key 当 Bearer 发出去，
     放行任意字符串就等于"谁拿到面板就能把音频和密钥投到任意地址"。
     本地自建（127.0.0.1 / localhost）要留着 —— 自建 Whisper 服务端是主要用法之一。 */
  try {
    const u = new URL(String(endpoint));
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { ok: false, error: "语音识别端点协议不支持（仅 http/https）" };
    }
  } catch {
    return { ok: false, error: "语音识别端点不是合法 URL" };
  }
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
 * 在线语音合成（TTS）代理：面板把文本和端点/音色发过来，主进程代发 HTTP 请求。
 * 存在的理由与 asr-transcribe 完全相同 —— 面板 CSP 只放行 127.0.0.1:19387，
 * 渲染层发不出去；而且 API Key 不该出现在渲染层。
 * 接口形态对齐 OpenAI /v1/audio/speech：{model, input, voice, response_format, speed}，
 * 兼容这个形态的厂商/自建服务都能直接用。
 * ⚠️ 失败一律返回 ok:false，由调用方回落到浏览器内置语音 —— 不能让用户因为
 *    填错一个地址就彻底没声。
 */
ipcMain.handle("tts-online", async (_e, p) => {
  const { endpoint, model, voice, text, format, speed, instruct } = (p && typeof p === "object") ? p : {};
  if (!endpoint) return { ok: false, error: "未配置语音合成端点" };
  /* 协议闸：这个通道会把主进程里的 TTS Key 当 Bearer 发出去，
     放行任意字符串等于把密钥投到任意地址。本地自建（127.0.0.1）要保留。 */
  try {
    const u = new URL(String(endpoint));
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { ok: false, error: "语音合成端点协议不支持（仅 http/https）" };
    }
  } catch {
    return { ok: false, error: "语音合成端点不是合法 URL" };
  }
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "要合成的文本为空" };
  if (t.length > 800) return { ok: false, error: "文本过长（上限 800 字）" };
  try {
    const body = { model: String(model || "tts-1"), input: t, voice: String(voice || "alloy") };
    if (format) body.response_format = String(format);
    const sp = Number(speed);
    if (sp > 0) body.speed = Math.min(4, Math.max(0.25, sp));
    /* instructions 只有部分模型（gpt-4o-mini-tts 等）认，不认的会忽略这个字段，
       不会报错 —— 所以无条件带上，让支持的服务能收到语气提示。 */
    if (instruct) body.instructions = String(instruct).slice(0, 300);
    const headers = { "Content-Type": "application/json" };
    const key = (state.voice && state.voice.ttsApiKey) || "";
    if (key) headers.Authorization = "Bearer " + key;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let r;
    try {
      r = await fetch(endpoint, {
        method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { ok: false, error: "TTS HTTP " + r.status + "：" + txt.slice(0, 200) };
    }
    const ab = await r.arrayBuffer();
    if (!ab || !ab.byteLength) return { ok: false, error: "服务端返回的音频为空" };
    return {
      ok: true,
      mime: r.headers.get("content-type") || "audio/mpeg",
      b64: Buffer.from(ab).toString("base64"),
    };
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
/* opt.wake = true → 让 bridge 在回状态前先把识别服务拉起来（见 voice.js 的注释：
   服务空闲 5 分钟会被回收，点麦克风时它是睡着的，只探活会误判成"没装"）。
   ⚠️ 必须带超时：加载 medium 权重在 GPU 冷启动 / 回落 CPU 时要几秒到几十秒，
      没有超时的话面板会一直挂在"正在启动本地识别服务…"。 */
ipcMain.handle("asr-status", async (_e, opt) => {
  try {
    const token = bridgeTokenSync();
    const headers = {};
    if (token) headers["X-Orb-Token"] = token;
    const q = (opt && opt.wake) ? "?wake=1" : "";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), (opt && opt.wake) ? 95000 : 5000);
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${PORT}/api/asr${q}`, { headers, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) return { ok: false, error: "bridge HTTP " + r.status };
    const j = await r.json();
    return { ok: true, ...j };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});
