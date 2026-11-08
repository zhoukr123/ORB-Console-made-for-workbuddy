/* 大附件采样计划（attachPlan）：给出"这个附件大概要花多少、怎么读才不烧穿"的确定性答案。
 *
 * 起因很具体：拖进来一个 1GB 的日志/视频/PDF，如果直接整份塞进模型，
 * 一次就是几十万 token，而且大部分内容是重复的 —— 钱烧了，结论却没更准。
 * 这里要回答三个问题，且答案必须能在**不读文件**的前提下算出来：
 *   ① 这份东西大概值多少 token / 多少钱；
 *   ② 该采多少（页 / 帧 / 行 / 字符）；
 *   ③ 采样会不会漏掉关键信息，漏在哪儿。
 *
 * 设计取舍：
 *   · 纯函数，只吃 {kind, bytes, pages?, durationSec?, width?, height?}，不碰文件系统 ——
 *     采样计划算错不该把用户的东西读坏，本身也不该有 IO 成本。
 *   · 数字全部**偏保守（估高）**：低估会让人放心地拖进 1GB，高估只会让人少拖一点。
 *   · 阈值与单价集中在这一个表里，改价只改一处（成本账本也从这里取，不各写一份）。
 *   · 不做"自动决定要不要截断"：这里只给计划，执行层（面板/桥）决定用不用，
 *     因为"悄悄只读前 200 页"比"明确告诉你只读了 200 页"糟得多。
 */

/* 各类附件的 token 估算基准。单位与 note 写清楚，避免下一个人凭感觉改。
 *  · 文本：约 1 token ≈ 2.2 个中文字符 / 4 个英文字符，取保守的 2 字符/token。
 *  · PDF：一页正文约 550 token（含排版损耗），扫描页按图算。
 *  · 图像：单帧 ≈ (w*h)/750 token，与主流视觉编码器的 tile 数对齐。
 *  · 音视频：按秒计（语音 12 token/s，视频另加帧）。 */
export const RATES = Object.freeze({
  chars_per_token: 2,          // 保守：中文多时更接近 1.5，取 2 是低估 token 数（偏保守）
  pdf_page_tokens: 550,
  scan_page_tokens: 1100,      // 扫描页要当图看，贵一倍
  image_tokens_per_px: 1 / 750,
  audio_tokens_per_sec: 12,
  video_tokens_per_sec: 90,    // 帧 + 音轨
  usd_per_mtoken_in: 0.28,     // 与 costLedger 的 deepseek-v4 档对齐；只用于"量级判断"
});

/* 采样上限：不是"技术极限"，是"再多也不会更准"的经验值。
 * 超过它的部分对结论的边际贡献接近零，而成本是线性的。 */
export const CAPS = Object.freeze({
  text_chars: 400_000,         // 约 20 万 token
  pdf_pages: 120,
  image_side: 1568,            // 主流视觉模型的长边上限，再大也会被缩放
  audio_sec: 1800,             // 30 分钟
  video_frames: 120,           // 约每 5 秒 1 帧（10 分钟片）
  video_sec: 600,
});

const KINDS = new Set(["text", "pdf", "image", "audio", "video", "archive", "unknown"]);

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** 从扩展名猜类别。猜不出就 unknown —— 猜错的代价比"未知"高。 */
export function kindOf(name, mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("text/")) return "text";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (/zip|tar|7z|rar|gzip/.test(m)) return "archive";
  const ext = String(name || "").toLowerCase().split(".").pop();
  if (["txt", "md", "log", "csv", "tsv", "json", "jsonl", "yml", "yaml", "xml", "html", "js", "mjs", "ts", "py", "go", "rs", "java", "c", "cpp", "h", "css"].includes(ext)) return "text";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic"].includes(ext)) return "image";
  if (["mp3", "wav", "m4a", "opus", "flac", "aac", "ogg"].includes(ext)) return "audio";
  if (["mp4", "mov", "mkv", "avi", "webm"].includes(ext)) return "video";
  if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) return "archive";
  return "unknown";
}

function estTokens(kind, meta) {
  switch (kind) {
    case "text": {
      const chars = num(meta.chars) || Math.round(num(meta.bytes) * 0.9);  // UTF-8 中文约 3 字节/字，取 0.9 字/字节
      return { tokens: Math.ceil(chars / RATES.chars_per_token), chars };
    }
    case "pdf": {
      const pages = num(meta.pages) || Math.max(1, Math.round(num(meta.bytes) / 60_000));  // 约 60KB/页
      const t = pages * (meta.scanned ? RATES.scan_page_tokens : RATES.pdf_page_tokens);
      return { tokens: Math.ceil(t), pages };
    }
    case "image": {
      const w = num(meta.width) || 1280, h = num(meta.height) || 720;
      return { tokens: Math.ceil(w * h * RATES.image_tokens_per_px), frames: 1 };
    }
    case "audio": {
      const sec = num(meta.durationSec) || Math.round(num(meta.bytes) / 16_000);  // 128kbps ≈ 16KB/s
      return { tokens: Math.ceil(sec * RATES.audio_tokens_per_sec), sec };
    }
    case "video": {
      /* 这里**不套采样上限**：full 的语义是"整份看要多少"，
       * 上限只属于 plan。混在一起会出现"计划比整份还贵"的荒谬结果。 */
      const sec = num(meta.durationSec) || Math.round(num(meta.bytes) / 250_000);  // 2Mbps ≈ 250KB/s
      return { tokens: Math.ceil(sec * RATES.video_tokens_per_sec), sec };
    }
    default:
      /* 未知/压缩包：只知道体积。按"文本 0.9 字/字节"的上界估，
         并明确标注 uncertain —— 让人知道这个数不能当承诺。 */
      return { tokens: Math.ceil((num(meta.bytes) * 0.9) / RATES.chars_per_token), uncertain: true };
  }
}

/**
 * 生成采样计划。
 * @returns {{
 *   ok:boolean, kind:string, bytes:number,
 *   full:{tokens:number, usd:number},
 *   plan:{tokens:number, usd:number, unit:string, take:number, total:number, step:number|null},
 *   overCap:boolean, ratio:number, note:string, warnings:string[]
 * }}
 */
export function planFor(input = {}) {
  const a = input && typeof input === "object" ? input : {};
  const meta = a.meta && typeof a.meta === "object" ? a.meta : a;
  const bytes = num(a.bytes ?? meta.bytes);
  const kind = KINDS.has(a.kind) ? a.kind : kindOf(a.name, a.mime);
  const warnings = [];

  if (!bytes && !num(meta.chars) && !num(meta.pages) && !num(meta.durationSec)) {
    return {
      ok: false, error: "缺体积/页数/时长，算不出计划", kind, bytes: 0,
      full: { tokens: 0, usd: 0 }, plan: { tokens: 0, usd: 0, unit: "", take: 0, total: 0, step: null },
      overCap: false, ratio: 1, note: "", warnings: [],
    };
  }

  const e = estTokens(kind, { ...meta, bytes });
  const fullTokens = e.tokens;
  const fullUsd = (fullTokens / 1e6) * RATES.usd_per_mtoken_in;

  /* take / total 各自用**同类单位**（页对页、秒对秒、字符对字符），
   * 比例只用来表达"取了多少"，真正的 token 数在每个分支里单独算 ——
   * 混用单位（比如视频的"帧"除"秒"）会算出一个看似合理却完全不对的数。 */
  let unit = "char", total = fullTokens, take = fullTokens, step = null;
  let planTokens = fullTokens;

  switch (kind) {
    case "text": {
      unit = "char";
      total = e.chars || Math.round(bytes * 0.9);
      take = Math.min(total, CAPS.text_chars);
      if (take < total) {
        /* 采样方式：头 + 尾 + 均匀抽样。只取开头会漏结论，只取结尾会漏起因。 */
        step = Math.max(1, Math.round(total / Math.max(1, take / 4)));
        planTokens = Math.ceil((take / RATES.chars_per_token) * 1.15);
        warnings.push(`只读前 ${Math.round(take / 2)} 与后 ${Math.round(take / 2)} 字符，中间每 ${step} 字符抽 1 行`);
      }
      break;
    }
    case "pdf": {
      unit = "page";
      total = e.pages || 1;
      take = Math.min(total, CAPS.pdf_pages);
      if (take < total) {
        step = Math.max(1, Math.round(total / take));
        planTokens = Math.ceil(take * (meta.scanned ? RATES.scan_page_tokens : RATES.pdf_page_tokens) * 1.1);
        warnings.push(`只读 ${take}/${total} 页（每 ${step} 页取 1 页，首末页必取）—— 结论可能落在没读的那几页上`);
      }
      break;
    }
    case "image": {
      unit = "px";
      const w = num(meta.width) || 1280, h = num(meta.height) || 720;
      total = Math.max(w, h);
      take = Math.min(total, CAPS.image_side);
      if (take < total) {
        const scale = take / total;
        planTokens = Math.ceil(w * scale * h * scale * RATES.image_tokens_per_px);
        warnings.push(`长边缩到 ${CAPS.image_side}px：再大的图也会被模型自己缩放，白花钱`);
      }
      break;
    }
    case "audio": {
      unit = "sec";
      total = e.sec || 0;
      take = Math.min(total, CAPS.audio_sec);
      if (take < total) {
        planTokens = Math.ceil(take * RATES.audio_tokens_per_sec);
        warnings.push(`只转写前 ${take} 秒（共 ${total} 秒）—— 后面的内容不会进上下文`);
      }
      break;
    }
    case "video": {
      unit = "frame";
      const sec = e.sec || 0;
      const need = Math.max(1, Math.ceil(sec / 5));      // 每 5 秒 1 帧
      const want = Math.min(CAPS.video_frames, need);
      total = need;
      take = want;
      step = Math.max(1, Math.round(sec / Math.max(1, want)));
      if (want < need || sec > CAPS.video_sec) {
        /* 视频按"帧"算：每帧按 800 token（1280×720 一档），音轨按 30% 时长折算。 */
        planTokens = Math.ceil(want * 800 + Math.min(sec, CAPS.video_sec) * RATES.audio_tokens_per_sec * 0.3);
        if (sec > CAPS.video_sec) warnings.push(`只取前 ${CAPS.video_sec} 秒（共 ${sec} 秒）`);
        else warnings.push(`每隔约 ${step} 秒取 1 帧，共 ${want} 帧 —— 快速动作不会被逐帧看到`);
      }
      break;
    }
    case "archive": {
      unit = "char";
      total = e.tokens;
      take = Math.min(total, CAPS.text_chars);
      if (take < total) planTokens = Math.ceil((take / RATES.chars_per_token) * 1.15);
      warnings.push("压缩包无法在不展开的情况下估准：这里按体积上界估，展开后请重算一次");
      break;
    }
    default:
      if (e.uncertain) warnings.push("未知类型，token 数是按体积的上界估计，不能当承诺");
      break;
  }

  const ratio = total > 0 ? Math.min(1, take / total) : 1;
  const planUsd = (planTokens / 1e6) * RATES.usd_per_mtoken_in;
  const overCap = ratio < 1 || planTokens < fullTokens;

  return {
    ok: true,
    kind, bytes,
    full: { tokens: fullTokens, usd: round6(fullUsd) },
    plan: { tokens: planTokens, usd: round6(planUsd), unit, take, total, step },
    overCap, ratio: round6(ratio),
    note: overCap
      ? `超采样上限：整份约 ${fmtTok(fullTokens)} token（约 $${fullUsd.toFixed(4)}），按计划只取 ${fmtPct(ratio)}`
      : `不需要采样：整份约 ${fmtTok(fullTokens)} token（约 $${fullUsd.toFixed(4)}）`,
    warnings,
  };
}

function round6(n) { return Math.round(Number(n) * 1e6) / 1e6; }
/* "取 0%" 会让人以为是 bug；1% 以下直接写"不足 1%"。 */
function fmtPct(r) {
  const p = Math.round((Number(r) || 0) * 100);
  return p < 1 ? "不足 1%" : p + "%";
}
function fmtTok(n) {
  const v = Number(n) || 0;
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v);
}

/** 一句话回答"值不值得读"。给面板直接用，别让用户自己看数字判断。
 *
 * 判据用**整份**的价格，不是采样后的价格：用户问的是"这东西能不能拖进来"，
 * 而"整份读不起、得采样"本身就是最该被告知的那句话。
 */
export function verdictOf(plan) {
  if (!plan || plan.ok === false) return { level: "unknown", text: "算不出，建议先看文件本身" };
  const whole = plan.full.usd;
  const p = plan.plan.usd;
  if (whole >= 1) {
    return { level: "warn", text: `整份约 $${whole.toFixed(2)}，不能整读；按计划采样约 $${p.toFixed(3)}（取 ${fmtPct(plan.ratio)}）` };
  }
  if (p >= 0.5) return { level: "stop", text: `即使采样也要约 $${p.toFixed(2)}，建议先缩小范围再拖进来` };
  if (p >= 0.1) return { level: "warn", text: `约 $${p.toFixed(2)}，可以读，但别反复读同一份` };
  return { level: "ok", text: `约 $${p.toFixed(3)}，可以直接读` };
}
