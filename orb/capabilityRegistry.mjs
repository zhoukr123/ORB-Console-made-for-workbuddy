/* ---------------- 能力清单（capabilityRegistry） ----------------
 *
 * 解决的是同一件事被写在三个地方的问题：
 *   ① bridge 的 STOP_EXEMPT 白名单；
 *   ② 文档里那张"急停期间哪些工具还能用"的表；
 *   ③ 面板给人的解释（"为什么这个按钮还能点"）。
 * 三份手抄，改一处忘两处是迟早的事 —— 而这里恰恰是安全边界：
 * **多放一个工具进白名单，就等于在刹车踩下去的时候留了一只脚**。
 *
 * 所以：清单只写在这一个文件里，白名单由它派生，文档由它生成，
 * 单测再校验"文档与清单一致"（见 test/capabilityRegistry.test.mjs）。
 *
 * 字段含义：
 *   server / tool   与 MCP 的 (server, tool) 对齐，判定时拼成 "server|tool"
 *   readOnly        是否只读。**只有只读的才允许豁免**，写操作一律进不来
 *   stopExempt      急停期间是否仍放行
 *   effect          给用户看的一句话：它到底做了什么（含"不做什么"）
 *
 * 11-07 增量简报 §1：ref 版本绑定要写进 capability manifest。
 * 这里不往 CAPABILITIES 每行塞 toolVersion（那会动到已冻结的清单与文档一致性断言），
 * 而是单独提供一条「带工具版本的声明」构造函数，由调用方在签发 capability 时显式带上。
 */
import { capabilityManifestEntry, ELEMENT_REF_SCHEMA_VERSION, AGENT_DESKTOP_VERSION } from "./refBinding.mjs";

export { capabilityManifestEntry, ELEMENT_REF_SCHEMA_VERSION, AGENT_DESKTOP_VERSION };

/** 签发一条带 (server, tool, toolVersion, platform) 的能力声明。 */
export function manifestFor(server, tool, toolVersion, extra = {}) {
  return capabilityManifestEntry(server, tool, toolVersion, extra);
}

export const CAPABILITIES = [
  {
    server: "orb", tool: "cursor_position", readOnly: true, stopExempt: true,
    effect: "读鼠标坐标；不动鼠标、不点任何东西",
  },
  {
    server: "orb", tool: "ocr", readOnly: true, stopExempt: true,
    effect: "截屏后离线取词；只读屏幕像素，不操作窗口",
  },
  {
    server: "orb", tool: "subtitle", readOnly: true, stopExempt: true,
    effect: "查实时字幕状态；启停字幕仍受急停拦截",
  },
  {
    server: "windows", tool: "Screenshot", readOnly: true, stopExempt: true,
    effect: "截一张屏；不移动焦点",
  },
  {
    server: "windows", tool: "Snapshot", readOnly: true, stopExempt: true,
    effect: "读当前窗口与控件树；不改任何状态",
  },
  {
    server: "windows", tool: "DisplayInventory", readOnly: true, stopExempt: true,
    effect: "枚举显示器信息；纯查询",
  },
];

/** 豁免集合。bridge 直接用它构造 STOP_EXEMPT —— 不再手抄第二份。 */
export function stopExemptSet() {
  const s = new Set();
  for (const c of CAPABILITIES) {
    if (c.stopExempt && c.readOnly) s.add(`${c.server}|${c.tool}`);
  }
  return s;
}

/** 判定：某个 (server, tool) 在急停期间是否放行。写操作永远 false。 */
export function isStopExempt(server, tool) {
  const key = `${server}|${tool}`;
  for (const c of CAPABILITIES) {
    if (`${c.server}|${c.tool}` === key) return !!(c.stopExempt && c.readOnly);
  }
  return false;
}

/** 判定：某个 (server, tool) 是否只读。
 *
 * **未登记的一律当写操作**（fail-closed）。这是刻意的：
 * 只读判定会被"专家只许观察"这类规则直接用来放行/拒绝，
 * 未知工具的默认若是"只读"，等于给所有新工具开了一张免检通行证。
 */
export function isReadOnly(server, tool) {
  const key = `${server}|${tool}`;
  for (const c of CAPABILITIES) {
    if (`${c.server}|${c.tool}` === key) return !!c.readOnly;
  }
  return false;
}

/** 结构化表格（面板/自检直接吃）。 */
export function table() {
  return CAPABILITIES.map((c) => ({
    server: c.server, tool: c.tool, key: `${c.server}|${c.tool}`,
    readOnly: !!c.readOnly, stopExempt: !!(c.stopExempt && c.readOnly),
    effect: c.effect || "",
  }));
}

/** 生成文档表格。**必须是确定性的**：单测拿它和磁盘上的 md 逐字比对，靠这个防漂移。 */
export function toMarkdown() {
  const head = [
    "# 急停期间仍放行的能力（自动生成，勿手改）",
    "",
    "> 本文件由 `orb/capabilityRegistry.mjs` 的 `toMarkdown()` 生成。",
    "> 要改白名单请改那个文件，然后跑 `node orb/tools/gen-capabilities-doc.mjs`。",
    "> 单测会校验本文件与清单一致 —— 手改这里会直接测挂。",
    "",
    "| server | tool | 只读 | 急停放行 | 它到底做了什么 |",
    "|---|---|---|---|---|",
  ].join("\n");
  const rows = CAPABILITIES.map((c) => {
    const exempt = !!(c.stopExempt && c.readOnly);
    return `| ${c.server} | ${c.tool} | ${c.readOnly ? "是" : "否"} | ${exempt ? "是" : "否"} | ${c.effect || ""} |`;
  }).join("\n");
  const tail = [
    "",
    "## 为什么只有这几项",
    "",
    "急停的语义是「别再动了」。因此豁免只给**看了也不会改变任何状态**的查询：",
    "截屏、看屏幕、读显示器、查鼠标位置、取词。",
    "",
    "`workbuddy_execute`（后台派活）已于 2026-11-03 移出白名单：它不动机器，",
    "但它是**最贵、最久、最容易跑飞**的那一类 —— 急停期间还允许新建，等于刹车踩下去油门还留着。",
    "",
    "新增豁免必须同时满足三条，缺一条就别加：",
    "1. `readOnly: true`，且实际实现里确实没有任何写操作；",
    "2. 不占用 GUI 锁（不移动焦点、不点到别的窗口）；",
    "3. 用户能看懂 `effect` 那句人话 —— 说不清的，就是不该放行。",
    "",
    "检索类（`windows|Scrape`、外部 `/api/search`、`browser|dom.get_text` 等）",
    "**一律不进豁免**：它们会往外发请求并带回不可信正文，急停时必须一起停。",
    "`readOnly: true` 只表示「不改本机状态」，**不等于**「急停期间可放行」。",
    "这条由 `batchA.mjs` 的 `searchExemptAudit()` 与单测点名锁定，别靠「没登记」",
    "这种隐式满足 —— 将来往清单里加一行 search 就会静默破防。",
    "",
  ].join("\n");
  return head + "\n" + rows + "\n" + tail;
}

/* ============================ 方案 D：写操作治理（权限治理） ============================
 * 在「只读 / 急停豁免」之上再补一层：写操作（含未登记工具，fail-closed 当写处理）
 * 默认需要人工确认，并可按身份 / 设备 / 行为放行。决策逻辑全部集中在这里，
 * 纯函数、可单测；bridge 只在真正执行写工具前调一次 governWrite 裁决。
 *
 * 新增能力字段（可选，默认等价 false / 空）：
 *   requiresConfirm  写操作执行前是否需要人工确认令牌（未登记工具默认 true）
 *   authorizedBy    { identities:[], devices:[] } 授权白名单；非空时不在白名单内即拒
 *   revocable       该能力是否支持事后撤销（用于审计 / 回滚提示）
 *
 * 注：本段只新增「判定函数」，不改上面的 CAPABILITIES 清单与 toMarkdown 形状，
 *     因此既有的 capabilityRegistry.test.mjs（锁文档一致性）不受影响。 */

function findCap(server, tool) {
  const key = `${server}|${tool}`;
  return CAPABILITIES.find((c) => `${c.server}|${c.tool}` === key) || null;
}

/** 写操作是否需要人工确认（未登记工具默认 true，延续 fail-closed 哲学）。 */
export function requiresConfirmOf(server, tool) {
  const c = findCap(server, tool);
  if (!c) return true;
  return !!c.requiresConfirm;
}

/** 该能力是否支持事后撤销。 */
export function revocableOf(server, tool) {
  const c = findCap(server, tool);
  return c ? !!c.revocable : false;
}

/** 授权白名单（{ identities, devices }），未配置返回 null。 */
export function authorizedByOf(server, tool) {
  const c = findCap(server, tool);
  return c && c.authorizedBy ? c.authorizedBy : null;
}

/** 需要确认的工具集合（bridge 可一次性取，用于预检）。 */
export function confirmRequiredSet() {
  const s = new Set();
  for (const c of CAPABILITIES) if (c.requiresConfirm && !c.readOnly) s.add(`${c.server}|${c.tool}`);
  return s;
}

/** 可撤销工具集合。 */
export function revocableSet() {
  const s = new Set();
  for (const c of CAPABILITIES) if (c.revocable) s.add(`${c.server}|${c.tool}`);
  return s;
}

/**
 * 写操作治理裁决（纯函数）。返回结构化结果，bridge 据以放行或拦截：
 *   { ok:true }                                  —— 放行（只读 / 已确认 / 白名单内）
 *   { ok:false, code:'CONFIRM_REQUIRED', ... }   —— 需人工确认但没带确认令牌
 *   { ok:false, code:'DENIED', ... }             —— 身份/设备不在授权白名单
 * opts: { confirmed?:boolean, identity?:string, device?:string }
 */
export function governWrite(server, tool, opts = {}) {
  const c = findCap(server, tool);
  const readOnly = c ? !!c.readOnly : false;
  if (readOnly) return { ok: true };            // 只读直接放行，不卡
  // 写操作（含未登记工具，fail-closed）
  const req = c ? !!c.requiresConfirm : true;   // 未登记默认需确认
  if (req && !opts.confirmed) {
    return {
      ok: false, code: "CONFIRM_REQUIRED", tool: `${server}|${tool}`,
      reason: `写操作需要人工确认（${c ? "capability.requiresConfirm" : "未登记工具默认按写操作处理，需确认"}）`,
    };
  }
  // 授权白名单（按身份/设备/行为放行）
  const auth = c && c.authorizedBy ? c.authorizedBy : null;
  if (auth) {
    const ids = Array.isArray(auth.identities) ? auth.identities : [];
    const devs = Array.isArray(auth.devices) ? auth.devices : [];
    const id = opts.identity, dev = opts.device;
    if ((ids.length && (!id || !ids.includes(id))) ||
        (devs.length && (!dev || !devs.includes(dev)))) {
      return { ok: false, code: "DENIED", tool: `${server}|${tool}`,
        reason: "当前身份/设备不在该能力的授权白名单内" };
    }
  }
  return { ok: true };
}
