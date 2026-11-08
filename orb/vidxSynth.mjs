/**
 * 看视频产物 → 「内容提要 + 关键截图」MD 合成器。
 *
 * 为什么独立成模块：bridge 的 HTTP 路由（在线触发）和一次性补交脚本（离线补历史任务）
 * 都要同一套逻辑——定位任务目录、抽关键帧、组装 MD、落盘到 exports。放一处避免两版漂移。
 *
 * 不负责登记：登记统一交给调用方（路由走 registerArtifact，脚本走 artifactStore.register），
 * 这样根指纹(rootKey)、epoch 等契约与线上完全一致，产物浮层状态判定不会算出两种结论。
 *
 * 安全：vidKey 只接受 [A-Za-z0-9._:-]，绝不接受客户端传来的任意路径；jobDir 仅离线脚本用，
 * 且必须由调用方显式给出（来自已知的 artifacts 树内路径，不是用户自由输入）。
 */
import fs from "node:fs";
import path from "node:path";
import { productRel } from "./artifactView.mjs";

const KEY_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const MAX_FRAMES = 24;

/**
 * 在 layout 的存储树里按 vidKey 找看视频任务目录；多匹配取最新一天。
 *
 * 双形态兼容：
 *   新形（扁平化）：vidx 落点 = <root>/vidx/<day>/<vidKey>，listProducts 返回的 dir
 *     即 <root>/vidx/<day>，直接拼 vidKey 即为任务目录，无会话层，故 cid 记为 "local"；
 *   旧形（只读）：<root>/artifacts/<day>/sessions/<cid>/vidx/<vidKey>，深扫 sessionsDir
 *     下的每个会话子目录，命中则保留真实 cid 便于回填登记表。
 * 同一天内新形优先（先扫新形），跨天取日期最新。
 */
export function findVidxJob(layout, vidKey) {
  if (!KEY_RE.test(String(vidKey || ""))) return null;
  const vk = String(vidKey);
  let best = null;
  try {
    for (const day of layout.listDays()) {
      // 新形：扁平化后 vidx/<day>/<vidKey>
      for (const p of layout.listProducts(day)) {
        if (p.kind !== "vidx") continue;
        const dir = path.join(p.dir, vk);
        if (fs.existsSync(dir) && (!best || day > best.day)) {
          best = { day, cid: "local", dir };
        }
      }
      // 旧形兼容：artifacts/<day>/sessions/<cid>/vidx/<vidKey>
      const sessionsDir = typeof layout.sessionsDir === "function" ? layout.sessionsDir(day) : null;
      if (sessionsDir) {
        let cids;
        try { cids = fs.readdirSync(sessionsDir); } catch { cids = []; }
        for (const cid of cids) {
          const legacyDir = path.join(sessionsDir, cid, "vidx", vk);
          if (fs.existsSync(legacyDir) && (!best || day > best.day)) {
            best = { day, cid: String(cid).slice(0, 64), dir: legacyDir };
          }
        }
      }
    }
  } catch { /* 扫描失败当没找到 */ }
  return best;
}

/** 从帧列表里均匀抽 count 张（去重）。 */
function pickFrames(frames, count) {
  const n = Array.isArray(frames) ? frames.length : 0;
  if (n === 0) return [];
  const c = Math.max(1, Math.min(Number(count) || 12, MAX_FRAMES, n));
  const seen = new Set();
  const out = [];
  const step = c > 1 ? (n - 1) / (c - 1) : 0;
  for (let i = 0; i < c; i++) {
    const fi = frames[Math.round(i * step)];
    if (fi && fi.file && !seen.has(fi.file)) { seen.add(fi.file); out.push(fi); }
  }
  return out;
}

function fmtTime(sec) {
  const s0 = Math.floor(Number(sec) || 0);
  const m = Math.floor(s0 / 60);
  const s = s0 % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function readUtf8(jobDir, name) {
  try { return fs.readFileSync(path.join(jobDir, name), "utf8"); } catch { return ""; }
}

/**
 * 合成并落盘。
 * @param {object} o
 * @param {object} o.layout       写入用 layout（决定产物落在哪个存储根）
 * @param {string} [o.vidKey]     任务 key（与 jobDir 二选一）
 * @param {string} [o.jobDir]     已知任务目录（离线脚本用，优先于 vidKey 扫描）
 * @param {object} [o.sourceLayout] 在别的存储根里找任务时用（历史任务在新根找不到）
 * @param {string} [o.cid]         覆盖会话 id（默认用任务所在会话）
 * @param {string} [o.day]         覆盖日期（默认用任务所在天）
 * @param {number} [o.count]       关键帧张数（默认 12，上限 24）
 * @param {string} [o.summary]     LLM 对话框叙事提要（优先作「内容提要」；只作正文，不用于路径）
 * @returns {{ok:boolean, error?:string, mdName?:string, mdPath?:string,
 *            framesDir?:string, framesDirName?:string, count?:number, size?:number,
 *            rel?:string, cid?:string, day?:string, title?:string, origin?:string,
 *            hasSummary?:boolean}}
 */
export function synthesizeVidxMd(o = {}) {
  const layout = o.layout;
  if (!layout) return { ok: false, error: "缺少 layout" };

  let job;
  if (o.jobDir && fs.existsSync(o.jobDir)) {
    job = { dir: o.jobDir, cid: o.cid || "local", day: o.day || layout.day() };
  } else {
    const findIn = o.sourceLayout || layout;
    const vk = String(o.vidKey || "");
    if (!KEY_RE.test(vk)) return { ok: false, error: "vidKey 非法" };
    job = findVidxJob(findIn, vk);
    if (!job) return { ok: false, error: "未找到该看视频任务：" + vk };
  }

  const { dir: jobDir, cid: jobCid, day: jobDay } = job;
  const useCid = String(o.cid || jobCid || "local").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64) || "local";
  const useDay = /^\d{4}-\d{2}-\d{2}$/.test(o.day || "") ? o.day : (jobDay || layout.day());

  let meta = {};
  try { meta = JSON.parse(readUtf8(jobDir, "meta.json")); } catch { /* 没 meta 也能跑 */ }
  const indexMd = readUtf8(jobDir, "index.md");
  let framesJson = { frames: [] };
  try { framesJson = JSON.parse(readUtf8(jobDir, "frames.json")); } catch { /* 没帧清单也能跑 */ }

  const framesSrc = path.join(jobDir, "frames");
  const safeKey = String(o.vidKey || path.basename(jobDir)).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 48);
  const mdName = `vidx-md-${safeKey}`;
  const framesDirName = `vidx-md-${safeKey}_frames`;

  const exportsDir = layout.kindDir("exports", useCid, useDay);
  if (!exportsDir) return { ok: false, error: "无法解析/创建 exports 目录" };
  const framesOut = path.join(exportsDir, framesDirName);
  try { fs.mkdirSync(framesOut, { recursive: true }); } catch (e) {
    return { ok: false, error: "帧目录创建失败：" + (e && e.message || e) };
  }

  const chosen = pickFrames(framesJson.frames || [], o.count);
  for (const f of chosen) {
    const src = path.join(framesSrc, f.file);
    const dst = path.join(framesOut, f.file);
    try { fs.copyFileSync(src, dst); } catch { /* 单张失败不中断 */ }
  }

  const title = meta.title || (indexMd.match(/^#\s+(.+)$/m) || [, "看视频内容提要"])[1];
  const origin = meta.origin || (meta.source && meta.source.url) || "";
  const dur = meta.durationSec ? `${Math.round(Number(meta.durationSec))} 秒` : "";

  /* 叙事提要的单一事实源：优先前端传来的对话框叙事 → 任务目录里已落盘的 summary.md
     → meta.json 的 summary/narrative 字段；都没有就如实标注缺失，绝不拿技术元数据冒充。
     曾经这里直接把 index.md 正文（时长/帧率/字幕段数/情绪引擎）塞进「内容提要」，
     用户在对话框看到的 LLM 叙事却和 MD 里的「内容提要」对不上 —— 两者本就不是一回事。 */
  const cleanText = (s) => String(s ?? "").replace(/\r\n/g, "\n").trim().slice(0, 20000);
  let narrative = cleanText(o.summary);
  if (!narrative) narrative = cleanText(readUtf8(jobDir, "summary.md"));
  if (!narrative) narrative = cleanText(meta.summary || meta.narrative || "");
  // 拿到叙事就顺手落盘：以后重跑 / 离线脚本合成也能复用同一份，避免两份提要对不上。
  if (o.summary && narrative) {
    try { fs.writeFileSync(path.join(jobDir, "summary.md"), narrative, "utf8"); } catch { /* 只读目录不影响主流程 */ }
  }
  // index.md 的正文是技术画像，降级成「技术信息」小节；一级标题与文档标题重复，去掉。
  const techBody = indexMd.replace(/^---[\s\S]*?---/, "").trim()
    .replace(/^#\s+.*(?:\n|$)/m, "")
    .replace(/^##\s+/gm, "### ")
    .trim();

  const md = [];
  md.push(`# ${title}`);
  md.push("");
  if (origin) md.push(`- 来源：${origin}`);
  if (dur) md.push(`- 时长：${dur}`);
  md.push(`- 生成时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
  md.push(`- 视频任务 key：${String(o.vidKey || path.basename(jobDir))}`);
  md.push("");
  md.push("## 内容提要");
  md.push("");
  md.push(narrative || "（该任务未生成文字提要，仅附关键截图与技术信息）");
  md.push("");
  md.push("## 技术信息与产物说明");
  md.push("");
  md.push(techBody || "（无技术信息）");
  md.push("");
  md.push(`## 关键截图（共 ${chosen.length} 张，按时间均匀抽取）`);
  md.push("");
  for (const f of chosen) {
    const t = typeof f.t === "number" ? fmtTime(f.t) : "";
    md.push(`![${t || f.file}](${framesDirName}/${f.file})`);
    if (t) md.push(`*${t}*`);
    md.push("");
  }

  const mdText = md.join("\n");
  const mdPath = path.join(exportsDir, `${mdName}.md`);
  try { fs.writeFileSync(mdPath, mdText, "utf8"); }
  catch (e) { return { ok: false, error: "MD 写入失败：" + (e && e.message || e) }; }

  const size = Buffer.byteLength(mdText, "utf8");
  const pr = productRel(useDay, useCid, "exports", `${mdName}.md`);
  if (!pr.ok) return { ok: false, error: "产物 rel 非法：" + pr.reason };

  return {
    ok: true, mdName, mdPath, framesDir: framesOut, framesDirName,
    count: chosen.length, size, rel: pr.rel, cid: useCid, day: useDay,
    title, origin, hasSummary: !!narrative,
  };
}
