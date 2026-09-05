param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Get", "Set", "Remove")]
  [string]$Action,

  [string]$Weekdays,

  [ValidatePattern("^(?:[01]\d|2[0-3]):[0-5]\d$")]
  [string]$LocalTime
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\schedule-identity.ps1"
$taskName = $nightlyTaskName
$projectRoot = Split-Path -Parent $PSScriptRoot
$nightlyScript = (Resolve-Path (Join-Path $PSScriptRoot "nightly.ps1")).Path
$powershell = (Get-Command powershell.exe).Source
$canonicalWeekdays = @("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
[string[]]$startBoundaryFormats = @(
  "yyyy-MM-dd'T'HH:mm:ss",
  "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF",
  "yyyy-MM-dd'T'HH:mm:ssK",
  "yyyy-MM-dd'T'HH:mm:ss.FFFFFFFK"
)
$weekdayBits = [ordered]@{
  Sunday = 1
  Monday = 2
  Tuesday = 4
  Wednesday = 8
  Thursday = 16
  Friday = 32
  Saturday = 64
}

function Get-ValidatedWeekdays {
  param([string]$Value)

  $items = @($Value -split ",")
  if ($items.Count -lt 1 -or $items.Count -gt 2) {
    throw "Weekdays must contain one or two canonical weekday names."
  }
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($item in $items) {
    if ($item -cnotin $canonicalWeekdays -or -not $seen.Add($item)) {
      throw "Weekdays must contain one or two unique canonical weekday names."
    }
  }
  return @($canonicalWeekdays | Where-Object { $_ -cin $items })
}

function Get-WeeklyTriggerWeekdays {
  param($Trigger)

  if ([int]$Trigger.WeeksInterval -ne 1) {
    throw "Unsupported or ambiguous trigger configuration for '$taskName'."
  }
  $dayMask = [int]$Trigger.DaysOfWeek
  if ($dayMask -eq 0 -or ($dayMask -band (-bnot 127)) -ne 0) {
    throw "Unsupported or ambiguous trigger configuration for '$taskName'."
  }
  $weekdays = @(
    foreach ($entry in $weekdayBits.GetEnumerator()) {
      if (($dayMask -band [int]$entry.Value) -ne 0) { [string]$entry.Key }
    }
  )
  if ($weekdays.Count -lt 1 -or $weekdays.Count -gt 2) {
    throw "Unsupported or ambiguous trigger configuration for '$taskName'."
  }
  return $weekdays
}

function Get-ExistingScheduledTask {
  try {
    return Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  } catch {
    if (
      [string]$_.FullyQualifiedErrorId -eq
        "CmdletizationQuery_NotFound_TaskName,Get-ScheduledTask"
    ) {
      return $null
    }
    throw
  }
}

function Write-ScheduleState {
  param([string]$Outcome)

  $task = Get-ExistingScheduledTask
  if (-not $task) {
    [pscustomobject]@{
      outcome = $Outcome
      available = $true
      configured = $false
      enabled = $false
      scheduleKind = $null
      weekdays = $null
      localTime = $null
      state = "not_configured"
      nextRunAt = $null
      lastRunAt = $null
      lastResult = $null
    } | ConvertTo-Json -Compress
    return
  }

  $triggers = @($task.Triggers)
  if ($triggers.Count -ne 1) {
    throw "Unsupported or ambiguous trigger configuration for '$taskName'."
  }
  $trigger = $triggers[0]
  $scheduleKind = $null
  [object[]]$scheduleWeekdays = $null
  switch ($trigger.CimClass.CimClassName) {
    "MSFT_TaskWeeklyTrigger" {
      $scheduleKind = "weekly"
      $scheduleWeekdays = @(Get-WeeklyTriggerWeekdays -Trigger $trigger)
    }
    "MSFT_TaskDailyTrigger" {
      $scheduleKind = "legacy_daily"
    }
    default {
      throw "Unsupported or ambiguous trigger configuration for '$taskName'."
    }
  }

  try {
    $start = [DateTimeOffset]::ParseExact(
      [string]$trigger.StartBoundary,
      $startBoundaryFormats,
      [System.Globalization.CultureInfo]::InvariantCulture,
      [System.Globalization.DateTimeStyles]::AssumeLocal
    )
  } catch {
    throw "Unsupported or ambiguous trigger configuration for '$taskName'."
  }
  if (($start.Ticks % [TimeSpan]::TicksPerMinute) -ne 0) {
    throw "Unsupported or ambiguous trigger configuration for '$taskName'."
  }
  $info = Get-ScheduledTaskInfo -TaskName $taskName
  [pscustomobject]@{
    outcome = $Outcome
    available = $true
    configured = $true
    enabled = $task.State -ne "Disabled"
    scheduleKind = $scheduleKind
    weekdays = $scheduleWeekdays
    localTime = $start.ToString("HH:mm")
    state = $task.State.ToString().ToLowerInvariant()
    nextRunAt = if ($info.NextRunTime -and $info.NextRunTime -gt [DateTime]::MinValue) {
      ([DateTimeOffset]$info.NextRunTime).ToString("o")
    } else { $null }
    lastRunAt = if ($info.LastRunTime -and $info.LastRunTime -gt [DateTime]::MinValue) {
      ([DateTimeOffset]$info.LastRunTime).ToString("o")
    } else { $null }
    lastResult = $info.LastTaskResult
  } | ConvertTo-Json -Compress
}

try {
  switch ($Action) {
    "Get" {
      Write-ScheduleState -Outcome "read"
    }
    "Set" {
      if (-not $Weekdays -or -not $LocalTime) {
        throw "Weekdays and LocalTime are required when Action is Set."
      }
      $validatedWeekdays = @(Get-ValidatedWeekdays -Value $Weekdays)
      $weeklyTime = [DateTime]::ParseExact(
        $LocalTime,
        "HH:mm",
        [System.Globalization.CultureInfo]::InvariantCulture
      )
      $nightlyAction = New-ScheduledTaskAction `
        -Execute $powershell `
        -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$nightlyScript`"" `
        -WorkingDirectory $projectRoot
      $nightlyTrigger = New-ScheduledTaskTrigger `
        -Weekly `
        -WeeksInterval 1 `
        -DaysOfWeek $validatedWeekdays `
        -At $weeklyTime
      $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -WakeToRun `
        -RunOnlyIfNetworkAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 5) `
        -ExecutionTimeLimit (New-TimeSpan -Hours 12) `
        -MultipleInstances IgnoreNew

      Register-ScheduledTask `
        -TaskName $taskName `
        -Description "Runs scheduled bounded local auction discovery, starting its local runtime when needed." `
        -Action $nightlyAction `
        -Trigger $nightlyTrigger `
        -Settings $settings `
        -Force | Out-Null
      Write-ScheduleState -Outcome "saved"
    }
    "Remove" {
      if (Get-ExistingScheduledTask) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
      }
      Write-ScheduleState -Outcome "removed"
    }
  }
} catch {
  [pscustomobject]@{
    outcome = "failed"
    available = $false
    configured = $false
    enabled = $false
    scheduleKind = $null
    weekdays = $null
    localTime = $null
    state = "unavailable"
    nextRunAt = $null
    lastRunAt = $null
    lastResult = $null
    error = $_.Exception.Message
  } | ConvertTo-Json -Compress
  exit 1
}
