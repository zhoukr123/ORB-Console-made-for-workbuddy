@echo off
rem ORB video-recording launcher: sets ORB_NO_PROTECT=1 so ORB's own windows
rem are NOT excluded from screen capture (panel / ball / record bar will show up).
rem Use the normal launcher after recording is done.
title ORB Rec Mode
set "ELECTRON_RUN_AS_NODE="
set "ORB_NO_PROTECT=1"
set "ORB_APP=%~dp0orb\desktop"
start "" "%ORB_APP%\node_modules\electron\dist\electron.exe" "%ORB_APP%"
echo   ORB started in RECORDING mode (content protection OFF).
