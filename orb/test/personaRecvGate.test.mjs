/* 陪伴层「接收台词」时序回归（2026-11-08 用户反馈）。
 *
 * 事故：确定性网页指令秒级完成，而「交给我，勉强算你找对人了」是**任务开始**时
 * 说的接收台词（毒舌档还会成对补一句甜系服软）。结果气泡都出来了，语音还在说
 * "我来做" —— 用户看到的就是"完成播报在任务完成之前就出现"。
 *
 * 修法：接收台词延迟 800ms 才开口；凡 quickWebOpen 已开页（结果马上出），
 * 未出口的那句整个撤掉。这里锁三件事：延迟存在、撤销函数存在、快速路真的调用它。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PANEL = fs.readFileSync(path.join(import.meta.dirname, "..", "desktop", "panel.html"), "utf8");
const BACKGROUND = fs.readFileSync(path.join(import.meta.dirname, "..", "browser-extension", "background.js"), "utf8");

test("接收台词必须延迟 800ms，且可撤销", () => {
  assert.match(PANEL, /let recvSpeakTimer = null;/);
  assert.match(PANEL, /function cancelRecvSpeak\(\)/);
  assert.match(
    PANEL,
    /recvSpeakTimer = setTimeout\(\(\) => \{ recvSpeakTimer = null; speakSituation\('recv'\); \}, 800\)/,
    "接收台词不许再同步直说 —— 秒级任务会追着结果放"
  );
});

test("快速路开页（quickWebOpen）必须撤掉未出口的接收台词", () => {
  const start = PANEL.indexOf("function quickWebOpen(");
  assert.ok(start >= 0, "找不到 quickWebOpen");
  /* 函数随「走浏览器通道」改造变长，扫描窗口放大到能覆盖两个成功分支
     （扩展通道成功 / 退回系统默认浏览器）。cancelRecvSpeak 只出现在 quickWebOpen 内，
     下一个函数 bchanOnline 不含，所以窗口多扫一点不会误判。 */
  const seg = PANEL.slice(start, start + 4000);
  const n = (seg.match(/cancelRecvSpeak\(\)/g) || []).length;
  assert.ok(n >= 2, "quickWebOpen 至少在两个开页分支里调用 cancelRecvSpeak（实际 " + n + " 处）");
});

test("quickWebOpen 成功闸门必须用 res2.ok && res2.result，不得用 res2.result.ok", () => {
  const start = PANEL.indexOf("function quickWebOpen(");
  assert.ok(start >= 0, "找不到 quickWebOpen");
  const seg = PANEL.slice(start, start + 4000);
  /* 桥回执结构为 { ok:true, result:{tabId,url}, error:null }（成功）或
     { ok:true, result:null, error:{...} }（失败）。result 本身没有 .ok 字段，
     成功与否看「有没有 result」，不是 res2.result.ok。
     2026-11-08 事故：旧代码写 res2.result.ok，夸克扩展明明执行成功也被判失败，
     又用默认浏览器开了一遍 —— 用户看到「在夸克搜却跳到默认浏览器」。 */
  assert.match(seg, /res2 && res2\.ok && res2\.result/,
    "成功闸门必须是 res2.ok && res2.result（result 含扩展回执，无 .ok 字段）");
  assert.ok(!/if \(res2 && res2\.result && res2\.result\.ok\)/.test(PANEL),
    "严禁再用 res2.result.ok 作为成功闸门（永远 undefined，会把成功判成失败）");
});

test("tab.open 必须干净开页、不得进 ORB 分组", () => {
  /* 2026-11-08 用户反馈：在夸克里开页被塞进「ORB 绿色分组」，不如默认浏览器(openExternal)
   * 那样无痕干净。修法：tab.open 不再走 createOwnedTab -> addOwnedTab -> chrome.tabs.group，
   * 改为直接用 chrome.tabs.create 开页，和 openExternal 同一原则（开了就不管）。这里锁死它。 */
  const start = BACKGROUND.indexOf("case 'tab.open':");
  assert.ok(start >= 0, "找不到 tab.open 分支");
  const end = BACKGROUND.indexOf("case 'tab.goto':", start);
  assert.ok(end > start, "找不到 tab.open 分支结束位置");
  const seg = BACKGROUND.slice(start, end);
  assert.ok(!/createOwnedTab\(/.test(seg),
    "tab.open 不得再调用 createOwnedTab（它会强制归 ORB 分组）");
  assert.ok(!/addOwnedTab\(/.test(seg),
    "tab.open 不得调用 addOwnedTab（会归组并登记 ownedTabIds）");
  assert.ok(/chrome\.tabs\.create\(\{[^}]*active: true/.test(seg),
    "tab.open 必须直接用 chrome.tabs.create 干净开新页");
});

test("读页面不得在用户标签栏创建 ORB 分组（2026-11-09 用户反馈）", () => {
  /* 用户原话「产生了特殊标签页分组，不是可以不产生吗」。
   * 根因：dom.get_text / get_page_text 不传 tabId → 懒接管当前页 → addOwnedTab
   * 顺手 chrome.tabs.group 并改标题颜色。只是读一下文字，不该动用户的标签栏。
   * 现在 addOwnedTab 只登记所有权；创建分组的代码整段删掉，避免有人再开回来。 */
  const start = BACKGROUND.indexOf("async function addOwnedTab");
  assert.ok(start >= 0, "找不到 addOwnedTab");
  const end = BACKGROUND.indexOf("\n}", start);
  const seg = BACKGROUND.slice(start, end + 2);
  assert.ok(!/chrome\.tabs\.group\(/.test(seg),
    "addOwnedTab 不得调用 chrome.tabs.group（读操作会在标签栏留下 ORB 分组）");
  assert.ok(!/chrome\.tabGroups\.update\(/.test(seg),
    "addOwnedTab 不得改分组标题/颜色");
  /* 归属登记必须保留：所有权闸门（tab-not-owned）靠它放行 */
  assert.ok(/state\.ownedTabIds\.add\(tabId\)/.test(seg),
    "addOwnedTab 仍必须登记 ownedTabIds，否则读命令会被 tab-not-owned 拒掉");
});

test("老版本遗留的 ORB 分组仍要能拆掉", () => {
  /* 删掉创建分组的逻辑，但不能删掉清理逻辑：
     已经装了老版本的用户标签栏里可能还有 ORB 分组，急停/关通道时要帮他们拆。 */
  const start = BACKGROUND.indexOf("async function ungroupOwnedTabs");
  assert.ok(start >= 0, "找不到 ungroupOwnedTabs");
  const end = BACKGROUND.indexOf("\n}", start);
  assert.ok(/chrome\.tabs\.ungroup\(/.test(BACKGROUND.slice(start, end + 2)),
    "ungroupOwnedTabs 必须仍然调用 chrome.tabs.ungroup");
});
