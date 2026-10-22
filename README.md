<div align="center">

# ORB 控制台

**一个真的会替你操作电脑的桌面 AI 员工。**

说一句话，它自己截图看屏幕、判断该点哪里、替你点击 / 输入 / 滚动 —— 做完把整个过程回给你。
悬浮球常驻桌面，不用的时候停在角落。

[English](README.en.md) · [下载](#下载) · [文档](使用说明.md) · [路线图](ROADMAP.md)

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6)
![license](https://img.shields.io/badge/license-MIT-brightgreen)
![release](https://img.shields.io/github/v/release/zhoukr123/ORB-Console-made-for-workbuddy)
![stars](https://img.shields.io/github/stars/zhoukr123/ORB-Console-made-for-workbuddy)

</div>

![ORB 控制台界面：悬浮球展开后的主面板](ORB界面预览.png)

---

## 先说安全：它会动你的鼠标，所以先给了急停

把鼠标键盘交给 AI，你第一个问题一定是「它乱来怎么办」。ORB 把这件事当成第一功能来做：

| 机制 | 说明 |
| --- | --- |
| **急停** | `Ctrl + Alt + Backspace` 一键中断，或顶栏红色急停按钮。随时可打断，不留后台动作 |
| **权限分级** | 只读 / 工作区可写 / 完全访问三档，随会话保存，切换即时生效。不开「完全访问」就不会有视觉循环 |
| **观察边框** | 前台执行时目标窗口亮起一圈边框，你能实时看到「它正在操作谁」 |
| **人工确认** | 删除、支付、发送等不可逆操作，模型必须先发起确认 |
| **令牌鉴权** | 桥接层每个接口都要启动时随机生成的 `X-Orb-Token`，浏览器里的任意网页无法遥控你的电脑 |
| **零遥测** | 项目不含任何遥测；密钥只在内存里过一遍，不落盘、不写日志 |

---

## 三条执行轨道

同一句自然语言，ORB 会自己判断该走哪条路；你也可以手动指定。

| 轨道 | 干什么 | 适合 |
| --- | --- | --- |
| **前台轨道** | 直接操作你的电脑：点击、输入、快捷键、滚动、长按、拖动、截图看屏幕 | 打开软件、填表单、整理文件这类「手上的活」 |
| **后台轨道** | 把重活派给 Agent（headless 一次性执行），跑完自动回填结果 | 读代码库、写长文档、跑批处理这类「动脑的活」 |
| **视觉轨道** | 「截图 → 视觉模型 → 动作 → 再截图」的闭环，模型自己决定下一步点哪里 | 没有 API、只能靠看的软件 |

视觉轨道的坐标用 **千分比（0–1000）** 而不是像素，避免高分辨率下模型数错位置；
支持主动 `zoom` / `reset` 调整视野；主力模型失败自动切备选。

---

## 下载

| 方式 | 体积 | 说明 |
| --- | --- | --- |
| **便携单文件 `.exe`** | 约 208 MB | [Releases](https://github.com/zhoukr123/ORB-Console-made-for-workbuddy/releases) 下载 `ORB-Console-<版本>-portable.exe`，双击即用 |
| **便携包 `.zip`** | 约 208 MB | 同一个 Release 里的 zip，解压后运行里面的启动脚本 |
| **从源码运行** | — | 需要 Node.js 22+，见下 |

便携版是**自解压单文件**：运行后把自己展开到 `%LOCALAPPDATA%\ORBConsole` 并启动，
不安装、不写注册表、不需要预装 Node 或 Python（运行时随包自带）。

- 数据目录：`%APPDATA%\ORB 控制台`
- 卸载：运行同目录下的 `uninstall-ORB-Console.cmd`
- 首次运行如遇 SmartScreen 提示，选「更多信息 → 仍要运行」（项目尚未购买代码签名证书，见 [#签名](#关于代码签名)）
- GitHub 会把发布资产的文件名强制转成 ASCII，中文名显示在每个资产右侧的说明文字里

### 从源码运行

```bat
:: 前置：Windows 10/11 x64、Node.js 22+
npm install --prefix orb
npm install --prefix orb/desktop

:: 起面板
双击「启动 ORB 控制台.cmd」
```

### 首次使用

1. **配置视觉模型** —— 设置（顶栏齿轮）→「视觉模型」，填接口地址、模型名、API Key。
   没有 key 时可选「自检」预设，用脚本化响应跑通除第三方接口外的全部环节。
2. **选择权限** —— 状态条右侧滑轨，日常用「工作区可写」。
3. **直接说** —— 例如 `打开记事本`、`截个图`、`把这段代码整理成文档发到桌面`。

---

## 功能一览

| 能力 | 说明 |
| --- | --- |
| 悬浮球交互 | 常驻置顶；悬停展开、单击固定、拖动换位并记忆、拖出屏幕边缘收纳成细签 |
| 对话式操作 | 输入框按内容自动分流到前台 / 后台，也可手动指定 |
| 划词即用 | 拖拽划选文字后工具条自动弹出（搜索 / 翻译 / 发给 Agent），不注册任何全局键盘钩子 |
| 语音输入 | 麦克风按钮流式转写。引擎可插拔：浏览器 Web Speech 或自建 Whisper 端点 |
| 视觉决策循环 | 千分比坐标 + 主动缩放 + 失败自动切备选模型 |
| 录屏 | 原生直出 MP4（1080p / 30fps），悬浮控制条可暂停、继续、取消、完成（v1.1.0） |
| 截屏 | 唤起本机 Snipaste 框选标注，截图统一归档到你的存储目录（v1.1.0） |
| 四套主题 | 深空 / 白昼 / 极光·氤氲 / 自定义（整窗图片），一键切换；极光另带 6 款渐变；深空与自定义可开毛玻璃 |
| 首跑向导 | 首次启动自动体检四条通道（前台 / 语音 / 视觉 / 后台），逐条给出可用状态 |

### 四套主题

| 深空 | 白昼 |
| --- | --- |
| ![深空主题](docs/shots/theme-deepspace.png) | ![白昼主题](docs/shots/theme-daylight.png) |

| 极光·氤氲（6 款渐变之一） | 自定义（整窗图片，示例壁纸） |
| --- | --- |
| ![极光主题](docs/shots/theme-aurora.png) | ![自定义主题](docs/shots/theme-custom.png) |

---

## 架构速览

```
你说话
  │
  ├─ 前台轨道 ──► 原生输入原语（orb-input.c）──► 真的动鼠标键盘
  │                 ▲
  │                 └─ 视觉轨道：截图 → 视觉模型 → 千分比坐标 → 动作 → 再截图
  │
  └─ 后台轨道 ──► 本机 CodeBuddy CLI（headless）──► 结果回填对话区
```

所有能力都通过本机的 HTTP 桥进程（端口 19387）暴露，桥带令牌鉴权；
面板是单文件渲染层（全部内联 SVG，零外部资源）。

```
orb/
  bridge.mjs              HTTP 桥进程（端口 19387）：MCP 服务代理 + 令牌鉴权
  runtime.mjs             运行时（Python / Node）定位的单一真相源
  pack.cjs                一键打包：便携目录 → zip → 自解压单文件
  selftest.mjs            全链路自检
  sign.cjs                代码签名（含自解压包的签名兼容校验）
  desktop/
    main.js               Electron 主进程（多窗口、托盘、快捷键、划词、桥的拉起与回收）
    panel.html            面板（单文件渲染层）
    ball.html             悬浮球
    toolbar.html          划词工具条
    recbar.html           录屏悬浮控制条
    border.html           观察边框
  native/
    src/orb-input.c       原生鼠标原语（长按 / 按住 / 拖动 / 滚轮）
    src/orb-sfx.c         自解压桩（签名感知）
asr/                      本地 Whisper 语音识别服务（可选）
```

---

## 自检

```bat
node orb\selftest.mjs          :: 只读链路检查
node orb\selftest.mjs --full   :: 额外跑一次真实后台任务（会消耗模型额度）
```

覆盖：启动产物、令牌鉴权、三条服务通道、原生输入原语逐个实调、
异常边界（未知服务 / 畸形 JSON / 越界参数）、面板可用性。退出码 0 表示全绿。

---

## 参与贡献

欢迎提 Issue 和 PR。开始之前请先读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [行为准则](CODE_OF_CONDUCT.md)，
安全问题请看 [SECURITY.md](SECURITY.md)，下一步做什么看 [ROADMAP.md](ROADMAP.md)。

---

## 关于第三方组件

本项目**只包含自研源码、文档与构建脚本**，不随仓库或发布物分发任何第三方专有软件：

- **WorkBuddy / CodeBuddy Code CLI** 是腾讯的专有软件。后台轨道调用你**本机自行安装**的
  CodeBuddy CLI，仓库和发布包中都不包含它。请自行安装并遵守其许可条款。
- 划词、截图、窗口操作等能力通过你本机自行安装的 MCP 服务提供，同样不随本项目分发。
- 截屏功能唤起你本机安装的 **Snipaste**（闭源免费软件），ORB 只做「检测 + 唤起 + 归档」，不含其代码。
- 第三方组件的许可与归属见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

> 名字里的 ORB 指悬浮球形态，与 DeepSeek Orb 及其它同名产品**没有关联**。能力对照见
> [功能对标分析.md](功能对标分析.md)。

---

## 关于代码签名

发布物目前**未签名**，所以 Windows 会弹 SmartScreen。原因和进度写在
[docs/代码签名获取方案调研.md](docs/代码签名获取方案调研.md)，三条路线的工程量对比见
[docs/代码签名三条路线-工程量评估.md](docs/代码签名三条路线-工程量评估.md)。

自签名证书只能自用（`signtool verify /pa` 会因为根不受信任而失败），**不能解决别人的拦截**。
签名工具 `orb/sign.cjs` 已就绪，只差一张受信任的证书。

---

## 常见问题

**会让 AI 在我不知情的情况下操作电脑吗？**
不会。不开「完全访问」权限就没有视觉循环，前台动作都有观察边框，`Ctrl + Alt + Backspace` 随时中断。

**必须装 CodeBuddy / WorkBuddy 吗？**
后台轨道需要你本机装有 CodeBuddy CLI。前台轨道、视觉轨道、录屏、截屏不依赖它。

**没有视觉模型的 API Key 能用吗？**
能。设置里选「自检」预设，可用脚本化响应跑通除第三方接口外的全部环节。

**为什么便携包有 208 MB？**
它自带 Electron 运行时和 Node/Python 依赖，换来了「不装任何东西也能双击运行」。介意的话可以用源码方式运行。

---

## 文档

| 文档 | 面向 |
| --- | --- |
| [使用说明.md](使用说明.md) | 使用者：界面速览、操作方式、常见问题、环境变量、彻底卸载 |
| [ROADMAP.md](ROADMAP.md) | 所有人：接下来三个版本做什么 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献者：怎么跑起来、怎么提 PR |
| [orb/README.md](orb/README.md) | 开发者：各模块实现细节与踩坑记录 |
| [orb/desktop/打包与发布说明.md](orb/desktop/打包与发布说明.md) | 维护者：打包流程、包内路径契约、发布检查清单 |

---

## 许可

[MIT](LICENSE)
