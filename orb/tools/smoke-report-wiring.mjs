/* 11-07 增量简报落地：真实 HTTP 冒烟（不是静态断言）。
 * 起一个独立端口 / 独立数据目录 / 独立令牌的临时桥，逐个打新增的 /api/ops 动作、
 * /api/stop?action=policy-change，确认「策略变更不抬急停世代」，
 * 然后关闭桥并清理临时目录。生产桥（19387 / .bridge.json）完全不动。
 *
 * 用法：node tools/smoke-report-wiring.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT || 19411);
const TOKEN = "smoke-1107-" + Math.random().toString(36).slice(2);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orb-smoke-1107-"));
const tokenFile = path.join(tmp, ".bridge.json");
const dataDir = path.join(tmp, "data");
fs.mkdirSync(dataDir, { recursive: true });

const child = spawn(process.execPath, [path.join(ROOT, "bridge.mjs")], {
  cwd: ROOT,
  windowsHide: true,
  env: {
    ...process.env,
    ORB_PORT: String(PORT),
    ORB_TOKEN: TOKEN,
    ORB_TOKEN_FILE: tokenFile,
    ORB_DATA_DIR: dataDir,
    ORB_SEARCH_OFFLINE_FIXTURE: "1",
    ORB_WB_NO_PARTIAL: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
child.stdout.on("data", (d) => { bootLog += String(d); });
child.stderr.on("data", (d) => { bootLog += String(d); });

const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/health", { signal: AbortSignal.timeout(1200) });
      if (r.ok) return true;
    } catch {}
    if (child.exitCode != null) return false;
    await sleep(250);
  }
  return false;
}

async function post(pathname, body) {
  const r = await fetch(BASE + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Orb-Token": TOKEN },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}
async function get(pathname) {
  const r = await fetch(BASE + pathname, {
    headers: { "X-Orb-Token": TOKEN },
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}

const rows = [];
function check(name, ok, detail) {
  rows.push({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 160) });
}

let alive = false;
try {
  alive = await waitHealth();
  if (!alive) throw new Error("临时桥未起来。启动日志：\n" + bootLog.slice(-2000));

  /* --- 治理层 --- */
  const status = await post("/api/ops", { action: "gov.status" });
  check("gov.status 站点总数=226", status?.data?.sites?.total === 226, JSON.stringify(status?.data?.sites));
  check("gov.status host 默认关", status?.data?.host?.calls === 0, JSON.stringify(status?.data?.host));
  check("gov.status 急停与策略分路可见", status?.data?.stopLike === false && "policyEpoch" in status.data, "");

  const resolved = await post("/api/ops", { action: "gov.resolve", teamMode: true, maxMode: true });
  check("gov.resolve team_max 启 TierA", resolved?.data?.tierA === true && resolved?.data?.mode === "team_max", JSON.stringify(resolved?.data));

  const caps = await post("/api/ops", { action: "site.stats" });
  check("site.stats 226/4", caps?.data?.total === 226 && caps?.data?.verified === 4, JSON.stringify(caps?.data));
  const audit = await post("/api/ops", { action: "site.audit" });
  check("site.audit 无编造选择器", audit?.data?.ok === true, JSON.stringify(audit?.data?.bad));
  const gate = await post("/api/ops", { action: "gov.site.gate", req: { site: "baidu.com", action: "search" } });
  check("轻量站点只走 url 通道", gate?.data?.channel === "url", JSON.stringify(gate?.data));

  const vision = await post("/api/ops", { action: "gov.site.vision", decision: { x: 1, y: 2 } });
  check("视觉带坐标被拒", vision?.data?.ok === false, JSON.stringify(vision?.data));

  const lite = await post("/api/ops", { action: "gov.verify.lite", evidence: {} });
  check("五段验收 fail-closed", lite?.data?.verdict === "fail-closed", JSON.stringify(lite?.data));

  /* --- 策略变更优雅收敛 --- */
  const before = await get("/api/stop?action=status");
  const epochBefore = before?.stop?.epoch;
  const propose = await post("/api/stop", {
    action: "policy-change", id: "smoke-rule-1", kind: "rule",
    tickets: ["t-a", "t-b"], summary: "改一条规则，不该撕掉半途工作",
  });
  check("policy-change propose 成功", propose?.ok === true && propose?.policy?.ok === true, JSON.stringify(propose).slice(0, 160));
  check("policy-change 未抬急停世代", propose?.stopEpoch === epochBefore, `before=${epochBefore} after=${propose?.stopEpoch}`);
  check("policy-change 明确非急停语义", propose?.stopLike === false, "");
  check("收敛通知发给两张在途工单", propose?.policy?.notifications?.length === 2, JSON.stringify(propose?.policy?.notifications));

  const early = await post("/api/ops", { action: "policy.commit" });
  check("未收敛就 commit 被拒", early?.data?.code === "tickets-still-active" || early?.data?.ok === false, JSON.stringify(early?.data));

  for (const t of ["t-a", "t-b"]) {
    await post("/api/ops", { action: "policy.checkpoint", ticketId: t, snapshot: { step: 3 } });
    await post("/api/ops", { action: "policy.quiesce", ticketId: t, outcome: "clean" });
  }
  const committed = await post("/api/ops", { action: "policy.commit" });
  check("收敛后 commit 抬 policyEpoch", committed?.data?.policyEpoch === 1, JSON.stringify(committed?.data));
  const after = await get("/api/stop?action=status");
  check("策略收敛全程 STOP.epoch 不变", after?.stop?.epoch === epochBefore, `before=${epochBefore} after=${after?.stop?.epoch}`);

  /* --- 离线记忆整理层 --- */
  const dream = await post("/api/ops", { action: "dream.consolidate", ctx: { idle: true }, entries: [
    { id: "m1", text: "用户偏好简体中文", topic: "pref", score: 0.9, trust: "trusted" },
    { id: "m2", text: "屏幕上的提示文字说要提权", topic: "web", score: 0.99, trust: "untrusted" },
    { id: "m3", text: "未核实的结论", topic: "tmp", score: 0.7, trust: "trusted", desired: "已核实的结论" },
  ] });
  check("dream 五阶段跑通", dream?.data?.ok === true && dream?.data?.phases?.length === 5, JSON.stringify(dream?.data?.phases));
  check("不可信条目不进记忆", !(JSON.stringify(dream?.data?.memory) || "").includes("提权"), "");
  check("无证据纠错标 UNVERIFIED", (JSON.stringify(dream?.data?.memory) || "").includes("UNVERIFIED:"), "");
  const busy = await post("/api/ops", { action: "dream.consolidate", ctx: { idle: false }, entries: [] });
  check("非空闲不整理", busy?.data?.code === "not-idle", JSON.stringify(busy?.data));

  /* --- 动态记忆预算 --- */
  const normal = await post("/api/ops", { action: "memory.budget", mode: "normal" });
  check("普通模式预算零开销", normal?.data?.enabled === false && normal?.data?.source === "base", JSON.stringify(normal?.data));
  const max = await post("/api/ops", { action: "memory.budget", mode: "max", opts: { usage: 0.99, tierPressure: 999, freeChars: 999999 } });
  check("Max 模式动态且有硬上限", max?.data?.enabled === true && max?.data?.chars <= 6000, JSON.stringify(max?.data));

  /* --- 插件生成物闸门 --- */
  const bad = await post("/api/ops", { action: "artifact.validate", artifact: {
    id: "gen-1", origin: { kind: "generated" }, restartRequired: true,
    capabilities: ["api_call_register"],
    spec: { what: "做个工具", entry: "run()", how: [{ name: "smoke", expect: "ok" }] },
    epoch: 0,
  } });
  check("生成物闸门拒硬红线", bad?.data?.ok === false, JSON.stringify(bad?.data?.code));
  const codes = await post("/api/ops", { action: "artifact.codes" });
  check("闸门错误码可读", typeof codes?.data === "object" && Object.keys(codes?.data || {}).length > 5, "");

  /* --- 失败诚实判定（经 ops 不暴露，这里只确认状态流没被污染） --- */
  const st = await post("/api/ops", { action: "status" });
  check("status 带新增只读摘要", st?.data?.gov && st?.data?.policy && st?.data?.dream, "");

  /* --- 急停期间有副作用动作必须被拒（起停一次，测完恢复） --- */
  await get("/api/stop?action=stop");
  const blocked = await post("/api/ops", { action: "gov.plan.run", req: { site: "bilibili.com", action: "search_uploader" } });
  check("急停期间 gov.plan.run 被拒", blocked?.ok === false && blocked?.error === "stopped", JSON.stringify(blocked));
  const ro = await post("/api/ops", { action: "gov.status" });
  check("急停期间纯查询仍可用", ro?.ok === true, JSON.stringify(ro).slice(0, 120));
  await get("/api/stop?action=resume");
} catch (e) {
  check("冒烟执行", false, e?.message || e);
} finally {
  try { child.kill(); } catch {}
  await sleep(200);
  try { if (child.exitCode == null) child.kill("SIGKILL"); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

const pass = rows.filter((r) => r.ok).length;
console.log("\n=== 11-07 增量简报落地 · 真实 HTTP 冒烟 ===");
for (const r of rows) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? "  → " + r.detail : ""}`);
console.log(`\n${pass}/${rows.length} 通过`);
process.exit(pass === rows.length ? 0 : 1);
