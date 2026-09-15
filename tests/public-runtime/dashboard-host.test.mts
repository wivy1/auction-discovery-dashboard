import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

test("dashboard host gates descendants, sets the Worker heap limit, and drains its job", {
  skip: process.platform !== "win32",
  timeout: 60_000,
}, () => {
  const testDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(testDirectory, "../..");
  const fixtureRoot = join(projectRoot, ".wrangler", "public-runtime-tests");
  mkdirSync(fixtureRoot, { recursive: true });
  const directory = mkdtempSync(join(fixtureRoot, "dashboard host "));
  const fixturePath = join(directory, "child fixture.mjs");
  const receiptPath = join(directory, "child receipt.json");
  const controlPath = join(directory, "control fixture.ps1");
  const hostPath = join(projectRoot, "scripts", "dev-dashboard-host.ps1");
  const runtimePath = join(projectRoot, "scripts", "runtime.ps1");
  const gateName = `Local\\auction-discovery-dashboard-${randomUUID().replaceAll("-", "")}`;

  writeFileSync(fixturePath, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
  stdio: "ignore", windowsHide: true,
});
child.on("spawn", () => writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({
  processId: process.pid, descendantId: child.pid,
  flags: process.env.MINIFLARE_WORKERD_V8_FLAGS ?? null,
})));
setTimeout(() => {}, 30000);
`, "utf8");

  writeFileSync(controlPath, `
$ErrorActionPreference = 'Stop'
. ${powershellLiteral(runtimePath)}
$env:MINIFLARE_WORKERD_V8_FLAGS = '--max-old-space-size=768'
$gate = $null
$job = $null
$hostProcess = $null
$fixtureProcesses = @()
try {
  $gate = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, ${powershellLiteral(gateName)})
  $job = New-DashboardProcessJob
  $quote = [char]34
  $hostPath = ${powershellLiteral(hostPath)}
  $nodePath = ${powershellLiteral(process.execPath)}
  $fixturePath = ${powershellLiteral(fixturePath)}
  $gateName = ${powershellLiteral(gateName)}
  $arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $quote$hostPath$quote -GateName $quote$gateName$quote -NodeExe $quote$nodePath$quote -VinextCli $quote$fixturePath$quote"
  $hostProcess = Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList $arguments -WorkingDirectory ${powershellLiteral(directory)} -WindowStyle Hidden -RedirectStandardOutput ${powershellLiteral(join(directory, "stdout.log"))} -RedirectStandardError ${powershellLiteral(join(directory, "stderr.log"))} -PassThru
  Start-Sleep -Milliseconds 200
  $startedBeforeAssignment = Test-Path -LiteralPath ${powershellLiteral(receiptPath)}
  Add-ProcessToDashboardJob -Job $job -Process $hostProcess
  Start-Sleep -Milliseconds 200
  $beforeRelease = Get-DashboardProcessJobActiveCount -Job $job
  $startedBeforeRelease = Test-Path -LiteralPath ${powershellLiteral(receiptPath)}
  $gate.Set() | Out-Null
  $deadline = [DateTimeOffset]::UtcNow.AddSeconds(10)
  do {
    $active = Get-DashboardProcessJobActiveCount -Job $job
    if ($active -ge 3 -and (Test-Path -LiteralPath ${powershellLiteral(receiptPath)})) { break }
    Start-Sleep -Milliseconds 50
  } while ([DateTimeOffset]::UtcNow -lt $deadline)
  $receipt = Get-Content -LiteralPath ${powershellLiteral(receiptPath)} -Raw | ConvertFrom-Json
  $fixtureProcesses = @(
    Get-Process -Id ([int]$receipt.processId) -ErrorAction Stop
    Get-Process -Id ([int]$receipt.descendantId) -ErrorAction Stop
  )
  if ($active -lt 3) { throw 'The host, child, and descendant did not enter the job.' }
  $stopped = Stop-DashboardProcessJob -Job $job
  $job = $null
  if (-not $hostProcess.WaitForExit(5000)) { throw 'The owned host survived job teardown.' }
  foreach ($ownedProcess in $fixtureProcesses) {
    if (-not $ownedProcess.WaitForExit(5000)) { throw 'An owned descendant survived job teardown.' }
  }
  [pscustomobject]@{
    startedBeforeAssignment = $startedBeforeAssignment
    startedBeforeRelease = $startedBeforeRelease
    beforeRelease = $beforeRelease
    activeBeforeStop = $active
    activeAfterStop = $stopped.ActiveProcesses
    descendantsExited = @($fixtureProcesses | Where-Object { -not $_.HasExited }).Count -eq 0
    flags = [string]$receipt.flags
  } | ConvertTo-Json -Compress
} finally {
  if ($job) { Stop-DashboardProcessJob -Job $job | Out-Null }
  foreach ($ownedProcess in @($hostProcess) + $fixtureProcesses) {
    if ($null -ne $ownedProcess) {
      if (-not $ownedProcess.HasExited) {
        $ownedProcess.Kill()
        if (-not $ownedProcess.WaitForExit(5000)) { throw 'Fixture cleanup did not finish.' }
      }
      $ownedProcess.Dispose()
    }
  }
  if ($gate) { $gate.Dispose() }
}
`, "utf8");

  try {
    const result = spawnSync("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", controlPath,
    ], { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: 45_000, maxBuffer: 64 * 1024 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.startedBeforeAssignment, false);
    assert.equal(evidence.startedBeforeRelease, false);
    assert.equal(evidence.beforeRelease, 1);
    assert.ok(evidence.activeBeforeStop >= 3);
    assert.equal(evidence.activeAfterStop, 0);
    assert.equal(evidence.descendantsExited, true);
    assert.equal(evidence.flags, "--max-old-space-size=512");
  } finally {
    const anchoredRoot = realpathSync(fixtureRoot);
    const cleanupPath = realpathSync(directory);
    const childPath = relative(anchoredRoot, cleanupPath);
    assert.ok(childPath !== "" && childPath !== ".." && !childPath.startsWith(`..${sep}`) && !isAbsolute(childPath), "Fixture cleanup escaped its root");
    rmSync(cleanupPath, { recursive: true, force: true });
  }
});
