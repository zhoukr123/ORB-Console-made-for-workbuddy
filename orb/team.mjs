/* 专家团（阶段一形态）：单模型多视角 + 确定性校验器。
 *
 * 设计取舍：
 * 1) 本模块不调用任何模型。多 Agent 各自独立实例、各自发声，会让「同一份输入两次评审结论不同」，
 *    评审就失去可审计性；这里只登记「视角」（纯数据），把判断留给人，把聚合留给确定性代码。
 * 2) 聚合顺序固定（归一化去重 → 过滤 → 冲突 → 排序 → 裁决），最后同分再按 claim 兜底排序，
 *    保证结果完全可复现：可以 diff、可以重放、可以在面板上解释「为什么是这条排前面」。
 * 3) 冲突绝不自动裁决。support 与 oppose 同时出现只置 needsHuman，机器不替人做取舍。
 * 4) 对外方法一律不抛异常：bridge/面板会高频调用，一次 throw 会拖垮主流程；
 *    失败统一返回 { ok:false, error }，调用方按返回值分支即可。
 * 5) 时间与文件系统全部注入（now/fs）。测试用固定 now + 临时目录就能重放，不必 mock 全局对象。
 * 6) weight 只是展示/排序的候选元数据，不参与 verdict —— 裁决一旦掺入主观权重就不可复现了。
 */
import * as fsDefault from "node:fs";
import path from "node:path";

const SEVERITY_WEIGHT = { block: 3, warn: 2, info: 1 };
const SEVERITIES = ["block", "warn", "info"];
const STANCES = ["support", "oppose"];
const BLOCK_CONFIDENCE = 0.7;   // 低于这条线不算「硬阻断」，降级成警告而不是当成通过
const DEFAULT_CONFIDENCE = 0.5;
const HISTORY_LIMIT = 200;      // 只留最近的评审，内存不随会话无限长

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const collapse = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const normKey = (v) => collapse(v).toLowerCase();          // 去重键：大小写/空白差异不该算两条
const confOf = (v) => (typeof v === "number" && Number.isFinite(v) ? clamp01(v) : DEFAULT_CONFIDENCE);
const sevOf = (v) => (SEVERITIES.includes(v) ? v : "info");
const stanceOf = (v) => (STANCES.includes(v) ? v : null);
/* 落盘文件名用：只留安全字符，避免视角 id 变成路径跳转。 */
const safeSeg = (v) => String(v ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "unknown";
const clone = (v) => JSON.parse(JSON.stringify(v));

export const BUILTIN_EXPERTS = [
  {
    id: "arch",
    name: "架构视角",
    icon: "layers",
    role: "看边界与耦合",
    brief: "盯模块边界、依赖方向与耦合度，防止改动把两片本不相干的代码粘在一起。",
    checks: [
      "新逻辑是否越层调用（UI 直接摸存储、路由直接做副作用）",
      "依赖方向是否单向，有无循环引用",
      "公共接口是否被随手扩大，改动是否外溢到无关模块",
      "状态归属是否唯一，有无两处各存一份真相",
    ],
    inputs: ["改动涉及的模块与调用链", "现有接口签名"],
    outputs: ["边界违规点", "建议收敛的接口"],
    keywords: ["架构", "耦合", "边界", "依赖", "模块", "分层"],
    weight: 1,
  },
  {
    id: "sec",
    name: "安全视角",
    icon: "shield",
    role: "看权限与急停",
    brief: "检查权限边界、危险动作确认与急停可达性，任何能绕过中断的路径都要拦。",
    checks: [
      "危险动作前是否仍有可中断的确认点",
      "急停/停止信号是否还能立刻送达，有无被批量合并吃掉",
      "外部输入是否直接进了命令、路径或选择器",
      "权限提升是否显式、可审计，有无隐式越权",
    ],
    inputs: ["动作链路与中断点", "权限与确认策略"],
    outputs: ["绕过中断的路径", "需补的确认点"],
    keywords: ["安全", "权限", "急停", "中断", "确认", "越权", "注入"],
    weight: 1.2,
  },
  {
    id: "ux",
    name: "交互视角",
    icon: "cursor",
    role: "看好不好用",
    brief: "站在使用者一侧看：状态是否可见、下一步是否可发现、出错能否自己恢复。",
    checks: [
      "关键状态是否在界面上可见，而不是只写日志",
      "下一步操作是否可发现，空态/失败态是否有指引",
      "错误信息是否说清「发生了什么 + 怎么办」",
      "键盘可达性、焦点顺序与屏幕阅读器信息是否完整",
    ],
    inputs: ["界面截图或流程描述", "用户可见文案"],
    outputs: ["可发现性缺口", "文案与无障碍问题"],
    keywords: ["交互", "可发现性", "无障碍", "文案", "空态", "焦点", "体验"],
    weight: 1,
  },
  {
    id: "perf",
    name: "性能视角",
    icon: "gauge",
    role: "看资源与时延",
    brief: "关心常驻内存、事件频率与首帧时延，尤其警惕无界缓存和同步阻塞调用。",
    checks: [
      "是否有无界增长的数组/Map/日志缓冲",
      "高频事件是否做了节流，回调里有无同步 IO",
      "轮询与定时器是否可被清理，退出后是否残留",
      "大对象是否被长生命周期引用持有",
    ],
    inputs: ["热点路径与调用频率", "内存/时延基线"],
    outputs: ["资源泄漏点", "可去掉的同步阻塞"],
    keywords: ["性能", "资源", "时延", "内存", "泄漏", "节流", "阻塞"],
    weight: 0.9,
  },
  {
    id: "correct",
    name: "正确性视角",
    icon: "check",
    role: "看边界与回归",
    brief: "专挑边界条件与旧行为回归：空值、极端值、并发与「以前是好的」那部分。",
    checks: [
      "空数组、null、超长输入、零值是否都有明确行为",
      "时间/时区/序号回绕等边界是否被处理",
      "旧调用方是否被新语义悄悄改坏",
      "失败分支是否真的返回失败，而不是静默吞掉",
    ],
    inputs: ["改动前后的行为差异", "现有测试与已知回归点"],
    outputs: ["边界用例缺口", "回归风险点"],
    keywords: ["正确性", "边界", "回归", "空值", "并发", "用例", "极端值"],
    weight: 1.1,
  },
  {
    id: "core-team",
    name: "核心评审团",
    kind: "team",
    members: ["arch", "sec", "ux", "perf", "correct"],
    policy: "parallel",
    brief: "五个视角并行各查一遍，再由确定性规则聚合；不做多实例互评，避免结论不可复现。",
  },
];

export function createTeam(opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  const fs = o.fs || fsDefault;
  const baseDir = typeof o.dir === "string" && o.dir ? o.dir : null;

  const registry = new Map();          // id -> 深拷贝的登记项（内置表只读，运行时只动副本）
  const order = [];
  const enabled = new Map();           // id -> boolean，关掉的视角不参与裁决
  for (const item of BUILTIN_EXPERTS) {
    const copy = clone(item);
    registry.set(copy.id, copy);
    order.push(copy.id);
    enabled.set(copy.id, true);
  }

  const history = [];                  // 最近若干次评审，供 detail 回溯证据
  let reviews = 0;
  let lastReviewAt = null;

  const isTeam = (e) => !!e && e.kind === "team";
  const expertIds = () => order.filter((id) => !isTeam(registry.get(id)));
  const teamIds = () => order.filter((id) => isTeam(registry.get(id)));

  function stats() {
    return {
      experts: expertIds().length,
      teams: teamIds().length,
      reviews,
      lastReviewAt,
    };
  }

  function list() {
    try {
      const experts = expertIds().map((id) => ({ ...clone(registry.get(id)), enabled: enabled.get(id) !== false }));
      const teams = teamIds().map((id) => ({ ...clone(registry.get(id)), enabled: enabled.get(id) !== false }));
      return { ok: true, experts, teams, stats: stats() };
    } catch {
      return { ok: false, error: "internal" };
    }
  }

  function detail(id, arg = {}) {
    try {
      const e = registry.get(String(id ?? ""));
      if (!e) return { ok: false, error: "unknown-expert" };
      const limit = Number(arg && arg.limit) > 0 ? Math.floor(Number(arg.limit)) : 20;
      const recent = [];
      const evidence = [];
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        const mine = h.ranked.filter((f) => f.expertId === e.id);
        if (!mine.length) continue;
        if (recent.length < limit) {
          recent.push({ at: h.at, subject: h.subject, verdict: h.verdict, findings: mine.length });
        }
        for (const f of mine) {
          if (evidence.length >= limit) break;
          if (f.evidence) evidence.push({ at: h.at, subject: h.subject, topic: f.topic, claim: f.claim, evidence: f.evidence });
        }
      }
      return {
        ok: true,
        expert: { ...clone(e), enabled: enabled.get(e.id) !== false },
        recent,
        evidence,
      };
    } catch {
      return { ok: false, error: "internal" };
    }
  }

  function setEnabled(id, on) {
    try {
      const key = String(id ?? "");
      if (!registry.has(key)) return { ok: false, error: "unknown-expert" };
      enabled.set(key, on === true);
      return { ok: true, id: key, enabled: on === true };
    } catch (err) {
      return { ok: false, error: "internal" };
    }
  }

  function isEnabled(id) {
    return enabled.get(String(id ?? "")) === true;   // 未知 id 一律视为未启用
  }

  /* 归一化单条发现；不合法返回 { reject: reason }。 */
  function normalizeFinding(f) {
    if (!f || typeof f !== "object") return { reject: "bad-finding" };
    const claim = collapse(f.claim);
    if (!claim) return { reject: "empty-claim" };
    const expertId = String(f.expertId ?? "").trim();
    const expert = registry.get(expertId);
    if (!expert || isTeam(expert)) return { reject: "unknown-expert" };
    if (enabled.get(expertId) === false) return { reject: "expert-disabled" };
    const topic = collapse(f.topic);
    return {
      finding: {
        expertId,
        expertName: expert.name,
        claim,
        topic,
        severity: sevOf(f.severity),
        stance: stanceOf(f.stance),
        confidence: confOf(f.confidence),
        evidence: typeof f.evidence === "string" ? collapse(f.evidence) : "",
      },
      key: normKey(claim),
    };
  }

  /* 排序比较器：严重度 → 置信度 → 主题 → claim 键。
   * 第四个键是为了让「严重度/置信度/主题全同」时也有唯一顺序，否则结果依赖输入顺序。 */
  function compare(a, b) {
    const w = (SEVERITY_WEIGHT[b.severity] || 0) - (SEVERITY_WEIGHT[a.severity] || 0);
    if (w !== 0) return w;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.topic !== b.topic) return a.topic < b.topic ? -1 : 1;
    const ka = normKey(a.claim);
    const kb = normKey(b.claim);
    if (ka === kb) return 0;
    return ka < kb ? -1 : 1;
  }

  function review(input) {
    try {
      const a = input && typeof input === "object" ? input : null;
      if (!a) return { ok: false, error: "bad-input" };
      const subject = collapse(a.subject);
      if (!subject) return { ok: false, error: "bad-subject" };
      if (!Array.isArray(a.findings)) return { ok: false, error: "bad-findings" };

      const ts = now();
      const raw = a.findings;
      const rejected = [];
      const byKey = new Map();     // 去重键 -> { finding, dupCount }
      let duplicates = 0;

      for (const item of raw) {
        const r = normalizeFinding(item);
        if (r.reject) {
          rejected.push({ claim: collapse(item && item.claim), reason: r.reject });
          continue;
        }
        const prev = byKey.get(r.key);
        if (!prev) {
          byKey.set(r.key, { finding: r.finding, dupCount: 0 });
          continue;
        }
        // 同键保留置信度更高的那条；平手保留先到的那条（顺序固定，不随机）
        duplicates++;
        prev.dupCount++;
        if (r.finding.confidence > prev.finding.confidence) prev.finding = r.finding;
      }

      const kept = [...byKey.values()].map((v) => v.finding);
      kept.sort(compare);

      // 冲突：同一 topic 上同时有支持与反对。topic 为空的发现不参与（没有共同主题就谈不上对立）
      const byTopic = new Map();
      for (const f of kept) {
        if (!f.topic || !f.stance) continue;
        if (!byTopic.has(f.topic)) byTopic.set(f.topic, { support: [], oppose: [] });
        byTopic.get(f.topic)[f.stance].push(f);
      }
      const conflicts = [];
      for (const [topic, sides] of [...byTopic.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
        if (!sides.support.length || !sides.oppose.length) continue;
        conflicts.push({
          topic,
          a: { expertId: sides.support[0].expertId, claim: sides.support[0].claim },
          b: { expertId: sides.oppose[0].expertId, claim: sides.oppose[0].claim },
        });
      }

      const counts = {
        total: raw.length,
        kept: kept.length,
        duplicates,
        rejected: rejected.length,
        conflicts: conflicts.length,
        block: 0, warn: 0, info: 0,
      };
      for (const f of kept) counts[f.severity]++;

      // 裁决：只有「block 且高置信」才阻断；低置信 block 降级成警告，不能当成通过混过去
      const hardBlock = kept.filter((f) => f.severity === "block" && f.confidence >= BLOCK_CONFIDENCE).length;
      const softBlock = kept.filter((f) => f.severity === "block" && f.confidence < BLOCK_CONFIDENCE).length;
      let verdict = "pass";
      if (hardBlock > 0) verdict = "block";
      else if (counts.warn > 0 || softBlock > 0) verdict = "warn";

      const needsHuman = conflicts.length > 0;   // 冲突不自动裁决

      const perspectives = expertIds().map((id) => {
        const e = registry.get(id);
        return { id, name: e.name, findings: kept.filter((f) => f.expertId === id).length };
      });
      const active = perspectives.filter((p) => p.findings > 0);

      const decisionText = verdict === "block"
        ? `裁决：阻断。存在 ${hardBlock} 条高置信度阻断意见（置信度 ≥ ${BLOCK_CONFIDENCE}），不建议继续。`
        : verdict === "warn"
          ? `裁决：警告。没有高置信度阻断意见，但有 ${counts.warn + softBlock} 条需关注项，处理后再继续。`
          : "裁决：通过。本轮没有阻断或警告级发现。";
      const decision = needsHuman ? `${decisionText} 另检测到 ${conflicts.length} 处同主题对立意见，须人工裁决。` : decisionText;

      const fourStage = {
        discover: active.length
          ? `本轮 ${active.length} 个视角共提出 ${kept.length} 条发现：${active.map((p) => `${p.name} ${p.findings}`).join(" / ")}。`
          : "本轮 0 个视角提出 0 条发现。",
        evidence: counts.kept
          ? `证据原文落在 ${kept.filter((f) => f.evidence).length} 条发现的 evidence 字段，已按视角归档到 evidence 目录（一视角一文件）。`
          : "本轮没有发现，无证据需要归档。",
        decision,
        skill: kept.length
          ? `可把本轮 ${new Set(kept.map((f) => f.topic).filter(Boolean)).size} 个主题沉淀为「同类情况先查」检查项，已写入 skill.md。`
          : "本轮无新增检查项，沿用既有清单即可。",
      };

      const result = {
        ok: true,
        subject,
        epoch: a.epoch ?? null,
        ticketId: a.ticketId != null ? String(a.ticketId) : null,
        generatedAt: ts,
        verdict,
        needsHuman,
        counts,
        ranked: kept.map((f) => ({ ...f })),
        conflicts,
        rejected,
        fourStage,
        perspectives,
      };

      reviews++;
      lastReviewAt = ts;
      history.push({ at: ts, subject, verdict, ranked: kept.map((f) => ({ ...f })) });
      while (history.length > HISTORY_LIMIT) history.shift();

      return result;
    } catch (err) {
      return { ok: false, error: "internal" };
    }
  }

  /* 表格单元格转义：先转义反斜杠再转义竖线，否则 \| 会被二次转义成字面反斜杠+分隔符。
   * 换行直接压成空格 —— 表格行一旦断行就整段错位，且不允许输出 HTML。 */
  function cell(v) {
    return String(v ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  }

  function buildReport(rv) {
    const rows = rv.ranked.map((f) =>
      `| ${cell(f.severity)} | ${cell(`${f.expertName}（${f.expertId}）`)} | ${cell(f.topic || "-")} | ${cell(f.claim)} | ${f.confidence.toFixed(2)} |`,
    );
    const table = rows.length
      ? ["| 严重度 | 视角 | 主题 | 说法 | 置信度 |", "| --- | --- | --- | --- | --- |", ...rows].join("\n")
      : "| 严重度 | 视角 | 主题 | 说法 | 置信度 |\n| --- | --- | --- | --- | --- |\n| - | - | - | 本轮无发现 | - |";
    const conflictBlock = rv.conflicts.length
      ? rv.conflicts.map((c) => `- 主题「${cell(c.topic)}」：${cell(c.a.expertId)} 主张「${cell(c.a.claim)}」，${cell(c.b.expertId)} 反对「${cell(c.b.claim)}」`).join("\n")
      : "无";
    return [
      `# 评审报告：${cell(rv.subject)}`,
      "",
      `> ${cell(rv.fourStage.decision)}`,
      "",
      "## 一、发现",
      "",
      rv.fourStage.discover,
      "",
      "## 二、证据",
      "",
      rv.fourStage.evidence,
      "",
      "## 三、裁决",
      "",
      rv.fourStage.decision,
      "",
      "## 四、沉淀",
      "",
      rv.fourStage.skill,
      "",
      "## 排序后的发现",
      "",
      table,
      "",
      "## 冲突",
      "",
      conflictBlock,
      "",
    ].join("\n");
  }

  function buildSkill(rv) {
    const bullets = [];
    const top = rv.ranked.slice(0, 5);
    if (!top.length) bullets.push("- 本轮无发现，保持现有检查项即可。");
    for (const f of top) {
      const tag = f.severity === "block" ? "阻断" : f.severity === "warn" ? "警告" : "提示";
      bullets.push(`- 查「${cell(f.topic) || "未分类"}」：${cell(f.claim)}（${tag} / 置信度 ${f.confidence.toFixed(2)}）`);
    }
    for (const c of rv.conflicts) {
      bullets.push(`- 冲突「${cell(c.topic)}」：「${cell(c.a.claim)}」vs「${cell(c.b.claim)}」—— 两种意见对立，先人工定调再动手。`);
    }
    return [
      `# 自动沉淀：${cell(rv.subject)}`,
      "",
      "> 本清单由 ORB 专家团按确定性规则生成，不是模型撰写；同样的发现重跑必得同样的清单。",
      "",
      `- 裁决：${rv.verdict}${rv.needsHuman ? "（含待人工裁决项）" : ""}`,
      "",
      "## 以后遇到同类情况先查这几条",
      "",
      ...bullets,
      "",
    ].join("\n");
  }

  /* 原子写：先写 .part 再 rename，中途崩掉也不会留下半截文件被下游当成完整报告读走。 */
  function writeAtomic(dir, rel, content) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.part`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, abs);
    return rel.split(path.sep).join("/");
  }

  function writeReport(rv, arg = {}) {
    try {
      const a = arg && typeof arg === "object" ? arg : {};
      if (!rv || typeof rv !== "object" || rv.ok !== true || !Array.isArray(rv.ranked)) {
        return { ok: false, error: "bad-review" };
      }
      const dir = typeof a.dir === "string" && a.dir ? a.dir : baseDir;
      if (!dir) return { ok: false, error: "no-dir" };

      const files = [];
      files.push(writeAtomic(dir, "report.md", buildReport(rv)));
      files.push(writeAtomic(dir, "skill.md", buildSkill(rv)));

      const byExpert = new Map();
      for (const f of rv.ranked) {
        if (!byExpert.has(f.expertId)) byExpert.set(f.expertId, []);
        byExpert.get(f.expertId).push(f);
      }
      for (const [id, items] of byExpert) {
        files.push(writeAtomic(dir, `evidence/${safeSeg(id)}.json`, JSON.stringify(items, null, 2) + "\n"));
      }

      const manifest = {
        subject: rv.subject,
        epoch: rv.epoch ?? null,
        ticketId: rv.ticketId ?? null,
        generatedAt: rv.generatedAt ?? now(),
        verdict: rv.verdict,
        files: files.slice(),
      };
      // manifest 只列其它文件，不列自己：否则文件列表会随写入顺序自指，读起来永远多一项。
      files.push(writeAtomic(dir, "manifest.json", JSON.stringify(manifest, null, 2) + "\n"));

      return { ok: true, dir, files };
    } catch (err) {
      return { ok: false, error: "write-failed" };
    }
  }

  return { list, detail, review, writeReport, stats, setEnabled, isEnabled };
}
