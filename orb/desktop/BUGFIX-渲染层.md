# ORB 控制台 —— 渲染层 Bug 审计与修复清单

范围：`desktop/panel.html`、`desktop/voice.js`、`desktop/preload.js`
审计日期：2026-10-13　工程师：寇豆码（Kou）
备份：修改前已自行备份为 `panel.html.koubak-20261013-230616` / `voice.js.koubak-*` / `preload.js.koubak-*`

严重度定义：**P0** 功能不可用 / 数据丢失 / 崩溃；**P1** 明显错误行为；**P2** 健壮性 / 边界 / 隐患。

---

## 一、Bug 清单

| # | 严重度 | 文件:行号 | 问题描述 | 根因 | 修复方案 | 状态 |
|---|---|---|---|---|---|---|
| 1 | P1 | `panel.html:2199(原)` / 修复点 `2193 / 6065` | **首屏提示（`Ctrl+Space 唤起面板…`）永远看不到** | 启动期两个并发 IIFE 存在竞态：`historyLoad` 那条链先返回 → `startFreshConversation()` 里 `addMsg(..., silent=true)` 把提示贴到 DOM → 随后 init 尾部的 `render()` 执行 `msgs.innerHTML=''`，而提示是 silent 的、不在 `cur.messages` 里，重建时不会再回来，直接被抹掉 | 增加 `freshStarted` 闸门：`startFreshConversation()` 置位，init 尾部改为 `if (!freshStarted) render()` | ✅ 已修 |
| 2 | P1 | `panel.html:2368 / 5908` | **顶栏「前台 / 原生 / 后台」三盏通道灯只在启动时刷一次，之后永不更新**；若启动瞬间 bridge 还没就绪，三盏灯会永久停在「断开」 | 合并轮询后 `pollStatus()` 拿到的 `/api/status` 里明明带着 `windows / orb / workbuddy` 三个通道字段，但只用了 `live / stop / pending`，没应用到指示灯；`refreshStatus()` 全文件仅 1 处调用 | 从 `refreshStatus()` 抽出 `applyChannels(s)`，`pollStatus()` 每次拿到响应后复用（不新增请求） | ✅ 已修 |
| 3 | P1 | `panel.html:2726-2745` | **后台任务轮询泄漏：`runningJobs` 永不归零，悬浮球永久挂在「忙碌」** | `poll()` 内 `try { r = await api(...) } catch { return; }` —— 网络异常 / bridge 重启时既不 `clearInterval` 也不 `setRunning(-1)`，2 秒一次的轮询永久空转，且忙计数再也回不去 | 加连续失败计数 `fails`，连续 15 次（约 30s）取不到即 `clearInterval` + `setRunning(-1)` + 提示「后台任务状态失联」 | ✅ 已修 |
| 4 | P1 | `panel.html:4096` | **中文输入法组合态按回车会误发送**：打一半按回车选候选词 → 半截内容被发出、输入框被清空 | `input` 的 keydown 只判 `e.key === 'Enter' && !e.shiftKey`，未排除 IME 组合态 | 开头加 `if (e.isComposing \|\| e.keyCode === 229) return;`（Chromium 组合期两个特征都覆盖） | ✅ 已修 |
| 5 | P1 | `panel.html:2168-2173` | **磁盘会话历史 >20 条时，第一次发消息即被永久截断到 20 条** | `save()` 里 `convs.slice(-20)` 本来是为 localStorage 容量设计的，却同样作用于磁盘落盘；而 `historyLoad` 读回的是**全部**历史，读写不对称 | ✅ 用户拍板「磁盘不限量、localStorage 仍限量」：两条路径拆开——`store.setItem('orb.convs', convs.slice(-20))` 只供 localStorage 缓存，`window.orb.historySave(convs.slice())` 落盘全量；`historyReady` 闸门原样保留 | ✅ 已修（2026-10-13 用户决策后落地） |
| 21 | P1 | `panel.html:2180-2185 / 4212 / 4228 / 4367 / 4379` | **切回很早的会话继续聊时，该会话会被挤出 localStorage 的 20 条窗口** | `slice(-20)` 按数组位置截取，不是按「最近活跃」；老会话在数组头部，一保存就被丢掉 | 新增 `touchCurrent()`：切会话 / 新建会话时把 `cur` 从原位置摘出再 `push` 到末尾，保证最近活跃的会话始终留在缓存窗口内；磁盘存档是全量的，不受影响 | ✅ 已修（2026-10-13 用户决策后落地） |
| 23 | P2 | `panel.html:2774-2783` | **拿不到 job（404 / 被 bridge 的 `MAX_JOBS` 淘汰）时，消息永远停在「后台执行中… N 秒」，没有终态** | `poll()` 的 `if (!r.ok)` 分支只 `clearInterval` + `setRunning(-1)` 就 `return`，不给消息节点任何更新；气泡卡在"执行中"，用户既等不到结果也看不到失败 | `!r.ok` 分支补 `updateMsg(node, '后台任务状态已丢失：' + esc(r.error), 'err')`。bridge 侧 404 文案已改成「job X 不存在或已被淘汰（最多保留 N 条）」，直接显示即可自解释 | ✅ 已修 |
| 24 | P2 | `panel.html:2804-2815` | **jobs 结果裁剪后表达不清**（跨层预约项，裁剪尚未上线） | 原代码只有 `|| '(无文本返回)'` 一个兜底，裁剪上线后用户会以为任务没产出 | 按与 bridge 约定的契约（`truncated: true` **挂 job 上**）铺好两种形态：result 整个没了 → 「已被省略，未回传全文」；result 还在但截短了 → 正文照显 + 末尾补「以上仅为开头部分」。**当前 `truncated` 恒为 undefined，不改变现有行为** | ✅ 已修（前置铺路） |
| 22 | P2 | `panel.html:1849 / 4914 / 4932-4933 / 4942-4943 / 2046` | **急停的作用范围没有任何说明**，用户会以为「按了急停却还有后台任务在跑」是 bug | 有意设计（急停只中断前台执行与录制，不影响已派发的后台任务），但界面上没写出来 | ✅ 用户确认保持现有行为不改，只补纯文案：抽 `STOP_SCOPE_NOTE` 常量，顶栏急停按钮的 `title` / `aria-label` 与设置面板「安全」分区说明各加一句「急停用于中断当前前台执行与录制，不影响已派发的后台任务」。**未禁用发送按钮、未改 `runBack`** | ✅ 已修（纯文案，2026-10-13 用户决策后落地） |
| 6 | P2 | `panel.html:4440` | **命令面板打开后再按 Ctrl+K 关不掉**（只能 Esc 或点遮罩） | `cmdInput` 的 keydown 里 `e.stopPropagation()`，document 上的 Ctrl+K 处理器收不到；而 `openCmd()` 30ms 后就把焦点给了 `cmdInput`，所以焦点永远在它身上 | 在 `cmdInput` 的 keydown 里自己接一次 Ctrl+K → `closeCmd()` | ✅ 已修 |
| 7 | P2 | `panel.html:3927-3950` | **关闭设置面板后 180ms 内再次点开，会被上一次的退场定时器关掉**（「点开设置，一闪就没」） | `closeVisionSheet()` 的 180ms `setTimeout` 句柄没保存，`openSheet()` 无法取消它；`sheetClosing` 虽被重置，但旧定时器到点仍会 `remove('show')` | 用 `sheetCloseTimer` 保存句柄，`openSheet()` 里先 `clearTimeout` 再重置状态 | ✅ 已修 |
| 8 | P2 | `panel.html:4962 / 4977` | **危险操作确认框点完「允许/拒绝」会闪回来**，可能诱导二次点击 | `applyPending()` 的判重条件是 `cfmId === p.id && mask.classList.contains('on')` —— 弹窗一隐藏就不再判重，而服务端此时还没把该条从队列摘掉，下次轮询被当成新条目重弹 | 判重只看 `cfmId === p.id`；`answerConfirm()` 不再提前清空 `cfmId`，等该条真的从队列消失（`list` 为空）才归零 | ✅ 已修 |
| 9 | P2 | `panel.html:2601 / 4200 / 4344` | **「新建会话」后权限滑轨与实际权限不一致**：新会话 `access='full'`，但界面仍显示旧档位 | `newConv()` 分支只做了 `cur = newConv(); render();`，漏了 `access = cur.access` 与滑轨同步（同一文件里「切换会话」分支是做了的） | 抽出 `syncAccessUi()`，三处换 `cur` 的地方统一调用 | ✅ 已修 |
| 10 | P2 | `panel.html:2148` | **`orb.convs` 被写成非数组（null / 对象 / 字符串）时，`convs.filter` 抛错**，打断会话初始化 | `load()` 只 try/catch 了 JSON.parse，没校验结果类型 | `Array.isArray(v) ? v : []` 归一 | ✅ 已修 |
| 11 | P2 | `panel.html:4509 / 4524 / 4521 / 4558 / 4561 / 4707 / 4712 / 4718 / 4750-4751 / 4854 / 4858 / 4865-4867 / 4923 / 4926 / 5823 / 5826 / 5833` | **多处 `addMsg` 把用户输入 / bridge 返回的文本未转义塞进 `innerHTML`**：工作流名（`r.name`，用户起名任意）、bridge 错误文本、AI 模型原始返回。可注入 `<img onerror=…>` 破坏渲染 | `addMsg` 的 `html` 参数语义是「可信 HTML」，但这些调用方传的是不可信字符串，而旁边的同类调用都规规矩矩 `esc()` 了 | 全部补 `esc()`（错误文本 / 名称 / 模型返回 / 步数等） | ✅ 已修 |
| 12 | P2 | `voice.js:24-25 / 272 / 285 / 324` | **语音设置里 API Key 状态永远显示「尚未设置」**（明明保存过） | 主进程 `get-state`（`main.js:1363`）出于安全只返回 `hasKey` 布尔，**不回传** `apiKey`；而 `voice.js` 用 `cfg.apiKey` 判断 | 新增 `keySaved()` = `cfg.apiKey \|\| cfg.hasKey`，三处状态文案统一走 `keyStateText()` | ✅ 已修 |
| 13 | P2 | `voice.js:64 / 185-215 / 168` | **Whisper / 麦克风失败原因用户看不到** | `setActive(false)` 无条件 `statusEl.style.display="none"`，而失败文案在它之前写入，随即被隐藏 | 失败分支改为先 `setActive(false)`，再放开 `display` 并写文案 | ✅ 已修 |
| 14 | P2 | `voice.js:130-142` | **浏览器引擎报 network / service-not-allowed 后无限重启**：按钮一直停在「停止」图标，界面像卡死 | `onerror` 里只显示文案、没把 `active` 置 false；随后 `onend` 见 `active` 仍为 true 就 `r.start()` 再来一轮，一秒重试好几次 | 不可自愈的错误码分支里先 `active=false; recognizer=null; setActive(false)`，再显示文案 | ✅ 已修 |
| 15 | P2 | `panel.html:2334 / 2805 / 3790` | **`setObserving(false)` 延时定时器互相覆盖**：连续两次前台动作，前一个定时器会提前撤掉后一次还在用的观察状态 | 两处各起裸 `setTimeout`，无句柄管理 | 抽出 `stopObservingSoon(ms)`，单句柄，新的来先 `clearTimeout` 旧的 | ✅ 已修 |
| 16 | P2 | `panel.html:4392 / 4464` | **命令面板打开后异步刷回工作流列表，会把用户用 ↑↓ 选中的条目打回第 0 项** | `renderCmd()` 无条件 `cmdSel = 0`；`openCmd` 的 `.then()` 里又调了一次 `renderCmd()` | `renderCmd(keepSel)` 增加保留选中项参数，异步补渲染时传 `true` | ✅ 已修 |
| 17 | P2 | `panel.html:2628-2650` | **`syncSlider` 的「量实际格宽」兜底分支永远走不到**（死代码） | `parseFloat(...) \|\| 30` 已保证 `sw` 恒为真，下一句 `sw \|\| first.getBoundingClientRect().width \|\| 30` 后半截永远不执行 | 改成在解析结果上判空：`Number.isFinite(sw) && sw > 0 ? sw : (量一次 \|\| 30)` | ✅ 已修 |
| 18 | P2 | `preload.js:3(原)` → `preload.js:3-36` | **`on()` 无法解绑**：注册的是包装函数，渲染层拿不到它，`removeListener` 无从下手；重复注册就会累积（同一事件被处理 N 次） | 未保存 wrapper、未暴露解绑入口 | 增加 `listeners` 表：`on()` 对同一 `(channel, cb)` 只注册一次并保存 wrapper；新增 `orb.off(channel, cb)`（纯追加，不改任何现有 API 语义） | ✅ 已修 |
| 19 | P2 | `panel.html:6057` | **`orb-open-voice-settings` 打开的是上次停留的页签**，而提示写的是「点此打开语音设置」，用户照做却看不到要改的项 | 事件处理器只调了 `openVisionSheet()`，没激活「语音」页签 | 打开前先 `click()` 一下 `#setnav .setnav-i[data-pane="voice"]`（复用 `bindThemeUI` 里已有的切页逻辑） | ✅ 已修 |
| 20 | P2 | `panel.html:2504` | `dangerToggle()` 里 `const cur` **遮蔽了全局的当前会话 `cur`**（当前无实际影响，属隐患） | 命名与全局状态冲突 | 改名为 `fsRest` | ✅ 已修 |

**合计 24 条：P0 = 0，P1 = 7，P2 = 17。已修 24 条，待确认 0 条。**
（#5 / #21 / #22 为 2026-10-13 用户拍板后追加落地，详见第二节末与第三节；#23 / #24 为与 software-engineer-2 跨层对齐后追加。）

---

## 二、已修 P0 / P1 摘要

1. **首屏提示永远看不到**（`panel.html`）——启动期两个并发 IIFE 竞态，后跑的 `render()` 把 silent 提示抹掉。加 `freshStarted` 闸门。
2. **通道指示灯永不刷新**（`panel.html`）——合并轮询后 `/api/status` 里的通道字段被丢掉，只有启动时刷一次。抽出 `applyChannels()` 在 `pollStatus()` 里复用。
3. **后台任务轮询泄漏 + 忙计数不归零**（`panel.html`）——`poll()` 的 `catch { return; }` 既不清理 interval 也不减计数。加连续失败上限后收摊。
4. **输入法回车误发送**（`panel.html`）——未判 `isComposing` / `keyCode 229`，中文输入到一半按回车选词即被发出并清空输入框。
5. **磁盘历史被截断**（`panel.html:2168`）——读写不对称（读全部、写 20 条）。✅ 已按用户决策修复：磁盘写全量、localStorage 仍限 20 条。
6. **老会话被挤出 localStorage 窗口**（`panel.html:2180`）——切回早期会话继续聊会被 `slice(-20)` 丢掉。✅ 已修：新增 `touchCurrent()` 把当前会话挪到数组末尾。
7. **急停作用范围无说明**（`panel.html:1849 / 4914 / 2046`）——易被误判为 bug。✅ 已修：保持行为不变，只补 tooltip 与设置页文案。
8. **job 被淘汰后消息卡在「执行中」无终态**（`panel.html:2774-2783`）——`poll()` 的 `!r.ok` 分支不给终态。✅ 已修：补 `updateMsg` 显示 bridge 返回的 404 原因。

---

## 三、用户已拍板的决策（均已落地）

| 疑点 | 用户决策 | 落地位置 |
|---|---|---|
| `save()` 的 20 条上限是否也作用于磁盘落盘？ | **磁盘不限量，localStorage 仍限量** | `panel.html:2168-2173` |
| 老会话被挤出 localStorage 窗口怎么办？ | **切会话 / 新建会话时把当前会话移到数组末尾** | `panel.html:2180-2185` + 4 处调用点 |
| 急停是否要禁用发送按钮 / 拦截后台任务？ | **保持现状不动行为**，只补文案说明作用范围 | `panel.html:1849 / 4914 / 4932-4933 / 4942-4943 / 2046` |

## 四、仍需用户确认的疑点（未动）

1. **`execute()` 的 `setObserving(false)` 延时（2400ms / 1200ms）数值是否合理**
   现在只做了「单句柄、不互相覆盖」的修复，时长本身没动。若用户反馈观察态提前结束，再调数值。

2. **磁盘历史改为全量后文件会随时间增长**
   已按决策落地，但没有做归档 / 滚动切分。若日后 `conversations.json` 涨到很慢影响启动读盘，需要再定一个归档策略（例如按月切文件）。提前知会。

3. **`openAddStep(arr, afterAdd)` 的第二个参数 `afterAdd` 从未被使用**（`panel.html:5230 附近`）
   死参数，删掉是安全的，但属于清理性质，未在本轮改动。

---

## 四、自检结果

> 最近一次校验：2026-10-13（用户决策三项落地后）

| 项 | 结果 |
|---|---|
| `panel.html` 主 `<script>`（4000 行）抽出后 `node --check` | ✅ 通过 |
| `voice.js` `node --check` | ✅ 通过 |
| `preload.js` `node --check` | ✅ 通过 |
| 新增硬编码颜色 | ✅ 无（唯一新增的 `#a32d2d` 与同函数内既有 5 处错误文案完全一致，非新令牌） |
| 新增外部资源（CDN / 外链字体 / 图片 / `@import`） | ✅ 无 |
| 新增 `animation` / `transition` / `backdrop-filter` | ✅ 无（diff 全量比对为空） |
| `prefers-reduced-motion` 兜底 | ✅ 未被触碰，9 处媒体查询原样保留 |
| 主题令牌 / 品牌色 | ✅ 未引入新颜色，未破坏 `data-theme` 切换 |
| 既有交互与快捷键 | ✅ 全部保留（Ctrl+Space / Ctrl+K / Ctrl+Alt+S / Ctrl+Alt+G / Ctrl+Alt+Backspace / F9 均只做增强，未移除） |
| 顶栏 SVG 图标 | ✅ `setRecUi` / `renderStop` 仍只切 class，未引入 `textContent` 赋值 |
| `data-route="auto"` init 尾部查询 | ✅ 属性与代码原样保留 |
| `historyReady` 落盘闸门 / 每次重启开新会话 | ✅ 闸门原样保留（先 localStorage、再判闸门、最后落盘），`startFreshConversation()` 仍不落盘 |
| `save()` 两条路径 | ✅ localStorage 仍 `slice(-20)`，磁盘全量；两条已拆开，互不干扰 |
| 急停行为 | ✅ 未禁用发送按钮、未改 `runBack`，仅补 tooltip / 说明文案 |

---

## 五、改动文件与改动点概要

### `desktop/panel.html`（+152 / -55 行，另加本轮用户决策三项 +23 / -4）
- `load()`：结果类型归一为数组
- `startFreshConversation()` + 新增 `freshStarted`：修复首屏提示被 `render()` 抹掉
- 新增 `applyChannels()`，`refreshStatus()` 改为复用它；`pollStatus()` 每次应用通道状态
- `poll()`：增加连续失败计数与收摊逻辑
- 新增 `stopObservingSoon()`，替换两处裸 `setTimeout`
- 新增 `syncAccessUi()`，三处换会话 / 新建会话 / 权限 chip 统一走它
- `input` keydown：排除 IME 组合态
- `cmdInput` keydown：补 Ctrl+K 关闭；`renderCmd(keepSel)` 保留选中项
- `closeVisionSheet()` / `openSheet()`：退场定时器句柄化
- `applyPending()` / `answerConfirm()`：确认框判重改为只按 id
- `syncSlider()`：修正失效的格宽兜底
- `dangerToggle()`：`cur` → `fsRest`（消除全局遮蔽）
- `orb-open-voice-settings`：打开设置时切到「语音」页签
- 17 处 `addMsg` 补 `esc()`
- **（用户决策 1）** `save()` 两条路径拆开：localStorage 走 `convs.slice(-20)`，磁盘走 `window.orb.historySave(convs.slice())` 全量；`historyReady` 闸门不动
- **（用户决策 2）** 新增 `touchCurrent()`，在 `openHistory` 切会话、`cmdSources` 切会话、`openHistory` 新建会话、`cmdSources` 新建会话 4 处调用，把 `cur` 挪到 `convs` 末尾
- **（用户决策 3）** 新增 `STOP_SCOPE_NOTE` 常量；顶栏 `#stopBtn` 的 `title` / `aria-label`、设置面板「安全」分区 `.slotnote`、`renderStop()` 里两支动态 title（含 `#toolStop`）补作用范围说明——**行为零改动**
- **（跨层对齐）** `poll()` 的 `!r.ok` 分支补终态文案「后台任务状态已丢失：`<bridge 返回的原因>`」，修复 job 被 `MAX_JOBS` 淘汰后气泡永久卡在「执行中」
- **（跨层对齐）** `poll()` 结果读取处按与 bridge 约定的 `truncated` 契约铺好两种展示形态（前置铺路，今日零行为变更）
- `ensureToken()` 上方补注释：说明 `bridge-token` IPC 改为每次重读后 force 分支触发变少、但不能删

### `desktop/voice.js`
- 新增 `cfg.hasKey` / `keySaved()` / `keyStateText()`，修复 Key 状态永远显示「尚未设置」
- `onstop` 失败分支 / 麦克风打开失败 / 启动失败：失败文案在 `setActive(false)` 之后重新放开 `display`
- `onerror`：不可自愈的错误先 `active=false` 再 `setActive(false)`，阻断无限重启

### `desktop/preload.js`
- 新增 `listeners` 表；`on()` 对同一 `(channel, cb)` 去重并保存 wrapper；新增 `orb.off(channel, cb)`（纯追加）
