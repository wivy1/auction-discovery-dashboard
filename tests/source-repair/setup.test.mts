import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, powershell, projectRoot, setupFixture } from "./entrypoint-fixtures.mts";

const windows = process.platform === "win32";
const setup = await readFile(join(projectRoot, "scripts/setup.ps1"), "utf8");
const sandboxSetup = await readFile(join(projectRoot, "scripts/setup-source-repair.ps1"), "utf8");
test("ordinary setup creates empty repair configuration without registering adapters or preparing a sandbox", { skip: !windows }, async () => fixture(async (root) => {
  const script = await setupFixture(root, setup);
  const result = powershell(script, root); assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(root, "source-adapters.local.ts"), "utf8"), "export const sourceAdapters = [];\n");
  assert.deepEqual(JSON.parse(await readFile(join(root, "source-repair.config.local.json"), "utf8")), { schemaVersion: "source-repair-config-v1", targets: [] });
  await assert.rejects(stat(join(root, "work/source-repairs/toolchain")), { code: "ENOENT" });
  await assert.rejects(stat(join(root, "source-adapters.local")), { code: "ENOENT" });
}));
test("ordinary setup preserves existing source, repair and environment files exactly", { skip: !windows }, async () => fixture(async (root) => {
  const script = await setupFixture(root, setup);
  const files = { "source-adapters.local.ts": "operator-owned source\r\n", "source-repair.config.local.json": "operator-owned config\r\n", ".env.local": "FIXTURE_CANARY=never_print_this\r\n" };
  for (const [path, value] of Object.entries(files)) await writeFile(join(root, path), value);
  const result = powershell(script, root); assert.equal(result.status, 0, result.stderr);
  for (const [path, value] of Object.entries(files)) assert.equal(await readFile(join(root, path), "utf8"), value);
  assert.ok(!`${result.stdout}${result.stderr}`.includes("never_print_this"));
}));
test("failed dependency installation does not initialize local configuration", { skip: !windows }, async () => fixture(async (root) => {
  const script = await setupFixture(root, setup, 8);
  const result = powershell(script, root); assert.equal(result.status, 8, result.stderr);
  await assert.rejects(stat(join(root, "source-repair.config.local.json")), { code: "ENOENT" });
}));

async function mockedSandboxSetup(root: string): Promise<string> {
  const scripts = join(root, "scripts"); await mkdir(scripts, { recursive: true });
  const marker = "\n$repairStaging = $null\ntry {";
  assert.equal(sandboxSetup.split(marker).length, 2);
  const mock = `
$repairWsl = Join-Path $PSScriptRoot 'fixture-wsl.exe'
function Invoke-RepairSetupWsl {
  param([string[]]$Arguments)
  if ($Arguments[0] -eq '/usr/bin/uname') { return 'x86_64' }
  if ($Arguments[0] -eq '/usr/bin/bwrap') { return }
  throw 'Unexpected mocked WSL operation.'
}
function Invoke-WebRequest { throw 'A fixture attempted network download.' }
`;
  const path = join(scripts, "setup-source-repair.ps1");
  await writeFile(join(scripts, "fixture-wsl.exe"), "inert availability fixture");
  await writeFile(path, sandboxSetup.replace(marker, mock + marker)); return path;
}
test("optional check-only does not download or create a toolchain", { skip: !windows }, async () => fixture(async (root) => {
  const script = await mockedSandboxSetup(root); const result = powershell(script, root, ["-CheckOnly"]);
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout.trim());
  assert.equal(output.toolchainReady, false); assert.equal(output.checkOnly, true); assert.equal(output.modelsInstalled, 0);
  await assert.rejects(stat(join(root, "work")), { code: "ENOENT" });
}));
test("wrong offline archive is rejected before extraction and owned staging is removed", { skip: !windows }, async () => fixture(async (root) => {
  const script = await mockedSandboxSetup(root); const archive = join(root, "fixture.tar.xz"); await writeFile(archive, "not the pinned archive");
  const result = powershell(script, root, ["-ArchivePath", archive]); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixed SHA-256 pin/u);
  assert.deepEqual(await readdir(join(root, "work/source-repairs/toolchain")), []);
  assert.equal(await readFile(archive, "utf8"), "not the pinned archive");
}));
test("existing invalid toolchain is preserved and never replaced", { skip: !windows }, async () => fixture(async (root) => {
  const script = await mockedSandboxSetup(root); const directory = join(root, "work/source-repairs/toolchain/node-v24.18.0-linux-x64/bin");
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, "node"), "operator-owned invalid node");
  const result = powershell(script, root); assert.notEqual(result.status, 0); assert.match(result.stderr, /preserved unchanged/u);
  assert.equal(await readFile(join(directory, "node"), "utf8"), "operator-owned invalid node");
}));
test("actual optional setup accepts the verified offline official archive in a disposable project", { skip: !windows || !process.env.SOURCE_REPAIR_SETUP_ARCHIVE }, async () => fixture(async (root) => {
  const scripts = join(root, "scripts"); await mkdir(scripts, { recursive: true }); const path = join(scripts, "setup-source-repair.ps1");
  await copyFile(join(projectRoot, "scripts/setup-source-repair.ps1"), path);
  const result = powershell(path, root, ["-ArchivePath", process.env.SOURCE_REPAIR_SETUP_ARCHIVE!]);
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout.trim());
  assert.equal(output.toolchainReady, true); assert.equal(output.nodeVersion, "24.18.0");
  assert.equal(output.nodeSha256, "41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c");
  assert.equal(output.modelsInstalled, 0); assert.equal(output.adaptersRegistered, 0);
}));
