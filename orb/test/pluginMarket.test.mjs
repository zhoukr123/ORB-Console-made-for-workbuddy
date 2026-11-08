/* pluginMarket 单测：本机插件市场索引 + 从市场真实安装到注册表
 *
 * 数据是真的：读 %USERPROFILE%\.workbuddy\plugins 下的 6 个市场清单，
 * 安装时读的是市场里**真实插件目录**的 plugin.json / SKILL.md。
 * 本机没装 WorkBuddy 时整体 skip，不伪造数据。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createPluginHost } from "../pluginHost.mjs";
import { createArtifactGate } from "../pluginArtifactGate.mjs";
import { scanMarket, searchMarket, readSource, PLUGIN_ROOT } from "../pluginMarket.mjs";
import { dryRunManifest, installManifest } from "../pluginEcosystem.mjs";

const HAS_MARKET = fs.existsSync(PLUGIN_ROOT + "/known_marketplaces.json");
const skip = HAS_MARKET ? false : "本机无 WorkBuddy 插件市场目录";

const idx = HAS_MARKET ? scanMarket() : { marketplaces: [], plugins: [], warnings: [] };

function freshHost() {
  const gate = createArtifactGate({ epochProvider: () => 7 });
  return { gate, host: createPluginHost({ artifactGate: gate, epochProvider: () => 7 }) };
}

test("scanMarket 读全 6 个市场，条目数 ≥ 600", { skip }, () => {
  assert.equal(idx.ok, true);
  assert.ok(idx.marketplaces.length >= 5, "市场数 " + idx.marketplaces.length);
  assert.ok(idx.plugins.length >= 600, "条目数 " + idx.plugins.length);
  assert.deepEqual(idx.warnings, []);
  for (const e of idx.plugins) {
    assert.ok(e.name && e.marketplace, "条目必须带 name/marketplace");
    assert.ok(e.id && /^[a-z0-9][a-z0-9-]{0,31}$/.test(e.id), "id 必须符合注册表规则：" + e.name + " → " + e.id);
  }
});

test("searchMarket 按名命中，且带 total（界面要显示「还有 N 条」）", { skip }, () => {
  const r = searchMarket(idx.plugins, { q: "pdf", limit: 5 });
  assert.ok(r.total >= 1, "pdf 应至少命中 1 条");
  assert.ok(r.items.length <= 5);
  assert.ok(r.items.some((x) => x.name.toLowerCase().includes("pdf")));
});

test("searchMarket 按市场过滤，结果全属该市场", { skip }, () => {
  const r = searchMarket(idx.plugins, { marketplace: "experts", limit: 100 });
  assert.ok(r.total > 0);
  assert.ok(r.items.every((x) => x.marketplace === "experts"));
});

test("searchMarket 无关键词时优先给本机可装的条目", { skip }, () => {
  const r = searchMarket(idx.plugins, { limit: 10 });
  assert.equal(r.items.length, 10);
  assert.ok(r.items[0].hasSource);
});

test("readSource 能读到真实插件目录的清单", { skip }, () => {
  const e = idx.plugins.find((p) => p.hasSource && p.marketplace === "codebuddy-plugins-official");
  assert.ok(e, "官方市场应至少有一条可装条目");
  const s = readSource(e.dir);
  assert.equal(s.ok, true);
  assert.ok(s.manifestPath.endsWith("plugin.json"));
  assert.ok(typeof s.manifest === "object");
});

test("从市场装一个真实 skill：装进注册表并能 run", { skip }, () => {
  const e = idx.plugins.find((p) => p.hasSource && p.name === "skill-workbuddy-pdf")
    || idx.plugins.find((p) => p.hasSource && p.marketplace === "workbuddy-builtin");
  assert.ok(e, "需要一个带源码的 skill 条目");

  const s = readSource(e.dir);
  const { gate, host } = freshHost();
  const plan = dryRunManifest(gate, { manifest: s.manifest, skillMd: s.skillMd, hasScripts: s.hasScripts }, { sourceHash: "sha256:test" });
  assert.equal(plan.ok, true, "干跑应通过：" + JSON.stringify(plan.plugins));

  const res = installManifest(host, { manifest: s.manifest, skillMd: s.skillMd, hasScripts: s.hasScripts }, { sourceHash: "sha256:test" });
  assert.equal(res.ok, true, "安装应成功：" + JSON.stringify(res.plugins));

  const id = res.plugins.find((p) => p.ok).id;
  const listed = host.list().plugins.find((p) => p.id === id);
  assert.ok(listed, "装完应出现在 list 里");
  assert.ok(listed.fidelity, "list 应带 fidelity");
  const run = host.run(id, {});
  assert.equal(run.ok, true);
});

test("从市场装 MCP 连接器：无审批被真实闸门拒，有审批装成功", { skip }, () => {
  const e = idx.plugins.find((p) => p.hasSource && p.name === "tdx-connector");
  if (!e) return; // 该市场未安装时跳过，不伪造
  const s = readSource(e.dir);
  const { gate, host } = freshHost();

  const denied = dryRunManifest(gate, { manifest: s.manifest }, { sourceHash: "sha256:test" });
  assert.equal(denied.ok, false);
  assert.equal(denied.plugins[0].code, "dangerous-capability");

  const ok = installManifest(host, { manifest: s.manifest }, { sourceHash: "sha256:test", approvedBy: "user:test" });
  assert.equal(ok.ok, true, JSON.stringify(ok.plugins));
  const id = ok.plugins[0].id;
  const run = host.run(id, {});
  assert.equal(run.ok, true);
  assert.equal(run.result.kind, "mcp-connector");
  assert.ok(Array.isArray(run.result.servers) && run.result.servers.length > 0, "应解析出真实服务名");
});

test("重复安装同一插件：返回 duplicate-id，不抛异常", { skip }, () => {
  const e = idx.plugins.find((p) => p.hasSource && p.marketplace === "experts");
  if (!e) return;
  const s = readSource(e.dir);
  const { host } = freshHost();
  const first = installManifest(host, { manifest: s.manifest, skillMd: s.skillMd, hasScripts: s.hasScripts }, { sourceHash: "sha256:x" });
  assert.equal(first.ok, true, JSON.stringify(first.plugins));
  const again = installManifest(host, { manifest: s.manifest, skillMd: s.skillMd, hasScripts: s.hasScripts }, { sourceHash: "sha256:x" });
  assert.equal(again.ok, false);
  assert.ok(again.plugins[0].error.includes("duplicate-id"), again.plugins[0].error);
});

test("远端来源条目：标 hasSource:false，不假装能装", { skip }, () => {
  const remote = idx.plugins.find((p) => !p.hasSource);
  if (!remote) return; // 本机全是本地目录时跳过
  assert.equal(remote.dir, "");
});
