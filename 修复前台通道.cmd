@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

rem ============================================================
rem  ORB 前台通道一键修复
rem ------------------------------------------------------------
rem  症状：控制台「前台」不可用（截图 / 点击 / 键盘 / Snapshot 全挂），
rem        面板状态里 windows-mcp 显示「连接失败」。
rem  原因：WorkBuddy 更新时会清理 ~/.workbuddy/binaries 下的旧环境，
rem        导致 windows-mcp.exe 连同 venv 一起消失。
rem  本脚本：检测 -> 重建 venv -> 安装 windows-mcp -> 验证，全程无需手动。
rem ============================================================

title ORB Front-Channel Repair

rem ---- 路径（C 盘路径是指向 D 盘的软链接，实际落盘在 D 盘）----
set "VENV=%USERPROFILE%\.workbuddy\binaries\python\envs\default"
set "PY=%VENV%\Scripts\python.exe"
set "MCP=%VENV%\Scripts\windows-mcp.exe"
set "BASE_PY=%USERPROFILE%\.workbuddy\binaries\python\versions\3.13.12\python.exe"

rem 阿里源实测可用；清华源对本 venv 返回 403，官方源走代理会 502
set "INDEX=https://mirrors.aliyun.com/pypi/simple"

echo.
echo ============================================================
echo   ORB 前台通道一键修复
echo ============================================================
echo.

rem ---- 1) 已经好了就别折腾 ----
if exist "%MCP%" (
  echo [1/4] 检测到 windows-mcp.exe 已存在：
  echo        %MCP%
  echo        尝试直接启动验证...
  goto :probe
) else (
  echo [1/4] 未找到 windows-mcp.exe，需要重装。
)

rem ---- 2) 基础 Python 是否存在 ----
if not exist "%BASE_PY%" (
  echo.
  echo [错误] 基础 Python 不存在：
  echo        %BASE_PY%
  echo.
  echo        这说明 WorkBuddy 的运行环境被整体清理过，
  echo        请在 WorkBuddy 里任意执行一次任务让它重建环境，再重新运行本脚本。
  echo.
  pause
  exit /b 1
)

rem ---- 3) 重建 venv ----
if not exist "%PY%" (
  echo [2/4] 重建虚拟环境...
  "%BASE_PY%" -m venv "%VENV%"
  if errorlevel 1 (
    echo [错误] 创建 venv 失败。
    pause
    exit /b 1
  )
  echo       venv 已创建。
) else (
  echo [2/4] 虚拟环境已存在，跳过创建。
)

rem ---- 4) 安装 windows-mcp ----
echo [3/4] 安装 / 更新 windows-mcp（源：阿里云）...
"%PY%" -m pip install --upgrade --no-cache-dir -i %INDEX% --proxy "" windows-mcp
if errorlevel 1 (
  echo.
  echo [警告] 阿里源失败，改用官方源重试...
  "%PY%" -m pip install --upgrade --no-cache-dir -i https://pypi.org/simple windows-mcp
  if errorlevel 1 (
    echo.
    echo [错误] 两个源都装不上，请检查网络后重试。
    pause
    exit /b 1
  )
)

:probe
rem ---- 5) 冒烟验证 ----
echo [4/4] 验证 windows-mcp 能否正常启动...
echo.

set "PROBE_TMP=%TEMP%\orb_probe_%RANDOM%.txt"
(
  echo {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"repair","version":"1"}}}
  echo {"jsonrpc":"2.0","method":"notifications/initialized"}
  echo {"jsonrpc":"2.0","id":2,"method":"tools/list"}
) > "%PROBE_TMP%"

"%MCP%" serve --transport stdio --exclude-tools Registry < "%PROBE_TMP%" > "%PROBE_TMP%.out" 2>&1
del "%PROBE_TMP%" >nul 2>&1

findstr /C:"\"tools\"" "%PROBE_TMP%.out" >nul 2>&1
if errorlevel 1 (
  echo [失败] windows-mcp 启动异常，输出如下：
  echo ------------------------------------------------------------
  type "%PROBE_TMP%.out"
  echo ------------------------------------------------------------
  del "%PROBE_TMP%.out" >nul 2>&1
  pause
  exit /b 1
)

del "%PROBE_TMP%.out" >nul 2>&1

echo.
echo ============================================================
echo   修复完成！
echo ============================================================
echo.
echo   windows-mcp  →  %MCP%
echo   真实落盘位置  →  %VENV%
echo.
echo   前台通道已就绪。如果控制台正在运行，请重启一次控制台
echo   让它重新连接（托盘图标 -> 退出，再双击「启动 ORB 控制台」）。
echo.
pause
exit /b 0
