# 贡献指南

感谢你想让 ORB 变好。这篇文档讲清楚三件事：**怎么把项目跑起来**、**改哪些地方容易踩坑**、**PR 怎么提**。

开始前请先读 [行为准则](CODE_OF_CONDUCT.md)。安全相关的漏洞请走 [SECURITY.md](SECURITY.md)，不要开公开 Issue。

---

## 一、把项目跑起来

**环境要求**

| 项目 | 版本 |
| --- | --- |
| 操作系统 | Windows 10 / 11 x64（本项目当前只支持 Windows） |
| Node.js | 22+ |
| MSVC + Windows SDK | 仅编译原生模块时需要，构建脚本会自动探测 |

```bat
:: 1) 装依赖 —— 两个 package.json 各装一次
npm install --prefix orb
npm install --prefix orb/desktop

:: 2) 起面板
双击「启动 ORB 控制台.cmd」
```

> 启动脚本会先清掉 `ELECTRON_RUN_AS_NODE` 环境变量 —— 从 Electron 宿主继承到它时，
> Electron 会退化成纯 Node 并报 `Cannot read properties of undefined (reading 'whenReady')`。

**自检**

```bat
node orb\selftest.mjs          :: 只读链路检查，改完代码先跑这个
node orb\selftest.mjs --full   :: 额外跑一次真实后台任务（会消耗模型额度）
```

退出码 0 表示全绿。它覆盖启动产物、令牌鉴权、三条服务通道、原生输入原语逐个实调、
异常边界与面板可用性。

**打包**（只在发布时需要）

```bat
powershell -ExecutionPolicy Bypass -File orb\native\build.ps1   :: 编译原生模块
node orb\pack.cjs                                               :: 便携目录 → zip → 自解压单文件
```

产物落在 `dist/`，路径带时间戳，不会覆盖旧构建。

---

## 二、改动前的四条硬约束

这几条都是踩过真事故才写下来的，改代码前请先看一遍。

**1. 主进程模块顶层不许直接碰 ready-gated API**

`screen` / `BrowserWindow` / `session` / `dialog` / `Tray` / `globalShortcut` / `nativeTheme` /
`powerMonitor` / `desktopCapturer` 都必须写在 `app.whenReady()` 之后。

曾经的事故：一个 `screen.on('display-metrics-changed', …)` 写在模块顶层，模块求值同步抛错，
结果窗口能开、但那行之后的所有 IPC 通道都没注册 —— 表现为「按键全失效、面板没内容」，
看起来像整个程序崩了，极具误导性。

**改完 `main.js` 必须真启动一次应用并看日志**（`orb/desktop/.orbdata/orb.log`），
最近的 `[app] 启动` 之后不应出现 `No handler registered` / `[panel:error] JS REJECT` /
`render-process-gone`。headless 探针只测渲染层，测不出主进程的启动顺序问题。

**2. 渲染层的 CSP 是零外部资源**

面板 CSP = `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
script-src 'self' 'unsafe-inline'; connect-src http://127.0.0.1:19387`。

所以：图标全部内联 SVG，不引任何 CDN、字体、外链图片；面板里禁止 `<a href="http">`，
外链一律走 `window.orb.openExternal`。

**3. 动效只动 `transform` / `opacity`**

项目主动关闭了硬件加速（`app.disableHardwareAcceleration()`），模糊走软件渲染。
因此：禁止给 `backdrop-filter` 做动画，禁止给消息区加模糊（滚动重绘），
保留 `prefers-reduced-motion` 与 `html.no-motion` 兜底。
新增模糊面积前先想清楚代价 —— 现有预算只有 4 处（`.card` blur(10px) + 三个浮层 blur(8px)）。

**4. 新增文件要进打包清单**

`orb/pack.cjs` 的 `APP_FILES` 是手工维护的。新增一个被 `main.js` require 的模块却忘了加进去，
结果是：**开发态完全正常，发布版静默失效**。（`snipaste.js`、`glassbg.js` 都补过。）

---

## 三、目录与职责

```
orb/
  bridge.mjs        HTTP 桥进程（端口 19387）：MCP 服务代理 + 令牌鉴权
  runtime.mjs       运行时（Python / Node）定位的单一真相源
  pack.cjs          打包
  selftest.mjs      全链路自检
  sign.cjs          代码签名（含自解压包的签名兼容校验）
  desktop/
    main.js         Electron 主进程
    panel.html      面板（单文件渲染层）
    ball.html       悬浮球
    toolbar.html    划词工具条
    recbar.html     录屏悬浮控制条
    border.html     观察边框
    preload.js      contextBridge 暴露的最小 IPC 面
  native/src/       原生模块（鼠标原语、自解压桩）
docs/               设计文档、调研、一次性验证脚本
asr/                本地 Whisper 语音识别服务（可选）
```

各模块的实现细节与踩坑记录见 [orb/README.md](orb/README.md)，打包契约见
[orb/desktop/打包与发布说明.md](orb/desktop/打包与发布说明.md)。

---

## 四、提交与 PR

**分支**：从 `main` 切 `feat/xxx` 或 `fix/xxx`，PR 回 `main`。

**提交信息**：用 [Conventional Commits](https://www.conventionalcommits.org/)，正文用中文。

```
feat: 录屏直出 MP4 + 悬浮控制条
fix: 录屏净时长计量（netMs/segStart）
docs: 同步发布资产名
chore: pack.cjs 补录屏链路新文件进 APP_FILES
```

**PR 里请写清**

1. 改了什么、为什么改；
2. 怎么验证的（`node orb\selftest.mjs` 全绿？跑了哪个 `docs/_*.js` 探针？真启动过应用吗？）；
3. 有没有影响打包（新增文件、改了包内路径）；
4. 界面改动请附截图，动效改动请说明是否遵循「只动 transform/opacity」。

**关于 `docs/_*.js` 探针**

仓库里 `docs/_*` 被 `.gitignore` 排除 —— 那些是我本地用的一次性无头验证脚本（主题渲染、毛玻璃、渐变、
录制条链路等），依赖本机 Edge 路径与硬编码目录，不适合作为通用测试。**所以 PR 不需要跑它们**，
你只要保证 `selftest.mjs` 全绿、并且真启动过一次应用即可。

如果你确实想补自动化测试，欢迎新开 `test/` 目录写可移植的用例 —— 这是路线图里缺的一块。

---

## 五、不入库的东西

以下几类内容不进仓库（已写进 `.gitignore`，改完记得 `git rm -r --cached` 已跟踪项）：

调参截图、审批台账、逆向脚本、`.icon-backup/`、录制产物（`recordings/`、`screenshots/`）、
构建产物（`dist/`、`dist-electron/`、`cache/`、`.cache/`）、数据目录下的令牌与日志。

---

## 六、License

贡献即表示你同意你的代码以本项目相同的 [MIT](LICENSE) 许可发布。
请勿提交任何第三方专有代码或私有密钥。
