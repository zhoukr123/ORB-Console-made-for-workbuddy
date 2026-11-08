# 目录索引（SRC-INDEX）

这个根目录**既是代码目录，也是开发态的数据目录** —— `orb/bridge.mjs` 里
`DATA_DIR = process.env.ORB_DATA_DIR || path.join(HERE, "..")`，`HERE` 是 `orb/`，
所以 `HERE/..` 就是本目录。包装态下 `DATA_DIR` 是 `%APPDATA%\ORB`，源码目录不会长数据。

结果就是：源码、运行时状态、用户数据全挤在同一层，新人第一眼会以为"很乱"。
其实只分三类，按下面这张表看就清楚了。

> ⚠️ **下表里标「运行时」的目录一个都不能移动、改名、清理。**
> 它们在代码里是硬编码路径，引用次数见"引用"列；动一下就是"昨天 `.bridge.json` 那次事故"的翻版
> —— 面板看着正常，实际在读写另一个空目录。

---

## 一、源码（可以改，别乱挪）

| 路径 | 是什么 | 说明 |
|---|---|---|
| `orb/` | 桥与全部后端逻辑（ESM） | 入口 `bridge.mjs`；`orb/desktop/` 是面板（Electron 渲染层）；`orb/test/` 单测；`orb/tools/` 验收脚本；`orb/docs/` 自动生成的注册表 |
| `orb/desktop/` | 面板：`panel.html` + `panel.css` + 分块 JS | `panel.html` 仍是单文件大头（含内联主脚本），新功能一律写到同目录的独立 JS，不再往里堆 |
| `orb/test/` | 单测（`*.test.mjs`） | 纯函数优先；碰桌面的逻辑抽成模块后用 mock 覆盖 |
| `orb/tools/` | 验收脚本 | 一键全套：`node orb/tools/verify-all.mjs` |
| `docs/` | 对外文档 | 其中 `registry.md` / `capabilities.md` **由脚本生成**，手改会测挂 |
| `docs/_probes/` | 一次性探针与验证脚本（88 个，2026-11-08 按领域分成 10 类） | 不在构建、不在测试、不在打包清单里；`README.md` 有分类说明。<br>`panel/` 下三件套与 `storage/_orb_audit.cjs` 仍被 `AGENTS.md` 的验证流程点名 |
| `dist/`、`dist-electron/` | 打包产物 | 只在 `npm run build` 后出现，可随时重生成 |
| `asr/`、`tts/` | 语音子进程与模型相关 | `asr/` 被代码引用 52 处，按运行时看待 |

## 二、运行时数据（**不可移动**）

| 目录 / 文件 | 谁在写 | 引用 | 说明 |
|---|---|---|---|
| `workflows/` | 桥 | 5 | 自动化配方（一条一个 json）。删了等于删用户资产 |
| `workflows-trash/` | 桥 | 2 | 配方回收站，撤销删除靠它 |
| `audit/` | 桥 | 28 | 审计流水，`audit_mem` 的内存快照落盘在这里 |
| `trail/` | 桥 | 4 | 工单轨迹（`/api/tickets/:id/trail` 的唯一来源） |
| `artifacts/` | 桥 | 57 | 产物登记表（实际文件在 `ORB存储/`，这里只登记） |
| `cache/` | 桥 | 115 | 各类缓存与中间态。**看着像垃圾，删了会让下次运行全部退化成冷启动** |
| `history/` | 桥 | 9 | 运行历史快照 |
| `recordings/` | 桥 | 39 | 录制原始数据（注意：与 `ORB存储/recordings/` 不是一回事） |
| `vidx/` | 桥 | 31 | 看视频的索引 |
| `screenshots/` | 桥 | 20 | 截屏中间产物 |
| `gov-channel/` | 桥 | 1 | 治理通道落盘 |
| `governance/` | 桥 | 19 | 治理账本 |
| `wf-checkpoints/` | 桥（2026-11-08 新增） | — | 断点续跑记录。一个配方一个 json，跑成功即作废 |
| `api-channel.json` | 桥 | 2 | 前台通道配置 |
| `approvals.json` | 桥 | 4 | 待批清单 |
| `tickets.json` | 桥 | 4 | 工单账本 |
| `outbox.json` | 桥 | 1 | 发件箱 |
| `cost-ledger.json` | 桥 | 2 | 成本账本 |
| `bridge.conf` | 桥 / 启动脚本 | 12 | 端口、token 等运行配置 |
| `.children-<端口>.json` | 桥 | 3 | 子进程登记（按端口分文件，只写自己那个端口） |

## 三、用户可见的存储根（`ORB存储/`）

| 路径 | 说明 |
|---|---|
| `ORB存储/recordings/` | 录屏成品 |
| `ORB存储/screenshots/` | 截屏成品 |
| `ORB存储/vidx/` | 看视频成品 |
| `ORB存储/exports/` | 导出 |
| `ORB存储/logs/<日期>/` | ORB 运行日志，按天分层 |
| `ORB存储/governance/`、`history/`、`misc/` | 治理 / 历史 / 杂项 |
| `ORB存储/archive/<日期>/` | **归档**。搬进来的东西还在这儿，只是不在根目录碍眼 |

约定：存储根下只允许上表这些目录，**不允许出现根级 `<YYYY-MM-DD>` 日期目录**
（历史包袱：曾经有过，按天堆了一层，后来统一收到 `archive/<日期>/` 下）。

## 四、根级散落文件

| 文件 | 归属 |
|---|---|
| `启动 ORB 控制台.cmd`、`启动 ORB 控制台（录制模式）.cmd`、`启动 实时字幕.cmd`、`启动 语音识别服务.cmd`、`生成字幕.cmd`、`修复前台通道.cmd`、`卸载 ORB 控制台.cmd` | 给用户双击的入口。中文名是**刻意的** —— 用户不会去命令行敲命令 |
| `codebuddy-login.cmd`、`fix-desktop-icon.cmd/.ps1` | 一次性修复脚本，留着备查 |
| `*.json`（见第二节） | 运行时状态，不是配置样例 |
| `*.md`（README / ROADMAP / SECURITY / AGENTS / 使用说明 / 迁移说明 …） | 文档，可读可改 |

## 五、新增文件该放哪

| 你要加的东西 | 放这里 |
|---|---|
| 一个新的纯逻辑模块 | `orb/<模块名>.mjs`，同时**登记进 `orb/pack.cjs`**（打包闭包会查） |
| 模块单测 | `orb/test/<模块名>.test.mjs` |
| 面板新功能 | `orb/desktop/` 下新建 JS/CSS，用 `panel.html` 挂一行 `<script>`；不要再写进内联主脚本 |
| 一次性脚本 / 验收脚本 | `orb/tools/` |
| 文档 | `docs/`（若要生成，写生成脚本，别手写） |
| 运行时产物 | `ORB存储/<kind>/<日期>/`，不要落在根目录 |

## 六、已知的乱，以及为什么不强行整理

- `cache/`、`screenshots/`、`recordings/` 在根目录和各有一个同名目录跟 `ORB存储/` 重名。
  这是**历史分层**：根目录下这几个是"中间态"，`ORB存储/` 下的是"成品"。
  合并会连带动 100+ 处路径引用，收益只是"看起来整齐"，不值。
- 根目录有 20+ 个中文 `.cmd`。它们不优雅，但那是用户唯一的入口，不能收进子目录。

---

最后更新：2026-11-08（把 `_parse_work/` 与 9 个陈旧 `.children-*.json` 移入
`ORB存储/archive/2026-11-08/散落文件归位/`；两者都确认代码里 0 引用）。
