import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const parent = resolve(root, ".wrangler", "public-runtime-tests");
const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
const revision = `sha256:${"a".repeat(64)}`;

test("Windows PowerShell nightly wrapper completes empty and enabled-subset campaigns and rejects unexpected scoring work", { skip: process.platform !== "win32", timeout: 30_000 }, async () => {
  for (const { registeredIds, unexpectedScoring } of [
    { registeredIds: [], unexpectedScoring: false },
    { registeredIds: ["fixture_disabled", "fixture_enabled"], unexpectedScoring: false },
    { registeredIds: [], unexpectedScoring: true },
  ]) {
    mkdirSync(parent, { recursive: true });
    const directory = mkdtempSync(resolve(parent, "nightly wrapper-"));
    const modules = resolve(directory, "node_modules");
    mkdirSync(resolve(directory, "scripts"));
    symlinkSync(resolve(root, "node_modules"), modules, "junction");
    try {
      for (const name of ["runtime.ps1", "node-runtime-preload.mjs"]) {
        copyFileSync(resolve(root, "scripts", name), resolve(directory, "scripts", name));
      }
      // Only supervisor readiness and child scheduler output are fixture seams.
      // The production wrapper, child launch, JSON parsing, terminal validation,
      // status publication and workflow lock run under Windows PowerShell 5.1.
      const wrapper = readFileSync(resolve(root, "scripts/nightly.ps1"), "utf8");
      const mainBoundary = "\nif (-not $HealthCheckOnly) {";
      assert.equal(wrapper.split(mainBoundary).length, 2);
      writeFileSync(resolve(directory, "scripts/nightly.ps1"), wrapper.replace(mainBoundary, `
function Test-CurrentSupervisedRuntimeReady { return $true }
function Get-ExistingRuntimeObservation { return [pscustomobject]@{ AnyObserved = $false } }
function Assert-LoadedRuntimeRevision {}
${mainBoundary}`));
      writeFileSync(resolve(directory, "scripts/source-order.mts"), `process.stdout.write(${JSON.stringify(JSON.stringify(registeredIds) + "\n")});`);
      const sourceOutcomes = registeredIds.length === 0 ? [] : [{
        sourceId: "fixture_enabled", outcome: "refreshed", dependencySatisfied: true,
        reasonCode: "fresh_publication_verified", priorHead: null,
        resultingHead: { inventoryRunId: "fixture-publication", listingCount: 1 },
        nextEligibleAt: null, proofIdentity: "fixture-proof", receiptIdentity: "fixture-receipt",
      }];
      const classification = unexpectedScoring ? "core_complete_maintenance_deferred" : "clean_empty";
      const summary = {
        schemaVersion: "auction-discovery-nightly-scheduler-cli-v1", classification,
        readiness: { ready: true, selectedMode: "optimized", missingSeams: [], sourceCount: sourceOutcomes.length },
        result: { classification, completed: sourceOutcomes.length, deterministicTerminals: 0,
          earliestAvailableAt: null, tailCandidateIds: [], tailReasonCodes: [], preparationProgressCandidateIds: [],
          proximityProgress: { queued: 0, claimed: 0, completed: 0, stale: 0, remaining: 0 },
          coreProgress: { ready: 0, deferred: 0, claimed: 0, remaining: 0 },
          maintenanceProgress: { ready: 0, deferred: unexpectedScoring ? 1 : 0, claimed: 0, remaining: unexpectedScoring ? 1 : 0 }, sourceOutcomes,
          ...(unexpectedScoring ? { preferenceV2Progress: {
            queueBefore: 1, selected: 0, completed: 0, reused: 0, newlyScored: 0, stale: 0, queueAfter: 1, remaining: 1,
            lastProgressAt: null, elapsedMs: 0, throughputRowsPerSecond: null, estimatedRemainingMs: null, stopReason: "quantum",
          } } : {}) },
      };
      writeFileSync(resolve(directory, "scripts/nightly-scheduler.mts"), `const summary = ${JSON.stringify(summary)};
const deadline = process.argv[process.argv.indexOf('--workflow-deadline-at') + 1];
process.stdout.write(JSON.stringify({ ...summary, workflowDeadlineAt: deadline }) + '\\n');`);
      const execution = promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", resolve(directory, "scripts/nightly.ps1"), "-RequireExistingRuntime", "-ExpectedRuntimeRevision", revision],
      { cwd: directory, windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
      if (unexpectedScoring) {
        await assert.rejects(execution, /Unexpected preference scoring work is unavailable/);
        const failedStatus = JSON.parse(readFileSync(resolve(directory, ".wrangler/logs/nightly-status.json"), "utf8"));
        assert.equal(failedStatus.state, "failed");
        assert.equal(failedStatus.workflowState, "failed");
        continue;
      }
      const output = await execution;
      const status = JSON.parse(readFileSync(resolve(directory, ".wrangler/logs/nightly-status.json"), "utf8"));
      assert.equal(status.state, "completed", JSON.stringify({ status, stdout: output.stdout }));
      assert.equal(status.workflowState, "completed");
      assert.equal(status.campaignSourcesTotal, sourceOutcomes.length);
      assert.equal(status.campaignSourcesCompleted, sourceOutcomes.length);
      assert.deepEqual(status.sourceOutcomes, sourceOutcomes);
    } finally {
      assert.ok(resolve(directory).startsWith(`${parent}${sep}`));
      unlinkSync(modules);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
