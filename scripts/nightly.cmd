@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0nightly.ps1" %*
