@echo off
chcp 65001 >nul
title ORB 控制台 · 全量删除
setlocal

rem ===================================================================
rem  ORB 控制台 · 全量删除
rem
rem  删三处：
rem    [1] %APPDATA%\ORB 控制台        数据目录（历史会话/工作流/配置/头像/日志）
rem    [2] %LOCALAPPDATA%\ORBConsole   解压出来的程序运行目录（约 500 MB）
rem    [3] %TEMP%\orb-sfx-*.zip       上次解压失败残留的临时压缩包
rem
rem  不删：你下载的「便携版 exe / 便携目录 zip」本体 —— 脚本不知道你放哪，自己删。
rem
rem  ⚠ 两个实现要点，改这个文件前先看：
rem  ① 自我搬迁：本脚本通常就躺在 [2] 那个目录里，直接删会把自己删到一半中断，
rem     所以先复制到 %TEMP% 再重开一次（下面第一段）。
rem  ② 只杀 "ORB 控制台.exe"（pack.cjs 把 electron.exe 改名后的专名）。
rem     **绝不要** taskkill electron.exe —— 那是通配名，会把 WorkBuddy、
rem     VS Code 等所有 Electron 应用一起杀掉。
rem  ③ 本机回收站 API 不可用（Add-Type 被安全策略拦），只能直接删除，
rem     所以删除不可恢复 —— 必须让用户显式输入 DELETE 才动手。
rem ===================================================================

rem ---- ① 自我搬迁 ----
echo "%~dp0" | find /i "%LOCALAPPDATA%\ORBConsole" >nul
if not errorlevel 1 (
  copy /y "%~f0" "%TEMP%\ORB_Uninstall.cmd" >nul 2>&1
  if exist "%TEMP%\ORB_Uninstall.cmd" (
    start "" /wait cmd /c "%TEMP%\ORB_Uninstall.cmd"
    del /f /q "%TEMP%\ORB_Uninstall.cmd" >nul 2>&1
    exit /b
  )
)

echo.
echo   ==========================================================
echo     ORB 控制台 · 全量删除
echo   ==========================================================
echo.
echo    本操作会**永久删除**以下内容（不可恢复，不进回收站）：
echo.
echo      [1] 数据目录 —— 历史会话 / 工作流 / 配置 / 头像 / 日志
echo          %APPDATA%\ORB 控制台
echo      [2] 解压出来的程序运行目录（约 500 MB）
echo          %LOCALAPPDATA%\ORBConsole
echo      [3] 上次解压失败残留的临时压缩包
echo          %TEMP%\orb-sfx-*.zip
echo.
echo    不会删：你下载的便携版 exe / zip 本体（不知道你放在哪，请自己删）。
echo    开发态源码目录也不在本脚本的删除范围内。
echo.

echo    正在结束正在运行的 ORB 控制台（否则文件被占用删不掉）...
taskkill /f /im "ORB 控制台.exe" >nul 2>&1
timeout /t 1 >nul 2>&1

echo.
echo    当前状态：
call :show "%APPDATA%\ORB 控制台"
call :show "%LOCALAPPDATA%\ORBConsole"
echo.
set "ANS="
set /p "ANS=    确认全量删除？请输入 DELETE 后回车（直接回车 = 取消）："
if /i not "%ANS%"=="DELETE" (
  echo.
  echo    已取消，没有删除任何东西。
  echo.
  pause
  exit /b 0
)

echo.
echo    开始删除...
call :del "%APPDATA%\ORB 控制台"
call :del "%LOCALAPPDATA%\ORBConsole"
del /f /q "%TEMP%\orb-sfx-*.zip" >nul 2>&1
echo      [3] 临时压缩包：已清理（本来没有就是没有）
echo.
echo   ==========================================================
echo     完成。ORB 控制台已从这台机器移除。
echo   ==========================================================
echo.
pause
exit /b 0

:show
if exist "%~1" (echo       [存在]   %~1) else (echo       [不存在] %~1)
exit /b 0

:del
if exist "%~1" (
  rmdir /s /q "%~1" >nul 2>&1
  if exist "%~1" (
    echo       [失败]   %~1
    echo                仍有进程占用它；关掉 ORB 后台（含热启动 daemon）后重跑本脚本。
  ) else (
    echo       [已删除] %~1
  )
) else (
  echo       [跳过]   %~1 （本来就不存在）
)
exit /b 0
