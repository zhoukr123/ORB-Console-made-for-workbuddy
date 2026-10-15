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

  /* 会话历史（落盘到 <控制台>/history/conversations.json） */
  historyLoad: () => ipcRenderer.invoke("history-load"),
  historySave: (data) => ipcRenderer.invoke("history-save", data),

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
  onAvatar: (cb) => on("avatar", cb),
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
