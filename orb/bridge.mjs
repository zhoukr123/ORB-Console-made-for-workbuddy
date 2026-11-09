/* ORB 桥：面板（Electron 渲染进程）与外部能力之间的唯一进出通道。
 *
 * 它同时是三件事：
 *   ① 一个 HTTP 服务（面板所有 /api/* 都打到这里）；
 *   ② MCP 客户端（orb / windows / workbuddy 三路会话，按需冷启动）；
 *   ③ 治理层装配点（账本、工单、产物、播报、急停、GUI 锁在这里接起来）。
 *
 * 三条约定，改动时别破：
 *   1) **不抛异常给面板**：所有处理函数最终都要 send(res, ...)，宁可 500 带 error 字段，
 *      也不要让一个未捕获的 rejection 把整条流挂住（面板会表现为"永远转圈"）。
 *   2) **急停检查点在 callToolRaw 入口**：只放一处，覆盖回放/单次/后台/确认四条路。
 *      分散写检查点一定会漏，而漏的那条就是急停失效的那条。
 *   3) **状态流里不放会 spawn 的东西**：buildStatusSnapshot 每 1.5s 推一次，
 *      塞一个 wmic/tasklist 进去就是每 1.5 秒开一次子进程。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { resolvePython, windowsMcpArgs, windowsMcpEnv, matchProcKind, hasWindowsMcp } from "./runtime.mjs";
/* 确定性锚定解析（方案 A1 / B 的纯逻辑层）。把抗迁移锚定从 OCR/Windows API 里抽出来，
 * 成为可单测的纯模块；bridge 只把有副作用的解析器（OCR 文字锚定、控件树抓取）以 deps 注入。
 * 依赖方向单向：bridge → anchorResolver，模块不 import bridge。 */
import { createAnchorResolver, parseSnapshotTree, buildTreeSelector, matchTreeNode, pruneSnapshotTree, resolveTreeNode, preferSnapshotRef, createTreeCache, primaryPoint, addDeltaToArgs, ANCHORABLE, classifyActionError, decideEscalation, ACTION_ERROR_CODES, verifyEffect, isSelfElectronWindow } from "./anchorResolver.mjs";
import { createVisualAnchor, captureVisualCrop } from "./visualAnchor.mjs";
import { createVisualLoopBudget } from "./v13LoopGuard.mjs";
/* 治理层（2026-11-03 接入）。五个模块都是纯 Node、无第三方依赖，
 * 之所以单独成文件而不是继续堆进 bridge.mjs：这个文件已经 5700 行，
 * 再往里塞状态机只会让"谁能写任务状态"重新变回没人说得清。
 * 依赖方向是单向的：bridge → 模块，模块不 import bridge（pack.cjs 的依赖审计认这个）。 */
import { createTicketStore } from "./ticketStore.mjs";
import { createOutbox } from "./outbox.mjs";
import { createCostLedger } from "./costLedger.mjs";
import { createGuiLock } from "./guiLock.mjs";
import { createDispatcher, keywords as keywordsMatcher } from "./dispatcher.mjs";
/* 本地站点库：书签 + 浏览历史 + 已确认过的解析结果。
 * 站名 → 官网的通用解析没有 100% 方案，但"你自己去过的站"是零猜测的。 */
import { createSiteLibrary } from "./siteLibrary.mjs";
/* 专家团 / 门控 / 插件底座 / 语义路由 / 机器遥测。
 * 五个模块都是纯逻辑（不调模型、不写库），只在这里挂上桥的生命周期与产物目录。 */
import { createTeam } from "./team.mjs";
import { createAffectGate, GATES as AFFECT_GATES } from "./affectGate.mjs";
import { createPluginHost } from "./pluginHost.mjs";
/* 跨生态摄入（市场/技能/连接器/生成物 → 同一注册表）+ 本机插件市场只读索引。
 * 两者都是纯逻辑，安全面统一交给 pluginArtifactGate，桥只负责编排与审批透传。 */
import { dryRunManifest, installManifest } from "./pluginEcosystem.mjs";
import { scanMarket, searchMarket, readSource, safeId } from "./pluginMarket.mjs";
import {
  readZip, looksLikeZip, unpackTo, packHash, locateRoot,
  synthesizeSkillManifest, PACK_LIMITS,
} from "./pluginPack.mjs";
import { createSemanticRouter } from "./semanticRouter.mjs";
import { createTelemetry } from "./telemetry.mjs";
import { createTrajectory } from "./trajectory.mjs";
import { createWorkerPool } from "./workerPool.mjs";
import { createWatchdog } from "./watchdog.mjs";
import { runCommandOp, normalizeCmdOp } from "./cmdchan.mjs";
import { commandChannelArgs, hardDangerOp } from "./cmdDanger.mjs";
import { createFreeTier } from "./freetier.mjs";
import { classifyCommandable, planTask, probeCommandable, planTaskProbed } from "./taskRouter.mjs";
import { createProber } from "./probe.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
/* 阶段一交付层 / 尺子 / 归档（2026-11-04 接入）。
 * 与上面治理层同一个规矩：模块不 import bridge，全部零三方依赖、可单测。 */
import { createEpochClock } from "./epoch.mjs";
import { createCommandGate } from "./cmdGuard.mjs";
import { createStateWriter, STATE_WRITERS } from "./stateWriters.mjs";
import { DEFAULT_PROFILE, normalizeProfile, validateProfile } from "./outputProfile.mjs";
import { createExporter, buildSource } from "./exporter.mjs";
import { createLogBus, CATEGORIES, LEVELS } from "./logBus.mjs";
import { createArtifactStore, ALLOWED_EXT } from "./artifactStore.mjs";
/* I-17 产物浮层：rel 形状 / 四类失效态 / 预览边界的唯一判定处（纯函数，可单测）。 */
import {
  productRel, inferRel, viewRow, viewRows, truncatePreview,
  rootKeyOf, isPreviewable, STATUSES, STATUS_META,
} from "./artifactView.mjs";
import { createSpanCollector, METRICS } from "./span.mjs";
import { createObserveRouter } from "./observeRouter.mjs";
import { createTextGate } from "./textGate.mjs";
import { createFastPath } from "./fastPath.mjs";
import { createSearchProvider } from "./searchProvider.mjs";
/* 批次C · 多 provider 适配器：厂商差异只在注册表里，编排层 / L4 / 文本闸门零改动。
 * 用户可申请一个用途明确的检索 key（百度千帆 / 智谱；额度与开通前置条件见各 adapter 的 quotaNote），
 * 不必碰 dsh 凭据库。 */
import { getAdapter, ADAPTER_IDS, listAdapters, DEFAULT_ADAPTER_ID } from "./searchProviderAdapters.mjs";
/* 浏览器操控 provider：纯逻辑状态机（白名单 / epoch / confirm / tab 所有权），
 * 与 Native Messaging 宿主解耦；桥侧只做授权与记账，真执行在浏览器扩展侧。 */
import { createBrowserProvider } from "./browserProvider.mjs";
import { BROWSER_PROTOCOL_VERSION, BROWSER_METHODS } from "./browserProvider.mjs";
import { createBaseline } from "./perfBaseline.mjs";
import { createSessionManager } from "./session.mjs";
/* 应用意图能力表（报告A §4.1）：静态表 + 查表解析，不猜、不填未实测深链模板。 */
import { appMatrix, APP_COUNT, DEEP_LINKS, CONFIDENCE_GATE, resolveAppAction, resolveWebLanding, resolveClientAction, planClientLaunch, deepLinkAudit, LAUNCH_EVIDENCE } from "./appIntent.mjs";
/* 报告B §7 批次A 第5、6项：纪律层纯函数（判定口径单一真相源）。 */
import { isUntrustedSource, authorizeDomain, searchExemptAudit, classifyDegrade, degradeRecord, DEGRADE_CODES, V12_CONTRACT } from "./batchA.mjs";
/* 报告B §7 批次B 第8项：V-06 L4 对外统一契约（只上契约，不接 provider）。 */
import { normalizeL4, l4Schema } from "./searchL4.mjs";
/* 报告B §7 批次C：可插拔凭据来源（默认 inert）+ 结果回填编排。 */
import { createCredentialProvider, CREDENTIAL_SOURCES } from "./searchCredentials.mjs";
import {
  buildSearchDoc, parseProduceIntent, orchestratorSchema,
} from "./searchOrchestrator.mjs";
/* 意图未命中闭环（2026-11-07）：只记原句与原因码，纯内存、有上限，供 /api/search/misses 查。
 * 没有这一步，确定性文法就永远停在写它那天的词表上。 */
import { missLog } from "./intentMissLog.mjs";
/* schema 约束兜底（2026-11-07）：只在「文法没认出来」时问一次模型，默认不开。 */
import { createIntentFallback, needsFallback } from "./intentFallback.mjs";

/* ===== 11-07 增量简报落地：报告可复用项 + 专家团治理纪律层 =====
 * 两段都是纯逻辑、零三方依赖；有副作用的一律靠注入（hostApi / fs / teamFactory / dir）。
 * 依赖方向保持单向：bridge → 模块，模块不 import bridge（pack.cjs 的审计认这个）。
 * 治理层用命名空间导入，避免与桥里既有的 TIERS / GATES / CHANNELS 等标识符撞名。 */
import { createPolicyTransition, assertSeparateFromStop, drainPlan, POLICY_CHANGE_KINDS, POLICY_PHASES } from "./policyTransition.mjs";
import { createDreamConsolidator, UNVERIFIED_PREFIX, DEFAULT_QUOTA } from "./dreamConsolidator.mjs";
import { createArtifactGate, GATE_CODES } from "./pluginArtifactGate.mjs";
import { createMemoryBudget, budgetFor, BUDGET_MODES } from "./memoryBudget.mjs";
import { buildCapabilityTable, lookupSite, assertNoInventedSelectors, SITE_STATS } from "./siteCapabilityData.mjs";
import * as govCore from "./governanceCore.mjs";
import * as govP0 from "./p0Discipline.mjs";
import * as govP1 from "./p1FileChannel.mjs";
import * as govP2 from "./p2SiteAdapter.mjs";
import * as govSeal from "./p2SealReview.mjs";
import * as govVerify from "./p3VerifyLite.mjs";
import * as govHost from "./hostDataApi.mjs";
import { createApiChannel, USER_DISABLED } from "./apiChannel.mjs";
import * as govExec from "./executionBridge.mjs";
import * as govRules from "./injectable.mjs";

/* CLI_EXIT_START —— 11-07 简报 §3.5「失败诚实产品化」：
 * 旧口径是「stdout 非空即成功」，CLI 内部报错但已吐出半段结果时会被当成成功交付。
 * 这里把退出码与「是否有输出」合成一个可展示状态；纯函数，单测按标记抽段独立跑。
 * 约定：err 为空 = 0；err.code 为数字或纯数字串 = 该退出码；字符串错误码
 * （ENOENT/EACCES）/ killed / signal 一律视为非零失败，不做「补零」。 */
function cliExitCode(err) {
  if (!err) return 0;
  const raw = err.code;
  if (raw == null) return (err.killed || err.signal) ? -1 : 0;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (/^\d+$/.test(String(raw))) return Number(String(raw));
  return -1;
}

function classifyCliExit(err, stdoutText) {
  const exitCode = cliExitCode(err);
  const hasOutput = String(stdoutText ?? "").trim().length > 0;
  const failed = exitCode !== 0;
  return {
    exitCode,
    hasOutput,
    failed,
    partialOutput: failed && hasOutput,
    code: failed ? (hasOutput ? "partial-output-failed" : "cli-failed") : "ok",
  };
}

function cliExitMessage(exit) {
  if (!exit.failed) return "";
  const tail = exit.partialOutput
    ? "；已产出的部分内容不作为任务结果交付（副作用可能已产生，不假装没执行）"
    : "；无可用输出";
  return `CodeBuddy CLI 以退出码 ${exit.exitCode} 结束${tail}`;
}
/* CLI_EXIT_END */

/* 未命中该记什么：只记「本来可以走快速通道」的句子。
 * 判据是句子里出现了词表里的多字词（单字「查 / 找 / 搜」太宽，普通闲聊也带）；
 * 词集直接取自 schema，不手抄第二份 —— 手抄的那份迟早和解析器漂移。 */
const INTENT_HINT_WORDS = (() => {
  try {
    const s = orchestratorSchema();
    const all = [...s.coarse.search, ...s.coarse.produce, ...s.coarse.targets];
    return [...new Set(all.filter((w) => String(w).length >= 2))];
  } catch { return []; }
})();
function recordIntentMiss(text, reasonCode) {
  const t = String(text ?? "");
  if (!t.trim()) return;
  if (!INTENT_HINT_WORDS.some((w) => t.includes(w))) return;
  missLog.record(t, reasonCode);
}

/* 文法没认出来时的兜底（默认关）。
 * 只有显式 ORB_INTENT_LLM=1 才可能问一次模型，且用的是用户**自己配的**自定义模型：
 * 没配置就当作不可用 —— 不外呼、不报错、不改原有行为。
 * 模型输出要过 validateIntentResult（action 必须在动作表里、query 必须是原句子串），
 * 任何一条不合规都放弃，调用方保持原来的拒绝。 */
const intentFallback = createIntentFallback({
  enabled: process.env.ORB_INTENT_LLM === "1",
  llm: async (sys, usr) => {
    const custom = readCustomModel();
    if (!custom || !custom.baseUrl || !custom.key || !custom.model) throw new Error("no-custom-model");
    const r = await callCustomChat(custom, sys, usr, 4000, { temperature: 0, maxTokens: 300 });
    return r && r.text;
  },
});

/** 解析 + 兜底 + 落点校验，三个端点共用一份，避免各自演化出第二套判定。
 *  sink 传 null 表示不限落点（/api/search/plan 只做分流，不执行）。 */
async function parseForSink(text, sink) {
  let r = parseProduceIntent(text);
  if (needsFallback(r)) {
    const fb = await intentFallback.resolve(text);
    if (fb) r = fb;
  }
  if (r.ok && sink && r.sink !== sink) {
    return { ok: false, reasonCode: "no-whitelist-match", query: "" };
  }
  return r;
}
import { createArchiver } from "./archiver.mjs";
import { createVisualTiers, TIERS } from "./visualTiers.mjs";
import { createTicketControl } from "./ticketControl.mjs";
import { createReceipts } from "./receipts.mjs";
import { createEventRecorder } from "./events.mjs";
/* 自动化回收站：删除改为可撤销的移动，替代「输入删除两字」的通用词确认。 */
import { createWfTrash } from "./wfTrash.mjs";
/* 自动化运行账本：给已有的回放解释器补「每次点火算一次可查的运行」。
   不引入调度器/队列，只补 n8n / Node-RED / Temporal 共有的执行语义。 */
import { createWfRunLedger } from "./wfRunLedger.mjs";
/* observe / auto 升降级判据：用运行账本里的执行质量字段决定能不能自动点火。 */
import { evaluatePolicy, decideTransition } from "./autoPolicy.mjs";
/* 独立结果判定（OutcomeGate）：把「这次到底成没成」从执行者手里拿走。
   原先是 runSteps 没抛异常就 ok:true，而 autoPolicy 又拿这个 ok 当零退化样本 ——
   地基是自证的。现在判定只看观测物：配方声明的判据、回读、前后指纹。 */
import { buildSpec, judge, toRunStatus, VERDICT } from "./autoOutcome.mjs";
/* 步级轨迹：运行账本记「跑完没有」，这里记「断在第几步、为什么」。 */
import { createAutoTrace } from "./autoTrace.mjs";
/* 失败分类 + 有限重试 + 动作级幂等键。不可逆动作与权限拒绝一律不重试。 */
import { shouldRetry, riskOf, stepIdemKey, DEFAULT_RETRY } from "./autoRetry.mjs";
/* 配方版本：保存前留只读快照，可列 / 可 diff / 可一字不差回滚。 */
import { createRecipeVersions } from "./wfRecipeVersions.mjs";
/* 受限编排：拓扑序 + 子流程 + 人工闸门。不并行、不做长期等待、不让节点内嵌图。 */
import { validateGraph, planOrder } from "./wfDag.mjs";
/* 判据归纳建议：从配方里已有信息（窗口标题、产物路径）推导 outcome 候选。
   没有它，用户必须手写判据才能脱离弱证据档 —— 而多数人不知道该写什么。 */
import { suggestOutcomes, buildOutcome } from "./outcomeSuggest.mjs";
/* 界面证据候选：把「上次运行后界面新出现哪些行」算出来交给用户勾选。
   机器只取证、不判断哪行算成功 —— 那件事只有人知道，猜错会把每次运行都判成失败。 */
import { diffLines as diffEvidenceLines } from "./outcomeEvidence.mjs";
/* 断点续跑：补「第 5 步挂了就得从第 1 步重来」这个洞 —— 桌面动作不可逆，
   重跑等于把做过的提交再做一遍，所以它是安全功能，不只是省时间。
   安全门全在模块里（线性配方 + 最后一步已结算 + 配方没改过），bridge 只负责接线。 */
import { createCheckpoints, canResume, recipeDigest, isLinearRecipe as isLinearRecipeWf } from "./wfCheckpoint.mjs";
/* 回放前预检：跑之前先对着当前界面把锚点核一遍。静态硬伤判 block（必然失败），
   锚点核对只判 warn —— 中途界面可能被前面的步骤切走，开局快照看不到。 */
import { preflight as preflightWf, summarizePreflight } from "./wfPreflight.mjs";
/* 产物布局（2026-11-04）：录屏/截屏/看视频/导出/日志统一按日期分层。
 * 单独成模块是为了让主进程（CJS）和桥（ESM）共用同一套路径算法，不出现两套漂移。 */
import { createLayout } from "./artifactLayout.mjs";
/* 看视频产物 → 内容提要+关键截图 MD 合成器（2026-11-07）。
 * 路由与离线补交脚本共用，避免两版逻辑漂移；登记仍交给 registerArtifact。 */
import { synthesizeVidxMd } from "./vidxSynth.mjs";
/* 能力清单（2026-11-05）：急停白名单的唯一真相源。
 * 之前白名单手抄在 bridge、表格手抄在文档、解释手抄在面板 —— 三份，改一处忘两处。
 * 这里恰是安全边界（多放一个进白名单 = 刹车踩下去还留一只脚），所以必须只有一份。 */
import { stopExemptSet, isStopExempt, isReadOnly, revocableOf, governWrite, table as capabilityTable } from "./capabilityRegistry.mjs";
/* 专家契约（2026-11-05）：把"这个专家能做什么"变成可校验的声明，并在派发口强制。
 * 只读专家若还能拿到写通道，"它说没问题"就不成立 —— 因为它自己改过了。 */
import { createExpertBook, arbitrate, defaultBookPath } from "./expertContract.mjs";
/* 大附件采样计划：只回答"这东西大概值多少、该采多少"，不做截断决定。 */
import { planFor as attachPlanFor, verdictOf as attachVerdict } from "./attachPlan.mjs";
/* 升级器：换档（视觉档 / 路由 / 通道 / 模式）统一记账 + 世代校验。 */
import { createUpgrade, LADDERS } from "./upgrade.mjs";
/* 语气三槽：性格管"是谁在说"，槽位管"这次多热"——两件事正交，别混成 25 套台词。 */
import { createPersonaSlots, SLOTS as PERSONA_SLOTS } from "./personaSlots.mjs";
/* 专家团模式 = 任务分配（orchestrator-workers），与上面只读复核的 team.mjs 刻意分开：
   一个负责「派活」，一个负责「验活」，混在一起就会变成用户批评过的假专家团。 */
import { createExpertTeam, LEAD as TEAM_LEAD } from "./expertTeam.mjs";
/* 安全子菜单的只读概览：把治理计数器翻译成状态词，保证「不放任何数值」。 */
import { safetyOverview } from "./safetyOverview.mjs";
import { SPEAK_TIERS, inferTierFromText } from "./affectGate.mjs";
/* 后台自动复核开关由面板持有，桥留一份镜像给安全页做只读展示。 */
let reviewAutoEnabled = true;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 可写目录。**定义必须靠前**：confFlag / writeConfFlag 在模块顶层就会被调用
   （第 300 行上下的 WB_DAEMON 等常量），如果 DATA_DIR 定义在文件中间，
   那几处会撞上 const 的暂时性死区（TDZ）直接 ReferenceError。
   ⚠️ HERE（装目录）在打包态是 Program Files 下的 resources/ —— **不可写**。
   凡是运行时会写的东西（用户级配置、日志、临时文件）都必须落这里。 */
const DATA_DIR = process.env.ORB_DATA_DIR || path.join(HERE, "..");
/* 用户可配存储根：由主进程 spawn 时注入（= storage.resolveRoot()）。
 * 没注入才回退 DATA_DIR。产物树必须挂在这里，否则用户一改「设置 › 存储」，
 * 面板写新目录、桥还写旧目录，两边分叉。 */
const STORAGE_ROOT = process.env.ORB_STORAGE_ROOT || DATA_DIR;
const PORT = Number(process.env.ORB_PORT || 19387);

/** 统一日志（桌面端从 bridge 的 stdout/stderr 抓取）。带标签的调用方把标签作为首参传入。 */
function log(...args) {
  console.log(...args);
}

/* ---------------- 兜底 ----------------
 * 这个进程一死，ORB 的全部能力（前台自动化 / 后台 AI / 语音 / 字幕）一起没，
 * 而 main.js 只是记一行日志、并不会把它拉起来（历史上表现为"整个控制台点不动"）。
 * 所以两类致命异常都必须在这里兜住：
 *   · uncaughtException —— Node 默认直接终结进程。最典型的来源就是 spawn 出来的
 *     子进程发 'error' 事件（ENOENT）时没有监听者，EventEmitter 会把它升级成抛出。
 *   · unhandledRejection —— Node 15+ 同样默认致命。
 * 语义是"记下来、继续跑"：本地服务宁可带伤运行，也不能整体消失。
 */
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err?.stack ?? String(err));
});
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection:", (err && err.stack) || String(err));
});

/*
 * 访问令牌。
 *
 * 为什么必须有：这个 bridge 能执行任意 PowerShell、控制鼠标键盘。
 * 如果只靠 Access-Control-Allow-Origin:* 而不鉴权，那么用户浏览的**任意网页**
 * 都能 fetch('http://127.0.0.1:19387/api/call', ...) 来遥控这台机器 —— 等于远程代码执行。
 * 所以每个请求都要带 X-Orb-Token，令牌在启动时随机生成并写进 .bridge.json，
 * 只有本机的 Electron 主进程会读到它再转交给面板。
 *
 * ORB_TOKEN_FILE 可覆盖路径：单测会 spawn 真 bridge，不设的话它会**覆盖生产
 * .bridge.json**（把端口/令牌写成测试端口的），用户下次开控制台就会连错地方。
 * 踩过一次，所以这里开一个注入口，测试一律指向 cache/ 下的临时文件。
 */
const TOKEN_FILE = process.env.ORB_TOKEN_FILE || path.join(HERE, ".bridge.json");
const TOKEN = process.env.ORB_TOKEN || randomUUID();
/* 免令牌放行的三个路径：
 *   · /api/health     存活探测
 *   · /api/wb-callback daemon 的结果回调（回调方没有我们的令牌，
 *                     但它必须命中一个已知的 runId 才会被采纳）
 *   · /api/resolve-site 站名 → 官网地址。后台 CLI 里被提示"拿不准就查这个接口"，
 *                     而子进程拿不到 X-Orb-Token；接口本身只读、只绑 127.0.0.1、
 *                     不会执行命令，放行的代价仅限于"本机进程能问一次站名"。 */
const PUBLIC_PATHS = new Set(["/api/health", "/api/wb-callback", "/api/resolve-site"]);

// Node 可执行文件定位顺序：ORB_NODE 环境变量 → 版本目录里最新可用版本 → 交给 PATH 解析。
// 不要硬编码 versions/<版本>-<构建号>：WorkBuddy 升级会换目录名（22.22.2-3 → 22.22.2-6），
// 硬编码会直接导致 spawn ENOENT，bridge 起不来，ORB 全部功能失效。
function resolveNodeExe() {
  const exe = process.platform === "win32" ? "node.exe" : "node";
  const cands = [];
  if (process.env.ORB_NODE) cands.push(process.env.ORB_NODE);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const base = path.join(home, ".workbuddy", "binaries", "node", "versions");
  try {
    for (const d of fsSync.readdirSync(base).sort().reverse()) cands.push(path.join(base, d, exe));
  } catch {}
  for (const p of cands) { try { if (p && fsSync.existsSync(p)) return p; } catch {} }
  return "node";
}
const NODE_EXE = resolveNodeExe();

/* ---- 外部依赖定位（三级解析，零硬编码）----
 * 这些组件属于宿主 WorkBuddy，装在 ~/.workbuddy/ 下。原来写死了本机用户名，
 * 打包到别的机器上必挂。现在统一三级解析：
 *   ① 环境变量（ORB_WB_HOME / ORB_VENV / ORB_BASE_PY / ORB_DSH_MCP / ORB_WB_CLI）
 *   ② 当前用户目录下的标准位置（%USERPROFILE%\.workbuddy\...）—— 换机器/换用户都对
 *   ③ 旧式 C:\Users\<用户名>\.workbuddy 兜底 —— 按当前用户推导，不写死任何用户名
 * 找不到时返回原路径，由调用方的 existsSync 检查去报错，不在这里抛。 */
const WB_HOME = process.env.ORB_WB_HOME
  || path.join(process.env.USERPROFILE || process.env.HOME || "", ".workbuddy");
const LEGACY_HOME = process.env.ORB_WB_LEGACY_HOME
  || path.join("C:\\Users", process.env.USERNAME || "", ".workbuddy");
/* 在标准位置和旧位置里找第一个存在的；都没有就返回标准位置（让上层报"找不到"） */
function pickFirst(rel, envVar) {
  if (process.env[envVar]) return process.env[envVar];
  const a = path.join(WB_HOME, rel);
  if (fsSync.existsSync(a)) return a;
  const b = path.join(LEGACY_HOME, rel);
  if (fsSync.existsSync(b)) return b;
  return a;
}

/* ---- 前台通道运行时（windows-mcp 的宿主）----
 * 全部走 orb/runtime.mjs 这个**单一真相源**，解析顺序：
 *   ORB_PY_EXE → 随包 resources/runtime/python/python.exe → ORB_BASE_PY → PATH → 不可用
 * 随包自带 embeddable CPython + 精简 site-packages（构建见 orb/native/build-runtime.ps1），
 * 所以干净机上（没装 Python、没装 WorkBuddy）前台通道也能直接起来。
 *
 * 旧行为保留在哪：下面三个名字仍然导出，供 repairFront() 那条**遗留 venv 修复路径**使用
 * （只有当解释器来自 WorkBuddy 的 venv 时才有意义；随包运行时是不可重建的，见 repairFront）。 */
const PY = resolvePython();
const BASE_PY = PY.ok ? PY.exe : "";                       // 供遗留修复路径当"基础解释器"
const VENV_DIR = PY.ok ? PY.dir : "";                      // 解释器所在目录
const VENV_PY = PY.ok ? PY.exe : "";                       // 随包运行时本身就是"那个 python"
// 阿里源实测可用；清华源对该 venv 返回 403，官方源走本机代理会 502（仅遗留修复路径用到）
const PIP_INDEX = "https://mirrors.aliyun.com/pypi/simple";
/* 前台通道的可执行文件 = 我们 spawn 的那个解释器（`-m windows_mcp` 而非 windows-mcp.exe） */
const WINDOWS_MCP = PY.ok ? PY.exe : "";
const DSH_MCP = process.env.ORB_DSH_MCP
  || pickFirst(path.join("tools", "dsh-mcp", "dist", "index.js"), "ORB_DSH_MCP");

/* ─────────── 后台 Agent CLI（CodeBuddy Code）定位 ───────────
 *
 * CodeBuddy Code CLI 是**腾讯专有软件**。开源版：
 *   · 不随仓库分发、不随发布物打包 codebuddy.exe（再分发即侵权）；
 *   · 不再兜底到任何本机绝对路径（那等于把作者机器的目录写进公共仓库，
 *     换一台机器 100% 失效，而且泄漏个人目录结构）。
 *
 * 解析顺序：
 *   ① ORB_WB_CLI 环境变量 —— 手动指向 codebuddy.exe 的全路径
 *   ② orb/local.conf 里的 wbCli —— **自用机的本地覆盖**（该文件已进 .gitignore，
 *      既不入库也不随包，所以"自用那份后台通道照常可用、发布那份路径干净"两全）
 *   ③ 系统 PATH —— Windows 用 `where codebuddy`，其它平台用 `which codebuddy`
 *   ④ 都没有 → { found:false }，由上层给出「请安装并登录」的中文提示
 *
 * 契约：**任何情况下都不抛异常、不崩溃**。后台通道不可用只影响后台任务，
 * 前台自动化 / 原生输入 / 视觉 / 语音全部照常。
 */
const WB_CLI_NAME = "codebuddy";
/** 结果缓存 30 秒：面板 5 秒轮询一次 /api/status，不能每次都去 spawn 一个 where */
const WB_CLI_CACHE_MS = 30_000;
/** @type {{at:number, value:{found:boolean, source:string, path:string, fileName:string, hint:string}|null}} */
let wbCliCache = { at: 0, value: null };
/**
 * 登录态（**不猜凭据路径、不做联网探测**，只记录最近一次真实调用的结果）：
 *   "unknown"         —— 从未成功调用过，也没被判过未登录
 *   "ok"              —— 最近一次后台调用成功
 *   "not-logged-in"   —— 最近一次后台调用被 CLI 判为未登录/未授权
 */
let wbCliAuth = "unknown";

/** 未安装：面向用户的「现象 → 怎么做」两段式文案 */
const CLI_HINT_MISSING = "未检测到 CodeBuddy CLI，后台任务不可用。"
  + "请自行安装 CodeBuddy CLI 并完成一次登录/注册（它是专有软件，本项目不随包分发）；"
  + "若已安装但不在 PATH 中，可设置环境变量 ORB_WB_CLI 指向 codebuddy.exe。"
  + "详见「使用说明 → 九、常见问题 · 后台通道」。";
/** 已安装但未登录：与「没装」严格区分，避免用户装好了还以为没装上 */
const CLI_HINT_LOGIN = "CodeBuddy CLI 已安装但尚未登录：请直接运行 codebuddy，"
  + "按提示选择登录方式并在浏览器完成认证（首次使用会引导完成注册）；"
  + "已登录过的可在会话内输入 /login 重新登录、/logout 退出，再重试后台任务。";

/**
 * 读取本地覆盖配置 `orb/local.conf`（JSON，形如 {"wbCli": "..."}）。
 *
 * 为什么要有它：自用机上 CLI 装在某个不打算公开的目录里（比如不在 PATH 中），
 * 直接写进代码/文档等于把私有路径带进开源仓库。放到 local.conf 里则永远不会入库 ——
 * 该文件已在 .gitignore 中排除，**也不在 pack.cjs 的打包清单里**。
 * 发布版没有这个文件 → 走 PATH 检测 + 优雅降级。
 *
 * 读不到、格式坏、不是对象 → 一律返回空对象，绝不抛。
 */
function readLocalConf() {
  try {
    const j = JSON.parse(fsSync.readFileSync(path.join(HERE, "local.conf"), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** 在系统 PATH 里找 codebuddy。找不到返回空串（不抛异常）。 */
function whichCodebuddy() {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "where" : "which";
    execFile(cmd, [WB_CLI_NAME], {
      timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024,
    }, (err, stdout) => {
      if (err || !stdout) return resolve("");
      const lines = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return resolve("");
      // Windows 的 where 会按 PATHEXT 一次返回 .exe/.cmd/.bat 等；优先原生可执行文件，
      // 其次才是脚本包装（两者都能起进程，但 .exe 少了 cmd 层，信号/退出码更准）。
      const exe = lines.find((l) => /\.exe$/i.test(l));
      resolve(exe || lines[0]);
    });
  });
}

/**
 * 解析后台 CLI 位置。
 * @param {boolean} refresh 为 true 时强制重查（用户装完 CLI 点「重新检测」，无需重启）。
 * @returns {Promise<{found:boolean, source:string, path:string, fileName:string, hint:string}>}
 */
async function resolveWbCli(refresh = false) {
  const now = Date.now();
  if (!refresh && wbCliCache.value && now - wbCliCache.at < WB_CLI_CACHE_MS) {
    return wbCliCache.value;
  }
  let value = { found: false, source: "none", path: "", fileName: "", hint: CLI_HINT_MISSING };
  // 显式指定：环境变量优先，其次本地覆盖文件（自用机专用，不入库）
  const fromEnv = (process.env.ORB_WB_CLI || "").trim();
  const fromConf = String(readLocalConf().wbCli || "").trim();
  const explicit = fromEnv || fromConf;
  const src = fromEnv ? "env" : "local-conf";
  if (explicit) {
    let exists = false;
    try { exists = fsSync.existsSync(explicit); } catch { exists = false; }
    value = exists
      ? { found: true, source: src, path: explicit, fileName: path.basename(explicit), hint: "" }
      : {
        found: false,
        source: src + "-missing",
        path: explicit,
        fileName: path.basename(explicit),
        hint: (fromEnv
          ? "环境变量 ORB_WB_CLI 指向的文件不存在："
          : "本地配置 orb/local.conf 的 wbCli 指向的文件不存在：")
          + explicit
          + "。请改成 codebuddy 可执行文件（Windows 下通常为 codebuddy.exe）的真实完整路径。",
      };
  } else {
    const onPath = await whichCodebuddy();
    if (onPath) {
      value = { found: true, source: "path", path: onPath, fileName: path.basename(onPath), hint: "" };
    }
  }
  wbCliCache = { at: now, value };
  return value;
}

/** /api/status 与 /api/wb-cli 共用的对外形态（路径脱敏：只暴露文件名，不暴露完整目录） */
function cliStatusPayload(cli) {
  const c = cli || { found: false, source: "none", path: "", fileName: "", hint: CLI_HINT_MISSING };
  return {
    found: !!c.found,
    source: c.source || "none",
    fileName: c.fileName || "",
    auth: wbCliAuth,
    // 已安装但最近一次被判未登录 → 给登录文案；否则给未安装文案；都没问题就空串
    hint: !c.found ? (c.hint || CLI_HINT_MISSING)
      : (wbCliAuth === "not-logged-in" ? CLI_HINT_LOGIN : ""),
  };
}

/*
 * 传给 codebuddy 子进程的环境变量。
 *
 * 桌面端 WorkBuddy 启动时会把自身服务端口写进环境变量：
 *   SERVER__PORT=<桌面端口>
 *   CODEBUDDY_SERVICE_PROXY_URL=http://127.0.0.1:<桌面端口>/...
 * 若 orb 是从桌面端派生的终端里启动的，就会继承这两个变量；codebuddy 子进程随后会
 * 试图绑定「桌面已占用的同一个端口」→ EADDRINUSE 未捕获异常秒退。
 * 这里显式剔除，确保子进程用自己的端口（与 spawnOnce 的 --port 双保险）。
 */
let cacheEnvLogged = false;
function cleanCliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.SERVER__PORT;
  delete env.CODEBUDDY_SERVICE_PROXY_URL;
  /* 一次性诊断（每个进程只记一条）：提示缓存是 CLI 的**默认行为**（1h TTL，
     请求里带 cache_retention:"long"），命令行没有开关，只能被环境变量关掉。
     若用户机器上恰好设了 CODEBUDDY_DISABLE_PROMPT_CACHING_1H=1，缓存会静默退化成
     5 分钟，而 ORB 这边一点迹象都没有 —— 至少让 orb.log 留下这一行可供排查。
     另注：走自定义模型接管（--model custom-local:*）时官方口径是 unaffected，
     那条路径不享受缓存，别拿它做速度对比。 */
  if (!cacheEnvLogged) {
    cacheEnvLogged = true;
    try {
      const off = String(env.CODEBUDDY_DISABLE_PROMPT_CACHING_1H || "").trim();
      const disabled = !!off && !/^(0|false|no|off)$/i.test(off);
      log("[cache] 提示缓存 1h " + (disabled
        ? "已关闭（CODEBUDDY_DISABLE_PROMPT_CACHING_1H=" + off + "）→ TTL 退回 5 分钟"
        : "按 CLI 默认开启（1h TTL）"));
    } catch { /* 日志失败不能影响 spawn */ }
  }
  return env;
}

/*
 * 速度开关。
 *
 * 后台慢的两个主因：
 *   1) 每次派发都是冷启动（147MB 原生进程 + 加载产品配置 / 插件 / MCP / 工具集），
 *      这是「每次开一个完整 agent」的固有开销，只能靠降低推理强度来补；
 *   2) 默认模型 hy4-preview 带推理，会先吐 reasoning token 再回答。
 *
 * 想更快就设 ORB_WB_MODEL（如 fast-model / hy3 / deepseek-v4.1-flash）；
 * ORB_WB_EFFORT 默认 low 以减少推理开销；ORB_WB_MAX_TURNS 兜住失控的多轮任务。
 */
const WB_MODEL = (process.env.ORB_WB_MODEL || "").trim();
const WB_EFFORT = (process.env.ORB_WB_EFFORT || "low").trim();
const WB_MAX_TURNS = (process.env.ORB_WB_MAX_TURNS || "").trim();

/* 后台 Agent 的运行环境约束，用 --append-system-prompt 注入。
 *
 * 为什么必须有这条：后台 CLI 在无 GUI 的前提下想「帮用户搜索」，它自己想到的
 * 办法就是 `start chrome "https://www.google.com/search?q=…"`。国内 google 打不开，
 * 用户看到的就是「地址栏里有一串字、没有结果页」，还以为是我们把搜索做坏了。
 * 这不是代码 bug，是模型不知道这台机器的网络环境 —— 所以要在系统层把事实告诉它，
 * 而不是等它每次都猜错再去改代码。
 *
 * 只写三条确定成立的事实，不教它怎么用浏览器通道（通道的上层调用方还没接，
 * 现在教了它也只会去调不存在的工具）。ORB_WB_NO_ENV_HINT=1 可关掉。 */
const WB_ENV_HINT = [
  "【本机环境约束，优先于任何默认习惯】",
  "1. 这台机器在中国大陆网络下运行：google.com、googleapis.com、youtube.com、x.com、facebook.com 通常不可访问，",
  "   不要把这些域名当作可用的搜索或结果页地址。",
  "2. 需要搜索时，只用必应中国（这台机器的浏览器默认引擎就是 Bing；换成百度会得到另一套排序和满屏推广位，",
  "   用户会认为「打开错了地方」）：",
  "   · 必应中国 https://cn.bing.com/search?q=<URL 编码后的搜索词>",
  "   · 不要用百度/搜狗/360 的搜索页，也不要退而用 google。",
  "3. 用命令行启动浏览器时，必须传完整且已编码的 URL；只传一个词会被浏览器当成地址栏输入，停在输入状态而不出结果。",
  "4. 「打开某某官网/首页」这类请求，停在搜索结果页不算完成。不确定域名时先问本机解析接口：",
  `   curl "http://127.0.0.1:${PORT}/api/resolve-site?q=<站名 URL 编码>"  → {"ok":true,"url":"https://…"}`,
  "   拿到 url 直接打开；只有接口返回 ok:false 才退回必应搜索结果页，并在回复里说明没找到官网。",
  "5. 做事顺序：命令行 / HTTP 接口 / 文件操作 优先；GUI 与视觉操作只是**兜底**，",
  "   仅在确实没有任何命令行手段时才使用。不要一开口就声明「我没有 GUI 操作能力」然后放弃 ——",
  "   先想办法用命令/接口把事办成（打开网页、调用接口、读写文件都属于命令行可达）。",
].join("\n");
const WB_ENV_HINT_ON = String(process.env.ORB_WB_NO_ENV_HINT || "") !== "1";

/* CLI 能力探测：只跑一次 `codebuddy --help`，同时判两件事。
 * ① --append-system-prompt：版本移除后带着它 spawn 会「未知选项」直接退出；
 * ② --include-partial-messages：token 级增量的前提，没有它 stream-json 只在
 *    **整条 assistant 消息写完**时吐一次，用户看到的就是「每隔一段时间蹦一段」。
 *
 * 绝不额外再起一个 147MB 进程 —— 这两项共用同一次 help 输出。
 * 判定规则保守：只有明确探到 false 才停用；未知（还没探完 / 探测本身失败）
 * 按支持处理，因为当前安装的版本确定支持，探测失败不该反过来把功能关掉。
 * ORB_WB_NO_PARTIAL=1 可一键退回旧的消息级输出，便于排障。 */
let appendPromptSupport = null;
let partialSupport = null;
const WB_PARTIAL_ON = String(process.env.ORB_WB_NO_PARTIAL || "") !== "1";
function cliWantsPartial() { return WB_PARTIAL_ON && partialSupport !== false; }

function probeCliFlags() {
  resolveWbCli(false).then((cli) => {
    if (!cli.found) return;
    execFile(cli.path, ["--help"], { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return;
        const help = String(stdout);
        appendPromptSupport = /--append-system-prompt/.test(help);
        partialSupport = /--include-partial-messages/.test(help);
        if (appendPromptSupport === false) {
          log("[wb] 当前 CLI 不支持 --append-system-prompt，环境约束不注入（搜索仍可用，只是不再提示网络环境）");
        }
        if (!partialSupport) log("[wb] 当前 CLI 不支持 --include-partial-messages，退回整条消息级流式");
      });
  }).catch(() => { /* 探测失败保持未知，不影响 spawn */ });
}

/* ---------- 常驻 daemon（可选，用来消掉冷启动） ----------
 *
 * 开启：ORB_WB_DAEMON=1
 *
 * 为什么默认不开（实测结论，2026-09-29）：
 *   POST /api/v1/runs      → {"data":{"runId":"…","status":"accepted"}}   能派发
 *   GET  /api/v1/runs/:id  → {"data":{"runId":"…","active":false}}        没有结果文本
 *   GET  /api/v1/runs/:id/stream → RUN_NOT_FOUND "already completed"     结果已丢弃
 * 即结果**拿不回来**，唯一途径是请求体里的 callback.url，
 * 而回调报文的字段名官方未文档化。
 * 因此做成可选：回调来了就用；没来 / 超时一律回落到 `-p` 子进程（现有可用路径），
 * 并把每次回调的原始报文经 logBus 结构化落盘（已脱敏），便于确认字段后固化解析。
 */
/* 开关有两个来源，任一为真即启用：
 *   1) 环境变量 ORB_WB_DAEMON=1（走 .cmd 启动时有效）
 *   2) bridge.conf 里 {"daemon": true}
 * 之所以还要看文件：桌面的 .lnk 直接拉起 electron，拿不到 .cmd 里 set 的环境变量。 */
/** 用户级配置（DATA_DIR 下），没有就退回随包那份（HERE，只读）。 */
function confFileForWrite() { return path.join(DATA_DIR, "bridge.conf"); }
function confFlag(name, dflt = false) {
  /* 读的顺序反过来：用户级优先，随包的当默认值。
     打包态装目录只读 —— 只认 HERE 的话，用户在设置里改的开关写不进去也读不回来。 */
  for (const f of [confFileForWrite(), path.join(HERE, "bridge.conf")]) {
    try {
      const j = JSON.parse(fsSync.readFileSync(f, "utf8"));
      if (j && name in j) return !!j[name];
    } catch { /* 这一份没有/坏了，看下一份 */ }
  }
  return dflt;
}

/**
 * 原子写 JSON：先写 .tmp，再 rename 到目标。
 * 直接写目标文件时，进程被强杀 / 断电会把文件截成半个 JSON —— 而所有读取点
 * 都是 `try { JSON.parse } catch { 回默认值 }`，于是**危险工具清单、白名单、
 * 触发器、积分累计（allTime）**会无声归零，用户还以为自己从来没设置过。
 * 同一分区内的 rename 是原子的：要么拿到新文件，要么还是旧文件，不存在中间态。
 */
function writeJsonAtomic(file, obj, pretty = 2) {
  const text = JSON.stringify(obj, null, pretty) + "\n";
  const tmp = file + ".tmp";
  try { fsSync.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* 目录已存在 */ }
  fsSync.writeFileSync(tmp, text, "utf8");
  fsSync.renameSync(tmp, file);
}

/** 写回 bridge.conf 的某个布尔开关（保留其它字段与注释），供控制台 UI 切换。 */
function writeConfFlag(name, value) {
  /* 写到 DATA_DIR，不是装目录：打包态 HERE 在 Program Files 下不可写，
     写那里会让「设置里切换开关」静默失败（release 版表现为开关永远不变）。 */
  const file = confFileForWrite();
  let j = {};
  try { j = JSON.parse(fsSync.readFileSync(file, "utf8")) || {}; } catch {
    /* 用户级那份还没有：以随包那份为底，第一次写的时候顺手搬到可写目录 */
    try { j = JSON.parse(fsSync.readFileSync(path.join(HERE, "bridge.conf"), "utf8")) || {}; } catch { /* 容忍缺失/损坏 */ }
  }
  j[name] = !!value;
  try { writeJsonAtomic(file, j); } catch (e) { log("[conf] 写配置失败:", e?.message ?? e); }
}

// 可变：控制台 UI 可在运行时切换（无需重启 ORB）。
let WB_DAEMON = process.env.ORB_WB_DAEMON === "1" || confFlag("daemon", false);
const WB_DAEMON_PORT = Number(process.env.ORB_WB_PORT || 19090);
// daemon 单次等待上限（等一次 run 的回调往返）。
// ⚠️ 2026-11-05 实测把默认值从 90s 降到 12s：这条 daemon 路线在本机 CLI 构建里
// **回调永远不来**，90s 只是纯空等。用户看到的是「后台执行中 … 91 秒」然后才
// 开始真正干活（随后还有 24s 的一次性进程），整单将近 100 秒，而且期间没有任何流式
// 回传 —— 因为那 90 秒里根本没有 agent 在跑。日志实证：
//   [wb-daemon] 回落到一次性子进程：后台任务在 90s 内未收到回调
//   [wb] 首字节 4086ms / 结束 24221ms
// daemon 是"锦上添花"，它的失败成本必须远小于自己省下的冷启动，否则就是负优化。
let WB_DAEMON_WAIT = Number(process.env.ORB_WB_DAEMON_WAIT || 12000);
const pendingRuns = new Map();
let daemonProc = null;
/* 站名 → 官网地址 的解析缓存：同一个站名一小时内不再问一次 Bing。
   这类查询的结果是稳定的（"湖南大学官网"不会今天指 A 明天指 B），
   缓存让第二次「打开 XX 官网」变成零网络请求。 */
const siteCache = new Map();
const SITE_CACHE_MS = 3600000;
/* 本地站点库：先翻"你自己去过的地方"，命中就是零猜测；没命中才去问搜索引擎。
   建立索引是懒加载的（首次约 250ms），之后 30 分钟刷新一次。 */
const siteLibrary = createSiteLibrary({ dir: path.join(HERE, "cache"), log });
/* 解析不到时也要缓存，但只缓存 5 分钟：既避免用户重试时反复吃 2 秒超时，
   又不至于把一次网络抖动记成"这个站永远解析不出来"。 */
const SITE_MISS_CACHE_MS = 300000;
/* 熔断：连续 N 次回调没来就本次会话内不再走 daemon。
 * 没有这个的话，用户的"热启动"开关会一直挂在那里，每单都白等 12 秒。 */
let daemonMiss = 0;
const DAEMON_MISS_LIMIT = 2;

const daemonBase = () => `http://127.0.0.1:${WB_DAEMON_PORT}`;

/* ---------- 站名 → 官网地址 ----------
 *
 * 为什么不能"取 Bing 第一条"（2026-11-05 实测翻车）：
 *   查询「湖南省官网」时 Bing RSS 的 8 条结果全是 kidscodes.cn（少儿编程 SEO 农场），
 *   取第一条就会把用户送到一个和湖南省毫无关系的招生广告页；查询「河南省官网」时
 *   第一条又是百度百科 —— 百科能查资料，但不是"官网"，点进去用户还得自己找官网链接。
 *
 * 所以改成打分挑，而不是取第一条：
 *   · 黑名单：百科/知道/知乎/贴吧/微博/豆瓣/CSDN 这类"讲某个东西"的站，永远不是官网；
 *   · 政府/教育域名（.gov.cn/.edu.cn）天然加分，这是"官网"最强的客观信号；
 *   · 首页路径、标题含站名主体、标题含"官方/官网/门户"都加分；
 *   · 同一个站霸屏（8 条里占 4 条以上）判定为 SEO 农场，换一次查询重来。
 *
 * 为什么不放在面板里：面板 CSP 只放行 127.0.0.1，发不出这个请求。
 */
/* 只拦"讲某个东西"的站：百科、问答、文档农场、维基。
 * 不拦知乎/豆瓣/哔哩哔哩这类站本身 —— 「打开哔哩哔哩官网」要的正是 bilibili.com，
 * 第一版把它们一并拉黑，结果官方站被自己拉黑，只剩微软应用商店的下载页能选。 */
const SITE_BLOCK_HOST = /^(?:baike|zhidao|baijiahao|jingyan|wenku|map|image|v|tieba)\.baidu\.com$|^(?:zhidao|wenda)\.so\.com$|^(?:www\.)?(?:wikipedia\.org|wikiwand\.com|360doc\.com|docin\.com|book118\.com|renrendoc\.com)$|^zhuanlan\.zhihu\.com$|^sm\.cn$/i;
/* 应用商店 / 下载站：内容对，但不是"这个站的官网"，用户进去还得再点一次下载。 */
const SITE_STORE_HOST = /^(?:apps|play)\.(?:microsoft|google)\.com$|^apps\.apple\.com$|^(?:www\.)?(?:softonic|coolapk|onlinedown|cr173|pconline|zol)\.com(?:\.cn)?$/i;
const SITE_ENGINE_HOST = /(^|\.)(bing\.com|baidu\.com|sogou\.com|so\.com|google\.[a-z.]+)$/i;
const SITE_OFFICIAL_TLD = /\.(gov\.cn|edu\.cn|org\.cn|ac\.cn|gov|edu)$/i;

function regDomain(host) {
  const h = String(host || "").toLowerCase();
  const p = h.split(".");
  if (p.length <= 2) return h;
  const last2 = p.slice(-2).join(".");
  /* com.cn / gov.cn / edu.cn 这类二级后缀要往前多取一段，否则 hnu.edu.cn 会被算成 edu.cn，
     "同站计数"就会把全国所有高校合并成一个站。 */
  if (/^(com|net|org|gov|edu|ac|co|bj|sh)\.(cn|hk|tw|mo)$/.test(last2)) return p.slice(-3).join(".");
  return last2;
}

function siteCore(q) {
  let s = String(q || "").trim();
  /* 「在谷歌浏览器里打开XX官网」被整句丢进来时，先把浏览器名剥掉，
     否则会拿"谷歌浏览器里打开湖南大学"去搜，搜出来全是 Chrome 教程。 */
  s = s.replace(/^(?:帮我|请|麻烦你?|给我)\s*/, "");
  s = s.replace(/^在\s*(?:谷歌浏览器|谷歌|chrome|edge|火狐|firefox|浏览器|百度|必应|bing|google)\s*(?:里|中|上)?\s*/i, "");
  s = s.replace(/^(?:打开|访问|进入|跳转到|导航到|带我到|前往|去)\s*/i, "");
  /* 后缀词要循环剥：「抖音网页版官网」先剥「官网」得「抖音网页版」，
     再剥「网页版」才是「抖音」。2026-11-08 实测：core 停在「抖音网页版」时，
     douyin.com 的标题「抖音 - 记录美好生活」不以它开头，
     siteSpamDomain 的 selfTitled 判不出来，于是把真官网当成 SEO 农场拒收。 */
  for (let i = 0; i < 4; i++) {
    const next = s.replace(/(?:的)?(?:官方网站|官网版|官网|网站|首页|网页版|网页|页面|站点|网址|手机版|电脑版|客户端|官方版|最新版|下载|入口)\s*$/i, "").trim();
    if (next === s) break;
    s = next;
  }
  return s.trim().slice(0, 40);
}

/* 这条结果是不是"在说这个单位"。只看标题：
 *   · 标题里含完整站名（"欢迎光临湖南省人民政府门户网站" 含"湖南省"）；
 *   · 或首二字与末二字都出现（"中国民用航空局" vs 站名"中国民航局" —— 全称与简称不一致，
 *     但两头都在，足以认定是同一个单位）。
 * 反例：「北京协和医学院官网」的 m.beijing.gov.cn（北京市人民政府）、
 * 「中国人民大学官网」的 www.gov.cn（中国政府网）—— 都是官方域名，但不是这个单位。 */
function siteEvidence(item, core) {
  const t = String((item && item.title) || "");
  if (!core || !t) return false;
  if (t.includes(core)) return true;
  if (core.length < 3) return false;
  /* 末字放宽到 1 个字："中国民用航空局" 与站名 "中国民航局" 连末二字都对不上（"航局" vs "空局"），
     但"中国…局"已经足够定位。首字仍要求两字，避免"北京"二字把北京市政府当成北京协和医学院。 */
  return t.includes(core.slice(0, 2)) && t.includes(core.slice(-1));
}

/* 用户点的名是不是"某个部门/业务站"（招生网、研究生院、图书馆、就业网……）。
 * 这一位决定了两个相反的处理：
 *   · 只说机构名（"华南理工大学官网"）→ 招生子站要降权、并换回 www 主页；
 *   · 点名要部门站（"华南理工大学本科招生网"）→ 恰恰要留在 admission.scut.edu.cn，
 *     降权和"同域换主页"都得让路，否则用户要招生网、我们给学校官网。 */
const SITE_DEPT_RE = /招生|研究生院|教务处|图书馆|新闻网|就业|统一身份|认证|邮件|办公|采购|招标|财务|继续教育|本科|研究生|博士|硕士/;

function siteScore(it, core) {  const host = it.host;
  if (!host) return -1e9;
  if (SITE_BLOCK_HOST.test(host)) return -1e9;
  if (SITE_ENGINE_HOST.test(host) && /\/search|\/[sS]\?|format=rss/i.test(it.url)) return -1e9;
  let s = 10;
  if (SITE_STORE_HOST.test(host)) s -= 45;
  /* 官方域名是强信号，但必须配上"这条结果确实在说这个单位"。
     否则任何一所高校的查询都可能被某个无关的 gov.cn 页面按 .gov.cn 加分顶到第一。 */
  const ev = siteEvidence(it, core);
  if (/\.gov\.cn$/i.test(host)) s += ev ? 45 : 8;
  else if (/\.edu\.cn$/i.test(host)) s += ev ? 38 : 8;
  else if (/\.(org\.cn|ac\.cn)$/i.test(host)) s += ev ? 22 : 6;
  else if (/\.(com\.cn|net\.cn|cn)$/i.test(host)) s += 6;
  try {
    const p = new URL(it.url).pathname;
    if (!p || p === "/") s += 12;
    else if (p.length > 40) s -= 8;
  } catch { /* 解析不了就当没有路径信息 */ }
  const t = String(it.title || "");
  /* 标题里站名的位置很说明问题：官网首页的标题以站名开头（"淘宝"、"湖南大学"），
     而 SEO 农场的标题是"科技特长生：湖南省……整理汇总大全"，站名被埋在中间。
     只给"开头 + 后面不长"的标题加分，避免这种页面仅凭"包含站名"就拿高分。 */
  if (core && t.trim().startsWith(core)) {
    const tail = t.trim().slice(core.length).replace(/^[\s\-_|·:：,，]+/, "");
    if (tail.length <= 8 || /官网|官方|门户|首页|网站|欢迎/.test(t)) s += 30;
    else s += 10;
  } else if (core && t.includes(core)) {
    s += 8;
  }
  if (/官方|官网|门户|首页/.test(t)) s += 14;
  /* "下载中心/客户端下载/登录入口"这类页面属于功能页，不是官网首页。
     实测「哔哩哔哩官网」会把 app.bilibili.com（哔哩哔哩下载中心）顶到 www 前面。 */
  if (/下载中心|客户端下载|下载页|入口|登录页|注册页/.test(t)) s -= 20;
  /* 院系/职能部门子站，标题里都带着自己的职能名：
     「华南理工大学官网」把 yz.scut.edu.cn（研究生招生网）排在了 www.scut.edu.cn 前面，
     因为它的标题以站名开头、又短又"像首页"。这类站是学校的一部分，不是学校本身。
     但用户点名要的就是这类站时（"…本科招生网"）不能压它的分。 */
  if (!SITE_DEPT_RE.test(core) && SITE_DEPT_RE.test(t)) s -= 25;
  /* pt.hnu.edu.cn / yz.tsinghua.edu.cn 这类业务子域经常排在首页前面，
     但用户要的是首页 —— 非 www 的多级子域降一点。 */
  const labels = host.split(".");
  if (!/^(www|www\d|m)$/i.test(labels[0]) && labels.length > regDomain(host).split(".").length) s -= 10;
  return s;
}

/* 把"我对这个结果有多确定"量化出来。上层的规矩是：≥0.8 才允许直接跳转，
 * 低于 0.8 一律不猜 —— 要么交后台核对，要么退回搜索页并说明。 */
function siteConfidence(best, core, opts = {}) {
  if (!best) return 0;
  const t = String(best.title || "").trim();
  const head = t.replace(/[\s\-_|·:：,，（(].*$/, "").trim();
  let c = 0;
  if (opts.deptSameSite) c = 0.9;
  else if (core && (head === core || t === core)) c = 0.92;
  else if (core && t.startsWith(core)) c = 0.82;
  else if (core && t.includes(core)) c = 0.66;
  else if (SITE_OFFICIAL_TLD.test(best.host) && siteEvidence(best, core)) c = 0.8;
  if (c < 0.66) return Math.round(c * 100) / 100;
  if (SITE_OFFICIAL_TLD.test(best.host)) c += 0.05;
  if (best.s >= 80) c += 0.03;
  return Math.min(0.98, Math.round(c * 100) / 100);
}

/* 一个站霸屏 = SEO 农场。正常的官网查询里，同一注册域最多出现两三次。
 * 但「淘宝官网」这种商业站，官方主站本来就会占据大半结果 —— 区分办法是看
 * 该站的标题是不是以站名开头：官网首页的 title 就是"淘宝"/"中国银行"，
 * SEO 农场的 title 是"科技特长生：湖南省……整理汇总大全"，站名埋在中间。 */
function siteSpamDomain(items, core) {
  if (items.length < 6) return "";
  const counts = new Map();
  for (const it of items) {
    const d = regDomain(it.host);
    if (!d) continue;
    counts.set(d, (counts.get(d) || 0) + 1);
  }
  let dom = "", n = 0;
  for (const [k, v] of counts) if (v > n) { dom = k; n = v; }
  if (n < 4 || !dom) return "";
  if (SITE_OFFICIAL_TLD.test(dom)) return "";
  /* 官网首页的 title 就是站名本身（"淘宝"/"中国银行"），顶多带个后缀；
     SEO 农场的 title 是"湖南省科技特长生的政策 - 少儿编程学习网"，站名只是开头几个字，
     所以要用"以站名开头 + 标题不长"两个条件一起卡。
     再放一条反向：core 比 title 长（「抖音网页版」vs「抖音」）也算自指 ——
     后缀剥离没剥干净时，别拿真官网当农场杀（2026-11-08 实际误杀 douyin.com）。 */
  const selfTitled = !!core && items.some((it) => {
    if (regDomain(it.host) !== dom) return false;
    const t = String(it.title || "").trim();
    if (!t) return false;
    if (t.startsWith(core) && t.length <= 24) return true;
    return core.length > t.length && core.startsWith(t);
  });
  return selfTitled ? "" : dom;
}

/* Bing 的 RSS 接口会偶发 ECONNRESET（实测：连续十几条查询时必然撞上几次）。
 * 一个域名失败就换另一个域名再试一次 —— 代价只有几秒的上限，
 * 而不重试的代价是"输入了正确站名却被打回搜索页"。
 * 2026-11-08 事故：串行 + 1.8 秒/host 在这台机器上连续两次超时，
 * 「抖音官网」直接被打回搜索页。改成两个 host **并行**取先到的非空结果：
 * 总耗时从 2×timeout 降到 1×timeout，成功率还翻倍。 */
const SITE_RSS_HOSTS = ["cn.bing.com", "www.bing.com"];
const SITE_RSS_TIMEOUT_MS = 3000;

async function fetchSiteRssOnce(host, q) {
  const r = await fetch(`https://${host}/search?q=` + encodeURIComponent(q) + "&format=rss&setlang=zh-CN", {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Accept": "application/rss+xml,text/xml,*/*" },
    /* 单 host 上限 3 秒：两个 host 并行，最坏也就是 3 秒 —— 宁可多等这一下，
       也不要像串行版那样"第一次超时就把用户打回搜索页"。 */
    signal: AbortSignal.timeout(SITE_RSS_TIMEOUT_MS),
  });
  const xml = await r.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    const link = (body.match(/<link>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/link>/) || [])[1] || "";
    const title = (body.match(/<title>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/title>/) || [])[1] || "";
    let p = null;
    try { p = new URL(link.trim()); } catch { continue; }
    if (!/^https?:$/.test(p.protocol)) continue;
    /* RSS 头部那几个 bing 自指链接长这样 `http://www.bing.com:80/search?q=...` ——
       带端口，字符串包含判断会漏，所以按 hostname 过滤。 */
    if (/(^|\.)bing\.com$/i.test(p.hostname)) continue;
    items.push({ url: p.href, host: p.hostname, title: title.trim() });
  }
  return items;
}

async function fetchSiteRss(q) {
  /* 并行竞速：任一 host 拿到非空结果立刻返回；全空/全挂才回落。
     全挂时抛最后一个错误（保持"上层打日志"的旧语义）。 */
  return new Promise((resolve, reject) => {
    let left = SITE_RSS_HOSTS.length;
    let lastErr = null;
    let done = false;
    for (const host of SITE_RSS_HOSTS) {
      fetchSiteRssOnce(host, q).then((items) => {
        if (done) return;
        if (items && items.length) { done = true; resolve(items); return; }
        if (--left === 0) { done = true; lastErr ? reject(lastErr) : resolve([]); }
      }).catch((err) => {
        if (done) return;
        lastErr = err;
        log(`[resolve-site] ${host} 取不到结果：${err?.message ?? err}`);
        if (--left === 0) { done = true; reject(lastErr); }
      });
    }
  });
}

function pickSite(items, core) {
  /* 同一查询里被引用最多的注册域，通常是真站（官方主站的栏目页会一起被召回）。
     实测「微信官网」：真正的 weixin.qq.com 占 6 条，而套壳站 wechatapp.com 只有 1 条，
     但两者标题都是"微信，是一个生活方式"，光看标题分不开 —— 用出现次数当旁证。
     加分封顶 +12，不足以推翻政府/教育域名的强信号。 */
  const counts = new Map();
  for (const it of items) {
    const d = regDomain(it.host);
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  }
  const score = (it) => siteScore(it, core) + Math.min(3, (counts.get(regDomain(it.host)) || 1) - 1) * 4;
  let best = null, bestScore = -1e9;
  for (const it of items) {
    const s = score(it);
    if (s > bestScore) { bestScore = s; best = it; }
  }
  if (!best || bestScore <= -1e8) return null;
  /* 同域"主页优先"：学校/机关的官网是 www.<域名>，而 yz./jw./admission./my. 都是下属站点。
     只在官方域名上这么做 —— 拿 weixin.qq.com 去换 www.qq.com 会开到腾讯门户，那是另一个站。
     用户点名要部门站（"本科招生网"）时不动 —— 那时 www 才是答错。 */
  if (SITE_OFFICIAL_TLD.test(best.host) && !SITE_DEPT_RE.test(core)) {
    const reg = regDomain(best.host);
    const home = items.find((it) => it.host === "www." + reg || it.host === reg);
    if (home && home.host !== best.host) {
      best = home;
      bestScore = Math.max(bestScore, score(home));
    }
  }
  return { url: best.url, host: best.host, title: best.title, s: bestScore };
}

/* 「打开 X 官网」要的是首页，不是某个频道页。
 * 实测「教育部官网」挑中的是 moe.gov.cn/was5/web/search?channelid=… 这种站内搜索页，
 * 「知乎」挑中的是 zhihu.com/selection/ —— 域名对、页面错，用户还得自己找首页。
 * 所以解析结果一律收回站点根（目标里写了完整路径的走不到这里，那条路直接开原 URL）。 */
function siteHomeUrl(raw) {
  try { return new URL(raw).origin + "/"; } catch { return raw; }
}

/* 把"华南理工大学本科招生网"拆成「机构 + 部门」。
 * 为什么要拆：Bing 的 RSS 对长查询几乎不按整体匹配 —— 实测「华南理工大学本科招生网」
 * 返回的是"华南地区_百度百科 / 华南金牌 / 华南师范大学"，机构名都被拆成"华南"了。
 * 拆开之后可以按"机构"先把域名找准，再在结果里找带部门词的那个子站。 */
function splitDeptName(core) {
  const m = String(core || "").match(
    /^(.{2,}?)((?:本科|研究生|博士|硕士|普通|成人|继续|网络|国际)?招生(?:信息)?(?:网|网站|办|信息网)?|研究生院|教务处|图书馆|就业(?:指导)?(?:网|中心)?|校友会|新闻网|统一身份认证)$/);
  if (!m) return null;
  const org = m[1].replace(/[的之]\s*$/, "").trim();
  const dept = m[2];
  if (org.length < 2) return null;
  /* 部门词再抽一次：'本科招生网' → '招生'，'研究生院' → '研究生院'。
     搜"机构+招生"比搜"机构+本科招生网"稳得多。 */
  const kw = /招生/.test(dept) ? "招生" : dept.replace(/(网|网站|办)$/, "");
  return { org, dept, kw };
}

/* 部门意图的打分：在通用打分之上，认"标题里有部门词"和"标题里有机构名"。 */
function deptScore(it, core, sp) {
  const t = String(it.title || "");
  const host = String(it.host || "");
  let s = siteScore(it, core);
  if (sp.kw && t.includes(sp.kw)) s += 22;
  if (t.includes(sp.org)) s += 18;
  /* 部门自己的站点，标题常常就叫"图书馆"——短到只有部门名，这正是"这是部门首页"的特征。
     而"广州国际校区图书馆 - 华南理工大学"是门户里的一个栏目页，标题里机构名齐全反而更像答案。 */
  if (sp.kw && t.trim().startsWith(sp.kw) && t.trim().length <= sp.kw.length + 6) s += 25;
  /* www2/www3 这类"第二门户"常把各部门的栏目页都挂在下面，抢分能力虚高。 */
  if (/^www\d/i.test(host)) s -= 15;
  /* "广州国际校区图书馆"是分校区/分馆，不是本部门。 */
  if (/校区|分馆|分部/.test(t)) s -= 20;
  return s;
}

/* 用户点名要某个部门/业务站（招生网、研究生院、图书馆……）。 */
async function resolveDeptSite(q, core, sp) {
  const queries = [];
  const push = (x) => { if (x && !queries.includes(x)) queries.push(x); };
  push(q);
  push(sp.org + sp.kw);
  push(sp.org + "官网");
  const tried = [];
  let best = null, bestScore = -1e9;
  /* 机构域名：部门站几乎总是挂在机构自己的域名下（lib.scut.edu.cn ⊂ scut.edu.cn）。
     只有"标题含机构名 + 官方域名"的结果才有资格定义它，免得被 SEO 站带偏。 */
  let orgReg = "";
  const pool = [];
  for (const query of queries) {
    let items = [];
    try {
      items = await fetchSiteRss(query);
    } catch (err) {
      log("[resolve-site] 查询失败：", err?.message ?? err);
    }
    tried.push(query);
    for (const it of items) pool.push(it);
    if (!orgReg) {
      let pick = null, top = -1e9;
      for (const it of items) {
        if (!SITE_OFFICIAL_TLD.test(it.host)) continue;
        if (!String(it.title || "").includes(sp.org)) continue;
        const s = siteScore(it, sp.org);
        if (s > top) { top = s; pick = it; }
      }
      if (pick) orgReg = regDomain(pick.host);
    }
    /* 这里原本有个"拿到机构名下带部门词的结果就提前收工"的短路 —— 实测会误判：
       「华南理工大学图书馆」第一条候选是 www2.scut.edu.cn（标题"图书馆 - 华南理工大学"），
       已满足短路条件，于是真正的 lib.scut.edu.cn 根本没机会出现在后面的查询里。
       所以三条查询一律跑完（单条 ~120ms，结果按站名缓存一小时）。 */
  }
  for (const it of pool) {
    const s = deptScore(it, core, sp) + (orgReg && regDomain(it.host) === orgReg ? 20 : 0);
    if (s > bestScore) { bestScore = s; best = { ...it, s }; }
  }
  const t = String((best && best.title) || "");
  const sameSite = !!best && !!orgReg && regDomain(best.host) === orgReg;
  /* 点名要部门站时，标题里必须真的出现那个部门词。
     没有这条，「华南理工大学教务处」会被 yz.scut.edu.cn（研究生招生网）拿走 ——
     它同域名、标题含机构名，唯独没有"教务处"。宁可退回搜索页，也不给一个不相干的部门。 */
  const deptOk = !sp.kw || t.includes(sp.kw) || t.trim().startsWith(sp.dept);
  if (!best || bestScore < 45 || !deptOk || (!t.includes(sp.org) && !sameSite && !siteEvidence(best, core))) {
    log(`[resolve-site] 未采纳(部门) ${JSON.stringify(q)} → ${best ? best.host + "(" + bestScore + ")" : "无"} tried=${tried.join("|")}`);
    return { url: "", tried, confidence: 0 };
  }
  /* 部门站的首页往往在子域根（admission.scut.edu.cn），但也可能挂在 www2 的某个目录下
     （…/graduate）。浅路径保留，深路径（文章页）收回站点根。 */
  let home = best.url;
  try {
    const u = new URL(best.url);
    const segs = u.pathname.split("/").filter(Boolean);
    home = (segs.length <= 2 ? u.origin + u.pathname.replace(/\/?$/, "/") : u.origin + "/");
  } catch { home = best.url; }
  const conf = siteConfidence(best, core, { deptSameSite: sameSite && deptOk });
  log(`[resolve-site] (部门) ${JSON.stringify(q)} → ${best.host}(${bestScore}, ${conf}) ${home} tried=${tried.join("|")}`);
  return { url: home, tried, confidence: conf };
}

async function resolvePlainSite(q, core) {
  let tried = [];
  let items = [];
  try {
    items = await fetchSiteRss(q);
    tried.push(q);
  } catch (err) {
    log("[resolve-site] 查询失败：", err?.message ?? err);
  }
  let best = pickSite(items, core);
  /* 该换查询重来的情况：
     1) 一条可用结果都没有；
     2) 首选分数明显偏低（<45，即没有官方域名、也不像首页）；
     3) 结果被同一个非官方站霸屏（kidscodes.cn 那种 SEO 农场）。
     第 2 条一开始写成"分数低**且**标题里没有站名"，结果「湖南省官网」漏了：
     SEO 农场的标题恰好以"湖南省"开头（"湖南省科技特长生的政策 - 少儿编程学习网"），
     于是既不算弱、也不算无标题，补救查询不触发，最后被 30 分门槛拒掉。 */
  const spam = siteSpamDomain(items, core);
  const weak = !best || best.s < 45;
  /* "官方域名但不像在说这个单位"也当作弱结果，必须换查询重来。 */
  const offTarget = !!best && SITE_OFFICIAL_TLD.test(best.host) && !siteEvidence(best, core);
  if ((!best || weak || spam || offTarget) && core && core !== q) {
    try {
      const items2 = await fetchSiteRss(core);
      tried.push(core);
      const best2 = pickSite(items2, core);
      if (best2 && (!best || best2.s > best.s)) best = best2;
    } catch (err) {
      log("[resolve-site] 补救查询失败：", err?.message ?? err);
    }
  }
  /* 官方域名或高分才算解析成功。剩下的交给面板退回搜索页 ——
     给一个明显错的地址，比停在搜索结果页更糟。 */
  if (spam && best && regDomain(best.host) === spam) {
    log(`[resolve-site] 拒收霸屏站 ${JSON.stringify(q)} → ${best.host} tried=${tried.join("|")}`);
    return { url: "", tried, spam, confidence: 0 };
  }
  /* 官方域名、但标题里找不到这个单位 —— 那是"另一个政府/学校的官网"，
     打开它比停在搜索结果页更误导。 */
  if (best && SITE_OFFICIAL_TLD.test(best.host) && !siteEvidence(best, core)) {
    log(`[resolve-site] 拒收错主体 ${JSON.stringify(q)} → ${best.host}｜${String(best.title || "").slice(0, 24)} tried=${tried.join("|")}`);
    return { url: "", tried, confidence: 0 };
  }
  if (!best || best.s < 30) {
    log(`[resolve-site] 未采纳 ${JSON.stringify(q)} → ${best ? best.host + "(" + best.s + ")" : "无"} tried=${tried.join("|")}`);
    return { url: "", tried, confidence: 0 };
  }
  const home = siteHomeUrl(best.url);
  const conf = siteConfidence(best, core);
  log(`[resolve-site] ${JSON.stringify(q)} → ${best.host}(${best.s}, ${conf}) ${home} tried=${tried.join("|")}`);
  return { url: home, tried, confidence: conf };
}

/* 名字本身可能就是域名。
 *
 * 起因（2026-11-06）：用户输入「湖南奶龙大学官网」——这不是虚构机构，
 * 而是有人真的注册了 `湖南奶龙大学.com`（IDN，punycode xn--6kr28k0gz4eq33b7r1e.com），
 * 访问后 301 到 https 站点。搜索引擎对它一无所获（返回全是 SEO 农场），
 * 但"这个域名存在"是可以用 DNS 直接验证的客观事实 —— 比任何排名都硬。
 *
 * 只在解析器已经放弃（没有 ≥0.8 的答案）时才用，绝不覆盖正规官网；
 * 而且必须有 DNS 解析 + HTTP 可达（2xx/3xx）双证据，纯 DNS 的死域名不给过。 */
async function probeDomainAlias(core) {
  const name = String(core || "").trim().replace(/\s+/g, "");
  if (name.length < 2 || name.length > 40) return null;
  if (/[，,。、；;：:！!？?（）()【】\[\]"'“”]/.test(name)) return null;
  const bare = name.replace(/^www\./i, "");
  const cands = [];
  if (name !== bare) cands.push(name);
  if (/\.[a-z]{2,}$/i.test(bare)) cands.push(bare);
  else for (const tld of ["com", "cn", "com.cn", "net"]) cands.push(`${bare}.${tld}`);
  let dns = null;
  try { dns = await import("node:dns"); } catch { return null; }
  for (const host of cands.slice(0, 4)) {
    try { await dns.promises.lookup(host, { timeout: 900 }); } catch { continue; }
    try {
      const r = await fetch("http://" + host + "/", {
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        signal: AbortSignal.timeout(1800),
      });
      if (r.status >= 400) continue;
      const url = r.status >= 300 ? (r.headers.get("location") || "http://" + host + "/") : (r.url || "http://" + host + "/");
      return { url, host, status: r.status, confidence: 0.85 };
    } catch {
      /* DNS 有解析但连不上：可能只是这台机器到该站不通（https 超时很常见）。
         给低置信度，让上层按"不猜"处理，而不是硬开一个打不开的页面。 */
      return { url: "http://" + host + "/", host, status: 0, confidence: 0.6 };
    }
  }
  return null;
}

async function resolveSite(q) {
  const core = siteCore(q) || q;
  const sp = splitDeptName(core);
  return sp ? resolveDeptSite(q, core, sp) : resolvePlainSite(q, core);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function daemonHealth() {
  try {
    const r = await fetch(daemonBase() + "/api/v1/health", {
      headers: { "X-CodeBuddy-Request": "1" },
      signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.data?.status === "ok";
  } catch { return false; }
}

/** spawn 失败是**异步**报的：spawn() 本身总是同步成功，ENOENT 走 'error' 事件。
 *  没有监听者时 EventEmitter 会把它升级成抛出，整个 bridge 立刻没了。
 *  这里统一记录，并让等待循环提前放弃（否则每次调用都白等 40 秒）。 */
let daemonSpawnErr = "";
async function ensureDaemon() {
  if (await daemonHealth()) return true;
  // CLI 不在就别试着拉进程了：spawn 一个不存在的 exe 只会得到 ENOENT 与一堆噪音日志。
  const cli = await resolveWbCli();
  if (!cli.found) { log("[wb-daemon] 跳过：", cli.hint || CLI_HINT_MISSING); return false; }
  try {
    if (daemonProc && daemonProc.exitCode === null) {
      // 已有实例正在起（并发调用）：直接进等待循环，
      // 再 spawn 一个会把上一个的引用顶掉 —— 那个进程就再也管不着了。
    } else {
      daemonSpawnErr = "";
      daemonProc = spawn(cli.path, ["--serve", "--port", String(WB_DAEMON_PORT)], {
        env: cleanCliEnv({ CODEBUDDY_GATEWAY_AUTH: "none" }),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        cwd: process.env.ORB_WB_CWD || path.join(HERE, ".."),
      });
      daemonProc.stdout.on("data", (d) => log("[wb-daemon]", String(d).trim()));
      daemonProc.stderr.on("data", (d) => log("[wb-daemon:err]", String(d).trim()));
      daemonProc.on("error", (e) => {
        daemonSpawnErr = String(e?.message ?? e);
        log("[wb-daemon] 启动异常:", daemonSpawnErr, "→", cli.path);
        daemonProc = null;
      });
      daemonProc.on("exit", (c) => { log("[wb-daemon] 退出 code =", c); daemonProc = null; });
      /* 必须进台账 + 活动进程表：漏登记的后果是"急停停不掉它"，而且 bridge 被强杀后
         reapStaleChildren 按台账回收时也看不见它 —— 那就是一个永久孤儿。 */
      try { if (daemonProc.pid) registerChild(daemonProc.pid, "daemon"); } catch {}
      try { trackProc(daemonProc); } catch {}
    }
  } catch (err) {
    log("[wb-daemon] 启动失败:", err?.message ?? err);
    return false;
  }
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (daemonSpawnErr) { daemonSpawnErr = ""; return false; }   // 起不来就别干等
    if (await daemonHealth()) { log("[wb-daemon] 就绪:", daemonBase()); return true; }
  }
  return false;
}

/** 回调字段名未知，按常见键名逐层找第一个非空文本。 */
function extractCallbackText(v, depth = 0) {
  if (!v || depth > 6) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const t = extractCallbackText(v[i], depth + 1);
      if (t) return t;
    }
    return "";
  }
  if (typeof v === "object") {
    const keys = ["text", "result", "content", "message", "output", "reply", "answer"];
    for (const k of keys) if (typeof v[k] === "string" && v[k].trim()) return v[k].trim();
    for (const k of [...keys, "data", "payload"]) {
      const t = extractCallbackText(v[k], depth + 1);
      if (t) return t;
    }
    for (const k of Object.keys(v)) {
      const t = extractCallbackText(v[k], depth + 1);
      if (t) return t;
    }
  }
  return "";
}

/* ---------- 后台 daemon（HTTP --serve，best-effort 兜底） ----------
 *
 * 实测结论（2026-09-29，对照多轮探针）：
 *   · ACP（`--acp`）：`initialize` 握手正常，但 `session/new` **永远不回**
 *     （即便显式 --port、即便用空目录 cwd 也 120s 零响应；ACP 又没有 auth/login
 *     方法，疑似鉴权死锁）。这条路在本 CLI 构建里不可用。
 *   · HTTP `--serve`：能接受 run（POST /api/v1/runs 返回 runId），但 run 始终
 *     active:false、回调**不来**、stream 报 already completed —— agent 引擎没真正执行。
 *   · 两条 daemon 路线都依赖登录态，且都会因 codebuddy 默认去绑 58449 端口、
 *     与正在运行的 WorkBuddy 桌面端冲突（EADDRINUSE 未捕获）而崩坏。
 *
 * 因此：默认且可靠的路径是 `spawnOnce`（-p 子进程，必须带 --port 避开 58449）。
 * 下面的 HTTP daemon 仅作 WB_DAEMON=1 时的 best-effort 兜底——派发成功就等回调，
 * 没来/超时一律回落到 -p 子进程，回调原始报文经 logBus 结构化落盘（已脱敏）。
 */
async function daemonRun(task, timeoutMs, model) {
  if (!(await ensureDaemon())) return null;
  const runId = randomUUID();
  const waitMs = Math.min(timeoutMs, WB_DAEMON_WAIT);
  const done = new Promise((resolve, reject) => {
    /* 超时定时器必须在**结算时也清掉**。
       原来是裸 setTimeout + 直接 resolve：回调先到的话，那个定时器会一直挂到
       waitMs（最长 90s）才空转一次 —— 每派发一次后台任务就多一个吊着的定时器。 */
    const timer = setTimeout(() => {
      if (pendingRuns.delete(runId)) {
        reject(new Error(`后台任务在 ${Math.round(waitMs / 1000)}s 内未收到回调`));
      }
    }, waitMs);
    pendingRuns.set(runId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
  });
  try {
    const r = await fetch(daemonBase() + "/api/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CodeBuddy-Request": "1" },
      body: JSON.stringify({
        id: runId, type: "message", version: "1.0",
        source: {
          platform: "generic",
          sender: { id: "orb", name: "Orb" },
          conversation: { id: runId, type: "direct" },
        },
        payload: { text: task },
        timeoutMs,
        ...(model ? { model } : {}),
        callback: { url: `http://127.0.0.1:${PORT}/api/wb-callback` },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const j = await r.json().catch(() => ({}));
    if (j?.error) throw new Error(`${j.error.code || "ERROR"}: ${j.error.message || ""}`);
    if (!j?.data?.runId) throw new Error("daemon 未返回 runId");
  } catch (err) {
    pendingRuns.delete(runId);
    log("[wb-daemon] 派发失败:", err?.message ?? err);
    return null;
  }
  return await done;
}

/*
 * DSH（DeepSeek Harness）通道 —— **历史遗留，开源版默认不注册**（见 SERVERS）。
 *
 * 为什么不注册：
 *   ① 面板早已不走 dsh（后台改走 CodeBuddy CLI），它是死功能；
 *   ② 它依赖某个具体用户家目录下的凭据与 node_modules，开源携带别人家目录
 *      既不体面，在别人机器上也永远起不来，只会白占一个 node 进程。
 * 需要它时显式设 ORB_ENABLE_DSH=1 才会注册。
 *
 * 家目录不再硬编码：默认取「当前用户」的 ~/.workbuddy/orb-dsh，可用 DSH_HOME 覆盖。
 */
const DSH_HOME = process.env.DSH_HOME || path.join(WB_HOME, "orb-dsh");
const DSH_ROOT = process.env.DSH_ROOT
  || path.join(DSH_HOME, "profiles", "node_modules", "@deepseek-ai", "node_modules", "@deepseek-ai", "dsh");

/** 从凭据文件读 key 注入环境。dsh-mcp 启动时硬性要求 DEEPSEEK_API_KEY，没有就直接退出。 */
function credentialFromHome(name) {
  if (process.env[name]) return process.env[name];
  try {
    const txt = readFileSync(path.join(DSH_HOME, ".credentials.yaml"), "utf8");
    const m = txt.match(new RegExp(name + ":\\s*([A-Za-z0-9._\\-]{16,})"));
    return m ? m[1] : "";
  } catch {
    return "";
  }
}
const DSH_API_KEY = credentialFromHome("DEEPSEEK_API_KEY");
const DSH_CSCS_KEY = credentialFromHome("CSCS_API_KEY");

const CALL_TIMEOUT_MS = Number(process.env.ORB_CALL_TIMEOUT || 120000);
const JOB_TIMEOUT_MS = Number(process.env.ORB_JOB_TIMEOUT || 1800000);
const MAX_JOBS = 60;

/*
 * 本地伪服务 "orb"。
 *
 * 为什么需要它：windows-mcp 只有 Click（等价 down+up 连发），
 * 没有把按下和抬起拆开的能力，所以「长按」「按住拖动」做不了。
 * native/orb-input.exe 用 Win32 SendInput 补齐，这里把它包装成
 * 与 MCP 一致的工具面，界面无需区分来源。
 *
 * 坐标系与 windows-mcp 的 loc 一致（物理像素）。
 */
const ORB_INPUT = process.env.ORB_INPUT_EXE
  || path.join(HERE, "native", "dist", "orb-input.exe");

function runOrbInput(argv, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile(ORB_INPUT, argv.map(String), { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || "").trim();
          return reject(new Error(`orb-input 执行失败：${detail || err.code}`));
        }
        const text = String(stdout || "").trim();
        resolve({
          content: [{ type: "text", text: text || "ok" }],
          isError: false,
        });
      });
  });
}

const clampInt = (v, lo, hi, dflt) => {
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

const LOCAL_TOOLS = {
  long_press: (a) => {
    const ms = clampInt(a.durationMs ?? a.duration, 1, 60000, 800);
    // 超时必须大于时长本身，否则 60 秒的长按会先撞 30 秒默认超时被误杀。
    return runOrbInput(["longpress",
      clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0),
      ms, a.button ?? "left"], ms + 15000);
  },
  mouse_press: (a) => runOrbInput([
    "press", clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0), a.button ?? "left",
  ]),
  mouse_release: (a) => runOrbInput(["release", a.button ?? "left"]),
  drag: (a) => {
    const ms = clampInt(a.durationMs, 0, 20000, 400);
    return runOrbInput([
      "drag",
      clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0),
      clampInt(a.x2, -100000, 100000, 0), clampInt(a.y2, -100000, 100000, 0),
      ms, a.button ?? "left"], ms + 15000);
  },
  move_to: (a) => runOrbInput([
    "move", clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0),
  ]),
  cursor_position: () => runOrbInput(["cursor"]),
  scroll_at: (a) => runOrbInput([
    "scroll", clampInt(a.x, -100000, 100000, 0), clampInt(a.y, -100000, 100000, 0),
    a.direction ?? "down", clampInt(a.clicks, 1, 100, 3),
  ]),
};

const ORB_TOOL_LIST = Object.keys(LOCAL_TOOLS);

/*
 * WorkBuddy 后台轨道。
 *
 * 原先后台派给 DeepSeek Harness（dsh-mcp），现改为直接调用 WorkBuddy 自带的
 * headless Agent CLI（CodeBuddy Code）。它就是 WorkBuddy 本体在用的那个 agent，
 * 模型 / 账号沿用 ~/.workbuddy 的配置，无需另配 key。
 *
 * 一次性执行：codebuddy -p "<task>" --output-format text
 *   （不要用 json —— 那是整段会话流水，不是回答正文）
 */
const WORKBUDDY_TOOLS = {
  // 包一层 metered：这次调用新产生的会话才算到 ORB 头上（详见 readCredits 的注释）
  /* sink = 流式正文的增量出口（见 startJob 的 partial）。
     后台任务真正耗的是 CLI 那一轮，等它跑完才回显的话，
     用户要对着「排队中」干等几十秒 —— 把已经生成的正文时不时吐出来，
     体感上的"反应速度"是另一个量级。不传就等于没有，行为与原来完全一致。 */
  workbuddy_execute: (a, timeoutMs, sink) =>
    metered(() => runWorkbuddy(String(a?.task ?? ""), timeoutMs, String(a?.model ?? ""), sink)),
  /* 人格台词批量生成（B + E 的措辞来源）。
     不进 metered：它本身就是「额外消耗」那一块，面板会单独标注成本，
     不该和「会话记账」混在一起。失败一律返回 {ok:false}，不抛。 */
  persona_bundle: (a) => runPersonaBundle(a),
  /* 把自定义接口注册进 CLI 的模型清单。面板保存配置后调一次，
     让「能不能接管后台任务」在配置阶段就有答案，而不是等派任务时才失败。 */
  cli_model_register: async () => {
    try {
      const r = await ensureCliModel();
      return { ok: true, model: r.model, warn: r.warn || "", file: CLI_MODELS_FILE };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  },
};

/** 面板用这个值表示「后台任务走用户自己的接口」。
 *  bridge 收到后先把它翻译成真正的 `custom-local:<id>`（见 ensureCliModel）。 */
const CUSTOM_ENGINE = "__custom__";

/*
 * 后台可选模型清单（供面板下拉用）。
 *
 * 这些都是 CodeBuddy CLI `--model` 支持的取值，调用走 CLI 的登录态，
 * 不需要任何 API key —— 与「视觉」槽那种要自己填 baseUrl + key 的路子是两回事。
 * 注意：WorkBuddy 云服务的免密钥通道（/.cloud/llm/chat/completions）**不能用**：
 * Origin 校验过不了，且明令禁止把它做成可被别的应用调用的代理。
 *
 * credit = 积分消耗倍率的**参考值**（2026-10-25 整理自 WorkBuddy 客户端模型菜单，
 *   格式 "×N[ · 活动标签]"）。倍率随活动（限免/夜间折扣/订阅优先）漂移，
 *   CLI 只吐模型 ID 不吐倍率，所以这里只能是带日期的参考 —— 面板上已注明
 *   "以 WorkBuddy 客户端显示为准"。新模型先上线、倍率后公布的，credit 留空，
 *   绝不编数。
 *
 * 运行时以 /api/wb-models 的**实时解析**为准（见 fetchLiveWbModels）：CLI 的
 * --model 帮助文本永远列着当前真支持的清单；本表在 CLI 不可用时兜底，
 * 并给实时清单补 label/credit 元数据。
 */
const WB_MODEL_LIST = [
  { id: "", label: "默认（跟随 CLI）", credit: "" },
  /* 模式档：快速 / 均衡 / 极致 三个 CLI 别名，倍率为模式级参考值 */
  { id: "fast-model", label: "fast-model", credit: "快速档 ×0.21" },
  { id: "balanced-model", label: "balanced-model", credit: "均衡档 ×0.65" },
  { id: "deep-model", label: "deep-model", credit: "极致档 ×1.20" },
  { id: "hy4-preview", label: "hy4-preview", credit: "均衡默认 ×0.29 · 夜间免费" },
  { id: "hy3", label: "hy3", credit: "限时免费 ×0.00" },
  { id: "hy3-x", label: "hy3-x", credit: "" },
  { id: "step-5-preview", label: "step-5-preview", credit: "独家限免 ×0.00" },
  { id: "space-bunny", label: "space-bunny", credit: "×0.08" },
  { id: "deepseek-v4.1-flash", label: "deepseek-v4.1-flash", credit: "×0.11 · 夜间折扣" },
  { id: "deepseek-v4-pro", label: "deepseek-v4-pro", credit: "" },
  { id: "glm-5.3", label: "glm-5.3", credit: "×0.69 · 订阅优先" },
  { id: "glm-5.3-flash", label: "glm-5.3-flash", credit: "×0.08" },
  { id: "glm-5.2", label: "glm-5.2", credit: "×0.79 · 夜间折扣" },
  { id: "glm-5.1", label: "glm-5.1", credit: "×0.79" },
  { id: "glm-5v-turbo", label: "glm-5v-turbo", credit: "×0.95" },
  { id: "minimax-m3.1-flash", label: "minimax-m3.1-flash", credit: "" },
  { id: "minimax-m3", label: "minimax-m3", credit: "×0.25" },
  { id: "kimi-k3.1-pro", label: "kimi-k3.1-pro", credit: "" },
  { id: "kimi-k3-1", label: "kimi-k3-1", credit: "×1.62" },
  { id: "kimi-k2.8-preview", label: "kimi-k2.8-preview", credit: "" },
  { id: "mimo-v2.6-pro", label: "mimo-v2.6-pro", credit: "" },
  { id: "custom-local:Qwen3.5", label: "自定义 · Qwen3.5（本地）", credit: "自付额度" },
  { id: "custom-local:glm-5.3", label: "自定义 · glm-5.3（本地）", credit: "自付额度" },
  { id: "custom-local:GLM 5.3-flash", label: "自定义 · GLM 5.3-flash（本地）", credit: "自付额度" },
];

/* 模型清单缓存：解析一次要 spawn CLI --help（约 1s），面板可能反复拉，缓存 5 分钟。
   面板的「更新」钮带 ?refresh=1 强制重拉。 */
const WB_MODELS_CACHE_MS = 5 * 60 * 1000;
/* 强制刷新的最小间隔：面板那个「更新」钮可以连点，而 force 会绕过缓存 ——
   不去重的话每点一次就 spawn 一个 ~147MB 的 codebuddy --help（各带 8s 超时），
   连点几下就有好几个 CLI 在后台同时跑。 */
const WB_MODELS_MIN_REFRESH_MS = 10 * 1000;
/** @type {{at:number, value:{models:Array, source:string, at:number}|null}} */
let wbModelsCache = { at: 0, value: null };
let wbModelsInflight = null;   // 在途的强制刷新（连点复用同一个 Promise）

/**
 * 从 CodeBuddy CLI 的 --help 里解析**实时**模型清单。
 * 真源：--model 选项说明里的 "Currently supported: (a, b, c...)"。
 * 没装 / 超时 / 解析失败 → null（调用方回落静态表）。任何情况下不抛。
 */
function fetchLiveWbModels() {
  return resolveWbCli(false).then((cli) => new Promise((resolve) => {
    if (!cli.found) return resolve(null);
    execFile(cli.path, ["--help"], { timeout: 8000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const text = String(stdout || "");
        const m = text.match(/Currently supported:\s*\(([^)]+)\)/);
        if (!m) return resolve(null);
        /* 按逗号切：id 里允许冒号与空格（custom-local:GLM 5.3-flash） */
        const ids = m[1].split(",").map((s) => s.trim()).filter(Boolean);
        resolve(ids.length ? ids : null);
      });
  }));
}

/**
 * 合并实时 ID 与静态元数据（label / credit），产出下拉 payload。
 * CLI 临时少列的内置项也会并上（标 source 仍为 cli，面板无所谓）。
 * 全程不抛：任何一步失败都回落静态表。
 */
async function wbModelsPayload(force = false) {
  const now = Date.now();
  if (!force && wbModelsCache.value && now - wbModelsCache.at < WB_MODELS_CACHE_MS) {
    return wbModelsCache.value;
  }
  if (force) {
    if (wbModelsInflight) return wbModelsInflight;                       // 连点：复用在途的那次
    if (wbModelsCache.value && now - wbModelsCache.at < WB_MODELS_MIN_REFRESH_MS) {
      return wbModelsCache.value;                                        // 10 秒内重复点：直接给缓存
    }
    wbModelsInflight = wbModelsBuild(now).finally(() => { wbModelsInflight = null; });
    return wbModelsInflight;
  }
  return wbModelsBuild(now);
}
async function wbModelsBuild(now) {
  const meta = new Map(WB_MODEL_LIST.map((x) => [x.id, x]));
  let models = null;
  try {
    const live = await fetchLiveWbModels();
    if (live) {
      const rows = live.map((id) => {
        const k = meta.get(id);
        return { id, label: k ? k.label : id, credit: k ? (k.credit || "") : "" };
      });
      const seen = new Set(live);
      const extras = WB_MODEL_LIST.filter((x) => !seen.has(x.id)).map((x) => ({ ...x }));
      /* ""（默认·跟随 CLI）是纯静态项：必须钉在首位。HTML select 默认选中
         第一个选项，把它甩到末尾等于把用户的默认模型悄悄换成第一个真模型。 */
      const di = extras.findIndex((x) => x.id === "");
      const def = di >= 0 ? extras.splice(di, 1)[0] : null;
      models = def ? [def, ...rows, ...extras] : [...rows, ...extras];
    }
  } catch { /* 回落静态 */ }
  const value = models
    ? { models, source: "cli", at: now }
    : { models: WB_MODEL_LIST.map((x) => ({ ...x })), source: "static", at: now };
  wbModelsCache = { at: now, value };
  return value;
}
const WORKBUDDY_TOOL_LIST = Object.keys(WORKBUDDY_TOOLS);

/**
 * 从 CLI 输出里取「回答正文」。
 * - text 格式：本身就是正文，原样返回。
 * - 若仍是 JSON：可能是 {result} 对象，也可能是整段会话数组 ——
 *   数组绝不能整段回显（否则面板会刷一大坨 JSON），
 *   优先取 type==="result" 的 result，其次取最后一条 assistant 的 output_text。
 */
function extractAnswer(out) {
  const raw = String(out || "").trim();
  if (!raw) return "";
  let j = null;
  try { j = JSON.parse(raw); } catch { return raw; }          // 非 JSON → 就是正文
  if (typeof j === "string") return j;
  if (j && typeof j.result === "string") return j.result;
  if (j && typeof j.text === "string") return j.text;
  if (Array.isArray(j)) {
    for (let i = j.length - 1; i >= 0; i--) {
      const m = j[i];
      if (m && m.type === "result" && typeof m.result === "string") return m.result;
      if (m && m.type === "message" && m.role === "assistant" && Array.isArray(m.content)) {
        const t = m.content
          .filter((c) => c && (c.type === "output_text" || c.type === "text"))
          .map((c) => c.text ?? c.output_text ?? "")
          .join("").trim();
        if (t) return t;
      }
    }
    return raw.slice(0, 2000) + "\n\n（未能从会话流水里解析出正文，已截断显示）";
  }
  return typeof j === "object" ? JSON.stringify(j).slice(0, 4000) : raw;
}

async function runWorkbuddy(task, timeoutMs = JOB_TIMEOUT_MS, model = "", sink = null) {
  // 前置校验：CLI 不在就直接给「去安装」的中文提示，绝不 spawn 一个不存在的可执行文件。
  // 这里是后台派发的唯一入口（面板 /api/call → WORKBUDDY_TOOLS.workbuddy_execute），
  // 放在最前面可以让「没装」和「没登录」走两条完全不同的文案。
  const cli = await resolveWbCli();
  if (!cli.found) throw new Error(cli.hint || CLI_HINT_MISSING);

  /* 自定义模型怎么「接管后台任务」：不是自己实现一套工具循环，而是把它注册进
     CLI 的模型清单再传 --model —— 工具编排、文件读写、MCP 全都还是 CLI 在做。
     注册失败（没配 / 被标成不支持工具调用 / 清单文件坏了）在这里直接抛，
     面板能拿到可读原因，不会静默退回默认模型去花用户的积分。 */
  const wantCustom = String(model || "").trim() === CUSTOM_ENGINE;
  const reg = wantCustom ? await ensureCliModel() : null;
  const useModel = reg ? reg.model : model;
  const engine = wantCustom ? "custom" : "cli";

  // 常驻 daemon 优先（可选开启，见 WB_DAEMON 处的实测说明）；
  // 拿不到结果就回落到一次性子进程 —— 保证后台始终有可用路径。
  // 熔断：这台机器上的 daemon 若连续两次不回回调，剩下的任务直接走 -p，
  // 不再让每单都先白等一次 WAIT（用户感知就是"点了没反应"）。
  if (WB_DAEMON && daemonMiss < DAEMON_MISS_LIMIT) {
    try {
      const text = await daemonRun(task, timeoutMs, useModel);
      if (text) { daemonMiss = 0; return { content: [{ type: "text", text }], isError: false }; }
    } catch (err) {
      daemonMiss += 1;
      log("[wb-daemon] 回落到一次性子进程：", err?.message ?? err,
        daemonMiss >= DAEMON_MISS_LIMIT
          ? "（连续 " + daemonMiss + " 次未回回调，本次会话内不再尝试 daemon；"
            + "可在状态栏把「热启动」关掉以免每次启动都白试）"
          : "");
    }
  }
  /* 进度可见：把普通后台任务也挂进 LIVE（面板每 5 秒轮询 /api/status 就能读到）。
     total=0 时面板不画步数，只显示「最近一个工具 · 已用几秒」。
     只有 LIVE 空闲时才接管，免得和正在跑的自动化回放抢同一个槽。 */
  const ownLive = !LIVE.active;
  if (ownLive) liveStart("workbuddy", String(task || "").replace(/\s+/g, " ").slice(0, 24), 0, "后台任务");
  tokBegin(engine, wantCustom ? useModel : (useModel || "").trim());
  try {
    /* 默认走流式：能拿到 tool_use 才能做过程播报。
       ORB_WB_TEXT=1 可整体退回旧的纯文本路径（排障用，行为与历史完全一致）。 */
    const r = process.env.ORB_WB_TEXT === "1"
      ? await spawnOnce(task, timeoutMs, useModel)
      : await spawnOnceStream(task, timeoutMs, useModel, "", sink);
    tokEnd(true);
    if (ownLive) liveEnd(true);
    return r;
  } catch (e) {
    tokEnd(false);
    if (ownLive) liveEnd(false, String((e && e.message) || e).slice(0, 120));
    throw e;
  }
}

/** 流式版一次性执行：--output-format stream-json + 增量消息。
 *
 *  正文怎么取：双轨。
 *   · 最终答案 text：只把**完整的 assistant 事件**里的 text 拼起来。这是最稳的一条 ——
 *     不依赖 result 事件里叫什么字段，也不受 CLI 版本改动影响；万一哪天事件形状变了，
 *     只要还有 assistant 文本就有内容，不会把整个后台通道弄哑。
 *   · 实时预览 preview：--include-partial-messages 推来的 content_block_delta 逐块
 *     累加，只用于推给面板（sink(text + preview)），**不进最终答案**。完整消息到达时
 *     text 收下整段、preview 清零，两边不重复；收尾时 commitPreview 兜底，
 *     保证「只给增量不给完整消息」的实现也不会交出空答案。
 *
 *  真要出问题，用 ORB_WB_NO_PARTIAL=1 退回消息级输出，或 ORB_WB_TEXT=1 整体退回 spawnOnce。
 *
 *  顺带把每个 tool_use 的名字写进 LIVE.lastTool，供面板做过程播报。
 */

/* ==== WB_PARTIAL_START ====
 * 流式正文状态机（纯函数、零副作用）。按标记抽出来由 test/wbStreamPartial.test.mjs 独立跑。
 *
 * 为什么要单独一层：开启 --include-partial-messages 后，同一个 token 可能出现两次 ——
 * 先在 content_block_delta 里，后在完整的 assistant 消息里。直接在解析回调里
 * 两边都 `text +=` 会把答案翻倍；只认增量又怕某些 CLI 版本不给完整消息、最后交空答案。
 *
 * 契约：
 *   · text    —— 最终答案，只由完整 assistant 消息提交；
 *   · preview —— 当前消息尚未提交的增量，只用于推给面板，不进 text；
 *   · 完整消息到达：text += 整段，preview 清零（面板看到的内容连续、不回退）；
 *   · 收尾由调用方 commitPreview() 兜底：只给增量时把残留预览并进 text。
 */
function applyStreamEvent(state, ev) {
  const out = {
    text: String((state && state.text) || ""),
    preview: String((state && state.preview) || ""),
    partialSeen: !!(state && state.partialSeen),
    chunk: "",        // 本次新增的增量文本（决定要不要推一次 sink）
    committed: false, // 发生了完整消息提交（调用方据此强制推一次）
    toolUses: [],
    isResult: false,
    usage: null,
    errors: [],
  };
  if (!ev || typeof ev !== "object") return out;
  /* stream_event 是外层包装，真事件在 .event 里；没有 .event 就当它自己是真的。 */
  let e = ev;
  if (e.type === "stream_event" && e.event && typeof e.event === "object") e = e.event;
  const t = e.type;

  // ① 文本增量：只认 text_delta，thinking_delta / input_json_delta 一律不进正文
  /* 兼容三种外壳：裸 content_block_delta、裸 text_delta、以及没带 .event 的
     stream_event 自身裹着 delta（不同 CLI 版本见过不止一种）。 */
  if (t === "content_block_delta" || t === "text_delta" || t === "stream_event") {
    const d = (e.delta && typeof e.delta === "object") ? e.delta : {};
    let chunk = null;
    if ((t === "content_block_delta" || t === "stream_event")
      && (d.type === "text_delta" || !d.type) && typeof d.text === "string") chunk = d.text;
    else if (t === "text_delta" && typeof e.text === "string") chunk = e.text;
    if (chunk) { out.preview += chunk; out.partialSeen = true; out.chunk = chunk; }
    return out;
  }

  // ② 完整 assistant 消息：提交整段、清预览；工具名照旧留给过程播报
  if (t === "assistant" && e.message && Array.isArray(e.message.content)) {
    for (const c of e.message.content) {
      if (!c) continue;
      if (c.type === "text" && typeof c.text === "string") {
        out.text += c.text;
        if (out.partialSeen) { out.preview = ""; out.partialSeen = false; }
        out.committed = true;
      } else if (c.type === "tool_use" && c.name) {
        out.toolUses.push(String(c.name));
      }
    }
    return out;
  }

  // ③ result：整轮累计用量在这里，assistant 事件上的 usage 全是 0 或占位
  if (t === "result") {
    out.isResult = true;
    out.usage = e.usage || null;
    if (e.is_error && Array.isArray(e.errors)) out.errors = e.errors.slice();
    return out;
  }
  return out;
}

/** 收尾兜底：把尚未提交的预览并进最终答案。 */
function commitStreamPreview(state) {
  return {
    text: String((state && state.text) || "") + String((state && state.preview) || ""),
    preview: "",
    partialSeen: false,
  };
}
/* ==== WB_PARTIAL_END ==== */

/* ---------------- 接口级拒绝 ≠ 任务结果 ----------------
 * 真实故障（2026-11-05）：后台任务跑完 91 秒，模型侧已限流，CLI 把
 * 「429 您的使用量已超出频率限制，将在 … 重置」当成**模型正文**回吐。
 * 旧逻辑只看「正文非空」，于是面板显示「后台完成：429 …」、人格再补一句
 * 「搞定了」—— 用户被界面和语音双重误导，还以为任务真做完了。
 *
 * 现在分三层处理：
 *   ① 流式过程中一旦认出这句是接口拒绝 → 立刻杀进程（不再白等 100 秒）；
 *   ② 收尾时正文 / result 事件判成接口拒绝 → 抛错（job 记 error，不走成功分支）；
 *   ③ 面板侧再兜一层（见 panel.html 的 looksLikeProviderError）。
 *
 * 误伤防线：不接受"正文里顺带提到 429"这种情形 —— 必须
 *   要么 result 事件自己标了 is_error，要么这句落在正文开头 60 字内且全文很短。 */
const FATAL_PROVIDER_RE = /(\b429\b[^\n]{0,60}(频率|限流|rate[\s_-]?limit|too many requests|使用量已超出|请求过于频繁|稍后重试|重置)|(频率|限流|请求过于频繁)[^\n]{0,30}\b429\b|rate[\s_-]?limit|too many requests|insufficient_quota|quota exceeded|额度(不足|已用尽|已超出|已用完)|用量已超出|invalid[_ ]api[_ ]key|\b401\b[^\n]{0,40}(unauthorized|invalid|未授权|鉴权)|unauthorized|API key[^\n]{0,30}(invalid|expired|无效|过期))/i;
const FATAL_MAX_LEN = 400;

function fatalProviderText(text, resultIsError) {
  const s = String(text || "").trim();
  if (!s) return "";
  const m = s.match(FATAL_PROVIDER_RE);
  if (!m) return "";
  const atFront = (m.index || 0) <= 60;
  if (!resultIsError && !(atFront && s.length <= FATAL_MAX_LEN)) return "";
  return m[0];
}

/** 把接口原文翻成"用户能照着做"的一句话。 */
function fatalProviderMessage(raw, fallbackDetail) {
  const s = String(raw || "") + "\n" + String(fallbackDetail || "");
  const reset = s.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  const when = reset ? `${reset[1]} ${reset[2]}` : "";
  if (/\b429\b|rate[\s_-]?limit|too many requests|频率|限流|用量已超出/i.test(s)) {
    return "模型调用被限流（429）：额度已用完或请求过快，这次任务没有做成。"
      + (when ? `额度预计 ${when} 重置。` : "")
      + "可以先在「后台模型」里换一个模型再试。";
  }
  if (/401|unauthorized|invalid[_ ]api[_ ]key|鉴权|API key[^\n]{0,20}(无效|过期)/i.test(s)) {
    return "模型接口鉴权失败（401）：Key 无效或已过期，这次任务没有做成。"
      + "请到「后台模型 › 自定义 API」重填 Key 后再派一次。";
  }
  return "模型接口拒绝了这次调用（额度或配额问题），任务没有做成。换模型或稍后重试。";
}

function spawnOnceStream(task, timeoutMs, model, cliPath = "", sink = null) {
  return new Promise(async (resolve, reject) => {
    if (!task.trim()) return reject(new Error("workbuddy_execute 需要一个 task 参数"));
    const cli = await resolveWbCli();
    if (!cli.found) return reject(new Error(cli.hint || CLI_HINT_MISSING));
    const cliExe = cliPath || cli.path;
    const port = await freePort();
    const viaNode = /\.(m?js)$/i.test(cliExe);
    const file = viaNode ? NODE_EXE : cliExe;
    const argv = [
      ...(viaNode ? [cliExe] : []),
      "-p", task,
      "--port", String(port),
      "--output-format", "stream-json",
      /* token 级增量：不开这个开关时，stream-json 只在整条 assistant 消息**写完**
         才吐一行，面板就是「隔十几秒蹦一整段」。开了之后 CLI 会额外推
         stream_event / content_block_delta，onLine 把它们逐块接进预览文本。
         --verbose 是这套原始 SSE 增量在 print 模式下的前置开关（本机 CLI 的
         --help 明确列出两者）。能力探测判不支持时自动退回旧的消息级输出。 */
      ...(cliWantsPartial() ? ["--include-partial-messages", "--verbose"] : []),
      // 后台无人值守，不能卡在权限确认上
      "--permission-mode", "bypassPermissions",
      ...(WB_ENV_HINT_ON && appendPromptSupport !== false ? ["--append-system-prompt", WB_ENV_HINT] : []),
      ...((model || WB_MODEL).trim() ? ["--model", (model || WB_MODEL).trim()] : []),
      ...(WB_EFFORT ? ["--effort", WB_EFFORT] : []),
      ...(WB_MAX_TURNS ? ["--max-turns", WB_MAX_TURNS] : []),
    ];

    let child;
    try {
      child = spawn(file, argv, {
        windowsHide: true,
        env: cleanCliEnv(),
        cwd: process.env.ORB_WB_CWD || path.join(HERE, ".."),
      });
    } catch (e) {
      return reject(e);
    }
    trackProc(child);
    registerChild(child.pid, "cli");

    /* 开启增量后 stdout 里多的是每个 delta 的事件元数据（不只是正文本身），
       行数可能比旧的消息级输出高两个数量级。上限从 8MB 放宽到 32MB，
       否则长回答会在半路被 MAX_BYTES 误杀，表现成「跑到一半突然没结果」。 */
    const MAX_BYTES = 32 * 1024 * 1024;
    let text = "";       // 最终答案：只由完整的 assistant 消息提交，绝不重复累加
    let preview = "";    // 当前消息尚未提交的增量文本，只用于实时预览推送
    let partialSeen = false;
    let stderr = "";
    let bytes = 0;
    let buf = "";
    let done = false;
    let timedOut = false;
    let toolSeen = 0;
    let lastSinkPush = 0;
    /* 接口级拒绝：一旦认出就把原文留在这里，并在流式途中直接杀进程。
       resultIsError 来自 CLI 的 result 事件，是比正文匹配更硬的信号。 */
    let fatalRaw = "";
    let resultIsError = false;
    /* 耗时分解：用户抱怨「反应慢」时，必须能分清是 CLI 冷启动、还是模型生成。
       不记这三个数，任何优化都是瞎猜。 */
    const tSpawn = Date.now();
    let firstByteMs = 0;
    /* 增量推送节流：350ms 是给「整条消息级」输出定的（约 3 次/秒），
       套在 token 级增量上就还是「每隔一段时间蹦一段」。100ms ≈ 10 帧/秒，
       面板侧已有 rAF 批量 + 增量追加，不会把渲染主线程压垮。 */
    const SINK_PUSH_MS = cliWantsPartial() ? 100 : 350;
    const sinkPush = (force) => {
      if (!sink) return;
      const now = Date.now();
      if (!force && now - lastSinkPush < SINK_PUSH_MS) return;
      lastSinkPush = now;
      /* 预览只进推送、不进最终答案：完整 assistant 消息到达时会把它提交成 text，
         这样两边不会把同一段字算两遍，面板看到的也是连续不回退的一段。 */
      try { sink(text + preview); } catch {}
    };
    /* 兜底提交：万一某个 CLI 版本只给增量、不给完整 assistant 消息，
       收尾时把残留预览并进最终答案，保证「有输出就该有结果」。
       合并规则与上面同源，走纯函数 commitStreamPreview。 */
    const commitPreview = () => {
      const r = commitStreamPreview({ text, preview, partialSeen });
      text = r.text; preview = r.preview; partialSeen = r.partialSeen;
    };

    /* execFile 的 timeout 只杀父进程，孙进程会成孤儿；这里自己计时 + 树杀 */
    const timer = setTimeout(() => { timedOut = true; killProcTree(child); }, timeoutMs);

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      /* 接口拒绝优先于"正文非空 = 成功"这条老判定 —— 否则限流提示会被
         当成任务结果交付（面板显示「后台完成：429 …」，人格还说"搞定了"）。 */
      if (fatalRaw) {
        const msg = fatalProviderMessage(fatalRaw, stderr);
        log("[wb] 接口拒绝，判失败：" + msg);
        return reject(new Error(msg));
      }
      const out = text.trim();
      const exit = classifyCliExit(err, out);
      const fatalInAnswer = fatalProviderText(out, resultIsError);
      if (fatalInAnswer) {
        const msg = fatalProviderMessage(fatalInAnswer, stderr);
        log("[wb] 正文即接口拒绝，判失败：" + msg);
        return reject(new Error(msg));
      }
      /* 失败诚实：非零退出码优先于「正文非空」。半段结果必须如实上报，
       * 不能让面板显示「后台完成」、人格再补一句「搞定了」。 */
      if (exit.failed) {
        const msg = cliExitMessage(exit);
        log("[wb] " + msg);
        const e = new Error(msg);
        e.exitCode = exit.exitCode;
        e.partialOutput = exit.partialOutput;
        return reject(e);
      }
      if (out) {
        wbCliAuth = "ok";
        return resolve({ content: [{ type: "text", text: extractAnswer(out) }], isError: false, exitCode: exit.exitCode });
      }
      const detail = String(stderr || (err && err.message) || "").trim();
      if (/Authentication required|Please use \/login|not logged in|unauthorized/i.test(detail)) {
        wbCliAuth = "not-logged-in";
        return reject(new Error(CLI_HINT_LOGIN));
      }
      /* 用了自定义模型时，CLI 的报错基本都是「清单里没这条 / url 没配」，
         原文是英文且不知道怎么办，转成能照着做的提示。 */
      const hint = cliModelHint(detail);
      if (hint) return reject(new Error(hint));
      if (timedOut) return reject(new Error("CodeBuddy CLI 超时（" + Math.round(timeoutMs / 1000) + " 秒）"));
      return reject(new Error(`CodeBuddy CLI 无输出：${detail || "exit " + ((err && err.code) ?? "?")}`));
    };

    /* 解析回调只负责把状态机结果落回局部变量 + 发副作用；
       文本合并规则全在 applyStreamEvent（WB_PARTIAL_START 段），可独立单测。 */
    const onLine = (line) => {
      const s = line.trim();
      if (!s || s.charCodeAt(0) !== 123) return;      // 只吃 JSON 行
      let ev;
      try { ev = JSON.parse(s); } catch { return; }
      const r = applyStreamEvent({ text, preview, partialSeen }, ev);
      text = r.text; preview = r.preview; partialSeen = r.partialSeen;

      if (r.chunk) {
        sinkPush(false);
        /* 接口拒绝也可能先出现在增量里：识别到就立刻杀进程，别白等 90 秒。 */
        if (!fatalRaw) {
          const hit = fatalProviderText(text + preview, false);
          if (hit) {
            fatalRaw = text + preview;
            log("[wb] 流式识别到接口拒绝（" + hit.slice(0, 40) + "），立即停止 CLI");
            try { killProcTree(child); } catch {}
          }
        }
      }
      if (r.committed) {
        sinkPush(true);   // 提交这一帧必须推，别被节流吞掉
        /* 流式就认出来：这句不是任务结果，是接口拒绝。
           立刻杀掉 CLI —— 限流不会因为再跑 90 秒而自愈，
           白等只会让用户以为"还在努力"。 */
        if (!fatalRaw) {
          const hit = fatalProviderText(text, false);
          if (hit) {
            fatalRaw = text;
            log("[wb] 流式识别到接口拒绝（" + hit.slice(0, 40) + "），立即停止 CLI");
            try { killProcTree(child); } catch {}
          }
        }
      }
      for (const name of r.toolUses) {
        toolSeen += 1;
        if (LIVE.active) liveStep(toolSeen, name);
      }
      if (r.isResult) {
        /* 整轮累计用量就在这里（assistant 事件上的 usage 全是 0 或占位）。
           自定义模型也照给，所以两种引擎同一条取数路径。 */
        if (r.usage) tokAddTask(r.usage);
        if (r.errors.length) stderr += r.errors.join("\n") + "\n";
      }
    };

    child.stdout.on("data", (d) => {
      if (!firstByteMs) {
        firstByteMs = Date.now() - tSpawn;
        /* 首字节 = 冷启动（拉起 CLI + 完成鉴权/建连）+ 首 token。这个数一出来，
           「慢在壳还是慢在模型」就不用再猜了。 */
        log("[wb] 首字节 " + firstByteMs + "ms（含冷启动）");
      }
      bytes += d.length;
      if (bytes > MAX_BYTES) { try { killProcTree(child); } catch {} return; }
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code, sig) => {
      if (buf) { onLine(buf); buf = ""; }
      commitPreview();   // 只给增量、不给完整消息的实现在这里兜底，别让答案变空
      sinkPush(true);   // 收尾再推一次，确保最后一段不丢
      log("[wb] 结束 " + (Date.now() - tSpawn) + "ms，首字节 " + (firstByteMs || 0)
        + "ms，工具 " + toolSeen + " 次，正文 " + text.length + " 字");
      finish(sig || code ? { code, signal: sig } : null);
    });
  });
}

/* ---------------- 后台 CLI 预热 ----------------
 * Windows 上这个 CLI 每次冷启动都要重新映射一批 DLL，二次启动明显更快（二进制与依赖
 * 已进系统文件缓存）。这里在桥起来之后延迟跑一次极短调用，把这份固定成本摊到用户
 * 开口之前 —— 代价是一次几百 token 的空调用。
 *
 * 为什么不用 daemon（--serve 常驻）：实测那条路会先等约 90s 回调、不来再回落 -p，
 * 反而更慢（见 bridge.conf 的 _daemon_note）。预热是同一目标下更笨但不会倒退的做法。
 * 常驻单进程（--input-format stream-json 连发多轮）也实测过：那条路径不走 -p 的鉴权，
 * 第一轮就回 "Authentication required / Please use /login"，本轮直接不可用。
 *
 * 现在有两处触发：① 桥起来 8 秒后自动一次；② 面板唤出 / 输入框聚焦时按需再热一次
 * （带 TTL，见 PREWARM_TTL_MS）—— 用户打字的那几秒正好把 2.5 秒启动成本摊掉。
 * ORB_WB_PREWARM=0 关闭；若此刻已有真实任务在跑就直接跳过，绝不叠加。 */
const PREWARM_TTL_MS = 180000;      // 3 分钟内热过就不再重复
let cliPrewarmAt = 0;
let cliPrewarming = false;
function prewarmCli(force = false) {
  if (String(process.env.ORB_WB_PREWARM || "") === "0") return;
  if (LIVE.active || cliPrewarming) return;
  const now = Date.now();
  if (!force && cliPrewarmAt && now - cliPrewarmAt < PREWARM_TTL_MS) return;
  cliPrewarmAt = now;
  cliPrewarming = true;
  (async () => {
    try {
      const cli = await resolveWbCli();
      if (!cli.found) return;
      const viaNode = /\.(m?js)$/i.test(cli.path);
      const t0 = Date.now();
      const child = spawn(viaNode ? NODE_EXE : cli.path, [
        ...(viaNode ? [cli.path] : []),
        "-p", "ok",
        "--output-format", "stream-json",
        "--permission-mode", "bypassPermissions",
      ], { windowsHide: true, stdio: ["ignore", "ignore", "ignore"], env: cleanCliEnv() });
      child.on("error", () => {});
      const t = setTimeout(() => { try { killProcTree(child); } catch {} }, 90000);
      if (t && typeof t.unref === "function") t.unref();
      child.on("close", () => {
        clearTimeout(t);
        cliPrewarming = false;
        log("[wb] 预热完成 " + (Date.now() - t0) + "ms（之后的任务省掉冷启动）");
      });
    } catch { cliPrewarming = false; }
  })();
}

/* ---------------- 人格台词批量生成（B + E 的措辞来源） ----------------
 * 一次调用拿到整轮要用的台词：过程三句 + 成功一句 + 失败一句。
 * 成本等同「结尾现编一次」，却能让整个过程都有这个人自己的说法 ——
 * 这是比「每句现调一次」便宜一个数量级的关键。
 *
 * 分工铁律：**事实由面板给，模型只负责措辞**。它不知道任务里发生了什么，
 * 所以过程句只能用泛化动作，不许出现具体文件名或行号（那些由 E 的规则层补）。
 * 任何失败都返回 {ok:false}，由面板退回预定台词，绝不抛给调用方。
 */
const PERSONA_TASK_MAX = 200;

function buildPersonaPrompt(a) {
  const spec = a && a.spec && typeof a.spec === "object" ? a.spec : {};
  const L = [];
  L.push("你现在只需要「说话」：不要调用任何工具、不要执行任务、不要读文件。");
  L.push("");
  L.push("[当前人格] " + String(spec.name || "元气开心果"));
  if (spec.mechanism) L.push("[性格内核] " + String(spec.mechanism));
  L.push("[语言规则] " + String(spec.rules || "句长 10~18 字；口语；不啰嗦。"));
  L.push("[禁止] " + String(spec.bans || "不讽刺、不说教、不自贬。"));
  if (Array.isArray(spec.samples) && spec.samples.length) {
    L.push("[说话方式参考，不要照抄] " + spec.samples.join(" ／ "));
  }
  if (spec.actions) {
    /* 动作语言：一句末尾用全角括号补一个动作（「做好了…辛苦你啦。（轻轻笑了笑）」）。
       它不占口播时长，却让人"看见"这个人在做什么 —— 是这类陪伴角色最省字的一招。
       与颜文字**可以同时出现**，但顺序固定：正文 → 颜文字 →（动作）。
       颜文字是语气，动作是舞台指示，两个各管一段，叠起来也不会读成字幕。 */
    L.push("[动作] 每句末尾用一个全角括号括一个动作，例如（轻轻笑了笑）。只许一个，"
      + "放在句子最末；允许与颜文字同现，但颜文字必须排在动作之前；"
      + "动作不计入上面的字数限制；失败与深夜只许用收着做的动作。"
      + "从这些里挑或按同样风格自造：" + String(spec.actions));
  }
  L.push("");
  L.push("[本次任务] " + String((a && a.task) || "").slice(0, PERSONA_TASK_MAX));
  L.push("");
  L.push("一次生成四段，严格按下面的 JSON 输出，不要解释、不要代码块：");
  L.push('{"steps":["…","…","…"],"done":"…","fail":"…"}');
  L.push("steps：任务执行中说的三句，每句不超过 18 字，只说「正在做的事」；不知道具体文件名就不要编；");
  L.push("done：成功后收尾一句；");
  L.push("fail：失败后一句 —— 先承认这确实让人挫败，再给一个具体的小肯定；禁止说「没事」「小问题」「别想太多」。");
  return L.join("\n");
}

function parsePersonaJson(raw) {
  const s = String(raw || "");
  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  let o;
  try { o = JSON.parse(s.slice(i, j + 1)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const arr = Array.isArray(o.steps) ? o.steps : [];
  const steps = arr
    .filter((x) => typeof x === "string" && x.trim())
    .slice(0, 4)
    .map((x) => x.trim().slice(0, 60));
  const done = typeof o.done === "string" ? o.done.trim().slice(0, 80) : "";
  const fail = typeof o.fail === "string" ? o.fail.trim().slice(0, 80) : "";
  if (!steps.length && !done && !fail) return null;
  return { steps, done, fail };
}

/** 调用户自己填的 OpenAI 兼容接口。这是一条「纯说话」的旁路 ——
 *  要让它干活走的是 CLI 的 custom-local 通道（见 ensureCliModel）。 */
async function callCustomChat(custom, sys, usr, timeoutMs, opts) {
  const base = String(custom.baseUrl || "").replace(/\/+$/, "");
  if (!base || !custom.key || !custom.model) throw new Error("自定义模型配置不完整");
  const url = /\/chat\/completions$/i.test(base) ? base : base + "/chat/completions";
  /* opts 只给"翻译"这类要稳定输出、可能偏长的旁路用；
     台词那一路不传，行为与原来完全一致（温度 0.75 / 500 tokens）。 */
  const temperature = (opts && typeof opts.temperature === "number") ? opts.temperature : 0.75;
  const maxTokens = (opts && Number(opts.maxTokens)) || 500;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + custom.key },
    body: JSON.stringify({
      model: custom.model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: usr },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let t = "";
    try { t = (await res.text()).slice(0, 160); } catch {}
    throw new Error("HTTP " + res.status + (t ? " " + t : ""));
  }
  const j = await res.json();
  const t = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof t !== "string" || !t.trim()) throw new Error("自定义模型返回空内容");
  /* 顺手把 usage 带出去：人格台词这部分消耗要算进「本次任务」的账里，
     不能让它在面板上变成一笔看不见的支出。 */
  const usage = j && j.usage && typeof j.usage === "object"
    ? { input_tokens: Number(j.usage.prompt_tokens) || 0, output_tokens: Number(j.usage.completion_tokens) || 0 }
    : null;
  return { text: t, usage };
}

/** 读主进程写入的自定义模型配置（路径由 main.js 通过 ORB_CM_FILE 注入）。
 *  走文件而不是走参数：明文 key 因此永远不进渲染层、也不经过本地 HTTP。 */
function readCustomModel() {
  const f = process.env.ORB_CM_FILE;
  if (!f) return null;
  try {
    const o = JSON.parse(fsSync.readFileSync(f, "utf8")) || {};
    if (!o.baseUrl || !o.key || !o.model) return null;
    return {
      baseUrl: String(o.baseUrl),
      key: String(o.key),
      model: String(o.model),
      name: String(o.name || ""),
      /* 缺字段按 true 处理：绝大多数 OpenAI 兼容接口都支持 function calling，
         真不支持的会被 CLI 那侧暴露出来（模型只顾说话、不动工具），比拦在门口好排查。 */
      supportsToolCall: o.supportsToolCall !== false,
    };
  } catch {
    return null;
  }
}

/* ══════════ 把自定义接口注册进 CLI 的模型清单 ══════════
 *
 * 关键事实（2026-10-28 实测，别再另写一套执行链了）：
 *   CodeBuddy CLI 会读 `~/.workbuddy/models.json`，把里面每一条都暴露成
 *   `custom-local:<id>` 交给 `--model`；而且**走的是那条记录里的 apiKey，
 *   不需要 CLI 登录态**（实测：`-p` 默认模型报 Authentication required，
 *   换成 custom-local:Qwen3.5 直接返回结果）。
 *
 * 所以「让自定义模型接管后台任务」= 注册一条记录 + 传 --model。
 * 读写文件、跑命令、MCP 工具编排全部还是 CLI 在做，能力不打折；
 * 自己实现一套工具循环只会把「能干的事」做少，还要重接急停/审计/危险确认。
 *
 * 写的是 WorkBuddy 自己的配置文件，所以规矩很严：
 *   · 只增删 `vendor` 等于 ORB_CONTROL_VENDOR 的条目，用户自己的一个字段都不碰；
 *   · 原文件不是合法 JSON 就**拒绝写入**（宁可这次任务失败，也不能毁掉用户的模型清单）；
 *   · 写前备份一份 .orb-bak，原子写避免半截文件。
 */
const ORB_CONTROL_VENDOR = "ORB 控制台";

/* 这个路径必须和 CLI 自己算出来的一模一样，否则会「写在一处、CLI 读另一处」，
   表现就是日志里那句 has no endpoint url configured。
   CLI 的取法（从二进制里抠出来的，见 getUserConfigPath）：
     有 WORKBUDDY_CONFIG_DIR / CODEBUDDY_CONFIG_DIR → <它>/models.json
     否则 → <home>/.workbuddy/models.json
   ORB_CLI_MODELS 只是给单测改道用的，正式运行不要碰。 */
const CLI_CONF_DIR = String(process.env.WORKBUDDY_CONFIG_DIR || process.env.CODEBUDDY_CONFIG_DIR || "").trim();
const CLI_MODELS_FILE = process.env.ORB_CLI_MODELS
  || path.join(CLI_CONF_DIR || path.join(process.env.USERPROFILE || process.env.HOME || "", ".workbuddy"), "models.json");

/** id 就是**发给接口的 model 名** —— 这一点是从 CLI 二进制里抠出来的：
 *
 *    if ($E && ml) { let iE = stripCustomLocalModelPrefix(ml); if (iE !== ml && $E.model === ml) $E.model = iE }
 *
 *  也就是说 `--model custom-local:<id>` 里的前缀会被剥掉，剩下的**原样**当请求体的
 *  model 发出去（实测：清单里 id 写 ORB-接管测试，接口收到的 model 就是 ORB-接管测试）。
 *  所以这里绝不能加前缀、绝不能美化 —— 加一个字母，接口就找不到模型。
 *  唯一允许的改动是掐掉换行/制表符（会破坏 JSON 与 argv）。 */
function cliModelIdFor(custom) {
  return String(custom.model || custom.name || "").replace(/[\r\n\t]+/g, " ").trim();
}

/** 读模型清单。missing / corrupt 必须分开 —— 混成一个「空数组」就会把用户的配置清空。 */
function readCliModels() {
  if (!CLI_MODELS_FILE) return { arr: [], missing: true, corrupt: false, wrap: null };
  if (!fsSync.existsSync(CLI_MODELS_FILE)) return { arr: [], missing: true, corrupt: false, wrap: null };
  try {
    const j = JSON.parse(fsSync.readFileSync(CLI_MODELS_FILE, "utf8"));
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.models) ? j.models : null);
    if (!arr) return { arr: [], missing: false, corrupt: true, wrap: null };
    /* 现版本 CLI 的清单是裸数组；万一哪天改成 {models:[...]} 的外壳，
       也要按原形状写回去，不能把人家的外壳拆掉。 */
    return { arr, missing: false, corrupt: false, wrap: Array.isArray(j) ? null : j };
  } catch {
    return { arr: [], missing: false, corrupt: true, wrap: null };
  }
}

/** 按原文件的形状组装要写回的内容（裸数组 or {models:[...]} 外壳）。 */
function cliModelsPayload(cur, list) {
  return cur.wrap ? Object.assign({}, cur.wrap, { models: list }) : list;
}

function customModelUrl(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(base) ? base : base + "/chat/completions";
}

/** 保证 CLI 的模型清单里有当前这条自定义模型，返回 { model, warn }。
 *  幂等：字段没变就不写盘（避免每次任务都动用户的配置文件）。 */
async function ensureCliModel() {
  const custom = readCustomModel();
  if (!custom) {
    throw new Error("还没配置自定义模型。去「设置 › 通道 › 后台 Agent › 自定义模型」填接口地址、模型名和 Key，再来选它。");
  }
  if (!custom.supportsToolCall) {
    throw new Error("这条自定义模型被标记为「不支持工具调用」，只能用来生成台词，接管后台任务需要接口支持 function calling。");
  }
  const id = cliModelIdFor(custom);
  if (!id) {
    throw new Error("自定义模型没填模型名（就是接口要的那个 model，比如 gpt-4o-mini / qwen-plus）。接管后台任务必须有它。");
  }
  const url = customModelUrl(custom.baseUrl);
  const entry = {
    /* id 会被 CLI 当请求体的 model 原样发出去，所以它就等于模型名 */
    id,
    name: custom.name || id,
    vendor: ORB_CONTROL_VENDOR,
    url,
    apiKey: custom.key,
    supportsToolCall: true,
    /* 不宣称视觉与推理：越权声明会让 CLI 把截图丢给它，然后整轮沉默失败。
       要让它看屏幕，走「设置 › 视觉模型」那条独立通道，与这里无关。 */
    supportsImages: false,
    supportsReasoning: false,
    /* true = url 就是完整的 completions 地址，不要 CLI 再拼路径 */
    useCustomProtocol: true,
  };

  const cur = readCliModels();
  if (cur.corrupt) {
    throw new Error("读不懂 " + CLI_MODELS_FILE + "（不是合法 JSON）。为了不毁掉你已有的模型配置，这次不写入 —— 请先修好或删掉这个文件。");
  }

  /* 清单里已经有一条**用户自己的**同名模型时，别再加一条重复的：
     CLI 是按 id 找第一条匹配（find），重复条目只会让「到底用哪条」变得不可预测。 */
  let warn = "";
  const alien = cur.arr.find((m) => m && m.id === id && m.vendor !== ORB_CONTROL_VENDOR);
  if (alien) {
    const sameTarget = alien.url === url && alien.apiKey === custom.key;
    if (!sameTarget) {
      warn = "模型清单里已经有一条同名模型「" + id + "」（地址/Key 和你这里填的不一样）。"
        + "CLI 会优先用那一条，所以这次的配置可能不生效 —— 要么把这里改成别的模型名，要么删掉清单里的旧条目。";
      log("[cli-model] 同名条目已存在，跳过写入：" + id);
    }
    return { model: "custom-local:" + id, warn };
  }

  const mine = cur.arr.filter((m) => m && m.vendor === ORB_CONTROL_VENDOR);
  const same = mine.find((m) => m.id === id);
  const stale = mine.some((m) => m.id !== id);
  const changed = !same || same.url !== url || same.apiKey !== custom.key
    || same.name !== entry.name || same.useCustomProtocol !== true || same.supportsToolCall !== true
    || same.supportsImages !== false || same.supportsReasoning !== false;

  if (cur.missing || changed || stale) {
    try { fsSync.copyFileSync(CLI_MODELS_FILE, CLI_MODELS_FILE + ".orb-bak"); } catch { /* 首次没有原文件 */ }
    const others = cur.arr.filter((m) => !m || m.vendor !== ORB_CONTROL_VENDOR);
    writeJsonAtomic(CLI_MODELS_FILE, cliModelsPayload(cur, [...others, entry]), 2);
    log("[cli-model] 已注册到 CLI 模型清单：" + id + (stale ? "（清理了旧条目）" : ""));
  }
  return { model: "custom-local:" + id, warn };
}

/** CLI 侧对自定义模型的报错太技术，转成能照着做的中文。 */
function cliModelHint(text) {
  const s = String(text || "");
  const m = s.match(/Custom model (\S+) has no endpoint url configured/i);
  if (m) {
    return "CLI 没认出这个自定义模型（" + m[1] + "）：它的模型清单里没有对应条目。重新派一次任务会自动重新注册；"
      + "若一直如此，请检查 " + CLI_MODELS_FILE + " 有没有被别的程序改写成不可写。";
  }
  const a = s.match(/Authentication failed for custom model\s*"?([^".\n]*)"?/i);
  if (a) {
    return "自定义模型鉴权失败（" + (String(a[1] || "").trim() || "未知模型") + "）：接口不认配置里的 Key。"
      + "回「设置 › 后台 Agent › 自定义模型」核对 Key；若清单里还有一条同名模型，CLI 会优先用它，那条的 Key 也一并检查。";
  }
  if (/model .*not found|unknown model|invalid model/i.test(s)) {
    return "接口说这个模型名不存在：" + s.slice(0, 160)
      + "。模型名必须和接口那边一模一样（大小写也算），改完再到设置页重新保存一次。";
  }
  return "";
}


async function runPersonaBundle(a) {
  const t0 = Date.now();
  const sys = "你是一个只会说话的桌面伙伴角色。严格遵守给定人格的语言规则，只输出要求的 JSON。";
  const usr = buildPersonaPrompt(a);
  const custom = readCustomModel() || (a && a.custom && typeof a.custom === "object" ? a.custom : null);

  /* 1) 自定义模型优先：更快、不占 CLI 会话额度，而且能拿到 usage ——
     这部分消耗要并进「本次任务」的账里（见 tokAddPersona）。 */
  if (custom && custom.baseUrl && custom.key && custom.model) {
    try {
      const r = await callCustomChat(custom, sys, usr, 9000);
      const p = parsePersonaJson(r.text);
      if (r.usage) tokAddPersona(r.usage);
      if (p) return Object.assign({ ok: true, src: "custom", ms: Date.now() - t0, usage: r.usage || null }, p);
      return { ok: false, error: "自定义模型输出不是可解析的 JSON", src: "custom", ms: Date.now() - t0, usage: r.usage || null };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200), src: "custom", ms: Date.now() - t0 };
    }
  }

  /* 2) 退回 CLI。中文不能走 argv（Windows 下会被按 GBK 转码弄坏），
     所以整段要求写进临时文件，用 --system-prompt-file 传。
     cwd 指向临时目录：避免 CLI 读到项目 AGENTS.md 把人格盖掉。 */
  const cli = await resolveWbCli();
  if (!cli.found) return { ok: false, error: cli.hint || CLI_HINT_MISSING, src: "cli", ms: Date.now() - t0 };
  const tmpDir = process.env.TEMP || process.env.TMP || HERE;
  const tmp = path.join(tmpDir, "orb-persona-" + process.pid + "-" + t0 + ".txt");
  try {
    fsSync.writeFileSync(tmp, usr, "utf8");
  } catch (e) {
    return { ok: false, error: "写临时提示文件失败：" + String((e && e.message) || e), src: "cli", ms: Date.now() - t0 };
  }
  try {
    const port = await freePort();
    const text = await new Promise((resolve, reject) => {
      const child = execFile(
        cli.path,
        [
          "-p", "按系统提示的要求生成四段台词 JSON。",
          "--port", String(port),
          "--output-format", "text",
          "--system-prompt-file", tmp,
          "--permission-mode", "bypassPermissions",
          ...((WB_MODEL || "").trim() ? ["--model", WB_MODEL.trim()] : []),
        ],
        { timeout: 25000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: cleanCliEnv(), cwd: tmpDir },
        (err, stdout) => {
          const out = String(stdout || "").trim();
          if (out) return resolve(out);
          return reject(new Error(String((err && err.message) || "CLI 无输出").slice(0, 160)));
        },
      );
      trackProc(child);
    });
    const p = parsePersonaJson(text);
    if (p) return Object.assign({ ok: true, src: "cli", ms: Date.now() - t0 }, p);
    return { ok: false, error: "输出不是可解析的 JSON", src: "cli", ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200), src: "cli", ms: Date.now() - t0 };
  } finally {
    try { fsSync.unlinkSync(tmp); } catch {}
  }
}

/* ---------------- 划词翻译（轻量旁路，不进 Agent 循环） ----------------
 *
 * 划词工具条上的「翻译」原来只是把选中文字塞进对话框并预填一句"翻译成中文"，
 * 用户点了根本没翻译（原话："只是将选中的文字添加进控制台对话框"）。
 *
 * 这里走一条**纯翻译**的旁路：自己配的接口 / CLI 各调一次，只带一段待译文本，
 * 不派任务、不调工具、不碰输入框 —— 译文直接回给工具条显示成一张可复制的小卡。
 *
 * ⚠️ 方向自动，不额外调一次"语言检测"：含中日韩字符就译成英文，否则译成中文。
 *    绝大多数场景就这两向，多一次调用只会让"划一下看个词"变慢。
 */
const TRANSLATE_MAX = 1500;

async function runTranslate(text) {
  const t0 = Date.now();
  const src = String(text || "").slice(0, TRANSLATE_MAX);
  if (!src.trim()) return { ok: false, error: "没有选中文字", ms: 0 };
  const cjk = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(src);
  const target = cjk ? "English" : "简体中文";
  const dir = cjk ? "zh→en" : "en→zh";
  const sys = "你是翻译器。只输出译文：不要解释、不要加引号、不要加任何前后缀或代码块；"
    + "保留原文的换行与段落结构；专有名词、代码标识符、命令保持原样。";
  const usr = "把下面这段翻译成" + target + "：\n\n" + src;

  /* 1) 自定义模型优先：快、不占 CLI 会话额度 */
  const custom = readCustomModel();
  if (custom && custom.baseUrl && custom.key && custom.model) {
    try {
      const r = await callCustomChat(custom, sys, usr, 20000, { temperature: 0.2, maxTokens: 1200 });
      const out = String(r.text || "").trim();
      if (!out) throw new Error("模型返回空内容");
      return { ok: true, text: out, dir, src: "custom", ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e).slice(0, 200), dir, src: "custom", ms: Date.now() - t0 };
    }
  }

  /* 2) 退回 CLI。中文不能走 argv（Windows 下会被按 GBK 转码弄坏），
        整段要求写进临时文件，用 --system-prompt-file 传（与台词同一招）。 */
  const cli = await resolveWbCli();
  if (!cli.found) return { ok: false, error: cli.hint || CLI_HINT_MISSING, dir, src: "cli", ms: Date.now() - t0 };
  const tmpDir = process.env.TEMP || process.env.TMP || HERE;
  const tmp = path.join(tmpDir, "orb-translate-" + process.pid + "-" + t0 + ".txt");
  try {
    fsSync.writeFileSync(tmp, sys + "\n\n" + usr, "utf8");
  } catch (e) {
    return { ok: false, error: "写临时提示文件失败：" + String((e && e.message) || e), dir, src: "cli", ms: Date.now() - t0 };
  }
  try {
    const port = await freePort();
    const out = await new Promise((resolve, reject) => {
      const child = execFile(
        cli.path,
        [
          "-p", "按系统提示的要求翻译，只输出译文。",
          "--port", String(port),
          "--output-format", "text",
          "--system-prompt-file", tmp,
          "--permission-mode", "bypassPermissions",
          ...((WB_MODEL || "").trim() ? ["--model", WB_MODEL.trim()] : []),
        ],
        { timeout: 30000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: cleanCliEnv(), cwd: tmpDir },
        (err, stdout) => {
          const s = String(stdout || "").trim();
          if (s) return resolve(s);
          return reject(new Error(String((err && err.message) || "CLI 无输出").slice(0, 160)));
        },
      );
      trackProc(child);
    });
    return { ok: true, text: out, dir, src: "cli", ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200), dir, src: "cli", ms: Date.now() - t0 };
  } finally {
    try { fsSync.unlinkSync(tmp); } catch {}
  }
}

/** 找一个当前空闲的本地端口，避免 codebuddy 默认去绑 58449 与正在运行的
 *  WorkBuddy 桌面端冲突（冲突会导致 -p / ACP / --serve 全部卡死）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function spawnOnce(task, timeoutMs, model, cliPath = "") {
  if (!task.trim()) throw new Error("workbuddy_execute 需要一个 task 参数");

  // 兜底：正常路径上 runWorkbuddy 已经校验过；这里再查一次，防止将来有人
  // 直接调 spawnOnce 时拉起一个不存在的可执行文件。
  const cli = await resolveWbCli();
  if (!cli.found) throw new Error(cli.hint || CLI_HINT_MISSING);
  const cliExe = cliPath || cli.path;

  // 关键：显式指定一个空闲端口。codebuddy 启动时总会尝试绑一个内部 HTTP 服务，
  // 默认端口 58449 正被用户运行的 WorkBuddy 桌面端占用，撞上 EADDRINUSE 会让整个
  // 进程卡死（表现为 -p 无输出、ACP session/new 永不回、--serve 的 run 不执行）。
  // 指定 --port 后该冲突消失，进程能正常跑完。
  const port = await freePort();

  // CLI 是原生 .exe 就直接执行；若被覆盖成 .js/.mjs 脚本则用 node 起。
  const viaNode = /\.(m?js)$/i.test(cliExe);
  const file = viaNode ? NODE_EXE : cliExe;
  const argv = [
    ...(viaNode ? [cliExe] : []),
    "-p", task,
    "--port", String(port),
    // 必须用 text：json 输出是「整段会话流水」（含 reasoning / snapshot / 各轮 message），
    // 直接回显那个数组的话，面板会刷出一大坨 JSON 而不是回答正文。
    "--output-format", "text",
    // 后台无人值守，不能卡在权限确认上；与 dsh 轨道的「直接干活」语义对齐。
    "--permission-mode", "bypassPermissions",
    ...(WB_ENV_HINT_ON && appendPromptSupport !== false ? ["--append-system-prompt", WB_ENV_HINT] : []),
    // 单次指定的 model 优先，其次才用环境变量里的默认值
    ...((model || WB_MODEL).trim() ? ["--model", (model || WB_MODEL).trim()] : []),
    ...(WB_EFFORT ? ["--effort", WB_EFFORT] : []),
    ...(WB_MAX_TURNS ? ["--max-turns", WB_MAX_TURNS] : []),
  ];

  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      argv,
      {
        timeout: timeoutMs,
        // 8MB：输出是纯正文（AI 回复 / 命令结果），64MB 纯属给 maxBuffer 事件
        // 留出把整个进程内存顶爆的空间；真超了 8MB 本来就该判失败而不是硬吞。
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        // 剔除桌面端注入的端口变量，避免子进程抢桌面端口（见 cleanCliEnv 注释）
        env: cleanCliEnv(),
        cwd: process.env.ORB_WB_CWD || path.join(HERE, ".."),
      },
      (err, stdout, stderr) => {
        /* execFile 的 timeout 只 TerminateProcess **父进程** —— CLI 拉起的孙进程会
           变孤儿继续跑。所以在这里补一刀树杀。
           ⚠️ 不能改用"超时 + 500ms 的定时器"：timeout 一到 exit 立刻就来了
           （实测 timeoutMs+16ms），定时器会先被 exit 清掉，等于什么都没做。 */
        if (err && (err.killed || err.signal)) killProcTree(child);
        const out = String(stdout || "").trim();
        const exit = classifyCliExit(err, out);
        /* 与 spawnOnceStream 的 finish 使用同一份判定，杜绝两条 CLI 路径口径漂移。
         * 旧注释说「非零退出时也可能已产出结果，优先取 stdout」——按 11-07 简报
         * §3.5 改成：退出码优先，部分输出不采纳，且如实说明副作用可能已产生。 */
        if (exit.failed) {
          const e = new Error(cliExitMessage(exit));
          e.exitCode = exit.exitCode;
          e.partialOutput = exit.partialOutput;
          return reject(e);
        }
        if (!out) {
          const detail = String(stderr || err?.message || "").trim();
          // 未登录是最常见的失败：直接把「怎么修」给到面板，而不是只回一句英文报错。
          // 这里与「没装 CLI」是两种状态，文案必须严格区分，否则用户装好了还以为没装上。
          if (/Authentication required|Please use \/login|not logged in|unauthorized/i.test(detail)) {
            wbCliAuth = "not-logged-in";
            return reject(new Error(CLI_HINT_LOGIN));
          }
          return reject(new Error(`CodeBuddy CLI 无输出：${detail}`));
        }
        wbCliAuth = "ok";   // 真实调用成功过一次，登录态才算确认
        resolve({ content: [{ type: "text", text: extractAnswer(out) }], isError: false, exitCode: exit.exitCode });
      },
    );
    trackProc(child);   // 登记进活动表：急停时连它一起杀（后台 AI 任务就靠这个能停住）
    registerChild(child.pid, "cli");
  });
}


const SERVERS = {
  windows: {
    label: "windows-mcp",
    // 随包运行时没有 pip / venv，也不该在用户机器上跑 pip，所以改成 `-m windows_mcp`
    // 直接加载已随包装好的包：零安装、零网络（参数与环境变量都由 runtime.mjs 统一给）。
    command: WINDOWS_MCP,
    args: windowsMcpArgs(),
    // 遥测三道闸 + pillow 截图后端都在这里（详见 runtime.mjs 的 windowsMcpEnv 注释）
    env: windowsMcpEnv(),
  },
  // WorkBuddy 后台：非 MCP，而是直接拉起 CodeBuddy CLI（见 runWorkbuddy）。
  workbuddy: { label: "workbuddy", kind: "cli" },
};

/* dsh 通道**默认不注册**：它是历史遗留通道，面板早已不走它（后台改走 CodeBuddy CLI），
 * 且依赖某个具体用户家目录下的凭据与 node_modules —— 开源携带别人家目录既不体面，
 * 在别人机器上也永远起不来，只会白占一个常驻 node 进程。
 * 需要它时设环境变量 ORB_ENABLE_DSH=1 显式开启。 */
if (process.env.ORB_ENABLE_DSH === "1") {
  SERVERS.dsh = {
    label: "dsh",
    // lazy：**不参与 /api/status 的预热连接**。
    // status 会遍历所有 SERVER 去 listTools，不标记 lazy 就会每次开面板白拉起一个进程。
    // 标记后只有真正 /api/call 到 dsh 时才连接。
    lazy: true,
    command: NODE_EXE,
    args: [DSH_MCP],
    env: {
      ...process.env,
      DSH_ROOT,
      DSH_HOME,
      // dsh-mcp 启动时硬性检查这个变量，没有就直接报错退出。
      // 值从 .credentials.yaml 读，不硬编码在代码里。
      ...(DSH_API_KEY ? { DEEPSEEK_API_KEY: DSH_API_KEY } : {}),
      ...(DSH_CSCS_KEY ? { CSCS_API_KEY: DSH_CSCS_KEY } : {}),
    },
  };
}

const sessions = new Map();
const connecting = new Map();
/* 连接失败退避：key -> 最早重试时间戳。
 * 面板每 5 秒轮询一次 /api/status，如果某个 MCP server 起不来，
 * 没有退避就会变成"每 5 秒重连一次、每次卡满超时"，CPU 白烧还把 status 拖慢。 */
const SESSION_BACKOFF_MS = 30_000;
const sessionBackoff = new Map();

function isBroken(err) {
  const m = String(err?.message ?? err);
  return /closed|ECONNRESET|EPIPE|not connected|socket hang up|terminated/i.test(m);
}

/**
 * 销毁某个 server 的会话：先从 map 摘掉，再真正 close 掉 client/transport。
 * 只 delete 不 close 会让 MCP 子进程变成孤儿进程，越堆越多，
 * 最终表现为整台机器"用久了就卡死"。
 */
function disposeSession(key) {
  const s = sessions.get(key);
  sessionBackoff.delete(key);   // 主动断开就清退避，让下次调用能立刻重连
  if (!s) return;
  sessions.delete(key);
  try { s.client?.close?.(); } catch {}
  try { s.transport?.close?.(); } catch {}
}

/** 所有会话统一收尾（进程退出时调用，避免留下孤儿 MCP 子进程） */
function disposeAllSessions() {
  for (const key of [...sessions.keys()]) disposeSession(key);
}

/* ══════════ 子进程台账：防止孤儿堆积 ══════════
 * 问题：bridge 被**强杀**（taskkill /F、崩溃、任务管理器结束进程）时收不到 SIGTERM，
 *   shutdown() 根本来不及跑，它拉起的 MCP / ASR 子进程就留在系统里变成孤儿。
 *   实测这台机器上挂着 3 份 windows-mcp（每份 153MB）+ 1 份 dsh-mcp，全都没父进程。
 * 解法：拉起的每个子进程都记进台账；下次 bridge 启动时先按台账清一遍。
 *   台账按**端口**命名 —— 同机跑多个 bridge（离线单测就是）时互不误伤。 */
/* 落 DATA_DIR：装目录在打包态可能不可写，台账写不进去 = 孤儿回收失效。
   读时回退旧位置（HERE），老版本升级上来不会把已有台账当成没有。 */
const CHILD_REG = path.join(DATA_DIR, `.children-${PORT}.json`);
const CHILD_REG_OLD = path.join(HERE, `.children-${PORT}.json`);

function readChildReg() {
  /* 先读 DATA_DIR 的新位置，再回退装目录的旧位置：老版本升级上来时
     不能把已经存在的台账当成"没有"（那会让上一批孤儿无人回收）。 */
  for (const f of [CHILD_REG, CHILD_REG_OLD]) {
    try {
      const a = JSON.parse(fsSync.readFileSync(f, "utf8"));
      if (Array.isArray(a)) return a;
    } catch { /* 这一份没有/坏了，看下一份 */ }
  }
  return [];
}
function writeChildReg(arr) {
  try { writeJsonAtomic(CHILD_REG, arr.slice(-60), 0); } catch { /* ignore */ }
}
function registerChild(pid, kind) {
  if (!pid) return;
  const a = readChildReg().filter((x) => x && x.pid !== pid);
  // owner 记下是谁拉起的：回收时靠它区分「孤儿」和「另一个控制台实例正在用的」。
  // 没有这个字段时，同机开两个控制台，后启动的会把前一个的 ASR / windows-mcp 一起杀掉。
  a.push({ pid, kind: kind || "child", at: Date.now(), owner: process.pid });
  writeChildReg(a);
}

/* 台账里记的是 PID，而 **PID 会被系统回收再利用**：
   跨一次重启、或者上一次 ORB 已经是很久以前的事，台账里那个号完全可能
   已经属于某个别的程序。原来的实现是拿出来就 taskkill /F，那是在赌博。
   所以杀之前先做两道核对：记录时间不能太老、进程名必须和 kind 对得上。 */
/* ⚠️ 前台通道改成 `python -m windows_mcp` 之后，它的映像名变成了 python.exe，
   和 ASR / 实时字幕**一模一样**。再按映像名核对，就会把上一个实例的 ASR
   当成前台孤儿杀掉（本项目以前真踩过这个坑）。
   所以改成按**命令行子串**识别（规则表在 runtime.mjs 的 PROC_KIND_MATCHERS）。
   KIND_IMAGES 只保留给「拿不到命令行」时的兜底粗筛：此时宁可放过，不妄杀。 */
const KIND_IMAGES = {
  windows: ["python.exe", "python", "windows-mcp.exe"],
  dsh: ["node.exe"],
  cli: ["codebuddy.exe"],
  asr: ["python.exe", "python"],
  rt: ["python.exe", "python"],
};
const REAP_MAX_AGE_MS = 7 * 86400000;

/** 一次拿到 PID -> { name, cmd }（Windows 走 CIM 取命令行；拿不到就只回映像名）。 */
function pidInfoMap() {
  return new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process | "
      + "Select-Object ProcessId,Name,CommandLine | "
      + "ConvertTo-Csv -NoTypeInformation",
    ], { timeout: 20000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (_err, stdout) => {
      const m = new Map();
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const cols = line.match(/"[^"]*"/g);
        if (!cols || cols.length < 3) continue;
        const pid = Number(cols[0].replace(/"/g, ""));
        const name = cols[1].replace(/"/g, "").toLowerCase();
        const cmd = cols[2].replace(/^"|"$/g, "");
        if (Number.isFinite(pid)) m.set(pid, { name, cmd });
      }
      resolve(m);
    });
  });
}

/** 一次 tasklist 拿到本机 pid -> 进程名（拿不到时返回空表，调用方据此放弃回收） */
function pidImageMap() {
  return new Promise((resolve) => {
    execFile("tasklist", ["/FO", "CSV", "/NH"], {
      timeout: 8000, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    }, (_err, stdout) => {
      const m = new Map();
      for (const line of String(stdout || "").split(/\r?\n/)) {
        const cols = line.match(/"[^"]*"/g);
        if (!cols || cols.length < 2) continue;
        const name = cols[0].slice(1, -1).toLowerCase();
        const pid = Number(cols[1].slice(1, -1));
        if (name && Number.isFinite(pid)) m.set(pid, name);
      }
      resolve(m);
    });
  });
}

/** PID 是否还活着（优先复用已拿到的 tasklist 名单；非 Windows 用 signal 0 探） */
function pidAlive(pid, images) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (images) return images.has(p);
  try { process.kill(p, 0); return true; } catch { return false; }
}

/** 清掉上一次遗留的子进程：**只杀台账里记过、且核对无误的 PID**。 */
async function reapStaleChildren() {
  const a = readChildReg();
  if (!a.length) return 0;
  const now = Date.now();
  // 优先取带命令行的名单（前台/ASR 现在都是 python.exe，只能靠命令行区分）；
  // PowerShell 拿不到就退回到只看映像名的粗名单。
  let infos = process.platform === "win32" ? await pidInfoMap() : null;
  let images = infos && infos.size
    ? new Map([...infos].map(([pid, v]) => [pid, v.name]))
    : (process.platform === "win32" ? await pidImageMap() : null);
  if (infos && !infos.size) infos = null;      // 空表等同没拿到，交给粗筛
  if (images && !images.size) {
    // 拿不到进程名单就什么都别杀：认不出身份的 PID 一律放过，孤儿下次再清
    log("[gc] 无法获取进程名单，跳过本次回收");
    return 0;
  }
  const killed = [];
  const skipped = [];
  // taskkill 改成 await：原来是 fire-and-forget，杀完立刻接 asrEnsure 时，
  // 旧服务的端口可能还没释放、health 也还响应得过来，于是"以为还在跑"就不拉新的，
  // 紧接着旧进程真死了 → 面板显示服务未运行。
  const killPid = (pid) => new Promise((resolve) => {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { timeout: 8000 }, () => resolve());
    } else {
      try { process.kill(pid, "SIGKILL"); } catch { /* 早就没了 */ }
      resolve();
    }
  });
  for (const x of a) {
    if (!x || !x.pid) continue;
    // ① 太老的记录不认：那是若干天/若干次重启以前的事，PID 早就换了主人
    if (!Number.isFinite(x.at) || now - x.at > REAP_MAX_AGE_MS) continue;
    // ② 身份核对：有命令行就按命令行子串严格判断（python.exe 之间才能分辨清楚）；
    //    只有拿不到命令行时才退回映像名粗筛。
    if (images) {
      const name = images.get(Number(x.pid));
      const want = KIND_IMAGES[x.kind];
      if (!name || (want && !want.includes(name))) continue;
      if (infos) {
        const cmd = infos.get(Number(x.pid))?.cmd || "";
        const verdict = matchProcKind(cmd, x.kind);
        // verdict 为 null = 认不出（没规则 / 没命令行）→ 放过，不赌
        if (verdict === false) continue;
      }
    }
    // ③ owner 还活着、且不是自己 → 是**另一个控制台实例**正在用的，跳过。
    //    实测踩过：两个窗口同时开着，后启动的这个把前一个的 ASR 杀了，
    //    前一个面板上"识别服务"和前台通道同时变成未运行，且查不出原因。
    if (x.owner && Number(x.owner) !== process.pid && pidAlive(x.owner, images)) {
      skipped.push(`${x.kind}#${x.pid}(属 #${x.owner})`);
      continue;
    }
    await killPid(Number(x.pid));
    killed.push(`${x.kind}#${x.pid}`);
  }
  // 只清掉自己这条线：被跳过的条目还要留着，等它 owner 死了再回收
  writeChildReg(a.filter((x) => skipped.some((s) => s.startsWith(`${x.kind}#${x.pid}(`))));
  log(`[gc] 回收遗留子进程 ${killed.length}/${a.length} 个：${killed.join(", ") || "(无需回收)"}`
    + (skipped.length ? `；跳过 ${skipped.length} 个（其他实例在用）：${skipped.join(", ")}` : ""));
  return killed.length;
}

/** 从 MCP transport 里挖出子进程 PID（SDK 内部属性，取不到就算了） */
function transportPid(t) {
  return t?._process?.pid ?? t?.process?.pid ?? t?.child?.pid ?? 0;
}

/* ---------------- 前台通道自检 / 修复 ----------------
 * 症状：面板里 windows-mcp 显示「连接失败」，截图/点击/键盘全不可用。
 *
 * 两种根因（**现在要分开看**）：
 *   A. 随包运行时（orb/runtime/python）缺失或没带上 —— 发布包不完整 / 开发态没构建。
 *      这种情况**不可自动修复**：随包运行时是构建期产物，用户机器上既没 pip 也不该联网。
 *      只能提示重新下载完整安装包（或开发态跑 build-runtime.ps1）。
 *   B. 解释器来自系统（ORB_PY_EXE / ORB_BASE_PY / PATH），里面没装 windows-mcp。
 *      这种情况**可以自动修复**：沿用原来的 venv + pip 安装路径。
 */

/** 解释器在不在 */
function venvPythonOk() {
  try { return !!VENV_PY && fsSync.existsSync(VENV_PY); } catch { return false; }
}
/** 基础 Python 在不在（遗留 venv 修复路径的前提） */
function basePythonOk() {
  try { return !!BASE_PY && fsSync.existsSync(BASE_PY); } catch { return false; }
}
/** 前台通道自检结果，供 /api/status 和设置面板显示 */
function frontHealth() {
  const py = resolvePython();
  const exe = py.ok;                       // 现在"那个可执行文件"就是解释器本身
  const pkg = py.ok && hasWindowsMcp(py);  // 解释器在，但包没装 → missing-exe
  const base = basePythonOk();
  const connected = sessions.has("windows");
  let state = "ok";
  if (!exe) state = "missing-venv";        // 连解释器都没有
  else if (!pkg) state = "missing-exe";    // 有解释器，没装 windows-mcp
  else if (!connected) state = "not-connected";
  return {
    state,
    exe: py.exe,
    exeExists: exe,
    venvExists: py.ok,
    basePythonExists: base,
    connected,
    packageExists: pkg,
    // 随包运行时是构建期产物，**不可在用户机器上重建**；
    // 只有解释器来自系统（env / base-py / path）时才走 pip 修复。
    repairable: py.ok && py.source !== "bundled" && base,
    source: py.source,
    hint: py.ok ? "" : py.hint,
  };
}

/** 轻量重连：只重置会话，不动运行时。
 *  「组件都在、只是 MCP 会话断了」（not-connected）时这一步就足够，毫秒级见效，
 *  而且**对随包运行时同样有效** —— 这是发布包用户唯一够得着的「修复」。
 *  注意必须走 disposeSession：session 对象没有 close 方法，只删 map 引用
 *  会把 windows-mcp 子进程留成孤儿（见 afterInstall 里的同款注释）。 */
function reconnectFront(steps) {
  const push = (s) => { steps.push(s); log("[repair]", s); };
  try {
    disposeSession("windows");
    connecting.delete("windows");
    sessionBackoff.delete("windows");
  } catch { /* ignore */ }
  push("已重置前台连接，下次调用会自动重连");
  return { ok: true, mode: "reconnect", steps, health: frontHealth() };
}

/** 执行修复。三档，按真实状态分流，别让用户陪跑：
 *  ① 组件在、只是会话断（not-connected）→ 轻量重连（任何运行时来源都走这条，
 *     不为这点事去跑 10-15 分钟的 pip）；
 *  ② 随包运行时缺东西（解释器 / windows-mcp 不在）→ 拒绝：构建期产物不可重建，
 *     只能重新下载完整安装包（或开发态重跑 build-runtime.ps1）；
 *  ③ 解释器来自系统且没装 windows-mcp → 重建 venv + pip 安装（遗留修复路径，
 *     开发态 / WorkBuddy venv 被更新清掉的场景）。 */
function repairFront() {
  return new Promise((resolve) => {
    const steps = [];
    const push = (s) => { steps.push(s); log("[repair]", s); };

    const py = resolvePython();
    const pkg = py.ok && hasWindowsMcp(py);
    const connected = sessions.has("windows");

    if (py.ok && pkg && !connected) {
      push("组件已就位、会话未连上：走轻量重连（不重装）");
      resolve(reconnectFront(steps));
      return;
    }

    if (py.ok && py.source === "bundled") {
      /* 用的是随包运行时且缺东西：它是构建期产物，里面没有 pip、也不该在用户机器上
         联网装包。这里明确说"不能修"并给出可执行建议，而不是去跑一次注定失败的 pip。 */
      push("当前使用随包运行时（构建期产物），不支持在线修复");
      resolve({
        ok: false,
        error: "前台通道使用随包运行时，无法在线修复；"
          + "若持续不可用，说明发布包不完整，请重新下载完整的 ORB 控制台安装包。"
          + "（开发态请运行 orb\\native\\build-runtime.ps1 重新构建运行时。）",
        steps,
        health: frontHealth(),
      });
      return;
    }

    if (!basePythonOk()) {
      resolve({ ok: false, error: "基础 Python 不存在，无法自动修复。请在 WorkBuddy 里跑一次任务重建环境，或用 ORB_PY_EXE 指向一个 python.exe。", steps });
      return;
    }

    const run = (cmd, args, cb) => {
      // 关键：剔除代理环境变量。
      // WorkBuddy 会注入 http_proxy=127.0.0.1:xxxx，pip 走这个代理访问 pypi 会 502；
      // 直连（阿里云源）反而通。用 env 覆盖比传 "--proxy ''" 更稳（后者会被当成空值参数）。
      const env = { ...process.env };
      for (const k of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]) {
        delete env[k];
      }
      // 超时给足 20 分钟：实测冷装 windows-mcp 要拉 90+ 个包（含 pillow/numpy/pywin32
      // 等大轮子），慢的时候能跑 12 分钟以上。给小了会中途被杀、留下半成品 venv。
      execFile(cmd, args, { timeout: 1_200_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env },
        (err, stdout, stderr) => cb(err, String(stdout || ""), String(stderr || "")));
    };

    const afterInstall = () => {
      if (!hasWindowsMcp(py)) {
        resolve({ ok: false, error: "安装完成但仍未找到 windows_mcp 包", steps });
        return;
      }
      // 断开旧的坏 session，让下一次 /api/call 或 /api/status 重新连接
      try {
        /* 原来写的是 `sessions.get("windows").close()`。session 对象是
           { client, transport, tools }，**没有 close 方法** —— typeof 检查恒为 false，
           于是只删掉了 map 里的引用，windows-mcp 子进程原封不动地活着变成孤儿。
           修复流程本身反而制造孤儿进程，必须走 disposeSession。 */
        disposeSession("windows");
        connecting.delete("windows");
        sessionBackoff.delete("windows");
      } catch { /* ignore */ }
      push("已重置前台连接，下次调用会自动重连");
      resolve({ ok: true, steps, health: frontHealth() });
    };

    const install = () => {
      push("安装 windows-mcp（阿里云源）...");
      run(VENV_PY, ["-m", "pip", "install", "--upgrade", "--no-cache-dir",
        "-i", PIP_INDEX, "windows-mcp"], (err, out, errOut) => {
        if (!err) { push("安装成功"); afterInstall(); return; }
        push("阿里源失败，改用官方源重试...");
        run(VENV_PY, ["-m", "pip", "install", "--upgrade", "--no-cache-dir",
          "-i", "https://pypi.org/simple", "windows-mcp"], (e2, o2, e2Out) => {
          if (e2) {
            resolve({ ok: false, error: "两个源都安装失败：" + (errOut || err.message).slice(-500), steps });
            return;
          }
          push("安装成功（官方源）");
          afterInstall();
        });
      });
    };

    if (venvPythonOk()) {
      push("venv 已存在，跳过创建");
      install();
    } else {
      push("重建虚拟环境...");
      run(BASE_PY, ["-m", "venv", VENV_DIR], (err, out, errOut) => {
        if (err) {
          resolve({ ok: false, error: "重建 venv 失败：" + (errOut || err.message).slice(-500), steps });
          return;
        }
        push("venv 已重建");
        install();
      });
    }
  });
}

/* ---------------- 自动化录制 / 回放 ----------------
 * 目标：把「录一遍 → 一键重放」做出来，固定流程不再消耗 AI 调用。
 * 落盘：<控制台>/workflows/<名称>.json
 * 录制原理：录制期间拦截每一次 /api/call，把 (tool, args) 原样记下来；
 *          回放时按序重放，中间留出间隔（UI 需要时间响应）。
 * 说明：只读工具（Snapshot/Screenshot）默认也录，但可按 skipRead 跳过，
 *      避免回放时因"多看一眼"把节奏拖慢。
 */
/* 自动化目录跟着 DATA_DIR 走：桥与面板共用同一处，
   避免「桥写包内、面板读 APPDATA」分叉（DATA_DIR 的定义见文件头部）。 */
const WORKFLOW_DIR = path.join(DATA_DIR, "workflows");
/* 与 WORKFLOW_DIR 同级而非其子目录：wfList() 直接 readdir(WORKFLOW_DIR)，
   放子目录虽会被 .json 后缀过滤掉，但同级隔离更彻底，也方便用户手动清理。 */
const WF_TRASH_DIR = path.join(DATA_DIR, "workflows-trash");
const wfTrash = createWfTrash({ dir: WORKFLOW_DIR, trashDir: WF_TRASH_DIR, safeName: (s) => wfSafeName(s) });
const wfRuns = createWfRunLedger({ file: path.join(DATA_DIR, "wf-runs.jsonl"), log: (s) => console.log(s) });
/* 步级轨迹：一个运行一个 jsonl，按运行查是最高频用法，不必扫全表。
   轨迹是观测，不是执行前提 —— 写不进去也绝不拖垮回放（模块内部已吞异常）。 */
const wfTrace = createAutoTrace({ dir: path.join(DATA_DIR, "wf-trace") });
/* 配方版本：<dir>/<配方名>/<rev>.json，body 存原始文本，回滚可以一字不差。
   与 wfTrash 分工明确：回收站管「删了能捡回来」，版本管「改坏了能退回去」。 */
const wfRevs = createRecipeVersions({ dir: path.join(DATA_DIR, "workflows-rev") });
/* 动作级幂等收据：单独一个实例，不与智能体任务的 receipts 抢 2000 额度 ——
   一条 30 步的自动化跑 70 次就能把智能体收据全挤掉，那是最难查的一类丢活。
   key = runId|步号|server|tool|参数指纹，同一次运行的同一步稳定复算。 */
const wfReceipts = createReceipts({
  file: () => path.join(DATA_DIR, "wf-receipts.jsonl"),
  snapshot: () => path.join(DATA_DIR, "wf-receipts.json"),
  max: 6000,
});
const READ_TOOLS_FOR_REC = new Set(["Snapshot", "Screenshot", "DisplayInventory", "Process"]);

/* 断点存储：一条配方一个断点（后写覆盖）。放在 DATA_DIR 下与其他运行数据同级，
   故意不进 WORKFLOW_DIR —— 配方目录要能整体拷贝给别人，断点是本机状态。 */
const wfCps = createCheckpoints({ dir: path.join(DATA_DIR, "wf-checkpoints") });

const REC = { on: false, name: "", steps: [], startedAt: 0, pendingWinCaps: [] };

/**
 * 去重兜底：抑制窗口之外偶尔还是会有"ORB 自己发起的操作被钩子又记一遍"。
 * 判据很明确 —— 相邻两步内容相同，且前一步是 wfCapture 记的、后一步是钩子记的。
 * 用户**真的**连点两次不会误删（clicks 不同，args 就不相同）。
 */
function dedupeRecSteps(steps) {
  const out = [];
  for (const s of steps) {
    const prev = out[out.length - 1];
    if (prev && s.hook && !prev.hook && prev.tool === s.tool
        && JSON.stringify(prev.args) === JSON.stringify(s.args)) {
      continue;
    }
    out.push(s);
  }
  if (out.length !== steps.length) {
    console.log(`[rec] 去重：${steps.length} → ${out.length} 步`);
  }
  return out.map(({ hook, ...rest }) => rest);   // hook 只是内部标记，不落盘
}

/* 全局鼠标钩子：懒加载 + 失败即降级（false 表示"确认不可用"，别反复重试）。 */
let MOUSE_HOOK = null;
async function getMouseHook() {
  if (MOUSE_HOOK !== null) return MOUSE_HOOK || null;
  try {
    MOUSE_HOOK = await import("./mousehook.mjs");
  } catch (e) {
    MOUSE_HOOK = false;
    log("[hook] 模块不可用：", (e && e.message) || e);
  }
  return MOUSE_HOOK || null;
}

function wfSafeName(s) {
  return String(s || "workflow").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "workflow";
}
function wfFile(name) {
  return path.join(WORKFLOW_DIR, wfSafeName(name) + ".json");
}
function wfList() {
  try {
    return fsSync.readdirSync(WORKFLOW_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const j = JSON.parse(fsSync.readFileSync(path.join(WORKFLOW_DIR, f), "utf8"));
          /* 列表直接带最近一次运行：observe 阶段判断「哪类菜谱值得升 auto」时，
             用户在自动化列表就能看见，不必去翻日志。 */
          let lastRun = null;
          try { lastRun = wfRuns.lastFor(j.name); } catch {}
          return { name: j.name, steps: (j.steps || []).length, savedAt: j.savedAt, lastRun };
        } catch { return null; }
      })
      .filter(Boolean);
  } catch { return []; }
}

/**
 * 保存 / 录制覆盖前，把**即将被替换掉**的那份内容留成版本。
 *
 * 只在这次保存真的会改变文件内容时才建版本 —— 反复点保存、内容一字未动却留一堆
 * 同内容快照，会把 maxPerName 的额度耗光，等到真改坏时发现最早的干净版本已被挤掉。
 * 判据是「新内容 vs 磁盘上现有内容」，不是「现有内容 vs 上一个版本」：
 * 后者会把「把当前状态再存一遍」也当成一次改动，快照里全是重复项，回滚时根本分不清哪版是好的。
 * 版本号语义是「第 N 版 = 第 N+1 次保存之前的内容」，回滚到 rev k 即回到那一刻。
 */
function snapshotRecipeVersion(name, opts = {}) {
  const safe = wfSafeName(name);
  if (!safe) return { ok: false, error: "配方名为空" };
  let body = "";
  try { body = String(fsSync.readFileSync(wfFile(name), "utf8")); } catch { return { ok: false, error: "没有可留档的旧内容" }; }
  if (!body.trim()) return { ok: false, error: "旧内容为空" };
  /* 内容没变 = 这次保存是空操作，留档没有意义（比对原文，不做 JSON 归一化）。 */
  if (typeof opts.next === "string" && opts.next === body) {
    return { ok: true, rev: null, skipped: true };
  }
  let steps = 0;
  try { steps = (JSON.parse(body).steps || []).length; } catch { /* 旧内容坏掉也照样留档，回滚时由 rollback 拒绝 */ }
  return wfRevs.save(safe, body, { note: String(opts.note || ""), source: String(opts.source || ""), steps });
}

/** 解析失败返回 null，不抛：版本内容可能被外部改坏，接口不该因此 500。 */
function safeParse(text) {
  try { return JSON.parse(String(text)); } catch { return null; }
}

/** 录制中：把一次工具调用追加进步骤表 */
function wfCapture(server, tool, args) {
  if (!REC.on) return;
  const step = {
    server, tool,
    args: args ?? {},
    wait: 0,                       // 回放时该步之前额外等待(ms)，MVP 先留 0
  };
  REC.steps.push(step);
  /* 抗迁移 + 录制即定身份：异步抓「窗口 + 控件树身份」，抓到就挂到 step 上。
     fire-and-forget，不影响回放/录制节奏；rec-stop 会等这些抓取收尾。 */
  const pp = primaryPoint(step);
  if (pp) {
    const p = captureWinAt(pp[0], pp[1])
      .then((anchor) => { if (anchor) step.win = anchor; })
      .then(() => captureTreeRef(step))   // 录制即定结构化身份（回放不依赖 OCR）
      .catch(() => {});
    (REC.pendingWinCaps || (REC.pendingWinCaps = [])).push(p);
  }
}

/* ---------------- 任务编排执行器 ----------------
 * 让自动化会判断、会循环、能带参数。节点类型：
 *   action（默认，兼容老自动化）/ set（变量赋值）/ loop（次数或条件）/ if（then-else）
 * 字符串里写 {{变量名}} 会被插值替换。
 * **两道防跑飞保险**：嵌套深度上限、while 循环最大轮数上限 ——
 * 编排最容易出的灾难就是"条件永远成立 → 无限循环把机器跑满"。
 */
const MAX_DEPTH = 8;
const MAX_WHILE = 500;
/* 子流程链路上限：subflow 引用另一条配方，只串行不递归展开。
   三层足够表达「准备 → 主流程 → 收尾」，再多说明该拆成两条配方而不是嵌套。 */
const MAX_SUBFLOW_DEPTH = 3;

/* ---------------- 急停（Kill Switch） ----------------
 * 自动化跑飞时唯一能救命的东西。设计取向：**宁可误停，不可漏停**。
 *  · 检查点放在"每一步之前"，所以最多再多走一步就停下
 *  · 急停时**连触发器一起卸掉** —— 否则定时/文件触发器还会继续点火
 *  · 停下后必须**手动恢复**：避免条件重新满足就自己又跑起来（那才是真灾难）
 */
const STOP = { on: false, at: 0, reason: "", epoch: 0 };
/* epoch（世代号）是这次改造的核心。
 *
 * 原来的急停只有一个布尔：`STOP.on`。它能拦住"下一步"，但拦不住**已经飞出去的**东西 ——
 * 后台任务跑完的回调、MCP 迟到的结果、WorkBuddy CLI 的流式尾包，都会在恢复之后
 * 若无其事地写回状态。于是出现最坏的一种：用户以为停了，面板过了两分钟自己变成"完成"。
 *
 * 世代号把"停"从"把开关拨回去"变成"换一代"：
 *   · 每次急停 epoch + 1；
 *   · 任务开工时记下当时的 epoch；
 *   · 任何写状态/拿 GUI 锁/恢复工单，都要比对 epoch，旧世代一律拒收。
 * 这样"恢复"就是一次干净的换代，而不是在旧垃圾上继续叠加。 */
const ticketStore = createTicketStore({
  dir: DATA_DIR,
  log: (...a) => log("[tickets]", ...a),
});
/* 启动即收尾上一进程遗留的非终态工单。此刻内存里没有任何在跑任务，
 * 所以状态非终态的必然是幽灵（崩溃/被杀时没结算）。不收尾的话它们会永远
 * 计入 summary().open，面板就会在什么都没跑的时候显示"有任务在跑"。 */
try {
  const r = ticketStore.reapDangling("上次进程未正常收尾");
  if (r.reaped) log("[tickets] 收尾遗留工单", r.reaped, "条");
} catch (err) {
  log("[tickets] 收尾遗留工单失败：", err?.message ?? err);
}
/* ⚠️ 世代号只有一个来源：工单表的（它落盘、跨重启连续）。
 * 曾经这里让 STOP.epoch 从 0 自己数，而 ticketStore.epoch 从上一次的 2 续上 ——
 * 两个计数器一旦不等，所有"这单是不是上一代的"判断全部失效：
 * 急停后任务照样被当成当代任务、结果被当成成功交付、工单永远收不了尾。
 * 现在只做一件事：内存值跟随落盘值，之后每次急停两边一起 +1。 */
STOP.epoch = Number(ticketStore.epoch || 0);

/* 面板可见的通知（“已停止 3 个任务”“这单花了多少钱”这类）。
 * 用环形缓冲而不是无限数组：控制台是长期常驻的，任何"只增不减"的列表
 * 最后都会变成内存泄漏（SuperAgent 原型被自己列为缺陷的正是这一类）。 */
const NOTICES = [];
const NOTICE_MAX = 50;
function pushNotice(kind, text) {
  const n = { id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), kind, text: String(text).slice(0, 400) };
  NOTICES.push(n);
  if (NOTICES.length > NOTICE_MAX) NOTICES.splice(0, NOTICES.length - NOTICE_MAX);
  return n;
}

/* 发件箱：把"要通知面板"这件事变成一条**有 id、可重试、不重发**的记录。
 * 原来急停是直接 push 一次，SSE 断线就永远丢了；重连后又可能收到两遍。 */
const outbox = createOutbox({
  dir: DATA_DIR,
  log: (...a) => log("[outbox]", ...a),
  send: async (row) => {
    if (row.kind === "notice") {
      pushNotice("system", row.payload?.text || "");
      // 通知落地后立刻推一帧，不等 1.5s 的安全网 —— 急停的反馈必须是即时的。
      await broadcastStatus({ force: true });
      return;
    }
    // 未知类型：不静默吞掉，也不无限重试。标记为永久失败，留在 outbox 里可查。
    const e = new Error(`未知的通知类型：${row.kind}`);
    e.permanent = true;
    throw e;
  },
});

const costLedger = createCostLedger({
  dir: DATA_DIR,
  log: (...a) => log("[cost]", ...a),
});

const guiLock = createGuiLock({
  log: (...a) => log("[gui]", ...a),
  epoch: 0,
});

/* 派发器：**今天的行为与改造前完全一致**（没有注册专家 = 永远走 fallback）。
 * 它存在的意义是给"多 Agent / 派发者专家团"留一个唯一的决策入口，
 * 避免以后出现"面板判一次、桥里再判一次"的两套真相。 */
const dispatcher = createDispatcher({
  log: (...a) => log("[dispatch]", ...a),
});

/* ---------------- 自由路由（命令通道优先，失败回落 GUI 模拟） ----------------
 *
 * 桌面动作（"用 X 打开 Y" / "运行 X" / "写文件"）的通道选择层。
 *   · 命令通道 = cmdchan（文件 + 进程，不碰 GUI 全局态、不占 GUI 锁）；
 *   · GUI 模拟通道 = windows-mcp 的真实桌面自动化工具，经 guiLock 串行化。
 *
 * guiSimulate 是 GUI 回退的**具体实现**：命令通道失败后，由 freeTier 在持有
 * guiLock 的前提下调用它，通过 windows-mcp 的启动工具驱动真实桌面。
 * 工具名用常量 ORB_GUI_LAUNCH_TOOL 暴露，因为不同 windows-mcp 发行版的
 * 启动工具名不一（launch_app / launch / open / run…），装好哪版改一个常量即可。 */
const GUI_LAUNCH_TOOL = process.env.ORB_GUI_LAUNCH_TOOL || "launch_app";

async function guiSimulate(intent) {
  const app = intent.app || intent.command || "";
  if (!app && !intent.filePath) {
    throw new Error("GUI 模拟需要 app 或 filePath（纯写入动作没有 GUI 等价操作）");
  }
  const args = [];
  if (intent.filePath) args.push(intent.filePath);
  if (Array.isArray(intent.args)) args.push(...intent.args);
  try {
    // callTool 是函数声明（已提升），此处引用不受定义位置影响。
    const r = await callTool("windows", GUI_LAUNCH_TOOL, { path: app, args });
    if (r && r.isError) {
      throw new Error(Array.isArray(r.content) ? r.content.map((c) => c?.text || "").join("") : "GUI 工具返回错误");
    }
    return r;
  } catch (e) {
    throw new Error(`GUI 模拟失败（tool=${GUI_LAUNCH_TOOL}）：${e?.message ?? e}`);
  }
}

const freeTier = createFreeTier({
  log: (...a) => log("[freetier]", ...a),
  cmd: { runCommandOp, normalizeCmdOp },
  guiLock,
  gui: guiSimulate,
});

/* 环境探测器：判定「能不能命令化」前先查环境（which/exists），只读、带超时与缓存。 */
const prober = createProber({ log: (...a) => log("[probe]", ...a) });

/* 任务作用域：把"这个子进程属于哪张工单"自动带上。
 * 为什么用 AsyncLocalStorage 而不是给每个函数加参数：
 * spawn 点在 4 个不同的调用链上（CLI / 流式 / daemon / 翻译），
 * 逐个透传参数等于把 jobId 一路缝进 20 个签名里，漏一个就"停不掉那个进程"。
 * 用异步上下文，只有 trackProc 一处需要知道这件事。 */
const jobScope = new AsyncLocalStorage();
const jobProcs = new Map();   // jobId -> Set<proc>，供"只停这一单"用

const trajectory = createTrajectory({
  dir: path.join(DATA_DIR, "trail"),
  log: (...a) => log("[trail]", ...a),
});

/* Worker 池：**默认关着**（maxWorkers 通过 ORB_POOL_WORKERS 打开）。
 *
 * 为什么默认关：今天的行为是"派一个跑一个"，没有上限。直接套一层队列会
 * 悄悄改变时序，而并发恰恰是这份方案里唯一被写死前置条件（P0 全绿、P1 有基线、
 * P2 有 observe 数字）的一项。机制先做出来、用例先跑通，什么时候开是运营决定，不是今晚的决定。 */
const POOL_WORKERS = Number(process.env.ORB_POOL_WORKERS || 0) || 0;
const pool = createWorkerPool({
  maxWorkers: Math.max(1, POOL_WORKERS || 1),
  lock: guiLock,
  log: (...a) => log("[pool]", ...a),
});
let poolEnabled = POOL_WORKERS > 0;

const watchdog = createWatchdog({
  tickets: ticketStore,
  trajectory,
  log: (...a) => log("[watchdog]", ...a),
  /* S5 只读探活：不碰进程、不联网，仅据轨迹检查点回答"还动没动"。
   * alive 恒不据 HTTP 200 / a11y 非空来判定"完成"—— 那正是缺席检测要拆掉的错觉。 */
  probeLiveness: (ticketId) => {
    try {
      const cp = trajectory.checkpoint(ticketId);
      return { alive: !!cp, lastAt: cp ? cp.lastAt : 0, events: cp ? cp.events : 0,
        note: "只读：轨迹检查点，未触碰进程/端口/a11y 状态" };
    } catch { return { alive: null, note: "探活不可用" }; }
  },
  onAlert: (a) => {
    // 看门狗只报告。落成一条通知，推给面板 —— 不自动杀任务。
    if (a.kind === "absent") {
      /* S5：预期完成事件缺失 → logBus 的 safety.warn（可追溯）+ 状态行 + 面板通知。
       * 只报不改：decision 是建议，autoRerun 恒 false，绝不自动重跑/拉起人工停止项。 */
      try {
        logBus.write({ category: "safety", level: "warn", epoch: epochOf(), ticketId: a.ticketId,
          message: `[s5] 预期完成事件缺失：${a.title || a.ticketId} —— ${a.reason}（建议 ${a.decision?.action || "report"}，不自动重跑）` });
      } catch {}
      outbox.enqueue({ kind: "notice", dedupe: `absent:${a.ticketId}`,
        payload: { text: `预期完成事件缺失：${a.title || a.ticketId} —— ${a.reason}；建议${a.decision?.action === "handoff" ? "交还人工" : a.decision?.action === "retry" ? "人工确认后重试" : "降级复核"}（看门狗不自动重跑）` } });
      outbox.pump().catch(() => {});
    } else if (a.kind === "stalled") {
      /* 5 分钟一个桶：同一次卡住只报一次，不会每分钟刷一条。
       * 用分钟做桶的话，一个卡了半小时的任务会刷 30 条通知 —— 那本身就是噪音污染。 */
      outbox.enqueue({ kind: "notice", dedupe: `stall:${a.ticketId}:${Math.floor(a.idleMs / 300000)}`, payload: { text: `可能卡住：${a.title || a.ticketId} —— ${a.reason}` } });
      outbox.pump().catch(() => {});
    } else if (a.kind === "repeating") {
      outbox.enqueue({ kind: "notice", dedupe: `repeat:${a.ticketId}:${a.message.slice(0, 40)}`, payload: { text: `同一错误已重复 ${a.count} 次：${a.message.slice(0, 120)}` } });
      outbox.pump().catch(() => {});
    }
  },
});

/* 在跑的子进程登记表。
 * 为什么需要：急停只把 JS 层的循环停下来，但**已经 spawn 出去的子进程还在跑**
 * （最典型的是后台 AI 的 CodeBuddy CLI），那才是真正失控的东西。
 * Windows 上必须用 taskkill /T 连同**子进程树**杀 —— CLI 会拉起孙进程，
 * 只 kill 父进程的话孙进程会变孤儿继续跑。 */
/* ---------------- 阶段一：交付层 / 尺子 / 归档 的实例 ----------------
 * 世代号只有 STOP.epoch 一个来源。历史上 STOP 与 ticketStore 各数各的，
 * 结果所有跨代比较都为假；这里所有新模块一律注入 epochOf() 读取，不另存。 */
/* 2026-11-04 起固定下来的三棵树（形状写死在 artifactLayout.cjs，别在别处另拼路径）：
 *   ① 产物树  <storageRoot>/<kind>/<YYYY-MM-DD>/<product>   （扁平两层，无会话层、无 artifacts 容器）
 *        kind ∈ {recordings,screenshots,vidx,exports,archive,misc}
 *        类别目录即真实落点：录屏/截屏/看视频/导出/归档/杂项直接按日期铺放，打开即见。
 *        （旧 artifacts/<day>/sessions/<cid>/<kind> 仅作只读兼容，由 layout.resolveSafe 双形态解析，
 *          运行时绝不在 artifacts/ 下创建或写入。）
 *   ② 日志树  <storageRoot>/logs/<YYYY-MM-DD>/      logBus 唯一写者、safety.stop、spool、哈希链 manifest
 *   ③ 治理树  <storageRoot>/governance/<YYYY-MM-DD>/ 观测流 jsonl（span / observe / events / receipts ...）
 * 为什么日志不在产物树里：产物目录要能整体交付/打包，混进 jsonl 日志就不干净了
 * （用户明确要求「除日志文件外」）。三棵树同根、平级，都按 Asia/Shanghai 结束日分区。
 * 日志**绝不写进 audit/**：那里只保留原有「执行审计」与面板查看器，旧契约一个字不动。 */
const layout = createLayout({ root: STORAGE_ROOT });
/* ARTIFACTS_DIR 现在指向「存储根」本身（不再是 legacy 的 artifacts/ 容器）。
 * 扁平化后：sessionMgr 只建 <root>/<day>/ 工作父目录，archiver 落位到 <root>/<relDir>
 * （归档 relDir = archive/<day>/<cid>），artifacts.resolve 的兜底根也是它。
 * 运行时绝不往 artifacts/ 写：那是旧结构的只读兼容路径。 */
const ARTIFACTS_DIR = layout.root();
const govDirOf = () => layout.govDir();
const govFileOf = (name) => () => layout.govFile(name);
try { layout.ensureDay(); } catch {}   // 建当天公共层，失败不影响启动
const epochOf = () => STOP.epoch;
const commandGate = createCommandGate({ isStopped: () => STOP.on, epochOf });
const stateWriter = createStateWriter();
const logBus = createLogBus({
  dirFor: (day) => layout.logsDir(day),
  dayOf: (ts) => layout.day(ts),
  epoch: epochOf,
  minLevel: "info",
  redactPaths: true,
  spoolDirFor: (day) => layout.spoolDir(day),
  chain: {
    stateFile: (day) => layout.chainStateFile(day),
    manifestFile: (day) => layout.manifestFile(day),
  },
});
/* ---------------- 专家团 / 门控 / 插件 / 路由 / 遥测 ----------------
 * 全部只在桥进程里建一份实例，面板通过 /api/ops 读写。
 * 为什么实例化放在这里而不是各模块内部单例：单例会让单测互相污染，
 * 也让"改一份配置立刻生效"变得不可能。桥是唯一宿主，依赖注入即可。 */
const team = createTeam();
const affectGate = createAffectGate();
/* 专家团模式（任务分配）默认关：它是用户主动开的一档，不是后台常驻。 */
const expertTeam = createExpertTeam();
const pluginHost = createPluginHost();
const semanticRouter = createSemanticRouter();
/* 遥测只读、不驻留。exec 由桥提供（取磁盘容量与进程内存前 5）。
   拿不到的字段模块自己会返回 null + reason，桥不替它补零。 */
const telemetry = createTelemetry({
  exec: (cmd) => new Promise((resolve) => {
    try {
      const ch = spawn(cmd, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      ch.stdout.on("data", (d) => { out += String(d); });
      ch.on("error", () => resolve(""));
      ch.on("close", () => resolve(out));
    } catch { resolve(""); }
  }),
});

/* ===== 11-07 新增实例：策略 / 记忆 / 插件闸门 / 治理层 =====
 * 与上面那批共用同一条纪律：桥进程里只建一份，面板经 /api/ops 读写。
 * hostApi 默认关（enabled:false），杜绝配置误开偷偷发请求；要启用必须显式动作。 */
const policyTransition = createPolicyTransition({
  notify: (n) => { try { log("[policy] 收敛通知：" + JSON.stringify(n)); } catch {} },
});
const dream = createDreamConsolidator();
const artifactGate = createArtifactGate({ epochProvider: () => epochOf() });

/* ===== 插件市场索引（只读本机 marketplaces；60s 内复用同一次扫描） =====
 * 数据全在磁盘上：known_marketplaces.json + 各市场 marketplace.json，
 * 不联网、不猜。某个市场清单坏了只跳过它，其余照常可用。 */
let marketIdx = null;
let marketIdxAt = 0;
const MARKET_TTL_MS = 60_000;
function marketIndex(force = false) {
  if (!force && marketIdx && Date.now() - marketIdxAt < MARKET_TTL_MS) return marketIdx;
  try {
    marketIdx = scanMarket();
  } catch (e) {
    marketIdx = {
      ok: false, root: "", marketplaces: [], plugins: [],
      warnings: ["扫描失败：" + String((e && e.message) || e)], scannedAt: Date.now(),
    };
  }
  marketIdxAt = Date.now();
  return marketIdx;
}

function findMarketEntry(name, marketplace) {
  return marketIndex().plugins.find(
    (p) => p.name === name && (!marketplace || p.marketplace === marketplace),
  ) || null;
}

/* 从市场装：读本机源码目录 → 统一摄入 → 真实闸门 → 注册表。
 * 与导入区的「校验」共用 installManifest / dryRunManifest，
 * 所以「校验通过」与「装得上」不会各说各话。 */
function installFromMarket(b = {}) {
  const name = String(b.name || "");
  const mkt = String(b.marketplace || "");
  const entry = findMarketEntry(name, mkt);
  if (!entry) return { ok: false, error: "market-entry-not-found", name, marketplace: mkt };
  if (!entry.hasSource || !entry.dir) {
    return { ok: false, error: "source-not-local", name, note: "该条目只有远端来源，控制台不联网拉包" };
  }
  const src = readSource(entry.dir);
  if (!src.ok) return { ok: false, error: src.error, name, dir: entry.dir };

  const sourceHash = "sha256:" + createHash("sha256")
    .update(JSON.stringify(src.manifest) + "|" + entry.marketplace + "|" + entry.version)
    .digest("hex").slice(0, 32);

  const res = installManifest(
    pluginHost,
    { manifest: src.manifest, skillMd: src.skillMd, hasScripts: src.hasScripts },
    { sourceHash, epoch: epochOf(), approvedBy: String(b.approvedBy || "") },
  );
  if (res.ok) {
    ledgerRecord({
      name: String(src.manifest.name || name), dir: entry.dir, sourceHash,
      approvedBy: String(b.approvedBy || ""), via: "market", marketplace: entry.marketplace,
      id: (res.plugins && res.plugins[0] && res.plugins[0].id) || "",
    });
  }
  return { ...res, name, marketplace: entry.marketplace, dir: entry.dir, sourceHash, hasScripts: src.hasScripts };
}

/* ===== 安装台账（桥重启后按它装回来） =====
 * pluginHost 是纯内存的。没有这份台账，用户从市场装的、拖进来的插件在桥重启后
 * 全部消失 —— 而他刚才明明看到「已安装 2 个」。台账是唯一的状态源，
 * 记的是「从哪来、指纹是什么、谁批的」，重装时按同一条摄入路径再走一遍闸门。
 * 同一 sourceHash 只留一条：重复装同一个包不会让台账无限长。 */
const PLUGIN_LEDGER_FILE = process.env.ORB_PLUGIN_LEDGER || path.join(DATA_DIR, "plugins-installed.json");
function ledgerKeyOf(rec) {
  return String((rec && (rec.sourceHash || rec.dir || rec.name)) || "");
}
function ledgerRead() {
  try {
    const j = JSON.parse(fsSync.readFileSync(PLUGIN_LEDGER_FILE, "utf8"));
    return { version: 1, entries: Array.isArray(j && j.entries) ? j.entries : [] };
  } catch { return { version: 1, entries: [] }; }
}
function ledgerWrite(led) {
  try { writeJsonAtomic(PLUGIN_LEDGER_FILE, led); return true; }
  catch (e) { log("[plugin] 写台账失败:", (e && e.message) || e); return false; }
}
function ledgerRecord(rec) {
  const led = ledgerRead();
  const key = ledgerKeyOf(rec);
  led.entries = led.entries.filter((e) => ledgerKeyOf(e) !== key);
  led.entries.push({ ...rec, at: Date.now() });
  ledgerWrite(led);
}
function ledgerForget(key) {
  const led = ledgerRead();
  const before = led.entries.length;
  led.entries = led.entries.filter((e) => ledgerKeyOf(e) !== String(key));
  if (led.entries.length !== before) ledgerWrite(led);
}

/**
 * 启动时把台账里记的插件装回注册表。
 * 逐条独立：某一条失效（目录被删、清单改坏）只让它自己失败，不连累别人。
 * approvedBy 沿用当初的审批 —— 同一个 sourceHash 用户已经批过一次，
 * 重启不该让他再批一遍；但 epoch 用**当前**的，急停之后旧审批不自动延续。
 */
function restoreInstalledPlugins() {
  const led = ledgerRead();
  const rows = [];
  for (const rec of led.entries) {
    const dir = String(rec.dir || "");
    const src = dir ? readSource(dir) : { ok: false, error: "source-missing" };
    if (!src.ok) { rows.push({ name: String(rec.name || ""), ok: false, error: src.error }); continue; }
    try {
      const r = installManifest(
        pluginHost,
        { manifest: src.manifest, skillMd: src.skillMd, hasScripts: src.hasScripts },
        { sourceHash: String(rec.sourceHash || ""), epoch: epochOf(), approvedBy: String(rec.approvedBy || "") },
      );
      const bad = (r.plugins || []).find((p) => !p.ok);
      rows.push({ name: String(rec.name || ""), ok: Boolean(r.ok), error: r.ok ? "" : String((bad && bad.code) || "install-failed") });
    } catch (e) {
      rows.push({ name: String(rec.name || ""), ok: false, error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  const restored = rows.filter((r) => r.ok).length;
  if (rows.length) log(`[plugin] 台账恢复：${restored}/${rows.length} 成功`);
  return { ok: true, total: rows.length, restored, failed: rows.length - restored, rows };
}

/* ===== 本地插件包：拖进来 / 选文件 =====
 * 落盘目录是稳定的（按内容指纹命名），所以它同时是台账的重装锚点：
 * 桥重启后 readSource(同一个 dir) 就能原样装回来。 */
const PACK_STORE = process.env.ORB_PACK_STORE || path.join(DATA_DIR, "plugin-store");

function decodePackFiles(list) {
  if (!Array.isArray(list) || !list.length) return { ok: false, error: "pack-empty", warnings: [] };
  const entries = [];
  const warnings = [];
  let total = 0;
  for (const f of list) {
    const p = String((f && (f.path || f.name)) || "");
    const b64 = String((f && f.b64) || "");
    if (!p || !b64) continue;
    let data;
    try { data = Buffer.from(b64, "base64"); } catch (e) { continue; }
    if (!data.length) continue;
    total += data.length;
    /* 总量闸放在解码循环里：等全部解完再看大小，垃圾早就进内存了 */
    if (total > PACK_LIMITS.maxTotalBytes) {
      return { ok: false, error: "pack-too-large", warnings: [`超过 ${Math.round(PACK_LIMITS.maxTotalBytes / 1048576)}MB 上限`] };
    }
    if (entries.length >= PACK_LIMITS.maxFiles) return { ok: false, error: "pack-too-many-files", warnings: [`超过 ${PACK_LIMITS.maxFiles} 个文件`] };
    entries.push({ path: p, data });
  }
  if (!entries.length) return { ok: false, error: "pack-empty", warnings };
  return { ok: true, entries, warnings };
}

/** 单个 zip 就解压；单个清单/skill 原样用；其它按文件清单处理。 */
function expandPack(decoded) {
  const one = decoded.entries.length === 1 ? decoded.entries[0] : null;
  if (one && looksLikeZip(one.data)) {
    const z = readZip(one.data);
    if (!z.ok) return { ok: false, error: z.error, warnings: z.warnings };
    return { ok: true, entries: z.entries, warnings: z.warnings, zipped: true };
  }
  if (one && /\.zip$/i.test(one.path)) {
    return { ok: false, error: "zip-corrupt", warnings: ["扩展名是 .zip 但内容不是，文件可能没传完"] };
  }
  return { ok: true, entries: decoded.entries, warnings: decoded.warnings, zipped: false };
}

/**
 * 本地包 → 注册表。dry=true 时只判定。
 * 与市场安装共用 readSource / dryRunManifest / installManifest，
 * 所以「校验通过」与「装得上」在这里也不会各说各话。
 */
function installFromPack(b = {}, { dry = false } = {}) {
  const dec = decodePackFiles(b.files);
  if (!dec.ok) return { ok: false, error: dec.error, warnings: dec.warnings || [] };
  const ex = expandPack(dec);
  if (!ex.ok) return { ok: false, error: ex.error, warnings: ex.warnings || [] };

  const hash = packHash(ex.entries);
  const label = safeId(String(b.name || ex.entries[0].path || "pack").replace(/\.(zip|json|md|skill)$/i, "")) || "pack";
  const storeDir = path.join(PACK_STORE, `${label}-${hash.slice(7, 15)}`);

  const up = unpackTo(storeDir, ex.entries);
  const warnings = [...(ex.warnings || []), ...up.warnings];
  if (!up.ok) return { ok: false, error: up.error || "pack-write-failed", sourceHash: hash, warnings };

  const root = locateRoot(storeDir);
  let src = readSource(root);
  /* 只拖一个 SKILL.md 也是合法包：补一份最小清单（标记 __synthesized），
     并写到盘上 —— 否则重启后台账恢复会读不到清单。 */
  if (!src.ok && src.error === "manifest-unreadable") {
    const synth = synthesizeSkillManifest(root);
    if (synth) {
      try { writeJsonAtomic(path.join(root, "plugin.json"), synth); } catch (e) { /* 写不进就让下面照常失败 */ }
      src = readSource(root);
    }
  }
  if (!src.ok) {
    return { ok: false, error: src.error, dir: root, sourceHash: hash, files: up.written.length, warnings };
  }

  const ctx = { sourceHash: hash, epoch: epochOf(), approvedBy: String(b.approvedBy || "") };
  const input = { manifest: src.manifest, skillMd: src.skillMd, hasScripts: src.hasScripts };
  const res = dry
    ? dryRunManifest(artifactGate, input, ctx)
    : installManifest(pluginHost, input, ctx);

  if (!dry && res.ok) {
    ledgerRecord({
      name: String(src.manifest.name || label), dir: root, sourceHash: hash,
      approvedBy: ctx.approvedBy, via: "pack",
      id: (res.plugins && res.plugins[0] && res.plugins[0].id) || "",
    });
  }
  return {
    ...res,
    name: String(src.manifest.name || label),
    kind: res.kind,
    dir: root,
    sourceHash: hash,
    files: up.written.length,
    zipped: Boolean(ex.zipped),
    warnings: [...warnings, ...(res.warnings || [])],
  };
}

/* 台账恢复放在这里：pluginHost 与 artifactGate 都已就绪，晚于任何常量定义。 */
const pluginRestore = (() => {
  try { return restoreInstalledPlugins(); }
  catch (e) { log("[plugin] 台账恢复异常:", (e && e.message) || e); return { ok: false, total: 0, restored: 0, failed: 0, rows: [] }; }
})();

const memoryBudget = createMemoryBudget({ mode: "normal" });
const hostApi = govHost.createHostDataApi({ enabled: false });
/* API 通道的用户开关（宿主侧唯一状态源，默认关）。
 * 放在 DATA_DIR 而非安装目录：打包态 HERE 在 Program Files 下不可写，
 * 写那儿会让「用户拨开关」静默失败（表现为拨了没反应、重启又变回去）。
 * 读不懂/读到坏文件时 apiChannel 自己退回关闭，这里不做任何"猜"。 */
const API_CHANNEL_FILE = path.join(DATA_DIR, "api-channel.json");
const apiChannel = createApiChannel({
  load: () => {
    try { return JSON.parse(fsSync.readFileSync(API_CHANNEL_FILE, "utf8")); } catch { return null; }
  },
  save: (s) => {
    try { writeJsonAtomic(API_CHANNEL_FILE, s); return { ok: true }; } catch (e) {
      return { ok: false, warning: String(e && e.message ? e.message : e).slice(0, 160) };
    }
  },
});
const sealReview = govSeal.createSealReview({ mode: "normal", teamFactory: () => team });
const GOV_CHANNEL_DIR = path.join(DATA_DIR, "gov-channel");
try { fsSync.mkdirSync(GOV_CHANNEL_DIR, { recursive: true }); } catch {}
const govChannel = govP1.createFileChannel({ dir: GOV_CHANNEL_DIR });

/* 最近一次评审结果：面板重开时要能立刻看到上次结论，不必重跑。 */
let teamLastReview = null;

/**
 * 采集当前运行状态，生成一批**确定性**发现。
 * 为什么不用模型：阶段一形态的定义就是「单模型多视角 + 确定性校验器」，
 * 这里如果偷偷调一次模型，"可复现、可解释"这条就没了。
 * 每条发现都必须能指到具体的状态字段（evidence），指不到的不写。
 */
/* 收集本轮可验证的异常项。
 * light=true 时**跳过遥测**：telemetry.snapshot() 要 spawn wmic/tasklist 这类命令，
 * 而自动复核是挂在「每条任务收尾」上的 —— 每单开一次子进程，用户会直接感觉到卡。
 * 轻量档只看内存里的计数器（急停/限流/插件/派发器/门控），毫秒级。
 * 深档（light=false）才连内存与磁盘一起看，供面板手动发起。 */
function teamCollectFindings(opts = {}) {
  const light = !!opts.light;
  const rows = [];
  const add = (expertId, claim, topic, severity, confidence, evidence) => {
    rows.push({ expertId, claim, topic, severity, stance: "support", confidence, evidence });
  };
  try { if (STOP.on) add("sec", "急停处于开启状态，所有自动化已被拦下", "stop-on", "block", 1, "STOP.on=true"); } catch {}
  try {
    const lb = logBus.stats();
    if (Number(lb.rejected) > 0) add("sec", "日志写入被限流 " + lb.rejected + " 条", "log-throttle", "warn", 0.8, "logBus.stats().rejected");
  } catch {}
  try {
    const ps = pluginHost.stats();
    if (Number(ps.failed) > 0) add("correct", "插件调用失败 " + ps.failed + " 次", "plugin-failure", "warn", 0.75, "pluginHost.stats().failed");
  } catch {}
  try {
    const n = dispatcher.list().length;
    if (!n) add("arch", "派发器没有注册任何专家，路由仍走单路", "dispatcher-empty", "info", 0.6, "dispatcher.list().length === 0");
  } catch {}
  try {
    const a = affectGate.stats();
    if (Number(a.blocked) > 0) add("ux", "门控最近拦下 " + a.blocked + " 次主动开口", "gate-blocked", "info", 0.55, "affectGate.stats().blocked");
  } catch {}
  if (!light) {
    try {
      const t = telemetry.snapshot();
      if (t && t.mem && Number.isFinite(t.mem.usedPct) && t.mem.usedPct > 92) {
        add("perf", "内存占用 " + Math.round(t.mem.usedPct) + "%", "mem-high", "warn", 0.8, "telemetry.mem.usedPct");
      }
      if (t && Array.isArray(t.disk)) {
        for (const d of t.disk) {
          if (d && Number.isFinite(d.usedPct) && d.usedPct > 90) {
            add("perf", "磁盘 " + String(d.mount) + " 已用 " + Math.round(d.usedPct) + "%", "disk-high", "warn", 0.85, "telemetry.disk");
          }
        }
      }
    } catch {}
  }
  /* 一条发现都没有时也要给一条，否则面板会以为"没跑"。 */
  if (!rows.length) add("correct", "本轮自检未发现异常项", "all-clear", "info", 1, "collect");
  return rows;
}

let logForwardEnabled = true;   // /api/log 接收闸；主进程另有 state.logForward 开关
/* 桥起来后回放主进程在桥未就绪期间落的 spool，并按保留期清一次过期行。
 * 都放在下一个事件循环，别拖慢监听端口的启动。 */
setTimeout(() => {
  try { logBus.replaySpool?.(); } catch {}
  try { logBus.cleanup?.(Date.now()); } catch {}
}, 2000);
/* 运行期主进程日志偶尔 POST 失败会重建同名 spool 文件；只靠启动回放会把那批拖到下次重启。
 * replaySpool 已验证幂等（同名重建只补写新批次、不重复行），60s 兜底一次即可。
 * unref 掉：别让这个定时器拖住进程退出。 */
setInterval(() => { try { logBus.replaySpool?.(); } catch {} }, 60000).unref?.();
let profile = normalizeProfile(DEFAULT_PROFILE);   // 七键交付契约，勿漏：下面 exporter 与 /api/ops 都用它
let exporter = createExporter({ profile, epoch: STOP.epoch });
const artifactStore = createArtifactStore({ dir: govDirOf });

/* ---- I-17：产物登记唯一入口 ----------------------------------------------
 * 之前三处各自 register({ rel: path.basename(...) })，登记表里只有一个文件名，
 * 主进程想定位就得扫目录 —— 这正是 I-17 明令禁止的。现在统一写完整 rel：
 *   <day>/sessions/<cid>/<kind>/<name>
 * layout.resolveSafe() 能直接把它解析回 artifactsRoot 下的绝对路径，不扫目录。
 * 旧调用方（含面板 artifacts.register）传裸文件名时，这里按当前会话补齐形状，
 * 老数据由 artifactView.inferRel() 兜底，不需要迁移。
 */
function currentArtifactCtx() {
  const c = sessionMgr.current();
  return {
    cid: String(c?.conversationId || "local"),
    day: layout.day(),
    epoch: epochOf(),
  };
}

function registerArtifact(o = {}) {
  const ctx = currentArtifactCtx();
  const cid = String(o.conversationId || ctx.cid);
  const day = String(o.day || ctx.day);
  /* 旧登记表把导出类写成 "artifacts"，但布局六类里没有这一项（是 exports）。
     不归一的话，面板 PDF 两跳那条老入口会永远登记失败。 */
  const rawKind = String(o.kind || "exports");
  const kind = rawKind === "artifacts" ? "exports" : rawKind;
  const p = productRel(day, cid, kind, o.fileName || o.rel || "");
  if (!p.ok) {
    return { ok: false, id: null, reason: `rel 不合法: ${p.reason}`, hint: "产物表登记失败，文件本身不受影响" };
  }
  return artifactStore.register({
    conversationId: cid,
    epoch: Number(o.epoch ?? ctx.epoch),
    ticketId: String(o.ticketId || ""),
    kind,
    rel: p.rel,
    ext: String(o.ext || p.ext).toLowerCase(),
    size: Number(o.size) || 0,
    sha: String(o.sha || ""),
    rootKey: rootKeyOf(layout.root()),
    createdAt: Number(o.createdAt) || Date.now(),
  });
}

/* 按 artifactId 查表 → 安全解析绝对路径。两处都要用（列表判定存在、详情读预览）。
 * 只认登记表里的 rel，绝不接受客户端传来的任意路径。 */
function artifactSafeRel(entry) {
  const direct = String(entry?.rel || "");
  if (direct && layout.resolveSafe(direct)) return direct;
  return inferRel(entry, { day: layout.day(), cid: entry?.conversationId, now: Date.now() });
}
function artifactAbs(entry) {
  const rel = artifactSafeRel(entry);
  return rel ? layout.resolveSafe(rel) : null;
}

const MEDIA_RETENTION_MS = 30 * 24 * 3600 * 1000;
function artifactViewCtx(extra = {}) {
  return {
    now: Date.now(),
    currentRootKey: rootKeyOf(layout.root()),
    mediaRetentionMs: MEDIA_RETENTION_MS,
    ...extra,
  };
}

const spanCollector = createSpanCollector({ file: govFileOf("spans") });
const observeRouter = createObserveRouter({ file: govFileOf("observe") });
const textGate = createTextGate({ mode: "balanced" });
/* 报告B V-10：域名授权白名单只从环境注入，默认空 = 带 url 的检索一律要求人工授权。
   与 searchProvider 的开关同一套 fail-closed 约定，代码里不硬塞任何站点。 */
const SEARCH_ALLOWED_HOSTS = String(process.env.ORB_SEARCH_HOSTS || "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
/* 报告B §10.2：V-01 回落从「隐式失败」变成「显式可审计分支」。
   只留最近 200 条在内存，可从 /api/ops gov 查；不落盘、不进安全页（§5 约束）。 */
const v01Degrades = [];
function noteV01Degrade(rec = {}) {
  const row = {
    ...degradeRecord(rec.reasonCode || "", rec.stage || "v01-compile"),
    at: Date.now(),
    textLen: Number(rec.textLen || 0),
  };
  v01Degrades.push(row);
  if (v01Degrades.length > 200) v01Degrades.shift();
  return row;
}
/* 从 MCP content 里抽文本，供三个不可信入口统一过闸。 */
function toolTextOf(r) {
  const parts = (r && Array.isArray(r.content)) ? r.content : [];
  return parts.filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text).join("\n");
}
const fastPath = createFastPath({ probe: prober });
/* 外部检索 provider（批次C 降级接线）：
 *  · 默认 inert 凭据来源：不读本机 dsh 凭据库、不读账号平台签发的那把 key，
 *    零外发、零计费 —— 授权范围未经确认，本轮不挪作检索用途。
 *  · 只有「总开关显式打开」且「来源显式登记」时，才从用户自己设的
 *    ORB_SEARCH_API_KEY 拿 key（不管是哪家，统一填这一个变量）。
 *  · ORB_SEARCH_PROVIDER 选厂商形状（anysearch / deepseek / zhipu / baidu / custom），
 *    未登记的拼法一律回落到 deepseek，绝不猜。anysearch 与 custom 允许无 Key 匿名
 *    调用（官方端点 key 可选），此时 CREDENTIAL_SOURCE=inert、API_KEY 为空，由 adapter
 *    省略 Authorization 头；除此之外无 Key 一律 no-credential 降级。
 *  · ORB_SEARCH_MODEL 是可选的「模型 / 引擎」名；deepseek 无此项会忽略。
 *  · 凭证绝不来自请求体 / /api/ops / 运行时的 HTTP 调用，绝不写进日志、
 *    状态或任何返回值。面板「检索工具」栏目填的 Key 也不是运行时注入：
 *    它由 Electron 主进程在**启动本进程时**从系统加密库取出、注入成
 *    ORB_SEARCH_API_KEY，本进程仍然只认启动期的受控环境变量。
 *  · 失败一律降级，绝不回落截图 / 视觉循环。
 */
const SEARCH_PROVIDER_ID = String(process.env.ORB_SEARCH_PROVIDER || DEFAULT_ADAPTER_ID).trim().toLowerCase();
const searchAdapter = getAdapter(SEARCH_PROVIDER_ID) || getAdapter(DEFAULT_ADAPTER_ID);
const searchCredentials = createCredentialProvider({
  enabled: process.env.ORB_SEARCH_ENABLED === "1",
  source: process.env.ORB_SEARCH_CREDENTIAL_SOURCE || "inert",
});
const searchProvider = createSearchProvider({
  enabled: searchCredentials.describe().enabled,
  apiKey: searchCredentials.resolve().apiKey,
  adapter: searchAdapter.id,
  model: process.env.ORB_SEARCH_MODEL || "",
  endpoint: process.env.ORB_SEARCH_ENDPOINT || "",
  timeoutMs: Number(process.env.ORB_SEARCH_TIMEOUT_MS),
  maxResults: Number(process.env.ORB_SEARCH_MAX_RESULTS),
});
/* 离线 fixture 只用于验收「编排层真的会消费 results[]」：默认关闭。
 * 开启时产物会显式标注「非真实检索」；它不触发任何网络请求，也不消耗凭据。 */
const SEARCH_OFFLINE_FIXTURE = process.env.ORB_SEARCH_OFFLINE_FIXTURE === "1";
/* 浏览器操控 provider。onCommand 是桥侧执行器，也是**第二道**白名单：
 * provider 自身已做过一次白名单 / epoch / confirm / tab 所有权校验，这里不放宽、只复核。
 * 真执行在浏览器扩展侧，桥只做授权与记账 —— 绝不执行任意 JS、绝不访问网络、
 * 绝不读 cookie、不注入任何凭据；只回固定形状的结构化结果。 */
const browserReadMethods = new Set(BROWSER_METHODS.read);
const browserWriteMethods = new Set(BROWSER_METHODS.write);
/* 桥主动下发命令的回执关联表：
 *   browserCmdResults: corrId -> { resolve, timer, promise }
 *     —— POST /api/browser/command 时登记，command_done 回执到达或超时后 settle。
 *   extToCorr:        扩展重派发的 command_id -> 桥侧 corrId
 *     —— 扩展收到桥下发的命令后会用自有 command_id 重新派发，桥授权后执行，
 *        回执 command_done 里带的是扩展的 command_id；这里把它映射回我们的 corrId，
 *        好让 /api/browser/command-result 找到等待的调用方。映射表是无界的，但每条
 *        只在「下发→回执」这一小段生命周期内存在，且 command_done 到达即删。 */
const BROWSER_CMD_TIMEOUT_MS = 8000;
const browserCmdResults = new Map();
const extToCorr = new Map();
const BROWSER_CMD_ERR = {
  "method-denied": "方法不在浏览器通道白名单内",
  "confirmation-required": "写操作需要 confirm:true",
  "no-channel": "浏览器扩展通道当前不在线，无法下发命令",
};
function registerBrowserCommand(corrId) {
  const slot = { resolve: null, timer: null, promise: null };
  slot.promise = new Promise((resolve) => {
    slot.resolve = resolve;
    slot.timer = setTimeout(() => {
      browserCmdResults.delete(corrId);
      for (const [k, v] of extToCorr) if (v === corrId) extToCorr.delete(k);
      resolve({ ok: false, error: { code: "timeout", message: "命令在限定时间内未收到扩展执行回执", outcome: "timeout" } });
    }, BROWSER_CMD_TIMEOUT_MS);
    if (slot.timer.unref) slot.timer.unref();
  });
  browserCmdResults.set(corrId, slot);
  return slot.promise;
}
/* 扩展新鲜度比对（S3）：读随包 background.js 顶部的 `const BUILD = '...'` 作为期望值。
 * 扩展每次 provider_hello 会带着自己的 build 上报，browserProvider 比对两者：
 * 不一致即判定浏览器里跑的是旧副本，需要到扩展页「重新加载」。
 * 期望值直接从随包文件读，与扩展实现同源，天然不会两处漂移。 */
function readBundledExtBuild() {
  const candidates = [
    path.join(HERE, "app", "browser-extension", "background.js"),
    path.join(HERE, "..", "browser-extension", "background.js"),
  ];
  for (const f of candidates) {
    try {
      const t = fsSync.readFileSync(f, "utf8");
      const m = t.match(/const\s+BUILD\s*=\s*['"]([^'"]+)['"]/);
      if (m && m[1]) return m[1];
    } catch { /* 读不到试下一个候选 */ }
  }
  return null;
}
const BUNDLED_EXT_BUILD = readBundledExtBuild();
if (BUNDLED_EXT_BUILD) log(`[browser] 随包扩展构建戳 ${BUNDLED_EXT_BUILD}（用于新鲜度比对）`);
else log("[browser] 未找到随包 background.js 的 BUILD，扩展新鲜度比对暂不启用");

const browserProvider = createBrowserProvider({
  /* 期望值传给 provider，由它对扩展上报值做比对。 */
  bundledBuild: BUNDLED_EXT_BUILD,
  onCommand: async (method, params, ctx) => {
    /* 记录关联：扩展会用新 command_id 重派发，桥授权后执行，回执带扩展的 command_id。
       这里把扩展的 command_id 映射回桥侧 corrId（放在 params._orbCmd 透传过来）。 */
    if (ctx && typeof ctx.command_id === "string" && params && typeof params._orbCmd === "string") {
      extToCorr.set(ctx.command_id, params._orbCmd);
    }
    if (browserReadMethods.has(method)) {
      /* authorized:true 是扩展侧 handleProviderResult 的唯一放行闸；
         delegated 仅作兼容老版本扩展（它只看 ok），两者都给，互不冲突。 */
      return { ok: true, authorized: true, delegated: true, method, note: "执行在浏览器扩展侧" };
    }
    if (browserWriteMethods.has(method)) {
      if (!params || params.confirm !== true) {
        return { ok: false, degraded: true, reasonCode: "confirmation-required" };
      }
      return { ok: true, authorized: true, delegated: true, method, note: "执行在浏览器扩展侧" };
    }
    return { ok: false, degraded: true, reasonCode: "method-denied" };
  },
  /* 用户开关：provider 不存值，只转发给 apiChannel 并回带真值，
   * 保证「面板显示的」与「执行时用的」是同一份状态。 */
  settingsSnapshot: () => ({
    api_channel_enabled: apiChannel.isEnabled(),
    /* 端点清单由代码里的白名单生成：界面不再手写"2 个"，扩端点时文案自动跟着变。 */
    api_channel_endpoints: govHost.listEndpoints().map((e) => e.label),
  }),
  onSettings: ({ api_channel_enabled }) => {
    const r = apiChannel.setEnabled(api_channel_enabled, { by: "popup" });
    try {
      log(`[api-channel] 面板开关 → ${r.enabled ? "开" : "关"}（来源 ${r.updatedBy}，persisted=${r.persisted}）`);
      if (r.warning) log("[api-channel] " + r.warning);
    } catch { /* 日志失败不影响开关本身 */ }
    return r;
  },
});
const baseline = createBaseline({ file: govFileOf("baseline") });
const eventRecorder = createEventRecorder({ file: govFileOf("events") });
/* 效果收据：审计流 append-only 走 receipts，另存一份"当前有效索引"快照。
 * 快照是幂等能跨重启生效的前提 —— 只有内存态时，重启后同一件事会做第二遍。 */
const receipts = createReceipts({ file: govFileOf("receipts"), snapshot: govFileOf("receipts-snapshot") });
try {
  const l = receipts.load();
  if (l.loaded) log(`[receipts] 恢复 ${l.loaded} 张已结算收据（generation=${l.generation}）`);
} catch {}
const ticketCtl = createTicketControl({ file: govFileOf("ticket-control") });
/* 自动化步骤收据同样跨重启恢复：只有内存态的话，重启后同一步会做第二遍。 */
try {
  const l = wfReceipts.load();
  if (l.loaded) console.log(`[wf-receipts] 恢复 ${l.loaded} 条已结算步骤收据`);
} catch { /* 恢复失败不阻塞启动，只是幂等退化成同进程内 */ }
/* 专家契约：默认最保守，用户可在运行目录下放 expertBook.json 覆盖。
 * 读不懂覆盖文件时整份退回默认并留 warning —— 绝不"读不懂就全放开"。 */
const expertBook = createExpertBook({ file: defaultBookPath(DATA_DIR) });
try {
  const eb = expertBook.load();
  if (eb.warning) log(`[expertBook] ${eb.warning}`);
} catch {}
/** 仲裁一次专家动作。没带 expertId 或专家未登记 → 放行（不是专家链路，不归它管）。 */
function arbitrateExpert(expertId, ask = {}) {
  const id = String(expertId || "");
  if (!id || !expertBook.has(id)) return { ok: true, reason: "no-expert", detail: "" };
  const v = arbitrate(expertBook.get(id), { ...ask, tool: `${ask.server || ""}|${ask.tool || ""}` });
  if (v.allow) return { ok: true, reason: v.reason, detail: "" };
  try {
    logBus.write({ category: "safety", level: "warn", epoch: epochOf(),
      message: `专家越权被拒：${id} / ${ask.server}.${ask.tool}（${v.reason}）` });
  } catch {}
  return { ok: false, reason: v.reason, detail: v.detail };
}
/* 升级器（2026-11-05）：所有"换档"都记在同一个账本里，并统一做世代校验。
 * 为什么必须统一：旧世代迟到的降级回调会把状态改回去，而每处各自决定要不要看
 * epoch，就一定有一处忘了。这里只记账 + 校验，不替业务决定该不该换。 */
const upgrade = createUpgrade({ epoch: () => epochOf() });
const personaSlots = createPersonaSlots();
const visualTiers = createVisualTiers({
  epoch: epochOf,
  probe: prober,
  /* 视觉档位换档 → 记进升级账本。参数名对不上就静默丢弃，
     不让"记账"这件事有本事把选档带崩。 */
  onTransition: (ev) => {
    try { upgrade.transition(ev.ladder, ev.from, ev.to, { cause: ev.cause, epoch: ev.epoch }); } catch {}
  },
});
const sessionMgr = createSessionManager({
  root: ARTIFACTS_DIR,
  onFinalize: (r) => {
    try {
      logBus.write({ category: "artifact", level: "info", epoch: epochOf(),
        message: `会话归档触发：${r?.conversationId || "-"} / ${r?.reason || "finalize"}${r?.interrupted ? "（急停冻结）" : ""}` });
    } catch {}
  },
});
const archiver = createArchiver({ root: ARTIFACTS_DIR, linkMode: "copy" }); // 默认纯复制，L4 只留引用

/* 命令通道「启动类」进程的可枚举登记表。
 * launchApp 刻意 detached + unref，让被打开的程序独立于桥存活 —— 这是设计，不是漏洞，
 * 因此不进 activeProcs（急停不该顺手杀掉用户刚打开的记事本）。但两件事必须成立：
 * ① 可枚举（这里登记 pid/command/epoch），② 急停后不许新建（commandGate 入口 409）。 */
const launchedProcs = new Map();
function noteLaunched(result) {
  const l = result && result.launched;
  if (!l || !l.pid) return;
  launchedProcs.set(String(l.pid), {
    pid: l.pid, command: String(l.command || ""), args: Array.isArray(l.args) ? l.args : [],
    epoch: epochOf(), at: Date.now(), orphaned: false,
  });
  if (launchedProcs.size > 200) launchedProcs.delete(launchedProcs.keys().next().value);
}

const activeProcs = new Set();

function trackProc(p) {
  if (!p || typeof p.once !== "function") return p;
  activeProcs.add(p);
  /* 归属到工单：`jobScope` 是异步上下文，spawn 发生在哪条链上就自动归到哪张工单，
   * 不需要把 jobId 一路透传进 20 个函数签名。
   * 有了这张表才能做"只停这一单"——否则 /api/job/:id/abort 只能全杀。 */
  const scope = jobScope.getStore();
  if (scope && scope.id) {
    let set = jobProcs.get(scope.id);
    if (!set) { set = new Set(); jobProcs.set(scope.id, set); }
    set.add(p);
    const drop = () => { set.delete(p); if (!set.size) jobProcs.delete(scope.id); };
    p.once("exit", drop);
    p.once("error", drop);
  }
  const done = () => activeProcs.delete(p);
  p.once("exit", done);
  p.once("error", done);
  return p;
}

/** 杀**进程树**：Windows 上只 kill 父进程，CLI 拉起的孙进程会变孤儿继续跑。 */
function killProcTree(p) {
  if (!p || !p.pid) return;
  try {
    if (process.platform === "win32") execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], () => {});
    else p.kill("SIGKILL");
  } catch { /* 已经退了 */ }
}
function killActiveProcs() {
  let n = 0;
  for (const p of activeProcs) {
    try {
      if (process.platform === "win32" && p.pid) {
        execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], () => {});
      } else {
        p.kill("SIGKILL");
      }
      n++;
    } catch {}
  }
  activeProcs.clear();
  return n;
}

/* 注：原先这里有个 checkStop()，只在 runSteps 里被调用一次，
 * 导致急停拦不住单次工具调用。检查逻辑已内联到 callToolRaw 入口，
 * 那里能一次性覆盖回放 / 单次 / 后台 / 危险确认四条路径。 */

/* 在途的 MCP 调用计数：key -> 数量。
 * 为什么需要它：MCP 工具（比如一条跑很久的 PowerShell、一次大范围 Snapshot）
 * 是在 **MCP server 子进程内部**执行的，bridge 这边只是 await，kill 不到它。
 * 唯一能真正中断的办法是**把连接断掉** —— stdio 一关，子进程收到 EOF 退出，
 * 卡在 callTool 上的 Promise 立刻 reject，自动化也就停下来了。
 * 但断连代价不小（下次调用要重连、要几秒），所以**只在确实有在途调用时才断**。 */
const inflightMcp = new Map();
const inflightTotal = () => [...inflightMcp.values()].reduce((a, b) => a + b, 0);

/** 急停时中断正在跑的 MCP 调用：断连接 → 子进程 EOF 退出 → Promise reject。
 *  返回断掉的 server 名单，供面板显示"停掉了什么"。 */
function killInflightMcp() {
  const busy = [...inflightMcp.keys()];
  if (!busy.length) return [];
  // 先把 PID 抓出来（dispose 之后 transport 上的引用就没了）
  const pids = [];
  for (const key of busy) {
    const t = sessions.get(key)?.transport;
    const pid = t?._process?.pid ?? t?.process?.pid ?? t?.child?.pid;
    if (pid) pids.push(pid);
    disposeSession(key);   // 会 close client + transport
  }
  // MCP server 可能自己还拉起过孙进程，close 不保证全清干净 —— 补一刀。
  // 原来每个 PID 起一个 taskkill 进程：急停时常见 3~5 个在途调用，
  // 等于在最不该卡的时候连开 3~5 个进程。taskkill 支持一次喂多个 /PID，合并成一次。
  if (pids.length) {
    const args = [];
    for (const pid of pids) args.push("/PID", String(pid));
    args.push("/T", "/F");
    try { execFile("taskkill", args, { timeout: 8000 }, () => {}); } catch { /* ignore */ }
  }
  console.log("[stop] 中断在途 MCP 调用：", busy.join(", "), pids.length ? `（taskkill ${pids.join(",")}）` : "");
  return busy;
}

/* 最近一次急停的收场报告：doStop 每次都写，面板用 /api/stop/report 读。
   急停最该回答的不是「停没停」，而是「哪些活白做了、哪些能续」。 */
let LAST_STOP_REPORT = null;

function doStop(reason) {
  STOP.on = true;
  STOP.at = Date.now();
  STOP.reason = reason || "手动急停";
  /* 换代。这是"停得住"的关键：先抬 epoch，再杀进程 ——
   * 反过来的话，杀进程期间跑完的任务会以"当前世代"写回状态，正好漏掉。 */
  STOP.epoch = Number(STOP.epoch || 0) + 1;
  /* 运行账本同步作废：在跑的 recipe 标 interrupted，不留「永远在跑」的幽灵。
     恢复不重放旧 run —— 与 doResume 的既有语义一致。 */
  try {
    const n = wfRuns.abortAll(STOP.reason, STOP.epoch);
    if (n) console.log(`[stop] 已作废 ${n} 条在跑的自动化运行`);
  } catch {}
  /* 浏览器扩展通道也一并停掉：急停不是只停 GUI。provider 会推 channel_close，
     宿主轮询 /api/browser/pending 取走并转交扩展。 */
  try { browserProvider.closeAll("stopped"); } catch {}
  /* 阶段一接线：抬代之后立刻做三件带外的事，且必须排在 killActiveProcs 之前。
     safety.stop 是急停期间最后一条日志，日志总线写的是文件不是子进程，不会被进程树清理带走。 */
  try { commandGate.onEpochAdvanced(); } catch {}
  try { logBus.stopSafe(`${STOP.reason} / 第 ${STOP.epoch} 代`); } catch {}
  try { eventRecorder.flush(); } catch {}
  try {
    const frozen = sessionMgr.finalize("stop");
    if (frozen && frozen.ok) {
      logBus.write({ category: "artifact", level: "warn", epoch: STOP.epoch,
        message: `急停：会话 ${frozen.conversationId} 已冻结为只读快照（${frozen.dir}）` });
    }
  } catch {}
  console.log(`[stop] 急停生效（第 ${STOP.epoch} 代）：${STOP.reason}`);
  let staled = 0;
  try {
    const bumped = ticketStore.bumpEpoch(STOP.reason);
    staled = bumped.staled;
    /* 以工单表的世代为准（它是落盘的那份）。正常情况下两者本就相等，
     * 这里只是防止某条路径漏抬一次导致长期漂移 —— 漂移的后果是"急停后
     * 任务仍被当成当代"，属于一次就够毁掉整个语义的错误。 */
    if (Number(bumped.epoch) !== Number(STOP.epoch)) {
      console.log(`[stop] 世代号不一致（内存 ${STOP.epoch} / 工单表 ${bumped.epoch}），以工单表为准`);
      STOP.epoch = Number(bumped.epoch);
    }
  } catch (err) {
    console.log("[stop] 作废工单失败：", err?.message ?? err);
  }
  try { guiLock.setEpoch(STOP.epoch); } catch { /* 锁没起也无所谓 */ }
  try { disarmTriggers(); } catch {}
  const killed = killActiveProcs();     // 关键：连正在跑的子进程一起干掉
  console.log(`[stop] 已终止 ${killed} 个在跑的子进程`);
  // MCP 内部的长任务：没有在途调用就不动它，避免误触后每次操作都要重连
  const mcpCut = killInflightMcp();
  /* 通知走发件箱而不是直接 push：急停的反馈恰恰是最不能丢的一条，
   * 而 SSE 此刻可能正在断线重连。幂等键带上 epoch，重连后不会收到两遍。 */
  try {
    outbox.enqueue({
      kind: "notice",
      dedupe: `stop:${STOP.epoch}`,
      payload: { text: `已急停（第 ${STOP.epoch} 代）：终止 ${killed} 个子进程，中断 ${mcpCut.length} 个在途调用，作废 ${staled} 张工单` },
    });
    outbox.pump().catch(() => {});
  } catch (err) {
    console.log("[stop] 通知入箱失败：", err?.message ?? err);
  }
  /* 池里的排队项直接清掉：急停之后它们不该再"按顺序慢慢跑起来"。
   * 在跑的那些由上面的 killActiveProcs 统一杀，这里不重复动手。
   * ⚠️ 被清掉的必须**同时把 job 结算掉** —— 否则它们永远停在 running，
   * 面板会挂着几个永远转圈的任务（runBody 从未被调用，没有任何后续回调）。 */
  let droppedJobs = [];
  try { droppedJobs = pool.halt(STOP.reason).dropped || []; } catch {}
  for (const jid of droppedJobs) {
    const j = jobs.get(jid);
    if (!j) continue;
    const next = { ...j, status: "error", stopped: true, finishedAt: Date.now(), error: "急停：任务还在队列里，未开始执行" };
    jobs.set(jid, next);
    pushJobFinal(jid, next);
    settleJobTicket(next, "stopped", "急停清队");
  }
  LAST_STOP_REPORT = {
    on: STOP.on, at: STOP.at, reason: STOP.reason, epoch: STOP.epoch,
    killed, mcpCut: mcpCut.length, staled, dropped: droppedJobs.length,
  };
  return LAST_STOP_REPORT;
}

function doResume() {
  const wasOn = STOP.on;
  STOP.on = false;
  /* reopen 只恢复协议状态（stopped=false），不会自动重连扩展；扩展自己会重连并重新 hello/open。 */
  try { browserProvider.reopen(); } catch {}
  STOP.reason = "";
  console.log(`[stop] 已恢复（第 ${STOP.epoch} 代）`);
  try { armTriggers(); } catch {}
  /* 注意：恢复**不回退 epoch**。回退等于让旧世代重新有效，
   * 那些迟到的回调立刻就又能写状态了 —— 这正是要防的东西。 */
  if (wasOn) {
    try {
      outbox.enqueue({
        kind: "notice",
        dedupe: `resume:${STOP.epoch}`,
        payload: { text: `已恢复（第 ${STOP.epoch} 代）。上一世代的迟到回调会被拒收，需要续跑请重新派单` },
      });
      outbox.pump().catch(() => {});
    } catch {}
  }
  try { pool.resume(); } catch {}
  /* 恢复 = 新世代开新会话组，被冻结的旧组不复活。 */
  try { sessionMgr.start({ reason: "resume", epoch: STOP.epoch }); } catch {}
  return { on: STOP.on, epoch: STOP.epoch };
}

/* ---------------- 执行审计日志 ----------------
 * 记录"谁、何时、做了什么、结果如何"。出问题能回溯，也是合规的基础。
 * 落盘 <控制台>/audit/YYYY-MM-DD.jsonl（按天分文件、追加写）。
 * 只记**摘要**，不存 result 全文 —— 否则一条截图就能写出几 MB。
 */
/* 注意：这里是**执行审计**（谁在何时调了哪个工具、结果如何），不是运行日志。
 * 面板「设置 › 存储 › 执行审计日志」查看器读的就是这个目录，旧契约保持不动。
 * 新的结构化日志一律走 artifacts/<日期>/logs/，绝不写进本目录。 */
const AUDIT_DIR = path.join(DATA_DIR, "audit");
const AUDIT_KEEP_DAYS = 30;
const AUDIT_MEM_MAX = 500;
const AUDIT_MEM = [];          // 内存里留最近若干条，面板查询用（不必读磁盘）
let auditStream = null;
let auditDay = "";

function auditDayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function audit(rec) {
  const full = Object.assign({
    ts: Date.now(),
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false }),
  }, rec);
  AUDIT_MEM.push(full);
  if (AUDIT_MEM.length > AUDIT_MEM_MAX) AUDIT_MEM.splice(0, AUDIT_MEM.length - AUDIT_MEM_MAX);
  try {
    const day = auditDayKey();
    if (day !== auditDay) {
      if (auditStream) { try { auditStream.end(); } catch {} }
      fsSync.mkdirSync(AUDIT_DIR, { recursive: true });
      auditStream = fsSync.createWriteStream(path.join(AUDIT_DIR, day + ".jsonl"), { flags: "a" });
      // 磁盘满 / 目录变只读时流会抛 'error'：没有监听者就升级成未捕获异常，
      // 一条审计日志写不上去，结果把整个 bridge 带崩。
      auditStream.on("error", (e) => {
        console.log("[audit] 写入失败，本次审计跳过：", e?.message ?? e);
      });
      auditDay = day;
    }
    auditStream.write(JSON.stringify(full) + "\n");
  } catch { /* 审计写失败不能影响主流程 */ }
}

/** 清理超过保留期的审计文件（启动时跑一次） */
function auditCleanup() {
  try {
    const cutoff = Date.now() - AUDIT_KEEP_DAYS * 86400000;
    for (const f of fsSync.readdirSync(AUDIT_DIR)) {
      if (!f.endsWith(".jsonl")) continue;
      const t = new Date(f.replace(".jsonl", "") + "T00:00:00").getTime();
      if (Number.isFinite(t) && t < cutoff) {
        try { fsSync.unlinkSync(path.join(AUDIT_DIR, f)); } catch {}
      }
    }
  } catch {}
}

/* ---------------- 执行状态（AI 步骤可视化） ----------------
 * 让"正在跑什么"看得见，而不是黑盒等待。
 * 面板轮询 /api/live 拿这个，渲染成一条进度。 */
const LIVE = {
  active: false, kind: "", name: "", step: 0, total: 0,
  lastTool: "", note: "", startedAt: 0, finishedAt: 0, ok: null,
  /* 智能接管请求。非 null 时说明回放正卡在某一步等视觉层接手，
     面板轮询 /api/status 看到这个字段就去跑 runVision，跑完回调 /api/agent-done。
     为什么绕这一圈：视觉模型的密钥存在主进程（main.js 的 get-vision-key），
     bridge 是独立 Node 进程，拿不到 —— 所以它只能「把活儿挂出去等回答」。 */
  pendingAgent: null,
};

function liveStart(kind, name, total, note) {
  LIVE.active = true; LIVE.kind = kind; LIVE.name = name || "";
  LIVE.step = 0; LIVE.total = total || 0; LIVE.note = note || "";
  LIVE.lastTool = ""; LIVE.startedAt = Date.now(); LIVE.ok = null; LIVE.finishedAt = 0;
  audit({ source: kind, event: "start", name: LIVE.name, total: LIVE.total });
}

function liveStep(i, tool) {
  LIVE.step = i;
  if (tool) LIVE.lastTool = tool;
}

function liveEnd(ok, note) {
  LIVE.active = false; LIVE.ok = !!ok;
  LIVE.finishedAt = Date.now();
  LIVE.pendingAgent = null;          // 回放结束必须清掉，否则面板会一直以为有活儿要接手
  if (note) LIVE.note = note;
  audit({
    source: LIVE.kind || "job", event: "end", name: LIVE.name,
    ok: LIVE.ok, ms: LIVE.finishedAt - LIVE.startedAt, note: LIVE.note,
  });
}

/* ---------------- 消耗账本（任务 + 人格，记在同一个任务头上） ----------------
 * 为什么要有它：人格台词是「额外的一次调用」，如果只报任务本身的用量，
 * 用户看到的花费就不完整 —— 台词那笔成了看不见的支出。
 * 所以这里只维护一份「本次任务」的账：
 *   · 任务用量：从 CLI 的 result.usage 取（它给的是整轮累计，最可信）；
 *   · 台词用量：persona_bundle 那次调用自己报（自定义模型走 usage，CLI 走不到就记 0）。
 * 面板读 /api/status 的 live.tok 就能显示「任务 + 台词」的合计，
 * 任务结束后这条记录进 history，供积分弹窗按任务列出来。
 *
 * 归属的坑：人格台词和任务是两个并发的 /api/call，谁先回来不确定 ——
 * 台词先到就暂存在 pending 里，等任务开始再并进去；任务已经结束才到，
 * 就补给刚才那条历史记录（而不是算到下一个任务头上，那会张冠李戴）。 */
const TOK = {
  in: 0, out: 0, personaIn: 0, personaOut: 0,
  engine: "", model: "", pending: null, history: [],
};
const TOK_HISTORY_MAX = 20;
let tokOpen = false;

const usageIn = (u) => Math.max(0, Number(u && (u.input_tokens ?? u.prompt_tokens)) || 0);
const usageOut = (u) => Math.max(0, Number(u && (u.output_tokens ?? u.completion_tokens)) || 0);

function tokBegin(engine, model) {
  TOK.in = 0; TOK.out = 0; TOK.personaIn = 0; TOK.personaOut = 0;
  TOK.engine = engine || ""; TOK.model = model || "";
  tokOpen = true;
  if (TOK.pending) {   // 台词比任务先落地：并进这次任务
    TOK.personaIn += TOK.pending.in;
    TOK.personaOut += TOK.pending.out;
    TOK.pending = null;
  }
}

function tokAddTask(u) {
  TOK.in += usageIn(u);
  TOK.out += usageOut(u);
}

function tokAddPersona(u) {
  const i = usageIn(u), o = usageOut(u);
  if (!i && !o) return;
  if (tokOpen) { TOK.personaIn += i; TOK.personaOut += o; return; }
  const last = TOK.history[0];
  if (last && Date.now() - last.at < 120000) {   // 任务刚结束，台词迟到一步
    last.personaIn += i; last.personaOut += o;
    return;
  }
  TOK.pending = TOK.pending || { in: 0, out: 0 };
  TOK.pending.in += i;
  TOK.pending.out += o;
}

function tokEnd(ok) {
  if (!tokOpen) return;
  tokOpen = false;
  const rec = {
    at: Date.now(), ok: !!ok, engine: TOK.engine, model: TOK.model,
    in: TOK.in, out: TOK.out, personaIn: TOK.personaIn, personaOut: TOK.personaOut,
  };
  /* 一个字都没记账就不留痕：否则历史里会堆一堆全 0 的条目，读起来像坏了 */
  if (rec.in || rec.out || rec.personaIn || rec.personaOut) {
    TOK.history.unshift(rec);
    if (TOK.history.length > TOK_HISTORY_MAX) TOK.history.length = TOK_HISTORY_MAX;
  }
  return rec;
}

/** 给 /api/status 用的快照。total 就是「整体任务」的合计（含人格那笔）。 */
function tokSnapshot() {
  return {
    engine: TOK.engine,
    model: TOK.model,
    in: TOK.in,
    out: TOK.out,
    personaIn: TOK.personaIn,
    personaOut: TOK.personaOut,
    persona: TOK.personaIn + TOK.personaOut,
    total: TOK.in + TOK.out + TOK.personaIn + TOK.personaOut,
  };
}


/* ---------------- 智能接管：bridge ⇄ 面板握手 ----------------
 * 一次接管 = 挂出请求 → 阻塞等面板回答。阻塞是必须的：
 * 回放正在半路停下，后面每步都依赖「现在屏幕处于什么状态」，
 * 不能放它继续跑。所以用 promise 挂起，且**必须有超时**——
 * 面板被用户收起时轮询会停，没人接这个活儿，不超时就永远卡死。 */
const WAITER = { agent: null };    // { resolve, reject, timer }
const AGENT_WAIT_MS = 180000;      // 单轮接管最长等 3 分钟（含模型往返）

function askPanelForAgent(payload, timeoutMs = AGENT_WAIT_MS) {
  return new Promise((resolve, reject) => {
    if (WAITER.agent) {             // 上一轮没结算：先拒掉，否则两个 resolve 抢同一个 promise
      try { clearTimeout(WAITER.agent.timer); WAITER.agent.reject(new Error("被新的接管请求覆盖")); } catch { /* ignore */ }
      WAITER.agent = null;
    }
    const timer = setTimeout(() => {
      WAITER.agent = null;
      LIVE.pendingAgent = null;
      reject(new Error(`接管等待超时（${Math.round(timeoutMs / 1000)}s 无回应）`
        + `——面板可能已收起，或视觉模型还没配置`));
    }, timeoutMs);
    WAITER.agent = { resolve, reject, timer };
    LIVE.pendingAgent = payload;
    log(`[agent] 挂出接管请求：第 ${payload.stepNo}/${payload.totalNo} 步，本批 ${payload.batch} 步`);
  });
}

/** 面板回报后结算挂起的 promise。返回是否真的有人等着（没人等就说明超时已过，丢弃即可）。 */
function settleAgent(payload) {
  LIVE.pendingAgent = null;
  const w = WAITER.agent;
  WAITER.agent = null;
  if (!w) return false;
  clearTimeout(w.timer);
  if (payload && payload.ok === false) w.reject(new Error(String(payload.error || "面板接管失败").slice(0, 300)));
  else w.resolve(payload || {});
  return true;
}

/* ---------------- 危险操作确认 ----------------
 * 与急停互补：急停是「事后踩刹车」，这里是「事前拦一下」。
 * 命中 DANGER_TOOLS 的操作会**挂起**等人确认；**无人确认就超时拒绝**——
 * 安全默认必须是"拒绝"，绝不能因为没人管就自动放行。
 */
/* 危险清单改成**可配置**（原来是硬编码的 Set，想加一个得改源码再重启）。
 *
 * 两类规则：
 *   tools  —— 整个工具都危险（命中即拦）
 *   args   —— 只在参数匹配时危险（比如 FileSystem 只有 delete 才拦，
 *              read/list 不该每次都打扰人）
 * 依然**故意不做正则**：正则写歪会把危险命令一起放行，那还不如每次点一下。 */
// ORB_DANGER_FILE 同样只给离线单测用
const DANGER_FILE = process.env.ORB_DANGER_FILE || path.join(DATA_DIR, "danger-tools.json");
const DANGER_DEFAULTS = {
  tools: ["PowerShell"],
  args: {
    FileSystem: [{ mode: "delete" }],
    /* 命令通道：这三类另有"代码级硬闸"兜底（见 cmdDanger.mjs）——
       列出是为了配置文件自解释；即便老机器的 danger-tools.json 没有这段，也拦得住。 */
    CommandChannel: [{ op: "move" }, { op: "rename" }, { op: "copy", overwrite: "true" }],
  },
};
let DANGER = structuredClone(DANGER_DEFAULTS);
const DANGER_TOOLS = new Set(DANGER.tools);   // 兼容老代码：只放"整工具危险"的那部分

function loadDanger() {
  try {
    const j = JSON.parse(fsSync.readFileSync(DANGER_FILE, "utf8"));
    DANGER.tools = Array.isArray(j?.tools) ? j.tools.map(String) : [...DANGER_DEFAULTS.tools];
    DANGER.args = (j && typeof j.args === "object" && j.args) ? j.args : structuredClone(DANGER_DEFAULTS.args);
  } catch {
    DANGER = structuredClone(DANGER_DEFAULTS);
  }
  DANGER_TOOLS.clear();
  for (const t of DANGER.tools) DANGER_TOOLS.add(t);
}

function saveDanger() {
  try { writeJsonAtomic(DANGER_FILE, DANGER); } catch {}
}

loadDanger();

/** 参数规则命中了吗：任一规则的所有字段都对上才算命中。 */
function dangerByArgs(tool, args) {
  const rules = DANGER.args?.[tool];
  if (!Array.isArray(rules) || !args) return false;
  return rules.some((r) =>
    r && typeof r === "object" &&
    Object.keys(r).every((k) => String(args[k] ?? "").toLowerCase() === String(r[k]).toLowerCase()));
}
const CONFIRM_TIMEOUT_MS = 60000;
const approvals = new Map();                    // id -> { id, server, tool, args, at, timer, resolve }
let confirmSeq = 0;

/* 危险操作白名单：把"反复执行、你信得过"的命令记下来，避免每次都要点确认。
 * 只支持 prefix（前缀）/ exact（完全相同）两种匹配 —— 故意不做正则，
 * 因为正则写歪了会把危险命令一起放行，那还不如每次点一下。 */
const WHITELIST_FILE = process.env.ORB_WHITELIST_FILE || path.join(DATA_DIR, "approvals.json");
/* prefix 模式下存多少字。原来只取 120 —— 一条稍长的命令被截断后，
   后面换了个参数就匹配不上了（"同意过"却还要再问一次），形同虚设。
   这里放宽到 1000，并在存之前做一次提示：真超过 1000 字的命令建议用 exact。 */
const WL_PREFIX_MAX = 1000;
let whiteList = [];

function loadWhiteList() {
  try {
    const arr = JSON.parse(fsSync.readFileSync(WHITELIST_FILE, "utf8"));
    whiteList = Array.isArray(arr) ? arr : [];
  } catch { whiteList = []; }
}

function saveWhiteList() {
  try { writeJsonAtomic(WHITELIST_FILE, whiteList); } catch {}
}

function cmdOf(args) {
  if (!args) return "";
  return String(args.command ?? args.script ?? args.text ?? args.path ?? "").trim();
}

function isWhitelisted(tool, args) {
  const cmd = cmdOf(args);
  if (!cmd) return false;
  return whiteList.some((w) => {
    if (!w || !w.pattern) return false;
    if (w.tool && w.tool !== tool) return false;
    return w.mode === "exact" ? cmd === w.pattern : cmd.startsWith(w.pattern);
  });
}

loadWhiteList();

function isDangerous(server, tool, args) {
  if (server !== "windows") return false;
  if (DANGER_TOOLS.has(tool)) return true;
  return dangerByArgs(tool, args);   // 例如 FileSystem 只有 delete 才拦，read/list 不该打扰用户
}

/* 命令通道危险判定：**硬闸优先，配置兜底**。
 * move/rename/copy+overwrite 会令源消失或毁目标 —— 无条件需确认，不受旧 danger-tools.json
 * / 白名单影响（旧配置不会自动补齐新规则，靠配置会漏）。其余（write/launch/openWith/
 * 非覆盖 copy）交给可配置 DANGER，口径与既有治理层完全一致。 */
function commandChannelDanger(body = {}) {
  const args = commandChannelArgs(body);
  const hard = hardDangerOp(args);
  if (hard) return { danger: true, reason: hard, args, hard: true };
  const danger = DANGER_TOOLS.has("CommandChannel") || dangerByArgs("CommandChannel", args);
  return { danger, reason: danger ? "命中可配置危险规则" : "", args, hard: false };
}

function listPending() {
  return [...approvals.values()].map((a) => ({ id: a.id, tool: a.tool, args: a.args, at: a.at, ticketId: a.ticketId || "" }));
}

/* 11-07 简报 §3.1 hermes「No, and tell Hermes what to do instead」：
 * 一次交互里同时否决 + 给纠正。旧实现里「否决」只是抛个拒绝文案，
 * 用户想说「别这么干，改成那样」必须再打一次 /api/tickets，等于两轮。
 * extra = { correction, ticketId, replan }；否决且带纠正时同步写入 ticketCtl 的
 * steers（correct）或重排（rethink），并把结果回给等待方，不另起一轮。 */
function resolveApproval(id, allow, reason, remember, extra = {}) {
  const a = approvals.get(id);
  if (!a) return false;
  clearTimeout(a.timer);
  approvals.delete(id);

  // 「允许并记住」：把这条命令写进白名单
  if (allow && remember) {
    const cmd = cmdOf(a.args);
    if (cmd) {
      // 默认 exact（完全相同才放行）最安全；prefix 需要显式指定
      const mode = remember === "prefix" ? "prefix" : "exact";
      const pattern = mode === "prefix" ? cmd.slice(0, WL_PREFIX_MAX) : cmd;
      if (mode === "prefix" && cmd.length > WL_PREFIX_MAX) {
        console.log(`[whitelist] 提示：命令超过 ${WL_PREFIX_MAX} 字，前缀只存了前 ${WL_PREFIX_MAX} 字；` +
          '之后参数一变就匹配不上，这种情况建议用「exact」。');
      }
      if (!isWhitelisted(a.tool, a.args)) {
        whiteList.push({ tool: a.tool, mode, pattern, addedAt: Date.now() });
        saveWhiteList();
        console.log(`[whitelist] 新增 ${mode}：${pattern.slice(0, 60)}`);
      }
    }
  }

  const correction = String(extra.correction || "").trim().slice(0, 2000);
  const ticketId = String(extra.ticketId || a.ticketId || "").trim();
  const veto = !allow && !!correction;
  let steer = null;
  if (veto) {
    try {
      steer = ticketCtl.control(ticketId, extra.replan ? "rethink" : "correct", { text: correction });
      log(`[confirm] 否决并纠正：${ticketId || "(无工单号)"} → ${correction.slice(0, 60)}`);
    } catch (e) {
      steer = { ok: false, error: String(e?.message ?? e) };
    }
  }

  a.resolve({
    allow: !!allow,
    reason: reason || (allow ? "已允许" : (veto ? "已否决并给出纠正" : "已拒绝")),
    veto, correction, ticketId, replan: !!extra.replan, steer,
  });
  return true;
}

function waitApproval(server, tool, args, meta = {}) {
  const id = "c" + (++confirmSeq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      approvals.delete(id);
      console.log(`[confirm] ${id} 超时未确认，按拒绝处理`);
      resolve({ allow: false, reason: "超时未确认（安全默认：拒绝）" });
    }, CONFIRM_TIMEOUT_MS);
    approvals.set(id, { id, server, tool, args, ticketId: String(meta.ticketId || ""), at: Date.now(), timer, resolve });
    console.log(`[confirm] 等待确认：${tool} ${JSON.stringify(args).slice(0, 120)}`);
  });
}

function interp(v, ctx) {
  if (typeof v === "string") {
    return v.replace(/\{\{(\w+)\}\}/g, (_, k) => (ctx.vars[k] === undefined ? "" : String(ctx.vars[k])));
  }
  if (Array.isArray(v)) return v.map((x) => interp(x, ctx));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v)) o[k] = interp(v[k], ctx);
    return o;
  }
  return v;
}

/** 条件求值：支持「变量条件」和「工具条件」两种 */
async function evalWhen(when, ctx) {
  if (!when) return true;

  if (when.var) {
    const val = ctx.vars[when.var];
    if ("equals" in when) return String(val) === String(interp(when.equals, ctx));
    if ("contains" in when) return String(val ?? "").includes(String(interp(when.contains, ctx)));
    return !!val;
  }

  // 工具条件：调一次工具，拿它的文本结果做判断（如 Snapshot 里有没有"稍后再说"）
  if (when.tool) {
    const r = await callTool(when.server || "windows", when.tool, interp(when.args || {}, ctx), CALL_TIMEOUT_MS);
    const text = typeof r === "string" ? r : JSON.stringify(r ?? "");
    if ("contains" in when) return text.includes(String(when.contains));
    if ("notContains" in when) return !text.includes(String(when.notContains));
    return !!text;
  }
  return true;
}

async function runSteps(steps, ctx, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error(`嵌套层数超过上限（${MAX_DEPTH}）`);
  const list = steps || [];
  let i = 0;
  while (i < list.length) {
    // 急停检查已下沉到 callToolRaw 入口（覆盖全部调用路径），此处不再重复。
    /* 智能体判定最终目标已达成：整条流程收工。
       只 return 不够 —— 嵌套层返回只能结束本层，父层循环还会跑下一轮。 */
    if (ctx.finished) return;
    const idemBefore = ctx.lastIdem;
    const sig = await runNode(list[i], ctx, depth);
    if (sig && sig.downgraded) {
      /* 这一步「配了锚点却找不到」——界面变了。交给接管层处理：
         它会让视觉智能体推进几小步，再探一次是否已回到原轨道。 */
      const back = await takeover(list, i, ctx);
      if (back === null) {
        throw new Error(`第 ${ctx.step} 步「${sig.anchor || sig.tool}」定位失败，智能接管也没能回到原流程`);
      }
      if (back === "fallback") {
        /* once 模式没救回来：退回录制坐标把这一步做掉，同时把策略降级，
           否则同一步会反复触发接管，一路卡在这里。 */
        log(`[agent] 单点救援未果，第 ${ctx.step} 步改用录制坐标继续`);
        ctx.escalate = "off";
        continue;                       // 不 i++，重跑这一步
      }
      i = back;
      continue;
    }
    /* 断点只认「这一步真产生了一条已结算收据」的边界。
       纯 set 这类不落收据的步不推进断点 —— 让断点稍微滞后一点，
       总比让断点声称"后面几步也做完了"要安全（只是多跑几步本地赋值）。 */
    if (depth === 0 && typeof ctx.onStepDone === "function"
      && ctx.lastIdem && ctx.lastIdem !== idemBefore) {
      try {
        ctx.onStepDone((Number(ctx.baseIndex) || 0) + i + 1);
      } catch { /* 断点写失败绝不影响回放：它是观测，不是执行前提 */ }
    }
    i++;
  }
}

async function runNode(s, ctx, depth) {
  if (!s || typeof s !== "object") return null;
  const type = s.type || "action";

  if (type === "set") {
    ctx.vars[s.name] = interp(s.value, ctx);
    return null;
  }

  if (type === "loop") {
    const saveI = ctx.vars.i;
    const saveScopes = ctx.scopes;
    /* scope 栈要复制一层再压：直接用原数组的话，兄弟节点会互相踩，
       而且 pop 之后外面那层的引用就断了。 */
    ctx.scopes = (ctx.scopes || []).slice();
    if (s.while) {
      /* while 型不需要轮次对齐 —— 它的退出条件是每轮重算的，
         接管把剩下的干完了，条件自然变 false，循环自己就停了。 */
      let n = 0;
      ctx.scopes.push({ kind: "while", iter: () => n, jumpTo: () => false, pending: null });
      while (n < MAX_WHILE && (await evalWhen(s.while, ctx))) {
        if (ctx.finished) break;
        ctx.vars.i = n;
        await runSteps(s.body, ctx, depth + 1);
        n++;
      }
      if (n >= MAX_WHILE) console.log(`[wf] while 达到上限 ${MAX_WHILE}，已强制停止`);
      ctx.scopes.pop();
    } else {
      const times = Math.max(0, Number(interp(s.times ?? 1, ctx)) || 0);
      let n = 0;
      const mark = s.mark || null;
      const since = Number(ctx.startedAt) || 0;
      const scope = {
        kind: "times", total: times, mark, pending: null, since,
        /* 每轮几次标记动作：用户手填 > 静态数循环体 > 1。
           静态数是主来源 —— 答案本来就写在 body 里，不用问人，也不用示范。 */
        markPerRound: (mark && Number(mark.perRound) > 0)
          ? Number(mark.perRound)
          : Math.max(1, countMarkInSteps(s.body, mark) || 1),
        lastRoundCount: 0,          // 上一轮实测点了几次，用来覆盖静态数
        iter: () => n,
        /* 只能往前跳，且不能超过总轮数。
           倒退等于把已经做过的事重做一遍（可能重复提交），一律拒绝；
           跳到 times 则表示全部做完，循环会自然退出。 */
        jumpTo: (v) => {
          if (!canJump(n, v, times)) return false;
          scope.pending = v;
          return true;
        },
      };
      ctx.scopes.push(scope);
      // 取原始次数（不除 perRound）：perRound 传 1 让 countMarks 直接返回条数
      const rawCount = () => (mark
        ? countMarks(AUDIT_MEM, since, Object.assign({}, mark, { perRound: 1 }))
        : null);
      while (n < times) {
        if (ctx.finished) break;
        ctx.vars.i = n;
        scope.pending = null;
        const rawBefore = rawCount();
        await runSteps(s.body, ctx, depth + 1);
        /* 实测本轮点了几次。循环体里有分支时静态数会偏，
           用实测值覆盖，下一轮自动收敛；0 次说明这轮没走那条路，不覆盖。 */
        const rawAfter = rawCount();
        if (rawBefore !== null && rawAfter !== null && rawAfter > rawBefore) {
          scope.lastRoundCount = rawAfter - rawBefore;
        }
        // 接管对齐过轮次 → 直接跳到目标轮，不能再 +1（否则白跑一轮）
        n = (scope.pending === null) ? n + 1 : scope.pending;
      }
      ctx.scopes.pop();
    }
    ctx.scopes = saveScopes;   // 还原，避免嵌套循环互相污染
    ctx.vars.i = saveI;
    return null;
  }

  if (type === "if") {
    const hit = await evalWhen(s.when, ctx);
    await runSteps(hit ? s.then : s.else, ctx, depth + 1);
    return null;
  }

  // 默认：普通动作（老自动化的步骤没有 type，走这里）
  ctx.step = (ctx.step || 0) + 1;
  liveStep(ctx.step, s.tool);
  // 抗迁移：先按窗口锚定 / 文字锚定 / 兜底重算坐标，再回放
  const { args: actArgs, conf, element } = await resolveAnchor(s);
  ctx.lastConf = conf;
  /* S4：resolveAnchor 在降级裁决命中时给 element 挂 degradation 标记。
   * 此时**绝不能**因为 conf==='absolute' 就 return downgraded 触发 takeover（视觉循环），
   * 否则等于"降级又接回 runVision()"。改走录制坐标/窗口兜底，并按 degradeTo 处理。 */
  const degradation = element && element.degradation;

  if (degradation && degradation.code) {
    log(`[s4] 第 ${ctx.step} 步降级（${degradation.code} → ${degradation.degradeTo}），不进视觉接管：${degradation.reason}`);
    try {
      logBus.write({ category: "safety", level: "warn", epoch: epochOf(),
        message: `[s4] 单步降级脱离视觉循环：${degradation.code} / ${degradation.degradeTo}（step=${s.tool}）` });
    } catch {}
    if (degradation.degradeTo === "human") {
      throw new Error(`第 ${ctx.step} 步「${s.tool}」需要人工处理（${degradation.code}）：${degradation.reason}`);
    }
    // window / absolute / structured：直接按已算好的（降级）坐标继续，不升级视觉，照常往下执行动作。
  } else if (conf === "absolute") {
    /* 配了锚点却落到录制坐标 = 真降级，界面上那个文字找不到了。
       三种处置由自动化的 escalate 决定。 */
    if (ctx.escalate === "stop") {
      throw new Error(`第 ${ctx.step} 步「${(s.args && s.args.anchor) || s.tool}」在界面上找不到，已按「遇到意外就停」停下`);
    }
    /* 嵌套层（loop / if 的 body）现在也接管，但只在**同一层**回归：
       失守发生在 body 里，就让智能体在 body 里顶，回到 body 的某一步继续。
       父层的循环次数、分支选择、迭代变量完全不受影响 —— 这是 UiPath
       Retry Scope 的作用域语义，也是唯一不会搞乱控制流的接法。 */
    if (ctx.escalate === "agent" || ctx.escalate === "once") {
      // 预测降级：锚点没找到 = 界面变了，语义对应 STALE_REF。
      return { downgraded: true, conf, tool: s.tool, anchor: (s.args && s.args.anchor) || "", code: ACTION_ERROR_CODES.STALE_REF };
    }
  }

  // 方案 B：真实动作失败按结构化错误码决策升级，不再只会「整条抛错挂掉」。
  // conf==='absolute' 的「预测降级」已在上面提前 return 触发接管；这里覆盖的是
  // 高可信锚定（tree/text/window/none）却仍被工具拒绝的情形。
  const hadRef = conf === "tree" || conf === "text" || !!(s.args && s.args.anchor);
  // 方案 E：verify 环（opt-in，只记日志、不阻断）。动作前抓一次控件树当基线，
  // 动作后再抓一次比对指纹；只在明显"没生效"时告警，供人排查 / 后续接重锚。
  const VERIFY_ON = process.env.ORB_VERIFY === "1";
  let beforeVerifyText = null;
  if (VERIFY_ON) { try { beforeVerifyText = await getSnapshotText(8000); } catch { /* 抓不到就跳过 verify */ } }

  /* 动作级幂等键：同一次运行的同一步必须稳定复算出同一个键。
     用 ctx.step（每执行一次动作就 +1，循环里重复执行也算新步）而不是静态下标 ——
     静态下标会让循环第 2 轮被误判成「这一步做过了」而整段跳过。 */
  const actArgsNow = interp(actArgs, ctx);
  const idemKey = stepIdemKey({
    runId: ctx.runId, stepNo: ctx.step, server: s.server, tool: s.tool, args: actArgsNow,
  });
  /* 风险档由能力清单给，不由配方自称。未登记的工具一律按不可逆处理（fail-closed）。 */
  const risk = riskOf({ readOnly: isReadOnly(s.server, s.tool), revocable: revocableOf(s.server, s.tool) });

  /* 有限重试：只有「界面漂移类错误码 + 动作可逆 + 未达上限」三条同时成立才重试。
     桌面 GUI 与云端不同 —— 点过「提交」再点一次就是提交两次，所以默认 maxAttempts=2，
     而且不可逆动作直接判死，不看错误码。 */
  let attempt = 0;
  let failure = null;
  let out = null;
  for (;;) {
    attempt++;
    try {
      out = await callTool(s.server, s.tool, actArgsNow, s.timeoutMs ?? CALL_TIMEOUT_MS);
      failure = null;
      break;
    } catch (err) {
      const code = classifyActionError(String(err?.message ?? err), { hadRef });
      const rt = shouldRetry({ code, risk, attempt, hadRef });
      if (rt.retry) {
        if (ctx.q) ctx.q.retries = (ctx.q.retries || 0) + 1;
        traceStep(ctx, { no: ctx.step, tool: s.tool, server: s.server, conf, attempt,
          ok: false, code, retryIn: rt.delayMs, message: String(err?.message ?? err) });
        await sleep(rt.delayMs);
        continue;
      }
      failure = { err, code, rt };
      break;
    }
  }

  if (failure) {
    const { err, code } = failure;
    const decision = decideEscalation(code, { escalate: ctx.escalate });
    if (decision === "hard-stop") {
      // 权限/急停拒绝：绝不重试、绝不升级视觉（确认交人），直接硬停。
      traceStep(ctx, { no: ctx.step, tool: s.tool, server: s.server, conf, attempt, ok: false, code, message: "hard-stop" });
      throw new Error(`第 ${ctx.step} 步「${s.tool}」被权限/急停拒绝（${code}），已停止并交人工处理：${String(err?.message ?? err)}`);
    }
    if (decision === "takeover" && !(degradation && degradation.code)) {
      // STALE_REF / AMBIGUOUS_TARGET / WINDOW_GONE / UNKNOWN + escalate∈{agent,once}：
      // 交给接管层按视觉推进。S4：已判降级的步骤即便动作失败也**不接回 runVision()**，
      // 落到下面 off/stop 分支原样抛出交人工，避免降级→失败→又进视觉循环的回环。
      if (ctx.q) ctx.q.anchorFallbacks++;   // 抗迁移三道防线失守一次，记账不改行为
      traceStep(ctx, { no: ctx.step, tool: s.tool, server: s.server, conf, attempt,
        ok: false, code, downgraded: true, message: String(err?.message ?? err) });
      return { downgraded: true, conf, tool: s.tool, anchor: (s.args && s.args.anchor) || "", code };
    }
    // off / stop 且真实失败（含 UNKNOWN）：原样抛出，由 wfPlay 捕获上报（行为不变）。
    traceStep(ctx, { no: ctx.step, tool: s.tool, server: s.server, conf, attempt, ok: false, code,
      message: String(err?.message ?? err) });
    throw err;
  }

  /* 本次真的执行完毕：结算幂等收据。
     收据是「这一步确实做成了」的独立痕迹 —— 同 key 再来一次会被识别成已完成，
     断点续跑与重复点火都据此判断，不必猜。写不进去绝不影响回放。 */
  try {
    const iss = wfReceipts.issue({ idempotencyKey: idemKey, effect: { server: s.server, tool: s.tool } });
    if (iss && iss.receiptId && !iss.duplicate) wfReceipts.settle(iss.receiptId, { ok: true, result: { step: ctx.step } });
    /* 交给 runSteps 记断点：只有真的落了收据的这一步，才是可确认的续跑边界。 */
    ctx.lastIdem = idemKey;
  } catch { /* 收据是观测，不是执行前提 */ }

  /* 只读动作的回读计数：判只读配方「有没有真的拿到东西」时唯一的客观依据。 */
  const isRead = READ_TOOLS_FOR_REC.has(s.tool) || isReadOnly(s.server, s.tool);
  if (isRead) {
    const txt = toolTextOf(out);
    if (txt && String(txt).trim() && ctx.q) ctx.q.readbacks = (ctx.q.readbacks || 0) + 1;
  }
  traceStep(ctx, { no: ctx.step, tool: s.tool, server: s.server, conf, attempt, ok: true,
    readonly: isRead, idem: idemKey.slice(-8) });

  if (VERIFY_ON) {
    try {
      await sleep(120);                 // 给界面一点时间落定，避免读到"还没来得及变"的旧树
      snapTreeCache.clear();            // 清掉动作前缓存，强制拿动作后的新树
      const afterVerifyText = await getSnapshotText(8000);
      const mutating = !READ_TOOLS_FOR_REC.has(s.tool);
      const v = verifyEffect({ beforeText: beforeVerifyText, afterText: afterVerifyText, mutating });
      if (!v.ok) {
        if (ctx.q) ctx.q.verifyFailed++;
        log(`[verify] 第 ${ctx.step} 步「${s.tool}」疑似未生效：${v.reason}`);
      }
    } catch { /* verify 失败绝不影响回放 */ }
  }
  if (ctx.gap) await sleep(ctx.gap);
  return null;
}

/** 写一条步级轨迹。没有 runId（内部直调 / 单测）时静默跳过。 */
function traceStep(ctx, entry) {
  if (!ctx || !ctx.runId) return;
  /* 子流程共享父级 runId，并打上 node 标记。
     不共享的话，子流程内部的断点只能从父层那句"子流程失败了"往前猜 ——
     而子流程恰恰是最容易藏住"第几步"的地方（它有自己的 steps 数组）。 */
  const e = ctx.traceNode ? Object.assign({}, entry, { node: String(ctx.traceNode), nested: true }) : entry;
  try { wfTrace.step(ctx.runId, e); } catch { /* 轨迹失败不影响执行 */ }
}

/** 回放：支持编排节点；失败立即停并汇报 */
async function wfPlay(name, opts = {}) {
  const file = wfFile(name);
  let wf;
  try { wf = JSON.parse(fsSync.readFileSync(file, "utf8")); }
  catch { throw new Error(`读不到自动化：${name}`); }

  const gap = Number(opts.gap ?? wf.gap ?? 700);
  /* escalate：界面变了怎么办。
     off   —— 老行为，直接按录制坐标点下去（默认，不改变既有自动化的语义）
     stop  —— 立刻停并报错（宁可不做，也不乱点）
     once  —— 先问一次视觉模型，救不回来再用录制坐标顶上
     agent —— 交给视觉智能体分几小步推进，每批停下探一次是否回到原轨道 */
  const escalate = ["off", "stop", "once", "agent"].includes(wf.escalate) ? wf.escalate : "off";
  const subDepth = Number(opts._depth) || 0;
  /* 人工批准：由调用方（面板点「批准」/ 外部通道）传进来，只认节点 id。
     不给就一律当作未批准 —— fail-closed，绝不让"没人批过"变成"默认放行"。 */
  const approvedSet = new Set(
    (Array.isArray(opts.approved) ? opts.approved : []).map((x) => String(x)),
  );

  /* 受限编排：配方带 graph 段时以图为准（拓扑序 + 子流程 + 人工闸门），
     steps 退化成图里 step 节点的默认动作序列。
     图有环 / 引用不存在的节点 / 节点类型不认识 → 直接拒绝，不跑半张图。 */
  let plan = null;
  let steps = wf.steps || [];
  if (wf.graph && typeof wf.graph === "object") {
    const p = planOrder(wf.graph, { vars: Object.assign({}, wf.vars || {}), ...(opts.env || {}) });
    if (!p.ok) throw new Error(`编排图不合法，拒绝执行：${(p.errors || []).join("；")}`);
    plan = p.plan || [];
    for (const w of p.warnings || []) log(`[wf] 编排警告（${name}）：${w}`);
  }

  /* 断点续跑：跳过前 resumeFrom 个顶层步（0 基）。
     调用方（/api/wf resume）已经用 canResume 过了一遍安全门，这里仍要校一次区间 ——
     入参来自外部，只信任上游是不够的。skipRead 会改变步索引，与续跑互斥。 */
  let resumeFrom = 0;
  if (opts.resumeFrom != null && opts.resumeFrom !== "" && Number(opts.resumeFrom) !== 0) {
    if (opts.skipRead) throw new Error("skipRead 与断点续跑不能同时用：前者会改变步索引，续跑位置会错位");
    if (plan) throw new Error("编排图配方不支持断点续跑（节点内会重复执行同一段）");
    const n = Number(opts.resumeFrom);
    if (!Number.isInteger(n) || n < 1 || n >= steps.length) {
      throw new Error(`续跑起点不合法：${opts.resumeFrom}（配方共 ${steps.length} 步，合法范围 1..${steps.length - 1}）`);
    }
    resumeFrom = n;
  }

  const ctx = {
    runId: String(opts.runId || ""),      // 有 runId 才写步级轨迹；内部直调不写
    vars: Object.assign({}, wf.vars || {}),
    gap,
    goal: String(wf.goal || ""),          // 给智能体看的最终目标，接管时原样拼进提示词
    escalate,
    agentBudget: Number(wf.agentBudget) || 0,
    lastConf: "none",
    startedAt: Date.now(),                // 轮次推定的时间基线：只数这次运行之后的动作
    scopes: [],                           // 循环作用域栈：接管靠它知道「在哪一层、第几轮」
    finished: false,                      // 智能体判定最终目标已达成 → 整条流程收工
    /* 回放质量计数：确定性执行有没有退化成视觉摸索。只统计，不改任何执行语义。
       运行账本据此回答「这条菜谱在 observe 一周里值不值得升 auto」。
       retries / readbacks 是 2026-11-08 新增的独立观测量：
       前者数重试，后者数只读动作真的拿到了数据（只读配方的唯一判据）。 */
    q: { takeovers: 0, verifyFailed: 0, skippedRead: 0, anchorFallbacks: 0, retries: 0, readbacks: 0 },
    baseIndex: resumeFrom,                // 顶层步的原始下标基准（续跑时非 0）
    lastIdem: "",                         // 最近一条已结算收据的幂等键 → 断点的确认凭据
    /* S4 独立刹车：本次回放的视觉循环预算。每次进入 takeover 记一轮，耗尽即脱离，
     * 与 AGENT_MAX_ROUNDS 相互独立、取其更严者 —— 即便 escalation 配置再宽松也不无限截图。 */
    s4VisualBudget: createVisualLoopBudget(Number(wf.visualLoopBudget) || AGENT_MAX_ROUNDS),
  };

  /* 断点：线性配方每完成一个「已结算」的顶层步就落一次，失败时它就是救命记录。
     含 loop / if / subflow / graph 的配方一律不落 —— 顶层索引表达不了循环体中间的位置，
     落下去只会诱导人去续跑一个本来就跑不准的点。 */
  let resumeCapable = false;
  {
    const linearSelf = plan ? { ok: false } : isLinearRecipeWf(wf);
    resumeCapable = !!linearSelf.ok;
    if (resumeCapable) {
      ctx.onStepDone = (nextIndex) => {
        wfCps.save(name, {
          workflow: wf.name || name,
          runId: ctx.runId,
          nextIndex,
          total: (Array.isArray(wf.steps) ? wf.steps.length : 0),
          /* 内容指纹：只比步数会漏掉"步数没变但某步被改过"，那种情况续跑会接错位置。 */
          stepsDigest: recipeDigest(wf.steps),
          vars: ctx.vars,
          lastIdem: ctx.lastIdem,
        });
      };
    }
  }

  if (opts.skipRead) {
    // 只跳过顶层的只读动作；编排节点原样保留
    const before = steps.length;
    steps = steps.filter((s) => !(s.type === undefined && READ_TOOLS_FOR_REC.has(s.tool)));
    ctx.q.skippedRead = before - steps.length;
  }

  /* 结果判据与探测计划：配方没声明 postconditions 时，唯一能拿到的客观证据就是
     「整条运行有没有真的改变界面」。纯只读配方没有副作用可观测，改用回读计数判。
     探测失败一律当"没拿到证据"，绝不因此判成功 —— 这是 OutcomeGate 的红线。 */
  const spec = buildSpec(wf);
  const flatSteps = plan ? plan.flatMap((it) => (it.kind === "step"
    ? (Array.isArray(it.node.steps) ? it.node.steps : steps) : [])) : steps;
  const mutating = flatSteps.some((s) => s && s.type === undefined && !READ_TOOLS_FOR_REC.has(s.tool));
  const readonlyRun = !mutating;
  const needProbe = opts.noProbe === true ? false : ((spec.postconditions || []).length === 0 && mutating);
  let beforeText = null;
  if (needProbe) {
    try { snapTreeCache.clear(); beforeText = await getSnapshotText(6000); } catch { /* 抓不到就退成"没证据" */ }
  }

  const totalForLive = plan ? plan.length : steps.length;
  // 标记来源 + 推送实时状态（面板靠这个显示进度，不再是黑盒等待）
  const prevSource = CURRENT_SOURCE;
  CURRENT_SOURCE = opts.source || "workflow";
  ctx.step = 0;
  /* 子流程不再自己 begin/end、也不再抢实时进度：它和父流程共用一条轨迹与一个进度条。
     否则每进一层子流程，面板上的「第 N/M 步」会跳回 0，看着像重新开始了。 */
  const nested = subDepth > 0;
  if (nested) ctx.traceNode = String(opts._traceNode || wf.name || name);
  if (!nested) liveStart(CURRENT_SOURCE, wf.name || name, totalForLive, "回放自动化");
  if (ctx.runId && !nested) {
    try {
      wfTrace.begin(ctx.runId, {
        workflow: wf.name || name, mode: plan ? "graph" : "steps",
        nodes: plan ? plan.length : 0, steps: steps.length, escalate,
      });
    } catch { /* 轨迹失败不影响回放 */ }
  }

  /* 图执行的单节点派发。刻意只做「先后与依赖」：
     不并行（GUI 独占）、不做长期等待（人工节点 fail-closed）、节点内不嵌图。 */
  const runPlan = async () => {
    for (const item of plan) {
      if (ctx.finished) break;
      const node = item.node || {};
      if (item.kind === "step") {
        const body = Array.isArray(node.steps) ? node.steps : steps;
        if (node.when && !(await evalWhen(node.when, ctx))) {
          traceStep(ctx, { node: item.id, kind: "step", skipped: true, reason: "when 未满足" });
          continue;
        }
        traceStep(ctx, { node: item.id, kind: "step", started: true, steps: body.length });
        await runSteps(body, ctx, 0);
      } else if (item.kind === "subflow") {
        if (subDepth >= MAX_SUBFLOW_DEPTH) {
          throw new Error(`子流程嵌套超过上限（${MAX_SUBFLOW_DEPTH}）：${node.workflow}`);
        }
        traceStep(ctx, { node: item.id, kind: "subflow", workflow: String(node.workflow || "") });
        const sub = await wfPlay(String(node.workflow || ""), {
          ...opts, _depth: subDepth + 1, approved: opts.approved,
          /* 子流程共享父级的 runId 与轨迹：不共享的话，父层只剩一句
             「子流程 X 失败」，而它自己的第几步挂了完全查不到。 */
          runId: ctx.runId, _traceNode: String(item.id || node.workflow || ""),
          source: opts.source,
          /* 续跑起点绝不能被子流程继承：那会跳过子流程自己的前几步。 */
          resumeFrom: 0,
        });
        if (!sub.ok) {
          throw new Error(`子流程「${node.workflow}」失败：${sub.error || sub.status || "未知原因"}`);
        }
        /* 子流程的产出变量并回父层：不并回去的话，"准备"那一步算出来的东西
           在"主流程"里就看不见，subflow 也就没意义了。 */
        Object.assign(ctx.vars, sub.vars || {});
      } else if (item.kind === "approval") {
        if (approvedSet.has(String(item.id))) {
          traceStep(ctx, { node: item.id, kind: "approval", approved: true });
          continue;
        }
        if (String(node.onMissing || "") === "continue") {
          /* 配方自己写了"没人批也继续"。这是绕过批准，必须留痕 ——
             悄悄放行等于把人工闸门做成装饰。 */
          log(`[wf] 人工节点 ${item.id} 未批准，但配方写了 onMissing=continue，已绕过批准继续`);
          traceStep(ctx, { node: item.id, kind: "approval", approved: false, bypassed: true });
          continue;
        }
        /* fail-closed：未批准就整条落 needs_review 停下。
           不挂着等 —— 长期等待会占着 GUI 独占权，"等"比"停"更危险。 */
        traceStep(ctx, { node: item.id, kind: "approval", approved: false, blocked: true });
        ctx.pendingApproval = String(item.id);
        return;
      } else if (item.kind === "if") {
        traceStep(ctx, { node: item.id, kind: "if", conditionMet: !!item.conditionMet, taken: !!item.taken });
        if (item.taken) await runSteps(item.taken, ctx, 0);
      }
    }
  };

  let errorMsg = "";
  try {
    if (plan) await runPlan();
    else if (resumeFrom > 0) {
      /* 从断点往后跑：前面那些步已经由上一次运行做完了（并且收据在手），
         再跑一遍等于把不可逆动作做第二次 —— 这正是续跑要避免的事。 */
      log(`[wf] 断点续跑「${wf.name || name}」：跳过前 ${resumeFrom} 步，从第 ${resumeFrom + 1} 步开始（共 ${steps.length} 步）`);
      traceStep(ctx, { no: ctx.step, resumeFrom, total: steps.length });
      await runSteps(steps.slice(resumeFrom), ctx, 0);
    } else await runSteps(steps, ctx, 0);
  } catch (err) {
    errorMsg = String(err?.message ?? err);
  }

  /* 结果判定：从执行者手里拿走"成没成"。探测只在这一刻做一次。 */
  let effect = null;
  let evidence = null;
  if (needProbe && !errorMsg) {
    try {
      await sleep(150);                 // 让界面落定，否则比到的是"还没来得及变"的旧树
      snapTreeCache.clear();
      const afterText = await getSnapshotText(6000);
      effect = { changed: verifyEffect({ beforeText, afterText, mutating: true }).changed };
      /* 顺手把差异里的"新增文本行"留下来。它是 tree_state 判据唯一的证据来源 ——
         没有它，用户想写「界面上得出现某某提示」只能靠回忆。 */
      evidence = diffEvidenceLines(beforeText, afterText);
    } catch { effect = null; evidence = null; }
  }
  const outcome = judge({
    spec,
    evidence: { effect, readbackCount: ctx.q.readbacks },
    quality: ctx.q,
    selfClaim: !!ctx.finished,
    readonly: readonlyRun,
  });
  /* 人工节点没批：整条一律 needs_review，不管判据怎么说 —— 缺口在流程里，
     不是"结果看起来没问题"能盖掉的。 */
  const verdict = ctx.pendingApproval ? VERDICT.NEEDS_REVIEW : outcome.verdict;
  const status = errorMsg ? "failed" : toRunStatus(verdict);

  if (ctx.runId && !nested) {
    try {
      wfTrace.end(ctx.runId, {
        status, verdict, evidenceLevel: outcome.evidenceLevel,
        reasonCode: ctx.pendingApproval ? "approval_missing" : outcome.outcomeReasonCode,
        error: errorMsg, steps: ctx.step, pendingApproval: ctx.pendingApproval || "",
        /* 界面证据候选落轨迹：outcome-evidence 从这里读，面板据此给人勾选。
           只存清洗后的可搜片段，不存原行 —— 原行里的 ref 编号下次就变了。 */
        evidenceLines: evidence && evidence.ok ? evidence.lines.map((l) => l.text) : [],
        evidenceReason: evidence ? evidence.reason : "",
        ...ctx.q,
      });
    } catch { /* 轨迹失败不影响回放 */ }
  }

  /* 没报错地跑完 → 断点作废。
     留着它会出事：下次点「从断点续跑」会跳过本次已经正常做完的步骤，
     而界面上那些动作早就不在同一个状态了。 */
  if (!errorMsg && resumeCapable) {
    try { wfCps.clear(name); } catch { /* 清不掉也不影响本次结论 */ }
  }

  if (errorMsg) {
    if (!nested) liveEnd(false, errorMsg);
    CURRENT_SOURCE = prevSource;
    return { ok: false, status, verdict, outcome, total: totalForLive, stoppedAt: -1,
      resumedFrom: resumeFrom, error: errorMsg, vars: ctx.vars, escalate,
      evidenceLines: evidence && evidence.ok ? evidence.lines.map((l) => l.text) : [],
      ...ctx.q };
  }

  if (!nested) liveEnd(true);
  CURRENT_SOURCE = prevSource;
  return {
    ok: true, status, verdict, outcome,
    total: totalForLive, stoppedAt: null, results: [], vars: ctx.vars,
    resumedFrom: resumeFrom,
    evidenceLines: evidence && evidence.ok ? evidence.lines.map((l) => l.text) : [],
    // finished：智能体在接管时判定「最终目标已达成」，整条流程提前收工（不是失败）
    finished: !!ctx.finished,
    pendingApproval: ctx.pendingApproval || "",
    escalate, ...ctx.q,
  };
}

(async () => { try { fsSync.mkdirSync(WORKFLOW_DIR, { recursive: true }); } catch {} })();

/* ---------------- 触发器 ----------------
 * 让自动化"自己跑"，不必有人守着点。
 * 分工：定时 / 文件变化在 bridge（Node 能力）；**热键在 main.js**——
 * globalShortcut 是 Electron 的 API，bridge 进程里没有。
 * 落盘 <控制台>/triggers.json，重启后自动重新武装。
 */
const TRIGGER_FILE = process.env.ORB_TRIGGER_FILE || path.join(DATA_DIR, "triggers.json");
let triggers = [];
const triggerHandles = new Map();   // id -> Interval / FSWatcher

/**
 * 触发器 id 去重。
 * 两条路会产生重复 id：
 *   ① 面板在同一毫秒内连续新建（id = "t" + Date.now().toString(36)）；
 *   ② triggers.json 手工编辑时漏写 id（全是 undefined）。
 * 重复 id 的后果很实在：armTriggers 拿 id 当句柄表的 key，
 * 后一条把前一条的句柄覆盖掉 —— 前一个 setInterval / FSWatcher 既泄漏、
 * 又再也没法被 disarmTriggers 摘掉（触发器"关不掉"就是从这儿来的）。
 */
function ensureTriggerIds() {
  const seen = new Set();
  let changed = false;
  for (const t of triggers) {
    if (!t || typeof t !== "object") continue;
    if (!t.id || seen.has(String(t.id))) {
      t.id = "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      changed = true;
    }
    seen.add(String(t.id));
  }
  if (changed) saveTriggers();
}

function loadTriggers() {
  try {
    const arr = JSON.parse(fsSync.readFileSync(TRIGGER_FILE, "utf8"));
    triggers = Array.isArray(arr) ? arr : [];
  } catch { triggers = []; }
  ensureTriggerIds();
}

function saveTriggers() {
  try { writeJsonAtomic(TRIGGER_FILE, triggers); } catch {}
}

function disarmTriggers() {
  for (const h of triggerHandles.values()) {
    try { h.close?.(); } catch {}
    try { clearInterval(h); } catch {}
  }
  triggerHandles.clear();
}

/* ---------------- 唯一点火入口 ----------------
 * 三层触发器（interval / file 在 bridge，hotkey 在 main.js）与人工回放都走这里。
 * 之前热键直接 POST /api/wf play，绕过 fireTrigger —— 只改触发器会漏掉整整一层。
 *
 * 分层原则（对照 n8n / Node-RED / Temporal）：
 *   · 账本只管「何时点火 / 归谁 / 是否重复 / 跑完没有」，绝不碰执行语义；
 *   · wfPlay 原封不动保留：变量/条件/循环/scopes、锚定三道防线、verifyEffect、
 *     escalate 四档、智能接管握手、agentBudget、skipRead、live SSE 全部照旧；
 *   · 安全闸门（急停、能力清单、危险确认）在点火前裁决，被拦下也留收据；
 *   · 归属复用 ticketStore / trajectory，不另起一套成本账。
 */
/* 判据只看「真正跑过」的运行：observe 拦下的是 skipped，不算样本。
   人工回放算样本，否则 observe 不执行就永远攒不够数据、永远升不了 auto。 */
function policyFor(name) {
  const key = wfSafeName(name);
  const runs = wfRuns.list({ limit: 500 }).filter((r) => wfSafeName(r.workflow) === key);
  return evaluatePolicy(runs);
}

/** 自动升降级。缺省 mode=auto 以兼容既有配置；手动设过的 modeLocked 不被覆盖。 */
function applyPolicies() {
  const changed = [];
  let dirty = false;
  for (const t of triggers) {
    if (!t || t.enabled === false) continue;
    const cur = t.mode === "observe" ? "observe" : "auto";
    const d = decideTransition(t, policyFor(t.workflow), cur);
    if (!d.change) continue;
    t.mode = d.mode;
    changed.push({ id: t.id, workflow: t.workflow, from: cur, to: d.mode, reason: d.reason });
    dirty = true;
  }
  if (dirty) { saveTriggers(); armTriggers(); }
  return changed;
}

/**
 * 这条配方现在能不能从断点续跑。只读，不改任何状态（面板拿它决定要不要显示按钮）。
 *
 * 「最后一步已结算」这条是整套机制的地基：断点记录的是 nextIndex（下标），
 * 但下标本身只是一句自述 —— 真正证明「那一步确实做完了」的是 receipts 里那条
 * 已结算的收据。收据丢了（被裁剪 / 换了机器）就一律拒绝，宁可从头跑。
 */
/* 谁把这条配方当子流程在调（含编排图里的 subflow 节点）。
   删之前必须查：删掉 B，A 要到**运行时**才炸，而那时候 A 可能已经做到一半。
   悬空引用里最难查的就是这种 —— 删的那一刻一切正常，报错在几天后的半夜。 */
function subflowReferrersOf(name) {
  const key = wfSafeName(name);
  const out = [];
  for (const w of wfList()) {
    if (wfSafeName(w.name) === key) continue;
    let body = null;
    try { body = JSON.parse(fsSync.readFileSync(wfFile(w.name), "utf8")); } catch { continue; }
    const hits = [];
    const scan = (list, where, depth) => {
      if (!Array.isArray(list) || depth > 8) return;
      list.forEach((s, i) => {
        if (!s || typeof s !== "object") return;
        if (String(s.type || "") === "subflow" && wfSafeName(s.workflow) === key) {
          hits.push(`${where}第 ${i + 1} 步`);
        }
        scan(s.body, where, depth + 1);
        scan(s.then, where, depth + 1);
        scan(s.else, where, depth + 1);
      });
    };
    scan(body.steps, "", 1);
    const nodes = Array.isArray(body.graph && body.graph.nodes) ? body.graph.nodes : [];
    for (const n of nodes) {
      if (n && String(n.kind || "") === "subflow" && wfSafeName(n.workflow) === key) {
        hits.push(`编排图节点 ${String(n.id || "(无名)")}`);
      }
    }
    if (hits.length) out.push({ name: w.name, where: hits.slice(0, 6) });
  }
  return out;
}

function resumeStatusOf(name) {
  const nm = String(name || "");
  if (!nm) return { ok: false, code: "no_workflow", reason: "缺少名称" };
  let wf = null;
  try { wf = JSON.parse(fsSync.readFileSync(wfFile(nm), "utf8")); }
  catch { return { ok: false, code: "no_workflow", reason: "读不到自动化：" + nm }; }

  const linear = isLinearRecipeWf(wf);
  const cp = wfCps.get(nm);
  if (!linear.ok) {
    return { ok: true, resumable: false, code: linear.code, reason: linear.reason,
      checkpoint: cp, linear: false, total: (wf.steps || []).length };
  }
  const rec = cp && cp.lastIdem ? wfReceipts.byKey(cp.lastIdem) : null;
  const gate = canResume(wf, cp, { lastSettled: !!(rec && rec.settled) });
  return {
    ok: true, resumable: !!gate.ok, code: gate.code, reason: gate.reason,
    nextIndex: gate.ok ? gate.nextIndex : null,
    checkpoint: cp, linear: true, total: (wf.steps || []).length,
    lastSettled: !!(rec && rec.settled),
  };
}

async function fireWorkflow(o = {}) {
  const t = o.trigger || null;
  const name = String(o.name || (t && t.workflow) || "");
  const triggerId = String(o.triggerId || (t && t.id) || "");
  const layer = String(o.layer || "manual");
  const eventId = `ev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let wf = null;
  try { wf = JSON.parse(fsSync.readFileSync(wfFile(name), "utf8")); } catch {}

  let policyEpoch = 0;
  try { policyEpoch = policyTransition.state().policyEpoch; } catch {}

  /* S5：recipe 声明的「预期完成事件契约」（expected_event_schema / 最大静默期 /
   * 里程碑 / 探测方式）。存进运行账本当真相源，watchdog 据此监听缺席。 */
  const expectedEvent = (wf && wf.expectedEvent && typeof wf.expectedEvent === "object")
    ? wf.expectedEvent
    : (wf && wf.expected_event_schema && typeof wf.expected_event_schema === "object")
      ? wf.expected_event_schema : null;
  const claim = wfRuns.begin({
    triggerId, workflow: name, source: layer === "manual" ? "manual" : "trigger",
    layer, eventId, dedupeKey: String(o.dedupeKey || ""),
    /* 热键防连击、文件变化防抖；interval 由自身周期保证，不额外冷却。 */
    cooldownMs: layer === "hotkey" ? 500 : (layer === "file" ? 1500 : 0),
    epoch: STOP.epoch, escalate: String((wf && wf.escalate) || "off"), policyEpoch,
    /* 闸门优先级：急停 > observe > 其它。被拦下也进账本留收据。 */
    blockedBy: STOP.on ? "stopped" : String(o.blockedBy || ""),
    expectedEvent: expectedEvent || undefined,
  });
  if (!claim.ok) return { ok: false, code: claim.code, run: claim.run };

  let ticketId = "";
  try {
    const tk = ticketStore.openTicket({
      kind: "recipe", title: name, source: layer,
      meta: { runId: claim.run.runId, triggerId, workflow: name, layer },
    });
    ticketId = tk.id;
    trajectory.append(ticketId, { type: "step", name: "recipe.start", ok: true,
      target: name, epoch: tk.epoch, runId: claim.run.runId });
    /* S5：recipe 声明了预期完成契约才 declare（默认不声明 → 存量配方完全不受影响）。
     * 没显式写 expectedEvents 时按 recipe.done 兜底 —— 配方正常跑完就该有它。 */
    if (expectedEvent) watchdog.declare(ticketId, { expectedEvents: ["recipe.done"], ...expectedEvent });
  } catch (err) {
    console.log("[wf] 开工单失败（回放照跑，只是没账）：", err?.message ?? err);
  }

  let res;
  try {
    res = await wfPlay(name, {
      gap: o.gap ?? (t && t.gap),
      source: layer === "manual" ? "workflow" : "trigger",
      skipRead: o.skipRead === true,
      /* 步级轨迹挂在账本的 runId 上：出了事能回答「断在第几步」，而不只是"跑挂了"。 */
      runId: claim.run.runId,
      approved: o.approved,
      /* 断点续跑：从第 N 个顶层步之后接着跑。安全门在 /api/wf resume 里已经过完，
         这里原样透传 —— wfPlay 内部还会再校一次索引区间。 */
      resumeFrom: o.resumeFrom,
    });
  } catch (err) {
    res = { ok: false, status: "failed", total: 0, error: String(err?.message ?? err) };
  }

  /* status 由 OutcomeGate 给，不再「没抛异常 = ok」。
     needs_review 单独一档：autoPolicy 的样本集只认 ok / failed，它自然被排除 ——
     拿不到证据的运行既不能算成功样本，也不该算失败样本。 */
  const runStatus = String(res.status || (res.ok ? "ok" : "failed"));
  wfRuns.finish(claim.run.runId, {
    ok: runStatus === "ok", status: runStatus,
    reasonCode: runStatus === "ok" ? "" : String(res?.outcome?.outcomeReasonCode || (res.pendingApproval ? "approval_missing" : "play-failed")),
    steps: res.total || 0, error: res.error || "",
    takeovers: res.takeovers || 0, anchorFallbacks: res.anchorFallbacks || 0,
    verifyFailed: res.verifyFailed || 0, skippedRead: res.skippedRead || 0,
    retries: res.retries || 0,
    finishedEarly: !!res.finished,
    verdict: String(res.verdict || ""),
    evidenceLevel: String(res?.outcome?.evidenceLevel || ""),
  });
  if (ticketId) {
    /* S5：配方已跑完 → 撤销预期事件契约，避免下一轮采样把它误判成 absent。 */
    try { watchdog.clear(ticketId); } catch {}
    try {
      trajectory.append(ticketId, { type: "step", name: runStatus === "ok" ? "recipe.done" : "recipe.error",
        ok: runStatus === "ok", message: String(res.error || res?.outcome?.outcomeReasonCode || "").slice(0, 200),
        runId: claim.run.runId });
      /* needs_review 在工单侧记 done：它确实跑完了，只是"没证据说它成了"。
         真实状态以运行账本为准，工单只承担成本归属，不冒充验收结论。 */
      ticketStore.transition(ticketId, runStatus === "failed" ? "failed" : "done",
        { reason: String(res.error || (runStatus === "needs_review" ? `needs_review:${res?.outcome?.outcomeReasonCode || ""}` : "")).slice(0, 200) });
    } catch {}
  }
  /* 每次跑完重算一次升降级：失败立即降回 observe，连续干净才升 auto。 */
  let transitions = [];
  try { transitions = applyPolicies(); } catch (err) {
    console.log("[auto] 升降级评估失败（不影响本次运行）：", err?.message ?? err);
  }
  /* 步骤收据按 max 裁剪 + 落盘：一条 30 步自动化跑一次就 60 条，
     不裁剪的话跑上一周就把内存和审计队列撑起来了。 */
  try { wfReceipts.prune(); wfReceipts.flush(); } catch { /* 收据维护失败不影响运行结论 */ }
  return { ok: !!res.ok, runId: claim.run.runId, ticketId, layer, transitions, ...res };
}

async function fireTrigger(t, reason) {
  try {
    /* 幂等键取事件本身的稳定指纹，不用 runId（n8n 明确警告：execution.id 每次重试都变）。
       定时按分钟桶合并；文件变化按 mtime 合并，防一次保存触发多次 watch 事件。 */
    let dedupeKey = "";
    if (t.type === "interval") {
      dedupeKey = `${t.id}|interval|${Math.floor(Date.now() / 60000)}`;
    } else if (t.type === "file") {
      let mt = 0;
      try { mt = fsSync.statSync(t.path).mtimeMs; } catch {}
      dedupeKey = `${t.id}|file|${mt || Math.floor(Date.now() / 1000)}`;
    }
    console.log(`[trigger] ${t.id} → ${t.workflow}（${reason}）`);
    /* observe = 只记录不执行（官方默认纪律）；收据进账本，人工回放仍可攒干净样本。 */
    const r = await fireWorkflow({ trigger: t, layer: t.type, reason, dedupeKey,
      blockedBy: t.mode === "observe" ? "observe" : "" });
    if (!r.ok && r.code) console.log(`[trigger] ${t.id} 跳过：${r.code}`);
    else console.log(`[trigger] ${t.id} 完成（${r.runId} / ${r.ticketId}）`);
  } catch (err) {
    console.log(`[trigger] ${t.id} 执行失败：${err?.message ?? err}`);
  }
}

/** 按当前配置重新武装所有触发器（启动时 / 改配置后调用） */
function armTriggers() {
  disarmTriggers();
  ensureTriggerIds();
  triggers.forEach((t, i) => {
    if (!t || t.enabled === false) return;
    /* 句柄 key 带序号：即使 id 还撞（文件被外部改过），每条也各有独立句柄，
       不会再出现"后一条覆盖前一条、前一条永远关不掉也清不掉"。 */
    const hkey = `${t.id}#${i}`;
    if (t.type === "interval") {
      // 下限 1 分钟：防手滑写 0 把机器跑满；1 分钟起允许用户精细调度
      const ms = Math.max(1, Number(t.minutes || 10)) * 60000;
      triggerHandles.set(hkey, setInterval(() => fireTrigger(t, "interval"), ms));
    } else if (t.type === "file") {
      try {
        const w = fsSync.watch(t.path, { persistent: true }, (ev) => fireTrigger(t, "file:" + ev));
        // 目录被删 / 盘符掉线时 watcher 会抛 'error'，没有监听者就升级成未捕获异常
        w.on("error", (e) => console.log(`[trigger] 文件监听出错 ${t.path}：${e?.message ?? e}`));
        triggerHandles.set(hkey, w);
      } catch (err) {
        console.log(`[trigger] 文件监听失败 ${t.path}：${err?.message ?? err}`);
      }
    }
    // hotkey 类型不在此处理：交给 main.js 的 globalShortcut
  });
  console.log(`[trigger] 已武装 ${triggerHandles.size} 个（配置共 ${triggers.length} 条）`);
}

loadTriggers();
setTimeout(() => { try { armTriggers(); } catch (e) { console.log("[trigger] 武装失败", e?.message); } }, 2000);

// 审计日志保留 30 天：启动后清一次过期文件
setTimeout(() => { try { auditCleanup(); } catch {} }, 3000);

/* 只读结果短时缓存（提速）。
 * 轮询场景里同一个 Snapshot 会被反复调用，每次都走完整 MCP 往返很浪费。
 * 只缓存**确认无副作用**的只读工具，且任何写操作后立刻整体失效，
 * 保证「点一下再看」永远拿到新画面。 */
const READ_CACHE = new Map();
const READ_CACHE_MS = 300;
const READ_ONLY_TOOLS = new Set([
  "windows|Snapshot",
  "windows|DisplayInventory",
]);

async function openSession(key) {
  const def = SERVERS[key];
  const transport = new StdioClientTransport({
    command: def.command,
    args: def.args,
    env: def.env ?? process.env,
    stderr: "pipe",
  });
  const client = new Client({ name: "orb-console", version: "1.0.0" });

  const drop = () => {
    if (sessions.get(key)?.client === client) {
      sessions.delete(key);
      try { client.close?.(); } catch {}
    }
  };
  try { transport.onclose = drop; } catch {}
  try { client.onclose = drop; } catch {}

  await client.connect(transport);
  const { tools } = await client.listTools();
  const session = {
    client,
    transport,
    tools: tools.map((t) => ({ name: t.name, description: t.description ?? "" })),
  };
  sessions.set(key, session);
  registerChild(transportPid(transport), key);   // 记进台账，供下次启动回收
  return session;
}

async function getSession(key, retry = true) {
  if (!SERVERS[key]) throw new Error(`unknown server: ${key}`);
  const live = sessions.get(key);
  if (live && live.client) {
    /* 僵死会话自愈（兜底，实测当前 SDK 下极少触发）：
     * 子进程死了但会话还躺 map 里时，/api/status 会误报在线、调用表现异常。
     * 主力恢复其实在另外两处——① SDK 的 transport.onclose 会调 drop 摘掉会话；
     * ② callToolRaw 里 isBroken(err) 命中（"Not connected"/"Connection closed"）也会
     * disposeSession。这两条都实测有效（杀子进程后：在途调用 5s 内报 Connection
     * closed，空闲会话 4ms 报 Not connected，下一次调用 4s 重连成功）。
     * 这里的 PID 探活覆盖的是 SDK 兜不住的 exotic 场景：子进程没了、但 'close'
     * 事件迟迟不触发（例如它的孙进程继承了 stdout 管道把管道占着），此时 SDK
     * 不会清 _process、也不会调 onclose，只有 kill(pid,0) 能发现它死了。
     * 注意：SDK 在 'close' 里会顺手把 _process 置 undefined，所以正常情况下
     * （'close' 正常触发）这个探活反而拿不到 PID——这是已知的，不是 bug。 */
    const pid = transportPid(live.transport);
    if (pid > 0 && !pidAlive(pid)) {
      log(`[session] ${key} 的子进程 PID ${pid} 已不在，销毁僵死会话并重连`);
      disposeSession(key);
    } else {
      return live;
    }
  }

  if (!connecting.has(key)) {
    connecting.set(key, openSession(key).finally(() => connecting.delete(key)));
  }
  try {
    return await connecting.get(key);
  } catch (err) {
    connecting.delete(key);
    if (retry) {
      await new Promise((r) => setTimeout(r, 800));
      return getSession(key, false);
    }
    throw err;
  }
}

/* 急停豁免名单：这些调用即使在急停状态下也放行。
 *
 * 为什么必须豁免：
 *   ① 「恢复」本身就是一次工具调用 —— 如果急停把所有调用都拦死，
 *      就再也回不来了，只能杀进程重启。这是把刹车焊死。
 *   ② 只读的「看一眼」类操作不会改变电脑状态，急停时禁掉它们没有安全收益，
 *      反而让人没法确认"到底停了没"。
 *
 * 豁免的粒度是 (server, tool)，不是整个 server ——
 * 不能因为 orb 有 cursor_position 就把 orb 的 drag 也放行。
 *
 * 2026-11-05：名单本体已移至 ./capabilityRegistry.mjs，这里只做派生。
 * 移走的理由不是洁癖：这份名单同时被文档表格和面板解释引用，
 * 手抄三份必然漂移，而漂移的后果是「某个写操作悄悄对急停免疫」——
 * 这种 bug 不会报错，只会在某次急停时默默把鼠标动了。
 *
 * 2026-11-03 移除 `workbuddy|workbuddy_execute` 的决定记在能力清单里
 * （capabilityRegistry.mjs 的 toMarkdown() 会把它写进文档，单测锁着）。
 */
const STOP_EXEMPT = stopExemptSet();
function stopExempt(key, tool) {
  return isStopExempt(key, tool);
}

/* 方案 D：运行时配置（面板「安全」页实体开关可改，运行中即生效）。
 * 与 process.env 的区别：这个是**可变**的，经 /api/runtime 读写并持久化到
 * DATA_DIR/runtime-config.json，重启控制台后仍在。process.env 只作启动期强制覆盖。 */
const RUNTIME_CONF_FILE = path.join(DATA_DIR, "runtime-config.json");
let RUNTIME_CONF = { confirmWrites: false };
try {
  const j = JSON.parse(fsSync.readFileSync(RUNTIME_CONF_FILE, "utf8"));
  if (j && typeof j === "object") RUNTIME_CONF.confirmWrites = !!j.confirmWrites;
} catch { /* 首次没有文件 → 用默认值（关） */ }
function saveRuntimeConf() {
  try { fsSync.writeFileSync(RUNTIME_CONF_FILE, JSON.stringify(RUNTIME_CONF, null, 2)); }
  catch (e) { log("[runtime] 保存失败:", e?.message ?? e); }
}

async function callToolRaw(key, tool, args, timeoutMs, sink = null) {
  /* 急停检查点：放在 callToolRaw 的入口，一次覆盖全部四条路 ——
   *   回放（runSteps → callTool）、单次调用（/api/call → callTool）、
   *   后台任务（startJob → callTool）、危险确认（WaitFor → callTool）。
   *
   * 之前 checkStop() 只在 runSteps 里调过一次，导致急停只拦得住"自动化回放"，
   * 而面板上任何一个工具按钮、以及直接打 /api/call 都能绕过 —— 急停形同虚设。
   */
  if (STOP.on && !stopExempt(key, tool)) {
    throw new Error(`已被急停（${STOP.reason || "手动"}），${key}.${tool} 被拦下`);
  }
  // 方案 D：写操作治理（可选开关 ORB_CONFIRM_WRITES=1）。
  // 未登记/写操作默认需人工确认；确认令牌由调用方在 args.__confirmed 带入，
  // 复用既有的 waitApproval 人机确认回路。默认关闭 —— 开启后写工具才会被拦下确认，
  // 不影响只读工具（governWrite 对只读直接放行），也不影响当前未开此开关的运行实例。
  if (RUNTIME_CONF.confirmWrites || process.env.ORB_CONFIRM_WRITES === "1") {
    const confirmed = !!(args && typeof args === "object" && args.__confirmed);
    const g = governWrite(key, tool, {
      confirmed,
      identity: process.env.ORB_IDENTITY || "",
      device: process.env.ORB_DEVICE || "",
    });
    if (!g.ok) {
      if (g.code === "CONFIRM_REQUIRED") {
        const r = await waitApproval(key, tool, args);
        if (!r.allow) throw new Error(`写操作需人工确认但被拒绝：${key}.${tool} —— ${r.reason}`);
      } else {
        throw new Error(`写操作被治理策略拒绝：${g.reason}`);
      }
    }
    if (args && typeof args === "object") delete args.__confirmed;
  }
  /* 这次调用属于哪个世代。下面 getSession 可能冷启动一个 Python MCP server
   * （windows-mcp 首次要好几秒），而急停恰恰可能落在这段"还没登记在途"的窗口里 ——
   * 那时 inflightMcp 是空的，killInflightMcp 无事可杀，等会话起来后这次调用
   * 会若无其事地继续跑完。所以在拿到会话之后再验一次世代。 */
  const callEpoch = Number(jobScope.getStore()?.epoch ?? STOP.epoch);

  // 本地伪服务：不经过 MCP，直接调原生工具
  if (key === "orb") {
    const fn = LOCAL_TOOLS[tool];
    if (!fn) throw new Error(`orb 没有工具 ${tool}（可用：${ORB_TOOL_LIST.join(", ")}）`);
    return fn(args ?? {});
  }

  // WorkBuddy 后台：也不经 MCP，直接拉起 CodeBuddy CLI
  if (key === "workbuddy") {
    const fn = WORKBUDDY_TOOLS[tool];
    if (!fn) throw new Error(`workbuddy 没有工具 ${tool}（可用：${WORKBUDDY_TOOL_LIST.join(", ")}）`);
    return fn(args ?? {}, timeoutMs, sink);
  }

  // 危险操作：挂起等人确认；超时按拒绝处理（绝不自动放行）。
  // 命中白名单的（你明确信得过的命令）直接放行，不再反复打扰。
  if (isDangerous(key, tool, args) && !isWhitelisted(tool, args)) {
    const r = await waitApproval(key, tool, args);
    if (!r.allow) throw new Error(`危险操作被拒绝：${tool} —— ${r.reason}`);
  }

  let session;
  try {
    session = await getSession(key);
  } catch (err) {
    throw new Error(`连接 ${SERVERS[key]?.label ?? key} 失败：${err?.message ?? err}`);
  }
  /* 会话刚建好，但世代已经变了（急停在冷启动窗口里按下）→ 这次调用作废。
   * 用世代比而不是只看 STOP.on：恢复之后 STOP.on 又变回 false，可这次调用
   * 依旧属于上一代，让它跑完就是把"已经停掉的东西"重新交付给用户。 */
  if (!stopExempt(key, tool) && callEpoch < Number(STOP.epoch || 0)) {
    throw new Error(`已被急停（第 ${callEpoch} 代发出，现在第 ${STOP.epoch} 代），${key}.${tool} 在建立连接期间被作废`);
  }

  let timer;
  // 记「在途调用」：急停时只有确实有调用卡在 MCP 里，才值得把连接断掉。
  // 没有在途调用就保持连接，避免误触急停后每次操作都要重连（慢好几秒）。
  inflightMcp.set(key, (inflightMcp.get(key) || 0) + 1);
  /* 录制时屏蔽鼠标钩子：这次操作是 ORB 自己发起的（会产生真实鼠标事件），
     已经由 wfCapture 记过一遍，再让钩子记一次就重复了。 */
  const mh = REC.on ? await getMouseHook() : null;
  if (mh) mh.suppressMouseHook(true);
  try {
    return await Promise.race([
      session.client.callTool({ name: tool, arguments: args ?? {} }),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error(`工具 ${tool} 超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
      }),
    ]);
  } catch (err) {
    // 断连 **或超时** 都说明这个 session 已不可信：必须关掉重建。
    // 只处理断连的话，被卡住的 client 会被后续请求反复复用，
    // 表现为"卡一次之后所有调用都超时"，只能重启整个 ORB 才能恢复。
    if (isBroken(err) || /超时/.test(String(err?.message ?? err))) disposeSession(key);
    throw err;
  } finally {
    clearTimeout(timer);
    const n = (inflightMcp.get(key) || 0) - 1;
    if (n <= 0) inflightMcp.delete(key); else inflightMcp.set(key, n);
    // 解除抑制要**晚一点**：MCP 里的真实点击可能在调用返回后才落到系统里，
    // 立刻解除会把这次操作又记一遍。
    if (mh) setTimeout(() => mh.suppressMouseHook(false), 250);
  }
}

/* 审计包装：所有工具调用都从这里过，统一记录「谁/何时/做了什么/结果/耗时」。
 * CURRENT_SOURCE 由上层设置（workflow / trigger / ai / api），用来回溯是谁触发的。 */
let CURRENT_SOURCE = "api";

function auditArgs(args) {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch { return "(无法序列化)"; }
}

async function callTool(key, tool, args, timeoutMs, sink = null) {
  const t0 = Date.now();
  try {
    const r = await callToolRaw(key, tool, args, timeoutMs, sink);
    audit({ source: CURRENT_SOURCE, server: key, tool, args: auditArgs(args), ok: true, ms: Date.now() - t0 });
    /* V-11：网页正文（Scrape / dom.get_text）是不可信输入。
       只**加**一个 untrusted 字段，不改原 content —— 文字锚定等控制流照旧；
       但要送进模型/记忆就必须用 untrusted.data，形状上堵住「拿原文提权」。 */
    if (r && typeof r === "object" && !Array.isArray(r) &&
        ((key === "windows" && tool === "Scrape") || tool === "dom.get_text")) {
      return { ...r, untrusted: textGate.guard(toolTextOf(r), "webpage") };
    }
    return r;
  } catch (err) {
    audit({
      source: CURRENT_SOURCE, server: key, tool, args: auditArgs(args),
      ok: false, ms: Date.now() - t0, error: String(err?.message ?? err).slice(0, 200),
    });
    throw err;
  }
}

const jobs = new Map();
let jobSeq = 0;
/* 进程启动标签。jobSeq 每次重启都从 0 重数，而**工单是要落盘的**：
 * 重启后第一个任务必然还是 job-1，与上次运行的 job-1 撞名，
 * 于是历史被覆盖（轨迹/成本/结论一起没）。带上启动标签就永久唯一了。 */
const BOOT_TAG = Math.random().toString(36).slice(2, 6);

/* ---------------- 任务结果裁剪 ----------------
 * MCP 工具的返回值里常带整张屏幕截图（base64，单张 1~3MB），而 jobs 表最多留
 * MAX_JOBS 条 —— 峰值能到 100MB+ 且 GC 不掉。
 * 策略（与面板侧约定）：超过 512KB 就不把原文留在内存里，只削出一段文字摘要，
 * 并在 **job 顶层**置 truncated: true；面板见到这个标志会补一句
 * 「结果过大已省略，以上仅为开头部分」。
 * 内存从 MB 级降到 KB 级，用户也不至于只看一句「已省略」以为任务白跑。 */
const JOB_RESULT_MAX = 512 * 1024;   // 超过这个体积就不留在内存里
const JOB_TEXT_KEEP = 2000;          // 摘要保留的字符数

function jobResultSize(r) {
  try { return JSON.stringify(r).length; } catch { return JOB_RESULT_MAX; }
}

/** 返回 { result, truncated }：超限时 result 被削成一段文字摘要 */
function trimJobResult(r) {
  if (jobResultSize(r) <= JOB_RESULT_MAX) return { result: r, truncated: false };
  const parts = (r && r.content) || [];
  let text = parts
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  if (!text) {
    /* 没有文字（纯截图之类）时给一句能自解释的话，
       别让用户以为任务跑了几分钟却什么都没产出。 */
    text = `（本次返回的是非文本内容，共 ${parts.length} 项，因体积过大未回传）`;
  } else if (text.length > JOB_TEXT_KEEP) {
    text = text.slice(0, JOB_TEXT_KEEP);
  }
  return {
    result: { content: [{ type: "text", text }], trimmed: true },
    truncated: true,
  };
}

/* 从工具返回值里取纯文本，供成本账本估算 token。
 * 只取前 20000 字符：为了估算一个量级，没必要把整篇结果再复制一遍。 */
function jobTextOf(r) {
  const parts = (r && r.content) || [];
  return parts
    .filter((c) => c && c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .slice(0, 20000);
}

/** 把工单推进到终态。带 rev 的 CAS：迟到的回调（旧 rev / 旧 epoch）会被拒，
 *  而不是把已经 failed 的工单又写成 done。 */
function settleJobTicket(job, status, reason) {
  try {
    const cur = ticketStore.get(job.ticketId);
    if (!cur) return null;
    /* allowStale 只给"往下收"的终态：被急停打断的工单**必须**能被标成 stopped，
     * 否则它永远停在 running，summary().open 一直不为零（面板上就是"还在跑"）。
     * done 不给：旧世代跑完的结果不许借结算这道门把自己写成成功。 */
    const r = ticketStore.transition(job.ticketId, status, {
      expectRev: cur.rev,
      reason,
      allowStale: status !== "done",
    });
    /* 轨迹落一条终态。**即使被拒也要落** —— "这次结果因为换代被丢弃了"
     * 恰恰是排查时最需要看到的一行。 */
    trajectory.append(job.ticketId, {
      type: status === "failed" ? "error" : "step",
      name: `job.${status}`,
      ok: status !== "failed",
      message: reason ? String(reason).slice(0, 200) : "",
      accepted: !!(r && r.ok),
      code: r && !r.ok ? r.code : "",
      epoch: job.epoch,
    });
    return r;
  } catch (err) {
    console.log("[tickets] 结算失败：", err?.message ?? err);
    return null;
  }
}

function startJob(key, tool, args, timeoutMs, sink = null, o = {}) {
  const id = String(++jobSeq);
  /* 每张工单在开工那一刻记下 epoch。急停之后它就成了"旧世代"，
   * 后续任何写回都会被 ticketStore 拒收 —— 这是"停了就别再活过来"的唯一保险。 */
  let ticket = null;
  try {
    ticket = ticketStore.openTicket({
      id: `job-${id}-${BOOT_TAG}`,
      kind: "job",
      title: `${key}.${tool}`,
      source: "api",
      meta: { server: key, tool },
    });
  } catch (err) {
    console.log("[tickets] 开工单失败（任务照跑，只是没有账）：", err?.message ?? err);
  }
  // partial：后台任务把已生成的正文体不时写回这里，面板轮询时能看到"正在长出来"的答案。
  const job = {
    id, server: key, tool, status: "running", startedAt: Date.now(), partial: "",
    ticketId: ticket ? ticket.id : "",
    epoch: ticket ? ticket.epoch : STOP.epoch,
    /* ---- 成本归因（I-09）----
     * 这三项由调用方按"这次是怎么被派出去的"填进来，缺省也要有值：
     *   route  最终通道；ruleId 命中的规则/专家（空 = 兜底单路）；
     *   attempt 同一单第几次路由尝试（Fast Path 失败再降级时要能分开算）。 */
    route: String(o.route || "").slice(0, 32),
    ruleId: String(o.ruleId || "").slice(0, 64),
    attempt: Math.max(1, Number(o.attempt) || 1),
    /* 报告B 批次A：V-09 零 VLM 标记 / V-01 显式降级 / V-12 人类优先名额。
       只记在 job 上，随成本账单一起导出；不进安全页、不改执行语义。 */
    zeroVlm: o.zeroVlm === true,
    vlmCalls: o.zeroVlm === true ? 0 : null,
    degraded: o.degraded === true,
    degradeReasonCode: String(o.degradeReasonCode || "").slice(0, 48),
    priority: String(o.priority || "background").slice(0, 16),
    guarded: o.guarded === true,
  };
  jobs.set(id, job);
  if (job.ticketId) {
    trajectory.append(job.ticketId, { type: "step", name: "job.start", ok: true, target: `${key}.${tool}`, epoch: job.epoch });
  }
  // 增量正文出口：节流写回 job.partial（最多 ~3 次/秒，不拖慢 CLI 主流程）。
  // 同时把 partial 推给 SSE 订阅者：面板不再 2s 轮询，做到"生成即到屏"。
  const jobSink = (s) => {
    job.partial = typeof s === "string" ? s : "";
    try { pushJobPartial(id, job.partial); } catch { /* 推送失败不影响主流程 */ }
  };
  const finalSink = sink
    ? (s) => { jobSink(s); try { sink(s); } catch {} }
    : jobSink;
  /* 原来的淘汰条件是 `find(status !== "running")`，找不到就 break：
     60 个全是 running 时 jobs 再也不淘汰，而每条 result 是工具的**完整返回**
     （一张截图就几 MB）—— 内存只涨不降。这里保证上限一定生效。
     另外被淘汰的 job 跑完后不许再写回来：原代码 `if (cur)` 之外没有别的闸门，
     淘汰后又复活出一个没有 id / server / tool 的残对象，把表越撑越大。 */
  while (jobs.size > MAX_JOBS) {
    const keys = [...jobs.keys()];
    const victim = keys.find((k) => jobs.get(k).status !== "running") || keys[0];
    if (!victim || victim === id) break;
    jobs.delete(victim);
  }
  /* 用异步上下文包住整条链路：CLI 在这一层之下 spawn，trackProc 会自动把它
   * 归到这张工单上，于是"只停这一单"成为可能。 */
  const runBody = () => jobScope.run(job, () => (async () => {
    try {
      const raw = await callTool(key, tool, args, timeoutMs ?? JOB_TIMEOUT_MS, finalSink);
      const { result, truncated } = trimJobResult(raw);
      const cur = jobs.get(id);
      if (cur) {
        const next = { ...cur, status: "done", finishedAt: Date.now(), result, truncated };
        jobs.set(id, next);
        pushJobFinal(id, next);
        const tr = settleJobTicket(next, "done");
        /* 被急停判陈旧：任务其实跑完了，但结果不该被采纳。
         * 判据以**世代**为准，不靠 CAS 的返回码 —— 急停时 bumpEpoch 已经改过工单
         * rev，这里带进去的 expectRev 必然过期，回来的是 stale-rev 而不是
         * stale-epoch；只认 stale-epoch 的话，"急停窗口里跑完的任务"会被当成
         * 正常完成交付（这是最坑的一类错觉：面板说完成，实际桥早已作废）。
         * 不把 stale-rev 也算进来，是因为它可能来自与急停无关的并发结算，
         * 那种情况该报出来让人查，而不是悄悄标成"作废"。 */
        const staleGen = Number(next.epoch || 0) < Number(STOP.epoch || 0)
          || !!(tr && !tr.ok && tr.code === "stale-epoch");
        if (staleGen) {
          next.stale = true;
          next.error = `结果属于第 ${next.epoch} 代，急停已换到第 ${STOP.epoch} 代，本次结果作废`;
          jobs.set(id, next);
        } else if (tr && !tr.ok) {
          console.log(`[tickets] 任务 ${id} 结算被拒：${tr.code}`);
        }
        try {
          costLedger.recordText(next.ticketId, next.partial || jobTextOf(result), {
            note: `${next.guarded === true ? "[已过不可信文本闸门] " : ""}CLI 未回吐 usage，按文本长度估算（${key}.${tool}）`,
            /* 归因三元组：没有它，"这次误派发花了多少钱"就只能靠猜。 */
            route: next.route || "back",
            ruleId: next.ruleId || "",
            routeAttemptId: next.ticketId ? `${next.ticketId}#${next.attempt || 1}` : "",
            /* 结构化单显式记 0 次 VLM，普通单留 null —— 「没记」不许被当成「0 次」。 */
            zeroVlm: next.zeroVlm === true,
            vlmCalls: next.zeroVlm === true ? 0 : undefined,
            degraded: next.degraded === true,
            degradeReasonCode: next.degradeReasonCode || "",
          });
        } catch {}
        broadcastStatus().catch(() => {});   // 任务状态变化 → 状态流也即时刷新
      }
    } catch (err) {
      const cur = jobs.get(id);
      if (cur) {
        /* 这条已经被 abortJob 结算过了（手动停单条）：那次结算给的是可读的
         * "已手动停止"，这里再写一遍会把文案换成底层那句"Connection closed"，
         * 工单也会被二次结算（aborted→stopped 属于终态互改，会被拒）。
         * 直接返回，别用更差的信息覆盖更好的。 */
        if (cur.aborted) return;
        const msg = String(err?.message ?? err);
        /* 被急停打断的任务在面板上不该是"失败"。判据有两条：
         *   ① 报错文本本身就写明被急停拦下（runBody 入口的拦截）；
         *   ② 任务开工于旧世代 / 此刻正处在急停中 —— 子进程是被
         *      killActiveProcs 杀掉的，message 只是一句"退出码非零"，
         *      单看文本认不出来。这条才是绝大多数情况。 */
        const byStop = /已被急停/.test(msg) || !!cur.stale
          || (STOP.on && Number(cur.epoch || 0) < Number(STOP.epoch || 0));
        const next = { ...cur, status: "error", finishedAt: Date.now(), error: msg };
        if (byStop) next.stopped = true;
        jobs.set(id, next);
        pushJobFinal(id, next);
        // "已被急停拦下"不是任务失败，是**预期内的拒绝**：记 stopped，别污染失败率。
        settleJobTicket(next, byStop ? "stopped" : "failed", msg.slice(0, 200));
        broadcastStatus().catch(() => {});
      }
    }
  })());

  /* 池化执行：**默认关闭**。关着时与改造前完全一致 —— 派一个跑一个。
   * 打开后（ORB_POOL_WORKERS>0）任务排队，人类请求优先且允许超出上限一个槽，
   * GUI 任务必须持锁且硬串行。 */
  if (poolEnabled) {
    const sub = pool.submit({
      id,
      kind: o.kind || "job",
      priority: o.priority ?? "background",
      exclusive: o.exclusive === true,
      run: runBody,
      onAbort: () => abortJob(id, "worker 池中止"),
      meta: { server: key, tool },
    });
    if (!sub.ok) {
      // 池满 / 已停：不能留一个永远 running 的幽灵任务（面板会一直转圈）。
      const next = { ...job, status: "error", finishedAt: Date.now(), error: `未能进入执行队列（${sub.code}）` };
      jobs.set(id, next);
      pushJobFinal(id, next);
      settleJobTicket(next, "failed", `未入队：${sub.code}`);
      broadcastStatus({ force: true }).catch(() => {});
      return id;
    }
    return id;
  }
  runBody();
  return id;
}

/**
 * 只停这一单：杀掉它的子进程树，把 job 与工单都标成 stopped。
 * 急停是"全停"，这个是"停一个"—— 面板上每张任务卡都能单独刹车。
 *
 * ⚠️ 边界（别把这里当成"局部急停"）：能杀掉的只有**这一单自己 spawn 的子进程**
 * （CLI、本地脚本）。如果这一步是在 MCP server 内部执行的（windows-mcp 的
 * Wait/Click、PowerShell 之类），它跑在那个共享 server 进程里，杀不掉单条 ——
 * 这里能做到的是"结果不再被采纳、任务立刻从面板上结束"，那个底层动作会把
 * 剩余时间跑完（比如 Wait 5 秒会继续等完）。要立刻掐断只能用急停：它会
 * dispose 整个会话（代价是所有在途调用一起断）。
 * 所以文案统一说"结果未采纳"，不说"已终止"。
 */
function abortJob(id, reason) {
  const job = jobs.get(id);
  if (!job) return { ok: false, code: "not-found" };
  if (job.status !== "running") return { ok: false, code: "not-running", status: job.status };
  const set = jobProcs.get(id);
  let killed = 0;
  if (set) {
    for (const p of set) {
      try {
        if (process.platform === "win32" && p.pid) execFile("taskkill", ["/PID", String(p.pid), "/T", "/F"], () => {});
        else p.kill("SIGKILL");
        killed++;
      } catch {}
    }
    jobProcs.delete(id);
  }
  const next = { ...job, status: "error", finishedAt: Date.now(), error: `已手动停止（${reason || "用户操作"}）`, aborted: true };
  jobs.set(id, next);
  pushJobFinal(id, next);
  /* 记 aborted 而不是 stopped：工单表要能区分"全停（急停）"和"单停（点了这一单的刹车）"，
   * 否则事后查"这次事故到底是谁停的"时两者长得一样。 */
  settleJobTicket(next, "aborted", reason || "手动停止单条任务");
  broadcastStatus({ force: true }).catch(() => {});
  return { ok: true, killed, job: next };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // X-Orb-Token 必须在这里放行：带自定义头的请求会先发 OPTIONS 预检，
  // 预检不通过的话浏览器根本不会发出真正的请求（表现为所有 POST 直接失败）。
  "Access-Control-Allow-Headers": "Content-Type, X-Orb-Token",
};

function send(res, code, body) {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...CORS,
  });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 8 * 1024 * 1024) throw new Error("body too large");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

/* ---------- SSE 推送（替代面板轮询，做到"生成即到屏"） ----------
 * jobSubs:    任务 id → 订阅该任务流式输出的响应集合
 * statusSubs: 订阅全局状态（通道/活动/急停/待确认）的响应集合
 * 设计：纯增量 + 包裹，现有 /api/job/:id、/api/status 轮询端点一字未改；
 *       面板侧 EventSource 出错会自动退回原轮询，零退化。 */
const jobSubs = new Map();      // id -> Set<ServerResponse>
const statusSubs = new Set();   // Set<ServerResponse>
let lastStatusJson = "";

function sseHead(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    ...CORS,
  });
}

function sseSend(res, obj) {
  if (res.writableEnded) return;
  try { res.write("data: " + JSON.stringify(obj) + "\n\n"); } catch { /* 连接已断 */ }
}

// 任务 partial 写回时顺推订阅者（由 jobSink 调用，永不向 CLI 主流程抛错）。
function pushJobPartial(id, text) {
  const set = jobSubs.get(id);
  if (!set || !set.size) return;
  const payload = JSON.stringify({ type: "partial", text: typeof text === "string" ? text : "" });
  for (const res of set) { if (!res.writableEnded) { try { res.write("data: " + payload + "\n\n"); } catch {} } }
}

function pushJobFinal(id, job) {
  const set = jobSubs.get(id);
  if (!set || !set.size) return;
  const payload = JSON.stringify({ type: "final", job });
  for (const res of set) {
    if (res.writableEnded) continue;
    try { res.write("data: " + payload + "\n\n"); res.end(); } catch {}
  }
  jobSubs.delete(id);
}

function subscribeJob(id, res) {
  let set = jobSubs.get(id);
  if (!set) { set = new Set(); jobSubs.set(id, set); }
  set.add(res);
  res.on("close", () => { set.delete(res); if (!set.size) jobSubs.delete(id); });
}

function subscribeStatus(res) {
  statusSubs.add(res);
  res.on("close", () => statusSubs.delete(res));
}

/* 快照重入守卫：buildStatusSnapshot 里要 await getSession（坏掉的 server 会一直
 * 超时到退避生效），1.5s 定时器很容易在上一次还没算完时再进来。不挡的话：
 *   ① 并发快照白烧 CPU，还可能重复 spawn；
 *   ② lastStatusJson 会被较晚返回的旧快照覆盖 —— 下一次真变化与旧值相同就被
 *      判成"没变"而永久漏推，面板卡在过期状态上（很难查的那种）。 */
let statusBuilding = false;
/* 重入期间被"合并丢弃"的强制广播，在本次结束后补跑一次。
 * 原实现是 `if (statusBuilding) return;` —— 上一帧没算完就直接丢掉这次变更，
 * 只能等 1.5s 安全网，表现为"状态变了但面板没动"。
 * 对普通帧无所谓（安全网会补），但对急停这种**必须即时**的帧就是真丢。 */
let statusPending = false;

async function broadcastStatus(o = {}) {
  if (!statusSubs.size) return;
  if (statusBuilding) {
    if (o.force) statusPending = true;
    return;
  }
  statusBuilding = true;
  try {
    let snap;
    try { snap = await buildStatusSnapshot(); } catch { return; }
    const json = JSON.stringify(snap);
    if (!o.force && json === lastStatusJson) return;   // 无变化不重复推，省带宽
    lastStatusJson = json;
    for (const res of statusSubs) sseSend(res, snap);
  } finally {
    statusBuilding = false;
    if (statusPending) {
      statusPending = false;
      broadcastStatus({ force: true }).catch(() => {});
    }
  }
}

// 安全网：订阅者存在时每 1.5s 重算并推送（仅在状态真变化时发送）。
// 覆盖未在显式广播点覆盖的少量状态变更；无订阅者时不跑。
const _statusTimer = setInterval(() => { broadcastStatus().catch(() => {}); }, 1500);
if (_statusTimer.unref) _statusTimer.unref();

/* ---------- OCR（截屏取词）：走 Windows 自带 OCR 引擎，离线、免安装、不限流 ---------- */

const OCR_PS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $t) { $m = $asTaskGeneric.MakeGenericMethod($t); $task = $m.Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime] | Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null
$path = '__PATH__'
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bmp = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('__LANG__')))
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw '本机没有可用的 OCR 语言（需在系统语言里装中文/英文 OCR）' }
$r = Await ($engine.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
/* 除了整段文本，还要**每行文字的位置** —— 取词要拿它给用户画高亮框，
   让用户一眼看出"框对了没有 / 有没有多框一行"。
   坐标取自 OcrWord.BoundingRect（词级），再按行取外接矩形：
   ⚠️ 不能直接用词级框 —— 中文被按"词"切得极碎，一个词一个框会画成一地碎格子。
   单位是**送进来的这张图的像素**，调用方不用再换算。 */
$boxes = @()
foreach ($L in $r.Lines) {
  $x1 = $null; $y1 = $null; $x2 = $null; $y2 = $null
  foreach ($w in $L.Words) {
    $b = $w.BoundingRect
    if ($null -eq $b) { continue }
    $wx1 = [double]$b.X; $wy1 = [double]$b.Y
    $wx2 = $wx1 + [double]$b.Width; $wy2 = $wy1 + [double]$b.Height
    if ($null -eq $x1) { $x1 = $wx1; $y1 = $wy1; $x2 = $wx2; $y2 = $wy2 }
    else {
      if ($wx1 -lt $x1) { $x1 = $wx1 }
      if ($wy1 -lt $y1) { $y1 = $wy1 }
      if ($wx2 -gt $x2) { $x2 = $wx2 }
      if ($wy2 -gt $y2) { $y2 = $wy2 }
    }
  }
  if ($null -eq $x1) { continue }
  $boxes += [pscustomobject]@{
    t = [string]$L.Text
    x = [int][math]::Floor($x1)
    y = [int][math]::Floor($y1)
    w = [int][math]::Ceiling($x2 - $x1)
    h = [int][math]::Ceiling($y2 - $y1)
  }
}
$out = [pscustomobject]@{ text = [string]$r.Text; lines = $boxes }
$out | ConvertTo-Json -Depth 5 -Compress
`;

/** 对 PNG 缓冲做 OCR，返回识别到的文字。 */
function ocrPng(buf, lang = "zh-Hans-CN") {
  return new Promise((resolve, reject) => {
    /* 临时图必须落 DATA_DIR：HERE 在打包态是 Program Files 下的 resources/，
       写不进去 —— 表现为 OCR 恒失败并只剩一句"写临时图片失败"。 */
    const tmpDir = path.join(DATA_DIR, "tmp");
    try { fsSync.mkdirSync(tmpDir, { recursive: true }); } catch { /* 已存在 */ }
    const tmp = path.join(tmpDir, `.ocr-${Date.now()}-${process.pid}.png`);
    try {
      fsSync.writeFileSync(tmp, buf);
    } catch (e) {
      return reject(new Error("写临时图片失败：" + e.message));
    }
    const script = OCR_PS.replace("__PATH__", tmp).replace("__LANG__", lang);
    const b64 = Buffer.from(script, "utf16le").toString("base64");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
      { timeout: 40000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try { fsSync.unlinkSync(tmp); } catch {}
        if (err) {
          return reject(new Error(String(stderr || err.message || "").trim().slice(0, 300) || "OCR 失败"));
        }
        resolve(parseOcrOut(String(stdout || "").replace(/^\uFEFF/, "").trim()));
      }
    );
  });
}

/**
 * OCR 输出解析。新版脚本吐 JSON（{text, lines:[{t,x,y,w,h}]}），
 * 但**任何异常都必须退回纯文本**：老系统 / 语言包装不上 / 输出被截断时，
 * 取词只是"没有高亮框"，绝不能因为没有框就整个不可用。
 */
function parseOcrOut(raw) {
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.text === "string") {
      const lines = (Array.isArray(j.lines) ? j.lines : [])
        .filter((l) => l && typeof l.t === "string" && String(l.t).trim())
        .map((l) => ({
          text: String(l.t),
          x: Math.max(0, Math.round(Number(l.x) || 0)),
          y: Math.max(0, Math.round(Number(l.y) || 0)),
          w: Math.max(1, Math.round(Number(l.w) || 1)),
          h: Math.max(1, Math.round(Number(l.h) || 1)),
        }));
      return { text: j.text, lines };
    }
  } catch { /* 不是 JSON —— 按纯文本处理 */ }
  return { text: raw, lines: [] };
}

/* ---------- 抗迁移：窗口锚定 / 文字锚定 / 落空兜底 ----------
 * 录制得到的点击都是「绝对屏幕坐标」。窗口一旦被拖动 / 缩放 / 重排，
 * 原来的按钮就不在那个点了 —— 这就是「按钮迁移」导致自动化失效的根因。
 *
 * 三道防线（统一在 resolveAnchor 里串行裁决）：
 *   1) 窗口相对坐标：录制时把「点落在哪个窗口、相对窗口左上角的偏移」记下来；
 *      回放时按窗口现在的左上角重新算出绝对坐标。窗口挪了也能点准。
 *   2) 文字锚定：用户在编辑器给某一步写上「锚定文字」（如"确定"），
 *      回放时对该窗口截图 OCR，找到这段文字就点它中心。按钮改名不碍事，
 *      只要文字还在就能点。
 *   3) 落空兜底：上述都失败（窗口找不到 / 文字没认出）时，退回录制时的
 *      绝对坐标，至少按原样试一次，而不是整步作废。
 */

const WIN_AT_POINT_PS = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class WAP{
 [DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(int x,int y);
 [DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint ga);
 [DllImport("user32.dll")]public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 public struct RECT{public int L,T,R,B;}
}
"@
$h=[WAP]::WindowFromPoint([int]__X__,[int]__Y__)
if($h-eq[IntPtr]::Zero){'NONE';exit}
$h=[WAP]::GetAncestor($h,2)
if($h-eq[IntPtr]::Zero){'NONE';exit}
$len=[WAP]::GetWindowTextLength($h)
$sb=New-Object System.Text.StringBuilder($len+1)
[WAP]::GetWindowText($h,$sb,$len+1)|Out-Null
$r=New-Object WAP+RECT
[WAP]::GetWindowRect($h,[ref]$r)|Out-Null
$ox=[int]__X__-$r.L
$oy=[int]__Y__-$r.T
($sb.ToString())+'|'+($r.L)+','+($r.T)+','+($r.R-$r.L)+','+($r.B-$r.T)+'|'+$ox+','+$oy
`;

const WIN_BY_TITLE_PS = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class WFT{
 [DllImport("user32.dll")]public static extern bool EnumWindows(EnumProc e,IntPtr l);
 [DllImport("user32.dll")]public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h);
 public delegate bool EnumProc(IntPtr h,IntPtr l);
 public struct RECT{public int L,T,R,B;}
}
"@
$t=__TITLE__
$t=[System.Management.Automation.WildcardPattern]::Escape($t)
$script:m=$null
$p=[WFT+EnumProc]{param($h,$l)
 if(-not [WFT]::IsWindowVisible($h)){return $true}
 $len=[WFT]::GetWindowTextLength($h)
 if($len-le 0){return $true}
 $sb=New-Object System.Text.StringBuilder($len+1)
 [WFT]::GetWindowText($h,$sb,$len+1)|Out-Null
 if($sb.ToString()-like "*$t*"){
  $rr=New-Object WFT+RECT
  [WFT]::GetWindowRect($h,[ref]$rr)|Out-Null
  $script:m=(($rr.L)+','+($rr.T)+','+($rr.R-$rr.L)+','+($rr.B-$rr.T))
  return $false
 }
 return $true
}
[WFT]::EnumWindows($p,[IntPtr]::Zero)|Out-Null
$script:m
`;

const OCR_WORDS_PS = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime|Out-Null
$asTaskGeneric=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name-eq 'AsTask'-and$_.GetParameters().Count-eq 1-and$_.GetParameters()[0].ParameterType.Name-eq 'IAsyncOperation\`1'})[0]
function Await($op,$t){$m=$asTaskGeneric.MakeGenericMethod($t);$task=$m.Invoke($null,@($op));$task.Wait(-1)|Out-Null;$task.Result}
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]|Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]|Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]|Out-Null
$path='__PATH__'
$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path))([Windows.Storage.StorageFile])
$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read))([Windows.Storage.Streams.IRandomAccessStream])
$decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))([Windows.Graphics.Imaging.BitmapDecoder])
$bmp=Await ($decoder.GetSoftwareBitmapAsync())([Windows.Graphics.Imaging.SoftwareBitmap])
$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language('__LANG__')))
if(-not $engine){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
if(-not $engine){throw '本机没有可用的 OCR 语言'}
$r=Await ($engine.RecognizeAsync($bmp))([Windows.Media.Ocr.OcrResult])
$lines=@()
foreach($line in $r.Lines){foreach($w in $line.Words){$b=$w.BoundingRect;$lines+=(($w.Text)+'|'+($b.X)+','+($b.Y)+','+($b.Width)+','+($b.Height))}}
$lines-join [char]10
`;

const SHOT_PS = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$x=[int]__X__;$y=[int]__Y__;$w=[int]__W__;$h=[int]__H__
if($w-le 0){$w=10}if($h-le 0){$h=10}
$bmp=New-Object System.Drawing.Bitmap($w,$h)
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x,$y,0,0,$bmp.Size)
$bmp.Save('__PATH__',[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose();$bmp.Dispose()
'OK'
`;

/* 虚拟桌面范围 + 前台窗口标题，一次 PowerShell 拿全。
   用虚拟桌面（76~79）而不是主屏（0/1）：目标窗口很可能被拖到副屏上，
   只截主屏会让「锚点明明在屏幕上却探不到」，从而白白多跑一轮接管。
   DPI 提示：这个进程是 DPI-unaware 的，取到的是逻辑尺寸，
   但 CopyFromScreen 用的也是逻辑坐标，两者一致，所以截图范围不会错。
   归一化后的小数由系统缩放，不影响「文字在不在」这个判断。 */
const SCREEN_PS = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class SFG{
 [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]public static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder t,int n);
 [DllImport("user32.dll")]public static extern int GetSystemMetrics(int i);
}
"@
$h=[SFG]::GetForegroundWindow()
$len=[SFG]::GetWindowTextLength($h)
$sb=New-Object System.Text.StringBuilder($len+1)
[SFG]::GetWindowText($h,$sb,$len+1)|Out-Null
$vx=[SFG]::GetSystemMetrics(76)
$vy=[SFG]::GetSystemMetrics(77)
$vw=[SFG]::GetSystemMetrics(78)
$vh=[SFG]::GetSystemMetrics(79)
if($vw-le 0){$vx=0;$vy=0;$vw=[SFG]::GetSystemMetrics(0);$vh=[SFG]::GetSystemMetrics(1)}
($vx.ToString()+','+$vy.ToString()+','+$vw.ToString()+','+$vh.ToString()+'|'+$sb.ToString())
`;

/** 跑一段 PowerShell（UTF-16LE 编码走 -EncodedCommand），返回 stdout。 */
function psRun(script, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(script, "utf16le").toString("base64");
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
      { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message || "").trim().slice(0, 300) || "PowerShell 失败"));
        resolve(String(stdout || ""));
      });
  });
}

/** 录制时：取某点的「所在窗口」信息（标题 + 矩形 + 相对左上角偏移）。 */
async function captureWinAt(x, y) {
  try {
    const out = await psRun(WIN_AT_POINT_PS.replace("__X__", String(Math.round(x))).replace("__Y__", String(Math.round(y))));
    const s = (out || "").trim();
    if (!s || s === "NONE") return null;
    const parts = s.split("|");
    if (parts.length < 3) return null;
    const rect = parts[1].split(",").map(Number);
    const off = parts[2].split(",").map(Number);
    if (rect.length !== 4 || off.length !== 2 || rect.some(isNaN) || off.some(isNaN)) return null;
    return { title: parts[0] || "", rect, off };
  } catch (e) {
    console.log("[anchor] 录制取窗口失败:", e?.message ?? e);
    return null;
  }
}

/** 回放时：按标题（子串）找可见窗口当前矩形。找不到返回 null（触发兜底）。 */
async function findWinRectByTitle(title) {
  if (!title) return null;
  try {
    const out = (await psRun(WIN_BY_TITLE_PS.replace("__TITLE__", title))).trim();
    if (!out || out === "NONE") return null;
    const r = out.split(",").map(Number);
    if (r.length !== 4 || r.some(isNaN)) return null;
    return r;
  } catch (e) {
    console.log("[anchor] 找窗口失败:", e?.message ?? e);
    return null;
  }
}

/** 截图指定区域为 PNG 缓冲（GDI，离线）。 */
async function screenshotRegion(x, y, w, h) {
  const tmpDir = path.join(DATA_DIR, "tmp");
  try { fsSync.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const tmp = path.join(tmpDir, `.shot-${Date.now()}-${process.pid}.png`);
  const script = SHOT_PS
    .replace("__X__", String(Math.round(x))).replace("__Y__", String(Math.round(y)))
    .replace("__W__", String(Math.round(w))).replace("__H__", String(Math.round(h)))
    .replace("__PATH__", tmp);
  try {
    await psRun(script, 20000);
    return fsSync.readFileSync(tmp);
  } catch (e) {
    console.log("[anchor] 截图失败:", e?.message ?? e);
    return null;
  } finally {
    try { fsSync.unlinkSync(tmp); } catch {}
  }
}

/** OCR 取词框：返回 [{text,x,y,w,h}]（坐标相对截图左上角）。 */
async function ocrWords(buf, lang = "zh-Hans-CN") {
  if (!buf) return [];
  const tmpDir = path.join(DATA_DIR, "tmp");
  try { fsSync.mkdirSync(tmpDir, { recursive: true }); } catch {}
  const tmp = path.join(tmpDir, `.ocw-${Date.now()}-${process.pid}.png`);
  try { fsSync.writeFileSync(tmp, buf); } catch (e) { return []; }
  const script = OCR_WORDS_PS.replace("__PATH__", tmp).replace("__LANG__", lang);
  const b64 = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", b64],
      { timeout: 40000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        try { fsSync.unlinkSync(tmp); } catch {}
        if (err) { console.log("[anchor] OCR 失败:", err?.message ?? err); return resolve([]); }
        const words = [];
        for (const line of String(stdout || "").split("\n")) {
          const i = line.lastIndexOf("|");
          if (i < 0) continue;
          const text = line.slice(0, i);
          const box = line.slice(i + 1).split(",").map(Number);
          if (box.length === 4 && box.every((n) => !isNaN(n))) words.push({ text, x: box[0], y: box[1], w: box[2], h: box[3] });
        }
        resolve(words);
      });
  });
}

/** 控件树锚定（方案 A1，默认关闭）：重新抓一次 Snapshot，用结构化树匹配把录制点
 *  重新定位到当前元素中心 —— 绕开 OCR 文字识别，抗改名/改版更稳。
 *  仅当 ORB_ANCHOR_TREE=1 时才注入到 resolveAnchor；默认不启用，桥行为不变。
 *  失败时返回 null，由 resolveAnchor 自动落到 OCR/坐标档。 */
/* 控件树抓取的短时复用：同一窗口里连点/连填的 burst 内共享一次 Snapshot，
 * 减少每步的 MCP 往返。纯时间窗（不按写操作失效）——陈旧树最坏只让 matchTreeNode
 * 命中失败退回 OCR/坐标，绝不误点。详见 anchorResolver.createTreeCache。 */
const snapTreeCache = createTreeCache(300);

/** 取控件树文本（带短时缓存）。失败返回 null（调用方自行兜底）。 */
async function getSnapshotText(timeoutMs = 20000) {
  const now = Date.now();
  const cached = snapTreeCache.get(now);
  if (cached != null) return cached;
  const r = await callTool("windows", "Snapshot", {}, timeoutMs);
  const txt = toolTextOf(r);
  if (txt) snapTreeCache.set(txt, now);
  return txt;
}

async function anchorByTree(step) {
  try {
    const txt = await getSnapshotText(20000);
    if (!txt) return null;
    const root = pruneSnapshotTree(parseSnapshotTree(txt));
    // 优先用录制期存下的 treeRef（结构化身份，不依赖回放坐标、不依赖 OCR）；
    // 没有/没命中时再按录制坐标重定位。裁决见 anchorResolver.resolveTreeNode。
    const hit = resolveTreeNode(root, step);
    if (!hit) return null;
    return { x: hit.x, y: hit.y, ref: hit.ref };
  } catch {
    return null;
  }
}

/** 录制期：抓一次控件树，把「光标点落在哪个控件」的结构化身份（sig）存进 step.treeRef。
 *  这样回放时直接按 sig 精确匹配，既不依赖录制坐标是否还准，也不依赖 OCR 文字识别。
 *  纯加成：抓不到就算了，回放仍走坐标 / OCR 兜底，不阻断录制。 */
async function captureTreeRef(step) {
  try {
    if (!step || !ANCHORABLE.has(`${step.server}|${step.tool}`)) return;
    const pp = primaryPoint(step);
    if (!pp) return;
    const txt = await getSnapshotText(20000);
    if (!txt) return;
    const root = pruneSnapshotTree(parseSnapshotTree(txt));
    const winName = step.win && step.win.title;
    const sel = buildTreeSelector(root, pp[0], pp[1], winName);
    if (sel && sel.sig) step.treeRef = sel.sig;
  } catch { /* 录制期抓不到不影响录制 */ }
  // 视觉档（C0 模板 / C1 CLIP）的录制期 crop：存一小块被点元素的图，回放时复用。
  // 与 treeRef 互补——treeRef 失手（无树/改名）时，视觉档仍能按"长什么样"定位。
  try { await captureVisualCrop(step, screenshotRegion); } catch { /* 不影响录制 */ }
}

/** 文字锚定：对目标窗口截图 OCR，找锚定文字中心。找不到返回 null。 */
async function anchorByText(step) {
  const a = step.args || {};
  if (!a.anchor) return null;
  const target = String(a.anchor).trim().toLowerCase();
  if (!target) return null;
  try {
    let rx = 0, ry = 0, rw = 0, rh = 0;
    if (step.win && step.win.title) {
      const r = await findWinRectByTitle(step.win.title);
      if (r) { rx = r[0]; ry = r[1]; rw = r[2]; rh = r[3]; }
    }
    if (!rw || !rh) {                       // 没窗口信息就裁一小块围住录制点
      const pp = primaryPoint(step);
      if (!pp) return null;
      rx = Math.max(0, pp[0] - 200); ry = Math.max(0, pp[1] - 100); rw = 400; rh = 200;
    }
    const buf = await screenshotRegion(rx, ry, rw, rh);
    const words = await ocrWords(buf, "zh-Hans-CN");
    const pp = primaryPoint(step);
    let best = null, bestD = Infinity;
    for (const w of words) {
      if (w.text.toLowerCase().includes(target)) {
        const cx = w.x + w.w / 2, cy = w.y + w.h / 2;     // 相对截图
        const d = pp ? Math.hypot(cx - (pp[0] - rx), cy - (pp[1] - ry)) : 0;
        if (d < bestD) { bestD = d; best = { x: rx + cx, y: ry + cy }; }
      }
    }
    if (best) { console.log(`[anchor] 文字「${a.anchor}」命中 (${best.x},${best.y})`); return best; }
    console.log(`[anchor] 文字「${a.anchor}」未识别，转兜底`);
  } catch (e) {
    console.log("[anchor] 文字锚定异常:", e?.message ?? e);
  }
  return null;
}

/**
 * 统一裁决抗迁移策略，返回 { args, conf }（不改动原 step）。
 * 顺序：① 文字锚定 → ② 窗口相对坐标 → ③ 绝对坐标兜底。
 *
 * conf 记录「这次定位到底有多可信」，上层据此决定要不要升级到视觉层：
 *   text     文字锚定命中 —— 最可信，界面改版也常能活
 *   window   窗口相对命中 —— 可信，窗口被拖动/换位置也跟得上
 *   absolute 配了锚点却落到录制坐标 —— ⚠️ **真降级**，说明锚点没找到
 *   none     本来就没配锚点，只有录制坐标 —— 正常路径，不算降级
 *
 * absolute 与 none 必须分开：只有 absolute 才值得叫视觉模型。
 * 混成一个「兜底」的话，没配锚点的步骤每步都会触发升级，成本和延迟直接崩。
 */
/* 抗迁移策略裁决器（由 anchorResolver.mjs 的纯逻辑组装，这里只注入有副作用的解析器）。
 * 顺序：① 控件树锚定（方案 A1，默认关闭）→ ② 文字锚定(OCR) → ③ 窗口相对坐标 → ④ 绝对坐标兜底。
 * conf 记录「这次定位有多可信」，上层据此决定是否升级到视觉层：
 *   tree     控件树匹配命中 —— 最可信（结构化匹配，抗改名/改版）
 *   text     文字锚定命中 —— 可信，界面改版也常能活
 *   window   窗口相对命中 —— 可信，窗口被拖动/换位置也跟得上
 *   absolute 配了锚点却落到录制坐标 —— ⚠️ **真降级**，说明锚点没找到
 *   none     本来就没配锚点，只有录制坐标 —— 正常路径，不算降级
 * absolute 与 none 必须分开：只有 absolute 才值得叫视觉模型。
 * tree/text/window 都视为高可信，不触发视觉升级（与 absolute 严格区分）。 */
const resolveAnchor = createAnchorResolver({
  anchorByText,
  // 控件树锚定**默认常驻开启**（用户要求）：回放时优先按控件树结构化定位，
  // 只有显式设 ORB_ANCHOR_TREE=0 才关闭（保留一个逃生口，便于排查/降级）。
  // 开启后每个带锚点的单点步骤会额外抓一次 Snapshot；新录的自动化带 treeRef，
  // 直接按 sig 匹配，不再依赖 OCR。
  anchorByTree: process.env.ORB_ANCHOR_TREE === "0" ? null : anchorByTree,
  // 视觉锚定（方案 C 的 C0/C1 两档）：不依赖控件树、不依赖文字，按"长什么样"定位。
  // 录制期已抓 crop 存进 step.visualCrop；回放时 C0 模板命中即返回，未命中才上 C1 CLIP。
  anchorByVisual: createVisualAnchor({ screenshotRegion }),
  findWinRectByTitle,
  /* S4 / V-13 / C-07 降级纪律：自属 Electron 界面（UIA 读不到）在 resolveAnchor 层
   * 就跳过视觉档（③），即「明确不接回 runVision()」的前半段。纯现场判定、无副作用。 */
  degradation: (step) => ({
    selfElectron: isSelfElectronWindow(step && step.win && step.win.title),
  }),
  onLoopExit: (e) => {
    log(`[s4] 脱离视觉循环 ${e.code}：${e.reason}`);
    try {
      logBus.write({ category: "safety", level: "warn", epoch: epochOf(),
        message: `[s4] 视觉锚定降级：${e.code} / ${e.degradeTo}（step=${e.step && e.step.tool}）` });
    } catch {}
  },
});

/* ---------------- 回归探测 + 智能接管 ----------------
 * 这两块是「录制一遍，正常情况下纯回放，界面变了才请模型帮忙」的核心。
 * 关键判断都写在各自注释里，因为这里的每一处取舍都是拿事故换的。
 */

/** 取虚拟桌面范围 + 当前前台窗口标题。失败返回 null。 */
async function screenAndForeground() {
  try {
    const out = String((await psRun(SCREEN_PS, 10000)) || "");
    const i = out.indexOf("|");
    if (i < 0) return null;
    const box = out.slice(0, i).split(",").map(Number);
    if (box.length !== 4 || box.some(isNaN) || !box[2] || !box[3]) return null;
    return { x: box[0], y: box[1], w: box[2], h: box[3], title: out.slice(i + 1).trim() };
  } catch (e) {
    console.log("[probe] 取屏幕信息失败:", e?.message ?? e);
    return null;
  }
}

/**
 * 把逐词 OCR 结果合并成「行」，行内按 x 排序后直接拼接。
 *
 * 两件事都必须做：
 *   ① 合并 —— WinRT OCR 会把「确定」切成「确」「定」两个独立词，
 *      不合并的话锚点文字哪怕就在屏幕正中间也永远匹配不上。
 *   ② 行内重排 —— 同一行文字的 y 会有一两个像素的基线抖动，
 *      直接按 y 排序会把「确(100) 定(102) 取消(101)」排成「确取消定」，
 *      于是 "确定" 这个词在屏幕上是断开的，匹配照样失败。
 *      （这个 bug 是单测抓出来的，肉眼评审看不出来。）
 */
function ocrLines(words) {
  const sorted = (words || []).slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const rows = [];
  for (const w of sorted) {
    const last = rows[rows.length - 1];
    const tol = Math.max(6, (w.h || 12) * 0.6);       // 行高的一半内算同一行
    // 已按 y 升序，同一行的词必然连续，所以只跟最后一个桶比就够；
    // baseY 用均值而不是首词的 y，否则一行内 y 慢慢爬升时后半截会被切成新行。
    if (last && Math.abs(w.y - last.baseY) <= tol) {
      last.items.push(w);
      last.baseY = (last.baseY * (last.items.length - 1) + w.y) / last.items.length;
    } else {
      rows.push({ baseY: w.y, items: [w] });
    }
  }
  return rows.map((r) => r.items
    .sort((a, b) => a.x - b.x)
    .map((w) => w.text)
    .join("")
    .toLowerCase());
}

/**
 * 回归探测：判断「现在这块屏幕对应原流程的第几步」。
 *
 * 为什么不问智能体「你干到第几步了」：模型没有步骤计数的内部状态，
 * 只是在看屏幕猜，而且倾向于给一个看起来合理的数字。拿它去对齐重放，
 * 等于把「点错位置」换成「跳错步骤」——后者难查得多。
 * 所以这里只认客观证据：屏幕上的文字、前台窗口标题。
 *
 * 返回 { resumeAt, via } 或 null（未回归）。
 */
/**
 * 纯判定：给定「剩余步骤 + 屏幕上的文字行 + 前台窗口标题」，算出回归点。
 * 单独抽出来是为了能脱离 PowerShell 单测 —— 这段逻辑判错了比慢更难发现：
 * 它不报错，只是让流程从错的地方接着跑。
 *
 * lines 已经过 ocrLines 合并（行内无分隔），所以「确 定」能匹配「确定」。
 */
function pickResumePoint(rest, lines, foregroundTitle, from) {
  const onScreen = (s) => {
    const t = String(s || "").trim().toLowerCase();
    if (!t) return false;
    return lines.some((l) => l.includes(t));
  };

  // ① 文字锚点：按序号从小到大扫，第一个命中的就是断点。
  // 不能按屏幕位置扫——第 6 步和第 9 步都叫「确定」时，按位置会命中错的那个；
  // 按序号取最小才符合「流程往前走」的语义。命中即停，不收集全部：
  // 收全部再取最靠后的，会把智能体多干的那几步误判成「还没干」。
  for (let i = 0; i < rest.length; i++) {
    const s = rest[i] || {};
    const a = s.args && s.args.anchor;
    if (!a || !ANCHORABLE.has(`${s.server}|${s.tool}`)) continue;   // 没配锚点 → 探测里隐形
    if (!onScreen(a)) continue;
    /* 隐形步骤不能被跨过：中间夹着没配锚点的步骤就拒绝回归。
       因为无法确认那一步到底做没做——跳过去可能漏动作或做两遍。
       宁可多跑一轮智能体，也不能跳步。 */
    const skipped = rest.slice(0, i).some((x) => !(x && x.args && x.args.anchor));
    if (skipped) {
      console.log(`[probe] 第 ${from + i + 1} 步命中「${a}」，但中间有未配锚点的步骤，拒绝回归`);
      continue;
    }
    console.log(`[probe] 回归点 = 第 ${from + i + 1} 步（文字「${a}」在屏幕上）`);
    return { resumeAt: from + i, via: "anchor" };
  }

  // ② 窗口标题：文字全对不上时退一步，看前台窗口是不是某一步的目标窗口
  if (foregroundTitle) {
    const ft = String(foregroundTitle).toLowerCase();
    for (let i = 0; i < rest.length; i++) {
      const w = rest[i] && rest[i].win && rest[i].win.title;
      if (w && ft.includes(String(w).toLowerCase())) {
        console.log(`[probe] 窗口命中：前台「${foregroundTitle}」≈ 第 ${from + i + 1} 步`);
        return { resumeAt: from + i, via: "window" };
      }
    }
  }

  return null;
}

async function probeAnchors(steps, from) {
  const rest = (steps || []).slice(from);
  if (!rest.length) return null;

  const scr = await screenAndForeground();
  if (!scr) return null;

  let words = [];
  try {
    /* 超宽桌面（双 4K 拼接能到 7680）直接跳过文字探测：
       这种图 OCR 要么超时要么糊成一团，拿它做判断比不做还糟。
       跳过之后上层会继续交给智能体，慢一点但不会判错。 */
    if (scr.w > 6000 || scr.h > 6000) {
      console.log(`[probe] 桌面 ${scr.w}x${scr.h} 过大，跳过文字探测`);
    } else {
      const buf = await screenshotRegion(scr.x, scr.y, scr.w, scr.h);
      if (buf) words = await ocrWords(buf, "zh-Hans-CN");
    }
  } catch (e) {
    console.log("[probe] 全屏 OCR 失败:", e?.message ?? e);
  }

  return pickResumePoint(rest, ocrLines(words), scr.title, from);
}

/** 把剩余步骤压成可读清单，给接管时的智能体当上下文。
 *  它必须知道「本来打算干什么」，否则只能盯着当前画面瞎猜下一步。 */
function summarizeSteps(steps, limit = 8) {
  const out = [];
  const list = steps || [];
  list.slice(0, limit).forEach((s, i) => {
    const t = (s && s.type) || "action";
    if (t !== "action") { out.push(`${i + 1}. [${t}] 编排节点`); return; }
    const a = (s && s.args) || {};
    const bits = [];
    if (a.anchor) bits.push(`目标「${a.anchor}」`);
    if (a.text) bits.push(`输入「${String(a.text).slice(0, 24)}」`);
    if (a.keys) bits.push(`按键 ${Array.isArray(a.keys) ? a.keys.join("+") : a.keys}`);
    if (Array.isArray(a.loc)) bits.push(`录制坐标 ${a.loc[0]},${a.loc[1]}`);
    out.push(`${i + 1}. ${(s && s.tool) || "?"} ${bits.join(" ")}`.trim());
  });
  if (list.length > limit) out.push(`… 还有 ${list.length - limit} 步未列出`);
  return out.join("\n");
}

const AGENT_BATCH = 3;          // 每轮让智能体推进几步就停下重新探测
const AGENT_MAX_STEPS = 15;     // 一次接管累计最多借给它多少步
const AGENT_MAX_ROUNDS = 5;     // 一次回放最多允许「接管→回归」来回几趟

/* ---------------- 轮次推定 ----------------
 * 嵌套循环里失守时，光知道「回到子单元第几步」不够 —— 还得知道「回到第几轮」。
 * 三个来源，按可信度从硬到软。都做成纯函数，因为判错了不会报错，
 * 只会让循环多跑一轮或少跑一轮（重复提交 / 漏提交），这种错最难查。
 */

/**
 * 校验模型自报的轮次有没有自证。
 * 规则：evidence 里必须真的出现那个数字。
 *
 * 为什么不能只信 roundSeen：模型没有轮次计数器，它就是看屏幕猜，
 * 而且倾向于给一个「看起来合理」的数。但让它把原文抄下来，
 * 它就很难既编数字又编出处 —— 这是最便宜的防幻觉手段。
 */
function verifyRoundClaim(seen, evidence) {
  const n = Number(seen);
  // 必须是正整数：小数（3.5 条）和负数都不该出现在轮次计数里，直接判为无效
  if (!Number.isInteger(n) || n < 0 || n > 100000) return null;
  const ev = String(evidence || "").trim();
  if (ev.length < 2) return null;
  // 数字必须以「独立数字」的形式出现：前面不能紧贴别的数字，后面同理。
  // 否则 "已处理 30 条" 会把 3 也判成命中。
  const re = new RegExp(`(^|\\D)0*${n}(\\D|$)`);
  if (!re.test(ev)) return null;
  return Math.floor(n);
}

/**
 * 数「轮次标记动作」被成功执行了几次。
 * 数据源是审计表 —— callTool 每调一次工具就写一条，所以这里零成本，
 * 不用额外埋点。传 entries 而不是直接读全局，是为了能单测。
 *
 * perRound：每轮对应几次该动作（默认 1）。这一项故意留给用户配，
 * 因为「点了 3 次提交 ≠ 完成了 3 轮」——有一次点了没生效时，
 * 只有用户知道该按几次算一轮。程序不该假装能自动推断。
 */
function countMarks(entries, since, mark, perOverride) {
  if (!mark || typeof mark !== "object") return null;
  const tool = String(mark.tool || "Click");
  const anchor = String(mark.anchor || "").toLowerCase();
  // perOverride 用来传「每轮几次」：优先实测值，其次静态数，最后用户手填
  const per = Math.max(1, Number(perOverride) || Number(mark.perRound) || 1);
  let n = 0;
  for (const e of entries || []) {
    if (Number(e.ts) < since) continue;         // 只看本次运行
    if (!e.ok) continue;                        // 调用就直接失败的不能算
    if (String(e.tool) !== tool) continue;
    if (anchor && !String(e.args || "").toLowerCase().includes(anchor)) continue;
    n++;
  }
  return Math.floor(n / per);
}

/**
 * 数「循环体里这个标记动作出现了几次」——也就是每轮应该点几次。
 *
 * 为什么直接数而不问用户：循环体是静态的步骤数组，答案本来就写在里面。
 * 让用户再填一遍「每轮几次」纯属重复劳动，而且他会填错。
 *
 * if 的两支用 max 不是相加：分支只会走一支。
 * loop 的 body 递归进去，但只算一次（内层循环的重复次数不叠乘 ——
 * 标记动作基本都是「提交」这种收尾动作，不会藏在内层循环里；
 * 叠乘反而会在嵌套循环下炸出离谱的分母）。
 */
function countMarkInSteps(body, mark) {
  if (!mark || typeof mark !== "object") return 0;
  const tool = String(mark.tool || "Click");
  const anchor = String(mark.anchor || "").toLowerCase();
  const hit = (s) => {
    if (String(s.tool) !== tool) return false;
    if (!anchor) return true;
    let t = "";
    try { t = JSON.stringify(s.args || {}); } catch { t = ""; }
    return t.toLowerCase().includes(anchor);
  };
  let n = 0;
  for (const s of body || []) {
    if (!s || typeof s !== "object") continue;
    const t = s.type || "action";
    if (t === "action") { if (hit(s)) n++; continue; }
    if (t === "loop") { n += countMarkInSteps(s.body, mark); continue; }
    if (t === "if") { n += Math.max(countMarkInSteps(s.then, mark), countMarkInSteps(s.else, mark)); continue; }
  }
  return n;
}

/**
 * 步骤签名：用来判断「这两段录制是不是同一个循环体的重复」。
 * 关键是把坐标按 40px 量化后收进签名 —— 不收的话，所有纯点击的签名都是
 * `Click|{}`，任何两段都会「看起来一样」；量化后同一位置的重复才算相同，
 * 不同位置的点击不会混为一谈。
 */
function stepSig(s) {
  const a = (s && s.args) || {};
  const keep = {};
  for (const k of ["anchor", "text", "keys", "shortcut", "button", "clicks", "direction", "wheel_times", "durationMs"]) {
    if (a[k] !== undefined) keep[k] = a[k];
  }
  const q = (v) => Math.round(Number(v) / 40) || 0;
  if (Array.isArray(a.loc)) keep.loc = [q(a.loc[0]), q(a.loc[1])];
  else if (a.x !== undefined) keep.xy = [q(a.x), q(a.y)];
  return `${(s && s.type) || "action"}:${(s && s.tool) || ""}:${JSON.stringify(keep)}`;
}

/** 比较 arr[a..a+len) 与 arr[b..b+len) 是否逐位相同 */
function sameRange(arr, a, b, len) {
  for (let i = 0; i < len; i++) if (arr[a + i] !== arr[b + i]) return false;
  return true;
}

/**
 * 检测录制产物里有没有「同一段操作重复了 k 次」。
 *
 * 录制是平的：用户实际处理了 3 条数据，录下来就是 3 段一模一样的步骤，
 * 自动化里却看不出一丝「循环」的意思。这个函数把那段找出来，
 * 让面板能问一句「要不要折叠成重复 3 次的循环」。
 *
 * 只认**完全相同**的重复。每轮输入内容不同（读第 1/2/3 行数据填进去）
 * 时签名就不相等，检测会失败 —— 那是「参数化录制」该管的事，不在这。
 *
 * 返回 { count, unitLen, start, tail } 或 null。
 */
function detectRepeat(steps) {
  const list = (steps || []).filter((s) => s && typeof s === "object");
  const n = list.length;
  if (n < 4) return null;                      // 至少两轮、每轮两步，否则不值得折

  const arr = list.map(stepSig);
  // 全是同一个签名（比如连点四下同一处）说明根本没有「一段操作」，
  // 折成循环只会变成「循环点 4 次」，没有意义
  if (new Set(arr).size < 2) return null;

  let best = null;
  // 开头可能有一两个一次性步骤（打开软件、点菜单），所以起点允许偏移
  for (let start = 0; start < Math.min(3, n); start++) {
    const room = n - start;
    /* 单元至少两步：单步重复不是循环。
       「连点两次保存」在录制里到处都是，按循环处理纯属误报 ——
       真需要连点 N 次，用户直接多录几下就行，折成「循环 1 步」反而更难改。 */
    for (let L = 2; L <= Math.floor(room / 2); L++) {
      let k = 1;
      while (start + (k + 1) * L <= n && sameRange(arr, start, start + k * L, L)) k++;
      if (k < 2) continue;
      const covered = k * L;
      if (!best || covered > best.covered) {
        best = { count: k, unitLen: L, start, covered, tail: n - start - covered };
      }
    }
  }
  if (!best) return null;
  // 覆盖不到一半就不提 —— 说明只是零散地撞了几次，不是真循环
  if (best.covered < n * 0.5) return null;
  return { count: best.count, unitLen: best.unitLen, start: best.start, tail: best.tail };
}

/**
 * 三轮推定，返回「已完成的轮数」（= 下一轮应有的索引），拿不到返回 null。
 *   ① 模型自证 —— 有原文，最可信
 *   ② 审计动作计数 —— 客观但可能虚高
 * ③（纯自报无原文）不走这里，在调用方就被 verifyRoundClaim 挡掉了。
 * 两者冲突时信 ①（它有原文），但记日志，方便事后对账。
 */
function deduceRound(res, scope, entries, since) {
  if (!scope || scope.kind !== "times") return null;
  const byClaim = verifyRoundClaim(res && res.roundSeen, res && res.roundEvidence);
  /* perRound 优先用「上一轮实测值」：循环体里有分支时静态数不准
     （有的轮次走复核分支多点一次），实测能自动收敛。
     第一轮还没有实测值，退回静态数。 */
  const per = Number(scope.lastRoundCount) > 0
    ? Number(scope.lastRoundCount)
    : Number(scope.markPerRound) || 1;
  const byMark = scope.mark ? countMarks(entries, since, scope.mark, per) : null;

  if (byClaim !== null && byMark !== null && byClaim !== byMark) {
    log(`[round] 自证 ${byClaim} 与动作计数 ${byMark}（每轮按 ${per} 次算）不一致，采信自证（有原文）`);
  }
  if (byClaim !== null) return byClaim;
  if (byMark !== null) return byMark;
  return null;
}

/** 给智能体看的「你现在在哪一层」。null = 顶层线性流程。 */
function scopeInfo(ctx) {
  const st = (ctx && ctx.scopes) || [];
  const top = st[st.length - 1];
  if (!top) return null;
  return {
    depth: st.length,
    kind: top.kind,
    round: top.iter() + 1,
    total: top.kind === "times" ? top.total : 0,
  };
}

/**
 * 循环游标能不能跳到 to（to = 已完成轮数，也是下一轮应有的索引）。
 * 只允许往前：倒退等于把已经做过的事重做一遍，可能重复提交。
 * to === total 表示全部做完，允许 —— 循环会自然退出。
 * 抽成纯函数只为一件事：这段判断一旦写错，后果是重复提交或漏提交，
 * 现场看不出来，必须能单独测。
 */
function canJump(from, to, total) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(total)) return false;
  return to > from && to <= total;
}

/**
 * 轮次对齐：把「已经做到第几轮」写回当前循环的游标。
 * 只对 times 型有意义 —— while 型靠条件决定要不要继续，改游标没用
 * （它的条件每轮都会重算，接管把剩下的干完了，条件自然就 false 了）。
 */
function alignRound(res, ctx) {
  const st = (ctx && ctx.scopes) || [];
  const scope = st[st.length - 1];
  if (!scope || scope.kind !== "times") return;
  const done = deduceRound(res, scope, AUDIT_MEM, Number(scope.since) || Number(ctx.startedAt) || 0);
  if (done === null) {
    log("[round] 拿不到可信轮次，游标不动");
    return;
  }
  const before = scope.iter();
  if (scope.jumpTo(done)) {
    log(`[round] 轮次对齐：第 ${before + 1} 轮 → 已完成 ${done} 轮，下一轮从第 ${done + 1} 轮开始`);
  } else {
    // 倒退或越界：宁可不动。倒退会把已经做过的事重做一遍。
    log(`[round] 推定已完成 ${done} 轮（当前第 ${before + 1} 轮 / 共 ${scope.total} 轮），不可用，游标不动`);
  }
}

/**
 * 预算式智能接管：分批推进，每批停下就探一次「是否已回到原轨道」。
 *
 * 分批而不是「让它一路跑到结束」，理由很硬：跑过头的步骤没法回退
 * （比如已经点了提交），只有每批都停下来探一次，才可能及早抓回确定性轨道。
 *
 * 返回：可继续的步骤索引；'fallback' 表示 once 模式没救回来（用录制坐标顶上）；
 *       null 表示放弃。
 */
async function takeover(steps, from, ctx) {
  const list = steps || [];
  if (ctx.q) ctx.q.takeovers++;   // 智能接管 handshake 次数：确定性执行退化的直接指标
  const once = ctx.escalate === "once";

  /* S4 独立刹车：视觉循环预算。每进一次接管记一轮，耗尽即脱离，绝不无限截图调模型。
   * 记 safety.warn + 状态行，让「为什么停」在日志里查得到（方案 S4 的可解释要求）。 */
  if (ctx.s4VisualBudget) {
    const used = ctx.s4VisualBudget.take();
    if (ctx.s4VisualBudget.exhausted()) {
      const reason = `视觉循环预算耗尽（第 ${used}/${ctx.s4VisualBudget.cap()} 轮），脱离循环降级交人工`;
      log(`[s4] ${reason}`);
      try {
        logBus.write({ category: "safety", level: "warn", epoch: epochOf(),
          message: `[s4] VISUAL_LOOP_EXHAUSTED：${reason}` });
      } catch {}
      return once ? "fallback" : null;
    }
  }

  /* 命令短路：视觉接管之前，先看这个任务的最终目标能不能直接用命令通道完成
     （"用 X 打开 Y" / "运行 X" / "把 … 写入 …"）。能就一步做完，省掉整轮视觉。
     只做一次（ctx.cmdTried），且只在高置信时才动手；失败一律回落原视觉路径。 */
  /* 急停期间绝不做命令短路：这条路径不走 callToolRaw，是原先唯一能绕过刹车的地方。 */
  if (!ctx.cmdTried && ctx.goal && !STOP.on) {
    ctx.cmdTried = true;
    // 探测式：先查环境（which/exists）再决定；探测失败/不确定一律回落视觉
    const c = await probeCommandable(ctx.goal, prober);
    // 自动短路只放行「低风险」：排除 cli-explicit（git/npm…）与危险文件操作（move/rename/copy覆盖）——
    // 这两类必须走 /api/act 的确认闸门，绝不能在视觉接管里"悄悄执行"。
    const isDanger = !!(c.intent && c.intent.danger);
    if (c.commandable && !String(c.rule).startsWith("cli-explicit") && !isDanger) {
      try {
        const r = await freeTier.route(c.intent);
        ctx.finished = true;
        log(`[agent] 目标可命令化（${c.rule}），已用命令通道完成（via=${r.via}），跳过视觉接管`);
        return list.length;
      } catch (e) {
        log(`[agent] 命令短路失败（${c.rule}），回落视觉：${e?.message ?? e}`);
      }
    } else if (c.commandable) {
      log(`[agent] 目标需确认（${c.rule}${isDanger ? "／危险文件操作" : "／显式 CLI"}），不自动短路，交视觉或手动`);
    }
  }

  /* 全局次数守卫：回归之后又在下游失守，会再一次进来。
     不设上限的话，一条到处都失守的流程会不停「接管→回归→再失守」，
     token 烧光了还停不下来。 */
  ctx.agentRuns = (Number(ctx.agentRuns) || 0) + 1;
  if (ctx.agentRuns > AGENT_MAX_ROUNDS) {
    log(`[agent] 本次回放已接管 ${ctx.agentRuns - 1} 次，达到上限，不再接管`);
    return once ? "fallback" : null;
  }

  const budget = once ? 1 : Math.max(1, Math.min(AGENT_MAX_STEPS, Number(ctx.agentBudget) || AGENT_MAX_STEPS));
  let used = 0;

  while (used < budget) {
    const batch = Math.min(AGENT_BATCH, budget - used);
    let res;
    try {
      res = await askPanelForAgent({
        stepNo: from + 1,
        totalNo: list.length,
        goal: String(ctx.goal || "").trim(),
        batch,
        remain: summarizeSteps(list.slice(from)),
        conf: ctx.lastConf || "absolute",
        // 方案 E：硬偏好——接管发生在「界面变了」时，控件树是最该先用的手段；
        // 只有验证码/画布/图片类任务才让视觉模型上。面板侧据此决定先看树还是先截图。
        prefer: preferSnapshotRef(String(ctx.goal || ""), { hasTree: true }).mode,
        // 嵌套结构里必须告诉它「你在哪一层、第几轮」，否则它会把这轮当成唯一的一轮
        scope: scopeInfo(ctx),
      });
    } catch (e) {
      log("[agent] 接管失败：", e?.message ?? e);
      return once ? "fallback" : null;
    }

    // 面板回报用了多少步。用 max(1,…) 保证一定推进计数，否则失败回报 0 步会死循环。
    const did = Math.max(1, Number(res.steps) || 1);
    used += did;

    /* 整条流程结束 —— 只认 finished。
       done 的含义是「这一批做完了」，finished 才是「最终目标达成了」。
       混为一谈会让接管在第一批就收工，后面所有步骤静默丢掉。
       置 ctx.finished 而不是只 return：嵌套层返回只能结束本层，
       父层的循环还会照样跑下一轮。 */
    if (res.done && res.finished) {
      ctx.finished = true;
      log("[agent] 智能体判定最终目标已达成，整条流程结束");
      return list.length;
    }

    // 先看屏幕证据（客观，优先）
    const back = await probeAnchors(list, from);
    if (back && back.resumeAt > from) {
      alignRound(res, ctx);
      log(`[agent] 回归轨道：从第 ${back.resumeAt + 1} 步继续（依据 ${back.via}）`);
      return back.resumeAt;
    }

    /* 屏幕证据说「没往前走」。最常见的原因是：按钮点完还留在原处，
       于是 from 那一步的锚点一直在，探测永远原地打转。
       这时用智能体自报的进度做**交叉验证**：只有它说的那一步的目标
       确实出现在屏幕上（说明它真走到了那儿），才采信这个数字。
       自报不能单独用 —— 模型没有步骤计数器，那个数字是猜的。

       编号基准要小心：智能体看到的是 summarizeSteps 给的那份清单，
       编号从 1 起、对应 from 开头。所以全局索引 = from + 自报 - 1。
       （第一版忘了 −1，导致自报永远对不上，被探测一路否掉。） */
    const claim = from + Number(res.resumeAt) - 1;
    if (Number.isFinite(claim) && claim > from && claim < list.length) {
      const at = await probeAnchors(list, claim);
      if (at && at.resumeAt === claim) {
        alignRound(res, ctx);
        log(`[agent] 采信自报进度：第 ${claim + 1} 步（探测已确认该步目标在屏幕上）`);
        return claim;
      }
      log(`[agent] 自报第 ${claim + 1} 步，但探测不认（该步目标没出现），继续推进`);
    }

    if (back) log(`[agent] 探测仍指向第 ${from + 1} 步，视为未推进`);
    log(`[agent] 本轮推进 ${did} 步仍未回归（已用 ${used}/${budget}）`);
  }

  log(`[agent] 接管累计 ${used} 步仍未回归，放弃`);
  return once ? "fallback" : null;
}

/* ---------- ASR 服务（本地 Whisper）：进程管理 + CPU/GPU 切换 ---------- */

/* ASR 目录双路径探测（DESIGN §5.1）：
     打包态 <APP_ROOT>/resources/asr（pack.cjs 随包复制源码四件套）
     开发态 <项目根>/asr
   ORB_ASR_DIR 可强制覆盖（§6.2 环境变量约定）。 */
const APP_ROOT = path.resolve(HERE, "..");
/** 取第一个存在的路径；都没有就返回最后一个（让上层 existsSync 去报"找不到"） */
function firstExisting(paths) {
  for (const p of paths) { try { if (p && fsSync.existsSync(p)) return p; } catch { /* ignore */ } }
  return paths[paths.length - 1] || "";
}
const ASR_DIR = process.env.ORB_ASR_DIR
  || firstExisting([path.join(APP_ROOT, "resources", "asr"), path.resolve(HERE, "..", "asr")]);
const ASR_SCRIPT = path.join(ASR_DIR, "asr_server.py");
const ASR_CONF = path.join(ASR_DIR, "asr.conf");
/* 解释器优先级（DESIGN §5.1）：
     ① asr/venv/Scripts/python.exe —— 用户一键安装（prepare.ps1）建的独立 venv，
        依赖（faster-whisper 等）全在里面，与前台通道的运行时互不污染；
     ② 随包嵌入 python（runtime.mjs 解析）—— 只是保底：没有 fastapi/faster-whisper，
        asr_server 起不来，由 /health 超时把真实状态报给面板，不会崩。
   PYTHONPATH 指向用户自管的 asr/site-packages（可选，给不想建 venv 的人留的口）。 */
function asrVenvPy() { return path.join(ASR_DIR, "venv", "Scripts", "python.exe"); }
function asrPython() {
  const venv = asrVenvPy();
  if (fsSync.existsSync(venv)) return venv;
  const rt = resolvePython();
  return rt.ok && rt.exe ? rt.exe : venv;
}
/** 用户是否已完成一键安装（venv 就绪）—— 自启门槛与"需要安装"提示都看它 */
function asrInstalled() { return fsSync.existsSync(asrVenvPy()); }
/** SenseVoice 权重是否就位（首选引擎：228MB int8 ONNX，带情绪识别） */
function asrSenseVoiceReady() {
  const d = path.join(ASR_DIR, "models", "sensevoice");
  return fsSync.existsSync(path.join(d, "model.int8.onnx")) && fsSync.existsSync(path.join(d, "tokens.txt"));
}
/** 模型权重是否已下载。**两条引擎任一就绪就算就绪**：
 *  SenseVoice（models/sensevoice/，优选）或 Whisper（models/<name>/model.bin，兜底）。
 *  反过来说，"这里说没就绪但 /health 说 ready"是不可能的 —— 两条都查了。 */
function asrModelDownloaded() {
  if (asrSenseVoiceReady()) return true;
  const name = String(readAsrConf().model || "small");
  return fsSync.existsSync(path.join(ASR_DIR, "models", name, "model.bin"));
}
/** 本地已下全权重的模型名列表（面板显示"已下载：small / medium"）；
 *  服务在跑时以 /health 的 modelsAvailable 为准，没跑就自己扫 models/ 目录。 */
function asrModelsAvailable() {
  const base = path.join(ASR_DIR, "models");
  let names = [];
  try {
    names = fsSync.readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fsSync.existsSync(path.join(base, d.name, "model.bin")))
      .map((d) => d.name)
      .sort();
  } catch { /* models/ 不存在（没装）就是空列表 */ }
  return names;
}
/** 可追加下载的模型权重（name → HF repo）。
 *  small 由一键安装（prepare.ps1）负责；medium 等额外模型走 /api/asr/model，
 *  供首跑向导的「可选组件」勾选后下载（≈1.5GB，默认不勾）。 */
const ASR_MODEL_REPOS = {
  small: "Systran/faster-whisper-small",
  medium: "Systran/faster-whisper-medium",
};
/* ASR 自动启动开关：ORB_ASR_AUTOSTART=0 可关掉。
 * 正常不用设；主要是给单测用 —— 测试会 spawn 真 bridge，
 * 若这时自动拉起 Whisper（small 模型 + GPU），又慢又会和用户当前会话抢显存。
 * 另外 asr.conf 里 autostart:false 可单独关自动启动（只保留手动/按需拉起）。 */
const ASR_AUTOSTART = !/^(0|false|no)$/i.test(String(process.env.ORB_ASR_AUTOSTART ?? "").trim());
const ASR_PORT = Number(process.env.ORB_ASR_PORT || 19876);
const ASR_BASE = `http://127.0.0.1:${ASR_PORT}`;

function readAsrConf() {
  try { return JSON.parse(fsSync.readFileSync(ASR_CONF, "utf8")) || {}; } catch { return {}; }
}
function writeAsrConf(patch) {
  const next = { ...readAsrConf(), ...patch };
  try { writeJsonAtomic(ASR_CONF, next); } catch (e) { log("[asr] 写配置失败:", e.message); }
  return next;
}
async function asrHealth(timeoutMs = 2500) {
  try {
    const r = await fetch(ASR_BASE + "/health", { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
let asrProc = null;
/** spawn 的失败是异步的（'error' 事件），必须有监听者，否则整个 bridge 被带走。 */
let asrSpawnErr = "";
/** 一键安装（prepare.ps1）的进行态：{running, proc, lines, step, percent, ok, error, startedAt} */
let asrPrepare = null;
function asrSpawn() {
  // 已有实例在跑就别再起一个：新引用会把旧的顶掉，那个进程从此再没人管
  if (asrProc && asrProc.exitCode === null) return;
  const conf = readAsrConf();
  // device/compute 原样透传：conf 里可以是 auto，由 asr_server 的 resolve_device_compute
  // 按实际硬件定，不可用时回落 cpu/int8 并写回 conf（DESIGN §5.3）
  const dev = String(conf.device || "auto");
  const env = cleanCliEnv({
    ORB_ASR_DEVICE: dev,
    ORB_ASR_COMPUTE: String(conf.compute || "auto"),
    ...(conf.model ? { ORB_ASR_MODEL_NAME: String(conf.model) } : {}),
    // 中文路径 / 中文日志不能变乱码；不在用户机上写 __pycache__（安装目录可能只读）
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    PYTHONDONTWRITEBYTECODE: "1",
  });
  // 用户自管的 asr/site-packages（可选保底，见 asrPython 注释）
  const extraSite = path.join(ASR_DIR, "site-packages");
  if (fsSync.existsSync(extraSite)) env.PYTHONPATH = extraSite;
  asrSpawnErr = "";
  asrProc = spawn(asrPython(), [ASR_SCRIPT], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: ASR_DIR });
  asrProc.stdout.on("data", (d) => log("[asr]", String(d).trim()));
  asrProc.stderr.on("data", (d) => log("[asr:err]", String(d).trim()));
  asrProc.on("error", (e) => {
    asrSpawnErr = String(e?.message ?? e);
    log("[asr] 启动异常:", asrSpawnErr, "→", asrPython());
    asrProc = null;
  });
  asrProc.on("exit", (c) => { log("[asr] 退出 code =", c); asrProc = null; });
  if (asrProc) registerChild(asrProc.pid, "asr");
}
/* ══════════ ASR 空闲回收 ══════════
 * Whisper 常驻要 ~238MB 内存 + 约 2.1GB 显存（GPU 模式还会让独显一直醒着），
 * 但绝大多数时间没人用。所以：按需加载 + 空闲 N 分钟自动停。
 * 注意只在**当前会话没有正在用的语音功能**时回收（rtProc 在跑就跳过）。
 *
 * 默认 5 分钟（原 10 分钟）：实测闲置 10 分钟太久，那 2.1GB 显存和白占的 238MB
 * 内存会一直压着。5 分钟的代价是"隔几分钟就说一句"时会反复启停——每次要重新
 * 加载模型，有几秒到几十秒的等待。嫌烦就用 ORB_ASR_IDLE_MS 调大（毫秒），
 * 设成很大的值等于关闭自动回收。 */
const ASR_IDLE_MS = Number(process.env.ORB_ASR_IDLE_MS || 5 * 60 * 1000);
let asrLastUse = 0;
let asrReaper = null;

function asrTouch() { asrLastUse = Date.now(); }

function startAsrIdleReaper() {
  if (asrReaper) return;
  asrReaper = setInterval(async () => {
    if (!asrLastUse) return;
    if (Date.now() - asrLastUse < ASR_IDLE_MS) return;
    if (rtProc) return;                       // 实时字幕还在跑，别停
    // 不是自己拉起的就别停：很可能是另一个控制台实例正在用的，
    // asrStop() 会按端口找 PID 强杀，一杀就把别人那份也带走了。
    if (!asrProc) { asrLastUse = 0; return; }
    log(`[asr] 空闲超过 ${Math.round(ASR_IDLE_MS / 60000)} 分钟，停掉释放内存/显存`);
    asrLastUse = 0;
    try { await asrStop(); } catch (e) { log("[asr] 空闲回收失败:", e?.message ?? e); }
  }, 60000);
  asrReaper.unref?.();     // 别因为这个定时器把进程吊住不退出
}

async function asrEnsure(timeoutMs = 90000) {
  asrTouch();
  if (await asrHealth()) return true;
  try { asrSpawn(); } catch (e) { log("[asr] 启动失败:", e?.message ?? e); return false; }
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    await sleep(1000);
    // 解释器/脚本压根不在（asr\venv 没建）时立刻放弃，
    // 否则每次「切换识别设备」都要干等 90 秒才报错。
    if (asrSpawnErr) { asrSpawnErr = ""; return false; }
    if (await asrHealth()) return true;
  }
  return false;
}
async function asrStop() {
  if (asrProc) {
    try { asrProc.kill(); } catch { /* ignore */ }
    asrProc = null;
  } else {
    // 不是本进程拉起的（例如启动器先起的）：按端口找 PID 杀掉
    try {
      const out = await new Promise((res) => execFile("netstat", ["-ano"], (e, so) => res(e ? "" : so)));
      const line = String(out).split("\n").find((l) => l.includes(":" + ASR_PORT) && l.includes("LISTENING"));
      const pid = line && line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) await new Promise((res) => execFile("taskkill", ["/PID", pid, "/F"], () => res()));
    } catch { /* ignore */ }
  }
  for (let i = 0; i < 25; i++) {
    if (!(await asrHealth(600))) return;
    await sleep(300);
  }
}

/* ---------- 实时字幕服务（回环采集 -> 实时上屏）---------- */

const RT_SCRIPT = path.join(ASR_DIR, "subtitle_rt.py");
const RT_PORT = Number(process.env.ORB_RT_PORT || 19879);

async function rtHealth(timeoutMs = 2000) {
  try {
    const r = await fetch(`http://127.0.0.1:${RT_PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
let rtProc = null;
let rtSpawnErr = "";
function rtStart() {
  // 只判 rtProc 非空不够：进程已经退出但事件还没到时 rtProc 仍是旧对象，
  // 这里会被"以为还在跑"挡住，字幕就再也起不来。按 exitCode 判活。
  if (rtProc && rtProc.exitCode === null) return;
  rtSpawnErr = "";
  rtProc = spawn(asrPython(), [RT_SCRIPT], {
    env: cleanCliEnv({
      ORB_ASR_ENDPOINT: "http://127.0.0.1:19876/v1/audio/transcriptions",
      /* 字幕落盘目录：跟会话历史/自动化一样进 DATA_DIR（开发态是项目根，
         打包态由 main.js 用 ORB_DATA_DIR 传 %APPDATA%\ORB 控制台 下来）。
         ⚠️ subtitle_rt.py 里原来写死了开发机的私有路径 ——
         那是开发机的私有路径，开源后必须去掉；留 ORB_RT_SRT_DIR 环境变量作覆盖口。 */
      ORB_RT_SRT_DIR: process.env.ORB_RT_SRT_DIR || path.join(DATA_DIR, ".cache", "实时字幕"),
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONDONTWRITEBYTECODE: "1",
    }),
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: ASR_DIR,
  });
  rtProc.stdout.on("data", (d) => log("[rt]", String(d).trim()));
  rtProc.stderr.on("data", (d) => log("[rt:err]", String(d).trim()));
  rtProc.on("error", (e) => {
    rtSpawnErr = String(e?.message ?? e);
    log("[rt] 启动异常:", rtSpawnErr, "→", asrPython());
    rtProc = null;
  });
  rtProc.on("exit", (c) => { log("[rt] 退出 code =", c); rtProc = null; });
  if (rtProc) registerChild(rtProc.pid, "rt");
}
async function rtStop() {
  if (rtProc) {
    try { rtProc.kill(); } catch { /* ignore */ }
    rtProc = null;
  } else {
    try {
      const out = await new Promise((res) => execFile("netstat", ["-ano"], (e, so) => res(e ? "" : so)));
      const line = String(out).split("\n").find((l) => l.includes(":" + RT_PORT) && l.includes("LISTENING"));
      const pid = line && line.trim().split(/\s+/).pop();
      if (pid && /^\d+$/.test(pid)) await new Promise((res) => execFile("taskkill", ["/PID", pid, "/F"], () => res()));
    } catch { /* ignore */ }
  }
  for (let i = 0; i < 15; i++) {
    if (!(await rtHealth(500))) return;
    await sleep(300);
  }
}
function rtOpenBrowser() {
  try {
    execFile("cmd", ["/c", "start", "", `http://127.0.0.1:${RT_PORT}`], { windowsHide: true }, () => {});
  } catch { /* ignore */ }
}

/* ══════════ 积分 / 额度 ══════════
   WorkBuddy 把每条消息的真实积分消耗写进 ~/.workbuddy/workbuddy.db 的
   session_usage.credit_json（{ 消息ID: 积分 }）。

   ★ 关键取舍：不能"取最新那个会话"就完事 —— 那样显示的是用户正在交谈的那个
     WorkBuddy 对话的消耗，而不是 ORB 控制台自己花掉的。
     所以这里做「归因」：只有 ORB 派发出去的后台任务（CLI 一次性执行，每次新建会话）
     才计入。做法是在 spawnOnce 前后各快照一次 session 表：
       · 派发期间**新出现**的会话 → 认定是这次任务建的，整段计入；
       · 之前就存在的会话（比如用户正在用的 WorkBuddy 对话）→ 一律不计，
         哪怕它在增长也不算，避免把别人的账算到 ORB 头上。
     之后每次 /api/credits 只补记"已认领会话"的新增，不再认领新会话。
   只读、不写、不联网。 */
// ORB_WB_DB 只用于离线单测（指向一份造出来的库），正常运行时不设。
const WB_DB = process.env.ORB_WB_DB || (() => {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return home ? path.join(home, ".workbuddy", "workbuddy.db") : "";
})();
// ORB_CREDITS_FILE 同样只给单测用（避免单测把真实累计值写脏）
const CREDITS_FILE = process.env.ORB_CREDITS_FILE || path.join(DATA_DIR, "credits.json");
const CREDITS_FILE_OLD = path.join(HERE, "credits.json");

/** 本次 ORB 运行期间，控制台自己花掉的积分（进程重启即归零，符合"这次"的语义）。 */
const orbCredits = { total: 0, tasks: 0, last: 0, running: 0, since: Date.now() };
/** 已被认定属于 ORB 的会话 id；只有它们的后续增长才会继续计入。 */
const orbSessions = new Set();
/** 累计（跨 ORB 重启，落盘到 credits.json）。 */
let creditsAllTime = 0;
try {
  for (const f of [CREDITS_FILE, CREDITS_FILE_OLD]) {
    try {
      const v = Number(JSON.parse(fsSync.readFileSync(f, "utf8")).allTime) || 0;
      if (v) { creditsAllTime = v; break; }   // 累计值不可逆，旧位置有就接着用
    } catch { /* 这一份没有/坏了 */ }
  }
} catch { /* 首次运行没有文件 */ }
let creditsBase = null;   // 上一次快照：session_id -> 累计积分

function saveCreditsAllTime() {
  try { writeJsonAtomic(CREDITS_FILE, { allTime: Math.round(creditsAllTime * 100) / 100, updatedAt: Date.now() }, 1); } catch { /* ignore */ }
}

/** 快照：读一次 session_usage，返回 Map<sessionId, 该会话累计积分>。 */
async function snapCredits() {
  const m = new Map();
  if (!WB_DB || !fsSync.existsSync(WB_DB)) return m;
  let db = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(WB_DB, { readOnly: true });
    for (const r of db.prepare("select session_id, credit_json from session_usage").all()) {
      let v = 0;
      try {
        const o = JSON.parse(r.credit_json || "{}") || {};
        for (const k of Object.keys(o)) if (typeof o[k] === "number") v += o[k];
      } catch { /* ignore */ }
      m.set(String(r.session_id), v);
    }
  } catch { /* 库被锁/不存在就当空快照，绝不影响主流程 */ }
  finally { try { db?.close(); } catch { /* ignore */ } }
  return m;
}

/** 用最新快照推进账本。allowNew=true 时才认领新会话（只在派发任务期间开）。 */
async function pumpCredits(allowNew, before) {
  const now = await snapCredits();
  if (!now.size) { creditsBase = now; return 0; }
  const prev = before || creditsBase;
  let add = 0;
  if (prev) {
    for (const [id, v] of now) {
      if (!prev.has(id)) {
        if (allowNew) { orbSessions.add(id); add += v; }     // 派发期间冒出来的 → 这次任务建的
      } else if (orbSessions.has(id)) {
        const d = v - prev.get(id);
        if (d > 0) add += d;                                  // 已认领会话继续跑，继续计
      }
    }
  } else if (allowNew) {
    // 首次快照：不认领任何东西（否则一上来就会把用户正在聊的会话算进来）
  }
  creditsBase = now;
  if (add > 0) {
    orbCredits.total = Math.round((orbCredits.total + add) * 100) / 100;
    creditsAllTime = Math.round((creditsAllTime + add) * 100) / 100;
    saveCreditsAllTime();
  }
  return add;
}

/** 给 spawnOnce 包一层"电表"：只把派发期间新建的会话算到 ORB 头上。 */
async function metered(fn) {
  const before = await snapCredits();
  orbCredits.running++;
  try { return await fn(); }
  finally {
    orbCredits.running--;
    // CLI 退出后记账可能还有几十毫秒才落盘，等一会儿再结算
    await new Promise((r) => setTimeout(r, 400));
    const add = await pumpCredits(true, before);
    orbCredits.tasks++;
    orbCredits.last = Math.round(add * 100) / 100;
    log("[credits] 本次派发计入", orbCredits.last, "累计", orbCredits.total);
  }
}

async function readCredits() {
  await pumpCredits(false, null);          // 补记已认领会话的增长
  const data = {
    ok: true,
    scope: "orb",                          // 只统计控制台自己派发的任务
    credits: orbCredits.total,
    tasks: orbCredits.tasks,
    last: orbCredits.last,
    running: orbCredits.running,
    allTime: Math.round(creditsAllTime * 100) / 100,
    since: orbCredits.since,
    sessions: orbSessions.size,
    model: WB_MODEL || "",
    db: !!creditsBase,
    /* 本次运行的任务用量明细（最近 20 条），任务与人格台词分开给，
       面板据此显示「这个任务一共花了多少」—— 两笔都算在同一个任务头上。 */
    tokRecent: TOK.history,
    tokCurrent: tokSnapshot(),
  };
  return data;
}

// /api/status 与 /api/events(SSE) 共用的快照构造：原样提取，返回字段形状不变，
// 面板现有的 applyChannels/applyLive/renderStop/applyPending 消费方无需改动。
async function buildStatusSnapshot() {
  // 后台 CLI 检测：结果缓存 30s（resolveWbCli），所以 5 秒一次的轮询不会反复 spawn where。
  const cliNow = await resolveWbCli();
  const out = {
    orb: { ok: true, label: "orb-native", tools: ORB_TOOL_LIST },
  };
  for (const key of Object.keys(SERVERS)) {
    const def = SERVERS[key];
    if (def.kind === "cli") {
      out[key] = {
        // CLI 没找到就置灰（ok:false）：面板据此把后台灯画成灰，并给出安装提示
        ok: !!cliNow.found,
        label: def.label,
        tools: WORKBUDDY_TOOL_LIST,
        cli: cliStatusPayload(cliNow),
      };
      continue;
    }
    // lazy 的服务不在这里预热：面板根本不显示它，拉起来只是白占内存（见 SERVERS.dsh 注释）
    if (def.lazy && !sessions.has(key)) {
      out[key] = { ok: true, label: def.label, tools: [], lazy: true };
      continue;
    }
    // 连接失败后退避：这个接口每 5 秒被轮询一次，坏掉的 server 会变成
    // "每 5 秒重连一次、每次都超时"，白烧 CPU 还拖慢整个 status 响应。
    if (sessionBackoff.has(key)) {
      const left = sessionBackoff.get(key) - Date.now();
      if (left > 0) {
        out[key] = { ok: false, label: def.label, error: "连接失败，稍后重试", retryInMs: left };
        continue;
      }
      sessionBackoff.delete(key);
    }
    try {
      const s = await getSession(key);
      out[key] = { ok: true, label: def.label, tools: s.tools.map((t) => t.name) };
      sessionBackoff.delete(key);
    } catch (err) {
      sessionBackoff.set(key, Date.now() + SESSION_BACKOFF_MS);
      out[key] = { ok: false, label: def.label, error: String(err?.message ?? err) };
    }
  }
  // 顺带带上面板轮询需要的三样，把原来的 3 个轮询（live/confirm/stop）合并成这一次请求
  out.ok = true;
  /* tok 是「本次任务的合计用量」，含人格台词那一笔 —— 面板拿它画状态条。
     复制一份再挂，别把 LIVE 本身改成另一种形状：LIVE 还被审计/接管逻辑读写。 */
  out.live = Object.assign({}, LIVE, { tok: tokSnapshot() });
  out.stop = { on: STOP.on, reason: STOP.reason, at: STOP.at, epoch: STOP.epoch };
  /* 阶段一：把新能力的健康摘要挂到原有状态接口，便于一条命令验收。 */
  out.gov = {
    epoch: STOP.epoch, stopped: STOP.on,
    commandGate: commandGate.stats(), logBus: logBus.stats(),
    artifacts: artifactStore.stats(), session: sessionMgr.stats(),
    observe: observeRouter.stats(), baseline: baseline.coverage(),
    launched: launchedProcs.size, writers: STATE_WRITERS.length,
    layout: { root: layout.root(), day: layout.day(), dayDir: layout.dayDir(),
              artifactsRoot: layout.artifactsRoot(), logsRoot: layout.logsRoot(),
              govRoot: layout.govRoot(), logsDir: layout.logsDir(),
              productKinds: layout.describe().productKinds, days: layout.listDays().length },
    logForward: logForwardEnabled,
  };
  /* 专家团 / 门控 / 插件 / 语义路由四项摘要：全部是内存里的计数器，零 IO、零子进程，
     挂在每 1.5s 一次的推送里没有成本。
     ⚠️ 机器遥测**故意不在这里**：telemetry.snapshot() 要 spawn wmic/tasklist 这类命令，
     放进状态流就是每 1.5 秒开一次子进程。它只在 /api/ops telemetry.snapshot 里按需算。 */
  try {
    out.gov.team = team.stats();
    out.gov.affect = affectGate.stats();
    out.gov.plugin = pluginHost.stats();
    out.gov.router = semanticRouter.stats();
    out.gov.expertTeam = expertTeam.stats();
  } catch { /* 任一模块没起来不影响 status 本体 */ }
  /* 急停豁免清单：**只放计数和键名，不放 effect 文案**。
   * 面板要解释"为什么急停了这个按钮还能点"时走 /api/capabilities 拿整表，
   * 状态流每 1.5s 推一遍长文案是白烧带宽。这里放个总数是为了让"名单突然变长"
   * 这件事在面板上可见 —— 白名单无声无息多一项，正是这里最该报警的变更。 */
  try {
    out.gov.capabilities = { count: STOP_EXEMPT.size, keys: [...STOP_EXEMPT] };
  } catch { out.gov.capabilities = { count: 0, keys: [] } }
  /* 专家契约摘要：source=default 说明用户的覆盖文件没读到/没读懂，
   * 这是"我明明配了为什么不生效"的第一现场，必须一眼可见。 */
  try { out.gov.expertBook = expertBook.stats(); } catch {}
  /* 换档统计：up/down + 被拒/过期次数。
   * rejected 不为零说明有代码在发起非法转移（多半是档位名拼错），
   * stale 不为零说明急停之后还有迟到的回调 —— 两个都该为 0。 */
  try { out.gov.upgrade = upgrade.stats(); } catch {}
  /* 语气槽：不只推统计，把当前档位与"为什么在这个档"一起推给面板 ——
   * 面板据此调语速音高，也据此在设置页显示原因。 */
  try { out.gov.personaSlot = personaSlots.stats(); } catch {}
  /* 治理层的四项观测值。面板不需要额外轮询 —— 全都搭在这条已经每 1.5s 推送一次的
   * 状态流上。只放"能一眼看出异常"的量，明细走 /api/tickets、/api/cost。 */
  try { out.tickets = ticketStore.summary(); } catch { out.tickets = null; }
  /* 注意别把 summary.open（数字）覆盖成数组：一度这么写，status 里 open 从计数
   * 变成列表，面板的"在跑几个"直接算不出来。明细单独挂一个键。 */
  try { out.ticketList = ticketStore.list({ open: true, limit: 20 }); } catch { out.ticketList = []; }
  try { out.guiLock = guiLock.status(); } catch { out.guiLock = null; }
  try { out.outbox = outbox.stats(); } catch { out.outbox = null; }
  try {
    const t = costLedger.totals();
    out.cost = { calls: t.calls, tokens: t.totalTokens, usd: t.costUSD, estimatedCalls: t.estimatedCalls, allEstimated: t.allEstimated };
  } catch { out.cost = null; }
  out.notices = NOTICES.slice(-8);
  try { out.expertCount = dispatcher.list().length; } catch { out.expertCount = 0; }
  try { out.pool = { ...pool.status(), enabled: poolEnabled }; } catch { out.pool = null; }
  try { out.watchdog = watchdog.status(); } catch { out.watchdog = null; }
  try { out.trail = trajectory.stats(); } catch { out.trail = null; }
  out.pending = listPending();
  out.dangerous = [...DANGER_TOOLS];
  out.dangerRules = { tools: [...DANGER.tools], args: DANGER.args };
  // 前台通道健康度：面板据此显示「一键修复」按钮（windows 挂了才有意义）
  out.frontHealth = frontHealth();
  // 后台 CLI 状态（与 out.workbuddy.cli 同源，面板读这一份即可，不必再发一次请求）
  out.cli = cliStatusPayload(cliNow);
  // 本地识别摘要：只做文件系统检查、不探测端口（这个接口 5 秒轮询一次，别添延迟）；
  // 运行中与否 / 生效设备走 /api/asr。
  out.asr = { installed: asrInstalled(), modelDownloaded: asrModelDownloaded(), running: !!asrProc };
  return out;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // 鉴权：预检请求（OPTIONS）不带自定义头，必须放行且不泄露任何信息；
  // 其余 /api/* 一律要令牌。SSE 用 EventSource 不能带自定义头，
  // 令牌改走 ?token= 查询参数（与请求头二选一即可，不放松校验）。
  if (url.pathname.startsWith("/api/") && !PUBLIC_PATHS.has(url.pathname)) {
    const hdrTok = req.headers["x-orb-token"];
    const qTok = url.searchParams && url.searchParams.get("token");
    if (hdrTok !== TOKEN && qTok !== TOKEN) {
      send(res, 401, { ok: false, error: "缺少或错误的 X-Orb-Token" });
      return;
    }
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const html = await fs.readFile(path.join(HERE, "orb.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, { ok: true, uptime: process.uptime(), jobs: jobs.size });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    send(res, 200, await buildStatusSnapshot());
    return;
  }

  // SSE：全局状态（通道/活动/急停/待确认）实时推送，替代面板 1.2s/10s 轮询。
  // 回退：面板 EventSource 出错会退回原 pollStatus 轮询，本改动纯增量、零退化。
  if (req.method === "GET" && url.pathname === "/api/events") {
    sseHead(res);
    try {
      const snap = await buildStatusSnapshot();
      sseSend(res, snap);
      /* 首帧也记进去重缓存：否则紧接着的 1.5s 定时器会认为「状态变了」，
         给**所有**订阅者再推一遍一模一样的内容（每来一个新连接就多一次全量帧）。 */
      lastStatusJson = JSON.stringify(snap);
    } catch { sseSend(res, { ok: false }); }  // 构造失败也给一帧避免空等
    subscribeStatus(res);
    const ka = setInterval(() => {
      if (res.writableEnded) return;
      try { res.write(": keep-alive\n\n"); } catch {}
    }, 15000);
    res.on("close", () => clearInterval(ka));
    return;
  }

  /* ── 后台 CLI（CodeBuddy Code）检测状态 ──
   * GET  /api/wb-cli            —— 读缓存（30s）
   * GET  /api/wb-cli?refresh=1  —— 强制重查
   * POST /api/wb-cli            —— 强制重查（等价于 refresh=1）
   * 用途：用户装完 CLI 后在设置里点「重新检测」，**无需重启 ORB** 就能让后台通道变绿。 */
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/wb-cli") {
    const refresh = req.method === "POST" || url.searchParams.get("refresh") === "1";
    send(res, 200, { ok: true, cli: cliStatusPayload(await resolveWbCli(refresh)) });
    return;
  }

  /* ── 积分/额度：直接读 WorkBuddy 本地库 ~/.workbuddy/workbuddy.db（只读，拿不到就降级）
     数据来源是 WorkBuddy 自己写的 session_usage.credit_json（每条消息的真实积分消耗）。 */
  if (req.method === "GET" && url.pathname === "/api/credits") {
    send(res, 200, await readCredits());
    return;
  }

  /* 后台可选模型清单（面板下拉用）。默认走 CLI --help 实时解析（缓存 5 分钟）；
     ?refresh=1 强制重拉（面板「更新」钮）。CLI 不可用才回落内置静态表。 */
  if (req.method === "GET" && url.pathname === "/api/wb-models") {
    const force = url.searchParams.get("refresh") === "1";
    wbModelsPayload(force)
      .then((p) => send(res, 200, p))
      .catch(() => send(res, 200, { models: WB_MODEL_LIST, source: "static", at: Date.now() }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/tools") {
    const key = url.searchParams.get("server");
    // orb 原生轨道不是 MCP session，直接回本地工具表（与 /api/status 保持一致，避免 unknown server: orb）
    if (key === "orb") {
      send(res, 200, { tools: ORB_TOOL_LIST.map((name) => ({ name, description: "" })) });
      return;
    }
    if (SERVERS[key]?.kind === "cli") {
      send(res, 200, { tools: WORKBUDDY_TOOL_LIST.map((name) => ({ name, description: "" })) });
      return;
    }
    const s = await getSession(key);
    send(res, 200, { tools: s.tools });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/call") {
    const body = await readBody(req);
    const ck = body.server + "|" + body.tool;
    /* isRead 只决定"能不能走读缓存"，语义与原来完全一致 ——
     * 别把它和能力清单的只读合成一个：截图/取词在清单里是只读，
     * 但缓存它们会给用户看到上一帧的画面。仲裁另用一个更宽的判据。 */
    const isRead = READ_ONLY_TOOLS.has(ck);
    const readForArb = isRead || isReadOnly(body.server, body.tool);
    /* 专家契约仲裁（2026-11-05）：带 expertId 的调用必须服从该专家的 actionScope。
     * 这是"只读专家"唯一真正靠得住的地方 —— 靠自觉的只读等于没有只读：
     * 一个自己动手改过的评审视角，说"没问题"是没意义的。
     * 拒的时候回 403 + 固定 code，日志里能 grep 到原因。 */
    const arb = arbitrateExpert(body.expertId, { server: body.server, tool: body.tool, readOnly: readForArb, nestedDepth: body.nestedDepth });
    if (!arb.ok) {
      send(res, 403, { ok: false, code: arb.reason, error: arb.detail, expertId: String(body.expertId || "") });
      return;
    }
    try {
      if (isRead) {
        const hit = READ_CACHE.get(ck);
        if (hit && Date.now() - hit.t < READ_CACHE_MS) {
          wfCapture(body.server, body.tool, body.args);   // 录制时缓存命中也要记，保持序列完整
          send(res, 200, { ok: true, result: hit.v, cached: true });
          return;
        }
      }
      const result = await callTool(body.server, body.tool, body.args, body.timeoutMs ?? CALL_TIMEOUT_MS);
      if (isRead) READ_CACHE.set(ck, { t: Date.now(), v: result });
      else READ_CACHE.clear();   // 任何写操作后立刻失效，避免读到过期画面
      wfCapture(body.server, body.tool, body.args);
      send(res, 200, { ok: true, result });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* ── 命令通道：写文件 + 用指定程序打开（不碰 GUI 全局态，不占 GUI 令牌）──
   * POST /api/cmd
   *   body: { write?: {filePath, content, encoding},
   *           openWith?: {app, filePath},
   *           launch?: {command, args} }
   * 复用既有 DANGER 规则：danger-tools.json 里加了 "CommandChannel" 或配了
   * DANGER.args.CommandChannel，则启动前走 /api/confirm 确认（与 PowerShell 同机制）。
   * 安全硬边界在 cmdchan.mjs：绝不进 shell、强制 UTF-8、spawn 数组形式。 */
  /* ============ 阶段一：日志唯一写者（主进程 log() 经 POST /api/log 转发） ============ */
  if (url.pathname === "/api/log" && req.method === "POST") {
    const body = await readBody(req);
    /* 「主进程日志接入」关掉时桥侧直接拒收：主进程仍会写 orb.log 与 spool，
       只是不再进入结构化日志流。急停带外写 stopSafe 不经此闸，永远留痕。 */
    if (!logForwardEnabled) {
      send(res, 200, { ok: false, written: 0, rejected: 0, reasons: ["forward-disabled"] });
      return;
    }
    /* 主进程是批量 flush，一次 POST 一批；单条也兼容。 */
    const list = Array.isArray(body?.batch) ? body.batch
      : (Array.isArray(body) ? body : [body || {}]);
    let written = 0;
    const reasons = [];
    for (const rec of list.slice(0, 256)) {
      const r = logBus.write(rec || {});
      if (r.ok) written++;
      else reasons.push(String(r.reason || "rejected"));
    }
    send(res, 200, { ok: written > 0, written, rejected: list.length - written, reasons: reasons.slice(0, 5) });
    return;
  }
  if (url.pathname === "/api/log" && req.method === "GET") {
    send(res, 200, {
      ok: true, categories: CATEGORIES, levels: LEVELS, stats: logBus.stats(),
      rows: logBus.query({
        category: url.searchParams.get("category") || "",
        level: url.searchParams.get("level") || "",
        since: Number(url.searchParams.get("since") || 0),
        limit: Number(url.searchParams.get("limit") || 200),
      }),
    });
    return;
  }

  /* ============ 阶段一：统一导出入口 ============
   * bridge 跑在 ELECTRON_RUN_AS_NODE=1 下，拿不到 Electron API，
   * 所以 pdf 只返回渲染计划（plan.channel = artifact-render-pdf），
   * 由面板转交主进程 printToPDF 落地 —— 落地成功才算真的导出成功。
   *
   * 两种入参形状：
   *   ① body.source  已结构化的源（segments / rows / files / {title,body}），给程序用；
   *   ② body.text    一段纯文本，按 format 自动解释（buildSource），给人用。
   * 两者都给时以 source 为准。 */
  if (url.pathname === "/api/export" && req.method === "POST") {
    const body = await readBody(req);
    const gate = commandGate.check(body);
    if (!gate.ok) { send(res, gate.httpStatus, gate.body); return; }
    try {
      const epoch = Number(body.epoch ?? STOP.epoch);
      const fmt = String(body.format || "md");
      const title = String(body.title || "").trim();

      /* ---- 源解析：纯文本走 buildSource，规则只在 exporter 里有一份 ---- */
      let source = body.source;
      if (source == null || source === "") {
        const text = typeof body.text === "string" ? body.text : "";
        if (!text.trim()) {
          send(res, 200, { ok: false, error: "需要 source 或非空 text", format: fmt, epoch });
          return;
        }
        /* 4MB 上限：再大就不是「导出一段内容」而是「搬一个文件」，走归档更合适。 */
        if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) {
          send(res, 200, { ok: false, error: "内容超过 4MB，请改用 source 直接给结构化数据", format: fmt, epoch });
          return;
        }
        const built = buildSource(text, { format: fmt, title });
        if (!built.ok) {
          send(res, 200, { ok: false, error: built.error, format: fmt, epoch, stage: "build-source" });
          return;
        }
        source = built.source;
      }

      /* 没指定 outPath 时不再平铺在 artifacts 根下，而是落到「当天 / 当前会话 / exports」。 */
      const outPath = String(body.outPath || "").trim() || (() => {
        const c = sessionMgr.current();
        const dir = layout.kindDir("exports", c?.conversationId || "local", layout.day());
        try { fsSync.mkdirSync(dir, { recursive: true }); } catch {}
        return path.join(dir, `export-${Date.now()}.${fmt}`);
      })();
      const r = await exporter.run({ format: fmt, source, outPath, epoch });
      const cur = sessionMgr.current();
      if (r && r.ok && r.path && !r.delegated) {
        registerArtifact({
          conversationId: String(body.conversationId || cur?.conversationId || ""),
          epoch, ticketId: String(body.ticketId || ""), kind: "exports",
          fileName: path.basename(r.path), ext: fmt, size: r.bytes || 0, sha: r.sha || "",
        });
        logBus.write({ category: "artifact", level: "info", epoch,
          message: `导出 ${fmt}：${path.basename(r.path)}（${r.bytes || 0} 字节）` });
      }
      send(res, 200, { ok: !!(r && r.ok), ...r, epoch, profile,
        /* 面板据此判断「还需不需要再走一趟主进程」，不必自己认 delegated 的字符串 */
        needsRenderer: !!r?.pending,
        note: r?.pending ? "PDF 已生成渲染计划，需主进程 printToPDF 落地后才算导出完成" : "" });
    } catch (e) {
      send(res, 200, { ok: false, error: String(e?.message ?? e) });
    }
    return;
  }

  /* ============ 阶段一：产物登记表（栏目 UI 本轮不做，只交付数据层） ============ */
  if (url.pathname === "/api/artifacts" && req.method === "GET") {
    send(res, 200, {
      ok: true, allowedExt: ALLOWED_EXT, stats: artifactStore.stats(),
      rows: artifactStore.list({
        conversationId: url.searchParams.get("conversationId") || "",
        limit: Number(url.searchParams.get("limit") || 200),
      }),
    });
    return;
  }
  if (url.pathname === "/api/artifacts" && req.method === "POST") {
    const b = await readBody(req);
    /* 外部调用方仍可能直接 POST 登记表条目；统一走 registerArtifact 补齐 rel，
       否则浮层里会出现一条永远定位不到的裸文件名记录。 */
    send(res, 200, b && (b.rel || b.fileName) ? registerArtifact({ ...b, fileName: b.rel || b.fileName }) : artifactStore.register(b || {}));
    return;
  }

  /* ============ 看视频产物 → 「内容提要 + 关键截图」MD 合成（修复 I-17 浮层漏登） ========
   * 旧的「做成.md文件交付」走后台 Agent，Agent 缺 AskUserQuestion 工具会整体崩掉，
   * 导致既没 MD 也没浮层卡片。这里用本地可靠路径替代：直接读任务目录里的
   * meta/index/frames，挑关键帧、组装 MD、写进 exports 并登记，前端按钮触发后 artSync 即可见。 */
  if (url.pathname === "/api/synthesize-vidx-md" && req.method === "POST") {
    try {
      const b = await readBody(req);
      const vidKey = String(b.vidKey || "").trim();
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(vidKey)) {
        send(res, 200, { ok: false, error: "vidKey 非法" });
        return;
      }
      const cid = String(b.conversationId || sessionMgr.current()?.conversationId || "local");
      /* 对话框里 LLM 生成的叙事提要只存在于会话记录，从没落盘。前端把它带上来，
         vidxSynth 才会用它当「内容提要」；否则 MD 里那节会退回 index.md 的技术元数据，
         和用户刚在对话框看到的内容完全对不上。这里只作正文，绝不参与任何路径拼接。 */
      const summary = String(b.summary ?? "").slice(0, 20000);
      const syn = synthesizeVidxMd({
        layout, vidKey, cid, summary,
        day: /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || "")) ? String(b.day) : undefined,
        count: Number(b.count) || 12,
      });
      if (!syn.ok) { send(res, 200, syn); return; }
      const reg = registerArtifact({
        conversationId: syn.cid, epoch: epochOf(), ticketId: String(b.ticketId || ""),
        kind: "exports", fileName: `${syn.mdName}.md`, ext: "md", size: syn.size, sha: "",
        day: syn.day,
      });
      send(res, 200, {
        ok: reg.ok, artifactId: reg.ok ? reg.id : null,
        ...syn, note: reg.ok ? "" : (reg.reason || "登记失败"),
      });
    } catch (e) {
      send(res, 200, { ok: false, error: String(e?.message ?? e) });
    }
    return;
  }

  /* ============ I-17 产物浮层：卡片列表（WorkBuddy 风格，跟在对应回答下面） ========
   * 只读、不扫目录：全部条目来自登记表，文件存在与否只做一次 existsSync。
   * since 用来把「这一轮回答之后新产生的产物」挂到那一轮消息下面；面板不自己判状态，
   * 四类失效态一律由 artifactView.statusOf 给出，避免两端算出不同结论。 */
  if (url.pathname === "/api/artifacts/view" && req.method === "GET") {
    const cid = String(url.searchParams.get("conversationId") || currentArtifactCtx().cid);
    const since = Number(url.searchParams.get("since") || 0) || 0;
    const limRaw = Number(url.searchParams.get("limit") || 200);
    const limit = Number.isFinite(limRaw) ? Math.max(0, Math.min(limRaw, 1000)) : 200;
    const all = artifactStore.list({ conversationId: cid, limit: 10000 });
    const byId = new Map(all.map((e) => [e.id, e]));
    const rows = viewRows(all, artifactViewCtx({ since })).map((r) => {
      const e = byId.get(r.id);
      const abs = artifactAbs(e);
      return viewRow(e, artifactViewCtx({ exists: !!(abs && fsSync.existsSync(abs)) }));
    }).slice(-limit);
    send(res, 200, {
      ok: true, conversationId: cid, since, rows,
      revision: artifactStore.stats().rows,
      rootKey: rootKeyOf(layout.root()),
      statuses: STATUSES, statusMeta: STATUS_META,
    });
    return;
  }

  /* 点开卡片才读内容：artifactId 查表 → 安全解析 → 只读前 96KB → 截断到 24000 字。
   * 二进制格式一律不读；客户端传任意路径在这里没有任何入口。 */
  if (url.pathname === "/api/artifacts/item" && req.method === "GET") {
    const id = String(url.searchParams.get("id") || "");
    if (!/^a_[0-9a-f]{20}$/.test(id)) { send(res, 200, { ok: false, error: "artifactId 格式不对" }); return; }
    const entry = artifactStore.list({ limit: 10000 }).find((e) => e.id === id);
    if (!entry) { send(res, 200, { ok: false, error: "产物表里没有这条登记" }); return; }
    const rel = artifactSafeRel(entry);
    const abs = rel ? layout.resolveSafe(rel) : null;
    if (!abs) {
      send(res, 200, { ok: false, error: "路径不安全，拒绝读取", entry: viewRow(entry, artifactViewCtx({ exists: false })) });
      return;
    }
    const exists = fsSync.existsSync(abs);
    const row = viewRow(entry, artifactViewCtx({ exists }));
    if (!exists) { send(res, 200, { ok: false, error: "文件已不存在", entry: row, rel }); return; }
    let preview = null;
    if (isPreviewable(entry.ext)) {
      const CAP = 96 * 1024;
      try {
        const size = fsSync.statSync(abs).size;
        const fd = fsSync.openSync(abs, "r");
        let buf;
        try {
          buf = Buffer.alloc(Math.max(0, Math.min(size, CAP)));
          if (buf.length) fsSync.readSync(fd, buf, 0, buf.length, 0);
        } finally { try { fsSync.closeSync(fd); } catch {} }
        preview = { ...truncatePreview(buf.toString("utf8"), 24000), ext: entry.ext, bytes: size, overBytes: size > CAP };
      } catch (e) {
        preview = { text: "", truncated: false, chars: 0, error: String(e?.message ?? e) };
      }
    }
    send(res, 200, { ok: true, entry: row, rel, preview });
    return;
  }

  /* ============ 专家团模式 = 任务分配（orchestrator-workers）====================
   * 与上面只读复核的 team.* 刻意分开：那里是「验活」，这里是「派活」。
   * 硬约束（参考 Anthropic orchestrator-workers 自动化与 2025-26 生产实践）：
   *   · 用户唯一对话对象是分配者，worker 没有对话入口；
   *   · worker 上下文隔离，只拿自己的 brief + 成功判据，不拿兄弟结果；
   *   · worker 只回传压缩结果，分配者单独汇总，不做字符串拼接；
   *   · 每个 worker 绑一个**真实**后台 jobId，状态从 jobs 表回读，卡片不是摆设。 */
  function syncTeamJobs() {
    const snap = expertTeam.status();
    if (!snap) return null;
    for (const w of snap.workers) {
      if (!w.jobId) continue;
      const job = jobs.get(w.jobId);
      if (!job) continue;
      if (job.status === "running") {
        const p = String(job.partial || "");
        if (p) expertTeam.step(w.id, { title: "执行中", note: p.slice(-80), state: "running" });
        continue;
      }
      if (w.status === "running") {
        const raw = String(job.result || job.error || "");
        /* 只回传压缩结果：不要把整段轨迹灌回分配者上下文。 */
        const compact = raw.length > 800 ? raw.slice(0, 800) + " …（已压缩）" : raw;
        expertTeam.complete(w.id, {
          ok: job.status === "done",
          result: job.status === "done" ? compact : "",
          error: job.status === "done" ? "" : (compact || "后台任务未成功"),
        });
      }
    }
    /* 所有工作者都回传后，分配者必须收口。少了这一步，phase 永远停在 running：
       面板一直轮询、卡片一直"进行中"、用户拿不到答案，整轮等于空跑。
       汇总只吃 aggregate() 产出的压缩结果 / 缺口 / 冲突，不拼完整轨迹；
       也不额外起一次模型调用，免得给首字延迟再叠一跳。 */
    if (snap.phase === "running" || snap.phase === "planning") {
      const allTerminal = snap.workers.length > 0
        && snap.workers.every((w) => w.status === "done" || w.status === "failed");
      if (allTerminal) {
        const agg = expertTeam.aggregate();
        expertTeam.finish(leadDigest(snap, agg));
      }
    }
    return expertTeam.status();
  }

  /* 分配者的最终答复 = 对工作者压缩结果的结构化汇总 + 如实列出缺口和冲突。
     不编造结论、不假装推理过：worker 失败就写失败，结论打架就写要裁定。 */
  function leadDigest(snap, agg) {
    const lines = [`任务：${snap.subject || "未命名任务"}`];
    for (const r of agg?.results || []) {
      const one = String(r.result || "无结果").replace(/\s+/g, " ").slice(0, 300);
      lines.push(`· ${r.name}：${one}`);
    }
    if (agg?.gaps?.length) lines.push(`缺口：${agg.gaps.join("；")}`);
    if (agg?.conflicts?.length) lines.push(`冲突：${agg.conflicts.join("；")}`);
    lines.push("以上是分配者对各方结果的汇总；要调整直接对我说，点名工作者即可。");
    return lines.join("\n");
  }

  if (url.pathname === "/api/team/mode" && req.method === "POST") {
    const b = await readBody(req);
    if (STOP.on && b.on === true) {
      send(res, 409, { ok: false, error: "急停期间不开启专家团模式" });
      return;
    }
    const r = expertTeam.enable(b.on === true);
    /* 关掉开关就得真停：否则 worker 的后台 job 还在跑，面板却不显示，
       变成「关了但还在烧钱」的隐形任务。只停本轮专家团派出去的那些单。 */
    let aborted = 0;
    if (b.on !== true) {
      const snap = expertTeam.status();
      for (const w of snap?.workers || []) {
        if (!w.jobId) continue;
        const job = jobs.get(w.jobId);
        if (job && job.status === "running" && abortJob(w.jobId, "专家团模式已关闭").ok !== false) aborted++;
      }
    }
    send(res, 200, { ok: true, enabled: r.enabled, aborted, stats: expertTeam.stats() });
    return;
  }

  if (url.pathname === "/api/team/status" && req.method === "GET") {
    const run = syncTeamJobs();
    /* 工单只读投影：面板已没有独立「工单」子菜单，本轮各工作者的工单信息改为
       跟在分配者那条回答下面的折叠卡片。随这次状态轮询一并返回，不新增轮询；
       只带摘要字段，成本 / 轨迹 / 插手记录等点开卡片时再按 id 单取下钻，
       否则 2s 一次的轮询会平白读四份内存账本。 */
    const tickets = ((run && run.workers) || []).map((w) => {
      const job = w.jobId ? jobs.get(w.jobId) : null;
      const tid = job && job.ticketId ? String(job.ticketId) : "";
      const t = tid ? ticketStore.get(tid) : null;
      return {
        workerId: w.id,
        name: w.name,
        brief: w.brief,
        workerStatus: w.status,
        jobId: w.jobId || "",
        ticketId: tid,
        status: t ? t.status : "",
        title: t ? t.title : "",
        createdAt: t ? t.createdAt : 0,
        endedAt: t ? t.endedAt : 0,
        route: job ? job.route : "",
        ruleId: job ? job.ruleId : "",
      };
    });
    send(res, 200, {
      ok: true, enabled: expertTeam.enabled(),
      lead: { id: TEAM_LEAD.id, name: TEAM_LEAD.name, role: TEAM_LEAD.role },
      run, tickets, stats: expertTeam.stats(),
    });
    return;
  }

  if (url.pathname === "/api/team/start" && req.method === "POST") {
    const b = await readBody(req);
    const r = expertTeam.start({ text: b.text || b.subject || "" });
    if (!r.ok) { send(res, 200, r); return; }
    let dispatched = 0;
    for (const w of r.plan.workers) {
      try {
        const jid = startJob("workbuddy", "workbuddy_execute", {
          task: `【子任务 · ${w.name}】${w.brief}\n成功判据：${w.criterion}`,
        }, JOB_TIMEOUT_MS, null, { route: "expert-team", ruleId: w.roleId });
        expertTeam.attachJob(w.id, jid);
        dispatched++;
      } catch (e) {
        /* 派不出去就如实标失败，绝不假装在跑。 */
        expertTeam.step(w.id, { title: "派发失败", note: String(e?.message ?? e), state: "failed" });
        expertTeam.complete(w.id, { ok: false, error: "子任务没能派出去" });
      }
    }
    send(res, 200, {
      ok: true, run: expertTeam.status(), dispatched,
      lead: { id: TEAM_LEAD.id, name: TEAM_LEAD.name },
    });
    return;
  }

  /* 用户开口的唯一入口：话只交给分配者。分配者决定自己调整计划，还是转一条
     结构化指令给某个 worker；worker 永远收不到「和用户的一段对话」。 */
  if (url.pathname === "/api/team/steer" && req.method === "POST") {
    const b = await readBody(req);
    const r = expertTeam.steer({ text: b.text || "", workerId: b.workerId || "" });
    if (!r.ok) { send(res, 200, r); return; }
    let injected = false;
    if (r.workerId) {
      const snap = expertTeam.status();
      const w = (snap?.workers || []).find((x) => x.id === r.workerId);
      const job = w && w.jobId ? jobs.get(w.jobId) : null;
      if (job && job.ticketId) {
        /* 真生效：把纠偏写进该工单，执行层在 step 边界会注入。 */
        try { injected = !!(ticketCtl.control(job.ticketId, "correct", { text: String(b.text || "") }) || {}).ok; }
        catch { injected = false; }
      }
    }
    send(res, 200, { ok: true, targets: r.targets, workerId: r.workerId, leadNoted: r.leadNoted, injected, run: expertTeam.status() });
    return;
  }

  if (url.pathname === "/api/team/worker" && req.method === "GET") {
    send(res, 200, expertTeam.workerDetail(url.searchParams.get("id") || ""));
    return;
  }

  if (url.pathname === "/api/team/stop" && req.method === "POST") {
    send(res, 200, { ok: true, ...expertTeam.stop(), run: expertTeam.status() });
    return;
  }

  /* 分配者汇总：不拼接全文，如实列出缺口与冲突，最终答案由分配者继续生成。 */
  if (url.pathname === "/api/team/aggregate" && req.method === "POST") {
    send(res, 200, expertTeam.aggregate());
    return;
  }

  /* ---------------- 外部检索（只读、降级、绝不回落视觉） ----------------
   * 凭证只在模块初始化时从环境变量注入，这里绝不接收任何 apiKey / 开关。
   * 业务失败一律 200 + degraded/reasonCode，绝不 5xx、绝不静默吞掉、绝不调用 runVision。 */
  if (url.pathname === "/api/search" && req.method === "POST") {
    const b = await readBody(req);
    /* 报告B V-10：带 url 的定向检索必须落在显式授权白名单内，否则不擅自访问外部域名。
       白名单只从 ORB_SEARCH_HOSTS 注入，默认空 = 一律 requires_user_authorization。
       只带 query 的普通检索不涉及域名，无需这一步。 */
    if (typeof b.url === "string" && b.url.trim()) {
      const auth = authorizeDomain(b.url, SEARCH_ALLOWED_HOSTS);
      if (!auth.ok) {
        /* V-10 授权失败也走 L4：业务失败一律 200 + degraded + 固定 reasonCode。 */
        send(res, 200, normalizeL4({
          ok: false, results: [], degraded: true,
          reasonCode: "requires_user_authorization", detail: auth.why || "", elapsedMs: 0,
        }));
        return;
      }
    }
    const query = typeof b.query === "string" ? b.query.trim() : "";
    if (query.length < 1 || query.length > 128) {
      /* 业务失败不回 4xx：L4 契约要求统一 200 + degraded + reasonCode，
         调用方只看返回体就能判定，不必再分叉处理 HTTP 状态。 */
      send(res, 200, normalizeL4({ ok: false, results: [], degraded: true, reasonCode: "bad-query", elapsedMs: 0 }));
      return;
    }
    if (STOP.on) {
      send(res, 200, normalizeL4({ ok: false, results: [], degraded: true, reasonCode: "stopped", elapsedMs: 0 }));
      return;
    }
    const ctx = { epoch: epochOf() };
    const r = await searchProvider.search(query, ctx);
    /* provider 内部是 schema v1（含细粒度拒因），对外统一规范化成 L4 v2：
       默认关闭 / 无凭据 → not_available；绝不回落截图或视觉循环。 */
    send(res, 200, normalizeL4(r));
    return;
  }

  /* L4 契约自检：只读字段清单与原因码，不暴露配置、端点或凭据。 */
  if (url.pathname === "/api/search/schema" && req.method === "GET") {
    send(res, 200, { ok: true, ...l4Schema() });
    return;
  }

  if (url.pathname === "/api/search/status" && req.method === "GET") {
    send(res, 200, {
      ok: true,
      config: searchProvider.config(),
      stats: searchProvider.stats(),
      /* 批次C：凭据来源可插拔且默认 inert；这两个布尔是可证伪的判据。 */
      credentials: searchCredentials.describe(),
      acceptedCredentialSources: [...CREDENTIAL_SOURCES],
      /* 厂商形状可查，但绝不回显 key；verified 如实标注「官方文档已核对 ≠ 真实调用已实测」。 */
      provider: searchAdapter.id,
      availableProviders: [...ADAPTER_IDS],
      adapters: listAdapters(),
      orchestrator: orchestratorSchema(),
      offlineFixtureEnabled: SEARCH_OFFLINE_FIXTURE,
    });
    return;
  }

  /* 编排层只读自检：句型数 / 降级码 / 零视觉契约，不暴露配置或凭据。 */
  if (url.pathname === "/api/search/to-doc/schema" && req.method === "GET") {
    send(res, 200, { ok: true, ...orchestratorSchema() });
    return;
  }

  /* ---------------- 意图未命中只读视图（2026-11-07） ----------------
   * 「该往词表里加什么」应该是查出来的，不是猜出来的：这里把没认出来的原句按同形聚合列出。
   * 纯内存、有上限、不落盘、不外发；POST {clear:true} 只清本进程这一份。
   */
  if (url.pathname === "/api/search/misses" && (req.method === "GET" || req.method === "POST")) {
    if (req.method === "POST") {
      const b = await readBody(req);
      if (b && b.clear === true) missLog.clear();
    }
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
    send(res, 200, { ok: true, ...missLog.stats(), items: missLog.list({ limit }) });
    return;
  }

  /* ---------------- 意图只解析、不执行（2026-11-06） ----------------
   * 面板拿到一句话后先问这里：走哪条动作、落到哪（doc / clipboard）、要几条。
   * 分流的依据只有这一份（parseProduceIntent），面板不再复刻第二套判定 ——
   * 复刻过的东西早晚漂移，历史上 RE_SEARCH 与 INTENT_PATTERNS 就是两份。
   * 纯解析：不发请求、不写盘、不动剪贴板，未命中就如实回 reasonCode。
   */
  if (url.pathname === "/api/search/plan" && (req.method === "POST" || req.method === "GET")) {
    const b = req.method === "POST" ? await readBody(req) : {};
    const text = req.method === "GET"
      ? String(url.searchParams.get("text") || "")
      : String(b.text || "");
    const r = await parseForSink(text, null);
    /* 未命中才记，且只记「像这类任务」的句子：普通闲聊也含「找」「生成」这类单字，
       不设这道闸，日志三天就会被聊天噪声淹没，等于没记。 */
    if (!r.ok) recordIntentMiss(text, r.reasonCode);
    send(res, 200, {
      ok: r.ok === true,
      reasonCode: r.reasonCode || "",
      action: r.action || "",
      sink: r.sink || "",
      format: r.format || "",
      query: r.query || "",
      count: r.count || 0,
      note: r.note || "",
      /* 低置信：不改变执行，只把「按哪个理解做的」交出去，面板可以补一句说明。 */
      confidence: r.confidence || "high",
      clarify: r.clarify || null,
      via: r.via || "grammar",
      zeroVlm: true, vlmCalls: 0, noVisionFallback: true,
    });
    return;
  }

  /* ---------------- 批次C：结果回填编排（搜一下 X 然后记到文档） ----------------
   * 报告 §7 第10项：只做 /api/search 而没人消费 results[] 就是空头功能。
   * 这里把 L4 结果真正落成一份产物并登记；能力不可用时如实降级，
   * 绝不编造三条、绝不回落视觉循环、不播报、不调用 /api/vlm、不抓屏。
   * 离线 fixture 只用于验收编排层，文档里会显式写「非真实检索」。
   */
  if (url.pathname === "/api/search/to-doc" && req.method === "POST") {
    const b = await readBody(req);
    const intentText = typeof b.text === "string" ? b.text : "";
    const intent = intentText ? await parseForSink(intentText, "doc") : null;
    if (intent && !intent.ok) {
      recordIntentMiss(intentText, intent.reasonCode);
      send(res, 200, { ok: false, degraded: true, reasonCode: intent.reasonCode,
        artifactId: null, zeroVlm: true, vlmCalls: 0 });
      return;
    }
    const query = String(b.query || (intent && intent.query) || "").trim();
    if (!query || query.length > 128) {
      send(res, 200, { ok: false, degraded: true, reasonCode: "bad-query",
        artifactId: null, zeroVlm: true, vlmCalls: 0 });
      return;
    }
    /* V-10：带 url 的定向检索必须落在显式授权白名单内。 */
    if (typeof b.url === "string" && b.url.trim()) {
      const auth = authorizeDomain(b.url, SEARCH_ALLOWED_HOSTS);
      if (!auth.ok) {
        send(res, 200, { ok: false, degraded: true, reasonCode: "requires_user_authorization",
          artifactId: null, zeroVlm: true, vlmCalls: 0 });
        return;
      }
    }
    /* V-10：检索类一律不进急停豁免。 */
    if (STOP.on) {
      send(res, 200, { ok: false, degraded: true, reasonCode: "stopped",
        artifactId: null, zeroVlm: true, vlmCalls: 0 });
      return;
    }

    let l4;
    let fixture = false;
    if (SEARCH_OFFLINE_FIXTURE && Array.isArray(b.fixtureResults)) {
      /* 验收专用：注入的是 fixture，不是检索结果；产物会写明「非真实检索」。 */
      l4 = normalizeL4({ ok: true, results: b.fixtureResults, provider: "offline-fixture", elapsedMs: 0 });
      fixture = true;
    } else {
      l4 = normalizeL4(await searchProvider.search(query, { epoch: epochOf() }));
    }

    /* 用户说「前 5 条」时按 5 条写；没说就用默认 3 条（parser 里已夹到上限）。 */
    const doc = buildSearchDoc(query, l4, {
      fixture,
      maxEntries: Number(intent && intent.count) || Number(b.count) || undefined,
    });
    if (!doc.ok) {
      send(res, 200, { ...doc, artifactId: null, realResults: false });
      return;
    }

    /* 落盘 + 登记：文件名由代码生成，绝不接受请求体里的路径。 */
    const cur = sessionMgr.current();
    const cid = String(b.conversationId || cur?.conversationId || "local");
    const fileName = `search-${Date.now()}.md`;
    let artifactId = null;
    let outPath = "";
    try {
      const dir = layout.kindDir("exports", cid, layout.day());
      fsSync.mkdirSync(dir, { recursive: true });
      outPath = path.join(dir, fileName);
      fsSync.writeFileSync(outPath, doc.markdown, "utf8");
      const reg = registerArtifact({
        conversationId: cid, epoch: epochOf(), ticketId: String(b.ticketId || ""),
        kind: "exports", fileName, ext: "md",
        size: Buffer.byteLength(doc.markdown, "utf8"), sha: "",
      });
      artifactId = reg.ok ? reg.id : null;
      logBus.write({ category: "artifact", level: "info", epoch: epochOf(),
        message: `检索回填 ${fileName}（${doc.entries.length} 条${fixture ? "，离线 fixture" : ""}）` });
    } catch (e) {
      send(res, 200, { ...doc, ok: false, degraded: true, reasonCode: "write-failed",
        artifactId: null, note: String(e?.message ?? e) });
      return;
    }
    /* realResults:false 明确告诉调用方「这是 fixture」，不许拿它冒充检索能力可用。
       带上 conversationId，产物表按会话过滤时就能直接查到这份文件。 */
    send(res, 200, {
      ...doc, artifactId, fileName, path: outPath,
      conversationId: cid, realResults: !fixture,
    });
    return;
  }

  /* ---------------- 检索 → 剪贴板（第二个确定性落点） ----------------
   * 和 to-doc 共用同一条闸门（provider → textGate → URL 协议闸），区别只在落点：
   * 不落盘、不登记产物，只把已过闸的纯文本回给调用方，由主进程写剪贴板。
   * 桥自己碰不到剪贴板，也不该碰 —— 一个 HTTP 服务不该有系统副作用。
   */
  if (url.pathname === "/api/search/to-clipboard" && req.method === "POST") {
    const b = await readBody(req);
    const intentText = typeof b.text === "string" ? b.text : "";
    const intent = intentText ? await parseForSink(intentText, "clipboard") : null;
    if (intent && !intent.ok) {
      recordIntentMiss(intentText, intent.reasonCode);
      send(res, 200, { ok: false, degraded: true, reasonCode: intent.reasonCode,
        text: "", count: 0, zeroVlm: true, vlmCalls: 0 });
      return;
    }
    const query = String(b.query || (intent && intent.query) || "").trim();
    if (!query || query.length > 128) {
      send(res, 200, { ok: false, degraded: true, reasonCode: "bad-query",
        text: "", count: 0, zeroVlm: true, vlmCalls: 0 });
      return;
    }
    if (STOP.on) {
      send(res, 200, { ok: false, degraded: true, reasonCode: "stopped",
        text: "", count: 0, zeroVlm: true, vlmCalls: 0 });
      return;
    }
    let l4;
    let fixture = false;
    if (SEARCH_OFFLINE_FIXTURE && Array.isArray(b.fixtureResults)) {
      l4 = normalizeL4({ ok: true, results: b.fixtureResults, provider: "offline-fixture", elapsedMs: 0 });
      fixture = true;
    } else {
      l4 = normalizeL4(await searchProvider.search(query, { epoch: epochOf() }));
    }
    /* 复用 buildSearchDoc 的闸门结果：再过一遍 textGate / URL 闸就等于有两份判定，
       这里只取已过闸的 entries 拼纯文本，不写盘、不登记产物。 */
    const doc = buildSearchDoc(query, l4, {
      fixture,
      maxEntries: Number(intent && intent.count) || Number(b.count) || undefined,
    });
    if (!doc.ok) {
      send(res, 200, { ok: false, degraded: true, reasonCode: doc.reasonCode, note: doc.note,
        text: "", count: 0, realResults: false, zeroVlm: true, vlmCalls: 0 });
      return;
    }
    const text = doc.entries
      .map((e, i) => `${i + 1}. ${e.title || "(无标题)"}\n${e.url}`)
      .join("\n\n");
    send(res, 200, {
      ok: true, action: "search-to-clipboard", query, text,
      count: doc.entries.length, entries: doc.entries,
      realResults: !fixture, fixture: fixture,
      zeroVlm: true, vlmCalls: 0, noVisionFallback: true,
    });
    return;
  }

  /* ---------------- 浏览器扩展通道（Native Messaging 宿主转发） ----------------
   * 所有 /api/* 已统一走 X-Orb-Token 鉴权，这里不重复也不放进 PUBLIC_PATHS。
   * 网页正文一律当作不可信输入交给 provider 状态机；不打印消息正文 / token，
   * 不调用 runVision、不回落截图 / 视觉循环。 */
  if (url.pathname === "/api/browser/relay" && req.method === "POST") {
    const b = await readBody(req);
    const m = b && b.message;
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      send(res, 400, { ok: false, error: "bad-message" });
      return;
    }
    /* command_done：扩展执行完桥下发（或自发）的命令后回执，本身不是给 provider 的状态机消息，
       而是桥侧结果关联表的输入。带的是扩展重派发时的 command_id，据此映射回 corrId。 */
    if (m.type === "command_done") {
      const corrId = (m.command_id && extToCorr.get(m.command_id)) || m.command_id || null;
      const slot = corrId ? browserCmdResults.get(corrId) : null;
      if (slot) {
        clearTimeout(slot.timer);
        browserCmdResults.delete(corrId);
        if (m.command_id) extToCorr.delete(m.command_id);
        slot.resolve({
          ok: true,
          result: m.ok ? (m.result || {}) : null,
          error: m.ok ? null : (m.error || { code: "exec-failed", message: "扩展执行未成功" }),
        });
      }
      send(res, 200, { ok: true, reply: null });
      return;
    }
    /* 急停期间也照常交给 provider：它自己会回 stopped / channel_close。
       closeAll 已在 doStop 里统一做过，这里不再追加任何带外动作。 */
    /* 带上传这个的宿主实例：provider 用它给 channel 记归属，
       后续 /api/browser/pending 才能只把命令交给开这条通道的那个浏览器。
       老宿主不带 instance → meta.instance 为空 → 退回老的全量投递行为。 */
    const relayInstance = url.searchParams.get("instance") || "";
    const reply = await browserProvider.handle(m, { instance: relayInstance });
    send(res, 200, { ok: true, reply: reply || null });
    return;
  }

  if (url.pathname === "/api/browser/pending" && req.method === "GET") {
    /* instance：宿主进程的实例标识。多个浏览器都装了扩展时会各起一个宿主，
       它们共享同一个 pending 队列 —— 不按归属分发就会被对方抢走，扩展侧静默丢弃。
       老宿主不带这个参数，drain 退回全量取走的老行为。 */
    const instance = url.searchParams.get("instance") || "";
    send(res, 200, { ok: true, messages: browserProvider.drain(instance) });
    return;
  }

  if (url.pathname === "/api/browser/status" && req.method === "GET") {
    /* config / stats 均为 provider 内脱敏后的固定字段。 */
    send(res, 200, {
      ok: true,
      enabled: !STOP.on,
      provider: browserProvider.stats(),
      config: browserProvider.config(),
      /* 用户级开关：面板据此显示，避免"界面上是开、执行时按关"的分裂。 */
      api_channel: apiChannel.status(),
      protocol: BROWSER_PROTOCOL_VERSION,
      reasonCode: STOP.on ? "stopped" : "",
    });
    return;
  }

  if (url.pathname === "/api/browser/stop" && req.method === "POST") {
    browserProvider.closeAll("manual-stop");
    send(res, 200, { ok: true, closed: true });
    return;
  }

  if (url.pathname === "/api/browser/own-tab" && req.method === "POST") {
    const b = await readBody(req);
    const ce = (typeof b.channel_epoch === "string" || typeof b.channel_epoch === "number")
      ? String(b.channel_epoch) : "";
    if (!ce || b.tabId === undefined || b.tabId === null) {
      send(res, 400, { ok: false, error: "bad-params" });
      return;
    }
    const owned = browserProvider.ownTab(ce, b.tabId);
    send(res, 200, { ok: true, owned: !!owned });
    return;
  }

  /* 桥主动下发命令到浏览器扩展（2026-11-08）：
   * 面板 / 自动化在「浏览器通道在线」时调用，由扩展在装了它的那个浏览器里真正执行
   * （夸克 / Chrome / Edge，取决于扩展装在哪）。写操作强制 confirm:true —— 这是
   * 第二道安全闸，和 provider 内的确认校验互为冗余。回传 command_id 供结果查询。 */
  if (url.pathname === "/api/browser/command" && req.method === "POST") {
    const b = await readBody(req);
    const method = typeof b.method === "string" ? b.method.trim() : "";
    const params = (b && b.params && typeof b.params === "object" && !Array.isArray(b.params)) ? b.params : {};
    if (b && b.confirm === true) params.confirm = true;
    let kind = "denied";
    if (browserReadMethods.has(method)) kind = "read";
    else if (browserWriteMethods.has(method)) kind = "write";
    if (kind === "denied") {
      send(res, 400, { ok: false, error: "method-denied", message: "方法不在浏览器通道白名单内" });
      return;
    }
    if (kind === "write" && params.confirm !== true) {
      send(res, 400, { ok: false, error: "confirmation-required", message: "写操作需要 confirm:true" });
      return;
    }
    const corrId = "br-" + randomUUID();
    /* _orbCmd 是桥侧关联标签，随 params 透传到扩展重派发的命令上，
       再随 command_done 前的 onCommand 回调映射回 corrId；它不含任何敏感字段，
       扩展侧 command_done 的 scrub 也不会把它当凭据滤掉。 */
    params._orbCmd = corrId;
    const slot = registerBrowserCommand(corrId);
    const r = browserProvider.command(method, params, { commandId: corrId });
    if (!r.ok) {
      clearTimeout(browserCmdResults.get(corrId)?.timer);
      browserCmdResults.delete(corrId);
      const msg = BROWSER_CMD_ERR[r.code] || r.code || "command-enqueue-failed";
      send(res, 409, { ok: false, error: r.code, message: msg });
      return;
    }
    /* slot.promise 在 command_done 到达或超时前不会 settle；
       但不在此 await —— 端点立刻返回 command_id，面板用 /command-result 另起轮询。 */
    void slot;
    send(res, 200, { ok: true, command_id: corrId, channel_epoch: r.channel_epoch });
    return;
  }

  /* 查询一条桥下发命令的执行结果（长轮询，桥侧最多等 BROWSER_CMD_TIMEOUT_MS）。
   * 成功返回 { ok:true, result:{...} }；扩展拒绝/执行失败返回 { ok:true, error:{...} }；
   * 已结算或不存在返回 404。面板据此把失败原因如实回显，而不是假装成功。 */
  if (url.pathname === "/api/browser/command-result" && req.method === "GET") {
    const id = url.searchParams.get("id");
    const slot = id ? browserCmdResults.get(id) : null;
    if (!slot) {
      send(res, 404, { ok: false, error: "not-found", message: "没有这条命令或已结算" });
      return;
    }
    const out = await slot.promise;
    send(res, 200, { ok: true, ...out });
    return;
  }

  /* ---------------- 浏览器扩展：安装 / 卸载 / 体检 ----------------
   * 只做三件事：调本仓自带的注册脚本、打开扩展目录、读状态。
   * 不写注册表以外的系统位置；不提权（全 HKCU）；不接受任何路径/参数透传
   * （扩展 ID 由脚本从 manifest.key 自行计算，避免被诱导写入任意 allowed_origins）。 */
  /* 开发态：HERE = orb/，脚本与扩展就在同级子目录。
     发布态：bridge.mjs 在 resources/，而 app 文件都在 resources/app/ 下。
     两处都试，取第一个存在的 —— 写死任一种都会在另一态静默失效。 */
  function firstExisting(cands) {
    for (const p of cands) { try { if (fsSync.existsSync(p)) return p; } catch {} }
    return cands[0];
  }
  const browserSetupScript = firstExisting([
    path.join(HERE, "tools", "register-browser-host.mjs"),
    path.join(HERE, "app", "tools", "register-browser-host.mjs"),
  ]);
  const browserExtDir = firstExisting([
    path.join(HERE, "browser-extension"),
    path.join(HERE, "app", "browser-extension"),
  ]);
  /* 宿主运行时：bridge 自己可能就跑在「Electron 当 Node」下（打包版没有独立 node.exe），
     这种情况下 process.execPath 是 ORB 控制台.exe，直接拿它当 electron 运行时最准确。 */
  const selfExeIsNode = /^node(\.exe)?$/i.test(path.basename(process.execPath));

  function runBrowserSetup(action, done) {
    if (!fsSync.existsSync(browserSetupScript)) {
      done({ ok: false, error: "setup-script-missing", path: browserSetupScript });
      return;
    }
    const flag = action === "install" ? "--install" : action === "remove" ? "--remove" : "--status";
    const args = [browserSetupScript, flag];
    if (action === "install") {
      if (selfExeIsNode) args.push("--node", process.execPath);
      else args.push("--electron", process.execPath);
    }
    execFile(process.execPath, args, {
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      /* ELECTRON_RUN_AS_NODE=1 才能让 ORB 控制台.exe 当 node 解释器跑这个脚本；
         bridge 由 node 拉起时该变量无害（node 会忽略）。 */
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }, (err, stdout, stderr) => {
      const text = String(stdout || "");
      const errText = String(stderr || "");
      /* 从脚本输出里取扩展 ID，纯展示用，不回写任何东西。 */
      const m = /扩展 ID\s*:\s*([a-p]{32})/.exec(text);
      done({
        ok: !err,
        action,
        extensionId: m ? m[1] : "",
        extensionDir: browserExtDir,
        output: text.split(/\r?\n/).filter(Boolean).slice(-40),
        error: err ? (errText || err.message || "setup-failed") : "",
      });
    });
  }

  if (url.pathname === "/api/browser/setup" && req.method === "POST") {
    const b = await readBody(req);
    const action = String((b && b.action) || "install");
    if (!["install", "remove", "status"].includes(action)) {
      send(res, 400, { ok: false, error: "bad-action" });
      return;
    }
    await new Promise((resolve) => {
      runBrowserSetup(action, (out) => {
        send(res, 200, out);
        resolve();
      });
    });
    return;
  }

  if (url.pathname === "/api/browser/open-dir" && req.method === "POST") {
    if (!fsSync.existsSync(browserExtDir)) {
      send(res, 404, { ok: false, error: "extension-dir-missing" });
      return;
    }
    /* 只允许打开固定目录，不接受请求参数里的路径。 */
    try {
      execFile("explorer.exe", [browserExtDir], { windowsHide: false }, () => {});
      send(res, 200, { ok: true, opened: browserExtDir });
    } catch (e) {
      send(res, 500, { ok: false, error: String(e && e.message || e) });
    }
    return;
  }

  /* ============ 阶段一：新增能力的聚合操作入口 ============
   * 面板不做，先给带令牌的 HTTP API；所有动作都是纯逻辑或本地文件，零模型调用。 */
  if (url.pathname === "/api/ops" && req.method === "POST") {
    const b = await readBody(req);
    const a = String(b.action || "");
    let out = { ok: true, action: a };
    try {
      /* 带外急停期间：任何可能发网络 / 写盘 / 签发收据的动作一律拒。
         纯查询动作（stats / capabilities / gate）仍允许，排查急停时不能把仪表盘也关了。 */
      const guardStop = () => {
        if (!STOP.on) return false;
        out = { ok: false, action: a, error: "stopped" };
        return true;
      };
      switch (a) {
        case "status":
          out.data = {
            epoch: epochOf(), stopped: STOP.on, writers: STATE_WRITERS,
            commandGate: commandGate.stats(), stateWriter: stateWriter.stats(),
            logBus: logBus.stats(), artifacts: artifactStore.stats(),
            span: spanCollector.stats(), observe: observeRouter.stats(),
            textGate: textGate.stats(), fastPath: fastPath.stats(),
            baseline: baseline.coverage(), events: eventRecorder.stats(),
            receipts: receipts.stats(), ticketControl: ticketCtl.stats(),
            visualTiers: visualTiers.stats(), session: sessionMgr.stats(),
            archiver: archiver.stats(), profile, formats: exporter.formats,
            /* 本批新增的五个只读能力，摘要一律走各自的 stats()/snapshot()：
               拿不到的指标在各模块内部就是 null + reason，这里不补零、不猜。 */
            team: team.stats(), affect: affectGate.stats(), plugin: pluginHost.stats(),
            router: semanticRouter.stats(), telemetry: (() => {
              try { return telemetry.snapshot(); } catch (e) { return { ok: false, error: String(e?.message || e) }; }
            })(),
            metrics: METRICS, tiers: TIERS, launched: [...launchedProcs.values()],
            layout: layout.describe(), logForward: logForwardEnabled,
            logChain: logBus.chainStats?.() || null,
            /* 11-07 新增：全是纯内存摘要，不读盘、不 spawn。状态流每 1.5s 推一次，
               明细一律走 /api/ops 的 gov.status / policy.state / dream.stats。 */
            gov: { tiers: govCore.TIERS, sites: SITE_STATS.total, host: hostApi.getStats() },
            policy: { epoch: policyTransition.state().policyEpoch, stopEpoch: STOP.epoch, stopLike: policyTransition.isStopLike() },
            dream: dream.stats(), memoryBudget: memoryBudget.stats(), artifactGate: artifactGate.stats(),
          };
          break;
        /* 外部检索状态（只读）：脱敏 config + stats。不提供任何设 key / 开关的动作。 */
        case "search.status": out.data = { config: searchProvider.config(), stats: searchProvider.stats() }; break;
        /* 浏览器通道（只读）：脱敏 stats/config + drain。不提供设 key / 绕过白名单的动作。 */
        case "browser.status": out.data = { provider: browserProvider.stats(), config: browserProvider.config() }; break;
        case "browser.pending": out.data = { messages: browserProvider.drain() }; break;
        case "log.write": out.data = logBus.write(b.rec || {}); break;
        case "log.query": out.data = logBus.query(b.query || {}); break;
        case "log.flush": logBus.flush(); out.data = logBus.stats(); break;
        /* ============ 产物布局 / 日志配置（面板「产物与日志」区块用） ============ */
        case "layout.describe": out.data = layout.describe(); break;
        case "layout.products": out.data = layout.listProducts(b.day || undefined); break;
        case "layout.context": {
          /* 主进程录屏/截屏/看视频前会来取一次，保证两边用同一个 day + conversationId。 */
          let cur = sessionMgr.current();
          if (!cur) { sessionMgr.start({ reason: "layout-context" }); cur = sessionMgr.current(); }
          const cid = String(cur?.conversationId || "local");
          const day = layout.day();
          /* 一次把六类产物目录建全：主进程/面板拿到上下文的那一刻，
             产物树形状就是完整的（不含日志/治理，它们各自在别的树里）。 */
          try { layout.ensureDay(day); layout.ensureSession(cid, day); } catch {}
          /* 把这一天的**全部固定路径**一次给全 —— 主进程不再自己拼任何一层目录名。
             改目录形状只需要改 artifactLayout.cjs 一处。 */
          out.data = {
            day, conversationId: cid,
            ...layout.paths(cid, day),
          };
          break;
        }
        case "layout.paths": {
          /* 面板 / 自检用：不传 cid 就取当前会话，不传 day 就取当天。 */
          let cur = sessionMgr.current();
          const cid = String(b.conversationId || cur?.conversationId || "local");
          out.data = layout.paths(cid, b.day || undefined);
          break;
        }
        case "layout.setRoot": {
          const r = String(b.root || "").trim();
          if (r) layout.setRoot(r);
          try { layout.ensureDay(); } catch {}
          out.data = { root: layout.root(), day: layout.day() };
          break;
        }
        case "layout.openDay": {
          const d = /^\d{4}-\d{2}-\d{2}$/.test(String(b.day || "")) ? String(b.day) : layout.day();
          const dir = layout.dayDir(d);
          fsSync.mkdirSync(dir, { recursive: true });
          /* 走 spawn 数组参数，绝不拼 shell 命令；explorer 是查看目录，不是脚本宿主。 */
          try {
            const ch = spawn("explorer.exe", [dir], { stdio: "ignore", windowsHide: true, detached: true });
            ch.on("error", () => {});
            if (typeof ch.unref === "function") ch.unref();
            out.data = { path: dir, opened: true };
          } catch (e) { out.data = { path: dir, opened: false, error: String(e?.message ?? e) }; }
          break;
        }
        case "log.level": {
          const l = String(b.level || "");
          if (!LEVELS.includes(l)) { out = { ok: false, action: a, error: "invalid level" }; break; }
          logBus.setMinLevel?.(l);
          out.data = { minLevel: l };
          break;
        }
        case "log.redact": {
          /* 兼容两种字段名：redactPaths=是否遮路径；enabled（旧约定）=路径脱敏开关。 */
          const rp = b.redactPaths != null ? !!b.redactPaths : (b.enabled !== false);
          logBus.setRedactPaths?.(rp);
          out.data = { redactPaths: rp };
          break;
        }
        case "log.forward": {
          logForwardEnabled = b.enabled !== false;
          out.data = { enabled: logForwardEnabled };
          break;
        }
        case "log.retention": out.data = logBus.cleanup?.(Date.now(), { days: Number(b.days) || 0 }) || { ok: false, reason: "cleanup unavailable" }; break;
        case "log.spool.replay": out.data = logBus.replaySpool?.() || { ok: false, reason: "replay unavailable" }; break;
        case "log.stats": {
          const lb = logBus.stats();
          out.data = {
            ...lb,
            /* 面板读的是 data.logBus.written/rejected —— 同时保留顶层扁平字段，
               两种读法都成立，避免面板与接口各写一套。 */
            logBus: { ...lb, forward: logForwardEnabled },
            chain: logBus.chainStats?.() || null,
            forward: logForwardEnabled, categories: CATEGORIES, levels: LEVELS,
            layout: { root: layout.root(), day: layout.day(), logsDir: layout.logsDir() },
          };
          break;
        }
        case "log.export": {
          const fmt = String(b.format || "jsonl");
          if (!["jsonl", "csv", "txt"].includes(fmt)) { out = { ok: false, action: a, error: "unsupported format" }; break; }
          /* 面板的分类多选是用逗号拼起来传的（未全选时只传选中的几类）。
             逐类查完再合并去重，最后统一按 ts 排序并截到 limit。 */
          const limit = Math.max(1, Math.min(Number(b.limit || 2000), 10000));
          const cats = String(b.category || "").split(",").map((s) => s.trim()).filter(Boolean);
          let rows;
          if (cats.length) {
            const seen = new Set();
            rows = [];
            for (const c of cats) {
              for (const r of logBus.query({ category: c, level: String(b.level || ""), since: Number(b.since || 0), limit: 10000 })) {
                const k = `${r.ts}|${r.category}|${r.message}`;
                if (seen.has(k)) continue;
                seen.add(k);
                rows.push(r);
              }
            }
            rows.sort((x, y) => (x.ts || 0) - (y.ts || 0));
            rows = rows.slice(-limit);
          } else {
            rows = logBus.query({ level: String(b.level || ""), since: Number(b.since || 0), limit });
          }
          let text;
          if (fmt === "csv") {
            const esc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
            text = ["ts,category,level,epoch,message"]
              .concat(rows.map((r) => [r.ts, r.category, r.level, r.epoch, r.message].map(esc).join(","))).join("\n");
          } else if (fmt === "txt") {
            text = rows.map((r) => `${new Date(r.ts || 0).toISOString()} [${r.level}] [${r.category}] ${r.message}`).join("\n");
          } else {
            text = rows.map((r) => JSON.stringify(r)).join("\n");
          }
          const c = sessionMgr.current();
          const dir = layout.kindDir("exports", c?.conversationId || "local", layout.day());
          fsSync.mkdirSync(dir, { recursive: true });
          const outFile = path.join(dir, `logs-${Date.now()}.${fmt}`);
          const part = outFile + ".part";
          fsSync.writeFileSync(part, text + (text ? "\n" : ""), "utf8");
          fsSync.renameSync(part, outFile);   // 原子落盘，不留半个文件
          const bytes = fsSync.statSync(outFile).size;
          registerArtifact({
            conversationId: String(c?.conversationId || ""), epoch: epochOf(),
            kind: "exports", fileName: path.basename(outFile), ext: fmt, size: bytes, sha: "",
          });
          logBus.write({ category: "artifact", level: "info", epoch: epochOf(),
            message: `日志导出 ${fmt}：${path.basename(outFile)}（${rows.length} 行）` });
          out.data = { path: outFile, bytes, format: fmt, rows: rows.length };
          break;
        }
        /* 面板 artifacts.register 仍传裸文件名（PDF 两跳落地后登记），这里补齐
           <day>/sessions/<cid>/exports/<name>，让它在浮层里也能被定位。 */
        case "artifacts.register": {
          const e = b.entry && typeof b.entry === "object" ? b.entry : {};
          out.data = registerArtifact({ ...e, fileName: e.rel || e.fileName || "" });
          break;
        }
        case "artifacts.resolve": out.data = artifactStore.resolve(b.root || ARTIFACTS_DIR, b.kind || "artifacts", b.rel || ""); break;
        case "observe.assess": out.data = observeRouter.assess(b.event || {}); break;
        case "observe.recordHuman": out.data = observeRouter.recordHuman(b.record || {}); break;
        case "observe.stats": out.data = { stats: observeRouter.stats(), canAuto: observeRouter.canEnableAuto() }; break;
        case "observe.flush": out.data = observeRouter.flush(); break;
        case "span.start": out.data = spanCollector.start(b.meta || {}); break;
        case "span.mark": out.data = spanCollector.mark(b.spanId, b.name, b.at); break;
        case "span.finish": out.data = spanCollector.finish(b.spanId, b.info || {}); break;
        case "span.percentiles": out.data = spanCollector.percentiles(b.name || ""); break;
        case "span.six": out.data = spanCollector.sixMetrics(); break;
        case "span.flush": out.data = spanCollector.flush(); break;
        case "baseline.plan": out.data = baseline.plan(b.tasks || []); break;
        case "baseline.record": out.data = baseline.record(b.record || {}); break;
        case "baseline.report": out.data = baseline.report(); break;
        case "fastpath.screen": out.data = fastPath.screen(b.data || {}); break;
        case "fastpath.charge": out.data = fastPath.charge(b.key || "default", Number(b.tokens || 0)); break;
        case "textgate.check": out.data = textGate.check(String(b.text || ""), b.meta || {}); break;
        case "textgate.asData": out.data = textGate.asData(String(b.text || "")); break;
        /* V-11 统一入口：transcript / ocr / webpage 三个来源都走 guard，
           来源不合法直接拒，不猜一个默认值蒙混过关。 */
        case "textgate.guard": {
          const src = String(b.source || "");
          out.data = isUntrustedSource(src)
            ? textGate.guard(String(b.text || ""), src)
            : { ok: false, reasonCode: "unknown-source", source: src, data: "" };
          break;
        }
        case "textgate.markTemp": out.data = textGate.markTemp(String(b.text || "")); break;
        case "textgate.disposition": out.data = textGate.disposition(b.record || {}); break;
        case "textgate.scorePrompt": out.data = textGate.scorePrompt(String(b.text || "")); break;
        /* V-01 回落：显式可审计降级（§10.2），四类架构原因码由 batchA 统一映射。 */
        case "v01.degrade": out.data = noteV01Degrade(b); break;
        case "v01.degrades": out.data = { rows: v01Degrades.slice(-50), count: v01Degrades.length, codes: Object.keys(DEGRADE_CODES) }; break;
        case "batchA.audit": out.data = { searchExempt: searchExemptAudit(), allowedHosts: SEARCH_ALLOWED_HOSTS.length, v12: V12_CONTRACT }; break;
        case "session.start": out.data = sessionMgr.start(b.meta || {}); break;
        case "session.current": out.data = sessionMgr.current(); break;
        case "session.touch": sessionMgr.touch(); out.data = sessionMgr.current(); break;
        case "session.finalize": out.data = sessionMgr.finalize(b.reason || "explicit"); break;
        case "session.startNew": out.data = sessionMgr.startNew(b.meta || {}); break;
        case "session.idleCheck": out.data = sessionMgr.idleCheck(); break;
        case "archive.run": {
          const sess = b.session || (() => { const f = sessionMgr.finalize(b.reason || "explicit"); return f && f.ok ? f : null; })();
          /* 扁平化：归档产物落 <root>/archive/<day>/<cid>/，与录屏/截屏/看视频同一棵树、
           * 同一层语义（都是 <root>/<kind>/<day>/...），由 listProducts("archive") 统一枚举。
           * 旧约定 `<day>/sessions/<cid>/archive` 不再使用。 */
          const aligned = sess ? {
            ...sess,
            dir: `archive/${sess.day}/${String(sess.conversationId || "local").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64)}`,
          } : null;
          out.data = aligned
            ? archiver.archive({ session: aligned, entries: b.entries || [], logs: b.logs || [] })
            : { ok: false, error: "no active session" };
          break;
        }
        case "archive.manifest": out.data = archiver.readManifest(b.dir || ""); break;
        /* ---------------- 专家团（只读） ----------------
         * 只读是硬约束：这里不提供"派给它执行"的入口。真正执行只有 /api/dispatch
         * 与 /api/call 两条通道，都过 commandGate 与 STOP.epoch。 */
        case "team.list": {
          const l = team.list();
          /* 把最近一次评审的每条视角贡献数挂上去，面板卡片可以直接显示"发现 N"。 */
          const per = {};
          if (teamLastReview && Array.isArray(teamLastReview.perspectives)) {
            for (const p of teamLastReview.perspectives) per[p.id] = p.findings;
          }
          out.data = {
            ok: true,
            experts: (l.experts || []).map((e) => ({ ...e, findings: per[e.id] || 0 })),
            teams: l.teams || [],
            stats: l.stats || {},
            lastReview: teamLastReview,
          };
          break;
        }
        case "team.detail": {
          const r = team.detail(String(b.id || ""));
          if (!r.ok) { out = { ok: false, action: a, error: r.error || "unknown-expert" }; break; }
          /* 下钻的"最近发现"从最近一次评审里筛，不额外读盘 —— 只读视图要快且可复现。 */
          let recent = Array.isArray(r.recent) ? r.recent : [];
          if (teamLastReview && Array.isArray(teamLastReview.ranked)) {
            recent = teamLastReview.ranked
              .filter((f) => f.expertId === String(b.id || ""))
              .map((f) => ({ claim: f.claim, severity: f.severity, confidence: f.confidence, evidence: f.evidence }));
          }
          out.data = { ok: true, expert: r.expert, recent, evidence: r.evidence || [] };
          break;
        }
        case "team.setEnabled": {
          const id = String(b.id || "");
          const on = b.enabled !== false;
          out.data = { ok: team.setEnabled(id, on), id, enabled: on };
          break;
        }
        case "team.review": {
          const rev = team.review({
            subject: String(b.subject || "手动评审"),
            findings: Array.isArray(b.findings) ? b.findings : [],
            epoch: epochOf(),
          });
          teamLastReview = rev;
          out.data = { ok: true, review: rev };
          break;
        }
        case "team.collectReview": {
          /* 面板「任务后自动复核」开关经 review.auto 同步过来。这里必须真拦：
             否则安全页显示「关闭」，后台却还在每单跑一轮，就是空头状态。
             手动发起的评审不带 auto，仍然可用（排查时需要）。 */
          if (b.auto === true && !reviewAutoEnabled) {
            out = { ok: false, action: a, error: "自动复核已关闭" };
            break;
          }
          /* light 默认开：这条会被面板在**每条任务收尾**自动调用，
             不能为了自检去 spawn 遥测命令。要深档请显式传 light:false。 */
          const light = b.light !== false;
          const t0 = Date.now();
          const rev = team.review({
            subject: String(b.subject || ("运行状态自检 " + layout.day())),
            findings: teamCollectFindings({ light }),
            epoch: epochOf(),
          });
          teamLastReview = rev;
          /* 四段式报告落产物树 misc/：报告是"产物"，不是日志，所以进 artifacts。
             自动档只在**有发现**时落盘 —— 每单写三个文件（report/skill/evidence）
             是纯噪音，磁盘和 mtime 都受不了。需要留档请传 report:true。 */
          let report = null;
          const wantReport = b.report === true
            || (!light && rev.verdict !== "pass")
            || (light && rev.verdict !== "pass" && b.report !== false);
          if (wantReport) {
            try {
              const c = sessionMgr.current();
              const cid = String(c?.conversationId || "local");
              const base = layout.kindDir("misc", cid, layout.day()) || layout.dayMiscDir(layout.day());
              report = team.writeReport(rev, { dir: path.join(base, "team-review-" + Date.now()) });
            } catch (e) {
              report = { ok: false, error: String(e?.message || e) };
            }
          }
          try {
            logBus.write({
              category: "task", level: "info", epoch: epochOf(),
              message: "专家团自检评审：" + String(rev.verdict) + "（" + ((rev.counts && rev.counts.kept) || 0) + " 条发现）",
            });
          } catch {}
          /* elapsedMs 一起回去：面板要靠它判断"自动复核是不是拖慢了响应"，
             连续几次超阈值就自己降级并在界面上说明，而不是硬扛。 */
          out.data = { ok: true, review: rev, report, light, elapsedMs: Date.now() - t0 };
          break;
        }
        case "team.paths": {
          /* 让面板/自检能问一句"报告会落在哪"，不必自己拼路径。 */
          const c = sessionMgr.current();
          const cid = String(b.conversationId || c?.conversationId || "local");
          out.data = { ok: true, miscDir: layout.kindDir("misc", cid, layout.day()) };
          break;
        }

        /* ---------------- 开口门控（六项） ---------------- */
        case "affect.status": {
          out.data = {
            ok: true,
            options: affectGate.options(),
            stats: affectGate.stats(),
            tier: affectGate.tier(),
            tiers: Object.fromEntries(Object.entries(SPEAK_TIERS).map(([k, v]) => [k, { id: v.id, name: v.name, hint: v.hint }])),
            records: affectGate.records({ limit: Number(b.limit) || 20 }),
            gates: AFFECT_GATES.map((g) => ({ ...g })),
          };
          break;
        }
        /* 用户能碰的只有「安静 / 标准 / 及时」三档，不给任何数值参数入口。
           旧的 affect.set 允许直接改冷却/阈值/熔断次数，已按用户要求收口：
           现在只认 tier，传 options 一律拒绝，护栏无法被调没了。 */
        case "affect.setTier": {
          const r = affectGate.setTier(String(b.tier || ""));
          if (r.ok === false) { out = { ok: false, action: a, error: r.error }; break; }
          out.data = { ok: true, tier: r.tier, name: r.name };
          break;
        }
        case "affect.infer": out.data = { ok: true, inferred: inferTierFromText(String(b.text || "")) }; break;
        case "affect.set": {
          out = { ok: false, action: a, error: "门控参数不开放调整，请用 affect.setTier 选「安静 / 标准 / 及时」" };
          break;
        }
        /* 安全子菜单只读概览：全部是状态词，一个数值都不给界面。 */
        case "safety.overview": {
          out.data = {
            ok: true,
            overview: safetyOverview({
              reviewAuto: reviewAutoEnabled,
              team: team.stats(),
              affect: affectGate.stats(),
              lastReview: teamLastReview,
              plugins: (pluginHost.list().plugins || []).map((p) => ({ name: p.name, enabled: p.enabled !== false })),
              tier: affectGate.tier(),
              tiers: SPEAK_TIERS,
            }),
          };
          break;
        }
        case "review.auto": {
          if (typeof b.on === "boolean") reviewAutoEnabled = b.on;
          out.data = { ok: true, enabled: reviewAutoEnabled };
          break;
        }
        /* 门控判定（热路径）。面板每次要主动开口前调一次。
         * stopped 由桥自己补：面板不该猜急停状态 —— 它看到的可能是一秒前的快照，
         * 而"该不该说话"必须在**当下**判定。ctx 显式给了 stopped 才以它为准（自检用）。 */
        case "affect.evaluate": {
          const ctx = Object.assign({}, (b.ctx && typeof b.ctx === "object") ? b.ctx : {});
          if (ctx.stopped === undefined) ctx.stopped = STOP.on;
          out.data = affectGate.evaluate(ctx);
          break;
        }
        case "affect.reset": affectGate.reset(); out.data = { ok: true, stats: affectGate.stats() }; break;

        /* ---------------- 插件底座 ---------------- */
        case "plugin.list": {
          const hostPlugins = (pluginHost.list().plugins || []);
          const ledById = {};
          (ledgerRead().entries || []).forEach((e) => { if (e.id) ledById[e.id] = e; });
          const plugins = hostPlugins.map((p) => {
            const rec = ledById[p.id];
            return rec ? Object.assign({}, p, { via: rec.via || "", sourceHash: rec.sourceHash || "" }) : p;
          });
          out.data = { ok: true, plugins, stats: pluginHost.stats(), restore: pluginRestore };
          break;
        }
        case "plugin.run": out.data = await pluginHost.run(String(b.id || ""), b.args || {}); break;
        case "plugin.register": {
          const r = pluginHost.register(b.plugin || {});
          /* 只接受纯函数插件：桥不会把 run 序列化给别的进程，也不落盘。 */
          out.data = r;
          break;
        }
        case "plugin.unregister": out.data = pluginHost.unregister(String(b.id || "")); break;
        /* 用户级卸载：注销注册表 + 忘台账 + 删本地落盘目录。
         * 市场装的 dir 指向外部 WorkBuddy 目录，不在 PACK_STORE 下，绝不删。 */
        case "plugin.uninstall": {
          if (guardStop()) break;
          const id = String(b.id || "");
          if (!id) { out = { ok: false, action: a, error: "id-required" }; break; }
          const ur = pluginHost.unregister(id);
          let forgot = false, deletedDir = null;
          try {
            const rec = (ledgerRead().entries || []).find((e) => String(e.id) === id);
            if (rec) {
              ledgerForget(rec.sourceHash || rec.dir || rec.name);
              forgot = true;
              const dir = String(rec.dir || "");
              if (dir && dir.indexOf(PACK_STORE + path.sep) === 0) {
                try { fsSync.rmSync(dir, { recursive: true, force: true }); deletedDir = dir; } catch { /* 删不动也不挡注销 */ }
              }
            }
          } catch { /* 台账异常不阻断注销本身 */ }
          out.data = { ok: true, id, unregister: ur, forgot, deletedDir };
          break;
        }

        /* ---------------- 导入区：先校验、再安装（同一条摄入路径） ---------------- */
        case "plugin.dryrun": {
          const raw = b.manifest && typeof b.manifest === "object" ? b.manifest : null;
          if (!raw) { out = { ok: false, action: a, error: "manifest-required" }; break; }
          const hash = b.sourceHash
            ? String(b.sourceHash)
            : "sha256:" + createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 32);
          out.data = dryRunManifest(artifactGate, { manifest: raw }, {
            sourceHash: hash, epoch: epochOf(), approvedBy: String(b.approvedBy || ""),
          });
          break;
        }
        case "plugin.install": {
          if (guardStop()) break;
          const raw = b.manifest && typeof b.manifest === "object" ? b.manifest : null;
          if (!raw) { out = { ok: false, action: a, error: "manifest-required" }; break; }
          const hash = b.sourceHash
            ? String(b.sourceHash)
            : "sha256:" + createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 32);
          out.data = installManifest(pluginHost, { manifest: raw }, {
            sourceHash: hash, epoch: epochOf(), approvedBy: String(b.approvedBy || ""),
          });
          break;
        }

        /* ---------------- 本机插件市场（只读索引 + 一键安装） ---------------- */
        case "plugin.market.list": {
          const idx = marketIndex(Boolean(b.refresh));
          const r = searchMarket(idx.plugins, {
            q: String(b.q || ""),
            marketplace: String(b.marketplace || ""),
            limit: Number(b.limit) || 60,
          });
          /* 已装标记按名字比：注册表里的 name 与市场条目名同源（适配器会保留原名）。
             名字可能重名，所以这只是一个"看起来装过"的提示，不作为安装判据。 */
          const regNames = new Set(
            (pluginHost.list().plugins || []).map((p) => String(p.name || "").toLowerCase()),
          );
          out.data = {
            ok: idx.ok,
            root: idx.root,
            scannedAt: idx.scannedAt,
            marketplaces: idx.marketplaces,
            warnings: idx.warnings,
            allTotal: (idx.plugins || []).length,   // 全量收录：页签徽标用这个，不是搜索结果数
            total: r.total,                          // 当前筛选命中数
            items: r.items.map((it) => ({ ...it, installed: regNames.has(String(it.name).toLowerCase()) })),
          };
          break;
        }
        case "plugin.market.install": {
          if (guardStop()) break;
          out.data = installFromMarket(b);
          break;
        }
        case "plugin.market.open": {
          const idx = marketIndex();
          const want = String(b.marketplace || "");
          const hit = want ? (idx.marketplaces || []).find((m) => m.name === want) : null;
          const target = (hit && hit.dir) || idx.root || "";
          if (!target) { out = { ok: false, action: a, error: "market-root-unknown" }; break; }
          try {
            execFile("explorer.exe", [target], { windowsHide: false }, () => {});
            out.data = { ok: true, opened: target };
          } catch (e) {
            out.data = { ok: false, error: String((e && e.message) || e) };
          }
          break;
        }

        /* ---------------- 本地插件包（拖进来 / 选文件） ----------------
         * 拖进来的字节先落 DATA_DIR/plugin-store，再走 readSource → 摄入 → 真实闸门。
         * 校验与安装用的是同一份落盘结果，所以界面上"校验通过"就等于"装得上"。 */
        case "plugin.pack.inspect": out.data = installFromPack(b, { dry: true }); break;
        case "plugin.pack.install": {
          if (guardStop()) break;
          out.data = installFromPack(b, { dry: false });
          break;
        }

        /* ---------------- 安装台账（重启后装回来的依据） ---------------- */
        case "plugin.ledger.list": out.data = { ok: true, file: PLUGIN_LEDGER_FILE, ...ledgerRead(), restore: pluginRestore }; break;
        case "plugin.ledger.forget": {
          if (guardStop()) break;
          const key = String(b.sourceHash || b.dir || b.name || "");
          if (!key) { out = { ok: false, action: a, error: "key-required" }; break; }
          ledgerForget(key);
          out.data = { ok: true, forgot: key };
          break;
        }

        /* ---------------- 语义路由（只观察） ---------------- */
        case "router.classify": out.data = semanticRouter.classify(String(b.text || "")); break;
        case "router.setMode": out.data = semanticRouter.setMode(String(b.mode || "")); break;
        case "router.stats": out.data = { ok: true, ...semanticRouter.stats(), samples: semanticRouter.samples({ limit: Number(b.limit) || 10 }) }; break;

        /* ---------------- 机器遥测（只读快照） ---------------- */
        case "telemetry.snapshot": out.data = telemetry.snapshot(); break;
        case "events.start": out.data = eventRecorder.start(b.sessionId || ""); break;
        case "events.record": out.data = eventRecorder.record(b.event || {}); break;
        case "events.read": out.data = eventRecorder.read(b.query || {}); break;
        case "events.flush": out.data = eventRecorder.flush(); break;
        case "receipts.issue": out.data = receipts.issue(b.data || {}); break;
        case "receipts.settle": out.data = receipts.settle(b.receiptId, b.info || {}); break;
        case "receipts.memoryOwnership": out.data = receipts.memoryOwnership(b.data || {}); break;
        /* 按幂等键查上次结果：调用方重试时先问这一句，比自己记状态可靠。 */
        case "receipts.byKey": out.data = { ok: true, receipt: receipts.byKey(String(b.key || "")) }; break;

        /* ---------------- 专家契约（只读边界） ---------------- */
        case "expert.list": out.data = { ok: true, ...expertBook.stats(), rows: expertBook.list() }; break;
        /* 改完 expertBook.json 不必重启桥：重读一次即可，读不懂会把 warning 带回去。 */
        case "expert.reload": out.data = { ok: true, ...expertBook.load(), stats: expertBook.stats() }; break;
        case "expert.get": out.data = { ok: expertBook.has(b.expertId), expertId: String(b.expertId || ""), contract: expertBook.get(b.expertId) }; break;

        /* ---------------- 换档账本（视觉档 / 路由 / 通道 / 模式） ---------------- */
        case "upgrade.stats": out.data = { ok: true, ...upgrade.stats(), ladders: LADDERS, last: Object.keys(LADDERS).map((k) => ({ ladder: k, rec: upgrade.last(k) })) }; break;
        case "upgrade.history": out.data = { ok: true, rows: upgrade.history({ ladder: b.ladder, limit: Number(b.limit) || 30 }) }; break;
        /* 手动记一次换档：面板切 Max 模式时用，这样"什么时候进的 Max"也有账。 */
        case "upgrade.track": {
          const r = upgrade.transition(String(b.ladder || ""), String(b.from || ""), String(b.to || ""), { cause: String(b.cause || ""), epoch: b.epoch });
          out.ok = r.ok;
          out.data = r;
          break;
        }

        /* ---------------- 语气三槽（暖/中/冷） ----------------
         * 面板只在上下文变化时问一次（任务完成/失败、切 Max、启动），
         * 不是每句台词都问 —— 主动开口本来就不该多一次往返。 */
        case "persona.slot": out.data = personaSlots.update(b.ctx || {}); break;
        case "persona.stats": out.data = { ok: true, ...personaSlots.stats(), slots: PERSONA_SLOTS }; break;
        case "persona.reset": out.data = personaSlots.reset(); break;
        case "ticket.pause": out.data = ticketCtl.pause(b.scope || "global"); break;
        case "ticket.resume": out.data = ticketCtl.resume(b.scope || "global"); break;
        case "ticket.isBlocked": out.data = ticketCtl.isBlocked(b.scope || "global", { isNew: b.isNew !== false }); break;
        case "ticket.steer": out.data = ticketCtl.steer(b.ticketId || "", String(b.text || "")); break;
        case "ticket.applyStep": out.data = ticketCtl.applyStep(b.ticketId || "", Number(b.stepIdx || 0)); break;
        case "ticket.humanCorrection": out.data = ticketCtl.humanCorrection(b.ticketId || "", String(b.text || "")); break;
        case "ticket.alert": out.data = ticketCtl.alert(b.ticketId || "", b.reason || "", b.epoch ?? epochOf()); break;
        case "visual.pick": out.data = visualTiers.pick(b.data || {}); break;
        case "visual.preload": out.data = visualTiers.preload({ kind: b.kind || "default", read: () => b.value, epoch: b.epoch ?? epochOf() }); break;
        case "visual.cancel": out.data = visualTiers.cancel(b.kind || "default"); break;
        case "visual.invalidate": out.data = visualTiers.invalidate(b.epoch ?? epochOf()); break;
        case "state.commit": out.data = stateWriter.commit(b.id || "ops", b.to || "running", b.info || {}); break;
        case "state.stats": out.data = stateWriter.stats(); break;
        case "profile.get": out.data = profile; break;
        case "profile.set": {
          const v = validateProfile(b.profile || {});
          if (v.ok) { profile = normalizeProfile(b.profile); exporter = createExporter({ profile, epoch: epochOf() }); }
          out.data = { ok: v.ok, errors: v.errors, profile };
          break;
        }
        case "epoch.stats": out.data = { epoch: epochOf(), gate: commandGate.stats(), clock: commandGate.clock.stats() }; break;
        case "launched.list": out.data = [...launchedProcs.values()]; break;

        /* ===== 11-07 增量简报落地 + 专家团治理纪律层 =====
         * 三段前缀：gov.*（治理层）/ policy.*（策略优雅收敛）/ dream.*（离线整理）
         * / memory.*（动态预算）/ artifact.*（生成物闸门）/ site.*（规模化能力表）。
         * 只读动作不拦急停；有副作用的先过 guardStop()。 */

        /* --- 治理层：四档矩阵 / 代价路由 / 证据 / 红线 --- */
        case "gov.status": out.data = {
          modes: govCore.MODES, tiers: govCore.TIERS,
          stages: govVerify.STAGES, channels: govP2.CHANNELS,
          sites: SITE_STATS, endpoints: Object.keys(govHost.API_ENDPOINTS),
          host: hostApi.getStats(), channelRev: govChannel.readAll().rev,
          apiChannel: apiChannel.status(),
          policyEpoch: policyTransition.state().policyEpoch,
          stopEpoch: STOP.epoch, stopLike: policyTransition.isStopLike(),
        }; break;
        case "gov.resolve": {
          const mode = govCore.resolveMode({ teamMode: b.teamMode === true, maxMode: b.maxMode === true });
          out.data = { mode, description: govCore.describeMode(mode),
            enabled: govCore.enabledGovernance(mode),
            tierA: govCore.isTierAEnabled(mode), tierB: govCore.isTierBEnabled(mode) };
          break;
        }
        case "gov.route": out.data = govP0.routeByCost(b.task || {}); break;
        case "gov.evidence.tag": out.data = govP0.tagEvidence(b.claim, b.meta || {}); break;
        case "gov.evidence.admit": out.data = govP0.admissibleForSeal(b.items || []); break;
        case "gov.redline": out.data = govP0.checkRedLine(b.action || {}); break;
        case "gov.house": out.data = govP0.checkHouseRule(b.roster || {}, b.ctx || {}); break;
        case "gov.rules": out.data = { sections: govRules.SECTIONS.length, markdown: govRules.render() }; break;

        /* --- 站点能力表：226 站真实域名，未核实条目绝不生成选择器 --- */
        case "gov.site.capabilities": out.data = { stats: SITE_STATS, table: govP2.SITE_CAPABILITIES }; break;
        case "gov.site.gate": out.data = govP2.actionGate(b.req || {}); break;
        case "gov.site.vision": out.data = govP2.assertVisionDecisionOnly(b.decision || {}); break;
        case "site.stats": out.data = SITE_STATS; break;
        case "site.table": out.data = buildCapabilityTable(); break;
        case "site.lookup": out.data = lookupSite(b.domain || ""); break;
        case "site.audit": out.data = assertNoInventedSelectors(buildCapabilityTable()); break;

        /* --- 执行桥接 / 宿主取数 / 封驳 / 五段验收 / 文件信道 --- */
        case "gov.plan": out.data = govExec.planExecution(b.req || {}); break;
        case "gov.plan.run": {
          if (guardStop()) break;
          const plan = b.plan || govExec.planExecution(b.req || {});
          /* api 通道的计划先过用户开关：关着就不执行，也不把请求发出去。 */
          if (!apiChannel.isEnabled() && plan && plan.browser && plan.browser.channel === "host_data_api") {
            out.data = { ok: false, code: USER_DISABLED, reason: "用户在扩展面板关闭了 API 通道", results: [] };
            break;
          }
          /* 开关是唯一决定权：开着才给 hostApi 一个 enabled 实例；
             关着沿用常驻的 enabled:false 实例（runPlan 会拿到 disabled）。 */
          const planHostApi = apiChannel.isEnabled() ? govHost.createHostDataApi({ enabled: true }) : hostApi;
          out.data = await govExec.runPlan(plan, { hostApi: planHostApi });
          break;
        }
        case "gov.host.fetch": {
          if (guardStop()) break;
          /* 用户开关是**硬上限**：关着的时候，调用方传 enabled:true 也不放行。
             `enabled` 参数保留（老调用方还在传），但已不具备开启能力。 */
          if (!apiChannel.isEnabled()) {
            out.data = {
              ok: false, code: USER_DISABLED, data: null, evidence: null, elapsedMs: 0,
              reason: "用户在扩展面板关闭了 API 通道；可在扩展图标 → API 通道开关中开启",
            };
            break;
          }
          const api = govHost.createHostDataApi({ enabled: true });
          out.data = await api.fetchSiteData(b.req || {});
          break;
        }
        case "gov.host.stats": out.data = hostApi.getStats(); break;

        /* --- API 通道用户开关（与控制台面板/扩展弹窗共用同一份状态） --- */
        case "api.channel.status": out.data = apiChannel.status(); break;
        case "api.channel.set": {
          /* 只读动作不拦急停，写开关也不拦：急停管"不再执行"，用户此刻更需要能关掉对外取数。 */
          const r = apiChannel.setEnabled(b.enabled === true, { by: "panel" });
          try { log(`[api-channel] 控制台开关 → ${r.enabled ? "开" : "关"}（persisted=${r.persisted}）`); } catch {}
          out.data = r;
          break;
        }
        case "gov.seal.review": out.data = await sealReview.reviewPlan(b.plan || {}, b.findings || []); break;
        case "gov.seal.context": out.data = govSeal.buildContextBag(b.req || {}); break;
        case "gov.verify.stage": out.data = govVerify.checkStage(b.stage, b.observed || []); break;
        case "gov.verify.lite": out.data = govVerify.verifyLite(b.evidence || {}); break;
        case "gov.verify.claim": out.data = govVerify.claimDone(b.req || {}); break;
        case "gov.channel.read": out.data = govChannel.readAll(); break;
        case "gov.channel.commit": { if (guardStop()) break; out.data = govChannel.commit(b.patch || {}, b.expectedRev); break; }
        case "gov.channel.dispatch": { if (guardStop()) break; out.data = govChannel.writeDispatch(b.packet || {}, b.expectedRev); break; }
        case "gov.channel.repair": { if (guardStop()) break; out.data = govChannel.appendRepair(b.entry || {}, b.expectedRev); break; }
        case "gov.channel.cost": out.data = govChannel.broadcastCost(b.messages || [], b.members || []); break;

        /* --- 策略变更优雅收敛：与带外急停分路，绝不 bumpEpoch --- */
        case "policy.kinds": out.data = POLICY_CHANGE_KINDS; break;
        case "policy.phases": out.data = POLICY_PHASES; break;
        case "policy.state": out.data = { ...policyTransition.state(), stopEpoch: STOP.epoch, stopLike: policyTransition.isStopLike() }; break;
        case "policy.propose": out.data = policyTransition.propose(b.change || {}); break;
        case "policy.notice": out.data = drainPlan(b.change || {}); break;
        case "policy.guard": out.data = assertSeparateFromStop(b.change || {}); break;
        case "policy.checkpoint": { if (guardStop()) break; out.data = policyTransition.checkpoint(b.ticketId, b.snapshot ?? null); break; }
        case "policy.quiesce": { if (guardStop()) break; out.data = policyTransition.quiesce(b.ticketId, b.outcome || "clean"); break; }
        case "policy.commit": { if (guardStop()) break; out.data = policyTransition.commit(); break; }
        case "policy.rollback": out.data = policyTransition.rollback(b.reason || ""); break;
        case "policy.reject": out.data = policyTransition.reject(b.reason || ""); break;
        case "policy.stats": out.data = policyTransition.stats(); break;

        /* --- 离线记忆整理层（Dreaming）：只在空闲时跑，不可信输入不进记忆 --- */
        case "dream.consolidate": out.data = dream.consolidate(b.entries || [], b.ctx || {}); break;
        case "dream.verify": out.data = dream.verify(b.id, b.evidence || ""); break;
        case "dream.index": out.data = dream.rebuildIndex(); break;
        case "dream.preload": out.data = dream.preloadFor(b.topic || ""); break;
        case "dream.stats": out.data = { ...dream.stats(), prefix: UNVERIFIED_PREFIX, quota: DEFAULT_QUOTA }; break;
        case "dream.snapshot": out.data = dream.snapshot(); break;

        /* --- 动态记忆预算（仅 Max 模式；普通模式零开销） --- */
        case "budget.modes": out.data = BUDGET_MODES; break;
        case "memory.budget": out.data = budgetFor(b.mode || "normal", b.opts || {}); break;
        case "memory.setMode": out.data = memoryBudget.setMode(b.mode || "normal"); break;
        case "memory.allocate": out.data = memoryBudget.allocate(b.entries || [], b.ctx || {}); break;
        case "memory.observe": out.data = memoryBudget.observe(b.usage); break;
        case "memory.stats": out.data = memoryBudget.stats(); break;
        case "memory.snapshot": out.data = memoryBudget.snapshot(); break;

        /* --- 插件生成物闸门：三段式声明式验收 + restart-required 不算成功 --- */
        case "artifact.codes": out.data = GATE_CODES; break;
        case "artifact.validate": out.data = artifactGate.validate(b.artifact || {}, b.ctx || {}); break;
        case "artifact.accept": { if (guardStop()) break; out.data = await artifactGate.accept(b.artifact || {}, b.ctx || {}); break; }
        case "artifact.reverify": { if (guardStop()) break; out.data = await artifactGate.reverify(b.artifact || {}, b.ctx || {}); break; }
        case "artifact.stats": out.data = artifactGate.stats(); break;

        default: out = { ok: false, action: a, error: "unknown action" };
      }
    } catch (e) {
      out = { ok: false, action: a, error: String(e?.message ?? e) };
    }
    send(res, 200, out);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/cmd") {
    const body = await readBody(req);
    /* 止血：命令通道原先绕过了 callToolRaw 的急停检查点，急停期间照样能写盘/起进程。 */
    const gate = commandGate.check(body);
    if (!gate.ok) { send(res, gate.httpStatus, gate.body); return; }
    try {
      if (!body.write && !body.launch && !body.openWith && !body.copy && !body.move && !body.rename) {
        send(res, 400, { ok: false, error: "命令通道需要 write / openWith / launch / copy / move / rename 至少一项" });
        return;
      }
      /* 危险闸门：硬闸（move/rename/copy+overwrite）+ 可配置 DANGER，统一走 commandChannelDanger。
         注意：move/rename 的 args 无 command/path，白名单匹配不到 —— 永远会问，正是要的"难拦截"。 */
      const d = commandChannelDanger(body);
      if (d.danger && !isWhitelisted("CommandChannel", d.args)) {
        const a = await waitApproval("windows", "CommandChannel", d.args);
        if (!a.allow) {
          send(res, 200, { ok: false, needConfirm: true, approved: false,
            error: "命令通道操作已被拒绝：" + (a.reason || "用户未确认") + (d.reason ? `（${d.reason}）` : "") });
          return;
        }
      }
      if (!commandGate.verify(gate.cap)) {
        send(res, 409, { ok: false, stopped: true, epoch: STOP.epoch, error: "签发后急停，命令未执行" });
        return;
      }
      const result = await runCommandOp(body);
      const stale = !commandGate.verify(gate.cap);
      if (stale) {
        /* 副作用已经发生（文件/进程不可回滚），所以只拒绝采纳结果并如实上报，
           不假装"没执行"。这就是为什么入口 409 才是最关键的一道闸。 */
        send(res, 409, { ok: false, stopped: true, epoch: STOP.epoch,
          error: "执行期间急停：副作用可能已产生，结果不采纳" });
        return;
      }
      noteLaunched(result);
      logBus.write({ category: "tool", level: "info", epoch: STOP.epoch,
        message: `命令通道：${Object.keys(body).filter((k) => ["write", "launch", "openWith", "copy", "move", "rename"].includes(k)).join(",")}` });
      send(res, 200, {
        ok: true, written: result.written, launched: result.launched,
        copied: result.copied, moved: result.moved, renamed: result.renamed,
      });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 任务规划：判断一段任务描述该走「命令通道」还是「视觉循环」。
   * 只做决策、不执行 —— 面板/上层可先问一嘴，再决定调 /api/act 还是跑视觉。
   * 返回 { via:'command'|'vision', confidence, intent, reason, rule }。 */
  if (req.method === "POST" && url.pathname === "/api/plan") {
    const body = await readBody(req);
    try {
      const text = String(body.text || body.task || "");
      if (!text.trim()) {
        send(res, 400, { ok: false, error: "需要 text/task" });
        return;
      }
      send(res, 200, await planTaskProbed(text, prober));
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 自由路由：桌面动作「优先命令通道，失败回落 GUI 模拟」。
   * body.intent 可以是：
   *   · 结构化对象 { op:'open'|'launch'|'write', app?, command?, filePath?, content?, args? }
   *   · 或一句文本（"用 notepad 打开 a.txt"），由 freeTier.parseOpenIntent 解析
   * 危险操作闸门复用 /api/cmd 的同款机制（DANGER_TOOLS / waitApproval）。 */
  if (req.method === "POST" && url.pathname === "/api/act") {
    const body = await readBody(req);
    const gate = commandGate.check(body);
    if (!gate.ok) { send(res, gate.httpStatus, gate.body); return; }
    try {
      /* mode:"auto"：先分类再决定。能给命令通道做就做；做不了就明确回 via:'vision'，
         让调用方去跑视觉循环，而不是在这里瞎猜一个命令。 */
      const autoText = (body.mode === "auto" || body.auto === true)
        ? String(body.text || body.task || (typeof body.intent === "string" ? body.intent : "")).trim()
        : "";
      if (autoText) {
        const plan = await planTaskProbed(autoText, prober);
        if (plan.via !== "command") {
          send(res, 200, { ok: true, via: "vision", plan });
          return;
        }
        body.intent = plan.intent;   // 命中高置信命令化，落到下面命令通道执行
      }
      const intent = typeof body.intent === "string"
        ? freeTier.parseOpenIntent(body.intent)
        : (body.intent || null);
      if (!intent) {
        send(res, 400, { ok: false, error: "需要 intent（结构化对象，或 '用 X 打开 Y' 文本）" });
        return;
      }
      // 先算命令通道的操作体，做危险操作闸门（与 /api/cmd 同机制，含硬闸）
      const cmdOp = freeTier.intentToCmdOp(intent);
      const d = commandChannelDanger(cmdOp);
      if (d.danger && !isWhitelisted("CommandChannel", d.args)) {
        const a = await waitApproval("windows", "CommandChannel", d.args);
        if (!a.allow) {
          send(res, 200, { ok: false, needConfirm: true, approved: false,
            error: "命令通道操作已被拒绝：" + (a.reason || "用户未确认") + (d.reason ? `（${d.reason}）` : "") });
          return;
        }
      }
      if (!commandGate.verify(gate.cap)) {
        send(res, 409, { ok: false, stopped: true, epoch: STOP.epoch, error: "签发后急停，未执行" });
        return;
      }
      const r = await freeTier.route(intent);
      if (!commandGate.verify(gate.cap)) {
        send(res, 409, { ok: false, stopped: true, epoch: STOP.epoch,
          error: "执行期间急停：副作用可能已产生，结果不采纳" });
        return;
      }
      noteLaunched(r.result);
      send(res, 200, {
        ok: true, via: r.via, intent: r.intent, result: r.result,
        commandError: r.commandError || null,
      });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 自动化：录制 / 停止 / 状态 / 列表 / 回放 */
  if (req.method === "POST" && url.pathname === "/api/wf") {
    const body = await readBody(req);
    try {
      switch (body.action) {
        case "rec-start": {
          REC.on = true;
          REC.name = body.name || ("workflow_" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-"));
          REC.steps = [];
          REC.pendingWinCaps = [];       // 抗迁移：清空上一次的窗口抓取队列
          REC.startedAt = Date.now();
          /* 挂上全局鼠标钩子：这样"你手动在别的软件里点的/拖的/滚的"也能录进来。
             挂不上（缺模块 / 权限 / 杀软）就静默降级，面板的 F9 打点仍在。 */
          let hook = false;
          try {
            const m = await getMouseHook();
            if (m) {
              const r = m.startMouseHook({
                exclude: Array.isArray(body.exclude) ? body.exclude : [],
                onStep: (s) => {
                  if (!REC.on) return;
                  /* holdMs 是钩子对「按住维持」的实测时长。
                     不直接用 wait（那是步与步之间的自然间隔），
                     而是单独记下来，面板编辑时能显示「这一按维持了多久」。
                     回放侧不必特殊处理——press/release 本来就是两步。 */
                  const step = {
                    server: s.server, tool: s.tool, args: s.args,
                    wait: s.wait || 0, note: s.note || "", hook: true,
                  };
                  if (s.holdMs) step.holdMs = s.holdMs;
                  REC.steps.push(step);
                  /* 抗迁移：异步抓「点落在哪个窗口」，抓到了就把 step.win 挂上。
                     不影响录制节奏（fire-and-forget），rec-stop 会等它们收尾。 */
                  const pp = primaryPoint(step);
                  if (pp) {
                    const p = captureWinAt(pp[0], pp[1])
                      .then((anchor) => { if (anchor) step.win = anchor; })
                      .then(() => captureTreeRef(step))
                      .catch(() => {});
                    REC.pendingWinCaps.push(p);
                  }
                },
              });
              hook = !!(r && r.ok);
              if (!hook && r) log("[hook] 未挂载：", r.error);
            }
          } catch (e) {
            log("[hook] 挂载异常：", (e && e.message) || e);
          }
          send(res, 200, { ok: true, recording: true, name: REC.name, hook });
          break;
        }

        /* 手动打点：只**记录**、不执行。
           录制时用户按一下打点热键，面板读出当前鼠标坐标发过来。
           注意不能顺手真的点一下 —— 用户自己已经点过了，
           这里再点一次等于把动作做两遍。 */
        case "rec-step": {
          if (!REC.on) { send(res, 200, { ok: false, error: "当前没有在录制" }); break; }
          const tool = String(body.tool || "Click");
          const server = String(body.server || "windows");
          const step = { server, tool, args: body.args ?? {}, wait: 0 };
          REC.steps.push(step);
          const pp = primaryPoint(step);
          if (pp) {
            const p = captureWinAt(pp[0], pp[1])
              .then((anchor) => { if (anchor) step.win = anchor; })
              .then(() => captureTreeRef(step))
              .catch(() => {});
            REC.pendingWinCaps.push(p);
          }
          console.log(`[rec] 打点 +1（${tool} ${JSON.stringify(body.args ?? {})}），共 ${REC.steps.length} 步`);
          send(res, 200, { ok: true, steps: REC.steps.length });
          break;
        }

        case "rec-stop": {
          REC.on = false;
          // 先卸钩子，再结算步骤 —— 否则卸载瞬间的事件会漏进正在保存的数组
          try { const m = await getMouseHook(); if (m) m.stopMouseHook(); } catch { /* ignore */ }
          // 抗迁移：等窗口锚定抓取收尾，避免保存时 step.win 还没挂上
          try { await Promise.allSettled(REC.pendingWinCaps || []); } catch { /* ignore */ }
          REC.pendingWinCaps = [];
          const name = REC.name;
          const steps = dedupeRecSteps(REC.steps);
          if (!steps.length) {
            send(res, 200, { ok: false, error: "没有录到任何操作" });
            break;
          }
          /* 与 /api/wf 的 save 一致走原子写：录制产物正是最容易被强杀打断的
             那类写入，写坏一半 = 用户录了半天的自动化打不开。 */
          /* 录制会**静默覆盖**同名配方 —— 这正是「改坏没有回头路」最常发生的地方，
             所以覆盖前留一版。 */
          try { snapshotRecipeVersion(name, { note: "录制覆盖前自动留档", source: "rec-stop" }); } catch {}
          writeJsonAtomic(wfFile(name), { name, savedAt: Date.now(), gap: 700, steps });
          REC.steps = [];
          /* 顺带看一眼录制里有没有「同一段操作重复了 k 次」。
             只提示、不改结构 —— 用户录 3 段不一定是想循环，
             也可能就是三份内容不同的表。检测失败不影响录制结果。 */
          let repeatHint = null;
          try { repeatHint = detectRepeat(steps); } catch { /* 忽略 */ }
          send(res, 200, { ok: true, name, steps: steps.length, repeatHint });
          break;
        }

        case "status":
          send(res, 200, { ok: true, recording: REC.on, name: REC.name, steps: REC.steps.length });
          break;

        case "list":
          send(res, 200, { ok: true, workflows: wfList() });
          break;

        case "get": {
          try {
            const wf = JSON.parse(fsSync.readFileSync(wfFile(body.name), "utf8"));
            send(res, 200, { ok: true, workflow: wf });
          } catch (e) {
            send(res, 200, { ok: false, error: "读不到：" + (e?.message ?? e) });
          }
          break;
        }

        case "save": {
          const wf = Object.assign({}, body.workflow || {});
          wf.name = wf.name || body.name;
          if (!wf.name) { send(res, 200, { ok: false, error: "缺少自动化名称" }); break; }
          try {
            fsSync.mkdirSync(WORKFLOW_DIR, { recursive: true });
            /* 先留旧版本，再覆盖 —— 顺序不能反，反了就是把新内容存成快照。 */
            let rev = null;
            try {
              const next = JSON.stringify(wf, null, 2) + "\n";   // 与 writeJsonAtomic 完全同款
              const v = snapshotRecipeVersion(wf.name, { note: String(body.note || "保存前自动留档"), source: "save", next });
              rev = v.ok && !v.skipped ? v.rev : null;
            } catch { /* 留档失败不阻断保存：能存下来优先 */ }
            writeJsonAtomic(wfFile(wf.name), wf);
            send(res, 200, { ok: true, name: wf.name, steps: (wf.steps || []).length, rev });
          } catch (e) {
            send(res, 200, { ok: false, error: "保存失败：" + (e?.message ?? e) });
          }
          break;
        }

        /* 人工回放也走唯一点火入口，只是 layer=manual（不去重、不冷却）。
           返回契约保持 { ok, result }，面板 playWorkflow 不用改。 */
        case "play":
          send(res, 200, { ok: true, result: await fireWorkflow({
            name: body.name, layer: "manual", gap: body.gap, skipRead: body.skipRead === true,
            /* approved：人工节点 id 列表。不传 = 全部未批准（fail-closed）。 */
            approved: body.approved,
          }) });
          break;

        /* 自动点火：热键（main.js）、扩展、外部脚本统一从这里进。 */
        case "fire": {
          const r = await fireWorkflow({
            name: body.name, triggerId: body.triggerId || "",
            layer: body.layer || "trigger", dedupeKey: body.dedupeKey || "",
            gap: body.gap, skipRead: body.skipRead === true,
            approved: body.approved,
          });
          if (!r.ok) { send(res, 200, { ok: false, code: r.code || "play-failed", run: r.run || null }); break; }
          send(res, 200, { ok: true, runId: r.runId, ticketId: r.ticketId, result: r });
          break;
        }

        /* 执行历史：可观测性是账本的另一半，供面板/排障直接查。 */
        case "runs":
          send(res, 200, { ok: true,
            runs: wfRuns.list({ limit: body.limit || 50, triggerId: body.triggerId || "",
              status: body.status || "", reviewState: body.reviewState || "" }),
            stats: wfRuns.stats() });
          break;

        /* 待复核队列：needs_review 的出口。没有它，用户永远不知道还剩几条没看。 */
        case "review-queue":
          send(res, 200, Object.assign({ ok: true },
            wfRuns.reviewQueue({ scope: body.scope || "pending", limit: body.limit || 50 })));
          break;

        /* 标记已复核。注意它**不改判** —— status / verdict 原样保留，
           只记"谁在什么时候看过、看完怎么认"。理由见 wfRunLedger 里那段注释：
           一旦用人的判断覆盖 verdict，autoPolicy 就又拿主观结论当零退化样本了。 */
        case "review": {
          const r = wfRuns.markReviewed(String(body.runId || ""), {
            by: body.by || "user", verdict: body.reviewVerdict || body.verdict || "accepted",
            note: body.note || "",
          });
          send(res, 200, r.ok ? { ok: true, run: r.run } : { ok: false, error: r.error });
          break;
        }

        case "unreview": {
          const r = wfRuns.unreview(String(body.runId || ""));
          send(res, 200, r.ok ? { ok: true, run: r.run } : { ok: false, error: r.error });
          break;
        }

        /* 步级轨迹：运行级账本回答「跑完没有」，这里回答「断在第几步、为什么」。
           一个运行一个 jsonl，按 runId 直接读，不扫全表。 */
        case "trace":
          send(res, 200, { ok: true, runId: String(body.runId || ""),
            entries: wfTrace.read(String(body.runId || ""), body.limit || 500) });
          break;

        case "trace-runs":
          send(res, 200, { ok: true, runs: wfTrace.listRuns(), stats: wfTrace.stats() });
          break;

        /* 配方版本：列出 / 取某一版 / 比对 / 回滚。
           回滚本身也会先给"当前内容"留一版 —— 回滚必须是可再回滚的，
           否则按错一次就彻底回不去，等于把一个坑换成另一个坑。 */
        case "versions":
          send(res, 200, { ok: true, name: String(body.name || ""),
            items: wfRevs.list(wfSafeName(body.name)) });
          break;

        case "version-get": {
          const v = wfRevs.get(wfSafeName(body.name), body.rev);
          send(res, 200, v ? { ok: true, version: v, parsed: safeParse(v.body) }
            : { ok: false, error: "版本不存在" });
          break;
        }

        case "version-diff":
          send(res, 200, wfRevs.diff(wfSafeName(body.name), body.from, body.to));
          break;

        case "version-rollback": {
          const nm = String(body.name || "");
          if (!nm) { send(res, 200, { ok: false, error: "缺少名称" }); break; }
          const r = wfRevs.rollback(wfSafeName(nm), body.rev);
          if (!r.ok) { send(res, 200, { ok: false, error: r.error }); break; }
          try {
            snapshotRecipeVersion(nm, {
              note: `回滚到 rev ${r.rev} 前的自动留档`, source: "rollback",
              next: JSON.stringify(r.parsed, null, 2) + "\n",
            });
            writeJsonAtomic(wfFile(nm), r.parsed);
            send(res, 200, { ok: true, name: nm, rev: r.rev, steps: (r.parsed.steps || []).length });
          } catch (e) {
            send(res, 200, { ok: false, error: "回滚写入失败：" + (e?.message ?? e) });
          }
          break;
        }

        /* 编排图校验：存之前先照一遍结构，把环 / 悬空边 / 缺字段挡在保存口，
           而不是等点到「运行」才炸。只校验，不执行。 */
        case "graph-validate":
          send(res, 200, validateGraph(body.graph));
          break;

        /* 判据建议：只读，不改配方。让人看见「这条为什么会需复核」，
           并给一份能直接用的判据候选。 */
        case "outcome-suggest": {
          const nm = String(body.name || "");
          let wf2 = null;
          try { wf2 = JSON.parse(fsSync.readFileSync(wfFile(nm), "utf8")); }
          catch { send(res, 200, { ok: false, error: "读不到自动化：" + nm }); break; }
          const s = suggestOutcomes(wf2, { isReadOnly });
          send(res, 200, { ok: true, name: nm, ...s });
          break;
        }

        /* 界面证据候选：上次运行前后控件树新增了哪些行。
           机器只负责取证 —— 哪一行算"成功提示"只有人知道，所以这里列候选、不写判据。 */
        case "outcome-evidence": {
          const nm = String(body.name || "");
          if (!nm) { send(res, 200, { ok: false, error: "缺少名称" }); break; }
          let runId = String(body.runId || "");
          if (!runId) {
            const lastRun = wfRuns.list({ limit: 300 }).find((r) => r.workflow === nm && r.status !== "running");
            runId = lastRun ? lastRun.runId : "";
          }
          if (!runId) {
            send(res, 200, { ok: false, error: "这条自动化还没有跑完过 —— 先跑一次，才谈得上「界面上多出了什么」" });
            break;
          }
          let endEntry = null;
          for (const e of wfTrace.read(runId, 2000)) if (e.t === "end") endEntry = e;
          if (!endEntry) {
            send(res, 200, { ok: false, error: "这次运行没有结束记录（还在跑，或轨迹已按 TTL 清理）" });
            break;
          }
          const lines = Array.isArray(endEntry.evidenceLines) ? endEntry.evidenceLines : [];
          send(res, 200, { ok: true, name: nm, runId, lines,
            reason: String(endEntry.evidenceReason || (lines.length ? "" : "这次运行没有留下界面证据（可能没做探测）")) });
          break;
        }

        /* 把选中的判据写进配方。和手动保存走同一条路：
           先留版本快照再原子写，所以"写坏了"照样能回滚。 */
        case "outcome-apply": {
          const nm = String(body.name || "");
          if (!nm) { send(res, 200, { ok: false, error: "缺少名称" }); break; }
          let wf3 = null;
          try { wf3 = JSON.parse(fsSync.readFileSync(wfFile(nm), "utf8")); }
          catch { send(res, 200, { ok: false, error: "读不到自动化：" + nm }); break; }
          const built = buildOutcome(
            (Array.isArray(body.postconditions) ? body.postconditions : []).map((p) => ({ postcondition: p })),
            { max: body.max },
          );
          if (!built.postconditions.length) {
            send(res, 200, { ok: false, error: "没有可写入的有效判据（kind 必须是 tree_state / window_state / data_readback / effect_evidence）" });
            break;
          }
          wf3.outcome = Object.assign({}, wf3.outcome || {}, { postconditions: built.postconditions });
          try {
            fsSync.mkdirSync(WORKFLOW_DIR, { recursive: true });
            const next = JSON.stringify(wf3, null, 2) + "\n";
            snapshotRecipeVersion(nm, { note: "写入判据前自动留档", source: "outcome-apply", next });
            writeJsonAtomic(wfFile(nm), wf3);
            send(res, 200, { ok: true, name: nm, postconditions: built.postconditions });
          } catch (e) {
            send(res, 200, { ok: false, error: "写入失败：" + (e?.message ?? e) });
          }
          break;
        }

        /* 断点查询：只读。面板据此决定「从断点续跑」这个按钮出不出。 */
        case "checkpoint":
          send(res, 200, Object.assign({ name: String(body.name || "") }, resumeStatusOf(body.name)));
          break;

        /* 回放前预检：动手之前先对着当前界面把锚点核一遍，别等跑废前四步才发现第 5 步没了。
           返回里 ok 一律是「接口调用成功」，预检结论在 passed / summary / findings 里 ——
           两个 ok 混用的话，面板会把"预检不通过"当成"请求失败"。 */
        case "preflight": {
          const nm = String(body.name || "");
          if (!nm) { send(res, 200, { ok: false, error: "缺少名称" }); break; }
          let wfp = null;
          try { wfp = JSON.parse(fsSync.readFileSync(wfFile(nm), "utf8")); }
          catch { send(res, 200, { ok: false, error: "读不到自动化：" + nm }); break; }
          let snapText = null;
          if (body.noSnapshot !== true) {
            try { snapText = await getSnapshotText(8000); } catch { snapText = null; }
          }
          let rp = null;
          try {
            rp = preflightWf(wfp, snapText, {
              fromIndex: Number(body.fromIndex) || 0,
              workflows: wfList().map((x) => x.name),
            });
          } catch (e) {
            send(res, 200, { ok: false, error: "预检执行失败：" + (e?.message ?? e) });
            break;
          }
          const { ok: passed, ...rest } = rp;
          send(res, 200, Object.assign(
            { ok: true, name: nm, passed, summary: summarizePreflight(rp) }, rest));
          break;
        }

        /* 断点续跑。安全门不过就明确拒绝并说明原因 ——
           拒绝时绝不"退化成从头跑"：那会把做过的不可逆动作再做一遍，
           正是这个功能存在的理由。 */
        case "resume": {
          const st = resumeStatusOf(body.name);
          if (!st.ok || !st.resumable) {
            send(res, 200, { ok: false, code: st.code || "not_resumable",
              error: st.reason || "这条配方当前不能从断点续跑", checkpoint: st.checkpoint || null });
            break;
          }
          const r = await fireWorkflow({
            name: body.name, layer: "manual", gap: body.gap,
            approved: body.approved, resumeFrom: st.nextIndex,
          });
          send(res, 200, { ok: !!r.ok, result: r,
            resumedFrom: st.nextIndex, checkpoint: st.checkpoint || null });
          break;
        }

        /* 升降级判据：每条自动化的样本数、退化计数、建议模式与理由。 */
        case "policy":
          send(res, 200, { ok: true,
            items: wfList().map((w) => ({ name: w.name, ...policyFor(w.name) })),
            triggers: triggers.map((t) => ({ id: t.id, workflow: t.workflow,
              mode: t.mode === "observe" ? "observe" : "auto", locked: !!t.modeLocked, enabled: t.enabled !== false })) });
          break;

        case "policy-apply":
          send(res, 200, { ok: true, transitions: applyPolicies() });
          break;

        /* 自动化 › 回收站：列表与手动清理（不在启动时偷偷删用户数据）。 */
        case "trash":
          send(res, 200, { ok: true, items: wfTrash.list() });
          break;

        case "purge":
          send(res, 200, { ok: true, ...wfTrash.sweep({ ttlMs: body.ttlMs, max: body.max }) });
          break;

        /* 删除 = 移入回收站 + 停用引用它的触发器。
         * 「输入删除两字」是通用词确认：只加摩擦不加信息，用户会背成肌肉记忆；
         * 改成两个按钮的前提是把操作真正做成可逆的（撤销窗口 + 回收站）。
         * 触发器必须一起停用：留着 enabled 的触发器指向已删的菜谱，
         * 只会在半夜点火时抛「读不到自动化」，是最难查的一类悬空引用。 */
        case "delete": {
          /* 先查子流程引用：删掉被引用的配方，引用方要到运行时才炸。
             不直接拒绝死 —— 两条一起删是合理需求，所以给 force 一条路，
             但第一次必须先让人看清楚是谁在引用、在哪一步引用。 */
          const referrers = subflowReferrersOf(body.name);
          if (referrers.length && body.force !== true) {
            send(res, 200, {
              ok: false, code: "referenced", referrers,
              error: "有配方还在调用它，删掉之后那些配方回放时会当场报错："
                + referrers.map((x) => `「${x.name}」(${x.where.join("、")})`).join("；"),
            });
            break;
          }
          const key = wfSafeName(body.name);
          const r = wfTrash.remove(key);
          if (!r.ok) { send(res, 200, { ok: false, error: "删除失败：" + r.error }); break; }
          let disabledTriggers = 0;
          try {
            for (const t of triggers) {
              if (t && wfSafeName(t.workflow) === key && t.enabled !== false) {
                t.enabled = false;
                t.disabledBy = "wf-delete";   // 撤销只恢复这类，不误开用户手动关掉的
                disabledTriggers++;
              }
            }
            if (disabledTriggers) { saveTriggers(); armTriggers(); }
          } catch (e) { console.log("[wf] 停用关联触发器失败：", e?.message ?? e); }
          send(res, 200, { ok: true, name: r.name, trashId: r.trashId,
            steps: r.steps, disabledTriggers, undoable: true });
          break;
        }

        /* 撤销：从回收站移回，并把因这次删除而停用的触发器重新武装。 */
        case "restore": {
          const r = wfTrash.restore(body.trashId);
          if (!r.ok) { send(res, 200, { ok: false, error: "撤销失败：" + r.error }); break; }
          let enabledTriggers = 0;
          try {
            const key = wfSafeName(r.name);
            for (const t of triggers) {
              if (t && t.disabledBy === "wf-delete" && wfSafeName(t.workflow) === key) {
                t.enabled = true;
                delete t.disabledBy;
                enabledTriggers++;
              }
            }
            if (enabledTriggers) { saveTriggers(); armTriggers(); }
          } catch (e) { console.log("[wf] 恢复关联触发器失败：", e?.message ?? e); }
          send(res, 200, { ok: true, name: r.name, enabledTriggers });
          break;
        }

        default:
          send(res, 200, { ok: false, error: "未知 action：" + body.action });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 触发器：定时 / 文件变化（热键由 main.js 注册，不在此列） */
  if (req.method === "POST" && url.pathname === "/api/triggers") {
    const body = await readBody(req);
    try {
      switch (body.action) {
        case "list":
          send(res, 200, { ok: true, triggers });
          break;

        case "add": {
          const t = Object.assign({}, body.trigger || {});
          if (!t.workflow) { send(res, 200, { ok: false, error: "缺少 workflow" }); break; }
          t.id = t.id || ("t" + Date.now().toString(36));
          t.enabled = t.enabled !== false;
          /* 新触发器默认 observe（只记录不执行），攒够干净样本才由判据升 auto。 */
          t.mode = t.mode === "auto" ? "auto" : "observe";
          triggers.push(t);
          saveTriggers();
          armTriggers();
          send(res, 200, { ok: true, trigger: t });
          break;
        }

        case "remove":
          triggers = triggers.filter((x) => x.id !== body.id);
          saveTriggers();
          armTriggers();
          send(res, 200, { ok: true });
          break;

        /* 手动设定 observe / auto：默认加 modeLocked，系统不再自动改人的决定。 */
        case "mode": {
          const t = triggers.find((x) => x.id === body.id);
          if (!t) { send(res, 200, { ok: false, error: "触发器不存在" }); break; }
          t.mode = body.mode === "auto" ? "auto" : "observe";
          t.modeLocked = body.locked !== false;
          saveTriggers();
          armTriggers();
          send(res, 200, { ok: true, trigger: t });
          break;
        }

        case "toggle": {
          const t = triggers.find((x) => x.id === body.id);
          if (t) { t.enabled = !t.enabled; saveTriggers(); armTriggers(); }
          send(res, 200, { ok: true, trigger: t || null });
          break;
        }

        case "reload":
          loadTriggers();
          armTriggers();
          send(res, 200, { ok: true, armed: triggerHandles.size });
          break;

        default:
          send(res, 200, { ok: false, error: "未知 action：" + body.action });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 急停开关：自动化跑飞时救命用。GET 也支持，方便热键/外部脚本直接打。 */
  /* 急停收场清单（只读）：把 doStop 已经算好的四个数字 + 受影响工单 + 可续跑候选
     一次性给面板。不新造数据、不编数，全部来自现有账本。 */
  if (req.method === "GET" && url.pathname === "/api/stop/report") {
    const all = ticketStore.list({ limit: 200 });
    const open = ticketStore.list({ limit: 200, open: true });
    const affected = all.filter((t) => t.stale || t.status === "aborted" || t.status === "stopped");
    send(res, 200, {
      ok: true,
      stop: { on: STOP.on, epoch: STOP.epoch, at: STOP.at, reason: STOP.reason },
      last: LAST_STOP_REPORT,
      openTickets: open.length,
      affected: affected.slice(0, 20).map((t) => ({
        id: t.id, title: t.title, status: t.status, stale: !!t.stale,
        reason: t.reason, endedAt: t.endedAt, epoch: t.epoch,
      })),
      /* 可续跑：被急停判陈旧但还没进终态的，resumeTicket 会认。 */
      resumable: all.filter((t) => t.stale && !["done", "failed", "dropped", "aborted", "stopped"].includes(t.status))
        .slice(0, 20).map((t) => ({ id: t.id, title: t.title, epoch: t.epoch })),
    });
    return;
  }
  if (url.pathname === "/api/stop") {
    try {
      let action = "status", reason = "", body = {};
      if (req.method === "POST") {
        body = await readBody(req);
        /* 兼容 query：`POST /api/stop?action=stop` 是很自然的手工调用方式，
         * 原来只有 GET 认 query，POST 一律回 status ——
         * 排查时按了没反应，会误以为"急停坏了"。 */
        action = body.action || url.searchParams.get("action") || "status";
        reason = body.reason || url.searchParams.get("reason") || "";
      } else {
        const q = url.searchParams.get("action");
        if (q) action = q;
      }
      if (action === "stop") send(res, 200, { ok: true, stop: doStop(reason) });
      else if (action === "resume") send(res, 200, { ok: true, stop: doResume() });
      /* 11-07 简报 §3.4：策略变更与带外急停必须是两条不同路径。
       * 这个分支只投递收敛通知，绝不调用 doStop / bumpEpoch，也不杀任何在途进程；
       * 在途 ticket 由 /api/ops 的 policy.checkpoint → policy.quiesce → policy.commit 收尾。 */
      else if (action === "policy-change" || action === "policy-propose") {
        const change = {
          id: String(body.id || body.policyId || url.searchParams.get("id") || ("policy-" + Date.now())),
          kind: String(body.kind || url.searchParams.get("kind") || "rule"),
          tickets: Array.isArray(body.tickets) ? body.tickets : String(url.searchParams.get("tickets") || "").split(",").filter(Boolean),
          summary: String(body.summary || reason || ""),
        };
        const r = policyTransition.propose(change);
        send(res, 200, { ok: r.ok, policy: r, stopEpoch: STOP.epoch,
          stopLike: policyTransition.isStopLike(), note: "策略变更未触发急停；STOP.epoch 保持不变" });
      }
      else if (action === "policy-status") {
        send(res, 200, { ok: true, policy: policyTransition.state(), stopEpoch: STOP.epoch,
          stopLike: policyTransition.isStopLike() });
      }
      else send(res, 200, { ok: true, stop: { on: STOP.on, at: STOP.at, reason: STOP.reason, epoch: STOP.epoch } });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 危险操作确认：面板轮询 pending 列表，用户点允许/拒绝 */
  if (url.pathname === "/api/confirm") {
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        const done = resolveApproval(body.id, !!body.allow, body.reason, body.remember, {
          correction: body.correction, ticketId: body.ticketId, replan: !!body.replan,
        });
        send(res, 200, { ok: done, error: done ? undefined : "确认项不存在或已超时" });
      } else {
        send(res, 200, {
          ok: true, pending: listPending(),
          dangerous: [...DANGER_TOOLS], whitelist: whiteList,
          dangerRules: { tools: [...DANGER.tools], args: DANGER.args },
        });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 全局鼠标钩子状态：面板据此决定"要不要教用户按 F9" */
  if (req.method === "GET" && url.pathname === "/api/hook") {
    try {
      const m = await getMouseHook();
      send(res, 200, Object.assign({ ok: true }, m ? m.hookState() : { available: false, error: "模块未加载" }));
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 前台通道自检 / 一键修复 */
  if (url.pathname === "/api/repair") {
    try {
      if (req.method === "GET") {
        send(res, 200, { ok: true, health: frontHealth() });
        return;
      }
      if (req.method === "POST") {
        log("[repair] 收到前台通道修复请求");
        const r = await repairFront();
        send(res, 200, r);
        return;
      }
      send(res, 405, { ok: false, error: "method not allowed" });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 危险清单管理：读 / 写 danger-tools.json */
  /* 方案 D：运行时配置（面板「安全」页的「写操作人工确认」实体开关读写这里） */
  if (url.pathname === "/api/runtime") {
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        if (typeof body.confirmWrites === "boolean") RUNTIME_CONF.confirmWrites = body.confirmWrites;
        saveRuntimeConf();
        console.log("[runtime] 写操作人工确认 =", RUNTIME_CONF.confirmWrites ? "开" : "关");
      }
      send(res, 200, { ok: true, confirmWrites: !!RUNTIME_CONF.confirmWrites });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  if (url.pathname === "/api/danger") {
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        if (Array.isArray(body.tools)) DANGER.tools = body.tools.map(String).filter(Boolean);
        if (body.args && typeof body.args === "object") DANGER.args = body.args;
        DANGER_TOOLS.clear();
        for (const t of DANGER.tools) DANGER_TOOLS.add(t);
        saveDanger();
        console.log("[danger] 清单更新：tools =", DANGER.tools.join(", ") || "(空)");
      }
      send(res, 200, { ok: true, tools: [...DANGER.tools], args: DANGER.args, defaults: structuredClone(DANGER_DEFAULTS) });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 危险操作白名单管理 */
  if (url.pathname === "/api/whitelist") {
    try {
      if (req.method === "POST") {
        const body = await readBody(req);
        if (body.action === "add") {
          const pattern = String(body.pattern || "").trim();
          if (!pattern) { send(res, 200, { ok: false, error: "缺少 pattern" }); return; }
          const mode = body.mode === "prefix" ? "prefix" : "exact";
          const tool = body.tool || "PowerShell";
          if (!whiteList.some((w) => w.tool === tool && w.mode === mode && w.pattern === pattern)) {
            whiteList.push({ tool, mode, pattern, addedAt: Date.now() });
            saveWhiteList();
          }
          send(res, 200, { ok: true, whitelist: whiteList });
        } else if (body.action === "remove") {
          whiteList = whiteList.filter((w) => !(w.pattern === body.pattern && w.mode === body.mode));
          saveWhiteList();
          send(res, 200, { ok: true, whitelist: whiteList });
        } else {
          send(res, 200, { ok: true, whitelist: whiteList });
        }
      } else {
        send(res, 200, { ok: true, whitelist: whiteList });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 智能接管回报：面板跑完一轮视觉会话后回到这里，结算挂起的 promise。
     没人在等（超时已过 / 两轮撞车）就返回 stale，让面板知道这一轮白跑了，
     不必再重试——重试只会把已经走远的流程再拉回来一次。 */
  if (req.method === "POST" && url.pathname === "/api/agent-done") {
    const body = await readBody(req);
    const ok = settleAgent(body);
    if (!ok) log("[agent] 收到迟到的接管回报，已丢弃");
    send(res, 200, { ok: true, stale: !ok });
    return;
  }

  /* 执行状态（AI 步骤可视化）+ 执行审计日志 */
  if (url.pathname === "/api/live" || url.pathname === "/api/audit") {
    try {
      if (url.pathname === "/api/live") {
        send(res, 200, {
          ok: true,
          live: LIVE,
          stop: { on: STOP.on, reason: STOP.reason },
        });
      } else {
        const limit = Math.max(1, Math.min(AUDIT_MEM_MAX, Number(url.searchParams.get("limit") || 100)));
        send(res, 200, { ok: true, entries: AUDIT_MEM.slice(-limit).reverse() });
      }
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /*
   * 视觉模型代理。
   *
   * 为什么必须放在这里：面板是 file:// 页面，浏览器会把对
   * https://api.deepseek.com 之类的请求当作跨域，而这些 API 都不发
   * Access-Control-Allow-Origin，渲染进程直接被 CORS 拦死。
   * Node 侧 fetch 没有这个限制，所以由 bridge 代发。
   *
   * 密钥只在本进程内存里过一遍，不落盘、不写日志。
   */
  if (req.method === "POST" && url.pathname === "/api/vlm") {
    const body = await readBody(req);
    const baseUrl = String(body.baseUrl || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    const model = String(body.model || "").trim();
    if (!baseUrl || !model) {
      send(res, 200, { ok: false, error: "缺少 baseUrl 或 model" });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Number(body.timeoutMs) || 180000);
    const started = Date.now();
    try {
      const r = await fetch(baseUrl.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: body.messages ?? [],
          max_tokens: Number(body.maxTokens) || 1024,
          temperature: body.temperature === undefined ? 0 : body.temperature,
          // 厂商私有参数透传。典型用途：Qwen3.5 是 hybrid-thinking 模型，
          // 默认会先吐思考过程，污染 JSON 解析，需要 enable_thinking:false。
          ...(body.extra && typeof body.extra === "object" ? body.extra : {}),
        }),
        signal: ctrl.signal,
      });
      const text = await r.text();
      send(res, 200, {
        ok: r.ok,
        status: r.status,
        ms: Date.now() - started,
        body: text.slice(0, 400000),
      });
    } catch (err) {
      send(res, 200, { ok: false, status: 0, error: String(err?.message ?? err) });
    } finally {
      clearTimeout(t);
    }
    return;
  }

  /* 列出该端点可用模型，方便用户找对视觉模型的名字。
     预置里的模型名可能过时，用它查真实清单最靠谱。 */
  if (req.method === "POST" && url.pathname === "/api/vlm/models") {
    const body = await readBody(req);
    const baseUrl = String(body.baseUrl || "").trim();
    const apiKey = String(body.apiKey || "").trim();
    if (!baseUrl) {
      send(res, 200, { ok: false, error: "缺少 baseUrl" });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(baseUrl.replace(/\/+$/, "") + "/models", {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        signal: ctrl.signal,
      });
      const text = await r.text();
      let ids = [];
      if (r.ok) {
        try {
          const j = JSON.parse(text);
          ids = (j.data || j.models || [])
            .map((m) => m.id || m.name || m.model)
            .filter(Boolean);
        } catch {}
      }
      send(res, 200, { ok: r.ok, status: r.status, ids, body: r.ok ? "" : text.slice(0, 400) });
    } catch (err) {
      send(res, 200, { ok: false, status: 0, error: String(err?.message ?? err) });
    } finally {
      clearTimeout(t);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/dispatch") {
    const body = await readBody(req);
    const server = body.server ?? "workbuddy";
    const tool = body.tool ?? "workbuddy_execute";
    /* 急停期间不再新建后台任务（STOP_EXEMPT 已移除 workbuddy_execute）。
     * 这里**提前**拦并给出 409：否则会先返回一个 jobId、几十毫秒后才在流里报错，
     * 面板上表现为"任务创建成功然后立刻失败"，比直接拒绝更难理解。 */
    if (STOP.on && !stopExempt(server, tool)) {
      /* stopped:true 是给面板的判别位：急停拒单**不是任务失败**，
       * 面板据此跳过失败统计与人格失败台词，只提示"先恢复再发"。 */
      send(res, 409, { ok: false, stopped: true, error: `已被急停（${STOP.reason || "手动"}，第 ${STOP.epoch} 代），不再新建任务`, epoch: STOP.epoch });
      return;
    }
    /* 幂等（2026-11-05）：派新任务是最贵的一类副作用，重复派发等于账单翻倍。
     * 调用方带 idempotencyKey 时：
     *   · 这个 key 上次已经结算过 → 直接把它上次的 jobId 还回去，**不再新建**；
     *   · 上次还没跑完（重复点击/超时重发）→ 409，让调用方等那一次，而不是并行再开一份；
     *   · 没带 key → 保持原行为（不惩罚不传的人，但也就没有这层保护）。
     * 这个 key 必须是"一次用户意图一个"，不能由服务端按参数哈希生成 ——
     * 哈希会把"用户确实想再发一次同样的话"误判成重复。 */
    /* 专家契约：派发口是最经济的一道闸 —— 在这里拒，比让一个只读专家
     * 跑到工具层再被拒要好：省一次冷启动、省一次计费、日志里也只有一条。 */
    const arbD = arbitrateExpert(body.expertId, {
      server, tool,
      readOnly: READ_ONLY_TOOLS.has(`${server}|${tool}`) || isReadOnly(server, tool),
      nestedDepth: body.nestedDepth,
    });
    if (!arbD.ok) {
      send(res, 403, { ok: false, code: arbD.reason, error: arbD.detail, expertId: String(body.expertId || "") });
      return;
    }
    let receipt = null;
    const ikey = String(body.idempotencyKey || "").trim();    if (ikey) {
      const r = receipts.issue({ idempotencyKey: ikey, ticketId: String(body.ticketId || ""), effect: { server, tool } });
      if (r.duplicate) {
        const ex = r.existing || {};
        if (ex.settled && ex.ok && ex.result && ex.result.jobId) {
          send(res, 200, { ok: true, jobId: ex.result.jobId, epoch: STOP.epoch, duplicate: true, receiptId: r.receiptId });
          return;
        }
        send(res, 409, {
          ok: false, duplicate: true, inFlight: !ex.settled, receiptId: r.receiptId,
          error: ex.settled ? "这次派发之前失败过，需要换个说法重发" : "同一件事已经在派发中，别重复点",
          epoch: STOP.epoch,
        });
        return;
      }
      receipt = r;
    }
    /* 归因随单走：面板/调用方可以在派发时说明"这一单是谁路由出来的"，
       记录到成本账上以后就能回答"哪条规则最贵"。不传也有兜底值。 */
    const id = startJob(server, tool, body.args ?? {}, body.timeoutMs ?? JOB_TIMEOUT_MS, null, {
      route: body.route,
      ruleId: body.ruleId,
      attempt: body.attempt,
      /* 报告B 批次A：V-09 零 VLM / V-01 显式降级 / V-12 人类优先名额。
         只认结构化标记与显式 'human'，其余值一律不透传（避免伪造优先级）。 */
      zeroVlm: body.zeroVlm === true,
      degraded: body.degraded === true,
      degradeReasonCode: String(body.reasonCode || "").slice(0, 48),
      priority: body.priority === "human" ? "human" : undefined,
      guarded: body.guarded === true,
    });
    if (receipt) {
      try { receipts.settle(receipt.receiptId, { ok: true, result: { jobId: id } }); } catch {}
    }
    send(res, 200, { ok: true, jobId: id, epoch: STOP.epoch, receiptId: receipt ? receipt.receiptId : "" });
    return;
  }

  /* ================= 治理层接口（2026-11-03 新增） =================
   * 这一组接口全是**只读优先 + 显式动作**：GET 拿状态，POST 必须带 action。
   * 不做 REST 风格的隐式语义（PATCH 一张工单就顺手改了状态），
   * 因为这里的每一条都会影响"停不停得下来"，显式比优雅重要。
   */

  // 只停这一单：面板每张任务卡上的单独刹车
  if (req.method === "POST" && /^\/api\/job\/[^/]+\/abort$/.test(url.pathname)) {
    const id = url.pathname.split("/")[3];
    const body = await readBody(req).catch(() => ({}));
    const r = abortJob(id, body?.reason);
    send(res, r.ok ? 200 : 404, r);
    return;
  }

  // 工单：列表 / 单品 / 动作（resume|stop）
  if (req.method === "GET" && url.pathname === "/api/tickets") {
    const limit = Number(url.searchParams.get("limit")) || 50;
    send(res, 200, {
      ok: true,
      epoch: STOP.epoch,
      summary: ticketStore.summary(),
      items: ticketStore.list({ limit, open: url.searchParams.get("open") === "1" }),
    });
    return;
  }
  if (url.pathname.startsWith("/api/tickets/")) {
    const rest = url.pathname.slice("/api/tickets/".length);
    const tid = decodeURIComponent(rest.split("/")[0]);
    const sub = rest.split("/")[1] || "";
    if (sub === "trail" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit")) || 200;
      send(res, 200, { ok: true, ticketId: tid, trail: trajectory.read(tid, limit), checkpoint: trajectory.checkpoint(tid) });
      return;
    }
    if (req.method === "GET") {
      const t = ticketStore.get(tid);
      if (!t) { send(res, 404, { ok: false, error: "工单不存在或已过保留期" }); return; }
      /* 下钻一次给全：面板点开一张单，不该再打三四个请求才凑齐一屏。
       * 四块内容都是内存账本（轨迹在内存里、成本在内存里），没有 IO。 */
      send(res, 200, {
        ok: true,
        ticket: t,
        checkpoint: trajectory.checkpoint(tid),
        /* 同一单可能走过多次路由：逐次拆开才看得出钱花在哪一步。 */
        cost: (() => { try { return { summary: costLedger.summary(tid), attempts: costLedger.attempts(tid), budget: costLedger.budgetStatus(tid) }; } catch { return null; } })(),
        /* 人插手过几次、插在哪儿 —— 复盘时最先要看的就是这个。 */
        control: (() => { try { return ticketCtl.events(tid, 20); } catch { return []; } })(),
        trail: (() => { try { return trajectory.read(tid, Number(url.searchParams.get("trail")) || 60); } catch { return []; } })(),
      });
      return;
    }
    if (req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      if (body.action === "resume") {
        const r = ticketStore.resumeTicket(tid);
        if (r.ok) trajectory.append(tid, { type: "ticket.resumed", epoch: r.ticket.epoch });
        send(res, r.ok ? 200 : 400, r);
        return;
      }
      if (body.action === "stop") {
        const cur = ticketStore.get(tid);
        if (!cur) { send(res, 404, { ok: false, error: "工单不存在" }); return; }
        /* 先记控制事件再改状态：反过来的话，状态一旦变成 stopped，
         * 面板的"为什么停了"就只能显示一个终态，看不到是谁按的。 */
        let ctl = null;
        try { ctl = ticketCtl.control(tid, "stop", { reason: body.reason || "人工停止" }); } catch {}
        const r = ticketStore.transition(tid, "stopped", { expectRev: cur.rev, reason: body.reason || "人工停止" });
        if (ctl && ctl.ok) trajectory.append(tid, { type: "control.stop", epoch: STOP.epoch, reason: body.reason || "人工停止" });
        send(res, r.ok ? 200 : 400, { ...r, control: ctl && ctl.event ? ctl.event : null });
        return;
      }
      /* 纠正 / 换思路：都要求带一句说明 —— 空指令等于没插手，只会在执行层留下一条噪音。 */
      if (body.action === "correct" || body.action === "rethink") {
        const t = ticketStore.get(tid);
        if (!t) { send(res, 404, { ok: false, error: "工单不存在" }); return; }
        const r = ticketCtl.control(tid, body.action, { text: body.text });
        if (r.ok) {
          trajectory.append(tid, { type: "control." + body.action, epoch: STOP.epoch, text: String(body.text || "").slice(0, 200) });
        }
        send(res, r.ok ? 200 : 400, r);
        return;
      }
      send(res, 400, { ok: false, error: "action 只能是 resume / stop / correct / rethink" });
      return;
    }
  }

  // 成本：总账 / 按工单 / 按路由归因 / 明细
  if (req.method === "GET" && url.pathname === "/api/cost") {
    const ticketId = url.searchParams.get("ticket");
    if (ticketId) {
      send(res, 200, {
        ok: true,
        summary: costLedger.summary(ticketId),
        /* 同一单可能走了多次路由（Fast Path 失败再降级），逐次拆开才看得清钱花在哪一步 */
        attempts: costLedger.attempts(ticketId),
        budget: costLedger.budgetStatus(ticketId),
        rows: costLedger.list({ ticketId, limit: 50 }),
      });
      return;
    }
    send(res, 200, {
      ok: true,
      totals: costLedger.totals(),
      byTicket: costLedger.byTicket(20),
      /* 归因：哪条规则/哪个通道在烧钱。这是开并发前唯一能拦住"线性放大账单"的判据。 */
      byRoute: costLedger.byRoute(20),
      budgets: costLedger.budgets(),
      pricing: { note: "USD / 百万 token；CLI 未回吐 usage 时按文本长度估算，estimated=true", table: {
        "deepseek-v4-pro": costLedger.priceOf("deepseek-v4-pro"),
        "deepseek-v4": costLedger.priceOf("deepseek-v4"),
      } },
    });
    return;
  }
  /* 大附件采样计划（只算，不读文件）。
   * 面板在用户拖进大文件时问一句"这大概要花多少"，避免整份塞进模型把账单烧穿。
   * 纯计算、零 IO —— 所以可以放在这个位置，跟其他只读接口并列。 */
  if (req.method === "POST" && url.pathname === "/api/attach/plan") {
    const b = await readBody(req).catch(() => ({}));
    try {
      const plan = attachPlanFor(b);
      send(res, 200, { ok: true, ...plan, verdict: attachVerdict(plan) });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 能力清单（急停豁免白名单）整表。面板用它解释「急停了这个按钮为什么还能点」，
   * 也用它做"新增豁免需三条同时满足"的展示。
   * 顺带把"这次急停期间到底有哪些工具被拦"算出来给面板，省得面板自己推断分支。 */
  if (req.method === "GET" && url.pathname === "/api/capabilities") {
    const rows = capabilityTable();
    send(res, 200, {
      ok: true,
      stopped: STOP.on,
      epoch: STOP.epoch,
      count: rows.length,
      exempt: rows.filter((r) => r.stopExempt).map((r) => r.key),
      rows,
      /* 文件位置给面板一个"去看细节"的入口，不把整篇 md 塞进 JSON。 */
      doc: "docs/capabilities.md",
    });
    return;
  }

  /* 应用能力矩阵自检（报告A §4.3）：列出哪些应用能直接搜、哪些只能唤起。
     只读、不执行任何动作；深链白名单刻意留空，新增条目必须附实测记录。
     继承统一 token 鉴权，不进 PUBLIC_PATHS。 */
  if (req.method === "GET" && url.pathname === "/api/app-matrix") {
    const rows = appMatrix();
    const probe = url.searchParams.get("q");
    /* 报告A §4.2：只有用户显式说「用客户端」才给 clientAction，
       面板据此决定唤起还是只写剪贴板；默认解析 probe 不受影响。 */
    const clientAction = probe ? resolveClientAction(probe) : null;
    send(res, 200, {
      ok: true,
      schemaVersion: 2,
      count: rows.length,
      appCount: APP_COUNT,
      confidenceGate: CONFIDENCE_GATE,
      deepLinks: DEEP_LINKS,
      deepLinkNote: "只放实测通过且带搜索语义的项；本机实测 0 条，刻意留空",
      deepLinkAudit: deepLinkAudit(),
      launchable: Object.keys(LAUNCH_EVIDENCE),
      rows,
      /* q 用于「以后装了新客户端，跑一次就知道能不能用，不用改代码试错」。 */
      ...(probe ? { probe: resolveAppAction(probe) } : {}),
      /* 复合网页指令（搜索 X 并进入其官网）：关键词与搜索 URL 都由这里给，
         面板不再自己拼，免得出现「浏览器 湖南大学并进入其官网」这种脏 query。 */
      ...(probe ? { landing: resolveWebLanding(probe) } : {}),
      ...(clientAction ? { clientAction } : {}),
    });
    return;
  }

  /* 报告A §五 P1：客户端唤起。只接受 appId，exe/args 一律由静态能力表决定。
     渲染层不许传路径/命令/参数，杜绝这条接口退化成任意执行入口。
     无参数启动是硬约束（报告 §2.2：带参数被 Node CLI 拒绝）。
     fire-and-forget：不等待窗口出现，也不谎报「已打开」。 */
  if (req.method === "POST" && url.pathname === "/api/app-launch") {
    const b = await readBody(req).catch(() => ({}));
    const injected = ["exe", "path", "command", "cmd", "args", "argv", "filePath", "url"]
      .filter((k) => Object.prototype.hasOwnProperty.call(b || {}, k));
    if (injected.length) {
      send(res, 400, { ok: false, launched: false, error: "app-launch 只接受 appId", rejected: injected });
      return;
    }
    const p = planClientLaunch(String((b && b.appId) || ""));
    if (!p.ok) {
      send(res, 200, { ok: false, launched: false, ...p });
      return;
    }
    if (!fsSync.existsSync(p.exe)) {
      send(res, 200, {
        ok: false, launched: false, appId: p.appId, reasonCode: "exe-not-found",
        hint: "实测登记的 exe 路径当前不存在，不猜替代路径、不降级去拼协议",
      });
      return;
    }
    try {
      const child = spawn(p.exe, p.args, { detached: true, stdio: "ignore", windowsHide: false });
      child.once("error", (e) => log("[app-launch] 唤起失败:", p.appId, String(e && e.message || e)));
      child.unref();
      send(res, 200, {
        ok: true, launched: "fire-and-forget", appId: p.appId, args: p.args,
        evidence: p.evidence,
        note: "已发起无参数唤起；不等待窗口出现，也不谎报已打开",
      });
    } catch (err) {
      send(res, 200, { ok: false, launched: false, appId: p.appId, reasonCode: "spawn-failed", error: String(err?.message ?? err) });
    }
    return;
  }

  /* 工单预算：只记账侧判定，不替执行层决定停不停（停手是 ticketControl 的权力）。 */
  if (req.method === "POST" && url.pathname === "/api/cost/budget") {
    const b = await readBody(req).catch(() => ({}));
    const id = String(b.ticketId || "");
    if (!id) { send(res, 400, { ok: false, error: "需要 ticketId" }); return; }
    if (b.action === "clear") { send(res, 200, { ok: true, ...costLedger.setBudget(id, 0) }); return; }
    const r = costLedger.setBudget(id, b.usd);
    send(res, r.ok ? 200 : 400, { ...r, status: r.ok ? costLedger.budgetStatus(id) : null });
    return;
  }

  // 发件箱：看有没有卡住 / 重发 / 丢弃
  if (req.method === "GET" && url.pathname === "/api/outbox") {
    send(res, 200, { ok: true, stats: outbox.stats(), rows: outbox.list({ limit: Number(url.searchParams.get("limit")) || 50, status: url.searchParams.get("status") || "" }) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/outbox") {
    const body = await readBody(req).catch(() => ({}));
    if (body.action === "pump") { send(res, 200, { ok: true, ...(await outbox.pump()) }); return; }
    if (body.action === "retry") { send(res, 200, outbox.retry(body.id)); return; }
    if (body.action === "drop") { send(res, 200, outbox.drop(body.id, body.reason)); return; }
    send(res, 400, { ok: false, error: "action 只能是 pump / retry / drop" });
    return;
  }

  /* GUI 独占锁：桌面 Agent 的键鼠/焦点/剪贴板是全局单例，
   * 同一时刻只允许一条链路持有。租约到期自动释放，用户物理输入无条件让路。 */
  if (req.method === "GET" && url.pathname === "/api/gui-lock") {
    send(res, 200, { ok: true, ...guiLock.status(), epoch: STOP.epoch });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/gui-lock") {
    const body = await readBody(req).catch(() => ({}));
    const st = guiLock.status();
    if (body.action === "acquire") { send(res, 200, guiLock.acquire({ owner: body.owner, ttlMs: body.ttlMs, epoch: STOP.epoch, meta: body.meta })); return; }
    if (body.action === "renew") { send(res, 200, guiLock.renew(body.token, body.ttlMs)); return; }
    if (body.action === "release") { send(res, 200, guiLock.release(body.token, body.reason)); return; }
    if (body.action === "yield") { send(res, 200, guiLock.yieldByUser(body.reason || "user-input")); return; }
    if (body.action === "force") { send(res, 200, guiLock.forceRelease(body.reason)); return; }
    send(res, 400, { ok: false, error: "action 只能是 acquire / renew / release / yield / force", current: st });
    return;
  }

  /* 派发器：**只做决策，不执行**。
   * 现在的行为与改造前一致（没有专家 → fallback 单路）。
   * 这条接口的意义是：以后接"派发者专家团"时，面板与桥都读同一份计划，
   * 不会出现"面板判一次、桥里再判一次"的两套真相。 */
  if (req.method === "GET" && url.pathname === "/api/experts") {
    send(res, 200, {
      ok: true,
      experts: dispatcher.list(),
      threshold: dispatcher.threshold,
      maxFanout: dispatcher.maxFanout,
      note: "注册专家用 POST /api/experts；执行仍由 /api/dispatch 统一发起",
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/experts") {
    const body = await readBody(req).catch(() => ({}));
    try {
      if (body.action === "unregister") { send(res, 200, { ok: dispatcher.unregister(body.id) }); return; }
      // 注意：这里只接受**声明式**专家（关键字 + 路由），不接受函数体。
      // 从 HTTP 收一段可执行代码等于开了个远程后门，这个桥本来就是为了防这个才用令牌的。
      if (!body.id) { send(res, 400, { ok: false, error: "缺少 id" }); return; }
      const words = Array.isArray(body.keywords) ? body.keywords : [];
      const e = {
        id: String(body.id),
        name: String(body.name || body.id),
        kind: body.kind === "team" ? "team" : (body.kind === "dispatcher" ? "dispatcher" : "expert"),
        route: body.route || "workbuddy",
        policy: body.policy === "parallel" ? "parallel" : "serial",
        members: Array.isArray(body.members) ? body.members.map(String) : [],
        match: words.length ? keywordsMatcher(words) : () => 0,
        plan: Array.isArray(body.assignments) && body.assignments.length
          ? () => ({ assignments: body.assignments })
          : undefined,
      };
      send(res, 200, { ok: true, expert: dispatcher.register(e) });
    } catch (err) {
      send(res, 400, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/route") {
    const body = await readBody(req).catch(() => ({}));
    const plan = dispatcher.route({
      text: body.text,
      routeHint: body.routeHint || "auto",
      attachments: body.attachments,
      epoch: STOP.epoch,
      budget: body.budget,
    }, { dryRun: body.dryRun !== false });
    send(res, 200, { ok: true, plan });
    return;
  }

  /* Worker 池：观测 + 开关。
   * 打开它是有代价的（排队、可能让后台任务晚几十秒），所以做成显式动作而不是配置项自动生效。 */
  if (req.method === "GET" && url.pathname === "/api/pool") {
    send(res, 200, { ok: true, enabled: poolEnabled, ...pool.status() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/pool") {
    const body = await readBody(req).catch(() => ({}));
    if (body.action === "enable") {
      /* 急停期间不允许靠"开池"绕过去：池的 halted 就是急停的下游，
       * 在这里 resume 等于给刹车开了个后门。 */
      if (STOP.on) {
        send(res, 409, { ok: false, error: `已被急停（第 ${STOP.epoch} 代），先恢复再开池`, epoch: STOP.epoch });
        return;
      }
      poolEnabled = true;
      pool.resume();
      pool.setMaxWorkers(body.maxWorkers || pool.maxWorkers);
      send(res, 200, { ok: true, enabled: true, ...pool.status() });
      return;
    }
    if (body.action === "disable") {
      poolEnabled = false;
      send(res, 200, { ok: true, enabled: false, ...pool.status(), note: "已在跑的任务不受影响；新任务恢复为直接执行" });
      return;
    }
    if (body.action === "max") { send(res, 200, { ok: true, ...pool.setMaxWorkers(body.maxWorkers) }); return; }
    if (body.action === "halt") { send(res, 200, { ok: true, ...pool.halt(body.reason) }); return; }
    if (body.action === "resume") { send(res, 200, { ok: true, ...pool.resume() }); return; }
    send(res, 400, { ok: false, error: "action 只能是 enable / disable / max / halt / resume" });
    return;
  }

  /* 看门狗：**只报告不动手**。tick 可以手动触发，便于面板上"现在看一眼"。 */
  if (req.method === "GET" && url.pathname === "/api/watchdog") {
    send(res, 200, { ok: true, ...watchdog.status() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/watchdog") {
    const body = await readBody(req).catch(() => ({}));
    if (body.action === "start") { send(res, 200, { ok: true, ...watchdog.start(body.intervalMs || 60000) }); return; }
    if (body.action === "stop") { send(res, 200, { ok: true, ...watchdog.stop() }); return; }
    if (body.action === "tick") { send(res, 200, { ok: true, result: watchdog.tick() }); return; }
    if (body.action === "sweep") { send(res, 200, { ok: true, removed: trajectory.sweep() }); return; }
    /* S5：面板/外部声明与撤销预期完成事件契约。 */
    if (body.action === "declare") { send(res, 200, { ok: true, ...watchdog.declare(body.ticketId, body.contract || {}) }); return; }
    if (body.action === "clear") { send(res, 200, { ok: true, removed: watchdog.clear(body.ticketId) }); return; }
    send(res, 400, { ok: false, error: "action 只能是 start / stop / tick / sweep / declare / clear" });
    return;
  }

  /* 常驻 daemon 的结果回调（免令牌：回调方拿不到 X-Orb-Token）。
     命中已知 runId 才算数，其余忽略；原始报文一律落盘便于确认字段。 */
  if (req.method === "POST" && url.pathname === "/api/wb-callback") {
    const body = await readBody(req);
    const id = String(body?.runId || body?.id || body?.data?.runId || "");
    try {
      /* 回调原始报文改走 logBus —— 全仓日志的唯一写者，自带脱敏
         （Bearer / sk- / token / 本地路径 / 外链 / 指令注入全部中和），
         不再有 wb-callback.log 这个绕开总线、不脱敏的第二写者（P0-2）。
         body 作为 message 传入，logBus.write 按字段级策略脱敏后落盘。 */
      logBus.write({
        category: "task", level: "info", epoch: epochOf(),
        runId: id || undefined,
        message: "wb-callback " + (id || "(缺失 runId)") + ": " + JSON.stringify(body),
      });
    } catch { /* 落盘失败不影响主流程 */ }
    const entry = id && pendingRuns.get(id);
    if (entry) {
      pendingRuns.delete(id);
      entry.resolve(extractCallbackText(body) || "(回调里没找到正文，详情见日志 wb-callback 条目)");
    } else {
      log("[wb-callback] 收到未匹配的回调 runId =", id || "(缺失)");
    }
    send(res, 200, { ok: true });
    return;
  }

  // SSE：单个任务的 partial/final 实时推送，替代面板 2s 轮询 /api/job/:id。
  // 回退：面板 EventSource 出错会自动退回原 2s 轮询，零退化。
  if (req.method === "GET" && url.pathname.startsWith("/api/job/") && url.pathname.endsWith("/stream")) {
    const id = url.pathname.slice("/api/job/".length, -"/stream".length);
    sseHead(res);
    const job = jobs.get(id);
    sseSend(res, { type: "snapshot", job: job || null });   // 立即先推当前状态（含已存在的 partial）
    if (!job) { res.end(); return; }                         // 任务已不存在：推一帧空快照后关闭
    subscribeJob(id, res);
    const ka = setInterval(() => {
      if (res.writableEnded) return;
      try { res.write(": keep-alive\n\n"); } catch {}
    }, 15000);
    res.on("close", () => clearInterval(ka));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/job/")) {
    const id = url.pathname.split("/").pop();
    const job = jobs.get(id);
    if (!job) {
      /* 淘汰上限生效后（见 startJob），**正在跑的 job 也可能被挤掉**。
         原来只回一句 "job not found"，调用方完全分不清是"id 写错了"
         还是"被挤掉了"，排查时只能干瞪眼。给个能自解释的文案。 */
      send(res, 404, { ok: false, error: `job ${id} 不存在或已被淘汰（最多保留 ${MAX_JOBS} 条）` });
      return;
    }
    send(res, 200, { ok: true, job });
    return;
  }

  /* 热启动（常驻 daemon）开关：读状态 / 运行时切换。改完立即生效，无需重启 ORB。 */
  if (req.method === "GET" && url.pathname === "/api/wb-daemon") {
    send(res, 200, {
      ok: true,
      enabled: WB_DAEMON,
      port: WB_DAEMON_PORT,
      running: !!daemonProc,
      waitMs: WB_DAEMON_WAIT,
      healthy: WB_DAEMON ? await daemonHealth() : false,
    });
    return;
  }

  /* 站名 → 官网地址。「打开湖南大学官网」这类请求如果只能落到搜索结果页，
     用户还得自己点第一条 —— 那不算完成任务。
     实测（2026-11-05）Bing 的 RSS 输出稳定且快（~120-300ms）。
     注意：不能取"第一条"，见 resolveSite 上面的注释（「湖南省官网」8/8 是 SEO 农场）。 */
  if (req.method === "GET" && url.pathname === "/api/resolve-site") {
    const q = String(url.searchParams.get("q") || "").trim().slice(0, 60);
    if (!q) { send(res, 200, { ok: false, error: "缺少 q" }); return; }
    const now = Date.now();
    const hit = siteCache.get(q);
    const ttl = hit && hit.url ? SITE_CACHE_MS : SITE_MISS_CACHE_MS;
    if (hit && now - hit.at < ttl) {
      send(res, 200, hit.url
        ? { ok: true, url: hit.url, confidence: hit.confidence, source: hit.source || "cache", cached: true }
        : { ok: false, error: "没解析到结果", cached: true, confidence: 0 });
      return;
    }
    /* 第一顺位：本地站点库（书签 + 历史 + 上次确认过的结果）。
       这是唯一"零猜测"的来源 —— 你打开过的站，地址就是那个。 */
    let lib = null;
    try { lib = await siteLibrary.lookup(q); } catch (err) { log("[resolve-site] 本地库查询失败：", err?.message ?? err); }
    if (lib && lib.url) {
      siteCache.set(q, { url: lib.url, at: now, confidence: lib.confidence, source: lib.source });
      send(res, 200, { ok: true, url: lib.url, confidence: lib.confidence, source: lib.source, title: lib.title });
      return;
    }
    let out = { url: "", tried: [] };
    try {
      out = await resolveSite(q);
    } catch (err) {
      log("[resolve-site] 解析异常：", err?.message ?? err);
    }
    /* 解析器没给出足够确定的答案时，最后试一次"这个名字是不是本身就是域名"。 */
    if (!out.url || (out.confidence || 0) < 0.8) {
      try {
        const probe = await probeDomainAlias(siteCore(q) || q);
        if (probe && probe.confidence >= 0.8) {
          log(`[resolve-site] 域名命中 ${JSON.stringify(q)} → ${probe.url}（DNS ${probe.host}，HTTP ${probe.status}）`);
          out = { url: probe.url, confidence: probe.confidence, source: "dns", tried: out.tried };
        }
      } catch (err) {
        log("[resolve-site] 域名探针失败：", err?.message ?? err);
      }
    }
    /* 只有"够确定"的结果才写进学习库 —— 把 0.7 分的猜测记成"以后都这么开"，就是污染的起点。 */
    if (out.url && (out.confidence || 0) >= 0.8) siteLibrary.learn(q, out.url);
    siteCache.set(q, { url: out.url || "", at: now, confidence: out.confidence || 0, source: out.source || "search" });
    send(res, 200, out.url
      ? { ok: true, url: out.url, confidence: out.confidence || 0, source: out.source || "search", via: out.tried ? out.tried.join("|") : "" }
      : { ok: false, error: "没解析到结果", confidence: 0 });
    return;
  }

  /* 本地站点库的状态（给设置面板 / 排查用）。 */
  if (req.method === "GET" && url.pathname === "/api/site-library") {
    send(res, 200, { ok: true, ...siteLibrary.stats() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wb-prewarm") {
    /* 面板唤出 / 输入框聚焦时按需预热：把 CLI 那 2.5 秒启动成本挪到用户打字期间。
       带 3 分钟 TTL，重复调用是空操作。 */
    const warm = !!(cliPrewarmAt && Date.now() - cliPrewarmAt < PREWARM_TTL_MS);
    prewarmCli(false);
    send(res, 200, { ok: true, warm, at: cliPrewarmAt });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/wb-daemon") {
    const { enabled, waitMs } = await readBody(req);
    WB_DAEMON = !!enabled;
    /* 可选：一并调小「等回调」的上限（3–90s）。面板联动开启时会传一个较短值 ——
       daemon 派发成功但回调不来时，靠这个值快速回落到 -p 子进程，
       否则用户会盯着"后台执行中"干等 90 秒。 */
    if (waitMs !== undefined && enabled) {
      const n = Number(waitMs);
      if (isFinite(n) && n > 0) WB_DAEMON_WAIT = Math.max(3000, Math.min(90000, Math.round(n)));
    }
    try {
      writeConfFlag("daemon", WB_DAEMON);
    } catch (err) {
      send(res, 200, { ok: false, error: "写入 bridge.conf 失败：" + String(err?.message ?? err) });
      return;
    }
    if (!WB_DAEMON) {
      try { daemonProc && daemonProc.kill(); } catch { /* ignore */ }
      daemonProc = null;
      log("[wb-daemon] 已关闭热启动；后台改用 -p 子进程");
      send(res, 200, { ok: true, enabled: false, running: false });
      return;
    }
    log("[wb-daemon] 已开启热启动；随后台任务按需启动常驻服务");
    // 预热放后台，接口立即返回，避免面板卡住（ensureDaemon 最长等 40s）。
    ensureDaemon().then((ok) => log("[wb-daemon] 预热", ok ? "就绪" : "未成功")).catch(() => {});
    send(res, 200, { ok: true, enabled: true, running: !!daemonProc, waitMs: WB_DAEMON_WAIT });
    return;
  }

  /* 截屏取词：截图（或面板传入 dataUrl）→ Windows 自带 OCR → 文字。离线、免安装、不限流。 */
  /* 划词翻译：轻量旁路，见 runTranslate 的注释 */
  if (req.method === "POST" && url.pathname === "/api/translate") {
    const body = await readBody(req);
    try {
      send(res, 200, await runTranslate(String((body && body.text) || "")));
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/ocr") {
    const body = await readBody(req);
    try {
      let png;
      if (body.dataUrl) {
        png = Buffer.from(String(body.dataUrl).split(",")[1] || "", "base64");
      } else {
        const r = await callTool("windows", "Screenshot", {}, 60000);
        const img = ((r && r.content) || []).find((c) => c.type === "image");
        png = Buffer.from((img && img.data) || "", "base64");
      }
      if (!png || !png.length) {
        send(res, 200, { ok: false, error: "没有拿到图像（截图失败）" });
        return;
      }
      const r = await ocrPng(png, String(body.lang || "zh-Hans-CN"));
      /* lines 给取词的"确认态"画高亮框用；没有坐标的老环境就是空数组，
         那时取词退回"整块一次性拿走"，功能不残废。
         V-11：OCR 是不可信输入。text/lines 保留原样（坐标锚定与展示要用），
         但送进模型/记忆只准用 guarded.data —— 它已中和注入指令并包成 DATA-ONLY。 */
      send(res, 200, {
        ok: true, text: r.text, lines: r.lines, untrusted: true,
        guarded: textGate.guard(String(r.text || ""), "ocr"),
        guardNote: "text/lines 只供坐标锚定与展示；送进模型或记忆必须用 guarded.data",
      });
    } catch (err) {
      send(res, 200, { ok: false, error: String(err?.message ?? err) });
    }
    return;
  }

  /* 本地语音识别服务：查询状态 / 切换 CPU-GPU（改 asr.conf 并重启服务）
   *
   * ?wake=1 → **先确保服务在跑**再回状态。
   * 为什么需要：服务空闲 5 分钟会被回收（见 ASR_IDLE_MS），而这一支原来只探活
   * （asrHealth），不唤醒 —— 面板拿到的 running 恒 false，auto 模式于是静默
   * 降级到浏览器引擎，用户看到的就是"装了 Whisper 却永远识别失败"。
   * 代价：唤醒要重新加载权重（small 约 1 秒、medium 约 3 秒，回落 CPU 更久），
   * 所以调用方必须给足超时并在 UI 上说明"正在启动本地识别服务"。 */
  if (req.method === "GET" && url.pathname === "/api/asr") {
    const conf = readAsrConf();
    let h = await asrHealth();
    if (url.searchParams.get("wake") === "1") {
      if (asrInstalled() && asrModelDownloaded()) {
        if (!h) { await asrEnsure(90000); h = await asrHealth(); }
        else asrTouch();          // 服务在跑：续一次"最近使用"，别刚要用就被回收
      }
    }
    const installed = asrInstalled();
    const modelOk = asrModelDownloaded();
    const eff = (h && h.effective) || null;
    send(res, 200, {
      ok: true,
      // 就绪度三态：装没装（venv）/ 权重下没下 / 服务跑没跑
      installed,
      modelDownloaded: modelOk,
      // 已下载的模型清单：面板显示"已下载：small / medium"（服务在跑用它的 /health，没跑自己扫目录）
      modelsAvailable: (h && h.modelsAvailable) || asrModelsAvailable(),
      needDownload: !installed || !modelOk,
      ready: !!(h && h.ready !== false),
      running: !!h, health: !!h, owned: !!asrProc,
      model: (h && h.model) || String(conf.model || "small"),
      // 实际生效值：/health 的 effective 优先（asr_server 回落 CPU 后写回过 conf，两者一致）
      device: (h && h.device) || String(conf.device || "auto"),
      compute: (h && h.compute) || String(conf.compute || "auto"),
      // 期望值 vs 生效值：面板据此显示"GPU 不可用，已回落 CPU/int8"
      requested: { device: String(conf.device || "auto"), compute: String(conf.compute || "auto") },
      effective: eff,
      fellBack: !!(eff && eff.fellBack),
      note: eff && eff.reason ? String(eff.reason) : "",
      dir: ASR_DIR,
      autostart: conf.autostart !== false,
      /* 引擎：sensevoice（首选，一次前向出文字+情绪）/ whisper（兜底，只有文字）。
         服务没跑时按"权重在不在"推断，面板据此决定要不要承诺"能读情绪"。 */
      engine: (h && h.engine) || (asrSenseVoiceReady() ? "sensevoice" : "whisper"),
      emotion: !!(h && h.emotion),
      engineError: (h && h.engineError) || "",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/asr") {
    const body = await readBody(req);
    // 没装本地识别就别折腾：写 conf / 重启都无从谈起，直接引导一键安装
    if (!asrInstalled() || !asrModelDownloaded()) {
      send(res, 200, {
        ok: false, needDownload: true,
        // 面板会拿这个响应渲染状态行，字段必须和 GET 对齐，否则"已安装"被误判成"未安装"
        installed: asrInstalled(), modelDownloaded: asrModelDownloaded(),
        error: "还没安装本地识别。请先点「安装本地离线识别」（约 430 MB），装完即可离线转写，顺带读出情绪；不装也能用浏览器引擎语音。",
      });
      return;
    }
    const prev = readAsrConf();
    const patch = {};
    if (body.device) patch.device = String(body.device);
    if (body.compute) patch.compute = String(body.compute);
    if (body.model) patch.model = String(body.model);
    writeAsrConf(patch);
    log("[asr] 切换:", JSON.stringify(patch));
    await asrStop();
    let ok = await asrEnsure(90000);
    let note = "";
    if (!ok) {
      // 失败自动回滚：别让语音服务卡在「起不来」的配置上
      writeAsrConf(prev);
      await asrStop();
      ok = await asrEnsure(90000);
      note = "新配置启动失败，已回滚到 " + (prev.device || "auto") + "/" + (prev.compute || "auto");
      log("[asr] 回滚:", note);
    }
    const h = await asrHealth();
    const eff = (h && h.effective) || null;
    send(res, 200, {
      ok, reverted: !!note, error: ok ? undefined : (note || "服务未就绪（见 bridge 日志）"),
      // running 必须给：面板靠它决定按钮显示"启动"还是"重启"。
      // 原来只给 health，面板读 running 永远是 undefined → 按钮文案永远停在"启动"。
      running: !!h, health: !!h,
      installed: asrInstalled(), modelDownloaded: asrModelDownloaded(), needDownload: false,
      modelsAvailable: (h && h.modelsAvailable) || asrModelsAvailable(),
      model: (h && h.model) || readAsrConf().model || "small",
      device: (h && h.device) || readAsrConf().device || "auto",
      compute: (h && h.compute) || readAsrConf().compute || "auto",
      requested: { device: String(prev.device || "auto"), compute: String(prev.compute || "auto") },
      effective: eff,
      fellBack: !!(eff && eff.fellBack),
      note: eff && eff.reason ? String(eff.reason) : "",
    });
    return;
  }

  /* ── 本地识别一键安装（DESIGN §5.2 / §14.3）──
   * POST /api/asr/prepare           拉起 asr/prepare.ps1（幂等，重跑会接着装）
   * GET  /api/asr/prepare-progress  轮询进度：bridge 缓冲脚本输出的 [orb-asr] 行
   * 安装是**显式按钮触发**，不在启动路径上阻塞 UI（§15.6）；失败也不影响浏览器引擎语音。
   * 脚本输出行格式：[orb-asr] <step> <percent> <message> */
  if (req.method === "POST" && url.pathname === "/api/asr/prepare") {
    if (asrPrepare && asrPrepare.running) {
      send(res, 200, { ok: false, running: true, error: "正在安装中，请稍候（进度可轮询 /api/asr/prepare-progress）" });
      return;
    }
    const script = path.join(ASR_DIR, "prepare.ps1");
    if (!fsSync.existsSync(script)) {
      send(res, 200, { ok: false, error: "找不到安装脚本：" + script + "（发布版应随包附带 resources/asr/prepare.ps1）" });
      return;
    }
    const proc = spawn("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-AsrDir", ASR_DIR,
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: ASR_DIR });
    asrPrepare = {
      running: true, proc, lines: [], step: "pick", percent: 0,
      ok: false, error: "", startedAt: Date.now(), code: null,
    };
    const onOut = (d) => {
      for (const raw of String(d).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        asrPrepare.lines.push(line);
        if (asrPrepare.lines.length > 200) asrPrepare.lines.shift();
        const m = line.match(/^\[orb-asr\]\s+(\w+)\s+(\d+)(?:\s+(.*))?$/);
        if (m) { asrPrepare.step = m[1]; asrPrepare.percent = Number(m[2]) || 0; }
        log("[asr-prep]", line);
      }
    };
    proc.stdout.on("data", onOut);
    proc.stderr.on("data", onOut);
    proc.on("error", (e) => {
      asrPrepare.running = false;
      asrPrepare.ok = false;
      asrPrepare.error = String(e?.message ?? e);
      log("[asr-prep] 启动异常:", asrPrepare.error);
    });
    proc.on("exit", (code) => {
      asrPrepare.running = false;
      asrPrepare.code = code;
      asrPrepare.ok = code === 0;
      if (code !== 0 && !asrPrepare.error) {
        asrPrepare.error = "安装脚本退出码 " + code + "（详见上方日志；下载支持断点续传，可直接重试）";
      }
      log("[asr-prep] 结束，退出码", code);
    });
    if (proc) registerChild(proc.pid, "asr-prep");
    send(res, 200, { ok: true, started: true, running: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/asr/prepare-progress") {
    const p = asrPrepare;
    send(res, 200, {
      ok: true,
      running: !!(p && p.running),
      started: !!p,
      step: p ? p.step : "",
      percent: p ? p.percent : 0,
      success: p ? !!p.ok : false,
      error: p ? p.error : "",
      lines: p ? p.lines.slice(-40) : [],
      elapsedMs: p ? Date.now() - p.startedAt : 0,
    });
    return;
  }

  /* 追加下载某个模型权重（首跑「可选组件」用，例如 medium ≈1.5GB）：
     直接用 asr/venv 里的 python 跑 download_model.py <repo> models/<name>。
     进度并入 asrPrepare 单槽 —— 与一键安装互斥（同一时刻只跑一个），
     面板轮询 /api/asr/prepare-progress 即可看到（download_model.py 的输出行
     本身就是 [orb-asr] model <pct> …，解析规则现成）。
     ⚠️ medium 依赖 venv + 依赖：没装过先走 /api/asr/prepare，这里只做「追加」。 */
  if (req.method === "POST" && url.pathname === "/api/asr/model") {
    const body = await readBody(req);
    const name = String((body && body.name) || "").trim();
    const repo = ASR_MODEL_REPOS[name];
    if (!repo) {
      send(res, 200, { ok: false, error: "不支持的模型名：" + (name || "(空)") + "（可用：" + Object.keys(ASR_MODEL_REPOS).join(" / ") + "）" });
      return;
    }
    if (asrPrepare && asrPrepare.running) {
      send(res, 200, { ok: false, running: true, error: "正在安装中，请稍候（进度可轮询 /api/asr/prepare-progress）" });
      return;
    }
    if (!asrInstalled()) {
      send(res, 200, {
        ok: false, needInstall: true,
        error: "还没安装本地识别（venv / 依赖未就绪）：请先完成「安装本地离线识别」，再来下 " + name + " 权重。",
      });
      return;
    }
    const dest = path.join(ASR_DIR, "models", name);
    const proc = spawn(asrVenvPy(), [path.join(ASR_DIR, "download_model.py"), repo, dest],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, cwd: ASR_DIR });
    asrPrepare = {
      running: true, proc, lines: [], step: "model", percent: 0,
      ok: false, error: "", startedAt: Date.now(), code: null, model: name,
    };
    const onOut = (d) => {
      for (const raw of String(d).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        asrPrepare.lines.push(line);
        if (asrPrepare.lines.length > 200) asrPrepare.lines.shift();
        const m = line.match(/^\[orb-asr\]\s+(\w+)\s+(\d+)(?:\s+(.*))?$/);
        if (m) { asrPrepare.step = m[1]; asrPrepare.percent = Number(m[2]) || 0; }
        log("[asr-model]", line);
      }
    };
    proc.stdout.on("data", onOut);
    proc.stderr.on("data", onOut);
    proc.on("error", (e) => {
      asrPrepare.running = false;
      asrPrepare.ok = false;
      asrPrepare.error = String(e?.message ?? e);
      log("[asr-model] 启动异常:", asrPrepare.error);
    });
    proc.on("exit", (code) => {
      asrPrepare.running = false;
      asrPrepare.code = code;
      asrPrepare.ok = code === 0;
      if (code !== 0 && !asrPrepare.error) {
        asrPrepare.error = "下载脚本退出码 " + code + "（支持断点续传，可直接重试）";
      }
      log("[asr-model] 结束，退出码", code);
    });
    if (proc) registerChild(proc.pid, "asr-model");
    send(res, 200, { ok: true, started: true, running: true, model: name, dest });
    return;
  }

  /* 实时字幕：查状态 / 一键启动（自动打开字幕页面）/ 停止 */
  if (req.method === "GET" && url.pathname === "/api/rt") {
    const h = await rtHealth();
    send(res, 200, { ok: true, running: !!h, port: RT_PORT, owned: !!rtProc });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/rt") {
    const body = await readBody(req);
    if (body.stop) {
      await rtStop();
      send(res, 200, { ok: true, running: false });
      return;
    }
    let h = await rtHealth();
    if (!h) {
      rtStart();
      let up = false;
      let err = "";
      for (let i = 0; i < 20; i++) {
        await sleep(400);
        if (rtSpawnErr) { err = rtSpawnErr; rtSpawnErr = ""; break; }   // 起不来就别空转 8 秒
        if ((h = await rtHealth(600))) { up = true; break; }
      }
      if (!up) {
        send(res, 200, { ok: false, error: "实时字幕服务启动失败（见 bridge 日志）" + (err ? "：" + err : "") });
        return;
      }
    }
    if (body.open !== false) rtOpenBrowser();
    send(res, 200, { ok: true, running: true, url: `http://127.0.0.1:${RT_PORT}` });
    return;
  }

  /* 优雅停机（给 Electron 主进程退出前调用）。
     Windows 上父进程对我们的 kill() 是 TerminateProcess —— 本进程被瞬间抹掉，
     shutdown() 根本来不及跑，MCP / CLI / ASR / 字幕进程就全成了孤儿。
     主进程退出前先打这个接口，子进程树才能收干净。带令牌，外部网页调不动。 */
  if (req.method === "POST" && url.pathname === "/api/shutdown") {
    send(res, 200, { ok: true });
    setTimeout(() => { shutdown(); }, 60);
    return;
  }

  send(res, 404, { ok: false, error: "not found" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    send(res, 500, { ok: false, error: String(err?.message ?? err) });
  });
});

server.on("error", (err) => {
  console.error("server error:", err.message);
  /* 端口被占 = 已经有一个实例在服务。留在本进程只会拼出"端口通 + 令牌被我们
     改过"这个最糟的组合（主进程全线 401），不如干脆退出让旧实例继续干。 */
  if (err && err.code === "EADDRINUSE") {
    console.error("端口", PORT, "已被占用：已有 bridge 实例在跑，本进程退出");
    process.exit(1);
  }
});

async function shutdown() {
  /* 收尾必须覆盖**所有**被我们拉起来的东西。
     原来只管 daemon / asr / rt：正在跑的 CodeBuddy CLI（activeProcs 里记着）
     和各 MCP server 子进程（sessions）全留给了系统 —— 那正是孤儿进程的主要来源，
     用户说的"电脑负担"很大一块就来自这里。 */
  try { disarmTriggers(); } catch {}
  try { clearInterval(asrReaper); asrReaper = null; } catch {}
  /* 治理层的收尾：看门狗先停（别在关停过程中再报一堆"停滞"），
   * 然后落盘工单/发件箱/成本账 —— 这三份是"下次启动还能说清上次发生了什么"的唯一依据。 */
  try { watchdog.stop(); } catch {}
  try { pool.halt("shutdown"); } catch {}
  killActiveProcs();
  try { daemonProc && daemonProc.kill(); } catch {}
  try { asrProc && asrProc.kill(); } catch {}
  try { rtProc && rtProc.kill(); } catch {}
  disposeAllSessions();
  /* 阶段一收尾：会话按结束日归档，分类日志 / 事件流 / 各类账本落盘。
     放在 killActiveProcs 之后、process.exit 之前，保证是同步写、不丢。 */
  try { sessionMgr.finalize("before-quit"); } catch {}
  try { logBus.flush(); logBus.close(); } catch {}
  try { eventRecorder.flush(); } catch {}
  try { artifactStore.flush?.(); } catch {}
  try { spanCollector.flush(); } catch {}
  try { observeRouter.flush(); } catch {}
  try { receipts.flush?.(); } catch {}
  /* 步骤收据也要在退出前落盘：否则重启后 6000 条幂等索引全丢，
     同一步会被当成"没做过"再执行一次。 */
  try { wfReceipts.flush?.(); } catch {}
  try { ticketCtl.flush?.(); } catch {}
  // 干净退出后不该再留台账：下次启动会拿这批已不存在的 PID 去做回收核对
  try { writeChildReg([]); } catch {}
  try { ticketStore.close(); } catch {}
  try { outbox.close(); } catch {}
  try { costLedger.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 令牌文件必须在 listen **之前**写好：主进程的策略是「等端口通 -> 读文件」，
// 若端口先通而文件还是上一个实例的旧令牌，鉴权就会全线 401。
//
// 但这条规则有个副作用：第二个实例启动时会先把**新**令牌写进文件，然后才发现
// 端口被旧实例占着 —— 主进程于是拿着新令牌去问旧实例，全线 401，而旧实例的
// 令牌从此没人知道。所以写之前先探测：上一个实例还活着就什么都不写、直接退出。
function existingBridgeAlive() {
  try {
    const j = JSON.parse(fsSync.readFileSync(TOKEN_FILE, "utf8"));
    const pid = Number(j && j.pid);
    if (!pid || pid === process.pid) return false;
    try { process.kill(pid, 0); } catch { return false; }   // 信号 0：只探测存在性，不发信号
    /* pid 存在还不够：pid 会被系统复用，一个"恰好拿到旧 pid"的无关进程会让我
       们误判桥还活着而退出 —— 那结果是整个控制台无桥可用。所以再比对端口：
       记录的端口不是当前这个，就说明那份令牌不是同一套配置留下的。 */
    return Number(j.port) === PORT;
  } catch { return false; }
}
if (existingBridgeAlive()) {
  console.error(`已有 bridge 实例在跑（见 ${TOKEN_FILE}）：本进程退出，避免覆盖它的令牌`);
  process.exit(0);
}
try {
  writeJsonAtomic(TOKEN_FILE, { port: PORT, token: TOKEN, pid: process.pid });
} catch (e) {
  console.error("写入令牌文件失败:", e.message);
}

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`orb console ready: http://127.0.0.1:${PORT}`);
  /* 先把上一次强杀留下的子进程清掉，避免孤儿越堆越多（见 reapStaleChildren）。
     必须 **await**：ASR 的启动决策要基于"回收之后"的真实状态，
     否则旧 ASR 还半死不活地占着端口，asrEnsure 会误判"已经在跑"而不拉新的。 */
  try { await reapStaleChildren(); } catch (e) { log("[gc] 清理失败:", e?.message ?? e); }

  /* ── ASR 启动策略（单一归属，只由 bridge 管）──
   * 曾经的三个机制互相打架，导致面板**永远**显示"服务未运行"：
   *   ① .cmd 启动器也会起一份 ASR，且先 `netstat` 查 19876 再决定起不起；
   *   ② 旧 ASR 还活着 → .cmd 判定"已在运行" → 跳过启动；
   *   ③ 紧接着 reapStaleChildren 把旧 ASR 当孤儿杀掉；
   *   ④ 而 bridge 是懒加载的，不会主动拉 → 最后没人起 ASR。
   * 现在 .cmd 不再管 ASR，规则收敛成一条（DESIGN §5.2）：
   *   一键安装就绪（asr/venv 存在）才自启；没装 → 保持懒加载，
   *   不白占 238MB 内存 + 2.1GB 显存。没装时语音走浏览器引擎，功能不残。
   *   asr.conf 的 autostart:false 可单独关自动启动（只保留手动/按需拉起）。
   * 拉起来后会由空闲回收器在 5 分钟无人用时停掉，所以不会一直占着。
   * （ORB_ASR_AUTOSTART=0 可整个关掉，供单测 / 手动排查用。） */
  const asrAutoOn = ASR_AUTOSTART && readAsrConf().autostart !== false;
  if (asrAutoOn && asrInstalled()) {
    log("[asr] 检测到本地识别环境（venv 就绪），启动识别服务…");
    asrEnsure(120000)
      .then((ok) => log("[asr] 启动", ok ? "就绪" : "失败（详见上方日志）"))
      .catch((e) => log("[asr] 启动异常:", e?.message ?? e));
  } else if (asrAutoOn) {
    log("[asr] 未安装本地识别（asr/venv 不存在），保持懒加载；需要离线识别可在面板一键安装");
  }
  startAsrIdleReaper();

  /* 后台 CLI 预热：延迟 8s，错过启动高峰，也避开用户刚点开面板那一下。 */
  try {
    const pw = setTimeout(prewarmCli, 8000);
    if (pw && typeof pw.unref === "function") pw.unref();
  } catch {}
  /* CLI 参数能力探测：与预热错开，避免同时拉起两个 CLI 抢 IO。 */
  try {
    const pb = setTimeout(probeCliFlags, 4000);
    if (pb && typeof pb.unref === "function") pb.unref();
  } catch {}

  /* 看门狗：只判"有没有实质进展"，只报告不动手。ORB_WATCHDOG=0 可关。 */
  if (process.env.ORB_WATCHDOG !== "0") {
    try {
      watchdog.start(Number(process.env.ORB_WATCHDOG_MS || 60000));
      const removed = trajectory.sweep();
      if (removed) log(`[trail] 启动清扫：删除 ${removed} 个过期轨迹文件`);
    } catch (e) {
      log("[watchdog] 启动失败:", e?.message ?? e);
    }
  }
});
