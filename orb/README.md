# Orb 控制台

自建的桌面悬浮球 Agent 控制台，对标 DeepSeek Orb。两条轨道：**前台**直接操作你的电脑，**后台**把重活派给 WorkBuddy Agent（内置的 CodeBuddy CLI，headless 一次性执行）。

## 启动

双击 `start.cmd`。桌面上另有 **`ORB 控制台.cmd`**，意外关闭后双击即可重新打开。

手工启动：

```bash
cd desktop
ELECTRON_RUN_AS_NODE= ./node_modules/.bin/electron .
```

> 宿主环境可能带有 `ELECTRON_RUN_AS_NODE=1`（从 Electron 宿主继承），这会让 Electron 退化成纯 Node 运行并报 `Cannot read properties of undefined (reading 'whenReady')`。启动脚本已经处理，手工启动时必须清掉这个变量。

## 交互

| 操作 | 效果 |
|---|---|
| 鼠标悬停球体 | 约 300ms 后自动展开面板（临时态） |
| 单击球体 | 展开 → 再点固定（钉住，鼠标移开也不折叠）→ 再点取消固定 |
| 指针离开面板 | 未固定时自动折叠（`prompt` 弹窗期间不触发） |
| 拖动球体 | 移动位置，松手后位置被记住并自动吸附到边缘 |
| 拖出屏幕边缘超过球体 1/5 | 收纳成一条灰色细签 |
| 悬停细签 | 滑回完整球体 |
| 右键球体 | 打开菜单：换头像 / 坐标编码 / 观察边框 / 划词工具条 / 退出 |
| `Ctrl+Space` | 全局唤起 / 收起面板 |
| **拖拽划选文字** | **划词工具条自动弹出**（搜索 / 翻译 / 发给 Agent） |
| `Ctrl+Alt+S` | 划词工具条手动触发（自动弹出不可用时的兜底） |
| `Ctrl+Alt+G` | 把剪贴板文字送进输入框 |
| 托盘图标 | 单击开关面板，右键退出 |

## 图标

三处图标位共用同一个 `icon.png`：

| 位置 | 文件 | 尺寸 |
|---|---|---|
| 托盘图标 | `desktop/icon.png` | 512×512 |
| 桌面球体（`ball.html` 的 `<img id="icon">`） | `desktop/icon.png` | 512×512 |
| 面板头像（`panel.html` 的 `<img id="avatar">`） | `desktop/icon.png` | 512×512 |

根目录还有一个同名 `icon.png`，是托盘找不到 `desktop/icon.png` 时的回退路径。

### 源文件与设计说明

多档位源文件在 `docs/icon/`：`icon-1024.png` / `icon-512.png` / `icon-256.png` / `icon-64.png`，
`desktop/icon.png` 是其中的 512 档。

图标为**圆角方形蓝底 + 白色图形**，是本项目自有的视觉标识：

- 不使用任何第三方产品的图形元素，图形由本项目的白色有机轮廓 + 两个符号构成；
- 圆角方形与蓝白配色属于**通用视觉语言**（不受著作权保护），仅用于与所处生态保持视觉一致；
- 原图为位图，已做边缘修复后按 4 档输出：4×4 超采样重渲染消除锯齿、泛洪分离背景后
  置透明（无白边）、过渡带统一着色为品牌蓝（无灰边），并按长边等比缩放居中（原图非正方形）。

三处图标位共用同一张图，改完**必须重启**（托盘在启动时创建）。

### 换图标

```bash
C:/Users/%USERNAME%/.workbuddy/binaries/python/envs/default/Scripts/python.exe set-icon.py <图片路径>
```

自动补齐 512 / 64 两个尺寸，覆盖前备份到 `.icon-backup/`。改完**必须重启**（托盘在启动时创建）。

## 已脱离 DeepSeek Orb 独立运行

整套东西原来有两处硬依赖在 `~/.dsh`（Orb 的数据目录）里，卸载 Orb 可能一起没掉。现在都搬到自有目录了：

| 依赖 | 原来 | 现在 |
|---|---|---|
| DSH CLI（后台轨道） | `~/.dsh/profiles/node_modules/...` | `C:\Users\%USERNAME%\.workbuddy\orb-dsh\profiles\node_modules\...` |
| DSH 凭据 | `~/.dsh/.credentials.yaml` | `C:\Users\%USERNAME%\.workbuddy\orb-dsh\.credentials.yaml` |
| DSH_HOME | `~/.dsh` | `C:\Users\%USERNAME%\.workbuddy\orb-dsh` |

`bridge.mjs`、`mcp.json`、`dsh-mcp-launcher.mjs` 全部指向新路径。代码里已经没有任何 `~/.dsh` 引用。

**密钥不写进配置文件**：`bridge.mjs` 和 `dsh-mcp-launcher.mjs` 都在启动时从 `.credentials.yaml` 读一次再注入环境变量，配置里只留路径。

### 原生输入工具（orb-input.exe）

### 从 Orb 里抢救出来的配置

有一样东西只有 Orb 的配置里有，卸载后就再也找不回来——**cscs provider 的端点定义**（在 `profiles/desktop/cordis.patch.yml`）：

```yaml
cscs:
  apiKeyEnv: CSCS_API_KEY
  api: openai-responses                              # 注意不是 chat/completions
  baseURL: https://maas.nscc-cs.cn/external/api/v1   # 国家超算长沙中心 MaaS
  models: [ { id: Qwen3.5 } ]
```

已存档到 `refs/orb-config/`（`cordis.patch.yml`、`cordis.yml`、`orb-agent-models.json`，均不含密钥）。
`orb-agent-models.json` 显示 Orb 前台/后台用的都是 `cscs` + **Qwen3.5**——而 Qwen3.5 本身就是多模态的，所以这个端点理论上能同时喂后台 Agent 和视觉循环。

> 实测该 `CSCS_API_KEY` 已失效（`401 无效的令牌`），但端点本身活着。如果拿到新的 key，这条路可以复用。

## 原生输入工具（orb-input.exe）

windows-mcp 只有 `Click`（等价于按下+抬起连发），**没有把按下和抬起拆开的能力**，所以「长按」「按住拖动」「按住不放」这类操作做不了。`native/orb-input.exe` 用 Win32 `SendInput` 补齐这些原语。

它作为本地伪服务 **`orb`** 挂在 bridge 上（不经 MCP，不需要在连接器页面额外信任），界面上和另外两个服务一样看待。

| 工具 | 说明 |
|---|---|
| `long_press` | 按下 → 保持指定毫秒 → 抬起 |
| `mouse_press` | 只按下，不抬起（坐标传 `-1 -1` 表示就地操作，不移动光标） |
| `mouse_release` | 抬起 |
| `drag` | 按住 → 平滑移动 → 抬起 |
| `move_to` | 移动光标 |
| `cursor_position` | 读取当前鼠标位置 |
| `scroll_at` | 在指定位置滚轮 |

坐标是**物理屏幕像素**，与 windows-mcp 的 `loc` 同一坐标系（进程声明为 per-monitor DPI aware）。

### 编译

```powershell
powershell -ExecutionPolicy Bypass -File native\build.ps1
```

脚本会自动探测 MSVC 与 Windows SDK 并手工拼 `INCLUDE`/`LIB`/`PATH`。**刻意不调用 `vcvars64.bat`**——它内部要用 `reg.exe` 去注册表里找 VS/SDK，受限环境里 `reg.exe` 可能被安全策略拦掉，导致环境变量根本没设上，编译直接报 `C1083 找不到 stdio.h`。这个坑踩过一次。

本机实测路径：MSVC `D:\vs\VC\Tools\MSVC\14.51.36231`，SDK `D:\Windows Kits\10\Include\10.0.28000.0`（**注意两者都在 D 盘**，只查 C 盘会误判成"没有编译器"）。

> `build.ps1` 必须保存为**带 BOM 的 UTF-8**。Windows PowerShell 5.1 用 `-File` 执行时会按 ANSI(936) 读无 BOM 的 UTF-8 文件，中文会乱码并直接导致语法错误。

### 验证

用划词监听器当探针（它能观测全局鼠标状态），客观确认按下/抬起确实分离：

| 场景 | 观测结果 |
|---|---|
| `press` → 等 1.2s → `release` | `down(700,500)` … 1354ms 后 … `up dist=0` |
| `long_press 900ms` | `down` → 936ms → `up` |
| `drag 700→1000` | `down(718,500)` → `up dist=282` |

### 修复 koffi（DSH 依赖的原生模块）

后台轨道之前**从未真正跑通**。实测 `dsh_execute` 报：

```
dsh: Cannot find the native Koffi module; did you bundle it correctly?
```

原因是当初装 DSH 时本机还没有编译器，只能 `npm install --ignore-scripts` 跳过原生编译，koffi 一直是坏的。现在编译器有了，用 `native/build-koffi.ps1` 真正编译：

```powershell
powershell -ExecutionPolicy Bypass -File native\build-koffi.ps1
```

过程中踩了四个坑，都写进脚本注释了：

1. **`spawnSync` + 管道 stdio 在本环境返回 EBUSY**（异步 spawn 和 `stdio:'ignore'` 都正常）。cnoke 用它探测 cmake 和 ninja，探测全失败 → 误报「CMake 不可用」、生成器退回 MinGW。`native/patch-cnoke.mjs` 打最小补丁绕过。
2. **`vcvars64.bat` 要调被拦截的 `reg.exe`**，所以手工拼环境变量，并显式 `CMAKE_GENERATOR=Ninja`（否则 CMake 找 VS 也要查注册表）。
3. **SDK 的 `bin` 目录必须进 PATH**（`rc.exe`/`mt.exe` 在那）。漏了会报 `RC Pass 1: command "rc ..." failed ... no such file or directory`——报错里完全没提「找不到 rc.exe」，极易误判。
4. **`node.lib` 缺失**（本机这版 Node 是精简分发）。从 `https://nodejs.org/dist/v<ver>/win-x64/node.lib` 下载到 `.workbuddy/msvc-libs`，加进 `LIB`。

编译产物 `koffi.node`（1.46 MB）加载验证通过（koffi 3.3.1）。修好后 CLI 一路跑到模型调用：

```
dsh: AUTH: Authentication Fails, Your api key: ****FJdK is invalid
```

**也就是说整条链路已经通了，只差一个有效的 API key。**

## 划词自动弹出

**拖拽划选**一段文字后，工具条会自动出现在光标附近。实现上不依赖原生编译（DLL 注入与 Node Addon 这条路虽然现在有 MSVC 可用了，但侵入性强、易被杀软拦，没有必要），而是基于 Windows UI Automation：

1. `desktop/selection-watch.ps1` 常驻，轮询鼠标左键，检测「按下 → 抬起且拖动距离 > 8px」，即判定为拖拽划选；
2. 命中后读取**焦点元素**的 `TextPattern.GetSelection()` 拿到选中文字；
3. 主进程按光标位置弹出工具条。

两个关键细节，都是踩出来的：

- **必须用 `AutomationElement.FocusedElement`**。用 `FindFirst(Descendants, IsTextPatternAvailable)` 会命中页面里第一个带 TextPattern 的元素，而不是真正持有选区的那个，结果是永远读到空选区。
- **必须常驻并注册 UIA 事件订阅**。Chromium 只在检测到辅助技术客户端（`UiaClientsAreListening`）时才开启无障碍树。注册 `AutomationFocusChangedEventHandler` 后 Edge 才能被读到；一次性进程来不及激活就退出了。

**覆盖面**（实测）：

| 目标 | 自动取词 | 说明 |
|---|---|---|
| 原生应用（记事本等） | ✅ | UIA 直接读 |
| Edge / Chrome 等浏览器 | ✅ | 需常驻客户端激活无障碍树 |
| Electron 应用 | ❌ | 默认不开启无障碍树 |

Electron 应用需要走剪贴板降级（模拟 Ctrl+C），右键菜单里有开关 **「其它应用也用 Ctrl+C 取词（慎用）」**，**默认关闭**——因为 Ctrl+C 在终端里是「中断当前进程」，自动触发会打断你正在跑的命令。

降级路径会先备份剪贴板文字、读完立刻还原；如果剪贴板里是图片等无法还原的内容，则放弃本次取词，避免悄悄弄丢你的东西。

> **会和系统里已有的划词工具打架。** 本机是荣耀机器，装了 `C:\Program Files\HONOR\HNMagicAI`（YOYO 智慧助手）；Edge 自身也有划词条。它们和 Orb 会在同一次划选后同时弹出。想要干净体验，请在那些软件里关掉各自的划词功能。YOYO 是闭源第三方应用，没有对外 API/IPC，无法被复用或被 Orb 接管。

`demo-selection.html` 是验证用的测试页，双击即可打开。

## 语音输入模块

对齐 WorkBuddy 主界面的「麦克风按钮 → 录音 → 实时把转写文本灌进输入框」这套交互。识别引擎做成可插拔，因为**主界面那套是 WorkBuddy 云 ASR（端点与鉴权都绑 WorkBuddy 账号），第三方本地应用无法借用**，只能复制交互、换可插拔引擎。

### 怎么用

面板输入框左侧多了一个**麦克风按钮**（`#mic`），点击开始/停止；悬浮球右键菜单也有「语音输入」可远程唤起。识别结果实时写进输入框（流式 interim+final），你可以接着改、再发送。

### 两种识别引擎（设置面板「语音识别」里切换）

| 引擎 | 说明 | 配置 |
|---|---|---|
| `browser`（默认） | 浏览器内置 Web Speech API（`webkitSpeechRecognition`）。零配置，流式识别，且**不受页面 CSP 影响**。依赖 Chromium 的语音服务，需联网。 | 无 |
| `whisper` | OpenAI 兼容的 `/audio/transcriptions` 端点。录音完成后由**主进程 `asr-transcribe` 代为 POST**（绕开面板 CSP 只放行 127.0.0.1:19387），架构对齐主界面「daemon 负责网络、渲染层只管录音展示」。 | 填端点 + key + 模型；key 留空表示不改已存的 |

> 如果浏览器引擎点了没反应（某些 Electron 构建拿不到 Google 的识别后端），切到 whisper 端点即可。

### 关键实现点

- 麦克风权限：`main.js` 里 `session.defaultSession.setPermissionRequestHandler` 对 `file://` 页面放行 `media`/`microphone`，否则 `getUserMedia` / Web Speech 会被静默拒绝。
- 流式续接：`browser` 引擎在 `onend` 时若仍在录音就自动 `start()` 续上，保证连续说话不断流（与主界面流式转写行为一致）。
- 进程边界：`whisper` 的音频二进制走 `window.orb.asrTranscribe()` 交给主进程 `fetch`，密钥只在内存过一遍，不落盘、不写日志。
- 配置落盘：`set-voice` IPC 把 `{ engine, endpoint, model, apiKey, lang }` 存进 `orb-state.json`；`apiKey: null` 表示保留旧值（key 输入框留空即不改）。

### 文件

- `desktop/voice.js` — 完整语音模块（按钮、状态、两个引擎、`v-*` 设置接线）
- `desktop/main.js` — `state.voice`、麦克风权限、IP C`asr-transcribe` / `set-voice` / `voice-start`
- `desktop/preload.js` — 暴露 `setVoice` / `asrTranscribe` / `startVoice` / `onVoiceStart`
- `desktop/panel.html` — 视觉设置遮罩里的「语音识别」区 + 引入 `voice.js`

## 视觉决策循环（Computer Use）

原版 Orb 是「截图 → 视觉模型看截图输出坐标 → 执行点击」的闭环。这里同样实现，**模型可切换**。

闭环：`截图 → 交给视觉模型 → 模型输出一个动作 → 执行 → 再截图`，循环直到模型给出 `done`。

### 配置

面板右上角「**视觉**」。分**主力**和**备选**两个槽位，主力失败自动切备选：

| 预设 | 地址 | 默认模型 | 备注 |
|---|---|---|---|
| 混元 TokenHub | `api.hunyuan.cloud.tencent.com/v1` | `hunyuan-turbos-vision` | **新账号有 100 万 token 多模态试用额度**，有效期一年 |
| 混元 T1 Vision | 同上 | `hunyuan-t1-vision` | 深度视觉推理，更慢更准 |
| Qwen 3.5 | `dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3.5-plus` | 原生多模态，OCRBench 93.1 |
| Qwen3-VL | 同上 | `qwen3-vl-plus` | 专用视觉模型 |
| 智谱 GLM-4V / OpenAI / 自检 / 自定义 | — | — | — |

> **混元的坑**：老的混元多模态端点在 2026 年 6 月退役，模型迁到了 **TokenHub**。别再用 `hunyuan-vision` 这种旧名字，用 `hunyuan-turbos-vision` 或 `hunyuan-t1-vision`。
>
> **Qwen 3.5 的坑**：它是 hybrid-thinking 模型，**默认会先输出思考过程**，会把 JSON 解析搞乱。预设里已经带了 `enable_thinking: false`，换成自定义时记得手动加。

### 故障切换

每一步都会先试主力，失败才试备选；两边都失败才中断，并**把两边的原始错误一起报出来**：

```
第 1 步 · 视觉接口出错（主力与备选都不通）
主力：HTTP 401 ... "You can find your API key at https://console.cloud.tencent.com/hunyuan/start"
 ｜ 备选：HTTP 401 ... "For details, see: https://help.aliyun.com/zh/model-studio/error-code#apikey-error"
```

主力连续失败 2 次后，本次循环余下步骤直接走备选，避免每一步都白等一次超时。步进日志里每步都标注了**实际由哪个槽位回答**。

点「测主力 / 测备选」可以分别验证连通性，错误信息**如实回显上游原文**——直接告诉你该去哪里申请 key。
点「**列出可用模型**」直接向端点查真实清单（别靠猜名字），点条目即填入。

### 三个关键设计

**① 坐标用千分比（0–1000）而不是像素。** 2560×1600 这种分辨率下让模型直接给像素极易幻觉；千分比把输出空间压到 0–1000，且与图片实际尺寸解耦。

**② 模型可以主动 `zoom`。** 小图标、密集列表先放大再点，命中率明显提高。放大后的坐标按当前视野反算回屏幕千分比。

**③ 提供了 `reset`。** 这是实践里发现的：`zoom` 是相对当前视野的，模型一旦放大错了位置就再也缩不回来。加上 `reset` 才能救回。

### 动作集

```
click / type / hotkey / scroll / long_press / drag / wait / zoom / reset / done / ask
```

`ask` 用于在删除、支付、发送等不可逆操作前请求人工确认。

### 容错

- 输出解析容错：允许 markdown 代码块包裹、前后废话、尾逗号；解析失败会要求模型重出而不是直接中断
- 历史只保留最近 8 步且**只有当前一步带图**，控制 token 成本
- 每一步都可被「中断」按钮打断
- 需要「完全访问」权限才会启动（它真的会操作鼠标键盘）
- 循环期间观察边框常亮，能看清模型在看哪个窗口

### 为什么不用 WorkBuddy 云服务的免密钥通道

WorkBuddy 云服务里确实有一个**免密钥大模型调用**模块（`/.cloud/llm/chat/completions`），模型元数据里也有 `supportsImages` 字段。**但这条通道不能给 Orb 用**，三条硬约束（文档原文）：

| 位置 | 约束 |
|---|---|
| 错误表 `auth_` | 调用方的 **Origin** 必须匹配应用发布域名，否则直接拒绝 |
| Forbidden Patterns | 禁止 "Building a **BFF / Node API route / server proxy** to call the model service directly from the front end" |
| Safety Notes | "**Keyless is not protection-free**: the channel belongs to the **current app** — never expose it as an open proxy anyone can call" |

Orb 是本地 Electron 应用，源是 `file://`，直连必被 Origin 校验拒绝；而"让另一个软件借道消耗某个应用的额度"正是被明令禁止的代理模式。硬做等于盗用别人的通道，所以这里不做。

同理，**驱动网页版 AI 界面抓取回复**（把网页 AI 当接口用）也没有实现：它脆弱、依赖页面结构、且大概率违反服务条款。

正确做法就是用服务商自己发的 API key——所以「列出可用模型」这个按钮存在的意义就是：**别猜模型名，直接问端点要真实清单**。

### 关于接口代理

面板是 `file://` 页面，**直连这些 API 会被 CORS 拦死**（OpenAI / 混元等都不发 `Access-Control-Allow-Origin`）。所以请求统一走 bridge 的 `/api/vlm` 代理，由 Node 侧发出。密钥只在内存里过一遍，不落盘、不写日志。

### 自检模式

服务商选「**自检**」，无需 key 即可跑通整条链路（用脚本化响应替代真实模型）：

- 第 1 步 zoom → 验证视野裁剪与放大（图片从 671KB 变 411KB）
- 第 2 步 reset → 验证能退回全屏（图片回到 680KB）
- 第 3 步 click → 验证坐标换算并真的执行一次输入
- 第 5 步 done → 验证收尾

实测日志：

```
[selftest] 第 1 次请求，附带图片 671KB
[selftest] 第 2 次请求，附带图片 411KB
[selftest] 第 3 次请求，附带图片 680KB
[vision]   视野 {0,0,1000,1000} 模型坐标 800 400 -> 屏幕物理 2048 640
```

坐标换算可独立验算：`800/1000 × 2560 = 2048`、`400/1000 × 1600 = 640`，与日志一致。

> **自检模式验证的是「除第三方接口之外」的全部环节。** 本机现有凭据（DSH 里的 `DEEPSEEK_API_KEY`、`CSCS_API_KEY`、账号 token）实测对公开 API 全部返回 401，所以真实模型调用需要你自己填一个有效 key。

输入框按内容自动分流，也可用底部「自动 / 前台 / 后台」强制指定。

**前台**（走 windows-mcp，19 个 GUI 工具，当场执行、结果直接回显）：

| 说法 | 动作 |
|---|---|
| `打开 记事本` | 启动应用 |
| `打开网页 example.com` | 默认浏览器打开 |
| `打开文件夹 D:\work` | 资源管理器打开 |
| `输入 你好` | 键入文字 |
| `点击 500,300` / `双击` / `右键` | 指定坐标点击 |
| `按 ctrl+c` | 快捷键 |
| `滚动 下 3` | 滚动 |
| `等待 1000` | 等待 |
| `读剪贴板` / `复制 内容` | 剪贴板读写 |
| `截图` / `看屏幕` / `窗口` / `应用列表` | 屏幕与窗口信息 |
| `长按 500,300 800` | 在该点按住 800ms 再抬起（走原生服务） |
| `按住拖动 500,300 900,300` | 按住平滑拖过去（走原生服务） |
| `按住` / `释放` | 在鼠标当前位置按下 / 抬起，可手工组合 |
| `鼠标位置` | 读取当前光标坐标 |

不符合上述语法的内容全部派给后台（`workbuddy_execute` → WorkBuddy 内置的 CodeBuddy CLI）。派发立即返回，可在后台跑的同时继续派发别的任务；面板每 2 秒轮询进度，完成后结果自动回填。

> 后台会话看不到我们的对话，委派内容必须自包含：文件路径、要做什么、期望产出，一次写全。

## 健壮性与安全

### 接口鉴权（重要）

bridge 能执行任意 PowerShell、控制鼠标键盘。只靠 `Access-Control-Allow-Origin: *` 而不鉴权的话，**用户浏览的任意网页都能 `fetch('http://127.0.0.1:19387/api/call', …)` 遥控这台机器**——等于远程代码执行。

现在每个 `/api/*` 请求都必须带 `X-Orb-Token`：

- bridge 启动时随机生成令牌，在 `listen` **之前**写进 `orb/.bridge.json`
  （顺序很重要：主进程的策略是「等端口通 → 读文件」，端口先通而文件还是旧令牌的话会全线 401）
- 主进程读到后通过 IPC 交给面板；面板所有请求自动带上，遇到 401 会自动重取一次再试（覆盖 bridge 重启换令牌的情况）
- `CORS` 的 `Access-Control-Allow-Headers` **必须包含 `X-Orb-Token`**，否则预检不通过，浏览器根本不会发出真正的请求
- 只有 `/api/health` 免鉴权（存活探测，不泄露信息）

实测：无令牌 `401`、错令牌 `401`、正确令牌放行。

### 其它加固

| 措施 | 防的是什么 |
|---|---|
| **单实例锁** | 启动两次会出现两颗悬浮球、两套全局快捷键，托盘图标互相覆盖 |
| **划词监听自动重启** | 进程静默崩溃会让划词"有时候不弹"，事后完全查不出；带退避重试，连续 5 次失败才放弃，稳定运行 20 秒后重置计数 |
| **主进程全局异常兜底** | `uncaughtException` / `unhandledRejection` 全部落日志，不再静默吞掉 |
| **日志文件** | `%APPDATA%/orb-desktop/orb.log`，超过 2MB 自动清空；bridge 的 stdout/stderr 也转发进去 |
| **消息落盘截断** | 单条超 4000 字符截断、每会话最多 200 条——否则一条超长输出会撑爆 localStorage，之后整份历史都写不进去 |
| **bridge 退出可见** | 记录退出码，不再出现"服务莫名全红却不知道为什么" |

### 为什么"填 API Key 时没法粘贴"

实测结论：**Ctrl+V 本身是好的**（打字、普通输入框粘贴、密码框粘贴三种情况都用 SendInput 实测通过，密码框也正常出现圆点）。真正的坑是另外两个：

1. **Electron 默认没有右键菜单。** 右键点输入框选"粘贴"什么都不会发生——很多人就是靠右键粘贴的，体感就是"粘贴用不了"。
2. **面板未固定时，鼠标一移开就自动折叠。** 用户去浏览器复制 Key 的这几秒里，面板已经关了。

对应修了三处：

- 建了一份带编辑角色的**应用菜单**（撤销/重做/剪切/复制/粘贴/全选，中文标签），保证快捷键存在；
- 给所有窗口挂了**右键编辑菜单**（输入框内右键有"粘贴"），非输入框但有选中文字时给"复制"；
- 打开视觉设置时**按住面板**（`setHold`），鼠标移开不折叠，取消/保存后恢复；
- 另外给两个 Key 输入框加了 **「粘贴」按钮**：一键读剪贴板填入，完全不依赖键盘快捷键。

## 权限分级

面板右上角三档，随会话保存，切换即时生效：

- **只读** —— 前台后台都拦住
- **工作区可写** —— 允许 GUI 操作，不允许跑命令
- **完全访问** —— 含 `PowerShell`

## 观察边框

前台执行动作时，被操作窗口四周会亮起一圈紫色边框，执行结束后约 2.4 秒淡出。

实现要点：点击我们自己的面板会让焦点变成面板，所以不能只看"当前前景窗口"。程序维护一个**最近一个不属于自己的前景窗口**的记录，边框画在它上面；最大化窗口的矩形超出屏幕时会把边框夹进屏幕范围，避免被裁掉看不见。

只有在你接触悬浮球/面板时才启动探测，闲置时不跑 PowerShell，不空转。

## 坐标编码

右键菜单可切换 **像素 / 千分比（0-1000）**。千分比模式下输入的坐标会按屏幕分辨率换算成像素再发给底层工具。手工输入坐标时可留空，用当前鼠标位置。

## 架构

```
desktop/main.js               Electron 主进程：双窗口 + 工具条 + 边框窗口、
                              自定义拖拽（轮询光标）、贴边收纳、托盘、右键菜单、
                              全局快捷键、观察边框追踪、划词监听、拉起 bridge
desktop/selection-watch.ps1   划词监听器（常驻 PowerShell：UIA 客户端 + 鼠标轮询）
desktop/preload.js            contextBridge 暴露的 window.orb API
desktop/voice.js              语音输入与识别模块（麦克风按钮 + 可插拔识别引擎）
desktop/ball.html             悬浮球（透明无边框窗口，72×72）
desktop/panel.html            面板（透明无边框窗口，400×600）
desktop/toolbar.html          划词工具条（216×44）
desktop/border.html           观察边框（点击穿透）
native/src/orb-input.c        原生鼠标原语（SendInput）
native/build.ps1              自动探测 MSVC/SDK 并编译
native/dist/orb-input.exe     编译产物
bridge.mjs                    HTTP 桥：两个 MCP server + 一个本地伪服务 orb，端口 19387
orb.html                      早期单页版本，保留作参考
demo-selection.html           划词功能验证页
```

主进程启动时先探测 19387 端口，已在运行就复用，否则拉起 `bridge.mjs` 并在退出时回收。

## 与 DeepSeek Orb 的功能对照

已还原：悬浮球常驻置顶、悬停展开、单击固定、指针离开折叠、拖动换位与记忆、拖出边缘收纳成灰色细签、悬停滑回、右键菜单、前台 Computer Use、后台 Code Agent 派发、派发后继续对话、Access 权限三档、会话历史与新建、输入框自动生长、观察边框、**划词自动弹出**、**语音输入**、更换头像（PNG/JPG/GIF/WebP，2MB 上限）、坐标编码切换、全局快捷键、托盘、零遥测。

未还原：

- **Electron 应用的划词自动弹出**需要开启剪贴板降级（默认关闭的原因见上）。
- **Computer Use 没有视觉决策循环**。原版让模型看截图自己判断点哪里；这里没有接入视觉模型，坐标由人指定。
- 逐次点击审批、屏幕圈选截图 —— 底层工具没有对应原语。

（原版有而这里已补齐的：**长按 long_press**、按住/释放、按住拖动 —— 见「原生输入工具」。）

## 全链路自检

`node selftest.mjs` 一键跑完整链路检查，27 项断言，退出码 0 表示全绿：

```
[1] 启动产物   令牌文件、bridge 存活
[2] 令牌鉴权   无令牌/错令牌 401、正确令牌放行
[3] 三服务      orb(7) / windows(19) / dsh(5) 全部在线
[4] orb 原生    cursor/move/long_press/drag/press/release/scroll 逐个实调
[5] windows-mcp DisplayInventory/Clipboard/Process/Screenshot 抽查
[6] dsh         dsh_status 可解析 CLI、已注入 key
[7] 异常边界    未知服务、未知工具、畸形 JSON、404 jobId、时长下限、视觉缺参
[8] 面板可用性  能取到整屏截图
[9] 真实后台任务（--full 才有）  让 Agent 建一个文件并校验内容，用完即删
```

默认不跑真实模型调用（不消耗额度），加 `--full` 才会。
自检只做只读或落在自身面板消息区内的操作，不乱动桌面。
它已经抓住过三个真 bug（long_press 超时小于时长上限、日志文件因 statSync 先抛 ENOENT
而从未创建、以及后台任务的目标文件被放到了错误的目录）。

## 后台轨道已跑通（附排查过程）

先说结论：**后台 Agent 能真正干活了**。`node selftest.mjs --full` 会让它创建一个文件再校验内容，实测通过：

```
模型回复: 文件 orb-agent-proof.txt 已成功创建，包含内容 "ORB-AGENT-OK"
changedFiles: 1   A orb-agent-proof.txt (added)
验证: 文件存在 ✓  内容 "ORB-AGENT-OK"
```

### 关键一步：把可用模型接进 headless profile

本机 `DEEPSEEK_API_KEY` 是失效的，但 `maas.nscc-cs.cn` 网关（Orb 当年那个 cscs）上有一个可用的 `Qwen3.5`。把 Orb 的 provider 注册方式搬到 `orb-dsh/profiles/headless/cordis.patch.yml`：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      cscs:
        apiKeyEnv: CSCS_API_KEY
        api: openai-responses
        baseURL: https://maas.nscc-cs.cn/external/api/v1
        models: [ { id: Qwen3.5, name: Qwen3.5 } ]
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: cscs
    model: Qwen3.5
```

### 踩到的坑：两把 key 不是同一把

用户在「视觉设置 → 备选」里填的可用 key，和 `refs.CSCS_API_KEY`（DSH 实际读取的那把）**不是同一个**（都是 51 位，但内容不同）。
直接跑 CLI 传视觉槽的 key 能成功，经 bridge 走就 AUTH 失败——因为 bridge 用的是凭据文件里的旧值。

用 `sync-agent-key.mjs` 把视觉槽里可用的 key 同步回我们自己的凭据副本即可。
**改 YAML 时务必注意缩进**：`refs` 下的键是带缩进的，正则若不匹配缩进会误在顶层新增一条，而 `refs` 里的旧值根本没被改掉。

### 视觉循环目前走不通

这个网关**没有视觉模型**：

| 探测 | 结果 |
|---|---|
| `/models` | 只有 `Qwen3.5` 一个 |
| `Qwen3-VL` / `qwen3-vl-plus` / `Qwen2.5-VL-72B` / `qwen-vl-max` | 全部 `503 model_not_found` |
| `Qwen3.5` 传图 | `400 At most 0 image(s) may be provided` |

即该端点**明确拒绝图片输入**。文本能力正常（实测能回答）。要启用视觉循环，需要换一个真·视觉端点，例如：

- 百炼 `qwen3-vl-plus`（`https://dashscope.aliyuncs.com/compatible-mode/v1`）
- OpenAI `gpt-4o`
- 混元 `hunyuan-turbos-vision`（需要腾讯云 key）

在「视觉设置」里填对应地址 + key，点「测主力」验证即可。

## 已知限制

- **管理员权限的窗口**拒绝被点击和输入（Windows 系统级限制，官方 Orb 同样如此）。
- 悬浮球全局置顶在部分全屏独占游戏下可能被覆盖。
- 主进程会输出 `[open-panel] / [close-panel] / [drag-end] / [border]` 日志，便于排查交互问题。

## 后台后端：CodeBuddy CLI（官方原生版）

「后台」轨道不再调用 DeepSeek Harness，改为调用 **官方 CodeBuddy Code CLI**
（腾讯出品，与 WorkBuddy 同源；原生独立可执行文件）：

- 位置：`D:\orb-tools\codebuddy-cli\codebuddy.exe`（v2.158.0，装在 **D 盘**，不占 C 盘）
- 目录总大小：约 178MB（含同目录 `vendor/sandbox/*`）
- 调用：`codebuddy.exe -p "<任务>" --output-format json --permission-mode bypassPermissions`
- 会话 / 账号：CLI 自己的 `%USERPROFILE%\.codebuddy`

> **为什么不用 WorkBuddy 安装目录里自带的那份？**
> `D:\workbuddy\resources\app.asar.unpacked\cli\` 只打包了 **headless** bundle。
> 我解析过 `app.asar` 的完整文件表：`/cli/dist/` 下**没有** TUI 产物 `codebuddy.js`，
> 所以 `bin\codebuddy` 的交互分支必然 `MODULE_NOT_FOUND`，既无法交互登录，headless 独立跑也不通。
> 因此改用官方完整版原生 CLI（自带 TUI，可登录，也可 `-p` headless）。

### 首次使用需登录一次

双击 **桌面 `codebuddy-login.cmd`**（其内部就是运行上面那个 exe），首次会弹浏览器 / 扫码登录。
登录成功后退出 CLI，**重启 ORB**，后台任务即可复用该会话。

### 环境变量覆盖

- `ORB_WB_CLI`：CLI 可执行文件路径（默认上面 D 盘的 exe；若指向 `.js/.mjs` 会自动改用 node 启动）
- `ORB_WB_CWD`：后台任务的工作目录（默认 `orb` 的上级，即工作区根）

### 重装 / 升级

npm registry 在本机不可达，走官方**原生安装器**（腾讯 COS，可达）：

```powershell
irm https://copilot.tencent.com/cli/install.ps1 | iex
```

或手动下载 `codebuddy-code_Windows_x86_64.zip`
（`https://acc-1258344699.cos.accelerate.myqcloud.com/@tencent-ai/codebuddy-code/releases/download/<版本>/`）解压即用，
该站同时提供 `checksums.txt` 供校验。
