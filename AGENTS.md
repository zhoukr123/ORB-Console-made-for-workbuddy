# AGENTS.md — ORB 控制台（给接手这个项目的 AI / 协作者）

> 这是一份"规矩 + 上下文 + 验收标准"文件。它存在的理由，正是《次时代桌宠》分享里说的坑：**"不写文档，下一轮就从零开始"**。凡是散在记忆里、靠人每次读才守得住的约束，都应该沉淀到这里。

---

## 1. 这是什么

ORB 控制台是一个 **Electron 44 桌面应用**，形态是「常驻悬浮球 + 可唤起的面板」。它不是一个聊天框，核心能力是：

- **工作流录制回放**：录一遍操作，之后自动重跑；
- **智能接管**：确定性路径失败时，把画面交给 Agent / 视觉模型，由它识别新按钮和位置、推进几步，判定回归后再交回确定性回放；
- **截屏 / 录屏 / 划词**，以及磨砂透明窗等桌面特效。

- 仓库：`zhoukr123/ORB-Console-made-for-workbuddy`（public, main）
- 本地根：`D:\workbuddy_ORB控制台`
- 当前版本：`v1.5.0`（AI 台词 + 自定义模型可接管后台任务 + 消耗并账；五个人格）

---

## 2. 目录与文件约定

| 位置 | 内容 |
| --- | --- |
| `orb/desktop/main.js` | 主进程（~4500 行），窗口管理、主题推送、IPC 路由、急停、托盘 |
| `orb/desktop/preload.js` | 渲染进程白名单桥，所有 `window.orb.*` 都从这里放行 |
| `orb/bridge.mjs` | 后端逻辑：工作流引擎、接管调度、`probeAnchors` / `ocrLines` / `pickResumePoint` 等纯函数 |
| `orb/desktop/panel.html` | 主面板，**内联单块 `<script>`（~326KB）**，所有面板逻辑都在这里 |
| `orb/desktop/ball.html` | 常驻悬浮球（~130 行，独立窗口） |
| `orb/desktop/recbar.html` / `border.html` / `toolbar.html` | 录制条 / 观察边框 / 工具条 |
| `orb/desktop/{glassbg,snipaste,storage,voice,mp4finalize}.js` | 各能力模块 |
| `docs/_*.cjs` / `docs/_*.mjs` | 探针与静态审计脚本（`docs/_*` **不入库**） |
| `docs/更新说明-vX.X.X.md` | 更新说明范本，语气平实、讲"加了什么、用起来什么感觉" |

**升版只改两处**：`orb/desktop/package.json` 的 `version` + `orb/pack.cjs` 的 `VERSION`。使用说明真源是项目根那份 `使用说明.md`，别在别处另起一份。

---

## 3. 架构分层（目标态，对照《次时代桌宠》四层）

当前是「四个窗口各揣一份主题和状态」，理想态应明确分层、只靠接口通信，这样换皮 / 换模型 / 加端时才不用还债：

1. **交互层**：ball / panel / recbar / border 窗口 —— 只负责呈现与采集，不揣业务状态；
2. **会话 / 人格层**：上下文与提示词（目前散在主进程与 bridge，应抽成独立一层）；
3. **知识 / 记忆层**：对话存档 + 项目 `MEMORY.md` + **召回路径（目前缺失：只存不取，等于没存）**；
4. **模型层**：VLM 槽位（现在硬编码在主进程 `get-vision-key`）—— 尚未做成「可换」。

> 新代码优先走"可换接口"，别再把状态写死在某个窗口里。

---

## 4. 硬约束（都是真事故换来的，改前必读）

- **「古早 bug」的标准形态**：顶层 `getElementById('X').…` 而 HTML 里没有 `X` → 同步抛，静默掐掉其后整段脚本（用户看到的就是"点了没反应 / 只有动效"）。改完 HTML/JS **必跑** `node docs/_id_audit_all.cjs`。
- **改 UI 后必查对应关系**：HTML 里删了元素，JS 里对应的 `if (el)` 分支就变成永久空转的死代码（`#toolRec` / `#toolStop` 就是这么来的，前者还是"录制找不到停止键"的真根源）。要么补回元素，要么删掉分支。
- **CSS 令牌只有已定义的**：圆角只有 `--r-sm(8px)` / `--r-lg(16px)`，**没有 `--r-md`**；用不存在的令牌会静默失效、不报错。
- **主进程模块顶层禁碰 ready-gated API**（`screen` / `BrowserWindow` / `dialog` / `desktopCapturer` / `Tray` / `globalShortcut` / `nativeTheme` …）：同步抛会静默掐掉其后所有 `safeHandle` → 面板 `No handler registered`、按键全失效。**改 main.js 必须真启动一次看 `.orbdata/orb.log`**（headless 探针测不出主进程顺序）。
- **IPC = preload 白名单 + safeHandle**：禁暴露 `fs` / `shell` / 通用 `invoke`。渲染进程要任何能力都得先在 `preload.js` 放行、在主进程 `safeHandle` 实现。
- **从主进程弹窗 / 打开 `.cmd`：用 `shell.openPath` 且路径纯 ASCII**（2026-10-27 真踩）。GUI 主进程里 `spawn('cmd.exe','/k')` 拉起的子进程**窗口根本不显示**（改成 spawn 后用户那边"连弹窗都不弹了"）；而 `shell.openPath` 对**含中文/空格**的路径（如 `%APPDATA%/ORB 控制台/…`）会闪退。要弹窗的脚本一律生成到 `os.tmpdir()`（纯 ASCII）再 `shell.openPath`，并给 `shell.openPath` 失败加 `spawn` 兜底（兜底也**不要 `detached`**，否则同样不显示）。
- 透明窗 `backdrop-filter` 采不到桌面（DWM 在页面之后合成）；磨砂靠 `glassbg.js` 藏窗自截桌面。
- 录屏 `MediaRecorder` 必须 `video/mp4;codecs="avc1.42E01E"`；计时器放 recbar（面板隐藏时渲染定时器被节流）。
- 截屏调 Snipaste：`snip --hold -o <绝对路径>`（`--hold` 必须、非 PRO）；**划词监听必须避开截屏期**（Ctrl+C 在 Snipaste 里 = 复制并退出）。
- 成品包冒烟被单实例锁挡（锁按应用名）→ 只能静态核验包内文件契约；`APP_FILES` 漏 `glassbg.js` / `snipaste.js` = 发布版静默失效。
- **`APP_FILES` 只认单文件**（走 `cp`）。目录必须另走 `APP_DIRS` + `cpr`（robocopy，退出码 1–7 都算成功）；把目录名塞进 `APP_FILES` 会直接报"缺少应用文件"并中止打包。`anim/` 就是这么加的。
- **动效兜底**：`html.no-motion *` + `@media (prefers-reduced-motion)` 双兜底必须覆盖每一条新增动画。注意 `ball.html` 的 `no-motion` 由 `main.js` 推送（过去是死代码，用户关动效球照样呼吸）。
- **图标几何事实**（两个都实测过，别再用估计值）：
  - `icon.png`：512×512，不透明方块 **440×445 @ (35,28)**，圆角 **92px**，四周**透明**。铺到 66px 时可见蓝方块 56.7px、圆角 11.9px。
  - `anim/*.gif`：400×400，蓝块 **370×374 @ (13,13)**，圆角 **79px**，四周是 **#fbfcfd 不透明**白边（占 3.25%）。直接铺 66px 会比静态图标大一圈、还挂一圈白框 → 必须 `63px + clip-path: inset(4.5% round 12px)`，且 **filter 要挂在父层 `.face` 上**（`clip-path` 在 `filter` 之后生效，挂同一元素会把投影一起裁掉）。
- **GIF 没有时长 API**：要"只播一遍"必须自己读 GIF 块结构算帧延时总和（`main.js` 的 `readGifMeta`）。浏览器侧 `currentTime` / `duration` 一律没有。
- **面板里的 `loading="lazy"` 不可靠**：启动时 `display:none` 的子树里的懒加载图不会被触发（实测 `naturalWidth` 永远 0，切过去也不补）。要么去掉 lazy，要么等页签可见再赋 `src`。

---

## 5. 验证流程（改完必须自己跑过再回话）

这条直接来自《次时代桌宠》坑 01「它说已完成，打开是空的」——**要求给出验证结果，不接受空口"改完了"**。

1. `node --check orb/desktop/main.js` 与 `preload.js`；
2. 四个 HTML 的内联脚本语法（`new Function` 包裹检查，避免 `await` 之类在错误作用域）；
3. 静态审计四件套（都可直接 `node docs/_xxx.cjs`）：
   - `_id_audit_all.cjs`：悬空 `id`，四个 HTML 全量；
   - `_cls_audit.cjs`：JS 用到的 class 是否有样式；
   - `_orb_audit.cjs`：`window.orb` 是否在 preload 白名单；
   - `_div_audit.cjs`：标签配对；
4. 大改动后真启动一次：`env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ./node_modules/electron/dist/electron.exe .`（本机默认带 `ELECTRON_RUN_AS_NODE=1`，不 unset 会把 electron 当 node 跑），看 `.orbdata/orb.log` 是否干净；
5. 工作流接管 / 轮次推定等纯函数改动，跑 `docs/_round_test.mjs` / `_takeover_test.mjs` / `_probe_logic_test.mjs` 的断言。

---

## 6. 工作约定

- **一次一件事，拆任务并行**（坑 02「一次说太多会悄悄丢一半」）。这个长会话尤其适用。
- 大改动前先 commit（或至少确认影响面）；动接口先确认会影响哪些窗口。
- 日志集中放 `D:\WorkBuddy 附属文件夹\日志\`；项目记忆在 `项目记录/2026-09-28-00-45-13/.workbuddy/memory/`（`YYYY-MM-DD.md` 每日追加，别记临时路径/工具报错）。
- **GitHub 推送**：本机 `curl` 不通 GitHub HTTPS（被沙箱代理 502），改用 PowerShell `.NET` 栈 + `git credential` 取 `gho_` 令牌；大资产（~210MB）上传走 `[System.Net.HttpWebRequest]`（`SendChunked=$false`、保留默认代理），**`.ps1` 必须纯 ASCII（连路径都不能含中文）**。
- 把 AI 当同事用：**给它规矩、给它上下文、给它验收标准。它不是许愿池。**

---

## 7. 从《次时代桌宠》借来的 vs 不借的

### 借（已对齐进本文档）
- 四层架构意识（§3）；
- 知识库要走「写入 → 索引 → **召回**」完整链路，ORB 目前缺召回；
- 三个坑的对应物：验收标准制度化（§5）、一次一件事（§6）、写文档沉淀（本文件）。

### 不借（产品/工程定位不同）
- **「先玩具后工具」的产品顺序**：ORB 工具很重，玩具感靠一个悬浮球撑。要不要往"陪伴"方向走是产品决定，不是技术决定。
- **「会变形换身体」**：ORB 的球 / 竖条 / 面板是同一进程的三个窗口、状态各自维护 —— 这不叫换身体，叫换衣服。真要做"换身体"得先落地 §3 的分层。

### 判断标准（可抄进 README）
> 它是不是在让它更像一个伙伴，而不是更像一个功能。
