param([Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{32}$')][string]$RunId)
. "$PSScriptRoot\runner-state.ps1"
$path = Join-Path $runnerRegistry "$RunId.json"
$receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
if ($receipt.id -ne $RunId -or $receipt.manifest_path -ne $path -or
    $receipt.working_directory -ne $runnerProjectRoot -or
    $receipt.runtime_revision -notmatch '^sha256:[0-9a-f]{64}$') {
  throw 'Invalid discovery runner receipt.'
}
$receipt.host_pid = $PID
$receipt.host_started_at = (Get-Process -Id $PID).StartTime.ToUniversalTime().ToString('o')
Write-RunnerReceipt $receipt
try {
  $nightly = Join-Path $PSScriptRoot 'nightly.ps1'
  $powershell = (Get-Command powershell.exe).Source
  $process = Start-Process -FilePath $powershell -WindowStyle Hidden -PassThru `
    -WorkingDirectory $runnerProjectRoot `
    -RedirectStandardOutput $receipt.log_path `
    -RedirectStandardError (Join-Path $runnerRegistry "$RunId.stderr.log") `
    -ArgumentList "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$nightly`" -RequireExistingRuntime -ExpectedRuntimeRevision $($receipt.runtime_revision)"
  $receipt.runner_pid = $process.Id
  $null = $process.Handle
  $receipt.runner_started_at = $process.StartTime.ToUniversalTime().ToString('o')
  $receipt.state = 'running'
  $receipt.updated_at = [DateTimeOffset]::UtcNow.ToString('o')
  Write-RunnerReceipt $receipt
  $process.WaitForExit()
  # Refresh the native exit handle after redirected streams have drained.
  $receipt.exit_code = $process.ExitCode
  if ($null -eq $receipt.exit_code) { throw 'The discovery process returned no exit code.' }
  $receipt.state = if ($receipt.exit_code -eq 0) { 'completed' } else { 'failed' }
} catch {
  $receipt.state = 'failed'
  $receipt.exit_code = 1
  $receipt.last_error = $_.Exception.Message
} finally {
  $receipt.ended_at = [DateTimeOffset]::UtcNow.ToString('o')
  $receipt.updated_at = $receipt.ended_at
  Write-RunnerReceipt $receipt
}
exit $receipt.exit_code
