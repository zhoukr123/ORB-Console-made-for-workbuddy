/* 批次C · 外部检索 provider 适配器注册表（2026-11-06；2026-11-06 晚扩展）。
 *
 * 目的：让用户拿到的「用途明确、自己申请」的 key 能直接接进来，
 * 而不必碰本机 dsh 凭据库里那把账号平台签发的 key。
 *
 * 设计：
 *   · 每个 adapter 只负责两件事：把统一 query 翻成厂商请求体、把厂商响应翻成
 *     统一的 {title,url,snippet,source}[]。编排层 / L4 / 文本闸门 / 产物登记零改动。
 *   · 凭据统一由调用方注入（ORB_SEARCH_API_KEY），adapter 不读环境、不读文件、
 *     不持有任何 key，也不把 key 放进返回值。
 *   · anonymous=true 的 adapter 允许无 key：不填 Key 时完全省略 Authorization 头，
 *     走服务商的匿名免费额度（其余 adapter 无 key 仍一律 no-credential 降级）。
 *   · verified 字段如实标注证据强度：官方文档形状已核对 ≠ 真实调用已实测。
 *     未经实测的 adapter 一律保持默认关闭，不许对外宣称「可用」。
 *
 * 形状来源：
 *   · anysearch：anysearch.com/docs/api-endpoints/v1-search、/docs/quick-start
 *               POST /v1/search，{query,max_results(1-10)} → data.results[]，
 *               官方明确「API key optional（匿名按 IP 限速）」。
 *               额度：用户 2026-11-06 复核指出「2000 次/天」只对教育 / 学生档成立，
 *               普通档约 1000 次/天且档位会变 —— 故**不写死任何数字**，一律以控制台为准。
 *               **形状核过官方文档，但未真实调用。**
 *   · deepseek：orb/searchProvider.mjs 既有实现，报告 §11；本次不改默认行为
 *   · zhipu   ：docs.bigmodel.cn/api-reference/工具-api/网络搜索
 *   · baidu   ：aca.bce.baidu.com/doc/qianfan/s/2mh4su4uy（百度搜索 web_search）
 *               + cloud.baidu.com/doc/qianfan/s/1mh4sv6c4（百度搜索计费）
 *               + cloud.baidu.com/doc/qianfan/s/8miy9o4o6（智能搜索生成高性能版计费）
 *               50 次/天与 100 次/天不是口径冲突，是两条产品线各自独立的赠送额度：
 *               「百度搜索」web_search（ORB 用这条）1500 次/月按天发≈50 次/天、¥0.036/次；
 *               「智能搜索生成高性能版」（搜索+大模型总结，ORB 不用）100 次/天、¥0.06/次。
 *               控制台需先「开通后付费 / 专享资源」才能正常调用，免费资源默认优先抵扣。
 *   · custom  ：用户自行填名称 + 端点，无官方形状保证；请求体用最通用的
 *               {query,max_results}，响应兼容四种常见壳，形状不匹配一律返回空数组。
 */
export const DEFAULT_ADAPTER_ID = "deepseek";

function str(v) {
  return typeof v === "string" ? v : (v == null ? "" : String(v));
}

function arrayOf(v) {
  return Array.isArray(v) ? v : [];
}

function bearerHeaders(key) {
  return {
    "Authorization": "Bearer " + str(key),
    "Content-Type": "application/json",
  };
}

/* 免 Key 匿名档：key 为空时**完全省略** Authorization 头（AnySearch 官方口径），
   不是发一个空的 Bearer —— 后者会被判成无效 key 而 401。 */
function optionalBearerHeaders(key) {
  const h = { "Content-Type": "application/json" };
  const k = str(key).trim();
  if (k) h.Authorization = "Bearer " + k;
  return h;
}

/* 统一的 four-field 投影：缺字段一律落空串，由下游 URL 协议闸与文本闸门再判。 */
function project(item, map) {
  if (!item || typeof item !== "object") return null;
  return {
    title: str(item[map.title]),
    url: str(item[map.url]),
    snippet: str(item[map.snippet]),
    source: str(item[map.source]),
  };
}

/* 自定义档用：兼容四种最常见的响应壳，只投影真实存在的字段，绝不编造结果。 */
function genericRows(payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (p.code != null && Number(p.code) !== 0) return [];
  const d = p.data && typeof p.data === "object" ? p.data : {};
  for (const list of [arrayOf(d.results), arrayOf(p.results), arrayOf(p.references), arrayOf(p.search_result)]) {
    if (list.length) return list;
  }
  return [];
}

export const ADAPTERS = Object.freeze({
  /* 第一位：AnySearch。官方 API key 可选（不填则匿名调用、按 IP 限速）。
     额度和档位挂在账号上、会随档位变（教育/学生档与普通档不同），
     所以这里既不写数字也不做承诺，面板上同样不展示这类宣传语。 */
  anysearch: Object.freeze({
    id: "anysearch",
    label: "AnySearch",
    endpoint: "https://api.anysearch.com/v1/search",
    docs: "https://www.anysearch.com/docs/api-endpoints/v1-search",
    quotaNote: "额度、档位与限速以 AnySearch 控制台实际显示为准（不同档位/账号不同，本仓库不写死数字）；官方写明 API key 可选，不填则匿名调用、按 IP 限速。2026-11-06 匿名档实测：主进程测试 2248ms、桥侧 1613ms，均返回 3 条",
    verified: "live-verified",
    anonymous: true,
    headers: optionalBearerHeaders,
    buildBody(query, count) {
      /* 官方 Range: 1–10，超了会被 400；不悄悄放大。 */
      return { query, max_results: Math.min(10, Math.max(1, count)) };
    },
    parse(payload) {
      const p = payload && typeof payload === "object" ? payload : {};
      if (p.code != null && Number(p.code) !== 0) return [];
      const d = p.data && typeof p.data === "object" ? p.data : {};
      return arrayOf(d.results)
        .map((x) => (x && typeof x === "object"
          ? {
            title: str(x.title),
            url: str(x.url),
            snippet: str(x.snippet) || str(x.content),
            /* 响应没有 source 字段：留空让下游 hostOf(url) 兜底，不伪造来源名。 */
            source: "",
          }
          : null))
        .filter(Boolean);
    },
  }),

  /* 既有实现，保持完全向后兼容（19 条 provider 单测依赖这个形状）。 */
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek 官方 Search",
    endpoint: "https://api.deepseek.com/v1/tools/search",
    docs: "报告 §11；orb/searchProvider.mjs 既有实现",
    quotaNote: "¥5/千次成功请求（报告 §11 口径，未实测）",
    verified: "existing-code",
    headers: bearerHeaders,
    buildBody(query, count) {
      return { query, count, need_content: false };
    },
    parse(payload) {
      const p = payload && typeof payload === "object" ? payload : {};
      return arrayOf(p.results)
        .map((x) => (x && typeof x === "object"
          ? {
            title: str(x.title),
            url: str(x.url),
            /* 既有 provider 支持 snippet 缺失时回落 summary，这里保持兼容。 */
            snippet: str(x.snippet) || str(x.summary),
            source: str(x.source),
          }
          : null))
        .filter(Boolean);
    },
  }),

  /* 智谱 Web Search API：直接给结构化 search_result[]，形状最干净。 */
  zhipu: Object.freeze({
    id: "zhipu",
    label: "智谱 Web Search（search_std）",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/web_search",
    docs: "https://docs.bigmodel.cn/api-reference/%E5%B7%A5%E5%85%B7-api/%E7%BD%91%E7%BB%9C%E6%90%9C%E7%B4%A2",
    quotaNote: "search_std 约 ¥0.01/次（公开资料 2026-11-06，以官网为准）",
    verified: "docs-only",
    headers: bearerHeaders,
    buildBody(query, count, model) {
      return {
        search_query: query,
        /* 留空回落 search_std：既有 provider 单测的默认形状一字不改。 */
        search_engine: str(model).trim() || "search_std",
        search_intent: false,
        count,
        content_size: "medium",
      };
    },
    parse(payload) {
      const p = payload && typeof payload === "object" ? payload : {};
      return arrayOf(p.search_result)
        .map((x) => project(x, { title: "title", url: "link", snippet: "content", source: "media" }))
        .filter(Boolean);
    },
  }),

  /* 百度千帆「百度搜索」纯检索端点（2026-11-06 复核后修正）。
     原接的是 /v2/ai_search/chat/completions（智能搜索生成）：那个接口传 model 才做
     总结、不传才是百度搜索，但响应仍是 chat 形状（choices/usage），且官方价格页
     明确写「智能搜索生成需额外支付大模型调用费用」。用户核实发现千帆免费模型已于
     2026-07-28 全部停服，为杜绝「得先挑一个免费模型」的误解，改用专用
     /v2/ai_search/web_search：请求参数里根本没有 model，响应只有 references[]，
     协议层面就不可能产生模型费用。
     免费额度按官方文档已澄清：本端点（百度搜索）1500 次/月≈50 次/天、¥0.036/次；
     另一个产品「智能搜索生成高性能版」才是 100 次/天、¥0.06/次，ORB 不调用它。
     两条产品线额度池独立；控制台需先开通后付费/专享资源才可调用，免费资源默认优先抵扣。 */
  baidu: Object.freeze({
    id: "baidu",
    label: "百度千帆 · 百度搜索（纯检索）",
    endpoint: "https://qianfan.baidubce.com/v2/ai_search/web_search",
    docs: "https://aca.bce.baidu.com/doc/qianfan/s/2mh4su4uy",
    quotaNote: "¥0.036/次；百度搜索 web_search 每月免费 1500 次（按天发放约 50 次/天）、3 QPS；须先在控制台开通后付费/专享资源，免费资源优先抵扣，超额按量计费。另『智能搜索生成高性能版』100 次/天、¥0.06/次属另一产品线，ORB 不调用。纯检索不调模型，不受免费模型停服影响",
    verified: "docs-only",
    headers: bearerHeaders,
    /* 该端点无 model 项：即使调用方传了第三参也如实忽略，不伪造一个模型名。 */
    buildBody(query, count) {
      return {
        messages: [{ role: "user", content: query }],
        search_source: "baidu_search_v2",
        /* web_search standard 版网页 top_k 上限 50。 */
        resource_type_filter: [{ type: "web", top_k: Math.min(50, Math.max(1, count)) }],
      };
    },
    parse(payload) {
      const p = payload && typeof payload === "object" ? payload : {};
      return arrayOf(p.references)
        .map((x) => (x && typeof x === "object"
          ? {
            title: str(x.title),
            url: str(x.url),
            /* web_search 的 Reference 同时有 snippet 与 content（文档称当前一致）；
               兼容只给 content 的旧形状，优先取 snippet。 */
            snippet: str(x.snippet) || str(x.content),
            source: str(x.website || x.web_anchor),
          }
          : null))
        .filter(Boolean);
    },
  }),

  /* 自定义服务商：名称由用户自由填（不限制），端点必须过 http(s) 协议闸。
     没有官方形状保证 —— 形状对不上就返回空数组，如实降级，绝不编造结果。
     endpoint 默认复用 AnySearch 端点，用户几乎总会覆盖它。 */
  custom: Object.freeze({
    id: "custom",
    label: "自定义服务商（自行填名称与端点）",
    endpoint: "https://api.anysearch.com/v1/search",
    docs: "用户自定义；ORB 不提供官方形状保证",
    quotaNote: "额度、计费、稳定性完全取决于你填的服务商；ORB 不推断、不承诺。未真实调用前不宣称可用",
    verified: "user-supplied",
    anonymous: true,
    headers: optionalBearerHeaders,
    buildBody(query, count) {
      return { query, max_results: Math.min(10, Math.max(1, count)) };
    },
    parse(payload) {
      return genericRows(payload)
        .map((x) => (x && typeof x === "object"
          ? {
            title: str(x.title),
            url: str(x.url || x.link),
            snippet: str(x.snippet) || str(x.content) || str(x.summary),
            source: str(x.source || x.website || x.web_anchor || x.media),
          }
          : null))
        .filter(Boolean);
    },
  }),
});

export const ADAPTER_IDS = Object.freeze(Object.keys(ADAPTERS));

export function getAdapter(id) {
  const k = str(id).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ADAPTERS, k) ? ADAPTERS[k] : null;
}

/** 只读自检：给 /api/search/status 用，绝不返回 key 或可推断凭据的内容。 */
export function listAdapters() {
  return ADAPTER_IDS.map((id) => {
    const a = ADAPTERS[id];
    return {
      id: a.id,
      label: a.label,
      endpoint: a.endpoint,
      docs: a.docs,
      quotaNote: a.quotaNote,
      verified: a.verified,
      anonymous: a.anonymous === true,
    };
  });
}

export default { DEFAULT_ADAPTER_ID, ADAPTERS, ADAPTER_IDS, getAdapter, listAdapters };
