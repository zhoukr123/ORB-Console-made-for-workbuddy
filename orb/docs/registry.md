# ORB 注册表自述（自动生成，勿手改）

> 由 `orb/tools/gen-registry-doc.mjs` 从源码结构生成。
> 要改内容请改源码；改完跑 `node orb/tools/gen-registry-doc.mjs` 重新生成。
> 单测 `test/registryDoc.test.mjs` 会校验本文件与源码一致 —— 手改会直接测挂。

## 一、桥侧模块（orb/*.mjs）

共 105 个。按文件名排序，不按重要性 —— 排序规则一旦掺入主观判断就会天天变。

**故意不记行数**：行数每次修 bug 都变，把它放进文档等于让「漂移检测」
每次提交都红一次，红到最后就没人看了。
这里只记**结构**：有哪些模块、各自对外露了什么、头部怎么自述的。
这三样只在真的增删模块或改导出时才会变 —— 那时文档确实该跟着变。

| 模块 | 它是什么 | 对外导出 |
|---|---|---|
| `affectGate.mjs` | Affect Gate：只回答一个问题——「ORB 此刻该不该主动开口」。 | `DEFAULT_SPEAK_TIER` `GATES` `SPEAK_TIERS` `SPEAK_TIER_IDS` `createAffectGate` `inferTierFromText` |
| `anchorResolver.mjs` | anchorResolver（确定性锚定解析，可单测） | `ACTION_ERROR_CODES` `AGENT_DESKTOP_LIMITS` `ANCHORABLE` `DEGRADATION_CODES` `DEGRADE_TO` `ELEMENT_BACKENDS` `ELEMENT_REF_SCHEMA_VERSION` `REF_BINDING_ERRORS` `V13_METRICS` `V13_THRESHOLDS` `addDeltaToArgs` `bindRefVersion` `buildTreeSelector` `checkRefBinding` `classifyActionError` `classifyAgentDesktopError` `createAnchorResolver` `createTreeCache` `decideDegradation` `decideEscalation` `isSelfElectronWindow` `matchTreeNode` `normalizeElementRef` `normalizeElementRefWithBinding` `parseSnapshotTree` `preferSnapshotRef` `primaryPoint` `pruneSnapshotTree` `refBindingExtra` `resolveTreeNode` `treeFingerprint` `validateRefBinding` `verifyEffect` |
| `apiChannel.mjs` | API 通道的用户开关 —— 宿主侧**唯一**状态源。 | `USER_DISABLED` `createApiChannel` `defaultState` `normalizeState` |
| `appIntent.mjs` | 应用意图解析：静态能力表 + 查表函数，不猜、只查表。 | `APPS` `APP_COUNT` `CONFIDENCE_GATE` `DEEP_LINKS` `FORBIDDEN_SCHEMES` `LAUNCH_EVIDENCE` `appMatrix` `canDirectOpen` `deepLinkAudit` `extractKeyword` `findApp` `namedBrowser` `planClientLaunch` `registerDeepLink` `resolveAppAction` `resolveClientAction` `resolveDeepLink` `resolveWebLanding` `wantsClient` |
| `archiver.mjs` | 归档：.pending/<cid> → YYYY-MM-DD/<cid> 同卷 rename（跨卷/失败退化 copy 并记入 manifest）。 | `createArchiver` |
| `artifactLayout.mjs` | ESM 侧入口：实现只有 desktop/artifactLayout.cjs 一份，这里做转发。 | — |
| `artifactStore.mjs` | 产物登记：相对路径校验、按天 jsonl 追加、manifest 绝不存绝对路径。 | `ALLOWED_EXT` `DENIED_FILES` `createArtifactStore` |
| `artifactView.mjs` | 产物浮层的数据整形层：纯函数，零 Electron 依赖、零目录扫描。 | `MEDIA_EXTS` `PREVIEW_EXTS` `STATUSES` `STATUS_META` `dayFromTs` `inferRel` `isMedia` `isPreviewable` `productRel` `rootKeyOf` `statusOf` `truncatePreview` `viewRow` `viewRows` |
| `attachPlan.mjs` | 大附件采样计划（attachPlan）：给出"这个附件大概要花多少、怎么读才不烧穿"的确定性答案。 | `CAPS` `RATES` `kindOf` `planFor` `verdictOf` |
| `autoOutcome.mjs` | 独立结果判定（autoOutcome / OutcomeGate） | `EVIDENCE_LEVEL` `OUTCOME_SIGNALS` `REASON` `VERDICT` `buildSpec` `checkPostcondition` `isSample` `judge` `toRunStatus` |
| `autoPolicy.mjs` | 自动化升降级判据（autoPolicy） | `DEFAULT_THRESHOLDS` `MODES` `decideTransition` `evaluatePolicy` |
| `autoRetry.mjs` | 失败分类与有限重试（autoRetry） | `DEFAULT_RETRY` `RISK` `argsFingerprint` `backoffMs` `classifyRetryability` `riskOf` `shouldRetry` `stepIdemKey` |
| `autoTrace.mjs` | 逐步执行轨迹（autoTrace） | `createAutoTrace` |
| `batchA.mjs` | 报告B §7 批次A 第 5、6 项 —— 纪律层纯函数（单一真相源）。 | `DEGRADE_CODES` `SEARCH_LIKE_KEYS` `UNTRUSTED_SOURCES` `V12_CONTRACT` `authorizeDomain` `classifyDegrade` `degradeRecord` `isPrivateHost` `isSearchLike` `isUntrustedSource` `searchExemptAudit` `structuredMarker` |
| `bridge.mjs` | ORB 桥：面板（Electron 渲染进程）与外部能力之间的唯一进出通道。 | — |
| `browserProvider.mjs` | 浏览器操控 Provider 协议：ORB 侧纯逻辑状态机。 | `BROWSER_METHODS` `BROWSER_PROTOCOL_VERSION` `createBrowserProvider` |
| `capabilityRegistry.mjs` | 能力清单（capabilityRegistry） | `AGENT_DESKTOP_VERSION` `CAPABILITIES` `ELEMENT_REF_SCHEMA_VERSION` `authorizedByOf` `capabilityManifestEntry` `confirmRequiredSet` `governWrite` `isReadOnly` `isStopExempt` `manifestFor` `requiresConfirmOf` `revocableOf` `revocableSet` `stopExemptSet` `table` `toMarkdown` |
| `cmdDanger.mjs` | 命令通道危险判定（硬闸） | `commandChannelArgs` `hardDangerOp` |
| `cmdGuard.mjs` | 命令通道准入闸门（纯逻辑，便于单测；bridge 直接调用）。 | `createCommandGate` |
| `cmdchan.mjs` | （无头部说明） | `buildOpenWith` `classifyApp` `copyEntry` `launchApp` `moveEntry` `normalizeCmdOp` `renameEntry` `runCommandOp` `writeTextFile` |
| `costLedger.mjs` | 成本账本（costLedger） | `DEFAULT_PRICING` `createCostLedger` `estimateTokens` |
| `dispatcher.mjs` | 任务派发器（dispatcher） | `createDispatcher` `keywords` |
| `dreamConsolidator.mjs` | Dream 记忆整理层（桥侧纯逻辑，可单测） | `CONSOLIDATION_PHASES` `DEFAULT_QUOTA` `TRUST_LEVELS` `UNVERIFIED_PREFIX` `createDreamConsolidator` `isEligible` `similarity` |
| `dsh-mcp-launcher.mjs` | dsh-mcp 启动器 | — |
| `epoch.mjs` | 能力时钟：给「一次副作用」签发 capability，执行前后校验是否仍属当代。 | `createEpochClock` |
| `events.mjs` | 事件记录：采样/限流、UIA 退化、脱敏转义、凭据不进日志、events.jsonl 幂等 flush。 | `REASON_CODES` `createEventRecorder` |
| `executionBridge.mjs` | 执行桥接层：把治理层决策翻译成两条执行通道的真实指令形态。 | `planExecution` `runPlan` `toBrowserCall` `toDesktopCall` |
| `expertContract.mjs` | 专家契约（expertBook）：把"这个专家能做什么"从散落的代码变成一份可校验的声明。 | `DEFAULT_BOOK` `DEFAULT_CONTRACT` `SCOPES` `arbitrate` `createExpertBook` `defaultBookPath` `normalizeContract` `toMarkdown` |
| `expertTeam.mjs` | 专家团模式 = 任务分配机制（orchestrator-workers），**不是**审查/复核机制。 | `LEAD` `WORKER_ROLES` `WORKER_STATUS` `createExpertTeam` |
| `exporter.mjs` | 导出器：各格式纯函数 + 原子落盘。零三方依赖，fs/时间均可通过 opts 注入。 | `CSV_BOM` `EXPORT_SECTIONS` `buildSource` `createExporter` `evidenceSection` `markTempDisposition` `sectionToggle` |
| `fastPath.mjs` | 快速筛查：大文件/录屏音轨绝不进模型输入，只给 header/时长/内容哈希/采样窗口。 | `REASON_CODES` `createFastPath` |
| `freetier.mjs` | 自由路由（FreeTier） | `createFreeTier` `intentToCmdOp` `normalizeIntent` `parseOpenIntent` |
| `governanceCore.mjs` | 治理总闸：四档矩阵的唯一真相源。 | `MODES` `TIERS` `describeMode` `enabledGovernance` `isTierAEnabled` `isTierBEnabled` `resolveMode` |
| `guiLock.mjs` | GUI 独占锁（guiLock） | `createGuiLock` |
| `hostDataApi.mjs` | API 通道宿主侧实现：补齐《综合性方案》§3.2 的唯一功能缺口。 | `API_ENDPOINTS` `createHostDataApi` `listEndpoints` |
| `injectable.mjs` | 可注入纪律条款汇总 —— 单一真相源。 | `SECTIONS` `render` |
| `intentFallback.mjs` | 意图兜底：schema 约束的「只能选、不能造」（2026-11-07） | `FALLBACK_CACHE_MAX` `buildIntentSystemPrompt` `buildIntentUserPrompt` `createIntentFallback` `extractJson` `needsFallback` `validateIntentResult` |
| `intentMissLog.mjs` | 意图未命中日志（2026-11-07 · 数据驱动扩词表） | `MAX_MISS_ENTRIES` `MAX_MISS_TEXT` `createMissLog` `missKey` `missLog` |
| `logBus.mjs` | 日志总线：枚举校验 + 白名单 + 脱敏转义 + 限流 + 按天分类 jsonl 轮转。 | `CATEGORIES` `LEVELS` `RETENTION_DAYS` `createLogBus` |
| `mdEscape.mjs` | ESM 侧入口：实现只有 desktop/mdEscape.cjs 一份，这里做转发。 | — |
| `memoryBudget.mjs` | I-08 动态记忆预算 | `BASE_BUDGET` `BUDGET_MODES` `HARD_CAP` `MEMORY_TIERS` `budgetFor` `createMemoryBudget` |
| `mousehook.mjs` | ══════════ 全局鼠标钩子 ══════════ | `hookState` `mouseHookRunning` `startMouseHook` `stopMouseHook` `suppressMouseHook` |
| `observeRouter.mjs` | Observe 路由：只记录判定，绝不建 Ticket、绝不执行任何动作。 | `REASON_CODES` `createObserveRouter` |
| `orb-mcp-server.mjs` | orb-mcp-server —— 把 ORB 的原生能力包成一个标准 MCP server。 | — |
| `outbox.mjs` | 发件箱（outbox） | `createOutbox` `dedupeKeyOf` |
| `outcomeEvidence.mjs` | 界面证据候选（outcomeEvidence） | `diffLines` `stabilize` |
| `outcomeSuggest.mjs` | 判据归纳建议（outcomeSuggest） | `KNOWN_KINDS` `buildOutcome` `describeSuggestion` `suggestOutcomes` |
| `outputProfile.mjs` | 输出配置：七键 profile 的默认值、归一、校验与派生工具。纯函数，零 IO。 | `DEFAULT_PROFILE` `FORMATS` `normalizeProfile` `redactValue` `resolveName` `retentionCutoff` `shouldInclude` `validateProfile` |
| `p0Discipline.mjs` | P0 轻治理纪律：代价路由 / 证据标注 / 协作红线 / 家规。 | `COST_LEVELS` `EVIDENCE_TAGS` `INJECTABLE_DISCIPLINE` `RED_LINES` `admissibleForSeal` `checkHouseRule` `checkRedLine` `routeByCost` `tagEvidence` |
| `p1FileChannel.mjs` | P1 文件化机间信道：派工包 / 当前状态 / 修复台 三件套。 | `CHANNEL_FILES` `INJECTABLE_CHANNEL_RULE` `createFileChannel` |
| `p2SealReview.mjs` | P2 · Tier A 重治理：独立复核评审 + 多 agent 带上下文。 | `INJECTABLE_SEAL_RULE` `SEAL_GROUNDS` `buildContextBag` `createSealReview` `defaultTeamFactory` |
| `p2SiteAdapter.mjs` | P2 · 站点适配器：capability 表 + actionGate 闸门 + 通用兜底。 | `CHANNELS` `CONFIDENCE_THRESHOLD` `DEEP_ADAPTED_SITES` `GENERIC_FALLBACK` `INJECTABLE_ADAPTER_RULE` `SITE_CAPABILITIES` `SITE_STATS` `actionGate` `assertVisionDecisionOnly` |
| `p3VerifyLite.mjs` | P3 · 亲测验收 Lite + 五段验收引擎。 | `INJECTABLE_VERIFY_RULE` `STAGES` `STAGE_CHECKS` `VERIFY_SIGNALS` `checkStage` `claimDone` `verifyLite` |
| `perfBaseline.mjs` | 性能基线：只生成 20×3 采样计划与采集/统计机制，不产生任何结果。 | `createBaseline` |
| `personaSlots.mjs` | 语气三槽（personaSlots）：给五个性格再叠一层"此刻该用什么温度说话"。 | `SLOTS` `createPersonaSlots` `targetSlot` |
| `pluginAdapters.mjs` | pluginAdapters.mjs — 跨生态「插件消费层」（已进 orb/，与 pluginHost / pluginArtifactGate 同目录） | `ARTIFACT_ORIGINS` `adaptAgentPack` `adaptDeepseekArtifact` `adaptMcpConnector` `adaptSkill` `adaptWorkbuddyPlugin` `createArtifactGate` `createDemoHostAsync` `createPluginHost` `detectPluginKind` `mcpToolAdapter` `safeId` |
| `pluginArtifactGate.mjs` | pluginArtifactGate.mjs — ORB 生成物「纯逻辑验收闸门」 | `ACCEPTANCE_SECTIONS` `ARTIFACT_ORIGINS` `GATE_CODES` `createArtifactGate` |
| `pluginEcosystem.mjs` | pluginEcosystem.mjs — 共享插件生态（统一摄入层，已进 orb/，桥侧 plugin.install 直接调用） | `ARTIFACT_ORIGINS` `FIDELITY` `adaptBrowserExtensionDescriptor` `adaptUnknownDescriptor` `createArtifactGate` `createPluginHost` `detectPluginKind` `dryRunManifest` `ingestPlugin` `installAll` `installManifest` `mcpToolAdapter` |
| `pluginHost.mjs` | pluginHost.mjs — 插件转化底座（方案条目 I-23 窄版：协议底座 + 前 2 项 S 级工具） | `BUILTIN_PLUGINS` `createPluginHost` |
| `pluginMarket.mjs` | pluginMarket.mjs — WorkBuddy 插件市场的只读索引（离线、真实数据） | `MANIFEST_CANDS` `PLUGIN_ROOT` `readSource` `safeId` `scanMarket` `searchMarket` |
| `pluginPack.mjs` | pluginPack.mjs — 本地插件包的拆包与落盘（「把插件包拖进来」的后端） | `PACK_LIMITS` `locateRoot` `looksLikeZip` `packHash` `readZip` `safeRelPath` `synthesizeSkillManifest` `unpackTo` |
| `policyTransition.mjs` | 策略换代纯逻辑状态机：先投递收敛通知，待在途 ticket 完成 checkpoint 或干净回滚并静默后再提交换代；自维护 policyEpoch，与带外急停完全正交，全程不触发即时终止动作。 | `POLICY_CHANGE_KINDS` `POLICY_ERRORS` `POLICY_PHASES` `assertSeparateFromStop` `createPolicyTransition` `drainPlan` |
| `probe.mjs` | 环境探测器（probe） | `createProber` |
| `receipts.mjs` | 效果收据：幂等键绝不重复发、settle 落结果、内存归属带 interruption。 | `createReceipts` |
| `rectest.mjs` | 录屏模块实机验证（rectest） | — |
| `refBinding.mjs` | ref 版本绑定（11-07 增量简报 §1）：agent-desktop v1.1.0 已证实、当前 v1.2.0。 | `AGENT_DESKTOP_LIMITS` `AGENT_DESKTOP_VERSION` `ELEMENT_REF_SCHEMA_VERSION` `REF_BINDING_ERRORS` `bindRefVersion` `capabilityManifestEntry` `classifyAgentDesktopError` `refBindingExtra` `validateRefBinding` |
| `releaseManifest.mjs` | 发布安装清单：签名 / 来源 / 新鲜度「分列判定」+ 组件分组 + 体积评估（纯模块，可单测）。 | `COMPONENT_GROUPS` `MANIFEST_SCHEMA_VERSION` `ZIP_TARGET_BYTES` `assessTrust` `classifyFreshness` `classifySignature` `classifySource` `componentGroupOf` `evaluateSize` `summarizeComponents` |
| `runtime.mjs` | 前台通道运行时（windows-mcp 的宿主）——**单一真相源**。 | `PROC_KIND_MATCHERS` `RUNTIME_DIR` `RUNTIME_PY` `hasWindowsMcp` `matchProcKind` `resolvePython` `windowsMcpArgs` `windowsMcpEnv` |
| `safetyOverview.mjs` | 安全子菜单的只读概览。 | `OVERVIEW_LABELS` `containsNumeric` `safetyOverview` |
| `searchCredentials.mjs` | 批次C · 外部检索的**可插拔凭据来源**（默认 inert）。 | `CREDENTIAL_SOURCES` `DEFAULT_CREDENTIAL_SOURCE` `createCredentialProvider` |
| `searchL4.mjs` | 报告B §7 批次B 第8项：V-06 **L4 契约层**。 | `L4_FIELDS` `L4_REASON_CODES` `L4_SCHEMA_VERSION` `l4Schema` `l4Unavailable` `normalizeL4` |
| `searchOrchestrator.mjs` | 批次C · 结果回填编排（报告 §7 第 10 项）。 | `ACTIONS` `DOC_REASON_CODES` `INTENT_VERBS` `MAX_DOC_ENTRIES` `MAX_DOC_ENTRIES_LIMIT` `MAX_QUERY_LEN` `SEARCH_DOC_SCHEMA_VERSION` `buildSearchDoc` `firstRealSearchVerb` `intentVerbs` `normalizeText` `orchestratorSchema` `parseProduceIntent` `parseSearchToClipboardIntent` `parseSearchToDocIntent` `realSearchVerbs` `safeResultUrl` `splitClauses` `toHalfWidth` `trimQueryEdges` |
| `searchProvider.mjs` | 外部检索 REST 的可测试逻辑层：默认关闭、凭证绝不外泄、失败绝不静默回落到截图/视觉循环。 | `SEARCH_SCHEMA_VERSION` `createSearchProvider` |
| `searchProviderAdapters.mjs` | 批次C · 外部检索 provider 适配器注册表（2026-11-06；2026-11-06 晚扩展）。 | `ADAPTERS` `ADAPTER_IDS` `DEFAULT_ADAPTER_ID` `getAdapter` `listAdapters` |
| `searchUrl.mjs` | 开窗原语：把用户输入规范化为可安全交给系统浏览器打开的 http(s) URL。 | `SEARCH_ENGINE_NAMES` `SEARCH_MAX_LEN` `isKnownEngine` `searchEngineUrl` `searchUrl` |
| `selftest.mjs` | Orb 全链路自检 | — |
| `semanticRouter.mjs` | 语义路由（方案 I-26）——只做「这句话该走哪一档」的判定，不调模型、不改调度。 | `TIERS` `createSemanticRouter` |
| `session.mjs` | 会话生命周期：起止 / lastActive / 跨午夜归结束日 / stop 冻结只读快照。 | `createSessionManager` |
| `siteCapabilityData.mjs` | 站点能力数据表（规模化登记 · 诚实版） | `CATEGORIES` `DATA_SOURCE` `DEEP_ADAPTED_SITES` `SITE_ENTRIES` `SITE_STATS` `TIERS` `VERIFIED_SITES` `assertNoInventedSelectors` `buildCapabilityTable` `classify` `lookupSite` |
| `siteLibrary.mjs` | 本地站点库：把「用户自己的浏览痕迹」变成最快的站名 → 官网解析器。 | `createSiteLibrary` `normalizeSiteName` |
| `span.mjs` | Span 采集器：只提供打点/统计机制，样本不足在 sixMetrics().complete 明确为 false，绝不补假样本。 | `METRICS` `createSpanCollector` |
| `stateWriters.mjs` | 状态单一写者（新增通道用）。 | `RANK` `STATE_WRITERS` `SUCCESS_STATES` `TERMINAL` `createStateWriter` |
| `sync-agent-key.mjs` | 同步可用的 API Key 到我们自己的 DSH 凭据副本。 | — |
| `taskRouter.mjs` | 任务 → 通道 分类器（taskRouter） | `HIGH_CONFIDENCE` `MID_CONFIDENCE` `classifyCommandable` `planTask` `planTaskProbed` `probeCommandable` |
| `team.mjs` | 专家团（阶段一形态）：单模型多视角 + 确定性校验器。 | `BUILTIN_EXPERTS` `createTeam` |
| `telemetry.mjs` | 机器遥测（方案 I-12a）——只读一次性快照。 | `createTelemetry` |
| `textGate.mjs` | 文本闸门：零模型调用、纯确定性规则。 | `createTextGate` |
| `ticketControl.mjs` | 工单急停 / 引导：global 暂停只挡新工单，在跑的 isBlocked 永远 false。 | `createTicketControl` |
| `ticketStore.mjs` | 工单存储（ticketStore） | `TERMINAL` `createTicketStore` |
| `trajectory.mjs` | 工单轨迹（trajectory） | `createTrajectory` |
| `upgrade.mjs` | 升级器（upgrade）：把"从哪升到哪、为什么升、属于哪个世代"收敛成一种形状。 | `LADDERS` `createUpgrade` |
| `v13LoopGuard.mjs` | V-13 / C-07 降级纪律 + 视觉循环预算（纯模块，可单测）。 | `DEGRADATION_CODES` `DEGRADE_TO` `V13_METRICS` `V13_THRESHOLDS` `createVisualLoopBudget` `decideDegradation` `isSelfElectronWindow` |
| `v13Metrics.mjs` | V-13 / C-07 落地：五项指标 + 降级阈值 + 记录表（纯模块，可单测）。 | `DANGER_LABEL_RE` `V13_METRICS` `V13_THRESHOLDS` `computeTreeMetrics` `createV13RecordingTable` `evaluateMetric` |
| `vidxSynth.mjs` | 看视频产物 → 「内容提要 + 关键截图」MD 合成器。 | `findVidxJob` `synthesizeVidxMd` |
| `vidxSynthOnce.mjs` | 一次性补交脚本：把某条历史「看视频」任务（在旧存储根）合成「内容提要 + 关键截图」MD， | — |
| `visualAnchor.mjs` | 视觉锚定后端（方案 C 的 C0 / C1 两档） | `captureVisualCrop` `cosineSim` `createClipMatcher` `createVisualAnchor` `decodePng` `templateMatch` |
| `visualTiers.mjs` | 视觉档位选择 + 可取消预读 + 双路健康预探测。 | `NO_BATCH_ACTIONS` `TIERS` `createVisualTiers` |
| `watchdog.mjs` | 本地看门狗（watchdog） | `createWatchdog` `decideAbsentAction` `hasExpectedEvent` `normalizeExpectedContract` |
| `wfCheckpoint.mjs` | 断点续跑（wfCheckpoint） | `RESUME_BLOCK` `canResume` `createCheckpoints` `isLinearRecipe` `recipeDigest` |
| `wfDag.mjs` | 受限编排（wfDag） | `MAX_EDGES` `MAX_NODES` `NODE_KINDS` `evalCond` `normalizeGraph` `planOrder` `topoOrder` `validateGraph` |
| `wfPreflight.mjs` | 回放前预检（wfPreflight） | `PREFLIGHT` `SEVERITY` `preflight` `snapshotWindows` `summarizePreflight` `windowState` |
| `wfRecipeVersions.mjs` | 配方版本（wfRecipeVersions） | `createRecipeVersions` |
| `wfRunLedger.mjs` | 自动化运行账本（wfRunLedger） | `createWfRunLedger` |
| `wfTrash.mjs` | 自动化回收站（wfTrash） | `createWfTrash` |
| `workerPool.mjs` | Worker 池（workerPool） | `createWorkerPool` |

## 二、急停豁免能力（安全边界）

清单在 `orb/capabilityRegistry.mjs`，共 6 条，其中 6 条在急停期间放行。
完整说明见 [`capabilities.md`](./capabilities.md)（同样自动生成）。

| server | tool | 急停放行 | 它到底做了什么 |
|---|---|---|---|
| orb | cursor_position | 是 | 读鼠标坐标；不动鼠标、不点任何东西 |
| orb | ocr | 是 | 截屏后离线取词；只读屏幕像素，不操作窗口 |
| orb | subtitle | 是 | 查实时字幕状态；启停字幕仍受急停拦截 |
| windows | Screenshot | 是 | 截一张屏；不移动焦点 |
| windows | Snapshot | 是 | 读当前窗口与控件树；不改任何状态 |
| windows | DisplayInventory | 是 | 枚举显示器信息；纯查询 |

## 三、状态写入器（STATE_WRITERS）

这些位置是**允许写任务状态**的地方。清单外的代码直接改 status 就是越权，
`stateWriters.mjs` 的等级规则（RANK）会挡住「降级回写」。

| 名字 | 说明 |
|---|---|
| `ticketStore.transition` | 工单终态；bridge/settleJobTicket；CAS + RANK，done 不给 allowStale |
| `ticketStore.openTicket` | 工单创建；bridge/startJob；开局带当前 epoch |
| `ticketStore.bumpEpoch` | 全量作废；bridge/doStop；世代号唯一来源 |
| `ticketStore.resumeTicket` | 恢复；POST /api/tickets?action=resume；不回退 epoch |
| `jobs.set` | 面板任务镜像；bridge/runBody / abortJob / doStop；只镜像，不反向覆盖工单 |
| `createStateWriter.commit` | 新通道状态；新增通道（observe / 导出 / 归档）；RANK 单调，终态不得回写 success |
| `policyTransition.commit` | 策略世代；POST /api/ops policy.commit；仅在 draining 全清后才 +1；绝不调用 bumpEpoch / doStop |
| `policyTransition.rollback` | 策略回退；POST /api/ops policy.rollback；policyEpoch 不变，history 追加 rolled_back |
| `dreamConsolidator.consolidate` | 离线记忆整理；POST /api/ops dream.consolidate；仅空闲时跑；不可信输入不进记忆；只作候选不建 Ticket |
| `memoryBudget.setMode` | 记忆预算档位；POST /api/ops memory.setMode；普通模式零开销；Max 才启用动态预算，受 HARD_CAP 约束 |
| `createArtifactGate.accept` | 插件生成物收据；POST /api/ops artifact.accept；三段式验收全过后才签 receipt；restart-required 不算成功 |

## 四、指标（METRICS）

共 6 个。名字进这里是契约：改名字等于改监控面板的查询。

| 指标 | 类型 | 说明 |
|---|---|---|
| `eventToTaskMs` |  |  |
| `queueMs` |  |  |
| `e2eMs` |  |  |
| `costPerEffectiveWork` |  |  |
| `misrouteRate` |  |  |
| `interruptCost` |  |  |

## 五、日志分类与级别

分类（12）：`task`、`trigger`、`tool`、`gui`、`media`、`memory`、`persona`、`safety`、`cost`、`artifact`、`plugin`、`system`

级别（5）：`debug`、`info`、`warn`、`error`、`audit`

新增分类必须同步面板的筛选项，否则日志会写进去但没人看得到。
