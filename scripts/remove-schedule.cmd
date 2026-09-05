@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0remove-schedule.ps1" %*
