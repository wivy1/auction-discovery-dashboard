@echo off
setlocal
title Auction Discovery
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-dashboard.ps1"
set "launcherExitCode=%errorlevel%"
echo(
echo Press any key to close this launcher window.
pause >nul
exit /b %launcherExitCode%
