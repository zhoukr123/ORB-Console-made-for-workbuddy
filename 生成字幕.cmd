@echo off
title ORB Subtitle Generator (local Whisper)
rem Drag a video/audio file onto this .cmd, or run:  生成字幕.cmd "D:\path\video.mp4"
if "%~1"=="" (
  echo.
  echo   Usage: drag a video/audio file onto this file, or run:
  echo      "%~nx0" "D:\path\video.mp4"
  echo.
  echo   Output: a .srt file next to the source (same name).
  echo.
  pause
  exit /b 1
)
"%~dp0asr\venv\Scripts\python.exe" "%~dp0asr\make_srt.py" "%~1"
echo.
pause
