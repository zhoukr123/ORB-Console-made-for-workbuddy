/* 升级器（upgrade）：把"从哪升到哪、为什么升、属于哪个世代"收敛成一种形状。
 *
 * 现状是什么样的：视觉档位、任务路由、通道降级、Max 模式，四处各有各的 if/else，
 * 都能"升"都"降"，但谁也不记录原因。于是出现两种典型事故：
 *   ① 用户看到"这次怎么这么慢/这么贵"，没人能回答它是什么时候、因为什么换档的；
 *   ② 急停之后迟到的降级回调把状态又改回去 —— 因为没有统一的 epoch 校验，
 *      每处各自决定要不要看 epoch，总有一处忘了。
 *
 * 所以这里只做三件事，不做第四件：
 *   · 一张**显式**的合法转移表（在表外的转移一律拒，而不是"默认允许"）；
 *   · 一次判定必须带 cause（降级不带原因，等于把"为什么变慢"永久丢掉）；
 *   · 世代校验（旧世代发起的转移直接作废，返回 stale-epoch 让调用方知道被拒了）。
 * 不做第四件：**不替执行层决定要不要转移**。它只回答"这个转移合不合法、记成什么"，
 * 因为"该不该降级"是业务判断，塞进通用模块就会变成一个谁都看不懂的开关。
 */

/* 阶梯定义：值里的数字是"强度/代价"，用来判方向。数字越大越深、越贵、越慢。 */
export const LADDERS = Object.freeze({
  /* 视觉档位：延迟越高越要一次做对 */
  visual: Object.freeze({ fast: 8, normal: 12, deep: 20 }),
  /* 任务通道：能用指令就不上视觉（视觉贵一个量级） */
  route: Object.freeze({ command: 1, vision: 2 }),
  /* 通道健康：主路 → 备路 */
  channel: Object.freeze({ primary: 1, backup: 2, none: 3 }),
  /* 运行模式 */
  mode: Object.freeze({ normal: 1, max: 2 }),
});

/* 允许的转移。**显式列出**是刻意的：
 * "表外默认允许"会让一次拼错的档位名静默生效，而拼错的档位通常落进最深的那一档
 * —— 表现出来就是"莫名其妙变慢变贵"，且查不到任何报错。 */
const ALLOWED = Object.freeze({
  visual: Object.freeze([
    ["fast", "normal"], ["fast", "deep"], ["normal", "deep"],
    ["normal", "fast"], ["deep", "normal"], ["deep", "fast"],
  ]),
  route: Object.freeze([["command", "vision"], ["vision", "command"]]),
  channel: Object.freeze([["primary", "backup"], ["backup", "none"], ["backup", "primary"], ["none", "primary"]]),
  mode: Object.freeze([["normal", "max"], ["max", "normal"]]),
});

const MAX_RECORDS = 200;

function allowedPair(ladder, from, to) {
  const list = ALLOWED[ladder] || [];
  return list.some(([a, b]) => a === from && b === to);
}

export function createUpgrade(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  const epochFn = typeof o.epoch === "function" ? o.epoch : () => 0;

  const buf = [];              // 环形：{ seq, ladder, from, to, cause, dir, epoch, at }
  const lastByLadder = new Map();
  let seq = 0;
  const byLadder = Object.create(null);
  for (const k of Object.keys(LADDERS)) byLadder[k] = 0;
  let rejected = 0, stale = 0;

  function invalid(reason, extra = {}) {
    return { ok: false, reason, ...extra };
  }

  /**
   * 判定并记录一次转移。
   * @param {string} ladder visual | route | channel | mode
   * @param {string} from
   * @param {string} to
   * @param {{cause?:string, epoch?:number}} arg
   */
  function transition(ladder, from, to, arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const L = String(ladder || "");
    const table = LADDERS[L];
    if (!table) {
      /* 未知阶梯也是"被拒的一次尝试"，要计数 —— 否则拼错阶梯名的 bug
       * 既不留痕也不报警，表现只是"换档账本里怎么少了几笔"。 */
      rejected++;
      return invalid("unknown-ladder", { ladder: L });
    }

    const f = String(from || "");
    const t = String(to || "");
    if (!(f in table) || !(t in table)) {
      /* 拼错的档位名走这里。别把它当成 "noop" 放过去 —— 见文件头。 */
      rejected++;
      return invalid("unknown-state", { ladder: L, from: f, to: t });
    }
    if (f === t) {
      /* 同一档位的"再选一次"不是转移，也不该记一条噪音；但要区分有没有原因。 */
      return { ok: true, noop: true, ladder: L, from: f, to: t, dir: "same", cause: String(a.cause || ""), epoch: num(a.epoch, epochFn()), at: now() };
    }
    if (!allowedPair(L, f, t)) {
      rejected++;
      return invalid("illegal-transition", { ladder: L, from: f, to: t });
    }

    const dir = table[t] > table[f] ? "up" : "down";
    const cause = String(a.cause || "");
    /* 降级必须带原因：不带原因的那一次，就是三个月后"为什么变慢了"的唯一线索。 */
    if (dir === "down" && !cause) {
      rejected++;
      return invalid("missing-cause", { ladder: L, from: f, to: t, dir });
    }

    const epoch = num(a.epoch, epochFn());
    const cur = num(epochFn(), 0);
    /* 旧世代的转移一律作废：急停之后迟到的回调不该把状态改回去。
     * 注意判据是"发起时带的 epoch < 当前"，不是"!= 当前" —— 显式指定更高 epoch
     * 是合法的（预置下一次世代的初始状态）。 */
    if (epoch < cur) {
      stale++;
      return invalid("stale-epoch", { ladder: L, from: f, to: t, epoch, current: cur });
    }

    seq += 1;
    const rec = { seq, ladder: L, from: f, to: t, dir, cause, epoch, at: now() };
    buf.push(rec);
    if (buf.length > MAX_RECORDS) buf.shift();
    lastByLadder.set(L, rec);
    byLadder[L] = (byLadder[L] || 0) + 1;
    return { ok: true, noop: false, ...rec };
  }

  /** 某条阶梯最近一次转移（面板显示"现在是为什么在这一档"用）。 */
  function last(ladder) {
    return ladder ? (lastByLadder.get(String(ladder)) || null) : null;
  }

  /** 历史（新的在前）。 */
  function history(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const ladder = a.ladder ? String(a.ladder) : "";
    const n = Number.isFinite(a.limit) ? Math.max(0, Math.trunc(a.limit)) : 30;
    const rows = ladder ? buf.filter((r) => r.ladder === ladder) : buf.slice();
    return n === 0 ? [] : rows.slice(-n).reverse();
  }

  function stats() {
    let up = 0, down = 0;
    for (const r of buf) { if (r.dir === "up") up++; else if (r.dir === "down") down++; }
    return {
      total: seq, up, down, rejected, stale,
      byLadder: { ...byLadder },
      ladders: Object.keys(LADDERS),
    };
  }

  function reset() {
    buf.length = 0; seq = 0; rejected = 0; stale = 0;
    lastByLadder.clear();
    for (const k of Object.keys(byLadder)) byLadder[k] = 0;
    return { ok: true };
  }

  return { transition, last, history, stats, reset };
}

function num(v, d) {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
