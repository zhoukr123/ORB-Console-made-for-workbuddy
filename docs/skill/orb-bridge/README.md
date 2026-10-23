# ORB 桥接技能包 · 上架说明

这个目录是给 **WorkBuddy 开放平台**（open.workbuddy.cn）用的技能包。
打包上传后，任何 WorkBuddy 用户都能在对话里说"帮我点一下桌面上的 XX"，
由本机 ORB 控制台真的去执行。

## 目录结构

```
orb-bridge/
├── SKILL.md              ← 必需。YAML 头 + 给 AI 的执行指令
├── README.md             ← 本文件，不参与上架解析
├── references/
│   └── api.md            ← 桥接服务端点速查（内容读自 bridge.mjs 源码）
└── assets/
    └── icon.png          ← 512×512，97KB，就是 ORB 控制台本体那个图标
```

压缩时**只压 `orb-bridge/` 里的内容**，解压后第一层必须直接看到 `SKILL.md`。
多套一层文件夹是平台最常见的退回原因。

## 上架四步

1. **入驻认证**：open.workbuddy.cn →「立即入驻」→ 个人认证
   （身份证 + 人脸，几分钟）。个人认证足够发布技能。
   注意：一个身份证全平台只能认证一个个人主体；真实姓名 / 身份证号 / 手机号 / 邮箱四项必须一致。
2. **上传代码包**：发布管理 → 选「技能」→ 创建 → 上传 `orb-bridge.zip`。
   格式有问题平台会直接报错并提示缺什么，**不要反复重传**，按提示改一处、重压一次。
3. **补展示信息**：

   | 字段 | 填什么 |
   | --- | --- |
   | 市场展示名称 | `ORB 桌面操作助手`（9 字，上限 15 字，别写"测试""最终版"） |
   | 头像 | `assets/icon.png`（512×512，≤500KB，JPG/PNG） |
   | 分类 / 服务类目 | 效率工具 |
   | 版本 | v1.0.0 |

4. **提交审核**：周期约 7 个工作日。过审后全平台可搜可装。

## 十项自检（提交前逐条过）

1. 解压后**第一层**就能看到 `SKILL.md`（没多套文件夹）
2. YAML 头四个字段齐全且大小写正确：`name` `description` `version` `category`
3. 缩进统一**两个空格**，没有 Tab；冒号后都有一个空格
4. `name: orb-bridge` 与文件夹名完全一致，只用英文小写加连字符
5. `description` 写清了"解决什么问题 + 在什么场景用"，不是"提升效率"这类空话
6. 头像 512×512 且 ≤500KB
7. 展示名不含"测试""最终版""demo"字样
8. 分类与服务类目选准（选错会被退回）
9. 正文里的地址只有 `127.0.0.1:19387`，没有局域网 IP 或公网地址
10. 找一个没参与制作的人试装试用，确认他能跟着 SKILL.md 跑通

## 已知的退回原因（平台统计的高频五项）

| 原因 | 本包的对策 |
| --- | --- |
| 名称与内容不符 | 展示名与能力一一对应，没夸张 |
| 描述过于笼统 | `description` 写了具体触发条件与产出 |
| 图标 / 头像不合格 | 直接用本体的 512×512 图标 |
| 字段格式出错 | 见自检第 2、3 条 |
| 文件夹多套一层 | 打包命令已保证，见下 |

## 打包命令

PowerShell（关键：`includeBaseDirectory: $false`，否则会多套一层）：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  "D:\workbuddy_ORB控制台\docs\skill\orb-bridge",
  "D:\workbuddy_ORB控制台\docs\skill\orb-bridge.zip",
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false)
```

打完后用这条验证结构（必须第一项就是 `SKILL.md`）：

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead("D:\workbuddy_ORB控制台\docs\skill\orb-bridge.zip")
$z.Entries | Select-Object -First 5 FullName
$z.Dispose()
```

## 上架之后

- 每周看一次后台调用量，调用量为 0 说明 description 没被触发，回去改触发条件；
- 用户提的需求进 ROADMAP，技能升版本号重新上传（同一个发布入口 → 更新版本）；
- 这个技能是 ORB 的**自然流量入口**：用户为了用技能会去装 ORB 本体，
  所以技能描述里那句"本机装有 ORB 控制台时使用"不要删——它同时是筛选器和引流钩子。
