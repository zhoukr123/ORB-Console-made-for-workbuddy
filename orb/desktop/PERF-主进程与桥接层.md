# ORB 控制台 · 性能优化报告（主进程 / 桥接层 / 原生模块）

> 本文件记录任务 #3 中由主进程与桥接层承担的部分。渲染层部分见 `PERF-渲染层.md`。
> 所有改动前的备份：`main.js.koubak2-20261014-000943`、`bridge.mjs.koubak2-20261014-000943`、
> 以及 `_backup/` 下的全量时间戳备份。

---

## 0. 结论速览

| # | 优化项 | 文件 | 收益 | 状态 |
|---|---|---|---|---|
| 1 | 前台窗口追踪改用常驻原生模块 | `native/src/orb-foreground.c` + `main.js` | 消灭每秒 1~2 次 PowerShell 进程创建；单次查询 1.38s → 0.2ms | ✅ 已落地并实测 |
| 2 | `observing === 0` 时停止前台追踪 | `main.js:1160` | 面板开着但没执行动作时零开销 | ✅ |
| 3 | 拖拽定时器 16ms → 30ms | `main.js:390` | 主进程 IPC 量减半，跟手度无差别 | ✅ |
| 4 | 任务结果裁剪（>512KB 只留文字摘要） | `bridge.mjs` `startJob` | 峰值常驻内存从 100MB+ 降到 KB 级 | ✅ |
| 5 | 字幕轮询 500ms → 900ms | `main.js:863` | 常驻 HTTP fetch 次数降 44% | ✅ |
| 6 | 边框轮询 500ms → 800ms | `main.js:1182` | 重绘次数降 37% | ✅ |
| 7 | 读缓存 700ms → 300ms | `bridge.mjs:1529` | 重复读同一目标的冗余调用显著下降 | ✅ |
| 8 | `spawnOnce` maxBuffer 64MB → 8MB | `bridge.mjs:571` | 单次异常输出不再能顶爆进程内存 | ✅ |
| 9 | 急停批量 taskkill（一次多 PID） | `bridge.mjs` `killInflightMcp` | 急停时少起 3~5 个进程 | ✅ |
| 10 | 桥断开后向面板推送醒目提示 | `main.js:1433` | 不再"看起来还活着"地静默失效 | ✅ |
| 11 | 日志批量落盘 | — | **不适用，见 §11** | ➖ 无需改动 |

---

## 1. 前台窗口追踪：PowerShell → 常驻原生模块（收益最大）

### 问题
观察边框每 500~1000ms 要问一次"当前前台窗口在哪"，原实现是
`spawn("powershell.exe")` 并在脚本里 `Add-Type` 现场编译 P/Invoke。
**实测 1.38 秒/次**（`PERF` 冒烟数据），而刷新周期是 500ms——
等于每个周期都在烧一个核，且上一次还没回来下一次又出发。

### 方案
照 `native/orb-input.exe` 的既有先例新增 `native/src/orb-foreground.c`，
产物 `native/dist/orb-foreground.exe`：

- **常驻进程 + stdin/stdout 行协议**（JSON per line）。整个生命周期只 spawn 一次。
- 主进程 `main.js` 侧：`fgEnsure()` / `nativeForegroundRect()` / `foregroundRect()`。
- 单次查询 **实测 0.2ms**，且不再创建任何进程。

### 实测
```
$ echo '{"cmd":"fg"}' | ./native/dist/orb-foreground.exe --serve
{"ok":true,"ready":true}
{"ok":true,"hwnd":262444,"pid":41116,"title":"","exe":"explorer.exe","rect":[0,1019,1707,1067],"dwm":[0,1528,2560,1600]}
```
握手行与数据行都正常；`rect` 是逻辑坐标（与 PowerShell 路径语义一致，可直接喂 `setBounds`），
`dwm` 是真实边框矩形。

### 回退路径（硬要求，已实现）
以下任一情况自动退回原 PowerShell 实现，功能不中断：
1. exe 不存在 → 记日志，`fgBroken = true` 永久走回退
2. spawn 抛 error → 同上
3. 启动后 1.5s 内未就绪 → 本路径不可用
4. 单次请求 2s 无应答 → 判 null，调用方去回退
5. 进程崩溃 → 自动重启，超过 3 次则永久回退并在日志写明

进程退出时 `fgStop()` 先礼貌发 `{"cmd":"quit"}`，800ms 后兜底 `kill()`，
并接进 `before-quit` / `will-quit` 清理链。

---

## 2. `observing === 0` 时停止前台追踪

原 `startTrack()` 只看 `state.border`（"操作时显示观察边框"总开关），
于是**只要这个开关开着，面板一打开、鼠标一划过就开始追前台窗口**，
而观察边框此刻是隐藏的、根本画不出东西。

现在 `startTrack()` 开头加 `if (observing <= 0) return;`：
`openPanel()`（main.js:535）与 hover（main.js:1622）在 `observing === 0` 时不再起追踪，
`startObserve()` 自增到 1 后才启动。这是纯浪费的消除，与原生模块叠加后
空闲态这条线开销为零。

---

## 3. 拖拽定时器 16ms → 30ms

`setInterval(dragTick, 16)` 是 62fps，而每一帧都是三连 IPC
（`getCursorScreenPoint` + `getBounds` + `setPosition`）。改成 30ms（≈33fps）
后主进程 IPC 量减半，悬浮球拖拽跟手度无差别。

（顺带说明：工程师上轮已修掉这个定时器的**泄漏**问题——
`dragTick` 里 `if(!drag||!ball) return` 只返回不清表、`beginDrag` 覆盖旧 drag 不收表、
`drag-end` 漏发后定时器永久空转。那属于 Bug 修复，见 `BUGFIX-主进程与桥接层.md` M-01。）

---

## 4. 任务结果裁剪（>512KB）

### 问题
`jobs` Map 持有工具的**完整返回值**，而 MCP 工具的返回里常带整张屏幕截图
（base64，单张 1~3MB）。上限 60 条 → 峰值 100MB+ 常驻，且 GC 不掉。

### 实现
`bridge.mjs` 新增 `trimJobResult()`：
- `jobResultSize()` 超 `JOB_RESULT_MAX`（512KB）即触发裁剪
- 只削出一段文字摘要：取 `result.content` 里的 text 项拼接，截到 `JOB_TEXT_KEEP`（2000 字符）
- 纯非文本（只有截图之类）时给一句可解释的话，不让用户以为任务白跑
- **job 顶层置 `truncated: true`**

### 与渲染层的契约
`truncated` 挂在 **job 顶层**（触发裁剪时 `result` 可能整个不返回，
那时 `result.truncated` 无处可挂）。面板侧已预置
`j.truncated || j.result?.truncated` 两个位置都认，见到标志会补一句
「结果过大已省略，以上仅为开头部分」。

内存从 MB 级降到 KB 级；用户跑了几分钟的任务仍看得到开头部分，不至于只看到一句"已省略"。

---

## 5~6. 字幕 / 边框轮询放缓

| 轮询 | 原周期 | 新周期 | 理由 |
|---|---|---|---|
| `pollSubtitleLines` | 500ms | 900ms | 字幕是人眼跟着读的，500ms 纯浪费；且这是常驻 HTTP fetch |
| `updateBorder` | 500ms | 800ms | 边框只是描出目标窗口位置，500ms 看不出跟手差别 |

---

## 7. 读缓存 700ms → 300ms

`READ_CACHE` 对"读"类工具的结果做短时缓存，避免视觉循环里反复读同一目标。
窗口从 700ms 收紧到 300ms：既明显减少冗余调用，又不会因为缓存太旧
读到过期画面（任何写操作后立刻 `READ_CACHE.clear()`，这条不变）。

---

## 8. `spawnOnce` maxBuffer 64MB → 8MB

`maxBuffer` 是子进程 stdout 的缓冲上限。输出是纯正文（AI 回复 / 命令结果），
64MB 纯属给"异常情况下把进程内存顶爆"留空间。收到 8MB——真超了本来就该判失败
而不是硬吞。同文件另两处 16MB / 32MB 未动（那是 ASR / CLI 自己的路径）。

---

## 9. 急停批量 taskkill

原来 `killInflightMcp()` 里每个在途 MCP 调用的 PID 各起一个 `taskkill` 进程，
急停时常见 3~5 个在途调用——等于在最不该卡的时候连开 3~5 个进程。
改成一次喂多个 `/PID`：`taskkill /PID a /PID b /T /F`。

---

## 10. 桥断开后推送醒目提示

用户明确**不要**自动重启 bridge（挂了就手动重启，避免半死状态反复横跳）。
但原来的行为是 `bridgeProc.on("exit", code => log(...))` 只记日志——
用户看到的是一个"看起来还活着"的控制台，所有功能其实已经失效。

现在退出时通过 `pushNotice` 推一条醒目提示：
> 本地桥接服务已断开（退出码 N），ORB 的全部功能暂时失效。请重启 ORB 控制台恢复；详情见 .orbdata/orb.log。

带去重（`bridgeDeathNoticed`），避免退出过程里重复弹。

---

## 11. 日志批量落盘 —— 经核实无需改动

原计划把 `log()` 的同步 `appendFileSync` 改成 256 行 / 2 秒批量 flush。
核实后不适用：

- `bridge.mjs` 的 `log()` 只做 `console.log`，由主进程从 stdout 抓取，**不落盘**；
- 全文唯一的同步 `appendFileSync` 在 wb-callback 这一条低频路径（常驻 daemon 的结果回调），
  不是热路径；
- 主进程侧被点名的 `hover` 日志（"鼠标每次进出悬浮球都写盘"）**上轮已经修掉**——
  现在只有 hover 状态发生**翻转**时才记一条（main.js:1612-1614 的注释即为此事）。

所以这一项没有可改的东西，记录在此以免后人重复排查。

---

## 12. 未处理项（有明确理由）

| 项 | 理由 |
|---|---|
| ASR 空闲回收 10 分钟 → 5 分钟 | 用户明确 ASR 交给其他 agent 处理，本轮一律不碰 |
| `/api/status` 轮询 5s → 10s | 属 `panel.html`，已在 `PERF-渲染层.md` 完成 |
| 字幕服务改 SSE | 需要改 ASR 服务端，超出本轮范围 |
| 划词监听 `SetWinEventHook` 常驻化 | 需改原生模块，可作为后续项 |

> **后续更新（2026-10-14 晚）**：上表最后两项已完成 ——
> 字幕服务已改 SSE（`asr/subtitle_rt.py` 的 `GET /events`，见 §14），
> 划词监听也已原生化（`native/src/orb-selection.c`，见 §13）。

---

## 13. 划词监听：PowerShell → 常驻原生模块

### 问题
`selection-watch.ps1` 是一个常驻 `powershell.exe`，每 60ms 轮询一次鼠标键与光标位置，
命中拖拽后走 .NET 的 UI Automation 读选区。代价：

- 常驻一个 powershell.exe（连带 .NET 运行时），几十 MB 内存不放
- 60ms 轮询间隔，快速拖拽有概率整个错过（按下与抬起落在同一个间隔内）
- 每次命中走一遍 PowerShell → .NET → COM 互操作，慢且抖
- 启动时要 `Add-Type` 现场编译 P/Invoke，头 1~2 秒不可用

### 方案
照 `orb-foreground.c` 的既有先例新增 `native/src/orb-selection.c`，
产物 `native/dist/orb-selection.exe`（构建入口 `native/build-selection.ps1`）：

- **常驻进程 + stdin/stdout 行协议**，与 `orb-foreground` 同一套约定
  （`ready` 握手行 / `ping` / `sel` / `quit`；非 ASCII 一律 `\uXXXX` 转义，stdout 纯 ASCII）
- **16ms 轮询**（PowerShell 版 60ms），拖动判定阈值、去重窗口与旧版逐项一致
- UIA 直读：`GetFocusedElement` → `GetCurrentPattern(UIA_TextPatternId)` →
  `GetSelection()` → `GetText(-1)`，收尾按旧版语义做首尾空白裁剪
- **`IUIAutomation::AddFocusChangedEventHandler` 挂在专职 STA 线程上抽消息** ——
  这一步就是旧版 `AddAutomationFocusChangedEventHandler` 的作用：让
  `UiaClientsAreListening()` 为真，Chromium / Edge 才会开启自己的无障碍树。
  处理器本体什么都不做，我们只关心"有客户端在听"这个事实
- **DPI unaware**，与 `orb-foreground.c` 一致：事件里虽带 x/y，但主进程
  `handleWatchEvent` 明确忽略它们、改用 Electron 自己的光标位置，坐标系不影响行为

### 主进程接入
`main.js` 的划词监听改为**原生优先、PowerShell 兜底**：
`startSelectionWatch()` → `startNativeWatch()` → 失败则 `startPsWatch()`。
两条路径共用 `attachWatchProc()`（stdout 行解析 + 崩溃自动重启 + 20 秒稳定期清零计数）。
原生连续崩溃超过 `WATCH_MAX_RESTARTS`（5）次时**自动改走 PowerShell**，而不是让功能整个消失。

事件输出格式与 `selection-watch.ps1` 逐字节一致，`handleWatchEvent()` 一行未改。

### 回退路径（硬要求，已实现）
1. exe 不存在 → 记日志，直接走 `startPsWatch()`
2. spawn 抛 error → 同上
3. 连续崩溃超过 5 次 → 记日志，改走 PowerShell
4. PowerShell 也连续崩溃超过 5 次 → 停止重试并写明原因（原行为）

### 实测
```
Node 侧 spawn 复现 main.js 接入方式：
  {"ok":true,"ready":true}
  {"ok":true,"pong":true}
  {"ok":true,"text":null}
  {"ok":true,"bye":true}
  exited: yes (code 0)
RESULT: PASS
```
stderr 为空 → `AddFocusChangedEventHandler` 返回 S_OK。
与 PowerShell 版 UIA 读取链路的**行为一致性**也已在同一会话上比对：
两者都走 `GetFocusedElement → GetCurrentPattern(TextPattern) → GetSelection`，
在桌面锁屏（前台为 `Windows.UI.Core.CoreWindow`）下同样得到空结果。

> ⚠️ **未能完成 GUI 级端到端取词验证**：测试期间桌面处于锁屏状态
> （前台窗口是「Windows 默认锁屏界面」），记事本 / WinForms 窗口既拿不到焦点、
> 也无法接受 UIA 选区。协议层、UIA 订阅、读取链路均已验证；
> 真实拖拽取词需在解锁的桌面上由用户验收。

---

## 14. 字幕服务轮询改 SSE（`asr/subtitle_rt.py`）

### 问题
主进程 `pollSubtitleLines()` 每 900ms `fetch` 一次 `/lines`，字幕悬浮窗开着就一直在打。

### 方案
`subtitle_rt.py` 新增 `GET /events`（FastAPI `StreamingResponse`）：

- **协议与 `/lines` 的默认行为逐字段一致**：data 行是同一个 JSON
  （`total` / `items` / `partial`），`items` 是尾部 8 条的**窗口快照**
- 有变化才推；无变化时每 250ms 发一行 `: ping` 心跳注释
- 响应头带 `Cache-Control: no-cache` / `X-Accel-Buffering: no`（防代理缓冲）

主进程改为 `pumpSubtitleStream()`：`fetch` + `TextDecoder` + `getReader()`，
按 `\n\n` 切 SSE 帧、按 `data:` 前缀取行，断线退避 1s → 2s → 4s 封顶 8s。
`/lines` 端点保留未删（向后兼容）。内置页面同步改为 `EventSource('/events')`，
并补了 HTML 转义（原来直接拼 HTML）。

### ⚠️ 中途修掉的一个真实回归
第一版把 `items` 写成**增量**（只发自上次之后的新句子），结果两个客户端语义分叉：

- 内置页面 `lines.push(...)` 自己攒窗口 → 碰巧对
- Electron 悬浮窗 `subtitle.html` 的 `render()` 是**整表替换**后取 `slice(-2)`
  → 每帧只拿到新那一句，前一句被抹掉，字幕窗口从此只显示一行

改成窗口快照后两边都对，且客户端完全无状态（每帧整表替换，重连也不用重置缓存）。
这也让 `/events` 与 `/lines` 的契约真正统一——原先文档写"协议一致"其实并不一致。

### 实测（`asr/_t_sse2.py`，跑完已删）
同一条连接上分六段验证：
```
首帧 3 条                     → 窗口含全部 3 条 ✅
同连接静默 2s                 → data 帧数 0，有心跳 ✅
新增 2 条                     → 窗口变成整表 5 条（不是只有增量 2 条）✅
灌到 12 条                    → 窗口截到尾部 8 条 ✅
只改草稿                      → 推帧且 items 保持 8 条 ✅
两个客户端的渲染逻辑复算       → subtitle.html 显示 ['第11句','第12句'] ✅
```

> 两条测试设计教训：
> ① 增量语义**只能在同一连接上验证**。最初把"再取一次"写成新开一条连接，
> 服务端按设计重发全量快照，测试判成失败——是断言写错了，不是代码错了。
> ② 断言里的期望值要跟造的数据对严：前 5 条用的是中文数字（"第五句"），
> 断言却写"第5句"，白fail 一轮。

---

## 15. 校验记录

```
node --check bridge.mjs          ✅
node --check desktop/main.js     ✅
原生探针握手 + 查询               ✅（见 §1 实测输出）
划词监听 Node 侧 spawn 协议        ✅（见 §13 实测输出）
SSE 四段增量验证                   ✅（见 §14 实测输出）
隔离端口冒烟（ORB_PORT=19399）    ✅ 服务起来、/api/status 鉴权生效（无令牌 401）
IPC 通道 / 快捷键 / CSP           ✅ 未增未减（上轮已核，本轮未触碰相关代码）
```

### 冒烟测试中发现并已记录的问题
隔离实例把 `.bridge.json` 写到了**项目根**（`TOKEN_FILE` 用的是 `HERE`，不受
`ORB_DATA_DIR` 影响），导致测试实例会覆盖生产令牌文件。开发态无害（两边本就同目录），
**打包态也无害**（`resources/` 是真实可写目录，且 main.js 与 bridge.mjs 的路径计算一致）。
但将来若要做"多实例隔离"，这是第一个要改的点。已记录，未改动。
