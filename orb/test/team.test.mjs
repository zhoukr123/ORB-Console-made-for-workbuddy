/* team 单测：内置视角结构 / list·detail·stats / review 的确定性五步 / writeReport 落盘。
 * 重点是「同样的输入必得同样的输出」，所以排序、去重、阈值都按边界值钉死。 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTeam, BUILTIN_EXPERTS } from "../team.mjs";

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "orb-team-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const FINDING = (over = {}) => ({
  expertId: "sec",
  claim: "示例说法",
  topic: "topic-a",
  severity: "info",
  stance: "support",
  confidence: 0.8,
  evidence: "日志第 12 行",
  ...over,
});

test("内置专家与团：五个视角 id 齐全，团的 members 都能对上", () => {
  const ids = ["arch", "sec", "ux", "perf", "correct"];
  const experts = BUILTIN_EXPERTS.filter((e) => e.kind !== "team");
  assert.deepEqual(experts.map((e) => e.id).sort(), [...ids].sort());
  for (const e of experts) {
    assert.match(e.id, /^[a-z0-9-]+$/, "id 必须是 safeId 风格");
    assert.ok(e.name && e.icon && e.role, "name/icon/role 必填");
    assert.ok(e.role.length <= 6, `${e.id} 的 role 应 ≤6 字`);
    assert.ok(e.brief.length >= 20 && e.brief.length <= 40, `${e.id} 的 brief 应 20-40 字`);
    assert.ok(Array.isArray(e.checks) && e.checks.length >= 3 && e.checks.length <= 5);
    assert.ok(Array.isArray(e.inputs) && e.inputs.length >= 1);
    assert.ok(Array.isArray(e.outputs) && e.outputs.length >= 1);
    assert.ok(Array.isArray(e.keywords) && e.keywords.length >= 5 && e.keywords.length <= 8);
    assert.ok(e.weight >= 0.5 && e.weight <= 1.5);
  }
  const teams = BUILTIN_EXPERTS.filter((e) => e.kind === "team");
  assert.equal(teams.length, 1);
  assert.equal(teams[0].id, "core-team");
  assert.equal(teams[0].policy, "parallel");
  for (const m of teams[0].members) assert.ok(ids.includes(m), `团成员 ${m} 必须存在`);
  assert.deepEqual([...teams[0].members].sort(), [...ids].sort(), "团覆盖全部五个视角");
});

test("list：五个视角 + 一个团，附 stats", () => {
  const t = createTeam({ now: () => 1000 });
  const r = t.list();
  assert.equal(r.ok, true);
  assert.equal(r.experts.length, 5);
  assert.equal(r.teams.length, 1);
  assert.equal(r.experts[0].enabled, true);
  assert.deepEqual(r.stats, { experts: 5, teams: 1, reviews: 0, lastReviewAt: null });
});

test("list 返回的是副本：改外部拿到的数组不影响注册表", () => {
  const t = createTeam({ now: () => 1000 });
  const r = t.list();
  r.experts[0].checks.push("被外部篡改");
  r.experts[0].name = "篡改";
  assert.notEqual(t.list().experts[0].name, "篡改");
  assert.equal(t.list().experts[0].checks.includes("被外部篡改"), false);
});

test("detail：未知 id 返回 unknown-expert", () => {
  const t = createTeam({ now: () => 1000 });
  assert.deepEqual(t.detail("nope"), { ok: false, error: "unknown-expert" });
});

test("detail：正常路径带出该视角的 recent 与 evidence", () => {
  const t = createTeam({ now: () => 1000 });
  t.review({ subject: "改急停", findings: [FINDING({ claim: "急停被合并吃掉", evidence: "cmdchan L88" })] });
  const d = t.detail("sec", { limit: 5 });
  assert.equal(d.ok, true);
  assert.equal(d.expert.id, "sec");
  assert.equal(d.recent.length, 1);
  assert.equal(d.recent[0].findings, 1);
  assert.equal(d.recent[0].verdict, "pass");
  assert.equal(d.evidence.length, 1);
  assert.equal(d.evidence[0].evidence, "cmdchan L88");
  assert.deepEqual(t.detail("sec", { limit: 0 }).evidence.length, 1, "非法 limit 回落到默认值");
});

test("stats：评审后计数与时间戳更新", () => {
  const t = createTeam({ now: () => 777 });
  t.review({ subject: "s", findings: [] });
  t.review({ subject: "s", findings: [] });
  assert.deepEqual(t.stats(), { experts: 5, teams: 1, reviews: 2, lastReviewAt: 777 });
});

test("review：去重保留高置信度，其余计入 duplicates", () => {
  const t = createTeam({ now: () => 1000 });
  const r = t.review({
    subject: "s",
    findings: [
      FINDING({ claim: "  Stop  Epoch   被吃掉 ", confidence: 0.3 }),
      FINDING({ claim: "stop epoch 被吃掉", confidence: 0.9 }),
      FINDING({ claim: "STOP EPOCH 被吃掉", confidence: 0.5 }),
    ],
  });
  assert.equal(r.counts.total, 3);
  assert.equal(r.counts.kept, 1);
  assert.equal(r.counts.duplicates, 2);
  assert.equal(r.ranked[0].confidence, 0.9, "留最高置信度那条");
  assert.equal(r.ranked[0].claim, "stop epoch 被吃掉", "保留胜出那条的原文（不转小写展示）");
});

test("review：未知 expertId 进 rejected，不参与裁决", () => {
  const t = createTeam({ now: () => 1000 });
  const r = t.review({
    subject: "s",
    findings: [
      FINDING({ expertId: "ghost", claim: "幽灵视角", severity: "block", confidence: 1 }),
      FINDING({ expertId: "core-team", claim: "团不能直接发言", severity: "block", confidence: 1 }),
      FINDING({ expertId: "arch", claim: "正常发现", severity: "info", confidence: 0.2 }),
    ],
  });
  assert.equal(r.rejected.length, 2);
  assert.equal(r.rejected[0].reason, "unknown-expert");
  assert.equal(r.rejected[0].claim, "幽灵视角");
  assert.equal(r.rejected[1].reason, "unknown-expert");
  assert.equal(r.counts.kept, 1);
  assert.equal(r.verdict, "pass", "被拒的 block 不得影响裁决");
});

test("review：同主题 support/oppose 记为冲突并置 needsHuman", () => {
  const t = createTeam({ now: () => 1000 });
  const r = t.review({
    subject: "s",
    findings: [
      FINDING({ expertId: "sec", claim: "必须保留 epoch 校验", topic: "stop-epoch", stance: "support", severity: "block", confidence: 0.9 }),
      FINDING({ expertId: "arch", claim: "epoch 校验可以去掉", topic: "stop-epoch", stance: "oppose", severity: "info", confidence: 0.6 }),
      FINDING({ expertId: "ux", claim: "无人反对的建议", topic: "other", stance: "support", severity: "info", confidence: 0.6 }),
    ],
  });
  assert.equal(r.counts.conflicts, 1);
  assert.equal(r.needsHuman, true);
  assert.equal(r.conflicts[0].topic, "stop-epoch");
  assert.equal(r.conflicts[0].a.expertId, "sec");
  assert.equal(r.conflicts[0].b.expertId, "arch");
  assert.equal(r.conflicts[0].b.claim, "epoch 校验可以去掉");
});

test("review：只有 support 时不产生冲突", () => {
  const t = createTeam({ now: () => 1000 });
  const r = t.review({
    subject: "s",
    findings: [
      FINDING({ expertId: "sec", topic: "t", stance: "support" }),
      FINDING({ expertId: "arch", topic: "t", stance: "support", claim: "另一个说法" }),
    ],
  });
  assert.equal(r.counts.conflicts, 0);
  assert.equal(r.needsHuman, false);
});

test("review：block 置信度阈值 0.70 阻断、0.69 不阻断", () => {
  const lo = createTeam({ now: () => 1000 }).review({
    subject: "s",
    findings: [FINDING({ severity: "block", confidence: 0.69 })],
  });
  assert.notEqual(lo.verdict, "block");
  assert.equal(lo.verdict, "warn", "低置信度的 block 降级为警告，不能当成通过混过去");
  assert.equal(lo.counts.block, 1, "降级只影响裁决，严重度计数仍是 block");

  const hi = createTeam({ now: () => 1000 }).review({
    subject: "s",
    findings: [FINDING({ severity: "block", confidence: 0.7 })],
  });
  assert.equal(hi.verdict, "block", "0.70 正好命中阈值");
  assert.equal(hi.needsHuman, false);
});

test("review：只有 warn → warn；全 info → pass", () => {
  const warn = createTeam({ now: () => 1000 }).review({
    subject: "s",
    findings: [FINDING({ severity: "warn", confidence: 0.9 }), FINDING({ severity: "info", claim: "另一条" })],
  });
  assert.equal(warn.verdict, "warn");
  assert.equal(warn.counts.warn, 1);
  assert.equal(warn.counts.info, 1);

  const pass = createTeam({ now: () => 1000 }).review({
    subject: "s",
    findings: [FINDING({ severity: "info" }), FINDING({ severity: "info", claim: "另一条" })],
  });
  assert.equal(pass.verdict, "pass");
  assert.equal(pass.needsHuman, false);
});

test("review：排序稳定（严重度 → 置信度 → 主题）且与输入顺序无关", () => {
  const findings = [
    FINDING({ expertId: "ux", claim: "info-高", topic: "t2", severity: "info", confidence: 0.9 }),
    FINDING({ expertId: "perf", claim: "warn-低", topic: "t1", severity: "warn", confidence: 0.5 }),
    FINDING({ expertId: "sec", claim: "block-高", topic: "t3", severity: "block", confidence: 0.8 }),
    FINDING({ expertId: "arch", claim: "block-低", topic: "t0", severity: "block", confidence: 0.4 }),
    FINDING({ expertId: "correct", claim: "warn-高", topic: "t0", severity: "warn", confidence: 0.95 }),
  ];
  const a = createTeam({ now: () => 1000 }).review({ subject: "s", findings });
  const b = createTeam({ now: () => 1000 }).review({ subject: "s", findings: [...findings].reverse() });
  assert.deepEqual(a.ranked, b.ranked, "打乱输入后 ranked 必须完全一致");
  assert.deepEqual(
    a.ranked.map((f) => f.claim),
    ["block-高", "block-低", "warn-高", "warn-低", "info-高"],
    "先严重度降序，再 confidence 降序",
  );
});

test("review：空 findings → pass、counts 全 0、四段式齐全", () => {
  const t = createTeam({ now: () => 1000 });
  const r = t.review({ subject: "空评审", findings: [] });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "pass");
  assert.equal(r.needsHuman, false);
  assert.deepEqual(r.counts, { total: 0, kept: 0, duplicates: 0, rejected: 0, conflicts: 0, block: 0, warn: 0, info: 0 });
  assert.deepEqual(r.ranked, []);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.generatedAt, 1000);
  for (const k of ["discover", "evidence", "decision", "skill"]) {
    assert.equal(typeof r.fourStage[k], "string");
    assert.ok(r.fourStage[k].length > 0, `fourStage.${k} 不能为空`);
  }
});

test("review：epoch / ticketId 透传，缺失时为 null", () => {
  const t = createTeam({ now: () => 1000 });
  const r = t.review({ subject: "s", findings: [], epoch: 12, ticketId: "tk-9" });
  assert.equal(r.epoch, 12);
  assert.equal(r.ticketId, "tk-9");
  const r2 = t.review({ subject: "s", findings: [] });
  assert.equal(r2.epoch, null);
  assert.equal(r2.ticketId, null);
});

test("review：perspectives 列出每个视角贡献的条数", () => {
  const t = createTeam({ now: () => 1000 });
  const r = t.review({
    subject: "s",
    findings: [
      FINDING({ expertId: "sec", claim: "a", topic: "t1" }),
      FINDING({ expertId: "sec", claim: "b", topic: "t2" }),
      FINDING({ expertId: "ux", claim: "c", topic: "t3" }),
    ],
  });
  const byId = Object.fromEntries(r.perspectives.map((p) => [p.id, p.findings]));
  assert.equal(r.perspectives.length, 5);
  assert.equal(byId.sec, 2);
  assert.equal(byId.ux, 1);
  assert.equal(byId.perf, 0);
});

test("setEnabled / isEnabled：关掉的视角不参与裁决，未知 id 不崩", () => {
  const t = createTeam({ now: () => 1000 });
  assert.equal(t.isEnabled("sec"), true);
  assert.equal(t.isEnabled("ghost"), false);
  assert.deepEqual(t.setEnabled("ghost", true), { ok: false, error: "unknown-expert" });

  assert.deepEqual(t.setEnabled("sec", false), { ok: true, id: "sec", enabled: false });
  assert.equal(t.isEnabled("sec"), false);
  const r = t.review({ subject: "s", findings: [FINDING({ expertId: "sec", severity: "block", confidence: 1 })] });
  assert.equal(r.counts.kept, 0);
  assert.equal(r.rejected[0].reason, "expert-disabled");
  assert.equal(r.verdict, "pass");

  t.setEnabled("sec", true);
  assert.equal(t.isEnabled("sec"), true);
  assert.equal(t.review({ subject: "s", findings: [FINDING({ severity: "block", confidence: 1 })] }).verdict, "block");
});

test("review：非法入参一律不抛异常，返回 ok:false", () => {
  const t = createTeam({ now: () => 1000 });
  for (const bad of [null, undefined, 0, "x", [], {}]) {
    const r = t.review(bad);
    assert.equal(r.ok, false);
    assert.equal(typeof r.error, "string");
  }
  assert.equal(t.review({ findings: [] }).error, "bad-subject");
  assert.equal(t.review({ subject: "s", findings: null }).error, "bad-findings");
  assert.equal(t.review({ subject: "s", findings: "nope" }).error, "bad-findings");
  assert.equal(t.stats().reviews, 0, "非法入参不计数");
  // 非法单条发现也只落 rejected
  const r = t.review({ subject: "s", findings: [null, 5, { expertId: "arch", claim: "   " }] });
  assert.equal(r.ok, true);
  assert.equal(r.counts.kept, 0);
  assert.equal(r.rejected.length, 3);
});

test("writeReport：在临时目录写出四类文件，manifest 可解析，report 含 subject", () => {
  const t = createTeam({ now: () => 1700000000000 });
  const rv = t.review({
    subject: "急停改造",
    epoch: 12,
    ticketId: "tk-1",
    findings: [
      FINDING({ expertId: "sec", claim: "急停被批量合并吃掉", topic: "stop-epoch", severity: "block", confidence: 0.92, evidence: "cmdchan L88" }),
      FINDING({ expertId: "arch", claim: "worker 与主进程耦合", topic: "coupling", severity: "warn", confidence: 0.6 }),
      FINDING({ expertId: "arch", claim: "epoch 校验可以去掉", topic: "stop-epoch", stance: "oppose", severity: "info", confidence: 0.4 }),
    ],
  });
  const dir = tmp();
  const out = t.writeReport(rv, { dir });
  assert.equal(out.ok, true);
  assert.equal(out.dir, dir);
  assert.deepEqual(out.files.sort(), ["evidence/arch.json", "evidence/sec.json", "manifest.json", "report.md", "skill.md"].sort());
  for (const f of out.files) assert.ok(fs.existsSync(path.join(dir, f)), `${f} 应存在`);

  const report = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  assert.ok(report.includes("急停改造"), "report 必须含 subject");
  assert.ok(report.includes("| 严重度 | 视角 | 主题 | 说法 | 置信度 |"), "必须有表格表头");
  assert.ok(report.includes("0.92"));
  assert.ok(report.includes("## 冲突"));

  const skill = fs.readFileSync(path.join(dir, "skill.md"), "utf8");
  assert.ok(skill.includes("自动沉淀"));
  assert.ok(skill.includes("stop-epoch"), "冲突主题进沉淀清单");

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(manifest.subject, "急停改造");
  assert.equal(manifest.verdict, "block");
  assert.equal(manifest.epoch, 12);
  assert.equal(manifest.ticketId, "tk-1");
  assert.equal(manifest.generatedAt, 1700000000000);
  assert.deepEqual(manifest.files.sort(), ["evidence/arch.json", "evidence/sec.json", "report.md", "skill.md"].sort());

  const ev = JSON.parse(fs.readFileSync(path.join(dir, "evidence/sec.json"), "utf8"));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].evidence, "cmdchan L88");

  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith(".part"));
  assert.deepEqual(leftovers, [], "原子写不应留下 .part");

  // 目录不存在时自建
  const deep = path.join(tmp(), "a", "b");
  assert.equal(t.writeReport(rv, { dir: deep }).ok, true);
  assert.ok(fs.existsSync(path.join(deep, "manifest.json")));
});

test("writeReport：Markdown 表格转义竖线与换行，非法 review 不抛异常", () => {
  const t = createTeam({ now: () => 1000 });
  const rv = t.review({
    subject: "a|b 的对象",
    findings: [FINDING({ claim: "左 | 右\n下一行", topic: "t|x", evidence: "e" })],
  });
  const dir = tmp();
  assert.equal(t.writeReport(rv, { dir }).ok, true);
  const report = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  assert.ok(report.includes("a\\|b 的对象"), "标题里的竖线要转义");
  assert.ok(report.includes("左 \\| 右 下一行"), "单元格竖线转义、换行压平");
  const rows = report.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---") && !l.includes("严重度"));
  assert.equal(rows.length, 1, "转义后表格仍是单行，不被打断");
  assert.equal(/<[a-z]+>/i.test(report), false, "不得输出 HTML");

  assert.deepEqual(t.writeReport(null, { dir }).error, "bad-review");
  assert.deepEqual(t.writeReport(rv, {}).error, "no-dir");
  assert.equal(createTeam({ now: () => 1, dir }).writeReport(rv, {}).ok, true, "dir 可由 opts 默认");
});
