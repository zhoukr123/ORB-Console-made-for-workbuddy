/* 产物登记：相对路径校验、按天 jsonl 追加、manifest 绝不存绝对路径。 */
import * as fsDefault from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const ALLOWED_EXT = [
  "mp4", "webm", "mkv", "srt", "ass", "png", "jpg", "jpeg", "md", "json",
  "zip", "pdf", "csv", "vtt", "db", "html", "webp", "txt", "lrc", "tsv",
  "docx", "xlsx", "pptx",
];

// 内部状态文件 / 目录，一律拒绝作为产物路径
export const DENIED_FILES = [
  ".bridge.json", "bridge.json", "memory.json", "credits.json", "vault",
  "triggers", "audit", "audit.jsonl", "cost-ledger.json", "local.conf",
  "credentials.json", "token.json", "cookies.json", "config.json",
  "safety.stop", ".env",
];

const DENIED = new Set(DENIED_FILES.map((s) => s.toLowerCase()));
const ALLOWED = new Set(ALLOWED_EXT);
const STATUSES = ["ok", "missing", "rootChanged", "interrupted", "expired"];
const dayTag = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
const str = (v) => (v == null ? "" : String(v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const token = (v) => String(v ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);

/* rel 安全校验：防穿越 / 绝对路径 / 隐藏文件 / 黑名单 / 非法扩展名。 */
function checkRel(rel) {
  const s = String(rel ?? "").trim();
  if (!s) return { ok: false, reason: "empty rel" };
  if (s.includes("\\")) return { ok: false, reason: "backslash" };
  if (s.includes("..")) return { ok: false, reason: "parent traversal" };
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.startsWith("/")) {
    return { ok: false, reason: "absolute path" };
  }
  if (/[\x00-\x1f]/.test(s)) return { ok: false, reason: "control char" };
  const segs = s.split("/").filter(Boolean);
  if (!segs.length) return { ok: false, reason: "empty rel" };
  for (const seg of segs) {
    if (DENIED.has(seg.toLowerCase())) return { ok: false, reason: `denied: ${seg}` };
    if (seg.startsWith(".")) return { ok: false, reason: `hidden: ${seg}` };
  }
  const file = segs[segs.length - 1];
  const ext = (file.includes(".") ? file.split(".").pop() : "").toLowerCase();
  if (!ALLOWED.has(ext)) return { ok: false, reason: `ext not allowed: ${ext}` };
  return { ok: true, rel: segs.join("/") };
}

export function createArtifactStore(opts = {}) {
  const dirOf = typeof opts.dir === "function" ? opts.dir : () => (opts.dir || ".");
  const fs = opts.fs || fsDefault;
  const now = opts.now || Date.now;

  const rows = [];
  const byId = new Map();
  const files = new Set();
  let registered = 0;

  function load() {
    const d = dirOf();
    try {
      for (const name of fs.readdirSync(d)) {
        if (!name.startsWith("artifacts.") || !name.endsWith(".jsonl")) continue;
        files.add(name);
        let txt;
        try { txt = fs.readFileSync(path.join(d, name), "utf8"); } catch { continue; }
        for (const ln of txt.split("\n")) {
          if (!ln.trim()) continue;
          try {
            const e = JSON.parse(ln);
            if (e && e.id && !byId.has(e.id)) { rows.push(e); byId.set(e.id, e); }
          } catch {}
        }
      }
    } catch {}
  }

  function makeId(conversationId, epoch, kind, rel) {
    const key = JSON.stringify([conversationId, epoch, kind, rel]);
    return "a_" + createHash("sha256").update(key).digest("hex").slice(0, 20);
  }

  function register(rec) {
    const d = dirOf();
    const r = rec && typeof rec === "object" ? rec : {};
    const c = checkRel(r.rel);
    if (!c.ok) return { ok: false, id: null, reason: c.reason };

    const ext = String(r.ext || c.rel.split(".").pop() || "").toLowerCase();
    if (!ALLOWED.has(ext)) return { ok: false, id: null, reason: "ext not allowed" };

    const id = makeId(str(r.conversationId), num(r.epoch), token(r.kind), c.rel);
    if (byId.has(id)) return { ok: true, id, duplicate: true };  // 重复 id 不重复登记

    const entry = {
      id,
      conversationId: str(r.conversationId),
      epoch: num(r.epoch),
      ticketId: str(r.ticketId),
      kind: token(r.kind),
      rel: c.rel,
      ext,
      size: num(r.size),
      sha: str(r.sha),
      /* 存储根指纹（只存哈希，不存绝对路径）。换根后旧条目据此显示「存储根已换」，
         而不是一句没用的「文件缺失」。老数据没有这个字段，走 ctx 兜底即可。 */
      rootKey: token(r.rootKey),
      createdAt: num(r.createdAt) || now(),
      status: STATUSES.includes(r.status) ? r.status : "ok",
    };

    const file = path.join(d, `artifacts.${dayTag(now())}.jsonl`);
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
      files.add(path.basename(file));
    } catch (e) {
      return { ok: false, id, reason: `write failed: ${e?.message || e}` };
    }
    rows.push(entry);
    byId.set(id, entry);
    registered++;
    return { ok: true, id };
  }

  function list(o = {}) {
    let rs = rows.slice();
    if (o.conversationId != null) rs = rs.filter((e) => e.conversationId === String(o.conversationId));
    rs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    let lim = o.limit == null ? 100 : Number(o.limit);
    if (!Number.isFinite(lim)) lim = 100;
    lim = Math.max(0, Math.min(lim, 10000));
    if (lim === 0) return [];
    return rs.slice(-lim).map((e) => ({ ...e }));
  }

  function byConversation(id) {
    return rows.filter((e) => e.conversationId === String(id)).map((e) => ({ ...e }));
  }

  function status(entry, o = {}) {
    if (o.rootChanged) return "rootChanged";
    if (o.mediaExpired) return "expired";
    if (!entry) return "missing";
    const s = entry.status;
    if (s === "interrupted") return "interrupted";
    if (s === "missing") return "missing";
    if (s === "expired") return "expired";
    if (s === "rootChanged") return "rootChanged";
    return "ok";
  }

  function resolve(root, kind, rel) {
    if (kind != null && /[\\/]/.test(String(kind))) return { ok: false, abs: null, reason: "bad kind" };
    const c = checkRel(rel);
    if (!c.ok) return { ok: false, abs: null, reason: c.reason };
    const base = path.resolve(String(root || "."));
    const abs = path.resolve(base, c.rel);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      return { ok: false, abs: null, reason: "escape root" };
    }
    return { ok: true, abs };
  }

  /* manifest 只保存白名单字段 + 清洗过的标量，绝不存绝对路径。 */
  function cleanEntry(e) {
    if (!e || typeof e !== "object") return null;
    const out = {};
    for (const k of ["id", "conversationId", "epoch", "ticketId", "kind", "rel", "ext", "size", "sha", "rootKey", "createdAt", "status"]) {
      const v = e[k];
      if (v == null) continue;
      if (typeof v === "string" &&
          (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith("/") || v.startsWith("\\") || v.includes(".."))) continue;
      out[k] = v;
    }
    return out;
  }

  function writeManifest(targetDir, entries, meta = {}) {
    const d = dirOf();
    const outDir = String(targetDir || d);
    const list = (Array.isArray(entries) ? entries : []).map(cleanEntry).filter(Boolean);
    const m = {};
    const src = meta && typeof meta === "object" ? meta : {};
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v == null || typeof v === "object") continue;
      if (typeof v === "string" &&
          (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith("/") || v.startsWith("\\"))) continue;
      m[k] = v;
    }
    const t = now();
    const doc = { version: 1, generatedAt: t, meta: { ...m, generatedAt: t }, entries: list };
    const file = path.join(outDir, "manifest.json");
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const part = `${file}.part`;
      const buf = Buffer.from(JSON.stringify(doc, null, 2), "utf8");
      fs.writeFileSync(part, buf);
      try { fs.renameSync(part, file); }
      catch { fs.writeFileSync(file, buf); try { fs.unlinkSync(part); } catch {} }
      return { ok: true, path: file, bytes: buf.length };
    } catch (e) {
      return { ok: false, path: file, error: String(e?.message || e) };
    }
  }

  function readManifest(targetDir) {
    const d = dirOf();
    const file = path.join(String(targetDir || d), "manifest.json");
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!doc || typeof doc !== "object") return null;
      return {
        version: doc.version, generatedAt: doc.generatedAt,
        meta: doc.meta || {}, entries: Array.isArray(doc.entries) ? doc.entries : [],
      };
    } catch { return null; }
  }

  function stats() {
    return { registered, files: files.size, rows: rows.length };
  }

  load();
  return { register, list, byConversation, status, resolve, writeManifest, readManifest, stats };
}
