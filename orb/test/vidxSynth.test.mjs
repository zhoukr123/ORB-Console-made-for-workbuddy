/* vidxSynth「内容提要」契约单测（A）。
 *
 * 曾经「做成 MD 交付」把 index.md 的技术元数据（时长/帧率/字幕段数/情绪引擎）
 * 原样塞进「## 内容提要」，而用户在对话框看到的是 LLM 写的视频叙事 —— 两者对不上。
 * 这里锁住修复后的契约：
 *   · 「内容提要」只放叙事（前端传入 / summary.md / meta.summary）；
 *   · 技术元数据一律进「技术信息与产物说明」，绝不冒充提要；
 *   · 没有叙事时如实标注缺失，不再拿技术信息糊弄；
 *   · 叙事落盘后重跑能复用同一份，保证 MD 与后续导出同源。 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesizeVidxMd } from "../vidxSynth.mjs";

const INDEX_MD = [
  "---",
  'key: "k"',
  "---",
  "",
  "# 上下文的真正开源",
  "",
  "- 时长：4:00 · 640×360 · 30fps · hevc",
  "- 台词：有（86 段带时间戳）",
  "- 截图：48 张",
  "",
  "## 怎么用这些产物",
  "",
  "1. 先读 timeline.md",
  "",
].join("\n");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orb-vidxsynth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jobDir = path.join(root, "job");
  const exportsDir = path.join(root, "exports");
  fs.mkdirSync(path.join(jobDir, "frames"), { recursive: true });
  fs.mkdirSync(exportsDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "meta.json"), JSON.stringify({
    title: "上下文的真正开源", origin: "https://example.com/v", durationSec: 240,
  }));
  fs.writeFileSync(path.join(jobDir, "index.md"), INDEX_MD);
  fs.writeFileSync(path.join(jobDir, "frames.json"), JSON.stringify({
    frames: [{ file: "f0.jpg", t: 0 }, { file: "f1.jpg", t: 5 }],
  }));
  for (const f of ["f0.jpg", "f1.jpg"]) fs.writeFileSync(path.join(jobDir, "frames", f), "fake-jpeg");
  const layout = {
    day: () => "2026-11-07",
    kindDir: (kind) => (kind === "exports" ? exportsDir : null),
  };
  const run = (extra = {}) => synthesizeVidxMd({
    layout, jobDir, day: "2026-11-07", cid: "c-1", count: 2, ...extra,
  });
  return { root, jobDir, exportsDir, run };
}

const NARRATIVE = [
  "# 内容提要：《上下文的真正开源》",
  "",
  "核心是演示 dsh-context 这个 DeepSeek Harness 插件，把上下文变成可观察对象。",
  "",
  "## 安装与接入（0:00–0:20）",
  "在桌面端「添加插件」里填 GitHub 仓库名即可。",
].join("\n");

test("无叙事：提要如实标注缺失，技术元数据挪进独立小节且降级标题", (t) => {
  const fx = fixture(t);
  const r = fx.run();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.hasSummary, false);
  assert.equal(r.rel, "exports/2026-11-07/" + r.mdName + ".md");
  const md = fs.readFileSync(r.mdPath, "utf8");
  assert.match(md, /## 内容提要\n\n（该任务未生成文字提要/);
  assert.ok(md.includes("## 技术信息与产物说明"));
  assert.ok(md.includes("640×360 · 30fps · hevc"), "技术元数据仍在，只是换了位置");
  assert.ok(md.includes("### 怎么用这些产物"), "index.md 的二级标题降一级，不与文档层级打架");
  assert.ok(!md.includes("# 上下文的真正开源\n\n- 时长"), "重复的一级标题已去掉");
  const digest = md.slice(md.indexOf("## 内容提要"), md.indexOf("## 技术信息与产物说明"));
  assert.ok(!digest.includes("640×360"), "技术元数据绝不能出现在提要节里");
  assert.ok(fs.existsSync(path.join(r.framesDir, "f0.jpg")), "关键帧照常复制");
});

test("有叙事：提要就是对话框那一段，技术信息单列，且叙事落盘可复用", (t) => {
  const fx = fixture(t);
  const r = fx.run({ summary: NARRATIVE });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.hasSummary, true);
  const md = fs.readFileSync(r.mdPath, "utf8");
  const digest = md.slice(md.indexOf("## 内容提要"), md.indexOf("## 技术信息与产物说明"));
  assert.ok(digest.includes("dsh-context 这个 DeepSeek Harness 插件"), "叙事正文进提要");
  assert.ok(digest.includes("在桌面端「添加插件」里填 GitHub 仓库名即可"), "叙事尾部没被截断");
  assert.ok(digest.includes("## 安装与接入"), "叙事原样保留，不被改写");
  assert.ok(!digest.includes("640×360"), "提要节里没有技术元数据");
  assert.ok(md.includes("## 技术信息与产物说明"), "技术信息仍单列保留");
  assert.ok(md.includes("## 关键截图（共 2 张"), "关键截图段不变");

  // 落盘的叙事成为单一事实源：不传 summary 重跑，提要仍是同一份
  assert.ok(fs.existsSync(path.join(fx.jobDir, "summary.md")));
  const r2 = fx.run();
  const md2 = fs.readFileSync(r2.mdPath, "utf8");
  assert.equal(r2.hasSummary, true);
  const digest2 = md2.slice(md2.indexOf("## 内容提要"), md2.indexOf("## 技术信息与产物说明"));
  assert.ok(digest2.includes("dsh-context 这个 DeepSeek Harness 插件"));
});

test("meta.json 的 summary 作为第三优先级；叙事里的尖括号不破坏 MD", (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.jobDir, "meta.json"), JSON.stringify({
    title: "上下文的真正开源", summary: "来自 meta 的叙事 <未加工>",
  }));
  const r = fx.run();
  assert.equal(r.hasSummary, true);
  const md = fs.readFileSync(r.mdPath, "utf8");
  assert.ok(md.includes("来自 meta 的叙事 <未加工>"));
});

test("前端传入的叙事优先于任务目录里已有的旧叙事", (t) => {
  const fx = fixture(t);
  fs.writeFileSync(path.join(fx.jobDir, "summary.md"), "旧的一份叙事");
  const r = fx.run({ summary: NARRATIVE });
  const md = fs.readFileSync(r.mdPath, "utf8");
  assert.ok(md.includes("dsh-context 这个 DeepSeek Harness 插件"));
  assert.ok(!md.includes("旧的一份叙事"));
  assert.equal(fs.readFileSync(path.join(fx.jobDir, "summary.md"), "utf8"), NARRATIVE);
});
