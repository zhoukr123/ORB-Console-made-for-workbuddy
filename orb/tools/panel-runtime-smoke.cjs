#!/usr/bin/env node
/* 面板运行时冒烟：真起一个隐藏的 Electron 窗口加载 panel.html。
 *
 * 为什么需要它：check-panel.mjs 只编译内联脚本、查重复 id / 悬空 id，
 * 查不出「函数被删了但还有调用点」这类 ReferenceError；node --test 也跑不到渲染层。
 * 本工具专抓这一类：启动期未定义引用、preload 失败、TDZ，并顺手断言新 UI 真的
 * 渲染、绑定、生成了三档按钮、没有旧的 team 设置页。
 *
 * 用法：node tools/panel-runtime-smoke.cjs
 * 退出码 0 = 通过。脚本自己会去掉 ELECTRON_RUN_AS_NODE 再拉起 electron.exe ——
 * 带着那个环境变量，electron.exe 会退化成普通 Node，报 "Cannot find module 'electron'"。
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const DESK = path.resolve(__dirname, "..", "desktop");
const PANEL = path.join(DESK, "panel.html");
const IN_ELECTRON = !!process.versions.electron;

if (!IN_ELECTRON) {
  /* 父进程：找 electron.exe，去掉 ELECTRON_RUN_AS_NODE，拉起自己。 */
  const candidates = [
    path.join(DESK, "node_modules", "electron", "dist", "electron.exe"),
    path.join(DESK, "node_modules", "electron", "dist", "electron"),
  ];
  const exe = candidates.find((p) => fs.existsSync(p));
  if (!exe) {
    console.log("PANEL_RUNTIME_FAIL: 找不到 electron 可执行文件");
    process.exit(1);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [__filename, "--electron-child"], {
    env, cwd: DESK, stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  child.on("exit", (code) => {
    const lines = out.trim().split("\n").filter(Boolean);
    for (const l of lines) {
      if (/DOM_PROBE=|ELECTRON_FATAL=|STUB_HITS=|PANEL_RUNTIME_(FAIL|TIMEOUT)/.test(l)) console.log(l);
    }
    const pass = /PANEL_RUNTIME_OK/.test(out) && code === 0;
    console.log(pass ? "PANEL_RUNTIME_OK" : "PANEL_RUNTIME_FAIL");
    process.exit(pass ? 0 : 1);
  });
  return;
}

/* ---- 以下只在 Electron 主进程里跑 ---- */
const { app, BrowserWindow, ipcMain } = require("electron");
const http = require("http");
app.disableHardwareAcceleration();

const pre = fs.readFileSync(path.join(DESK, "preload.js"), "utf8");
const chans = new Set([...pre.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((x) => x[1]));

/* preload 里所有 invoke 通道都给一个无害的返回值：本测不接桥，
   目的是让渲染层完整跑完启动路径，而不是测 IPC 业务。
 *
 * 但 `bridge-token` 必须单独给：它的返回值会被直接塞进 X-Orb-Token 请求头。
 * 统一返回对象的话（历史写法），fetch 会在设置请求头时就抛
 * "Failed to execute 'fetch'" —— 请求根本发不出去，表现为"桩一次都没被命中"，
 * 而面板只是安静地走了降级分支，看起来像是桥没起来。真实桥返回的是字符串。 */
const CHAN_OVERRIDE = {
  "bridge-token": () => "",
};
for (const c of chans) {
  const fn = CHAN_OVERRIDE[c];
  ipcMain.handle(c, async (...args) => (fn
    ? fn(...args)
    : { ok: true, enabled: false, rows: [], data: {}, path: "" }));
}

/* ---------------- 桩桥 ----------------
 * 2026-11-08 修的一处环境耦合：本测原来让面板直接打默认端口 19387。
 * 那个端口上如果真有一台控制台在跑，面板的**首次 API 请求会 401 并重试**
 * （ensureToken 拿不到令牌 → 再打一次），叠加 Windows 首次连接的延迟，
 * 很容易超过本测 3.5s 的等待窗口 —— 于是 speakTierInit() 还卡在
 * teamOps('affect.status') 上没返回，三档按钮压根没画出来，报 tiers=0。
 * 实测插桩确认：同样环境下手动调 speakTierPaint() 立刻出 3 个 chip，
 * 也就是说渲染没问题，卡的是网络。
 *
 * 修法是消除变量而不是放宽断言：起一个本地桩，把面板指过来。断言一个字都不改。
 * 另外统计命中次数：如果路由没生效，hits=0 → 直接判失败，
 * 不会出现"其实在测别的桥"这种假绿。
 */
let hits = 0;
const stub = http.createServer((req, res) => {
  /* 必须回 CORS 头：面板从 file:// 加载，源是 null，
     fetch 打 http://127.0.0.1 属于跨源；X-Orb-Token 不是简单头，还会先发 OPTIONS。
     真实桥就是这么做才通的，桩不能省这一步。 */
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Max-Age": "600",
  };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  hits++;
  req.on("data", () => { });
  req.on("end", () => {
    const ok = String(req.url || "").startsWith("/api/health");
    /* 保守形状：ok:false + error，与"桥在但没令牌"完全同形，
       面板不用为这个桩多一条特殊分支。 */
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify(ok ? { ok: true } : { ok: false, error: "smoke-stub" }));
  });
});

/* ---------------- 测试期面板副本 ----------------
 * panel.html 的 CSP 把 connect-src 锁死在 http://127.0.0.1:19387，这是**刻意的安全边界**
 * （CONTRIBUTING.md 记着：外部请求必须走主进程代理）。所以 ?bridge=<随机端口> 在生产里
 * 其实是被 CSP 挡掉的死路 —— 想验证它就必须绕开 CSP，而不能去放宽生产策略。
 *
 * 做法：在 desktop/ 下写一份同名相对路径都能解析的临时副本，只把 connect-src 的端口
 * 换成通配，加载它；退出时删掉。这样 panel.css / automation.js / voicepack 的相对引用
 * 全部原样生效，测的仍是同一份界面代码，只是网络目标可指向本地桩。
 * 替换没命中就直接判失败 —— 否则 CSP 文案一变，这里会静默退回打真实端口，又变成假绿。
 */
const TMP_PANEL = path.join(DESK, ".panel-smoke.html");
function makeTempPanel() {
  const src = fs.readFileSync(PANEL, "utf8");
  const patched = src.replace(
    /connect-src http:\/\/127\.0\.0\.1:19387\b/,
    "connect-src http://127.0.0.1:*",
  );
  if (patched === src) {
    throw new Error("CSP 文案变了，没能把 connect-src 改到通配；请同步本测的替换规则");
  }
  fs.writeFileSync(TMP_PANEL, patched, "utf8");
  return TMP_PANEL;
}
function dropTempPanel() { try { fs.unlinkSync(TMP_PANEL); } catch { /* 已删 */ } }
try { dropTempPanel(); } catch { /* 清理上次残留 */ }

const fatal = [];
const record = (m) => {
  const s = String(m || "");
  if (/ReferenceError|is not defined|Cannot access '.*' before initialization|SyntaxError|Cannot read properties of (undefined|null)/i.test(s)) {
    fatal.push(s.slice(0, 260));
  }
};

app.whenReady().then(async () => {
  const port = await new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", () => resolve(stub.address().port));
  });
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: {
      preload: path.join(DESK, "preload.js"),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  win.webContents.on("console-message", (e, level, msg) => {
    record(typeof e === "object" && e && e.message ? e.message : msg);
  });
  win.webContents.on("preload-error", (_e, _p, err) => record("preload: " + ((err && err.message) || err)));
  /* 用测试期副本加载：既能绕开 CSP 的端口锁，又保持所有相对资源引用不变。
     用 loadURL + ?bridge= 而不是 loadFile({query})：后者在部分 Electron 版本上
     会被静默忽略，结果面板仍在打默认端口，测试看着"跑过了"其实测的是别的桥。 */
  const { pathToFileURL } = require("url");
  let panelForRun = PANEL;
  try { panelForRun = makeTempPanel(); } catch (e) { record(String(e && e.message || e)); }
  try {
    await win.loadURL(pathToFileURL(panelForRun).href + "?bridge=" + port);
  } catch (e) { record("loadFile: " + e.message); }
  await new Promise((r) => setTimeout(r, 3500));

  let probe = {};
  try {
    probe = await win.webContents.executeJavaScript(`(async () => {
      /* 工单只读折叠卡片：用一组假 rows 真正走一遍 tkPaint，验证卡片渲染、
         只读约束（无 input / 无纠正-换思路-停止按钮）、展开后出详情、
         以及旧的 run 子菜单 / runInit 确实被删干净。 */
      const host = [...document.querySelectorAll('#msgs .msg')].reverse()
        .find(n => n.querySelector('.body')) || document.createElement('div');
      let cards = 0, detail = 0, inputs = 0, ctlBtns = 0, tkErr = '';
      let painted = false, expanded = false;
      try {
        tkPaint(host, [
          { workerId: 'w1', name: '检索者', brief: '查资料', ticketId: 'job-1-abc', status: 'running', route: 'expert-team', ruleId: 'researcher' },
          { workerId: 'w2', name: '写作者', brief: '写结论', ticketId: 'job-2-abc', status: 'done', route: 'expert-team', ruleId: 'writer' },
        ]);
        const strip = host.querySelector('.tk-strip');
        painted = !!strip;
        cards = strip ? strip.querySelectorAll('.art-card').length : 0;
        inputs = strip ? strip.querySelectorAll('input, textarea, select').length : 0;
        ctlBtns = strip ? [...strip.querySelectorAll('button')]
          .filter(b => !b.classList.contains('art-card-top')).length : 0;
        const head = strip && strip.querySelector('.art-card-top');
        if (head) { head.click(); expanded = true; }
        detail = strip ? strip.querySelectorAll('.art-detail').length : 0;
      } catch (e) { tkErr = String(e && e.message || e); }
      const rt = document.getElementById('safReviewToggle');
      let toggle = false;
      if (rt) { const before = rt.getAttribute('aria-pressed'); rt.click(); toggle = rt.getAttribute('aria-pressed') !== before; rt.click(); }
      return {
        btn: !!document.getElementById('teamModeBtn'),
        bound: typeof document.getElementById('teamModeBtn').onclick === 'function',
        tiers: document.querySelectorAll('#speakTiers .chip').length,
        tierNames: [...document.querySelectorAll('#speakTiers .chip')].map(b => b.textContent).join('/'),
        saf: (document.getElementById('safOvRows').textContent || '').trim().slice(0, 40),
        mode: typeof teamModeOn !== 'undefined' ? teamModeOn : 'undefined',
        panes: [...document.querySelectorAll('#setnav .setnav-i')].map(b => b.dataset.pane).join(','),
        tkPainted: painted, tkCards: cards, tkExpanded: expanded, tkDetail: detail,
        tkInputs: inputs, tkCtlBtns: ctlBtns, tkErr: tkErr,
        tkOldGone: typeof runInit === 'undefined' && typeof tkState === 'undefined',
        reviewToggle: !!rt, reviewToggleWorks: toggle,
        /* 外链资产是否真的加载：panel.css / automation.css / automation.js
           都是 2026-11-08 抽壳后新加的 file:// 相对引用。CSP 或打包清单漏一项，
           这里会先于用户在发布版里发现。 */
        autoPane: typeof window.autoPaneRefresh === 'function',
        autoDrawer: !!document.getElementById('autoRunsMask'),
        autoPaneDom: !!document.querySelector('.setpane[data-pane="auto"]'),
        /* 栏目重排（2026-11-08）：生成入口与运行历史从「已录好的自动化」里搬出去，
           刷新收成标题右侧图标。这里锁住"搬干净了"，否则下次改动很容易又塞回去。 */
        autoLayout: (() => {
          const secs = [...document.querySelectorAll('.setpane[data-pane="auto"] .setsec')];
          const tt = (n) => ((n.querySelector('.setsec-tt') || {}).textContent || '').trim();
          const pick = (t) => secs.find((n) => tt(n) === t);
          const list = pick('已录好的自动化'), make = pick('新建自动化'), runs = pick('运行历史');
          if (!list || !make || !runs) return false;
          if (!list.querySelector('.setsec-hd #autoRefresh')) return false;      // 刷新在标题栏
          if (!make.querySelector('#wfSetSample') || !make.querySelector('#wfSetAi')) return false;
          if (!runs.querySelector('#autoRunsOpen')) return false;
          if (list.querySelector('#wfSetSample') || list.querySelector('#wfSetAi')
            || list.querySelector('#autoRunsOpen')) return false;               // 旧位置不许留
          if (secs.some((n) => tt(n).includes('导出与交付'))) return false;        // 该栏目已撤
          return true;
        })(),
        autoCss: (() => { const n = document.querySelector('.auto-intro'); return !!n && getComputedStyle(n).display === 'flex'; })(),
        /* 新建自动化（2026-11-08 晚）：说明压成一行、去掉外层的嵌套 .slotbox（双份留白），
           两个键必须是圆角方框 + 有过渡，否则又退回"UA 默认直角按钮"的呆板样子。 */
        autoNewFlat: (() => {
          const secs = [...document.querySelectorAll('.setpane[data-pane="auto"] .setsec')];
          const make = secs.find((n) => ((n.querySelector('.setsec-tt') || {}).textContent || '').trim() === '新建自动化');
          if (!make) return false;
          if (make.querySelector('.slotbox')) return false;
          if (!make.querySelector('.wf-new-tx')) return false;
          const b = document.getElementById('wfSetSample');
          if (!b) return false;
          const cs = getComputedStyle(b);
          if (cs.borderRadius !== '8px') return false;
          return /transform/.test(cs.transitionProperty || '');
        })(),
        /* 存储 › 产物与日志（2026-11-08 晚）：摘要只留 6 项、路径只写相对子路径，
           两个下拉并排。用 computed style 判，元素隐藏时也能取到（不靠几何量）。 */
        artLogCompact: (() => {
          const sum = document.getElementById('artLogSum');
          if (!sum || sum.querySelectorAll('.artLog-sum-i').length !== 6) return false;
          if (document.getElementById('artLogSumDay')) return false;        // 与产物路径重复
          if (document.getElementById('artLogSumLogsRoot')) return false;   // 与日志路径重复
          return !!document.querySelector('.artLog-note');
        })(),
        artLogRow: (() => {
          const ctl = document.querySelector('.artLog-ctl');
          if (!ctl || getComputedStyle(ctl).flexDirection !== 'row') return false;
          const fs = [...ctl.querySelectorAll('.artLog-field')];
          return fs.length === 2 && fs.every((f) => getComputedStyle(f).display === 'flex');
        })(),
        /* 审计日志默认只摆 6 条，余下折在按钮后（速览，不是账本） */
        auditPreview: (typeof AUDIT_PREVIEW === 'number' && AUDIT_PREVIEW === 6),
        /* 插件页签必须跟着 tab 走：原来 HTML 把「已安装」写死 on，启动又从 localStorage
           恢复成 market —— 亮着「已安装」却列着市场条目。这里点一遍来回验证。 */
        plugTabs: (() => {
          const tabs = [...document.querySelectorAll('#plugTabs .plug-tab')];
          if (tabs.length !== 2) return false;
          const on = () => tabs.find((b) => b.classList.contains('on'));
          tabs[1].click();
          if (!on() || on().getAttribute('data-tab') !== 'market') return false;
          tabs[0].click();
          return !!on() && on().getAttribute('data-tab') === 'installed';
        })(),
        plugMoreBtn: (() => { const n = document.getElementById('plugMore'); return !!n && n.tagName === 'BUTTON'; })(),
        /* 回收站 / 运行历史（2026-11-08 晚）：两处都必须「默认只露 2 条 + 滑条」，
           不许再把整列铺开把自动化页拉长。 */
        autoLists: (() => {
          const t = document.getElementById('autoTrashList');
          const r = document.getElementById('autoRunsRecent');
          if (!t || !r) return false;
          if (!t.classList.contains('capped') || !r.classList.contains('capped')) return false;
          const cs = getComputedStyle(t);
          return cs.maxHeight === '78px' && cs.overflowY === 'auto';
        })(),
        /* 工单监督：标题去掉「叙述 vs 原始动作」，改用一句人话说明用途；
           两列容器仍在（左叙述 / 右账本），参数折叠交给渲染层。 */
        govPlain: (() => {
          const secs = [...document.querySelectorAll('.setpane[data-pane="safe"] .setsec')];
          const tt = (n) => ((n.querySelector('.setsec-tt') || {}).textContent || '').trim();
          const s = secs.find((n) => tt(n) === '工单监督');
          if (!s) return false;
          if (!s.querySelector('.gov-sub')) return false;
          return !!s.querySelector('#govNarrative') && !!s.querySelector('#govRaw');
        })(),
        /* 版幅收口（2026-11-09）：音频来源 / 摄像头形状 / 皮肤改一行并排的竖排小卡；
           存储页两条开关行不再让长解释把开关顶到下一行。 */
        recCompact: (() => {
          const row = document.getElementById('audioSrcPick');
          if (!row || !row.classList.contains('compact')) return false;
          if (getComputedStyle(row).flexDirection !== 'row') return false;
          const kids = [...row.querySelectorAll('.recskin')];
          if (kids.length !== 3) return false;
          return kids.every((b) => getComputedStyle(b).flexDirection === 'column');
        })(),
        /* 安全页不再重复展示插件启停：设置 › 插件 已有专门一栏。
           锁住「这块不许再塞回来」，否则下次改动很容易顺手加回一行状态。 */
        safNoPlugins: (() => {
          if (document.getElementById('safOvPlugins')) return false;
          const pane = document.querySelector('.setpane[data-pane="safe"]');
          if (!pane) return false;
          return !/插件启停清单/.test(pane.textContent || '');
        })(),
        artLogTogs: (() => {
          const togs = [...document.querySelectorAll('.artLog-tog')];
          if (togs.length !== 2) return false;
          return togs.every((n) => getComputedStyle(n).flexWrap === 'nowrap' && !!n.querySelector('.switch'));
        })(),
        /* 空提示条不占位：临时造一个 .slotmsg 验「空=不显示、有字=显示」 */
        slotmsgEmpty: (() => {
          const p = document.createElement('div');
          p.className = 'slotmsg';
          document.body.appendChild(p);
          const hidden = getComputedStyle(p).display === 'none';
          p.textContent = 'x';
          const shown = getComputedStyle(p).display !== 'none';
          p.remove();
          return hidden && shown;
        })(),
        baseCss: (() => { const n = document.querySelector('.setsec-hd'); return !!n && getComputedStyle(n).display === 'flex'; })(),
        govCards: ['stopReportBody', 'govNarrative', 'silentCardBody'].every((id) => !!document.getElementById(id)),
        /* 编排图编辑器（2026-11-08）：面板从"只能校验"变成"能编辑"。
           这里只验它真的挂上了、点开能画出骨架 —— 保存链路属于 API 冒烟的范围。
           桩桥对 get 一律返回 {ok:false}，所以内容区会显示"读不到"，
           但那恰好证明失败路径也不炸：按钮骨架仍应完整。 */
        graphEditor: (() => {
          if (typeof window.openWfGraph !== 'function') return false;
          window.openWfGraph('__smoke__');
          const box = document.getElementById('wfBox');
          if (!box) return false;
          const labels = [...box.querySelectorAll('button')].map((b) => b.textContent.trim());
          return labels.includes('+ 加节点') && labels.includes('校验')
            && labels.includes('保存编排图') && labels.includes('清空');
        })(),
        /* 预检（2026-11-08）：列表行里必须真的有这个入口，且点开不炸。
           桩桥对 preflight 返回 {ok:false}，所以内容区会显示"预检失败"，
           但那恰好证明失败路径也不炸：按钮骨架仍应完整、可点。 */
        preflight: await (async () => {
          if (typeof window.openWfPreflight !== 'function') return false;
          /* 这个弹层是异步的（先请求再画画），必须等它一轮 —— 同步取按钮只会取到空。 */
          await window.openWfPreflight('__smoke__');
          const box = document.getElementById('wfBox');
          if (!box) return false;
          const labels = [...box.querySelectorAll('button')].map((b) => b.textContent.trim());
          return labels.includes('关掉') || labels.includes('重试');
        })(),
        /* 桩路由是否真的生效：API 必须指向本地桩，href 里必须带 ?bridge=。
           没有这两项，"请求打到了别的桥"这种假绿就查不出来。 */
        api: String(API || ''),
        href: String(location.href || '').slice(-40),
      };
    })()`);
  } catch (e) { record("probe: " + e.message); }
  console.log("DOM_PROBE=" + JSON.stringify(probe));
  console.log("ELECTRON_FATAL=" + JSON.stringify(fatal));
  console.log("STUB_HITS=" + hits);
  const good = !fatal.length && probe.btn && probe.bound
    && probe.tiers === 3 && probe.tierNames === "安静/标准/及时"
    && probe.mode === false && !(probe.panes || "").split(",").includes("team")
    && !(probe.panes || "").split(",").includes("run")
    && probe.tkPainted === true && probe.tkCards === 2 && probe.tkExpanded === true
    && probe.tkDetail === 1 && probe.tkInputs === 0 && probe.tkCtlBtns === 0
    && probe.tkErr === "" && probe.tkOldGone === true
    && probe.reviewToggle === true && probe.reviewToggleWorks === true
    && probe.autoPane === true && probe.autoDrawer === true && probe.autoPaneDom === true
    && probe.autoLayout === true
    && probe.autoCss === true && probe.baseCss === true && probe.govCards === true
    && probe.autoNewFlat === true && probe.artLogCompact === true && probe.artLogRow === true
    && probe.auditPreview === true && probe.plugTabs === true && probe.plugMoreBtn === true
    && probe.autoLists === true && probe.govPlain === true
    && probe.recCompact === true && probe.artLogTogs === true && probe.slotmsgEmpty === true
    && probe.safNoPlugins === true
    && probe.graphEditor === true && probe.preflight === true
    /* hits 是"自证式绿灯"的解毒剂：至少要有几次请求落到桩上，才说明
       ?bridge= 真的生效、被测的就是本桩而不是恰好跑着的真实控制台。 */
    && hits >= 3;
  console.log(good ? "PANEL_RUNTIME_OK" : "PANEL_RUNTIME_FAIL");
  try { stub.close(); } catch { /* 忽略 */ }
  dropTempPanel();
  app.exit(good ? 0 : 1);
});
setTimeout(() => { console.log("PANEL_RUNTIME_TIMEOUT"); dropTempPanel(); app.exit(2); }, 20000);
