# Build Windows files into the shared portable USB folder (no installer required).
# Output: portable\YaskawaJobEditor\
# Linux binaries already in that folder are left in place unless -Clean is passed.
# Then run: .\scripts\Install-Portable-to-Drive.ps1 -Drive D:

param(
  [switch]$SkipFrontend,
  [switch]$SkipKin,
  [switch]$SkipTauri,
  [switch]$Clean
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
  $KinDir = Join-Path $Root "kinematics"
  # Local modules live beside server.py; without --paths PyInstaller omits them
  # and the onefile exe crashes with ModuleNotFoundError (e.g. ar2010).
  $Hidden = @(
    "ar2010",
    "calibrate",
    "cnd",
    "robot_model",
    "robot_profile",
    "frame_flip",
    "transform",
    "numpy",
    "scipy",
    "scipy.optimize"
  )
  $PyArgs = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--onefile",
    "--name", "yaskawa-kin",
    "--paths", $KinDir,
    "--distpath", $KinDist,
    "--workpath", (Join-Path $KinDist "work"),
    "--specpath", (Join-Path $KinDist "spec"),
    "--collect-submodules", "numpy",
    "--collect-submodules", "scipy"
  )
  foreach ($mod in $Hidden) {
    $PyArgs += @("--hidden-import", $mod)
  }
  $PyArgs += (Join-Path $KinDir "server.py")
  & $py.Source @PyArgs
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed - pip install pyinstaller numpy scipy" }

  $KinExeSmoke = Join-Path $KinDist "yaskawa-kin.exe"
  Write-Host "    Smoke-testing yaskawa-kin.exe..." -ForegroundColor DarkGray
  $smokeScript = Join-Path $PSScriptRoot "portable\smoke_kin.py"
  & $py.Source $smokeScript $KinExeSmoke
  if ($LASTEXITCODE -ne 0) {
    throw "yaskawa-kin.exe smoke test failed - local modules or numpy/scipy not bundled"
  }
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

Write-Host "[4/4] Assembling portable folder (Windows files)..." -ForegroundColor Yellow

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

if ($Clean -and (Test-Path $OutDir)) {
  Write-Host "    -Clean: removing $OutDir" -ForegroundColor DarkYellow
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
  "set `"YASKAWA_PORTABLE_DIR=%~dp0`""
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

$PortableSrc = Join-Path $PSScriptRoot "portable"
Copy-Item -Force (Join-Path $PortableSrc "Yaskawa Job Editor.sh") (Join-Path $OutDir "Yaskawa Job Editor.sh")
Copy-Item -Force (Join-Path $PortableSrc "README-PORTABLE.txt") (Join-Path $OutDir "README-PORTABLE.txt")

Write-Host ""
Write-Host "Portable package ready:" -ForegroundColor Green
Write-Host "  $OutDir"
Get-ChildItem $OutDir | Format-Table Name, Length -AutoSize
if (Test-Path (Join-Path $OutDir "yaskawa-job-editor")) {
  Write-Host "Linux files are still present (left untouched)." -ForegroundColor Green
} else {
  Write-Host "Ubuntu launcher is included. Build Linux binaries on Ubuntu/WSL with:" -ForegroundColor DarkGray
  Write-Host "  ./Build-Portable-USB.sh"
}
Write-Host "Windows: .\scripts\Install-Portable-to-Drive.ps1 -Drive D:"
Write-Host "Ubuntu:  bash `"$OutDir\Yaskawa Job Editor.sh`""
