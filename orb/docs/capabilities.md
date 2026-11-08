# 急停期间仍放行的能力（自动生成，勿手改）

> 本文件由 `orb/capabilityRegistry.mjs` 的 `toMarkdown()` 生成。
> 要改白名单请改那个文件，然后跑 `node orb/tools/gen-capabilities-doc.mjs`。
> 单测会校验本文件与清单一致 —— 手改这里会直接测挂。

| server | tool | 只读 | 急停放行 | 它到底做了什么 |
|---|---|---|---|---|
| orb | cursor_position | 是 | 是 | 读鼠标坐标；不动鼠标、不点任何东西 |
| orb | ocr | 是 | 是 | 截屏后离线取词；只读屏幕像素，不操作窗口 |
| orb | subtitle | 是 | 是 | 查实时字幕状态；启停字幕仍受急停拦截 |
| windows | Screenshot | 是 | 是 | 截一张屏；不移动焦点 |
| windows | Snapshot | 是 | 是 | 读当前窗口与控件树；不改任何状态 |
| windows | DisplayInventory | 是 | 是 | 枚举显示器信息；纯查询 |

## 为什么只有这几项

急停的语义是「别再动了」。因此豁免只给**看了也不会改变任何状态**的查询：
截屏、看屏幕、读显示器、查鼠标位置、取词。

`workbuddy_execute`（后台派活）已于 2026-11-03 移出白名单：它不动机器，
但它是**最贵、最久、最容易跑飞**的那一类 —— 急停期间还允许新建，等于刹车踩下去油门还留着。

新增豁免必须同时满足三条，缺一条就别加：
1. `readOnly: true`，且实际实现里确实没有任何写操作；
2. 不占用 GUI 锁（不移动焦点、不点到别的窗口）；
3. 用户能看懂 `effect` 那句人话 —— 说不清的，就是不该放行。

检索类（`windows|Scrape`、外部 `/api/search`、`browser|dom.get_text` 等）
**一律不进豁免**：它们会往外发请求并带回不可信正文，急停时必须一起停。
`readOnly: true` 只表示「不改本机状态」，**不等于**「急停期间可放行」。
这条由 `batchA.mjs` 的 `searchExemptAudit()` 与单测点名锁定，别靠「没登记」
这种隐式满足 —— 将来往清单里加一行 search 就会静默破防。
