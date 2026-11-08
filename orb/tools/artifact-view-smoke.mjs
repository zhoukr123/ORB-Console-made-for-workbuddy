#!/usr/bin/env node
/* I-17 产物浮层端到端冒烟：起一个独立端口 + 临时存储根的桥，真走一遍
   「导出 → 登记 → 卡片列表 → 点开读预览 → 文件被移走后状态变 missing」。
   绝不碰生产 .bridge.json / 生产产物树；跑完杀进程并清临时目录。

   用法：node tools/artifact-view-smoke.mjs
   退出码 0 = 全部通过。 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orb-art-view-"));
const PORT = 19400 + Math.floor(Math.random() * 400);
const TOKEN = "smoke-" + Date.now().toString(36);
const API = `http://127.0.0.1:${PORT}`;

let bad = 0;
const ok = (m) => console.log("  ✓ " + m);
const fail = (m) => { bad++; console.log("  ✗ " + m); };
const check = (cond, m) => cond ? ok(m) : fail(m);

const env = {
  ...process.env,
  ORB_PORT: String(PORT),
  ORB_TOKEN: TOKEN,
  ORB_TOKEN_FILE: path.join(tmp, ".bridge.json"),
  ORB_DATA_DIR: tmp,
  ORB_STORAGE_ROOT: tmp,
  ORB_ASR_AUTOSTART: "0",
  ORB_ENABLE_DSH: "0",
  ORB_WB_DAEMON: "0",
};
const child = spawn(process.execPath, [path.join(ROOT, "bridge.mjs")], {
  env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += String(d).slice(0, 4000); });

async function req(p, init = {}) {
  const headers = { "X-Orb-Token": TOKEN, ...(init.headers || {}) };
  const r = await fetch(API + p, { ...init, headers, signal: AbortSignal.timeout(6000) });
  return r.json();
}
const post = (p, body) => req(p, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await req("/api/status"); if (r && r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let exportedPath = "";
try {
  check(await waitUp(), `桥在 ${PORT} 上起来了（独立端口/临时存储根）`);

  const ex = await post("/api/export", { format: "md", text: "# 冒烟标题\n\n一二三四五", title: "I-17 冒烟" });
  exportedPath = String(ex.path || "");
  check(ex.ok === true && !!exportedPath, "导出 .md 成功并拿到落盘路径");
  check(fs.existsSync(exportedPath), "导出文件确实存在于产物树");

  const view = await req("/api/artifacts/view?limit=200");
  const row = (view.rows || []).find((r) => r.ext === "md" && /export-/.test(r.name));
  check(!!row, "卡片列表里出现这条产物");
  if (row) {
    /* 产物布局 2026-11-08 已扁平化为 <kind>/<day>/<name>（旧的
       <day>/sessions/<cid>/<kind>/<name> 只作只读兼容）。这里锁的是"完整形状 +
       不含绝对路径"，不是某一段的旧写法。 */
    check(/^(recordings|screenshots|vidx|exports|archive|misc)\/\d{4}-\d{2}-\d{2}\/[^/]+$/.test(row.rel),
      `rel 是完整形状而不是裸文件名：${row.rel}`);
    check(row.status === "ok", "状态 ok（文件真存在）");
    check(row.previewable === true && row.locatable === true, "可内联预览、可定位");
    check(!!row.statusLabel && !!row.statusHint, "状态中文说明齐全");
  }
  check(/^[0-9a-f]{16}$/.test(String(view.rootKey || "")), "rootKey 只存哈希，不含绝对路径");
  check(Array.isArray(view.statuses) && view.statuses.includes("rootChanged"), "四类失效态对外可见");

  if (row) {
    const item = await req("/api/artifacts/item?id=" + encodeURIComponent(row.id));
    check(item.ok === true, "按 artifactId 能查到详情");
    check(String(item.preview?.text || "").includes("一二三四五"), "点开卡片能读到真实文件内容");
    check(/^(recordings|screenshots|vidx|exports|archive|misc)\/\d{4}-\d{2}-\d{2}\//.test(String(item.rel || "")),
      "详情返回的是安全 rel，不是绝对路径");

    /* 把文件移走：状态必须从 ok 翻成 missing，且定位按钮该被禁掉。 */
    fs.unlinkSync(exportedPath);
    exportedPath = "";
    const view2 = await req("/api/artifacts/view?limit=200");
    const row2 = (view2.rows || []).find((r) => r.id === row.id);
    check(row2?.status === "missing", "文件被移走后卡片状态变「文件缺失」");
    check(row2?.locatable === false && row2?.previewable === false, "失效态不再提供预览/定位");
  }

  const bogus = await req("/api/artifacts/item?id=..%2F..%2Fsecret");
  check(bogus.ok === false, "伪造 artifactId 被拒（客户端传任意路径没有入口）");

  /* 面板 PDF 两跳走的旧入口：只给裸文件名，也必须被补成完整 rel。 */
  const reg = await post("/api/ops", {
    action: "artifacts.register",
    entry: { kind: "artifacts", rel: "manual.pdf", ext: "pdf", size: 10 },
  });
  const regOk = reg?.data?.ok === true;
  check(regOk, "旧调用方传裸文件名仍能登记成功");
  const view3 = await req("/api/artifacts/view?limit=200");
  const pdf = (view3.rows || []).find((r) => r.ext === "pdf");
  check(!!pdf && /^exports\/\d{4}-\d{2}-\d{2}\/manual\.pdf$/.test(pdf.rel),
    "裸文件名被补成 exports/<day>/manual.pdf（扁平布局）");
  check(pdf?.status === "missing", "没真落盘的文件如实显示缺失，不假装可用");
} catch (e) {
  fail("冒烟异常：" + String((e && e.stack) || e));
  if (stderr) console.log("  bridge stderr(尾部): " + stderr.slice(-800));
} finally {
  try { child.kill("SIGTERM"); } catch {}
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, `.children-${PORT}.json`), { force: true }); } catch {}
}

console.log(bad ? `ART_VIEW_SMOKE_FAIL (${bad})` : "ART_VIEW_SMOKE_OK");
process.exit(bad ? 1 : 0);
