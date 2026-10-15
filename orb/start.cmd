@echo off
chcp 65001 > nul
title Orb 控制台

rem 宿主环境若带 ELECTRON_RUN_AS_NODE，Electron 会退化成纯 Node 运行，必须清掉
set "ELECTRON_RUN_AS_NODE="

rem 热启动（常驻 daemon）开关：统一在 orb/bridge.conf 的 "daemon" 字段控制（true/false），
rem 改完重启 ORB 即生效，且不受本文件影响（用 .lnk 直接启动也生效）。
rem 想在这里强制覆盖 bridge.conf，可取消下面这行注释：
rem set "ORB_WB_DAEMON=1"

cd /d "%~dp0desktop"
start "" "%~dp0desktop\node_modules\electron\dist\electron.exe" "%~dp0desktop"

echo.
echo   Orb 控制台已启动
echo   - 悬浮球在屏幕右侧，点击展开面板
echo   - Ctrl+Space 唤起 / 收起面板
echo   - Ctrl+Alt+G 把剪贴板文字送进输入框
echo   - 托盘图标可退出
echo.
