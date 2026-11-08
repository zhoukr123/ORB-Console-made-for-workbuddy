#!/usr/bin/env node
/* 接线与死代码审计：把「谁在调、谁在接」两侧对起来扫一遍。
 *
 * 为什么必须自动扫：这个项目的每一条链都跨 3~4 层
 *   面板 HTML/JS → preload 白名单 → 主进程 safeHandle → 引擎模块
 *   面板 → 桥 HTTP 路由 → /api/ops action switch
 * 任何一层少一行都不会报错，只会「点了没反应」「列表一直转」「开关不生效」。
 * 2026-11-09 之前就真实踩过两次：pluginSettings.js 没进包（发布版插件页空白）、
 * 记忆页删除按钮调用了一直在、但 flush 从没在退出时执行（删了重启复活）。
 *
 * 五组检查：
 *   A. preload → 主进程：invoke/send 的通道必须有人 handle/on
 *   B. 主进程 → preload：webContents.send 的通道必须有人在 preload 里 on
 *   C. 面板 → preload：window.orb.X 必须在 exposeInMainWorld 里声明
 *   D. 面板 → 桥：用到的 /api/* 路径必须在 bridge.mjs 里有对应路由
 *   E. 面板 → /api/ops：用到的 action 必须在桥的 switch 里有 case
 * 另附「反向」清单（实现了但没人调用），只提示、不判失败 —— 有些是给外部/未来的入口。
 *
 * 用法：node orb/tools/wiring-audit.mjs [--strict]
 *   默认：A~E 有断线 → 退出码 1；反向清单只是打印。
 *   --strict：反向清单非空也判失败（清死代码时用）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const DESKTOP = path.join(ROOT, "orb", "desktop");
const STRICT = process.argv.includes("--strict");

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
/* 只剥「整行注释」和块注释，不碰行内 //。
 * 之前用 `[^:]\/\/` 判断行内注释，结果把 `url.pathname === "/api/status"` 这类
 * 代码里带 `//` 的字符串也当成注释切掉，直接造成假断线。剥注释的目的是避免
 * 注释里的示例路径被当成真实调用，整行注释已经覆盖 99% 的情况。 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*/gm, "");

const mainSrc = read(path.join(DESKTOP, "main.js"));
const bridgeSrc = read(path.join(ROOT, "orb", "bridge.mjs"));

/* 桌面侧所有会调用 / window.orb 的文件 */
const desktopFiles = fs
  .readdirSync(DESKTOP)
  .filter((f) => /\.(html|js|cjs)$/i.test(f))
  .map((f) => ({ name: f, src: read(path.join(DESKTOP, f)) }));

const preloadFiles = fs
  .readdirSync(DESKTOP)
  .filter((f) => /preload\.js$/i.test(f))
  .map((f) => ({ name: f, src: read(path.join(DESKTOP, f)) }));

const collect = (src, re, group = 1) => {
  const out = new Set();
  let m;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = g.exec(src))) out.add(m[group]);
  return out;
};

const RESULT = [];
function section(title) {
  console.log("\n== " + title + " ==");
}
function report(ok, name, detail) {
  RESULT.push({ ok, name, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
}
function note(name, detail) {
  RESULT.push({ ok: true, name, detail, warn: true });
  console.log(`WARN ${name}${detail ? "  — " + detail : ""}`);
}

/* ------------------------------------------------------------------ *
 * A. preload → 主进程
 * ------------------------------------------------------------------ */
section("A. preload → 主进程（invoke / send 必须有 handler）");
const fromPreload = new Map(); // channel -> 来源文件
for (const p of preloadFiles) {
  const s = stripComments(p.src);
  for (const ch of collect(s, /ipcRenderer\.(?:invoke|send|sendSync)\(\s*["']([\w.:\-/]+)["']/)) {
    fromPreload.set(ch, p.name);
  }
}
const handled = new Set([
  ...collect(stripComments(mainSrc), /(?:safeHandle|ipcMain\.handle|ipcMain\.on|ipcMain\.once)\(\s*["']([\w.:\-/]+)["']/),
]);
/* 有些地方用数组批量注册：['a','b'].forEach(ch => ipcMain.on(ch, ...)) */
for (const m of stripComments(mainSrc).matchAll(/(?:safeHandle|ipcMain\.(?:handle|on|once))\(\s*ch\b/g)) {
  void m; // 动态注册：整段视为"可能覆盖"，靠下面的批量名清单兜
}
const batchNames = collect(stripComments(mainSrc), /["']([\w\-]+)["']/g);
const missingA = [...fromPreload.keys()].filter((ch) => !handled.has(ch) && !batchNames.has(ch));
report(missingA.length === 0, "preload 调用的每个通道都有 handler",
  missingA.length ? "缺：" + missingA.join(", ") : `${fromPreload.size} 个通道全部有接`);
console.log(`     preload 声明 ${fromPreload.size} 个，main 显式 handler ${handled.size} 个`);

/* ------------------------------------------------------------------ *
 * B. 主进程 → preload
 * ------------------------------------------------------------------ */
section("B. 主进程 → preload（webContents.send 必须有人在 preload 里 on）");
const toPreload = collect(stripComments(mainSrc),
  /(?:webContents|contents|win|ball|panel)\.send\(\s*["']([\w.:\-/]+)["']/);
const preloadOn = new Set();
for (const p of preloadFiles) {
  const s = stripComments(p.src);
  for (const ch of collect(s, /ipcRenderer\.on\(\s*["']([\w.:\-/]+)["']/)) preloadOn.add(ch);
  /* preload 里普遍用本地别名 `const on = (channel, cb) => ipcRenderer.on(...)` 转发
     （例如 onDockState: (cb) => on("dock-state", cb)）。只扫 ipcRenderer.on 会把
     这些全部误判成"没人监听"，所以把 on(...) / once(...) 的调用也算进来。 */
  for (const ch of collect(s, /(?:^|[^.\w])on(?:ce)?\(\s*["']([\w.:\-/]+)["']\s*,/)) preloadOn.add(ch);
}
const missingB = [...toPreload].filter((ch) => !preloadOn.has(ch));
report(missingB.length === 0, "主进程推送的每个通道都有人在 preload 里监听",
  missingB.length ? "缺：" + missingB.join(", ") : `${toPreload.size} 个推送通道都有监听`);
if (toPreload.size === 0) note("主进程没有 webContents.send 推送", "全是请求-应答，无单向推送");

/* ------------------------------------------------------------------ *
 * C. 面板 → preload（window.orb.X）
 * ------------------------------------------------------------------ */
section("C. 面板 → preload（window.orb.X 必须已暴露）");
const orbUsed = new Set();
for (const f of desktopFiles.filter((x) => /\.(html|js)$/i.test(x.name) && !/preload\.js$/i.test(x.name))) {
  /* 兼容可选链：面板大量使用 `window.orb?.historyLoad?.()` 这种写法，
     只认 `window.orb.X` 会把它们全部误判成"未使用"。 */
  const body = stripComments(f.src);
  for (const k of collect(body, /window\.orb\??\.([A-Za-z_][A-Za-z0-9_]*)/)) orbUsed.add(k);
  /* 面板里普遍先 `const orb = window.orb` 再写 `orb.xxx()`（recbar / capNative 都是），
     只扫 window.orb 会把这些真实调用误报成未使用。只在文件确实引用过 window.orb
     时才把裸 orb.X 计入，避免撞上同名局部对象。 */
  if (body.includes("window.orb")) {
    /* 只认「调用形态」orb.xxx(...)：裸 orb.xxx 的属性读会撞上别的同名对象
       （panel 里还有 cfg.orb.font 这类写法），全收会刷出一片假断线。 */
    for (const k of collect(body, /(?:^|[^.\w])orb\??\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/)) orbUsed.add(k);
  }
}
const orbExposed = new Set();
for (const p of preloadFiles) {
  const s = stripComments(p.src);
  const at = s.indexOf("exposeInMainWorld");
  if (at < 0) continue;
  /* 从这个位置往后扫到文件尾，取形如 `  name:` 的成员名 */
  for (const k of collect(s.slice(at), /^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)) orbExposed.add(k);
}
const missingC = [...orbUsed].filter((k) => !orbExposed.has(k));
report(missingC.length === 0, "面板用到的每个 window.orb.* 都已暴露",
  missingC.length ? "缺：" + missingC.join(", ") : `${orbUsed.size} 个成员全部已暴露`);
const unusedExposed = [...orbExposed].filter((k) => !orbUsed.has(k) && k !== "orb");
if (unusedExposed.length) note("暴露了但桌面侧没调用（可能是给扩展页/未来的入口）", unusedExposed.join(", "));

/* ------------------------------------------------------------------ *
 * D. 面板 → 桥路由
 * ------------------------------------------------------------------ */
section("D. 面板 → 桥（用到的 /api/* 必须在 bridge.mjs 里有路由）");
const apiUsed = new Set();
for (const f of desktopFiles.filter((x) => /\.(html|js)$/i.test(x.name))){
  for (const p of collect(stripComments(f.src), /["'`](\/api\/[\w\-/]+)/)) apiUsed.add(p.replace(/\/$/, ""));
}
const apiRoutes = new Set();
const apiPrefixes = new Set();
{
  /* 用原始源码而不是剥注释版：bridge.mjs 里有 glob 字符串（星号斜杠星号那种），
     会被块注释正则误判成注释开头，一路吞掉后面的路由判断（实测吃掉 /api/status，
     造成假断线）。注释里几乎不会出现 url.pathname 的比较语句，所以不剥更安全。 */
  const s = bridgeSrc;
  for (const p of collect(s, /url\.pathname\s*===\s*["'](\/api\/[\w\-/]+)["']/)) apiRoutes.add(p);
  /* 前缀路由（/api/job/:id 这类）：剥掉末尾斜杠存前缀，匹配时用 startsWith。
     之前拼成 p + "/*" 再 slice，得到的 "/api/job//" 永远匹配不上，属于自造假断线。 */
  for (const p of collect(s, /url\.pathname\.startsWith\(\s*["'](\/api\/[\w\-/]*)["']/)) {
    apiPrefixes.add(p.replace(/\/+$/, "") + "/");
  }
}
const routeMatches = (p) => apiRoutes.has(p) || [...apiPrefixes].some((pre) => p.startsWith(pre));
const missingD = [...apiUsed].filter((p) => !routeMatches(p));
report(missingD.length === 0, "桌面侧调用的每个 /api/* 都有桥路由",
  missingD.length ? "缺：" + missingD.join(", ") : `${apiUsed.size} 条路径全部命中`);
const unusedRoutes = [...apiRoutes].filter((r) => !apiUsed.has(r));
if (unusedRoutes.length) note("桥有路由但桌面侧没调用（外部/CLI 入口或死路由）", `${unusedRoutes.length} 条：` + unusedRoutes.slice(0, 12).join(", "));
if (apiPrefixes.size) console.log(`     另有 ${apiPrefixes.size} 个前缀路由：` + [...apiPrefixes].join(", "));

/* ------------------------------------------------------------------ *
 * E. /api/ops action
 * ------------------------------------------------------------------ */
section("E. 面板 → /api/ops（action 必须在桥 switch 里有 case）");
const opsUsed = new Set();
for (const f of desktopFiles) {
  for (const a of collect(stripComments(f.src), /action\s*:\s*["']([a-z][\w]*\.[\w.]+)["']/)) opsUsed.add(a);
}
const opsCases = new Set(collect(bridgeSrc, /case\s+["']([a-z][\w]*\.[\w.]+)["']\s*:/));
const missingE = [...opsUsed].filter((a) => !opsCases.has(a));
report(missingE.length === 0, "面板用到的每个 ops action 都有 case",
  missingE.length ? "缺：" + missingE.join(", ") : `${opsUsed.size} 个 action 全部命中`);
console.log(`     桥侧共 ${opsCases.size} 个 action case，面板用到 ${opsUsed.size} 个`);

/* ------------------------------------------------------------------ *
 * F. 模块级死代码（只有 exports 没人 import）
 * ------------------------------------------------------------------ */
section("F. 模块级死代码（orb/*.mjs 从未被 import）");
const orbDir = path.join(ROOT, "orb");
const allMjs = fs.readdirSync(orbDir).filter((f) => f.endsWith(".mjs"));
const importers = new Map(allMjs.map((f) => [f, new Set()]));
const scanDirs = [orbDir, path.join(orbDir, "tools"), path.join(orbDir, "desktop"), path.join(ROOT, "docs", "_probes")];
for (const dir of scanDirs) {
  if (!fs.existsSync(dir)) continue;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walk(p); continue; }
      if (!/\.(mjs|cjs|js)$/.test(e.name)) continue;
      const s = read(p);
      /* from "x" / import("x") / require("x") 三种写法都要收。
         双分组正则里 group1 在 require 形式下是 undefined，直接拿 basename 会崩。 */
      const specs = new Set();
      for (const m of s.matchAll(/from\s+["']([^"']+)["']/g)) specs.add(m[1]);
      for (const m of s.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]);
      for (const m of s.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]);
      for (const spec of specs) {
        if (!spec || typeof spec !== "string") continue;
        if (!/^\.{1,2}\//.test(spec)) continue;   // 只算本地相对引用
        const base = path.basename(spec).replace(/\.m?js$/, ".mjs");
        if (importers.has(base) && path.basename(p) !== base) importers.get(base).add(path.relative(ROOT, p));
      }
    }
  };
  walk(dir);
}
/* bridge.mjs / selftest.mjs 是入口；registry.md 登记过的模块是命令行/子进程入口，
   它们是"被外部按文件名拉起"的，静态 import 图里当然看不到，不算死代码。 */
const registryDoc = read(path.join(ROOT, "orb", "docs", "registry.md"));
const ENTRY = new Set(["bridge.mjs", "selftest.mjs"]);
const noImporter = allMjs.filter((f) => !ENTRY.has(f) && importers.get(f).size === 0);
const documented = noImporter.filter((f) => registryDoc.includes(f.replace(/\.mjs$/, "")));
const dead = noImporter.filter((f) => !documented.includes(f));
if (documented.length) console.log(`     命令行/子进程入口（registry.md 已登记，不算死代码）：${documented.join(", ")}`);
if (dead.length) note("没有任何文件 import、也没在 registry.md 登记的模块", dead.join(", "));
else report(true, "所有 orb/*.mjs 都有引用方或已登记为入口", `${allMjs.length} 个模块`);

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
const hard = RESULT.filter((r) => !r.ok && !r.warn);
const warn = RESULT.filter((r) => r.warn);
console.log("");
if (hard.length) {
  console.log(`WIRING_AUDIT_FAIL (${hard.length} 处断线)`);
  for (const h of hard) console.log("  - " + h.name + " :: " + h.detail);
  process.exit(1);
}
if (STRICT && warn.length) {
  console.log(`WIRING_AUDIT_FAIL --strict（${warn.length} 处待清理）`);
  for (const w of warn) console.log("  - " + w.name + " :: " + w.detail);
  process.exit(1);
}
console.log(`WIRING_AUDIT_OK (${RESULT.length - warn.length} 项通过${warn.length ? `，${warn.length} 项仅提示` : ""})`);
