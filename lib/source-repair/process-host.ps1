param([Parameter(Mandatory = $true)][string]$ConfigurationPath)
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function ConvertTo-RepairProcessArgument {
  param([AllowEmptyString()][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

$ownedChild = $null
$ownedHost = $null
$repairJob = $null
try {
  $text = Get-Content -LiteralPath $ConfigurationPath -Raw -Encoding UTF8
  if ([System.Text.Encoding]::UTF8.GetByteCount($text) -gt 65536) { throw "process_input_limit" }
  $configuration = $text | ConvertFrom-Json -ErrorAction Stop
  if (
    $configuration.schemaVersion -ne "source-repair-process-v1" -or
    -not [System.IO.Path]::IsPathRooted([string]$configuration.executable) -or
    -not [System.IO.Path]::IsPathRooted([string]$configuration.cwd) -or
    -not (Test-Path -LiteralPath ([string]$configuration.executable) -PathType Leaf) -or
    @($configuration.args).Count -gt 100
  ) { throw "process_contract_invalid" }

  # Trusted runtime helpers are reused only for local process ownership. This
  # host joins the job before any child exists; descendants inherit containment.
  . (Join-Path $PSScriptRoot "..\..\scripts\runtime.ps1")
  $repairJob = New-DashboardProcessJob
  $ownedHost = [System.Diagnostics.Process]::GetCurrentProcess()
  Add-ProcessToDashboardJob -Job $repairJob -Process $ownedHost

  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = [string]$configuration.executable
  $start.Arguments = (@($configuration.args | ForEach-Object { ConvertTo-RepairProcessArgument ([string]$_) }) -join " ")
  $start.WorkingDirectory = [string]$configuration.cwd
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.RedirectStandardInput = $true
  $start.EnvironmentVariables.Clear()
  foreach ($property in $configuration.env.PSObject.Properties) {
    $start.EnvironmentVariables[$property.Name] = [string]$property.Value
  }
  $ownedChild = [System.Diagnostics.Process]::new()
  $ownedChild.StartInfo = $start
  if (-not $ownedChild.Start()) { throw "process_start_failed" }
  Add-Type -TypeDefinition @'
using System.IO;
using System.Threading.Tasks;
public static class SourceRepairInputRelay {
  public static async Task Copy(Stream source, Stream destination) {
    try { await source.CopyToAsync(destination).ConfigureAwait(false); }
    finally { destination.Close(); }
  }
}
'@
  $inputCopy = [SourceRepairInputRelay]::Copy([Console]::OpenStandardInput(), $ownedChild.StandardInput.BaseStream)
  $outputCopy = $ownedChild.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $errorCopy = $ownedChild.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  $ownedChild.WaitForExit()
  $null = $outputCopy.GetAwaiter().GetResult()
  $null = $errorCopy.GetAwaiter().GetResult()
  $code = $ownedChild.ExitCode
  @{ schemaVersion = "source-repair-process-exit-v1"; exitCode = $code } |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath ([string]$configuration.exitReceipt) -Encoding UTF8
  # Keep the handle alive until process exit. Closing it kills this host too,
  # so disposal must never precede emitting the child's exit status.
  [GC]::KeepAlive($repairJob)
  exit $code
} catch {
  [Console]::Error.WriteLine("source repair process host unavailable")
  exit 70
} finally {
  if ($ownedChild) { $ownedChild.Dispose() }
  if ($ownedHost) { $ownedHost.Dispose() }
  [GC]::KeepAlive($repairJob)
}
