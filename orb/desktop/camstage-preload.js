/* 摄像头小框 · 全屏摆位层的桥。两件事：取初始状态 / 交出结果。
   不暴露文件、进程、shell —— 这一层存在的唯一理由是 contextIsolation。 */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("orb", {
  /** 页面加载后主动拉初始状态（比"创建完再 send"少一个竞态 —— region 那边踩过）：
   *  @returns {Promise<{cam:{shape,ratio,customRatio,bx,by,bw,bh}, dip:{w,h}, sf:number,
   *                     region:({x,y,w,h}|null)}>} */
  init: () => ipcRenderer.invoke("cam-stage-init"),
  /** @param {{kind:'ok'|'cancel', cam?:{shape,ratio,bx,by,bw,bh}}} msg
   *  kind='ok' 时 bx/by 是**中心点占屏比例**、bw/bh 是**占屏宽高比例**（0..1），
   *  与主进程 recCam 的既有口径完全一致，保存时不需要再折算。 */
  done: (msg) => ipcRenderer.send("cam-stage-done", msg),
});
