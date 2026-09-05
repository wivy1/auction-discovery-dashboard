import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../db/bootstrap";
import { createSequentialEnrichmentProviders } from "../ai";
import { optionalAiCapabilities } from "../ai/capabilities";
import { getConfig } from "../config";
import {
  boundedEnrichmentChunks,
  boundedEnrichmentLimit,
  EnrichmentCancelledError,
  throwIfEnrichmentCancelled,
  type EnrichmentSessionSummary,
} from "../enrichment/backlog";
import { readActiveRouteScope } from "../routing/active-scope";
import {
  EnrichmentBacklogError,
  enrichmentProvenanceTarget,
  runEnrichmentBacklogSession,
} from "./enrichment-backlog";
import {
  acquireEnrichmentRunMutationLease,
  beginEnrichmentRun,
  finishEnrichmentRun,
  renewPipelineRunLease,
  suspendEnrichmentRunMutationLease,
} from "./storage";
import { readConfiguredAdhocReviewCohort } from "../review-cohort/storage";
import type {
  PerformanceTelemetryContext,
  PerformanceTelemetrySink,
} from "../performance/telemetry";
import {
  type EnrichmentQueueWorkSummary,
  type EnrichmentQueueSelectionFingerprint,
  type EnrichmentSessionDiagnostics,
  type QueueBackedEnrichmentSessionSummary,
  runQueueBackedEnrichmentSession,
} from "./enrichment-queue-session";
import type { PipelineWorkClaimIdentity } from "./work-queue";
import type { EnrichmentStagedGenerationStore } from
  "../enrichment/staged-generation";

export interface EnrichmentRunSummary extends EnrichmentSessionSummary {
  runId: string;
  status: "completed" | "partial" | "failed" | "stopped";
  originPostalCode: string;
  profileVotesUsed: number;
  remainingWork: boolean;
  work: EnrichmentQueueWorkSummary | null;
  diagnostics: EnrichmentSessionDiagnostics | null;
}

export interface EnrichmentRunOptions {
  /** Retained wire compatibility; production execution is always staged. */
  sessionResidency?: boolean;
  /** Bounded parallel text preparation; embedding and durable chunk commits stay ordered. */
  textPreparationConcurrency?: number;
  /** Explicit task-owned root for sealed restartable generation payloads. */
  stagingRoot?: string;
  /** Explicit runtime adapter for sealed restartable generation payloads. */
  stagedGenerationStore?: EnrichmentStagedGenerationStore;
  readonly signal?: AbortSignal;
  /** Explicit benchmark/debug capture only. */
  telemetry?: PerformanceTelemetrySink;
  telemetryContext?: PerformanceTelemetryContext;
  /** Exact scheduler-owned claim; this always forces queue-backed execution. */
  queueClaim?: PipelineWorkClaimIdentity;
  /** Safe identity/hash-only proof that the claimed production read is exact. */
  onSelectionFingerprint?: (
    fingerprint: EnrichmentQueueSelectionFingerprint,
  ) => void;
}

/**
 * Runs one localhost-triggered enrichment session without repeating source
 * discovery. Each optional chunk remains a separately bounded model batch.
 * The shared pipeline lease remains held through the fresh terminal read and
 * terminal read so no other pipeline writer can observe half-finished state.
 */
export async function runEnrichmentBatch(
  requestedLimit: number,
  requestedChunks = 1,
  runOptions: EnrichmentRunOptions = {},
): Promise<EnrichmentRunSummary> {
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 10) {
    throw new RangeError("enrichment batch limit must be an integer from 1 through 10");
  }
  if (!Number.isSafeInteger(requestedChunks) || requestedChunks < 1 || requestedChunks > 10) {
    throw new RangeError("enrichment chunks must be an integer from 1 through 10");
  }
  throwIfEnrichmentCancelled(runOptions.signal);

  if (!optionalAiCapabilities().enrichment) {
    throw new Error("Optional text enrichment is not configured.");
  }

  await ensureDatabase();
  // The queue-backed staged path is the only admitted production
  // execution. The legacy helper remains isolated for rollback tests but may
  // not bypass cancellation, staging, or mutation-lane suspension here.
  const sessionResidency = true;
  const config = getConfig();
  const textPreparationConcurrency = runOptions.textPreparationConcurrency ??
    config.ai.textPreparationConcurrency;
  if (
    !Number.isSafeInteger(textPreparationConcurrency) ||
    textPreparationConcurrency < 1 ||
    textPreparationConcurrency > 2
  ) {
    throw new RangeError("text preparation concurrency must be an integer from 1 through 2");
  }
  const routeScope = await readActiveRouteScope();
  const providers = createSequentialEnrichmentProviders();
  const target = enrichmentProvenanceTarget(providers);
  const effectiveLimit = boundedEnrichmentLimit(requestedLimit);
  const effectiveChunks = boundedEnrichmentChunks(requestedChunks);
  const runId = await beginEnrichmentRun({
    originPostalCode: routeScope.postalCode,
    requestedLimit,
    effectiveLimit,
    target,
    leaseMs: config.limits.discoveryRunLeaseMs,
  });
  const renewLease = () => renewPipelineRunLease(
    "enrichment",
    runId,
    config.limits.discoveryRunLeaseMs,
  );
  let mutationLeaseHeld = true;
  const suspendMutationLease = async (): Promise<void> => {
    if (!mutationLeaseHeld) return;
    await suspendEnrichmentRunMutationLease(runId);
    mutationLeaseHeld = false;
  };
  const acquireMutationLease = async (
    respectCancellation: boolean,
  ): Promise<void> => {
    if (mutationLeaseHeld) return;
    await acquireEnrichmentRunMutationLease(
      runId,
      config.limits.discoveryRunLeaseMs,
      new Date(),
      {
        waitMs: respectCancellation
          ? 5_000
          : Math.min(config.limits.discoveryRunLeaseMs, 60_000),
        signal: respectCancellation ? runOptions.signal : undefined,
      },
    );
    mutationLeaseHeld = true;
  };
  const withMutationLease = async <T,>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    await acquireMutationLease(true);
    try {
      return await operation();
    } finally {
      await suspendMutationLease();
    }
  };
  const withCleanupMutationLease = async <T,>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    await acquireMutationLease(false);
    try {
      return await operation();
    } finally {
      await suspendMutationLease();
    }
  };

  let batch: EnrichmentSessionSummary | QueueBackedEnrichmentSessionSummary = emptySession(
    requestedLimit,
    effectiveLimit,
    requestedChunks,
    effectiveChunks,
  );
  const profileVotesUsed = 0;
  let durableError: Error | undefined;
  let status: EnrichmentRunSummary["status"] = "failed";

  try {
    await renewLease();
    await readConfiguredAdhocReviewCohort();
    await renewLease();
    batch = sessionResidency
      ? await runQueueBackedEnrichmentSession({
          database: env.DB,
          owner: runId,
          providers,
          originCacheKey: routeScope.originCacheKey,
          routeProviderName: routeScope.providerName,
          requestedLimit,
          requestedChunks,
          suppliedClaim: runOptions.queueClaim,
          preparationConcurrency: textPreparationConcurrency,
          signal: runOptions.signal,
          stagingRoot: runOptions.stagingRoot,
          stagedGenerationStore: runOptions.stagedGenerationStore,
          leaseMs: config.limits.discoveryRunLeaseMs,
          telemetry: runOptions.telemetry,
          telemetryContext: {
            ...runOptions.telemetryContext,
            runId,
          },
          renewPipelineLease: renewLease,
          suspendMutationLease,
          withMutationLease,
          withCleanupMutationLease,
          beforeTerminalRead: async () => {
            await readConfiguredAdhocReviewCohort();
          },
          onSelectionFingerprint: runOptions.onSelectionFingerprint,
        })
      : await runEnrichmentBacklogSession({
          originCacheKey: routeScope.originCacheKey,
          routeProviderName: routeScope.providerName,
          requestedLimit,
          requestedChunks,
          providers,
          renewLease,
          beforeTerminalRead: async () => {
            await readConfiguredAdhocReviewCohort();
          },
        });

    const cancelled = runOptions.signal?.aborted === true ||
      batch.errorMessage === "enrichment_cancelled";
    if (cancelled) {
      durableError = new EnrichmentCancelledError();
    } else if (batch.circuitOpen) {
      durableError = new EnrichmentBacklogError(batch);
    }

    if (
      !durableError &&
      batch.remaining === 0 &&
      !batch.terminalReadPerformed
    ) {
      durableError = new Error(
        "The enrichment session cannot finalize without a fresh terminal queue read",
      );
    }

    status = cancelled
      ? "stopped"
      : durableError
      ? batch.completed > 0 ? "partial" : "failed"
      : "completed";
  } catch (error) {
    const cancelled = runOptions.signal?.aborted === true ||
      error instanceof EnrichmentCancelledError;
    durableError = cancelled
      ? new EnrichmentCancelledError()
      : namedError(
          "EnrichmentRunError",
          error,
          "Enrichment batch failed before completing a listing",
        );
    status = cancelled ? "stopped" : "failed";
  }

  await acquireMutationLease(false);
  await finishEnrichmentRun(
    runId,
    status,
    {
      pendingAtStart: batch.pendingAtStart,
      attempted: batch.attempted,
      completed: batch.completed,
      failures: durableError && batch.failures === 0 ? 1 : batch.failures,
      remaining: batch.remaining,
      profileVotesUsed,
    },
    durableError,
    runOptions.queueClaim === undefined ? [] : [runOptions.queueClaim],
  );
  mutationLeaseHeld = false;

  const queueSummary = isQueueBackedEnrichmentSummary(batch) ? batch : null;
  return {
    runId,
    status,
    originPostalCode: routeScope.postalCode,
    ...batch,
    failures: durableError && batch.failures === 0 ? 1 : batch.failures,
    circuitOpen: Boolean(durableError) || batch.circuitOpen,
    errorMessage: durableError?.message ?? batch.errorMessage,
    profileVotesUsed,
    remainingWork: queueSummary === null
      ? batch.remaining > 0
      : queueSummary.remainingWork,
    work: queueSummary?.work ?? null,
    diagnostics: queueSummary?.diagnostics ?? null,
  };
}

function isQueueBackedEnrichmentSummary(
  summary: EnrichmentSessionSummary | QueueBackedEnrichmentSessionSummary,
): summary is QueueBackedEnrichmentSessionSummary {
  return "work" in summary && "remainingWork" in summary;
}

function emptySession(
  requestedLimit: number,
  effectiveLimit: number,
  requestedChunks: number,
  effectiveChunks: number,
): EnrichmentSessionSummary {
  return {
    requestedLimit,
    effectiveLimit,
    requestedChunks,
    effectiveChunks,
    chunksAttempted: 0,
    chunksCompleted: 0,
    terminalReadPerformed: false,
    pendingAtStart: 0,
    attempted: 0,
    completed: 0,
    failures: 0,
    remaining: 0,
    circuitOpen: false,
    failedItemId: null,
    errorMessage: null,
  };
}

function namedError(name: string, error: unknown, fallback: string): Error {
  const wrapped = new Error(error instanceof Error ? error.message : fallback);
  wrapped.name = name;
  return wrapped;
}
