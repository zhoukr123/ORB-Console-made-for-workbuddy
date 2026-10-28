const { contextBridge, ipcRenderer } = require("electron");

/* 事件订阅表：channel -> Map(cb -> wrapper)
 *
 * 为什么要有这张表：contextBridge 只能把包装过的函数丢给渲染层，
 * 外面拿到的是 cb 而不是 ipcRenderer 真正注册的那个 wrapper，
 * 于是没有任何办法解绑 —— 同一个回调被注册几次，事件就会触发几次。
 * 现在同一 (channel, cb) 只注册一次，并且额外暴露 off() 供显式解绑。
 */
const listeners = new Map();

const on = (channel, cb) => {
  let m = listeners.get(channel);
  if (!m) { m = new Map(); listeners.set(channel, m); }
  if (m.has(cb)) return cb;                 // 同一个回调不重复注册
  const wrapper = (_e, ...args) => cb(...args);
  m.set(cb, wrapper);
  ipcRenderer.on(channel, wrapper);
  return cb;
};

const off = (channel, cb) => {
  const m = listeners.get(channel);
  if (!m) return;
  const wrapper = m.get(cb);
  if (!wrapper) return;
  try { ipcRenderer.removeListener(channel, wrapper); } catch { /* 已解绑 */ }
  m.delete(cb);
};

contextBridge.exposeInMainWorld("orb", {
  /* 解绑：与 on() 配对使用。传的是当初传给 on() 的那个回调。 */
  off: (channel, cb) => off(channel, cb),

  /* 面板控制 */
  openPanel: () => ipcRenderer.send("panel-open"),
  closePanel: () => ipcRenderer.send("panel-close"),
  togglePanel: () => ipcRenderer.send("ball-click"),

  /* 悬浮球 */
  dragBegin: () => ipcRenderer.send("drag-begin"),
  dragEnd: () => ipcRenderer.send("drag-end"),
  contextMenu: () => ipcRenderer.send("ball-context"),
  undock: () => ipcRenderer.send("undock"),
  hover: (on) => ipcRenderer.send("hover", !!on),

  /* 状态 */
  getState: () => ipcRenderer.invoke("get-state"),
  getBridgeToken: () => ipcRenderer.invoke("bridge-token"),
  getVisionKey: (slot) => ipcRenderer.invoke("get-vision-key", slot),
  setVision: (patch) => ipcRenderer.invoke("set-vision", patch),
  /* 自定义模型（只用于人格台词生成）。key 只写不读：读回来的是掩码，
     真正的明文留在主进程写的那份文件里，由 bridge 直接读。 */
  cmGet: () => ipcRenderer.invoke("cm-get"),
  cmSet: (patch) => ipcRenderer.invoke("cm-set", patch),
  cmClear: () => ipcRenderer.invoke("cm-clear"),
  setVoice: (patch) => ipcRenderer.invoke("set-voice", patch),
  /* 首跑向导「已看过」标记（对应 main.js 的 set-wizard-done）。
     单独开通道而不复用 setVision：UI 标记不该混进视觉配置的写入语义。 */
  setWizardDone: (v) => ipcRenderer.invoke("set-wizard-done", v),
  asrTranscribe: (p) => ipcRenderer.invoke("asr-transcribe", p),
  /* 本地 Whisper 状态（/api/asr 代理）：voice.js 在 engine=auto 时据此选择本地/浏览器引擎 */
  asrStatus: () => ipcRenderer.invoke("asr-status"),
  startVoice: () => ipcRenderer.send("voice-start"),
  setPin: (v) => ipcRenderer.send("pin", v),
  setHold: (v) => ipcRenderer.send("hold", !!v),
  setBusy: (v) => ipcRenderer.send("busy", !!v),
  setObserving: (v) => ipcRenderer.send("observe", !!v),
  /* 「外观 › 动效」开关：面板改完要告诉主进程，否则悬浮球那套常驻动效
     不知道用户已经不想看动效了（球的窗口自己读不到面板的 localStorage）。 */
  setMotion: (on) => ipcRenderer.send("motion", !!on),
  /* 「设置 › 个性」那份偏好（人格 / 动图 / 记忆 / TTS）。面板落 localStorage 只够
     自己用；悬浮球是独立窗口，读不到那份 localStorage，所以整份经主进程中转。
     传的是纯数据（字符串/布尔/数字），不做任何 fs 或 shell 暴露。 */
  setCharacter: (cfg) => ipcRenderer.send("character", cfg),

  /* 会话历史（落盘到 <存储根>/history/conversations.json） */
  historyLoad: () => ipcRenderer.invoke("history-load"),
  historySave: (data) => ipcRenderer.invoke("history-save", data),

  /* 长期文件的存储根目录：录屏 / 历史 / 截图都挂在它下面。
     注意这里不给 fs、不给 shell、也不给通用 invoke ——
     渲染层能做的只有"选目录 / 查用量 / 打开子目录"这三件具体的事。 */
  storageGet: () => ipcRenderer.invoke("storage-get"),
  storagePick: () => ipcRenderer.invoke("storage-pick"),
  storageSet: (dir) => ipcRenderer.invoke("storage-set", dir),
  storageMigrate: () => ipcRenderer.invoke("storage-migrate"),
  storageOpen: (kind) => ipcRenderer.invoke("storage-open", kind),

  /* 屏幕录制：抓流与编码在渲染进程（MediaRecorder 直出 MP4），
     主进程负责落盘收尾。capChunk 传 ArrayBuffer，不接受 base64。 */
  capSources: () => ipcRenderer.invoke("cap-sources"),
  capOpen: (opts) => ipcRenderer.invoke("cap-open", opts),
  capChunk: (sessionId, data) => ipcRenderer.invoke("cap-chunk", sessionId, data),
  capClose: (sessionId, opts) => ipcRenderer.invoke("cap-close", sessionId, opts),
  capAbort: (sessionId) => ipcRenderer.invoke("cap-abort", sessionId),

  /* 原生录屏（Stage 2）：编码在主进程起的 orb-cap.exe 里（DXGI + MF 直出 MP4），
     渲染层不碰流也不碰字节，只要三条命令式调用。失败一律回 { ok:false, error }，
     面板据此回退到上面的 MediaRecorder 链路 —— 所以这三条**不能抛**。
     刻意只开三个具名通道，不给通用 invoke（白名单一旦变成万能钥匙，
     contextIsolation 就只剩个名字了）。 */
  capNativeStart: (opts) => ipcRenderer.invoke("cap-native-start", opts),
  capNativeCmd: (cmd) => ipcRenderer.invoke("cap-native-cmd", cmd),
  capNativeStop: () => ipcRenderer.invoke("cap-native-stop"),

  /* 截屏（Snipaste）：装没装 / 唤起框选 / 首跑引导卡已读。
     唤起后截图由 Snipaste 直写 <存储根>/screenshots，字节不经过 IPC。 */
  snipDetect: () => ipcRenderer.invoke("snip-detect"),
  snipRun: () => ipcRenderer.invoke("snip-run"),
  snipGuideDone: (v) => ipcRenderer.invoke("snip-guide-done", !!v),
  /* 截屏期间别缩回：主进程盯着这次截图的目标文件，落盘/取消/超时才回这一条。
     渲染层据此决定什么时候解除面板保持（见 panel.html 的 snipHold）。 */
  onSnipDone: (cb) => on("snip-done", cb),
  /* 设置遮罩开关：主进程据此把实时字幕窗（独立置顶窗）让开，
     否则它会浮在设置卡片表面上。 */
  setSheetOpen: (v) => ipcRenderer.invoke("sheet-open", !!v),

  /* 桌面模糊背景（磨砂玻璃的"磨砂"来源）：透明窗里 backdrop-filter 采不到桌面，
     由主进程抓一张桌面实拍垫在卡片背后（窗口已 setContentProtection 排除出截图，
     抓图不含自身，故不藏窗、不闪）。want = 申报要不要（玻璃态才要），
     通道名与 recbar-preload 共用，主进程按发送窗口各记各的回传通道。 */
  glassBgWant: (on) => ipcRenderer.send("glass-bg-want", !!on),
  glassBgRefresh: () => ipcRenderer.send("glass-bg-refresh"),
  onGlassBg: (cb) => on("glass:bg", cb),

  /* 悬浮控制条联动。面板录制开始后自己会隐藏，控制键落在独立悬浮窗上，
     所以两条通道都是"转发"：面板把状态递给主进程，主进程再转给控制条；
     控制条的用户操作同样经主进程回到这里。 */
  /* 走 on() 表（与其余 20+ 条订阅同一套）：裸 ipcRenderer.on 绕开了去重与
     off()，重复注册解不掉，窗口复用（hide/show）时会叠监听。 */
  onRecCmd: (cb) => on("rec:cmd", cb),
  sendRecBarEvent: (payload) => ipcRenderer.send("rec-cmd-to-bar", payload),
  /* 控制条偏好（皮肤 / 能量条 / 描边颜色）。落盘在主进程 orb-state.json，
     由 set-rectheme 收口：一处校验、一处落盘、一处推给控制条。 */
  setRecTheme: (patch) => ipcRenderer.invoke("set-rectheme", patch),
  setRecAudio: (patch) => ipcRenderer.invoke("set-recaudio", patch),
  setRecCam: (patch) => ipcRenderer.invoke("set-reccam", patch),
  /* 实时字幕窗偏好（皮肤 + 描边色）：同一套皮肤逻辑，字幕默认深纱。 */
  setSubTheme: (patch) => ipcRenderer.invoke("set-sub-theme", patch),
  /* 主题自选（设置 › 外观）：交互键换色、极光渐变搭配、自定义主题背景图。
     图片对话框在主进程（渲染层没有 fs 权限），选完回 data URL。 */
  setThemeAccent: (patch) => ipcRenderer.invoke("set-theme-accent", patch),
  /* 主题切换时把当前主题名报给主进程，由它同步给划词工具栏等独立窗口
     （那些窗口没有自己的主题系统，靠主进程打 data-theme 才能跟随换肤）。 */
  reportTheme: (name, vars) => ipcRenderer.send("theme-changed", name, vars || null),
  pickThemeImage: () => ipcRenderer.invoke("pick-theme-image"),
  clearThemeImage: () => ipcRenderer.invoke("clear-theme-image"),
  /* 附件（加号）：引用语义 —— 选文件只回 {name,path,size}，文件不拷贝不移动，
     面板把路径拼进任务文本，Agent 凭路径自己读；缩略图另走 attach-preview
     读一张 ≤4MB 的图片 data URL。同样守白名单：不给 fs、不给通用 invoke。 */
  pickAttachments: () => ipcRenderer.invoke("attach-pick"),
  attachPreview: (p) => ipcRenderer.invoke("attach-preview", p),
  /* 字幕窗皮肤推送（主进程 → 字幕窗；面板只负责发起点，不转发） */
  onSubCfg: (cb) => on("sub:cfg", cb),

  /* 剪贴板 */
  readClipboard: () => ipcRenderer.invoke("clipboard-read"),
  writeClipboard: (t) => ipcRenderer.invoke("clipboard-write", t),
  getCursor: () => ipcRenderer.invoke("cursor"),
  getBounds: () => ipcRenderer.invoke("orb-bounds"),   // 录制时排除自身窗口

  /* 外部 */
  openExternal: (url) => ipcRenderer.send("open-external", url),
  triggerReload: () => ipcRenderer.send("trigger-reload"),

  /* 使用说明：设置面板「关于」页的入口。
     返回布尔值，让面板能显示"打开失败"而不是假装成功。 */
  openGuide: () => ipcRenderer.invoke("open-guide"),
  openGuideDir: () => ipcRenderer.invoke("open-guide-dir"),

  /* 打开 CodeBuddy CLI 登录脚本（桌面那份，回落项目根目录）。
     设置面板「后台 Agent」里的直达入口，省得每次去桌面翻。 */
  openCliLogin: () => ipcRenderer.invoke("open-cli-login"),

  /* 划词工具条 */
  toolbarHide: () => ipcRenderer.send("toolbar-hide"),
  toolbarAction: (action, text) => ipcRenderer.send("toolbar-action", action, text),

  /* 实时字幕悬浮窗 */
  setSubtitle: (show) => ipcRenderer.invoke(show ? "subtitle-show" : "subtitle-hide"),
  onSubtitleLines: (cb) => on("subtitle-lines", cb),

  /* 事件 */
  onDockState: (cb) => on("dock-state", cb),
  onPanelState: (cb) => on("panel-state", cb),
  onBusy: (cb) => on("busy", cb),
  onMotion: (cb) => on("motion", cb),
  onAvatar: (cb) => on("avatar", cb),
  /* 个性偏好与动图：`character` 是主进程归一化后的整份配置（含每张 GIF 的真实
     循环时长 gifMeta，球靠它算「只播一遍」要多久）；`recv` 是「用户刚发出一条
     任务」的瞬时信号，用来点头 —— busy 那个信号来的时候已经在思考了。 */
  onCharacter: (cb) => on("character", cb),
  onRecv: (cb) => on("recv", cb),
  /* 面板指定悬浮球播某张动图（专属行为用：傲娇害羞、温柔晚安睡觉…）。
     只传动图 id，球的播放/关停/时长逻辑都在它自己那边。 */
  onGesture: (cb) => on("gesture", cb),
  /* 面板：发出任务的瞬间报一下，让悬浮球点头。 */
  taskSent: () => ipcRenderer.send("task-sent"),
  /* 指定手势：让球播某张动图（见 onGesture）。 */
  gesture: (id) => ipcRenderer.send("gesture", id),
  onPrefill: (cb) => on("prefill", cb),
  onRecordMark: (cb) => on("record-mark", cb),   // 录制时的手动打点热键
  onNotice: (cb) => on("notice", cb),
  onPinState: (cb) => on("pin-state", cb),
  onCoordMode: (cb) => on("coord-mode", cb),
  onBorderMode: (cb) => on("border-mode", cb),
  onFocusRoute: (cb) => on("focus-route", cb),
  onSelectionText: (cb) => on("selection-text", cb),
  onClipboardText: (cb) => on("clipboard-text", cb),
  onVoiceStart: (cb) => on("voice-start", cb),
});
