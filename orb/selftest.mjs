/*
 * Orb 全链路自检
 *
 * 用法：
 *   node selftest.mjs          基础检查（快，不消耗模型额度）
 *   node selftest.mjs --full   追加真实模型调用：让后台 Agent 真的建一个文件并校验内容
 *   node selftest.mjs --skip-gates   跳过 [9] 开箱即用合规门禁（不建议用于发布前验证）
 *
 * 覆盖：启动产物 -> 令牌鉴权 -> 三个服务 -> 各工具实调 -> 异常边界 -> 面板可用性
 *       -> 开箱即用合规门禁 V1–V8（发布硬门禁，见 [9] 注释）
 * （--full 还会跑一次真实的 workbuddy_execute，验证后台轨道端到端可用）
 * 只做只读或落在自身面板内的操作，不会乱动你的桌面。
 * （[9] 的 V5 会短暂拉起一个记事本窗口用于端到端验证 App 工具，随后即可手动关掉。）
 * 退出码 0 = 无硬失败（⚠ 环境受限项不算失败，但会在汇总里单独列出、绝不静默）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 19387;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0, warned = 0;
const results = [];

function ok(name, detail) { pass++; results.push(["✓", name, detail || ""]); }
function bad(name, detail) { fail++; results.push(["✗", name, detail || ""]); }
/** 环境受限未验证：不是产品故障（如锁屏期间截不了图），但也没验成——
 *  单独计数、单独列出，绝不当通过、也绝不静默跳过。 */
function warn(name, detail) { warned++; results.push(["⚠", name, detail || ""]); }
function check(cond, name, detail) { cond ? ok(name, detail) : bad(name, detail); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readToken() {
  try { return JSON.parse(fs.readFileSync(path.join(HERE, ".bridge.json"), "utf8")).token || ""; }
  catch { return ""; }
}

const FULL = process.argv.includes("--full");
/* 合规门禁（V1–V8）默认执行；仅当你明确知道自己在跳过什么时才用 --skip-gates。
   这几条是发布前的硬门禁：任何一条失败都意味着发布物不合规或不可自包含。 */
const SKIP_GATES = process.argv.includes("--skip-gates");

async function call(server, tool, args, token) {
  const r = await fetch(BASE + "/api/call", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Orb-Token": token ?? readToken() },
    body: JSON.stringify({ server, tool, args: args || {} }),
  });
  const j = await r.json().catch(() => ({ ok: false, error: "响应不是 JSON" }));
  return { status: r.status, ...j };
}
const textOf = (res) => ((res.result?.content) || []).map((c) => c.text || `[${c.type}]`).join(" ");

/* 全新 python 进程直接 PIL grab —— 「环境级故障 vs 产品故障」的判别器。
 * 2026-10-15 凌晨实测：某段时间里 MCP 截图连败、同时全新进程的直接 grab
 * 也连败，约 10 分钟后环境自行恢复、同一代码全绿。锁屏 / 安全桌面
 * （UAC 提示）/ 远程会话断开期间，BitBlt 对**所有**进程一起失效，
 * 与产品无关。反过来，新进程能截到而 MCP 子进程截不到，才是产品 bug。 */
function directGrab(rt) {
  try {
    const py = rt.resolvePython(true);
    if (!py.ok) return { unknown: true, why: py.hint };
    const code = [
      "from PIL import ImageGrab",
      "try:",
      "    im = ImageGrab.grab(all_screens=True)",
      "    print('OK', im.size)",
      "except Exception as e:",
      "    print('FAIL', type(e).__name__, e)",
    ].join("\n");
    const r = spawnSync(py.exe, ["-c", code], { encoding: "utf8", timeout: 30000, windowsHide: true });
    const out = (r.stdout || "").trim();
    if (out.startsWith("OK")) return { ok: true, detail: out };
    if (out.startsWith("FAIL")) return { ok: false, detail: out };
    return { unknown: true, why: `spawn status=${r.status} ${(r.stderr || "").slice(0, 100)}` };
  } catch (e) {
    return { unknown: true, why: String(e.message).slice(0, 120) };
  }
}

/* 截图带重试：实测 V5 刚拉起/关闭记事本的那一两秒里，一次 BitBlt 可能
 * "screen grab failed"（窗口切换期的瞬时态，不是真故障）。
 * 更长的壁也见过：2026-10-15 凌晨无人值守自检里连续 5 次（间隔 3s、中间
 * 夹鼠标唤醒）全部失败，且**全新进程的直接 grab 同样失败** —— 环境级
 * （锁屏/安全桌面/会话切换）期间 BitBlt 整体不可用，pillow 后端内部的两级
 * 降级被同一面墙一起挡死。发布门禁不该把环境抖动判成产品故障：
 * 重试耗尽后先用 directGrab 判别，环境级记 ⚠（未验证），
 * 只有"新进程能截而 MCP 子进程不能"才记 ✗（真故障）。 */
async function screenshot(token, rt) {
  for (let i = 0; i < 5; i++) {
    if (i > 0) {
      await sleep(3000);
      try { await call("orb", "move_to", { x: 2100, y: 600 }, token); } catch { /* 唤醒失败不影响重试 */ }
    }
    const r = await call("windows", "Screenshot", {}, token);
    const hasImg = (r.result?.content || []).some((c) => c.type === "image");
    if (r.ok && hasImg) return r;
    if (i === 4) {
      const d = directGrab(rt);
      if (d.ok) {
        return { ok: false, envLimited: false, why: `MCP 连败 5 次，但全新进程能直接截到（${d.detail}）——前台通道自身故障` };
      }
      return { ok: false, envLimited: true, why: `全新进程同样截不到（${d.detail || d.why}）——环境级限制（锁屏/安全桌面/远程会话断开），非产品故障` };
    }
  }
}

async function main() {
  console.log("Orb 全链路自检\n" + "=".repeat(46));

  /* ---------- 0. 环境预检：截图能力 ---------- */
  /* 为什么放在最前面：锁屏 / 安全桌面 / 远程会话断开期间 BitBlt 对所有进程
   * 一起失效（2026-10-15 凌晨实测持续约 10 分钟）。提前探一次，让"环境不满足"
   * 和"产品故障"在输出里一眼可辨，而不是等跑到 [5] 才莫名失败。 */
  const rt = await import("./runtime.mjs");
  const envShot = directGrab(rt);
  if (envShot.ok) {
    ok("环境预检：当前会话可直接截屏", envShot.detail);
  } else if (envShot.unknown) {
    console.log(`   （环境预检无法执行：${envShot.why}；截图项若失败将无法自动判别环境/产品）`);
  } else {
    console.log("\n⚠️ 环境预检失败：当前会话直接截屏不可用（"
      + `${envShot.detail}）。`);
    console.log("   形态为锁屏 / 安全桌面（UAC 提示）/ 远程会话断开 —— 环境级限制，非产品故障。");
    console.log("   本次运行的截图相关检查将记 ⚠（未验证），其余检查照常执行；");
    console.log("   恢复交互桌面后建议重跑，让截图项真正验到。\n");
  }

  /* ---------- 1. 启动产物 ---------- */
  console.log("\n[1] 启动产物");
  const token = readToken();
  check(!!token && token.length >= 16, "令牌文件存在且有效", `len=${token.length}`);
  let health;
  try { health = await fetch(BASE + "/api/health").then((r) => r.json()); } catch (e) { health = null; }
  check(!!health?.ok, "bridge 存活探测可访问", health ? JSON.stringify(health) : "连不上");

  /* ---------- 2. 令牌鉴权 ---------- */
  console.log("\n[2] 令牌鉴权");
  const noTok = await fetch(BASE + "/api/call", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "orb", tool: "cursor_position", args: {} }),
  });
  check(noTok.status === 401, "无令牌被拒", `HTTP ${noTok.status}`);

  const badTok = await fetch(BASE + "/api/call", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Orb-Token": "wrong-token" },
    body: JSON.stringify({ server: "orb", tool: "cursor_position", args: {} }),
  });
  check(badTok.status === 401, "错误令牌被拒", `HTTP ${badTok.status}`);

  const goodRes = await call("orb", "cursor_position", {});
  check(goodRes.ok === true, "正确令牌放行", textOf(goodRes).slice(0, 40));

  /* ---------- 3. 三个服务 ---------- */
  console.log("\n[3] 服务在线状态");
  const st = await fetch(BASE + "/api/status", { headers: { "X-Orb-Token": token } }).then((r) => r.json());
  for (const [k, v] of Object.entries(st)) {
    /* /api/status 里除三个服务外还混了 ok / live / stop / pending / dangerous /
       dangerRules / frontHealth / cli 等信息字段。区分办法：真正的服务项一定带
       布尔型的 ok（在线 true / 离线 false），信息字段要么没有 ok、要么是 null。 */
    if (!v || typeof v !== "object" || typeof v.ok !== "boolean") continue;
    check(v.ok === true, `服务 ${k} 在线`, v.ok ? `${v.tools.length} 个工具` : v.error);
  }

  /* ---------- 4. orb 原生工具 ---------- */
  console.log("\n[4] orb 原生输入工具");
  // 目标点落在自身面板的消息区，操作无害
  const SAFE = [2100, 600];
  const r1 = await call("orb", "cursor_position", {});
  check(r1.ok && /cursor -?\d+ -?\d+/.test(textOf(r1)), "cursor_position", textOf(r1));

  const r2 = await call("orb", "move_to", { x: SAFE[0], y: SAFE[1] });
  check(r2.ok && /moved/.test(textOf(r2)), "move_to", textOf(r2));

  const r3 = await call("orb", "long_press", { x: SAFE[0], y: SAFE[1], durationMs: 350 });
  check(r3.ok && /longpressed/.test(textOf(r3)), "long_press(350ms)", textOf(r3));

  const r4 = await call("orb", "drag", { x: SAFE[0], y: SAFE[1], x2: SAFE[0] + 60, y2: SAFE[1], durationMs: 300 });
  check(r4.ok && /dragged/.test(textOf(r4)), "drag", textOf(r4));

  const r5 = await call("orb", "mouse_press", { x: -1, y: -1 });
  const r6 = await call("orb", "mouse_release", {});
  check(r5.ok && r6.ok, "mouse_press / mouse_release（就地）", `${textOf(r5)} | ${textOf(r6)}`);

  const r7 = await call("orb", "scroll_at", { x: SAFE[0], y: SAFE[1], direction: "down", clicks: 1 });
  check(r7.ok, "scroll_at", textOf(r7));

  /* ---------- 5. windows-mcp 抽查 ---------- */
  console.log("\n[5] windows-mcp 抽查");
  const w1 = await call("windows", "DisplayInventory", {});
  check(w1.ok && /resolution/.test(textOf(w1)), "DisplayInventory", textOf(w1).slice(0, 60));

  const w2 = await call("windows", "Clipboard", { mode: "get" });
  check(w2.ok, "Clipboard get", textOf(w2).slice(0, 40));

  const w3 = await call("windows", "Process", { mode: "list", limit: 3 });
  check(w3.ok, "Process list", textOf(w3).split("\n")[0] || "");

  const w4 = await screenshot(token, rt);
  const hasImg = (w4.result?.content || []).some((c) => c.type === "image");
  if (w4.envLimited) {
    warn("Screenshot 返回图像", `环境受限未验证：${w4.why}`);
  } else {
    check(w4.ok && hasImg, "Screenshot 返回图像", hasImg ? "含 image 内容" : textOf(w4).slice(0, 90));
  }

  /* ---------- 6. workbuddy 后台轨道 ---------- */
  console.log("\n[6] workbuddy 后台轨道");
  const d1 = await fetch(BASE + "/api/status", {
    headers: { "X-Orb-Token": token },
  }).then((r) => r.json());
  const wb = d1.workbuddy || {};
  check(wb.ok === true, "workbuddy 后台在线", wb.label || "");
  check(Array.isArray(wb.tools) && wb.tools.includes("workbuddy_execute"),
    "workbuddy 暴露 workbuddy_execute", (wb.tools || []).join(",") || "(无)");

  /* ---------- 7. 异常边界 ---------- */
  console.log("\n[7] 异常边界（都应优雅失败，不能挂起）");
  const e1 = await call("nosuch", "x", {});
  check(e1.ok === false && !!e1.error, "未知服务被拒", String(e1.error).slice(0, 50));

  const e2 = await call("orb", "nosuchtool", {});
  check(e2.ok === false && /没有工具/.test(String(e2.error)), "未知工具被拒", String(e2.error).slice(0, 50));

  const e3 = await fetch(BASE + "/api/call", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Orb-Token": token },
    body: "{ this is not valid json",
  }).then((r) => r.json());
  check(e3.ok === false && !!e3.error, "畸形 JSON 请求被优雅拒绝", String(e3.error).slice(0, 60));

  const e4 = await fetch(BASE + "/api/job/999999", { headers: { "X-Orb-Token": token } });
  check(e4.status === 404, "不存在的 jobId 返回 404", `HTTP ${e4.status}`);

  const e5 = await call("orb", "long_press", { x: SAFE[0], y: SAFE[1], durationMs: 0 });
  check(e5.ok && /for 1 ms/.test(textOf(e5)), "超短时长被夹到下限", textOf(e5));

  const e6 = await fetch(BASE + "/api/vlm", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Orb-Token": token },
    body: JSON.stringify({ baseUrl: "", model: "" }),
  }).then((r) => r.json());
  check(e6.ok === false && /缺少/.test(String(e6.error)), "视觉代理缺参被拒", String(e6.error));

  /* ---------- 8. 面板可用性 ---------- */
  console.log("\n[8] 面板可用性");
  const png = (w4.result?.content || []).find((c) => c.type === "image");
  if (w4.envLimited) {
    warn("能取到整屏截图", `环境受限未验证：${w4.why}`);
  } else if (png) {
    try {
      const buf = Buffer.from(png.data, "base64");
      // 只判断能取到图，不做视觉判定
      check(buf.length > 10000, "能取到整屏截图", `${Math.round(buf.length / 1024)}KB`);
      fs.writeFileSync(path.join(HERE, ".selftest-shot.png"), buf);
    } catch (e) { bad("截图落盘", e.message); }
  } else {
    bad("截图内容", "没有 image 内容");
  }

  /* ---------- 8. 开箱即用合规门禁（V1–V8） ---------- *
   * 为什么单独一节：这些是"发布物能不能发"的硬门禁，不是功能抽查。
   *   V1 无 GPL/LGPL/AGPL/SSPL 残留          —— 否则触发 copyleft 源代码提供义务
   *   V2 numpy/dxcam/真 fuzzywuzzy/真 posthog 都不在，且缺 numpy 截图仍工作
   *   V3 空环境变量确实以 '' 传到子进程      —— Windows `set VAR=` 是删除不是置空
   *   V4 无 PostHog 出站、无 .windows-mcp-user-id 落盘
   *   V5 端到端调一次 App 工具（fuzzywuzzwy→thefuzz 壳真的顶住了）
   *   V6 pillow 截图后端生效
   *   V7 产物拷到含中文路径仍能跑
   *   V8 `python -m windows_mcp serve` stdio 握手成功、工具列全            */
  if (SKIP_GATES) {
    console.log("\n[9] 开箱即用合规门禁 —— 已按 --skip-gates 跳过（不建议用于发布前验证）");
  } else {
    console.log("\n[9] 开箱即用合规门禁（V1–V8）");
    const py = rt.resolvePython(true);
    const sp = path.join(rt.RUNTIME_DIR, "Lib", "site-packages");

    /** 在指定解释器里跑一段 python，返回 {stdout,stderr,status} */
    const runPy = (exe, code, opts = {}) => spawnSync(exe, ["-c", code], {
      env: rt.windowsMcpEnv(), encoding: "utf8", windowsHide: true,
      timeout: 240000, ...opts,
    });

    check(py.ok === true, "V0 随包 Python 可解析", py.ok ? `source=${py.source}` : py.hint);

    /* ---- V1：许可证扫描 ---- */
    if (fs.existsSync(sp)) {
      let pkgs = 0;
      const gplHits = [];
      for (const d of fs.readdirSync(sp)) {
        if (!d.endsWith(".dist-info")) continue;
        pkgs++;
        let md = "";
        try { md = fs.readFileSync(path.join(sp, d, "METADATA"), "utf8"); } catch { continue; }
        const lic = md.split(/\r?\n/).filter((l) => /^(License|Classifier: License)/i.test(l)).join(" | ");
        if (/\b(GPL|LGPL|AGPL|SSPL)\b/i.test(lic)) gplHits.push(`${d} → ${lic.slice(0, 100)}`);
      }
      check(gplHits.length === 0, "V1 site-packages 无 GPL/LGPL/AGPL/SSPL",
        gplHits.length ? gplHits.join(" ; ") : `${pkgs} 个包全部宽松许可（certifi 为 MPL-2.0，已在 THIRD-PARTY-NOTICES.md 单列）`);
    } else {
      bad("V1 site-packages 不存在", sp);
    }

    /* ---- V2 / V3：模块去向 + 空环境变量语义 ---- */
    if (py.ok) {
      const v2 = runPy(py.exe, `
import importlib.util as u, json, os
out = {}
for m in ("numpy", "dxcam", "fuzzywuzzy", "posthog", "thefuzz"):
    s = u.find_spec(m)
    out[m] = s.origin if s else None
out["repr_POSTHOG_API_KEY"] = repr(os.environ.get("POSTHOG_API_KEY"))
out["repr_ANONYMIZED_TELEMETRY"] = repr(os.environ.get("ANONYMIZED_TELEMETRY"))
print(json.dumps(out))
`);
      let j = {};
      try { j = JSON.parse(v2.stdout.trim().split("\n").pop()); } catch { j = {}; }
      const inRt = (p) => typeof p === "string" && path.resolve(p).startsWith(path.resolve(rt.RUNTIME_DIR));
      check(j.numpy == null, "V2 numpy 未随包", String(j.numpy));
      check(j.dxcam == null, "V2 dxcam 未随包", String(j.dxcam));
      check(inRt(j.fuzzywuzzy), "V2 fuzzywuzzy 是我们的 MIT 转发壳", String(j.fuzzywuzzy));
      check(inRt(j.posthog), "V2 posthog 是我们的 no-op stub", String(j.posthog));
      check(j.repr_POSTHOG_API_KEY === "''", "V3 POSTHOG_API_KEY 以空串到达子进程", `repr=${j.repr_POSTHOG_API_KEY}`);
      check(j.repr_ANONYMIZED_TELEMETRY === "'false'", "V3 ANONYMIZED_TELEMETRY=false 到达子进程", `repr=${j.repr_ANONYMIZED_TELEMETRY}`);
    } else {
      bad("V2/V3 无法执行（没有可用解释器）", py.hint);
    }

    /* ---- V4 / V8：真起一次 stdio 服务，握手 + 列工具 + 查遥测落盘 ---- */
    const uidFiles = [
      path.join(os.homedir(), ".windows-mcp-user-id"),
      path.join(rt.RUNTIME_DIR, ".windows-mcp-user-id"),
    ];
    const uidBefore = uidFiles.filter((f) => fs.existsSync(f));
    if (py.ok) {
      const handshake = await new Promise((resolve) => {
        const child = spawn(py.exe, rt.windowsMcpArgs(), {
          env: rt.windowsMcpEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
        });
        let buf = "";
        const tools = [];
        const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, why: "60s 超时", tools }); }, 60000);
        child.stdout.on("data", (d) => {
          buf += String(d);
          for (const line of buf.split("\n")) {
            if (!line.trim()) continue;
            let msg; try { msg = JSON.parse(line); } catch { continue; }
            if (msg.id === 1 && msg.result) {
              child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
            }
            if (msg.id === 2 && msg.result) {
              for (const t of msg.result.tools || []) tools.push(t.name);
              clearTimeout(timer);
              try { child.kill(); } catch {}
              resolve({ ok: true, tools });
            }
          }
          buf = buf.slice(buf.lastIndexOf("\n") + 1);
        });
        child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, why: String(e.message || e), tools }); });
        child.on("exit", (c) => { clearTimeout(timer); resolve({ ok: tools.length > 0, why: `提前退出 code=${c}`, tools }); });
        child.stdin.write(JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "orb-selftest", version: "1.0.0" } },
        }) + "\n");
      });
      check(handshake.ok, "V8 windows_mcp stdio 握手成功", handshake.ok ? `${handshake.tools.length} 个工具` : handshake.why);
      check(handshake.tools.length >= 15, "V8 工具数量完整（≥15）", handshake.tools.slice(0, 8).join(",") + (handshake.tools.length > 8 ? " …" : ""));
      check(!handshake.tools.includes("Registry"), "V8 Registry 工具已按 --exclude-tools 排除", handshake.tools.filter((t) => /registry/i.test(t)).join(",") || "(无)");
      await sleep(300);
      const uidAfter = uidFiles.filter((f) => fs.existsSync(f));
      check(uidAfter.length === uidBefore.length, "V4 未生成 .windows-mcp-user-id（遥测未落盘）",
        uidAfter.length ? uidAfter.join(",") : "无");
    } else {
      bad("V4/V8 无法执行（没有可用解释器）", py.hint);
    }

    /* ---- V5：端到端调一次 App 工具（经桥，真集成路径） ---- */
    /* 注意 windows-mcp 的 App 是按**模糊名**在开始菜单/窗口标题里找（score_cutoff=70），
       而中文系统的开始菜单条目是中文、窗口标题却常是英文（"无标题 - Notepad"）。
       所以这里按候选名逐个试，命中任意一个即算过 —— 这不是我们的缺陷，
       是上游模糊匹配跨语种打分的固有行为（已在交付报告里记录）。 */
    const winOk = (st.windows && st.windows.ok) === true;
    if (winOk) {
      const LAUNCH_CANDIDATES = ["记事本", "notepad", "Notepad", "计算器", "calculator"];
      const SWITCH_CANDIDATES = ["notepad", "Notepad", "记事本", "计算器", "calculator"];
      let launchTxt = "", launchOk = false;
      for (const nm of LAUNCH_CANDIDATES) {
        const a = await call("windows", "App", { mode: "launch", name: nm });
        launchTxt = textOf(a);
        if (a.ok && /launched|switched/i.test(launchTxt)) { launchOk = true; break; }
      }
      await sleep(1500);
      let switchTxt = "", switchOk = false;
      for (const nm of SWITCH_CANDIDATES) {
        const a = await call("windows", "App", { mode: "switch", name: nm });
        switchTxt = textOf(a);
        if (a.ok && /switched/i.test(switchTxt)) { switchOk = true; break; }
      }
      check(launchOk && switchOk, "V5 App 工具端到端可用（fuzzywuzzy→thefuzz 壳生效）",
        `launch: ${launchTxt.slice(0, 44)} | switch: ${switchTxt.slice(0, 44)}`);
    } else {
      bad("V5 前台通道不在线，无法端到端验证", String(st.windows?.error || "(无 windows 服务)"));
    }

    /* ---- V6：pillow 截图后端 ---- */
    if (winOk) {
      const s1 = await screenshot(token, rt);
      const backend = String(rt.windowsMcpEnv().WINDOWS_MCP_SCREENSHOT_BACKEND || "");
      const imgOk = (s1.result?.content || []).some((c) => c.type === "image");
      if (s1.envLimited) {
        warn("V6 pillow 截图后端生效（numpy 不在仍出图）", `环境受限未验证：${s1.why}`);
      } else {
        check(imgOk && backend === "pillow", "V6 pillow 截图后端生效（numpy 不在仍出图）",
          imgOk ? `backend=${backend}` : textOf(s1).slice(0, 90));
      }
    }

    /* ---- V7：拷到含中文路径再跑一遍 ---- */
    if (py.ok) {
      const cnRoot = path.join(os.tmpdir(), "ORB自检-中文路径", "运行时");
      try {
        fs.rmSync(cnRoot, { recursive: true, force: true });
        fs.mkdirSync(cnRoot, { recursive: true });
        const rc = spawnSync("robocopy", [rt.RUNTIME_DIR, cnRoot, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1"],
          { windowsHide: true, encoding: "utf8" });
        const cnPy = path.join(cnRoot, "python.exe");
        if (!fs.existsSync(cnPy)) {
          bad("V7 中文路径拷贝失败", `robocopy exit=${rc.status}`);
        } else {
          const v7 = runPy(cnPy, `
# -*- coding: utf-8 -*-
import windows_mcp, fuzzywuzzy, thefuzz, PIL, comtypes, win32api
from fuzzywuzzy import process
print("import_all=ok")
print("match:", process.extractOne("记事本", ["无标题 - 记事本"], score_cutoff=70))
`, { cwd: cnRoot });
          check(v7.status === 0 && /import_all=ok/.test(v7.stdout),
            "V7 中文路径下全部 import 成功（pywin32 DLL 兜底）",
            v7.status === 0 ? v7.stdout.trim().split("\n").pop() : String(v7.stderr || "").slice(0, 160));
        }
      } finally {
        try { fs.rmSync(path.join(os.tmpdir(), "ORB自检-中文路径"), { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
      }
    } else {
      bad("V7 无法执行（没有可用解释器）", py.hint);
    }
  }

  /* ---------- 10. 真实后台任务（可选） ---------- */
  if (FULL) {
    console.log("\n[8] 后台 Agent 真实任务（--full）");
    // 目标文件必须放到 **DSH 自己的工作目录**（通常是工作区根目录），不是本脚本所在目录。
    // 先问 dsh_status 拿到 workspace，避免路径错位导致误判"没落地"。
    const wsMatch = textOf(await call("dsh", "dsh_status")).match(/workspace:\s*(.+)/);
    const ws = wsMatch ? wsMatch[1].trim() : process.cwd();
    console.log(`    （DSH 工作目录: ${ws}）`);
    const target = path.join(ws, "orb-agent-proof.txt");
    try { fs.unlinkSync(target); } catch {}

    const r = await fetch(BASE + "/api/dispatch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Orb-Token": token },
      body: JSON.stringify({
        server: "workbuddy", tool: "workbuddy_execute",
        args: { task: `在当前工作目录创建文本文件 ${target}，内容只有一行：ORB-AGENT-OK。完成后用一句话确认。` },
      }),
    }).then((x) => x.json());

    if (!r.ok) {
      bad("后台任务派发", String(r.error).slice(0, 80));
    } else {
      let done = false;
      for (let i = 0; i < 30 && !done; i++) {
        await sleep(5000);
        const j = await fetch(BASE + "/api/job/" + r.jobId, { headers: { "X-Orb-Token": token } }).then((x) => x.json());
        const job = j.job;
        if (job.status === "running") continue;
        done = true;
        if (job.status === "done") {
          const t = (job.result?.content || []).map((c) => c.text || "").join(" ");
          check(fs.existsSync(target), "后台 Agent 落地了文件", target);
          if (fs.existsSync(target)) {
            const body = fs.readFileSync(target, "utf8");
            check(body.includes("ORB-AGENT-OK"), "文件内容符合预期", JSON.stringify(body.trim()));
            try { fs.unlinkSync(target); } catch {}
          }
          void t;
        } else {
          bad("后台任务执行", String(job.error).replace(/\s+/g, " ").slice(0, 160));
        }
      }
      if (!done) bad("后台任务超时", "150 秒未完成");
    }
  }

  /* ---------- 汇总 ---------- */
  console.log("\n" + "=".repeat(46));
  for (const [mark, name, detail] of results) {
    console.log(`  ${mark} ${name}${detail ? "  —  " + detail : ""}`);
  }
  console.log("=".repeat(46));
  console.log(`通过 ${pass} 项，失败 ${fail} 项` + (warned ? `，环境受限未验证 ${warned} 项` : ""));
  if (warned > 0) {
    console.log(`⚠ 有 ${warned} 项因环境受限未能验证（均为截图类：锁屏/安全桌面/远程会话断开期间 BitBlt 对所有进程失效）。`);
    console.log("  这不是产品故障；恢复交互桌面（解锁 / 关掉 UAC 提示 / 重连远程会话）后重跑本脚本即可验到。");
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("\n自检脚本自身出错:", e.message);
  process.exit(2);
});
