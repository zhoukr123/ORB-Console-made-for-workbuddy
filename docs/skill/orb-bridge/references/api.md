# ORB 桥接服务 · 端点速查（v1.4.5）

> 权威来源：`orb/bridge.mjs`（ORB 控制台仓库）。本文件是给 AI 看的速查表，
> 行为以源码为准。所有地址均为 `http://127.0.0.1:19387`。
> 除 `/api/health`、`/api/wb-callback` 外，所有接口都要求请求头 `X-Orb-Token: <token>`。
> 令牌在 `%APPDATA%\ORB 控制台\.bridge.json` 的 `token` 字段，进程启动时随机生成；
> 令牌不进仓库、不随包分发、不写日志。

## 鉴权

- 除 `/api/health` 外，所有接口都要求请求头 `X-Orb-Token: <token>`；
- SSE（`/api/events`、`/api/job/:id/stream`）用 EventSource 不能带自定义头，改走 `?token=<token>` 查询参数；
- 令牌不进仓库、不随包分发、不写日志。

## 统一调用入口

所有"工具"都通过这一个端点调用：

```
POST /api/call
{ "server": "orb"|"windows"|"workbuddy"|<mcp名>, "tool": "<工具名>", "args": {...}, "timeoutMs"? }
→ { "ok": true, "result": … } | { "ok": false, "error": "…" }
```

- `server=orb`：原生输入（7 个鼠标原语，见下）
- `server=windows`：随包 windows-mcp（截屏/看屏/取词/控件枚举，工具以 `/api/tools` 实时清单为准）
- `server=workbuddy`：本机后台 Agent（CodeBuddy CLI）
- 其它 key：注册到 bridge 的任意 MCP server

先 `GET /api/tools?server=<key>` 拿实时工具清单（以它为准，不要假设）。

## 端点总表

| 方法与路径 | 用途 | 鉴权 |
| --- | --- | --- |
| `GET /api/health` | 存活探测（免令牌） | 公开 |
| `GET /api/status` | 三条通道 + CLI 检测状态 | 令牌 |
| `GET /api/events` | **SSE** 全局状态推送（v1.4.5 新增，取代轮询） | 令牌/`?token=` |
| `GET /api/job/:id` | 单任务状态（轮询兜底） | 令牌 |
| `GET /api/job/:id/stream` | **SSE** 单任务 partial/final 实时推送（v1.4.5 新增） | 令牌/`?token=` |
| `GET /api/tools?server=<key>` | 工具清单 | 令牌 |
| `POST /api/call` | 调用工具（统一入口） | 令牌 |
| `POST /api/dispatch` | 派发后台任务，返回 `jobId`（配合 SSE 拿进度） | 令牌 |
| `GET /api/stop` / `POST /api/stop` | 急停 / 恢复 / 查询（`?action=stop\|resume`） | 令牌 |
| `GET /api/confirm` / `POST /api/confirm` | 危险操作确认列表 / 允许拒绝 | 令牌 |
| `GET /api/live` / `GET /api/audit` | 当前执行进度 / 审计记录 | 令牌 |
| `POST /api/agent-done` | 视觉/后台任务回执（内部） | 令牌 |
| `POST /api/wf` | 工作流录制/回放（`rec-start`/`rec-stop`/`play`/`save`） | 令牌 |
| `POST /api/triggers` | 触发器管理 | 令牌 |
| `GET /api/hook` | 钩子状态 | 令牌 |
| `GET /api/repair` | 自修复 | 令牌 |
| `GET /api/danger` / `POST /api/danger` | 危险工具清单读/写 | 令牌 |
| `GET /api/whitelist` / `POST /api/whitelist` | 白名单读/写 | 令牌 |
| `POST /api/vlm` | 视觉模型调用（截图→视觉→判读闭环） | 令牌 |
| `POST /api/vlm/models` | 列出视觉模型端点可用模型 | 令牌 |
| `POST /api/ocr` | 截屏取词（离线 OCR，`{dataUrl?}` 可选） | 令牌 |
| `POST /api/translate` | 划词翻译 | 令牌 |
| `GET /api/asr` / `POST /api/asr` | 语音识别状态 / 开关 | 令牌 |
| `POST /api/asr/prepare` | 拉起安装脚本（幂等） | 令牌 |
| `GET /api/asr/prepare-progress` | 安装进度轮询 | 令牌 |
| `POST /api/asr/model` | 追加识别模型 | 令牌 |
| `GET /api/rt` / `POST /api/rt` | 实时字幕/转写 状态 / 开关 | 令牌 |
| `GET /api/wb-cli` / `?refresh=1` | CodeBuddy CLI 检测（缓存 30s） | 令牌 |
| `GET /api/wb-models` / `?refresh=1` | 后台可选模型清单（实时解析 CLI） | 令牌 |
| `GET /api/credits` | 已认领的后台会话计数 | 令牌 |
| `GET /api/wb-daemon` / `POST /api/wb-daemon` | 热启动常驻 daemon 状态 / 开关 | 令牌 |
| `POST /api/shutdown` | 关闭桥接服务 | 令牌 |
| `POST /api/wb-callback` | 后台 daemon 结果回调（免令牌） | 公开 |

## 原生输入轨道（server = `orb`）

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

## 后台轨道（server = `workbuddy`）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `workbuddy_execute` | `task`（必填）, `model?` | 一次性执行，返回回答正文 |
| `persona_bundle` | 人格台词批量生成（面板内部用） | 生成五人格台词包 |
| `cli_model_register` | 无 | 把自定义接口注册进 CLI 模型清单 |

`model` 为空时用 CLI 默认模型。该工具复用用户本机 CodeBuddy CLI 的登录态，不需要额外 API Key。
长任务建议 `POST /api/dispatch` 拿 `jobId`，再用 `GET /api/job/<jobId>/stream`（SSE）收进度。

## 视觉与观察轨道（server = `windows` + /api/vlm + /api/ocr）

- `windows` 服务工具以 `GET /api/tools?server=windows` 实时清单为准，常用：`Screenshot`、`Snapshot`、
  `OCR`、`DisplayInventory`、`Process`、`Click`、`Move`、`Type`、`Key`。
- `POST /api/ocr`：`{"lang":"zh-Hans-CN","dataUrl"?}` → 截图(或指定图)离线 OCR，返回 `{ok,text,lines[]}`。
- `POST /api/vlm`：把截图 + `messages` 发给 OpenAI 兼容视觉模型；`baseUrl`/`apiKey`/`model` 必填，
  `maxTokens` 默认 1024；密钥只在本进程内存过一遍，不落盘不写日志。
- `POST /api/translate`：`{"text":"…"}` 划词翻译。

## 语音识别 / 实时字幕（/api/asr、/api/rt）

- 首次使用先 `POST /api/asr/prepare`（幂等安装），必要时 `POST /api/asr/model` 追加模型，
  进度轮询 `GET /api/asr/prepare-progress`；
- `POST /api/rt` 开关实时字幕/转写，`GET /api/rt` 读状态；
- 依赖本机模型，未安装时引导用户先 prepare，不要反复报错重试。

## 工作流录制回放（/api/wf）

```
POST /api/wf  {"action":"rec-start","name":"<名>","skipRead"?}   # 开始录制
POST /api/wf  {"action":"rec-stop"}                              # 停止
POST /api/wf  {"action":"play","name":"<名>"}                    # 回放
POST /api/wf  {"action":"save", ...}                            # 落盘（原子写）
```

录制期间每次 `/api/call` 都会被记录；只读工具（Snapshot/Screenshot）默认也录，可用 `skipRead` 跳过。

## 错误处理约定

- `/api/call` 永远返回 HTTP 200，用 `ok` 字段判断成败；
- `ok:false` 时 `error` 是给人看的原文，直接转述，不要改写；
- 连接失败（`ECONNREFUSED` / 超时）= ORB 未运行，按 SKILL.md 第二节引导用户启动，不要重试超过一次；
- SSE 出错时面板/调用方自动退回 2s 轮询（`/api/job/:id`），零退化。

## 危险操作确认

删除、支付、发送、覆盖保存等操作会进入 `/api/confirm` 的 `pending` 列表，
需要用户在 ORB 面板上点"允许"。**AI 不得代替用户点允许**，
只能等待或告知用户"需要在悬浮球面板上确认这次操作"。
