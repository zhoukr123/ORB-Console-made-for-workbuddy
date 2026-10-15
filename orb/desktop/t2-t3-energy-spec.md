# t2「紫罗兰 · 青柠」/ t3「浅色玻璃拟态」能量色体系施工图（Phase 1b）

> 用户追加：「另外两个方案也一样，增加除底色以外的颜色比例，如方案二增加青柠色」。
> 沿用 t1 琥珀金方法论，为 t2 / t3 各产出一套等价的「能量色体系」，**三套主题的能量语义位置完全对齐**（同一 UI 元素在三套里承担同样语义，只是颜色不同）。
> 硬约束同 t1：只改配色/质感，不动布局/尺寸/间距/DOM；`data-theme`+CSS 变量机制不变；CSP 不变；动效只动 transform/opacity + reduced-motion 兜底。

---

## 0. 核心适配原则（与 t1 相反）

t1 是**深色底**：能量色可以做文字（金字 `#f0a92e` on `#12162b` = 8.87:1）。
t2/t3 是**浅色底**：能量色做文字必挂——青柠 `#8fc93a` on 白 = **1.98:1**。所以策略整体反转：

- **P1 · 浅底反相**：能量色只做 **填充 / 描边 / 底衬 / 半透明层**；**文字一律走深色 ink**（`--fg` 或 `--energy-ink`）。t1 是「色做字」，t2/t3 是「色做面」。
- **P2 · 一字千面（语义对齐、实现分野）**：能量锚点**位置**三套一致（标题/头像环/底线/积分/通道灯/执行条/Orb 轨/更多入口/发送键/设置）；**实现**随底色变——t1 标题用金字，t2/t3 标题用深字 + 能量光晕。
- **P3 · t3 玻璃特则**：不用实心填充提色（会破玻璃感），只走 **光斑强度 / 彩色内描边 / 半透明色层**。
- **P4 · 共享语义令牌 `--energy-*`**：三套都暴露同一组语义变量，元素规则尽量复用，杜绝「三份各写各的」漂移。

---

## 1. 跨主题「能量语义位置」对齐表（核心交付）

**共享语义令牌契约**（三套主题都须定义）：
`--energy` / `--energy-bright` / `--energy-deep` / `--energy-soft` / `--energy-edge` / `--energy-ink` / `--energy-glow`

| 语义令牌 | t1 深空靛蓝·琥珀 | t2 紫罗兰·青柠 | t3 玻璃·青碧 |
|---|---|---|---|
| `--energy` | `#f0a92e` | `#8fc93a` | `#0e8fb0` |
| `--energy-bright` | `#ffc65c` | `#a8dd4f` | `#12a5b8` |
| `--energy-deep`（白底可做字 ≥4.5） | `#c98a1f`(深底用) | `#4a6f10` | `#0a6f82` |
| `--energy-soft`（底衬/半透明层） | `#3a2c14` | `#eef7dc` | `rgba(14,143,176,.14)` |
| `--energy-edge`（描边 ≥3:1） | `#8a6520` | `#649f18` | `rgba(14,143,176,.55)` |
| `--energy-ink`（填充上的字） | `#12162b` | `#1a2405` | `#08313a` |
| `--energy-glow` | `rgba(240,169,46,.32)` | `rgba(143,201,58,.30)` | `rgba(18,165,184,.26)` |

| 12 个能量锚点（位置，三套一致） | t1 实现 | t2 实现 | t3 实现 |
|---|---|---|---|
| ① 标题 | 金字 + 金光晕 | **深字 + 青柠光晕** | **深字 + 青碧光晕** |
| ② 头像环 | 琥珀环 | 青柠环 | 青碧环 + 外发光 |
| ③ header 底线 | `--amber-border` | `--lime-edge` | `rgba(青碧,.55)` |
| ④ 积分 chip | 琥珀底/金数 | 青柠底/深绿数 | 半透明青碧层/深数 |
| ⑤ 通道活跃灯 | 琥珀 | 青柠 | 青碧亮 |
| ⑥ 执行条 liveBar | 琥珀底/金字 | 青柠底/深字 | 青碧半透明/深字 |
| ⑦ Orb 强调条 | 琥珀 | 青柠深 | 青碧 |
| ⑧ 「更多」入口 | 琥珀虚边/琥珀数 | 青柠边/深绿字 | 青碧边/深字 |
| ⑨ 分段锚点 | 琥珀竖线 | 青柠竖线 | 青碧竖线 |
| ⑩ 发送键（主行动） | **琥珀实心填充 + 深字** | **青柠实心填充 + 深字** | **青碧半透明 + 内描边（玻璃，不实心）** |
| ⑪ 设置 partition 标题 | 金字 | 深绿字(lime-deep) | 深青字(cyan-deep) |
| ⑫ 保存键 + 主题卡选中 | 琥珀填充/琥珀描边 | 青柠填充/青柠描边 | 青碧玻璃层/青碧描边 |

> 能量三点法则同样适用：**顶栏标题 · 状态条积分/灯 · 输入区发送键** 三角在三套主题都成立。

---

## 1.5 浅底既存 a11y：`--fg-muted` 小字正文不达标（本轮必须一并修）

t2/t3 的 `--fg-muted` 是 `#928f86`(t2) / `#8f8ca6`(t3)，而 `.msg .who`(11px)、`.msg.sys .body`(12px)、`.muted`(11.5px) 等**正文**正用它。白底实测**不足 AA 4.5:1**：

| 组合 | 白 `#ffffff` | bg-soft | 能量底衬上 |
|---|---|---|---|
| t2 `#928f86`（现状） | **3.23** ❌ | 3.07 ❌ | lime-soft `#eef7dc` = **2.92** ❌ |
| t3 `#8f8ca6`（现状） | **3.25** ❌ | 3.13 ❌ | cyan-tint `#ddeff4` = **2.74** ❌ |

**解法（采用「统一压深 muted」，一处定义全 UI 受益）：** 新增语义令牌 `--fg-quiet`（专供小字正文，实测 ≥4.5），并令 `--fg-muted:var(--fg-quiet)`。

| 令牌 | t2 值 | t3 值 | 白 | bg-soft | 能量底衬 |
|---|---|---|---|---|---|
| `--fg-quiet`（= 新 `--fg-muted`） | `#6a675e` | `#67637e` | **5.65 / 5.73** ✅ | **5.37 / 5.52** ✅ | lime `#eef7dc` **5.11** ✅ · cyan `#ddeff4` **4.84** ✅ |

层级仍保持：`--fg #2c2c2a` > `--fg-soft #5f5e5a` > `--fg-quiet`（仍比 fg-soft 轻）。

**α 上限（能量铺层压在 `--fg-quiet` 正文之上时，照 t1 的 α 纪律执行）：**
| 主题 | 铺层 | α=.10 | .14 | .18 | .22 | **α 上限** |
|---|---|---|---|---|---|---|
| t2 | 青柠 `#8fc93a` over 白 | 5.31 | 5.14 | 5.01 | 4.88 | **≤ .22** |
| t3 | 青碧 `#0e8fb0` over 白 | 5.10 | 4.84 | 4.63 | 4.39 ❌ | **≤ .18** |

> 本方案补丁中 `.messages` 的能量铺层用 `--energy-soft`（t2 `#eef7dc` ≈α.12；t3 `rgba(14,143,176,.14)`）——均在各自 α 上限内 ✅。**凡新增加的能量铺层，凡其下压着 `--fg-muted`/`--fg-quiet` 正文，α 一律不得超过上表上限；超限只能降铺层，不得压暗正文。**

---

## 2. t2「紫罗兰 · 青柠」能量体系

### 2.1 令牌表（新增/变更，`[data-theme="t2"]`）
| 令牌 | 值 | 用途 | 关键对比度 |
|---|---|---|---|
| `--energy` / `--lime` | `#8fc93a` | 主青柠：填充、图形、活跃态（= 旧 `--run`） | ink `#1a2405` on it = 8.15 |
| `--energy-bright` / `--lime-bright` | `#a8dd4f` | 填充高亮（渐变顶） | ink on it = 10.10 |
| `--energy-deep` / `--lime-deep` | `#4a6f10` | **白底上的青柠文字/图标**、pending | **5.88 on 白** ✓ |
| `--energy-soft` / `--lime-soft` | `#eef7dc` | chip/liveBar/铺层底衬 | ink on it = 12.64 |
| `--energy-edge` / `--lime-edge` | `#649f18` | 描边/滑轨（图形 ≥3:1） | **3.22 on 白** ✓ |
| `--energy-ink` / `--lime-ink` | `#1a2405` | 青柠填充上的深字 | 8.15 on `--lime` |
| `--energy-glow` | `rgba(143,201,58,.30)` | 光晕/发光 | 纯质感 |
| `--fg-quiet`（新 `--fg-muted`） | `#6a675e` | 小字正文（`.msg .who`/`.msg.sys .body`/`.muted`） | **5.65 on 白** ✅ |
| `--run` | `var(--energy)` | 兼容旧规则 | — |

**不改**：`--accent:#534ab7`（紫罗兰品牌主色）、`--danger:#d8443f`、`--ok`、`--warn`。青柠是「能量色」，紫罗兰仍是主色。

### 2.2 落位清单
- 顶栏：`header` 底 `--lime-edge` + 左上青柠暖铺层；`.title` 深字 + `text-shadow: 0 0 14px var(--energy-glow)`；`header img` 青柠环；`#avatar.busy` 青柠呼吸。
- 状态条：`.credit` 青柠底 `/` 深绿字（`--lime-deep` 5.88 ✓）；`.led.on` 青柠；`.strip` 青柠铺层。
- 执行条：`#liveBar` 青柠底渐变 + **深字**（浅底不能金字）+ 青柠扫光。
- 消息区：`.msg.orb::before` 青柠深轨；`.typing i` 青柠深；`.pending` → `--lime-deep`（5.88，同时修掉 `--warn` 白底 3.76 的既存对比不足）。**用户气泡仍紫罗兰**。
- 工具区：`.more-btn` 青柠边/深绿字；`.more-sec::before` 青柠；`.pinned:hover`/`.mcell:hover` 青柠底/边/深绿字。
- 输入区：`.compose` 顶边青柠 + 铺层；**`.send` 青柠填充（`--lime-bright`→`--lime`）+ `--lime-ink` 深字**（主行动最大青柠块）；`textarea:focus` 青柠边。
- 设置：`.slothead` → `--lime-deep`（深绿字，5.88 ✓）；`.slotnote` 青柠底/边；`.row2 button.pri` 青柠填充；`.themecard.on` 青柠描边；`.cr-bar.hot` 青柠→橙。

### 2.3 对比度自检（WCAG AA：正文 ≥4.5 / 大字·图形 ≥3）
| 用法 | 前景 | 背景 | 实测 | 门槛 | 结论 |
|---|---|---|---|---|---|
| 青柠做文字（**禁**） | `#8fc93a` | 白 | 1.98 | 4.5 | ❌ 故改做填充 |
| 深青柠文字 | `#4a6f10` | 白 | **5.88** | 4.5 | ✅ |
| 深青柠文字 on bg-soft | `#4a6f10` | `#faf9f6` | **5.58** | 4.5 | ✅ |
| 青柠边/图形 | `#649f18` | 白 | **3.22** | 3.0 | ✅ |
| 青柠填充上深字 | `#1a2405` | `#8fc93a` | **8.15** | 4.5 | ✅ |
| 亮青柠填充上深字 | `#1a2405` | `#a8dd4f` | **10.10** | 4.5 | ✅ |
| 深青柠字 on 青柠底衬 | `#4a6f10` | `#eef7dc` | **5.31** | 4.5 | ✅ |
| 深字 on 青柠底衬 | `#2c2c2a` | `#eef7dc` | **12.64** | 4.5 | ✅ |

### 2.4 与危险红区分
青柠 hue **84°** vs 危险红 hue **2°** → 相差 **82°**（远 >60° 安全阈）→ **无碰撞**。
侧向注意：青柠 vs `--ok #1d9e75`(161°) = 77°（安全）；青柠 vs `--warn #b4770f`(38°) = 46° —— 规则：**warn 只做细字提醒、青柠只做填充/进行态**，不同排相邻；急停/录制沿用 `#D8443F` 实心红不动。

---

## 3. t3「浅色玻璃拟态」能量体系

### 3.1 令牌表（新增，`[data-theme="t3"]`）
t3 的「能量色」原为 `--run:#7f77dd`（≈品牌紫，不独立），本方案**新增青碧作为能量色**（hue 192°，与紫罗兰品牌 245° 拉开），并强化「彩色光斑」。

| 令牌 | 值 | 用途 | 关键对比度 |
|---|---|---|---|
| `--energy` / `--glow` | `#0e8fb0` | 主青碧：图形/描边 | **3.77 on 白**（图形 ✓） |
| `--energy-bright` / `--glow-bright` | `#12a5b8` | 光斑亮部/灯 | 2.96 on 白（仅填充/发光） |
| `--energy-deep` / `--glow-deep` | `#0a6f82` | 白底文字 | **5.82 on 白** ✓ |
| `--energy-soft` | `rgba(14,143,176,.14)` | 半透明色层（玻璃） | 上面深字 11.81 ✓ |
| `--energy-edge` | `rgba(14,143,176,.55)` | 彩色内描边 | 图形线 |
| `--energy-ink` | `#08313a` | 玻璃填充上深字 | ≥4.7 |
| `--energy-glow` | `rgba(18,165,184,.26)` | 光斑/发光 | — |
| `--blob-violet` | `rgba(83,74,183,.12)` | 彩色光斑·紫（品牌） | — |
| `--blob-cyan` | `rgba(18,165,184,.14)` | 彩色光斑·青碧（能量） | — |
| `--blob-green` | `rgba(29,158,117,.10)` | 彩色光斑·绿 | — |
| `--fg-quiet`（新 `--fg-muted`） | `#67637e` | 小字正文（`.msg .who`/`.msg.sys .body`/`.muted`） | **5.73 on 白** ✅ |
| `--run` | `var(--energy)` | 兼容旧规则（原 `#7f77dd`→改青碧） | — |

**不改**：`--accent:#534ab7`（紫罗兰品牌不变）。

### 3.2 落位清单（玻璃特则：光斑 + 内描边 + 半透明层，**不实心**）
- `.card::before`（玻璃底座）：三枚光斑 = 紫 + **青碧** + 绿，比现状多一枚青碧、整体提亮 → 「彩色光斑」更足。
- 顶栏：`header` 底青碧内描边 + 左上青碧光晕；`.title` 深字 + `text-shadow` 青碧光晕；`header img` 青碧内环 + 外发光；`#avatar.busy` 青碧呼吸。
- 状态条：`.credit` 白玻璃底 + 青碧内描边 + 深青字（`--glow-deep`）；`.led.on` 青碧亮 + 青碧光晕。
- 执行条：`#liveBar` 青碧半透明层渐变 + 深字 + 青碧扫光。
- 消息区：`.msg.orb::before` 青碧轨；`.typing i` / `.pending` → 青碧深。**用户气泡仍紫罗兰**。
- 工具区：`.more-btn` 青碧边/深青字；`.more-sec::before` 青碧；`.pinned:hover`/`.mcell:hover` 青碧半透明层 + 内描边 + 深青字。
- 输入区：`.compose` 青碧光晕铺层 + 顶内描边；**`.send` 玻璃键** = `linear-gradient(rgba(青碧,.24),rgba(青碧,.18))` + `inset 0 0 0 1.5px var(--energy-edge)`（青碧内描边）+ `inset 0 1px 0 rgba(255,255,255,.9)`（白高光）+ **深字**（不是实心填充，保住玻璃感）；`textarea:focus` 青碧边 + 青碧柔光。
- 设置：`.slothead` → `--glow-deep`（深青字 5.82 ✓）；`.slotnote` 青碧半透明层/内描边；`.row2 button.pri` **玻璃青碧**（半透明+内描边+白高光）；`.themecard.on` 青碧描边 + 青碧柔光。

### 3.3 对比度自检（WCAG AA）
| 用法 | 前景 | 背景 | 实测 | 门槛 | 结论 |
|---|---|---|---|---|---|
| 青碧做图形/边 | `#0e8fb0` | 白 | **3.77** | 3.0 | ✅ |
| 深青碧文字 | `#0a6f82` | 白 | **5.82** | 4.5 | ✅ |
| 青碧半透明层(α .14) | 层色 `#ddeff4` | — | 深字 on 它 = **11.81** | 4.5 | ✅ |
| 青碧半透明层(α .18) | `#d4ebf1` | — | 深字 = **11.30** | 4.5 | ✅ |
| 玻璃键深字 | `#2c2c2a` | `rgba(青碧,.18)` 叠白 | **11.30** | 4.5 | ✅ |
| 青碧 bright 做灯 | `#12a5b8` | 白 | 2.96 | 3.0 | ⚠️ 仅作 3px 发光点/光斑，不单独承载信息 |
| 内描边 on 白 | `rgba(14,143,176,.55)` | 白 | ≈2.1 | 3.0 | ⚠️ 内描边是**装饰性玻璃边**，语义靠文字/图形承载 |

### 3.4 与危险红区分
青碧 hue **192°** vs 危险红 hue **2°** → 相差 **190°**（近互补）→ 极安全。
侧向：青碧 vs `--ok #1d9e75`(161°) = 31°（最近）——规则：**ok 只用于成功态细字**，青碧用于填充/描边，二者不同区；青碧 vs 品牌紫(245°) = 53°，可辨。急停/录制红不动。

---

## 4. 占比目标（t2 / t3，对标 t1）

同样两口径（分母 = 面板可视面，含弹层）：
- **口径 A · 饱和能量色**（t2：H70–100° 且 S≥40%；t3：H170–210° 且 S≥40%）：静息 **≥2.5–3%**，运行峰值 **≥5–6%**。
- **口径 B · 能量色感知**（含 ≤24% α 色层/光斑，面积×强度加权）：静息 **8–11%**，运行峰值 **13–16%**。
- t3 额外计入「彩色光斑」（紫+青碧+绿）——除底色外的**总彩色占比**应随本方案明显高于现状。

> 现状：t2 只有 `--run` 少数点（≈0.4%）；t3 能量色≈0（`--run` 近似品牌紫）。本方案把两者拉到与 t1 同档。

---

## 5. 落地补丁

### 5.1 t2（`[data-theme="t2"]`，纯配色/质感，零布局影响）
```css
[data-theme="t2"] {
  --energy:#8fc93a; --energy-bright:#a8dd4f; --energy-deep:#4a6f10;
  --energy-soft:#eef7dc; --energy-edge:#649f18; --energy-ink:#1a2405;
  --energy-glow:rgba(143,201,58,.30);
  --lime:#8fc93a; --lime-bright:#a8dd4f; --lime-deep:#4a6f10;
  --lime-soft:#eef7dc; --lime-edge:#649f18; --lime-ink:#1a2405;
  --fg-quiet:#6a675e; --fg-muted:var(--fg-quiet);   /* 修既存 a11y：小字正文 ≥4.5 */
  --run:var(--energy);
}
[data-theme="t2"] header {
  background: radial-gradient(120px 34px at 4% 0%, var(--energy-soft), transparent 72%),
              linear-gradient(180deg, var(--bg) 0%, var(--bg-soft) 100%);
  border-bottom-color: var(--energy-edge);
}
[data-theme="t2"] header .title { color: var(--fg); text-shadow: 0 0 14px var(--energy-glow); }
[data-theme="t2"] header img { box-shadow: 0 0 0 1.5px var(--energy-edge); }
[data-theme="t2"] #avatar.busy { animation-name: avBreatheT2; }
@keyframes avBreatheT2 {
  0%,100% { box-shadow: 0 0 0 1.5px var(--energy-edge), 0 0 0 3px rgba(143,201,58,.14); }
  50%     { box-shadow: 0 0 0 2px   var(--energy),      0 0 0 7px rgba(143,201,58,.20); }
}
[data-theme="t2"] .strip {
  background: radial-gradient(220px 60px at 6% 50%, var(--energy-soft), transparent 70%), var(--bg-soft);
}
[data-theme="t2"] .credit {
  border-color: var(--energy-edge);
  background: linear-gradient(180deg, var(--energy-soft), var(--bg-soft));
  color: var(--energy-deep);
}
[data-theme="t2"] .credit-ico { fill: var(--energy-deep); }
[data-theme="t2"] .credit b { color: var(--energy-deep); }
[data-theme="t2"] .credit:hover { border-color: var(--energy); background: var(--energy-soft); box-shadow: 0 2px 10px var(--energy-glow); }
[data-theme="t2"] .led.on { background: var(--energy); animation-name: ledpulseT2; }
@keyframes ledpulseT2 {
  0%,100% { box-shadow: 0 0 0 3px rgba(143,201,58,.22); }
  50%     { box-shadow: 0 0 0 6px rgba(143,201,58,.06); }
}
[data-theme="t2"] #liveBar { background: linear-gradient(180deg, var(--energy-soft), #dcefc0); color: var(--fg); border-bottom-color: var(--energy-edge); }
[data-theme="t2"] .msg.orb::before { background: var(--energy-edge); opacity: .7; }
[data-theme="t2"] .typing i { background: var(--energy-deep); }
[data-theme="t2"] .pending { color: var(--energy-deep); }
[data-theme="t2"] .more-btn { border-color: var(--energy-edge); color: var(--energy-deep); }
[data-theme="t2"] .more-btn b { color: var(--energy-deep); opacity: .85; }
[data-theme="t2"] .more-btn:hover,
[data-theme="t2"] .more-btn.on { border-color: var(--energy); color: var(--energy-deep); background: var(--energy-soft); }
[data-theme="t2"] .more-sec::before { background: var(--energy); opacity: .7; }
[data-theme="t2"] .pinned:hover,
[data-theme="t2"] .mcell:hover { background: var(--energy-soft); border-color: var(--energy); color: var(--energy-deep); }
[data-theme="t2"] .compose {
  background: radial-gradient(260px 80px at 50% 100%, var(--energy-soft), transparent 74%), var(--bg-soft);
  border-top-color: var(--energy-edge);
}
[data-theme="t2"] textarea:focus { border-color: var(--energy); box-shadow: 0 0 0 3px rgba(143,201,58,.16); }
[data-theme="t2"] .send { background: linear-gradient(180deg, var(--energy-bright), var(--energy)); color: var(--energy-ink); box-shadow: 0 1px 3px rgba(143,201,58,.40); }
[data-theme="t2"] .send:hover { box-shadow: 0 4px 14px var(--energy-glow); }
[data-theme="t2"] .send:disabled { background: var(--border-strong); color: var(--fg-muted); }
[data-theme="t2"] .messages { background: radial-gradient(320px 130px at 50% 100%, var(--energy-soft), transparent 80%); }
[data-theme="t2"] .slothead { color: var(--energy-deep); }
[data-theme="t2"] .slotnote { background: var(--energy-soft); border-color: var(--energy-edge); }
[data-theme="t2"] .slotnote b { color: var(--energy-deep); }
[data-theme="t2"] .sheet .row2 button.pri,
[data-theme="t2"] .sheet .row2 button.pri:hover { background: linear-gradient(180deg, var(--energy-bright), var(--energy)); border-color: var(--energy); color: var(--energy-ink); }
[data-theme="t2"] .themecard.on { border-color: var(--energy); background: var(--energy-soft); }
[data-theme="t2"] .field input:focus,
[data-theme="t2"] .field select:focus { border-color: var(--energy); box-shadow: 0 0 0 3px rgba(143,201,58,.16); }
[data-theme="t2"] .cr-bar.hot > i { background: linear-gradient(90deg, var(--energy), #e8590c); }
```

### 5.2 t3（`[data-theme="t3"]`，玻璃：光斑 + 内描边 + 半透明层）
```css
[data-theme="t3"] {
  --energy:#0e8fb0; --energy-bright:#12a5b8; --energy-deep:#0a6f82;
  --energy-soft:rgba(14,143,176,.14); --energy-edge:rgba(14,143,176,.55);
  --energy-ink:#08313a; --energy-glow:rgba(18,165,184,.26);
  --glow:#0e8fb0; --glow-bright:#12a5b8; --glow-deep:#0a6f82;
  --blob-violet:rgba(83,74,183,.12); --blob-cyan:rgba(18,165,184,.14); --blob-green:rgba(29,158,117,.10);
  --fg-quiet:#67637e; --fg-muted:var(--fg-quiet);   /* 修既存 a11y：小字正文 ≥4.5 */
  --run:var(--energy);
}
/* 彩色光斑：多一枚青碧，整体提亮（玻璃底座） */
[data-theme="t3"] .card::before {
  box-shadow: inset 0 1px 0 rgba(255,255,255,.9), inset 0 0 0 1px rgba(255,255,255,.55);
  background:
    radial-gradient(150px 100px at 10% 4%, var(--blob-violet), transparent 70%),
    radial-gradient(170px 110px at 92% 10%, var(--blob-cyan), transparent 70%),
    radial-gradient(140px 90px at 70% 96%, var(--blob-green), transparent 72%);
}
[data-theme="t3"] header {
  background: radial-gradient(130px 40px at 4% 0%, var(--energy-glow), transparent 72%), rgba(255,255,255,.72);
  border-bottom-color: var(--energy-edge);
}
[data-theme="t3"] header .title { color: var(--fg); text-shadow: 0 0 16px var(--energy-glow); }
[data-theme="t3"] header img { box-shadow: 0 0 0 1.5px var(--energy-edge), 0 0 14px var(--energy-glow); }
[data-theme="t3"] #avatar.busy { animation-name: avBreatheT3; }
@keyframes avBreatheT3 {
  0%,100% { box-shadow: 0 0 0 1.5px var(--energy-edge), 0 0 0 3px rgba(18,165,184,.14); }
  50%     { box-shadow: 0 0 0 2px   var(--energy-bright), 0 0 0 8px rgba(18,165,184,.20); }
}
[data-theme="t3"] .strip {
  background: radial-gradient(220px 60px at 6% 50%, var(--energy-soft), transparent 70%), rgba(255,255,255,.72);
  border-bottom-color: var(--energy-edge);
}
[data-theme="t3"] .credit {
  border-color: var(--energy-edge); background: rgba(255,255,255,.80); color: var(--energy-deep);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.9);
}
[data-theme="t3"] .credit-ico { fill: var(--energy); }
[data-theme="t3"] .credit b { color: var(--energy-deep); }
[data-theme="t3"] .led.on { background: var(--energy-bright); animation-name: ledpulseT3; }
@keyframes ledpulseT3 {
  0%,100% { box-shadow: 0 0 0 3px rgba(18,165,184,.20); }
  50%     { box-shadow: 0 0 0 7px rgba(18,165,184,.05); }
}
[data-theme="t3"] #liveBar { background: linear-gradient(180deg, var(--energy-soft), rgba(14,143,176,.22)); color: var(--fg); border-bottom-color: var(--energy-edge); }
[data-theme="t3"] .msg.orb::before { background: var(--energy); opacity: .55; }
[data-theme="t3"] .typing i { background: var(--energy-deep); }
[data-theme="t3"] .pending { color: var(--energy-deep); }
[data-theme="t3"] .more-btn { border-color: var(--energy-edge); color: var(--energy-deep); }
[data-theme="t3"] .more-btn:hover,
[data-theme="t3"] .more-btn.on { border-color: var(--energy); color: var(--energy-deep); background: var(--energy-soft); }
[data-theme="t3"] .more-sec::before { background: var(--energy); opacity: .6; }
[data-theme="t3"] .pinned:hover,
[data-theme="t3"] .mcell:hover { background: var(--energy-soft); border-color: var(--energy); color: var(--energy-deep); }
[data-theme="t3"] .compose {
  background: radial-gradient(280px 90px at 50% 100%, var(--energy-soft), transparent 76%), rgba(255,255,255,.72);
  border-top-color: var(--energy-edge);
}
[data-theme="t3"] textarea:focus { border-color: var(--energy); box-shadow: 0 0 0 3px var(--energy-soft); }
/* 发送键：玻璃键——半透明青碧层 + 青碧内描边 + 白高光，不实心 */
[data-theme="t3"] .send {
  background: linear-gradient(180deg, rgba(18,165,184,.24), rgba(14,143,176,.18));
  color: var(--fg);
  box-shadow: inset 0 0 0 1.5px var(--energy-edge), inset 0 1px 0 rgba(255,255,255,.9), 0 2px 10px var(--energy-glow);
}
[data-theme="t3"] .send:hover {
  box-shadow: inset 0 0 0 1.5px var(--energy), inset 0 1px 0 rgba(255,255,255,.9), 0 6px 18px var(--energy-glow);
}
[data-theme="t3"] .send:disabled { background: var(--bg-sunken); color: var(--fg-muted); box-shadow: none; }
[data-theme="t3"] .messages { background: radial-gradient(340px 150px at 50% 100%, var(--energy-soft), transparent 82%); }
[data-theme="t3"] .slothead { color: var(--energy-deep); }
[data-theme="t3"] .slotnote { background: var(--energy-soft); border-color: var(--energy-edge); }
[data-theme="t3"] .sheet .row2 button.pri,
[data-theme="t3"] .sheet .row2 button.pri:hover {
  background: linear-gradient(180deg, rgba(18,165,184,.30), rgba(14,143,176,.24));
  border-color: var(--energy-edge); color: var(--fg);
  box-shadow: inset 0 0 0 1.5px var(--energy-edge), inset 0 1px 0 rgba(255,255,255,.9);
}
[data-theme="t3"] .themecard.on { border-color: var(--energy); background: var(--energy-soft); }
[data-theme="t3"] .field input:focus,
[data-theme="t3"] .field select:focus { border-color: var(--energy); box-shadow: 0 0 0 3px var(--energy-soft); }
[data-theme="t3"] .cr-bar.hot > i { background: linear-gradient(90deg, var(--energy), #e8590c); }
```

> 注：t1 若要共用语义名，可在其变量块补 `--energy:var(--amber); --energy-bright:var(--amber-bright); --energy-deep:var(--amber-dim); --energy-soft:var(--amber-soft); --energy-edge:var(--amber-border); --energy-ink:var(--amber-ink); --energy-glow:var(--amber-glow);`（纯新增，不影响既有规则）。

---

## 6. 发现与处理

- **`--fg-muted` 小字正文不达标（本轮已修）**：见 §1.5 —— t2/t3 的 muted 正文在白底/能量底衬上仅 2.7–3.3:1，已通过新增 `--fg-quiet` 并 `--fg-muted:var(--fg-quiet)` 统一压深至 ≥4.5（t2 `#6a675e`、t3 `#67637e`）。**已并入补丁，不是待办。**
- **t2/t3 危险红文字不达 AA（既存，待判）**：`--danger:#d8443f` on 白 = **4.36**（<4.5）；on `--danger-soft:#fdecec` = **3.82**。`.msg.err .body`（错误消息）在浅色主题下正文对比不足。涉三套主题 `--danger`，不在能量色范围，报 ux-reviewer/team-lead 判。
- **t2/t3 `--warn:#b4770f` on 白 = 3.76**（<4.5）：`.pending` 已在本方案改走 `--energy-deep`（5.88/5.82）规避；其余 `--warn` 文字待判。
- t2/t3 的浅色硬编码（`.slotbox #fdfdfc` 等）在**浅色主题下正常**，无需像 t1 那样反色——即 t1 的深色适配清单**不适用于 t2/t3**。

---

## 7. 本轮修正（任务 #7 · 覆盖前面同名属性）

### 7.1 危险红 / 警告色（裁决：只改 t2/t3，t1 不动）
实测：旧 `--danger #d8443f` on 白 = **4.36** ❌、on `--danger-soft #fdecec` = **3.82** ❌。取代值：
- `--danger: #b3261e` → on 白 **6.54** ✅ / on `--danger-soft` **5.72** ✅ / 白字压其上 **6.54** ✅（深砖红，语义不弱化）
- `--warn: #8a5a00` → on 白 **5.93** ✅ / on `#fdf2e0` **5.35** ✅（仍是琥珀土黄提醒色）
- `#mic.on` 硬编码 `#D8443F`（on #fdecec = 3.82 ❌）→ 改 `var(--danger)`
- `.pinned.danger` 那处硬编码：急停移出工具区、元素删除 → **作废**

### 7.2 令牌契约（A）——不可互换
t3 原 `--energy-edge`(alpha .55) 作功能边界只有 **2.02** ❌。**新增 `--energy-edge-solid:#0e8fb0`（on 白 3.77 ✅）供功能边界**；`--energy-edge`(alpha) **仅装饰**。t2 的 `--energy-edge #649f18`(3.22) 本就是实色，保留并作为 `--energy-edge-solid` 的 t2 值。**两者语义不等价，禁止互相调用。**

### 7.3 对齐表断裂修正（B）
| 锚点 | 原 | 改为 | 实测 |
|---|---|---|---|
| ⑤通道灯 t2 | `--energy`(lime 1.98 ❌) | `--energy-edge` | **3.22** ✅ |
| ⑤通道灯 t3 | `--energy-bright`(2.96 ❌) | `--energy` | **3.77** ✅ |
| ⑦Orb 轨 t2 | `--energy-edge`(2.19 ❌) | `--energy-deep` | **5.88** ✅ |
| ⑦Orb 轨 t3 | `--energy`(2.02 ❌) | `--energy`(满透明) | **3.77** ✅ |
| ⑩⑫ t3 发送/保存键 | 弱玻璃 | 实心边界+更强填充+分层辉光（与 t1/t2 对等） | 见 §7.4 / iridescent-spec |
| ①标题 t2/t3 | 仅光晕（最弱锚） | **记档**：靠「3 层辉光 + 头像环 + header 底线」三件补强，非靠字色（浅底字色必须深） | — |

### 7.4 t3 玻璃键边界（C，实测更正 team-lead 建议）
主行动边界是**状态语义不是装饰**，须 ≥3:1。浅青填充上：`rgba(.55)`=**2.02 ❌**、`--energy #0e8fb0`=**2.78–2.97 ❌**、**`--energy-deep #0a6f82`=4.29–4.59 ✅**。→ **内描边改 `--energy-deep`**（不是 `--energy`），填充保持半透明。`.row2 button.pri` 同。

### 7.5 杂项（D）
- t2 `.messages` 暖晕：**实底 `#eef7dc` → alpha 洗色**（新增 `--energy-wash:rgba(143,201,58,.12)`；实测其上 `--fg-quiet` = 5.24 ✅）
- t2 `.more-btn b`：去 `opacity:.85`
- t3 `.slotnote b`：补 `--energy-deep`
- **`.slotnote` 正文 & `.slothead .hint` 的硬编码 `#888780`**（on 白 3.61 ❌ / on t2 实底 3.26 ❌ / on t3 青碧层 3.04 ❌，**不在 token 里，上一轮没覆盖到**）→ 覆盖为 `--fg-quiet`

### 7.6 本轮修正补丁（在 §5 补丁之后加载）
```css
/* ===== t2 本轮修正 ===== */
[data-theme="t2"] {
  --danger:#b3261e; --warn:#8a5a00;
  --energy-wash:rgba(143,201,58,.12);
  --energy-edge-solid:#649f18;
}
[data-theme="t2"] #mic.on { background: var(--danger-soft); color: var(--danger); }
[data-theme="t2"] .led.on { background: radial-gradient(circle at 36% 30%, #c6ea86 0%, #8fc93a 60%, var(--energy-edge) 100%); }
[data-theme="t2"] .msg.orb::before { background: var(--energy-deep); opacity: 1; }
[data-theme="t2"] .messages { background: radial-gradient(320px 130px at 50% 100%, var(--energy-wash), transparent 80%); }
[data-theme="t2"] .more-btn b { opacity: 1; }
[data-theme="t2"] .slotnote { color: var(--fg-quiet); }
[data-theme="t2"] .slothead .hint { color: var(--fg-quiet); }

/* ===== t3 本轮修正 ===== */
[data-theme="t3"] {
  --danger:#b3261e; --warn:#8a5a00;
  --energy-edge-solid:#0e8fb0;   /* 功能边界；与 alpha 版 --energy-edge 不可互换 */
}
[data-theme="t3"] #mic.on { background: var(--danger-soft); color: var(--danger); }
[data-theme="t3"] .led.on { background: radial-gradient(circle at 36% 30%, #6fe0ee 0%, #12a5b8 55%, var(--energy) 100%); }
[data-theme="t3"] .msg.orb::before { background: var(--energy); opacity: 1; }
[data-theme="t3"] .slotnote { color: var(--fg-quiet); }
[data-theme="t3"] .slotnote b { color: var(--energy-deep); }
[data-theme="t3"] .slothead .hint { color: var(--fg-quiet); }
[data-theme="t3"] .send,
[data-theme="t3"] .sheet .row2 button.pri,
[data-theme="t3"] .sheet .row2 button.pri:hover { box-shadow: inset 0 1px 0 rgba(255,255,255,.92), inset 0 0 0 1.5px var(--energy-deep), 0 2px 8px rgba(18,165,184,.30), 0 10px 24px rgba(18,165,184,.18); }
/* 注：.hist-mask 的 backdrop-filter（panel.html:857）是一次性静态模糊，务必保留勿删。 */
```
> 流光渐变（发送键/liveBar/积分/标题辉光/光斑/动效）见 `iridescent-spec.md`，在**本 §7.6 之后**加载并覆盖同选择器的填充/发光。
