/* 可注入纪律条款汇总 —— 单一真相源。
 * 生成的 md 必须与本文件 render() 逐字一致（防文档漂移，沿用 ORB capabilityRegistry 的做法）。
 */
import { INJECTABLE_DISCIPLINE } from "./p0Discipline.mjs";
import { INJECTABLE_CHANNEL_RULE } from "./p1FileChannel.mjs";
import { INJECTABLE_SEAL_RULE } from "./p2SealReview.mjs";
import { INJECTABLE_ADAPTER_RULE } from "./p2SiteAdapter.mjs";
import { INJECTABLE_VERIFY_RULE } from "./p3VerifyLite.mjs";

export const SECTIONS = Object.freeze([
  Object.freeze({ tier: "Tier B · 所有团队模式", title: "P0 基础纪律", items: INJECTABLE_DISCIPLINE }),
  Object.freeze({ tier: "Tier B · 所有团队模式", title: "P1 文件化机间信道", items: INJECTABLE_CHANNEL_RULE }),
  Object.freeze({ tier: "Tier A · 仅专家团 + Max", title: "P2 封驳评审与满血上下文", items: INJECTABLE_SEAL_RULE }),
  Object.freeze({ tier: "执行层 · 桥接红线", title: "P2 站点适配器与视觉建闸", items: INJECTABLE_ADAPTER_RULE }),
  Object.freeze({ tier: "Tier B · 所有团队模式", title: "P3 亲测验收 Lite", items: INJECTABLE_VERIFY_RULE }),
]);

export function render() {
  const lines = [
    "# 专家团治理纪律 · 可注入条款",
    "",
    "> 本文件由 `落地/governance/injectable.mjs` 生成，请勿手工编辑。",
    "> 用途：整段注入专家团 system prompt / 每个 teammate 的派工包头部。",
    "> 绑定规则由 `governanceCore.mjs` 的四档矩阵以代码强制执行，条款只是提示层。",
    "",
    "## 四档矩阵（硬约束）",
    "",
    "| 档位 | 团队 | Max | 启用治理 |",
    "|---|---|---|---|",
    "| 普通（默认） | 关 | 关 | 无 |",
    "| 普通 + Max | 关 | 开 | 无 |",
    "| 专家团（轻量） | 开 | 关 | 仅 Tier B |",
    "| 专家团 + Max（满血） | 开 | 开 | Tier A + Tier B |",
    "",
    "> 封驳评审与多 agent 带上下文**只在「专家团 + Max」同时开启时启用**。",
    "",
  ];
  for (const s of SECTIONS) {
    lines.push(`## ${s.title}`, "", `*适用范围：${s.tier}*`, "");
    s.items.forEach((it, i) => lines.push(`${i + 1}. ${it}`));
    lines.push("");
  }
  lines.push(
    "## 诚实降级（总纲）",
    "",
    "任一治理层 / 执行层断言失败或超预算 → 如实报告并降级，不绕过闸门、不谎报成功。",
    ""
  );
  return lines.join("\n");
}

export default { SECTIONS, render };
