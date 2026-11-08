# overview — 2026-11-08 本轮交付

## 做了什么

按「拿业界一手方案逐条对标，既补新短板、也回头复核已做完的项」这一要求，本轮做了四件事：

1. **新增回放前预检** `orb/wfPreflight.mjs`（对标 Playwright actionability + n8n 四道门）
   动手前抓一次控件树，把「哪几步的锚点已经找不到」先摆出来，别等跑废前四步才发现第 5 步失效。
   分两层判：静态自洽问题（缺工具名 / 循环体空 / 子流程引用已删配方 / 编排图有环）→ `block`；
   锚点核对 → 只判 `warn`（中途界面可能被前面步骤切走）。查不出来的一律标 `unverifiable`，不猜。

2. **两处回头修**（第 5 条消息点名"已做好的也要对标"，结果真挖出两个洞）
   - `backoffMs` 原来是纯指数**无抖动** → 改 AWS Full Jitter（+50ms 地板，桌面动作 0 延迟等于立刻再点一次）。
   - `canResume` 原来只比**步数** → 加配方内容指纹 `recipeDigest`。步数一样但改过坐标这类情况，
     旧实现会放行并从错的位置接上（正是 Temporal 讲的非确定性来源）。

3. **删配方先查引用**：删掉被 `subflow` 引用的配方，引用方要到运行时才炸。现在先拦住、
   说清是谁在第几步引用（含编排图节点这一路，最容易漏），确认后可强删。

4. **目录整理 + 一条命令验收**
   - `_parse_work/`（0 引用）与 9 个陈旧 `.children-*.json` → `ORB存储/archive/2026-11-08/散落文件归位/`
   - 新增 `SRC-INDEX.md`：每个目录归属 + 13 个**不可移动**的运行时路径（`DATA_DIR` 就是这个根目录）
   - 新增 `orb/tools/verify-all.mjs`：`node orb/tools/verify-all.mjs` 一次跑完七项

另外顺手修了三个小 bug：复核筛选下拉切了不重渲染、栏目页看不到「待复核 N」、预检弹层在探针里
取不到按钮（异步没等）。

## 验收（全绿）

```
node orb/tools/verify-all.mjs
→ 7 项全过 / 19.8s
```

- 单元测试 **1428 / 1428**（新增预检 27 项、断点指纹 5 项、退避抖动 4 项）
- 打包闭包 94 / 94，依赖边 132
- PANEL_OK / REG_OK（102 模块）/ CAP_OK
- 自动化 API 冒烟 **87 / 87**（原 77，新增预检 4、悬空引用 4、内容指纹 2）
- 面板运行时冒烟 PANEL_RUNTIME_OK（含新增 preflight 探针）

## 关键决策

| 决策 | 理由 |
|---|---|
| 预检的锚点问题只判 `warn`，不判 `block` | 一次快照看不到中途状态。判死会天天误报，误报几次功能就没人用了 |
| 退避抖动加 50ms 地板 | AWS 允许退到 0；桌面动作 0 延迟重试＝立刻再点一次 |
| 旧断点没有内容指纹时**拒绝**续跑 | 无从核对就不放行。宁可从头跑，不赌"大概没改过" |
| 删配方不硬拒，给 `force` | 两条一起删是合理需求；硬拒会把人卡死 |
| 不做熔断器 | GUI 独占 + 单用户 + 串行，无并发风暴；由 `autoPolicy` 降级兜底更对症 |

## 文档

- `docs/可靠执行-对标记录.md` —— 每条设计对标了哪个一手来源、采纳什么、**拒绝什么及为什么**
  （含明确记录「熔断器不适配」的论证，免得后人当漏项重做一遍）
- `SRC-INDEX.md` —— 目录归属与新增文件该放哪

## 已知还差

1. 预检只做静态 + 「能不能解析」；真跑一次仍是唯一硬证据。
2. 内容指纹是 32 位 FNV，对"改没改"够用，非安全用途。
3. `cache/` 与 `ORB存储/` 同名目录并存是历史分层（中间态 vs 成品），已写进索引，不合并。

---

# 追加：设置 › 自动化栏目重排（UI 收口）

## 做了什么

原来自动化页是「一个列表 + 一排按钮 + 混在里面的运行历史 + 一个导出栏目」，本轮按语义重切成三栏，
并撤掉一块多余功能。

| 区块 | 内容 |
|---|---|
| 已录好的自动化 | 配方列表；**刷新**收成标题右侧 `.setsec-ico` 图标键（24px） |
| 新建自动化 | 「编排示例」「用 AI 生成」两个按钮 + 一行用途说明 |
| 运行历史 | `待复核 N` 角标 + 「打开历史」+ 一句话摘要（独立成栏） |
| ~~导出与交付~~ | **整块删除**（HTML / JS / CSS 全撤），交付形式交 agent 自选，默认 `.md` |

## 修掉的四个具体毛病

1. **删除键被顶出边框** —— `.wf-row` 是 `display:flex` 不换行，7 个操作键挤满一行，
   名称 `flex:1 1 auto; min-width:0` 被压到 0 宽。三层修：`flex-wrap:wrap` +
   名称 `flex:1 1 96px; min-width:64px` + 操作键打包成 `.wf-ops{flex:0 0 auto;margin-left:auto}`，尺寸 28→26px。
2. **中文按钮竖排、占地巨大** —— `.slot-actions button` 缺 `white-space:nowrap` 且参与 flex 收缩，
   窄栏下每字一行。加 `flex:0 0 auto; white-space:nowrap`，按钮数同时从 4 减到 2。
3. **两个生成按钮点了像没反应** —— 结果只发到聊天栏，设置页看不见；且 `renderWfSetList()`
   会清空 `wfSetMsg`。改为 `wire()` 收集返回值 → 先重渲染 → 再写提示（顺序错了提示会被抹掉）。
4. **急停收场清单过长** —— 受影响工单 6→2 条、可续跑候选 6→3 条，标题带总数。

## 顺带修的两处测试债

- `check-panel.mjs` 原来靠**注释锚点**切 CSS 区块（`indexOf("/* ===== 设置 › 存储 › 导出与交付")`），
  栏目一删就报「找不到区块」。改为按**选择器**（`.wf-*` / `.setsec-ico`）正则取规则块。
- `officeExport.test.mjs` 原来断言「面板 chips 与后端 FORMATS 一致」，本质是维护两份清单必然漂移。
  改为断言「面板里不许再出现 `const EXP_FORMATS`」——唯一来源是 `outputProfile.FORMATS`。
- 新增 `panel-runtime-smoke` 的 `autoLayout` 探针：三栏都存在、刷新键在列表栏、生成键在新建栏、
  历史键在历史栏、互不串位、且不再有「导出与交付」。

## 验收

```
node orb/tools/verify-all.mjs
→ 7 项全过 / 25.0s（单测 1428 / 冒烟 87 / PANEL_RUNTIME_OK，DOM_PROBE autoLayout:true）
```

## 边界

导出能力**没有删**：`/api/export`、`exporter.mjs`、`outputProfile.mjs` 原样保留，只是不再由面板驱动。

---

# 追加：设置页信息密度收口（三处）

同一天晚上的第二轮，用户连提三条"版幅太长 / 看不懂 / 交互呆板"，逐条落地。

## 1. 存储页：路径不再重复铺，日志控件并排

| 改前 | 改后 |
|---|---|
| 8 枚摘要卡，其中 4 条都是同一前缀的绝对路径（`D:/.../ORB存储/artifacts/2026-11-08`、`...\logs\2026-11-08`） | 6 枚卡：存储根报全路径一次，产物 / 日志只报**相对子路径**（`artifacts/2026-11-08`、`logs/2026-11-08`），悬停给完整地址 |
| 日志级别、保留天数各占一行（label 块级 + select 100% 宽） | 同一行并排：label 在左、select 收窄到 88–140px |
| 审计日志一次铺 60 条，撑到 280px 高 | 默认只摆最近 **6** 条 + 「查看全部 N 条」按钮，高度上限降到 190px |

实现要点：
- `artLogRel(p, root)` 只在确认同根时才裁前缀，存储根换盘时原样返回，不瞎删。
- `artLogSet(id, v, full)` 多接一个参数：显示值缩写了，`title` 里仍留完整路径。
- 审计日志的「刷新」必须包一层箭头函数 —— `el.onclick = renderAuditInline` 会把 click 事件
  当成实参传进去，一旦函数有展开参数，**一刷新就自动变成全展开**。

## 2. 插件页：页签错位是个真 bug，市场列表默认收起

- **Bug**：HTML 把「已安装」写死成 `.on`，启动时又从 `localStorage` 把 `tab` 恢复成 `market`，
  于是页签亮着「已安装」、列表里却是市场条目。修法：抽 `syncTabs()`，`init()` 先对齐再拉数据。
- **市场列表**：卡片收起态只有「名称 + 类别」一行，点整行展开（描述 / 市场 / 版本 / 许可 / 安装键）。
  默认只摆 **2 条**，其余点「显示更多 · 还有 N 条」按 20 条一批放出。
  有搜索词或选了市场时不受此限 —— 那时用户是在找东西，命中多少给多少。

## 3. 自动化 / 安全页：两处窗口 + 工单监督人话化

- **回收站 / 运行历史**：都改成 `.auto-list.capped` 固定窗口（78px ≈ 2 行）+ 纵向滑条，
  「运行历史」栏内新增 `#autoRunsRecent`（时间 · 名称 · 状态，点行开抽屉）。
  完整明细仍在抽屉里，栏目只回答"刚才跑成什么样"。
- **新建自动化**：两个键从 UA 默认直角按钮改成 8px 圆角方框 + hover 抬升 / active 回弹，
  双降级（`html.no-motion` 与 `prefers-reduced-motion`）一并写上；外层多余的 `.slotbox`
  撤掉（`.setsec-bd` 已有内边距，套两层等于双份留白），说明压成一行。
- **工单监督**：标题从「工单监督 · 叙述 vs 原始动作」改回「工单监督」，顶部加一句用途：
  核对「它说做了什么」和「账本里真记了什么」是不是同一件事。
  左列改为结论先行（`已完成 / 失败 · 需要你看一眼` + 为什么停在这 + 最近动作），
  `epoch / rev / 检查点 / 成本` 折进「技术细节」；右列每条轨迹压成
  `时分秒 · 类型 · 摘要`，JSON 折到「参数」按钮后面。
  工单状态加了 `TICKET_STATUS` / `TICKET_NEEDS_YOU` 两张小表（对齐 `ticketStore.mjs` 的 RANK），
  表里没有的状态原样显示，不编。

## 验收

```
node orb/tools/verify-all.mjs
→ 7 项全过 / 22.3s
DOM_PROBE 新增：autoNewFlat / artLogCompact / artLogRow / auditPreview /
               plugTabs / plugMoreBtn / autoLists / govPlain 均为 true
```

新增探针全部用 computed style 判，不靠几何量 —— 元素隐藏时也能断言，
不会因为"面板没切到那一页"就假绿。

---

# 追加：设置页留白再收一档（用户举了两张图，其余按同一判据自查）

## 判据

一屏里塞十几个分区的页面，浪费不是"某一块特别大"，而是**每一层都多留几像素**：
`.setsec` 10px + `.slotbox` 10px + `.field` 10px + `.slotmsg` 8px，叠三五层就是一屏。
所以这轮分两类处理：**统一收一档间距** + **把竖排的重复结构改成并排**。

## 统一收一档

| 位置 | 改前 | 改后 |
|---|---|---|
| `.setsec` | padding 10/12/12，margin-bottom 10 | 9/11/10，8 |
| `.setsec-hd` | margin-bottom 9 | 7 |
| `.setsec-bd` | gap 10 | 8 |
| `.slotbox` | padding 10/12/4，margin-bottom 10 | 8/10/2，8 |
| `.slothead` | margin-bottom 8 | 6 |
| `.field` | margin-bottom 10 | 8 |
| `.slotmsg` | line-height 1.6，margin-bottom 9，胶囊 padding 6/9 | 1.5，8，5/8 |
| `.slotnote` | line-height 1.65，padding 7/9，margin-bottom 9 | 1.55，6/8，7 |
| `.auto-intro` | gap 4，padding 9/11，margin-bottom 10 | 3，8/10，8 |

另加一条：**`.slotmsg:empty { display: none }`**。设置页有几十个待命的提示条，
每条都白占 8px 外边距 + 一份 flex gap，加起来的空白没有任何信息。

## 竖排改并排（图 2 的根因）

音频来源 / 摄像头形状 / 三处皮肤选择，原本都是 `.recskin-row` 竖排——**一行一个**，
每张卡 38px 高，三张就 114px，占的是整整三行版面。

改成 `.recskin-row.compact`：一行并排、图标在上文字在下的竖排小卡。
关键约束是量出来的：352px 的卡片减掉导航列和各层内边距，**真实可用宽度只有 ~207px**，
三格各 ~65px。所以横向排「图标 + 文字 + 勾」放不下（勾会吃掉 12px，把「系统音」挤成省略号），
只能改成「图标在上、文字在下」并藏掉勾——选中态仍有 2px 主题色描边 + 淡底，信息量不减。

实测（Electron 里量 getBoundingClientRect）：
- 音频来源三张卡 `top` 全等（同一行），65×44，标签 `scrollWidth <= clientWidth`（没被裁）
- 摄像头形状三张卡同理，65×45
- 由 3×38+2×8=130px 降到 44px，**这两块各省 ~86px**

## 图 1：开关行与操作键

- 两条开关行原来是「标签 + 长解释」塞在一行文字里，窄栏下换行把开关顶到下一行，
  每行 ~50px。长解释搬进 `title`，正文只留短标签，`.artLog-tog` 改 `nowrap` + 省略号：
  **每行 23px，开关与文字同一行**。
- 三个操作键原来换行成两行：「打开当天目录 / 导出日志 / 立即清理」在 207px 里放不下。
  文案收短（打开目录 / 导出日志 / 清理，全称进 `title`）+ 内边距 4/8：
  **三个 `top` 全等，一行放下**。

## 顺手判断的另外几处

- 「摄像头小框」原本在同一块里出现三次（`.slothead` + `.field label` + 按钮文案）。
  删 `.slothead`，按钮改「已开启 / 已关闭」，`.field label` 右边的状态改为说明「录屏时会叠加」。
- 自动化页顶部 `.auto-intro` 说明压成一行。
- 审计日志 / 日期目录两个滚动窗口下调到 190 / 200px。

## 验收

```
node orb/tools/verify-all.mjs
→ 7 项全过 / 20.6s（recCompact / artLogTogs / slotmsgEmpty 三个新探针均为 true）
```

几何量是用一次性 Electron 脚本量的（getBoundingClientRect + scrollWidth 判裁切），
量完即删，没留在仓库里——它验的是"此刻的版式"，不适合当构建期断言。

---

# 追加：安全页去掉「插件启停清单」

设置 › 插件 已经有专门一栏展示启停，同一份状态摆两处只会互相过期打架（面板级启停是
localStorage 偏好，桥侧镜像更新时机不同，两边同时显示反而让人不知道该信哪个）。

删掉的是**展示**，不是数据：

- `panel.html`：`#safOvPlugins` 容器 + `safLoadOverview()` 里画清单那一段（约 15 行）
- `panel.css`：只服务于这块的 `.saf-ov-plugins .pl-off` 一条；
  容器规则 `.saf-ov-plugins` 保留 —— 影子路由观测卡的 `#shadowAnnotBar` 还在用它
- **没动** `safety.overview` 的返回结构（`plugins` 字段仍在），
  `test/safetyOverview.test.mjs` 与 `tools/team-mode-smoke.mjs` 验的都是桥侧契约，照旧通过

新增探针 `safNoPlugins`：既查 `#safOvPlugins` 不存在，也查整个安全页文本里
不再出现「插件启停清单」——防止下次改动顺手又塞回来。

验收：`node orb/tools/verify-all.mjs` → 7 项全过。
