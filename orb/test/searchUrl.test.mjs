/* searchUrl / searchEngineUrl 纯函数单测，无任何文件 IO。 */
import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_MAX_LEN, searchUrl, searchEngineUrl } from "../searchUrl.mjs";

function assertFail(r, reason) {
  assert.deepEqual(r, { ok: false, url: "", reason });
}

test("SEARCH_MAX_LEN 固定为 512", () => {
  assert.equal(SEARCH_MAX_LEN, 512);
});

test("searchUrl：空 / 全空白 / null / undefined 返回 empty", () => {
  for (const raw of ["", "   ", "\t\n  ", null, undefined]) {
    assertFail(searchUrl(raw), "empty");
  }
  // trim 后为空的超长空白仍判 empty，而不是 too-long
  assertFail(searchUrl(" ".repeat(600)), "empty");
});

test("searchUrl：trim 后长度超过 512 返回 too-long，边界 512 放行", () => {
  assertFail(searchUrl("a".repeat(SEARCH_MAX_LEN + 1)), "too-long");
  // 长度检查先于双重编码检查
  assertFail(searchUrl("https://example.com/" + "%25".repeat(300)), "too-long");

  const prefix = "https://example.com/?q=";
  const atLimit = prefix + "a".repeat(SEARCH_MAX_LEN - prefix.length);
  assert.equal(atLimit.length, SEARCH_MAX_LEN);
  assert.equal(searchUrl(atLimit).ok, true);
  // 前后空白不计入长度
  assert.equal(searchUrl("  " + "a".repeat(SEARCH_MAX_LEN) + "  ").ok, true);
});

test("searchUrl：裸域名 / 裸路径自动补 https://", () => {
  assert.equal(searchUrl("example.com").url, "https://example.com/");
  assert.equal(searchUrl("  example.com  ").url, "https://example.com/");
  assert.equal(searchUrl("example.com/path?q=1#frag").url, "https://example.com/path?q=1#frag");
  assert.equal(searchUrl("example.com:8080/x").url, "https://example.com:8080/x");
  assert.equal(searchUrl("localhost:3000/x").url, "https://localhost:3000/x");

  // 纯路径形式也能补协议并放行 http/https
  const bare = searchUrl("/foo/bar");
  assert.equal(bare.ok, true);
  assert.equal(new URL(bare.url).protocol, "https:");
});

test("searchUrl：保留已带协议的 http/https URL 与 query、hash", () => {
  assert.equal(
    searchUrl("https://example.com/a/b?x=1&y=2#frag").url,
    "https://example.com/a/b?x=1&y=2#frag",
  );
  assert.equal(searchUrl("http://example.com").url, "http://example.com/");
  assert.equal(searchUrl("HTTPS://EXAMPLE.COM").url, "https://example.com/");

  // opts 预留参数不影响结果，成功时 reason 为空串
  const r = searchUrl("https://example.com/a?b=1#c", { foo: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.reason, "");
  assert.equal(r.url, "https://example.com/a?b=1#c");
});

test("searchUrl：非 http(s) 协议一律 bad-protocol", () => {
  for (const raw of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<h1>hi</h1>",
    "smb://server/share",
    "ftp://example.com/x",
    "mailto:a@b.com",
    "vbscript:msgbox(1)",
    "chrome://settings",
  ]) {
    assertFail(searchUrl(raw), "bad-protocol");
  }
});

test("searchUrl：无法解析返回 bad-url", () => {
  for (const raw of ["https://", "http://", "https://?q=1", "not a url"]) {
    assertFail(searchUrl(raw), "bad-url");
  }
});

test("searchUrl：拒绝双重编码（已编码百分号与解码残留）", () => {
  for (const raw of [
    "https://example.com/?q=%2520",
    "https://example.com/?q=hello%2520world",
    "https://example.com/%25E4%25B8%25AD",
    "https://example.com/?q=%252F%252Fevil.com",
    "example.com/%2520",
  ]) {
    assertFail(searchUrl(raw), "double-encoding");
  }
});

test("searchUrl：合法单次编码不被误判为双重编码", () => {
  for (const raw of [
    "https://example.com/a%20b",
    "https://www.bing.com/search?q=%E4%B8%AD%E6%96%87",
    "https://example.com/?q=a%2Bb",
    "https://example.com/?q=a%20b&c=d",
  ]) {
    const r = searchUrl(raw);
    assert.equal(r.ok, true, raw);
    assert.equal(r.reason, "");
    assert.equal(r.url, raw);
  }
});

test("searchUrl：非法百分号序列不会让 decodeURIComponent 抛崩", () => {
  for (const raw of [
    "https://example.com/%ZZ",
    "https://example.com/%",
    "https://example.com/abc%",
  ]) {
    assert.doesNotThrow(() => searchUrl(raw));
    assert.notEqual(searchUrl(raw).reason, "double-encoding");
  }
});

test("searchUrl：成功结果幂等，href 再喂一次不变", () => {
  const samples = [
    "example.com",
    "example.com/path?q=1#frag",
    "http://example.com/a?b=1#c",
    "https://example.com/a%20b",
    "https://www.bing.com/search?q=%E4%B8%AD%E6%96%87",
    "localhost:3000/x",
  ];
  for (const raw of samples) {
    const first = searchUrl(raw);
    assert.equal(first.ok, true, raw);
    assert.equal(first.reason, "");
    const second = searchUrl(first.url);
    assert.equal(second.ok, true, raw);
    assert.equal(second.reason, "");
    assert.equal(second.url, first.url, raw);
  }
});

test("searchEngineUrl：默认 bing 与 google / duckduckgo 前缀", () => {
  assert.deepEqual(searchEngineUrl("hello world"), {
    ok: true,
    url: "https://www.bing.com/search?q=hello%20world",
    reason: "",
  });
  assert.equal(
    searchEngineUrl("hello world", "google").url,
    "https://www.google.com/search?q=hello%20world",
  );
  assert.equal(
    searchEngineUrl("hello world", "duckduckgo").url,
    "https://duckduckgo.com/?q=hello%20world",
  );
  assert.equal(
    searchEngineUrl("中文 查询").url,
    "https://www.bing.com/search?q=%E4%B8%AD%E6%96%87%20%E6%9F%A5%E8%AF%A2",
  );
  // 首尾空白按 trim 后参与编码
  assert.equal(searchEngineUrl("  hi  ").url, "https://www.bing.com/search?q=hi");
});

test("searchEngineUrl：空 / 超长 / 未知引擎", () => {
  for (const q of ["", "   ", null, undefined]) {
    assertFail(searchEngineUrl(q), "empty");
  }
  assertFail(searchEngineUrl("a".repeat(SEARCH_MAX_LEN + 1)), "too-long");
  /* baidu 已加入引擎表（国内网络可用），这里改用真正不存在的名字当反例，
     同时保留原型链键与大写变体 —— 那几个必须继续被拒，否则 Map 之外的对象实现会漏。 */
  for (const e of ["yahoo", "yandex", "toString", "constructor", "__proto__", "BING"]) {
    assertFail(searchEngineUrl("hi", e), "bad-engine");
  }
});

/* 国内可达引擎：用户默认网络在中国大陆，google / duckduckgo 打不开，
   这几个必须都能生成合法 URL 且能被 searchUrl 二次校验通过。 */
test("searchEngineUrl：国内引擎（baidu / bing-cn / sogou / so360）", () => {
  const cases = [
    ["baidu", "https://www.baidu.com/s?wd=%E6%B9%96%E5%8D%97%E5%A4%A7%E5%AD%A6"],
    ["bing-cn", "https://cn.bing.com/search?q=%E6%B9%96%E5%8D%97%E5%A4%A7%E5%AD%A6"],
    ["sogou", "https://www.sogou.com/web?query=%E6%B9%96%E5%8D%97%E5%A4%A7%E5%AD%A6"],
    ["so360", "https://www.so.com/s?q=%E6%B9%96%E5%8D%97%E5%A4%A7%E5%AD%A6"],
  ];
  for (const [engine, expectUrl] of cases) {
    const r = searchEngineUrl("湖南大学", engine);
    assert.equal(r.ok, true, engine);
    assert.equal(r.url, expectUrl, engine);
    // 生成结果必须能再过一次 searchUrl 的协议闸
    const re = searchUrl(r.url);
    assert.equal(re.ok, true, engine + " 未通过 searchUrl 校验");
  }
});

test("searchEngineUrl 生成的 url 能被 searchUrl 再次校验通过且保持不变", () => {
  const engines = ["bing", "google", "duckduckgo"];
  const queries = ["hello world", "中文 查询", "orb console", "a+b&c=d"];
  for (const engine of engines) {
    for (const q of queries) {
      const r = searchEngineUrl(q, engine);
      assert.equal(r.ok, true, engine + " / " + q);
      const checked = searchUrl(r.url);
      assert.equal(checked.ok, true, engine + " / " + q);
      assert.equal(checked.reason, "");
      assert.equal(checked.url, r.url, engine + " / " + q);
    }
  }
});

test("searchEngineUrl('100% off','bing') 结果能被 searchUrl 二次校验通过", () => {
  // encodeURIComponent("100% off") === "100%25%20off"：字面 % 会变成 %25，
  // 但 %25 后跟的是 %20 而非两位十六进制，不应被判双重编码。
  const r = searchEngineUrl("100% off", "bing");
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://www.bing.com/search?q=100%25%20off");
  const checked = searchUrl(r.url);
  assert.equal(checked.ok, true, checked.reason);
  assert.equal(checked.reason, "");
  assert.equal(checked.url, r.url);

  // 直接喂含字面 %25 的合法 URL 同样放行
  assert.equal(searchUrl("https://example.com/?q=100%25%20off").ok, true);
  assert.equal(searchUrl("https://example.com/discount%25").ok, true);
});

test("searchUrl：%25 后紧跟两位十六进制仍判双重编码（%2520 不放开）", () => {
  for (const raw of [
    "https://example.com/?q=%2520",
    "https://example.com/?q=hello%2520world",
    "https://www.bing.com/search?q=%2520",
  ]) {
    assertFail(searchUrl(raw), "double-encoding");
  }
  // 对照：%25 后不是两位十六进制属于合法单次编码
  assert.equal(searchUrl("https://example.com/?q=100%25%20off").ok, true);
});
