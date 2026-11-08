#!/usr/bin/env node
/* 面板静态自检：语法 / 重复 id / 引用不存在的 id / 新增区块里的硬编码色值。
 *
 * 为什么要有这个脚本：panel.html 是一个两万行、内联全部 JS+CSS 的单文件，
 * 没有构建期检查。一个三元表达式拆行时多打的 +、一个重复的 id，
 * 在浏览器里表现为「整块功能突然不响应」或「控件绑到了另一个元素上」，
 * 而且不会报错 —— 只能靠这类静态扫描提前拦住。
 *
 * 用法：node tools/check-panel.mjs [panel.html 路径]
 * 退出码 0 = 通过；1 = 有问题（每条都会打印行号）。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const file = process.argv[2] || path.join(import.meta.dirname, "..", "desktop", "panel.html");
const src = fs.readFileSync(file, "utf8");
/* 2026-11-08：4028 行 <style> 已物理切到同目录 panel.css（CSS 抽壳第一步）。
   下面第 4/5 项查的是 CSS 区块，得把外链样式拼回来一起看；DOM/id 检查仍只看
   panel.html —— CSS 里没有 id 字面量，拼进去只会让引用检查多扫一遍无用文本。 */
const cssFile = path.join(path.dirname(file), "panel.css");
const extraCssFile = path.join(path.dirname(file), "automation.css");
const cssSrc = [
  fs.existsSync(cssFile) ? fs.readFileSync(cssFile, "utf8") : "",
  fs.existsSync(extraCssFile) ? fs.readFileSync(extraCssFile, "utf8") : "",
].join("\n");
const styleSrc = src + "\n" + cssSrc;

let bad = 0;
const fail = (msg) => { bad++; console.log("  ✗ " + msg); };
const ok = (msg) => console.log("  ✓ " + msg);

/* ---------- 1. 内联脚本语法 ---------- */
const opens = [];
const re = /<script\b([^>]*)>/gi;
let m;
while ((m = re.exec(src))) {
  const attrs = m[1] || "";
  if (/\bsrc\s*=/.test(attrs)) continue;          // 外链脚本不在这里校验
  opens.push({ start: re.lastIndex, len: m[0].length });
}
if (!opens.length) fail("没找到内联 <script>");
/* 主干的结束位置是「起点之后的第一个 </script>」。
   不能用 lastIndexOf —— 文件末尾还有个外链 <script src="voice.js">，
   取最后那个会把 `</script><script src=…>` 一起切进脚本体里，报出假的 '<' 语法错误。 */
const closeAt = src.indexOf("</script>", opens[0].start);
const body = src.slice(opens[0].start, closeAt);
const lineOf = (idx) => src.slice(0, idx).split("\n").length;
try {
  new vm.Script(body);                             // 只编译不执行：面板脚本有副作用，不能真跑
  ok(`内联脚本语法通过（${opens.length} 段，主干 ${body.length} 字符，起始第 ${lineOf(opens[0].start)} 行）`);
} catch (e) {
  fail(`内联脚本语法错误：${e.message}（脚本起始第 ${lineOf(opens[0].start)} 行）`);
}

/* ---------- 2. 重复 id ---------- */
const ids = new Map();
const idRe = /\bid\s*=\s*"([^"]+)"/g;
while ((m = idRe.exec(src))) {
  const id = m[1];
  const ln = lineOf(m.index);
  if (!ids.has(id)) ids.set(id, []);
  ids.get(id).push(ln);
}
const dups = [...ids.entries()].filter(([, v]) => v.length > 1);
if (dups.length) {
  for (const [id, lns] of dups) fail(`重复 id: ${id}（第 ${lns.join(", ")} 行）`);
} else ok(`id 唯一（共 ${ids.size} 个）`);

/* ---------- 3. getElementById 引用的 id 是否真的存在 ---------- */
/* 只查字面量，动态拼的（'x' + n）天然跳过 —— 误报比漏报更让人不敢用这脚本。 */
/* 面板里有一部分元素是运行时造出来的（例如录屏工具条把按钮 id 改成 toolCap），
   这类 id 在静态 HTML 里根本没有。不把它们算进来，脚本就会报一条吓人的假警报 ——
   假警报多了，这脚本就没人看了。 */
const dynIdRe = /\.id\s*=\s*['"]([^'"]+)['"]/g;
while ((m = dynIdRe.exec(body))) ids.set(m[1], ids.get(m[1]) || [0]);

const refs = new Set();
const refRe = /getElementById\(\s*['"]([^'"]+)['"]\s*\)/g;
while ((m = refRe.exec(body))) refs.add(m[1]);
const missing = [...refs].filter((id) => !ids.has(id));
if (missing.length) {
  for (const id of missing) fail(`getElementById 引用了不存在的 id：${id}`);
} else ok(`getElementById 引用全部命中（${refs.size} 个）`);

/* ---------- 3b. 外置 automation.js 的 $('id') 引用 ---------- */
/* 抽壳后新逻辑搬到外部 classic script，第 3 项只扫内联脚本会漏掉它们。
   这类错误在浏览器里是「按钮没反应、还不报错」，必须构建期拦住。 */
{
  const jsFile = path.join(path.dirname(file), "automation.js");
  if (fs.existsSync(jsFile)) {
    const js = fs.readFileSync(jsFile, "utf8");
    const autoRefs = new Set();
    for (const m of js.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) autoRefs.add(m[1]);
    const miss = [...autoRefs].filter((id) => !ids.has(id));
    if (miss.length) fail(`automation.js 引用了不存在的 id：${miss.join(", ")}`);
    else ok(`automation.js 的 $('id') 引用全部命中（${autoRefs.size} 个）`);
  }
}

/* ---------- 4. 自动化区块里的硬编码色值 ---------- */
/* 按**选择器**取要检查的范围（.wf-* / .setsec-ico），不按注释锚点 ——
   注释随改动漂移，选择器不会；以前用注释切片，区块一搬走检查就变成"找不到区块"。 */
const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
const scopedRules = [...styleSrc.matchAll(/(?:^|\n)\s*([^{}\n]*?\.(?:wf-|setsec-ico)[^{}\n]*?)\{([^}]*)\}/g)];
const scopedCss = scopedRules.map((m) => m[2]).join("\n");
const colorHits = scopedCss.match(hexRe) || [];
if (!scopedRules.length) {
  fail("没能从 panel.css 里取到 .wf-* / .setsec-ico 规则（选择器改名了？）");
} else if (colorHits.length) {
  fail(`自动化区块出现硬编码色值：${[...new Set(colorHits)].join(", ")}`);
} else {
  ok(`自动化区块 ${scopedRules.length} 条规则没有硬编码色值（全部走设计令牌）`);
}

/* ---------- 5. 动效降级：动画与图标微动必须同时进 no-motion 与 prefers-reduced-motion ---------- */
/* 这里只查"本区块新增的那几类"（.wf-op / .setsec-ico 的 :hover 变换），
   因为全局逐条比对历史动画噪声太大，查出来的问题也没人认领。 */
const motionScoped = scopedRules.length;
const hasNoMotion = /html\.no-motion \.wf-op[^{]*\{[^}]*transform: none/.test(styleSrc)
  && /html\.no-motion \.setsec-ico[^{]*\{[^}]*transform: none/.test(styleSrc);
const hasReduced = /prefers-reduced-motion[\s\S]{0,900}?\.wf-op[^{]*\{[^}]*transform: none/.test(styleSrc)
  && /prefers-reduced-motion[\s\S]{0,400}?\.setsec-ico[^{]*\{[^}]*transform: none/.test(styleSrc);
if (motionScoped && (!hasNoMotion || !hasReduced)) {
  fail("自动化区块的图标微动缺少降级兜底（no-motion / prefers-reduced-motion）");
} else if (motionScoped) {
  ok("自动化区块的图标微动有双降级兜底");
}

/* ---------- 6. 导出格式清单（已退休） ----------
 * 面板不再有「导出与交付」栏目：交付形式由 agent 按内容自己选（默认 .md），
 * 不需要一份手写格式清单跟后端 FORMATS 对齐。后端 /api/export 仍然存在，
 * 它的 FORMATS 由 orb/test/outputProfile.test.mjs 覆盖，不靠这里的文本比对。
 */
console.log(bad ? `\nPANEL_FAIL (${bad})` : "\nPANEL_OK");
process.exit(bad ? 1 : 0);
