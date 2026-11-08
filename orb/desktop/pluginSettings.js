/* pluginSettings.js — 设置 › 插件 页交互（经典脚本，自带 callOps，不依赖主脚本全局）
 *
 * 两个视图共用一条搜索栏：
 *   已安装    ← /api/ops plugin.list（桥侧真实注册表）
 *   插件市场  ← /api/ops plugin.market.list（本机 WorkBuddy 市场清单，服务端搜索）
 *
 * 写入路径只走真实闸门：
 *   plugin.dryrun / plugin.install      导入区（先校验、后安装）
 *   plugin.market.install               从市场装（读市场里真实的插件目录）
 *   plugin.run                          自检
 *
 * 设计纪律：
 *  - 不伪造：列表只画桥侧回的东西；装不上就照实报闸门给的原因。
 *  - 危险能力必须二次确认：第一次安装不带 approvedBy，被拒后按钮变「审批并安装」。
 *  - 启停是面板级偏好（localStorage），后端暂无 plugin.disable，内置插件不可停。
 *  - 动效/主题全走 panel.html 的 CSS 变量，本文件不写死颜色。
 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var LS_KEY = 'orb.plugins.disabled';
  var LS_TAB = 'orb.plugins.tab';
  var MARKET_PAGE = 60;
  /* 市场默认只摆 2 条：收起态一行一条（名称 + 类别），点开才铺细节。
     市场收录几十上百个，全摊开能把整页拉到几千像素。 */
  var MARKET_PREVIEW = 2;
  var MARKET_STEP = 20;

  /* ---------------- 状态 ---------------- */
  var tab = 'installed';
  var query = '';
  var installed = [];
  var installedLoaded = false;
  var market = null;            // { marketplaces, items, total, warnings, root, scannedAt }
  var marketLoaded = false;
  var installedFilter = 'all';
  var marketFilter = '';
  var marketAllTotal = 0;   // 全量收录数（页签徽标/下拉标题用，不受搜索影响）
  var marketShown = MARKET_PREVIEW;  // 当前摊开的条数（点「显示更多」按批加）
  var expanded = new Set();     // 展开态：跨 render 保留（筛选/停用都会重建 DOM）
  var searchTimer = 0;

  /* ---------------- 图标 ---------------- */
  var ICON = {
    builtin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 20.6 7.6v8.8L12 21.2 3.4 16.4V7.6Z"/><path d="M12 12 20.6 7.6M12 12 3.4 7.6M12 12v9.2"/></svg>',
    custom: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
    market: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8.4h16l-1.2 11a1.6 1.6 0 0 1-1.6 1.4H6.8a1.6 1.6 0 0 1-1.6-1.4Z"/><path d="M8.6 8.4V6.6a3.4 3.4 0 0 1 6.8 0v1.8"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.8 12.6 4.6 4.6L19.2 7.4"/></svg>',
    err: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 6.2v7.4"/><circle cx="12" cy="17.6" r="1.1" fill="currentColor" stroke="none"/></svg>',
    chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5.6 6.4 6.4L9 18.4"/></svg>'
  };

  /* 被闸门以「危险能力」拒过之后，按钮换成这一版文案：再点一次才是显式审批 */
  var APPROVE_HTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 20 6v6c0 4.6-3.2 8-8 9.2-4.8-1.2-8-4.6-8-9.2V6Z"/><path d="M9 12l2.2 2.2L15.4 10"/></svg>审批并安装';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ---------------- 面板级启停偏好 ---------------- */
  function disabledSet() {
    try { return new Set(JSON.parse(localStorage.getItem(LS_KEY) || '[]')); }
    catch (e) { return new Set(); }
  }
  function saveDisabled(set) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(Array.from(set))); } catch (e) { /* 不可用时忽略 */ }
  }

  function setMsg(text, kind) {
    var m = $('#plugImportMsg');
    if (!m) return;
    var k = (kind === 'ok' || kind === 'err') ? kind : '';
    m.className = 'plug-msg' + (k ? ' ' + k : '');
    m.innerHTML = (k ? ICON[k] : '') + '<span>' + esc(text || '') + '</span>';
    if (text) {
      m.classList.remove('show');
      void m.offsetWidth;
      m.classList.add('show');
    }
  }

  /* ---------------- 桥通信 ---------------- */
  var TOKEN = '';
  function bridgeBase() {
    try {
      var p = new URLSearchParams(location.search).get('bridge');
      if (p && /^\d{2,5}$/.test(p)) return 'http://127.0.0.1:' + p;
    } catch (e) { /* location 不可用则用默认 */ }
    return 'http://127.0.0.1:19387';
  }
  async function getToken(force) {
    if (TOKEN && !force) return TOKEN;
    try {
      TOKEN = (window.orb && typeof window.orb.getBridgeToken === 'function')
        ? ((await window.orb.getBridgeToken()) || '')
        : '';
    } catch (e) { TOKEN = ''; }
    return TOKEN;
  }
  async function callOps(action, extra) {
    var body = Object.assign({ action: action }, extra || {});
    async function once(retried) {
      var t = await getToken(retried);
      var headers = { 'Content-Type': 'application/json' };
      if (t) headers['X-Orb-Token'] = t;
      var r = await fetch(bridgeBase() + '/api/ops', {
        method: 'POST', headers: headers, body: JSON.stringify(body)
      });
      if (r.status === 401 && !retried) return once(true);
      return await r.json();
    }
    return once(false);
  }

  /* ---------------- 保真度 ---------------- */
  function fidelityOf(p) {
    var f = p.fidelity;
    if (!f && p.builtin) f = 'executable';
    return f === 'executable' || f === 'declarative' || f === 'descriptor' ? f : '';
  }
  var FID_CLS = { executable: 'ok', declarative: 'accent', descriptor: 'warn' };

  /* 市场短名：市场 id 又长又像路径，卡片上一行放不下。
     别名是纯显示层，认不出就用原名截断 —— 不影响任何判定。 */
  var MARKET_ALIAS = {
    'codebuddy-plugins-official': '官方',
    'workbuddy-connector-plugins-official': '连接器',
    'workbuddy-builtin': '随包',
    'cb_teams_marketplace': '团队',
    'experts': '专家',
    'workbuddy-wecom-unified': '企微'
  };
  function shortMarket(name) {
    return MARKET_ALIAS[name] || String(name || '').replace(/-plugins?/g, '').slice(0, 12);
  }

  function skeletonHtml() {
    var one = '<div class="plug-skel"><i class="sk-ico"></i>'
      + '<div class="sk-main"><i class="sk-l1"></i><i class="sk-l2"></i><i class="sk-l3"></i></div></div>';
    return one + one;
  }

  /* ================= 已安装视图 ================= */

  function filteredInstalled() {
    var q = query.trim().toLowerCase();
    return installed.filter(function (p) {
      if (installedFilter === 'builtin' && !p.builtin) return false;
      if (installedFilter === 'custom' && p.builtin) return false;
      if (!q) return true;
      return String(p.name || '').toLowerCase().indexOf(q) >= 0
        || String(p.id || '').toLowerCase().indexOf(q) >= 0
        || String(p.brief || '').toLowerCase().indexOf(q) >= 0;
    });
  }

  function cardInstalled(p, i) {
    var isOff = disabledSet().has(p.id);
    var inputs = Array.isArray(p.inputs) ? p.inputs : [];
    var outputs = Array.isArray(p.outputs) ? p.outputs : [];
    var fid = fidelityOf(p);
    var fcls = FID_CLS[fid] || '';
    return '<div class="plug-card' + (isOff ? ' off' : '') + (expanded.has(p.id) ? ' open' : '')
      + '" data-id="' + esc(p.id) + '" style="--i:' + i + '">'
      + '<div class="plug-ico">' + (p.builtin ? ICON.builtin : ICON.custom) + '</div>'
      + '<div class="plug-main">'
      +   '<div class="plug-title">' + esc(p.name || p.id)
      +     '<span class="plug-badge ' + (p.builtin ? 'accent' : '') + '">' + (p.builtin ? '内置' : '自定义') + '</span>'
      +     (p.level ? '<span class="plug-badge">' + esc(p.level) + '</span>' : '')
      +     (fid ? '<span class="plug-badge ' + fcls + '"><i class="plug-dot ' + fcls + '"></i>' + esc(fid) + '</span>' : '')
      +   '</div>'
      +   '<div class="plug-desc">' + esc(p.brief || '（无描述）') + '</div>'
      +   '<div class="plug-meta">'
      +     (inputs.length ? '<span class="plug-badge">入参 ' + inputs.length + '</span>' : '')
      +     (outputs.length ? '<span class="plug-badge">出参 ' + outputs.length + '</span>' : '')
      +     (p.via ? '<span class="plug-badge">来源 ' + (p.via === 'pack' ? '本地' : p.via === 'market' ? '市场' : esc(p.via)) + '</span>' : '')
      +   '</div>'
      +   '<div class="plug-tools">'
      +     '<button class="plug-mini" type="button" data-act="detail" title="展开标识 / 输入 / 输出 / 保真度 / 状态">详情</button>'
      +     '<button class="plug-mini" type="button" data-act="test" title="调用 plugin.run 跑一次自检">自检</button>'
      +     (p.builtin ? '' : '<button class="plug-mini danger" type="button" data-act="uninstall" title="从控制台移除（拖入的包会同时删本地落盘目录）">卸载</button>')
      +   '</div>'
      +   '<div class="plug-detail">'
      +     '<div class="plug-kv"><b>标识</b><span>' + esc(p.id) + '</span></div>'
      +     '<div class="plug-kv"><b>输入</b><span>' + (inputs.length ? esc(inputs.join(', ')) : '—') + '</span></div>'
      +     '<div class="plug-kv"><b>输出</b><span>' + (outputs.length ? esc(outputs.join(', ')) : '—') + '</span></div>'
      +     '<div class="plug-kv"><b>保真度</b><span>' + (fid || '未声明') + '</span></div>'
      +     '<div class="plug-kv"><b>状态</b><span>' + (isOff ? '面板已停用' : '启用中') + '</span></div>'
      +   '</div>'
      + '</div>'
      + '<div class="plug-actions">'
      +   '<button class="plug-switch' + (isOff ? '' : ' on') + '" type="button" role="switch" aria-checked="' + (!isOff) + '"'
      +     (p.builtin ? ' aria-disabled="true" title="内置插件不可停用"' : ' title="启用 / 停用（面板级）"')
      +     ' data-act="toggle"></button>'
      + '</div>'
      + '</div>';
  }

  async function loadInstalled() {
    var grid = $('#plugGrid');
    var empty = $('#plugEmpty');
    if (tab === 'installed' && grid && !installed.length) {
      grid.innerHTML = skeletonHtml();
      if (empty) empty.hidden = true;
    }
    try {
      var r = await callOps('plugin.list');
      var d = (r && r.data) || {};
      installed = Array.isArray(d.plugins) ? d.plugins : [];
      installedLoaded = true;
      render();
    } catch (e) {
      installed = [];
      installedLoaded = true;
      render();
      setMsg('读取插件列表失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  /* ================= 插件市场视图 ================= */

  async function loadMarket(force) {
    var grid = $('#plugGrid');
    var empty = $('#plugEmpty');
    if (tab === 'market' && grid) {
      grid.innerHTML = skeletonHtml();
      if (empty) empty.hidden = true;
    }
    try {
      var r = await callOps('plugin.market.list', {
        q: query.trim(),
        marketplace: marketFilter,
        limit: MARKET_PAGE,
        refresh: Boolean(force),
      });
      var d = (r && r.data) || {};
      /* 桥是长驻进程：面板换了、桥没重启时新加的动作还不存在。
         这时候要说清「重启控制台」，而不是只说「读取失败」。 */
      if (!d.ok && (r && r.error) === "unknown action") {
        market = { ok: false, root: '', marketplaces: [], items: [], total: 0, allTotal: 0, warnings: [], scannedAt: 0 };
        marketLoaded = true;
        render();
        setMsg('当前桥还不认识 plugin.market.*：重启控制台后可用', 'err');
        return;
      }
      market = {
        ok: Boolean(d.ok),
        root: d.root || '',
        marketplaces: Array.isArray(d.marketplaces) ? d.marketplaces : [],
        items: Array.isArray(d.items) ? d.items : [],
        total: Number(d.total) || 0,
        allTotal: Number(d.allTotal) || 0,
        warnings: Array.isArray(d.warnings) ? d.warnings : [],
        scannedAt: d.scannedAt || 0,
      };
      marketLoaded = true;
      marketAllTotal = market.allTotal || marketAllTotal;
      marketShown = MARKET_PREVIEW;   // 换了关键词/市场：回到收起态的首屏条数
      render();
    } catch (e) {
      market = { ok: false, root: '', marketplaces: [], items: [], total: 0, warnings: [], scannedAt: 0 };
      marketLoaded = true;
      render();
      setMsg('读取插件市场失败：' + (e && e.message ? e.message : e), 'err');
    }
  }

  /* 市场卡片：收起态只有「名称 + 类别」一行，点整行才展开市场 / 版本 / 许可 / 安装键。
     收起态不再放「详情」按钮 —— 整行都是热区，多一枚按钮只是多一个误点目标。 */
  function cardMarket(m, i) {
    var key = m.marketplace + ':' + m.name;
    var canInstall = Boolean(m.hasSource);
    var inst = Boolean(m.installed);
    var meta = [];
    meta.push('<span class="plug-badge accent" title="' + esc(m.marketplaceDesc || m.marketplace) + '">'
      + esc(shortMarket(m.marketplace)) + '</span>');
    if (m.version) meta.push('<span class="plug-badge">v' + esc(m.version) + '</span>');
    if (m.license) meta.push('<span class="plug-badge">' + esc(m.license) + '</span>');
    if (inst) meta.push('<span class="plug-badge ok">已安装</span>');
    if (!canInstall) meta.push('<span class="plug-badge warn">仅远端</span>');

    var action = inst
      ? '<button class="plug-btn" type="button" disabled>已安装</button>'
      : '<button class="plug-btn pri" type="button" data-act="minstall"'
        + (canInstall ? '' : ' disabled title="仅远端来源，控制台不联网拉包"') + '>'
        + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6v11.2"/><path d="m7.4 10.4 4.6 4.6 4.6-4.6"/><path d="M4.4 20.4h15.2"/></svg>安装</button>';

    var open = expanded.has(key);
    return '<div class="plug-card mkt' + (open ? ' open' : '') + '" data-key="' + esc(key)
      + '" data-name="' + esc(m.name) + '" data-mkt="' + esc(m.marketplace) + '"'
      + ' aria-expanded="' + (open ? 'true' : 'false') + '" style="--i:' + i + '">'
      + '<div class="plug-ico">' + ICON.market + '</div>'
      + '<div class="plug-main">'
      +   '<div class="plug-title">' + esc(m.name)
      +     (m.category ? '<span class="plug-badge">' + esc(m.category) + '</span>' : '')
      +   '</div>'
      +   '<div class="plug-desc">' + esc(m.description || '（无描述）') + '</div>'
      +   '<div class="plug-meta">' + meta.join('') + '</div>'
      +   '<div class="plug-detail">'
      +     '<div class="plug-kv"><b>市场</b><span>' + esc(m.marketplace) + '</span></div>'
      +     '<div class="plug-kv"><b>作者</b><span>' + esc(m.author || '—') + '</span></div>'
      +     '<div class="plug-kv"><b>主页</b><span>' + esc(m.homepage || '—') + '</span></div>'
      +     '<div class="plug-kv"><b>来源</b><span>' + (m.hasSource ? '本机目录，可直接安装' : '远端，控制台不代拉') + '</span></div>'
      +   '</div>'
      + '</div>'
      + '<span class="plug-chev" aria-hidden="true">' + ICON.chev + '</span>'
      + '<div class="plug-actions">' + action + '</div>'
      + '</div>';
  }

  /* ================= 渲染 ================= */

  function renderFilters() {
    var box = $('#plugFilters');
    var sel = $('#plugMktSel');
    if (!box) return;

    if (tab === 'installed') {
      if (sel) sel.hidden = true;
      box.hidden = false;
      var b = installed.filter(function (p) { return p.builtin; }).length;
      var c = installed.length - b;
      var chips = [['all', '全部', installed.length], ['builtin', '内置', b], ['custom', '自定义', c]];
      box.innerHTML = chips.map(function (x) {
        return '<button class="plug-chip' + (installedFilter === x[0] ? ' on' : '') + '" type="button" data-f="'
          + x[0] + '">' + x[1] + (installed.length ? ' ' + x[2] : '') + '</button>';
      }).join('');
      return;
    }

    /* 市场视图：不再放「全部市场」胶囊 —— 下拉已经承担了同一个选择，两套并列只会重复 */
    box.hidden = true;
    if (sel) {
      sel.hidden = false;
      var mks = (market && market.marketplaces) || [];
      sel.innerHTML = '<option value="">全部市场（' + (marketAllTotal || 0) + '）</option>'
        + mks.filter(function (m) { return m.count > 0; }).map(function (m) {
          return '<option value="' + esc(m.name) + '"' + (marketFilter === m.name ? ' selected' : '') + '>'
            + esc(shortMarket(m.name)) + '（' + m.count + '）· ' + esc(m.name) + '</option>';
        }).join('');
      if (marketFilter) sel.value = marketFilter;
    }
  }

  function render() {
    var grid = $('#plugGrid');
    var empty = $('#plugEmpty');
    var more = $('#plugMore');
    if (!grid) return;

    var list;
    if (tab === 'installed') {
      list = filteredInstalled();
      grid.innerHTML = list.map(cardInstalled).join('');
      if (more) more.hidden = true;
    } else {
      var all = (market && market.items) || [];
      /* 有搜索词或选了市场 = 用户明确在找东西，命中多少摆多少；
         否则先摆 MARKET_PREVIEW 条，点「显示更多」按批放。 */
      var searching = Boolean(query.trim() || marketFilter);
      list = searching ? all : all.slice(0, marketShown);
      grid.innerHTML = list.map(cardMarket).join('');
      if (more) {
        var extra = searching ? 0 : Math.max(0, all.length - list.length);
        more.hidden = extra <= 0;
        if (extra > 0) {
          more.textContent = '显示更多 · 还有 ' + extra + ' 条（共 ' + all.length + ' 条）';
        }
      }
    }
    if (empty) empty.hidden = list.length > 0;

    var ci = $('#plugCountInstalled');
    var cm = $('#plugCountMarket');
    if (ci) ci.textContent = installedLoaded ? installed.length : '—';
    if (cm) cm.textContent = marketAllTotal ? marketAllTotal : (marketLoaded ? '0' : '—');

    var hint = $('#plugHeadHint');
    if (hint) {
      hint.textContent = tab === 'installed'
        ? '共享插件生态 · 一个注册表吃多生态'
        : (market && market.marketplaces
            ? '收录 ' + market.marketplaces.reduce(function (n, m) { return n + (m.count || 0); }, 0)
              + ' 个 · ' + market.marketplaces.length + ' 个市场'
            : '读取中…');
    }
    var et = $('#plugEmptyText');
    if (et) {
      et.textContent = tab === 'installed'
        ? '还没有匹配的插件。可在下方导入声明，或先清空搜索条件。'
        : '市场里没有匹配的条目。换个关键词，或把筛选切回「全部市场」。';
    }
    var se = $('#plugSearch');
    if (se) {
      se.placeholder = tab === 'installed'
        ? '搜索已安装插件…'
        : '搜索插件市场（' + (marketAllTotal || '…') + ' 个收录）…';
    }
    var rule = $('#plugRule');
    if (rule) {
      rule.innerHTML = tab === 'installed'
        ? '插件执行体为同进程纯 JS，<b>需随控制台构建期内置</b>；从市场安装只登记元信息与路由，危险能力（network / 写盘 / shell）必须显式审批。控制台不会把任意代码注入运行中的进程。'
        : '市场数据来自本机 <b>%USERPROFILE%\\.workbuddy\\plugins</b> 下的市场清单，只读、不联网；「安装」读的是市场里的真实插件目录，<b>照样要过生成物闸门</b>，危险能力需二次确认。';
    }
    renderFilters();
  }

  /* 页签高亮必须跟着 tab 走。
     原来只在 setTab 里切换 .on，而 HTML 把「已安装」写死成 on、启动时又从
     localStorage 把 tab 恢复成 market —— 结果页签亮着「已安装」，列表里却是市场条目。 */
  function syncTabs() {
    $$('#plugTabs .plug-tab').forEach(function (b) {
      b.classList.toggle('on', (b.getAttribute('data-tab') || 'installed') === tab);
    });
  }

  function setTab(next) {
    if (next === tab) return;
    tab = next;
    try { localStorage.setItem(LS_TAB, tab); } catch (e) { /* 忽略 */ }
    syncTabs();
    var se = $('#plugSearch');
    if (se) {
      se.placeholder = tab === 'installed'
        ? '搜索已安装插件…'
        : '搜索插件市场（' + (market ? market.total : '…') + ' 个收录）…';
    }
    if (tab === 'market' && !marketLoaded) loadMarket(false);
    else render();
  }

  /* ================= 从市场安装 ================= */

  async function withBusy(btn, label, fn) {
    if (!btn || btn.classList.contains('busy')) return;
    var old = btn.innerHTML;
    btn.classList.add('busy');
    btn.innerHTML = '<span class="spin"></span>' + esc(label);
    try {
      return await fn();
    } finally {
      btn.classList.remove('busy');
      /* 回调里若把按钮改成了「审批并安装」，收尾不能拿旧文案盖回去 */
      btn.innerHTML = btn.getAttribute('data-approve') === '1' ? APPROVE_HTML : old;
    }
  }

  /* 从闸门/安装结果里提炼一个可读的原因码（artifact-gate:xxx → xxx） */
  function gateCodeOf(d) {
    var first = (d && d.plugins && d.plugins[0]) || {};
    var s = String(first.code || first.error || (d && d.error) || '');
    var m = s.match(/artifact-gate:([a-z-]+)/);
    if (m) return m[1];
    return s || 'unknown';
  }

  /* 一个包可能装出多个插件，也可能"一部分成功、一部分被闸门拒"。
     这里统一收口：成功 / 已存在 / 真失败 三类分开数，
     否则界面会把混合结果笼统说成"已安装"，那是撒谎。 */
  function summarizeInstall(d) {
    var ps = (d && d.plugins) || [];
    var added = [];
    var dup = [];
    var bad = [];
    ps.forEach(function (p) {
      var err = String(p.error || p.code || '');
      if (p.ok) { added.push(p); return; }
      if (err.indexOf('duplicate-id') >= 0) { dup.push(p); return; }
      var m = err.match(/artifact-gate:([a-z-]+)/);
      bad.push({ entry: p, code: (m && m[1]) || err || 'unknown' });
    });
    return { added: added, dup: dup, bad: bad };
  }

  function reportInstall(d, label, approving, btn) {
    var s = summarizeInstall(d);
    if (!s.bad.length) {
      var tail = s.dup.length ? '（' + s.dup.length + ' 个已存在）' : '';
      setMsg('已安装 ' + s.added.length + ' 个 · ' + label + tail, 'ok');
      return 'ok';
    }
    var danger = s.bad.some(function (b) { return b.code === 'dangerous-capability'; });
    if (danger && !approving) {
      if (btn) { btn.setAttribute('data-approve', '1'); btn.innerHTML = APPROVE_HTML; }
      setMsg('需要审批：该插件声明了危险能力，再点一次「审批并安装」放行。', 'err');
      return 'approve';
    }
    if (s.added.length) {
      setMsg('部分安装：' + s.added.length + ' 个成功 · ' + s.bad.length + ' 个未通过（' + s.bad[0].code + '）', 'err');
      return 'partial';
    }
    setMsg('安装未通过：' + s.bad[0].code, 'err');
    return 'fail';
  }

  async function installMarket(name, mkt, btn) {
    var approving = btn && btn.getAttribute('data-approve') === '1';
    await withBusy(btn, approving ? '审批中' : '安装中', async function () {
      var body = { name: name, marketplace: mkt };
      if (approving) body.approvedBy = 'orb-panel:user-explicit';
      var r = await callOps('plugin.market.install', body);
      var d = (r && r.data) || {};
      if (d.error && !d.plugins) { setMsg('安装失败：' + d.error, 'err'); return; }
      var verdict = reportInstall(d, name, approving, btn);
      if (verdict === 'ok' || verdict === 'partial') {
        installedLoaded = false;
        await loadInstalled();
        await loadMarket(false);
      }
    });
  }

  /* ================= 已安装卡片动作 ================= */

  async function runTest(id, btn) {
    await withBusy(btn, '自检中', async function () {
      try {
        var r = await callOps('plugin.run', { id: id, args: {} });
        var d = (r && r.data) || r || {};
        if (d && d.ok) setMsg('自检通过 · ' + id, 'ok');
        else setMsg('自检失败 · ' + id + (d && d.error ? ' · ' + d.error : ''), 'err');
      } catch (e) {
        setMsg('自检异常：' + (e && e.message ? e.message : e), 'err');
      }
    });
  }

  /* 已安装卡片「卸载」：二次确认 + 注销 + 清台账（桥侧顺带删本地落盘目录） */
  async function uninstallPlugin(id, btn) {
    /* 二次确认：第一次点 → 按钮变「确认卸载？」(红)，4 秒内再点才真删；否则复原。
       避免手滑把刚装好的插件整没了。 */
    if (btn.getAttribute('data-armed') !== '1') {
      var prev = btn.innerHTML;
      btn.setAttribute('data-armed', '1');
      btn.classList.add('armed');
      btn.innerHTML = '确认卸载？';
      setMsg('再点一次「确认卸载？」才会真的移除该插件', 'err');
      clearTimeout(btn._armT);
      btn._armT = setTimeout(function () {
        btn.removeAttribute('data-armed');
        btn.classList.remove('armed');
        btn.innerHTML = prev;
      }, 4000);
      return;
    }
    clearTimeout(btn._armT);
    btn.removeAttribute('data-armed');
    await withBusy(btn, '卸载中', async function () {
      try {
        var r = await callOps('plugin.uninstall', { id: id });
        var d = (r && r.data) || {};
        if (d.unregister && d.unregister.error === 'builtin') {
          setMsg('内置插件不可卸载', 'err');
          return;
        }
        setMsg('已卸载 · ' + id + (d.deletedDir ? '（本地包已删除）' : (d.forgot ? '（台账已清除）' : '')), 'ok');
        installedLoaded = false;
        marketLoaded = false;
        await loadInstalled();
        if (tab === 'market') await loadMarket(false);
      } catch (e) {
        setMsg('卸载异常：' + (e && e.message ? e.message : e), 'err');
      }
    });
  }

  /* ================= 导入区：校验 → 安装 ================= */

  function readImport() {
    var ta = $('#plugImport');
    var raw = (ta && ta.value || '').trim();
    if (!raw) { setMsg('请先粘贴插件清单 JSON', 'err'); return null; }
    try { return JSON.parse(raw); }
    catch (e) { setMsg('JSON 解析失败：' + (e && e.message ? e.message : e), 'err'); return null; }
  }

  function setInstallEnabled(on) {
    var b = $('#plugInstall');
    if (!b) return;
    b.disabled = !on;
    if (!on) b.removeAttribute('data-approve');
    b.title = on ? '把校验通过的声明装进注册表' : '先校验通过才能安装';
  }

  async function validateImport() {
    var obj = readImport();
    if (!obj) { setInstallEnabled(false); return; }
    await withBusy($('#plugValidate'), '校验中', async function () {
      try {
        var r = await callOps('plugin.dryrun', { manifest: obj });
        var d = (r && r.data) || {};
        if (d.ok) {
          var n = (d.plugins || []).length;
          var fid = (d.plugins || []).map(function (p) { return p.fidelity; }).filter(Boolean).join(' / ');
          setMsg('校验通过 · 将安装 ' + n + ' 个' + (fid ? '（' + fid + '）' : ''), 'ok');
          setInstallEnabled(true);
        } else {
          setInstallEnabled(false);
          setMsg('未通过：' + gateCodeOf(d) + (d.warnings && d.warnings.length ? ' · ' + d.warnings[0] : ''), 'err');
        }
      } catch (e) {
        setInstallEnabled(false);
        setMsg('校验异常：' + (e && e.message ? e.message : e), 'err');
      }
    });
  }

  async function installImport() {
    var obj = readImport();
    if (!obj) return;
    var btn = $('#plugInstall');
    var approving = btn && btn.getAttribute('data-approve') === '1';
    await withBusy(btn, approving ? '审批中' : '安装中', async function () {
      var body = { manifest: obj };
      if (approving) body.approvedBy = 'orb-panel:user-explicit';
      try {
        var r = await callOps('plugin.install', body);
        var d = (r && r.data) || {};
        if (d.error && !d.plugins) { setMsg('安装失败：' + d.error, 'err'); return; }
        var verdict = reportInstall(d, String(obj.id || obj.name || ''), approving, btn);
        if (verdict === 'ok') { setInstallEnabled(false); installedLoaded = false; await loadInstalled(); }
        else if (verdict === 'partial') { installedLoaded = false; await loadInstalled(); }
      } catch (e) {
        setMsg('安装异常：' + (e && e.message ? e.message : e), 'err');
      }
    });
  }

  /* ================= 插件包：拖拽进来 / 从本机选择 =================
   *
   * 和「粘贴 JSON」走的是同一个后端入口（plugin.pack.inspect / .install），
   * 落盘 → readSource → 摄入 → 真实闸门，面板这一层不做任何判定。
   *
   * 拖拽的坑都在这一层：
   *  - dataTransfer.files 只有一层，目录要递归 webkitGetAsEntry 才拿得到里面的文件；
   *  - 遮罩必须 pointer-events:none，否则它盖住投放区后自己吃 dragleave，遮罩会闪；
   *  - 拖到面板任何地方都会让 Electron 直接导航到那个文件，所以 document 上也要拦。
   */

  var PACK_MAX_BYTES = 24 * 1024 * 1024;   // 与桥侧 PACK_LIMITS.maxTotalBytes 对齐
  var PACK_MAX_FILES = 400;
  var pendingPack = null;                   // 校验通过的包，等用户点「添加到控制台」
  var dragDepth = 0;

  function readB64(file, onprog) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onprogress = function (e) {
        if (onprog && e && e.lengthComputable) onprog(e.loaded, e.total);
      };
      fr.onload = function () {
        var s = String(fr.result || '');
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : '');
      };
      fr.onerror = function () { reject(new Error('读取失败：' + file.name)); };
      fr.readAsDataURL(file);
    });
  }

  /* 目录要一层层读：readEntries 每次只回一批，空数组才算读完 */
  function collectEntry(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (!entry || out.length >= PACK_MAX_FILES) return resolve();
      if (entry.isFile) {
        entry.file(function (f) {
          out.push({ file: f, path: prefix ? prefix + '/' + entry.name : entry.name });
          resolve();
        }, function () { resolve(); });
        return;
      }
      if (!entry.isDirectory) return resolve();
      var next = prefix ? prefix + '/' + entry.name : entry.name;
      var reader = entry.createReader();
      var step = function () {
        reader.readEntries(function (batch) {
          if (!batch || !batch.length) return resolve();
          Promise.all(batch.map(function (e) { return collectEntry(e, next, out); }))
            .then(step, function () { resolve(); });
        }, function () { resolve(); });
      };
      step();
    });
  }

  async function collectFromDataTransfer(dt) {
    var out = [];
    var entries = [];
    /* webkitGetAsEntry 必须在 drop 事件的同步阶段取，取晚了 items 就空了 */
    if (dt.items && dt.items.length) {
      for (var i = 0; i < dt.items.length; i++) {
        if (dt.items[i].kind !== 'file') continue;
        var en = dt.items[i].webkitGetAsEntry ? dt.items[i].webkitGetAsEntry() : null;
        if (en) entries.push(en);
      }
    }
    if (entries.length) {
      for (var j = 0; j < entries.length; j++) await collectEntry(entries[j], '', out);
      return out;
    }
    if (dt.files && dt.files.length) {
      for (var k = 0; k < dt.files.length; k++) out.push({ file: dt.files[k], path: dt.files[k].name });
    }
    return out;
  }

  function filesFromInput(input) {
    var out = [];
    if (!input || !input.files) return out;
    for (var i = 0; i < input.files.length; i++) {
      var f = input.files[i];
      out.push({ file: f, path: f.webkitRelativePath || f.name });
    }
    return out;
  }

  function packLabel(list) {
    if (!list.length) return '插件包';
    if (list.length === 1) return String(list[0].path).split('/').pop();
    var head = String(list[0].path).split('/');
    return head.length > 1 ? head[0] : '插件包';
  }

  /* 读成 base64 再发给桥：Electron 32+ 拿不到 File.path，走字节最稳。
     onprog(read, total, path) 回调给读取进度条用（大包不至于黑屏）。 */
  async function packPayload(list, onprog) {
    if (!list.length) return { error: '没有读到文件' };
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      if (i >= PACK_MAX_FILES) return { error: '文件太多（上限 ' + PACK_MAX_FILES + ' 个）' };
      total += list[i].file.size;
      if (total > PACK_MAX_BYTES) {
        return { error: '包太大（超过 ' + Math.round(PACK_MAX_BYTES / 1048576) + 'MB）' };
      }
    }
    var files = [];
    var read = 0;
    for (var k = 0; k < list.length; k++) {
      var fsize = list[k].file.size;
      try {
        var b64 = await readB64(list[k].file, function (loaded, t) {
          if (onprog) onprog(read + loaded, total, list[k].path);
        });
        files.push({ path: list[k].path, b64: b64 });
        read += fsize;
        if (onprog) onprog(read, total, list[k].path);
      } catch (e) { return { error: String(e && e.message ? e.message : e) }; }
    }
    return { files: files, label: packLabel(list) };
  }

  function setRep(html, shown) {
    var box = $('#plugRep');
    if (!box) return;
    if (!shown) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = html;
    box.hidden = false;
  }

  function repBusy(text) {
    setRep(
      '<div class="plug-rep-head"><span class="plug-rep-name"><span class="spin"></span>' + esc(text) + '</span></div>',
      true
    );
  }

  function fidOf(plugins) {
    var seen = [];
    plugins.forEach(function (p) {
      if (p && p.fidelity && seen.indexOf(p.fidelity) < 0) seen.push(p.fidelity);
    });
    return seen.join(' / ');
  }

  /**
   * 一份报告，两种用途：校验结果（phase=inspect）和安装结果（phase=installed）。
   * 判定一律抄桥侧回的 ok/code，面板不自己算「大概能装」。
   */
  function renderPack(d, label, phase) {
    var plugins = d.plugins || [];
    var s = summarizeInstall(d);
    var danger = s.bad.some(function (b) { return b.code === 'dangerous-capability'; });
    var name = String(d.name || label || '插件包');

    var meta = [];
    if (d.kind) meta.push('类型 ' + d.kind);
    if (d.files) meta.push(d.files + ' 个文件');
    if (d.zipped) meta.push('.zip 包');
    if (plugins.length) meta.push(plugins.length + ' 个能力');
    var warns = (d.warnings || []).filter(Boolean);

    var reason = '';
    var first = s.bad[0] || {};
    var reasons = (first.entry && first.entry.reasons) || [];
    if (danger) reason = reasons.length ? reasons.join(' / ') : 'network / 写盘 / shell';

    var head = '<div class="plug-rep-head"><span class="plug-rep-name">' + esc(name) + '</span>';
    var fid = fidOf(plugins);
    if (fid) head += '<span class="plug-rep-badge">' + esc(fid) + '</span>';
    head += '</div>';
    head += '<div class="plug-rep-meta">' + esc(meta.join(' · ')) + '</div>';

    var msg = '';
    if (d.ok) {
      msg = phase === 'installed'
        ? '已安装 ' + s.added.length + ' 个' + (s.dup.length ? '（' + s.dup.length + ' 个已存在）' : '')
        : '校验通过，可以安装。';
    } else if (danger) {
      msg = '需要审批：这个包要求危险能力（' + reason + '）。';
    } else if (d.error) {
      msg = '读不了这个包：' + d.error;
    } else {
      msg = (phase === 'installed' ? '安装未通过：' : '未通过：') + (first.code || 'gate-denied');
    }
    var body = head + '<div class="plug-rep-msg ' + (d.ok ? 'ok' : 'err') + '">' + esc(msg) + '</div>';
    if (warns.length) {
      body += '<div class="plug-rep-meta">提示：' + esc(warns.slice(0, 3).join('；')) + '</div>';
    }

    var acts = '<div class="plug-rep-row">';
    if (d.ok && phase === 'installed') {
      acts += '<button class="plug-btn pri" type="button" data-rep="view">查看已安装</button>';
    } else if (d.ok || danger) {
      acts += '<button class="plug-btn pri" type="button" data-rep="install"' + (danger ? ' data-approve="1"' : '') + '>'
        + (danger ? APPROVE_HTML : '添加到控制台') + '</button>';
    }
    acts += '<button class="plug-btn" type="button" data-rep="cancel">' + (d.ok && phase === 'installed' ? '关闭' : '取消') + '</button>';
    acts += '</div>';

    setRep(body + acts, true);
  }

  async function inspectPack(list) {
    setRep('<div class="plug-rep-head"><span class="plug-rep-name"><span class="spin"></span>读取中…</span></div>', true);
    var p = await packPayload(list, function (read, total) {
      var pct = total ? Math.round((read / total) * 100) : 0;
      setRep('<div class="plug-rep-head"><span class="plug-rep-name"><span class="spin"></span>读取中 '
        + pct + '% · ' + (read / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB</span></div>', true);
    });
    if (p.error) { setRep('<div class="plug-rep-msg err">' + esc(p.error) + '</div>', true); return; }
    pendingPack = { name: p.label, files: p.files, label: p.label };
    repBusy('正在校验 ' + p.label + ' …');
    try {
      var r = await callOps('plugin.pack.inspect', { name: p.label, files: p.files });
      var d = (r && r.data) || {};
      if (d.error === 'unknown action') {
        setRep('<div class="plug-rep-msg err">当前桥还不认识 plugin.pack.*：重启控制台后可用。</div>', true);
        return;
      }
      renderPack(d, p.label, 'inspect');
    } catch (e) {
      setRep('<div class="plug-rep-msg err">校验异常：' + esc(e && e.message ? e.message : e) + '</div>', true);
    }
  }

  async function installPending(btn) {
    if (!pendingPack) { setRep('<div class="plug-rep-msg err">包已失效，请重新拖入。</div>', true); return; }
    var approving = btn && btn.getAttribute('data-approve') === '1';
    await withBusy(btn, approving ? '审批中' : '安装中', async function () {
      var body = { name: pendingPack.name, files: pendingPack.files };
      if (approving) body.approvedBy = 'orb-panel:user-explicit';
      var d;
      try {
        var r = await callOps('plugin.pack.install', body);
        d = (r && r.data) || {};
      } catch (e) {
        renderPack({ ok: false, error: String(e && e.message ? e.message : e) }, pendingPack.label, 'installed');
        return;
      }
      renderPack(d, pendingPack.label, 'installed');
      if (d.ok) {
        installedLoaded = false;
        marketLoaded = false;
        await loadInstalled();
      } else if (summarizeInstall(d).added.length) {
        installedLoaded = false;
        await loadInstalled();
      }
    });
  }

  function setHot(on) {
    var dz = $('#plugDrop');
    var veil = $('#plugVeil');
    if (dz) dz.classList.toggle('hot', !!on);
    if (veil) veil.classList.toggle('on', !!on);
  }

  function bindPack() {
    var pane = document.querySelector('.setpane[data-pane="plugins"]');
    var dz = $('#plugDrop');
    var fileIn = $('#plugFileInput');
    var dirIn = $('#plugDirInput');

    /* 打开文件/文件夹选择器 */
    function pick(input) { if (input) { input.value = ''; input.click(); } }
    var pf = $('#plugPickFile');
    var pd = $('#plugPickDir');
    if (pf) pf.addEventListener('click', function (e) { e.stopPropagation(); pick(fileIn); });
    if (pd) pd.addEventListener('click', function (e) { e.stopPropagation(); pick(dirIn); });
    if (dz) {
      dz.addEventListener('click', function () { pick(fileIn); });
      dz.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(fileIn); }
      });
    }
    if (fileIn) fileIn.addEventListener('change', function () { inspectPack(filesFromInput(fileIn)); });
    if (dirIn) dirIn.addEventListener('change', function () { inspectPack(filesFromInput(dirIn)); });

    /* 面板级投放：掉在列表上也接，不必精确对准虚线框 */
    if (pane) {
      pane.addEventListener('dragenter', function (e) {
        if (!e.dataTransfer) return;
        e.preventDefault();
        dragDepth++;
        setHot(true);
      });
      pane.addEventListener('dragover', function (e) {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setHot(true);
      });
      pane.addEventListener('dragleave', function (e) {
        /* 移出到子元素也会触发 dragleave，用计数抵消 */
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) setHot(false);
      });
      pane.addEventListener('drop', async function (e) {
        if (!e.dataTransfer) return;
        e.preventDefault();
        e.stopPropagation();
        dragDepth = 0;
        setHot(false);
        var list = await collectFromDataTransfer(e.dataTransfer);
        if (!list.length) { setRep('<div class="plug-rep-msg err">没有拿到文件，试试用「选择文件」。</div>', true); return; }
        await inspectPack(list);
      });
    }

    /* 报告里的动作 */
    var rep = $('#plugRep');
    if (rep) {
      rep.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-rep]') : null;
        if (!b) return;
        var act = b.getAttribute('data-rep');
        if (act === 'cancel') { pendingPack = null; setRep('', false); return; }
        if (act === 'view') { setTab('installed'); return; }
        if (act === 'install') { installPending(b); return; }
      });
    }

    /* 拖到面板任何地方都会让 Electron 直接导航到那个文件 —— 一律拦下。
       只拦"带文件"的拖拽，不影响面板里拖选文字。 */
    ['dragover', 'drop'].forEach(function (t) {
      document.addEventListener(t, function (ev) {
        var dt = ev.dataTransfer;
        if (!dt || !dt.types) return;
        var hasFile = Array.prototype.indexOf.call(dt.types, 'Files') >= 0;
        if (!hasFile) return;
        ev.preventDefault();
        if (t === 'dragover') dt.dropEffect = 'copy';
      }, false);
    });
  }

  /* ================= 绑定 ================= */

  function bindGrid() {
    var grid = $('#plugGrid');
    if (!grid) return;
    grid.addEventListener('click', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.plug-card') : null;
      if (!card) return;
      var hit = ev.target.closest ? ev.target.closest('[data-act]') : null;
      /* 市场卡片：整行都是展开热区（收起态只剩名称 + 类别，没有按钮可点） */
      var mkey = card.getAttribute('data-key');
      if (mkey && (!hit || !card.contains(hit))) {
        if (expanded.has(mkey)) expanded.delete(mkey); else expanded.add(mkey);
        var nowOpen = expanded.has(mkey);
        card.classList.toggle('open', nowOpen);
        card.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
        return;
      }
      if (!hit || !card.contains(hit)) return;
      var act = hit.getAttribute('data-act');

      if (act === 'minstall') {
        installMarket(card.getAttribute('data-name'), card.getAttribute('data-mkt'), hit);
        return;
      }

      var id = card.getAttribute('data-id');
      if (act === 'detail') {
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        card.classList.toggle('open', expanded.has(id));
        return;
      }
      if (act === 'toggle') {
        var p = null;
        for (var i = 0; i < installed.length; i++) { if (installed[i].id === id) { p = installed[i]; break; } }
        if (!p) return;
        if (p.builtin) { setMsg('内置插件不可停用', 'err'); return; }
        var set = disabledSet();
        if (set.has(id)) set.delete(id); else set.add(id);
        saveDisabled(set);
        render();
        return;
      }
      if (act === 'test') { runTest(id, hit); return; }
      if (act === 'uninstall') { uninstallPlugin(id, hit); return; }
    });
  }

  function bind() {
    bindGrid();
    bindPack();

    var tabs = $('#plugTabs');
    if (tabs) {
      tabs.addEventListener('click', function (ev) {
        var b = ev.target.closest ? ev.target.closest('.plug-tab') : null;
        if (b) setTab(b.getAttribute('data-tab') || 'installed');
      });
    }

    var rf = $('#plugRefresh');
    if (rf) {
      rf.addEventListener('click', function () {
        if (tab === 'installed') { installedLoaded = false; loadInstalled(); }
        else { marketLoaded = false; loadMarket(true); }
      });
    }

    var se = $('#plugSearch');
    if (se) {
      se.addEventListener('input', function (e) {
        query = e.target.value || '';
        if (tab === 'installed') { render(); return; }
        clearTimeout(searchTimer);
        searchTimer = setTimeout(function () { loadMarket(false); }, 220);
      });
    }

    var fl = $('#plugFilters');
    if (fl) {
      fl.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('.plug-chip') : null;
        if (!b) return;
        var f = b.getAttribute('data-f') || '';
        if (tab === 'installed') { installedFilter = f || 'all'; render(); }
        else { marketFilter = f; loadMarket(false); }
      });
    }

    var ms = $('#plugMktSel');
    if (ms) {
      ms.addEventListener('change', function () {
        marketFilter = ms.value || '';
        loadMarket(false);
      });
    }

    var pm = $('#plugMore');
    if (pm) {
      pm.addEventListener('click', function () {
        if (pm.hidden) return;
        marketShown += MARKET_STEP;
        render();
      });
    }

    var va = $('#plugValidate');
    if (va) va.addEventListener('click', validateImport);
    var ins = $('#plugInstall');
    if (ins) ins.addEventListener('click', installImport);

    // 切到「插件」页时按需加载（.on 切换由主脚本负责）
    var navBtn = document.querySelector('#setnav .setnav-i[data-pane="plugins"]');
    if (navBtn) navBtn.addEventListener('click', function () { setTimeout(init, 0); });
  }

  function init() {
    syncTabs();                     // 先让页签高亮和恢复出来的 tab 对齐，再拉数据
    if (!installedLoaded) loadInstalled();
    else render();
    if (tab === 'market' && !marketLoaded) loadMarket(false);
  }

  try {
    if (localStorage.getItem(LS_TAB) === 'market') tab = 'market';
  } catch (e) { /* 忽略 */ }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { bind(); init(); });
  } else {
    bind(); init();
  }
})();
