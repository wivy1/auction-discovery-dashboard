param([string]$ArchivePath = '', [switch]$CheckOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repairProjectRoot = Split-Path -Parent $PSScriptRoot
$repairVersion = '24.18.0'
$repairNodeName = "node-v$repairVersion-linux-x64"
$repairArchiveHash = '55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742'
$repairBinaryHash = '41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c'
$repairToolchain = Join-Path $repairProjectRoot 'work\source-repairs\toolchain'
$repairNodeTree = Join-Path $repairToolchain $repairNodeName
$repairNode = Join-Path $repairNodeTree 'bin\node'
$repairWsl = Join-Path $env:SystemRoot 'System32\wsl.exe'

function Assert-RepairSetupPath {
  param([string]$Path)
  $root = [IO.Path]::GetFullPath($repairProjectRoot).TrimEnd('\')
  $cursor = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if (-not [string]::Equals($cursor, $root, [StringComparison]::OrdinalIgnoreCase) -and
      -not $cursor.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Sandbox setup path escapes this project.' }
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Sandbox setup does not follow links.' }
    }
    if ([string]::Equals($cursor, $root, [StringComparison]::OrdinalIgnoreCase)) { break }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
    if (-not $cursor) { throw 'Sandbox setup ancestry is unavailable.' }
  }
}
function ConvertTo-RepairWslPath {
  param([string]$Path)
  $value = [IO.Path]::GetFullPath($Path).Replace('\', '/')
  if ($value -notmatch '^[A-Za-z]:/' -or $value -match '[\x00-\x1f]') { throw 'Sandbox setup requires a local Windows drive path.' }
  return '/mnt/' + $value.Substring(0, 1).ToLowerInvariant() + $value.Substring(2)
}
function Get-RepairSetupHash {
  param([string]$Path)
  $stream = [IO.File]::OpenRead($Path)
  $digest = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($digest.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $digest.Dispose(); $stream.Dispose() }
}
function Invoke-RepairSetupWsl {
  param([string[]]$Arguments)
  $lines = @(& $repairWsl -d Ubuntu --exec @Arguments)
  if ($LASTEXITCODE -ne 0) { throw 'Existing WSL Ubuntu/bubblewrap is unavailable; install it separately before optional sandbox setup.' }
  return $lines
}

$repairStaging = $null
try {
  [Console]::Error.WriteLine('1/4: checking existing WSL Ubuntu and bubblewrap')
  if ($env:OS -ne 'Windows_NT' -or -not (Test-Path -LiteralPath $repairWsl -PathType Leaf)) { throw 'Optional sandbox setup requires existing Windows WSL Ubuntu; no WSL or package installation is performed.' }
  Assert-RepairSetupPath -Path $repairNode
  $architecture = @(Invoke-RepairSetupWsl -Arguments @('/usr/bin/uname', '-m'))
  if ($architecture.Count -ne 1 -or $architecture[0].Trim() -cne 'x86_64') { throw 'The pinned sandbox runtime requires x86_64 Ubuntu.' }
  $null = Invoke-RepairSetupWsl -Arguments @('/usr/bin/bwrap', '--version')
  $null = Invoke-RepairSetupWsl -Arguments @('/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--clearenv',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin', '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--', '/usr/bin/true')
  [Console]::Error.WriteLine('2/4: checking the pinned Linux Node runtime')
  if (Test-Path -LiteralPath $repairNodeTree) {
    if (-not (Test-Path -LiteralPath $repairNode -PathType Leaf) -or
        (Get-RepairSetupHash -Path $repairNode) -cne $repairBinaryHash) { throw 'Existing sandbox runtime failed its pin; it was preserved unchanged.' }
  } elseif (-not $CheckOnly) {
    Assert-RepairSetupPath -Path $repairToolchain
    $null = New-Item -ItemType Directory -Path $repairToolchain -Force
    $repairStaging = Join-Path $repairToolchain ('.setup-' + [Guid]::NewGuid().ToString('N'))
    Assert-RepairSetupPath -Path $repairStaging
    $null = New-Item -ItemType Directory -Path $repairStaging
    $archive = Join-Path $repairStaging ($repairNodeName + '.tar.xz')
    [Console]::Error.WriteLine('3/4: preparing the verified official Node archive')
    if ($ArchivePath) {
      $repairArchiveInput = Get-Item -LiteralPath $ArchivePath -Force -ErrorAction Stop
      if ($repairArchiveInput.PSIsContainer -or ($repairArchiveInput.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Offline Node archive must be a regular file.' }
      [IO.File]::Copy($repairArchiveInput.FullName, $archive, $false)
    } else {
      Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$repairVersion/$repairNodeName.tar.xz" -MaximumRedirection 0 -TimeoutSec 180 -OutFile $archive
    }
    if ((Get-RepairSetupHash -Path $archive) -cne $repairArchiveHash) { throw 'Official Node archive failed its fixed SHA-256 pin.' }
    $null = Invoke-RepairSetupWsl -Arguments @('/usr/bin/tar', '-xJf', (ConvertTo-RepairWslPath $archive), '-C', (ConvertTo-RepairWslPath $repairStaging), '--', ($repairNodeName + '/bin/node'), ($repairNodeName + '/LICENSE'))
    $extracted = Join-Path $repairStaging $repairNodeName
    $binary = Join-Path $extracted 'bin\node'
    Assert-RepairSetupPath -Path $binary
    if ((Get-RepairSetupHash -Path $binary) -cne $repairBinaryHash) { throw 'Extracted Linux Node binary failed its fixed SHA-256 pin.' }
    Assert-RepairSetupPath -Path $repairNodeTree
    if (Test-Path -LiteralPath $repairNodeTree) { throw 'Sandbox runtime appeared concurrently; existing files were preserved.' }
    Move-Item -LiteralPath $extracted -Destination $repairNodeTree -ErrorAction Stop
  }
  $ready = Test-Path -LiteralPath $repairNode -PathType Leaf
  if ($ready) {
    $version = @(Invoke-RepairSetupWsl -Arguments @((ConvertTo-RepairWslPath $repairNode), '--version'))
    if ($version.Count -ne 1 -or $version[0].Trim() -cne "v$repairVersion") { throw 'Pinned Linux Node runtime did not report its verified version.' }
  }
  [Console]::Error.WriteLine('4/4: optional sandbox setup check complete; no adapters registered or models installed')
  [pscustomobject]@{schemaVersion='source-repair-setup-v1';nodeVersion=$repairVersion;ubuntuNamespaceAvailable=$true;toolchainReady=[bool]$ready;
    toolchainPath='work/source-repairs/toolchain/node-v24.18.0-linux-x64';nodeSha256=if ($ready) {$repairBinaryHash} else {$null};checkOnly=[bool]$CheckOnly;modelsInstalled=0;adaptersRegistered=0} | ConvertTo-Json -Compress
} finally {
  if ($repairStaging -and (Test-Path -LiteralPath $repairStaging)) {
    Assert-RepairSetupPath -Path $repairStaging
    $expectedParent = [IO.Path]::GetFullPath($repairToolchain).TrimEnd('\') + '\'
    if (-not [IO.Path]::GetFullPath($repairStaging).StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($repairStaging) -notmatch '^\.setup-[0-9a-f]{32}$') { throw 'Sandbox setup cleanup is outside its owned staging area.' }
    Remove-Item -LiteralPath $repairStaging -Recurse -Force
  }
}
