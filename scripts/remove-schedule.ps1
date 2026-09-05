$ErrorActionPreference = "Stop"
. "$PSScriptRoot\schedule-identity.ps1"

foreach ($name in @($nightlyTaskName, $serverTaskName)) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "Removed $name."
  }
}
