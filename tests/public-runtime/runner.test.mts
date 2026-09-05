import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

interface RunnerReceipt {
  id: string;
  state: string;
  exit_code: number | null;
  runner_pid: number;
  runner_started_at: string;
  created_at: string;
  ended_at: string;
  log_path: string;
  manifest_path: string;
  reused: boolean;
}

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureParent = resolve(root, ".wrangler", "public-runtime-tests");
const revision = `sha256:${"a".repeat(64)}`;
const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function fixture(): string {
  mkdirSync(fixtureParent, { recursive: true });
  const directory = mkdtempSync(resolve(fixtureParent, "checkout with spaces-"));
  mkdirSync(resolve(directory, "scripts"));
  for (const name of ["start-visible-process.ps1", "discovery-runner.ps1", "runner-state.ps1", "get-visible-processes.ps1", "schedule-identity.ps1"]) {
    copyFileSync(resolve(root, "scripts", name), resolve(directory, "scripts", name));
  }
  return directory;
}

function cleanup(directory: string): void {
  assert.ok(resolve(directory).startsWith(`${fixtureParent}${sep}`));
  rmSync(directory, { recursive: true, force: true });
}

function launchArguments(directory: string): string[] {
  const command = `& '${resolve(directory, "scripts", "nightly.ps1").replaceAll("'", "''")}' -RequireExistingRuntime -ExpectedRuntimeRevision '${revision}'`;
  return [...args, "-File", resolve(directory, "scripts", "start-visible-process.ps1"),
    "-ProjectName", "auction-discovery", "-TaskName", "dashboard", "-Activity", "nightly-discovery",
    "-WorkingDirectory", directory, "-CommandBase64", Buffer.from(command).toString("base64")];
}

function launch(directory: string): RunnerReceipt {
  return JSON.parse(execFileSync(powershell, launchArguments(directory),
  { encoding: "utf8", windowsHide: true, timeout: 15_000 }));
}

async function terminal(directory: string, id: string): Promise<RunnerReceipt> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const receipt = JSON.parse(readFileSync(resolve(directory, ".wrangler", "logs", "discovery-runners", `${id}.json`), "utf8"));
    if (receipt.state === "completed" || receipt.state === "failed") return receipt;
    await sleep(250);
  }
  throw new Error("Fixture runner did not complete within 20 seconds");
}

test("launcher returns before completion, reuses the exact live runner, and persists success after its caller exits", { skip: process.platform !== "win32" }, async () => {
  const directory = fixture();
  writeFileSync(resolve(directory, "scripts", "nightly.ps1"), "param([switch]$RequireExistingRuntime,[string]$ExpectedRuntimeRevision)\nStart-Sleep -Seconds 4\nWrite-Output 'fixture completed'\nexit 0\n");
  let first: RunnerReceipt | undefined;
  try {
    first = launch(directory);
    assert.ok(["starting", "running"].includes(first.state));
    assert.equal(first.exit_code, null);
    const second = launch(directory);
    assert.equal(second.id, first.id);
    assert.equal(second.reused, true);
    const receipt = await terminal(directory, first.id);
    assert.equal(receipt.state, "completed");
    assert.equal(receipt.exit_code, 0);
    assert.ok(receipt.runner_pid > 0);
    assert.ok(Date.parse(receipt.created_at) <= Date.parse(receipt.runner_started_at));
    assert.ok(Date.parse(receipt.runner_started_at) <= Date.parse(receipt.ended_at));
    assert.match(readFileSync(receipt.log_path, "utf8"), /fixture completed/);
  } finally {
    if (first) await terminal(directory, first.id);
    cleanup(directory);
  }
});

test("simultaneous launches serialize admission and acknowledge one exact runner", { skip: process.platform !== "win32" }, async () => {
  const directory = fixture();
  writeFileSync(resolve(directory, "scripts", "nightly.ps1"), "param([switch]$RequireExistingRuntime,[string]$ExpectedRuntimeRevision)\nStart-Sleep -Seconds 3\nexit 0\n");
  let first: RunnerReceipt | undefined;
  try {
    const run = promisify(execFile);
    const outputs = await Promise.all([0, 1].map(() => run(powershell, launchArguments(directory), {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
    })));
    const receipts = outputs.map(({ stdout }) => JSON.parse(stdout));
    first = receipts[0];
    assert.equal(receipts[0].id, receipts[1].id);
    assert.equal(receipts.filter(({ reused }) => reused).length, 1);
    assert.equal((await terminal(directory, first!.id)).exit_code, 0);
  } finally {
    if (first) await terminal(directory, first.id);
    cleanup(directory);
  }
});

test("runner preserves a nonzero child exit and the registry rejects a reused PID start time", { skip: process.platform !== "win32" }, async () => {
  const directory = fixture();
  writeFileSync(resolve(directory, "scripts", "nightly.ps1"), "param([switch]$RequireExistingRuntime,[string]$ExpectedRuntimeRevision)\nexit 7\n");
  let first: RunnerReceipt | undefined;
  try {
    first = launch(directory);
    const receipt = await terminal(directory, first.id);
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.exit_code, 7);
    Object.assign(receipt, { state: "running", host_pid: process.pid, runner_pid: process.pid,
      host_started_at: "2000-01-01T00:00:00.0000000Z", runner_started_at: "2000-01-01T00:00:00.0000000Z" });
    writeFileSync(receipt.manifest_path, JSON.stringify(receipt));
    const state = JSON.parse(execFileSync(powershell, [...args, "-File", resolve(directory, "scripts", "get-visible-processes.ps1"), "-AsJson"], { encoding: "utf8", windowsHide: true }));
    assert.equal(state[0].state, "exited-unrecorded");
    // Restore the real terminal receipt for fixture teardown.
    receipt.state = "failed";
    writeFileSync(receipt.manifest_path, JSON.stringify(receipt));
  } finally {
    if (first) await terminal(directory, first.id);
    cleanup(directory);
  }
});

test("schedule identities are stable per checkout and isolated between installations without invoking Task Scheduler", { skip: process.platform !== "win32" }, () => {
  const first = fixture();
  const second = fixture();
  const identity = (directory: string) => execFileSync(powershell, [...args, "-Command",
    `. '${resolve(directory, "scripts", "schedule-identity.ps1").replaceAll("'", "''")}'; Write-Output $nightlyTaskName; Write-Output $serverTaskName`], { encoding: "utf8", windowsHide: true });
  try {
    assert.equal(identity(first), identity(first));
    assert.notEqual(identity(first), identity(second));
    assert.match(identity(first), /Auction Discovery - [0-9a-f]{16} - Nightly/);
  } finally { cleanup(first); cleanup(second); }
});

test("setup installs the lockfile and bootstraps only an absent local source configuration", { skip: process.platform !== "win32" }, () => {
  const directory = fixture();
  try {
    for (const name of ["setup.ps1", "runtime.ps1"]) copyFileSync(resolve(root, "scripts", name), resolve(directory, "scripts", name));
    const binaryDirectory = resolve(directory, "bin");
    mkdirSync(binaryDirectory);
    writeFileSync(resolve(binaryDirectory, "pnpm.cmd"), '@echo off\necho %*>>"%~dp0pnpm-arguments.txt"\nexit /b 0\n');
    writeFileSync(resolve(directory, "source-adapters.example.ts"), "export default [];\n");
    const setup = () => execFileSync(powershell, [...args, "-File", resolve(directory, "scripts", "setup.ps1")], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, PATH: `${binaryDirectory};${process.env.PATH}` },
    });
    setup();
    assert.equal(readFileSync(resolve(directory, "source-adapters.local.ts"), "utf8"), "export default [];\n");
    writeFileSync(resolve(directory, "source-adapters.local.ts"), "// operator configuration\nexport default [];\n");
    setup();
    assert.equal(readFileSync(resolve(directory, "source-adapters.local.ts"), "utf8"), "// operator configuration\nexport default [];\n");
    const invocations = readFileSync(resolve(binaryDirectory, "pnpm-arguments.txt"), "utf8").trim().split(/\r?\n/);
    assert.deepEqual(invocations, ["install --frozen-lockfile --store-dir .pnpm-store", "install --frozen-lockfile --store-dir .pnpm-store"]);
  } finally { cleanup(directory); }
});
