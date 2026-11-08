/* 专家契约测试：这一组守的是"只读专家真的只读"这条边界。
 *
 * 为什么值得单独测：只读是靠自觉的时候，它一定会在某次赶工里被绕开；
 * 而被绕开的表现是"评审说没问题"，没有任何报错。所以规则必须可测、可回归。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BOOK, DEFAULT_CONTRACT, SCOPES, normalizeContract, arbitrate, createExpertBook, toMarkdown,
} from "../expertContract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "orb-book-"));

test("默认契约是最保守的那一档", () => {
  assert.equal(DEFAULT_CONTRACT.actionScope, "read-only");
  assert.equal(DEFAULT_CONTRACT.maxNestedDepth, 0);
  assert.deepEqual([...DEFAULT_CONTRACT.checkpoints], ["freeze", "check"]);
});

test("内置专家全部是只读档（评审视角不许自己动手）", () => {
  for (const [id, c] of Object.entries(DEFAULT_BOOK.experts)) {
    assert.equal(normalizeContract(c).actionScope, "read-only", `${id} 不是只读档`);
  }
});

test("arbitrate: 只读专家提写操作被拒，理由固定为 scope-read-only", () => {
  const r = arbitrate(DEFAULT_CONTRACT, { tool: "windows|Click", readOnly: false });
  assert.equal(r.allow, false);
  assert.equal(r.reason, "scope-read-only");
  assert.match(r.detail, /windows\|Click/);
});

test("arbitrate: 只读专家提只读操作放行", () => {
  const r = arbitrate(DEFAULT_CONTRACT, { tool: "windows|Screenshot", readOnly: true });
  assert.equal(r.allow, true);
  assert.equal(r.reason, "ok");
});

test("arbitrate: 嵌套超过 maxNestedDepth 被拒", () => {
  const c = normalizeContract({ actionScope: "read-only", maxNestedDepth: 1, checkpoints: ["freeze", "check"] });
  assert.equal(arbitrate(c, { tool: "t", readOnly: true, nestedDepth: 1 }).allow, true);
  const r = arbitrate(c, { tool: "t", readOnly: true, nestedDepth: 2 });
  assert.equal(r.allow, false);
  assert.equal(r.reason, "nested-too-deep");
});

test("arbitrate: execute 档缺 freeze 直接拒（钉不住现状就不许动手）", () => {
  const c = normalizeContract({ actionScope: "execute", maxNestedDepth: 0, checkpoints: ["check"] });
  const r = arbitrate(c, { tool: "windows|Click", readOnly: false });
  assert.equal(r.allow, false);
  assert.equal(r.reason, "missing-freeze");
});

test("normalizeContract: 非法值落回默认，不抛异常", () => {
  const n = normalizeContract({ actionScope: "god-mode", maxNestedDepth: -3, checkpoints: ["nope"] });
  assert.equal(n.actionScope, "read-only");
  assert.equal(n.maxNestedDepth, 0);
  assert.deepEqual(n.checkpoints, ["freeze", "check"]);
  assert.ok(SCOPES.includes(n.actionScope));
});

test("normalizeContract: 嵌套上限被夹在 5 以内", () => {
  assert.equal(normalizeContract({ maxNestedDepth: 999 }).maxNestedDepth, 5);
});

test("createExpertBook: 没有覆盖文件时用默认，且不报错", () => {
  const b = createExpertBook({ file: path.join(tmp(), "nope.json") });
  const r = b.load();
  assert.equal(r.ok, true);
  assert.equal(r.source, "default");
  assert.equal(b.get("arch").actionScope, "read-only");
});

test("createExpertBook: 覆盖文件生效（放宽到 propose）", () => {
  const f = path.join(tmp(), "expertBook.json");
  fs.writeFileSync(f, JSON.stringify({ version: 2, experts: { arch: { actionScope: "propose", maxNestedDepth: 2 } } }), "utf8");
  const b = createExpertBook({ file: f });
  const r = b.load();
  assert.equal(r.ok, true);
  assert.equal(r.source, "file");
  assert.equal(b.get("arch").actionScope, "propose");
  assert.equal(b.get("arch").maxNestedDepth, 2);
  assert.equal(b.get("arch").checkpoints.join(","), "freeze,check", "没写的字段继承默认而不是空");
});

test("createExpertBook: 解析失败整份退回默认并给 warning（绝不「读不懂就放开」）", () => {
  const f = path.join(tmp(), "broken.json");
  fs.writeFileSync(f, "{ this is not json", "utf8");
  const b = createExpertBook({ file: f });
  const r = b.load();
  assert.equal(r.ok, false);
  assert.match(r.warning, /解析失败/);
  assert.equal(b.stats().source, "default");
  assert.equal(b.get("arch").actionScope, "read-only", "坏文件不能把档位放开");
});

test("createExpertBook: 结构不对也退回默认", () => {
  const f = path.join(tmp(), "shape.json");
  fs.writeFileSync(f, JSON.stringify({ experts: [] }), "utf8");
  const b = createExpertBook({ file: f });
  const r = b.load();
  assert.equal(r.ok, false);
  assert.match(r.warning, /结构不对/);
});

test("readOnlySet / stats 与清单一致", () => {
  const b = createExpertBook({});
  b.load();
  const set = b.readOnlySet();
  const rows = b.list();
  assert.equal(set.size, rows.filter((r) => r.actionScope === "read-only").length);
  assert.equal(b.stats().experts, rows.length);
  assert.equal(b.has("arch"), true);
  assert.equal(b.has("nobody"), false);
});

test("docs/expertBook.md 与 toMarkdown(DEFAULT_BOOK) 逐字一致", () => {
  const doc = path.join(ROOT, "docs", "expertBook.md");
  try {
    execFileSync(process.execPath, [path.join(ROOT, "tools", "gen-expertbook-doc.mjs"), "--check"], {
      cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    assert.fail(`专家契约文档漂移：${(err.stdout || "") + (err.stderr || "")}\n修法：node orb/tools/gen-expertbook-doc.mjs`);
  }
  assert.ok(fs.existsSync(doc));
  assert.equal(fs.readFileSync(doc, "utf8"), toMarkdown(DEFAULT_BOOK));
});

test("未登记的专家/工具组合不会因为查不到就被当成只读", () => {
  /* 这条守的是方向：仲裁的默认不是"放行"，而是由契约档位决定。
     没有契约就没有仲裁（no-expert），而不是"没有契约所以随便用"。 */
  const b = createExpertBook({});
  b.load();
  assert.equal(b.has("unknown-expert"), false, "未登记的专家必须能被识别出来，桥据此走 no-expert 分支");
});
