/* #131 存储根 / 扁平化产物浮层验证（11-07 收尾）。
 *
 * 用户此前要求「重启控制台后确认存储根与产物浮层生效」。这里不打扰正在运行的
 * 控制台（不重启、不写用户文件），改为从磁盘 + 真实配置 + artifactView 纯函数
 * 三个层面做可复跑核验：读 orb-state.json 拿生效中的 storageRoot，检查
 * <kind>/<day>/<name> 扁平形状，再用产物浮层的 productRel/inferRel/viewRow
 * 实解析一个真实文件，确认「路径形状 → 浮层行」这条链没断。
 *
 * 用法：node tools/verify-storage-flat.mjs [--state=<orb-state.json>] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { productRel, inferRel, viewRow, rootKeyOf, isPreviewable } from "../artifactView.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const stateFile = arg("state", path.join(ROOT, "desktop/.orbdata/orb-state.json"));
const asJson = process.argv.includes("--json");

const KINDS = ["recordings", "screenshots", "vidx", "exports", "archive", "misc"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function verifyStorage({ statePath, fsImpl = fs, pathImpl = path } = {}) {
  const out = { ok: true, checks: [], statePath, storageRoot: null, kinds: {}, flatFiles: 0,
    samples: [], legacy: null, governance: null, caveats: [] };
  const ck = (name, ok, detail) => { out.checks.push({ name, ok: !!ok, detail: String(detail ?? "") }); if (!ok) out.ok = false; };

  let state = {};
  try { state = JSON.parse(fsImpl.readFileSync(statePath, "utf8")); }
  catch (e) { ck("读取 orb-state.json", false, e.message); return out; }
  const root = String(state.storageRoot || "").trim();
  out.storageRoot = root || null;
  ck("storageRoot 已配置", !!root, root);
  ck("存储根目录存在", !!root && fsImpl.existsSync(root), root);

  if (!root || !fsImpl.existsSync(root)) return out;

  for (const k of KINDS) {
    const dir = pathImpl.join(root, k);
    const exists = fsImpl.existsSync(dir);
    let days = [];
    if (exists) {
      days = fsImpl.readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && DAY_RE.test(d.name)).map((d) => d.name);
    }
    out.kinds[k] = { exists, days };
    ck(`类别目录 ${k} 存在`, exists, dir);
  }

  /* 扁平形状：<kind>/<YYYY-MM-DD>/<name>；旧形 <day>/sessions/<cid>/<kind>/<name> 不得再出现。 */
  const badShape = [];
  const legacyShape = [];
  for (const k of KINDS) {
    const dir = pathImpl.join(root, k);
    if (!fsImpl.existsSync(dir)) continue;
    for (const day of out.kinds[k].days) {
      const dd = pathImpl.join(dir, day);
      for (const ent of fsImpl.readdirSync(dd, { withFileTypes: true })) {
        if (ent.isDirectory() && ent.name === "sessions") legacyShape.push(pathImpl.join(k, day, "sessions"));
        if (!ent.isFile()) continue;
        const rel = `${k}/${day}/${ent.name}`;
        out.flatFiles++;
        if (out.samples.length < 3) out.samples.push({ rel, abs: pathImpl.join(dd, ent.name), bytes: fsImpl.statSync(pathImpl.join(dd, ent.name)).size });
        const m = rel.match(/^([^/]+)\/(\d{4}-\d{2}-\d{2})\/(.+)$/);
        if (!m || !KINDS.includes(m[1])) badShape.push(rel);
      }
    }
  }
  ck("所有产物 rel 都是 <kind>/<day>/<name>", badShape.length === 0, badShape.slice(0, 3).join(", "));
  ck("扁平目录里没有旧 sessions 层级", legacyShape.length === 0, legacyShape.join(", "));
  ck("确实扫到了扁平产物", out.flatFiles > 0, `${out.flatFiles} 个文件`);

  /* 产物浮层链路：真实 rel → productRel → inferRel → viewRow。 */
  if (out.samples.length) {
    const s = out.samples[0];
    const [kind, day, name] = s.rel.split("/");
    const built = productRel(day, "", kind, name);
    ck("productRel 能重建真实 rel", built.ok && built.rel === s.rel, JSON.stringify(built));
    const entry = { id: "verify-131", rel: s.rel, kind, ext: path.extname(name).slice(1),
      createdAt: Date.now(), conversationId: "local-verify" };
    const inferred = inferRel(entry, { root });
    ck("inferRel 保留扁平 rel 不回退旧形", inferred === s.rel, inferred);
    const row = viewRow(entry, { root });
    ck("viewRow 产出可展示行", row && row.rel === s.rel && row.name === name, JSON.stringify(row).slice(0, 200));
    ck("viewRow 判为文件存在（非 missing）", row.status === "ok", row.status);
    out.previewable = isPreviewable(entry.ext || "");
    out.rootKey = rootKeyOf(root);
  }

  /* 旧 artifacts/ 目录：之前只读核对过 13 个文件全部有副本，仍未删，等用户拍板。 */
  const legacyDir = pathImpl.join(root, "artifacts");
  if (fsImpl.existsSync(legacyDir)) {
    let n = 0;
    const walk = (d) => { for (const e of fsImpl.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(pathImpl.join(d, e.name)); else n++;
    } };
    walk(legacyDir);
    out.legacy = { present: true, files: n, decision: "未删除，等用户明确确认" };
    out.caveats.push(`旧 ${legacyDir} 仍在，含 ${n} 个文件；此前只读核对全部有 SHA256 一致副本，未删除。`);
  } else out.legacy = { present: false, files: 0 };

  /* 登记表 rel 形状 */
  const govDir = pathImpl.join(root, "governance");
  if (fsImpl.existsSync(govDir)) {
    let oldRel = 0, newRel = 0, lines = 0;
    for (const day of fsImpl.readdirSync(govDir, { withFileTypes: true })) {
      if (!day.isDirectory()) continue;
      for (const f of fsImpl.readdirSync(pathImpl.join(govDir, day.name))) {
        if (!f.endsWith(".jsonl")) continue;
        for (const line of fsImpl.readFileSync(pathImpl.join(govDir, day.name, f), "utf8").split(/\r?\n/)) {
          if (!line.trim()) continue;
          lines++;
          try {
            const j = JSON.parse(line);
            const rel = String(j.rel || "");
            if (/^\d{4}-\d{2}-\d{2}\/sessions\//.test(rel)) oldRel++;
            else if (/^(recordings|screenshots|vidx|exports|archive|misc)\/\d{4}-\d{2}-\d{2}\//.test(rel)) newRel++;
          } catch {}
        }
      }
    }
    out.governance = { lines, newRel, oldRel };
    ck("登记表没有残留旧形 rel", oldRel === 0, `旧形 ${oldRel} 条 / 新形 ${newRel} 条`);
  }

  out.caveats.push("本工具不重启正在运行的控制台；验证基于磁盘现状 + 生效配置 + 产物浮层纯函数。");
  out.caveats.push("面板浮层的实际渲染需在控制台窗口内目视确认，脚本只能验证其数据链路。");
  return out;
}

const r = verifyStorage({ statePath: stateFile });

/* 只有作为 CLI 直接运行时才打印报告 + 设退出码。
 * 被单测 import 时绝不能执行这段 —— 尤其不能 process.exit，否则会把 test runner 直接掐掉。 */
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    const L = [];
  L.push("# #131 存储根 / 扁平化产物浮层验证（2026-11-07）");
  L.push("");
  L.push(`- 状态文件：\`${r.statePath}\``);
  L.push(`- 生效存储根：\`${r.storageRoot}\``);
  L.push(`- 扁平产物文件数：${r.flatFiles}`);
  L.push(`- rootKey：\`${r.rootKey || "—"}\``);
  L.push("");
  L.push("| 检查 | 结果 | 说明 |");
  L.push("|---|---|---|");
  for (const c of r.checks) L.push(`| ${c.name} | ${c.ok ? "PASS" : "FAIL"} | ${c.detail.replace(/\|/g, "\\|")} |`);
  L.push("");
  L.push("## 真实样本（产物浮层解析用）");
  L.push("");
  for (const s of r.samples) L.push(`- \`${s.rel}\` (${s.bytes} bytes)`);
  L.push("");
  L.push(`## 结论：${r.ok ? "通过" : "存在失败项"}（${r.checks.filter((c) => c.ok).length}/${r.checks.length}）`);
  L.push("");
  L.push("## 边界");
  L.push("");
  for (const x of r.caveats) L.push(`- ${x}`);
  L.push("");
  console.log(L.join("\n"));
  }
  process.exit(r.ok ? 0 : 1);
}
