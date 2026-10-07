import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, powershell, projectRoot, psLiteral } from "./entrypoint-fixtures.mts";

const source = await readFile(join(projectRoot, "scripts/nightly.ps1"), "utf8");
const start = source.indexOf("function Invoke-OptionalSourceRepair {"); const end = source.indexOf("function Get-CheckoutRuntimeRevision", start);
assert.ok(start > 0 && end > start); const helper = source.slice(start, end);
const terminalFinally = source.slice(source.lastIndexOf("} finally {") + "} finally {".length).trim();
assert.ok(terminalFinally.endsWith("}")); const finalBody = terminalFinally.slice(0, -1);
const windows = process.platform === "win32";
const idle = { idle: true, active: [], activeReservations: [], activeWorkClaims: [], orphanedRuns: [] };
async function runHook(root: string, options: { state?: string; healthOnly?: boolean; enabled?: string; childExit?: number; omitChild?: boolean; observation?: unknown; idleExit?: number; omitEnd?: boolean } = {}) {
  const scripts = join(root, "scripts"); await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, "node-runtime-preload.mjs"), "// Inert fixture preload.\n");
  await writeFile(join(scripts, "check-pipeline-idle.mjs"), `console.log(${JSON.stringify(JSON.stringify(options.observation ?? idle))});process.exitCode=${options.idleExit ?? 0};\n`);
  if (!options.omitChild) await writeFile(join(scripts, "source-repair-sandbox.mts"), `import {openSync,closeSync,writeFileSync} from 'node:fs';import {fileURLToPath} from 'node:url';
    const root=fileURLToPath(new URL('../',import.meta.url));const lock=openSync(root+'nightly.lock','r+');closeSync(lock);
    writeFileSync(root+'child.json',JSON.stringify({args:process.argv.slice(2),lockReleased:true}));process.exitCode=${options.childExit ?? 0};`);
  const harness = join(scripts, "hook-fixture.ps1");
  await writeFile(harness, `Set-StrictMode -Version Latest\n$ErrorActionPreference='Stop'\n${helper}\n
    $NodeExe=${psLiteral(process.execPath)}
    $NodeRuntimePreload=([Uri]${psLiteral(join(scripts, "node-runtime-preload.mjs"))}).AbsoluteUri
    $nightlyStatus=@{state=${psLiteral(options.state ?? "completed")};startedAt='2026-01-01T00:00:00.000Z';endedAt=${options.omitEnd ? "$null" : "'2026-01-01T01:00:00.000Z'"}}
    $HealthCheckOnly=$${options.healthOnly ? "true" : "false"};$ownedDevProcess=$null
    $nightlyLock=[IO.File]::Open(${psLiteral(join(root, "nightly.lock"))},[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    $global:LASTEXITCODE=77
    try {} finally {${finalBody}}
    [pscustomobject]@{priorExitPreserved=($global:LASTEXITCODE -eq 77);state=$nightlyStatus['state'];endedAt=$nightlyStatus['endedAt']}|ConvertTo-Json -Compress
  `);
  const result = powershell(harness, root, [], { SOURCE_REPAIR_ENABLED: options.enabled });
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout.trim());
  assert.equal(output.priorExitPreserved, true); assert.equal(output.state, options.state ?? "completed");
  return { result, output };
}
test("terminal hook invokes the fixed CLI after releasing the real exclusive nightly lock", { skip: !windows }, async () => fixture(async (root) => {
  await runHook(root); const child = JSON.parse(await readFile(join(root, "child.json"), "utf8"));
  assert.equal(child.lockReleased, true); assert.deepEqual(child.args, ["run", "--since", "2026-01-01T00:00:00.000Z", "--until", "2026-01-01T01:00:00.000Z", "--limit", "2"]);
}));
for (const [name, options] of [
  ["health-only", { healthOnly: true }], ["active workflow", { state: "running" }], ["failed workflow", { state: "failed" }],
  ["missing terminal end", { omitEnd: true }], ["explicit process opt-out", { enabled: "0" }],
  ["active ownership", { observation: { ...idle, idle: false, active: [{}] } }],
  ["ambiguous ownership", { observation: { ...idle, active: null } }], ["unavailable idle observation", { idleExit: 9 }],
] as const) test(`terminal hook skips ${name} and preserves discovery exit`, { skip: !windows }, async () => fixture(async (root) => {
  await runHook(root, options); await assert.rejects(stat(join(root, "child.json")), { code: "ENOENT" });
}));
test("optional child nonzero does not alter completed discovery status or exit", { skip: !windows }, async () => fixture(async (root) => {
  await runHook(root, { childExit: 13 }); assert.ok(await stat(join(root, "child.json")));
}));
test("missing optional CLI leaves the completed discovery result intact", { skip: !windows }, async () => fixture(async (root) => {
  await runHook(root, { omitChild: true }); await assert.rejects(stat(join(root, "child.json")), { code: "ENOENT" });
}));
