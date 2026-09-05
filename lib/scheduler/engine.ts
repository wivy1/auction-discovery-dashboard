import {
  estimatedRemainingMs,
  selectScheduleBatch,
  updateSchedulerEwma,
  type ScheduleStrategy,
} from "./critical-path";
import { MutationFifo } from "./mutation-fifo";
import {
  CORE_PREPARATION_WORK_STAGES,
  MAINTENANCE_PREPARATION_WORK_STAGES,
  SCHEDULER_SCHEMA_VERSION,
  SCHEDULER_ENRICHMENT_PROGRESS_SCOPE,
  type SchedulerAcquiredBundle,
  type SchedulerCandidate,
  type SchedulerDecision,
  type SchedulerEnrichmentProgress,
  type SchedulerHandler,
  type SchedulerHandlerRegistry,
  type SchedulerProgressEvent,
  type SchedulerProgressPhase,
  type SchedulerPrimaryImageProgress,
  type SchedulerPrimaryImageSession,
  type SchedulerPreferenceV2Progress,
  type SchedulerPreferenceV2SessionDiagnostics,
  type SchedulerPreparationScopeProgress,
  type SchedulerProximityProgress,
  type SchedulerRunOptions,
  type SchedulerRunResult,
  type SchedulerPreparationScope,
  type SchedulerSourceCampaignOutcome,
  type SchedulerSourceCampaignOutcomeKind,
  type SchedulerSourceCampaignPolicy,
  type SchedulerSnapshot,
  type SchedulerSourceHeadEvidence,
  type SchedulerTailClassification,
  type SchedulerTimingEstimate,
  type SchedulerWorkOutcome,
  type SchedulerWorkSource,
} from "./types";
import { hashCanonicalJson } from "../performance/generations";
import type { PreferenceV2ScorerErrorEnvelope } from
  "../preference-v2/scorer-error";
import type {
  PerformanceTelemetryContext,
  PerformanceTelemetrySink,
} from "../performance/telemetry";

interface ExecutedWork {
  readonly candidate: SchedulerCandidate;
  readonly outcome: SchedulerWorkOutcome;
  readonly timing: SchedulerTimingEstimate;
  readonly requestAcquireMs: number;
  readonly parseValidationMs: number;
  readonly callbackQueueMs: number;
  readonly commitMs: number;
  readonly writerOccupancyMs: number;
}

interface RuntimeTimingState {
  timing: SchedulerTimingEstimate;
  samples: number;
  writerOccupancyMs: number;
}

const HANDLER_FAILURE_REASON_CODE = "scheduler_handler_failure";
export const WORKFLOW_DEADLINE_SETTLEMENT_RESERVE_EXHAUSTED =
  "workflow_deadline_settlement_reserve_exhausted" as const;
export const SCHEDULER_GRACEFUL_STOP_REQUESTED =
  "scheduler_graceful_stop_requested" as const;
const DEFAULT_BATCH_HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_BATCH_HEARTBEAT_INTERVAL_MS = 60_000;
const BATCH_HEARTBEAT_MESSAGE =
  "Durable discovery callback is still running; exact source progress updates when it returns.";
const DEFAULT_MAX_CAMPAIGN_WAIT_MS = 30 * 60_000;
const MAX_SOURCE_ATTEMPTS = 2;
const EMPTY_PROXIMITY_PROGRESS: SchedulerProximityProgress = Object.freeze({
  queued: null,
  claimed: null,
  completed: null,
  stale: null,
  remaining: null,
});
const EMPTY_ENRICHMENT_PROGRESS: SchedulerEnrichmentProgress = Object.freeze({
  scope: SCHEDULER_ENRICHMENT_PROGRESS_SCOPE,
  queued: null,
  claimed: null,
  completed: null,
  stale: null,
  remaining: null,
});
const EMPTY_PREPARATION_SCOPE_PROGRESS: SchedulerPreparationScopeProgress =
  Object.freeze({ ready: 0, deferred: 0, claimed: 0, remaining: 0 });
const CORE_PREPARATION_STAGE_SET = new Set<string>(CORE_PREPARATION_WORK_STAGES);
const MAINTENANCE_PREPARATION_STAGE_SET = new Set<string>(
  MAINTENANCE_PREPARATION_WORK_STAGES,
);

export async function runNightlyScheduler(input: {
  readonly workSource: SchedulerWorkSource;
  readonly handlerRegistry: SchedulerHandlerRegistry;
  readonly options?: SchedulerRunOptions;
  /** Explicit benchmark/debug capture only; ordinary scheduler calls omit it. */
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
  /** Fixed order exists only for like-for-like performance comparisons. */
  readonly strategy?: ScheduleStrategy;
  /** Stops admission after the current started batch has fully settled. */
  readonly signal?: AbortSignal;
}): Promise<SchedulerRunResult> {
  const maximum = input.options?.maxConcurrentNetworkJobs ?? 3;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 3) {
    throw new RangeError("nightly scheduler permits one through three network jobs");
  }
  const maxDispatches = input.options?.maxDispatches ?? 100;
  if (!Number.isSafeInteger(maxDispatches) || maxDispatches < 1 || maxDispatches > 10_000) {
    throw new RangeError("nightly scheduler dispatch limit must be 1..10000");
  }
  const batchHeartbeatIntervalMs = input.options?.batchHeartbeatIntervalMs ??
    DEFAULT_BATCH_HEARTBEAT_INTERVAL_MS;
  if (
    !Number.isSafeInteger(batchHeartbeatIntervalMs) ||
    batchHeartbeatIntervalMs < 1 ||
    batchHeartbeatIntervalMs > MAX_BATCH_HEARTBEAT_INTERVAL_MS
  ) {
    throw new RangeError("nightly scheduler batch heartbeat interval must be 1..60000ms");
  }
  const now = input.options?.now ?? (() => new Date());
  const sleep = input.options?.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxCampaignWaitMs = input.options?.maxCampaignWaitMs ??
    DEFAULT_MAX_CAMPAIGN_WAIT_MS;
  if (
    !Number.isSafeInteger(maxCampaignWaitMs) || maxCampaignWaitMs < 0 ||
    maxCampaignWaitMs > DEFAULT_MAX_CAMPAIGN_WAIT_MS
  ) {
    throw new RangeError("nightly scheduler campaign wait limit must be 0..1800000ms");
  }
  const deadlineAtMs = input.options?.deadlineAtMs;
  if (
    deadlineAtMs !== undefined &&
    (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 0)
  ) {
    throw new RangeError("nightly scheduler deadline must be an absolute epoch millisecond");
  }
  const minimumSettlementReserveMs = input.options?.minimumSettlementReserveMs ?? 0;
  if (
    !Number.isSafeInteger(minimumSettlementReserveMs) ||
    minimumSettlementReserveMs < 0
  ) {
    throw new RangeError("nightly scheduler settlement reserve must be a nonnegative integer");
  }
  const preparationScope = input.options?.preparationScope ?? "all";
  if (
    preparationScope !== "all" && preparationScope !== "core" &&
    preparationScope !== "maintenance"
  ) {
    throw new RangeError("nightly scheduler preparation scope is invalid");
  }
  const sourceCampaignPolicies = validateSourceCampaignPolicies(
    input.options?.sourceCampaignPolicies,
  );
  const sourceCampaignPolicyById = new Map(
    sourceCampaignPolicies.map((policy) => [policy.sourceId, policy]),
  );
  const schedulerStartedAt = performance.now();
  input.telemetry?.record({
    context: input.telemetryContext,
    details: {
      kind: "stage",
      stage: "nightly_scheduler",
      outcome: "started",
    },
  });
  const mutationFifo = new MutationFifo();
  // Work IDs are stable across coalesced input revisions. Suppress only the
  // exact completed revision so a callback that exposes newer invalidation in
  // the same nightly remains visible and drainable.
  const completedCandidateKeys = new Set<string>();
  const dependencySatisfiedSourceIds = new Set<string>();
  const terminalSourceIds = new Set<string>();
  const sourceOutcomes = new Map<string, SchedulerSourceCampaignOutcome>();
  const sourcePriorHeads = new Map<string, SchedulerSourceHeadEvidence | null>();
  const sourceAttemptCounts = new Map<string, number>();
  const sourceNonAdvancingAttempts = new Map<string, number>();
  const sourceRetryAvailableAt = new Map<string, string>();
  let campaignWaitedMs = 0;
  const attemptedSourceIds = new Set<string>();
  const decisions: SchedulerDecision[] = [];
  const tailReasons = new Set<string>();
  let decisionSequence = 0;
  let boundedReads = 0;
  let dispatched = 0;
  let completed = 0;
  let deterministicTerminals = 0;
  let sourceRequests = 0;
  let lastClassification: SchedulerTailClassification = "clean_empty";
  let lastCandidates: readonly SchedulerCandidate[] = [];
  const timingByCandidate = new Map<string, RuntimeTimingState>();
  const candidateByKey = new Map<string, SchedulerCandidate>();
  const candidateKindById = new Map<string, SchedulerCandidate["kind"]>();
  const skippedRounds = new Map<string, number>();
  let writerOccupancyMs = 0;
  let activeValidations = 0;
  let maxConcurrentValidations = 0;
  let activeCommits = 0;
  let maxConcurrentCommits = 0;
  let sourceCommitObservationCount = 0;
  let preparationCommitObservationCount = 0;
  const preparationProgressCandidateIds = new Set<string>();
  const preparationNoProgressIdentities = new Set<string>();
  let proximityProgress = EMPTY_PROXIMITY_PROGRESS;
  let primaryImageProgress: SchedulerPrimaryImageProgress = Object.freeze({
    ready: 0,
    deferred: 0,
    claimed: 0,
    remaining: 0,
  });
  let primaryImageSession: SchedulerPrimaryImageSession | null = null;
  let enrichmentProgress = EMPTY_ENRICHMENT_PROGRESS;
  let preferenceV2Progress: SchedulerPreferenceV2Progress | null = null;
  let preferenceV2SessionDiagnostics: SchedulerPreferenceV2SessionDiagnostics | null = null;
  let preferenceV2ScorerError: PreferenceV2ScorerErrorEnvelope | null = null;
  let coreProgress = EMPTY_PREPARATION_SCOPE_PROGRESS;
  let maintenanceProgress = EMPTY_PREPARATION_SCOPE_PROGRESS;
  let deadlineBoundaryReached = false;
  let gracefulStopBoundaryReached = false;
  const snapshotBoundaries: Array<Readonly<{
    generation: string;
    candidates: readonly Readonly<{
      id: string;
      kind: SchedulerCandidate["kind"];
      revision: number;
      inputHash: string | null;
    }>[];
  }>> = [];
  let lastKnownRemainingUnits = 0;
  let lastKnownCandidates: readonly SchedulerCandidate[] = [];
  const reportProgress = (
    phase: SchedulerProgressPhase,
    candidates: readonly SchedulerCandidate[],
    message: string,
    current: SchedulerCandidate | null = null,
    remainingUnits = lastKnownRemainingUnits,
    state: SchedulerProgressEvent["state"] = "running",
  ): void => {
    const event = schedulerProgressEvent({
      phase,
      state,
      candidates,
      current,
      completedWorkUnits: completedCandidateKeys.size,
      remainingWorkUnits: remainingUnits,
      proximityProgress,
      coreProgress,
      maintenanceProgress,
      primaryImageProgress,
      primaryImageSession,
      enrichmentProgress,
      preferenceV2Progress,
      preferenceV2SessionDiagnostics,
      preferenceV2ScorerError,
      attemptedSourceIds,
      completedSourceIds: dependencySatisfiedSourceIds,
      terminalSourceIds,
      maxConcurrentNetworkJobs: maximum,
      message,
    });
    try {
      input.options?.onProgress?.(event);
    } catch {
      // Status reporting is deliberately fail-soft and cannot change scheduling.
    }
  };
  const readSnapshot = async () => {
    const startedAt = performance.now();
    const snapshot = schedulerSnapshotForPreparationScope(
      await input.workSource.readSnapshot(),
      preparationScope,
    );
    primaryImageProgress = snapshot.remainingWork?.primaryImages ?? Object.freeze({
      ready: 0,
      deferred: 0,
      claimed: 0,
      remaining: 0,
    });
    const snapshotEnrichment = snapshot.remainingWork?.enrichment;
    if (snapshot.remainingWork !== undefined) {
      coreProgress = preparationScopeProgress(
        snapshot.remainingWork.coreReady,
        snapshot.remainingWork.coreDeferred,
        snapshot.remainingWork.coreClaimed,
      );
      maintenanceProgress = preparationScopeProgress(
        snapshot.remainingWork.maintenanceReady,
        snapshot.remainingWork.maintenanceDeferred,
        snapshot.remainingWork.maintenanceClaimed,
      );
    }
    if (snapshotEnrichment !== undefined) {
      enrichmentProgress = Object.freeze({
        ...snapshotEnrichment,
        completed: enrichmentProgress.completed,
        stale: enrichmentProgress.stale,
      });
    }
    input.telemetry?.record({
      context: input.telemetryContext,
      details: {
        kind: "queue",
        operation: "snapshot",
        stage: "nightly_scheduler",
        created: 0,
        upserted: 0,
        selected: snapshot.candidates.length,
        claimed: 0,
        completed: 0,
        deferred: 0,
        failed: 0,
        reclaimed: 0,
        remaining: snapshot.candidates.length,
        statements: snapshot.boundedReadCount,
        batches: 0,
        durationMs: performance.now() - startedAt,
      },
    });
    return snapshot;
  };
  const settlementReserveForCandidate = (candidate: SchedulerCandidate): number => {
    const candidateReserve = input.options?.minimumSettlementReserveForCandidateMs?.(
      candidate,
    ) ?? minimumSettlementReserveMs;
    if (!Number.isSafeInteger(candidateReserve) || candidateReserve < 0) {
      throw new RangeError(
        "nightly scheduler candidate settlement reserve must be a nonnegative integer",
      );
    }
    return Math.max(minimumSettlementReserveMs, candidateReserve);
  };
  const deadlineAdmits = (reserveMs: number, delayMs = 0): boolean => {
    if (deadlineAtMs === undefined) return true;
    const nowMs = now().getTime();
    if (!Number.isFinite(nowMs)) {
      throw new RangeError("nightly scheduler clock returned an invalid timestamp");
    }
    return nowMs + delayMs + reserveMs <= deadlineAtMs;
  };
  const reachDeadlineBoundary = (): void => {
    deadlineBoundaryReached = true;
    tailReasons.add(WORKFLOW_DEADLINE_SETTLEMENT_RESERVE_EXHAUSTED);
    lastClassification = "checkpoint_paused";
  };
  const reachGracefulStopBoundary = (): void => {
    gracefulStopBoundaryReached = true;
    lastClassification = "checkpoint_paused";
    tailReasons.add(SCHEDULER_GRACEFUL_STOP_REQUESTED);
  };
  const appendDecision = (
    candidate: SchedulerCandidate,
    action: SchedulerDecision["action"],
    reasonCode: string | null,
  ): void => {
    const entry = decision(++decisionSequence, candidate, action, reasonCode);
    decisions.push(entry);
    input.telemetry?.record({
      context: {
        ...input.telemetryContext,
        sourceId: candidate.sourceId,
      },
      details: {
        kind: "scheduler",
        dependencyDecision: action,
        laneKey: candidate.networkLanes.join("+"),
        estimatedRemainingMs: entry.estimatedRemainingMs,
        fairnessQuantum: candidate.fairnessQuantum,
      },
    });
  };
  const recordSourceOutcome = (
    candidate: SchedulerCandidate,
    outcome: SchedulerSourceCampaignOutcomeKind,
    reasonCode: string,
    nextEligibleAt: string | null = null,
    refreshed?: SchedulerWorkOutcome & { readonly classification: "completed" },
  ): void => {
    if (!sourceCampaignPolicyById.has(candidate.sourceId) ||
        sourceOutcomes.has(candidate.sourceId)) return;
    const priorHead = candidate.sourceInput?.priorHead ??
      sourcePriorHeads.get(candidate.sourceId) ?? null;
    sourcePriorHeads.set(candidate.sourceId, priorHead);
    const boundary = refreshed?.sourceBoundary;
    const isRefreshed = outcome === "refreshed" && boundary?.outcome === "refreshed";
    const recent = outcome === "skipped_recent"
      ? candidate.sourceInput?.recentPublicationSkip ?? null
      : null;
    if (outcome === "skipped_recent" && recent === null) {
      throw new Error("recent publication skip evidence is missing");
    }
    const dependencySatisfied = isRefreshed || recent !== null;
    const truthfulOutcome = outcome === "preserved" && priorHead === null
      ? "stopped" as const
      : outcome;
    const entry: SchedulerSourceCampaignOutcome = Object.freeze({
      sourceId: candidate.sourceId,
      outcome: truthfulOutcome,
      dependencySatisfied,
      reasonCode: boundedReasonCode(reasonCode),
      priorHead: isRefreshed ? boundary.priorHead : recent?.head ?? priorHead,
      resultingHead: isRefreshed ? boundary.resultingHead : recent?.head ?? null,
      nextEligibleAt: truthfulOutcome === "paused" ? validNextEligibleAt(nextEligibleAt) : null,
      proofIdentity: isRefreshed
        ? boundedIdentity(boundary.proofIdentity)
        : recent === null ? null : boundedIdentity(recent.proofIdentity),
      receiptIdentity: isRefreshed
        ? boundedIdentity(boundary.receiptIdentity)
        : recent === null ? null : boundedIdentity(recent.receiptIdentity),
    });
    sourceOutcomes.set(candidate.sourceId, entry);
    terminalSourceIds.add(candidate.sourceId);
    completedCandidateKeys.add(candidateCompletionKey(candidate));
    if (entry.dependencySatisfied) dependencySatisfiedSourceIds.add(candidate.sourceId);
  };
  const prepareCampaignCandidates = (
    rawCandidates: readonly SchedulerCandidate[],
  ): readonly SchedulerCandidate[] => {
    const prepared: SchedulerCandidate[] = [];
    for (const candidate of rawCandidates) {
      if (candidate.kind !== "source_acquisition" ||
          !sourceCampaignPolicyById.has(candidate.sourceId)) {
        prepared.push(candidate);
        continue;
      }
      sourcePriorHeads.set(
        candidate.sourceId,
        candidate.sourceInput?.priorHead ?? sourcePriorHeads.get(candidate.sourceId) ?? null,
      );
      if (terminalSourceIds.has(candidate.sourceId)) continue;
      const policy = sourceCampaignPolicyById.get(candidate.sourceId)!;
      const failedDependencies = policy.dependencies.filter((dependency) =>
        terminalSourceIds.has(dependency) && !dependencySatisfiedSourceIds.has(dependency)
      );
      if (failedDependencies.length > 0) {
        const reason = `dependency_not_refreshed:${failedDependencies.join("+")}`;
        appendDecision(candidate, "dependency_blocked", reason);
        recordSourceOutcome(candidate, "blocked", reason);
        continue;
      }
      const recentPublicationSkip = candidate.sourceInput?.recentPublicationSkip ?? null;
      const dependenciesSatisfied = policy.dependencies.every((dependency) =>
        dependencySatisfiedSourceIds.has(dependency)
      ) && (policy.terminalDependencies ?? []).every((dependency) =>
        terminalSourceIds.has(dependency)
      );
      if (recentPublicationSkip !== null && dependenciesSatisfied) {
        const retainedHead = candidate.sourceInput?.priorHead ?? null;
        if (
          candidate.sourceInput?.coverageMode !== "complete_current" ||
          retainedHead === null ||
          retainedHead.inventoryRunId !== recentPublicationSkip.head.inventoryRunId ||
          retainedHead.listingCount !== recentPublicationSkip.head.listingCount
        ) {
          throw new Error("recent publication skip does not match the current source head");
        }
        appendDecision(
          candidate,
          "recent_publication_skipped",
          recentPublicationSkip.reasonCode,
        );
        recordSourceOutcome(
          candidate,
          "skipped_recent",
          recentPublicationSkip.reasonCode,
        );
        continue;
      }
      const retryAt = sourceRetryAvailableAt.get(candidate.sourceId);
      if (candidate.accessState === "manual_reset_required") {
        const reason = candidate.accessReasonCode ?? "manual_reset_required";
        appendDecision(candidate, "access_blocked", reason);
        recordSourceOutcome(candidate, "stopped", reason);
        continue;
      }
      if (candidate.accessState === "cooldown" && retryAt === undefined) {
        const next = candidate.nextEligibleAt;
        const reason = candidate.accessReasonCode ?? "source_cooldown";
        appendDecision(candidate, "access_blocked", reason);
        recordSourceOutcome(
          candidate,
          next === null ? "stopped" : "paused",
          reason,
          next,
        );
        continue;
      }
      prepared.push(Object.freeze({
        ...candidate,
        ...(retryAt === undefined ? {} : {
          accessState: "ready" as const,
          accessReasonCode: null,
          nextEligibleAt: null,
          availableAt: retryAt,
        }),
      }));
    }
    return Object.freeze(prepared);
  };

  while (dispatched < maxDispatches) {
    if (input.signal?.aborted) {
      reachGracefulStopBoundary();
      break;
    }
    if (!deadlineAdmits(minimumSettlementReserveMs)) {
      reachDeadlineBoundary();
      break;
    }
    const snapshot = await readSnapshot();
    if (input.signal?.aborted) {
      reachGracefulStopBoundary();
      break;
    }
    snapshotBoundaries.push(schedulerSnapshotBoundary(snapshot));
    boundedReads += snapshot.boundedReadCount;
    const candidates = prepareCampaignCandidates(snapshot.candidates.filter(
      (candidate) => !completedCandidateKeys.has(candidateCompletionKey(candidate)),
    ).map((candidate) => runtimeCandidate(
      candidate,
      timingByCandidate.get(candidateCompletionKey(candidate))?.timing,
      skippedRounds.get(candidateCompletionKey(candidate)) ?? candidate.skippedRounds,
    )));
    lastKnownRemainingUnits = sourceCampaignPolicies.length > 0
      ? Math.max(0, sourceCampaignPolicies.length - terminalSourceIds.size)
      : schedulerRemainingWorkUnits(snapshot, candidates.length, preparationScope);
    lastKnownCandidates = candidates;
    reportProgress(
      "snapshot",
      candidates,
      candidates.length === 0
        ? "Scheduler snapshot has no visible work."
        : `Scheduler snapshot exposes ${candidates.length} runnable or blocked candidate${candidates.length === 1 ? "" : "s"}.`,
      progressCurrentCandidate(candidates),
    );
    if (input.signal?.aborted) {
      reachGracefulStopBoundary();
      break;
    }
    for (const candidate of candidates) {
      candidateByKey.set(candidateCompletionKey(candidate), candidate);
      candidateKindById.set(candidate.id, candidate.kind);
    }
    lastCandidates = candidates;
    if (candidates.length === 0) {
      const fresh = await readSnapshot();
      snapshotBoundaries.push(schedulerSnapshotBoundary(fresh));
      boundedReads += fresh.boundedReadCount;
      const freshCandidates = prepareCampaignCandidates(fresh.candidates.filter(
        (candidate) => !completedCandidateKeys.has(candidateCompletionKey(candidate)),
      ).map((candidate) => runtimeCandidate(
        candidate,
        timingByCandidate.get(candidateCompletionKey(candidate))?.timing,
        skippedRounds.get(candidateCompletionKey(candidate)) ?? candidate.skippedRounds,
      )));
      lastKnownRemainingUnits = sourceCampaignPolicies.length > 0
        ? Math.max(0, sourceCampaignPolicies.length - terminalSourceIds.size)
        : schedulerRemainingWorkUnits(fresh, freshCandidates.length, preparationScope);
      lastKnownCandidates = freshCandidates;
      reportProgress(
        "snapshot",
        freshCandidates,
        freshCandidates.length === 0
          ? "Confirmation snapshot has no visible work."
          : `Confirmation snapshot exposes ${freshCandidates.length} candidate${freshCandidates.length === 1 ? "" : "s"}.`,
        progressCurrentCandidate(freshCandidates),
      );
      if (freshCandidates.length === 0) {
        if (sourceCampaignPolicies.length > 0 &&
            terminalSourceIds.size < sourceCampaignPolicies.length) {
          lastClassification = "no_progress";
          break;
        }
        if (lastClassification !== "deterministic_terminal") {
          lastClassification = emptyScopeClassification(fresh, preparationScope);
        }
        lastCandidates = [];
        break;
      }
      lastCandidates = freshCandidates;
      continue;
    }

    const selection = selectScheduleBatch({
      candidates,
      completedSourceIds: dependencySatisfiedSourceIds,
      terminalSourceIds,
      maxConcurrentNetworkJobs: Math.min(maximum, maxDispatches - dispatched),
      now: now(),
      strategy: input.strategy,
    });
    for (const candidate of selection.dependencyBlocked) {
      appendDecision(
        candidate,
        "dependency_blocked",
        "dependency_not_terminal",
      );
    }
    for (const candidate of selection.laneBlocked) {
      appendDecision(candidate, "lane_blocked", "lane_busy");
    }
    for (const candidate of selection.accessBlocked) {
      const reason = candidate.accessReasonCode ?? candidate.accessState;
      tailReasons.add(reason);
      appendDecision(candidate, "access_blocked", reason);
    }
    for (const candidate of selection.futureDeferred) {
      appendDecision(
        candidate,
        "future_deferred",
        "not_yet_available",
      );
    }

    if (selection.selected.length === 0) {
      const deferredSources = selection.futureDeferred.filter((candidate) =>
        candidate.kind === "source_acquisition" &&
        sourceCampaignPolicyById.has(candidate.sourceId)
      );
      if (deferredSources.length > 0) {
        const next = earliestAvailableAt(deferredSources);
        const delay = next === null ? Number.POSITIVE_INFINITY
          : Math.max(0, Date.parse(next) - now().getTime());
        if (
          Number.isFinite(delay) && campaignWaitedMs + delay <= maxCampaignWaitMs &&
          deadlineAdmits(minimumSettlementReserveMs, delay)
        ) {
          if (delay > 0) await sleep(delay);
          campaignWaitedMs += delay;
          continue;
        }
        if (
          Number.isFinite(delay) && campaignWaitedMs + delay <= maxCampaignWaitMs &&
          !deadlineAdmits(minimumSettlementReserveMs, delay)
        ) {
          reachDeadlineBoundary();
          break;
        }
        for (const candidate of deferredSources) {
          const nextEligibleAt = sourceRetryAvailableAt.get(candidate.sourceId) ??
            candidate.availableAt;
          recordSourceOutcome(
            candidate,
            "paused",
            "source_retry_wait_budget_exhausted",
            nextEligibleAt,
          );
        }
        continue;
      }
      lastClassification = classifyBlockedSelection(selection);
      break;
    }

    const selectedKeys = new Set(selection.selected.map(candidateCompletionKey));
    for (const candidate of candidates) {
      const key = candidateCompletionKey(candidate);
      skippedRounds.set(key, selectedKeys.has(key)
        ? 0
        : (skippedRounds.get(key) ?? candidate.skippedRounds) + 1);
    }

    const executable: Array<{ candidate: SchedulerCandidate; handler: SchedulerHandler }> = [];
    let deadlineDeferred = false;
    for (const candidate of selection.selected) {
      const handler = input.handlerRegistry.resolve(candidate);
      if (handler === null || !handler.ready) {
        const reason = handler?.readinessReasonCode ?? "handler_unregistered";
        tailReasons.add(reason);
        appendDecision(
          candidate,
          "handler_not_ready",
          reason,
        );
        if (
          candidate.kind === "source_acquisition" &&
          sourceCampaignPolicyById.has(candidate.sourceId)
        ) recordSourceOutcome(candidate, "preserved", reason);
      } else if (!deadlineAdmits(settlementReserveForCandidate(candidate))) {
        deadlineDeferred = true;
        tailReasons.add(WORKFLOW_DEADLINE_SETTLEMENT_RESERVE_EXHAUSTED);
        appendDecision(
          candidate,
          "deadline_deferred",
          WORKFLOW_DEADLINE_SETTLEMENT_RESERVE_EXHAUSTED,
        );
      } else {
        executable.push({ candidate, handler });
        appendDecision(candidate, "selected", null);
      }
    }

    const critical = executable.reduce<SchedulerCandidate | null>((current, entry) =>
      current === null || estimatedRemainingMs(entry.candidate.timing) >
          estimatedRemainingMs(current.timing)
        ? entry.candidate
        : current
    , null);
    if (critical !== null) {
      const observedAt = now().toISOString();
      input.telemetry?.record({
        context: {
          ...input.telemetryContext,
          sourceId: critical.sourceId,
        },
        details: {
          kind: "critical_path",
          sourceOrLane: critical.networkLanes.join("+"),
          estimatedRemainingMs: estimatedRemainingMs(critical.timing),
          observedAt,
        },
      });
    }
    if (executable.length === 0) {
      if (deadlineDeferred) {
        reachDeadlineBoundary();
        break;
      }
      if (sourceCampaignPolicies.length > 0) continue;
      lastClassification = "handler_not_ready";
      break;
    }

    for (const { candidate } of executable) {
      if (candidate.kind === "source_acquisition") {
        attemptedSourceIds.add(candidate.sourceId);
        if (sourceCampaignPolicyById.has(candidate.sourceId)) {
          sourceAttemptCounts.set(
            candidate.sourceId,
            (sourceAttemptCounts.get(candidate.sourceId) ?? 0) + 1,
          );
        }
      }
    }
    const batchCurrent = critical ?? executable[0]!.candidate;
    reportProgress(
      "batch_started",
      candidates,
      `Started a durable batch of ${executable.length} candidate${executable.length === 1 ? "" : "s"}.`,
      batchCurrent,
    );
    dispatched += executable.length;
    sourceRequests += executable.filter(({ candidate }) =>
      candidate.kind === "source_acquisition"
    ).length;
    const batchPromise = Promise.all(executable.map(async ({ candidate, handler }) => {
      let commitStarted = false;
      let reserveOperationMs = 0;
      let commitOperationMs = 0;
      let requestAcquireMs = 0;
      let parseValidationMs = 0;
      let reserveQueueMs = 0;
      let commitQueueMs = 0;
      let acquireObserved = false;
      let validationObserved = false;
      let commitObserved = false;
      const reserveQueuedAt = performance.now();
      try {
        const reservation = (await mutationFifo.run(
          `reserve:${candidate.id}`,
          async () => {
            const startedAt = performance.now();
            reserveQueueMs = Math.max(0, startedAt - reserveQueuedAt);
            try {
              return await handler.reserve(candidate);
            } finally {
              reserveOperationMs = performance.now() - startedAt;
            }
          },
        )).value;
        const reserveFinishedAt = performance.now();
        reserveQueueMs = Math.max(
          0,
          reserveFinishedAt - reserveQueuedAt - reserveOperationMs,
        );
        const acquireStartedAt = performance.now();
        let acquired: unknown;
        try {
          acquired = await handler.acquire(candidate, reservation);
        } finally {
          requestAcquireMs = performance.now() - acquireStartedAt;
          acquireObserved = true;
        }
        const validationStartedAt = performance.now();
        activeValidations += 1;
        maxConcurrentValidations = Math.max(maxConcurrentValidations, activeValidations);
        let bundle: SchedulerAcquiredBundle;
        try {
          bundle = await handler.validate(candidate, reservation, acquired);
        } finally {
          parseValidationMs = performance.now() - validationStartedAt;
          validationObserved = true;
          activeValidations -= 1;
        }
        commitStarted = true;
        const commitQueuedAt = performance.now();
        const outcome = (await mutationFifo.run(
          `commit:${candidate.id}`,
          async () => {
            const startedAt = performance.now();
            commitQueueMs = Math.max(0, startedAt - commitQueuedAt);
            activeCommits += 1;
            if (candidate.kind === "source_acquisition") {
              sourceCommitObservationCount += 1;
            } else {
              preparationCommitObservationCount += 1;
            }
            maxConcurrentCommits = Math.max(maxConcurrentCommits, activeCommits);
            try {
              return await handler.commit(candidate, reservation, bundle);
            } finally {
              commitOperationMs = performance.now() - startedAt;
              commitObserved = true;
              activeCommits -= 1;
            }
          },
        )).value;
        const commitFinishedAt = performance.now();
        commitQueueMs = Math.max(
          0,
          commitFinishedAt - commitQueuedAt - commitOperationMs,
        );
        const callbackQueueMs = reserveQueueMs + commitQueueMs;
        const occupied = reserveOperationMs + commitOperationMs;
        const priorTiming = timingByCandidate.get(candidateCompletionKey(candidate))?.timing ??
          candidate.timing;
        const timing = updateSchedulerEwma({
          previous: {
            ...priorTiming,
            remainingRequests: Math.max(0,
              priorTiming.remainingRequests - (bundle.metrics?.requestsConsumed ??
                (candidate.kind === "source_acquisition" ? 1 : 0))),
            remainingPages: Math.max(0,
              priorTiming.remainingPages - (bundle.metrics?.pagesConsumed ?? 1)),
          },
          observed: {
            requestEwmaMs: requestAcquireMs,
            parseEwmaMs: parseValidationMs,
            callbackEwmaMs: callbackQueueMs,
            commitEwmaMs: commitOperationMs,
          },
        });
        return Object.freeze({
          candidate,
          outcome,
          timing,
          requestAcquireMs,
          parseValidationMs,
          callbackQueueMs,
          commitMs: commitOperationMs,
          writerOccupancyMs: occupied,
        });
      } catch (error) {
        const stateAmbiguous = handlerFailureIsStateAmbiguous(error);
        const priorHeadPreserved = !stateAmbiguous &&
          (!commitStarted || handlerFailurePreservesPriorHead(error));
        const priorTiming = timingByCandidate.get(candidateCompletionKey(candidate))?.timing ??
          candidate.timing;
        const callbackQueueMs = reserveQueueMs + commitQueueMs;
        const timing = updateSchedulerEwma({
          previous: priorTiming,
          observed: {
            requestEwmaMs: acquireObserved
              ? requestAcquireMs
              : priorTiming.requestEwmaMs,
            parseEwmaMs: validationObserved
              ? parseValidationMs
              : priorTiming.parseEwmaMs,
            callbackEwmaMs: callbackQueueMs > 0
              ? callbackQueueMs
              : priorTiming.callbackEwmaMs,
            commitEwmaMs: commitObserved
              ? commitOperationMs
              : priorTiming.commitEwmaMs,
          },
        });
        return Object.freeze({
          candidate,
          outcome: Object.freeze({
            classification: priorHeadPreserved
              ? "handler_failure_prior_head_preserved" as const
              : "handler_failure_state_ambiguous" as const,
            madeProgress: false as const,
            remaining: true as const,
            reasonCode: handlerFailureReasonCode(error),
          }),
          timing,
          requestAcquireMs,
          parseValidationMs,
          callbackQueueMs,
          commitMs: commitOperationMs,
          writerOccupancyMs: reserveOperationMs + commitOperationMs,
        });
      }
    }));
    const heartbeat = setInterval(() => {
      reportProgress(
        "batch_heartbeat",
        candidates,
        BATCH_HEARTBEAT_MESSAGE,
        batchCurrent,
      );
    }, batchHeartbeatIntervalMs);
    const results = await (async () => {
      try {
        return await batchPromise;
      } finally {
        clearInterval(heartbeat);
      }
    })();
    await mutationFifo.idle();

    let madeProgress = false;
    let stateAmbiguous = false;
    const completedBeforeAccounting = completedCandidateKeys.size;
    for (const result of results) {
      if (
        result.candidate.stage === "proximity" &&
        "proximityProgress" in result.outcome &&
        result.outcome.proximityProgress !== undefined
      ) {
        proximityProgress = result.outcome.proximityProgress;
      }
      if (
        result.candidate.stage === "primary_image" &&
        "primaryImageSession" in result.outcome &&
        result.outcome.primaryImageSession !== undefined
      ) {
        primaryImageSession = result.outcome.primaryImageSession;
      }
      if (
        (result.candidate.stage === "enrichment_text" ||
          result.candidate.stage === "enrichment_embedding") &&
        "enrichmentProgress" in result.outcome &&
        result.outcome.enrichmentProgress !== undefined
      ) {
        enrichmentProgress = result.outcome.enrichmentProgress;
      }
      if (
        result.candidate.stage === "preference_v2_score" &&
        "preferenceV2Progress" in result.outcome &&
        result.outcome.preferenceV2Progress !== undefined
      ) {
        preferenceV2Progress = result.outcome.preferenceV2Progress;
      }
      if (
        result.candidate.stage === "preference_v2_score" &&
        "preferenceV2SessionDiagnostics" in result.outcome &&
        result.outcome.preferenceV2SessionDiagnostics !== undefined
      ) {
        preferenceV2SessionDiagnostics = result.outcome.preferenceV2SessionDiagnostics;
      }
      if (result.candidate.stage === "preference_v2_score") {
        if (
          "preferenceV2ScorerError" in result.outcome &&
          result.outcome.preferenceV2ScorerError !== undefined
        ) {
          preferenceV2ScorerError = result.outcome.preferenceV2ScorerError;
        } else if (
          "preferenceV2Progress" in result.outcome &&
          result.outcome.preferenceV2Progress !== undefined
        ) {
          preferenceV2ScorerError = null;
        }
      }
      const key = candidateCompletionKey(result.candidate);
      const previous = timingByCandidate.get(key);
      timingByCandidate.set(key, {
        timing: result.timing,
        samples: (previous?.samples ?? 0) + 1,
        writerOccupancyMs: (previous?.writerOccupancyMs ?? 0) + result.writerOccupancyMs,
      });
      writerOccupancyMs += result.writerOccupancyMs;
      madeProgress ||= result.outcome.madeProgress;
      if (
        result.candidate.kind === "preparation" &&
        result.outcome.madeProgress
      ) {
        preparationProgressCandidateIds.add(result.candidate.id);
      }
      if (
        result.candidate.kind === "preparation" &&
        !result.outcome.madeProgress &&
        "noProgressIdentity" in result.outcome &&
        result.outcome.noProgressIdentity !== undefined
      ) {
        preparationNoProgressIdentities.add(result.outcome.noProgressIdentity);
      }
      if (result.outcome.classification === "completed") {
        completed += 1;
        if (
          result.candidate.kind === "source_acquisition" &&
          sourceCampaignPolicyById.has(result.candidate.sourceId)
        ) {
          if (result.outcome.sourceBoundary?.outcome !== "refreshed") {
            stateAmbiguous = true;
            tailReasons.add("source_publication_proof_missing");
          } else {
            recordSourceOutcome(
              result.candidate,
              "refreshed",
              "fresh_publication_verified",
              null,
              result.outcome,
            );
            sourceRetryAvailableAt.delete(result.candidate.sourceId);
          }
        } else if (!result.outcome.remaining) {
          completedCandidateKeys.add(candidateCompletionKey(result.candidate));
          if (result.candidate.kind === "source_acquisition") {
            dependencySatisfiedSourceIds.add(result.candidate.sourceId);
          }
        }
      } else if (result.outcome.classification === "deterministic_terminal") {
        deterministicTerminals += 1;
        if (
          result.candidate.kind === "source_acquisition" &&
          sourceCampaignPolicyById.has(result.candidate.sourceId)
        ) recordSourceOutcome(
          result.candidate,
          "preserved",
          "deterministic_terminal_prior_head_preserved",
        );
        else completedCandidateKeys.add(candidateCompletionKey(result.candidate));
        tailReasons.add("deterministic_terminal");
      } else {
        tailReasons.add(result.outcome.reasonCode);
        if (
          result.candidate.kind === "source_acquisition" &&
          sourceCampaignPolicyById.has(result.candidate.sourceId)
        ) {
          const nonAdvancingAttempts = result.outcome.madeProgress
            ? 0
            : (sourceNonAdvancingAttempts.get(result.candidate.sourceId) ?? 0) + 1;
          sourceNonAdvancingAttempts.set(
            result.candidate.sourceId,
            nonAdvancingAttempts,
          );
          if (result.outcome.classification === "handler_failure_state_ambiguous") {
            stateAmbiguous = true;
          } else if (
            (result.outcome.classification === "retryable_pressure" ||
              result.outcome.classification === "access_stop" ||
              result.outcome.classification === "handler_failure_prior_head_preserved") &&
            nonAdvancingAttempts < MAX_SOURCE_ATTEMPTS &&
            !(
              result.outcome.classification === "access_stop" &&
              (result.outcome.availableAt === null ||
                result.outcome.reasonCode === "challenge")
            )
          ) {
            const availableAt = result.outcome.classification === "retryable_pressure" ||
                result.outcome.classification === "access_stop"
              ? result.outcome.availableAt
              : new Date(now().getTime() + 60_000).toISOString();
            if (availableAt !== null) {
              sourceRetryAvailableAt.set(result.candidate.sourceId, availableAt);
            }
          } else if (result.outcome.classification === "access_stop") {
            recordSourceOutcome(
              result.candidate,
              result.outcome.availableAt === null ? "stopped" : "paused",
              result.outcome.reasonCode,
              result.outcome.availableAt,
            );
          } else if (result.outcome.classification === "retryable_pressure") {
            recordSourceOutcome(
              result.candidate,
              "paused",
              result.outcome.reasonCode,
              result.outcome.availableAt,
            );
          } else {
            recordSourceOutcome(
              result.candidate,
              "preserved",
              result.outcome.reasonCode,
            );
          }
        }
      }
    }
    lastKnownRemainingUnits = Math.max(
      0,
      lastKnownRemainingUnits - (completedCandidateKeys.size - completedBeforeAccounting),
    );
    lastKnownCandidates = candidates.filter(
      (candidate) => !completedCandidateKeys.has(candidateCompletionKey(candidate)),
    );
    reportProgress(
      "batch_completed",
      lastKnownCandidates,
      `Accounted for ${results.length} durable batch outcome${results.length === 1 ? "" : "s"}.`,
      batchCurrent,
    );
    lastClassification = classifyOutcomes(results);
    if (input.signal?.aborted) {
      reachGracefulStopBoundary();
      break;
    }
    if (stateAmbiguous) {
      lastClassification = "handler_failure_state_ambiguous";
      break;
    }
    if (sourceCampaignPolicies.length > 0) continue;
    if (!madeProgress || results.some(({ outcome }) =>
      outcome.classification === "access_stop" ||
      outcome.classification === "no_progress" ||
      outcome.classification === "handler_failure_prior_head_preserved" ||
      outcome.classification === "handler_failure_state_ambiguous"
    )) break;
  }

  if (
    dispatched >= maxDispatches && lastCandidates.length > 0 &&
    !deadlineBoundaryReached &&
    lastClassification !== "handler_failure_prior_head_preserved" &&
    lastClassification !== "handler_failure_state_ambiguous" &&
    lastClassification !== "checkpoint_paused" &&
    lastClassification !== "access_stop" &&
    lastClassification !== "no_progress" &&
    lastClassification !== "retryable_pressure"
  ) {
    lastClassification = "bounded_quantum_exhausted";
  }
  let tail: SchedulerSnapshot | null = null;
  try {
    tail = await readSnapshot();
  } catch (error) {
    if (lastClassification !== "handler_failure_state_ambiguous") throw error;
    tailReasons.add("terminal_snapshot_unavailable_after_state_ambiguous");
  }
  let tailCandidates = lastKnownCandidates;
  if (tail !== null) {
    snapshotBoundaries.push(schedulerSnapshotBoundary(tail));
    boundedReads += tail.boundedReadCount;
    tailCandidates = prepareCampaignCandidates(tail.candidates.filter(
      (candidate) => !completedCandidateKeys.has(candidateCompletionKey(candidate)),
    ).map((candidate) => runtimeCandidate(
      candidate,
      timingByCandidate.get(candidateCompletionKey(candidate))?.timing,
      skippedRounds.get(candidateCompletionKey(candidate)) ?? candidate.skippedRounds,
    )));
    lastKnownRemainingUnits = sourceCampaignPolicies.length > 0
      ? Math.max(0, sourceCampaignPolicies.length - terminalSourceIds.size)
      : schedulerRemainingWorkUnits(tail, tailCandidates.length, preparationScope);
    lastKnownCandidates = tailCandidates;
    reportProgress(
      "snapshot",
      tailCandidates,
      tailCandidates.length === 0
        ? "Terminal scheduler snapshot has no visible work."
        : `Terminal scheduler snapshot retains ${tailCandidates.length} candidate${tailCandidates.length === 1 ? "" : "s"}.`,
      progressCurrentCandidate(tailCandidates),
    );
  }
  if (
    sourceCampaignPolicies.length > 0 &&
    terminalSourceIds.size === sourceCampaignPolicies.length &&
    lastClassification !== "handler_failure_state_ambiguous"
  ) {
    lastClassification = sourceOutcomes.size === sourceCampaignPolicies.length &&
        [...sourceOutcomes.values()].every(({ outcome }) => outcome === "refreshed")
      ? "clean_empty"
      : "deterministic_terminal";
  } else if (
    tail !== null &&
    tailCandidates.length === 0 &&
    lastClassification !== "core_complete_maintenance_deferred" &&
    lastClassification !== "handler_not_ready" &&
    lastClassification !== "deterministic_terminal" &&
    lastClassification !== "handler_failure_prior_head_preserved" &&
    lastClassification !== "handler_failure_state_ambiguous" &&
    !(gracefulStopBoundaryReached && lastClassification === "checkpoint_paused")
  ) {
    lastClassification = emptyScopeClassification(tail, preparationScope);
  }
  if (sourceCampaignPolicies.length > 0 &&
      lastClassification !== "bounded_quantum_exhausted" &&
      lastClassification !== "checkpoint_paused" &&
      sourceOutcomes.size !== sourceCampaignPolicies.length) {
    const incompleteReason = lastClassification === "handler_failure_state_ambiguous"
      ? "campaign_state_ambiguous_unassessed"
      : "campaign_terminal_boundary_missing";
    for (const policy of sourceCampaignPolicies) {
      if (sourceOutcomes.has(policy.sourceId)) continue;
      const priorHead = sourcePriorHeads.get(policy.sourceId) ?? null;
      sourceOutcomes.set(policy.sourceId, Object.freeze({
        sourceId: policy.sourceId,
        outcome: "stopped" as const,
        dependencySatisfied: false,
        reasonCode: incompleteReason,
        priorHead,
        resultingHead: null,
        nextEligibleAt: null,
        proofIdentity: null,
        receiptIdentity: null,
      }));
      terminalSourceIds.add(policy.sourceId);
    }
    if (lastClassification === "clean_empty") lastClassification = "no_progress";
  }
  const orderedSourceOutcomes = Object.freeze(sourceCampaignPolicies.flatMap((policy) => {
    const outcome = sourceOutcomes.get(policy.sourceId);
    if (outcome === undefined) {
      if (
        lastClassification === "bounded_quantum_exhausted" ||
        lastClassification === "checkpoint_paused"
      ) return [];
      throw new Error("source campaign outcome vector is incomplete");
    }
    return [outcome];
  }));
  if (sourceCampaignPolicies.length > 0) {
    lastKnownRemainingUnits = Math.max(
      0,
      sourceCampaignPolicies.length - terminalSourceIds.size,
    );
  }
  const timingObservations = Object.freeze([...timingByCandidate.entries()]
    .map(([key, state]) => {
      const candidate = candidateByKey.get(key);
      return Object.freeze({
        candidateId: candidate?.id ?? key.split("\u0000", 1)[0]!,
        sourceId: candidate?.sourceId ?? "unknown",
        samples: state.samples,
        requestAcquireEwmaMs: state.timing.requestEwmaMs,
        parseValidationEwmaMs: state.timing.parseEwmaMs,
        callbackQueueEwmaMs: state.timing.callbackEwmaMs,
        commitEwmaMs: state.timing.commitEwmaMs,
        writerOccupancyMs: state.writerOccupancyMs,
        skippedRounds: skippedRounds.get(key) ?? 0,
        remainingRequests: state.timing.remainingRequests,
        remainingPages: state.timing.remainingPages,
      });
    })
    .sort((left, right) => left.candidateId.localeCompare(right.candidateId)));
  const selectedDecisions = decisions.filter((entry) => entry.action === "selected");
  const sourceDecisions = decisions.filter((entry) =>
    candidateKindById.get(entry.candidateId) === "source_acquisition"
  );
  const preparationDecisions = decisions.filter((entry) =>
    candidateKindById.get(entry.candidateId) === "preparation"
  );
  const sourceMutations = mutationFifo.order.filter((entry) =>
    candidateKindById.get(mutationCandidateId(entry)) === "source_acquisition"
  );
  const preparationMutations = mutationFifo.order.filter((entry) =>
    candidateKindById.get(mutationCandidateId(entry)) === "preparation"
  );
  const sourceTimings = timingObservations.filter((entry) =>
    candidateKindById.get(entry.candidateId) === "source_acquisition"
  );
  const preparationTimings = timingObservations.filter((entry) =>
    candidateKindById.get(entry.candidateId) === "preparation"
  );
  const sourceBoundaryRows = snapshotBoundaries.map((boundary) => ({
    generation: boundary.generation,
    candidates: boundary.candidates.filter((candidate) =>
      candidate.kind === "source_acquisition"
    ).map(({ revision, inputHash }) => ({ revision, inputHash })),
  }));
  const preparationBoundaryRows = snapshotBoundaries.map((boundary) => ({
    generation: boundary.generation,
    candidates: boundary.candidates.filter((candidate) =>
      candidate.kind === "preparation"
    ).map(({ revision, inputHash }) => ({ revision, inputHash })),
  }));
  const sourceSelectedCount = selectedDecisions.filter((entry) =>
    candidateKindById.get(entry.candidateId) === "source_acquisition"
  ).length;
  const preparationSelectedCount = selectedDecisions.filter((entry) =>
    candidateKindById.get(entry.candidateId) === "preparation"
  ).length;
  const [sourceInputBoundaryHash, preparationInputBoundaryHash,
    sourceOutputBoundaryHash, preparationOutputBoundaryHash,
    sourceCandidateOrderHash, sourceDecisionHash,
    preparationCandidateOrderHash, preparationDecisionHash,
    sourceMutationOrderHash, preparationMutationOrderHash,
    sourceTimingObservationHash, preparationTimingObservationHash] = await Promise.all([
      hashCanonicalJson(sourceBoundaryRows.map((boundary) => ({
        generation: boundary.generation,
        candidates: boundary.candidates.map(({ revision, inputHash }) => ({
          revision,
          inputHash,
        })),
      }))),
      hashCanonicalJson(preparationBoundaryRows.map((boundary) => ({
        generation: boundary.generation,
        candidates: boundary.candidates.map(({ revision, inputHash }) => ({
          revision,
          inputHash,
        })),
      }))),
      hashCanonicalJson({
        classification: lastClassification,
        selectedCount: sourceSelectedCount,
        requestCount: sourceRequests,
        commitObservationCount: sourceCommitObservationCount,
        tailReasonCodes: [...tailReasons].sort(),
      }),
      hashCanonicalJson({
        classification: lastClassification,
        selectedCount: preparationSelectedCount,
        requestCount: 0,
        commitObservationCount: preparationCommitObservationCount,
        tailReasonCodes: [...tailReasons].sort(),
      }),
      hashCanonicalJson(snapshotBoundaries.map((boundary) =>
        boundary.candidates.map((candidate) => candidate.id)
          .filter((id) => candidateKindById.get(id) === "source_acquisition")
      )),
      hashCanonicalJson(sourceDecisions),
      hashCanonicalJson(snapshotBoundaries.map((boundary) =>
        boundary.candidates.filter((candidate) => candidate.kind === "preparation")
          .map((candidate) => candidate.id)
      )),
      hashCanonicalJson(preparationDecisions),
      hashCanonicalJson(sourceMutations),
      hashCanonicalJson(preparationMutations),
      hashCanonicalJson(sourceTimings),
      hashCanonicalJson(preparationTimings),
    ]);
  const result = Object.freeze({
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    classification: lastClassification,
    dispatched,
    completed,
    deterministicTerminals,
    sourceRequests,
    childProcesses: 0,
    boundedReads,
    mutationOrder: mutationFifo.order,
    earliestAvailableAt: earliestAvailableAt(tailCandidates),
    tailCandidateIds: Object.freeze(tailCandidates.map((candidate) => candidate.id).sort()),
    tailReasonCodes: Object.freeze([...tailReasons].sort()),
    decisions: Object.freeze(decisions),
    timingObservations,
    writerOccupancyMs,
    maxConcurrentValidations,
    maxConcurrentCommits,
    preparationProgressCandidateIds: Object.freeze(
      [...preparationProgressCandidateIds].sort(),
    ),
    preparationNoProgressIdentities: Object.freeze(
      [...preparationNoProgressIdentities].sort(),
    ),
    proximityProgress,
    coreProgress,
    maintenanceProgress,
    enrichmentProgress,
    ...(preferenceV2Progress === null ? {} : { preferenceV2Progress }),
    ...(preferenceV2SessionDiagnostics === null
      ? {}
      : { preferenceV2SessionDiagnostics }),
    ...(preferenceV2ScorerError === null
      ? {}
      : { preferenceV2ScorerError }),
    sourceOutcomes: orderedSourceOutcomes,
    executionEvidence: Object.freeze({
      schemaVersion: "auction-discovery-scheduler-execution-evidence-v2" as const,
      unifiedSourceScheduler: Object.freeze({
        derivationVersion: "unified-source-scheduler-execution-v2" as const,
        inputBoundaryHash: sourceInputBoundaryHash,
        outputBoundaryHash: sourceOutputBoundaryHash,
        candidateOrderHash: sourceCandidateOrderHash,
        decisionHash: sourceDecisionHash,
        mutationOrderHash: sourceMutationOrderHash,
        timingObservationHash: sourceTimingObservationHash,
        snapshotCount: snapshotBoundaries.length,
        candidateObservationCount: sourceBoundaryRows.reduce(
          (sum, boundary) => sum + boundary.candidates.length,
          0,
        ),
        decisionObservationCount: sourceDecisions.length,
        mutationObservationCount: sourceMutations.length,
        selectedCount: sourceSelectedCount,
        requestCount: sourceRequests,
        childProcessCount: 0 as const,
        singleWriterObserved: true as const,
        commitObservationCount: sourceCommitObservationCount,
        maxConcurrentCommits,
        maxConcurrentValidations,
      }),
      preparationScheduler: Object.freeze({
        derivationVersion: "preparation-scheduler-execution-v2" as const,
        inputBoundaryHash: preparationInputBoundaryHash,
        outputBoundaryHash: preparationOutputBoundaryHash,
        candidateOrderHash: preparationCandidateOrderHash,
        decisionHash: preparationDecisionHash,
        mutationOrderHash: preparationMutationOrderHash,
        timingObservationHash: preparationTimingObservationHash,
        snapshotCount: snapshotBoundaries.length,
        candidateObservationCount: preparationBoundaryRows.reduce(
          (sum, boundary) => sum + boundary.candidates.length,
          0,
        ),
        decisionObservationCount: preparationDecisions.length,
        mutationObservationCount: preparationMutations.length,
        selectedCount: preparationSelectedCount,
        requestCount: 0,
        childProcessCount: 0 as const,
        singleWriterObserved: true as const,
        commitObservationCount: preparationCommitObservationCount,
        maxConcurrentCommits,
        maxConcurrentValidations,
      }),
    }),
  });
  input.telemetry?.record({
    context: input.telemetryContext,
    details: {
      kind: "stage",
      stage: "nightly_scheduler",
      outcome: "completed",
      durationMs: performance.now() - schedulerStartedAt,
      reasonCode: lastClassification,
    },
  });
  reportProgress(
    "terminal",
    lastKnownCandidates,
    `Scheduler stopped at ${lastClassification}.`,
    null,
    lastKnownRemainingUnits,
    "terminal",
  );
  return result;
}

function schedulerProgressEvent(input: {
  readonly phase: SchedulerProgressPhase;
  readonly state: SchedulerProgressEvent["state"];
  readonly candidates: readonly SchedulerCandidate[];
  readonly current: SchedulerCandidate | null;
  readonly completedWorkUnits: number;
  readonly remainingWorkUnits: number;
  readonly proximityProgress: SchedulerProximityProgress;
  readonly coreProgress: SchedulerPreparationScopeProgress;
  readonly maintenanceProgress: SchedulerPreparationScopeProgress;
  readonly primaryImageProgress: SchedulerPrimaryImageProgress;
  readonly primaryImageSession: SchedulerPrimaryImageSession | null;
  readonly enrichmentProgress: SchedulerEnrichmentProgress;
  readonly preferenceV2Progress: SchedulerPreferenceV2Progress | null;
  readonly preferenceV2SessionDiagnostics: SchedulerPreferenceV2SessionDiagnostics | null;
  readonly preferenceV2ScorerError: PreferenceV2ScorerErrorEnvelope | null;
  readonly attemptedSourceIds: ReadonlySet<string>;
  readonly completedSourceIds: ReadonlySet<string>;
  readonly terminalSourceIds: ReadonlySet<string>;
  readonly maxConcurrentNetworkJobs: number;
  readonly message: string;
}): SchedulerProgressEvent {
  const completedWorkUnits = safeProgressInteger(input.completedWorkUnits);
  const remainingWorkUnits = safeProgressInteger(input.remainingWorkUnits);
  const totalWorkUnits = safeProgressInteger(completedWorkUnits + remainingWorkUnits);
  const progressPercent = totalWorkUnits === 0
    ? 100
    : Math.min(100, Math.max(0,
        Math.round((completedWorkUnits / totalWorkUnits) * 10_000) / 100,
      ));
  const candidateEstimate = schedulerCandidatesEstimatedRemainingMs(
    input.candidates,
    remainingWorkUnits,
    input.maxConcurrentNetworkJobs,
  );
  const knownSourceIds = new Set<string>([
    ...input.attemptedSourceIds,
    ...input.completedSourceIds,
    ...input.terminalSourceIds,
    ...input.candidates
      .filter((candidate) => candidate.kind === "source_acquisition")
      .map((candidate) => candidate.sourceId),
  ]);
  return Object.freeze({
    observedAt: new Date().toISOString(),
    phase: input.phase,
    state: input.state,
    pipelineStage: input.current?.stage ?? null,
    completedWorkUnits,
    totalWorkUnits,
    progressPercent,
    proximityProgress: input.proximityProgress,
    coreProgress: input.coreProgress,
    maintenanceProgress: input.maintenanceProgress,
    primaryImageProgress: input.primaryImageProgress,
    primaryImageSession: input.primaryImageSession,
    enrichmentProgress: input.enrichmentProgress,
    ...(input.preferenceV2Progress === null
      ? {}
      : { preferenceV2Progress: input.preferenceV2Progress }),
    ...(input.preferenceV2SessionDiagnostics === null
      ? {}
      : { preferenceV2SessionDiagnostics: input.preferenceV2SessionDiagnostics }),
    ...(input.preferenceV2ScorerError === null
      ? {}
      : { preferenceV2ScorerError: input.preferenceV2ScorerError }),
    estimatedRemainingMs: input.phase === "batch_heartbeat"
      ? null
      : remainingWorkUnits === 0 ? 0 : candidateEstimate,
    currentSourceId: input.current?.sourceId ?? null,
    attemptedSourceCount: safeProgressInteger(input.attemptedSourceIds.size),
    completedSourceCount: safeProgressInteger(input.completedSourceIds.size),
    terminalSourceCount: safeProgressInteger(input.terminalSourceIds.size),
    knownSourceCount: safeProgressInteger(knownSourceIds.size),
    message: input.message.slice(0, 512),
  });
}

function schedulerRemainingWorkUnits(
  snapshot: import("./types").SchedulerSnapshot,
  visibleCandidateCount: number,
  preparationScope: SchedulerPreparationScope,
): number {
  const remaining = snapshot.remainingWork;
  if (remaining === undefined) return safeProgressInteger(visibleCandidateCount);
  const preparationRemaining = preparationScope === "core"
    ? remaining.coreReady + remaining.coreDeferred + remaining.coreClaimed
    : preparationScope === "maintenance"
    ? remaining.maintenanceReady + remaining.maintenanceDeferred +
      remaining.maintenanceClaimed
    : remaining.preparationReady + remaining.preparationDeferred +
      remaining.preparationClaimed;
  return safeProgressInteger(
    remaining.sourceAcquisitions + preparationRemaining,
  );
}

function schedulerSnapshotForPreparationScope(
  snapshot: import("./types").SchedulerSnapshot,
  preparationScope: SchedulerPreparationScope,
): import("./types").SchedulerSnapshot {
  if (preparationScope === "all") return snapshot;
  const stageSet = preparationScope === "core"
    ? CORE_PREPARATION_STAGE_SET
    : MAINTENANCE_PREPARATION_STAGE_SET;
  return Object.freeze({
    ...snapshot,
    candidates: Object.freeze(snapshot.candidates.filter((candidate) =>
      candidate.kind === "source_acquisition" || stageSet.has(candidate.stage)
    )),
  });
}

function preparationScopeProgress(
  ready: number,
  deferred: number,
  claimed: number,
): SchedulerPreparationScopeProgress {
  return Object.freeze({
    ready: safeProgressInteger(ready),
    deferred: safeProgressInteger(deferred),
    claimed: safeProgressInteger(claimed),
    remaining: safeProgressInteger(ready + deferred + claimed),
  });
}

function emptyScopeClassification(
  snapshot: import("./types").SchedulerSnapshot,
  preparationScope: SchedulerPreparationScope,
): SchedulerTailClassification {
  if (preparationScope !== "core") return "clean_empty";
  const remaining = snapshot.remainingWork;
  if (remaining === undefined) return "clean_empty";
  const coreRemaining = remaining.coreReady + remaining.coreDeferred +
    remaining.coreClaimed;
  const maintenanceRemaining = remaining.maintenanceReady +
    remaining.maintenanceDeferred + remaining.maintenanceClaimed;
  return coreRemaining === 0 && maintenanceRemaining > 0
    ? "core_complete_maintenance_deferred"
    : "clean_empty";
}

function schedulerCandidatesEstimatedRemainingMs(
  candidates: readonly SchedulerCandidate[],
  remainingWorkUnits: number,
  maxConcurrentNetworkJobs: number,
): number | null {
  if (remainingWorkUnits === 0) return 0;
  const estimates = candidates.map((candidate) => estimatedRemainingMs(candidate.timing))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (estimates.length === 0) return null;
  const visibleSum = estimates.reduce((sum, value) => sum + value, 0);
  const scaledSum = visibleSum * Math.max(1, remainingWorkUnits / estimates.length);
  const estimate = Math.max(
    Math.max(...estimates),
    scaledSum / maxConcurrentNetworkJobs,
  );
  return Number.isFinite(estimate) && estimate >= 0 ? Math.ceil(estimate) : null;
}

function progressCurrentCandidate(
  candidates: readonly SchedulerCandidate[],
): SchedulerCandidate | null {
  return candidates.reduce<SchedulerCandidate | null>((current, candidate) =>
    current === null || estimatedRemainingMs(candidate.timing) > estimatedRemainingMs(current.timing)
      ? candidate
      : current
  , null);
}

function safeProgressInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function schedulerSnapshotBoundary(snapshot: import("./types").SchedulerSnapshot) {
  return Object.freeze({
    generation: snapshot.generation,
    candidates: Object.freeze(snapshot.candidates.map((candidate) => Object.freeze({
      id: candidate.id,
      kind: candidate.kind,
      revision: candidate.workItem?.revision ?? candidate.sourceInput?.inputRevision ?? 0,
      inputHash: candidate.workItem?.inputHash ?? candidate.sourceInput?.inputHash ?? null,
    }))),
  });
}

function mutationCandidateId(value: string): string {
  return value.startsWith("reserve:")
    ? value.slice("reserve:".length)
    : value.startsWith("commit:")
    ? value.slice("commit:".length)
    : value;
}

function runtimeCandidate(
  candidate: SchedulerCandidate,
  timing: SchedulerTimingEstimate | undefined,
  skippedRounds: number,
): SchedulerCandidate {
  return Object.freeze({
    ...candidate,
    timing: timing ?? candidate.timing,
    skippedRounds,
  });
}

function candidateCompletionKey(candidate: SchedulerCandidate): string {
  if (candidate.workItem !== undefined) {
    return `${candidate.id}\u0000${candidate.workItem.revision}\u0000${candidate.workItem.inputHash}`;
  }
  if (candidate.sourceInput !== undefined) {
    return `${candidate.id}\u0000${candidate.sourceInput.inputRevision}\u0000${candidate.sourceInput.inputHash}`;
  }
  return candidate.id;
}

function decision(
  sequence: number,
  candidate: SchedulerCandidate,
  action: SchedulerDecision["action"],
  reasonCode: string | null,
): SchedulerDecision {
  return Object.freeze({
    sequence,
    candidateId: candidate.id,
    sourceId: candidate.sourceId,
    action,
    estimatedRemainingMs: estimatedRemainingMs(candidate.timing),
    reasonCode,
  });
}

function classifyBlockedSelection(
  selection: ReturnType<typeof selectScheduleBatch>,
): SchedulerTailClassification {
  if (selection.accessBlocked.length > 0) return "access_stop";
  if (selection.futureDeferred.length > 0) return "future_deferred";
  return "no_progress";
}

function classifyOutcomes(results: readonly ExecutedWork[]): SchedulerTailClassification {
  if (results.some(({ outcome }) =>
    outcome.classification === "handler_failure_state_ambiguous"
  )) {
    return "handler_failure_state_ambiguous";
  }
  if (results.some(({ outcome }) =>
    outcome.classification === "handler_failure_prior_head_preserved"
  )) {
    return "handler_failure_prior_head_preserved";
  }
  if (results.some(({ outcome }) => outcome.classification === "no_progress")) {
    return "no_progress";
  }
  if (results.some(({ outcome }) => outcome.classification === "access_stop")) {
    return "access_stop";
  }
  if (results.some(({ outcome }) => outcome.classification === "retryable_pressure")) {
    return "retryable_pressure";
  }
  if (results.every(({ outcome }) => outcome.classification === "deterministic_terminal")) {
    return "deterministic_terminal";
  }
  return "bounded_quantum_exhausted";
}

function handlerFailurePreservesPriorHead(error: unknown): boolean {
  return error !== null && typeof error === "object" &&
    "priorHeadPreserved" in error && error.priorHeadPreserved === true;
}

function handlerFailureIsStateAmbiguous(error: unknown): boolean {
  return error !== null && typeof error === "object" &&
    "stateAmbiguous" in error && error.stateAmbiguous === true;
}

function handlerFailureReasonCode(error: unknown): string {
  if (
    error !== null && typeof error === "object" &&
    "reasonCode" in error && typeof error.reasonCode === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(error.reasonCode)
  ) {
    return error.reasonCode;
  }
  return HANDLER_FAILURE_REASON_CODE;
}

function earliestAvailableAt(candidates: readonly SchedulerCandidate[]): string | null {
  const times = candidates.map((candidate) => {
    const boundaries = [
      candidate.accessState === "ready" ? candidate.availableAt : candidate.nextEligibleAt,
      candidate.leaseExpiresAt,
    ]
      .filter((value): value is string => value !== null)
      .map(Date.parse)
      .filter(Number.isFinite);
    return boundaries.length === 0 ? Number.NaN : Math.max(...boundaries);
  }).filter(Number.isFinite).sort((left, right) => left - right)
    .map((value) => new Date(value).toISOString());
  return times[0] ?? null;
}

function validateSourceCampaignPolicies(
  value: readonly SchedulerSourceCampaignPolicy[] | undefined,
): readonly SchedulerSourceCampaignPolicy[] {
  if (value === undefined) return Object.freeze([]);
  const seen = new Set<string>();
  const result: SchedulerSourceCampaignPolicy[] = [];
  for (const policy of value) {
    const terminalDependencies = policy.terminalDependencies ?? [];
    const allDependencies = [...policy.dependencies, ...terminalDependencies];
    if (!/^[a-z][a-z0-9_]{0,63}$/u.test(policy.sourceId) ||
        seen.has(policy.sourceId) || !Array.isArray(policy.dependencies) ||
        new Set(policy.dependencies).size !== policy.dependencies.length ||
        !Array.isArray(terminalDependencies) ||
        new Set(terminalDependencies).size !== terminalDependencies.length ||
        new Set(allDependencies).size !== allDependencies.length ||
        allDependencies.some((dependency) => !seen.has(dependency))) {
      throw new RangeError("source campaign policies must be unique dependency-safe order");
    }
    seen.add(policy.sourceId);
    result.push(Object.freeze({
      sourceId: policy.sourceId,
      dependencies: Object.freeze([...policy.dependencies]),
      terminalDependencies: Object.freeze([...terminalDependencies]),
    }));
  }
  return Object.freeze(result);
}

function boundedReasonCode(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(value)
    ? value
    : "scheduler_source_boundary";
}

function boundedIdentity(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) {
    throw new RangeError("scheduler source proof identity is invalid");
  }
  return value;
}

function validNextEligibleAt(value: string | null): string {
  if (value === null || !Number.isFinite(Date.parse(value))) {
    throw new RangeError("paused scheduler source requires an exact next eligible time");
  }
  return new Date(Date.parse(value)).toISOString();
}
