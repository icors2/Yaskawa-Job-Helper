@echo off
setlocal
cd /d "%~dp0"
title Build portable USB package

echo Building portable Yaskawa Job Editor package...
echo This needs Node, Rust, and Python ON THIS BUILD PC only.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-portable.ps1"
if errorlevel 1 (
  echo.
  echo BUILD FAILED.
  pause
  exit /b 1
)

echo.
echo Package is in: portable\YaskawaJobEditor\
echo Windows: double-click Install-Portable-to-D.bat  ^(or pass another drive^)
echo Ubuntu:  Linux binaries are added by Build-Portable-USB.sh on Ubuntu/WSL.
echo          The USB file to open there is "Yaskawa Job Editor.sh".
pause
endlocal
