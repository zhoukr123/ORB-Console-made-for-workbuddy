/* ORB Browser Bridge — MV3 service worker (ESM, type: "module")
 *
 * 自研 Provider：只连 com.orb.browser 宿主，绝不占用 WorkBuddy 官方宿主名。
 * 安全判定（白名单 / epoch / 租约 / tab 所有权 / confirm 确认）全部在桥侧。
 * 扩展发出 command 后，只有收到 provider_result.ok===true 且
 * result.authorized===true 才本地执行；执行完回 command_done 记账。
 * 收到 ok:false 一律不执行，错误写入 popup 状态。绝不自行放宽任何限制。
 *
 * 所有 chrome.* 都是运行时全局；本文件不 import 任何模块，便于 `node --check`。
 */

'use strict';

const NATIVE_HOST = 'com.orb.browser';
const PROTOCOL = 1;
/* 脚本构建戳：只用来回答一个问题——「现在跑的这一份，是不是磁盘上那一份」。
 *
 * 为什么要它：Chrome 不会因为磁盘上的扩展文件变了就重读脚本，必须去扩展页点
 * 「重新加载」。而这份脚本最容易踩这个坑 —— 改完代码以为生效了，实际浏览器里
 * 还是旧的，表现就是「明明已经修好的行为又回来了」（2026-11-09：删掉分组逻辑后
 * 仍旧建组，查了半天才发现跑的是旧脚本）。
 * 改这个文件时顺手改这里，然后 browser.info 会把它报回来，桥侧一比对就知道新旧。 */
const BUILD = '2026-11-09T0130';
/* 分组标题/颜色已随「读操作不再分组」一起移除（2026-11-09）。
   groupId 仍保留：老版本可能已把标签页并进 ORB 分组，急停时要靠它拆掉。 */
const MAX_NODES = 300;
const MAX_TEXT = 200;
const RECONNECT_ALARM = 'orb.reconnect';

const DOM_METHODS = new Set([
  'dom.get_visible_dom',
  'dom.get_text',
  /* 整页正文（2026-11-09）：get_visible_dom 收的是**每个元素**的 textContent，
     父元素的 textContent 又包含子元素，于是「把所有节点 text 拼起来」既重复一遍，
     还会把内联 <script>/<style> 的源码拼进正文（实测湖南大学首页正文前 300 字全是 JS）。
     要「把网页文字提取出来」就该有一个专门的整页取文本入口，而不是让调用方去猜。 */
  'dom.get_page_text',
  'dom.get_attributes',
  'dom.click',
  'dom.type',
  'dom.scroll',
]);
const TAB_METHODS = new Set([
  'tab.list',
  'tab.open',
  'tab.url',
  'tab.title',
  'tab.goto',
  'tab.back',
  'tab.forward',
  'tab.reload',
  'tab.focus',
  'browser.info',
]);
// 这些命令必须作用在一个「本扩展接管」的标签页上。
const TAB_SCOPED = new Set([
  'dom.get_visible_dom',
  'dom.get_text',
  'dom.get_page_text',
  'dom.get_attributes',
  'dom.click',
  'dom.type',
  'dom.scroll',
  'tab.url',
  'tab.title',
  'tab.goto',
  'tab.back',
  'tab.forward',
  'tab.reload',
  'tab.focus',
]);

const BROWSER_FAMILY = (() => {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/OPR\//.test(ua)) return 'opera';
  if (/Chrome\//.test(ua)) return 'chrome';
  return 'chromium';
})();

const state = {
  port: null,
  helloAck: null,
  channelEpoch: null,
  channelsOpened: 0,
  renewTimer: null,
  renewIntervalMs: 0,
  reconnectDelayMs: 1000,
  reconnectCapMs: 60000,
  ownedTabIds: new Set(),
  groupId: null,
  lastOwnedTabId: null,
  pending: new Map(),
  lastError: null,
  /* API 通道用户开关：**不在这里存权威值**，只镜像桥回带的真值。
   * 扩展自己存一份就会出现「面板显示开、桥按关执行」的分裂，
   * 那比没有开关更糟。known=false 表示桥尚未告知（未握手或桥版本过旧）。 */
  apiChannel: { enabled: false, known: false, pending: false, requested: null, warning: null, endpoints: null },
};

function makeError(code, message, retryable, outcome) {
  return {
    code: String(code),
    message: String(message == null ? '' : message).slice(0, 300),
    retryable: !!retryable,
    outcome: String(outcome || 'failed'),
  };
}

/* command_done.result 里绝不能出现 cookie / 密码 / apiKey / 完整 HTML。 */
function scrub(value, depth) {
  depth = depth || 0;
  if (value == null) return null;
  if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value)) {
    if (/cookie|password|passwd|secret|token|apikey|api[_-]?key|authorization|authorisation|outerhtml|innerhtml/i.test(key)) continue;
    out[String(key).slice(0, 120)] = scrub(value[key], depth + 1);
  }
  return out;
}

function canSend() {
  return !!(state.port && state.helloAck && state.channelEpoch);
}

function post(message) {
  if (!state.port) return false;
  try {
    state.port.postMessage(message);
    return true;
  } catch (e) {
    state.lastError = 'postMessage failed: ' + (e && e.message ? e.message : String(e));
    return false;
  }
}

/* ---------------- tab 所有权（持久化到 chrome.storage.session） ---------------- */

async function persistOwned() {
  await chrome.storage.session.set({
    ownedTabIds: Array.from(state.ownedTabIds),
    groupId: state.groupId,
  });
}

async function loadOwned() {
  const data = await chrome.storage.session.get({ ownedTabIds: [], groupId: null });
  state.ownedTabIds = new Set((data.ownedTabIds || []).map(Number));
  state.groupId = data.groupId == null ? null : Number(data.groupId);
  state.lastOwnedTabId = state.ownedTabIds.size ? Array.from(state.ownedTabIds).pop() : null;
}

async function pruneOwned() {
  for (const id of Array.from(state.ownedTabIds)) {
    try {
      await chrome.tabs.get(id);
    } catch (e) {
      state.ownedTabIds.delete(id);
    }
  }
  if (!state.ownedTabIds.has(state.lastOwnedTabId)) {
    state.lastOwnedTabId = state.ownedTabIds.size ? Array.from(state.ownedTabIds).pop() : null;
  }
  await persistOwned();
}

async function removeOwnedTab(tabId) {
  if (!state.ownedTabIds.delete(tabId)) return;
  if (state.lastOwnedTabId === tabId) {
    state.lastOwnedTabId = state.ownedTabIds.size ? Array.from(state.ownedTabIds).pop() : null;
  }
  await persistOwned();
}

/* 只把「本扩展创建」的 tab 登记为接管，并归入标题 ORB 的绿色标签组。 */
/* 登记所有权。**只登记，不动标签栏。**
 *
 * 2026-11-09 用户反馈：只是让 ORB 读一下当前页的文字，标签栏却冒出一个 ORB 分组。
 * 根因是「懒接管」走了 addOwnedTab，而它顺手 chrome.tabs.group + 改标题改颜色。
 *
 * 这跟 2026-11-05 的既有决定一致：tab.open 明确不调 createOwnedTab，理由写在
 * personaRecvGate.test.mjs —— 「开了就不管」才像用户自己点开的页面。
 * 同一个理由适用于所有读操作：读一下内容不该在用户的标签栏留下任何痕迹。
 * 所以这里把分组逻辑整个删掉，不再保留「有时分组有时不分」的开关
 * —— 留着开关就迟早会有人再打开它。
 *
 * ungroupOwnedTabs 保留：老版本可能已经把标签页并进了 ORB 分组，
 * 急停/关通道时仍要帮用户把那些历史分组拆掉。 */
async function addOwnedTab(tabId) {
  state.ownedTabIds.add(tabId);
  state.lastOwnedTabId = tabId;
  await persistOwned();
}

/* 懒接管：需要页面但手上还没有时，接管用户**当前正在看**的那一页。
 *
 * 这是「复用用户日常浏览器的登录态」这个定位的直接体现 —— 用户此刻开着的页面
 * 才是他想让 ORB 操作的对象，凭空新开一页既没有登录态，又污染标签栏。
 * chrome:// / edge:// / about: 这类页面注入不了脚本，不接管（返回 null，由调用方拒绝）。
 */
async function ensureOwnedTab() {
  if (state.lastOwnedTabId != null && state.ownedTabIds.has(state.lastOwnedTabId)) {
    return state.lastOwnedTabId;
  }
  if (state.ownedTabIds.size > 0) {
    const first = Array.from(state.ownedTabIds)[0];
    state.lastOwnedTabId = first;
    return first;
  }
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0] ? tabs[0] : null;
  } catch { /* 查询失败按"没有可用页面"处理 */ }
  if (!tab || tab.id === undefined) return null;
  if (!/^https?:/i.test(String(tab.url || ''))) return null;
  try {
    /* 懒接管只登记所有权，不分组：这是「读一下当前页」的场景，
       不该在用户标签栏留下 ORB 分组（见 addOwnedTab 头注）。 */
    await addOwnedTab(tab.id);
  } catch (e) {
    state.lastError = 'adopt tab failed: ' + (e && e.message ? e.message : String(e));
    return null;
  }
  return tab.id;
}

async function ungroupOwnedTabs() {
  const ids = Array.from(state.ownedTabIds);
  if (ids.length) {
    try {
      await chrome.tabs.ungroup({ tabIds: ids });
    } catch (e) {
      /* 急停时即使 ungroup 失败也继续清理 */
    }
  }
  state.ownedTabIds.clear();
  state.groupId = null;
  state.lastOwnedTabId = null;
  await persistOwned();
}

/* ---------------- 连接管理 + 退避重连 ---------------- */

function connect() {
  if (state.port) return;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    state.lastError = 'connectNative failed: ' + (e && e.message ? e.message : String(e));
    scheduleReconnect();
    return;
  }
  state.port = port;
  state.helloAck = null;
  port.onMessage.addListener(onNativeMessage);
  port.onDisconnect.addListener(() => {
    if (state.port === port) state.port = null;
    const detail = (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'native host disconnected';
    state.lastError = 'disconnected: ' + detail;
    state.helloAck = null;
    clearChannel(false);
    scheduleReconnect();
    /* chrome.alarms 的延迟会被浏览器钳到 >=30s（开发版扩展除外）。ORB 重启后
       宿主会主动退出以触发重新握手，如果只等 alarm，用户要空等半分钟。
       此刻 service worker 通常还活着，先就地快速重连一次；SW 被回收则由 alarm 兜底。
       两者并发无害：connect() 里 state.port 非空就直接返回。 */
    try {
      setTimeout(() => { if (!state.port) connect(); }, 1200);
    } catch { /* SW 已回收，交给 alarm */ }
  });
  post({
    type: 'provider_hello',
    protocol: PROTOCOL,
    extension_id: chrome.runtime.id,
    extension_version: chrome.runtime.getManifest().version,
    browser_family: BROWSER_FAMILY,
  });
}

function scheduleReconnect() {
  const delayMs = Math.min(state.reconnectCapMs, state.reconnectDelayMs);
  // chrome.alarms 的 delayInMinutes 可能被 Chrome 钳制到 >=30s（开发版扩展除外），
  // 这里仍按指数退避给出期望值，且只用一个命名 alarm，不重复堆积。
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: Math.max(delayMs, 1000) / 60000 });
  state.reconnectDelayMs = Math.min(state.reconnectCapMs, state.reconnectDelayMs * 2);
}

function handleHelloAck(msg) {
  // 校验 protocol === 1 且 provider_epoch 非空。
  if (msg.protocol !== PROTOCOL || !msg.provider_epoch) {
    state.lastError = 'invalid provider_hello_ack (protocol/epoch)';
    try { if (state.port) state.port.disconnect(); } catch (e) { /* noop */ }
    return;
  }
  state.helloAck = {
    protocol: msg.protocol,
    provider_epoch: String(msg.provider_epoch),
    provider_instance_id: msg.provider_instance_id == null ? null : String(msg.provider_instance_id),
    lease_ttl_ms: Number(msg.lease_ttl_ms) > 0 ? Number(msg.lease_ttl_ms) : 30000,
  };
  state.reconnectDelayMs = 1000;
  chrome.alarms.clear(RECONNECT_ALARM);
  /* 桥回带用户开关真值；没有这个字段说明桥侧还没有该能力，
     保持 known=false，面板会如实显示"桥不支持"，而不是显示一个假默认值。 */
  if (Array.isArray(msg.api_channel_endpoints)) {
    state.apiChannel.endpoints = msg.api_channel_endpoints
      .filter((x) => typeof x === 'string' && x.trim())
      .slice(0, 8)
      .map((x) => x.trim().slice(0, 24));
  }
  if (typeof msg.api_channel_enabled === 'boolean') {
    state.apiChannel.enabled = msg.api_channel_enabled;
    state.apiChannel.known = true;
    state.apiChannel.pending = false;
    state.apiChannel.requested = null;
    state.apiChannel.warning = null;
  } else {
    state.apiChannel.known = false;
  }
  void openChannel().catch((e) => {
    state.lastError = 'openChannel failed: ' + (e && e.message ? e.message : String(e));
  });
}

/* ---------------- API 通道开关（桥是唯一状态源，这里只镜像） ---------------- */

function apiChannelSnapshot() {
  return {
    enabled: state.apiChannel.enabled === true,
    /* 只有"已握手且桥明确告知过"才算知道；否则界面必须说不知道，不能猜。 */
    known: !!state.apiChannel.known && !!state.helloAck,
    pending: !!state.apiChannel.pending,
    requested: state.apiChannel.requested,
    warning: state.apiChannel.warning,
    endpoints: Array.isArray(state.apiChannel.endpoints) ? state.apiChannel.endpoints.slice() : null,
    bridge_connected: !!state.port,
    bridge_acked: !!state.helloAck,
  };
}

function applySettingsAck(msg) {
  if (typeof msg.api_channel_enabled === 'boolean') {
    state.apiChannel.enabled = msg.api_channel_enabled;
    state.apiChannel.known = true;
  }
  if (Array.isArray(msg.api_channel_endpoints)) {
    state.apiChannel.endpoints = msg.api_channel_endpoints
      .filter((x) => typeof x === 'string' && x.trim())
      .slice(0, 8)
      .map((x) => x.trim().slice(0, 24));
  }
  state.apiChannel.pending = false;
  state.apiChannel.requested = null;
  if (msg.accepted === false) {
    state.apiChannel.warning = '桥未采纳本次修改（' + String(msg.reason || 'rejected') + '）';
  } else if (msg.persisted === false) {
    state.apiChannel.warning = msg.warning
      ? String(msg.warning)
      : '已生效，但未能写入磁盘，重启 ORB 后会退回关闭';
  } else {
    state.apiChannel.warning = null;
  }
  return { ok: msg.accepted !== false, ...apiChannelSnapshot() };
}

/* 拨开关：不本地改值，等桥 ack 回来再改 —— 避免"界面先变、桥没收到"的假成功。 */
function setApiChannel(enabled) {
  const want = enabled === true;
  if (!state.port) {
    return { ok: false, error: 'bridge-offline', message: 'ORB 桥未连接，开关无法生效', ...apiChannelSnapshot() };
  }
  if (!state.helloAck) {
    return { ok: false, error: 'bridge-not-ready', message: '正在与 ORB 桥握手，请稍后再试', ...apiChannelSnapshot() };
  }
  if (!post({ type: 'settings', api_channel_enabled: want })) {
    return { ok: false, error: 'post-failed', message: state.lastError || '发送失败', ...apiChannelSnapshot() };
  }
  state.apiChannel.pending = true;
  state.apiChannel.requested = want;
  state.apiChannel.warning = null;
  return { ok: true, pending: true, ...apiChannelSnapshot() };
}

/* ---------------- channel 管理 ---------------- */

async function openChannel() {
  if (state.channelEpoch) return;
  const epoch = crypto.randomUUID();
  state.channelEpoch = epoch;
  state.channelsOpened += 1;
  // 只有 ack 之后才 open channel。
  if (!post({ type: 'channel_open', channel_epoch: epoch })) {
    clearChannel(false);
    return;
  }
  /* 这里**不再**自动建 about:blank。
   *
   * 旧行为是「只要没有已接管页面就开一个」，后果是：扩展每次重载、每次断线重连
   * 都往标签栏塞一个空白页 —— 用户看到的就是「点一下刷新又冒出一个新标签页」，
   * 而且那个页面没有任何登录态，等于白开。
   * 现在改成懒接管：真正要执行需要页面的命令时，才去接管用户当前正在看的那一页
   * （见 ensureOwnedTab）。只建立通道，不动用户的标签栏。 */
  startRenew();
}

function startRenew() {
  stopRenew();
  const ttl = state.helloAck ? state.helloAck.lease_ttl_ms : 30000;
  // 间隔取 ttl 的 1/3，clamp 到 2s..10s。
  const interval = Math.min(10000, Math.max(2000, Math.floor(ttl / 3)));
  state.renewIntervalMs = interval;
  state.renewTimer = setInterval(() => {
    if (!canSend()) return;
    post({
      type: 'channel_renew',
      channel_epoch: state.channelEpoch,
      lease_deadline_ms: Date.now() + ttl,
    });
  }, interval);
}

function stopRenew() {
  if (state.renewTimer != null) {
    clearInterval(state.renewTimer);
    state.renewTimer = null;
  }
}

function clearChannel(ungroup) {
  stopRenew();
  const epoch = state.channelEpoch;
  state.channelEpoch = null;
  if (epoch) {
    for (const commandId of state.pending.keys()) {
      post({ type: 'cancel', channel_epoch: epoch, command_id: commandId });
    }
  }
  state.pending.clear();
  if (ungroup) void ungroupOwnedTabs();
  return epoch;
}

function closeChannel(reason) {
  const epoch = state.channelEpoch;
  if (!epoch) return;
  for (const commandId of state.pending.keys()) {
    post({ type: 'cancel', channel_epoch: epoch, command_id: commandId });
  }
  clearChannel(false);
  post({ type: 'channel_close', channel_epoch: epoch });
  if (reason) state.lastError = 'channel closed: ' + reason;
}

/* ---------------- command：扩展发起 → 桥授权 → 本地执行 → 记账 ---------------- */

function dispatchCommand(method, params) {
  // 断线 / 未 ack / 无 channel 期间收到的 command 一律不发，也不执行。
  if (!canSend()) {
    const error = makeError('not-connected', 'native channel is not ready; command dropped', true, 'dropped');
    state.lastError = error.code + ': ' + error.message;
    return { ok: false, queued: false, error: error };
  }
  if (typeof method !== 'string' || !method) {
    const error = makeError('method-denied', 'missing method', false, 'denied');
    state.lastError = error.code + ': ' + error.message;
    return { ok: false, queued: false, error: error };
  }
  const commandId = crypto.randomUUID();
  state.pending.set(commandId, {
    method: method,
    params: params,
    channelEpoch: state.channelEpoch,
  });
  const sent = post({
    type: 'command',
    channel_epoch: state.channelEpoch,
    command_id: commandId,
    method: method,
    params: params,
  });
  if (!sent) {
    state.pending.delete(commandId);
    const error = makeError('not-connected', 'postMessage failed; command dropped', true, 'dropped');
    state.lastError = error.code + ': ' + error.message;
    return { ok: false, queued: false, error: error };
  }
  return { ok: true, queued: true, command_id: commandId };
}

async function handleProviderResult(msg) {
  const commandId = msg && msg.command_id;
  const entry = state.pending.get(commandId);
  if (!entry) {
    state.lastError = 'provider_result for unknown command_id: ' + String(commandId);
    return;
  }
  state.pending.delete(commandId);

  let outcome;
  if (msg.ok === true && msg.result && msg.result.authorized === true) {
    // 只有桥侧明确授权后，才进入本地执行。
    try {
      outcome = await execLocal(entry.method, entry.params);
    } catch (e) {
      outcome = { ok: false, error: makeError('exec-failed', e && e.message ? e.message : String(e), true, 'failed') };
    }
  } else {
    // ok:false 一律不执行，错误进 popup 状态。
    const raw = msg.error && typeof msg.error === 'object' ? msg.error : {};
    outcome = {
      ok: false,
      error: {
        code: String(raw.code || 'provider-denied'),
        message: String(raw.message || 'provider rejected the command').slice(0, 300),
        retryable: !!raw.retryable,
        outcome: String(raw.outcome || 'denied'),
      },
    };
  }

  if (!outcome.ok) state.lastError = outcome.error.code + ': ' + outcome.error.message;
  sendCommandDone(commandId, entry.channelEpoch, outcome);
}

function sendCommandDone(commandId, channelEpoch, outcome) {
  // 所有回给桥的 command_done 必带 command_id 与 channel_epoch。
  const message = {
    type: 'command_done',
    command_id: commandId,
    channel_epoch: channelEpoch,
    ok: !!outcome.ok,
  };
  if (outcome.ok) message.result = scrub(outcome.result);
  else message.error = outcome.error;
  post(message);
}

/* ---------------- 页内注入函数（不 eval、不注入字符串脚本、不读 cookie） ----------------
 * 该函数被 chrome.scripting.executeScript 序列化后在隔离世界执行，
 * 因此函数体内不得引用模块作用域的任何变量，参数一律通过 args 传入。
 */
function orbInjected(payload) {
  const w = window;
  const maxNodes = payload.maxNodes || 300;
  const maxText = payload.maxText || 200;

  const INTERACTIVE_TAGS = {
    a: 1, button: 1, input: 1, select: 1, textarea: 1, summary: 1,
    option: 1, label: 1, details: 1, dialog: 1, optgroup: 1,
  };
  const INTERACTIVE_ROLES = {
    button: 1, link: 1, checkbox: 1, radio: 1, textbox: 1, combobox: 1,
    listbox: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1,
    option: 1, searchbox: 1, slider: 1, spinbutton: 1, switch: 1, tab: 1, treeitem: 1,
  };
  const SENSITIVE_ATTR = /^on[a-z]+$|cookie|password|passwd|secret|token|apikey|api[_-]?key|authorization|authorisation|auth|outerhtml|innerhtml/i;

  const clip = (s) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > maxText ? t.slice(0, maxText) : t;
  };
  const fail = (code, message, outcome) => ({
    ok: false,
    error: { code: code, message: String(message).slice(0, 300), retryable: false, outcome: outcome || 'failed' },
  });

  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const cs = w.getComputedStyle(el);
    if (!cs) return true;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    if (Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const interactive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS[tag]) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (INTERACTIVE_ROLES[role]) return true;
    if (el.hasAttribute('tabindex') || el.hasAttribute('onclick')) return true;
    return !!el.isContentEditable;
  };
  const accessibleName = (el) => {
    for (const a of ['aria-label', 'alt', 'title', 'placeholder']) {
      const v = el.getAttribute(a);
      if (v) return clip(v);
    }
    return '';
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.round(r.width), height: Math.round(r.height),
    };
  };

  // nodeId 用页内递增序号，Map 存在 window.__orbNodes（隔离世界内跨调用保留）。
  function scan() {
    const map = new Map();
    w.__orbNodes = map;
    const out = [];
    const all = document.querySelectorAll('*');
    let seq = 0;
    for (let i = 0; i < all.length && out.length < maxNodes; i += 1) {
      const el = all[i];
      if (!visible(el)) continue;
      const text = clip(el.textContent);
      if (!interactive(el) && !text) continue; // 只收可交互或含文本的元素
      const nodeId = ++seq;
      map.set(nodeId, el);
      out.push({
        nodeId: nodeId,
        tag: el.tagName.toLowerCase(),
        role: (el.getAttribute('role') || '').toLowerCase(),
        name: accessibleName(el),
        text: text,
        rect: rectOf(el),
      });
    }
    return out;
  }

  const nodeOf = (nodeId) => {
    if (!w.__orbNodes || w.__orbNodes.size === 0) scan(); // map 丢失时尽力重建
    const el = w.__orbNodes.get(Number(nodeId));
    return el && el.isConnected ? el : null;
  };

  const p = payload;
  switch (p.op) {
    case 'get_visible_dom':
      return { ok: true, result: scan() };

    case 'get_text': {
      const el = nodeOf(p.nodeId);
      if (!el) return fail('node-not-found', 'nodeId not found: ' + String(p.nodeId));
      return { ok: true, result: { nodeId: Number(p.nodeId), text: clip(el.textContent) } };
    }

    case 'get_page_text': {
      /* 整页可见正文。用 TreeWalker 走文本节点，而不是遍历元素的 textContent：
         · 只取文本节点 → 不会因为父元素包含子元素而重复计数；
         · 祖先在 SKIP 表里 → 天然排除 <script>/<style> 源码；
         · 父元素不可见 → 跳过（display:none 的内容不该出现在正文里）。
         上限用 maxText 的宽松倍数，够一篇文章用，又不会把超长页面拖死。 */
      const SKIP = { script: 1, style: 1, noscript: 1, template: 1 };
      const limit = Math.max(maxText * 40, 20000);
      const chunks = [];
      let total = 0;
      let truncated = false;
      const root = document.body || document.documentElement;
      if (!root) return fail('no-document', 'document has no body');
      let walker;
      try {
        walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      } catch (e) {
        return fail('walk-failed', e && e.message ? e.message : String(e));
      }
      let n = walker.nextNode();
      while (n) {
        const raw = n.nodeValue;
        if (raw && raw.trim()) {
          const pEl = n.parentElement;
          const tag = pEl ? pEl.tagName.toLowerCase() : '';
          if (!SKIP[tag] && pEl && visible(pEl)) {
            const line = raw.replace(/\s+/g, ' ').trim();
            if (line) {
              if (total + line.length > limit) { truncated = true; break; }
              chunks.push(line);
              total += line.length + 1;
            }
          }
        }
        n = walker.nextNode();
      }
      const text = chunks.join('\n');
      return { ok: true, result: { text, length: text.length, blocks: chunks.length, truncated, title: document.title || '', url: location.href } };
    }

    case 'get_attributes': {
      const el = nodeOf(p.nodeId);
      if (!el) return fail('node-not-found', 'nodeId not found: ' + String(p.nodeId));
      const attributes = {};
      for (const a of el.attributes) {
        if (SENSITIVE_ATTR.test(a.name)) continue;
        if (a.name === 'value' && (el.getAttribute('type') || '').toLowerCase() === 'password') continue;
        attributes[a.name] = clip(a.value);
      }
      return { ok: true, result: { nodeId: Number(p.nodeId), tag: el.tagName.toLowerCase(), attributes: attributes } };
    }

    case 'click': {
      const el = nodeOf(p.nodeId);
      if (!el) return fail('node-not-found', 'nodeId not found: ' + String(p.nodeId));
      try {
        if (typeof el.focus === 'function') el.focus();
        el.click();
      } catch (e) {
        return fail('click-failed', e && e.message ? e.message : String(e));
      }
      return { ok: true, result: { nodeId: Number(p.nodeId), clicked: true } };
    }

    case 'type': {
      const el = nodeOf(p.nodeId);
      if (!el) return fail('node-not-found', 'nodeId not found: ' + String(p.nodeId));
      const text = String(p.text == null ? '' : p.text);
      if (el.isContentEditable) el.textContent = text;
      else if ('value' in el) el.value = text;
      else return fail('not-typable', 'element is not typable');
      // 设 value 后派发 input + change；结果里不回显文本（可能是密码）。
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, result: { nodeId: Number(p.nodeId), typed: true, length: text.length } };
    }

    case 'scroll': {
      const el = nodeOf(p.nodeId) || document.scrollingElement || document.documentElement;
      const dx = Number(p.dx) || 0;
      const dy = Number(p.dy) || 0;
      if (el && typeof el.scrollBy === 'function') el.scrollBy({ left: dx, top: dy, behavior: 'auto' });
      else w.scrollBy(dx, dy);
      return { ok: true, result: { nodeId: p.nodeId == null ? null : Number(p.nodeId), scrolled: true } };
    }

    default:
      return fail('method-denied', 'unknown dom op: ' + String(p.op), 'denied');
  }
}

async function inject(tabId, method, params) {
  const payload = {
    op: method.slice('dom.'.length),
    nodeId: params.nodeId,
    text: params.text,
    dx: params.dx != null ? params.dx : (params.deltaX != null ? params.deltaX : 0),
    dy: params.dy != null ? params.dy : (params.deltaY != null ? params.deltaY : 0),
    maxNodes: MAX_NODES,
    maxText: MAX_TEXT,
  };
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: orbInjected,
      args: [payload],
    });
  } catch (e) {
    return { ok: false, error: makeError('script-injection-failed', e && e.message ? e.message : String(e), true, 'failed') };
  }
  const hit = (results || []).find((r) => r && r.result !== undefined);
  if (!hit || !hit.result) {
    return { ok: false, error: makeError('script-injection-failed', 'no DOM result from tab', true, 'failed') };
  }
  if (hit.result.ok === false) return { ok: false, error: hit.result.error };
  return { ok: true, result: hit.result.result };
}

/* ---------------- 本地执行（只有在桥侧授权之后才会走到这里） ---------------- */

async function execLocal(method, params) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};

  // 本地 tab 所有权闸门：任何命令带的 params.tabId 不在集合内，直接拒绝并回 command_done。
  if (p.tabId != null && !state.ownedTabIds.has(Number(p.tabId))) {
    return {
      ok: false,
      error: makeError('tab-not-owned', 'tabId ' + String(p.tabId) + ' is not owned by ORB', false, 'denied'),
    };
  }

  let tabId = null;
  if (TAB_SCOPED.has(method)) {
    if (p.tabId != null) {
      /* 明确指定了 tabId：必须已在接管集合内，不做任何"顺手接管"——
         这是安全边界，不能因为命令点了名就把任意页面纳入所有权。 */
      tabId = Number(p.tabId);
      if (!state.ownedTabIds.has(tabId)) {
        return {
          ok: false,
          error: makeError('tab-not-owned', 'no owned tab available for this command', false, 'denied'),
        };
      }
    } else {
      /* 未指定：先用上次的，没有就懒接管用户当前页。
         仍然拿不到（比如全屏在 chrome:// 页面上）才拒绝。 */
      tabId = state.lastOwnedTabId;
      if (tabId == null || !state.ownedTabIds.has(tabId)) {
        tabId = await ensureOwnedTab();
      }
      if (tabId == null || !state.ownedTabIds.has(tabId)) {
        return {
          ok: false,
          error: makeError('tab-not-owned', 'no owned tab available for this command', false, 'denied'),
        };
      }
    }
  }

  if (DOM_METHODS.has(method)) return inject(tabId, method, p);

  if (!TAB_METHODS.has(method)) {
    // 其它 method 一律拒绝。
    return {
      ok: false,
      error: makeError('method-denied', "method '" + String(method) + "' is not allowed", false, 'denied'),
    };
  }

  switch (method) {
    case 'tab.list': {
      const tabs = await chrome.tabs.query({});
      const list = (tabs || [])
        .filter((t) => state.ownedTabIds.has(t.id))
        .map((t) => ({
          tabId: t.id,
          title: t.title || '',
          url: t.url || '',
          active: !!t.active,
          groupId: t.groupId == null ? null : t.groupId,
          windowId: t.windowId,
        }));
      return { ok: true, result: { tabs: list, count: list.length } };
    }
    case 'tab.url': {
      const t = await chrome.tabs.get(tabId);
      return { ok: true, result: { tabId: tabId, url: t.url || '' } };
    }
    case 'tab.title': {
      const t = await chrome.tabs.get(tabId);
      return { ok: true, result: { tabId: tabId, title: t.title || '' } };
    }
    case 'tab.open': {
      /* 显式开新页。这是唯一会新增标签的操作 —— 因为它是命令点名要的，
         而不是扩展自己"顺手"开的（那正是以前刷新一次多一个空白页的来源）。
         只允许 http(s)，不给 url 就开空白页。 */
      let targetUrl = '';
      if (p.url != null) {
        let u;
        try {
          u = new URL(String(p.url));
        } catch (e) {
          return { ok: false, error: makeError('url-invalid', 'invalid url', false, 'denied') };
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return { ok: false, error: makeError('url-scheme-denied', 'only http(s) urls are allowed', false, 'denied') };
        }
        targetUrl = u.href;
      }
      let newId = null;
      try {
        /* 用户显式开页：像默认浏览器(openExternal)那样「开了就不管」。
         * 不调用 createOwnedTab，因此不进 ORB 分组、不登记 ownedTabIds、急停也不清理——
         * 行为与普通 shell.openExternal 完全一致，只是落在用户选定的浏览器(夸克/Chrome)里，
         * 而不是系统默认浏览器。这正是之前「默认路干净无分组」所遵循的同一原则。 */
        const tab = await chrome.tabs.create({ url: targetUrl || 'about:blank', active: true });
        newId = tab.id;
      } catch (e) {
        return { ok: false, error: makeError('tab-open-failed', e && e.message ? e.message : String(e), true, 'failed') };
      }
      return { ok: true, result: { tabId: newId, url: targetUrl || 'about:blank' } };
    }
    case 'tab.goto': {
      // 只允许 http(s)，且 tabId 必须已由本地所有权闸门校验为 ownedTabs。
      let url;
      try {
        url = new URL(String(p.url == null ? '' : p.url));
      } catch (e) {
        return { ok: false, error: makeError('url-invalid', 'invalid url', false, 'denied') };
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, error: makeError('url-scheme-denied', 'only http(s) urls are allowed', false, 'denied') };
      }
      await chrome.tabs.update(tabId, { url: url.href });
      return { ok: true, result: { tabId: tabId, url: url.href } };
    }
    case 'tab.back': {
      await chrome.tabs.goBack(tabId);
      return { ok: true, result: { tabId: tabId, action: 'back' } };
    }
    case 'tab.forward': {
      await chrome.tabs.goForward(tabId);
      return { ok: true, result: { tabId: tabId, action: 'forward' } };
    }
    case 'tab.reload': {
      await chrome.tabs.reload(tabId);
      return { ok: true, result: { tabId: tabId, action: 'reload' } };
    }
    case 'tab.focus': {
      await chrome.tabs.update(tabId, { active: true });
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
      } catch (e) { /* 聚焦窗口是尽力而为 */ }
      return { ok: true, result: { tabId: tabId, focused: true } };
    }
    case 'browser.info': {
      const m = chrome.runtime.getManifest();
      return {
        ok: true,
        result: {
          browser_family: BROWSER_FAMILY,
          extension_id: chrome.runtime.id,
          extension_name: m.name,
          extension_version: m.version,
          protocol: PROTOCOL,
          /* 构建戳：桥/面板拿它对比磁盘上的脚本，判断浏览器里跑的是不是旧副本。
             没这个字段 = 跑的是更老的构建（那时还没有它）。 */
          build: BUILD,
          user_agent: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '',
          platform: (typeof navigator !== 'undefined' && navigator.platform) ? navigator.platform : '',
        },
      };
    }
    default:
      return {
        ok: false,
        error: makeError('method-denied', "method '" + String(method) + "' is not allowed", false, 'denied'),
      };
  }
}

/* ---------------- 消息入口 ---------------- */

function onNativeMessage(message) {
  // 消息一律 JSON 对象。
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  switch (message.type) {
    case 'provider_hello_ack':
      handleHelloAck(message);
      break;
    case 'provider_result':
      void handleProviderResult(message).catch((e) => {
        state.lastError = 'provider_result handler: ' + (e && e.message ? e.message : String(e));
      });
      break;
    case 'channel_closed':
      clearChannel(false);
      break;
    case 'channel_close_ack':
      clearChannel(false);
      break;
    case 'settings_ack':
      applySettingsAck(message);
      break;
    case 'channel_close':
      // 急停（桥 → 扩展，带 reason）：清理并 ungroup 所有已接管标签页。
      if (!message.channel_epoch || !state.channelEpoch || message.channel_epoch === state.channelEpoch) {
        clearChannel(true);
      }
      break;
    case 'command':
      // 兼容桥侧推送的意图：同样进入「向桥申请授权 → 本地执行」流程。
      if (message.command_id && state.pending.has(message.command_id)) break; // 防止回声自循环
      dispatchCommand(message.method, message.params);
      break;
    default:
      break;
  }
}

function statusSnapshot() {
  return {
    connected: !!state.port,
    hello_acked: !!state.helloAck,
    protocol: PROTOCOL,
    provider_epoch: state.helloAck ? state.helloAck.provider_epoch : null,
    provider_instance_id: state.helloAck ? state.helloAck.provider_instance_id : null,
    lease_ttl_ms: state.helloAck ? state.helloAck.lease_ttl_ms : null,
    channel_count: state.channelEpoch ? 1 : 0,
    channels_opened_total: state.channelsOpened,
    channel_epoch: state.channelEpoch,
    renew_interval_ms: state.renewIntervalMs,
    owned_tab_count: state.ownedTabIds.size,
    owned_tab_ids: Array.from(state.ownedTabIds),
    group_id: state.groupId,
    pending_commands: state.pending.size,
    last_error: state.lastError,
    extension_id: chrome.runtime.id,
    extension_version: chrome.runtime.getManifest().version,
    browser_family: BROWSER_FAMILY,
    native_host: NATIVE_HOST,
    api_channel: apiChannelSnapshot(),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'orb.status') {
    sendResponse(statusSnapshot());
    return;
  }
  if (message.type === 'orb.command') {
    sendResponse(dispatchCommand(message.method, message.params));
    return;
  }
  if (message.type === 'orb.close') {
    closeChannel(message.reason);
    sendResponse({ ok: true, closed: true });
    return;
  }
  if (message.type === 'orb.apiChannel.set') {
    sendResponse(setApiChannel(message.enabled === true));
    return;
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === RECONNECT_ALARM) {
    chrome.alarms.clear(RECONNECT_ALARM);
    connect();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeOwnedTab(tabId).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => { void init(); });

async function init() {
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS_ONLY' });
  } catch (e) { /* 默认即为 TRUSTED_CONTEXTS_ONLY，忽略 */ }
  try {
    await loadOwned();
    await pruneOwned();
  } catch (e) {
    state.lastError = 'storage init: ' + (e && e.message ? e.message : String(e));
  }
  connect();
}

void init();
