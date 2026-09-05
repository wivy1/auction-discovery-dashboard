param(
  [switch]$HealthCheckOnly,
  [switch]$RequireExistingRuntime,
  [switch]$CompleteCurrentAudit,
  [switch]$ExistingCatalogOnly,
  [ValidateSet("auto", "canonical", "optimized")][string]$SchedulerMode = "auto",
  [ValidateRange(1, 3)][int]$MaxConcurrentNetworkJobs = 3,
  [ValidateRange(1, 10000)][int]$MaxDispatches = 100,
  [string]$ExpectedRuntimeRevision = ""
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\runtime.ps1"

$baseUrl = if ($env:AUCTION_DISCOVERY_URL) {
  $env:AUCTION_DISCOVERY_URL.TrimEnd("/")
} else {
  "http://localhost:3000"
}
$companionPort = if ($env:AUCTION_DISCOVERY_IMAGE_PORT) {
  [int]$env:AUCTION_DISCOVERY_IMAGE_PORT
} else {
  32110
}
$companionHealthUrl = "http://127.0.0.1:$companionPort/v1/health"
$ownedDevProcess = $null
$nightlyLock = $null
$nightlyStatus = $null
$nightlyStatusPath = Join-Path $ProjectRoot ".wrangler\logs\nightly-status.json"
$nightlyLockPath = Join-Path $ProjectRoot ".wrangler\logs\nightly.lock"
$supervisorLockPath = Join-Path $ProjectRoot ".wrangler\logs\runtime-supervisor.lock"
$runtimeRevisionSchema = "auction-discovery-runtime-revision-v1"
$runtimeRevisionPattern = '^sha256:[0-9a-f]{64}$'
$runtimeRevisionFailure = "Loaded local runtime does not match the current checkout; discovery was not started. Restart the supervised local stack."
$invocationRuntimeRevision = $null
$sourceOrderScript = Join-Path $PSScriptRoot "source-order.mts"
$sourceOrderOutput = @(& $NodeExe --import $NodeRuntimePreload --import tsx $sourceOrderScript)
if ($LASTEXITCODE -ne 0 -or $sourceOrderOutput.Count -ne 1) { throw "The source registry could not be loaded." }
$sourceOutcomeOrder = [string[]](ConvertFrom-Json -InputObject $sourceOrderOutput[0] -ErrorAction Stop)
$sourceOutcomeNames = @(
  "refreshed", "skipped_recent", "preserved", "paused", "stopped", "blocked"
)
$nightlyStageLedgerOrder = @(
  "source_acquisition",
  "projection_listing_refresh", "projection_source_refresh",
  "projection_group_refresh", "projection_global_refresh",
  "detail", "action_deadline", "owner_refresh", "factual_supplement",
  "image_evidence", "primary_image", "proximity", "enrichment_text",
  "enrichment_embedding", "preference_v2_score", "source_release",
  "source_acquisition_readiness"
)
$nightlyLedgerActiveStage = $null
$nightlyLedgerActiveStartedAt = $null
$nightlyLedgerActiveAttempt = $null

# The workflow owns one absolute five-hour terminal deadline. TypeScript admits
# a callback only while its full settlement reserve still fits; once dispatched,
# that callback is allowed to settle and reconcile without being killed or
# duplicated. D-208 permits one
# automatic retry for the same no-progress reason. A dashboard-owned invocation
# gives an existing runtime five bounded minutes to survive an ordinary dev-server
# recycle and one idle-gated child restart; an exact prior-head-preserved
# callback failure gets 60 seconds.
$workflowDeadlineHours = 5
$maximumSameReasonRetries = 1
$handlerNotReadyBackoffSeconds = 15
$priorHeadPreservedBackoffSeconds = 60
$existingRuntimeRecoverySeconds = 300
$nonTtyHeartbeatSeconds = 30

function Get-CheckoutRuntimeRevision {
  $revisionScript = (Resolve-Path `
    (Join-Path $PSScriptRoot "runtime-revision.mts")).Path
  $output = @(
    & $NodeExe `
      --import $NodeRuntimePreload `
      --import tsx `
      $revisionScript `
      2>&1
  )
  if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1) {
    throw "The checkout runtime revision could not be computed."
  }
  try {
    $payload = $output[0] | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "The checkout runtime revision returned invalid JSON."
  }
  if (
    $payload.schemaVersion -ne $runtimeRevisionSchema -or
    [string]$payload.revision -notmatch $runtimeRevisionPattern
  ) {
    throw "The checkout runtime revision returned an invalid contract."
  }
  return [string]$payload.revision
}

function Assert-LoadedRuntimeRevision {
  param([Parameter(Mandatory = $true)][string]$Expected)
  if (-not (Test-CurrentSupervisedRuntimeReady -Expected $Expected -TimeoutSec 5)) {
    throw $runtimeRevisionFailure
  }
}

function Get-DashboardSupervisorLockState {
  $lockDirectory = Split-Path -Parent $supervisorLockPath
  if (-not (Test-Path -LiteralPath $lockDirectory -PathType Container)) {
    return "absent"
  }
  $result = Enter-DashboardSupervisorLock -Path $supervisorLockPath
  if ($result.status -eq "acquired") {
    $result.stream.Dispose()
    return "absent"
  }
  if ($result.status -eq "held_by_other") { return "held" }
  throw "The local runtime supervisor lock state is indeterminate: $($result.error)"
}

function Test-SameDashboardSupervisorReceipt {
  param(
    [AllowNull()]$Left,
    [AllowNull()]$Right
  )

  return $null -ne $Left -and
    $null -ne $Right -and
    [string]$Left.schemaVersion -eq [string]$Right.schemaVersion -and
    [string]$Left.instanceId -eq [string]$Right.instanceId -and
    [int]$Left.processId -eq [int]$Right.processId -and
    [string]$Left.startedAt -eq [string]$Right.startedAt
}

function Test-DashboardSupervisorReceiptProcess {
  param(
    [Parameter(Mandatory = $true)]$Receipt,
    [AllowNull()]$Process = $null
  )

  try {
    if ($null -eq $Process) {
      $Process = Get-Process -Id ([int]$Receipt.processId) -ErrorAction Stop
    }
    $Process.Refresh()
    if ($Process.HasExited -or [int]$Receipt.processId -ne $Process.Id) {
      return $false
    }
    $receiptStartedAt = ConvertTo-DashboardSupervisorTimestamp $Receipt.startedAt
    if ($null -eq $receiptStartedAt) { return $false }
    $processStartedAt = [DateTimeOffset]::new(
      $Process.StartTime.ToUniversalTime()
    )
    return $receiptStartedAt.UtcDateTime.Ticks -eq
      $processStartedAt.UtcDateTime.Ticks
  } catch {
    return $false
  }
}

function Get-CurrentSupervisedRuntimeIdentity {
  param(
    [Parameter(Mandatory = $true)][string]$Expected,
    [ValidateRange(1, 15)][int]$TimeoutSec = 3
  )

  try {
    if ($Expected -notmatch $runtimeRevisionPattern) { return $null }
    $checkoutRevision = Get-CheckoutRuntimeRevision
    if ($checkoutRevision -ne $Expected) { return $null }
    $receipt = Read-DashboardSupervisorLockReceipt -Path $supervisorLockPath
    if (
      $null -eq $receipt -or
      (Get-DashboardSupervisorLockState) -ne "held" -or
      -not (Test-DashboardSupervisorReceiptProcess -Receipt $receipt)
    ) { return $null }
    $root = Invoke-WebRequest `
      -UseBasicParsing `
      -Method Get `
      -Uri "$baseUrl/" `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec $TimeoutSec
    if ($root.StatusCode -ne 200) { return $null }
    $appRevision = Invoke-RestMethod `
      -Method Get `
      -Uri "$baseUrl/api/internal/runtime-revision" `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec $TimeoutSec
    $appHealth = Invoke-RestMethod `
      -Method Get `
      -Uri "$baseUrl/api/internal/runtime-health" `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec $TimeoutSec
    $companionHealth = Invoke-RestMethod `
      -Method Get `
      -Uri $companionHealthUrl `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec $TimeoutSec
    if (
      $appRevision.schemaVersion -ne $runtimeRevisionSchema -or
      [string]$appRevision.revision -ne $Expected -or
      -not (Test-DashboardSupervisorRuntimeHealth `
        -Health $appHealth `
        -ExpectedRuntimeRevision $Expected) -or
      $companionHealth.status -ne "ready" -or
      $companionHealth.runtimeRevisionSchema -ne $runtimeRevisionSchema -or
      [string]$companionHealth.runtimeRevision -ne $Expected -or
      -not (Test-DashboardSupervisorRuntimeIdentity `
        -Receipt $receipt `
        -AppHealth $appHealth `
        -CompanionHealth $companionHealth `
        -ExpectedRuntimeRevision $Expected)
    ) { return $null }
    $confirmation = Read-DashboardSupervisorLockReceipt -Path $supervisorLockPath
    if (
      -not (Test-SameDashboardSupervisorReceipt -Left $receipt -Right $confirmation) -or
      (Get-DashboardSupervisorLockState) -ne "held" -or
      -not (Test-DashboardSupervisorReceiptProcess -Receipt $confirmation)
    ) { return $null }
    return [pscustomobject]@{
      schemaVersion = [string]$confirmation.schemaVersion
      instanceId = [string]$confirmation.instanceId
      processId = [int]$confirmation.processId
      startedAt = [string]$confirmation.startedAt
    }
  } catch {
    return $null
  }
}

function Test-LoadedRuntimeRevision {
  param(
    [Parameter(Mandatory = $true)][string]$Expected,
    [ValidateRange(1, 15)][int]$TimeoutSec = 3
  )

  return $null -ne (Get-CurrentSupervisedRuntimeIdentity `
    -Expected $Expected `
    -TimeoutSec $TimeoutSec)
}

function Test-CurrentSupervisedRuntimeReady {
  param(
    [Parameter(Mandatory = $true)][string]$Expected,
    [ValidateRange(1, 15)][int]$TimeoutSec = 3
  )

  return Test-LoadedRuntimeRevision -Expected $Expected -TimeoutSec $TimeoutSec
}

function Wait-LoadedRuntimeRevision {
  param(
    [Parameter(Mandatory = $true)][string]$Expected,
    [ValidateRange(1, 3600)][int]$WindowSeconds,
    [ValidateRange(1, 15)][int]$AttemptTimeoutSeconds = 3
  )

  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    $remainingSeconds = [Math]::Max(
      1,
      [Math]::Ceiling($WindowSeconds - $timer.Elapsed.TotalSeconds)
    )
    $attemptTimeout = [Math]::Min($AttemptTimeoutSeconds, $remainingSeconds)
    if (Test-CurrentSupervisedRuntimeReady `
      -Expected $Expected `
      -TimeoutSec $attemptTimeout) { return $true }
    $remainingMilliseconds = [Math]::Floor(
      [Math]::Max(0, ($WindowSeconds - $timer.Elapsed.TotalSeconds) * 1000)
    )
    if ($remainingMilliseconds -gt 0) {
      Start-Sleep -Milliseconds ([Math]::Min(500, $remainingMilliseconds))
    }
  } while ($timer.Elapsed.TotalSeconds -lt $WindowSeconds)
  return $false
}

function Test-HttpEndpointObserved {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [ValidateRange(1, 5)][int]$TimeoutSec = 2
  )

  try {
    Invoke-WebRequest `
      -UseBasicParsing `
      -Method Get `
      -Uri $Uri `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec $TimeoutSec | Out-Null
    return $true
  } catch {
    return $null -ne $_.Exception.Response
  }
}

function Get-ExistingRuntimeObservation {
  $dashboardObserved = Test-HttpEndpointObserved -Uri "$baseUrl/"
  $companionObserved = Test-HttpEndpointObserved -Uri $companionHealthUrl
  $supervisorHeld = (Get-DashboardSupervisorLockState) -eq "held"
  return [pscustomobject]@{
    DashboardObserved = $dashboardObserved
    CompanionObserved = $companionObserved
    SupervisorHeld = $supervisorHeld
    AnyObserved = $dashboardObserved -or $companionObserved -or $supervisorHeld
  }
}

function Write-NightlyStatus {
  param(
    [Parameter(Mandatory = $true)][string]$Stage,
    [Parameter(Mandatory = $true)][string]$Message,
    [ValidateSet("running", "completed", "failed")][string]$State = "running",
    [AllowNull()]
    [ValidateSet(
      "running", "completed", "failed", "checkpoint_paused",
      "core_complete_maintenance_deferred"
    )]
    [string]$WorkflowState = $null,
    [AllowNull()][string]$Failure = $null,
    [switch]$Ended
  )
  if ($null -eq $script:nightlyStatus) { return }
  $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $script:nightlyStatus["stage"] = $Stage
  $script:nightlyStatus["message"] = $Message
  $script:nightlyStatus["state"] = $State
  $script:nightlyStatus["workflowState"] = if ([string]::IsNullOrEmpty($WorkflowState)) {
    $State
  } else {
    $WorkflowState
  }
  $script:nightlyStatus["updatedAt"] = $now
  $script:nightlyStatus["endedAt"] = if ($Ended) { $now } else { $null }
  $script:nightlyStatus["error"] = $Failure
  $temporaryPath = "$nightlyStatusPath.tmp.$PID.$([Guid]::NewGuid().ToString('N'))"
  $encoding = New-Object System.Text.UTF8Encoding($false)
  try {
    [System.IO.File]::WriteAllText(
      $temporaryPath,
      (($script:nightlyStatus | ConvertTo-Json -Depth 6 -Compress) + "`n"),
      $encoding
    )
    Move-Item -LiteralPath $temporaryPath -Destination $nightlyStatusPath -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
}

function Test-JsonNonnegativeInteger {
  param([AllowNull()]$Value)
  if ($null -eq $Value -or $Value -is [bool] -or $Value -isnot [ValueType]) {
    return $false
  }
  try {
    $number = [double]$Value
    return -not [double]::IsNaN($number) -and
      -not [double]::IsInfinity($number) -and
      $number -ge 0 -and
      $number -le 9007199254740991 -and
      [Math]::Floor($number) -eq $number
  } catch {
    return $false
  }
}

function ConvertTo-NightlyProximityProgress {
  param([AllowNull()]$Value)
  $empty = [ordered]@{
    queued = $null
    claimed = $null
    completed = $null
    stale = $null
    remaining = $null
  }
  if ($null -eq $Value) { return [pscustomobject]$empty }
  $expected = @("queued", "claimed", "completed", "stale", "remaining")
  $properties = @($Value.PSObject.Properties.Name)
  if (
    $properties.Count -ne $expected.Count -or
    @($expected | Where-Object { $_ -notin $properties }).Count -gt 0
  ) { return $null }
  $values = @($Value.queued, $Value.claimed, $Value.completed, $Value.stale, $Value.remaining)
  if (@($values | Where-Object { $null -ne $_ }).Count -eq 0) {
    return [pscustomobject]$empty
  }
  if (
    @($values | Where-Object { -not (Test-JsonNonnegativeInteger $_) }).Count -gt 0 -or
    [double]$Value.claimed -gt [double]$Value.queued -or
    [double]$Value.completed + [double]$Value.stale -gt [double]$Value.claimed -or
    [double]$Value.remaining -ne [double]$Value.queued - [double]$Value.completed
  ) { return $null }
  return [pscustomobject][ordered]@{
    queued = [long]$Value.queued
    claimed = [long]$Value.claimed
    completed = [long]$Value.completed
    stale = [long]$Value.stale
    remaining = [long]$Value.remaining
  }
}

function ConvertTo-NightlyPrimaryImageProgress {
  param([AllowNull()]$Value)
  $empty = [ordered]@{
    ready = $null
    deferred = $null
    claimed = $null
    remaining = $null
  }
  if ($null -eq $Value) { return [pscustomobject]$empty }
  $expected = @("ready", "deferred", "claimed", "remaining")
  $properties = @($Value.PSObject.Properties.Name)
  if (
    $properties.Count -ne $expected.Count -or
    @($expected | Where-Object { $_ -notin $properties }).Count -gt 0
  ) { return $null }
  $values = @($Value.ready, $Value.deferred, $Value.claimed, $Value.remaining)
  if (@($values | Where-Object { $null -ne $_ }).Count -eq 0) {
    return [pscustomobject]$empty
  }
  if (
    @($values | Where-Object { -not (Test-JsonNonnegativeInteger $_) }).Count -gt 0 -or
    [double]$Value.remaining -ne
      [double]$Value.ready + [double]$Value.deferred + [double]$Value.claimed
  ) { return $null }
  return [pscustomobject][ordered]@{
    ready = [long]$Value.ready
    deferred = [long]$Value.deferred
    claimed = [long]$Value.claimed
    remaining = [long]$Value.remaining
  }
}

function ConvertTo-NightlyEnrichmentProgress {
  param([Parameter(Mandatory = $true)]$Value)
  $expected = @("scope", "queued", "claimed", "completed", "stale", "remaining")
  $properties = @($Value.PSObject.Properties.Name)
  if (
    $properties.Count -ne $expected.Count -or
    @($expected | Where-Object { $_ -notin $properties }).Count -gt 0 -or
    $Value.scope -ne "enrichment_text+enrichment_embedding"
  ) { return $null }
  foreach ($name in @("queued", "claimed", "completed", "stale", "remaining")) {
    if ($null -ne $Value.$name -and -not (Test-JsonNonnegativeInteger $Value.$name)) {
      return $null
    }
  }
  return [pscustomobject][ordered]@{
    scope = "enrichment_text+enrichment_embedding"
    queued = if ($null -eq $Value.queued) { $null } else { [long]$Value.queued }
    claimed = if ($null -eq $Value.claimed) { $null } else { [long]$Value.claimed }
    completed = if ($null -eq $Value.completed) { $null } else { [long]$Value.completed }
    stale = if ($null -eq $Value.stale) { $null } else { [long]$Value.stale }
    remaining = if ($null -eq $Value.remaining) { $null } else { [long]$Value.remaining }
  }
}

function ConvertTo-NightlyPrimaryImageSession {
  param([Parameter(Mandatory = $true)]$Value)
  $expected = @("sourceId", "attempted", "archived", "failed", "remainingWork", "stopReason")
  $properties = @($Value.PSObject.Properties.Name)
  if (
    $properties.Count -ne $expected.Count -or
    @($expected | Where-Object { $_ -notin $properties }).Count -gt 0 -or
    $Value.sourceId -isnot [string] -or
    [string]::IsNullOrWhiteSpace([string]$Value.sourceId) -or
    $Value.sourceId.Length -gt 128 -or
    -not (Test-JsonNonnegativeInteger $Value.attempted) -or
    -not (Test-JsonNonnegativeInteger $Value.archived) -or
    -not (Test-JsonNonnegativeInteger $Value.failed) -or
    [double]$Value.archived + [double]$Value.failed -ne [double]$Value.attempted -or
    $Value.remainingWork -isnot [bool] -or
    ($null -ne $Value.stopReason -and (
      $Value.stopReason -isnot [string] -or
      [string]::IsNullOrWhiteSpace([string]$Value.stopReason) -or
      $Value.stopReason.Length -gt 128
    ))
  ) { return $null }
  return [pscustomobject][ordered]@{
    sourceId = [string]$Value.sourceId
    attempted = [long]$Value.attempted
    archived = [long]$Value.archived
    failed = [long]$Value.failed
    remainingWork = [bool]$Value.remainingWork
    stopReason = if ($null -eq $Value.stopReason) { $null } else { [string]$Value.stopReason }
  }
}

function Test-JsonProgressPercent {
  param([AllowNull()]$Value)
  if ($null -eq $Value -or $Value -is [bool] -or $Value -isnot [ValueType]) {
    return $false
  }
  try {
    $number = [double]$Value
    return -not [double]::IsNaN($number) -and
      -not [double]::IsInfinity($number) -and
      $number -ge 0 -and
      $number -le 100
  } catch {
    return $false
  }
}

function Test-JsonNonnegativeFiniteNumber {
  param([AllowNull()]$Value)
  if ($null -eq $Value -or $Value -is [bool] -or $Value -isnot [ValueType]) {
    return $false
  }
  try {
    $number = [double]$Value
    return -not [double]::IsNaN($number) -and
      -not [double]::IsInfinity($number) -and
      $number -ge 0
  } catch {
    return $false
  }
}

function ConvertTo-CanonicalNightlyTimestamp {
  param([AllowNull()]$Value)
  if ($Value -isnot [string]) { return $null }
  $parsed = [DateTimeOffset]::MinValue
  if (-not [DateTimeOffset]::TryParseExact(
    [string]$Value,
    "yyyy-MM-ddTHH:mm:ss.fffZ",
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::AssumeUniversal,
    [ref]$parsed
  )) { return $null }
  return $parsed.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
}

function ConvertTo-NightlyPreferenceV2Progress {
  param([Parameter(Mandatory = $true)]$Value)
  $expected = @(
    "queueBefore", "selected", "completed", "reused", "newlyScored", "stale",
    "queueAfter", "remaining", "lastProgressAt", "elapsedMs",
    "throughputRowsPerSecond", "estimatedRemainingMs", "stopReason"
  )
  $properties = @($Value.PSObject.Properties.Name)
  if (
    $properties.Count -ne $expected.Count -or
    @($expected | Where-Object { $_ -notin $properties }).Count -gt 0
  ) { return $null }
  foreach ($name in @(
    "queueBefore", "selected", "completed", "reused", "newlyScored", "stale",
    "queueAfter", "remaining"
  )) {
    if (-not (Test-JsonNonnegativeInteger $Value.$name)) { return $null }
  }
  if (
    [long]$Value.selected -gt 10 -or
    [long]$Value.selected -gt [long]$Value.queueBefore -or
    [long]$Value.queueAfter -gt [long]$Value.queueBefore -or
    [long]$Value.completed -ne [long]$Value.queueBefore - [long]$Value.queueAfter -or
    [long]$Value.completed -gt [long]$Value.selected -or
    [long]$Value.reused + [long]$Value.newlyScored -gt [long]$Value.selected -or
    [long]$Value.stale -gt [long]$Value.selected -or
    [long]$Value.remaining -ne [long]$Value.queueAfter -or
    -not (Test-JsonNonnegativeFiniteNumber $Value.elapsedMs)
  ) { return $null }
  $lastProgressAt = ConvertTo-CanonicalNightlyTimestamp $Value.lastProgressAt
  if (
    ([long]$Value.completed -eq 0 -and $null -ne $Value.lastProgressAt) -or
    ([long]$Value.completed -gt 0 -and $null -eq $lastProgressAt)
  ) { return $null }
  $throughput = if ($null -eq $Value.throughputRowsPerSecond) {
    $null
  } elseif (
    (Test-JsonNonnegativeFiniteNumber $Value.throughputRowsPerSecond) -and
    [double]$Value.throughputRowsPerSecond -gt 0
  ) {
    [double]$Value.throughputRowsPerSecond
  } else {
    return $null
  }
  $estimatedRemainingMs = if ($null -eq $Value.estimatedRemainingMs) {
    $null
  } elseif (Test-JsonNonnegativeFiniteNumber $Value.estimatedRemainingMs) {
    [double]$Value.estimatedRemainingMs
  } else {
    return $null
  }
  if (
    (([long]$Value.completed -gt 0 -and [double]$Value.elapsedMs -gt 0) -ne
      ($null -ne $throughput)) -or
    ([long]$Value.remaining -eq 0 -and
      ($null -eq $estimatedRemainingMs -or [double]$estimatedRemainingMs -ne 0)) -or
    ([long]$Value.remaining -gt 0 -and
      (($null -eq $throughput) -ne ($null -eq $estimatedRemainingMs))) -or
    [string]$Value.stopReason -ne $(
      if ([long]$Value.remaining -eq 0) { "queue_empty" } else { "quantum" }
    )
  ) { return $null }
  return [pscustomobject][ordered]@{
    queueBefore = [long]$Value.queueBefore
    selected = [long]$Value.selected
    completed = [long]$Value.completed
    reused = [long]$Value.reused
    newlyScored = [long]$Value.newlyScored
    stale = [long]$Value.stale
    queueAfter = [long]$Value.queueAfter
    remaining = [long]$Value.remaining
    lastProgressAt = $lastProgressAt
    elapsedMs = [double]$Value.elapsedMs
    throughputRowsPerSecond = $throughput
    estimatedRemainingMs = $estimatedRemainingMs
    stopReason = [string]$Value.stopReason
  }
}

function Resolve-NightlyPreferenceV2Remaining {
  param(
    [AllowNull()]$Result,
    [AllowNull()]$RetainedRemaining
  )

  $progressProperty = if ($null -eq $Result) {
    $null
  } else {
    $Result.PSObject.Properties["preferenceV2Progress"]
  }
  if ($null -ne $progressProperty -and $null -ne $progressProperty.Value) {
    $progress = ConvertTo-NightlyPreferenceV2Progress $progressProperty.Value
    if ($null -eq $progress) {
      throw "The TypeScript nightly scheduler returned malformed Preference V2 progress."
    }
    return [long]$progress.remaining
  }
  if ($null -eq $RetainedRemaining) { return $null }
  if (-not (Test-JsonNonnegativeInteger $RetainedRemaining)) {
    throw "The retained Preference V2 queue count is malformed."
  }
  return [long]$RetainedRemaining
}

function ConvertTo-NightlyPreferenceV2SessionDiagnostics {
  param([Parameter(Mandatory = $true)]$Value)
  $expected = @(
    "sourceDataVersion", "sessionStatus", "snapshotCreationElapsedMs",
    "sessionElapsedMs", "rowsPerBatch", "reusableRows", "newlyScoredRows",
    "materializerInvocations", "pythonProcesses", "materializationElapsedMs",
    "inferenceElapsedMs", "scoreImportElapsedMs"
  )
  $properties = @($Value.PSObject.Properties.Name)
  if (
    $properties.Count -ne $expected.Count -or
    @($expected | Where-Object { $_ -notin $properties }).Count -gt 0
  ) { return $null }
  foreach ($name in @(
    "sourceDataVersion", "rowsPerBatch", "reusableRows", "newlyScoredRows",
    "materializerInvocations", "pythonProcesses"
  )) {
    if (-not (Test-JsonNonnegativeInteger $Value.$name)) { return $null }
  }
  foreach ($name in @(
    "snapshotCreationElapsedMs", "sessionElapsedMs", "materializationElapsedMs",
    "inferenceElapsedMs", "scoreImportElapsedMs"
  )) {
    if (
      -not (Test-JsonNonnegativeFiniteNumber $Value.$name) -or
      [double]$Value.$name -gt 1200000
    ) { return $null }
  }
  if (
    [long]$Value.rowsPerBatch -lt 1 -or [long]$Value.rowsPerBatch -gt 10 -or
    [long]$Value.reusableRows -gt [long]$Value.rowsPerBatch -or
    [long]$Value.newlyScoredRows -gt [long]$Value.rowsPerBatch -or
    [long]$Value.reusableRows + [long]$Value.newlyScoredRows -gt
      [long]$Value.rowsPerBatch -or
    [long]$Value.materializerInvocations -gt 1 -or
    [long]$Value.pythonProcesses -gt 1 -or
    ([long]$Value.materializerInvocations -eq 0 -and
      [double]$Value.materializationElapsedMs -ne 0) -or
    ([long]$Value.pythonProcesses -eq 0 -and
      [double]$Value.inferenceElapsedMs -ne 0) -or
    [double]$Value.materializationElapsedMs -gt [double]$Value.sessionElapsedMs -or
    [double]$Value.inferenceElapsedMs -gt [double]$Value.sessionElapsedMs -or
    [double]$Value.scoreImportElapsedMs -gt [double]$Value.sessionElapsedMs -or
    [string]$Value.sessionStatus -notin @("up_to_date", "scored", "stale", "coverage_only")
  ) { return $null }
  return [pscustomobject][ordered]@{
    sourceDataVersion = [long]$Value.sourceDataVersion
    sessionStatus = [string]$Value.sessionStatus
    snapshotCreationElapsedMs = [double]$Value.snapshotCreationElapsedMs
    sessionElapsedMs = [double]$Value.sessionElapsedMs
    rowsPerBatch = [long]$Value.rowsPerBatch
    reusableRows = [long]$Value.reusableRows
    newlyScoredRows = [long]$Value.newlyScoredRows
    materializerInvocations = [long]$Value.materializerInvocations
    pythonProcesses = [long]$Value.pythonProcesses
    materializationElapsedMs = [double]$Value.materializationElapsedMs
    inferenceElapsedMs = [double]$Value.inferenceElapsedMs
    scoreImportElapsedMs = [double]$Value.scoreImportElapsedMs
  }
}

function ConvertTo-NightlyPreferenceV2ScorerError {
  param([AllowNull()]$Value)
  if ($null -eq $Value) { return $null }
  $required = @("schemaVersion", "code", "stage", "retryable", "message")
  $allowed = @(
    "schemaVersion", "code", "stage", "retryable", "message",
    "affectedCount", "context"
  )
  $properties = @($Value.PSObject.Properties.Name)
  if (
    @($required | Where-Object { $_ -notin $properties }).Count -gt 0 -or
    @($properties | Where-Object { $_ -notin $allowed }).Count -gt 0
  ) { return $null }
  $codes = @(
    "preference_v2_input_invalid", "preference_v2_artifact_invalid",
    "preference_v2_inference_failed", "preference_v2_output_invalid",
    "preference_v2_io_failed", "preference_v2_timeout",
    "preference_v2_cancelled", "preference_v2_scorer_failed"
  )
  $stages = @(
    "scorer_input", "scorer_materialization", "scorer_inference",
    "scorer_validation", "scorer_io", "scorer_process"
  )
  if (
    [string]$Value.schemaVersion -ne "preference-v2-scorer-error-v1" -or
    $Value.code -isnot [string] -or [string]$Value.code -notin $codes -or
    $Value.stage -isnot [string] -or [string]$Value.stage -notin $stages -or
    $Value.retryable -isnot [bool] -or $Value.message -isnot [string] -or
    [string]::IsNullOrWhiteSpace([string]$Value.message) -or
    ([string]$Value.message).Length -gt 240 -or
    [string]$Value.message -ne ([string]$Value.message).Trim() -or
    [string]$Value.message -match '[\x00-\x1f\x7f]'
  ) { return $null }
  $result = [ordered]@{
    schemaVersion = "preference-v2-scorer-error-v1"
    code = [string]$Value.code
    stage = [string]$Value.stage
    retryable = [bool]$Value.retryable
    message = [string]$Value.message
  }
  $affectedProperty = $Value.PSObject.Properties["affectedCount"]
  if ($null -ne $affectedProperty) {
    if (
      -not (Test-JsonNonnegativeInteger $affectedProperty.Value) -or
      [long]$affectedProperty.Value -gt 25000
    ) { return $null }
    $result["affectedCount"] = [long]$affectedProperty.Value
  }
  $contextProperty = $Value.PSObject.Properties["context"]
  if ($null -ne $contextProperty) {
    if ($null -eq $contextProperty.Value) { return $null }
    $contextProperties = @($contextProperty.Value.PSObject.Properties.Name)
    if (
      "errorType" -notin $contextProperties -or
      @($contextProperties | Where-Object { $_ -notin @("errorType", "exitCode") }).Count -gt 0 -or
      $contextProperty.Value.errorType -isnot [string] -or
      [string]$contextProperty.Value.errorType -notin @(
        "input", "artifact", "inference", "validation", "io", "timeout",
        "cancelled", "unknown"
      )
    ) { return $null }
    $context = [ordered]@{ errorType = [string]$contextProperty.Value.errorType }
    $exitCodeProperty = $contextProperty.Value.PSObject.Properties["exitCode"]
    if ($null -ne $exitCodeProperty) {
      $exitCode = $exitCodeProperty.Value
      if (
        $exitCode -is [bool] -or $exitCode -isnot [ValueType] -or
        [double]$exitCode -lt -1 -or [double]$exitCode -gt 255 -or
        [Math]::Floor([double]$exitCode) -ne [double]$exitCode
      ) { return $null }
      $context["exitCode"] = [long]$exitCode
    }
    $result["context"] = [pscustomobject]$context
  }
  return [pscustomobject]$result
}

function Test-SafeRuntimeIdentity {
  param([AllowNull()]$Value, [ValidateRange(1, 4096)][int]$MaximumLength = 1024)
  return $Value -is [string] -and
    -not [string]::IsNullOrWhiteSpace([string]$Value) -and
    ([string]$Value).Length -le $MaximumLength -and
    [string]$Value -notmatch '[\x00-\x1f\x7f]'
}

function Assert-SourceOutcomeVector {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()]$SourceOutcomes,
    [Parameter(Mandatory = $true)][ValidateRange(0, 10000)][int]$ExpectedSourceCount,
    [switch]$AllowPartial
  )
  $outcomes = @($SourceOutcomes)
  if (
    $ExpectedSourceCount -gt $sourceOutcomeOrder.Count -or
    $outcomes.Count -gt $ExpectedSourceCount -or
    (-not $AllowPartial -and $outcomes.Count -ne $ExpectedSourceCount)
  ) {
    throw "The TypeScript nightly scheduler returned an incomplete source outcome vector."
  }
  $entryProperties = @(
    "sourceId", "outcome", "dependencySatisfied", "reasonCode", "priorHead",
    "resultingHead", "nextEligibleAt", "proofIdentity", "receiptIdentity"
  )
  $previousSourceOrderIndex = -1
  for ($index = 0; $index -lt $outcomes.Count; $index += 1) {
    $entry = $outcomes[$index]
    $properties = @($entry.PSObject.Properties.Name)
    $sourceOrderIndex = if ($null -eq $entry) {
      -1
    } else {
      [Array]::IndexOf([string[]]$sourceOutcomeOrder, [string]$entry.sourceId)
    }
    if (
      $null -eq $entry -or
      $properties.Count -ne $entryProperties.Count -or
      @($entryProperties | Where-Object { $_ -notin $properties }).Count -gt 0 -or
      $sourceOrderIndex -le $previousSourceOrderIndex -or
      $entry.outcome -notin $sourceOutcomeNames -or
      $entry.dependencySatisfied -isnot [bool] -or
      -not (Test-SafeRuntimeIdentity $entry.reasonCode -MaximumLength 128)
    ) {
      throw "The TypeScript nightly scheduler returned a malformed source outcome vector."
    }
    $previousSourceOrderIndex = $sourceOrderIndex
    foreach ($headName in @("priorHead", "resultingHead")) {
      $head = $entry.$headName
      if ($null -eq $head) { continue }
      $headProperties = @($head.PSObject.Properties.Name)
      if (
        $headProperties.Count -ne 2 -or
        "inventoryRunId" -notin $headProperties -or
        "listingCount" -notin $headProperties -or
        -not (Test-SafeRuntimeIdentity $head.inventoryRunId) -or
        -not (Test-JsonNonnegativeInteger $head.listingCount)
      ) {
        throw "The TypeScript nightly scheduler returned a malformed source publication head."
      }
    }
    if (($entry.outcome -eq "paused") -ne ($null -ne $entry.nextEligibleAt)) {
      throw "The TypeScript nightly scheduler returned a contradictory source retry boundary."
    }
    if ($null -ne $entry.nextEligibleAt) {
      $parsedEligibleAt = [DateTimeOffset]::MinValue
      if (
        $entry.outcome -ne "paused" -or
        $entry.nextEligibleAt -isnot [string] -or
        -not [DateTimeOffset]::TryParse(
          [string]$entry.nextEligibleAt,
          [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::RoundtripKind,
          [ref]$parsedEligibleAt
        )
      ) {
        throw "The TypeScript nightly scheduler returned a malformed source retry boundary."
      }
    }
    $refreshed = $entry.outcome -eq "refreshed"
    $skippedRecent = $entry.outcome -eq "skipped_recent"
    $verified = $refreshed -or $skippedRecent
    if (
      [bool]$entry.dependencySatisfied -ne $verified -or
      $verified -ne ($null -ne $entry.resultingHead) -or
      ($verified -and -not (Test-SafeRuntimeIdentity $entry.proofIdentity)) -or
      (-not $verified -and $null -ne $entry.proofIdentity) -or
      ($verified -and -not (Test-SafeRuntimeIdentity $entry.receiptIdentity)) -or
      (-not $verified -and $null -ne $entry.receiptIdentity) -or
      ($skippedRecent -and $entry.reasonCode -ne "recent_verified_publication") -or
      ($skippedRecent -and $null -eq $entry.priorHead) -or
      ($skippedRecent -and (
        $entry.priorHead.inventoryRunId -ne $entry.resultingHead.inventoryRunId -or
        [int64]$entry.priorHead.listingCount -ne [int64]$entry.resultingHead.listingCount
      ))
    ) {
      throw "The TypeScript nightly scheduler returned contradictory source outcome evidence."
    }
  }
}

function Set-NightlySourceOutcomes {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()]$SourceOutcomes,
    [Parameter(Mandatory = $true)][ValidateRange(0, 10000)][int]$ExpectedSourceCount,
    [switch]$AllowPartial
  )
  Assert-SourceOutcomeVector -SourceOutcomes $SourceOutcomes -ExpectedSourceCount $ExpectedSourceCount -AllowPartial:$AllowPartial
  $outcomes = @($SourceOutcomes)
  $counts = [ordered]@{
    refreshed = @($outcomes | Where-Object { $_.outcome -eq "refreshed" }).Count
    skipped_recent = @($outcomes | Where-Object { $_.outcome -eq "skipped_recent" }).Count
    preserved = @($outcomes | Where-Object { $_.outcome -eq "preserved" }).Count
    paused = @($outcomes | Where-Object { $_.outcome -eq "paused" }).Count
    stopped = @($outcomes | Where-Object { $_.outcome -eq "stopped" }).Count
    blocked = @($outcomes | Where-Object { $_.outcome -eq "blocked" }).Count
  }
  $script:nightlyStatus["sourceOutcomes"] = $outcomes
  $script:nightlyStatus["sourceOutcomeCounts"] = $counts
  $script:nightlyStatus["campaignSourcesCompleted"] = $outcomes.Count
  $script:nightlyStatus["campaignSourcesTotal"] = $ExpectedSourceCount
}

function Get-NightlySchedulerResult {
  param([Parameter(Mandatory = $true)]$Summary)
  $resultProperty = $Summary.PSObject.Properties["result"]
  if ($null -eq $resultProperty) { return $null }
  return $resultProperty.Value
}

function Update-NightlyPreferenceV2ScorerErrorFromResult {
  param([AllowNull()]$Result)
  if ($null -eq $script:nightlyStatus -or $null -eq $Result) { return }
  $errorProperty = $Result.PSObject.Properties["preferenceV2ScorerError"]
  if ($null -ne $errorProperty) {
    $parsed = ConvertTo-NightlyPreferenceV2ScorerError $errorProperty.Value
    if ($null -eq $parsed) {
      throw "The TypeScript nightly scheduler returned a malformed Preference V2 scorer error."
    }
    $script:nightlyStatus["preferenceV2ScorerError"] = $parsed
    return
  }
  $progressProperty = $Result.PSObject.Properties["preferenceV2Progress"]
  if (
    $null -ne $progressProperty -and
    $null -ne $progressProperty.Value -and
    $null -ne (ConvertTo-NightlyPreferenceV2Progress $progressProperty.Value)
  ) {
    $script:nightlyStatus["preferenceV2ScorerError"] = $null
  }
}

function Get-SafeSchedulerReasonCodes {
  param([Parameter(Mandatory = $true)]$Summary)
  $codes = @()
  $result = Get-NightlySchedulerResult -Summary $Summary
  if ($null -ne $result) {
    $codes = @($result.tailReasonCodes)
  } elseif ($null -ne $Summary.readiness) {
    $codes = @($Summary.readiness.missingSeams)
  }
  if ($codes.Count -eq 0) { return @([string]$Summary.classification) }
  foreach ($code in $codes) {
    if (
      $code -isnot [string] -or
      $code -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ) {
      throw "The TypeScript nightly scheduler returned an unsafe reason code."
    }
  }
  return @($codes | Sort-Object -Unique)
}

function Get-CanonicalContinuationProgressComparison {
  param(
    [Parameter(Mandatory = $true)]$Summary,
    [switch]$Required
  )
  $receiptProperty = $Summary.PSObject.Properties["continuationProgress"]
  $receipt = if ($null -eq $receiptProperty) {
    $null
  } else {
    $receiptProperty.Value
  }
  if ($null -eq $receipt) {
    if ($Required) {
      throw "The retryable canonical scheduler result omitted its durable progress receipt."
    }
    return $null
  }
  $properties = @($receipt.PSObject.Properties.Name)
  $requiredProperties = @(
    "schemaVersion", "comparison", "beforeHash", "afterHash"
  )
  if (
    $properties.Count -ne $requiredProperties.Count -or
    @($requiredProperties | Where-Object { $_ -notin $properties }).Count -gt 0 -or
    $receipt.schemaVersion -ne
      "auction-discovery-canonical-continuation-progress-receipt-v2" -or
    $receipt.comparison -notin @("advanced", "no_progress") -or
    $receipt.beforeHash -isnot [string] -or
    $receipt.beforeHash -notmatch '^sha256:[0-9a-f]{64}$' -or
    $receipt.afterHash -isnot [string] -or
    $receipt.afterHash -notmatch '^sha256:[0-9a-f]{64}$' -or
    ($receipt.comparison -eq "advanced" -and
      $receipt.beforeHash -eq $receipt.afterHash)
  ) {
    throw "The TypeScript nightly scheduler returned a malformed durable progress receipt."
  }
  return [string]$receipt.comparison
}

function Assert-NightlySchedulerSummary {
  param(
    [Parameter(Mandatory = $true)]$Summary,
    [Parameter(Mandatory = $true)][int]$ExitCode,
    [Parameter(Mandatory = $true)]
    [ValidateSet("auto", "canonical", "optimized")]
    [string]$Mode,
    [switch]$PreparationOnly
  )
  if (
    $null -eq $Summary -or
    $Summary.schemaVersion -ne "auction-discovery-nightly-scheduler-cli-v1"
  ) {
    throw "The TypeScript nightly scheduler returned a malformed summary."
  }
  $classifications = @(
    "clean_empty", "future_deferred", "retryable_pressure",
    "deterministic_terminal", "access_stop", "no_progress",
    "handler_not_ready", "handler_failure_prior_head_preserved",
    "handler_failure_state_ambiguous", "bounded_quantum_exhausted",
    "checkpoint_paused", "core_complete_maintenance_deferred"
  )
  if ($Summary.classification -notin $classifications) {
    throw "The TypeScript nightly scheduler returned an unsupported classification."
  }
  if ($null -eq $Summary.readiness) {
    throw "The TypeScript nightly scheduler omitted its readiness summary."
  }
  if ($Summary.readiness.selectedMode -notin @("canonical", "optimized")) {
    throw "The TypeScript nightly scheduler returned an unsupported selected mode."
  }
  if (-not (Test-JsonNonnegativeInteger $Summary.readiness.sourceCount) -or
      [double]$Summary.readiness.sourceCount -gt $sourceOutcomeOrder.Count) {
    throw "The TypeScript nightly scheduler returned an invalid source population count."
  }
  $missingSeams = @($Summary.readiness.missingSeams)
  foreach ($seam in $missingSeams) {
    if (
      $seam -isnot [string] -or
      $seam -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ) {
      throw "The TypeScript nightly scheduler returned an unsafe readiness reason."
    }
  }
  $result = Get-NightlySchedulerResult -Summary $Summary
  if ($null -ne $result) {
    $resultProperties = @($result.PSObject.Properties.Name)
    $requiredResultProperties = @(
      "classification", "completed", "deterministicTerminals",
      "earliestAvailableAt", "tailCandidateIds", "tailReasonCodes",
      "preparationProgressCandidateIds", "proximityProgress", "sourceOutcomes"
    )
    if (@($requiredResultProperties | Where-Object { $_ -notin $resultProperties }).Count -gt 0) {
      throw "The TypeScript nightly scheduler returned an incomplete durable result."
    }
    if ($result.classification -ne $Summary.classification) {
      throw "The TypeScript nightly scheduler summary classifications disagree."
    }
    $sourceOutcomesProperty = $result.PSObject.Properties["sourceOutcomes"]
    if ($null -eq $sourceOutcomesProperty) {
      throw "The terminal TypeScript nightly scheduler result omitted its source outcome vector."
    }
    $deadlineCheckpoint =
      $Summary.classification -eq "checkpoint_paused" -and
      @($result.tailReasonCodes) -contains
        "workflow_deadline_settlement_reserve_exhausted"
    if ($Mode -eq "canonical" -or $PreparationOnly) {
      if (
        $null -eq $sourceOutcomesProperty.Value -or
        @($sourceOutcomesProperty.Value).Count -ne 0
      ) {
        if ($PreparationOnly) {
          throw "The preparation-only scheduler must return an empty source outcome vector."
        }
        throw "The explicit canonical scheduler must return an empty source outcome vector."
      }
    } else {
      Assert-SourceOutcomeVector `
        -SourceOutcomes $sourceOutcomesProperty.Value `
        -ExpectedSourceCount ([int]$Summary.readiness.sourceCount) `
        -AllowPartial:$deadlineCheckpoint
    }
    if (
      -not (Test-JsonNonnegativeInteger $result.completed) -or
      -not (Test-JsonNonnegativeInteger $result.deterministicTerminals)
    ) {
      throw "The TypeScript nightly scheduler returned malformed progress accounting."
    }
    if ($null -eq (ConvertTo-NightlyProximityProgress $result.proximityProgress)) {
      throw "The TypeScript nightly scheduler returned malformed proximity progress."
    }
    foreach ($scopeName in @("coreProgress", "maintenanceProgress")) {
      $scopeProperty = $result.PSObject.Properties[$scopeName]
      if (
        $null -ne $scopeProperty -and
        $null -eq (ConvertTo-NightlyPrimaryImageProgress $scopeProperty.Value)
      ) {
        throw "The TypeScript nightly scheduler returned malformed scoped preparation progress."
      }
    }
    $preferenceV2ScorerErrorProperty =
      $result.PSObject.Properties["preferenceV2ScorerError"]
    if (
      $null -ne $preferenceV2ScorerErrorProperty -and
      $null -eq (ConvertTo-NightlyPreferenceV2ScorerError `
        $preferenceV2ScorerErrorProperty.Value)
    ) {
      throw "The TypeScript nightly scheduler returned a malformed Preference V2 scorer error."
    }
    foreach ($candidateId in @($result.tailCandidateIds)) {
      if (
        $candidateId -isnot [string] -or
        [string]::IsNullOrWhiteSpace($candidateId) -or
        $candidateId.Length -gt 1024 -or
        $candidateId -match '[\x00-\x1f\x7f]'
      ) {
        throw "The TypeScript nightly scheduler returned an unsafe tail candidate identity."
      }
    }
    $preparationProgressCandidateIds = @($result.preparationProgressCandidateIds)
    if ($preparationProgressCandidateIds.Count -gt 10000) {
      throw "The TypeScript nightly scheduler returned too many preparation progress identities."
    }
    $previousPreparationProgressCandidateId = $null
    foreach ($candidateId in $preparationProgressCandidateIds) {
      if (
        $candidateId -isnot [string] -or
        [string]::IsNullOrWhiteSpace($candidateId) -or
        $candidateId.Length -gt 1024 -or
        $candidateId -match '[\x00-\x1f\x7f]'
      ) {
        throw "The TypeScript nightly scheduler returned an unsafe preparation progress identity."
      }
      if (
        $null -ne $previousPreparationProgressCandidateId -and
        [string]::CompareOrdinal(
          [string]$previousPreparationProgressCandidateId,
          [string]$candidateId
        ) -ge 0
      ) {
        throw "The TypeScript nightly scheduler returned unsorted or duplicate preparation progress identities."
      }
      $previousPreparationProgressCandidateId = [string]$candidateId
    }
    $preparationNoProgressProperty =
      $result.PSObject.Properties["preparationNoProgressIdentities"]
    $preparationNoProgressIdentities = @()
    if ($null -ne $preparationNoProgressProperty) {
      $preparationNoProgressIdentities =
        @($preparationNoProgressProperty.Value)
    }
    if ($preparationNoProgressIdentities.Count -gt 10000) {
      throw "The TypeScript nightly scheduler returned too many preparation no-progress identities."
    }
    $previousPreparationNoProgressIdentity = $null
    foreach ($identity in $preparationNoProgressIdentities) {
      if (
        $identity -isnot [string] -or
        [string]::IsNullOrWhiteSpace($identity) -or
        $identity.Length -gt 512 -or
        $identity -match '[\x00-\x1f\x7f]'
      ) {
        throw "The TypeScript nightly scheduler returned an unsafe preparation no-progress identity."
      }
      if (
        $null -ne $previousPreparationNoProgressIdentity -and
        [string]::CompareOrdinal(
          [string]$previousPreparationNoProgressIdentity,
          [string]$identity
        ) -ge 0
      ) {
        throw "The TypeScript nightly scheduler returned unsorted or duplicate preparation no-progress identities."
      }
      $previousPreparationNoProgressIdentity = [string]$identity
    }
    $safeReasonCodes = @(Get-SafeSchedulerReasonCodes -Summary $Summary)
    if (
      $Summary.classification -eq "checkpoint_paused" -and
      (
        $Summary.readiness.selectedMode -ne "optimized" -or
        (
          $safeReasonCodes -notcontains
            "workflow_deadline_settlement_reserve_exhausted" -and
          (
            $safeReasonCodes -notcontains
              "optimized_preparation_continuation_deadline_exhausted" -or
            $preparationProgressCandidateIds.Count -eq 0
          )
        )
      )
    ) {
      throw "The TypeScript nightly scheduler returned an unsupported checkpoint pause."
    }
    $canonicalRetryablePartial =
      $Summary.classification -eq "retryable_pressure" -and
      (
        $safeReasonCodes -contains
          "canonical_campaign_incomplete_prior_heads_preserved" -or
        @($safeReasonCodes | Where-Object {
          $_ -match '^canonical_source_error:[a-z][a-z0-9_]{0,63}:(checkpoint_pause|source_pressure|untyped_retry_once)$'
        }).Count -gt 0
      )
    [void](Get-CanonicalContinuationProgressComparison `
      -Summary $Summary `
      -Required:$canonicalRetryablePartial)
    $continuationProgressProperty =
      $Summary.PSObject.Properties["continuationProgress"]
    if (-not $canonicalRetryablePartial -and
      $null -ne $continuationProgressProperty -and
      $null -ne $continuationProgressProperty.Value) {
      throw "The TypeScript nightly scheduler attached progress evidence to an unsupported state."
    }
    if ($null -ne $result.earliestAvailableAt) {
      $parsedBoundary = [DateTimeOffset]::MinValue
      if (
        $result.earliestAvailableAt -isnot [string] -or
        -not [DateTimeOffset]::TryParse(
          [string]$result.earliestAvailableAt,
          [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::RoundtripKind,
          [ref]$parsedBoundary
        )
      ) {
        throw "The TypeScript nightly scheduler returned a malformed retry boundary."
      }
    }
  } elseif (
    $Summary.classification -notin @(
      "handler_not_ready", "handler_failure_prior_head_preserved"
    )
  ) {
    throw "The TypeScript nightly scheduler omitted its durable result."
  }
  $successful = $Summary.classification -in @(
    "clean_empty", "deterministic_terminal", "checkpoint_paused",
    "core_complete_maintenance_deferred"
  )
  if (($successful -and $ExitCode -ne 0) -or (-not $successful -and $ExitCode -eq 0)) {
    throw "The TypeScript nightly scheduler exit code contradicts its classification."
  }
}

function Get-SchedulerRetryBoundary {
  param([Parameter(Mandatory = $true)]$Summary)
  $parsedBoundary = [DateTimeOffset]::MinValue
  $result = Get-NightlySchedulerResult -Summary $Summary
  if (
    $null -eq $result -or
    $result.earliestAvailableAt -isnot [string] -or
    -not [DateTimeOffset]::TryParse(
      [string]$result.earliestAvailableAt,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$parsedBoundary
    )
  ) {
    throw "The retryable scheduler result omitted an exact retry boundary."
  }
  return $parsedBoundary.ToUniversalTime()
}

function Get-NightlyGenericMaintenanceRetryBoundary {
  param(
    [Parameter(Mandatory = $true)]$Result,
    [Parameter(Mandatory = $true)][object[]]$ReasonCodes
  )
  if (
    $null -eq $Result -or
    [string]$Result.classification -ne
      "core_complete_maintenance_deferred" -or
    $ReasonCodes -notcontains
      "optimized_same_signature_no_progress_retry_exhausted" -or
    $ReasonCodes -notcontains "maintenance_deferred:no_progress"
  ) {
    return $null
  }
  $identityProperty =
    $Result.PSObject.Properties["preparationNoProgressIdentities"]
  if (
    $null -eq $identityProperty -or
    @($identityProperty.Value).Count -eq 0
  ) {
    return $null
  }
  $parsedBoundary = [DateTimeOffset]::MinValue
  if (
    $Result.earliestAvailableAt -isnot [string] -or
    -not [DateTimeOffset]::TryParse(
      [string]$Result.earliestAvailableAt,
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$parsedBoundary
    ) -or
    $parsedBoundary.ToUniversalTime() -le [DateTimeOffset]::UtcNow
  ) {
    return $null
  }
  $utcBoundary = $parsedBoundary.ToUniversalTime()
  $canonicalBoundary = $utcBoundary.ToString(
    "yyyy-MM-ddTHH:mm:ss.fffZ",
    [Globalization.CultureInfo]::InvariantCulture
  )
  if ([string]$Result.earliestAvailableAt -cne $canonicalBoundary) {
    return $null
  }
  return $utcBoundary
}

function Wait-UntilNightlyBoundary {
  param(
    [Parameter(Mandatory = $true)][DateTimeOffset]$Boundary,
    [Parameter(Mandatory = $true)][DateTimeOffset]$Deadline,
    [Parameter(Mandatory = $true)][string]$Reason
  )
  if ($Boundary -gt $Deadline) {
    throw "The nightly workflow deadline precedes the next safe retry boundary."
  }
  $now = [DateTimeOffset]::UtcNow
  $delay = $Boundary - $now
  $nightlyStatus["retryAt"] = $Boundary.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  Write-NightlyStatus `
    -Stage "scheduler_wait" `
    -Message "Waiting until the scheduler's exact retry boundary ($Reason)."
  if ($delay.TotalMilliseconds -gt 0) {
    Start-Sleep -Milliseconds ([int][Math]::Ceiling($delay.TotalMilliseconds))
  }
}

function New-NightlyStageLedger {
  return @($nightlyStageLedgerOrder | ForEach-Object {
    [ordered]@{
      stage = $_
      timingState = "unknown"
      observedStartedAt = $null
      observedEndedAt = $null
      durationMs = $null
      queueState = "unknown"
      queueBefore = $null
      queueAfter = $null
      completedDelta = $null
      remaining = $null
      throughputRowsPerSecond = $null
      lastProgressAt = $null
      etaSeconds = $null
    }
  })
}

function Clear-NightlyStageLedgerTiming {
  param(
    [Parameter(Mandatory = $true)]$Entry,
    [ValidateSet("unknown", "mixed")][string]$State
  )
  $Entry.timingState = $State
  $Entry.observedStartedAt = $null
  $Entry.observedEndedAt = $null
  $Entry.durationMs = $null
}

function Clear-NightlyStageLedgerQueue {
  param(
    [Parameter(Mandatory = $true)]$Entry,
    [ValidateSet("unknown", "mixed")][string]$State
  )
  $Entry.queueState = $State
  $Entry.queueBefore = $null
  $Entry.queueAfter = $null
  $Entry.completedDelta = $null
  $Entry.remaining = $null
  $Entry.throughputRowsPerSecond = $null
  $Entry.lastProgressAt = $null
  $Entry.etaSeconds = $null
}

function Set-NightlyStageLedgerExactQueue {
  param(
    [Parameter(Mandatory = $true)]$Entry,
    [Parameter(Mandatory = $true)][long]$QueueBefore,
    [Parameter(Mandatory = $true)][long]$QueueAfter,
    [AllowNull()]$ThroughputRowsPerSecond,
    [AllowNull()]$LastProgressAt,
    [AllowNull()]$EtaSeconds
  )
  $sameReceipt =
    $Entry.queueState -eq "exact" -and
    [long]$Entry.queueBefore -eq $QueueBefore -and
    [long]$Entry.queueAfter -eq $QueueAfter -and
    $Entry.throughputRowsPerSecond -eq $ThroughputRowsPerSecond -and
    $Entry.lastProgressAt -eq $LastProgressAt -and
    $Entry.etaSeconds -eq $EtaSeconds
  if ($sameReceipt) { return }
  if ($Entry.queueState -ne "unknown") {
    Clear-NightlyStageLedgerQueue -Entry $Entry -State "mixed"
    return
  }
  $Entry.queueState = "exact"
  $Entry.queueBefore = $QueueBefore
  $Entry.queueAfter = $QueueAfter
  $Entry.completedDelta = $QueueBefore - $QueueAfter
  $Entry.remaining = $QueueAfter
  $Entry.throughputRowsPerSecond = $ThroughputRowsPerSecond
  $Entry.lastProgressAt = $LastProgressAt
  $Entry.etaSeconds = $EtaSeconds
}

function Update-NightlyStageLedger {
  param(
    [Parameter(Mandatory = $true)]$Progress,
    [Parameter(Mandatory = $true)][string]$Stage,
    [AllowNull()]$PreferenceV2Progress,
    [AllowNull()]$ProximityProgress,
    [AllowNull()]$EnrichmentProgress,
    [AllowNull()]$QuantumAttempt
  )
  if ($Stage -notin $nightlyStageLedgerOrder) { return }
  $entry = @($script:nightlyStatus["stageLedger"] | Where-Object {
    $_.stage -eq $Stage
  })[0]
  if ($null -eq $entry) { return }

  if ($Stage -eq "preference_v2_score" -and $null -ne $PreferenceV2Progress) {
    $preferenceEtaSeconds = if ($null -eq $PreferenceV2Progress.estimatedRemainingMs) {
      $null
    } else {
      [long][Math]::Ceiling([double]$PreferenceV2Progress.estimatedRemainingMs / 1000)
    }
    Set-NightlyStageLedgerExactQueue `
      -Entry $entry `
      -QueueBefore ([long]$PreferenceV2Progress.queueBefore) `
      -QueueAfter ([long]$PreferenceV2Progress.queueAfter) `
      -ThroughputRowsPerSecond $PreferenceV2Progress.throughputRowsPerSecond `
      -LastProgressAt $PreferenceV2Progress.lastProgressAt `
      -EtaSeconds $preferenceEtaSeconds
  } elseif (
    $Stage -eq "proximity" -and $null -ne $ProximityProgress -and
    $null -ne $ProximityProgress.queued
  ) {
    Set-NightlyStageLedgerExactQueue `
      -Entry $entry `
      -QueueBefore ([long]$ProximityProgress.queued) `
      -QueueAfter ([long]$ProximityProgress.remaining) `
      -ThroughputRowsPerSecond $null `
      -LastProgressAt $null `
      -EtaSeconds $null
  } elseif (
    $Stage -in @("enrichment_text", "enrichment_embedding") -and
    $null -ne $EnrichmentProgress
  ) {
    Clear-NightlyStageLedgerQueue -Entry $entry -State "mixed"
  }

  $observedAtProperty = $Progress.PSObject.Properties["observedAt"]
  if ($null -eq $observedAtProperty) { return }
  $observedAt = ConvertTo-CanonicalNightlyTimestamp $observedAtProperty.Value
  if ($null -eq $observedAt) { return }
  $attemptIdentity = if ($null -eq $QuantumAttempt) { $null } else { [long]$QuantumAttempt }

  if ($Progress.phase -eq "batch_started") {
    if ($null -ne $script:nightlyLedgerActiveStage) {
      $activeEntry = @($script:nightlyStatus["stageLedger"] | Where-Object {
        $_.stage -eq $script:nightlyLedgerActiveStage
      })[0]
      if ($null -ne $activeEntry -and $activeEntry.timingState -eq "exact") {
        Clear-NightlyStageLedgerTiming -Entry $activeEntry -State "mixed"
      }
    }
    if ($entry.timingState -eq "exact") {
      Clear-NightlyStageLedgerTiming -Entry $entry -State "mixed"
    }
    $script:nightlyLedgerActiveStage = $Stage
    $script:nightlyLedgerActiveStartedAt = $observedAt
    $script:nightlyLedgerActiveAttempt = $attemptIdentity
    return
  }
  if ($Progress.phase -ne "batch_completed") { return }
  $matchingBracket =
    $script:nightlyLedgerActiveStage -eq $Stage -and
    $script:nightlyLedgerActiveAttempt -eq $attemptIdentity
  if ($matchingBracket) {
    $startedMilliseconds = [DateTimeOffset]::ParseExact(
      $script:nightlyLedgerActiveStartedAt,
      "yyyy-MM-ddTHH:mm:ss.fffZ",
      [Globalization.CultureInfo]::InvariantCulture
    ).ToUnixTimeMilliseconds()
    $endedMilliseconds = [DateTimeOffset]::ParseExact(
      $observedAt,
      "yyyy-MM-ddTHH:mm:ss.fffZ",
      [Globalization.CultureInfo]::InvariantCulture
    ).ToUnixTimeMilliseconds()
    if ($endedMilliseconds -ge $startedMilliseconds -and $entry.timingState -eq "unknown") {
      $entry.timingState = "exact"
      $entry.observedStartedAt = $script:nightlyLedgerActiveStartedAt
      $entry.observedEndedAt = $observedAt
      $entry.durationMs = [long]($endedMilliseconds - $startedMilliseconds)
    } elseif ($entry.timingState -ne "mixed") {
      Clear-NightlyStageLedgerTiming -Entry $entry -State "mixed"
    }
  } elseif ($entry.timingState -eq "exact") {
    Clear-NightlyStageLedgerTiming -Entry $entry -State "mixed"
  }
  $script:nightlyLedgerActiveStage = $null
  $script:nightlyLedgerActiveStartedAt = $null
  $script:nightlyLedgerActiveAttempt = $null
}

function Update-NightlyStatusFromSchedulerProgress {
  param(
    [Parameter(Mandatory = $true)]$Progress,
    [switch]$PreserveSourceCampaign
  )
  if ($null -eq $script:nightlyStatus -or $null -eq $Progress) { return }
  $properties = @($Progress.PSObject.Properties.Name)
  $required = @(
    "observedAt", "phase", "state", "pipelineStage", "completedWorkUnits", "totalWorkUnits",
    "progressPercent", "estimatedRemainingMs", "currentSourceId",
    "attemptedSourceCount", "completedSourceCount", "terminalSourceCount",
    "knownSourceCount", "message",
    "proximityProgress"
  )
  if (@($required | Where-Object { $_ -notin $properties }).Count -gt 0) { return }
  if ($Progress.phase -notin @("snapshot", "batch_started", "batch_heartbeat", "batch_completed", "terminal")) {
    return
  }
  if ($Progress.state -notin @("running", "terminal")) { return }
  if ($null -eq (ConvertTo-CanonicalNightlyTimestamp $Progress.observedAt)) { return }
  if (
    -not (Test-JsonNonnegativeInteger $Progress.completedWorkUnits) -or
    -not (Test-JsonNonnegativeInteger $Progress.totalWorkUnits) -or
    [double]$Progress.completedWorkUnits -gt [double]$Progress.totalWorkUnits -or
    -not (Test-JsonProgressPercent $Progress.progressPercent) -or
    -not (Test-JsonNonnegativeInteger $Progress.attemptedSourceCount) -or
    -not (Test-JsonNonnegativeInteger $Progress.completedSourceCount) -or
    -not (Test-JsonNonnegativeInteger $Progress.terminalSourceCount) -or
    -not (Test-JsonNonnegativeInteger $Progress.knownSourceCount) -or
    [double]$Progress.completedSourceCount -gt [double]$Progress.knownSourceCount -or
    [double]$Progress.terminalSourceCount -gt [double]$Progress.knownSourceCount
  ) { return }
  $proximityProgress = ConvertTo-NightlyProximityProgress $Progress.proximityProgress
  if ($null -eq $proximityProgress) { return }
  $coreProgressProperty = $Progress.PSObject.Properties["coreProgress"]
  $maintenanceProgressProperty = $Progress.PSObject.Properties["maintenanceProgress"]
  $coreProgress = if ($null -eq $coreProgressProperty) {
    $null
  } else {
    ConvertTo-NightlyPrimaryImageProgress $coreProgressProperty.Value
  }
  $maintenanceProgress = if ($null -eq $maintenanceProgressProperty) {
    $null
  } else {
    ConvertTo-NightlyPrimaryImageProgress $maintenanceProgressProperty.Value
  }
  if (
    ($null -ne $coreProgressProperty -and $null -eq $coreProgress) -or
    ($null -ne $maintenanceProgressProperty -and $null -eq $maintenanceProgress)
  ) { return }
  $primaryImageProperty = $Progress.PSObject.Properties["primaryImageProgress"]
  $primaryImageProgress = ConvertTo-NightlyPrimaryImageProgress $(
    if ($null -eq $primaryImageProperty) { $null } else { $primaryImageProperty.Value }
  )
  if ($null -eq $primaryImageProgress) { return }
  $enrichmentProperty = $Progress.PSObject.Properties["enrichmentProgress"]
  $enrichmentProgress = $script:nightlyStatus["enrichmentProgress"]
  if ($null -ne $enrichmentProperty -and $null -ne $enrichmentProperty.Value) {
    $freshEnrichmentProgress = ConvertTo-NightlyEnrichmentProgress `
      $enrichmentProperty.Value
    if ($null -eq $freshEnrichmentProgress) { return }
    $priorEnrichmentProgress = if ($null -eq $enrichmentProgress) {
      $null
    } else {
      ConvertTo-NightlyEnrichmentProgress $enrichmentProgress
    }
    $enrichmentProgress = [pscustomobject][ordered]@{
      scope = "enrichment_text+enrichment_embedding"
      queued = $null
      claimed = $null
      completed = $null
      stale = $null
      remaining = $null
    }
    foreach ($name in @("queued", "claimed", "completed", "stale", "remaining")) {
      $enrichmentProgress.$name = if ($null -ne $freshEnrichmentProgress.$name) {
        $freshEnrichmentProgress.$name
      } elseif ($null -ne $priorEnrichmentProgress) {
        $priorEnrichmentProgress.$name
      } else {
        $null
      }
    }
  }
  $preferenceV2Property = $Progress.PSObject.Properties["preferenceV2Progress"]
  $preferenceV2Progress = $script:nightlyStatus["preferenceV2Progress"]
  if ($null -ne $preferenceV2Property -and $null -ne $preferenceV2Property.Value) {
    $preferenceV2Progress = ConvertTo-NightlyPreferenceV2Progress `
      $preferenceV2Property.Value
    if ($null -eq $preferenceV2Progress) { return }
  }
  $preferenceV2DiagnosticsProperty =
    $Progress.PSObject.Properties["preferenceV2SessionDiagnostics"]
  $preferenceV2SessionDiagnostics =
    $script:nightlyStatus["preferenceV2SessionDiagnostics"]
  if (
    $null -ne $preferenceV2DiagnosticsProperty -and
    $null -ne $preferenceV2DiagnosticsProperty.Value
  ) {
    $preferenceV2SessionDiagnostics = ConvertTo-NightlyPreferenceV2SessionDiagnostics `
      $preferenceV2DiagnosticsProperty.Value
    if ($null -eq $preferenceV2SessionDiagnostics) { return }
  }
  $preferenceV2ScorerErrorProperty =
    $Progress.PSObject.Properties["preferenceV2ScorerError"]
  $preferenceV2ScorerError = $script:nightlyStatus["preferenceV2ScorerError"]
  if ($null -ne $preferenceV2ScorerErrorProperty) {
    $preferenceV2ScorerError = ConvertTo-NightlyPreferenceV2ScorerError `
      $preferenceV2ScorerErrorProperty.Value
    if ($null -eq $preferenceV2ScorerError) { return }
  }
  $primaryImageSessionProperty = $Progress.PSObject.Properties["primaryImageSession"]
  $primaryImageSession = if (
    $null -eq $primaryImageSessionProperty -or
    $null -eq $primaryImageSessionProperty.Value
  ) {
    $script:nightlyStatus["primaryImageSession"]
  } else {
    ConvertTo-NightlyPrimaryImageSession $primaryImageSessionProperty.Value
  }
  if (
    $null -ne $primaryImageSessionProperty -and
    $null -ne $primaryImageSessionProperty.Value -and
    $null -eq $primaryImageSession
  ) { return }
  if (
    $null -ne $Progress.estimatedRemainingMs -and
    -not (Test-JsonNonnegativeInteger $Progress.estimatedRemainingMs)
  ) { return }
  if (
    ($null -ne $Progress.pipelineStage -and $Progress.pipelineStage -isnot [string]) -or
    ($null -ne $Progress.currentSourceId -and $Progress.currentSourceId -isnot [string]) -or
    $Progress.message -isnot [string] -or
    $Progress.message.Length -gt 512
  ) { return }
  $quantumAttemptProperty = $Progress.PSObject.Properties["quantumAttempt"]
  if (
    $null -ne $quantumAttemptProperty -and
    (
      -not (Test-JsonNonnegativeInteger $quantumAttemptProperty.Value) -or
      [long]$quantumAttemptProperty.Value -lt 1
    )
  ) { return }

  $stage = if ([string]::IsNullOrWhiteSpace([string]$Progress.pipelineStage)) {
    "scheduler_$($Progress.phase)"
  } else {
    [string]$Progress.pipelineStage
  }
  if (
    $stage -eq "preference_v2_score" -and
    $null -eq $preferenceV2ScorerErrorProperty -and
    $null -ne $preferenceV2Property -and
    $null -ne $preferenceV2Property.Value
  ) {
    $preferenceV2ScorerError = $null
  }
  $script:nightlyStatus["proximityProgress"] = $proximityProgress
  if ($null -ne $coreProgress) {
    $script:nightlyStatus["coreProgress"] = $coreProgress
  }
  if ($null -ne $maintenanceProgress) {
    $script:nightlyStatus["maintenanceProgress"] = $maintenanceProgress
  }
  $script:nightlyStatus["primaryImageProgress"] = $primaryImageProgress
  $script:nightlyStatus["primaryImageSession"] = $primaryImageSession
  $script:nightlyStatus["enrichmentProgress"] = $enrichmentProgress
  $script:nightlyStatus["preferenceV2Progress"] = $preferenceV2Progress
  $script:nightlyStatus["preferenceV2SessionDiagnostics"] =
    $preferenceV2SessionDiagnostics
  $script:nightlyStatus["preferenceV2ScorerError"] =
    $preferenceV2ScorerError
  if ($stage -eq "proximity") {
    $script:nightlyStatus["progressCompleted"] = $proximityProgress.completed
    $script:nightlyStatus["progressTotal"] = $proximityProgress.queued
    $script:nightlyStatus["progressPercent"] = if ($null -eq $proximityProgress.queued) {
      $null
    } elseif ([long]$proximityProgress.queued -eq 0) {
      100.0
    } else {
      [Math]::Min(100.0, [Math]::Max(0.0,
        ([double]$proximityProgress.completed / [double]$proximityProgress.queued) * 100.0
      ))
    }
  } elseif ($stage -in @("primary_image", "enrichment_text", "enrichment_embedding")) {
    $script:nightlyStatus["progressCompleted"] = $null
    $script:nightlyStatus["progressTotal"] = $null
    $script:nightlyStatus["progressPercent"] = $null
  } else {
    $script:nightlyStatus["progressCompleted"] = [long]$Progress.completedWorkUnits
    $script:nightlyStatus["progressTotal"] = [long]$Progress.totalWorkUnits
    $script:nightlyStatus["progressPercent"] = [double]$Progress.progressPercent
  }
  $script:nightlyStatus["progressPhase"] = [string]$Progress.phase
  $script:nightlyStatus["etaSeconds"] = if ($null -eq $Progress.estimatedRemainingMs) {
    $null
  } else {
    [long][Math]::Ceiling(([double]$Progress.estimatedRemainingMs) / 1000)
  }
  if (-not $PreserveSourceCampaign) {
    $script:nightlyStatus["currentSourceId"] = if ($null -eq $Progress.currentSourceId) {
      $null
    } else {
      [string]$Progress.currentSourceId
    }
    $script:nightlyStatus["invocationSourcesAttempted"] = [long]$Progress.attemptedSourceCount
    $script:nightlyStatus["invocationSourcesCompleted"] = [long]$Progress.completedSourceCount
    $script:nightlyStatus["terminalSourceCount"] = [long]$Progress.terminalSourceCount
  }
  if ($null -ne $quantumAttemptProperty) {
    $script:nightlyStatus["attemptCount"] = [long]$quantumAttemptProperty.Value
  }
  Update-NightlyStageLedger `
    -Progress $Progress `
    -Stage $stage `
    -PreferenceV2Progress $preferenceV2Progress `
    -ProximityProgress $proximityProgress `
    -EnrichmentProgress $enrichmentProgress `
    -QuantumAttempt $(
      if ($null -eq $quantumAttemptProperty) { $null } else { $quantumAttemptProperty.Value }
    )
  $sourceOutcomesProperty = $Progress.PSObject.Properties["sourceOutcomes"]
  if (
    -not $PreserveSourceCampaign -and
    $null -ne $sourceOutcomesProperty -and
    $null -ne $sourceOutcomesProperty.Value
  ) {
    Set-NightlySourceOutcomes `
      -SourceOutcomes $sourceOutcomesProperty.Value `
      -ExpectedSourceCount ([int]$Progress.knownSourceCount) `
      -AllowPartial
  }
  Write-NightlyStatus -Stage $stage -Message ([string]$Progress.message)
}

function Start-OwnedDashboard {
  param([Parameter(Mandatory = $true)][string]$Expected)

  $dashboardUri = [Uri]$baseUrl
  if (
    $dashboardUri.Scheme -ne "http" -or
    $dashboardUri.Host -ne "localhost" -or
    $dashboardUri.Port -ne 3000
  ) { throw "Only http://localhost:3000 can be started automatically." }
  $devHostScript = (Resolve-Path `
    (Join-Path $PSScriptRoot "dev-host.ps1")).Path
  $powershell = (Get-Command powershell.exe).Source
  $ownerProcess = Get-Process -Id $PID -ErrorAction Stop
  $ownerProcessStartedAt = $ownerProcess.StartTime.ToUniversalTime().ToString("o")
  $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden " +
    "-ExecutionPolicy Bypass -File `"$devHostScript`" -TaskOwned " +
    "-OwnerProcessId $PID " +
    "-OwnerProcessStartedAt `"$ownerProcessStartedAt`""
  $process = Start-Process `
    -FilePath $powershell `
    -ArgumentList $arguments `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -PassThru
  try {
    $startupTimer = [System.Diagnostics.Stopwatch]::StartNew()
    while ($startupTimer.Elapsed.TotalSeconds -lt 120) {
      $identity = Get-CurrentSupervisedRuntimeIdentity `
        -Expected $Expected `
        -TimeoutSec 3
      $process.Refresh()
      if ($null -ne $identity) {
        if (
          $identity.processId -eq $process.Id -and
          -not $process.HasExited -and
          (Test-DashboardSupervisorReceiptProcess `
            -Receipt $identity `
            -Process $process)
        ) {
          return [pscustomobject]@{
            Process = $process
            schemaVersion = [string]$identity.schemaVersion
            instanceId = [string]$identity.instanceId
            processId = [int]$identity.processId
            startedAt = [string]$identity.startedAt
          }
        }
        # Another launcher won the singleton race. Once this exact process exits,
        # the already-ready winner remains independently owned.
        if ($process.HasExited) { return $null }
      }
      if ($process.HasExited) {
        $observation = Get-ExistingRuntimeObservation
        if (-not $observation.AnyObserved) {
          throw "The owned local dashboard exited during startup."
        }
      }
      Start-Sleep -Milliseconds 500
    }
    throw "The owned local dashboard did not become exactly ready within the bounded startup window."
  } catch {
    $process.Refresh()
    if (-not $process.HasExited) {
      $receipt = Read-DashboardSupervisorLockReceipt -Path $supervisorLockPath
      if (
        $null -ne $receipt -and
        [int]$receipt.processId -eq $process.Id -and
        (Test-DashboardSupervisorReceiptProcess `
          -Receipt $receipt `
          -Process $process)
      ) {
        Stop-OwnedDashboard -Ownership ([pscustomobject]@{
          Process = $process
          schemaVersion = [string]$receipt.schemaVersion
          instanceId = [string]$receipt.instanceId
          processId = [int]$receipt.processId
          startedAt = [string]$receipt.startedAt
        })
      } else {
        Stop-ExactProcessTree -Process $process
      }
    }
    throw
  }
}

function Stop-ExactProcessTree {
  param([Parameter(Mandatory = $true)]$Process)

  $Process.Refresh()
  if ($Process.HasExited) { return }
  $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
  $output = @(& $taskkill /PID ([string]$Process.Id) /T /F 2>&1)
  $exitCode = $LASTEXITCODE
  $Process.Refresh()
  if (-not $Process.HasExited -and -not $Process.WaitForExit(10000)) {
    throw "The exact owned process tree remained active after taskkill: $($output -join ' ')"
  }
  $Process.Refresh()
  if ($exitCode -ne 0 -and -not $Process.HasExited) {
    throw "The exact owned process tree could not be stopped: $($output -join ' ')"
  }
}

function Test-DashboardSupervisorInstanceEndpointObserved {
  param([Parameter(Mandatory = $true)][string]$InstanceId)

  try {
    $appHealth = Invoke-RestMethod `
      -Method Get `
      -Uri "$baseUrl/api/internal/runtime-health" `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec 2
    if ([string]$appHealth.supervisorInstanceId -eq $InstanceId) { return $true }
  } catch {
    # The companion probe below is independent evidence.
  }
  try {
    $companionHealth = Invoke-RestMethod `
      -Method Get `
      -Uri $companionHealthUrl `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec 2
    return [string]$companionHealth.supervisorInstanceId -eq $InstanceId
  } catch {
    return $false
  }
}

function Wait-DashboardSupervisorOwnershipReleased {
  param(
    [Parameter(Mandatory = $true)]$Ownership,
    [ValidateRange(1, 60)][int]$WindowSeconds = 15
  )

  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  do {
    $state = Get-DashboardSupervisorLockState
    $receipt = Read-DashboardSupervisorLockReceipt -Path $supervisorLockPath
    $expectedStillHeld = $state -eq "held" -and
      (Test-SameDashboardSupervisorReceipt `
        -Left $Ownership `
        -Right $receipt)
    if (
      -not $expectedStillHeld -and
      -not (Test-DashboardSupervisorInstanceEndpointObserved `
        -InstanceId ([string]$Ownership.instanceId))
    ) { return $true }
    Start-Sleep -Milliseconds 250
  } while ($timer.Elapsed.TotalSeconds -lt $WindowSeconds)
  return $false
}

function Stop-OwnedDashboard {
  param([Parameter(Mandatory = $true)]$Ownership)

  $process = $Ownership.Process
  if ($null -eq $process) {
    throw "The owned dashboard process receipt is incomplete."
  }
  $process.Refresh()
  if (-not $process.HasExited) {
    $currentReceipt = Read-DashboardSupervisorLockReceipt -Path $supervisorLockPath
    if (
      (Get-DashboardSupervisorLockState) -ne "held" -or
      -not (Test-SameDashboardSupervisorReceipt `
        -Left $Ownership `
        -Right $currentReceipt) -or
      -not (Test-DashboardSupervisorReceiptProcess `
        -Receipt $currentReceipt `
        -Process $process)
    ) {
      throw "The owned dashboard no longer matches its exact supervisor receipt; refusing PID-based cleanup."
    }
    Stop-ExactProcessTree -Process $process
  }
  if (-not (Wait-DashboardSupervisorOwnershipReleased -Ownership $Ownership)) {
    throw "The owned dashboard process tree, endpoints, or supervisor lock remained active after bounded cleanup."
  }
}

function Invoke-NightlyScheduler {
  param(
    [switch]$PreparationOnly,
    [switch]$MaintenanceOnly
  )

  if ($MaintenanceOnly -and -not $PreparationOnly) {
    throw "A maintenance-only scheduler quantum must also be preparation-only."
  }

  $tsxPackage = Join-Path $ProjectRoot "node_modules\tsx\package.json"
  if (-not (Test-Path -LiteralPath $tsxPackage)) {
    throw "Project dependencies are missing. Run .\scripts\setup.ps1 first."
  }
  $schedulerScript = (Resolve-Path (Join-Path $PSScriptRoot "nightly-scheduler.mts")).Path
  $schedulerArguments = @(
    $schedulerScript,
    "--mode", $SchedulerMode,
    "--base-url", $baseUrl,
    "--runtime-revision", $invocationRuntimeRevision,
    "--workflow-deadline-at", $workflowDeadline.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
    "--max-concurrency", $MaxConcurrentNetworkJobs,
    "--max-dispatches", $MaxDispatches
  )
  if ($CompleteCurrentAudit) { $schedulerArguments += "--complete-current-audit" }
  if ($ExistingCatalogOnly -or $PreparationOnly) {
    $schedulerArguments += "--existing-catalog-only"
  }
  if ($MaintenanceOnly) {
    $schedulerArguments += "--existing-catalog-maintenance-only"
  }
  $progressPrefix = "@@auction-discovery-nightly-progress-v1@@"
  $recentOutput = New-Object "System.Collections.Generic.Queue[string]"
  & $NodeExe `
    --import $NodeRuntimePreload `
      --import tsx `
    @schedulerArguments `
    2>&1 | ForEach-Object {
      $line = [string]$_
      if ($line.StartsWith($progressPrefix, [StringComparison]::Ordinal)) {
        try {
          $progress = $line.Substring($progressPrefix.Length) |
            ConvertFrom-Json -ErrorAction Stop
          Update-NightlyStatusFromSchedulerProgress `
            -Progress $progress `
            -PreserveSourceCampaign:$PreparationOnly
        } catch {
          # Progress reporting is best effort and cannot interrupt scheduling.
        }
      } else {
        $recentOutput.Enqueue($line)
        while ($recentOutput.Count -gt 5) { [void]$recentOutput.Dequeue() }
      }
    }
  $exitCode = $LASTEXITCODE
  $summary = $null
  foreach ($line in @($recentOutput.ToArray())) {
    try {
      $candidate = [string]$line | ConvertFrom-Json -ErrorAction Stop
      if ($candidate.schemaVersion -eq "auction-discovery-nightly-scheduler-cli-v1") {
        $summary = $candidate
      }
    } catch {
      # The scheduler may emit bounded diagnostics before terminal JSON.
    }
  }
  if ($null -eq $summary) { throw "The TypeScript nightly scheduler returned no valid summary." }
  Assert-NightlySchedulerSummary `
    -Summary $summary `
    -ExitCode $exitCode `
    -Mode $SchedulerMode `
    -PreparationOnly:$PreparationOnly
  if (
    [string]$summary.workflowDeadlineAt -ne
      $workflowDeadline.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  ) {
    throw "The TypeScript nightly scheduler changed the absolute workflow deadline."
  }
  return [pscustomobject]@{
    summary = $summary
    exitCode = $exitCode
  }
}

if (-not $HealthCheckOnly) {
  $statusDirectory = Split-Path -Parent $nightlyStatusPath
  New-Item -ItemType Directory -Force -Path $statusDirectory | Out-Null
  try {
    $nightlyLock = [System.IO.File]::Open(
      $nightlyLockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    $nativeError = $_.Exception.HResult -band 0xffff
    if ($nativeError -in @(32, 33)) {
      [pscustomobject]@{
        status = "already_running"
        reusedActiveWorkflow = $true
      } | ConvertTo-Json -Compress
      exit 76
    }
    throw
  }
  $workflowStartedAt = [DateTimeOffset]::UtcNow
  $startedAt = $workflowStartedAt.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  $workflowDeadline = $workflowStartedAt.AddHours($workflowDeadlineHours)
  $nightlyStatus = [ordered]@{
    schemaVersion = "auction-discovery-nightly-status-v1"
    state = "running"
    workflowState = "running"
    processId = $PID
    stage = "runtime_check"
    completedStages = 0
    totalStages = 1
    progressCompleted = 0
    progressTotal = $null
    progressPercent = $null
    progressPhase = $null
    proximityProgress = [ordered]@{
      queued = $null
      claimed = $null
      completed = $null
      stale = $null
      remaining = $null
    }
    primaryImageProgress = [ordered]@{
      ready = $null
      deferred = $null
      claimed = $null
      remaining = $null
    }
    coreProgress = [ordered]@{
      ready = 0
      deferred = 0
      claimed = 0
      remaining = 0
    }
    maintenanceProgress = [ordered]@{
      ready = 0
      deferred = 0
      claimed = 0
      remaining = 0
    }
    primaryImageSession = $null
    enrichmentProgress = $null
    preferenceV2Progress = $null
    preferenceV2SessionDiagnostics = $null
    preferenceV2ScorerError = $null
    stageLedger = @(New-NightlyStageLedger)
    etaSeconds = $null
    currentSourceId = $null
    invocationSourcesAttempted = 0
    invocationSourcesCompleted = 0
    terminalSourceCount = 0
    campaignSourcesCompleted = 0
    campaignSourcesTotal = $null
    attemptCount = 0
    runtimeRevision = $null
    sourceOutcomes = @()
    sourceOutcomeCounts = [ordered]@{
      refreshed = 0
      skipped_recent = 0
      preserved = 0
      paused = 0
      stopped = 0
      blocked = 0
    }
    lastClassification = $null
    lastReasonCodes = @()
    failedAtStage = $null
    retryAt = $null
    workflowDeadlineAt = $workflowDeadline.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    message = "Checking the existing local runtime."
    startedAt = $startedAt
    updatedAt = $startedAt
    endedAt = $null
    error = $null
  }
  Write-NightlyStatus -Stage "runtime_check" -Message "Checking the existing local runtime."
}

try {
  if ($ExpectedRuntimeRevision) {
    if ($ExpectedRuntimeRevision -notmatch $runtimeRevisionPattern) {
      throw "The expected runtime revision is malformed."
    }
    $invocationRuntimeRevision = $ExpectedRuntimeRevision
  } else {
    $invocationRuntimeRevision = Get-CheckoutRuntimeRevision
  }
  $env:AUCTION_DISCOVERY_RUNTIME_REVISION = $invocationRuntimeRevision
  if ($null -ne $nightlyStatus) {
    $nightlyStatus["runtimeRevision"] = $invocationRuntimeRevision
    Write-NightlyStatus `
      -Stage "runtime_check" `
      -Message "Checking the loaded local runtime revision."
  }
  $runtimeReady = Test-CurrentSupervisedRuntimeReady `
    -Expected $invocationRuntimeRevision `
    -TimeoutSec 3
  $runtimeObservation = Get-ExistingRuntimeObservation
  $existingRuntimeObserved = [bool]$runtimeObservation.AnyObserved
  if (-not $runtimeReady -and ($RequireExistingRuntime -or $existingRuntimeObserved)) {
    Write-NightlyStatus `
      -Stage "runtime_check" `
      -Message "Waiting up to $existingRuntimeRecoverySeconds seconds for the existing supervised runtime to converge on the checkout revision."
    $runtimeReady = Wait-LoadedRuntimeRevision `
      -Expected $invocationRuntimeRevision `
      -WindowSeconds $existingRuntimeRecoverySeconds `
      -AttemptTimeoutSeconds 3
  }
  if (-not $runtimeReady) {
    if ($RequireExistingRuntime) {
      throw "The existing supervised runtime remained unavailable or revision-stale for $existingRuntimeRecoverySeconds seconds; -RequireExistingRuntime forbids starting a replacement."
    }
    $runtimeObservation = Get-ExistingRuntimeObservation
    $existingRuntimeObserved = [bool]$runtimeObservation.AnyObserved
    if ($existingRuntimeObserved) {
      throw "An existing local runtime or supervisor remained present without the exact ready contract; refusing to start a competing replacement."
    }
    $ownedDevProcess = Start-OwnedDashboard -Expected $invocationRuntimeRevision
    $runtimeReady = Test-CurrentSupervisedRuntimeReady `
      -Expected $invocationRuntimeRevision `
      -TimeoutSec 5
    if (-not $runtimeReady) { throw $runtimeRevisionFailure }
  }
  if ($HealthCheckOnly) {
    [pscustomobject]@{
      status = "ready"
      baseUrl = $baseUrl
      startedForThisRun = $null -ne $ownedDevProcess
      runtimeRevision = $invocationRuntimeRevision
    } | ConvertTo-Json -Compress
    return
  }
  Assert-LoadedRuntimeRevision -Expected $invocationRuntimeRevision
  Write-NightlyStatus `
    -Stage "typescript_scheduler" `
    -Message "Running one long-lived TypeScript nightly scheduler in $SchedulerMode mode."
  $sameReasonRetries = @{}
  $attempt = 0
  $sourceCampaignCompleted = [bool]$ExistingCatalogOnly
  $retainedPreferenceV2Remaining = $null
  $maintenanceOnlyNext = $false
  while ($true) {
    if ([DateTimeOffset]::UtcNow -ge $workflowDeadline) {
      throw "The nightly workflow reached its absolute five-hour deadline."
    }
    $attempt += 1
    $nightlyStatus["attemptCount"] = $attempt
    $nightlyStatus["retryAt"] = $null
    Write-NightlyStatus `
      -Stage "typescript_scheduler" `
      -Message "Running scheduler quantum $attempt in $SchedulerMode mode."
    $maintenanceOnlyInvocation = $maintenanceOnlyNext
    $maintenanceOnlyNext = $false
    $preparationOnlyInvocation = $sourceCampaignCompleted
    $invocation = Invoke-NightlyScheduler `
      -PreparationOnly:$preparationOnlyInvocation `
      -MaintenanceOnly:$maintenanceOnlyInvocation
    $summary = $invocation.summary
    $schedulerResult = Get-NightlySchedulerResult -Summary $summary
    Update-NightlyPreferenceV2ScorerErrorFromResult -Result $schedulerResult
    $reportedPreferenceV2Remaining =
      Resolve-NightlyPreferenceV2Remaining `
        -Result $schedulerResult `
        -RetainedRemaining $retainedPreferenceV2Remaining
    if ($null -ne $reportedPreferenceV2Remaining) {
      $retainedPreferenceV2Remaining = [long]$reportedPreferenceV2Remaining
    }
    $sourceOutcomesProperty = if ($null -eq $schedulerResult) {
      $null
    } else {
      $schedulerResult.PSObject.Properties["sourceOutcomes"]
    }
    if ($null -ne $sourceOutcomesProperty -and -not $sourceCampaignCompleted) {
      $deadlineCheckpoint =
        [string]$summary.classification -eq "checkpoint_paused" -and
        @($schedulerResult.tailReasonCodes) -contains
          "workflow_deadline_settlement_reserve_exhausted"
      Set-NightlySourceOutcomes `
        -SourceOutcomes $sourceOutcomesProperty.Value `
        -ExpectedSourceCount ([int]$summary.readiness.sourceCount) `
        -AllowPartial:($SchedulerMode -eq "canonical" -or $deadlineCheckpoint)
      if ($SchedulerMode -ne "canonical" -and -not $deadlineCheckpoint) {
        $sourceCampaignCompleted = $true
      }
    }
    $classification = [string]$summary.classification
    $selectedMode = [string]$summary.readiness.selectedMode
    $reasonCodes = @(Get-SafeSchedulerReasonCodes -Summary $summary)
    if ($classification -notin @("clean_empty", "deterministic_terminal")) {
    }
    $tailCandidateIds = if ($null -eq $schedulerResult) {
      @()
    } else {
      @($schedulerResult.tailCandidateIds)
    }
    $maintenanceProgressProperty = if ($null -eq $schedulerResult) {
      $null
    } else {
      $schedulerResult.PSObject.Properties["maintenanceProgress"]
    }
    $maintenanceProgress = if ($null -eq $maintenanceProgressProperty) {
      $null
    } else {
      ConvertTo-NightlyPrimaryImageProgress $maintenanceProgressProperty.Value
    }
    $maintenanceRemaining = if (
      $null -eq $maintenanceProgress -or
      $null -eq $maintenanceProgress.remaining
    ) {
      0L
    } else {
      [long]$maintenanceProgress.remaining
    }
    $reasonSignature = "$classification|$($reasonCodes -join ',')|$($tailCandidateIds -join ',')"
    $nightlyStatus["lastClassification"] = $classification
    $nightlyStatus["lastReasonCodes"] = $reasonCodes

    if ($classification -eq "checkpoint_paused") {
      if (
        $selectedMode -ne "optimized" -or
        $null -eq $schedulerResult -or
        (
          $reasonCodes -notcontains
            "workflow_deadline_settlement_reserve_exhausted" -and
          (
            $reasonCodes -notcontains
              "optimized_preparation_continuation_deadline_exhausted" -or
            @($schedulerResult.preparationProgressCandidateIds).Count -eq 0
          )
        )
      ) {
        throw "The scheduler returned an unsupported checkpoint pause."
      }
      Write-NightlyStatus `
        -Stage "paused" `
        -Message "Discovery paused at a durable preparation checkpoint; remaining work will resume on the next discovery run." `
        -State "completed" `
        -WorkflowState "checkpoint_paused" `
        -Ended
      break
    }

    if ($classification -eq "core_complete_maintenance_deferred") {
      $resolvedPreferenceV2Remaining =
        Resolve-NightlyPreferenceV2Remaining `
          -Result $schedulerResult `
          -RetainedRemaining $retainedPreferenceV2Remaining
      if ($null -ne $resolvedPreferenceV2Remaining) {
        $retainedPreferenceV2Remaining =
          [long]$resolvedPreferenceV2Remaining
      }
      $preferenceRemaining = if ($null -eq $resolvedPreferenceV2Remaining) {
        0L
      } else {
        [long]$resolvedPreferenceV2Remaining
      }
      if ($preferenceRemaining -gt 0) {
        throw "Unexpected preference scoring work is unavailable in this distribution; discovery stopped without changing scoring state."
      }
      if ($reasonCodes -contains "projection_quantum_remaining") {
        Write-NightlyStatus `
          -Stage "scheduler_continue" `
          -Message "Projection maintenance made durable progress; continuing immediately."
        $sameReasonRetries = @{}
        continue
      }
      if (
        $reasonCodes -contains
          "optimized_preparation_continuation_deadline_exhausted" -or
        $reasonCodes -contains
          "workflow_deadline_settlement_reserve_exhausted"
      ) {
        Write-NightlyStatus `
          -Stage "paused" `
          -Message "Discovery core is ready; remaining maintenance is checkpointed at the five-hour boundary." `
          -State "completed" `
          -WorkflowState "checkpoint_paused" `
          -Ended
        break
      }
      $genericMaintenanceRetryBoundary =
        Get-NightlyGenericMaintenanceRetryBoundary `
          -Result $schedulerResult `
          -ReasonCodes $reasonCodes
      if ($null -ne $genericMaintenanceRetryBoundary) {
        $nightlyStatus["maintenanceRetryAt"] =
          $genericMaintenanceRetryBoundary.ToString(
            "yyyy-MM-ddTHH:mm:ss.fffZ"
          )
        $nightlyStatus["maintenanceNoProgressIdentities"] =
          @($schedulerResult.preparationNoProgressIdentities)
        Write-NightlyStatus `
          -Stage "paused" `
          -Message "Discovery core is ready; generic maintenance retained its exact durable retry boundary for the next discovery run." `
          -State "completed" `
          -WorkflowState "core_complete_maintenance_deferred" `
          -Ended
        break
      }
      if (-not $maintenanceOnlyInvocation -and $maintenanceRemaining -gt 0) {
        $maintenanceOnlyNext = $true
        Write-NightlyStatus `
          -Stage "scheduler_continue" `
          -Message "Discovery core is ready; draining one retained maintenance quantum without source acquisition."
        $sameReasonRetries = @{}
        continue
      }
      throw "The scheduler deferred maintenance without a resumable Preference V2 queue, deadline boundary, or exact generic retry boundary."
    }

    if (
      -not $maintenanceOnlyInvocation -and
      $classification -in @("clean_empty", "deterministic_terminal") -and
      $maintenanceRemaining -gt 0
    ) {
      $maintenanceOnlyNext = $true
      Write-NightlyStatus `
        -Stage "scheduler_continue" `
        -Message "Discovery core reached a terminal boundary; draining one retained maintenance quantum without source acquisition."
      $sameReasonRetries = @{}
      continue
    }

    if (
      $maintenanceOnlyInvocation -and
      $classification -in @("clean_empty", "deterministic_terminal")
    ) {
      Write-NightlyStatus `
        -Stage "scheduler_continue" `
        -Message "Retained maintenance reached a boundary; rechecking required discovery work."
      $sameReasonRetries = @{}
      continue
    }

    if ($classification -in @("clean_empty", "deterministic_terminal")) {
      $nightlyStatus["completedStages"] = 1
      $reportedQuantumCount = [long]$nightlyStatus["attemptCount"]
      Write-NightlyStatus `
        -Stage "complete" `
        -Message "The TypeScript nightly scheduler finished with $classification after $reportedQuantumCount quantum(s)." `
        -State "completed" `
        -Ended
      break
    }

    if (
      $selectedMode -eq "optimized" -and
      -not $preparationOnlyInvocation
    ) {
      if ($classification -in @("no_progress", "access_stop")) {
        throw "The optimized nightly scheduler reached a permanent fail-closed stop ($classification): $($reasonCodes -join ', ')."
      }
      if ($classification -eq "handler_failure_state_ambiguous") {
        throw "The optimized nightly scheduler callback state is ambiguous: $($reasonCodes -join ', ')."
      }
      throw "The one-process optimized nightly scheduler returned a nonterminal continuation state ($classification); refusing to create a new campaign."
    }

    if ($classification -eq "bounded_quantum_exhausted") {
      $provedProgress = $null -ne $schedulerResult -and (
        [long]$schedulerResult.completed -gt 0 -or
        [long]$schedulerResult.deterministicTerminals -gt 0
      )
      if (-not $provedProgress) {
        throw "A bounded scheduler quantum exhausted without proved durable progress."
      }
      Write-NightlyStatus `
        -Stage "scheduler_continue" `
        -Message "Scheduler quantum $attempt made proved progress; continuing immediately."
      $sameReasonRetries = @{}
      continue
    }

    if ($classification -in @("no_progress", "access_stop")) {
      throw "The nightly scheduler reached a permanent fail-closed stop ($classification): $($reasonCodes -join ', ')."
    }
    if ($classification -eq "handler_failure_state_ambiguous") {
      throw "The nightly scheduler callback state is ambiguous: $($reasonCodes -join ', ')."
    }
    if ($classification -notin @(
      "future_deferred", "retryable_pressure", "handler_not_ready",
      "handler_failure_prior_head_preserved"
    )) {
      throw "The nightly scheduler returned an unsupported continuation state."
    }

    $continuationComparison = Get-CanonicalContinuationProgressComparison `
      -Summary $summary
    $advancingCanonicalPartial =
      $classification -eq "retryable_pressure" -and
      (
        $reasonCodes -contains
          "canonical_campaign_incomplete_prior_heads_preserved" -or
        @($reasonCodes | Where-Object {
          $_ -match '^canonical_source_error:[a-z][a-z0-9_]{0,63}:(checkpoint_pause|source_pressure)$'
        }).Count -gt 0
      ) -and
      $continuationComparison -eq "advanced"
    if ($advancingCanonicalPartial) {
      # An exact publication head or immutable completed-page set advanced
      # during this received canonical callback. Reset only the no-progress
      # allowance for this same reason; the workflow deadline remains binding.
      [void]$sameReasonRetries.Remove($reasonSignature)
      Write-NightlyStatus `
        -Stage "scheduler_continue" `
        -Message "Canonical checkpoint state advanced; continuing at its exact boundary."
    } else {
      $priorRetries = if ($sameReasonRetries.ContainsKey($reasonSignature)) {
        [int]$sameReasonRetries[$reasonSignature]
      } else {
        0
      }
      if ($priorRetries -ge $maximumSameReasonRetries) {
        throw "The nightly scheduler exhausted its one same-reason no-progress retry ($classification): $($reasonCodes -join ', ')."
      }
      $sameReasonRetries[$reasonSignature] = $priorRetries + 1
    }

    $retryBoundary = if ($classification -in @("future_deferred", "retryable_pressure")) {
      Get-SchedulerRetryBoundary -Summary $summary
    } elseif ($classification -eq "handler_not_ready") {
      [DateTimeOffset]::UtcNow.AddSeconds($handlerNotReadyBackoffSeconds)
    } else {
      [DateTimeOffset]::UtcNow.AddSeconds($priorHeadPreservedBackoffSeconds)
    }
    Wait-UntilNightlyBoundary `
      -Boundary $retryBoundary `
      -Deadline $workflowDeadline `
      -Reason $classification
  }
} catch {
  $workflowError = $_
  try {
    $nightlyStatus["failedAtStage"] = [string]$nightlyStatus["stage"]
    Write-NightlyStatus `
      -Stage "failed" `
      -Message "Nightly scheduling failed closed." `
      -State "failed" `
      -Failure $_.Exception.Message `
      -Ended
  } catch {
    # Preserve the scheduler failure if its best-effort status write also fails.
  }
  throw $workflowError
} finally {
  if ($ownedDevProcess) { Stop-OwnedDashboard -Ownership $ownedDevProcess }
  if ($nightlyLock) { $nightlyLock.Dispose() }
}
