@echo off
setlocal EnableExtensions
title Stop Yaskawa Job Editor

rem Always run from this script's directory (app root)
cd /d "%~dp0"
if errorlevel 1 (
  echo ERROR: Could not change to app directory:
  echo   %~dp0
  pause
  exit /b 1
)

set "PID_FILE=%CD%\.dev.pids"
set "APP_ROOT=%CD%"
set "STOPPED_ANY=0"
set "VITE_PORT=1420"

echo Yaskawa Job Editor - stop
echo App root: %APP_ROOT%
echo.

rem --- Prefer precise stop via PID file written by start.bat ---
if exist "%PID_FILE%" (
  echo Found PID file: %PID_FILE%
  for /f "usebackq tokens=* delims=" %%P in ("%PID_FILE%") do (
    call :kill_pid %%P
  )
  del /f /q "%PID_FILE%" 2>nul
  if exist "%PID_FILE%" (
    echo WARNING: Could not delete %PID_FILE%
  ) else (
    echo Removed PID file.
  )
) else (
  echo No .dev.pids file - using port and path fallbacks.
)

echo.
echo Freeing TCP port %VITE_PORT% ^(Vite / Tauri dev^)...
set "FREE_PORT=%VITE_PORT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\free-port.ps1"
if errorlevel 2 set "STOPPED_ANY=1"

echo.
echo Scanning for leftover project-tied node/vite/tauri/cargo processes...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-project-procs.ps1"
if errorlevel 2 (
  set "STOPPED_ANY=1"
) else if errorlevel 1 (
  echo.
  echo ERROR: Fallback process scan failed.
  pause
  exit /b 1
)

set "FREE_PORT=%VITE_PORT%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\free-port.ps1"
if errorlevel 2 set "STOPPED_ANY=1"

echo.
if "%STOPPED_ANY%"=="1" (
  echo Done. Dev processes for this project should be stopped.
) else (
  echo Done. Nothing left to stop ^(or already stopped^).
)
echo Tip: if start.bat still says port %VITE_PORT% in use, wait a few seconds for TIME_WAIT to clear.
endlocal
exit /b 0

:kill_pid
set "TARGET=%~1"
if "%TARGET%"=="" goto :eof
echo %TARGET%| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo Skipping non-PID line: %TARGET%
  goto :eof
)
echo Stopping process tree for PID %TARGET%...
taskkill /PID %TARGET% /T /F >nul 2>&1
if errorlevel 1 (
  echo   PID %TARGET% was not running ^(or already stopped^).
) else (
  echo   Stopped PID %TARGET% and children.
  set "STOPPED_ANY=1"
)
goto :eof
