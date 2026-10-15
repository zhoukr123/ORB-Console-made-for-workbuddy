# Compile orb-selection.exe
#
# Relationship to build-foreground.ps1:
#   Independent entry point for orb-selection. It does NOT touch build.ps1
#   or build-foreground.ps1. All three share the same "auto-detect MSVC /
#   hand-build INCLUDE+LIB" approach - reason documented at the top of
#   build.ps1: vcvars64.bat internally shells out to reg.exe, which can be
#   blocked in restricted environments, leaving INCLUDE/LIB unset and causing
#   C1083 "stdio.h not found". So we never depend on the registry or vcvars.
#
# Usage: powershell -ExecutionPolicy Bypass -File native\build-selection.ps1
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads a UTF-8 file
#   without BOM as ANSI(936); any Chinese comment would garble and break
#   parsing. C source comments may be Chinese (cl.exe /utf-8 handles it),
#   but the .ps1 must stay ASCII-only.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'src\orb-selection.c'
$dist = Join-Path $here 'dist'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
$out  = Join-Path $dist 'orb-selection.exe'

if (-not (Test-Path $src)) { throw "source not found: $src" }

Write-Output "== detect MSVC =="
$clCandidates = @()
foreach ($root in @('D:\vs', 'C:\Program Files\Microsoft Visual Studio', 'C:\Program Files (x86)\Microsoft Visual Studio')) {
  if (-not (Test-Path $root)) { continue }
  $found = Get-ChildItem -LiteralPath $root -Filter 'cl.exe' -Recurse -File -Force -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -match '\\Hostx64\\x64\\cl\.exe$' }
  if ($found) { $clCandidates += $found }
}
if (-not $clCandidates) { throw "cl.exe (Hostx64\x64) not found" }

$cl = $clCandidates | Sort-Object { $_.Directory.Parent.Parent.Parent.Name } | Select-Object -Last 1
$msvcRoot = $cl.Directory.Parent.Parent.Parent.FullName     # ...\VC\Tools\MSVC\<ver>
Write-Output "   cl   : $($cl.FullName)"
Write-Output "   MSVC : $msvcRoot"

Write-Output ""
Write-Output "== detect Windows SDK =="
$kitsCandidates = @(
  'C:\Program Files (x86)\Windows Kits\10',
  'D:\Windows Kits\10',
  'C:\Program Files\Windows Kits\10'
) | Where-Object { Test-Path $_ }

# Same as build.ps1: several Windows Kits dirs may exist, some of them are
# Bootstrapper-only shells. Pick the one that really has Include/Lib.
$kits = $null
$ver  = $null
foreach ($k in $kitsCandidates) {
  $v = (Get-ChildItem (Join-Path $k 'Include') -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name | Select-Object -Last 1).Name
  if ($v -and (Test-Path (Join-Path $k "Lib\$v"))) { $kits = $k; $ver = $v; break }
}
if (-not $kits) { throw "no Windows Kits with Include/Lib under: $($kitsCandidates -join ', ')" }
Write-Output "   Kits : $kits  (version $ver)"

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
  if (-not (Test-Path $d)) { throw "missing directory: $d" }
}

$env:INCLUDE = ($incDirs -join ';')
$env:LIB     = ($libDirs -join ';')
$env:PATH    = "$($cl.Directory.FullName);" + $env:PATH

Write-Output ""
Write-Output "== compile =="
# Extra libs beyond build-foreground.ps1: ole32 (COM), oleaut32 (BSTR:
# SysStringLen/SysFreeString), uuid (CLSID/IID), uiautomationcore (UIA).
# #pragma comment(lib,...) in the source also covers these; listing them
# here keeps the build self-documenting.
& $cl.FullName /nologo /O2 /W3 /utf-8 /DUNICODE /D_UNICODE `
    "/Fo:$dist\" "/Fe:$out" $src /link ole32.lib oleaut32.lib uuid.lib uiautomationcore.lib user32.lib
if ($LASTEXITCODE -ne 0) { throw "compile failed, exit code $LASTEXITCODE" }

if (-not (Test-Path $out)) { throw "output missing: $out" }
$size = (Get-Item $out).Length
Write-Output ""
Write-Output "== ok =="
Write-Output "   output: $out  ($size bytes)"

Write-Output ""
Write-Output "== self-check: --sel (reads the current selection) =="
Write-Output "   (focus a text editor, select some text, then check the line below)"
& $out --sel
if ($LASTEXITCODE -ne 0) { throw "--sel self-check failed, exit code $LASTEXITCODE" }
