import type {
  PipelineWorkClaimIdentity,
  PipelineWorkItem,
  PipelineWorkStage,
} from "../pipeline/work-queue";
import type { SourceAccessStateRow } from "../sources/access-state";
import type {
  SourceAcquiredBundle,
  SourceAcquisitionClaimIdentity,
} from "../sources/acquisition-reservations";
import type { SourceOrchestrationPolicy } from "../sources/orchestration";
import type { PreferenceV2ScorerErrorEnvelope } from
  "../preference-v2/scorer-error";

export const SCHEDULER_SCHEMA_VERSION =
  "auction-discovery-nightly-scheduler-v1" as const;

export const PREPARATION_WORK_STAGES = Object.freeze([
  "projection_listing_refresh",
  "projection_source_refresh",
  "projection_group_refresh",
  "projection_global_refresh",
  "detail",
  "action_deadline",
  "owner_refresh",
  "factual_supplement",
  "image_evidence",
  "primary_image",
  "proximity",
  "enrichment_text",
  "enrichment_embedding",
  "preference_v2_score",
  "source_release",
  "source_acquisition_readiness",
] as const satisfies readonly PipelineWorkStage[]);

export type PreparationWorkStage = (typeof PREPARATION_WORK_STAGES)[number];
export const CORE_PREPARATION_WORK_STAGES = Object.freeze([
  "projection_listing_refresh",
  "projection_source_refresh",
  "projection_group_refresh",
  "projection_global_refresh",
  "source_acquisition_readiness",
  "proximity",
  "detail",
  "action_deadline",
  "owner_refresh",
  "factual_supplement",
  "image_evidence",
  "primary_image",
] as const satisfies readonly PreparationWorkStage[]);
export const MAINTENANCE_PREPARATION_WORK_STAGES = Object.freeze([
  "enrichment_text",
  "enrichment_embedding",
  "preference_v2_score",
  "source_release",
] as const satisfies readonly PreparationWorkStage[]);
export type SchedulerPreparationScope = "core" | "maintenance" | "all";
export type SchedulerWorkKind = "source_acquisition" | "preparation";
export type SchedulerAccessState = "ready" | "cooldown" | "manual_reset_required";

export interface SchedulerTimingEstimate {
  readonly remainingRequests: number;
  readonly remainingPages: number;
  readonly pacingFloorMs: number;
  readonly requestEwmaMs: number;
  readonly parseEwmaMs: number;
  readonly callbackEwmaMs: number;
  readonly commitEwmaMs: number;
}

export interface SchedulerPhaseTimingObservation {
  readonly candidateId: string;
  readonly sourceId: string;
  readonly samples: number;
  readonly requestAcquireEwmaMs: number;
  readonly parseValidationEwmaMs: number;
  readonly callbackQueueEwmaMs: number;
  readonly commitEwmaMs: number;
  readonly writerOccupancyMs: number;
  readonly skippedRounds: number;
  readonly remainingRequests: number;
  readonly remainingPages: number;
}

export interface SchedulerComponentExecutionEvidence {
  readonly derivationVersion:
    | "unified-source-scheduler-execution-v2"
    | "preparation-scheduler-execution-v2";
  readonly inputBoundaryHash: string;
  readonly outputBoundaryHash: string;
  readonly candidateOrderHash: string;
  readonly decisionHash: string;
  readonly mutationOrderHash: string;
  readonly timingObservationHash: string;
  readonly snapshotCount: number;
  readonly candidateObservationCount: number;
  readonly decisionObservationCount: number;
  readonly mutationObservationCount: number;
  readonly selectedCount: number;
  readonly requestCount: number;
  readonly childProcessCount: 0;
  readonly singleWriterObserved: true;
  readonly commitObservationCount: number;
  readonly maxConcurrentCommits: number;
  readonly maxConcurrentValidations: number;
}

export interface SchedulerExecutionEvidence {
  readonly schemaVersion: "auction-discovery-scheduler-execution-evidence-v2";
  readonly unifiedSourceScheduler: SchedulerComponentExecutionEvidence;
  readonly preparationScheduler: SchedulerComponentExecutionEvidence;
}

export interface SchedulerCandidate {
  readonly id: string;
  readonly kind: SchedulerWorkKind;
  readonly sourceId: string;
  readonly stage: PipelineWorkStage | "source_acquisition";
  readonly networkLanes: readonly string[];
  /** Dependencies that require a fresh or verified-recent publication. */
  readonly dependencies: readonly string[];
  /** Ordering-only dependencies satisfied by any truthful terminal outcome. */
  readonly terminalDependencies?: readonly string[];
  readonly dependencyDepth: number;
  readonly priority: number;
  readonly fairnessQuantum: number;
  readonly skippedRounds: number;
  readonly enqueueOrder: number;
  readonly availableAt: string;
  readonly accessState: SchedulerAccessState;
  readonly accessReasonCode: string | null;
  readonly nextEligibleAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly inputAttemptCount: number;
  readonly timing: SchedulerTimingEstimate;
  readonly workItem?: PipelineWorkItem;
  readonly sourcePolicy?: SourceOrchestrationPolicy;
  /** Exact durable source input used by the reservation CAS. */
  readonly sourceInput?: SchedulerSourceInput;
}

export interface SchedulerSourceInput {
  readonly campaignId: string;
  readonly coverageMode: "complete_current";
  readonly adapterVersion: string;
  readonly proofVersion: string;
  readonly expectedGeneration: number;
  readonly inputHash: string;
  readonly inputRevision: number;
  readonly baseInventoryRunId?: string | null;
  readonly expectedActiveProofId?: string | null;
  readonly priorCheckpointIdentity?: string | null;
  readonly priorCheckpoint?: SchedulerSourceCheckpointEvidence | null;
  readonly pageOrPartitionIdentity?: string | null;
  readonly requestIdentity?: string;
  readonly requestBudget?: number;
  /** Publication head observed before this exact campaign source candidate. */
  readonly priorHead?: SchedulerSourceHeadEvidence | null;
  /**
   * A source-neutral, server-derived proof that the exact current complete-
   * current publication is still inside the configured freshness window.
   * The engine may terminalize this candidate without reserving or dispatching
   * source work only when this complete evidence is present.
   */
  readonly recentPublicationSkip?: SchedulerRecentPublicationSkip | null;
}

export interface SchedulerSourceCheckpointEvidence {
  readonly traversalId: string;
  readonly contractHash: string;
  readonly expectedPages: number;
  readonly completedCheckpointHashes: readonly string[];
}

export interface SchedulerSourceHeadEvidence {
  readonly inventoryRunId: string;
  readonly listingCount: number;
}

export interface SchedulerRecentPublicationSkip {
  readonly reasonCode: "recent_verified_publication";
  /** Immutable publication proof completion time used as the freshness anchor. */
  readonly verifiedAt: string;
  /** Exact publication time retained for truthful status and proof binding. */
  readonly publishedAt: string;
  readonly head: SchedulerSourceHeadEvidence;
  readonly proofIdentity: string;
  readonly receiptIdentity: string;
}

/** Exact durable proof returned only after a fresh source head is verified. */
export interface SchedulerVerifiedSourceBoundary {
  readonly outcome: "refreshed";
  readonly priorHead: SchedulerSourceHeadEvidence | null;
  readonly resultingHead: SchedulerSourceHeadEvidence;
  readonly proofIdentity: string;
  readonly receiptIdentity: string;
}

export interface SchedulerProximityProgress {
  /** Proximity rows present when the current local pass began. */
  readonly queued: number | null;
  readonly claimed: number | null;
  readonly completed: number | null;
  readonly stale: number | null;
  /**
   * Rows left from that pass's starting queue (`queued - completed`). The
   * queue is dynamic, so a later pass may report a different denominator.
   */
  readonly remaining: number | null;
}

/**
 * Bounded callback telemetry from one source-scoped image worker session.
 * These are not cumulative run counters and never define durable completion.
 */
export interface SchedulerPrimaryImageSession {
  readonly sourceId: string;
  readonly attempted: number;
  readonly archived: number;
  readonly failed: number;
  readonly remainingWork: boolean;
  readonly stopReason: string | null;
}

export type SchedulerSourceCampaignOutcomeKind =
  | "refreshed"
  | "skipped_recent"
  | "preserved"
  | "paused"
  | "stopped"
  | "blocked";

export interface SchedulerSourceCampaignOutcome {
  readonly sourceId: string;
  readonly outcome: SchedulerSourceCampaignOutcomeKind;
  /** Whether this outcome satisfies a freshness-dependent source. */
  readonly dependencySatisfied: boolean;
  readonly reasonCode: string;
  readonly priorHead: SchedulerSourceHeadEvidence | null;
  readonly resultingHead: SchedulerSourceHeadEvidence | null;
  readonly nextEligibleAt: string | null;
  readonly proofIdentity: string | null;
  readonly receiptIdentity: string | null;
}

export interface SchedulerSourceCampaignPolicy {
  readonly sourceId: string;
  readonly dependencies: readonly string[];
  readonly terminalDependencies?: readonly string[];
}

export type SchedulerCallbackInstruction =
  | {
      readonly kind: "loopback_json";
      readonly service: "dashboard" | "companion";
      readonly path: string;
      readonly body: Readonly<Record<string, unknown>> | null;
      readonly timeoutMs: number;
      readonly executionBoundary?: "commit_fifo" | "acquire_outside_fifo";
      readonly successContract:
        | "source_catalog"
        | "source_continuation"
        | "enrichment_session"
        | "primary_image_session"
        | "proximity_session"
        | "preference_v2_session";
    }
  | { readonly kind: "local_commit" };

export interface SchedulerCallbackReceipt {
  readonly status: number;
  readonly responseHash: string;
  readonly body: unknown;
}

export interface SchedulerExternalAcquisitionReceipt {
  readonly kind: "external_acquisition_receipt";
  readonly instruction: Exclude<SchedulerCallbackInstruction, { kind: "local_commit" }>;
  readonly receipt: SchedulerCallbackReceipt;
}

/**
 * Bounded durable observation after the local callback transport detached.
 * The callback response body is deliberately absent: only exact persisted
 * mutation state can make the detached dispatch terminal.
 */
export type SchedulerDetachedCallbackReconciliation =
  | {
      readonly state: "active";
      readonly reasonCode:
        | "detached_callback_mutation_active"
        | "detached_callback_settlement_pending";
    }
  | {
      readonly state: "outcome";
      readonly outcome: SchedulerWorkOutcome;
    };

type SchedulerWorkOutcomeCore =
  | {
      readonly classification: "completed";
      readonly madeProgress: true;
      readonly remaining: false;
      readonly sourceBoundary?: SchedulerVerifiedSourceBoundary;
    }
  | {
      readonly classification: "deterministic_terminal";
      readonly madeProgress: true;
      readonly remaining: false;
    }
  | {
      readonly classification: "retryable_pressure";
      readonly madeProgress: boolean;
      readonly remaining: true;
      readonly availableAt: string;
      readonly reasonCode: string;
    }
  | {
      readonly classification: "access_stop";
      readonly madeProgress: false;
      readonly remaining: true;
      readonly availableAt: string | null;
      readonly reasonCode: string;
    }
  | {
      readonly classification: "no_progress";
      readonly madeProgress: false;
      readonly remaining: true;
      readonly reasonCode: string;
    }
  | {
      /**
       * No canonical commit was accepted. The durable queue/reservation and
       * prior publication head remain authoritative for a later retry.
       */
      readonly classification: "handler_failure_prior_head_preserved";
      readonly madeProgress: false;
      readonly remaining: true;
      readonly reasonCode: string;
    }
  | {
      /** Commit transport ended without authoritative server-side receipt. */
      readonly classification: "handler_failure_state_ambiguous";
      readonly madeProgress: false;
      readonly remaining: true;
      readonly reasonCode: string;
    };

export type SchedulerWorkOutcome = SchedulerWorkOutcomeCore & Readonly<{
  /** Present only when a proximity callback returned a valid queue summary. */
  proximityProgress?: SchedulerProximityProgress;
  /** Present only when one primary-image callback returned valid session telemetry. */
  primaryImageSession?: SchedulerPrimaryImageSession;
  /** Present only when an enrichment callback returned a valid bounded summary. */
  enrichmentProgress?: SchedulerEnrichmentProgress;
  /** Present only when one Preference V2 callback returned a valid queue delta. */
  preferenceV2Progress?: SchedulerPreferenceV2Progress;
  /** Exact local snapshot/session facts returned by that Preference V2 callback. */
  preferenceV2SessionDiagnostics?: SchedulerPreferenceV2SessionDiagnostics;
  /** Latest strict sanitized scorer failure returned by Preference V2. */
  preferenceV2ScorerError?: PreferenceV2ScorerErrorEnvelope;
  /**
   * Stable semantic identity for a proved non-advancing preparation boundary.
   * Unlike a bounded candidate window, this changes only when the owned queue
   * scope changes, so rotating ready rows cannot refill a retry allowance.
   */
  noProgressIdentity?: string;
}>;

export interface SchedulerReservation {
  readonly reservationId: string;
  readonly candidateId: string;
  readonly sourceId: string;
  readonly laneKey: string;
  readonly inputRevision: number;
  readonly expiresAt: string;
  /** Exact durable queue claim for preparation handlers. */
  readonly queueClaim: PipelineWorkClaimIdentity | null;
  /**
   * Exact ordered claim bundle for the bounded Preference V2 callback. The
   * existing queueClaim remains the seed (and first member) so every other
   * preparation contract stays singular and backward compatible.
   */
  readonly queueClaims?: readonly PipelineWorkClaimIdentity[];
  /** Canonical SHA-256 binding of the ordered Preference V2 claim bundle. */
  readonly queueClaimsIdentity?: string;
  /** Exact durable reservation claim for source acquisition handlers. */
  readonly acquisitionClaim: SourceAcquisitionClaimIdentity | null;
}

export interface SchedulerAcquiredBundle {
  readonly reservationId: string;
  readonly bundleIdentity: string;
  readonly responseHash: string;
  readonly contentHash: string;
  readonly validated: true;
  /** Persisted acquired-bundle identity when the source reservation path is used. */
  readonly acquiredBundle: SourceAcquiredBundle | null;
  readonly metrics?: Readonly<{
    readonly requestsConsumed: number;
    readonly pagesConsumed: number;
    readonly bytesDownloaded: number;
  }>;
  /** The mutation FIFO executes the canonical callback. */
  readonly callback: SchedulerCallbackInstruction;
}

/**
 * A handler owns one exact stage/source contract. Reserve and commit are always
 * called through the scheduler's mutation FIFO; acquire and validate are not.
 */
export interface SchedulerHandler {
  readonly id: string;
  readonly ready: boolean;
  readonly readinessReasonCode: string | null;
  reserve(candidate: SchedulerCandidate): Promise<SchedulerReservation>;
  acquire(
    candidate: SchedulerCandidate,
    reservation: SchedulerReservation,
  ): Promise<unknown>;
  validate(
    candidate: SchedulerCandidate,
    reservation: SchedulerReservation,
    acquired: unknown,
  ): Promise<SchedulerAcquiredBundle>;
  commit(
    candidate: SchedulerCandidate,
    reservation: SchedulerReservation,
    bundle: SchedulerAcquiredBundle,
  ): Promise<SchedulerWorkOutcome>;
}

export interface SchedulerHandlerRegistry {
  readonly handlers: ReadonlyMap<string, SchedulerHandler>;
  resolve(candidate: SchedulerCandidate): SchedulerHandler | null;
}

export interface SchedulerSnapshot {
  readonly generation: string;
  readonly candidates: readonly SchedulerCandidate[];
  readonly boundedReadCount: number;
  readonly remainingWork?: {
    readonly sourceAcquisitions: number;
    readonly preparationReady: number;
    readonly preparationDeferred: number;
    readonly preparationClaimed: number;
    readonly coreReady: number;
    readonly coreDeferred: number;
    readonly coreClaimed: number;
    readonly maintenanceReady: number;
    readonly maintenanceDeferred: number;
    readonly maintenanceClaimed: number;
    readonly returned: number;
    readonly truncated: number;
    /** Current actionable primary-image queue; omitted when that queue is empty. */
    readonly primaryImages?: SchedulerPrimaryImageProgress;
    /** Current combined text-and-embedding enrichment queue. */
    readonly enrichment?: SchedulerEnrichmentProgress;
  };
}

export interface SchedulerPrimaryImageProgress {
  /** Unclaimed work whose availability boundary has elapsed. */
  readonly ready: number;
  /** Unclaimed work waiting for its exact availability boundary. */
  readonly deferred: number;
  /** Work with a currently live durable claim. */
  readonly claimed: number;
  /** Current actionable queue: ready + deferred + claimed. */
  readonly remaining: number;
}

export interface SchedulerPreparationScopeProgress {
  readonly ready: number;
  readonly deferred: number;
  readonly claimed: number;
  readonly remaining: number;
}

export const SCHEDULER_ENRICHMENT_PROGRESS_SCOPE =
  "enrichment_text+enrichment_embedding" as const;

/**
 * Point-in-time combined enrichment queue facts plus the latest bounded worker
 * receipt. `completed` and `stale` describe only that latest worker session;
 * they are deliberately not accumulated across scheduler quanta.
 */
export interface SchedulerEnrichmentProgress {
  readonly scope: typeof SCHEDULER_ENRICHMENT_PROGRESS_SCOPE;
  readonly queued: number | null;
  readonly claimed: number | null;
  readonly completed: number | null;
  readonly stale: number | null;
  readonly remaining: number | null;
}

/**
 * Exact bounded receipt from one Preference V2 scoring quantum. Queue counts
 * are point-in-time facts; completed/reused/newlyScored/stale describe only
 * this callback and are never inferred from the all-maintenance denominator.
 */
export interface SchedulerPreferenceV2Progress {
  readonly queueBefore: number;
  readonly selected: number;
  readonly completed: number;
  readonly reused: number;
  readonly newlyScored: number;
  readonly stale: number;
  readonly queueAfter: number;
  readonly remaining: number;
  readonly lastProgressAt: string | null;
  readonly elapsedMs: number;
  readonly throughputRowsPerSecond: number | null;
  readonly estimatedRemainingMs: number | null;
  readonly stopReason: "queue_empty" | "quantum";
}

/** Exact disposable-snapshot and scoring-phase facts from one bounded session. */
export interface SchedulerPreferenceV2SessionDiagnostics {
  readonly sourceDataVersion: number;
  readonly sessionStatus: "up_to_date" | "scored" | "stale" | "coverage_only";
  readonly snapshotCreationElapsedMs: number;
  readonly sessionElapsedMs: number;
  readonly rowsPerBatch: number;
  readonly reusableRows: number;
  readonly newlyScoredRows: number;
  readonly materializerInvocations: 0 | 1;
  readonly pythonProcesses: 0 | 1;
  readonly materializationElapsedMs: number;
  readonly inferenceElapsedMs: number;
  readonly scoreImportElapsedMs: number;
}

export interface SchedulerWorkSource {
  readSnapshot(): Promise<SchedulerSnapshot>;
}

export type SchedulerTailClassification =
  | "clean_empty"
  | "checkpoint_paused"
  | "core_complete_maintenance_deferred"
  | "future_deferred"
  | "retryable_pressure"
  | "deterministic_terminal"
  | "access_stop"
  | "no_progress"
  | "handler_not_ready"
  | "handler_failure_prior_head_preserved"
  | "handler_failure_state_ambiguous"
  | "bounded_quantum_exhausted";

export interface SchedulerDecision {
  readonly sequence: number;
  readonly candidateId: string;
  readonly sourceId: string;
  readonly action:
    | "selected"
    | "recent_publication_skipped"
    | "dependency_blocked"
    | "lane_blocked"
    | "access_blocked"
    | "future_deferred"
    | "deadline_deferred"
    | "handler_not_ready";
  readonly estimatedRemainingMs: number;
  readonly reasonCode: string | null;
}

export interface SchedulerRunResult {
  readonly schemaVersion: typeof SCHEDULER_SCHEMA_VERSION;
  readonly classification: SchedulerTailClassification;
  readonly dispatched: number;
  readonly completed: number;
  readonly deterministicTerminals: number;
  readonly sourceRequests: number;
  readonly childProcesses: 0;
  readonly boundedReads: number;
  readonly mutationOrder: readonly string[];
  readonly earliestAvailableAt: string | null;
  readonly tailCandidateIds: readonly string[];
  readonly tailReasonCodes: readonly string[];
  readonly decisions: readonly SchedulerDecision[];
  readonly timingObservations: readonly SchedulerPhaseTimingObservation[];
  readonly writerOccupancyMs: number;
  readonly maxConcurrentValidations: number;
  readonly maxConcurrentCommits: number;
  /**
   * Bounded, sorted identities whose preparation commit durably advanced in
   * this scheduler run. Source acquisition progress never populates it.
   */
  readonly preparationProgressCandidateIds: readonly string[];
  /** Semantic preparation boundaries that did not durably advance. */
  readonly preparationNoProgressIdentities: readonly string[];
  /** Latest valid proximity-only queue summary observed during this run. */
  readonly proximityProgress: SchedulerProximityProgress;
  readonly coreProgress: SchedulerPreparationScopeProgress;
  readonly maintenanceProgress: SchedulerPreparationScopeProgress;
  /** Latest combined enrichment queue/session summary observed during this run. */
  readonly enrichmentProgress?: SchedulerEnrichmentProgress;
  /** Latest exact bounded Preference V2 worker receipt observed during this run. */
  readonly preferenceV2Progress?: SchedulerPreferenceV2Progress;
  /** Latest exact bounded Preference V2 companion diagnostics observed during this run. */
  readonly preferenceV2SessionDiagnostics?: SchedulerPreferenceV2SessionDiagnostics;
  /** Latest strict sanitized Preference V2 scorer failure observed during this run. */
  readonly preferenceV2ScorerError?: PreferenceV2ScorerErrorEnvelope;
  /** Canonical source order; empty for preparation-only and legacy composite runs. */
  readonly sourceOutcomes: readonly SchedulerSourceCampaignOutcome[];
  /** Privacy-safe append-only receipt payload for independent audit storage. */
  readonly executionEvidence: SchedulerExecutionEvidence;
}

export type SchedulerProgressPhase =
  | "snapshot"
  | "batch_started"
  | "batch_heartbeat"
  | "batch_completed"
  | "terminal";

export interface SchedulerProgressEvent {
  /** Wall-clock observation boundary for this exact progress event. */
  readonly observedAt: string;
  readonly phase: SchedulerProgressPhase;
  readonly state: "running" | "terminal";
  readonly pipelineStage: PipelineWorkStage | "source_acquisition" | null;
  readonly completedWorkUnits: number;
  readonly totalWorkUnits: number;
  readonly progressPercent: number;
  /** Proximity-only queue progress; fields are null until its callback settles. */
  readonly proximityProgress: SchedulerProximityProgress;
  /** Required discovery preparation only; never includes optional maintenance. */
  readonly coreProgress: SchedulerPreparationScopeProgress;
  /** Optional ranking maintenance only; never includes core preparation. */
  readonly maintenanceProgress: SchedulerPreparationScopeProgress;
  /** Current durable primary-image queue; never an all-stage denominator. */
  readonly primaryImageProgress: SchedulerPrimaryImageProgress;
  /** Latest bounded image-worker receipt; null before any valid session settles. */
  readonly primaryImageSession: SchedulerPrimaryImageSession | null;
  /** Combined enrichment queue plus latest bounded worker receipt. */
  readonly enrichmentProgress?: SchedulerEnrichmentProgress;
  /** Exact Preference V2 queue delta and throughput from its latest quantum. */
  readonly preferenceV2Progress?: SchedulerPreferenceV2Progress;
  /** Exact snapshot/session diagnostics from that Preference V2 quantum. */
  readonly preferenceV2SessionDiagnostics?: SchedulerPreferenceV2SessionDiagnostics;
  /** Latest strict sanitized Preference V2 scorer failure. */
  readonly preferenceV2ScorerError?: PreferenceV2ScorerErrorEnvelope;
  readonly estimatedRemainingMs: number | null;
  readonly currentSourceId: string | null;
  readonly attemptedSourceCount: number;
  readonly completedSourceCount: number;
  /** Every refreshed/skipped/preserved/paused/stopped/blocked campaign boundary. */
  readonly terminalSourceCount: number;
  readonly knownSourceCount: number;
  /** One-process scheduler quantum; source is 1 and preparation starts at 2. */
  readonly quantumAttempt?: number;
  /** Exact terminal source vector once the campaign has entered preparation. */
  readonly sourceOutcomes?: readonly SchedulerSourceCampaignOutcome[];
  readonly message: string;
}

export interface SchedulerRunOptions {
  readonly maxConcurrentNetworkJobs?: number;
  readonly maxDispatches?: number;
  readonly now?: () => Date;
  /** Best-effort synchronous reporting; reporter failures never affect scheduling. */
  readonly onProgress?: (event: SchedulerProgressEvent) => void;
  /** Focused-test cadence seam; ordinary scheduler calls use the bounded default. */
  readonly batchHeartbeatIntervalMs?: number;
  /** Enables the exact per-source campaign terminal vector for an adapter run. */
  readonly sourceCampaignPolicies?: readonly SchedulerSourceCampaignPolicy[];
  /** Exact cooldown wait seam. Production uses the ordinary timer. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Finite wall-clock budget owned by one scheduler invocation. */
  readonly maxCampaignWaitMs?: number;
  /**
   * One absolute workflow deadline, expressed as Unix epoch milliseconds.
   * Omission preserves the historical unbounded-admission behavior.
   */
  readonly deadlineAtMs?: number;
  /** Minimum time that must remain before any candidate in this run is admitted. */
  readonly minimumSettlementReserveMs?: number;
  /** Optional candidate-specific reserve; it may only strengthen the run minimum. */
  readonly minimumSettlementReserveForCandidateMs?: (
    candidate: SchedulerCandidate,
  ) => number;
  /** Preparation subset owned by this run; source candidates are never filtered. */
  readonly preparationScope?: SchedulerPreparationScope;
}

export interface SourceScheduleInput {
  readonly policy: SourceOrchestrationPolicy;
  readonly completedSourceIds: ReadonlySet<string>;
  readonly timing: SchedulerTimingEstimate;
  readonly accessRows: readonly SourceAccessStateRow[];
  readonly availableAt: string;
  readonly skippedRounds?: number;
  readonly enqueueOrder?: number;
  readonly leaseExpiresAt?: string | null;
  readonly inputAttemptCount?: number;
}
