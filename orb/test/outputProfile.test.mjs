/* outputProfile 纯函数单测，无任何文件 IO。 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  FORMATS, DEFAULT_PROFILE, normalizeProfile, validateProfile,
  resolveName, retentionCutoff, shouldInclude, redactValue,
} from "../outputProfile.mjs";

test("DEFAULT_PROFILE：七键齐全且自身校验通过", () => {
  assert.deepEqual(
    Object.keys(DEFAULT_PROFILE).sort(),
    ["formats", "dest", "nameTemplate", "retentionDays", "include", "redact", "autoOpen"].sort(),
  );
  assert.deepEqual(validateProfile(DEFAULT_PROFILE), { ok: true, errors: [] });
});

test("FORMATS：前 10 种顺序固定，末尾追加 Office 三件套", () => {
  assert.equal(FORMATS.length, 13);
  assert.deepEqual(FORMATS.slice(0, 10),
    ["md", "vtt", "lrc", "txt", "csv", "tsv", "html", "pdf", "zip", "db"]);
  assert.deepEqual(FORMATS.slice(10), ["docx", "xlsx", "pptx"]);
});

test("normalizeProfile：非法 formats 过滤、布尔强制、retention 回退", () => {
  const p = normalizeProfile({
    formats: ["md", "bogus", "csv", "md"],
    retentionDays: -5,
    redact: "yes",
    autoOpen: 1,
    include: { rawLog: true },
  });
  assert.deepEqual(p.formats, ["md", "csv"]);
  assert.equal(p.retentionDays, 30);
  assert.equal(p.redact, true);
  assert.equal(p.autoOpen, false);
  assert.equal(p.include.rawLog, true);
  assert.equal(p.include.media, true, "缺省键继承默认");
  assert.equal(validateProfile(p).ok, true);
});

test("validateProfile：逐项拒绝并汇总 errors", () => {
  const r = validateProfile({
    formats: ["md", "exe"],
    retentionDays: -1,
    nameTemplate: "a/b.md",
    redact: "true",
    autoOpen: 1,
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 5);
  assert.ok(r.errors.some((e) => /未知格式/.test(e)));
  assert.ok(r.errors.some((e) => /retentionDays/.test(e)));
  assert.ok(r.errors.some((e) => /路径分隔符/.test(e)));
  assert.ok(r.errors.some((e) => /redact/.test(e)));
  assert.ok(r.errors.some((e) => /autoOpen/.test(e)));
});

test("resolveName：占位符替换 + 危险字符净化", () => {
  const n = resolveName("{title}-{date}-{epoch}-{seq}.{ext}", {
    title: "../机密:笔记*?", date: "20261104", epoch: 7, seq: 3, ext: "md",
  });
  assert.equal(n.includes("/"), false);
  assert.equal(n.includes("\\"), false);
  assert.equal(n.includes(".."), false);
  assert.ok(!/[<>:"|?*]/.test(n));
  assert.match(n, /20261104/);
  assert.match(n, /7/);
  assert.match(n, /\.md$/);
});

test("retentionCutoff：按天回推，0/非法返回 null", () => {
  const t = 1_700_000_000_000;
  assert.equal(retentionCutoff({ retentionDays: 30 }, t), t - 30 * 86400000);
  assert.equal(retentionCutoff({ retentionDays: 0 }, t), null);
  assert.equal(retentionCutoff({ retentionDays: -1 }, t), null);
  assert.equal(retentionCutoff({}, t), null);
});

test("shouldInclude：四类 part 按 include 判定，未知 part 拒绝", () => {
  const p = normalizeProfile({ include: { media: true, frames: false, rawLog: false, transcript: true } });
  assert.equal(shouldInclude(p, "media"), true);
  assert.equal(shouldInclude(p, "frames"), false);
  assert.equal(shouldInclude(p, "rawLog"), false);
  assert.equal(shouldInclude(p, "transcript"), true);
  assert.equal(shouldInclude(p, "bogus"), false);
});

test("redactValue：绝不回传原值、确定性、按类型分类", () => {
  const secret = "sk-live-ABCDEFG123456";
  const a = redactValue(secret);
  assert.equal(a, redactValue(secret), "同输入必须确定");
  assert.ok(!a.includes(secret));
  assert.ok(!a.includes("ABCDEFG"));
  assert.match(a, /^\[redact:credential:/);
  const p = redactValue("C:/Users/me/token.txt");
  assert.match(p, /^\[redact:path:/);
  assert.ok(!p.includes("token.txt"));
  assert.notEqual(redactValue("x"), redactValue("y"));
});
