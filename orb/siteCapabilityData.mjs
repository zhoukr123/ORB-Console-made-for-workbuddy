/* 站点能力数据表（规模化登记 · 诚实版）
 *
 * 数据来源：china-top1000-websites.csv，取 NetAPI_Rank_CN <= 226 的前 226 个真实域名，
 *          逐行内联在源码里，不运行时读 CSV、不编造任何域名或排名。
 * 品类规则：移植自 analyze_top226.py 的 CATS 正则（顺序敏感，首个命中胜出），
 *          JS 侧分类分布已与 Python 原版逐类比对一致。
 *
 * 红线（p2SiteAdapter.GENERIC_FALLBACK）：未登记站点只做通用兜底，不猜 DOM 选择器。
 *         因此本表对 226 个域名仅做「品类 + rank + 分层」登记，把「未登记站点」
 *         变成「已登记但只走安全通道」：未核实条目只给 channel:"url" 的通用搜索 URL
 *         模板（送进 searchUrl.mjs 的 A 口径），verify 仅写「URL 变化 + 页面就绪」
 *         这类可观察信号，绝不生成 selector / endpoint / 站内 DOM 路径。
 *         仅 4 个已核实站点（bilibili.com / taobao.com / jd.com / eastmoney.com）
 *         保留真实 api/dom/url 动作并标 verified:true。
 *         成人/无关品类标 tier:"skip"，不生成任何动作、不进能力表。
 * 本模块零依赖、零 IO、不引入任何外部模块，打包自包含。
 */

export const DATA_SOURCE = "china-top1000-websites.csv#rank<=226";

export const CATEGORIES = Object.freeze({
  GOV: "政府/机构",
  EDU: "教育/高校",
  FINANCE: "金融/投资",
  ECOMMERCE: "电商/购物",
  MEDIA: "影音/媒体",
  SOCIAL: "社区/社交",
  PORTAL: "搜索/门户/新闻",
  TECH: "工具/AI/技术",
  TRAVEL: "旅游/出行",
  INTL: "国际通用",
  ADULT: "成人/无关",
  OTHER: "其他/品牌/长尾",
});

export const TIERS = Object.freeze({ LIGHT: "light", DEEP: "deep", SKIP: "skip" });

// 4 个已核实站点：形状与 p2SiteAdapter.SITE_CAPABILITIES 条目一致，动作原样保留。
export const VERIFIED_SITES = Object.freeze({
  "bilibili.com": Object.freeze({
    category: "影音",
    actions: Object.freeze({
      search_uploader: { channel: "api", endpoint: "api.bilibili.com/x/web-interface/search/all/v2", verify: "返回 mid 与 uname 匹配" },
      open_video:     { channel: "url", pattern: "https://www.bilibili.com/video/{bvid}", verify: "URL 变化 + 播放器 DOM 就绪" },
      read_meta:      { channel: "dom", selector: ".video-info-meta", verify: "标题/播放量回读非空" },
    }),
    fallback: "vision",
  }),
  "taobao.com": Object.freeze({
    category: "电商",
    actions: Object.freeze({
      search_product: { channel: "url", pattern: "https://s.taobao.com/search?q={kw}", verify: "结果列表 DOM 就绪" },
      open_official:  { channel: "dom", selector: "[data-official='true']", verify: "店铺资质标记存在" },
      read_price:     { channel: "dom", selector: ".price", verify: "价格回读为数值且非空" },
    }),
    fallback: "vision",
  }),
  "jd.com": Object.freeze({
    category: "电商",
    actions: Object.freeze({
      search_product: { channel: "url", pattern: "https://search.jd.com/Search?keyword={kw}", verify: "结果列表 DOM 就绪" },
      read_price:     { channel: "dom", selector: ".p-price", verify: "价格回读为数值且非空" },
    }),
    fallback: "vision",
  }),
  "eastmoney.com": Object.freeze({
    category: "投资",
    actions: Object.freeze({
      read_quote: { channel: "api", endpoint: "push2.eastmoney.com/api/qt/stock/get", verify: "返回 secid 与最新价" },
    }),
    fallback: "vision",
  }),
});

// 深度适配层（L1/L2 用户指令「常用网站深度适配」）：独立于 226 CSV 清单，手工实证、verified。
// 与 VERIFIED_SITES 的区别：VERIFIED_SITES 是 CSV 起源的 4 站；本层是后续按需新增的常用站，
// 不计入 SITE_STATS（保持 226/4 不变），只并入能力表供 API 通道使用。
// 红线依旧：每条动作都来自实测匿名可达的公开端点，绝不编造选择器或盗用 Cookie。
export const DEEP_ADAPTED_SITES = Object.freeze({
  "tencent.com": Object.freeze({
    verified: true,
    category: "金融/投资",
    actions: Object.freeze({
      read_quote: { channel: "api", endpoint: "qt.gtimg.cn/q=", verify: "返回名称/代码/当前价（GBK 波浪号分隔）" },
    }),
    fallback: "vision",
    note: "腾讯财经 qt.gtimg.cn 行情，匿名 200 / GBK，2026-11-07 实测",
  }),
  "sina.com.cn": Object.freeze({
    verified: true,
    category: "金融/投资",
    actions: Object.freeze({
      read_quote: { channel: "api", endpoint: "hq.sinajs.cn/list=", verify: "返回名称/今开/昨收/当前价（GBK 逗号分隔，需 Referer）" },
    }),
    fallback: "vision",
    note: "新浪财经 hq.sinajs.cn 行情，匿名须带 Referer 否则 403 / GBK，2026-11-07 实测",
  }),
  "github.com": Object.freeze({
    verified: true,
    category: "工具/AI/技术",
    actions: Object.freeze({
      search_repo: { channel: "api", endpoint: "api.github.com/search/repositories", verify: "返回 items[] 仓库列表" },
      get_user: { channel: "api", endpoint: "api.github.com/users", verify: "返回登录名/主页等用户资料" },
    }),
    fallback: "vision",
    note: "GitHub 公开 API，匿名可达（限频 60/h），需 User-Agent，2026-11-07 实测",
  }),
  "open-meteo.com": Object.freeze({
    verified: true,
    category: "工具/AI/技术",
    actions: Object.freeze({
      get_weather: { channel: "api", endpoint: "api.open-meteo.com/v1/forecast", verify: "返回 current.temperature_2m 等天气" },
    }),
    fallback: "vision",
    note: "Open-Meteo 天气 API，免 key 匿名可达，2026-11-07 实测",
  }),
  "douban.com": Object.freeze({
    verified: true,
    category: "影音/社区",
    actions: Object.freeze({
      search: { channel: "url", pattern: "https://www.douban.com/search?q={kw}", verify: "结果列表 DOM 就绪" },
      extract_page: { channel: "extract", verify: "页面结构化字段（JSON-LD/meta/表格）回读非空" },
    }),
    fallback: "vision",
    note: "豆瓣 JSON API 被反爬 403，改用 L1 页面内通用抽取（零外发）；搜索走 url，2026-11-07 实测",
  }),
});

// 品类判定规则：顺序敏感，首个命中胜出；与 analyze_top226.py 的 CATS 逐条一致。
const CAT_RULES = [
  ["政府/机构", [/\.gov(\.cn)?$/, /gov\.cn/, /gov\./, /state\.gov/, /service\.gov/, /chsi/, /nsfc/, /nasa/, /tax/, /mps\./, /cnipa/, /whitehouse/, /who\.int/, /courts/, /jcrb/, /supremecourt/, /ndrc/, /miit/, /samr/, /moe\./, /edu\.cn/]],
  ["教育/高校", [/\.edu(\.cn)?$/, /tsinghua/, /pku/, /sjtu/, /zju/, /fudan/, /ruc/, /sysu/, /hit\./, /buaa/, /nju/, /whu/, /neu/, /hust/, /scut/, /bnu/, /ustc/, /duke/, /mit\.edu/, /cambridge/, /neea/, /cuhk/, /bupt/, /lzu/, /jlu/, /xjtu/, /tju/, /ouc/, /scu/, /sdu/, /nwpu/, /cqu/, /seu/, /bit/, /tongji/, /hkust/, /cuhk/]],
  ["金融/投资", [/eastmoney/, /binance/, /huobi/, /okx/, /coin/, /jr/, /bank/, /fund/, /stock/, /finance/, /tenpay/, /alipay/, /cmb/, /icbc/, /ccb/, /abc\./, /xueqiu/, /licai/, /investing/, /jrj/, /cnstock/, /sina.*finance/, /10jqka/, /futu/, /tiger/, /jr/, /insurance/, /pa18/, /pingan/, /cf/, /vipshop.*fin/, /wealth/]],
  ["电商/购物", [/taobao/, /tmall/, /jd/, /1688/, /alibaba/, /aliexpress/, /amazon/, /ebay/, /etsy/, /pinduoduo/, /made-in-china/, /wish/, /shop/, /mall/, /cainiao/, /sf\./, /vip\./, /dangdang/, /suning/, /kaola/, /gome/, /pdd/, /jd\./, /dianping/, /meituan/, /ele/, /cainiao/, /seller/, /store/, /smzdm/, /jd/]],
  ["影音/媒体", [/bilibili/, /youku/, /iqiyi/, /douyin/, /kuaishou/, /tiktok/, /youtube/, /twitch/, /netflix/, /spotify/, /acfun/, /mgtv/, /weibo/, /cntv/, /cctv/, /imdb/, /music/, /video/, /tv\./, /live/, /stream/, /mango/, /wasu/, /qq\.com/, /tencent/, /maoyan/, /douban/, /yinyuetai/, /kugou/, /kuwo/, /biligame/]],
  ["社区/社交", [/weibo/, /xiaohongshu/, /douban/, /zhihu/, /tieba/, /reddit/, /facebook/, /instagram/, /x\.com/, /pinterest/, /telegram/, /discord/, /twitter/, /linkedin/, /t\.me/, /quora/, /tumblr/, /vk\./, /line\./, /wechat/, /douyin/, /kuaishou/, /tianya/, /coolapk/, /nga/, /hupu/, /gov\.cn/]],
  ["搜索/门户/新闻", [/baidu/, /bing/, /sogou/, /so\.com/, /360/, /hao123/, /sina/, /sohu/, /netease/, /xinhua/, /people/, /ifeng/, /news/, /nytimes/, /bbc/, /thepaper/, /yahoo/, /163\.com/, /qq\.com/, /yangtse/, /cnr/, /cctv/, /china\.com/, /hexun/, /finance\.sina/, /stnn/, /zaobao/]],
  ["工具/AI/技术", [/github/, /gitlab/, /csdn/, /stackoverflow/, /npm/, /docker/, /maven/, /oracle/, /microsoft/, /aws/, /aliyun/, /cloud/, /openai/, /deepseek/, /chatgpt/, /kimi/, /doubao/, /qwen/, /huggingface/, /kaggle/, /arxiv/, /ieee/, /mozilla/, /chrome/, /developer/, /apple/, /wiley/, /springer/, /sciencedirect/, /nature/, /mdpi/, /tandfonline/, /researchgate/, /office/, /wikipedia/, /cloudflare/, /cloudfront/, /dingtalk/, /feishu/, /huawei/, /mi\.com/, /lenovo/, /intel/, /nvidia/, /amd/, /ibm/, /sap/, /adobe/, /figma/, /notion/, /atlassian/, /jira/, /zoom/, /slack/]],
  ["旅游/出行", [/ctrip/, /trip\.com/, /qunar/, /fliggy/, /ly\.com/, /mafengwo/, /cathay/, /air/, /rail/, /12306/, /amap/, /gaode/, /ditu/, /uber/, /didi/, /meituan/]],
  ["国际通用", [/google/, /youtube/, /facebook/, /amazon/, /apple/, /microsoft/, /wikipedia/, /yahoo/, /pinterest/, /instagram/, /linkedin/, /x\.com/, /whatsapp/, /paypal/, /netflix/, /spotify/, /reddit/, /ebay/, /twitch/, /imdb/, /bbc/, /nytimes/, /naver/, /pornhub/, /xhamster/, /pixabay/, /patreon/, /deviantart/, /fc2/, /t\.me/, /telegram/, /discord/, /vk\./, /duckduckgo/, /proton/, /signal/]],
  ["成人/无关", [/pornhub/, /xhamster/, /porn/, /xvideos/, /xnxx/, /onlyfans/, /sex/]],
];

export const SITE_ENTRIES = Object.freeze([
  {
    "rank": 1,
    "domain": "google.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 2,
    "domain": "apple.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 3,
    "domain": "facebook.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 4,
    "domain": "qq.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 5,
    "domain": "microsoft.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 6,
    "domain": "wikipedia.org",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 7,
    "domain": "baidu.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 8,
    "domain": "tiktok.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 9,
    "domain": "youtube.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 10,
    "domain": "amazon.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 11,
    "domain": "yahoo.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 12,
    "domain": "pinterest.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 13,
    "domain": "nih.gov",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 14,
    "domain": "github.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 15,
    "domain": "instagram.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 16,
    "domain": "linkedin.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 17,
    "domain": "x.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 18,
    "domain": "aliyun.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 19,
    "domain": "bilibili.com",
    "category": "影音/媒体",
    "tier": "deep",
    "verified": true,
    "channel": "verified",
    "note": "已核实站点，保留来自 p2SiteAdapter.SITE_CAPABILITIES 的真实 api/dom/url 动作"
  },
  {
    "rank": 20,
    "domain": "taobao.com",
    "category": "电商/购物",
    "tier": "deep",
    "verified": true,
    "channel": "verified",
    "note": "已核实站点，保留来自 p2SiteAdapter.SITE_CAPABILITIES 的真实 api/dom/url 动作"
  },
  {
    "rank": 21,
    "domain": "163.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 22,
    "domain": "whatsapp.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 23,
    "domain": "cloudfront.net",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 24,
    "domain": "weibo.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 25,
    "domain": "shopify.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 26,
    "domain": "alibaba.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 27,
    "domain": "live.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 28,
    "domain": "reddit.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 29,
    "domain": "jd.com",
    "category": "电商/购物",
    "tier": "deep",
    "verified": true,
    "channel": "verified",
    "note": "已核实站点，保留来自 p2SiteAdapter.SITE_CAPABILITIES 的真实 api/dom/url 动作"
  },
  {
    "rank": 30,
    "domain": "nytimes.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 31,
    "domain": "t.me",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 32,
    "domain": "nature.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 33,
    "domain": "archive.org",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 34,
    "domain": "openai.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 35,
    "domain": "tencent.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 36,
    "domain": "naver.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 37,
    "domain": "bing.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 38,
    "domain": "wiley.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 39,
    "domain": "feishu.cn",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 40,
    "domain": "office.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 41,
    "domain": "cloud.microsoft",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 42,
    "domain": "sciencedirect.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 43,
    "domain": "discord.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 44,
    "domain": "huawei.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 45,
    "domain": "yahoo.co.jp",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 46,
    "domain": "kuaishou.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 47,
    "domain": "paypal.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 48,
    "domain": "xiaohongshu.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 49,
    "domain": "1688.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 50,
    "domain": "bbc.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 51,
    "domain": "cloudflare.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 52,
    "domain": "douyin.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 53,
    "domain": "researchgate.net",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 54,
    "domain": "springer.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 55,
    "domain": "ebay.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 56,
    "domain": "telegram.org",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 57,
    "domain": "mdpi.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 58,
    "domain": "douban.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 59,
    "domain": "twitch.tv",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 60,
    "domain": "tsinghua.edu.cn",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 61,
    "domain": "chatgpt.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 62,
    "domain": "imdb.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 63,
    "domain": "tandfonline.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 64,
    "domain": "arxiv.org",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 65,
    "domain": "ieee.org",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 66,
    "domain": "mi.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 67,
    "domain": "aliexpress.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 68,
    "domain": "steampowered.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 69,
    "domain": "alibaba-inc.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 70,
    "domain": "amazon.co.uk",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 71,
    "domain": "etsy.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 72,
    "domain": "pku.edu.cn",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 73,
    "domain": "cambridge.org",
    "category": "教育/高校",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 74,
    "domain": "ctrip.com",
    "category": "旅游/出行",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 75,
    "domain": "sjtu.edu.cn",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 76,
    "domain": "deepseek.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 77,
    "domain": "eastmoney.com",
    "category": "金融/投资",
    "tier": "deep",
    "verified": true,
    "channel": "verified",
    "note": "已核实站点，保留来自 p2SiteAdapter.SITE_CAPABILITIES 的真实 api/dom/url 动作"
  },
  {
    "rank": 78,
    "domain": "binance.com",
    "category": "金融/投资",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 79,
    "domain": "cctv.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 80,
    "domain": "csdn.net",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 81,
    "domain": "fc2.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 82,
    "domain": "pornhub.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 83,
    "domain": "pixabay.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 84,
    "domain": "state.gov",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 85,
    "domain": "service.gov.uk",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 86,
    "domain": "sohu.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 87,
    "domain": "amazon.de",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 88,
    "domain": "netease.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 89,
    "domain": "springernature.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 90,
    "domain": "tmall.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 91,
    "domain": "netflix.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 92,
    "domain": "scribd.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 93,
    "domain": "chsi.com.cn",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 94,
    "domain": "google.com.hk",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 95,
    "domain": "xhamster.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 96,
    "domain": "made-in-china.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 97,
    "domain": "trip.com",
    "category": "旅游/出行",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 98,
    "domain": "patreon.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 99,
    "domain": "deviantart.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 100,
    "domain": "amazon.co.jp",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 101,
    "domain": "dingtalk.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 102,
    "domain": "orcid.org",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 103,
    "domain": "temu.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 104,
    "domain": "instructure.com",
    "category": "教育/高校",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 105,
    "domain": "huggingface.co",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 106,
    "domain": "toutiao.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 107,
    "domain": "threads.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 108,
    "domain": "xiaomi.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 109,
    "domain": "so.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 110,
    "domain": "yandex.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 111,
    "domain": "cnki.net",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 112,
    "domain": "nintendo.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 113,
    "domain": "woa.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 114,
    "domain": "huijiwiki.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 115,
    "domain": "chaoxing.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 116,
    "domain": "tradingview.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 117,
    "domain": "claude.ai",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 118,
    "domain": "duke.edu",
    "category": "教育/高校",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 119,
    "domain": "mioffice.cn",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 120,
    "domain": "bytedance.net",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 121,
    "domain": "steamcommunity.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 122,
    "domain": "itch.io",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 123,
    "domain": "duckduckgo.com",
    "category": "国际通用",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 124,
    "domain": "cuhk.edu.hk",
    "category": "教育/高校",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 125,
    "domain": "pixiv.net",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 126,
    "domain": "dmm.co.jp",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 127,
    "domain": "hupu.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 128,
    "domain": "sankuai.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 129,
    "domain": "ozon.ru",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 130,
    "domain": "ups.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 131,
    "domain": "amazon.fr",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 132,
    "domain": "bytedance.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 133,
    "domain": "volcengine.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 134,
    "domain": "shein.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 135,
    "domain": "gitee.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 136,
    "domain": "cityu.edu.hk",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 137,
    "domain": "amazon.ca",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 138,
    "domain": "jinritemai.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 139,
    "domain": "weather.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 140,
    "domain": "notion.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 141,
    "domain": "neea.edu.cn",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 142,
    "domain": "xvideos.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 143,
    "domain": "figma.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 144,
    "domain": "deepl.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 145,
    "domain": "51job.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 146,
    "domain": "sogou.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 147,
    "domain": "polyu.edu.hk",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 148,
    "domain": "3dmgame.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 149,
    "domain": "apple.com.cn",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 150,
    "domain": "upwork.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 151,
    "domain": "fedex.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 152,
    "domain": "mega.nz",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 153,
    "domain": "autohome.com.cn",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 154,
    "domain": "discogs.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 155,
    "domain": "weibo.cn",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 156,
    "domain": "cuhk.edu.cn",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 157,
    "domain": "eporner.com",
    "category": "成人/无关",
    "tier": "skip",
    "verified": false,
    "channel": "no_go",
    "note": "仅品类登记，未核实选择器；成人/无关品类按红线不生成任何动作、不进能力表"
  },
  {
    "rank": 158,
    "domain": "rfi.fr",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 159,
    "domain": "nexusmods.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 160,
    "domain": "liepin.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 161,
    "domain": "artstation.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 162,
    "domain": "larkoffice.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 163,
    "domain": "vkvideo.ru",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 164,
    "domain": "okx.com",
    "category": "金融/投资",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 165,
    "domain": "roblox.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 166,
    "domain": "cursor.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 167,
    "domain": "booth.pm",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 168,
    "domain": "pinduoduo.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 169,
    "domain": "ollama.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 170,
    "domain": "bigo.sg",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 171,
    "domain": "zhibo8.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 172,
    "domain": "hotjob.cn",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 173,
    "domain": "xunlei.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 174,
    "domain": "coupang.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 175,
    "domain": "apkpure.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 176,
    "domain": "kdocs.cn",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 177,
    "domain": "zotero.org",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 178,
    "domain": "wjx.cn",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 179,
    "domain": "spankbang.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 180,
    "domain": "zhipin.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 181,
    "domain": "agoda.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 182,
    "domain": "overleaf.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 183,
    "domain": "wise.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 184,
    "domain": "uuss.uk",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 185,
    "domain": "etherscan.io",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 186,
    "domain": "yuque.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 187,
    "domain": "kimi.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 188,
    "domain": "12306.cn",
    "category": "旅游/出行",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 189,
    "domain": "dlsite.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 190,
    "domain": "chaturbate.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 191,
    "domain": "bigmodel.cn",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 192,
    "domain": "quark.cn",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 193,
    "domain": "stripchat.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 194,
    "domain": "v2ex.com",
    "category": "社区/社交",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 195,
    "domain": "dhgate.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 196,
    "domain": "10086.cn",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 197,
    "domain": "chess.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 198,
    "domain": "garena.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 199,
    "domain": "onlyfans.com",
    "category": "成人/无关",
    "tier": "skip",
    "verified": false,
    "channel": "no_go",
    "note": "仅品类登记，未核实选择器；成人/无关品类按红线不生成任何动作、不进能力表"
  },
  {
    "rank": 200,
    "domain": "themoviedb.org",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 201,
    "domain": "doubao.com",
    "category": "工具/AI/技术",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 202,
    "domain": "grok.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 203,
    "domain": "erome.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 204,
    "domain": "oceanengine.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 205,
    "domain": "znzmo.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 206,
    "domain": "douyu.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 207,
    "domain": "miguvideo.com",
    "category": "影音/媒体",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 208,
    "domain": "qidian.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 209,
    "domain": "linux.do",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 210,
    "domain": "runoob.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 211,
    "domain": "um.edu.mo",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 212,
    "domain": "juejin.cn",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 213,
    "domain": "openreview.net",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 214,
    "domain": "zcool.com.cn",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 215,
    "domain": "baidu-int.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 216,
    "domain": "huya.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 217,
    "domain": "mercari.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 218,
    "domain": "gate.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 219,
    "domain": "17track.net",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 220,
    "domain": "xueqiu.com",
    "category": "金融/投资",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 221,
    "domain": "opencode.ai",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 222,
    "domain": "jianying.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 223,
    "domain": "nsfc.gov.cn",
    "category": "政府/机构",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 224,
    "domain": "hao123.com",
    "category": "搜索/门户/新闻",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 225,
    "domain": "sis001.com",
    "category": "其他/品牌/长尾",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  },
  {
    "rank": 226,
    "domain": "tiktokshopglobalselling.com",
    "category": "电商/购物",
    "tier": "light",
    "verified": false,
    "channel": "url",
    "note": "仅品类登记，未核实选择器；走 channel:url 通用搜索 URL 模板（A 口径），不猜 DOM 选择器"
  }
]);

export const SITE_STATS = Object.freeze({
  "total": 226,
  "light": 220,
  "deep": 4,
  "skip": 2,
  "verified": 4,
  "deepCandidates": 39,
  "deepVerified": 4,
  "byCategory": {
    "政府/机构": 10,
    "教育/高校": 4,
    "金融/投资": 4,
    "电商/购物": 20,
    "影音/媒体": 18,
    "社区/社交": 15,
    "搜索/门户/新闻": 13,
    "工具/AI/技术": 36,
    "旅游/出行": 3,
    "国际通用": 11,
    "成人/无关": 2,
    "其他/品牌/长尾": 90
  }
});

const SEARCH_PATTERN = "https://www.baidu.com/s?wd={kw}%20site:{domain}";
const LIGHT_VERIFY = "URL 变化 + 页面就绪";
const LIGHT_FALLBACK = "vision";

function normalizeDomain(domain) {
  return String(domain).trim().toLowerCase().replace(/^www\./, "");
}

export function classify(domain = "") {
  const d = String(domain).trim().toLowerCase();
  for (const [name, patterns] of CAT_RULES) {
    for (const re of patterns) {
      if (re.test(d)) return name;
    }
  }
  return CATEGORIES.OTHER;
}

export function lookupSite(domain = "") {
  const key = normalizeDomain(domain);
  if (!key) return null;
  for (const e of SITE_ENTRIES) {
    if (normalizeDomain(e.domain) === key) return e;
  }
  return null;
}

export function buildCapabilityTable() {
  const table = {};
  for (const e of SITE_ENTRIES) {
    if (e.tier === TIERS.SKIP) continue;
    if (e.verified === true && Object.prototype.hasOwnProperty.call(VERIFIED_SITES, e.domain)) {
      table[e.domain] = Object.assign({}, VERIFIED_SITES[e.domain], {
        verified: true,
        note: e.note,
      });
    } else {
      table[e.domain] = {
        category: e.category,
        actions: {
          search: {
            channel: "url",
            pattern: SEARCH_PATTERN,
            verify: LIGHT_VERIFY,
          },
        },
        fallback: LIGHT_FALLBACK,
        verified: false,
        note: e.note,
      };
    }
  }
  // 深度适配层：覆盖到 github/tencent（已在 226 但为 unverified），并补 sina/open-meteo/douban（不在 226）。
  // 合并后这些站点标记为已核实，承接 L2 api / L1 extract 通道。VERIFIED_SITES 与 SITE_STATS 不受影响。
  for (const [domain, def] of Object.entries(DEEP_ADAPTED_SITES)) {
    table[domain] = Object.assign({}, def, {
      verified: true,
      deepAdapted: true,
      note: def.note || "深度适配站点",
    });
  }
  return table;
}

// 红线守卫：任何未核实（verified!==true）条目出现 selector / endpoint / DOM 选择器值即报错。
export function assertNoInventedSelectors(table = {}) {
  const bad = [];
  const forbiddenKeys = ["selector", "endpoint"];
  const cssSelectorValue = /^\s*(?:[.#][A-Za-z_][\w-]*|\[[^\]]+\])/;
  for (const site of Object.keys(table)) {
    const entry = table[site];
    if (!entry || entry.verified === true) continue;
    const actions = entry.actions || {};
    for (const action of Object.keys(actions)) {
      const spec = actions[action];
      if (!spec || typeof spec !== "object") continue;
      for (const key of Object.keys(spec)) {
        if (forbiddenKeys.indexOf(key) !== -1) bad.push(site + "." + action + "." + key);
      }
      for (const val of Object.values(spec)) {
        if (typeof val === "string" && cssSelectorValue.test(val)) {
          bad.push(site + "." + action + ".dom-path");
        }
      }
    }
    for (const key of Object.keys(entry)) {
      if (forbiddenKeys.indexOf(key) !== -1) bad.push(site + "." + key);
    }
  }
  return { ok: bad.length === 0, bad: bad };
}
