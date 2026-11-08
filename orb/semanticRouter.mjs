/* 语义路由（方案 I-26）——只做「这句话该走哪一档」的判定，不调模型、不改调度。
 *
 * 设计取舍：
 * 1) 方案原稿把「Thread 直通」写成提速手段，本地评估已改判：直通省的是钱不是时间
 *    （P50 12.4→12.6 分钟，读缓存 +36.8%），单用户低事件率下时间收益基本为零。
 *    所以对外结果里 savesTime 恒为 false、savesCredits 只在 direct 档为 true，
 *    任何调用方都不可能把它包装成性能优化。
 * 2) 判定必须是确定性的规则匹配（关键词 + 特征），同一输入两次结果必须逐字节相同；
 *    一旦引入模型打分，就无法离线回归，也没法解释「为什么走了这一档」。
 * 3) 只读：默认 mode = observe，classify 只产出建议，绝不改变任何调度状态。
 *    方案要求「有数字之前不开 auto」，因此 auto 被显式拒绝，而不是留个后门。
 * 4) 规则用「视觉 > 确定性 > 后台 > 前台」的优先级：看屏幕的事前台/后台都做不了，
 *    哪怕句子里同时出现文件操作词，也必须先落到 vision。
 */
export const TIERS = ["direct", "front", "vision", "back"];

const MAX_TEXT = 120;      // 回显截断长度：日志里不需要整段 prompt
const MAX_SAMPLES = 200;   // 环形缓冲：只够最近排查用，不做分析存储

/* 特征表：每条是 [标签, 正则]。正则一律不带 g，避免 lastIndex 造成的非确定性。 */
const FEATURES = {
  vision: [
    ["截图", /截图|截屏|截个图|抓屏|screenshot/i],
    ["看屏幕", /(看|查看|看看|观察)(一下|下)?(我的|这个)?(屏幕|桌面|显示器)/],
    ["屏幕", /屏幕(上|里|中)|桌面上的/],
    ["点击", /点击|单击|双击|右键|点一下|点开|click/i],
    ["窗口", /窗口|对话框|弹窗|任务栏|window/i],
    ["界面", /界面|菜单|按钮|图标|面板|选项卡|工具栏|\bUI\b/],
    ["坐标", /坐标|像素位置|\(\s*\d{1,4}\s*,\s*\d{1,4}\s*\)|x\s*=\s*\d+\s*,\s*y\s*=\s*\d+/],
    ["鼠标", /鼠标|光标|拖拽|拖动|滚轮|滚动|mouse|cursor/i],
    ["控件", /输入框|文本框|下拉框|复选框|勾选/],
  ],
  direct: [
    ["文件操作", /(读|写|打开|保存|复制|移动|删除|重命名|创建|新建|列出|查找)(一下|下)?(这个|那个|这份|该)?(文件|文件夹|目录|路径)|\.(txt|json|md|csv|log|png|jpg)\b/i],
    ["命令行", /命令行|终端|shell|powershell|cmd\.exe|bash|(执行|运行)(一下)?(命令|脚本)/i],
    ["时间日期", /现在几点|今天(是)?(几号|星期几|周几)|当前时间|时间戳|日期格式|格式化(时间|日期)/],
    ["纯计算", /计算|算一下|算算|求和|求平均|换算|百分比|开方|[\d.]+\s*[+\-*/×÷]\s*[\d.]+/],
    ["格式转换", /转成\s*(json|csv|utf-?8|base64)|格式化\s*(json|xml)|去重|排序/],
  ],
  back: [
    ["文本生成", /写(一段|一篇|一份|一个)|生成[^，。]{0,8}(文案|文本|文章|内容|邮件|报告)|起草|拟一?[份个篇]/],
    ["总结", /总结|概括|摘要|归纳|提炼|summarize/i],
    ["检索", /检索|搜索|搜一下|查一下|找一下|调研|资料/],
    ["改写", /润色|改写|翻译|校对|重写|扩写|缩写/],
    ["解释", /解释|说明一下|讲讲|介绍一下|为什么|原理|是什么意思/],
  ],
};

/* 优先级顺序即数组顺序：视觉必须最先，其次确定性，再次后台，最后前台。 */
const PRIORITY = ["vision", "direct", "back", "front"];

const BASE_SCORE = { vision: 0.86, direct: 0.8, back: 0.72, front: 0.34 };

const REASON = {
  vision: (tags) => `命中视觉特征（${tags.slice(0, 3).join("/")}），需要看屏幕才能完成`,
  direct: (tags) => `命中确定性特征（${tags.slice(0, 3).join("/")}），可规则直接处理，不必调模型`,
  back: (tags) => `命中纯文本特征（${tags.slice(0, 3).join("/")}），适合后台批量处理`,
  front: () => "未命中明确特征，按通用前台处理",
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round2 = (v) => Math.round(v * 100) / 100;

/* 按「码点」截断，避免把 emoji 的代理对切成半个字。 */
function clip(text) {
  const chars = Array.from(text);
  return chars.length > MAX_TEXT ? chars.slice(0, MAX_TEXT).join("") : text;
}

function matchTier(text, tier) {
  const tags = [];
  const table = FEATURES[tier];
  if (!table) return tags;   // front 是兜底档，没有自己的特征表
  for (const [tag, re] of table) {
    if (re.test(text)) tags.push(tag);
  }
  return tags;
}

export function createSemanticRouter(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const now = typeof o.now === "function" ? o.now : Date.now;

  let mode = "observe";      // 默认只读：只观察，不动调度
  const ring = [];           // 环形缓冲，最新在尾部
  const byTier = { direct: 0, front: 0, vision: 0, back: 0 };
  let total = 0;

  function record(entry) {
    total++;
    byTier[entry.tier] = (byTier[entry.tier] || 0) + 1;
    ring.push(entry);
    while (ring.length > MAX_SAMPLES) ring.shift();
  }

  /* 纯函数式判定：不读时间、不写状态，保证同一输入结果恒定。 */
  function decide(text) {
    const hits = {};
    for (const tier of PRIORITY) hits[tier] = matchTier(text, tier);

    const tier = PRIORITY.find((t) => hits[t].length > 0) || "front";
    const conflicts = PRIORITY.filter((t) => t !== tier && hits[t].length > 0).length;
    const own = hits[tier].length;

    // 命中越多越有把握；存在别的类也命中则降权，避免「看着像就直接」。
    const raw = BASE_SCORE[tier] + 0.04 * (own - 1) - 0.07 * conflicts;
    const score = round2(clamp01(raw));

    return {
      tier,
      score,
      tags: own > 0 ? [...hits[tier]] : [],
      reason: REASON[tier](hits[tier]),
    };
  }

  /* 对外唯一的判定入口：永不抛，一律 { ok, ... }。 */
  function classify(text) {
    if (typeof text !== "string") {
      return { ok: false, error: "bad-input", hint: "classify 只接受字符串" };
    }
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "empty-text" };
    if (mode === "off") {
      // 关闭态不产出建议，也不记样本：没观测就没有统计。
      return { ok: false, error: "router-off" };
    }

    const d = decide(trimmed);
    const result = {
      ok: true,
      text: clip(trimmed),
      tier: d.tier,
      score: d.score,
      tags: d.tags,
      reason: d.reason,
      savesCredits: d.tier === "direct",  // 直通省的是积分
      savesTime: false,                   // 口径：直通不省时间，恒为 false
    };

    record({
      at: now(),
      text: result.text,
      tier: result.tier,
      score: result.score,
      tags: [...result.tags],
      savesCredits: result.savesCredits,
      savesTime: result.savesTime,
    });
    return result;
  }

  /* 只允许 off / observe；auto 明确拒绝（方案：有数字之前不开 auto）。 */
  function setMode(next) {
    if (next === "off" || next === "observe") {
      mode = next;
      return { ok: true, mode };
    }
    if (next === "auto") {
      return { ok: false, error: "auto-not-allowed", reason: "方案要求先有观测数字，当前不具备开 auto 的依据" };
    }
    return { ok: false, error: "bad-mode", hint: "只接受 off / observe" };
  }

  function currentMode() {
    return mode;
  }

  function stats() {
    return {
      ok: true,
      total,
      byTier: { ...byTier },
      observedCreditsSaved: 0,  // 观察模式只是记账，没有真的省下积分
      note: "直通省的是积分不是时间",
    };
  }

  /* 最近记录，新的在前；limit 非法时退回默认 20。 */
  function samples(arg = {}) {
    const a = arg && typeof arg === "object" ? arg : {};
    const raw = Number(a.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_SAMPLES) : 20;
    const list = ring.slice(-limit).reverse().map((s) => ({ ...s, tags: [...s.tags] }));
    return { ok: true, count: list.length, samples: list };
  }

  return { classify, setMode, mode: currentMode, stats, samples };
}
