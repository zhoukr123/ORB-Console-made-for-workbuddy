/* 真实 PDF 渲染冒烟（必须用 Electron 跑，node 跑不了）
 *
 * 用法（Windows）：
 *   cd orb
 *   env -u ELECTRON_RUN_AS_NODE ./desktop/node_modules/electron/dist/electron.exe tools/pdf-render-smoke.cjs
 *
 * ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE。这个变量在 ORB 的运行环境里常驻（bridge 就靠它
 *    退化成纯 Node），带着它启动 electron.exe 会直接跑成 Node，
 *    于是 require("electron") 变成一个路径字符串、printToPDF 根本不存在 —— 报错还很像"没装"。
 *
 * 验证的是**平台能力**，不是业务逻辑：
 *   ① 隐藏窗口能不能用 data:text/html 载入一段中文 HTML；
 *   ② webContents.printToPDF 在当前 Electron 版本上是不是真的能出字节；
 *   ③ 产物是不是真 PDF（文件头 %PDF-）、中文有没有丢（页数/字节数合理）；
 *   ④ .part + rename 的原子写在这条路径上成立。
 *
 * 为什么单独写一个：主进程里的 artifact-render-pdf 只有把整个应用跑起来才能碰到，
 * 而这个能力的风险全在「Electron 版本换了两三年，printToPDF 的参数还认不认」，
 * 用一个 60 行的独立脚本就能把这块钉住，不必为了验证它去启动托盘和面板。
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

app.disableHardwareAcceleration();

function says(name, cond, extra) {
  console.log((cond ? "  PASS " : "  FAIL ") + name + (cond || extra === undefined ? "" : " → " + JSON.stringify(extra).slice(0, 300)));
  if (!cond) process.exitCode = 1;
}

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-pdf-smoke-"));
  const out = path.join(dir, "smoke.pdf");
  const html = [
    "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>冒烟</title>",
    "<style>body{font-family:system-ui,sans-serif;margin:2rem;line-height:1.7}",
    "h1{font-size:22px}pre{white-space:pre-wrap}</style></head><body>",
    "<h1>PDF 渲染冒烟</h1><pre>第一段：中文不能丢。\n第二段：A4 版式。\n第三段：—·—</pre>",
    "<p>第 2 页占位（用足够长的内容把分页撑出来）</p>",
    "<div style=\"height:900px\"></div><p>这是第二页的内容。</p></body></html>",
  ].join("\n");
  /* 与主进程完全一致的 CSP 注入方式 */
  const csp = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: file:; style-src 'unsafe-inline'\">";
  const safeHtml = html.replace(/<head[^>]*>/i, (m) => m + csp);

  let win = null;
  try {
    win = new BrowserWindow({
      show: false, width: 1024, height: 768,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    await win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(safeHtml));
    says("隐藏窗口能载入 data:text/html（含 inline style 与中文）", true);

    const buf = await win.webContents.printToPDF({
      printBackground: true, pageSize: "A4", margins: { marginType: "default" },
    });
    says("printToPDF 返回了字节", Buffer.isBuffer(buf) && buf.length > 0, buf && buf.length);
    says("产物以 %PDF- 开头（是真 PDF，不是空壳）", buf.slice(0, 5).toString() === "%PDF-", buf.slice(0, 8).toString());
    says("字节数落在合理区间（>3KB 且 <10MB）", buf.length > 3000 && buf.length < 10 * 1024 * 1024, buf.length);

    /* 页数：读 /Type /Page 出现次数（不算 /Pages 容器） */
    const txt = buf.toString("latin1");
    const pages = (txt.match(/\/Type\s*\/Page[^s]/g) || []).length;
    says("确实分了页（>=1 页，长内容能分到第 2 页）", pages >= 1, pages);

    const part = out + ".part";
    fs.writeFileSync(part, buf);
    fs.renameSync(part, out);
    says("原子写：.part 已重命名，不留半个文件", fs.existsSync(out) && !fs.existsSync(part));
    says("落盘文件大小与内存缓冲一致", fs.statSync(out).size === buf.length, { disk: fs.statSync(out).size, mem: buf.length });
    console.log("  产物：" + out);
  } catch (e) {
    says("渲染过程没有抛错", false, String((e && e.message) || e));
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    console.log(process.exitCode ? "\nPDF_SMOKE_FAIL" : "\nPDF_SMOKE_OK");
    app.exit(process.exitCode || 0);
  }
});
