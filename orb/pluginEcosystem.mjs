/* pluginEcosystem.mjs — 共享插件生态（统一摄入层，已进 orb/，桥侧 plugin.install 直接调用）
 *
 * 目标：一个注册表吃下多生态、多类型的插件，最大化兼容。
 * 做法：统一中间表示（IR）+ 按特征分派 + 保真度分级。
 *
 *   任何来源(JSON清单 / SKILL.md / MCP tools / DeepSeek 生成物 / 浏览器扩展)
 *     → ingestPlugin()  提取「一个包里的全部能力」
 *     → 每个能力翻成 ORB 插件契约 { id, level, run, origin, spec, capabilities }
 *     → 打保真度标签 fidelity：executable / declarative / descriptor
 *     → 真实 pluginHost.register（安全面复用真实 artifactGate）
 *
 * 保真度语义（这就是「尽量全兼容」的关键）：
 *   executable  — 能真跑：MCP 工具 / 生成物 entry / 带脚本的 skill
 *   declarative — 可当上下文/编排用：agent/team 包、纯 prompt skill
 *   descriptor  — 已登记可路由，执行交给宿主原生通道：浏览器扩展、未知清单
 *   （不丢弃任何能解析的清单；不能跨宿主执行的，诚实标 descriptor + 给出路由）
 */

import {
  safeId,
  createPluginHost,
  createArtifactGate,
  ARTIFACT_ORIGINS,
  detectPluginKind,
  adaptAgentPack,
  adaptSkill,
  adaptMcpConnector,
  adaptDeepseekArtifact,
  mcpToolAdapter,
} from "./pluginAdapters.mjs";

export {
  createPluginHost,
  createArtifactGate,
  ARTIFACT_ORIGINS,
  detectPluginKind,
  mcpToolAdapter,
};

export const FIDELITY = Object.freeze({
  EXECUTABLE: "executable",
  DECLARATIVE: "declarative",
  DESCRIPTOR: "descriptor",
});

/* ------------------------------------------------------------------ *
 * 特征探测（一个包可能同时命中多种，故逐个判，不靠单一 kind）
 * ------------------------------------------------------------------ */

const hasAgents = (m) => Array.isArray(m.agents) && m.agents.length > 0 || Boolean(m.expertType);
const isSkill = (m) =>
  m.category === "skill" || Boolean(m.workbuddy && /skill/i.test(String(m.workbuddy.kind || "")));
const isArtifact = (m) => {
  const s = m.spec && typeof m.spec === "object" ? m.spec : m;
  return Boolean(s && s.what && s.entry && Array.isArray(s.how));
};
const isBrowserExt = (m) => Boolean(m.manifest_version && (m.background || m.action));
const mcpServerNames = (m) => {
  const out = [];
  const ext = m.extensions && typeof m.extensions === "object" ? m.extensions : {};
  for (const k of Object.keys(ext)) {
    const node = ext[k];
    if (node && node.policy && node.policy.mcpServers && typeof node.policy.mcpServers === "object") {
      out.push(...Object.keys(node.policy.mcpServers));
    }
  }
  /* 顶层 mcpServers（市场插件常见写法）：内联对象才有服务名，
     字符串是"指向 .mcp.json 的路径"，由读取方先解析成对象再进来。 */
  const top = m.mcpServers;
  if (top && typeof top === "object" && !Array.isArray(top)) out.push(...Object.keys(top));
  return out;
};

/* ------------------------------------------------------------------ *
 * 描述符型适配器（兼容但不假装能执行）
 * ------------------------------------------------------------------ */

/** 浏览器扩展 → 描述符插件：登记 + 路由到 ORB 自有浏览器通道，不伪装跨宿主执行。 */
export function adaptBrowserExtensionDescriptor(manifest, { sourceHash } = {}) {
  const name = String(manifest.name || "browser-extension");
  const perms = Array.isArray(manifest.permissions) ? manifest.permissions.slice() : [];
  return {
    ok: true,
    fidelity: FIDELITY.DESCRIPTOR,
    manifest: {
      id: safeId(`ext-${name}`),
      name,
      level: "A",
      origin: { kind: ARTIFACT_ORIGINS.IMPORTED, sourceHash },
      spec: {
        what: manifest.description || `浏览器扩展 ${name}`,
        entry: `descriptor/browser-extension/${safeId(name)}.route`,
        how: [{ name: "permissions-present", expect: "permissions" }],
      },
      capabilities: [], // 只描述，不自己执行危险动作
      run: () => ({
        ok: true,
        kind: "descriptor",
        source: "browser-extension",
        route: "browser_automation",
        permissions: perms,
        note: "不可跨宿主执行；请路由到 ORB 自有浏览器通道消费同类能力",
      }),
    },
  };
}

/** 未知清单 → 通用描述符：尽量不丢，登记 + 原样暴露元信息。 */
export function adaptUnknownDescriptor(manifest, { sourceHash } = {}) {
  const name = String(manifest.name || manifest.id || "unknown-plugin");
  return {
    ok: true,
    fidelity: FIDELITY.DESCRIPTOR,
    manifest: {
      id: safeId(`unknown-${name}`),
      name,
      level: "A",
      origin: { kind: ARTIFACT_ORIGINS.IMPORTED, sourceHash },
      spec: {
        what: manifest.description || `未识别插件 ${name}`,
        entry: `descriptor/unknown/${safeId(name)}.describe`,
        how: [{ name: "manifest-parseable", expect: "ok" }],
      },
      capabilities: [],
      run: () => ({
        ok: true,
        kind: "descriptor",
        source: "unknown",
        name,
        keys: Object.keys(manifest).slice(0, 32),
        note: "未识别来源，仅登记元信息",
      }),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 统一摄入：一个包 → 多个插件能力
 * ------------------------------------------------------------------ */

/**
 * @param {object} input
 *   manifest?  已解析的插件清单对象
 *   skillMd?   SKILL.md 正文（skill 包）
 *   hasScripts? skill 是否带 scripts/（有则升为 executable）
 * @param {object} ctx  { sourceHash, epoch?, approvedBy? }
 * @returns {{ ok:boolean, kind:string, plugins:Array<{manifest:object,fidelity:string}>, warnings:string[] }}
 */
export function ingestPlugin(input = {}, ctx = {}) {
  const { manifest, skillMd = "", hasScripts = false } = input;
  const sourceHash = ctx.sourceHash;
  const warnings = [];
  const plugins = [];

  if (!manifest || typeof manifest !== "object") {
    return { ok: false, kind: "unknown", plugins: [], warnings: ["manifest-required"] };
  }
  if (!sourceHash) {
    return { ok: false, kind: detectPluginKind(manifest), plugins: [], warnings: ["sourceHash-required"] };
  }

  const push = (res, fidelity) => {
    if (res && res.ok && res.manifest) plugins.push({ manifest: res.manifest, fidelity });
    else if (res && !res.ok) warnings.push(res.error || res.reason || "adapt-failed");
  };

  // 1) 生成物（DeepSeekHarness 三段式）——可执行
  if (isArtifact(manifest)) {
    push(adaptDeepseekArtifact(manifest, { sourceHash, epoch: ctx.epoch }), FIDELITY.EXECUTABLE);
  }

  // 2) MCP connector —— 可执行（MCP 网关）；危险能力需 approvedBy
  const servers = mcpServerNames(manifest);
  if (servers.length) {
    push(adaptMcpConnector(manifest, { sourceHash, approvedBy: ctx.approvedBy || "" }), FIDELITY.EXECUTABLE);
  }

  // 3) skill —— 有脚本可执行，纯 prompt 则声明式
  if (isSkill(manifest) || skillMd) {
    push(
      adaptSkill(manifest, { sourceHash, skillMd }),
      hasScripts ? FIDELITY.EXECUTABLE : FIDELITY.DECLARATIVE,
    );
  }

  // 4) agent/team 包 —— 声明式编排
  if (hasAgents(manifest)) {
    push(adaptAgentPack(manifest, { sourceHash }), FIDELITY.DECLARATIVE);
  }

  // 5) 浏览器扩展 —— 描述符（可路由，不跨宿主）
  if (isBrowserExt(manifest)) {
    push(adaptBrowserExtensionDescriptor(manifest, { sourceHash }), FIDELITY.DESCRIPTOR);
  }

  // 6) 兜底：能解析但上面都没命中 → 通用描述符，尽量不丢
  if (plugins.length === 0) {
    push(adaptUnknownDescriptor(manifest, { sourceHash }), FIDELITY.DESCRIPTOR);
    if (plugins.length) warnings.push("fallback-descriptor");
  }

  return { ok: plugins.length > 0, kind: detectPluginKind(manifest), plugins, warnings };
}

/** 批量安装到真实宿主；逐个过真实闸门。返回每条结果。 */
export function installAll(host, entries, ctx = {}) {
  const results = [];
  for (const e of entries) {
    const reg = host.register({ ...e.manifest, fidelity: e.fidelity });
    results.push({ id: e.manifest.id, fidelity: e.fidelity, ...reg });
    // 可选：装完即跑一次自检（默认不跑，避免副作用）
    if (ctx.selfTest) {
      try {
        results[results.length - 1].selfTest = host.run(e.manifest.id, {});
      } catch (err) {
        results[results.length - 1].selfTest = { ok: false, error: String((err && err.message) || err) };
      }
    }
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * 桥侧入口：干跑（只判不装）与安装（判完即装）
 *
 * 两者共用同一条 ingest 路径，所以「校验通过」与「装得上」不会各说各话：
 * 干跑用的就是安装时那套清单，差别只在最后要不要写进注册表。
 * ------------------------------------------------------------------ */

/** 只判定、不落注册表：给界面的「校验」用，回的是"如果装会得到什么"。 */
export function dryRunManifest(gate, input = {}, ctx = {}) {
  const ing = ingestPlugin(input, ctx);
  if (!ing.ok) {
    return { ok: false, kind: ing.kind, sourceHash: ctx.sourceHash || "", warnings: ing.warnings, plugins: [] };
  }
  const plugins = ing.plugins.map((e) => {
    const v = gate.validate(e.manifest, { approvedBy: ctx.approvedBy || "" });
    return {
      id: e.manifest.id,
      name: e.manifest.name,
      fidelity: e.fidelity,
      ok: Boolean(v && v.ok),
      code: (v && v.code) || "",
      reasons: (v && v.reasons) || [],
    };
  });
  return {
    ok: plugins.length > 0 && plugins.every((p) => p.ok),
    kind: ing.kind,
    sourceHash: ctx.sourceHash || "",
    warnings: ing.warnings,
    plugins,
  };
}

/** 判定 + 安装：逐条过真实闸门，任何一条不过都不进注册表（其余照装）。 */
export function installManifest(host, input = {}, ctx = {}) {
  const ing = ingestPlugin(input, ctx);
  if (!ing.ok) {
    return { ok: false, kind: ing.kind, sourceHash: ctx.sourceHash || "", warnings: ing.warnings, plugins: [] };
  }
  const plugins = installAll(host, ing.plugins, ctx);
  return {
    ok: plugins.some((p) => p.ok),
    kind: ing.kind,
    sourceHash: ctx.sourceHash || "",
    warnings: ing.warnings,
    plugins,
  };
}
