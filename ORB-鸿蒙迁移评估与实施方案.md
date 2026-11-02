# ORB 控制台 · 开源鸿蒙（OpenHarmony / HarmonyOS NEXT）迁移评估与实施方案

> 配套文档：`ORB-HarmonyOS-演进路线图.md`（概念级规划）。
> 本文在其基础上，**基于代码实测测绘 + 官方能力验证**，给出量化的工作量、可行性逐项判定与可落地实施方案。
> 适用基线：ORB 控制台 v1.4.2（Electron + Windows 深度绑定）。
> 撰写时点：2026-10-29。

---

## 一、结论摘要（先给判断）

1. **可行性 =「整体重写」，不是移植。** 当前代码约 23,600 行 JS/HTML + 5 个 Windows 原生 `.exe`（2,551 行 C），零运行时 npm 依赖。其中约 **10–15% 可原样复用或轻量移植**（产品 DNA），**85–90% 必须重写**。
2. **4 项招牌能力在鸿蒙上被削弱或需语义重构**：任意窗口截屏/取词、前台窗口操控（windows-mcp）、Snipaste 集成、磨砂背景（此项反而更简单）。其中前三项受**系统隐私策略硬限制**，无法通过调高权限绕过（已用官方文档核实）。
3. **工作量**：单开发者做出功能接近的 v1 约 **18–35 人周**（含降级范围）；其中产品 DNA 抽取（现在就能在 Windows 上做）约 **1–2 周**。
4. **最大不确定项不是技术，是设备目标**：手机/平板生态成熟但"桌面悬浮多窗"形态错配；PC 鸿蒙仍早期，调试成本高。这点不定，方案无法收敛。

---

## 二、技术栈对照

| 维度 | 现状（Electron + Windows） | 鸿蒙目标（ArkTS + ArkUI） | 备注 |
|---|---|---|---|
| 运行时 | Chromium 渲染 + Node 主进程 | ArkUI 声明式 + ArkTS 逻辑线程 | 无 Node、无 DOM |
| UI | `panel.html` 内联 DOM/CSS（13,900 行） | ArkUI 组件树（ets） | 全部重写，数据/交互可搬 |
| 进程/IPC | `BrowserWindow` 多窗 + `ipcMain`/`contextBridge`（79 请求 + 23 事件通道） | `UIAbility`/`ExtensionAbility` + 自建事件总线 / `commonEvent` | 契约名可保留，实现重写 |
| 屏幕录制 | MediaRecorder `avc1.42E01E` / DXGI+MF 原生 `.exe` | `AVScreenCapture` + `AVRecorder`（mp4/H.264） | 容器/编码假设**可延续** |
| 截屏/取词 | 藏窗自截桌面 + 两阶段 OCR + 剪贴板监听 | `AVScreenCapture`（限本应用/用户 Picker）+ `Core Vision Kit` OCR + 无障碍 | **不能截任意窗口/IME/系统 UI** |
| 磨砂背景 | `glassbg.js` 自截桌面绕 DWM | ArkUI 原生 `.blur()` / `blendMode` | **更简单，反成优势** |
| 托盘/快捷键 | `Tray` / `globalShortcut` | 服务卡片 / 胶囊 / 后台 `Service` + `Want` | 入口形态变更 |
| 前台操控 | `windows-mcp`（控 Windows 窗、SendInput） | 无等价 → 分布式软总线控**其他鸿蒙设备** | 语义变更或砍掉 |
| 语音 | Web Speech + 本地 Whisper（Python venv） | 云端 ASR / 端侧 `SpeechRecognizer`（无 Python 运行时） | 离线方案需换 |
| 智能体后台 | WorkBuddy CLI（HTTP/RPC，跨平台） | 后台 `Service` + 同款 CLI 调用 | **可复用** |

> ⚠️ 术语澄清：纯 OpenHarmony（开源基线上游）用 `@ohos.*` 接口，且缺部分 HarmonyOS NEXT 的 `@kit.*` Kit（如 CoreVisionKit、部分 MediaKit 封装）。**参赛/商用通常目标 HarmonyOS NEXT**（即"开源鸿蒙大赛"实际运行环境）。本文按 HarmonyOS NEXT（`@kit.*`）能力评估；若严格纯 OpenHarmony，CoreVisionKit OCR 需改用 `@ohos` 等效或三方 OCR 库，工作量略增。

---

## 三、代码测绘与可移植性（逐文件实测）

源码扁平置于 `orb/desktop/`，打包目标仅 `win x64`。

| 模块 | 文件 | 行数 | 移植判定 |
|---|---|---|---|
| main | `main.js` | 5,340 | **必重写**（窗口/托盘/IPC/剪贴板/对话框/全局快捷键） |
| preload | `preload.js`(227)+`pick`(20)+`recbar`(43) | 290 | **接口清单保留**，实现重写 |
| panel | `panel.html`（无独立 panel.js，JS 内联） | 13,900 | **必重写到 ArkUI**（人格/触发/审计/Ctrl+K 全在内） |
| recbar / ball / border / pick / subtitle / toolbar | 6 个 html | ~1,900 | 必重写（悬浮窗体系） |
| glassbg | `glassbg.js` | 424 | **删除**（ArkUI 原生模糊替代） |
| snipaste | `snipaste.js` | 370 | **必重写**（软件不存在） |
| storage | `storage.js` | 426 | ✅ 轻量移植（仅 `shell.openPath` 一处换系统打开） |
| voice | `voice.js` | 425 | ⚠️ 轻量移植（Web Speech→端侧/云端 ASR） |
| mp4finalize | `mp4finalize.js`(320)+`cap-native.js`(385) | 705 | ✅ `mp4finalize` 纯 JS 复用；`cap-native` 桥接重写 |
| 原生 C `.exe` | `orb-cap/foreground/input/selection/sfx.c` | 2,551 | **必重写**（DXGI/MF/Win32/OCR 全无等价） |

**Electron 主进程 API 命中（main.js）**：`screen` 40 / `ipcMain` 38 / `app` 38 / `clipboard` 22 / `BrowserWindow` 11 / `Menu` 6 / `globalShortcut` 6 / `Tray` 3 / `desktopCapturer` 3 / `dialog` 7。缺 `BrowserWindow`/`screen`/`ipcMain`/`app` 任一则 app 无法启动——这四项是中枢，必须被 ArkUI/Ability 体系彻底替换。

**可原样复用的产品 DNA（与平台无关）**：
- 五人格数据：`PERSONAS` / `DIALECT` / `PERSONA_SPEC` / `PERSONA_ACTION` / `GIFS(7张)`（gentle/genki/comrade/guide/tsundere，**id 严禁改名**）→ 纯数据搬进 ArkTS 常量。
- 流式回传协议规则：按 `j.id === undefined` 认握手（v1.4.2 根因修复，必须继承）。
- 主题令牌分化思想：`--accent/-soft/-fg` 等映射 ArkUI `Resource` + `ColorMode`；保留"浅色底能量色禁作文字色""消息区永不加模糊"等约束。
- 存储 schema：`recordings/history/screenshots` + `orb-state.json`/`custom-model.json` 纯数据。
- 自定义模型接管后台任务：CLI 模型清单 + `--model custom-local:<id>` 前缀剥离，WorkBuddy CLI 跨平台经 HTTP/RPC 复用。

---

## 四、可行性逐项判定

| 能力 | 鸿蒙可行性 | 说明 |
|---|---|---|
| 五人格陪伴 UI | ✅ 高 | 纯前端，ArkUI 重写即可 |
| 人格/台词/主题数据 | ✅ 高 | 纯数据直接搬 |
| 智能体编排 + CLI 桥接 | ✅ 高 | 核心在外部 WorkBuddy CLI，架构延续 |
| 录屏（本应用内） | ⚠️ 中 | `AVScreenCapture`+`AVRecorder` 可做，但**不能录 IME/系统 UI/其他应用隐私窗**（已核实） |
| 截屏/取词 | ⚠️ 中 | `AVScreenCapture` 可截**整屏（含其他应用窗口）**；隐私窗(IME/密码/系统UI)采不到；全局剪贴板监听无等价，需无障碍+OCR 折中 |
| 磨砂背景 | ✅ 高（反而更简单） | 删除 glassbg，用 ArkUI 原生模糊 |
| 托盘/全局快捷键 | ⚠️ 中 | 改服务卡片/胶囊/后台 Service，入口形态变 |
| 前台窗口操控（windows-mcp） | ⚠️ 中/需授权 | 有路径：`AccessibilityExtensionAbility`+`gestureInject`（需用户授权无障碍）+ 现有 RPA 工具(iEasyClick/Airtest/AScript) + 鸿蒙7 Agent 框架；无原始 SendInput 注入 |
| Snipaste 集成 | ❌ 不可行 | 软件不存在，截图 UX 需从零自研 |
| 本地离线语音（Whisper/Python） | ⚠️ 中 | 无 Python 运行时；改用端侧 `SpeechRecognizer` 或云端 ASR |
| 附件/触发器/审计/急停/Ctrl+K 前端 | ✅ 高 | 纯前端逻辑可搬 |

**硬阻塞（无等价或平台级限制）**：
1. `AVScreenCapture` 隐私窗口排除策略——IME、状态栏、密码框、标记为 PRIVACY 的窗口**默认不采集**，普通应用无法绕过（官方论坛确认）；**但普通应用仍可截/录整屏（含其他应用的正常窗口）**，只是采不到上述隐私窗。
2. 跨进程/跨应用的**原始输入注入（SendInput）**在鸿蒙沙箱模型下不存在；但**无障碍路径**（`AccessibilityExtensionAbility` + `gestureInject` 节点点击/坐标手势）可实现受限的跨应用操控，现有 RPA 工具(iEasyClick/Airtest/AScript)与鸿蒙7 Agent 框架均已验证；前提是用户授权无障碍或设备/系统级通道。
3. Snipaste 闭源 Windows 软件无鸿蒙版。
4. 系统托盘 / 全局热键概念不存在。
5. 捆绑的 Windows x64 二进制（5 个 `.exe` + Python venv）无法在鸿蒙运行。

---

## 五、工作量估算（分层，单开发者人周）

| 阶段/层 | 当前规模 | 目标工作量 | 说明 |
|---|---|---|---|
| Phase 0 产品 DNA 抽取 | ~2,000 行 + 数据 | **1–2 周** | 现在即可在 Windows 做，不依赖鸿蒙环境 |
| Phase 1 ArkUI 陪伴 UI + CLI 探针 | panel 13,900 行 DOM | **4–8 周** | 重写到 ArkUI，含人格切换/台词/主题/模糊验证 |
| 智能体编排/审计/急停/触发器前端 | ~1,500 行内联 | 含在 Phase 1 | 纯前端逻辑 |
| Phase 2 OS 集成层（Ability/Window/IPC 总线/剪贴板/选择器/后台 Service） | main.js 5,340 | **4–6 周** | 替换 79+23 IPC 通道实现 |
| 录屏（AVScreenCapture+AVRecorder） | 705 行桥接 | **2–3 周** | 降级范围，补 mp4finalize 复用 |
| 截屏/取词（CoreVisionKit OCR + 无障碍） | 370+424 行 | **2–3 周** | 降级：限本应用/用户选窗 |
| 语音（端侧/云端 ASR） | 425 行 | **1–2 周** | 含离线→在线方案切换 |
| 入口形态（卡片/胶囊/Service 替代托盘） | 3 处 | **1–2 周** | |
| 打包/签名/HAP/上架 | — | **1 周** | DevEco + 证书 + 真机调 |
| **合计（含降级）** | — | **≈18–35 人周** | 不含 windows-mcp 等效；若保留跨设备协同 +2–4 周 |

> 标注：上述为"功能接近 v1"的乐观下限；首次踩坑 ArkUI/AVScreenCapture 的隐私边界、模拟器局限会拉长 Phase 1–2。

---

## 六、实施方案（分阶段，含出口标准）

### Phase 0 — 产品 DNA 抽取（现在可做，1–2 周）
- 从 `panel.html` 抽出五人格/台词/指纹/动作/动图为独立 TS 常量模块；人格 id 锁定。
- 把流式协议、`id===undefined` 握手规则、智能体编排抽成平台无关规范。
- 封装 `mp4finalize.js`、`storage.js` 为纯逻辑模块（去 Electron 依赖）。
- **出口**：一份「平台无关资产清单」+ 可单独 import 的 TS 模块 + 协议规范文档。

### Phase 1 — 可行性探针（最小 Demo，4–8 周）
- ArkTS/ArkUI 重写五人格陪伴界面（纯 UI）。
- 用后台 `Service` + HTTP/RPC 跑通「人格切换 + 台词调用 + WorkBuddy CLI 调用」。
- 验证关键点：`ArkUI .blur()` 替代 glassbg；主题令牌映射；CLI 模型桥接；性能从第一天分段埋点。
- **出口**：能在模拟器/真机跑的陪伴 Demo（截图/录屏/操控先不做）。

### Phase 2 — 能力重建（最难的 OS 集成层）
- 截屏/取词：`AVScreenCapture`（限本应用）+ `Core Vision Kit` OCR + 无障碍。
- 录屏：`AVScreenCapture` + `AVRecorder`（mp4/H.264），复用 `mp4finalize`。
- 入口形态：服务卡片/胶囊/后台 Service 替代托盘与全局快捷键。
- 语音：端侧 `SpeechRecognizer` 或云端 ASR。
- **出口**：具备「陪伴 + 智能体 + 本应用内截图/录屏 + 语音」的鸿蒙版。

### Phase 3 — 三通道重新映射
| 原三通道（Windows） | 鸿蒙新映射 |
|---|---|
| 前台 `windows-mcp`（控 Windows 窗） | **分布式软总线**（跨鸿蒙设备协同）；或**砍掉该通道** |
| 原生 ORB（陪伴/截图/取词/录屏） | 原生 ArkUI 陪伴层 + Phase 2 能力 |
| 后台 WorkBuddy CLI Agent | 后台智能体 Service（HTTP/RPC 复用） |

### Phase 4 — 上架/参赛化（可选）
- 对接 HarmonyOS 应用市场 / 开源鸿蒙相关赛道；需先解决设备目标与（如涉及）参赛资格前提。
- 注意：PC 鸿蒙生态仍在早期，优先手机/平板目标更稳。

---

## 七、需你拍板的关键决策点

1. **设备目标**：手机/平板（生态成熟，但"桌面悬浮多窗"形态需重设计）vs PC（形态匹配，但 OpenHarmony PC 早期、调试贵）。**这是方案能否收敛的第一前提**。
2. **是否保留"跨设备协同"通道**：用分布式软总线重建"设备协同"语义，还是直接砍掉 windows-mcp 那条通道。
3. **截屏范围接受度**：接受"仅本应用画面 + 用户 Picker 选窗"（系统隐私硬限制），还是坚持"任意桌面截屏"——后者在鸿蒙上不可行。
4. **离线语音 vs 云端 ASR**：是否接受联网 ASR（更简单、更准），还是要求端侧离线（隐私好但能力弱）。
5. **目标系统**：HarmonyOS NEXT（`@kit.*`，参赛/商用现实路径）vs 纯 OpenHarmony（`@ohos.*`，OCR 等需换方案）。

---

## 八、风险清单

| 风险 | 等级 | 缓解 |
|---|---|---|
| 设备目标不定 → 方案发散 | 高 | 先决策 §七.1 |
| 截屏/操控受隐私策略硬限，招牌体验降级 | 高 | Phase 0 起就对用户明示范围，重设计交互 |
| 现有 1.4.2 Windows 层优化全部作废 | 高 | 接受"重写"定位，不抱"改几行"幻想 |
| ArkUI/AVScreenCapture 首踩坑 + 模拟器局限 | 中 | Phase 1 尽早真机验证 |
| 主进程/Ability 顶层碰受限 API → 静默失效 | 中 | 继承 Windows 同款事故预防：模块顶层禁碰受限 API |
| 流式协议握手规则被改回 `j.ready` → 吞应答 | 中 | 强制继承 `id===undefined` 认握手 |
| PC 鸿蒙生态早期，调试/文档不全 | 中 | 优先手机/平板；保留降级形态 |

---

## 九、建议定位

- **今年主力仍放现有 Electron 架构**（如湖南省智能体创新赛道等纯线上、无路演路径）。
- 把 **Phase 0（DNA 抽取）现在就做**——零风险、不依赖鸿蒙环境，且能反向清理现有代码。
- Phase 1–4 作为 **2027 技术储备**：待设备目标（§七.1）与参赛/上架前提明确后再启动全量重写。
- 不要低估"重写"二字：这不是迁移，是用 ORB 的产品 DNA 在鸿蒙上**再造一个应用**。

---

## 十、补充：社区已有建议与实际方案（2026-10-29 调研）

网上不仅有人讨论，已有**两套成熟思路 + 真实可跑项目**，对本评估的"必重写"结论需做修正。

### 思路 A — 让 Electron 直接在鸿蒙上跑（实际方案，已有成功案例）
- 华为路线 `libelectron`（`atomgit.com/openharmony-sig/electron` / `openharmony-electron`）：把 Chromium/Node/V8 按 OHOS 重编译为 `.so` + resfile，配 ArkTS `web_engine` HAR 桥接窗口/剪贴板/文件等系统能力；应用 JS 产物塞进 `resfile/resources/app`，业务代码几乎不动。
- `ElectronEgg v5`：同一套代码除 Windows/Mac/Linux 外可直接跑 HarmonyOS（测试阶段但链路跑通）。
- `CPF-Electron`（`atomgit.com/CPF-Electron`）：定位"现有 Electron 项目迁移"，支持窗口/菜单/托盘/本地文件。
- 真实案例：**PicGo**（Electron 应用）已适配鸿蒙，只改平台差异（托盘、迷你窗、启动模式、静态路径、原生 addon），主进程/preload/渲染照旧。
- 最简 Web 容器：纯 Web 应用可直接用 ArkUI `Web` 组件加载 `rawfile/*.html`，零改代码。
- ⚠️ 代价：包体大（~180MB vs 原生 12MB）、启动慢（~1800ms vs 320ms）、内存高（~380MB vs 95MB）；**AppGallery 要求网页渲染必须用 ArkWeb，自带 Chromium 可能合规被拒**（已有 PoC 但需处理）。

### 思路 B — 原生 ArkTS 重写（主流建议）
- 多篇深度文明确反对"直接移植"：建议把 Electron 应用拆为 **界面层 / 逻辑层 / 系统能力层** 三层，只用 ArkTS 重写界面与系统能力层（腾讯云、CSDN 社区文）。
- 决策矩阵：纯桌面工具 Electron 足够；需上架华为市场或多设备协作者优先鸿蒙原生。

### 对 ORB 的含义（关键修正）
- 思路 A 能**省掉约 16,000 行 UI 重写**（panel/recbar/ball 等 DOM→直接跑），把 Phase 1 从 4–8 周压到 1–2 周适配。
- 但 **ORB 真正的差异化在 Windows 深度集成层**：Snipaste、DXGI+MF 原生录屏、windows-mcp 前台操控、glassbg 自截桌面——这些依赖的 Windows API 在鸿蒙上**即使 Chromium 跑起来也不存在**，必须重写成 ArkUI/ArkTS 系统能力（AVScreenCapture / 软总线 / CoreVisionKit OCR / 原生模糊）。
- 思路 A 还**偏鸿蒙 PC**（ORB 是桌面工具，这反而契合），但有上架合规与性能代价。
- **结论修正**：本评估"85–90% 必重写"对 ORB 的**功能差异点**依然成立；但若走思路 A，可大幅砍掉纯 UI 重写量，把精力集中到无法回避的 OS 集成层。建议把"思路 A 可行性探针"加入 Phase 1 作为并行选项。

---

## 十一、派 A vs 派 B：最终产品差异、功能限制与解决方案（2026-10-29 调研）

本节基于社区已验证的 libelectron / ElectronEgg / CPF-Electron 实际行为（含多位开发者真机踩坑记录），对 ORB 做逐能力对照。

### 11.1 最终产品形态差异

| 维度 | 派 A：Electron 跑在鸿蒙上 | 派 B：原生 ArkTS 重写 |
|---|---|---|
| UI 代码 | 现有 DOM/CSS 几乎原样跑（~16,000 行省掉重写） | 全量重写为 ArkUI（~16,000 行 → ArkTS） |
| 运行时 | 包内自带 Chromium+Node（libelectron.so ~172MB） | 方舟运行时 AOT，无 Chromium |
| 包体 / 启动 / 内存 | ~180MB / ~1800ms / ~380MB（基准实测） | ~12MB / ~320ms / ~95MB |
| 上架合规 | AppGallery 要求网页渲染用 ArkWeb，自带 Chromium 有被拒风险（PicGo/JupyterLab 已实证可上架，但需处理） | 原生合规，无此问题 |
| 目标设备 | 偏**鸿蒙 PC**（libelectron/ElectronEgg 均 PC 向） | 手机/平板/PC 全适配 |
| 系统能力获取 | 经 web_engine HAR 桥接（窗口/剪贴板/文件框/通知部分可用） | 直接用 `@kit.*` 系统能力 |
| 磨砂玻璃 | CSS `backdrop-filter`（Chromium 原生支持）→ **几乎免费** | ArkUI 原生 `.blur()` |
| 多窗口 | `@ohos.window.create()` 桥接替代 `BrowserWindow`（可用，但多显示器定位可能受限） | ArkUI `Window` API（手机上形态需重设计） |
| 维护模型 | 跟进上游 Electron 即可，UI 改动零成本 | 每次 UI 变动都要 ArkTS 重写 |

### 11.2 ORB 功能限制与解决方案对照

| ORB 能力 | 派 A 状态 | 派 B 状态 | 主要限制 | 解决方案 |
|---|---|---|---|---|
| 五人格陪伴 UI / 台词 / 主题 | ✅ 直接跑 | 🔁 全重写 | A 无限制；B 工作量大 | A：直接；B：ArkUI 重写（数据原样搬） |
| 智能体编排 + CLI 模型桥接 | ✅ Node 跑 CLI(HTTP/RPC) | ✅ ArkTS 调用 CLI | 无 | 两派均可，A 更省 |
| 流式协议(id===undefined 握手) | ✅ 纯 JS 跑 | ✅ 重写但继承规则 | 无 | 两派均可 |
| 录屏 | ⚠️ Chromium `MediaRecorder` 不确定，原生 DXGI `.exe` 死 | ✅ `AVScreenCapture`+`AVRecorder` | A：渲染内录制链路可能未接编码器，需桥接系统 `AVRecorder`；B：隐私窗(IME/系统UI)采不到 | A：用 addon 桥接 `AVRecorder`；B：原生实现 |
| 截屏 / 取词 | ✅ `desktopCapturer` 桥接可用(需 `CAPTURE_SCREEN` 权限) | ✅ `AVScreenCapture`(可截整屏含其他应用)+`CoreVisionKit` OCR | 两派同受**平台隐私窗排除**（IME/密码/系统UI采不到，普通应用无法绕过） | 常规"整屏截图/录屏"可行；隐私窗靠用户退出输入/密码态规避，OCR 补取词 |
| 磨砂背景 | ✅ CSS `backdrop-filter`（Chromium 原生） | ✅ ArkUI `.blur()` | 无（A 反而更省，无需自截桌面） | 两派均优于现状 glassbg |
| 系统托盘 | ⚠️ 可用但坑多：click 事件在鸿蒙 PC 不保证触发、焦点管理异、通知需 `NOTIFICATION_CONTROLLER` 否则静默失败 | ❌ 无托盘概念 | A：需右键菜单+双击保底；B：入口形态变更 | A：右键/双击兜底+真机验证；B：服务卡片/胶囊/后台 Service |
| 全局快捷键 | ❌ `globalShortcut` 整模块在鸿蒙 PC **基本失灵**（底层 X11 GrabKey 异步/不保证拦截，且不报错） | ❌ 无全局热键（PC 后续可能开放） | A 触发器"热键类型"失效 | A：改用窗口级 `before-input-event` 或应用内命令面板；B：应用内手势/命令面板（Ctrl+K 思路保留） |
| 前台窗口操控(windows-mcp) | ⚠️ 可走 `AccessibilityExtensionAbility`+`gestureInject`(需用户授权无障碍)或设备级 HDC/UiTest | ⚠️ 同派 A + 鸿蒙7 Agent 框架(系统AI跨App操作) | 无原始 SendInput；普通应用未经授权不能点其他应用；安卓点击器在鸿蒙跑不了 | 用户授权无障碍服务实现跨应用节点查询+手势；或走系统 Agent/设备管控通道 |
| 悬浮多窗体系(球/面板/录制条/边框/字幕/工具条 7 窗) | ⚠️ `@ohos.window.create` 桥接多窗可用，但多显示器 `screen` 定位可能受限 | ⚠️ ArkUI `Window` 可用，手机上形态需重设计 | A：多屏坐标体系差异；B：手机无"桌面悬浮"范式 | A：适配 OHOS 显示 API；B：重设计为移动端交互 |
| 语音 | ⚠️ Web Speech 在 Chromium 或可用(需网)；本地 Whisper(Python)死 | ✅ 端侧 `SpeechRecognizer`/云端 ASR | A：离线 Python 不可行；B：需换方案 | A：云端 ASR 或端侧；B：端侧/云端 |
| 附件 | ✅ 文件框桥接+`fs`/`path` | ✅ 文件 Picker+`@ohos.file.fs` | 无 | 两派均可 |
| 触发器/审计/急停/Ctrl+K | ⚠️ 前端逻辑可跑，但"全局"热键触发受影响 | ✅ 应用内命令面板 | A：全局快捷键失灵拖累触发 | 统一改为应用内命令面板入口 |
| 存储 schema | ✅ `fs` 可用(沙盒目录) | ✅ `@ohos.file.fs` | 无 | 两派均可，`shell.openPath` 换系统打开 |
| MP4 收尾(mp4finalize) | ✅ 纯 JS `fs` 直接跑 | ✅ 重写但简单 | 无 | 两派均可 |

### 11.3 两派各自的"硬伤"小结

**派 A 无法回避的限制（已真机验证）**
- 全局快捷键（`globalShortcut`）基本失灵，触发器热键类型需改应用内入口。
- 系统托盘点击/焦点坑多、通知需额外权限，且要真机验证（模拟器行为不一致）。
- 5 个 Windows `.exe` + Snipaste + Python Whisper **一个都跑不了**——ORB 的 Windows 深度集成层在派 A 下同样必须重写或丢弃。
- 上架合规（ArkWeb 要求）与体积/性能代价。
- 偏鸿蒙 PC，手机/平板不适配。

**派 B 无法回避的限制**
- 全量 UI 重写（~16,000 行），工作量集中在此。
- 同样受平台隐私窗排除、无托盘/全局热键、无原始 SendInput 注入、无 Snipaste 的约束；**跨应用操控有受限的等价路径（无障碍授权 / 鸿蒙7 Agent 框架）**（这些是**鸿蒙平台共性**，不是派系差异）。
- 手机形态需重新设计"桌面悬浮多窗"交互。

**关键结论**：派 A 与派 B 的**真正分水岭不在"能跑多少功能"，而在"UI 重写成本 + 入口形态 + 合规/性能"**。经补充调研修正：ORB 真正无解的只有 **Snipaste（闭源 Win 软件）/ DXGI+MF 原生录屏（可由 AVScreenCapture+AVRecorder 替代）/ Python Whisper 离线（换端侧或云端 ASR）/ 原始 SendInput 注入（只能走无障碍或系统 Agent）**；而**全屏截图与跨应用操控在鸿蒙上并非不可能，只是权限受限**——派 A、派 B 在这些点上限制相近。因此建议：**先用派 A 做探针验证 UI 与通用桌面能力（窗口/剪贴板/文件/截屏桥接），把必重写部分收敛到"Windows 深度集成层 + 入口形态"，再决定是否值得为合规/性能/多端去走派 B。**

---

## 十二、无鸿蒙硬件时的验证路径（2026-10-29 补充）

无需购买鸿蒙 PC。但"真机运行级验证"必须有一个鸿蒙运行时，可用以下免硬件方案替代。

### 12.1 免自有硬件的鸿蒙运行时
- **DevEco Studio 本地模拟器（PC 设备模板 MateStation）**：免费，跑在本机，需本机性能足够；鸿蒙 PC 模拟自 DevEco 6.0+ 起支持。
- **DevEco Studio 远程模拟器（云端）**：免费，云端设备，只需开发机+网络，最省事。
- **AppGallery Connect 远程真机调试**：真实设备按分钟计费（价格低），桌面特性（托盘/全局快捷键/窗口生命周期）必须用真机——社区已验证模拟器在这些点上与真机差异大。
- **廉价 OpenHarmony 开发板**（润和 DAYU / HiHope 等，数百元）：跑 OpenHarmony，适合验证手机/平板路径，非 PC。

### 12.2 在 Windows 上零鸿蒙环境即可验证的部分
- 平台无关逻辑（五人格/台词/主题令牌/流式协议/存储 schema）：用 Node/TS 单测。
- 静态能力映射：读 libelectron/ElectronEgg 文档与社区适配代码，确认哪些 Electron API 被桥接（已完成调研，不需运行时）。
- UI 逻辑冒烟：因 Web 容器路径=ArkUI Web 加载 HTML，`panel.html` 可直接在 Chrome 跑，近似验证。
- 适配工程脚手架：把整个 HAP 适配工程（桥接 IPC handler、权限声明、module.json5）写好，仅最后"设备上运行"一步需云端/真机。

### 12.3 结论
Phase 0（DNA 抽取 + 静态矩阵 + 适配工程脚手架）**现在就能在 Windows 上 100% 推进**；运行级探针（派 A 跑 ORB / 验证 AVScreenCapture / AccessibilityExtensionAbility）用 **免费 DevEco 云模拟器** 起步，桌面特性卡点再上 **远程真机**。无需购置鸿蒙电脑。

### 12.4 账号与签名获取难度（补充）
- **华为开发者账号**：免费注册（developer.huawei.com / AppGallery Connect），需实名认证（个人用身份证/护照，企业用营业执照）。调试阶段用 HUAWEI ID + DevEco「自动签名」即可，无需独立申请证书。
- **签名证书**：调试走 DevEco「自动签名」（一键生成 debug 证书 + profile 并绑定账号/设备，免费）；发布在 AGC 创建发布证书 + profile（免费，需实名 + 应用审核）。
- **验证阶段门槛极低**：走「自动签名 + 云模拟器/云真机」，基本只需一个 HUAWEI ID，不用正式证书、不用上架审核。
- **注意**：个人开发者实名通常需满 18 岁；若用到受限权限（如 `CUSTOM_SCREEN_RECORDING`）或声明无障碍服务（`AccessibilityExtensionAbility`），上架需 AGC 审核 / 更严审查——但这些**都不影响"调试验证"阶段**，只有正式上架才碰。

---

*本文与 `docs/` 探针、`orb/pack.cjs` 打包流程无关，不参与发版，仅作迁移评估与实施参考。*
