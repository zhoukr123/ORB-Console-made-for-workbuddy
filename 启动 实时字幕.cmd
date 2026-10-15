@echo off
title ORB Live Subtitles
echo Starting live subtitles (system audio -^> text)...
echo.
echo   Page : http://127.0.0.1:19879
echo   Close this window to stop. The .srt keeps accumulating.
echo.
"%~dp0asr\venv\Scripts\python.exe" "%~dp0asr\subtitle_rt.py"
echo.
pause
