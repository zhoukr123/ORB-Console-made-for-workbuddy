/* Popup 的状态读取与 API 通道开关。
 *
 * 必须独立成文件：MV3 扩展页的默认 CSP 是 `script-src 'self'`，
 * **不允许内联 <script>**。写在 popup.html 里会被浏览器直接拦掉，
 * 并在扩展页留下一条永久的 "Executing inline script violates ..." 错误 ——
 * 面板看着像坏了，其实只是脚本根本没跑。
 *
 * 开关的权威值在桥侧（apiChannel.mjs），这里只显示桥回报的真值：
 * 拨动后等 ack 回来才改界面，避免"界面先变绿、桥没收到"的假成功。
 */
const $ = (id) => document.getElementById(id);
const txt = (v) => (v === null || v === undefined || v === '') ? '—' : String(v);

/* 最近一次成功读到的开关状态：提交失败时用它回滚界面，不留下错位显示。 */
let lastApi = null;

function renderApi(a) {
  const el = $('apich');
  const st = $('apistate');
  const wa = $('apiwarn');
  const v = (a && typeof a === 'object') ? a : {};
  lastApi = v;

  const connected = !!v.bridge_connected;
  const known = !!v.known;
  const pending = !!v.pending;
  const on = v.enabled === true;

  /* pending 时展示用户刚拨到的位置，其余时候展示桥的真值。 */
  el.checked = (pending && typeof v.requested === 'boolean') ? v.requested : on;

  let label = '';
  let cls = '';
  let disabled = false;
  if (!connected) {
    label = '桥未连接 · 开关暂不可用';
    cls = 'bad';
    disabled = true;
  } else if (!known) {
    label = '当前桥版本不回报该状态，无法开关';
    cls = 'warn';
    disabled = true;
  } else if (pending) {
    label = '正在提交给 ORB 桥…';
    cls = 'warn';
    disabled = true;
  } else if (on) {
    label = '已开启 · 需要时才向登记端点取数';
    cls = 'ok';
  } else {
    label = '已关闭 · 零外发（默认）';
  }

  st.textContent = label;
  st.className = cls;
  el.disabled = disabled;
  el.setAttribute('aria-checked', el.checked ? 'true' : 'false');

  /* 端点数量与名字由桥回带，不在页面里写死 —— 否则白名单一扩，文案立刻变谎话。
     桥没回带时保留 HTML 里的兜底文案（那份是当前真实清单）。 */
  const labels = Array.isArray(v.endpoints)
    ? v.endpoints.filter((x) => typeof x === 'string' && x.trim())
    : [];
  if (labels.length) {
    $('apicount').textContent = labels.length + ' 个已登记端点';
    $('apinames').textContent = labels.join('、');
  }

  if (v.warning) {
    wa.textContent = '⚠ ' + String(v.warning);
    wa.className = 'on';
  } else {
    wa.textContent = '';
    wa.className = '';
  }
}

function render(s) {
  if (!s || s.error) {
    $('conn').textContent = '读取失败';
    $('conn').className = 'v bad';
    $('err').textContent = '最近一条错误：' + (s && s.error ? s.error : '无法连接 background');
    $('err').className = '';
    /* 读不到状态时开关一律置灰：宁可让用户多点一次，也不显示一个可能过期的"开"。 */
    renderApi({ bridge_connected: false });
    return;
  }
  const connected = !!s.connected;
  const acked = !!s.hello_acked;
  $('conn').textContent = connected ? (acked ? '已连接 / 已握手' : '已连接 / 待握手') : '未连接';
  $('conn').className = 'v ' + (connected && acked ? 'ok' : (connected ? 'warn' : 'bad'));
  $('epoch').textContent = txt(s.provider_epoch);
  $('channels').textContent = s.channel_count + (s.channels_opened_total ? ' (累计 ' + s.channels_opened_total + ')' : '');
  $('tabs').textContent = txt(s.owned_tab_count);
  $('chepoch').textContent = txt(s.channel_epoch);
  $('extid').textContent = txt(s.extension_id);
  $('host').textContent = txt(s.native_host);
  const hasErr = !!s.last_error;
  $('err').textContent = hasErr ? ('最近一条错误：' + s.last_error) : '最近一条错误：无';
  $('err').className = hasErr ? '' : 'none';
  renderApi(s.api_channel);
}

function refresh() {
  try {
    chrome.runtime.sendMessage({ type: 'orb.status' }, (resp) => {
      if (chrome.runtime.lastError) { render({ error: chrome.runtime.lastError.message }); return; }
      render(resp);
    });
  } catch (e) {
    render({ error: e && e.message ? e.message : String(e) });
  }
}

/* 拨开关：只发意图，不本地改值；等 ack 由下一次 refresh 呈现。 */
$('apich').addEventListener('change', () => {
  const want = $('apich').checked;
  $('apich').disabled = true;
  $('apistate').textContent = '正在提交给 ORB 桥…';
  $('apistate').className = 'warn';
  try {
    chrome.runtime.sendMessage({ type: 'orb.apiChannel.set', enabled: want }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        renderApi({ ...(lastApi || {}), pending: false, warning: chrome.runtime.lastError ? chrome.runtime.lastError.message : '提交失败' });
        return;
      }
      if (resp.ok === false) {
        /* 桥拒绝/离线：把界面拨回原值，并说明原因，不留下"看起来开着"的错位。 */
        renderApi({ ...(lastApi || {}), warning: resp.message || resp.error || '提交失败' });
        return;
      }
      renderApi(resp);
      setTimeout(refresh, 350);
    });
  } catch (e) {
    renderApi({ ...(lastApi || {}), pending: false, warning: e && e.message ? e.message : String(e) });
  }
});

refresh();
setInterval(refresh, 2000);
