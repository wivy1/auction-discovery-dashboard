import { isDirectImageSourceId } from "../images/direct-source-registry";
import {
  hashCanonicalJson,
} from "../performance/generations";
import type {
  PerformanceTelemetryContext,
  PerformanceTelemetrySink,
} from "../performance/telemetry";
import {
  coalescePipelineWorkItem,
  completePipelineWorkClaim,
  deferPipelineWorkClaim,
  failPipelineWorkClaim,
  pipelineWorkClaimIdentity,
  type PipelineWorkItem,
  type PipelineWorkStage,
} from "../pipeline/work-queue";
import {
  PROJECTION_REFRESH_STAGES,
  runProjectionRefreshQuantum,
  type ProjectionRefreshQuantumResult,
  type ProjectionRefreshStage,
} from "../pipeline/projection-refresh";
import { readCurrentProjectionContracts } from
  "../pipeline/projection-contracts";
import { isSourceInventoryTraversalPauseMessage } from
  "../pipeline/traversal-page-errors";
import { reconcileProjectedSourceRelease } from "../pipeline/source-release-state";
import {
  checkSourceAccessEligibility,
  inspectSourceAccessStates,
} from "../sources/access-state";
import { checkSourceDocumentAccess } from "../sources/acquisition-access";
import { getSourceAdapter } from "../sources/registry";
import {
  commitSourceAcquisitionReservation,
  putSourceAcquiredBundle,
  readSourceAcquisitionReservation,
  releaseSourceAcquisitionReservation,
  reserveSourceAcquisition,
  readSourceAcquisitionGeneration,
  sourceAcquisitionClaimIdentity,
  type SourceAcquisitionReservation,
} from "../sources/acquisition-reservations";
import {
  sourceOrchestrationRegistry,
  type SourceOrchestrationPolicy,
} from "../sources/orchestration";
import type { SourceId, SourceCoverageMode } from "../sources/types";
import {
  readInitializedActiveOrigin,
} from "../settings/active-origin";
import { readExactCurrentDistanceExclusionListingIds } from "../pipeline/operational-projection";
import {
  preparationCandidateFromWorkItem,
  sourceCandidateFromPolicy,
  sourceDependencyDepths,
} from "./candidates";
import {
  CORE_PREPARATION_WORK_STAGES,
  MAINTENANCE_PREPARATION_WORK_STAGES,
  PREPARATION_WORK_STAGES,
  SCHEDULER_ENRICHMENT_PROGRESS_SCOPE,
  type SchedulerAcquiredBundle,
  type SchedulerCallbackInstruction,
  type SchedulerCallbackReceipt,
  type SchedulerCandidate,
  type SchedulerDetachedCallbackReconciliation,
  type SchedulerEnrichmentProgress,
  type SchedulerReservation,
  type SchedulerPreparationScope,
  type SchedulerRecentPublicationSkip,
  type SchedulerSnapshot,
  type SchedulerSourceInput,
  type SchedulerSourceCheckpointEvidence,
  type SchedulerTimingEstimate,
  type SchedulerVerifiedSourceBoundary,
  type SchedulerWorkOutcome,
} from "./types";
import { LOCAL_SCHEDULER_SOURCE_ID } from "./runtime-adapter";
import {
  SCHEDULED_SOURCE_QUANTUM_ACQUISITION_WINDOW_MS,
  SCHEDULED_SOURCE_QUANTUM_DISCOVERY_LEASE_MS,
  SCHEDULED_SOURCE_QUANTUM_RESERVATION_LEASE_MS,
} from "./source-quantum";
import { ENRICHMENT_CALLBACK_TIMEOUT_MS } from "./enrichment-contract";

export const NIGHTLY_SCHEDULER_RUNTIME_VERSION =
  "auction-discovery-nightly-scheduler-runtime-v2" as const;

const SOURCE_LEASE_MS = 3 * 60 * 60_000;
const PREPARATION_LEASE_MS = 60 * 60_000;
const RETRY_DELAY_MS = 60_000;
const DETACHED_CALLBACK_SETTLEMENT_GRACE_MS = 60_000;
/** Matches the companion's 15-minute worker quantum plus five-minute guard. */
export const PREFERENCE_V2_CALLBACK_TIMEOUT_MS = 20 * 60_000;
export const RECENT_VERIFIED_PUBLICATION_WINDOW_MS = 16 * 60 * 60_000;
const PRIMARY_IMAGE_HANDOFF_CURSOR_VERSION = "primary-image-handoff-v1";
const PRIMARY_IMAGE_FINAL_CURSOR_VERSION = "primary-image-final-v1";
const CURRENT_TERMINAL_IMAGE_EVIDENCE_SQL = `
  (
    terminal_image.last_error_code = 'source_image_unavailable'
    OR (
      terminal_image.last_error_code = 'source_image_absent'
      AND NOT EXISTS (
        SELECT 1 FROM listing_images observed_image
        WHERE observed_image.listing_id = terminal_image.listing_id
      )
    )
  )
`;
const MAX_SNAPSHOT_ROWS = 200;
// Matches the durable traversal-key contract enforced by pipeline storage.
const MAX_TRAVERSAL_PAGE_KEY_LENGTH = 1_024;
const MAX_RELEASE_FANOUT_ROWS = 250_000;
const RELEASE_FANOUT_BATCH_SIZE = 1_000;
const PROJECTION_SLICE_BATCH_SIZE = 250;
const PROJECTION_SLICE_MAX_QUANTA = 8;
const PROJECTION_SLICE_ELAPSED_CEILING_MS = 15_000;
const SOURCE_POLICY_BY_ID = new Map(
  sourceOrchestrationRegistry.map((policy) => [policy.sourceId, policy]),
);
const DEPTH_BY_SOURCE = sourceDependencyDepths(sourceOrchestrationRegistry);
const PREPARATION_STAGE_SET = new Set<string>(PREPARATION_WORK_STAGES);
const PROJECTION_STAGE_SET = new Set<string>(PROJECTION_REFRESH_STAGES);
const COMBINED_CALLBACK_STAGE_SET = new Set<string>([
  ...PROJECTION_REFRESH_STAGES,
]);
const DISTANCE_EXCLUSION_SUPPRESSED_STAGE_SET = new Set<PipelineWorkStage>([
  "detail",
  "action_deadline",
  "owner_refresh",
  "factual_supplement",
  "image_evidence",
  "primary_image",
  "enrichment_text",
  "enrichment_embedding",
  "preference_v2_score",
]);
const NO_REFETCH_CONTINUATION_STAGE_SET = new Set<string>([
  "owner_refresh",
  "factual_supplement",
]);
const WORK_ROW_COLUMNS = `
  stage, subject_type, subject_id, listing_id, source_id,
  subject_payload_json, lane_key, input_hash, revision, priority, reason_code,
  available_at, input_attempt_count, lifetime_attempt_count,
  lease_owner, lease_expires_at, claimed_input_hash, claimed_revision,
  progress_cursor, progress_generation, progress_rows,
  last_error_code, last_error_fingerprint,
  created_at, updated_at, last_claimed_at, last_completed_at
`;

interface WorkRow {
  stage: string;
  subject_type: string;
  subject_id: string;
  listing_id: string | null;
  source_id: string | null;
  subject_payload_json: string | null;
  lane_key: string;
  input_hash: string;
  revision: number;
  priority: number;
  reason_code: string;
  available_at: string;
  input_attempt_count: number;
  lifetime_attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  claimed_input_hash: string | null;
  claimed_revision: number | null;
  progress_cursor: string | null;
  progress_generation: number | null;
  progress_rows: number;
  last_error_code: string | null;
  last_error_fingerprint: string | null;
  created_at: string;
  updated_at: string;
  last_claimed_at: string | null;
  last_completed_at: string | null;
}

interface SchedulerTraversalEvidenceRow {
  readonly source_id: string;
  readonly traversal_id: string;
  readonly fingerprint: string;
  readonly expected_pages: number;
  readonly expected_listings: number;
  readonly page_key: string | null;
  readonly completed_at: string | null;
}

interface DurableSourceHeadRow {
  readonly inventory_run_id: string;
  readonly listing_count: number;
  readonly published_at: string;
}

interface DetachedPublicationRunRow {
  readonly discovery_run_id: string;
  readonly discovery_status: string;
  readonly discovery_started_at: string;
  readonly discovery_completed_at: string | null;
  readonly source_run_id: string;
  readonly source_status: string;
  readonly source_started_at: string;
  readonly source_completed_at: string | null;
}

export interface SchedulerCommitRequired {
  readonly kind: "callback_required";
  readonly instruction: Exclude<SchedulerCallbackInstruction, { kind: "local_commit" }>;
}

export interface SchedulerCommitOutcome {
  readonly kind: "outcome";
  readonly outcome: SchedulerWorkOutcome;
}

export type SchedulerCommitResult = SchedulerCommitRequired | SchedulerCommitOutcome;

export async function readNightlySchedulerSnapshot(input: {
  readonly database: D1Database;
  readonly limit: number;
  readonly campaignId: string;
  readonly coverageMode: SourceCoverageMode | "auto";
  readonly includeSourceAcquisitions: boolean;
  readonly preparationScope?: SchedulerPreparationScope;
  readonly completedSourceIds?: readonly string[];
  readonly now?: Date;
}): Promise<SchedulerSnapshot> {
  const limit = integer(input.limit, "snapshot limit", 1, MAX_SNAPSHOT_ROWS);
  const campaignId = code(input.campaignId, "campaign id", 256);
  const now = validDate(input.now ?? new Date(), "snapshot time");
  const nowIso = now.toISOString();
  const preparationScope = input.preparationScope ?? "all";
  if (
    preparationScope !== "core" && preparationScope !== "maintenance" &&
    preparationScope !== "all"
  ) {
    throw new RangeError("nightly preparation scope is invalid");
  }
  if (
    input.coverageMode !== "complete_current" && input.coverageMode !== "auto"
  ) {
    throw new RangeError("nightly coverage mode is invalid");
  }
  const completedSourceIds = new Set(input.completedSourceIds ?? []);
  if ([...completedSourceIds].some((sourceId) => !SOURCE_POLICY_BY_ID.has(sourceId as SourceId))) {
    throw new RangeError("completed source IDs contain an unknown source");
  }
  if (completedSourceIds.size > 0) {
    throw new RangeError("completed source IDs are invocation-local scheduler state");
  }
  const enabledRows = input.includeSourceAcquisitions
    ? await input.database.prepare("SELECT id FROM auction_sources WHERE enabled = 1 AND permission_status = 'allowed'").all<{id: string}>()
    : null;
  const enabledIds = new Set((enabledRows?.results ?? []).map((row) => row.id));
  const remainingPolicies = input.includeSourceAcquisitions
    ? sourceOrchestrationRegistry.filter((policy) => enabledIds.has(policy.sourceId))
    : [];
  const exposedPreparationStages = preparationScope === "core"
    ? CORE_PREPARATION_WORK_STAGES
    : preparationScope === "maintenance"
    ? MAINTENANCE_PREPARATION_WORK_STAGES
    : PREPARATION_WORK_STAGES;
  const exposedPlaceholders = exposedPreparationStages.map(() => "?").join(", ");
  const placeholders = PREPARATION_WORK_STAGES.map(() => "?").join(", ");
  const corePlaceholders = CORE_PREPARATION_WORK_STAGES.map(() => "?").join(", ");
  const maintenancePlaceholders = MAINTENANCE_PREPARATION_WORK_STAGES.map(() => "?")
    .join(", ");
  const traversalEvidenceStatement = input.includeSourceAcquisitions
    ? input.database.prepare(`
        SELECT traversal.source_id, traversal.traversal_id, traversal.fingerprint,
          traversal.expected_pages, traversal.expected_listings,
          page.page_key, page.completed_at
        FROM source_inventory_traversals traversal
        LEFT JOIN source_inventory_traversal_pages page
          ON page.traversal_id = traversal.traversal_id
        ORDER BY traversal.source_id, page.page_key
      `)
    : input.database.prepare(`
        SELECT NULL AS source_id, NULL AS traversal_id, NULL AS fingerprint,
          NULL AS expected_pages, NULL AS expected_listings,
          NULL AS page_key, NULL AS completed_at
        WHERE 0
      `);
  const [rowsResult, countsResult, traversalResult,
    publicationHeadsResult] = await input.database.batch([
    input.database.prepare(`
      WITH eligible_work AS (
        SELECT ${WORK_ROW_COLUMNS},
          ${pipelinePhaseSql("stage")} AS scheduler_phase,
          CASE WHEN available_at <= ?
            AND (lease_owner IS NULL OR lease_expires_at <= ?) THEN 0 ELSE 1 END
            AS readiness_bucket,
          COALESCE(source_id, 'scheduler_local') AS fairness_source
        FROM pipeline_work_items
        WHERE stage IN (${exposedPlaceholders})
          AND (
            source_id IS NOT NULL OR
            stage IN ('projection_group_refresh', 'projection_global_refresh')
          )
          AND (
            stage != 'primary_image' OR NOT EXISTS (
              SELECT 1 FROM listing_recovery_status terminal_image
              WHERE terminal_image.listing_id = pipeline_work_items.listing_id
                AND terminal_image.state = 'terminal'
                AND terminal_image.stage = 'image'
                AND ${CURRENT_TERMINAL_IMAGE_EVIDENCE_SQL}
            )
          )
      ), ranked_work AS (
        SELECT ${WORK_ROW_COLUMNS}, scheduler_phase, readiness_bucket, fairness_source,
          ROW_NUMBER() OVER (
            PARTITION BY scheduler_phase, readiness_bucket, fairness_source
            ORDER BY available_at, priority DESC, updated_at, stage, subject_id, subject_type
          ) AS fairness_rank
        FROM eligible_work
      )
      SELECT ${WORK_ROW_COLUMNS}
      FROM ranked_work
      ORDER BY
        scheduler_phase, readiness_bucket, fairness_rank, fairness_source,
        available_at, priority DESC, updated_at, stage, subject_id, subject_type
      LIMIT ?
    `).bind(nowIso, nowIso, ...exposedPreparationStages, limit),
    input.database.prepare(`
      WITH target(now_iso) AS (SELECT ?)
      SELECT
        COALESCE(SUM(CASE WHEN available_at <= target.now_iso
          AND (lease_owner IS NULL OR lease_expires_at <= target.now_iso) THEN 1 ELSE 0 END), 0)
          AS ready,
        COALESCE(SUM(CASE WHEN available_at > target.now_iso
          AND (lease_owner IS NULL OR lease_expires_at <= target.now_iso) THEN 1 ELSE 0 END), 0)
          AS deferred,
        COALESCE(SUM(CASE WHEN lease_owner IS NOT NULL
          AND lease_expires_at > target.now_iso THEN 1 ELSE 0 END), 0) AS claimed,
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN work.stage IN (${corePlaceholders})
          AND work.available_at <= target.now_iso
          AND (work.lease_owner IS NULL OR work.lease_expires_at <= target.now_iso)
          THEN 1 ELSE 0 END), 0) AS core_ready,
        COALESCE(SUM(CASE WHEN work.stage IN (${corePlaceholders})
          AND work.available_at > target.now_iso
          AND (work.lease_owner IS NULL OR work.lease_expires_at <= target.now_iso)
          THEN 1 ELSE 0 END), 0) AS core_deferred,
        COALESCE(SUM(CASE WHEN work.stage IN (${corePlaceholders})
          AND work.lease_owner IS NOT NULL
          AND work.lease_expires_at > target.now_iso
          THEN 1 ELSE 0 END), 0) AS core_claimed,
        COALESCE(SUM(CASE WHEN work.stage IN (${maintenancePlaceholders})
          AND work.available_at <= target.now_iso
          AND (work.lease_owner IS NULL OR work.lease_expires_at <= target.now_iso)
          THEN 1 ELSE 0 END), 0) AS maintenance_ready,
        COALESCE(SUM(CASE WHEN work.stage IN (${maintenancePlaceholders})
          AND work.available_at > target.now_iso
          AND (work.lease_owner IS NULL OR work.lease_expires_at <= target.now_iso)
          THEN 1 ELSE 0 END), 0) AS maintenance_deferred,
        COALESCE(SUM(CASE WHEN work.stage IN (${maintenancePlaceholders})
          AND work.lease_owner IS NOT NULL
          AND work.lease_expires_at > target.now_iso
          THEN 1 ELSE 0 END), 0) AS maintenance_claimed,
        COALESCE(SUM(CASE WHEN work.stage = 'primary_image'
          AND work.available_at <= target.now_iso
          AND (work.lease_owner IS NULL OR work.lease_expires_at <= target.now_iso)
          AND NOT EXISTS (
            SELECT 1 FROM listing_recovery_status terminal_image
            WHERE terminal_image.listing_id = work.listing_id
              AND terminal_image.state = 'terminal'
              AND terminal_image.stage = 'image'
              AND ${CURRENT_TERMINAL_IMAGE_EVIDENCE_SQL}
          ) THEN 1 ELSE 0 END), 0) AS primary_image_ready,
        COALESCE(SUM(CASE WHEN work.stage = 'primary_image'
          AND work.available_at > target.now_iso
          AND (work.lease_owner IS NULL OR work.lease_expires_at <= target.now_iso)
          AND NOT EXISTS (
            SELECT 1 FROM listing_recovery_status terminal_image
            WHERE terminal_image.listing_id = work.listing_id
              AND terminal_image.state = 'terminal'
              AND terminal_image.stage = 'image'
              AND ${CURRENT_TERMINAL_IMAGE_EVIDENCE_SQL}
          ) THEN 1 ELSE 0 END), 0) AS primary_image_deferred,
        COALESCE(SUM(CASE WHEN work.stage = 'primary_image'
          AND work.lease_owner IS NOT NULL
          AND work.lease_expires_at > target.now_iso
          AND NOT EXISTS (
            SELECT 1 FROM listing_recovery_status terminal_image
            WHERE terminal_image.listing_id = work.listing_id
              AND terminal_image.state = 'terminal'
              AND terminal_image.stage = 'image'
              AND ${CURRENT_TERMINAL_IMAGE_EVIDENCE_SQL}
          ) THEN 1 ELSE 0 END), 0) AS primary_image_claimed
        ,COALESCE(SUM(CASE WHEN work.stage IN (
          'enrichment_text', 'enrichment_embedding'
        ) AND work.available_at <= target.now_iso
          AND (work.lease_owner IS NULL OR work.lease_expires_at <= target.now_iso)
          THEN 1 ELSE 0 END), 0) AS enrichment_ready
        ,COALESCE(SUM(CASE WHEN work.stage IN (
          'enrichment_text', 'enrichment_embedding'
        ) AND work.available_at > target.now_iso
          AND (work.lease_owner IS NULL OR work.lease_expires_at <= target.now_iso)
          THEN 1 ELSE 0 END), 0) AS enrichment_deferred
        ,COALESCE(SUM(CASE WHEN work.stage IN (
          'enrichment_text', 'enrichment_embedding'
        ) AND work.lease_owner IS NOT NULL
          AND work.lease_expires_at > target.now_iso
          THEN 1 ELSE 0 END), 0) AS enrichment_claimed
        ,COALESCE(SUM(CASE WHEN work.stage IN (
          'enrichment_text', 'enrichment_embedding'
        ) THEN 1 ELSE 0 END), 0) AS enrichment_total
      FROM pipeline_work_items work
      CROSS JOIN target
      WHERE work.stage IN (${placeholders})
        AND (
          work.source_id IS NOT NULL OR
          work.stage IN ('projection_group_refresh', 'projection_global_refresh')
        )
        AND (
          work.stage != 'primary_image' OR NOT EXISTS (
            SELECT 1 FROM listing_recovery_status terminal_image
            WHERE terminal_image.listing_id = work.listing_id
              AND terminal_image.state = 'terminal'
              AND terminal_image.stage = 'image'
              AND ${CURRENT_TERMINAL_IMAGE_EVIDENCE_SQL}
          )
        )
    `).bind(
      nowIso,
      ...CORE_PREPARATION_WORK_STAGES,
      ...CORE_PREPARATION_WORK_STAGES,
      ...CORE_PREPARATION_WORK_STAGES,
      ...MAINTENANCE_PREPARATION_WORK_STAGES,
      ...MAINTENANCE_PREPARATION_WORK_STAGES,
      ...MAINTENANCE_PREPARATION_WORK_STAGES,
      ...PREPARATION_WORK_STAGES,
    ),
    traversalEvidenceStatement,
    input.database.prepare(`
      SELECT head.source_id, head.inventory_run_id, publication.listing_count,
        publication.published_at
      FROM source_inventory_publication_heads head
      JOIN source_inventory_publications publication
        ON publication.source_id = head.source_id
        AND publication.inventory_run_id = head.inventory_run_id
      ORDER BY head.source_id
    `),
  ]);
  const access = await inspectSourceAccessStates({
    database: input.database,
    limit: 500,
    now,
  });
  const traversalEvidence = await schedulerTraversalEvidence(
    (traversalResult?.results ?? []) as unknown as SchedulerTraversalEvidenceRow[],
  );
  const publicationHeads = new Map(
    ((publicationHeadsResult?.results ?? []) as unknown as Array<{
      source_id: string;
      inventory_run_id: string;
      listing_count: number;
      published_at: string;
    }>).map((row) => [row.source_id, Object.freeze({
      head: Object.freeze({
        inventoryRunId: row.inventory_run_id,
        listingCount: Number(row.listing_count),
      }),
      publishedAt: row.published_at,
    })]),
  );
  const allItems = ((rowsResult?.results ?? []) as unknown as WorkRow[]).map(mapWorkItem);
  const firstPhase = allItems[0] === undefined ? null : pipelinePhase(allItems[0].stage);
  const sourceCandidates: SchedulerCandidate[] = [];
  if (input.includeSourceAcquisitions) {
    for (const policy of remainingPolicies.slice(0, limit)) {
      const adapter = getSourceAdapter(policy.sourceId);
      const generation = await readSourceAcquisitionGeneration(input.database, policy.sourceId);
      const priorCheckpoint = traversalEvidence.get(policy.sourceId) ?? null;
      const publication = publicationHeads.get(policy.sourceId) ?? null;
      const priorHead = publication?.head ?? null;
      const adapterVersion = NIGHTLY_SCHEDULER_RUNTIME_VERSION;
      const proofVersion = "source-publication-receipt-v1";
      const priorCheckpointIdentity = priorCheckpoint === null ? null : await hashCanonicalJson(priorCheckpoint);
      const sourceInput: SchedulerSourceInput = Object.freeze({
        campaignId,
        coverageMode: "complete_current",
        adapterVersion,
        proofVersion,
        expectedGeneration: generation,
        inputHash: await hashCanonicalJson({campaignId, sourceId: policy.sourceId, generation, priorHead, priorCheckpoint, manifest: adapter.manifest}),
        inputRevision: generation,
        baseInventoryRunId: priorHead?.inventoryRunId ?? null,
        priorCheckpointIdentity,
        priorCheckpoint,
        pageOrPartitionIdentity: "complete-current-campaign",
        requestIdentity: campaignId + ":" + policy.sourceId + ":complete_current",
        requestBudget: policy.requestBudgetCeiling,
        priorHead,
      });
      const candidate = sourceCandidateFromPolicy({
        policy,
        completedSourceIds: new Set(),
        timing: sourceTiming(policy),
        accessRows: access.rows,
        availableAt: nowIso,
        enqueueOrder: policy.order,
      });
      sourceCandidates.push(Object.freeze({ ...candidate, sourceInput }));
    }
  }
  // Source acquisition and preparation are an explicit one-way campaign
  // boundary. During the source phase every durable preparation item remains
  // coalesced but invisible; only the authorized transition to
  // `includeSourceAcquisitions=false` may expose it. This prevents a freshly
  // published source's projection fan-out from interrupting the independent
  // sources that still need their terminal boundary.
  const selectedItems = input.includeSourceAcquisitions || firstPhase === null
    ? []
    : allItems.filter((item) => pipelinePhase(item.stage) === firstPhase);
  const preparationCandidates = selectedItems
    .flatMap((item, index) => {
      const policy = item.sourceId === null ? undefined : SOURCE_POLICY_BY_ID.get(item.sourceId as SourceId);
      if (!PREPARATION_STAGE_SET.has(item.stage)) return [];
      return [PROJECTION_STAGE_SET.has(item.stage) || policy === undefined
        ? localPreparationCandidate(item, index)
        : preparationCandidateFromWorkItem({
            item,
            policy,
            timing: preparationTiming(item),
            accessRows: access.rows,
            dependencyDepth: DEPTH_BY_SOURCE.get(policy.sourceId) ?? 0,
            enqueueOrder: sourceOrchestrationRegistry.length + index,
          })];
    });
  const candidates = Object.freeze([...sourceCandidates, ...preparationCandidates]);
  const count = ((countsResult?.results ?? [])[0] ?? {}) as Record<string, unknown>;
  const totalPreparation = numeric(count.total);
  const coreReady = numeric(count.core_ready);
  const coreDeferred = numeric(count.core_deferred);
  const coreClaimed = numeric(count.core_claimed);
  const maintenanceReady = numeric(count.maintenance_ready);
  const maintenanceDeferred = numeric(count.maintenance_deferred);
  const maintenanceClaimed = numeric(count.maintenance_claimed);
  const exposedPreparation = preparationScope === "core"
    ? coreReady + coreDeferred + coreClaimed
    : preparationScope === "maintenance"
    ? maintenanceReady + maintenanceDeferred + maintenanceClaimed
    : totalPreparation;
  const primaryImageReady = numeric(count.primary_image_ready);
  const primaryImageDeferred = numeric(count.primary_image_deferred);
  const primaryImageClaimed = numeric(count.primary_image_claimed);
  const primaryImageRemaining = primaryImageReady + primaryImageDeferred +
    primaryImageClaimed;
  const enrichmentClaimed = numeric(count.enrichment_claimed);
  const enrichmentRemaining = numeric(count.enrichment_total);
  const enrichmentProgress: SchedulerEnrichmentProgress = Object.freeze({
    scope: SCHEDULER_ENRICHMENT_PROGRESS_SCOPE,
    queued: enrichmentRemaining,
    claimed: enrichmentClaimed,
    completed: null,
    stale: null,
    remaining: enrichmentRemaining,
  });
  // `remainingWork` describes the whole scheduler boundary, not only the
  // currently exposed phase. Source and preparation populations remain
  // mutually exclusive candidates, but both stay visible in the totals.
  const totalRemaining = remainingPolicies.length + exposedPreparation;
  return Object.freeze({
    generation: `${campaignId}:${nowIso}:${sourceCandidates.length}:${totalPreparation}${
      preparationScope === "all" ? "" : `:${preparationScope}`
    }`,
    candidates,
    boundedReadCount: 2,
    remainingWork: Object.freeze({
      sourceAcquisitions: remainingPolicies.length,
      preparationReady: numeric(count.ready),
      preparationDeferred: numeric(count.deferred),
      preparationClaimed: numeric(count.claimed),
      coreReady,
      coreDeferred,
      coreClaimed,
      maintenanceReady,
      maintenanceDeferred,
      maintenanceClaimed,
      returned: candidates.length,
      truncated: Math.max(0, totalRemaining - candidates.length),
      ...(primaryImageRemaining === 0
        ? {}
        : {
            primaryImages: Object.freeze({
              ready: primaryImageReady,
              deferred: primaryImageDeferred,
              claimed: primaryImageClaimed,
              remaining: primaryImageRemaining,
            }),
          }),
      enrichment: enrichmentProgress,
    }),
  });
}

export async function reserveNightlySchedulerCandidate(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly now?: Date;
}): Promise<SchedulerReservation> {
  const now = validDate(input.now ?? new Date(), "reservation time");
  if (
    input.candidate.kind === "preparation" &&
    COMBINED_CALLBACK_STAGE_SET.has(input.candidate.stage)
  ) {
    const item = requireWorkItem(input.candidate);
    const identity = await hashCanonicalJson({
      candidateId: input.candidate.id,
      inputHash: item.inputHash,
      revision: item.revision,
    });
    return Object.freeze({
      reservationId: `combined:${identity.slice(7, 31)}`,
      candidateId: input.candidate.id,
      sourceId: input.candidate.sourceId,
      laneKey: item.laneKey,
      inputRevision: item.revision,
      expiresAt: new Date(now.getTime() + PREPARATION_LEASE_MS).toISOString(),
      queueClaim: null,
      acquisitionClaim: null,
    });
  }
  const policy = requirePolicy(input.candidate);
  if (input.candidate.kind === "source_acquisition") {
    const sourceInput = requireSourceInput(input.candidate);
    const expectation = await sourceReservationExpectation(input.candidate);
    const generation = await readSourceAcquisitionGeneration(input.database, policy.sourceId);
    if (generation !== sourceInput.expectedGeneration) throw priorHeadError("source_generation_changed");
    const access = await checkSourceDocumentAccess({
      database: input.database,
      manifest: getSourceAdapter(policy.sourceId).manifest,
      now,
    });
    if (!access.eligible) throw priorHeadError(access.row.reasonCode ?? access.row.state);
    const reservationLeaseMs =
        sourceInput.coverageMode === "complete_current" &&
        policy.campaignAcquisition === "direct"
      ? SCHEDULED_SOURCE_QUANTUM_RESERVATION_LEASE_MS
      : SOURCE_LEASE_MS;
    const reserve = (reservationId: string) => reserveSourceAcquisition({
      database: input.database,
      reservationId,
      ...expectation.fields,
      leaseMs: reservationLeaseMs,
      now,
    });
    let reserved = await reserve(expectation.baseReservationId);
    if (
      reserved.outcome === "lane_contended" &&
      matchesSourceReservationExpectation(
        reserved.activeReservation,
        expectation,
      )
    ) {
      reserved = Object.freeze({
        outcome: "already_reserved" as const,
        reservation: reserved.activeReservation,
      });
    } else if (
      reserved.outcome === "generation_changed" &&
      reserved.currentGeneration === sourceInput.expectedGeneration
    ) {
      const attempts = await input.database.prepare(`
        SELECT COUNT(*) AS count
        FROM source_acquisition_reservations
        WHERE reservation_id = ? OR reservation_id LIKE ?
      `).bind(
        expectation.baseReservationId,
        `${expectation.baseReservationId}:%`,
      ).first<{ count: number }>();
      const attemptOrdinal = numeric(attempts?.count);
      if (!Number.isSafeInteger(attemptOrdinal) || attemptOrdinal < 1 || attemptOrdinal > 10_000) {
        throw priorHeadError("source_reservation_attempt_history_invalid");
      }
      reserved = await reserve(`${expectation.baseReservationId}:${attemptOrdinal}`);
      if (
        reserved.outcome === "lane_contended" &&
        matchesSourceReservationExpectation(
          reserved.activeReservation,
          expectation,
        )
      ) {
        reserved = Object.freeze({
          outcome: "already_reserved" as const,
          reservation: reserved.activeReservation,
        });
      }
    }
    if (reserved.outcome !== "reserved" && reserved.outcome !== "already_reserved") {
      throw priorHeadError(reserved.outcome === "lane_contended"
        ? "source_acquisition_lane_contended"
        : "source_generation_changed");
    }
    const reservation = reserved.reservation;
    if (reserved.outcome === "already_reserved") {
      // A persisted acquired bundle is a post-callback boundary. It may be
      // reconciled from its exact retained receipt, but it must never be
      // converted back into another callback dispatch by a reserve retry.
      if (reservation.state === "acquired") {
        throw priorHeadError("source_acquisition_reservation_already_acquired");
      }
      // Direct callbacks derive their eight-minute server quantum from the
      // original 45-minute lease. Once that exact quantum has elapsed, reuse
      // fails closed so the pre-dispatch abort path can release the stale
      // claim; extending it here could duplicate a detached callback.
      if (
        sourceInput.coverageMode === "complete_current" &&
        policy.campaignAcquisition === "direct" &&
        Date.parse(directSourceQuantumDeadline(reservation.expiresAt)) <= now.getTime()
      ) {
        throw priorHeadError("scheduled_source_quantum_reservation_stale");
      }
    }
    return Object.freeze({
      reservationId: reservation.reservationId,
      candidateId: input.candidate.id,
      sourceId: policy.sourceId,
      laneKey: reservation.laneKey,
      inputRevision: reservation.inputRevision,
      expiresAt: reservation.expiresAt,
      queueClaim: null,
      acquisitionClaim: sourceAcquisitionClaimIdentity(reservation),

    });
  }
  const item = requireWorkItem(input.candidate);
  if (
    item.subjectType === "listing" &&
    DISTANCE_EXCLUSION_SUPPRESSED_STAGE_SET.has(item.stage)
  ) {
    const origin = await readInitializedActiveOrigin(input.database);
    const excluded = await readExactCurrentDistanceExclusionListingIds({
      database: input.database,
      listingIds: [item.subjectId],
      originPostalCode: origin.postalCode,
      originCountryCode: origin.countryCode,
    });
    if (excluded.has(item.subjectId)) {
      throw priorHeadError("pipeline_work_distance_excluded");
    }
  }
  const ownerHash = (await hashCanonicalJson({ candidateId: input.candidate.id, now: now.toISOString() }))
    .slice(7, 31);
  const owner = `nightly:${ownerHash}`;
  const expiresAt = new Date(now.getTime() + PREPARATION_LEASE_MS).toISOString();
  const [update, selected] = await input.database.batch([
    input.database.prepare(`
      UPDATE pipeline_work_items
      SET lease_owner = ?, lease_expires_at = ?, claimed_input_hash = input_hash,
          claimed_revision = revision, last_claimed_at = ?, updated_at = ?
      WHERE stage = ? AND subject_type = ? AND subject_id = ?
        AND input_hash = ? AND revision = ? AND available_at <= ?
        AND (lease_owner IS NULL OR lease_expires_at <= ?)
    `).bind(
      owner, expiresAt, now.toISOString(), now.toISOString(), item.stage,
      item.subjectType, item.subjectId, item.inputHash, item.revision,
      now.toISOString(), now.toISOString(),
    ),
    input.database.prepare(`
      SELECT ${WORK_ROW_COLUMNS} FROM pipeline_work_items
      WHERE stage = ? AND subject_type = ? AND subject_id = ?
        AND lease_owner = ? AND claimed_input_hash = ? AND claimed_revision = ?
    `).bind(item.stage, item.subjectType, item.subjectId, owner, item.inputHash, item.revision),
  ]);
  if (changes(update) !== 1) throw priorHeadError("pipeline_work_claim_missed");
  const claimedRows = (selected?.results ?? []) as unknown as WorkRow[];
  if (claimedRows.length !== 1) throw priorHeadError("pipeline_work_claim_missed");
  const claimed = mapWorkItem(claimedRows[0]!);
  const seedClaim = Object.freeze({
    stage: claimed.stage,
    subjectType: claimed.subjectType,
    subjectId: claimed.subjectId,
    owner,
    inputHash: claimed.inputHash,
    revision: claimed.revision,
  });
  return Object.freeze({
    reservationId: `work:${ownerHash}`,
    candidateId: input.candidate.id,
    sourceId: policy.sourceId,
    laneKey: input.candidate.networkLanes[0]!,
    inputRevision: claimed.revision,
    expiresAt,
    queueClaim: seedClaim,


    acquisitionClaim: null,
  });
}

async function sourceReservationExpectation(candidate: SchedulerCandidate) {
  const policy = requirePolicy(candidate);
  const sourceInput = requireSourceInput(candidate);
  const reservationDigest = await hashCanonicalJson({
    campaignId: sourceInput.campaignId,
    sourceId: policy.sourceId,
    coverageMode: sourceInput.coverageMode,
    expectedGeneration: sourceInput.expectedGeneration,
    requestIdentity: sourceInput.requestIdentity,
    pageOrPartitionIdentity: sourceInput.pageOrPartitionIdentity,
    priorCheckpointIdentity: sourceInput.priorCheckpointIdentity,
    adapterVersion: sourceInput.adapterVersion,
    proofVersion: sourceInput.proofVersion,
    laneKey: policy.networkLanes[0],
    inputHash: sourceInput.inputHash,
    inputRevision: sourceInput.inputRevision,
    requestBudget: sourceInput.requestBudget ?? policy.requestBudgetCeiling,
  });
  return Object.freeze({
    baseReservationId: `nightly:${reservationDigest.slice(7, 39)}`,
    fields: Object.freeze({
      sourceId: policy.sourceId,
      requestRole: sourceInput.coverageMode,
      requestIdentity: sourceInput.requestIdentity ??
        `${sourceInput.campaignId}:${policy.sourceId}:${sourceInput.coverageMode}`,
      pageOrPartitionIdentity: sourceInput.pageOrPartitionIdentity ?? null,
      priorCheckpointIdentity: sourceInput.priorCheckpointIdentity ?? null,
      adapterVersion: sourceInput.adapterVersion,
      proofVersion: sourceInput.proofVersion,
      laneKey: policy.networkLanes[0]!,
      expectedGeneration: sourceInput.expectedGeneration,
      inputHash: sourceInput.inputHash,
      inputRevision: sourceInput.inputRevision,
      requestBudget: sourceInput.requestBudget ?? policy.requestBudgetCeiling,
      leaseOwner: `nightly:${reservationDigest.slice(7, 31)}`,
    }),
  });
}

function matchesSourceReservationExpectation(
  reservation: Awaited<ReturnType<typeof readSourceAcquisitionReservation>> & {},
  expectation: Awaited<ReturnType<typeof sourceReservationExpectation>>,
): boolean {
  const fields = expectation.fields;
  return (
    (
      reservation.reservationId === expectation.baseReservationId ||
      new RegExp(`^${expectation.baseReservationId}:[1-9][0-9]*$`, "u")
        .test(reservation.reservationId)
    ) &&
    reservation.sourceId === fields.sourceId &&
    reservation.requestRole === fields.requestRole &&
    reservation.requestIdentity === fields.requestIdentity &&
    reservation.pageOrPartitionIdentity === fields.pageOrPartitionIdentity &&
    reservation.priorCheckpointIdentity === fields.priorCheckpointIdentity &&
    reservation.adapterVersion === fields.adapterVersion &&
    reservation.proofVersion === fields.proofVersion &&
    reservation.laneKey === fields.laneKey &&
    reservation.expectedGeneration === fields.expectedGeneration &&
    reservation.inputHash === fields.inputHash &&
    reservation.inputRevision === fields.inputRevision &&
    reservation.requestBudget === fields.requestBudget &&
    reservation.leaseOwner === fields.leaseOwner &&
    (reservation.state === "reserved" || reservation.state === "acquired")
  );
}

export function acquireNightlySchedulerCandidate(input: {
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
}): SchedulerCallbackInstruction {
  assertReservation(input.candidate, input.reservation);
  if (input.candidate.kind === "source_acquisition") {
    const policy = requirePolicy(input.candidate);
    const sourceInput = requireSourceInput(input.candidate);
    return policy.campaignAcquisition === "local_companion"
      ? callback("companion", "/v1/source-acquisition", {
          sourceId: policy.sourceId,
          mode: "catalog",
          trigger: "scheduled",
        }, "source_catalog", 2 * 60 * 60_000)
      : callback("dashboard", "/api/runs", {
          kind: "source_discovery",
          sourceId: policy.sourceId,
          schedulerQuantum: {
            campaignId: sourceInput.campaignId,
            sourceId: policy.sourceId,
            coverageMode: "complete_current",
            acquisitionDeadlineAt: directSourceQuantumDeadline(
              input.reservation.expiresAt,
            ),
          },
        }, "source_catalog", SCHEDULED_SOURCE_QUANTUM_DISCOVERY_LEASE_MS);
  }
  const stage = input.candidate.stage;
  if (PROJECTION_STAGE_SET.has(stage)) {
    return Object.freeze({ kind: "local_commit" });
  }
  if (NO_REFETCH_CONTINUATION_STAGE_SET.has(stage)) {
    return Object.freeze({ kind: "local_commit" });
  }
  if (stage === "proximity") {
    if (input.reservation.queueClaim === null) {
      throw priorHeadError("pipeline_work_claim_missing");
    }
    return callback("dashboard", "/api/proximity", {
      queueClaim: input.reservation.queueClaim,
    }, "proximity_session", 3 * 60 * 60_000);
  }
  if (stage === "source_release" || stage === "source_acquisition_readiness") {
    return Object.freeze({ kind: "local_commit" });
  }
  if (stage === "enrichment_text" || stage === "enrichment_embedding") {
    if (input.reservation.queueClaim === null) {
      throw priorHeadError("pipeline_work_claim_missing");
    }
    return callback("dashboard", "/api/enrichment/run", {
      limit: 10,
      chunks: 10,
      queueClaim: input.reservation.queueClaim,
    }, "enrichment_session", ENRICHMENT_CALLBACK_TIMEOUT_MS, "acquire_outside_fifo");
  }
  if (stage === "primary_image" && isDirectImageSourceId(input.candidate.sourceId)) {
    if (input.reservation.queueClaim === null) {
      throw priorHeadError("pipeline_work_claim_missing");
    }
    return callback("companion", "/v1/primary-image-session", {
      sourceId: input.candidate.sourceId,
      claim: input.reservation.queueClaim,
    }, "primary_image_session", 30 * 60_000);
  }
  return callback("dashboard", "/api/runs", {
        kind: "source_continuation",
        sourceId: input.candidate.sourceId,
      }, "source_continuation", 30 * 60_000);
}

function directSourceQuantumDeadline(reservationExpiresAt: string): string {
  const expiresAtMs = Date.parse(reservationExpiresAt);
  if (
    !Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0 ||
    new Date(expiresAtMs).toISOString() !== reservationExpiresAt
  ) throw priorHeadError("scheduled_source_quantum_reservation_expiry_invalid");
  const deadlineMs = expiresAtMs -
    (
      SCHEDULED_SOURCE_QUANTUM_RESERVATION_LEASE_MS -
      SCHEDULED_SOURCE_QUANTUM_ACQUISITION_WINDOW_MS
    );
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 0) {
    throw priorHeadError("scheduled_source_quantum_deadline_invalid");
  }
  return new Date(deadlineMs).toISOString();
}

/**
 * Reconciles an exact callback whose local HTTP client detached after dispatch.
 * It never invokes the callback. Preparation callbacks settle only their bound
 * queue claims; source callbacks retain their durable publication proof rules.
 */
export async function reconcileDetachedNightlySchedulerCallback(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  /** Exact response retained by the client when only both finalizer responses detached. */
  readonly receipt?: SchedulerCallbackReceipt;
  readonly callbackIdentity: string;
  readonly transportFailureReasonCode: "local_transport_failed";
  readonly dispatchedAt: string;
  readonly now?: Date;
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
}): Promise<SchedulerDetachedCallbackReconciliation> {
  const now = validDate(input.now ?? new Date(), "callback reconciliation time");
  const dispatchedAt = validDate(
    new Date(input.dispatchedAt),
    "detached callback dispatch time",
  );
  assertReservation(input.candidate, input.reservation);
  if (input.candidate.kind === "preparation") {
    return reconcileDetachedPreparationCallback(input, now, dispatchedAt);
  }
  const sourceInput = requireSourceInput(input.candidate);
  if (
    input.candidate.kind !== "source_acquisition" ||
    sourceInput.coverageMode !== "complete_current" ||
    input.transportFailureReasonCode !== "local_transport_failed" ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.callbackIdentity)
  ) throw priorHeadError("detached_callback_reconciliation_binding_invalid");
  const instruction = acquireNightlySchedulerCandidate({
    candidate: input.candidate,
    reservation: input.reservation,
  });
  if (
    instruction.kind !== "loopback_json" ||
    instruction.executionBoundary === "acquire_outside_fifo" ||
    instruction.successContract !== "source_catalog" ||
    await hashCanonicalJson(instruction) !== input.callbackIdentity
  ) throw priorHeadError("detached_callback_reconciliation_binding_invalid");
  const claim = requiredAcquisitionClaim(input.reservation);
  const stored = await readSourceAcquisitionReservation(
    input.database,
    claim.reservationId,
  );
  if (
    stored === null || stored.reservationId !== claim.reservationId ||
    stored.sourceId !== claim.sourceId || stored.laneKey !== claim.laneKey ||
    stored.leaseOwner !== claim.leaseOwner ||
    stored.expectedGeneration !== claim.expectedGeneration ||
    stored.inputHash !== claim.inputHash ||
    stored.inputRevision !== claim.inputRevision ||
    stored.requestRole !== "complete_current" ||
    !(
      ["reserved", "acquired", "committed"].includes(stored.state) ||
      (input.receipt !== undefined && stored.state === "failed")
    ) ||
    dispatchedAt.getTime() < Date.parse(stored.createdAt) ||
    dispatchedAt.getTime() > Date.parse(stored.expiresAt) ||
    dispatchedAt.getTime() > now.getTime()
  ) throw priorHeadError("detached_callback_reconciliation_reservation_changed");

  if (input.receipt !== undefined) {
    if (await hashCanonicalJson(input.receipt.body) !== input.receipt.responseHash) {
      return detachedAmbiguous("detached_callback_receipt_hash_mismatch");
    }
    const transition = completeCurrentPublicationTransition(
      input.receipt.body,
      input.candidate.sourceId,
    );
    if (!callbackSucceeded("source_catalog", input.receipt, input.candidate.sourceId)) {
      try {
        return Object.freeze({
          state: "outcome" as const,
          outcome: await finalizeFailedSourceAcquisition({
            database: input.database,
            candidate: input.candidate,
            reservation: input.reservation,
            receipt: input.receipt,
            now,
          }),
        });
      } catch (error) {
        if (isStateAmbiguousError(error)) {
          return detachedAmbiguous(error.reasonCode);
        }
        throw error;
      }
    }
    if (transition === null) {
      return detachedAmbiguous("detached_callback_receipt_publication_transition_missing");
    }
    if (stored.state === "failed") {
      return detachedAmbiguous("detached_callback_failed_receipt_mismatch");
    }
  }

  const committed = await reconstructCommittedDetachedBoundary({
    database: input.database,
    candidate: input.candidate,
    reservation: input.reservation,
  });
  if (committed !== null) {
    return Object.freeze({
      state: "outcome",
      outcome: Object.freeze({
        classification: "completed",
        madeProgress: true,
        remaining: false,
        sourceBoundary: committed,
      }),
    });
  }
  const activeLease = await input.database.prepare(`
    SELECT run_id FROM pipeline_run_lease
    WHERE expires_at > ?
    LIMIT 1
  `).bind(now.toISOString()).first<{ run_id: string }>();
  if (activeLease !== null) {
    return Object.freeze({
      state: "active",
      reasonCode: "detached_callback_mutation_active",
    });
  }
  const unsettled = await input.database.prepare(`
    SELECT COUNT(*) AS count
    FROM source_runs source_run
    JOIN discovery_runs discovery
      ON discovery.id = source_run.discovery_run_id
    WHERE source_run.source_id = ?
      AND source_run.started_at >= ?
      AND (
        source_run.status IN ('queued', 'running') OR
        discovery.status IN ('queued', 'running')
      )
  `).bind(
    input.candidate.sourceId,
    stored.createdAt,
  ).first<{ count: number }>();
  if (numeric(unsettled?.count) > 0) {
    return detachedAmbiguous("detached_callback_active_without_lease");
  }

  const resultingHead = await readDurableSourceHead(
    input.database,
    input.candidate.sourceId,
  );
  const priorHead = sourceInput.priorHead ?? null;
  if (!sameSchedulerSourceHead(resultingHead, priorHead)) {
    if (resultingHead === null) {
      return detachedAmbiguous("detached_callback_publication_head_regressed");
    }
    const sourceRunCount = await input.database.prepare(`
      SELECT COUNT(*) AS count
      FROM source_runs
      WHERE source_id = ? AND started_at >= ?
    `).bind(
      input.candidate.sourceId,
      stored.createdAt,
    ).first<{ count: number }>();
    const publicationRun = await input.database.prepare(`
      SELECT
        discovery.id AS discovery_run_id,
        discovery.status AS discovery_status,
        discovery.started_at AS discovery_started_at,
        discovery.completed_at AS discovery_completed_at,
        source_run.id AS source_run_id,
        source_run.status AS source_status,
        source_run.started_at AS source_started_at,
        source_run.completed_at AS source_completed_at
      FROM discovery_runs discovery
      JOIN source_runs source_run
        ON source_run.discovery_run_id = discovery.id
      WHERE discovery.id = ? AND source_run.source_id = ?
      LIMIT 2
    `).bind(
      resultingHead.inventoryRunId,
      input.candidate.sourceId,
    ).all<DetachedPublicationRunRow>();
    const rows = publicationRun.results ?? [];
    const run = rows.length === 1 ? rows[0]! : null;
    if (
      numeric(sourceRunCount?.count) !== 1 || run === null ||
      run.discovery_run_id !== resultingHead.inventoryRunId ||
      !["completed", "partial", "failed"].includes(run.discovery_status) ||
      run.source_status !== "completed" ||
      run.discovery_completed_at === null || run.source_completed_at === null ||
      !orderedDetachedPublicationTimes({
        reservationCreatedAt: stored.createdAt,
        discoveryStartedAt: run.discovery_started_at,
        sourceStartedAt: run.source_started_at,
        sourceCompletedAt: run.source_completed_at,
        publishedAt: resultingHead.publishedAt,
        discoveryCompletedAt: run.discovery_completed_at,
      })
    ) return detachedAmbiguous("detached_callback_publication_proof_mismatch");

    const priorPublication = priorHead === null
      ? null
      : await input.database.prepare(`
          SELECT inventory_run_id, listing_count, published_at
          FROM source_inventory_publications
          WHERE source_id = ? AND inventory_run_id = ?
          LIMIT 1
        `).bind(
          input.candidate.sourceId,
          priorHead.inventoryRunId,
        ).first<DurableSourceHeadRow>();
    if (
      priorHead !== null &&
      (priorPublication === null ||
        Number(priorPublication.listing_count) !== priorHead.listingCount)
    ) return detachedAmbiguous("detached_callback_prior_publication_mismatch");
    const transition = Object.freeze({
      resultingInventoryRunId: resultingHead.inventoryRunId,
      resultingUnionCount: resultingHead.listingCount,
      publishedAt: resultingHead.publishedAt,
      firstSeenCount: 0,
      priorPublicationHead: priorPublication === null
        ? null
        : Object.freeze({
            sourceId: input.candidate.sourceId,
            inventoryRunId: priorPublication.inventory_run_id,
            publishedAt: priorPublication.published_at,
            listingCount: Number(priorPublication.listing_count),
          }),
    });
    await verifyDurableCompleteCurrentPublication(input, transition);
    const durableEvidence = Object.freeze({
      contract: "detached-complete-current-durable-reconciliation-v1",
      sourceId: input.candidate.sourceId,
      reservationId: input.reservation.reservationId,
      callbackIdentity: input.callbackIdentity,
      discoveryRunId: run.discovery_run_id,
      sourceRunId: run.source_run_id,
      sourceCompletedAt: run.source_completed_at,
      resultingHead: Object.freeze({
        inventoryRunId: resultingHead.inventoryRunId,
        listingCount: resultingHead.listingCount,
        publishedAt: resultingHead.publishedAt,
      }),
    });
    const receiptIdentity = await hashCanonicalJson(durableEvidence);
    let bundleIdentity: string;
    let boundReceiptIdentity: string = receiptIdentity;
    if (stored.state === "committed") {
      const committedBundles = await input.database.prepare(`
        SELECT bundle_identity, response_hash
        FROM source_acquired_bundles
        WHERE reservation_id = ? AND source_id = ? AND state = 'committed'
        ORDER BY bundle_identity
        LIMIT 2
      `).bind(
        input.reservation.reservationId,
        input.candidate.sourceId,
      ).all<{ bundle_identity: string; response_hash: string }>();
      const rows = committedBundles.results ?? [];
      if (
        rows.length !== 1 ||
        !/^sha256:[0-9a-f]{64}$/u.test(rows[0]!.bundle_identity) ||
        !/^sha256:[0-9a-f]{64}$/u.test(rows[0]!.response_hash)
      ) return detachedAmbiguous("detached_callback_committed_bundle_mismatch");
      bundleIdentity = rows[0]!.bundle_identity;
      boundReceiptIdentity = rows[0]!.response_hash;
    } else {
      const encoded = JSON.stringify(durableEvidence);
      const persisted = await putSourceAcquiredBundle({
        database: input.database,
        claim,
        responseHash: receiptIdentity,
        contentHash: receiptIdentity,
        contentType: "application/json",
        byteLength: new TextEncoder().encode(encoded).byteLength,
        parserVersion: NIGHTLY_SCHEDULER_RUNTIME_VERSION,
        validationVersion: NIGHTLY_SCHEDULER_RUNTIME_VERSION,
        validatedMetadata: Object.freeze({
          sourceId: input.candidate.sourceId,
          contract: "complete_current_detached_durable_reconciliation",
          published: true,
        }),
        requestsConsumed: 1,
        now,
      });
      if (persisted.outcome === "claim_missed") {
        return detachedAmbiguous("detached_callback_bundle_claim_missed");
      }
      bundleIdentity = persisted.bundle.bundleIdentity;
      const currentGeneration = await readSourceAcquisitionGeneration(input.database, input.candidate.sourceId);
      const committedReservation = await commitSourceAcquisitionReservation({
        database: input.database,
        claim,
        bundleIdentity,
        currentGeneration,
        now,
      });
      if (committedReservation.outcome !== "committed") {
        return detachedAmbiguous(`detached_callback_${committedReservation.outcome}`);
      }
    }
    const receipt: SchedulerCallbackReceipt = Object.freeze({
      status: 200,
      responseHash: boundReceiptIdentity,
      body: null,
    });
    const sourceBoundary = await recordCompleteCurrentPublicationProof({
      database: input.database,
      candidate: input.candidate,
      reservation: input.reservation,
      bundleIdentity,
      receipt,
      transition,
      now,
      telemetry: input.telemetry,
      telemetryContext: input.telemetryContext,
    });
    const boundProof = await input.database.prepare(`
      SELECT reservation_id FROM source_acquisition_publications
      WHERE proof_id = ? AND source_id = ?
      LIMIT 1
    `).bind(
      sourceBoundary.proofIdentity,
      input.candidate.sourceId,
    ).first<{ reservation_id: string | null }>();
    if (boundProof?.reservation_id !== input.reservation.reservationId) {
      return detachedAmbiguous("detached_callback_publication_proof_binding_mismatch");
    }
    return Object.freeze({
      state: "outcome",
      outcome: Object.freeze({
        classification: "completed",
        madeProgress: true,
        remaining: false,
        sourceBoundary,
      }),
    });
  }

  if (input.receipt !== undefined) {
    // An authoritative success receipt cannot be downgraded to checkpoint or
    // prior-head preservation. Without its claimed durable publication the
    // exact receipt/head pair is contradictory and remains ambiguous.
    return detachedAmbiguous("detached_callback_receipt_publication_missing");
  }

  const resultingCheckpoint = await readSchedulerTraversalEvidence(
    input.database,
    input.candidate.sourceId,
  );
  const checkpoint = compareSchedulerCheckpointEvidence(
    sourceInput.priorCheckpoint ?? null,
    resultingCheckpoint,
  );
  if (checkpoint === "regressed") {
    return detachedAmbiguous("detached_callback_checkpoint_regressed");
  }
  if (
    checkpoint === "same" &&
    now.getTime() - dispatchedAt.getTime() <
      instruction.timeoutMs + DETACHED_CALLBACK_SETTLEMENT_GRACE_MS
  ) {
    return Object.freeze({
      state: "active",
      reasonCode: "detached_callback_settlement_pending",
    });
  }
  const release = async (
    reasonCode: string,
  ): Promise<SchedulerDetachedCallbackReconciliation | null> => {
    try {
      await releaseExactFailedSourceReservation({
        database: input.database,
        candidate: input.candidate,
        reservation: input.reservation,
        reasonCode,
        failureFingerprint: input.callbackIdentity,
        now,
      });
      return null;
    } catch (error) {
      if (isStateAmbiguousError(error)) return detachedAmbiguous(error.reasonCode);
      throw error;
    }
  };
  const access = await checkSourceDocumentAccess({
    database: input.database,
    manifest: getSourceAdapter(requirePolicy(input.candidate).sourceId).manifest,
    now,
  });
  if (!access.eligible) {
    const reasonCode = access.row.reasonCode ?? access.row.state;
    const releaseAmbiguity = await release(reasonCode);
    if (releaseAmbiguity !== null) return releaseAmbiguity;
    return Object.freeze({
      state: "outcome",
      outcome: failedSourceAccessOutcome({
        reasonCode,
        availableAt: access.row.nextEligibleAt,
      }, checkpoint === "advanced" || checkpoint === "replanned"),
    });
  }
  if (checkpoint === "advanced" || checkpoint === "replanned") {
    const reasonCode = checkpoint === "advanced"
      ? "source_checkpoint_advanced_after_detach"
      : "source_checkpoint_safely_replanned_after_detach";
    const releaseAmbiguity = await release(reasonCode);
    if (releaseAmbiguity !== null) return releaseAmbiguity;
    return Object.freeze({
      state: "outcome",
      outcome: Object.freeze({
        classification: "retryable_pressure",
        madeProgress: true,
        remaining: true,
        availableAt: now.toISOString(),
        reasonCode,
      }),
    });
  }
  const releaseAmbiguity = await release("detached_callback_prior_head_preserved");
  if (releaseAmbiguity !== null) return releaseAmbiguity;
  return Object.freeze({
    state: "outcome",
    outcome: Object.freeze({
      classification: "no_progress",
      madeProgress: false,
      remaining: true,
      reasonCode: "detached_callback_prior_head_preserved",
    }),
  });
}

async function reconcileDetachedPreparationCallback(
  input: {
    readonly database: D1Database;
    readonly candidate: SchedulerCandidate;
    readonly reservation: SchedulerReservation;
    readonly receipt?: SchedulerCallbackReceipt;
    readonly callbackIdentity: string;
    readonly transportFailureReasonCode: "local_transport_failed";
    readonly dispatchedAt: string;
    readonly telemetry?: PerformanceTelemetrySink;
    readonly telemetryContext?: PerformanceTelemetryContext;
  },
  now: Date,
  dispatchedAt: Date,
): Promise<SchedulerDetachedCallbackReconciliation> {
  const stage = input.candidate.stage;
  const isEnrichment = stage === "enrichment_text" || stage === "enrichment_embedding";

  const instruction = acquireNightlySchedulerCandidate({
    candidate: input.candidate,
    reservation: input.reservation,
  });
  const expiresAt = validDate(
    new Date(input.reservation.expiresAt),
    "preparation reservation expiry",
  );
  const reservationStartedAt = expiresAt.getTime() - PREPARATION_LEASE_MS;
  if (
    !isEnrichment ||
    instruction.kind !== "loopback_json" ||
    instruction.successContract !==
      "enrichment_session" ||
    input.transportFailureReasonCode !== "local_transport_failed" ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.callbackIdentity) ||
    await hashCanonicalJson(instruction) !== input.callbackIdentity ||
    expiresAt.toISOString() !== input.reservation.expiresAt ||
    dispatchedAt.getTime() < reservationStartedAt ||
    dispatchedAt.getTime() > expiresAt.getTime() ||
    dispatchedAt.getTime() > now.getTime()
  ) throw priorHeadError("detached_callback_reconciliation_binding_invalid");

  if (input.receipt !== undefined) {
    const receipt = requiredReceipt(input.receipt);
    if (await hashCanonicalJson(receipt.body) !== receipt.responseHash) {
      return detachedAmbiguous("detached_callback_receipt_hash_mismatch");
    }
    try {
      const bundle = await validateNightlySchedulerAcquisition({
        candidate: input.candidate,
        reservation: input.reservation,
        acquired: instruction,
      });
      const committed = await commitNightlySchedulerCandidate({
        database: input.database,
        candidate: input.candidate,
        reservation: input.reservation,
        bundle,
        receipt,
        now,
        telemetry: input.telemetry,
        telemetryContext: input.telemetryContext,
      });
      return committed.kind === "outcome"
        ? Object.freeze({ state: "outcome", outcome: committed.outcome })
        : detachedAmbiguous("detached_preparation_callback_receipt_not_finalized");
    } catch (error) {
      if (isStateAmbiguousError(error)) return detachedAmbiguous(error.reasonCode);
      throw error;
    }
  }

  const claims = Object.freeze([requiredQueueClaim(input.reservation)]);
  let states = await readDetachedPreparationClaimStates(input.database, claims);
  if (states.some((state) => state.kind === "foreign_claim")) {
    return detachedAmbiguous("detached_preparation_callback_claim_reowned");
  }
  const liveMutation = await input.database.prepare(`
    SELECT 1 AS active FROM pipeline_run_lease
    WHERE expires_at > ?
    LIMIT 1
  `).bind(now.toISOString()).first<{ active: number }>();
  if (liveMutation !== null) {
    return Object.freeze({
      state: "active",
      reasonCode: "detached_callback_mutation_active",
    });
  }
  if (isEnrichment) {
    const activeEnrichment = await input.database.prepare(`
      SELECT 1 AS active FROM enrichment_runs
      WHERE status = 'running' AND started_at >= ? AND started_at <= ?
      LIMIT 1
    `).bind(
      dispatchedAt.toISOString(),
      now.toISOString(),
    ).first<{ active: number }>();
    if (activeEnrichment !== null) {
      return Object.freeze({
        state: "active",
        reasonCode: "detached_callback_mutation_active",
      });
    }
  }
  const missing = states.filter((state) => state.kind === "missing").length;
  if (missing > 0) {
    if (missing !== states.length) {
      return detachedAmbiguous("detached_preparation_callback_partial_settlement");
    }
    return Object.freeze({
      state: "outcome",
      outcome: Object.freeze({
        classification: "completed",
        madeProgress: true,
        remaining: false,
      }),
    });
  }
  const deadlineAt = dispatchedAt.getTime() + instruction.timeoutMs +
    DETACHED_CALLBACK_SETTLEMENT_GRACE_MS;
  const owned = states.filter((state) => state.kind === "owned");
  if (
    now.getTime() < deadlineAt ||
    owned.some((state) => Date.parse(state.item.leaseExpiresAt!) > now.getTime())
  ) {
    return Object.freeze({
      state: "active",
      reasonCode: "detached_callback_settlement_pending",
    });
  }
  if (owned.length > 0) {
    const retryAt = new Date(now.getTime() + RETRY_DELAY_MS);
    for (const state of owned) {
      const released = await deferPipelineWorkClaim({
        database: input.database,
        claim: state.claim,
        availableAt: retryAt,
        now,
        telemetry: input.telemetry,
        telemetryContext: input.telemetryContext,
      });
      if (released.outcome === "claim_missed") {
        states = await readDetachedPreparationClaimStates(input.database, claims);
        if (states.some((current) => current.kind === "foreign_claim")) {
          return detachedAmbiguous("detached_preparation_callback_claim_reowned");
        }
        const currentMissing = states.filter((current) => current.kind === "missing").length;
        if (currentMissing !== 0 && currentMissing !== states.length) {
          return detachedAmbiguous("detached_preparation_callback_partial_settlement");
        }
        if (currentMissing === states.length) {
          return Object.freeze({
            state: "outcome",
            outcome: Object.freeze({
              classification: "completed",
              madeProgress: true,
              remaining: false,
            }),
          });
        }
      }
    }
    states = await readDetachedPreparationClaimStates(input.database, claims);
  }
  if (states.some((state) => state.kind === "owned" || state.kind === "foreign_claim")) {
    return detachedAmbiguous("detached_preparation_callback_claim_not_released");
  }
  const settled = states.flatMap((state) => state.kind === "unclaimed" ? [state.item] : []);
  if (settled.length !== states.length) {
    return detachedAmbiguous("detached_preparation_callback_settlement_changed");
  }
  const inputChanged = settled.some((item, index) =>
    item.inputHash !== claims[index]!.inputHash || item.revision !== claims[index]!.revision
  );
  const availableAt = settled.map((item) => item.availableAt).sort()[0]!;
  return Object.freeze({
    state: "outcome",
    outcome: Object.freeze({
      classification: "retryable_pressure",
      madeProgress: inputChanged,
      remaining: true,
      availableAt,
      reasonCode: inputChanged
        ? "pipeline_work_input_changed"
        : "detached_preparation_callback_settled_without_receipt",
    }),
  });
}

type DetachedPreparationClaimState = Readonly<
  | {
      readonly kind: "owned";
      readonly claim: NonNullable<SchedulerReservation["queueClaim"]>;
      readonly item: PipelineWorkItem;
    }
  | {
      readonly kind: "unclaimed";
      readonly claim: NonNullable<SchedulerReservation["queueClaim"]>;
      readonly item: PipelineWorkItem;
    }
  | {
      readonly kind: "foreign_claim";
      readonly claim: NonNullable<SchedulerReservation["queueClaim"]>;
      readonly item: PipelineWorkItem;
    }
  | {
      readonly kind: "missing";
      readonly claim: NonNullable<SchedulerReservation["queueClaim"]>;
    }
>;

async function readDetachedPreparationClaimStates(
  database: D1Database,
  claims: readonly NonNullable<SchedulerReservation["queueClaim"]>[],
): Promise<readonly DetachedPreparationClaimState[]> {
  return Promise.all(claims.map(async (claim): Promise<DetachedPreparationClaimState> => {
    const row = await database.prepare(`
      SELECT ${WORK_ROW_COLUMNS} FROM pipeline_work_items
      WHERE stage = ? AND subject_type = ? AND subject_id = ?
    `).bind(claim.stage, claim.subjectType, claim.subjectId).first<WorkRow>();
    if (row === null) return Object.freeze({ kind: "missing", claim });
    const item = mapWorkItem(row);
    if (isUnclaimedWorkItem(item)) {
      return Object.freeze({ kind: "unclaimed", claim, item });
    }
    if (
      item.leaseOwner === claim.owner && item.leaseExpiresAt !== null &&
      item.claimedInputHash === claim.inputHash && item.claimedRevision === claim.revision
    ) return Object.freeze({ kind: "owned", claim, item });
    return Object.freeze({ kind: "foreign_claim", claim, item });
  }));
}

/** Releases only an exact source reservation or preparation claim before callback dispatch. */
export async function abortNightlySchedulerCallbackBeforeDispatch(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly callbackIdentity?: string;
  readonly abortPhase:
    | "acquire_failed"
    | "validate_failed"
    | "commit_prepare_failed";
  readonly now?: Date;
}): Promise<SchedulerWorkOutcome> {
  const now = validDate(input.now ?? new Date(), "pre-callback abort time");
  assertReservation(input.candidate, input.reservation);
  if (
    !["acquire_failed", "validate_failed", "commit_prepare_failed"].includes(
      input.abortPhase,
    ) ||
    (input.callbackIdentity !== undefined &&
      !/^sha256:[0-9a-f]{64}$/u.test(input.callbackIdentity))
  ) throw priorHeadError("source_callback_abort_binding_invalid");
  const expectedInstruction = acquireNightlySchedulerCandidate({
    candidate: input.candidate,
    reservation: input.reservation,
  });
  const expectedCallbackIdentity = await hashCanonicalJson(expectedInstruction);
  if (input.candidate.kind === "preparation") {
    if (
      expectedInstruction.kind !== "loopback_json" ||
      expectedInstruction.executionBoundary !== "acquire_outside_fifo" ||
      (input.callbackIdentity !== undefined &&
        expectedCallbackIdentity !== input.callbackIdentity)
    ) throw priorHeadError("preparation_callback_abort_binding_invalid");
    const released = await deferPipelineWorkClaim({
      database: input.database,
      claim: requiredQueueClaim(input.reservation),
      availableAt: now,
      now,
    });
    if (released.outcome !== "deferred" && released.outcome !== "stale_released") {
      throw new Error("preparation_callback_abort_claim_missed");
    }
    return Object.freeze({
      classification: "no_progress",
      madeProgress: false,
      remaining: true,
      reasonCode: `preparation_callback_${input.abortPhase}`,
    });
  }
  const sourceInput = requireSourceInput(input.candidate);
  if (
    input.candidate.kind !== "source_acquisition" ||
    sourceInput.coverageMode !== "complete_current" ||
    expectedInstruction.kind !== "loopback_json" ||
    expectedInstruction.executionBoundary === "acquire_outside_fifo" ||
    (input.callbackIdentity !== undefined &&
      expectedCallbackIdentity !== input.callbackIdentity)
  ) throw priorHeadError("source_callback_abort_binding_invalid");
  const claim = requiredAcquisitionClaim(input.reservation);
  const stored = await readSourceAcquisitionReservation(
    input.database,
    claim.reservationId,
  );
  if (
    stored === null || stored.reservationId !== claim.reservationId ||
    stored.sourceId !== claim.sourceId || stored.laneKey !== claim.laneKey ||
    stored.leaseOwner !== claim.leaseOwner ||
    stored.expectedGeneration !== claim.expectedGeneration ||
    stored.inputHash !== claim.inputHash ||
    stored.inputRevision !== claim.inputRevision ||
    stored.requestRole !== "complete_current" ||
    (stored.state !== "reserved" && stored.state !== "acquired")
  ) throw priorHeadError("source_callback_abort_reservation_changed");
  const durableHead = await readDurableSourceHead(
    input.database,
    input.candidate.sourceId,
  );
  const checkpoint = compareSchedulerCheckpointEvidence(
    sourceInput.priorCheckpoint ?? null,
    await readSchedulerTraversalEvidence(input.database, input.candidate.sourceId),
  );
  if (
    !sameSchedulerSourceHead(durableHead, sourceInput.priorHead ?? null) ||
    checkpoint !== "same"
  ) throw new Error("source_callback_abort_state_ambiguous");
  const reasonCode = `source_callback_${input.abortPhase}`;
  const released = await releaseSourceAcquisitionReservation({
    database: input.database,
    claim,
    state: "failed",
    failureCode: reasonCode,
    failureFingerprint: expectedCallbackIdentity,
    now,
  });
  if (released.outcome !== "released") {
    throw new Error("source_callback_abort_claim_missed");
  }
  return Object.freeze({
    classification: "no_progress",
    madeProgress: false,
    remaining: true,
    reasonCode,
  });
}

/**
 * Cleans up only the exact deterministic complete-current reservation that a
 * same-campaign reserve request may have committed before its response was
 * lost. It never creates or revives a reservation.
 */
export async function abortNightlySchedulerReserveBeforeCallback(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly now?: Date;
}): Promise<SchedulerWorkOutcome> {
  const now = validDate(input.now ?? new Date(), "reserve cleanup time");
  if (input.candidate.kind === "preparation") {
    const item = requireWorkItem(input.candidate);
    const claimed = await input.database.prepare(`
      SELECT ${WORK_ROW_COLUMNS}
      FROM pipeline_work_items
      WHERE stage = ? AND subject_type = ? AND subject_id = ?
        AND claimed_input_hash = ? AND claimed_revision = ?
        AND lease_owner IS NOT NULL
      LIMIT 2
    `).bind(
      item.stage,
      item.subjectType,
      item.subjectId,
      item.inputHash,
      item.revision,
    ).all<WorkRow>();
    const rows = claimed.results ?? [];
    if (rows.length === 0) {
      return Object.freeze({
        classification: "no_progress",
        madeProgress: false,
        remaining: true,
        reasonCode: "preparation_reserve_failure_no_live_claim",
      });
    }
    if (rows.length !== 1) {
      throw new Error("preparation_reserve_cleanup_state_ambiguous");
    }
    const stored = mapWorkItem(rows[0]!);
    if (stored.leaseOwner === null || !stored.leaseOwner.startsWith("nightly:")) {
      throw new Error("preparation_reserve_cleanup_state_ambiguous");
    }
    const released = await deferPipelineWorkClaim({
      database: input.database,
      claim: pipelineWorkClaimIdentity(stored),
      availableAt: now,
      now,
    });
    if (released.outcome !== "deferred" && released.outcome !== "stale_released") {
      throw new Error("preparation_reserve_cleanup_claim_missed");
    }
    return Object.freeze({
      classification: "no_progress",
      madeProgress: false,
      remaining: true,
      reasonCode: "preparation_reserve_failure_released",
    });
  }
  const sourceInput = requireSourceInput(input.candidate);
  if (
    input.candidate.kind !== "source_acquisition" ||
    sourceInput.coverageMode !== "complete_current"
  ) throw priorHeadError("source_reserve_cleanup_binding_invalid");
  const expectation = await sourceReservationExpectation(input.candidate);
  const activeRows = await input.database.prepare(`
    SELECT reservation_id
    FROM source_acquisition_reservations
    WHERE source_id = ? AND lane_key = ?
      AND state IN ('reserved', 'acquired') AND expires_at > ?
    ORDER BY created_at, reservation_id
    LIMIT 2
  `).bind(
    expectation.fields.sourceId,
    expectation.fields.laneKey,
    now.toISOString(),
  ).all<{ reservation_id: string }>();
  const rows = activeRows.results ?? [];
  const durableHead = await readDurableSourceHead(
    input.database,
    input.candidate.sourceId,
  );
  const checkpoint = compareSchedulerCheckpointEvidence(
    sourceInput.priorCheckpoint ?? null,
    await readSchedulerTraversalEvidence(input.database, input.candidate.sourceId),
  );
  if (
    !sameSchedulerSourceHead(durableHead, sourceInput.priorHead ?? null) ||
    checkpoint !== "same"
  ) throw new Error("source_reserve_cleanup_state_ambiguous");
  if (rows.length === 0) {
    return Object.freeze({
      classification: "no_progress",
      madeProgress: false,
      remaining: true,
      reasonCode: "source_reserve_failure_no_live_claim",
    });
  }
  if (rows.length !== 1) throw new Error("source_reserve_cleanup_state_ambiguous");
  const stored = await readSourceAcquisitionReservation(
    input.database,
    rows[0]!.reservation_id,
  );
  if (
    stored === null || stored.state !== "reserved" ||
    !matchesSourceReservationExpectation(stored, expectation)
  ) throw new Error("source_reserve_cleanup_state_ambiguous");
  const failureFingerprint = await hashCanonicalJson({
    contract: "nightly-source-reserve-cleanup-v1",
    candidateId: input.candidate.id,
    reservationId: stored.reservationId,
    inputHash: sourceInput.inputHash,
    inputRevision: sourceInput.inputRevision,
  });
  const released = await releaseSourceAcquisitionReservation({
    database: input.database,
    claim: sourceAcquisitionClaimIdentity(stored),
    state: "failed",
    failureCode: "source_reserve_response_failed",
    failureFingerprint,
    now,
  });
  if (released.outcome !== "released") {
    throw new Error("source_reserve_cleanup_claim_missed");
  }
  return Object.freeze({
    classification: "no_progress",
    madeProgress: false,
    remaining: true,
    reasonCode: "source_reserve_failure_released",
  });
}

export async function validateNightlySchedulerAcquisition(input: {
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly acquired: unknown;
}): Promise<SchedulerAcquiredBundle> {
  assertReservation(input.candidate, input.reservation);
  if (input.candidate.kind === "source_acquisition") requireSourceInput(input.candidate);
  if (!isCallbackInstruction(input.acquired)) {
    throw priorHeadError("scheduler_acquisition_instruction_invalid");
  }
  const expected = acquireNightlySchedulerCandidate({
    candidate: input.candidate,
    reservation: input.reservation,
  });
  if (await hashCanonicalJson(expected) !== await hashCanonicalJson(input.acquired)) {
    throw priorHeadError("scheduler_acquisition_instruction_changed");
  }
  const contentHash = await hashCanonicalJson(input.acquired);
  return Object.freeze({
    reservationId: input.reservation.reservationId,
    bundleIdentity: await hashCanonicalJson({
      reservationId: input.reservation.reservationId,
      candidateId: input.candidate.id,
      contentHash,
    }),
    responseHash: contentHash,
    contentHash,
    validated: true,
    acquiredBundle: null,
    callback: input.acquired,
  });
}

export async function commitNightlySchedulerCandidate(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly bundle: SchedulerAcquiredBundle;
  readonly receipt?: SchedulerCallbackReceipt;
  readonly now?: Date;
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
}): Promise<SchedulerCommitResult> {
  const now = validDate(input.now ?? new Date(), "commit time");
  assertReservation(input.candidate, input.reservation);
  if (input.bundle.reservationId !== input.reservation.reservationId || !input.bundle.validated) {
    throw priorHeadError("scheduler_bundle_identity_changed");
  }
  const sourceInput = input.candidate.kind === "source_acquisition"
    ? requireSourceInput(input.candidate)
    : null;
  const expectedCallback = acquireNightlySchedulerCandidate({
    candidate: input.candidate,
    reservation: input.reservation,
  });
  const expectedContentHash = await hashCanonicalJson(expectedCallback);
  const expectedBundleIdentity = await hashCanonicalJson({
    reservationId: input.reservation.reservationId,
    candidateId: input.candidate.id,
    contentHash: expectedContentHash,
  });
  if (
    await hashCanonicalJson(input.bundle.callback) !== expectedContentHash ||
    input.bundle.contentHash !== expectedContentHash ||
    input.bundle.responseHash !== expectedContentHash ||
    input.bundle.bundleIdentity !== expectedBundleIdentity ||
    input.bundle.acquiredBundle !== null
  ) {
    throw priorHeadError("scheduler_bundle_identity_changed");
  }
  if (input.receipt !== undefined &&
      await hashCanonicalJson(input.receipt.body) !== input.receipt.responseHash) {
    if (sourceInput?.coverageMode === "complete_current") {
      throw stateAmbiguousError("scheduler_callback_receipt_hash_mismatch");
    }
    throw priorHeadError("scheduler_callback_receipt_hash_mismatch");
  }
  if (
    input.candidate.kind === "preparation" &&
    input.candidate.stage === "primary_image" &&
    input.bundle.callback.kind !== "local_commit" &&
    input.receipt === undefined
  ) {
    return preparePrimaryImageCallbackHandoff({
      database: input.database,
      candidate: input.candidate,
      reservation: input.reservation,
      instruction: input.bundle.callback,
      now,
      telemetry: input.telemetry,
      telemetryContext: input.telemetryContext,
    });
  }
  if (input.bundle.callback.kind !== "local_commit" && input.receipt === undefined) {
    return Object.freeze({ kind: "callback_required", instruction: input.bundle.callback });
  }
  if (input.candidate.kind === "preparation" && PROJECTION_STAGE_SET.has(input.candidate.stage)) {
    return Object.freeze({
      kind: "outcome",
      outcome: await executeProjectionCandidate({
        database: input.database,
        candidate: input.candidate,
        reservation: input.reservation,
        now,
      }),
    });
  }
  if (
    input.candidate.kind === "preparation" &&
    NO_REFETCH_CONTINUATION_STAGE_SET.has(input.candidate.stage)
  ) {
    return Object.freeze({
      kind: "outcome",
      outcome: await completePreparation(
        input.database,
        input.reservation,
        input.telemetry,
        input.telemetryContext,
      ),
    });
  }
  if (input.candidate.kind === "source_acquisition") {
    return Object.freeze({
      kind: "outcome",
      outcome: await finalizeSourceAcquisition({ ...input, receipt: requiredReceipt(input.receipt), now }),
    });
  }
  if (input.candidate.stage === "source_release") {
    const releaseStartedAt = performance.now();
    const release = await reconcileProjectedSourceRelease({
      database: input.database,
      sourceId: input.candidate.sourceId,
      now,
    });
    const releaseDurationMs = performance.now() - releaseStartedAt;
    input.telemetry?.record({
      context: {
        ...input.telemetryContext,
        sourceId: input.candidate.sourceId,
        coverageMode: release.state.coverageMode,
      },
      details: {
        kind: "equivalence",
        surface: "release",
        equivalent: release.outcome !== "stale_refused",
        reasonCode: release.outcome === "stale_refused"
          ? "release_input_race"
          : `release_${release.outcome}`,
      },
    });
    input.telemetry?.record({
      context: {
        ...input.telemetryContext,
        sourceId: input.candidate.sourceId,
        coverageMode: release.state.coverageMode,
      },
      details: {
        kind: "stage",
        stage: "source_release",
        outcome: release.outcome === "stale_refused" ? "failed" : "completed",
        durationMs: releaseDurationMs,
        releaseOrPrimeMs: releaseDurationMs,
        reasonCode: release.outcome,
      },
    });
    if (release.outcome === "stale_refused") {
      return Object.freeze({
        kind: "outcome",
        outcome: await deferPreparation(input.database, input.reservation, now,
          "source_release_input_changed", true, input.telemetry, input.telemetryContext),
      });
    }
    return Object.freeze({
      kind: "outcome",
      outcome: await completePreparation(
        input.database,
        input.reservation,
        input.telemetry,
        input.telemetryContext,
      ),
    });
  }
  if (input.candidate.stage === "source_acquisition_readiness") {
    const item = requireWorkItem(input.candidate);
    const access = await checkSourceAccessEligibility({
      database: input.database,
      sourceId: input.candidate.sourceId,
      laneKey: item.laneKey,
      currentInputHash: item.inputHash,
      now,
    });
    if (!access.eligible) {
      const availableAt = access.row.nextEligibleAt === null
        ? new Date(now.getTime() + 24 * 60 * 60_000)
        : new Date(access.row.nextEligibleAt);
      await deferPipelineWorkClaim({
        database: input.database,
        claim: requiredQueueClaim(input.reservation),
        availableAt,
        now,
        telemetry: input.telemetry,
        telemetryContext: input.telemetryContext,
      });
      return Object.freeze({
        kind: "outcome",
        outcome: Object.freeze({
          classification: "access_stop",
          madeProgress: false,
          remaining: true,
          availableAt: access.row.nextEligibleAt,
          reasonCode: access.row.reasonCode ?? access.row.state,
        }),
      });
    }
    return Object.freeze({
      kind: "outcome",
      outcome: await completePreparation(
        input.database,
        input.reservation,
        input.telemetry,
        input.telemetryContext,
      ),
    });
  }
  const receipt = requiredReceipt(input.receipt);
  const contract = input.bundle.callback.kind === "loopback_json"
    ? input.bundle.callback.successContract
    : null;
  if (input.candidate.stage === "primary_image") {
    return Object.freeze({
      kind: "outcome",
      outcome: await finalizePrimaryImageCallback({
        database: input.database,
        candidate: input.candidate,
        reservation: input.reservation,
        receipt,
        callbackSucceeded: callbackSucceeded(
          contract,
          receipt,
          input.candidate.sourceId,
        ),
        callbackContract: contract,
        now,
      }),
    });
  }
  if (
    input.candidate.stage === "enrichment_text" ||
    input.candidate.stage === "enrichment_embedding"
  ) {
    return Object.freeze({
      kind: "outcome",
      outcome: await finalizeEnrichmentCallback({
        database: input.database,
        candidate: input.candidate,
        reservation: input.reservation,
        receipt,
        callbackContract: contract,
        now,
        telemetry: input.telemetry,
        telemetryContext: input.telemetryContext,
      }),
    });
  }
  if (!callbackSucceeded(contract, receipt, input.candidate.sourceId)) {
    if (input.candidate.stage === "proximity") {
      return Object.freeze({
        kind: "outcome",
        outcome: await deferPreparation(
          input.database,
          input.reservation,
          now,
          callbackFailureCode(contract, receipt),
          false,
          input.telemetry,
          input.telemetryContext,
        ),
      });
    }
    return Object.freeze({
      kind: "outcome",
      outcome: await failPreparation(
        input.database,
        input.reservation,
        now,
        callbackFailureCode(contract, receipt),
        receipt.responseHash,
        input.telemetry,
        input.telemetryContext,
      ),
    });
  }
  if (input.candidate.stage === "proximity") {
    const pending = await exactWorkItemExists(
      input.database,
      requireWorkItem(input.candidate),
    );
    if (pending) {
      return Object.freeze({
        kind: "outcome",
        outcome: await deferPreparation(
          input.database,
          input.reservation,
          now,
          "proximity_session_no_queue_delta",
          false,
          input.telemetry,
          input.telemetryContext,
        ),
      });
    }
    const staleRelease = await deferPipelineWorkClaim({
      database: input.database,
      claim: requiredQueueClaim(input.reservation),
      availableAt: now,
      now,
      telemetry: input.telemetry,
      telemetryContext: input.telemetryContext,
    });
    return Object.freeze({
      kind: "outcome",
      outcome: staleRelease.outcome === "stale_released"
        ? Object.freeze({
            classification: "retryable_pressure" as const,
            madeProgress: true,
            remaining: true,
            availableAt: staleRelease.item.availableAt,
            reasonCode: "pipeline_work_input_changed",
          })
        : staleRelease.outcome === "deferred"
        ? Object.freeze({
            classification: "retryable_pressure" as const,
            madeProgress: false,
            remaining: true,
            availableAt: staleRelease.item.availableAt,
            reasonCode: "proximity_session_no_queue_delta",
          })
        : Object.freeze({
            classification: "completed" as const,
            madeProgress: true,
            remaining: false,
          }),
    });
  }
  if (callbackHasRemaining(receipt.body)) {
    return Object.freeze({
      kind: "outcome",
      outcome: await deferPreparation(input.database, input.reservation, now,
        "preparation_callback_remaining", true, input.telemetry, input.telemetryContext),
    });
  }
  return Object.freeze({
    kind: "outcome",
    outcome: await completePreparation(
      input.database,
      input.reservation,
      input.telemetry,
      input.telemetryContext,
    ),
  });
}

async function finalizeSourceAcquisition(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly bundle: SchedulerAcquiredBundle;
  readonly receipt: SchedulerCallbackReceipt;
  readonly now: Date;
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
}): Promise<SchedulerWorkOutcome> {
  const claim = input.reservation.acquisitionClaim;
  if (claim === null) throw priorHeadError("source_acquisition_claim_missing");
  const existingReservation = await readSourceAcquisitionReservation(
    input.database,
    claim.reservationId,
  );
  const receiptIdentityMatches = await hashCanonicalJson(input.receipt.body) ===
    input.receipt.responseHash;
  const publicationTransition = completeCurrentPublicationTransition(
    input.receipt.body,
    input.candidate.sourceId,
  );
  if (existingReservation?.state === "committed") {
    if (
      !receiptIdentityMatches || publicationTransition === null ||
      !callbackSucceeded("source_catalog", input.receipt, input.candidate.sourceId)
    ) throw stateAmbiguousError("source_committed_receipt_cannot_reconstruct_publication");
    await verifyDurableCompleteCurrentPublication(input, publicationTransition);
    const committedBundle = await input.database.prepare(`
      SELECT bundle_identity FROM source_acquired_bundles
      WHERE reservation_id = ? AND source_id = ? AND response_hash = ?
        AND state = 'committed'
      LIMIT 1
    `).bind(
      claim.reservationId,
      input.candidate.sourceId,
      input.receipt.responseHash,
    ).first<{ bundle_identity: string }>();
    if (committedBundle === null) {
      throw new Error("source_committed_bundle_cannot_reconstruct_publication");
    }
    const sourceBoundary = await recordCompleteCurrentPublicationProof({
      database: input.database,
      candidate: input.candidate,
      reservation: input.reservation,
      bundleIdentity: committedBundle.bundle_identity,
      receipt: input.receipt,
      transition: publicationTransition,
      now: input.now,
      telemetry: input.telemetry,
      telemetryContext: input.telemetryContext,
    });
    return Object.freeze({
      classification: "completed",
      madeProgress: true,
      remaining: false,
      sourceBoundary,
    });
  }
  if (
    !receiptIdentityMatches ||
    publicationTransition === null ||
    !callbackSucceeded("source_catalog", input.receipt, input.candidate.sourceId)
  ) {
    return finalizeFailedSourceAcquisition({
      database: input.database,
      candidate: input.candidate,
      reservation: input.reservation,
      receipt: input.receipt,
      now: input.now,
    });
  }
  await verifyDurableCompleteCurrentPublication(input, publicationTransition);
  const encoded = JSON.stringify(input.receipt.body);
  const persisted = await putSourceAcquiredBundle({
    database: input.database,
    claim,
    responseHash: input.receipt.responseHash,
    contentHash: input.receipt.responseHash,
    contentType: "application/json",
    byteLength: new TextEncoder().encode(encoded).byteLength,
    parserVersion: NIGHTLY_SCHEDULER_RUNTIME_VERSION,
    validationVersion: NIGHTLY_SCHEDULER_RUNTIME_VERSION,
    validatedMetadata: Object.freeze({
      sourceId: input.candidate.sourceId,
      contract: "complete_current_callback_receipt",
      status: input.receipt.status,
      published: true,
    }),
    requestsConsumed: 1,
    now: input.now,
  });
  if (persisted.outcome === "claim_missed") throw priorHeadError("source_bundle_claim_missed");
  const currentGeneration = await readSourceAcquisitionGeneration(input.database, input.candidate.sourceId);
  const committed = await commitSourceAcquisitionReservation({
    database: input.database,
    claim,
    bundleIdentity: persisted.bundle.bundleIdentity,
    currentGeneration,
    now: input.now,
  });
  if (committed.outcome !== "committed") throw priorHeadError(`source_${committed.outcome}`);
  const sourceBoundary = await recordCompleteCurrentPublicationProof({
    database: input.database,
    candidate: input.candidate,
    reservation: input.reservation,
    bundleIdentity: persisted.bundle.bundleIdentity,
    receipt: input.receipt,
    transition: publicationTransition,
    now: input.now,
    telemetry: input.telemetry,
    telemetryContext: input.telemetryContext,
  });
  return Object.freeze({
    classification: "completed",
    madeProgress: true,
    remaining: false,
    sourceBoundary,
  });
}

type FailedSourceCallbackBoundary =
  | {
      readonly kind: "checkpoint_progress";
      readonly reasonCode: "source_checkpoint_advanced" |
        "source_checkpoint_safely_replanned";
    }
  | {
      readonly kind: "integrity_stop";
      readonly reasonCode: "source_checkpoint_evidence_regressed";
    }
  | {
      readonly kind: "access_stop";
      readonly reasonCode: string;
      readonly availableAt: string | null;
      readonly checkpointAdvanced: boolean;
    }
  | {
      readonly kind: "callback_failure";
      readonly reasonCode: string;
    };

/**
 * Classifies an authoritative complete-current non-success before releasing
 * its reservation. The resulting reason and exact receipt hash are the
 * durable idempotency key for a lost finalizer response.
 */
async function finalizeFailedSourceAcquisition(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly receipt: SchedulerCallbackReceipt;
  readonly now: Date;
}): Promise<SchedulerWorkOutcome> {
  if (await hashCanonicalJson(input.receipt.body) !== input.receipt.responseHash) {
    throw stateAmbiguousError("scheduler_callback_receipt_hash_mismatch");
  }
  if (callbackSucceeded("source_catalog", input.receipt, input.candidate.sourceId)) {
    throw stateAmbiguousError("source_callback_success_cannot_reconstruct_failure");
  }
  const sourceInput = requireSourceInput(input.candidate);
  const durableHead = await readDurableSourceHead(
    input.database,
    input.candidate.sourceId,
  );
  if (!sameSchedulerSourceHead(durableHead, sourceInput.priorHead ?? null)) {
    throw stateAmbiguousError("source_callback_failure_publication_state_ambiguous");
  }
  const resultingCheckpoint = await readSchedulerTraversalEvidence(
    input.database,
    input.candidate.sourceId,
  );
  const checkpoint = compareSchedulerCheckpointEvidence(
    sourceInput.priorCheckpoint ?? null,
    resultingCheckpoint,
  );
  let boundary: FailedSourceCallbackBoundary;
  if (checkpoint === "regressed") {
    // A previously observed checkpoint disappearing or losing a completed
    // page is an integrity stop for this source. It is not a safe replan and
    // must not make the whole campaign ambiguous.
    boundary = Object.freeze({
      kind: "integrity_stop",
      reasonCode: "source_checkpoint_evidence_regressed",
    });
  } else {
    let accessBoundary = retainedSourceCallbackAccessBoundary(
      input.receipt,
      input.candidate.sourceId,
    );
    if (accessBoundary === null) {
      const access = await checkSourceDocumentAccess({
        database: input.database,
        manifest: getSourceAdapter(requirePolicy(input.candidate).sourceId).manifest,
        now: input.now,
      });
      if (!access.eligible) {
        accessBoundary = {
          reasonCode: access.row.reasonCode ?? access.row.state,
          availableAt: access.row.nextEligibleAt,
        };
      }
    }
    const checkpointAdvanced = checkpoint === "advanced" || checkpoint === "replanned";
    boundary = accessBoundary !== null
      ? Object.freeze({ kind: "access_stop" as const, ...accessBoundary, checkpointAdvanced })
      : checkpointAdvanced
      ? Object.freeze({
          kind: "checkpoint_progress" as const,
          reasonCode: checkpoint === "advanced"
            ? "source_checkpoint_advanced" as const
            : "source_checkpoint_safely_replanned" as const,
        })
      : Object.freeze({
          kind: "callback_failure" as const,
          reasonCode: callbackFailureCode(
            "source_catalog", input.receipt, input.candidate.sourceId,
          ),
        });
  }

  const failed = await terminalizeExactFailedSourceCallbackOrphan({
    database: input.database,
    candidate: input.candidate,
    reservation: input.reservation,
    reasonCode: boundary.reasonCode,
    failureFingerprint: input.receipt.responseHash,
    now: input.now,
  }) ?? await releaseExactFailedSourceReservation({
    database: input.database,
    candidate: input.candidate,
    reservation: input.reservation,
    reasonCode: boundary.reasonCode,
    failureFingerprint: input.receipt.responseHash,
    now: input.now,
  });
  return failedSourceCallbackOutcome(
    boundary,
    validDate(new Date(failed.updatedAt), "failed source reservation time"),
  );
}

function failedSourceCallbackOutcome(
  boundary: FailedSourceCallbackBoundary,
  releasedAt: Date,
): SchedulerWorkOutcome {
  if (boundary.kind === "checkpoint_progress") {
    return Object.freeze({
      classification: "retryable_pressure",
      madeProgress: true,
      remaining: true,
      availableAt: releasedAt.toISOString(),
      reasonCode: boundary.reasonCode,
    });
  }
  if (boundary.kind === "integrity_stop") {
    return Object.freeze({
      classification: "access_stop",
      madeProgress: false,
      remaining: true,
      availableAt: null,
      reasonCode: boundary.reasonCode,
    });
  }
  if (boundary.kind === "access_stop") {
    return failedSourceAccessOutcome(boundary, boundary.checkpointAdvanced);
  }
  return Object.freeze({
    classification: "retryable_pressure",
    madeProgress: false,
    remaining: true,
    availableAt: new Date(releasedAt.getTime() + RETRY_DELAY_MS).toISOString(),
    reasonCode: boundary.reasonCode,
  });
}

interface SourceCallbackAccessBoundary {
  readonly reasonCode: string;
  readonly availableAt: string | null;
}

function retainedSourceCallbackAccessBoundary(
  receipt: SchedulerCallbackReceipt,
  sourceId: string,
): SourceCallbackAccessBoundary | null {
  if (!isRecord(receipt.body) || !("accessReceipt" in receipt.body)) return null;
  const access = receipt.body.accessReceipt;
  if (
    !isRecord(access) || access.sourceId !== sourceId || access.laneKey !== "document" ||
    Object.keys(access).some((key) => ![
      "sourceId", "laneKey", "state", "reasonCode", "nextEligibleAt",
    ].includes(key)) ||
    !(
      (access.state === "manual_reset_required" && access.reasonCode === "access_denied" &&
        access.nextEligibleAt === null) ||
      (access.state === "cooldown" && typeof access.reasonCode === "string" &&
        ["challenge", "rate_limited", "source_pressure"].includes(access.reasonCode) &&
        typeof access.nextEligibleAt === "string" &&
        exactTimestampMilliseconds(access.nextEligibleAt) !== null)
    )
  ) throw stateAmbiguousError("source_callback_access_receipt_invalid");
  return Object.freeze({
    reasonCode: access.reasonCode as string,
    availableAt: access.nextEligibleAt as string | null,
  });
}

function failedSourceAccessOutcome(
  access: SourceCallbackAccessBoundary,
  checkpointAdvanced: boolean,
): SchedulerWorkOutcome {
  if (checkpointAdvanced && access.availableAt !== null &&
      (access.reasonCode === "rate_limited" || access.reasonCode === "source_pressure")) {
    return Object.freeze({
      classification: "retryable_pressure",
      madeProgress: true,
      remaining: true,
      availableAt: access.availableAt,
      reasonCode: access.reasonCode,
    });
  }
  return Object.freeze({
    classification: "access_stop",
    madeProgress: false,
    remaining: true,
    availableAt: access.availableAt,
    reasonCode: access.reasonCode,
  });
}

/**
 * A source callback can return an authoritative failure receipt after its own
 * final `finishDiscoveryRun` transaction was rejected by the local D1 runtime.
 * In that exact shape, the scheduler still owns the source reservation and the
 * singleton pipeline lease identifies one running discovery containing one
 * matching source run. Terminalize that closed callback atomically before the
 * ordinary reservation finalizer runs. Any sibling, ownership, chronology, or
 * cardinality disagreement remains state-ambiguous and is never cleaned up.
 */
async function terminalizeExactFailedSourceCallbackOrphan(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly reasonCode: string;
  readonly failureFingerprint: string;
  readonly now: Date;
}): Promise<SourceAcquisitionReservation | null> {
  const instruction = acquireNightlySchedulerCandidate({
    candidate: input.candidate,
    reservation: input.reservation,
  });
  if (
    instruction.kind !== "loopback_json" ||
    instruction.service !== "dashboard" ||
    instruction.path !== "/api/runs" ||
    instruction.successContract !== "source_catalog" ||
    instruction.executionBoundary === "acquire_outside_fifo"
  ) {
    // Only a direct dashboard source callback can own the discovery/source-run
    // pair repaired below. Companion callbacks own only their exact source
    // reservation and must never bind to an unrelated discovery singleton.
    return null;
  }

  const claim = requiredAcquisitionClaim(input.reservation);
  const reservation = await readSourceAcquisitionReservation(
    input.database,
    claim.reservationId,
  );
  if (!exactSourceReservationBinding(reservation, input.candidate, input.reservation)) {
    throw stateAmbiguousError("source_callback_failure_reservation_changed");
  }
  if (reservation.state === "failed") return null;
  if (reservation.state !== "reserved" && reservation.state !== "acquired") {
    return null;
  }

  const lease = await input.database.prepare(`
    SELECT lease.run_kind, lease.run_id, lease.acquired_at, lease.expires_at,
      run.trigger, run.status, run.started_at, run.completed_at,
      run.error_code, run.error_message
    FROM pipeline_run_lease lease
    JOIN discovery_runs run ON run.id = lease.run_id
    WHERE lease.singleton = 1
      AND lease.run_kind = 'discovery'
      AND lease.expires_at > ?
  `).bind(input.now.toISOString()).first<{
    run_kind: string;
    run_id: string;
    acquired_at: string;
    expires_at: string;
    trigger: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    error_code: string | null;
    error_message: string | null;
  }>();
  if (lease === null) return null;

  const reservationCreatedAt = validDate(
    new Date(reservation.createdAt),
    "source reservation creation time",
  );
  const leaseAcquiredAt = validDate(
    new Date(lease.acquired_at),
    "pipeline lease acquisition time",
  );
  const discoveryStartedAt = validDate(
    new Date(lease.started_at),
    "orphan discovery start time",
  );
  if (
    leaseAcquiredAt.getTime() < reservationCreatedAt.getTime() ||
    discoveryStartedAt.getTime() < reservationCreatedAt.getTime()
  ) {
    // A run or lease that predates this reservation cannot have been created
    // by its callback. Leave the historical state untouched and finalize only
    // the exact current reservation through the ordinary failure path.
    return null;
  }

  if (
    lease.status !== "running" ||
    (lease.trigger !== "manual" && lease.trigger !== "scheduled") ||
    lease.completed_at !== null || lease.error_code !== null ||
    lease.error_message !== null
  ) throw stateAmbiguousError("source_callback_orphan_discovery_binding_changed");

  const sourceRows = await input.database.prepare(`
    SELECT id, discovery_run_id, source_id, status, started_at, completed_at,
      error_code, error_message
    FROM source_runs
    WHERE discovery_run_id = ?
    ORDER BY started_at, id
  `).bind(lease.run_id).all<{
    id: string;
    discovery_run_id: string;
    source_id: string;
    status: string;
    started_at: string;
    completed_at: string | null;
    error_code: string | null;
    error_message: string | null;
  }>();
  const rows = sourceRows.results ?? [];
  const matchingRows = rows.filter((row) =>
    row.discovery_run_id === lease.run_id &&
    row.source_id === input.candidate.sourceId
  );
  if (matchingRows.length === 0) {
    // Another live discovery may legitimately own the singleton while this
    // failed callback still owns only its source reservation. With no exact
    // source binding there is no orphan proof and nothing here may be mutated.
    return null;
  }
  if (rows.length !== 1 || matchingRows.length !== 1) {
    throw stateAmbiguousError("source_callback_orphan_source_run_cardinality_changed");
  }
  const sourceRun = matchingRows[0]!;
  if (
    sourceRun.discovery_run_id !== lease.run_id ||
    (sourceRun.status !== "queued" && sourceRun.status !== "running") ||
    sourceRun.completed_at !== null || sourceRun.error_code !== null ||
    sourceRun.error_message !== null
  ) throw stateAmbiguousError("source_callback_orphan_source_run_binding_changed");

  const sourceStartedAt = validDate(
    new Date(sourceRun.started_at),
    "orphan source start time",
  );
  if (
    leaseAcquiredAt.getTime() > discoveryStartedAt.getTime() ||
    discoveryStartedAt.getTime() > sourceStartedAt.getTime() ||
    sourceStartedAt.getTime() > input.now.getTime()
  ) throw stateAmbiguousError("source_callback_orphan_chronology_changed");

  const completedAt = input.now.toISOString();
  const errorCode = "ScheduledSourceCallbackFailed";
  const sourceMessage =
    "The scheduled source callback ended after its final run-state write failed.";
  const discoveryMessage =
    "The scheduled source callback ended before its discovery run could be finalized.";
  const guardReservationSql = `
    EXISTS (
      SELECT 1 FROM source_acquisition_reservations reservation
      WHERE reservation.reservation_id = ?
        AND reservation.source_id = ?
        AND reservation.request_role = 'complete_current'
        AND reservation.lane_key = ?
        AND reservation.lease_owner = ?
        AND reservation.expected_generation = ?
        AND reservation.input_hash = ?
        AND reservation.input_revision = ?
        AND reservation.state = 'failed'
        AND reservation.failure_code = ?
        AND reservation.failure_fingerprint = ?
    )
  `;
  const guardReservationBindings = [
    claim.reservationId,
    claim.sourceId,
    claim.laneKey,
    claim.leaseOwner,
    claim.expectedGeneration,
    claim.inputHash,
    claim.inputRevision,
    input.reasonCode,
    input.failureFingerprint,
  ] as const;
  const [failedReservation, failedSourceRun, failedDiscovery, discardedObservations,
    releasedLease] = await input.database.batch([
    input.database.prepare(`
      UPDATE source_acquisition_reservations
      SET state = 'failed', failure_code = ?, failure_fingerprint = ?,
          updated_at = ?
      WHERE reservation_id = ? AND source_id = ?
        AND request_role = 'complete_current' AND lane_key = ?
        AND lease_owner = ? AND expected_generation = ?
        AND input_hash = ? AND input_revision = ?
        AND state IN ('reserved', 'acquired')
    `).bind(
      input.reasonCode,
      input.failureFingerprint,
      completedAt,
      claim.reservationId,
      claim.sourceId,
      claim.laneKey,
      claim.leaseOwner,
      claim.expectedGeneration,
      claim.inputHash,
      claim.inputRevision,
    ),
    input.database.prepare(`
      UPDATE source_runs
      SET status = 'failed', completed_at = ?, error_code = ?, error_message = ?
      WHERE id = ? AND discovery_run_id = ? AND source_id = ?
        AND status IN ('queued', 'running') AND started_at = ?
        AND ${guardReservationSql}
    `).bind(
      completedAt,
      errorCode,
      sourceMessage,
      sourceRun.id,
      lease.run_id,
      input.candidate.sourceId,
      sourceRun.started_at,
      ...guardReservationBindings,
    ),
    input.database.prepare(`
      UPDATE discovery_runs
      SET status = 'failed', completed_at = ?, error_code = ?, error_message = ?
      WHERE id = ? AND status = 'running' AND started_at = ?
        AND EXISTS (
          SELECT 1 FROM source_runs source
          WHERE source.id = ? AND source.discovery_run_id = discovery_runs.id
            AND source.source_id = ? AND source.status = 'failed'
            AND source.completed_at = ? AND source.error_code = ?
        )
        AND ${guardReservationSql}
    `).bind(
      completedAt,
      errorCode,
      discoveryMessage,
      lease.run_id,
      lease.started_at,
      sourceRun.id,
      input.candidate.sourceId,
      completedAt,
      errorCode,
      ...guardReservationBindings,
    ),
    input.database.prepare(`
      DELETE FROM source_inventory_observations
      WHERE run_id = ?
        AND EXISTS (
          SELECT 1 FROM discovery_runs run
          WHERE run.id = ? AND run.status = 'failed'
            AND run.completed_at = ? AND run.error_code = ?
        )
        AND ${guardReservationSql}
    `).bind(
      lease.run_id,
      lease.run_id,
      completedAt,
      errorCode,
      ...guardReservationBindings,
    ),
    input.database.prepare(`
      DELETE FROM pipeline_run_lease
      WHERE singleton = 1 AND run_kind = 'discovery' AND run_id = ?
        AND acquired_at = ? AND expires_at = ?
        AND EXISTS (
          SELECT 1 FROM discovery_runs run
          WHERE run.id = ? AND run.status = 'failed'
            AND run.completed_at = ? AND run.error_code = ?
        )
        AND ${guardReservationSql}
    `).bind(
      lease.run_id,
      lease.acquired_at,
      lease.expires_at,
      lease.run_id,
      completedAt,
      errorCode,
      ...guardReservationBindings,
    ),
  ]);
  const discardedObservationCount = changes(discardedObservations);
  if (
    changes(failedReservation) !== 1 || changes(failedSourceRun) !== 1 ||
    changes(failedDiscovery) !== 1 || changes(releasedLease) !== 1 ||
    !Number.isSafeInteger(discardedObservationCount)
  ) throw stateAmbiguousError("source_callback_orphan_terminalization_ambiguous");

  const [stored, discoveryAfter, sourceAfter, leaseAfter, observationsAfter] =
    await Promise.all([
      readSourceAcquisitionReservation(input.database, claim.reservationId),
      input.database.prepare(`
        SELECT status, completed_at, error_code FROM discovery_runs WHERE id = ?
      `).bind(lease.run_id).first<{
        status: string;
        completed_at: string | null;
        error_code: string | null;
      }>(),
      input.database.prepare(`
        SELECT status, completed_at, error_code FROM source_runs WHERE id = ?
      `).bind(sourceRun.id).first<{
        status: string;
        completed_at: string | null;
        error_code: string | null;
      }>(),
      input.database.prepare(`
        SELECT run_id FROM pipeline_run_lease
        WHERE singleton = 1 AND run_kind = 'discovery' AND run_id = ?
      `).bind(lease.run_id).first<{ run_id: string }>(),
      input.database.prepare(`
        SELECT COUNT(*) AS count FROM source_inventory_observations WHERE run_id = ?
      `).bind(lease.run_id).first<{ count: number }>(),
    ]);
  if (
    !exactSourceReservationBinding(stored, input.candidate, input.reservation) ||
    stored.state !== "failed" || stored.failureCode !== input.reasonCode ||
    stored.failureFingerprint !== input.failureFingerprint ||
    stored.updatedAt !== completedAt ||
    discoveryAfter?.status !== "failed" ||
    discoveryAfter.completed_at !== completedAt ||
    discoveryAfter.error_code !== errorCode ||
    sourceAfter?.status !== "failed" || sourceAfter.completed_at !== completedAt ||
    sourceAfter.error_code !== errorCode || leaseAfter !== null ||
    numeric(observationsAfter?.count) !== 0
  ) throw stateAmbiguousError("source_callback_orphan_terminalization_unverified");
  return stored;
}

async function releaseExactFailedSourceReservation(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly reasonCode: string;
  readonly failureFingerprint: string;
  readonly now: Date;
}): Promise<SourceAcquisitionReservation> {
  const claim = requiredAcquisitionClaim(input.reservation);
  const before = await readSourceAcquisitionReservation(
    input.database,
    claim.reservationId,
  );
  if (!exactSourceReservationBinding(before, input.candidate, input.reservation)) {
    throw stateAmbiguousError("source_callback_failure_reservation_changed");
  }
  if (before.state === "failed") {
    if (
      before.failureCode !== input.reasonCode ||
      before.failureFingerprint !== input.failureFingerprint
    ) throw stateAmbiguousError("source_callback_failed_receipt_mismatch");
    return before;
  }
  if (before.state !== "reserved" && before.state !== "acquired") {
    throw stateAmbiguousError("source_callback_failure_reservation_terminal_changed");
  }
  const released = await releaseSourceAcquisitionReservation({
    database: input.database,
    claim,
    state: "failed",
    failureCode: input.reasonCode,
    failureFingerprint: input.failureFingerprint,
    now: input.now,
  });
  const stored = await readSourceAcquisitionReservation(
    input.database,
    claim.reservationId,
  );
  if (
    !exactSourceReservationBinding(stored, input.candidate, input.reservation) ||
    stored.state !== "failed" || stored.failureCode !== input.reasonCode ||
    stored.failureFingerprint !== input.failureFingerprint ||
    (released.outcome === "released" && stored.updatedAt !== input.now.toISOString())
  ) throw stateAmbiguousError("source_callback_failure_release_ambiguous");
  return stored;
}

function exactSourceReservationBinding(
  stored: SourceAcquisitionReservation | null,
  candidate: SchedulerCandidate,
  reservation: SchedulerReservation,
): stored is SourceAcquisitionReservation {
  const claim = reservation.acquisitionClaim;
  return stored !== null && claim !== null &&
    reservation.reservationId === claim.reservationId &&
    reservation.sourceId === claim.sourceId &&
    reservation.laneKey === claim.laneKey &&
    reservation.inputRevision === claim.inputRevision &&
    candidate.sourceId === stored.sourceId &&
    stored.reservationId === claim.reservationId &&
    stored.sourceId === claim.sourceId && stored.laneKey === claim.laneKey &&
    stored.leaseOwner === claim.leaseOwner &&
    stored.expectedGeneration === claim.expectedGeneration &&
    stored.inputHash === claim.inputHash &&
    stored.inputRevision === claim.inputRevision &&
    stored.requestRole === "complete_current";
}
async function recordCompleteCurrentPublicationProof(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly bundleIdentity: string;
  readonly receipt: SchedulerCallbackReceipt;
  readonly transition: NonNullable<ReturnType<typeof completeCurrentPublicationTransition>>;
  readonly now: Date;
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
}): Promise<SchedulerVerifiedSourceBoundary> {
  const transition = input.transition;
  await verifyDurableCompleteCurrentPublication(input, transition);
  const proofId = await hashCanonicalJson({
    contract: "source-publication-receipt-v1", sourceId: input.candidate.sourceId,
    reservationId: input.reservation.reservationId, bundleIdentity: input.bundleIdentity,
    responseHash: input.receipt.responseHash, transition,
  });
  await input.database.prepare(`
    INSERT INTO source_acquisition_publications
      (proof_id, source_id, reservation_id, bundle_identity, resulting_inventory_run_id,
       resulting_union_count, published_at, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM source_acquired_bundles
      WHERE bundle_identity = ? AND reservation_id = ? AND state = 'committed')
    ON CONFLICT(reservation_id) DO NOTHING
  `).bind(proofId, input.candidate.sourceId, input.reservation.reservationId,
    input.bundleIdentity, transition.resultingInventoryRunId, transition.resultingUnionCount,
    transition.publishedAt, input.now.toISOString(), input.bundleIdentity,
    input.reservation.reservationId).run();
  const row = await input.database.prepare(`
    SELECT proof_id FROM source_acquisition_publications WHERE reservation_id = ?
  `).bind(input.reservation.reservationId).first<{proof_id:string}>();
  if(row?.proof_id !== proofId) throw stateAmbiguousError("source_publication_receipt_changed");
  recordCompleteCurrentPublicationTelemetry(input, transition, requireSourceInput(input.candidate).priorHead?.listingCount ?? 0);
  return verifiedSourceBoundary(transition, proofId, input.receipt.responseHash);
}


async function verifyDurableCompleteCurrentPublication(
  input: {
    readonly database: D1Database;
    readonly candidate: SchedulerCandidate;
  },
  transition: NonNullable<ReturnType<typeof completeCurrentPublicationTransition>>,
): Promise<void> {
  const sourceInput = requireSourceInput(input.candidate);
  const prior = transition.priorPublicationHead;
  const expectedPrior = sourceInput.priorHead ?? null;
  if (
    (prior === null) !== (expectedPrior === null) ||
    (prior !== null && expectedPrior !== null && (
      prior.inventoryRunId !== expectedPrior.inventoryRunId ||
      Number(prior.listingCount) !== expectedPrior.listingCount
    )) ||
    (expectedPrior !== null &&
      transition.resultingInventoryRunId === expectedPrior.inventoryRunId)
  ) {
    throw new Error("source_publication_prior_head_changed");
  }
  const durable = await input.database.prepare(`
    SELECT head.source_id, head.inventory_run_id, publication.listing_count,
      publication.published_at
    FROM source_inventory_publication_heads head
    JOIN source_inventory_publications publication
      ON publication.source_id = head.source_id
      AND publication.inventory_run_id = head.inventory_run_id
    WHERE head.source_id = ?
    LIMIT 1
  `).bind(input.candidate.sourceId).first<{
    source_id: string;
    inventory_run_id: string;
    listing_count: number;
    published_at: string;
  }>();
  if (
    durable === null || durable.source_id !== input.candidate.sourceId ||
    durable.inventory_run_id !== transition.resultingInventoryRunId ||
    Number(durable.listing_count) !== transition.resultingUnionCount ||
    durable.published_at !== transition.publishedAt
  ) {
    throw new Error("source_publication_durable_head_mismatch");
  }
}

async function reconstructCommittedDetachedBoundary(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
}): Promise<SchedulerVerifiedSourceBoundary | null> {
  const row = await input.database.prepare(`
    SELECT
      proof.proof_id,
      proof.resulting_inventory_run_id,
      proof.resulting_union_count,
      bundle.response_hash
    FROM source_acquisition_publications proof
    JOIN source_acquired_bundles bundle
      ON bundle.bundle_identity = proof.bundle_identity
      AND bundle.reservation_id = proof.reservation_id
      AND bundle.state = 'committed'
    WHERE proof.reservation_id = ? AND proof.source_id = ?
    LIMIT 2
  `).bind(
    input.reservation.reservationId,
    input.candidate.sourceId,
  ).all<{
    proof_id: string;
    resulting_inventory_run_id: string | null;
    resulting_union_count: number;
    response_hash: string;
  }>();
  const rows = row.results ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error("detached_callback_committed_proof_ambiguous");
  const proof = rows[0]!;
  const durableHead = await readDurableSourceHead(
    input.database,
    input.candidate.sourceId,
  );
  if (
    durableHead === null ||
    durableHead.inventoryRunId !== proof.resulting_inventory_run_id ||
    durableHead.listingCount !== Number(proof.resulting_union_count) ||
    !/^sha256:[0-9a-f]{64}$/u.test(proof.proof_id) ||
    !/^sha256:[0-9a-f]{64}$/u.test(proof.response_hash)
  ) throw new Error("detached_callback_committed_proof_mismatch");
  return Object.freeze({
    outcome: "refreshed",
    priorHead: requireSourceInput(input.candidate).priorHead ?? null,
    resultingHead: Object.freeze({
      inventoryRunId: durableHead.inventoryRunId,
      listingCount: durableHead.listingCount,
    }),
    proofIdentity: proof.proof_id,
    receiptIdentity: proof.response_hash,
  });
}

async function readDurableSourceHead(
  database: D1Database,
  sourceId: string,
): Promise<Readonly<{
  inventoryRunId: string;
  listingCount: number;
  publishedAt: string;
}> | null> {
  const row = await database.prepare(`
    SELECT head.inventory_run_id, publication.listing_count,
      publication.published_at
    FROM source_inventory_publication_heads head
    JOIN source_inventory_publications publication
      ON publication.source_id = head.source_id
      AND publication.inventory_run_id = head.inventory_run_id
    WHERE head.source_id = ?
    LIMIT 1
  `).bind(sourceId).first<DurableSourceHeadRow>();
  if (row === null) return null;
  const listingCount = Number(row.listing_count);
  if (
    typeof row.inventory_run_id !== "string" || row.inventory_run_id.length < 1 ||
    row.inventory_run_id.length > 512 || !Number.isSafeInteger(listingCount) ||
    listingCount < 0 || listingCount > 1_000_000 ||
    !Number.isFinite(Date.parse(row.published_at))
  ) throw new Error("durable_source_head_invalid");
  return Object.freeze({
    inventoryRunId: row.inventory_run_id,
    listingCount,
    publishedAt: row.published_at,
  });
}

function sameSchedulerSourceHead(
  durable: Readonly<{ inventoryRunId: string; listingCount: number }> | null,
  expected: Readonly<{ inventoryRunId: string; listingCount: number }> | null,
): boolean {
  return durable === null || expected === null
    ? durable === null && expected === null
    : durable.inventoryRunId === expected.inventoryRunId &&
      durable.listingCount === expected.listingCount;
}

function orderedDetachedPublicationTimes(input: {
  readonly reservationCreatedAt: string;
  readonly discoveryStartedAt: string;
  readonly sourceStartedAt: string;
  readonly sourceCompletedAt: string;
  readonly publishedAt: string;
  readonly discoveryCompletedAt: string;
}): boolean {
  const reservation = Date.parse(input.reservationCreatedAt);
  const discoveryStarted = Date.parse(input.discoveryStartedAt);
  const sourceStarted = Date.parse(input.sourceStartedAt);
  const sourceCompleted = Date.parse(input.sourceCompletedAt);
  const published = Date.parse(input.publishedAt);
  const discoveryCompleted = Date.parse(input.discoveryCompletedAt);
  return [
    reservation,
    discoveryStarted,
    sourceStarted,
    sourceCompleted,
    published,
    discoveryCompleted,
  ].every(Number.isFinite) &&
    reservation <= discoveryStarted && discoveryStarted <= sourceStarted &&
    sourceStarted <= sourceCompleted && sourceStarted <= published &&
    published <= discoveryCompleted && sourceCompleted <= discoveryCompleted;
}

function detachedAmbiguous(
  reasonCode: string,
): SchedulerDetachedCallbackReconciliation {
  return Object.freeze({
    state: "outcome",
    outcome: Object.freeze({
      classification: "handler_failure_state_ambiguous",
      madeProgress: false,
      remaining: true,
      reasonCode,
    }),
  });
}

function verifiedSourceBoundary(
  transition: NonNullable<ReturnType<typeof completeCurrentPublicationTransition>>,
  proofIdentity: string,
  receiptIdentity: string,
): SchedulerVerifiedSourceBoundary {
  return Object.freeze({
    outcome: "refreshed",
    priorHead: transition.priorPublicationHead === null
      ? null
      : Object.freeze({
          inventoryRunId: String(transition.priorPublicationHead.inventoryRunId),
          listingCount: Number(transition.priorPublicationHead.listingCount),
        }),
    resultingHead: Object.freeze({
      inventoryRunId: transition.resultingInventoryRunId,
      listingCount: transition.resultingUnionCount,
    }),
    proofIdentity,
    receiptIdentity,
  });
}

function recordCompleteCurrentPublicationTelemetry(
  input: {
    readonly candidate: SchedulerCandidate;
    readonly telemetry?: PerformanceTelemetrySink;
    readonly telemetryContext?: PerformanceTelemetryContext;
  },
  transition: NonNullable<ReturnType<typeof completeCurrentPublicationTransition>>,
  priorUnionCount: number,
): void {
  input.telemetry?.record({
    context: {
      ...input.telemetryContext,
      sourceId: input.candidate.sourceId,
      coverageMode: "complete_current",
      publicationId: transition.resultingInventoryRunId,
    },
    details: {
      kind: "publication",
      outcome: "published",
      priorHeadIdentity: typeof transition.priorPublicationHead?.inventoryRunId === "string"
        ? transition.priorPublicationHead.inventoryRunId
        : null,
      resultingHeadIdentity: transition.resultingInventoryRunId,
      preservationReasonCode: null,
      firstSeenCount: transition.firstSeenCount,
      priorUnionCount,
      resultingUnionCount: transition.resultingUnionCount,
    },
  });
  input.telemetry?.record({
    context: {
      ...input.telemetryContext,
      sourceId: input.candidate.sourceId,
      coverageMode: "complete_current",
      publicationId: transition.resultingInventoryRunId,
    },
    details: {
      kind: "equivalence",
      surface: "publication",
      equivalent: true,
      reasonCode: "durable_complete_current_transition",
    },
  });
}

function completeCurrentPublicationTransition(
  body: unknown,
  sourceId: string,
): {
  readonly resultingInventoryRunId: string;
  readonly resultingUnionCount: number;
  readonly publishedAt: string;
  readonly firstSeenCount: number;
  readonly priorPublicationHead: Readonly<Record<string, unknown>> | null;
} | null {
  if (!isRecord(body)) return null;
  const catalog = isRecord(body.catalog) ? body.catalog : body;
  if (!Array.isArray(catalog.publicationTransitions)) return null;
  const raw = catalog.publicationTransitions.find((entry) =>
    isRecord(entry) && entry.sourceId === sourceId
  );
  if (!isRecord(raw) || raw.outcome !== "published" || !isRecord(raw.resultingHead)) {
    return null;
  }
  const head = raw.resultingHead;
  if (
    head.sourceId !== sourceId || typeof head.inventoryRunId !== "string" ||
    head.inventoryRunId.length < 1 || head.inventoryRunId.length > 512 ||
    typeof head.publishedAt !== "string" || !Number.isFinite(Date.parse(head.publishedAt)) ||
    Date.parse(head.publishedAt) > inputDateCeilingMs() ||
    !Number.isInteger(head.listingCount) || Number(head.listingCount) < 0 ||
    Number(head.listingCount) > 1_000_000
  ) return null;
  const prior = raw.priorHead;
  if (prior !== null && (
    !isRecord(prior) || prior.sourceId !== sourceId ||
    typeof prior.inventoryRunId !== "string" || prior.inventoryRunId.length < 1 ||
    prior.inventoryRunId.length > 512 || typeof prior.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(prior.publishedAt)) ||
    !Number.isInteger(prior.listingCount) || Number(prior.listingCount) < 0 ||
    Number(prior.listingCount) > 1_000_000
  )) return null;
  return Object.freeze({
    resultingInventoryRunId: head.inventoryRunId,
    resultingUnionCount: Number(head.listingCount),
    publishedAt: head.publishedAt,
    firstSeenCount: Number.isInteger(catalog.newListings) && Number(catalog.newListings) >= 0 &&
        Number(catalog.newListings) <= Number(head.listingCount)
      ? Number(catalog.newListings)
      : 0,
    priorPublicationHead: prior === null
      ? null
      : Object.freeze({
          inventoryRunId: prior.inventoryRunId,
          publishedAt: prior.publishedAt,
          listingCount: Number(prior.listingCount),
        }),
  });
}

function inputDateCeilingMs(): number {
  return Date.now() + 5 * 60_000;
}

export interface NightlyProjectionSliceResult extends ProjectionRefreshQuantumResult {
  readonly quanta: number;
  readonly stopReason:
    | "completed"
    | "failed"
    | "claim_missed"
    | "max_quanta"
    | "elapsed_ceiling";
}

/**
 * Runs a finite local projection slice while each underlying quantum retains
 * its own durable cursor. The slice reduces loopback request amplification but
 * never turns the whole slice into one all-or-nothing mutation.
 */
export async function runBoundedNightlyProjectionSlice(input: {
  readonly runQuantum: () => Promise<ProjectionRefreshQuantumResult>;
  readonly monotonicNow?: () => number;
  readonly maxQuanta?: number;
  readonly elapsedCeilingMs?: number;
}): Promise<NightlyProjectionSliceResult> {
  const maxQuanta = input.maxQuanta ?? PROJECTION_SLICE_MAX_QUANTA;
  const elapsedCeilingMs = input.elapsedCeilingMs ??
    PROJECTION_SLICE_ELAPSED_CEILING_MS;
  if (!Number.isSafeInteger(maxQuanta) || maxQuanta < 1 ||
      maxQuanta > PROJECTION_SLICE_MAX_QUANTA) {
    throw new RangeError("projection slice quantum limit is invalid");
  }
  if (!Number.isFinite(elapsedCeilingMs) || elapsedCeilingMs <= 0 ||
      elapsedCeilingMs > PROJECTION_SLICE_ELAPSED_CEILING_MS) {
    throw new RangeError("projection slice elapsed ceiling is invalid");
  }
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  const startedAt = monotonicNow();
  const aggregate = {
    claimed: 0,
    completed: 0,
    deferred: 0,
    failed: 0,
    stale: 0,
    rows: 0,
    statements: 0,
  };
  let quanta = 0;
  let stopReason: NightlyProjectionSliceResult["stopReason"] = "max_quanta";
  while (quanta < maxQuanta) {
    const quantum = await input.runQuantum();
    quanta += 1;
    aggregate.claimed += quantum.claimed;
    aggregate.completed += quantum.completed;
    aggregate.deferred += quantum.deferred;
    aggregate.failed += quantum.failed;
    aggregate.stale += quantum.stale;
    aggregate.rows += quantum.rows;
    aggregate.statements += quantum.statements;
    if (quantum.failed > 0) {
      stopReason = "failed";
      break;
    }
    if (quantum.claimed === 0) {
      stopReason = "claim_missed";
      break;
    }
    if (quantum.completed > 0) {
      stopReason = "completed";
      break;
    }
    if (monotonicNow() - startedAt >= elapsedCeilingMs) {
      stopReason = "elapsed_ceiling";
      break;
    }
  }
  return Object.freeze({ ...aggregate, quanta, stopReason });
}

async function executeProjectionCandidate(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly now: Date;
}): Promise<SchedulerWorkOutcome> {
  const item = requireWorkItem(input.candidate);
  const stage = item.stage as ProjectionRefreshStage;
  const contracts = await readCurrentProjectionContracts(input.database);
  const result = await runBoundedNightlyProjectionSlice({
    runQuantum: () => runProjectionRefreshQuantum({
      database: input.database,
      stage,
      owner: `nightly-projection:${input.reservation.reservationId.slice(-24)}`,
      contracts: { ...contracts, now: input.now },
      claimLimit: 100,
      listingBatchSize: PROJECTION_SLICE_BATCH_SIZE,
      leaseMs: PREPARATION_LEASE_MS,
      now: input.now,
    }),
  });
  if (result.rows > 0 || result.completed > 0) {
    await enqueueProjectedSourceReleaseWork(
      input.database,
      input.now,
      item.sourceId === null ? [] : [item.sourceId],
    );
  }
  const pending = await exactWorkItemExists(input.database, item);
  if (!pending) {
    return Object.freeze({
      classification: "completed",
      madeProgress: true,
      remaining: false,
    });
  }
  if (result.failed > 0) {
    return Object.freeze({
      classification: "retryable_pressure",
      madeProgress: result.rows > 0 || result.completed > 0 || result.deferred > 0,
      remaining: true,
      availableAt: new Date(input.now.getTime() + RETRY_DELAY_MS).toISOString(),
      reasonCode: "projection_refresh_failed",
    });
  }
  return Object.freeze({
    classification: "retryable_pressure",
    madeProgress: result.rows > 0 || result.completed > 0 || result.deferred > 0,
    remaining: true,
    availableAt: input.now.toISOString(),
    reasonCode: result.stopReason === "claim_missed"
      ? "projection_claim_missed"
      : "projection_quantum_remaining",
  });
}

export async function enqueueProjectedSourceReleaseWork(
  database: D1Database,
  now: Date,
  explicitlyAffectedSourceIds: readonly string[] = [],
): Promise<void> {
  const touched = await database.prepare(`
    SELECT DISTINCT source_id
    FROM listing_current_pipeline_state
    WHERE updated_at = ?
    ORDER BY source_id
    LIMIT 33
  `).bind(now.toISOString()).all<{ source_id: string }>();
  const sourceIds = [...new Set([
    ...explicitlyAffectedSourceIds,
    ...(touched.results ?? []).map((row) => row.source_id),
  ])].sort();
  if (sourceIds.length > 32) throw new RangeError("projection release fan-out exceeded 32 sources");
  for (const sourceId of sourceIds) {
    const rows: Array<{
      listing_id: string;
      source_release_work_input_hash: string;
    }> = [];
    let afterListingId: string | null = null;
    for (;;) {
      const page: D1Result<{
        listing_id: string;
        source_release_work_input_hash: string;
      }> = await database.prepare(`
        SELECT listing_id, source_release_work_input_hash
        FROM listing_current_pipeline_state
        WHERE source_id = ? AND (? IS NULL OR listing_id > ?)
        ORDER BY listing_id
        LIMIT ?
      `).bind(
        sourceId,
        afterListingId,
        afterListingId,
        RELEASE_FANOUT_BATCH_SIZE,
      ).all<{
        listing_id: string;
        source_release_work_input_hash: string;
      }>();
      const pageRows: Array<{
        listing_id: string;
        source_release_work_input_hash: string;
      }> = page.results ?? [];
      rows.push(...pageRows);
      if (rows.length > MAX_RELEASE_FANOUT_ROWS) {
        throw new RangeError(
          `source release fan-out exceeded ${MAX_RELEASE_FANOUT_ROWS} listings for ${sourceId}`,
        );
      }
      if (pageRows.length < RELEASE_FANOUT_BATCH_SIZE) break;
      afterListingId = pageRows.at(-1)!.listing_id;
    }
    await coalescePipelineWorkItem({
      database,
      stage: "source_release",
      subject: { type: "source", id: sourceId },
      laneKey: `source-release:${sourceId}`,
      inputHash: await hashCanonicalJson({
        version: NIGHTLY_SCHEDULER_RUNTIME_VERSION,
        sourceId,
        listings: rows.map((row) => [
          row.listing_id,
          row.source_release_work_input_hash,
        ]),
      }),
      priority: 30,
      reasonCode: "projection_source_release_changed",
      now,
    });
  }
}

async function exactWorkItemExists(
  database: D1Database,
  item: PipelineWorkItem,
): Promise<boolean> {
  const row = await database.prepare(`
    SELECT 1 AS found FROM pipeline_work_items
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND input_hash = ? AND revision = ?
  `).bind(
    item.stage,
    item.subjectType,
    item.subjectId,
    item.inputHash,
    item.revision,
  ).first<{ found: number }>();
  return row !== null;
}

/**
 * The broad image workers select only unclaimed queue rows. Hand the exact
 * scheduler claim back before dispatch and persist the source/stage queue
 * boundary on that same desired revision so the later receipt can prove a
 * bounded delta without trusting the callback's success label alone.
 */
async function preparePrimaryImageCallbackHandoff(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly instruction: Exclude<SchedulerCallbackInstruction, { kind: "local_commit" }>;
  readonly now: Date;
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
}): Promise<SchedulerCommitResult> {
  const item = requireWorkItem(input.candidate);
  const queueTotal = await countPrimaryImageSourceQueue(
    input.database,
    input.candidate.sourceId,
  );
  const cursor = primaryImageHandoffCursor(input.reservation);
  const handedOff = await deferPipelineWorkClaim({
    database: input.database,
    claim: requiredQueueClaim(input.reservation),
    availableAt: input.now,
    progress: {
      cursor,
      generation: item.revision,
      rows: queueTotal,
    },
    now: input.now,
    telemetry: input.telemetry,
    telemetryContext: input.telemetryContext,
  });
  if (handedOff.outcome === "deferred") {
    return Object.freeze({ kind: "callback_required", instruction: input.instruction });
  }
  const current = handedOff.item;
  if (current === null) {
    return Object.freeze({
      kind: "outcome",
      outcome: primaryImageCompletedOutcome(),
    });
  }
  if (!sameWorkRevision(current, item)) {
    return Object.freeze({
      kind: "outcome",
      outcome: primaryImageInputChangedOutcome(
        current,
        input.candidate.sourceId,
        queueTotal,
      ),
    });
  }
  if (
    handedOff.outcome === "claim_missed" &&
    isUnclaimedWorkItem(current) &&
    current.progress.cursor === cursor &&
    current.progress.generation === item.revision &&
    current.progress.rows === queueTotal
  ) {
    // The first prepare response may have detached after its durable handoff.
    // Returning the same instruction is safe because the caller has not yet
    // crossed its callback-dispatch boundary.
    return Object.freeze({ kind: "callback_required", instruction: input.instruction });
  }
  throw stateAmbiguousError("primary_image_callback_handoff_changed");
}

interface EnrichmentCallbackProgressReceipt {
  readonly queued: number;
  readonly claimed: number;
  readonly completed: number;
  readonly stale: number;
  readonly remaining: number;
  readonly remainingWork: boolean;
  readonly suppliedClaimOutcome:
    | "completed"
    | "stale_or_obsolete"
    | "failed_or_deferred"
    | "still_pending";
  readonly suppliedClaim: Readonly<{
    stage: string;
    subjectType: string;
    subjectId: string;
    owner: string;
    inputHash: string;
    revision: number;
  }>;
}

async function finalizeEnrichmentCallback(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly receipt: SchedulerCallbackReceipt;
  readonly callbackContract: string | null;
  readonly now: Date;
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
}): Promise<SchedulerWorkOutcome> {
  const expected = requireWorkItem(input.candidate);
  const claim = requiredQueueClaim(input.reservation);
  const parsed = parseEnrichmentCallbackProgress(input.receipt.body);
  const boundReceipt = parsed !== null && sameEnrichmentReceiptClaim(
    parsed.suppliedClaim,
    claim,
  ) && parsed.remainingWork === (parsed.remaining > 0);
  const currentBefore = await readExactWorkIdentity(input.database, expected);
  const durable = await readEnrichmentQueueProgress(input.database, input.now);
  const receiptMatchesQueue = boundReceipt && parsed.remaining === durable.remaining;
  const enrichmentProgress: SchedulerEnrichmentProgress = Object.freeze({
    scope: SCHEDULER_ENRICHMENT_PROGRESS_SCOPE,
    queued: receiptMatchesQueue ? parsed.queued : durable.queued,
    claimed: durable.claimed,
    completed: receiptMatchesQueue ? parsed.completed : null,
    stale: receiptMatchesQueue ? parsed.stale : null,
    remaining: durable.remaining,
  });
  const callbackReportedSuccess = callbackSucceeded(
    input.callbackContract,
    input.receipt,
    input.candidate.sourceId,
  );
  const callbackContractSatisfied = callbackReportedSuccess && receiptMatchesQueue && (
    parsed.suppliedClaimOutcome === "completed" ||
    parsed.suppliedClaimOutcome === "stale_or_obsolete"
  );

  if (currentBefore === null) {
    return enrichmentProgressOutcome(
      enrichmentProgress,
      input.now,
      true,
      callbackContractSatisfied
        ? "enrichment_session_remaining"
        : "enrichment_session_completed_after_callback_failure",
    );
  }

  if (!sameWorkRevision(currentBefore, expected)) {
    if (!isUnclaimedWorkItem(currentBefore)) {
      throw stateAmbiguousError("enrichment_callback_newer_revision_reclaimed");
    }
    return Object.freeze({
      classification: "retryable_pressure",
      madeProgress: true,
      remaining: true,
      availableAt: currentBefore.availableAt,
      reasonCode: "pipeline_work_input_changed",
      enrichmentProgress,
    });
  }

  const reasonCode = callbackReportedSuccess
    ? "enrichment_session_did_not_complete_claim"
    : callbackFailureCode(input.callbackContract, input.receipt);
  const retryAt = new Date(input.now.getTime() + RETRY_DELAY_MS);
  const released = await deferPipelineWorkClaim({
    database: input.database,
    claim,
    availableAt: retryAt,
    now: input.now,
    telemetry: input.telemetry,
    telemetryContext: input.telemetryContext,
  });
  if (released.item === null) {
    const after = await readEnrichmentQueueProgress(input.database, input.now);
    return enrichmentProgressOutcome(
      Object.freeze({
        ...enrichmentProgress,
        claimed: after.claimed,
        remaining: after.remaining,
      }),
      input.now,
      true,
      "enrichment_session_completed_during_finalization",
    );
  }
  if (released.outcome === "stale_released") {
    return Object.freeze({
      classification: "retryable_pressure",
      madeProgress: true,
      remaining: true,
      availableAt: released.item.availableAt,
      reasonCode: "pipeline_work_input_changed",
      enrichmentProgress,
    });
  }
  if (!sameWorkRevision(released.item, expected)) {
    throw stateAmbiguousError("enrichment_callback_work_identity_changed");
  }
  if (!isUnclaimedWorkItem(released.item)) {
    throw stateAmbiguousError("enrichment_callback_claim_reowned");
  }
  const finalProgress = await readEnrichmentQueueProgress(input.database, input.now);
  return Object.freeze({
    classification: "retryable_pressure",
    madeProgress: false,
    remaining: true,
    availableAt: released.item.availableAt,
    reasonCode,
    noProgressIdentity: enrichmentNoProgressIdentity(
      reasonCode,
      finalProgress.remaining ?? 0,
    ),
    enrichmentProgress: Object.freeze({
      ...enrichmentProgress,
      claimed: finalProgress.claimed,
      remaining: finalProgress.remaining,
    }),
  });
}

function enrichmentProgressOutcome(
  progress: SchedulerEnrichmentProgress,
  now: Date,
  madeProgress: true,
  reasonCode: string,
): SchedulerWorkOutcome {
  if ((progress.remaining ?? 0) === 0) {
    return Object.freeze({
      classification: "completed",
      madeProgress,
      remaining: false,
      enrichmentProgress: progress,
    });
  }
  return Object.freeze({
    classification: "retryable_pressure",
    madeProgress,
    remaining: true,
    availableAt: now.toISOString(),
    reasonCode,
    enrichmentProgress: progress,
  });
}

function parseEnrichmentCallbackProgress(
  body: unknown,
): EnrichmentCallbackProgressReceipt | null {
  if (!isRecord(body) || !isRecord(body.work)) return null;
  const work = body.work;
  if (
    work.scope !== SCHEDULER_ENRICHMENT_PROGRESS_SCOPE ||
    typeof work.remainingWork !== "boolean" ||
    !isRecord(work.suppliedClaim) ||
    !isRecord(work.suppliedClaim.claim) ||
    ![
      "completed",
      "stale_or_obsolete",
      "failed_or_deferred",
      "still_pending",
    ].includes(String(work.suppliedClaim.outcome))
  ) return null;
  const queued = nonnegativeSafeIntegerOrNull(work.queued);
  const claimed = nonnegativeSafeIntegerOrNull(work.claimed);
  const completed = nonnegativeSafeIntegerOrNull(work.completed);
  const stale = nonnegativeSafeIntegerOrNull(work.stale);
  const remaining = nonnegativeSafeIntegerOrNull(work.remaining);
  if (
    queued === null || claimed === null || completed === null ||
    stale === null || remaining === null
  ) return null;
  const claim = work.suppliedClaim.claim;
  if (
    typeof claim.stage !== "string" ||
    typeof claim.subjectType !== "string" ||
    typeof claim.subjectId !== "string" ||
    typeof claim.owner !== "string" ||
    typeof claim.inputHash !== "string" ||
    !Number.isSafeInteger(claim.revision) || Number(claim.revision) < 1
  ) return null;
  return Object.freeze({
    queued,
    claimed,
    completed,
    stale,
    remaining,
    remainingWork: work.remainingWork,
    suppliedClaimOutcome: work.suppliedClaim.outcome as
      EnrichmentCallbackProgressReceipt["suppliedClaimOutcome"],
    suppliedClaim: Object.freeze({
      stage: claim.stage,
      subjectType: claim.subjectType,
      subjectId: claim.subjectId,
      owner: claim.owner,
      inputHash: claim.inputHash,
      revision: Number(claim.revision),
    }),
  });
}

function sameEnrichmentReceiptClaim(
  actual: EnrichmentCallbackProgressReceipt["suppliedClaim"],
  expected: NonNullable<SchedulerReservation["queueClaim"]>,
): boolean {
  return actual.stage === expected.stage &&
    actual.subjectType === expected.subjectType &&
    actual.subjectId === expected.subjectId &&
    actual.owner === expected.owner &&
    actual.inputHash === expected.inputHash &&
    actual.revision === expected.revision;
}

async function readEnrichmentQueueProgress(
  database: D1Database,
  now: Date,
): Promise<SchedulerEnrichmentProgress> {
  const row = await database.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN lease_owner IS NOT NULL AND lease_expires_at > ?
        THEN 1 ELSE 0 END), 0) AS claimed
    FROM pipeline_work_items
    WHERE stage IN ('enrichment_text', 'enrichment_embedding')
      AND subject_type = 'listing'
  `).bind(now.toISOString()).first<{ total: number; claimed: number }>();
  const remaining = numeric(row?.total ?? 0);
  return Object.freeze({
    scope: SCHEDULER_ENRICHMENT_PROGRESS_SCOPE,
    queued: remaining,
    claimed: numeric(row?.claimed ?? 0),
    completed: null,
    stale: null,
    remaining,
  });
}

function nonnegativeSafeIntegerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function enrichmentNoProgressIdentity(reasonCode: string, queueTotal: number): string {
  return `enrichment:${reasonCode}:remaining:${queueTotal}`;
}

async function finalizePrimaryImageCallback(input: {
  readonly database: D1Database;
  readonly candidate: SchedulerCandidate;
  readonly reservation: SchedulerReservation;
  readonly receipt: SchedulerCallbackReceipt;
  readonly callbackSucceeded: boolean;
  readonly callbackContract: string | null;
  readonly now: Date;
}): Promise<SchedulerWorkOutcome> {
  const expected = requireWorkItem(input.candidate);
  let current = await readExactWorkIdentity(input.database, expected);
  if (current === null) return primaryImageCompletedOutcome();
  if (!sameWorkRevision(current, expected)) {
    return primaryImageInputChangedOutcome(
      current,
      input.candidate.sourceId,
      await countPrimaryImageSourceQueue(input.database, input.candidate.sourceId),
    );
  }
  if (!isUnclaimedWorkItem(current)) {
    throw stateAmbiguousError("primary_image_callback_handoff_reclaimed");
  }

  const deltaCursor = primaryImageFinalCursor(
    input.reservation,
    input.receipt,
    "primary_image_callback_queue_delta",
  );
  const noDeltaReason = input.callbackSucceeded
    ? "primary_image_callback_did_not_complete_claim"
    : callbackFailureCode(input.callbackContract, input.receipt);
  const noDeltaCursor = primaryImageFinalCursor(
    input.reservation,
    input.receipt,
    noDeltaReason,
  );
  if (current.progress.cursor === deltaCursor) {
    return primaryImageQueueDeltaOutcome(current.availableAt);
  }
  if (current.progress.cursor === noDeltaCursor) {
    return primaryImageNoDeltaOutcome(
      current.availableAt,
      noDeltaReason,
      input.candidate.sourceId,
      current.progress.rows,
    );
  }
  if (
    current.progress.cursor !== primaryImageHandoffCursor(input.reservation) ||
    current.progress.generation !== expected.revision
  ) {
    throw stateAmbiguousError("primary_image_callback_handoff_changed");
  }

  const queueTotal = await countPrimaryImageSourceQueue(
    input.database,
    input.candidate.sourceId,
  );
  const stageDelta = queueTotal < current.progress.rows;
  const reasonCode = stageDelta
    ? "primary_image_callback_queue_delta"
    : noDeltaReason;
  const availableAt = stageDelta
    ? input.now
    : new Date(input.now.getTime() + RETRY_DELAY_MS);
  const finalCursor = stageDelta ? deltaCursor : noDeltaCursor;
  const result = await input.database.prepare(`
    UPDATE pipeline_work_items
    SET available_at = ?, progress_cursor = ?, progress_generation = ?,
        progress_rows = ?, updated_at = ?
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND input_hash = ? AND revision = ?
      AND lease_owner IS NULL AND lease_expires_at IS NULL
      AND claimed_input_hash IS NULL AND claimed_revision IS NULL
      AND progress_cursor = ? AND progress_generation = ? AND progress_rows = ?
  `).bind(
    availableAt.toISOString(),
    finalCursor,
    expected.revision,
    queueTotal,
    input.now.toISOString(),
    expected.stage,
    expected.subjectType,
    expected.subjectId,
    expected.inputHash,
    expected.revision,
    current.progress.cursor,
    current.progress.generation,
    current.progress.rows,
  ).run();
  if (changes(result) !== 1) {
    current = await readExactWorkIdentity(input.database, expected);
    if (current === null) return primaryImageCompletedOutcome();
    if (!sameWorkRevision(current, expected)) {
      return primaryImageInputChangedOutcome(
        current,
        input.candidate.sourceId,
        await countPrimaryImageSourceQueue(input.database, input.candidate.sourceId),
      );
    }
    if (!isUnclaimedWorkItem(current)) {
      throw stateAmbiguousError("primary_image_callback_handoff_reclaimed");
    }
    if (current.progress.cursor === deltaCursor) {
      return primaryImageQueueDeltaOutcome(current.availableAt);
    }
    if (current.progress.cursor === noDeltaCursor) {
      return primaryImageNoDeltaOutcome(
        current.availableAt,
        noDeltaReason,
        input.candidate.sourceId,
        current.progress.rows,
      );
    }
    throw stateAmbiguousError("primary_image_callback_finalization_changed");
  }
  return stageDelta
    ? primaryImageQueueDeltaOutcome(availableAt.toISOString())
    : primaryImageNoDeltaOutcome(
        availableAt.toISOString(),
        reasonCode,
        input.candidate.sourceId,
        queueTotal,
      );
}

async function readExactWorkIdentity(
  database: D1Database,
  item: PipelineWorkItem,
): Promise<PipelineWorkItem | null> {
  const row = await database.prepare(`
    SELECT ${WORK_ROW_COLUMNS} FROM pipeline_work_items
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
  `).bind(item.stage, item.subjectType, item.subjectId).first<WorkRow>();
  return row === null ? null : mapWorkItem(row);
}

async function countPrimaryImageSourceQueue(
  database: D1Database,
  sourceId: string,
): Promise<number> {
  const row = await database.prepare(`
    SELECT COUNT(*) AS count
    FROM pipeline_work_items work
    WHERE work.stage = 'primary_image' AND work.source_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM listing_recovery_status terminal_image
        WHERE terminal_image.listing_id = work.listing_id
          AND terminal_image.state = 'terminal'
          AND terminal_image.stage = 'image'
          AND ${CURRENT_TERMINAL_IMAGE_EVIDENCE_SQL}
      )
  `).bind(sourceId).first<{ count: number }>();
  return numeric(row?.count ?? 0);
}

function sameWorkRevision(current: PipelineWorkItem, expected: PipelineWorkItem): boolean {
  return current.inputHash === expected.inputHash && current.revision === expected.revision;
}

function isUnclaimedWorkItem(item: PipelineWorkItem): boolean {
  return item.leaseOwner === null && item.leaseExpiresAt === null &&
    item.claimedInputHash === null && item.claimedRevision === null;
}

function primaryImageHandoffCursor(reservation: SchedulerReservation): string {
  return `${PRIMARY_IMAGE_HANDOFF_CURSOR_VERSION}:${reservation.reservationId}`;
}

function primaryImageFinalCursor(
  reservation: SchedulerReservation,
  receipt: SchedulerCallbackReceipt,
  reasonCode: string,
): string {
  return `${PRIMARY_IMAGE_FINAL_CURSOR_VERSION}:${reservation.reservationId}:` +
    `${receipt.responseHash}:${reasonCode}`;
}

function primaryImageCompletedOutcome(): SchedulerWorkOutcome {
  return Object.freeze({
    classification: "completed",
    madeProgress: true,
    remaining: false,
  });
}

function primaryImageInputChangedOutcome(
  item: PipelineWorkItem,
  sourceId: string,
  queueTotal: number,
): SchedulerWorkOutcome {
  if (!isUnclaimedWorkItem(item)) {
    throw stateAmbiguousError("primary_image_callback_newer_revision_reclaimed");
  }
  return Object.freeze({
    classification: "retryable_pressure",
    madeProgress: false,
    remaining: true,
    availableAt: item.availableAt,
    reasonCode: "pipeline_work_input_changed",
    noProgressIdentity: primaryImageNoProgressIdentity(sourceId, queueTotal),
  });
}

function primaryImageQueueDeltaOutcome(availableAt: string): SchedulerWorkOutcome {
  return Object.freeze({
    classification: "retryable_pressure",
    madeProgress: true,
    remaining: true,
    availableAt,
    reasonCode: "primary_image_callback_queue_delta",
  });
}

function primaryImageNoDeltaOutcome(
  availableAt: string,
  reasonCode: string,
  sourceId: string,
  queueTotal: number,
): SchedulerWorkOutcome {
  return Object.freeze({
    classification: "retryable_pressure",
    madeProgress: false,
    remaining: true,
    availableAt,
    reasonCode,
    noProgressIdentity: primaryImageNoProgressIdentity(sourceId, queueTotal),
  });
}

function primaryImageNoProgressIdentity(sourceId: string, queueTotal: number): string {
  return `primary_image:${sourceId}:remaining:${queueTotal}`;
}

async function completePreparation(
  database: D1Database,
  reservation: SchedulerReservation,
  telemetry?: PerformanceTelemetrySink,
  telemetryContext?: PerformanceTelemetryContext,
): Promise<SchedulerWorkOutcome> {
  const result = await completePipelineWorkClaim({
    database,
    claim: requiredQueueClaim(reservation),
    telemetry,
    telemetryContext,
  });
  if (result.outcome === "claim_missed") throw priorHeadError("pipeline_work_claim_missed");
  if (result.outcome === "stale_released") {
    return Object.freeze({
      classification: "retryable_pressure",
      madeProgress: true,
      remaining: true,
      availableAt: result.item.availableAt,
      reasonCode: "pipeline_work_input_changed",
    });
  }
  return Object.freeze({ classification: "completed", madeProgress: true, remaining: false });
}

async function failPreparation(
  database: D1Database,
  reservation: SchedulerReservation,
  now: Date,
  reasonCode: string,
  fingerprint: string,
  telemetry?: PerformanceTelemetrySink,
  telemetryContext?: PerformanceTelemetryContext,
): Promise<SchedulerWorkOutcome> {
  await failPipelineWorkClaim({
    database,
    claim: requiredQueueClaim(reservation),
    errorCode: reasonCode,
    errorFingerprint: fingerprint,
    retryAt: new Date(now.getTime() + RETRY_DELAY_MS),
    now,
    telemetry,
    telemetryContext,
  });
  return Object.freeze({
    classification: "retryable_pressure",
    madeProgress: false,
    remaining: true,
    availableAt: new Date(now.getTime() + RETRY_DELAY_MS).toISOString(),
    reasonCode,
  });
}

async function deferPreparation(
  database: D1Database,
  reservation: SchedulerReservation,
  now: Date,
  reasonCode: string,
  madeProgress: boolean,
  telemetry?: PerformanceTelemetrySink,
  telemetryContext?: PerformanceTelemetryContext,
): Promise<SchedulerWorkOutcome> {
  const availableAt = new Date(now.getTime() + RETRY_DELAY_MS);
  await deferPipelineWorkClaim({
    database,
    claim: requiredQueueClaim(reservation),
    availableAt,
    now,
    telemetry,
    telemetryContext,
  });
  return Object.freeze({
    classification: "retryable_pressure",
    madeProgress,
    remaining: true,
    availableAt: availableAt.toISOString(),
    reasonCode,
  });
}

function callback(
  service: "dashboard" | "companion",
  path: string,
  body: Readonly<Record<string, unknown>> | null,
  successContract: Exclude<SchedulerCallbackInstruction, { kind: "local_commit" }>[
    "successContract"
  ],
  timeoutMs: number,
  executionBoundary: "commit_fifo" | "acquire_outside_fifo" = "commit_fifo",
): SchedulerCallbackInstruction {
  return Object.freeze({
    kind: "loopback_json",
    service,
    path,
    body,
    timeoutMs,
    successContract,
    ...(executionBoundary === "commit_fifo" ? {} : { executionBoundary }),
  });
}

function callbackSucceeded(
  contract: string | null,
  receipt: SchedulerCallbackReceipt,
  sourceId: string,
): boolean {
  if (receipt.status < 200 || receipt.status >= 300 || !isRecord(receipt.body)) return false;
  if (contract === "source_catalog") {
    const catalog = isRecord(receipt.body.catalog) ? receipt.body.catalog : receipt.body;
    return catalog.status === "completed" && Array.isArray(catalog.publishedSourceIds) &&
      catalog.publishedSourceIds.includes(sourceId) &&
      (!Array.isArray(catalog.sourceErrors) || catalog.sourceErrors.length === 0);
  }
  if (contract === "source_continuation") {
    const continuation = isRecord(receipt.body.continuation)
      ? receipt.body.continuation
      : receipt.body;
    return continuation.status === "completed" ||
      (receipt.body.status === "skipped" && receipt.body.skipReason === "no_pending_work");
  }
  if (
    contract === "enrichment_session" ||
    contract === "proximity_session" || contract === "preference_v2_session" ||
    contract === "primary_image_session"
  ) {
    return receipt.body.status === "completed";
  }
  return false;
}

function callbackHasRemaining(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.remainingWork === true || value.remainingPending === true) return true;
  for (const key of ["continuation", "images", "imageEvidence", "closeSupplements", "bidSupplements"] as const) {
    const nested = value[key];
    if (isRecord(nested) && (nested.remainingWork === true || nested.remainingPending === true)) return true;
  }
  return false;
}

function callbackFailureCode(
  contract: string | null,
  receipt: SchedulerCallbackReceipt,
  sourceId: string | null = null,
): string {
  const continuation = isRecord(receipt.body) && isRecord(receipt.body.continuation)
    ? receipt.body.continuation
    : receipt.body;
  if (
    contract === "source_continuation" && receipt.status === 207 &&
    isRecord(continuation) && continuation.status === "partial"
  ) return "source_continuation_partial";
  if (contract === "source_catalog" && isRecord(receipt.body)) {
    const catalog = isRecord(receipt.body.catalog) ? receipt.body.catalog : receipt.body;
    if (Array.isArray(catalog.sourceErrors)) {
      const hasSourceContractMismatch = catalog.sourceErrors.some((entry) =>
        isRecord(entry) && typeof entry.message === "string" &&
        /(?:^|\b)source contract mismatch(?::|\b)/iu.test(entry.message)
      );
      if (hasSourceContractMismatch) return "source_contract_mismatch";
      const hasCheckpointPause = sourceId !== null &&
        catalog.sourceErrors.some((entry) =>
          isRecord(entry) && entry.sourceId === sourceId &&
          typeof entry.message === "string" &&
          isSourceInventoryTraversalPauseMessage(sourceId, entry.message)
        );
      if (hasCheckpointPause) return "source_checkpoint_unchanged";
      const hasBoundedSourceFailure = sourceId !== null &&
        catalog.sourceErrors.some((entry) =>
          isRecord(entry) && entry.sourceId === sourceId &&
          typeof entry.message === "string" &&
          entry.message.trim().length > 0 && entry.message.length <= 2_000
        );
      if (hasBoundedSourceFailure) return "source_callback_failed";
    }
  }
  if (isRecord(receipt.body) && typeof receipt.body.code === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(receipt.body.code)) {
    if (receipt.body.code === "browser_contract_failed") {
      const upstreamCode = typeof receipt.body.upstreamCode === "string" &&
          /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(receipt.body.upstreamCode)
        ? receipt.body.upstreamCode
        : null;
      const upstreamDiagnostic = typeof receipt.body.upstreamDiagnostic === "string" &&
          /^[A-Za-z][A-Za-z0-9._-]{0,31}$/u.test(receipt.body.upstreamDiagnostic)
        ? receipt.body.upstreamDiagnostic
        : null;
      if (upstreamCode !== null) {
        const detailed = [
          receipt.body.code,
          upstreamCode,
          ...(upstreamDiagnostic === null ? [] : [upstreamDiagnostic]),
        ].join(":");
        if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(detailed)) return detailed;
      }
    }
    return receipt.body.code;
  }
  return receipt.status >= 200 && receipt.status < 300
    ? "scheduler_callback_contract_mismatch"
    : `scheduler_callback_http_${receipt.status}`;
}

function requiredReceipt(value: SchedulerCallbackReceipt | undefined): SchedulerCallbackReceipt {
  if (value === undefined || !Number.isSafeInteger(value.status) ||
      typeof value.responseHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value.responseHash)) {
    throw priorHeadError("scheduler_callback_receipt_invalid");
  }
  return value;
}

function requiredQueueClaim(reservation: SchedulerReservation) {
  if (reservation.queueClaim === null) throw priorHeadError("pipeline_work_claim_missing");
  return reservation.queueClaim;
}

function requiredAcquisitionClaim(reservation: SchedulerReservation) {
  if (reservation.acquisitionClaim === null) {
    throw priorHeadError("source_acquisition_claim_missing");
  }
  return reservation.acquisitionClaim;
}

function requireSourceInput(candidate: SchedulerCandidate): SchedulerSourceInput {
  const value = candidate.sourceInput;
  if (value === undefined ||
      value.coverageMode !== "complete_current" ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.inputHash) || value.expectedGeneration < 1 ||
      value.inputRevision < 1 ||
      !validRecentPublicationSkip(value.recentPublicationSkip)) {
    throw priorHeadError("source_input_invalid");
  }
  return value;
}

function validRecentPublicationSkip(
  value: SchedulerRecentPublicationSkip | null | undefined,
): boolean {
  if (value === undefined || value === null) return true;
  const publishedAt = exactTimestampMilliseconds(value.publishedAt);
  const verifiedAt = exactTimestampMilliseconds(value.verifiedAt);
  return value.reasonCode === "recent_verified_publication" &&
    publishedAt !== null && verifiedAt !== null && publishedAt <= verifiedAt &&
    typeof value.head?.inventoryRunId === "string" &&
    value.head.inventoryRunId.length > 0 && value.head.inventoryRunId.length <= 512 &&
    Number.isSafeInteger(value.head.listingCount) && value.head.listingCount >= 0 &&
    /^sha256:[0-9a-f]{64}$/u.test(value.proofIdentity) &&
    /^sha256:[0-9a-f]{64}$/u.test(value.receiptIdentity);
}

function requireWorkItem(candidate: SchedulerCandidate): PipelineWorkItem {
  if (candidate.workItem === undefined || candidate.kind !== "preparation" ||
      (
        candidate.sourceId === LOCAL_SCHEDULER_SOURCE_ID
          ? candidate.workItem.sourceId !== null &&
            !PROJECTION_STAGE_SET.has(candidate.workItem.stage)
          : candidate.workItem.sourceId !== candidate.sourceId
      ) ||
      candidate.workItem.stage !== candidate.stage) {
    throw priorHeadError("pipeline_work_identity_invalid");
  }
  return candidate.workItem;
}

function requirePolicy(candidate: SchedulerCandidate): SourceOrchestrationPolicy {
  const canonical = SOURCE_POLICY_BY_ID.get(candidate.sourceId as SourceId);
  if (canonical === undefined || candidate.sourcePolicy?.sourceId !== canonical.sourceId) {
    throw priorHeadError("source_policy_invalid");
  }
  return canonical;
}

function assertReservation(candidate: SchedulerCandidate, reservation: SchedulerReservation): void {
  const laneMatches = candidate.sourceId === LOCAL_SCHEDULER_SOURCE_ID &&
      candidate.kind === "preparation"
    ? candidate.workItem?.laneKey === reservation.laneKey
    : candidate.networkLanes.includes(reservation.laneKey);
  if (reservation.candidateId !== candidate.id || reservation.sourceId !== candidate.sourceId ||
      !laneMatches) {
    throw priorHeadError("scheduler_reservation_identity_changed");
  }
  if (candidate.kind !== "preparation") return;
  const item = requireWorkItem(candidate);
  const claim = reservation.queueClaim;
  const expectsClaim = !COMBINED_CALLBACK_STAGE_SET.has(item.stage);
  if (
    reservation.inputRevision !== item.revision ||
    (!expectsClaim && claim !== null) ||
    (expectsClaim && (
      claim === null ||
      claim.stage !== item.stage ||
      claim.subjectType !== item.subjectType ||
      claim.subjectId !== item.subjectId ||
      claim.inputHash !== item.inputHash ||
      claim.revision !== item.revision
    ))
  ) {
    throw priorHeadError("scheduler_reservation_queue_claim_changed");
  }
}

function isCallbackInstruction(value: unknown): value is SchedulerCallbackInstruction {
  if (!isRecord(value) || (value.kind !== "loopback_json" && value.kind !== "local_commit")) return false;
  if (value.kind === "local_commit") return Object.keys(value).length === 1;
  return (value.service === "dashboard" || value.service === "companion") &&
    typeof value.path === "string" && value.path.startsWith("/") && !value.path.includes("?") &&
    (value.body === null || isRecord(value.body)) && Number.isSafeInteger(value.timeoutMs) &&
    Number(value.timeoutMs) > 0 && typeof value.successContract === "string" &&
    (value.executionBoundary === undefined || value.executionBoundary === "commit_fifo" ||
      value.executionBoundary === "acquire_outside_fifo");
}

function mapWorkItem(row: WorkRow): PipelineWorkItem {
  const payload = row.subject_payload_json === null ? null : JSON.parse(row.subject_payload_json) as
    Readonly<Record<string, unknown>> | readonly unknown[];
  return Object.freeze({
    stage: row.stage as PipelineWorkStage,
    subjectType: row.subject_type as PipelineWorkItem["subjectType"],
    subjectId: row.subject_id,
    listingId: row.listing_id,
    sourceId: row.source_id,
    subjectPayload: payload,
    laneKey: row.lane_key,
    inputHash: row.input_hash,
    revision: Number(row.revision),
    priority: Number(row.priority),
    reasonCode: row.reason_code,
    availableAt: row.available_at,
    inputAttemptCount: Number(row.input_attempt_count),
    lifetimeAttemptCount: Number(row.lifetime_attempt_count),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    claimedInputHash: row.claimed_input_hash,
    claimedRevision: row.claimed_revision === null ? null : Number(row.claimed_revision),
    progress: Object.freeze({
      cursor: row.progress_cursor,
      generation: row.progress_generation === null ? null : Number(row.progress_generation),
      rows: Number(row.progress_rows),
    }),
    lastErrorCode: row.last_error_code,
    lastErrorFingerprint: row.last_error_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastClaimedAt: row.last_claimed_at,
    lastCompletedAt: row.last_completed_at,
  });
}

function sourceTiming(policy: SourceOrchestrationPolicy): SchedulerTimingEstimate {
  return Object.freeze({
    remainingRequests: policy.requestBudgetCeiling,
    remainingPages: policy.requestBudgetCeiling,
    pacingFloorMs: policy.documentPacingFloorMs,
    requestEwmaMs: policy.documentPacingFloorMs,
    parseEwmaMs: 0,
    callbackEwmaMs: 0,
    commitEwmaMs: 0,
  });
}

function preparationTiming(item: PipelineWorkItem): SchedulerTimingEstimate {
  return Object.freeze({
    remainingRequests: item.stage === "source_release" ||
        item.stage === "source_acquisition_readiness" ||
        PROJECTION_STAGE_SET.has(item.stage) || item.stage === "preference_v2_score"
      ? 0
      : 1,
    remainingPages: 1,
    pacingFloorMs: 0,
    requestEwmaMs: 0,
    parseEwmaMs: 0,
    callbackEwmaMs: 0,
    commitEwmaMs: 0,
  });
}

function localPreparationCandidate(item: PipelineWorkItem, index: number): SchedulerCandidate {
  return Object.freeze({
    id: `work:${item.stage}:${item.subjectType}:${item.subjectId}`,
    kind: "preparation",
    sourceId: LOCAL_SCHEDULER_SOURCE_ID,
    stage: item.stage,
    // Source-neutral projection work is a local canonical mutation. Its
    // durable lane key remains on the work item/reservation, but it must not
    // consume or require a source network lane.
    networkLanes: Object.freeze([]),
    dependencies: Object.freeze([]),
    dependencyDepth: 0,
    priority: item.priority,
    fairnessQuantum: 1,
    skippedRounds: 0,
    enqueueOrder: sourceOrchestrationRegistry.length + index,
    availableAt: item.availableAt,
    accessState: "ready",
    accessReasonCode: null,
    nextEligibleAt: null,
    leaseExpiresAt: item.leaseExpiresAt,
    inputAttemptCount: item.inputAttemptCount,
    timing: preparationTiming(item),
    workItem: item,
  });
}

function pipelinePhase(stage: PipelineWorkStage): number {
  if (PROJECTION_STAGE_SET.has(stage)) return 0;
  if (stage === "source_acquisition_readiness") return 1;
  if (stage === "proximity") return 2;
  if (
    stage === "detail" || stage === "action_deadline" ||
    stage === "owner_refresh" || stage === "factual_supplement"
  ) return 3;
  if (stage === "image_evidence" || stage === "primary_image") return 4;
  if (stage === "enrichment_text" || stage === "enrichment_embedding") return 5;
  if (stage === "source_release") return 7;
  return 99;
}

function pipelinePhaseSql(column: string): string {
  return `CASE
    WHEN ${column} IN (
      'projection_listing_refresh', 'projection_source_refresh',
      'projection_group_refresh', 'projection_global_refresh'
    ) THEN 0
    WHEN ${column} = 'source_acquisition_readiness' THEN 1
    WHEN ${column} = 'proximity' THEN 2
    WHEN ${column} IN ('detail', 'action_deadline', 'owner_refresh', 'factual_supplement') THEN 3
    WHEN ${column} IN ('image_evidence', 'primary_image') THEN 4
    WHEN ${column} IN ('enrichment_text', 'enrichment_embedding') THEN 5
    WHEN ${column} = 'preference_v2_score' THEN 6
    WHEN ${column} = 'source_release' THEN 7
    ELSE 99 END`;
}

function priorHeadError(reasonCode: string): Error & {
  readonly reasonCode: string;
  readonly priorHeadPreserved: true;
} {
  return Object.assign(new Error(reasonCode), { reasonCode, priorHeadPreserved: true as const });
}

function stateAmbiguousError(reasonCode: string): Error & {
  readonly reasonCode: string;
  readonly stateAmbiguous: true;
} {
  return Object.assign(new Error(reasonCode), {
    reasonCode,
    stateAmbiguous: true as const,
  });
}

function isStateAmbiguousError(
  error: unknown,
): error is Error & { readonly reasonCode: string; readonly stateAmbiguous: true } {
  return error !== null && typeof error === "object" &&
    "stateAmbiguous" in error && error.stateAmbiguous === true &&
    "reasonCode" in error && typeof error.reasonCode === "string";
}

async function schedulerTraversalEvidence(
  rows: readonly SchedulerTraversalEvidenceRow[],
): Promise<ReadonlyMap<string, SchedulerSourceCheckpointEvidence>> {
  const grouped = new Map<string, {
    traversalId: string;
    fingerprint: string;
    expectedPages: number;
    expectedListings: number;
    pageKeys: Set<string>;
    completedPageKeys: string[];
  }>();
  for (const row of rows) {
    if (!SOURCE_POLICY_BY_ID.has(row.source_id as SourceId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(row.traversal_id) ||
        !Number.isSafeInteger(Number(row.expected_pages)) || Number(row.expected_pages) < 1 ||
        Number(row.expected_pages) > 100_000 ||
        !Number.isSafeInteger(Number(row.expected_listings)) || Number(row.expected_listings) < 0 ||
        Number(row.expected_listings) > 1_000_000) {
      throw new RangeError("scheduler traversal evidence is invalid");
    }
    let group = grouped.get(row.source_id);
    if (group === undefined) {
      group = {
        traversalId: row.traversal_id,
        fingerprint: row.fingerprint,
        expectedPages: Number(row.expected_pages),
        expectedListings: Number(row.expected_listings),
        pageKeys: new Set(),
        completedPageKeys: [],
      };
      grouped.set(row.source_id, group);
    } else if (
      group.traversalId !== row.traversal_id || group.fingerprint !== row.fingerprint ||
      group.expectedPages !== Number(row.expected_pages) ||
      group.expectedListings !== Number(row.expected_listings)
    ) {
      throw new RangeError("scheduler source has contradictory traversal evidence");
    }
    if (
      typeof row.page_key !== "string" || row.page_key.length < 1 ||
      row.page_key.length > MAX_TRAVERSAL_PAGE_KEY_LENGTH ||
      row.page_key.trim() !== row.page_key ||
      /[\u0000-\u001f\u007f]/u.test(row.page_key) ||
      group.pageKeys.has(row.page_key)
    ) {
      throw new RangeError("scheduler traversal page evidence is invalid");
    }
    group.pageKeys.add(row.page_key);
    if (row.completed_at !== null) group.completedPageKeys.push(row.page_key);
  }
  const result = new Map<string, SchedulerSourceCheckpointEvidence>();
  for (const [sourceId, group] of grouped) {
    if (group.pageKeys.size !== group.expectedPages ||
        group.completedPageKeys.length > group.expectedPages) {
      throw new RangeError("scheduler traversal cardinality evidence is invalid");
    }
    const completedCheckpointHashes = await Promise.all(
      group.completedPageKeys.map((pageKey) =>
        hashCanonicalJson({ sourceId, traversalId: group.traversalId, pageKey })
      ),
    );
    completedCheckpointHashes.sort();
    result.set(sourceId, Object.freeze({
      traversalId: group.traversalId,
      contractHash: await hashCanonicalJson({
        sourceId,
        fingerprint: group.fingerprint,
        expectedPages: group.expectedPages,
        expectedListings: group.expectedListings,
      }),
      expectedPages: group.expectedPages,
      completedCheckpointHashes: Object.freeze(completedCheckpointHashes),
    }));
  }
  return result;
}

async function readSchedulerTraversalEvidence(
  database: D1Database,
  sourceId: string,
): Promise<SchedulerSourceCheckpointEvidence | null> {
  if (!SOURCE_POLICY_BY_ID.has(sourceId as SourceId)) {
    throw new RangeError("scheduler traversal source is invalid");
  }
  const rows = await database.prepare(`
    SELECT traversal.source_id, traversal.traversal_id, traversal.fingerprint,
      traversal.expected_pages, traversal.expected_listings,
      page.page_key, page.completed_at
    FROM source_inventory_traversals traversal
    LEFT JOIN source_inventory_traversal_pages page
      ON page.traversal_id = traversal.traversal_id
    WHERE traversal.source_id = ?
    ORDER BY page.page_key
  `).bind(sourceId).all<SchedulerTraversalEvidenceRow>();
  return (await schedulerTraversalEvidence(rows.results ?? [])).get(sourceId) ?? null;
}

function compareSchedulerCheckpointEvidence(
  prior: SchedulerSourceCheckpointEvidence | null,
  resulting: SchedulerSourceCheckpointEvidence | null,
): "advanced" | "replanned" | "same" | "regressed" {
  if (prior === null) {
    return resulting !== null && resulting.completedCheckpointHashes.length > 0
      ? "advanced"
      : "same";
  }
  if (resulting === null) return "regressed";
  if (
    prior.traversalId !== resulting.traversalId ||
    prior.contractHash !== resulting.contractHash ||
    prior.expectedPages !== resulting.expectedPages
  ) {
    return resulting.completedCheckpointHashes.length > 0 ? "replanned" : "same";
  }
  const resultingHashes = new Set(resulting.completedCheckpointHashes);
  if (prior.completedCheckpointHashes.some((hash) => !resultingHashes.has(hash))) {
    return "regressed";
  }
  return resulting.completedCheckpointHashes.length > prior.completedCheckpointHashes.length
    ? "advanced"
    : "same";
}

function changes(result: D1Result | undefined): number {
  return Math.max(0, Number(result?.meta.changes ?? 0));
}

function numeric(value: unknown): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("scheduler count is invalid");
  return result;
}

function integer(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be ${minimum}..${maximum}`);
  }
  return value;
}

function code(value: string, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)) throw new RangeError(`${label} is invalid`);
  return value;
}

function exactTimestampMilliseconds(value: string | null): number | null {
  if (value === null) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new RangeError(`${label} is invalid`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
