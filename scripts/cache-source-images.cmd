@echo off
setlocal
if defined NODE_OPTIONS (
  set "NODE_OPTIONS=--use-system-ca --dns-result-order=ipv4first %NODE_OPTIONS%"
) else (
  set "NODE_OPTIONS=--use-system-ca --dns-result-order=ipv4first"
)
call "%~dp0..\node_modules\.bin\tsx.cmd" "%~dp0cache-source-images.ts" %*
exit /b %ERRORLEVEL%
