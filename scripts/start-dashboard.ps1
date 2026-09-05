$ErrorActionPreference = "Stop"

$projectDirectory = Split-Path -Parent $PSScriptRoot
$supervisorScript = Join-Path $PSScriptRoot "dev-host.ps1"
$lockContendedExitCode = 76
$launcherExitCode = 1
$stage = 1
$progressLineWidth = 0
$interactiveProgress = -not [Console]::IsErrorRedirected -and -not $env:CI

function Write-LauncherStage {
  param([int]$Step, [string]$Message, [switch]$Complete)

  $line = "$Step/2: $Message"
  if ($interactiveProgress) {
    $width = [Math]::Max(1, [Console]::WindowWidth - 1)
    if ($line.Length -gt $width) { $line = $line.Substring(0, $width) }
    $padding = " " * [Math]::Max(0, [Math]::Min($width, $script:progressLineWidth) - $line.Length)
    [Console]::Error.Write("`r$line$padding")
    $script:progressLineWidth = $line.Length
    if ($Complete) {
      [Console]::Error.WriteLine()
      $script:progressLineWidth = 0
    }
  } else {
    [Console]::Error.WriteLine($line)
  }
}

try {
  Set-Location -LiteralPath $projectDirectory
  Write-LauncherStage -Step 1 -Message "checking prerequisites"
  # Resolve the installed runtime through the shared prerequisite check.
  . (Join-Path $PSScriptRoot "runtime.ps1")
  $nodeVersion = & $NodeExe --version
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+\.\d+\.\d+)$' -or
      [version]$Matches[1] -lt [version]"22.13.0") {
    throw "Node.js 22.13 or newer is required. Update the installed Node.js, then try again."
  }
  foreach ($dependency in @("node_modules\vinext\dist\cli.js", "node_modules\tsx\package.json")) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory $dependency) -PathType Leaf)) {
      throw "Project dependencies are missing. Run scripts\setup.cmd from this folder once, then open Auction Discovery.cmd again. Setup requires pnpm."
    }
  }
  if (-not (Test-Path -LiteralPath $supervisorScript -PathType Leaf)) {
    throw "scripts\dev-host.ps1 is missing. Restore the project files before starting the dashboard."
  }

  $stage = 2
  Write-LauncherStage -Step $stage -Message "starting the supervised dashboard" -Complete
  [Console]::Error.WriteLine('Wait for "Dashboard runtime is ready", then open http://localhost:3000 in your browser.')
  [Console]::Error.WriteLine("Keep this terminal open while using the dashboard.")
  [Console]::Error.WriteLine("To stop: let active discovery finish (or stop it in the dashboard), then press Ctrl+C here.")
  [Console]::Error.WriteLine("If Windows asks 'Terminate batch job (Y/N)?', press Y.")
  [Console]::Error.WriteLine("Runtime logs: $(Join-Path $projectDirectory '.wrangler\logs')")
  [Console]::Error.WriteLine()

  # This foreground call retains the existing host's lock, health checks and
  # process ownership. It must stay a separate process because the host exits.
  & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $supervisorScript
  $launcherExitCode = $LASTEXITCODE
  if ($launcherExitCode -eq $lockContendedExitCode) {
    [Console]::Error.WriteLine("Another supervisor owns this checkout. This launch has left it running.")
    [Console]::Error.WriteLine("Use the original terminal for startup status and stopping. If it is ready, open http://localhost:3000.")
  } elseif ($launcherExitCode -eq 0) {
    [Console]::Error.WriteLine("Dashboard supervisor stopped.")
  } else {
    [Console]::Error.WriteLine("Dashboard supervisor stopped with exit code $launcherExitCode. Review the error above and .wrangler\logs before trying again.")
  }
} catch {
  Write-LauncherStage -Step $stage -Message "startup failed" -Complete
  [Console]::Error.WriteLine($_.Exception.Message)
  $launcherExitCode = 1
}

exit $launcherExitCode
