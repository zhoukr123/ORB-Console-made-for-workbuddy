/* 应用意图解析：静态能力表 + 查表函数，不猜、只查表。
 *
 * 对应《ORB桌面客户端操控-可行性实证与落地方案.md》§4.1 / §4.2。
 * 实测依据（报告 §2.1）：本机注册协议扫描 130+ 项，PC 客户端的协议语义
 * 只到「登录/唤起/分享」，没有「搜索」；bilibili PC 注册的是 bilipc 而非 bilibili。
 *
 * 严守 §六「明确不做」：
 *   1) 不照搬移动端 scheme 表（bilibili://、snssdk1128:// 等本机一个都不存在）；
 *   2) 不给已运行的 Electron 注入调试端口；
 *   3) 不做视觉找搜索框；
 *   4) 不在协议表里填未经实测的模板 —— DEEP_LINKS 默认**空表**，留空比乱填安全。
 *
 * 与面板复用同一条 0.8 闸门：表里命中且有 webSearch → 0.95 直开；
 * 只有客户端 → 0.6（低于闸门），改为「唤起 + 剪贴板 + 提示」；
 * 未命中 → 0，明确告知没有稳定入口。
 */
export const CONFIDENCE_GATE = 0.8;

/* 深链白名单：只放实测通过且带搜索语义的项。当前本机实测结果为 0 条，
   所以刻意留空。新增条目必须附实测记录，宁可空着也不猜。 */
export const DEEP_LINKS = Object.freeze({});

const APP = (aliases, o = {}) => Object.freeze({
  aliases: Object.freeze(aliases),
  webSearch: o.webSearch ?? null,
  installed: o.installed === true,
  protocol: o.protocol ?? null,     // 已实测注册的协议名，仅作记录，不用于拼搜索 URL
  exe: o.exe ?? null,
  clientSearch: o.clientSearch ?? null,  // 'clipboard' = 只能唤起 + 剪贴板预置
  generic: o.generic === true,           // 通用兜底，匹配优先级最低
  note: o.note ?? "",
});

/* 18 个应用。URL 只写「网页版搜索」这一层，不写客户端 scheme。
   未安装的客户端（知乎/抖音等）仍可用网页版，故照常登记。 */
export const APPS = Object.freeze({
  bilibili: APP(["b站", "B站", "哔哩哔哩", "bilibili"], {
    webSearch: "https://search.bilibili.com/all?keyword=",
    installed: true, protocol: "bilipc",
    exe: "D:\\Program Files\\bilibili\\哔哩哔哩.exe",
    note: "bilipc 无搜索语义，客户端不支持命令行搜索",
  }),
  zhihu: APP(["知乎"], { webSearch: "https://www.zhihu.com/search?type=content&q=" }),
  douyin: APP(["抖音"], { webSearch: "https://www.douyin.com/search/" }),
  xiaohongshu: APP(["小红书", "xhs"], { webSearch: "https://www.xiaohongshu.com/search_result?keyword=" }),
  kuaishou: APP(["快手"], { webSearch: "https://www.kuaishou.com/search/video?searchKey=" }),
  weibo: APP(["微博"], { webSearch: "https://s.weibo.com/weibo?q=" }),
  meituan: APP(["美团"], { webSearch: "https://www.meituan.com/s/" }),
  dianping: APP(["大众点评"], { webSearch: "https://www.dianping.com/search/keyword/0/0_" }),
  netease_music: APP(["网易云", "网易云音乐"], { webSearch: "https://music.163.com/#/search/m/?s=" }),
  xunlei: APP(["迅雷"], { webSearch: null, note: "下载器，无通用网页搜索入口" }),
  dingtalk: APP(["钉钉"], { webSearch: null, note: "无公开网页搜索入口" }),
  feishu: APP(["飞书"], { webSearch: null, note: "无公开网页搜索入口" }),
  jianying: APP(["剪映"], { webSearch: null, note: "无公开网页搜索入口" }),
  wechat: APP(["微信", "wechat"], {
    installed: true, protocol: "weixin/xweixin", clientSearch: "clipboard",
    note: "无网页版搜索，仅登录/扫码/跳转语义",
  }),
  qq: APP(["QQ", "qq"], {
    installed: true, protocol: "tencent/mqqapi", clientSearch: "clipboard",
    note: "无网页版搜索，仅登录/分享语义",
  }),
  wecom: APP(["企业微信", "企微"], {
    installed: true, protocol: "wxwork/WeWork/WeDrive", clientSearch: "clipboard",
    note: "无网页版搜索，仅登录/分享语义",
  }),
  quark: APP(["夸克"], { installed: true, protocol: "qklink/magnet", webSearch: "https://quark.sm.cn/s?q=" }),
  vscode: APP(["vscode", "VS Code"], {
    installed: true, protocol: "vscode", webSearch: null,
    note: "协议只用于打开文件/URL，不做搜索",
  }),
  webSearch: APP(["网页搜索", "上网搜"], {
    webSearch: "https://cn.bing.com/search?q=",
    generic: true,
    note: "通用网页搜索，走 bing-cn（国内可达）；只在没有点名具体应用时兜底",
  }),
});

export const APP_COUNT = Object.keys(APPS).length;

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** 从一句话里找出点名的应用。别名按长度降序，避免「B站」被「b站」之类短词抢先。
 *  通用兜底项（generic）排最后，否则「搜一下」会盖掉用户点名的具体应用。 */
export function findApp(text) {
  const t = norm(text);
  if (!t) return null;
  const pairs = [];
  for (const [id, app] of Object.entries(APPS)) {
    for (const a of app.aliases) pairs.push({ id, alias: norm(a), generic: app.generic === true });
  }
  pairs.sort((x, y) => {
    if (x.generic !== y.generic) return x.generic ? 1 : -1;  // 具体应用优先
    return y.alias.length - x.alias.length;
  });
  for (const p of pairs) {
    if (t.includes(p.alias)) return { id: p.id, alias: p.alias, app: APPS[p.id] };
  }
  return null;
}

/** 抽出搜索关键词：去掉应用别名、动作动词与语气词。
 *  2026-11-08：「在夸克浏览器中搜索湖南大学」被剥成「浏览器 湖南大学」——
 *  「浏览器」是状语残留，必须一起剥；第二落地动作（并进入其官网）也不是搜索词。 */
export function extractKeyword(text, alias) {
  let t = String(text ?? "").trim();
  if (alias) t = t.replace(new RegExp(alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  t = t.replace(/(客户端|打开|启动|唤起|用|在|里|中|上|搜一下|搜索|搜|查一下|查|找|看看|一下|帮我|请|浏览器)/g, " ");
  /* 第二步落地动作不属于关键词：宁可截断，也不把「并进入其官网」塞进 query。 */
  t = t.replace(/(?:并|然后|接着|随后)?\s*(?:进入|打开|访问|前往)\s*(?:其|该|这个|它的)?\s*(?:官网|网站|主页|首页|站点).*$/g, " ");
  t = t.replace(/[\s，,。.、！!？?]+/g, " ").trim();
  return t.slice(0, 128);
}

/* ───────── 「搜索 X 并进入其官网」这类复合网页指令 ─────────
 * 2026-11-08 事故：用户说「帮我在夸克浏览器中搜索湖南大学并进入其官网」，旧链路
 * 把它当成「用夸克搜」三层全错：
 *   ① 浏览器名被当成搜索站点，用 quark.sm.cn 在**默认浏览器**里开了夸克网页版 ——
 *      看起来像在操控夸克客户端，其实没有任何接管（用户当场指出「好像不太对」）；
 *   ② 关键词拼成「浏览器 湖南大学并进入其官网」；
 *   ③ 停在搜索结果页，官网一步没做。
 * 这里把这类句子从「应用搜索」里摘出来，只产出一个复合意图：
 *   · keyword 干净（不带浏览器状语、不带第二步动作）；
 *   · searchUrl 用能力表里的通用网页搜索，**不因为点了浏览器名就伪造入口**；
 *   · siteQuery 交给 /api/resolve-site 解析官网，仍走 0.8 闸门，不猜。
 * 只认紧连的落地补语；带「然后/顺便/接着」的显式多步任务仍交后台，不在这里抢。
 */
const WEB_SEARCH_VERB = /(?:搜一下|搜搜|搜索(?!框)|搜|查一下|查查|找一下|百度一下|谷歌一下|必应一下)/;
const WEB_LANDING_TAIL = /(?:并|而且)?\s*(?:进入|打开|访问|前往|跳转到?|导航到?)\s*(?:其|该|这个|它的|对应)?\s*(?:官网|网站|主页|首页|站点)/;
const WEB_MULTI_STEP = /(然后|并且|接着|之后|随后|顺便|同时|再打开|再进)/;
const WEB_RESEARCH = /(分析|总结|整理|对比|比较|写|报告|表格|归纳|提炼|深入|复制|保存|提取|抓取|翻译|记录|发给|发到)/;
const BROWSER_WORD = /(?:夸克浏览器|谷歌浏览器|chrome浏览器|edge浏览器|火狐浏览器|夸克|谷歌|chrome|edge|火狐|firefox|浏览器)/i;

function cleanWebKeyword(s) {
  let t = String(s ?? "");
  t = t.replace(/[，,。;；、!！？?~～]+/g, " ");
  t = t.replace(/(?:在|用|打开)?\s*(?:夸克浏览器|谷歌浏览器|chrome浏览器|edge浏览器|火狐浏览器|夸克|谷歌|chrome|edge|火狐|firefox|浏览器|bing|必应|google)\s*(?:里|中|上|里面|内)?\s*/gi, " ");
  t = t.replace(/(?:帮我|请|麻烦你?|给我|我想要?|能不能|可以|需要你)\s*/g, " ");
  return t.replace(/[的了吧呀啊嘛。，,\s]+$/, "").replace(/\s+/g, " ").trim();
}

/** 句子里点名的浏览器（状语），没有就返回空串。 */
export function namedBrowser(text) {
  const m = BROWSER_WORD.exec(String(text ?? ""));
  return m ? m[0] : "";
}

/** 复合网页指令：{ keyword, siteQuery, searchUrl, browser } 或 null（拿不准一律 null）。 */
export function resolveWebLanding(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  if (WEB_MULTI_STEP.test(raw)) return null;   // 显式多步交后台
  if (WEB_RESEARCH.test(raw)) return null;     // 研究型任务交模型
  const tail = WEB_LANDING_TAIL.exec(raw);
  if (!tail) return null;
  const head = raw.slice(0, tail.index);
  const g = new RegExp(WEB_SEARCH_VERB.source, "g");
  let sm = null;
  let mm;
  while ((mm = g.exec(head))) sm = mm;          // 取最后一个搜索动词
  if (!sm) return null;
  const keyword = cleanWebKeyword(head.slice(sm.index + sm[0].length));
  if (!keyword || keyword.length > 60) return null;
  const siteQuery = /(官网|网站|主页|首页|站点)$/.test(keyword) ? keyword : keyword + "官网";
  const base = APPS.webSearch.webSearch;
  return {
    keyword,
    siteQuery,
    searchUrl: base + encodeURIComponent(keyword),
    searchEngine: "bing",
    browser: namedBrowser(raw),
    reason: "复合网页指令：关键词先洗净，再解析官网并过 0.8 闸门",
  };
}

/**
 * 解析应用动作。返回 { transport, url, confidence, reason, app, keyword, clipboard }
 * transport: web | clipboard | none
 * 绝不返回 deeplink —— 白名单为空，且报告明确禁止填未实测模板。
 */
export function resolveAppAction(text) {
  /* 复合网页指令先判：搜索只是手段，落点是官网。
     不能当成「用某应用搜」处理，否则会拿脏关键词开一个搜索结果页。 */
  const landing = resolveWebLanding(text);
  if (landing) {
    return {
      transport: "none", url: "", confidence: 0,
      reason: landing.reason, app: null, keyword: landing.keyword, clipboard: "",
      webLanding: landing,
    };
  }
  const hit = findApp(text);
  if (!hit) {
    return {
      transport: "none", url: "", confidence: 0,
      reason: "这个应用没有稳定的命令行入口（表里未登记），不猜", app: null, keyword: "", clipboard: "",
    };
  }
  /* 浏览器名当状语（「在夸克浏览器中」）时，它是「用什么打开」，不是「去哪个站搜」。
     拿 quark.sm.cn 顶替，会在默认浏览器里开一个夸克网页版 —— 看起来像在操控
     夸克客户端，其实没有任何接管（2026-11-08 用户当场指出「好像不太对」）。 */
  if (/浏览器/.test(text) && /^(?:夸克|谷歌|chrome|edge|火狐|firefox)$/i.test(hit.alias)) {
    return {
      transport: "none", url: "", confidence: 0,
      reason: "点名的是浏览器客户端，不是搜索站点；确定性链路只能用系统默认浏览器打开，不伪装成操控客户端",
      app: null, keyword: extractKeyword(text, hit.alias), clipboard: "",
      browserVehicle: hit.alias,
    };
  }
  const keyword = extractKeyword(text, hit.alias);
  const { app, id } = hit;

  if (app.webSearch) {
    return {
      transport: "web",
      url: app.webSearch + encodeURIComponent(keyword),
      confidence: 0.95,
      reason: `已用网页版搜索${app.note ? "（" + app.note + "）" : ""}`,
      app: id, keyword, clipboard: "",
    };
  }
  if (app.clientSearch === "clipboard") {
    return {
      transport: "clipboard", url: "", confidence: 0.6,
      reason: `${id} 只有客户端且不支持命令行传搜索词；改为唤起 + 关键词写入剪贴板 + 提示（不模拟点击）`,
      app: id, keyword, clipboard: keyword,
      exe: app.exe, protocol: app.protocol,
    };
  }
  return {
    transport: "none", url: "", confidence: 0,
    reason: app.note || "该应用无稳定网页搜索入口，不做猜测", app: id, keyword, clipboard: "",
  };
}

/** 0.8 闸门：只有 >= 0.8 才允许直接开，其余一律走兜底。 */
export function canDirectOpen(action) {
  return !!action && action.transport === "web" && action.confidence >= CONFIDENCE_GATE && /^https?:\/\//i.test(action.url);
}

/** 自检矩阵：给 /api/app-matrix 用，列出每个应用的 transport 判定。 */
export function appMatrix() {
  return Object.entries(APPS).map(([id, a]) => ({
    id,
    aliases: [...a.aliases],
    installed: a.installed,
    protocol: a.protocol,
    webSearch: a.webSearch,
    clientSearch: a.clientSearch,
    transport: a.webSearch ? "web" : a.clientSearch === "clipboard" ? "clipboard" : "none",
    note: a.note,
  }));
}

/* ───────── 报告A §五 P1：深链白名单「机制」 ─────────
 * 报告 §六第 4 条：深链表宁可为空，也不能猜。这里把「空表」升级成
 * 「可证伪的登记机制」，四条硬约束：
 *   ① 编译期真相 DEEP_LINKS 仍是冻结空对象 —— 本机实测 0 条；
 *   ② 运行时要新增条目，必须提交完整实测证据，缺任一项直接拒；
 *   ③ 报告 §2.1 点名「本机注册表里一个都不存在」的移动端 scheme 直接拉黑；
 *   ④ 登记后**不会自动生效**：resolveAppAction 不查运行时表，
 *      只有显式调用 resolveDeepLink 才可能产出 deeplink。
 * 目的：将来真装了支持搜索的客户端，跑一次实测就能登记，不用改代码猜模板。
 */
const RUNTIME_DEEP_LINKS = new Map();

export const FORBIDDEN_SCHEMES = Object.freeze([
  "bilibili://", "snssdk1128://", "zhihu://", "xhsdiscover://", "imeituan://",
]);

const DEEP_LINK_EVIDENCE_FIELDS = Object.freeze([
  "verifiedAt", "probe", "result", "template", "params",
]);

export function registerDeepLink(appId, record = {}) {
  const id = String(appId || "");
  if (!APPS[id]) return { ok: false, reasonCode: "unknown-app", appId: id };
  const missing = DEEP_LINK_EVIDENCE_FIELDS.filter((k) => {
    const v = record[k];
    return v == null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);
  });
  if (missing.length) return { ok: false, reasonCode: "missing-evidence", appId: id, missing };
  if (record.verified !== true) return { ok: false, reasonCode: "not-verified", appId: id };
  const tpl = String(record.template);
  const bad = FORBIDDEN_SCHEMES.find((s) => tpl.toLowerCase().startsWith(s));
  if (bad) return { ok: false, reasonCode: "forbidden-scheme", appId: id, scheme: bad };
  if (!tpl.includes("{keyword}")) {
    return { ok: false, reasonCode: "no-keyword-placeholder", appId: id };
  }
  RUNTIME_DEEP_LINKS.set(id, Object.freeze({
    appId: id,
    template: tpl,
    params: Object.freeze([...record.params]),
    verifiedAt: String(record.verifiedAt),
    probe: String(record.probe),
    result: String(record.result),
    note: String(record.note || ""),
  }));
  return { ok: true, registered: true, appId: id };
}

export function resolveDeepLink(appId, keyword = "") {
  const e = RUNTIME_DEEP_LINKS.get(String(appId || ""));
  if (!e) {
    return { ok: false, transport: "none", url: "", reasonCode: "no-verified-deeplink" };
  }
  return {
    ok: true,
    transport: "deeplink",
    url: e.template.replace("{keyword}", encodeURIComponent(String(keyword || ""))),
    evidence: { verifiedAt: e.verifiedAt, probe: e.probe, result: e.result },
  };
}

export function deepLinkAudit() {
  return {
    compiledCount: Object.keys(DEEP_LINKS).length,
    runtimeCount: RUNTIME_DEEP_LINKS.size,
    runtimeIds: [...RUNTIME_DEEP_LINKS.keys()],
    forbiddenSchemes: [...FORBIDDEN_SCHEMES],
    /* 关键：默认解析路径永远不消费运行时登记，防止「悄悄填上就生效」。 */
    defaultPathUsesRuntime: false,
  };
}

/* ───────── 报告A §五 P1：客户端唤起 + 剪贴板兜底 ─────────
 * 报告 §4.2：用户明确说「用客户端搜」时 → 启动 exe（**无参数**）
 * → 关键词写入剪贴板 → 提示按 Ctrl+V 回车。
 * 实测依据：报告 §2.2 用 Start-Process 启动 bilibili exe 成功，
 * 但 --remote-debugging-port 被它自己的 Node CLI 拒绝（bad option），
 * 所以结论只能是「无参数唤起」，绝不能拼搜索参数。
 * 微信/QQ/企业微信只实测到协议名、没有实测 exe 路径 —— 一律不登记，
 * 不猜路径、不拼 scheme、不模拟点击，只走剪贴板 + 如实提示。
 */
export const LAUNCH_EVIDENCE = Object.freeze({
  bilibili: Object.freeze({
    exe: "D:\\Program Files\\bilibili\\哔哩哔哩.exe",
    args: Object.freeze([]),
    evidence: "报告 §2.2：Start-Process 启动成功；带参数被 Node CLI 拒绝（bad option），故只用无参数唤起",
  }),
});

/** 只接受能力表里的 appId；exe/args 全由桥侧静态表决定，不接受外部路径。 */
export function planClientLaunch(appId) {
  const id = String(appId || "");
  const rec = LAUNCH_EVIDENCE[id];
  if (!rec) {
    return {
      ok: false, reasonCode: "no-verified-launch", appId: id, exe: "", args: [],
      hint: "本机没有这个客户端的实测唤起通道，请手动打开（关键词已放进剪贴板）",
    };
  }
  return {
    ok: true, kind: "exe", appId: id, exe: rec.exe, args: [...rec.args],
    evidence: rec.evidence, launchMode: "fire-and-forget",
  };
}

/** 「用客户端搜」是显式意图，不能由「只有客户端」自动推断。 */
export function wantsClient(text) {
  return /(用客户端|在客户端|客户端里|客户端中|客户端搜|打开客户端|启动客户端)/.test(String(text || ""));
}

/** 只有显式要求客户端时才返回非空；默认解析 resolveAppAction 完全不受影响。 */
export function resolveClientAction(text) {
  if (!wantsClient(text)) return null;
  const hit = findApp(text);
  const appId = hit ? hit.id : null;
  const keyword = extractKeyword(text, hit ? hit.alias : "");
  const launch = planClientLaunch(appId);
  return {
    transport: launch.ok ? "client_launch" : "clipboard",
    app: appId,
    keyword,
    clipboard: keyword,
    launch,
    confidence: launch.ok ? 0.9 : 0.6,
    reason: launch.ok
      ? "用户明确要用客户端：无参数唤起 + 关键词预置剪贴板（不模拟点击、不拼搜索参数）"
      : "该客户端没有实测唤起通道：只写剪贴板 + 提示，不猜路径、不模拟点击",
  };
}

export default {
  CONFIDENCE_GATE, DEEP_LINKS, APPS, APP_COUNT,
  findApp, extractKeyword, resolveAppAction, canDirectOpen, appMatrix,
  resolveWebLanding, namedBrowser,
  FORBIDDEN_SCHEMES, registerDeepLink, resolveDeepLink, deepLinkAudit,
  LAUNCH_EVIDENCE, planClientLaunch, wantsClient, resolveClientAction,
};
