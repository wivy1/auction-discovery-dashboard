param(
  [Parameter(Mandatory = $true)][string]$ProjectName,
  [Parameter(Mandatory = $true)][string]$TaskName,
  [Parameter(Mandatory = $true)][string]$Activity,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(Mandatory = $true)][string]$CommandBase64,
  [string]$UrlOrPort
)
. "$PSScriptRoot\runner-state.ps1"
if ($ProjectName -ne 'auction-discovery' -or $TaskName -ne 'dashboard' -or
    $Activity -ne 'nightly-discovery' -or
    [IO.Path]::GetFullPath($WorkingDirectory).TrimEnd('\') -ne $runnerProjectRoot) {
  throw 'The discovery launcher identity does not belong to this checkout.'
}
$command = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandBase64))
$nightly = Join-Path $runnerProjectRoot 'scripts\nightly.ps1'
$prefix = "& '$($nightly.Replace("'", "''"))' -RequireExistingRuntime -ExpectedRuntimeRevision '"
if (-not $command.StartsWith($prefix) -or $command.Substring($prefix.Length) -notmatch "^(sha256:[0-9a-f]{64})'$" ) {
  throw 'Only the revision-bound local discovery command may be launched.'
}
$revision = $Matches[1]
New-Item -ItemType Directory -Path $runnerRegistry -Force | Out-Null
$lock = $null
$lockTimer = [Diagnostics.Stopwatch]::StartNew()
while ($null -eq $lock) {
  try {
    $lock = [IO.File]::Open((Join-Path $runnerRegistry 'launch.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
  } catch [IO.IOException] {
    if (($_.Exception.HResult -band 0xffff) -notin @(32, 33) -or $lockTimer.Elapsed.TotalSeconds -ge 12) { throw }
    Start-Sleep -Milliseconds 50
  }
}
try {
  $active = @(Read-RunnerReceipts | Where-Object { $_.state -in @('starting', 'running', 'stop-requested') })
  if ($active.Count -gt 1) { throw 'Multiple discovery runner identities require operator review.' }
  if ($active.Count -eq 1) {
    if ($active[0].command -ne $command) { throw 'An existing discovery owns a different runtime revision.' }
    $active[0].reused = $true
    $active[0] | ConvertTo-Json -Depth 8 -Compress
    return
  }
  $id = [Guid]::NewGuid().ToString('N')
  $now = [DateTimeOffset]::UtcNow.ToString('o')
  $receipt = [ordered]@{
    id = $id; project = $ProjectName; task = $TaskName; activity = $Activity
    command = $command; working_directory = $runnerProjectRoot
    manifest_path = (Join-Path $runnerRegistry "$id.json")
    log_path = (Join-Path $runnerRegistry "$id.stdout.log")
    title = 'Auction Discovery'; state = 'starting'; reused = $false
    created_at = $now; updated_at = $now; ended_at = $null; exit_code = $null
    runner_pid = $null; runner_started_at = $null; host_pid = $null; host_started_at = $null
    last_error = $null; runtime_revision = $revision
  }
  Write-RunnerReceipt $receipt
  $hostScript = Join-Path $PSScriptRoot 'discovery-runner.ps1'
  $powershell = (Get-Command powershell.exe).Source
  $process = Start-Process -FilePath $powershell -WindowStyle Hidden -PassThru `
    -WorkingDirectory $runnerProjectRoot `
    -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$hostScript`" -RunId $id"
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    Start-Sleep -Milliseconds 50
    $current = Get-Content -LiteralPath $receipt.manifest_path -Raw | ConvertFrom-Json
    if ($current.host_pid) { $current | ConvertTo-Json -Depth 8 -Compress; return }
    $process.Refresh()
  } while (-not $process.HasExited -and $timer.Elapsed.TotalSeconds -lt 10)
  throw 'The discovery runner did not acknowledge its exact receipt.'
} finally { $lock.Dispose() }
