import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ARTIFACT_ORIGINS,
  ACCEPTANCE_SECTIONS,
  GATE_CODES,
  createArtifactGate,
} from "../pluginArtifactGate.mjs";

const gateSourcePath = new URL("../pluginArtifactGate.mjs", import.meta.url);

function builtin(overrides = {}) {
  return {
    id: "tool.builtin.echo",
    origin: { kind: ARTIFACT_ORIGINS.BUILTIN },
    spec: {
      what: "回显输入字符串",
      entry: "builtin/echo.run",
      how: [
        { name: "returns-same-value", expect: "abc" },
        { name: "handles-empty", expect: "" },
      ],
    },
    ...overrides,
  };
}

function generated(overrides = {}) {
  return {
    id: "tool.gen.sum",
    origin: { kind: ARTIFACT_ORIGINS.GENERATED, sourceHash: "sha256:deadbeef" },
    spec: {
      what: "对数组求和",
      entry: "generated/sum.run",
      how: [{ name: "sums-1-2-3", expect: 6 }],
    },
    epoch: 7,
    ...overrides,
  };
}

test("1. 合法 builtin 通过；缺 what/entry/how 分别被拒且错误码正确", () => {
  const g = createArtifactGate();

  const ok = g.validate(builtin());
  assert.equal(ok.ok, true, "合法 builtin 应通过");
  assert.equal(ok.needsRestart, false);
  assert.deepEqual(Object.keys(ok.checks).sort(), [
    "capabilities",
    "entry",
    "epoch",
    "how",
    "origin",
    "what",
  ]);
  assert.equal(ok.checks.what, true);
  assert.equal(ok.checks.entry, true);
  assert.equal(ok.checks.how, true);
  assert.equal(ok.checks.origin, true);
  assert.equal(ok.checks.capabilities, true);
  assert.equal(ok.checks.epoch, true);

  const noWhat = builtin();
  delete noWhat.spec.what;
  const r1 = g.validate(noWhat);
  assert.equal(r1.ok, false);
  assert.equal(r1.code, GATE_CODES.INCOMPLETE_ACCEPTANCE);
  assert.equal(r1.checks.what, false);

  const noEntry = builtin();
  delete noEntry.spec.entry;
  const r2 = g.validate(noEntry);
  assert.equal(r2.ok, false);
  assert.equal(r2.code, GATE_CODES.BAD_ENTRY);

  const noHow = builtin();
  delete noHow.spec.how;
  const r3 = g.validate(noHow);
  assert.equal(r3.ok, false);
  assert.equal(r3.code, GATE_CODES.INCOMPLETE_ACCEPTANCE);

  // bad-artifact：非对象 / 缺 id
  assert.equal(g.validate(null).code, GATE_CODES.BAD_ARTIFACT);
  const noId = builtin();
  delete noId.id;
  assert.equal(g.validate(noId).code, GATE_CODES.BAD_ARTIFACT);
});

test("2. generated 缺 sourceHash / 缺验收 / 缺 epoch 分别被拒（含 epochProvider 不一致）", () => {
  const g = createArtifactGate({ epochProvider: () => 7 });
  assert.equal(g.validate(generated()).ok, true, "合法 generated 应通过");

  const noHash = generated();
  delete noHash.origin.sourceHash;
  assert.equal(g.validate(noHash).code, GATE_CODES.MISSING_ORIGIN_HASH);

  const noAcceptance = generated();
  delete noAcceptance.spec.how;
  assert.equal(g.validate(noAcceptance).code, GATE_CODES.INCOMPLETE_ACCEPTANCE);

  const emptyAcceptance = generated();
  emptyAcceptance.spec = {};
  assert.equal(g.validate(emptyAcceptance).code, GATE_CODES.MISSING_ACCEPTANCE);

  const noEpoch = generated();
  delete noEpoch.epoch;
  assert.equal(g.validate(noEpoch).code, GATE_CODES.EPOCH_REQUIRED);

  assert.equal(
    g.validate(generated({ epoch: 6 })).code,
    GATE_CODES.EPOCH_REQUIRED,
    "epoch 与 epochProvider 当前世代不一致",
  );

  const badOrigin = generated();
  badOrigin.origin.kind = "unknown";
  assert.equal(g.validate(badOrigin).code, GATE_CODES.BAD_ORIGIN);

  // builtin 豁免 sourceHash 与 epoch
  assert.equal(g.validate(builtin()).ok, true);
  // imported 需要 sourceHash，但不强制 epoch
  const imported = { ...generated(), origin: { kind: ARTIFACT_ORIGINS.IMPORTED, sourceHash: "sha256:abcd" } };
  delete imported.epoch;
  assert.equal(g.validate(imported).ok, true);
});

test("3. 危险能力：network 无批准被拒/有批准放行；api_call_register 硬红线一律拒", () => {
  const g = createArtifactGate();
  const net = builtin({ capabilities: ["network"] });

  const r1 = g.validate(net, {});
  assert.equal(r1.ok, false);
  assert.equal(r1.code, GATE_CODES.DANGEROUS_CAPABILITY);
  assert.equal(r1.checks.capabilities, false);

  const r2 = g.validate(net, { approvedBy: "reviewer-01" });
  assert.equal(r2.ok, true, "显式 approvedBy 后放行");
  assert.equal(r2.checks.capabilities, true);

  const redline = builtin({ capabilities: ["api_call_register"] });
  const r3 = g.validate(redline, { approvedBy: "reviewer-01" });
  assert.equal(r3.ok, false, "硬红线即使 approvedBy 也拒");
  assert.equal(r3.code, GATE_CODES.DANGEROUS_CAPABILITY);

  for (const cap of ["filesystem_write", "shell"]) {
    const a = builtin({ capabilities: [cap] });
    assert.equal(g.validate(a, {}).code, GATE_CODES.DANGEROUS_CAPABILITY);
    assert.equal(g.validate(a, { approvedBy: "ops" }).ok, true);
  }

  // 字符串形态也不得绕过红线
  assert.equal(
    g.validate(builtin({ capabilities: "api_call_register" }), {
      approvedBy: "someone",
    }).code,
    GATE_CODES.DANGEROUS_CAPABILITY,
  );
});

test("4. restart-required 不算成功：validate 直接 ok:false，accept 也不发 receipt", async () => {
  const g = createArtifactGate({ runner: () => true });
  const pending = builtin({ restartRequired: true });

  const v = g.validate(pending, {});
  assert.equal(v.ok, false);
  assert.equal(v.code, GATE_CODES.RESTART_REQUIRED);
  assert.equal(v.needsRestart, true);
  assert.ok(v.reasons.length >= 1);

  const a = await g.accept(pending, {});
  assert.equal(a.ok, false);
  assert.equal(a.code, GATE_CODES.RESTART_REQUIRED);
  assert.ok(!("receipt" in a), "重启待激活不得签发 receipt");
});

test("5. accept() 实跑验收：全真发 receipt / 一项假 / 抛错 / 无 runner 均失败且无 receipt", async () => {
  const fixedNow = 1700000000000;
  const goodGate = createArtifactGate({
    runner: () => true,
    now: () => fixedNow,
  });
  const art = builtin();

  const okRes = await goodGate.accept(art, {});
  assert.equal(okRes.ok, true);
  assert.ok(okRes.receipt, "全过后才发 receipt");
  assert.equal(okRes.receipt.id, art.id);
  assert.equal(okRes.receipt.origin.kind, ARTIFACT_ORIGINS.BUILTIN);
  assert.equal(okRes.receipt.epoch, null);
  assert.equal(okRes.receipt.acceptedAt, fixedNow);
  assert.equal(okRes.receipt.checksCount, art.spec.how.length);
  assert.equal(okRes.receipt.verified, true);

  const oneFalse = createArtifactGate({
    runner: ({ name }) => name !== "handles-empty",
  });
  const r1 = await oneFalse.accept(art, {});
  assert.equal(r1.ok, false);
  assert.equal(r1.code, GATE_CODES.ACCEPTANCE_FAILED);
  assert.ok(!("receipt" in r1));
  assert.ok(Array.isArray(r1.failed));
  assert.ok(r1.failed.includes("handles-empty"));

  const throws = createArtifactGate({
    runner: ({ name }) => {
      if (name === "returns-same-value") throw new Error("boom");
      return true;
    },
  });
  const r2 = await throws.accept(art, {});
  assert.equal(r2.ok, false);
  assert.equal(r2.code, GATE_CODES.ACCEPTANCE_FAILED);
  assert.ok(!("receipt" in r2));

  const noRunner = createArtifactGate({ runner: null });
  const r3 = await noRunner.accept(art, {});
  assert.equal(r3.ok, false);
  assert.equal(r3.code, GATE_CODES.ACCEPTANCE_FAILED);
  assert.ok(!("receipt" in r3));

  // validate 失败时 accept 直接透传，不实跑、不发 receipt
  const bad = createArtifactGate({ runner: () => true });
  const invalid = builtin();
  delete invalid.spec.entry;
  const r4 = await bad.accept(invalid, {});
  assert.equal(r4.code, GATE_CODES.BAD_ENTRY);
  assert.ok(!("receipt" in r4));
});

test("6. reverify()：缺 restarted / profileSame 被拒；满足后通过并带 reverified:true", async () => {
  const g = createArtifactGate({ runner: () => true });
  const art = builtin();

  const a = await g.reverify(art, {});
  assert.equal(a.ok, false);
  assert.equal(a.code, GATE_CODES.RESTART_NOT_REVERIFIED);

  const b = await g.reverify(art, { restarted: true, profileSame: false });
  assert.equal(b.ok, false);
  assert.equal(b.code, GATE_CODES.RESTART_NOT_REVERIFIED);

  const c = await g.reverify(art, { restarted: true, profileSame: true });
  assert.equal(c.ok, true);
  assert.equal(c.reverified, true);
  assert.ok(c.receipt);
  assert.equal(c.receipt.verified, true);
});

test("7. allowlist 命中/不命中（数组与 Set）", () => {
  const g = createArtifactGate();
  const art = builtin();

  assert.equal(g.validate(art, { allowlist: [art.id, "other"] }).ok, true);
  const miss = g.validate(art, { allowlist: ["other"] });
  assert.equal(miss.ok, false);
  assert.equal(miss.code, GATE_CODES.NOT_ALLOWLISTED);
  assert.equal(g.validate(art, { allowlist: new Set([art.id]) }).ok, true);
  assert.equal(
    g.validate(art, { allowlist: new Set(["x"]) }).code,
    GATE_CODES.NOT_ALLOWLISTED,
  );
});

test("8. stats() 单调递增且返回独立快照", async () => {
  const g = createArtifactGate({ runner: () => true });
  const art = builtin();
  const snaps = [g.stats()];
  g.validate(art, {});
  snaps.push(g.stats());
  await g.accept(art, {});
  snaps.push(g.stats());
  g.validate({}, {});
  snaps.push(g.stats());
  g.validate(builtin({ restartRequired: true }), {});
  snaps.push(g.stats());

  const keys = ["validated", "accepted", "failed", "restartPending"];
  for (let i = 1; i < snaps.length; i++) {
    for (const k of keys) {
      assert.ok(snaps[i][k] >= snaps[i - 1][k], `${k} 必须单调不减`);
    }
  }
  const last = snaps[snaps.length - 1];
  assert.ok(last.validated > snaps[0].validated);
  assert.ok(last.accepted >= 1);
  assert.ok(last.failed >= 2);
  assert.ok(last.restartPending >= 1);

  const snapshot = g.stats();
  snapshot.validated = 999999;
  assert.notEqual(g.stats().validated, 999999, "stats() 不得泄漏内部可变引用");
});

test("9. assertNoApiCallRegistration：干净源码 ok；含拼接源码 false", () => {
  const g = createArtifactGate();

  const clean = [
    "const pluginHost = {};",
    "function register(x) { return x; }",
    "export const answer = 42;",
  ].join("\n");
  const r1 = g.assertNoApiCallRegistration(clean);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.bad, []);

  const dirty = [
    "plugin.register(makeTool());",
    'await fetch("/api/call", { method: "POST", body: JSON.stringify(payload) });',
  ].join("\n");
  const r2 = g.assertNoApiCallRegistration(dirty);
  assert.equal(r2.ok, false);
  assert.ok(r2.bad.length > 0);
  assert.equal(Array.isArray(r2.bad), true);

  // 仅有字面量但无注册拼装，不误报
  const onlyLiteral = 'const hint = "/api/call"; const v = 1;';
  assert.equal(g.assertNoApiCallRegistration(onlyLiteral).ok, true);
});

test("10. 静态契约：闸门源码零 import、无真实注册调用、/api/call 仅作检测字面量", () => {
  const src = readFileSync(gateSourcePath, "utf8");

  const importLines = src.split("\n").filter((line) => /^\s*import\b/.test(line));
  assert.equal(importLines.length, 0, "闸门源码 import 语句为零（纯逻辑）");

  // 断言字符串在测试内拼装，不写进被测源码
  const regCall = ["plugin", "register"].join(".") + "(";
  assert.ok(!src.includes(regCall), "不得出现真实注册调用");

  const apiCall = "/" + "api" + "/" + "call";
  const fetchCall = "fetch(" + '"' + apiCall + '"';
  assert.ok(!src.includes(fetchCall), "不得出现 fetch 到 /api/call 的实际调用");
  assert.ok(src.includes(apiCall), "应保留 /api/call 检测字面量");

  // 导出清单契约
  assert.equal(typeof createArtifactGate, "function");
  assert.deepEqual(Object.keys(ARTIFACT_ORIGINS).sort(), [
    "BUILTIN",
    "GENERATED",
    "IMPORTED",
  ]);
  for (const s of ["what", "entry", "how"]) {
    assert.ok(ACCEPTANCE_SECTIONS.includes(s));
  }
  for (const v of [
    "bad-artifact",
    "bad-origin",
    "missing-origin-hash",
    "missing-acceptance",
    "incomplete-acceptance",
    "bad-entry",
    "dangerous-capability",
    "epoch-required",
    "acceptance-failed",
    "restart-required",
    "restart-not-reverified",
    "not-allowlisted",
  ]) {
    assert.ok(Object.values(GATE_CODES).includes(v), `GATE_CODES 缺少 ${v}`);
  }
});

test("11. 返回对象不泄漏内部可变引用", async () => {
  const g = createArtifactGate({ runner: () => true });
  const art = builtin();

  const r1 = g.validate(art, {});
  r1.checks.what = false;
  r1.reasons.push("tampered");
  const r2 = g.validate(art, {});
  assert.equal(r2.checks.what, true);
  assert.equal(r2.reasons.length, 0);

  const dirty = 'plugin.register(x); fetch("/api/call");';
  const s1 = g.assertNoApiCallRegistration(dirty);
  s1.bad.push("tampered");
  const s2 = g.assertNoApiCallRegistration(dirty);
  assert.ok(s2.bad.length > 0 && !s2.bad.includes("tampered"));

  const a = await g.accept(art, {});
  a.receipt.id = "hacked";
  const b = await g.accept(art, {});
  assert.equal(b.receipt.id, art.id);
});
