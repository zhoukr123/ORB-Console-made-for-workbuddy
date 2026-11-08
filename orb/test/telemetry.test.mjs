/* telemetry 单测：全用注入的假 os / 假 exec / 假 sleeper，绝不读真实机器、绝不 sleep 真实时间。
 * 重点盯住三件事：结构完整、算得对、拿不到就是 null + reason（不编数字）。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createTelemetry } from "../telemetry.mjs";

const GB = 1024 ** 3;

/* 假 os：cpuSeq 的取值按调用次数推进（cores 一次 + 两次采样），
 * 因此通常传 [起点, 起点, 终点]，保证「第一次采样 = 起点、第二次 = 终点」。 */
function makeOs({
  platform = "win32",
  cpuSeq = [{ user: 500, sys: 500, idle: 1000 }, { user: 500, sys: 500, idle: 1000 }, { user: 900, sys: 600, idle: 1500 }],
  total = 16 * GB,
  free = 4 * GB,
  load = [0.5, 0.4, 0.3],
} = {}) {
  let i = 0;
  return {
    platform: () => platform,
    cpus: () => {
      const s = cpuSeq[Math.min(i++, cpuSeq.length - 1)];
      const one = { model: "FakeCPU @ 2.00GHz", times: { user: s.user, nice: 0, sys: s.sys, idle: s.idle, irq: 0 } };
      return [one, { ...one, times: { ...one.times } }];
    },
    totalmem: () => total,
    freemem: () => free,
    uptime: () => 12345.6,
    loadavg: () => load,
  };
}

const WMIC = [
  "",
  "Node,Caption,FreeSpace,Size",
  "HOST,C:,100000000000,500000000000",
  "HOST,D:,400000000000,400000000000",
  "",
].join("\r\n");

const TASKLIST = [
  '"我的 应用.exe","4321","Console","1","204,800 K"',
  '"chrome.exe","1234","Console","1","512,000 K"',
  '"a,b.exe","999","Console","1","102,400 K"',
  "",
].join("\r\n");

const fakeExec = (cmd) => {
  if (cmd.includes("tasklist")) return { ok: true, stdout: TASKLIST };
  if (cmd.includes("wmic")) return { ok: true, stdout: WMIC };
  return { ok: false, stdout: "" };
};

const noSleep = () => { /* 注入的 sleeper：不消耗真实时间 */ };

const mk = (o = {}) => createTelemetry({ now: () => 1700000000000, os: makeOs(), sleeper: noSleep, exec: fakeExec, ...o });

test("snapshot 结构完整：cpu/mem/disk/temp/top/warnings 一个不少", () => {
  const s = mk().snapshot();
  assert.equal(s.ok, true);
  assert.equal(s.at, 1700000000000);
  assert.deepEqual(Object.keys(s.cpu).sort(), ["cores", "load1", "load15", "load5", "model", "usagePct"].sort());
  assert.deepEqual(Object.keys(s.mem).sort(), ["free", "total", "usedPct"].sort());
  assert.deepEqual(Object.keys(s.temp).sort(), ["celsius", "reason"].sort());
  assert.equal(Array.isArray(s.warnings), true);
  assert.equal(Array.isArray(s.disk), true);
  assert.equal(Array.isArray(s.top), true);
  assert.equal(s.cpu.cores, 2);
  assert.match(s.cpu.model, /FakeCPU/);
  assert.equal(s.uptimeSec, 12346, "uptimeSec 四舍五入到秒");
});

test("mem.usedPct 计算正确（16G 总量 / 4G 空闲 → 75%）", () => {
  const s = mk().snapshot();
  assert.equal(s.mem.total, 16 * GB);
  assert.equal(s.mem.free, 4 * GB);
  assert.equal(s.mem.usedPct, 75);
});

test("注入 sleeper 后两次采样差分算出 usagePct（50%）", () => {
  let slept = 0;
  const s = mk({ sleeper: (ms) => { slept = ms; } }).snapshot();
  assert.equal(slept, 120, "默认采样间隔 120ms 传给 sleeper");
  assert.equal(s.cpu.usagePct, 50);
});

test("未注入 sleeper → usagePct 为 null 且 warnings 有说明", () => {
  const s = mk({ sleeper: undefined }).snapshot();
  assert.equal(s.cpu.usagePct, null);
  assert.equal(s.warnings.some((w) => w.startsWith("no-sleeper")), true);
});

test("两次采样无推进 → usagePct 为 null 而不是 0", () => {
  const flat = { user: 500, sys: 500, idle: 1000 };
  const s = mk({ os: makeOs({ cpuSeq: [flat, flat, flat] }) }).snapshot();
  assert.equal(s.cpu.usagePct, null);
  assert.equal(s.warnings.some((w) => w.startsWith("no-delta")), true);
});

test("未注入 exec → disk / top 均为 null 且 warnings 有说明", () => {
  const s = mk({ exec: undefined }).snapshot();
  assert.equal(s.disk, null);
  assert.equal(s.top, null);
  assert.equal(s.warnings.some((w) => w.startsWith("no-exec")), true);
});

test("温度恒为 null 且带 reason：绝不编造数字", () => {
  const win = mk().snapshot();
  assert.equal(win.temp.celsius, null);
  assert.equal(typeof win.temp.celsius, "object", "必须是 null，不能是 0 或任何数字");
  assert.equal(win.temp.reason, "windows-no-dependency");

  const linux = mk({ os: makeOs({ platform: "linux" }) }).snapshot();
  assert.equal(linux.temp.celsius, null);
  assert.equal(linux.temp.reason, "no-sensor-api");
});

test("exec 返回垃圾文本 → disk 为 null 且不抛", () => {
  const s = mk({ exec: () => "这不是 CSV，只是随便一段话 42" }).snapshot();
  assert.equal(s.disk, null);
  assert.equal(s.top, null);
  assert.equal(s.warnings.some((w) => w.startsWith("disk-unavailable")), true);
  assert.equal(s.warnings.some((w) => w.startsWith("top-unavailable")), true);
});

test("exec 抛异常也不外泄", () => {
  const s = mk({ exec: () => { throw new Error("boom"); } }).snapshot();
  assert.equal(s.ok, true);
  assert.equal(s.disk, null);
  assert.equal(s.top, null);
});

test("磁盘 CSV 解析：盘符、容量、usedPct 都算对", () => {
  const s = mk().snapshot();
  assert.equal(s.disk.length, 2);
  const c = s.disk.find((d) => d.mount === "C:");
  assert.equal(c.total, 500000000000);
  assert.equal(c.free, 100000000000);
  assert.equal(c.usedPct, 80);
  const d = s.disk.find((d) => d.mount === "D:");
  assert.equal(d.usedPct, 0);
});

test("tasklist CSV 解析正确：带引号、带逗号的进程名不被切坏", () => {
  const s = mk().snapshot();
  assert.equal(s.top.length, 3);
  assert.equal(s.top[0].name, "chrome.exe", "内存最大的排第一");
  assert.equal(s.top[0].pid, 1234);
  assert.equal(s.top[0].cpuPct, null, "tasklist 不给 CPU%，必须为 null");
  assert.equal(s.top[0].memPct, 3.1);
  assert.equal(s.top.map((p) => p.name).includes("a,b.exe"), true);
  assert.equal(s.top.find((p) => p.name === "a,b.exe").pid, 999);
});

test("setOptions：非法值被忽略，合法值生效", () => {
  const t = mk();
  assert.equal(t.options().sampleMs, 120);

  const bad = t.setOptions({ sampleMs: -5 });
  assert.equal(bad.ok, true);
  assert.equal(bad.applied, 0);
  assert.equal(t.options().sampleMs, 120, "非法值不得改动状态");

  t.setOptions({ sampleMs: 99999, exec: "not-a-function", sleeper: 123 });
  assert.equal(t.options().sampleMs, 120);

  t.setOptions({ sampleMs: 250, exec: null });
  assert.equal(t.options().sampleMs, 250);
  assert.equal(t.options().hasExec, false);

  assert.equal(t.setOptions(null).ok, false);
  assert.equal(t.setOptions(undefined).ok, false);
});

test("options() 只报告能力位，不泄露函数本身", () => {
  const t = mk();
  const o = t.options();
  assert.deepEqual(Object.keys(o).sort(), ["hasExec", "hasSleeper", "platform", "sampleMs"].sort());
  assert.equal(typeof o.hasExec, "boolean");
  assert.equal(typeof o.hasSleeper, "boolean");
  assert.equal(o.platform, "win32");
});

test("loadavg：Windows 上不给假 0，记 null 并说明；其他平台照实上报", () => {
  const win = mk().snapshot();
  assert.equal(win.cpu.load1, null);
  assert.equal(win.cpu.load5, null);
  assert.equal(win.cpu.load15, null);
  assert.equal(win.warnings.some((w) => w.startsWith("loadavg-unavailable-on-windows")), true);

  const linux = mk({ os: makeOs({ platform: "linux" }) }).snapshot();
  assert.equal(linux.cpu.load1, 0.5);
  assert.equal(linux.cpu.load5, 0.4);
  assert.equal(linux.cpu.load15, 0.3);
});
