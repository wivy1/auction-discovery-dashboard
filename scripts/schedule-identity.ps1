$scheduleProjectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\').ToLowerInvariant()
$scheduleHasher = [Security.Cryptography.SHA256]::Create()
try {
  $scheduleHash = [BitConverter]::ToString($scheduleHasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($scheduleProjectRoot))).Replace('-', '').Substring(0, 16).ToLowerInvariant()
} finally { $scheduleHasher.Dispose() }
$nightlyTaskName = "Auction Discovery - $scheduleHash - Nightly"
$serverTaskName = "Auction Discovery - $scheduleHash - Local Server"
