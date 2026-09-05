import { env } from "cloudflare:workers";
import { createSequentialEnrichmentProviders, sha256Text } from "../lib/ai";
import { getConfig } from "../lib/config";
import {
  EXTRACTION_PROMPT_VERSION,
  SEMANTIC_DOCUMENT_VERSION,
} from "../lib/enrichment/prompt";
import {
  enrichmentInputLimit,
} from "../lib/enrichment/input";
import { enrichmentSessionProvenanceTarget } from "../lib/enrichment/target";
import { effectiveAssetClasses } from "../lib/enrichment/asset-classes";
import { canonicalItemDescription } from "../lib/domain/item-text";
import {
  locationEvidenceSources,
  type LocationEvidenceSource,
  type NormalizedListingDetail,
} from "../lib/domain/listings";
import {
  deriveDisplayLotType,
  type ExtractedLotType,
} from "../lib/domain/lot-classification";
import { effectiveLotType } from "../lib/operator-feedback";
import {
  readLatestProfileSignalFeedback,
  type ProfileSignalFeedbackSnapshot,
} from "../lib/pipeline/profile-feedback";
import {
  compileReviewPreferenceFilter,
  reviewPreferenceVisibilityDecision,
} from "../lib/ranking/review-prefilter";
import { readActiveRouteScope } from "../lib/routing/active-scope";
import { roundedDistanceMiles } from "../lib/routing/helpers";
import {
  assertCompleteDashboardListingCoverage,
  countEnrichmentReadyDashboardListings,
  dashboardPresentationImageReady,
  dashboardRowHasAcceptedReviewEligibility,
  dashboardRowIsCoreReady,
  DASHBOARD_LISTING_QUERY_LIMIT,
  reviewReadySourceIds,
  sourceIdsWithUnresolvedAcceptanceCandidates,
  summarizeDashboardRouteHealth,
  type DashboardRouteHealth,
  type DashboardRouteInventoryRow,
  type DashboardReviewInventoryRow,
} from "../lib/dashboard-route-health";
import { sourceCanBeEnabled } from "../lib/settings/source-policy";
import { findSourceAdapter, sourceRegistry } from "../lib/sources";
import { EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL } from "../lib/pipeline/detail-observation";
import {
  acceptedReviewCohortLimitMessage,
  MAX_ACCEPTED_REVIEW_COHORT_PER_SOURCE,
  oversizedAcceptedReviewCohorts,
  readCurrentAcceptedReviewCohortCounts,
  readValidatedEnrichmentHeadStates,
  readValidatedEnrichmentStates,
  readValidatedListingRatings,
  type EnrichmentHeadReadTarget,
  type EnrichmentProvenanceTarget,
  type ValidatedEnrichmentState,
  type ValidListingRating,
} from "../lib/pipeline/storage";
import { ENRICHMENT_HEAD_DERIVATION_VERSION } from "../lib/pipeline/enrichment-heads";
import { ACTIVE_PREFERENCE_V2_MODEL_VERSION } from "../lib/preference-v2/review-runtime";
import { optionalAiCapabilities } from "../lib/ai/capabilities";
import { completedRunDurationSeconds } from "../lib/run-duration";
import { listingReviewCompletedSql } from "../lib/review-completion";
import { readDashboardLotFeedback } from "./dashboard-lot-feedback";
import {
  readConfiguredAdhocReviewCohort,
  type AdhocReviewCohortStatus,
} from "../lib/review-cohort/storage";
import { adhocReviewMemberExistsSql } from "../lib/review-cohort/runtime";
import {
  readNightlyPerformanceFeatures,
  resolvePerformanceFeature,
  type PerformanceFeatureDecision,
} from "../lib/performance/features";
import { readPerformanceFeatureReadiness } from "../lib/performance/readiness";
import {
  DASHBOARD_RELEASE_PRIME_DERIVATION_VERSION,
  clearDashboardReleasePrimeCache,
  readWithDashboardReleasePrime,
} from "../lib/pipeline/dashboard-release-prime";
import {
  changedDashboardReleaseSourceIds,
  readDashboardReleaseVector,
  type DashboardReleaseVector,
} from "../lib/pipeline/source-release-state";
import {
  prepareCanonicalMutationPayloadInvalidationStatements,
} from "../lib/pipeline/mutation-invalidation";

type Row = Record<string, unknown>;

export type DashboardListingScope =
  | "unvoted"
  | "all"
  | "voted"
  | "interested"
  | "not_interested";

type ReviewedDashboardListingScope = Exclude<
  DashboardListingScope,
  "unvoted"
>;

export async function executeDashboardReadBatch<T>(
  database: D1Database,
  statements: readonly D1PreparedStatement[],
): Promise<D1Result<T>[]> {
  if (statements.length === 0) {
    return [];
  }
  const results = await database.batch<T>([...statements]);
  if (results.length !== statements.length) {
    throw new Error(
      `Dashboard read batch returned ${results.length} results for ${statements.length} statements`,
    );
  }
  return results;
}

const DASHBOARD_INITIAL_READ_STATEMENT_COUNT = 9;
const DASHBOARD_INITIAL_LARGE_READ_INDEXES = new Set([0, 6]);

type DashboardInitialReadStatement =
  | D1PreparedStatement
  | (() => Promise<D1Result<unknown>>);

export async function executeDashboardInitialReads<T>(
  database: D1Database,
  statements: readonly DashboardInitialReadStatement[],
): Promise<D1Result<T>[]> {
  if (statements.length !== DASHBOARD_INITIAL_READ_STATEMENT_COUNT) {
    throw new Error(
      `Dashboard initial read requires exactly ${DASHBOARD_INITIAL_READ_STATEMENT_COUNT} statements`,
    );
  }
  const listingRead = statements[0]!;
  const listingResult = typeof listingRead === "function"
    ? await listingRead() as D1Result<T>
    : await listingRead.all<T>();
  const distanceInventoryRead = statements[6]!;
  if (typeof distanceInventoryRead === "function") {
    throw new Error("Dashboard distance inventory read must be prepared");
  }
  const distanceInventoryResult = await distanceInventoryRead.all<T>();
  const smallResults = await executeDashboardReadBatch<T>(
    database,
    statements.filter((_statement, index) =>
      !DASHBOARD_INITIAL_LARGE_READ_INDEXES.has(index)
    ) as D1PreparedStatement[],
  );
  const results: D1Result<T>[] = [];
  let smallResultIndex = 0;
  for (let index = 0; index < statements.length; index += 1) {
    if (index === 0) results.push(listingResult);
    else if (index === 6) results.push(distanceInventoryResult);
    else results.push(smallResults[smallResultIndex++]!);
  }
  if (
    results.length !== DASHBOARD_INITIAL_READ_STATEMENT_COUNT ||
    smallResultIndex !== smallResults.length
  ) {
    throw new Error("Dashboard initial read result reconstruction failed");
  }
  return results;
}

export interface DashboardListingImageRecord {
  position: number;
  isPrimary: boolean;
  sourceUrl: string;
  localUrl: string | null;
  displayUrl: string;
  downloadStatus: "deferred" | "pending" | "downloaded" | "failed";
  downloadError: string | null;
}

export interface DashboardListingDetailPayload {
  listingId: string;
  cleanDescription: string;
  rawDescription: string;
  galleryImageUrls: string[];
  images: DashboardListingImageRecord[];
}

const DASHBOARD_PER_SOURCE_QUERY_LIMIT = DASHBOARD_LISTING_QUERY_LIMIT + 1;
const DASHBOARD_REGISTERED_SOURCE_LIMIT = Math.max(1, sourceRegistry.size);
const DASHBOARD_RAW_QUERY_LIMIT =
  DASHBOARD_PER_SOURCE_QUERY_LIMIT * DASHBOARD_REGISTERED_SOURCE_LIMIT;
const ATOMIC_CURRENT_COHORT_SOURCE_IDS = new Set(sourceRegistry.keys());
const DASHBOARD_ACCEPTED_ROUTE_BUCKETS = new Set([
  "under_2h",
  "under_4h",
  "under_8h",
]);

interface DashboardReleaseCacheEntry {
  readonly sourceId: string;
  readonly publicationInventoryRunId: string;
  readonly originCacheKey: string;
  readonly providerName: string;
  readonly profileVersionId: string;
  readonly adhocReviewCohortId: string;
  readonly adhocReviewHeadVectorHash: string;
  readonly releasedListingIds: ReadonlySet<string>;
}

interface DashboardReleaseCacheLookup {
  readonly sourceId: string;
  readonly publicationInventoryRunId: string;
  readonly originCacheKey: string;
  readonly providerName: string;
  readonly profileVersionId: string;
  readonly adhocReviewCohortId: string;
  readonly adhocReviewHeadVectorHash: string;
  readonly listingId: string;
  readonly hasActivePipelineLease: boolean;
}

const dashboardReleaseCache = new WeakMap<
  object,
  ReadonlyMap<string, DashboardReleaseCacheEntry>
>();
const dashboardReleasePrimeVector = new WeakMap<object, DashboardReleaseVector>();

type DashboardChainStates =
  Awaited<ReturnType<typeof readValidatedEnrichmentStates>>;
type DashboardRatings = Map<string, ValidListingRating>;
const DASHBOARD_VALIDATION_READ_PAGE_SIZE = 5_000;

interface DashboardValidationCacheEntry {
  readonly key: string;
  readonly chainStates: DashboardChainStates;
  readonly ratings: DashboardRatings;
}

interface DashboardValidationInFlightEntry {
  readonly key: string;
  readonly promise: Promise<{
    chainStates: DashboardChainStates;
    ratings: DashboardRatings;
  }>;
}

/**
 * Enrichment artifacts are immutable. Cache only
 * their validated projection; votes, run health, images, source state, and
 * profile feedback are still read on every request.
 */
const dashboardValidationCache = new WeakMap<
  object,
  DashboardValidationCacheEntry
>();
const dashboardValidationInFlight = new WeakMap<
  object,
  DashboardValidationInFlightEntry
>();
const DASHBOARD_VALIDATION_CACHE_SCHEMA_VERSION = 8;
const DASHBOARD_VALIDATION_CACHE_ORIGIN =
  "https://auction-discovery.local/.internal/dashboard-validation";
export const DASHBOARD_VALIDATION_CACHE_IO_TIMEOUT_MS = 2_000;

interface DashboardValidationCachePayload {
  readonly schemaVersion: typeof DASHBOARD_VALIDATION_CACHE_SCHEMA_VERSION;
  readonly key: string;
  readonly chainStates: Array<[string, ValidatedEnrichmentState]>;
  readonly ratings: Array<[string, ValidListingRating]>;
}

function dashboardValidationCacheRequest(key: string): Request {
  return new Request(
    `${DASHBOARD_VALIDATION_CACHE_ORIGIN}/v${DASHBOARD_VALIDATION_CACHE_SCHEMA_VERSION}/${key}`,
  );
}

function dashboardValidationCacheStorage(): Cache | null {
  return typeof caches === "undefined"
    ? null
    : (caches as unknown as { readonly default: Cache }).default;
}

export async function withDashboardValidationCacheTimeout<T>(
  operation: Promise<T>,
  fallback: T,
  timeoutMs = DASHBOARD_VALIDATION_CACHE_IO_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation.catch(() => fallback),
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function parseDashboardValidationCachePayload(
  value: unknown,
  expectedKey: string,
): {
  chainStates: DashboardChainStates;
  ratings: DashboardRatings;
} | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<DashboardValidationCachePayload>;
  if (
    payload.schemaVersion !== DASHBOARD_VALIDATION_CACHE_SCHEMA_VERSION ||
    payload.key !== expectedKey ||
    !Array.isArray(payload.chainStates) ||
    !Array.isArray(payload.ratings) ||
    payload.chainStates.length > DASHBOARD_RAW_QUERY_LIMIT ||
    payload.ratings.length > DASHBOARD_RAW_QUERY_LIMIT
  ) return null;

  const chainStates = new Map<string, ValidatedEnrichmentState>();
  for (const entry of payload.chainStates) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [listingId, state] = entry;
    if (
      typeof listingId !== "string" ||
      !listingId ||
      !state ||
      typeof state !== "object" ||
      state.listingId !== listingId ||
      typeof state.expectedExtractionInputHash !== "string" ||
      chainStates.has(listingId)
    ) return null;
    if (
      state.completeChain !== null &&
      (
        state.completeChain.listingId !== listingId ||
        typeof state.completeChain.extractionArtifactId !== "string" ||
        typeof state.completeChain.extractionOutputJson !== "string" ||
        typeof state.completeChain.semanticArtifactId !== "string" ||
        typeof state.completeChain.semanticOutputHash !== "string" ||
        typeof state.completeChain.embeddingId !== "string" ||
        !Number.isSafeInteger(state.completeChain.embeddingDimensions) ||
        state.completeChain.embeddingDimensions <= 0 ||
        state.completeChain.vector !== null
      )
    ) return null;
    chainStates.set(listingId, state);
  }

  const ratings = new Map<string, ValidListingRating>();
  for (const entry of payload.ratings) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [listingId, rating] = entry;
    if (
      typeof listingId !== "string" ||
      !listingId ||
      !rating ||
      typeof rating !== "object" ||
      rating.listingId !== listingId ||
      typeof rating.profileVersionId !== "string" ||
      !rating.profileVersionId ||
      typeof rating.score !== "number" ||
      !Number.isFinite(rating.score) ||
      rating.score < 0 ||
      rating.score > 100 ||
      typeof rating.explorationWeight !== "number" ||
      !Number.isFinite(rating.explorationWeight) ||
      rating.explorationWeight < 0 ||
      rating.explorationWeight > 1 ||
      typeof rating.explanationArtifactId !== "string" ||
      !rating.explanationArtifactId ||
      typeof rating.explanation !== "string" ||
      !rating.explanation ||
      typeof rating.scoredAt !== "string" ||
      !rating.scoredAt ||
      ratings.has(listingId)
    ) return null;
    ratings.set(listingId, rating);
  }
  return { chainStates, ratings };
}

async function readPersistedDashboardValidation(
  key: string,
): Promise<{
  chainStates: DashboardChainStates;
  ratings: DashboardRatings;
} | null> {
  try {
    const cache = dashboardValidationCacheStorage();
    if (!cache) return null;
    const request = dashboardValidationCacheRequest(key);
    const response = await withDashboardValidationCacheTimeout(
      cache.match(request),
      undefined,
    );
    if (!response) return null;
    const body = await withDashboardValidationCacheTimeout(
      response.text(),
      null,
    );
    if (body === null) return null;
    const expectedHash = response.headers.get(
      "x-auction-discovery-validation-hash",
    );
    if (!expectedHash || await sha256Text(body) !== expectedHash) {
      await withDashboardValidationCacheTimeout(cache.delete(request), false);
      return null;
    }
    const parsed = parseDashboardValidationCachePayload(JSON.parse(body), key);
    if (!parsed) {
      await withDashboardValidationCacheTimeout(cache.delete(request), false);
    }
    return parsed;
  } catch {
    return null;
  }
}

async function persistDashboardValidation(
  key: string,
  chainStates: DashboardChainStates,
  ratings: DashboardRatings,
): Promise<void> {
  try {
    const cache = dashboardValidationCacheStorage();
    if (!cache) return;
    const body = JSON.stringify({
      schemaVersion: DASHBOARD_VALIDATION_CACHE_SCHEMA_VERSION,
      key,
      chainStates: [...chainStates],
      ratings: [...ratings],
    } satisfies DashboardValidationCachePayload);
    const bodyHash = await sha256Text(body);
    await withDashboardValidationCacheTimeout(
      cache.put(
        dashboardValidationCacheRequest(key),
        new Response(body, {
          headers: {
            "cache-control": "public, max-age=604800, immutable",
            "content-type": "application/json",
            "x-auction-discovery-validation-hash": bodyHash,
          },
        }),
      ),
      undefined,
    );
  } catch {
    // A cache write is an optimization only; exact validation already passed.
  }
}

function persistedDashboardValidationMatches(
  validation: {
    chainStates: DashboardChainStates;
    ratings: DashboardRatings;
  },
  rows: readonly Row[],
  scoreModelVersionId: string,
): boolean {
  const expectedChainListingIds = new Set(
    selectDashboardRowsForEnrichmentValidation(rows)
      .map((row) => text(row.id))
      .filter(Boolean),
  );
  const expectedRatingListingIds = new Set(
    rows.map((row) => text(row.id)).filter(Boolean),
  );
  return (
    validation.chainStates.size === expectedChainListingIds.size &&
    [...expectedChainListingIds].every((listingId) =>
      validation.chainStates.has(listingId)
    ) &&
    [...validation.ratings].every(([listingId, rating]) =>
      expectedRatingListingIds.has(listingId) &&
      rating.profileVersionId === scoreModelVersionId
    )
  );
}

/**
 * A cached vote is valid only for the exact immutable dashboard release that
 * already passed the full source-cohort gate. Pipeline activity fails closed.
 */
export function dashboardReleaseCacheAllowsVote(
  cached: DashboardReleaseCacheEntry | undefined,
  lookup: DashboardReleaseCacheLookup,
): boolean {
  return Boolean(
    cached &&
    !lookup.hasActivePipelineLease &&
    cached.sourceId === lookup.sourceId &&
    cached.publicationInventoryRunId === lookup.publicationInventoryRunId &&
    cached.originCacheKey === lookup.originCacheKey &&
    cached.providerName === lookup.providerName &&
    cached.profileVersionId === lookup.profileVersionId &&
    cached.adhocReviewCohortId === lookup.adhocReviewCohortId &&
    cached.adhocReviewHeadVectorHash === lookup.adhocReviewHeadVectorHash &&
    cached.releasedListingIds.has(lookup.listingId),
  );
}

/** Drops the positive release proof when runtime state may be changing. */
export function invalidateDashboardReleaseCache(): void {
  dashboardReleaseCache.delete(env.DB);
  dashboardReleasePrimeVector.delete(env.DB);
  clearDashboardReleasePrimeCache(env.DB);
  dashboardValidationCache.delete(env.DB);
  dashboardValidationInFlight.delete(env.DB);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Rows eligible for expensive  chain and rating validation. */
export function selectAcceptedDashboardRouteRows<
  T extends {
    drive_bucket?: unknown;
    error_code?: unknown;
  },
>(rows: readonly T[]): T[] {
  return rows.filter((row) =>
    !text(row.error_code) &&
    DASHBOARD_ACCEPTED_ROUTE_BUCKETS.has(text(row.drive_bucket))
  );
}

export interface DashboardRouteHealthAggregateRow
  extends DashboardRouteInventoryRow {
  count: number;
}

export function summarizeDashboardRouteHealthInventory(
  detailedRows: readonly DashboardRouteInventoryRow[],
  aggregateRows: readonly DashboardRouteHealthAggregateRow[],
  originPostalCode: string,
): DashboardRouteHealth {
  const summary = summarizeDashboardRouteHealth(detailedRows, originPostalCode);
  for (const aggregate of aggregateRows) {
    if (!Number.isSafeInteger(aggregate.count) || aggregate.count < 1) {
      throw new Error("Dashboard route-health aggregate count is invalid");
    }
    const classified = summarizeDashboardRouteHealth(
      [aggregate],
      originPostalCode,
    );
    summary.scope += classified.scope * aggregate.count;
    summary.completed += classified.completed * aggregate.count;
    summary.review += classified.review * aggregate.count;
    summary.excluded += classified.excluded * aggregate.count;
    summary.unknown += classified.unknown * aggregate.count;
    summary.errors += classified.errors * aggregate.count;
    summary.pending += classified.pending * aggregate.count;
  }
  return summary;
}

function dashboardAcceptedRouteExistsSql(input: {
  listingIdSql: string;
  originCacheKeySql: string;
  providerNameSql: string;
}): string {
  return `EXISTS (
    SELECT 1
    FROM listing_current_pipeline_state accepted_state
    JOIN listing_routes accepted_assignment
      ON accepted_assignment.listing_id = accepted_state.listing_id
      AND accepted_assignment.route_cache_id = accepted_state.route_cache_identity
    JOIN route_cache accepted_route
      ON accepted_route.id = accepted_state.route_cache_identity
      AND accepted_route.input_hash = accepted_state.route_input_hash
    WHERE accepted_state.listing_id = ${input.listingIdSql}
      AND accepted_route.origin_cache_key = ${input.originCacheKeySql}
      AND accepted_route.provider_name = ${input.providerNameSql}
      AND accepted_route.error_code IS NULL
      AND accepted_route.drive_bucket IN (
        'under_2h', 'under_4h', 'under_8h'
      )
  )`;
}

function dashboardTerminalPrefilterExcludedSql(input: {
  listingIdSql: string;
  originCacheKeySql: string;
}): string {
  return `EXISTS (
    SELECT 1
    FROM listing_recovery_status terminal_recovery
    WHERE terminal_recovery.listing_id = ${input.listingIdSql}
      AND terminal_recovery.origin_cache_key = ${input.originCacheKeySql}
      AND terminal_recovery.state = 'terminal'
      AND terminal_recovery.stage IN ('scope', 'prefilter')
  )`;
}

function dashboardAcceptedOrCohortMemberSql(input: {
  listingIdSql: string;
  sourceIdSql: string;
  inventoryRunIdSql: string;
  cohortIdSql: string;
  originCacheKeySql: string;
  providerNameSql: string;
}): string {
  const member = adhocReviewMemberExistsSql({
    listingIdSql: input.listingIdSql,
    sourceIdSql: input.sourceIdSql,
    inventoryRunIdSql: input.inventoryRunIdSql,
    cohortIdSql: input.cohortIdSql,
  });
  return `(
    (
      ${input.cohortIdSql} = ''
      OR ${member}
    )
    AND ${dashboardAcceptedRouteExistsSql({
      listingIdSql: input.listingIdSql,
      originCacheKeySql: input.originCacheKeySql,
      providerNameSql: input.providerNameSql,
    })}
  )`;
}

export const DASHBOARD_COMPLETED_REVIEWS_CTE_SQL = `
  completed_reviews AS MATERIALIZED (
    SELECT listing_id FROM listing_votes
    UNION
    SELECT listing_id FROM listing_impressions
  )
` as const;

function dashboardReviewedHistorySql(
  listingScope: DashboardListingScope,
): string {
  switch (listingScope) {
    case "interested":
      return `
        SELECT completed_vote.listing_id
        FROM listing_votes completed_vote
        WHERE completed_vote.value = 'interested'
      `;
    case "not_interested":
      return `
        SELECT completed_vote.listing_id
        FROM listing_votes completed_vote
        WHERE completed_vote.value = 'not_interested'
      `;
    case "voted":
      return `
        SELECT completed_vote.listing_id
        FROM listing_votes completed_vote
      `;
    case "all":
      return `
        SELECT completed_vote.listing_id
        FROM listing_votes completed_vote
        UNION
        SELECT completed_impression.listing_id
        FROM listing_impressions completed_impression
      `;
    case "unvoted":
      return `
        SELECT completed_vote.listing_id
        FROM listing_votes completed_vote
        CROSS JOIN target
        WHERE target.include_reviewed_history = 1
        UNION
        SELECT completed_impression.listing_id
        FROM listing_impressions completed_impression
        CROSS JOIN target
        WHERE target.include_reviewed_history = 1
      `;
  }
}

function dashboardCandidateListingIdsSql(
  listingScope: DashboardListingScope,
): string {
  if (listingScope === "all" || listingScope === "unvoted") {
    return `
      SELECT listing_id
      FROM source_current_listings
      WHERE review_candidate = 1
      UNION
      SELECT listing_id FROM reviewed_history
    `;
  }
  return `SELECT listing_id FROM reviewed_history`;
}

function dashboardProvedSourceImageAbsentSql(listingIdSql: string): string {
  return `(
    NOT EXISTS (
      SELECT 1 FROM listing_images any_review_image
      WHERE any_review_image.listing_id = ${listingIdSql}
    )
    AND EXISTS (
      SELECT 1
      FROM listing_recovery_status proved_image_absence
      WHERE proved_image_absence.listing_id = ${listingIdSql}
        AND proved_image_absence.state = 'terminal'
        AND proved_image_absence.stage = 'image'
        AND proved_image_absence.last_error_code = 'source_image_absent'
    )
  )`;
}

function dashboardProvedSourceImageUnavailableSql(listingIdSql: string): string {
  return `EXISTS (
    SELECT 1 FROM listing_recovery_status unavailable_image
    WHERE unavailable_image.listing_id = ${listingIdSql}
      AND unavailable_image.state = 'terminal'
      AND unavailable_image.stage = 'image'
      AND unavailable_image.last_error_code = 'source_image_unavailable'
  )`;
}

function dashboardPresentationReadySql(listingIdSql: string): string {
  return `(
    ${dashboardProvedSourceImageAbsentSql(listingIdSql)}
    OR ${dashboardProvedSourceImageUnavailableSql(listingIdSql)}
    OR EXISTS (
      SELECT 1 FROM listing_images ready_review_primary
      WHERE ready_review_primary.listing_id = ${listingIdSql}
        AND ready_review_primary.is_primary = 1
        AND ready_review_primary.download_status = 'downloaded'
        AND NULLIF(TRIM(ready_review_primary.local_path), '') IS NOT NULL
    )
  )`;
}

function dashboardUsableSourceTextSql(
  stubSql: string,
  detailSql: string,
): string {
  return `(
    length(trim(${stubSql}.title)) > 0
    OR length(trim(coalesce(${detailSql}.raw_description, ''))) > 0
    OR length(trim(coalesce(${detailSql}.clean_description, ''))) > 0
  )`;
}

export function dashboardTerminalEnrichmentReady(
  row: { terminal_enrichment_ready?: unknown },
): boolean {
  return row.terminal_enrichment_ready === 1;
}

export function selectDashboardRowsForEnrichmentValidation<
  T extends { terminal_enrichment_ready?: unknown },
>(rows: readonly T[]): T[] {
  return rows.filter((row) => !dashboardTerminalEnrichmentReady(row));
}

function unresolvedAcceptanceCountSql(sourceIdSql: string): string {
  return `(
    SELECT COUNT(*)
    FROM source_current_listings unresolved_current
    WHERE unresolved_current.source_id = ${sourceIdSql}
      AND unresolved_current.review_candidate = 1
      AND NOT EXISTS (
        SELECT 1
        FROM listing_detail_terminal_status terminal_detail
        WHERE terminal_detail.listing_id = unresolved_current.listing_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM listing_recovery_status terminal_recovery
        WHERE terminal_recovery.listing_id = unresolved_current.listing_id
          AND terminal_recovery.origin_cache_key = ?
          AND terminal_recovery.state = 'terminal'
          AND (
            terminal_recovery.stage IN ('scope', 'prefilter')
            OR (
              terminal_recovery.stage = 'route'
              AND terminal_recovery.last_error_code = 'unknown_location'
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM listing_recovery_status publication_deferred_route
        WHERE publication_deferred_route.listing_id =
          unresolved_current.listing_id
          AND publication_deferred_route.origin_cache_key = ?
          AND publication_deferred_route.state = 'retryable'
          AND publication_deferred_route.stage = 'route'
          AND publication_deferred_route.last_attempted_at >=
            unresolved_current.observed_at
      )
      AND NOT EXISTS (
        SELECT 1
        FROM listing_current_pipeline_state resolved_pipeline_state
        JOIN listing_routes resolved_listing_route
          ON resolved_listing_route.listing_id = resolved_pipeline_state.listing_id
          AND resolved_listing_route.route_cache_id =
            resolved_pipeline_state.route_cache_identity
        JOIN route_cache resolved_route
          ON resolved_route.id = resolved_pipeline_state.route_cache_identity
          AND resolved_route.input_hash = resolved_pipeline_state.route_input_hash
        WHERE resolved_pipeline_state.listing_id = unresolved_current.listing_id
          AND resolved_route.origin_cache_key = ?
          AND resolved_route.provider_name = ?
          AND (
            (
              resolved_route.error_code IS NULL
              AND resolved_route.drive_bucket IN (
                'under_2h', 'under_4h', 'under_8h', 'exclude'
              )
            )
            OR resolved_route.error_code = 'unknown_location'
          )
      )
  )`;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sourceName(id: string, displayName: string): string {
  return findSourceAdapter(id)?.manifest.displayName || displayName || id;
}

function imagePath(localPath: unknown): string {
  if (typeof localPath === "string" && localPath) {
    return `/stored-images/${localPath.split("/").map(encodeURIComponent).join("/")}`;
  }
  return "";
}

function mapExtraction(value: unknown, title: string) {
  const extraction = json<Record<string, unknown>>(value, {});
  const list = (key: string) => Array.isArray(extraction[key])
    ? (extraction[key] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  const includedItems = list("included_items");
  const manufacturer = typeof extraction.manufacturer === "string" ? extraction.manufacturer : null;
  const manufacturers = list("manufacturers");
  if (manufacturers.length === 0 && manufacturer) manufacturers.push(manufacturer);
  return {
    summary: text(extraction.short_summary),
    attributes: {
      assetClasses: effectiveAssetClasses(list("asset_classes"), {
        title,
        includedItems,
      }),
      industryDomain: text(extraction.industry_domain, "unknown"),
      manufacturer,
      manufacturers,
      modelNumbers: list("model_numbers"),
      lotType: text(extraction.lot_type, "unknown"),
      includedItems,
      missingItems: list("missing_items"),
      condition: text(extraction.condition, "unknown"),
      testedStatus: text(extraction.tested_status, "unknown"),
      highValueSignals: list("high_value_signals"),
      negativeSignals: list("negative_signals"),
      safetyFlags: list("regulatory_or_safety_flags"),
    },
  };
}

function dashboardProvenanceTarget(config: ReturnType<typeof getConfig>): EnrichmentProvenanceTarget {
  return {
    textProviderName: config.ai.textProvider,
    textModelName: config.ai.textModel,
    extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
    semanticDocumentVersion: SEMANTIC_DOCUMENT_VERSION,
    embeddingProviderName: config.ai.embeddingProvider,
    embeddingModelName: config.ai.embeddingModel,
  };
}

function dashboardChainListing(row: Row): {
  listingId: string;
  detail: NormalizedListingDetail;
} {
  const pickupEvidence = text(row.pickup_evidence_source);
  const evidenceSource = locationEvidenceSources.includes(
      pickupEvidence as LocationEvidenceSource,
    )
    ? pickupEvidence as LocationEvidenceSource
    : "unknown";
  const hasPickup = Boolean(
    text(row.pickup_city) || text(row.pickup_state) || text(row.pickup_postal_code),
  );
  return {
    listingId: text(row.id),
    detail: {
      sourceId: text(row.source_id),
      sourceListingId: text(row.source_listing_id),
      sourceUrl: text(row.source_url),
      title: text(row.title),
      category: text(row.category_at_scrape) || null,
      lotNumber: text(row.lot_number_at_scrape) || null,
      rawDescription: text(row.raw_description),
      cleanDescription: text(row.clean_description),
      priceAtScrape: {
        amountMinor: typeof row.price_amount_minor === "number" ? row.price_amount_minor : null,
        currency: text(row.price_currency) || null,
        displayText: text(row.price_display_text) || null,
      },
      auctionEndsAt: text(row.auction_ends_at) || null,
      seller: text(row.seller) || null,
      pickupLocation: hasPickup ? {
        city: text(row.pickup_city) || null,
        state: text(row.pickup_state) || null,
        postalCode: text(row.pickup_postal_code) || null,
        countryCode: text(row.pickup_country_code, "US"),
        evidenceSource,
      } : null,
      images: [],
      scrapedAt: text(row.scraped_at),
      contentHash: text(row.content_hash),
    },
  };
}

/**
 * Uses compact current heads only at an idle database boundary and only when
 * they provide the same complete-chain contract for each requested listing.
 * An incomplete idle binding falls back to the canonical immutable-attempt
 * scan only for its missing or mismatched listings. During active mutation,
 * enrichment remains conservatively pending so progressive reads do not rescan
 * every immutable attempt or loosen voting.
 */
export async function readDashboardEnrichmentStates(input: {
  listings: readonly ReturnType<typeof dashboardChainListing>[];
  canonicalTarget: EnrichmentProvenanceTarget;
  headTarget: EnrichmentHeadReadTarget;
  hasActivePipelineLease: boolean;
  readHeadStates?: typeof readValidatedEnrichmentHeadStates;
  readCanonicalStates?: typeof readValidatedEnrichmentStates;
}): Promise<DashboardChainStates> {
  if (input.hasActivePipelineLease || !optionalAiCapabilities().enrichment) return new Map();
  const listingIds = new Set(input.listings.map((listing) => listing.listingId));
  const headStates: DashboardChainStates = new Map();
  const readHeadStates = input.readHeadStates ?? readValidatedEnrichmentHeadStates;
  for (
    let offset = 0;
    offset < input.listings.length;
    offset += DASHBOARD_VALIDATION_READ_PAGE_SIZE
  ) {
    const pageStates = await readHeadStates({
      listings: input.listings.slice(
        offset,
        offset + DASHBOARD_VALIDATION_READ_PAGE_SIZE,
      ),
      target: input.headTarget,
    });
    for (const [listingId, state] of pageStates) {
      headStates.set(listingId, state);
    }
  }
  const exactHeadStates: DashboardChainStates = new Map();
  const fallbackListings = input.listings.filter((listing) => {
    const state = headStates.get(listing.listingId);
    const exact = Boolean(
      state?.validExtraction &&
      state.completeChain &&
      state.expectedExtractionInputHash ===
        state.completeChain.extractionInputHash &&
      state.validExtraction.artifactId ===
        state.completeChain.extractionArtifactId &&
      state.validExtraction.outputHash ===
        state.completeChain.extractionOutputHash,
    );
    if (exact && state) exactHeadStates.set(listing.listingId, state);
    return !exact;
  });
  if (fallbackListings.length === 0 && exactHeadStates.size === listingIds.size) {
    return headStates;
  }
  const readCanonicalStates = input.readCanonicalStates ?? readValidatedEnrichmentStates;
  if (
    exactHeadStates.size === 0 &&
    fallbackListings.length <= DASHBOARD_VALIDATION_READ_PAGE_SIZE
  ) {
    return await readCanonicalStates({
      listings: fallbackListings,
      target: input.canonicalTarget,
    });
  }
  const canonicalStates: DashboardChainStates = new Map();
  for (
    let offset = 0;
    offset < fallbackListings.length;
    offset += DASHBOARD_VALIDATION_READ_PAGE_SIZE
  ) {
    const pageStates = await readCanonicalStates({
      listings: fallbackListings.slice(
        offset,
        offset + DASHBOARD_VALIDATION_READ_PAGE_SIZE,
      ),
      target: input.canonicalTarget,
    });
    for (const [listingId, state] of pageStates) {
      canonicalStates.set(listingId, state);
    }
  }
  if (exactHeadStates.size === 0) return canonicalStates;
  return new Map([...exactHeadStates, ...canonicalStates]);
}

export async function readDashboardValidatedListingRatings(
  input: Parameters<typeof readValidatedListingRatings>[0],
  readRatings: typeof readValidatedListingRatings = readValidatedListingRatings,
): Promise<Map<string, ValidListingRating>> {
  const listingIds = [...new Set(input.listingIds.filter(Boolean))];
  const ratings = new Map<string, ValidListingRating>();
  for (
    let offset = 0;
    offset < listingIds.length;
    offset += DASHBOARD_VALIDATION_READ_PAGE_SIZE
  ) {
    const pageIds = listingIds.slice(
      offset,
      offset + DASHBOARD_VALIDATION_READ_PAGE_SIZE,
    );
    const pageMinimums = input.minimumScoredAtByListing
      ? new Map(pageIds.flatMap((listingId) => {
        const value = input.minimumScoredAtByListing?.get(listingId);
        return value === undefined ? [] : [[listingId, value] as const];
      }))
      : undefined;
    const pageSemanticHashes = new Map(pageIds.flatMap((listingId) => {
      const value = input.semanticOutputHashByListing.get(listingId);
      return value === undefined ? [] : [[listingId, value] as const];
    }));
    const pageRatings = await readRatings({
      ...input,
      listingIds: pageIds,
      minimumScoredAtByListing: pageMinimums,
      semanticOutputHashByListing: pageSemanticHashes,
    });
    for (const [listingId, rating] of pageRatings) ratings.set(listingId, rating);
  }
  return ratings;
}

function dashboardImageReady(row: Row): boolean {
  return dashboardPresentationImageReady({
    thumbnailUrl: text(row.thumbnail_url) || null,
    provedSourceImageAbsent: number(row.proved_source_image_absent) === 1,
    provedSourceImageUnavailable: number(row.proved_source_image_unavailable) === 1,
    primaryImageStatus: text(row.primary_image_status) || null,
    primaryImageLocalPath: text(row.primary_image_local_path) || null,
  });
}

function dashboardHasSourceImageEvidence(row: Row): boolean {
  return Boolean(text(row.thumbnail_url)) ||
    Boolean(text(row.primary_image_id)) ||
    number(row.has_any_image) > 0;
}

async function activePipelineLeaseExists(): Promise<boolean> {
  const row = await env.DB.prepare(`
    SELECT EXISTS (
      SELECT 1
      FROM pipeline_run_lease
      WHERE singleton = 1
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    ) AS active
  `).first<Row>();
  return number(row?.active) === 1;
}

export async function dashboardValidationKey(input: {
  rows: readonly Row[];
  target: EnrichmentProvenanceTarget;
  targetIdentity: string;
  scoreModelVersionId: string;
  adhocReviewCohortId: string;
  adhocReviewHeadVectorHash: string;
}): Promise<string> {
  const revision = await env.DB.prepare(`SELECT COUNT(*) AS count,
    COALESCE(MAX(updated_at || ':' || head_identity), '') AS revision
    FROM listing_enrichment_heads WHERE provenance_target_identity = ?
      AND derivation_version = ? AND state = 'complete'`).bind(
        input.targetIdentity, ENRICHMENT_HEAD_DERIVATION_VERSION,
      ).first<Row>();
  return sha256Text(JSON.stringify({
    schema: DASHBOARD_VALIDATION_CACHE_SCHEMA_VERSION,
    target: input.target, targetIdentity: input.targetIdentity,
    enrichmentInputLimit: enrichmentInputLimit(), capabilities: optionalAiCapabilities(),
    cohort: input.adhocReviewCohortId, cohortHead: input.adhocReviewHeadVectorHash,
    listings: input.rows.map(row => [text(row.id), text(row.content_hash), text(row.title), dashboardTerminalEnrichmentReady(row)]),
    enrichmentHeadCount: number(revision?.count), enrichmentHeadRevision: text(revision?.revision),
  }));
}

async function primeDashboardReleaseCache(input: {
  sourceRows: readonly Row[];
  releasedRows: readonly Row[];
  readySourceIds: ReadonlySet<string>;
  originCacheKey: string;
  providerName: string;
  profileVersionId: string;
  adhocReviewCohortId: string;
  adhocReviewHeadVectorHash: string;
  releaseVector?: DashboardReleaseVector | null;
}): Promise<void> {
  const priorVector = dashboardReleasePrimeVector.get(env.DB) ?? null;
  if (
    input.releaseVector?.settled &&
    priorVector?.vectorHash === input.releaseVector.vectorHash
  ) return;
  if (!input.profileVersionId || await activePipelineLeaseExists()) {
    invalidateDashboardReleaseCache();
    return;
  }

  const releasedListingIdsBySource = new Map<string, Set<string>>();
  for (const row of input.releasedRows) {
    const sourceId = text(row.source_id);
    const listingId = text(row.id);
    if (!sourceId || !listingId || !input.readySourceIds.has(sourceId)) continue;
    const listingIds = releasedListingIdsBySource.get(sourceId) ?? new Set<string>();
    listingIds.add(listingId);
    releasedListingIdsBySource.set(sourceId, listingIds);
  }

  const sourceRows = new Map(
    input.sourceRows.map((row) => [text(row.id), row]),
  );
  const changedSourceIds = input.releaseVector
    ? changedDashboardReleaseSourceIds(priorVector, input.releaseVector)
    : new Set(input.readySourceIds);
  const next = input.releaseVector
    ? new Map(dashboardReleaseCache.get(env.DB) ?? [])
    : new Map<string, DashboardReleaseCacheEntry>();
  for (const sourceId of changedSourceIds) next.delete(sourceId);
  for (const sourceId of changedSourceIds) {
    if (!input.readySourceIds.has(sourceId)) continue;
    const sourceRow = sourceRows.get(sourceId);
    const publicationInventoryRunId = text(
      sourceRow?.publication_inventory_run_id,
    );
    const releasedListingIds = releasedListingIdsBySource.get(sourceId);
    if (!publicationInventoryRunId || !releasedListingIds?.size) continue;
    next.set(sourceId, {
      sourceId,
      publicationInventoryRunId,
      originCacheKey: input.originCacheKey,
      providerName: input.providerName,
      profileVersionId: input.profileVersionId,
      adhocReviewCohortId: input.adhocReviewCohortId,
      adhocReviewHeadVectorHash: input.adhocReviewHeadVectorHash,
      releasedListingIds,
    });
  }
  dashboardReleaseCache.set(env.DB, next);
  if (input.releaseVector?.settled) {
    dashboardReleasePrimeVector.set(env.DB, input.releaseVector);
  } else {
    dashboardReleasePrimeVector.delete(env.DB);
  }
}

async function readDashboardVoteReleaseState(
  listingId: string,
  routeScope: Awaited<ReturnType<typeof readActiveRouteScope>>,
  activeCohort: AdhocReviewCohortStatus | null,
): Promise<DashboardReleaseCacheLookup | null> {
  const target = await env.DB.prepare(`
    WITH target (cohort_id, origin_cache_key, provider_name) AS (
      VALUES (?, ?, ?)
    )
    SELECT
      stub.source_id,
      current_inventory.inventory_run_id,
      COALESCE((
        SELECT profile_version.id
        FROM interest_profiles profile
        JOIN profile_versions profile_version
          ON profile_version.profile_id = profile.id
          AND profile_version.version = profile.current_version
        WHERE profile.id = 'default'
        LIMIT 1
      ), '') AS profile_version_id,
      EXISTS (
        SELECT 1
        FROM pipeline_run_lease
        WHERE singleton = 1
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ) AS has_active_pipeline_lease
    FROM listing_stubs stub
    JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = stub.id
      AND current_inventory.source_id = stub.source_id
      AND current_inventory.review_candidate = 1
    JOIN source_inventory_publication_heads publication_head
      ON publication_head.source_id = current_inventory.source_id
      AND publication_head.inventory_run_id = current_inventory.inventory_run_id
    CROSS JOIN target
    WHERE stub.id = ?
      AND ${dashboardPresentationReadySql("stub.id")}
      AND NOT ${dashboardTerminalPrefilterExcludedSql({
        listingIdSql: "stub.id",
        originCacheKeySql: "target.origin_cache_key",
      })}
      AND EXISTS (
        SELECT 1
        FROM listing_operational_ownership ownership
        JOIN listing_current_pipeline_state ownership_state
          ON ownership_state.listing_id = ownership.listing_id
          AND ownership_state.ownership_input_hash = ownership.ownership_input_hash
        WHERE ownership.listing_id = stub.id
          AND ownership.actionable_owner_listing_id = stub.id
      )
      AND ${dashboardAcceptedOrCohortMemberSql({
        listingIdSql: "stub.id",
        sourceIdSql: "stub.source_id",
        inventoryRunIdSql: "current_inventory.inventory_run_id",
        cohortIdSql: "target.cohort_id",
        originCacheKeySql: "target.origin_cache_key",
        providerNameSql: "target.provider_name",
      })}
    LIMIT 1
  `).bind(
    activeCohort?.id ?? "",
    routeScope.originCacheKey,
    routeScope.providerName,
    listingId,
  ).first<Row>();
  const sourceId = text(target?.source_id);
  const publicationInventoryRunId = text(target?.inventory_run_id);
  const profileVersionId = text(target?.profile_version_id);
  if (!sourceId || !publicationInventoryRunId) return null;
  return {
    sourceId,
    publicationInventoryRunId,
    originCacheKey: routeScope.originCacheKey,
    providerName: routeScope.providerName,
    profileVersionId,
    adhocReviewCohortId: activeCohort?.id ?? "",
    adhocReviewHeadVectorHash: activeCohort?.headVectorHash ?? "",
    listingId,
    hasActivePipelineLease: number(target?.has_active_pipeline_lease) === 1,
  };
}

const DASHBOARD_PRESENTATION_READ_PAGE_SIZE = 512;

async function readUnvotedDashboardListingRows(input: {
  readonly activeCohortId: string;
  readonly originCacheKey: string;
  readonly providerName: string;
}): Promise<D1Result<Row>> {
  const eligibleResult = await env.DB.prepare(`
    WITH accepted_routes AS MATERIALIZED (
      SELECT pipeline.listing_id
      FROM listing_current_pipeline_state pipeline
      JOIN listing_routes assignment
        ON assignment.listing_id = pipeline.listing_id
        AND assignment.route_cache_id = pipeline.route_cache_identity
      JOIN route_cache route
        ON route.id = pipeline.route_cache_identity
        AND route.input_hash = pipeline.route_input_hash
      WHERE route.origin_cache_key = ?
        AND route.provider_name = ?
        AND route.error_code IS NULL
        AND route.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
      GROUP BY pipeline.listing_id
    ), ${DASHBOARD_COMPLETED_REVIEWS_CTE_SQL}, presentation_ready AS MATERIALIZED (
      SELECT ready_primary.listing_id
      FROM listing_images ready_primary
      WHERE ready_primary.is_primary = 1
        AND ready_primary.download_status = 'downloaded'
        AND NULLIF(TRIM(ready_primary.local_path), '') IS NOT NULL
      UNION
      SELECT source_absent.listing_id
      FROM listing_recovery_status source_absent
      LEFT JOIN listing_images any_image
        ON any_image.listing_id = source_absent.listing_id
      WHERE source_absent.state = 'terminal'
        AND source_absent.stage = 'image'
        AND source_absent.last_error_code = 'source_image_absent'
        AND any_image.listing_id IS NULL
      UNION
      SELECT source_unavailable.listing_id
      FROM listing_recovery_status source_unavailable
      WHERE source_unavailable.state = 'terminal'
        AND source_unavailable.stage = 'image'
        AND source_unavailable.last_error_code = 'source_image_unavailable'
    ), cohort_members AS MATERIALIZED (
      SELECT membership.listing_id, membership.source_id,
        membership.inventory_run_id
      FROM adhoc_review_cohort_memberships membership
      JOIN adhoc_review_cohorts cohort
        ON cohort.id = membership.cohort_id
        AND cohort.state = 'ready'
      JOIN source_inventory_publication_heads publication_head
        ON publication_head.source_id = membership.source_id
        AND publication_head.inventory_run_id = membership.inventory_run_id
      WHERE membership.cohort_id = ?
    ), eligible AS (
      SELECT stub.id, stub.source_id, stub.discovered_at,
        ROW_NUMBER() OVER (
          PARTITION BY stub.source_id
          ORDER BY stub.discovered_at DESC, stub.id
        ) AS source_row_number
      FROM source_current_listings current_listing
      JOIN listing_stubs stub ON stub.id = current_listing.listing_id
      JOIN listing_current_pipeline_state pipeline
        ON pipeline.listing_id = stub.id
      JOIN listing_operational_ownership ownership
        ON ownership.listing_id = pipeline.listing_id
        AND ownership.ownership_input_hash = pipeline.ownership_input_hash
        AND ownership.actionable_owner_listing_id = pipeline.listing_id
      JOIN accepted_routes accepted ON accepted.listing_id = stub.id
      JOIN presentation_ready presentation ON presentation.listing_id = stub.id
      LEFT JOIN completed_reviews completed ON completed.listing_id = stub.id
      LEFT JOIN cohort_members cohort_member
        ON cohort_member.listing_id = stub.id
        AND cohort_member.source_id = current_listing.source_id
        AND cohort_member.inventory_run_id = current_listing.inventory_run_id
      WHERE current_listing.review_candidate = 1
        AND completed.listing_id IS NULL
        AND (? = '' OR cohort_member.listing_id IS NOT NULL)
    )
    SELECT id
    FROM eligible
    WHERE source_row_number <= ${DASHBOARD_PER_SOURCE_QUERY_LIMIT}
    ORDER BY discovered_at DESC, id
    LIMIT ${DASHBOARD_RAW_QUERY_LIMIT + 1}
  `).bind(
    input.originCacheKey,
    input.providerName,
    input.activeCohortId,
    input.activeCohortId,
  ).all<{ id: string }>();
  const listingIds = (eligibleResult.results ?? []).map((row) => row.id);
  const rowsById = new Map<string, Row>();
  for (
    let offset = 0;
    offset < listingIds.length;
    offset += DASHBOARD_PRESENTATION_READ_PAGE_SIZE
  ) {
    const pageIds = listingIds.slice(
      offset,
      offset + DASHBOARD_PRESENTATION_READ_PAGE_SIZE,
    );
    const page = await env.DB.prepare(`
      WITH requested AS (
        SELECT value AS listing_id FROM json_each(?)
      )
      SELECT
        s.id,
        s.source_id,
        src.display_name AS source_name,
        s.source_listing_id,
        s.source_url,
        s.thumbnail_url,
        COALESCE(observation.title, d.title_at_scrape, s.title) AS title,
        s.discovered_at,
        COALESCE(d.raw_description, '') AS raw_description,
        COALESCE(d.clean_description, '') AS clean_description,
        COALESCE(d.category_at_scrape, s.category) AS category_at_scrape,
        COALESCE(d.lot_number_at_scrape, s.lot_number) AS lot_number_at_scrape,
        d.price_amount_minor,
        d.price_currency,
        d.price_display_text,
        ${EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL} AS auction_ends_at,
        action_deadline.deadline_at AS action_deadline_at,
        action_deadline.basis AS action_deadline_basis,
        action_deadline.source_text AS action_deadline_source_text,
        action_deadline.observed_at AS action_deadline_observed_at,
        d.seller,
        COALESCE(d.pickup_city, s.visible_city) AS pickup_city,
        COALESCE(d.pickup_state, s.visible_state) AS pickup_state,
        COALESCE(d.pickup_postal_code, s.visible_postal_code)
          AS pickup_postal_code,
        COALESCE(d.pickup_country_code, s.visible_country_code)
          AS pickup_country_code,
        COALESCE(d.pickup_evidence_source, s.location_evidence_source)
          AS pickup_evidence_source,
        COALESCE(d.scraped_at, s.discovered_at) AS scraped_at,
        COALESCE(d.content_hash, s.content_hash) AS content_hash,
        new_snapshot.listing_id AS new_listing_id,
        NULL AS vote,
        rc.drive_seconds,
        rc.drive_bucket,
        rc.distance_meters AS direct_distance_meters,
        rc.provider_name AS proximity_estimator,
        route_destination.geocode_provider AS proximity_evidence,
        1 AS is_current_dashboard_row,
        0 AS review_completed,
        CASE WHEN terminal_enrichment.listing_id IS NOT NULL
            AND ${dashboardUsableSourceTextSql("s", "d")}
          THEN 1 ELSE 0 END AS terminal_enrichment_ready,
        NULL AS extraction_json,
        NULL AS ai_provider,
        NULL AS ai_model,
        NULL AS ai_prompt_version,
        NULL AS ai_generated_at,
        NULL AS semantic_document_id,
        NULL AS enrichment_embedding_id,
        NULL AS score_profile_version_id,
        NULL AS rank_score,
        NULL AS score_exploration_weight,
        NULL AS why_recommended
      FROM requested
      JOIN listing_stubs s ON s.id = requested.listing_id
      JOIN source_current_listings current_listing
        ON current_listing.listing_id = s.id
        AND current_listing.source_id = s.source_id
        AND current_listing.review_candidate = 1
      JOIN auction_sources src ON src.id = s.source_id
      LEFT JOIN listing_details d ON d.listing_id = s.id
      LEFT JOIN listing_detail_observations observation
        ON observation.listing_id = s.id
      LEFT JOIN listing_action_deadlines action_deadline
        ON action_deadline.listing_id = s.id
      LEFT JOIN dashboard_new_listings new_snapshot
        ON new_snapshot.listing_id = s.id
      LEFT JOIN listing_current_pipeline_state pipeline
        ON pipeline.listing_id = s.id
      LEFT JOIN listing_enrichment_heads terminal_enrichment
        ON terminal_enrichment.listing_id = pipeline.listing_id
        AND terminal_enrichment.head_identity =
          pipeline.enrichment_head_identity
        AND terminal_enrichment.enrichment_input_hash =
          pipeline.enrichment_input_hash
        AND terminal_enrichment.state = 'terminal'
      LEFT JOIN route_cache rc
        ON rc.id = pipeline.route_cache_identity
        AND rc.input_hash = pipeline.route_input_hash
        AND rc.origin_cache_key = ?
        AND rc.provider_name = ?
        AND rc.error_code IS NULL
        AND rc.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
      LEFT JOIN locations route_destination
        ON route_destination.id = rc.destination_location_id
    `).bind(
      JSON.stringify(pageIds),
      input.originCacheKey,
      input.providerName,
    ).all<Row>();
    for (const row of page.results ?? []) rowsById.set(text(row.id), row);
  }
  return {
    ...eligibleResult,
    results: listingIds.flatMap((listingId) => {
      const row = rowsById.get(listingId);
      return row ? [row] : [];
    }),
  } as D1Result<Row>;
}

async function readAllDashboardListingRows(input: {
  readonly activeCohortId: string;
  readonly originCacheKey: string;
  readonly providerName: string;
  readonly scoreModelVersionId: string;
  readonly listingScope: ReviewedDashboardListingScope;
}): Promise<D1Result<Row>> {
  const eligibleResult = await env.DB.prepare(`
    WITH target (
      cohort_id, origin_cache_key, provider_name, include_reviewed_history
    ) AS (
      VALUES (?, ?, ?, 1)
    ), ${DASHBOARD_COMPLETED_REVIEWS_CTE_SQL}, reviewed_history AS (
      ${dashboardReviewedHistorySql(input.listingScope)}
    ), dashboard_candidates AS (
      ${dashboardCandidateListingIdsSql(input.listingScope)}
    ), eligible AS (
      SELECT
        s.id,
        s.source_id,
        s.discovered_at,
        CASE WHEN current_listing.listing_id IS NOT NULL THEN 1 ELSE 0 END
          AS is_current_dashboard_row,
        CASE WHEN completed_review.listing_id IS NOT NULL THEN 1 ELSE 0 END
          AS review_completed,
        ROW_NUMBER() OVER (
          PARTITION BY s.source_id
          ORDER BY s.discovered_at DESC, s.id
        ) AS source_row_number
      FROM dashboard_candidates dashboard_candidate
      JOIN listing_stubs s ON s.id = dashboard_candidate.listing_id
      LEFT JOIN source_current_listings current_listing
        ON current_listing.listing_id = s.id
        AND current_listing.source_id = s.source_id
        AND current_listing.review_candidate = 1
      LEFT JOIN reviewed_history review_history
        ON review_history.listing_id = s.id
      LEFT JOIN completed_reviews completed_review
        ON completed_review.listing_id = s.id
      CROSS JOIN target
      WHERE (
          current_listing.listing_id IS NOT NULL
          OR review_history.listing_id IS NOT NULL
        )
        AND (
          review_history.listing_id IS NOT NULL
          OR (
            ${dashboardAcceptedOrCohortMemberSql({
              listingIdSql: "s.id",
              sourceIdSql: "s.source_id",
              inventoryRunIdSql: "current_listing.inventory_run_id",
              cohortIdSql: "target.cohort_id",
              originCacheKeySql: "target.origin_cache_key",
              providerNameSql: "target.provider_name",
            })}
            AND ${dashboardPresentationReadySql("s.id")}
          )
        )
    )
    SELECT id, is_current_dashboard_row, review_completed
    FROM eligible
    WHERE source_row_number <= ${DASHBOARD_PER_SOURCE_QUERY_LIMIT}
    ORDER BY discovered_at DESC, id
    LIMIT ${DASHBOARD_RAW_QUERY_LIMIT + 1}
  `).bind(
    input.activeCohortId,
    input.originCacheKey,
    input.providerName,
  ).all<Row>();
  const eligibleRows = eligibleResult.results ?? [];
  const listingIds = eligibleRows.map((row) => text(row.id));
  const eligibilityById = new Map(
    eligibleRows.map((row) => [text(row.id), row] as const),
  );
  const rowsById = new Map<string, Row>();
  for (
    let offset = 0;
    offset < listingIds.length;
    offset += DASHBOARD_PRESENTATION_READ_PAGE_SIZE
  ) {
    const pageIds = listingIds.slice(
      offset,
      offset + DASHBOARD_PRESENTATION_READ_PAGE_SIZE,
    );
    const page = await env.DB.prepare(`
      WITH requested AS (
        SELECT value AS listing_id FROM json_each(?)
      )
      SELECT
        s.id,
        s.source_id,
        src.display_name AS source_name,
        s.source_listing_id,
        s.source_url,
        s.thumbnail_url,
        COALESCE(observation.title, d.title_at_scrape, s.title) AS title,
        s.discovered_at,
        COALESCE(d.raw_description, '') AS raw_description,
        COALESCE(d.clean_description, '') AS clean_description,
        COALESCE(d.category_at_scrape, s.category) AS category_at_scrape,
        COALESCE(d.lot_number_at_scrape, s.lot_number) AS lot_number_at_scrape,
        d.price_amount_minor,
        d.price_currency,
        d.price_display_text,
        ${EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL} AS auction_ends_at,
        action_deadline.deadline_at AS action_deadline_at,
        action_deadline.basis AS action_deadline_basis,
        action_deadline.source_text AS action_deadline_source_text,
        action_deadline.observed_at AS action_deadline_observed_at,
        d.seller,
        COALESCE(d.pickup_city, s.visible_city) AS pickup_city,
        COALESCE(d.pickup_state, s.visible_state) AS pickup_state,
        COALESCE(d.pickup_postal_code, s.visible_postal_code)
          AS pickup_postal_code,
        COALESCE(d.pickup_country_code, s.visible_country_code)
          AS pickup_country_code,
        COALESCE(d.pickup_evidence_source, s.location_evidence_source)
          AS pickup_evidence_source,
        COALESCE(d.scraped_at, s.discovered_at) AS scraped_at,
        COALESCE(d.content_hash, s.content_hash) AS content_hash,
        new_snapshot.listing_id AS new_listing_id,
        v.value AS vote,
        rc.drive_seconds,
        rc.drive_bucket,
        rc.distance_meters AS direct_distance_meters,
        rc.provider_name AS proximity_estimator,
        route_destination.geocode_provider AS proximity_evidence,
        CASE WHEN terminal_enrichment.listing_id IS NOT NULL
            AND ${dashboardUsableSourceTextSql("s", "d")}
          THEN 1 ELSE 0 END AS terminal_enrichment_ready,
        NULL AS extraction_json,
        NULL AS ai_provider,
        NULL AS ai_model,
        NULL AS ai_prompt_version,
        NULL AS ai_generated_at,
        NULL AS semantic_document_id,
        NULL AS enrichment_embedding_id,
        NULL AS score_profile_version_id,
        NULL AS rank_score,
        NULL AS score_exploration_weight,
        NULL AS why_recommended
      FROM requested
      JOIN listing_stubs s ON s.id = requested.listing_id
      JOIN auction_sources src ON src.id = s.source_id
      LEFT JOIN listing_details d ON d.listing_id = s.id
      LEFT JOIN listing_detail_observations observation
        ON observation.listing_id = s.id
      LEFT JOIN listing_action_deadlines action_deadline
        ON action_deadline.listing_id = s.id
      LEFT JOIN dashboard_new_listings new_snapshot
        ON new_snapshot.listing_id = s.id
      LEFT JOIN listing_current_pipeline_state pipeline
        ON pipeline.listing_id = s.id
      LEFT JOIN listing_enrichment_heads terminal_enrichment
        ON terminal_enrichment.listing_id = pipeline.listing_id
        AND terminal_enrichment.head_identity = pipeline.enrichment_head_identity
        AND terminal_enrichment.enrichment_input_hash = pipeline.enrichment_input_hash
        AND terminal_enrichment.state = 'terminal'
      LEFT JOIN route_cache rc
        ON rc.id = pipeline.route_cache_identity
        AND rc.input_hash = pipeline.route_input_hash
        AND rc.origin_cache_key = ?
        AND rc.provider_name = ?
        AND rc.error_code IS NULL
        AND rc.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
      LEFT JOIN locations route_destination
        ON route_destination.id = rc.destination_location_id
      LEFT JOIN listing_votes v ON v.listing_id = s.id
    `).bind(
      JSON.stringify(pageIds),
      input.originCacheKey,
      input.providerName,
    ).all<Row>();
    for (const row of page.results ?? []) {
      const listingId = text(row.id);
      const eligibility = eligibilityById.get(listingId);
      if (!eligibility) continue;
      rowsById.set(listingId, {
        ...row,
        is_current_dashboard_row: number(eligibility.is_current_dashboard_row),
        review_completed: number(eligibility.review_completed),
      });
    }
  }
  return {
    ...eligibleResult,
    results: listingIds.flatMap((listingId) => {
      const row = rowsById.get(listingId);
      return row ? [row] : [];
    }),
  } as D1Result<Row>;
}

async function readCanonicalDashboardPayload(
  listingScope: DashboardListingScope = "unvoted",
  reviewVisibility: "policy" | "unfiltered" = "policy",
  releaseVector: DashboardReleaseVector | null = null,
) {
  const routeScope = await readActiveRouteScope();
  const config = getConfig();
  // The configured cohort is fully validated against its immutable source-head
  // vector before it narrows presentation scope. Route acceptance remains exact.
  const activeCohort = await readConfiguredAdhocReviewCohort();
  const activeCohortId = activeCohort?.id ?? "";
  const activeCohortHeadVectorHash = activeCohort?.headVectorHash ?? "";
  const [
    directReadResults,
    profileSignalFeedback,
    acceptedReviewCohortCounts,
  ] = await Promise.all([
    executeDashboardInitialReads<Row>(env.DB, [
      listingScope === "unvoted"
        ? () => readUnvotedDashboardListingRows({
          activeCohortId,
          originCacheKey: routeScope.originCacheKey,
          providerName: routeScope.providerName,
        })
        : () => readAllDashboardListingRows({
          activeCohortId,
          originCacheKey: routeScope.originCacheKey,
          providerName: routeScope.providerName,
          scoreModelVersionId: ACTIVE_PREFERENCE_V2_MODEL_VERSION ?? "",
          listingScope,
        }),
    env.DB.prepare(`
      SELECT pv.*
      FROM interest_profiles profile
      JOIN profile_versions pv
        ON pv.profile_id = profile.id
        AND pv.version = profile.current_version
      WHERE profile.id = 'default'
      LIMIT 1
    `),
    env.DB.prepare(`
      SELECT
        src.id,
        src.display_name,
        src.enabled,
        src.permission_status,
        sr.status AS last_status,
        sr.started_at AS last_started_at,
        sr.completed_at AS last_run,
        COALESCE(sr.stubs_discovered, 0) AS discovered,
        (
          SELECT COUNT(*)
          FROM source_current_listings catalog
          WHERE catalog.source_id = src.id
        ) AS cataloged,
        (
          SELECT publication_head.inventory_run_id
          FROM source_inventory_publication_heads publication_head
          WHERE publication_head.source_id = src.id
          LIMIT 1
        ) AS publication_inventory_run_id,
        ${unresolvedAcceptanceCountSql("src.id")} AS unresolved_acceptance_count,
        sr.error_message AS error_message
      FROM auction_sources src
       LEFT JOIN source_runs sr ON sr.id = (
        SELECT r.id
        FROM source_runs r
        WHERE r.source_id = src.id
        ORDER BY r.started_at DESC LIMIT 1
      )
      ORDER BY src.display_name
    `).bind(
      routeScope.originCacheKey,
      routeScope.originCacheKey,
      routeScope.originCacheKey,
      routeScope.providerName,
    ),
    env.DB.prepare(`
      SELECT latest.*, (
        SELECT MAX(completed.completed_at)
        FROM discovery_runs completed
        WHERE completed.origin_postal_code = ?
          AND completed.status = 'completed'
          AND EXISTS (
            SELECT 1 FROM source_runs completed_source
            WHERE completed_source.discovery_run_id = completed.id
          )
      ) AS latest_successful_completed_at,
      EXISTS (
        SELECT 1
        FROM pipeline_run_lease active_discovery_lease
        WHERE active_discovery_lease.singleton = 1
          AND active_discovery_lease.run_kind = 'discovery'
          AND active_discovery_lease.run_id = latest.id
          AND active_discovery_lease.expires_at >
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ) AS has_active_discovery_lease
      FROM discovery_runs latest
      WHERE latest.origin_postal_code = ?
        AND EXISTS (
          SELECT 1 FROM source_runs latest_source
          WHERE latest_source.discovery_run_id = latest.id
        )
      ORDER BY latest.started_at DESC
      LIMIT 1
    `).bind(routeScope.postalCode, routeScope.postalCode),
    env.DB.prepare(`
      SELECT *
      FROM enrichment_runs
      WHERE origin_postal_code = ?
        AND text_provider_name = ?
        AND text_model_name = ?
        AND extraction_prompt_version = ?
        AND semantic_document_version = ?
        AND embedding_provider_name = ?
        AND embedding_model_name = ?
      ORDER BY started_at DESC
      LIMIT 1
    `).bind(
      routeScope.postalCode,
      config.ai.textProvider,
      config.ai.textModel,
      EXTRACTION_PROMPT_VERSION,
      SEMANTIC_DOCUMENT_VERSION,
      config.ai.embeddingProvider,
      config.ai.embeddingModel,
    ),

    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM listing_stubs) AS seen
    `),
    env.DB.prepare(`
      WITH target (
        cohort_id, origin_cache_key, provider_name, include_reviewed_history
      ) AS (
        VALUES (?, ?, ?, ?)
      ), reviewed_history AS (
        ${dashboardReviewedHistorySql(listingScope)}
      ), dashboard_candidates AS (
        ${dashboardCandidateListingIdsSql(listingScope)}
      ), scoped_inventory AS (
      SELECT
        s.id,
        s.source_id,
        s.thumbnail_url,
        d.pickup_postal_code,
        d.pickup_country_code,
        rc.drive_bucket,
        rc.error_code,
        CASE WHEN current_listing.listing_id IS NOT NULL THEN 1 ELSE 0 END
          AS is_current_dashboard_row,
        CASE WHEN ${listingReviewCompletedSql("s.id")}
          THEN 1 ELSE 0 END AS review_completed,
        CASE WHEN terminal_enrichment.listing_id IS NOT NULL
            AND ${dashboardUsableSourceTextSql("s", "d")}
          THEN 1 ELSE 0 END AS terminal_enrichment_ready,
        CASE WHEN ${dashboardTerminalPrefilterExcludedSql({
          listingIdSql: "s.id",
          originCacheKeySql: "target.origin_cache_key",
        })} THEN 1 ELSE 0 END AS terminal_prefilter_exclusion,
        primary_image.id AS primary_image_id,
        primary_image.local_path AS primary_image_local_path,
        primary_image.download_status AS primary_image_status,
        CASE WHEN EXISTS (
          SELECT 1 FROM listing_images any_image WHERE any_image.listing_id = s.id
        ) THEN 1 ELSE 0 END AS has_any_image,
        CASE WHEN ${dashboardProvedSourceImageAbsentSql("s.id")}
          THEN 1 ELSE 0 END AS proved_source_image_absent,
        CASE WHEN ${dashboardProvedSourceImageUnavailableSql("s.id")}
          THEN 1 ELSE 0 END AS proved_source_image_unavailable,
        vote.value AS vote
      FROM dashboard_candidates dashboard_candidate
      JOIN listing_stubs s ON s.id = dashboard_candidate.listing_id
      LEFT JOIN source_current_listings current_listing
        ON current_listing.listing_id = s.id
        AND current_listing.source_id = s.source_id
        AND current_listing.review_candidate = 1
      LEFT JOIN reviewed_history review_history
        ON review_history.listing_id = s.id
      CROSS JOIN target
      LEFT JOIN listing_details d ON d.listing_id = s.id
      LEFT JOIN listing_images primary_image
        ON primary_image.listing_id = s.id
        AND primary_image.is_primary = 1
      LEFT JOIN listing_votes vote ON vote.listing_id = s.id
      LEFT JOIN listing_current_pipeline_state inventory_pipeline_state
        ON inventory_pipeline_state.listing_id = s.id
      LEFT JOIN listing_enrichment_heads terminal_enrichment
        ON terminal_enrichment.listing_id = inventory_pipeline_state.listing_id
        AND terminal_enrichment.head_identity =
          inventory_pipeline_state.enrichment_head_identity
        AND terminal_enrichment.enrichment_input_hash =
          inventory_pipeline_state.enrichment_input_hash
        AND terminal_enrichment.state = 'terminal'
      LEFT JOIN listing_routes inventory_route_assignment
        ON inventory_route_assignment.listing_id = s.id
        AND inventory_route_assignment.route_cache_id =
          inventory_pipeline_state.route_cache_identity
      LEFT JOIN route_cache rc
        ON rc.id = inventory_pipeline_state.route_cache_identity
        AND rc.input_hash = inventory_pipeline_state.route_input_hash
        AND rc.origin_cache_key = target.origin_cache_key
        AND rc.provider_name = target.provider_name
      WHERE (
          target.include_reviewed_history = 1
          OR NOT (${listingReviewCompletedSql("s.id")})
        )
        AND (
          review_history.listing_id IS NOT NULL
          OR (
            target.cohort_id = '' AND (
              current_listing.listing_id IS NOT NULL
            )
          )
          OR ${adhocReviewMemberExistsSql({
            listingIdSql: "s.id",
            sourceIdSql: "s.source_id",
            inventoryRunIdSql: "current_listing.inventory_run_id",
            cohortIdSql: "target.cohort_id",
          })}
        )
      ), detailed_review_inventory AS (
        SELECT scoped_inventory.*, 1 AS route_health_count
        FROM scoped_inventory
        WHERE review_completed = 1
          OR error_code = 'unknown_location'
          OR (
            COALESCE(error_code, '') = ''
            AND COALESCE(drive_bucket, '') IN (
              'under_2h', 'under_4h', 'under_8h'
            )
          )
      ), aggregate_route_health AS (
        SELECT
          NULL AS id,
          source_id,
          NULL AS thumbnail_url,
          pickup_postal_code,
          pickup_country_code,
          drive_bucket,
          error_code,
          1 AS is_current_dashboard_row,
          0 AS review_completed,
          0 AS terminal_enrichment_ready,
          terminal_prefilter_exclusion,
          NULL AS primary_image_id,
          NULL AS primary_image_local_path,
          NULL AS primary_image_status,
          0 AS has_any_image,
          0 AS proved_source_image_absent,
          0 AS proved_source_image_unavailable,
          NULL AS vote,
          COUNT(*) AS route_health_count
        FROM scoped_inventory
        WHERE is_current_dashboard_row = 1
          AND review_completed <> 1
          AND NOT (
            COALESCE(error_code, '') = 'unknown_location'
            OR (
              COALESCE(error_code, '') = ''
              AND COALESCE(drive_bucket, '') IN (
                'under_2h', 'under_4h', 'under_8h'
              )
            )
          )
        GROUP BY source_id, pickup_postal_code, pickup_country_code,
          drive_bucket, error_code, terminal_prefilter_exclusion
      )
      SELECT * FROM detailed_review_inventory
      UNION ALL
      SELECT * FROM aggregate_route_health
    `).bind(
      activeCohortId,
      routeScope.originCacheKey,
      routeScope.providerName,
      listingScope === "unvoted" ? 0 : 1,
    ),
    env.DB.prepare(`
      SELECT
        SUM(CASE WHEN value = 'interested' THEN 1 ELSE 0 END) AS interested,
        SUM(CASE WHEN value = 'not_interested' THEN 1 ELSE 0 END) AS not_interested
      FROM listing_votes
    `),
    env.DB.prepare(`
      SELECT (
        EXISTS (SELECT 1 FROM listing_votes)
        OR EXISTS (SELECT 1 FROM listing_impressions)
      ) AS has_reviewed
    `),
    ]),
    readLatestProfileSignalFeedback(),
    readCurrentAcceptedReviewCohortCounts({
      originCacheKey: routeScope.originCacheKey,
      routeProviderName: routeScope.providerName,
    }),
  ]);
  const [
    listingResult,
    profileBatchResult,
    sourceResult,
    runBatchResult,
    enrichmentRunBatchResult,
    countsBatchResult,
    distanceInventoryResult,
    voteCountsBatchResult,
    reviewCompletionBatchResult,
  ] = directReadResults;
  const profileResult = profileBatchResult.results?.[0] ?? null;
  const runResult = runBatchResult.results?.[0] ?? null;
  const enrichmentRunResult = enrichmentRunBatchResult.results?.[0] ?? null;
  const countsResult = countsBatchResult.results?.[0] ?? null;
  const voteCountsResult = voteCountsBatchResult.results?.[0] ?? null;
  const reviewCompletionResult = reviewCompletionBatchResult.results?.[0] ?? null;
  const distanceInventoryRows = distanceInventoryResult.results ?? [];
  const distanceRows = distanceInventoryRows.filter((row) => Boolean(text(row.id)));
  const aggregateRouteHealthRows: DashboardRouteHealthAggregateRow[] =
    distanceInventoryRows.flatMap((row) => text(row.id) ? [] : [{
      sourceId: text(row.source_id),
      pickupPostalCode: text(row.pickup_postal_code) || null,
      pickupCountryCode: text(row.pickup_country_code) || null,
      driveBucket: text(row.error_code) === "unknown_location"
        ? null
        : text(row.drive_bucket) || null,
      errorCode: text(row.error_code) || null,
      terminalPrefilterExclusion: Boolean(row.terminal_prefilter_exclusion),
      count: number(row.route_health_count),
    }]);
  const currentDistanceRows = distanceRows.filter((row) =>
    number(row.is_current_dashboard_row) === 1
  );
  const rawListingRows = listingResult.results ?? [];
  if (rawListingRows.length > DASHBOARD_RAW_QUERY_LIMIT) {
    throw new Error(
      `Dashboard query exceeded the bounded ${DASHBOARD_RAW_QUERY_LIMIT}-row cross-source scan`,
    );
  }
  const provenanceTarget = dashboardProvenanceTarget(config);
  const headProvenanceTarget = await enrichmentSessionProvenanceTarget(
    createSequentialEnrichmentProviders(),
  );
  const profileVersionId = text(profileResult?.id);
  const scoreModelVersionId = ACTIVE_PREFERENCE_V2_MODEL_VERSION ?? "";
  let chainStates: DashboardChainStates;
  let ratings: DashboardRatings;
  const validationCacheAllowed = Boolean(scoreModelVersionId) &&
    !await activePipelineLeaseExists();
  const validationKey = validationCacheAllowed
      ? await dashboardValidationKey({
        rows: rawListingRows,
        target: provenanceTarget,
        targetIdentity: headProvenanceTarget.identity,
        scoreModelVersionId,
        adhocReviewCohortId: activeCohortId,
        adhocReviewHeadVectorHash: activeCohortHeadVectorHash,
      })
    : "";
  const cachedValidation = validationKey
    ? dashboardValidationCache.get(env.DB)
    : undefined;
  let persistedValidation = validationKey &&
      cachedValidation?.key !== validationKey
    ? await readPersistedDashboardValidation(validationKey)
    : null;
  if (
    persistedValidation &&
    (
      !persistedDashboardValidationMatches(
        persistedValidation,
        rawListingRows,
        scoreModelVersionId,
      ) ||
      await activePipelineLeaseExists() ||
      validationKey !== await dashboardValidationKey({
        rows: rawListingRows,
        target: provenanceTarget,
        targetIdentity: headProvenanceTarget.identity,
        scoreModelVersionId,
        adhocReviewCohortId: activeCohortId,
        adhocReviewHeadVectorHash: activeCohortHeadVectorHash,
      })
    )
  ) {
    persistedValidation = null;
  }
  if (cachedValidation?.key === validationKey) {
    chainStates = cachedValidation.chainStates;
    ratings = cachedValidation.ratings;
  } else if (persistedValidation) {
    chainStates = persistedValidation.chainStates;
    ratings = persistedValidation.ratings;
    dashboardValidationCache.set(env.DB, {
      key: validationKey,
      chainStates,
      ratings,
    });
  } else {
    const validate = async () => {
      const listings = selectDashboardRowsForEnrichmentValidation(rawListingRows)
        .map(dashboardChainListing);
      const nextChainStates = await readDashboardEnrichmentStates({
        // The accepted listing query already carries the exact factual detail
        // needed for enrichment validation. Route-health inventory intentionally stays slim.
        listings,
        canonicalTarget: provenanceTarget,
        headTarget: headProvenanceTarget,
        hasActivePipelineLease: await activePipelineLeaseExists(),
      });
      const nextRatings: DashboardRatings = new Map();
      return { chainStates: nextChainStates, ratings: nextRatings };
    };
    const existingValidation = validationKey
      ? dashboardValidationInFlight.get(env.DB)
      : undefined;
    const validationPromise = existingValidation?.key === validationKey
      ? existingValidation.promise
      : validate();
    if (validationKey && existingValidation?.key !== validationKey) {
      dashboardValidationInFlight.set(env.DB, {
        key: validationKey,
        promise: validationPromise,
      });
    }
    try {
      ({ chainStates, ratings } = await validationPromise);
    } finally {
      if (dashboardValidationInFlight.get(env.DB)?.promise === validationPromise) {
        dashboardValidationInFlight.delete(env.DB);
      }
    }

    if (
      validationKey &&
      !await activePipelineLeaseExists() &&
      validationKey === await dashboardValidationKey({
        rows: rawListingRows,
        target: provenanceTarget,
        targetIdentity: headProvenanceTarget.identity,
        scoreModelVersionId,
        adhocReviewCohortId: activeCohortId,
        adhocReviewHeadVectorHash: activeCohortHeadVectorHash,
      })
    ) {
      dashboardValidationCache.set(env.DB, {
        key: validationKey,
        chainStates,
        ratings,
      });
      await persistDashboardValidation(validationKey, chainStates, ratings);
    } else {
      dashboardValidationCache.delete(env.DB);
    }
  }
  const normalizedDistanceRows: DashboardReviewInventoryRow[] = distanceRows.map((row) => {
    const routeRow = {
      sourceId: text(row.source_id),
      pickupPostalCode: text(row.pickup_postal_code) || null,
      pickupCountryCode: text(row.pickup_country_code) || null,
      driveBucket: text(row.error_code) === "unknown_location"
        ? null
        : text(row.drive_bucket) || null,
      errorCode: text(row.error_code) || null,
      terminalPrefilterExclusion: Boolean(row.terminal_prefilter_exclusion),
    } satisfies DashboardRouteInventoryRow;
    const accepted = dashboardRowHasAcceptedReviewEligibility(routeRow);
    const terminalFallback = dashboardTerminalEnrichmentReady(row);
    return {
      ...routeRow,
      sourceMemberships: [routeRow.sourceId],
      coreReady: accepted && dashboardImageReady(row),
      vote: text(row.vote) || null,
      enrichmentReady: Boolean(chainStates.get(text(row.id))?.completeChain),
      reviewReady: accepted && dashboardImageReady(row) && (
        !optionalAiCapabilities().enrichment || terminalFallback ||
        Boolean(chainStates.get(text(row.id))?.completeChain)
      ),
    };
  });
  const currentNormalizedDistanceRows = normalizedDistanceRows.filter((_row, index) =>
    number(distanceRows[index]?.is_current_dashboard_row) === 1
  );
  const enrichmentReadyListingIds = new Set(currentDistanceRows.flatMap((row) =>
    chainStates.get(text(row.id))?.completeChain ? [text(row.id)] : []
  ));
  const unresolvedAcceptanceSourceIds = activeCohort
    ? new Set<string>()
    : sourceIdsWithUnresolvedAcceptanceCandidates(
      (sourceResult.results ?? []).map((row) => ({
        sourceId: text(row.id),
        unresolvedActionableCurrentListings: number(row.unresolved_acceptance_count),
      })),
      ATOMIC_CURRENT_COHORT_SOURCE_IDS,
    );
  const oversizedReviewCohorts = oversizedAcceptedReviewCohorts(
    acceptedReviewCohortCounts,
  );
  const oversizedReviewCohortsBySource = new Map(
    oversizedReviewCohorts.map((cohort) => [cohort.sourceId, cohort]),
  );
  const blockedReviewSourceIds = new Set([
    ...unresolvedAcceptanceSourceIds,
    ...oversizedReviewCohortsBySource.keys(),
  ]);
  const readySourceIds = reviewReadySourceIds(
    currentNormalizedDistanceRows,
    blockedReviewSourceIds,
  );
  const reviewInventoryByListingId = new Map(
    distanceRows.map((row, index) => [
      text(row.id),
      normalizedDistanceRows[index]!,
    ]),
  );
  const listingRows: Row[] = rawListingRows.flatMap<Row>((row) => {
    const reviewInventory = reviewInventoryByListingId.get(text(row.id));
    const reviewCompleted = number(row.review_completed) === 1;
    if (
      !reviewCompleted && (
        !reviewInventory ||
        // Review/source-cohort readiness remains a strict mutation and
        // release concern; it must not delay factual card presentation.
        !dashboardRowIsCoreReady(reviewInventory)
      )
    ) return [];
    const chain = chainStates.get(text(row.id))?.completeChain;
    const rating = ratings.get(text(row.id));
    return [{
      ...row,
      extraction_json: chain?.extractionOutputJson ?? null,
      ai_provider: chain ? provenanceTarget.textProviderName : null,
      ai_model: chain ? provenanceTarget.textModelName : null,
      ai_prompt_version: chain ? provenanceTarget.extractionPromptVersion : null,
      ai_generated_at: chain?.extractionGeneratedAt ?? null,
      semantic_document_id: chain?.semanticArtifactId ?? null,
      enrichment_embedding_id: chain?.embeddingId ?? null,
      score_profile_version_id: rating?.profileVersionId ?? null,
      rank_score: rating?.score ?? null,
      score_exploration_weight: rating?.explorationWeight ?? 0,
      why_recommended: rating?.explanation ?? "",
    }];
  }).sort((left, right) =>
    number(right.rank_score, -1) - number(left.rank_score, -1) ||
    text(right.discovered_at).localeCompare(text(left.discovered_at)) ||
    text(left.id).localeCompare(text(right.id))
  );
  const strictReviewReadyRows = listingRows.filter((row) => {
    const reviewInventory = reviewInventoryByListingId.get(text(row.id));
    return reviewInventory?.reviewReady === true &&
      readySourceIds.has(text(row.source_id));
  });
  const currentCardVoteReadyListingIds = new Set(
    normalizedDistanceRows.flatMap((reviewInventory, index) =>
      number(distanceRows[index]?.is_current_dashboard_row) === 1 &&
        dashboardRowIsCoreReady(reviewInventory)
        ? [text(distanceRows[index]?.id)]
        : []
    ).filter(Boolean),
  );
  const rawListingIds = new Set(rawListingRows.map((row) => text(row.id)));
  assertCompleteDashboardListingCoverage(
    normalizedDistanceRows.filter((reviewInventory, index) =>
      (
        number(distanceRows[index]?.review_completed) === 1 &&
        rawListingIds.has(text(distanceRows[index]?.id))
      ) ||
      (
        dashboardRowIsCoreReady(reviewInventory) &&
        rawListingIds.has(text(distanceRows[index]?.id))
      )
    ).length,
    listingRows.length,
  );
  const voteCounts = {
    positive: number(voteCountsResult?.interested),
    negative: number(voteCountsResult?.not_interested),
  };
  const profile = profileResult
    ? mapProfile(profileResult, voteCounts, profileSignalFeedback)
    : {
        versionId: null,
        version: 0,
        generatedAt: new Date(0).toISOString(),
        positiveVotes: voteCounts.positive,
        negativeVotes: voteCounts.negative,
        confidence: 0,
        positiveConcepts: [],
        negativeConcepts: [],
        signalCorrections: [],
        representativeListingIds: [],
        summary: voteCounts.positive + voteCounts.negative > 0
          ? `${voteCounts.positive + voteCounts.negative} votes are saved. Production text enrichment is needed before reliable interest signals can be generated.`
          : "Vote on listings to begin building a text-only interest profile.",
      };
  const reviewPreferenceFilter = compileReviewPreferenceFilter({
    profileVersionId: profile.versionId,
    positiveConcepts: profile.positiveConcepts,
    negativeConcepts: profile.negativeConcepts,
  });
  type PolicyVisibleRow = {
    row: Row;
    extraction: ReturnType<typeof mapExtraction> | null;
  };
  const policyVisibleRows = listingRows.flatMap<PolicyVisibleRow>((row) => {
    let extraction: ReturnType<typeof mapExtraction> | null = null;
    if (number(row.review_completed) === 1) return [{ row, extraction }];
    const decision = reviewPreferenceVisibilityDecision(
      reviewPreferenceFilter,
      ACTIVE_PREFERENCE_V2_MODEL_VERSION,
      {
        vote: text(row.vote) || null,
        recommendationProfileVersionId:
          text(row.score_profile_version_id) || null,
        recommendationExplanation: text(row.why_recommended),
        recommendationScore: typeof row.rank_score === "number"
            ? row.rank_score
            : null,
        exploration: number(row.score_exploration_weight) > 0,
        assetClasses: () => {
          extraction = mapExtraction(row.extraction_json, text(row.title));
          return extraction.attributes.assetClasses;
        },
      },
    );
    return decision === null ? [{ row, extraction }] : [];
  });
  const currentPolicyVisibleRows = policyVisibleRows.filter(({ row }) =>
    number(row.is_current_dashboard_row) === 1
  );
  const reviewVisibilityRows = reviewVisibility === "unfiltered"
    ? listingRows.map((row) => ({ row, extraction: null }))
    : policyVisibleRows;
  const scopedRows = listingScope === "unvoted"
    ? reviewVisibilityRows.filter(({ row }) =>
        number(row.review_completed) !== 1
      )
    : reviewVisibilityRows;
  const listingIds = scopedRows.map(({ row }) => text(row.id)).filter(Boolean);
  const lotFeedback = await readDashboardLotFeedback(env.DB, listingIds);
  const primaryImageUrls = new Map(distanceRows.map((row) => [
    text(row.id),
    imagePath(row.primary_image_local_path),
  ]));

  const listings = scopedRows.map(({ row, extraction: policyExtraction }) => {
    const extraction = policyExtraction ??
      mapExtraction(row.extraction_json, text(row.title));
    const canonicalCleanDescription = canonicalItemDescription(
      text(row.clean_description),
    );
    const effectiveFeedback = lotFeedback.get(text(row.id));
    const lotDecision = effectiveFeedback?.decision ?? null;
    extraction.attributes.lotType = deriveDisplayLotType(
      extraction.attributes.lotType as ExtractedLotType,
      extraction.attributes.includedItems,
      {
        title: text(row.title),
        shortSummary: extraction.summary,
        sourceText: canonicalCleanDescription,
      },
    );
    extraction.attributes.lotType = effectiveLotType(
      extraction.attributes.lotType,
      lotDecision,
    );
    const driveMinutes = typeof row.drive_seconds !== "number"
      ? null
      : Math.max(0, Math.round(number(row.drive_seconds) / 60));
    const directDistanceMiles = typeof row.direct_distance_meters !== "number"
      ? null
      : roundedDistanceMiles(number(row.direct_distance_meters));
    const recommendationProfileVersionId = text(row.score_profile_version_id);
    const recommendationExplanation = text(row.why_recommended);
    const recommendationScore =
      (typeof row.rank_score === "number" && Number.isFinite(row.rank_score)
      ? Math.round(row.rank_score * 10) / 10
      : null);
    const recommendation = recommendationProfileVersionId &&
        recommendationExplanation &&
        recommendationScore !== null
      ? {
          profileVersionId: recommendationProfileVersionId,
          score: recommendationScore,
          explanation: recommendationExplanation,
          exploration: number(row.score_exploration_weight) > 0,
        }
      : null;
    const primarySourceId = text(row.source_id);
    const primarySource = sourceName(primarySourceId, text(row.source_name));
    const exactSourceLinks = [{
      sourceId: primarySourceId, displayName: primarySource,
      sourceListingId: text(row.source_listing_id), sourceUrl: text(row.source_url),
    }];
    const sourceFilters = exactSourceLinks
      .map((membership) => sourceName(membership.sourceId, membership.displayName))
      .filter((membership, index, all) => all.indexOf(membership) === index);
    const sourceLinks = exactSourceLinks.map((membership) => ({
      source: sourceName(membership.sourceId, membership.displayName),
      sourceListingId: membership.sourceListingId,
      url: membership.sourceUrl,
    }));
    return {
      id: text(row.id),
      source: primarySource,
      sourceFilters,
      sourceLinks,
      sourceListingId: text(row.source_listing_id),
      sourceUrl: text(row.source_url),
      sourceTaxonomy: text(row.category_at_scrape)
        ? [text(row.category_at_scrape)]
        : [],
      title: text(row.title),
      aiSummary: extraction.summary,
      // Canonical source text supports local free-text filtering before a row
      // is opened. The larger raw original and gallery remain detail-only.
      cleanDescription: canonicalCleanDescription,
      rawDescription: "",
      pickupLocation: {
        city: text(row.pickup_city, "Unknown"),
        state: text(row.pickup_state),
        postalCode: text(row.pickup_postal_code),
      },
      driveMinutes,
      driveBucket: text(row.drive_bucket) || null,
      distanceWaived: false,
      directDistanceMiles,
      proximityEvidence: text(row.proximity_evidence) || null,
      proximityEstimator: text(row.proximity_estimator) || null,
      priceAtScrape: text(row.price_display_text, "Not listed"),
      closesAt: text(row.auction_ends_at),
      actionDeadline:
        text(row.action_deadline_at) &&
          text(row.action_deadline_basis) === "live_auction_start"
          ? {
              at: text(row.action_deadline_at),
              basis: "live_auction_start" as const,
              sourceText: text(row.action_deadline_source_text),
              observedAt: text(row.action_deadline_observed_at),
            }
          : null,
      firstSeenAt: text(row.discovered_at),
      isNewSinceLastRun: Boolean(text(row.new_listing_id)),
      recommendation,
      vote: row.vote === "interested" || row.vote === "not_interested" ? row.vote : null,
      voteReady: number(row.is_current_dashboard_row) === 1
        ? currentCardVoteReadyListingIds.has(text(row.id))
        : reviewInventoryByListingId.get(text(row.id))?.coreReady === true,
      lotOverride: effectiveFeedback &&
          (lotDecision === "lot" || lotDecision === "not_lot")
        ? {
            feedbackId: effectiveFeedback.id,
            decision: lotDecision,
            createdAt: effectiveFeedback.createdAt,
            source: "operator_dashboard" as const,
          }
        : null,
      primaryImageUrl: primaryImageUrls.get(text(row.id)) ?? "",
      galleryImageUrls: [],
      images: [],
      attributes: extraction.attributes,
      aiMeta: {
        provider: text(row.ai_provider, "pending"),
        model: text(row.ai_model, "pending"),
        promptVersion: text(row.ai_prompt_version, "pending"),
        generatedAt: text(row.ai_generated_at, text(row.scraped_at)),
      },
    };
  });

  const hasReviewedListings = number(reviewCompletionResult?.has_reviewed) === 1;

  const routeHealth = summarizeDashboardRouteHealthInventory(
    currentNormalizedDistanceRows,
    aggregateRouteHealthRows,
    routeScope.postalCode,
  );
  const routeHealthBySource = new Map<string, ReturnType<typeof summarizeDashboardRouteHealth>>();
  for (const row of sourceResult.results ?? []) {
    const sourceId = text(row.id);
    routeHealthBySource.set(
      sourceId,
      summarizeDashboardRouteHealthInventory(
        currentNormalizedDistanceRows.filter((item) =>
          (item.sourceMemberships ?? [item.sourceId]).includes(sourceId)
        ),
        aggregateRouteHealthRows.filter((item) => item.sourceId === sourceId),
        routeScope.postalCode,
      ),
    );
  }

  const sources = (sourceResult.results ?? []).map((row) => {
    const sourceId = text(row.id);
    const sourceRouteHealth = routeHealthBySource.get(sourceId) ??
      summarizeDashboardRouteHealth([], routeScope.postalCode);
    const reviewRows = selectAcceptedDashboardRouteRows(currentDistanceRows.filter((item) =>
      text(item.source_id) === sourceId
    ));
    const manifest = findSourceAdapter(sourceId)?.manifest;
    const permission = text(row.permission_status);
    const enabled = Boolean(row.enabled);
    const implementationStatus = manifest?.implementationStatus ?? "not_implemented";
    const canEnable = sourceCanBeEnabled(implementationStatus, permission);
    const lastStatus = text(row.last_status);
    const oversizedReviewCohort = oversizedReviewCohortsBySource.get(sourceId);
    const state = !enabled
      ? "planned"
      : permission !== "allowed"
        ? "review"
        : lastStatus === "running"
          ? "running"
          : lastStatus === "failed"
            ? "failed"
            : lastStatus === "partial"
              ? "degraded"
              : oversizedReviewCohort
                ? "degraded"
              : lastStatus === "completed"
                ? "active"
                : "ready";
    return {
      id: sourceId,
      name: sourceName(sourceId, text(row.display_name)),
      state,
      enabled,
      canEnable,
      implementationStatus,
      lastRun: typeof row.last_run === "string"
        ? row.last_run
        : typeof row.last_started_at === "string" ? row.last_started_at : null,
      durationSeconds: completedRunDurationSeconds(
        row.last_started_at,
        row.last_run,
      ),
      discovered: number(row.discovered),
      coverage: {
        catalog: number(row.cataloged),
        proximityScope: sourceRouteHealth.scope,
        distanceComplete: sourceRouteHealth.completed,
        routeErrors: sourceRouteHealth.errors,
        unknownLocations: sourceRouteHealth.unknown,
        review: sourceRouteHealth.review,
        imageBearing: reviewRows.filter(dashboardHasSourceImageEvidence).length,
        localPrimaryImages: reviewRows.filter((item) =>
          Boolean(text(item.primary_image_local_path)) &&
          text(item.primary_image_status) === "downloaded"
        ).length,
        imageFailures: reviewRows.filter((item) =>
          text(item.primary_image_status) === "failed"
        ).length,
        enrichmentReady: reviewRows.filter((item) =>
          enrichmentReadyListingIds.has(text(item.id))
        ).length,
        voted: reviewRows.filter((item) =>
          text(item.vote) === "interested" || text(item.vote) === "not_interested"
        ).length,
      },
      detail: implementationStatus !== "ready"
        ? implementationStatus === "parser_ready_live_disabled"
          ? "Parser ready; live source contract is blocked"
          : "Not implemented"
        : permission === "allowed"
        ? enabled
          ? lastStatus === "failed"
            ? "Latest run failed"
            : lastStatus === "partial"
              ? "Latest run completed with errors"
              : oversizedReviewCohort
                ? `${oversizedReviewCohort.count.toLocaleString()} accepted listings exceed the ${MAX_ACCEPTED_REVIEW_COHORT_PER_SOURCE.toLocaleString()}-listing per-source sanity limit; category audit required`
              : "Enabled with conservative request limits"
          : "Ready but disabled"
        : permission === "review_required"
          ? "Awaiting manual automation permission review"
          : "Disabled",
      errorMessage: typeof row.error_message === "string"
        ? row.error_message
        : oversizedReviewCohort
          ? acceptedReviewCohortLimitMessage(oversizedReviewCohort)
          : null,
    };
  });

  const run = runResult;
  const currentInventoryExcludedByDistance = routeHealth.excluded;
  const unknownLocations = routeHealth.unknown;
  const routeErrors = routeHealth.errors;
  const routePending = routeHealth.pending;
  const latestSuccessfulCompletedAt = text(run?.latest_successful_completed_at);
  const refreshRequired = !latestSuccessfulCompletedAt ||
    Date.parse(latestSuccessfulCompletedAt) < Date.parse(routeScope.updatedAt);
  const acceptedReviewRows = selectAcceptedDashboardRouteRows(currentDistanceRows);
  const imageBearingReviewRows = acceptedReviewRows.filter(dashboardHasSourceImageEvidence);
  const localPrimaryCount = imageBearingReviewRows.filter((row) =>
    Boolean(text(row.primary_image_local_path)) &&
    text(row.primary_image_status) === "downloaded"
  ).length;
  const failedPrimaryCount = imageBearingReviewRows.filter((row) =>
    text(row.primary_image_status) === "failed"
  ).length;
  const enrichedCount = countEnrichmentReadyDashboardListings(currentNormalizedDistanceRows);
  const acceptedReviewCount = routeHealth.review;
  const recordedLatestState = text(run?.status, "idle");
  const staleRunningRun = recordedLatestState === "running" &&
    number(run?.has_active_discovery_lease) !== 1;
  const latestState = staleRunningRun ? "failed" : recordedLatestState;
  const discoveryState = latestState === "completed"
    ? "passed"
    : latestState === "failed" || latestState === "partial"
      ? "failed"
      : latestState === "running" ? "pending" : "not_run";
  const routingState = routeErrors > 0
    ? "failed"
    : refreshRequired || routePending > 0
      ? "pending"
      : latestState === "idle" ? "not_run" : "passed";
  const routingInventoryDetail = [
    routeErrors > 0 ? `${routeErrors.toLocaleString()} proximity errors` : "",
    routePending > 0 ? `${routePending.toLocaleString()} catalog locations pending` : "",
    unknownLocations > 0
      ? `${unknownLocations.toLocaleString()} locations unavailable`
      : "",
    currentInventoryExcludedByDistance > 0
      ? `${currentInventoryExcludedByDistance.toLocaleString()} catalog listings outside the approximate proximity limit or unknown`
      : "",
  ].filter(Boolean).join("; ");
  const imageState = failedPrimaryCount > 0
    ? "failed"
    : localPrimaryCount < imageBearingReviewRows.length
      ? "pending"
      : acceptedReviewCount > 0 ? "passed" : "not_run";
  const latestEnrichmentStatus = text(enrichmentRunResult?.status);
  const enrichmentState = !optionalAiCapabilities().enrichment ? "not_run" : latestEnrichmentStatus === "failed" ||
      latestEnrichmentStatus === "partial"
    ? "failed"
    : acceptedReviewCount === 0
      ? "not_run"
      : enrichedCount === acceptedReviewCount
        ? "passed"
        : "pending";
  const enrichmentRunDetail = latestEnrichmentStatus === "running"
    ? "latest bounded batch is running"
    : latestEnrichmentStatus === "failed" || latestEnrichmentStatus === "partial"
      ? `latest bounded batch ${latestEnrichmentStatus}${
        text(enrichmentRunResult?.error_message)
          ? `: ${text(enrichmentRunResult?.error_message)}`
          : ""
      }`
      : enrichmentRunResult
        ? `latest bounded batch completed ${number(enrichmentRunResult.completed_count)} of ${number(enrichmentRunResult.attempted)} attempts; ${number(enrichmentRunResult.remaining)} remained at completion`
        : "no dedicated enrichment batch recorded yet";
  const payload = {
    originPostalCode: routeScope.postalCode,
    listingScope,
    hasReviewedListings,
    listings,
    profile,
    sources,
    run: {
      state: latestState === "running"
        ? "running"
        : latestState === "failed" || latestState === "partial"
          ? "degraded"
          : latestState === "completed" ? "completed" : "idle",
      latestDiscoveryStatus: latestState,
      lastStartedAt: typeof run?.started_at === "string" ? run.started_at : null,
      lastCompletedAt: typeof run?.completed_at === "string" ? run.completed_at : null,
      durationSeconds: completedRunDurationSeconds(
        run?.started_at,
        run?.completed_at,
      ),
      lastSuccessfulCompletedAt: latestSuccessfulCompletedAt || null,
      nextScheduledAt: null,
      refreshRequired,
      discoveredListings: number(run?.listings_discovered),
      newListings: number(run?.listings_new),
      currentNewListings: currentPolicyVisibleRows.filter(({ row }) =>
        Boolean(text(row.new_listing_id))
      ).length,
      currentUnvotedListings: currentPolicyVisibleRows.filter(({ row }) =>
        number(row.review_completed) !== 1
      ).length,
      acceptedListings: number(run?.listings_accepted),
      seenListings: number(countsResult?.seen),
      excludedByDistance: number(run?.listings_excluded),
      errorMessage: typeof run?.error_message === "string"
        ? run.error_message
        : staleRunningRun
          ? "The last discovery run lost its durable lease before reaching a terminal state."
          : null,
      stages: [
        {
          id: "discovery",
          label: "Source discovery",
          state: discoveryState,
          detail: run
            ? `${number(run.listings_discovered).toLocaleString()} records checked`
            : "No run yet",
        },
        {
          id: "routing",
          label: "Approximate proximity",
          state: routingState,
          detail: refreshRequired
            ? routingInventoryDetail
              ? `Proximity refresh required for this origin; ${routingInventoryDetail}`
              : "Proximity refresh required for this origin"
            : routingInventoryDetail || "Current origin proximity is complete",
        },
        {
          id: "images",
          label: "Primary images",
          state: imageState,
          detail: `${localPrimaryCount} of ${imageBearingReviewRows.length} accepted image-bearing listings archived`,
        },
        {
          id: "enrichment",
          label: "Text enrichment",
          state: enrichmentState,
          detail: optionalAiCapabilities().enrichment
            ? `${enrichedCount} of ${acceptedReviewCount} accepted listings have the complete current extraction and embedding chain; ${enrichmentRunDetail}`
            : "Optional text enrichment is not configured; source facts remain reviewable.",
        },
      ],
    },
  };
  await primeDashboardReleaseCache({
    sourceRows: sourceResult.results ?? [],
    releasedRows: strictReviewReadyRows,
    readySourceIds,
    originCacheKey: routeScope.originCacheKey,
    providerName: routeScope.providerName,
    profileVersionId,
    adhocReviewCohortId: activeCohortId,
    adhocReviewHeadVectorHash: activeCohortHeadVectorHash,
    releaseVector,
  });
  return payload;
}

async function dashboardReleaseReadDecision(): Promise<{
  readonly decision: PerformanceFeatureDecision;
  readonly vector?: DashboardReleaseVector;
}> {
  const features = readNightlyPerformanceFeatures();
  if (
    features.forceCanonical ||
    features.modes.dashboardReleaseGenerations === "off" ||
    getConfig().adhocReviewCohortId !== null
  ) return { decision: "canonical" };
  const vector = await readDashboardReleaseVector(env.DB);
  const readiness = await readPerformanceFeatureReadiness({
    database: env.DB,
    featureName: "dashboardReleaseGenerations",
    derivationVersion: DASHBOARD_RELEASE_PRIME_DERIVATION_VERSION,
    generationVectorHash: vector.vectorHash,
    implementationAvailable: true,
  });
  return {
    decision: resolvePerformanceFeature({
      features,
      feature: "dashboardReleaseGenerations",
      readiness,
    }),
    vector,
  };
}

/**
 * The canonical payload remains
 * the oracle and fallback. Only an exact settled, readiness-approved release
 * vector may bypass its reconstruction and cache prime.
 */
export async function readDashboardPayload(
  listingScope: DashboardListingScope = "unvoted",
  reviewVisibility: "policy" | "unfiltered" = "policy",
) {
  const release = await dashboardReleaseReadDecision();
  const result = await readWithDashboardReleasePrime({
    database: env.DB,
    cacheKey: `${listingScope}:${reviewVisibility}`,
    decision: release.decision,
    initialVector: release.vector,
    canonicalRead: (vector) =>
      readCanonicalDashboardPayload(listingScope, reviewVisibility, vector),
  });
  return result.payload;
}

/**
 * Explicit copied-database audit seam for the release-prime readiness gate.
 * It exercises the production canonical payload and optimized vector cache
 * without consulting an as-yet-unsealed readiness receipt. Runtime requests
 * continue to enter only through readDashboardPayload above.
 */
export async function readDashboardPayloadForReleasePrimeAudit(
  listingScope: DashboardListingScope = "unvoted",
  reviewVisibility: "policy" | "unfiltered" = "policy",
) {
  const vector = await readDashboardReleaseVector(env.DB);
  return readWithDashboardReleasePrime({
    database: env.DB,
    cacheKey: `${listingScope}:${reviewVisibility}`,
    decision: "optimized",
    initialVector: vector,
    canonicalRead: (releaseVector) =>
      readCanonicalDashboardPayload(
        listingScope,
        reviewVisibility,
        releaseVector,
      ),
  });
}

/**
 * Supplies the payload-heavy immutable source text and gallery only when a
 * listing detail panel is opened. The initial Discover response needs just the
 * local primary image and card fields.
 */
export async function readDashboardListingDetail(
  listingId: string,
): Promise<DashboardListingDetailPayload | null> {
  const detail = await env.DB.prepare(`
    SELECT
      COALESCE(detail.clean_description, '') AS clean_description,
      COALESCE(detail.raw_description, '') AS raw_description
    FROM listing_stubs stub
    LEFT JOIN listing_details detail ON detail.listing_id = stub.id
    WHERE stub.id = ?
    LIMIT 1
  `).bind(listingId).first<Row>();
  if (!detail) return null;

  const imageResult = await env.DB.prepare(`
    SELECT position, is_primary, source_url, local_path,
      download_status, download_error
    FROM listing_images
    WHERE listing_id = ?
    ORDER BY position
  `).bind(listingId).all<Row>();
  const images: DashboardListingImageRecord[] = (imageResult.results ?? [])
    .map((row) => {
      const localUrl = imagePath(row.local_path) || null;
      const status = text(row.download_status, "deferred");
      return {
        position: number(row.position),
        isPrimary: number(row.is_primary) === 1,
        sourceUrl: text(row.source_url),
        localUrl,
        displayUrl: localUrl ?? "",
        downloadStatus:
          status === "pending" ||
            status === "downloaded" ||
            status === "failed"
            ? status
            : "deferred",
        downloadError: text(row.download_error) || null,
      };
    });
  return {
    listingId,
    cleanDescription: canonicalItemDescription(text(detail.clean_description)),
    rawDescription: text(detail.raw_description),
    galleryImageUrls: images.map((image) => image.displayUrl).filter(Boolean),
    images,
  };
}

function mapProfile(
  row: Row,
  voteCounts: { positive: number; negative: number },
  signalFeedback: readonly ProfileSignalFeedbackSnapshot[],
) {
  type StoredConcept = {
    label?: string;
    concept?: string;
    confidence?: number;
    supportCount?: number;
    support?: number;
    representativeListingIds?: string[];
    examples?: Array<{ listingId?: string | number; title?: string }>;
  };
  const positives = json<StoredConcept[]>(row.interested_concepts_json, []);
  const negatives = json<StoredConcept[]>(row.not_interested_concepts_json, []);
  const concept = (entry: StoredConcept) => ({
    name: entry.label ?? entry.concept ?? "unknown",
    confidence: entry.confidence ?? 0,
    support: entry.supportCount ?? entry.support ?? 0,
    note: entry.examples?.map((example) => example.title).filter(Boolean).join(", ") || "Learned from binary votes",
  });
  const ids = [...positives, ...negatives].flatMap((entry) => [
    ...(entry.representativeListingIds ?? []),
    ...(entry.examples ?? []).map((example) => String(example.listingId ?? "")).filter(Boolean),
  ]);
  const positiveVotes = voteCounts.positive;
  const negativeVotes = voteCounts.negative;
  const removedConcepts = (polarity: "positive" | "negative") => new Set(
    signalFeedback
      .filter((entry) => entry.polarity === polarity && entry.action === "removed")
      .map((entry) => entry.normalizedConcept),
  );
  const positiveRemoved = removedConcepts("positive");
  const negativeRemoved = removedConcepts("negative");
  const activeConcepts = (entries: StoredConcept[], removed: ReadonlySet<string>) => entries
    .map(concept)
    .filter((entry) => !removed.has(normalizeConcept(entry.name)));
  return {
    versionId: text(row.id) || null,
    version: number(row.version),
    generatedAt: text(row.created_at),
    positiveVotes,
    negativeVotes,
    confidence: Math.min(0.95, (positiveVotes + negativeVotes) / 20),
    positiveConcepts: activeConcepts(positives, positiveRemoved),
    negativeConcepts: activeConcepts(negatives, negativeRemoved),
    signalCorrections: signalFeedback
      .filter((entry) => entry.action === "removed")
      .map((entry) => ({
        feedbackId: entry.id,
        concept: entry.concept,
        normalizedConcept: entry.normalizedConcept,
        polarity: entry.polarity,
        removedAt: entry.createdAt,
        sourceProfileVersionId: entry.sourceProfileVersionId,
      })),
    representativeListingIds: Array.from(new Set(ids)).slice(0, 12),
    summary: text(row.human_summary, "The profile is still learning from binary votes."),
  };
}

function normalizeConcept(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

async function prepareVoteMutationInvalidation(input: {
  readonly listingIds: readonly string[];
  readonly value: "interested" | "not_interested" | null;
  readonly now: Date;
}): Promise<readonly D1PreparedStatement[]> {
  return prepareCanonicalMutationPayloadInvalidationStatements({
    database: env.DB,
    generations: [{
      domain: "votes",
      scopeType: "global",
      scopeId: "all",
      input: {
        listingIds: [...new Set(input.listingIds)].sort(),
        value: input.value,
      },
      derivationVersion: "votes-mutation-v1",
    }],
    refresh: {
      target: { type: "global", scopeId: "all" },
      reasonCode: "votes_changed",
      priority: 900,
    },
    aggregateGlobalDomains: false,
    now: input.now,
  });
}

const VOTE_MUTATION_LEASE_GUARD_ERROR =
  /pipeline_run_lease_singleton_check/u;

/**
 * Makes the lease check the first statement in the same transaction as the
 * vote and its invalidation. An active lease deliberately violates the named
 * singleton constraint, rolling the whole D1 batch back before either can
 * advance.
 */
async function executeVoteMutationBatch(
  statements: readonly D1PreparedStatement[],
): Promise<D1Result[] | null> {
  const guard = env.DB.prepare(`
    INSERT INTO pipeline_run_lease (
      singleton, run_kind, run_id, acquired_at, expires_at
    )
    SELECT
      0,
      'discovery',
      'vote-mutation-lease-guard',
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE EXISTS (
      SELECT 1
      FROM pipeline_run_lease
      WHERE singleton = 1
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  `);
  try {
    const results = await env.DB.batch([guard, ...statements]);
    return results.slice(1);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (VOTE_MUTATION_LEASE_GUARD_ERROR.test(message)) return null;
    throw error;
  }
}

export async function upsertBinaryVote(listingId: string, vote: string) {
  if (vote !== "interested" && vote !== "not_interested") {
    throw new Error("vote must be interested or not_interested");
  }
  if (await listingIsReviewReady(listingId)) {
    return upsertOperationalBinaryVote(listingId, vote);
  }
  if (!await listingIsReviewedHistoryReady(listingId)) return false;
  const now = new Date();
  const invalidation = await prepareVoteMutationInvalidation({
    listingIds: [listingId],
    value: vote,
    now,
  });
  const results = await executeVoteMutationBatch([env.DB.prepare(`
    INSERT INTO listing_votes (listing_id, value, created_at, updated_at)
    SELECT
      ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1
      FROM pipeline_run_lease
      WHERE singleton = 1
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    ON CONFLICT(listing_id) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
    WHERE listing_votes.value <> excluded.value
  `).bind(listingId, vote, now.toISOString(), now.toISOString()),
  ...invalidation]);
  if (!results) return false;
  const persisted = await env.DB.prepare(`
    SELECT value FROM listing_votes WHERE listing_id = ?
  `).bind(listingId).first<{ value: string }>();
  return persisted?.value === vote;
}

export type BulkNotInterestedOutcomeStatus =
  | "changed"
  | "unchanged_not_interested"
  | "skipped_existing_vote"
  | "skipped_not_actionable"
  | "skipped_not_ready";

export interface BulkNotInterestedOutcome {
  readonly listingId: string;
  readonly canonicalListingId: string | null;
  readonly status: BulkNotInterestedOutcomeStatus;
  readonly vote: "interested" | "not_interested" | null;
}

export interface BulkNotInterestedResult {
  readonly requestedCount: number;
  readonly changedCanonicalListingIds: readonly string[];
  readonly outcomes: readonly BulkNotInterestedOutcome[];
}

interface ReadyBulkNotInterestedPersistence {
  readonly before: ReadonlyMap<string, "interested" | "not_interested">;
  readonly after: ReadonlyMap<string, "interested" | "not_interested">;
  readonly changedCanonicalListingIds: readonly string[];
}

function exactBulkListingIds(listingIds: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const listingId of listingIds) {
    if (
      typeof listingId !== "string" || listingId.length < 1 ||
      listingId.length > 512 || listingId.trim() !== listingId ||
      /[\u0000-\u001f\u007f]/u.test(listingId)
    ) throw new TypeError("bulk vote listing identity is invalid");
    unique.add(listingId);
  }
  return [...unique];
}

async function readVotesByListingId(
  listingIds: readonly string[],
): Promise<Map<string, "interested" | "not_interested">> {
  if (listingIds.length === 0) return new Map();
  const rows = await env.DB.prepare(`
    SELECT vote.listing_id, vote.value
    FROM listing_votes vote
    JOIN json_each(?) requested ON requested.value = vote.listing_id
    WHERE requested.type = 'text'
    ORDER BY vote.listing_id
  `).bind(JSON.stringify(listingIds)).all<{
    listing_id: string;
    value: "interested" | "not_interested";
  }>();
  return new Map((rows.results ?? []).map((row) => [row.listing_id, row.value]));
}

/**
 * Applies one atomic mutation and one global vote invalidation to an already
 * readiness-validated canonical target set. Existing votes always win.
 */
export async function persistReadyBulkNotInterestedVotes(
  canonicalListingIds: readonly string[],
): Promise<ReadyBulkNotInterestedPersistence> {
  const canonicalIds = exactBulkListingIds(canonicalListingIds);
  const before = await readVotesByListingId(canonicalIds);
  const candidates = canonicalIds.filter((listingId) => !before.has(listingId));
  if (candidates.length === 0 || await activePipelineLeaseExists()) {
    return {
      before,
      after: before,
      changedCanonicalListingIds: [],
    };
  }

  const now = new Date();
  const invalidation = await prepareVoteMutationInvalidation({
    listingIds: candidates,
    value: "not_interested",
    now,
  });
  const results = await executeVoteMutationBatch([env.DB.prepare(`
    INSERT INTO listing_votes (listing_id, value, created_at, updated_at)
    SELECT DISTINCT
      requested.value,
      'not_interested',
      ?, ?
    FROM json_each(?) requested
    WHERE requested.type = 'text'
      AND NOT EXISTS (
        SELECT 1
        FROM pipeline_run_lease
        WHERE singleton = 1
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      )
      AND NOT EXISTS (
        SELECT 1 FROM listing_votes existing
        WHERE existing.listing_id = requested.value
      )
    ORDER BY requested.value
    ON CONFLICT(listing_id) DO NOTHING
  `).bind(
    now.toISOString(),
    now.toISOString(),
    JSON.stringify(candidates),
  ), ...invalidation]);
  if (!results) {
    return {
      before,
      after: before,
      changedCanonicalListingIds: [],
    };
  }

  const after = await readVotesByListingId(canonicalIds);
  const changedCanonicalListingIds = candidates.filter((listingId) =>
    !before.has(listingId) && after.get(listingId) === "not_interested"
  );
  return { before, after, changedCanonicalListingIds };
}

async function resolveOperationalBulkVoteTargets(
  requestedListingIds: readonly string[],
): Promise<Map<string, string>> {
  if (requestedListingIds.length === 0) return new Map();
  const rows = await env.DB.prepare(`
    WITH requested AS MATERIALIZED (
      SELECT DISTINCT CAST(value AS TEXT) AS requested_listing_id
      FROM json_each(?)
      WHERE type = 'text'
    ), eligible_vote_targets AS (
      SELECT
        requested.requested_listing_id,
        current_inventory.listing_id AS canonical_listing_id,
        0 AS precedence
      FROM requested
      JOIN source_current_listings current_inventory
        ON current_inventory.listing_id = requested.requested_listing_id
        AND current_inventory.review_candidate = 1
    ), ranked AS (
      SELECT
        requested_listing_id,
        canonical_listing_id,
        ROW_NUMBER() OVER (
          PARTITION BY requested_listing_id
          ORDER BY precedence, canonical_listing_id
        ) AS target_rank
      FROM eligible_vote_targets
    )
    SELECT requested_listing_id, canonical_listing_id
    FROM ranked
    WHERE target_rank = 1
    ORDER BY requested_listing_id
  `).bind(JSON.stringify(requestedListingIds)).all<{
    requested_listing_id: string;
    canonical_listing_id: string;
  }>();
  return new Map((rows.results ?? []).map((row) => [
    row.requested_listing_id,
    row.canonical_listing_id,
  ]));
}

async function readBulkTargetReadiness(
  operationalCanonicalIds: ReadonlySet<string>,
  historicalListingIds: ReadonlySet<string>,
): Promise<Map<string, boolean>> {
  const targets = [
    ...[...operationalCanonicalIds].map((listingId) => ({
      listingId,
      operational: true,
    })),
    ...[...historicalListingIds]
      .filter((listingId) => !operationalCanonicalIds.has(listingId))
      .map((listingId) => ({ listingId, operational: false })),
  ];
  const readiness = new Map<string, boolean>();
  const concurrency = 12;
  for (let offset = 0; offset < targets.length; offset += concurrency) {
    const group = targets.slice(offset, offset + concurrency);
    const values = await Promise.all(group.map(({ listingId, operational }) =>
      operational
        ? listingIsReviewReady(listingId)
        : listingIsReviewedHistoryReady(listingId)
    ));
    group.forEach(({ listingId }, index) => readiness.set(listingId, values[index]!));
  }
  return readiness;
}

/** Marks only null-vote canonical targets and returns one outcome per request. */
export async function markListingsNotInterestedIfUnvoted(
  requestedListingIds: readonly string[],
): Promise<BulkNotInterestedResult> {
  const requestedIds = exactBulkListingIds(requestedListingIds);
  if (requestedIds.length === 0) {
    throw new RangeError("bulk vote requires at least one listing identity");
  }

  const operationalTargets = await resolveOperationalBulkVoteTargets(requestedIds);
  const operationalCanonicalIds = new Set(operationalTargets.values());
  const historicalListingIds = new Set(
    requestedIds.filter((listingId) => !operationalTargets.has(listingId)),
  );
  const readiness = await readBulkTargetReadiness(
    operationalCanonicalIds,
    historicalListingIds,
  );
  const canonicalByRequest = new Map<string, string>();
  for (const listingId of requestedIds) {
    const operational = operationalTargets.get(listingId);
    if (operational) canonicalByRequest.set(listingId, operational);
    else if (readiness.get(listingId)) canonicalByRequest.set(listingId, listingId);
  }

  const readyCanonicalIds = [...new Set(canonicalByRequest.values())].filter(
    (listingId) => readiness.get(listingId) === true,
  );
  const persistence = await persistReadyBulkNotInterestedVotes(readyCanonicalIds);
  const changed = new Set(persistence.changedCanonicalListingIds);
  const outcomes = requestedIds.map((listingId): BulkNotInterestedOutcome => {
    const canonicalListingId = canonicalByRequest.get(listingId) ?? null;
    if (!canonicalListingId) {
      return {
        listingId,
        canonicalListingId: null,
        status: "skipped_not_actionable",
        vote: null,
      };
    }
    if (!readiness.get(canonicalListingId)) {
      return {
        listingId,
        canonicalListingId,
        status: "skipped_not_ready",
        vote: persistence.after.get(canonicalListingId) ?? null,
      };
    }
    if (changed.has(canonicalListingId)) {
      return {
        listingId,
        canonicalListingId,
        status: "changed",
        vote: "not_interested",
      };
    }
    const vote = persistence.after.get(canonicalListingId) ?? null;
    return {
      listingId,
      canonicalListingId,
      status: vote === "not_interested"
        ? "unchanged_not_interested"
        : vote === "interested"
          ? "skipped_existing_vote"
          : "skipped_not_ready",
      vote,
    };
  });
  return {
    requestedCount: requestedIds.length,
    changedCanonicalListingIds: [...changed],
    outcomes,
  };
}

/** Atomically re-resolves the current actionable identity at vote-write time. */
export async function upsertOperationalBinaryVote(
  listingId: string,
  vote: "interested" | "not_interested",
) {
  const target = await env.DB.prepare(`
    WITH eligible_vote_target AS (
      SELECT current_inventory.listing_id
      FROM source_current_listings current_inventory
      WHERE current_inventory.listing_id = ?
        AND current_inventory.review_candidate = 1
    )
    SELECT listing_id FROM eligible_vote_target
    ORDER BY listing_id
    LIMIT 1
  `).bind(listingId).first<{ listing_id: string }>();
  if (!target?.listing_id) return false;
  const existing = await env.DB.prepare(`
    SELECT value FROM listing_votes WHERE listing_id = ?
  `).bind(target.listing_id).first<{ value: string }>();
  if (existing?.value === vote) return true;
  const now = new Date();
  const invalidation = await prepareVoteMutationInvalidation({
    listingIds: [target.listing_id],
    value: vote,
    now,
  });
  const results = await executeVoteMutationBatch([env.DB.prepare(`
    WITH eligible_vote_target AS (
      SELECT current_inventory.listing_id
      FROM source_current_listings current_inventory
      WHERE current_inventory.listing_id = ?
        AND current_inventory.review_candidate = 1
    ), confirmed_vote_target AS (
      SELECT listing_id
      FROM eligible_vote_target
      WHERE listing_id = ?
      ORDER BY listing_id
      LIMIT 1
    )
    INSERT INTO listing_votes (listing_id, value, created_at, updated_at)
    SELECT
      listing_id,
      ?,
      ?, ?
    FROM confirmed_vote_target
    WHERE NOT EXISTS (
      SELECT 1
      FROM pipeline_run_lease
      WHERE singleton = 1
        AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
    ON CONFLICT(listing_id) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
    WHERE listing_votes.value <> excluded.value
  `).bind(
    listingId,
    target.listing_id,
    vote,
    now.toISOString(),
    now.toISOString(),
  ), ...invalidation]);
  if (!results) return false;
  const persisted = await env.DB.prepare(`
    SELECT value FROM listing_votes WHERE listing_id = ?
  `).bind(target.listing_id).first<{ value: string }>();
  return persisted?.value === vote;
}

export async function clearBinaryVote(listingId: string) {
  if (
    !await listingIsReviewReady(listingId) &&
    !await listingIsReviewedHistoryReady(listingId)
  ) return false;
  return clearOperationalBinaryVote(listingId);
}

export type BinaryVoteMutationResult = Readonly<{
  status: "saved" | "not_found" | "not_ready";
}>;

/**
 * Keeps API identity and readiness failures distinct. The boolean persistence
 * helpers remain available for internal and fixture callers, while HTTP must
 * never translate every failed readiness check into a false missing listing.
 */
export async function mutateBinaryVote(
  listingId: string,
  vote: "interested" | "not_interested" | null,
): Promise<BinaryVoteMutationResult> {
  const saved = vote === null
    ? await clearBinaryVote(listingId)
    : await upsertBinaryVote(listingId, vote);
  if (saved) return { status: "saved" };
  const existing = await env.DB.prepare(`
    SELECT EXISTS (
      SELECT 1 FROM listing_stubs WHERE id = ?
    ) AS exists_flag
  `).bind(listingId).first<{ exists_flag: number }>();
  return {
    status: number(existing?.exists_flag) === 1 ? "not_ready" : "not_found",
  };
}

/** Clears the requested listing vote while preserving immutable feedback. */
export async function clearOperationalBinaryVote(listingId: string) {
  const targets = await env.DB.prepare(`
    SELECT listing_id
    FROM listing_votes
    WHERE listing_id = ?
    ORDER BY listing_id
  `).bind(listingId).all<{ listing_id: string }>();
  const listingIds = (targets.results ?? []).map((row) => row.listing_id);
  if (listingIds.length === 0) return true;
  const now = new Date();
  const invalidation = await prepareVoteMutationInvalidation({
    listingIds,
    value: null,
    now,
  });
  const results = await executeVoteMutationBatch([env.DB.prepare(`
    DELETE FROM listing_votes
    WHERE listing_id = ?
  `).bind(listingId), ...invalidation]);
  if (!results) return false;
  if (Number(results[0]?.meta?.changes ?? 0) > 0) {
    invalidateDashboardReleaseCache();
  }
  return true;
}

/** Reviewed history retains exact route and image eligibility without a model. */

async function listingIsReviewedHistoryReady(listingId: string): Promise<boolean> {
  if (await activePipelineLeaseExists()) return false;
  const scope = await readActiveRouteScope();
  const row = await env.DB.prepare(`SELECT s.id FROM listing_stubs s
    WHERE s.id = ? AND ${listingReviewCompletedSql("s.id")}
      AND ${dashboardPresentationReadySql("s.id")}
      AND ${dashboardAcceptedRouteExistsSql({listingIdSql: "s.id", originCacheKeySql: "?", providerNameSql: "?"})}
    LIMIT 1`).bind(listingId, scope.originCacheKey, scope.providerName).first<Row>();
  return Boolean(row) && !await activePipelineLeaseExists();
}

async function listingIsReviewReady(listingId: string): Promise<boolean> {
  const routeScope = await readActiveRouteScope();
  const activeCohort = await readConfiguredAdhocReviewCohort();
  const capability = await readDashboardVoteReleaseState(
    listingId,
    routeScope,
    activeCohort,
  );
  if (!capability) return false;
  if (capability.hasActivePipelineLease) {
    invalidateDashboardReleaseCache();
    return false;
  }
  // Source health and atomic preparation remain source-wide diagnostics, but
  // they cannot disable an unrelated card that the dashboard has already
  // admitted with a current actionable owner, exact route, and settled image.
  // Optional enrichment and scoring affect presentation only.
  return true;
}
