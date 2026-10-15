/* orb-sfx 端到端联调：桩 + zip + trailer -> 运行 -> 解压 -> 找启动器 -> 拉起
 *
 * 用合成小包验证，不依赖真实 386MB 构建产物。
 * 跑法：node native/test-sfx.cjs
 */
"use strict";

const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const STUB = path.join(ROOT, "native", "dist", "orb-sfx.exe");

/* ---- 与 pack.cjs 共用的 trailer 拼装（先在这里验证，再进 pack.cjs） ---- */
const SFX_MAGIC = Buffer.from("ORBSFX1", "ascii");
const SFX_TRAILER = 32;

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeTrailer(payloadLen, payloadCrc) {
  const t = Buffer.alloc(SFX_TRAILER, 0);
  SFX_MAGIC.copy(t, 0);
  t.writeBigUInt64LE(BigInt(payloadLen), 8);
  t.writeUInt32LE(payloadCrc, 16);
  return t;
}

function buildSfx(stub, zip, out) {
  const s = fs.readFileSync(stub);
  const z = fs.readFileSync(zip);
  const tr = makeTrailer(z.length, crc32(z));
  fs.writeFileSync(out, Buffer.concat([s, z, tr]));
  return s.length + z.length + tr.length;
}

/* ---- 造合成包 ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orb-sfx-test-"));
const stage = path.join(tmp, "stage");
const payloadDir = path.join(stage, "ORB控制台-测试");
fs.mkdirSync(path.join(payloadDir, "resources", "app"), { recursive: true });
fs.writeFileSync(path.join(payloadDir, "resources", "app", "main.js"), "// stub main.js\n", "utf8");
// 启动器：写一个标记文件，用来证明「桩真的把它拉起来了」
fs.writeFileSync(
  path.join(payloadDir, "启动测试.cmd"),
  "@echo off\r\n@echo ok > \"%~dp0_LAUNCHED.txt\"\r\n",
  "utf8"
);

const zipPath = path.join(tmp, "payload.zip");
// tar.exe 做压缩（与 pack.cjs 里对 386MB 大包走的是同一条路，行为一致）
execFileSync("tar.exe", ["-a", "-c", "-f", zipPath, "-C", stage, "ORB控制台-测试"], {
  stdio: "ignore",
});
const zipSize = fs.statSync(zipPath).size;

const sfxPath = path.join(tmp, "ORB控制台-便携版.exe");
const total = buildSfx(STUB, zipPath, sfxPath);
console.log(`stub      : ${fs.statSync(STUB).size} B`);
console.log(`payload   : ${zipSize} B`);
console.log(`packaged  : ${total} B  -> ${sfxPath}`);

/* ---- 跑 ---- */
const target = path.join(tmp, "out");
console.log(`\nrunning sfx -> ${target}`);
const r = spawnSync(sfxPath, [target], { encoding: "utf8", timeout: 120000 });
console.log(`exit code : ${r.status}`);
if (r.error) console.log(`error     : ${r.error.message}`);

/* ---- 校验 ---- */
const checks = [];
const mark = path.join(target, "_raw", "ORB控制台-测试", "_LAUNCHED.txt");
const mainjs = path.join(target, "_raw", "ORB控制台-测试", "resources", "app", "main.js");
checks.push(["退出码 0", r.status === 0]);
checks.push(["启动器被拉起（_LAUNCHED.txt）", fs.existsSync(mark)]);
checks.push(["main.js 解出来了", fs.existsSync(mainjs)]);
checks.push(["临时 zip 已清理", !fs.readdirSync(os.tmpdir()).some((f) => f.startsWith("orb-sfx-") && f.endsWith(".zip"))]);

// 二次运行应跳过解压、直接启动（have==2 分支）
const before = fs.statSync(mainjs).mtimeMs;
const r2 = spawnSync(sfxPath, [target], { encoding: "utf8", timeout: 120000 });
checks.push(["二次运行退出码 0（跳过重复解压）", r2.status === 0]);
checks.push(["二次运行没有重新解压", fs.statSync(mainjs).mtimeMs === before]);

console.log("");
let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) fail++;
}
console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
process.exit(fail === 0 ? 0 : 1);
