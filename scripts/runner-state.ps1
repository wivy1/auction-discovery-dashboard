$ErrorActionPreference = "Stop"
$runnerProjectRoot = Split-Path -Parent $PSScriptRoot
$runnerRegistry = Join-Path $runnerProjectRoot ".wrangler\logs\discovery-runners"

function Write-RunnerReceipt {
  param([Parameter(Mandatory = $true)]$Receipt)
  $path = Join-Path $runnerRegistry "$($Receipt.id).json"
  $temporary = "$path.tmp.$PID"
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($temporary, ($Receipt | ConvertTo-Json -Depth 8 -Compress), $encoding)
  Move-Item -LiteralPath $temporary -Destination $path -Force
}

function Test-RunnerProcess {
  param($ProcessIdValue, $StartedAt)
  if (-not $ProcessIdValue -or -not $StartedAt) { return $false }
  try {
    $process = Get-Process -Id ([int]$ProcessIdValue) -ErrorAction Stop
    return -not $process.HasExited -and $process.StartTime.ToUniversalTime().ToString("o") -eq [string]$StartedAt
  } catch { return $false }
}

function Read-RunnerReceipts {
  if (-not (Test-Path -LiteralPath $runnerRegistry)) { return }
  foreach ($file in Get-ChildItem -LiteralPath $runnerRegistry -Filter '*.json' -File) {
    if ($file.Name -notmatch '^[0-9a-f]{32}\.json$' -or $file.Length -gt 65536) { continue }
    try {
      $receipt = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -ErrorAction Stop
      if ($receipt.id -ne $file.BaseName -or $receipt.manifest_path -ne $file.FullName -or
          $receipt.working_directory -ne $runnerProjectRoot -or
          $receipt.project -ne 'auction-discovery' -or $receipt.task -ne 'dashboard' -or
          $receipt.activity -ne 'nightly-discovery') { continue }
      if ($receipt.state -in @('starting', 'running', 'stop-requested')) {
        $alive = (Test-RunnerProcess $receipt.host_pid $receipt.host_started_at) -or
          (Test-RunnerProcess $receipt.runner_pid $receipt.runner_started_at)
        $starting = $receipt.state -eq 'starting' -and
          ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($receipt.created_at)).TotalSeconds -lt 15
        if (-not $alive -and -not $starting) {
          $receipt.state = 'exited-unrecorded'
          $receipt.updated_at = [DateTimeOffset]::UtcNow.ToString('o')
          $receipt.last_error = 'The exact discovery runner exited without a completion receipt.'
        }
      }
      $receipt
    } catch { continue }
  }
}
