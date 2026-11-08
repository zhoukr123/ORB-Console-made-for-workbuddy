/* ORB 浏览器扩展的 Chrome Native Messaging 原生宿主（com.orb.browser）。
 *
 * 由 tools/register-browser-host.mjs 生成的 orb-browser-host.cmd 启动：
 *   "<node.exe>" "%~dp0browserHost.cjs" %*
 *
 * 职责（刻意保持极薄，消息的业务授权全部在 HTTP 桥侧）：
 *   - 把 stdin 上的 Native Messaging 帧（4 字节小端 uint32 长度 + UTF-8 JSON）
 *     解码后 POST 到 http://127.0.0.1:<port>/api/browser/relay；
 *   - 把桥返回的 reply 编码成帧写回 stdout；
 *   - 每 1000ms 轮询 /api/browser/pending，把需要主动推给扩展的消息写回 stdout
 *     （急停时用于推送 channel_close）。
 *
 * 安全约束：不把网页内容 / Cookie / token 写日志；不执行子进程；不监听端口；
 * 不读写注册表；不对消息内容做任何业务判断。stdout 只走协议帧，日志一律走 stderr。
 *
 * 本文件既是可执行宿主，也导出纯函数供单测使用。只有 require.main === module
 * （直接 node 运行）时才启动宿主循环；被 require 时零副作用。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/* 单帧长度上限 1MB（Chrome Native Messaging 单条消息限制）。 */
const MAX_FRAME = 1024 * 1024;
/* 单次 HTTP 请求超时：避免桥未启动时轮询/转发被长时间挂住。 */
const REQ_TIMEOUT_MS = 3000;
/* 配置未就绪时最多暂存的帧数，防止无界增长。 */
const MAX_EARLY_FRAMES = 256;

/* ------------------------------------------------------------------ *
 * 纯函数：帧编解码
 * ------------------------------------------------------------------ */

/**
 * 把任意可 JSON 序列化的值编码为一条 Native Messaging 帧，返回 Buffer。
 * 对不可序列化（循环引用 / BigInt / toJSON 抛错 / undefined / 函数 / Symbol）
 * 的输入返回空 Buffer 作为安全 no-op——向 stdout 写 0 字节不会破坏帧流，
 * 且本函数绝不抛异常。
 */
function encodeFrame(obj) {
  let json;
  try {
    json = JSON.stringify(obj);
  } catch {
    return Buffer.alloc(0);
  }
  if (typeof json !== 'string') return Buffer.alloc(0);
  const payload = Buffer.from(json, 'utf8');
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0); // 4 字节小端长度前缀
  payload.copy(frame, 4);
  return frame;
}

/**
 * 从字节流缓冲区切分出 Native Messaging 帧，绝不抛异常。
 *
 * 返回 { frames, rest, skip }：
 *   - frames: 解析出的「JSON 对象」数组（协议消息一律为对象）；
 *   - rest:   末尾尚未收齐的半包（头部 + 部分 payload），原样保留供下次拼接；
 *   - skip:   超长帧 payload 未收齐时，还需从后续 chunk 丢弃的字节数（跨 chunk 用）。
 *
 * 丢弃策略（通过可选 onDiscard(reason) 回调上报；默认静默，故本函数是纯函数）：
 *   - 长度 > MAX_FRAME        → 丢弃整帧（reason: 'oversize'）；payload 未到齐则用
 *                               skip 记录剩余待丢弃字节，宿主在后续数据里继续跳过；
 *   - 非法 JSON               → 丢弃该帧（reason: 'invalid-json'）；
 *   - 非对象 JSON（数组 / null / 数字 / 字符串 / 布尔）→ 丢弃（reason: 'non-object'）。
 *     理由：Native Messaging 帧由扩展发来且协议规定为 JSON 对象，下游 relay 也只接受
 *     { message: <对象> }，故在帧层就过滤掉非对象，避免把无意义的值转发给桥。
 *
 * 任意畸形输入（含非 Buffer）都返回安全的空结果，不抛异常。
 */
function decodeFrames(buf, onDiscard) {
  const frames = [];
  if (!Buffer.isBuffer(buf)) return { frames, rest: Buffer.alloc(0), skip: 0 };
  const warn = typeof onDiscard === 'function'
    ? (reason) => { try { onDiscard(reason); } catch { /* 回调不得破坏解码 */ } }
    : () => {};
  let offset = 0;
  try {
    for (;;) {
      if (offset + 4 > buf.length) break; // 4 字节长度头都还没收齐

      const len = buf.readUInt32LE(offset);
      if (len > MAX_FRAME) {
        warn('oversize');
        offset += 4; // 丢掉长度头
        const consume = Math.min(len, buf.length - offset); // 丢掉当前已收到的 payload
        offset += consume;
        const skip = len - consume;
        if (skip > 0) {
          // 整帧未收齐：rest 为空，剩余字节交给宿主持久化后在后续 chunk 继续丢。
          return { frames, rest: Buffer.alloc(0), skip };
        }
        continue; // 完整超长帧已整帧丢弃，继续解析后续帧
      }
      if (offset + 4 + len > buf.length) break; // payload 未收齐，整帧留在 rest

      const payload = buf.subarray(offset + 4, offset + 4 + len);
      offset += 4 + len;
      let value;
      try {
        value = JSON.parse(payload.toString('utf8'));
      } catch {
        warn('invalid-json');
        continue;
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        warn('non-object');
        continue;
      }
      frames.push(value);
    }
  } catch {
    // 兜底：任何异常输入都不允许冒泡。
    return { frames, rest: Buffer.alloc(0), skip: 0 };
  }
  return { frames, rest: buf.subarray(offset), skip: 0 };
}

/* ------------------------------------------------------------------ *
 * 配置解析（仅宿主循环使用）
 * ------------------------------------------------------------------ */

function readJsonFile(p) {
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

/* .bridge.json 候选：脚本同目录 → 上一级 → 上两级。
 * 发布版 resources/app/browserHost.cjs 与 resources/.bridge.json 命中「上一级」。 */
function bridgeCandidates() {
  const d = __dirname;
  return [
    path.join(d, '.bridge.json'),
    path.join(d, '..', '.bridge.json'),
    path.join(d, '..', '..', '.bridge.json'),
  ];
}

/* port/token 优先取环境变量 ORB_PORT / ORB_TOKEN；缺省字段回退到 ORB_TOKEN_FILE
 * 指定的文件，或按候选顺序找到的 .bridge.json。找不到有效配置返回 null。
 * 绝不把 token 返回到日志、也绝不打印它。 */
function resolveConfig() {
  let fileCfg = null;
  const tokenFile = process.env.ORB_TOKEN_FILE;
  if (tokenFile) fileCfg = readJsonFile(tokenFile);
  if (!fileCfg) {
    for (const p of bridgeCandidates()) {
      fileCfg = readJsonFile(p);
      if (fileCfg) break;
    }
  }
  const envPort = Number.parseInt(process.env.ORB_PORT, 10);
  const envToken = process.env.ORB_TOKEN;
  const port = Number.isInteger(envPort) && envPort > 0
    ? envPort
    : (fileCfg && Number(fileCfg.port) > 0 ? Number(fileCfg.port) : 0);
  const token = envToken && envToken.length
    ? envToken
    : (fileCfg && typeof fileCfg.token === 'string' ? fileCfg.token : '');
  return port > 0 && token ? { port, token } : null;
}

/* ------------------------------------------------------------------ *
 * 宿主循环（仅当本文件作为主模块直接运行时启动）
 * ------------------------------------------------------------------ */

function startHost() {
  const log = (s) => {
    try { process.stderr.write('[orb-browser-host] ' + s + '\n'); } catch { /* ignore */ }
  };
  const onDiscard = (reason) => log('丢弃帧: ' + reason);

  /* 本宿主进程的实例标识。
   *
   * 每个装了扩展的浏览器都会拉起自己的宿主进程，而桥侧的待发队列是唯一的：
   * 不带标识的话两个宿主会互相抢消息，被抢走的那条在扩展侧静默丢弃
   * （2026-11-09 实测：Chrome + 夸克同时在线时 tab.open 稳定超时）。
   * 带上它，桥就能按 channel_epoch 归属投递，只交给开那条通道的浏览器。 */
  const INSTANCE_ID = randomUUID();

  let config = null;          // { port, token }；未就绪前收到的帧暂存
  let buf = Buffer.alloc(0);  // 未处理完的字节流（半包）
  let skip = 0;               // 超长帧剩余待丢弃字节（跨 chunk 持久化）
  const earlyFrames = [];     // 配置就绪前暂存的帧
  let pendingBusy = false;    // pending 轮询简单布尔锁，避免并发叠加
  let retryTimer = null;
  let pendingTimer = null;
  let stopped = false;
  let lastReloadAt = 0;

  /* 桥每次重启都会换一个新令牌（main.js 侧重新生成 .bridge.json），
   * 同时 provider_epoch 也换了一轮 —— 扩展手里的 helloAck 就此作废。
   *
   * 所以这里不是「拿到新令牌接着用」，而是**换令牌就退出**：
   * 本进程一退，Chrome 就会关掉 native port，扩展的 onDisconnect 随即触发重连，
   * 新宿主进程读到新令牌、重新 hello、拿到新 epoch —— 整条链路自愈。
   *
   * 为什么不原地换令牌继续跑：那样扩展不会重新握手，它会一直用旧 epoch 发包，
   * 桥每次都以 epoch-mismatch 拒绝，表现为「连着但什么都做不了」，比断开更难查。
   * 代价是扩展页会多一条 "Native host has exited"，属于可接受的已知噪音。
   *
   * 节流 1.5s：桥没起来时轮询每秒一次，不能每次都读盘。 */
  function refreshConfig() {
    const now = Date.now();
    if (now - lastReloadAt < 1500) return config;
    lastReloadAt = now;
    const c = resolveConfig();
    if (!c || !config) return config;
    if (c.token !== config.token || c.port !== config.port) {
      log('桥已重启（端口 ' + c.port + '），退出以便扩展重新握手');
      config = c;
      setTimeout(() => cleanupAndExit(0), 50);
    }
    return config;
  }

  const reqInit = (cfg, extra) => ({
    ...extra,
    headers: { 'X-Orb-Token': cfg.token, ...(extra.headers || {}) },
    signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
  });

  function writeFrame(obj) {
    if (stopped) return;
    const frame = encodeFrame(obj);
    if (frame.length === 0) return; // 不可序列化：安全 no-op，不写坏的协议字节
    try {
      process.stdout.write(frame);
    } catch {
      log('stdout 写入失败');
    }
  }

  async function postRelay(message, cfg) {
    const body = JSON.stringify({ message });
    const send = (c) => fetch(
      'http://127.0.0.1:' + c.port + '/api/browser/relay?instance=' + encodeURIComponent(INSTANCE_ID),
      reqInit(c, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }),
    );
    try {
      const res = await send(cfg);
      /* 401 = 桥重启过、令牌换了。refreshConfig 会安排本进程退出，
         由浏览器重建宿主 + 扩展重新握手；这一帧不重发（重连后扩展会重发）。 */
      if (res.status === 401) { refreshConfig(); return; }
      const data = await res.json();
      const reply = data && data.reply;
      if (reply !== null && typeof reply === 'object') writeFrame(reply);
    } catch (e) {
      // 网络失败只写 stderr，不伪造协议消息、不崩。
      log('relay 失败: ' + (e && e.message ? e.message : 'unknown'));
    }
  }

  async function pollPending(cfg) {
    if (pendingBusy || stopped) return;
    pendingBusy = true;
    try {
      const res = await fetch(
        'http://127.0.0.1:' + cfg.port + '/api/browser/pending?instance=' + encodeURIComponent(INSTANCE_ID),
        reqInit(cfg, { method: 'GET' }),
      );
      if (res.status === 401) { refreshConfig(); return; }
      const data = await res.json();
      const messages = data && data.messages;
      if (Array.isArray(messages)) {
        for (const m of messages) {
          if (m !== null && typeof m === 'object') writeFrame(m);
        }
      }
    } catch (e) {
      log('pending 轮询失败: ' + (e && e.message ? e.message : 'unknown'));
    } finally {
      pendingBusy = false;
    }
  }

  function activate(cfg) {
    if (stopped) return;
    config = cfg;
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    log('已就绪，桥端口 ' + cfg.port); // 启动日志只写 stderr，绝不含 token
    const queued = earlyFrames.splice(0);
    for (const m of queued) void postRelay(m, config);
    pendingTimer = setInterval(() => { void pollPending(config); }, 1000);
    pendingTimer.unref(); // 不阻止进程退出
  }

  function onData(chunk) {
    let data = chunk;
    if (skip > 0) {
      const n = Math.min(skip, data.length);
      data = data.subarray(n);
      skip -= n;
      if (skip > 0) return; // 仍在丢弃超长帧余下字节，buf 仍为空
    }
    buf = Buffer.concat([buf, data]);
    const r = decodeFrames(buf, onDiscard);
    buf = r.rest;
    skip = r.skip;
    for (const frame of r.frames) {
      if (config) void postRelay(frame, config);
      else if (earlyFrames.length < MAX_EARLY_FRAMES) earlyFrames.push(frame);
      else log('配置未就绪，丢弃一帧');
    }
  }

  function cleanupAndExit(code) {
    if (stopped) return;
    stopped = true;
    if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    process.exit(code);
  }

  // stdout 的 EPIPE / stdin 异常等不能让进程崩溃。
  process.stdout.on('error', () => cleanupAndExit(0));
  process.stdin.on('error', () => cleanupAndExit(0));
  process.stdin.on('data', onData);
  process.stdin.on('end', () => cleanupAndExit(0));
  process.on('SIGINT', () => cleanupAndExit(0));

  log('宿主启动');
  const initial = resolveConfig();
  if (initial) {
    activate(initial);
  } else {
    log('等待桥配置（.bridge.json / ORB_PORT / ORB_TOKEN / ORB_TOKEN_FILE）...');
    retryTimer = setInterval(() => {
      const c = resolveConfig();
      if (c) activate(c);
    }, 2000);
    retryTimer.unref(); // 生命线是 stdin；配置重试定时器不阻止退出
  }
}

module.exports = { encodeFrame, decodeFrames, MAX_FRAME, startHost };

if (require.main === module) {
  startHost();
}
