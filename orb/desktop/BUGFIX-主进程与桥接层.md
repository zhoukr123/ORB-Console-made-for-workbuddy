# ORB 控制台 — 主进程（main.js）与桥接层（bridge.mjs）Bug 审计报告

审计人：寇豆码（Kou）　范围：`desktop/main.js`（1498 行）、`bridge.mjs`（2670 行）
审计基线：`_backup/main.js.20261013-230315`、`_backup/bridge.mjs.20261013-230316`
本地备份：`desktop/main.js.koubak-20261013-233035`、`bridge.mjs.koubak-20261013-233035`

**行号说明**：下表「文件:行号」为**审计基线（修改前）**的行号，便于对照备份追查；修复后的行号已变化。

**严重度定义**
- P0 = 崩溃 / 功能不可用 / 资源泄漏导致不可用
- P1 = 明显错误行为
- P2 = 健壮性 / 边界

**统计**：共 27 条 —— P0 × 3、P1 × 14、P2 × 10（main.js 15 条，bridge.mjs 12 条）。全部已修复。

---

## 一、Bug 清单

### main.js

| # | 严重度 | 文件:行号 | 问题描述 | 根因 | 修复方案 | 状态 |
|---|---|---|---|---|---|---|
| M-01 | **P0**（性能型） | main.js:306 / 310-312 / 299 / 1229 | 16ms（≈62fps）拖拽定时器会泄漏：拖拽未正常收尾后定时器永久常驻，悬浮球一直粘着鼠标 | ①`beginDrag()` 直接 `drag = {...}` 覆盖，上一次的 `drag.timer` 没人清；②`dragTick()` 开头 `if (!drag \|\| !ball) return;` 只 return 不 `clearInterval`，球被销毁后定时器照样每 16ms 空转；③`drag-end` 依赖渲染层 `mouseup`，页面重载 / 窗口重建 / 右键菜单都会漏掉；④`will-quit` 没清 | 抽出 `stopDragTimer()`；`beginDrag()` 起新表前先收旧表；`dragTick()` 检测到球已销毁立刻收表（不触发单击语义）；`will-quit` 兜底清 | ✅ 已修 |
| M-02 | P1 | main.js:694-708（原 707） | 字幕窗被用户关掉后，500ms 的 `subPoll` 轮询**永久继续**，持续打 `127.0.0.1:19879` | `subWin.on("closed")` 只做 `subWin = null`，没停表；停表只挂在 `subtitle-hide` 通道上 | `closed` 里调 `stopSubtitlePoll()`；`pollSubtitleLines()` 开头发现窗口不在/不可见就自行停表（覆盖所有非 `subtitle-hide` 路径） | ✅ 已修 |
| M-03 | P1 | main.js:663-673 | **第一次划词弹出的工具条点了没反应**：搜索/翻译/发给 Agent 拿到的是空文本 | 工具条是懒创建的，`showToolbar()` 里 `createToolbar()` 后立刻 `send("selection-text")`，而 `toolbar.html` 的 `onSelectionText` 监听要等 `did-finish-load` 之后才挂上 —— 消息在页面就绪前发出，直接被丢弃 | 加 `toolbarReady` + `pendingToolbarText`：页面 `did-finish-load` 后补发；窗口 `closed` 时复位 | ✅ 已修 |
| M-04 | P1 | main.js:524-530 | `Ctrl+Alt+S` 在没有选区时，会把**上一次复制的剪贴板内容**当成"选中文字"塞进面板 | 末行 `return text && text !== before ? text : text \|\| before;`：Ctrl+C 没取到东西时 `text === before`，于是回落到 `before`（旧剪贴板）。同文件的 `clipboardSelection()`（540-555）在同样场景下正确返回 `null`，两者语义不一致 | 改为 `return text && text !== before ? text : "";` | ✅ 已修 |
| M-05 | P1 | main.js:1332 | 会话历史在**打包态**永远落不了盘，只躺在 localStorage | `HISTORY_DIR = path.join(__dirname, "..", "..", "history")`。开发态 `__dirname/../..` 恰好等于 `DATA_ROOT`（所以从未暴露）；打包态 `__dirname` 在只读的 `app.asar` 内 → `mkdirSync/writeFileSync` EPERM → `history-save` 静默返回 false | 改用 `path.join(DATA_ROOT, "history")`（同 `guidePath()` 已踩过并修掉的同一个坑） | ✅ 已修 |
| M-06 | P1 | main.js:1424 | bridge 被重启过之后，面板所有 `/api/*` 全线 401，**必须重启 ORB 才能恢复** | `ipcMain.handle("bridge-token", () => bridgeToken)` 返回的是启动时缓存的令牌。bridge 每次启动都重新生成令牌（bridge.mjs:31），中途重启（手动 / 崩溃后由 start.cmd 拉起）后主进程手里的令牌即失效 | 每次取令牌都从 `.bridge.json` 重读并回写缓存；`bridgeCall()` 遇 401 自动重读令牌重试一次（原来取词失败是静默的） | ✅ 已修 |
| M-07 | P1 | main.js:1094 / 1233 | ①bridge spawn 失败（ENOENT）无任何提示；②退出时 `bridgeProc.kill()` 在 Windows 上是 TerminateProcess，bridge 拉起的 MCP server / CodeBuddy CLI / ASR / 字幕进程**全部残留成孤儿** | ①`spawn()` 只监听了 stdout/stderr/exit，没监听 `error`，失败信息全丢；`waitForBridge(60)` 超时也不吭声；②没有优雅停机通道 | ①加 `error` 监听 + 端口不通时通过新的 `noticeQueue` 队列在面板打开时弹出提示；②新增 `before-quit` → 先 POST `/api/shutdown`（bridge 侧新增，带令牌）→ 800ms 后兜底强杀，硬上限 2.5s | ✅ 已修 |
| M-08 | P1 | main.js:859-864 | 面板打开期间会**叠加出多个 PowerShell 进程**，机器越用越卡 | `pollForeground()` 无并发闸。`foregroundRect()` 是一次 `powershell.exe -EncodedCommand`（含 `Add-Type` 编译 P/Invoke），实测 1~3 秒；而 `startTrack()` 的周期是 500~1000ms，上一次还没回来下一次又出发 | 加 `pollingForeground` 并发闸，在途就直接跳过（同时避免"后到的结果比先到的旧"） | ✅ 已修 |
| M-09 | P1 | main.js:255-256 | 拔掉外接屏 / 改分辨率后，悬浮球可能建在**所有屏幕之外**，用户除了删存档没有任何办法把它弄回来（等于应用不可用） | 存档坐标只校验了 `Number.isFinite`，没校验是否落在当前任一显示器的工作区内 | 新增 `clampToWorkArea()`，用 `screen.getDisplayNearestPoint()` 把球夹回最近显示器工作区 | ✅ 已修 |
| M-10 | P2 | main.js:73-88 | `log()` 自己会抛异常，并把调用方（IPC handler、子进程 data 回调）一起带崩 | `JSON.stringify(a)` 在遇到循环引用 / BigInt 时抛异常，且**这行在 try 之外**（`const line = ...` 先于 `try { console.log(line) }`） | 抽 `logArg()` 单独兜住 stringify；整个 `log()` 函数体再包一层 try/catch | ✅ 已修 |
| M-11 | P2 | main.js:236-249 | 端口探测链可能永久悬挂 | `net.connect` 没设超时：若对端"接受连接但永不响应"，`connect` 与 `error` 都不触发，socket 与递归链一直挂着 | `s.setTimeout(1500)` + 监听 `timeout`；用 `settled` 单次结算，保证 socket 一定 `destroy()` | ✅ 已修 |
| M-12 | P2 | main.js:1229-1234 | `will-quit` 只清了 `borderTimer`，其余定时器全部随进程消失前空转 | 漏了 `subPoll` / `tracker` / `hoverOpenTimer` / `closeTimer` / `drag.timer` | 补全全部清理 | ✅ 已修 |
| M-13 | P2 | main.js:1044-1045 | 取消勾选「操作时显示观察边框」后，已开着的 `borderTimer`(500ms) 与 `tracker`(PowerShell 追踪) **继续空转** | `startTrack()` 有 `state.border` 门禁，但运行时把开关关掉没有任何地方去停已经起好的表 | 新增 `stopObserveAll()`（强制归零、清表、隐藏边框），在开关关闭时调用 | ✅ 已修（行为变化，见第三节第 3 条） |
| M-14 | P2 | main.js:1358 / 1425 / 1434 / 1440 / 1393 / 1469 / 1395 / 1450 | `ipcMain.handle` 中未捕获异常会让渲染层 `await invoke(...)` 拿不到回包，表现为"点了没反应，按钮一直转圈" | 8 个 handler 直接读剪贴板 / 取窗口 bounds / 取光标，无任何兜底 | 新增 `safeHandle(channel, fn, fallback)` 统一包装，按通道给出类型匹配的 fallback（`""`/`[]`/`false`/`{ok:false}`），异常记进日志 | ✅ 已修 |
| M-15 | P2 | main.js:1451 / 1405 | `set-voice` / `set-vision` 对 `patch` 未做类型校验 | `const next = {...cur, ...(patch \|\| {})}`：若渲染层误传字符串，`{...str}` 会展开出 `"0"`、`"1"`… 这类键并写进存档 | 显式判 `typeof patch === "object"`；`set-vision` 的 `patch[slot]` 同样加校验 | ✅ 已修 |

### bridge.mjs

| # | 严重度 | 文件:行号 | 问题描述 | 根因 | 修复方案 | 状态 |
|---|---|---|---|---|---|---|
| B-01 | **P0** | bridge.mjs（全文，缺 `process.on`） | **一次异步异常就让整个 bridge 消失**，ORB 全部能力（前台自动化 / 后台 AI / 语音 / 字幕）一起没，且 main.js 只记日志不会重启 | 全文没有 `process.on("uncaughtException")` / `process.on("unhandledRejection")`。Node 对这两类默认致命退出 | 补两个全局兜底，语义取"记下来、继续跑"（本地服务宁可带伤运行，也不能整体消失） | ✅ 已修 |
| B-02 | **P0** | bridge.mjs:202 / 1692 / 1766 | `daemonProc` / `asrProc` / `rtProc` 三处 `spawn` **没有 `error` 监听**：ENOENT（CLI / `asr\venv\Scripts\python.exe` 不存在）时 Node 直接抛未捕获异常 → bridge 秒退 | `spawn()` 同步必定成功，失败是异步的 `'error'` 事件；EventEmitter 在无监听者时把它升级成抛出。外面包 `try/catch` 完全没用（`ensureDaemon` 里正是这么写的，catch 永远进不去） | 三处全部加 `error` 监听并落日志；同时置 `daemonSpawnErr` / `asrSpawnErr` / `rtSpawnErr`，让各自的等待循环立刻放弃（否则每次调用白等 40s / 90s / 8s） | ✅ 已修 |
| B-03 | P1 | bridge.mjs:2638-2648 | `shutdown()` 收尾不全：**正在跑的 CodeBuddy CLI 与各 MCP server 子进程全部残留** | 只 kill 了 daemon/asr/rt；`activeProcs`（`spawnOnce` 派出去的 CLI，bridge.mjs:879）不杀、`triggerHandles` 不停；且配合 main.js 的 TerminateProcess，这条函数平时根本来不及跑 | 补 `killActiveProcs()` + `disarmTriggers()` + `clearInterval(asrReaper)` + `disposeAllSessions()`；退出前清空子进程台账；新增带令牌的 `POST /api/shutdown` 供主进程在退出前优雅调用 | ✅ 已修（已冒烟验证，见第四节） |
| B-04 | P1 | bridge.mjs:730-736 | 「一键修复前台通道」跑完之后，**windows-mcp 子进程变孤儿** —— 修复流程本身在制造孤儿进程 | `afterInstall()` 里 `const s = sessions.get("windows"); if (s && typeof s.close === "function") s.close();`。session 对象是 `{ client, transport, tools }`（bridge.mjs:1403-1407），**根本没有 close 方法** → 判断恒 false → 只删了 map 引用，连接和子进程原封不动 | 改调 `disposeSession("windows")`（会真正 `client.close()` + `transport.close()`） | ✅ 已修 |
| B-05 | P1 | bridge.mjs:1345-1363 | 触发器**关不掉**且句柄泄漏：两条触发器 id 相同时，前一条的 interval/watcher 永远留在内存里跑 | `triggerHandles.set(t.id, ...)` 拿 id 当句柄 key。id 重复有两条真实来源：① 面板同一毫秒内连续新建（`t.id = "t" + Date.now().toString(36)`，bridge.mjs:2183）；② `triggers.json` 手工编辑漏写 id（全是 `undefined`）。后一条把前一条的句柄覆盖掉，`disarmTriggers()` 再也摘不到 | 新增 `ensureTriggerIds()`（加载与武装前各跑一次，重复即重发 id 并落盘）；`armTriggers()` 的句柄 key 改为 `` `${t.id}#${idx}` `` 双保险 | ✅ 已修 |
| B-06 | P1 | bridge.mjs:266-274 | 每次后台 daemon 派发都留下一个**最长 90 秒的空转定时器** | `daemonRun` 的超时 `setTimeout` 是裸的：回调先到时只 `pendingRuns.delete()` + `resolve()`，定时器本身没人 `clearTimeout`，一直挂到 `waitMs` 到点 | 把 `pendingRuns` 的 `resolve/reject` 包一层，先 `clearTimeout(timer)` 再结算 | ✅ 已修 |
| B-07 | P1 | bridge.mjs:1557-1576 | `jobs` Map **无上限增长**（内存只涨不降），且被淘汰的 job 跑完还会"复活"出一个残缺对象 | ① 淘汰条件 `keys.find(k => status !== "running")`，60 条全是 running 时 `oldest` 为 undefined → 直接 `break` → 上限形同虚设；② 完成回调里 `jobs.set(id, {...cur, ...})` 在 `cur` 早已被淘汰时会重新写回一个**没有 id / server / tool** 的对象。每条 result 是工具的完整返回（一张截图常见 1~3MB） | 淘汰时优先非 running，找不到就淘汰最老的一条（保证 `MAX_JOBS` 一定生效）；完成回调改用 `if (cur)` 闸门防止复活 | ✅ 已修 |
| B-08 | P1 | bridge.mjs:645-658 | 启动回收**可能误杀无关进程** | 台账存的是 PID，而 PID 会被系统回收再利用：跨一次重启、或上次 ORB 已是很久以前的事，那个号完全可能属于别的程序。原实现是拿出来就 `taskkill /PID … /T /F`，注释里写的"不会误伤别的程序"并不成立 | 杀之前做两道核对：① 记录时间超过 7 天不认；② 一次 `tasklist /FO CSV /NH` 拿到 pid→进程名，`kind` 对应的镜像名对不上不杀（`windows→windows-mcp.exe`、`cli→codebuddy.exe`、`asr/rt→python.exe`、`dsh→node.exe`）。拿不到进程名单就整批跳过（认不出身份一律放过） | ✅ 已修 |
| B-09 | P2 | bridge.mjs:1764-1765 | 实时字幕服务可能"再也起不来" | `rtStart()` 的判活是 `if (rtProc) return;`。进程已退出、但 `exit` 事件还没派发时 `rtProc` 仍是旧对象，调用会被挡住（此后 `exit` 事件才把它置 null，但这次调用已经废了） | 改按 `rtProc.exitCode === null` 判活；`asrSpawn()` 同款加固（避免新引用顶掉旧进程） | ✅ 已修 |
| B-10 | P2 | bridge.mjs:988-994 | 审计日志写盘失败会**把整个 bridge 带崩** | `auditStream = createWriteStream(...)` 后没有 `error` 监听。磁盘满 / 目录变只读时流抛 `'error'` → 无监听者 → 升级为未捕获异常 | 加 `auditStream.on("error", ...)`，写不进去就跳过这一条 | ✅ 已修 |
| B-11 | P2 | bridge.mjs:1355 | 文件触发器监听的目录被删 / 盘符掉线时，FSWatcher 抛 `'error'` 无人监听 → 未捕获异常 | `fsSync.watch()` 返回的 watcher 只传了 callback | `w.on("error", ...)` 记录并继续 | ✅ 已修 |
| B-12 | P2 | bridge.mjs:199-219 | 并发调用 `ensureDaemon()` 会顶掉 `daemonProc` 引用，上一个进程从此没人管 | `daemonProc = spawn(...)` 无"已有实例在起"的判断。两个并发后台任务 + 面板预热同发时可达 | 加 `if (daemonProc && daemonProc.exitCode === null)` 分支，已有实例就直接进等待循环 | ✅ 已修 |

---

## 二、性能问题清单（**不在本轮修复范围**，留给任务 #3）

> 本轮严格只修 Bug。以下条目是审计中确认存在、但属于"优化"而非"错误"的点，按预估收益从高到低排列。

### 1. `pollForeground` 每 500~1000ms 起一次 PowerShell —— 全场最大的 CPU 开销源 ★★★
- 位置：main.js:758-771（`foregroundRect`）+ 866-871（`startTrack`）
- 现状：一次 `powershell.exe -EncodedCommand`（脚本内含 `Add-Type` 编译 `user32.dll` 的 P/Invoke），冷启动 1~3 秒、峰值吃满一个核。面板打开期间常驻；执行前台动作期间（observing>0）更是压到 500ms 一次。
- 建议（按收益递减）：
  - **(a) 原生化**：`native/` 目录里已有 `orb-input.exe` 的先例，照做一发常驻的 `orb-foreground.exe`（`GetForegroundWindow` + `GetWindowRect`），由 bridge 或主进程常驻调用，毫秒级、零进程创建。**收益最大**：彻底消掉每秒一次的百 MB 级进程创建。
  - **(b) 脚本瘦身**：去掉 `Add-Type`（这是主要耗时），改用 PowerShell 的 `[System.Windows.Forms.Screen]` 或直接调 `user32.dll` 的预编译互操作缓存。收益中。
  - **(c) 语义收敛**：面板打开但**没有在执行动作**时（`observing === 0`）根本不需要知道前台窗口是谁 —— 现在只要面板开着就在追。把 `tracker` 只在 `observing > 0` 或"刚打开面板的头 2 秒"才起。收益中，改动最小，**建议与 (a) 一起做**。
- 预估：单次前台动作的 CPU 占用可降一个数量级；面板常开待机时 PowerShell 调用量接近 0。

### 2. `jobs` Map 持有完整工具返回值 —— bridge 内存峰值 ★★★
- 位置：bridge.mjs:1565-1574（`startJob`）+ 2486-2494（`/api/job/:id`）
- 现状：每条 job 的 `result` 是工具的**完整返回**，`Screenshot` 一次就是 base64 PNG 1~3MB；`MAX_JOBS = 60` → 峰值 100MB+ 常驻，且 GC 不掉（Map 强引用）。
- 建议：只保留文本摘要（或干脆不存 result，让面板在 job 完成时通过 `LIVE`/通知拿结果）；必须保留时按大小淘汰——超过 512KB 的 result 直接丢弃并置 `truncated: true`，面板侧已有 `j.result?.content` 的可选链容错。
- 预估：bridge 常驻内存降 50~150MB。

### 3. `setInterval(dragTick, 16)` —— 拖拽期间 62fps ★★
- 位置：main.js:306（泄漏问题已在 M-01 修掉，这里说的是**正常路径的开销**）
- 现状：每个 tick 做 `getCursorScreenPoint()` + `ball.getBounds()` + `ball.setPosition()`，62 次/秒，跨进程 IPC。
- 建议：16ms → 30~33ms（约 30fps）。悬浮球跟随是"位移"，不是动画，30fps 视觉上无差别，主进程 IPC 量直接减半。
- 预估：拖拽期间主进程 CPU 降约 50%。

### 4. `stopSelectionWatch` 的常驻 PowerShell ★★
- 位置：main.js:572-619
- 现状：`spawn("powershell.exe", ["-EncodedCommand", b64])` 常驻监听 UIA 选区，约 30~80MB 常驻 + 事件循环开销。
- 建议：功能确实需要，短期不动；长期可考虑并入 (1a) 的原生模块（用 `SetWinEventHook(EVENT_OBJECT_TEXTSELECTIONCHANGED)`）。
- 预估：省 30~80MB 内存，但改造成本高，列为长期项。

### 5. `log()` 每次同步 `appendFileSync` ★
- 位置：main.js:73-88
- 现状：所有日志同步写盘。高频点包括 `hover`（鼠标每次进出悬浮球都打一条）、`[watch] select`（每次划词）、`[drag-end]`。
- 建议：加 256 行 / 2 秒的批量缓冲；`hover` 那条日志直接降级（或只在状态变化时打）。
- 预估：减少主线程同步 I/O 阻塞，磁盘写入降一个数量级。

### 6. `spawnOnce` 的 `maxBuffer: 64MB` ★
- 位置：bridge.mjs:1733
- 现状：一次后台任务最多把 64MB 输出缓冲在内存里。CLI 的 `--output-format text` 是纯回答正文，用不到这个量级。
- 建议：降到 8MB（超限会 `err`，但正常回答远达不到；真超了也比吃掉 64MB 好）。
- 预估：后台任务期间内存峰值上限降 56MB。

### 7. `subPoll` 500ms 轮询本地 HTTP ★
- 位置：main.js:719-726（泄漏已修，这里说周期）
- 建议：500ms → 800~1000ms；或让 `subtitle_rt.py` 支持 SSE 长轮询，彻底去掉轮询。收益小-中。

### 8. `borderTimer` 500ms ★
- 位置：main.js:888
- 建议：500ms → 800ms。边框跟随的是窗口矩形，不需要 2Hz 以上。收益小。

### 9. `READ_CACHE` 缓存整个 result 对象 ★
- 位置：bridge.mjs:1375-1376、2034
- 现状：700ms 缓存期内持有一份完整 `Screenshot` 结果（含 base64 图）。
- 建议：缓存期降到 300ms，或只缓存文本型结果。收益小。

### 10. 急停时的 N 个 `taskkill` 进程 ★
- 位置：bridge.mjs:890-904（`killActiveProcs`）、651-653 / 934（`reapStaleChildren`）
- 现状：每个 PID 起一次 `taskkill`，急停时会瞬间起 N 个进程。
- 建议：`taskkill` 支持多个 `/PID`，改成一次性批量调用（`/PID a /PID b /PID c /T /F`）。收益：急停更快、进程创建更少。

### 11. ASR 空闲回收周期 ★
- 位置：bridge.mjs:1702（默认 10 分钟）
- 现状：已经是"按需启动 + 空闲回收"，做得很好。
- 建议：想更激进可以把 `ORB_ASR_IDLE_MS` 降到 5 分钟，让 ~238MB 内存 + ~2.1GB 显存更快释放。收益取决于用户习惯。

### 12. `/api/status` 轮询间隔 ★（跨层，需与渲染层任务协调）
- 位置：面板每 5 秒轮询（渲染层），bridge 侧已加 30 秒连接退避（bridge.mjs:1961-1968）
- 建议：5s → 10s。bridge 侧遍历 SERVERS 时会保活 windows-mcp 连接。收益中，但要改 panel.html。

---

## 三、需要用户确认才能改的疑点（**未擅自动**）

1. **`get-state` 里的 `workspace` 字段**（main.js:1380）：`path.join(__dirname, "..", "..")`，打包态指向只读的 `resources` 目录。面板只在 panel.html:2788 用它**读**目录（`act.value || workspace`）。是否要改成 `DATA_ROOT`？开发态两者完全相同，打包态语义不同 —— 需确认"工作区"到底希望指向哪里（项目目录 / 数据目录）。

2. **bridge 崩溃后是否自动重启**（main.js:1107）：现在 `bridgeProc.on("exit")` 只记日志，不重启。若 bridge 中途挂掉，ORB 全部功能失效直到手动重启。加"自动重启 N 次"是产品行为决策，需要确认。

3. **关闭「操作时显示观察边框」的即时性**（M-13 引入）：现在关掉开关会**立刻**撤下观察态（强制 `observing = 0`）。若此时面板正在视觉循环中，边框会马上消失，且循环结束后不会自动恢复（要等下一次 `setObserving(true)`）。我判断"关掉就要真的停"符合用户意图，但严格说是行为变化，请确认。

4. **触发器 interval 的重入**（bridge.mjs:1352）：`setInterval(() => fireTrigger(t, "interval"))` 没有重入保护 —— 若上一次回放还没跑完，会并发跑同一工作流。我倾向加"上一次没跑完就跳过本次"，但这改变了调度语义（用户可能就是想密集触发），需确认。

5. **`Ctrl+Alt+S` 无选区时的行为**（M-04 引入）：现在返回空串，面板会提示"没取到选中文字——先选中一段文本，再按 Ctrl+Alt+S"。原行为是用旧剪贴板内容冒充选区（我认为那明显是错的），请确认新行为符合预期。

6. **新增的 `POST /api/shutdown`**（bridge.mjs 末尾）：带 `X-Orb-Token` 鉴权，外部网页调不动（已验证无令牌返回 401）。且 main.js 只对自己 spawn 的 bridge 调用它（外部 `start.cmd` 起的 bridge 不受影响）。若希望"ORB 退出时连外部 bridge 一起收掉"，需要另外确认。

---

## 四、自检结果

| 检查项 | 结果 |
|---|---|
| `node --check desktop/main.js` | ✅ 通过 |
| `node --check bridge.mjs` | ✅ 通过 |
| IPC 通道完整性 | ✅ 33 个通道一个没少（`ipcMain.on` 19 + `handle` 14），语义未变；仅把其中 12 个 `handle` 换成同通道的 `safeHandle` 包装 |
| 快捷键完整性 | ✅ `Control+Space` / `Control+Alt+S` / `Control+Alt+G` / `Control+Alt+Backspace` / `Control+Alt+E` / `F9` 全部保留（含 hotkeys.json 的急停保底逻辑） |
| CSP | ✅ 四个 HTML 页面的 CSP 一行未动 |
| Windows 路径 / powershell 调用方式 | ✅ 未改（`selection-watch.ps1`、`PS_FOREGROUND`、`OCR_PS`、`taskkill`、`netstat` 全部原样） |
| 动态探测 | ✅ `resolveNodeExe()`（main.js:48 / bridge.mjs:39）、`resolveBasePy()` 未改成硬编码 |
| 隔离冒烟测试 | ✅ 见下 |

**隔离冒烟测试**（`ORB_PORT=19399` + 独立 `ORB_DATA_DIR`，测试目录已删除，未污染 `orb/.bridge.json`）：

```
[1] /api/status              windows.ok = true  tools = 19     ← windows-mcp 连通
[2] 台账 pid = 15912 kind = windows  停机前存活 = true
[3] /api/shutdown ->         {"ok":true}
[4] bridge 端口存活 =        false                             ← 优雅退出
[5] MCP pid 停机后仍存活 =   false                             ← ★子进程被回收（B-03 修复生效）
[6] 台账 =                   []                                ← 干净退出不留台账
另：无令牌 POST /api/shutdown → 401 {"ok":false,"error":"缺少或错误的 X-Orb-Token"}
```

---

## 五、改动点概要

### `desktop/main.js`（+217 行）
- 新增：`logArg()`、`safeHandle()`、`clampToWorkArea()`、`stopDragTimer()`、`pushNotice()`/`flushNotices()`、`stopObserveAll()`、`stopBridge()`、`before-quit` 钩子
- 修改：`log()`（异常兜底）、`waitForBridge()`（socket 超时）、`createBall()`（坐标夹取）、`beginDrag()`/`dragTick()`（定时器不泄漏）、`createSubtitleWin()`/`pollSubtitleLines()`（字幕轮询自停）、`createToolbar()`/`showToolbar()`（文本补发）、`captureSelection()`（不再返回旧剪贴板）、`pollForeground()`（并发闸）、bridge spawn（error 监听 + 失败提示）、`bridgeCall()`（401 重试 + 非 JSON 兜底）、`bridge-token`（令牌重读）、`will-quit`（补全清理）、观察边框开关（真停）、`HISTORY_DIR`（→DATA_ROOT）、12 个 IPC handler（safeHandle）、`set-vision`/`set-voice`（patch 类型校验）

### `bridge.mjs`（+178 行）
- 新增：`process.on("uncaughtException"/"unhandledRejection")`、`daemonSpawnErr`/`asrSpawnErr`/`rtSpawnErr`（fail-fast）、`ensureTriggerIds()`、`pidImageMap()`、`KIND_IMAGES`/`REAP_MAX_AGE_MS`、`POST /api/shutdown`
- 修改：`ensureDaemon()`（并发保护 + error 监听）、`daemonRun()`（超时定时器清理）、`repairFront().afterInstall`（改调 `disposeSession`）、`loadTriggers()`/`armTriggers()`（id 去重 + 句柄 key + watcher error 监听）、`startJob()`（淘汰上限生效 + 防复活）、`asrSpawn()`/`rtStart()`（error 监听 + 判活）、`asrEnsure()`/`/api/rt`（fail-fast）、`audit()`（流 error 监听）、`reapStaleChildren()`（双重复核后才杀）、`shutdown()`（收尾全覆盖）、listen 回调（异步回收）

---

## 六、修订记录（交付后的补充改动）

### R-1｜`/api/job/:id` 的 404 文案改成能自解释的（bridge.mjs:2646）
- **由 B-07 的修复连带产生**：淘汰上限现在对 running 状态的 job 也生效（原来 running 的永远淘汰不掉）。于是"查不到 job"多了一个真实成因 —— 被挤掉了。
- 原实现只回 `"job not found"`，调用方分不清是"id 写错了"还是"被挤掉了"，排查只能干瞪眼。
- 改为：`job ${id} 不存在或已被淘汰（最多保留 ${MAX_JOBS} 条）`。
- **只改文案不改结构**：响应体仍是 `{ ok: false, error }` + 404，渲染层的 `if (!r.ok)` 判断路径不变。
- 已同步 software-engineer：面板侧若要给这个分支一个终态提示（现在会停在「后台执行中…」），可直接取 `r.error`，改动量一行，属渲染层文件由其决定。

### R-2｜与渲染层敲定的跨层契约：jobs 结果裁剪的字段名
- 裁剪属性能优化任务 #3（owner: software-engineer），本轮未实现，仅定契约。
- 约定：**标志挂 job 顶层 `truncated: true`，触发裁剪时 `result` 键整个不返回**（因为裁剪的目的就是不把大 result 留在内存里，返回一个"缩水版 result"没有意义）。
  ```
  未裁剪：{ id, server, tool, status:"done", finishedAt, result: {...} }
  已裁剪：{ id, server, tool, status:"done", finishedAt, truncated: true }
  ```
- 渲染层已预置兜底 `j.truncated || j.result?.truncated`（两种位置都认），当前 `truncated` 恒为 undefined，**不改变任何现有行为**，桥侧一上线即自动生效。

### 校验
- `node --check bridge.mjs` ✅ 通过；`MAX_JOBS` 定义（367）早于两处使用（1690 / 2646），无 TDZ
- 未新增任何 IPC 通道，未改动任何既有通道语义
