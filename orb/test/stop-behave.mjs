/* 急停行为验收（一次性脚本，跑完即可删）
 * 四个阶段，对应四类"急停停不住"的真实漏法：
 *   A 会话已热：在途 MCP 调用必须被杀，job 标 stopped（不是 failed）
 *   B 急停期间：非豁免工具派单必须 409，且带 stopped:true
 *   C 会话冷启动中按下急停：这次调用不许跑完再假装成功
 *   D 恢复后：普通任务照常完成，且不带 stopped/stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORB = path.resolve(HERE, "..");          // orb/test → orb（桥的工作目录）
const BASE = "http://127.0.0.1:19387";
const token = JSON.parse(fs.readFileSync(path.join(ORB, ".bridge.json"), "utf8")).token;
const H = { "X-Orb-Token": token, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let bad = 0;
function ck(cond, name, detail) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${detail ? "  —  " + detail : ""}`);
  if (!cond) bad++;
}
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(b || {}) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const get = (p) => fetch(BASE + p, { headers: H }).then((r) => r.json());
async function waitJob(id, ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await get("/api/job/" + id);
    const j = r && r.job;
    if (j && j.status !== "running") return j;
    await sleep(200);
  }
  const r = await get("/api/job/" + id);
  return (r && r.job) || null;
}
const stop = (reason) => post("/api/stop", { action: "stop", reason });
const resume = () => post("/api/stop", { action: "resume" });

console.log("\n[急停行为] 起点");
const s0 = await get("/api/status");
ck(s0.stop.on === false, "未在急停", `epoch=${s0.stop.epoch}`);
await resume();   // 清掉上一次遗留的急停态

// 预热 windows 会话，让 A 阶段落在"真正在途"而不是冷启动上
await post("/api/call", { server: "windows", tool: "Wait", args: { duration: 100 } });

console.log("\n[A] 会话已热：在途调用被杀");
const jA = await post("/api/dispatch", { server: "windows", tool: "Wait", args: { duration: 8000 } });
ck(jA.ok && jA.jobId, "派单成功", `jobId=${jA.jobId}`);
await sleep(700);
const spA = await stop("验收A：热态打断");
ck(spA.ok && spA.stop.on === true, "急停生效", `epoch=${spA.stop.epoch}`);
const jAr = await waitJob(jA.jobId, 6000);
ck(!!jAr && jAr.status !== "running", "任务已结算", jAr && `${jAr.status} stopped=${jAr.stopped} stale=${jAr.stale}`);
ck(!!jAr && jAr.stopped === true, "在途任务标 stopped（不算失败）", jAr && String(jAr.error || "").slice(0, 60));

console.log("\n[B] 急停期间派单必须被拒");
const dB = await post("/api/dispatch", { server: "windows", tool: "Wait", args: { duration: 100 } });
ck(dB.status === 409 && dB.ok === false && dB.stopped === true, "非豁免工具被 409 拒", `${dB.status} ${String(dB.error || "").slice(0, 50)}`);
const dEx = await post("/api/dispatch", { server: "orb", tool: "cursor_position", args: {} });
ck(dEx.status === 200, "只读豁免工具仍放行（设计如此）", `${dEx.status}`);
if (dEx.jobId) await waitJob(dEx.jobId, 5000);

console.log("\n[C] 冷启动窗口里按下急停");
await resume();
const jC = await post("/api/dispatch", { server: "windows", tool: "Wait", args: { duration: 5000 } });
ck(jC.ok && jC.jobId, "派单成功（会话已被上一轮断开，需冷启动）", `jobId=${jC.jobId}`);
await sleep(250);                       // 抢在 python 起完之前
const spC = await stop("验收C：冷启动窗口");
ck(spC.ok, "急停生效", `epoch=${spC.stop.epoch}`);
const jCr = await waitJob(jC.jobId, 30000);
ck(!!jCr && jCr.status !== "running", "任务已结算", jCr && `${jCr.status} stopped=${jCr.stopped} stale=${jCr.stale}`);
ck(!!jCr && (jCr.stopped === true || jCr.stale === true), "冷启动中的调用被判作废（不许假装成功）",
  jCr && (jCr.stopped ? "stopped" : jCr.stale ? "stale（结果作废）" : `都没标！status=${jCr.status}`));

console.log("\n[D] 恢复后照常干活");
const rp = await resume();
ck(rp.ok && rp.stop.on === false, "恢复生效", `epoch=${rp.stop.epoch}`);
const jD = await post("/api/dispatch", { server: "orb", tool: "cursor_position", args: {} });
ck(jD.ok && jD.jobId, "可再派单", `jobId=${jD.jobId}`);
const jDr = await waitJob(jD.jobId, 8000);
ck(!!jDr && jDr.status === "done" && !jDr.stopped && !jDr.stale, "普通任务正常完成",
  jDr && `${jDr.status} stopped=${jDr.stopped} stale=${jDr.stale}`);

console.log("\n[E] 单条刹车（区别于急停：只停这一单）");
const jE = await post("/api/dispatch", { server: "windows", tool: "Wait", args: { duration: 5000 } });
ck(jE.ok && jE.jobId, "派单成功", `jobId=${jE.jobId}`);
await sleep(600);
const ab = await post("/api/job/" + jE.jobId + "/abort", { reason: "验收E：单条刹车" });
ck(ab.ok === true, "单条停止接口可用", `killed=${ab.killed}`);
const jEr = await waitJob(jE.jobId, 10000);
ck(!!jEr && jEr.aborted === true, "任务标 aborted（不是 stopped）", jEr && String(jEr.error || "").slice(0, 40));
ck(!!jEr && /手动停止/.test(String(jEr.error || "")), "文案说清是手动停的（别被底层报错盖掉）",
  jEr && String(jEr.error || "").slice(0, 60));
const ab2 = await post("/api/job/" + jE.jobId + "/abort", { reason: "再点一次" });
ck(ab2.ok === false && ab2.code === "not-running", "重复点停止不会出错", ab2.code || ab2.error);

const tk = await get("/api/tickets");
const list = tk.items || [];
console.log(`\n[工单] 共 ${list.length} 条：` + list.slice(0, 6).map((t) => `${t.id}:${t.status}${t.stale ? "*stale" : ""}`).join("  "));
const stoppedOnes = list.filter((t) => t.status === "stopped");
ck(stoppedOnes.length >= 2, "被急停打断的工单记为 stopped", `${stoppedOnes.length} 条`);
ck(list.some((t) => t.status === "aborted"), "单条刹车记为 aborted", `${list.filter((t) => t.status === "aborted").length} 条`);
ck(tk.summary && tk.summary.open === 0, "收尾后没有幽灵在跑工单", `open=${tk.summary && tk.summary.open}`);

console.log(bad === 0 ? "\n急停行为验收：全部通过\n" : `\n急停行为验收：${bad} 项失败\n`);
process.exit(bad === 0 ? 0 : 1);
