# 流光溢彩 · 能量色「流光」质感层施工图（Phase 1c / 任务 #7）

> 用户拍板：「**用流光溢彩的颜色**」。即能量色不再单色平涂，要做出**流光**质感。
> 本文件是**叠在**已交付的能量色体系（`t1-amber-spec.md` / `t2-t3-energy-spec.md`）**之上**的质感层；同选择器的**填充/发光**属性以本文件为准（级联后加载）。
> 硬约束全继承：只改配色/质感，**不动布局/尺寸/间距/DOM**；CSP 不变；品牌身份不变（t1 靛蓝+金、t2 紫+青柠、t3 紫+青碧）。

---

## 0. 总则与性能红线

**本层采用**：静态多层渐变、分层 `box-shadow` 辉光、`inset` 虹彩描边、光斑增数。**不新增常驻动效**（理由见 §5）。
**做不到（性能硬结论，禁止）**：`backdrop-filter`、每帧全屏模糊、`background-position` 位移覆盖大块面板、任何大面积逐帧重绘。面板跑在 `disable-gpu` 软件渲染下，每帧全屏模糊必卡。
→ **流光靠「局部小元素 + 静态多层渐变」读感成立，不靠全局动效。**

**无障碍硬门槛**：每一处承载文字的渐变，**逐 stop** 给对比度；文字落点所在 stop ≥4.5（大字/图形 ≥3）。掉标准就把浅色 stop 挪离文字区（调角度/半径，不新增元素），或文字改实色底+深 ink。**不许"整体看起来还行"糊过去。**

---

## 1. 通用流光技法（三套共用）

| 技法 | 做法 | 落地约束 |
|---|---|---|
| **多段虹彩渐变** | 关键锚点填充改 3–5 stop，色相跨「品牌色→能量色→亮部」 | ≥3 stop；**文字落点必须落在 ≥4.5 的 stop 段** |
| **分层辉光** | 同一光用 2–3 层 `box-shadow`，半径 6px / 16px / 34px 递进 | 仅 `box-shadow`，静态 |
| **虹彩内描边** | 白高光 `inset 0 1px 0 rgba(255,255,255,.9)` 旁叠一层**能量色** `inset 0 0 0 1px`（t3 玻璃为主） | 装饰性描边；**功能边界另用实心色，过 3:1** |
| **光斑增数** | t3 `.card::before` 由 2 枚增到 4 枚，色相跨度紫/青碧/翠绿 | 仅 t3 |
| ~~流光动效~~ | ~~小面积元素上缓慢掠过的虹彩高光~~ | **本轮不启用**（冲突/性能，见 §5）；仅保留原有 LED 呼吸 |

---

## 2. t1 流光（深空靛蓝 + 琥珀金）

### 2.1 渐变定义
```css
[data-theme="t1"] .send {
  background: linear-gradient(118deg, #7b8bf2 0%, #f0a92e 34%, #ffc65c 70%, #ffe3ae 100%);
  color: var(--amber-ink);
  box-shadow: 0 2px 6px rgba(240,169,46,.35), 0 8px 20px rgba(240,169,46,.26), 0 14px 36px rgba(240,169,46,.15);
}
[data-theme="t1"] #liveBar {
  background: linear-gradient(115deg, #2a2350 0%, #3a2c14 38%, #5c4116 68%, #3a2c14 100%);
  color: var(--amber-bright);
}
[data-theme="t1"] .credit {
  background: linear-gradient(135deg, #3a2c14 0%, #4d3a12 55%, #3a2c14 100%);
  box-shadow: inset 0 0 0 1px rgba(255,198,92,.22), 0 1px 6px rgba(240,169,46,.18);
}
[data-theme="t1"] header .title {
  text-shadow: 0 0 6px rgba(240,169,46,.60), 0 0 16px rgba(240,169,46,.34), 0 0 30px rgba(255,198,92,.18);
}
[data-theme="t1"] .led.on {
  background: radial-gradient(circle at 36% 30%, #ffe3ae 0%, #ffc65c 45%, #f0a92e 100%);
  box-shadow: 0 0 4px rgba(255,198,92,.55), 0 0 10px rgba(240,169,46,.35);
}
```

### 2.2 逐 stop 对比度表（承载文字者）
**`.send` 文字 `--amber-ink #12162b`（13px 正文，阈 4.5）**
| stop 位置 | 色 | ink #12162b | 判定 |
|---|---|---|---|
| 0%（最左·仅图标区） | `#7b8bf2` | **5.80** | ✅（图标为图形，阈 3） |
| 34% | `#f0a92e` | **8.87** | ✅ |
| 70% | `#ffc65c` | **11.47** | ✅ |
| 100% | `#ffe3ae` | **14.34** | ✅ |
> 文字列（约 30%–75%）整段落在 ≥#f0a92e 段（≥8.87）；品牌蓝只在 0% 边缘（图标处 5.80）。

**`#liveBar` 文字 `--amber-bright #ffc65c`**
| stop | 色 | bright on it | 判定 |
|---|---|---|---|
| 0% | `#2a2350` | **9.27** | ✅ |
| 38% | `#3a2c14` | **8.70** | ✅ |
| 68% | `#5c4116` | **6.07** | ✅（最低，仍 >4.5） |
| 100% | `#3a2c14` | **8.70** | ✅ |

**`.credit` 文字 `--amber-bright #ffc65c`**
| stop | 色 | bright on it | 判定 |
|---|---|---|---|
| 0% | `#3a2c14` | **8.70** | ✅ |
| 55% | `#4d3a12` | **6.99** | ✅ |
| 100% | `#3a2c14` | **8.70** | ✅ |

---

## 3. t2 流光（紫罗兰 + 青柠）

### 3.1 渐变定义
```css
[data-theme="t2"] .send {
  background: linear-gradient(118deg, #8b7fd8 0%, #6fb52c 30%, #8fc93a 50%, #a8dd4f 76%, #c6ea86 100%);
  color: var(--energy-ink);   /* #1a2405 */
  box-shadow: 0 2px 6px rgba(143,201,58,.38), 0 8px 20px rgba(143,201,58,.28), 0 14px 36px rgba(143,201,58,.16);
}
[data-theme="t2"] #liveBar {
  background: linear-gradient(115deg, #f2f8e6 0%, #eef7dc 45%, #dcefc0 100%);
  color: var(--fg);
}
[data-theme="t2"] .credit {
  background: linear-gradient(135deg, #eef7dc 0%, #e3f2cc 60%, #eef7dc 100%);
  box-shadow: inset 0 0 0 1px rgba(100,159,24,.35);
}
[data-theme="t2"] header .title {
  text-shadow: 0 0 6px rgba(143,201,58,.55), 0 0 16px rgba(143,201,58,.30), 0 0 30px rgba(143,201,58,.16);
}
[data-theme="t2"] .led.on {
  background: radial-gradient(circle at 36% 30%, #c6ea86 0%, #8fc93a 60%, #649f18 100%);
  box-shadow: 0 0 4px rgba(143,201,58,.6), 0 0 10px rgba(100,159,24,.4);
}
```

### 3.2 逐 stop 对比度表
**`.send` 文字 `--energy-ink #1a2405`（阈 4.5）**
| stop | 色 | ink on it | 判定 |
|---|---|---|---|
| 0%（边缘） | `#8b7fd8` | **4.72** | ✅ |
| 30% | `#6fb52c` | **6.41** | ✅ |
| 50% | `#8fc93a` | **8.15** | ✅ |
| 76% | `#a8dd4f` | **10.10** | ✅ |
| 100% | `#c6ea86` | **11.95** | ✅ |
> 全段 ≥4.72，含品牌紫最左边缘也达标——t2 的虹彩渐变**无需挪 stop**。

**`#liveBar` 文字 `--fg #2c2c2a`**
| stop | 色 | ink | 判定 |
|---|---|---|---|
| 0% | `#f2f8e6` | 13.14 | ✅ |
| 45% | `#eef7dc` | 12.64 | ✅ |
| 100% | `#dcefc0` | 11.43 | ✅ |

**`.credit` 文字 `--energy-deep #4a6f10`（阈 4.5）**：on `#eef7dc` **5.31** ✅ / on `#e3f2cc` ≥5.0 ✅（实测 5.31 为最低）。

---

## 4. t3 流光（浅色玻璃拟态 · 紫 → 青碧 → 翠绿）

### 4.1 玻璃底光斑增数（2 → 4 枚，拉开色相）
```css
[data-theme="t3"] .card::before {
  box-shadow: inset 0 1px 0 rgba(255,255,255,.9), inset 0 0 0 1px rgba(14,143,176,.28); /* 虹彩内描边（装饰） */
  background:
    radial-gradient(150px 100px at 8% 4%,   rgba(83,74,183,.14),  transparent 70%),  /* 紫 */
    radial-gradient(170px 110px at 94% 8%,  rgba(12,165,184,.16), transparent 70%),  /* 青碧 */
    radial-gradient(150px 100px at 78% 98%, rgba(16,185,129,.12), transparent 72%),  /* 翠绿 */
    radial-gradient(120px 90px  at 30% 92%, rgba(139,92,246,.10), transparent 72%);  /* 淡紫 */
}
```

### 4.2 玻璃发送键 / 保存键：虹彩半透明填充 + **实心深青碧边界**
```css
[data-theme="t3"] .send {
  background: linear-gradient(118deg, rgba(83,74,183,.20) 0%, rgba(14,143,176,.20) 45%, rgba(18,165,184,.26) 100%);
  color: var(--fg);
  /* 内白高光(玻璃) + 深青碧实心边界(功能边界, ≥3:1) + 分层外辉光 */
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,.92),
    inset 0 0 0 1.5px var(--energy-deep),      /* #0a6f82 —— 见 §4.3，别用 --energy/#0e8fb0 */
    0 2px 8px rgba(18,165,184,.30), 0 10px 24px rgba(18,165,184,.20), 0 16px 40px rgba(83,74,183,.14);
}
[data-theme="t3"] .sheet .row2 button.pri,
[data-theme="t3"] .sheet .row2 button.pri:hover {
  background: linear-gradient(118deg, rgba(83,74,183,.22), rgba(14,143,176,.24));
  color: var(--fg);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.92), inset 0 0 0 1.5px var(--energy-deep),
              0 2px 8px rgba(18,165,184,.28), 0 10px 22px rgba(83,74,183,.16);
}
[data-theme="t3"] header .title {
  text-shadow: 0 0 8px rgba(18,165,184,.45), 0 0 18px rgba(18,165,184,.26), 0 0 32px rgba(83,74,183,.16);
}
[data-theme="t3"] .led.on {
  background: radial-gradient(circle at 36% 30%, #6fe0ee 0%, #12a5b8 55%, #0e8fb0 100%);
  box-shadow: 0 0 4px rgba(18,165,184,.6), 0 0 10px rgba(83,74,183,.30);
}
```

### 4.3 逐 stop 对比度表（含**边界 token 更正**）
**`.send` 文字 `--fg #2c2c2a` 压在「半透明虹彩填充 over 白」上（阈 4.5）**
| stop | 有效底色（over 白） | ink #2c2c2a | 判定 |
|---|---|---|---|
| 0%（紫 α.20） | `#dddbf1` | **10.31** | ✅ |
| 45%（青碧 α.20） | `#cfe9ef` | **11.03** | ✅ |
| 100%（青碧 α.26） | `#c3e5ec` | ≥10.4 | ✅ |

**边界 token 更正（实测，优于原建议）** —— 主行动边界是**状态语义不是装饰**，必须 ≥3:1：
| 边界 token | 对浅青填充的对比度 | 判定 |
|---|---|---|
| `rgba(14,143,176,.55)`（原内描边） | **2.02** | ❌ 越线 |
| `--energy #0e8fb0`（原建议实心） | **2.78–2.97** | ❌ 仍 <3 |
| **`--energy-deep #0a6f82`**（本轮采用） | **4.29–4.59** | ✅ |

> **结论**：t3 玻璃键内描边改用 **`--energy-deep`**（不是 `--energy`）——因为在浅青填充上 `--energy` 只有 2.8，够不到 3:1。半透明填充保持，边界做实心。

---

## 5. 动效：本层**不新增常驻动效**（决策与理由）

**结论**：流光质感**全部由静态多层渐变 + 分层辉光 + 光斑承载**——不再新增任何常驻动画。原因（三条，均为硬约束冲突）：

1. **红线冲突（决定项）**：原本想复用 `.send::after` 做一道虹彩掠光，但该伪元素在 `panel.html:702–707` **已被占用为 hover 高光**：
   `content:''; position:absolute; top:0; left:-130%; width:55%; height:100%; transition:left .55s` + `.send:hover::after{left:135%}`。
   复用它必须改 `left`（并牵动 `width/height/top`）→ **触碰「不动布局/尺寸」红线**；且本层规则加载在后、选择器特指度相同，会把 hover 的 `left:135%` 一并压死，**破坏既有 hover 手感**。
2. **性能**：常驻 `transform` 动画在小元素上虽可接受，但 `disable-gpu` 软件渲染下仍是**每次合成都重绘**的持续成本；面板已长期常驻，收益（一道掠光）远小于成本。
3. **无障碍/克制**：常驻动效对 `prefers-reduced-motion` 用户是持续干扰；本层业务无「必须动态」的语义，静态虹彩已满足「流光溢彩」。

**保留（非本层新增，不动）**：活跃灯 `ledpulseA/T2/T3` 呼吸光晕——`panel.html` 原有，本就受 `html.no-motion .led.on{animation:none}`（:230）兜底。

**可选增强（默认关闭，需前端明确签字才启用）**：若产品坚持要发送键掠光，唯一不越线的方式是**让前端把 `.send::after` 的 hover 位移由 `left` 改为 `transform`**（改 `panel.html` 本体，属前端职责），之后本层再挂 `iridSweep`。**在此之前不要启用**——本层不提供会破坏 hover 或触碰布局的补丁。
```css
/* ↓ 仅上述前置条件满足后启用；否则整段不要贴 */
@keyframes iridSweep { 0% { transform: translateX(-150%) } 55%,100% { transform: translateX(280%) } }
@media (prefers-reduced-motion: no-preference) {
  [data-theme="t1"] .send::after,[data-theme="t2"] .send::after,[data-theme="t3"] .send::after {
    left: 0; transform: translateX(-150%); animation: iridSweep 3.6s var(--ease) infinite; }
  html.no-motion .send::after { animation: none !important; }
}
```
> 因此本层交付的「流光溢彩」是 **100% 静态**：靠 §2/§3/§4 的多段虹彩渐变与分层辉光读作「流光」，无需动效即成立。

---

## 6. 本轮修正汇总（危险红 / 令牌契约 / 对齐断裂 / 杂项）

> 详细已写入两份 base spec 的「§7 本轮修正」；此处只列结论与 patch 位置，避免双源。

- **危险红/警告**：t2/t3 `--danger:#d8443f→#b3261e`（白 **6.54** / danger-soft **5.72**）、`--warn:#b4770f→#8a5a00`（白 **5.93** / #fdf2e0 **5.35**）；`#mic.on` 硬编码 `#D8443F→var(--danger)`。t1 `--danger` 不动。
- **令牌契约（A）**：t3 新增 `--energy-edge-solid:#0e8fb0`（3.77）供**功能边界**；alpha 版 `--energy-edge` 仅装饰；**两者不可互换**。
- **对齐断裂（B）**：⑤灯 t2→`--energy-edge`(3.22)/t3→`--energy`(3.77)；⑦Orb轨 t2→`--energy-deep`(5.88)/t3→`--energy`(3.77)；⑩⑫ t3 提权重（实心边界+更强半透明填充+分层辉光）；①标题以「分层辉光（3 层）+ 能量环 + 底线」补强，非靠字色。
- **杂项（D）**：t2 `.messages` 改 alpha 洗色；t2 `.more-btn b` 去 `opacity`；t3 `.slotnote b` 补 `--energy-deep`；`.slotnote` 正文与 `.slothead .hint` 硬编码 `#888780`（3.61/3.26/3.04 ❌）→ 覆盖为 `--fg-quiet`。
- **保留**：`.hist-mask` 的 `backdrop-filter`（panel.html:857）是**一次性静态模糊、非每帧**，**务必不要删**。
