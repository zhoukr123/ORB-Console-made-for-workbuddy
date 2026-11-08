import test from "node:test";
import assert from "node:assert/strict";
import { stabilize, diffLines } from "../outcomeEvidence.mjs";

const join = (a) => a.join("\n");

test("新增行被提取：只在 after 里出现的才算", () => {
  const before = join(["文件(F) 编辑(E)", "工具栏"]);
  const after = join(["文件(F) 编辑(E)", "工具栏", "导出成功：月度报表.xlsx"]);
  const r = diffLines(before, after);
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].text, "导出成功：月度报表.xlsx");
  assert.equal(r.lines[0].why, "运行后新出现的行");
});

test("before 里已有的行不算新增（哪怕出现多次）", () => {
  const before = join(["保存", "保存"]);
  const after = join(["保存", "另存为对话框", "保存"]);
  const r = diffLines(before, after);
  assert.deepEqual(r.lines.map((x) => x.text), ["另存为对话框"]);
});

test("纯数字 / 时间 / 日期 / 纯符号被滤掉", () => {
  const r = diffLines("", join(["12345", "12:34", "12:34:56", "2026-11-08 导出", "----", ">>>", "…"]));
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 0);
  assert.ok(r.added > 0, "被滤掉不等于没新增");
});

test("路径与 URL 被滤掉：它们是数据不是结论", () => {
  const r = diffLines("", join(["D:\\导出\\报表.xlsx", "\\\\nas\\share\\a.txt", "/home/u/a.log", "https://x.test/a"]));
  assert.equal(r.lines.length, 0);
});

test("万用按钮文字被滤掉：它们成功失败都在", () => {
  const r = diffLines("", join(["确定", "取消", "关闭", "是", "否", "OK", "Cancel"]));
  assert.equal(r.lines.length, 0);
});

test("stabilize 清掉 ref 编号 / 坐标 / 长 hex（否则判据会随界面编号漂移）", () => {
  assert.equal(stabilize('button "导出" [ref=12]'), 'button "导出"');
  assert.equal(stabilize("图片 (120, 340) 已保存"), "图片 已保存");
  assert.equal(stabilize("句柄 a1b2c3d4e5f6 已释放"), "句柄 已释放");
  assert.equal(stabilize("[3] 完成"), "完成");
});

test("清洗后为空的丢弃（原本只有易变片段）", () => {
  const r = diffLines("", join(["[ref=7]", "(10, 20)", "a1b2c3d4e5f6"]));
  assert.equal(r.lines.length, 0);
});

test("过短的片段丢弃：单字在树里几乎恒真，没有判别力", () => {
  const r = diffLines("", join(["完", "好", "已保存"]));
  assert.deepEqual(r.lines.map((x) => x.text), ["已保存"]);
});

test("过长的行丢弃：整段日志塞进判据没法维护", () => {
  const long = "导出".repeat(40);
  const r = diffLines("", join([long, "导出完成"]));
  assert.deepEqual(r.lines.map((x) => x.text), ["导出完成"]);
});

test("重复行只留一条（控件树里同名控件很常见）", () => {
  const r = diffLines("", join(["导出完成", "导出完成", "导出完成"]));
  assert.equal(r.lines.length, 1);
});

test("候选上限生效", () => {
  const many = Array.from({ length: 20 }, (_, i) => "提示行第" + i + "条");
  const r = diffLines("", join(many), { max: 3 });
  assert.equal(r.lines.length, 3);
  assert.equal(r.kept, 3);
  assert.ok(r.added >= 3);
});

test("没有 before 也能取证，但明说「不精确」", () => {
  const r = diffLines("", join(["导出完成"]));
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0].why, /没有运行前基线/);
});

test("没有 after 时明确拒绝：抓不到就无从取证", () => {
  const r = diffLines("abc", "");
  assert.equal(r.ok, false);
  assert.match(r.reason, /抓不到/);
});

test("空 / 非法入参不崩", () => {
  for (const [a, b] of [[null, null], [undefined, undefined], [123, 456], [{}, []]]) {
    const r = diffLines(a, b);
    assert.equal(r.ok, false);
    assert.deepEqual(r.lines, []);
  }
  assert.equal(stabilize(null), "");
  assert.equal(stabilize(undefined), "");
  assert.equal(stabilize(123), "123");
});

test("前后完全一致：没有新增，reason 说清是「界面没变」", () => {
  const t = join(["窗口标题", "工具栏"]);
  const r = diffLines(t, t);
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 0);
  assert.equal(r.added, 0);
  assert.match(r.reason, /没有新增行/);
});

test("返回的 raw 保留原行便于对照，text 是清洗后可搜的片段", () => {
  const r = diffLines("", join(['static "导出成功" [ref=9]']));
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0].raw, /ref=9/, "raw 用于让人对照界面");
  assert.ok(!/ref=9/.test(r.lines[0].text), "text 必须能稳定搜到");
});
