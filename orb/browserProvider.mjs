/**
 * 浏览器操控 Provider 协议：ORB 侧纯逻辑状态机。
 *
 * 与传输层完全解耦：不碰 HTTP / 文件 / 子进程，只做「消息 → 回复 / 通知」的状态转移。
 * ORB 内建通道与外部 MV3 扩展共用这套语义；宿主通过 drain() 轮询，把主动通知
 * （channel_closed / channel_close）推给扩展。
 *
 * 约定：
 *  - handle(raw) 是 async 且永不抛异常；坏消息降级为 null，业务拒绝走 provider_result.error。
 *  - 成功但无需回复的消息（channel_open / channel_renew / cancel）返回 null。
 *  - provider_hello 每次成功都会前进 provider_epoch 并作废旧 channel。
 *  - 租约按注入的 clock() 惰性判定：handle / drain / stats 入口都会清理过期 channel。
 *  - 白名单是唯一放行依据，且绝不执行任意 JS；所有对外结果的字段形状固定。
 */
export const BROWSER_PROTOCOL_VERSION = 1;

/* 硬编码命令白名单：只读无需确认，写必须 params.confirm === true。 */
export const BROWSER_METHODS = Object.freeze({
  read: Object.freeze([
    "dom.get_visible_dom",
    "dom.get_text",
    /* 整页正文（2026-11-09）：只取可见文本节点，天然排除 <script>/<style> 源码，
       也不会像「拼所有元素 textContent」那样把子元素重复一遍。
       用户原话「提取出所有文字放到记事本」就该一条命令拿到干净正文。 */
    "dom.get_page_text",
    "dom.get_attributes",
    "tab.list",
    "tab.url",
    "tab.title",
    "browser.info",
  ]),
  write: Object.freeze([
    "dom.click",
    "dom.type",
    "dom.scroll",
    /* 显式开新页（2026-11-05）。归到 write：它会新增一个标签并把它纳入接管集合，
       属于有副作用的操作，必须带 confirm。之所以需要它，是因为扩展不再自动建
       about:blank（那会让标签栏每重连一次多一个空白页），开页必须由命令点名。 */
    "tab.open",
    "tab.goto",
    "tab.back",
    "tab.forward",
    "tab.reload",
    "tab.focus",
  ]),
  deniedPrefixes: Object.freeze(["cua.", "cookie."]),
  deniedExact: Object.freeze(["eval", "upload", "submit", "script.execute"]),
});

const PROTOCOL = BROWSER_PROTOCOL_VERSION;
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_MAX_INFLIGHT = 8;
const DEFAULT_MAX_CHANNELS = 4;

const READ = new Set(BROWSER_METHODS.read);
const WRITE = new Set(BROWSER_METHODS.write);
const DENIED_EXACT = new Set(BROWSER_METHODS.deniedExact);
const DENIED_PREFIXES = BROWSER_METHODS.deniedPrefixes;
/* 这些家族的子命名空间也一律拒绝：即便将来误加白名单也不放行，杜绝任意 JS 执行。 */
const DENIED_FAMILIES = ["eval.", "upload.", "submit.", "script.execute."];

/* 固定、脱敏的错误文案：绝不夹带 onCommand 的异常信息或任何注入内容。 */
const ERROR_MESSAGES = Object.freeze({
  "protocol-mismatch": "protocol version mismatch",
  stopped: "provider stopped",
  "epoch-mismatch": "channel epoch mismatch",
  "channel-expired": "channel expired",
  cancelled: "command cancelled",
  "method-denied": "method denied",
  "confirmation-required": "confirmation required",
  "tab-not-owned": "tab not owned",
  "duplicate-command": "duplicate command id",
  "resource-exhausted": "too many inflight commands",
  "command-failed": "command execution failed",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

function positiveInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
}

function isExplicitlyDenied(method) {
  if (DENIED_EXACT.has(method)) return true;
  for (const p of DENIED_PREFIXES) if (method.startsWith(p)) return true;
  for (const p of DENIED_FAMILIES) if (method.startsWith(p)) return true;
  return false;
}

/* 白名单是唯一放行依据；显式拒绝优先于白名单（防御性）。 */
function classifyMethod(method) {
  if (isExplicitlyDenied(method)) return "denied";
  if (READ.has(method)) return "read";
  if (WRITE.has(method)) return "write";
  return "denied";
}

let instanceCounter = 0;

export function createBrowserProvider(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};

  /* clock 优先，now 作为等价别名，便于确定性单测。 */
  const clock = typeof o.clock === "function"
    ? o.clock
    : (typeof o.now === "function" ? o.now : Date.now);
  function safeClock() {
    try {
      const v = Number(clock());
      return Number.isFinite(v) ? v : 0;
    } catch {
      return 0;
    }
  }

  const baseEpoch = isNonEmptyString(o.epoch)
    ? o.epoch
    : `ep-${safeClock()}-${Math.random().toString(36).slice(2, 10)}`;
  const leaseTtlMs = positiveInt(o.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
  const maxInflight = positiveInt(o.maxInflight, DEFAULT_MAX_INFLIGHT);
  const maxChannels = positiveInt(o.maxChannels, DEFAULT_MAX_CHANNELS);
  const onCommand = typeof o.onCommand === "function" ? o.onCommand : async () => null;
  /* 用户级设置（当前只有 API 通道开关）：
   * 状态源在桥进程（apiChannel.mjs），provider 只做转发与回带，自己不存值。
   * 这样扩展面板拨的开关和桥实际执行用的是同一份状态 —— 面板显示"开"而桥按"关"
   * 执行这类分裂，比没有开关更糟。
   * 两个回调都可缺省：缺省时 settings 消息一律不采纳，hello_ack 也不带该字段，
   * 老版本扩展据此显示"桥不支持"，而不是显示一个假的默认值。 */
  const readSettings = typeof o.settingsSnapshot === "function" ? o.settingsSnapshot : null;
  const writeSettings = typeof o.onSettings === "function" ? o.onSettings : null;

  /* instance id 只依赖 clock + 模块内计数，不引入其它不可控来源。 */
  instanceCounter += 1;
  const providerInstanceId = `inst-${safeClock()}-${instanceCounter}`;

  let providerEpoch = baseEpoch;
  let helloSeq = 0;
  let stopped = false;
  let protocolMismatch = false;

  let hellos = 0;
  let commands = 0;
  let succeeded = 0;
  let failed = 0;
  const byReason = Object.create(null);

  const channels = new Map();          /* channel_epoch -> channel */
  const usedChannelEpochs = new Set(); /* 曾成功 open 过，防 epoch 重用 */
  const expiredChannelEpochs = new Set();
  const seen = new Set();              /* 已进入执行的 command_id，防重放 */
  const cancelled = new Set();
  const inflight = new Map();          /* command_id -> channel_epoch */
  const pending = [];
  /* channel_epoch -> 宿主实例标识。
   *
   * 为什么需要它：pending 原来是**全局单队列**，而每个装了扩展的浏览器都会起一个
   * 原生宿主进程、各自 1s 轮询一次 /api/browser/pending。两个浏览器同时在线时
   * 谁先轮询谁就把消息整条取走 —— 取走的那一方如果没有这条 channel_epoch 对应的
   * 连接，扩展侧 dispatchCommand 走到 canSend() 会静默丢弃（连错误都不回），
   * 桥侧只看到「命令在限定时间内未收到扩展执行回执」。
   * 实测（2026-11-09）：Chrome + 夸克都装了扩展时，tab.open 稳定复现超时，
   * 而 tab.list 时好时坏 —— 典型的「两个消费者抢一个队列」。
   *
   * 归属来源：channel_open 是从某个宿主转发上来的，转发时带上 instance，
   * 于是「这个 channel 归哪个宿主」是可判定的事实，不靠猜。 */
  const channelOwner = new Map();

  /* pending 里的条目带上入队时间，供 drain 清掉「归属未知、永远送不出去」的残条。 */
  function pushPending(msg) {
    pending.push({ msg, at: safeClock() });
  }

  function okReply(commandId, result) {
    succeeded += 1;
    return { type: "provider_result", command_id: commandId, ok: true, result };
  }

  /* 统一错误回复：字段固定，code 即 reasonCode，outcome 默认 not_started。 */
  function fail(commandId, code, extra) {
    failed += 1;
    byReason[code] = (byReason[code] || 0) + 1;
    return {
      type: "provider_result",
      command_id: commandId,
      ok: false,
      error: {
        code,
        message: ERROR_MESSAGES[code] || "command rejected",
        retryable: code === "resource-exhausted",
        outcome: (extra && extra.outcome) || "not_started",
      },
    };
  }

  function cleanupChannel(ce) {
    channels.delete(ce);
    channelOwner.delete(ce);
    for (const [cid, epoch] of Array.from(inflight)) {
      if (epoch === ce) inflight.delete(cid);
    }
  }

  function isExpired(ch) {
    return safeClock() >= ch.leaseDeadlineMs;
  }

  function expireChannel(ce) {
    cleanupChannel(ce);
    expiredChannelEpochs.add(ce);
    pushPending({ type: "channel_closed", channel_epoch: ce, reason: "channel_expired" });
  }

  /* 惰性租约清理：无定时器，宿主轮询或收到任何消息时判定。 */
  function sweepExpired() {
    const now = safeClock();
    for (const [ce, ch] of Array.from(channels)) {
      if (now >= ch.leaseDeadlineMs) expireChannel(ce);
    }
  }

  function advanceEpoch() {
    helloSeq += 1;
    /* 第一次 hello 把 provider_epoch 重置为注入的 epoch；之后每次前进一代。 */
    providerEpoch = helloSeq === 1 ? baseEpoch : `${baseEpoch}#${helloSeq}`;
    for (const ce of Array.from(channels.keys())) cleanupChannel(ce);
    cancelled.clear();
  }

  function onHello(m) {
    if (m.protocol !== PROTOCOL) {
      protocolMismatch = true;
      return null;
    }
    if (!isNonEmptyString(m.extension_id) ||
        !isNonEmptyString(m.extension_version) ||
        !isNonEmptyString(m.browser_family)) {
      return null;
    }
    protocolMismatch = false;
    hellos += 1;
    advanceEpoch();
    return {
      type: "provider_hello_ack",
      protocol: PROTOCOL,
      provider_epoch: providerEpoch,
      provider_instance_id: providerInstanceId,
      lease_ttl_ms: leaseTtlMs,
      /* 回带用户开关的**真值**：扩展面板据此显示，不自己存一份默认值。 */
      ...settingsEcho(),
    };
  }

  /* 设置回带的**唯一**出口：只透出白名单字段。
   * 绝不 `{...opts}` —— 那会把后续新加的凭据类选项一并漏给扩展。 */
  function settingsEcho() {
    const out = {};
    if (!readSettings) return out;
    let snap = null;
    try { snap = readSettings(); } catch { snap = null; }
    if (!snap || typeof snap !== "object" || Array.isArray(snap)) return out;
    if (typeof snap.api_channel_enabled === "boolean") out.api_channel_enabled = snap.api_channel_enabled;
    /* 端点清单只用于界面显示，属于"通道状态"的一部分。收紧成短字符串数组，
       防止将来某个调用方把整份配置（含 url/凭据字段）顺手带出去。 */
    if (Array.isArray(snap.api_channel_endpoints)) {
      out.api_channel_endpoints = snap.api_channel_endpoints
        .filter((x) => typeof x === "string" && x.trim())
        .slice(0, 8)
        .map((x) => x.trim().slice(0, 24));
    }
    return out;
  }

  /* 扩展面板拨开关。**不受急停限制**：急停管的是"不再执行动作"，
   * 而这里是治理配置（同 policyTransition 的处理口径）—— 急停期间用户
   * 反而更需要能把对外取数关掉。写入失败不抛异常，回 accepted:false + reason。 */
  function onSettings(m) {
    if (!writeSettings) return null;
    if (typeof m.api_channel_enabled !== "boolean") return null;
    let r = null;
    try { r = writeSettings({ api_channel_enabled: m.api_channel_enabled }); } catch { r = null; }
    const echo = settingsEcho();
    if (!r || r.ok !== true) {
      return {
        type: "settings_ack",
        accepted: false,
        reason: (r && isNonEmptyString(r.reason)) ? r.reason : "rejected",
        ...echo,
      };
    }
    const ack = { type: "settings_ack", accepted: true, persisted: r.persisted !== false, ...echo };
    if (r.warning) ack.warning = String(r.warning).slice(0, 200);
    return ack;
  }

  function onChannelOpen(m, meta) {
    if (!isNonEmptyString(m.channel_epoch)) return null;
    const ce = m.channel_epoch;
    if (stopped) return { type: "channel_closed", channel_epoch: ce, reason: "stopped" };
    if (usedChannelEpochs.has(ce)) {
      return { type: "channel_closed", channel_epoch: ce, reason: "channel_epoch_reused" };
    }
    if (channels.size >= maxChannels) {
      return { type: "channel_closed", channel_epoch: ce, reason: "resource-exhausted" };
    }
    const now = safeClock();
    const ch = {
      channelEpoch: ce,
      sessionId: m.session_id === undefined || m.session_id === null ? null : m.session_id,
      leaseDeadlineMs: now + leaseTtlMs,
      ownedTabs: new Set(),
      openedAt: now,
    };
    /* session_id 可视为该 channel 已登记的一个 tab 标识。 */
    if (typeof m.session_id === "string" || typeof m.session_id === "number") {
      ch.ownedTabs.add(String(m.session_id));
    }
    channels.set(ce, ch);
    usedChannelEpochs.add(ce);
    /* 记住这条 channel 是从哪个宿主转上来的：drain 只把命令交给它自己的宿主。
       宿主没带 instance（老版本宿主）时不登记，drain 退回老的「谁要都给」行为。 */
    const inst = meta && typeof meta.instance === "string" ? meta.instance : "";
    if (inst) channelOwner.set(ce, inst);
    return null;
  }

  function onChannelRenew(m) {
    if (!isNonEmptyString(m.channel_epoch)) return null;
    const deadline = m.lease_deadline_ms;
    if (typeof deadline !== "number" || !Number.isFinite(deadline)) return null;
    const ch = channels.get(m.channel_epoch);
    if (!ch || isExpired(ch)) {
      return { type: "channel_closed", channel_epoch: m.channel_epoch, reason: "channel_expired" };
    }
    ch.leaseDeadlineMs = deadline;
    return null;
  }

  function onCancel(m) {
    if (!isNonEmptyString(m.channel_epoch) || !isNonEmptyString(m.command_id)) return null;
    const ch = channels.get(m.channel_epoch);
    if (!ch || isExpired(ch)) return null;
    cancelled.add(m.command_id);
    inflight.delete(m.command_id); /* 取消即释放 inflight 槽位 */
    return null;
  }

  function onChannelClose(m) {
    if (!isNonEmptyString(m.channel_epoch)) return null;
    cleanupChannel(m.channel_epoch);
    return { type: "channel_close_ack", channel_epoch: m.channel_epoch, cleaned: true };
  }

  function validCommandShape(m) {
    return isNonEmptyString(m.channel_epoch) &&
      isNonEmptyString(m.command_id) &&
      isNonEmptyString(m.method) &&
      isPlainObject(m.params);
  }

  async function onCommandMessage(m) {
    if (!validCommandShape(m)) return null;
    commands += 1;
    const ce = m.channel_epoch;
    const cid = m.command_id;
    const method = m.method;
    const params = m.params;

    if (stopped) return fail(cid, "stopped");
    if (protocolMismatch) return fail(cid, "protocol-mismatch");

    const ch = channels.get(ce);
    if (!ch) {
      return fail(cid, expiredChannelEpochs.has(ce) ? "channel-expired" : "epoch-mismatch");
    }
    if (isExpired(ch)) {
      expireChannel(ce);
      return fail(cid, "channel-expired");
    }

    if (cancelled.has(cid)) return fail(cid, "cancelled");

    const kind = classifyMethod(method);
    if (kind === "denied") return fail(cid, "method-denied");
    if (kind === "write" && params.confirm !== true) return fail(cid, "confirmation-required");

    if (params.tabId !== undefined && params.tabId !== null &&
        !ch.ownedTabs.has(String(params.tabId))) {
      return fail(cid, "tab-not-owned");
    }

    if (seen.has(cid)) return fail(cid, "duplicate-command");
    if (inflight.size >= maxInflight) return fail(cid, "resource-exhausted");

    seen.add(cid);
    inflight.set(cid, ce);
    const ctx = { channel_epoch: ce, command_id: cid, provider_epoch: providerEpoch, method };
    let value;
    try {
      value = await onCommand(method, params, ctx);
    } catch {
      inflight.delete(cid);
      if (cancelled.has(cid)) return fail(cid, "cancelled");
      return fail(cid, "command-failed", { outcome: "failed" });
    }
    inflight.delete(cid);
    if (cancelled.has(cid)) return fail(cid, "cancelled"); /* 执行期间被取消，结果不采纳 */
    if (stopped) return fail(cid, "stopped");              /* 执行期间急停，结果不采纳 */
    return okReply(cid, value === undefined ? null : value);
  }

  /* ------------------------------------------------------------------ *
   * 桥侧主动下发（2026-11-08）：把一条 command 推入 pending，由宿主轮询
   * /api/browser/pending 转交扩展执行。扩展收到后走与自发命令完全相同的
   * 「桥授权 → 扩展本地执行 → command_done 回执」流程（见扩展 background.js
   * 的 onNativeMessage case 'command'）。
   *
   * 入队前用统一 code 卡死，绝不把坏命令塞进队列：
   *   method-denied          方法不在白名单（或命中显式拒绝家族）
   *   confirmation-required  写操作但 params.confirm !== true
   *   no-channel            当前没有任何活跃通道（扩展未连接 / 全部到期）
   * 成功返回 command_id（调用方用它关联 command_done 回执）。
   * ------------------------------------------------------------------ */
  function command(method, params, opts) {
    const kind = classifyMethod(method);
    if (kind === "denied") return { ok: false, code: "method-denied" };
    if (kind === "write" && (params && params.confirm) !== true) return { ok: false, code: "confirmation-required" };
    let ce = null;
    for (const [k, ch] of Array.from(channels)) {
      if (!isExpired(ch)) { ce = k; break; }
    }
    if (!ce) return { ok: false, code: "no-channel" };
    const commandId = (opts && isNonEmptyString(opts.commandId))
      ? opts.commandId
      : `cmd-${safeClock()}-${Math.random().toString(36).slice(2, 10)}`;
    /* 与扩展自发命令同一形状：type/command_id/method/params 齐全，
       扩展收到后按自有 command_id 重新派发，桥侧只需保证本消息可被识别。 */
    pushPending({ type: "command", channel_epoch: ce, command_id: commandId, method, params });
    return { ok: true, command_id: commandId, channel_epoch: ce };
  }

  /* 唯一入口：顶层兜底保证永不抛异常 / 永不 reject。 */
  async function handle(raw, meta) {
    try {
      sweepExpired();
      if (!isPlainObject(raw)) return null;
      switch (raw.type) {
        case "provider_hello": return onHello(raw);
        case "channel_open": return onChannelOpen(raw, meta);
        case "channel_renew": return onChannelRenew(raw);
        case "cancel": return onCancel(raw);
        case "channel_close": return onChannelClose(raw);
        case "settings": return onSettings(raw);
        case "command": return await onCommandMessage(raw);
        default: return null;
      }
    } catch {
      return null;
    }
  }

  /* 急停：清空 channel/inflight，逐 channel 推一条 channel_close，并置 stopped。 */
  function closeAll(reason = "stopped") {
    const r = isNonEmptyString(reason) ? reason : "stopped";
    const ces = Array.from(channels.keys());
    for (const ce of ces) {
      pushPending({ type: "channel_close", channel_epoch: ce, reason: r });
    }
    channels.clear();
    inflight.clear();
    cancelled.clear();
    stopped = true;
    return ces.length;
  }

  function reopen() {
    stopped = false;
    return true;
  }

  /* 供宿主轮询：取走**属于本宿主**的消息并清空已取走的部分。
   *
   * instance 为空（老宿主）→ 维持老行为，全量取走，避免老版本宿主没消息可拿。
   * 带 instance → 只交付「channel_epoch 归属本宿主」或「不带 channel_epoch」的消息，
   * 别人的留在队列里等它自己的宿主来取。归属未知（channel 已过期、或开通道的宿主
   * 没带 instance）的条目超过一个租约周期就丢掉，不让队列无界增长。 */
  function drain(instance) {
    sweepExpired();
    if (!isNonEmptyString(instance)) {
      const out = pending.map((e) => e.msg);
      pending.length = 0;
      return out;
    }
    const now = safeClock();
    const out = [];
    const keep = [];
    for (const e of pending) {
      const ce = e.msg && typeof e.msg.channel_epoch === "string" ? e.msg.channel_epoch : "";
      if (!ce) { out.push(e.msg); continue; }          // 广播类：谁取都行
      const owner = channelOwner.get(ce);
      if (owner === instance) { out.push(e.msg); continue; }
      if (owner === undefined) {
        /* 归属未知：可能 channel 刚过期。给一个租约周期的宽限，过后丢弃。 */
        if (now - e.at < leaseTtlMs) keep.push(e);
        continue;
      }
      keep.push(e);                                     // 明确属于另一个宿主
    }
    pending.length = 0;
    for (const e of keep) pending.push(e);
    return out;
  }

  function stats() {
    sweepExpired();
    /* 接管中的标签页按所有活跃通道汇总。只回数字，不回 tabId —— 面板只需要看规模，
       把 tabId 抖给前端等于多一个可被误用的枚举面。 */
    let ownedTabs = 0;
    for (const ch of channels.values()) ownedTabs += ch.ownedTabs ? ch.ownedTabs.size : 0;
    return {
      hellos,
      commands,
      succeeded,
      failed,
      byReason: { ...byReason },
      channels: channels.size,
      ownedTabs,
      inflight: inflight.size,
      stopped,
    };
  }

  /* 脱敏配置：只挑白名单字段，绝不展开 opts（apiKey 等凭据一律不外泄），不含 onCommand。 */
  function config() {
    return {
      protocol: PROTOCOL,
      leaseTtlMs,
      maxInflight,
      maxChannels,
      providerEpoch,
      providerInstanceId,
    };
  }

  function isStopped() {
    return stopped;
  }

  /* 供调用方登记 tab 所有权（对应 channel_open 的 session_id 之外的显式登记）。 */
  function ownTab(channelEpoch, tabId) {
    if (!isNonEmptyString(channelEpoch) || tabId === undefined || tabId === null) return false;
    const ch = channels.get(channelEpoch);
    if (!ch || isExpired(ch)) return false;
    ch.ownedTabs.add(String(tabId));
    return true;
  }

  return { handle, closeAll, drain, stats, config, isStopped, reopen, ownTab, command };
}
