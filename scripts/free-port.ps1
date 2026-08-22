# Free TCP port held by stale Vite/Tauri. Uses FREE_PORT env (default 1420).
# Exit 0 = nothing to kill, 2 = killed one or more PIDs.
$port = if ($env:FREE_PORT) { [int]$env:FREE_PORT } else { 1420 }
$pids = New-Object 'System.Collections.Generic.HashSet[int]'

try {
  Get-NetTCPConnection -LocalPort $port -ErrorAction Stop | ForEach-Object {
    if ($_.OwningProcess -gt 0) {
      [void]$pids.Add([int]$_.OwningProcess)
    }
  }
} catch {
  netstat -ano | ForEach-Object {
    if ($_ -match (':' + $port + '\s+\S+\s+\S+\s+(\d+)\s*$')) {
      $id = [int]$Matches[1]
      if ($id -gt 0) {
        [void]$pids.Add($id)
      }
    }
  }
}

if ($pids.Count -eq 0) {
  Write-Host "No LISTEN/ESTABLISHED owner on TCP $port (TIME_WAIT alone is OK)."
  exit 0
}

foreach ($id in @($pids)) {
  try {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    $name = if ($proc) { $proc.ProcessName } else { 'unknown' }
    Stop-Process -Id $id -Force -ErrorAction Stop
    Write-Host "  Killed PID $id ($name) holding port $port"
  } catch {
    Write-Host "  Could not kill PID $id via Stop-Process; trying taskkill..."
    & taskkill.exe /PID $id /T /F 2>$null | Out-Null
    Write-Host "  taskkill fallback used for PID $id"
  }
}

exit 2
