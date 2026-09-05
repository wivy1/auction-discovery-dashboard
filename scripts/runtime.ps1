$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
if (Get-Command node -ErrorAction SilentlyContinue) {
  $script:NodeExe = (Get-Command node).Source
} else {
  throw "Node.js 22.13 or newer is required. Install Node.js and reopen this terminal."
}
$script:PnpmExe = if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  (Get-Command pnpm).Source
} else { $null }
$script:ProjectRoot = $projectRoot
$script:NodeRuntimePreload = ([System.Uri](Join-Path $PSScriptRoot "node-runtime-preload.mjs")).AbsoluteUri

if (-not ("AuctionDiscovery.DashboardJobNative" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace AuctionDiscovery
{
    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JobObjectBasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    public static class DashboardJobNative
    {
        private const int JobObjectBasicAccountingInformationClass = 1;
        private const int JobObjectExtendedLimitInformationClass = 9;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateJobObject(
            IntPtr jobAttributes,
            string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            SafeFileHandle job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(
            SafeFileHandle job,
            IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(
            SafeFileHandle job,
            int informationClass,
            IntPtr information,
            uint informationLength,
            IntPtr returnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(
            SafeFileHandle job,
            uint exitCode);

        public static SafeFileHandle CreateKillOnCloseJob()
        {
            SafeFileHandle job = CreateJobObject(IntPtr.Zero, null);
            if (job == null || job.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            JobObjectExtendedLimitInformation limits =
                new JobObjectExtendedLimitInformation();
            limits.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            IntPtr pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, pointer, false);
                if (!SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformationClass,
                    pointer,
                    (uint)size))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                return job;
            }
            catch
            {
                job.Dispose();
                throw;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        public static void Assign(SafeFileHandle job, IntPtr process)
        {
            if (!AssignProcessToJobObject(job, process))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }

        public static uint ActiveProcessCount(SafeFileHandle job)
        {
            int size = Marshal.SizeOf(typeof(JobObjectBasicAccountingInformation));
            IntPtr pointer = Marshal.AllocHGlobal(size);
            try
            {
                if (!QueryInformationJobObject(
                    job,
                    JobObjectBasicAccountingInformationClass,
                    pointer,
                    (uint)size,
                    IntPtr.Zero))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                }
                JobObjectBasicAccountingInformation accounting =
                    (JobObjectBasicAccountingInformation)Marshal.PtrToStructure(
                        pointer,
                        typeof(JobObjectBasicAccountingInformation));
                return accounting.ActiveProcesses;
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        public static void Terminate(SafeFileHandle job)
        {
            if (!TerminateJobObject(job, 1))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
        }
    }
}
'@
}

function New-DashboardProcessJob {
  return [AuctionDiscovery.DashboardJobNative]::CreateKillOnCloseJob()
}

function Add-ProcessToDashboardJob {
  param(
    [Parameter(Mandatory = $true)]$Job,
    [Parameter(Mandatory = $true)]$Process
  )

  $Process.Refresh()
  if ($Process.HasExited) {
    throw "The gated dashboard host exited before Job Object assignment."
  }
  [AuctionDiscovery.DashboardJobNative]::Assign($Job, $Process.Handle)
}

function Get-DashboardProcessJobActiveCount {
  param([Parameter(Mandatory = $true)]$Job)

  if ($Job.IsClosed -or $Job.IsInvalid) {
    throw "The dashboard Job Object is unavailable."
  }
  return [long][AuctionDiscovery.DashboardJobNative]::ActiveProcessCount($Job)
}

function Stop-DashboardProcessJob {
  param(
    [Parameter(Mandatory = $true)]$Job,
    [ValidateRange(100, 60000)][int]$TimeoutMilliseconds = 10000
  )

  if ($Job.IsClosed -or $Job.IsInvalid) {
    throw "The dashboard Job Object is unavailable for verified teardown."
  }
  $activeProcesses = $null
  $failure = $null
  try {
    $activeProcesses = Get-DashboardProcessJobActiveCount -Job $Job
    if ($activeProcesses -gt 0) {
      [AuctionDiscovery.DashboardJobNative]::Terminate($Job)
      $timer = [Diagnostics.Stopwatch]::StartNew()
      do {
        Start-Sleep -Milliseconds 25
        $activeProcesses = Get-DashboardProcessJobActiveCount -Job $Job
      } while (
        $activeProcesses -gt 0 -and
        $timer.ElapsedMilliseconds -lt $TimeoutMilliseconds
      )
    }
    if ($activeProcesses -ne 0) {
      throw "The dashboard Job Object retained $activeProcesses active process(es) after bounded termination."
    }
  } catch {
    $failure = $_
  } finally {
    # KILL_ON_JOB_CLOSE is the last-resort containment boundary if termination
    # or accounting failed. A failed verification still blocks replacement.
    $Job.Dispose()
  }
  if ($failure) { throw $failure }
  return [pscustomobject]@{ ActiveProcesses = 0 }
}

function Invoke-ProjectBinary {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
  )

  $binary = Join-Path $script:ProjectRoot "node_modules\.bin\$Name.cmd"
  if (-not (Test-Path $binary)) {
    throw "Project dependencies are missing. Run .\scripts\setup.ps1 first."
  }
  & $binary @Arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Get-DashboardSupervisorAction {
  param(
    [Parameter(Mandatory = $true)][bool]$ChildExited,
    [Parameter(Mandatory = $true)][bool]$EndpointReady,
    [ValidateRange(0, 86400)][int]$UnavailableSeconds,
    [ValidateRange(1, 86400)][int]$GraceSeconds,
    [Parameter(Mandatory = $true)][bool]$RestartUsed,
    [Parameter(Mandatory = $true)][bool]$RestartSafe
  )

  $terminalLoss = $ChildExited -or (
    -not $EndpointReady -and $UnavailableSeconds -ge $GraceSeconds
  )
  if (-not $terminalLoss) {
    return $(if ($EndpointReady) { "ready" } else { "wait" })
  }
  if (-not $RestartUsed -and $RestartSafe) { return "restart" }
  return "fail"
}

function Get-DashboardSupervisorRevisionAction {
  param(
    [Parameter(Mandatory = $true)][string]$LoadedRuntimeRevision,
    [Parameter(Mandatory = $true)][string]$CheckoutRuntimeRevision,
    [AllowEmptyString()][string]$PreviousCheckoutRuntimeRevision = "",
    [Parameter(Mandatory = $true)][bool]$RestartSafe
  )

  $pattern = '^sha256:[0-9a-f]{64}$'
  if (
    $LoadedRuntimeRevision -notmatch $pattern -or
    $CheckoutRuntimeRevision -notmatch $pattern -or
    ($PreviousCheckoutRuntimeRevision -and
      $PreviousCheckoutRuntimeRevision -notmatch $pattern)
  ) { return "fail" }
  if ($LoadedRuntimeRevision -eq $CheckoutRuntimeRevision) { return "ready" }
  if ($PreviousCheckoutRuntimeRevision -ne $CheckoutRuntimeRevision) {
    return "sample"
  }
  return $(if ($RestartSafe) { "restart" } else { "wait" })
}

function Enter-DashboardSupervisorLock {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowEmptyString()][string]$OwnerInstanceId = "",
    [ValidateRange(0, 2147483647)][int]$OwnerProcessId = 0
  )

  try {
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::Read
    )
    if ($OwnerInstanceId -or $OwnerProcessId -ne 0) {
      if (
        $OwnerInstanceId -notmatch '^[0-9a-f]{32}$' -or
        $OwnerProcessId -le 0
      ) {
        $stream.Dispose()
        return [pscustomobject]@{
          status = "indeterminate"
          stream = $null
          error = "The runtime supervisor owner receipt is invalid."
        }
      }
      $receipt = [ordered]@{
        schemaVersion = "auction-discovery-runtime-supervisor-lock-v1"
        instanceId = $OwnerInstanceId
        processId = $OwnerProcessId
        startedAt = [DateTimeOffset]::UtcNow.ToString("o")
      }
      $encoding = New-Object System.Text.UTF8Encoding($false)
      $bytes = $encoding.GetBytes(($receipt | ConvertTo-Json -Compress) + "`n")
      $stream.SetLength(0)
      $stream.Position = 0
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    }
    return [pscustomobject]@{
      status = "acquired"
      stream = $stream
      error = $null
    }
  } catch [System.IO.IOException] {
    $nativeCode = $_.Exception.HResult -band 0xffff
    if ($nativeCode -in @(32, 33)) {
      return [pscustomobject]@{
        status = "held_by_other"
        stream = $null
        error = $null
      }
    }
    return [pscustomobject]@{
      status = "indeterminate"
      stream = $null
      error = $_.Exception.Message
    }
  } catch {
    return [pscustomobject]@{
      status = "indeterminate"
      stream = $null
      error = $_.Exception.Message
    }
  }
}

function Read-DashboardSupervisorLockReceipt {
  param([Parameter(Mandatory = $true)][string]$Path)

  $stream = $null
  $reader = $null
  try {
    $stream = [System.IO.File]::Open(
      $Path,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    if ($stream.Length -le 0 -or $stream.Length -gt 4096) { return $null }
    $encoding = New-Object System.Text.UTF8Encoding($false, $true)
    $reader = [System.IO.StreamReader]::new(
      $stream,
      $encoding,
      $true,
      1024,
      $true
    )
    $receipt = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
    $properties = @($receipt.PSObject.Properties.Name)
    $expected = @("schemaVersion", "instanceId", "processId", "startedAt")
    if (
      $properties.Count -ne $expected.Count -or
      @($expected | Where-Object { $_ -notin $properties }).Count -gt 0 -or
      $receipt.schemaVersion -ne "auction-discovery-runtime-supervisor-lock-v1" -or
      [string]$receipt.instanceId -notmatch '^[0-9a-f]{32}$' -or
      -not (Test-DashboardSupervisorNonnegativeInteger $receipt.processId) -or
      [long]$receipt.processId -le 0 -or
      $null -eq (ConvertTo-DashboardSupervisorTimestamp $receipt.startedAt)
    ) { return $null }
    return [pscustomobject]@{
      schemaVersion = [string]$receipt.schemaVersion
      instanceId = [string]$receipt.instanceId
      processId = [int]$receipt.processId
      startedAt = [string]$receipt.startedAt
    }
  } catch {
    return $null
  } finally {
    if ($reader) { $reader.Dispose() }
    if ($stream) { $stream.Dispose() }
  }
}

function Test-DashboardSupervisorRuntimeIdentity {
  param(
    [Parameter(Mandatory = $true)]$Receipt,
    [Parameter(Mandatory = $true)]$AppHealth,
    [Parameter(Mandatory = $true)]$CompanionHealth,
    [Parameter(Mandatory = $true)][string]$ExpectedRuntimeRevision
  )

  if (
    $null -eq $Receipt -or
    $null -eq $AppHealth -or
    $null -eq $CompanionHealth -or
    $ExpectedRuntimeRevision -notmatch '^sha256:[0-9a-f]{64}$' -or
    [string]$Receipt.instanceId -notmatch '^[0-9a-f]{32}$'
  ) { return $false }
  return [string]$AppHealth.supervisorInstanceId -eq [string]$Receipt.instanceId -and
    [string]$CompanionHealth.supervisorInstanceId -eq [string]$Receipt.instanceId -and
    [string]$AppHealth.runtimeRevision -eq $ExpectedRuntimeRevision -and
    [string]$CompanionHealth.runtimeRevision -eq $ExpectedRuntimeRevision
}

function Test-DashboardSupervisorSafeText {
  param(
    [AllowNull()]$Value,
    [ValidateRange(1, 4096)][int]$MaximumLength = 1024
  )

  return $Value -is [string] -and
    -not [string]::IsNullOrWhiteSpace([string]$Value) -and
    ([string]$Value).Length -le $MaximumLength -and
    [string]$Value -notmatch '[\x00-\x1f\x7f]'
}

function Test-DashboardSupervisorNonnegativeInteger {
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

function ConvertTo-DashboardSupervisorTimestamp {
  param([AllowNull()]$Value)

  if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$Value)) {
    return $null
  }
  $parsed = [DateTimeOffset]::MinValue
  $ok = [DateTimeOffset]::TryParse(
    [string]$Value,
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind,
    [ref]$parsed
  )
  if (-not $ok) { return $null }
  return $parsed.ToUniversalTime()
}

function Test-DashboardSupervisorRuntimeHealth {
  param(
    [Parameter(Mandatory = $true)]$Health,
    [Parameter(Mandatory = $true)][string]$ExpectedRuntimeRevision
  )

  $required = @(
    "schemaVersion", "status", "databaseReadable", "databaseWritable",
    "runtimeRevisionSchema", "runtimeRevision"
  )
  if ($null -eq $Health) { return $false }
  $properties = @($Health.PSObject.Properties.Name)
  if (@($required | Where-Object { $_ -notin $properties }).Count -gt 0) {
    return $false
  }
  return $Health.schemaVersion -eq "auction-discovery-runtime-health-v1" -and
    $Health.status -eq "ready" -and
    $Health.databaseReadable -is [bool] -and
    [bool]$Health.databaseReadable -and
    $Health.databaseWritable -is [bool] -and
    [bool]$Health.databaseWritable -and
    $Health.runtimeRevisionSchema -eq "auction-discovery-runtime-revision-v1" -and
    $Health.runtimeRevision -is [string] -and
    [string]$Health.runtimeRevision -eq $ExpectedRuntimeRevision
}

function Test-DashboardSupervisorExpiredOrphan {
  param(
    [Parameter(Mandatory = $true)]$Orphan,
    [Parameter(Mandatory = $true)][DateTimeOffset]$CheckedAt
  )

  $required = @("runKind", "runId", "startedAt", "expiresAt", "status")
  if ($null -eq $Orphan) { return $false }
  $properties = @($Orphan.PSObject.Properties.Name)
  if (@($required | Where-Object { $_ -notin $properties }).Count -gt 0) {
    return $false
  }
  if (
    $Orphan.runKind -notin @("discovery", "enrichment") -or
    -not (Test-DashboardSupervisorSafeText $Orphan.runId -MaximumLength 512) -or
    $Orphan.status -ne "running"
  ) { return $false }
  $startedAt = ConvertTo-DashboardSupervisorTimestamp $Orphan.startedAt
  $expiresAt = ConvertTo-DashboardSupervisorTimestamp $Orphan.expiresAt
  if ($null -eq $startedAt -or $null -eq $expiresAt) { return $false }
  return $startedAt -le $CheckedAt -and
    $expiresAt -ge $startedAt -and
    $expiresAt -le $CheckedAt
}

function Test-DashboardSupervisorLiveReservation {
  param(
    [Parameter(Mandatory = $true)]$Reservation,
    [Parameter(Mandatory = $true)][DateTimeOffset]$CheckedAt
  )

  $required = @(
    "reservationId", "sourceId", "requestRole", "laneKey", "leaseOwner",
    "state", "createdAt", "expiresAt"
  )
  if ($null -eq $Reservation) { return $false }
  $properties = @($Reservation.PSObject.Properties.Name)
  if (@($required | Where-Object { $_ -notin $properties }).Count -gt 0) {
    return $false
  }
  if (
    -not (Test-DashboardSupervisorSafeText $Reservation.reservationId -MaximumLength 512) -or
    -not (Test-DashboardSupervisorSafeText $Reservation.sourceId -MaximumLength 512) -or
    $Reservation.requestRole -ne "complete_current" -or
    -not (Test-DashboardSupervisorSafeText $Reservation.laneKey -MaximumLength 512) -or
    -not (Test-DashboardSupervisorSafeText $Reservation.leaseOwner -MaximumLength 512) -or
    $Reservation.state -notin @("reserved", "acquired")
  ) { return $false }
  $createdAt = ConvertTo-DashboardSupervisorTimestamp $Reservation.createdAt
  $expiresAt = ConvertTo-DashboardSupervisorTimestamp $Reservation.expiresAt
  return $null -ne $createdAt -and $null -ne $expiresAt -and
    $createdAt -le $CheckedAt -and $expiresAt -gt $CheckedAt -and
    $expiresAt -ge $createdAt
}

function Get-DashboardSupervisorNightlyStatus {
  param([Parameter(Mandatory = $true)][string]$StatusPath)

  try {
    if (-not (Test-Path -LiteralPath $StatusPath -PathType Leaf)) { return $null }
    $statusFile = Get-Item -LiteralPath $StatusPath -ErrorAction Stop
    if ($statusFile.Length -gt 64KB) { return $null }
    return Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Test-DashboardSupervisorLiveNightlyRunner {
  param(
    [Parameter(Mandatory = $true)]$Status,
    [Parameter(Mandatory = $true)]$Reservation,
    [Parameter(Mandatory = $true)][DateTimeOffset]$CheckedAt,
    [Parameter(Mandatory = $true)][string]$ExpectedRuntimeRevision
  )

  $required = @(
    "schemaVersion", "state", "stage", "processId", "runtimeRevision", "workflowDeadlineAt",
    "updatedAt", "attemptCount", "invocationSourcesAttempted",
    "invocationSourcesCompleted", "terminalSourceCount",
    "campaignSourcesCompleted", "campaignSourcesTotal", "currentSourceId",
    "sourceOutcomes"
  )
  if ($null -eq $Status) { return $false }
  $properties = @($Status.PSObject.Properties.Name)
  if (@($required | Where-Object { $_ -notin $properties }).Count -gt 0) {
    return $false
  }
  if (
    $Status.schemaVersion -ne "auction-discovery-nightly-status-v1" -or
    $Status.state -ne "running" -or
    $Status.runtimeRevision -isnot [string] -or
    [string]$Status.runtimeRevision -ne $ExpectedRuntimeRevision -or
    -not (Test-DashboardSupervisorSafeText $Status.currentSourceId -MaximumLength 512) -or
    [string]$Status.currentSourceId -ne [string]$Reservation.sourceId
  ) { return $false }

  $deadline = ConvertTo-DashboardSupervisorTimestamp $Status.workflowDeadlineAt
  $updatedAt = ConvertTo-DashboardSupervisorTimestamp $Status.updatedAt
  if ($null -eq $deadline -or $null -eq $updatedAt -or $deadline -le $CheckedAt) {
    return $false
  }
  if ($updatedAt -gt $CheckedAt.AddMinutes(1) -or
      $CheckedAt - $updatedAt -gt [TimeSpan]::FromMinutes(10)) {
    return $false
  }

  $compatibleStages = @(
    "typescript_scheduler", "scheduler", "scheduler_snapshot",
    "scheduler_batch_started", "scheduler_batch_heartbeat",
    "scheduler_batch_completed", "scheduler_terminal", "scheduler_continue",
    "scheduler_wait", "scheduler_retry", "scheduler_reconciliation",
    "source_acquisition", "preparation", "projection_listing_refresh",
    "projection_source_refresh", "projection_group_refresh",
    "projection_global_refresh", "source_acquisition_readiness", "proximity",
    "detail", "action_deadline", "owner_refresh", "factual_supplement",
    "image_evidence", "primary_image", "enrichment_text",
    "enrichment_embedding", "preference_v2_score", "source_release",
    "reconciliation", "callback_reconciliation"
  )
  if ($Status.stage -notin $compatibleStages) { return $false }

  try {
    $process = Get-Process -Id ([int]$Status.processId) -ErrorAction Stop
    $process.Refresh()
    if ($process.HasExited) { return $false }
  } catch {
    return $false
  }

  $counterNames = @(
    "attemptCount", "invocationSourcesAttempted", "invocationSourcesCompleted",
    "terminalSourceCount", "campaignSourcesCompleted", "campaignSourcesTotal"
  )
  if (@($counterNames | Where-Object {
    -not (Test-DashboardSupervisorNonnegativeInteger $Status.$_)
  }).Count -gt 0) { return $false }
  $total = [long]$Status.campaignSourcesTotal
  if (
    $total -lt 1 -or $total -gt 128 -or
    [long]$Status.invocationSourcesAttempted -gt $total -or
    [long]$Status.invocationSourcesCompleted -gt $total -or
    [long]$Status.terminalSourceCount -gt $total -or
    [long]$Status.campaignSourcesCompleted -gt $total
  ) { return $false }

  $outcomes = @($Status.sourceOutcomes)
  if ($outcomes.Count -ne [long]$Status.campaignSourcesCompleted -or
      $outcomes.Count -gt $total) { return $false }
  $sourceIds = New-Object "System.Collections.Generic.HashSet[string]"
  foreach ($outcome in $outcomes) {
    if ($null -eq $outcome -or
        -not (Test-DashboardSupervisorSafeText $outcome.sourceId -MaximumLength 512) -or
        $outcome.outcome -notin @("refreshed", "skipped_recent", "preserved", "paused", "stopped", "blocked") -or
        -not $sourceIds.Add([string]$outcome.sourceId)) {
      return $false
    }
  }
  return Test-DashboardSupervisorLiveReservation `
    -Reservation $Reservation `
    -CheckedAt $CheckedAt
}

function Test-DashboardSupervisorPipelineIdle {
  param(
    [Parameter(Mandatory = $true)]$Idle,
    [Parameter(Mandatory = $true)][string]$StatusPath,
    [Parameter(Mandatory = $true)][string]$ExpectedRuntimeRevision
  )

  $required = @(
    "checkedAt", "idle", "active", "activeReservations", "activeWorkClaims",
    "orphanedRuns"
  )
  if ($null -eq $Idle) { return $false }
  $properties = @($Idle.PSObject.Properties.Name)
  if (@($required | Where-Object { $_ -notin $properties }).Count -gt 0 -or
      $Idle.idle -isnot [bool]) { return $false }
  $checkedAt = ConvertTo-DashboardSupervisorTimestamp $Idle.checkedAt
  if ($null -eq $checkedAt) { return $false }

  $active = @($Idle.active)
  $reservations = @($Idle.activeReservations)
  $workClaims = @($Idle.activeWorkClaims)
  $orphans = @($Idle.orphanedRuns)
  $reportedIdle = $active.Count -eq 0 -and
    $reservations.Count -eq 0 -and
    $workClaims.Count -eq 0
  if ([bool]$Idle.idle -ne $reportedIdle) { return $false }
  if ($active.Count -gt 0 -or $workClaims.Count -gt 0) { return $false }
  if ($orphans.Count -gt 1 -or $reservations.Count -gt 1) { return $false }
  foreach ($orphan in $orphans) {
    if (-not (Test-DashboardSupervisorExpiredOrphan -Orphan $orphan -CheckedAt $checkedAt)) {
      return $false
    }
  }
  foreach ($reservation in $reservations) {
    if (-not (Test-DashboardSupervisorLiveReservation -Reservation $reservation -CheckedAt $checkedAt)) {
      return $false
    }
  }

  if ($reservations.Count -eq 0) { return $true }
  if ($orphans.Count -ne 1 -or $orphans[0].runKind -ne "discovery") {
    return $false
  }
  $status = Get-DashboardSupervisorNightlyStatus -StatusPath $StatusPath
  return Test-DashboardSupervisorLiveNightlyRunner `
    -Status $status `
    -Reservation $reservations[0] `
    -CheckedAt $checkedAt `
    -ExpectedRuntimeRevision $ExpectedRuntimeRevision
}

function Test-DashboardSupervisorCompanionIdle {
  param([Parameter(Mandatory = $true)]$Health)

  $required = @(
    "status", "active", "sourceAcquisitionActive",
    "sourceFrontierAcquisitionActive", "sourceFrontierAcquisitionCount",
    "preferenceV2ScoringActive", "sourcePublicationQueueDepth",
    "sourceAcquisitionCleanupBlocked", "scheduleMutationActive"
  )
  $properties = @($Health.PSObject.Properties.Name)
  if (@($required | Where-Object { $_ -notin $properties }).Count -gt 0) {
    return $false
  }
  return $Health.status -eq "ready" -and
    $Health.active -is [bool] -and -not $Health.active -and
    $Health.sourceAcquisitionActive -is [bool] -and
      -not $Health.sourceAcquisitionActive -and
    $Health.sourceFrontierAcquisitionActive -is [bool] -and
      -not $Health.sourceFrontierAcquisitionActive -and
    $Health.sourceFrontierAcquisitionCount -is [ValueType] -and
      [long]$Health.sourceFrontierAcquisitionCount -eq 0 -and
    $Health.preferenceV2ScoringActive -is [bool] -and
      -not $Health.preferenceV2ScoringActive -and
    $Health.sourcePublicationQueueDepth -is [ValueType] -and
      [long]$Health.sourcePublicationQueueDepth -eq 0 -and
    $Health.sourceAcquisitionCleanupBlocked -is [bool] -and
      -not $Health.sourceAcquisitionCleanupBlocked -and
    $Health.scheduleMutationActive -is [bool] -and
      -not $Health.scheduleMutationActive
}

function Test-DashboardSupervisorNightlyRuntimeCheck {
  param([Parameter(Mandatory = $true)]$Status)

  $required = @(
    "state", "stage", "processId", "attemptCount",
    "invocationSourcesAttempted", "invocationSourcesCompleted", "updatedAt"
  )
  $properties = @($Status.PSObject.Properties.Name)
  if (@($required | Where-Object { $_ -notin $properties }).Count -gt 0) {
    return $false
  }
  return $Status.state -eq "running" -and
    $Status.stage -eq "runtime_check" -and
    $Status.processId -is [ValueType] -and [long]$Status.processId -gt 0 -and
    $Status.attemptCount -is [ValueType] -and [long]$Status.attemptCount -eq 0 -and
    $Status.invocationSourcesAttempted -is [ValueType] -and
      [long]$Status.invocationSourcesAttempted -eq 0 -and
    $Status.invocationSourcesCompleted -is [ValueType] -and
      [long]$Status.invocationSourcesCompleted -eq 0 -and
    $Status.updatedAt -is [string] -and $Status.updatedAt.Length -le 128
}
