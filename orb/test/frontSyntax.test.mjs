/* 报告B §7 批次A 前半：V-03 标签语法 / V-05 openedUrl / V-04、V-07 现状核查。
 * 沿用 structuredCompile.test.mjs 的惯例：按 FRONT_START / FRONT_END 把前台解析段
 * 原样抽出，丢进 new Function 独立跑；抽空或标记被改就明确断言失败。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = fs.readFileSync(path.join(ROOT, "desktop", "panel.html"), "utf8");
const MAIN = fs.readFileSync(path.join(ROOT, "desktop", "main.js"), "utf8");

const START = "/* ==== FRONT_START ==== */";
const END = "/* ==== FRONT_END ==== */";
const from = PANEL.indexOf(START);
const to = PANEL.indexOf(END, from);
assert.ok(from >= 0, "找不到 FRONT_START 标记");
assert.ok(to > from, "找不到 FRONT_END 标记");
const block = PANEL.slice(from, to + END.length);
assert.ok(block.includes("function parseFront"), "抽取段为空或不含 parseFront");
assert.ok(/if\s*\(\s*typeof window\s*!==\s*['"]undefined['"]\s*\)/.test(block),
  "window.__orbLastOpenedUrl 暴露必须做 typeof 保护");

function makeEnv() {
  return new Function(block + "; return { parseFront, normalizeOpenUrl, setLastOpenedUrl, getLastOpenedUrl, FRONTISH };")();
}

test("V-05：normalizeOpenUrl 只放行 http(s)，危险协议一律拒", () => {
  const { normalizeOpenUrl: n } = makeEnv();
  assert.equal(n(""), "");
  assert.equal(n("example.com"), "https://example.com/");
  assert.equal(n("example.com/a?q=1#f"), "https://example.com/a?q=1#f");
  assert.equal(n("https://example.com/a?q=1#f"), "https://example.com/a?q=1#f");
  assert.equal(n("localhost:3000/x"), "https://localhost:3000/x", "裸端口不被误判成协议");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///C:/x",
                     "vbscript:msgbox", "chrome://settings", "about:blank",
                     "ftp://example.com/x", "blob:https://x/y"]) {
    assert.equal(n(bad), "", bad + " 必须被拒");
  }
});

test("V-03：按标签定位的七类句型都带 label、都不带坐标", () => {
  const { parseFront: p } = makeEnv();
  const cases = [
    ["点击标签 保存", "Click", "保存"],
    ["单击控件「确定按钮」", "Click", "确定按钮"],
    ["双击标签 列表项", "Click", "列表项"],
    ["右键标签 文件", "Click", "文件"],
    ["输入标签 搜索框 固态硬盘", "Type", "搜索框"],
    ["滚动标签 列表 上", "Scroll", "列表"],
    ["等待控件 确定 10", "WaitFor", "确定"],
  ];
  for (const [s, tool, label] of cases) {
    const r = p(s);
    assert.ok(r, s + " 没解析出来");
    assert.equal(r.tool, tool, s);
    assert.equal(r.byLabel, true, s);
    assert.ok(!r.pos, s + " 不该带坐标");
    assert.equal(r.args.label || r.args.text, label, s);
  }
  const tree = p("读控件树");
  assert.equal(tree.tool, "Snapshot");
  assert.equal(tree.args.use_ui_tree, true);
  assert.equal(tree.args.use_annotation, false, "不读像素标注");
});

test("V-03：标签优先于坐标，坐标句型仍保持原样（无回归）", () => {
  const { parseFront: p } = makeEnv();
  const byLabel = p("点击标签 保存");
  assert.equal(byLabel.args.label, "保存");
  assert.equal(byLabel.args.loc, null);
  const byPixel = p("点击 120, 340");
  assert.equal(byPixel.tool, "Click");
  assert.deepEqual(byPixel.pos, [120, 340]);
  assert.ok(!("label" in byPixel.args), "坐标句型不该被塞 label");
  assert.equal(p("双击 10,20").args.clicks, 2);
  assert.equal(p("右键 10,20").args.button, "right");
  assert.equal(p("按 ctrl+c").tool, "Shortcut");
});

test("V-05：抓网页复用上一轮 openedUrl；没打开过就明确 NO_URL，不猜", () => {
  const env = makeEnv();
  assert.equal(env.getLastOpenedUrl(), "");
  assert.equal(env.parseFront("抓网页").tool, "NO_URL");
  assert.match(env.parseFront("抓网页").note, /不猜网址/);

  env.setLastOpenedUrl("https://example.com/a?q=1");
  const r = env.parseFront("抓网页");
  assert.equal(r.tool, "Scrape");
  assert.equal(r.args.url, "https://example.com/a?q=1");
  assert.equal(r.args.use_dom, true);
  assert.equal(r.openedUrl, "https://example.com/a?q=1");
  assert.equal(r.byLabel, true);

  const explicit = env.parseFront("抓网页 news.example.com/top");
  assert.equal(explicit.args.url, "https://news.example.com/top", "显式给出的地址优先");
  assert.equal(env.parseFront("读网页 javascript:alert(1)").tool, "NO_URL");
});

test("V-05：OPEN_URL / OPEN_DIR 仍由 parseFront 正确产出", () => {
  const { parseFront: p } = makeEnv();
  assert.equal(p("打开网页 example.com").tool, "OPEN_URL");
  assert.equal(p("打开网页 example.com").value, "example.com");
  assert.equal(p("打开文件夹 D:/tmp").tool, "OPEN_DIR");
});

test("V-05 接线契约：execute 回传 openedUrl，quickWebOpen 统一记账", () => {
  assert.match(PANEL, /const openedUrl = normalizeOpenUrl\(act\.value\)/);
  assert.match(PANEL, /return \{ ok: true, openedUrl: openedUrl, tool: 'OPEN_URL' \}/);
  assert.match(PANEL, /return \{ ok: false, openedUrl: '', reasonCode: 'bad-protocol' \}/);
  assert.match(PANEL, /return \{ ok: false, openedUrl: '', reasonCode: 'no-opened-url' \}/);
  assert.match(PANEL, /setLastOpenedUrl\(openedUrl\)/);
  assert.match(PANEL, /setLastOpenedUrl\(normalizeOpenUrl\(raw\) \|\| raw\)/);
  assert.match(PANEL, /window\.__orbLastOpenedUrl = getLastOpenedUrl/);
});

test("V-03 接线契约：execute 命中 label 时删掉坐标字段", () => {
  assert.match(PANEL, /if \(args\.label\) delete args\.loc/);
  assert.match(PANEL, /按标签定位（不读像素）/);
  assert.match(PANEL, /tool: 'NO_URL'/);
});

test("V-07 已实现核查：站点打开真的调 vaultSiteTouch，时间显示是人话不是数字", () => {
  assert.match(PANEL, /await window\.orb\.vaultSiteTouch\(s\.id\)/);
  assert.match(PANEL, /async function siteOpen\(s\)/);
  assert.match(PANEL, /await loadSites\(\)/);
  assert.match(PANEL, /function siteAgo\(ts\)/);
  assert.match(PANEL, /分钟前|小时前|天前/);
  /* 报告 §5.2：别把 lastUsedAt 显示成裸数字 */
  assert.ok(!/siteAgo[\s\S]{0,400}textContent\s*=\s*Number\(/.test(PANEL));
});

test("V-04 已实现核查：划词搜索统一经 searchUrl.mjs，不再硬编码", () => {
  assert.match(MAIN, /import\("\.\.\/searchUrl\.mjs"\)/);
  assert.match(MAIN, /cachedSearchUrl = m\.searchUrl/);
  assert.match(MAIN, /统一经 searchUrl\.mjs 生成/);
});

test("V-11 闭环：Scrape 的返回由桥侧统一挂 untrusted 闸门", () => {
  const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");
  assert.match(BRIDGE, /\(key === "windows" && tool === "Scrape"\)/);
  assert.match(BRIDGE, /untrusted: textGate\.guard\(toolTextOf\(r\), "webpage"\)/);
});
