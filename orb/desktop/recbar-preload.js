/**
 * 悬浮录屏控制条的 preload。
 * 与 panel 的 preload 分开而不是复用那个：面板侧已经有上百个白名单方法，
 * 控制条只需要"发命令 / 收事件 / 收配置 / 切点击穿透 / 收悬停"五件事，
 * 复用会让渲染层拿到一堆用不到的接口。
 * contextIsolation:true / nodeIntegration:false，只暴露下面五个方法。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orb", {
  /* 控制条 → 主进程：pause / resume / finish / abort。
     只发不收：命令的最终结果由主进程以 rec:event 广播回来，
     本地不维护任何"我以为成功了"的状态。 */
  sendBarCmd: (cmd) => ipcRenderer.send("rec-bar-cmd", cmd),

  /* 主进程 → 控制条：{ type: 'start'|'pause'|'resume'|'stop' }。
     这里直接用 ipcRenderer.on 而不是 panel 那套 on/off 包装表：
     控制条整个生命周期只有一个回调，不存在重复注册导致的多次触发问题。 */
  onRecEvent: (cb) => ipcRenderer.on("rec:event", (_e, payload) => cb(payload)),

  /* 主进程 → 控制条：{ skin:'light'|'dark', energy:boolean, borderColor:'#rrggbb'|'' }。
     皮肤 / 能量条开关 / 自选描边色三项偏好都在设置 › 录屏 里改，
     由主进程落盘后推进来 —— 控制条自己不存偏好（它是被反复创建销毁的小窗）。 */
  onRecCfg: (cb) => ipcRenderer.on("rec:cfg", (_e, payload) => cb(payload)),

  /* 控制条 → 主进程：收成能量条时把窗口切成点击穿透，
     否则那条细条会挡住背后的最大化按钮 / 浏览器标签页。 */
  setClickThrough: (on) => ipcRenderer.send("rec-bar-passthru", !!on),

  /* 主进程 → 控制条：{ inside: true|false } —— 穿透期间由**主进程**盯着光标
      （screen.getCursorScreenPoint 定时比对窗口矩形），进出各广播一次。
      为什么不由页面自己判：Windows 下 setIgnoreMouseEvents(forward:true) 的
      mousemove 转发并不可靠，穿透态里页面可能一个鼠标事件都收不到，
      于是悬停永不展开、按钮彻底点不到（2026-10-22 修）。 */
  onRecHover: (cb) => ipcRenderer.on("rec:hover", (_e, payload) => cb(payload)),

  /* 桌面模糊底图：控制条的纱（α.82）在透明窗里同样采不到桌面 —— .skin 的
     backdrop-filter 身后只有透明。由主进程抓桌面实拍垫在 .skin 背后
     （窗口已 setContentProtection 排除出截图，抓图不含自身，故不藏窗、不闪），
     .skin 的 blur(8px) 负责糊成磨砂。控制条常驻可见，所以常申报。 */
  glassBgWant: (on) => ipcRenderer.send("glass-bg-want", !!on),
  onGlassBg: (cb) => ipcRenderer.on("recbar:glass-bg", (_e, payload) => cb(payload)),
});
