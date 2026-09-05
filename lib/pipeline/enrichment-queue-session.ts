import type {
  AiProviders,
  EmbeddingProvider,
  GenerationUsage,
  TextGenerationProvider,
} from "../ai";
import {
  isAiProviderError,
  isRetainableAiInvalidResponseText,
} from "../ai";
import { sha256Text } from "../ai/provenance";
import { getConfig } from "../config";
import {
  locationEvidenceSources,
  type LocationCandidate,
  type LocationEvidenceSource,
  type NormalizedListingDetail,
} from "../domain/listings";
import {
  boundedEnrichmentChunks,
  boundedEnrichmentLimit,
  drainEnrichmentSessionResidency,
  throwIfEnrichmentCancelled,
  type EnrichmentFailureClassification,
  type EnrichmentSessionSummary,
} from "../enrichment/backlog";
import {
  verifyTextGenerationCapacity,
  type GenerationCapacityEvidence,
  type VerifiedTextGenerationCapacity,
} from "../enrichment/generation-capacity";
import { enrichmentSessionProvenanceTarget } from "../enrichment/target";
import {
  fileEnrichmentStagedGenerationStore,
  type EnrichmentEmbeddingStageBinding,
  type EnrichmentStageBinding,
  type EnrichmentStagedGenerationStore,
  type EnrichmentStageTargetIdentity,
  type StagedEnrichmentEmbeddingResult,
} from "../enrichment/staged-generation";
import {
  hashCanonicalJson,
  readCompactPipelineGenerationVector,
  type PipelineGenerationVector,
} from "../performance/generations";
import type {
  PerformanceTelemetryContext,
  PerformanceTelemetrySink,
} from "../performance/telemetry";
import {
  appendIdempotentPipelineAuditReceipt,
  ENRICHMENT_SESSION_CONTRACT_EVIDENCE_DERIVATION_VERSION,
  ENRICHMENT_SESSION_CONTRACT_EVIDENCE_FEATURE,
  ENRICHMENT_SESSION_EXECUTION_EVIDENCE_DERIVATION_VERSION,
  ENRICHMENT_SESSION_EXECUTION_EVIDENCE_FEATURE,
} from "../performance/readiness";
import {
  ENRICHMENT_SESSION_RESIDENCY_READINESS_DERIVATION_VERSION,
} from "../performance/component-readiness";
export {
  ENRICHMENT_SESSION_CONTRACT_EVIDENCE_DERIVATION_VERSION,
  ENRICHMENT_SESSION_CONTRACT_EVIDENCE_FEATURE,
  ENRICHMENT_SESSION_EXECUTION_EVIDENCE_DERIVATION_VERSION,
  ENRICHMENT_SESSION_EXECUTION_EVIDENCE_FEATURE,
} from "../performance/readiness";
import { locationCacheKey } from "../routing/helpers";
import {
  embedPreparedListingEnrichments,
  prepareListingEnrichment,
  readPreparedListingEnrichmentFromHead,
  type PendingEnrichmentArtifact,
  type PendingEnrichmentEmbedding,
  type PreparedListingEnrichment,
} from "./enrich";
import {
  prepareEnrichmentEmbeddingQueueCoalesceStatement,
  prepareListingEnrichmentHeadInitialization,
  prepareListingEnrichmentTerminal,
  prepareListingEnrichmentTextTransition,
  readListingEnrichmentHead,
  type EnrichmentProvenanceTarget,
  type ListingEnrichmentHead,
} from "./enrichment-heads";
import { prepareCanonicalMutationPayloadInvalidationStatements } from "./mutation-invalidation";
import {
  completePipelineWorkClaim,
  deferPipelineWorkClaim,
  failPipelineWorkClaim,
  type PipelineWorkClaimIdentity,
} from "./work-queue";

const ENRICHMENT_HEAD_INVALIDATION_VERSION =
  "enrichment-head-canonical-invalidation-v1";
export const ENRICHMENT_QUEUE_SESSION_DERIVATION_VERSION =
  ENRICHMENT_SESSION_RESIDENCY_READINESS_DERIVATION_VERSION;
const TEXT_STAGE_KEEP_ALIVE_SECONDS = 60;
const PROVIDER_CLEANUP_TIMEOUT_MS = 30_000;
const MAX_SESSION_ITEMS = 100;
// Two fixed route bindings share D1's 100-variable statement ceiling with the
// listing ids. Retain headroom so this read can evolve without crossing it.
const CANDIDATE_LOAD_BATCH_SIZE = 75;
const RETRY_DELAY_MS = 30_000;
const CANCELLATION_SETTLEMENT_ATTEMPTS = 3;
const LOAD_FAILURE_SETTLEMENT_ATTEMPTS = 3;

const EXACT_CURRENT_ENRICHMENT_WORK_CTE_SQL = `
  active_route (origin_cache_key, provider_name) AS (VALUES (?, ?)),
  eligible_work AS (
    SELECT
      work.stage, work.subject_id, work.listing_id, work.source_id,
      work.input_hash, work.revision, work.available_at, work.priority,
      work.updated_at, work.lease_owner, work.lease_expires_at
    FROM pipeline_work_items work
    JOIN listing_current_pipeline_state pipeline
      ON pipeline.listing_id = work.listing_id
      AND pipeline.source_id = work.source_id
    JOIN listing_details detail ON detail.listing_id = pipeline.listing_id
    JOIN listing_detail_observations observation
      ON observation.listing_id = pipeline.listing_id
      AND observation.detail_content_hash = detail.content_hash
    JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = pipeline.listing_id
      AND current_inventory.source_id = pipeline.source_id
      AND current_inventory.inventory_run_id = pipeline.active_inventory_run_id
      AND current_inventory.review_candidate = 1
    JOIN source_inventory_publication_heads publication_head
      ON publication_head.source_id = pipeline.source_id
      AND publication_head.inventory_run_id = pipeline.active_inventory_run_id
    JOIN listing_routes route_assignment
      ON route_assignment.listing_id = pipeline.listing_id
      AND route_assignment.route_cache_id = pipeline.route_cache_identity
    JOIN route_cache accepted_route
      ON accepted_route.id = route_assignment.route_cache_id
      AND accepted_route.input_hash = pipeline.route_input_hash
      AND accepted_route.error_code IS NULL
      AND accepted_route.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
    JOIN active_route
      ON active_route.origin_cache_key = accepted_route.origin_cache_key
      AND active_route.provider_name = accepted_route.provider_name
    WHERE work.stage IN ('enrichment_embedding', 'enrichment_text')
      AND work.subject_type = 'listing'
      AND work.subject_id = pipeline.listing_id
      AND pipeline.source_current = 1 AND pipeline.review_candidate = 1
      AND pipeline.active_inventory_run_id IS NOT NULL
      AND pipeline.source_publication_generation IS NOT NULL
      AND pipeline.accepted_detail_identity IS NOT NULL
      AND pipeline.accepted_detail_hash = detail.content_hash
      AND pipeline.route_cache_identity IS NOT NULL
      AND pipeline.route_assignment_identity IS NOT NULL
      AND pipeline.route_input_hash IS NOT NULL
      AND work.revision >= 1
      AND (
        (
          work.stage = 'enrichment_text'
          AND work.input_hash = pipeline.enrichment_input_hash
          AND work.input_hash = pipeline.enrichment_text_work_input_hash
        ) OR (
          work.stage = 'enrichment_embedding'
          AND (
            work.input_hash = pipeline.enrichment_embedding_work_input_hash
            OR EXISTS (
              SELECT 1 FROM pipeline_work_items projection_refresh
              WHERE projection_refresh.stage = 'projection_listing_refresh'
                AND projection_refresh.subject_type = 'listing'
                AND projection_refresh.subject_id = pipeline.listing_id
                AND projection_refresh.listing_id = pipeline.listing_id
                AND projection_refresh.source_id = pipeline.source_id
                AND projection_refresh.reason_code = 'enrichment_head_changed'
            )
          )
          AND EXISTS (
            SELECT 1 FROM listing_enrichment_heads enrichment_head
            WHERE enrichment_head.listing_id = pipeline.listing_id
              AND enrichment_head.state IN ('text_ready', 'pending_embedding')
          )
        )
      )
  )`;

type EnrichmentQueueStage = "enrichment_text" | "enrichment_embedding";

interface ClaimedEnrichmentWork {
  readonly stage: EnrichmentQueueStage;
  readonly listingId: string;
  readonly sourceId: string;
  readonly inputHash: string;
  readonly revision: number;
  readonly claim: PipelineWorkClaimIdentity;
}

interface EnrichmentSessionCandidate extends ClaimedEnrichmentWork {
  readonly detail: NormalizedListingDetail;
  readonly projectionEnrichmentInputHash: string;
  readonly upstream: CandidateUpstreamIdentity;
  readonly upstreamInputHash: string;
  head: ListingEnrichmentHead;
  activeClaim: PipelineWorkClaimIdentity | null;
  pendingHeadInitialization: Awaited<ReturnType<
    typeof prepareListingEnrichmentHeadInitialization
  >> | null;
  generationBoundary: ListingGenerationBoundary | null;
  generationBoundaryHash: string | null;
}

interface CandidateRow {
  listing_id: string;
  source_id: string;
  enrichment_input_hash: string | null;
  enrichment_head_identity: string | null;
  enrichment_text_work_input_hash: string | null;
  enrichment_embedding_work_input_hash: string | null;
  active_inventory_run_id: string;
  source_publication_generation: number;
  accepted_detail_identity: string;
  accepted_detail_hash: string;
  route_cache_identity: string;
  route_assignment_identity: string;
  route_input_hash: string;
  origin_cache_key: string;
  route_provider_name: string;
  source_listing_id: string;
  source_url: string;
  title_at_scrape: string;
  category_at_scrape: string | null;
  lot_number_at_scrape: string | null;
  raw_description: string;
  clean_description: string;
  price_amount_minor: number | null;
  price_currency: string | null;
  price_display_text: string | null;
  auction_ends_at: string | null;
  seller: string | null;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_postal_code: string | null;
  pickup_country_code: string | null;
  pickup_evidence_source: string | null;
  scraped_at: string;
  content_hash: string;
}

interface CandidateUpstreamIdentity {
  readonly listingId: string;
  readonly sourceId: string;
  readonly activeInventoryRunId: string;
  readonly sourcePublicationGeneration: number;
  readonly acceptedDetailIdentity: string;
  readonly acceptedDetailHash: string;
  readonly detailContentHash: string;
  readonly routeCacheIdentity: string;
  readonly routeAssignmentIdentity: string;
  readonly routeInputHash: string;
  readonly originCacheKey: string;
  readonly routeProviderName: string;
}

interface EnrichmentRouteIdentity {
  readonly originCacheKey: string;
  readonly providerName: string;
}

interface ListingGenerationBoundary {
  readonly generation: number | null;
  readonly fingerprint: string | null;
  readonly derivationVersion: string | null;
  readonly hash: string;
}

interface QueueSelectionRow {
  queue_total: number;
  stage: EnrichmentQueueStage | null;
  subject_id: string | null;
  listing_id: string | null;
  source_id: string | null;
  input_hash: string | null;
  revision: number | null;
}

interface ExactQueueSelection {
  readonly total: number;
  readonly rows: readonly ExactQueueSelectionRow[];
}

interface ExactQueueSelectionRow {
  readonly stage: EnrichmentQueueStage;
  readonly subject_id: string;
  readonly listing_id: string;
  readonly source_id: string;
  readonly input_hash: string;
  readonly revision: number;
}

interface LoadedSessionCandidate extends ClaimedEnrichmentWork {
  readonly detail: NormalizedListingDetail;
  readonly projectionEnrichmentInputHash: string;
  readonly upstream: CandidateUpstreamIdentity;
  readonly upstreamInputHash: string;
  readonly detailProjection: {
    readonly enrichmentHeadIdentity: string | null;
    readonly enrichmentTextWorkInputHash: string | null;
    readonly enrichmentEmbeddingWorkInputHash: string | null;
  };
}

interface SuppliedClaimQueueRow {
  readonly stage: EnrichmentQueueStage;
  readonly subject_type: "listing";
  readonly subject_id: string;
  readonly listing_id: string | null;
  readonly source_id: string | null;
  readonly input_hash: string;
  readonly revision: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly claimed_input_hash: string | null;
  readonly claimed_revision: number | null;
}

export type SuppliedEnrichmentClaimOutcome =
  | "completed"
  | "stale_or_obsolete"
  | "failed_or_deferred"
  | "still_pending";

export interface SuppliedEnrichmentClaimResult {
  readonly claim: PipelineWorkClaimIdentity;
  readonly outcome: SuppliedEnrichmentClaimOutcome;
}

export interface EnrichmentQueueWorkSummary {
  readonly scope: "enrichment_text+enrichment_embedding";
  readonly queued: number;
  readonly claimed: number;
  readonly completed: number;
  readonly stale: number;
  readonly remaining: number;
  readonly remainingWork: boolean;
  readonly suppliedClaim: SuppliedEnrichmentClaimResult | null;
}

export interface QueueBackedEnrichmentSessionSummary
  extends EnrichmentSessionSummary {
  readonly remainingWork: boolean;
  readonly work: EnrichmentQueueWorkSummary;
  readonly diagnostics: EnrichmentSessionDiagnostics;
}

export type EnrichmentCapacityEvidence =
  | GenerationCapacityEvidence
  | "not_probed_no_provider_work";

/**
 * Bounded, secret-free execution evidence. Timings are wall-clock unions:
 * parallel workers open one phase interval and close it when the last worker
 * leaves, so two overlapping calls are never double-counted.
 */
export interface EnrichmentSessionDiagnostics {
  readonly configuredGenerationConcurrency: 1 | 2;
  readonly verifiedGenerationConcurrency: 1 | 2;
  readonly effectiveGenerationConcurrency: 1 | 2;
  readonly capacityEvidence: EnrichmentCapacityEvidence;
  readonly providerSlots: number | null;
  readonly maximumConcurrentGenerations: number;
  readonly maximumConcurrentMutations: number;
  /** Queue/current-input assembly before an actual provider request. */
  readonly inputPreparationElapsedMs: number;
  /** Exact text and embedding provider-call wall-clock union. */
  readonly modelGenerationElapsedMs: number;
  /** Provider-output normalization plus sealed-stage integrity reads. */
  readonly validationElapsedMs: number;
  /** Transactional text/embedding publication callbacks, excluding lease wait. */
  readonly serializedCommitElapsedMs: number;
  /** Text or embedding output rows generated by a provider in this session. */
  readonly newlyGeneratedRows: number;
  /** Exact immutable text or embedding rows reused without a provider call. */
  readonly immutableRowsReused: number;
  /** Exact sealed text or embedding rows reused after a prior interruption. */
  readonly stagedPayloadRowsReused: number;
  readonly staleRows: number;
  readonly failedRows: number;
  readonly terminalRows: number;
  /** Text plus embedding rows published through serialized transactions. */
  readonly committedRows: number;
}

export interface QueueBackedEnrichmentSessionOptions {
  readonly database: D1Database;
  readonly owner: string;
  readonly providers: AiProviders;
  /** Exact active route tuple admitted for every selected/current listing. */
  readonly originCacheKey?: string;
  readonly routeProviderName?: string;
  readonly requestedLimit: number;
  readonly requestedChunks: number;
  readonly suppliedClaim?: PipelineWorkClaimIdentity;
  readonly preparationConcurrency?: number;
  readonly signal?: AbortSignal;
  readonly stagingRoot?: string;
  /** Host-capable immutable stage adapter; required by filesystem-less runtimes. */
  readonly stagedGenerationStore?: EnrichmentStagedGenerationStore;
  /** Focused crash-boundary seam after atomic local staging and before commit. */
  readonly afterGenerationStaged?: (listingId: string) => Promise<void>;
  /** Focused crash-boundary seam after atomic embedding staging and before commit. */
  readonly afterEmbeddingGenerationStaged?: (
    listingIds: readonly string[],
  ) => Promise<void>;
  readonly leaseMs: number;
  readonly embeddingDimensions?: number;
  readonly renewPipelineLease?: () => Promise<unknown>;
  /** Drops the singleton writer lease before any provider call. */
  readonly suspendMutationLease?: () => Promise<void>;
  /** Reacquires and releases the singleton writer lease around one publication. */
  readonly withMutationLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Cleanup lane ignores an already-aborted work signal but remains bounded. */
  readonly withCleanupMutationLease?: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly beforeTerminalRead?: () => Promise<void>;
  readonly now?: () => Date;
  /** Explicit benchmark/debug capture only. */
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
  /** Safe identity/hash-only seam for exact read/claim equivalence tests. */
  readonly onSelectionFingerprint?: (
    fingerprint: EnrichmentQueueSelectionFingerprint,
  ) => void;
}

export interface EnrichmentQueueSelectionFingerprint {
  readonly selectedCount: number;
  readonly aggregateHash: string;
  readonly orderedSelectionHash: string;
  readonly inputHash: string;
  readonly projectionTargetHash: string;
  readonly targetIdentity: string;
  readonly listingGenerationHash: string;
  readonly generationVectorHash: string;
}

export { enrichmentSessionProvenanceTarget } from "../enrichment/target";

interface WallClockUnion {
  begin(): () => void;
  elapsedMs(): number;
}

interface MutableEnrichmentDiagnostics {
  capacity: Readonly<{
    configuredConcurrency: 1 | 2;
    verifiedProviderCapacity: 1 | 2;
    effectiveConcurrency: 1 | 2;
    providerSlots: number | null;
    evidence: EnrichmentCapacityEvidence;
  }>;
  readonly inputPreparation: WallClockUnion;
  readonly modelGeneration: WallClockUnion;
  readonly validation: WallClockUnion;
  readonly serializedCommit: WallClockUnion;
  activeGenerations: number;
  maximumConcurrentGenerations: number;
  activeMutations: number;
  maximumConcurrentMutations: number;
  newlyGeneratedRows: number;
  immutableRowsReused: number;
  stagedPayloadRowsReused: number;
  staleRows: number;
  failedRows: number;
  terminalRows: number;
  committedRows: number;
}

function configuredGenerationConcurrency(value: number | undefined): 1 | 2 {
  const configured = value ?? 1;
  if (configured !== 1 && configured !== 2) {
    throw new RangeError("text preparation concurrency must be exactly 1 or 2");
  }
  return configured;
}

function createWallClockUnion(): WallClockUnion {
  let active = 0;
  let intervalStartedAt = 0;
  let totalMs = 0;
  return Object.freeze({
    begin: () => {
      if (active === 0) intervalStartedAt = performance.now();
      active += 1;
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        active -= 1;
        if (active === 0) {
          totalMs += Math.max(0, performance.now() - intervalStartedAt);
        }
      };
    },
    elapsedMs: () => {
      const liveMs = active === 0
        ? 0
        : Math.max(0, performance.now() - intervalStartedAt);
      return boundedDiagnosticNumber(totalMs + liveMs);
    },
  });
}

function createEnrichmentDiagnostics(
  configuredConcurrency: 1 | 2,
): MutableEnrichmentDiagnostics {
  return {
    capacity: Object.freeze({
      configuredConcurrency,
      verifiedProviderCapacity: 1,
      effectiveConcurrency: 1,
      providerSlots: null,
      evidence: "not_probed_no_provider_work" as const,
    }),
    inputPreparation: createWallClockUnion(),
    modelGeneration: createWallClockUnion(),
    validation: createWallClockUnion(),
    serializedCommit: createWallClockUnion(),
    activeGenerations: 0,
    maximumConcurrentGenerations: 0,
    activeMutations: 0,
    maximumConcurrentMutations: 0,
    newlyGeneratedRows: 0,
    immutableRowsReused: 0,
    stagedPayloadRowsReused: 0,
    staleRows: 0,
    failedRows: 0,
    terminalRows: 0,
    committedRows: 0,
  };
}

function setVerifiedCapacity(
  diagnostics: MutableEnrichmentDiagnostics,
  capacity: VerifiedTextGenerationCapacity,
): void {
  diagnostics.capacity = Object.freeze(capacity);
}

function beginProviderGeneration(
  diagnostics: MutableEnrichmentDiagnostics,
): () => void {
  if (diagnostics.activeMutations !== 0) {
    throw new Error("enrichment_generation_overlapped_mutation");
  }
  diagnostics.activeGenerations += 1;
  diagnostics.maximumConcurrentGenerations = Math.max(
    diagnostics.maximumConcurrentGenerations,
    diagnostics.activeGenerations,
  );
  const finishClock = diagnostics.modelGeneration.begin();
  let settled = false;
  return () => {
    if (settled) return;
    settled = true;
    finishClock();
    diagnostics.activeGenerations -= 1;
  };
}

async function runTrackedMutation<T>(input: {
  readonly diagnostics: MutableEnrichmentDiagnostics;
  readonly withLease: <R>(operation: () => Promise<R>) => Promise<R>;
  readonly publicationRows?: number;
  readonly operation: () => Promise<T>;
}): Promise<T> {
  return input.withLease(async () => {
    if (input.diagnostics.activeGenerations !== 0) {
      throw new Error("enrichment_mutation_overlapped_generation");
    }
    if (input.diagnostics.activeMutations !== 0) {
      throw new Error("enrichment_concurrent_mutation_detected");
    }
    input.diagnostics.activeMutations = 1;
    input.diagnostics.maximumConcurrentMutations = Math.max(
      input.diagnostics.maximumConcurrentMutations,
      1,
    );
    const finishCommit = input.publicationRows === undefined
      ? null
      : input.diagnostics.serializedCommit.begin();
    try {
      const result = await input.operation();
      if (input.publicationRows !== undefined) {
        input.diagnostics.committedRows += input.publicationRows;
      }
      return result;
    } finally {
      finishCommit?.();
      input.diagnostics.activeMutations = 0;
    }
  });
}

function enrichmentDiagnosticsSnapshot(
  diagnostics: MutableEnrichmentDiagnostics,
): EnrichmentSessionDiagnostics {
  return Object.freeze({
    configuredGenerationConcurrency:
      diagnostics.capacity.configuredConcurrency,
    verifiedGenerationConcurrency:
      diagnostics.capacity.verifiedProviderCapacity,
    effectiveGenerationConcurrency:
      diagnostics.capacity.effectiveConcurrency,
    capacityEvidence: diagnostics.capacity.evidence,
    providerSlots: diagnostics.capacity.providerSlots,
    maximumConcurrentGenerations: requiredDiagnosticCount(
      diagnostics.maximumConcurrentGenerations,
    ),
    maximumConcurrentMutations: requiredDiagnosticCount(
      diagnostics.maximumConcurrentMutations,
    ),
    inputPreparationElapsedMs: diagnostics.inputPreparation.elapsedMs(),
    modelGenerationElapsedMs: diagnostics.modelGeneration.elapsedMs(),
    validationElapsedMs: diagnostics.validation.elapsedMs(),
    serializedCommitElapsedMs: diagnostics.serializedCommit.elapsedMs(),
    newlyGeneratedRows: requiredDiagnosticCount(diagnostics.newlyGeneratedRows),
    immutableRowsReused: requiredDiagnosticCount(diagnostics.immutableRowsReused),
    stagedPayloadRowsReused: requiredDiagnosticCount(
      diagnostics.stagedPayloadRowsReused,
    ),
    staleRows: requiredDiagnosticCount(diagnostics.staleRows),
    failedRows: requiredDiagnosticCount(diagnostics.failedRows),
    terminalRows: requiredDiagnosticCount(diagnostics.terminalRows),
    committedRows: requiredDiagnosticCount(diagnostics.committedRows),
  });
}

function requiredDiagnosticCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SESSION_ITEMS * 2) {
    throw new RangeError("enrichment session diagnostic count is invalid");
  }
  return value;
}

function boundedDiagnosticNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
}

function settleDiagnosticInterval(finish: (() => void) | null): void {
  if (finish !== null) finish();
}

/**
 * Production enrichment path: one exact queue claim, one text residency, then
 * one embedding residency. The broad canonical selector remains outside this
 * helper as the explicit audit/rollback path.
 */
export async function runQueueBackedEnrichmentSession(
  options: QueueBackedEnrichmentSessionOptions,
): Promise<QueueBackedEnrichmentSessionSummary> {
  const diagnostics = createEnrichmentDiagnostics(
    configuredGenerationConcurrency(options.preparationConcurrency),
  );
  const telemetryStartedAt = performance.now();
  options.telemetry?.record({
    context: options.telemetryContext,
    details: {
      kind: "stage",
      stage: "enrichment_queue_session",
      outcome: "started",
    },
  });
  const effectiveLimit = boundedEnrichmentLimit(options.requestedLimit);
  const effectiveChunks = boundedEnrichmentChunks(options.requestedChunks);
  const capacity = Math.min(
    MAX_SESSION_ITEMS,
    effectiveLimit * effectiveChunks,
  );
  if (capacity < 1) {
    throw new RangeError("enrichment queue session capacity must be positive");
  }
  const now = options.now ?? (() => new Date());
  const stagedGenerationStore = options.stagedGenerationStore ??
    fileEnrichmentStagedGenerationStore(options.stagingRoot);
  const routeIdentity = await resolveEnrichmentRouteIdentity({
    database: options.database,
    originCacheKey: options.originCacheKey,
    routeProviderName: options.routeProviderName,
  });
  const target = await enrichmentSessionProvenanceTarget(
    options.providers,
    options.embeddingDimensions,
  );
  const supplied = options.suppliedClaim === undefined
    ? null
    : await inspectSuppliedEnrichmentClaim({
        database: options.database,
        claim: options.suppliedClaim,
        now: now(),
        telemetry: options.telemetry,
        telemetryContext: options.telemetryContext,
      });
  const selection = await claimEnrichmentSessionWork({
    database: options.database,
    owner: options.owner,
    limit: capacity - (supplied === null || supplied.work === null ? 0 : 1),
    leaseMs: options.leaseMs,
    routeIdentity,
    now: now(),
    suppliedClaim: options.suppliedClaim,
    telemetry: options.telemetry,
    telemetryContext: options.telemetryContext,
  });
  const claims = Object.freeze([
    ...(supplied?.work === null || supplied === null ? [] : [supplied.work]),
    ...selection.claims,
  ]);
  const claimedCount = claims.length + (supplied?.countedStaleClaim ? 1 : 0);
  let suppliedClaimOutcome = supplied?.outcome ?? null;
  let staleCount = supplied?.staleCount ?? 0;
  diagnostics.staleRows = staleCount;
  if (selection.total === 0 && claims.length === 0) {
    const summary = queueBackedSummary({
      summary: emptyQueueSummary(options.requestedLimit, options.requestedChunks),
      queued: 0,
      claimed: claimedCount,
      stale: staleCount,
      suppliedClaim: suppliedClaimOutcome,
      diagnostics: enrichmentDiagnosticsSnapshot(diagnostics),
    });
    recordEnrichmentModelTelemetry(options, emptyModelMeasurements());
    recordEnrichmentStageTelemetry(
      options,
      telemetryStartedAt,
      "skipped",
      "clean_empty",
    );
    return summary;
  }
  if (claims.length === 0) {
    const summary = queueBackedSummary({
      summary: pendingQueueSummary(
        options.requestedLimit,
        options.requestedChunks,
        selection.total,
      ),
      queued: selection.total,
      claimed: claimedCount,
      stale: staleCount,
      suppliedClaim: suppliedClaimOutcome,
      diagnostics: enrichmentDiagnosticsSnapshot(diagnostics),
    });
    recordEnrichmentModelTelemetry(options, emptyModelMeasurements());
    recordEnrichmentStageTelemetry(
      options,
      telemetryStartedAt,
      "skipped",
      "no_ready_claim",
    );
    return summary;
  }

  let loaded: Awaited<ReturnType<typeof loadSessionCandidates>>;
  try {
    loaded = await loadSessionCandidates({
      database: options.database,
      claims,
      routeIdentity,
    });
  } catch (error) {
    try {
      await releaseSessionClaimsAfterLoadFailure({
        database: options.database,
        claims: claims.map((claim) => claim.claim),
        now: now(),
        telemetry: options.telemetry,
        telemetryContext: options.telemetryContext,
      });
    } catch (settlementError) {
      throw new AggregateError(
        [error, settlementError],
        "enrichment candidate loading and exact claim release both failed",
      );
    }
    throw error;
  }
  if (options.onSelectionFingerprint !== undefined && selection.rows.length > 0) {
    const selectedIds = new Set(selection.rows.map((row) => row.listing_id));
    options.onSelectionFingerprint(await enrichmentSelectionFingerprint({
      database: options.database,
      selection: selection.rows,
      loaded: loaded.candidates.filter((candidate) =>
        selectedIds.has(candidate.listingId)
      ),
      targetIdentity: target.identity,
    }));
  }
  const staleClaims: PipelineWorkClaimIdentity[] = [
    ...loaded.unavailableClaims,
  ];
  const candidates: EnrichmentSessionCandidate[] = [];
  for (const candidate of loaded.candidates) {
    if (
      candidate.stage === "enrichment_text" &&
      candidate.detailProjection.enrichmentTextWorkInputHash !== candidate.inputHash
    ) {
      staleClaims.push(candidate.claim);
      continue;
    }
    let head = await readListingEnrichmentHead(options.database, candidate.listingId);
    let pendingHeadInitialization: EnrichmentSessionCandidate[
      "pendingHeadInitialization"
    ] = null;
    if (candidate.stage === "enrichment_text") {
      if (candidate.projectionEnrichmentInputHash !== candidate.inputHash) {
        staleClaims.push(candidate.claim);
        continue;
      }
      const initialization = await prepareListingEnrichmentHeadInitialization({
        database: options.database,
        listingId: candidate.listingId,
        target,
        enrichmentInputHash: candidate.inputHash,
        now: now(),
      });
      head = initialization.resultingHead;
      pendingHeadInitialization = initialization;
    } else {
      const exactHead = head !== null &&
        head.provenanceTargetIdentity === target.identity &&
        head.enrichmentInputHash === candidate.projectionEnrichmentInputHash &&
        ["text_ready", "pending_embedding"].includes(head.state);
      const expectedEmbeddingHash = exactHead
        ? await hashCanonicalJson({
            enrichmentInputHash: head!.enrichmentInputHash,
            headIdentity: head!.headIdentity,
            headState: "pending_embedding",
          })
        : null;
      const projected = exactHead &&
        candidate.detailProjection.enrichmentHeadIdentity === head!.headIdentity &&
        candidate.detailProjection.enrichmentEmbeddingWorkInputHash === candidate.inputHash;
      const durablyPendingProjection = exactHead &&
        expectedEmbeddingHash === candidate.inputHash &&
        await hasPendingEnrichmentProjectionRefresh(
          options.database,
          candidate.listingId,
          candidate.sourceId,
        );
      if (!projected && !durablyPendingProjection) {
        staleClaims.push(candidate.claim);
        continue;
      }
    }
    candidates.push({
      stage: candidate.stage,
      listingId: candidate.listingId,
      sourceId: candidate.sourceId,
      inputHash: candidate.inputHash,
      revision: candidate.revision,
      claim: candidate.claim,
      activeClaim: candidate.claim,
      pendingHeadInitialization,
      generationBoundary: null,
      generationBoundaryHash: null,
      projectionEnrichmentInputHash: candidate.projectionEnrichmentInputHash,
      upstream: candidate.upstream,
      upstreamInputHash: candidate.upstreamInputHash,
      detail: candidate.detail,
      head: head!,
    });
  }
  await completeObsoleteClaims(
    options.database,
    staleClaims,
    now(),
    options.telemetry,
    options.telemetryContext,
  );
  staleCount += staleClaims.length;
  diagnostics.staleRows = staleCount;
  if (
    options.suppliedClaim !== undefined &&
    staleClaims.some((claim) => samePipelineWorkClaim(claim, options.suppliedClaim!))
  ) {
    suppliedClaimOutcome = Object.freeze({
      claim: options.suppliedClaim,
      outcome: "stale_or_obsolete",
    });
  }
  const pendingAtStart = Math.max(0, selection.total - staleClaims.length);
  if (candidates.length === 0) {
    const remaining = await readEnrichmentQueueCount(
      options.database,
      routeIdentity,
    );
    const summary = queueBackedSummary({
      summary: {
        ...pendingQueueSummary(
          options.requestedLimit,
          options.requestedChunks,
          remaining,
        ),
        terminalReadPerformed: remaining === 0,
      },
      queued: selection.total,
      claimed: claimedCount,
      stale: staleCount,
      suppliedClaim: suppliedClaimOutcome,
      diagnostics: enrichmentDiagnosticsSnapshot(diagnostics),
    });
    recordEnrichmentModelTelemetry(options, emptyModelMeasurements());
    recordEnrichmentStageTelemetry(
      options,
      telemetryStartedAt,
      "skipped",
      "obsolete_claims_only",
    );
    return summary;
  }
  const generationBefore = await readCompactPipelineGenerationVector(options.database);
  const queueBefore = await readEnrichmentEvidenceQueue(options.database);

  let textModelUsed = false;
  let embeddingModelUsed = false;
  let textHealthChecks = 0;
  let embeddingHealthChecks = 0;
  let textLoadPhases = 0;
  let embeddingLoadPhases = 0;
  let textUnloadCount = 0;
  let embeddingUnloadCount = 0;
  let textResident = false;
  let embeddingResident = false;
  let coResidencyObserved = false;
  let maxPreparationChunk = 0;
  let maxEmbeddingGroup = 0;
  let textHealthMs = 0;
  let embeddingHealthMs = 0;
  let textGenerationMs = 0;
  let embeddingGenerationMs = 0;
  let textLoadMs = 0;
  let embeddingLoadMs = 0;
  let textInputTokens = 0;
  let textOutputTokens = 0;
  let embeddingInputTokens = 0;
  let embeddingOutputTokens = 0;
  let textRequests = 0;
  let embeddingRequests = 0;
  let textUsageResults = 0;
  let embeddingUsageResults = 0;
  let textUsageComplete = true;
  let embeddingUsageComplete = true;
  let textUnloadMs = 0;
  let embeddingUnloadMs = 0;
  let failureCandidates: readonly EnrichmentSessionCandidate[] = [];
  const invalidTextAttempts: PendingEnrichmentArtifact[] = [];
  const withMutationLease = options.withMutationLease ??
    (async <T,>(operation: () => Promise<T>): Promise<T> => operation());
  const withCleanupMutationLease = options.withCleanupMutationLease ?? withMutationLease;
  await options.suspendMutationLease?.();
  let summary = await drainEnrichmentSessionResidency({
    candidates,
    pendingAtStart,
    requestedLimit: options.requestedLimit,
    requestedChunks: options.requestedChunks,
    preparationConcurrency: () => diagnostics.capacity.effectiveConcurrency,
    signal: options.signal,
    identify: (candidate) => candidate.listingId,
    preflight: async (selected) => {
      throwIfEnrichmentCancelled(options.signal);
      await assertCandidatesUpstreamCurrent(options.database, selected);
      if (selected.some((candidate) => candidate.stage === "enrichment_text")) {
        setVerifiedCapacity(diagnostics, await verifyTextGenerationCapacity({
          configuredConcurrency: diagnostics.capacity.configuredConcurrency,
          provider: options.providers.text,
          signal: options.signal,
        }));
      }
      failureCandidates = selected;
      if (selected.some((candidate) => candidate.stage === "enrichment_text")) {
        textHealthChecks += 1;
        const startedAt = performance.now();
        try {
          await assertProviderReady(options.providers.text, "text", options.signal);
        } finally {
          textHealthMs += performance.now() - startedAt;
        }
      }
      embeddingHealthChecks += 1;
      const embeddingHealthStartedAt = performance.now();
      try {
        await assertProviderReady(
          options.providers.embeddings,
          "embedding",
          options.signal,
        );
      } finally {
        embeddingHealthMs += performance.now() - embeddingHealthStartedAt;
      }
      // Health/capacity probes are provider boundaries too: revalidate the
      // exact active route tuple after they settle and before model work starts.
      await assertCandidatesUpstreamCurrent(options.database, selected);
      failureCandidates = [];
    },
    beforeChunk: async () => {
      throwIfEnrichmentCancelled(options.signal);
      await runTrackedMutation({
        diagnostics,
        withLease: withMutationLease,
        operation: () =>
          renewActiveClaims(options.database, candidates, options.leaseMs, now()),
      });
    },
    prepare: async (candidate) => {
      const finishInitialPreparation = diagnostics.inputPreparation.begin();
      let stageBinding: EnrichmentStageBinding | null = null;
      try {
        await assertCandidateUpstreamCurrent(options.database, candidate);
        const generationBoundary = await readListingEnrichmentGenerationBoundary(
          options.database,
          candidate.listingId,
        );
        candidate.generationBoundary = generationBoundary;
        const generationBoundaryHash = generationBoundary.hash;
        candidate.generationBoundaryHash = generationBoundaryHash;
        stageBinding = candidate.stage === "enrichment_text"
          ? await enrichmentStageBinding(candidate, target, generationBoundaryHash)
          : null;
      } finally {
        finishInitialPreparation();
      }
      let staged: PreparedListingEnrichment | null = null;
      if (stageBinding !== null) {
        const finishStageValidation = diagnostics.validation.begin();
        try {
          staged = await stagedGenerationStore.readListingEnrichment({
            binding: stageBinding,
          });
        } finally {
          finishStageValidation();
        }
      }
      let finishGeneration: (() => void) | null = null;
      let finishProviderValidation: (() => void) | null = null;
      const finishProviderInput = diagnostics.inputPreparation.begin();
      let providerInputActive = true;
      const finishInput = () => {
        if (!providerInputActive) return;
        providerInputActive = false;
        finishProviderInput();
      };
      let prepared: PreparedListingEnrichment;
      try {
        prepared = staged ?? (candidate.stage === "enrichment_text"
          ? await prepareListingEnrichment(
              candidate.listingId,
              candidate.detail,
              options.providers,
              {
                providersPreflighted: true,
                textKeepAlive: TEXT_STAGE_KEEP_ALIVE_SECONDS,
                beforeTextGeneration: () => {
                  finishInput();
                  textRequests += 1;
                  if (!textModelUsed) textLoadPhases += 1;
                  if (embeddingResident) coResidencyObserved = true;
                  textResident = true;
                  textModelUsed = true;
                  finishGeneration = beginProviderGeneration(diagnostics);
                },
                afterTextGeneration: () => {
                  finishGeneration?.();
                  finishGeneration = null;
                },
                beforeValidation: () => {
                  finishProviderValidation = diagnostics.validation.begin();
                },
                afterValidation: () => {
                  finishProviderValidation?.();
                  finishProviderValidation = null;
                },
                onTextGenerationUsage: (usage) => {
                  textUsageResults += 1;
                  const exact = exactProviderUsage(usage);
                  if (exact === null) {
                    textUsageComplete = false;
                    return;
                  }
                  textLoadMs += exact.loadDurationMs;
                  textGenerationMs += exact.totalDurationMs;
                  textInputTokens += exact.inputTokens;
                  textOutputTokens += exact.outputTokens;
                },
                signal: options.signal,
                deferPersistence: true,
                generatedAt: now,
                embeddingDimensions: options.embeddingDimensions,
              },
            )
          : await readPreparedListingEnrichmentFromHead(
              candidate.listingId,
              candidate.detail,
              candidate.head,
              options.providers,
              { embeddingDimensions: options.embeddingDimensions },
            ));
      } catch (error) {
        const invalidAttempt = await pendingInvalidTextAttempt({
          error,
          candidate,
          target,
        });
        if (invalidAttempt !== null) invalidTextAttempts.push(invalidAttempt);
        throw error;
      } finally {
        finishInput();
        settleDiagnosticInterval(finishGeneration);
        settleDiagnosticInterval(finishProviderValidation);
      }
      if (staged !== null) {
        diagnostics.stagedPayloadRowsReused += 1;
      } else if (prepared.textGenerated) {
        diagnostics.newlyGeneratedRows += 1;
      } else {
        diagnostics.immutableRowsReused += 1;
      }
      if (
        stageBinding !== null && staged === null &&
        (prepared.pendingArtifacts?.length ?? 0) > 0
      ) {
        await stagedGenerationStore.writeListingEnrichment({
          binding: stageBinding,
          prepared,
        });
        await options.afterGenerationStaged?.(candidate.listingId);
      }
      if (staged === null) textModelUsed ||= prepared.textGenerated;
      return prepared;
    },
    afterPreparationChunk: async ({ prepared }) => {
      throwIfEnrichmentCancelled(options.signal);
      maxPreparationChunk = Math.max(maxPreparationChunk, prepared.length);
      const text = prepared.filter(({ candidate }) =>
        candidate.stage === "enrichment_text"
      );
      if (text.length === 0) return;
      failureCandidates = text.map(({ candidate }) => candidate);
      await runTrackedMutation({
        diagnostics,
        withLease: withMutationLease,
        publicationRows: text.length,
        operation: () => commitTextChunk({
          database: options.database,
          owner: options.owner,
          leaseMs: options.leaseMs,
          target,
          entries: text,
          now: now(),
          signal: options.signal,
        }),
      });
      failureCandidates = [];
    },
    finishPreparation: async () => {
      if (!textModelUsed) return;
      if (
        options.providers.text.providerName === "ollama" &&
        !options.providers.text.unload
      ) throw new Error("The Ollama text provider cannot explicitly unload its model");
      const unloadStartedAt = performance.now();
      await cleanupProvider(options.providers.text.unload === undefined
        ? undefined
        : (signal) => options.providers.text.unload!(signal));
      textUnloadMs += performance.now() - unloadStartedAt;
      if (options.providers.text.unload) textUnloadCount += 1;
      textResident = false;
    },
    beforeBatch: async ({ chunk }) => {
      throwIfEnrichmentCancelled(options.signal);
      maxEmbeddingGroup = Math.max(maxEmbeddingGroup, chunk.prepared.length);
      if (textResident) coResidencyObserved = true;
      failureCandidates = chunk.prepared.map(({ candidate }) => candidate);
      await runTrackedMutation({
        diagnostics,
        withLease: withMutationLease,
        operation: () =>
          renewActiveClaims(options.database, candidates, options.leaseMs, now()),
      });
    },
    completeBatch: async (prepared) => {
      throwIfEnrichmentCancelled(options.signal);
      const finishEmbeddingInput = diagnostics.inputPreparation.begin();
      let stageBindings: readonly EnrichmentEmbeddingStageBinding[];
      try {
        await assertCandidatesUpstreamCurrent(
          options.database,
          prepared.map(({ candidate }) => candidate),
        );
        stageBindings = await Promise.all(prepared.map((entry) =>
          enrichmentEmbeddingStageBinding(
            [entry],
            target,
            options.database,
          )
        ));
      } finally {
        finishEmbeddingInput();
      }
      const finishStageValidation = diagnostics.validation.begin();
      let stagedByIndex: readonly (StagedEnrichmentEmbeddingResult | null)[];
      try {
        stagedByIndex = await Promise.all(stageBindings.map(async (binding) => {
          const staged = await stagedGenerationStore.readListingEmbeddings({
            binding,
          });
          return staged?.[0] ?? null;
        }));
      } finally {
        finishStageValidation();
      }
      const misses = prepared.flatMap((entry, index) =>
        stagedByIndex[index] === null ? [{ entry, index }] : []
      );
      let finishGeneration: (() => void) | null = null;
      let finishProviderValidation: (() => void) | null = null;
      const generated = misses.length > 0
        ? await embedPreparedListingEnrichments(
          misses.map(({ entry }) => entry.value),
          options.providers,
          {
            providersPreflighted: true,
            embeddingKeepAlive: TEXT_STAGE_KEEP_ALIVE_SECONDS,
            beforeEmbeddingGeneration: () => {
              embeddingRequests += 1;
              if (!embeddingModelUsed) embeddingLoadPhases += 1;
              if (textResident) coResidencyObserved = true;
              embeddingResident = true;
              embeddingModelUsed = true;
              finishGeneration = beginProviderGeneration(diagnostics);
            },
            afterEmbeddingGeneration: () => {
              finishGeneration?.();
              finishGeneration = null;
            },
            beforeValidation: () => {
              finishProviderValidation = diagnostics.validation.begin();
            },
            afterValidation: () => {
              finishProviderValidation?.();
              finishProviderValidation = null;
            },
            onEmbeddingUsage: (usage) => {
              embeddingUsageResults += 1;
              const exact = exactProviderUsage(usage);
              if (exact === null) {
                embeddingUsageComplete = false;
                return;
              }
              embeddingLoadMs += exact.loadDurationMs;
              embeddingGenerationMs += exact.totalDurationMs;
              embeddingInputTokens += exact.inputTokens;
              embeddingOutputTokens += exact.outputTokens;
            },
            signal: options.signal,
            deferPersistence: true,
            generatedAt: now,
            embeddingDimensions: options.embeddingDimensions,
          },
        )
        : [];
      settleDiagnosticInterval(finishGeneration);
      settleDiagnosticInterval(finishProviderValidation);
      const generatedByIndex = new Map(misses.map(({ entry, index }, missIndex) => [
        index,
        Object.freeze({
          listingId: entry.candidate.listingId,
          embeddingId: generated[missIndex]!.embeddingId,
          ...(generated[missIndex]!.pendingEmbedding === undefined
            ? {}
            : { pendingEmbedding: generated[missIndex]!.pendingEmbedding }),
        }) satisfies StagedEnrichmentEmbeddingResult,
      ]));
      const results: readonly StagedEnrichmentEmbeddingResult[] = prepared.map(
        (_entry, index) => stagedByIndex[index] ?? generatedByIndex.get(index)!,
      );
      diagnostics.stagedPayloadRowsReused += stagedByIndex.filter(
        (result) => result !== null,
      ).length;
      diagnostics.newlyGeneratedRows += [...generatedByIndex.values()].filter((result) =>
        result.pendingEmbedding !== undefined
      ).length;
      diagnostics.immutableRowsReused += [...generatedByIndex.values()].filter((result) =>
        result.pendingEmbedding === undefined
      ).length;
      const generatedStages = [...generatedByIndex.entries()].filter(
        ([, result]) => result.pendingEmbedding !== undefined,
      );
      for (const [index, result] of generatedStages) {
        await stagedGenerationStore.writeListingEmbeddings({
          binding: stageBindings[index]!,
          results: [result],
        });
      }
      if (generatedStages.length > 0) {
        await options.afterEmbeddingGenerationStaged?.(
          results.map((result) => result.listingId),
        );
      }
      throwIfEnrichmentCancelled(options.signal);
      await runTrackedMutation({
        diagnostics,
        withLease: withMutationLease,
        publicationRows: prepared.length,
        operation: () => commitEmbeddingGroup({
          database: options.database,
          target,
          entries: prepared.map((entry, index) => ({
            candidate: entry.candidate,
            result: results[index]!,
          })),
          now: now(),
          signal: options.signal,
        }),
      });
      failureCandidates = [];
    },
    finishEmbedding: async () => {
      if (!embeddingModelUsed) return;
      if (
        options.providers.embeddings.providerName === "ollama" &&
        !options.providers.embeddings.unload
      ) throw new Error("The Ollama embedding provider cannot explicitly unload its model");
      const unloadStartedAt = performance.now();
      await cleanupProvider(options.providers.embeddings.unload === undefined
        ? undefined
        : (signal) => options.providers.embeddings.unload!(signal));
      embeddingUnloadMs += performance.now() - unloadStartedAt;
      if (options.providers.embeddings.unload) embeddingUnloadCount += 1;
      embeddingResident = false;
    },
    beforeTerminalRead: async () => {
      await options.beforeTerminalRead?.();
    },
    readTerminalPending: () =>
      readEnrichmentQueueCount(options.database, routeIdentity),
  });

  let terminalizedListingId: string | null = null;
  const sessionFailed = summary.circuitOpen;
  const sessionCancelled = options.signal?.aborted === true ||
    summary.errorMessage === "enrichment_cancelled";
  const sessionStale = sessionFailed && summary.errorMessage !== null &&
    /(?:_stale| (?:is|was) stale|upstream_input_stale)/u.test(summary.errorMessage);
  if (sessionCancelled) {
    await retryCancellationSettlement(() => runTrackedMutation({
      diagnostics,
      withLease: withCleanupMutationLease,
      operation: () => settleCancelledSessionClaims({
        database: options.database,
        candidates,
        owner: options.owner,
        now: now(),
      }),
    }));
    summary = Object.freeze({
      ...summary,
      failures: 1,
      circuitOpen: true,
      failedItemId: null,
      errorMessage: "enrichment_cancelled",
      remaining: await readEnrichmentQueueCount(options.database, routeIdentity),
      terminalReadPerformed: false,
    });
  } else if (sessionFailed) {
    if (sessionStale) diagnostics.staleRows += 1;
    else diagnostics.failedRows = 1;
    const settlement = await runTrackedMutation({
      diagnostics,
      withLease: withMutationLease,
      operation: () => settleFailedSessionClaims({
        database: options.database,
        candidates,
        failedListingId: summary.failedItemId,
        failureCandidates,
        failureClassification: summary.failureClassification,
        invalidTextAttempts,
        message: summary.errorMessage ?? "enrichment_session_failed",
        now: now(),
        telemetry: options.telemetry,
        telemetryContext: options.telemetryContext,
        routeIdentity,
      }),
    });
    terminalizedListingId = settlement.terminalizedListingId;
    diagnostics.terminalRows = settlement.terminalizedListingId === null ? 0 : 1;
    if (settlement.terminalizedListingId !== null) {
      summary = Object.freeze({
        ...summary,
        completed: summary.completed + 1,
        failures: 0,
        remaining: settlement.remaining,
        circuitOpen: false,
        failedItemId: null,
        errorMessage: null,
        terminalReadPerformed: settlement.remaining === 0,
      });
    }
  }
  const suppliedCandidate = options.suppliedClaim === undefined
    ? undefined
    : candidates.find((candidate) =>
        samePipelineWorkClaim(candidate.claim, options.suppliedClaim!)
      );
  if (suppliedCandidate !== undefined && suppliedClaimOutcome === null) {
    suppliedClaimOutcome = Object.freeze({
      claim: options.suppliedClaim!,
      outcome: sessionCancelled || sessionFailed
        ? terminalizedListingId === suppliedCandidate.listingId
          ? "completed"
          : "failed_or_deferred"
        : suppliedCandidate.activeClaim === null
        ? "completed"
        : "still_pending",
    });
  }
  const generationAfter = await readCompactPipelineGenerationVector(options.database);
  const queueAfter = await readEnrichmentEvidenceQueue(options.database);
  const appendEvidenceWithLease = sessionCancelled
    ? withCleanupMutationLease
    : withMutationLease;
  await runTrackedMutation({
    diagnostics,
    withLease: appendEvidenceWithLease,
    operation: () => appendEnrichmentSessionEvidence({
      database: options.database,
      candidates,
      summary,
      targetIdentity: target.identity,
      generationBefore,
      generationAfter,
      queueBefore,
      queueAfter,
      metrics: {
        textHealthChecks,
        embeddingHealthChecks,
        textLoadPhases,
        embeddingLoadPhases,
        textUnloadCount,
        embeddingUnloadCount,
        textModelUsed,
        embeddingModelUsed,
        coResidencyObserved,
        maxPreparationChunk,
        maxEmbeddingGroup,
      },
      completedAt: now(),
    }),
  });
  recordEnrichmentModelTelemetry(options, {
    text: {
      healthMs: textHealthMs,
      loadCount: textLoadPhases,
      unloadCount: textUnloadCount,
      loadMs: textLoadMs,
      generationMs: textGenerationMs,
      embeddingMs: 0,
      unloadMs: textUnloadMs,
      inputTokens: textInputTokens,
      outputTokens: textOutputTokens,
      usageComplete: textUsageComplete && textUsageResults === textRequests,
    },
    embedding: {
      healthMs: embeddingHealthMs,
      loadCount: embeddingLoadPhases,
      unloadCount: embeddingUnloadCount,
      loadMs: embeddingLoadMs,
      generationMs: 0,
      embeddingMs: embeddingGenerationMs,
      unloadMs: embeddingUnloadMs,
      inputTokens: embeddingInputTokens,
      outputTokens: embeddingOutputTokens,
      usageComplete: embeddingUsageComplete &&
        embeddingUsageResults === embeddingRequests,
    },
  });
  recordEnrichmentStageTelemetry(
    options,
    telemetryStartedAt,
    summary.circuitOpen ? "failed" : "completed",
    summary.circuitOpen ? "enrichment_circuit_open" : "session_complete",
  );
  return queueBackedSummary({
    summary,
    queued: selection.total,
    claimed: claimedCount,
    stale: staleCount,
    suppliedClaim: suppliedClaimOutcome,
    diagnostics: enrichmentDiagnosticsSnapshot(diagnostics),
  });
}

async function hasPendingEnrichmentProjectionRefresh(
  database: D1Database,
  listingId: string,
  sourceId: string,
): Promise<boolean> {
  const row = await database.prepare(`
    SELECT 1 AS pending
    FROM pipeline_work_items
    WHERE stage = 'projection_listing_refresh' AND subject_type = 'listing'
      AND subject_id = ? AND listing_id = ? AND source_id = ?
      AND reason_code = 'enrichment_head_changed'
  `).bind(listingId, listingId, sourceId).first<{ pending: number }>();
  return row !== null;
}

async function enrichmentStageBinding(
  candidate: EnrichmentSessionCandidate,
  target: EnrichmentProvenanceTarget,
  generationBoundaryHash: string,
): Promise<EnrichmentStageBinding> {
  if (candidate.stage !== "enrichment_text") {
    throw new Error("enrichment_staged_generation_stage_invalid");
  }
  return Object.freeze({
    listingId: candidate.listingId,
    stage: "enrichment_text",
    claimInputHash: candidate.claim.inputHash,
    claimRevision: candidate.claim.revision,
    headIdentity: candidate.head.headIdentity,
    headGeneration: candidate.head.generation,
    sourceEvidenceHash: await hashCanonicalJson(candidate.detail),
    upstreamInputHash: candidate.upstreamInputHash,
    target: enrichmentStageTargetIdentity(target),
    generationVectorHash: generationBoundaryHash,
  });
}

async function enrichmentEmbeddingStageBinding(
  prepared: readonly {
    candidate: EnrichmentSessionCandidate;
    value: PreparedListingEnrichment;
  }[],
  target: EnrichmentProvenanceTarget,
  database: D1Database,
): Promise<EnrichmentEmbeddingStageBinding> {
  return Object.freeze({
    stage: "enrichment_embedding",
    entries: Object.freeze(await Promise.all(prepared.map(async ({ candidate, value }) => {
      if (candidate.activeClaim === null) {
        throw new Error("The embedding work claim is absent");
      }
      const generationBoundary =
        await readListingEnrichmentGenerationBoundary(
          database,
          candidate.listingId,
        );
      candidate.generationBoundary = generationBoundary;
      const generationBoundaryHash = generationBoundary.hash;
      candidate.generationBoundaryHash = generationBoundaryHash;
      return Object.freeze({
        listingId: candidate.listingId,
        claimInputHash: candidate.activeClaim.inputHash,
        claimRevision: candidate.activeClaim.revision,
        headIdentity: candidate.head.headIdentity,
        headGeneration: candidate.head.generation,
        sourceEvidenceHash: await hashCanonicalJson(candidate.detail),
        upstreamInputHash: candidate.upstreamInputHash,
        semanticHash: value.semanticHash,
        generationVectorHash: generationBoundaryHash,
      });
    }))),
    target: enrichmentStageTargetIdentity(target),
  });
}

async function readListingEnrichmentGenerationBoundary(
  database: D1Database,
  listingId: string,
): Promise<ListingGenerationBoundary> {
  const row = await database.prepare(`
    SELECT generation, fingerprint, derivation_version
    FROM pipeline_generation_state
    WHERE domain = 'enrichment_target' AND scope_type = 'listing' AND scope_id = ?
  `).bind(listingId).first<{
    generation: number;
    fingerprint: string;
    derivation_version: string;
  }>();
  const identity = row === null ? null : {
    generation: Number(row.generation),
    fingerprint: row.fingerprint,
    derivationVersion: row.derivation_version,
  };
  return Object.freeze({
    generation: identity?.generation ?? null,
    fingerprint: identity?.fingerprint ?? null,
    derivationVersion: identity?.derivationVersion ?? null,
    hash: await hashCanonicalJson(identity),
  });
}

function enrichmentStageTargetIdentity(
  target: EnrichmentProvenanceTarget,
): EnrichmentStageTargetIdentity {
  return Object.freeze({
    identity: target.identity,
    textProviderName: target.textProviderName,
    textModelName: target.textModelName,
    extractionPromptVersion: target.extractionPromptVersion,
    semanticDocumentVersion: target.semanticDocumentVersion,
    embeddingProviderName: target.embeddingProviderName,
    embeddingModelName: target.embeddingModelName,
    embeddingDimensions: target.embeddingDimensions,
  });
}

async function commitTextChunk(input: {
  database: D1Database;
  owner: string;
  leaseMs: number;
  target: EnrichmentProvenanceTarget;
  entries: readonly {
    candidate: EnrichmentSessionCandidate;
    value: PreparedListingEnrichment;
  }[];
  now: Date;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfEnrichmentCancelled(input.signal);
  const statements: D1PreparedStatement[] = [];
  const checks: Array<{
    head: number;
    completion: number;
    embeddingClaim: number;
    listingId: string;
    embeddingInputHash: string;
  }> = [];
  const resultingHeads = new Map<string, ListingEnrichmentHead>();
  for (const { candidate, value } of input.entries) {
    throwIfEnrichmentCancelled(input.signal);
    await assertCandidateUpstreamCurrent(input.database, candidate);
    if (candidate.activeClaim === null) throw new Error("The text work claim is absent");
    await assertClaimCurrent(input.database, candidate.activeClaim, input.now);
    if (
      candidate.generationBoundary === null ||
      candidate.generationBoundaryHash !== candidate.generationBoundary.hash ||
      (await readListingEnrichmentGenerationBoundary(
        input.database,
        candidate.listingId,
      )).hash !== candidate.generationBoundaryHash
    ) throw new Error("enrichment_staged_generation_boundary_stale");

    const pendingArtifacts = value.pendingArtifacts ?? [];
    const extraction = pendingArtifacts.find((artifact) =>
      artifact.id === value.extractionArtifactId && artifact.task === "listing_extraction"
    );
    const semantic = pendingArtifacts.find((artifact) =>
      artifact.id === value.semanticArtifactId && artifact.task === "semantic_document"
    );
    let resultingHead: ListingEnrichmentHead;
    let headStatement: D1PreparedStatement;
    if (extraction !== undefined && semantic !== undefined) {
      if (extraction.outputHash === null || semantic.outputHash !== value.semanticHash) {
        throw new Error("enrichment_staged_artifact_identity_changed");
      }
      if (candidate.pendingHeadInitialization?.statement !== null &&
          candidate.pendingHeadInitialization !== null) {
        statements.push(candidate.pendingHeadInitialization.statement);
      }
      for (const artifact of pendingArtifacts) {
        const collision = await readStagedArtifactCollision(input.database, artifact);
        if (collision === "mismatch") {
          throw new Error("enrichment_staged_artifact_identity_changed");
        }
        if (collision === "absent") {
          statements.push(stagedArtifactInsertStatement(input.database, artifact));
        }
      }
      resultingHead = await makeSessionHead({
        ...candidate.head,
        state: "pending_embedding",
        extractionArtifactId: value.extractionArtifactId,
        extractionOutputHash: extraction.outputHash,
        semanticArtifactId: value.semanticArtifactId,
        semanticOutputHash: semantic.outputHash,
        embeddingId: null,
        embeddingInputHash: null,
        embeddingVectorHash: null,
        generation: candidate.head.generation + 1,
        updatedAt: input.now.toISOString(),
      });
      headStatement = stagedTextHeadTransitionStatement({
        database: input.database,
        candidate,
        resultingHead,
        extraction,
        semantic,
      });
    } else {
      const pendingInitialization = candidate.pendingHeadInitialization;
      const pendingInitializationStatement =
        pendingInitialization?.statement ?? null;
      if (pendingInitializationStatement !== null) {
        statements.push(pendingInitializationStatement);
      }
      const transition = await prepareListingEnrichmentTextTransition({
        database: input.database,
        listingId: candidate.listingId,
        expectedHeadIdentity: candidate.head.headIdentity,
        expectedEnrichmentInputHash: candidate.head.enrichmentInputHash,
        ...(pendingInitializationStatement === null
          ? {}
          : { pendingInitializationHead: pendingInitialization!.resultingHead }),
        target: input.target,
        artifactInputHash: value.artifactInputHash,
        extractionArtifactId: value.extractionArtifactId,
        semanticArtifactId: value.semanticArtifactId,
        nextState: "pending_embedding",
        now: input.now,
      });
      if (transition === null) {
        throw new Error(`The text head for ${candidate.listingId} did not advance`);
      }
      resultingHead = transition.resultingHead;
      headStatement = transition.statement;
    }
    const headIndex = statements.length;
    statements.push(headStatement);
    const embeddingInputHash = await hashCanonicalJson({
      enrichmentInputHash: resultingHead.enrichmentInputHash,
      headIdentity: resultingHead.headIdentity,
      headState: "pending_embedding",
    });
    statements.push(await prepareEnrichmentEmbeddingQueueCoalesceStatement({
      database: input.database,
      listingId: candidate.listingId,
      sourceId: candidate.sourceId,
      enrichmentInputHash: resultingHead.enrichmentInputHash,
      textHeadIdentity: resultingHead.headIdentity,
      now: input.now,
    }));
    statements.push(...await enrichmentHeadInvalidationStatements({
      database: input.database,
      sourceId: candidate.sourceId,
      head: resultingHead,
      now: input.now,
    }));
    const completionIndex = statements.length;
    statements.push(guardedExactClaimCompletionStatement(
      input.database,
      candidate.activeClaim,
      resultingHead,
    ));
    const embeddingClaimIndex = statements.length;
    statements.push(exactEmbeddingClaimStatement({
      database: input.database,
      owner: input.owner,
      leaseMs: input.leaseMs,
      inputHash: embeddingInputHash,
      head: resultingHead,
      now: input.now,
    }));
    statements.push(commitGuardStatement(input.database, resultingHead, input.owner, embeddingInputHash));
    checks.push({
      head: headIndex,
      completion: completionIndex,
      embeddingClaim: embeddingClaimIndex,
      listingId: candidate.listingId,
      embeddingInputHash,
    });
    resultingHeads.set(candidate.listingId, resultingHead);
  }
  throwIfEnrichmentCancelled(input.signal);
  const writes = await input.database.batch(statements);
  for (const check of checks) {
    if (
      changes(writes[check.head]) !== 1 || changes(writes[check.completion]) !== 1 ||
      changes(writes[check.embeddingClaim]) !== 1
    ) {
      throw new Error(`The exact text checkpoint for ${check.listingId} was stale`);
    }
  }
  for (const { candidate } of input.entries) {
    const check = checks.find((value) => value.listingId === candidate.listingId)!;
    candidate.head = resultingHeads.get(candidate.listingId)!;
    candidate.pendingHeadInitialization = null;
    candidate.activeClaim = await readExactOwnedEmbeddingClaim({
      database: input.database,
      listingId: candidate.listingId,
      owner: input.owner,
      inputHash: check.embeddingInputHash,
    });
  }
}

async function commitEmbeddingGroup(input: {
  database: D1Database;
  target: EnrichmentProvenanceTarget;
  entries: readonly {
    candidate: EnrichmentSessionCandidate;
    result: {
      readonly embeddingId: string;
      readonly pendingEmbedding?: PendingEnrichmentEmbedding;
    };
  }[];
  now: Date;
  signal?: AbortSignal;
}): Promise<void> {
  throwIfEnrichmentCancelled(input.signal);
  const statements: D1PreparedStatement[] = [];
  const checks: Array<{ head: number; completion: number; listingId: string }> = [];
  const resultingHeads = new Map<string, ListingEnrichmentHead>();
  for (const { candidate, result } of input.entries) {
    throwIfEnrichmentCancelled(input.signal);
    await assertCandidateUpstreamCurrent(input.database, candidate);
    if (
      candidate.generationBoundary === null ||
      candidate.generationBoundaryHash !== candidate.generationBoundary.hash ||
      (await readListingEnrichmentGenerationBoundary(
        input.database,
        candidate.listingId,
      )).hash !== candidate.generationBoundaryHash
    ) throw new Error("enrichment_staged_generation_boundary_stale");
    if (candidate.activeClaim === null) throw new Error("The embedding work claim is absent");
    await assertClaimCurrent(input.database, candidate.activeClaim, input.now);
    const embedding = result.pendingEmbedding ??
      await readExistingEmbedding(input.database, result.embeddingId);
    const vectorJson = JSON.stringify(embedding.vector);
    if (
      embedding.id !== result.embeddingId || embedding.listingId !== candidate.listingId ||
      embedding.providerName !== input.target.embeddingProviderName ||
      embedding.modelName !== input.target.embeddingModelName ||
      embedding.inputHash !== candidate.head.semanticOutputHash ||
      embedding.vector.length !== input.target.embeddingDimensions
    ) throw new Error("enrichment_staged_embedding_identity_changed");
    if (result.pendingEmbedding !== undefined) {
      const collision = await readStagedEmbeddingCollision(
        input.database,
        embedding,
        vectorJson,
      );
      if (collision === "mismatch") {
        throw new Error("enrichment_staged_embedding_identity_changed");
      }
      if (collision === "absent") {
        statements.push(stagedEmbeddingInsertStatement(input.database, embedding));
      }
    }
    const resultingHead = await makeSessionHead({
      ...candidate.head,
      state: "complete",
      embeddingId: embedding.id,
      embeddingInputHash: embedding.inputHash,
      embeddingVectorHash: await sha256Text(vectorJson),
      generation: candidate.head.generation + 1,
      updatedAt: input.now.toISOString(),
    });
    const headIndex = statements.length;
    statements.push(stagedEmbeddingHeadTransitionStatement({
      database: input.database,
      candidate,
      resultingHead,
      embedding,
      vectorJson,
    }));
    statements.push(...await enrichmentHeadInvalidationStatements({
      database: input.database,
      sourceId: candidate.sourceId,
      head: resultingHead,
      now: input.now,
    }));
    const completionIndex = statements.length;
    statements.push(guardedExactClaimCompletionStatement(
      input.database,
      candidate.activeClaim,
      resultingHead,
    ));
    statements.push(embeddingCommitGuardStatement(input.database, resultingHead));
    checks.push({ head: headIndex, completion: completionIndex, listingId: candidate.listingId });
    resultingHeads.set(candidate.listingId, resultingHead);
  }
  throwIfEnrichmentCancelled(input.signal);
  const writes = await input.database.batch(statements);
  for (const check of checks) {
    if (changes(writes[check.head]) !== 1 || changes(writes[check.completion]) !== 1) {
      throw new Error(`The exact embedding checkpoint for ${check.listingId} was stale`);
    }
  }
  for (const { candidate } of input.entries) {
    candidate.head = resultingHeads.get(candidate.listingId)!;
    candidate.activeClaim = null;
  }
}

type StagedTextArtifact = NonNullable<
  PreparedListingEnrichment["pendingArtifacts"]
>[number];

async function pendingInvalidTextAttempt(input: {
  readonly error: unknown;
  readonly candidate: EnrichmentSessionCandidate;
  readonly target: EnrichmentProvenanceTarget;
}): Promise<PendingEnrichmentArtifact | null> {
  if (!isAiProviderError(input.error)) return null;
  const evidence = input.error.invalidAttemptEvidence;
  const context = input.error.invalidAttemptContext;
  if (
    evidence === undefined || context === undefined ||
    input.error.providerName !== input.target.textProviderName ||
    input.error.modelName !== input.target.textModelName ||
    context.listingId !== input.candidate.listingId ||
    context.task !== "listing_extraction" ||
    context.promptVersion !== input.target.extractionPromptVersion ||
    !/^[0-9a-f]{64}$/u.test(context.inputHash) ||
    !/^[0-9a-f]{64}$/u.test(evidence.responseHash) ||
    !Number.isFinite(Date.parse(evidence.generatedAt))
  ) return null;
  const responseText = evidence.responseText;
  if (
    responseText !== null &&
    await sha256Text(responseText) !== evidence.responseHash
  ) return null;
  return Object.freeze({
    id: crypto.randomUUID(),
    listingId: context.listingId,
    task: context.task,
    providerName: input.error.providerName,
    modelName: input.error.modelName,
    promptVersion: context.promptVersion,
    inputHash: context.inputHash,
    outputText: responseText !== null &&
        isRetainableAiInvalidResponseText(responseText)
      ? responseText
      : null,
    outputJson: null,
    outputHash: evidence.responseHash,
    generatedAt: evidence.generatedAt,
  });
}

function stagedArtifactInsertStatement(
  database: D1Database,
  artifact: StagedTextArtifact,
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO ai_artifacts (
      id, subject_type, subject_id, task, provider_name, model_name,
      prompt_version, input_hash, output_text, output_json, output_hash,
      generated_at
    ) VALUES (?, 'listing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    artifact.id,
    artifact.listingId,
    artifact.task,
    artifact.providerName,
    artifact.modelName,
    artifact.promptVersion,
    artifact.inputHash,
    artifact.outputText,
    artifact.outputJson,
    artifact.outputHash,
    artifact.generatedAt,
  );
}

async function readStagedArtifactCollision(
  database: D1Database,
  artifact: StagedTextArtifact,
): Promise<"absent" | "exact" | "mismatch"> {
  const row = await database.prepare(`
    SELECT subject_type, subject_id, task, provider_name, model_name,
      prompt_version, input_hash, output_text, output_json, output_hash,
      generated_at
    FROM ai_artifacts WHERE id = ?
  `).bind(artifact.id).first<{
    subject_type: string;
    subject_id: string;
    task: string;
    provider_name: string;
    model_name: string;
    prompt_version: string;
    input_hash: string;
    output_text: string | null;
    output_json: string | null;
    output_hash: string | null;
    generated_at: string;
  }>();
  if (row === null) return "absent";
  return row.subject_type === "listing" && row.subject_id === artifact.listingId &&
      row.task === artifact.task && row.provider_name === artifact.providerName &&
      row.model_name === artifact.modelName && row.prompt_version === artifact.promptVersion &&
      row.input_hash === artifact.inputHash && row.output_text === artifact.outputText &&
      row.output_json === artifact.outputJson && row.output_hash === artifact.outputHash &&
      row.generated_at === artifact.generatedAt
    ? "exact"
    : "mismatch";
}

function stagedEmbeddingInsertStatement(
  database: D1Database,
  embedding: PendingEnrichmentEmbedding,
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO embeddings (
      id, subject_type, subject_id, kind, provider_name, model_name,
      input_hash, dimensions, vector_json, generated_at
    ) VALUES (?, 'listing', ?, 'listing_semantic_document', ?, ?, ?, ?, ?, ?)
  `).bind(
    embedding.id,
    embedding.listingId,
    embedding.providerName,
    embedding.modelName,
    embedding.inputHash,
    embedding.vector.length,
    JSON.stringify(embedding.vector),
    embedding.generatedAt,
  );
}

async function readStagedEmbeddingCollision(
  database: D1Database,
  embedding: PendingEnrichmentEmbedding,
  vectorJson: string,
): Promise<"absent" | "exact" | "mismatch"> {
  const row = await database.prepare(`
    SELECT subject_type, subject_id, kind, provider_name, model_name,
      input_hash, dimensions, vector_json, generated_at
    FROM embeddings WHERE id = ?
  `).bind(embedding.id).first<{
    subject_type: string;
    subject_id: string;
    kind: string;
    provider_name: string;
    model_name: string;
    input_hash: string;
    dimensions: number;
    vector_json: string;
    generated_at: string;
  }>();
  if (row === null) return "absent";
  return row.subject_type === "listing" && row.subject_id === embedding.listingId &&
      row.kind === "listing_semantic_document" &&
      row.provider_name === embedding.providerName && row.model_name === embedding.modelName &&
      row.input_hash === embedding.inputHash && row.dimensions === embedding.vector.length &&
      row.vector_json === vectorJson && row.generated_at === embedding.generatedAt
    ? "exact"
    : "mismatch";
}

async function readExistingEmbedding(
  database: D1Database,
  embeddingId: string,
): Promise<PendingEnrichmentEmbedding> {
  const row = await database.prepare(`
    SELECT id, subject_id, provider_name, model_name, input_hash,
      vector_json, generated_at
    FROM embeddings
    WHERE id = ? AND subject_type = 'listing'
      AND kind = 'listing_semantic_document'
  `).bind(embeddingId).first<{
    id: string;
    subject_id: string;
    provider_name: string;
    model_name: string;
    input_hash: string;
    vector_json: string;
    generated_at: string;
  }>();
  if (row === null) throw new Error("enrichment staged embedding is absent");
  let vector: unknown;
  try {
    vector = JSON.parse(row.vector_json) as unknown;
  } catch {
    throw new Error("enrichment staged embedding vector is invalid");
  }
  if (!Array.isArray(vector) || vector.some((value) =>
    typeof value !== "number" || !Number.isFinite(value)
  )) throw new Error("enrichment staged embedding vector is invalid");
  return Object.freeze({
    id: row.id,
    listingId: row.subject_id,
    providerName: row.provider_name,
    modelName: row.model_name,
    inputHash: row.input_hash,
    vector: Object.freeze(vector as number[]),
    generatedAt: row.generated_at,
  });
}

function stagedEmbeddingHeadTransitionStatement(input: {
  readonly database: D1Database;
  readonly candidate: EnrichmentSessionCandidate;
  readonly resultingHead: ListingEnrichmentHead;
  readonly embedding: PendingEnrichmentEmbedding;
  readonly vectorJson: string;
}): D1PreparedStatement {
  const upstream = exactUpstreamGuard(input.candidate.upstream);
  const generation = exactGenerationGuard(
    input.candidate.listingId,
    input.candidate.generationBoundary!,
  );
  return input.database.prepare(`
    UPDATE listing_enrichment_heads
    SET state = 'complete', embedding_id = ?, embedding_input_hash = ?,
        embedding_vector_hash = ?, head_identity = ?, generation = ?,
        updated_at = ?
    WHERE listing_id = ? AND head_identity = ? AND generation = ?
      AND enrichment_input_hash = ? AND provenance_target_identity = ?
      AND state IN ('text_ready', 'pending_embedding')
      AND EXISTS (
        SELECT 1 FROM embeddings embedding
        WHERE embedding.id = ? AND embedding.subject_type = 'listing'
          AND embedding.subject_id = ?
          AND embedding.kind = 'listing_semantic_document'
          AND embedding.provider_name = ? AND embedding.model_name = ?
          AND embedding.input_hash = ? AND embedding.dimensions = ?
          AND embedding.vector_json = ? AND embedding.generated_at = ?
      )
      AND ${upstream.sql}
      AND ${generation.sql}
  `).bind(
    input.resultingHead.embeddingId,
    input.resultingHead.embeddingInputHash,
    input.resultingHead.embeddingVectorHash,
    input.resultingHead.headIdentity,
    input.resultingHead.generation,
    input.resultingHead.updatedAt,
    input.candidate.listingId,
    input.candidate.head.headIdentity,
    input.candidate.head.generation,
    input.candidate.head.enrichmentInputHash,
    input.candidate.head.provenanceTargetIdentity,
    input.embedding.id,
    input.embedding.listingId,
    input.embedding.providerName,
    input.embedding.modelName,
    input.embedding.inputHash,
    input.embedding.vector.length,
    input.vectorJson,
    input.embedding.generatedAt,
    ...upstream.bindings,
    ...generation.bindings,
  );
}

function embeddingCommitGuardStatement(
  database: D1Database,
  head: ListingEnrichmentHead,
): D1PreparedStatement {
  return database.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM listing_enrichment_heads
      WHERE listing_id = ? AND head_identity = ? AND generation = ?
    ) AND NOT EXISTS (
      SELECT 1 FROM pipeline_work_items
      WHERE stage = 'enrichment_embedding' AND subject_type = 'listing'
        AND subject_id = ?
    ) THEN json('null') ELSE json('enrichment_embedding_commit_stale') END AS exact_guard
  `).bind(head.listingId, head.headIdentity, head.generation, head.listingId);
}

async function makeSessionHead(
  input: Omit<ListingEnrichmentHead, "headIdentity"> & { readonly headIdentity?: string },
): Promise<ListingEnrichmentHead> {
  const identity = await hashCanonicalJson({
    listingId: input.listingId,
    provenanceTargetIdentity: input.provenanceTargetIdentity,
    enrichmentInputHash: input.enrichmentInputHash,
    state: input.state,
    extractionArtifactId: input.extractionArtifactId,
    extractionOutputHash: input.extractionOutputHash,
    semanticArtifactId: input.semanticArtifactId,
    semanticOutputHash: input.semanticOutputHash,
    embeddingId: input.embeddingId,
    embeddingInputHash: input.embeddingInputHash,
    embeddingVectorHash: input.embeddingVectorHash,
    generation: input.generation,
    derivationVersion: input.derivationVersion,
  });
  return Object.freeze({ ...input, headIdentity: identity });
}

function stagedTextHeadTransitionStatement(input: {
  readonly database: D1Database;
  readonly candidate: EnrichmentSessionCandidate;
  readonly resultingHead: ListingEnrichmentHead;
  readonly extraction: StagedTextArtifact;
  readonly semantic: StagedTextArtifact;
}): D1PreparedStatement {
  const upstream = exactUpstreamGuard(input.candidate.upstream);
  const generation = exactGenerationGuard(
    input.candidate.listingId,
    input.candidate.generationBoundary!,
  );
  return input.database.prepare(`
    UPDATE listing_enrichment_heads
    SET state = 'pending_embedding', extraction_artifact_id = ?,
        extraction_output_hash = ?, semantic_artifact_id = ?,
        semantic_output_hash = ?, embedding_id = NULL,
        embedding_input_hash = NULL, embedding_vector_hash = NULL,
        head_identity = ?, generation = ?, updated_at = ?
    WHERE listing_id = ? AND head_identity = ? AND generation = ?
      AND enrichment_input_hash = ? AND provenance_target_identity = ?
      AND state = 'pending_text'
      AND EXISTS (
        SELECT 1 FROM ai_artifacts artifact
        WHERE artifact.id = ? AND artifact.subject_type = 'listing'
          AND artifact.subject_id = ? AND artifact.task = ?
          AND artifact.provider_name = ? AND artifact.model_name = ?
          AND artifact.prompt_version = ? AND artifact.input_hash = ?
          AND artifact.output_text IS ? AND artifact.output_json IS ?
          AND artifact.output_hash IS ? AND artifact.generated_at = ?
      )
      AND EXISTS (
        SELECT 1 FROM ai_artifacts artifact
        WHERE artifact.id = ? AND artifact.subject_type = 'listing'
          AND artifact.subject_id = ? AND artifact.task = ?
          AND artifact.provider_name = ? AND artifact.model_name = ?
          AND artifact.prompt_version = ? AND artifact.input_hash = ?
          AND artifact.output_text IS ? AND artifact.output_json IS ?
          AND artifact.output_hash IS ? AND artifact.generated_at = ?
      )
      AND ${upstream.sql}
      AND ${generation.sql}
  `).bind(
    input.resultingHead.extractionArtifactId,
    input.resultingHead.extractionOutputHash,
    input.resultingHead.semanticArtifactId,
    input.resultingHead.semanticOutputHash,
    input.resultingHead.headIdentity,
    input.resultingHead.generation,
    input.resultingHead.updatedAt,
    input.candidate.listingId,
    input.candidate.head.headIdentity,
    input.candidate.head.generation,
    input.candidate.head.enrichmentInputHash,
    input.candidate.head.provenanceTargetIdentity,
    ...artifactBindings(input.extraction),
    ...artifactBindings(input.semantic),
    ...upstream.bindings,
    ...generation.bindings,
  );
}

function artifactBindings(artifact: StagedTextArtifact): readonly unknown[] {
  return [
    artifact.id,
    artifact.listingId,
    artifact.task,
    artifact.providerName,
    artifact.modelName,
    artifact.promptVersion,
    artifact.inputHash,
    artifact.outputText,
    artifact.outputJson,
    artifact.outputHash,
    artifact.generatedAt,
  ];
}

function guardedExactClaimCompletionStatement(
  database: D1Database,
  claim: PipelineWorkClaimIdentity,
  head: ListingEnrichmentHead,
): D1PreparedStatement {
  return database.prepare(`
    DELETE FROM pipeline_work_items
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND lease_owner = ? AND claimed_input_hash = ? AND claimed_revision = ?
      AND input_hash = ? AND revision = ?
      AND EXISTS (
        SELECT 1 FROM listing_enrichment_heads head
        WHERE head.listing_id = ? AND head.head_identity = ? AND head.generation = ?
      )
  `).bind(
    claim.stage,
    claim.subjectType,
    claim.subjectId,
    claim.owner,
    claim.inputHash,
    claim.revision,
    claim.inputHash,
    claim.revision,
    head.listingId,
    head.headIdentity,
    head.generation,
  );
}

function exactEmbeddingClaimStatement(input: {
  readonly database: D1Database;
  readonly owner: string;
  readonly leaseMs: number;
  readonly inputHash: string;
  readonly head: ListingEnrichmentHead;
  readonly now: Date;
}): D1PreparedStatement {
  const nowIso = input.now.toISOString();
  return input.database.prepare(`
    UPDATE pipeline_work_items
    SET lease_owner = ?, lease_expires_at = ?, claimed_input_hash = input_hash,
        claimed_revision = revision, last_claimed_at = ?, updated_at = ?
    WHERE stage = 'enrichment_embedding' AND subject_type = 'listing'
      AND subject_id = ? AND input_hash = ? AND available_at <= ?
      AND (lease_owner IS NULL OR lease_expires_at <= ?)
      AND EXISTS (
        SELECT 1 FROM listing_enrichment_heads head
        WHERE head.listing_id = ? AND head.head_identity = ? AND head.generation = ?
      )
  `).bind(
    input.owner,
    new Date(input.now.getTime() + input.leaseMs).toISOString(),
    nowIso,
    nowIso,
    input.head.listingId,
    input.inputHash,
    nowIso,
    nowIso,
    input.head.listingId,
    input.head.headIdentity,
    input.head.generation,
  );
}

function commitGuardStatement(
  database: D1Database,
  head: ListingEnrichmentHead,
  owner: string,
  embeddingInputHash: string,
): D1PreparedStatement {
  return database.prepare(`
    SELECT CASE WHEN
      EXISTS (
        SELECT 1 FROM listing_enrichment_heads
        WHERE listing_id = ? AND head_identity = ? AND generation = ?
      ) AND EXISTS (
        SELECT 1 FROM pipeline_work_items
        WHERE stage = 'enrichment_embedding' AND subject_type = 'listing'
          AND subject_id = ? AND input_hash = ? AND lease_owner = ?
          AND claimed_input_hash = input_hash AND claimed_revision = revision
      )
      THEN json('null') ELSE json('enrichment_text_commit_stale') END AS exact_guard
  `).bind(
    head.listingId,
    head.headIdentity,
    head.generation,
    head.listingId,
    embeddingInputHash,
    owner,
  );
}

async function readExactOwnedEmbeddingClaim(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly owner: string;
  readonly inputHash: string;
}): Promise<PipelineWorkClaimIdentity> {
  const row = await input.database.prepare(`
    SELECT revision FROM pipeline_work_items
    WHERE stage = 'enrichment_embedding' AND subject_type = 'listing'
      AND subject_id = ? AND input_hash = ? AND lease_owner = ?
      AND claimed_input_hash = input_hash AND claimed_revision = revision
  `).bind(input.listingId, input.inputHash, input.owner).first<{ revision: number }>();
  if (row === null) throw new Error(`Embedding work could not be claimed for ${input.listingId}`);
  return Object.freeze({
    stage: "enrichment_embedding",
    subjectType: "listing",
    subjectId: input.listingId,
    owner: input.owner,
    inputHash: input.inputHash,
    revision: Number(row.revision),
  });
}

function exactUpstreamGuard(upstream: CandidateUpstreamIdentity): {
  readonly sql: string;
  readonly bindings: readonly unknown[];
} {
  return {
    sql: `EXISTS (
      SELECT 1
      FROM listing_current_pipeline_state pipeline
      JOIN listing_details detail ON detail.listing_id = pipeline.listing_id
      JOIN listing_detail_observations observation
        ON observation.listing_id = pipeline.listing_id
        AND observation.detail_content_hash = detail.content_hash
      JOIN source_current_listings current_inventory
        ON current_inventory.listing_id = pipeline.listing_id
        AND current_inventory.source_id = pipeline.source_id
        AND current_inventory.inventory_run_id = pipeline.active_inventory_run_id
        AND current_inventory.review_candidate = 1
      JOIN source_inventory_publication_heads publication_head
        ON publication_head.source_id = pipeline.source_id
        AND publication_head.inventory_run_id = pipeline.active_inventory_run_id
      JOIN listing_routes route_assignment
        ON route_assignment.listing_id = pipeline.listing_id
        AND route_assignment.route_cache_id = pipeline.route_cache_identity
      JOIN route_cache accepted_route
        ON accepted_route.id = route_assignment.route_cache_id
        AND accepted_route.input_hash = pipeline.route_input_hash
        AND accepted_route.origin_cache_key = ?
        AND accepted_route.provider_name = ?
        AND accepted_route.error_code IS NULL
        AND accepted_route.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
      WHERE pipeline.listing_id = ? AND pipeline.source_id = ?
        AND pipeline.source_current = 1 AND pipeline.review_candidate = 1
        AND pipeline.active_inventory_run_id = ?
        AND pipeline.source_publication_generation = ?
        AND pipeline.accepted_detail_identity = ?
        AND pipeline.accepted_detail_hash = ? AND detail.content_hash = ?
        AND pipeline.route_cache_identity = ?
        AND pipeline.route_assignment_identity = ?
        AND pipeline.route_input_hash = ?
    )`,
    bindings: [
      upstream.originCacheKey,
      upstream.routeProviderName,
      upstream.listingId,
      upstream.sourceId,
      upstream.activeInventoryRunId,
      upstream.sourcePublicationGeneration,
      upstream.acceptedDetailIdentity,
      upstream.acceptedDetailHash,
      upstream.detailContentHash,
      upstream.routeCacheIdentity,
      upstream.routeAssignmentIdentity,
      upstream.routeInputHash,
    ],
  };
}

function exactGenerationGuard(
  listingId: string,
  boundary: ListingGenerationBoundary,
): { readonly sql: string; readonly bindings: readonly unknown[] } {
  return boundary.generation === null
    ? {
        sql: `NOT EXISTS (
          SELECT 1 FROM pipeline_generation_state
          WHERE domain = 'enrichment_target' AND scope_type = 'listing'
            AND scope_id = ?
        )`,
        bindings: [listingId],
      }
    : {
        sql: `EXISTS (
          SELECT 1 FROM pipeline_generation_state
          WHERE domain = 'enrichment_target' AND scope_type = 'listing'
            AND scope_id = ? AND generation = ? AND fingerprint = ?
            AND derivation_version = ?
        )`,
        bindings: [
          listingId,
          boundary.generation,
          boundary.fingerprint,
          boundary.derivationVersion,
        ],
      };
}

async function enrichmentHeadInvalidationStatements(input: {
  database: D1Database;
  sourceId: string;
  head: ListingEnrichmentHead;
  now: Date;
}): Promise<readonly D1PreparedStatement[]> {
  return prepareCanonicalMutationPayloadInvalidationStatements({
    database: input.database,
    generations: [{
      domain: "enrichment_target",
      scopeType: "listing",
      scopeId: input.head.listingId,
      input: {
        listingId: input.head.listingId,
        provenanceTargetIdentity: input.head.provenanceTargetIdentity,
        enrichmentInputHash: input.head.enrichmentInputHash,
        state: input.head.state,
        headIdentity: input.head.headIdentity,
        headGeneration: input.head.generation,
        extractionOutputHash: input.head.extractionOutputHash,
        semanticOutputHash: input.head.semanticOutputHash,
        embeddingInputHash: input.head.embeddingInputHash,
        embeddingVectorHash: input.head.embeddingVectorHash,
      },
      derivationVersion: ENRICHMENT_HEAD_INVALIDATION_VERSION,
    }],
    refresh: {
      target: {
        type: "listing",
        listingId: input.head.listingId,
        sourceId: input.sourceId,
      },
      reasonCode: "enrichment_head_changed",
      priority: 550,
    },
    now: input.now,
  });
}

interface SuppliedEnrichmentClaimInspection {
  readonly work: ClaimedEnrichmentWork | null;
  readonly outcome: SuppliedEnrichmentClaimResult | null;
  readonly staleCount: number;
  readonly countedStaleClaim: boolean;
}

async function inspectSuppliedEnrichmentClaim(input: {
  readonly database: D1Database;
  readonly claim: PipelineWorkClaimIdentity;
  readonly now: Date;
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
}): Promise<SuppliedEnrichmentClaimInspection> {
  const claim = exactEnrichmentClaim(input.claim);
  const row = await input.database.prepare(`
    SELECT stage, subject_type, subject_id, listing_id, source_id,
      input_hash, revision, lease_owner, lease_expires_at,
      claimed_input_hash, claimed_revision
    FROM pipeline_work_items
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
  `).bind(
    claim.stage,
    claim.subjectType,
    claim.subjectId,
  ).first<SuppliedClaimQueueRow>();
  if (row === null) {
    return Object.freeze({
      work: null,
      outcome: suppliedClaimResult(claim, "completed"),
      staleCount: 0,
      countedStaleClaim: false,
    });
  }

  const desiredMatches = row.input_hash === claim.inputHash &&
    Number(row.revision) === claim.revision;
  const claimedMatches = row.lease_owner === claim.owner &&
    row.claimed_input_hash === claim.inputHash &&
    Number(row.claimed_revision) === claim.revision;
  const queueShapeMatches = row.stage === claim.stage &&
    row.subject_type === "listing" && row.subject_id === claim.subjectId &&
    row.listing_id === claim.subjectId && typeof row.source_id === "string" &&
    row.source_id.length > 0;
  const leaseExpired = row.lease_expires_at === null ||
    row.lease_expires_at <= input.now.toISOString();
  if (claimedMatches && leaseExpired) {
    const released = await releaseExpiredSuppliedEnrichmentClaim({
      database: input.database,
      claim,
      leaseExpiresAt: row.lease_expires_at,
      now: input.now,
    });
    return Object.freeze({
      work: null,
      outcome: suppliedClaimResult(claim, "stale_or_obsolete"),
      staleCount: 1,
      countedStaleClaim: released,
    });
  }
  if (desiredMatches && claimedMatches && queueShapeMatches) {
    return Object.freeze({
      work: Object.freeze({
        stage: row.stage,
        listingId: row.listing_id!,
        sourceId: row.source_id!,
        inputHash: row.input_hash,
        revision: Number(row.revision),
        claim,
      }),
      outcome: null,
      staleCount: 0,
      countedStaleClaim: false,
    });
  }

  if (!desiredMatches || (claimedMatches && !queueShapeMatches)) {
    const settlement = claimedMatches
      ? await completePipelineWorkClaim({
          database: input.database,
          claim,
          now: input.now,
          telemetry: input.telemetry,
          telemetryContext: input.telemetryContext,
        })
      : null;
    return Object.freeze({
      work: null,
      outcome: suppliedClaimResult(claim, "stale_or_obsolete"),
      staleCount: 1,
      countedStaleClaim: settlement?.outcome === "stale_released" ||
        settlement?.outcome === "completed",
    });
  }

  return Object.freeze({
    work: null,
    outcome: suppliedClaimResult(claim, "still_pending"),
    staleCount: 0,
    countedStaleClaim: false,
  });
}

async function releaseExpiredSuppliedEnrichmentClaim(input: {
  readonly database: D1Database;
  readonly claim: PipelineWorkClaimIdentity;
  readonly leaseExpiresAt: string | null;
  readonly now: Date;
}): Promise<boolean> {
  const nowIso = input.now.toISOString();
  const result = await input.database.prepare(`
    UPDATE pipeline_work_items
    SET lease_owner = NULL, lease_expires_at = NULL,
        claimed_input_hash = NULL, claimed_revision = NULL,
        updated_at = ?
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND lease_owner = ?
      AND claimed_input_hash = ? AND claimed_revision = ?
      AND input_hash = ? AND revision = ?
      AND (
        (? IS NULL AND lease_expires_at IS NULL)
        OR lease_expires_at = ?
      )
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(
    nowIso,
    input.claim.stage,
    input.claim.subjectType,
    input.claim.subjectId,
    input.claim.owner,
    input.claim.inputHash,
    input.claim.revision,
    input.claim.inputHash,
    input.claim.revision,
    input.leaseExpiresAt,
    input.leaseExpiresAt,
    nowIso,
  ).run();
  return changes(result) === 1;
}

function exactEnrichmentClaim(
  claim: PipelineWorkClaimIdentity,
): PipelineWorkClaimIdentity {
  if (
    (claim.stage !== "enrichment_text" &&
      claim.stage !== "enrichment_embedding") ||
    claim.subjectType !== "listing"
  ) {
    throw new RangeError("supplied enrichment work claim has an invalid scope");
  }
  return Object.freeze({
    stage: claim.stage,
    subjectType: "listing",
    subjectId: boundedClaimText(claim.subjectId, "subject id", 512),
    owner: boundedClaimText(claim.owner, "owner", 256),
    inputHash: boundedClaimText(claim.inputHash, "input hash", 512),
    revision: requiredPositiveSafeInteger(claim.revision, "revision"),
  });
}

function suppliedClaimResult(
  claim: PipelineWorkClaimIdentity,
  outcome: SuppliedEnrichmentClaimOutcome,
): SuppliedEnrichmentClaimResult {
  return Object.freeze({ claim, outcome });
}

function samePipelineWorkClaim(
  left: PipelineWorkClaimIdentity,
  right: PipelineWorkClaimIdentity,
): boolean {
  return left.stage === right.stage && left.subjectType === right.subjectType &&
    left.subjectId === right.subjectId && left.owner === right.owner &&
    left.inputHash === right.inputHash && left.revision === right.revision;
}

async function resolveEnrichmentRouteIdentity(input: {
  readonly database: D1Database;
  readonly originCacheKey?: string;
  readonly routeProviderName?: string;
}): Promise<EnrichmentRouteIdentity> {
  if (
    (input.originCacheKey === undefined) !==
      (input.routeProviderName === undefined)
  ) {
    throw new RangeError("enrichment route identity must be supplied as one exact tuple");
  }
  if (
    input.originCacheKey !== undefined &&
    input.routeProviderName !== undefined
  ) {
    return Object.freeze({
      originCacheKey: boundedRouteIdentityText(
        input.originCacheKey,
        "origin cache key",
        512,
      ),
      providerName: boundedRouteIdentityText(
        input.routeProviderName,
        "route provider name",
        128,
      ),
    });
  }

  const active = await input.database.prepare(`
    SELECT origin_postal_code, origin_country
    FROM app_settings WHERE singleton = 1
  `).first<{ origin_postal_code: string; origin_country: string }>();
  if (active === null) throw new Error("enrichment_active_route_identity_missing");
  const countryCode = active.origin_country.trim().toUpperCase();
  if (countryCode !== "US") {
    throw new Error("enrichment_active_route_identity_invalid");
  }
  return Object.freeze({
    originCacheKey: locationCacheKey({
      postalCode: active.origin_postal_code,
      countryCode,
    }),
    providerName: boundedRouteIdentityText(
      getConfig().routing.routeProvider,
      "route provider name",
      128,
    ),
  });
}

function boundedRouteIdentityText(
  value: string,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > maximumLength || value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new RangeError(`enrichment ${label} is invalid`);
  return value;
}

/**
 * Read-only proof that the next full production selection is exactly 100
 * canonical text inputs. The receipt contains only the bounded target identity,
 * hashes, and a count; it never exposes listing identity, source evidence, or
 * provider input.
 */
export async function readEnrichmentQueueSessionPreflight(input: {
  readonly database: D1Database;
  readonly providers: AiProviders;
  readonly embeddingDimensions?: number;
  readonly originCacheKey?: string;
  readonly routeProviderName?: string;
  readonly now?: Date;
}): Promise<EnrichmentQueueSelectionFingerprint> {
  const routeIdentity = await resolveEnrichmentRouteIdentity({
    database: input.database,
    originCacheKey: input.originCacheKey,
    routeProviderName: input.routeProviderName,
  });
  const target = await enrichmentSessionProvenanceTarget(
    input.providers,
    input.embeddingDimensions,
  );
  const selection = await readExactEnrichmentSessionSelection({
    database: input.database,
    now: input.now ?? new Date(),
    limit: MAX_SESSION_ITEMS,
    routeIdentity,
  });
  if (selection.rows.length !== MAX_SESSION_ITEMS) {
    throw new Error("enrichment_queue_preflight_requires_100_rows");
  }
  if (selection.rows.some((row) => row.stage !== "enrichment_text")) {
    throw new Error("enrichment_queue_preflight_requires_all_text_rows");
  }
  const claims = selection.rows.map((row): ClaimedEnrichmentWork => ({
    stage: row.stage,
    listingId: row.listing_id,
    sourceId: row.source_id,
    inputHash: row.input_hash,
    revision: row.revision,
    claim: Object.freeze({
      stage: row.stage,
      subjectType: "listing",
      subjectId: row.subject_id,
      owner: "read-only-preflight",
      inputHash: row.input_hash,
      revision: row.revision,
    }),
  }));
  const loaded = await loadSessionCandidates({
    database: input.database,
    claims,
    routeIdentity,
  });
  if (
    loaded.unavailableClaims.length !== 0 ||
    loaded.candidates.length !== MAX_SESSION_ITEMS
  ) throw new Error("enrichment_queue_preflight_canonical_input_invalid");
  for (const candidate of loaded.candidates) {
    if (
      candidate.projectionEnrichmentInputHash !== candidate.inputHash ||
      candidate.detailProjection.enrichmentTextWorkInputHash !== candidate.inputHash
    ) throw new Error("enrichment_queue_preflight_projection_input_stale");
  }
  return enrichmentSelectionFingerprint({
    database: input.database,
    selection: selection.rows,
    loaded: loaded.candidates,
    targetIdentity: target.identity,
  });
}

async function readExactEnrichmentSessionSelection(input: {
  readonly database: D1Database;
  readonly now: Date;
  readonly limit: number;
  readonly routeIdentity: EnrichmentRouteIdentity;
  readonly suppliedSubjectId?: string;
}): Promise<ExactQueueSelection> {
  const suppliedExclusion = input.suppliedSubjectId === undefined
    ? ""
    : "AND subject_id <> ?";
  const suppliedBindings = input.suppliedSubjectId === undefined
    ? []
    : [input.suppliedSubjectId];
  const nowIso = input.now.toISOString();
  const result = await input.database.prepare(`
    WITH ${EXACT_CURRENT_ENRICHMENT_WORK_CTE_SQL}, queue_total AS (
      SELECT COUNT(*) AS total FROM eligible_work
    ), ready AS (
      SELECT stage, subject_id, listing_id, source_id, input_hash, revision
      FROM eligible_work
      WHERE available_at <= ?
        AND (lease_owner IS NULL OR lease_expires_at <= ?)
        ${suppliedExclusion}
      ORDER BY stage, available_at, priority DESC, updated_at, subject_id
      LIMIT ?
    )
    SELECT queue_total.total AS queue_total,
      ready.stage, ready.subject_id, ready.listing_id, ready.source_id,
      ready.input_hash, ready.revision
    FROM queue_total LEFT JOIN ready ON 1 = 1
  `).bind(
    input.routeIdentity.originCacheKey,
    input.routeIdentity.providerName,
    nowIso,
    nowIso,
    ...suppliedBindings,
    input.limit,
  ).all<QueueSelectionRow>();
  const rows = result.results ?? [];
  return Object.freeze({
    total: Number(rows[0]?.queue_total ?? 0),
    rows: Object.freeze(rows.flatMap((row): ExactQueueSelectionRow[] =>
      row.stage === null || row.subject_id === null || row.listing_id === null ||
        row.source_id === null || row.input_hash === null || row.revision === null
        ? []
        : [Object.freeze({
            stage: row.stage,
            subject_id: row.subject_id,
            listing_id: row.listing_id,
            source_id: row.source_id,
            input_hash: row.input_hash,
            revision: Number(row.revision),
          })]
    )),
  });
}

async function enrichmentSelectionFingerprint(input: {
  readonly database: D1Database;
  readonly selection: readonly ExactQueueSelectionRow[];
  readonly loaded: readonly LoadedSessionCandidate[];
  readonly targetIdentity: string;
}): Promise<EnrichmentQueueSelectionFingerprint> {
  if (input.loaded.length !== input.selection.length) {
    throw new Error("enrichment_queue_preflight_canonical_input_invalid");
  }
  const loadedById = new Map(input.loaded.map((row) => [row.listingId, row]));
  const ordered = input.selection.map((row) => {
    const candidate = loadedById.get(row.listing_id);
    if (
      candidate === undefined || candidate.stage !== row.stage ||
      candidate.sourceId !== row.source_id || candidate.inputHash !== row.input_hash ||
      candidate.revision !== row.revision
    ) throw new Error("enrichment_queue_preflight_selection_changed");
    return candidate;
  });
  const boundaries = await Promise.all(ordered.map((candidate) =>
    readListingEnrichmentGenerationBoundary(input.database, candidate.listingId)
  ));
  const orderedSelectionHash = await hashCanonicalJson(input.selection.map((row) => ({
    stage: row.stage,
    subjectId: row.subject_id,
    listingId: row.listing_id,
    sourceId: row.source_id,
    inputHash: row.input_hash,
    revision: row.revision,
  })));
  const inputHash = await hashCanonicalJson(ordered.map((candidate) => ({
    inputHash: candidate.inputHash,
    detail: candidate.detail,
    upstreamInputHash: candidate.upstreamInputHash,
  })));
  const projectionTargetHash = await hashCanonicalJson(ordered.map((candidate) => ({
    enrichmentInputHash: candidate.projectionEnrichmentInputHash,
    enrichmentHeadIdentity: candidate.detailProjection.enrichmentHeadIdentity,
    textWorkInputHash: candidate.detailProjection.enrichmentTextWorkInputHash,
    embeddingWorkInputHash:
      candidate.detailProjection.enrichmentEmbeddingWorkInputHash,
  })));
  const listingGenerationHash = await hashCanonicalJson(boundaries);
  const generationVectorHash =
    (await readCompactPipelineGenerationVector(input.database)).hash;
  const aggregateHash = await hashCanonicalJson({
    selectedCount: input.selection.length,
    orderedSelectionHash,
    inputHash,
    projectionTargetHash,
    targetIdentity: input.targetIdentity,
    listingGenerationHash,
    generationVectorHash,
  });
  return Object.freeze({
    selectedCount: input.selection.length,
    aggregateHash,
    orderedSelectionHash,
    inputHash,
    projectionTargetHash,
    targetIdentity: input.targetIdentity,
    listingGenerationHash,
    generationVectorHash,
  });
}

async function claimEnrichmentSessionWork(input: {
  database: D1Database;
  owner: string;
  limit: number;
  leaseMs: number;
  routeIdentity: EnrichmentRouteIdentity;
  now: Date;
  suppliedClaim?: PipelineWorkClaimIdentity;
  telemetry?: PerformanceTelemetrySink;
  telemetryContext?: PerformanceTelemetryContext;
}): Promise<{
  total: number;
  rows: readonly ExactQueueSelectionRow[];
  claims: readonly ClaimedEnrichmentWork[];
}> {
  const telemetryStartedAt = performance.now();
  const nowIso = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
  const selection = await readExactEnrichmentSessionSelection({
    database: input.database,
    now: input.now,
    limit: input.limit,
    routeIdentity: input.routeIdentity,
    suppliedSubjectId: input.suppliedClaim?.subjectId,
  });
  const total = selection.total;
  const selected = selection.rows;
  if (selected.length === 0) {
    input.telemetry?.record({
      context: input.telemetryContext,
      details: {
        kind: "queue",
        operation: "claim",
        stage: "enrichment",
        created: 0,
        upserted: 0,
        selected: 0,
        claimed: 0,
        completed: 0,
        deferred: 0,
        failed: 0,
        reclaimed: 0,
        remaining: total,
        statements: 1,
        batches: 0,
        durationMs: performance.now() - telemetryStartedAt,
      },
    });
    return {
      total,
      rows: Object.freeze([]),
      claims: Object.freeze([]),
    };
  }
  const writes = await input.database.batch(selected.map((row) =>
    input.database.prepare(`
      UPDATE pipeline_work_items
      SET lease_owner = ?, lease_expires_at = ?,
          claimed_input_hash = input_hash, claimed_revision = revision,
          last_claimed_at = ?, updated_at = ?
      WHERE stage = ? AND subject_type = 'listing' AND subject_id = ?
        AND input_hash = ? AND revision = ? AND available_at <= ?
        AND (lease_owner IS NULL OR lease_expires_at <= ?)
    `).bind(
      input.owner,
      expiresAt,
      nowIso,
      nowIso,
      row.stage,
      row.subject_id,
      row.input_hash,
      row.revision,
      nowIso,
      nowIso,
    )
  ));
  const claims = selected.flatMap((row, index) => {
    if (changes(writes[index]) !== 1) return [];
    const claim: PipelineWorkClaimIdentity = Object.freeze({
      stage: row.stage,
      subjectType: "listing",
      subjectId: row.subject_id,
      owner: input.owner,
      inputHash: row.input_hash,
      revision: row.revision,
    });
    return [{
      stage: row.stage,
      listingId: row.listing_id,
      sourceId: row.source_id,
      inputHash: row.input_hash,
      revision: row.revision,
      claim,
    }];
  });
  input.telemetry?.record({
    context: input.telemetryContext,
    details: {
      kind: "queue",
      operation: "claim",
      stage: "enrichment",
      created: 0,
      upserted: 0,
      selected: selected.length,
      claimed: claims.length,
      completed: 0,
      deferred: 0,
      failed: 0,
      reclaimed: 0,
      remaining: total,
      statements: 1 + selected.length,
      batches: 1,
      durationMs: performance.now() - telemetryStartedAt,
    },
  });
  return {
    total,
    rows: selected,
    claims: Object.freeze(claims),
  };
}

interface EnrichmentModelMeasurements {
  readonly text: Readonly<{
    readonly healthMs: number;
    readonly loadCount: number;
    readonly unloadCount: number;
    readonly loadMs: number;
    readonly generationMs: number;
    readonly embeddingMs: number;
    readonly unloadMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly usageComplete: boolean;
  }>;
  readonly embedding: Readonly<{
    readonly healthMs: number;
    readonly loadCount: number;
    readonly unloadCount: number;
    readonly loadMs: number;
    readonly generationMs: number;
    readonly embeddingMs: number;
    readonly unloadMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly usageComplete: boolean;
  }>;
}

function emptyModelMeasurements(): EnrichmentModelMeasurements {
  const empty = Object.freeze({
    healthMs: 0,
    loadCount: 0,
    unloadCount: 0,
    loadMs: 0,
    generationMs: 0,
    embeddingMs: 0,
    unloadMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    usageComplete: true,
  });
  return Object.freeze({ text: empty, embedding: empty });
}

function recordEnrichmentModelTelemetry(
  options: QueueBackedEnrichmentSessionOptions,
  measurements: EnrichmentModelMeasurements,
): void {
  for (const role of ["text", "embedding"] as const) {
    const measured = measurements[role];
    if (options.telemetry !== undefined && !measured.usageComplete) {
      throw new Error(`exact ${role} provider usage telemetry is unavailable`);
    }
    options.telemetry?.record({
      context: options.telemetryContext,
      details: {
        kind: "model",
        role,
        loadCount: measured.loadCount,
        unloadCount: measured.unloadCount,
        healthMs: measured.healthMs,
        loadMs: measured.loadMs,
        generationMs: measured.generationMs,
        embeddingMs: measured.embeddingMs,
        unloadMs: measured.unloadMs,
        inputTokens: measured.inputTokens,
        outputTokens: measured.outputTokens,
      },
    });
  }
}

function exactProviderUsage(usage: GenerationUsage | undefined): Required<GenerationUsage> | null {
  if (
    usage === undefined ||
    !nonnegativeFinite(usage.loadDurationMs) ||
    !nonnegativeInteger(usage.inputTokens) ||
    !nonnegativeInteger(usage.outputTokens) ||
    !nonnegativeFinite(usage.totalDurationMs)
  ) return null;
  return {
    loadDurationMs: usage.loadDurationMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalDurationMs: usage.totalDurationMs,
  };
}

function nonnegativeFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonnegativeInteger(value: number | undefined): value is number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0;
}

function recordEnrichmentStageTelemetry(
  options: QueueBackedEnrichmentSessionOptions,
  startedAt: number,
  outcome: "completed" | "failed" | "skipped",
  reasonCode: string,
): void {
  options.telemetry?.record({
    context: options.telemetryContext,
    details: {
      kind: "stage",
      stage: "enrichment_queue_session",
      outcome,
      durationMs: performance.now() - startedAt,
      reasonCode,
    },
  });
}

async function loadSessionCandidates(input: {
  database: D1Database;
  claims: readonly ClaimedEnrichmentWork[];
  routeIdentity: EnrichmentRouteIdentity;
}): Promise<{
  readonly candidates: readonly LoadedSessionCandidate[];
  readonly unavailableClaims: readonly PipelineWorkClaimIdentity[];
}> {
  const ids = [...new Set(input.claims.map((claim) => claim.listingId))];
  const rows: CandidateRow[] = [];
  for (let offset = 0; offset < ids.length; offset += CANDIDATE_LOAD_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + CANDIDATE_LOAD_BATCH_SIZE);
    const result = await input.database.prepare(`
    SELECT
      pipeline.listing_id, pipeline.source_id, pipeline.enrichment_input_hash,
      pipeline.enrichment_head_identity,
      pipeline.enrichment_text_work_input_hash,
      pipeline.enrichment_embedding_work_input_hash,
      pipeline.active_inventory_run_id, pipeline.source_publication_generation,
      pipeline.accepted_detail_identity, pipeline.accepted_detail_hash,
      pipeline.route_cache_identity, pipeline.route_assignment_identity,
      pipeline.route_input_hash, accepted_route.origin_cache_key,
      accepted_route.provider_name AS route_provider_name,
      stub.source_listing_id, stub.source_url,
      COALESCE(observation.title, detail.title_at_scrape) AS title_at_scrape,
      detail.category_at_scrape, detail.lot_number_at_scrape,
      detail.raw_description, detail.clean_description,
      detail.price_amount_minor, detail.price_currency, detail.price_display_text,
      CASE
        WHEN observation.listing_id IS NOT NULL THEN observation.auction_ends_at
        ELSE detail.auction_ends_at
      END AS auction_ends_at,
      detail.seller, detail.pickup_city, detail.pickup_state,
      detail.pickup_postal_code, detail.pickup_country_code,
      detail.pickup_evidence_source, detail.scraped_at, detail.content_hash
    FROM listing_current_pipeline_state pipeline
    JOIN listing_stubs stub ON stub.id = pipeline.listing_id
    JOIN listing_details detail ON detail.listing_id = pipeline.listing_id
    JOIN listing_detail_observations observation
      ON observation.listing_id = pipeline.listing_id
      AND observation.detail_content_hash = detail.content_hash
    JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = pipeline.listing_id
      AND current_inventory.source_id = pipeline.source_id
      AND current_inventory.inventory_run_id = pipeline.active_inventory_run_id
      AND current_inventory.review_candidate = 1
    JOIN source_inventory_publication_heads publication_head
      ON publication_head.source_id = pipeline.source_id
      AND publication_head.inventory_run_id = pipeline.active_inventory_run_id
    JOIN listing_routes route_assignment
      ON route_assignment.listing_id = pipeline.listing_id
      AND route_assignment.route_cache_id = pipeline.route_cache_identity
      JOIN route_cache accepted_route
        ON accepted_route.id = route_assignment.route_cache_id
        AND accepted_route.input_hash = pipeline.route_input_hash
        AND accepted_route.origin_cache_key = ?
        AND accepted_route.provider_name = ?
        AND accepted_route.error_code IS NULL
        AND accepted_route.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
    WHERE pipeline.listing_id IN (${chunk.map(() => "?").join(", ")})
      AND pipeline.source_current = 1 AND pipeline.review_candidate = 1
      AND pipeline.active_inventory_run_id IS NOT NULL
      AND pipeline.source_publication_generation IS NOT NULL
      AND pipeline.accepted_detail_identity IS NOT NULL
      AND pipeline.accepted_detail_hash = detail.content_hash
      AND pipeline.route_cache_identity IS NOT NULL
      AND pipeline.route_assignment_identity IS NOT NULL
      AND pipeline.route_input_hash IS NOT NULL
  `).bind(
    input.routeIdentity.originCacheKey,
    input.routeIdentity.providerName,
    ...chunk,
  ).all<CandidateRow>();
    rows.push(...result.results ?? []);
  }
  const byId = new Map(rows.map((row) => [row.listing_id, row]));
  const candidates: LoadedSessionCandidate[] = [];
  const unavailableClaims: PipelineWorkClaimIdentity[] = [];
  for (const claim of input.claims) {
    const row = byId.get(claim.listingId);
    if (row === undefined || row.source_id !== claim.sourceId ||
        row.enrichment_input_hash === null) {
      unavailableClaims.push(claim.claim);
      continue;
    }
    let detail: NormalizedListingDetail;
    try {
      detail = detailFromRow(row);
    } catch {
      unavailableClaims.push(claim.claim);
      continue;
    }
    const upstream = upstreamIdentityFromRow(row);
    candidates.push({
      ...claim,
      projectionEnrichmentInputHash: row.enrichment_input_hash,
      detailProjection: {
        enrichmentHeadIdentity: row.enrichment_head_identity,
        enrichmentTextWorkInputHash: row.enrichment_text_work_input_hash,
        enrichmentEmbeddingWorkInputHash: row.enrichment_embedding_work_input_hash,
      },
      detail,
      upstream,
      upstreamInputHash: await hashCanonicalJson(upstream),
    });
  }
  return Object.freeze({
    candidates: Object.freeze(candidates),
    unavailableClaims: Object.freeze(unavailableClaims),
  });
}

async function releaseSessionClaimsAfterLoadFailure(input: {
  readonly database: D1Database;
  readonly claims: readonly PipelineWorkClaimIdentity[];
  readonly now: Date;
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
}): Promise<void> {
  const failures: unknown[] = [];
  for (const claim of input.claims) {
    let settled = false;
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt < LOAD_FAILURE_SETTLEMENT_ATTEMPTS && !settled;
      attempt += 1
    ) {
      try {
        await deferPipelineWorkClaim({
          database: input.database,
          claim,
          availableAt: input.now,
          now: input.now,
          telemetry: input.telemetry,
          telemetryContext: input.telemetryContext,
        });
        settled = true;
      } catch (error) {
        lastError = error;
      }
    }
    if (!settled) failures.push(lastError);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "one or more enrichment claims could not be released after candidate loading failed",
    );
  }
}

function detailFromRow(row: CandidateRow): NormalizedListingDetail {
  for (const value of [
    row.source_listing_id,
    row.source_url,
    row.title_at_scrape,
    row.scraped_at,
    row.content_hash,
  ]) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error("enrichment_candidate_detail_invalid");
    }
  }
  if (
    typeof row.raw_description !== "string" ||
    typeof row.clean_description !== "string"
  ) throw new Error("enrichment_candidate_detail_invalid");
  const storedCountryCode = row.pickup_country_code || "US";
  const pickupLocation: LocationCandidate | null =
    !row.pickup_city && !row.pickup_state && !row.pickup_postal_code
      ? null
      : {
          city: row.pickup_city,
          state: row.pickup_state,
          postalCode: row.pickup_postal_code,
          countryCode: storedCountryCode,
          evidenceSource: storedLocationEvidenceSource(
            row.pickup_evidence_source,
          ),
        };
  return {
    sourceId: row.source_id,
    sourceListingId: row.source_listing_id,
    sourceUrl: row.source_url,
    title: row.title_at_scrape,
    category: row.category_at_scrape,
    lotNumber: row.lot_number_at_scrape,
    rawDescription: row.raw_description,
    cleanDescription: row.clean_description,
    priceAtScrape: {
      amountMinor: row.price_amount_minor,
      currency: row.price_currency,
      displayText: row.price_display_text,
    },
    auctionEndsAt: row.auction_ends_at,
    seller: row.seller,
    pickupLocation,
    images: [],
    scrapedAt: row.scraped_at,
    contentHash: row.content_hash,
  };
}

function upstreamIdentityFromRow(row: CandidateRow): CandidateUpstreamIdentity {
  return Object.freeze({
    listingId: row.listing_id,
    sourceId: row.source_id,
    activeInventoryRunId: row.active_inventory_run_id,
    sourcePublicationGeneration: Number(row.source_publication_generation),
    acceptedDetailIdentity: row.accepted_detail_identity,
    acceptedDetailHash: row.accepted_detail_hash,
    detailContentHash: row.content_hash,
    routeCacheIdentity: row.route_cache_identity,
    routeAssignmentIdentity: row.route_assignment_identity,
    routeInputHash: row.route_input_hash,
    originCacheKey: row.origin_cache_key,
    routeProviderName: row.route_provider_name,
  });
}

async function assertCandidatesUpstreamCurrent(
  database: D1Database,
  candidates: readonly EnrichmentSessionCandidate[],
): Promise<void> {
  for (const candidate of candidates) {
    await assertCandidateUpstreamCurrent(database, candidate);
  }
}

async function assertCandidateUpstreamCurrent(
  database: D1Database,
  candidate: EnrichmentSessionCandidate,
): Promise<void> {
  const current = await readCandidateUpstreamIdentity(
    database,
    candidate.listingId,
    {
      originCacheKey: candidate.upstream.originCacheKey,
      providerName: candidate.upstream.routeProviderName,
    },
  );
  if (
    current === null || await hashCanonicalJson(current) !== candidate.upstreamInputHash
  ) throw new Error("enrichment_staged_upstream_input_stale");
}

async function readCandidateUpstreamIdentity(
  database: D1Database,
  listingId: string,
  routeIdentity: EnrichmentRouteIdentity,
): Promise<CandidateUpstreamIdentity | null> {
  const row = await database.prepare(`
    SELECT
      pipeline.listing_id, pipeline.source_id,
      pipeline.active_inventory_run_id, pipeline.source_publication_generation,
      pipeline.accepted_detail_identity, pipeline.accepted_detail_hash,
      detail.content_hash,
      pipeline.route_cache_identity, pipeline.route_assignment_identity,
      pipeline.route_input_hash, accepted_route.origin_cache_key,
      accepted_route.provider_name AS route_provider_name
    FROM listing_current_pipeline_state pipeline
    JOIN listing_details detail ON detail.listing_id = pipeline.listing_id
    JOIN listing_detail_observations observation
      ON observation.listing_id = pipeline.listing_id
      AND observation.detail_content_hash = detail.content_hash
    JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = pipeline.listing_id
      AND current_inventory.source_id = pipeline.source_id
      AND current_inventory.inventory_run_id = pipeline.active_inventory_run_id
      AND current_inventory.review_candidate = 1
    JOIN source_inventory_publication_heads publication_head
      ON publication_head.source_id = pipeline.source_id
      AND publication_head.inventory_run_id = pipeline.active_inventory_run_id
    JOIN listing_routes route_assignment
      ON route_assignment.listing_id = pipeline.listing_id
      AND route_assignment.route_cache_id = pipeline.route_cache_identity
      JOIN route_cache accepted_route
        ON accepted_route.id = route_assignment.route_cache_id
        AND accepted_route.input_hash = pipeline.route_input_hash
        AND accepted_route.origin_cache_key = ?
        AND accepted_route.provider_name = ?
        AND accepted_route.error_code IS NULL
        AND accepted_route.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
    WHERE pipeline.listing_id = ?
      AND pipeline.source_current = 1 AND pipeline.review_candidate = 1
      AND pipeline.active_inventory_run_id IS NOT NULL
      AND pipeline.source_publication_generation IS NOT NULL
      AND pipeline.accepted_detail_identity IS NOT NULL
      AND pipeline.accepted_detail_hash = detail.content_hash
      AND pipeline.route_cache_identity IS NOT NULL
      AND pipeline.route_assignment_identity IS NOT NULL
      AND pipeline.route_input_hash IS NOT NULL
  `).bind(
    routeIdentity.originCacheKey,
    routeIdentity.providerName,
    listingId,
  ).first<CandidateRow>();
  return row === null ? null : upstreamIdentityFromRow(row);
}

function storedLocationEvidenceSource(
  value: string | null,
): LocationEvidenceSource {
  return value && (locationEvidenceSources as readonly string[]).includes(value)
    ? value as LocationEvidenceSource
    : "unknown";
}

async function renewActiveClaims(
  database: D1Database,
  candidates: readonly EnrichmentSessionCandidate[],
  leaseMs: number,
  now: Date,
): Promise<void> {
  const active = candidates.flatMap((candidate) =>
    candidate.activeClaim === null ? [] : [candidate.activeClaim]
  );
  if (active.length === 0) return;
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const writes = await database.batch(active.map((claim) => database.prepare(`
    UPDATE pipeline_work_items SET lease_expires_at = ?, updated_at = ?
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND lease_owner = ? AND claimed_input_hash = ? AND claimed_revision = ?
      AND lease_expires_at > ?
  `).bind(
    expiresAt,
    nowIso,
    claim.stage,
    claim.subjectType,
    claim.subjectId,
    claim.owner,
    claim.inputHash,
    claim.revision,
    nowIso,
  )));
  if (writes.some((result) => changes(result) !== 1)) {
    throw new Error("An exact enrichment work lease was lost");
  }
}

async function assertClaimCurrent(
  database: D1Database,
  claim: PipelineWorkClaimIdentity,
  now: Date,
): Promise<void> {
  const row = await database.prepare(`
    SELECT 1 AS exact
    FROM pipeline_work_items
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND lease_owner = ? AND claimed_input_hash = ? AND claimed_revision = ?
      AND input_hash = ? AND revision = ? AND lease_expires_at > ?
  `).bind(
    claim.stage,
    claim.subjectType,
    claim.subjectId,
    claim.owner,
    claim.inputHash,
    claim.revision,
    claim.inputHash,
    claim.revision,
    now.toISOString(),
  ).first<{ exact: number }>();
  if (row === null) throw new Error(`The enrichment work revision for ${claim.subjectId} is stale`);
}

function exactClaimCompletionStatement(
  database: D1Database,
  claim: PipelineWorkClaimIdentity,
): D1PreparedStatement {
  return database.prepare(`
    DELETE FROM pipeline_work_items
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND lease_owner = ? AND claimed_input_hash = ? AND claimed_revision = ?
      AND input_hash = ? AND revision = ?
  `).bind(
    claim.stage,
    claim.subjectType,
    claim.subjectId,
    claim.owner,
    claim.inputHash,
    claim.revision,
    claim.inputHash,
    claim.revision,
  );
}

async function completeObsoleteClaims(
  database: D1Database,
  claims: readonly PipelineWorkClaimIdentity[],
  now: Date,
  telemetry?: PerformanceTelemetrySink,
  telemetryContext?: PerformanceTelemetryContext,
): Promise<void> {
  for (const claim of claims) {
    await completePipelineWorkClaim({
      database,
      claim,
      now,
      telemetry,
      telemetryContext,
    });
  }
}

async function settleFailedSessionClaims(input: {
  database: D1Database;
  candidates: readonly EnrichmentSessionCandidate[];
  failedListingId: string | null;
  failureCandidates: readonly EnrichmentSessionCandidate[];
  failureClassification?: EnrichmentFailureClassification;
  invalidTextAttempts: readonly PendingEnrichmentArtifact[];
  message: string;
  now: Date;
  telemetry?: PerformanceTelemetrySink;
  telemetryContext?: PerformanceTelemetryContext;
  routeIdentity: EnrichmentRouteIdentity;
}): Promise<{
  readonly terminalizedListingId: string | null;
  readonly remaining: number;
}> {
  const explicitFailures = new Set(
    input.failureCandidates.map((candidate) => candidate.listingId),
  );
  if (input.failedListingId !== null) explicitFailures.add(input.failedListingId);
  const systemicProviderContractFailure =
    input.failureClassification === "systemic_provider_contract";
  if (systemicProviderContractFailure && input.invalidTextAttempts.length > 0) {
    await input.database.batch(
      input.invalidTextAttempts.map((attempt) =>
        stagedArtifactInsertStatement(input.database, attempt)
      ),
    );
  }
  const fingerprint = await sha256Text(input.message.slice(0, 500));
  let terminalizedListingId: string | null = null;
  for (const candidate of input.candidates) {
    const claim = candidate.activeClaim;
    if (claim === null) continue;
    const listingIdentifiedFailure = !systemicProviderContractFailure &&
      candidate.listingId === input.failedListingId &&
      !input.message.startsWith("enrichment_staged_generation_");
    const hasUsableSourceText = candidate.detail.title.trim() !== "" ||
      candidate.detail.rawDescription.trim() !== "" ||
      candidate.detail.cleanDescription.trim() !== "";
    if (listingIdentifiedFailure && hasUsableSourceText) {
      if (candidate.pendingHeadInitialization?.statement !== null &&
          candidate.pendingHeadInitialization !== null) {
        const initialized = await candidate.pendingHeadInitialization.statement.run();
        if (changes(initialized) !== 1) {
          throw new Error(
            `The enrichment head initialization for ${candidate.listingId} was stale`,
          );
        }
        candidate.pendingHeadInitialization = null;
      }
      const terminal = await prepareListingEnrichmentTerminal({
        database: input.database,
        listingId: candidate.listingId,
        expectedHeadIdentity: candidate.head.headIdentity,
        expectedEnrichmentInputHash: candidate.head.enrichmentInputHash,
        targetIdentity: candidate.head.provenanceTargetIdentity,
        now: input.now,
      });
      const statements: D1PreparedStatement[] = [];
      const terminalIndex = terminal === null ? null : statements.length;
      if (terminal !== null) {
        statements.push(terminal.statement);
        statements.push(...await enrichmentHeadInvalidationStatements({
          database: input.database,
          sourceId: candidate.sourceId,
          head: terminal.resultingHead,
          now: input.now,
        }));
      }
      const completionIndex = statements.length;
      statements.push(exactClaimCompletionStatement(input.database, claim));
      const writes = await input.database.batch(statements);
      if (
        (terminalIndex !== null && changes(writes[terminalIndex]) !== 1) ||
        changes(writes[completionIndex]) !== 1
      ) {
        throw new Error(
          `The exact enrichment fallback for ${candidate.listingId} was stale`,
        );
      }
      if (terminal !== null) candidate.head = terminal.resultingHead;
      terminalizedListingId = candidate.listingId;
    } else if (systemicProviderContractFailure || explicitFailures.has(candidate.listingId)) {
      await failPipelineWorkClaim({
        database: input.database,
        claim,
        errorCode: "enrichment_session_failed",
        errorFingerprint: fingerprint,
        retryAt: new Date(input.now.getTime() + RETRY_DELAY_MS),
        now: input.now,
        telemetry: input.telemetry,
        telemetryContext: input.telemetryContext,
      });
    } else {
      await deferPipelineWorkClaim({
        database: input.database,
        claim,
        availableAt: input.now,
        now: input.now,
        telemetry: input.telemetry,
        telemetryContext: input.telemetryContext,
      });
    }
    candidate.activeClaim = null;
  }
  return Object.freeze({
    terminalizedListingId,
    remaining: await readEnrichmentQueueCount(input.database, input.routeIdentity),
  });
}

async function settleCancelledSessionClaims(input: {
  database: D1Database;
  candidates: readonly EnrichmentSessionCandidate[];
  owner: string;
  now: Date;
}): Promise<void> {
  const active = input.candidates.flatMap((candidate) =>
    candidate.activeClaim === null ? [] : [{ candidate, claim: candidate.activeClaim }]
  );
  const nowIso = input.now.toISOString();
  const statements = active.map(({ claim }) => input.database.prepare(`
    UPDATE pipeline_work_items
    SET available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
        claimed_input_hash = NULL, claimed_revision = NULL,
        last_error_code = NULL, last_error_fingerprint = NULL, updated_at = ?
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND lease_owner = ? AND claimed_input_hash = ? AND claimed_revision = ?
  `).bind(
    nowIso,
    nowIso,
    claim.stage,
    claim.subjectType,
    claim.subjectId,
    claim.owner,
    claim.inputHash,
    claim.revision,
  ));
  const externalClaims = active.filter(({ claim }) => claim.owner !== input.owner);
  const externalClaimSql = externalClaims.length === 0
    ? ""
    : `OR (${externalClaims.map(() => `(
        stage = ? AND subject_type = ? AND subject_id = ?
        AND lease_owner = ? AND claimed_input_hash = ? AND claimed_revision = ?
      )`).join(" OR ")})`;
  const externalBindings = externalClaims.flatMap(({ claim }) => [
    claim.stage,
    claim.subjectType,
    claim.subjectId,
    claim.owner,
    claim.inputHash,
    claim.revision,
  ]);
  statements.push(input.database.prepare(`
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM pipeline_work_items
      WHERE (
        stage IN ('enrichment_text', 'enrichment_embedding')
        AND subject_type = 'listing' AND lease_owner = ?
      ) ${externalClaimSql}
    ) THEN json('null') ELSE json('enrichment_cancelled_claims_remain') END
      AS exact_guard
  `).bind(input.owner, ...externalBindings));
  await input.database.batch(statements);
  for (const { candidate } of active) candidate.activeClaim = null;
}

async function retryCancellationSettlement(
  operation: () => Promise<void>,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CANCELLATION_SETTLEMENT_ATTEMPTS; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const failure = new Error(
    lastError instanceof Error
      ? `enrichment_cancellation_settlement_failed: ${lastError.message}`
      : "enrichment_cancellation_settlement_failed",
  );
  failure.name = "EnrichmentCancellationSettlementError";
  throw failure;
}

async function readEnrichmentQueueCount(
  database: D1Database,
  routeIdentity: EnrichmentRouteIdentity,
): Promise<number> {
  const row = await database.prepare(`
    WITH ${EXACT_CURRENT_ENRICHMENT_WORK_CTE_SQL}
    SELECT COUNT(*) AS count FROM eligible_work
  `).bind(
    routeIdentity.originCacheKey,
    routeIdentity.providerName,
  ).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function assertProviderReady(
  provider: TextGenerationProvider | EmbeddingProvider,
  capability: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfEnrichmentCancelled(signal);
  const health = await provider.healthCheck(signal);
  throwIfEnrichmentCancelled(signal);
  if (!health.ok || !health.modelAvailable) {
    throw new Error(
      health.message ||
        `Configured ${capability} model ${health.modelName} is unavailable`,
    );
  }
}

async function cleanupProvider(
  unload: ((signal?: AbortSignal) => Promise<void>) | undefined,
): Promise<void> {
  if (unload === undefined) return;
  // Provider adapters must settle when this signal aborts. Awaiting settlement
  // is what prevents an abandoned unload from overlapping the next provider.
  const cleanupController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    timeout = setTimeout(
      () => cleanupController.abort(
        new Error("enrichment_provider_cleanup_timeout"),
      ),
      PROVIDER_CLEANUP_TIMEOUT_MS,
    );
    await unload(cleanupController.signal);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function emptyQueueSummary(
  requestedLimit: number,
  requestedChunks: number,
): EnrichmentSessionSummary {
  return {
    ...pendingQueueSummary(requestedLimit, requestedChunks, 0),
    terminalReadPerformed: true,
  };
}

function pendingQueueSummary(
  requestedLimit: number,
  requestedChunks: number,
  remaining: number,
): EnrichmentSessionSummary {
  return {
    requestedLimit,
    effectiveLimit: boundedEnrichmentLimit(requestedLimit),
    requestedChunks,
    effectiveChunks: boundedEnrichmentChunks(requestedChunks),
    chunksAttempted: 0,
    chunksCompleted: 0,
    terminalReadPerformed: false,
    pendingAtStart: remaining,
    attempted: 0,
    completed: 0,
    failures: 0,
    remaining,
    circuitOpen: false,
    failedItemId: null,
    errorMessage: null,
  };
}

function queueBackedSummary(input: {
  readonly summary: EnrichmentSessionSummary;
  readonly queued: number;
  readonly claimed: number;
  readonly stale: number;
  readonly suppliedClaim: SuppliedEnrichmentClaimResult | null;
  readonly diagnostics: EnrichmentSessionDiagnostics;
}): QueueBackedEnrichmentSessionSummary {
  const queued = requiredNonnegativeSafeInteger(input.queued, "queued");
  const claimed = requiredNonnegativeSafeInteger(input.claimed, "claimed");
  const completed = requiredNonnegativeSafeInteger(
    input.summary.completed,
    "completed",
  );
  const stale = requiredNonnegativeSafeInteger(input.stale, "stale");
  const remaining = requiredNonnegativeSafeInteger(
    input.summary.remaining,
    "remaining",
  );
  const remainingWork = remaining > 0;
  return Object.freeze({
    ...input.summary,
    remainingWork,
    diagnostics: input.diagnostics,
    work: Object.freeze({
      scope: "enrichment_text+enrichment_embedding",
      queued,
      claimed,
      completed,
      stale,
      remaining,
      remainingWork,
      suppliedClaim: input.suppliedClaim,
    }),
  });
}

function boundedClaimText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new RangeError(`supplied enrichment work claim ${label} is invalid`);
  return value;
}

function requiredPositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`supplied enrichment work claim ${label} is invalid`);
  }
  return Number(value);
}

function requiredNonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`enrichment queue ${label} count is invalid`);
  }
  return Number(value);
}

function changes(result: D1Result | undefined): number {
  const value = result?.meta?.changes;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface EnrichmentEvidenceQueueSnapshot {
  readonly count: number;
  readonly orderedHash: string;
}

interface EnrichmentSessionEvidenceMetrics {
  readonly textHealthChecks: number;
  readonly embeddingHealthChecks: number;
  readonly textLoadPhases: number;
  readonly embeddingLoadPhases: number;
  readonly textUnloadCount: number;
  readonly embeddingUnloadCount: number;
  readonly textModelUsed: boolean;
  readonly embeddingModelUsed: boolean;
  readonly coResidencyObserved: boolean;
  readonly maxPreparationChunk: number;
  readonly maxEmbeddingGroup: number;
}

async function readEnrichmentEvidenceQueue(
  database: D1Database,
): Promise<EnrichmentEvidenceQueueSnapshot> {
  const result = await database.prepare(`
    SELECT stage, subject_id, input_hash, revision,
      CASE WHEN lease_owner IS NULL THEN 0 ELSE 1 END AS claimed
    FROM pipeline_work_items
    WHERE stage IN ('enrichment_embedding', 'enrichment_text')
      AND subject_type = 'listing'
    ORDER BY stage, subject_id
    LIMIT 100001
  `).all<{
    stage: EnrichmentQueueStage;
    subject_id: string;
    input_hash: string;
    revision: number;
    claimed: number;
  }>();
  const rows = result.results ?? [];
  if (rows.length > 100_000) {
    throw new RangeError("enrichment execution evidence exceeds 100000 queue rows");
  }
  const sanitized = await Promise.all(rows.map(async (row) => ({
    stage: row.stage,
    subjectIdentityHash: await hashCanonicalJson(row.subject_id),
    inputHash: row.input_hash,
    revision: Number(row.revision),
    claimed: Number(row.claimed) === 1,
  })));
  return Object.freeze({
    count: sanitized.length,
    orderedHash: await hashCanonicalJson(sanitized),
  });
}

async function appendEnrichmentSessionEvidence(input: {
  readonly database: D1Database;
  readonly candidates: readonly EnrichmentSessionCandidate[];
  readonly summary: EnrichmentSessionSummary;
  readonly targetIdentity: string;
  readonly generationBefore: PipelineGenerationVector;
  readonly generationAfter: PipelineGenerationVector;
  readonly queueBefore: EnrichmentEvidenceQueueSnapshot;
  readonly queueAfter: EnrichmentEvidenceQueueSnapshot;
  readonly metrics: EnrichmentSessionEvidenceMetrics;
  readonly completedAt: Date;
}): Promise<void> {
  const selectedByListing = new Map(await Promise.all(
    input.candidates.map(async (candidate) => [candidate.listingId, {
      subjectIdentityHash: await hashCanonicalJson(candidate.listingId),
      stage: candidate.stage,
      inputHash: candidate.inputHash,
      revision: candidate.revision,
    }] as const),
  ));
  const selected = [...selectedByListing.values()];
  selected.sort(compareEnrichmentEvidenceRows);
  const ids = input.candidates.map((candidate) => candidate.listingId);
  const headResult = await input.database.prepare(`
    SELECT listing_id, provenance_target_identity, enrichment_input_hash,
      state, extraction_output_hash, semantic_output_hash,
      embedding_input_hash, embedding_vector_hash,
      head_identity, generation, derivation_version
    FROM listing_enrichment_heads
    WHERE listing_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
    ORDER BY listing_id
  `).bind(JSON.stringify(ids)).all<Record<string, unknown>>();
  const headByListing = new Map(
    (headResult.results ?? []).map((row) => [String(row.listing_id), row]),
  );
  const completed = input.candidates.flatMap((candidate) => {
    const head = headByListing.get(candidate.listingId);
    return candidate.activeClaim === null &&
      (head?.state === "complete" || head?.state === "terminal") &&
      head.enrichment_input_hash === candidate.projectionEnrichmentInputHash &&
      head.provenance_target_identity === input.targetIdentity
      ? [selectedByListing.get(candidate.listingId)!]
      : [];
  });
  completed.sort(compareEnrichmentEvidenceRows);
  const lineage = await Promise.all(input.candidates.map(async (candidate) => {
    const head = headByListing.get(candidate.listingId);
    return {
      subjectIdentityHash: await hashCanonicalJson(candidate.listingId),
      state: head?.state ?? null,
      provenanceTargetIdentityHash: head?.provenance_target_identity === undefined
        ? null
        : await hashCanonicalJson(head.provenance_target_identity),
      enrichmentInputHash: head?.enrichment_input_hash ?? null,
      extractionOutputHash: head?.extraction_output_hash ?? null,
      semanticOutputHash: head?.semantic_output_hash ?? null,
      embeddingInputHash: head?.embedding_input_hash ?? null,
      embeddingVectorHash: head?.embedding_vector_hash ?? null,
      headIdentity: head?.head_identity ?? null,
      generation: head?.generation === undefined ? null : Number(head.generation),
      derivationVersion: head?.derivation_version ?? null,
    };
  }));
  lineage.sort(compareEnrichmentEvidenceRows);
  const textSelected = input.candidates.some((candidate) =>
    candidate.stage === "enrichment_text"
  );
  const violations: string[] = [];
  if (input.summary.circuitOpen) violations.push("session_circuit_open");
  if (completed.length !== input.summary.completed) {
    violations.push("selected_completion_mismatch");
  }
  if (input.summary.remaining !== input.queueAfter.count) {
    violations.push("remaining_queue_count_mismatch");
  }
  if (input.metrics.textHealthChecks !== (textSelected ? 1 : 0)) {
    violations.push("text_health_count_mismatch");
  }
  if (input.metrics.embeddingHealthChecks !== 1) {
    violations.push("embedding_health_count_mismatch");
  }
  if (input.metrics.textLoadPhases > 1 || input.metrics.embeddingLoadPhases > 1) {
    violations.push("multiple_model_load_phases");
  }
  if (input.metrics.textUnloadCount > 1 || input.metrics.embeddingUnloadCount > 1) {
    violations.push("multiple_model_unloads");
  }
  if (input.metrics.coResidencyObserved) violations.push("model_co_residency_observed");
  if (input.metrics.maxPreparationChunk > 10) {
    violations.push("preparation_chunk_exceeded_ten");
  }
  if (input.metrics.maxEmbeddingGroup > 10) {
    violations.push("embedding_group_exceeded_ten");
  }
  violations.sort();
  const selectedHash = await hashCanonicalJson(selected);
  const completedHash = await hashCanonicalJson(completed);
  const failedSubjectIdentityHash = input.summary.failedItemId === null
    ? null
    : await hashCanonicalJson(input.summary.failedItemId);
  const executionDocument = Object.freeze({
    targetIdentityHash: await hashCanonicalJson(input.targetIdentity),
    generationBeforeHash: input.generationBefore.hash,
    generationAfterHash: input.generationAfter.hash,
    queueBeforeCount: input.queueBefore.count,
    queueBeforeHash: input.queueBefore.orderedHash,
    queueAfterCount: input.queueAfter.count,
    queueAfterHash: input.queueAfter.orderedHash,
    selectedCount: selected.length,
    selectedHash,
    completedCount: completed.length,
    completedHash,
    lineageHash: await hashCanonicalJson(lineage),
    pendingAtStart: input.summary.pendingAtStart,
    completed: input.summary.completed,
    remaining: input.summary.remaining,
    failedSubjectIdentityHash,
  });
  const executionReceiptId = `enrichment-execution-evidence:${(
    await hashCanonicalJson({
      derivationVersion: ENRICHMENT_SESSION_EXECUTION_EVIDENCE_DERIVATION_VERSION,
      executionDocument,
      violations,
    })
  ).slice("sha256:".length)}`;
  const execution = await appendIdempotentPipelineAuditReceipt(input.database, {
    receiptId: executionReceiptId,
    receiptKind: violations.length === 0 ? "full_audit" : "mismatch",
    featureName: ENRICHMENT_SESSION_EXECUTION_EVIDENCE_FEATURE,
    derivationVersion: ENRICHMENT_SESSION_EXECUTION_EVIDENCE_DERIVATION_VERSION,
    beforeGenerationVectorHash: input.generationBefore.hash,
    afterGenerationVectorHash: input.generationAfter.hash,
    canonicalCount: selected.length,
    canonicalOrderedHash: selectedHash,
    projectionCount: completed.length,
    projectionOrderedHash: completedHash,
    queueCount: input.queueAfter.count,
    queueOrderedHash: input.queueAfter.orderedHash,
    mismatchCount: violations.length,
    differingIdsHash: violations.length === 0 ? null : await hashCanonicalJson({
      violations,
      failedSubjectIdentityHash,
    }),
    priorReceiptId: null,
    completedAt: evidenceTimestamp(input.completedAt),
  });
  const metricsDocument = Object.freeze({
    ...input.metrics,
    executionDocumentHash: await hashCanonicalJson(executionDocument),
    actualViolations: violations,
  });
  const expectedViolationsHash = await hashCanonicalJson([]);
  const actualViolationsHash = await hashCanonicalJson(violations);
  const contractReceiptId = `enrichment-contract-evidence:${(
    await hashCanonicalJson({
      derivationVersion: ENRICHMENT_SESSION_CONTRACT_EVIDENCE_DERIVATION_VERSION,
      executionReceiptId: execution.receipt.receiptId,
      metricsDocument,
    })
  ).slice("sha256:".length)}`;
  await appendIdempotentPipelineAuditReceipt(input.database, {
    receiptId: contractReceiptId,
    receiptKind: violations.length === 0 ? "full_audit" : "mismatch",
    featureName: ENRICHMENT_SESSION_CONTRACT_EVIDENCE_FEATURE,
    derivationVersion: ENRICHMENT_SESSION_CONTRACT_EVIDENCE_DERIVATION_VERSION,
    beforeGenerationVectorHash: input.generationBefore.hash,
    afterGenerationVectorHash: input.generationAfter.hash,
    canonicalCount: 0,
    canonicalOrderedHash: expectedViolationsHash,
    projectionCount: violations.length,
    projectionOrderedHash: actualViolationsHash,
    queueCount: Math.max(
      input.metrics.maxPreparationChunk,
      input.metrics.maxEmbeddingGroup,
    ),
    queueOrderedHash: await hashCanonicalJson(metricsDocument),
    mismatchCount: violations.length,
    differingIdsHash: violations.length === 0 ? null : await hashCanonicalJson(violations),
    priorReceiptId: execution.receipt.receiptId,
    completedAt: evidenceTimestamp(input.completedAt),
  });
}

function compareEnrichmentEvidenceRows(
  left: { readonly subjectIdentityHash: string },
  right: { readonly subjectIdentityHash: string },
): number {
  return left.subjectIdentityHash < right.subjectIdentityHash
    ? -1
    : left.subjectIdentityHash > right.subjectIdentityHash ? 1 : 0;
}

function evidenceTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError("enrichment evidence completion time is invalid");
  }
  return value.toISOString();
}
