# Stop node/vite/tauri/cargo processes whose command line includes APP_ROOT.
# Exit 0 = none found, 2 = stopped one or more.
$root = $env:APP_ROOT
if (-not $root) {
  Write-Host 'APP_ROOT not set.'
  exit 1
}

$rootNorm = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
$escaped = [regex]::Escape($rootNorm)
$patterns = @('node\.exe', 'npm\.cmd', 'npm-cli', 'vite', '@tauri-apps', 'tauri', 'cargo\.exe', 'rustc')
$killed = New-Object System.Collections.Generic.List[string]

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  $cmd = $_.CommandLine
  if (-not $cmd) {
    return
  }
  if ($cmd -notmatch $escaped) {
    return
  }
  $hit = $false
  foreach ($p in $patterns) {
    if ($cmd -match $p) {
      $hit = $true
      break
    }
  }
  if (-not $hit -and $_.Name -match '^(node|cargo|rustc)\.exe$') {
    $hit = $true
  }
  if (-not $hit) {
    return
  }
  try {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
    [void]$killed.Add(('  PID {0} ({1})' -f $_.ProcessId, $_.Name))
  } catch {}
}

if ($killed.Count -eq 0) {
  Write-Host 'No matching leftover processes found.'
  exit 0
}

Write-Host 'Stopped path-matched processes:'
$killed | ForEach-Object { Write-Host $_ }
exit 2
