#!/usr/bin/env node
/* 浏览器通道（快速路）端到端冒烟：真打桥、真下发命令、真看扩展回执。
 *
 * 为什么单独一个脚本：quickWebOpen() 的成败完全取决于桥侧这套通道，
 * 而它最容易「只炸真机」——单测里全是桩，桩永远说 ok。
 * 这里不 mock，直接对着本机在跑的 bridge（orb/.bridge.json 里的 port+token）跑四件事：
 *
 *   1. /api/browser/status     通道在线（channels > 0、未急停）
 *   2. tab.open + confirm:true 真开一个标签，回执必须带 tabId/url（成功判据看 result 非空）
 *   3. tab.open 不带 confirm    必须 400 confirmation-required（安全闸不能被绕过）
 *   4. eval（黑名单）            必须 400 method-denied
 *
 * 用法：node orb/tools/browser-channel-smoke.mjs [--url <要开的网址>]
 * 退出码 0 = 全绿。桥没起 / 扩展没连 = 失败（这就是要暴露的真机状态）。
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const STATE = path.join(ROOT, "orb", ".bridge.json");

const argv = process.argv.slice(2);
const argUrl = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 ? argv[i + 1] : null;
})();

const RESULTS = [];
function check(name, ok, detail) {
  RESULTS.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
}

function readState() {
  if (!fs.existsSync(STATE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(STATE, "utf8"));
    return j && j.port && j.token ? j : null;
  } catch {
    return null;
  }
}

function req(st, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const r = http.request(
      {
        host: "127.0.0.1",
        port: st.port,
        path: p,
        method,
        timeout: 45_000,
        headers: {
          "X-Orb-Token": st.token,
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
      },
      (s) => {
        let b = "";
        s.setEncoding("utf8");
        s.on("data", (d) => (b += d));
        s.on("end", () => {
          let json = null;
          try { json = JSON.parse(b); } catch {}
          resolve({ code: s.statusCode, json, raw: b });
        });
      }
    );
    r.on("error", reject);
    r.on("timeout", () => { r.destroy(new Error("timeout")); });
    if (payload) r.write(payload);
    r.end();
  });
}

async function main() {
  const st = readState();
  if (!st) {
    check("读取 orb/.bridge.json", false, "找不到，桥没启动过？");
    return finish();
  }
  console.log(`桥: 127.0.0.1:${st.port} (pid ${st.pid ?? "?"})\n`);

  /* ---- 1. 通道状态 ---- */
  let status = null;
  try {
    const r = await req(st, "GET", "/api/browser/status");
    status = r.json;
    check("GET /api/browser/status 返回 200", r.code === 200, `HTTP ${r.code}`);
  } catch (e) {
    check("GET /api/browser/status", false, e.message);
    return finish();
  }
  const p = (status && status.provider) || {};
  check("浏览器通道已启用", status && status.enabled === true, `enabled=${status && status.enabled}`);
  check("有打开的通道（channels > 0）", Number(p.channels) > 0, `channels=${p.channels} hellos=${p.hellos}`);
  check("未被急停", p.stopped !== true, `stopped=${p.stopped} reasonCode=${status && status.reasonCode}`);
  console.log("");

  /* ---- 2. 真开一个标签 ---- */
  const url = argUrl || `https://cn.bing.com/search?q=ORB+browser+channel+smoke+${Date.now()}`;
  let opened = false;
  try {
    const r = await req(st, "POST", "/api/browser/command", {
      method: "tab.open",
      params: { url, confirm: true },
    });
    const cid = r.json && r.json.command_id;
    check("POST tab.open(confirm) 入队", r.code === 200 && !!cid, `HTTP ${r.code} ${cid || r.raw.slice(0, 160)}`);
    if (cid) {
      const res = await req(st, "GET", "/api/browser/command-result?id=" + encodeURIComponent(cid));
      const j = res.json || {};
      /* 成功判据：桥已结算 + 扩展回了 result（result 里是 {tabId,url}，本身没有 .ok 字段）。
         这条正是 2026-11-08 那个 bug 的靶心 —— 千万别改回 result.ok。 */
      const okResult = res.code === 200 && j.ok === true && j.result != null;
      opened = okResult;
      check(
        "扩展执行 tab.open 并回执 result",
        okResult,
        okResult
          ? `tabId=${j.result.tabId ?? "?"} url=${String(j.result.url || url).slice(0, 80)}`
          : `${res.code} ${JSON.stringify(j).slice(0, 240)}`
      );
      check("回执 url 是本次下发的地址", okResult && String(j.result.url || "").startsWith(url.slice(0, 24)), String(j.result && j.result.url || "").slice(0, 80));
    }
  } catch (e) {
    check("tab.open 端到端", false, e.message);
  }
  console.log("");

  /* ---- 3. 安全闸：写操作不带 confirm ---- */
  try {
    const r = await req(st, "POST", "/api/browser/command", {
      method: "tab.open",
      params: { url: "https://example.com/" },
    });
    check(
      "tab.open 不带 confirm 被拒（confirmation-required）",
      r.code === 400 && r.json && r.json.error === "confirmation-required",
      `HTTP ${r.code} ${r.json && r.json.error}`
    );
  } catch (e) {
    check("写操作 confirm 闸", false, e.message);
  }

  /* ---- 4. 安全闸：黑名单方法 ---- */
  try {
    const r = await req(st, "POST", "/api/browser/command", { method: "eval", params: { code: "1", confirm: true } });
    check(
      "eval 被拒（method-denied）",
      r.code === 400 && r.json && r.json.error === "method-denied",
      `HTTP ${r.code} ${r.json && r.json.error}`
    );
  } catch (e) {
    check("黑名单闸", false, e.message);
  }

  if (opened) console.log(`\n打开过一个标签，可手动关掉：${url}`);
  finish();
}

function finish() {
  const bad = RESULTS.filter((r) => !r.ok);
  const total = RESULTS.length;
  console.log("");
  if (!total) {
    console.log("BROWSER_CHANNEL_SMOKE_FAIL (0 项都没跑)");
    process.exit(1);
  }
  if (bad.length) {
    console.log(`BROWSER_CHANNEL_SMOKE_FAIL (${bad.length}/${total})`);
    for (const b of bad) console.log("  - " + b.name + (b.detail ? " :: " + b.detail : ""));
    process.exit(1);
  }
  console.log(`BROWSER_CHANNEL_SMOKE_OK (${total} 项)`);
  process.exit(0);
}

main().catch((e) => {
  console.error("BROWSER_CHANNEL_SMOKE_FAIL " + e.message);
  process.exit(1);
});
