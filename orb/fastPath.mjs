/* 快速筛查：大文件/录屏音轨绝不进模型输入，只给 header/时长/内容哈希/采样窗口。
 * 固定 reasonCode 枚举；重复哈希直接拒、已索引直接复用；索引与原文分离。
 * charge 提供多个视频 Trigger 并发共享的采样预算；probe 等外部能力经 opts 注入。 */
export const REASON_CODES = [
  "admitted", "too-large", "unsupported-type", "already-indexed",
  "duplicate-hash", "budget-exhausted", "missing-meta",
];

const HEADER_TOKENS = 256;       // 大文件仅元数据/header 的 token 上限，与文件大小无关
const ESTIMATE_CAP = 8192;       // 小文件直入的估算上限
const SAMPLE_BYTES = 64 * 1024;  // 采样窗口上限

/* 录屏音轨/视频/纯二进制归档一律不进模型输入。 */
const UNSUPPORTED_MIME = /^(?:audio\/|video\/|application\/(?:octet-stream|zip|x-7z-compressed|x-rar-compressed|x-tar|vnd\.rar)|application\/x-)/i;

const toNum = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function createFastPath(opts = {}) {
  const probe = typeof opts.probe === "function" ? opts.probe : null;
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const largeBytes = toNum(opts.largeBytes, 1024 * 1024 * 1024);
  const maxTokens = toNum(opts.budget && opts.budget.maxTokens, 100000);
  const perKeyRaw = opts.budget && opts.budget.perKeyMax;
  const perKeyMax = Number.isFinite(Number(perKeyRaw)) ? Number(perKeyRaw) : null;

  let pool = maxTokens;          // 共享采样预算
  const used = new Map();        // key -> 已用 token
  const hashes = new Set();      // 已处理内容哈希
  let screened = 0;
  let admitted = 0;
  let rejected = 0;
  const byReason = Object.create(null);

  /* probe 只补缺失字段，异常被吞掉，绝不影响主流程。 */
  function fillMeta(input) {
    const src = input && typeof input === "object" ? input : {};
    const clean = {};
    for (const k of Object.keys(src)) if (src[k] !== undefined) clean[k] = src[k];
    if (probe) {
      try {
        const p = probe(clean);
        if (p && typeof p === "object") {
          for (const k of Object.keys(p)) if (clean[k] === undefined) clean[k] = p[k];
        }
      } catch { /* 探针失败不影响主流程 */ }
    }
    return clean;
  }

  function isUnsupported(mime) {
    const m = String(mime ?? "").toLowerCase();
    return m ? UNSUPPORTED_MIME.test(m) : false;
  }

  function result(admittedFlag, reasonCode, estimatedTokens, samplingWindow, hash) {
    byReason[reasonCode] = (byReason[reasonCode] || 0) + 1;
    if (admittedFlag) admitted++; else rejected++;
    return {
      admitted: admittedFlag,
      reasonCode,
      estimatedTokens,
      samplingWindow,
      contentHash: hash,
      budget: { remaining: pool, maxTokens, perKeyMax },
    };
  }

  function screen(input = {}) {
    screened++;
    const m = fillMeta(input);
    const hash = m.contentHash != null ? String(m.contentHash) : "";
    const noWindow = { enabled: false };

    // 1) 缺失必要元数据
    const sz = Number(m.size);
    if (m.size === undefined || m.size === null || !Number.isFinite(sz) || sz < 0 || !hash) {
      return result(false, "missing-meta", 0, noWindow, hash);
    }
    // 2) 已索引：直接复用现有索引，不重复处理
    if (m.indexed === true) return result(false, "already-indexed", 0, noWindow, hash);
    // 3) 重复内容哈希：直接拒
    if (hashes.has(hash)) return result(false, "duplicate-hash", 0, noWindow, hash);
    // 4) 不支持的类型（录屏音轨/视频/二进制归档）
    if (isUnsupported(m.mime)) return result(false, "unsupported-type", 0, noWindow, hash);
    // 5) 大文件：不进模型输入，仅给 header/时长/哈希/采样窗口（token 与 1GB 大小无关）
    if (sz >= largeBytes) {
      const sw = {
        enabled: true,
        reason: "too-large",
        maxSampleBytes: SAMPLE_BYTES,
        durationMs: m.header && m.header.durationMs != null ? m.header.durationMs : null,
        header: m.header ?? null,
        mtimeMs: m.mtimeMs ?? null,
        at: now(),
      };
      hashes.add(hash);
      return result(false, "too-large", HEADER_TOKENS, sw, hash);
    }
    // 6) 共享采样预算耗尽
    if (pool <= 0) return result(false, "budget-exhausted", 0, noWindow, hash);
    // 7) 准入
    const estimatedTokens = Math.min(ESTIMATE_CAP, Math.ceil(sz / 4) + 64);
    hashes.add(hash);
    return result(true, "admitted", estimatedTokens, noWindow, hash);
  }

  /* 多 Trigger 共享同一采样池；perKeyMax 可额外限制单 key。 */
  function charge(key, tokens) {
    const k = String(key ?? "");
    const t = Number(tokens);
    if (!Number.isFinite(t) || t < 0) return { ok: false, remaining: pool };
    if (t === 0) return { ok: true, remaining: pool };
    if (t > pool) return { ok: false, remaining: pool };
    if (perKeyMax !== null && (used.get(k) || 0) + t > perKeyMax) return { ok: false, remaining: pool };
    pool -= t;
    used.set(k, (used.get(k) || 0) + t);
    return { ok: true, remaining: pool };
  }

  function remaining(key) {
    if (perKeyMax === null) return pool;
    return Math.max(0, Math.min(pool, perKeyMax - (used.get(String(key ?? "")) || 0)));
  }

  function stats() {
    return { screened, admitted, rejected, byReason: { ...byReason } };
  }

  return { screen, charge, remaining, stats };
}
