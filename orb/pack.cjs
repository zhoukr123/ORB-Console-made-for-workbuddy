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

/* ROOT：默认按脚本自身位置反推（本文件在 <ROOT>/orb/pack.cjs），
   因此任何人克隆仓库后 `node orb/pack.cjs` 都能直接跑，不必改这一行。
   特殊场景（在别的目录里构建）用 ORB_ROOT 覆盖。 */
const ROOT = process.env.ORB_ROOT ? path.resolve(process.env.ORB_ROOT) : path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'orb', 'desktop');
const ELECTRON = path.join(APP, 'node_modules', 'electron', 'dist');
const VERSION = '1.4.5';
/* 输出目录带时间戳：不删旧构建。早先这里是 fs.rmSync(OUT) 一把清空，
   但批量删除会触发安全保护（3789 个文件远超阈值）而被拦截。
   版本化目录反而更好——每次构建都是可回溯的产物，旧的由用户自行清理。 */
const STAMP = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const OUT_NAME = `ORB控制台-${VERSION}-${STAMP}`;
const OUT = path.join(ROOT, 'dist', OUT_NAME);
const ZIP_NAME = `${OUT_NAME}.zip`;

const APP_FILES = [
  'main.js', 'preload.js', 'panel.html', 'ball.html', 'border.html',
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
const BRIDGE_LOCAL = ['mousehook.mjs', 'runtime.mjs'];

/* 随包释放的示例工作流（桥读 DATA_DIR/workflows，打包态 DATA_DIR 是 APPDATA，
   所以要从 resources/extras/workflows 里种子过去）。
   ⚠️ 源目录在 orb/desktop/extras/workflows（**随仓库走**），不是项目根的 workflows/ ——
   后者是开发态录制产生的个人数据，已被 .gitignore 排除，克隆仓库的人拿不到，
   整个目录忽略会让发布版一个示例工作流都没有。 */
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

console.log('输出目录:', OUT_NAME, '（带时间戳，不覆盖旧构建）');
if (fs.existsSync(OUT)) {
  console.error('✗ 输出目录已存在（同一秒内重复构建？），换个别的时间再试：', OUT);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

console.log('复制 Electron 运行时…');
cpr(ELECTRON, OUT);

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

/* 桥进程：main.js 用 path.join(__dirname,'..','bridge.mjs') 定位，
   打包后就是 resources/bridge.mjs。它的 ESM 依赖 @modelcontextprotocol/sdk
   要放在 resources/node_modules（Node 按桥自身位置向上找 node_modules）。 */
const BRIDGE_SRC = path.join(ROOT, 'orb', 'bridge.mjs');
const NM_SRC = path.join(ROOT, 'orb', 'node_modules');
const BRIDGE_DST = path.join(OUT, 'resources', 'bridge.mjs');
if (!fs.existsSync(BRIDGE_SRC)) { console.error('✗ 缺少 bridge.mjs'); process.exit(1); }
console.log('复制桥进程…');
cp(BRIDGE_SRC, BRIDGE_DST);
if (fs.existsSync(NM_SRC)) { console.log('复制桥的依赖（@modelcontextprotocol 等）…'); cpr(NM_SRC, path.join(OUT, 'resources', 'node_modules')); }
else { console.error('✗ 缺少 orb/node_modules（桥的依赖）'); process.exit(1); }

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

/* 示例工作流 → resources/extras/workflows（main.js 启动时种子到 DATA_ROOT） */
if (fs.existsSync(WORKFLOW_SRC)) {
  const wfDst = path.join(OUT, 'resources', 'extras', 'workflows');
  fs.mkdirSync(wfDst, { recursive: true });
  const wfs = fs.readdirSync(WORKFLOW_SRC).filter((f) => f.endsWith('.json'));
  for (const f of wfs) cp(path.join(WORKFLOW_SRC, f), path.join(wfDst, f));
  console.log('复制示例工作流…', wfs.length, '个');
} else console.log('  （无 workflows 目录，跳过）');

/* 本地语音识别（ASR）源码：只带 .py/.ps1/.txt/.conf 四类文本，约 100 KB。
   明确排除 venv/（2 GB）、models/（权重，GB 级）、__pycache__/ ——
   后两者由用户端首次点「安装本地离线识别」时按需下载（见 asr/prepare.ps1）。
   ⚠️ 这里若把 models/ 或 venv/ 带进去，包体会直接从 ~490 MB 涨到 2 GB 以上。 */
console.log('复制本地语音识别源码…');
const ASR_SRC = path.join(ROOT, 'asr');
const ASR_DST = path.join(OUT, 'resources', 'asr');
const ASR_KEEP = new Set(['asr_server.py', 'subtitle_rt.py', 'download_model.py', 'make_srt.py',
  'prepare.ps1', 'requirements.txt', 'asr.conf']);
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
