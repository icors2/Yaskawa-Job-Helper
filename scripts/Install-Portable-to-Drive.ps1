# Copy the portable package to a USB / fixed drive letter (default D:).
param(
  [Parameter(Mandatory = $false)]
  [string]$Drive = "D",

  [Parameter(Mandatory = $false)]
  [string]$FolderName = "YaskawaJobEditor"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Root "portable\YaskawaJobEditor"

$Drive = $Drive.TrimEnd(":\") + ":"
$Dest = Join-Path "$Drive\" $FolderName

if (-not (Test-Path $Src)) {
  Write-Host "ERROR: Portable package not found:" -ForegroundColor Red
  Write-Host "  $Src"
  Write-Host "Build first:"
  Write-Host "  powershell -File scripts\build-portable.ps1"
  exit 1
}

if (-not (Test-Path "$Drive\")) {
  Write-Host "ERROR: Drive $Drive is not available. Plug in the USB or pick another letter." -ForegroundColor Red
  exit 1
}

Write-Host "Copying portable app..." -ForegroundColor Cyan
Write-Host "  From: $Src"
Write-Host "  To:   $Dest"

if (Test-Path $Dest) {
  Write-Host "Removing existing $Dest ..." -ForegroundColor DarkYellow
  Remove-Item -Recurse -Force $Dest
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Path (Join-Path $Src "*") -Destination $Dest -Recurse -Force

Write-Host ""
Write-Host "Installed portable app to:" -ForegroundColor Green
Write-Host "  $Dest"
Write-Host "Run:  $Dest\Run.bat"
Write-Host "Or:   $Dest\Yaskawa Job Editor.exe"
