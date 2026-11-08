/* API 通道的用户开关 —— 宿主侧**唯一**状态源。
 *
 * 为什么开关必须落在宿主侧：
 *   真正发请求的是宿主进程里的 `hostDataApi.fetchSiteData`（Node 的 fetch），
 *   浏览器扩展自己不发网络请求。开关若只做在扩展的 chrome.storage 里，
 *   就是一块「拨了没用」的假开关 —— 用户以为关掉了，桥照样发请求。
 *   所以扩展面板只做**读写与显示**，判定与强制全部在桥这边。
 *
 * 语义：用户开关是**上限**（ceiling），不是「每次调用的额外许可」。
 *   - 关（默认）→ 一律拒绝，code = user-disabled，连白名单端点也不发。
 *     调用方此时即使显式传 enabled:true 也不能越过 —— 用户的关就是关。
 *   - 开 → API 通道可用，具体端点仍受 hostDataApi 的白名单 / SSRF / 超时 /
 *     体积上限约束，开关不放大任何单次请求的能力。
 *
 * 为什么不做「开关 + 每次调用双许可」：
 *   双许可会让用户拨开开关后一切照旧（还得有人再传一个 enabled），
 *   面板看着是「已开启」、能力却调不动 —— 这正是本项目此前踩过的坑。
 *
 * 落盘失败**不静默**：内存态仍生效（本次运行可用），但返回 persisted:false
 * 并带 warning，让界面能如实说「重启后会退回关闭」。
 *
 * IO 全部注入（load / save），模块本身不碰 fs —— 单测不需要临时目录。
 */

/** 拒绝码：与 hostDataApi 的错误码同一套字符串风格，便于上层统一判断。 */
export const USER_DISABLED = "user-disabled";

/** 记录来源的合法值；非法值一律归一为 "unknown"，避免把任意字符串写进文件。 */
const ALLOWED_BY = new Set(["default", "popup", "panel", "system"]);

const MAX_BY_LEN = 40;

/** 默认态：关。任何解析不出来的输入都退回这里，绝不"读不懂就当作开"。 */
export function defaultState() {
  return { enabled: false, updatedAt: null, updatedBy: "default", rev: 0 };
}

/**
 * 把磁盘上的任意输入归一成合法状态。
 * 只认 `enabled === true`；`"true"` / `1` / `{}` 一律当关 —— 配置被手改成什么都能开，
 * 就等于没开关。
 */
export function normalizeState(raw) {
  const out = defaultState();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  out.enabled = raw.enabled === true;
  const ts = Number(raw.updatedAt);
  out.updatedAt = Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : null;
  const by = typeof raw.updatedBy === "string" ? raw.updatedBy.trim().slice(0, MAX_BY_LEN) : "";
  out.updatedBy = ALLOWED_BY.has(by) ? by : (by ? "unknown" : "default");
  const rev = Number(raw.rev);
  out.rev = Number.isFinite(rev) && rev >= 0 ? Math.floor(rev) : 0;
  return out;
}

/**
 * @param {object} opts
 * @param {() => any} [opts.load] 读取原始磁盘内容；抛异常/返回 null 都按"无记录"处理
 * @param {(state: object) => any} [opts.save] 落盘；返回 {ok, warning} 或抛异常
 * @param {() => number} [opts.clock]
 */
export function createApiChannel({ load, save, clock = Date.now } = {}) {
  const readRaw = typeof load === "function" ? load : () => null;
  const writeRaw = typeof save === "function" ? save : null;
  const now = typeof clock === "function" ? clock : Date.now;

  function safeClock() {
    const v = Number(now());
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }

  function loadState() {
    try {
      return normalizeState(readRaw());
    } catch {
      /* 读到坏文件：退回默认关，且**不**趁机覆盖磁盘，留给用户/工具排查。 */
      return defaultState();
    }
  }

  let state = loadState();

  function snapshot() {
    return { ...state };
  }

  function isEnabled() {
    return state.enabled === true;
  }

  /** 给界面/日志用的一份只读快照，附上"关的时候拒绝码是什么"。 */
  function status() {
    return {
      ...snapshot(),
      denyCode: isEnabled() ? "" : USER_DISABLED,
      scope: "宿主进程；扩展面板只读写此状态",
    };
  }

  /**
   * 改开关。
   * @param {boolean} next 必须显式 boolean true/false
   * @param {{by?: string}} [meta]
   */
  function setEnabled(next, meta = {}) {
    const want = next === true;
    const byRaw = meta && typeof meta.by === "string" ? meta.by.trim() : "";
    const by = ALLOWED_BY.has(byRaw) ? byRaw : "system";

    if (want === state.enabled) {
      return { ok: true, unchanged: true, persisted: true, ...status() };
    }

    state = { enabled: want, updatedAt: safeClock(), updatedBy: by, rev: state.rev + 1 };

    if (!writeRaw) {
      /* 没有落盘通道：内存生效，但必须说清楚重启即失效，不能装作持久化成功。 */
      return { ok: true, persisted: false, warning: "未提供落盘通道，重启后会退回关闭", ...status() };
    }
    try {
      const r = writeRaw(snapshot());
      if (r && r.ok === false) {
        return { ok: true, persisted: false, warning: String(r.warning || "写入失败，重启后会退回关闭"), ...status() };
      }
      return { ok: true, persisted: true, ...status() };
    } catch (e) {
      return {
        ok: true,
        persisted: false,
        warning: "写入失败：" + String(e && e.message ? e.message : e).slice(0, 160) + "（重启后会退回关闭）",
        ...status(),
      };
    }
  }

  /** 供执行侧调用：返回是否放行 + 拒绝码，调用方不必自己拼字符串。 */
  function guard() {
    return isEnabled()
      ? { allowed: true, code: "" }
      : { allowed: false, code: USER_DISABLED };
  }

  return { isEnabled, status, setEnabled, guard, snapshot };
}

export default { USER_DISABLED, normalizeState, defaultState, createApiChannel };
