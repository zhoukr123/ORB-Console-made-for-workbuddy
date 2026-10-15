#Requires -Version 5.1
<#
.SYNOPSIS
  清理 ORB 控制台的旧构建产物。

.DESCRIPTION
  pack.cjs 的输出目录带时间戳、故意不删旧构建（批量删除会触发安全保护）。
  本脚本补上"手动清理"这一环：

    - 只扫描 dist\ 下的 ORB控制台-<版本>-<时间戳> 目录与同名 .zip，
      以及旧的 ORB控制台-便携版* 产物
    - **绝不动 dist\发布\**（那里放的是本次要交付的成品）
    - 默认保留最新 1 份，其余进**回收站**（可恢复，不是永久删除）
    - 删除前打印完整清单与体积，并要求输入 YES 才继续
    - 支持 -DryRun 只看不动

.PARAMETER Keep
  保留几份最新的构建。默认 1。

.PARAMETER DistDir
  构建产物目录。默认取脚本位置反推的 <仓库根>\dist（克隆仓库后直接可用）。

.PARAMETER DryRun
  只列清单，不删任何东西。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File clean-old-builds.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File clean-old-builds.ps1 -Keep 2
#>
[CmdletBinding()]
param(
    [int]$Keep = 1,
    [string]$DistDir = (Join-Path $PSScriptRoot '..\dist'),
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
# 故意不设 [Console]::OutputEncoding：中文 Windows 控制台代码页是 936(GBK)，
# 把它改成 UTF8 反而会让 Write-Host 吐出的中文在控制台里显示成乱码。
# 保持默认（跟随控制台代码页）才是对的。

if (-not (Test-Path -LiteralPath $DistDir)) {
    Write-Host "找不到构建目录：$DistDir"
    exit 1
}

# ---------- 收集候选 ----------
# 形如 ORB控制台-1.0.0-202610131640（目录） / 同名 .zip / ORB控制台-便携版*
$candidates = @()
foreach ($item in Get-ChildItem -LiteralPath $DistDir -Force) {
    if ($item.Name -eq '发布') { continue }              # 交付物，绝不碰
    if ($item.Name -notmatch '^ORB控制台-') { continue }
    if ($item.PSIsContainer) {
        $size = (Get-ChildItem -LiteralPath $item.FullName -Recurse -File -Force -ErrorAction SilentlyContinue |
                 Measure-Object -Property Length -Sum).Sum
    } else {
        $size = $item.Length
    }
    $candidates += [PSCustomObject]@{
        Name = $item.Name
        Path = $item.FullName
        IsDir = $item.PSIsContainer
        MB   = [math]::Round(($size / 1MB), 1)
        When = $item.LastWriteTime
    }
}

if ($candidates.Count -eq 0) {
    Write-Host "没有找到任何旧构建产物。"
    exit 0
}

# 新的在前
$sorted = $candidates | Sort-Object When -Descending
$keepSet = @{}
for ($i = 0; $i -lt [math]::Min($Keep, $sorted.Count); $i++) { $keepSet[$sorted[$i].Path] = $true }
$toDelete = @($sorted | Where-Object { -not $keepSet[$_.Path] })

Write-Host ""
Write-Host "========== 构建产物清单（$DistDir） =========="
$n = 0
foreach ($c in $sorted) {
    $n++
    $tag = if ($keepSet[$c.Path]) { '[保留]' } else { '[待删]' }
    $kind = if ($c.IsDir) { '目录' } else { '文件' }
    Write-Host ("{0,3}. {1} {2,-8} {3,8} MB  {4}" -f $n, $tag, $kind, $c.MB, $c.Name)
}

$freeMB = [math]::Round((($toDelete | Measure-Object -Property MB -Sum).Sum), 1)
Write-Host ""
Write-Host ("待删 {0} 项，合计 {1} MB；保留最新 {2} 份。" -f $toDelete.Count, $freeMB, $Keep)

if ($toDelete.Count -eq 0) {
    Write-Host "没有需要清理的东西。"
    exit 0
}

if ($DryRun) {
    Write-Host ""
    Write-Host "（-DryRun：以上只是预览，没有删除任何文件）"
    exit 0
}

# ---------- 确认 ----------
Write-Host ""
Write-Host "即将把上面标 [待删] 的项目移入**回收站**（可从回收站还原）。"
$ans = Read-Host "确认请输入 YES（其他任何输入都会取消）"
if ($ans -ne 'YES') {
    Write-Host "已取消，什么都没有动。"
    exit 0
}

# ---------- 执行：进回收站，不用永久删除 ----------
Add-Type -AssemblyName Microsoft.VisualBasic
$ok = 0
$fail = 0
foreach ($c in $toDelete) {
    try {
        if ($c.IsDir) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
                $c.Path,
                [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
                [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
        } else {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
                $c.Path,
                [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
                [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
        }
        Write-Host ("  已移入回收站：{0}  ({1} MB)" -f $c.Name, $c.MB)
        $ok++
    } catch {
        Write-Host ("  失败：{0}  — {1}" -f $c.Name, $_.Exception.Message)
        $fail++
    }
}

Write-Host ""
Write-Host ("完成：成功 {0} 项，失败 {1} 项，释放约 {2} MB。" -f $ok, $fail, $freeMB)
if ($fail -gt 0) { exit 1 }
exit 0
