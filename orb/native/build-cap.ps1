# Compile orb-cap.exe (DXGI Desktop Duplication + Media Foundation H.264 -> MP4)
#
# Relationship to the other build scripts:
#   Independent entry point for orb-cap. It does NOT touch build.ps1,
#   build-foreground.ps1, build-selection.ps1 or build-sfx.ps1. All of them
#   share the same "auto-detect MSVC / hand-build INCLUDE+LIB" approach - the
#   reason is documented at the top of build.ps1: vcvars64.bat internally
#   shells out to reg.exe, which can be blocked in restricted environments,
#   leaving INCLUDE/LIB unset and causing C1083 "stdio.h not found". So we
#   never depend on the registry or vcvars.
#
# Usage: powershell -ExecutionPolicy Bypass -File orb\native\build-cap.ps1
#
# NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads a UTF-8 file
#   without BOM as ANSI(936); any Chinese comment would garble and break
#   parsing. C source comments may be Chinese (cl.exe /utf-8 handles it),
#   but the .ps1 must stay ASCII-only.
#
# Extra libs beyond build-selection.ps1:
#   d3d11 dxgi dxguid   - D3D11 device + DXGI output duplication
#   mfplat mfreadwrite mfuuid - Media Foundation startup / SinkWriter / H.264
#   ole32   - COM (CoInitializeEx, MFStartup)
#   user32 gdi32 shell32 - DPI awareness, CommandLineToArgvW (shell32)
# The source also carries #pragma comment(lib,...) for the same set; listing
# them here keeps the build self-documenting and works even if a pragma is
# removed by mistake.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src  = Join-Path $here 'src\orb-cap.c'
$dist = Join-Path $here 'dist'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist -Force | Out-Null }
$out  = Join-Path $dist 'orb-cap.exe'

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
& $cl.FullName /nologo /O2 /W3 /utf-8 /DUNICODE /D_UNICODE `
    "/Fo:$dist\" "/Fe:$out" $src `
    /link d3d11.lib dxgi.lib dxguid.lib mfplat.lib mfreadwrite.lib mfuuid.lib `
    ole32.lib user32.lib gdi32.lib shell32.lib
if ($LASTEXITCODE -ne 0) { throw "compile failed, exit code $LASTEXITCODE" }

if (-not (Test-Path $out)) { throw "output missing: $out" }
$size = (Get-Item $out).Length
Write-Output ""
Write-Output "== ok =="
Write-Output "   output: $out  ($size bytes)"

Write-Output ""
Write-Output "== self-check: --help (argument parsing works, no capture started) =="
& $out --help
if ($LASTEXITCODE -ne 0) { throw "--help self-check failed, exit code $LASTEXITCODE" }
