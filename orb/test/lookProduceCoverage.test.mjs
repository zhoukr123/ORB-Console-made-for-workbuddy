/* 面板粗筛 ⊇ 桥文法（2026-11-06）。
 *
 * 为什么需要这条不变式：
 *   面板只用三类词做粗筛「值不值得问桥」，真正的判定在桥的 parseProduceIntent。
 *   粗筛一旦漏了某个写法，桥再全能也没人问它 —— 这条链路就对用户**静默失效**，
 *   表现为「同样一句话，有时秒回、有时派 Agent」，而且查不到原因。
 *
 * 锁住的方向只有一个：桥认得出 ⇒ 粗筛必须也为真（交集覆盖）。
 * 反过来不要求：粗筛为真而桥拒绝是允许的（粗筛宁松勿紧，桥会严格拒绝、不乱执行）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseProduceIntent, ACTIONS, intentVerbs, orchestratorSchema,
} from "../searchOrchestrator.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = fs.readFileSync(path.join(ROOT, "desktop", "panel.html"), "utf8");

/* 按标记抽出粗筛段，丢进独立函数作用域跑 —— 面板不必被整体加载。 */
function loadLook() {
  const s = PANEL.indexOf("/* ==== LOOKPRODUCE_START ====");
  const e = PANEL.indexOf("/* ==== LOOKPRODUCE_END ==== */");
  assert.ok(s >= 0 && e > s, "面板里找不到粗筛段标记");
  const src = PANEL.slice(s, e);
  /* eslint-disable no-new-func */
  const fn = new Function(src + "\nreturn { lookingLikeSearchProduce, buildLookFromSchema };");
  return fn();
}

const look = loadLook();
/* 用桥运行时**同一份** schema 初始化粗筛（不再手抄第二套词表）。 */
const SCHEMA = orchestratorSchema();
assert.ok(SCHEMA && SCHEMA.coarse && SCHEMA.coarse.search, "schema 必须暴露 coarse 词表给面板");
look.buildLookFromSchema(SCHEMA);
const lookingLike = look.lookingLikeSearchProduce;

/* 覆盖每个动作 + 各种写法：换动词、加数量、倒装、礼貌词、带标点、剪贴板。
   这份清单既是回归样本，也是「动作表加了新场景后粗筛有没有跟上」的守门人。 */
const SENTENCES = [
  "帮我搜一下 DeepSeek V4，前三条记到笔记",
  "搜索 湖南大学 前5条结果写入文档",
  "帮我查找 长沙 天气 存到文件",
  "找找 考研分数线 整理成文档",
  "把 DeepSeek V4 的前两条搜索结果整理成文档",
  "检索 结构化结果 写入文档",
  "搜一下 ORB 然后记到文档",
  "搜索一下 DeepSeek Search 记入笔记",
  "查一下 天气预报 汇总成清单",
  "搜一搜 论文 导出为文本",
  "搜一下 长沙天气，把前两条复制到剪贴板",
  "搜一下 DeepSeek V4 发布，然后把前三条复制到剪贴板",
  "查一下 停车位 放到剪贴板",
  "检索 ORB 前十条存进备忘录",
  "找一找 会议纪要 整理为 markdown",
];

test("粗筛段能独立加载（面板不必整体跑起来就能测）", () => {
  assert.equal(typeof lookingLike, "function");
});

test("粗筛未同步 schema 前：一律放行（宁松勿紧，绝不漏问）", () => {
  /* 新作用域 = 尚未 buildLookFromSchema：任何非空短句都该放行去问桥；
     但空句/多行/超长这些硬边界仍然挡掉。 */
  const fresh = loadLook();
  assert.equal(fresh.lookingLikeSearchProduce("随便一句话"), true);
  assert.equal(fresh.lookingLikeSearchProduce("搜一下 X 记到文档"), true);
  assert.equal(fresh.lookingLikeSearchProduce(""), false);
  assert.equal(fresh.lookingLikeSearchProduce("搜一下 X\n记到文档"), false);
});

test("桥认得出的句子，粗筛必须也为真（否则链路静默失效）", () => {
  const missed = [];
  for (const s of SENTENCES) {
    const r = parseProduceIntent(s);
    if (r.ok !== true) { missed.push(s + " ← 桥其实也没认，样本写错了"); continue; }
    if (!lookingLike(s)) missed.push(s);
  }
  assert.deepEqual(missed, [], "粗筛漏了这些句子：" + missed.join(" / "));
});

test("样本本身有效：每个动作至少被覆盖到一次", () => {
  const seen = new Set();
  for (const s of SENTENCES) {
    const r = parseProduceIntent(s);
    if (r.ok === true) seen.add(r.action);
  }
  for (const id of Object.keys(ACTIONS)) {
    assert.ok(seen.has(id), "样本没覆盖动作 " + id + "：动作表加了新场景，样本也要跟着加");
  }
});

test("粗筛宁松勿紧：桥拒绝的句子粗筛可以为真，但不许反过来", () => {
  /* 「整理成表格」桥会回 unsupported-format（认得出、写不了），粗筛为真没问题 ——
     面板问一次桥拿到 reasonCode，再照常回落，比漏检好。 */
  assert.equal(lookingLike("搜一下 X 整理成表格"), true);
  assert.equal(parseProduceIntent("搜一下 X 整理成表格").reasonCode, "unsupported-format");
  /* 空句 / 多行 / 超长一律不粗筛：这几条是硬边界，两边一致。 */
  for (const bad of ["", "   ", "搜一下 X\n记到文档", "搜一下 " + "X".repeat(200) + " 记到文档"]) {
    assert.equal(lookingLike(bad), false, JSON.stringify(bad.slice(0, 20)));
  }
});

/* 穷举：动词表 × 目标词。词表从正则里拆出来（intentVerbs），测试不手抄第二份。
   这样以后在正则里加一个动词，这条用例自动覆盖它，面板没跟上就当场红。 */
test("穷举动词表 × 目标词：桥认的每一句粗筛都必须认", () => {
  const { search, produce } = intentVerbs();
  assert.ok(search.length >= 8 && produce.length >= 10, "动词表规模异常，检查正则是否被改坏");
  const gaps = [];
  let recognized = 0;
  for (const a of Object.values(ACTIONS)) {
    for (const target of a.targets) {
      for (const sv of search) {
        for (const pv of produce) {
          const s = `${sv} 测试词 ${pv}${target}`;
          if (parseProduceIntent(s).ok !== true) continue;
          recognized++;
          if (!lookingLike(s)) gaps.push(s);
        }
      }
    }
  }
  assert.ok(recognized >= 100, "可识别组合太少（" + recognized + "），穷举没跑到实质内容");
  assert.deepEqual(gaps.slice(0, 10), [], "有 " + gaps.length + " 个组合桥认、粗筛不认");
});
