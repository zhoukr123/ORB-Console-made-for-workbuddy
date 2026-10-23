# ORB 桥接服务 · 端点速查

> 权威来源：`orb/bridge.mjs`（ORB 控制台仓库）。本文件是给 AI 看的速查表，
> 行为以源码为准。所有地址均为 `http://127.0.0.1:19387`。

## 鉴权

- 除 `/api/health` 外，所有接口都要求请求头 `X-Orb-Token: <token>`；
- 令牌在 `%APPDATA%\ORB 控制台\.bridge.json` 的 `token` 字段，进程启动时随机生成；
- 令牌不进仓库、不随包分发、不写日志。

## 端点

| 方法与路径 | 用途 | 请求 | 响应 |
| --- | --- | --- | --- |
| `GET /api/health` | 存活探测（免鉴权） | — | `{"ok":true,…}` |
| `GET /api/status` | 三条通道 + CLI 检测状态 | — | `{windows:{ok,tools},orb:{ok,tools},workbuddy:{ok,tools,cli:{found,auth,hint}}}` |
| `GET /api/tools?server=<key>` | 工具清单 | `key`：`orb` / `workbuddy` / MCP server 名 | `{"tools":[{"name":"…","description":""}]}` |
| `POST /api/call` | 调用工具 | `{server, tool, args, timeoutMs?}` | `{"ok":true,"result":…}` / `{"ok":false,"error":"…"}` |
| `GET\|POST /api/stop` | 急停 / 恢复 / 查询 | `?action=stop\|resume`（缺省为查询） | `{"ok":true,"stop":{"on":bool,"at":ts,"reason":"…"}}` |
| `GET /api/confirm` | 待确认的危险操作列表 | — | `{ok, pending, dangerous, whitelist, dangerRules}` |
| `POST /api/confirm` | 允许 / 拒绝某次确认 | `{id, allow, reason?, remember?}` | `{"ok":bool}` |
| `GET /api/live` | 当前执行进度（轮询） | — | 进度快照 |
| `POST /api/wf` | 工作流录制 / 回放 | `{action:"rec-start"\|"rec-stop"\|"play", name?, steps?}` | 视 action 而定 |
| `GET /api/credits` | 已认领的后台会话计数 | — | — |

## 原生轨道工具（server = `orb`）

参数均为 JSON 对象；坐标为屏幕像素（左上原点），越界会被钳制。

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `move_to` | `x`, `y` | 移动鼠标 |
| `mouse_press` | `x`, `y`, `button?` | 按下，`button` 默认 `left` |
| `mouse_release` | `button?` | 松开 |
| `long_press` | `x`, `y`, `durationMs?`, `button?` | 长按，`durationMs` 1–60000，默认 800 |
| `drag` | `x`, `y`, `x2`, `y2`, `durationMs?`, `button?` | 拖动，`durationMs` 0–20000，默认 400 |
| `scroll_at` | `x`, `y`, `direction?`, `clicks?` | `direction` 默认 `down`，`clicks` 1–100 默认 3 |
| `cursor_position` | — | 返回当前坐标 |

## 后台轨道工具（server = `workbuddy`）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `workbuddy_execute` | `task`（必填）, `model?` | 一次性执行，返回回答正文 |

`model` 为空时用 CLI 默认模型。该工具复用用户本机 CodeBuddy CLI 的登录态，
不需要额外 API Key。

## 错误处理约定

- `/api/call` 永远返回 HTTP 200，用 `ok` 字段判断成败；
- `ok:false` 时 `error` 是给人看的原文，直接转述，不要改写；
- 连接失败（`ECONNREFUSED` / 超时）= ORB 未运行，按 SKILL.md 第二节引导用户启动，不要重试超过一次。

## 危险操作确认

删除、支付、发送、覆盖保存等操作会进入 `/api/confirm` 的 `pending` 列表，
需要用户在 ORB 面板上点"允许"。**AI 不得代替用户点允许**，
只能等待或告知用户"需要在悬浮球面板上确认这次操作"。
