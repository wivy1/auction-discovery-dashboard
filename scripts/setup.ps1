. "$PSScriptRoot\runtime.ps1"

Set-Location -LiteralPath $ProjectRoot
if (-not $PnpmExe) { throw "pnpm is required. Install the version declared in package.json, then rerun setup." }
$nodeVersion = & $NodeExe --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+\.\d+\.\d+)$' -or
    [version]$Matches[1] -lt [version]'22.13.0') { throw 'Node.js 22.13 or newer is required.' }
[Console]::Error.WriteLine('1/2: installing locked dependencies')
& $PnpmExe install --frozen-lockfile --store-dir .pnpm-store
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
[Console]::Error.WriteLine('2/2: preparing local source configuration')
$localSourceConfig = Join-Path $ProjectRoot 'source-adapters.local.ts'
if (-not (Test-Path -LiteralPath $localSourceConfig)) {
  # File.Copy with overwrite=false preserves a concurrent or existing local configuration.
  [IO.File]::Copy((Join-Path $ProjectRoot 'source-adapters.example.ts'), $localSourceConfig, $false)
}
[Console]::Error.WriteLine('2/2: setup complete; open Auction Discovery.cmd')
