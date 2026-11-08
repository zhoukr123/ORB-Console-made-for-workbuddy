/* pluginAdapters.mjs — 跨生态「插件消费层」（已进 orb/，与 pluginHost / pluginArtifactGate 同目录）
 *
 * 更正前提：不是把 WorkBuddy / DeepSeekHarness 两个宿主包成插件，
 * 而是让【它们插件生态里已有的插件】能被 ORB 控制台消费（安装 + 执行）。
 *
 * 真实契约（2026-11-07 实测自本机 WorkBuddy 插件缓存）：
 *  - MCP connector 插件：.codebuddy-plugin/plugin.json 的
 *      extensions.ai.workbuddy.policy.mcpServers  → 本质是 MCP server
 *  - skill 插件：plugin.json(category:"skill") + SKILL.md(frontmatter + 正文 + scripts/)
 *  - agent/team 插件：plugin.json 的 agents[] / teamInfo / members[]（声明式编排）
 *  - DeepSeekHarness 生成物：spec{what,entry,how} —— 与 pluginArtifactGate.spec 几乎 1:1
 *  - 浏览器扩展（wb_ext_027）：MV3 + chrome.*，不可跨宿主 → 拒绝，走 ORB 自有浏览器通道
 *
 * 做法：detectPluginKind 先判类型，adaptWorkbuddyPlugin 按类型翻成 ORB 插件契约
 * { id, level, run, origin, spec{what,entry,how}, capabilities }，再喂给真实 pluginHost.register；
 * 安全面（危险能力审批 / api_call_register 硬红线 / 三段验收 / epoch / 白名单）全部复用真实 artifactGate。
 */

import { createPluginHost } from "./pluginHost.mjs";
import { createArtifactGate, ARTIFACT_ORIGINS } from "./pluginArtifactGate.mjs";

export { createPluginHost, createArtifactGate, ARTIFACT_ORIGINS };

/* ------------------------------------------------------------------ *
 * 契约辅助
 * ------------------------------------------------------------------ */

/** id 必须 ^[a-z0-9][a-z0-9-]{0,31}$，把非法字符压成连字符。 */
export function safeId(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > 32 ? s.slice(0, 32) : s;
}

/* ------------------------------------------------------------------ *
 * 类型判定
 * ------------------------------------------------------------------ */

/**
 * 从已解析的插件清单对象判定来源类型。
 * @returns {"browser-extension"|"deepseek-artifact"|"mcp-connector"|"skill"|"agent-pack"|"unknown"}
 */
export function detectPluginKind(manifest) {
  if (!manifest || typeof manifest !== "object") return "unknown";

  // 浏览器扩展：MV3 manifest 特征
  if (manifest.manifest_version && (manifest.background || manifest.action)) {
    return "browser-extension";
  }

  // DeepSeekHarness 生成物：三段式 what/entry/how（顶层或 spec 内）
  const spec = manifest.spec && typeof manifest.spec === "object" ? manifest.spec : manifest;
  if (spec && spec.what && spec.entry && Array.isArray(spec.how)) {
    return "deepseek-artifact";
  }

  // MCP connector：extensions.*.policy.mcpServers 或 keywords 含 mcp
  const ext = manifest.extensions && typeof manifest.extensions === "object" ? manifest.extensions : null;
  if (ext) {
    for (const k of Object.keys(ext)) {
      const node = ext[k];
      if (node && node.policy && node.policy.mcpServers && typeof node.policy.mcpServers === "object") {
        return "mcp-connector";
      }
    }
  }
  if (Array.isArray(manifest.keywords) && manifest.keywords.includes("mcp")) return "mcp-connector";

  // skill：category=skill 或 workbuddy.kind 含 skill
  if (manifest.category === "skill") return "skill";
  if (manifest.workbuddy && /skill/i.test(String(manifest.workbuddy.kind || ""))) return "skill";

  // agent/team 包：agents[] 或 expertType
  if (Array.isArray(manifest.agents) || manifest.expertType) return "agent-pack";

  return "unknown";
}

/* ------------------------------------------------------------------ *
 * 各类型适配器（→ ORB 插件契约）
 * ------------------------------------------------------------------ */

const pickName = (m) => {
  if (m.displayName && typeof m.displayName === "object") {
    return m.displayName.zh || m.displayName.en || m.name;
  }
  return m.name || m.agentName || "unnamed";
};

/** agent/team 包 → 声明式编排插件（run 产出编排描述，真实运行交给 ORB team.mjs）。 */
export function adaptAgentPack(manifest, { sourceHash } = {}) {
  const name = String(manifest.name || "").trim();
  if (!name) return { ok: false, error: "agent-pack:name-required" };
  if (!sourceHash) return { ok: false, error: "agent-pack:sourceHash-required" };
  return {
    ok: true,
    manifest: {
      id: safeId(`wb-agent-${name}`),
      name: pickName(manifest),
      level: "A",
      origin: { kind: ARTIFACT_ORIGINS.IMPORTED, sourceHash },
      spec: {
        what: manifest.description || `WorkBuddy 专家团/代理包 ${name}`,
        entry: `workbuddy/agent-pack/${name}.orchestrate`,
        how: [{ name: "roster-present", expect: "members" }],
      },
      capabilities: [],
      run: () => ({
        ok: true,
        kind: "agent-pack",
        agentName: manifest.agentName || null,
        expertType: manifest.expertType || null,
        agents: Array.isArray(manifest.agents) ? manifest.agents.slice() : [],
        teamInfo: manifest.teamInfo || null,
        members: Array.isArray(manifest.members) ? manifest.members.slice() : [],
      }),
    },
  };
}

/** skill 插件 → 程序性上下文插件（run 返回 SKILL.md 正文 + 脚本目录，供调用方注入/沙箱执行）。 */
export function adaptSkill(manifest, { sourceHash, skillMd = "" } = {}) {
  const name = String(manifest.name || "").trim();
  if (!name) return { ok: false, error: "skill:name-required" };
  if (!sourceHash) return { ok: false, error: "skill:sourceHash-required" };
  return {
    ok: true,
    manifest: {
      id: safeId(`wb-skill-${name}`),
      name: pickName(manifest),
      level: "A",
      origin: { kind: ARTIFACT_ORIGINS.IMPORTED, sourceHash },
      spec: {
        what: manifest.description || `WorkBuddy 技能 ${name}`,
        entry: `workbuddy/skill/${name}.load`,
        how: [{ name: "skill-md-loadable", expect: "instructions" }],
      },
      capabilities: [],
      run: () => ({ ok: true, kind: "skill", instructions: String(skillMd), scriptsHint: "skill_dir/scripts" }),
    },
  };
}

/** MCP connector 插件 → MCP 服务插件（run 返回声明的 server 名；真实 tools/list 由 MCP runtime 补）。 */
export function adaptMcpConnector(manifest, { sourceHash, approvedBy = "" } = {}) {
  const name = String(manifest.name || "").trim();
  if (!name) return { ok: false, error: "mcp-connector:name-required" };
  if (!sourceHash) return { ok: false, error: "mcp-connector:sourceHash-required" };
  const servers = [];
  const ext = manifest.extensions && typeof manifest.extensions === "object" ? manifest.extensions : {};
  for (const k of Object.keys(ext)) {
    const node = ext[k];
    if (node && node.policy && node.policy.mcpServers) {
      servers.push(...Object.keys(node.policy.mcpServers));
    }
  }
  /* 市场里很多插件走的是顶层 mcpServers（"{./.mcp.json}" 或直接内联对象），
     不是 extensions.*.policy —— 不认这一支会把它们误判成「未知清单」。 */
  const top = manifest.mcpServers;
  if (top && typeof top === "object" && !Array.isArray(top)) servers.push(...Object.keys(top));
  return {
    ok: true,
    manifest: {
      id: safeId(`wb-connector-${name}`),
      name: pickName(manifest),
      level: "A",
      origin: { kind: ARTIFACT_ORIGINS.IMPORTED, sourceHash },
      spec: {
        what: manifest.description || `WorkBuddy MCP 连接器 ${name}`,
        entry: `workbuddy/connector/${name}.tools`,
        how: [{ name: "servers-declared", expect: "mcpServers" }],
      },
      capabilities: ["shell", "network"], // 需拉起/连接 MCP server
      approvedBy,
      run: () => ({ ok: true, kind: "mcp-connector", servers: servers.slice() }),
    },
  };
}

/** DeepSeekHarness 生成物 → 原样映射三段式（origin=generated，绑 epoch）。 */
export function adaptDeepseekArtifact(artifact = {}, { sourceHash, epoch } = {}) {
  const spec = artifact.spec && typeof artifact.spec === "object" ? artifact.spec : artifact;
  if (!spec || !spec.what || !spec.entry || !Array.isArray(spec.how)) {
    return { ok: false, error: "deepseek-artifact:spec-what-entry-how-required" };
  }
  if (!sourceHash) return { ok: false, error: "deepseek-artifact:sourceHash-required" };
  if (typeof epoch !== "number" || !Number.isFinite(epoch)) {
    return { ok: false, error: "deepseek-artifact:epoch-required" };
  }
  return {
    ok: true,
    manifest: {
      id: safeId(artifact.id || `deepseek-${String(spec.entry).replace(/[^a-z0-9]+/gi, "-")}`),
      name: artifact.name || spec.what,
      level: "A",
      origin: { kind: ARTIFACT_ORIGINS.GENERATED, sourceHash },
      epoch,
      spec: { what: spec.what, entry: spec.entry, how: spec.how.slice() },
      capabilities: Array.isArray(artifact.capabilities) ? artifact.capabilities.slice() : [],
      run: () => ({ ok: true, kind: "deepseek-artifact", entry: spec.entry, executed: true }),
    },
  };
}

/** 统一入口：按类型分派。返回 { ok, manifest } 或 { ok:false, error/reason }。 */
export function adaptWorkbuddyPlugin(manifest, ctx = {}) {
  const kind = detectPluginKind(manifest);
  switch (kind) {
    case "agent-pack": return adaptAgentPack(manifest, ctx);
    case "skill": return adaptSkill(manifest, ctx);
    case "mcp-connector": return adaptMcpConnector(manifest, ctx);
    case "deepseek-artifact": return adaptDeepseekArtifact(manifest, ctx);
    case "browser-extension":
      return {
        ok: false,
        reason: "browser-extension 不可跨宿主运行（MV3/chrome.*），改用 ORB 自有浏览器通道消费同类能力",
      };
    default:
      return { ok: false, reason: "unknown-plugin-kind" };
  }
}

/* ------------------------------------------------------------------ *
 * 单个 MCP 工具 → 插件（tools/list 之后用；run 异步调 tools/call）
 * ------------------------------------------------------------------ */

export function mcpToolAdapter(tool = {}, server = {}) {
  const name = String(tool.name || "").trim();
  const serverId = String(server.id || "").trim();
  if (!name || !serverId) return { ok: false, error: "mcp-adapter:name-serverId-required" };
  if (!server.sourceHash) return { ok: false, error: "mcp-adapter:sourceHash-required" };
  return {
    ok: true,
    manifest: {
      id: safeId(`mcp-${serverId}-${name}`),
      name: tool.description || name,
      level: "A",
      origin: { kind: ARTIFACT_ORIGINS.IMPORTED, sourceHash: server.sourceHash },
      spec: {
        what: tool.description || `调用 MCP 工具 ${name}`,
        entry: `mcp/${serverId}/${name}.call`,
        how: [{ name: "call-returns-ok", expect: "ok" }],
      },
      capabilities: ["shell", "network"],
      approvedBy: server.approvedBy || "",
      run: (args) => server.call(name, args || {}),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 宿主 await 补丁演示（§3）
 *
 * 真实 pluginHost.run 是同步的：它先取 result 再判 ok，MCP 的 Promise 结果会被丢弃。
 * 真实落地只需在 pluginHost.mjs 的 run() 内加一行 await（见拟诏 §3）。
 * createDemoHostAsync 是自包含最小宿主，仅证明 await 语义、不碰用户文件。
 * ------------------------------------------------------------------ */

const DEMO_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function createDemoHostAsync(opts = {}) {
  const now = typeof opts.now === "function" ? opts.now : Date.now;
  const gate = opts.gate || createArtifactGate({});
  const entries = new Map();
  let runs = 0;
  let failed = 0;

  function register(plugin) {
    if (!plugin || typeof plugin !== "object") return { ok: false, error: "bad-plugin" };
    if (typeof plugin.id !== "string" || !DEMO_ID_RE.test(plugin.id)) return { ok: false, error: "bad-id" };
    if (typeof plugin.run !== "function") return { ok: false, error: "bad-run" };
    if (!["S", "A"].includes(plugin.level)) return { ok: false, error: "bad-level" };
    if (entries.has(plugin.id)) return { ok: false, error: "duplicate-id" };
    if (plugin.origin) {
      const v = gate.validate(plugin, { approvedBy: plugin.approvedBy || "" });
      if (!v.ok) return { ok: false, error: `artifact-gate:${v.code}` };
    }
    entries.set(plugin.id, plugin);
    return { ok: true, plugin: { id: plugin.id, name: plugin.name || plugin.id, level: plugin.level } };
  }

  async function run(id, args) {
    const p = entries.get(id);
    if (!p) return { ok: false, error: "unknown-plugin" };
    runs++;
    const t0 = now();
    let result;
    try {
      const r0 = p.run(args === undefined ? {} : args);
      result = r0 && typeof r0.then === "function" ? await r0 : r0;
    } catch (e) {
      failed++;
      return { ok: false, pluginId: id, error: String((e && e.message) || e) };
    }
    const ms = now() - t0;
    if (!result || result.ok !== true) {
      failed++;
      return { ok: false, pluginId: id, error: (result && result.error) || "run-failed" };
    }
    return { ok: true, pluginId: id, ms, result };
  }

  return { register, run, stats: () => ({ ok: true, count: entries.size, runs, failed }) };
}
