#Requires -Version 5.1
<#
.SYNOPSIS
  ORB 本地离线语音识别 · 一键安装（建 venv → 装依赖 → 下 small 权重 → 落 ready 标记）
.DESCRIPTION
  由 bridge 的 POST /api/asr/prepare 触发，幂等：中断后重跑会复用已建好的 venv、
  接着下没下完的权重（断点续传），不会推倒重来。

  解释器选择顺序（DESIGN §5.2 / §14.3）：
    -Py 参数 > ORB_ASR_BASE_PY 环境变量 > PATH 上的 python > 随包嵌入 python
    优先用户自己的 Python：venv 用它来建，装的就是用户自行获取的第三方组件
    （faster-whisper 依赖链含 av/FFmpeg，不进发布物，见 THIRD-PARTY-NOTICES.md）。

  所有输出行格式统一为（面板/bridge 解析进度用）：
    [orb-asr] <step> <percent> <message>
    step: pick / venv / deps / model / done / error

.PARAMETER AsrDir
  asr 源码目录（默认取脚本所在目录；打包态是 resources/asr）。
.PARAMETER Py
  手动指定解释器全路径（默认按上面的顺序自动挑）。
.PARAMETER Repo
  模型仓库（默认 Systran/faster-whisper-small）。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File prepare.ps1
#>
param(
  [string]$AsrDir = $PSScriptRoot,
  [string]$Py = "",
  [string]$Repo = "Systran/faster-whisper-small"
)

$ErrorActionPreference = 'Stop'
# 输出一律 UTF-8：桥按 UTF-8 读管道，中文提示不能变乱码（PS 5.1 默认走 OEM 代码页）
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

function Step([int]$Percent, [string]$Name, [string]$Message) {
  Write-Output ("[orb-asr] {0} {1} {2}" -f $Name, $Percent, $Message)
}
function Fail([string]$Message) {
  Write-Output ("[orb-asr] error 0 {0}" -f $Message)
  exit 1
}

if (-not (Test-Path -LiteralPath $AsrDir)) { Fail "找不到 asr 目录：$AsrDir" }

# ── 1. 选解释器 ───────────────────────────────────────────────
function Pick-Python {
  if ($Py -and (Test-Path -LiteralPath $Py)) {
    return @{ Exe = (Resolve-Path -LiteralPath $Py).Path; Source = 'param' }
  }
  $envPy = $env:ORB_ASR_BASE_PY
  if ($envPy -and (Test-Path -LiteralPath $envPy)) {
    return @{ Exe = (Resolve-Path -LiteralPath $envPy).Path; Source = 'env' }
  }
  $cmd = Get-Command python -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Source) { return @{ Exe = $cmd.Source; Source = 'path' } }
  # 随包嵌入 python（embeddable CPython，PSF 许可）：
  #   开发态  <repo>\orb\runtime\python\python.exe
  #   打包态  <app>\resources\runtime\python\python.exe
  $cands = @()
  if ($env:ORB_RUNTIME_DIR) { $cands += (Join-Path $env:ORB_RUNTIME_DIR 'python.exe') }
  $cands += (Join-Path $AsrDir '..\orb\runtime\python\python.exe')
  $cands += (Join-Path $AsrDir '..\runtime\python\python.exe')
  foreach ($c in $cands) {
    if (Test-Path -LiteralPath $c) { return @{ Exe = (Resolve-Path -LiteralPath $c).Path; Source = 'embedded' } }
  }
  return $null
}

Step 0 'pick' '选择 Python 解释器…'
$pyInfo = Pick-Python
if ($null -eq $pyInfo) {
  Fail "没有找到可用的 Python 解释器。请先安装 Python 3.10+ 并加进 PATH（或设置环境变量 ORB_ASR_BASE_PY 指向 python.exe），然后重试。"
}
$verOut = & $pyInfo.Exe -V 2>&1
if ($LASTEXITCODE -ne 0) { Fail "解释器不可用：$($pyInfo.Exe)（$verOut）" }
Step 8 'pick' "解释器：$($pyInfo.Exe)（$verOut，来源 $($pyInfo.Source)）"

# ── 2. 建虚拟环境（asr/venv，与前台通道的运行时互相独立） ───────
$venvDir = Join-Path $AsrDir 'venv'
$venvPy = Join-Path $venvDir 'Scripts\python.exe'
$bootstrapPip = $false
if (Test-Path -LiteralPath $venvPy) {
  Step 12 'venv' '检测到已存在的虚拟环境，复用（重跑会接着装，不会推倒重来）。'
} else {
  Step 12 'venv' '创建虚拟环境…'
  & $pyInfo.Exe -m venv $venvDir
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPy)) {
    # 嵌入版 Python 不带 ensurepip，venv 建不出来 → 先 --without-pip，再自行引导 pip
    Step 15 'venv' '该解释器不带 ensurepip，改用 --without-pip + get-pip 引导…'
    & $pyInfo.Exe -m venv --without-pip $venvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPy)) {
      Fail "创建虚拟环境失败（解释器：$($pyInfo.Exe)）。可改装一个 Python 3.10+ 并加进 PATH 后重试。"
    }
    $bootstrapPip = $true
  }
}
if ($bootstrapPip) {
  $getPip = Join-Path $env:TEMP 'orb-get-pip.py'
  try {
    Step 18 'venv' '下载 get-pip.py…'
    Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip -UseBasicParsing -TimeoutSec 120
    & $venvPy $getPip --disable-pip-version-check 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "pip 引导失败（get-pip.py 退出码 $LASTEXITCODE）" }
  } catch {
    Fail "pip 引导失败：$($_.Exception.Message)。建议改装一个 Python 3.10+ 并加进 PATH 后重试。"
  }
}

# ── 3. 装依赖（faster-whisper / fastapi / uvicorn，约 200 MB） ──
Step 22 'deps' '安装依赖（约 200 MB，首次取决于网速，请稍候）…'
$req = Join-Path $AsrDir 'requirements.txt'
if (-not (Test-Path -LiteralPath $req)) { Fail "缺少依赖清单：$req" }
& $venvPy -m pip install --disable-pip-version-check -r $req
if ($LASTEXITCODE -ne 0) {
  Step 30 'deps' '默认源安装失败，改用阿里云镜像重试…'
  & $venvPy -m pip install --disable-pip-version-check `
    -i https://mirrors.aliyun.com/pypi/simple --trusted-host mirrors.aliyun.com -r $req
  if ($LASTEXITCODE -ne 0) {
    Fail "依赖安装失败（pip 退出码 $LASTEXITCODE）。常见原因：网络不通或被代理拦截；修复网络后直接重试本按钮即可。"
  }
}
Step 68 'deps' '依赖安装完成。'

# ── 4. 下 small 权重（约 480 MB，download_model.py 内部断点续传） ──
Step 72 'model' "下载 Whisper 权重（约 480 MB，支持断点续传）…"
$dl = Join-Path $AsrDir 'download_model.py'
if (-not (Test-Path -LiteralPath $dl)) { Fail "缺少下载脚本：$dl" }
& $venvPy $dl $Repo (Join-Path $AsrDir 'models\small')
if ($LASTEXITCODE -ne 0) {
  Fail "权重下载失败（退出码 $LASTEXITCODE）。下载支持断点续传，修复网络后重试即可接着下。"
}

# ── 5. 落 ready 标记（面板据此显示"已安装"，bridge 据此决定自启） ──
Step 98 'done' '写入就绪标记…'
$confPath = Join-Path $AsrDir 'asr.conf'
try {
  $cfg = New-Object psobject
  if (Test-Path -LiteralPath $confPath) {
    $raw = Get-Content -LiteralPath $confPath -Raw -Encoding UTF8
    if ($raw.Trim()) { $cfg = $raw | ConvertFrom-Json }
  }
  $cfg | Add-Member -NotePropertyName 'ready' -NotePropertyValue $true -Force
  # 必须无 BOM：asr_server.py 用 json.loads 读，带 BOM 会解析失败
  $json = $cfg | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($confPath, $json, (New-Object System.Text.UTF8Encoding($false)))
} catch {
  Fail "写就绪标记失败：$($_.Exception.Message)"
}

Step 100 'done' '安装完成，本地离线识别已就绪（离线可用、免 Key）。'
exit 0
