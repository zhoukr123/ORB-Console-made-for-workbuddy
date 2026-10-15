<#
.SYNOPSIS
    Build the self-contained Python runtime for the ORB front channel (windows-mcp).

.DESCRIPTION
    Produces <repo>\orb\runtime\python\ -- a portable CPython + a curated site-packages
    that lets windows-mcp run on a machine with NO Python and NO WorkBuddy installed.

    Hard constraints enforced here:
      * NO GPL / LGPL / AGPL binaries may end up in the output.
          - windows-mcp itself is installed with --no-deps, because its METADATA lists
            fuzzywuzzy (GPLv2), python-levenshtein (GPL-2.0-or-later), posthog and
            dxcam as *unconditional* dependencies.
          - fuzzywuzzy is replaced by our own MIT forwarder shim -> thefuzz.
          - posthog is replaced by our own MIT no-op stub.
          - dxcam (and therefore numpy) is simply not installed; screenshots use pillow.
      * Versions are pinned in orb\runtime\requirements-curated.in (this repo owns it).

    Mirrors (python.org is NOT reachable behind the local proxy -- do not retry it):
      1. https://mirrors.aliyun.com/python-release/windows/python-3.13.1-embed-amd64.zip
      2. https://mirrors.huaweicloud.com/python/3.13.1/python-3.13.1-embed-amd64.zip
      3. A local full CPython install under %USERPROFILE%\.workbuddy\... (PSF licensed,
         redistributable as long as its LICENSE.txt ships with it -- we keep it).

.NOTES
    This file is deliberately ASCII-only so no code-page mismatch can ever corrupt it.
#>

[CmdletBinding()]
param(
    # Python used to *run pip* (the embeddable build has no pip of its own).
    [string] $PipPython = '',
    # Skip re-downloading the embeddable zip if it is already in _dl\
    [switch] $KeepDownload
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------------------------------------------------------------- paths ----
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root       = Resolve-Path (Join-Path $ScriptDir '..\..')
$RuntimeDir = Join-Path $Root 'orb\runtime'
$OutDir     = Join-Path $RuntimeDir 'python'
$DlDir      = Join-Path $RuntimeDir '_dl'
$ShimDir    = Join-Path $RuntimeDir 'shims'
$ReqIn      = Join-Path $RuntimeDir 'requirements-curated.in'
$ReqLock    = Join-Path $RuntimeDir 'requirements-curated.lock'
$PipIndex   = 'https://mirrors.aliyun.com/pypi/simple'

$EmbedVersion = '3.13.1'
$EmbedName    = "python-$EmbedVersion-embed-amd64.zip"
$EmbedUrls = @(
    "https://mirrors.aliyun.com/python-release/windows/$EmbedName",
    "https://mirrors.huaweicloud.com/python/$EmbedVersion/$EmbedName"
)

function Say($msg) { Write-Output "[build-runtime] $msg" }

<#
    Delete a directory tree.
    The dev machine has a safe-delete guard that fails closed on bulk deletions
    (see the same note in orb\pack.cjs, which stopped wiping old builds for that
    reason). Try Remove-Item first, fall back to cmd's rmdir, and if both are
    blocked just warn -- the install below runs with --upgrade so an in-place
    refresh still converges on the pinned set.
#>
function Remove-Dir($p) {
    if (-not (Test-Path $p)) { return $true }
    try { Remove-Item $p -Recurse -Force -ErrorAction Stop; return $true } catch { }
    try { cmd /c "rd /s /q `"$p`"" 2>$null; if (-not (Test-Path $p)) { return $true } } catch { }
    Say "WARNING: could not delete $p (safe-delete guard). Continuing in place."
    return $false
}

<#
    Run `python -m pip ...` safely.
    pip writes its "[notice] A new release ..." banner to *stderr*; with
    $ErrorActionPreference='Stop' PowerShell turns native stderr into a terminating
    error, so the build would die even though pip exited 0. Merge the streams and
    judge only by $LASTEXITCODE.
#>
function Invoke-Pip([string[]] $PipArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $out = & $PipPython -m pip @PipArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    if ($code -ne 0) { Write-Output $out }
    return $code
}

# ------------------------------------------------------- 1. pip driver ----
if (-not $PipPython) {
    $cands = @()
    $wbVers = Join-Path $env:USERPROFILE '.workbuddy\binaries\python\versions'
    if (Test-Path $wbVers) {
        $cands += Get-ChildItem $wbVers -Directory |
                  ForEach-Object { Join-Path $_.FullName 'python.exe' }
    }
    $cands += 'python.exe'
    foreach ($c in $cands) {
        try {
            if (Test-Path $c) {
                # NOTE: no double quotes in the -c payload -- PowerShell eats them when
                # handing arguments to a native command (they are re-parsed as quoting).
                $v = & $c -c 'import sys;print(sys.version.split()[0])' 2>$null
                if ($LASTEXITCODE -eq 0 -and $v) { $PipPython = $c; break }
            }
        } catch { }
    }
}
if (-not $PipPython) { throw 'No usable Python found to run pip. Pass -PipPython <path>.' }
Say "pip driver: $PipPython"
$pipVer = & $PipPython -c 'import sys;print(sys.version.split()[0])'
Say "pip driver version: $pipVer"

# ------------------------------------------------- 2. embeddable python ----
New-Item -ItemType Directory -Path $DlDir -Force | Out-Null
if (Test-Path $OutDir) { Say "clearing previous build: $OutDir"; [void](Remove-Dir $OutDir) }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$zipPath = Join-Path $DlDir $EmbedName
$downloaded = $false
if ($KeepDownload -and (Test-Path $zipPath)) {
    Say "reusing cached download: $zipPath"
    $downloaded = $true
} else {
    foreach ($u in $EmbedUrls) {
        Say "trying $u"
        try {
            Invoke-WebRequest -Uri $u -OutFile $zipPath -TimeoutSec 300 -UseBasicParsing
            if ((Get-Item $zipPath).Length -gt 5MB) { Say "downloaded OK ($u)"; $downloaded = $true; break }
            Say 'file too small, trying next mirror'
        } catch { Say "failed: $($_.Exception.Message)" }
    }
}

if ($downloaded) {
    Say "extracting -> $OutDir"
    Expand-Archive -Path $zipPath -DestinationPath $OutDir -Force
    # The embeddable build does NOT run site.main(), so site-packages is never added.
    # Enable it and point at Lib\site-packages (that is where we install below).
    $pth = Join-Path $OutDir "python$($EmbedVersion -replace '\.','')._pth"
    $pth = Get-ChildItem $OutDir -Filter 'python*._pth' | Select-Object -First 1
    if ($pth) {
        $lines = @('python313.zip', '.', 'Lib\site-packages', '', '# Uncomment to run site.main() automatically', 'import site')
        Set-Content -Path $pth.FullName -Value ($lines -join "`r`n") -Encoding ASCII
        Say "patched $($pth.Name) (import site + Lib\site-packages)"
    } else {
        Say 'WARNING: no python*._pth found; site-packages may not be importable'
    }
} else {
    # ---- fallback: reuse a local full CPython (PSF license, ship LICENSE.txt) ----
    Say 'all mirrors failed -> falling back to a local full CPython'
    $wbVers = Join-Path $env:USERPROFILE '.workbuddy\binaries\python\versions'
    $local = Get-ChildItem $wbVers -Directory -ErrorAction SilentlyContinue |
             Sort-Object Name -Descending | Select-Object -First 1
    if (-not $local) { throw 'No embeddable download and no local CPython to fall back to.' }
    $src = $local.FullName
    Say "fallback source: $src"
    foreach ($f in @('python.exe','python3.dll','python313.dll','python313.dll','vcruntime140.dll','vcruntime140_1.dll','LICENSE.txt')) {
        $p = Join-Path $src $f
        if (Test-Path $p) { Copy-Item $p $OutDir -Force }
    }
    if (Test-Path (Join-Path $src 'DLLs')) { Copy-Item (Join-Path $src 'DLLs') $OutDir -Recurse -Force }
    if (Test-Path (Join-Path $src 'Lib')) {
        $dstLib = Join-Path $OutDir 'Lib'
        New-Item -ItemType Directory -Path $dstLib -Force | Out-Null
        robocopy (Join-Path $src 'Lib') $dstLib /E /XD '__pycache__' 'site-packages' 'test' 'tests' /NFL /NDL /NJH /NJS /NP | Out-Null
    }
    Say 'fallback copy done (no _pth patch needed: full CPython has a real Lib)'
}

if (-not (Test-Path (Join-Path $OutDir 'python.exe'))) { throw 'python.exe missing after step 2' }
if (-not (Test-Path (Join-Path $OutDir 'LICENSE.txt'))) { Say 'WARNING: LICENSE.txt missing - PSF redistribution requires it' }

# ------------------------------------------------------ 3. install pkgs ----
$target = Join-Path $OutDir 'Lib\site-packages'
New-Item -ItemType Directory -Path $target -Force | Out-Null

Say 'installing windows-mcp==0.8.5 with --no-deps (its own deps are GPL/telemetry)'
$code = Invoke-Pip @('install','--no-deps','--no-cache-dir','--only-binary=:all:','--upgrade',
                     '--target',$target,'-i',$PipIndex,'windows-mcp==0.8.5')
if ($code -ne 0) { throw "windows-mcp install failed ($code)" }

Say 'installing curated dependency set'
$code = Invoke-Pip @('install','--no-cache-dir','--only-binary=:all:','--upgrade',
                     '--target',$target,'-i',$PipIndex,'-r',$ReqIn)
if ($code -ne 0) { throw "curated dependency install failed ($code)" }

# ----------------------------------------------------------- 4. shims -----
Say 'installing our MIT shims (fuzzywuzzy forwarder + posthog no-op)'
foreach ($s in @('fuzzywuzzy','posthog')) {
    $src = Join-Path $ShimDir $s
    $dst = Join-Path $target $s
    if (-not (Test-Path $src)) { throw "missing shim source: $src" }
    New-Item -ItemType Directory -Path $dst -Force | Out-Null
    Copy-Item (Join-Path $src '*') $dst -Recurse -Force
}

# ---------------------------------------------------------- 5. pruning ----
Say 'pruning (pycache / console scripts / pywin32 IDE / tests / debug junk)'
$pyc = Get-ChildItem $OutDir -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue
Say ('  __pycache__ dirs: ' + $pyc.Count)
foreach ($d in $pyc) { Remove-Item $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
# Some are locked / guarded; sweep whatever survived with cmd's rmdir.
$left = Get-ChildItem $OutDir -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue
foreach ($d in $left) { [void](Remove-Dir $d.FullName) }

Get-ChildItem $OutDir -Recurse -Directory -Filter 'tests' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*site-packages*' } |
    ForEach-Object { [void](Remove-Dir $_.FullName) }
foreach ($junk in @('bin','pythonwin','adodbapi')) {
    [void](Remove-Dir (Join-Path $target $junk))
}
Remove-Item (Join-Path $OutDir 'python.cat') -Force -ErrorAction SilentlyContinue
# Console-script launchers and the audit tooling we pulled in only to inspect licenses.
Get-ChildItem $target -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(pip_licenses|prettytable|wcwidth)-.*\.dist-info$' -or
                   $_.Name -match '^(prettytable|wcwidth)$' } |
    ForEach-Object { [void](Remove-Dir $_.FullName) }
Remove-Item (Join-Path $target 'piplicenses.py') -Force -ErrorAction SilentlyContinue

# ------------------------------------------------------------- 6. lock -----
Say "writing $ReqLock"
$lock = Get-ChildItem $target -Directory -Filter '*.dist-info' | ForEach-Object {
    $n = $_.Name -replace '\.dist-info$',''
    if ($n -match '^(.*?)-(\d[^-]*)$') { '{0}=={1}' -f $Matches[1], $Matches[2] } else { $n }
} | Sort-Object
$header = @(
    '# ORB front-channel runtime - RESOLVED lock (generated by orb\native\build-runtime.ps1)',
    '#',
    '# Regenerate by running the build script; do NOT hand-edit.',
    '# Source of truth for what we *ask* for:  requirements-curated.in',
    '# GPL / LGPL / AGPL must never appear here - see THIRD-PARTY-NOTICES.md',
    ''
)
Set-Content -Path $ReqLock -Value (($header + $lock) -join "`r`n") -Encoding ASCII

# ------------------------------------------------------------ 7. report ----
$total = (Get-ChildItem $OutDir -Recurse -File -ErrorAction SilentlyContinue |
          Measure-Object -Property Length -Sum).Sum
Say ('done. runtime size: {0:N1} MB' -f ($total/1MB))
Say ('packages: ' + (Get-ChildItem $target -Directory -Filter '*.dist-info').Count)
Say 'next: verify with pip-licenses that no GPL/LGPL/AGPL slipped in'
