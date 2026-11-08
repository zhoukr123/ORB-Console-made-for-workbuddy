/* 「搜一下 X 然后记到文档 / 复制到剪贴板」接进对话主流程（Task #114）的防漂移测试。
 *
 * 判据：
 *   ① 粗筛命中时**先**问桥的动作表（/api/search/plan），再按 sink 分流，成功就不派后台；
 *   ② 只要检索不可用（未启用 / 无凭据 / 空结果 / 动作表不认 / 表外落点）就必须回落 Agent，
 *      不许把任务吞掉，也不许先显示成功文案；
 *   ③ doc 落点要把产物卡片挂到这一轮回答下面（走 artSync 同一条路）；
 *   ④ clipboard 落点只写剪贴板，写不进去时贴到对话里，绝不为了重试再烧一次检索额度。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = fs.readFileSync(path.join(ROOT, "desktop", "panel.html"), "utf8");
const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");

function fnBody(name, endMark) {
  const from = PANEL.indexOf("async function " + name + "(");
  const to = PANEL.indexOf(endMark, from + 1);
  assert.ok(from >= 0 && to > from, "找不到 " + name);
  return PANEL.slice(from, to);
}

const DISPATCH = fnBody("trySearchProduce", "\n}");
const DOC = fnBody("runSearchToDoc", "\n}");
const CLIP = fnBody("runSearchToClipboard", "\n}");

test("① 粗筛命中时先走确定性链路，成功就 return（不再派后台 Agent）", () => {
  const m = PANEL.match(/if \(lookingLikeSearchProduce\(text\) && await trySearchProduce\(text\)\) return;/);
  assert.ok(m, "检索分支必须先调 trySearchProduce 并在成功时直接 return");
  /* 顺序：接线必须在 runBack 之前，否则等于没接。 */
  const iWire = PANEL.indexOf("await trySearchProduce(text)");
  const iRunBack = PANEL.indexOf("await runBack(sc.plan.taskText", iWire);
  assert.ok(iWire > 0 && iRunBack > iWire, "trySearchProduce 必须排在 runBack 之前");
});

test("① 分流只问桥的动作表，不在面板重算 query 或落点", () => {
  assert.match(DISPATCH, /post\('\/api\/search\/plan', \{ text \}\)/);
  assert.match(DISPATCH, /plan\.sink/);
  assert.ok(!/compileStructured/.test(DISPATCH), "分流不许依赖面板自己的编译器");
  assert.ok(!/query\s*:/.test(DISPATCH), "不要在面板里重算 query：句型真相只留桥那一份");
  assert.match(BRIDGE, /url\.pathname === "\/api\/search\/plan"/);
});

test("① doc 落点走 to-doc，clipboard 落点走 to-clipboard，表外落点返回 false", () => {
  assert.match(DISPATCH, /sink === 'doc'[\s\S]{0,80}runSearchToDoc/);
  assert.match(DISPATCH, /sink === 'clipboard'[\s\S]{0,80}runSearchToClipboard/);
  assert.match(DISPATCH, /return false;/, "表外落点必须回落，不在面板里现编执行路径");
  assert.match(DOC, /post\('\/api\/search\/to-doc', \{ text \}\)/);
  assert.match(CLIP, /post\('\/api\/search\/to-clipboard', \{ text \}\)/);
  assert.match(BRIDGE, /url\.pathname === "\/api\/search\/to-doc" && req\.method === "POST"/);
  assert.match(BRIDGE, /url\.pathname === "\/api\/search\/to-clipboard" && req\.method === "POST"/);
});

test("② 检索不可用时返回 false，调用方继续走原 Agent 路径（不吞任务）", () => {
  assert.match(DISPATCH, /if \(!plan \|\| plan\.ok !== true\) return false;/);
  assert.match(DOC, /if \(!r \|\| r\.ok !== true\) return false;/);
  assert.match(CLIP, /if \(!r \|\| r\.ok !== true \|\| typeof r\.text !== 'string' \|\| !r\.text\) return false;/);
  /* addMsg 必须在 ok 判定之后：降级时不许先冒一句「已整理成文档」。 */
  for (const [name, body] of [["doc", DOC], ["clipboard", CLIP]]) {
    const iGuard = body.indexOf("return false;");
    const iMsg = body.indexOf("addMsg(");
    assert.ok(iGuard > 0 && iMsg > iGuard, name + " 的成功文案必须排在 ok 判定之后");
  }
  assert.match(DISPATCH, /catch \{ return false; \}/);
  assert.match(DOC, /catch \{ return false; \}/);
  assert.match(CLIP, /catch \{ return false; \}/);
});

test("③ doc 成功后把产物挂到这一轮回答下面，并如实标注零视觉", () => {
  assert.match(DOC, /artTarget = node/);
  assert.match(DOC, /await artSync\(true\)/);
  assert.match(DOC, /视觉调用 0 次/);
  assert.match(DOC, /realResults === false/, "fixture 与真实检索必须区分显示");
});

test("④ clipboard 写失败不重做检索：贴到对话里，且不落产物", () => {
  assert.match(CLIP, /writeClipboard\(r\.text\)/);
  /* 写失败分支里不许出现二次请求：结果已经拿到了，再跑一遍等于白烧一次额度。 */
  const tail = CLIP.slice(CLIP.indexOf("if (pasted)"));
  assert.ok(!/await post\(/.test(tail), "写剪贴板失败后不许再发一次检索请求");
  assert.ok(!/artSync|artTarget/.test(CLIP), "剪贴板落点不产生产物卡片");
  assert.match(CLIP, /剪贴板没写成功/);
});

test("④ 其它结构化句型（对比 / 整理）仍走 Agent，行为不变", () => {
  /* 检索类已改由粗筛 + 动作表处理，不再依赖 compileStructured 的 search-and-compose 分支；
     剩下的 compare / compose 必须原样走 runBack —— 泛化不许把既有路径改坏。 */
  const seg = PANEL.slice(PANEL.indexOf("if (sc && sc.ok) {"), PANEL.indexOf("} else if (sc) {"));
  assert.match(seg, /await runBack\(sc\.plan\.taskText/, "非检索分支必须保留 runBack");
});
