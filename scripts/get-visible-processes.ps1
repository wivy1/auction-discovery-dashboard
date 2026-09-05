param([switch]$AsJson)
. "$PSScriptRoot\runner-state.ps1"
$all = @(Read-RunnerReceipts | Sort-Object created_at -Descending)
$receipts = @($all | Where-Object { $_.state -in @('starting', 'running', 'stop-requested') })
if ($receipts.Count -eq 0 -and $all.Count -gt 0 -and $all[0].state -eq 'exited-unrecorded') {
  $receipts = @($all[0])
}
ConvertTo-Json -InputObject $receipts -Depth 8 -Compress
