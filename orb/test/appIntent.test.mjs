/* appIntent 单测 —— 锁的是报告 §六「不猜」这条安全边界。
 * 最怕的不是解析不出来，而是：把移动端 scheme 抄进来、给只有客户端的应用
 * 伪造一个能搜的 URL、低置信却放行、深链表被悄悄填上未实测模板。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONFIDENCE_GATE, DEEP_LINKS, APPS, APP_COUNT, findApp, extractKeyword,
  resolveAppAction, canDirectOpen, appMatrix, resolveWebLanding, namedBrowser,
} from "../appIntent.mjs";

test("能力表覆盖 18+ 应用，且每条字段形状固定", () => {
  assert.ok(APP_COUNT >= 18, `只有 ${APP_COUNT} 个应用`);
  for (const [id, a] of Object.entries(APPS)) {
    assert.ok(Array.isArray(a.aliases) && a.aliases.length, id);
    assert.equal(typeof a.installed, "boolean", id);
    assert.ok(a.webSearch === null || /^https:\/\//.test(a.webSearch), `${id} 的 webSearch 必须是 https`);
    assert.ok(Object.isFrozen(a), `${id} 必须冻结`);
  }
  assert.ok(Object.isFrozen(APPS));
});

test("深链白名单刻意留空：本机实测 0 条带搜索语义的协议", () => {
  assert.equal(Object.keys(DEEP_LINKS).length, 0, "不许填未实测模板");
  assert.ok(Object.isFrozen(DEEP_LINKS));
});

test("绝不产出移动端 scheme；所有 transport 只能是 web/clipboard/none", () => {
  for (const [id, a] of Object.entries(APPS)) {
    const r = resolveAppAction(`用${a.aliases[0]}搜一下测试关键词`);
    assert.ok(["web", "clipboard", "none"].includes(r.transport), id);
    assert.ok(!String(r.url).includes("://bilibili"), id);
    for (const bad of ["bilibili://", "snssdk1128://", "xhsdiscover://", "imeituan://", "zhihu://"]) {
      assert.ok(!String(r.url).startsWith(bad), `${id} 不该出现 ${bad}`);
    }
  }
});

test("B站：命中网页版搜索，置信 0.95 过闸门，URL 编码正确", () => {
  const r = resolveAppAction("打开哔哩哔哩搜一下 某某博主 的视频");
  assert.equal(r.app, "bilibili");
  assert.equal(r.transport, "web");
  assert.equal(r.confidence, 0.95);
  assert.equal(r.url, "https://search.bilibili.com/all?keyword=" + encodeURIComponent(r.keyword));
  assert.equal(canDirectOpen(r), true);
  assert.match(r.reason, /网页版搜索/);
});

test("微信/QQ/企业微信：只有客户端，0.6 不过闸门，走剪贴板兜底", () => {
  for (const q of ["用微信搜一下张三", "用QQ搜一下群名", "企业微信搜一下文档"]) {
    const r = resolveAppAction(q);
    assert.equal(r.transport, "clipboard", q);
    assert.equal(r.confidence, 0.6, q);
    assert.equal(canDirectOpen(r), false, q);
    assert.equal(r.url, "", q);
    assert.ok(r.clipboard.length > 0, q);
    assert.match(r.reason, /不模拟点击/);
  }
});

test("未登记应用：confidence 0，明确告知没有稳定入口，不伪造 URL", () => {
  const r = resolveAppAction("用一个完全不存在的软件搜一下 X");
  assert.equal(r.transport, "none");
  assert.equal(r.confidence, 0);
  assert.equal(r.url, "");
  assert.match(r.reason, /不猜/);
});

test("0.8 闸门：低置信一律不放行，网址必须 http(s)", () => {
  assert.equal(CONFIDENCE_GATE, 0.8);
  assert.equal(canDirectOpen({ transport: "web", confidence: 0.79, url: "https://a.com" }), false);
  assert.equal(canDirectOpen({ transport: "web", confidence: 0.95, url: "javascript:alert(1)" }), false);
  assert.equal(canDirectOpen({ transport: "clipboard", confidence: 0.95, url: "https://a.com" }), false);
});

test("别名按长度降序：B站/哔哩哔哩 都命中同一个 id", () => {
  for (const q of ["B站搜一下X", "b站搜一下X", "哔哩哔哩搜一下X", "bilibili搜一下X"]) {
    assert.equal(findApp(q).id, "bilibili", q);
  }
  assert.equal(findApp("小红书搜一下穿搭").id, "xiaohongshu");
  assert.equal(findApp("网易云音乐搜一下周杰伦").id, "netease_music");
});

test("关键词抽取：去掉应用名与动作词，长度受限", () => {
  assert.equal(extractKeyword("搜一下 固态硬盘", ""), "固态硬盘");
  const k = extractKeyword("打开哔哩哔哩搜一下 某某博主", "哔哩哔哩");
  assert.ok(!k.includes("哔哩哔哩") && !k.includes("搜"));
  assert.ok(k.length <= 128);
  assert.equal(extractKeyword("A".repeat(500), "").length, 128);
});

test("appMatrix 自检输出：18+ 行，每行 transport 与能力一致", () => {
  const m = appMatrix();
  assert.ok(m.length >= 18);
  for (const row of m) {
    assert.ok(["web", "clipboard", "none"].includes(row.transport), row.id);
    if (row.webSearch) assert.equal(row.transport, "web", row.id);
    else if (row.clientSearch === "clipboard") assert.equal(row.transport, "clipboard", row.id);
    else assert.equal(row.transport, "none", row.id);
  }
  const b = m.find((x) => x.id === "bilibili");
  assert.equal(b.protocol, "bilipc", "实测协议名是 bilipc，不是 bilibili");
  assert.equal(b.installed, true);
});

test("报告 §2 实测：本机注册协议语义只到 登录/唤起/分享，不用于拼搜索", () => {
  for (const id of ["wechat", "qq", "wecom", "quark", "vscode"]) {
    const a = APPS[id];
    assert.ok(a.protocol, `${id} 应记录实测协议`);
  }
  assert.equal(APPS.bilibili.protocol, "bilipc");
  assert.ok(!("bilibili://" in DEEP_LINKS));
});

/* ───── 2026-11-08 事故：夸克浏览器 + 搜索 + 进入官网 ───── */

test("浏览器是状语不是搜索站：不拿 quark.sm.cn 顶替夸克客户端", () => {
  const r = resolveAppAction("帮我在夸克浏览器中搜索湖南大学");
  assert.equal(r.transport, "none");
  assert.equal(r.url, "", "不许拿夸克网页版冒充夸克客户端");
  assert.equal(r.app, null);
  assert.match(r.reason, /浏览器客户端/);
  assert.equal(r.browserVehicle, "夸克");
  /* 能力表语义不变：单说「用夸克搜」仍然是夸克网页版搜索 */
  assert.equal(resolveAppAction("用夸克搜一下固态硬盘").transport, "web");
});

test("复合指令：关键词洗净，第二步动作不塞进 query", () => {
  const r = resolveAppAction("帮我在夸克浏览器中搜索湖南大学并进入其官网");
  assert.equal(r.transport, "none");
  assert.equal(r.app, null);
  const w = r.webLanding;
  assert.ok(w, "必须带回复合意图");
  assert.equal(w.keyword, "湖南大学");
  assert.equal(w.siteQuery, "湖南大学官网");
  assert.equal(w.searchUrl, "https://cn.bing.com/search?q=" + encodeURIComponent("湖南大学"));
  assert.equal(w.browser, "夸克浏览器");
  assert.ok(!/浏览器/.test(w.keyword) && !/进入/.test(w.keyword) && !/官网/.test(w.keyword));
});

test("复合指令不抢显式多步 / 研究型任务", () => {
  assert.equal(resolveWebLanding("搜索湖南大学然后进入其官网"), null, "然后 → 交后台");
  assert.equal(resolveWebLanding("搜索湖南大学顺便打开官网"), null, "顺便 → 交后台");
  assert.equal(resolveWebLanding("搜索湖南大学并做对比分析"), null, "研究型 → 交模型");
  assert.equal(resolveWebLanding("搜索湖南大学"), null, "没有落地补语就不是复合指令");
});

test("namedBrowser 只认名字，不误伤普通关键词", () => {
  assert.equal(namedBrowser("在夸克浏览器中搜索湖南大学"), "夸克浏览器");
  assert.equal(namedBrowser("在 Chrome 打开湖南大学官网"), "Chrome");
  assert.equal(namedBrowser("搜一下湖南大学"), "");
});
