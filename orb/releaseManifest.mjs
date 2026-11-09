/* 发布安装清单：签名 / 来源 / 新鲜度「分列判定」+ 组件分组 + 体积评估（纯模块，可单测）。
 *
 * 方案 S6：签名时间戳 / 证书链 / buildId / 组件哈希进安装清单；按主进程、渲染/扩展桥、
 * 浏览器执行端、模型依赖、可选视觉模块拆分；随包 Python 运行时评估首次按需下载/外置；目标 zip ≤ 200 MB。
 * 验收 #3：「已签名但过期」与「未签名但内部调试」分别判定 —— 关键陷阱是**别把"签名过期"
 * 当成"内容被篡改/新鲜度失效"**，也别把"内部调试未签名"当成"发布版没签名"一刀切拒绝。
 *
 * 三条列彼此独立，不合并成一个布尔：
 *   signature（签名）  —— 密码学状态：signed-valid / signed-expired / unsigned / tampered
 *   source（来源）     —— 构建渠道：official-release / internal-debug / unknown
 *   freshness（新鲜度）—— buildId / 时间戳 / 扩展重载：fresh / stale / unknown
 * 只有把三列一起呈现，才能解释"已签名但过期"到底该不该拦。签名 crypto 校验属外部证书流程，
 * 本模块只做**判定逻辑与清单结构**（诚实标注 unavailable，不伪造签名）。
 */

export const MANIFEST_SCHEMA_VERSION = 1;
export const ZIP_TARGET_BYTES = 200 * 1024 * 1024;   // S6 目标 zip ≤ 200 MB

/** 组件分组：与方案 S6 的五个攻击面 + 一个待外置运行时一一对应。 */
export const COMPONENT_GROUPS = Object.freeze([
  { id: "main-process", label: "主进程 / Electron 运行时" },
  { id: "renderer-bridge", label: "渲染 / 扩展桥（桥侧 .mjs + 面板）" },
  { id: "browser-exec", label: "浏览器执行端（扩展）" },
  { id: "model-deps", label: "模型依赖（CLIP / 推理运行时）" },
  { id: "optional-vision", label: "可选视觉模块（C0/C1 锚定）" },
  { id: "python-runtime", label: "随包 Python 运行时（评估外置）" },
  { id: "other", label: "其它随包资源" },
]);

/** 按相对路径把文件归到一个组件组。纯函数，可单测。 */
export function componentGroupOf(rel) {
  const p = String(rel || "").replace(/\\/g, "/").replace(/^\.\//, "");
  // Python 运行时优先判定（它在 resources/runtime 下，路径里有 python）
  if (/^resources\/runtime\/(python|)/i.test(p) || /python(3\d+)?\.(dll|exe|zip)$/i.test(p)) return "python-runtime";
  if (/^resources\/app\/browser-extension\//i.test(p)) return "browser-exec";
  if (/@huggingface|onnxruntime|@xenova|transformers|tokenizers|sharp/i.test(p)) return "model-deps";
  if (/^resources\/node_modules\//i.test(p)) return "model-deps";
  if (/(^|\/)(visualAnchor|visualTiers|v13Metrics|v13LoopGuard|createClipMatcher)\.mjs$/i.test(p) || /visualAnchor\.mjs$/i.test(p)) return "optional-vision";
  if (/^resources\/app\//i.test(p)) return "renderer-bridge";
  // 主进程：exe / dll / resources/desktop 下的 main.js preload 等
  if (/\.(exe|dll|node|pak|bin)$/i.test(p) || /^resources\/desktop\//i.test(p) || /^(locales|swiftshader)\//i.test(p)) return "main-process";
  if (/\.(pak|dat|bin)$/i.test(p)) return "main-process";
  return "other";
}

/** 把 [{path,size,sha256}] 汇总成分组视图。纯函数。 */
export function summarizeComponents(files = []) {
  const byGroup = {};
  for (const g of COMPONENT_GROUPS) byGroup[g.id] = { id: g.id, label: g.label, files: 0, bytes: 0 };
  for (const f of files) {
    const g = componentGroupOf(f.path);
    const b = byGroup[g] || byGroup.other;
    b.files++;
    b.bytes += Number(f.size) || 0;
  }
  return COMPONENT_GROUPS.map((g) => byGroup[g.id]);
}

/**
 * 体积评估：给出随包 Python 运行时的占比 + 「外置后」的估算 zip 体积。
 * 不谎称已达 200 MB：如实给出 currentZipBytes / projectedWithoutPython / overTarget。
 * zipBytes 由调用方传入（压缩后大小），没有就置 null（不补零）。
 */
export function evaluateSize(groups = [], { zipBytes = null, targetBytes = ZIP_TARGET_BYTES } = {}) {
  const byId = Object.fromEntries(groups.map((g) => [g.id, g.bytes]));
  const pythonBytes = byId["python-runtime"] || 0;
  const totalBytes = groups.reduce((s, g) => s + g.bytes, 0);
  const ratio = totalBytes ? pythonBytes / totalBytes : null;
  // 外置后估算：按 Python 运行时在解压体积中的占比，从 zip 里同比例扣减（保守上界估计）。
  const projectedWithoutPython = (Number.isFinite(zipBytes) && ratio != null)
    ? Math.max(0, Math.round(zipBytes * (1 - ratio))) : null;
  return {
    totalBytes, pythonRuntimeBytes: pythonBytes, pythonRuntimeRatio: ratio == null ? null : Number(ratio.toFixed(4)),
    zipBytes: Number.isFinite(zipBytes) ? zipBytes : null,
    projectedWithoutPython,
    targetBytes,
    overTarget: Number.isFinite(zipBytes) ? zipBytes > targetBytes : null,
    meetsTargetAfterExternalizingPython: projectedWithoutPython != null ? projectedWithoutPython <= targetBytes : null,
    recommendation: pythonBytes > 0
      ? "随包 Python 运行时建议首次按需下载/外置（asr/prepare.ps1 已支持按需生成 venv）"
      : "未随包 Python 运行时，无需外置",
  };
}

/* ============================ 签名 / 来源 / 新鲜度 分列判定 ============================ */

/**
 * 签名列（纯函数）。sig 形如：
 *   { status: "signed"|"unsigned", algorithm, signedAt, timestamp, certChain:[{subject,notBefore,notAfter}], contentHashOK }
 * 返回 { status, note }。status ∈
 *   signed-valid       已签名且证书当前有效
 *   signed-expired     已签名但证书已过期（**签名本身在签署时有效，不是篡改** —— 验收 #3 要点）
 *   signed-notimestamp 已签名、证书过期且无 RFC3161 时间戳，无法证明签署时有效
 *   unsigned           未签名
 *   tampered           组件哈希不符（内容被动过）
 *   unavailable        未提供证书链/无法判定（诚实标注，不伪造）
 */
export function classifySignature(sig = {}, ctx = {}) {
  const s = sig || {};
  if (s.contentHashOK === false) return { status: "tampered", note: "组件哈希与清单不符，内容可能被篡改" };
  if (s.status !== "signed") return { status: "unsigned", note: "未签名（首次运行会有 SmartScreen 提示）" };
  if (!Array.isArray(s.certChain) || !s.certChain.length) {
    return { status: "unavailable", note: "声明已签名但无证书链，无法判定（不伪造结论）" };
  }
  const now = Number(ctx.now) || Date.now();
  const expired = s.certChain.some((c) => Number(c.notAfter) > 0 && now > Number(c.notAfter));
  if (!expired) return { status: "signed-valid", note: "已签名且证书当前有效" };
  if (s.timestamp && Number(s.timestamp) > 0) {
    const signedAtValid = s.certChain.every((c) =>
      !(Number(c.notBefore) > 0 && Number(s.timestamp) < Number(c.notBefore)) &&
      !(Number(c.notAfter) > 0 && Number(s.timestamp) > Number(c.notAfter)));
    if (signedAtValid) {
      return { status: "signed-expired", note: "签名时间戳证明签署时证书有效；证书现已过期，属『已签名但过期』，不是篡改、不是新鲜度失效" };
    }
    return { status: "signed-expired", note: "证书已过期且时间戳落在证书有效期外，需人工复核" };
  }
  return { status: "signed-notimestamp", note: "证书已过期且无时间戳，无法证明签署时有效（与『已签名但过期』分列）" };
}

/** 来源列（纯函数）：构建渠道决定"未签名"该如何解读。 */
export function classifySource(manifest = {}, opts = {}) {
  const channel = String(opts.channel || (manifest && manifest.channel) || "").toLowerCase();
  if (/^(release|official|public|stable)$/.test(channel)) return { status: "official-release", note: "正式发布渠道" };
  if (/^(debug|dev|internal|internal-debug|test)$/.test(channel)) return { status: "internal-debug", note: "内部调试构建（未签名是预期内，不等于发布版缺签）" };
  return { status: "unknown", note: "来源渠道未声明，保守按未知处理" };
}

/** 新鲜度列（纯函数）：只看 buildId / 重载，不因"证书过期"而判 stale。 */
export function classifyFreshness(manifest = {}, ctx = {}) {
  const expected = ctx.expectedBuildId != null ? String(ctx.expectedBuildId) : null;
  const actual = manifest && manifest.buildId != null ? String(manifest.buildId) : null;
  if (!expected || !actual) return { status: "unknown", note: "缺 buildId（磁盘或清单），无法比对新鲜度" };
  if (expected !== actual) return { status: "stale", note: `buildId 不匹配：磁盘 ${expected} ≠ 清单/扩展 ${actual}，请重新加载扩展或换用匹配构建` };
  return { status: "fresh", note: "buildId 一致，扩展与磁盘构建匹配" };
}

/**
 * 三列合并成一份裁决（分列判定，不塌成一个布尔）。
 * canCreateTarget：能否创建新的浏览器目标 —— 只在**新鲜度**不过关时拒绝，
 *   且保留 recoveryPath=true（安全中间态任务可恢复，不撕半途工作）。
 * 「已签名但过期」与「未签名但内部调试」分别给出可读结论，绝不互相污染。
 */
export function assessTrust(manifest = {}, opts = {}) {
  const columns = {
    signature: classifySignature(manifest.signature || {}, opts),
    source: classifySource(manifest, opts),
    freshness: classifyFreshness(manifest, opts),
  };
  const reasons = [];
  // 发布版未签名 → 明确警告；内部调试未签名 → 不报问题（分列判定的价值就在这）
  if (columns.signature.status === "unsigned" && columns.source.status === "official-release") {
    reasons.push("正式发布版未签名：首次信任/启动攻击面未收敛，需落代码签名");
  }
  if (columns.signature.status === "tampered") reasons.push("组件哈希不符：拒绝加载");
  if (columns.freshness.status === "stale") reasons.push("新鲜度失效：拒绝创建新目标，提示重载一次；保留恢复路径");
  const freshnessOk = columns.freshness.status !== "stale";
  const contentOk = columns.signature.status !== "tampered";
  const verdict = columns.signature.status === "tampered" ? "reject"
    : !freshnessOk ? "degrade"
      : reasons.length ? "warn" : "ok";
  return {
    verdict, columns, reasons,
    canCreateTarget: freshnessOk && contentOk,
    recoveryPath: true,   // 即便拒绝创建新目标，安全中间态任务仍可恢复
    // 面向用户的两句话，专门覆盖验收 #3 的两种易混情形
    cases: {
      signedButExpired: columns.signature.status === "signed-expired",
      unsignedInternalDebug: columns.signature.status === "unsigned" && columns.source.status === "internal-debug",
    },
  };
}

export default {
  MANIFEST_SCHEMA_VERSION, ZIP_TARGET_BYTES, COMPONENT_GROUPS,
  componentGroupOf, summarizeComponents, evaluateSize,
  classifySignature, classifySource, classifyFreshness, assessTrust,
};
