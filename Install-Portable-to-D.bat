@echo off
setlocal
cd /d "%~dp0"
title Install portable app to D:\

if not exist "portable\YaskawaJobEditor\Yaskawa Job Editor.exe" (
  echo Portable package not found. Run Build-Portable-USB.bat first.
  pause
  exit /b 1
)

if not exist "D:\" (
  echo ERROR: Drive D:\ is not available.
  echo Plug in your USB ^(or assign it as D:^), then try again.
  echo Or run:
  echo   powershell -File scripts\Install-Portable-to-Drive.ps1 -Drive E
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Install-Portable-to-Drive.ps1" -Drive D
if errorlevel 1 (
  pause
  exit /b 1
)

echo.
echo Done. Starting from D:\YaskawaJobEditor\ ...
if exist "D:\YaskawaJobEditor\Run.bat" (
  start "" "D:\YaskawaJobEditor\Run.bat"
) else (
  echo Run.bat missing — open D:\YaskawaJobEditor\ manually.
)
pause
endlocal
