/**
 * 悬浮录屏控制条的 preload。
 * 与 panel 的 preload 分开而不是复用那个：面板侧已经有上百个白名单方法，
 * 控制条只需要"发命令"和"收事件"两件事，复用会让渲染层拿到一堆用不到的接口。
 * contextIsolation:true / nodeIntegration:false，只暴露下面两个方法。
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
});
