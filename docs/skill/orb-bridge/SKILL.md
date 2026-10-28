---
name: orb-bridge
display_name: ORB Desktop Control
display_name_zh: ORB 桌面操作助手
display_name_en: ORB Desktop Control
name_en: ORB Desktop Control
description: 让 AI 真的操作你的 Windows 电脑。当用户要求"帮我点一下 / 打开某个软件 / 在桌面找文件 / 做重复的鼠标操作 / 把任务派给后台 Agent 跑"，且本机装有 ORB 控制台时使用本技能：通过本机桥接服务（127.0.0.1:19387）执行点击、输入、拖动、滚动，或把重活交给后台 Agent 一次性执行并回收结果。
description_zh: 让 AI 真的操作你的 Windows 电脑。当用户要求"帮我点一下 / 打开某个软件 / 在桌面找文件 / 做重复的鼠标操作 / 把任务派给后台 Agent 跑"，且本机装有 ORB 控制台时使用本技能：通过本机桥接服务（127.0.0.1:19387）执行点击、输入、拖动、滚动，或把重活交给后台 Agent 一次性执行并回收结果。
description_en: "Let the AI actually operate the user's Windows PC. Use it when the user asks to click something, open an app, find a file on the desktop, perform repetitive mouse actions, or hand a task to a background Agent, and ORB Console is installed locally. It drives the local bridge service (127.0.0.1:19387) to click, type, drag and scroll, or offload heavy work to a background Agent and collect the result."
version: 1.3.0
category: 效率工具
---

# ORB 桥接技能

本技能把本机运行的 **ORB 控制台**（github.com/zhoukr123/ORB-Console-made-for-workbuddy）的桥接服务
暴露给你，使你真的能操作用户的 Windows 桌面，而不是只能给出建议。

## 一、什么时候用

满足**任意一条**就启用本技能：

- 用户说"帮我点 / 帮我打开 / 帮我拖 / 帮我滚动 / 帮我填这个表单"
- 用户说"桌面/文件管理器里做某个重复操作"
- 用户说"这个事情很麻烦，让 Agent 在后台跑完告诉我结果"
- 用户提到"ORB""悬浮球""桌面 AI 员工"

**不满足以下条件时不要启用**：请求只是查资料、写代码、分析文档、生成内容 —— 这些你自己就能做，
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

桥接服务的每个 `/api/*` 接口都要求 `X-Orb-Token` 头（`/api/health` 除外）。
令牌在用户数据目录的 `.bridge.json` 里：

```
%APPDATA%\ORB 控制台\.bridge.json
```

用文件读取工具读这个文件，取 `token` 字段。规则：

- **只在本次任务期间持有**，任务结束即丢弃，不要写进任何文件、日志或回复正文；
- 读不到文件时不要猜测、不要复用旧值，直接按"ORB 未就绪"处理。

## 三、可用能力

### 3.1 原生轨道（server = orb）

7 个鼠标/窗口原语，坐标是**屏幕像素**（左上角为原点）：

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

### 3.2 后台轨道（server = workbuddy）

| 工具 | 参数 | 用途 |
| --- | --- | --- |
| `workbuddy_execute` | `task`, `model?` | 把 `task` 交给本机 Agent 一次性执行，返回回答正文 |

适合读代码库、写长文档、跑批处理这类"动脑的活"。它**不占用用户桌面**，
但执行期间用户看不到过程 —— 所以只用于用户明确同意后台处理的任务。

### 3.3 急停（任何轨道都适用）

```bash
curl -s "http://127.0.0.1:19387/api/stop?action=stop" -H "X-Orb-Token: <令牌>"
```

- `action=stop` 中断所有正在执行的前台动作；
- `action=resume` 恢复；不带参数返回当前状态。

**用户说出"停""停下""别动我的电脑"时，立刻打这个接口**，不要先问、不要先解释。

## 四、调用范式

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

## 五、操作桌面的作业规范

1. **先观察再动手**。用 `cursor_position` 确认起点；要点击陌生界面前，先问用户
   "我要点的是屏幕中下方那个蓝色按钮吗"，或让用户先手动把目标窗口放到前台。
2. **一次只做一步**。不要把"打开软件 → 点菜单 → 填三个框 → 点确定"合成一次长链，
   每步之间把结果告诉用户，让他能中断。
3. **坐标要保守**。`args.x/y` 超出屏幕范围会被钳制；拿不准时先问用户或让他给出大致位置。
4. **不可逆操作必须人工确认**。删除、支付、发送、覆盖保存这类动作，
   先明确告诉用户将要发生什么，得到肯定答复后再执行。
5. **不要静默连续操作**。超过 5 步的流程，主动询问用户"继续吗"。

## 六、红线（违反任何一条都立即停止）

- 只连接 `127.0.0.1:19387`，**不得**把该地址改成局域网 IP 或公网地址；
- 令牌不得出现在回复正文、日志、截图或任何外发内容里；
- 不得把 `.bridge.json` 的内容整体回显给用户；
- 不得在用户没有明确要求的情况下启动后台 Agent 执行长任务；
- 不得利用本技能读取与当前任务无关的文件或窗口内容；
- 用户随时可以说"停" —— 那是最高优先级指令。

## 七、输出要求

- 每完成一步，用一句话汇报："已把鼠标移到 (960, 540) 并点击了左键"；
- 失败时给出 `error` 原文 + 一句可行的下一步；
- 任务结束时明确说"已完成 / 未完成及原因"，不要含糊；
- 全程使用中文（除非用户用其它语言提问）。

## 八、备注

- 端点与参数的权威说明见 `references/api.md`；
- ORB 控制台本身是 MIT 开源项目，本技能只做调用，不含其代码；
- 适配 ORB 控制台 v1.3.0 及以上（原生 MP4 录屏、加号附件、重做后的截屏）；桥接服务（127.0.0.1:19387）协议自 v1.2 起稳定，本技能同样兼容。
- 若用户问"这是什么"，一句话回答：一个让 AI 真正动手操作电脑的桌面工具，带急停和权限分级。
