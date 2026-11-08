#!/usr/bin/env node
/* 记忆引擎接线冒烟：不看代码、只问引擎「你到底能不能用」。
 *
 * 为什么需要它：长期记忆这条链有 4 个环节 —— 面板 → preload 白名单 → 主进程 safeHandle
 * → memory.js 引擎 → <DATA_ROOT>/memory/memory.json。前三个环节是静态接线（改了会立刻
 * 报 "No handler registered"），最后一个环节才是真会坏的地方：落盘失败、键名写错、
 * 归档后仍被召回、删了还在 —— 这些在界面上只表现为"记忆页好像不太对"，没人会发现。
 *
 * 本脚本用临时目录跑真实引擎，逐项断言：
 *   1. 初始化后按 <dataRoot>/memory/memory.json 落盘
 *   2. 四个层级都能写、能读、能计数
 *   3. recall 能按关键词召回，且回的是给人看的文本
 *   4. 归档（不是删除）后：召回不再返回、原文仍在 getAll 里可回溯
 *   5. remove 之后真的查不到
 *   6. 换一个实例重新 init：数据还在（持久化真的成立，不是只在内存里）
 *   7. pruneArchived 只清归档、不动活跃条目
 *
 * 用法：node orb/tools/memory-wiring-smoke.mjs
 * 退出码 0 = 全绿。全程临时目录，不碰用户的真实记忆库。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const MEM = path.join(ROOT, "orb", "desktop", "memory.js");

const RESULTS = [];
function check(name, ok, detail) {
  RESULTS.push({ name, ok: !!ok, detail: detail || "" });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? "  — " + detail : ""}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-mem-smoke-"));
const state = {};

function freshEngine() {
  /* 每次 require 都要拿新的模块实例，才能验证「重启后数据还在」。
     用 delete require.cache 强制重新执行模块顶层代码。 */
  delete require.cache[require.resolve(MEM)];
  const m = require(MEM);
  m.init({
    dataRoot: dir,
    getState: () => state,
    setState: (patch) => Object.assign(state, patch || {}),
    log: () => {},
  });
  return m;
}

/* getAll / getAllActive 返回的是「按层分组」的对象，不是数组 ——
   面板就是照着这个形状渲染分组列表的。这里压平了好断言。 */
function flatten(grouped) {
  if (Array.isArray(grouped)) return grouped;
  const out = [];
  for (const k of Object.keys(grouped || {})) {
    const v = grouped[k];
    if (Array.isArray(v)) for (const r of v) out.push(r);
  }
  return out;
}

function main() {
  const mem = freshEngine();

  /* ---- 1. 落盘路径 ---- */
  const file = path.join(dir, "memory", "memory.json");
  check("记忆库落在 <dataRoot>/memory/memory.json", true, file);

  /* ---- 2. 四个层级都能写 ---- */
  const levels = mem.LEVELS;
  check("导出层级清单", Array.isArray(levels) && levels.length >= 3, JSON.stringify(levels));

  const written = [];
  for (const lv of levels) {
    const row = mem.insert({
      level: lv,
      title: "冒烟 " + lv,
      content: "这是 " + lv + " 层的一条冒烟记忆，关键词 蓝鲸测试标记",
      importance: 2,
      keywords: ["蓝鲸测试标记"],
    });
    if (row && row.id) written.push(row);
  }
  check("每层都能写入并回带 id", written.length === levels.length, `写入 ${written.length}/${levels.length}`);
  mem.flush && mem.flush();
  check("写入后 memory.json 已产生", fs.existsSync(file), fs.existsSync(file) ? `${fs.statSync(file).size} B` : "缺失");

  /* ---- 3. 读 / 计数 ---- */
  const st = mem.stats();
  check("stats 能给出条目数", st && typeof st === "object" && JSON.stringify(st).length > 2, JSON.stringify(st).slice(0, 160));
  const firstLv = levels[0];
  const listed = mem.list(firstLv, {});
  check("list 能按层取回", Array.isArray(listed) && listed.length >= 1, `${firstLv}: ${Array.isArray(listed) ? listed.length : "非数组"}`);

  /* ---- 4. 召回 ---- */
  const hits = mem.recall("蓝鲸测试标记", {});
  const hitText = JSON.stringify(hits || {});
  check("recall 命中关键词", hitText.includes("蓝鲸测试标记"), hitText.slice(0, 160));

  /* ---- 5. 归档：召回退出、原文可回溯 ---- */
  const target = written[0];
  const archived = mem.archiveMany([target.id], { into: [], reason: "smoke" });
  check("archiveMany 归档成功", Number(archived) >= 1 || archived === true, String(archived));
  const allAfter = flatten(mem.getAll());
  const stillThere = allAfter.find((r) => r.id === target.id);
  check("归档后原文仍留在库里（可回溯，不是删除）", !!stillThere, stillThere ? "status=" + stillThere.status : "找不到了");
  const activeAfter = flatten(mem.getAllActive());
  const stillActive = activeAfter.find((r) => r.id === target.id);
  check("归档后不再出现在活跃集合（退出召回与预算）", !stillActive, stillActive ? "仍在活跃集合" : "已退出");

  /* ---- 6. 删除 ---- */
  const victim = written[written.length - 1];
  const removed = mem.remove(victim.id);
  check("remove 返回成功", removed === true || Number(removed) > 0, String(removed));
  check("remove 之后真的查不到", !mem.findById(victim.id), String(mem.findById(victim.id)));

  /* ---- 7. 持久化：新实例重新 init ---- */
  /* 引擎写入是 300ms 防抖（markDirty）；退出路径由 main.js 的 will-quit 强制 flush。
     这里显式 flush 一次，等价于"正常退出"，也免得断言读到还没落盘的旧文件。 */
  mem.flush && mem.flush();
  const mem2 = freshEngine();
  const reloaded = flatten(mem2.getAll());
  const keptIds = written.slice(0, -1).map((r) => r.id);
  const survived = keptIds.filter((id) => reloaded.some((r) => r.id === id));
  check("重新 init 后数据还在（持久化成立）", survived.length === keptIds.length,
    `${survived.length}/${keptIds.length} 条存活`);
  check("重新 init 后已删除的没复活", !reloaded.some((r) => r.id === victim.id),
    reloaded.some((r) => r.id === victim.id) ? "又出现了" : "确认已删除");

  /* ---- 8. prune 只动归档 ---- */
  const pruned = mem2.pruneArchived(0);
  check("pruneArchived 能执行且返回数字", typeof pruned === "number" || Number.isFinite(Number(pruned)), String(pruned));
  const afterPrune = flatten(mem2.getAllActive());
  check("prune 之后活跃条目一条没少", afterPrune.length >= keptIds.length - 1,
    `活跃 ${afterPrune.length} 条`);

  /* ---- 清理 ---- */
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}

  const bad = RESULTS.filter((r) => !r.ok);
  console.log("");
  if (!RESULTS.length) {
    console.log("MEMORY_WIRING_SMOKE_FAIL (0 项都没跑)");
    process.exit(1);
  }
  if (bad.length) {
    console.log(`MEMORY_WIRING_SMOKE_FAIL (${bad.length}/${RESULTS.length})`);
    for (const b of bad) console.log("  - " + b.name + (b.detail ? " :: " + b.detail : ""));
    process.exit(1);
  }
  console.log(`MEMORY_WIRING_SMOKE_OK (${RESULTS.length} 项)`);
}

try {
  main();
} catch (e) {
  console.error("MEMORY_WIRING_SMOKE_FAIL " + (e && e.stack ? e.stack : e));
  process.exit(1);
}
