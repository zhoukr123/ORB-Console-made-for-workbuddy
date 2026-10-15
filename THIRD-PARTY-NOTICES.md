# 第三方许可公告（THIRD-PARTY NOTICES）

> 本文件说明 **ORB 控制台** 在源码仓库与已发布二进制中随附的第三方组件及其许可证。
> 本仓库自身以 **MIT** 授权，见 [`LICENSE`](./LICENSE)。
>
> 维护约定：凡新增或变更第三方依赖，**必须**同步更新本文件（构建脚本应对其做 diff 提醒）。

---

## 0. 一句话结论

- 本项目的**发布物中不含任何 GPL / LGPL / AGPL 二进制**。
- 唯一需要单列说明的弱 copyleft 组件是 Python 的 **`certifi`（MPL-2.0，文件级）**，见 §3.3。
- 后台通道使用的 **CodeBuddy CLI 是腾讯专有软件，既不随本仓库分发、也不随任何发布资产分发**，见 §4.1。

---

## 1. 运行时框架

| 组件 | 许可证 | 说明 |
| --- | --- | --- |
| **Electron** | MIT | 桌面外壳。版本以 `orb/desktop/package.json` 的 `devDependencies.electron` 为准。Electron 自身为 MIT，其许可文本随 Electron 分发物一同提供。 |
| **Chromium**（Electron 内置） | BSD 系为主的混合许可集合 | Electron 内置 Chromium 的完整许可证清单以其自带的 `LICENSES.chromium.html` 为准，该文件随 Electron 分发物提供；本项目不修改它。 |
| **Node.js**（Electron 内置） | MIT（含其 `deps/` 下若干 BSD / Apache-2.0 / ISC 组件） | 桥接层 `orb/bridge.mjs` 与本地 HTTP 服务运行于其上。完整清单见 Node.js 源码树自带的 `LICENSE` 文件。 |

---

## 2. 随包分发的 npm 依赖（全部为 MIT / ISC / BSD 系）

下列包位于 `orb/node_modules/`，构建时会被复制进发布物（见 `orb/desktop/package.json` 的 `extraResources`）。
许可证字段均取自各包 `package.json` 的 `license`；**版本随 `package-lock.json` 锁定，以实际构建为准**。

| 包 | 许可证 |
| --- | --- |
| `@modelcontextprotocol/sdk` | MIT |
| `express` | MIT |
| `hono` / `@hono/*` | MIT |
| `jose` | MIT |
| `zod` / `zod-to-json-schema` | MIT |
| `cors` | MIT |
| `express-rate-limit` | MIT |
| `uiohook-napi` | MIT |
| `pkce-challenge` | MIT |
| `eventsource` / `eventsource-parser` | MIT |
| `body-parser` / `raw-body` | MIT |
| `cross-spawn` / `which` / `isexe` / `path-key` / `shebang-*` | ISC / MIT |
| `ajv` / `ajv-formats` / `fast-deep-equal` / `fast-uri` / `json-schema-traverse` | MIT |
| `cookie` / `cookie-signature` / `qs` / `send` / `serve-static` / `type-is` / `mime-*` | MIT |
| `debug` / `ms` / `depd` / `inherits` / `once` / `wrappy` / `unpipe` / `ee-first` / `on-finished` | MIT |
| `iconv-lite` / `safer-buffer` | MIT |
| `ipaddr.js` / `ip-address` / `proxy-addr` / `forwarded` | MIT |

> 上述清单覆盖 `orb/node_modules` 的实际内容；若构建时依赖树发生变化，请以
> `npm ls --all --json` 或 `license-checker` 的输出为准并回填本表。

---

## 3. Python 侧随包组件（前台通道 `windows-mcp` 及其精简依赖集）

前台自动化通道由 **windows-mcp** 提供。构建期由 `scripts/build-python-runtime.ps1`
生成一个「嵌入版 CPython + 精简 site-packages」并随包发布（该目录本身不进 git，见 `.gitignore` 的 `resources/runtime/`）。

### 3.1 windows-mcp

- 名称：**windows-mcp**
- 版本：**0.8.5**
- 许可证：**MIT**
- 作者：**Jeomon George**（CursorTouch）
- 上游以 MIT 授权发布，本项目按其要求保留版权与许可声明：

```
MIT License

Copyright (c) Jeomon George

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 3.2 windows-mcp 的精简依赖集（全部 MIT / Apache-2.0 / BSD / PSF）

构建期刻意剔除的部分（及其原因）在 §3.4 列出。精简后随包的依赖包括（许可证类别）：

| 分类 | 包 | 许可证 |
| --- | --- | --- |
| MCP / 服务框架 | `fastmcp`、`mcp`、`starlette`、`uvicorn`、`pydantic`、`pydantic-core`、`anyio`、`cyclopts`、`docstring-parser` | Apache-2.0 / MIT / BSD |
| CLI 与终端 | `click`、`rich`、`markdown-it-py`（随 rich）、`pygments`、`mdurl` | BSD / MIT |
| Windows 自动化 | `pywin32`、`comtypes`、`psutil` | PSF / MIT / BSD |
| 图像 | `pillow`（PIL） | HPND（Historical Permission Notice and Disclaimer，MIT 兼容） |
| 文本 / 抓取 | `requests`、`urllib3`、`idna`、`charset-normalizer`、`markdownify`、`beautifulsoup4`、`soupsieve`、`six`、`tabulate` | Apache-2.0 / MIT / BSD |
| 工具库 | `platformdirs`、`uuid7`、`python-dotenv`、`typing-extensions`、`exceptiongroup`、`pyperclip` | MIT / PSF / BSD |
| 模糊匹配替代 | `thefuzz`、`rapidfuzz` | MIT（用于替代 GPL 的 `fuzzywuzzy`，见 §3.4） |

### 3.3 ⚠️ 单列：`certifi`（MPL-2.0）

| 项 | 内容 |
| --- | --- |
| 包 | `certifi` |
| 许可证 | **MPL-2.0**（Mozilla Public License 2.0，**文件级**弱 copyleft） |
| 为何随包 | `requests` 的传递依赖，用于 TLS 根证书；移除会导致抓取类工具失败 |
| 合规措施 | ① **保持该包内文件完全原样，本项目不修改其任何文件**；② 在此单列公告；③ 提供源码获取方式（见下） |
| 源码获取 | `pip download certifi --no-binary :all:` 或访问其官方 PyPI / 上游项目页面获取完整源码与 MPL-2.0 全文 |

> MPL-2.0 是**文件级** copyleft：只要不修改 certifi 自身的文件，仅随包分发不构成对整个作品的传染。
> 若将来希望彻底移除 MPL 组件，可评估以 `truststore`（MIT）替代或自持 CA 证书。

### 3.4 刻意**不**随包的 Python 组件

| 包 | 许可证 | 不随包的原因 | 处置 |
| --- | --- | --- | --- |
| `fuzzywuzzy` | **GPLv2** | 强 copyleft | 用 `thefuzz`（MIT）+ 自写同名转发壳顶替 |
| `python-Levenshtein` / `levenshtein` | **GPL-2.0-or-later** | 强 copyleft | 剔除（仅作加速器，`rapidfuzz` 已承担） |
| `posthog` | MIT（但是**第三方遥测 SDK**） | 不分发第三方遥测代码 | 用自写 MIT no-op stub 顶替 import，并在子进程环境里设 `ANONYMIZED_TELEMETRY=false`、`POSTHOG_API_KEY=` 双重关闭 |
| `numpy`、`dxcam` | MIT | 体积（约 55 MB）+ 无必要 | 改用 `pillow` 截图后端 |
| `pip`、`pythonwin`、`PyWin32.chm` | MIT / PSF | 仅构建期需要 | 剔除 |

---

## 4. **不**随任何发布资产分发的第三方组件

### 4.1 CodeBuddy CLI（后台 Agent 通道）—— 专有软件

- **性质**：CodeBuddy Code CLI 是腾讯的**专有命令行软件**。
- **处置**：本项目**不打包、不镜像、不代理分发** `codebuddy.exe`。用户如需后台 Agent 通道，
  必须**自行安装并登录/注册**。安装地址与命令请以官方渠道为准
  （本仓库文档中的相应位置保留 `TODO` 占位，**不代为填写**）。
- **原因**：再分发专有二进制即构成侵权；要求用户自行获取是唯一合规路径。
- **代码侧**：`orb/bridge.mjs` 只做「环境变量 `ORB_WB_CLI` → 系统 PATH」的定位，
  定位不到即优雅降级（后台通道置灰 + 中文提示），**不崩溃、不影响其它通道**。

### 4.2 语音识别（ASR）运行时依赖 —— 仅用户端按需安装

本地离线语音识别（faster-whisper 链路）的全部依赖 **不在发布物内**，
由用户在界面上点「安装」时才在本机创建虚拟环境并安装：

| 包 | 许可证 | 备注 |
| --- | --- | --- |
| `faster-whisper` | MIT | 用户端运行时安装 |
| `ctranslate2` | MIT | 用户端运行时安装 |
| **`av`（PyAV）** | 其二进制内含 **FFmpeg**（常见构建为 **LGPL**） | ⚠️ **仅由用户在自己机器上安装，绝不进本项目的任何发布资产**。安装按钮旁已明示「将下载第三方组件（含 FFmpeg 解码库，其许可证由各自项目提供）」 |
| `fastapi`、`uvicorn`、`huggingface-hub`、`tokenizers` 等 | Apache-2.0 / MIT / Apache-2.0 | 用户端运行时安装 |

### 4.3 模型权重 —— 运行时下载

- Whisper 权重（如 `Systran/faster-whisper-small`）由**用户在自己机器上**下载，
  数百 MB 量级，且属第三方模型，不进仓库、不进发布资产。
- 视觉模型的 API Key **必须由用户自行填写**（算力成本在用户侧，无法代付），本项目从不保存/回传明文 Key。

---

## 5. 自检与合规门禁

- 构建期应导出 `resources/runtime/THIRD-PARTY-NOTICES.txt`（可用 `pip-licenses` 生成）并与本文件核对。
- CI 门禁建议：`pip-licenses` 输出中出现 **GPL / LGPL / AGPL** 即判定失败。
- 依赖版本一律 pin 在 `runtime/requirements-curated.txt`，防止依赖漂移引入新的 copyleft 组件。

---

## 6. 如有遗漏

若您认为本公告遗漏或误述了某个组件的许可信息，请提交 issue，
我们会补充或更正。第三方组件的许可文本以其各自上游项目发布的原文为准。
