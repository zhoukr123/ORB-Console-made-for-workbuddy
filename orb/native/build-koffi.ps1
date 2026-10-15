# 编译 DSH 依赖的原生模块 koffi
#
# 背景：当初安装 @deepseek-ai/dsh 时因为本机没有编译器，只能用 --ignore-scripts
# 跳过原生编译，结果 koffi 至今是坏的。DSH 跑 headless 时直接报：
#   Cannot find the native Koffi module; did you bundle it correctly?
# 现在 MSVC + Windows SDK 都确认可用了，可以把它真正编译出来。
#
# 注意：同样不能依赖 vcvars64.bat（它要调被拦截的 reg.exe），
# 这里手工拼 INCLUDE/LIB/PATH。
#
# 用法： powershell -ExecutionPolicy Bypass -File native\build-koffi.ps1

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 用 %USERPROFILE% 而不是硬编码作者家目录：这个脚本会随仓库开源发布，
# 带 "C:\Users\<用户名>\..." 既不通用也会泄漏作者机器路径。
# 若 koffi 装在别处，用 $env:ORB_KOFFI_DIR 覆盖。
$KOFFI = if ($env:ORB_KOFFI_DIR) { $env:ORB_KOFFI_DIR }
         else { Join-Path $env:USERPROFILE ".workbuddy\orb-dsh\profiles\node_modules\@deepseek-ai\node_modules\koffi" }
if (-not (Test-Path $KOFFI)) { throw "找不到 koffi 目录：$KOFFI（可用 `$env:ORB_KOFFI_DIR` 指定）" }
Write-Output "koffi: $KOFFI"

Write-Output ""
Write-Output "== 探测 MSVC =="
$clCandidates = @()
foreach ($root in @('D:\vs', 'C:\Program Files\Microsoft Visual Studio', 'C:\Program Files (x86)\Microsoft Visual Studio')) {
  if (-not (Test-Path $root)) { continue }
  $found = Get-ChildItem -LiteralPath $root -Filter 'cl.exe' -Recurse -File -Force -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -match '\\Hostx64\\x64\\cl\.exe$' }
  if ($found) { $clCandidates += $found }
}
if (-not $clCandidates) { throw "找不到 cl.exe" }
$cl = $clCandidates | Sort-Object { $_.Directory.Parent.Parent.Parent.Name } | Select-Object -Last 1
$msvcRoot = $cl.Directory.Parent.Parent.Parent.FullName
Write-Output "  $($cl.FullName)"

Write-Output "== 探测 Windows SDK =="
$kits = $null; $ver = $null
foreach ($k in @('C:\Program Files (x86)\Windows Kits\10', 'D:\Windows Kits\10') | Where-Object { Test-Path $_ }) {
  $v = (Get-ChildItem (Join-Path $k 'Include') -Directory -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1).Name
  if ($v -and (Test-Path (Join-Path $k "Lib\$v"))) { $kits = $k; $ver = $v; break }
}
if (-not $kits) { throw "找不到 Windows SDK" }
Write-Output "  $kits ($ver)"

Write-Output "== 探测 CMake =="
# 优先用 VS 自带的 CMake：pip 装的 cmake.exe 在本机被同步 spawn 拦截（EBUSY），
# VS 自带的 4.3.1-msvc1 可正常被 cnoke 调用。
$cmakePath = $null
$vsCmake = 'D:\vs\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (Test-Path $vsCmake) { $cmakePath = $vsCmake }
else {
  $c = Get-ChildItem (Join-Path $env:USERPROFILE ".workbuddy\binaries\python\envs\default\Scripts\cmake.exe") -ErrorAction SilentlyContinue
  if ($c) { $cmakePath = $c.FullName }
  else { $c2 = Get-Command cmake -ErrorAction SilentlyContinue; if ($c2) { $cmakePath = $c2.Source } }
}
if (-not $cmakePath) { throw "找不到 cmake" }
Write-Output "  $cmakePath"

$env:INCLUDE = @(
  (Join-Path $msvcRoot 'include'),
  (Join-Path $kits "Include\$ver\ucrt"),
  (Join-Path $kits "Include\$ver\shared"),
  (Join-Path $kits "Include\$ver\um")
) -join ';'

# node.lib：链接 node addon 必需，但本机这版 Node 是精简分发，不自带。
# 来源：https://nodejs.org/dist/v<ver>/win-x64/node.lib
# node.lib 的本地存放目录：同样不写死作者家目录，可用 $env:ORB_MSVC_LIBS 覆盖
$nodeLibDir = if ($env:ORB_MSVC_LIBS) { $env:ORB_MSVC_LIBS }
              else { Join-Path $env:USERPROFILE ".workbuddy\msvc-libs" }
if (-not (Test-Path (Join-Path $nodeLibDir 'node.lib'))) {
  Write-Output "  警告：$nodeLibDir\node.lib 不存在，链接会报 LNK1181"
  Write-Output "        下载： https://nodejs.org/dist/v$((& node -v).TrimStart('v'))/win-x64/node.lib"
}
$env:LIB = @(
  $nodeLibDir,
  (Join-Path $msvcRoot 'lib\x64'),
  (Join-Path $kits "Lib\$ver\ucrt\x64"),
  (Join-Path $kits "Lib\$ver\um\x64")
) -join ';'

# SDK 的 bin 必须进 PATH：rc.exe / mt.exe 在这里。
# 漏了它会在链接阶段报 `RC Pass 1: command "rc ..." failed ... no such file or directory`，
# 而错误信息完全没提"找不到 rc.exe"，很容易误判。
$sdkBin = Join-Path $kits "bin\$ver\x64"
Write-Output "  SDK bin: $sdkBin"

# VS 自带的 ninja 也要放进 PATH：cnoke 探测到 ninja 才会用 Ninja 生成器，
# 否则退回 "MinGW Makefiles"（本机没有 MinGW）直接配置失败。
$ninjaDir = 'D:\vs\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja'
$ninjaPrefix = ''
if (Test-Path (Join-Path $ninjaDir 'ninja.exe')) {
  Write-Output "  ninja: $ninjaDir"
  $ninjaPrefix = "$ninjaDir;"
} else {
  Write-Output "  警告：找不到 VS 自带 ninja"
}

$env:PATH = "$($cl.Directory.FullName);$sdkBin;$(Split-Path -Parent $cmakePath);$ninjaPrefix" + $env:PATH

# 关键：强制指定 Ninja 生成器。
#   cnoke 在 Windows + 非 MinGW 工具链下**不推任何生成器**，交给 CMake 自己选；
#   而 CMake 找 Visual Studio 要靠注册表（本环境 reg.exe 被拦截），会失败；
#   同时上次失败留下的 CMakeCache.txt 会把生成器钉死在 "MinGW Makefiles"。
#   用 CMAKE_GENERATOR 环境变量显式指定最稳。
$env:CMAKE_GENERATOR = 'Ninja'
$env:CMAKE_MAKE_PROGRAM = Join-Path $ninjaDir 'ninja.exe'

# 清掉可能残留的脏缓存（生成器一旦被缓存钉死，后续所有配置都会沿用错的那个）
$buildDir = Join-Path $KOFFI 'build'
if (Test-Path $buildDir) {
  Write-Output "  清理旧构建目录: $buildDir"
  Remove-Item $buildDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Output ""
Write-Output "== 编译 koffi（源码构建，跳过 prebuild 下载）=="
Push-Location $KOFFI
try {
  # PowerShell 5.1 的坑：EAP=Stop 时，原生命令往 stderr 写的**警告**也会被当成
  # 致命错误抛出（CMake 的 dev warning 就走 stderr）。这里临时放宽，
  # 改用退出码判断成败。
  $ErrorActionPreference = 'Continue'
  & node ./cnoke.cjs -P . -D src/koffi --release 2>&1 | ForEach-Object { Write-Output ("  " + $_) }
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
} finally {
  Pop-Location
}
if ($code -ne 0) { throw "koffi 编译失败，退出码 $code" }

Write-Output ""
Write-Output "== 产物 =="
Get-ChildItem (Join-Path $KOFFI 'build') -Recurse -Filter '*.node' -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Output ("   " + $_.FullName + "  (" + [math]::Round($_.Length/1KB) + " KB)") }
