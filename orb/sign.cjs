#!/usr/bin/env node
/*
 * orb/sign.cjs —— ORB 控制台的 Authenticode 签名 / 校验入口
 *
 * 为什么需要这个脚本，而不是直接敲 signtool：
 *   1. signtool 不在 PATH 里，得自己去 Windows Kits 里按版本号挑最新的那一个。
 *   2. 本项目的便携版是 [桩][payload zip][32B trailer] 三段式，签名会追加在
 *      文件末尾。桩如果按「文件总长度 - 32」读 trailer，签名一加就再也读不到
 *      —— 产出的 exe 双击直接报「尾部签名不匹配」。这个脚本在签名后立刻
 *      回读末尾字节做回归检查，读不到 trailer 就自动还原文件并报错退出，
 *      绝不让一个打不开的 208MB 包流到发布目录。
 *   3. 时间戳是硬要求（证书 460 天就到期，没时间戳旧版本会变成「未签名」），
 *      统一在这里带 RFC 3161，避免手敲漏掉。
 *
 * 用法：
 *   node orb/sign.cjs --thumbprint <证书指纹> --file dist\xxx.exe
 *   node orb/sign.cjs --pfx cert.pfx --pw <密码> --file dist\xxx.exe
 *   node orb/sign.cjs --subject "Open Source Developer" --file a.exe --file b.exe
 *   node orb/sign.cjs --verify-only --file dist\xxx.exe
 *
 * 常用可选参数：
 *   --timestamp <url>   默认 http://timestamp.digicert.com
 *   --desc <文本>       文件描述，默认「ORB 控制台」
 *   --url <链接>        /du 用的项目地址
 *   --no-timestamp      仅供内网/离线测试，正式发布禁止使用
 *   --skip-verify       跳过 signtool verify（不推荐）
 *
 * 退出码：0 全部成功；1 参数/环境错误；2 签名失败；3 签完校验失败；
 *         4 便携包 trailer 被签名挤走（已自动还原）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MAGIC = 'ORBSFX1';        // 与 orb/native/src/orb-sfx.c 的 SFX_MAGIC 一致
const STUB_MARK = 'ORBSFXSIGN1'; // 桩里出现这串 = 该桩能从尾部倒扫找回 trailer
const TRAILER = 32;
const SCAN_WINDOW = 64 * 1024;  // 签名块通常 1.5–4KB，扫 64KB 足够宽松

// ---------------------------------------------------------------- 参数解析
function parseArgs(argv) {
  const o = {
    files: [],
    pfx: null, pw: null, thumbprint: null, subject: null,
    timestamp: 'http://timestamp.digicert.com',
    desc: 'ORB 控制台',
    url: 'https://github.com/zhoukr123/ORB-Console-made-for-workbuddy',
    verifyOnly: false, skipVerify: false, noTimestamp: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(`参数 ${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--file': case '-f': o.files.push(next()); break;
      case '--pfx': o.pfx = next(); break;
      case '--pw': case '--password': o.pw = next(); break;
      case '--thumbprint': case '--sha1': o.thumbprint = next(); break;
      case '--subject': case '-n': o.subject = next(); break;
      case '--timestamp': case '-t': o.timestamp = next(); break;
      case '--desc': case '-d': o.desc = next(); break;
      case '--url': case '-u': o.url = next(); break;
      case '--verify-only': o.verifyOnly = true; break;
      case '--skip-verify': o.skipVerify = true; break;
      case '--no-timestamp': o.noTimestamp = true; break;
      case '--help': case '-h': usage(); process.exit(0); break;
      default: die(`不认识的参数：${a}`);
    }
  }
  return o;
}

function usage() {
  console.log(`
ORB 签名工具

  node orb/sign.cjs --thumbprint <指纹> --file <文件> [--file <文件>...]
  node orb/sign.cjs --pfx <证书.pfx> --pw <密码> --file <文件>
  node orb/sign.cjs --subject "<证书 CN>" --file <文件>
  node orb/sign.cjs --verify-only --file <文件>

证书来源三选一：--pfx / --thumbprint / --subject
时间戳默认 http://timestamp.digicert.com（RFC 3161 + SHA256）
`);
}

function die(msg, code = 1) {
  console.error(`\x1b[31m[ERR]\x1b[0m ${msg}`);
  process.exit(code);
}

// ---------------------------------------------------------------- 找 signtool
function findSigntool() {
  const roots = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
    'D:\\Windows Kits\\10\\bin',
    'C:\\Program Files (x86)\\Windows Kits\\8.1\\bin',
  ];
  const hits = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const ver of fs.readdirSync(root)) {
      const p = path.join(root, ver, 'x64', 'signtool.exe');
      if (fs.existsSync(p)) hits.push({ ver, p });
    }
  }
  if (!hits.length) {
    die('没找到 signtool.exe。需要装 Windows SDK（含 Signing Tools）。\n' +
        '  已试：' + roots.join(' / '));
  }
  // 版本号按数字段比较，别用字符串排序（10.0.9999 vs 10.0.26100）
  hits.sort((a, b) => {
    const pa = a.ver.split('.').map(Number);
    const pb = b.ver.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  return hits[hits.length - 1];
}

// ---------------------------------------------------------------- trailer 探测
function readTail(file, n) {
  const st = fs.statSync(file);
  if (st.size < n) return Buffer.alloc(0);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, st.size - n);
  fs.closeSync(fd);
  return buf;
}

/** 从文件尾部往前找魔数，返回绝对偏移；找不到返回 -1 */
function findTrailerOffset(file) {
  const st = fs.statSync(file);
  const win = Math.min(st.size, SCAN_WINDOW);
  if (win < TRAILER) return -1;
  const tail = readTail(file, win);
  const base = st.size - win;
  for (let i = tail.length - TRAILER; i >= 0; i--) {
    if (tail[i] !== 0x4f) continue;
    if (tail.toString('latin1', i, i + MAGIC.length) === MAGIC) return base + i;
  }
  return -1;
}

/**
 * 判断包里的桩是否「签名感知」。
 * 桩本体 = 文件开头 payload_off 个字节（payload_off = trailer_off - payload_len）。
 * 旧桩按「文件总长度 - 32」读 trailer，签名一追加就瞎；新桩会从尾部倒扫。
 * 用桩内是否含 STUB_MARK 来区分，避免靠猜测。
 */
function stubSupportsSignature(file, trailerOff) {
  if (trailerOff < 0) return { known: false, ok: false };
  const t = readTail(file, TRAILER);
  if (t.toString('latin1', 0, MAGIC.length) !== MAGIC) return { known: false, ok: false };
  const payloadLen = Number(t.readBigUInt64LE(8));
  const stubLen = trailerOff - payloadLen;
  if (stubLen <= 0 || stubLen > 8 * 1024 * 1024) return { known: false, ok: false };
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(stubLen);
  fs.readSync(fd, buf, 0, stubLen, 0);
  fs.closeSync(fd);
  return { known: true, ok: buf.includes(Buffer.from(STUB_MARK, 'latin1')) };
}

// ---------------------------------------------------------------- 主流程
function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.files.length) { usage(); die('至少要给一个 --file'); }

  for (const f of o.files) {
    if (!fs.existsSync(f)) die(`文件不存在：${f}`);
  }

  const tool = findSigntool();
  console.log(`signtool : ${tool.p}  (SDK ${tool.ver})`);

  if (!o.verifyOnly) {
    const hasPfx = !!(o.pfx && o.pw);
    const hasTp = !!o.thumbprint;
    const hasSub = !!o.subject;
    const n = [hasPfx, hasTp, hasSub].filter(Boolean).length;
    if (n === 0) die('必须指定证书：--pfx+--pw / --thumbprint / --subject 三选一');
    if (n > 1) die('证书参数只能给一组，别混用');
    if (hasPfx && !fs.existsSync(o.pfx)) die(`pfx 不存在：${o.pfx}`);
  }

  let failed = 0;

  for (const file of o.files) {
    console.log(`\n=== ${file} ===`);
    const st = fs.statSync(file);
    console.log(`  大小 ${st.size.toLocaleString()} 字节`);

    const offBefore = findTrailerOffset(file);
    const hasTrailer = offBefore >= 0;
    const atEof = hasTrailer && offBefore === st.size - TRAILER;
    let stubAttrs = { known: false, ok: false };

    if (!hasTrailer) {
      console.log('  类型：普通 PE（末尾无 ORBSFX1 trailer）');
    } else {
      stubAttrs = stubSupportsSignature(file, offBefore);
      console.log(`  类型：ORB 便携单文件（payload ${readPayloadLen(file)} 字节，` +
                  `trailer 距末尾 ${st.size - TRAILER - offBefore} 字节）`);
      console.log(`  桩：${stubAttrs.known
        ? (stubAttrs.ok ? '签名感知（能从尾部倒扫找回 trailer）' : '旧版（只认文件最末 32 字节）')
        : '无法判定（桩里没找到标记）'}`);
    }

    if (o.verifyOnly) {
      const ok = verify(tool, file);
      if (!ok) failed++;
      continue;
    }

    // —— 硬拦截：旧桩 + 签名追加到末尾 = 产出必然打不开
    if (hasTrailer && atEof && !(stubAttrs.known && stubAttrs.ok)) {
      console.error('\n\x1b[31m[FATAL]\x1b[0m 拒绝对这个便携包签名：签出来的 exe 一定打不开。');
      console.error('        桩现在按「文件总长度 - 32」读 trailer；signtool 会把签名追加到');
      console.error('        文件末尾，trailer 不再位于最末 32 字节 → 桩报「尾部签名不匹配」。');
      console.error('        先做这两件事（顺序不能反）：');
      console.error('          1) 改 orb/native/src/orb-sfx.c：trailer 定位改成从尾部倒扫魔数，');
      console.error(`             并在源码里留一个 "${STUB_MARK}" 字面量当标记；`);
      console.error('          2) 重新 node orb/pack.cjs 出包，再做签名。');
      console.error('        细节见 docs/代码签名获取方案调研.md §8。');
      process.exit(4);
    }

    // 便携单文件：先留底，签坏了要能还原
    const bak = file + '.presign';
    if (hasTrailer) fs.copyFileSync(file, bak);

    const ok = sign(tool, o, file);
    if (!ok) {
      if (hasTrailer && fs.existsSync(bak)) { fs.copyFileSync(bak, file); fs.unlinkSync(bak); }
      failed++;
      continue;
    }

    // —— 回归检查 1：便携包的 trailer 还找得到吗、位置有没有被挪动
    if (hasTrailer) {
      const offAfter = findTrailerOffset(file);
      const sizeAfter = fs.statSync(file).size;
      if (offAfter !== offBefore) {
        console.error('\x1b[31m[FATAL]\x1b[0m 签名后 trailer 位置变了或找不到了 —— 这个包不能发布。');
        console.error(`        签名前 trailer 在 ${offBefore}，签名后 ${offAfter < 0 ? '找不到' : offAfter}`);
        if (fs.existsSync(bak)) {
          fs.copyFileSync(bak, file);
          fs.unlinkSync(bak);
          console.error('        已自动还原原文件。');
        }
        process.exit(4);
      }
      console.log(`  回归：trailer 仍在原位（原偏移 ${offBefore}），追加签名块 ${sizeAfter - st.size} 字节`);
      fs.unlinkSync(bak);
    }

    // —— 回归检查 2：签名本身有效吗
    if (!o.skipVerify) {
      if (!verify(tool, file)) failed++;
    }
  }

  console.log('');
  if (failed) die(`${failed} 个文件未通过`, 3);
  console.log('\x1b[32m[OK]\x1b[0m 全部完成');
}

function readPayloadLen(file) {
  const t = readTail(file, TRAILER);
  if (t.toString('latin1', 0, MAGIC.length) !== MAGIC) return '?';
  return t.readBigUInt64LE(8).toString();
}

function sign(tool, o, file) {
  const args = ['sign', '/fd', 'sha256', '/d', o.desc];
  if (o.url) args.push('/du', o.url);
  if (o.pfx) args.push('/f', o.pfx, '/p', o.pw);
  else if (o.thumbprint) args.push('/sha1', o.thumbprint);
  else if (o.subject) args.push('/n', o.subject);
  if (o.noTimestamp) {
    console.warn('  \x1b[33m[WARN]\x1b[0m 未加时间戳：证书一到期，这个签名就失效');
  } else {
    args.push('/tr', o.timestamp, '/td', 'sha256');
  }
  args.push(file);

  const r = spawnSync(tool.p, args, { encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) console.log(out.split('\n').map(l => '  ' + l).join('\n'));
  if (r.status !== 0) {
    console.error(`\x1b[31m[FAIL]\x1b[0m signtool 退出码 ${r.status}`);
    return false;
  }
  return true;
}

function verify(tool, file) {
  const r = spawnSync(tool.p, ['verify', '/pa', '/v', file], { encoding: 'utf8' });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status === 0) {
    console.log('  \x1b[32m[VERIFY OK]\x1b[0m 签名链受信任');
    const m = out.match(/Issued to: (.+)/);
    if (m) console.log(`  发布者：${m[1].trim()}`);
    if (!/timestamp/i.test(out) || /not timestamped/i.test(out)) {
      console.warn('  \x1b[33m[WARN]\x1b[0m 未发现时间戳');
    }
    return true;
  }
  console.error('  \x1b[31m[VERIFY FAIL]\x1b[0m signtool verify /pa 不通过');
  const untrusted = /not trusted by the trust provider|不受信任/.test(out);
  for (const line of out.split('\n')) {
    if (/Error|错误|Issued to|Issued by/.test(line)) console.error('    ' + line.trim());
  }
  if (untrusted) {
    console.error('    推断：证书链的根不在受信任根存储里。自签名证书必然如此 ——');
    console.error('    本机自用需把根证书导入「受信任的根证书颁发机构」与「受信任的发布者」；');
    console.error('    对外分发只能换 CA 签发的证书，自签名在别人机器上等于「签名无效」。');
  }
  return false;
}

main();
