/* ================= 自动化栏目 / 运行历史抽屉 / 治理三卡 =================
 * 2026-11-08：与 panel.html 主脚本分离的第一块独立逻辑。
 *
 * 为什么单独成文件：panel.html 主干还有 1.9 万行 inline script，且 15 个测试文件
 * 以它的文本为契约。新增功能不往里堆，才能单独做语法检查、单独回滚。
 * 这是 classic script（不带 type=module），和主脚本共享全局作用域，
 * 直接复用 post() / api() / renderWfSetList() / askConfirm()，不复制一份实现。
 *
 * 数据全部来自既有账本，不新造字段、不补零、不编数：
 *   /api/wf policy | trash | purge | runs | policy-apply | restore
 *          | versions | version-get | version-diff | version-rollback
 *          | trace | trace-runs | graph-validate | outcome-suggest | outcome-apply
 *          | checkpoint | resume | preflight
 *   /api/triggers mode
 *   /api/stop/report | /api/tickets | /api/tickets/:id | /api/tickets/:id/trail
 *   /api/ops affect.status
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function badge(text, kind) { return el('span', 'auto-badge' + (kind ? ' ' + kind : ''), text); }
  function empty(node, text) { if (node) node.replaceChildren(el('div', 'gov-empty', text)); }
  function kv(k, v) {
    const row = el('div', 'gov-kv');
    row.append(el('span', 'k', k), el('span', 'v', v));
    return row;
  }

  /* 主脚本是 function declaration 顶层声明，classic script 里能直接取到。
     typeof 保护：万一主脚本没就绪（面板被单独打开 / 加载失败），这里只降级不抛。 */
  async function callPost(path, body) {
    try {
      if (typeof post !== 'function') return { ok: false, error: '面板主脚本未就绪' };
      const r = await post(path, body || {});
      return r && typeof r === 'object' ? r : { ok: false, error: '桥返回了空响应' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  async function callGet(path) {
    try {
      if (typeof api !== 'function') return { ok: false, error: '面板主脚本未就绪' };
      const r = await api(path);
      return r && typeof r === 'object' ? r : { ok: false, error: '桥返回了空响应' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  async function callOps(action, extra) {
    const r = await callPost('/api/ops', Object.assign({ action: action }, extra || {}));
    if (!r.ok) return { ok: false, error: r.error || '桥未响应' };
    return { ok: true, data: r.data != null ? r.data : null };
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtTime(ms) {
    const t = Number(ms) || 0;
    if (!t) return '—';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '—';
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtDur(ms) {
    const n = Math.max(0, Number(ms) || 0);
    return n < 1000 ? n + 'ms' : (n / 1000).toFixed(1) + 's';
  }
  function fmtSize(n) {
    const b = Number(n) || 0;
    return b < 1024 ? b + ' B' : (b / 1024).toFixed(1) + ' KB';
  }
  const LAYER = { interval: '定时', file: '文件', hotkey: '热键', manual: '手动', trigger: '触发' };
  const STATUS = {
    ok: '成功', failed: '失败', needs_review: '需复核', skipped: '跳过', interrupted: '中断', running: '进行中',
  };
  /* needs_review 刻意用 warn 而不是 bad：它既不是成功也不是失败，是「没拿到证据」。
     把它涂成红的，用户会当成失败去重试；涂成绿的，等于替系统撒谎说成了。 */
  const STATUS_KIND = {
    ok: 'ok', failed: 'bad', needs_review: 'warn', skipped: 'warn', interrupted: 'bad', running: 'observe',
  };
  const VERDICT = { ok: '判据命中', failed: '判据落空', needs_review: '无证据' };
  const EVIDENCE = { strong: '强证据', weak: '弱证据', none: '无证据' };
  /* 复核结论：只是"人怎么认"，不是系统判定。三档语义见 wfRunLedger.markReviewed。 */
  const REVIEW = { accepted: '接受', rejected: '判为失败', ignored: '不追了' };
  const REASON = {
    postcondition_met: '配方判据命中',
    postcondition_unmet: '配方判据未达',
    evidence_missing: '拿不到观测',
    effect_not_observed: '界面未见变化',
    readonly_readback: '只读回读成功',
    no_spec: '未声明判据（弱证据）',
    self_claim_only: '仅模型自述，不算数',
    unknown_condition: '未知判据',
    approval_missing: '人工节点未批准',
    'play-failed': '回放失败',
  };

  /* 工单状态 → 人话。用户要判断的是"要不要我管"，不是 RANK 里的数字。
     取值对齐 ticketStore.mjs 的 RANK 表；表里没有的原样显示，不编。 */
  const TICKET_STATUS = {
    queued: '排队中', running: '进行中', idle: '空闲', ready: '已完成',
    done: '已完成', failed: '失败', blocked: '卡住', dropped: '已放弃',
    stopped: '已停止', aborted: '已中断',
  };
  /* 只有这两种状态真的需要人动手；其余是"跑着"或"已经有结论"。 */
  const TICKET_NEEDS_YOU = new Set(['failed', 'blocked']);

  /* ------------------------------------------------------------------ *
   * 一、自动化栏目：策略 + 回收站
   * ------------------------------------------------------------------ */

  async function renderPolicy() {
    const box = $('autoPolicyList');
    if (!box) return;
    const r = await callPost('/api/wf', { action: 'policy' });
    if (!r.ok) { empty(box, '读不到升降级判据：' + (r.error || '')); return; }
    const items = Array.isArray(r.items) ? r.items : [];
    const triggers = Array.isArray(r.triggers) ? r.triggers : [];
    box.replaceChildren();
    if (!items.length && !triggers.length) {
      empty(box, '还没有自动化或触发器。先录一条，或在编辑器里给它加触发器。');
      return;
    }
    for (const t of triggers) {
      const row = el('div', 'auto-row');
      const mode = t.mode === 'auto' ? 'auto' : 'observe';
      row.append(
        el('span', 'nm', t.workflow || '(未绑定)'),
        badge(mode === 'auto' ? '执行' : '观察', mode === 'auto' ? 'ok' : 'observe'),
        badge(t.locked ? '人工锁定' : '自动判据', ''),
        badge(t.enabled === false ? '已停用' : '已启用', t.enabled === false ? 'warn' : ''),
        el('span', 'spacer'),
      );
      const other = mode === 'auto' ? 'observe' : 'auto';
      const sw = el('button', 'chip', other === 'auto' ? '设为执行' : '设为观察');
      sw.type = 'button';
      sw.title = '人工设定后系统会锁住这个决定，不再自动升降级';
      sw.addEventListener('click', async () => {
        sw.disabled = true;
        const q = await callPost('/api/triggers', { action: 'mode', id: t.id, mode: other, locked: true });
        const msg = $('autoPolicyMsg');
        if (msg) msg.textContent = q.ok
          ? '已设为「' + (other === 'auto' ? '执行' : '观察') + '」并锁定'
          : '设置失败：' + (q.error || '');
        await renderPolicy();
      });
      row.append(sw);
      box.append(row);
    }
    for (const p of items) {
      const m = p.metrics || {};
      const row = el('div', 'auto-row');
      row.append(
        el('span', 'nm', p.name || '(无名)'),
        badge(p.recommendation === 'auto' ? '建议执行' : '建议观察',
          p.recommendation === 'auto' ? 'ok' : 'observe'),
        el('span', 'meta', '样本 ' + (m.samples || 0) + ' · 成功 ' + (m.ok || 0) + ' · 失败 ' + (m.failed || 0)),
      );
      if (p.degraded) row.append(badge('连续失败 ' + (p.failStreak || 0), 'bad'));
      row.append(el('span', 'why', p.reason || '暂无理由'));
      box.append(row);
    }
    const msg = $('autoPolicyMsg');
    if (msg) msg.textContent = triggers.length + ' 条触发器 · ' + items.length + ' 条自动化';
  }

  async function renderTrash() {
    const box = $('autoTrashList');
    if (!box) return;
    const r = await callPost('/api/wf', { action: 'trash' });
    if (!r.ok) { empty(box, '读不到回收站：' + (r.error || '')); return; }
    const items = Array.isArray(r.items) ? r.items : [];
    box.replaceChildren();
    if (!items.length) { empty(box, '回收站是空的。删除自动化后可以在这里恢复。'); return; }
    for (const it of items) {
      const row = el('div', 'auto-row');
      row.append(
        el('span', 'nm', it.damaged ? '损坏条目 · ' + (it.trashId || '') : (it.name || '(无名)')),
        badge(it.damaged ? '需人工处理' : (it.steps || 0) + ' 步', it.damaged ? 'bad' : ''),
        el('span', 'meta', fmtTime(it.deletedAt) + ' · ' + fmtSize(it.size)),
        el('span', 'spacer'),
      );
      const b = el('button', 'chip', '恢复');
      b.type = 'button';
      b.disabled = !!it.damaged;
      b.title = it.damaged ? '文件已损坏，桥拒绝恢复（不会悄悄盖掉现有内容）' : '把这条自动化放回列表';
      b.addEventListener('click', async () => {
        b.disabled = true;
        const q = await callPost('/api/wf', { action: 'restore', trashId: it.trashId });
        const msg = $('autoTrashMsg');
        if (msg) {
          msg.textContent = q.ok
            ? '已恢复「' + (q.name || it.name || '') + '」' +
              (q.enabledTriggers ? '，同时重新启用 ' + q.enabledTriggers + ' 条触发器' : '')
            : '恢复失败：' + (q.error || '');
        }
        await Promise.allSettled([renderTrash(), renderPolicy()]);
        if (typeof renderWfSetList === 'function') await renderWfSetList();
      });
      row.append(b);
      box.append(row);
    }
    const msg = $('autoTrashMsg');
    if (msg) msg.textContent = '共 ' + items.length + ' 条（保留 30 天 / 上限 200 条）';
  }

  async function refreshAutoPane() {
    await Promise.allSettled([
      typeof renderWfSetList === 'function' ? renderWfSetList() : Promise.resolve(),
      renderPolicy(),
      renderTrash(),
      refreshRunSummary(),
    ]);
  }
  window.autoPaneRefresh = refreshAutoPane;

  /* ------------------------------------------------------------------ *
   * 二、运行历史抽屉
   * ------------------------------------------------------------------ */

  let RUNS = [];
  let RUN_STATS = {};

  function fillRunWfFilter() {
    const sel = $('autoRunsFilterWf');
    if (!sel) return;
    const cur = sel.value;
    const names = [...new Set(RUNS.map((r) => String(r.workflow || '')).filter(Boolean))].sort();
    sel.replaceChildren(new Option('全部自动化', ''));
    for (const n of names) sel.add(new Option(n, n));
    sel.value = names.includes(cur) ? cur : '';
  }

  function renderRuns() {
    const box = $('autoRunsList');
    if (!box) return;
    const fw = ($('autoRunsFilterWf') || {}).value || '';
    const fl = ($('autoRunsFilterLayer') || {}).value || '';
    const fs = ($('autoRunsFilterStatus') || {}).value || '';
    const fr = ($('autoRunsFilterReview') || {}).value || '';
    const rows = RUNS.filter((r) => r && (!fw || r.workflow === fw) &&
      (!fl || r.layer === fl) && (!fs || r.status === fs) &&
      (!fr || (fr === 'reviewed' ? !!r.reviewedAt : (r.status === 'needs_review' && !r.reviewedAt))));
    const s = RUN_STATS || {};
    const stats = $('autoRunsStats');
    if (stats) {
      const by = s.byStatus || {};
      const parts = ['共 ' + (s.total || RUNS.length) + ' 次', '进行中 ' + (s.running || 0)];
      for (const k of ['ok', 'failed', 'needs_review', 'skipped', 'interrupted']) {
        if (by[k]) parts.push((STATUS[k] || k) + ' ' + by[k]);
      }
      /* 待复核条数单独说一句：这是"要不要人看一眼"的唯一提示。 */
      if (s.pendingReview) parts.push('待复核 ' + s.pendingReview);
      stats.textContent = parts.join(' · ') + '（当前筛出 ' + rows.length + ' 条）';
    }
    box.replaceChildren();
    if (!rows.length) { empty(box, '这个筛选条件下没有运行记录。'); return; }
    for (const r of rows) {
      const card = el('div', 'auto-run');
      const hd = el('div', 'auto-run-hd');
      hd.append(
        el('span', 'nm', r.workflow || '(未绑定)'),
        badge(STATUS[r.status] || r.status || '未知', STATUS_KIND[r.status] || ''),
        badge(LAYER[r.layer] || r.layer || '未知层', ''),
        el('span', 'meta', fmtTime(r.startedAt)),
      );
      /* verdict 是独立判定的结论，status 是它的落地形态。两个都显示：
         出现「status=ok 但 verdict 缺失」时，一眼就能看出这条运行来自老账本。 */
      if (r.verdict) {
        hd.append(badge(VERDICT[r.verdict] || r.verdict,
          r.verdict === 'ok' ? 'ok' : (r.verdict === 'failed' ? 'bad' : 'warn')));
        if (r.evidenceLevel) hd.append(badge(EVIDENCE[r.evidenceLevel] || r.evidenceLevel, ''));
      }
      /* 复核是「人看过」的痕迹，刻意与判定并列显示而不是替换它 ——
         判定说"系统没拿到证据"，复核说"人看过了"，两件事不能互相抵消。 */
      if (r.reviewedAt) {
        hd.append(badge('已复核 · ' + (REVIEW[r.reviewVerdict] || r.reviewVerdict || '—'), 'ok'));
      }
      card.append(hd);
      const dur = Math.max(0, (Number(r.endedAt) || 0) - (Number(r.startedAt) || 0));
      card.append(el('div', 'auto-run-meta',
        'runId ' + (r.runId || '—') + ' · ' + (r.steps || 0) + ' 步 · 耗时 ' +
        (r.status === 'running' ? '进行中' : fmtDur(dur)) +
        (r.triggerId ? ' · 触发器 ' + r.triggerId : '') +
        (r.ticketId ? ' · 工单 ' + r.ticketId : '') +
        (r.eventId ? ' · 事件 ' + r.eventId : '')));
      if (r.reasonCode) {
        card.append(el('div', 'auto-run-meta',
          '跳过/中断原因：' + (REASON[r.reasonCode] || r.reasonCode) + '（' + r.reasonCode + '）' +
          (r.epoch ? ' · epoch ' + r.epoch : '')));
      }
      const q = el('div', 'auto-run-q');
      const flags = [
        ['takeovers', '接管'], ['anchorFallbacks', '锚定失守'],
        ['verifyFailed', '效果验证未过'], ['skippedRead', '跳过读屏'], ['retries', '重试'],
      ];
      for (const [k, label] of flags) {
        if (Number(r[k]) > 0) q.append(badge(label + ' ' + r[k], (k === 'takeovers' || k === 'retries') ? 'warn' : 'bad'));
      }
      if (r.finishedEarly) q.append(badge('判定提前收工', 'ok'));
      if (r.escalate && r.escalate !== 'off') q.append(badge('升级档 ' + r.escalate, ''));
      if (q.childNodes.length) card.append(q);
      if (r.error) card.append(el('div', 'err', r.error));
      /* 步级轨迹：默认收起，点开才拉。一条运行一个 jsonl，按 runId 直读，
         不扫目录、不拖慢列表 —— 运行级账本只说「跑挂了」，这里才说「断在哪一步」。 */
      if (r.runId && r.status !== 'running') {
        const btn = el('button', 'chip', '看步级轨迹');
        btn.type = 'button';
        const pane = el('div', 'auto-trace');
        pane.hidden = true;
        let loaded = false;
        btn.addEventListener('click', async () => {
          pane.hidden = !pane.hidden;
          if (pane.hidden || loaded) return;
          loaded = true;
          pane.replaceChildren(el('div', 'gov-empty', '读取中…'));
          const t = await callPost('/api/wf', { action: 'trace', runId: r.runId, limit: 500 });
          renderTrace(pane, t);
        });
        card.append(btn, pane);
      }
      /* 「需复核」的出路：不能只告诉用户没证据，得给他补证据的入口。 */
      attachOutcomeSuggest(card, r);
      /* 失败 / 需复核的另一条出路：从断点接着跑。 */
      attachResume(card, r);
      /* 需复核的最后一步闭环：谁看过、看完怎么认。 */
      attachReview(card, r);
      box.append(card);
    }
  }

  /** 步级轨迹渲染。只读账本里已有的字段，不补零、不编数。 */
  function renderTrace(pane, t) {
    if (!t || !t.ok) { pane.replaceChildren(el('div', 'err', '读不到轨迹：' + ((t && t.error) || ''))); return; }
    const rows = Array.isArray(t.entries) ? t.entries : [];
    if (!rows.length) {
      pane.replaceChildren(el('div', 'gov-empty', '这次运行没有步级轨迹（老账本，或已按 TTL 清理）。'));
      return;
    }
    pane.replaceChildren();
    for (const e of rows) {
      const line = el('div', 'auto-trace-line');
      if (e.t === 'begin') {
        line.append(el('span', 'k', '开始'),
          el('span', 'v', (e.workflow || '') + ' · ' + (e.mode === 'graph' ? '编排图' : '线性') +
            ' · 步骤 ' + (e.steps != null ? e.steps : '—')));
      } else if (e.t === 'end') {
        const why = REASON[e.reasonCode] || e.reasonCode || '';
        line.append(el('span', 'k', '结束'),
          el('span', 'v', [STATUS[e.status] || e.status || '', why, e.error].filter(Boolean).join(' · ')));
      } else {
        /* 子流程的步也写进同一条轨迹（打 nested + node 标记）。
           不标源的话，父层只看得到「子流程 X 失败」，看不到它内部第几步挂的。 */
        const base = e.n != null ? '第 ' + e.n + ' 步' : (e.node || '节点');
        line.append(el('span', 'k', (e.nested && e.node && e.n != null) ? e.node + ' · ' + base : base),
          badge(e.tool || e.kind || '—', e.ok === false ? 'bad' : 'ok'));
        const bits = [];
        if (e.conf) bits.push('锚定 ' + e.conf);
        if (Number(e.attempt) > 1) bits.push('第 ' + e.attempt + ' 次尝试');
        if (e.retryIn) bits.push('退避 ' + e.retryIn + 'ms');
        if (e.code) bits.push(e.code);
        if (e.skipped) bits.push('跳过');
        if (e.bypassed) bits.push('绕过批准');
        if (e.blocked) bits.push('待批准');
        if (e.message) bits.push(String(e.message).slice(0, 140));
        if (bits.length) line.append(el('span', 'v', bits.join(' · ')));
      }
      pane.append(line);
    }
  }

  /* ------------------------------------------------------------------ *
   * 判据建议：需复核的运行旁边给一条出路
   *
   * 只播报「需复核」而不给动作，等于把问题丢回给用户：他既不知道该补什么，
   * 也看不出补了有什么好处。这里把配方里已有的信息（窗口标题、产物路径）
   * 直接翻译成可用的判据候选，勾一下就能写进去。
   * ------------------------------------------------------------------ */
  const CONF_LABEL = { high: '高', medium: '中', low: '低' };

  /** 把判据对象说成人话。面板上直接摆 JSON 没人愿意看。 */
  function describePc(pc) {
    const k = String((pc && pc.kind) || '');
    if (k === 'window_state') return '窗口标题含「' + String(pc.titleIncludes || '') + '」';
    if (k === 'data_readback') return '文件存在且非空：' + String(pc.path || '') + (pc.minBytes > 1 ? '（≥' + pc.minBytes + ' 字节）' : '');
    if (k === 'tree_state') return pc.text ? '界面上出现「' + String(pc.text) + '」' : '控件树非空';
    if (k === 'effect_evidence') return '界面确实发生了变化';
    return k;
  }

  function renderSuggest(pane, run, s, ev) {
    if (!s || !s.ok) {
      pane.replaceChildren(el('div', 'err', '读不到建议：' + ((s && s.error) || '')));
      return;
    }
    const list = Array.isArray(s.candidates) ? s.candidates : [];
    const evLines = (ev && ev.ok && Array.isArray(ev.lines)) ? ev.lines : [];
    if (!list.length && !evLines.length) {
      pane.replaceChildren(el('div', 'gov-empty',
        (s.notes || []).join('；') || '没有可归纳的判据。'));
      if (ev && !ev.ok && ev.error) pane.append(el('div', 'gov-empty', '界面证据：' + ev.error));
      return;
    }
    pane.replaceChildren();
    for (const n of s.notes || []) pane.append(el('div', 'gov-empty', n));

    const chosen = [];
    for (const c of list) {
      const row = el('div', 'auto-trace-line');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;                       // 默认全选：建议本身就是"我推的"，用户只需否决不合适的
      cb.setAttribute('aria-label', describePc(c.postcondition));
      chosen.push({ cb, pc: c.postcondition });
      row.append(cb, el('span', 'v',
        '[' + (CONF_LABEL[c.confidence] || c.confidence) + '] ' + describePc(c.postcondition) + ' — ' + c.why));
      pane.append(row);
    }

    /* tree_state 候选：这次运行前后控件树新增了哪些行。
       与上面那批的性质不同 —— 上面是**静态推导**（配方里本来就写着窗口标题 / 产物路径），
       这里是**实测证据**（跑完确实多出了这行字）。所以默认**不勾**：
       机器只回答"多出了这些行"，哪一行才算"成功提示"只有人知道。
       硬替用户猜，猜错就会把每次运行都判成失败。 */
    if (evLines.length) {
      pane.append(el('div', 'gov-empty',
        '这次运行后界面上新出现了这些行（' + (evLines.length) + ' 条）。勾一条会写成'
        + '「界面上出现这段字」的判据 —— 默认不勾，因为哪行算成功提示只有你知道。'));
      for (const l of evLines) {
        const row = el('div', 'auto-trace-line');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = false;
        const pc = { kind: 'tree_state', text: l.text };
        cb.setAttribute('aria-label', describePc(pc));
        chosen.push({ cb, pc });
        row.append(cb, el('span', 'v', describePc(pc)));
        pane.append(row);
      }
    } else if (ev && ev.ok === false && ev.error) {
      pane.append(el('div', 'gov-empty', '界面证据：' + ev.error));
    } else if (ev && ev.ok && !evLines.length) {
      pane.append(el('div', 'gov-empty',
        '这次运行前后控件树没有新增行（' + (ev.reason || '可能界面没变，或该应用不暴露控件树') + '），'
        + '所以没有「界面上出现某段字」的候选。'));
    }

    const apply = el('button', 'chip', '写入配方');
    apply.type = 'button';
    const msg = el('div', 'gov-empty', '');
    apply.addEventListener('click', async () => {
      const pcs = chosen.filter((x) => x.cb.checked).map((x) => x.pc);
      if (!pcs.length) { msg.textContent = '至少选一条。'; return; }
      apply.disabled = true;
      msg.textContent = '写入中…';
      const q = await callPost('/api/wf', { action: 'outcome-apply', name: run.workflow, postconditions: pcs });
      if (!q.ok) {
        apply.disabled = false;
        msg.textContent = '写入失败：' + (q.error || '');
        return;
      }
      /* 写前已自动留版本，所以这里敢说"能回滚" —— 不是客套话。 */
      msg.textContent = '已写入 ' + q.postconditions.length + ' 条判据。下次回放起按判据判定；'
        + '写入前已自动留版本，可在「历史版本」里回滚。点右上「刷新」看新结果。';
      apply.disabled = true;
    });
    pane.append(apply, msg);
  }

  /* ------------------------------------------------------------------ *
   * 断点续跑：失败 / 需复核的另一条出路
   *
   * 刻意做成两步：先查断点，把「从第几步继续」或「为什么不能续」摆出来，
   * 再让人点确认。续跑不是"重试" —— 它靠跳过前面已完成的步来避免重复副作用，
   * 而"已完成"的依据是执行收据。依据不成立时这里只解释、绝不放行，
   * 更不能悄悄退化成"从头跑一遍"：那等于把不可逆动作做第二次。
   * ------------------------------------------------------------------ */
  const RESUME_CODE = {
    no_workflow: '读不到这条自动化',
    no_checkpoint: '没有可用的断点（上次没跑到一半，或断点已过期被清）',
    has_control_flow: '含循环 / 分支：中断点可能落在循环体内部，从顶层步续跑会把整段重跑',
    graph_recipe: '编排图配方不支持续跑（节点内会重复执行同一段）',
    recipe_changed: '配方改过了（步数对不上），旧断点位置已不可信',
    index_zero: '断点停在第 0 步，等于从头跑，不叫续跑',
    index_out_of_range: '断点已在末尾，没有剩余步骤',
    stale: '断点已过期，界面状态多半早就变了',
    state_unconfirmed: '断点前那一步没有已结算的执行收据，无法确认它真做完了 —— 重做可能重复提交',
  };

  function attachResume(card, run) {
    if (!run || !run.workflow) return;
    /* 只在失败 / 需复核上给：成功了不需要续，跳过 / 中断的没跑起来也无从续。 */
    if (run.status !== 'failed' && run.status !== 'needs_review') return;
    const btn = el('button', 'chip', '从断点续跑');
    btn.type = 'button';
    btn.title = '跳过上次已经确认做完的步骤，从断掉的下一步接着跑';
    const pane = el('div', 'auto-trace');
    pane.hidden = true;
    let loaded = false;

    btn.addEventListener('click', async () => {
      pane.hidden = !pane.hidden;
      if (pane.hidden || loaded) return;
      loaded = true;
      pane.replaceChildren(el('div', 'gov-empty', '查断点…'));
      const st = await callPost('/api/wf', { action: 'checkpoint', name: run.workflow });
      pane.replaceChildren();
      if (!st || !st.ok) {
        pane.append(el('div', 'err', '查不到断点：' + ((st && (st.error || st.reason)) || '未知原因')));
        return;
      }
      if (!st.resumable) {
        /* 不能续就把原因说清楚。最怕的是"点了没反应" —— 用户会以为按钮坏了，
           然后手动把整条配方从头点一遍，正是这个功能要避免的事。 */
        pane.append(el('div', 'gov-empty',
          (RESUME_CODE[st.code] || st.reason || '当前不能从断点续跑') +
          (st.code ? '（' + st.code + '）' : '')));
        return;
      }
      const done = Number((st.checkpoint || {}).nextIndex) || 0;
      pane.append(el('div', 'gov-empty',
        '上次跑到第 ' + done + ' 步（共 ' + (st.total || 0) + ' 步）断掉。' +
        '续跑会跳过前 ' + done + ' 步，只跑剩下的 ' + Math.max(0, (st.total || 0) - done) + ' 步。'));
      const go = el('button', 'chip', '确认从第 ' + (done + 1) + ' 步继续');
      go.type = 'button';
      go.addEventListener('click', async () => {
        go.disabled = true;
        go.textContent = '续跑中…';
        const r = await callPost('/api/wf', { action: 'resume', name: run.workflow });
        if (!r || !r.ok) {
          go.disabled = false;
          go.textContent = '再试一次';
          pane.append(el('div', 'err',
            '续跑没成功：' + ((r && (r.error || (r.result && r.result.error))) || '未知原因')));
          return;
        }
        pane.append(el('div', 'gov-empty',
          '已从第 ' + ((Number(r.resumedFrom) || 0) + 1) + ' 步跑完，新记录在列表里。'));
        loadRuns();
      });
      pane.append(go);
    });
    card.append(btn, pane);
  }

  /* ------------------------------------------------------------------ *
   * 复核闭环：needs_review 的最后一步
   *
   * 之前只播报「需复核」，没有"谁看过、看完怎么认"的记录 —— 用户看到一屏
   * 黄标，既不知道哪些已经处理过，也不知道还剩几条。这里补的是那个闭环。
   *
   * 一条刻意守住的线：**复核不改判**。点了「接受」，verdict 仍然是
   * needs_review。因为判定说的是"系统没拿到足够证据"，而"人看过了觉得没问题"
   * 是一句人的判断 —— 拿它覆盖 verdict，autoPolicy 就会把主观结论当零退化样本，
   * 正好绕回这轮改造一开始要拆掉的循环。
   * ------------------------------------------------------------------ */
  function attachReview(card, run) {
    if (!run || run.status !== 'needs_review' || !run.runId) return;
    if (run.reviewedAt) {
      const pane = el('div', 'auto-trace');
      pane.hidden = true;
      const btn = el('button', 'chip', '复核记录');
      btn.type = 'button';
      btn.addEventListener('click', () => { pane.hidden = !pane.hidden; });
      pane.append(el('div', 'gov-empty',
        fmtTime(run.reviewedAt) + ' · ' + (run.reviewedBy || '—') + ' · ' +
        (REVIEW[run.reviewVerdict] || run.reviewVerdict || '—') +
        (run.reviewNote ? ' · ' + run.reviewNote : '') +
        '（判定仍是「需复核」，复核不会改写系统判定）'));
      const undo = el('button', 'chip', '撤销复核');
      undo.type = 'button';
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        const r = await callPost('/api/wf', { action: 'unreview', runId: run.runId });
        if (!r || !r.ok) { undo.disabled = false; pane.append(el('div', 'err', (r && r.error) || '撤销失败')); return; }
        loadRuns();
      });
      pane.append(undo);
      card.append(btn, pane);
      return;
    }

    const btn = el('button', 'chip', '标记已复核');
    btn.type = 'button';
    btn.title = '记下「这次我看过了」—— 只留复核痕迹，不改判定';
    const pane = el('div', 'auto-trace');
    pane.hidden = true;
    let built = false;
    btn.addEventListener('click', () => {
      pane.hidden = !pane.hidden;
      if (pane.hidden || built) return;
      built = true;
      const pick = el('div', 'auto-run-q');
      let choice = 'accepted';
      for (const [k, label] of Object.entries(REVIEW)) {
        const b = el('button', 'chip' + (k === 'accepted' ? ' sel' : ''), label);
        b.type = 'button';
        b.dataset.v = k;
        b.addEventListener('click', () => {
          choice = k;
          for (const x of pick.querySelectorAll('button')) x.classList.toggle('sel', x.dataset.v === k);
        });
        pick.append(b);
      }
      const note = el('input', 'auto-inp');
      note.type = 'text';
      note.placeholder = '备注（可留空）：比如「导出窗口正常，判据没写而已」';
      note.maxLength = 300;
      const go = el('button', 'chip', '记下复核');
      go.type = 'button';
      go.addEventListener('click', async () => {
        go.disabled = true;
        const r = await callPost('/api/wf', {
          action: 'review', runId: run.runId, reviewVerdict: choice, note: note.value || '',
        });
        if (!r || !r.ok) {
          go.disabled = false;
          pane.append(el('div', 'err', '记录失败：' + ((r && r.error) || '未知原因')));
          return;
        }
        loadRuns();
      });
      pane.append(
        el('div', 'gov-empty', '看完之后怎么认？（不会改变判定，只留下复核痕迹）'),
        pick, note, go);
    });
    card.append(btn, pane);
  }

  /** 需复核的运行才给这个入口：成功了不需要补判据，失败了也不该靠判据掩盖。 */
  function attachOutcomeSuggest(card, run) {
    if (!run || run.verdict !== 'needs_review' || !run.workflow) return;
    const btn = el('button', 'chip', '建议判据');
    btn.type = 'button';
    btn.title = '从配方里已有的窗口/产物信息推导 outcome 判据，让下次运行不再"需复核"';
    const pane = el('div', 'auto-trace');
    pane.hidden = true;
    let loaded = false;
    btn.addEventListener('click', async () => {
      pane.hidden = !pane.hidden;
      if (pane.hidden || loaded) return;
      loaded = true;
      pane.replaceChildren(el('div', 'gov-empty', '分析配方…'));
      /* 两条来源并行取：静态推导（配方里的窗口/路径）+ 实测证据（这次运行后新增的行）。 */
      const [s, ev] = await Promise.all([
        callPost('/api/wf', { action: 'outcome-suggest', name: run.workflow }),
        callPost('/api/wf', { action: 'outcome-evidence', name: run.workflow, runId: run.runId || '' }),
      ]);
      renderSuggest(pane, run, s, ev);
    });
    card.append(btn, pane);
  }

  async function loadRuns() {
    const r = await callPost('/api/wf', { action: 'runs', limit: 200 });
    if (!r.ok) {
      const box = $('autoRunsList');
      empty(box, '读不到运行账本：' + (r.error || ''));
      return;
    }
    RUNS = Array.isArray(r.runs) ? r.runs : [];
    RUN_STATS = r.stats && typeof r.stats === 'object' ? r.stats : {};
    fillRunWfFilter();
    renderRuns();
  }

  function openRuns() {
    const mask = $('autoRunsMask');
    if (!mask) return;
    mask.classList.add('on');
    mask.setAttribute('aria-hidden', 'false');
    loadRuns().catch(() => {});
  }
  function closeRuns() {
    const mask = $('autoRunsMask');
    if (!mask) return;
    mask.classList.remove('on');
    mask.setAttribute('aria-hidden', 'true');
  }
  window.autoOpenRuns = openRuns;

  /* 「运行历史」那一栏的一句话摘要，外加「待复核 N」角标。
     数字全部来自账本，读不到就明说读不到 —— 不补零、不猜（编一个数字比空着更坏）。
     点角标会把抽屉筛选切到「待复核」再打开：只给数字、点进去还是全部历史，等于白点。 */
  async function refreshRunSummary() {
    const badge = $('autoPendBadge');
    const line = $('autoRunsSummary');
    const recent = $('autoRunsRecent');
    const r = await callPost('/api/wf', { action: 'runs', limit: 6 });
    if (!r || !r.ok) {
      if (line) line.textContent = '读不到运行账本：' + ((r && r.error) || '未知原因');
      if (badge) badge.hidden = true;
      if (recent) { recent.replaceChildren(); }
      return;
    }
    const st = r.stats && typeof r.stats === 'object' ? r.stats : {};
    const n = Number(st.pendingReview) || 0;
    if (badge) { badge.textContent = '待复核 ' + n; badge.hidden = n <= 0; }
    /* 最近几次运行：一行一条（时间 · 名称 · 状态），窗口默认露 2 条，其余靠滑条。
       这里只回答"刚才跑成什么样"；步级轨迹 / 复核 / 续跑都在抽屉里，不在这里铺。 */
    if (recent) {
      recent.replaceChildren();
      const runs = Array.isArray(r.runs) ? r.runs : [];
      if (!runs.length) recent.append(el('div', 'gov-empty', '还没有运行记录。'));
      for (const run of runs) {
        const row = el('div', 'auto-row run-mini');
        row.append(
          el('span', 'meta', fmtTime(run.startedAt)),
          el('span', 'nm', run.workflow || '(未绑定)'),
          badge(STATUS[run.status] || run.status || '未知', STATUS_KIND[run.status] || ''),
        );
        if (run.status === 'needs_review' && !run.reviewedAt) row.append(badge('待复核', 'warn'));
        row.title = '点开运行历史抽屉看这条的明细';
        row.addEventListener('click', openRuns);
        recent.append(row);
      }
    }
    if (!line) return;
    const last = (Array.isArray(r.runs) && r.runs[0]) || null;
    const by = st.byStatus || {};
    const parts = ['共 ' + (Number(st.total) || 0) + ' 次运行'];
    if (Number(by.ok)) parts.push('成功 ' + Number(by.ok));
    if (Number(by.failed)) parts.push('失败 ' + Number(by.failed));
    if (n) parts.push('待复核 ' + n);
    parts.push(last
      ? ('最近 ' + fmtTime(last.startedAt) + ' · ' + (last.workflow || '未命名') + ' · ' + (STATUS[last.status] || last.status || '未知'))
      : '还没有运行记录');
    line.textContent = parts.join(' · ');
  }
  window.refreshAutoPaneSummary = refreshRunSummary;

  /* ------------------------------------------------------------------ *
   * 三、非自动化侧：急停收场清单 / 工单监督 / 静默状态卡
   * ------------------------------------------------------------------ */

  async function renderStopReport() {
    const box = $('stopReportBody');
    if (!box) return;
    const r = await callGet('/api/stop/report');
    if (!r.ok) { empty(box, '读不到急停收场报告：' + (r.error || '')); return; }
    const st = r.stop || {};
    const last = r.last || null;
    const affected = Array.isArray(r.affected) ? r.affected : [];
    const resumable = Array.isArray(r.resumable) ? r.resumable : [];
    box.replaceChildren();
    box.append(kv('当前状态', st.on ? '急停中 · 所有自动化已被拦下' : '正常'),
      kv('最近一次', last ? fmtTime(last.at) + '（' + (last.reason || '未写原因') + '）' : '还没有急停记录'),
      kv('epoch', st.epoch != null ? st.epoch : '—'));
    const metrics = el('div', 'gov-metrics');
    metrics.append(
      badge('杀进程 ' + (last ? last.killed || 0 : 0), ''),
      badge('断 MCP ' + (last ? last.mcpCut || 0 : 0), ''),
      badge('作废工单 ' + (last ? last.staled || 0 : 0), ''),
      badge('丢弃排队 ' + (last ? last.dropped || 0 : 0), ''),
      badge('未收口 ' + (r.openTickets || 0), r.openTickets ? 'warn' : ''),
    );
    box.append(metrics);
    /* 受影响工单只列最近两条：这块是"知道你被牵连了什么"，不是完整台账 ——
       要看全量去工单页。列六条会把三张治理卡撑得比自动化列表还高。 */
    if (affected.length) {
      box.append(el('div', 'gov-sub', '受影响的工单（最近 ' + Math.min(2, affected.length) +
        ' 条，共 ' + affected.length + ' 条）：'));
      for (const t of affected.slice(0, 2)) {
        box.append(el('div', 'gov-line', '· ' + (t.title || t.id) + ' · ' + (t.status || '') +
          (t.stale ? ' · 已判陈旧' : '') + (t.reason ? ' · ' + t.reason : '')));
      }
    }
    if (resumable.length) {
      box.append(el('div', 'gov-sub', '可续跑候选（前 3 条，共 ' + resumable.length + ' 条）：'));
      for (const t of resumable.slice(0, 3)) {
        const line = el('div', 'gov-line');
        line.append(document.createTextNode('· ' + (t.title || t.id) + ' '));
        const b = el('button', 'chip', '续跑');
        b.type = 'button';
        b.addEventListener('click', async () => {
          const yes = typeof askConfirm === 'function'
            ? await askConfirm('续跑工单「' + (t.title || t.id) + '」？', '会从最近检查点继续，已产生外部后果的动作不会重放。', '续跑')
            : true;
          if (!yes) return;
          b.disabled = true;
          const q = await callPost('/api/tickets/' + encodeURIComponent(t.id), { action: 'resume' });
          if (!q.ok) b.disabled = false;
          await renderStopReport();
        });
        line.append(b);
        box.append(line);
      }
    }
    if (!affected.length && !resumable.length && !last) {
      box.append(el('div', 'gov-empty', '没有需要收场的事项。'));
    }
  }

  async function renderTicketOptions(keep) {
    const sel = $('govTicketPick');
    if (!sel) return;
    const r = await callGet('/api/tickets?limit=50');
    const items = r.ok && Array.isArray(r.items) ? r.items : [];
    sel.replaceChildren();
    if (!items.length) { sel.add(new Option('暂无工单', '')); return; }
    sel.add(new Option('选择一张工单…', ''));
    for (const t of items) {
      sel.add(new Option((t.title || t.id) + ' · ' + (t.status || ''), t.id));
    }
    if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
  }

  async function renderTicketSupervision(id) {
    const nar = $('govNarrative');
    const raw = $('govRaw');
    const cnt = $('govRawCount');
    if (!id) {
      empty(nar, '选一张工单开始核对'); empty(raw, '选一张工单开始核对');
      if (cnt) cnt.textContent = '';
      return;
    }
    const enc = encodeURIComponent(id);
    const [d, tr] = await Promise.all([
      callGet('/api/tickets/' + enc),
      callGet('/api/tickets/' + enc + '/trail?limit=200'),
    ]);
    nar.replaceChildren(); raw.replaceChildren();
    if (!d.ok) { empty(nar, '读不到工单：' + (d.error || '')); empty(raw, '—'); return; }
    const t = d.ticket || {};
    const trailAll = (tr.ok && Array.isArray(tr.trail) && tr.trail.length)
      ? tr.trail : (Array.isArray(d.trail) ? d.trail : []);
    const lastAt = trailAll.length ? trailAll[trailAll.length - 1].at : 0;

    /* 结论先行。一般人要看的是"它卡在哪、要不要我管"，
       不是 epoch / rev / checkpoint 这些落盘字段 —— 那些折进「技术细节」。 */
    const stCode = String(t.status || '');
    const stZh = TICKET_STATUS[stCode] || (stCode || '未知状态');
    const own = TICKET_NEEDS_YOU.has(stCode);
    const cost = d.cost && d.cost.summary;

    nar.append(
      kv('结论', stZh + (own ? ' · 需要你看一眼' : ' · 不用你处理')),
      kv('工单', t.title || id),
      kv('为什么停在这', t.reason ? (REASON[t.reason] || t.reason) : '—'),
      kv('最近动作', lastAt
        ? fmtTime(lastAt) + '（共 ' + trailAll.length + ' 条，明细在右侧账本）'
        : '还没有落盘动作'),
    );
    const ctl = Array.isArray(d.control) ? d.control : [];
    if (ctl.length) {
      nar.append(el('div', 'gov-sub', '人工插手 ' + ctl.length + ' 次（最近 ' + Math.min(3, ctl.length) + ' 次）：'));
      for (const c of ctl.slice(-3)) {
        nar.append(el('div', 'gov-line', '· ' + (c.type || c.action || 'control') +
          ' ' + fmtTime(c.at) + (c.reason ? ' · ' + c.reason : '')));
      }
    }
    /* 技术字段默认收起：展开才看 epoch / 检查点 / 成本，避免一屏参数劝退。 */
    {
      const row = el('div', 'gov-trow');
      const btn = el('button', 'x', '技术细节');
      btn.type = 'button';
      const box = el('div', 'j', [
        'epoch ' + (t.epoch != null ? t.epoch : '—') + ' / rev ' + (t.rev != null ? t.rev : '—'),
        '检查点 ' + (d.checkpoint ? JSON.stringify(d.checkpoint) : '无'),
        '成本 ' + (cost ? (typeof cost === 'object' ? JSON.stringify(cost) : String(cost)) : '—'),
      ].join('\n'));
      box.hidden = true;
      btn.addEventListener('click', () => {
        box.hidden = !box.hidden;
        btn.textContent = box.hidden ? '技术细节' : '收起';
      });
      row.append(btn, box);
      nar.append(row);
    }

    if (cnt) cnt.textContent = trailAll.length + ' 条';
    if (!trailAll.length) { empty(raw, '这张工单还没有落盘的原始动作。'); return; }
    /* 一行一条：时间 · 类型 · 摘要。原来每条都摊一整段 JSON，200 条轨迹就是一屏乱码，
       用户看不懂也就等于没有 —— 参数压到「参数」按钮后面，默认收起。 */
    for (const e of trailAll) {
      if (!e || typeof e !== 'object') continue;
      const { at, type, ...rest } = e;
      const row = el('div', 'gov-trow');
      row.append(
        el('span', 't', fmtTime(at).slice(-8)),
        el('span', 'k', String(type || 'event')),
        el('span', 'b', trailBrief(rest) || '—'),
      );
      if (Object.keys(rest).length) {
        const x = el('button', 'x', '参数');
        x.type = 'button';
        const j = el('div', 'j', JSON.stringify(rest));
        j.hidden = true;
        x.addEventListener('click', () => {
          j.hidden = !j.hidden;
          x.textContent = j.hidden ? '参数' : '收起';
        });
        row.append(x, j);
      }
      raw.append(row);
    }
  }

  /* 从轨迹的其余字段里挑几个"人能读"的短值，凑一行摘要。
     认不出来的字段一律不猜，留给「参数」按钮 —— 猜错比不显示更误导。 */
  function trailBrief(rest) {
    const keys = ['name', 'label', 'title', 'text', 'tool', 'url', 'path', 'selector', 'target', 'step', 'ok', 'ms'];
    const out = [];
    for (const k of keys) {
      const v = rest[k];
      if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
      out.push(k + '=' + String(v).slice(0, 36));
      if (out.length >= 3) break;
    }
    return out.join(' ');
  }

  async function renderSilentCard() {
    const box = $('silentCardBody');
    if (!box) return;
    const [st, tk, af] = await Promise.all([
      callGet('/api/stop/report'),
      callGet('/api/tickets?open=1&limit=20'),
      callOps('affect.status'),
    ]);
    box.replaceChildren();
    const items = [];
    if (st.ok && st.stop && st.stop.on) {
      items.push('急停仍开着：自动化与后台任务都被拦下，需要你手动恢复。');
    }
    const open = tk.ok && Array.isArray(tk.items) ? tk.items : [];
    if (open.length) {
      items.push(open.length + ' 张工单还没收口：' +
        open.slice(0, 3).map((t) => t.title || t.id).join('、') + (open.length > 3 ? '…' : ''));
    }
    const resumable = st.ok && Array.isArray(st.resumable) ? st.resumable : [];
    if (resumable.length) items.push(resumable.length + ' 张工单可续跑（在上方急停收场清单里操作）。');
    const stats = af.ok && af.data && af.data.stats ? af.data.stats : null;
    if (stats && Number(stats.blocked) > 0) {
      items.push('开口门控最近拦下 ' + stats.blocked + ' 次主动开口（安静档生效，没有打扰你）。');
    }
    if (!items.length) {
      box.append(el('div', 'gov-empty', '当前没有需要你处理的事项，保持静默。'));
    } else {
      for (const s of items) box.append(el('div', 'gov-line', '· ' + s));
    }
    if (!st.ok || !tk.ok || !af.ok) {
      box.append(el('div', 'gov-empty', '有数据源暂不可用，上面只列已确认的部分；未取到的项不会补零。'));
    }
  }

  async function refreshGov() {
    await Promise.allSettled([renderStopReport(), renderSilentCard(), renderTicketOptions(
      ($('govTicketPick') || {}).value || '')]);
  }
  window.autoGovRefresh = refreshGov;

  /* ------------------------------------------------------------------ *
   * 四、事件接线
   * ------------------------------------------------------------------ */

  function wire(id, fn) {
    const b = $(id);
    if (!b) return;
    b.addEventListener('click', () => { Promise.resolve(fn()).catch(() => {}); });
  }

  wire('autoRefresh', refreshAutoPane);
  wire('autoPolicyApply', async () => {
    const r = await callPost('/api/wf', { action: 'policy-apply' });
    const msg = $('autoPolicyMsg');
    const ts = Array.isArray(r.transitions) ? r.transitions : [];
    if (msg) msg.textContent = r.ok
      ? (ts.length ? '已应用 ' + ts.length + ' 条变更：' + ts.map((x) => x.workflow + ' → ' + x.to).join('、') : '判据没有变化，模式保持不变')
      : '应用失败：' + (r.error || '');
    await renderPolicy();
  });
  wire('autoTrashPurge', async () => {
    const yes = typeof askConfirm === 'function'
      ? await askConfirm('清理回收站过期条目？', '只清超过 30 天或超出 200 条上限的部分，较新的条目会保留。', '清理')
      : false;
    if (!yes) return;
    const r = await callPost('/api/wf', { action: 'purge' });
    const msg = $('autoTrashMsg');
    if (msg) msg.textContent = r.ok
      ? '已清理 ' + (r.removed || []).length + ' 条，剩余 ' + (r.remaining || 0) + ' 条'
      : '清理失败：' + (r.error || '');
    await renderTrash();
  });

  wire('autoRunsOpen', openRuns);
  wire('autoRunsClose', closeRuns);
  wire('autoRunsRefresh', loadRuns);
  /* 「待复核 N」点进来直接落到待复核那一段，否则数字和列表对不上。 */
  wire('autoPendBadge', async () => {
    const s = $('autoRunsFilterReview');
    if (s) s.value = 'pending';
    openRuns();
  });
  /* 复核筛选也要触发重渲染 —— 漏了它，切下拉列表纹丝不动，看着像坏了。 */
  for (const id of ['autoRunsFilterWf', 'autoRunsFilterLayer', 'autoRunsFilterStatus', 'autoRunsFilterReview']) {
    const s = $(id);
    if (s) s.addEventListener('change', renderRuns);
  }
  const runsMask = $('autoRunsMask');
  if (runsMask) {
    runsMask.addEventListener('click', (ev) => { if (ev.target === runsMask) closeRuns(); });
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && runsMask && runsMask.classList.contains('on')) closeRuns();
  });

  wire('stopReportRefresh', renderStopReport);
  wire('silentCardRefresh', renderSilentCard);
  wire('govTicketRefresh', async () => {
    const cur = ($('govTicketPick') || {}).value || '';
    await renderTicketOptions(cur);
    if (cur) await renderTicketSupervision(cur);
  });
  const pick = $('govTicketPick');
  if (pick) pick.addEventListener('change', () => renderTicketSupervision(pick.value));

  /* 切到「安全」页时刷治理三卡。bindThemeUI 已绑定过同一个按钮，
     两个监听并存，互不覆盖。 */
  const safeNav = document.querySelector('#setnav .setnav-i[data-pane="safe"]');
  if (safeNav) safeNav.addEventListener('click', () => { refreshGov().catch(() => {}); });

  /* 主脚本里删除自动化后会自己重绘 #wfSetList；监听这一次重绘，
     顺带把回收站与判据刷成最新，用户不用多点一次「刷新」。
     debounce：重绘会先清空再逐行 append，避免一次操作触发多次请求。 */
  const wfListEl = $('wfSetList');
  if (wfListEl && typeof MutationObserver !== 'undefined') {
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        renderTrash().catch(() => {});
        renderPolicy().catch(() => {});
      }, 350);
    }).observe(wfListEl, { childList: true });
  }
})();
