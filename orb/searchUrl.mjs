/* 开窗原语：把用户输入规范化为可安全交给系统浏览器打开的 http(s) URL。
   纯函数、零依赖、零 IO。主进程的 open-external 协议闸只放行 http/https，
   因此本层必须先拦掉 javascript:/file:/smb: 等协议，以及重复编码过的 URL。 */

export const SEARCH_MAX_LEN = 512;

// 允许交给系统浏览器的协议白名单。
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// 已带协议的输入：交给 URL 解析器自行裁决协议。
// 冒号后紧跟数字时视为裸域名加端口，仍补 https://，避免误伤本地服务地址。
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:(?!\d)/;

// 双重编码痕迹：%25 后紧跟两位十六进制（如 %2520、%25E4），说明百分号又被编码了一轮。
// 单独的字面百分号 %25（query 含 "%" 时 encodeURIComponent 的产物）不算，必须放行。
const ENCODED_PERCENT_RE = /%25[0-9a-fA-F]{2}/i;
// 解码一次后仍残留的 %XX 编码，作为重复编码的纵深判定。
const LEFT_ENCODE_RE = /%[0-9a-fA-F]{2}/;

// 搜索引擎前缀表。用 Map 而非普通对象，避免 toString 之类的原型键被误命中。
//
// 为什么要有国内项：这台机器的实际网络环境是中国大陆，google.com 与 duckduckgo.com
// 通常不可达，用它们做默认引擎的表现就是「浏览器打开了，但停在空白页/地址栏」，
// 看着像我们把搜索做坏了。bing 也要走 cn 域名才稳（www.bing.com 会被重定向甚至超时）。
// 默认仍是 bing（保持既有行为与单测不变），需要换引擎时由调用方传 engine 名。
const SEARCH_ENGINES = new Map([
  ["bing", "https://www.bing.com/search?q="],
  ["bing-cn", "https://cn.bing.com/search?q="],
  ["baidu", "https://www.baidu.com/s?wd="],
  ["sogou", "https://www.sogou.com/web?query="],
  ["so360", "https://www.so.com/s?q="],
  ["google", "https://www.google.com/search?q="],
  ["duckduckgo", "https://duckduckgo.com/?q="],
]);

/* 供调用方做「按环境选引擎」的白名单校验：未知名字一律回退到 fallback。 */
export const SEARCH_ENGINE_NAMES = Object.freeze([...SEARCH_ENGINES.keys()]);
export function isKnownEngine(name) {
  return typeof name === "string" && SEARCH_ENGINES.has(name);
}

function fail(reason) {
  return { ok: false, url: "", reason };
}

function hasDoubleEncoding(text) {
  // 第一层：%25 后紧跟两位十六进制（例如 %2520），几乎必然是编码过两次。
  if (ENCODED_PERCENT_RE.test(text)) return true;

  // 第二层：解码一次后仍含 %XX 残留，同样说明输入被重复编码。
  let decoded;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // 非法百分号序列（如 %ZZ、孤立 %）会让 decodeURIComponent 抛 URIError；
    // 这里只吞掉异常并跳过该层判定，后续仍由 new URL 做解析校验。
    return false;
  }
  return LEFT_ENCODE_RE.test(decoded);
}

export function searchUrl(raw, opts = {}) {
  // opts 是预留的扩展入口，当前不参与校验，仅为保持接线接口稳定。
  if (raw === null || raw === undefined) return fail("empty");

  const text = String(raw).trim();
  if (text === "") return fail("empty");
  if (text.length > SEARCH_MAX_LEN) return fail("too-long");
  if (hasDoubleEncoding(text)) return fail("double-encoding");

  // 不带协议的裸域名 / 裸路径补 https://；带协议的原样交给解析器。
  const candidate = SCHEME_RE.test(text) ? text : "https://" + text;

  let u;
  try {
    u = new URL(candidate);
  } catch {
    return fail("bad-url");
  }
  if (!ALLOWED_PROTOCOLS.has(u.protocol)) return fail("bad-protocol");

  // 返回规范化后的 href（保留 query、hash）；把该 url 再喂一次结果不变。
  return { ok: true, url: u.href, reason: "" };
}

export function searchEngineUrl(query, engine = "bing") {
  const q = query === null || query === undefined ? "" : String(query).trim();
  if (q === "") return fail("empty");
  if (q.length > SEARCH_MAX_LEN) return fail("too-long");

  const base = SEARCH_ENGINES.get(engine);
  if (base === undefined) return fail("bad-engine");

  // 只做一次标准编码；字面百分号会变成 %25，但不含「%25 + 两位十六进制」，
  // 因此仍可被 searchUrl 再次校验通过。
  return { ok: true, url: base + encodeURIComponent(q), reason: "" };
}
