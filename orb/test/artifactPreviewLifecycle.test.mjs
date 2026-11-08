/* 产物预览生命周期：两个用户报的 bug 的防漂移静态测试。
 *
 * bug ①「文件遗失或意外删除后，点击刷新应当把产物从文件预览栏删掉」
 *      —— 根因：/api/artifacts/view 会照常返回 status=missing 的行，
 *         artSync 一直把它留在 artCache 里，artPaint 每轮都重画出来。
 * bug ②「刚开启控制台就显示上一次的产物」
 *      —— 根因：artBootstrap() 认领完当前会话的 artIds 后调 artSync(true)，
 *         后者把登记表里所有「未认领」的历史条目当成新产物挂到首屏下面。
 *
 * 追加护栏（本轮补）：清理名单只能来自「本次会话 + 未截断窗口」，
 *      否则切会话或超过 200 条时，会把另一段历史里还好的产物引用永久删掉。
 *
 * panel.html 是单文件 + 内联脚本，不能在 node:test 里直接跑 DOM，
 * 所以用源码切片断言锁住关键判据，防止后续重构悄悄把护栏改回去。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = fs.readFileSync(path.join(ROOT, "desktop", "panel.html"), "utf8");

function slice(from, to, label) {
  const a = PANEL.indexOf(from);
  const b = PANEL.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `找不到源码片段：${label}`);
  return PANEL.slice(a, b);
}

/* 切片从注释块起算：说明文字里写明了「只清 missing，换根/过期/中断保留」这条边界。 */
const FORGET = slice("/* 文件遗失 / 被意外删除后", "/* 核心同步", "artForget");
const SYNC = slice("async function artSync(", "function artOnStatus(", "artSync");
const BOOT = slice("/* 启动 / 切会话后的重放", "const ARTLOG_CATS", "artBootstrap");
/* renderArtifactLog 定义在 artLogRenderSessions 之后，用「往后截一段」而不是找下一个函数名。 */
const LOG_START = PANEL.indexOf("async function renderArtifactLog()");
assert.ok(LOG_START >= 0, "找不到 renderArtifactLog");
const LOG = PANEL.slice(LOG_START, LOG_START + 900);

test("① 刷新按存在性校验：missing 与登记表已无此条都进清理名单", () => {
  assert.match(SYNC, /x\.status === 'missing'/, "只把 missing 列入清理名单");
  assert.match(SYNC, /const truncated = rows\.length >= ART_VIEW_LIMIT/);
  assert.match(SYNC, /if \(!truncated\) \{/, "窗口打满时不许做「登记表已无此条」的推断");
  assert.match(SYNC, /rowCid !== cid\) continue/, "只判定属于本次会话的缓存条目");
  assert.match(SYNC, /artForget\(gone\)/);
  assert.match(SYNC, /if \(row\.status !== 'missing'\) artCache\.set/, "missing 不许再写回缓存");
  assert.match(SYNC, /x\.status !== 'missing'/, "missing 不许被当成新产物挂上去");
});

test("① 切会话 / 超过 200 条时不得误删另一段历史的产物引用", () => {
  /* artCache 全文件只在声明处初始化，切会话不清空；若「不在 live 里就删」，
     切到另一个会话会把上一会话的 artIds 从历史记录里永久抹掉。 */
  const decl = PANEL.slice(0, PANEL.indexOf("let artBusy = false;"));
  assert.equal((decl.match(/let artCache = new Map\(\)/g) || []).length, 1);
  /* 全文件只有声明这一次赋值：没有别处 artCache = new Map() / artCache.clear()。 */
  assert.equal((PANEL.match(/artCache = new Map\(\);/g) || []).length, 1,
    "缓存不在切会话时重置，判据必须自带会话过滤");
  assert.ok(!/artCache\.clear\(\)/.test(PANEL), "不许靠清空缓存掩盖跨会话误删");
  assert.ok(!/for \(const id of artCache\.keys\(\)\) if \(!live\.has\(id\)\) gone\.push\(id\)/.test(SYNC),
    "无条件的「缓存有、本次没返回就删」会误删别的会话");
  assert.match(SYNC, /const cid = String\(r\.conversationId \|\| ''\)/);
  assert.match(SYNC, /const live = new Set\(rows\.map\(\(x\) => x\.id\)\)/);
  assert.match(SYNC, /artCache\)/, "要遍历缓存而不是只遍历行");
});

test("① artForget 把缓存、展开态、预览、认领集合一并清掉", () => {
  for (const s of [
    "artCache.delete(id)", "artPreview.delete(id)", "artOpen.delete(id)", "artAttached.delete(id)",
  ]) {
    assert.ok(FORGET.includes(s), `artForget 缺少 ${s}`);
  }
  assert.match(FORGET, /artPaint\(node, artRowsFor\(kept\)\)/, "当前 DOM 要原地重画");
});

test("① artForget 同步清理所有会话记录，防止切回历史或重启后又冒出来", () => {
  assert.match(FORGET, /msgs\.children/);
  assert.match(FORGET, /Array\.isArray\(convs\)/);
  assert.match(FORGET, /c\.messages/);
  assert.match(FORGET, /m\.artIds = kept/);
  assert.match(FORGET, /save\(\)/, "改了历史记录必须落盘");
});

test("① 只清 missing，换根 / 媒体过期 / 会话中断仍保留状态徽标", () => {
  assert.match(FORGET, /换根 \/ 媒体过期/);
  assert.ok(!/status === 'rootChanged'/.test(SYNC), "不得把换根当成文件丢失删掉");
  assert.ok(!/status === 'expired'/.test(SYNC), "不得把媒体过期当成文件丢失删掉");
});

test("① 设置页「刷新」按钮显式触发一次 artSync", () => {
  assert.match(LOG, /artLogRefresh/);
  assert.match(LOG, /artSync\(true\)/);
});

test("② 启动 / 切会话重放禁止把上一次会话的产物挂到当前会话", () => {
  assert.match(BOOT, /artAttached\.add\(id\)/, "先认领当前会话已有的 artIds");
  assert.match(BOOT, /artSync\(true, \{ attachFresh: false \}\)/);
  assert.match(BOOT, /上一次会话/, "要把会话边界写清楚");
});

test("② artSync 只有运行期才允许挂新产物，启动重放冻结所有登记表条目", () => {
  assert.match(SYNC, /attachFresh = !\(opts && opts\.attachFresh === false\)/);
  assert.match(SYNC, /if \(!attachFresh\) artAttached\.add\(row\.id\)/,
    "启动重放要把登记表里的历史 id 全部冻结，避免后续状态推送又误挂");
  assert.match(SYNC, /const fresh = attachFresh/);
  assert.match(SYNC, /artRepaintAll\(\)/, "状态徽标仍要跟着重画");
});

test("② 上一次的产物仍留在历史记录里可查，没有被物理删除", () => {
  assert.match(PANEL, /cur\.messages|convs/);
  assert.ok(!/artForget\(.*rootChanged/.test(PANEL));
  /* artForget 只动 artIds 数组，不动登记表；桥侧 /api/artifacts/view 仍返回原始条目 */
  assert.ok(!/\/api\/artifacts\/delete|\/api\/artifacts\/remove/.test(PANEL), "不许借刷新偷偷删登记表");
});
