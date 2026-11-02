---
name: orb-bridge
display_name: ORB Desktop Control
display_name_zh: ORB 桌面操作助手
display_name_en: ORB Desktop Control
name_en: ORB Desktop Control
description: 让 AI 真正住进你的 Windows 桌面：既是随叫随到的桌面陪伴伙伴（常驻悬浮球、五人格、长期记忆越用越懂你），也是真能动手干活的员工。当用户想要：① AI 点击/输入/拖动/滚动桌面（打开软件、填表单、整理文件）；② 截图看屏幕、截屏取词、让 AI 自己看屏决定点哪；③ 开实时字幕或语音转写；④ 区域录屏；⑤ 把重活派给本机后台 Agent 跑完回收；⑥ 把一连串操作录成工作流回放——且本机已装 ORB 控制台时使用本技能。它通过本机桥接（127.0.0.1:19387，令牌鉴权）驱动原生输入、windows-mcp 视觉与 OCR、实时语音、录屏与录制回放，或调用 CodeBuddy CLI 后台执行，并由面板侧的长期记忆、五人格语音、在线语音合成等能力共同支撑。
description_zh: 让 AI 真正住进你的 Windows 桌面：既是随叫随到的桌面陪伴伙伴（常驻悬浮球、五人格、长期记忆越用越懂你），也是真能动手干活的员工。当用户想要：① AI 点击/输入/拖动/滚动桌面（打开软件、填表单、整理文件）；② 截图看屏幕、截屏取词、让 AI 自己看屏决定点哪；③ 开实时字幕或语音转写；④ 区域录屏；⑤ 把重活派给本机后台 Agent 跑完回收；⑥ 把一连串操作录成工作流回放——且本机已装 ORB 控制台时使用本技能。它通过本机桥接（127.0.0.1:19387，令牌鉴权）驱动原生输入、windows-mcp 视觉与 OCR、实时语音、录屏与录制回放，或调用 CodeBuddy CLI 后台执行，并由面板侧的长期记忆、五人格语音、在线语音合成等能力共同支撑。
description_en: "Let the AI live on your Windows desktop as both a companion and a doer: a persistent floating orb with five switchable personas and long-term memory that learns your habits, plus the ability to actually operate the PC. Use it when the user wants to: click/type/drag/scroll the desktop (open apps, fill forms); screenshot and read the screen, OCR text, or let the AI decide where to click; turn on live subtitles or speech-to-text; record a selected screen region; offload heavy work to a local background Agent and get the result; or record and replay a workflow — provided ORB Console is installed locally. It drives native mouse input, windows-mcp vision & OCR, real-time speech, region recording and workflow replay through the local bridge (127.0.0.1:19387, token-auth) or the CodeBuddy CLI, backed by panel-side long-term memory, five-persona voices and online speech synthesis."
version: 1.4.5
category: 效率工具
---

# ORB 桥接技能（v1.4.5）

本技能把本机运行的 **ORB 控制台**（github.com/zhoukr123/ORB-Console-made-for-workbuddy）的桥接服务
暴露给你，使你真的能操作用户的 Windows 桌面，而不是只能给建议。

v1.4.5 在 v1.3.0（原生输入 + 后台 Agent）的基础上，新增并开放了**视觉闭环、截屏取词 OCR、实时语音识别、
工作流录制回放、SSE 推送替代轮询**等能力。本技能一并封装，并保留「面板配置」一节覆盖所有 1.4.5 新特性。

## 一、什么时候用

满足**任意一条**就启用本技能：

- 用户说"帮我点 / 帮我打开 / 帮我拖 / 帮我滚动 / 帮我填这个表单"
- 用户说"桌面 / 文件管理器里做某个重复操作"
- 用户说"截图看一下屏幕上有没有 XX" / "把这段界面文字抠出来" / "翻译这个窗口里的词"
- 用户说"这个事情很麻烦，让 Agent 在后台跑完告诉我结果"
- 用户说"盯着屏幕，看到 XX 就点它"（视觉闭环）
- 用户说"帮我开实时字幕 / 边说边记"
- 用户说"把这一连串操作录下来，下次自动重放"
- 用户提到"ORB" / "悬浮球" / "桌面 AI 员工"

**不满足以下条件时不要启用**：请求只是查资料、写代码、分析文档、生成内容——这些你自己就能做，
不需要操作用户的电脑。

## 二、开工前的两步检查（必做）

### 第 1 步：确认 ORB 在运行

```bash
curl -s --max-time 3 http://127.0.0.1:19387/api/health
```

- 返回 JSON → 继续第 2 步。
- 连不上 / 超时 → **不要反复重试**。告诉用户：
  "ORB 控制台没有在运行。请先从
  https://github.com/zhoukr123/ORB-Console-made-for-workbuddy/releases 下载便携版并启动，
  启动后悬浮球会出现在桌面上。"
  然后**结束本次任务**，不要尝试用其它方式操作桌面。

### 第 2 步：取令牌

桥接服务的每个 `/api/*` 接口都要求 `X-Orb-Token` 头（`/api/health`、`/api/wb-callback` 除外）。
令牌在用户数据目录的 `.bridge.json` 里：

```
%APPDATA%\ORB 控制台\.bridge.json
```

用文件读取工具读这个文件，取 `token` 字段。规则：

- **只在本次任务期间持有**，任务结束即丢弃，不要写进任何文件、日志或回复正文；
- 读不到文件时不要猜测、不要复用旧值，直接按"ORB 未就绪"处理。

## 三、能力总览

| 轨道 | server / 端点 | 干什么 | 适合 |
| --- | --- | --- | --- |
| 原生输入 | `server=orb` | 点击、输入、拖动、滚动、长按（物理像素坐标） | 手上的活：打开软件、填表单、整理文件 |
| 视觉与观察 | `server=windows` + `/api/ocr` + `/api/vlm` | 截屏、看屏幕、截屏取词、视觉模型判读 | 没有 API、只能靠看的软件；读屏取字 |
| 后台 | `server=workbuddy` + `/api/dispatch` | 把重活派给本机 Agent，答案边跑边长 | 读代码库、写长文档、跑批处理 |
| 语音识别 | `/api/asr` + `/api/rt` | 实时语音转写 / 实时字幕 | 会议记录、边说边记 |
| 工作流 | `/api/wf` | 录制一连串工具调用并回放 | 每天重复的桌面操作 |
| 推送 | `/api/events` + `/api/job/:id/stream` | SSE 实时推状态 / 任务片段，免轮询 | 长任务进度展示（v1.4.5 起取代轮询） |

## 四、原生输入轨道（server = orb）

7 个鼠标 / 窗口原语，坐标是**屏幕像素**（左上角为原点）：

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `move_to` | `x`, `y` | 移动鼠标到指定像素坐标 |
| `mouse_press` | `x`, `y`, `button` | 在坐标处按下（`left`/`right`/`middle`） |
| `mouse_release` | `button` | 松开按键 |
| `long_press` | `x`, `y`, `durationMs`, `button` | 长按，`durationMs` 上限 60000 |
| `drag` | `x`, `y`, `x2`, `y2`, `durationMs`, `button` | 从 (x,y) 拖到 (x2,y2) |
| `scroll_at` | `x`, `y`, `direction`, `clicks` | 在坐标处滚动，`direction` 为 `up`/`down`/`left`/`right` |
| `cursor_position` | 无 | 返回当前鼠标坐标，用来确认位置是否合理 |

先 `GET /api/tools?server=orb` 可以拿到当前版本的工具清单（以它为准，不要假设）。

## 五、视觉与观察轨道（server = windows + /api/ocr + /api/vlm）

### 5.1 windows-mcp 工具

`server=windows` 是随包自带的 windows-mcp，提供截屏、看屏、取词、控件枚举等能力。常用工具
（**以 `GET /api/tools?server=windows` 实时清单为准**）：

| 工具 | 用途 |
| --- | --- |
| `Screenshot` | 截全屏，返回图像（供 OCR / 视觉判读） |
| `Snapshot` | 看屏幕可访问性树（窗口 / 控件结构，文本形式） |
| `OCR` | 对图像做 OCR 取字（也可走 `/api/ocr`） |
| `DisplayInventory` | 显示器信息（分辨率、缩放） |
| `Process` | 进程列表 |
| `Click` / `Move` / `Type` / `Key` | 基于可访问性树的点击 / 移动 / 输入 / 按键 |

### 5.2 /api/ocr — 截屏取词（离线、免安装、不限流）

```bash
curl -s -X POST http://127.0.0.1:19387/api/ocr \
  -H "X-Orb-Token: <令牌>" -H "Content-Type: application/json" \
  -d '{"lang":"zh-Hans-CN"}'
```

不传 `dataUrl` 时自动截全屏再 OCR；也可传 `{"dataUrl":"data:image/png;base64,..."}` 直接识别某张图。
返回 `{ok:true, text:"…", lines:[…]}`（`lines` 含坐标，供高亮用）。

### 5.3 /api/vlm — 视觉闭环（截图 → 视觉模型 → 判读）

把截图 + 对话消息发给一个 OpenAI 兼容的视觉模型，拿回模型判读结果。这是 v1.4.5「视觉轨道」的桥接入口：
模型自己决定下一步点哪里，再把坐标交回 `server=orb` 去点。

```bash
curl -s -X POST http://127.0.0.1:19387/api/vlm \
  -H "X-Orb-Token: <令牌>" -H "Content-Type: application/json" \
  -d '{
    "baseUrl": "https://your-vlm-endpoint/v1",
    "apiKey": "<视觉模型Key>",
    "model": "your-vision-model",
    "messages": [{"role":"user","content":[
      {"type":"text","text":"截图上「确定」按钮的坐标是多少？只回坐标。"},
      {"type":"image_url","image_url":{"url":"<截图dataUrl或URL>"}}
    ]}],
    "maxTokens": 1024
  }'
```

- 密钥只在本进程内存过一遍，不落盘、不写日志；**不要把 apiKey 写进回复或日志**；
- `/api/vlm/models` 可列出该端点可用模型名，方便用户选对视觉模型；
- 视觉轨道坐标用**千分比（0–1000）**而不是像素，避免高分辨率下数错位置。

### 5.4 /api/translate — 划词翻译

```bash
curl -s -X POST http://127.0.0.1:19387/api/translate \
  -H "X-Orb-Token: <令牌>" -H "Content-Type: application/json" \
  -d '{"text":"要翻译的文字"}'
```

## 六、后台轨道（server = workbuddy + /api/dispatch）

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `workbuddy_execute` | `task`（必填）, `model?` | 一次性执行，返回回答正文 |
| `persona_bundle` | 人格台词批量生成（面板内部用） | 生成五人格台词包 |
| `cli_model_register` | 无 | 把自定义接口注册进 CLI 模型清单 |

适合读代码库、写长文档、跑批处理这类"动脑的活"。它**不占用用户桌面**，
但执行期间用户看不到过程——所以只用于用户明确同意后台处理的任务。

`model` 为空时用 CLI 默认模型；该工具复用用户本机 CodeBuddy CLI 的登录态，不需要额外 API Key。

**长任务进度（v1.4.5 推荐用 SSE）**：先 `POST /api/dispatch` 拿到 `jobId`，再
`GET /api/job/<jobId>/stream`（SSE）实时接收 partial/final，空闲时一次请求都不发；
也可 `GET /api/job/<jobId>` 轮询兜底。详见 `references/api.md`。

## 七、语音识别与实时字幕（/api/asr + /api/rt）

- `GET /api/asr` 读状态；首次使用先 `POST /api/asr/prepare`（幂等，拉起安装脚本）与
  `POST /api/asr/model` 追加模型，进度可轮询 `GET /api/asr/prepare-progress`；
- `POST /api/rt` 开关实时字幕 / 实时转写；`GET /api/rt` 读状态。
- 这些能力依赖本机模型，未安装时引导用户先走 prepare，不要反复报错重试。

## 八、工作流录制与回放（/api/wf）

把一段操作录成可重放的「工具调用序列」，下次一键回放：

```bash
# 开始录制（期间每次 /api/call 都会被记录）
curl -s -X POST http://127.0.0.1:19387/api/wf -H "X-Orb-Token: <令牌>" \
  -H "Content-Type: application/json" -d '{"action":"rec-start","name":"晨会打卡"}'
# …执行一连串操作…
curl -s -X POST http://127.0.0.1:19387/api/wf -H "X-Orb-Token: <令牌>" \
  -H "Content-Type: application/json" -d '{"action":"rec-stop"}'
# 回放
curl -s -X POST http://127.0.0.1:19387/api/wf -H "X-Orb-Token: <令牌>" \
  -H "Content-Type: application/json" -d '{"action":"play","name":"晨会打卡"}'
```

`rec-start` 时只读工具（Snapshot / Screenshot）默认也录，可用 `skipRead` 跳过。

## 九、统一调用范式

所有工具调用都走同一个端点：

```bash
curl -s -X POST http://127.0.0.1:19387/api/call \
  -H "X-Orb-Token: <令牌>" \
  -H "Content-Type: application/json" \
  -d '{"server":"orb","tool":"move_to","args":{"x":960,"y":540}}'
```

返回 `{"ok":true,"result":…}` 或 `{"ok":false,"error":"…"}`。
**`ok:false` 时把 error 原文告诉用户**，不要自己编原因。

PowerShell 下的等价写法（注意引号转义）：

```powershell
$tok = (Get-Content "$env:APPDATA\ORB 控制台\.bridge.json" -Raw | ConvertFrom-Json).token
Invoke-RestMethod -Uri "http://127.0.0.1:19387/api/call" -Method Post `
  -Headers @{ "X-Orb-Token" = $tok } `
  -ContentType "application/json" `
  -Body '{"server":"orb","tool":"cursor_position","args":{}}'
```

## 十、作业规范

1. **先观察再动手**。用 `cursor_position` 或 `windows|Snapshot` / `Screenshot` 确认起点；
   要点击陌生界面前，先问用户"我要点的是屏幕中下方那个蓝色按钮吗"，或让用户先把目标窗口放到前台。
2. **一次只做一步**。不要把"打开软件 → 点菜单 → 填三个框 → 点确定"合成一次长链，
   每步之间把结果告诉用户，让他能中断。
3. **坐标要保守**。`args.x/y` 超出屏幕范围会被钳制；拿不准时先问用户或让他给出大致位置。
4. **不可逆操作必须人工确认**。删除、支付、发送、覆盖保存这类动作，
   先明确告诉用户将要发生什么，得到肯定答复后再执行（危险操作也会进 `/api/confirm` 待确认列表，
   **AI 不得代替用户点允许**）。
5. **不要静默连续操作**。超过 5 步的流程，主动询问用户"继续吗"。

## 十一、急停（任何轨道都适用）

```bash
curl -s "http://127.0.0.1:19387/api/stop?action=stop" -H "X-Orb-Token: <令牌>"
```

- `action=stop` 中断所有正在执行的前台动作；
- `action=resume` 恢复；不带参数返回当前状态。

**用户说出"停""停下""别动我的电脑"时，立刻打这个接口**，不要先问、不要先解释。

## 十二、红线（违反任何一条都立即停止）

- 只连接 `127.0.0.1:19387`，**不得**把该地址改成局域网 IP 或公网地址；
- 令牌不得出现在回复正文、日志、截图或任何外发内容里；
- 不得把 `.bridge.json` 的内容整体回显给用户；
- 不得在用户没有明确要求的情况下启动后台 Agent 执行长任务；
- 不得利用本技能读取与当前任务无关的文件或窗口内容；
- `/api/vlm` 的 `apiKey` 不得写进回复正文或日志；
- 用户随时可以说"停"——那是最高优先级指令。

## 十三、v1.4.5 新能力对照（每条更新都有落点）

| v1.4.5 更新 | 经桥接可驱动？ | 怎么用 / 在哪配 |
| --- | --- | --- |
| 视觉轨道：截图 → 视觉模型 → 动作闭环 | ✅ 可驱动 | `server=windows` 截图 + `/api/vlm` 判读 + `server=orb` 点击（坐标用千分比） |
| 截屏取词 / OCR | ✅ 可驱动 | `/api/ocr`（离线）或 `windows|OCR` |
| 划词翻译 | ✅ 可驱动 | `/api/translate` |
| 后台 SSE 推送替代轮询 | ✅ 可驱动 | `/api/events`（全局状态）、`/api/job/:id/stream`（单任务片段）；空闲不发请求 |
| 首字延迟 TTFT | ✅ 可观察 | 状态行显示；审计面板顶部给近 30 次 p50/p95（面板侧展示） |
| 实时语音识别 / 字幕 | ✅ 可驱动 | `/api/asr`（prepare/model）+ `/api/rt` |
| 工作流录制回放 | ✅ 可驱动 | `/api/wf`（rec-start / rec-stop / play / save） |
| 语音拆成两条并行音源（离线包 + 生成播报） | ⚙️ 面板配置 | 设置 › 个性 › 语音：两个独立开关；也可填「AI 在线语音合成」端点（地址/Key/模型/音色/语气） |
| 长期记忆自瘦身 | ⚙️ 面板配置 | 设置 › 存储 › 记忆管理：注入开关、自动提炼、项目锚定、手动添加、压缩键 |
| 区域录屏（全屏/左右半屏/上下半屏/中间/自定义框选） | ⚙️ 面板配置 | 设置 › 截屏与录屏 › 录制区域；比例存相对主屏比例，换屏/换缩放仍准确 |
| 录屏/截屏时隐藏控制台 | ⚙️ 面板配置 | 设置 › 截屏与录屏 › 顶部开关 |
| 摄像头小框（以录制区域为坐标系） | ⚙️ 面板配置 | 设置 › 截屏与录屏 › 摄像头小框 |

⚙️ = 该能力在 ORB 控制台**面板/设置**里配置（落 `orb-state.json`），**不经桥接 HTTP 接口暴露**，
所以本技能通过「引导用户在面板设置」来覆盖，而不是用 curl 直接驱动。

## 十四、输出要求

- 每完成一步，用一句话汇报："已把鼠标移到 (960, 540) 并点击了左键"；
- 失败时给出 `error` 原文 + 一句可行的下一步；
- 任务结束时明确说"已完成 / 未完成及原因"，不要含糊；
- 全程使用中文（除非用户用其它语言提问）。

## 十五、备注

- 端点与参数的权威说明见 `references/api.md`；
- ORB 控制台本身是 MIT 开源项目，本技能只做调用，不含其代码；
- 适配 ORB 控制台 v1.4.5 及以上（视觉闭环、截屏取词、实时语音识别、工作流录制回放、SSE 推送）；
  桥接服务（127.0.0.1:19387）协议自 v1.2 起稳定，本技能同样兼容。
- 若用户问"这是什么"，一句话回答：一个让 AI 真正动手操作电脑的桌面工具，带急停和权限分级。
