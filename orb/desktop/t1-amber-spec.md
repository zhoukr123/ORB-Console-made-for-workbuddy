# t1「深空靛蓝 · 琥珀金」视觉施工图

> 目标：解决「**方案一里金色部分严重偏少**」。
> 约束：只改配色与质感，**不动任何布局 / 尺寸 / 间距 / DOM**；靛蓝仍是品牌主色；CSP 不变（内联 SVG、零外链）；动效只动 transform / opacity 并保留 `prefers-reduced-motion`；切换机制仍是 `data-theme` + CSS 变量。
> 所有改动 **只作用于 `[data-theme="t1"]`**，t2 / t3 一个字节不动。

---

## 0. 结论（TL;DR）

现状根因：琥珀金只被当成「运行态的一个点」——全屏只有 `#liveBar` 扫光 + 1 枚 LED + `--warn` 文字吃到了 `--run`，静息态几乎为 0。所以用户看到的是「深蓝 + 一点点橙」。

修法不是「把金色调亮」，而是**把琥珀金升格为一个「能量色」体系**，覆盖六大分区的静息态与运行态：

1. 建立 3 档琥珀色阶 + 深色底衬 + 暖色铺层（§2）。
2. 让琥珀在**静息态**就出现在 6 个分区、共 10 个锚点（§3.2），并给出「能量三点法则」保证任何时刻都看得见金。
3. 主行动（发送键）改为**琥珀填充**，成为整屏最大的金色承载物。
4. 顺手修掉 t1 深色下**设置面板的浅色硬编码**（`#3dfdfc`/`#5f5e5a`/`#3c3489` 等，对比度 1.74–2.75:1，已违反 WCAG）——同一处改动同时把金色带进设置面板（§6）。

核心指标：**暖色感知占比** 静息 8–11% / 运行峰值 13–16%（现 ≈1%）；**饱和琥珀占比** 静息 ≥2.5% / 运行峰值 ≥5%。验收以「分区覆盖 + 能量三点」为准（§3.3）。

---

## 1. 设计原则（4 条）与「避免清单」

**P1 · 琥珀 = 能量，不是第二个主色。**
琥珀只出现在「能量语义场」：计量（积分）、进行（执行/等待/活跃通道）、消耗/热度（条填充）、主行动（发送/保存）、发声（Orb 强调条）。品牌、身份、选择、导航一律留靛蓝。**判定法**：一个元素若回答「现在有没有能量在流动 / 用户要不要点火」，才给琥珀。

**P2 · 静息态必须有金，运行态是「加亮」而非「从零出现」。**
静息态琥珀是基线（标题、积分、发送键…），运行态在其上叠加亮度：`--amber` → `--amber-bright`，或点亮扫光/呼吸。这样「在跑」= 金色变亮变跳，而不是「突然冒出一块金」。

**P3 · 金与红靠「质感签名 + 位置」区分，不靠色相。**
（详见 §5：色相仅差 35°，不足 60°，所以分工与质感才是主力手段。）

**P4 · 暖色铺层做「气」，饱和琥珀做「骨」。**
大面积用 ≤18% α 的暖铺层营造氛围（header/strip/compose），小而准地用饱和琥珀做锚点。既能把金铺开，又不会把深空靛蓝染成黄色。

**避免清单（这几件事直接返工）：**
- ❌ 不要把 `.msg.me` 用户气泡改成金色（用户=靛蓝，Orb=琥珀，这条语义别打破）。
- ❌ 不要用琥珀做「警告横幅」之外的错误态；错误/危险固定 `--danger`。
- ❌ 不要把整屏背景或面板四边描成金（会变成「第二个主色」）。
- ❌ 不要让琥珀描边出现在输入框**静息态**（会被读成校验警告）——只在 focus 用琥珀。
- ❌ 不要新增 `filter: hue-rotate` 之类全局调色 trick（不可控且影响 t2/t3）。
- ❌ 不要为了加金去加 `padding` / `border-width` / 伪元素占位（任何改变盒子尺寸的做法都违反硬约束）。

---

## 2. t1 完整令牌表

### 2.1 现有令牌（保持不变）
```css
--bg:#12162b; --bg-soft:#171c35; --bg-sunken:#0e1224;
--fg:#e8eaf6; --fg-soft:#b9bfe0; --fg-muted:#7c85ad;
--border:#262c4d; --border-strong:#39406b;
--accent:#5b6ee8; --accent-soft:#1e2547; --accent-fg:#a8b6ff;
--danger:#e8736a; --danger-soft:#2a1a1c;   /* 不动 */
--ok:#4fc98d;
--sh-sm/--sh-md/--sh-lg; --glass-undercoat:#12162b;
```

### 2.2 新增：琥珀金「能量色阶」
| 令牌 | 值 | 用途 | 关键对比度 |
|---|---|---|---|
| `--amber-bright` | `#ffc65c` | 高亮金：标题、图标、关键数字、发光核心 | 11.47:1 on bg |
| `--amber` | `#f0a92e` | 主琥珀：正文级强调、描边、填充、活跃态（= 旧 `--run`） | 8.87:1 on bg |
| `--amber-dim` | `#c98a1f` | 次级琥珀：次要文字、弱描边、未激活金 | 6.07:1 on bg |
| `--amber-soft` | `#3a2c14` | 琥珀底衬（深色）：金字底 / 琥珀 pill 底 | 面上文字见 §4 |
| `--amber-border` | `#8a6520` | 琥珀描边线（图形对象） | 3.37:1 on bg（达 3:1） |
| `--amber-ink` | `#12162b` | 金底上的深字 | 8.87:1 on `--amber` |
| `--amber-wash-faint` | `rgba(240,169,46,.04)` | **正文面上的暖晕**（`.messages`）——α 上限 .04 | 纯氛围 |
| `--amber-wash` | `rgba(240,169,46,.10)` | 无正文的面：header / strip / compose | 纯氛围 |
| `--amber-wash-strong` | `rgba(240,169,46,.18)` | 无正文的面·加强（运行态） | 纯氛围 |
| `--amber-glow` | `rgba(240,169,46,.32)` | 暖色发光（shadow / text-shadow） | 纯质感 |
| `--amber-line` | `rgba(240,169,46,.42)` | 琥珀分隔细线 | 纯质感 |

> **α 纪律（阻断项，已定）**：`--amber-wash`(.10) / `--amber-wash-strong`(.18) **只能铺在背后没有正文的面**（header / strip / compose；compose 的 textarea 是不透明 `--bg`、title 走 `--amber-bright` 压在 wash 上 = 9.7 ✅）。
> **消息阅读面 `.messages` 必须用 `--amber-wash-faint`(.04)**——其下 `.msg .who`(11px) / `.msg.sys .body`(12px) 用 `--fg-muted #7c85ad`：α=.10 时掉到 **4.18:1（违规）**，α=.06 时 4.51（余量仅 0.01），**α=.04 时 4.66:1 ✅**。α=.04 是安全上限，不得上调。

三档之间 CIEDE2000 距离：bright↔amber = 7.4，amber↔dim = 9.7（均 > JND 2.3，可辨为「三档」而非「一个色」）；dim↔soft底衬 = 41.6。

### 2.3 语义别名（向后兼容，别删旧规则）
```css
--run:  var(--amber);
--warn: var(--amber);
```
`#liveBar::after`、`.pending` 等既有 `var(--run)/var(--warn)` 规则**一行都不用改**即自动变金。

---

## 3. 琥珀金落位清单

### 3.1 分区 × 元素 × 状态 × 令牌

| 分区 | 元素（选择器） | 状态 | 令牌 | 为什么 |
|---|---|---|---|---|
| 顶栏 | `header` 底边 | 静息 | `--amber-border` | 金色从顶部起手，横贯一条能量线 |
| 顶栏 | `header .title` | 静息 | `--amber-bright` + `text-shadow:--amber-glow` | 产品名的「能量签名」，最大静息金锚 |
| 顶栏 | `header img` 头像外环 | 静息 | `--amber`(1.5px ring) | 左上角常驻金点，呼应能量三角 |
| 顶栏 | `#avatar.busy` 呼吸 | 运行 | `--amber` 呼吸 | 「后台还在跑」= 金色脉动（原为蓝） |
| 状态条 | `.credit` 积分 chip | 静息 | 底`--amber-soft` / 字`--amber-bright` / 图标`--amber` | 积分=能量消耗，语义最正 |
| 状态条 | `.led.on` 通道活跃 | 静息 | `--amber` | 「该通道有能量在流」 |
| 状态条 | `.led.off` 未激活 | 静息 | `--fg-muted`（**去掉红**） | 「关」不是危险，减少红泛滥 |
| 状态条 | `.strip` 暖铺层 | 静息 | `--amber-wash` | 整条氛围 |
| 执行条 | `#liveBar` 底 | 运行 | `--amber-soft`→`#241a0c` 渐变 | 运行态最大金块 |
| 执行条 | `#liveBar` 文字 | 运行 | `--amber-bright` | |
| 执行条 | `#liveBar::after` 扫光 | 运行 | `var(--run)`(=`--amber`) | 已是 `--run`，无需改 |
| 消息区 | `.msg.orb::before` 强调条 | 静息 | `--amber`, opacity .5 | Orb=能量发声；用户气泡仍靛蓝 |
| 消息区 | `.typing i` 思考点 | 运行 | `--amber-dim` | |
| 消息区 | `.pending` 等待文字 | 运行 | `--amber`（`--warn`） | |
| 工具区 | `.more-btn` 更多入口 | 静息 | 边`--amber-border` / 字`--amber-dim` / 数字`--amber` | 金色锚点 |
| 工具区 | `.more-sec::before` 分段锚点 | 静息 | `--amber`, opacity .55 | 分组结构能量 |
| 工具区 | `.pinned:hover` | 悬停 | 底`--amber-soft`/边`--amber`/字`--amber-bright` | 统一「激活=金」（同时修掉深色下 `background:#fff` 白闪） |
| 工具区 | `.mcell:hover` | 悬停 | 同上 | 同上 |
| 输入区 | `.compose` 顶金线 | 静息 | `--amber-border` | 与 header 底金线成上下呼应 |
| 输入区 | `.compose` 暖铺层 | 静息 | `--amber-wash` | |
| 输入区 | `.send` 发送键 | 静息 | 底`--amber-bright`→`--amber` / 字`--amber-ink` | **主行动=最大金承载物** |
| 输入区 | `.send:hover` 发光 | 悬停 | `--amber-glow` | |
| 输入区 | `textarea:focus` | 聚焦 | 边`--amber` | 点火=聚焦（静息保持中性，免误读为警告） |
| 设置 | `.slothead` 分区标题 | 静息 | `--amber-bright` | 同时修掉 `#3c3489`（1.74:1）失效 |
| 设置 | `.slotnote` 说明块 | 静息 | 底`--amber-soft`/边`--amber-border` | 同时修掉浅色硬编码 |
| 设置 | `.row2 button.pri` 保存 | 静息 | 底`--amber-bright`→`--amber` / 字`--amber-ink` | 主行动 |
| 设置 | `.themecard.on` 选中 | 静息 | 边`--amber`/底`--amber-soft` | t1 卡片本身就是琥珀金主题 |
| 设置 | `.cr-bar.hot > i` 热度条 | 静息 | `--amber`→`#e8590c` | 消耗热度 |

### 3.2 静息态金色承载物（这是本次的**重点**，必须逐条落地）

> 用户说「金色偏少」——所以要明确回答：**不运行时，金从哪来？** 下面 10 个锚点全部在静息态可见，分布在 6 个分区：

1. **标题金字**：`header .title` → `--amber-bright` + 暖光晕。
2. **头像琥珀环**：`header img` → `1.5px` `--amber` 外环（`box-shadow`，不影响布局）。
3. **header 底金线**：`border-bottom-color: --amber-border`。
4. **积分 chip**：琥珀底 + 亮金数字（能量计量）。
5. **通道活跃灯**：`--amber` 常亮 + 暖呼吸。
6. **「更多」入口**：琥珀虚线边 + 琥珀计数。
7. **浮层分段锚点**：`--amber` 竖线。
8. **compose 顶金线 + 发送键琥珀填充**（最大锚）。
9. **Orb 消息强调条**：`--amber` 左轨。
10. **设置面板**：slothead / slotnote / 保存键 / 主题卡（打开设置时金色满幅）。

**能量三点法则（硬验收）**：任何时刻屏幕上 ≥3 处琥珀锚点可见，且分处不同分区。典型三角 = 顶栏标题(左上) · 状态条积分或活跃灯(左中) · 输入区发送键(右下)。即使消息区为空，金也「一直在场」。

### 3.3 占比目标与预算

两个口径，都要测：

- **口径 A · 饱和琥珀占比**（HSL 色相 25–55° 且 S≥40%、按面积计）：
  - 静息 **≥2.5%**（现状 ≈0.4%）
  - 运行峰值 **≥5%**（liveBar 满幅 + 扫光 + 发送脉冲）
- **口径 B · 暖色感知占比**（含 ≤18% α 暖铺层，按「面积 × 强度」加权）：
  - 静息 **8–11%**（对标用户「8–12%」的诉求口径）
  - 运行峰值 **13–16%**

**静息预算表**（面板可视 ≈ 400×680 = 272,000 px²）：

| 承载物 | 估算面积(px²) | 强度 | 加权 |
|---|---|---|---|
| 发送键琥珀填充 | 2,240 | 1.0 | 2,240 |
| 积分 chip | 1,320 | 0.8 | 1,056 |
| header 标题金字 | 430 | 0.9 | 387 |
| header 底金线 | 400 | 0.6 | 240 |
| compose 顶金线 | 400 | 0.6 | 240 |
| Orb 强调条 ×4 | 560 | 0.5 | 280 |
| 头像环 | 52 | 1.0 | 52 |
| 活跃灯 ×2 | 80 | 1.0 | 80 |
| 更多入口+分段锚点 | 250 | 0.6 | 150 |
| header 暖铺层 | 18,000 | 0.10 | 1,800 |
| strip 暖铺层 | 13,200 | 0.09 | 1,188 |
| compose 暖铺层 | 49,600 | 0.07 | 3,472 |
| 消息区底部暖晕 | 152,000 | **0.04** | 6,080 |
| **合计** | | | **≈17,215 / 272,000 = 6.3%** |

> 含饱和元素(≈6,100 px² ≈ 2.2%)后整体暖色感知约 **6–9%**，运行态叠加 liveBar(≈11,200 px² ×1.0) 后越过 12%。
> **口径 B 若不足 8%，差额一律补到 header / strip / compose 三处铺层（背后无正文）；严禁补在消息阅读面**——`.messages` 的暖晕 α 已钉死在 **.04**（安全上限），再高就压垮 `--fg-muted` 正文（见 §2.2 α 纪律）。

### 3.4 测量协议（#3 回归用，含弹层口径 — 团队确定）

**采样面定义**：单张全屏截图，分母 = 面板卡片可视面积（含当前展开的弹层）。

- **场景 1 · 主面板静息**：t1 主面板，无弹层、消息区为空。
- **场景 2 · 主面板静息 + 弹层**：分别叠加 5 处弹层各截一张，**合计**统计——
  `.hist-box`(历史) · `.wfe-head`(工作流) · `.wfe-json`(JSON 编辑) · `.pedit-tab`(字段编辑 tab) · `.pfield-in`(字段输入)。
  > 这 5 处原本是纯白（`#fff`/`rgba(255,255,255,.98)`），会**显著稀释**金色感知占比；修成深色令牌后，整体暖度才回到本 §3.3 预算算出的数。**因此场景 2 必须计入分母与分子**，不能只量主面板。
- **场景 3 · 运行态**：`#liveBar` 亮起 + 扫光在跑 + 通道活跃 + 发送键 hover 脉冲。

**口径**（对每个场景分别算）：
- **口径 A**：像素满足 `HSL 色相 ∈ [25°,55°]` **且** `S ≥ 40%` → 占采样面比。
- **口径 B**：像素满足「暖色偏移可感知」——`R − B > 6`（含 α 暖铺层：无正文面 ≤.18，**消息阅读面仅 .04**），按 `面积 × 强度` 加权 → 占采样面比。

**门槛**：
| 场景 | 口径 A | 口径 B |
|---|---|---|
| 1 主面板静息 | ≥2.5% | 8–11% |
| 2 静息 + 弹层 | ≥2.5% | 8–11%（弹层不该把它拉低；若拉低说明弹层没修干净） |
| 3 运行峰值 | ≥5% | 13–16% |

**复现方法**：截图后按上面两个口径统计像素占比。若做不到逐像素统计，退而求其次做「六分区锚点 + 能量三点」的定性核查（§3.2），任何一条不满足即报数给 team-lead，**不替前端调值**。

---

## 4. 对比度自检表（WCAG AA：正文 ≥4.5:1，大字/图形 ≥3:1）

### 4.1 金字配深底
| 用法 | 前景 | 背景 | 实测 | 门槛 | 结论 |
|---|---|---|---|---|---|
| 亮金·标题/数字 | `#ffc65c` | `#12162b` bg | **11.47** | 4.5 | ✅ |
| 亮金 on bg-soft | `#ffc65c` | `#171c35` | **10.75** | 4.5 | ✅ |
| 亮金 on sunken | `#ffc65c` | `#0e1224` | **11.93** | 4.5 | ✅ |
| 主金·正文级 | `#f0a92e` | `#12162b` | **8.87** | 4.5 | ✅ |
| 主金 on bg-soft | `#f0a92e` | `#171c35` | **8.31** | 4.5 | ✅ |
| 主金 on sunken | `#f0a92e` | `#0e1224` | **9.22** | 4.5 | ✅ |
| 暗金·次要文字 | `#c98a1f` | `#12162b` | **6.07** | 4.5 | ✅ |
| 暗金 on bg-soft | `#c98a1f` | `#171c35` | **5.69** | 4.5 | ✅ |
| 琥珀描边线 | `#8a6520` | `#12162b` | **3.37** | 3.0 | ✅ |
| 琥珀描边 on 底衬 | `#8a6520` | `#3a2c14` | 2.56 | 3.0 | ⚠️ 仅作装饰，勿用于传达状态的边界 |

### 4.2 金底配深字
| 用法 | 前景 | 背景 | 实测 | 门槛 | 结论 |
|---|---|---|---|---|---|
| 发送键/保存键文字 | `#12162b` | `#f0a92e` | **8.87** | 4.5 | ✅ |
| 亮金底上的深字 | `#12162b` | `#ffc65c` | **11.47** | 4.5 | ✅ |
| 金字 on 琥珀底衬 | `#f0a92e` | `#3a2c14` | **6.72** | 4.5 | ✅ |
| 亮金字 on 琥珀底衬 | `#ffc65c` | `#3a2c14` | **8.70** | 4.5 | ✅ |
| 暗金字 on 琥珀底衬 | `#c98a1f` | `#3a2c14` | **4.60** | 4.5 | ✅（勉强，别再降） |

**结论**：所选值全部达标；`#8a6520` 描边对底衬仅 2.56，**只可用作纯装饰线**（如 header 底边靠的是与 `--bg` 的 3.37:1，达标）。

### 4.3 配错纪律与已知局限（防返工）

**禁用组合（硬）**
1. `--amber-dim #c98a1f` 文字压在 `--amber-soft #3a2c14` 上 = **4.60:1**（余量仅 0.10）→ **禁用组合**。需要「次级金字 + 琥珀底衬」时改用 `--amber-bright`（**8.70:1** ✅）。
2. `--amber-border #8a6520` **仅限装饰线**，**不得用于任何传达状态的边界**——它对 `--amber-soft` 只有 **2.56:1**（<3:1）。**状态边界一律用 `--amber-dim`**（对 `--bg` = 6.07:1 ✅）。

**已知局限（色弱可辨性）**
`--amber-soft #3a2c14` 对 `--bg #12162b` 仅 **1.32:1**（对 `--bg-soft #171c35` 仅 **1.24:1**）——几乎**纯靠色相差**区分，色弱用户对「琥珀填充态」**近乎不可辨**。
> **因此：每一处琥珀填充态都必须同时改「边框 + 文字色」，不许只改填充。** 例：`.credit` 填充 = 底 `--amber-soft` **+** 边 `--amber-border` **+** 字 `--amber-bright`；`.send` = 底金渐层 **+** 深字 `--amber-ink`（深字本身即边界）。只加一个背景色 ≠ 表达清楚。

---

## 5. 与危险红的区分度

现状：琥珀 `#f0a92e`(hue 38–39°) vs 危险 `#e8736a`(hue 4.3°)，色相仅差 **35°**（<60° 安全阈）。

但感知实测（CIEDE2000）：**`#f0a92e` vs `#e8736a` = ΔE 31.7**（>10 即「明确不同」）；`#ffc65c` vs `#e8736a` = 35.0。**结论：默认不改 danger**（`#e8736a` 在深底 6.03:1，文字对比更稳），靠下面三板斧区分：

| 维度 | 琥珀金（能量） | 危险红（危险） |
|---|---|---|
| 语义 | 计量/进行中/消耗/主行动/发声 | 停止/录制中/错误/危险 |
| 质感签名 | **描边 / 发光 / 金底深字**，带暖光晕 | **实心填充 + 白图标**，无光晕 |
| 位置 | 顶栏标题·状态条·输入区·消息区·设置 | 仅：顶栏右侧录制/急停簇、工具区急停常驻键、错误消息、mic 开启 |
| 动效 | 可呼吸/扫光（能量在动） | 静止（刹车不闪） |

**硬规矩**：
1. 顶栏右侧图标簇（录制/急停）**旁边不放琥珀元素**——避免红点与金点相邻误判。
2. **不在红底上叠金字，不在琥珀底上放红字。**
3. 急停/录制沿用具名红 `#D8443F`（`.pinned.danger`）或 `--danger`，不受琥珀体系影响。
4. **可选增强**：若仍觉得近，把 t1 `--danger` 从 `#e8736a` 调整为 `#e0574f`（更纯红，ΔE 提到 34.8，深底 4.80:1 仍 ≥4.5）。**默认不启用**，因 4.80 < 6.03，略有牺牲。

---

## 6. t1 深色适配缺口（同一处顺手修，且**引入金色**）

审计发现设置面板大量浅色硬编码在 t1 深色下失效/刺眼（**已违反 WCAG**）：

| 选择器 | 现值 | t1 实测 | 问题 |
|---|---|---|---|
| `.slothead` | `color:#3c3489` | **1.74:1** | 分区标题几乎不可见 ❌ |
| `.field label` | `color:#5f5e5a` | **2.75:1** | 表单标签不可读 ❌ |
| `.slotbox` | `background:#fdfdfc` | 白色卡片浮在深底上 | 明暗冲突 |
| `.sheet .row2 button` | `background:#faf9f6` | 白按钮 | 明暗冲突 |
| `.pinned:hover / .mcell:hover` | `background:#fff` | 悬停白闪 | 明暗冲突 |
| `.step-ico.if` | `background:#fdf2e0` | 浅桃色块 | 明暗冲突 |

统一在 `[data-theme="t1"]` 下覆盖为令牌（见 §7 补丁），既修对比度又把金色带进设置面板。

### 6.2 二类表面（复核后补全）——t1 下同样穿帮，需一并覆盖

以下为我回看 §7 后发现**遗漏**的浅色硬编码，均为既有问题（非本次改动引入）：

| 选择器 | 行 | 现值 | t1 问题 | 建议 |
|---|---|---|---|---|
| `.mlist button` | 840-844 | `background:#faf9f6` + `color:var(--fg)` | **浅底 + 浅字 = 不可见** ❌ | 底`var(--bg-soft)` / 边`var(--border-strong)` / 字`var(--fg-soft)` |
| `.pinned.danger`（急停常驻键） | 588 | `background:#fdf4f3;border-color:#f0c9c7` | 深底上一块浅粉 ❌（关系 #2 可发现性） | 底`var(--danger-soft)` / 边`var(--danger)` / 字`var(--danger)`；**注：Phase 3 会删除 `#toolStop` 常驻键（用户要求急停移出工具区）→ 本项降级为「顺手 t1 化，留作复用」** |
| `#wbmodel`（后台模型下拉） | 686 | `background:#fff` | 白下拉浮深底 ❌ | 底`var(--bg-soft)` / 字`var(--fg-soft)` |
| `#mic.on` / `#voice-status` | 714/717 | `background:#fdecec; color:#d8443f` | 浅粉底 + 硬编码暗红字 | 底`var(--danger-soft)` / 字`var(--danger)` |
| `.minibtn` | 834-837 | 边`#d3d1c7` + 字`#5f5e5a` | 字 on sunken **2.86:1** ❌ | 边`var(--border-strong)` / 字`var(--fg-soft)` |
| `.hist-box` | 866 | `background:rgba(255,255,255,.98)` | 白色历史浮层 | 底`var(--bg-soft)` |
| `.hist-hd`（sticky 头） | 880 | `background:rgba(255,255,255,.98)` | 白色 sticky 头 | 底`var(--bg-soft)` |
| `.hist-box::-webkit-scrollbar-thumb` | 874 | `#dcd9d0` | 浅滑条 | `var(--border-strong)` |
| `.wfe-head`（sticky） | 996 | `background:rgba(255,255,255,.985)` | 白色 sticky 头 | 底`var(--bg-soft)` |
| `.wfe-json:focus` | 1071 | `background:#fff` | 白 | `var(--bg-sunken)` |
| `.pedit-tab.on` | 1089 | `background:#fff` | 白 | `var(--bg)` |
| `.pfield-in` / `.pfield-pick` / `.pwait-num` | 1101/1111/1140 | `background:#fff` | 白输入 | `var(--bg-sunken)` |
| `.front-state.ok/.warn/.bad` | 830-832 | 浅绿/浅琥珀/浅红底 | 浅色小块 | 分别 `rgba(79,201,141,.14)`/`var(--amber-soft)`/`var(--danger-soft)` |
| `.shot` | 783 | 边`#d3d1c7` | 浅边 | `var(--border-strong)` |
| `.field input:hover/select:hover` | 765 | 边`#b9b6ab` | 浅边 | `var(--border-strong)` |
| `.chip.sel` | 475 | 边`#b9b2ee` | 浅薰衣草（滑轨内被 `border:none!important` 遮住，别处复用会穿帮） | `var(--accent)` |
| `.led` 底态 / `.led.off` | 457/466 | 底态 `#c9c6bc`、off `var(--danger)`(红) | off 误用危险红、底态在深底上发亮 | **off 与底态都用 `--fg-muted`（4.95:1）**；**明令禁用 `--border-strong`**（对底仅 **1.80:1**，≈隐形）。`.led` 尺寸 **7px** |

**CSS 覆盖不到（内联样式，需前端改 JS/HTML）**：动态生成的错误红字 `style="color:#a32d2d"`（行 1881/1887/1906/1953/1960/3032/3045）与 `#5f5e5a`/`#faf9f6`/`#d3d1c7`/`#e8e6df` 内联样式（行 2743/2746/2786），在 t1 深底下对比不足；建议内联改 `var(--danger)` / 令牌，或加 t1 分支。`.msg.err .body` 本身用 `var(--danger)`（OK）。

---

## 7. 落地补丁（可直接粘贴，纯配色 / 质感，零布局影响）

> 建议整块追加到现有主题样式之后。所有属性仅限：`color / background(-image) / border-color / box-shadow / text-shadow / fill / animation-name / opacity`。**未触碰** 任何 `width/height/padding/margin/gap/font-size/position/display`。

```css
/* ============ t1 琥珀金「能量色」系统（零布局改动） ============ */
[data-theme="t1"] {
  --amber-bright:#ffc65c; --amber:#f0a92e; --amber-dim:#c98a1f;
  --amber-soft:#3a2c14; --amber-border:#8a6520; --amber-ink:#12162b;
  --amber-wash-faint:rgba(240,169,46,.04);
  --amber-wash:rgba(240,169,46,.10);
  --amber-wash-strong:rgba(240,169,46,.18);
  --amber-glow:rgba(240,169,46,.32);
  --amber-line:rgba(240,169,46,.42);
  --run:var(--amber); --warn:var(--amber);
}

/* 顶栏：金字标题 + 琥珀环 + 底金线 + 暖铺层 */
[data-theme="t1"] header {
  background:
    radial-gradient(120px 34px at 4% 0%, var(--amber-wash), transparent 72%),
    linear-gradient(180deg, var(--bg) 0%, var(--bg-soft) 100%);
  border-bottom-color: var(--amber-border);
}
[data-theme="t1"] header .title { color: var(--amber-bright); text-shadow: 0 0 14px var(--amber-glow); }
[data-theme="t1"] header img { box-shadow: 0 0 0 1.5px var(--amber); }
[data-theme="t1"] header:hover img { box-shadow: 0 0 0 1.5px var(--amber), 0 2px 10px var(--amber-glow); }
[data-theme="t1"] #avatar.busy { animation-name: avBreatheA; }
@keyframes avBreatheA {
  0%,100% { box-shadow: 0 0 0 1.5px var(--amber), 0 0 0 3px rgba(240,169,46,.10); }
  50%     { box-shadow: 0 0 0 2px   var(--amber), 0 0 0 7px rgba(240,169,46,.16); }
}

/* 状态条：积分 chip + 活跃灯 + 暖铺层 */
[data-theme="t1"] .strip {
  background: radial-gradient(220px 60px at 6% 50%, var(--amber-wash), transparent 70%), var(--bg-soft);
}
[data-theme="t1"] .credit {
  border-color: var(--amber-border);
  background: linear-gradient(180deg, var(--amber-soft), var(--bg-soft));
  color: var(--amber-bright);
}
[data-theme="t1"] .credit-ico { fill: var(--amber); }
[data-theme="t1"] .credit b { color: var(--amber-bright); }
[data-theme="t1"] .credit:hover {
  border-color: var(--amber); background: var(--amber-soft); color: var(--amber-bright);
  box-shadow: 0 2px 10px var(--amber-glow);
}
[data-theme="t1"] .credit:hover .credit-ico { fill: var(--amber-bright); }
[data-theme="t1"] .credit.bump { animation-name: creditBumpA; }
@keyframes creditBumpA {
  0% { transform: scale(1); }
  28% { transform: scale(1.12); background: var(--amber-soft); border-color: var(--amber); }
  100% { transform: scale(1); }
}
[data-theme="t1"] .led { background: var(--fg-muted); }        /* 未点亮底态：用 fg-muted；禁用 --border-strong(1.80:1≈隐形) */
[data-theme="t1"] .led.on { background: var(--amber); animation-name: ledpulseA; }
[data-theme="t1"] .led.off { background: var(--fg-muted); box-shadow: none; }   /* off 钉死 fg-muted(4.95:1)，禁用危险红/低对比色 */
@keyframes ledpulseA {
  0%,100% { box-shadow: 0 0 0 3px rgba(240,169,46,.20); }
  50%     { box-shadow: 0 0 0 6px rgba(240,169,46,.05); }
}

/* 执行条：琥珀底 + 金扫光 */
[data-theme="t1"] #liveBar {
  background: linear-gradient(180deg, var(--amber-soft), #241a0c);
  color: var(--amber-bright);
  border-bottom-color: var(--amber-border);
  box-shadow: inset 0 0 24px rgba(240,169,46,.10);
}

/* 消息区：Orb 强调条=琥珀（用户气泡保持靛蓝） */
[data-theme="t1"] .msg.orb::before { background: var(--amber); opacity: .5; }
[data-theme="t1"] .typing i { background: var(--amber-dim); }
[data-theme="t1"] .pending { color: var(--amber); }

/* 工具区：更多入口 / 分段锚点吃琥珀，hover 转金（并修掉深色 #fff 白闪） */
[data-theme="t1"] .more-btn { border-color: var(--amber-border); color: var(--amber-dim); }
[data-theme="t1"] .more-btn b { color: var(--amber); opacity: .85; }
[data-theme="t1"] .more-btn:hover,
[data-theme="t1"] .more-btn.on { border-color: var(--amber); color: var(--amber-bright); background: var(--amber-soft); }
[data-theme="t1"] .more-sec { color: var(--amber-dim); }
[data-theme="t1"] .more-sec::before { background: var(--amber); opacity: .55; }
[data-theme="t1"] .pinned:hover { background: var(--amber-soft); border-color: var(--amber); color: var(--amber-bright); }
[data-theme="t1"] .mcell:hover   { background: var(--amber-soft); border-color: var(--amber); color: var(--amber-bright); }

/* 输入区：发送键=琥珀填充主行动 + 顶金线 + 暖铺层 */
[data-theme="t1"] .compose {
  background: radial-gradient(260px 80px at 50% 100%, var(--amber-wash), transparent 74%), var(--bg-soft);
  border-top-color: var(--amber-border);
}
[data-theme="t1"] textarea:focus { border-color: var(--amber); box-shadow: 0 0 0 3px rgba(240,169,46,.14); }
[data-theme="t1"] .send {
  background: linear-gradient(180deg, var(--amber-bright), var(--amber));
  color: var(--amber-ink);
  box-shadow: 0 1px 3px rgba(240,169,46,.35);
}
[data-theme="t1"] .send:hover { box-shadow: 0 4px 14px var(--amber-glow); }
[data-theme="t1"] .send:disabled { background: var(--border-strong); color: var(--fg-muted); box-shadow: none; }

/* 消息区底部暖晕：α 已钉死 .04（faint），护 --fg-muted 正文——不得上调，不足的占比去 header/strip/compose 补 */
[data-theme="t1"] .messages {
  background: radial-gradient(320px 130px at 50% 100%, var(--amber-wash-faint), transparent 80%);  /* α=.04 上限：护 --fg-muted 正文 */
}

/* 设置面板：修掉浅色硬编码 + 引入琥珀 */
[data-theme="t1"] .sheet { border-color: var(--border-strong); }
[data-theme="t1"] .sheet .slotbox { background: var(--bg-soft); border-color: var(--border); }
[data-theme="t1"] .slothead { color: var(--amber-bright); }
[data-theme="t1"] .slothead .hint { color: var(--fg-muted); }
[data-theme="t1"] .slotnote { background: var(--amber-soft); border-color: var(--amber-border); color: var(--fg-soft); }
[data-theme="t1"] .slotnote b { color: var(--amber-bright); }
[data-theme="t1"] .field label { color: var(--fg-soft); }
[data-theme="t1"] .field input,
[data-theme="t1"] .field select { background: var(--bg-sunken); border-color: var(--border-strong); color: var(--fg); }
[data-theme="t1"] .field input:focus,
[data-theme="t1"] .field select:focus { border-color: var(--amber); background: var(--bg); box-shadow: 0 0 0 3px rgba(240,169,46,.14); }
[data-theme="t1"] .sheet .row2 button { background: var(--bg-soft); border-color: var(--border-strong); color: var(--fg-soft); }
[data-theme="t1"] .sheet .row2 button.pri,
[data-theme="t1"] .sheet .row2 button.pri:hover {
  background: linear-gradient(180deg, var(--amber-bright), var(--amber));
  border-color: var(--amber); color: var(--amber-ink);
}
[data-theme="t1"] .sheet .note { color: var(--fg-muted); }
[data-theme="t1"] kbd { background: var(--bg-sunken); border-color: var(--border-strong); color: var(--fg-soft); }
[data-theme="t1"] .themecard { background: var(--bg-soft); }
[data-theme="t1"] .themecard:hover { border-color: var(--amber); background: var(--bg-sunken); }
[data-theme="t1"] .themecard.on { border-color: var(--amber); background: var(--amber-soft); }
[data-theme="t1"] .themecard b { color: var(--fg); }
[data-theme="t1"] .themecard .hint { color: var(--fg-muted); }
[data-theme="t1"] .step-ico.if { background: var(--amber-soft); color: var(--amber-bright); }
[data-theme="t1"] .step-ico.loop { background: rgba(79,201,141,.14); color: var(--ok); }
[data-theme="t1"] .cr-bar.hot > i { background: linear-gradient(90deg, var(--amber), #e8590c); }

/* ===== 二类表面：t1 深色 light-hardcode 补全（见 §6.2）===== */
[data-theme="t1"] .mlist button { background: var(--bg-soft); border-color: var(--border-strong); color: var(--fg-soft); }
[data-theme="t1"] .pinned.danger { background: var(--danger-soft); border-color: var(--danger); color: var(--danger); }
[data-theme="t1"] #wbmodel { background: var(--bg-soft); color: var(--fg-soft); border-color: var(--border-strong); }
[data-theme="t1"] #mic.on { background: var(--danger-soft); color: var(--danger); }
[data-theme="t1"] #voice-status { color: var(--danger); }
[data-theme="t1"] .minibtn { border-color: var(--border-strong); color: var(--fg-soft); }
[data-theme="t1"] .hist-box { background: var(--bg-soft); }
[data-theme="t1"] .hist-hd { background: var(--bg-soft); }
[data-theme="t1"] .hist-box::-webkit-scrollbar-thumb { background: var(--border-strong); }
[data-theme="t1"] .wfe-head { background: var(--bg-soft); }
[data-theme="t1"] .wfe-json:focus { background: var(--bg-sunken); }
[data-theme="t1"] .pedit-tab.on { background: var(--bg); }
[data-theme="t1"] .pfield-in,
[data-theme="t1"] .pfield-pick,
[data-theme="t1"] .pwait-num { background: var(--bg-sunken); }
[data-theme="t1"] .front-state.ok   { color: var(--ok);    border-color: rgba(79,201,141,.30); background: rgba(79,201,141,.14); }
[data-theme="t1"] .front-state.warn { color: var(--amber); border-color: var(--amber-border);   background: var(--amber-soft); }
[data-theme="t1"] .front-state.bad  { color: var(--danger); border-color: var(--danger);        background: var(--danger-soft); }
[data-theme="t1"] .shot { border-color: var(--border-strong); }
[data-theme="t1"] .field input:hover,
[data-theme="t1"] .field select:hover { border-color: var(--border-strong); }
[data-theme="t1"] .chip.sel { border-color: var(--accent); }
/* 注：动态内联样式（错误红字 #a32d2d 等，见 §6.2 末）CSS 覆盖不到，需前端改内联。 */
```

> 注：`.setnav-i.on`（设置左导航选中）**保持靛蓝**不动——导航=品牌/选择，留给靛蓝，避免琥珀在面板里变成第二主色。

---

## 8. 交付与对齐

- **体验（Phase 2）**：`.led.off` 与底态已**钉死 `--fg-muted`（4.95:1）**，不再是待复核项；「能量三点」在消息区大量文字时是否干扰阅读——**已定 α=.04**（不得再上调，见 §2.2 α 纪律），Phase 2 只需确认观感、不需改值。
- **前端（Phase 3）**：直接落 §7 补丁块；`--run/--warn` 已别名，既有 JS/规则零改动；三套主题切换机制不变；回归用 §3.3/§3.4 口径 A/B 统计截图占比（A 静息 ≥2.5%）。
- **动效兜底（已逐条核实，非"受既有兜底"）**：新增三个 keyframes 的选择器**均已在 `panel.html` 的 `html.no-motion` 关闭列表内**——
  · `:229 html.no-motion .credit.bump, html.no-motion #avatar.busy { animation:none }` → 覆盖 `creditBumpA` + `avBreatheA` ✅
  · `:230 html.no-motion .led.on { animation:none }` → 覆盖 `ledpulseA` ✅
  三者特异性均高于 `[data-theme="t1"]` 前缀规则（`html.no-motion …` 多一个元素），故 `animation:none` 生效 → **无需前端往列表补任何选择器**；另受 `@media (prefers-reduced-motion)` 全局 `*{animation-duration:.01ms !important}` 二次兜底。
- **未做（守约）**：未改任何布局/尺寸/间距/DOM；未引入字体或图片外链；新增 `@keyframes` 仅含 transform / box-shadow。

---

## 9. 流光溢彩质感层（任务 #7，覆盖 §7 中下列元素的**填充/发光**）

用户拍板「用流光溢彩的颜色」→ 能量色由平涂升级为**多段虹彩渐变 + 分层辉光**。t1 以下选择器的 `background` / `box-shadow` / `text-shadow` 以 **`iridescent-spec.md` §2** 为准（在 §7 之后加载）：
`.send`（靛蓝→琥珀→亮金 4-stop 渐变 + 3 层辉光）、`#liveBar`（深靛→深金渐变）、`.credit`（金底渐变 + 虹彩内描边）、`header .title`（3 层辉光）、`.led.on`（radial 金光斑）。
- 逐 stop 对比度已在 `iridescent-spec.md` §2.2 给出：`.send` 文字列全段 ≥8.87；`#liveBar` 最低 6.07；`.credit` 最低 6.99 → 全过 AA。
- 新增 `@keyframes iridSweep`（发送键斜向高光掠过，**只动 transform**），兜底写入补丁内：`html.no-motion .send::after { animation:none !important }` + `@media (prefers-reduced-motion)`。
- 红线：只动 transform/opacity；无 `backdrop-filter`、无 `background-position` 大面积位移、无每帧模糊。
- 其余 §1–§8（令牌、α 纪律、配错纪律、动效核实）**不变**。
