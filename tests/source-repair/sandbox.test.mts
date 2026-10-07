import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hash, REPAIR_CAPABILITY, REPAIR_SCHEMA, validateProposal, type RepairJob } from "../../lib/source-repair/core.ts";
import { validateRepairTarget } from "../../lib/source-repair/config.ts";
import { captureSourceParserEvidence } from "../../lib/source-repair/evidence.ts";
import { bundleRepairEntries, createLinuxSandbox, createRepairSnapshot, LINUX_NODE_HASH, runBoundedProcess, runLinuxSandbox,
  scrubEnvironment, validateIsolatedProposal, windowsToWslPath } from "../../lib/source-repair/sandbox.ts";

const PROJECT = fileURLToPath(new URL("../../", import.meta.url));
const BASE = join(PROJECT, "work/source-repairs/sandbox-tests");
async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  await mkdir(BASE, { recursive: true }); const root = await mkdtemp(join(BASE, "f-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(BASE) + sep)); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function targetFixture(root: string): Promise<RepairJob> {
  await cp(join(PROJECT, "lib"), join(root, "lib"), { recursive: true });
  const local = "source-adapters.local/example-json"; await mkdir(join(root, local), { recursive: true });
  for (const file of ["adapter.ts", "adapter.test.ts", "fixture.json"]) await cp(join(PROJECT, "examples/source-repair", file), join(root, local, file));
  const target = await validateRepairTarget(root, { sourceId: "example_json", adapterPath: `${local}/adapter.ts`, testFiles: [`${local}/adapter.test.ts`], files: [`${local}/fixture.json`] });
  return { schemaVersion: REPAIR_SCHEMA, id: hash("snapshot_fixture"), sourceId: target.sourceId, adapterPath: target.adapterPath,
    adapterHash: target.fileHashes[target.adapterPath]!, target, targetHash: target.targetHash, failureFingerprint: hash("fixture_failure"),
    diagnostic: { sourceId: target.sourceId, errorCode: "SourceAdapterError", message: "Example listing description must be a string.", observedAt: "2026-01-01T00:00:00.000Z", evidence: "source_run" },
    disposition: "parser_proposal", reason: "fixture", createdAt: "2026-01-01T00:00:00.000Z", state: "prepared" };
}
async function compilerFixture(root: string, source: string) {
  const copy = join(root, "copy"); const entry = "tests/source-repair-target/input.test.ts";
  await mkdir(dirname(join(copy, entry)), { recursive: true });
  await writeFile(join(copy, "package.json"), '{"type":"module"}');
  await writeFile(join(copy, "tsconfig.json"), '{"compilerOptions":{"target":"ES2022","module":"ESNext"}}');
  await writeFile(join(copy, entry), source); return { copy, entry };
}

test("snapshot copies only the validated target union and replaces the local registry", async (t) => {
  const root = await fixture(t); const job = await targetFixture(root);
  await writeFile(join(root, ".env.local"), "DO_NOT_COPY=PRIVATE_FIXTURE_MARKER");
  await writeFile(join(root, "source-repair.config.local.json"), "{\"doNotCopy\":true}");
  await writeFile(join(root, "source-adapters.local.ts"), "throw new Error('DO_NOT_EXECUTE_REGISTRY')");
  await writeFile(join(root, "source-adapters.local/example-json/unlisted.txt"), "unapproved fixture data");
  const copy = join(root, "copy"); const tests = await createRepairSnapshot(root, job, copy);
  assert.deepEqual(tests, [...job.target.testFiles, "tests/source-repair-target/contracts.test.ts"]);
  for (const path of [".env.local", "source-repair.config.local.json", "source-adapters.local.ts", "source-adapters.local/example-json/unlisted.txt"]) await assert.rejects(lstat(join(copy, path)), { code: "ENOENT" });
  const bridge = await readFile(join(copy, "lib/sources/registry.ts"), "utf8");
  assert.match(bridge, /import \{ adapter \}/u); assert.ok(bridge.includes(job.adapterPath)); assert.ok(!bridge.includes("DO_NOT_EXECUTE_REGISTRY"));
  for (const [path, digest] of Object.entries(job.target.fileHashes)) assert.equal(hash(await readFile(join(copy, path))), digest);
  const outputs = await bundleRepairEntries(copy, tests);
  assert.deepEqual(outputs, ["tests/source-repair-target/t00.test.mjs", "tests/source-repair-target/t01.test.mjs"]);
});

test("target or immutable test drift is rejected before snapshotting", async (t) => {
  const root = await fixture(t); const job = await targetFixture(root);
  await writeFile(join(root, job.target.testFiles[0]!), "changed immutable test");
  await assert.rejects(createRepairSnapshot(root, job, join(root, "copy")), /repair_target_changed_since_preparation/u);
});

test("compiler never evaluates the copied adapter in the host", async (t) => {
  const root = await fixture(t); const { copy, entry } = await compilerFixture(root, "import {adapter} from '../../adapter'; export const selected = adapter;");
  await writeFile(join(copy, "adapter.ts"), "(globalThis as any).__repairHostExecuted = true; export const adapter = {manifest:{id:'fixture'}};");
  await bundleRepairEntries(copy, [entry]); assert.equal((globalThis as Record<string, unknown>).__repairHostExecuted, undefined);
});

for (const [name, source] of [["relative escape", "import '../../../outside';"], ["installed but unapproved package", "import 'typescript';"], ["data URL", "import 'data:text/javascript,export default 1';"]] as const) {
  test(`compiler rejects ${name} without host resolver fallthrough`, async (t) => {
    const root = await fixture(t); await writeFile(join(root, "outside.ts"), "export const value = 'outside snapshot';");
    const { copy, entry } = await compilerFixture(root, source);
    await assert.rejects(bundleRepairEntries(copy, [entry]), /sandbox_(?:import_outside_snapshot|package_or_absolute_import_not_allowed)/u);
  });
}

test("compiler rejects absolute host paths", async (t) => {
  const root = await fixture(t); const outside = join(root, "outside.ts"); await writeFile(outside, "export const value = 1;");
  const { copy, entry } = await compilerFixture(root, `import ${JSON.stringify(outside)};`);
  await assert.rejects(bundleRepairEntries(copy, [entry]), /sandbox_package_or_absolute_import_not_allowed/u);
});

for (const operation of ["import", "require"] as const) {
  test(`compiler rejects computed ${operation} globs before outside enumeration or output`, async (t) => {
    const root = await fixture(t); const outside = join(root, "outside"); await mkdir(outside);
    await writeFile(join(outside, "marker.ts"), "export const marker='OUTSIDE_GLOB_MARKER';");
    const { copy, entry } = await compilerFixture(root, `const name = 'marker'; export const result = ${operation}('../../../outside/' + name + '.ts');`);
    await assert.rejects(bundleRepairEntries(copy, [entry]), /sandbox_nonliteral_module_request/u);
    assert.equal((await readdir(join(copy, "tests/source-repair-target"))).filter((name) => name.endsWith(".mjs")).length, 0);
  });
}

test("compiler admits literal dynamic imports and literal requires inside the snapshot", async (t) => {
  const root = await fixture(t); const { copy, entry } = await compilerFixture(root, "export const result = () => import(`./safe.ts`); export const other = () => require('./safe.ts');");
  await writeFile(join(copy, "tests/source-repair-target/safe.ts"), "export const marker='CONTAINED_LITERAL_MARKER';");
  const outputs = await bundleRepairEntries(copy, [entry]); assert.equal(outputs.length, 1);
  assert.ok((await readFile(join(copy, outputs[0]!), "utf8")).includes("CONTAINED_LITERAL_MARKER"));
});

test("compiler rejects copied junction or symlink routes", async (t) => {
  const root = await fixture(t); const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "value.ts"), "export const value=1;");
  const { copy, entry } = await compilerFixture(root, "import '../../route/value';"); const route = join(copy, "route");
  await symlink(outside, route, process.platform === "win32" ? "junction" : "dir");
  try { await assert.rejects(bundleRepairEntries(copy, [entry]), /symlink/u); }
  finally { await unlink(route); }
});

test("compiler admits the exact published HTML worker and Node builtins", async (t) => {
  const root = await fixture(t); const { copy, entry } = await compilerFixture(root, "import {parseHTML} from 'linkedom/worker'; import assert from 'node:assert/strict'; export const result=()=>assert.ok(parseHTML('<p>fixture</p>').document);");
  const outputs = await bundleRepairEntries(copy, [entry]); assert.equal(outputs.length, 1);
  const code = await readFile(join(copy, outputs[0]!), "utf8"); assert.ok(code.includes("node:assert/strict")); assert.ok(!code.includes("from \"linkedom/worker\""));
});

test("namespace launch uses only the fixed scrubbed host environment and WSL paths", () => {
  const environment = scrubEnvironment("C:\\fixture\\temp"); assert.equal(environment.TEMP, "C:\\fixture\\temp");
  assert.equal(environment.PATHEXT, ".EXE");
  assert.equal(environment.SOURCE_REPAIR_MODEL, undefined); assert.equal(environment.API_KEY, undefined);
  assert.equal(windowsToWslPath("C:\\fixture\\copy"), "/mnt/c/fixture/copy"); assert.throws(() => windowsToWslPath("C:\\fixture\\..\\private"));
});

// Explicit acceptance only: ordinary test runs do not launch WSL or copy a toolchain.
const NATIVE = process.env.SOURCE_REPAIR_PUBLIC_NATIVE_ACCEPTANCE === "1" && process.platform === "win32";
const NATIVE_BASE = join(PROJECT, "work/rp");
const NATIVE_RECEIPTS = join(PROJECT, "work/source-repairs/acceptance/sandbox-public", `native-${randomUUID()}`);
async function fileHash(path: string): Promise<string> {
  const digest = createHash("sha256"); for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}
async function sourceHashes(): Promise<Record<string, string>> {
  const files: string[] = [];
  const walk = async (directory: string) => { for (const entry of await readdir(join(PROJECT, directory), { withFileTypes: true })) {
    const name = `${directory}/${entry.name}`; assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) await walk(name); else if (entry.isFile()) files.push(name);
  } };
  for (const directory of ["lib", "examples/source-repair", "tests/fixtures/source-repair"]) await walk(directory);
  files.push("tests/source-repair/sandbox.test.mts", "tests/source-repair/replay.test.mts", "scripts/runtime.ps1", "package.json");
  return Object.fromEntries(await Promise.all(files.sort().map(async (name) => [name, await fileHash(join(PROJECT, name))])));
}
async function nativeFixture(t: { after: (callback: () => Promise<void>) => void }): Promise<string> {
  await mkdir(NATIVE_BASE, { recursive: true }); const root = await mkdtemp(join(NATIVE_BASE, "f-"));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(NATIVE_BASE) + sep)); await rm(root, { recursive: true, force: true }); });
  const original = process.env.SOURCE_REPAIR_NATIVE_NODE; assert.ok(original, "An existing explicitly selected Linux Node binary is required.");
  assert.equal((await lstat(original)).isFile(), true); assert.equal(await fileHash(original), LINUX_NODE_HASH);
  const node = join(root, "work/source-repairs/toolchain/node-v24.18.0-linux-x64/bin/node"); await mkdir(dirname(node), { recursive: true }); await cp(original, node);
  assert.equal(await fileHash(node), LINUX_NODE_HASH); assert.equal(await fileHash(original), LINUX_NODE_HASH);
  return root;
}
async function boundedTargetFixture(root: string): Promise<RepairJob> {
  await cp(join(PROJECT, "lib"), join(root, "lib"), { recursive: true });
  const local = "source-adapters.local/bounded-json"; await mkdir(join(root, local), { recursive: true });
  for (const name of ["adapter.ts", "adapter.test.ts"]) await cp(join(PROJECT, "tests/fixtures/source-repair/bounded-json", `${name}.txt`), join(root, local, name));
  await cp(join(PROJECT, "examples/source-repair/fixture.json"), join(root, local, "fixture.json"));
  const target = await validateRepairTarget(root, { sourceId: "bounded_json", adapterPath: `${local}/adapter.ts`, testFiles: [`${local}/adapter.test.ts`], files: [`${local}/fixture.json`] });
  return { schemaVersion: REPAIR_SCHEMA, id: hash("bounded_native_fixture"), sourceId: target.sourceId, adapterPath: target.adapterPath,
    adapterHash: target.fileHashes[target.adapterPath]!, target, targetHash: target.targetHash, failureFingerprint: hash("bounded_fixture_failure"),
    diagnostic: { sourceId: target.sourceId, errorCode: "SourceAdapterError", message: "Bounded listing description must be a string.", observedAt: "2026-01-01T00:00:00.000Z", evidence: "source_run" },
    disposition: "parser_proposal", reason: "synthetic_independent_bounds", createdAt: "2026-01-01T00:00:00.000Z", state: "prepared" };
}
async function attachFixtureEvidence(root: string, job: RepairJob, bounded: boolean) {
  const sourceRunId = randomUUID();
  const capture = await captureSourceParserEvidence({ sourceId: job.sourceId, sourceRunId, observedAt: job.diagnostic.observedAt,
    diagnostic: { errorCode: job.diagnostic.errorCode, message: job.diagnostic.message }, operation: bounded ? "parse_page" : "plan_inventory",
    page: { url: "https://example.invalid/inventory.json", body: await readFile(join(PROJECT, "examples/source-repair/failing-page.json"), "utf8"), fetchedAt: job.diagnostic.observedAt, contentType: "application/json" },
    ...(bounded ? { expectedListings: 2, plannedPage: { key: "independent-two-member-page", request: { kind: "api", url: "https://example.invalid/inventory.json" }, minimumListings: 2, maximumListings: 2, inventoryMember: true, reviewCandidate: true } } : {}) });
  if (!capture.available) throw new Error(capture.reason);
  const blob = Buffer.from(capture.serializedPacket); const r2 = join(root, ".wrangler/state/v3/r2");
  const metadata = join(r2, "miniflare-R2BucketObject", `${"a".repeat(64)}.sqlite`); const blobId = "b".repeat(80);
  await mkdir(dirname(metadata), { recursive: true }); await mkdir(join(r2, "fixture-bucket/blobs"), { recursive: true });
  await writeFile(join(r2, "fixture-bucket/blobs", blobId), blob, { flag: "wx" });
  const db = new DatabaseSync(metadata);
  try {
    db.exec("CREATE TABLE _mf_objects (key TEXT,blob_id TEXT,version TEXT,size INTEGER,etag TEXT,uploaded INTEGER,checksums TEXT,http_metadata TEXT,custom_metadata TEXT)");
    db.prepare("INSERT INTO _mf_objects VALUES (?,?,?,?,?,?,?,?,?)").run(capture.key, blobId, "c".repeat(32), blob.length, createHash("md5").update(blob).digest("hex"), 1,
      JSON.stringify({ sha256: hash(blob) }), JSON.stringify({ contentType: "application/json" }), "{}");
  } finally { db.close(); }
  job.sourceRunId = sourceRunId; job.evidenceKey = capture.key; job.evidenceHash = hash(blob);
  return capture;
}
async function saveNativeReceipt(name: string, value: unknown): Promise<string> {
  await mkdir(NATIVE_RECEIPTS, { recursive: true }); const path = join(NATIVE_RECEIPTS, `${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); return path;
}

test("native scrubbed Windows host resolves only the intended Node without private settings", { skip: !NATIVE }, async (t) => {
  const root = await nativeFixture(t);
  const receipt = await runBoundedProcess(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", "@{ node=(Get-Command node -ErrorAction Stop).Source; privateSettingsAbsent=([string]::IsNullOrEmpty($env:API_KEY) -and [string]::IsNullOrEmpty($env:SOURCE_REPAIR_MODEL)); extensions=$env:PATHEXT } | ConvertTo-Json -Compress"],
    { cwd: root, env: scrubEnvironment(root), timeoutMs: 15_000, maximumBytes: 2_000 });
  const path = await saveNativeReceipt("windows-environment", { checkedAt: new Date().toISOString(), sourceRequests: 0, modelRequests: 0, productionWrites: 0, receipt });
  t.diagnostic(`Native receipt: ${path}`); assert.equal(receipt.exitCode, 0); const result = JSON.parse(receipt.stdout);
  assert.equal(result.node.toLowerCase(), process.execPath.toLowerCase()); assert.equal(result.privateSettingsAbsent, true);
  // Windows PowerShell may append its intrinsic .CPL extension after startup.
  assert.ok([".EXE", ".EXE;.CPL"].includes(result.extensions)); assert.equal(scrubEnvironment(root).PATHEXT, ".EXE");
});

for (const bounded of [false, true]) {
  test(`native proposal replay ${bounded ? "proves independent captured bounds" : "retains the generic count limitation"}`, { skip: !NATIVE }, async (t) => {
    const before = await sourceHashes(); const root = await nativeFixture(t);
    const job = bounded ? await boundedTargetFixture(root) : await targetFixture(root); job.capability = REPAIR_CAPABILITY;
    const evidence = await attachFixtureEvidence(root, job, bounded); const base = await readFile(join(root, job.adapterPath), "utf8");
    const raw = JSON.stringify({ schemaVersion: REPAIR_SCHEMA, sourceId: job.sourceId, adapterPath: job.adapterPath, baseHash: job.adapterHash,
      edits: [{ before: "listing.description", after: 'listing.description === null ? "" : listing.description' }], explanation: "Manually authored synthetic null-only fixture proposal." });
    const proposal = validateProposal(raw, job, base); const receipt = await validateIsolatedProposal(root, job, proposal.candidate);
    const after = await sourceHashes();
    const path = await saveNativeReceipt(bounded ? "bounded" : "limited", { checkedAt: new Date().toISOString(), fixtureRoot: root,
      synthetic: true, modelGenerated: false, sourceRequests: 0, modelRequests: 0, productionWrites: 0,
      evidenceStore: "disposable handcrafted Miniflare R2 metadata; actual read-only loader", pinnedNodeHash: LINUX_NODE_HASH,
      inputsBefore: before, inputsAfter: after, job, base, proposal: proposal.proposal, candidate: proposal.candidate, evidence: evidence.packet, receipt });
    t.diagnostic(`Native receipt: ${path}`); assert.deepEqual(after, before);
    assert.equal(receipt.status, bounded ? "replay_and_fixtures_passed" : "replay_limited", receipt.reason);
    assert.equal(receipt.liveFailureReproduced, true); assert.equal(receipt.baseline!.exitCode, 0); assert.equal(receipt.candidate!.exitCode, 0);
    const containment = JSON.parse(receipt.containment!.stdout); assert.equal(containment.networkControl, true); assert.equal(containment.acceptedConnections, 0);
    const replay = JSON.parse(receipt.replayCandidate!.stdout); assert.equal(replay.listingCount, 2); assert.equal(replay.countContext, bounded ? "bounded" : "limited");
  });
}

test("native timeout and cancellation remove exactly their owned Linux descendants", { skip: !NATIVE }, async (t) => {
  const before = await sourceHashes(); const root = await nativeFixture(t); const job = await targetFixture(root);
  const sandbox = await createLinuxSandbox(root, job);
  await writeFile(join(sandbox.copy, "lifetime-fixture.mjs"), "console.log('namespace fixture ready'); setInterval(() => {}, 1000);\n", { flag: "wx" });
  const outcomes = [];
  for (const mode of ["timeout", "cancellation"] as const) {
    const control = new AbortController(); let output = "";
    const receipt = await runLinuxSandbox(sandbox, "lifetime_fixture", { timeoutMs: mode === "timeout" ? 7_000 : 15_000, signal: control.signal,
      onStdout: (chunk) => { output += chunk; if (mode === "cancellation" && output.includes("namespace fixture ready") && output.includes("ownedNamespacePids")) control.abort(); } });
    const frames = receipt.stdout.trim().split(/\r?\n/u).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { ownedHostPid?: number; ownedSandboxPid?: number; ownedNamespacePids?: number[] });
    const pids = [...new Set(frames.flatMap((frame) => [frame.ownedHostPid, frame.ownedSandboxPid, ...(frame.ownedNamespacePids ?? [])]).filter((pid): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0))];
    assert.ok(pids.length >= 3); assert.equal(receipt.timedOut, true); assert.ok(receipt.stdout.includes("namespace fixture ready"));
    const probe = await runBoundedProcess(join(process.env.SystemRoot ?? "C:\\Windows", "System32/wsl.exe"),
      ["-d", "Ubuntu", "--", `${windowsToWslPath(sandbox.nodeTree)}/bin/node`, "-e", `const fs=require('node:fs'); const pids=${JSON.stringify(pids)}; console.log(JSON.stringify(pids.map(pid=>({pid,exists:fs.existsSync('/proc/'+pid)}))));`],
      { cwd: sandbox.copy, env: scrubEnvironment(sandbox.temporary), timeoutMs: 15_000, maximumBytes: 2_000 });
    outcomes.push({ mode, receipt, ownedPids: pids, probe });
    await saveNativeReceipt(`teardown-${mode}`, { synthetic: true, sourceRequests: 0, modelRequests: 0, productionWrites: 0, pinnedNodeHash: LINUX_NODE_HASH, ...outcomes.at(-1)! });
    assert.equal(probe.exitCode, 0); assert.equal(probe.timedOut, false);
    assert.ok((JSON.parse(probe.stdout) as Array<{ exists: boolean }>).every(({ exists }) => !exists));
  }
  const after = await sourceHashes(); const path = await saveNativeReceipt("teardown", { checkedAt: new Date().toISOString(), fixtureRoot: root, outcomes, inputsBefore: before, inputsAfter: after });
  t.diagnostic(`Native receipt: ${path}`); assert.deepEqual(after, before);
});
