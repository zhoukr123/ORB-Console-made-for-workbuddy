/* 设置 › 通道 › 检索工具：非敏感配置的单一真相源（纯 CJS，零 electron 依赖，可单测）。
 *
 * 边界（与 bridge.mjs 检索红线对齐）：
 *   · 本模块**只处理非敏感配置**：启用开关、服务商、模型/引擎、可选端点、自定义名称。
 *     API Key 永远不写进配置文件、不进任何返回值 —— 只在主进程启动桥的那一瞬，
 *     由 vault 解密后注入 ORB_SEARCH_API_KEY 环境变量。
 *   · 默认 inert：从没配置过 → bridgeEnv 返回空对象，桥保持既有默认关闭。
 *     配置过但没启用 / 没 key 且服务商不支持匿名 → 显式注入 ORB_SEARCH_ENABLED=0。
 *   · 2026-11-06 晚：AnySearch / 自定义档允许**无 Key 匿名调用**（官方 API key 可选），
 *     这是唯一「不申请任何 key 也能跑通结构化检索」的路径，正好回应用户对
 *     「来路不明的 key」的顾虑。匿名时注入 ENABLED=1 但 CREDENTIAL_SOURCE=inert、
 *     API_KEY 为空，桥侧 adapter 会省略 Authorization 头。
 *   · 与视觉模型槽同一套纪律：明文不进渲染层、不进 HTTP 请求体、不进日志。
 *
 * 为什么单独拆文件：main.js 已六千行且依赖 electron，无法在 node --test 里直接跑；
 * 而「未知服务商回落 / 关闭时强制 inert / key 不落盘」这几条是最容易悄悄破的护栏。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/* 与 orb/searchProviderAdapters.mjs 的 ADAPTER_IDS 保持一致。
   由 test/searchToolConfig.test.mjs 做跨模块比对，防止两边漂移。
   第一位是 AnySearch（用户 2026-11-06 要求置顶）；最后一项 custom 允许自由填名称。 */
const PROVIDERS = Object.freeze(['anysearch', 'deepseek', 'zhipu', 'baidu', 'custom']);
const DEFAULT_PROVIDER = 'anysearch';
/* 只有这两档允许「无 Key 匿名调用」；其余无 key 一律强制 inert，绝不裸发请求。 */
const ANONYMOUS_PROVIDERS = Object.freeze(['anysearch', 'custom']);
const MAX_MODEL_LEN = 120;
const MAX_ENDPOINT_LEN = 300;
const MAX_NAME_LEN = 60;

function str(v) {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

/* 端点协议闸：只放行 http(s)。用户自填端点会把 Bearer Key 发过去，
   绝不允许 javascript: / file: / 任意自定义协议混进来。 */
function safeEndpoint(v) {
  const s = str(v).trim().slice(0, MAX_ENDPOINT_LEN);
  if (!s) return '';
  try {
    const u = new URL(s);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? s : '';
  } catch {
    return '';
  }
}

/* 自定义服务商名称：只作显示标签，不参与任何 URL 拼接 / 请求形状判断。
   去掉控制字符，避免有人把换行或注入指令塞进面板状态栏。 */
function safeName(v) {
  return str(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

/* 归一化：未知服务商一律回落 anysearch（绝不猜一个「看起来可用」的）；
   enabled 只认字面 true，配置误写 "1" / "true" 不会偷偷打开外发。 */
function normalize(patch, base) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const b = base && typeof base === 'object' ? base : {};
  const raw = str(p.provider ?? b.provider).trim().toLowerCase();
  const enabledRaw = Object.prototype.hasOwnProperty.call(p, 'enabled') ? p.enabled : b.enabled;
  return {
    enabled: enabledRaw === true,
    provider: PROVIDERS.includes(raw) ? raw : DEFAULT_PROVIDER,
    model: str(p.model ?? b.model).trim().slice(0, MAX_MODEL_LEN),
    endpoint: safeEndpoint(p.endpoint ?? b.endpoint),
    customName: safeName(p.customName ?? b.customName),
  };
}

function hasConfigFile(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

/* 读失败（文件不存在 / 半个 JSON / 权限）一律回落到 inert 默认，绝不抛到面板。 */
function readConfig(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')) || {}, {});
  } catch {
    return normalize({}, {});
  }
}

/* 原子写 tmp→rename，只写五个非敏感字段。调用方即使误传 apiKey 也会被丢弃。 */
function writeConfig(file, cfg) {
  const c = normalize(cfg, {});
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c), 'utf8');
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* Windows 下可能不支持，忽略 */ }
  return c;
}

/* 给面板的只读视图：含掩码但绝不含完整 key。
   opts.apiKey 只在主进程内部用来算尾四位，不会被原样带出。 */
function publicView(cfg, opts = {}) {
  const c = normalize(cfg, {});
  const key = str(opts.apiKey);
  const hasKey = opts.hasKey === true && key.length > 0;
  const anonymous = ANONYMOUS_PROVIDERS.includes(c.provider);
  return {
    enabled: c.enabled,
    provider: c.provider,
    model: c.model,
    endpoint: c.endpoint,
    customName: c.customName,
    hasKey,
    keyMask: hasKey ? '••••' + key.slice(-4) : '',
    encrypted: opts.encrypted === true,
    configured: opts.configured === true,
    providers: [...PROVIDERS],
    anonymousProviders: [...ANONYMOUS_PROVIDERS],
    anonymous,
    /* 显式启用 +（有 key 或该档允许匿名）才算真能发请求。 */
    effective: c.enabled && (hasKey || anonymous),
  };
}

/* 生成注入桥进程的环境变量。configured=false（面板从没配置过）时返回空对象，
   保持原有环境变量 / 默认 inert，不越权覆盖用户的手工配置。
   匿名档：ENABLED=1、CREDENTIAL_SOURCE=inert、API_KEY 为空，由 adapter 省略鉴权头。 */
function bridgeEnv(cfg, apiKey, configured) {
  if (configured !== true) return {};
  const c = normalize(cfg, {});
  const key = str(apiKey).trim();
  const allowsAnonymous = ANONYMOUS_PROVIDERS.includes(c.provider);
  const on = c.enabled && (key.length > 0 || allowsAnonymous);
  const env = {
    ORB_SEARCH_ENABLED: on ? '1' : '0',
    ORB_SEARCH_CREDENTIAL_SOURCE: on && key.length > 0 ? 'env' : 'inert',
    ORB_SEARCH_API_KEY: on ? key : '',
    ORB_SEARCH_PROVIDER: c.provider,
    ORB_SEARCH_MODEL: c.model,
  };
  if (c.endpoint) env.ORB_SEARCH_ENDPOINT = c.endpoint;
  return env;
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER, ANONYMOUS_PROVIDERS,
  MAX_MODEL_LEN, MAX_ENDPOINT_LEN, MAX_NAME_LEN,
  str, safeEndpoint, safeName, normalize, hasConfigFile, readConfig, writeConfig,
  publicView, bridgeEnv,
};
