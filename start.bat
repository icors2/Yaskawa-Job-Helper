@echo off
setlocal EnableExtensions
title Yaskawa Job Editor

rem Always run from this script's directory (app root)
cd /d "%~dp0"
if errorlevel 1 (
  echo ERROR: Could not change to app directory:
  echo   %~dp0
  pause
  exit /b 1
)

set "VITE_PORT=1420"

echo Yaskawa Job Editor
echo App root: %CD%
echo.

rem --- Node / npm (required) ---
where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js was not found on PATH.
  echo Install Node.js ^(project targets Node 24^) and reopen this window.
  echo See docs\DEVELOPER_GUIDE.md
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found on PATH.
  echo Install Node.js ^(includes npm^) and reopen this window.
  echo See docs\DEVELOPER_GUIDE.md
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
for /f "delims=" %%v in ('npm -v 2^>nul') do set "NPM_VER=%%v"
echo Found Node %NODE_VER%  npm %NPM_VER%

rem --- Python (optional warn; needed for kinematics sidecar) ---
where python >nul 2>&1
if errorlevel 1 (
  echo.
  echo WARNING: Python was not found on PATH.
  echo The kinematics sidecar may show "sidecar: offline".
  echo Install Python 3.11+ ^(guide targets 3.14^) and:
  echo   pip install -r kinematics\requirements.txt
  echo.
) else (
  for /f "delims=" %%v in ('python --version 2^>^&1') do set "PY_VER=%%v"
  echo Found %PY_VER%
)

rem --- Free stale Vite port so Tauri config stays on 1420 ---
echo.
echo Checking TCP port %VITE_PORT%...
set "FREE_PORT=%VITE_PORT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\free-port.ps1"

rem --- Optional: force npm install with --install or --force-install ---
set "FORCE_INSTALL="
if /i "%~1"=="--install" set "FORCE_INSTALL=1"
if /i "%~1"=="--force-install" set "FORCE_INSTALL=1"
if /i "%~1"=="/install" set "FORCE_INSTALL=1"

if not exist "node_modules\" (
  echo.
  echo node_modules not found - running npm install ^(first launch^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
) else if defined FORCE_INSTALL (
  echo.
  echo Running npm install ^(requested via %~1^)...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
) else (
  echo Dependencies present ^(node_modules^). Skipping npm install.
  echo Tip: pass --install to reinstall dependencies.
)

echo.
echo Starting desktop app ^(npm run dev^)...
echo Close this window, press Ctrl+C, or run stop.bat to stop.
echo.

set "PID_FILE=%CD%\.dev.pids"
del /f /q "%PID_FILE%" 2>nul

rem Launch npm in a tracked process so stop.bat can kill the tree precisely.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','dev' -WorkingDirectory (Get-Location) -PassThru -NoNewWindow; Set-Content -Path '.dev.pids' -Value $p.Id -Encoding ascii; Write-Host ('Recorded root PID ' + $p.Id + ' in .dev.pids'); $p.WaitForExit(); exit $p.ExitCode"

set "EXIT_CODE=%ERRORLEVEL%"

if exist "%PID_FILE%" del /f /q "%PID_FILE%" 2>nul

if not "%EXIT_CODE%"=="0" (
  echo.
  echo ERROR: App exited with code %EXIT_CODE%.
  if "%EXIT_CODE%"=="9009" (
    echo Exit code 9009 usually means a command was not found on PATH
    echo ^(for example cargo, rustc, or a missing npm script dependency^).
    echo Install Rust + VS Build Tools if cargo is missing - see docs\DEVELOPER_GUIDE.md
  ) else (
    echo If Vite reported "Port %VITE_PORT% is already in use", run stop.bat then retry.
    echo If cargo/Tauri failed, install Rust and VS Build Tools - see docs\DEVELOPER_GUIDE.md
  )
  echo Tip: run stop.bat to clear orphaned node/vite/tauri processes and free port %VITE_PORT%.
  pause
  exit /b %EXIT_CODE%
)

endlocal
exit /b 0
