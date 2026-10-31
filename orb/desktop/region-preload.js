/* 录屏选区覆盖层的桥。只有两件事：取初始状态 / 交出结果。
   不暴露文件、进程、shell —— 这一层存在的唯一理由是 contextIsolation。 */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orb", {
  /** 页面加载后主动拉初始状态（比"创建完再 send"少一个竞态）：
   *  @returns {Promise<{ratio:{x,y,w,h}, dip:{w,h}, sf:number}>} */
  init: () => ipcRenderer.invoke("region-init"),
  /** @param {{kind:'ok'|'cancel', rect?:{x,y,w,h}}} msg
   *  kind='ok' 时 rect 是**窗口内的 CSS 像素**（相对主显示器左上角），
   *  主进程负责按 scaleFactor 换成物理像素与比例。 */
  done: (msg) => ipcRenderer.send("region-done", msg),
});
