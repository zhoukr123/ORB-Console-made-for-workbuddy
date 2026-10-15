# ORB 控制台 —— 渲染层性能优化（`panel.html`）

范围：仅 `desktop/panel.html`（任务 #3 中属于渲染层的部分）
日期：2026-10-14　工程师：寇豆码（Kou）
备份：`panel.html.perfbak-20261014-001027`

> 未触碰 `main.js` / `bridge.mjs` / `native/`（另一位工程师并行改动中）。

---

## 一、`/api/status` 空闲轮询 5s → 10s

### 改了什么

| 行号 | 改动 |
|---|---|
| `5972-5974` | 新增两个具名常量，把轮询周期从散落的魔法数字收敛到一处：`POLL_FAST_MS = 1200`（有活动）、`POLL_IDLE_MS = 10000`（空闲，原 5s） |
| `5985` | `if (pollBusy) { schedulePoll(POLL_FAST_MS); return; }` —— 上一次请求未回的短间隔重试 |
| `5986` | `if (document.hidden) { schedulePoll(POLL_IDLE_MS); return; }` —— 面板隐藏时的兜底刷新，5s→10s |
| `5989` | `let next = POLL_IDLE_MS;` —— 默认下一轮间隔 |
| `5999` | `next = busy ? POLL_FAST_MS : POLL_IDLE_MS;` —— 有活动仍走 1.2s 快轮询 |

同时把注释块（`5964-5977`）补上了「为什么 10s 不影响体感」的依据。

### 收益

- **空闲态 `/api/status` 请求量减半**：12 次/分钟 → 6 次/分钟。
- 快轮询（1.2s）**完全没动**：跑工作流 / 有待确认项时界面依旧跟手。
- 面板隐藏时依旧零请求（`document.hidden` 分支 + `visibilitychange` 可见即刷）。

### 为什么 10s 不影响体感

空闲态这一路只刷三样东西：通道灯、急停态、待确认队列。
- **通道灯**是常亮状态指示，10s 延迟无感；
- **急停**有热键触发路径，触发后 `toggleStop()` → `syncStopUi()` 会立刻单独回查一次，不走轮询；
- **待确认队列**一旦出现，bridge 会把本轮判为 busy，`next` 自动切回 1.2s 快轮询 —— 也就是说「有待确认」根本不会落在 10s 档上。

### 关于「连续 15 次失败」阈值 —— **经核对后决定：保持 15 不动**

任务派发时建议「周期从 5s 变 10s 后，实际等待从 75 秒变成 150 秒，倾向把阈值调成 8（约 80 秒）」。**这个换算基准不对，按它改会引入回归**，说明如下。

#### 事实核对（`panel.html` 实测）

`fails` 这个计数在全文只出现 3 处（`2778 / 2781 / 2783`），全部位于 `poll()` 内部。两条定时器是完全独立的：

```
pollStatus()  → setTimeout 链，间隔 POLL_IDLE_MS(10s) / POLL_FAST_MS(1.2s)   ← 没有失败计数
poll(id,node) → setInterval，固定 2000ms                                     ← fails 归这条
```

| 量 | 值 |
|---|---|
| 原「75 秒」的来历 | 假设 `fails` 挂在 5s 状态轮询上：15 × 5s = 75s —— **但它不挂在那** |
| 实际（改前） | 15 × **2000ms** = **30 秒** |
| 实际（改后，10s 只影响状态轮询） | 15 × **2000ms** = **30 秒**，**完全没变** |
| 若按建议改成 8 | 8 × 2000ms = **16 秒** —— 不是预估的 80 秒 |

#### 为什么不能改成 8

后台任务（WorkBuddy 派发）本身就是分钟级的长任务。放弃跟踪的阈值实际会变成 **16 秒**：桥一次正常的重启、或一次十几秒的网络抖动，就会被误判成「桥没了」→ 提前 `clearInterval` + 提示「状态失联」。用户会看到**明明还在跑的任务被判定为失败**，这是功能回归，代价远大于省下的几个请求。

#### 决定与防复发

- **阈值保持 `JOB_FAIL_MAX = 15`（30 秒）不动。**
- 顺手把两个魔法数字抽成具名常量并写死换算公式（`panel.html:2771-2798`、`2836`）：

```js
const JOB_POLL_MS = 2000;
const JOB_FAIL_MAX = 15;      // 15 × 2000ms = 30s 放弃
```

注释里明确写了：
> 若要把放弃等待改成 N 秒，阈值应设为 `N / 2`（例：要 80 秒就填 **40**），
> **不要**拿 `POLL_IDLE_MS` 去除 —— 那会算出一个过小的阈值
> （比如误按 10s 折算填 8，实际只有 8 × 2s = 16 秒）。

**如果确实想把放弃等待拉长到 ~80 秒，正确的值是 40，不是 8** —— 说一声我就改，一行的事。

#### 顺带确认

`applyChannels(r)` 仍在每次 `pollStatus()` 都被调用（`panel.html:5992`），只是刷新频率随轮询降到 10s。通道灯是常亮状态指示，10s 刷新完全够用，不会「看起来更迟钝」。

### 确认未受影响

- `applyChannels(r)`（上轮新增）仍在 `pollStatus()` 里每次执行（`5992`）—— 通道灯刷新频率随轮询降到 10s，符合预期。
- 失败收摊逻辑（`fails >= 15`）未动，见上。

---

## 二、被淘汰 job 的终态处理

**结论：此项上一轮已修复，本轮未重复改动，仅复核确认。**

- 对应 Bug 清单 **#23**（`BUGFIX-渲染层.md`）
- 代码位置：`panel.html:2787-2798`

```js
if (!r.ok) {
  clearInterval(timer);
  setRunning(-1);
  updateMsg(node, '<span style="color:#a32d2d">后台任务状态已丢失：'
    + esc(r.error || '未知原因') + '</span>', 'err');
  return;
}
```

原来这条分支只 `clearInterval + setRunning(-1)` 就 return，计数和定时器都收干净了，唯独消息节点没人碰 —— 气泡永久停在「后台执行中… N 秒」。

bridge 侧（`bridge.mjs:2646`）的 404 文案已改为「job X 不存在或已被淘汰（最多保留 N 条）」，这里直接把它显示出来，用户能自解释，不需要在面板侧另造一套措辞。该分支同时也收口了「dispatch 没返回 jobId」这类情况。

本轮复核：`node --check` 通过，断言确认该分支及其 `clearInterval`/`setRunning(-1)` 均完好。

---

## 三、大结果裁剪的渲染层兜底

**结论：兜底上一轮已铺好，本轮按 R-2 最终契约对齐了文案措辞。**

- 对应 Bug 清单 **#24**（`BUGFIX-渲染层.md`）
- 代码位置：`panel.html:2810-2826`

契约（与 bridge 约定）：超 512KB 的结果 → job 顶层挂 `truncated: true`，`result` 键整个不返回。

```js
const truncated = j.truncated || j.result?.truncated;
let txt = parts.join('\n');
if (!txt) txt = truncated ? '(结果过大已省略，未回传全文)' : '(无文本返回)';
else if (truncated) txt += '\n\n（结果过大已省略，以上仅为开头部分）';
updateMsg(node, esc('后台完成：\n\n' + txt));
```

### 覆盖路径确认

| 契约形态 | `parts` | `truncated` | 面板表现 |
|---|---|---|---|
| 未裁剪（现状） | 非空 | undefined | 正文照常显示 —— **行为与今天完全一致** |
| 已裁剪、result 整个不返回（R-2 契约） | 空 | true | 「(结果过大已省略，未回传全文)」 |
| 已裁剪、result 只留摘要（备选方案） | 非空 | true | 正文显示摘要，末尾补「（结果过大已省略，以上仅为开头部分）」 |

- 提示是**消息正文里的一行文字，不是弹窗**，符合要求。
- `truncated` 两个位置都认（job 上或 result 上），将来契约若挪动也不用改面板。
- **当前 `truncated` 恒为 undefined，所以今日零行为变更** —— 纯前置铺路，bridge 侧一上线自动生效。

本轮只把措辞从「结果过长」统一成任务要求的「结果过大」，两处都改了。

---

## 四、`backdrop-filter` 专项评估（顺手评估项）

### 结论：**12 是 grep 命中数，不是声明数。真实声明只有 3 条，远低于 6~10 预算，无需改动。**

### 命中数拆解

`grep -n "backdrop-filter" panel.html` 得到 12 行，实际构成：

| 类别 | 行数 | 说明 |
|---|---|---|
| 注释里提到这个词 | 5 | 第 `80 / 93 / 555 / 560 / 590` 行，纯文字 |
| `transition` 属性 | 1 | 第 `97` 行 `backdrop-filter .22s`，是过渡声明不是模糊 |
| **真实模糊声明** | **6 行 = 3 条规则 × 2**（`-webkit-` 前缀 + 标准属性各写一遍） | 见下表 |

### 3 条真实声明的可见性分析

| # | 行号 | 选择器 | 半径 | 可见性 |
|---|---|---|---|---|
| 1 | `571-572` | `[data-theme="t3"] .card` | blur(10px) | **仅主题 t3（极光·氤氲）**，面板主壳体，常驻可见 |
| 2 | `585-586` | `[data-theme="t3"] .hist-box, .sheet, .more-panel` | blur(8px) | **仅 t3**，弹层（历史/设置/更多工具），非始终可见 |
| 3 | `1505-1506` | `.hist-mask` | blur(5px) | 弹层遮罩，仅弹层打开时出现 |

- **主题 t1 / t2 完全不使用 backdrop-filter** —— 第 1、2 条都带 `[data-theme="t3"]` 限定。
- 最坏情况（t3 + 弹层打开）= 同时 3 层模糊，仍远低于 6~10 预算。
- 第 3 条 `.hist-mask` 是全屏的、软件渲染下最贵，但已做过三重优化（去掉 `saturate`、半径压到 5px、底下垫了 `rgba(38,33,92,.16)` 纯色兜底），且只在弹层打开时存在。

### 项目既有性能红线的合规确认

| 红线 | 状态 |
|---|---|
| 只做静态模糊、快径 ≤10px | ✅ 三条分别 10 / 8 / 5px，全部静态 |
| 严禁对 `backdrop-filter` 做动画 | ✅ 无关键帧动画；只有第 `97` 行一条 220ms 的主题切换过渡（点主题那一次跑十几帧，非循环、不跟滚动挂钩），文件里已注明这是允许的 |
| 消息区不加模糊 | ✅ `.messages`（`1135`）无 `filter`/`backdrop-filter`，t3 下只叠 `var(--band-veil)` 白纱 |
| 背景渐变板不能动起来 | ✅ 未触碰 |

**→ 不需要把任何一处改成伪玻璃。改了反而会牺牲已调好的观感，收益为零。**

---

## 五、评估中另外发现的两点（未改，仅报告）

### 5.1 `#liveBar` 用了一条 `filter: brightness()` 的无限呼吸动画

位置：`panel.html:1023-1027`

```css
#liveBar { animation: livein .22s var(--ease) both, livebreathe 2.4s ease-in-out .3s infinite; }
@keyframes livebreathe {
  0%, 100% { filter: brightness(1) }
  50%      { filter: brightness(1.06) }
}
```

- 这是**持续帧重算**的动画，且 `filter` 不在「只允许 transform / opacity」的白名单里。
- 缓解因素：元素很小（一条状态条）、只在有任务跑时可见（`applyLive` 控制 `display`）、已有 `prefers-reduced-motion` 兜底（`1028-1031`）。
- 同处的 `#liveBar::after` 扫描线用的是 `transform: translateX`，合规。

**未改动**：按你的要求「判断改动会有可见观感差异就别改」。这条呼吸效是刻意做的「在跑」体感，换成 opacity 叠层很难做到无差别。如果实测确认它带来可观开销，再单独定方案。

### 5.2 `.messages` 带 `scroll-behavior: smooth`

位置：`panel.html:1135`

`addMsg` / `addStep` 每次追加都执行 `msgs.scrollTop = msgs.scrollHeight`（`panel.html:2281 / 2300 / 3541` 等）。在 `scroll-behavior: smooth` 下这是**动画式滚动**，视觉循环这类高频追加场景（每步一次）会让滚动动画排队。

**未改动**：属于观感取舍，且没有实测数据支撑它造成了卡顿。留作候选，需要时改成瞬时滚动是一行的事。

---

## 六、自检

| 项 | 结果 |
|---|---|
| `node --check`（panel.html 主 script / voice.js / preload.js） | ✅ 全部通过 |
| 断言脚本 8 项 | ✅ 全 OK（含反向断言：确认无残留写死的 `5000`、确认 `fails` 阈值与 `clearInterval` 未被误改） |
| 新增硬编码颜色 / 外链 / CDN / `@import` | ✅ 无 |
| 新增 `animation` / `transition` / `backdrop-filter` | ✅ 无 |
| `prefers-reduced-motion` 兜底 | ✅ 未触碰 |
| 主题令牌 / 配色 / 背景渐变板 | ✅ 未触碰 |
| 快捷键（Ctrl+Space / Ctrl+K / Ctrl+Alt+S / Ctrl+Alt+G / Ctrl+Alt+Backspace / F9） | ✅ 全部保留 |
| 只改 `panel.html` | ✅ `main.js` / `bridge.mjs` / `native/` 零改动 |

## 七、收益汇总

| 项 | 收益 | 代价 |
|---|---|---|
| 空闲轮询 5s→10s | `/api/status` 请求量 **-50%**（12→6 次/分钟） | 无体感差异（见第一节依据） |
| `JOB_POLL_MS` / `JOB_FAIL_MAX` 常量化 | 消除 2 个魔法数字，写死「阈值 = 目标秒数 / 2」换算公式，防止被按错误基准误调 | 无（行为不变，仍 30s 放弃） |
| 被淘汰 job 终态 | 消除「永远转圈」的死状态 | 无（上轮已修） |
| 大结果裁剪兜底 | 裁剪上线后用户不会看到误导性的「无文本返回」 | 无（今日零行为变更） |
| backdrop-filter 评估 | 澄清真实值 3 条而非 12 条，避免了一次无收益的观感改动 | 无 |
