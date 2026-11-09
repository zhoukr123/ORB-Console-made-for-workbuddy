# v1.5.0 优化批次交付概览（续）

> 本会话在「重新上传 v1.5.0 → 按方案优化 → 补全插件生态」的基础上继续推进。
> 源码改动已全部提交（本地 `main`，尚未 `git push`——见末尾网络阻塞说明）。

## 已交付

### #32 桥依赖改为「生产依赖闭包」复制（pack.cjs）
- **做法**：不再整目录 `cpr(orb/node_modules)`，而是从运行时入口（bridge.mjs + 桌面 CJS 实现 + package.json 运行/可选依赖）出发，按 Node 解析规则递归收集**真正被 import/require 的包**，只拷这些；并加了「闭包审计」兜底（扫描发布包内所有本地 JS 的裸导入，缺失的自动补拷，绝不静默丢依赖）。
- **效果**：`orb/node_modules` 521 MB → 发布包内 **69 MB**；单文件便携版 **223 MB → 218.6 MB**。
- **验证**：构建产物审计确认 `@modelcontextprotocol/sdk / pngjs / @huggingface/transformers` 在包内且可加载；`puppeteer-core`（仅测试工具用）与 `onnxruntime-*`（零引用死重）已排除；CLIP 视觉档在缺 onnxruntime 时优雅降级到 C0（不崩）。

### #33 扩展新鲜度桥侧比对（S3）
- **痛点**：浏览器仍跑旧扩展脚本时，修好的行为会「看起来又回来了」，且没有任何提示。
- **做法**：扩展 `provider_hello` 上报 `build` 构建戳；桥从**随包** `background.js` 读取 `BUILD` 作为期望值（单源、无两处漂移），传给 `browserProvider`；provider 比对上报值与期望值，暴露 `buildStale` 到 `stats()/config()`，经 `/api/browser/status` 下发；面板在「扩展版本过期」时提示到扩展页「重新加载」。
- **验证**：单测覆盖三种情形——build 匹配（不告警）、build 旧（告警）、老扩展不带 build（不误报）；桥侧 `BUILD` 正则抽取在真实 `background.js` 上验证通过。

### #34 插件生态（调研 + 验证）
- **调研结论**：逐项检查 `pluginHost / pluginEcosystem / pluginMarket / pluginPack / pluginArtifactGate / 面板插件页`，**未发现功能缺口**。
- 已具备：内置插件 + 外部注册 + 验收闸门（`api_call_register` 硬红线 / `restart-required`）；市场扫描（实测本机 `~/.workbuddy/plugins` 下 **647 个真实插件**可发现）；清单/包/市场三种安装路径 + dry-run + 台账持久化；面板「插件」页完整可触达（已装/市场分页、搜索、导入、卸载）；桥侧 14 个 `plugin.*` 操作全部注册；内置插件 `qr-encode / regex-pipeline` 实测可运行。
- 因无新增缺口，**未做多余改动**，仅做端到端验证。

### #35 S4 脱离视觉循环 + V-13 降级阈值
- **方案原文**：五项指标与降级阈值写进 `anchorResolver`/`refBinding`；`STALE_REF`/`AMBIGUOUS_TARGET` 落成正式错误状态；**明确不接回 `runVision()`**；Electron 自身界面走降级且不进视觉循环（验收 #4）。
- **新增纯模块**：`v13Metrics.mjs`（五项指标 + 阈值 + 「应用/版本/控件类型—a11y 覆盖—自动/人工—失败模式」记录表，缺样本不补零）；`v13LoopGuard.mjs`（降级纪律裁决 + 视觉循环预算 + 自属窗口识别）。
- **接线**：`anchorResolver.mjs` 注入 `degradation`/`onLoopExit`，降级时**跳过视觉档 ③**并给 `element` 挂 `degradation` 标记；`bridge.mjs` 的 `runNode` 读到该标记就走 window/absolute 兜底、`takeover` 分支被封死（降级绝不触发智能接管）；`takeover` 加独立视觉循环预算刹车（超限脱离 + `safety.warn`）；`tools/v13-uia-probe.mjs` 报告输出五项指标与降级裁决。
- **验证**：新增 `v13Metrics.test` / `v13LoopGuard.test`（12+8 项），扩展 `v13UiaProbe.test`，`anchorResolver` 40 项存量全绿（默认不注入 degradation 时行为零变化）。

### #36 S5 缺席检测（预期完成事件契约）
- **方案原文**：`wfRunLedger` 中 recipe 声明 `expected_event_schema`/最大静默期/里程碑/探测方式；**连续两个采样周期未见预期事件 → absent**，先只读探活，再按幂等性/外部副作用/凭证作用域决定降级/重试/交还人工；不自动重跑、不拉起人工停止项；进 `logBus` `safety.warn` + 状态行（验收 #6）。
- **做法**：`watchdog.mjs` 增加 `declare/clear/listContracts` + `absent` 检测（只认预期事件出现与否，不认进程 200/a11y 非空/心跳）+ 只读探活 + `decideAbsentAction` 三档建议（`autoRerun` 恒 false）；`wfRunLedger.mjs` 的 `begin` 存 `expectedEvent` 契约；`bridge.mjs` 在 recipe 点火 declare、结算 clear，`onAlert:absent` 写 `safety.warn` + outbox 通知，`/api/watchdog` 加 declare/clear。
- **验证**：新增 `watchdogAbsence.test`（10 项）+ `wfRunLedger.test` 扩展；`governance.test` 存量看门狗测试全绿。

### #37 S6 签名/版本清单（代码侧）
- **方案原文**：签名时间戳/证书链/`buildId`/组件哈希进安装清单；按主进程/渲染扩展桥/浏览器执行端/模型依赖/可选视觉模块拆分；随包 Python 运行时评估外置；目标 zip ≤ 200 MB（验收 #3：「已签名但过期」与「未签名但内部调试」分别判定）。
- **新增**：`releaseManifest.mjs`（**签名/来源/新鲜度三列分列判定**，互不污染；组件 7 分组；体积评估）；`tools/make-manifest.mjs`（生成 `install-manifest.json`，不可变 `buildId` 由内容哈希决定，逐文件 SHA256，如实标 unsigned 不伪造签名）；`tools/verify-manifest.mjs`（复算哈希防篡改 + 版本门禁 + 三列裁决）；`pack.cjs` 构建末尾自动生成清单（非致命）。
- **实机结果**（对 `dist/ORB控制台-1.5.0-202611090632`）：哈希 11149 个文件；zip 229 MB 超目标；**随包 Python 运行时 114.9 MB（占 22.5%），外置后估算 ≈169 MB 达标** —— 这就是 S6「首次按需下载/外置」的量化依据。签名 crypto（signtool/证书/RFC3161）属外部证书流程，清单留好结构、如实标注，拿到证书回填即可。
- **验证**：新增 `releaseManifest.test`（16 项）；生成器/校验器对真实构建目录往返验证通过；验收 #3 两种情形（buildId 不匹配 → `canCreateTarget=false` + 保留恢复路径；已签名但过期 ≠ 篡改 ≠ 新鲜度失效）单测与实机 CLI 均确认。

### 顺带修复（上一批次遗留）
- `browserProvider.test.mjs`：S3 给 `stats()/config()` 加了 3 个新鲜度字段却没同步「字段固定」断言，导致 2 项存量单测红。已更新断言并补一条 S3 `buildStale` 专项测试。

## 质量总览（本批次）
- 全量单测 **1484 / 1484 通过**（新增 46 项）；真起桥冒烟 **87 / 87 PASS**。
- 门禁全绿：`VERSION_CONSISTENT 1.5.0` / `PACK_CLOSURE OK` / `REG_OK(105 模块)` / `WIRING_AUDIT_OK`。

## 提交记录（本地 `main`）
- `2307c58` perf(governance): S1 版本单一真相源 + S2 wb-callback 收编 logBus + #32 桥依赖生产闭包瘦身
- `a0a39dd` feat(browser): S3 扩展新鲜度桥侧比对
- （本批次）S4/S5/S6 + S3 测试修复

## 待办 / 阻塞
- **GitHub 上传阻塞**：本环境当前无法访问 GitHub（`git ls-remote` 报 `CONNECT tunnel 502`），故 `git push` 与 Release 资产重新上传均无法在本会话完成。最终优化包已就绪于：
  - `dist/ORB控制台-1.5.0-202611090632-便携版.exe`（218.6 MB）
  - `dist/ORB控制台-1.5.0-202611090632.zip`
  - 目录 `dist/ORB控制台-1.5.0-202611090632/`
  待网络恢复后，到能访问 GitHub 的环境执行删除旧资产 + 上传上述新包即可（Release ID 仍沿用既有 v1.5.0）。
- **磁盘**：`dist/` 下累积了多个历史构建（1.4.5–1.5.0，约 4 GB+）。运行 `orb\清理旧构建.cmd`（默认保留最新 1 份）可回收，建议上传完成后执行。
