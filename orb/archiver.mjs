/* 归档：.pending/<cid> → YYYY-MM-DD/<cid> 同卷 rename（跨卷/失败退化 copy 并记入 manifest）。
 * manifest 绝不存绝对路径：定位靠 kind+rel 现算；只留白名单标量。
 * 三档：文本/字幕/截图/zip → copy(或显式 hardlink 且标 link:"hardlink")；
 *       L4 原始媒体 → 只写 { ref, expiresAt, link:"none" } 引用，绝不落副本、绝不硬链接
 *       （硬链接会让 7 天清理后 inode 保活、磁盘不释放，默认纯复制）。
 * interrupted 会话目录标只读快照：manifest.frozen=true。
 * 严禁合并连续 click/wait/type：本模块不提供任何批量 GUI 动作合并能力
 * （会吃掉危险确认中断点 / 破坏急停响应粒度 / 模糊回滚边界）。
 * 写盘失败一律收敛进 errors[]，不抛不崩。 */
import * as fsDefault from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const OFFSET_MS = 8 * 3600 * 1000;
const RETENTION_MS = 7 * 24 * 3600 * 1000;       // L4 引用 7 天，呼应「7 天清理」纪律
const MANIFEST_FIELDS = [
  "kind", "rel", "epoch", "conversationId", "size", "sha", "createdAt",
  "sessionEndAt", "link", "ref", "expiresAt", "layer", "frozen", "note",
];

const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function dayTag(ts) {
  const t = Number(ts);
  const base = Number.isFinite(t) ? t : 0;
  const d = new Date(base + OFFSET_MS);
  return isNaN(d.getTime()) ? "1970-01-01" : d.toISOString().slice(0, 10);
}

/* 相对路径清洗：拒绝对路径 / 盘符 / 反斜杠 / 穿越 / 控制字符。 */
function cleanRel(rel) {
  const s = String(rel ?? "").trim().replace(/\\/g, "/");
  if (!s) return null;
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || s.startsWith("/")) return null;
  if (/[\x00-\x1f]/.test(s)) return null;
  const segs = s.split("/").filter(Boolean);
  if (!segs.length || segs.some((x) => x === ".." || x === ".")) return null;
  return segs.join("/");
}

/* 绝不回传绝对值：字符串含盘符/根路径/穿越片段一律丢弃。 */
function cleanScalar(v) {
  if (v == null) return undefined;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (/^[A-Za-z]:[\\/]/.test(v) || v.startsWith("/") || v.startsWith("\\") || v.includes("..")) return undefined;
    return v;
  }
  return undefined;
}

/* 白名单字段 + 标量清洗，保证 manifest 内容绝无绝对路径。 */
function cleanEntry(e) {
  if (!e || typeof e !== "object") return null;
  const out = {};
  for (const k of MANIFEST_FIELDS) {
    const v = cleanScalar(e[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function toBuffer(content) {
  if (content == null) return null;
  if (Buffer.isBuffer(content)) return content;
  if (typeof content === "string") return Buffer.from(content, "utf8");
  try { return Buffer.from(JSON.stringify(content), "utf8"); } catch { return null; }
}

export function createArchiver(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const fs = o.fs || fsDefault;
  const now = typeof o.now === "function" ? o.now : Date.now;
  const rootResolved = path.resolve(String(o.root ?? "."));
  const linkMode = o.linkMode === "hardlink" ? "hardlink" : "copy";  // 默认纯复制

  let archived = 0, copied = 0, referenced = 0, errorsCount = 0;

  function resolveDir(dir) {
    const s = String(dir);
    return path.isAbsolute(s) ? s : path.join(rootResolved, s);
  }

  /* 原子写：.part + rename，跨卷/失败退化直写；绝不抛。 */
  function persist(file, buf) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const part = `${file}.part`;
      fs.writeFileSync(part, buf);
      try { fs.renameSync(part, file); }
      catch { fs.writeFileSync(file, buf); try { fs.unlinkSync(part); } catch {} }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  function writeManifest(dir, entries, meta) {
    const file = path.join(resolveDir(dir), "manifest.json");
    const list = (Array.isArray(entries) ? entries : []).map(cleanEntry).filter(Boolean);
    const m = {};
    const src = meta && typeof meta === "object" ? meta : {};
    for (const k of Object.keys(src)) {
      const v = cleanScalar(src[k]);
      if (v !== undefined) m[k] = v;
    }
    const doc = { version: 1, generatedAt: now(), ...m, entries: list };
    const r = persist(file, Buffer.from(JSON.stringify(doc, null, 2), "utf8"));
    return { ok: r.ok, path: file, ...(r.ok ? {} : { error: r.error }) };
  }

  function readManifest(dir) {
    const file = path.join(resolveDir(dir), "manifest.json");
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      return doc && typeof doc === "object" ? doc : null;
    } catch { return null; }
  }

  /* 跨卷退化：递归纯复制，绝不硬链接。 */
  function copyTree(src, dst, errs) {
    try { fs.mkdirSync(dst, { recursive: true }); }
    catch (e) { errs.push(`mkdir dest: ${e?.message || e}`); return; }
    let names;
    try { names = fs.readdirSync(src); }
    catch (e) { errs.push(`readdir pending: ${e?.message || e}`); return; }
    for (const name of names) {
      const s = path.join(src, name);
      const d = path.join(dst, name);
      let st;
      try { st = fs.statSync(s); } catch { continue; }
      if (st.isDirectory()) copyTree(s, d, errs);
      else {
        try { fs.copyFileSync(s, d); }
        catch (e) { errs.push(`copy ${name}: ${e?.message || e}`); }
      }
    }
  }

  function archive(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const s = a.session && typeof a.session === "object" ? a.session : {};
    const errs = [];
    const cid = String(s.conversationId ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64)
      || `unknown-${now()}`;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(s.day ?? "")) ? String(s.day)
      : dayTag(num(s.sessionEndAt, now()));
    const relDir = cleanRel(s.dir) || `${day}/${cid}`;
    const destDir = path.join(rootResolved, relDir);
    const pendingDir = path.join(rootResolved, ".pending", cid);
    const manifestEntries = [];
    let localCopied = 0, localSkipped = 0, localReferenced = 0;
    let crossVolume = false;

    // 1) 同卷 rename 整个 .pending/<cid> → <day>/<cid>；跨卷/失败退 copy 并记入 manifest
    try { fs.mkdirSync(path.dirname(destDir), { recursive: true }); }
    catch (e) { errs.push(`mkdir parent: ${e?.message || e}`); }
    let pendingExists = false;
    try { pendingExists = fs.existsSync(pendingDir); } catch { pendingExists = false; }
    if (pendingExists) {
      try { fs.renameSync(pendingDir, destDir); }   // 同卷，原子、快
      catch {
        crossVolume = true;
        copyTree(pendingDir, destDir, errs);
      }
    } else {
      try { fs.mkdirSync(destDir, { recursive: true }); }
      catch (e) { errs.push(`mkdir dest: ${e?.message || e}`); }
    }

    // 2) 逐条处理 entries
    const list = Array.isArray(a.entries) ? a.entries : [];
    const epoch = num(s.epoch, 0);
    const sessionEndAt = num(s.sessionEndAt, now());
    const createdAt = now();
    for (const raw of list) {
      const e = raw && typeof raw === "object" ? raw : {};
      const kind = String(e.kind ?? "file").replace(/[\\/]/g, "");
      const rel = cleanRel(e.rel);
      if (!rel) { errs.push(`invalid rel: ${String(e.rel)}`); localSkipped++; continue; }

      // L4 原始媒体：只留引用，绝不落任何副本、绝不硬链接
      if (e.layer === "L4") {
        manifestEntries.push({
          kind, rel, epoch, conversationId: cid,
          ref: rel, expiresAt: now() + RETENTION_MS, link: "none", layer: "L4",
        });
        localReferenced++; localSkipped++;
        continue;
      }

      let buf = toBuffer(e.content);
      let link = linkMode === "hardlink" ? "hardlink" : "copy";
      if (buf == null && e.abs) {
        try { buf = fs.readFileSync(e.abs); }
        catch (err) { buf = null; errs.push(`read abs ${rel}: ${err?.message || err}`); }
      }
      // target 是本机写入用的绝对路径，绝不进 manifest
      const target = path.join(destDir, rel);
      try { fs.mkdirSync(path.dirname(target), { recursive: true }); }
      catch (err) { errs.push(`mkdir target ${rel}: ${err?.message || err}`); }

      let written = false;
      if (buf != null) {
        // L4 已拦截；其余默认纯复制，仅显式 hardlink 且非 L4 才用 link
        try {
          if (link === "hardlink" && e.abs && e.content == null) {
            try { fs.unlinkSync(target); } catch {}
            fs.linkSync(e.abs, target);   // 仅非原始媒体允许 hardlink
          } else {
            fs.writeFileSync(target, buf);
            link = "copy";
          }
          written = true;
        } catch (err) { errs.push(`write ${rel}: ${err?.message || err}`); }
      } else if (e.abs) {
        try { fs.copyFileSync(e.abs, target); written = true; link = "copy"; }
        catch (err) { errs.push(`copy ${rel}: ${err?.message || err}`); }
      } else {
        written = false;   // 无 content / abs：视为 .pending 已落位的存量文件，只登记元数据
      }

      const size = buf != null ? buf.length : num(e.size, 0);
      const sha = buf != null ? sha256(buf) : "";
      manifestEntries.push({
        kind, rel, epoch, conversationId: cid,
        size, sha, createdAt, sessionEndAt, link,
        ...(written ? {} : { note: "pending-or-metadata-only" }),
      });
      if (written) localCopied++; else localSkipped++;
    }

    // 3) logs.jsonl 写进同一 manifest 目录
    try {
      let chunk = "";
      if (Array.isArray(a.logs)) {
        for (const l of a.logs) chunk += (typeof l === "string" ? l : JSON.stringify(l)) + "\n";
      } else if (typeof a.logs === "string") {
        chunk = a.logs.endsWith("\n") ? a.logs : a.logs + "\n";
      }
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "logs.jsonl"), chunk, "utf8");
    } catch (e) { errs.push(`logs.jsonl: ${e?.message || e}`); }

    // 4) manifest（frozen 只读快照 + 跨卷退化标记）
    const frozen = s.interrupted === true || s.frozen === true;
    const w = writeManifest(destDir, manifestEntries, {
      conversationId: cid, day, dir: relDir, epoch, sessionEndAt,
      frozen, crossVolume, degraded: crossVolume ? "copy" : "none", linkMode,
    });
    if (!w.ok) errs.push(`manifest: ${w.error || "write failed"}`);

    copied += localCopied;
    referenced += localReferenced;
    if (w.ok) archived++;
    errorsCount += errs.length;
    return {
      ok: w.ok,
      manifestPath: w.path,
      copied: localCopied,
      skipped: localSkipped,
      errors: errs,
    };
  }

  function stats() {
    return { archived, copied, referenced, errors: errorsCount };
  }

  return { archive, writeManifest, readManifest, stats };
}
