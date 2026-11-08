/* 便携版打包清单防漂移（开发态即可跑，不必真打几百 MB 的包）。
 *
 * 背景：pack.cjs 的 BRIDGE_LOCAL 是**硬编码**清单，而 bridge.mjs 顶层静态
 * import 任何新模块时，开发态永远正常（文件就在旁边），打包态却会
 * ERR_MODULE_NOT_FOUND —— 2026-10-15 加 runtime.mjs 时真踩过一次。
 * pack.cjs 里已有一段「打包后审计」，但那要等包出来才发现；这里把同一条
 * 判据前移到单测，新增本地依赖没登记就直接测挂。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");
const PACK = fs.readFileSync(path.join(ROOT, "pack.cjs"), "utf8");

/** 与 pack.cjs:340-341 完全同款的两条正则，从消费方反推依赖。 */
function bridgeLocalImports() {
  const rel = new Set();
  for (const m of BRIDGE.matchAll(/from\s+["']\.\/([\w.\-/]+)["']/g)) rel.add(m[1]);
  for (const m of BRIDGE.matchAll(/import\(\s*["']\.\/([\w.\-/]+)["']\s*\)/g)) rel.add(m[1]);
  return [...rel].sort();
}

function arrayBlock(name) {
  const from = PACK.indexOf(`const ${name} = [`);
  assert.ok(from >= 0, `pack.cjs 找不到 ${name}`);
  const to = PACK.indexOf("\n];", from);
  assert.ok(to > from, `pack.cjs 的 ${name} 没找到结束标记`);
  return [...PACK.slice(from, to).matchAll(/'([^']+\.[\w]+)'/g)].map((m) => m[1]);
}

const BRIDGE_LOCAL = arrayBlock("BRIDGE_LOCAL");
const APP_FILES = arrayBlock("APP_FILES");

test("BRIDGE_LOCAL 覆盖了 bridge.mjs 的全部相对本地依赖", () => {
  const rel = bridgeLocalImports();
  assert.ok(rel.length > 20, `只扫到 ${rel.length} 个相对导入，正则可能失效`);
  const listed = new Set([...BRIDGE_LOCAL, ...APP_FILES]);
  const missing = rel.filter((r) => !listed.has(r));
  assert.deepEqual(missing, [],
    `这些模块被 bridge.mjs 引用却没登记进 pack.cjs，打包版会 ERR_MODULE_NOT_FOUND：${missing.join(", ")}`);
});

test("本轮新增的三个模块都在打包清单里（报告A P0 / 批次A / 批次B）", () => {
  for (const f of ["appIntent.mjs", "batchA.mjs", "searchL4.mjs"]) {
    assert.ok(BRIDGE_LOCAL.includes(f), `${f} 必须进 BRIDGE_LOCAL`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} 源文件必须存在`);
  }
});

test("批次 C 新增的三个模块都在打包清单里（凭据来源 / 编排 / 适配器）", () => {
  for (const f of ["searchCredentials.mjs", "searchOrchestrator.mjs", "searchProviderAdapters.mjs"]) {
    assert.ok(BRIDGE_LOCAL.includes(f), `${f} 必须进 BRIDGE_LOCAL`);
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} 源文件必须存在`);
  }
});

test("清单里登记的每个桥侧模块都真实存在，且没有重复登记", () => {
  assert.equal(new Set(BRIDGE_LOCAL).size, BRIDGE_LOCAL.length, "BRIDGE_LOCAL 有重复项");
  for (const f of BRIDGE_LOCAL) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `登记了但源文件不存在：${f}`);
  }
});

test("APP_FILES 登记的每个应用文件都真实存在（发布版不会 MODULE_NOT_FOUND）", () => {
  /* pack.cjs:230 逐个 fs.existsSync 检查，缺一个就 process.exit(1)。
     这里在开发态前移同一条判据，新增 desktop 侧模块没登记也能立刻发现。 */
  for (const f of APP_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, "desktop", f)), `登记了但源文件不存在：desktop/${f}`);
  }
  assert.ok(APP_FILES.includes("searchToolConfig.cjs"), "检索工具配置模块必须随包");
  assert.ok(APP_FILES.includes("searchProbe.cjs"), "检索工具测试按钮的探测模块必须随包");
});

test("pack.cjs 仍保留打包后的本地依赖审计（双保险）", () => {
  assert.match(PACK, /桥进程引用了未打包的本地模块/);
  assert.match(PACK, /把它们加进 pack\.cjs 的 BRIDGE_LOCAL/);
});
