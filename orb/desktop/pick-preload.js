/* 框选取词覆盖层的桥。
   三个动作：交出矩形 / 交出挑好的文字 / 要求重框；一个收听口收 OCR 结果。
   不暴露任何文件、进程、shell —— 这一层存在的唯一理由是 contextIsolation。 */
"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const on = (ch, cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld("orb", {
  /** @param {{kind:string, rect?:object, text?:string}} msg
   *  kind = "rect"（框好了）/ "text"（挑好了）/ "cancel"（放弃） */
  pickDone: (msg) => ipcRenderer.send("pick-done", msg),
  /** 「重框」：主进程据此重置等待阶段，别把它当成一次结束 */
  pickRedo: () => ipcRenderer.send("pick-redo"),
  /** 主进程 OCR 完把「底图 + 每行文字的框」推回来 */
  onOcrResult: (cb) => on("ocr-result", cb),
  /** 复位成「等框选」的初始态。覆盖层窗口是复用的（隐藏而非销毁），
   *  不收尾复位的话页面会停在上一次的 phase，下次弹出来就是定格画面。 */
  onReset: (cb) => on("pick-reset", cb),
});
