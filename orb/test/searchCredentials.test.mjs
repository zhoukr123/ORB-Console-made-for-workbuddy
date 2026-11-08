/* 批次C · 可插拔凭据来源单测。
 * 核心判据：默认 inert、不读本机 dsh 凭据库、不读账号平台签发的那把 key，
 * 零外发零计费；describe() 绝不泄露 key；桥确实接了这个来源。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCredentialProvider, CREDENTIAL_SOURCES, DEFAULT_CREDENTIAL_SOURCE,
} from "../searchCredentials.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "searchCredentials.mjs"), "utf8");
const BRIDGE = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");
const PACK = fs.readFileSync(path.join(ROOT, "pack.cjs"), "utf8");

test("默认 inert：不启用、无 key、零外发，且不碰 dsh 凭据", () => {
  const p = createCredentialProvider({ env: {} });
  const d = p.describe();
  assert.equal(d.enabled, false);
  assert.equal(d.source, "inert");
  assert.equal(d.hasKey, false);
  assert.equal(d.dshCredentialUsed, false);
  assert.equal(d.zeroOutboundByDefault, true);
  assert.equal(p.resolve().apiKey, "");
});

test("总开关关闭时，即使环境变量里有 key 也不读", () => {
  const p = createCredentialProvider({
    enabled: false, source: "env",
    env: { ORB_SEARCH_API_KEY: "FAKE-KEY-FOR-TEST-ONLY" },
  });
  assert.equal(p.resolve().apiKey, "");
  assert.equal(p.resolve().source, "inert");
  assert.equal(p.describe().hasKey, false);
});

test("未知来源一律 fail-closed 回落 inert，绝不自动挑一个可用的", () => {
  for (const s of ["dsh-home", "credentials-file", "ENV", "deepseek", "auto"]) {
    const p = createCredentialProvider({ enabled: true, source: s, env: { ORB_SEARCH_API_KEY: "FAKE" } });
    assert.equal(p.describe().supported, false, s);
    assert.equal(p.describe().source, "inert", s);
    assert.equal(p.resolve().apiKey, "", s);
  }
  assert.deepEqual(CREDENTIAL_SOURCES, ["inert", "env"]);
  assert.equal(DEFAULT_CREDENTIAL_SOURCE, "inert");
});

test("env 是唯一登记的来源，只认用户显式设置的那个变量", () => {
  const p = createCredentialProvider({
    enabled: true, source: "env",
    env: {
      ORB_SEARCH_API_KEY: "FAKE-KEY-FOR-TEST-ONLY",
      /* 账号平台签发的凭据即使出现在环境里，也绝不能被这个来源取用。 */
      DEEPSEEK_API_KEY: "MUST-NOT-BE-USED",
      CSCS_API_KEY: "MUST-NOT-BE-USED",
    },
  });
  const r = p.resolve();
  assert.equal(r.source, "env");
  assert.equal(r.hasKey, true);
  assert.equal(r.apiKey, "FAKE-KEY-FOR-TEST-ONLY");
});

test("describe() 只回布尔与来源名，绝不把 key 放进返回值", () => {
  const p = createCredentialProvider({
    enabled: true, source: "env",
    env: { ORB_SEARCH_API_KEY: "SUPER-SECRET-TEST-VALUE" },
  });
  const dumped = JSON.stringify(p.describe());
  assert.ok(!dumped.includes("SUPER-SECRET-TEST-VALUE"));
  assert.ok(!dumped.includes("apiKey"));
  assert.equal(p.describe().dshCredentialUsed, false);
});

test("源码静态锁：不读文件、不碰凭据库、不引用账号平台签发的变量", () => {
  for (const forbidden of [
    "readFileSync", "node:fs", "credentialFromHome",
    ".credentials.yaml", "DEEPSEEK_API_KEY", "CSCS_API_KEY",
  ]) {
    assert.ok(!SRC.includes(forbidden), `凭据模块不该出现 ${forbidden}`);
  }
});

test("桥已接到可插拔来源，且不再直接从环境读 apiKey", () => {
  assert.match(BRIDGE, /createCredentialProvider\(\{/);
  assert.match(BRIDGE, /apiKey:\s*searchCredentials\.resolve\(\)\.apiKey/);
  assert.ok(!BRIDGE.includes('apiKey: process.env.ORB_SEARCH_API_KEY || ""'),
    "旧写法会绕过凭据来源闸门");
  assert.match(BRIDGE, /offlineFixtureEnabled:\s*SEARCH_OFFLINE_FIXTURE/);
});

test("新端点统一鉴权、不进 PUBLIC_PATHS，且两个新模块都在打包清单", () => {
  const pub = BRIDGE.match(/const PUBLIC_PATHS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(pub);
  assert.ok(!pub[1].includes("search"), "检索类端点不能免鉴权");
  assert.match(BRIDGE, /url\.pathname === "\/api\/search\/to-doc" && req\.method === "POST"/);
  assert.match(PACK, /'searchCredentials\.mjs'/);
  assert.match(PACK, /'searchOrchestrator\.mjs'/);
});
