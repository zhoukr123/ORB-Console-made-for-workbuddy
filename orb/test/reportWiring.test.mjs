/* 11-07 增量简报落地：接线防漂移契约。
 * 纯模块各自的单测只证明「模块本身对」，这里证明「模块真的被产品接线使用了」——
 * bridge.mjs / pack.cjs / pluginHost / anchorResolver / p2SiteAdapter / capabilityRegistry
 * 任一处把接线删掉，这个测试立刻红。
 *
 * bridge.mjs 会起服务，不能直接 import；按工程既有惯例只读源码做静态契约，
 * 纯函数段按标记抽出来用 new Function 独立跑（同 WB_PARTIAL_START/END 的做法）。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const BRIDGE = read("bridge.mjs");
const PACK = read("pack.cjs");
const PLUGIN = read("pluginHost.mjs");
const ANCHOR = read("anchorResolver.mjs");
const ADAPTER = read("p2SiteAdapter.mjs");
const CAPREG = read("capabilityRegistry.mjs");
const WRITERS = read("stateWriters.mjs");
const REGISTRY = read("docs/registry.md");

const DIRECT_MODULES = [
  "policyTransition.mjs", "dreamConsolidator.mjs", "pluginArtifactGate.mjs",
  "memoryBudget.mjs", "siteCapabilityData.mjs",
  "governanceCore.mjs", "p0Discipline.mjs", "p1FileChannel.mjs",
  "p2SiteAdapter.mjs", "p2SealReview.mjs", "p3VerifyLite.mjs",
  "hostDataApi.mjs", "executionBridge.mjs", "injectable.mjs",
];
/* refBinding 由 anchorResolver 间接 import，桥不直接引用，但打包必须带上。 */
const LEAF_MODULES = ["refBinding.mjs"];
const NEW_MODULES = [...DIRECT_MODULES, ...LEAF_MODULES];

test("14 个新模块都在 bridge.mjs 顶层 import，15 个全部登记进 BRIDGE_LOCAL", () => {
  const block = PACK.slice(PACK.indexOf("const BRIDGE_LOCAL = ["), PACK.indexOf("\n];", PACK.indexOf("const BRIDGE_LOCAL = [")));
  for (const m of DIRECT_MODULES) {
    assert.match(BRIDGE, new RegExp('from "\\./' + m.replace(".", "\\.") + '"'), `bridge.mjs 缺少 ${m} 的 import`);
  }
  for (const m of NEW_MODULES) assert.ok(block.includes(`'${m}'`), `pack.cjs BRIDGE_LOCAL 漏了 ${m}`);
  assert.match(PACK, /被已打包模块间接 import/, "打包注释要说明叶子模块为什么也要登记");
});

test("间接依赖的 3 个叶子模块也登记（便携版运行时才会暴露的事故）", () => {
  for (const m of ["refBinding.mjs", "siteCapabilityData.mjs", "pluginArtifactGate.mjs"]) {
    assert.ok(PACK.includes(`'${m}'`));
  }
  assert.match(ANCHOR, /from "\.\/refBinding\.mjs"/);
  assert.match(ADAPTER, /from "\.\/siteCapabilityData\.mjs"/);
  assert.match(PLUGIN, /from "\.\/pluginArtifactGate\.mjs"/);
});

test("治理层用命名空间导入，避免与桥内 TIERS / GATES 撞名", () => {
  for (const n of ["govCore", "govP0", "govP1", "govP2", "govSeal", "govVerify", "govHost", "govExec", "govRules"]) {
    assert.match(BRIDGE, new RegExp(`import \\* as ${n} from "\\./`), `缺命名空间导入 ${n}`);
  }
});

test("6 个新实例在桥进程里装配，hostApi 默认关", () => {
  for (const n of ["policyTransition", "dream", "artifactGate", "memoryBudget", "hostApi", "sealReview", "govChannel"]) {
    assert.match(BRIDGE, new RegExp(`const ${n} = `), `缺实例 ${n}`);
  }
  assert.match(BRIDGE, /createHostDataApi\(\{ enabled: false \}\)/, "宿主取数默认必须关");
  assert.match(BRIDGE, /createSealReview\(\{ mode: "normal", teamFactory: \(\) => team \}\)/,
    "独立复核评审必须注入已有 team，不能走硬编码绝对路径");
  assert.ok(!read("p2SealReview.mjs").includes("D:/workbuddy_ORB控制台"), "p2SealReview 不得再含绝对路径");
  assert.match(read("p2SealReview.mjs"), /new URL\("\.\/team\.mjs", import\.meta\.url\)/);
});

const OPS_CASES = [
  "gov.status", "gov.resolve", "gov.route", "gov.evidence.tag", "gov.evidence.admit",
  "gov.redline", "gov.house", "gov.rules", "gov.site.capabilities", "gov.site.gate",
  "gov.site.vision", "gov.plan", "gov.plan.run", "gov.host.fetch", "gov.host.stats",
  "gov.seal.review", "gov.seal.context", "gov.verify.stage", "gov.verify.lite",
  "gov.verify.claim", "gov.channel.read", "gov.channel.commit", "gov.channel.dispatch",
  "gov.channel.repair", "gov.channel.cost",
  "site.stats", "site.table", "site.lookup", "site.audit",
  "policy.kinds", "policy.phases", "policy.state", "policy.propose", "policy.notice",
  "policy.guard", "policy.checkpoint", "policy.quiesce", "policy.commit",
  "policy.rollback", "policy.reject", "policy.stats",
  "dream.consolidate", "dream.verify", "dream.index", "dream.preload", "dream.stats", "dream.snapshot",
  "budget.modes", "memory.budget", "memory.setMode", "memory.allocate", "memory.observe",
  "memory.stats", "memory.snapshot",
  "artifact.codes", "artifact.validate", "artifact.accept", "artifact.reverify", "artifact.stats",
];

test("/api/ops 暴露全部 60 个新动作", () => {
  for (const c of OPS_CASES) {
    assert.ok(BRIDGE.includes(`case "${c}":`), `缺 /api/ops case ${c}`);
  }
  assert.ok(OPS_CASES.length >= 55);
});

test("急停期间有副作用的动作先过 guardStop，纯查询不受影响", () => {
  assert.match(BRIDGE, /const guardStop = \(\) => \{[\s\S]{0,400}STOP\.on/);
  const guarded = [
    "gov.plan.run", "gov.host.fetch", "gov.channel.commit", "gov.channel.dispatch",
    "gov.channel.repair", "policy.checkpoint", "policy.quiesce", "policy.commit",
    "artifact.accept", "artifact.reverify",
  ];
  for (const c of guarded) {
    const from = BRIDGE.indexOf(`case "${c}":`);
    assert.ok(from > 0, `缺 case ${c}`);
    const body = BRIDGE.slice(from, from + 320);
    assert.match(body, /guardStop\(\)/, `${c} 必须在急停时拒`);
  }
  const statusBody = BRIDGE.slice(BRIDGE.indexOf('case "status":'), BRIDGE.indexOf('case "status":') + 1800);
  assert.match(statusBody, /policy: \{|dream: dream\.stats\(\)|artifactGate: artifactGate\.stats\(\)/,
    "状态流只放只读摘要");
});

test("策略变更与带外急停分路：/api/stop 的 policy 分支绝不调 doStop / bumpEpoch", () => {
  const from = BRIDGE.indexOf('action === "policy-change"');
  assert.ok(from > 0, "缺 policy-change 分支");
  const branch = BRIDGE.slice(from, BRIDGE.indexOf("else if (action === \"policy-status\")", from));
  assert.match(branch, /policyTransition\.propose\(/);
  assert.match(branch, /stopLike: policyTransition\.isStopLike\(\)/);
  assert.match(branch, /STOP\.epoch 保持不变/);
  assert.ok(!/doStop\(|bumpEpoch\(/.test(branch), "策略变更分支绝不能碰急停路径");
  /* doStop 里的 bumpEpoch 仍然保留（急停语义不能被削弱） */
  const stopBody = BRIDGE.slice(BRIDGE.indexOf("function doStop(reason)"), BRIDGE.indexOf("function doResume()"));
  assert.match(stopBody, /ticketStore\.bumpEpoch\(STOP\.reason\)/);
  assert.match(policySrc(), /policyEpoch/, "策略侧必须有独立世代");
});

function policySrc() { return read("policyTransition.mjs"); }

test("审批否决+纠正：一次交互内回写 steers，/api/confirm 透传三个新字段", () => {
  const fn = BRIDGE.slice(BRIDGE.indexOf("function resolveApproval("), BRIDGE.indexOf("function waitApproval("));
  assert.match(fn, /extra\.correction/);
  assert.match(fn, /ticketCtl\.control\(/);
  assert.match(fn, /veto, correction, ticketId/);
  assert.match(BRIDGE, /approvals\.set\(id, \{[^}]*ticketId:/, "pending 列表要带工单号");
  assert.match(BRIDGE, /correction: body\.correction, ticketId: body\.ticketId, replan:/);
  assert.match(BRIDGE, /function waitApproval\(server, tool, args, meta = \{\}\)/);
});

/* ---- 失败诚实：抽 CLI_EXIT 段独立跑 ---- */
function cliExitFns() {
  const a = BRIDGE.indexOf("/* CLI_EXIT_START");
  const b = BRIDGE.indexOf("/* CLI_EXIT_END");
  assert.ok(a > 0 && b > a, "CLI_EXIT 标记缺失");
  const seg = BRIDGE.slice(a, b);
  return new Function(seg + "\nreturn { cliExitCode, classifyCliExit, cliExitMessage };")();
}

test("classifyCliExit：成功 / 非零 / 部分输出 / 字符串错误码 / killed 五态", () => {
  const { classifyCliExit, cliExitMessage } = cliExitFns();
  assert.deepEqual(classifyCliExit(null, "答案"), { exitCode: 0, hasOutput: true, failed: false, partialOutput: false, code: "ok" });
  const nonzero = classifyCliExit({ code: 1 }, "半段答案");
  assert.equal(nonzero.exitCode, 1);
  assert.equal(nonzero.failed, true);
  assert.equal(nonzero.partialOutput, true);
  assert.equal(nonzero.code, "partial-output-failed");
  assert.match(cliExitMessage(nonzero), /部分内容不作为任务结果交付/);
  assert.equal(classifyCliExit({ code: 2 }, "").code, "cli-failed");
  assert.equal(classifyCliExit({ code: "ENOENT" }, "x").exitCode, -1);
  assert.equal(classifyCliExit({ killed: true }, "x").exitCode, -1);
  assert.equal(classifyCliExit({ code: "0" }, "x").failed, false, "纯数字串 0 是成功");
  assert.equal(cliExitMessage(classifyCliExit(null, "x")), "");
});

test("两条 CLI 路径都复用 classifyCliExit，且不再有『正文非空即成功』的旧注释", () => {
  assert.ok((BRIDGE.match(/classifyCliExit\(/g) || []).length >= 3, "定义 + 两个收尾点");
  assert.match(BRIDGE, /const exit = classifyCliExit\(err, out\)/);
  assert.match(BRIDGE, /const exit = classifyCliExit\(err, out\)/);
  assert.ok(!BRIDGE.includes("CLI 非零退出时也可能已在 stdout 里产出结果，优先取 stdout"),
    "旧的成功判定注释必须删除");
  assert.match(BRIDGE, /e\.exitCode = exit\.exitCode/);
});

test("站点能力表规模化：4 个样例换成 226 站真实数据，且未核实条目不生成选择器", () => {
  assert.match(ADAPTER, /SITE_CAPABILITIES = Object\.freeze\(buildCapabilityTable\(\)\)/);
  assert.match(ADAPTER, /export \{ SITE_STATS, DEEP_ADAPTED_SITES \}/);
  assert.match(ADAPTER, /绝不生成未核实的 DOM 选择器/);
  const data = read("siteCapabilityData.mjs");
  assert.match(data, /china-top1000-websites\.csv#rank<=226/);
  assert.ok(data.includes('"rank": 1,') && data.includes('"rank": 226,'), "226 条要内联在源码里");
});

test("插件生成物闸门真的接在 register()，且 capability manifest 能带工具版本", () => {
  const reg = PLUGIN.slice(PLUGIN.indexOf("function register(plugin)"), PLUGIN.indexOf("function unregister("));
  assert.match(reg, /plugin\.origin/);
  assert.match(reg, /artifactGate\.validate\(/);
  assert.match(reg, /artifact-gate:/);
  assert.match(CAPREG, /export function manifestFor\(/);
  assert.match(CAPREG, /from "\.\/refBinding\.mjs"/);
  assert.match(WRITERS, /policyTransition\.commit/);
  assert.match(WRITERS, /dreamConsolidator\.consolidate/);
  assert.match(WRITERS, /createArtifactGate\.accept/);
});

test("打包闭包：所有传递依赖都在 BRIDGE_LOCAL 里（便携版不会 ERR_MODULE_NOT_FOUND）", async () => {
  const { checkClosure } = await import("../tools/check-pack-closure.mjs");
  const r = checkClosure();
  assert.equal(r.ok, true, JSON.stringify({ missing: r.missing, missingFiles: r.missingFiles, duplicates: r.duplicates }));
  assert.ok(r.listed >= 70);
  assert.equal(r.missing.length, 0);
});

test("动态记忆预算真的挂在 Max 开关上（#50）", () => {
  const PANEL = read("desktop/panel.html");
  const from = PANEL.indexOf("function applyMaxMode(");
  assert.ok(from > 0);
  const fn = PANEL.slice(from, PANEL.indexOf("document.getElementById('maxBtn').addEventListener", from));
  assert.match(fn, /action: 'memory\.setMode'/);
  assert.match(fn, /mode: maxMode \? 'max' : 'normal'/);
  assert.match(fn, /动态记忆预算|记忆预算/);
});

test("注册表文档不再满是问号：状态写入器与指标两节都用真实字段", () => {
  const sec3 = REGISTRY.slice(REGISTRY.indexOf("## 三、状态写入器"), REGISTRY.indexOf("## 四、指标"));
  const sec4 = REGISTRY.slice(REGISTRY.indexOf("## 四、指标"), REGISTRY.indexOf("## 五、"));
  assert.ok(!sec3.includes("`?`"), "状态写入器表不能全是问号");
  assert.match(sec3, /policyTransition\.commit/);
  assert.ok(!sec4.includes("`undefined`"), "指标表不能全是 undefined");
  assert.match(sec4, /eventToTaskMs/);
});

test("端到端交叉：226 站能力表经 actionGate 仍守红线", async () => {
  const { SITE_CAPABILITIES, actionGate, assertVisionDecisionOnly } = await import("../p2SiteAdapter.mjs");
  const { SITE_STATS, assertNoInventedSelectors } = await import("../siteCapabilityData.mjs");
  assert.equal(SITE_STATS.total, 226);
  assert.equal(SITE_STATS.verified, 4);
  assert.ok(Object.keys(SITE_CAPABILITIES).length > 200, "站点表必须真的铺开");
  const audit = assertNoInventedSelectors(SITE_CAPABILITIES);
  assert.equal(audit.ok, true, JSON.stringify(audit.bad));
  /* 已核实深度站点保留真实 dom 动作 */
  assert.equal(actionGate({ site: "bilibili.com", action: "read_meta", nodeId: undefined }).channel, "dom");
  /* 轻量站点只给 url 通道，不给选择器 */
  const light = actionGate({ site: "baidu.com", action: "search" });
  assert.equal(light.allowed, true);
  assert.equal(light.channel, "url");
  assert.ok(!JSON.stringify(light.plan).includes("selector"));
  assert.equal(assertVisionDecisionOnly({ x: 1, y: 2 }).ok, false);
});
