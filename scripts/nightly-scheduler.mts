import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { samePublicationHead } from "../lib/pipeline/publication-transition.ts";

import { hashCanonicalJson } from "../lib/performance/generations.ts";
import {
  requestIdentityForTelemetry,
  type PerformanceTelemetryScenario,
  type PerformanceTelemetrySink,
} from "../lib/performance/telemetry.ts";
import {
  ingestPerformanceTelemetryEnvelope,
  PERFORMANCE_TELEMETRY_REQUEST_HEADER,
  PERFORMANCE_TELEMETRY_REQUEST_VALUE,
} from "../lib/performance/telemetry-transport.ts";
import {
  PerformanceTelemetrySession,
  type PerformanceTelemetrySessionReceipt,
} from "../lib/performance/telemetry-session.ts";
import {
  parsePreferenceV2ScorerErrorEnvelope,
  type PreferenceV2ScorerErrorEnvelope,
} from "../lib/preference-v2/scorer-error.ts";
import type { SourceInventoryPublicationHead } from "../lib/pipeline/storage.ts";
import {
  runNightlyScheduler,
  WORKFLOW_DEADLINE_SETTLEMENT_RESERVE_EXHAUSTED,
} from "../lib/scheduler/engine.ts";
import {
  LOCAL_SCHEDULER_SOURCE_ID,
  createRuntimeAdapterHandlerRegistry,
  NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION,
  type NightlySchedulerRuntimeAdapter,
  type SchedulerAdapterAction,
} from "../lib/scheduler/runtime-adapter.ts";
import { NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER } from
  "../lib/scheduler/runtime-authorization.ts";
import { ENRICHMENT_CALLBACK_TIMEOUT_MS } from
  "../lib/scheduler/enrichment-contract.ts";
import {
  PREPARATION_WORK_STAGES,
  SCHEDULER_SCHEMA_VERSION,
  type SchedulerAcquiredBundle,
  type SchedulerCallbackInstruction,
  type SchedulerCallbackReceipt,
  type SchedulerCandidate,
  type SchedulerDetachedCallbackReconciliation,
  type SchedulerExternalAcquisitionReceipt,
  type SchedulerPrimaryImageSession,
  type SchedulerPreferenceV2Progress,
  type SchedulerPreferenceV2SessionDiagnostics,
  type SchedulerProgressEvent,
  type SchedulerProximityProgress,
  type SchedulerReservation,
  type SchedulerRunResult,
  type SchedulerSnapshot,
  type SchedulerRecentPublicationSkip,
  type SchedulerSourceCampaignOutcome,
  type SchedulerSourceHeadEvidence,
  type SchedulerWorkOutcome,
} from "../lib/scheduler/types.ts";
import { sourceOrchestrationRegistry } from "../lib/sources/orchestration.ts";
import type { SourceId } from "../lib/sources/types.ts";
import {
  isRuntimeRevision,
  RUNTIME_REVISION_HEADER,
} from "../lib/runtime-revision.ts";

export const NIGHTLY_SCHEDULER_CLI_SCHEMA_VERSION =
  "auction-discovery-nightly-scheduler-cli-v1" as const;
export const NIGHTLY_SCHEDULER_ADAPTER_PATH =
  "/api/internal/nightly-scheduler" as const;
export const NIGHTLY_SCHEDULER_PROGRESS_PREFIX =
  "@@auction-discovery-nightly-progress-v1@@" as const;
export const CANONICAL_CONTINUATION_PROGRESS_SCHEMA_VERSION =
  "auction-discovery-canonical-continuation-progress-v2" as const;
export const CANONICAL_CONTINUATION_PROGRESS_RECEIPT_SCHEMA_VERSION =
  "auction-discovery-canonical-continuation-progress-receipt-v2" as const;

// Raw acquisition may consume 32 MiB before normalization. Adapter action
// envelopes remain bounded by the Worker action-body boundary.
const MAX_LOCAL_JSON_BYTES = 32 * 1024 * 1024;
const MAX_PREFERENCE_V2_SESSION_DIAGNOSTIC_MS = 20 * 60_000;
const ADAPTER_REQUEST_TIMEOUT_MS = 30 * 60_000;
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30_000;
export const SNAPSHOT_RECOVERY_INTERVAL_MS = 5_000;
export const SNAPSHOT_RECOVERY_WINDOW_MS = 5 * 60_000;
const MAX_SNAPSHOT_RECOVERY_ATTEMPTS =
  Math.ceil(SNAPSHOT_RECOVERY_WINDOW_MS / SNAPSHOT_RECOVERY_INTERVAL_MS) + 1;
const DETACHED_CALLBACK_RECONCILIATION_INTERVAL_MS = 15_000;
const DETACHED_CALLBACK_RECONCILIATION_GRACE_MS = 60_000;
const DIRECT_SOURCE_CALLBACK_RECONCILIATION_GRACE_MS = 20 * 60_000;
const RECONCILIATION_REQUEST_TIMEOUT_MS = 30_000;
const ACQUIRE_BOUND_PREPARATION_STAGE_SET = new Set([
  "enrichment_text",
  "enrichment_embedding",
]);
const CLI_PROGRESS_OBSERVATION_CADENCE_MS = 30_000;
// A source campaign must retain its invocation-local fresh/terminal sets until
// all manifest-bounded complete-current work has a boundary. The current sum
// of registered request ceilings remains bounded; this dispatch cap also
// bounds retries without handing completion state to a new process.
const SOURCE_CAMPAIGN_MAX_DISPATCHES = 10_000;
// One short retry absorbs a dev-route startup miss without turning a single
// transient 404/501 into a canonical compatibility campaign. A valid typed
// ready=false response is authoritative and is never retried here.
export const OPTIMIZED_READINESS_RETRY_DELAY_MS = 1_000;
export const SOURCE_MINIMUM_SETTLEMENT_RESERVE_MS = 3 * 60 * 60_000 + 5 * 60_000;
export const DIRECT_SOURCE_MINIMUM_SETTLEMENT_RESERVE_MS = 40 * 60_000;
export const CORE_PREPARATION_MINIMUM_SETTLEMENT_RESERVE_MS = 35 * 60_000;
// Maintenance is heterogeneous. Keep only a short admission
// floor here, then reserve each candidate's complete callback contract below.
// That lets a bounded scorer or local release use the remaining workflow time
// without admitting an enrichment callback that cannot settle.
export const MAINTENANCE_MINIMUM_SETTLEMENT_RESERVE_MS = 5 * 60_000;
// The companion owns a 20-minute detached-safe HTTP guard and may publish new
// core preparation work. Reserve that callback plus the complete ordinary core
// settlement contract so optional scoring cannot strand required work at the
// absolute workflow deadline.
export const PREFERENCE_V2_MINIMUM_SETTLEMENT_RESERVE_MS =
  20 * 60_000 + CORE_PREPARATION_MINIMUM_SETTLEMENT_RESERVE_MS;
const MAINTENANCE_DISPATCH_QUANTUM = 1;
const PREFERENCE_V2_MAINTENANCE_COMPLETED_CAP = 10;

export function preferenceV2MaintenanceCapReached(
  completedUnits: number,
  remainingRows: number,
): boolean {
  return completedUnits >= PREFERENCE_V2_MAINTENANCE_COMPLETED_CAP &&
    remainingRows > 0;
}
const OPTIMIZED_HANDLER_NOT_READY_BACKOFF_MS = 15_000;
const OPTIMIZED_PRIOR_HEAD_PRESERVED_BACKOFF_MS = 60_000;
const OPTIMIZED_GENERIC_MAINTENANCE_RETRY_BACKOFF_MS = 60_000;

export interface NightlySchedulerCliOptions {
  readonly mode: "auto" | "canonical" | "optimized";
  readonly baseUrl: string;
  readonly maxConcurrency: number;
  readonly maxDispatches: number;
  readonly readinessOnly: boolean;
  readonly completeCurrentAudit: boolean;
  readonly existingCatalogOnly: boolean;
  readonly existingCatalogMaintenanceOnly: boolean;
  readonly runtimeRevision: string | null;
  /** Exact argument text retained across the PowerShell/TypeScript boundary. */
  readonly workflowDeadlineAt: string | null;
  readonly deadlineAtMs: number | null;
  readonly performance: Readonly<{
    readonly scenario: PerformanceTelemetryScenario;
    readonly strategy: "fixed_order" | "critical_path";
    readonly destinationPath: string;
  }> | null;
}

export interface NightlySchedulerReadiness {
  readonly ready: boolean;
  readonly mode: NightlySchedulerCliOptions["mode"];
  readonly selectedMode: "canonical" | "optimized";
  readonly missingSeams: readonly string[];
  readonly sourceCount: number;
  readonly preparationStages: readonly string[];
}

export interface NightlySchedulerRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface NightlySchedulerResponse {
  readonly status: number;
  readonly body: unknown;
  /** Exact native-HTTP observation; present only on the production transport. */
  readonly transportMeasurement?: Readonly<{
    readonly startedAt: string;
    readonly endedAt: string;
    readonly responseBytes: number;
    readonly parsingMs: number;
  }>;
}

export interface NightlySchedulerCliDependencies {
  readonly request?: (input: NightlySchedulerRequest) => Promise<NightlySchedulerResponse>;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Includes this CLI process; tests may inject the measured process-tree count. */
  readonly processLaunchCount?: number;
  readonly progressSink?: (event: SchedulerProgressEvent) => void;
  /** Focused-test cadence seam; production re-observes silent work every 30 seconds. */
  readonly progressHeartbeatIntervalMs?: number;
  /** Graceful-stop signal shared with callback dispatch and scheduler admission. */
  readonly signal?: AbortSignal;
}

export interface ScopedNightlySchedulerRuntimeAdapter
  extends NightlySchedulerRuntimeAdapter {
  setPreparationScope(scope: "core" | "maintenance"): void;
}

interface ReconciledExternalCallbackOutcome {
  readonly kind: "reconciled_external_callback_outcome";
  readonly outcome: SchedulerWorkOutcome;
}

export interface OptimizedPreparationContinuationState {
  /** Signatures that have consumed their one unchanged retry allowance. */
  readonly retriedNoProgressSignatures: readonly string[];
}

export type OptimizedPreparationContinuationDecision =
  | Readonly<{
      continue: true;
      delayMs: number;
      signature: string;
      state: OptimizedPreparationContinuationState;
    }>
  | Readonly<{
      continue: false;
      terminalReasonCode: string | null;
      signature: string;
      state: OptimizedPreparationContinuationState;
    }>;

export interface CanonicalContinuationProgressVector {
  readonly schemaVersion: typeof CANONICAL_CONTINUATION_PROGRESS_SCHEMA_VERSION;
  readonly earliestDocumentAccessNextEligibleAt: string | null;
  readonly documentAccessStops: readonly Readonly<{
    sourceId: SourceId;
    state: "cooldown" | "manual_reset_required";
    reasonCode: string;
    nextEligibleAt: string | null;
  }>[];
  readonly sources: readonly Readonly<{
    sourceId: SourceId;
    publicationHead: (SourceInventoryPublicationHead & Readonly<{
      membershipFingerprint: string;
      membershipCount: number;
    }>) | null;
    traversal: Readonly<{
      traversalId: string;
      contractHash: string;
      expectedPages: number;
      completed: boolean;
      completedCheckpointHashes: readonly string[];
    }> | null;
  }>[];
}

export interface CanonicalContinuationProgressReceipt {
  readonly schemaVersion: typeof CANONICAL_CONTINUATION_PROGRESS_RECEIPT_SCHEMA_VERSION;
  readonly comparison: "advanced" | "no_progress";
  readonly beforeHash: string;
  readonly afterHash: string;
}

export interface CanonicalContinuationProgressComparison {
  readonly classification: "advanced" | "no_progress" | "regressed";
  readonly advancedSourceIds: readonly SourceId[];
  readonly publicationAdvancedSourceIds: readonly SourceId[];
}


class SchedulerAdapterUnavailableError extends Error {
  readonly reasonCode = "scheduler_adapter_endpoint_unavailable";

  constructor(
    message: string,
    readonly transientHttpStatus: 404 | 501 | null = null,
  ) {
    super(message);
    this.name = "SchedulerAdapterUnavailableError";
  }
}

class SchedulerRuntimeError extends Error {
  constructor(
    readonly reasonCode: string,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "SchedulerRuntimeError";
  }
}

function stateAmbiguousSchedulerError(
  reasonCode: string,
  message: string,
  cause: unknown,
): Error & { readonly reasonCode: string; readonly stateAmbiguous: true } {
  return Object.assign(new SchedulerRuntimeError(reasonCode, message), {
    stateAmbiguous: true as const,
    cause,
  });
}

export function parseNightlySchedulerArgs(
  args: readonly string[],
): NightlySchedulerCliOptions {
  let mode: NightlySchedulerCliOptions["mode"] = "auto";
  let baseUrl = "http://localhost:3000";
  let maxConcurrency = 3;
  let maxDispatches = 100;
  let readinessOnly = false;
  let completeCurrentAudit = false;
  let existingCatalogOnly = false;
  let existingCatalogMaintenanceOnly = false;
  let runtimeRevision: string | null = null;
  let workflowDeadlineAt: string | null = null;
  let deadlineAtMs: number | null = null;
  let performanceMode = false;
  let performanceScenario: PerformanceTelemetryScenario | null = null;
  let performanceStrategy: "fixed_order" | "critical_path" | null = null;
  let performanceDestination: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--mode") {
      const value = args[++index];
      if (value !== "auto" && value !== "canonical" && value !== "optimized") {
        throw new RangeError("--mode must be auto, canonical, or optimized");
      }
      mode = value;
    } else if (argument === "--base-url") {
      baseUrl = validateBaseUrl(args[++index]);
    } else if (argument === "--max-concurrency") {
      maxConcurrency = boundedInteger(args[++index], "--max-concurrency", 1, 3);
    } else if (argument === "--max-dispatches") {
      maxDispatches = boundedInteger(args[++index], "--max-dispatches", 1, 10_000);
    } else if (argument === "--readiness-only") {
      readinessOnly = true;
    } else if (argument === "--complete-current-audit") {
      completeCurrentAudit = true;

    } else if (argument === "--existing-catalog-only") {
      existingCatalogOnly = true;
    } else if (argument === "--existing-catalog-maintenance-only") {
      existingCatalogMaintenanceOnly = true;
    } else if (argument === "--runtime-revision") {
      const value = args[++index];
      if (!isRuntimeRevision(value)) {
        throw new RangeError("--runtime-revision must be sha256:<64 lowercase hex>");
      }
      runtimeRevision = value;
    } else if (argument === "--workflow-deadline-at") {
      if (workflowDeadlineAt !== null) {
        throw new RangeError("--workflow-deadline-at may be specified exactly once");
      }
      const parsed = absoluteWorkflowDeadline(args[++index]);
      workflowDeadlineAt = parsed.argument;
      deadlineAtMs = parsed.deadlineAtMs;
    } else if (argument === "--performance") {
      performanceMode = true;
    } else if (argument === "--scenario") {
      const value = args[++index];
      if (
        value !== "unchanged" && value !== "one_delta" &&
        value !== "tail_heavy"
      ) {
        throw new RangeError(
          "--scenario must be unchanged, one_delta, or tail_heavy",
        );
      }
      performanceScenario = value;
    } else if (argument === "--strategy") {
      const value = args[++index];
      if (value !== "fixed_order" && value !== "critical_path") {
        throw new RangeError("--strategy must be fixed_order or critical_path");
      }
      performanceStrategy = value;
    } else if (argument === "--telemetry-destination") {
      const value = args[++index];
      if (typeof value !== "string" || value.trim() === "") {
        throw new RangeError("--telemetry-destination requires a local JSONL path");
      }
      performanceDestination = value;
    } else {
      throw new RangeError(`unsupported nightly scheduler argument ${argument}`);
    }
  }
  if (existingCatalogOnly && mode === "canonical") {
    throw new RangeError("--existing-catalog-only requires auto or optimized mode");
  }
  if (existingCatalogOnly && completeCurrentAudit) {
    throw new RangeError(
      "--existing-catalog-only and --complete-current-audit are mutually exclusive",
    );
  }
  if (existingCatalogMaintenanceOnly && !existingCatalogOnly) {
    throw new RangeError(
      "--existing-catalog-maintenance-only requires --existing-catalog-only",
    );
  }
  const performanceArgumentsPresent = performanceScenario !== null ||
    performanceStrategy !== null || performanceDestination !== null;
  if (!performanceMode && performanceArgumentsPresent) {
    throw new RangeError(
      "--scenario, --strategy, and --telemetry-destination require --performance",
    );
  }
  if (
    performanceMode &&
    (performanceScenario === null || performanceStrategy === null ||
      performanceDestination === null)
  ) {
    throw new RangeError(
      "--performance requires --scenario, --strategy, and --telemetry-destination",
    );
  }
  if (performanceMode && readinessOnly) {
    throw new RangeError("--performance cannot be combined with --readiness-only");
  }
  return Object.freeze({
    mode,
    baseUrl,
    maxConcurrency,
    maxDispatches,
    readinessOnly,
    completeCurrentAudit,
    existingCatalogOnly,
    existingCatalogMaintenanceOnly,
    runtimeRevision,
    workflowDeadlineAt,
    deadlineAtMs,
    performance: performanceMode
      ? Object.freeze({
          scenario: performanceScenario!,
          strategy: performanceStrategy!,
          destinationPath: performanceDestination!,
        })
      : null,
  });
}

/**
 * Ordinary auto uses the exact per-source complete-current adapter. Legacy
 * canonical execution is unavailable in the public runtime.
 */
export function readNightlySchedulerReadiness(
  options: NightlySchedulerCliOptions,
  input: {
    readonly optimizedEndpointAvailable?: boolean;
    readonly sourceCount?: number;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  } = {},
): NightlySchedulerReadiness {
  const forceCanonical = strictBoolean(
    (input.environment ?? process.env).PERF_FORCE_CANONICAL,
  );
  const optimizedAvailable = input.optimizedEndpointAvailable === true;
  const selectedMode = options.mode === "canonical" || forceCanonical
    ? "canonical" as const
    : "optimized" as const;
  const missingSeams = selectedMode === "canonical"
    ? ["canonical_scheduler_unavailable"]
    : selectedMode === "optimized" && !optimizedAvailable
    ? ["worker_nightly_scheduler_adapter_endpoint_not_integrated"]
    : [];
  const readiness: NightlySchedulerReadiness = {
    ready: missingSeams.length === 0,
    mode: options.mode,
    selectedMode,
    missingSeams: Object.freeze(missingSeams),
    sourceCount: input.sourceCount ?? sourceOrchestrationRegistry.length,
    preparationStages: PREPARATION_WORK_STAGES.filter((stage) => stage !== "preference_v2_score"),
  };
  return Object.freeze(readiness);
}

export function createHttpSchedulerRuntimeAdapter(input: {
  readonly baseUrl: string;
  readonly maxDispatches: number;
  readonly request: (request: NightlySchedulerRequest) => Promise<NightlySchedulerResponse>;
  readonly forceCompleteCurrent?: boolean;
  readonly includeSourceAcquisitions?: boolean;
  readonly initialPreparationScope?: "core" | "maintenance";
  readonly deadlineAtMs?: number;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
}): ScopedNightlySchedulerRuntimeAdapter {
  if (
    input.initialPreparationScope !== undefined &&
    input.includeSourceAcquisitions !== false
  ) {
    throw new RangeError(
      "an initial preparation scope requires source acquisitions to be disabled",
    );
  }
  const endpoint = `${validateBaseUrl(input.baseUrl)}${NIGHTLY_SCHEDULER_ADAPTER_PATH}`;
  const campaignId =
    `nightly-${Date.now().toString(36)}-${process.pid.toString(36)}-${randomUUID()}`;
  // The Worker contract deliberately bounds a single read to 200 candidates;
  // a larger dispatch budget is satisfied across repeated exact snapshots.
  const snapshotLimit = Math.min(
    200,
    Math.max(input.maxDispatches, sourceOrchestrationRegistry.length),
  );
  let authorizationToken: string | null = null;
  let includeSourceAcquisitions = input.includeSourceAcquisitions !== false;
  let transitionedToPreparation = input.includeSourceAcquisitions === false;
  let preparationScope: "all" | "core" | "maintenance" =
    input.initialPreparationScope ?? "all";
  let prefetchedPreparationSnapshot: SchedulerSnapshot | null = null;
  const reconciledExternalOutcomes = new Map<string, SchedulerWorkOutcome>();
  const acquireBoundCallbackReceipts = new Map<string, Readonly<{
    candidateId: string;
    acquired: SchedulerExternalAcquisitionReceipt;
    acquiredIdentity: string;
  }>>();
  const schedulerAuthorizationHeaders = (): Readonly<Record<string, string>> => {
    if (authorizationToken === null) {
      throw new SchedulerRuntimeError(
        "scheduler_adapter_authorization_missing",
        "The nightly scheduler invocation has not completed its readiness handshake",
      );
    }
    return Object.freeze({
      [NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER]: authorizationToken,
    });
  };
  const snapshotNow = input.now ?? (() => new Date());
  const snapshotSleep = input.sleep ?? sleep;
  const snapshotRecoveryStatus = (status: number): boolean =>
    status === 500 || status === 502 || status === 503 || status === 504;
  const snapshotAuthorizationExpired = (response: NightlySchedulerResponse): boolean =>
    response.status === 401 && isRecord(response.body) &&
    response.body.code === "nightly_scheduler_authorization_required";
  const snapshotTransportFailure = (error: unknown): boolean =>
    (error instanceof SchedulerRuntimeError || isRecord(error)) &&
    error.reasonCode === "local_transport_failed";
  const waitForSnapshotRecovery = async (
    startedAtMs: number,
    attempt: number,
  ): Promise<boolean> => {
    const elapsedMs = snapshotNow().getTime() - startedAtMs;
    if (
      attempt >= MAX_SNAPSHOT_RECOVERY_ATTEMPTS ||
      elapsedMs >= SNAPSHOT_RECOVERY_WINDOW_MS
    ) return false;
    const waitMs = Math.min(
      SNAPSHOT_RECOVERY_INTERVAL_MS,
      Math.max(0, SNAPSHOT_RECOVERY_WINDOW_MS - elapsedMs),
    );
    const reserveMs = includeSourceAcquisitions
      ? DIRECT_SOURCE_MINIMUM_SETTLEMENT_RESERVE_MS
      : preparationScope === "core"
      ? CORE_PREPARATION_MINIMUM_SETTLEMENT_RESERVE_MS
      : MAINTENANCE_MINIMUM_SETTLEMENT_RESERVE_MS;
    if (
      input.deadlineAtMs !== undefined &&
      snapshotNow().getTime() + waitMs + reserveMs > input.deadlineAtMs
    ) return false;
    await snapshotSleep(waitMs);
    return true;
  };
  const requestAdapter = async (
    action: SchedulerAdapterAction,
    candidate: SchedulerCandidate,
    reservation?: SchedulerReservation,
    acquired?: unknown,
    bundle?: SchedulerAcquiredBundle,
    receipt?: SchedulerCallbackReceipt,
    lifecycleControl?: Readonly<
      | {
          callbackIdentity: string;
          transportFailureReasonCode: "local_transport_failed";
          dispatchedAt: string;
        }
      | {
          callbackIdentity?: string;
          abortPhase: "acquire_failed" | "validate_failed" | "commit_prepare_failed";
        }
    >,
    requestTimeoutMs = ADAPTER_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> => {
    const response = await input.request({
      method: "POST",
      url: endpoint,
      body: Object.freeze({
        schemaVersion: NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION,
        action,
        candidate,
        ...(reservation === undefined ? {} : { reservation }),
        ...(acquired === undefined ? {} : { acquired }),
        ...(bundle === undefined ? {} : { bundle }),
        ...(receipt === undefined ? {} : { receipt }),
        ...(lifecycleControl === undefined ? {} : lifecycleControl),
      }),
      timeoutMs: requestTimeoutMs,
      maxResponseBytes: MAX_LOCAL_JSON_BYTES,
      headers: schedulerAuthorizationHeaders(),
    });
    assertAdapterStatus(response, action);
    if (!isRecord(response.body) || response.body.schemaVersion !== NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION) {
      throw new SchedulerRuntimeError(
        "scheduler_adapter_contract_mismatch",
        `The nightly scheduler adapter returned an invalid ${action} response`,
      );
    }
    return response.body.result;
  };
  const abortBeforeCallback = async (
    candidate: SchedulerCandidate,
    reservation: SchedulerReservation,
    abortPhase: "acquire_failed" | "validate_failed" | "commit_prepare_failed",
    callbackIdentity?: string,
  ): Promise<SchedulerWorkOutcome> => {
    let outcome: SchedulerWorkOutcome;
    try {
      outcome = parseOutcome(await requestAdapter(
        "abort_before_callback",
        candidate,
        reservation,
        undefined,
        undefined,
        undefined,
        Object.freeze({
          abortPhase,
          ...(callbackIdentity === undefined ? {} : { callbackIdentity }),
        }),
      ));
    } catch (error) {
      throw stateAmbiguousSchedulerError(
        "source_callback_abort_failed",
        "The scheduler could not prove that its pre-callback reservation was released",
        error,
      );
    }
    if (
      outcome.classification !== "no_progress" || outcome.madeProgress ||
      !outcome.reasonCode.startsWith(
        candidate.kind === "preparation"
          ? "preparation_callback_"
          : "source_callback_",
      )
    ) {
      throw new SchedulerRuntimeError(
        "source_callback_abort_contract_mismatch",
        "The scheduler pre-callback abort returned an invalid terminal outcome",
      );
    }
    return outcome;
  };
  const refreshSameCampaignAuthorization = async (): Promise<void> => {
    const url = new URL(endpoint);
    url.searchParams.set("limit", String(snapshotLimit));
    url.searchParams.set("campaignId", campaignId);
    url.searchParams.set(
      "coverageMode",
      input.forceCompleteCurrent === true
        ? "complete_current"
        : "auto",
    );
    url.searchParams.set(
      "includeSourceAcquisitions",
      includeSourceAcquisitions ? "true" : "false",
    );
    url.searchParams.set("preparationScope", preparationScope);
    const response = await input.request({
      method: "GET",
      url: url.toString(),
      timeoutMs: RECONCILIATION_REQUEST_TIMEOUT_MS,
      maxResponseBytes: MAX_LOCAL_JSON_BYTES,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new SchedulerRuntimeError(
        "scheduler_adapter_authorization_refresh_failed",
        `The nightly scheduler same-campaign authorization refresh failed with HTTP ${response.status}`,
        response.status,
      );
    }
    // Parse and discard the bounded same-campaign snapshot. It exists only to
    // re-establish the process-local authorization after a supervised Worker
    // restart; it must not advance or replace the scheduler's current phase.
    parseAdapterSnapshot(response.body, snapshotLimit, preparationScope);
    authorizationToken = parseAdapterAuthorizationToken(response.body);
  };
  const reconcileAfterCallbackDispatch = async (
    candidate: SchedulerCandidate,
    reservation: SchedulerReservation,
    instruction: Exclude<SchedulerCallbackInstruction, { kind: "local_commit" }>,
    dispatchStartedAt: number,
    receipt?: SchedulerCallbackReceipt,
  ): Promise<SchedulerWorkOutcome> => {
    const dispatchedAt = new Date(dispatchStartedAt).toISOString();
    const callbackIdentity = await hashCanonicalJson(instruction);
    const directSourceCallback = candidate.kind === "source_acquisition" &&
      instruction.service === "dashboard" && instruction.path === "/api/runs" &&
      instruction.successContract === "source_catalog";
    const reconciliationGraceMs = directSourceCallback
      ? DIRECT_SOURCE_CALLBACK_RECONCILIATION_GRACE_MS
      : DETACHED_CALLBACK_RECONCILIATION_GRACE_MS;
    // Admission already reserved this settlement window before dispatch. Once
    // the callback is in flight, the workflow deadline must not cut off its
    // exact-once durable reconciliation.
    const callbackDeadlineMs = dispatchStartedAt + instruction.timeoutMs +
      reconciliationGraceMs;
    const deadlineMs = callbackDeadlineMs;
    const reconciliationWindowMs = Math.max(0, deadlineMs - dispatchStartedAt);
    const maxPolls = Math.ceil(
      reconciliationWindowMs /
        DETACHED_CALLBACK_RECONCILIATION_INTERVAL_MS,
    ) + 2;
    let polls = 0;
    let authorizationRecoveryUsed = false;
    while (true) {
      polls += 1;
      let reconciliation: SchedulerDetachedCallbackReconciliation;
      try {
        if (authorizationToken === null) await refreshSameCampaignAuthorization();
        reconciliation = parseDetachedCallbackReconciliation(
          await requestAdapter(
            "reconcile_callback",
            candidate,
            reservation,
            undefined,
            undefined,
            receipt,
            Object.freeze({
              callbackIdentity,
              // This code identifies the lost local transport boundary. The
              // optional receipt is present only when callback transport
              // completed and both later finalizer responses were lost.
              transportFailureReasonCode: "local_transport_failed" as const,
              dispatchedAt,
            }),
            RECONCILIATION_REQUEST_TIMEOUT_MS,
          ),
        );
      } catch (error) {
        const runtimeError = error instanceof SchedulerRuntimeError ? error : null;
        if (
          runtimeError?.httpStatus === 401 && authorizationToken !== null &&
          !authorizationRecoveryUsed
        ) {
          // A supervised Worker restart intentionally loses its opaque token.
          // Clear it once and use the same campaign GET to obtain a replacement;
          // the exact callback receipt is reconciled and never redispatched.
          authorizationToken = null;
          authorizationRecoveryUsed = true;
          continue;
        }
        const transportReasonCode = isRecord(error) &&
            typeof error.reasonCode === "string"
          ? error.reasonCode
          : null;
        const retryable = transportReasonCode === "local_transport_failed" ||
          runtimeError?.httpStatus === 500 || runtimeError?.httpStatus === 502 ||
          runtimeError?.httpStatus === 503 || runtimeError?.httpStatus === 504;
        const currentMs = (input.now?.() ?? new Date()).getTime();
        if (!retryable || currentMs >= deadlineMs || polls >= maxPolls) {
          throw stateAmbiguousSchedulerError(
            "d1_reconciliation_unavailable",
            "The scheduler could not prove the already-dispatched callback's durable terminal state",
            error,
          );
        }
        const waitMs = Math.min(
          DETACHED_CALLBACK_RECONCILIATION_INTERVAL_MS,
          deadlineMs - currentMs,
        );
        await (input.sleep ?? sleep)(waitMs);
        continue;
      }
      if (reconciliation.state === "outcome") return reconciliation.outcome;
      const currentMs = (input.now?.() ?? new Date()).getTime();
      if (currentMs >= deadlineMs || polls >= maxPolls) {
        throw stateAmbiguousSchedulerError(
          "detached_callback_reconciliation_timeout_active",
          "The detached callback remained durably active through its bounded reconciliation deadline",
          reconciliation,
        );
      }
      const waitMs = Math.min(
        DETACHED_CALLBACK_RECONCILIATION_INTERVAL_MS,
        deadlineMs - currentMs,
      );
      await (input.sleep ?? sleep)(waitMs);
    }
  };
  const adapter: ScopedNightlySchedulerRuntimeAdapter = {
    async readSnapshot(): Promise<SchedulerSnapshot> {
      if (prefetchedPreparationSnapshot !== null) {
        const snapshot = prefetchedPreparationSnapshot;
        prefetchedPreparationSnapshot = null;
        return snapshot;
      }
      const recoveryStartedAtMs = snapshotNow().getTime();
      let authorizationRecoveryUsed = false;
      for (let attempt = 1; ; attempt += 1) {
        const url = new URL(endpoint);
        url.searchParams.set("limit", String(snapshotLimit));
        url.searchParams.set("campaignId", campaignId);
        url.searchParams.set(
          "coverageMode",
          input.forceCompleteCurrent === true
            ? "complete_current"
            : "auto",
        );
        url.searchParams.set(
          "includeSourceAcquisitions",
          includeSourceAcquisitions ? "true" : "false",
        );
        url.searchParams.set("preparationScope", preparationScope);
        let response: NightlySchedulerResponse;
        try {
          response = await input.request({
            method: "GET",
            url: url.toString(),
            timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS,
            maxResponseBytes: MAX_LOCAL_JSON_BYTES,
            ...(authorizationToken === null
              ? {}
              : { headers: schedulerAuthorizationHeaders() }),
          });
        } catch (error) {
          if (
            !snapshotTransportFailure(error) ||
            !await waitForSnapshotRecovery(recoveryStartedAtMs, attempt)
          ) {
            if (!snapshotTransportFailure(error)) throw error;
            throw new SchedulerRuntimeError(
              "scheduler_adapter_snapshot_recovery_exhausted",
              "The nightly scheduler adapter snapshot transport remained unavailable after bounded recovery",
            );
          }
          continue;
        }
        if (
          snapshotAuthorizationExpired(response) && authorizationToken !== null &&
          !authorizationRecoveryUsed
        ) {
          // The authorization registry is intentionally process-local. A
          // supervised Worker restart therefore invalidates the old opaque
          // token; repeat the same campaign binding without a token exactly
          // once so the freshly loaded runtime can issue its replacement.
          authorizationToken = null;
          authorizationRecoveryUsed = true;
          continue;
        }
        if (snapshotRecoveryStatus(response.status)) {
          if (await waitForSnapshotRecovery(recoveryStartedAtMs, attempt)) continue;
          throw new SchedulerRuntimeError(
            "scheduler_adapter_snapshot_recovery_exhausted",
            `The nightly scheduler adapter snapshot remained unavailable after HTTP ${response.status}`,
          );
        }
        if (response.status === 404 || response.status === 501) {
          throw new SchedulerAdapterUnavailableError(
            "The Worker nightly scheduler adapter endpoint is not integrated",
            response.status,
          );
        }
        if (response.status < 200 || response.status >= 300) {
          throw new SchedulerRuntimeError(
            "scheduler_adapter_snapshot_failed",
            `The nightly scheduler adapter snapshot failed with HTTP ${response.status}`,
          );
        }
        const snapshot = parseAdapterSnapshot(
          response.body,
          snapshotLimit,
          preparationScope,
        );
        const receivedAuthorization = parseAdapterAuthorizationToken(response.body);
        if (authorizationToken === null) authorizationToken = receivedAuthorization;
        else if (authorizationToken !== receivedAuthorization) {
          throw new SchedulerRuntimeError(
            "scheduler_adapter_authorization_changed",
            "The nightly scheduler invocation authorization changed unexpectedly",
          );
        }
        return snapshot;
      }
    },
    async reserve(candidate) {
      try {
        return parseReservation(await requestAdapter("reserve", candidate), candidate);
      } catch (firstError) {
        if (!isCompleteCurrentSourceCandidate(candidate)) {
          try {
            const cleanup = parseOutcome(await requestAdapter(
              "abort_reserve_before_callback",
              candidate,
            ));
            if (
              cleanup.classification !== "no_progress" || cleanup.madeProgress ||
              !cleanup.reasonCode.startsWith("preparation_reserve_failure_")
            ) {
              throw new SchedulerRuntimeError(
                "preparation_reserve_cleanup_contract_mismatch",
                "The scheduler preparation reserve cleanup returned an invalid terminal outcome",
              );
            }
          } catch (cleanupError) {
            throw stateAmbiguousSchedulerError(
              "preparation_reserve_cleanup_failed",
              "The scheduler could not prove that its detached preparation claim was released",
              cleanupError,
            );
          }
          throw firstError;
        }
        try {
          return parseReservation(await requestAdapter("reserve", candidate), candidate);
        } catch (retryError) {
          try {
            const cleanup = parseOutcome(await requestAdapter(
              "abort_reserve_before_callback",
              candidate,
            ));
            if (
              cleanup.classification !== "no_progress" || cleanup.madeProgress ||
              !cleanup.reasonCode.startsWith("source_reserve_failure_")
            ) {
              throw new SchedulerRuntimeError(
                "source_reserve_cleanup_contract_mismatch",
                "The scheduler reserve cleanup returned an invalid terminal outcome",
              );
            }
          } catch (cleanupError) {
            throw stateAmbiguousSchedulerError(
              "source_reserve_cleanup_failed",
              "The scheduler could not prove that its detached reserve claim was released",
              cleanupError,
            );
          }
          throw retryError;
        }
      }
    },
    async acquire(candidate, reservation) {
      let acquired: unknown;
      try {
        acquired = await requestAdapter("acquire", candidate, reservation);
      } catch (error) {
        if (
          isCompleteCurrentSourceCandidate(candidate) ||
          isAcquireBoundPreparationCandidate(candidate)
        ) {
          await abortBeforeCallback(candidate, reservation, "acquire_failed");
        }
        throw error;
      }
      if (
        isCallbackInstruction(acquired) && acquired.kind === "loopback_json" &&
        acquired.executionBoundary === "acquire_outside_fifo"
      ) {
        const dispatchStartedAt = (input.now?.() ?? new Date()).getTime();
        if (input.signal?.aborted) {
          return Object.freeze({
            kind: "reconciled_external_callback_outcome" as const,
            outcome: await abortBeforeCallback(
              candidate,
              reservation,
              "acquire_failed",
              await hashCanonicalJson(acquired),
            ),
          } satisfies ReconciledExternalCallbackOutcome);
        }
        let receipt: SchedulerCallbackReceipt;
        try {
          receipt = await executeCallbackInstruction({
            baseUrl: input.baseUrl,
            request: input.request,
            instruction: acquired,
            signal: input.signal,
            ...(callbackRequiresSchedulerAuthorization(candidate, acquired)
              ? { headers: schedulerAuthorizationHeaders() }
              : {}),
          });
        } catch {
          return Object.freeze({
            kind: "reconciled_external_callback_outcome" as const,
            outcome: await reconcileAfterCallbackDispatch(
              candidate,
              reservation,
              acquired,
              dispatchStartedAt,
            ),
          } satisfies ReconciledExternalCallbackOutcome);
        }
        const externalReceipt = Object.freeze({
          kind: "external_acquisition_receipt" as const,
          instruction: acquired,
          receipt,
        } satisfies SchedulerExternalAcquisitionReceipt);
        if (candidate.kind === "preparation") {
          acquireBoundCallbackReceipts.set(reservation.reservationId, Object.freeze({
            candidateId: candidate.id,
            acquired: externalReceipt,
            acquiredIdentity: await hashCanonicalJson(externalReceipt),
          }));
        }
        return externalReceipt;
      }
      return acquired;
    },
    async validate(candidate, reservation, acquired) {
      if (isReconciledExternalCallbackOutcome(acquired)) {
        reconciledExternalOutcomes.set(reservation.reservationId, acquired.outcome);
        return Object.freeze({
          reservationId: reservation.reservationId,
          bundleIdentity: await hashCanonicalJson({
            reservationId: reservation.reservationId,
            outcome: acquired.outcome,
          }),
          responseHash: await hashCanonicalJson(acquired.outcome),
          contentHash: await hashCanonicalJson(acquired.outcome),
          validated: true,
          acquiredBundle: null,
          callback: Object.freeze({ kind: "local_commit" as const }),
        });
      }
      const acquireBoundReceipt = acquireBoundCallbackReceipts.get(
        reservation.reservationId,
      );
      let acquiredForValidation = acquired;
      if (acquireBoundReceipt !== undefined) {
        if (
          candidate.kind !== "preparation" ||
          acquireBoundReceipt.candidateId !== candidate.id ||
          !isExternalAcquisitionReceipt(acquired) ||
          await hashCanonicalJson(acquired) !== acquireBoundReceipt.acquiredIdentity
        ) {
          throw stateAmbiguousSchedulerError(
            "scheduler_external_acquisition_receipt_changed",
            "The acquire-bound callback receipt changed before validation",
            acquired,
          );
        }
        acquiredForValidation = acquireBoundReceipt.acquired.instruction;
      }
      let validationError: unknown = null;
      const maxValidationAttempts = acquireBoundReceipt === undefined ? 1 : 2;
      for (let attempt = 0; attempt < maxValidationAttempts; attempt += 1) {
        try {
          return parseBundle(
            await requestAdapter("validate", candidate, reservation, acquiredForValidation),
            reservation,
          );
        } catch (error) {
          validationError = error;
          if (!isTransientAdapterFailure(error)) break;
        }
      }
      if (
        acquireBoundReceipt !== undefined &&
        isTransientAdapterFailure(validationError)
      ) {
        return validateAcquireBoundPreparationInstruction(
          candidate,
          reservation,
          acquireBoundReceipt.acquired.instruction,
        );
      }
      {
        const error = validationError;
        if (isCompleteCurrentSourceCandidate(candidate)) {
          await abortBeforeCallback(candidate, reservation, "validate_failed");
        }
        if (acquireBoundReceipt !== undefined) {
          throw stateAmbiguousSchedulerError(
            "scheduler_external_acquisition_validation_ambiguous",
            "The acquire-bound callback receipt could not be validated exactly",
            error,
          );
        }
        throw error;
      }
    },
    async commit(candidate, reservation, bundle) {
      const reconciledExternalOutcome = reconciledExternalOutcomes.get(
        reservation.reservationId,
      );
      if (reconciledExternalOutcome !== undefined) {
        reconciledExternalOutcomes.delete(reservation.reservationId);
        return reconciledExternalOutcome;
      }
      const acquireBoundReceipt = acquireBoundCallbackReceipts.get(
        reservation.reservationId,
      );
      if (acquireBoundReceipt !== undefined) {
        if (
          acquireBoundReceipt.candidateId !== candidate.id ||
          await hashCanonicalJson(acquireBoundReceipt.acquired) !==
            acquireBoundReceipt.acquiredIdentity ||
          await hashCanonicalJson(acquireBoundReceipt.acquired.receipt.body) !==
            acquireBoundReceipt.acquired.receipt.responseHash ||
          await hashCanonicalJson(bundle.callback) !==
            await hashCanonicalJson(acquireBoundReceipt.acquired.instruction)
        ) {
          throw stateAmbiguousSchedulerError(
            "scheduler_external_acquisition_receipt_changed",
            "The acquire-bound callback identity changed before commit",
            bundle,
          );
        }
        let finalized: ReturnType<typeof parseCommitResult> | null = null;
        let finalizationError: unknown = null;
        for (let attempt = 0; attempt < 2 && finalized === null; attempt += 1) {
          if (
            await hashCanonicalJson(acquireBoundReceipt.acquired) !==
              acquireBoundReceipt.acquiredIdentity ||
            await hashCanonicalJson(acquireBoundReceipt.acquired.receipt.body) !==
              acquireBoundReceipt.acquired.receipt.responseHash
          ) {
            throw stateAmbiguousSchedulerError(
              "scheduler_external_acquisition_receipt_changed",
              "The acquire-bound callback receipt changed before finalization",
              acquireBoundReceipt.acquired,
            );
          }
          try {
            finalized = parseCommitResult(await requestAdapter(
              "commit",
              candidate,
              reservation,
              undefined,
              bundle,
              acquireBoundReceipt.acquired.receipt,
            ));
          } catch (error) {
            finalizationError = error;
          }
        }
        if (finalized === null || finalized.kind !== "outcome") {
          throw stateAmbiguousSchedulerError(
            "scheduler_external_callback_commit_ambiguous",
            "The acquire-bound callback receipt could not be finalized exactly",
            finalizationError ?? finalized,
          );
        }
        acquireBoundCallbackReceipts.delete(reservation.reservationId);
        return finalized.outcome;
      }
      let prepared: ReturnType<typeof parseCommitResult>;
      try {
        prepared = parseCommitResult(
          await requestAdapter("commit", candidate, reservation, undefined, bundle),
        );
        if (
          prepared.kind === "callback_required" &&
          await hashCanonicalJson(prepared.instruction) !==
            await hashCanonicalJson(bundle.callback)
        ) {
          throw new SchedulerRuntimeError(
            "scheduler_adapter_callback_identity_changed",
            "The scheduler callback identity changed before dispatch",
          );
        }
      } catch (error) {
        if (isCompleteCurrentSourceCandidate(candidate)) {
          return abortBeforeCallback(
            candidate,
            reservation,
            "commit_prepare_failed",
            await hashCanonicalJson(bundle.callback),
          );
        }
        throw error;
      }
      if (prepared.kind === "outcome") {
        return prepared.outcome;
      }
      if (input.signal?.aborted) {
        return abortBeforeCallback(
          candidate,
          reservation,
          "commit_prepare_failed",
          await hashCanonicalJson(prepared.instruction),
        );
      }
      const dispatchStartedAt = (input.now?.() ?? new Date()).getTime();
      let receipt: SchedulerCallbackReceipt;
      try {
        receipt = await executeCallbackInstruction({
          baseUrl: input.baseUrl,
          request: input.request,
          instruction: prepared.instruction,
          signal: input.signal,
          ...(callbackRequiresSchedulerAuthorization(candidate, prepared.instruction)
            ? { headers: schedulerAuthorizationHeaders() }
            : {}),
        });
      } catch {
        return reconcileAfterCallbackDispatch(
          candidate,
          reservation,
          prepared.instruction,
          dispatchStartedAt,
        );
      }
      const proximityProgress = candidate.stage === "proximity"
        ? parseProximityCallbackProgress(receipt.body)
        : null;
      const primaryImageSession = candidate.stage === "primary_image" &&
          prepared.instruction.successContract === "primary_image_session"
        ? parsePrimaryImageCallbackSession(receipt.body, candidate.sourceId)
        : null;
      let finalized: ReturnType<typeof parseCommitResult> | null = null;
      for (let attempt = 0; attempt < 2 && finalized === null; attempt += 1) {
        try {
          finalized = parseCommitResult(await requestAdapter(
            "commit",
            candidate,
            reservation,
            undefined,
            bundle,
            receipt,
          ));
        } catch {
          // The exact receipt and reservation make this retry idempotent. If
          // both response attempts are lost, durable reconciliation decides
          // the terminal boundary without redispatching the callback.
        }
      }
      if (finalized === null || finalized.kind !== "outcome") {
        const reconciled = await reconcileAfterCallbackDispatch(
          candidate,
          reservation,
          prepared.instruction,
          dispatchStartedAt,
          receipt,
        );
        return attachPrimaryImageSession(
          attachProximityProgress(reconciled, proximityProgress),
          primaryImageSession,
        );
      }
      return attachPrimaryImageSession(
        attachProximityProgress(finalized.outcome, proximityProgress),
        primaryImageSession,
      );
    },
    async recordExecutionEvidence(evidence, completedAt) {
      const response = await input.request({
        method: "POST",
        url: endpoint,
        body: Object.freeze({
          schemaVersion: NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION,
          action: "record_execution_evidence" satisfies SchedulerAdapterAction,
          executionEvidence: evidence,
          invocationIdentityHash: await hashCanonicalJson(campaignId),
          completedAt,
        }),
        timeoutMs: ADAPTER_REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_LOCAL_JSON_BYTES,
        headers: schedulerAuthorizationHeaders(),
      });
      assertAdapterStatus(response, "record_execution_evidence");
      if (
        !isRecord(response.body) ||
        response.body.schemaVersion !== NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION ||
        !isRecord(response.body.result) ||
        !isRecord(response.body.result.unifiedSourceScheduler) ||
        !isRecord(response.body.result.preparationScheduler)
      ) {
        throw new SchedulerRuntimeError(
          "scheduler_adapter_contract_mismatch",
          "The nightly scheduler adapter returned invalid execution receipts",
        );
      }
    },
    async transitionToPreparation(
      sourceOutcomes: readonly SchedulerSourceCampaignOutcome[],
    ) {
      if (
        authorizationToken === null || !includeSourceAcquisitions ||
        transitionedToPreparation
      ) {
        throw new SchedulerRuntimeError(
          "scheduler_preparation_transition_invalid",
          "The scheduler preparation transition is unavailable",
        );
      }
      let transitionError: unknown = null;
      try {
        const response = await input.request({
          method: "POST",
          url: endpoint,
          body: Object.freeze({
            schemaVersion: NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION,
            action: "transition_to_preparation" satisfies SchedulerAdapterAction,
            sourceOutcomes,
          }),
          timeoutMs: ADAPTER_REQUEST_TIMEOUT_MS,
          maxResponseBytes: MAX_LOCAL_JSON_BYTES,
          headers: schedulerAuthorizationHeaders(),
        });
        assertAdapterStatus(response, "transition_to_preparation");
        if (
          !isRecord(response.body) ||
          response.body.schemaVersion !== NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION ||
          !isRecord(response.body.result) || response.body.result.transitioned !== true ||
          response.body.result.sourceOutcomeCount !== sourceOutcomes.length
        ) {
          throw new SchedulerRuntimeError(
            "scheduler_preparation_transition_contract_mismatch",
            "The scheduler preparation transition response was invalid",
          );
        }
      } catch (error) {
        transitionError = error;
      }
      if (transitionError !== null) {
        const probeUrl = new URL(endpoint);
        probeUrl.searchParams.set("limit", String(snapshotLimit));
        probeUrl.searchParams.set("campaignId", campaignId);
        probeUrl.searchParams.set(
          "coverageMode",
          input.forceCompleteCurrent === true
            ? "complete_current"
            : "auto",
        );
        probeUrl.searchParams.set("includeSourceAcquisitions", "false");
        probeUrl.searchParams.set("preparationScope", preparationScope);
        const probe = await input.request({
          method: "GET",
          url: probeUrl.toString(),
          timeoutMs: ADAPTER_REQUEST_TIMEOUT_MS,
          maxResponseBytes: MAX_LOCAL_JSON_BYTES,
          headers: schedulerAuthorizationHeaders(),
        });
        if (probe.status < 200 || probe.status >= 300) throw transitionError;
        const snapshot = parseAdapterSnapshot(
          probe.body,
          snapshotLimit,
          preparationScope,
        );
        if (parseAdapterAuthorizationToken(probe.body) !== authorizationToken) {
          throw transitionError;
        }
        prefetchedPreparationSnapshot = snapshot;
      }
      includeSourceAcquisitions = false;
      transitionedToPreparation = true;
    },
    setPreparationScope(scope) {
      if (!transitionedToPreparation || includeSourceAcquisitions) {
        throw new SchedulerRuntimeError(
          "scheduler_preparation_scope_invalid",
          "The scheduler cannot select a preparation scope before transition",
        );
      }
      preparationScope = scope;
      prefetchedPreparationSnapshot = null;
    },
  };
  return Object.freeze(adapter);
}

export async function runNightlySchedulerCli(
  args: readonly string[],
  dependencies: NightlySchedulerCliDependencies = {},
): Promise<{ readonly exitCode: number; readonly output: object }> {
  const options = parseNightlySchedulerArgs(args);
  if (!options.readinessOnly && options.runtimeRevision === null) {
    throw new RangeError(
      "--runtime-revision is required for every mutating nightly scheduler invocation",
    );
  }
  if (!options.readinessOnly && options.deadlineAtMs === null) {
    throw new RangeError(
      "--workflow-deadline-at is required for every mutating nightly scheduler invocation",
    );
  }
  const baseRequest = dependencies.request ?? requestLocalJson;
  const environment = dependencies.environment ?? process.env;
  const campaignId = options.performance === null
    ? null
    : `performance-${Date.now().toString(36)}-${randomUUID()}`;
  const telemetrySession = options.performance === null
    ? null
    : new PerformanceTelemetrySession({
        destinationPath: options.performance.destinationPath,
        now: dependencies.now,
      });
  const telemetry: PerformanceTelemetrySink | undefined = telemetrySession === null
    ? undefined
    : Object.freeze({ record: telemetrySession.record.bind(telemetrySession) });
  const revisionBoundRequest = options.runtimeRevision === null
    ? baseRequest
    : (request: NightlySchedulerRequest) => baseRequest(Object.freeze({
        ...request,
        headers: Object.freeze({
          ...(request.headers ?? {}),
          [RUNTIME_REVISION_HEADER]: options.runtimeRevision!,
        }),
      }));
  const request = telemetry === undefined
    ? revisionBoundRequest
    : createPerformanceTelemetryRequest(revisionBoundRequest, telemetry, campaignId!);
  telemetry?.record({
    context: campaignId === null ? undefined : { campaignId },
    details: {
      kind: "stage",
      stage: "process_launch",
      outcome: "completed",
      reasonCode: "nightly_scheduler_cli",
    },
  });
  const forceCanonical = strictBoolean(environment.PERF_FORCE_CANONICAL);
  if (options.readinessOnly) {
    const readiness = readNightlySchedulerReadiness(options, { environment });
    return {
      exitCode: readiness.ready ? 0 : 3,
      output: cliOutput({
        workflowDeadlineAt: options.workflowDeadlineAt,
        readiness,
        classification: readiness.ready ? "ready" : "handler_not_ready",
        result: null,
      }),
    };
  }

  let optimizedSnapshot: SchedulerSnapshot | null = null;
  let adapter: ScopedNightlySchedulerRuntimeAdapter | null = null;
  const optimizedRequired = options.existingCatalogOnly ||
    options.mode === "optimized" || options.mode === "auto";
  const tryOptimized = optimizedRequired;
  if (tryOptimized && !forceCanonical) {
    adapter = createHttpSchedulerRuntimeAdapter({
      baseUrl: options.baseUrl,
      maxDispatches: options.maxDispatches,
      request,
      forceCompleteCurrent: !options.existingCatalogOnly,
      includeSourceAcquisitions: !options.existingCatalogOnly,
      initialPreparationScope: options.existingCatalogMaintenanceOnly
        ? "maintenance"
        : options.existingCatalogOnly
        ? "core"
        : undefined,
      deadlineAtMs: options.deadlineAtMs ?? undefined,
      now: dependencies.now,
      sleep: dependencies.sleep,
      signal: dependencies.signal,
    });
    let optimizedError: unknown = null;
    try {
      optimizedSnapshot = await adapter.readSnapshot();
    } catch (error) {
      if (
        error instanceof SchedulerAdapterUnavailableError &&
        error.transientHttpStatus !== null &&
        workflowDeadlineAdmits(
          options.deadlineAtMs!,
          DIRECT_SOURCE_MINIMUM_SETTLEMENT_RESERVE_MS +
            OPTIMIZED_READINESS_RETRY_DELAY_MS,
          dependencies.now,
        )
      ) {
        await (dependencies.sleep ?? sleep)(OPTIMIZED_READINESS_RETRY_DELAY_MS);
        try {
          optimizedSnapshot = await adapter.readSnapshot();
        } catch (retryError) {
          optimizedError = retryError;
        }
      } else {
        optimizedError = error;
      }
    }
    if (optimizedError !== null) {
      const error = optimizedError;
      if (optimizedRequired || !(error instanceof SchedulerAdapterUnavailableError)) {
        const readiness = readNightlySchedulerReadiness(options, {
          optimizedEndpointAvailable: false,
          environment,
        });
        return {
          exitCode: 3,
          output: cliOutput({
            workflowDeadlineAt: options.workflowDeadlineAt,
            readiness,
            classification: error instanceof SchedulerAdapterUnavailableError
              ? "handler_not_ready"
              : "handler_failure_prior_head_preserved",
            result: null,
          }),
        };
      }
      adapter = null;
    }
  }

  const readiness = readNightlySchedulerReadiness(options, {
    optimizedEndpointAvailable: adapter !== null,
    sourceCount: optimizedSnapshot?.remainingWork?.sourceAcquisitions,
    environment,
  });
  if (!readiness.ready) {
    return {
      exitCode: 3,
      output: cliOutput({
        workflowDeadlineAt: options.workflowDeadlineAt,
        readiness,
        classification: "handler_not_ready",
        result: null,
      }),
    };
  }
  const progressObservation = createCliProgressObservation({
    sink: dependencies.progressSink,
    now: dependencies.now,
    intervalMs: dependencies.progressHeartbeatIntervalMs,
  });
  const observedProgressSink = dependencies.progressSink === undefined
    ? undefined
    : progressObservation.observe;
  try {
  let result: SchedulerRunResult;
  try {
    if (adapter === null) throw new SchedulerRuntimeError(
      "scheduler_adapter_unavailable", "The generic scheduler adapter is required");
    result = await runAdapterScheduler({
          options,
          adapter,
          initialSnapshot: optimizedSnapshot!,
          workflowDeadlineAt: options.workflowDeadlineAt!,
          deadlineAtMs: options.deadlineAtMs!,
          telemetry,
          campaignId,
          onProgress: observedProgressSink,
          now: dependencies.now,
          sleep: dependencies.sleep,
          signal: dependencies.signal,
        });
  } catch (error) {
    if (
      adapter !== null && error instanceof SchedulerRuntimeError &&
      (
        error.reasonCode === "scheduler_adapter_snapshot_failed" ||
        error.reasonCode === "scheduler_adapter_snapshot_recovery_exhausted"
      )
    ) {
      // Snapshot reads are mutation-free. If the bounded same-campaign
      // recovery window expires, return a typed prior-head-preserved boundary
      // so the outer durable workflow can make its one finite fresh-process
      // retry instead of losing the whole unattended invocation to stderr.
      return {
        exitCode: 3,
        output: cliOutput({
          workflowDeadlineAt: options.workflowDeadlineAt,
          readiness,
          classification: "handler_failure_prior_head_preserved",
          result: null,
        }),
      };
    }
    throw error;
  }
  if (adapter !== null) {
    try {
      await adapter.recordExecutionEvidence(
        result.executionEvidence,
        (dependencies.now?.() ?? new Date()).toISOString(),
      );
    } catch (error) {
      // Execution evidence is append-only observability. Once the exact
      // scheduler result is already state-ambiguous, a second unavailable D1
      // write must not erase that classification or its complete source vector.
      if (result.classification !== "handler_failure_state_ambiguous") throw error;
    }
  }
  let performanceTelemetry: Readonly<{
    receipt: PerformanceTelemetrySessionReceipt;
  }> | null = null;
  if (telemetrySession !== null) {
    if (!successfulTerminal(result.classification)) {
      throw new SchedulerRuntimeError(
        "performance_campaign_not_terminal",
        "Performance telemetry is flushed only after a terminal durable scheduler boundary",
      );
    }
    recordCurrentSourceCoverage({
      telemetry: telemetry!,
      campaignId: campaignId!,
      options,
      selectedMode: readiness.selectedMode,
    });
    const receipt = await telemetrySession.flush();
    performanceTelemetry = Object.freeze({ receipt });
  }
  return {
    exitCode: successfulTerminal(result.classification) ? 0 : 2,
    output: cliOutput({
      workflowDeadlineAt: options.workflowDeadlineAt,
      readiness,
      classification: result.classification,
      result,
      performanceTelemetry,
    }),
  };
  } finally {
    progressObservation.stop();
  }
}

function createCliProgressObservation(input: {
  readonly sink?: (event: SchedulerProgressEvent) => void;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}): Readonly<{
  observe: (event: SchedulerProgressEvent) => void;
  stop: () => void;
}> {
  const intervalMs = input.intervalMs ?? CLI_PROGRESS_OBSERVATION_CADENCE_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new RangeError("nightly scheduler progress heartbeat interval must be positive");
  }
  let active = true;
  let latest: SchedulerProgressEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report = (event: SchedulerProgressEvent): void => {
    try {
      input.sink?.(event);
    } catch {
      // Status reporting is fail-soft and cannot change scheduler execution.
    }
  };
  const schedule = (): void => {
    if (!active || latest === null || input.sink === undefined) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!active || latest === null) return;
      let observedAt: string;
      try {
        observedAt = (input.now?.() ?? new Date()).toISOString();
      } catch {
        schedule();
        return;
      }
      latest = Object.freeze({ ...latest, observedAt });
      report(latest);
      schedule();
    }, intervalMs);
  };
  return Object.freeze({
    observe(event) {
      if (!active) return;
      latest = event;
      report(event);
      schedule();
    },
    stop() {
      active = false;
      latest = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  });
}

/**
 * Pure continuation policy for preparation-only optimized quanta. Durable
 * preparation advancement resets only the matching tail signature; source
 * progress cannot appear in preparationProgressCandidateIds and therefore
 * cannot refill this allowance.
 */
export function decideOptimizedPreparationContinuation(input: {
  readonly result: SchedulerRunResult;
  readonly state: OptimizedPreparationContinuationState;
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly minimumSettlementReserveMs?: number;
}): OptimizedPreparationContinuationDecision {
  if (!Number.isFinite(input.nowMs) || !Number.isFinite(input.deadlineMs)) {
    throw new RangeError("optimized preparation continuation requires finite timestamps");
  }
  const minimumSettlementReserveMs = input.minimumSettlementReserveMs ?? 0;
  if (
    !Number.isSafeInteger(minimumSettlementReserveMs) ||
    minimumSettlementReserveMs < 0
  ) {
    throw new RangeError(
      "optimized preparation continuation requires a nonnegative settlement reserve",
    );
  }
  const deadlineReasonCode = minimumSettlementReserveMs === 0
    ? "optimized_preparation_continuation_deadline_exhausted"
    : WORKFLOW_DEADLINE_SETTLEMENT_RESERVE_EXHAUSTED;
  const semanticNoProgressIdentities = [
    ...new Set(input.result.preparationNoProgressIdentities),
  ].sort();
  const signature = semanticNoProgressIdentities.length > 0
    ? JSON.stringify(["semantic_no_progress", semanticNoProgressIdentities])
    : JSON.stringify([
        input.result.classification,
        [...new Set(input.result.tailReasonCodes)].sort(),
        [...new Set(input.result.tailCandidateIds)].sort(),
      ]);
  const stateSignatures = new Set(input.state.retriedNoProgressSignatures);
  const progressed = input.result.preparationProgressCandidateIds.length > 0;
  const nextState = (): OptimizedPreparationContinuationState => Object.freeze({
    retriedNoProgressSignatures: Object.freeze([...stateSignatures].sort()),
  });
  const stop = (
    terminalReasonCode: string | null,
  ): OptimizedPreparationContinuationDecision => Object.freeze({
    continue: false as const,
    terminalReasonCode,
    signature,
    state: nextState(),
  });
  const proceed = (delayMs: number): OptimizedPreparationContinuationDecision =>
    Object.freeze({
      continue: true as const,
      delayMs,
      signature,
      state: nextState(),
    });

  if (
    input.result.classification === "clean_empty" ||
    input.result.classification === "checkpoint_paused" ||
    input.result.classification === "core_complete_maintenance_deferred" ||
    input.result.classification === "deterministic_terminal" ||
    input.result.classification === "access_stop" ||
    input.result.classification === "no_progress" ||
    input.result.classification === "handler_failure_state_ambiguous"
  ) return stop(null);

  if (input.result.classification === "bounded_quantum_exhausted") {
    if (!progressed) {
      return stop("optimized_bounded_quantum_without_preparation_progress");
    }
    stateSignatures.delete(signature);
    if (input.nowMs + minimumSettlementReserveMs > input.deadlineMs) {
      return stop(deadlineReasonCode);
    }
    return proceed(0);
  }

  if (
    input.result.classification !== "future_deferred" &&
    input.result.classification !== "retryable_pressure" &&
    input.result.classification !== "handler_not_ready" &&
    input.result.classification !== "handler_failure_prior_head_preserved"
  ) return stop("optimized_preparation_continuation_unsupported");

  if (semanticNoProgressIdentities.length > 0) {
    // Remember a durable no-progress boundary even when unrelated preparation
    // work advanced in the same batch. Once that independent work drains, a
    // repeated semantic boundary must stop instead of being perpetually reset.
    if (!progressed && stateSignatures.has(signature)) {
      return stop("optimized_same_signature_no_progress_retry_exhausted");
    }
    stateSignatures.add(signature);
  } else if (progressed) {
    stateSignatures.delete(signature);
  } else if (stateSignatures.has(signature)) {
    return stop("optimized_same_signature_no_progress_retry_exhausted");
  } else {
    stateSignatures.add(signature);
  }

  let retryAtMs: number;
  if (
    input.result.classification === "future_deferred" ||
    input.result.classification === "retryable_pressure"
  ) {
    retryAtMs = input.result.earliestAvailableAt === null
      ? Number.NaN
      : Date.parse(input.result.earliestAvailableAt);
    if (!Number.isFinite(retryAtMs)) {
      return stop("optimized_preparation_retry_boundary_missing");
    }
  } else {
    retryAtMs = input.nowMs + (
      input.result.classification === "handler_not_ready"
        ? OPTIMIZED_HANDLER_NOT_READY_BACKOFF_MS
        : OPTIMIZED_PRIOR_HEAD_PRESERVED_BACKOFF_MS
    );
  }
  if (
    input.nowMs + minimumSettlementReserveMs > input.deadlineMs ||
    retryAtMs + minimumSettlementReserveMs > input.deadlineMs
  ) {
    return stop(deadlineReasonCode);
  }
  return proceed(Math.max(0, retryAtMs - input.nowMs));
}

export function terminalizeOptimizedPreparationResult(
  result: SchedulerRunResult,
  reasonCode: string,
  hasPriorPreparationProgress = false,
  nowMs?: number,
): SchedulerRunResult {
  const checkpointPaused = (
    reasonCode === "optimized_preparation_continuation_deadline_exhausted" ||
    reasonCode === "workflow_deadline_settlement_reserve_exhausted"
  ) &&
    (
      result.preparationProgressCandidateIds.length > 0 ||
      hasPriorPreparationProgress
    );
  const retainedRetryBoundary =
    reasonCode === "optimized_same_signature_no_progress_retry_exhausted" &&
    result.preparationNoProgressIdentities.length > 0
      ? exactGenericMaintenanceRetryBoundary(result.earliestAvailableAt, nowMs)
      : null;
  return Object.freeze({
    ...result,
    classification: checkpointPaused
      ? "checkpoint_paused" as const
      : "no_progress" as const,
    earliestAvailableAt: retainedRetryBoundary,
    tailReasonCodes: Object.freeze([
      ...new Set([...result.tailReasonCodes, reasonCode]),
    ].sort()),
  });
}

function exactGenericMaintenanceRetryBoundary(
  durableBoundary: string | null,
  nowMs: number | undefined,
): string | null {
  if (durableBoundary === null) return null;
  const durableBoundaryMs = Date.parse(durableBoundary);
  if (
    !Number.isFinite(durableBoundaryMs) ||
    new Date(durableBoundaryMs).toISOString() !== durableBoundary
  ) return null;
  if (nowMs === undefined) return durableBoundary;
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("generic maintenance retry requires a finite timestamp");
  }
  return new Date(Math.max(
    nowMs + OPTIMIZED_GENERIC_MAINTENANCE_RETRY_BACKOFF_MS,
    durableBoundaryMs,
  )).toISOString();
}

async function runAdapterScheduler(input: {
  readonly options: NightlySchedulerCliOptions;
  readonly adapter: ScopedNightlySchedulerRuntimeAdapter;
  readonly initialSnapshot: SchedulerSnapshot;
  /** Exact CLI text retained for the whole one-process invocation. */
  readonly workflowDeadlineAt: string;
  /** Absolute invocation deadline; source and both preparation scopes share it. */
  readonly deadlineAtMs: number;
  readonly telemetry?: PerformanceTelemetrySink;
  readonly campaignId: string | null;
  readonly onProgress?: (event: SchedulerProgressEvent) => void;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<SchedulerRunResult> {
  if (absoluteWorkflowDeadline(input.workflowDeadlineAt).deadlineAtMs !== input.deadlineAtMs) {
    throw new RangeError("nightly scheduler workflow deadline identity changed");
  }
  let initial: SchedulerSnapshot | null = input.initialSnapshot;
  const initialSourceIds = new Set(input.initialSnapshot.candidates
    .filter((candidate) => candidate.kind === "source_acquisition")
    .map((candidate) => candidate.sourceId));
  const sourceCampaignPolicies = sourceOrchestrationRegistry.filter((policy) =>
    initialSourceIds.has(policy.sourceId));
  if (!input.options.existingCatalogOnly &&
      input.initialSnapshot.remainingWork?.sourceAcquisitions !== sourceCampaignPolicies.length) {
    throw new SchedulerRuntimeError("scheduler_source_population_incomplete",
      "The initial scheduler snapshot does not contain the complete enabled source population");
  }
  let sourceTerminalProgress: SchedulerProgressEvent | null = null;
  const existingCatalogPreparationScope = input.options.existingCatalogMaintenanceOnly
    ? "maintenance" as const
    : "core" as const;
  const sourcePhase = await runNightlyScheduler({
    workSource: {
      readSnapshot() {
        if (initial !== null) {
          const snapshot = initial;
          initial = null;
          return Promise.resolve(snapshot);
        }
        return input.adapter.readSnapshot();
      },
    },
    handlerRegistry: createRuntimeAdapterHandlerRegistry(input.adapter),
    options: {
      maxConcurrentNetworkJobs:
        input.options.existingCatalogOnly
          ? input.options.maxConcurrency
          : 1,
      maxDispatches: input.options.existingCatalogOnly
        ? input.options.existingCatalogMaintenanceOnly
          ? MAINTENANCE_DISPATCH_QUANTUM
          : input.options.maxDispatches
        : SOURCE_CAMPAIGN_MAX_DISPATCHES,
      now: input.now,
      sleep: input.sleep,
      deadlineAtMs: input.deadlineAtMs,
      minimumSettlementReserveMs: input.options.existingCatalogMaintenanceOnly
        ? MAINTENANCE_MINIMUM_SETTLEMENT_RESERVE_MS
        : DIRECT_SOURCE_MINIMUM_SETTLEMENT_RESERVE_MS,
      minimumSettlementReserveForCandidateMs:
        input.options.existingCatalogMaintenanceOnly
          ? maintenancePreparationSettlementReserveMs
          : sourceAcquisitionSettlementReserveMs,
      onProgress: input.onProgress === undefined
        ? undefined
        : (event) => {
            const enriched = Object.freeze({ ...event, quantumAttempt: 1 });
            if (event.phase === "terminal") sourceTerminalProgress = enriched;
            else input.onProgress!(enriched);
          },
      ...(input.options.existingCatalogOnly ? {
        preparationScope: existingCatalogPreparationScope,
      } : {
        sourceCampaignPolicies: sourceCampaignPolicies.map((policy) => Object.freeze({
          sourceId: policy.sourceId,
          dependencies: policy.dependencies,
          terminalDependencies: policy.terminalDependencies,
        })),
      }),
    },
    telemetry: input.telemetry,
    telemetryContext: input.campaignId === null
      ? undefined
      : { campaignId: input.campaignId },
    strategy: input.options.performance?.strategy,
    signal: input.signal,
  });
  if (input.options.existingCatalogOnly) {
    const existingCatalogPhase = !input.options.existingCatalogMaintenanceOnly &&
        (sourcePhase.classification === "clean_empty" ||
          sourcePhase.classification === "deterministic_terminal") &&
        sourcePhase.coreProgress.remaining === 0 &&
        sourcePhase.maintenanceProgress.remaining > 0
      ? Object.freeze({
          ...sourcePhase,
          classification: "core_complete_maintenance_deferred" as const,
        })
      : sourcePhase;
    if (sourceTerminalProgress !== null) input.onProgress?.(sourceTerminalProgress);
    return existingCatalogPhase;
  }
  if (
    !exactTerminalSourceVector(sourcePhase.sourceOutcomes, sourceCampaignPolicies.map((policy) => policy.sourceId))
  ) {
    if (sourceTerminalProgress !== null) input.onProgress?.(sourceTerminalProgress);
    return sourcePhase;
  }
  if (input.adapter.transitionToPreparation === undefined) {
    throw new SchedulerRuntimeError(
      "scheduler_preparation_transition_unavailable",
      "The optimized scheduler cannot transition its terminal source campaign to preparation",
    );
  }
  if (!workflowDeadlineAdmits(
    input.deadlineAtMs,
    CORE_PREPARATION_MINIMUM_SETTLEMENT_RESERVE_MS,
    input.now,
  )) {
    return terminalizeWorkflowDeadlineResult(sourcePhase);
  }
  await input.adapter.transitionToPreparation(sourcePhase.sourceOutcomes);
  input.adapter.setPreparationScope("core");
  let preparationSnapshot: SchedulerSnapshot | null =
    await input.adapter.readSnapshot();
  let combinedResult = sourcePhase;
  let continuationState: OptimizedPreparationContinuationState = Object.freeze({
    retriedNoProgressSignatures: Object.freeze([]),
  });
  let preparationScope: "core" | "maintenance" = "core";
  let completedPreferenceV2MaintenanceUnits = 0;
  let quantumAttempt = 2;
  while (true) {
    const currentQuantumAttempt = quantumAttempt;
    const minimumSettlementReserveMs = preparationScope === "core"
      ? CORE_PREPARATION_MINIMUM_SETTLEMENT_RESERVE_MS
      : MAINTENANCE_MINIMUM_SETTLEMENT_RESERVE_MS;
    const preparationPhase = await runNightlyScheduler({
      workSource: {
        readSnapshot() {
          if (preparationSnapshot !== null) {
            const snapshot = preparationSnapshot;
            preparationSnapshot = null;
            return Promise.resolve(snapshot);
          }
          return input.adapter.readSnapshot();
        },
      },
      handlerRegistry: createRuntimeAdapterHandlerRegistry(input.adapter),
      options: {
        maxConcurrentNetworkJobs: input.options.maxConcurrency,
        // Re-read the required core scope after every optional maintenance
        // commit. A maintenance callback is the smallest safe preemption
        // boundary because the mutation FIFO cannot be interrupted in flight.
        maxDispatches: preparationScope === "maintenance"
          ? MAINTENANCE_DISPATCH_QUANTUM
          : input.options.maxDispatches,
        now: input.now,
        sleep: input.sleep,
        deadlineAtMs: input.deadlineAtMs,
        minimumSettlementReserveMs,
        minimumSettlementReserveForCandidateMs: preparationScope === "core"
          ? corePreparationSettlementReserveMs
          : maintenancePreparationSettlementReserveMs,
        preparationScope,
        onProgress: input.onProgress === undefined
          ? undefined
          : (event) => input.onProgress!(Object.freeze({
              ...event,
              attemptedSourceCount: sourcePhase.sourceOutcomes.length,
              terminalSourceCount: sourcePhase.sourceOutcomes.length,
              knownSourceCount: sourcePhase.sourceOutcomes.length,
              quantumAttempt: currentQuantumAttempt,
              sourceOutcomes: sourcePhase.sourceOutcomes,
            })),
      },
      telemetry: input.telemetry,
      telemetryContext: input.campaignId === null
        ? undefined
        : { campaignId: input.campaignId },
      strategy: input.options.performance?.strategy,
      signal: input.signal,
    });
    if (
      preparationScope === "maintenance" &&
      preparationPhase.preferenceV2Progress !== undefined
    ) {
      completedPreferenceV2MaintenanceUnits +=
        preparationPhase.preferenceV2Progress.completed;
    }
    const preferenceV2MaintenanceCapIsReached =
      preferenceV2MaintenanceCapReached(
        completedPreferenceV2MaintenanceUnits,
        preparationPhase.preferenceV2Progress?.remaining ?? 0,
      );
    if (
      preparationScope === "maintenance" &&
      preparationPhase.classification !== "handler_failure_state_ambiguous"
    ) {
      input.adapter.setPreparationScope("core");
      const readyCoreSnapshot = await input.adapter.readSnapshot();
      if (maintenanceMustYieldToCore(readyCoreSnapshot)) {
        combinedResult = combineSchedulerPhases(combinedResult, preparationPhase);
        preparationScope = "core";
        preparationSnapshot = readyCoreSnapshot;
        continuationState = Object.freeze({
          retriedNoProgressSignatures: Object.freeze([]),
        });
        quantumAttempt += 1;
        continue;
      }
      if (preferenceV2MaintenanceCapIsReached) {
        combinedResult = combineSchedulerPhases(combinedResult, preparationPhase);
        return maintenanceDeferredResult(combinedResult, true);
      }
      input.adapter.setPreparationScope("maintenance");
    }
    if (
      preparationScope === "core" &&
      (
        preparationPhase.classification === "clean_empty" ||
        preparationPhase.classification === "deterministic_terminal" ||
        preparationPhase.classification === "core_complete_maintenance_deferred"
      )
    ) {
      combinedResult = combineSchedulerPhases(combinedResult, preparationPhase);
      if (preferenceV2MaintenanceCapIsReached) {
        return maintenanceDeferredResult(combinedResult, true);
      }
      preparationScope = "maintenance";
      input.adapter.setPreparationScope("maintenance");
      continuationState = Object.freeze({
        retriedNoProgressSignatures: Object.freeze([]),
      });
      quantumAttempt += 1;
      continue;
    }
    const continuationNowMs = (input.now?.() ?? new Date()).getTime();
    const continuation = decideOptimizedPreparationContinuation({
      result: preparationPhase,
      state: continuationState,
      nowMs: continuationNowMs,
      deadlineMs: input.deadlineAtMs,
      minimumSettlementReserveMs,
    });
    const terminalPreparationPhase =
      !continuation.continue && continuation.terminalReasonCode !== null
          ? terminalizeOptimizedPreparationResult(
            preparationPhase,
            continuation.terminalReasonCode,
            combinedResult.preparationProgressCandidateIds.length > 0,
            preparationScope === "maintenance" ? continuationNowMs : undefined,
          )
        : preparationPhase;
    combinedResult = combineSchedulerPhases(
      combinedResult,
      terminalPreparationPhase,
    );
    if (!continuation.continue) {
      return preparationScope === "maintenance"
        ? maintenanceDeferredResult(combinedResult)
        : combinedResult;
    }
    continuationState = continuation.state;
    if (continuation.delayMs > 0) {
      await (input.sleep ?? sleep)(continuation.delayMs);
    }
    quantumAttempt += 1;
  }
}

function exactTerminalSourceVector(
  outcomes: readonly SchedulerSourceCampaignOutcome[],
  sourceIds: readonly string[],
): boolean {
  return outcomes.length === sourceIds.length &&
    outcomes.every((outcome, index) =>
      outcome.sourceId === sourceIds[index] &&
      outcome.reasonCode !== "campaign_terminal_boundary_missing" &&
      outcome.reasonCode !== "campaign_state_ambiguous_unassessed"
    );
}

function workflowDeadlineAdmits(
  deadlineAtMs: number,
  minimumSettlementReserveMs: number,
  now?: () => Date,
): boolean {
  const currentMs = (now?.() ?? new Date()).getTime();
  if (!Number.isFinite(currentMs)) {
    throw new RangeError("nightly scheduler clock returned an invalid timestamp");
  }
  return currentMs + minimumSettlementReserveMs <= deadlineAtMs;
}

/**
 * Proximity retains its full server-side settlement guard. Other core work
 * uses the bounded local callback guard.
 */
export function corePreparationSettlementReserveMs(
  candidate: Pick<SchedulerCandidate, "sourceId" | "stage">,
): number {
  return candidate.stage === "proximity"
    ? SOURCE_MINIMUM_SETTLEMENT_RESERVE_MS
    : CORE_PREPARATION_MINIMUM_SETTLEMENT_RESERVE_MS;
}

/**
 * Maintenance callbacks have different settlement contracts. Text enrichment
 * keeps its bounded guard; frozen scoring is deliberately a
 * short checkpointed companion session; source release is a local commit.
 */
export function maintenancePreparationSettlementReserveMs(
  candidate: Pick<SchedulerCandidate, "stage">,
): number {
  if (
    candidate.stage === "enrichment_text" ||
    candidate.stage === "enrichment_embedding"
  ) {
    return ENRICHMENT_CALLBACK_TIMEOUT_MS +
      CORE_PREPARATION_MINIMUM_SETTLEMENT_RESERVE_MS;
  }
  if (candidate.stage === "preference_v2_score") {
    return PREFERENCE_V2_MINIMUM_SETTLEMENT_RESERVE_MS;
  }
  return MAINTENANCE_MINIMUM_SETTLEMENT_RESERVE_MS;
}

/** A core-scoped snapshot with ready work always preempts optional maintenance. */
export function maintenanceMustYieldToCore(snapshot: SchedulerSnapshot): boolean {
  return (snapshot.remainingWork?.coreReady ?? 0) > 0;
}

export function sourceAcquisitionSettlementReserveMs(
  candidate: Pick<SchedulerCandidate, "sourceId" | "kind">,
): number {
  if (candidate.kind !== "source_acquisition") {
    return DIRECT_SOURCE_MINIMUM_SETTLEMENT_RESERVE_MS;
  }
  const policy = sourceOrchestrationRegistry.find((entry) =>
    entry.sourceId === candidate.sourceId
  );
  return policy?.campaignAcquisition === "local_companion"
    ? SOURCE_MINIMUM_SETTLEMENT_RESERVE_MS
    : DIRECT_SOURCE_MINIMUM_SETTLEMENT_RESERVE_MS;
}

function terminalizeWorkflowDeadlineResult(
  result: SchedulerRunResult,
): SchedulerRunResult {
  return Object.freeze({
    ...result,
    classification: "checkpoint_paused" as const,
    earliestAvailableAt: null,
    tailReasonCodes: Object.freeze([
      ...new Set([
        ...result.tailReasonCodes,
        WORKFLOW_DEADLINE_SETTLEMENT_RESERVE_EXHAUSTED,
      ]),
    ].sort()),
  });
}

function maintenanceDeferredResult(
  result: SchedulerRunResult,
  knownRemainingMaintenance = false,
): SchedulerRunResult {
  if (
    (!knownRemainingMaintenance &&
      (
        result.classification === "clean_empty" ||
        result.classification === "deterministic_terminal"
      )) ||
    result.classification === "handler_failure_state_ambiguous"
  ) return result;
  return Object.freeze({
    ...result,
    classification: "core_complete_maintenance_deferred" as const,
    earliestAvailableAt:
      result.tailReasonCodes.includes(
        "optimized_same_signature_no_progress_retry_exhausted",
      ) && result.preparationNoProgressIdentities.length > 0
        ? result.earliestAvailableAt
        : null,
    tailReasonCodes: Object.freeze([
      ...new Set([
        ...result.tailReasonCodes,
        `maintenance_deferred:${result.classification}`,
      ]),
    ].sort()),
  });
}

function combineSchedulerPhases(
  source: SchedulerRunResult,
  preparation: SchedulerRunResult,
): SchedulerRunResult {
  const decisions = Object.freeze([
    ...source.decisions,
    ...preparation.decisions.map((decision, index) => Object.freeze({
      ...decision,
      sequence: source.decisions.length + index + 1,
    })),
  ]);
  const preferenceV2ScorerError = combinedPreferenceV2ScorerError(
    source,
    preparation,
  );
  return Object.freeze({
    ...preparation,
    classification:
      preparation.classification === "clean_empty" &&
        (
          source.classification === "deterministic_terminal" ||
          source.sourceOutcomes.some(({ outcome }) => outcome !== "refreshed")
        )
        ? "deterministic_terminal" as const
        : preparation.classification,
    dispatched: source.dispatched + preparation.dispatched,
    completed: source.completed + preparation.completed,
    deterministicTerminals:
      source.deterministicTerminals + preparation.deterministicTerminals,
    sourceRequests: source.sourceRequests + preparation.sourceRequests,
    boundedReads: source.boundedReads + preparation.boundedReads,
    mutationOrder: Object.freeze([
      ...source.mutationOrder,
      ...preparation.mutationOrder,
    ]),
    tailReasonCodes: Object.freeze([
      ...new Set([...source.tailReasonCodes, ...preparation.tailReasonCodes]),
    ].sort()),
    decisions,
    timingObservations: Object.freeze([
      ...source.timingObservations,
      ...preparation.timingObservations,
    ]),
    writerOccupancyMs:
      source.writerOccupancyMs + preparation.writerOccupancyMs,
    maxConcurrentValidations: Math.max(
      source.maxConcurrentValidations,
      preparation.maxConcurrentValidations,
    ),
    maxConcurrentCommits: Math.max(
      source.maxConcurrentCommits,
      preparation.maxConcurrentCommits,
    ),
    preparationProgressCandidateIds: Object.freeze([
      ...new Set([
        ...source.preparationProgressCandidateIds,
        ...preparation.preparationProgressCandidateIds,
      ]),
    ].sort()),
    preparationNoProgressIdentities: Object.freeze([
      ...new Set([
        ...source.preparationNoProgressIdentities,
        ...preparation.preparationNoProgressIdentities,
      ]),
    ].sort()),
    proximityProgress: mergeProximityProgress(
      source.proximityProgress,
      preparation.proximityProgress,
    ),
    ...(preparation.preferenceV2Progress !== undefined
      ? { preferenceV2Progress: preparation.preferenceV2Progress }
      : source.preferenceV2Progress === undefined
        ? {}
        : { preferenceV2Progress: source.preferenceV2Progress }),
    ...(preparation.preferenceV2SessionDiagnostics !== undefined
      ? { preferenceV2SessionDiagnostics: preparation.preferenceV2SessionDiagnostics }
      : source.preferenceV2SessionDiagnostics === undefined
        ? {}
        : { preferenceV2SessionDiagnostics: source.preferenceV2SessionDiagnostics }),
    ...(preferenceV2ScorerError === undefined
      ? {}
      : { preferenceV2ScorerError }),
    sourceOutcomes: source.sourceOutcomes,
    executionEvidence: Object.freeze({
      schemaVersion: "auction-discovery-scheduler-execution-evidence-v2" as const,
      unifiedSourceScheduler:
        source.executionEvidence.unifiedSourceScheduler,
      preparationScheduler:
        preparation.executionEvidence.preparationScheduler,
    }),
  });
}

export function combinedPreferenceV2ScorerError(
  earlier: Readonly<{
    readonly preferenceV2ScorerError?: PreferenceV2ScorerErrorEnvelope;
  }>,
  later: Readonly<{
    readonly preferenceV2ScorerError?: PreferenceV2ScorerErrorEnvelope;
    readonly preferenceV2Progress?: unknown;
  }>,
): PreferenceV2ScorerErrorEnvelope | undefined {
  if (later.preferenceV2ScorerError !== undefined) {
    return later.preferenceV2ScorerError;
  }
  if (later.preferenceV2Progress !== undefined) return undefined;
  return earlier.preferenceV2ScorerError;
}

function mergeProximityProgress(
  earlier: SchedulerProximityProgress,
  later: SchedulerProximityProgress,
): SchedulerProximityProgress {
  return later.queued === null ? earlier : later;
}

export function parseCanonicalContinuationProgressVector(
  value: unknown,
): CanonicalContinuationProgressVector {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "schemaVersion",
      "earliestDocumentAccessNextEligibleAt",
      "documentAccessStops",
      "sources",
    ]) ||
    value.schemaVersion !== CANONICAL_CONTINUATION_PROGRESS_SCHEMA_VERSION ||
    (value.earliestDocumentAccessNextEligibleAt !== null &&
      !isCanonicalTimestamp(value.earliestDocumentAccessNextEligibleAt)) ||
    !Array.isArray(value.documentAccessStops) ||
    !Array.isArray(value.sources)
  ) {
    throw new SchedulerRuntimeError(
      "canonical_continuation_progress_vector_contract_mismatch",
      "The canonical continuation progress vector was invalid",
    );
  }
  const expectedSourceIds = sourceOrchestrationRegistry.map(({ sourceId }) => sourceId);
  const accessStops: CanonicalContinuationProgressVector["documentAccessStops"][number][] = [];
  const accessStopSourceIds = new Set<SourceId>();
  for (const candidate of value.documentAccessStops) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["sourceId", "state", "reasonCode", "nextEligibleAt"]) ||
      !isCampaignSourceId(candidate.sourceId) ||
      accessStopSourceIds.has(candidate.sourceId) ||
      (candidate.state !== "cooldown" && candidate.state !== "manual_reset_required") ||
      !isSafeReasonCode(candidate.reasonCode) ||
      (candidate.state === "cooldown"
        ? !isCanonicalTimestamp(candidate.nextEligibleAt)
        : candidate.nextEligibleAt !== null)
    ) {
      throw new SchedulerRuntimeError(
        "canonical_continuation_progress_vector_contract_mismatch",
        "The canonical continuation progress vector contained an invalid access stop",
      );
    }
    accessStopSourceIds.add(candidate.sourceId);
    accessStops.push(Object.freeze({
      sourceId: candidate.sourceId,
      state: candidate.state,
      reasonCode: candidate.reasonCode,
      nextEligibleAt: candidate.nextEligibleAt as string | null,
    }));
  }
  if (accessStops.some((entry, index) =>
    index > 0 && accessStops[index - 1]!.sourceId >= entry.sourceId
  )) {
    throw new SchedulerRuntimeError(
      "canonical_continuation_progress_vector_contract_mismatch",
      "The canonical continuation progress vector access stops were not canonical",
    );
  }
  const exactEarliestAccessBoundary = accessStops
    .flatMap((entry) => entry.state === "cooldown" ? [entry.nextEligibleAt!] : [])
    .sort()[0] ?? null;
  if (value.earliestDocumentAccessNextEligibleAt !== exactEarliestAccessBoundary) {
    throw new SchedulerRuntimeError(
      "canonical_continuation_progress_vector_contract_mismatch",
      "The canonical continuation progress vector access boundary was inconsistent",
    );
  }
  if (value.sources.length !== expectedSourceIds.length) {
    throw new SchedulerRuntimeError(
      "canonical_continuation_progress_vector_contract_mismatch",
      "The canonical continuation progress vector omitted a source",
    );
  }
  const parsedBySource = new Map<SourceId, CanonicalContinuationProgressVector["sources"][number]>();
  for (const entry of value.sources) {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["sourceId", "publicationHead", "traversal"]) ||
      !isCampaignSourceId(entry.sourceId) ||
      parsedBySource.has(entry.sourceId)
    ) {
      throw new SchedulerRuntimeError(
        "canonical_continuation_progress_vector_contract_mismatch",
        "The canonical continuation progress vector contained an invalid source",
      );
    }
    if (
      entry.publicationHead !== null &&
      (!isRecord(entry.publicationHead) || !hasExactKeys(entry.publicationHead, [
        "sourceId",
        "inventoryRunId",
        "publishedAt",
        "listingCount",
        "membershipFingerprint",
        "membershipCount",
      ]))
    ) {
      throw new SchedulerRuntimeError(
        "canonical_continuation_progress_vector_contract_mismatch",
        "The canonical continuation progress vector contained a malformed publication head",
      );
    }
    const parsedPublicationHead = entry.publicationHead === null
      ? null
      : parseCampaignPublicationHead(entry.publicationHead);
    const publicationHead = parsedPublicationHead === null || entry.publicationHead === null
      ? null
      : isSha256Identity(entry.publicationHead.membershipFingerprint) &&
          Number.isSafeInteger(entry.publicationHead.membershipCount) &&
          Number(entry.publicationHead.membershipCount) >= 0 &&
          Number(entry.publicationHead.membershipCount) <= parsedPublicationHead.listingCount
        ? Object.freeze({
            ...parsedPublicationHead,
            membershipFingerprint: entry.publicationHead.membershipFingerprint,
            membershipCount: Number(entry.publicationHead.membershipCount),
          })
        : null;
    if (
      (entry.publicationHead !== null && publicationHead === null) ||
      (publicationHead !== null && publicationHead.sourceId !== entry.sourceId)
    ) {
      throw new SchedulerRuntimeError(
        "canonical_continuation_progress_vector_contract_mismatch",
        "The canonical continuation progress vector contained an invalid publication head",
      );
    }
    let traversal: CanonicalContinuationProgressVector["sources"][number]["traversal"] = null;
    if (entry.traversal !== null) {
      const candidate = entry.traversal;
      if (
        !isRecord(candidate) ||
        !hasExactKeys(candidate, [
          "traversalId",
          "contractHash",
          "expectedPages",
          "completed",
          "completedCheckpointHashes",
        ]) ||
        !isBoundedOpaqueIdentity(candidate.traversalId, 512) ||
        !isSha256Identity(candidate.contractHash) ||
        !Number.isSafeInteger(candidate.expectedPages) ||
        Number(candidate.expectedPages) < 1 ||
        Number(candidate.expectedPages) > 100_000 ||
        typeof candidate.completed !== "boolean" ||
        !Array.isArray(candidate.completedCheckpointHashes) ||
        (candidate.completed
          ? candidate.completedCheckpointHashes.length !== Number(candidate.expectedPages)
          : candidate.completedCheckpointHashes.length >= Number(candidate.expectedPages)) ||
        candidate.completedCheckpointHashes.some((hash) => !isSha256Identity(hash)) ||
        candidate.completedCheckpointHashes.some((hash, index, hashes) =>
          index > 0 && String(hashes[index - 1]) >= String(hash)
        )
      ) {
        throw new SchedulerRuntimeError(
          "canonical_continuation_progress_vector_contract_mismatch",
          "The canonical continuation progress vector contained an invalid traversal",
        );
      }
      traversal = Object.freeze({
        traversalId: candidate.traversalId,
        contractHash: candidate.contractHash,
        expectedPages: Number(candidate.expectedPages),
        completed: candidate.completed,
        completedCheckpointHashes: Object.freeze(
          candidate.completedCheckpointHashes as string[],
        ),
      });
    }
    parsedBySource.set(entry.sourceId, Object.freeze({
      sourceId: entry.sourceId,
      publicationHead,
      traversal,
    }));
  }
  return Object.freeze({
    schemaVersion: CANONICAL_CONTINUATION_PROGRESS_SCHEMA_VERSION,
    earliestDocumentAccessNextEligibleAt:
      value.earliestDocumentAccessNextEligibleAt as string | null,
    documentAccessStops: Object.freeze(accessStops),
    sources: Object.freeze(expectedSourceIds.map((sourceId) => {
      const entry = parsedBySource.get(sourceId);
      if (entry === undefined) {
        throw new SchedulerRuntimeError(
          "canonical_continuation_progress_vector_contract_mismatch",
          "The canonical continuation progress vector omitted a registered source",
        );
      }
      return entry;
    })),
  });
}

export function compareCanonicalContinuationProgressVectors(
  priorValue: unknown,
  resultingValue: unknown,
): CanonicalContinuationProgressComparison {
  const prior = parseCanonicalContinuationProgressVector(priorValue);
  const resulting = parseCanonicalContinuationProgressVector(resultingValue);
  const resultingBySource = new Map(
    resulting.sources.map((entry) => [entry.sourceId, entry]),
  );
  const advancedSourceIds: SourceId[] = [];
  const publicationAdvancedSourceIds: SourceId[] = [];
  let regressed = false;
  for (const priorEntry of prior.sources) {
    const resultingEntry = resultingBySource.get(priorEntry.sourceId)!;
    const priorHead = priorEntry.publicationHead;
    const resultingHead = resultingEntry.publicationHead;
    let publicationAdvanced = false;
    if (priorHead === null && resultingHead !== null) {
      // An empty first head changes only publication bookkeeping. It does not
      // change semantic current membership.
      if (resultingHead.membershipCount > 0) publicationAdvanced = true;
    } else if (priorHead !== null && resultingHead === null) {
      regressed = true;
    } else if (priorHead !== null && resultingHead !== null) {
      const exactHeadIdentityRepeated = samePublicationHead(priorHead, resultingHead);
      const sameMembershipFingerprint =
        priorHead.membershipFingerprint === resultingHead.membershipFingerprint;
      const sameMembershipCount =
        priorHead.membershipCount === resultingHead.membershipCount;
      const sameMembership = sameMembershipFingerprint && sameMembershipCount;
      const contradictoryMembership =
        sameMembershipFingerprint !== sameMembershipCount;
      if (contradictoryMembership) {
        regressed = true;
      } else if (exactHeadIdentityRepeated) {
        // One immutable head cannot acquire a different semantic current set
        // as publication progress. Later current-set pruning is intentionally
        // ambiguous here because it carries no exact publication receipt.
        if (!sameMembership) regressed = true;
      } else if (
        priorHead.inventoryRunId === resultingHead.inventoryRunId ||
        Date.parse(resultingHead.publishedAt) <= Date.parse(priorHead.publishedAt)
      ) {
        regressed = true;
      } else if (!sameMembership) {
        publicationAdvanced = true;
      }
      // A later run/head with the same semantic membership is deliberately
      // no progress; run IDs, timestamps, and counts never reset retry bounds.
    }
    if (publicationAdvanced) {
      advancedSourceIds.push(priorEntry.sourceId);
      publicationAdvancedSourceIds.push(priorEntry.sourceId);
    }
    if (publicationAdvanced || regressed) continue;
    const priorTraversal = priorEntry.traversal;
    const resultingTraversal = resultingEntry.traversal;
    if (priorTraversal === null && resultingTraversal === null) continue;
    if (priorTraversal === null && resultingTraversal !== null) {
      if (resultingTraversal.completedCheckpointHashes.length > 0) {
        advancedSourceIds.push(priorEntry.sourceId);
      }
      continue;
    }
    if (priorTraversal !== null && resultingTraversal === null) {
      if (!priorTraversal.completed) regressed = true;
      continue;
    }
    if (
      priorTraversal!.traversalId !== resultingTraversal!.traversalId ||
      priorTraversal!.contractHash !== resultingTraversal!.contractHash ||
      priorTraversal!.expectedPages !== resultingTraversal!.expectedPages
    ) {
      regressed = true;
      continue;
    }
    const resultingCheckpoints = new Set(resultingTraversal!.completedCheckpointHashes);
    if (priorTraversal!.completedCheckpointHashes.some((hash) =>
      !resultingCheckpoints.has(hash)
    )) {
      regressed = true;
      continue;
    }
    if (
      resultingTraversal!.completedCheckpointHashes.length >
        priorTraversal!.completedCheckpointHashes.length
    ) {
      advancedSourceIds.push(priorEntry.sourceId);
    }
  }
  return Object.freeze({
    classification: regressed
      ? "regressed"
      : advancedSourceIds.length > 0 ? "advanced" : "no_progress",
    advancedSourceIds: Object.freeze(advancedSourceIds),
    publicationAdvancedSourceIds: Object.freeze(publicationAdvancedSourceIds),
  });
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isBoundedOpaqueIdentity(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isSha256Identity(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isSafeReasonCode(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function parseCampaignPublicationHead(value: unknown): SourceInventoryPublicationHead | null {
  if (
    !isRecord(value) || !isCampaignSourceId(value.sourceId) ||
    typeof value.inventoryRunId !== "string" || value.inventoryRunId.length < 1 ||
    value.inventoryRunId.length > 512 || typeof value.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    !Number.isSafeInteger(value.listingCount) || Number(value.listingCount) < 0 ||
    Number(value.listingCount) > 1_000_000
  ) return null;
  return Object.freeze({
    sourceId: value.sourceId,
    inventoryRunId: value.inventoryRunId,
    publishedAt: value.publishedAt,
    listingCount: Number(value.listingCount),
  });
}

function isCampaignSourceId(value: unknown): value is SourceId {
  return typeof value === "string" &&
    sourceOrchestrationRegistry.some((entry) => entry.sourceId === value);
}

function parseAdapterSnapshot(
  value: unknown,
  maximum: number,
  preparationScope: "all" | "core" | "maintenance",
): SchedulerSnapshot {
  if (
    isRecord(value) &&
    value.schemaVersion === NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION &&
    value.ready !== true
  ) {
    throw new SchedulerAdapterUnavailableError(
      "The Worker nightly scheduler adapter is not schema-ready",
    );
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION ||
    value.ready !== true || !isRecord(value.capabilities) ||
    value.capabilities.exactQueueClaims !== true ||
    value.capabilities.sourceAccessState !== true ||
    value.capabilities.sourceAcquisitionReservations !== true ||
    value.capabilities.acquiredBundleReceipts !== true ||
    value.capabilities.singleWriterFinalize !== true ||
    typeof value.generation !== "string" || value.generation.length < 1 ||
    value.generation.length > 512 ||
    !Number.isSafeInteger(value.boundedReadCount) || Number(value.boundedReadCount) < 1 ||
    Number(value.boundedReadCount) > 32 ||
    !Array.isArray(value.candidates) || value.candidates.length > maximum ||
    !value.candidates.every(isSchedulerCandidate) ||
    (value.remainingWork !== undefined &&
      !isSchedulerRemainingWork(
        value.remainingWork,
        value.candidates.length,
        preparationScope,
      ))
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_snapshot_contract_mismatch",
      "The nightly scheduler adapter returned an invalid bounded snapshot",
    );
  }
  return Object.freeze({
    generation: value.generation,
    candidates: Object.freeze(value.candidates),
    boundedReadCount: Number(value.boundedReadCount),
    ...(value.remainingWork === undefined
      ? {}
      : { remainingWork: Object.freeze(value.remainingWork) }),
  });
}

function isSchedulerRemainingWork(
  value: unknown,
  returnedCandidates: number,
  preparationScope: "all" | "core" | "maintenance",
): value is NonNullable<
  SchedulerSnapshot["remainingWork"]
> {
  if (!isRecord(value)) return false;
  const keys = [
    "sourceAcquisitions",
    "preparationReady",
    "preparationDeferred",
    "preparationClaimed",
    "coreReady",
    "coreDeferred",
    "coreClaimed",
    "maintenanceReady",
    "maintenanceDeferred",
    "maintenanceClaimed",
    "returned",
    "truncated",
  ] as const;
  if (!keys.every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)) {
    return false;
  }
  const aggregateRemaining = Number(value.sourceAcquisitions) +
    Number(value.preparationReady) +
    Number(value.preparationDeferred) + Number(value.preparationClaimed);
  if (
    Number(value.preparationReady) !==
      Number(value.coreReady) + Number(value.maintenanceReady) ||
    Number(value.preparationDeferred) !==
      Number(value.coreDeferred) + Number(value.maintenanceDeferred) ||
    Number(value.preparationClaimed) !==
      Number(value.coreClaimed) + Number(value.maintenanceClaimed)
  ) return false;
  if (value.primaryImages !== undefined) {
    if (!isRecord(value.primaryImages)) return false;
    const primaryImages = value.primaryImages;
    const imageKeys = ["ready", "deferred", "claimed", "remaining"] as const;
    if (!imageKeys.every((key) =>
      Number.isSafeInteger(primaryImages[key]) &&
      Number(primaryImages[key]) >= 0
    )) return false;
    if (
      Number(primaryImages.remaining) !==
        Number(primaryImages.ready) + Number(primaryImages.deferred) +
          Number(primaryImages.claimed) ||
      Number(primaryImages.remaining) === 0 ||
      Number(primaryImages.remaining) > aggregateRemaining
    ) return false;
  }
  const scopedPreparationRemaining = preparationScope === "core"
    ? Number(value.coreReady) + Number(value.coreDeferred) + Number(value.coreClaimed)
    : preparationScope === "maintenance"
    ? Number(value.maintenanceReady) + Number(value.maintenanceDeferred) +
      Number(value.maintenanceClaimed)
    : Number(value.preparationReady) + Number(value.preparationDeferred) +
      Number(value.preparationClaimed);
  const validationRemaining = Number(value.sourceAcquisitions) +
    scopedPreparationRemaining;
  return value.returned === returnedCandidates &&
    validationRemaining >= returnedCandidates &&
    value.truncated === validationRemaining - returnedCandidates;
}

function parseAdapterAuthorizationToken(value: unknown): string {
  if (
    !isRecord(value) || typeof value.authorizationToken !== "string" ||
    value.authorizationToken.length < 32 || value.authorizationToken.length > 512
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_authorization_contract_mismatch",
      "The nightly scheduler adapter omitted its invocation authorization",
    );
  }
  return value.authorizationToken;
}

function isSchedulerCandidate(value: unknown): value is SchedulerCandidate {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 1_024) return false;
  if (value.kind !== "source_acquisition" && value.kind !== "preparation") return false;
  if (
    typeof value.sourceId !== "string" ||
    (
      value.sourceId !== LOCAL_SCHEDULER_SOURCE_ID &&
      !sourceOrchestrationRegistry.some((entry) => entry.sourceId === value.sourceId)
    )
  ) return false;
  if (typeof value.stage !== "string" || value.stage === "preference_v2_score" ||
      typeof value.availableAt !== "string") return false;
  if (
    !Array.isArray(value.networkLanes) ||
    !value.networkLanes.every((lane) => typeof lane === "string") ||
    (
      value.networkLanes.length < 1 &&
      !(value.kind === "preparation" && value.sourceId === LOCAL_SCHEDULER_SOURCE_ID)
    )
  ) return false;
  if (!Array.isArray(value.dependencies) || !value.dependencies.every((source) => typeof source === "string")) return false;
  if (value.accessState !== "ready" && value.accessState !== "cooldown" && value.accessState !== "manual_reset_required") return false;
  if (!isRecord(value.timing)) return false;
  if (value.kind === "source_acquisition" && (
    !isRecord(value.sourceInput) ||
    value.sourceInput.coverageMode !== "complete_current" ||
    typeof value.sourceInput.campaignId !== "string" ||
    typeof value.sourceInput.inputHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.sourceInput.inputHash) ||
    !Number.isSafeInteger(value.sourceInput.expectedGeneration) ||
    !Number.isSafeInteger(value.sourceInput.inputRevision) ||
    (value.sourceInput.priorHead !== undefined && value.sourceInput.priorHead !== null &&
      !isSourceHeadEvidence(value.sourceInput.priorHead)) ||
    (value.sourceInput.priorCheckpoint !== undefined &&
      value.sourceInput.priorCheckpoint !== null &&
      !isSourceCheckpointEvidence(value.sourceInput.priorCheckpoint)) ||
    (value.sourceInput.recentPublicationSkip !== undefined &&
      value.sourceInput.recentPublicationSkip !== null &&
      (
        !isRecentPublicationSkip(value.sourceInput.recentPublicationSkip) ||
        value.sourceInput.coverageMode !== "complete_current" ||
        !isSourceHeadEvidence(value.sourceInput.priorHead) ||
        value.sourceInput.priorHead.inventoryRunId !==
          value.sourceInput.recentPublicationSkip.head.inventoryRunId ||
        value.sourceInput.priorHead.listingCount !==
          value.sourceInput.recentPublicationSkip.head.listingCount
      ))
  )) return false;
  const timing = value.timing;
  return [
    "remainingRequests", "remainingPages", "pacingFloorMs", "requestEwmaMs",
    "parseEwmaMs", "callbackEwmaMs", "commitEwmaMs",
  ].every((key) => typeof timing[key] === "number" && Number(timing[key]) >= 0);
}

function isPipelineWorkClaimIdentity(value: unknown): value is NonNullable<
  SchedulerReservation["queueClaim"]
> {
  return isRecord(value) && typeof value.stage === "string" &&
    typeof value.subjectType === "string" && typeof value.subjectId === "string" &&
    value.subjectId.length > 0 && typeof value.owner === "string" && value.owner.length > 0 &&
    isBoundedOpaqueIdentity(value.inputHash, 512) &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 1;
}

function parseReservation(value: unknown, candidate: SchedulerCandidate): SchedulerReservation {
  if (
    !isRecord(value) || typeof value.reservationId !== "string" ||
    value.candidateId !== candidate.id || value.sourceId !== candidate.sourceId ||
    typeof value.laneKey !== "string" || !Number.isSafeInteger(value.inputRevision) ||
    Number(value.inputRevision) < 1 || !isCanonicalTimestamp(value.expiresAt) ||
    !("queueClaim" in value) || !("acquisitionClaim" in value)
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_reservation_contract_mismatch",
      "The nightly scheduler adapter returned an invalid reservation",
    );
  }
  if (value.queueClaim !== null && !isPipelineWorkClaimIdentity(value.queueClaim)) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_reservation_contract_mismatch",
      "The nightly scheduler adapter returned an invalid queue claim",
    );
  }
  if ("queueClaims" in value || "queueClaimsIdentity" in value) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_reservation_contract_mismatch",
      "The generic scheduler does not support scorer claim bundles",
    );
  }
  return value as unknown as SchedulerReservation;
}

function parseBundle(value: unknown, reservation: SchedulerReservation): SchedulerAcquiredBundle {
  if (
    !isRecord(value) || value.reservationId !== reservation.reservationId ||
    typeof value.bundleIdentity !== "string" || typeof value.responseHash !== "string" ||
    typeof value.contentHash !== "string" || value.validated !== true ||
    !("acquiredBundle" in value) || !isCallbackInstruction(value.callback) ||
    (value.metrics !== undefined && !isSchedulerBundleMetrics(value.metrics))
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_bundle_contract_mismatch",
      "The nightly scheduler adapter returned an invalid acquired bundle",
    );
  }
  return value as unknown as SchedulerAcquiredBundle;
}

function parseCommitResult(value: unknown):
  | { readonly kind: "outcome"; readonly outcome: SchedulerWorkOutcome }
  | { readonly kind: "callback_required"; readonly instruction: Exclude<SchedulerCallbackInstruction, { kind: "local_commit" }> } {
  if (!isRecord(value) || (value.kind !== "outcome" && value.kind !== "callback_required")) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_commit_contract_mismatch",
      "The nightly scheduler adapter returned an invalid commit response",
    );
  }
  if (value.kind === "outcome") {
    return Object.freeze({ kind: "outcome", outcome: parseOutcome(value.outcome) });
  }
  if (!isCallbackInstruction(value.instruction) || value.instruction.kind !== "loopback_json") {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_callback_contract_mismatch",
      "The nightly scheduler adapter returned an invalid callback instruction",
    );
  }
  return Object.freeze({ kind: "callback_required", instruction: value.instruction });
}

function parseDetachedCallbackReconciliation(
  value: unknown,
): SchedulerDetachedCallbackReconciliation {
  if (!isRecord(value) || (value.state !== "active" && value.state !== "outcome")) {
    throw new SchedulerRuntimeError(
      "detached_callback_reconciliation_contract_mismatch",
      "The detached callback reconciliation response was invalid",
    );
  }
  if (value.state === "active") {
    const reasonCode = value.reasonCode;
    if (
      (
        reasonCode !== "detached_callback_mutation_active" &&
        reasonCode !== "detached_callback_settlement_pending"
      ) ||
      Object.keys(value).some((key) => key !== "state" && key !== "reasonCode")
    ) {
      throw new SchedulerRuntimeError(
        "detached_callback_reconciliation_contract_mismatch",
        "The detached callback active response was invalid",
      );
    }
    return Object.freeze({
      state: "active",
      reasonCode,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(value, "outcome")) {
    throw new SchedulerRuntimeError(
      "detached_callback_reconciliation_contract_mismatch",
      "The detached callback terminal response omitted its outcome",
    );
  }
  return Object.freeze({
    state: "outcome",
    outcome: parseOutcome(value.outcome),
  });
}

function isCompleteCurrentSourceCandidate(candidate: SchedulerCandidate): boolean {
  return candidate.kind === "source_acquisition" &&
    candidate.sourceInput?.coverageMode === "complete_current";
}

function isAcquireBoundPreparationCandidate(candidate: SchedulerCandidate): boolean {
  return candidate.kind === "preparation" &&
    ACQUIRE_BOUND_PREPARATION_STAGE_SET.has(candidate.stage);
}

function isTransientAdapterFailure(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.reasonCode === "local_transport_failed") return true;
  const status = Number(error.httpStatus);
  return status === 500 || status === 502 || status === 503 || status === 504;
}

async function validateAcquireBoundPreparationInstruction(
  candidate: SchedulerCandidate,
  reservation: SchedulerReservation,
  instruction: Exclude<SchedulerCallbackInstruction, { kind: "local_commit" }>,
): Promise<SchedulerAcquiredBundle> {
  if (!isAcquireBoundPreparationCandidate(candidate)) {
    throw new SchedulerRuntimeError(
      "scheduler_external_acquisition_validation_invalid",
      "Only acquire-bound preparation can use the exact local validation fallback",
    );
  }
  const contentHash = await hashCanonicalJson(instruction);
  return Object.freeze({
    reservationId: reservation.reservationId,
    bundleIdentity: await hashCanonicalJson({
      reservationId: reservation.reservationId,
      candidateId: candidate.id,
      contentHash,
    }),
    responseHash: contentHash,
    contentHash,
    validated: true,
    acquiredBundle: null,
    callback: instruction,
  });
}

function callbackRequiresSchedulerAuthorization(
  candidate: SchedulerCandidate,
  instruction: Exclude<SchedulerCallbackInstruction, { kind: "local_commit" }>,
): boolean {
  return (
    candidate.kind === "source_acquisition" &&
    instruction.service === "dashboard" && instruction.path === "/api/runs" &&
    instruction.successContract === "source_catalog"
  ) || (
    candidate.kind === "preparation" && (
      instruction.successContract === "proximity_session" ||
      instruction.successContract === "enrichment_session"
    )
  );
}

async function executeCallbackInstruction(input: {
  readonly baseUrl: string;
  readonly request: (request: NightlySchedulerRequest) => Promise<NightlySchedulerResponse>;
  readonly instruction: Exclude<SchedulerCallbackInstruction, { kind: "local_commit" }>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}): Promise<SchedulerCallbackReceipt> {
  const base = input.instruction.service === "dashboard"
    ? validateBaseUrl(input.baseUrl)
    : "http://127.0.0.1:32110";
  const headers = Object.freeze({
    ...(input.instruction.service === "companion"
      ? { Origin: "http://localhost:3000" }
      : {}),
    ...(input.headers ?? {}),
  });
  const response = await input.request({
    method: "POST",
    url: `${base}${input.instruction.path}`,
    ...(input.instruction.body === null ? {} : { body: input.instruction.body }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    timeoutMs: input.instruction.timeoutMs,
    maxResponseBytes: MAX_LOCAL_JSON_BYTES,
    signal: input.signal,
  });
  return Object.freeze({
    status: response.status,
    responseHash: await hashCanonicalJson(response.body),
    body: response.body,
  });
}

function isReconciledExternalCallbackOutcome(
  value: unknown,
): value is ReconciledExternalCallbackOutcome {
  return isRecord(value) && value.kind === "reconciled_external_callback_outcome" &&
    isRecord(value.outcome);
}

function isExternalAcquisitionReceipt(
  value: unknown,
): value is SchedulerExternalAcquisitionReceipt {
  return isRecord(value) && value.kind === "external_acquisition_receipt" &&
    isCallbackInstruction(value.instruction) && value.instruction.kind === "loopback_json" &&
    value.instruction.executionBoundary === "acquire_outside_fifo" &&
    isRecord(value.receipt) && Number.isSafeInteger(value.receipt.status) &&
    typeof value.receipt.responseHash === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value.receipt.responseHash) &&
    "body" in value.receipt;
}

function isCallbackInstruction(value: unknown): value is SchedulerCallbackInstruction {
  if (!isRecord(value) || (value.kind !== "local_commit" && value.kind !== "loopback_json")) return false;
  if (value.kind === "local_commit") return true;
  return (value.service === "dashboard" || value.service === "companion") &&
    typeof value.path === "string" && value.path.startsWith("/") &&
    (value.body === null || isRecord(value.body)) && Number.isSafeInteger(value.timeoutMs) &&
    Number(value.timeoutMs) > 0 && typeof value.successContract === "string" &&
    (value.executionBoundary === undefined || value.executionBoundary === "commit_fifo" ||
      value.executionBoundary === "acquire_outside_fifo");
}

function isSchedulerBundleMetrics(value: unknown): boolean {
  return isRecord(value) && [
    value.requestsConsumed,
    value.pagesConsumed,
    value.bytesDownloaded,
  ].every((entry) => Number.isSafeInteger(entry) && Number(entry) >= 0);
}

function parseOutcome(value: unknown): SchedulerWorkOutcome {
  if (!isRecord(value) || typeof value.classification !== "string") {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_outcome_contract_mismatch",
      "The nightly scheduler adapter returned an invalid commit outcome",
    );
  }
  if (
    value.proximityProgress !== undefined &&
    !isSchedulerProximityProgress(value.proximityProgress)
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_outcome_contract_mismatch",
      "The nightly scheduler adapter returned invalid proximity progress",
    );
  }
  if (
    value.primaryImageSession !== undefined &&
    !isSchedulerPrimaryImageSession(value.primaryImageSession)
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_outcome_contract_mismatch",
      "The nightly scheduler adapter returned invalid primary-image session telemetry",
    );
  }
  if (
    value.preferenceV2Progress !== undefined &&
    !isSchedulerPreferenceV2Progress(value.preferenceV2Progress)
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_outcome_contract_mismatch",
      "The nightly scheduler adapter returned invalid Preference V2 progress",
    );
  }
  if (
    value.preferenceV2SessionDiagnostics !== undefined &&
    !isSchedulerPreferenceV2SessionDiagnostics(value.preferenceV2SessionDiagnostics)
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_outcome_contract_mismatch",
      "The nightly scheduler adapter returned invalid Preference V2 session diagnostics",
    );
  }
  if (
    value.preferenceV2ScorerError !== undefined &&
    parsePreferenceV2ScorerErrorEnvelope(value.preferenceV2ScorerError) === null
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_outcome_contract_mismatch",
      "The nightly scheduler adapter returned an invalid Preference V2 scorer error",
    );
  }
  if (
    value.noProgressIdentity !== undefined &&
    (
      value.madeProgress !== false ||
      !isBoundedOpaqueIdentity(value.noProgressIdentity, 512)
    )
  ) {
    throw new SchedulerRuntimeError(
      "scheduler_adapter_outcome_contract_mismatch",
      "The nightly scheduler adapter returned an invalid no-progress identity",
    );
  }
  if (
    (value.classification === "completed" || value.classification === "deterministic_terminal") &&
    value.madeProgress === true && value.remaining === false
  ) {
    if (value.classification === "completed" && value.sourceBoundary !== undefined &&
        !isVerifiedSourceBoundary(value.sourceBoundary)) {
      throw new SchedulerRuntimeError(
        "scheduler_adapter_outcome_contract_mismatch",
        "The nightly scheduler adapter returned invalid source publication proof",
      );
    }
    return value as unknown as SchedulerWorkOutcome;
  }
  if (
    value.classification === "retryable_pressure" &&
    typeof value.madeProgress === "boolean" && value.remaining === true &&
    isCanonicalTimestamp(value.availableAt) && isSafeReasonCode(value.reasonCode)
  ) return value as unknown as SchedulerWorkOutcome;
  if (
    value.classification === "access_stop" && value.madeProgress === false &&
    value.remaining === true &&
    (value.availableAt === null || isCanonicalTimestamp(value.availableAt)) &&
    isSafeReasonCode(value.reasonCode)
  ) return value as unknown as SchedulerWorkOutcome;
  if (
    (value.classification === "no_progress" ||
      value.classification === "handler_failure_prior_head_preserved" ||
      value.classification === "handler_failure_state_ambiguous") &&
    value.madeProgress === false && value.remaining === true &&
    isSafeReasonCode(value.reasonCode)
  ) return value as unknown as SchedulerWorkOutcome;
  throw new SchedulerRuntimeError(
    "scheduler_adapter_outcome_contract_mismatch",
    "The nightly scheduler adapter returned an unsupported commit outcome",
  );
}

function attachProximityProgress(
  outcome: SchedulerWorkOutcome,
  progress: SchedulerProximityProgress | null,
): SchedulerWorkOutcome {
  return progress === null
    ? outcome
    : Object.freeze({ ...outcome, proximityProgress: progress });
}

function attachPrimaryImageSession(
  outcome: SchedulerWorkOutcome,
  session: SchedulerPrimaryImageSession | null,
): SchedulerWorkOutcome {
  return session === null
    ? outcome
    : Object.freeze({ ...outcome, primaryImageSession: session });
}

function parsePrimaryImageCallbackSession(
  body: unknown,
  expectedSourceId: string,
): SchedulerPrimaryImageSession | null {
  if (!isRecord(body)) return null;
  const keys = Object.keys(body).sort().join(",");
  if (
    keys !== "archived,attempted,failed,remainingWork,schemaVersion,sourceId,status,stopReason" ||
    body.schemaVersion !== "auction-discovery-primary-image-session-v1" ||
    body.status !== "completed" ||
    body.sourceId !== expectedSourceId ||
    !isNonnegativeSafeInteger(body.attempted) ||
    !isNonnegativeSafeInteger(body.archived) ||
    !isNonnegativeSafeInteger(body.failed) ||
    Number(body.archived) + Number(body.failed) !== Number(body.attempted) ||
    typeof body.remainingWork !== "boolean" ||
    (body.stopReason !== null && !isSafeReasonCode(body.stopReason))
  ) return null;
  return Object.freeze({
    sourceId: expectedSourceId,
    attempted: Number(body.attempted),
    archived: Number(body.archived),
    failed: Number(body.failed),
    remainingWork: body.remainingWork,
    stopReason: body.stopReason === null ? null : String(body.stopReason),
  });
}

function parseProximityCallbackProgress(
  body: unknown,
): SchedulerProximityProgress | null {
  const record = isRecord(body) ? body : null;
  const work = record !== null && isRecord(record.work) ? record.work : null;
  if (work === null) return null;
  const queued = work.queuedAtStart;
  const claimed = work.claimed;
  const completed = work.completed;
  const stale = work.stale;
  if (
    !isNonnegativeSafeInteger(queued) ||
    !isNonnegativeSafeInteger(claimed) ||
    !isNonnegativeSafeInteger(completed) ||
    !isNonnegativeSafeInteger(stale) ||
    claimed > queued ||
    completed + stale > claimed
  ) return null;
  // This is a pass-local dynamic baseline, not the all-stage scheduler tail.
  const remaining = queued - completed;
  if (!Number.isSafeInteger(remaining) || remaining < 0) return null;
  return Object.freeze({ queued, claimed, completed, stale, remaining });
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isSchedulerProximityProgress(
  value: unknown,
): value is SchedulerProximityProgress {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "claimed,completed,queued,remaining,stale") return false;
  const { queued, claimed, completed, stale, remaining } = value;
  const values = [queued, claimed, completed, stale, remaining];
  if (values.every((entry) => entry === null)) return true;
  return values.every(isNonnegativeSafeInteger) &&
    Number(claimed) <= Number(queued) &&
    Number(completed) + Number(stale) <= Number(claimed) &&
    Number(remaining) === Number(queued) - Number(completed);
}

function isSchedulerPrimaryImageSession(
  value: unknown,
): value is SchedulerPrimaryImageSession {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  return keys === "archived,attempted,failed,remainingWork,sourceId,stopReason" &&
    typeof value.sourceId === "string" && value.sourceId.length > 0 &&
    value.sourceId.length <= 128 &&
    isNonnegativeSafeInteger(value.attempted) &&
    isNonnegativeSafeInteger(value.archived) &&
    isNonnegativeSafeInteger(value.failed) &&
    Number(value.archived) + Number(value.failed) === Number(value.attempted) &&
    typeof value.remainingWork === "boolean" &&
    (value.stopReason === null || isSafeReasonCode(value.stopReason));
}

function isSchedulerPreferenceV2Progress(
  value: unknown,
): value is SchedulerPreferenceV2Progress {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    "queueBefore", "selected", "completed", "reused", "newlyScored", "stale",
    "queueAfter", "remaining", "lastProgressAt", "elapsedMs",
    "throughputRowsPerSecond", "estimatedRemainingMs", "stopReason",
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) return false;
  const integerKeys = [
    "queueBefore", "selected", "completed", "reused", "newlyScored", "stale",
    "queueAfter", "remaining",
  ] as const;
  if (!integerKeys.every((key) => isNonnegativeSafeInteger(value[key]))) return false;
  const queueBefore = Number(value.queueBefore);
  const selected = Number(value.selected);
  const completed = Number(value.completed);
  const reused = Number(value.reused);
  const newlyScored = Number(value.newlyScored);
  const stale = Number(value.stale);
  const queueAfter = Number(value.queueAfter);
  const remaining = Number(value.remaining);
  const elapsedMs = value.elapsedMs;
  const throughput = value.throughputRowsPerSecond;
  const estimate = value.estimatedRemainingMs;
  const lastProgressAt = value.lastProgressAt;
  return selected <= 10 && selected <= queueBefore && queueAfter <= queueBefore &&
    completed === queueBefore - queueAfter && completed <= selected &&
    reused + newlyScored <= selected && stale <= selected &&
    remaining === queueAfter && typeof elapsedMs === "number" &&
    Number.isFinite(elapsedMs) && elapsedMs >= 0 &&
    (completed === 0
      ? lastProgressAt === null
      : isCanonicalTimestamp(lastProgressAt)) &&
    (throughput === null ||
      (typeof throughput === "number" && Number.isFinite(throughput) && throughput > 0)) &&
    ((completed > 0 && elapsedMs > 0) === (throughput !== null)) &&
    (estimate === null ||
      (typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0)) &&
    (remaining === 0
      ? estimate === 0
      : throughput === null ? estimate === null : estimate !== null) &&
    value.stopReason === (remaining === 0 ? "queue_empty" : "quantum");
}

function isSchedulerPreferenceV2SessionDiagnostics(
  value: unknown,
): value is SchedulerPreferenceV2SessionDiagnostics {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    "sourceDataVersion", "sessionStatus", "snapshotCreationElapsedMs",
    "sessionElapsedMs", "rowsPerBatch", "reusableRows", "newlyScoredRows",
    "materializerInvocations", "pythonProcesses", "materializationElapsedMs",
    "inferenceElapsedMs", "scoreImportElapsedMs",
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) return false;
  const integerKeys = [
    "sourceDataVersion", "rowsPerBatch", "reusableRows", "newlyScoredRows",
    "materializerInvocations", "pythonProcesses",
  ] as const;
  if (integerKeys.some((key) =>
    !isNonnegativeSafeInteger(value[key])
  )) return false;
  const timingKeys = [
    "snapshotCreationElapsedMs", "sessionElapsedMs", "materializationElapsedMs",
    "inferenceElapsedMs", "scoreImportElapsedMs",
  ] as const;
  if (timingKeys.some((key) =>
    typeof value[key] !== "number" || !Number.isFinite(value[key]) ||
    Number(value[key]) < 0 ||
    Number(value[key]) > MAX_PREFERENCE_V2_SESSION_DIAGNOSTIC_MS
  )) return false;
  const rowsPerBatch = Number(value.rowsPerBatch);
  const reusableRows = Number(value.reusableRows);
  const newlyScoredRows = Number(value.newlyScoredRows);
  const materializerInvocations = Number(value.materializerInvocations);
  const pythonProcesses = Number(value.pythonProcesses);
  const sessionElapsedMs = Number(value.sessionElapsedMs);
  const materializationElapsedMs = Number(value.materializationElapsedMs);
  const inferenceElapsedMs = Number(value.inferenceElapsedMs);
  const scoreImportElapsedMs = Number(value.scoreImportElapsedMs);
  return rowsPerBatch >= 1 && rowsPerBatch <= 10 &&
    reusableRows <= rowsPerBatch && newlyScoredRows <= rowsPerBatch &&
    reusableRows + newlyScoredRows <= rowsPerBatch &&
    (materializerInvocations === 0 || materializerInvocations === 1) &&
    (pythonProcesses === 0 || pythonProcesses === 1) &&
    (materializerInvocations !== 0 || materializationElapsedMs === 0) &&
    (pythonProcesses !== 0 || inferenceElapsedMs === 0) &&
    materializationElapsedMs <= sessionElapsedMs &&
    inferenceElapsedMs <= sessionElapsedMs && scoreImportElapsedMs <= sessionElapsedMs &&
    ["up_to_date", "scored", "stale", "coverage_only"].includes(
      value.sessionStatus as string,
    );
}

function isSourceHeadEvidence(
  value: unknown,
): value is SchedulerSourceHeadEvidence {
  return isRecord(value) && typeof value.inventoryRunId === "string" &&
    value.inventoryRunId.length >= 1 && value.inventoryRunId.length <= 512 &&
    Number.isSafeInteger(value.listingCount) && Number(value.listingCount) >= 0 &&
    Number(value.listingCount) <= 1_000_000;
}

function isRecentPublicationSkip(
  value: unknown,
): value is SchedulerRecentPublicationSkip {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [
    "head", "proofIdentity", "publishedAt", "reasonCode", "receiptIdentity", "verifiedAt",
  ].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]) &&
    value.reasonCode === "recent_verified_publication" &&
    isCanonicalTimestamp(value.publishedAt) && isCanonicalTimestamp(value.verifiedAt) &&
    Date.parse(value.publishedAt) <= Date.parse(value.verifiedAt) &&
    isSourceHeadEvidence(value.head) && isSha256Identity(value.proofIdentity) &&
    isSha256Identity(value.receiptIdentity);
}

function isSourceCheckpointEvidence(value: unknown): boolean {
  return isRecord(value) && typeof value.traversalId === "string" &&
    value.traversalId.length >= 1 && value.traversalId.length <= 512 &&
    typeof value.contractHash === "string" && /^sha256:[0-9a-f]{64}$/u.test(value.contractHash) &&
    Number.isSafeInteger(value.expectedPages) && Number(value.expectedPages) >= 1 &&
    Number(value.expectedPages) <= 100_000 && Array.isArray(value.completedCheckpointHashes) &&
    value.completedCheckpointHashes.length <= Number(value.expectedPages) &&
    value.completedCheckpointHashes.every((hash) =>
      typeof hash === "string" && /^sha256:[0-9a-f]{64}$/u.test(hash)
    ) && new Set(value.completedCheckpointHashes).size === value.completedCheckpointHashes.length;
}

function isVerifiedSourceBoundary(value: unknown): boolean {
  return isRecord(value) && value.outcome === "refreshed" &&
    (value.priorHead === null || isSourceHeadEvidence(value.priorHead)) &&
    isSourceHeadEvidence(value.resultingHead) &&
    typeof value.proofIdentity === "string" && value.proofIdentity.length >= 1 &&
    value.proofIdentity.length <= 512 && typeof value.receiptIdentity === "string" &&
    value.receiptIdentity.length >= 1 && value.receiptIdentity.length <= 512;
}

function assertAdapterStatus(
  response: NightlySchedulerResponse,
  action: SchedulerAdapterAction,
): void {
  if (response.status === 404 || response.status === 501) {
    throw new SchedulerAdapterUnavailableError(
      "The Worker nightly scheduler adapter endpoint is not integrated",
      response.status,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new SchedulerRuntimeError(
      `scheduler_adapter_${action}_failed`,
      `The nightly scheduler adapter ${action} failed with HTTP ${response.status}`,
      response.status,
    );
  }
}

async function requestLocalJson(
  input: NightlySchedulerRequest,
): Promise<NightlySchedulerResponse> {
  if (input.signal?.aborted) {
    throw new SchedulerRuntimeError(
      "local_transport_failed",
      "The local nightly scheduler request was cancelled",
    );
  }
  const url = new URL(input.url);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    url.protocol !== "http:" ||
    (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1") ||
    url.username || url.password
  ) {
    throw new SchedulerRuntimeError(
      "invalid_local_scheduler_url",
      "The nightly scheduler may call only loopback HTTP services",
    );
  }
  const encoded = input.body === undefined
    ? null
    : Buffer.from(JSON.stringify(input.body), "utf8");
  const startedAt = new Date().toISOString();
  return new Promise<NightlySchedulerResponse>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", abortRequest);
      operation();
    };
    const abortRequest = (): void => {
      request.destroy();
      finish(() => reject(new SchedulerRuntimeError(
        "local_transport_failed",
        "The local nightly scheduler request was cancelled",
      )));
    };
    const request = httpRequest(url, {
      method: input.method,
      headers: {
        accept: "application/json",
        ...(encoded === null
          ? {}
          : {
              "content-type": "application/json",
              "content-length": String(encoded.byteLength),
            }),
        ...input.headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > input.maxResponseBytes) {
          request.destroy();
          finish(() => reject(new SchedulerRuntimeError(
            "local_response_too_large",
            "A local nightly scheduler response exceeded its bounded size",
          )));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        finish(() => {
          const endedAt = new Date().toISOString();
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          const parsingStartedAt = performance.now();
          try {
            body = text.length === 0 ? null : JSON.parse(text);
          } catch {
            const parsingMs = performance.now() - parsingStartedAt;
            const status = response.statusCode ?? 500;
            if (status >= 200 && status < 300) {
              reject(new SchedulerRuntimeError(
                "local_response_invalid_json",
                "A successful local nightly scheduler response was not valid JSON",
              ));
              return;
            }
            // A missing framework route may return a bounded HTML error body.
            // Preserve only the status classification; never echo that body.
            resolve({
              status,
              body: null,
              transportMeasurement: { startedAt, endedAt, responseBytes: bytes, parsingMs },
            });
            return;
          }
          resolve({
            status: response.statusCode ?? 500,
            body,
            transportMeasurement: {
              startedAt,
              endedAt,
              responseBytes: bytes,
              parsingMs: performance.now() - parsingStartedAt,
            },
          });
        });
      });
      response.on("error", (error) => finish(() => reject(new SchedulerRuntimeError(
        "local_transport_failed",
        error.message,
      ))));
    });
    request.setTimeout(input.timeoutMs, () => {
      request.destroy();
      finish(() => reject(new SchedulerRuntimeError(
        "local_transport_failed",
        "The local nightly scheduler request timed out",
      )));
    });
    request.on("error", (error) => finish(() => reject(new SchedulerRuntimeError(
      "local_transport_failed",
      error.message,
    ))));
    input.signal?.addEventListener("abort", abortRequest, { once: true });
    if (input.signal?.aborted) {
      abortRequest();
      return;
    }
    if (encoded !== null) request.write(encoded);
    request.end();
  });
}

function createPerformanceTelemetryRequest(
  request: (input: NightlySchedulerRequest) => Promise<NightlySchedulerResponse>,
  telemetry: PerformanceTelemetrySink,
  campaignId: string,
): (input: NightlySchedulerRequest) => Promise<NightlySchedulerResponse> {
  return async (input) => {
    const signaledInput = Object.freeze({
      ...input,
      headers: Object.freeze({
        ...input.headers,
        [PERFORMANCE_TELEMETRY_REQUEST_HEADER]:
          PERFORMANCE_TELEMETRY_REQUEST_VALUE,
      }),
    });
    const response = await request(signaledInput);
    const measurement = response.transportMeasurement;
    if (measurement === undefined) {
      throw new SchedulerRuntimeError(
        "performance_local_transport_measurement_missing",
        "Performance mode requires exact native-HTTP timing and byte evidence",
      );
    }
    const url = new URL(input.url);
    if (response.status >= 200 && response.status < 300) {
      const body = response.body;
      const adapterResponse = url.pathname === NIGHTLY_SCHEDULER_ADAPTER_PATH;
      const remoteTelemetry = isRecord(body)
        ? body.performanceTelemetry
        : undefined;
      const rawEnvelopePresent = isRecord(remoteTelemetry) &&
        Object.prototype.hasOwnProperty.call(remoteTelemetry, "events");
      if (adapterResponse || rawEnvelopePresent) {
        try {
          ingestPerformanceTelemetryEnvelope(remoteTelemetry, telemetry);
        } catch (error) {
          throw new SchedulerRuntimeError(
            "performance_telemetry_contract_mismatch",
            error instanceof Error
              ? `The local performance telemetry envelope is invalid: ${error.message}`
              : "The local performance telemetry envelope is invalid",
          );
        }
      }
    }
    const body = input.body;
    const candidate = isRecord(body?.candidate) ? body.candidate : null;
    const sourceId = typeof candidate?.sourceId === "string"
      ? candidate.sourceId
      : typeof body?.sourceId === "string"
      ? body.sourceId
      : LOCAL_SCHEDULER_SOURCE_ID;
    const action = typeof body?.action === "string" ? body.action : null;
    const requestRole = action === null
      ? input.method === "GET" ? "state_read" : "campaign_callback"
      : `scheduler_${action}`;
    telemetry.record({
      context: { campaignId, sourceId },
      details: {
        kind: "request",
        requestIdentity: requestIdentityForTelemetry(input.url),
        requestRole,
        laneKey: `loopback:${url.hostname.toLowerCase()}:${url.port || "80"}${url.pathname}`,
        pacingWaitMs: 0,
        acquisitionQueueWaitMs: 0,
        startedAt: measurement.startedAt,
        endedAt: measurement.endedAt,
        statusCode: response.status,
        retry: 0,
        responseBytes: measurement.responseBytes,
        decompressionMs: 0,
        hashingMs: 0,
        parsingMs: measurement.parsingMs,
        validationMs: 0,
      },
    });
    return response;
  };
}

function cliOutput(input: {
  readonly workflowDeadlineAt: string | null;
  readonly readiness: NightlySchedulerReadiness;
  readonly classification: string;
  readonly result: SchedulerRunResult | null;
  readonly continuationProgress?: CanonicalContinuationProgressReceipt | null;
  readonly performanceTelemetry?: Readonly<{
    receipt: PerformanceTelemetrySessionReceipt;
  }> | null;
}): object {
  return Object.freeze({
    schemaVersion: NIGHTLY_SCHEDULER_CLI_SCHEMA_VERSION,
    schedulerSchemaVersion: SCHEDULER_SCHEMA_VERSION,
    workflowDeadlineAt: input.workflowDeadlineAt,
    classification: input.classification,
    readiness: input.readiness,
    sourceRequests: input.result?.sourceRequests ?? 0,
    childProcesses: 0,
    ...(input.result === null ? {} : { result: input.result }),
    ...(input.continuationProgress == null
      ? {}
      : { continuationProgress: input.continuationProgress }),
    ...(input.performanceTelemetry == null
      ? {}
      : { performanceTelemetry: input.performanceTelemetry }),
  });
}

function recordCurrentSourceCoverage(input: {
  readonly telemetry: PerformanceTelemetrySink;
  readonly campaignId: string;
  readonly options: NightlySchedulerCliOptions;
  readonly selectedMode: NightlySchedulerReadiness["selectedMode"];
}): void {
  for (const policy of sourceOrchestrationRegistry) {
    const coverageMode = "complete_current" as const;
    const reasonCode = input.options.completeCurrentAudit
      ? "forced_complete_current_audit"
      : "generic_complete_current";
    input.telemetry.record({
      context: {
        campaignId: input.campaignId,
        sourceId: policy.sourceId,
        coverageMode,
      },
      details: {
        kind: "coverage",
        reasonCode,
      },
    });
  }
}

function successfulTerminal(classification: string): boolean {
  return classification === "clean_empty" ||
    classification === "deterministic_terminal" ||
    classification === "core_complete_maintenance_deferred" ||
    classification === "checkpoint_paused";
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validateBaseUrl(value: string | undefined): string {
  if (value === undefined) throw new RangeError("--base-url requires a value");
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" || parsed.hostname !== "localhost" ||
    parsed.username || parsed.password || parsed.search || parsed.hash
  ) {
    throw new RangeError("--base-url must be a query-free localhost HTTP URL");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/u, "");
  return parsed.toString().replace(/\/$/u, "");
}

function boundedInteger(
  value: string | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function absoluteWorkflowDeadline(value: string | undefined): Readonly<{
  argument: string;
  deadlineAtMs: number;
}> {
  if (value === undefined) {
    throw new RangeError("--workflow-deadline-at requires an absolute timestamp");
  }
  let deadlineAtMs: number;
  if (/^\d{1,16}$/u.test(value)) {
    deadlineAtMs = Number(value);
  } else if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  ) {
    deadlineAtMs = Date.parse(value);
    if (
      Number.isFinite(deadlineAtMs) && new Date(deadlineAtMs).toISOString() !== value
    ) deadlineAtMs = Number.NaN;
  } else {
    deadlineAtMs = Number.NaN;
  }
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 0) {
    throw new RangeError(
      "--workflow-deadline-at must be canonical UTC ISO milliseconds or epoch milliseconds",
    );
  }
  return Object.freeze({ argument: value, deadlineAtMs });
}

function strictBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/gu, "/")}`) {
  const gracefulStop = new AbortController();
  const requestGracefulStop = () => gracefulStop.abort();
  process.once("SIGINT", requestGracefulStop);
  process.once("SIGTERM", requestGracefulStop);
  runNightlySchedulerCli(process.argv.slice(2), {
    signal: gracefulStop.signal,
    progressSink(event) {
      process.stdout.write(`${NIGHTLY_SCHEDULER_PROGRESS_PREFIX}${JSON.stringify(event)}\n`);
    },
  }).then(({ exitCode, output }) => {
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = exitCode;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "nightly scheduler failed";
    process.stderr.write(`${message.slice(0, 1_000)}\n`);
    process.exitCode = 1;
  }).finally(() => {
    process.removeListener("SIGINT", requestGracefulStop);
    process.removeListener("SIGTERM", requestGracefulStop);
  });
}
