import { env } from "cloudflare:workers";

import { ensureDatabase } from "../../../../db/bootstrap";
import { syncConfiguredSourceManifests } from "../../../../lib/settings/source-manifests";
import { sourceOrchestrationRegistry } from "../../../../lib/sources/orchestration";
import { HttpError, jsonError } from "../../../../lib/http";
import { readBoundedJson } from "../../../../lib/local-companion";
import { assertLoopbackRequest } from "../../../../lib/local-request";
import {
  loadedRuntimeRevision,
  RUNTIME_REVISION_HEADER,
  RUNTIME_REVISION_MISMATCH_MESSAGE,
} from "../../../../lib/runtime-revision";
import { readNightlyPerformanceFeatures } from "../../../../lib/performance/features";
import { hashCanonicalJson } from "../../../../lib/performance/generations";
import { reconcileCurrentOperationalProjectionContract } from
  "../../../../lib/pipeline/generation-reconcile";
import { appendSchedulerExecutionEvidence } from "../../../../lib/performance/runtime-execution-evidence";
import {
  createTransportPerformanceTelemetryBuffer,
  drainTransportPerformanceTelemetry,
  performanceTelemetryEventsRequested,
  recordObservedTransportDatabaseTelemetry,
} from "../../../../lib/performance/telemetry-transport";
import {
  NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION,
  parseExactTerminalSourceOutcomes,
  type SchedulerAdapterAction,
} from "../../../../lib/scheduler/runtime-adapter";
import {
  NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER,
  schedulerRuntimeAuthorizationRegistry,
  type SchedulerRuntimeAuthorizationBinding,
} from "../../../../lib/scheduler/runtime-authorization";
import {
  abortNightlySchedulerCallbackBeforeDispatch,
  abortNightlySchedulerReserveBeforeCallback,
  acquireNightlySchedulerCandidate,
  commitNightlySchedulerCandidate,
  readNightlySchedulerSnapshot,
  reconcileDetachedNightlySchedulerCallback,
  reserveNightlySchedulerCandidate,
  validateNightlySchedulerAcquisition,
} from "../../../../lib/scheduler/runtime-service";
import type {
  SchedulerAcquiredBundle,
  SchedulerCallbackReceipt,
  SchedulerCandidate,
  SchedulerExecutionEvidence,
  SchedulerReservation,
} from "../../../../lib/scheduler/types";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
type NightlySchedulerRouteAction = SchedulerAdapterAction;

const ACTIONS = new Set<NightlySchedulerRouteAction>([
  "reserve",
  "acquire",
  "validate",
  "commit",
  "abort_reserve_before_callback",
  "abort_before_callback",
  "reconcile_callback",
  "transition_to_preparation",
  "record_execution_evidence",
]);

interface AdapterPayload {
  readonly schemaVersion?: unknown;
  readonly action?: unknown;
  readonly candidate?: unknown;
  readonly reservation?: unknown;
  readonly acquired?: unknown;
  readonly bundle?: unknown;
  readonly receipt?: unknown;
  readonly executionEvidence?: unknown;
  readonly invocationIdentityHash?: unknown;
  readonly completedAt?: unknown;
  readonly callbackIdentity?: unknown;
  readonly transportFailureReasonCode?: unknown;
  readonly dispatchedAt?: unknown;
  readonly abortPhase?: unknown;
  readonly sourceOutcomes?: unknown;
}

export async function GET(request: Request) {
  try {
    const telemetry = createTransportPerformanceTelemetryBuffer(request);
    const telemetryStartedAt = performance.now();
    assertLoopbackRequest(request, "Nightly scheduler");
    assertRuntimeRevision(request);
    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (!new Set([
        "limit",
        "campaignId",
        "coverageMode",
        "includeSourceAcquisitions",
        "preparationScope",
      ]).has(key)) {
        throw invalidRequest(`unsupported snapshot parameter ${key}`);
      }
    }
    const limit = Number(requiredUniqueParameter(url, "limit"));
    const campaignId = requiredUniqueParameter(url, "campaignId");
    const coverageMode = requiredUniqueParameter(url, "coverageMode");
    if (
      coverageMode !== "complete_current" && coverageMode !== "auto"
    ) invalidCoverageMode();
    const includeSources = optionalUniqueParameter(url, "includeSourceAcquisitions") ?? "false";
    if (includeSources !== "true" && includeSources !== "false") {
      throw invalidRequest("includeSourceAcquisitions must be true or false");
    }
    const preparationScope = optionalUniqueParameter(url, "preparationScope") ?? "all";
    if (
      preparationScope !== "core" && preparationScope !== "maintenance" &&
      preparationScope !== "all"
    ) {
      throw invalidRequest("preparationScope must be core, maintenance, or all");
    }
    const authorizationBinding = Object.freeze({
      campaignId,
      coverageMode,
      includeSourceAcquisitions: includeSources === "true",
    } satisfies SchedulerRuntimeAuthorizationBinding);
    const suppliedAuthorization = request.headers.get(
      NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER,
    );
    const database = runtimeDatabase();
    await ensureDatabase(database);
    await syncConfiguredSourceManifests();
    let queueBackedProximityAuthorized = false;
    let enrichmentSessionResidencyAuthorized = false;
    if (suppliedAuthorization === null) {
      if (schedulerRuntimeAuthorizationRegistry.hasCampaign(campaignId)) {
        throw invalidAuthorization();
      }
      // This is an execution grant, not a claim that the queue is currently
      // parity-clean. Exact scheduler-owned proximity claims must remain on
      // the queue implementation even after this campaign legitimately
      // changes generations. The worker rechecks ownership, input hash, and
      // revision for every row and cannot fall back to the canonical selector.
      queueBackedProximityAuthorized =
        queueBackedProximityCampaignAuthorizationAvailable();
      enrichmentSessionResidencyAuthorized =
        enrichmentSessionResidencyCampaignAuthorizationAvailable();
    } else {
      assertSchedulerRuntimeModeAllowsContinuation();
      if (!schedulerRuntimeAuthorizationRegistry.authorize(
        suppliedAuthorization,
        authorizationBinding,
      )) throw invalidAuthorization();
    }
    const snapshot = await readNightlySchedulerSnapshot({
      database,
      limit,
      campaignId,
      coverageMode,
      includeSourceAcquisitions: includeSources === "true",
      preparationScope,
    });
    // This process-local grant cannot broaden from preparation back to sources.
    const optimizedFeatures = [
      ...(enrichmentSessionResidencyAuthorized
        ? ["enrichmentSessionResidency" as const]
        : []),
      ...(queueBackedProximityAuthorized
        ? ["queueBackedProximity" as const]
        : []),
    ];
    const authorizationToken = suppliedAuthorization ??
      schedulerRuntimeAuthorizationRegistry.issue(authorizationBinding, {
        optimizedFeatures,
      });
    telemetry.record({
      context: { campaignId },
      details: {
        kind: "stage",
        stage: "nightly_scheduler_snapshot",
        outcome: "completed",
        durationMs: performance.now() - telemetryStartedAt,
      },
    });
    if (performanceTelemetryEventsRequested(request)) {
      recordObservedTransportDatabaseTelemetry(
        telemetry,
        "nightly_scheduler_snapshot",
      );
    }
    return Response.json({
      schemaVersion: NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION,
      ready: true,
      capabilities: Object.freeze({
        exactQueueClaims: true,
        sourceAccessState: true,
        sourceAcquisitionReservations: true,
        acquiredBundleReceipts: true,
        singleWriterFinalize: true,
      }),
      authorizationToken,
      ...snapshot,
      performanceTelemetry: drainTransportPerformanceTelemetry(request, telemetry),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(normalizeValidationError(error));
  }
}

export async function POST(request: Request) {
  try {
    const telemetry = createTransportPerformanceTelemetryBuffer(request);
    const telemetryStartedAt = performance.now();
    assertLoopbackRequest(request, "Nightly scheduler");
    assertRuntimeRevision(request);
    const payload = await readBoundedJson<AdapterPayload>(request, MAX_BODY_BYTES);
    if (!isRecord(payload) || payload.schemaVersion !== NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION ||
        typeof payload.action !== "string" || !ACTIONS.has(payload.action as NightlySchedulerRouteAction)) {
      throw invalidRequest("the scheduler adapter action contract is invalid");
    }
    const allowed = actionAllowedKeys(payload.action as NightlySchedulerRouteAction);
    if (Object.keys(payload).some((key) => !allowed.has(key))) {
      throw invalidRequest("the scheduler adapter payload contains unsupported fields");
    }
    const action = payload.action as NightlySchedulerRouteAction;
    let result: unknown;
    const authorization = requireSchedulerRuntimeAuthorization(request);
    if (action === "record_execution_evidence") {
      if (
        !isRecord(payload.executionEvidence) ||
        typeof payload.invocationIdentityHash !== "string" ||
        typeof payload.completedAt !== "string"
      ) {
        throw invalidRequest("scheduler execution evidence is required");
      }
      if (
        payload.invocationIdentityHash !==
          await hashCanonicalJson(authorization.binding.campaignId)
      ) throw invalidAuthorization();
      const database = runtimeDatabase();
      await ensureDatabase(database);
      result = await appendSchedulerExecutionEvidence({
        database,
        evidence: payload.executionEvidence as unknown as SchedulerExecutionEvidence,
        invocationIdentityHash: payload.invocationIdentityHash,
        completedAt: payload.completedAt,
      });
      schedulerRuntimeAuthorizationRegistry.retire(authorization.token);
    } else if (action === "transition_to_preparation") {
      if (!authorization.binding.includeSourceAcquisitions) {
        throw invalidAuthorization();
      }
      const database = runtimeDatabase();
      await ensureDatabase(database);
      const enabledRows = await database.prepare(
        "SELECT id FROM auction_sources WHERE enabled = 1 AND permission_status = 'allowed'",
      ).all<{ id: string }>();
      const enabledIds = new Set((enabledRows.results ?? []).map((row) => row.id));
      const sourceOutcomes = parseExactTerminalSourceOutcomes(payload.sourceOutcomes,
        sourceOrchestrationRegistry.filter((policy) => enabledIds.has(policy.sourceId))
          .map((policy) => policy.sourceId));
      await reconcileCurrentOperationalProjectionContract({ database });
      if (
        schedulerRuntimeAuthorizationRegistry.transitionToPreparation(
          authorization.token,
          authorization.binding,
        ) === null
      ) throw invalidAuthorization();
      result = Object.freeze({
        transitioned: true,
        sourceOutcomeCount: sourceOutcomes.length,
      });
    } else {
      if (!isRecord(payload.candidate)) {
        throw invalidRequest("scheduler candidate is required");
      }
      assertCandidateAuthorization(payload.candidate, authorization.binding);
      const candidate = payload.candidate as unknown as SchedulerCandidate;
      if (action === "reserve") {
        const database = runtimeDatabase();
        await ensureDatabase(database);
        result = await reserveNightlySchedulerCandidate({ database, candidate });
      } else if (action === "abort_reserve_before_callback") {
        const database = runtimeDatabase();
        await ensureDatabase(database);
        result = await abortNightlySchedulerReserveBeforeCallback({
          database,
          candidate,
        });
      } else if (action === "acquire") {
        result = acquireNightlySchedulerCandidate({
          candidate,
          reservation: requiredRecord(payload.reservation, "reservation") as unknown as SchedulerReservation,
        });
      } else if (action === "validate") {
        result = await validateNightlySchedulerAcquisition({
          candidate,
          reservation: requiredRecord(payload.reservation, "reservation") as unknown as SchedulerReservation,
          acquired: payload.acquired,
        });
      } else if (action === "abort_before_callback") {
        if (
          (
            payload.callbackIdentity !== undefined &&
            typeof payload.callbackIdentity !== "string"
          ) ||
          (
            payload.abortPhase !== "acquire_failed" &&
            payload.abortPhase !== "validate_failed" &&
            payload.abortPhase !== "commit_prepare_failed"
          )
        ) throw invalidRequest("pre-callback abort binding is required");
        const database = runtimeDatabase();
        await ensureDatabase(database);
        result = await abortNightlySchedulerCallbackBeforeDispatch({
          database,
          candidate,
          reservation: requiredRecord(payload.reservation, "reservation") as unknown as SchedulerReservation,
          abortPhase: payload.abortPhase,
          ...(payload.callbackIdentity === undefined
            ? {}
            : { callbackIdentity: payload.callbackIdentity }),
        });
      } else if (action === "reconcile_callback") {
        if (
          typeof payload.callbackIdentity !== "string" ||
          payload.transportFailureReasonCode !== "local_transport_failed" ||
          typeof payload.dispatchedAt !== "string"
        ) throw invalidRequest("detached callback reconciliation binding is required");
        const database = runtimeDatabase();
        await ensureDatabase(database);
        result = await reconcileDetachedNightlySchedulerCallback({
          database,
          candidate,
          reservation: requiredRecord(payload.reservation, "reservation") as unknown as SchedulerReservation,
          ...(payload.receipt === undefined
            ? {}
            : { receipt: requiredRecord(payload.receipt, "receipt") as unknown as SchedulerCallbackReceipt }),
          callbackIdentity: payload.callbackIdentity,
          transportFailureReasonCode: payload.transportFailureReasonCode,
          dispatchedAt: payload.dispatchedAt,
          telemetry,
          telemetryContext: {
            campaignId: authorization.binding.campaignId,
            sourceId: candidate.sourceId,
          },
        });
      } else {
        const database = runtimeDatabase();
        await ensureDatabase(database);
        result = await commitNightlySchedulerCandidate({
          database,
          candidate,
          reservation: requiredRecord(payload.reservation, "reservation") as unknown as SchedulerReservation,
          bundle: requiredRecord(payload.bundle, "bundle") as unknown as SchedulerAcquiredBundle,
          ...(payload.receipt === undefined
            ? {}
            : { receipt: requiredRecord(payload.receipt, "receipt") as unknown as SchedulerCallbackReceipt }),
          telemetry,
        });
      }
    }
    if (performanceTelemetryEventsRequested(request)) {
      recordObservedTransportDatabaseTelemetry(
        telemetry,
        `nightly_scheduler_${action}`,
      );
    }
    telemetry.record({
      details: {
        kind: "stage",
        stage: `nightly_scheduler_${action}`,
        outcome: "completed",
        durationMs: performance.now() - telemetryStartedAt,
      },
    });
    return Response.json({
      schemaVersion: NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION,
      result,
      performanceTelemetry: drainTransportPerformanceTelemetry(request, telemetry),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(normalizeValidationError(error));
  }
}

function runtimeDatabase(): D1Database {
  const database = (env as unknown as { readonly DB?: D1Database }).DB;
  if (!database) throw new Error("Cloudflare D1 binding `DB` is unavailable");
  return database;
}

function requireSchedulerRuntimeAuthorization(request: Request): {
  readonly token: string;
  readonly binding: SchedulerRuntimeAuthorizationBinding;
} {
  const token = request.headers.get(NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER);
  if (token === null) throw invalidAuthorization();
  const binding = schedulerRuntimeAuthorizationRegistry.read(token);
  if (binding === null) throw invalidAuthorization();
  assertSchedulerRuntimeModeAllowsContinuation();
  return Object.freeze({ token, binding });
}

function assertSchedulerRuntimeModeAllowsContinuation(): void {
  const features = readNightlyPerformanceFeatures();
  if (features.forceCanonical) throw invalidAuthorization();
}

function queueBackedProximityCampaignAuthorizationAvailable(): boolean {
  const features = readNightlyPerformanceFeatures();
  const mode = features.modes.queueBackedProximity;
  return !features.forceCanonical && mode !== "off" && mode !== "shadow";
}

function enrichmentSessionResidencyCampaignAuthorizationAvailable(): boolean {
  const features = readNightlyPerformanceFeatures();
  const mode = features.modes.enrichmentSessionResidency;
  return !features.forceCanonical && mode !== "off" && mode !== "shadow";
}

function assertCandidateAuthorization(
  candidate: Record<string, unknown>,
  binding: SchedulerRuntimeAuthorizationBinding,
): void {
  if (candidate.stage === "preference_v2_score") {
    throw invalidRequest("Preference scoring is not available in this distribution");
  }
  if (candidate.kind !== "source_acquisition") return;
  if (!binding.includeSourceAcquisitions || !isRecord(candidate.sourceInput)) {
    throw invalidAuthorization();
  }
  const sourceInput = candidate.sourceInput;
  if (
    sourceInput.campaignId !== binding.campaignId ||
    sourceInput.coverageMode !== "complete_current" ||
    (
      binding.coverageMode !== "auto" &&
      sourceInput.coverageMode !== binding.coverageMode
    )
  ) throw invalidAuthorization();
}

function requiredUniqueParameter(url: URL, key: string): string {
  const value = optionalUniqueParameter(url, key);
  if (value === undefined || value.length === 0) throw invalidRequest(`${key} is required`);
  return value;
}

function optionalUniqueParameter(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) throw invalidRequest(`${key} may be specified only once`);
  return values[0];
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidRequest(`${label} is required`);
  return value;
}

function invalidCoverageMode(): never {
  throw invalidRequest(
    "coverageMode must be auto or complete_current",
  );
}

function actionAllowedKeys(action: NightlySchedulerRouteAction): ReadonlySet<string> {
  if (action === "record_execution_evidence") {
    return new Set([
      "schemaVersion",
      "action",
      "executionEvidence",
      "invocationIdentityHash",
      "completedAt",
    ]);
  }
  if (action === "transition_to_preparation") {
    return new Set(["schemaVersion", "action", "sourceOutcomes"]);
  }
  const common = ["schemaVersion", "action", "candidate"];
  if (action === "reserve" || action === "abort_reserve_before_callback") {
    return new Set(common);
  }
  if (action === "acquire") return new Set([...common, "reservation"]);
  if (action === "validate") return new Set([...common, "reservation", "acquired"]);
  if (action === "abort_before_callback") {
    return new Set([
      ...common,
      "reservation",
      "callbackIdentity",
      "abortPhase",
    ]);
  }
  if (action === "reconcile_callback") {
    return new Set([
      ...common,
      "reservation",
      "callbackIdentity",
      "transportFailureReasonCode",
      "dispatchedAt",
      "receipt",
    ]);
  }
  return new Set([...common, "reservation", "bundle", "receipt"]);
}

function invalidRequest(message: string): HttpError {
  return new HttpError(message, 400, "invalid_nightly_scheduler_request");
}

function invalidAuthorization(): HttpError {
  return new HttpError(
    "The scheduler invocation authorization is missing or invalid",
    401,
    "nightly_scheduler_authorization_required",
  );
}

function assertRuntimeRevision(request: Request): void {
  if (request.headers.get(RUNTIME_REVISION_HEADER) !== loadedRuntimeRevision()) {
    throw new HttpError(
      RUNTIME_REVISION_MISMATCH_MESSAGE,
      409,
      "runtime_revision_mismatch",
    );
  }
}

function normalizeValidationError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  if (error instanceof RangeError || error instanceof TypeError) return invalidRequest(error.message);
  if (isRecord(error) && error.priorHeadPreserved === true && typeof error.reasonCode === "string") {
    return new HttpError("The exact scheduler claim is no longer available", 409, error.reasonCode);
  }
  return error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
