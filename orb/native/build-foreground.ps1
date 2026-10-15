# 编译 orb-foreground.exe
#
# 与 build.ps1 的关系：
#   本脚本是 orb-foreground 的独立构建入口，**完全没有改动 build.ps1**。
#   两者共用同一套「自动探测 MSVC / 手工拼 INCLUDE+LIB」的做法 ——
#   原因 build.ps1 顶部已经写清楚了：vcvars64.bat 内部要用 reg.exe 查注册表，
#   受限环境里 reg.exe 可能被拦，INCLUDE/LIB 设不上就直接 C1083 找不到 stdio.h。
#   这里照抄那份探测逻辑，不依赖注册表，也不依赖 vcvars。
#
# 用法： powershell -ExecutionPolicy Bypass -File native\build-foreground.ps1
#
# 注意：本文件必须保存为「带 BOM 的 UTF-8」，原因与 build.ps1 相同 ——
#   Windows PowerShell 5.1 用 -File 执行时按 ANSI(936) 读无 BOM 的 UTF-8，
#   中文注释会乱码并直接导致语法错误。改动本文件后请确认 BOM 还在。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'src\orb-foreground.c'
$dist = Join-Path $here 'dist'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
$out  = Join-Path $dist 'orb-foreground.exe'

if (-not (Test-Path $src)) { throw "找不到源文件: $src" }

Write-Output "== 探测 MSVC =="
$clCandidates = @()
foreach ($root in @('D:\vs', 'C:\Program Files\Microsoft Visual Studio', 'C:\Program Files (x86)\Microsoft Visual Studio')) {
  if (-not (Test-Path $root)) { continue }
  $found = Get-ChildItem -LiteralPath $root -Filter 'cl.exe' -Recurse -File -Force -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -match '\\Hostx64\\x64\\cl\.exe$' }
  if ($found) { $clCandidates += $found }
}
if (-not $clCandidates) { throw "找不到 cl.exe（Hostx64\x64）" }

$cl = $clCandidates | Sort-Object { $_.Directory.Parent.Parent.Parent.Name } | Select-Object -Last 1
$msvcRoot = $cl.Directory.Parent.Parent.Parent.FullName     # ...\VC\Tools\MSVC\<ver>
Write-Output "   cl   : $($cl.FullName)"
Write-Output "   MSVC : $msvcRoot"

Write-Output ""
Write-Output "== 探测 Windows SDK =="
$kitsCandidates = @(
  'C:\Program Files (x86)\Windows Kits\10',
  'D:\Windows Kits\10',
  'C:\Program Files\Windows Kits\10'
) | Where-Object { Test-Path $_ }

# 同 build.ps1：可能有多个 Windows Kits 目录，其中一些是只有 Bootstrapper 的空壳，
# 必须挑真正含 Include/Lib 版本目录的那个。
$kits = $null
$ver  = $null
foreach ($k in $kitsCandidates) {
  $v = (Get-ChildItem (Join-Path $k 'Include') -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name | Select-Object -Last 1).Name
  if ($v -and (Test-Path (Join-Path $k "Lib\$v"))) { $kits = $k; $ver = $v; break }
}
if (-not $kits) { throw "在所有候选路径下都找不到带 Include/Lib 的 Windows Kits：$($kitsCandidates -join ', ')" }
Write-Output "   Kits : $kits  (版本 $ver)"

$incDirs = @(
  (Join-Path $msvcRoot 'include'),
  (Join-Path $kits "Include\$ver\ucrt"),
  (Join-Path $kits "Include\$ver\shared"),
  (Join-Path $kits "Include\$ver\um")
)
$libDirs = @(
  (Join-Path $msvcRoot 'lib\x64'),
  (Join-Path $kits "Lib\$ver\ucrt\x64"),
  (Join-Path $kits "Lib\$ver\um\x64")
)
foreach ($d in ($incDirs + $libDirs)) {
  if (-not (Test-Path $d)) { throw "缺少必要目录: $d" }
}

$env:INCLUDE = ($incDirs -join ';')
$env:LIB     = ($libDirs -join ';')
$env:PATH    = "$($cl.Directory.FullName);" + $env:PATH

Write-Output ""
Write-Output "== 编译 =="
& $cl.FullName /nologo /O2 /W3 /utf-8 /DUNICODE /D_UNICODE `
    "/Fo:$dist\" "/Fe:$out" $src /link user32.lib
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码 $LASTEXITCODE" }

if (-not (Test-Path $out)) { throw "未生成 $out" }
$size = (Get-Item $out).Length
Write-Output ""
Write-Output "== 成功 =="
Write-Output "   产物: $out  ($size 字节)"

Write-Output ""
Write-Output "== 自检：一次性模式取前台窗口 =="
& $out
if ($LASTEXITCODE -ne 0) { throw "一次性模式自检失败，退出码 $LASTEXITCODE" }
