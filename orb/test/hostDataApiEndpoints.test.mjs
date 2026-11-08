/* 端点层的解析规则：分块解包、上游业务码、参数白名单。
 * 全部用注入的 fetchImpl，不真发网络（真站验证另跑一次性的实测脚本）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHostDataApi, API_ENDPOINTS, listEndpoints } from "../hostDataApi.mjs";
import * as iconv from "iconv-lite";

function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  // body 可为字符串或 Buffer；hostDataApi 走 arrayBuffer() 再按声明编码解码
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
  const f = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => buf,
      text: async () => buf.toString("utf8"),
    };
  };
  f.calls = calls;
  return f;
}

const BLOCKED = {
  code: 0,
  data: {
    result: [
      { result_type: "video", data: [{ bvid: "BV1" }] },
      { result_type: "bili_user", data: [{ mid: 42, uname: "罗翔说刑法", fans: 32183019 }] },
    ],
  },
};

test("all/v2 分块返回时只取 bili_user 块（不是把整块数组交出去）", async () => {
  const f = fakeFetch(BLOCKED);
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "bilibili.com", action: "search_uploader", params: { keyword: "罗翔" } });
  assert.equal(r.ok, true);
  assert.equal(Array.isArray(r.data), true);
  assert.equal(r.data.length, 1);
  assert.equal(r.data[0].mid, 42);
  assert.match(f.calls[0].url, /\/x\/web-interface\/search\/all\/v2\?/);
});

test("没有目标块时返回 empty-data，不把空结果冒充成功", async () => {
  const f = fakeFetch({ code: 0, data: { result: [{ result_type: "video", data: [] }] } });
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "bilibili.com", action: "search_uploader", params: { keyword: "x" } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "empty-data");
});

test("HTTP 200 但上游 code=-412（风控）必须当失败，并带上游码", async () => {
  const f = fakeFetch({ code: -412, message: "request was banned", ttl: 1 });
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "bilibili.com", action: "search_uploader", params: { keyword: "x" } });
  assert.equal(r.ok, false);
  assert.equal(r.code, "upstream-code:-412");
});

test("只透传登记过的参数，多余参数不进外发请求", async () => {
  const f = fakeFetch(BLOCKED);
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  await api.fetchSiteData({
    site: "bilibili.com", action: "search_uploader",
    params: { keyword: "罗翔", search_type: "bili_user", page: 9, cookie: "SESSDATA=leak" },
  });
  const u = new URL(f.calls[0].url);
  assert.equal(u.searchParams.get("keyword"), "罗翔");
  assert.equal(u.searchParams.has("search_type"), false);
  assert.equal(u.searchParams.has("cookie"), false);
  assert.equal(u.searchParams.has("page"), false);
});

test("eastmoney 的 data 直取不受分块逻辑影响", async () => {
  const f = fakeFetch({ rc: 0, data: { f43: 3300, f57: "000001" } });
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "eastmoney.com", action: "read_quote", params: { secid: "1.000001" } });
  assert.equal(r.ok, true);
  assert.equal(r.data.f57, "000001");
});

test("未登记站点/动作仍然被拒（白名单没被放宽）", async () => {
  const f = fakeFetch(BLOCKED);
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  for (const req of [
    { site: "weibo.com", action: "hot_search" },
    { site: "bilibili.com", action: "read_quote" },
  ]) {
    const r = await api.fetchSiteData(req);
    assert.equal(r.ok, false);
    assert.equal(r.code, "endpoint-not-allowlisted");
  }
  assert.equal(f.calls.length, 0);
});

test("端点自带人话名，界面不必手写站点名", () => {
  const list = listEndpoints();
  assert.equal(list.length, Object.keys(API_ENDPOINTS).length);
  for (const e of list) {
    assert.equal(typeof e.key, "string");
    assert.ok(e.label && e.label.length > 1, e.key + " 缺少 label");
  }
});

// —— L2 深度适配新增端点的解析路径（端点清单来自 api-endpoints.json，已真机探针核实形状） ——

test("腾讯财经 GBK 波浪号文本：抽取 name/code/price/volume 并数值化", async () => {
  // 真实 GBK 字节解码已由真机探针验证；此处以 ASCII 结构复刻「抽取/字段映射/数值化」逻辑
  const buf = Buffer.from('v_sh600519="1~Moutai~600519~1453.00~1452.00~1450.00~42848~23139~19709~1452.00"');
  const f = fakeFetch(buf);
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "tencent.com", action: "read_quote", params: { code: "sh600519" } });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, "Moutai");
  assert.equal(r.data.code, "600519");
  assert.equal(r.data.price, 1453.00);
  assert.equal(r.data.volume, 42848);
  assert.equal(typeof r.data.price, "number");
});

test("新浪财经 GBK 逗号文本：需 Referer 头，抽取 open/prevClose/price/volume", async () => {
  const buf = Buffer.from('hq_str_sh600519="Moutai,1450.000,1452.000,1453.000,1457.720,1436.000,1452.000,1453.000,4284772,6199528289.000"');
  const f = fakeFetch(buf);
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "sina.com.cn", action: "read_quote", params: { code: "sh600519" } });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, "Moutai");
  assert.equal(r.data.open, 1450);
  assert.equal(r.data.prevClose, 1452);
  assert.equal(r.data.price, 1453);
  assert.equal(r.data.volume, 4284772);
  // 验证请求确实带上了 Referer（否则真实环境会 403）
  assert.equal(f.calls[0].init.headers.Referer, "https://finance.sina.com.cn");
});

test("GitHub 搜索仓库：JSON pick=items 返回数组", async () => {
  const f = fakeFetch({ total_count: 2, incomplete_results: false, items: [{ name: "react", full_name: "react/react" }, { name: "vue", full_name: "vuejs/vue" }] });
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "github.com", action: "search_repo", params: { kw: "react", n: 2 } });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.data));
  assert.equal(r.data.length, 2);
  assert.equal(r.data[0].name, "react");
  // GitHub 必须带 User-Agent（否则真实环境 403）
  assert.ok(/orb-host/.test(f.calls[0].init.headers["User-Agent"]));
});

test("GitHub 取用户：pick 空串返回整棵 JSON（根对象）", async () => {
  const f = fakeFetch({ login: "torvalds", id: 1024025, html_url: "https://github.com/torvalds" });
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "github.com", action: "get_user", params: { user: "torvalds" } });
  assert.equal(r.ok, true);
  assert.equal(r.data.login, "torvalds");
  assert.equal(r.data.id, 1024025);
});

test("Open-Meteo 天气：JSON pick=current 返回温度与风速", async () => {
  const f = fakeFetch({ latitude: 39.89, longitude: 116.35, current: { time: "2026-11-07T23:15", temperature_2m: 1.3, wind_speed_10m: 11.3 } });
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "open-meteo.com", action: "get_weather", params: { lat: 39.9, lon: 116.4 } });
  assert.equal(r.ok, true);
  assert.equal(r.data.temperature_2m, 1.3);
  assert.equal(r.data.wind_speed_10m, 11.3);
  // Open-Meteo 不需要特殊头，走默认 UA
  assert.ok(typeof f.calls[0].init.headers["User-Agent"] === "string");
});

test("未登记动作（open-meteo/read_quote 不存在）仍被拒，零调用", async () => {
  const f = fakeFetch({});
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "open-meteo.com", action: "read_quote", params: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, "endpoint-not-allowlisted");
  assert.equal(f.calls.length, 0);
});

// —— 真实 GBK 字节回归：之前的用例用 ASCII 蒙混过关，真机是 GBK 中文，必须用真实字节证明解码+抽取不串味 ——

test("腾讯财经：真实 GBK 字节（贵州茅台）→ 中文名正确解码且数值化", async () => {
  const raw = 'v_sh600519="1~贵州茅台~600519~1453.00~1452.00~1450.00~42848~23139~19709~1452.00"';
  const buf = iconv.encode(raw, "gbk"); // 真实 GBK 编码字节，而非 ASCII
  const f = fakeFetch(buf);
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "tencent.com", action: "read_quote", params: { code: "sh600519" } });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, "贵州茅台"); // 关键：中文不能是乱码/null
  assert.equal(r.data.code, "600519");
  assert.equal(r.data.price, 1453);
  assert.equal(r.data.volume, 42848);
  assert.equal(typeof r.data.price, "number");
});

test("新浪财经：真实 GBK 字节（贵州茅台）→ 中文名正确解码且带 Referer", async () => {
  const raw = 'hq_str_sh600519="贵州茅台,1450.000,1452.000,1453.000,1457.720,1436.000,1452.000,1453.000,4284772,6199528289.000"';
  const buf = iconv.encode(raw, "gbk");
  const f = fakeFetch(buf);
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "sina.com.cn", action: "read_quote", params: { code: "sh600519" } });
  assert.equal(r.ok, true);
  assert.equal(r.data.name, "贵州茅台");
  assert.equal(r.data.price, 1453);
  assert.equal(r.data.volume, 4284772);
  assert.equal(f.calls[0].init.headers.Referer, "https://finance.sina.com.cn");
});

test("模板占位符缺失时失败关闭（missing-param），不拿脏 URL 发请求", async () => {
  const f = fakeFetch("");
  const api = createHostDataApi({ enabled: true, fetchImpl: f });
  const r = await api.fetchSiteData({ site: "tencent.com", action: "read_quote", params: {} }); // 没给 code
  assert.equal(r.ok, false);
  assert.equal(r.code, "missing-param");
  assert.equal(f.calls.length, 0);
});

