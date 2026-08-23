# Build a portable USB folder (no installer required).
# Output: portable\YaskawaJobEditor\
# Then run: .\scripts\Install-Portable-to-Drive.ps1 -Drive D:

param(
  [switch]$SkipFrontend,
  [switch]$SkipKin,
  [switch]$SkipTauri
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$OutDir = Join-Path $Root "portable\YaskawaJobEditor"
$ReleaseDir = Join-Path $Root "src-tauri\target\release"
$KinDist = Join-Path $Root "dist-kin"

Write-Host "=== Yaskawa Job Editor - portable build ===" -ForegroundColor Cyan
Write-Host "App root: $Root"
Write-Host "Output:   $OutDir"
Write-Host ""

if (-not $SkipFrontend) {
  Write-Host "[1/4] Frontend (vite build)..." -ForegroundColor Yellow
  npm run build:web
  if ($LASTEXITCODE -ne 0) { throw "npm run build:web failed" }
} else {
  Write-Host "[1/4] Skipping frontend" -ForegroundColor DarkGray
}

if (-not $SkipKin) {
  Write-Host "[2/4] Kinematics sidecar (PyInstaller)..." -ForegroundColor Yellow
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
  if (-not $py) { throw "Python not found - required to bundle yaskawa-kin.exe" }

  New-Item -ItemType Directory -Force -Path $KinDist | Out-Null
  & $py.Source -m PyInstaller `
    --noconfirm `
    --onefile `
    --name yaskawa-kin `
    --distpath $KinDist `
    --workpath (Join-Path $KinDist "work") `
    --specpath (Join-Path $KinDist "spec") `
    (Join-Path $Root "kinematics\server.py")
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed - pip install pyinstaller" }
} else {
  Write-Host "[2/4] Skipping PyInstaller" -ForegroundColor DarkGray
}

if (-not $SkipTauri) {
  Write-Host "[3/4] Tauri release binary (no installer bundle)..." -ForegroundColor Yellow
  npx tauri build --no-bundle
  if ($LASTEXITCODE -ne 0) {
    Write-Host "tauri build --no-bundle failed; trying full tauri build..." -ForegroundColor DarkYellow
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
  }
} else {
  Write-Host "[3/4] Skipping Tauri build" -ForegroundColor DarkGray
}

Write-Host "[4/4] Assembling portable folder..." -ForegroundColor Yellow

$ExeCandidates = @(
  (Join-Path $ReleaseDir "yaskawa-job-editor.exe"),
  (Join-Path $ReleaseDir "Yaskawa Job Editor.exe")
)
$AppExe = $ExeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $AppExe) {
  throw "Release exe not found under $ReleaseDir. Build Tauri first."
}

$KinExe = Join-Path $KinDist "yaskawa-kin.exe"
if (-not (Test-Path $KinExe)) {
  throw "Missing $KinExe - run without -SkipKin or place yaskawa-kin.exe in dist-kin\"
}

if (Test-Path $OutDir) {
  Remove-Item -Recurse -Force $OutDir
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Copy-Item -Force $AppExe (Join-Path $OutDir "Yaskawa Job Editor.exe")
Copy-Item -Force $KinExe (Join-Path $OutDir "yaskawa-kin.exe")

$KinSrcOut = Join-Path $OutDir "kinematics"
New-Item -ItemType Directory -Force -Path $KinSrcOut | Out-Null
Copy-Item -Force (Join-Path $Root "kinematics\*.py") $KinSrcOut -ErrorAction SilentlyContinue
Copy-Item -Force (Join-Path $Root "kinematics\requirements.txt") $KinSrcOut -ErrorAction SilentlyContinue

$RunBat = @(
  "@echo off"
  "cd /d `"%~dp0`""
  "title Yaskawa Job Editor (portable)"
  "echo Starting Yaskawa Job Editor from:"
  "echo   %CD%"
  "echo."
  "if not exist `"Yaskawa Job Editor.exe`" ("
  "  echo ERROR: Yaskawa Job Editor.exe not found next to this script."
  "  pause"
  "  exit /b 1"
  ")"
  "if not exist `"yaskawa-kin.exe`" ("
  "  echo WARNING: yaskawa-kin.exe missing - transforms/calibration will be offline."
  ")"
  "start `"`" `"%~dp0Yaskawa Job Editor.exe`""
)
$RunBat | Set-Content -Encoding ASCII (Join-Path $OutDir "Run.bat")

$Readme = @(
  "Yaskawa Job Editor - Portable USB build"
  "======================================="
  ""
  "This folder is self-contained. No Node, Python, or Rust needed on the target PC."
  ""
  "Contents"
  "--------"
  "- Yaskawa Job Editor.exe  - desktop app"
  "- yaskawa-kin.exe         - kinematics sidecar (spawned automatically)"
  "- Run.bat                 - double-click to start"
  "- kinematics\             - optional Python sources (debug only)"
  ""
  "Install onto D:\ (or any USB drive)"
  "-----------------------------------"
  "From the repo (on a build PC):"
  ""
  "  powershell -File scripts\Install-Portable-to-Drive.ps1 -Drive D:"
  ""
  "Or copy this entire folder to:"
  ""
  "  D:\YaskawaJobEditor\"
  ""
  "Then on the locked PC: open D:\YaskawaJobEditor\ and double-click Run.bat"
  "(or Yaskawa Job Editor.exe)."
  ""
  "Notes"
  "-----"
  "- Windows 10/11 with WebView2 (usually preinstalled)."
  "- Profile settings may still store under the Windows user AppData folder."
  "- Prefer choosing a jobs output folder on the USB stick for edited .JBI files."
  "- If the PC blocks EXE from removable drives, IT must allow this binary."
)
$Readme | Set-Content -Encoding UTF8 (Join-Path $OutDir "README-PORTABLE.txt")

Write-Host ""
Write-Host "Portable package ready:" -ForegroundColor Green
Write-Host "  $OutDir"
Get-ChildItem $OutDir | Format-Table Name, Length -AutoSize
Write-Host "Next: .\scripts\Install-Portable-to-Drive.ps1 -Drive D:"
