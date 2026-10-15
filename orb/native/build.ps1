# 编译 orb-input.exe
#
# 为什么不直接调 vcvars64.bat：
#   vcvars 内部要用 reg.exe 去注册表里找 VS/SDK 的位置。在受限环境里
#   reg.exe 可能被安全策略拦掉，导致 INCLUDE/LIB 根本没设上，
#   编译立刻报 C1083 找不到 stdio.h —— 这个坑踩过一次。
#   所以这里直接自动探测路径并手工拼环境变量，不依赖注册表。
#
# 用法： powershell -ExecutionPolicy Bypass -File native\build.ps1
#
# 注意：本文件必须保存为「带 BOM 的 UTF-8」。
#   Windows PowerShell 5.1 用 -File 执行时会按 ANSI(936) 读无 BOM 的
#   UTF-8 文件，中文注释和字符串会乱码并直接导致语法错误。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'src\orb-input.c'
$dist = Join-Path $here 'dist'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
$out  = Join-Path $dist 'orb-input.exe'

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

# 注意：可能同时存在多个 Windows Kits 目录，其中有些是空壳
# （只有 Bootstrapper，没有 Include）。不能只取第一个，
# 要挑真正含 Include 版本目录的那个。
$kits = $null
$ver = $null
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

if (Test-Path $out) {
  $size = (Get-Item $out).Length
  Write-Output ""
  Write-Output "== 成功 =="
  Write-Output "   产物: $out  ($size 字节)"
  Write-Output ""
  Write-Output "== 自检 =="
  & $out cursor
} else {
  throw "未生成 $out"
}
