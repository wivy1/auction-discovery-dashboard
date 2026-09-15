param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^Local\\auction-discovery-dashboard-[0-9a-f]{32}$')]
  [string]$GateName,
  [Parameter(Mandatory = $true)][string]$NodeExe,
  [Parameter(Mandatory = $true)][string]$VinextCli
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
  throw "The dashboard Node.js executable is unavailable."
}
if (-not (Test-Path -LiteralPath $VinextCli -PathType Leaf)) {
  throw "The dashboard CLI is unavailable."
}

$gate = $null
try {
  $gate = [Threading.EventWaitHandle]::OpenExisting($GateName)
  if (-not $gate.WaitOne([TimeSpan]::FromSeconds(30))) {
    throw "The dashboard host was not released after bounded Job Object assignment."
  }
  # Collect native Worker wrappers before the external-entity table fills.
  $env:MINIFLARE_WORKERD_V8_FLAGS = "--max-old-space-size=512"
  & $NodeExe $VinextCli dev
  exit $LASTEXITCODE
} finally {
  if ($gate) { $gate.Dispose() }
}
