@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Please install Node.js 22 LTS and try again.
  pause
  exit /b 1
)
call node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if errorlevel 1 (
  echo Node.js 22 or newer is required. Please update Node.js and try again.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  echo Building Roadster Flight Lab...
  call npm ci
  if errorlevel 1 goto failed
  call npm run build
  if errorlevel 1 goto failed
)
call node scripts\serve.mjs --open
if errorlevel 1 goto failed
exit /b 0
:failed
echo Could not start Roadster Flight Lab. See the message above.
pause
exit /b 1
