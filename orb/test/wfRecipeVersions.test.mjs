import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRecipeVersions } from "../wfRecipeVersions.mjs";

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-rev-"));
  return { dir, V: createRecipeVersions({ dir }) };
}

const recipe = (n, extra = {}) => JSON.stringify({ name: "月度报表", steps: Array.from({ length: n }, (_, i) => ({ tool: "click", args: { i } })), ...extra });

test("save 递增 rev，list 按新到旧", () => {
  const { V } = mk();
  assert.equal(V.save("月度报表", recipe(2), { note: "初次" }).rev, 1);
  assert.equal(V.save("月度报表", recipe(3), { note: "加一步" }).rev, 2);
  const all = V.list("月度报表");
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((x) => x.rev), [2, 1]);
  assert.equal(all[0].note, "加一步");
  assert.equal(all[1].steps, 0);
});

test("get / latest 返回原文，可精确还原", () => {
  const { V } = mk();
  const body = recipe(2, { goal: "汇总" });
  V.save("月度报表", body);
  assert.equal(V.get("月度报表", 1).body, body);
  assert.equal(V.latest("月度报表").body, body);
});

test("rollback 返回可解析的正文", () => {
  const { V } = mk();
  V.save("月度报表", recipe(2));
  V.save("月度报表", recipe(5));
  const r = V.rollback("月度报表", 1);
  assert.equal(r.ok, true);
  assert.equal(r.parsed.steps.length, 2);
});

test("rollback 不存在 / 损坏版本一律拒绝", () => {
  const { dir, V } = mk();
  assert.equal(V.rollback("月度报表", 9).ok, false);
  V.save("月度报表", recipe(1));
  fs.writeFileSync(path.join(dir, "月度报表", "2.json"), JSON.stringify({ rev: 2, body: "{不是JSON" }), "utf8");
  const r = V.rollback("月度报表", 2);
  assert.equal(r.ok, false);
  assert.match(r.error, /损坏/);
});

test("diff：字段变化 + 步骤差异都列出来", () => {
  const { V } = mk();
  V.save("月度报表", JSON.stringify({ name: "月度报表", goal: "旧目标", steps: [{ tool: "click" }, { tool: "type" }] }));
  V.save("月度报表", JSON.stringify({ name: "月度报表", goal: "新目标", steps: [{ tool: "click" }, { tool: "paste" }, { tool: "click" }] }));
  const d = V.diff("月度报表", 1, 2);
  assert.equal(d.ok, true);
  const fields = d.changes.map((c) => c.field);
  assert.ok(fields.includes("goal"));
  assert.ok(fields.includes("steps.length"));
  assert.equal(d.totalStepChanges, 2);
  assert.equal(d.stepChanges[0].from.tool, "type");
  assert.equal(d.stepChanges[0].to.tool, "paste");
});

test("diff 版本不存在时明确报错", () => {
  const { V } = mk();
  assert.equal(V.diff("月度报表", 1, 2).ok, false);
});

test("空内容不建版本（防止把空文件写成基线）", () => {
  const { V } = mk();
  assert.equal(V.save("月度报表", "").ok, false);
  assert.equal(V.list("月度报表").length, 0);
});

test("prune 保留最新 maxPerName 个版本", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orb-rev-"));
  const V = createRecipeVersions({ dir, maxPerName: 3 });
  for (let i = 1; i <= 6; i++) V.save("月度报表", recipe(i));
  const revs = V.list("月度报表").map((x) => x.rev);
  assert.deepEqual(revs, [6, 5, 4]);
});

test("配方名里的路径字符被安全化，版本文件不会写出目录", () => {
  const { dir, V } = mk();
  V.save("../../evil", recipe(1));
  const children = fs.readdirSync(dir);
  assert.equal(children.length, 1);
  assert.ok(!children[0].includes(".."));
});

test("缺 dir 直接报错", () => {
  assert.throws(() => createRecipeVersions({}), /dir 必填/);
});

test("stats 汇总配方数与版本数", () => {
  const { V } = mk();
  V.save("A", recipe(1));
  V.save("A", recipe(2));
  V.save("B", recipe(1));
  const s = V.stats();
  assert.equal(s.recipes, 2);
  assert.equal(s.versions, 3);
});
