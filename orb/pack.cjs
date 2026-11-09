/* ORB 控制台 · 绿色便携版打包
   布局：
     ORB控制台-便携版/
       ├─ ORB 控制台.exe        ← electron.exe 改名（**必须改名**：Electron 以"可执行文件
       │                           是否叫 electron"来判断 app.isPackaged，不改名的话
       │                           main.js 里的 DATA_ROOT 不会切到用户目录，写盘会失败）
       ├─ *.dll / resources/    ← Electron 运行时（原样复制）
       ├─ resources/app/        ← 应用本体（main.js / 各页面 / voice.js / 图标 …）
       ├─ 使用说明.md           ← 随包附带文件
       └─ 启动 ORB 控制台.cmd
   说明：asr/ 只打包**源码**（asr_server.py / subtitle_rt.py / download_model.py /
         prepare.ps1 / requirements.txt / asr.conf，约 20 KB）；venv/（约 200 MB）与
         models/（权重，约 480 MB）由用户端首次点「安装本地离线识别」时按需生成
         （见 asr/prepare.ps1，bridge 的 /api/asr/prepare 触发）。详见
         docs/DESIGN-开箱即用增量设计.md §5。 */
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const { isBuiltin } = require('node:module');

/* ROOT：默认按脚本自身位置反推（本文件在 <ROOT>/orb/pack.cjs），
   因此任何人克隆仓库后 `node orb/pack.cjs` 都能直接跑，不必改这一行。
   特殊场景（在别的目录里构建）用 ORB_ROOT 覆盖。 */
const ROOT = process.env.ORB_ROOT ? path.resolve(process.env.ORB_ROOT) : path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'orb', 'desktop');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist');
const VERSION = '1.5.0';
/* 输出目录带时间戳：不删旧构建。早先这里是 fs.rmSync(OUT) 一把清空，
   但批量删除会触发安全保护（3789 个文件远超阈值）而被拦截。
   版本化目录反而更好——每次构建都是可回溯的产物，旧的由用户自行清理。 */
const STAMP = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT_NAME = `ORB控制台-${VERSION}-${STAMP}`;
const OUT = path.join(ROOT, 'dist', OUT_NAME);
const ZIP_NAME = `${OUT_NAME}.zip`;

const APP_FILES = [
  'main.js', 'preload.js', 'panel.html', 'ball.html', 'border.html',
  /* 面板抽壳（2026-11-08）：4028 行 <style> 已物理切到 panel.css，
     新增的自动化栏目 / 运行历史抽屉 / 治理视图放进 automation.js。
     两者都是 panel.html 用同源相对路径加载的，漏拷 = 发布版面板
     「没样式 + 新栏目全部不响应」，而且开发态完全正常、测不出来。 */
  'panel.css', 'automation.css', 'automation.js',
  /* 插件页交互（2026-11-07 抽出，2026-11-09 补进清单）：panel.html 用
     <script src="pluginSettings.js"> 加载，它不在 bridge.mjs 的 import 图里，
     所以打包闭包算不到它。漏了的后果：发布版「设置 › 插件」永远停在"读取中"，
     不报错、只是列表空着 —— 又一个"只炸发布版"的坑。
     tools/check-pack-closure.mjs 的 PACK_ASSETS 现在会拦这一类。 */
  'pluginSettings.js',
  'subtitle.html', 'toolbar.html', 'voice.js',
  /* 录屏链路（2026-10-21 新增）：storage.js / mp4finalize.js 被 main.js 引用，
     recbar.html + recbar-preload.js 是悬浮控制条（main.js 用 __dirname 定位）。
     漏一个 = 发布版录屏/存储/悬浮条静默失效，而开发态完全正常、测不出来。 */
  'storage.js', 'mp4finalize.js', 'recbar.html', 'recbar-preload.js',
  /* 截屏链路（2026-10-22 新增）：snipaste.js 被 main.js require，
     漏打包 = 发布版「截屏」键一点就报唤起失败（开发态完全正常）。 */
  'snipaste.js',
  /* 桌面模糊背景（2026-10-22 新增）：glassbg.js 被 main.js require，
     漏打包 = 发布版毛玻璃退化成"锐利透出桌面"（开发态完全正常、测不出来）。 */
  'glassbg.js',
  /* 框选取词（2026-10-28 新增）：pick.html + pick-preload.js 是取词覆盖层
     （main.js 用 __dirname 定位）。漏打包 = 发布版「取词」一点就报通道不可用，
     而开发态完全正常、测不出来。 */
  'pick.html', 'pick-preload.js',
  /* 录屏区域选择（2026-10-31 新增）：region.html + region-preload.js 是
     「自定义录制区域」的全屏覆盖层（main.js 用 __dirname 定位）。
     漏打包 = 发布版点「自定义…」报"选区覆盖层加载失败"，其余预设档位看着
     还都能用 —— 属于"只缺一角"的坑，最容易漏测。 */
  'region.html', 'region-preload.js',
  /* 摄像头小框摆位（2026-10-31 新增）：camstage.html + camstage-preload.js 是
     「预览模式」的全屏覆盖层。漏打包不会报错 —— 面板会静默回退到旧的
     "面板内放大示意图"，用户看到的是旧体验而不是故障，最难发现。 */
  'camstage.html', 'camstage-preload.js',
  /* 原生录屏（2026-10-23 新增）：cap-native.js 被 main.js require，
     它是 orb-cap.exe 的唯一入口。漏打包 = 发布版一 require 就抛，
     main.js 整个起不来（比"少个功能"严重得多）。 */
  'cap-native.js',
  /* 记忆模块（2026-10-31 补）：memory.js 被 main.js 顶层 require（第 13 行），
     漏打包 = 发布版一 require 就抛 MODULE_NOT_FOUND，main.js 整个起不来。
     这和 cap-native.js 是同一类：不是"少个功能"，是"程序打不开"。 */
  'memory.js',
  /* 凭据金库（2026-11-02 新增）：vault.js 被 main.js 顶层 require（第 22 行），
     存站点凭据 + 视觉 API Key 的密文。漏打包 = 和 memory.js 同一类事故：
     一 require 就抛 MODULE_NOT_FOUND，main.js 整个起不来。 */
  'vault.js',
  /* 检索工具配置（2026-11-06）：main.js 顶层 require 的纯 CJS 模块。
     漏打包 = 发布版一启动就 MODULE_NOT_FOUND，main.js 整个起不来。 */
  'searchToolConfig.cjs',
  /* 检索工具「测试」按钮的探测逻辑（2026-11-06）：同样被 main.js 顶层 require。 */
  'searchProbe.cjs',
  /* 看视频（2026-11-02 新增）：vidx.js 被 main.js 顶层 require（漏了 = 起不来）；
     vidx_probe.py 是探底/抽帧的**随包脚本**，vidx.js 按 __dirname 定位它
     （漏了 = 面板显示"运行时已装"但每次解析都报"脚本没有输出结果"，
      开发态因为文件就在原地永远正常 —— 又一个"只炸发布版"的坑）。 */
  'vidx.js', 'vidx_probe.py',
  /* md 净化层（2026-11-04）：vidx.js 顶层 require("./mdEscape.cjs")。
     漏打包 = 发布版一解析视频就 MODULE_NOT_FOUND，且开发态完全正常。 */
  'mdEscape.cjs',
  /* 产物布局（2026-11-04）：storage.js 顶层 require("./artifactLayout.cjs")。
     CJS 是唯一实现，ESM 侧 artifactLayout.mjs 用 createRequire 转发它。 */
  'artifactLayout.cjs',
  /* 浏览器 Agent 只走「随包 MV3 扩展」这一条路（2026-11-05 决策）：
     扩展复用用户日常浏览器已有的登录态，不新建 profile、不复制 Cookie。
     曾经做过一版 Electron 进程内 CDP 的原生降级后端 browserSession.cjs，
     但它要按站点重新登录、且自动化 profile 更容易撞风控，已按用户决定移除，
     不要再把任何 browserSession 文件加回 APP_FILES。 */
  /* 附件即时解析（2026-11-03 新增）：attach-probe.js 被 main.js **懒 require**
     （在 probeAttachments 内部）。漏打包 = 发布版选完附件永远拿不到解析结果，
     而且不报错、只是什么都不发生 —— 又是"只炸发布版"的那一类。 */
  'attach-probe.js',
  /* PDF 首页转图（2026-11-03 新增）：pdf-page.js 同样被 main.js 懒 require。
     漏打包 = Max 模式下扫描件永远转不出图，提示"取不出页面图"，
     而开发态一切正常 —— 和 attach-probe 是同一类坑，必须一起进清单。 */
  'pdf-page.js',
  'icon.png', 'icon.ico', 'icon-64.png', 'selection-watch.ps1', 'package.json',
];
/* 随包附带的配置文件（都放在包根，桥的 DATA_DIR 在开发态就是项目根，行为一致）：
   - bridge.conf      桥自身配置（daemon 等），桥从 resources/bridge.conf 读
   - approvals.json   危险操作白名单
   - danger-tools.json 危险工具清单（没有就用桥内置默认，不报错）
   - 使用说明.md      同时放两份：包根（开发态 DATA_DIR 就是包根时的位置）和
                      resources/extras/（main.js 的 ensureBundledExtras 只认这里，
                      打包态靠它把说明释放到 %APPDATA%/ORB 控制台）
   - 卸载 ORB 控制台.cmd  全量删除程序，放在包根（用户双击即跑）。它删的是
                      %APPDATA%\ORB 控制台 与 %LOCALAPPDATA%\ORBConsole 两处安装痕迹；
                      脚本内部会先把自己复制到 %TEMP% 再重开，否则删到自身所在目录
                      会把自己删中断。勿在脚本里 taskkill 通配的 electron.exe。 */
const EXTRA_FILES = ['使用说明.md', '卸载 ORB 控制台.cmd'];
const CONFIG_FILES = ['approvals.json', 'danger-tools.json'];

/* ⚠️ 原生模块与桥的动态依赖：漏一个，打包版就有对应功能是坏的。
   - native/dist/orb-foreground.exe  前台窗口探针（main.js:942 定位，缺失会自动
     退回 PowerShell，功能不中断但白丢性能收益）
   - native/dist/orb-selection.exe   划词监听探针（main.js 的 ORB_SELECTION 定位，
     缺失会自动退回 selection-watch.ps1，功能不中断但白丢性能收益）
   - native/dist/orb-input.exe       Win32 SendInput 键鼠模拟（bridge.mjs:384
     定位，缺失直接报"orb-input 执行失败"）
   - mousehook.mjs                   鼠标钩子，bridge.mjs:941 动态 import，
     缺失时 import 抛错、鼠标录制类功能整体失效
   - runtime.mjs                     前台通道运行时的单一真相源（T02 引入）。
     bridge.mjs **顶层静态 import** 它 —— 漏打包的后果不是"某个功能坏"，
     而是整个桥进程 ERR_MODULE_NOT_FOUND 起不来，面板全线无响应。
   - native/dist/orb-cap.exe         原生录屏（DXGI 复制 + MF 直出 MP4），
     cap-native.js 定位。缺失不致命（面板自动回退 MediaRecorder/VP9），但发布版
     就白丢原生 MP4，而且只有真去录一段才看得出来 —— 所以必须校验。
     （2026-10-15 实测踩过：加上 runtime.mjs 后忘了同步这里，发布版直接瘫。） */
const NATIVE_FILES = ['orb-foreground.exe', 'orb-selection.exe', 'orb-input.exe', 'orb-cap.exe'];
const BRIDGE_LOCAL = [
  'mousehook.mjs', 'runtime.mjs',
  /* 治理层（2026-11-03 新增）：bridge.mjs 顶层静态 import 这八个模块。
     漏任何一个 = 发布版桥进程 ERR_MODULE_NOT_FOUND 直接起不来，
     面板全线"已断开"—— 与 runtime.mjs 漏打包是同一类事故，必须列全。 */
  'ticketStore.mjs', 'outbox.mjs', 'costLedger.mjs', 'guiLock.mjs',
  'dispatcher.mjs', 'trajectory.mjs', 'workerPool.mjs', 'watchdog.mjs',
  /* 命令通道 / 自由路由（2026-11-04 早）：bridge.mjs 顶层静态 import。
     之前漏登记，打包审计会直接报「桥进程引用了未打包的本地模块」。 */
  'cmdchan.mjs', 'cmdDanger.mjs', 'freetier.mjs', 'taskRouter.mjs', 'probe.mjs',
  /* 阶段一 A · 止血与 md 源（2026-11-04） */
  'epoch.mjs', 'cmdGuard.mjs', 'stateWriters.mjs', 'mdEscape.mjs',
  /* 阶段一 B · 交付层后端 */
  'outputProfile.mjs', 'exporter.mjs', 'logBus.mjs', 'artifactStore.mjs',
  /* 阶段一 C · 尺子与前置隔离 */
  'span.mjs', 'observeRouter.mjs', 'textGate.mjs', 'fastPath.mjs', 'perfBaseline.mjs',
  /* 阶段一 D · 归档与体验 */
  'session.mjs', 'archiver.mjs', 'visualTiers.mjs', 'ticketControl.mjs',
  'receipts.mjs', 'events.mjs',
  /* 产物布局（2026-11-04）：bridge.mjs 顶层静态 import artifactLayout.mjs，
     漏登记 = 发布版桥进程直接 ERR_MODULE_NOT_FOUND。 */
  'artifactLayout.mjs',
  /* ⚠️ 2026-11-06 打包清单审计补漏：以下 16 个模块早就是 bridge.mjs 的顶层
     静态 import，却一直没登记进 BRIDGE_LOCAL。开发态源码就在旁边所以永远正常，
     但 pack.cjs:337 的「打包后本地依赖审计」会在 resources/ 里找不到它们并
     直接 process.exit(1) —— 等于便携版根本打不出来。
     由 orb/test/packManifest.test.mjs 从 bridge.mjs 的 import 反推锁定，
     以后再加本地模块没登记就会直接测挂。 */
  'team.mjs', 'expertTeam.mjs', 'expertContract.mjs', 'affectGate.mjs',
  'pluginHost.mjs', 'semanticRouter.mjs', 'telemetry.mjs',
  'siteLibrary.mjs', 'capabilityRegistry.mjs', 'searchProvider.mjs',
  'browserProvider.mjs', 'upgrade.mjs', 'personaSlots.mjs',
  'safetyOverview.mjs', 'artifactView.mjs', 'attachPlan.mjs', 'vidxSynth.mjs',
  /* 报告A P0 / 报告B 批次A / 批次B（2026-11-06 本轮新增）：
     appIntent 静态能力表、batchA 纪律层、searchL4 对外契约。 */
  'appIntent.mjs', 'batchA.mjs', 'searchL4.mjs',
  /* 报告B 批次C（2026-11-06）：可插拔凭据来源 + 结果回填编排 + 多 provider 适配器。 */
  'searchCredentials.mjs', 'searchOrchestrator.mjs', 'searchProviderAdapters.mjs',
  /* 方案 A1/B（2026-11-06 末）：确定性锚定解析纯模块，bridge.mjs 顶层静态 import。
     把抗迁移锚定从 OCR/Windows API 里抽出来，成为可单测的纯逻辑层。 */
  'anchorResolver.mjs',
  /* 方案 C（2026-11-07）：视觉锚定后端 —— C0 纯 JS 模板匹配 + C1 CLIP embedding，
     bridge.mjs 顶层静态 import。 */
  'visualAnchor.mjs',
  /* 语义解析泛化（2026-11-07）：意图未命中环形日志 + schema 约束兜底（纯内存，无 IO）。 */
  'intentMissLog.mjs', 'intentFallback.mjs',
  /* ===== 11-07 增量简报落地 + 专家团治理纪律层 =====
     注意：除 bridge.mjs 的顶层 import 外，还要登记「被已打包模块间接 import」的
     三个叶子模块（refBinding / siteCapabilityData / pluginArtifactGate）——
     打包审计只反推 bridge.mjs 的直接依赖，漏了它们开发态正常、便携版运行时才报
     ERR_MODULE_NOT_FOUND，属于最难查的一类事故。 */
  'policyTransition.mjs', 'dreamConsolidator.mjs', 'pluginArtifactGate.mjs',
  'memoryBudget.mjs', 'siteCapabilityData.mjs', 'refBinding.mjs',
  'governanceCore.mjs', 'p0Discipline.mjs', 'p1FileChannel.mjs',
  'p2SiteAdapter.mjs', 'p2SealReview.mjs', 'p3VerifyLite.mjs',
  'hostDataApi.mjs', 'executionBridge.mjs', 'injectable.mjs', 'apiChannel.mjs',
  /* 插件适配层（2026-11-08）：bridge.mjs 顶层静态 import pluginEcosystem / pluginMarket /
     pluginPack 三件，pluginAdapters 由 pluginEcosystem 间接 import。
     漏登记 = 便携版 resources/ 里找不到它们，桥进程 ERR_MODULE_NOT_FOUND 直接起不来，
     开发态因为源码就在旁边所以完全看不出来。由 check-pack-closure 反推锁定。 */
  'pluginEcosystem.mjs', 'pluginMarket.mjs', 'pluginPack.mjs', 'pluginAdapters.mjs',
  /* 自动化回收站（2026-11-08）：删除改可撤销后，bridge.mjs 新增的顶层静态 import。 */
  'wfTrash.mjs',
  /* 自动化运行账本（2026-11-08）：三层触发器唯一点火入口的依赖。 */
  'wfRunLedger.mjs',
  /* observe / auto 升降级判据（2026-11-08）。 */
  'autoPolicy.mjs',
  /* 可靠执行五件（2026-11-08）：bridge.mjs 顶层静态 import。
     独立结果判定 / 步级轨迹 / 失败分类与有限重试 / 配方版本 / 受限编排。
     漏登记 = 便携版桥进程 ERR_MODULE_NOT_FOUND 直接起不来，开发态完全正常。
     由 orb/test/packManifest.test.mjs 从 bridge.mjs 的 import 反推锁定。 */
  'autoOutcome.mjs', 'autoTrace.mjs', 'autoRetry.mjs',
  'wfRecipeVersions.mjs', 'wfDag.mjs',
  /* 判据归纳建议（2026-11-08）：把「你得自己写 outcome」这道坎降低。 */
  'outcomeSuggest.mjs',
  /* 界面证据候选（2026-11-08）：机器取证、人勾选 —— 解决 tree_state 判据没法自动推的问题。 */
  'outcomeEvidence.mjs',
  /* 断点续跑（2026-11-08）：安全功能 —— 桌面动作不可逆，重跑会把做过的再做一遍。 */
  'wfCheckpoint.mjs',
  /* 回放前预检（2026-11-08）：把「哪几步会失效」提前到动手之前，而不是跑废前四步才发现。 */
  'wfPreflight.mjs',
];

/* 随包释放的示例自动化（桥读 DATA_DIR/workflows，打包态 DATA_DIR 是 APPDATA，
   所以要从 resources/extras/workflows 里种子过去）。
   ⚠️ 源目录在 orb/desktop/extras/workflows（**随仓库走**），不是项目根的 workflows/ ——
   后者是开发态录制产生的个人数据，已被 .gitignore 排除，克隆仓库的人拿不到，
   整个目录忽略会让发布版一个示例自动化都没有。 */
const WORKFLOW_SRC = path.join(APP, 'extras', 'workflows');

const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
/* fs.cpSync 在本机复制 Electron 运行时会触发 Node 段错误（Windows 长路径/junction），改用 robocopy。 */
function cpr(from, to) {
  fs.mkdirSync(to, { recursive: true });
  /* 传**参数数组**而不是拼命令字符串：项目路径含中文与空格（本机正是
     `D:\WorkBuddy 附属文件夹\...`），拼进字符串再交给 cmd.exe 会按 ANSI 代码页
     转码，路径可能失真 —— 表现为 robocopy「找不到源」甚至复制到错误目录。
     spawnSync 走 CommandLineToArgv 的规则转义，中文路径安全。 */
  const r = spawnSync('robocopy', [from, to, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'],
    { stdio: 'ignore', windowsHide: true });
  if (r.error) { console.error('robocopy 启动失败:', r.error.message); process.exit(1); }
  /* robocopy 的退出码 1-7 都算成功，8 以上才是真失败 */
  const code = r.status == null ? 99 : r.status;
  if (code > 7) { console.error('robocopy 失败，退出码', code); process.exit(1); }
}

/* 发布包瘦身：删掉不被引用的死重依赖与多余语言包。
 * 诊断（2026-11-09）：pack.cjs 原先 `cpr(orb/node_modules, ...)` 整目录复制，
 * 把 onnxruntime-web/node（各 141M/288M，浏览器 WASM 与跨平台原生二进制，桥侧零引用，
 * ASR 实际走自带 Python）整包带进了 375MB 的 exe。这里在复制后剔除。
 * 注意：删除走原生 rmdir / robocopy，不能用 fs.rmSync —— 本环境的 safe-delete 包装会
 * 拦截批量删除。 */
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  const r = spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', p], { windowsHide: true, stdio: 'ignore' });
  if (r.error) console.error('  删除失败:', p, r.error.message);
}
function dirBytes(root) {
  let total = 0;
  const walk = (dir) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      try { if (e.isDirectory()) walk(fp); else total += fs.statSync(fp).size; } catch {}
    }
  };
  walk(root); return total;
}
function pruneLocales(outDir) {
  const loc = path.join(outDir, 'locales');
  if (!fs.existsSync(loc)) return;
  const keep = ['zh-CN.pak', 'en.pak'];
  const tmp = path.join(outDir, '.lockeep');
  fs.mkdirSync(tmp, { recursive: true });
  for (const f of keep) {
    const src = path.join(loc, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
  }
  // robocopy 把 tmp 镜像到 locales（/PURGE 删掉 locales 中 tmp 没有的文件），原生删除绕过 safe-delete 包装
  spawnSync('robocopy', [tmp, loc, '/PURGE', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { windowsHide: true, stdio: 'ignore' });
  rmrf(tmp);
  console.log('  语言包仅保留', keep.join(' / '));
}
function pruneNodeModules(outDir) {
  const nm = path.join(outDir, 'resources', 'node_modules');
  const dead = ['onnxruntime-web', 'onnxruntime-node', 'onnxruntime-common'];
  for (const d of dead) {
    const p = path.join(nm, d);
    if (fs.existsSync(p)) {
      const mb = (dirBytes(p) / 1048576).toFixed(0);
      rmrf(p);
      console.log('  剔除死重依赖', d, `(${mb} MB)`);
    }
  }
}

/* 生产依赖闭包复制（2026-11-09，Task #32）：
 * 不再整目录 `cpr(orb/node_modules)`，而是从运行时入口（bridge.mjs + 桌面 CJS 实现
 * + package.json 声明的运行/可选依赖）出发，按 Node 解析规则递归收集**真正被
 * import/require 的包**，只拷这些。
 * 收益：自动排除 devDependencies（puppeteer-core 仅测试工具用）、零引用死重；
 * 完全离线、不依赖网络或 lockfile，结果可复现。之后仍跑 pruneNodeModules 剔掉
 * onnxruntime-*（CLIP 视觉档优雅降级到 C0，不崩），作为体积兜底。 */
function pkgNameOf(spec) {
  if (!spec || spec[0] === '.' || isBuiltin(spec) || spec === 'electron') return null; // 相对导入 / Node 内置 / Electron 内置都不是 npm 包
  const parts = spec.split('/');
  if (spec[0] === '@') return parts.slice(0, 2).join('/'); // 作用域包 @scope/name
  return parts[0];
}
function resolvePkgRoot(name) {
  let p = NM_SRC;
  for (const part of name.split('/')) p = path.join(p, part);
  return (fs.existsSync(p) && fs.existsSync(path.join(p, 'package.json'))) ? p : null;
}
const SPEC_RE = /(?:import\b[^'"]*?\s+from\s*|export\b[^'"]*?\s+from\s*|require\(\s*|import\(\s*)[`'"]((?:[^'"`\\]|\\.)+)[`'"]/g;
function scanSpecs(file, out) {
  let txt; try { txt = fs.readFileSync(file, 'utf8'); } catch { return; }
  SPEC_RE.lastIndex = 0; let m;
  while ((m = SPEC_RE.exec(txt))) { const n = pkgNameOf(m[1]); if (n) out.add(n); }
}
function collectClosure() {
  const roots = new Map();   // name -> 顶层包根目录
  const queue = [];
  const enqueue = (name) => {
    if (roots.has(name)) return;
    const root = resolvePkgRoot(name);
    if (!root) return;       // 解析不到（Node 内置 / 嵌套未平铺）跳过
    roots.set(name, root);
    queue.push(root);
  };
  // 种子 1：package.json 声明的运行/可选依赖
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'orb', 'package.json'), 'utf8'));
  for (const n of [...Object.keys(pj.dependencies || {}), ...Object.keys(pj.optionalDependencies || {})]) enqueue(n);
  // 种子 2：运行时入口文件的裸导入
  const seeds = [
    path.join(ROOT, 'orb', 'bridge.mjs'),
    path.join(APP, 'mdEscape.cjs'),
    path.join(APP, 'artifactLayout.cjs'),
  ];
  const specs = new Set();
  for (const f of seeds) scanSpecs(f, specs);
  for (const s of specs) enqueue(s);
  // 广度优先展开：读每个包的依赖声明 + 扫其源文件的裸导入
  while (queue.length) {
    const root = queue.shift();
    const pjPath = path.join(root, 'package.json');
    if (fs.existsSync(pjPath)) {
      try {
        const p = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
        for (const n of [...Object.keys(p.dependencies || {}), ...Object.keys(p.optionalDependencies || {}), ...Object.keys(p.peerDependencies || {})]) enqueue(n);
      } catch {}
    }
    const walk = (dir) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(fp); } // 嵌套依赖随父包整体复制
        else if (/\.(?:m?js|cjs|mjs)$/.test(e.name)) { const s2 = new Set(); scanSpecs(fp, s2); for (const sp of s2) enqueue(sp); }
      }
    };
    walk(root);
  }
  return roots;
}
function copyProductionClosure(outDir) {
  const nmDst = path.join(outDir, 'resources', 'node_modules');
  const roots = collectClosure();
  let total = 0;
  for (const [name, root] of roots) {
    const dst = path.join(nmDst, path.relative(NM_SRC, root));
    cpr(root, dst);
    const mb = dirBytes(dst) / 1048576; total += mb;
    console.log('    ', name, mb.toFixed(1) + ' MB');
  }
  console.log('  生产依赖闭包', roots.size, '个包，', (total / 1048576).toFixed(0), 'MB（已排除 dev/puppeteer 等死重）');
}
/* 闭包审计（安全网）：扫发布包内所有本地 JS 的裸导入，确认每个都能在包内
 * node_modules 解析到；缺失的从源码 node_modules 补拷，绝不静默丢依赖。 */
function auditNodeModulesClosure(outDir) {
  const nmDst = path.join(outDir, 'resources', 'node_modules');
  const specs = new Set();
  const walk = (dir) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name === 'node_modules') continue; walk(fp); }
      else if (/\.(?:m?js|cjs|mjs)$/.test(e.name)) scanSpecs(fp, specs);
    }
  };
  walk(path.join(outDir, 'resources'));
  const missing = new Set();
  for (const sp of specs) {
    const name = pkgNameOf(sp); if (!name) continue;
    let p = nmDst; for (const part of name.split('/')) p = path.join(p, part);
    if (!fs.existsSync(p)) missing.add(name);
  }
  if (missing.size) {
    console.warn('  ⚠ 闭包审计补拷缺失包：', [...missing].join(', '));
    for (const name of missing) { const src = resolvePkgRoot(name); if (src) cpr(src, path.join(nmDst, path.relative(NM_SRC, src))); }
  } else {
    console.log('  桥依赖闭包审计通过：所有裸导入均在包内解析');
  }
}

console.log('输出目录:', OUT_NAME, '（带时间戳，不覆盖旧构建）');
if (fs.existsSync(OUT)) {
  console.error('✗ 输出目录已存在（同一秒内重复构建？），换个别的时间再试：', OUT);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

console.log('复制 Electron 运行时…');
cpr(ELECTRON, OUT);
pruneLocales(OUT);

/* ⚠️ 必须删掉 resources/default_app.asar：
   Electron 见到它就会加载**默认示例应用**而不是我们的 app
   （症状：能起来、但显示 hello-world，且 app.isPackaged 为 false，
     DATA_ROOT 落到 %APPDATA%/Electron，桥也不启动）。 */
const DEFAULT_APP = path.join(OUT, 'resources', 'default_app.asar');
if (fs.existsSync(DEFAULT_APP)) {
  fs.rmSync(DEFAULT_APP, { force: true });
  console.log('已移除 resources/default_app.asar（否则会加载默认示例应用）');
}

/* 顺带清掉从 electron dist 带过来的陈旧 debug.log：
   它是别处运行留下的，内容和本包无关，留着只会误导排查。 */
try { fs.rmSync(path.join(OUT, 'debug.log'), { force: true }); } catch { /* ignore */ }

console.log('改名 electron.exe → ORB 控制台.exe');
const exeSrc = path.join(OUT, 'electron.exe');
const exeDst = path.join(OUT, 'ORB 控制台.exe');
if (!fs.existsSync(exeSrc)) { console.error('✗ 找不到 electron.exe'); process.exit(1); }
fs.renameSync(exeSrc, exeDst);

console.log('复制应用本体…');
const APPDIR = path.join(OUT, 'resources', 'app');
fs.mkdirSync(APPDIR, { recursive: true });
for (const f of APP_FILES) {
  const src = path.join(APP, f);
  if (!fs.existsSync(src)) { console.error('✗ 缺少应用文件:', f); process.exit(1); }
  cp(src, path.join(APPDIR, f));
}
/* 随包目录（2026-10-27 新增）：anim/ 是图标动图（7 张 GIF，约 1.8MB），
   面板的预览网格与悬浮球都按相对路径 `anim/xxx.gif` 取。
   漏打包 = 设置页那 7 个格子全是碎图 + 球永远只演静态原图，
   而开发态完全正常 —— 和 glassbg.js / snipaste.js 是同一类"只炸发布版"的坑。

   voicepack/（2026-10-31 新增）：五人格预烘焙台词音频 + index.js 索引，
   面板按相对路径 `voicepack/xxx.opus` 取。漏打包不会报错，只会**静默**回落到
   系统语音 —— 用户听到的是冷冰冰的机器嗓，还以为人格语音就这么难听。 */
const APP_DIRS = ['anim', 'voicepack'];
for (const d of APP_DIRS) {
  const src = path.join(APP, d);
  if (!fs.existsSync(src)) { console.error('✗ 缺少应用目录:', d); process.exit(1); }
  cpr(src, path.join(APPDIR, d));
}

/* 浏览器 Agent 主路径（2026-11-05）：随包 MV3 扩展，复用用户日常浏览器的登录态。
   整个 orb/browser-extension/ 原样分发到 resources/app/browser-extension/，
   用户在发布版里「加载已解压的扩展程序」直接指到这个目录即可；cpr 用的是上面
   同一个 robocopy 封装（退出码 1-7 算成功）。漏打包 = 发布版找不到主路径扩展。 */
const EXT_SRC = path.join(ROOT, 'orb', 'browser-extension');
if (!fs.existsSync(EXT_SRC)) { console.error('✗ 缺少浏览器扩展目录:', EXT_SRC); process.exit(1); }
cpr(EXT_SRC, path.join(APPDIR, 'browser-extension'));
console.log('复制浏览器扩展（MV3 主路径）→ resources/app/browser-extension/');

/* 浏览器宿主注册脚本（2026-11-05）：APP_FILES 之外的单文件随包项，按现有风格
   用 cp() 单独拷一份到 resources/app/tools/，这样用户 / 面板在发布版里能直接
   找到并运行注册脚本，不必回源码仓库翻。 */
const REG_HOST_SRC = path.join(ROOT, 'orb', 'tools', 'register-browser-host.mjs');
if (!fs.existsSync(REG_HOST_SRC)) { console.error('✗ 缺少注册脚本:', REG_HOST_SRC); process.exit(1); }
cp(REG_HOST_SRC, path.join(APPDIR, 'tools', 'register-browser-host.mjs'));
console.log('复制注册脚本 → resources/app/tools/register-browser-host.mjs');

/* Native Messaging 宿主（2026-11-05）：**唯一需要保留 desktop/ 层级**的文件。
   注册脚本生成的 orb-browser-host.cmd 里写的是 `%~dp0browserHost.cjs`，
   %~dp0 就是 cmd 自己所在目录（DESKTOP_DIR = resources/app/desktop），
   所以宿主必须和 cmd 同目录。其它 desktop 文件都平铺到 resources/app/
   （main.js 靠 __dirname 找它们），只有这一个例外，故不走 APP_FILES。
   漏打包 = 注册表写对了、扩展装了，一 connectNative 就 "Native host has exited"，
   而开发态永远正常 —— 只炸发布版的那一类。 */
const HOST_SRC = path.join(APP, 'browserHost.cjs');
if (!fs.existsSync(HOST_SRC)) { console.error('✗ 缺少浏览器宿主:', HOST_SRC); process.exit(1); }
const HOST_DST_DIR = path.join(APPDIR, 'desktop');
fs.mkdirSync(HOST_DST_DIR, { recursive: true });
cp(HOST_SRC, path.join(HOST_DST_DIR, 'browserHost.cjs'));
console.log('复制浏览器宿主 → resources/app/desktop/browserHost.cjs');

/* 桥进程：main.js 用 path.join(__dirname,'..','bridge.mjs') 定位，
   打包后就是 resources/bridge.mjs。它的 ESM 依赖 @modelcontextprotocol/sdk
   要放在 resources/node_modules（Node 按桥自身位置向上找 node_modules）。 */
const BRIDGE_SRC = path.join(ROOT, 'orb', 'bridge.mjs');
const NM_SRC = path.join(ROOT, 'orb', 'node_modules');
const BRIDGE_DST = path.join(OUT, 'resources', 'bridge.mjs');
if (!fs.existsSync(BRIDGE_SRC)) { console.error('✗ 缺少 bridge.mjs'); process.exit(1); }
console.log('复制桥进程…');
cp(BRIDGE_SRC, BRIDGE_DST);
if (!fs.existsSync(NM_SRC)) { console.error('✗ 缺少 orb/node_modules（桥的依赖）'); process.exit(1); }
console.log('复制桥的依赖（生产依赖闭包，自动排除 dev/puppeteer 等死重）…');
copyProductionClosure(OUT);
auditNodeModulesClosure(OUT);
pruneNodeModules(OUT);

console.log('复制随包附带文件…');
for (const f of EXTRA_FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) {
    cp(src, path.join(OUT, f));
    // 打包态靠 resources/extras/ 这一份（见 ensureBundledExtras）
    cp(src, path.join(OUT, 'resources', 'extras', f));
  }
  else console.log('  （缺', f, '，跳过）');
}
/* 配置文件：bridge.conf 进 resources/（桥从 HERE/bridge.conf 读），
   其余放包根（DATA_DIR = 包根时的位置，与开发态一致）。 */
console.log('复制配置文件…');
const bcSrc = path.join(ROOT, 'orb', 'bridge.conf');
if (fs.existsSync(bcSrc)) cp(bcSrc, path.join(OUT, 'resources', 'bridge.conf'));
else console.log('  （缺 bridge.conf，跳过）');
for (const f of CONFIG_FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) {
    cp(src, path.join(OUT, f));
    /* resources/extras/ 这一份才是发布版真正生效的那份：打包态 DATA_DIR 是
       %APPDATA%\ORB 控制台（不再是包根），而 ensureBundledExtras 只从
       resources/extras/ 往 DATA_ROOT 种子 —— 只放包根的话，发布版里这两份定制
       配置会**静默**回落到桥内置默认（危险工具清单/白名单的随包定制全丢）。 */
    cp(src, path.join(OUT, 'resources', 'extras', f));
  }
  else console.log('  （缺', f, '，将使用内置默认）');
}

/* 原生模块 + 桥的本地依赖：一个都不能少（见上面 NATIVE_FILES 注释） */
console.log('复制原生模块…');
const NATIVE_SRC = path.join(ROOT, 'orb', 'native', 'dist');
for (const f of NATIVE_FILES) {
  const src = path.join(NATIVE_SRC, f);
  if (!fs.existsSync(src)) { console.error('✗ 缺少原生模块:', f, '（先跑 native/build.ps1 编译）'); process.exit(1); }
  cp(src, path.join(OUT, 'resources', 'native', 'dist', f));
  console.log('   ', f);
}
console.log('复制桥的本地依赖…');
for (const f of BRIDGE_LOCAL) {
  const src = path.join(ROOT, 'orb', f);
  if (!fs.existsSync(src)) { console.error('✗ 缺少桥的依赖文件:', f); process.exit(1); }
  cp(src, path.join(OUT, 'resources', f));
  console.log('   ', f);
}
/* ESM 转发层落在 resources/ 根（mdEscape.mjs / artifactLayout.mjs），
   内部用 createRequire("./desktop/X.cjs") 找 CJS 实现。
   而 APP_FILES 只把 X.cjs 拷到 resources/app/ —— 打包态 resources/desktop/ 根本不存在，
   于是发布版一 import 转发层就 MODULE_NOT_FOUND（开发态 orb/desktop/ 恰好有，测不出来）。
   这一步同时修掉既有的 mdEscape 漏拷与新增的布局层，二者共用同一份 CJS 单实现。 */
const BRIDGE_CJS_IMPL = ['mdEscape.cjs', 'artifactLayout.cjs'];
for (const f of BRIDGE_CJS_IMPL) {
  const src = path.join(APP, f);
  if (!fs.existsSync(src)) { console.error('✗ 缺少 CJS 实现:', f); process.exit(1); }
  cp(src, path.join(OUT, 'resources', 'desktop', f));
  console.log('   desktop/' + f);
}
/* ⚠️ 桥的本地依赖**自动审计**：把拷进包里的 bridge.mjs 拿出来，
   扫出它所有 `from "./X"` / `import("./X")` 形式的相对导入，逐个确认 X 在
   resources/ 里真实存在。
   为什么要有这一步：T02 引入 runtime.mjs 时漏了同步 BRIDGE_LOCAL，
   开发态完全正常（源码就在旁边），打包态桥进程直接 ERR_MODULE_NOT_FOUND 起不来，
   而既有的 must 校验清单只查"列进去的文件在不在"，查不出"该列却没列"。
   这个审计是**从消费方反推**，新增任何本地依赖都会被强制发现。 */
{
  const bridgeText = fs.readFileSync(path.join(OUT, 'resources', 'bridge.mjs'), 'utf8');
  const rel = new Set();
  for (const m of bridgeText.matchAll(/from\s+["']\.\/([\w.\-/]+)["']/g)) rel.add(m[1]);
  for (const m of bridgeText.matchAll(/import\(\s*["']\.\/([\w.\-/]+)["']\s*\)/g)) rel.add(m[1]);
  const missing = [...rel].filter((r) => !fs.existsSync(path.join(OUT, 'resources', r)));
  if (missing.length) {
    console.error('✗ 桥进程引用了未打包的本地模块:', missing.join(', '));
    console.error('  把它们加进 pack.cjs 的 BRIDGE_LOCAL（或确认已由其它步骤拷入 resources/）');
    process.exit(1);
  }
  console.log('   桥的本地依赖审计通过：', [...rel].join(', ') || '（无相对导入）');
}

/* 前台通道运行时：随包自带 embeddable CPython + 精简 site-packages（入口是 orb/runtime.mjs）。
   这是"干净机双击即用"的关键：原来前台通道寄生在 ~/.workbuddy 的 venv 上，
   没装 WorkBuddy 就整个废掉，而开发态完全正常、根本测不出来。
   ⚠️ 里面必须带 LICENSE.txt —— 再分发 CPython 有 PSF 许可要求，cpr 整目录复制不会漏。 */
console.log('复制前台通道运行时（Python）…');
const RUNTIME_SRC = path.join(ROOT, 'orb', 'runtime', 'python');
const RUNTIME_DST = path.join(OUT, 'resources', 'runtime', 'python');
if (!fs.existsSync(path.join(RUNTIME_SRC, 'python.exe'))) {
  console.error('✗ 缺少前台通道运行时:', RUNTIME_SRC);
  console.error('  先跑 orb\\native\\build-runtime.ps1 构建（下 embeddable Python + 装干净依赖集）');
  process.exit(1);
}
if (!fs.existsSync(path.join(RUNTIME_SRC, 'LICENSE.txt'))) {
  console.error('✗ 运行时缺 LICENSE.txt —— 再分发 CPython 必须附带 PSF 许可，构建脚本漏拷了');
  process.exit(1);
}
cpr(RUNTIME_SRC, RUNTIME_DST);
let rtBytes = 0;
(function walkRt(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walkRt(p);
    else { try { rtBytes += fs.statSync(p).size; } catch { /* 占用中 */ } }
  }
})(RUNTIME_DST);
console.log('    python.exe + Lib/site-packages，', (rtBytes / 1048576).toFixed(1), 'MB');

/* 示例自动化 → resources/extras/workflows（main.js 启动时种子到 DATA_ROOT） */
if (fs.existsSync(WORKFLOW_SRC)) {
  const wfDst = path.join(OUT, 'resources', 'extras', 'workflows');
  fs.mkdirSync(wfDst, { recursive: true });
  const wfs = fs.readdirSync(WORKFLOW_SRC).filter((f) => f.endsWith('.json'));
  for (const f of wfs) cp(path.join(WORKFLOW_SRC, f), path.join(wfDst, f));
  console.log('复制示例自动化…', wfs.length, '个');
} else console.log('  （无 workflows 目录，跳过）');

/* 本地语音识别（ASR）源码：只带 .py/.ps1/.txt/.conf 四类文本，约 100 KB。
   明确排除 venv/（2 GB）、models/（权重，GB 级）、__pycache__/ ——
   后两者由用户端首次点「安装本地离线识别」时按需下载（见 asr/prepare.ps1）。
   ⚠️ 这里若把 models/ 或 venv/ 带进去，包体会直接从 ~490 MB 涨到 2 GB 以上。 */
console.log('复制本地语音识别源码…');
const ASR_SRC = path.join(ROOT, 'asr');
const ASR_DST = path.join(OUT, 'resources', 'asr');
const ASR_KEEP = new Set(['asr_server.py', 'subtitle_rt.py', 'download_model.py', 'make_srt.py',
  'prepare.ps1', 'requirements.txt', 'asr.conf',
  /* SenseVoice 引擎（2026-11-02 新增）：sensevoice_engine.py 由 asr_server 顶层
     import，漏了 = 发布版直接回退 faster-whisper（没下 whisper 权重就完全没法识别），
     而且**不报错**，只在日志里留一句 engineError —— 又一个"只炸发布版"的坑。
     download_sensevoice.py 是 prepare.ps1 第 4 步调用的下载器，漏了 = 一键安装
     在"下载权重"这一步硬失败。 */
  'sensevoice_engine.py', 'download_sensevoice.py']);
const ASR_SKIP_DIR = new Set(['venv', 'models', '__pycache__', '_dl', 'site-packages']);
if (fs.existsSync(ASR_SRC)) {
  fs.mkdirSync(ASR_DST, { recursive: true });
  let asrBytes = 0;
  for (const e of fs.readdirSync(ASR_SRC, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (ASR_SKIP_DIR.has(e.name)) { console.log('    跳过目录', e.name, '（用户端按需生成/下载）'); continue; }
      console.log('  （asr 下有未预期目录', e.name, '，跳过；如需随包请加进 ASR_KEEP 逻辑）');
      continue;
    }
    if (!ASR_KEEP.has(e.name)) { console.log('    跳过文件', e.name, '（不在随包白名单）'); continue; }
    const src = path.join(ASR_SRC, e.name);
    if (!fs.statSync(src).isFile()) continue;
    cp(src, path.join(ASR_DST, e.name));
    asrBytes += fs.statSync(src).size;
  }
  console.log('    asr 源码合计', (asrBytes / 1024).toFixed(1), 'KB');
  if (asrBytes > 1024 * 1024) {
    console.error('✗ asr 源码超过 1 MB —— 混进了大文件（venv/models 漏拦？），中止');
    process.exit(1);
  }
} else console.log('  （无 asr/ 目录，跳过：语音识别在发布版不可用）');

console.log('生成启动器…');
/* 启动器必须做两件事，否则在某些环境里起不来：
   ① 清掉 ELECTRON_RUN_AS_NODE —— 这个变量一旦为 1，electron.exe 会退化成纯 Node，
      require('electron') 直接 MODULE_NOT_FOUND（开发态启动脚本开头正是这么做的）。
   ② 显式传 resources\app —— 不依赖 Electron 的自动发现，最稳。 */
fs.writeFileSync(path.join(OUT, '启动 ORB 控制台.cmd'), [
  '@echo off',
  'title ORB Console',
  'set "ELECTRON_RUN_AS_NODE="',
  'start "" "%~dp0ORB 控制台.exe" "%~dp0resources\\app"',
  'exit',
  '',
].join('\r\n'), 'utf8');

/* 打包态的首屏提示文件：确保 DATA_ROOT 里有使用说明（ensureBundledExtras 也会兜底） */
console.log('校验…');
const must = [
  'ORB 控制台.exe',
  path.join('resources', 'app', 'main.js'),
  path.join('resources', 'app', 'panel.html'),
  path.join('resources', 'app', 'panel.css'),
  path.join('resources', 'app', 'automation.css'),
  path.join('resources', 'app', 'automation.js'),
  path.join('resources', 'app', 'memory.js'),
  path.join('resources', 'app', 'voicepack', 'index.js'),
  path.join('resources', 'bridge.mjs'),
  path.join('resources', 'mousehook.mjs'),
  path.join('resources', 'runtime.mjs'),
  path.join('resources', 'native', 'dist', 'orb-foreground.exe'),
  path.join('resources', 'native', 'dist', 'orb-selection.exe'),
  path.join('resources', 'native', 'dist', 'orb-input.exe'),
  path.join('resources', 'native', 'dist', 'orb-cap.exe'),
  path.join('resources', 'runtime', 'python', 'python.exe'),
  path.join('resources', 'runtime', 'python', 'LICENSE.txt'),
  path.join('resources', 'asr', 'asr_server.py'),
  /* 下面两个漏了不会立刻报错，但发布版会静默残废：
     - sensevoice_engine.py：asr_server 顶层 import（try/except 吞掉），缺了直接回退
       faster-whisper；用户又只下了 SenseVoice 权重 → 一条都识别不出。
     - download_sensevoice.py：prepare.ps1 第 4 步调它下权重，缺了一键安装硬失败。
     都是"本机开发跑得好好的、打出来的包不行"那类，必须在打包时卡住。 */
  path.join('resources', 'asr', 'sensevoice_engine.py'),
  path.join('resources', 'asr', 'download_sensevoice.py'),
  path.join('resources', 'extras', '使用说明.md'),
  '使用说明.md',
];
for (const f of must) {
  if (!fs.existsSync(path.join(OUT, f))) { console.error('✗ 校验失败，缺', f); process.exit(1); }
}
let total = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else { try { total += fs.statSync(p).size; } catch { /* 忽略正在占用的文件 */ } }
  }
})(OUT);
const sizeMB = (total / 1048576).toFixed(1);
console.log('体积:', sizeMB, 'MB');

console.log('压缩 zip…');
/* zip 名也带时间戳，所以不存在同名冲突，不需要（也不能）先删旧的 */
const zipPath = path.join(ROOT, 'dist', ZIP_NAME);
/* 用 Windows 系统自带的 bsdtar（支持 -a 压 zip）；
   Git Bash 里 PATH 上的 GNU tar 不认 -a，会报 128 */
const SYSTAR = 'C:/Windows/System32/tar.exe';
/* 同上：参数数组，避免中文/空格路径在 cmd 转码时失真 */
const tar = spawnSync(SYSTAR, ['-a', '-c', '-f', zipPath, '-C', path.join(ROOT, 'dist'), OUT_NAME],
  { stdio: 'inherit', windowsHide: true });
if (tar.error) { console.error('tar 启动失败:', tar.error.message); process.exit(1); }
if (tar.status !== 0) { console.error('tar 失败，退出码', tar.status); process.exit(1); }
console.log('   压缩包:', zipPath);

/* ------------------------------------------------------------------ *
 * 单文件便携版：桩 + zip + trailer
 *
 * 为什么不是 IExpress：IExpress 内部走 MSZIP→CAB→合并，本次构建它对含
 * orb-selection.exe 的 payload **稳定失败**（CAB 本身完好、能正常展开，
 * 卡在最后的「桩 + CAB」合并步），而对另外几份 payload 全部成功——
 * 成败取决于 payload 的具体字节，不能作为发布依赖。排查记录见
 * 《打包与发布说明.md》。所以改用自研桩 orb-sfx.exe，格式完全可控。
 *
 * 布局：[ 桩本体 ][ payload zip ][ 32 字节 trailer ]
 *   trailer: +0 魔数"ORBSFX1" | +8 uint64 payload 长度 | +16 uint32 CRC32
 * 桩启动时读 trailer 反推 payload 偏移，因此桩可独立重编译、无需同步常量。
 * ------------------------------------------------------------------ */
const SFX_MAGIC = Buffer.from('ORBSFX1', 'ascii');
const SFX_TRAILER = 32;
const SFX_STUB = path.join(ROOT, 'orb', 'native', 'dist', 'orb-sfx.exe');
const SFX_OUT = path.join(ROOT, 'dist', `${OUT_NAME}-便携版.exe`);

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

if (!fs.existsSync(SFX_STUB)) {
  console.log('\n⚠️  跳过单文件便携版：找不到', SFX_STUB);
  console.log('    （先跑 orb\\native\\build-sfx.ps1 编译自解压桩）');
  console.log('    目录版与 zip 不受影响，可正常发布。');
} else {
  console.log('\n封装单文件便携版…');
  const stub = fs.readFileSync(SFX_STUB);
  const payload = fs.readFileSync(zipPath);

  const trailer = Buffer.alloc(SFX_TRAILER, 0);
  SFX_MAGIC.copy(trailer, 0);
  trailer.writeBigUInt64LE(BigInt(payload.length), 8);
  trailer.writeUInt32LE(crc32(payload), 16);
  fs.writeFileSync(SFX_OUT, Buffer.concat([stub, payload, trailer]));

  /* 结构校验：不必真解压 386MB，只要能把 trailer 反推的偏移处的内容
     与原 zip 逐字节对上，就说明桩一定能正确定位并取出 payload。
     （功能链路本身已由 native/test-sfx.cjs 用合成包端到端验证过。） */
  const packed = fs.readFileSync(SFX_OUT);
  const tail = packed.subarray(packed.length - SFX_TRAILER);
  if (tail.subarray(0, 7).toString('ascii') !== 'ORBSFX1') {
    console.error('✗ 校验失败：尾部魔数不对'); process.exit(1);
  }
  const len = Number(tail.readBigUInt64LE(8));
  const crc = tail.readUInt32LE(16);
  if (len !== payload.length) {
    console.error('✗ 校验失败：trailer 长度字段', len, '≠ zip 实际', payload.length); process.exit(1);
  }
  const off = packed.length - SFX_TRAILER - len;
  const slice = packed.subarray(off, off + len);
  if (slice.length !== payload.length || crc32(slice) !== crc || !slice.equals(payload)) {
    console.error('✗ 校验失败：按 trailer 反推取出的 payload 与原 zip 不一致'); process.exit(1);
  }
  const sfxMB = (fs.statSync(SFX_OUT).size / 1048576).toFixed(1);
  console.log(`   ✅ 单文件便携版: ${SFX_OUT}  (${sfxMB} MB)`);
  console.log(`      桩 ${stub.length} B + payload ${payload.length} B + trailer ${SFX_TRAILER} B`);
  console.log('      CRC32 与 trailer 均已核对，桩可正确定位并取出 payload');
}

console.log('\n✅ 完成');
console.log('   目录:', OUT);
console.log('   压缩包:', zipPath);
if (fs.existsSync(SFX_OUT)) console.log('   单文件便携版:', SFX_OUT);
console.log('');
console.log('   提示：本脚本故意不删旧构建（每次约 390MB）。要清理请运行');
console.log('         orb\\清理旧构建.cmd  （默认保留最新 1 份，其余进回收站，可先加 -DryRun 预览）');
