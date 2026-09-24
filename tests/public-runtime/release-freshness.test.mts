import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SchedulerCandidate, SchedulerProgressEvent, SchedulerRunResult } from "../../lib/scheduler/types.ts";
import type { NightlySchedulerRequest } from "../../scripts/nightly-scheduler.mts";

const sourceId = "public_freshness_fixture";
const emptyRegistry = process.env.PUBLIC_RELEASE_FRESHNESS_EMPTY === "1";
const fixture = `import { createJsonApiSource } from ${JSON.stringify(new URL("../../lib/sources/json-api.ts", import.meta.url).href)};
export default [{ enabled: true, adapter: createJsonApiSource({ id: ${JSON.stringify(sourceId)}, displayName: 'Public fixture',
baseUrl: 'https://fixture.invalid', inventoryUrl: 'https://fixture.invalid/inventory',
access: {permissionBasis:'recorded_permission',permissionReference:'test-only',permissionRecordedAt:'2026-01-01T00:00:00Z',reviewedAt:'2026-01-01T00:00:00Z',termsUrl:null,robotsUrl:null,documentationUrls:[],note:'Synthetic fixture; no source requests.'},
requests:{minDelayMs:1,maxRequestsPerRun:1,maxResponseBytes:10000,timeoutMs:1000,maxRetries:0},
itemsPath:['items'],totalPath:['total'],inlineDetails:true,mapListing:()=>{throw new Error('No source acquisition in this test');}
}) }];`;
const fixtureUrl = `data:text/javascript,${encodeURIComponent(emptyRegistry ? "export default [];" : fixture)}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) {
  if (/source-adapters\\.local(?:\\.ts)?$/.test(s)) return {shortCircuit:true,url:${JSON.stringify(fixtureUrl)}};
  return n(s,c);
}`)}`, import.meta.url);
const { createHttpSchedulerRuntimeAdapter, runNightlySchedulerCli, NIGHTLY_SCHEDULER_ADAPTER_PATH } = await import("../../scripts/nightly-scheduler.mts");
const { sourceOrchestrationRegistry } = await import("../../lib/sources/orchestration.ts");
const { NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER } = await import("../../lib/scheduler/runtime-authorization.ts");
const schemaVersion = "auction-discovery-nightly-scheduler-adapter-v1";
const revision = `sha256:${"c".repeat(64)}`;
const authorization = "a".repeat(64);
const now = new Date("2026-09-24T12:00:00.000Z");
const readiness = { ready: true, authorizationToken: authorization, capabilities: {
  exactQueueClaims: true, sourceAccessState: true, sourceAcquisitionReservations: true,
  acquiredBundleReceipts: true, singleWriterFinalize: true, outsideFifoFrontierAcquisition: true, atomicFrontierPublication: true,
} };
const response = (result: unknown) => ({ status: 200, body: { schemaVersion, result } });
const settled = { status: "settled", checkedSourceIds: [], queuedSourceIds: [] };

test("an empty public final boundary reconciles release freshness even without optional AI", async () => {
  for (const mode of ["full", "core"] as const) {
  let guards = 0;
  const run = await runNightlySchedulerCli(["--mode", "optimized", ...(mode === "core" ? ["--existing-catalog-only"] : []),
    "--runtime-revision", revision, "--workflow-deadline-at", "2099-01-01T00:00:00.000Z"], {
    now: () => now, environment: {},
    request: async request => {
      if (request.method === "GET") return { status: 200, body: { schemaVersion, ...readiness,
        generation: "empty", boundedReadCount: 1, candidates: [], remainingWork: {
          sourceAcquisitions: 0, preparationReady: 0, preparationDeferred: 0, preparationClaimed: 0,
          coreReady: 0, coreDeferred: 0, coreClaimed: 0, maintenanceReady: 0, maintenanceDeferred: 0, maintenanceClaimed: 0,
          returned: 0, truncated: 0,
        } } };
      if (request.body?.action === "transition_to_preparation") return response({ transitioned: true, sourceOutcomeCount: 0 });
      if (request.body?.action === "reconcile_release_freshness") {
        guards++;
        assert.deepEqual(Object.keys(request.body).sort(), ["action", "schemaVersion"]);
        assert.equal(request.headers?.[NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER], authorization);
        return response(settled);
      }
      assert.equal(request.body?.action, "record_execution_evidence");
      return response({ unifiedSourceScheduler: { receiptId: "test:source" }, preparationScheduler: { receiptId: "test:preparation" } });
    },
  });
  assert.equal((run.output as {classification: string}).classification, "clean_empty");
  assert.equal(guards, 1, "clean completion must reconcile release freshness");
  }
});

test("the same final guard supports a genuinely empty configured registry", { skip: emptyRegistry }, () => {
  const childEnvironment: NodeJS.ProcessEnv = { ...process.env, PUBLIC_RELEASE_FRESHNESS_EMPTY: "1" };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["--import", "./scripts/node-runtime-preload.mjs", "--import", "tsx", "--test",
    "--test-name-pattern", "an empty public final boundary|retained persisted source|retained source_release", fileURLToPath(import.meta.url)], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8", timeout: 20_000, windowsHide: true,
    env: childEnvironment,
  });
  assert.match(output, /pass 3/u);
});

test("retained persisted source IDs remain valid after adapters are removed", async () => {
  let result: unknown = settled;
  const adapter = createHttpSchedulerRuntimeAdapter({ baseUrl: "http://localhost:3000", maxDispatches: 1,
    includeSourceAcquisitions: false, initialPreparationScope: "core",
    request: async request => request.method === "GET"
      ? { status: 200, body: { schemaVersion, ...readiness, generation: "retained", boundedReadCount: 1, candidates: [] } }
      : response(result),
  });
  await adapter.readSnapshot();
  const retained = ["removed_adapter", "old-source_2"];
  for (const status of ["settled", "queued", "upstream_work_pending"] as const) {
    result = { status, checkedSourceIds: retained, queuedSourceIds: status === "settled" ? [] : [retained[0]] };
    assert.deepEqual(await adapter.reconcileReleaseFreshness(), result);
  }
  result = { status: "settled", checkedSourceIds: Array.from({length: 32}, (_v, i) => `retained_${i}`), queuedSourceIds: [] };
  assert.deepEqual(await adapter.reconcileReleaseFreshness(), result);
  for (const checkedSourceIds of [[""], ["Uppercase"], ["1starts_numeric"], ["source/path"], ["a".repeat(65)],
    ["duplicate", "duplicate"], Array.from({length: 33}, (_v, i) => `retained_${i}`)]) {
    result = { status: "settled", checkedSourceIds, queuedSourceIds: [] };
    await assert.rejects(adapter.reconcileReleaseFreshness(), /release freshness response was invalid/u);
  }
  for (const queuedSourceIds of [["not_checked"], ["removed_adapter", "removed_adapter"]]) {
    result = { status: "upstream_work_pending", checkedSourceIds: retained, queuedSourceIds };
    await assert.rejects(adapter.reconcileReleaseFreshness(), /release freshness response was invalid/u);
  }
});

test("production adapter rejects release reconciliation under source-enabled authorization", async () => {
  let posts = 0;
  const adapter = createHttpSchedulerRuntimeAdapter({ baseUrl: "http://localhost:3000", maxDispatches: 1,
    request: async request => {
      if (request.method === "POST") posts++;
      return { status: 200, body: { schemaVersion, ...readiness, generation: "ready", boundedReadCount: 1, candidates: [] } };
    } });
  await adapter.readSnapshot();
  await assert.rejects(adapter.reconcileReleaseFreshness(), /source-disabled preparation authorization/u);
  assert.equal(posts, 0);
});

type Stage = "source_release" | "projection_global_refresh";
async function runCase(input: {
  mode: "full" | "core" | "maintenance";
  stages?: Stage[];
  guard: (call: number, enqueue: (stage: Stage) => void) => unknown;
  clock?: () => Date;
  deadline?: string;
  retainedRelease?: boolean;
  unconfiguredAcquisition?: boolean;
}) {
  const policy = sourceOrchestrationRegistry[0]!;
  if (!input.retainedRelease) assert.equal(policy.sourceId, sourceId);
  const pending: SchedulerCandidate[] = [], progress: SchedulerProgressEvent[] = [];
  let sequence = 0, guards = 0, commits = 0, preparation = input.mode !== "full";
  const selectedStages: string[] = [];
  function candidate(kind: "source_acquisition" | "preparation", stage: SchedulerCandidate["stage"]): SchedulerCandidate {
    const id = `${kind}:${stage}:${++sequence}`;
    const value: SchedulerCandidate = { id, kind, sourceId, stage, networkLanes: ["fixture-lane"], dependencies: [], terminalDependencies: [],
      dependencyDepth: 0, priority: 0, fairnessQuantum: 1, skippedRounds: 0, enqueueOrder: sequence,
      availableAt: now.toISOString(), accessState: "ready", accessReasonCode: null, nextEligibleAt: null,
      leaseExpiresAt: null, inputAttemptCount: 0, sourcePolicy: policy,
      timing: { remainingRequests: 1, remainingPages: 1, pacingFloorMs: 0, requestEwmaMs: 1, parseEwmaMs: 1, callbackEwmaMs: 1, commitEwmaMs: 1 },
      ...(kind === "source_acquisition" ? { sourceInput: { campaignId: "test", coverageMode: "complete_current" as const,
        adapterVersion: "fixture-v1", proofVersion: "fixture-v1", expectedGeneration: 1, inputHash: `sha256:${"a".repeat(64)}`, inputRevision: 1 } } : {}),
    };
    if (input.retainedRelease && stage === "source_release") {
      return { ...value, sourceId: "scheduler_local", networkLanes: [], sourcePolicy: undefined,
        workItem: { stage, subjectType: "source", subjectId: "removed_adapter", listingId: null, sourceId: "removed_adapter",
          subjectPayload: null, laneKey: "source-release:removed_adapter", inputHash: `sha256:${"e".repeat(64)}`, revision: 1,
          priority: 0, reasonCode: "release_freshness_changed", availableAt: now.toISOString(), inputAttemptCount: 0, lifetimeAttemptCount: 0,
          leaseOwner: null, leaseExpiresAt: null, claimedInputHash: null, claimedRevision: null,
          progress: { cursor: null, generation: null, rows: 0 }, lastErrorCode: null, lastErrorFingerprint: null,
          createdAt: now.toISOString(), updatedAt: now.toISOString(), lastClaimedAt: null, lastCompletedAt: null } };
    }
    return value;
  }
  const source = { ...candidate("source_acquisition", "source_acquisition"),
    ...(input.unconfiguredAcquisition ? { sourceId: "removed_adapter" } : {}),
    accessState: "manual_reset_required", accessReasonCode: "synthetic_stop" };
  const enqueue = (stage: Stage) => { pending.push(candidate("preparation", stage)); };
  input.stages?.forEach(enqueue);
  const run = await runNightlySchedulerCli(["--mode", "optimized", "--runtime-revision", revision,
    "--workflow-deadline-at", input.deadline ?? "2099-01-01T00:00:00.000Z",
    ...(input.mode === "full" ? [] : ["--existing-catalog-only"]),
    ...(input.mode === "maintenance" ? ["--existing-catalog-maintenance-only"] : []),
  ], {
    now: input.clock ?? (() => now), sleep: async () => {}, environment: {}, progressSink: event => progress.push(event),
    request: async request => {
      assert.equal(new URL(request.url).pathname, NIGHTLY_SCHEDULER_ADAPTER_PATH, "no source or optional-model callback");
      if (request.method === "GET") {
        const url = new URL(request.url), scope = url.searchParams.get("preparationScope");
        assert.equal(url.searchParams.get("includeSourceAcquisitions"), String(!preparation));
        const core = pending.filter(c => c.stage === "projection_global_refresh"), maintenance = pending.filter(c => c.stage === "source_release");
        const candidates = !preparation ? [source] : scope === "core" ? core : scope === "maintenance" ? maintenance : pending;
        return { status: 200, body: { schemaVersion, ...readiness, generation: `test:${sequence}:${commits}`, boundedReadCount: 1, candidates,
          remainingWork: { sourceAcquisitions: preparation ? 0 : 1,
            preparationReady: pending.length, preparationDeferred: 0, preparationClaimed: 0,
            coreReady: core.length, coreDeferred: 0, coreClaimed: 0,
            maintenanceReady: maintenance.length, maintenanceDeferred: 0, maintenanceClaimed: 0,
            returned: candidates.length, truncated: 0 },
        } };
      }
      const action = request.body?.action;
      if (action === "transition_to_preparation") { preparation = true; return response({ transitioned: true, sourceOutcomeCount: 1 }); }
      if (action === "reconcile_release_freshness") {
        assert.equal(preparation, true);
        assert.deepEqual(Object.keys(request.body!).sort(), ["action", "schemaVersion"]);
        assert.equal(request.headers?.[NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER], authorization);
        const result = input.guard(++guards, enqueue);
        if (result instanceof Error) throw result;
        return response(result);
      }
      if (action === "record_execution_evidence") return response({ unifiedSourceScheduler: { receiptId: "test:source" }, preparationScheduler: { receiptId: "test:preparation" } });
      const selected = request.body?.candidate as SchedulerCandidate;
      assert.equal(selected.kind, "preparation");
      const reservation = { reservationId: `reservation:${selected.id}`, candidateId: selected.id, sourceId: selected.sourceId,
        laneKey: selected.workItem?.laneKey ?? selected.networkLanes[0], inputRevision: 1, expiresAt: new Date(now.getTime() + 60_000).toISOString(), acquisitionClaim: null,
        queueClaim: { stage: selected.stage, subjectType: "source", subjectId: selected.workItem?.subjectId ?? sourceId, owner: `owner:${selected.id}`, inputHash: `sha256:${"e".repeat(64)}`, revision: 1 } };
      if (action === "reserve") return response(reservation);
      if (action === "acquire") return response({ kind: "local_commit" });
      if (action === "validate") return response({ reservationId: reservation.reservationId, bundleIdentity: selected.id,
        responseHash: `response:${selected.id}`, contentHash: `content:${selected.id}`, validated: true, acquiredBundle: null, callback: { kind: "local_commit" } });
      assert.equal(action, "commit");
      pending.splice(pending.findIndex(c => c.id === selected.id), 1); commits++; selectedStages.push(selected.stage);
      return response({ kind: "outcome", outcome: { classification: "completed", madeProgress: true, remaining: false } });
    },
  });
  return { ...run, output: run.output as { classification: string; result: SchedulerRunResult }, guards, commits, pending, progress, selectedStages };
}
const queued = { status: "queued", checkedSourceIds: [sourceId], queuedSourceIds: [sourceId] };
const upstream = { status: "upstream_work_pending", checkedSourceIds: [], queuedSourceIds: [] };

test("retained source_release drains through the local candidate and its durable source work item", async () => {
  const run = await runCase({ mode: "maintenance", retainedRelease: true, guard: (call, enqueue) => {
    if (call === 1) { enqueue("source_release"); return { status: "queued", checkedSourceIds: ["removed_adapter"], queuedSourceIds: ["removed_adapter"] }; }
    return { status: "settled", checkedSourceIds: ["removed_adapter"], queuedSourceIds: [] };
  } });
  assert.equal(run.output.classification, "clean_empty"); assert.equal(run.commits, 1); assert.equal(run.guards, 2);
  assert.equal(run.output.result.sourceRequests, 0); assert.deepEqual(run.selectedStages, ["source_release"]);
});

test("retained freshness IDs do not admit an unconfigured source-acquisition candidate", { skip: emptyRegistry }, async () => {
  const run = await runCase({ mode: "full", unconfiguredAcquisition: true, guard: () => assert.fail("invalid source snapshot") });
  assert.equal(run.output.classification, "handler_failure_prior_head_preserved");
  assert.equal(run.guards, 0); assert.equal(run.commits, 0);
});

test("configured source releases defer in core-only scope and drain before full or maintenance-only completion", { skip: emptyRegistry }, async () => {
  for (const mode of ["full", "core", "maintenance"] as const) {
    const run = await runCase({ mode, guard: (call, enqueue) => {
      if (call === 1) { enqueue("source_release"); return queued; } return settled;
    } });
    assert.equal(run.output.classification, mode === "core" ? "core_complete_maintenance_deferred" : mode === "full" ? "deterministic_terminal" : "clean_empty");
    assert.equal(run.guards, mode === "core" ? 1 : 2); assert.equal(run.commits, mode === "core" ? 0 : 1);
    assert.equal(run.output.result.sourceRequests, 0);
    assert.equal(run.output.result.sourceOutcomes.length, mode === "full" ? 1 : 0);
  }
});

test("maintenance invocation budget survives release freshness and nonterminal quanta never reconcile", { skip: emptyRegistry }, async () => {
  const run = await runCase({ mode: "maintenance", guard: (_call, enqueue) => { enqueue("source_release"); return queued; } });
  assert.equal(run.output.classification, "bounded_quantum_exhausted"); assert.equal(run.commits, 1); assert.equal(run.guards, 2);
  const nonterminal = await runCase({ mode: "maintenance", stages: ["source_release", "source_release"], guard: () => assert.fail("not a final boundary") });
  assert.equal(nonterminal.guards, 0); assert.equal(nonterminal.commits, 1);
});

test("a late upstream race preserves already queued releases and preempts them with new core work", { skip: emptyRegistry }, async () => {
  const run = await runCase({ mode: "full", guard: (call, enqueue) => {
    if (call === 1) { enqueue("source_release"); enqueue("projection_global_refresh"); return { ...queued, status: "upstream_work_pending" }; }
    return settled;
  } });
  assert.equal(run.output.classification, "deterministic_terminal"); assert.equal(run.guards, 2);
  assert.deepEqual(run.selectedStages, ["projection_global_refresh", "source_release"]);
  const maintenance = await runCase({ mode: "maintenance", guard: (_call, enqueue) => { enqueue("projection_global_refresh"); return upstream; } });
  assert.equal(maintenance.output.classification, "no_progress"); assert.equal(maintenance.commits, 0);
});

test("guard failures, malformed IDs and persistent races cannot emit clean terminal progress", { skip: emptyRegistry }, async () => {
  for (const result of [new Error("fixture transport failure"), { ...settled, status: "unknown" },
    { ...queued, checkedSourceIds: [] }, { ...queued, checkedSourceIds: ["invalid/source"], queuedSourceIds: ["invalid/source"] }]) {
    const run = await runCase({ mode: "core", guard: () => result });
    assert.equal(run.output.classification, "handler_failure_prior_head_preserved");
    assert.equal(run.progress.some(event => event.phase === "terminal" && event.message.includes("clean_empty")), false);
    assert.ok(run.output.result.tailReasonCodes.some(code => code.startsWith("source_release_freshness_failed:")));
  }
  const race = await runCase({ mode: "core", guard: () => upstream });
  assert.equal(race.output.classification, "no_progress"); assert.equal(race.guards, 2);
});

test("one absolute deadline bounds release reconciliation before and after its POST", { skip: emptyRegistry }, async () => {
  const before = await runCase({ mode: "core", deadline: new Date(now.getTime() + 4 * 60_000).toISOString(), guard: () => assert.fail("reserve exhausted") });
  assert.equal(before.output.classification, "checkpoint_paused"); assert.equal(before.guards, 0);
  let clock = now;
  const after = await runCase({ mode: "core", deadline: new Date(now.getTime() + 36 * 60_000).toISOString(), clock: () => clock,
    guard: () => { clock = new Date(now.getTime() + 37 * 60_000); return settled; } });
  assert.equal(after.output.classification, "checkpoint_paused"); assert.equal(after.guards, 1);
  assert.equal(after.progress.some(event => event.phase === "terminal" && event.message.includes("clean_empty")), false);
});
