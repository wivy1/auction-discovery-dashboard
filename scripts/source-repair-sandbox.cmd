@echo off
setlocal
pushd "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. 1>&2
  popd
  exit /b 1
)
node --import ./scripts/node-runtime-preload.mjs --import tsx "%~dp0source-repair-sandbox.mts" %*
set "repairExit=%ERRORLEVEL%"
popd
exit /b %repairExit%
