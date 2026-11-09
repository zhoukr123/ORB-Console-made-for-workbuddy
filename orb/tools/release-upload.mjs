/* v1.5.0 Release 资产重传工具（2026-11-09 固化）。
 *
 * 用法：
 *   node tools/release-upload.mjs --dry                 # 只看计划，不写
 *   node tools/release-upload.mjs                      # 自动取 dist 里最新构建戳
 *   node tools/release-upload.mjs --stamp=202611091452 # 指定构建戳
 *   node tools/release-upload.mjs --cleanup            # 只清旧资产（幂等）
 *
 * 设计要点（都是拿事故换的）：
 *   · 凭证从 Git Credential Manager 取，只在内存里用，不落盘、不进 argv、不回显；
 *     token 经 curl 的 --config - 从 stdin 传入。
 *   · 必须走 curl：本机有 HTTPS_PROXY，Node 原生 https 不走代理，
 *     大 POST 会被中间设备 RST / 返回 HTML 400。
 *   · 顺序：先传完新资产并逐项确认 state=uploaded，才删旧资产（实时列表，不用启动快照），
 *     Release 全程不出现无包可下的空窗。
 *   · 删旧只认已知命名模式且不含当前 stamp，不误删用户手动挂的其它资产。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIST = path.join(ROOT, "dist");
const OWNER = "zhoukr123";
const REPO = "ORB-Console-made-for-workbuddy";
const VERSION = "1.5.0";
let RELEASE_ID = 438418638;

const argv = process.argv.slice(2);
const argOf = (k) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : null;
};
const DRY = argv.includes("--dry");
const CLEANUP = argv.includes("--cleanup");
const HELP = argv.includes("--help");
if (argOf("release-id")) RELEASE_ID = Number(argOf("release-id"));

if (HELP) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\s*/, ""));
  process.exit(0);
}

function findStamp() {
  const given = argOf("stamp");
  if (given) return given;
  const names = fs.readdirSync(DIST)
    .map((n) => /^ORB控制台-1\.5\.0-(\d{12})-便携版\.exe$/.exec(n))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
  if (!names.length) throw new Error("dist 下找不到 1.5.0 便携版构建，或请用 --stamp= 指定");
  return names[names.length - 1];
}

const STAMP = findStamp();
const PREFIX = `ORB-Console-${VERSION}-${STAMP}`;
const FILES = [
  { local: `ORB控制台-${VERSION}-${STAMP}-便携版.exe`, remote: `${PREFIX}-portable.exe` },
  { local: `ORB控制台-${VERSION}-${STAMP}.zip`, remote: `${PREFIX}.zip` },
  { local: `ORB控制台-${VERSION}-${STAMP}.install-manifest.json`, remote: `${PREFIX}.install-manifest.json` },
];

/* 注意命名里 dash / dot 是混用的：
   · -portable.exe 用连字符，.zip / .install-manifest.json 用点。
   2026-11-09 两次踩同一个坑（正则只写 `-` 导致旧 zip / manifest 漏删），
   这里用 [-.] 字符类覆盖两种，并用 --selftest 锁住。 */
const STALE_PATTERNS = [
  /^ORB-Console-1\.5\.0-portable\.exe$/,
  /^ORB-Console-1\.5\.0\.zip$/,
  /^ORB-Console-1\.5\.0-\d{12}[-.](?:portable\.exe|zip|install-manifest\.json)$/,
];
const isStale = (name) => !name.includes(STAMP) && STALE_PATTERNS.some((re) => re.test(name));

if (argv.includes("--selftest")) {
  const cases = [
    ["ORB-Console-1.5.0-202611090632-portable.exe", true],
    ["ORB-Console-1.5.0-202611090632.zip", true],
    ["ORB-Console-1.5.0-202611090632.install-manifest.json", true],
    ["ORB-Console-1.5.0-portable.exe", true],
    ["ORB-Console-1.5.0.zip", true],
    ["ORB-Console-1.5.0-202611091454-portable.exe", false],
    ["ORB-Console-1.5.0-202611091454.zip", false],
    ["ORB-Console-1.5.0-202611091454.install-manifest.json", false],
    ["README.md", false],
    ["ORB-Console-1.4.9.zip", false],
  ];
  for (const [n, want] of cases) {
    const got = isStale(n);
    if (got !== want) throw new Error(`selftest fail: ${n} got=${got} want=${want}`);
  }
  console.log(`SELFTEST_OK ${cases.length} 项`);
  process.exit(0);
}

function token() {
  const out = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    timeout: 25000,
  });
  const m = /^password=(.*)$/m.exec(out);
  if (!m || !m[1]) throw new Error("credential helper 未返回 password");
  return m[1].trim();
}

function headers(tok, extra = {}) {
  return {
    Authorization: `Bearer ${tok}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "orb-release-upload",
    ...extra,
  };
}

function request(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("api request timeout")));
    req.end();
  });
}

async function api(tok, method, p) {
  const r = await request({ hostname: "api.github.com", path: p, method, headers: headers(tok) });
  if (r.status >= 400) throw new Error(`${method} ${p} -> ${r.status} ${r.text.slice(0, 300)}`);
  return r;
}

const releasePath = () => `/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}`;
const relAssets = (tok) => api(tok, "GET", releasePath()).then((r) => r.json);

async function upload(tok, f) {
  const full = path.join(DIST, f.local);
  const outFile = path.join(process.env.TEMP || ".", `orb-upload-${process.pid}.out`);
  const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(f.remote)}`;
  const cfg = [
    `header = "Authorization: Bearer ${tok}"`,
    `header = "Accept: application/vnd.github+json"`,
    `header = "Content-Type: application/octet-stream"`,
    `header = "Expect:"`,
    `user-agent = "orb-release-upload"`,
    `url = "${url}"`,
  ].join("\n") + "\n";
  const args = [
    "-sS", "-X", "POST", "--config", "-",
    "--data-binary", `@${full}`,
    "--output", outFile, "--write-out", "%{http_code}", "--max-time", "900",
  ];
  const r = await new Promise((resolve, reject) => {
    const child = spawn("curl", args, { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, status: Number(out.trim()), err }));
    child.stdin.end(cfg);
  });
  const body = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
  try { fs.unlinkSync(outFile); } catch {}
  const safeErr = String(r.err || "").split(tok).join("[redacted]");
  if (r.code !== 0 || r.status !== 201) {
    throw new Error(`UPLOAD ${f.remote} -> curl_exit=${r.code} http=${r.status}\n`
      + `  stderr=${safeErr.slice(0, 300)}\n  body=${body.slice(0, 800)}`);
  }
  let json = null;
  try { json = JSON.parse(body); } catch {}
  return json || { name: f.remote, state: "uploaded" };
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const tok = token();
const me = await api(tok, "GET", "/user");
console.log(`AUTH_OK user=${me.json.login} scopes=${me.headers["x-oauth-scopes"] || "(none)"}`);
const rel = await relAssets(tok);
console.log(`RELEASE tag=${rel.tag_name} id=${rel.id} stamp=${STAMP}`);
console.log("CURRENT_ASSETS:");
for (const a of rel.assets || []) console.log(`  ${a.name} | ${(a.size / 1048576).toFixed(1)}MB | ${a.state}`);

if (!CLEANUP) {
  console.log("LOCAL_FILES:");
  for (const f of FILES) {
    const full = path.join(DIST, f.local);
    if (!fs.existsSync(full)) throw new Error("缺少本地文件: " + full);
    console.log(`  ${f.remote} | ${(fs.statSync(full).size / 1048576).toFixed(1)}MB | sha256=${sha256(full)}`);
  }
}

if (DRY) {
  const stale = (rel.assets || []).filter((a) => isStale(a.name));
  console.log(`DRY_RUN: 未写。将上传 ${FILES.length} 个新资产，成功后删除 ${stale.length} 个旧资产：`);
  for (const a of stale) console.log(`  STALE ${a.name} id=${a.id}`);
  process.exit(0);
}

if (!CLEANUP) {
  for (const f of FILES) {
    const cur = await relAssets(tok);
    const existing = (cur.assets || []).find((a) => a.name === f.remote && a.state === "uploaded");
    if (existing) {
      console.log(`SKIP_EXISTS ${f.remote} id=${existing.id}`);
      continue;
    }
    const dup = (cur.assets || []).find((a) => a.name === f.remote);
    if (dup) {
      console.log(`DELETE_DUP ${dup.name} id=${dup.id}`);
      await api(tok, "DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${dup.id}`);
    }
    console.log(`UPLOAD_START ${f.remote}`);
    const a = await upload(tok, f);
    console.log(`UPLOAD_OK ${a.name} id=${a.id} state=${a.state} size=${a.size}`);
  }

  const fresh = await relAssets(tok);
  if (!FILES.every((f) => (fresh.assets || []).some((a) => a.name === f.remote && a.state === "uploaded"))) {
    throw new Error("新资产未全部就绪，保留旧资产不动，终止删除");
  }
}

/* 删旧一律基于实时列表，不用启动快照 —— 上一轮就是快照 + 正则笔误漏了 zip。 */
const now = await relAssets(tok);
const stale = (now.assets || []).filter((a) => isStale(a.name));
for (const a of stale) {
  console.log(`DELETE_STALE ${a.name} id=${a.id}`);
  await api(tok, "DELETE", `/repos/${OWNER}/${REPO}/releases/assets/${a.id}`);
}

const fin = await relAssets(tok);
console.log("FINAL_ASSETS:");
for (const a of fin.assets || []) {
  console.log(`  ${a.name} | ${(a.size / 1048576).toFixed(1)}MB | ${a.state}`);
}
if (!CLEANUP) {
  console.log("SHA256_OF_UPLOADED:");
  for (const f of FILES) console.log(`  ${f.remote} ${sha256(path.join(DIST, f.local))}`);
}
console.log("RELEASE_UPLOAD_DONE");
