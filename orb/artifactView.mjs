/**
 * 产物浮层的数据整形层：纯函数，零 Electron 依赖、零目录扫描。
 *
 * 存在的理由：I-17 要求「按 artifactId 查表 → 主进程解析 kind+rel → 校验前缀
 * 与扩展名」并显示四类失效态。如果这段判断散在 bridge 与 panel 两处，两边迟早
 * 会算出不同结论（面板说"正常"、主进程说"文件没了"）。这里统一定义 rel 形状、
 * 状态判定和内联预览边界，两端只负责 IO。
 *
 * 硬约束：
 *   · rel 相对存储根，形状固定为 <kind>/<YYYY-MM-DD>/<name>（kind ∈ KINDS），绝不存绝对路径；
 *     旧登记表里的 <YYYY-MM-DD>/sessions/<cid>/<kind>/<name> 仍由 resolveSafe 双形态兼容；
 *   · 四类失效态 missing / rootChanged / interrupted / expired 各有明确来源；
 *   · 预览只吃文本类扩展名，二进制一律不读，且必须截断；
 *   · 不许「扫目录找文件」——路径全部由固定形状推导。
 */
import { createHash } from "node:crypto";
import { ALLOWED_EXT } from "./artifactStore.mjs";
import { KINDS } from "./artifactLayout.mjs";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EXTS = new Set(ALLOWED_EXT);
const KIND_SET = new Set(KINDS);
const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000;

/** 可以内联展开看内容的格式：一律按纯文本渲染，绝不 innerHTML（HTML 只显示源码）。 */
export const PREVIEW_EXTS = Object.freeze([
  "md", "txt", "csv", "tsv", "html", "json", "vtt", "lrc", "srt", "ass",
]);
const PREVIEW_SET = new Set(PREVIEW_EXTS);

/** 有保留期的临时媒体：超期即 expired，不假装文件还在。 */
export const MEDIA_EXTS = Object.freeze([
  "mp4", "webm", "mkv", "png", "jpg", "jpeg", "webp",
]);
const MEDIA_SET = new Set(MEDIA_EXTS);

export const STATUSES = Object.freeze(["ok", "missing", "rootChanged", "interrupted", "expired"]);

export const STATUS_META = Object.freeze({
  ok:           { label: "已就绪",     hint: "文件在产物树里，可以定位或打开", tone: "ok" },
  missing:      { label: "文件缺失",   hint: "登记表里有这条，但文件已被移走或删除", tone: "warn" },
  rootChanged:  { label: "存储根已换", hint: "这条登记在旧的存储根下，换根后原路径不再生效", tone: "warn" },
  interrupted:  { label: "会话被中断", hint: "急停 / 中断时留下的只读快照，文件可能不完整", tone: "warn" },
  expired:      { label: "媒体已过期", hint: "超过媒体保留期，临时文件可能已被清理", tone: "muted" },
});

const safeSeg = (v) => String(v ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);

/** 存储根指纹：只存哈希，绝不把绝对路径写进登记表 / manifest。 */
export function rootKeyOf(root) {
  return createHash("sha256").update(String(root ?? "")).digest("hex").slice(0, 16);
}

/** 与 artifactLayout.cjs dayOf 同口径：固定 UTC+8，跨午夜归结束日。 */
export function dayFromTs(ts, fallback) {
  const n = Number(ts);
  const base = Number.isFinite(n) && n > 0 ? n : (Number(fallback) || Date.now());
  try {
    const d = new Date(base + SHANGHAI_OFFSET_MS);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  } catch {}
  return new Date(Date.now() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 由固定形状推导 rel：<kind>/<day>/<name>（扁平化，类别在下、日期在中、文件名在上）。
 * 任何一段不合法都拒绝，宁可这条产物没卡片，也不能让面板拿到一个能指向树外的路径。
 * cid 不再进入 rel（扁平化后产物不再按会话归集），但保留参数以兼容旧调用方签名，
 * 仅做防穿越校验（拒绝含 .. / 分隔符的 cid）。
 */
export function productRel(day, cid, kind, fileName) {
  const d = String(day ?? "");
  if (!DAY_RE.test(d)) return { ok: false, reason: "bad-day" };
  const c = String(cid ?? "");
  if (c && (/[\/\\]/.test(c) || c.includes(".."))) return { ok: false, reason: "bad-cid" };
  const k = String(kind ?? "");
  if (!KIND_SET.has(k)) return { ok: false, reason: "bad-kind" };
  const raw = String(fileName ?? "");
  if (!raw || raw.includes("\\") || raw.includes("..") || /[\x00-\x1f]/.test(raw)) {
    return { ok: false, reason: "bad-name" };
  }
  const name = raw.split("/").filter(Boolean).pop() || "";
  if (!name || name.startsWith(".")) return { ok: false, reason: "bad-name" };
  const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
  if (!EXTS.has(ext)) return { ok: false, reason: "bad-ext" };
  return { ok: true, rel: `${k}/${d}/${name}`, name, ext };
}

/**
 * 老登记表只存了 basename（没有 kind/day 前缀），resolveSafe 会按新形拒掉；
 * 这里按创建时间 + 会话 ID 把形状补全为 <kind>/<day>/<name>，让历史产物也能有卡片。
 * 补不出来就返回空串，由调用方如实显示「路径不可用」，绝不猜一个可能指向别处的目录。
 * 已经是完整 rel（含 "/"）的条目原样返回：旧形 <day>/sessions/<cid>/<kind>/<name>
 * 由 resolveSafe 双形态兼容，不在这里改写。
 */
export function inferRel(entry, ctx = {}) {
  const raw = String(entry?.rel || "");
  if (!raw) return "";
  if (raw.includes("/")) return raw;
  const day = String(ctx.day || dayFromTs(entry?.createdAt, ctx.now));
  const cid = safeSeg(ctx.cid || entry?.conversationId);
  const p = productRel(day, cid, ctx.kind || "exports", raw);
  return p.ok ? p.rel : "";
}

/**
 * 状态判定（优先级有意为之）：
 *   中断 > 已显式过期 > 换根 > 媒体超期 > 文件不存在 > 其他显式状态 > 正常
 * 「换根」必须排在「不存在」前面，否则用户换过存储根之后，所有旧产物只会显示
 * 一句没用的「文件缺失」，看不到真正的原因。
 */
export function statusOf(entry, ctx = {}) {
  if (!entry || typeof entry !== "object") return "missing";
  const declared = String(entry.status || "ok");
  if (declared === "interrupted") return "interrupted";
  if (declared === "expired") return "expired";
  if (declared === "rootChanged") return "rootChanged";

  const rk = ctx.rootKey == null ? entry.rootKey : ctx.rootKey;
  if (rk && ctx.currentRootKey && rk !== ctx.currentRootKey) return "rootChanged";

  const now = Number(ctx.now) || 0;
  const keep = Number(ctx.mediaRetentionMs) || 0;
  const ext = String(entry.ext || "").toLowerCase();
  if (now > 0 && keep > 0 && MEDIA_SET.has(ext)) {
    const at = Number(entry.createdAt) || 0;
    if (at > 0 && now - at > keep) return "expired";
  }
  if (ctx.exists === false) return "missing";
  if (declared === "missing") return "missing";
  return "ok";
}

/** 单条登记 → 面板卡片需要的全部字段。面板不再自己判断任何状态。 */
export function viewRow(entry, ctx = {}) {
  const e = entry && typeof entry === "object" ? entry : {};
  const status = statusOf(e, ctx);
  const meta = STATUS_META[status] || STATUS_META.ok;
  const ext = String(e.ext || "").toLowerCase();
  const rel = String(e.rel || "");
  const name = rel.split("/").filter(Boolean).pop() || "未命名产物";
  return {
    id: String(e.id || ""),
    conversationId: String(e.conversationId || ""),
    ticketId: String(e.ticketId || ""),
    kind: String(e.kind || ""),
    rel,
    name,
    ext,
    size: Number(e.size) || 0,
    createdAt: Number(e.createdAt) || 0,
    status,
    statusLabel: meta.label,
    statusHint: meta.hint,
    tone: meta.tone,
    previewable: PREVIEW_SET.has(ext) && status === "ok",
    locatable: status === "ok",
  };
}

/** 批量整形：按时间正序，支持 since（只取某轮回答之后新产生的产物）。 */
export function viewRows(entries, ctx = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const since = Number(ctx.since) || 0;
  return list
    .filter((e) => !since || (Number(e?.createdAt) || 0) >= since)
    .map((e) => viewRow(e, ctx))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 预览截断：面板内联展开，不做分页，超长必须显式说明被截断。 */
export function truncatePreview(text, cap = 24000) {
  const s = String(text ?? "");
  const lim = Math.max(0, Math.min(Number(cap) || 24000, 200000));
  if (s.length <= lim) return { text: s, truncated: false, chars: s.length };
  return { text: s.slice(0, lim), truncated: true, chars: s.length };
}

export function isPreviewable(ext) { return PREVIEW_SET.has(String(ext || "").toLowerCase()); }
export function isMedia(ext) { return MEDIA_SET.has(String(ext || "").toLowerCase()); }

export default { productRel, inferRel, statusOf, viewRow, viewRows, truncatePreview, rootKeyOf, dayFromTs };
