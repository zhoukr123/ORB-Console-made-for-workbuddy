/* 机器遥测（方案 I-12a）——只读一次性快照。
 *
 * 设计取舍（照着方案里「低价值，缓」的结论写死）：
 * 1) 不做采集守护进程、不建时序库、不落盘：snapshot() 调一次就是读一次，
 *    没有后台定时器，所以进程闲下来不会因为本模块产生任何负载。
 * 2) 拿不到的指标一律 null 并在 warnings 里写明原因，绝不填一个「看起来合理」的数字。
 *    Windows 上无依赖拿不到 CPU 温度，是操作系统层面的限制，不是实现偷懒。
 * 3) usagePct 需要两次采样差分，中间那段等待必须由注入的 sleeper 完成——
 *    本模块不用真实 setTimeout 阻塞，也不自带轮询；没注入 sleeper 就老实返回 null。
 * 4) 外部命令（wmic / powershell / tasklist / df）全部走注入的 exec，
 *    默认不实现，于是默认运行下 disk / top 就是 null，不会在用户机器上偷偷起子进程。
 * 5) fs 也保留注入位，供调用方统一传参；本模块刻意什么都不写。
 */
import * as osDefault from "node:os";
import * as fsDefault from "node:fs";

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const round1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function safe(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

/* 单行 CSV 解析：tasklist 会把带逗号的进程名整体加引号，简单 split(",") 会切错。 */
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/* wmic logicaldisk /format:csv：列顺序随版本变化，所以不按固定下标取，
 * 而是「认出盘符 + 剩下两个纯数字列里大的当总量、小的当可用」。解析不出来就返回空数组。 */
function parseWmicDisk(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^Node\s*,/i.test(line)) continue;  // 表头
    const fields = line.split(",").map((s) => s.trim());
    const caption = fields.find((f) => /^[A-Za-z]:\\?$/.test(f));
    const nums = fields.filter((f) => /^\d+$/.test(f)).map(Number);
    if (!caption || nums.length < 2) continue;
    const total = Math.max(...nums);
    const free = Math.min(...nums);
    if (!(total > 0)) continue;
    rows.push({ mount: caption.toUpperCase(), total, free, usedPct: round1(clamp(((total - free) / total) * 100, 0, 100)) });
  }
  return rows;
}

/* powershell Get-PSDrive -PSProvider FileSystem | ConvertTo-Json：单盘时是对象，多盘时是数组。 */
function parsePsDrive(text) {
  let data;
  try { data = JSON.parse(String(text)); } catch { return []; }
  const list = Array.isArray(data) ? data : [data];
  const rows = [];
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    const used = num(d.Used, NaN);
    const free = num(d.Free, NaN);
    if (!Number.isFinite(used) || !Number.isFinite(free) || used + free <= 0) continue;
    rows.push({
      mount: String(d.Name ?? "?"),
      total: used + free,
      free,
      usedPct: round1(clamp((used / (used + free)) * 100, 0, 100)),
    });
  }
  return rows;
}

/* df -kP：Filesystem 1024-blocks Used Available Capacity Mounted-on，单位 KB。 */
function parseDf(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^Filesystem/i.test(line)) continue;
    const f = line.split(/\s+/);
    if (f.length < 6) continue;
    const totalKb = Number(f[1]);
    const freeKb = Number(f[3]);
    if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb) || totalKb <= 0) continue;
    rows.push({
      mount: f.slice(5).join(" "),
      total: totalKb * 1024,
      free: freeKb * 1024,
      usedPct: round1(clamp(((totalKb - freeKb) / totalKb) * 100, 0, 100)),
    });
  }
  return rows;
}

/* tasklist /FO CSV /NH：形如 "chrome.exe","1234","Console","1","123,456 K"
 * 只有内存是真实值；CPU% tasklist 不给，于是 cpuPct 一律 null（不编）。 */
function parseTasklist(text, totalMem) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('"')) continue;   // 跳过「没有运行的任务」这类提示行
    const f = parseCsvLine(line);
    if (f.length < 5) continue;
    const pid = Number(f[1]);
    if (!Number.isFinite(pid)) continue;
    const kb = Number(String(f[4]).replace(/[^\d]/g, ""));
    if (!Number.isFinite(kb)) continue;
    rows.push({
      pid,
      name: f[0],
      cpuPct: null,   // tasklist 不提供 CPU 占用，留空比造一个数诚实
      memPct: totalMem > 0 ? round1(clamp((kb * 1024 / totalMem) * 100, 0, 100)) : null,
      _bytes: kb * 1024,
    });
  }
  rows.sort((a, b) => b._bytes - a._bytes);
  return rows.slice(0, 5).map(({ _bytes, ...r }) => r);
}

export function createTelemetry(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  const osmod = o.os && typeof o.os === "object" ? o.os : osDefault;
  const fsmod = o.fs || fsDefault;   // 保留注入位；本模块不落盘，故不引用其方法

  const state = {
    sampleMs: (() => {
      const v = Number(o.sampleMs);
      return Number.isFinite(v) && v > 0 && v <= 10000 ? v : 120;
    })(),
    exec: typeof o.exec === "function" ? o.exec : null,
    sleeper: typeof o.sleeper === "function" ? o.sleeper : null,
  };

  const platformOf = () => String(safe(() => osmod.platform(), process.platform) ?? "unknown");

  /* exec 允许三种返回：字符串 / { ok, stdout } / { ok:false }；异常一律当失败。 */
  function runExec(cmd) {
    if (!state.exec) return { ok: false, out: "" };
    try {
      const r = state.exec(cmd);
      if (typeof r === "string") return { ok: true, out: r };
      if (r && typeof r === "object") {
        if (r.ok === false) return { ok: false, out: "" };
        const out = typeof r.stdout === "string" ? r.stdout : (typeof r.out === "string" ? r.out : "");
        return { ok: true, out };
      }
      return { ok: false, out: "" };
    } catch {
      return { ok: false, out: "" };
    }
  }

  function cpuTimes() {
    const cpus = safe(() => osmod.cpus(), []);
    const list = Array.isArray(cpus) ? cpus : [];
    let idle = 0;
    let total = 0;
    for (const c of list) {
      const t = (c && c.times) || {};
      idle += num(t.idle, 0);
      total += num(t.user, 0) + num(t.nice, 0) + num(t.sys, 0) + num(t.idle, 0) + num(t.irq, 0);
    }
    return { idle, total };
  }

  function probeDisk(platform) {
    const probes = platform === "win32"
      ? [
        ["wmic logicaldisk get size,freespace,caption /format:csv", parseWmicDisk],
        ['powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | ConvertTo-Json -Compress"', parsePsDrive],
      ]
      : [["df -kP", parseDf]];
    for (const [cmd, parse] of probes) {
      const r = runExec(cmd);
      if (!r.ok || !r.out) continue;
      const rows = safe(() => parse(r.out), []);
      if (Array.isArray(rows) && rows.length > 0) return rows;
    }
    return null;
  }

  function probeTop(platform, totalMem) {
    if (platform !== "win32") return null;    // 只做了 Windows 的解析路径，别的平台不猜
    const r = runExec("tasklist /FO CSV /NH");
    if (!r.ok || !r.out) return null;
    const rows = safe(() => parseTasklist(r.out, totalMem), []);
    return Array.isArray(rows) && rows.length > 0 ? rows : null;
  }

  function snapshot() {
    const warnings = [];
    const at = safe(() => now(), 0);
    const platform = platformOf();

    /* ---- CPU ---- */
    const cpus = safe(() => osmod.cpus(), []);
    const cpuList = Array.isArray(cpus) ? cpus : [];
    if (cpuList.length === 0) warnings.push("cpus-unavailable: os.cpus() 无数据，cores/model 记 null");

    let load1 = null, load5 = null, load15 = null;
    if (platform === "win32") {
      // Node 在 Windows 上恒返回 [0,0,0]，这不是真实负载，报 null 并说明。
      warnings.push("loadavg-unavailable-on-windows: Windows 没有 load average 语义，load1/5/15 记 null");
    } else {
      const la = safe(() => osmod.loadavg(), null);
      if (Array.isArray(la) && la.length >= 3) {
        load1 = num(la[0], null);
        load5 = num(la[1], null);
        load15 = num(la[2], null);
      } else {
        warnings.push("loadavg-unavailable: loadavg() 不可用，load1/5/15 记 null");
      }
    }

    let usagePct = null;
    if (!state.sleeper) {
      warnings.push("no-sleeper: 未注入 sleeper，无法做两次采样差分，usagePct 记 null");
    } else {
      try {
        const a = cpuTimes();
        state.sleeper(state.sampleMs);
        const b = cpuTimes();
        const dTotal = b.total - a.total;
        const dIdle = b.idle - a.idle;
        if (dTotal > 0) usagePct = round1(clamp((1 - dIdle / dTotal) * 100, 0, 100));
        else warnings.push("no-delta: 两次采样之间 CPU 时间未推进，usagePct 记 null");
      } catch {
        warnings.push("sample-failed: 采样过程出错，usagePct 记 null");
      }
    }

    const cpu = {
      cores: cpuList.length > 0 ? cpuList.length : null,
      model: (cpuList[0] && cpuList[0].model) || null,
      load1,
      load5,
      load15,
      usagePct,
    };

    /* ---- 内存 ---- */
    const totalMem = num(safe(() => osmod.totalmem(), null), null);
    const freeMem = num(safe(() => osmod.freemem(), null), null);
    let mem;
    if (totalMem === null || freeMem === null || totalMem <= 0) {
      warnings.push("mem-unavailable: totalmem/freemem 读取失败，mem 记 null");
      mem = { total: null, free: null, usedPct: null };
    } else {
      mem = {
        total: totalMem,
        free: freeMem,
        usedPct: round1(clamp(((totalMem - freeMem) / totalMem) * 100, 0, 100)),
      };
    }

    /* ---- 磁盘 / Top 进程 ---- */
    let disk = null;
    let top = null;
    if (!state.exec) {
      warnings.push("no-exec: 未注入 exec，disk 与 top 均记 null（不猜）");
    } else {
      disk = probeDisk(platform);
      if (!disk) warnings.push("disk-unavailable: 磁盘命令执行或解析失败，disk 记 null");
      if (platform !== "win32") warnings.push("top-unsupported-platform: 只实现了 Windows 的 tasklist 解析，top 记 null");
      else {
        top = probeTop(platform, totalMem);
        if (!top) warnings.push("top-unavailable: tasklist 不可用或解析失败，top 记 null");
      }
    }

    /* ---- 温度：拿不到就是拿不到 ---- */
    // 读 CPU 温度需要内核驱动或 WMI 传感器，Node 内置模块没有这条路；
    // 任何「估算」都是在编数字，所以这里恒为 null + reason。
    const temp = {
      celsius: null,
      reason: platform === "win32" ? "windows-no-dependency" : "no-sensor-api",
    };

    return {
      ok: true,
      at,
      cpu,
      mem,
      disk,
      temp,
      uptimeSec: Math.round(num(safe(() => osmod.uptime(), null), 0)),
      top,
      warnings,
    };
  }

  function options() {
    return {
      sampleMs: state.sampleMs,
      hasExec: !!state.exec,
      hasSleeper: !!state.sleeper,
      platform: platformOf(),
    };
  }

  /* 非法值直接忽略（不改状态），返回实际生效项数量，方便调用方对账。 */
  function setOptions(patch) {
    const p = patch && typeof patch === "object" ? patch : null;
    if (!p) return { ok: false, error: "bad-patch", options: options() };
    let applied = 0;
    if (p.sampleMs !== undefined) {
      const v = Number(p.sampleMs);
      if (Number.isFinite(v) && v > 0 && v <= 10000) { state.sampleMs = v; applied++; }
    }
    if (p.exec !== undefined && (typeof p.exec === "function" || p.exec === null)) {
      state.exec = p.exec; applied++;
    }
    if (p.sleeper !== undefined && (typeof p.sleeper === "function" || p.sleeper === null)) {
      state.sleeper = p.sleeper; applied++;
    }
    return { ok: true, applied, options: options() };
  }

  return { snapshot, setOptions, options };
}
