@echo off
rem ORB Console - clean up old build artifacts.
rem Pure ASCII on purpose: cmd.exe reads .cmd as ANSI(936), so any Chinese
rem byte in this file would garble. All Chinese text lives in the .ps1,
rem which is invoked with a BOM so PowerShell 5.1 reads it as UTF-8.
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"

echo.
echo === ORB build artifact cleanup ===
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%clean-old-builds.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo Done. Removed items are in the Recycle Bin ^(restorable^).
) else (
  echo Finished with errors ^(exit code %RC%^). See the messages above.
)
echo.
pause
endlocal
