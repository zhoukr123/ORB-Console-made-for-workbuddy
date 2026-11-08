#!/usr/bin/env node
/* 自动化 / 治理相关 API 的独立实例冒烟。
 *
 * 为什么独立：曾经有一次冒烟用了默认 TOKEN_FILE，把生产 .bridge.json 写成测试端口，
 * 用户下次打开控制台就连错了桥。这里四项全隔离：
 *   ORB_PORT=19887 / ORB_DATA_DIR=临时目录 / ORB_TOKEN_FILE=临时目录内 / ORB_TOKEN=固定值
 * 再加 ORB_ASR_AUTOSTART=0、ORB_WATCHDOG=0，不拉起语音与看门狗。
 * 脚本自己 spawn + kill bridge，退出时清掉临时目录，不留后台进程。
 *
 * 用法：node orb/tools/smoke-automation-api.mjs
 * 退出码 0 = 全部通过。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
/* 断点要带内容指纹（步数一样但内容改过也得拒），冒烟得按同一算法造记录。 */
import { recipeDigest } from "../wfCheckpoint.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 19887;
const TOKEN = "smoke-auto-token-20261108";
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orb-smoke-auto-"));
const env = {
  ...process.env,
  ORB_PORT: String(PORT),
  ORB_DATA_DIR: DIR,
  ORB_TOKEN_FILE: path.join(DIR, "bridge.json"),
  ORB_TOKEN: TOKEN,
  ORB_ASR_AUTOSTART: "0",
  ORB_WATCHDOG: "0",
};
/* 预置一条「已结算」的动作收据：断点续跑的放行需要"前面那步真做完了"的凭据，
   而凭据只能来自真实的动作执行。这里在桥启动前把它写进收据快照，
   桥的 load() 只信 settled:true 的行，所以这是模拟"上次跑到这里成功了"的最小合法输入。 */
const SEED_IDEM = "wr-seed|1|windows|Snapshot|0123456789ab";
fs.writeFileSync(path.join(DIR, "wf-receipts.json"), JSON.stringify({
  receiptId: "r-1-seedseedseed", generation: 1, idempotencyKey: SEED_IDEM,
  ticketId: "", effect: { server: "windows", tool: "Snapshot" },
  ok: true, result: { step: 1 }, settled: true,
  issuedAt: Date.now() - 60000, settledAt: Date.now() - 59000,
}) + "\n", "utf8");

const child = spawn(process.execPath, ["bridge.mjs"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
let logs = "";
child.stdout.on("data", (d) => { logs += d.toString(); });
child.stderr.on("data", (d) => { logs += d.toString(); });

const H = { "X-Orb-Token": TOKEN, "Content-Type": "application/json" };
async function req(method, p, body) {
  const r = await fetch("http://127.0.0.1:" + PORT + p, {
    method, headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return await r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS " + name + (detail ? " · " + detail : "")); }
  else { fail++; console.log("  FAIL " + name + (detail ? " · " + detail : "")); }
}

let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch("http://127.0.0.1:" + PORT + "/api/health");
    if (r.ok) { ready = true; break; }
  } catch {}
  await sleep(200);
}
if (!ready) {
  console.log("SMOKE_FAIL 桥未启动：\n" + logs.slice(-3000));
  child.kill();
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
}

try {
  const health = await req("GET", "/api/health");
  check("GET /api/health", health && health.ok === true);

  const list = await req("POST", "/api/wf", { action: "list" });
  check("POST /api/wf list", list.ok === true && Array.isArray(list.workflows),
    "自动化 " + (list.workflows || []).length + " 条");

  const policy = await req("POST", "/api/wf", { action: "policy" });
  check("POST /api/wf policy", policy.ok === true && Array.isArray(policy.items) && Array.isArray(policy.triggers),
    "判据 " + (policy.items || []).length + " / 触发器 " + (policy.triggers || []).length);

  const apply = await req("POST", "/api/wf", { action: "policy-apply" });
  check("POST /api/wf policy-apply", apply.ok === true && Array.isArray(apply.transitions));

  const runs = await req("POST", "/api/wf", { action: "runs", limit: 20 });
  check("POST /api/wf runs", runs.ok === true && Array.isArray(runs.runs) && runs.stats,
    "运行 " + (runs.runs || []).length + " / 总账 " + (runs.stats && runs.stats.total));

  const trash = await req("POST", "/api/wf", { action: "trash" });
  check("POST /api/wf trash", trash.ok === true && Array.isArray(trash.items),
    "回收站 " + (trash.items || []).length + " 条");

  const purge = await req("POST", "/api/wf", { action: "purge" });
  check("POST /api/wf purge", purge.ok === true && Array.isArray(purge.removed) && typeof purge.remaining === "number",
    "清理 " + (purge.removed || []).length + " / 剩 " + purge.remaining);

  /* ---- 配方版本：把「改坏能退回去」整条链路走一遍 ----
     首次保存没有旧内容 → 不建版本；第二次内容变了 → 留下 rev 1（=改坏前那份）。 */
  const s1 = await req("POST", "/api/wf", {
    action: "save",
    workflow: { name: "__smoke_ver__", steps: [{ server: "windows", tool: "Snapshot", args: {} }] },
  });
  check("save 首次", s1.ok === true && s1.rev === null, "rev=" + s1.rev);
  const s2 = await req("POST", "/api/wf", {
    action: "save",
    workflow: { name: "__smoke_ver__", steps: [
      { server: "windows", tool: "Snapshot" }, { server: "windows", tool: "Screenshot" },
    ] },
  });
  check("save 二次留下旧版本", s2.ok === true && Number(s2.rev) === 1, "rev=" + s2.rev);
  const s3 = await req("POST", "/api/wf", {
    action: "save",
    workflow: { name: "__smoke_ver__", steps: [
      { server: "windows", tool: "Snapshot" }, { server: "windows", tool: "Screenshot" },
    ] },
  });
  check("内容没变不建版本", s3.ok === true && s3.rev === null, "rev=" + s3.rev);

  const vers = await req("POST", "/api/wf", { action: "versions", name: "__smoke_ver__" });
  check("POST /api/wf versions", vers.ok === true && (vers.items || []).length === 1,
    "版本 " + (vers.items || []).length + " 个");
  const vget = await req("POST", "/api/wf", { action: "version-get", name: "__smoke_ver__", rev: 1 });
  check("version-get 原文可取", vget.ok === true && vget.parsed && vget.parsed.steps.length === 1);
  const vdiff = await req("POST", "/api/wf", { action: "version-diff", name: "__smoke_ver__", from: 1, to: 1 });
  check("version-diff 同版无差异", vdiff.ok === true && (vdiff.changes || []).length === 0);
  const vrb = await req("POST", "/api/wf", { action: "version-rollback", name: "__smoke_ver__", rev: 1 });
  check("version-rollback", vrb.ok === true && vrb.steps === 1, "steps=" + vrb.steps);
  const cur = await req("POST", "/api/wf", { action: "get", name: "__smoke_ver__" });
  check("回滚后配方确实回到 1 步", cur.ok === true && cur.workflow.steps.length === 1);

  /* ---- 编排图校验：环必须挡在保存口，不能等点运行才炸 ---- */
  const gBad = await req("POST", "/api/wf", { action: "graph-validate",
    graph: { nodes: [{ id: "a", kind: "step" }, { id: "b", kind: "step" }],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "a" }] } });
  check("graph-validate 有环 → 拒绝", gBad.ok === false && (gBad.errors || []).some((e) => e.includes("环")));
  const gGood = await req("POST", "/api/wf", { action: "graph-validate",
    graph: { nodes: [{ id: "a", kind: "step" }, { id: "b", kind: "approval", ask: "确认后继续" }],
      edges: [{ from: "a", to: "b" }] } });
  check("graph-validate 合法图给出拓扑序",
    gGood.ok === true && (gGood.order || []).join(",") === "a,b", "order=" + (gGood.order || []).join(","));

  /* ---- 步级轨迹：不存在的运行返回空，不是 500 ---- */
  const tr = await req("POST", "/api/wf", { action: "trace", runId: "__none__" });
  check("POST /api/wf trace 空运行", tr.ok === true && Array.isArray(tr.entries) && tr.entries.length === 0);
  const trr = await req("POST", "/api/wf", { action: "trace-runs" });
  check("POST /api/wf trace-runs", trr.ok === true && Array.isArray(trr.runs) && trr.stats);

  /* ---- OutcomeGate 的核心承诺：没动界面 ≠ 成功 ----
     空步骤配方一步也没执行，拿不到任何正向证据 → 必须落 needs_review。
     这条是整轮改造的地基判据：ok 不能等于「没抛异常」。 */
  await req("POST", "/api/wf", { action: "save", workflow: { name: "__smoke_empty__", steps: [] } });
  const playEmpty = await req("POST", "/api/wf", { action: "play", name: "__smoke_empty__" });
  check("空配方回放 → 拿不到证据判 needs_review",
    playEmpty.ok === true && playEmpty.result && playEmpty.result.verdict === "needs_review"
      && playEmpty.result.ok === true,
    "verdict=" + (playEmpty.result && playEmpty.result.verdict) + " / ok=" + (playEmpty.result && playEmpty.result.ok));

  /* 判定结论必须落到账本里，否则面板看不到、排障也查不到（白名单丢字段的老坑）。 */
  const runs2 = await req("POST", "/api/wf", { action: "runs", limit: 5 });
  const last = (runs2.runs || []).find((x) => x.workflow === "__smoke_empty__");
  check("账本里能查到 verdict / evidenceLevel",
    !!last && last.status === "needs_review" && last.verdict === "needs_review" && last.evidenceLevel === "none",
    last ? ("status=" + last.status + " verdict=" + last.verdict) : "没查到这条运行");

  /* ---- 复核闭环：needs_review 的出口 ----
     守的红线是「复核不改判」：人看过 ≠ 系统有证据。 */
  const q0 = await req("POST", "/api/wf", { action: "review-queue" });
  check("review-queue 列出待复核运行",
    q0.ok === true && (q0.items || []).some((x) => x.runId === (last && last.runId)),
    "待复核 " + q0.pending + " / 已复核 " + q0.reviewed);

  const rvBad = await req("POST", "/api/wf", { action: "review",
    runId: (last && last.runId) || "", reviewVerdict: "looks-fine" });
  check("review 拒绝非法结论（不接受拍脑袋的三档以外）",
    rvBad.ok === false && /accepted/.test(String(rvBad.error || "")), String(rvBad.error || "").slice(0, 30));

  const rvNone = await req("POST", "/api/wf", { action: "review", runId: "wr-nope" });
  check("review 不存在的运行 → 明确报错", rvNone.ok === false);

  const rvOk = await req("POST", "/api/wf", { action: "review",
    runId: (last && last.runId) || "", reviewVerdict: "accepted", note: "导出窗口正常" });
  check("review 记下复核痕迹", rvOk.ok === true && rvOk.run
    && rvOk.run.reviewedAt > 0 && rvOk.run.reviewVerdict === "accepted"
    && rvOk.run.reviewNote === "导出窗口正常");
  check("复核不改判：status / verdict 仍是 needs_review",
    rvOk.ok === true && rvOk.run.status === "needs_review" && rvOk.run.verdict === "needs_review",
    "status=" + (rvOk.run && rvOk.run.status) + " verdict=" + (rvOk.run && rvOk.run.verdict));

  const q1 = await req("POST", "/api/wf", { action: "review-queue" });
  check("复核后待复核数下降、已复核数上升",
    q1.ok === true && q1.pending === Math.max(0, (q0.pending || 0) - 1)
      && (q1.items || []).every((x) => x.runId !== (last && last.runId)),
    "待复核 " + q1.pending + " / 已复核 " + q1.reviewed);

  const qAll = await req("POST", "/api/wf", { action: "review-queue", scope: "all" });
  check("scope=all 能看到复核过的那条",
    qAll.ok === true && (qAll.items || []).some((x) => x.runId === (last && last.runId) && x.reviewedAt > 0));

  const rvList = await req("POST", "/api/wf", { action: "runs", reviewState: "reviewed", limit: 50 });
  check("runs 支持按复核状态筛选",
    rvList.ok === true && (rvList.runs || []).every((x) => !!x.reviewedAt)
      && (rvList.runs || []).some((x) => x.runId === (last && last.runId)),
    "已复核 " + (rvList.runs || []).length + " 条");

  const rvUndo = await req("POST", "/api/wf", { action: "unreview", runId: (last && last.runId) || "" });
  check("unreview 撤销复核，回到待复核", rvUndo.ok === true && !rvUndo.run.reviewedAt
    && rvUndo.run.status === "needs_review");


  /* ---- 界面证据候选（tree_state 的唯一证据来源） ----
     正向提取靠单测（16 项：噪音过滤 / 易变片段清洗 / 上限 / 去重）；
     这里只验"接线对、无证据时说得清"——真去动界面才能产生证据，冒烟不能碰 GUI。 */
  const evNo = await req("POST", "/api/wf", { action: "outcome-evidence", name: "__smoke_never_run__" });
  check("没跑完过的配方 → 明确说「先跑一次」",
    evNo.ok === false && /跑/.test(String(evNo.error || "")), String(evNo.error || "").slice(0, 24));

  const evNoName = await req("POST", "/api/wf", { action: "outcome-evidence" });
  check("outcome-evidence 缺名称 → 明确报错", evNoName.ok === false);

  const evEmpty = await req("POST", "/api/wf", {
    action: "outcome-evidence", name: "__smoke_empty__", runId: (last && last.runId) || "",
  });
  check("没做探测的运行 → 候选为空，但说清为什么",
    evEmpty.ok === true && Array.isArray(evEmpty.lines) && evEmpty.lines.length === 0
      && !!evEmpty.reason, String(evEmpty.reason || "").slice(0, 30));

  /* 轨迹的 end 记录必须带 evidenceLines 字段：缺了它 outcome-evidence 就永远读不到。
     （白名单 / sanitize 丢字段是这个项目里反复踩的坑。） */
  const evTrace = await req("POST", "/api/wf", { action: "trace", runId: (last && last.runId) || "" });
  const evEnd = (evTrace.entries || []).filter((e) => e.t === "end").pop();
  check("轨迹 end 记录带 evidenceLines 字段",
    !!evEnd && Array.isArray(evEnd.evidenceLines), evEnd ? "字段在" : "没有 end 记录");

  /* 整条闭环：候选 → 勾选 → 写入配方。这里直接用一条 tree_state 走一遍。 */
  await req("POST", "/api/wf", { action: "save", workflow: { name: "__smoke_tree__", steps: [] } });
  const appTree = await req("POST", "/api/wf", {
    action: "outcome-apply", name: "__smoke_tree__",
    postconditions: [{ kind: "tree_state", text: "导出成功" }],
  });
  check("tree_state 判据能写进配方（候选→勾选→落盘整条路通）",
    appTree.ok === true && appTree.postconditions.length === 1
      && appTree.postconditions[0].text === "导出成功");
  const treeGet = await req("POST", "/api/wf", { action: "get", name: "__smoke_tree__" });
  check("tree_state 判据真的落到配方里",
    treeGet.ok === true
      && (treeGet.workflow.outcome?.postconditions || [])[0]?.kind === "tree_state");


  /* ---- 判据归纳：把「你得自己写 outcome」这道坎走一遍 ----
     一条带窗口信息 + 产物路径的配方，应该同时给出 window_state 与 data_readback。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_outcome__",
    steps: [
      { server: "windows", tool: "Click", args: { anchor: "导出" }, win: { title: "月度报表 - 记事本" } },
      { server: "windows", tool: "Type", args: { path: "D:\\导出\\月度报表.xlsx" }, win: { title: "月度报表 - 记事本" } },
    ],
  } });
  const sug = await req("POST", "/api/wf", { action: "outcome-suggest", name: "__smoke_outcome__" });
  const kinds = (sug.candidates || []).map((c) => c.kind);
  check("outcome-suggest 给出窗口 + 回读两类候选",
    sug.ok === true && kinds.includes("window_state") && kinds.includes("data_readback"),
    "候选 " + kinds.join("/"));
  const rb = (sug.candidates || []).find((c) => c.kind === "data_readback");
  check("回读候选带真实路径与存在性判据",
    !!rb && rb.postcondition.path === "D:\\导出\\月度报表.xlsx" && rb.postcondition.exists === true);

  /* 只读接口不能偷偷改配方。 */
  const before = await req("POST", "/api/wf", { action: "get", name: "__smoke_outcome__" });
  check("outcome-suggest 不改配方", before.ok === true && !before.workflow.outcome);

  const app1 = await req("POST", "/api/wf", {
    action: "outcome-apply", name: "__smoke_outcome__",
    postconditions: [{ kind: "window_state", titleIncludes: "月度报表 - 记事本" },
      { kind: "data_readback", path: "D:\\导出\\月度报表.xlsx", exists: true, minBytes: 1 }],
  });
  check("outcome-apply 写入成功", app1.ok === true && app1.postconditions.length === 2,
    "写进 " + (app1.postconditions || []).length + " 条");
  const after = await req("POST", "/api/wf", { action: "get", name: "__smoke_outcome__" });
  check("判据真的落到配方里",
    after.ok === true && (after.workflow.outcome?.postconditions || []).length === 2);

  /* 拼错 kind 必须被拒，否则会变成"永远需复核"且查不出原因。 */
  const appBad = await req("POST", "/api/wf", {
    action: "outcome-apply", name: "__smoke_outcome__",
    postconditions: [{ kind: "checkpoint_readback", path: "x" }],
  });
  check("outcome-apply 拒绝未知 kind", appBad.ok === false && /kind/.test(String(appBad.error || "")),
    String(appBad.error || "").slice(0, 30));

  const sug2 = await req("POST", "/api/wf", { action: "outcome-suggest", name: "__smoke_outcome__" });
  check("已有判据时不再给建议（不盖掉用户写好的）",
    sug2.ok === true && (sug2.candidates || []).length === 0 && sug2.existing === 2);

  /* 写入也留了版本：这条能回滚。 */
  const overVer = await req("POST", "/api/wf", { action: "versions", name: "__smoke_outcome__" });
  check("写入判据前留了版本快照", overVer.ok === true && (overVer.items || []).length >= 1,
    "版本 " + (overVer.items || []).length + " 个");


  /* ---- 断点续跑：安全门必须先挡住，再谈"接着跑" ----
     这一整段的价值在「拒绝」而不是「放行」：放行错了会把已经做过的不可逆动作做第二遍。
     断点文件直接写进临时 DATA_DIR（和 bridge 看到的是同一个目录），
     这样能精确构造"状态不明"的各种情形，不必真的跑 GUI。 */
  const cpDir = path.join(DIR, "wf-checkpoints");
  const cpFile = (n) => path.join(cpDir, n + ".json");
  const putCp = (n, rec) => {
    fs.mkdirSync(cpDir, { recursive: true });
    fs.writeFileSync(cpFile(n), JSON.stringify(rec), "utf8");
  };

  const RES_STEPS = [
    { server: "windows", tool: "Snapshot", args: {} },
    { server: "windows", tool: "Snapshot", args: {} },
    { server: "windows", tool: "Snapshot", args: {} },
  ];
  const RES_DIGEST = recipeDigest(RES_STEPS);
  await req("POST", "/api/wf", { action: "save", workflow: { name: "__smoke_res__", steps: RES_STEPS } });
  const cpNone = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res__" });
  check("没有断点时 checkpoint 明确说 no_checkpoint（不假装可续）",
    cpNone.ok === true && cpNone.resumable === false && cpNone.code === "no_checkpoint",
    "code=" + cpNone.code);
  const rNone = await req("POST", "/api/wf", { action: "resume", name: "__smoke_res__" });
  check("没有断点时 resume 拒绝，且不退化成从头跑",
    rNone.ok === false && rNone.code === "no_checkpoint" && !rNone.result,
    "code=" + rNone.code);

  /* 断点说"前 1 步做完了"，但收据里没有它 → 状态不明，拒绝。
     这是整套机制的地基：下标是自述，收据才是证据。 */
  putCp("__smoke_res__", { workflow: "__smoke_res__", runId: "wr-forged", nextIndex: 1,
    total: 3, stepsDigest: RES_DIGEST, vars: {},
    lastIdem: "runId|1|windows|Snapshot|deadbeef", reason: "", at: Date.now() });
  const cpUn = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res__" });
  check("断点前那步没有已结算收据 → 拒绝（不赌「大概做完了」）",
    cpUn.ok === true && cpUn.resumable === false && cpUn.code === "state_unconfirmed",
    "code=" + cpUn.code);
  const rUn = await req("POST", "/api/wf", { action: "resume", name: "__smoke_res__" });
  check("状态不明时 resume 也拒绝", rUn.ok === false && rUn.code === "state_unconfirmed",
    "code=" + rUn.code);

  /* 配方改过（步数对不上）→ 旧索引不可信。 */
  putCp("__smoke_res__", { workflow: "__smoke_res__", runId: "wr-forged2", nextIndex: 1,
    total: 9, stepsDigest: RES_DIGEST, vars: {}, lastIdem: "k", reason: "", at: Date.now() });
  const cpCh = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res__" });
  check("配方改过（步数对不上）→ 拒绝", cpCh.ok === true && cpCh.resumable === false
    && cpCh.code === "recipe_changed", "code=" + cpCh.code);

  /* 步数一样但内容改过 —— 只比步数的实现会在这里放行，续跑就会接错位置。
     造一条 digest 对不上的断点：配方还是 3 步，指纹来自另一份内容。 */
  putCp("__smoke_res__", { workflow: "__smoke_res__", runId: "wr-forged3", nextIndex: 1,
    total: 3, stepsDigest: recipeDigest([{ server: "windows", tool: "Click", args: { x: 1, y: 2 } }]),
    vars: {}, lastIdem: SEED_IDEM, reason: "", at: Date.now() });
  const cpDig = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res__" });
  check("步数相同但内容改过 → 拒绝续跑（内容指纹对不上）",
    cpDig.ok === true && cpDig.resumable === false && cpDig.code === "recipe_changed"
      && /内容变过/.test(String(cpDig.reason || "")), "code=" + cpDig.code);

  /* 旧版断点没有指纹：无从核对就不放行 —— 宁可从头跑，也不赌。 */
  putCp("__smoke_res__", { workflow: "__smoke_res__", runId: "wr-forged4", nextIndex: 1,
    total: 3, vars: {}, lastIdem: SEED_IDEM, reason: "", at: Date.now() });
  const cpOld = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res__" });
  check("断点没有内容指纹（旧版）→ 拒绝，并说明为什么",
    cpOld.ok === true && cpOld.resumable === false && cpOld.code === "recipe_changed"
      && /没有内容指纹/.test(String(cpOld.reason || "")), "code=" + cpOld.code);

  /* 含控制流的配方一律不可续：顶层索引表达不了循环体中间的位置。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_res_loop__",
    steps: [{ type: "loop", times: 2, body: [{ server: "windows", tool: "Snapshot", args: {} }] }],
  } });
  putCp("__smoke_res_loop__", { workflow: "__smoke_res_loop__", nextIndex: 1, total: 1,
    stepsDigest: recipeDigest([{ type: "loop", times: 2, body: [] }]),
    vars: {}, lastIdem: "k", reason: "", at: Date.now() });
  const cpLoop = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res_loop__" });
  check("含 loop 的配方 → has_control_flow 拒绝，且面板能提前知道",
    cpLoop.ok === true && cpLoop.resumable === false && cpLoop.code === "has_control_flow"
      && cpLoop.linear === false, "code=" + cpLoop.code);

  /* 编排图同理：节点内可能重复执行同一段。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_res_graph__", steps: [],
    graph: { nodes: [{ id: "a", kind: "step", steps: [] }], edges: [] },
  } });
  const cpG = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res_graph__" });
  check("编排图配方 → graph_recipe 拒绝", cpG.ok === true && cpG.resumable === false
    && cpG.code === "graph_recipe", "code=" + cpG.code);

  /* 不存在的配方：明确报错，不抛 500。 */
  const cpBad = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res_nope__" });
  check("不存在的配方 → no_workflow（不 500）",
    cpBad.ok === false && cpBad.code === "no_workflow", "code=" + cpBad.code);

  /* 唯一能放行的情形：线性配方 + 断点在中间 + 断点前那步的收据已结算。
     这条走通到"真的从第 2 步开始跑"，才算接线没接歪。 */
  putCp("__smoke_res__", { workflow: "__smoke_res__", runId: "wr-seed", nextIndex: 1,
    total: 3, stepsDigest: RES_DIGEST, vars: { seed: "yes" }, lastIdem: SEED_IDEM,
    reason: "", at: Date.now() });
  const cpOk = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res__" });
  check("线性配方 + 收据已结算 → 允许续跑，并指出从第几步起",
    cpOk.ok === true && cpOk.resumable === true && cpOk.nextIndex === 1 && cpOk.lastSettled === true,
    "nextIndex=" + cpOk.nextIndex + " / " + cpOk.reason);

  const rOk = await req("POST", "/api/wf", { action: "resume", name: "__smoke_res__" });
  check("resume 真的带着续跑起点进了执行器（不是从头跑）",
    rOk.resumedFrom === 1 && rOk.result && rOk.result.resumedFrom === 1,
    "resumedFrom=" + rOk.resumedFrom + " / play.resumedFrom=" + (rOk.result && rOk.result.resumedFrom)
      + " / ok=" + (rOk.result && rOk.result.ok));

  /* 轨迹里要留得下"这次跳过了几步"：续跑出问题时第一个要查的就是它。 */
  const rTrace = await req("POST", "/api/wf", { action: "trace", runId: (rOk.result && rOk.result.runId) || "" });
  check("轨迹里留了续跑起点（排障时能回答「跳过了几步」）",
    rTrace.ok === true && (rTrace.entries || []).some((e) => Number(e.resumeFrom) === 1),
    "条目 " + (rTrace.entries || []).length);

  /* 跑成功了断点必须作废 —— 留着会让下次续跑跳过刚刚已经做完的步骤。
     只在这次真的跑通时断言（工具不可用的机器上不算这条的错）。 */
  const cpCleared = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res__" });
  check("跑完就作废断点（否则下次续跑会跳过刚做完的步骤）",
    !(rOk.result && rOk.result.ok) || cpCleared.code === "no_checkpoint",
    "play.ok=" + (rOk.result && rOk.result.ok) + " / code=" + cpCleared.code);

  /* 不带副作用、也不落收据的步（set）不能推进断点 ——
     否则断点会声称"几步都做完了"，而没有任何收据能证明它。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_res_noop__",
    steps: [{ type: "set", name: "a", value: "1" }, { type: "set", name: "b", value: "2" }],
  } });
  await req("POST", "/api/wf", { action: "play", name: "__smoke_res_noop__" });
  const cpNoop = await req("POST", "/api/wf", { action: "checkpoint", name: "__smoke_res_noop__" });
  check("只会本地赋值的步不推进断点（没有收据就没有可确认的边界）",
    cpNoop.ok === true && cpNoop.resumable === false && cpNoop.code === "no_checkpoint",
    "code=" + cpNoop.code + " / cp=" + JSON.stringify((cpNoop.checkpoint || {}).nextIndex ?? null));


  /* ---- 子流程共享父级轨迹：子流程内部挂在哪一步，必须查得到 ----
     用 orb 这个本地伪服务的未知工具名当失败源：它同步抛错、不碰 GUI，确定性最好。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_sub__", steps: [{ server: "orb", tool: "__nope__", args: {} }],
  } });
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_subparent__", steps: [],
    graph: {
      nodes: [
        { id: "a", kind: "step", steps: [] },
        { id: "s", kind: "subflow", workflow: "__smoke_sub__" },
      ],
      edges: [{ from: "a", to: "s" }],
    },
  } });
  const pSub = await req("POST", "/api/wf", { action: "play", name: "__smoke_subparent__" });
  check("子流程失败会冒泡成父层失败",
    pSub.ok === true && pSub.result && pSub.result.ok === false
      && String(pSub.result.error || "").includes("子流程"),
    String((pSub.result && pSub.result.error) || "").slice(0, 40));
  const subTrace = await req("POST", "/api/wf", { action: "trace", runId: (pSub.result && pSub.result.runId) || "" });
  const subEntries = subTrace.entries || [];
  check("子流程内部的步进了同一条轨迹（带 nested + node）",
    subEntries.some((e) => e.nested === true && e.node === "s" && e.ok === false),
    "条目 " + subEntries.length + " / nested=" + subEntries.filter((e) => e.nested).length);
  check("子流程不再自己写第二条 begin（一条运行一条轨迹）",
    subEntries.filter((e) => e.t === "begin").length === 1,
    "begin " + subEntries.filter((e) => e.t === "begin").length + " 条");


  /* ---- 回放前预检：动手之前先把「哪几步会失效」说清楚 ----
     这里不抓真界面（临时实例没有桌面），只验静态层与接口形状：
     必然失败的要判不通过，查不出来的要明说，不能假装通过。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_pf__",
    steps: [{ server: "windows", tool: "Click", args: { loc: [10, 20] } }],
  } });
  const pf1 = await req("POST", "/api/wf", { action: "preflight", name: "__smoke_pf__", noSnapshot: true });
  check("预检能返回结论（ok 是接口成功，passed 才是预检结论）",
    pf1.ok === true && pf1.passed === true && typeof pf1.summary === "string",
    "summary=" + String(pf1.summary || "").slice(0, 30));
  check("没抓快照时明说「锚点未核对」，不假装通过",
    pf1.hasSnapshot === false && /未抓界面快照/.test(String(pf1.summary || "")),
    "summary=" + String(pf1.summary || "").slice(0, 40));

  /* 缺工具名 = 必然失败，必须 passed=false 且给出 block 级问题。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_pf_bad__", steps: [{ args: { loc: [1, 2] } }],
  } });
  const pf2 = await req("POST", "/api/wf", { action: "preflight", name: "__smoke_pf_bad__", noSnapshot: true });
  check("缺工具名 → 预检判不通过（必然失败的那类才劝停）",
    pf2.ok === true && pf2.passed === false && (pf2.blocked || []).length >= 1,
    "blocked=" + (pf2.blocked || []).length);

  /* 调不存在的配方：明确报错，不 500。 */
  const pf3 = await req("POST", "/api/wf", { action: "preflight", name: "__smoke_pf_nope__" });
  check("预检不存在的配方 → 明确报错（不 500）", pf3.ok === false && !!pf3.error);

  /* ---- 删配方要先查子流程引用 ----
     删掉被引用的那条，引用方要到运行时才炸；这里把「先拦住、说清是谁、
     可以强删」这三件事都锁住。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_ref_child__", steps: [{ type: "set", name: "x", value: "1" }],
  } });
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_ref_parent__", steps: [{ type: "subflow", workflow: "__smoke_ref_child__" }],
  } });
  const del1 = await req("POST", "/api/wf", { action: "delete", name: "__smoke_ref_child__" });
  check("删被引用的配方 → 先拦住并说清是谁在引用",
    del1.ok === false && del1.code === "referenced" && (del1.referrers || []).length === 1,
    "code=" + del1.code + " / " + JSON.stringify((del1.referrers || [])[0] || {}));
  check("拦住时指名道姓：谁、在第几步引用",
    /__smoke_ref_parent__/.test(String(del1.error || "")) && /第 1 步/.test(String(del1.error || "")));

  /* 编排图里的 subflow 节点同样算引用（很容易漏的那一路）。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_ref_graph__", steps: [],
    graph: { nodes: [{ id: "n1", kind: "subflow", workflow: "__smoke_ref_child__" }], edges: [] },
  } });
  const del2 = await req("POST", "/api/wf", { action: "delete", name: "__smoke_ref_child__" });
  check("编排图里的 subflow 节点也算引用",
    del2.ok === false && del2.code === "referenced" && (del2.referrers || []).length === 2,
    "referrers=" + (del2.referrers || []).map((x) => x.name).join(","));

  /* 强删：用户确认过就放行（两条一起删是合理需求）。 */
  const del3 = await req("POST", "/api/wf", { action: "delete", name: "__smoke_ref_child__", force: true });
  check("确认后强删放行（不当场把人卡死）", del3.ok === true && del3.undoable === true);

  /* ---- 编排图编辑器的数据形状要能被后端原样接下 ----
     编辑器只做三件事：加节点、选类型、指定依赖。它产出的对象必须和
     wfDag 认的形状一致；这里按编辑器的 collect() 输出构造一遍走完整链路。 */
  const editorGraph = {
    nodes: [
      { id: "a", kind: "step", steps: [] },
      { id: "b", kind: "approval", ask: "确认导出后继续" },
      { id: "c", kind: "step", steps: [] },
    ],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
  };
  const eSave = await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_editor__", steps: [{ type: "set", name: "k", value: "1" }], graph: editorGraph,
  } });
  check("编辑器形状的编排图能保存", eSave.ok === true);
  const eGet = await req("POST", "/api/wf", { action: "get", name: "__smoke_editor__" });
  check("保存后 steps 与 graph 同时保留（编辑器是合并写，不是覆盖整条配方）",
    eGet.ok === true && (eGet.workflow.steps || []).length === 1
      && (eGet.workflow.graph?.nodes || []).length === 3);
  const eVal = await req("POST", "/api/wf", { action: "graph-validate", graph: editorGraph });
  check("编辑器形状通过校验并给出执行顺序",
    eVal.ok === true && (eVal.order || []).join(",") === "a,b,c", "order=" + (eVal.order || []).join(","));
  const ePlay = await req("POST", "/api/wf", { action: "play", name: "__smoke_editor__" });
  check("按图执行会在人工节点停下（fail-closed）",
    ePlay.ok === true && ePlay.result && ePlay.result.pendingApproval === "b",
    "pending=" + (ePlay.result && ePlay.result.pendingApproval));

  /* 编辑器的「清空」= delete workflow.graph，回到线性执行。
     这条得锁住：否则用户点了清空、界面看着空了，实际旧图还在跑。 */
  const eClear = await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_editor__", steps: [{ type: "set", name: "k", value: "1" }],
  } });
  const eGet2 = await req("POST", "/api/wf", { action: "get", name: "__smoke_editor__" });
  check("清空编排图后配方回到线性执行",
    eClear.ok === true && !eGet2.workflow.graph);
  const ePlay2 = await req("POST", "/api/wf", { action: "play", name: "__smoke_editor__" });
  check("清空后不再卡人工节点（走的已经是线性步）",
    ePlay2.ok === true && ePlay2.result && ePlay2.result.pendingApproval === "");


  /* ---- 受限编排：人工闸门 / 绕过 / 有环拒绝 ----
     全用空 steps，不碰 GUI，只验控制流本身。 */
  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_gate__", steps: [],
    graph: { nodes: [{ id: "a", kind: "step", steps: [] }, { id: "b", kind: "approval", ask: "确认后继续" }],
      edges: [{ from: "a", to: "b" }] },
  } });
  const pGate = await req("POST", "/api/wf", { action: "play", name: "__smoke_gate__" });
  check("人工节点未批准 → fail-closed 停在闸门",
    pGate.ok === true && pGate.result && pGate.result.pendingApproval === "b"
      && pGate.result.verdict === "needs_review",
    "pending=" + (pGate.result && pGate.result.pendingApproval));
  const pGateOk = await req("POST", "/api/wf", { action: "play", name: "__smoke_gate__", approved: ["b"] });
  check("人工节点已批准 → 闸门放行", pGateOk.ok === true && pGateOk.result && pGateOk.result.pendingApproval === "");

  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_bypass__", steps: [],
    graph: { nodes: [{ id: "g", kind: "approval", ask: "确认", onMissing: "continue" }], edges: [] },
  } });
  const pBy = await req("POST", "/api/wf", { action: "play", name: "__smoke_bypass__" });
  check("onMissing=continue 时不卡住（警告已记日志）",
    pBy.ok === true && pBy.result && pBy.result.pendingApproval === "");

  await req("POST", "/api/wf", { action: "save", workflow: {
    name: "__smoke_cycle__", steps: [],
    graph: { nodes: [{ id: "x", kind: "step", steps: [] }, { id: "y", kind: "step", steps: [] }],
      edges: [{ from: "x", to: "y" }, { from: "y", to: "x" }] },
  } });
  const pCyc = await req("POST", "/api/wf", { action: "play", name: "__smoke_cycle__" });
  check("有环的编排图拒绝执行（不跑半张图）",
    pCyc.ok === true && pCyc.result && pCyc.result.ok === false
      && String(pCyc.result.error || "").includes("编排图不合法"),
    String((pCyc.result && pCyc.result.error) || "").slice(0, 40));


  /* 步级轨迹也应该有：begin → end 两行起（空配方没有步）。 */
  const trOne = await req("POST", "/api/wf", { action: "trace", runId: (last && last.runId) || "" });
  check("空配方也有 begin/end 轨迹",
    trOne.ok === true && (trOne.entries || []).some((e) => e.t === "begin")
      && (trOne.entries || []).some((e) => e.t === "end"),
    "条目 " + (trOne.entries || []).length);

  const tAdd = await req("POST", "/api/triggers", {
    action: "add", trigger: { workflow: "__smoke__", type: "interval", minutes: 999, enabled: false },
  });
  check("POST /api/triggers add 默认 observe", tAdd.ok === true && tAdd.trigger && tAdd.trigger.mode === "observe",
    "mode=" + (tAdd.trigger && tAdd.trigger.mode));
  const tid = tAdd.trigger && tAdd.trigger.id;
  const tMode = await req("POST", "/api/triggers", { action: "mode", id: tid, mode: "auto", locked: true });
  check("POST /api/triggers mode 锁定",
    tMode.ok === true && tMode.trigger.mode === "auto" && tMode.trigger.modeLocked === true);
  const tDel = await req("POST", "/api/triggers", { action: "remove", id: tid });
  check("POST /api/triggers remove", tDel.ok === true);

  const stop = await req("GET", "/api/stop/report");
  check("GET /api/stop/report",
    stop.ok === true && stop.stop && Array.isArray(stop.affected) && Array.isArray(stop.resumable),
    "未收口 " + stop.openTickets + " / 受影响 " + stop.affected.length + " / 可续跑 " + stop.resumable.length);

  const tickets = await req("GET", "/api/tickets?open=1&limit=20");
  check("GET /api/tickets open=1", tickets.ok === true && Array.isArray(tickets.items));

  const affect = await req("POST", "/api/ops", { action: "affect.status" });
  check("POST /api/ops affect.status", affect.ok === true && affect.data && affect.data.stats);
} catch (e) {
  fail++;
  console.log("  FAIL 冒烟异常：" + (e && e.stack ? e.stack : e));
} finally {
  console.log("\nSMOKE pass=" + pass + " fail=" + fail);
  child.kill();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
