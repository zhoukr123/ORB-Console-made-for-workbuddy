import test from "node:test";
import assert from "node:assert/strict";
import {
  VERDICT, EVIDENCE_LEVEL, REASON,
  buildSpec, checkPostcondition, judge, toRunStatus, isSample,
} from "../autoOutcome.mjs";

test("无判据 + 指纹有变化 → ok（弱证据）", () => {
  const r = judge({ spec: { postconditions: [] }, evidence: { effect: { changed: true } }, quality: {} });
  assert.equal(r.verdict, VERDICT.OK);
  assert.equal(r.evidenceLevel, EVIDENCE_LEVEL.WEAK);
  assert.equal(r.outcomeReasonCode, REASON.NO_SPEC);
  assert.equal(r.independent, true);
  assert.equal(r.modelUsed, false);
});

test("无判据 + 指纹未变 → needs_review，绝不判 ok", () => {
  const r = judge({ spec: { postconditions: [] }, evidence: { effect: { changed: false } }, quality: {} });
  assert.equal(r.verdict, VERDICT.NEEDS_REVIEW);
  assert.equal(r.evidenceLevel, EVIDENCE_LEVEL.NONE);
});

test("无判据 + 退化计数 → failed（明确反证）", () => {
  const r = judge({ spec: { postconditions: [] }, evidence: {}, quality: { verifyFailed: 2 } });
  assert.equal(r.verdict, VERDICT.FAILED);
  assert.equal(r.evidenceLevel, EVIDENCE_LEVEL.STRONG);
  assert.equal(r.outcomeReasonCode, REASON.EFFECT_NOT_OBSERVED);
});

test("模型自述达成不能单独判 ok", () => {
  const r = judge({ spec: { postconditions: [] }, evidence: {}, quality: {}, selfClaim: true });
  assert.equal(r.verdict, VERDICT.NEEDS_REVIEW);
  assert.equal(r.outcomeReasonCode, REASON.SELF_CLAIM_ONLY);
  assert.equal(r.selfClaimed, true);
});

test("有判据且命中 → ok / strong", () => {
  const r = judge({
    spec: { postconditions: [{ kind: "tree_state", text: "保存成功" }] },
    evidence: { tree: { text: "对话框 保存成功 确定" } },
  });
  assert.equal(r.verdict, VERDICT.OK);
  assert.equal(r.evidenceLevel, EVIDENCE_LEVEL.STRONG);
  assert.equal(r.outcomeReasonCode, REASON.POSTCONDITION_MET);
});

test("有判据且落空 → failed / strong", () => {
  const r = judge({
    spec: { postconditions: [{ kind: "tree_state", text: "保存成功" }] },
    evidence: { tree: { text: "对话框 出错 重试" } },
  });
  assert.equal(r.verdict, VERDICT.FAILED);
  assert.equal(r.outcomeReasonCode, REASON.POSTCONDITION_UNMET);
});

test("有判据但拿不到观测 → needs_review，不误判失败", () => {
  const r = judge({
    spec: { postconditions: [{ kind: "tree_state", text: "保存成功" }] },
    evidence: {},
  });
  assert.equal(r.verdict, VERDICT.NEEDS_REVIEW);
  assert.equal(r.outcomeReasonCode, REASON.EVIDENCE_MISSING);
});

test("data_readback：文件不存在 → failed；minBytes 不足 → failed", () => {
  const spec = { postconditions: [{ kind: "data_readback", path: "C:/a.xlsx" }] };
  assert.equal(judge({ spec, evidence: { readback: { "C:/a.xlsx": { exists: false } } } }).verdict, VERDICT.FAILED);
  assert.equal(
    judge({ spec: { postconditions: [{ kind: "data_readback", path: "C:/a.xlsx", minBytes: 100 }] },
      evidence: { readback: { "C:/a.xlsx": { exists: true, bytes: 10, mtime: 1 } } } }).verdict,
    VERDICT.FAILED,
  );
});

test("window_state：标题匹配 → ok", () => {
  const r = judge({
    spec: { postconditions: [{ kind: "window_state", titleIncludes: "Excel" }] },
    evidence: { window: { title: "月度报表 - Excel" } },
  });
  assert.equal(r.verdict, VERDICT.OK);
});

test("effect_evidence 判据：未变化即 failed", () => {
  const r = judge({
    spec: { postconditions: [{ kind: "effect_evidence" }] },
    evidence: { effect: { changed: false } },
  });
  assert.equal(r.verdict, VERDICT.FAILED);
});

test("未知判据类型 → needs_review，不崩", () => {
  const r = judge({ spec: { postconditions: [{ kind: "telepathy" }] }, evidence: {} });
  assert.equal(r.verdict, VERDICT.NEEDS_REVIEW);
});

test("buildSpec 容错：无 outcome / 非法条目全部过滤", () => {
  assert.deepEqual(buildSpec(null).postconditions, []);
  assert.deepEqual(buildSpec({}).postconditions, []);
  const s = buildSpec({ outcome: { postconditions: [{ kind: "tree_state" }, null, {}, { kind: 1 }] } });
  assert.equal(s.postconditions.length, 1);
});

test("checkPostcondition 对空证据返回 null 而不是 false", () => {
  assert.equal(checkPostcondition({ kind: "tree_state" }, {}).observed, null);
  assert.equal(checkPostcondition({ kind: "data_readback", path: "x" }, {}).observed, null);
});

test("toRunStatus / isSample：needs_review 不进升降级样本", () => {
  assert.equal(toRunStatus(VERDICT.OK), "ok");
  assert.equal(toRunStatus(VERDICT.FAILED), "failed");
  assert.equal(toRunStatus(VERDICT.NEEDS_REVIEW), "needs_review");
  assert.equal(isSample(VERDICT.OK), true);
  assert.equal(isSample(VERDICT.FAILED), true);
  assert.equal(isSample(VERDICT.NEEDS_REVIEW), false);
});

test("只读配方：有实测回读 → ok/weak，零回读 → needs_review", () => {
  const spec = { postconditions: [], invariants: [], requireEvidence: false };
  const hit = judge({ spec, evidence: { readbackCount: 3 }, readonly: true });
  assert.equal(hit.verdict, VERDICT.OK);
  assert.equal(hit.evidenceLevel, EVIDENCE_LEVEL.WEAK);
  assert.equal(hit.outcomeReasonCode, REASON.READONLY_READBACK);
  const miss = judge({ spec, evidence: { readbackCount: 0 }, readonly: true });
  assert.equal(miss.verdict, VERDICT.NEEDS_REVIEW);
});

test("只读口子不能绕过反证：有退化计数仍判 failed", () => {
  const r = judge({ spec: { postconditions: [] }, evidence: { readbackCount: 9 },
    quality: { anchorFallbacks: 1 }, readonly: true });
  assert.equal(r.verdict, VERDICT.FAILED);
});

test("只读口子不能压过配方声明的判据", () => {
  const r = judge({
    spec: { postconditions: [{ kind: "tree_state", text: "完成" }] },
    evidence: { tree: { text: "还在处理中" }, readbackCount: 5 },
    readonly: true,
  });
  assert.equal(r.verdict, VERDICT.FAILED);
  assert.equal(r.outcomeReasonCode, REASON.POSTCONDITION_UNMET);
});
