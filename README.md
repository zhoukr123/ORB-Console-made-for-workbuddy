# ORB 控制台

一个常驻桌面的悬浮球式 **电脑操作控制台**。你用自然语言下任务，它自己判断该走哪条轨道去执行，
过程和结果实时回到对话区。

- **前台轨道** —— 直接操作你的电脑：点击、输入、快捷键、滚动、长按、拖动、截图看屏幕。
- **后台轨道** —— 把重活派给 Agent（headless 一次性执行），跑完自动回填结果。
- **视觉轨道** —— 「截图 → 视觉模型 → 动作 → 再截图」的闭环，模型自己决定下一步点哪里。

![ORB 控制台界面](ORB界面预览.png)

---

## 特性

| 能力 | 说明 |
| --- | --- |
| 悬浮球交互 | 常驻置顶；悬停展开、单击固定、拖动换位并记忆、拖出屏幕边缘收纳成细签 |
| 对话式操作 | 输入框按内容自动分流到前台 / 后台，也可手动指定 |
| 划词即用 | 拖拽划选文字后工具条自动弹出（搜索 / 翻译 / 发给 Agent），无需注册任何全局钩子 |
| 语音输入 | 麦克风按钮流式转写。引擎可插拔：浏览器 Web Speech 或自建 Whisper 端点 |
| 视觉决策循环 | 坐标用千分比（0–1000）避免高分辨率下模型幻觉；支持主动 `zoom` / `reset` 调整视野；主力失败自动切备选 |
| 权限分级 | 只读 / 工作区可写 / 完全访问三档，随会话保存，切换即时生效 |
| 急停 | 顶栏红色按钮 或 `Ctrl+Alt+Backspace`，一键中断正在跑的动作 |
| 观察边框 | 前台执行时目标窗口亮起一圈边框，可直观看到「它在操作谁」 |
| 三套主题 | 深空靛蓝 + 琥珀金 / 紫罗兰 + 青柠 / 浅色玻璃拟态，一键切换 |
| 首跑向导 | 首次启动自动体检四条通道（前台 / 语音 / 视觉 / 后台），逐条给出可用状态 |
| 令牌鉴权 | 桥接层每个接口都要求 `X-Orb-Token`，浏览器里的任意网页无法遥控你的电脑 |

---

## 快速开始

### 方式一：下载便携版（推荐）

到 [Releases](https://github.com/zhoukr123/ORB-Console-made-for-workbuddy/releases) 下载
`ORB控制台-<版本>-便携版.exe`，双击即可。

它是**自解压单文件**：运行后把自己展开到 `%LOCALAPPDATA%\ORBConsole` 并启动，
不需要安装、不写注册表、不需要预装 Node 或 Python（运行时随包自带）。

- 数据目录：`%APPDATA%\ORB 控制台`
- 首次运行如遇 SmartScreen 提示，选「更多信息 → 仍要运行」（未购买代码签名证书）
- 卸载：运行同目录下的 `卸载 ORB 控制台.cmd`，会把上面两个目录和临时文件一并清掉

也可以下载 `ORB控制台-<版本>-便携目录.zip`，解压后直接运行里面的启动脚本。

### 方式二：从源码运行

前置：Windows 10/11 x64、[Node.js](https://nodejs.org/) 22+。

```bat
:: 1) 装依赖（两个 package.json 各装一次）
npm install --prefix orb
npm install --prefix orb/desktop

:: 2) 起面板
双击「启动 ORB 控制台.cmd」
```

> 启动脚本会先清掉 `ELECTRON_RUN_AS_NODE` 环境变量 —— 从 Electron 宿主继承到它时，
> Electron 会退化成纯 Node 并报 `Cannot read properties of undefined (reading 'whenReady')`。

### 首次使用

1. **配置视觉模型** —— 设置（顶栏齿轮）→「视觉模型」，填接口地址、模型名、API Key。
   没有 key 时可选「自检」预设，用脚本化响应跑通除第三方接口外的全部环节。
2. **选择权限** —— 状态条右侧滑轨，日常用「工作区可写」。
3. **直接说** —— 例如 `打开记事本`、`截个图`、`把这段代码整理成文档发到桌面`。

---

## 目录结构

```
orb/
  bridge.mjs              HTTP 桥进程（端口 19387）：MCP 服务代理 + 令牌鉴权
  runtime.mjs             运行时（Python / Node）定位的单一真相源
  pack.cjs                一键打包：便携目录 → zip → 自解压单文件
  selftest.mjs            全链路自检
  desktop/
    main.js               Electron 主进程（双窗口、托盘、快捷键、划词、桥的拉起与回收）
    panel.html            面板（单文件渲染层：全部内联 SVG，零外部资源）
    ball.html             悬浮球
    toolbar.html          划词工具条
    border.html           观察边框
    voice.js              语音输入模块
    preload.js            contextBridge 暴露的最小 IPC 面
    selection-watch.ps1   划词监听（UI Automation 常驻客户端）
  native/
    src/orb-input.c       原生鼠标原语（长按 / 按住 / 拖动 / 滚轮）
    src/orb-sfx.c         自解压桩
    build*.ps1            自动探测 MSVC / Windows SDK 并编译
asr/                      本地 Whisper 语音识别服务（可选）
ui/icons.html             图标规格（唯一真相）
使用说明.md                面向使用者的完整说明
orb/README.md             面向开发者的实现笔记与踩坑记录
orb/desktop/打包与发布说明.md  打包流程与发布契约
```

---

## 构建与打包

```bat
:: 编译原生模块（需要 MSVC + Windows SDK，脚本会自动探测）
powershell -ExecutionPolicy Bypass -File orb\native\build.ps1

:: 一键打包：产出便携目录 + zip + 自解压单文件
node orb\pack.cjs
```

产物落在 `dist/`，路径带时间戳，不会覆盖旧构建。

**打包契约（改动前请先读 `orb/desktop/打包与发布说明.md`）：** 主进程靠相对路径定位桥、
令牌、原生模块与依赖，因此 `electron-builder` 必须 `asar: false`；同时可执行文件必须改名，
否则 Electron 会认为自己处于开发态，运行时目录不会切到用户目录。

---

## 自检

```bat
node orb\selftest.mjs          :: 只读链路检查
node orb\selftest.mjs --full   :: 额外跑一次真实后台任务（会消耗模型额度）
```

自检覆盖：启动产物、令牌鉴权、三条服务通道、原生输入原语逐个实调、
异常边界（未知服务 / 畸形 JSON / 越界参数）、面板可用性。退出码 0 表示全绿。

---

## 安全说明

- **桥接层可执行任意 PowerShell 并控制鼠标键盘**，因此每个 `/api/*` 请求都必须携带进程启动时
  随机生成的 `X-Orb-Token`；只有 `/api/health` 免鉴权。令牌写在数据目录下的 `.bridge.json`，
  不进仓库、不随包分发。
- 需要「完全访问」权限才会启动视觉循环 —— 它真的会操作你的鼠标键盘。
- 删除、支付、发送等不可逆操作，模型会被要求先发起人工确认。
- 项目不含任何遥测。密钥只在内存里过一遍，不落盘、不写日志。

---

## 关于第三方组件

本项目**只包含自研源码、文档与构建脚本**，不随仓库或发布物分发任何第三方专有软件：

- **WorkBuddy / CodeBuddy Code CLI** 是腾讯的专有软件。后台轨道调用你**本机自行安装**的
  CodeBuddy CLI，仓库和发布包中都不包含它。请自行安装并遵守其许可条款。
- 划词、截图、窗口操作等能力通过你本机自行安装的 MCP 服务提供，同样不随本项目分发。
- 第三方组件的许可与归属见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

---

## 文档

| 文档 | 面向 |
| --- | --- |
| [使用说明.md](使用说明.md) | 使用者：界面速览、操作方式、常见问题、环境变量、彻底卸载 |
| [orb/README.md](orb/README.md) | 开发者：各模块实现细节与踩坑记录 |
| [orb/desktop/打包与发布说明.md](orb/desktop/打包与发布说明.md) | 维护者：打包流程、包内路径契约、发布检查清单 |
| [orb/desktop/DESIGN-开箱即用增量设计.md](orb/desktop/DESIGN-开箱即用增量设计.md) | 设计：开箱即用的改造设计与验收标准 |
| [功能对标分析.md](功能对标分析.md) | 与 DeepSeek Orb 的能力对照 |

---

## 许可

[MIT](LICENSE)
