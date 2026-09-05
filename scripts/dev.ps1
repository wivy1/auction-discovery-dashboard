param([switch]$Generation)

if (-not $Generation) {
  $hostScript = (Resolve-Path (Join-Path $PSScriptRoot "dev-host.ps1")).Path
  $powershell = (Get-Command powershell.exe).Source
  & $powershell `
    -NoLogo `
    -NoProfile `
    -NonInteractive `
    -ExecutionPolicy Bypass `
    -File $hostScript
  exit $LASTEXITCODE
}

. "$PSScriptRoot\runtime.ps1"

Set-Location $ProjectRoot
$env:WRANGLER_LOG_PATH = ".wrangler/logs"
$env:AUCTION_DISCOVERY_IMAGE_PORT = "32110"

$runtimeRevisionScript = (Resolve-Path `
  (Join-Path $PSScriptRoot "runtime-revision.mts")).Path
$runtimeRevisionSchema = "auction-discovery-runtime-revision-v1"
$runtimeRevisionPattern = '^sha256:[0-9a-f]{64}$'
$supervisorInstanceId = [string]$env:AUCTION_DISCOVERY_SUPERVISOR_INSTANCE_ID
$supervisorProcessId = 0
if (
  $supervisorInstanceId -notmatch '^[0-9a-f]{32}$' -or
  -not [int]::TryParse(
    [string]$env:AUCTION_DISCOVERY_SUPERVISOR_PROCESS_ID,
    [ref]$supervisorProcessId
  ) -or
  $supervisorProcessId -le 0 -or
  [string]$env:AUCTION_DISCOVERY_IMAGE_TOKEN -notmatch '^[0-9A-F]{64}$'
) {
  throw "The runtime generation was not started by a valid supervisor host."
}

function Get-CheckoutRuntimeRevision {
  $runtimeRevisionOutput = @(
    & $NodeExe `
      --import $NodeRuntimePreload `
      --import tsx `
      $runtimeRevisionScript `
      2>&1
  )
  if ($LASTEXITCODE -ne 0 -or $runtimeRevisionOutput.Count -ne 1) {
    throw "The checkout runtime revision could not be computed."
  }
  try {
    $runtimeRevisionPayload = $runtimeRevisionOutput[0] |
      ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "The checkout runtime revision returned invalid JSON."
  }
  if (
    $runtimeRevisionPayload.schemaVersion -ne $runtimeRevisionSchema -or
    [string]$runtimeRevisionPayload.revision -notmatch $runtimeRevisionPattern
  ) {
    throw "The checkout runtime revision returned an invalid contract."
  }
  return [string]$runtimeRevisionPayload.revision
}

$logDirectory = Join-Path $ProjectRoot ".wrangler\logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$nightlyStatusPath = Join-Path $logDirectory "nightly-status.json"
$supervisorLockPath = Join-Path $logDirectory "runtime-supervisor.lock"
$supervisorReceipt = Read-DashboardSupervisorLockReceipt -Path $supervisorLockPath
try {
  $generationProcess = Get-CimInstance `
    Win32_Process `
    -Filter "ProcessId = $PID" `
    -ErrorAction Stop
  $supervisorProcess = Get-Process -Id $supervisorProcessId -ErrorAction Stop
  if (
    $null -eq $supervisorReceipt -or
    [string]$supervisorReceipt.instanceId -ne $supervisorInstanceId -or
    [int]$supervisorReceipt.processId -ne $supervisorProcessId -or
    [string]$supervisorReceipt.startedAt -ne
      $supervisorProcess.StartTime.ToUniversalTime().ToString("o") -or
    [int]$generationProcess.ParentProcessId -ne $supervisorProcessId -or
    $supervisorProcess.HasExited
  ) { throw "mismatch" }
} catch {
  throw "The runtime generation could not verify its exact supervisor host."
}
$dashboardUrl = "http://localhost:3000/"
$dashboardProbeTimeoutSeconds = 3
$dashboardStartupDeadlineSeconds = 120
$dashboardUnavailabilityGraceSeconds = 120
# The exact root probe renders the dashboard through the local Worker. Keep it
# frequent enough for bounded recovery without turning a multi-hour scheduled
# run into thousands of full application requests.
$dashboardPollMilliseconds = 30000
$maximumDashboardRestarts = 1
$dashboardChild = $null
$dashboardRestartCount = 0
$startupRuntimeRevision = ""
$pendingCheckoutRuntimeRevision = ""
$revisionProbeWarningActive = $false
$databaseStartupPrepared = $false

function Test-DashboardRootReady {
  try {
    $response = Invoke-WebRequest `
      -UseBasicParsing `
      -Method Get `
      -Uri $dashboardUrl `
      -TimeoutSec $dashboardProbeTimeoutSeconds
    if ($response.StatusCode -ne 200) { return $false }
    $revision = Invoke-RestMethod `
      -Method Get `
      -Uri "http://localhost:3000/api/internal/runtime-revision" `
      -TimeoutSec $dashboardProbeTimeoutSeconds
    if (-not $script:databaseStartupPrepared) {
      # This lightweight endpoint owns the established controlled bootstrap.
      # It initializes or migrates D1 before the separate write-readiness proof
      # without materializing the full review dashboard.
      Invoke-RestMethod `
        -Method Get `
        -Uri "http://localhost:3000/api/settings/origin" `
        -Headers @{ "Cache-Control" = "no-store" } `
        -TimeoutSec $dashboardProbeTimeoutSeconds | Out-Null
      $script:databaseStartupPrepared = $true
    }
    $health = Invoke-RestMethod `
      -Method Get `
      -Uri "http://localhost:3000/api/internal/runtime-health" `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec $dashboardProbeTimeoutSeconds
    return $revision.schemaVersion -eq "auction-discovery-runtime-revision-v1" -and
      [string]$revision.revision -eq $startupRuntimeRevision -and
      (Test-DashboardSupervisorRuntimeHealth `
        -Health $health `
        -ExpectedRuntimeRevision $startupRuntimeRevision) -and
      [string]$health.supervisorInstanceId -eq $supervisorInstanceId
  } catch {
    return $false
  }
}

function Start-DashboardChild {
  param([ValidateRange(1, 2)][int]$Attempt)

  $vinextCli = (Resolve-Path `
    (Join-Path $ProjectRoot "node_modules\vinext\dist\cli.js")).Path
  $dashboardHostScript = (Resolve-Path `
    (Join-Path $PSScriptRoot "dev-dashboard-host.ps1")).Path
  $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
  $stdoutPath = Join-Path `
    $logDirectory `
    "dashboard-runtime.$PID.attempt-$Attempt.stdout.log"
  $stderrPath = Join-Path `
    $logDirectory `
    "dashboard-runtime.$PID.attempt-$Attempt.stderr.log"
  $gateName = "Local\auction-discovery-dashboard-$([Guid]::NewGuid().ToString('N'))"
  $gate = $null
  $job = $null
  $process = $null
  $assigned = $false
  try {
    $gate = [Threading.EventWaitHandle]::new(
      $false,
      [Threading.EventResetMode]::ManualReset,
      $gateName
    )
    $job = New-DashboardProcessJob
    $arguments = `
      "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dashboardHostScript`" -GateName `"$gateName`" -NodeExe `"$NodeExe`" -VinextCli `"$vinextCli`""
    $process = Start-Process `
      -FilePath $powershell `
      -ArgumentList $arguments `
      -WorkingDirectory $ProjectRoot `
      -NoNewWindow `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -PassThru
    Add-ProcessToDashboardJob -Job $job -Process $process
    $assigned = $true
    $gate.Set() | Out-Null
    Write-Host `
      "Dashboard host PID $($process.Id); stdout: $stdoutPath; stderr: $stderrPath"
    return [pscustomobject]@{
      Process = $process
      Job = $job
      Gate = $gate
      StdoutPath = $stdoutPath
      StderrPath = $stderrPath
    }
  } catch {
    $startFailure = $_.Exception.Message
    $cleanupFailure = $null
    try {
      if ($assigned) {
        Stop-DashboardProcessJob -Job $job | Out-Null
        $job = $null
      } elseif ($process) {
        $process.Refresh()
        if (-not $process.HasExited) {
          Stop-Process -Id $process.Id -Force -ErrorAction Stop
          if (-not $process.WaitForExit(5000)) {
            throw "The gated dashboard host remained active after startup failed."
          }
        }
      }
    } catch {
      $cleanupFailure = $_.Exception.Message
    } finally {
      if ($job) { $job.Dispose() }
      if ($gate) { $gate.Dispose() }
    }
    if ($cleanupFailure) {
      throw "Dashboard startup failed: $startFailure Cleanup also failed: $cleanupFailure"
    }
    throw "Dashboard startup failed: $startFailure"
  }
}

function Stop-DashboardChildTree {
  param([Parameter(Mandatory = $true)]$Child)

  if ($null -eq $Child.Job) {
    throw "The dashboard child has no Job Object containment handle."
  }
  try {
    $stopped = Stop-DashboardProcessJob -Job $Child.Job
    if ([long]$stopped.ActiveProcesses -ne 0) {
      throw "The dashboard Job Object teardown did not verify zero active processes."
    }
  } finally {
    if ($Child.Gate) { $Child.Gate.Dispose() }
  }
}

function Test-NightlyWorkflowRestartCompatible {
  $lockPath = Join-Path $logDirectory "nightly.lock"
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $true }
  $lock = $null
  try {
    $lock = [System.IO.File]::Open(
      $lockPath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::None
    )
    return $true
  } catch [System.IO.IOException] {
    try {
      $statusPath = Join-Path $logDirectory "nightly-status.json"
      $statusFile = Get-Item -LiteralPath $statusPath -ErrorAction Stop
      if ($statusFile.Length -gt 64KB) { return $false }
      $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
      if (-not (Test-DashboardSupervisorNightlyRuntimeCheck -Status $status)) {
        return $false
      }
      $updatedAt = [DateTimeOffset]::Parse([string]$status.updatedAt)
      if ([DateTimeOffset]::UtcNow - $updatedAt -gt [TimeSpan]::FromMinutes(10)) {
        return $false
      }
      $process = Get-Process -Id ([int]$status.processId) -ErrorAction Stop
      return -not $process.HasExited
    } catch {
      return $false
    }
  } finally {
    if ($lock) { $lock.Dispose() }
  }
}

function Test-DashboardDurableRestartSafe {
  try {
    $idleScript = (Resolve-Path `
      (Join-Path $PSScriptRoot "check-pipeline-idle.mjs")).Path
    $idleOutput = @(& $NodeExe $idleScript 2>&1)
    $idleExitCode = $LASTEXITCODE
    # The read-only probe intentionally exits 2 when it reports live durable
    # ownership. Parse that exact result so the validator can admit only the
    # one expired-orphan/live-reservation/live-runner recovery shape.
    if ($idleExitCode -notin @(0, 2) -or $idleOutput.Count -ne 1) {
      return $false
    }
    $idle = $idleOutput[0] | ConvertFrom-Json
    $pipelineSafe = Test-DashboardSupervisorPipelineIdle `
      -Idle $idle `
      -StatusPath $nightlyStatusPath `
      -ExpectedRuntimeRevision $startupRuntimeRevision
    if (-not $pipelineSafe) { return $false }
    if (@($idle.activeReservations).Count -eq 0 -and
        @($idle.orphanedRuns).Count -eq 0) {
      return Test-NightlyWorkflowRestartCompatible
    }
    return $true
  } catch {
    return $false
  }
}

function Test-DashboardRestartSafe {
  param([Parameter(Mandatory = $true)][string]$HealthUrl)

  try {
    $health = Invoke-RestMethod -Method Get -Uri $HealthUrl -TimeoutSec 2
    if (-not (Test-DashboardSupervisorCompanionIdle -Health $health)) {
      return $false
    }
    return Test-DashboardDurableRestartSafe
  } catch {
    return $false
  }
}

function Wait-DashboardChildLivenessBoundary {
  param(
    [Parameter(Mandatory = $true)]$Child,
    [Parameter(Mandatory = $true)]$Companion,
    [Parameter(Mandatory = $true)][string]$HealthUrl,
    [Parameter(Mandatory = $true)][bool]$InitiallyReady
  )

  if (-not $InitiallyReady) {
    $Child.Process.Refresh()
    return [pscustomobject]@{
      ChildExited = $Child.Process.HasExited
      CompanionExited = $Companion.HasExited
      CompanionUnavailable = $false
      UnavailableSeconds = $dashboardUnavailabilityGraceSeconds
      RevisionChanged = $false
      CheckoutRevision = $null
    }
  }

  $unavailableSince = $null
  $companionUnavailableSince = $null
  while ($true) {
    if ($Child.Process.WaitForExit($dashboardPollMilliseconds)) {
      $Companion.Refresh()
      return [pscustomobject]@{
        ChildExited = $true
        CompanionExited = $Companion.HasExited
        CompanionUnavailable = $false
        UnavailableSeconds = 0
        RevisionChanged = $false
        CheckoutRevision = $null
      }
    }
    $Companion.Refresh()
    if ($Companion.HasExited) {
      return [pscustomobject]@{
        ChildExited = $false
        CompanionExited = $true
        CompanionUnavailable = $false
        UnavailableSeconds = 0
        RevisionChanged = $false
        CheckoutRevision = $null
      }
    }
    if (Test-LocalCompanionReady -HealthUrl $HealthUrl) {
      if ($null -ne $companionUnavailableSince) {
        Write-Host "The local companion health endpoint recovered."
        $companionUnavailableSince = $null
      }
    } else {
      if ($null -eq $companionUnavailableSince) {
        $companionUnavailableSince = [DateTimeOffset]::UtcNow
        Write-Warning `
          "The local companion is health-unavailable; allowing a $dashboardUnavailabilityGraceSeconds-second recovery window."
      }
      $companionUnavailableSeconds = [int][Math]::Floor(
        ([DateTimeOffset]::UtcNow - $companionUnavailableSince).TotalSeconds
      )
      if ($companionUnavailableSeconds -ge $dashboardUnavailabilityGraceSeconds) {
        return [pscustomobject]@{
          ChildExited = $false
          CompanionExited = $false
          CompanionUnavailable = $true
          UnavailableSeconds = $companionUnavailableSeconds
          RevisionChanged = $false
          CheckoutRevision = $null
        }
      }
    }
    try {
      $checkoutRuntimeRevision = Get-CheckoutRuntimeRevision
      $revisionAction = Get-DashboardSupervisorRevisionAction `
        -LoadedRuntimeRevision $startupRuntimeRevision `
        -CheckoutRuntimeRevision $checkoutRuntimeRevision `
        -PreviousCheckoutRuntimeRevision $script:pendingCheckoutRuntimeRevision `
        -RestartSafe $false
      $script:revisionProbeWarningActive = $false
      if ($revisionAction -eq "ready") {
        $script:pendingCheckoutRuntimeRevision = ""
      } elseif ($revisionAction -eq "sample") {
        $script:pendingCheckoutRuntimeRevision = $checkoutRuntimeRevision
      } elseif ($revisionAction -eq "wait") {
        return [pscustomobject]@{
          ChildExited = $false
          CompanionExited = $false
          CompanionUnavailable = $false
          UnavailableSeconds = 0
          RevisionChanged = $true
          CheckoutRevision = $checkoutRuntimeRevision
        }
      } else {
        throw "The checkout runtime revision returned an invalid transition."
      }
    } catch {
      $script:pendingCheckoutRuntimeRevision = ""
      if (-not $script:revisionProbeWarningActive) {
        Write-Warning `
          "The checkout runtime revision is temporarily unreadable; keeping the current supervised stack. $($_.Exception.Message)"
        $script:revisionProbeWarningActive = $true
      }
    }
    if (Test-DashboardRootReady) {
      if ($null -ne $unavailableSince) {
        $recoveredSeconds = [int][Math]::Ceiling(
          ([DateTimeOffset]::UtcNow - $unavailableSince).TotalSeconds
        )
        Write-Host "Dashboard root recovered after $recoveredSeconds second(s)."
        $unavailableSince = $null
      }
      continue
    }
    if ($null -eq $unavailableSince) {
      $unavailableSince = [DateTimeOffset]::UtcNow
      Write-Warning `
        "Dashboard root is unavailable; allowing a $dashboardUnavailabilityGraceSeconds-second recovery window."
    }
    $unavailableSeconds = [int][Math]::Floor(
      ([DateTimeOffset]::UtcNow - $unavailableSince).TotalSeconds
    )
    if ($unavailableSeconds -lt $dashboardUnavailabilityGraceSeconds) { continue }
    if (Test-DashboardRootReady) {
      Write-Host "Dashboard root recovered at the liveness boundary."
      $unavailableSince = $null
      continue
    }
    return [pscustomobject]@{
      ChildExited = $false
      CompanionExited = $false
      CompanionUnavailable = $false
      UnavailableSeconds = $unavailableSeconds
      RevisionChanged = $false
      CheckoutRevision = $null
    }
  }
}

function Start-LocalCompanion {
  $sidecarStart = New-Object System.Diagnostics.ProcessStartInfo
  $sidecarStart.FileName = $NodeExe
  $sidecarStart.Arguments = '--import ./scripts/node-runtime-preload.mjs --import tsx scripts\local-companion-service.ts'
  $sidecarStart.WorkingDirectory = $ProjectRoot
  $sidecarStart.UseShellExecute = $false
  $sidecarStart.CreateNoWindow = $false
  return [System.Diagnostics.Process]::Start($sidecarStart)
}

function Wait-LocalCompanionReady {
  param(
    [Parameter(Mandatory = $true)]$Companion,
    [Parameter(Mandatory = $true)][string]$HealthUrl
  )

  for ($attempt = 0; $attempt -lt 240; $attempt += 1) {
    $Companion.Refresh()
    if ($Companion.HasExited) {
      throw "The local companion exited during startup. Run the dev command in a terminal for diagnostics."
    }
    if (Test-LocalCompanionReady -HealthUrl $HealthUrl) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "The local companion did not become ready on $HealthUrl."
}

function Test-LocalCompanionReady {
  param([Parameter(Mandatory = $true)][string]$HealthUrl)

  try {
    $health = Invoke-RestMethod `
      -Method Get `
      -Uri $HealthUrl `
      -Headers @{ "Cache-Control" = "no-store" } `
      -TimeoutSec 1
    return $health.status -eq "ready" -and
      $health.runtimeRevisionSchema -eq $runtimeRevisionSchema -and
      [string]$health.runtimeRevision -eq $startupRuntimeRevision -and
      [string]$health.supervisorInstanceId -eq $supervisorInstanceId
  } catch {
    return $false
  }
}

function Stop-LocalCompanion {
  param(
    [Parameter(Mandatory = $true)]$Companion,
    [Parameter(Mandatory = $true)][string]$Capability
  )

  $Companion.Refresh()
  if ($Companion.HasExited) { return }
  try {
    $shutdownUrl = "http://127.0.0.1:$($env:AUCTION_DISCOVERY_IMAGE_PORT)/v1/shutdown"
    Invoke-WebRequest `
      -Method Post `
      -Uri $shutdownUrl `
      -Headers @{ "X-Auction-Discovery-Capability" = $Capability } `
      -UseBasicParsing `
      -TimeoutSec 3 | Out-Null
  } catch {
    # The bounded owned-process fallback below handles early or unhealthy exits.
  }
  if (-not $Companion.WaitForExit(15000)) {
    Stop-Process -Id $Companion.Id -ErrorAction SilentlyContinue
    if (-not $Companion.WaitForExit(5000)) {
      throw "The owned local companion remained active after bounded shutdown."
    }
  }
}

function Wait-DashboardRevisionRefreshBoundary {
  param(
    [Parameter(Mandatory = $true)][string]$HealthUrl,
    [Parameter(Mandatory = $true)]$Companion,
    [Parameter(Mandatory = $true)][string]$InitialCheckoutRevision
  )

  $candidateRevision = $InitialCheckoutRevision
  $probeWarningActive = $false
  Write-Warning `
    "Checkout runtime revision changed to $candidateRevision; waiting for an exact safe boundary without stopping any process."
  while ($true) {
    try {
      $checkoutRuntimeRevision = Get-CheckoutRuntimeRevision
      $probeWarningActive = $false
    } catch {
      $candidateRevision = ""
      if (-not $probeWarningActive) {
        Write-Warning `
          "The changed checkout revision is temporarily unreadable; keeping the current supervised stack. $($_.Exception.Message)"
        $probeWarningActive = $true
      }
      Start-Sleep -Milliseconds $dashboardPollMilliseconds
      continue
    }

    $Companion.Refresh()
    $restartSafe = if ($Companion.HasExited) {
      Test-DashboardDurableRestartSafe
    } else {
      Test-DashboardRestartSafe -HealthUrl $HealthUrl
    }
    $revisionAction = Get-DashboardSupervisorRevisionAction `
      -LoadedRuntimeRevision $startupRuntimeRevision `
      -CheckoutRuntimeRevision $checkoutRuntimeRevision `
      -PreviousCheckoutRuntimeRevision $candidateRevision `
      -RestartSafe $restartSafe
    if ($revisionAction -eq "ready") { return $null }
    if ($revisionAction -eq "fail") {
      throw "The checkout runtime revision returned an invalid transition."
    }
    if ($revisionAction -eq "sample") {
      $candidateRevision = $checkoutRuntimeRevision
      Start-Sleep -Milliseconds $dashboardPollMilliseconds
      continue
    }
    if ($revisionAction -eq "wait") {
      $candidateRevision = $checkoutRuntimeRevision
      Start-Sleep -Milliseconds $dashboardPollMilliseconds
      continue
    }

    # Recheck the hash and the complete idle boundary immediately before the
    # generation stop. A new write or new work returns to bounded waiting.
    $finalCheckoutRevision = Get-CheckoutRuntimeRevision
    $Companion.Refresh()
    $finalRestartSafe = if ($Companion.HasExited) {
      Test-DashboardDurableRestartSafe
    } else {
      Test-DashboardRestartSafe -HealthUrl $HealthUrl
    }
    $finalAction = Get-DashboardSupervisorRevisionAction `
      -LoadedRuntimeRevision $startupRuntimeRevision `
      -CheckoutRuntimeRevision $finalCheckoutRevision `
      -PreviousCheckoutRuntimeRevision $checkoutRuntimeRevision `
      -RestartSafe $finalRestartSafe
    if ($finalAction -eq "restart") { return $finalCheckoutRevision }
    if ($finalAction -eq "ready") { return $null }
    if ($finalAction -eq "fail") {
      throw "The checkout runtime revision returned an invalid final transition."
    }
    $candidateRevision = $finalCheckoutRevision
    Start-Sleep -Milliseconds $dashboardPollMilliseconds
  }
}

function Stop-LocalRuntimeGeneration {
  param(
    [AllowNull()]$DashboardChild,
    [AllowNull()]$Companion,
    [Parameter(Mandatory = $true)][string]$Capability
  )

  $failures = [Collections.Generic.List[string]]::new()
  if ($DashboardChild) {
    try { Stop-DashboardChildTree -Child $DashboardChild } catch {
      $failures.Add($_.Exception.Message)
    }
  }
  if ($Companion) {
    try {
      Stop-LocalCompanion -Companion $Companion -Capability $Capability
    } catch {
      $failures.Add($_.Exception.Message)
    }
  }
  if ($failures.Count -gt 0) {
    throw "The runtime generation teardown was incomplete; no replacement will start. $($failures -join ' ')"
  }
}

$sidecar = $null
$healthUrl = "http://127.0.0.1:$($env:AUCTION_DISCOVERY_IMAGE_PORT)/v1/health"
$startupRuntimeRevision = Get-CheckoutRuntimeRevision
$pendingCheckoutRuntimeRevision = ""
$revisionProbeWarningActive = $false
$env:AUCTION_DISCOVERY_RUNTIME_REVISION = $startupRuntimeRevision
$generationCapability = [string]$env:AUCTION_DISCOVERY_IMAGE_TOKEN
$dashboardRestartCount = 0
$refreshRequested = $false
$sidecar = $null
$dashboardChild = $null

try {
      $sidecar = Start-LocalCompanion
      Wait-LocalCompanionReady -Companion $sidecar -HealthUrl $healthUrl

      while (-not $refreshRequested) {
        $dashboardAttempt = $dashboardRestartCount + 1
        $dashboardChild = Start-DashboardChild -Attempt $dashboardAttempt
        $startupDeadline = [DateTimeOffset]::UtcNow.AddSeconds(
          $dashboardStartupDeadlineSeconds
        )
        $dashboardReady = $false
        while ([DateTimeOffset]::UtcNow -lt $startupDeadline) {
          $dashboardChild.Process.Refresh()
          $sidecar.Refresh()
          if ($dashboardChild.Process.HasExited -or $sidecar.HasExited) { break }
          if (Test-DashboardRootReady) {
            $dashboardReady = $true
            break
          }
          Start-Sleep -Milliseconds 500
        }

        if ($dashboardReady) {
          Write-Host `
            "Dashboard runtime is ready at $dashboardUrl on revision $startupRuntimeRevision."
        }
        while ($true) {
          $outcome = Wait-DashboardChildLivenessBoundary `
            -Child $dashboardChild `
            -Companion $sidecar `
            -HealthUrl $healthUrl `
            -InitiallyReady $dashboardReady

          if ([bool]$outcome.RevisionChanged) {
            $nextRevision = Wait-DashboardRevisionRefreshBoundary `
              -HealthUrl $healthUrl `
              -Companion $sidecar `
              -InitialCheckoutRevision ([string]$outcome.CheckoutRevision)
            if ($null -eq $nextRevision) {
              $pendingCheckoutRuntimeRevision = ""
              $dashboardReady = Test-DashboardRootReady
              continue
            }
            Write-Warning `
              "Restarting the supervised local stack on checkout revision $nextRevision."
            Stop-DashboardChildTree -Child $dashboardChild
            $dashboardChild = $null
            $refreshRequested = $true
            break
          }

          if ([bool]$outcome.CompanionExited) {
            Write-Warning `
              "The owned local companion exited; waiting for an exact safe boundary before replacing the complete supervised stack."
            while (-not (Test-DashboardDurableRestartSafe)) {
              Start-Sleep -Milliseconds $dashboardPollMilliseconds
            }
            Stop-DashboardChildTree -Child $dashboardChild
            $dashboardChild = $null
            $refreshRequested = $true
            break
          }

          if ([bool]$outcome.CompanionUnavailable) {
            Write-Warning `
              "The owned local companion remained health-unavailable; waiting for durable work to become idle before replacing the complete supervised stack."
            while (-not (Test-DashboardDurableRestartSafe)) {
              Start-Sleep -Milliseconds $dashboardPollMilliseconds
            }
            Stop-DashboardChildTree -Child $dashboardChild
            $dashboardChild = $null
            $refreshRequested = $true
            break
          }

          $restartSafe = Test-DashboardRestartSafe -HealthUrl $healthUrl
          $recoveredWhileWaiting = $false
          $companionRecoveryRequired = $false
          $safetyWaitLogged = $false
          while (-not $restartSafe) {
            $dashboardChild.Process.Refresh()
            $sidecar.Refresh()
            if ($sidecar.HasExited) {
              $companionRecoveryRequired = $true
              break
            }
            if (-not $dashboardChild.Process.HasExited -and (Test-DashboardRootReady)) {
              Write-Host "Dashboard root recovered before an idle restart boundary was available."
              $dashboardReady = $true
              $recoveredWhileWaiting = $true
              break
            }
            if (-not $safetyWaitLogged) {
              Write-Warning `
                "Dashboard reached a terminal liveness boundary while work may still be active; waiting for an exact safe boundary without stopping any process."
              $safetyWaitLogged = $true
            }
            Start-Sleep -Milliseconds $dashboardPollMilliseconds
            $restartSafe = Test-DashboardRestartSafe -HealthUrl $healthUrl
          }
          if ($recoveredWhileWaiting) { continue }
          if ($companionRecoveryRequired) {
            Write-Warning `
              "The owned local companion exited during dashboard recovery; waiting for durable work to become idle before replacing the complete supervised stack."
            while (-not (Test-DashboardDurableRestartSafe)) {
              Start-Sleep -Milliseconds $dashboardPollMilliseconds
            }
            Stop-DashboardChildTree -Child $dashboardChild
            $dashboardChild = $null
            $refreshRequested = $true
            break
          }

          $dashboardChild.Process.Refresh()
          if (-not $dashboardChild.Process.HasExited -and (Test-DashboardRootReady)) {
            Write-Host "Dashboard root recovered immediately before the restart boundary."
            $dashboardReady = $true
            continue
          }

          $childExited = [bool]$outcome.ChildExited
          $unavailableSeconds = [int]$outcome.UnavailableSeconds
          $action = Get-DashboardSupervisorAction `
            -ChildExited $childExited `
            -EndpointReady $false `
            -UnavailableSeconds $unavailableSeconds `
            -GraceSeconds $dashboardUnavailabilityGraceSeconds `
            -RestartUsed ($dashboardRestartCount -ge $maximumDashboardRestarts) `
            -RestartSafe $restartSafe

          if ($action -eq "restart") {
            Write-Warning `
              "Dashboard child reached a terminal liveness boundary at an exact safe boundary; performing its single bounded restart."
            Stop-DashboardChildTree -Child $dashboardChild
            $dashboardChild = $null
            $dashboardRestartCount += 1
            break
          }

          $exitDetail = if ($childExited) {
            "child exited with code $($dashboardChild.Process.ExitCode)"
          } else {
            "exact root remained unavailable for $unavailableSeconds second(s)"
          }
          throw `
            "Dashboard runtime supervisor stopped after $exitDetail. Its one restart was already consumed. Review $($dashboardChild.StdoutPath) and $($dashboardChild.StderrPath)."
        }
  }
} finally {
  Stop-LocalRuntimeGeneration `
    -DashboardChild $dashboardChild `
    -Companion $sidecar `
    -Capability $generationCapability
  Remove-Item Env:AUCTION_DISCOVERY_RUNTIME_REVISION -ErrorAction SilentlyContinue
  Remove-Item Env:AUCTION_DISCOVERY_VISIBLE_PROCESS_LAUNCHER -ErrorAction SilentlyContinue
}

if ($refreshRequested) { exit 75 }
throw "The runtime generation ended without a terminal outcome."
