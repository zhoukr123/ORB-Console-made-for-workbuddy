@echo off
title ORB Console
rem Clear ELECTRON_RUN_AS_NODE so Electron does not degrade to plain Node.
set "ELECTRON_RUN_AS_NODE="
rem Hot-start (resident daemon) switch is controlled by orb\bridge.conf "daemon"
rem and can also be toggled live from the console status bar. Do not override here.
rem Single base var + absolute paths (no cd) to avoid relative-path pitfalls.
set "ORB_APP=%~dp0orb\desktop"

rem ASR（本地 Whisper）不再由本脚本启动，改由 bridge 统一管。
rem 原实现是先 netstat 查 19876 再决定起不起，和 bridge 的孤儿回收打架：
rem   旧服务还活着 -> 这里跳过启动 -> bridge 紧接着把它当孤儿杀掉 -> 新的没人拉，
rem   设置面板于是永远显示"服务未运行"。现在规则只有一条（见 bridge.mjs
rem   server.listen 回调）：asr.conf 存在就拉起来，不存在就保持懒加载。

start "" "%ORB_APP%\node_modules\electron\dist\electron.exe" "%ORB_APP%"

echo.
echo   ORB Console launched (root: %~dp0).
echo   - Floating ball on the right; click to expand the panel.
echo   - Ctrl+Space toggle panel; tray icon to quit.
echo.
