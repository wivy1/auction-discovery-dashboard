import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseLatestSourceDiscoveryReceipt, readLatestSourceDiscoveryReceipt, readTerminalNightlyManifest } from "../../scripts/nightly-visible-control.ts";
import { emptyDashboard, parseLocalLatestSourceDiscovery, type LocalNightlyRunStatus, type LocalNightlySourceOutcome } from "../../app/components/auction-data.ts";
import { DiscoveryStatus, LatestSourceDiscoveryPanel } from "../../app/components/auction-dashboard.tsx";

const root = fileURLToPath(new URL("../../", import.meta.url));
const area = resolve(root, ".wrangler", "public-runtime-tests");
const revision = `sha256:${"a".repeat(64)}`;
const counts = (outcomes: readonly LocalNightlySourceOutcome[]) => Object.fromEntries(
  ["refreshed", "skipped_recent", "preserved", "paused", "stopped", "blocked"].map((name) => [name, outcomes.filter(({ outcome }) => outcome === name).length]),
);
const outcome = (sourceId = "removed_example"): LocalNightlySourceOutcome => ({
  sourceId, outcome: "paused", dependencySatisfied: false, reasonCode: "rate_limited",
  priorHead: { inventoryRunId: "prior-example-head", listingCount: 7 }, resultingHead: null,
  nextEligibleAt: "2026-01-02T01:00:00.000Z", proofIdentity: null, receiptIdentity: null,
});
function receipt(outcomes: readonly LocalNightlySourceOutcome[] = [outcome()]) {
  return { schemaVersion: "auction-discovery-source-discovery-v1", startedAt: "2026-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:01:00.000Z", runtimeRevision: revision,
    sourceCount: outcomes.length, sourceIds: outcomes.map(({ sourceId }) => sourceId), sourceOutcomes: outcomes, sourceOutcomeCounts: counts(outcomes) };
}

test("historical source receipts validate their sealed source set independently of the current empty registry", () => {
  for (const value of [receipt(), receipt([]), receipt([outcome("configured_later"), outcome("removed_example")])]) {
    assert.deepEqual(parseLatestSourceDiscoveryReceipt(value), value);
    assert.deepEqual(parseLocalLatestSourceDiscovery(value), value);
  }
  const value = receipt([outcome("example_one"), outcome("example_two")]);
  const tooLarge = receipt(Array.from({ length: 400 }, (_, index) => outcome(`example_${index}`)));
  for (const invalid of [
    { ...value, extra: true }, { ...value, schemaVersion: "other" }, { ...value, sourceCount: 1 },
    { ...value, sourceIds: [...value.sourceIds].reverse() },
    { ...value, sourceOutcomes: [...value.sourceOutcomes].reverse() },
    receipt([outcome(), outcome()]), { ...value, sourceOutcomeCounts: { ...value.sourceOutcomeCounts, blocked: 1 } },
    { ...value, recordedAt: "2025-12-31T23:59:59.000Z" }, { ...value, recordedAt: "2026-02-30T00:00:00.000Z" },
    { ...value, startedAt: "2026-01-01T00:00:00Z" }, { ...value, runtimeRevision: "invalid" },
    { ...value, sourceOutcomes: [{ ...outcome(), reasonCode: "\u0000private" }, outcome("other")] }, tooLarge,
  ]) {
    assert.equal(parseLatestSourceDiscoveryReceipt(invalid), null, JSON.stringify(invalid).slice(0, 180));
    assert.equal(parseLocalLatestSourceDiscovery(invalid), null, JSON.stringify(invalid).slice(0, 180));
  }
});

test("retained source result renders with its own date after a source-disabled drain without asserting a workflow exit", () => {
  const value = parseLocalLatestSourceDiscovery(receipt())!;
  const status = { active: false, workflowStartedAt: "2026-01-02T00:00:00.000Z", sourceOutcomes: [], latestSourceDiscovery: value } as unknown as LocalNightlyRunStatus;
  const html = renderToStaticMarkup(createElement(LatestSourceDiscoveryPanel, { status }));
  assert.match(html, /Latest source discovery/);
  assert.match(html, /Recorded/);
  assert.match(html, /Source discovery needs attention/);
  assert.match(html, /Removed Example/);
  assert.match(html, /prior 7-listing catalog retained/);
  assert.doesNotMatch(html, /clean_empty|exit code|Jan 2, 2026, 12:00/u);
  assert.equal(renderToStaticMarkup(createElement(LatestSourceDiscoveryPanel, { status: { ...status, active: true } })), "");
  assert.equal(renderToStaticMarkup(createElement(LatestSourceDiscoveryPanel, { status: { ...status, workflowStartedAt: value.startedAt, sourceOutcomes: value.sourceOutcomes } })), "");
  const empty = renderToStaticMarkup(createElement(LatestSourceDiscoveryPanel, { status: { ...status, latestSourceDiscovery: parseLocalLatestSourceDiscovery(receipt([])) } }));
  assert.match(empty, /No enabled sources/);
  assert.match(empty, /No sources were enabled for this discovery/);
});

test("older retained attention never replaces a newer source success or failure headline", () => {
  const status = { active: false, state: "unavailable", stage: null, exitCode: null, workflowError: null, workflowEndedAt: null,
    sourceOutcomes: [], sourceOutcomeCounts: counts([]), latestSourceDiscovery: parseLocalLatestSourceDiscovery(receipt()) } as unknown as LocalNightlyRunStatus;
  const run = { ...emptyDashboard.run, latestDiscoveryStatus: "completed" as const,
    lastCompletedAt: "2026-01-03T00:00:00.000Z", lastSuccessfulCompletedAt: "2026-01-03T00:00:00.000Z" };
  const success = renderToStaticMarkup(createElement(DiscoveryStatus, { run, nightlyStatus: status, running: false, refreshRequired: false }));
  assert.match(success, /Completed/); assert.doesNotMatch(success, /Source discovery needs attention/);
  const failed = renderToStaticMarkup(createElement(DiscoveryStatus, { run: { ...run, latestDiscoveryStatus: "failed", state: "degraded", errorMessage: "Source stopped" }, nightlyStatus: status, running: false, refreshRequired: false }));
  assert.match(failed, /Last run failed/); assert.doesNotMatch(failed, /Source discovery needs attention/);
});

function summary(outcomes: readonly LocalNightlySourceOutcome[], sourceCount = outcomes.length) {
  return { schemaVersion: "auction-discovery-nightly-scheduler-cli-v1", classification: "clean_empty",
    readiness: { ready: true, selectedMode: "optimized", missingSeams: [], sourceCount },
    result: { classification: "clean_empty", completed: outcomes.length, deterministicTerminals: 0,
      earliestAvailableAt: null, tailCandidateIds: [], tailReasonCodes: [], preparationProgressCandidateIds: [],
      proximityProgress: { queued: 0, claimed: 0, completed: 0, stale: 0, remaining: 0 },
      coreProgress: { ready: 0, deferred: 0, claimed: 0, remaining: 0 },
      maintenanceProgress: { ready: 0, deferred: 0, claimed: 0, remaining: 0 }, sourceOutcomes: outcomes } };
}

test("native wrapper retains complete enabled-subset outcomes through ExistingCatalogOnly and adapter removal", { skip: process.platform !== "win32", timeout: 90_000 }, async () => {
  mkdirSync(area, { recursive: true });
  const directory = mkdtempSync(resolve(area, "source receipt-"));
  const modules = resolve(directory, "node_modules");
  mkdirSync(resolve(directory, "scripts"));
  try {
    symlinkSync(resolve(root, "node_modules"), modules, "junction");
    for (const name of ["runtime.ps1", "node-runtime-preload.mjs"]) copyFileSync(resolve(root, "scripts", name), resolve(directory, "scripts", name));
    const wrapper = readFileSync(resolve(root, "scripts/nightly.ps1"), "utf8");
    const boundary = "\nif (-not $HealthCheckOnly) {";
    assert.equal(wrapper.split(boundary).length, 2);
    writeFileSync(resolve(directory, "scripts/nightly.ps1"), wrapper.replace(boundary, `
function Test-CurrentSupervisedRuntimeReady { return $true }
function Get-ExistingRuntimeObservation { return [pscustomobject]@{ AnyObserved = $false } }
function Assert-LoadedRuntimeRevision {}
${boundary}`));
    writeFileSync(resolve(directory, "scripts/source-order.mts"), "import{readFileSync}from'node:fs';process.stdout.write(readFileSync(new URL('../registry.json',import.meta.url),'utf8')+'\\n');");
    writeFileSync(resolve(directory, "scripts/nightly-scheduler.mts"), `import{readFileSync}from'node:fs';
const summary=JSON.parse(readFileSync(new URL('../fixture-summary.json',import.meta.url),'utf8'));
const deadline=process.argv[process.argv.indexOf('--workflow-deadline-at')+1];
if(process.argv.includes('--existing-catalog-only'))summary.result.sourceOutcomes=[];
process.stdout.write(JSON.stringify({...summary,workflowDeadlineAt:deadline})+'\\n');`);
    const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const run = (existing = false) => spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve(directory, "scripts/nightly.ps1"), "-RequireExistingRuntime", "-ExpectedRuntimeRevision", revision, ...(existing ? ["-ExistingCatalogOnly"] : [])], {
      cwd: directory, encoding: "utf8", windowsHide: true, timeout: 20_000, maxBuffer: 1024 * 1024,
      env: { ...process.env, SOURCE_REPAIR_ENABLED: "0", AI_TEXT_PROVIDER: "", AI_TEXT_MODEL: "", AI_EMBEDDING_PROVIDER: "", AI_EMBEDDING_MODEL: "" },
    });
    const configure = (registered: readonly string[], outcomes: readonly LocalNightlySourceOutcome[], sourceCount = outcomes.length) => {
      writeFileSync(resolve(directory, "registry.json"), JSON.stringify(registered));
      writeFileSync(resolve(directory, "fixture-summary.json"), JSON.stringify(summary(outcomes, sourceCount)));
    };
    const receiptPath = resolve(directory, ".wrangler/logs/latest-source-discovery.json");
    configure(["fixture_disabled", "removed_example"], [outcome()]);
    const first = run(); assert.equal(first.status, 0, first.stderr);
    const original = readFileSync(receiptPath, "utf8");
    const saved = JSON.parse(original);
    assert.equal(saved.sourceCount, 1);
    assert.deepEqual(saved.sourceIds, ["removed_example"]);
    assert.deepEqual(saved.sourceOutcomes, [outcome()]);
    assert.ok(parseLatestSourceDiscoveryReceipt(saved));
    configure([], [], 0);
    const continuation = run(true); assert.equal(continuation.status, 0, continuation.stderr);
    assert.equal(readFileSync(receiptPath, "utf8"), original);
    const statusText = readFileSync(resolve(directory, ".wrangler/logs/nightly-status.json"), "utf8");
    const status = JSON.parse(statusText);
    assert.equal(status.state, "completed"); assert.deepEqual(status.sourceOutcomes, []);
    assert.deepEqual(await readLatestSourceDiscoveryReceipt(directory), saved);
    assert.equal(await readTerminalNightlyManifest(directory, statusText), null, "Historical source receipt cannot manufacture a runner manifest");
    for (const [registered, outcomes, count] of [
      [["removed_example"], [], 1],
      [["fixture_disabled", "removed_example"], [outcome(), outcome()], 2],
    ] as const) {
      configure(registered, outcomes, count);
      assert.notEqual(run().status, 0);
      assert.equal(readFileSync(receiptPath, "utf8"), original, "Malformed or incomplete vector must retain prior receipt");
    }
    configure([], [], 0);
    const empty = run(); assert.equal(empty.status, 0, empty.stderr);
    const emptyReceipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    assert.equal(emptyReceipt.sourceCount, 0); assert.deepEqual(emptyReceipt.sourceIds, []);
    assert.deepEqual(emptyReceipt.sourceOutcomes, []); assert.ok(parseLatestSourceDiscoveryReceipt(emptyReceipt));
    writeFileSync(receiptPath, "{".repeat(70_000));
    assert.equal(await readLatestSourceDiscoveryReceipt(directory), null);
  } finally {
    assert.ok(resolve(directory).startsWith(`${area}${sep}`));
    if (existsSync(modules)) unlinkSync(modules);
    rmSync(directory, { recursive: true, force: true });
  }
});
