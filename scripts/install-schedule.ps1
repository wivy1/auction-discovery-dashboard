param(
  [ValidateCount(1, 2)]
  [string[]]$Weekdays = @("Tuesday", "Saturday"),

  [ValidatePattern("^(?:[01]\d|2[0-3]):[0-5]\d$")]
  [string]$LocalTime = "02:00",

  [switch]$StartServerAtLogon
)

$ErrorActionPreference = "Stop"
. "$PSScriptRoot\schedule-identity.ps1"
$projectRoot = Split-Path -Parent $PSScriptRoot
$nightlyScript = (Resolve-Path (Join-Path $PSScriptRoot "nightly.ps1")).Path
$devHostScript = (Resolve-Path (Join-Path $PSScriptRoot "dev-host.ps1")).Path
$powershell = (Get-Command powershell.exe).Source
$canonicalWeekdays = @("Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday")
$normalizedWeekdays = @($canonicalWeekdays | Where-Object { $_ -cin $Weekdays })
if ($normalizedWeekdays.Count -ne $Weekdays.Count) {
  throw "Weekdays must contain one or two unique canonical weekday names."
}
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
  -DaysOfWeek $normalizedWeekdays `
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
  -TaskName $nightlyTaskName `
  -Description "Runs scheduled bounded local auction discovery, starting its local runtime when needed." `
  -Action $nightlyAction `
  -Trigger $nightlyTrigger `
  -Settings $settings `
  -Force | Out-Null

if ($StartServerAtLogon) {
  $serverAction = New-ScheduledTaskAction `
    -Execute $powershell `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$devHostScript`"" `
    -WorkingDirectory $projectRoot
  $serverTrigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask `
    -TaskName $serverTaskName `
    -Description "Keeps the local auction-discovery dashboard available after sign-in." `
    -Action $serverAction `
    -Trigger $serverTrigger `
    -Settings (New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)) `
    -Force | Out-Null
}

Write-Host "Scheduled discovery for $($normalizedWeekdays -join ', ') at $LocalTime."
Write-Host "Scheduled discovery starts and later stops an owned local runtime when the dashboard is not already running."
if ($StartServerAtLogon) { Write-Host "The optional local-server-at-logon task was also installed." }
