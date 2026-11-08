/* 批次C · 外部检索的**可插拔凭据来源**（默认 inert）。
 *
 * 2026-11-06 口径（用户确认「不碰那把 key」）：
 *   · 本机 .dsh / orb-dsh 凭据库里的那把 key 是 DeepSeek 账号平台通过 dsh 设备授权
 *     签发的，授权范围未经确认、用户也未曾主动申请。本模块**不读取它**。
 *   · 默认 inert：不读本机凭据文件、不读账号平台签发的任何变量、不发请求。
 *   · 只有「总开关显式打开」且「来源显式登记」时才可能给出 key；
 *     唯一被接受的来源是 env（用户自己显式设置的 ORB_SEARCH_API_KEY）。
 *   · 未知来源一律 fail-closed 回落 inert，绝不猜、绝不自动挑一个可用的。
 *   · resolve() 的 apiKey 只在进程内交给 provider；describe() 只回布尔与来源名，
 *     绝不把 key 放进任何返回值、日志、面板或安全页。
 *
 * 这是批次 C 的「降级接线」：整套编排层照常落地，但默认零外发、零计费。
 * 将来若换用别的检索通道，只需换一个来源实现，不必重写编排层。
 */
export const CREDENTIAL_SOURCES = Object.freeze(["inert", "env"]);
export const DEFAULT_CREDENTIAL_SOURCE = "inert";

export function createCredentialProvider(opts = {}) {
  const env = opts.env && typeof opts.env === "object" ? opts.env : process.env;
  /* 只认字面 true：配置误写 "1" / "true" 都不会偷偷打开。 */
  const enabled = opts.enabled === true;
  const requested = String(
    opts.source ?? env.ORB_SEARCH_CREDENTIAL_SOURCE ?? DEFAULT_CREDENTIAL_SOURCE,
  ).trim() || DEFAULT_CREDENTIAL_SOURCE;
  const supported = CREDENTIAL_SOURCES.includes(requested);
  const source = supported ? requested : DEFAULT_CREDENTIAL_SOURCE;

  function resolve() {
    if (!enabled) {
      return { source: "inert", hasKey: false, apiKey: "", note: "检索总开关关闭：不读取任何凭据" };
    }
    if (!supported) {
      return { source: "inert", hasKey: false, apiKey: "", note: "来源未登记，fail-closed 回落 inert" };
    }
    if (source === "inert") {
      return { source: "inert", hasKey: false, apiKey: "", note: "显式 inert：不读取任何本机凭据文件" };
    }
    /* env 是唯一被登记的来源：只认用户自己显式设置的那一个变量。 */
    const raw = typeof env.ORB_SEARCH_API_KEY === "string" ? env.ORB_SEARCH_API_KEY.trim() : "";
    return {
      source: "env",
      hasKey: raw.length > 0,
      apiKey: raw,
      note: raw.length > 0 ? "来自用户显式设置的环境变量" : "环境变量未设置",
    };
  }

  function describe() {
    const r = resolve();
    return {
      enabled,
      requested,
      source: r.source,
      hasKey: r.hasKey,
      supported,
      acceptedSources: [...CREDENTIAL_SOURCES],
      note: r.note,
      /* 可证伪的两个判据：本机 dsh 凭据从未被使用；默认零外发。 */
      dshCredentialUsed: false,
      zeroOutboundByDefault: !enabled,
    };
  }

  return { resolve, describe };
}

export default { CREDENTIAL_SOURCES, DEFAULT_CREDENTIAL_SOURCE, createCredentialProvider };
