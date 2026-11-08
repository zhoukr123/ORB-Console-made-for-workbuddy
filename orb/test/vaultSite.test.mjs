/* vault 站点库单测：credentialAlias 与 cleanSite 白名单投影。
 * vault.js 是 CJS，cryptoApi() 在调用时才 require("electron")；纯 Node 环境取不到，
 * 所以先用 Module._load 拦截 "electron" 注入可逆的假 safeStorage（Buffer 与 utf8 互转），
 * 再用 createRequire 加载模块。临时库文件放在 os.tmpdir() 下，after 里统一清理。
 * 独立运行：node --test test/vaultSite.test.mjs */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const here = path.dirname(fileURLToPath(import.meta.url));
const vaultPath = path.resolve(here, "../desktop/vault.js");

/* 可逆替身：密文就是 base64(utf8(JSON))，便于测试手工往密文库里塞脏字段。 */
let encAvailable = true;
const fakeSafeStorage = {
  isEncryptionAvailable: () => encAvailable,
  encryptString: (s) => Buffer.from(String(s), "utf8"),
  decryptString: (b) => Buffer.from(b).toString("utf8"),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "electron") return { safeStorage: fakeSafeStorage };
  return originalLoad.call(this, request, parent, isMain);
};

const vault = require(vaultPath);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-vault-site-"));
let seq = 0;

/* 每个用例绑定一个独立的库文件，避免共享单例下的互相干扰。 */
function useFile() {
  const f = path.join(tmpDir, "vault-" + ++seq + ".bin");
  vault.init({ file: () => f, log: () => {} });
  return f;
}

/* 直接写密文（与假 encryptString 的输出格式一致），用于构造旧数据或脏数据。 */
function seed(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(JSON.stringify(obj), "utf8").toString("base64"), "utf8");
}

/* 绕过 vault 读回明文，用于断言写盘后的实际内容。 */
function plain(f) {
  const b64 = fs.readFileSync(f, "utf8");
  return JSON.parse(Buffer.from(b64.trim(), "base64").toString("utf8"));
}

after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("addSite 保存 credentialAlias 且可读回", () => {
  const f = useFile();
  const alias = "Bitwarden · GitHub 条目";
  const r = vault.addSite({ origin: "https://github.com", user: "alice", credentialAlias: alias });
  assert.equal(r.ok, true);
  assert.equal(r.site.credentialAlias, alias);
  assert.equal(vault.listSites()[0].credentialAlias, alias);
  assert.equal(plain(f).sites[0].credentialAlias, alias);
});

test("credentialAlias 超过 120 字被截断", () => {
  const f = useFile();
  const long = "a".repeat(200);
  const r = vault.addSite({ origin: "https://long.com", credentialAlias: long });
  assert.equal(r.ok, true);
  assert.equal(r.site.credentialAlias.length, 120);
  assert.equal(vault.listSites()[0].credentialAlias.length, 120);
  assert.equal(plain(f).sites[0].credentialAlias.length, 120);
});

test("updateSite 能修改 credentialAlias", () => {
  const f = useFile();
  const a = vault.addSite({ origin: "https://a.com", credentialAlias: "旧别名" });
  assert.equal(a.ok, true);
  const r = vault.updateSite(a.site.id, { credentialAlias: "新别名" });
  assert.equal(r.ok, true);
  assert.equal(r.site.credentialAlias, "新别名");
  assert.equal(vault.listSites()[0].credentialAlias, "新别名");
  assert.equal(plain(f).sites[0].credentialAlias, "新别名");
});

test("旧数据缺 credentialAlias 时读出空字符串", () => {
  const f = useFile();
  seed(f, {
    version: 1,
    sites: [{ id: "old1", origin: "https://old.com", user: "bob", note: "", createdAt: 1, lastUsedAt: 0 }],
    vision: {},
  });
  const list = vault.listSites();
  assert.equal(list.length, 1);
  assert.equal(list[0].credentialAlias, "");
  /* 对外字段集合恰好是 7 个约定字段 */
  assert.deepEqual(Object.keys(list[0]).sort(),
    ["id", "origin", "user", "note", "credentialAlias", "createdAt", "lastUsedAt"].sort());
});

test("read 白名单投影丢弃 password，且任意 write 后明文不再含 password", () => {
  const f = useFile();
  seed(f, {
    version: 1,
    sites: [{ id: "p1", origin: "https://secret.com", user: "u", note: "n",
      credentialAlias: "", createdAt: 1, lastUsedAt: 0, password: "hunter2", apiKey: "k" }],
    vision: {},
  });

  const list = vault.listSites();
  assert.equal(list.length, 1);
  assert.ok(!("password" in list[0]));
  assert.ok(!("apiKey" in list[0]));
  assert.ok(!JSON.stringify(list).includes("hunter2"));

  /* 第一次 write：touchSite 内部 read -> write */
  assert.equal(vault.touchSite("p1").ok, true);
  let obj = plain(f);
  assert.ok(!("password" in obj.sites[0]));
  assert.ok(!JSON.stringify(obj).includes("hunter2"));

  /* 第二次 write：新增站点同样会 read -> write */
  assert.equal(vault.addSite({ origin: "https://new.com" }).ok, true);
  obj = plain(f);
  assert.ok(!JSON.stringify(obj).includes("password"));
  assert.ok(!JSON.stringify(obj).includes("hunter2"));
  assert.ok(!JSON.stringify(obj).includes("apiKey"));
});

test("addSite 误传 password 被丢弃", () => {
  const f = useFile();
  const r = vault.addSite({ origin: "https://drop.com", user: "u", password: "x" });
  assert.equal(r.ok, true);
  assert.ok(!("password" in r.site));
  assert.ok(!("password" in vault.listSites()[0]));
  assert.ok(!JSON.stringify(plain(f)).includes("password"));
});

test("normalizeOrigin 拒绝 javascript: 与非 http(s) 网址", () => {
  const f = useFile();
  /* 先确认合法网址能成功，避免把「全部被拒」误当成通过 */
  assert.equal(vault.addSite({ origin: "https://ok.com" }).ok, true);
  const bads = ["javascript:alert(1)", "javascript://foo", "ftp://example.com", "file:///etc/passwd", "data:text/html,x"];
  for (const bad of bads) {
    assert.equal(vault.addSite({ origin: bad }).ok, false, "应拒绝: " + bad);
  }
  assert.equal(plain(f).sites.length, 1);
});

test("touchSite 确实更新 lastUsedAt", () => {
  const f = useFile();
  const a = vault.addSite({ origin: "https://touch.com" });
  assert.equal(a.ok, true);
  assert.equal(a.site.lastUsedAt, 0);
  assert.equal(vault.touchSite(a.site.id).ok, true);
  const s = vault.listSites().find((x) => x.id === a.site.id);
  assert.ok(s.lastUsedAt > 0);
  assert.equal(plain(f).sites[0].lastUsedAt, s.lastUsedAt);
});

test("系统加密不可用时 addSite 拒绝写入且原因含不支持系统加密", () => {
  const f = useFile();
  encAvailable = false;
  try {
    assert.equal(vault.isAvailable(), false);
    const r = vault.addSite({ origin: "https://noenc.com" });
    assert.equal(r.ok, false);
    assert.ok(String(r.error || r.reason || "").includes("不支持系统加密"));
    assert.equal(fs.existsSync(f), false);
  } finally {
    encAvailable = true;
  }
});
