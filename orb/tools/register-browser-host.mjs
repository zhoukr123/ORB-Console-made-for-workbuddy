#!/usr/bin/env node
/* ORB 浏览器扩展的 Native Messaging 宿主注册工具（Windows / 仅 HKCU）
 *
 * 只写这三个键的默认值：
 *   HKCU\Software\Google\Chrome\NativeMessagingHosts\com.orb.browser
 *   HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.orb.browser
 *   HKCU\Software\Chromium\NativeMessagingHosts\com.orb.browser
 * 绝不触碰 com.workbuddy.extension、绝不写 HKLM、绝不写 ExtensionInstallForcelist 策略。
 *
 * 用法：
 *   node tools/register-browser-host.mjs --install [--node <node.exe路径>] [--extension-id <id>]
 *   node tools/register-browser-host.mjs --remove
 *   node tools/register-browser-host.mjs --status
 *   node tools/register-browser-host.mjs --dry-run          （默认，不写任何东西）
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = 'com.orb.browser';
const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(TOOLS_DIR, '..');
const EXT_DIR = join(ROOT, 'browser-extension');
const DESKTOP_DIR = join(ROOT, 'desktop');
const MANIFEST_PATH = join(EXT_DIR, 'manifest.json');
const HOST_JSON_PATH = join(DESKTOP_DIR, HOST + '.json');
const HOST_CMD_PATH = join(DESKTOP_DIR, 'orb-browser-host.cmd');

const REG_KEYS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\' + HOST,
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\' + HOST,
  'HKCU\\Software\\Chromium\\NativeMessagingHosts\\' + HOST,
];

/* ---------------- CLI ---------------- */

const argv = process.argv.slice(2);
const has = (flag) => argv.indexOf(flag) !== -1;
function option(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

const USAGE = [
  '用法: node tools/register-browser-host.mjs <动作> [选项]',
  '',
  '动作:',
  '  --install           生成宿主文件并写 HKCU 注册表（默认动作为 dry-run）',
  '  --remove            仅删除 com.orb.browser 的 3 个 HKCU 注册表键',
  '  --status            用 reg query 只读检查并打印',
  '  --dry-run           只打印将要做什么，不写任何文件/注册表（默认）',
  '',
  '选项:',
  '  --node <path>       node.exe 绝对路径（默认 process.execPath）',
  '  --electron <path>   用 ORB 自带 Electron 当 Node（打包版没有 node.exe 时用这个，',
  '                      通过 ELECTRON_RUN_AS_NODE=1 启动宿主）',
  '  --extension-id <id> manifest.key 无法计算时显式指定扩展 ID',
  '  --help              显示本帮助',
].join('\n');

if (has('--help') || has('-h')) {
  console.log(USAGE);
  process.exit(0);
}

let action = 'dry-run';
if (has('--install')) action = 'install';
else if (has('--remove')) action = 'remove';
else if (has('--status')) action = 'status';
if (has('--dry-run')) action = 'dry-run';

/* 宿主运行时有两种形态：
 *   node 模式      —— 本机装了 Node：直接 "<node.exe>" browserHost.cjs
 *   electron 模式  —— 打包版只有 ORB 控制台.exe：置 ELECTRON_RUN_AS_NODE=1 让它当 Node 跑
 * 打包版绝不能假设用户装了 Node，所以 electron 模式是发布版的正解。
 * 自动探测顺序：--node > --electron > ROOT/../.. 下的 ORB 控制台.exe > process.execPath */
const providedId = option('--extension-id');

function detectElectronExe() {
  const candidates = [
    join(ROOT, '..', '..', 'ORB 控制台.exe'),   // 打包版：resources/app/tools -> 安装根
    join(ROOT, '..', 'ORB 控制台.exe'),         // 少数布局：tools 直接在根下
    join(ROOT, 'ORB 控制台.exe'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return resolve(p);
  }
  return null;
}

let nodeExe = option('--node');
let electronExe = option('--electron');
let hostMode = 'node';
if (nodeExe) {
  hostMode = 'node';
  nodeExe = resolve(nodeExe);
} else if (electronExe) {
  hostMode = 'electron';
  electronExe = resolve(electronExe);
} else {
  const detected = detectElectronExe();
  if (detected) {
    hostMode = 'electron';
    electronExe = detected;
  } else {
    hostMode = 'node';
    nodeExe = process.execPath;
  }
}

/* ---------------- 扩展 ID：Chrome 官方算法 ----------------
 * 对 base64 解码后的 DER/SPKI 公钥做 sha256，取前 16 字节，
 * 每个字节的高/低 4bit 分别映射成 'a'..'p'。
 */
function computeExtensionId(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    throw new Error('无法读取/解析 manifest.json (' + manifestPath + '): ' + e.message);
  }
  const key = manifest && manifest.key;
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error('manifest.json 缺少 key 字段（base64 DER/SPKI 公钥）');
  }
  const compact = key.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) {
    throw new Error('manifest.key 不是合法 base64');
  }
  const der = Buffer.from(compact, 'base64');
  if (der.length === 0 || der[0] !== 0x30) {
    throw new Error('manifest.key 解码后不是 DER/SPKI 公钥（应以 0x30 SEQUENCE 开头）');
  }
  const digest = createHash('sha256').update(der).digest();
  let id = '';
  for (const b of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + ((b >> 4) & 0x0f)); // 高 4bit
    id += String.fromCharCode(97 + (b & 0x0f));        // 低 4bit
  }
  return id;
}

let extensionId;
try {
  extensionId = computeExtensionId(MANIFEST_PATH);
  console.log('[ID] 由 manifest.key 计算得到扩展 ID: ' + extensionId);
} catch (e) {
  if (!providedId) {
    console.error('[错误] ' + e.message);
    console.error('[错误] 无法计算扩展 ID，请用 --extension-id <id> 显式指定。');
    process.exit(1);
  }
  extensionId = providedId;
  console.log('[ID] manifest.key 无法使用，改用 --extension-id: ' + extensionId);
}
if (providedId && providedId !== extensionId) {
  console.log('[ID] 提示: 命令行 --extension-id (' + providedId + ') 与计算值不同，按计算值 ' + extensionId + ' 使用。');
}
if (!/^[a-p]{32}$/.test(extensionId)) {
  console.error('[错误] 扩展 ID 不合法: ' + extensionId + '（应为 32 个 a-p 字符）');
  process.exit(1);
}

/* ---------------- 将要生成的内容 ---------------- */

const hostManifest = {
  name: HOST,
  description: 'ORB Browser Bridge native messaging host (self-developed, com.orb.browser)',
  type: 'stdio',
  path: HOST_CMD_PATH, // JSON.stringify 会正确转义 Windows 反斜杠
  allowed_origins: ['chrome-extension://' + extensionId + '/'],
};
const hostJson = JSON.stringify(hostManifest, null, 2) + '\n';

/* Windows 批处理。两种模板：
 *   node     : @echo off + "<node.exe>" "%~dp0browserHost.cjs" %*
 *   electron : set ELECTRON_RUN_AS_NODE=1 + "<ORB 控制台.exe>" "%~dp0browserHost.cjs" %*
 * 中文 exe 名在非 936 代码页的 cmd 里会被解释错，所以路径含非 ASCII 字符时不写死名字，
 * 改用通配符按顺序取第一个 *.exe（Electron 打包产物的根目录只有主 exe）。
 */
let cmdContent;
if (hostMode === 'node') {
  cmdContent = '@echo off\r\n"' + nodeExe + '" "%~dp0browserHost.cjs" %*\r\n';
} else {
  const hasNonAscii = /[^\x00-\x7F]/.test(electronExe);
  const lines = ['@echo off', 'setlocal'];
  if (hasNonAscii) {
    // 纯 ASCII 的批处理：不出现任何中文，避免代码页问题。
    lines.push(
      'set "ELECTRON_RUN_AS_NODE=1"',
      'set "ORB_EXE="',
      'for %%F in ("%~dp0..\\..\\..\\*.exe") do if not defined ORB_EXE set "ORB_EXE=%%~fF"',
      'for %%F in ("%~dp0..\\..\\*.exe") do if not defined ORB_EXE set "ORB_EXE=%%~fF"',
      'if not defined ORB_EXE exit /b 1',
      '"%ORB_EXE%" "%~dp0browserHost.cjs" %*'
    );
  } else {
    lines.push(
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"' + electronExe + '" "%~dp0browserHost.cjs" %*'
    );
  }
  cmdContent = lines.join('\r\n') + '\r\n';
}

console.log('');
console.log('ORB Browser Bridge — Native Messaging 宿主注册');
console.log('宿主名        : ' + HOST);
console.log('扩展 ID       : ' + extensionId);
console.log('项目根        : ' + ROOT);
console.log('manifest.json : ' + MANIFEST_PATH);
console.log('node.exe      : ' + nodeExe);
console.log('宿主清单      : ' + HOST_JSON_PATH);
console.log('宿主启动器    : ' + HOST_CMD_PATH);
console.log('宿主运行时    : ' + (hostMode === 'node'
  ? 'node 模式 — ' + nodeExe
  : 'electron 模式（ELECTRON_RUN_AS_NODE）— ' + electronExe));
if (hostMode === 'node' && !existsSync(nodeExe)) {
  console.log('[警告] node.exe 不存在: ' + nodeExe + ' —— 宿主将无法启动，请用 --node 指定或改用 --electron');
}
if (hostMode === 'electron' && !existsSync(electronExe)) {
  console.log('[警告] Electron 可执行文件不存在: ' + electronExe + ' —— 宿主将无法启动');
}
console.log('目标注册表键（仅 HKCU）:');
for (const k of REG_KEYS) console.log('  ' + k);
console.log('约束: 不触碰 com.workbuddy.extension / 不写 HKLM / 不写 ExtensionInstallForcelist');
console.log('');

/* ---------------- 子进程：一律 spawnSync，失败明确报错且非 0 ---------------- */

function runReg(args, label, tolerateMissing) {
  const r = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true, shell: false });
  if (r.error) {
    console.error('[错误] ' + label + ' 无法启动 reg.exe: ' + r.error.message);
    process.exit(1);
  }
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status !== 0) {
    if (tolerateMissing) return null; // 键不存在属于正常情况（--status / 幂等 --remove）
    console.error('[错误] ' + label + ' 失败 (exit ' + r.status + '): ' + out);
    process.exit(1);
  }
  return out;
}

function printRegAddPlan() {
  for (const key of REG_KEYS) {
    console.log('  reg add ' + key + ' /ve /d "' + HOST_JSON_PATH + '" /f');
  }
}

function printRegDeletePlan() {
  for (const key of REG_KEYS) {
    console.log('  reg delete ' + key + ' /f');
  }
}

/* ---------------- 动作 ---------------- */

if (action === 'status') {
  for (const key of REG_KEYS) {
    const out = runReg(['query', key, '/ve'], 'reg query ' + key, true);
    if (out === null) console.log('[状态] 未注册: ' + key);
    else console.log('[状态] 已注册: ' + key + '\n' + out.split('\n').map((l) => '        ' + l).join('\n'));
  }
  process.exit(0);
}

if (action === 'dry-run') {
  console.log('=== DRY RUN：不写任何文件、不写任何注册表键 ===');
  console.log('[计划] 写入文件（完整路径）: ' + HOST_JSON_PATH);
  console.log('  内容:');
  console.log(hostJson.split('\n').map((l) => '  ' + l).join('\n'));
  console.log('[计划] 写入文件（完整路径）: ' + HOST_CMD_PATH);
  console.log('  内容:');
  console.log('  ' + cmdContent.replace(/\r?\n/g, '\n  ').trimEnd());
  console.log('[计划] 若执行 --install，将运行:');
  printRegAddPlan();
  console.log('[计划] 若执行 --remove，将运行:');
  printRegDeletePlan();
  console.log('[DRY RUN] 结束，未写盘。');
  process.exit(0);
}

if (action === 'install') {
  // 文件写入前打印完整路径。
  console.log('[文件] 准备写入: ' + HOST_JSON_PATH);
  console.log('[文件] 准备写入: ' + HOST_CMD_PATH);
  if (!existsSync(DESKTOP_DIR)) mkdirSync(DESKTOP_DIR, { recursive: true });
  writeFileSync(HOST_JSON_PATH, hostJson, 'utf8');
  console.log('[写入] 完成: ' + HOST_JSON_PATH + ' (' + Buffer.byteLength(hostJson, 'utf8') + ' bytes)');
  writeFileSync(HOST_CMD_PATH, cmdContent, 'utf8');
  console.log('[写入] 完成: ' + HOST_CMD_PATH + ' (' + Buffer.byteLength(cmdContent, 'utf8') + ' bytes)');
  for (const key of REG_KEYS) {
    console.log('[注册表] reg add ' + key + ' /ve /d "' + HOST_JSON_PATH + '" /f');
    const out = runReg(['add', key, '/ve', '/d', HOST_JSON_PATH, '/f'], 'reg add ' + key);
    console.log('[写入] ' + key + ' -> ' + (out || '(默认)'));
  }
  console.log('[完成] 安装完成，请重启浏览器使注册表生效。');
  process.exit(0);
}

if (action === 'remove') {
  for (const key of REG_KEYS) {
    console.log('[注册表] reg delete ' + key + ' /f');
    const out = runReg(['delete', key, '/f'], 'reg delete ' + key, true);
    if (out === null) console.log('[跳过] 键不存在或删除失败（可能本就未注册）: ' + key);
    else console.log('[删除] ' + key + ': ' + out);
  }
  console.log('[完成] 仅移除了 com.orb.browser 的 HKCU 键；生成的文件保留在 ' + DESKTOP_DIR + '。');
  process.exit(0);
}

console.error('[错误] 未知动作。\n' + USAGE);
process.exit(1);
