@echo off
title ORB 语音识别服务（本地 Whisper）
echo 正在启动本地离线语音识别服务（faster-whisper / CPU）...
echo.
echo   端点: http://127.0.0.1:19876/v1/audio/transcriptions
echo   首次启动需加载模型，请稍候几秒。
echo   保持本窗口开着 = 服务在运行；关闭本窗口即停止服务。
echo.
"%~dp0asr\venv\Scripts\python.exe" "%~dp0asr\asr_server.py"
echo.
echo 服务已退出（code %ERRORLEVEL%）。
pause
