# Orb 划词监听器
#
# 常驻进程，做两件事：
#   1. 注册 UIA 事件订阅 —— 让 UiaClientsAreListening 为真，Chromium/Edge
#      才会开启无障碍树。不注册的话读不到网页选中文字。
#   2. 轮询鼠标左键，检测「按下 -> 抬起且拖动距离 > 8px」，判定为拖拽划选。
#
# 命中拖拽后立刻用 UI Automation 读焦点元素的 TextPattern 选区：
#   - 读到文字 -> 输出 {"type":"select",...,"text":"..."}  （不碰剪贴板）
#   - 读不到   -> 输出 {"type":"select",...,"text":null}   （由主进程走剪贴板降级）
#
# 标准输出为按行 JSON，使用 stdout 的 UTF-8 编码，主进程逐行解析。

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Namespace OrbW -Name Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
"@

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

# --- 1. 激活无障碍树 ---
try {
  $global:orbFocusHandler = [System.Windows.Automation.AutomationFocusChangedEventHandler]{
    param($sender, $e)
  }
  [System.Windows.Automation.Automation]::AddAutomationFocusChangedEventHandler($global:orbFocusHandler)
} catch { }

function Get-JsonString([string]$s) {
  if ($null -eq $s) { return 'null' }
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $s.ToCharArray()) {
    switch ($ch) {
      '"'  { [void]$sb.Append('\"') }
      '\'  { [void]$sb.Append('\\') }
      "`n" { [void]$sb.Append('\n') }
      "`r" { [void]$sb.Append('\r') }
      "`t" { [void]$sb.Append('\t') }
      default {
        if ([int]$ch -lt 32) { [void]$sb.Append(('\u{0:x4}' -f [int]$ch)) }
        else { [void]$sb.Append($ch) }
      }
    }
  }
  return '"' + $sb.ToString() + '"'
}

function Read-UiaSelection {
  # 焦点元素优先。这正是之前用 FindFirst(Descendants) 踩坑的地方：
  # 那种写法会命中页面里第一个带 TextPattern 的元素，而不是真正持有选区的那个。
  $targets = New-Object System.Collections.ArrayList
  try {
    $f = $AE::FocusedElement
    if ($null -ne $f) { [void]$targets.Add($f) }
  } catch { }

  foreach ($el in $targets) {
    try {
      $pat = $null
      if (-not $el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pat)) { continue }
      $text = ''
      $segs = $pat.GetSelection()
      foreach ($s in $segs) { $text += $s.GetText(-1) }
      $text = $text.Trim()
      if ($text.Length -gt 0) { return $text }
    } catch { }
  }
  return $null
}

function Get-FgClass {
  # 前台窗口类名 —— 主进程用它判断要不要走 Ctrl+C 降级（终端里 Ctrl+C 会中断命令）。
  # 放在常驻进程里算，免去主进程每次另起 PowerShell 的 2~3 秒开销。
  try {
    $h = [OrbW.Native]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 256
    [void][OrbW.Native]::GetClassName($h, $sb, 256)
    return $sb.ToString()
  } catch { return '' }
}

$leftDown = $false
$downX = 0
$downY = 0
$lastEmitText = ''
$lastEmitAt = [DateTime]::MinValue
$debug = $env:ORB_WATCH_DEBUG -eq '1'

$pt = New-Object OrbW.Native+POINT

# 注意：长驻进程不能用 Write-Output（走管道会被缓冲，父进程读不到）。
# 必须直接写 Console 输出流并立即 Flush。
function Emit([string]$line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

while ($true) {
  try {
    $pressed = (([OrbW.Native]::GetAsyncKeyState(0x01)) -band 0x8000) -ne 0
    [void][OrbW.Native]::GetCursorPos([ref]$pt)

    if ($pressed -and -not $leftDown) {
      $leftDown = $true
      $downX = $pt.X
      $downY = $pt.Y
      if ($debug) { Emit ('{"type":"debug","event":"down","x":' + $pt.X + ',"y":' + $pt.Y + '}') }
    }
    elseif (-not $pressed -and $leftDown) {
      $leftDown = $false
      $dx = $pt.X - $downX
      $dy = $pt.Y - $downY
      $dist = [Math]::Sqrt([double]($dx * $dx + $dy * $dy))
      if ($debug) { Emit ('{"type":"debug","event":"up","dist":' + [Math]::Round($dist, 1) + '}') }

      if ($dist -gt 8) {
        Start-Sleep -Milliseconds 180   # 等选区在目标应用里落定
        $text = Read-UiaSelection
        $cls = Get-FgClass
        $now = [DateTime]::UtcNow
        if ($null -ne $text -and $text.Length -gt 0) {
          if ($text -ne $lastEmitText -or ($now - $lastEmitAt).TotalMilliseconds -gt 4000) {
            $lastEmitText = $text
            $lastEmitAt = $now
            Emit ('{"type":"select","x":' + $pt.X + ',"y":' + $pt.Y + ',"cls":' + (Get-JsonString $cls) + ',"text":' + (Get-JsonString $text) + '}')
          }
        } else {
          $lastEmitAt = $now
          Emit ('{"type":"select","x":' + $pt.X + ',"y":' + $pt.Y + ',"cls":' + (Get-JsonString $cls) + ',"text":null}')
        }
      }
    }
  } catch {
    if ($debug) { Emit ('{"type":"debug","event":"error","msg":' + (Get-JsonString $_.Exception.Message) + '}') }
  }

  Start-Sleep -Milliseconds 60
}
