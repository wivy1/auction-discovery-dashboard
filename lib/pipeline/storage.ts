
import { env } from "cloudflare:workers";
import { getConfig } from "../config";
import {
  locationEvidenceSources,
  normalizeVerifiedUpstreamProvenance,
  type LocationCandidate,
  type LocationEvidenceSource,
  type NormalizedListingDetail,
  type NormalizedListingStub,
  type VerifiedPublisherEventProvenanceInput,
} from "../domain/listings";
import { sha256Text } from "../ai/provenance";
import { PROFILE_SIGNAL_RESIDUAL_VERSION } from "../ranking/profile";
import {
  listingExtractionInput,
  marketplacePolicyCleanupApplied,
} from "../enrichment/input";
import {
  expectedEmbeddingDimensions as resolveExpectedEmbeddingDimensions,
} from "../enrichment/target";
import { validateTextExtraction } from "../enrichment/schema";
import { readActiveRouteScope } from "../routing/active-scope";
import type { GeographicPrefilterErrorCode } from "../routing/geographic-prefilter";
import type {
  SourceInventoryCardinality,
  SourceListingFactCompatibility,
  SourceManifest,
  SourceId,
} from "../sources/types";
import {
  SOURCE_IMAGE_UNAVAILABLE_EVIDENCE_CACHE_KEY,
} from "../images/queue-reuse";
export { SOURCE_IMAGE_UNAVAILABLE_EVIDENCE_CACHE_KEY } from "../images/queue-reuse";
import { stableContentHash } from "../sources/parsing";
import {
  PipelineRunLeaseLostError,
  renewOwnedPipelineRunLease,
  type RenewablePipelineRunKind,
} from "./lease";
import { EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL } from "./detail-observation";
import {
  NON_INLINE_RECOVERY_FAIRNESS_ORDER_SQL,
  NON_INLINE_RECOVERY_ORDER_SQL,
} from "./recovery";
import { storedStubMatchesIdentity } from "./stub-identity";
import {
  CURRENT_NEW_LISTINGS_FOR_RUN_SELECT_SQL,
  type NewListingSnapshotPolicy,
} from "../dashboard-new-listings";
import {
  adhocReviewListingMemberExistsSql,
  adhocReviewMemberExistsSql,
  configuredAdhocReviewCohortId,
} from "../review-cohort/runtime";
import {
  prepareCanonicalMutationPayloadInvalidationStatements,
} from "./mutation-invalidation";
import type { PipelineGenerationDomainName } from "../performance/generations";
import type { PipelineWorkClaimIdentity } from "./work-queue";
import { listingReviewCompletedSql } from "../review-completion";
import { LOCAL_PROXIMITY_PROVIDER_NAME } from "../routing/local-proximity";
import { locationCacheKey } from "../routing/helpers";
import {
  isExactCurrentReviewEligibleRouteDisposition,
  readExactCurrentDistanceExclusionListingIds,
  readExactCurrentRouteDispositions,
  type ExactCurrentRouteDisposition,
} from "./operational-projection";
import { ENRICHMENT_HEAD_DERIVATION_VERSION } from "./enrichment-heads";
export interface RunCounters {
  discovered: number;
  newListings: number;
  accepted: number;
  excluded: number;
}
export const PROFILE_CONSTRAINT_MANIFEST_PROMPT_VERSION =
  "profile-constraint-manifest-v1";
export interface SourceRunCounters {
  stubsDiscovered: number;
  skippedAlreadySeen: number;
  detailsFetched: number;
  accepted: number;
  excluded: number;
}
export interface SourceInventoryPublicationHead {
  readonly sourceId: SourceId;
  readonly inventoryRunId: string;
  readonly publishedAt: string;
  readonly listingCount: number;
}
export interface SourceInventorySemanticPublicationHead
  extends SourceInventoryPublicationHead {
  readonly membershipFingerprint: `sha256:${string}`;
  readonly membershipCount: number;
}
export interface CommittedSourcePublicationTransition {
  readonly sourceId: SourceId;
  readonly priorHead: SourceInventoryPublicationHead | null;
  readonly resultingHead: SourceInventoryPublicationHead;
  readonly outcome: "published";
  readonly reasonCode: "transaction_committed_publication";
}
const SOURCE_PUBLICATION_MUTATION_DERIVATION_VERSION =
  "source-publication-mutation-v1" as const;
const SOURCE_MEMBERSHIP_MUTATION_DERIVATION_VERSION =
  "source-membership-mutation-v1" as const;
const UPSTREAM_REPRESENTATIVE_MUTATION_DERIVATION_VERSION =
  "upstream-representative-mutation-v1" as const;
const ACCEPTED_DETAIL_LOCATION_MUTATION_DERIVATION_VERSION =
  "accepted-detail-location-mutation-v1" as const;
const FACTUAL_SUPPLEMENT_MUTATION_DERIVATION_VERSION =
  "factual-supplement-mutation-v1" as const;
const IMAGE_LOCAL_PRIMARY_MUTATION_DERIVATION_VERSION =
  "image-local-primary-mutation-v1" as const;
const ROUTE_CONTRACT_MUTATION_DERIVATION_VERSION =
  "route-contract-mutation-v1" as const;
async function prepareListingCanonicalMutationInvalidation(input: {
  listingId: string;
  sourceId?: string;
  domain: PipelineGenerationDomainName;
  canonicalInput: unknown;
  derivationVersion: string;
  reasonCode: string;
  priority?: number;
  now?: Date;
}): Promise<readonly D1PreparedStatement[]> {
  return prepareListingCanonicalDomainsMutationInvalidation({
    listingId: input.listingId,
    sourceId: input.sourceId,
    generations: [{
      domain: input.domain,
      canonicalInput: input.canonicalInput,
      derivationVersion: input.derivationVersion,
    }],
    reasonCode: input.reasonCode,
    priority: input.priority,
    now: input.now,
  });
}
async function prepareListingCanonicalDomainsMutationInvalidation(input: {
  listingId: string;
  sourceId?: string;
  generations: readonly {
    domain: PipelineGenerationDomainName;
    canonicalInput: unknown;
    derivationVersion: string;
  }[];
  reasonCode: string;
  priority?: number;
  now?: Date;
}): Promise<readonly D1PreparedStatement[]> {
  const sourceId = input.sourceId ?? (await env.DB.prepare(`
    SELECT source_id FROM listing_stubs WHERE id = ? LIMIT 1
  `).bind(input.listingId).first<{ source_id: string }>())?.source_id;
  if (!sourceId) {
    throw new Error(`Canonical mutation listing ${input.listingId} has no source identity`);
  }
  return prepareCanonicalMutationPayloadInvalidationStatements({
    database: env.DB,
    generations: input.generations.map((generation) => ({
      domain: generation.domain,
      scopeType: "listing",
      scopeId: input.listingId,
      input: generation.canonicalInput,
      derivationVersion: generation.derivationVersion,
    })),
    refresh: {
      target: {
        type: "listing",
        listingId: input.listingId,
        sourceId,
      },
      reasonCode: input.reasonCode,
      priority: input.priority,
    },
    now: input.now,
  });
}
async function prepareSourceMembershipMutationInvalidation(input: {
  sourceId: string;
  listingId: string;
  reasonCode: string;
  mutationKind?: string;
  evidence: unknown;
  now?: Date;
}): Promise<readonly D1PreparedStatement[]> {
  return prepareCanonicalMutationPayloadInvalidationStatements({
    database: env.DB,
    generations: [{
      domain: "source_current_membership",
      scopeType: "source",
      scopeId: input.sourceId,
      input: {
        sourceId: input.sourceId,
        listingId: input.listingId,
        mutationKind: input.mutationKind ?? "removed",
        evidence: input.evidence,
      },
      derivationVersion: SOURCE_MEMBERSHIP_MUTATION_DERIVATION_VERSION,
    }],
    refresh: {
      target: { type: "source", sourceId: input.sourceId },
      reasonCode: input.reasonCode,
      priority: 800,
    },
    now: input.now,
  });
}
async function prepareSourcePublicationMutationInvalidation(input: {
  readonly sourceId: string;
  readonly runId: string;
  readonly publicationInput: unknown;
  readonly membershipInput: unknown;
}): Promise<readonly D1PreparedStatement[]> {
  return prepareCanonicalMutationPayloadInvalidationStatements({
    database: env.DB,
    generations: [
      {
        domain: "source_publication",
        scopeType: "source",
        scopeId: input.sourceId,
        input: input.publicationInput,
        derivationVersion: SOURCE_PUBLICATION_MUTATION_DERIVATION_VERSION,
      },
      {
        domain: "source_current_membership",
        scopeType: "source",
        scopeId: input.sourceId,
        input: input.membershipInput,
        derivationVersion: SOURCE_MEMBERSHIP_MUTATION_DERIVATION_VERSION,
      },
    ],
    refresh: {
      target: { type: "source", sourceId: input.sourceId },
      reasonCode: "source_publication_changed",
      priority: 500,
    },
  });
}
export async function readSourceInventoryPublicationHeads(): Promise<
  readonly SourceInventoryPublicationHead[]
> {
  const rows = await env.DB.prepare(`
    SELECT
      head.source_id,
      head.inventory_run_id,
      publication.published_at,
      publication.listing_count
    FROM source_inventory_publication_heads head
    JOIN source_inventory_publications publication
      ON publication.source_id = head.source_id
      AND publication.inventory_run_id = head.inventory_run_id
    ORDER BY head.source_id
  `).all<{
    source_id: SourceId;
    inventory_run_id: string;
    published_at: string;
    listing_count: number;
  }>();
  return Object.freeze((rows.results ?? []).map((row) => Object.freeze({
    sourceId: row.source_id,
    inventoryRunId: row.inventory_run_id,
    publishedAt: row.published_at,
    listingCount: Number(row.listing_count),
  })));
}
const MAX_SEMANTIC_PUBLICATION_MEMBERSHIP_ROWS = 100_000;
export async function readSourceInventorySemanticPublicationHeads(): Promise<
  readonly SourceInventorySemanticPublicationHead[]
> {
  const result = await env.DB.prepare(`
    SELECT
      head.source_id,
      head.inventory_run_id,
      publication.published_at,
      publication.listing_count,
      current.listing_id,
      current.inventory_run_id AS current_inventory_run_id
    FROM source_inventory_publication_heads head
    JOIN source_inventory_publications publication
      ON publication.source_id = head.source_id
      AND publication.inventory_run_id = head.inventory_run_id
    LEFT JOIN source_current_listings current
      ON current.source_id = head.source_id
    ORDER BY head.source_id, current.listing_id
    LIMIT ?
  `).bind(MAX_SEMANTIC_PUBLICATION_MEMBERSHIP_ROWS + 1).all<{
    source_id: SourceId;
    inventory_run_id: string;
    published_at: string;
    listing_count: number;
    listing_id: string | null;
    current_inventory_run_id: string | null;
  }>();
  const rows = result.results ?? [];
  if (rows.length > MAX_SEMANTIC_PUBLICATION_MEMBERSHIP_ROWS) {
    throw new RangeError(
      `Source current membership exceeds the bounded ${MAX_SEMANTIC_PUBLICATION_MEMBERSHIP_ROWS}-row semantic fingerprint read`,
    );
  }
  const grouped = new Map<SourceId, {
    inventoryRunId: string;
    publishedAt: string;
    listingCount: number;
    listingIds: string[];
  }>();
  for (const row of rows) {
    if (
      row.listing_id !== null &&
      row.current_inventory_run_id !== row.inventory_run_id
    ) {
      throw new Error(
        `${row.source_id} current semantic membership is not bound to its publication head`,
      );
    }
    const existing = grouped.get(row.source_id);
    if (existing === undefined) {
      grouped.set(row.source_id, {
        inventoryRunId: row.inventory_run_id,
        publishedAt: row.published_at,
        listingCount: Number(row.listing_count),
        listingIds: row.listing_id === null ? [] : [row.listing_id],
      });
      continue;
    }
    if (
      existing.inventoryRunId !== row.inventory_run_id ||
      existing.publishedAt !== row.published_at ||
      existing.listingCount !== Number(row.listing_count)
    ) {
      throw new Error(
        `${row.source_id} semantic publication membership crossed incompatible heads`,
      );
    }
    if (row.listing_id !== null) existing.listingIds.push(row.listing_id);
  }
  const heads = await Promise.all([...grouped.entries()].map(
    async ([sourceId, entry]): Promise<SourceInventorySemanticPublicationHead> => {
      if (entry.listingIds.length > entry.listingCount) {
        throw new Error(
          `${sourceId} current semantic membership exceeds its immutable publication count`,
        );
      }
      return Object.freeze({
        sourceId,
        inventoryRunId: entry.inventoryRunId,
        publishedAt: entry.publishedAt,
        listingCount: entry.listingCount,
        membershipFingerprint: `sha256:${await sha256Text(JSON.stringify({
          sourceId,
          listingIds: entry.listingIds,
        }))}`,
        membershipCount: entry.listingIds.length,
      });
    },
  ));
  return Object.freeze(heads);
}
export async function readSourceInventoryPublicationHead(
  sourceId: SourceId,
): Promise<SourceInventoryPublicationHead | null> {
  const row = await env.DB.prepare(`
    SELECT
      head.source_id,
      head.inventory_run_id,
      publication.published_at,
      publication.listing_count
    FROM source_inventory_publication_heads head
    JOIN source_inventory_publications publication
      ON publication.source_id = head.source_id
      AND publication.inventory_run_id = head.inventory_run_id
    WHERE head.source_id = ?
    LIMIT 1
  `).bind(sourceId).first<{
    source_id: SourceId;
    inventory_run_id: string;
    published_at: string;
    listing_count: number;
  }>();
  if (!row) return null;
  return {
    sourceId: row.source_id,
    inventoryRunId: row.inventory_run_id,
    publishedAt: row.published_at,
    listingCount: Number(row.listing_count),
  };
}
interface SourceInventoryPublicationHeadRow {
  readonly source_id: SourceId;
  readonly inventory_run_id: string;
  readonly published_at: string;
  readonly listing_count: number;
}
function sourceInventoryPublicationHeadReadStatement(
  sourceId: SourceId,
): D1PreparedStatement {
  return env.DB.prepare(`
    SELECT
      head.source_id,
      head.inventory_run_id,
      publication.published_at,
      publication.listing_count
    FROM source_inventory_publication_heads head
    JOIN source_inventory_publications publication
      ON publication.source_id = head.source_id
      AND publication.inventory_run_id = head.inventory_run_id
    WHERE head.source_id = ?
    LIMIT 1
  `).bind(sourceId);
}
function publicationHeadFromBatchResult(
  result: D1Result | undefined,
  expectedSourceId: SourceId,
): SourceInventoryPublicationHead | null {
  const rows = (result as { results?: unknown[] } | undefined)?.results;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new Error(
      `${expectedSourceId} publication transaction returned invalid head evidence`,
    );
  }
  const row = rows[0] as Partial<SourceInventoryPublicationHeadRow>;
  const listingCount = Number(row.listing_count);
  if (
    row.source_id !== expectedSourceId ||
    typeof row.inventory_run_id !== "string" ||
    row.inventory_run_id.length < 1 ||
    typeof row.published_at !== "string" ||
    !Number.isSafeInteger(listingCount) ||
    listingCount < 0
  ) {
    throw new Error(
      `${expectedSourceId} publication transaction returned malformed head evidence`,
    );
  }
  return Object.freeze({
    sourceId: row.source_id,
    inventoryRunId: row.inventory_run_id,
    publishedAt: row.published_at,
    listingCount,
  });
}
function committedPublicationTransition(input: {
  readonly sourceId: SourceId;
  readonly runId: string;
  readonly priorResult: D1Result | undefined;
  readonly resultingResult: D1Result | undefined;
}): CommittedSourcePublicationTransition {
  const priorHead = publicationHeadFromBatchResult(
    input.priorResult,
    input.sourceId,
  );
  const resultingHead = publicationHeadFromBatchResult(
    input.resultingResult,
    input.sourceId,
  );
  if (
    resultingHead === null ||
    resultingHead.inventoryRunId !== input.runId
  ) {
    throw new Error(
      `${input.sourceId} publication transaction did not return its committed head`,
    );
  }
  return Object.freeze({
    sourceId: input.sourceId,
    priorHead,
    resultingHead,
    outcome: "published",
    reasonCode: "transaction_committed_publication",
  });
}
function attachPublicationTransition(
  result: PublishedSourceInventoryTraversal,
  transition: CommittedSourcePublicationTransition,
): PublishedSourceInventoryTraversal {
  Object.defineProperty(result, "publicationTransition", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: transition,
  });
  return result;
}
export type StoredDriveBucket =
  | "under_2h"
  | "under_4h"
  | "under_8h"
  | "exclude";
export type StoredPrimaryImageStatus =
  | "deferred"
  | "pending"
  | "downloaded"
  | "failed";
export type ImageAcquisitionMethod =
  | "browser"
  | "direct"
  | "resolved_endpoint";
export const SOURCE_IMAGE_ABSENCE_EVIDENCE_CACHE_KEY =
  "source-evidence:image-absence:v1";
export const SOURCE_LISTING_ENDED_EVIDENCE_CACHE_KEY =
  "source-evidence:listing-ended:v1";
export interface ActionableListingOwnership {
  readonly listingId: string;
  readonly actionableListingId: string | null;
  readonly isActionableOwner: boolean;
  readonly basis:
    | "shared_alias"
    | "upstream_alias"
    | "upstream_tuple"
    | "source_listing"
    | "unresolved_upstream_alias";
}
export interface ListingDetailWriteResult extends ActionableListingOwnership {
  readonly inserted: boolean;
}
export interface AcceptedPrimaryImage {
  id: string;
  listingId: string;
  source: string;
  sourceListingId: string;
  listingTitle: string;
  listingUrl: string;
  sourceUrl: string;
  thumbnailUrl: string | null;
  downloadStatus: StoredPrimaryImageStatus;
  localPath: string | null;
  acquisitionMethod: ImageAcquisitionMethod | null;
  attemptCount: number;
  lastAttemptedAt: string | null;
  downloadErrorCode: string | null;
}
export interface SourceListingProgress {
  id: string;
  hasDetail: boolean;
  hasDetailObservation: boolean;
  /** A required source action deadline is absent from immutable acquisition. */
  needsActionDeadline?: boolean;
  needsOwnershipRefresh?: boolean;
  /** Explicit local resolution for a review row with no catalog image identity. */
  needsImageIdentityRefresh?: boolean;
  driveBucket: StoredDriveBucket | null;
  /** Exact membership in the configured one-run nationwide review cohort. */
  distanceExempt?: boolean;
  /** Exact active-origin local route is a current terminal distance exclusion. */
  distanceExcluded?: boolean;
  routeErrorCode: string | null;
  primaryImageStatus: StoredPrimaryImageStatus | null;
  primaryImageErrorCode?: string | null;
  recoveryState?: "retryable" | "terminal" | null;
  recoveryLastAttemptedAt?: string | null;
  recoveryErrorCode?: string | null;
}
export interface PendingNonInlineRecoveryListing {
  listingId: string;
  stub: NormalizedListingStub;
  progress: SourceListingProgress;
}

export interface PendingNonInlineGeographicPrefilterListing {
  readonly listingId: string;
  readonly stub: NormalizedListingStub;
  readonly prefilterLocation: LocationCandidate | null;
  readonly hasCompleteDetail: boolean;
  readonly routeAttemptCount: number;
  /** Current one-row assignment, used by the global local pass to avoid rewrites. */
  readonly assignedOriginCacheKey: string | null;
  readonly assignedProviderName: string | null;
  readonly assignedInputHash: string | null;
  readonly assignedDestinationCacheKey: string | null;
  readonly assignedRouteErrorCode: string | null;
  readonly recoveryState: "retryable" | "terminal" | null;
  readonly recoveryStage: NonInlineRecoveryStage | null;
  readonly recoveryErrorCode: string | null;
}
export interface RetryableUnknownRouteRepairListing {
  readonly listingId: string;
  readonly sourceId: string;
  readonly routeLocation: LocationCandidate | null;
  readonly recoveryAttemptCount: number;
  readonly recoveryLastAttemptedAt: string;
}
export type NonInlineRecoveryStage =
  | "scope"
  | "prefilter"
  | "detail"
  | "route"
  | "image"
  | "pipeline";
function chunkValues<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}
const EXACT_ROUTE_DISPOSITION_READ_BATCH_SIZE = 250;
async function readExactRouteDispositionsForScope(input: {
  readonly listingIds: readonly string[];
  readonly originCacheKey: string;
  readonly routeProviderName: string;
}): Promise<ReadonlyMap<string, ExactCurrentRouteDisposition>> {
  const listingIds = [...new Set(input.listingIds)];
  if (listingIds.length === 0) {
    return new Map<string, ExactCurrentRouteDisposition>();
  }
  const activeRouteScope = await readActiveRouteScope();
  if (
    input.routeProviderName !== LOCAL_PROXIMITY_PROVIDER_NAME ||
    activeRouteScope.originCacheKey !== input.originCacheKey ||
    activeRouteScope.providerName !== input.routeProviderName
  ) {
    return new Map(listingIds.map((listingId) => [listingId, "stale"] as const));
  }
  const dispositions = new Map<string, ExactCurrentRouteDisposition>();
  for (
    const batch of chunkValues(listingIds, EXACT_ROUTE_DISPOSITION_READ_BATCH_SIZE)
  ) {
    const batchDispositions = await readExactCurrentRouteDispositions({
      database: env.DB,
      listingIds: batch,
      originPostalCode: activeRouteScope.postalCode,
      originCountryCode: activeRouteScope.countryCode,
    });
    for (const listingId of batch) {
      dispositions.set(
        listingId,
        batchDispositions.get(listingId) ?? "stale",
      );
    }
  }
  return dispositions;
}
async function readExactAcceptedListingIdsForScope(input: {
  readonly listingIds: readonly string[];
  readonly originCacheKey: string;
  readonly routeProviderName: string;
}): Promise<ReadonlySet<string>> {
  const dispositions = await readExactRouteDispositionsForScope(input);
  return new Set(
    [...dispositions]
      .filter(([, disposition]) =>
        isExactCurrentReviewEligibleRouteDisposition(disposition)
      )
      .map(([listingId]) => listingId),
  );
}
export interface SourceInventoryTraversalPagePlan {
  key: string;
  inventoryMember: boolean;
  reviewCandidate: boolean;
}
export interface PreparedSourceInventoryTraversal {
  traversalId: string;
  inventoryCardinality: SourceInventoryCardinality;
  listingFactCompatibility: SourceListingFactCompatibility;
  completedPageKeys: string[];
  pendingPageKeys: string[];
}
export interface SourceInventoryTraversalState {
  traversalId: string;
  sourceId: string;
  fingerprint: string;
  inventoryCardinality: SourceInventoryCardinality;
  listingFactCompatibility: SourceListingFactCompatibility;
  expectedPages: number;
  expectedListings: number;
  completedPages: number;
  incompletePages: number;
  observedListings: number;
  inventoryListings: number;
  candidateListings: number;
  completed: boolean;
  updatedAt: string;
}
export interface SourceInventoryAcquisitionAttempt {
  readonly attemptId: string;
  readonly sourceId: string;
  readonly traversalId: string | null;
  readonly reservedRequestUnits: number;
  readonly maxRequestUnits: number;
  readonly activePlanFingerprint: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
}
export type SourceInventoryAcquisitionAttemptErrorCode =
  | "source_inventory_acquisition_budget_exhausted"
  | "source_inventory_acquisition_attempt_stale"
  | "source_inventory_acquisition_drift";
export class SourceInventoryAcquisitionAttemptError extends Error {
  constructor(
    readonly code: SourceInventoryAcquisitionAttemptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SourceInventoryAcquisitionAttemptError";
  }
}
export interface PublishedSourceInventoryTraversal {
  publishedCount: number;
  catalogCount: number;
  /** Adapter-declared eligible review rows. */
  candidateCount: number;
  /**
   * Exact before/after evidence read inside the publication D1 batch. This is
   * intentionally non-enumerable at runtime so legacy count-only consumers do
   * not accidentally copy it; callers that coordinate publications read it
   * explicitly.
   */
  readonly publicationTransition?: CommittedSourcePublicationTransition;
}
export interface SourceInventoryTraversalPublicationInput {
  traversalId: string;
  runId: string;
  sourceId: string;
  originCacheKey: string;
  inventoryCardinality?: SourceInventoryCardinality;
  listingFactCompatibility?: SourceListingFactCompatibility;
  expectedReviewCandidates?: number;
  /**
   * A freshly parsed exact inventory member carries source-supplied positive
   * currentness evidence that may supersede an immutable earlier detail end.
   */
  currentInventorySupersedesPriorDetailEnd?: boolean;
  /**
   * Optional coherent acquired-bundle completion boundary. Exact close facts
   * at or before this instant cannot enter the published current snapshot.
   */
  eligibilityAt?: string;
}
export class SourceInventoryTraversalNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceInventoryTraversalNotReadyError";
  }
}
const MAX_TRAVERSAL_PAGE_COUNT = 10_000;
const MAX_TRAVERSAL_LISTINGS_PER_PAGE = 25_000;
const TRAVERSAL_PAGE_INSERT_SIZE = 20;
const TRAVERSAL_LISTING_WRITE_SIZE = 75;
const TRAVERSAL_LISTING_FACT_WRITE_SIZE = 40;
const OBSERVED_UNION_FINGERPRINT_PREFIX =
  "inventory-cardinality:observed_union:";
const EXACT_LISTING_FACT_FINGERPRINT_PREFIX =
  "inventory-listing-facts:exact:";
const UNPARTITIONED_TRAVERSAL_KEY = "unpartitioned";
function validatedTraversalKey(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1_024 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TypeError(`${label} must be a non-empty, trimmed key of at most 1024 characters`);
  }
  return value;
}
function validatedTraversalFactHash(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    !/^fnv1a64:[0-9a-f]{16}$/.test(value)
  ) {
    throw new TypeError(`${label} must be a lowercase FNV-1a 64-bit hash`);
  }
  return value;
}
function sanitizedTraversalPageKeyForError(pageKey: string): string {
  const withoutQuery = pageKey.split(/[?#]/, 1)[0] ?? "";
  const sanitized = withoutQuery
    .replace(/[^A-Za-z0-9:_-]/g, "_")
    .slice(0, 160);
  return sanitized.length > 0 ? sanitized : "[redacted]";
}
function validatedTraversalCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}
function validatedInventoryCardinality(
  value: SourceInventoryCardinality | undefined,
): SourceInventoryCardinality {
  const cardinality = value ?? "exact";
  if (cardinality !== "exact" && cardinality !== "observed_union") {
    throw new TypeError("inventory traversal cardinality is unsupported");
  }
  return cardinality;
}
function validatedListingFactCompatibility(
  value: SourceListingFactCompatibility | undefined,
): SourceListingFactCompatibility {
  const compatibility = value ?? "none";
  if (compatibility !== "none" && compatibility !== "exact") {
    throw new TypeError(
      "inventory traversal listing fact compatibility is unsupported",
    );
  }
  return compatibility;
}
function storedTraversalFingerprint(
  fingerprint: string,
  cardinality: SourceInventoryCardinality,
  listingFactCompatibility: SourceListingFactCompatibility,
): string {
  if (
    fingerprint.startsWith(OBSERVED_UNION_FINGERPRINT_PREFIX) ||
    fingerprint.startsWith(EXACT_LISTING_FACT_FINGERPRINT_PREFIX)
  ) {
    throw new TypeError("traversal fingerprint uses a reserved prefix");
  }
  const factCompatibleFingerprint = listingFactCompatibility === "exact"
    ? `${EXACT_LISTING_FACT_FINGERPRINT_PREFIX}${fingerprint}`
    : fingerprint;
  return cardinality === "observed_union"
    ? `${OBSERVED_UNION_FINGERPRINT_PREFIX}${factCompatibleFingerprint}`
    : factCompatibleFingerprint;
}
function decodedTraversalFingerprint(storedFingerprint: string): {
  fingerprint: string;
  inventoryCardinality: SourceInventoryCardinality;
  listingFactCompatibility: SourceListingFactCompatibility;
} {
  const inventoryCardinality = storedFingerprint.startsWith(
    OBSERVED_UNION_FINGERPRINT_PREFIX,
  )
    ? "observed_union"
    : "exact";
  const cardinalityDecodedFingerprint =
    inventoryCardinality === "observed_union"
      ? storedFingerprint.slice(OBSERVED_UNION_FINGERPRINT_PREFIX.length)
      : storedFingerprint;
  const listingFactCompatibility =
    cardinalityDecodedFingerprint.startsWith(
      EXACT_LISTING_FACT_FINGERPRINT_PREFIX,
    )
      ? "exact"
      : "none";
  return {
    fingerprint: listingFactCompatibility === "exact"
      ? cardinalityDecodedFingerprint.slice(
          EXACT_LISTING_FACT_FINGERPRINT_PREFIX.length,
        )
      : cardinalityDecodedFingerprint,
    inventoryCardinality,
    listingFactCompatibility,
  };
}
function normalizedTraversalObservedAt(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) {
    throw new TypeError("traversal observedAt must be a valid UTC timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError("traversal observedAt must be a valid UTC timestamp");
  }
  return new Date(parsed).toISOString();
}
export async function recordNonInlineRecoveryOutcome(input: {
  listingId: string;
  originCacheKey: string;
  state: "retryable" | "terminal";
  stage: NonInlineRecoveryStage;
  errorCode?: string | null;
}): Promise<void> {
  const attemptedAt = utcNow();
  if (
    input.state === "terminal" &&
    input.stage === "scope" &&
    input.errorCode === "source_scope_excluded"
  ) {
    const source = await env.DB.prepare(`
      SELECT source_id FROM listing_stubs WHERE id = ? LIMIT 1
    `).bind(input.listingId).first<{ source_id: string }>();
    if (!source) throw new Error(`Recovery listing ${input.listingId} has no source`);
    const invalidation = await prepareSourceMembershipMutationInvalidation({
      sourceId: source.source_id,
      listingId: input.listingId,
      mutationKind: "review_candidate_excluded",
      reasonCode: "source_scope_excluded",
      evidence: { reviewCandidate: false, errorCode: input.errorCode },
      now: new Date(attemptedAt),
    });
    await env.DB.batch([
      env.DB.prepare(`
        UPDATE source_current_listings
        SET review_candidate = 0
        WHERE listing_id = ?
      `).bind(input.listingId),
      env.DB.prepare(`
        DELETE FROM listing_recovery_status
        WHERE listing_id = ?
          AND state = 'terminal'
          AND stage = 'scope'
          AND last_error_code = 'source_scope_excluded'
      `).bind(input.listingId),
      ...invalidation,
    ]);
    return;
  }
  if (
    input.state === "terminal" &&
    input.stage === "detail" &&
    (
      input.errorCode === "detail_access_restricted" ||
      input.errorCode === "detail_location_conflict" ||
      input.errorCode === "catalog_detail_fallback"
    )
  ) {
    const errorCode = input.errorCode;
    const invalidation = await prepareListingCanonicalMutationInvalidation({
      listingId: input.listingId,
      domain: "accepted_detail_location",
      canonicalInput: {
        state: "terminal",
        stage: "detail",
        errorCode,
      },
      derivationVersion: ACCEPTED_DETAIL_LOCATION_MUTATION_DERIVATION_VERSION,
      reasonCode: "detail_terminal_changed",
      priority: 550,
      now: new Date(attemptedAt),
    });
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO listing_detail_terminal_status (
          listing_id, error_code, attempt_count, last_attempted_at
        ) VALUES (?, ?, 1, ?)
        ON CONFLICT(listing_id) DO UPDATE SET
          error_code = excluded.error_code,
          attempt_count = listing_detail_terminal_status.attempt_count + 1,
          last_attempted_at = excluded.last_attempted_at
      `).bind(input.listingId, errorCode, attemptedAt),
      env.DB.prepare(`
        DELETE FROM listing_recovery_status
        WHERE listing_id = ?
          AND NOT (state = 'terminal' AND stage = 'prefilter')
      `).bind(input.listingId),
      ...invalidation,
    ]);
    return;
  }
  const status = env.DB.prepare(`
    INSERT INTO listing_recovery_status (
      listing_id, origin_cache_key, state, stage, attempt_count,
      last_attempted_at, last_error_code
    ) VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(listing_id, origin_cache_key) DO UPDATE SET
      state = excluded.state,
      stage = excluded.stage,
      attempt_count = listing_recovery_status.attempt_count + 1,
      last_attempted_at = excluded.last_attempted_at,
      last_error_code = excluded.last_error_code
    WHERE NOT (
      listing_recovery_status.state = 'terminal'
      AND listing_recovery_status.stage = 'prefilter'
    )
  `).bind(
    input.listingId,
    input.originCacheKey,
    input.state,
    input.stage,
    attemptedAt,
    input.errorCode ?? null,
  );
  const generationDomain = input.stage === "image"
    ? "image_local_primary"
    : input.stage === "route" || input.stage === "prefilter"
    ? "route_contract"
    : input.stage === "detail"
    ? "accepted_detail_location"
    : "factual_supplement";
  const derivationVersion = generationDomain === "image_local_primary"
    ? IMAGE_LOCAL_PRIMARY_MUTATION_DERIVATION_VERSION
    : generationDomain === "accepted_detail_location"
    ? ACCEPTED_DETAIL_LOCATION_MUTATION_DERIVATION_VERSION
    : generationDomain === "factual_supplement"
    ? FACTUAL_SUPPLEMENT_MUTATION_DERIVATION_VERSION
    : "route-outcome-mutation-v1";
  const invalidation = await prepareListingCanonicalMutationInvalidation({
    listingId: input.listingId,
    domain: generationDomain,
    canonicalInput: {
      originCacheKey: input.originCacheKey,
      state: input.state,
      stage: input.stage,
      errorCode: input.errorCode ?? null,
    },
    derivationVersion,
    reasonCode: `${input.stage}_recovery_changed`,
    priority: input.state === "terminal" ? 500 : 250,
    now: new Date(attemptedAt),
  });
  await env.DB.batch([status, ...invalidation]);
}
export async function recordMissingSourceImageEvidenceAbsence(input: {
  listingId: string;
  originCacheKey: string;
}): Promise<void> {
  await recordNonInlineRecoveryOutcome({
    listingId: input.listingId,
    originCacheKey: SOURCE_IMAGE_ABSENCE_EVIDENCE_CACHE_KEY,
    state: "terminal",
    stage: "image",
    errorCode: "source_image_absent",
  });
}
export async function recordUnavailableSourceImageEvidence(input: {
  listingId: string;
}): Promise<void> {
  await recordNonInlineRecoveryOutcome({
    listingId: input.listingId,
    originCacheKey: SOURCE_IMAGE_UNAVAILABLE_EVIDENCE_CACHE_KEY,
    state: "terminal",
    stage: "image",
    errorCode: "source_image_unavailable",
  });
}
export async function clearNonInlineImageRecoveryOutcome(input: {
  listingId: string;
  originCacheKey: string;
}): Promise<boolean> {
  const exists = await env.DB.prepare(`
    SELECT 1 AS present FROM listing_recovery_status
    WHERE listing_id = ? AND origin_cache_key = ?
      AND state = 'retryable' AND stage = 'image'
    LIMIT 1
  `).bind(input.listingId, input.originCacheKey).first<{ present: number }>();
  if (!exists) return false;
  const deletion = env.DB.prepare(`
    DELETE FROM listing_recovery_status
    WHERE listing_id = ?
      AND origin_cache_key = ?
      AND state = 'retryable'
      AND stage = 'image'
  `).bind(input.listingId, input.originCacheKey);
  const invalidation = await prepareListingCanonicalMutationInvalidation({
    listingId: input.listingId,
    domain: "image_local_primary",
    canonicalInput: { recovery: "cleared", originCacheKey: input.originCacheKey },
    derivationVersion: IMAGE_LOCAL_PRIMARY_MUTATION_DERIVATION_VERSION,
    reasonCode: "image_recovery_cleared",
  });
  const result = await env.DB.batch([deletion, ...invalidation]);
  return (result[0]?.meta.changes ?? 0) > 0;
}
export async function clearNonInlineDetailRecoveryOutcome(input: {
  listingId: string;
  originCacheKey: string;
}): Promise<boolean> {
  const exists = await env.DB.prepare(`
    SELECT 1 AS present FROM listing_recovery_status
    WHERE listing_id = ? AND origin_cache_key = ?
      AND state = 'retryable' AND stage = 'detail'
    LIMIT 1
  `).bind(input.listingId, input.originCacheKey).first<{ present: number }>();
  if (!exists) return false;
  const deletion = env.DB.prepare(`
    DELETE FROM listing_recovery_status
    WHERE listing_id = ?
      AND origin_cache_key = ?
      AND state = 'retryable'
      AND stage = 'detail'
  `).bind(input.listingId, input.originCacheKey);
  const invalidation = await prepareListingCanonicalMutationInvalidation({
    listingId: input.listingId,
    domain: "accepted_detail_location",
    canonicalInput: { recovery: "cleared", originCacheKey: input.originCacheKey },
    derivationVersion: ACCEPTED_DETAIL_LOCATION_MUTATION_DERIVATION_VERSION,
    reasonCode: "detail_recovery_cleared",
  });
  const result = await env.DB.batch([deletion, ...invalidation]);
  return (result[0]?.meta.changes ?? 0) > 0;
}
export async function clearNonInlineRouteRecoveryOutcome(input: {
  listingId: string;
  originCacheKey: string;
}): Promise<boolean> {
  const exists = await env.DB.prepare(`
    SELECT 1 AS present FROM listing_recovery_status
    WHERE listing_id = ? AND origin_cache_key = ?
      AND state = 'retryable' AND stage = 'route'
    LIMIT 1
  `).bind(input.listingId, input.originCacheKey).first<{ present: number }>();
  if (!exists) return false;
  const deletion = env.DB.prepare(`
    DELETE FROM listing_recovery_status
    WHERE listing_id = ?
      AND origin_cache_key = ?
      AND state = 'retryable'
      AND stage = 'route'
  `).bind(input.listingId, input.originCacheKey);
  const invalidation = await prepareListingCanonicalMutationInvalidation({
    listingId: input.listingId,
    domain: "route_contract",
    canonicalInput: { recovery: "cleared", originCacheKey: input.originCacheKey },
    derivationVersion: "route-outcome-mutation-v1",
    reasonCode: "route_recovery_cleared",
  });
  const result = await env.DB.batch([deletion, ...invalidation]);
  return (result[0]?.meta.changes ?? 0) > 0;
}
export async function clearNonInlineOwnershipRecoveryOutcome(input: {
  listingId: string;
  originCacheKey: string;
}): Promise<boolean> {
  const exists = await env.DB.prepare(`
    SELECT 1 AS present FROM listing_recovery_status
    WHERE listing_id = ? AND origin_cache_key = ?
      AND state = 'retryable' AND stage = 'detail'
      AND last_error_code = 'unresolved_upstream_alias'
    LIMIT 1
  `).bind(input.listingId, input.originCacheKey).first<{ present: number }>();
  if (!exists) return false;
  const deletion = env.DB.prepare(`
    DELETE FROM listing_recovery_status
    WHERE listing_id = ?
      AND origin_cache_key = ?
      AND state = 'retryable'
      AND stage = 'detail'
      AND last_error_code = 'unresolved_upstream_alias'
  `).bind(input.listingId, input.originCacheKey);
  const invalidation = await prepareListingCanonicalMutationInvalidation({
    listingId: input.listingId,
    domain: "upstream_representative",
    canonicalInput: { recovery: "cleared", originCacheKey: input.originCacheKey },
    derivationVersion: UPSTREAM_REPRESENTATIVE_MUTATION_DERIVATION_VERSION,
    reasonCode: "ownership_recovery_cleared",
  });
  const result = await env.DB.batch([deletion, ...invalidation]);
  return (result[0]?.meta.changes ?? 0) > 0;
}
export async function recordNonInlineGeographicPrefilterTerminals(input: {
  originCacheKey: string;
  entries: readonly {
    listingId: string;
    errorCode: GeographicPrefilterErrorCode;
  }[];
}): Promise<number> {
  if (input.entries.length === 0) return 0;
  if (input.entries.length > 25_000) {
    throw new RangeError("geographic prefilter writes are bounded to 25000 rows");
  }
  const attemptedAt = utcNow();
  let written = 0;
  for (const chunk of chunkValues(input.entries, 20)) {
    const statementGroups = await Promise.all(chunk.map(async (entry) => {
      const invalidation = await prepareListingCanonicalMutationInvalidation({
        listingId: entry.listingId,
        domain: "route_contract",
        canonicalInput: {
          originCacheKey: input.originCacheKey,
          state: "terminal",
          stage: "prefilter",
          errorCode: entry.errorCode,
        },
        derivationVersion: ROUTE_CONTRACT_MUTATION_DERIVATION_VERSION,
        reasonCode: "prefilter_terminal_changed",
        priority: 500,
        now: new Date(attemptedAt),
      });
      return [env.DB.prepare(`
        INSERT INTO listing_recovery_status (
          listing_id, origin_cache_key, state, stage, attempt_count,
          last_attempted_at, last_error_code
        ) VALUES (?, ?, 'terminal', 'prefilter', 1, ?, ?)
        ON CONFLICT(listing_id, origin_cache_key) DO UPDATE SET
          state = 'terminal',
          stage = 'prefilter',
          attempt_count = listing_recovery_status.attempt_count + 1,
          last_attempted_at = excluded.last_attempted_at,
          last_error_code = excluded.last_error_code
      `).bind(
        entry.listingId,
        input.originCacheKey,
        attemptedAt,
        entry.errorCode,
      ), ...invalidation] as const;
    }));
    const statements: D1PreparedStatement[] = [];
    const mutationIndexes: number[] = [];
    for (const group of statementGroups) {
      mutationIndexes.push(statements.length);
      statements.push(...group);
    }
    const results = await env.DB.batch(statements);
    written += mutationIndexes.reduce(
      (sum, index) => sum + (results[index]?.meta.changes ?? 0),
      0,
    );
  }
  return written;
}
export interface EnrichmentProvenanceTarget {
  textProviderName: string;
  textModelName: string;
  extractionPromptVersion: string;
  semanticDocumentVersion: string;
  embeddingProviderName: string;
  embeddingModelName: string;
  /** Required for nonstandard models; known project models have a strict built-in contract. */
  embeddingDimensions?: number;
}
export function expectedEmbeddingDimensions(
  target: Pick<
    EnrichmentProvenanceTarget,
    "embeddingProviderName" | "embeddingModelName" | "embeddingDimensions"
  >,
): number {
  return resolveExpectedEmbeddingDimensions(target);
}
export interface EnrichmentChainListingInput {
  listingId: string;
  detail: NormalizedListingDetail;
}
export interface ValidEnrichmentChain {
  listingId: string;
  extractionArtifactId: string;
  extractionInputHash: string;
  extractionOutputJson: string;
  extractionOutputHash: string;
  extractionGeneratedAt: string;
  semanticArtifactId: string;
  semanticOutputHash: string;
  semanticGeneratedAt: string;
  embeddingId: string;
  embeddingDimensions: number;
  embeddingGeneratedAt: string;
  chainGeneratedAt: string;
  /** Loaded only when the caller explicitly requests vectors. */
  vector: number[] | null;
}
export interface ValidatedEnrichmentState {
  listingId: string;
  expectedExtractionInputHash: string;
  validExtraction: {
    artifactId: string;
    inputHash: string;
    outputJson: string;
    outputHash: string;
    generatedAt: string;
  } | null;
  completeChain: ValidEnrichmentChain | null;
}
export interface ValidListingRating {
  listingId: string;
  profileVersionId: string;
  score: number;
  explorationWeight: number;
  explanationArtifactId: string;
  explanation: string;
  scoredAt: string;
}
export interface PendingEnrichmentListing {
  listingId: string;
  detail: NormalizedListingDetail;
  needsTextGeneration: boolean;
}
export interface PendingEnrichmentQueue {
  pendingAtStart: number;
  candidates: PendingEnrichmentListing[];
}
const MAX_ENRICHMENT_QUEUE_SCAN = 10_000;
export const MAX_ACCEPTED_REVIEW_COHORT_PER_SOURCE = 1_000;
export interface AcceptedReviewCohortCount {
  sourceId: string;
  count: number;
}
export interface CurrentAdhocReviewCandidate {
  listingId: string;
  sourceId: string;
  inventoryRunId: string;
  category: string | null;
  state: string | null;
  discoveredAt: string;
  ordinaryAccepted: boolean;
  voted: boolean;
  hasDetail: boolean;
  hasDetailObservation: boolean;
  presentationReady: boolean;
}
export function oversizedAcceptedReviewCohorts(
  cohorts: readonly AcceptedReviewCohortCount[],
  limit = MAX_ACCEPTED_REVIEW_COHORT_PER_SOURCE,
): AcceptedReviewCohortCount[] {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("accepted review cohort limit must be a positive integer");
  }
  return cohorts
    .filter((cohort) =>
      cohort.sourceId.length > 0 &&
      Number.isSafeInteger(cohort.count) &&
      cohort.count > limit
    )
    .sort((left, right) =>
      right.count - left.count || left.sourceId.localeCompare(right.sourceId)
    );
}
export function acceptedReviewCohortLimitMessage(
  cohort: AcceptedReviewCohortCount,
  limit = MAX_ACCEPTED_REVIEW_COHORT_PER_SOURCE,
): string {
  return `${cohort.sourceId} has ${cohort.count.toLocaleString()} current accepted review listings, exceeding the ${limit.toLocaleString()}-listing per-source sanity limit; audit category scope and representative samples before enrichment or review`;
}
export async function readCurrentAcceptedReviewCohortCounts(input: {
  originCacheKey: string;
  routeProviderName: string;
}): Promise<AcceptedReviewCohortCount[]> {
  const result = await env.DB.prepare(`
    SELECT
      current_inventory.source_id,
      count(DISTINCT current_inventory.listing_id) AS accepted_count
    FROM source_current_listings current_inventory
    JOIN source_inventory_publication_heads current_head
      ON current_head.source_id = current_inventory.source_id
      AND current_head.inventory_run_id = current_inventory.inventory_run_id
    WHERE current_inventory.review_candidate = 1
      AND (
        EXISTS (
          SELECT 1
          FROM listing_routes route
          JOIN route_cache cached_route ON cached_route.id = route.route_cache_id
          JOIN listing_current_pipeline_state pipeline_state
            ON pipeline_state.listing_id = current_inventory.listing_id
            AND pipeline_state.source_id = current_inventory.source_id
            AND pipeline_state.source_current = 1
            AND pipeline_state.review_candidate = 1
            AND pipeline_state.active_inventory_run_id =
              current_inventory.inventory_run_id
            AND pipeline_state.route_cache_identity = route.route_cache_id
            AND pipeline_state.route_input_hash = cached_route.input_hash
          WHERE route.listing_id = current_inventory.listing_id
            AND cached_route.origin_cache_key = ?
            AND cached_route.provider_name = ?
            AND cached_route.error_code IS NULL
            AND cached_route.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
        )
      )
    GROUP BY current_inventory.source_id
    ORDER BY current_inventory.source_id
  `).bind(
    input.originCacheKey,
    input.routeProviderName,
  ).all<{
    source_id: string;
    accepted_count: number;
  }>();
  return (result.results ?? []).map((row) => ({
    sourceId: row.source_id,
    count: Number(row.accepted_count),
  }));
}
export async function readCurrentAdhocReviewCandidates(input: {
  originCacheKey: string;
  routeProviderName: string;
  baseCohortId?: string | null;
  limit?: number;
}): Promise<CurrentAdhocReviewCandidate[]> {
  const limit = input.limit ?? 60_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60_000) {
    throw new RangeError("ad hoc review candidate limit must be between 1 and 60000");
  }
  const result = await env.DB.prepare(`
    WITH physical_candidates AS (
      SELECT DISTINCT
        s.id AS listing_id,
        s.source_id,
        current_inventory.inventory_run_id,
        COALESCE(detail.category_at_scrape, s.category) AS category,
        COALESCE(detail.pickup_state, s.visible_state) AS pickup_state,
        s.discovered_at,
        CASE WHEN EXISTS (
          SELECT 1
          FROM listing_routes route
          JOIN listing_current_pipeline_state pipeline_state
            ON pipeline_state.listing_id = s.id
            AND pipeline_state.source_id = current_inventory.source_id
            AND pipeline_state.source_current = 1
            AND pipeline_state.review_candidate = 1
            AND pipeline_state.active_inventory_run_id =
              current_inventory.inventory_run_id
            AND pipeline_state.route_cache_identity = route.route_cache_id
          JOIN route_cache cached_route
            ON cached_route.id = route.route_cache_id
            AND cached_route.input_hash = pipeline_state.route_input_hash
          WHERE route.listing_id = s.id
            AND cached_route.origin_cache_key = ?
            AND cached_route.provider_name = ?
            AND cached_route.error_code IS NULL
            AND cached_route.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
        ) THEN 1 ELSE 0 END AS ordinary_accepted,
        CASE WHEN vote.listing_id IS NOT NULL THEN 1 ELSE 0 END AS voted,
        CASE WHEN detail.listing_id IS NOT NULL THEN 1 ELSE 0 END AS has_detail,
        CASE WHEN detail_observation.listing_id IS NOT NULL
          THEN 1 ELSE 0 END AS has_detail_observation,
        CASE WHEN (
          (
            NOT EXISTS (
              SELECT 1 FROM listing_images any_image
              WHERE any_image.listing_id = s.id
            )
            AND EXISTS (
              SELECT 1
              FROM listing_recovery_status proved_image_absence
              WHERE proved_image_absence.listing_id = s.id
                AND proved_image_absence.state = 'terminal'
                AND proved_image_absence.stage = 'image'
                AND proved_image_absence.last_error_code =
                  'source_image_absent'
            )
          )
          OR EXISTS (
            SELECT 1
            FROM listing_recovery_status unavailable_image
            WHERE unavailable_image.listing_id = s.id
              AND unavailable_image.state = 'terminal'
              AND unavailable_image.stage = 'image'
              AND unavailable_image.last_error_code =
                'source_image_unavailable'
          )
          OR EXISTS (
            SELECT 1 FROM listing_images ready_primary
            WHERE ready_primary.listing_id = s.id
              AND ready_primary.is_primary = 1
              AND ready_primary.download_status = 'downloaded'
              AND NULLIF(TRIM(ready_primary.local_path), '') IS NOT NULL
          )
        ) THEN 1 ELSE 0 END AS presentation_ready,
        s.id AS actionable_listing_id
      FROM listing_stubs s
      JOIN source_current_listings current_inventory
        ON current_inventory.listing_id = s.id
        AND current_inventory.source_id = s.source_id
        AND current_inventory.review_candidate = 1
      JOIN source_inventory_publication_heads current_head
        ON current_head.source_id = current_inventory.source_id
        AND current_head.inventory_run_id = current_inventory.inventory_run_id
      LEFT JOIN listing_details detail ON detail.listing_id = s.id
      LEFT JOIN listing_detail_observations detail_observation
        ON detail_observation.listing_id = s.id
      LEFT JOIN listing_votes vote ON vote.listing_id = s.id
      WHERE (
        NOT EXISTS (
          SELECT 1 FROM listing_detail_terminal_status terminal_detail
          WHERE terminal_detail.listing_id = s.id
        )
        OR (
          ? IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM adhoc_review_cohort_memberships base_membership
            WHERE base_membership.cohort_id = ?
              AND base_membership.listing_id = s.id
          )
        )
      )
    )
    SELECT *
    FROM physical_candidates
    WHERE actionable_listing_id = listing_id
      AND ordinary_accepted = 1
    ORDER BY source_id, listing_id
    LIMIT ?
  `).bind(
    input.originCacheKey,
    input.routeProviderName,
    input.baseCohortId ?? null,
    input.baseCohortId ?? null,
    limit + 1,
  ).all<{
    listing_id: string;
    source_id: string;
    inventory_run_id: string;
    category: string | null;
    pickup_state: string | null;
    discovered_at: string;
    ordinary_accepted: number;
    voted: number;
    has_detail: number;
    has_detail_observation: number;
    presentation_ready: number;
  }>();
  const rows = result.results ?? [];
  if (rows.length > limit) {
    throw new Error(`Ad hoc review candidate inventory exceeds ${limit} rows`);
  }
  return rows.map((row) => ({
    listingId: row.listing_id,
    sourceId: row.source_id,
    inventoryRunId: row.inventory_run_id,
    category: row.category,
    state: row.pickup_state,
    discoveredAt: row.discovered_at,
    ordinaryAccepted: row.ordinary_accepted === 1,
    voted: row.voted === 1,
    hasDetail: row.has_detail === 1,
    hasDetailObservation: row.has_detail_observation === 1,
    presentationReady: row.presentation_ready === 1,
  }));
}

export const MAX_AI_PROVENANCE_RETRY_READ = 16;
const VALIDATED_CHAIN_READ_BATCH_SIZE = 200;
const VALIDATED_ENRICHMENT_HEAD_READ_BATCH_SIZE = 1_000;
const VALIDATED_RATING_READ_BATCH_SIZE = 50;
const VALIDATED_VECTOR_READ_BATCH_SIZE = 50;
const MAX_VALIDATED_CHAIN_LISTINGS = 10_000;
export const DEFAULT_DISCOVERY_RUN_LEASE_MS = 2 * 60 * 60 * 1_000;
const ENRICHMENT_ABSOLUTE_WORKFLOW_HORIZON_MS = 5 * 60 * 60 * 1_000;
const ENRICHMENT_TERMINAL_CLEANUP_MARGIN_MS = 5 * 60 * 1_000;
export const ENRICHMENT_GENERATION_ABANDONMENT_HORIZON_MS =
  ENRICHMENT_ABSOLUTE_WORKFLOW_HORIZON_MS +
  ENRICHMENT_TERMINAL_CLEANUP_MARGIN_MS;
export type PipelineRunKind = "discovery" | "enrichment";
export interface EnrichmentRunTelemetry {
  pendingAtStart: number;
  attempted: number;
  completed: number;
  failures: number;
  remaining: number;
  profileVotesUsed: number;
}
export interface BeginEnrichmentRunInput {
  originPostalCode: string;
  requestedLimit: number;
  effectiveLimit: number;
  target: EnrichmentProvenanceTarget;
  leaseMs?: number;
}
export class DiscoveryRunBusyError extends Error {
  readonly activeRunId: string;
  readonly activeRunKind: PipelineRunKind;

  constructor(activeRunId: string, activeRunKind: PipelineRunKind = "discovery") {
    super(`${pipelineRunLabel(activeRunKind)} run ${activeRunId} is already in progress`);
    this.name = "DiscoveryRunBusyError";
    this.activeRunId = activeRunId;
    this.activeRunKind = activeRunKind;
  }
}
export class EnrichmentRunBusyError extends Error {
  readonly activeRunId: string;
  readonly activeRunKind: PipelineRunKind;

  constructor(activeRunId: string, activeRunKind: PipelineRunKind) {
    super(`${pipelineRunLabel(activeRunKind)} run ${activeRunId} is already in progress`);
    this.name = "EnrichmentRunBusyError";
    this.activeRunId = activeRunId;
    this.activeRunKind = activeRunKind;
  }
}
const utcNow = () => new Date().toISOString();
function parseStoredDriveBucket(value: string | null): StoredDriveBucket | null {
  switch (value) {
    case "under_2h":
    case "under_4h":
    case "under_8h":
    case "exclude":
      return value;
    default:
      return null;
  }
}
function parseNonInlineRecoveryStage(
  value: string | null,
): NonInlineRecoveryStage | null {
  switch (value) {
    case "scope":
    case "prefilter":
    case "detail":
    case "route":
    case "image":
    case "pipeline":
      return value;
    default:
      return null;
  }
}
function parseStoredPrimaryImageStatus(
  value: string | null,
): StoredPrimaryImageStatus | null {
  switch (value) {
    case "deferred":
    case "pending":
    case "downloaded":
    case "failed":
      return value;
    default:
      return null;
  }
}
export function listingKey(sourceId: string, sourceListingId: string): string {
  return `${sourceId}:${sourceListingId}`;
}
export async function syncSourceManifests(
  manifests: readonly SourceManifest[],
  enabled: Readonly<Record<string, boolean>>,
  accessAllowed: Readonly<Record<string, boolean>> = {},
) {
  if (manifests.length === 0) return;

  const manifestStates = manifests.map((manifest) => {
    const permissionStatus =
      accessAllowed[manifest.id] || manifest.access.permissionBasis === "official_public_api"
        ? "allowed"
        : manifest.access.permissionBasis === "prohibited" ? "disabled" : "review_required";
    const runnable = manifest.implementationStatus === "ready" &&
      permissionStatus === "allowed";
    return { manifest, permissionStatus, runnable } as const;
  });
  const storedResult = await env.DB.prepare(`
    SELECT id, display_name, base_url, enabled, permission_status
    FROM auction_sources
    WHERE id IN (${manifests.map(() => "?").join(", ")})
  `).bind(...manifests.map((manifest) => manifest.id)).all<{
    id: string;
    display_name: string;
    base_url: string;
    enabled: number;
    permission_status: string;
  }>();
  const storedById = new Map(
    (storedResult.results ?? []).map((row) => [row.id, row] as const),
  );
  const alreadySynchronized = manifestStates.every(
    ({ manifest, permissionStatus, runnable }) => {
      const stored = storedById.get(manifest.id);
      return stored?.display_name === manifest.displayName &&
        stored.base_url === manifest.baseUrl &&
        stored.permission_status === permissionStatus &&
        (runnable
          ? stored.enabled === 0 || stored.enabled === 1
          : stored.enabled === 0);
    },
  );
  if (alreadySynchronized) return;

  const statements = manifestStates.flatMap(({
    manifest,
    permissionStatus,
    runnable,
  }) => {
    const insert = env.DB.prepare(`
    INSERT INTO auction_sources (
      id, display_name, base_url, enabled, permission_status,
      pickup_location_visibility, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'mixed', ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      base_url = excluded.base_url,
      permission_status = excluded.permission_status,
      updated_at = excluded.updated_at
    WHERE auction_sources.display_name <> excluded.display_name
       OR auction_sources.base_url <> excluded.base_url
       OR auction_sources.permission_status <> excluded.permission_status
  `).bind(
    manifest.id,
    manifest.displayName,
    manifest.baseUrl,
    enabled[manifest.id] && runnable ? 1 : 0,
    permissionStatus,
    utcNow(),
    utcNow(),
    );
    if (runnable) return [insert];
    const disable = env.DB.prepare(`
      UPDATE auction_sources
      SET enabled = 0, updated_at = ?
      WHERE id = ? AND enabled <> 0
    `).bind(utcNow(), manifest.id);
    return [insert, disable];
  });
  if (statements.length > 0) await env.DB.batch(statements);
}
export async function readEnabledSourceIds(): Promise<ReadonlySet<string>> {
  const result = await env.DB.prepare(`
    SELECT id
    FROM auction_sources
    WHERE enabled = 1 AND permission_status = 'allowed'
    ORDER BY id
  `).all<{ id: string }>();
  return new Set((result.results ?? []).map((row) => row.id));
}
export async function beginDiscoveryRun(
  trigger: "manual" | "scheduled",
  originPostalCode: string,
  leaseMs = DEFAULT_DISCOVERY_RUN_LEASE_MS,
): Promise<string> {
  return acquirePipelineRun({
    kind: "discovery",
    leaseMs,
    createRunStatement: (id, startedAt) => env.DB.prepare(`
      INSERT INTO discovery_runs (
        id, trigger, status, origin_postal_code, started_at,
        listings_discovered, listings_new, listings_accepted, listings_excluded
      )
      SELECT ?, ?, 'running', ?, ?, 0, 0, 0, 0
      WHERE EXISTS (
        SELECT 1 FROM pipeline_run_lease
        WHERE singleton = 1 AND run_kind = 'discovery' AND run_id = ?
      )
        AND NOT EXISTS (SELECT 1 FROM discovery_runs WHERE status = 'running')
        AND NOT EXISTS (SELECT 1 FROM enrichment_runs WHERE status = 'running')
    `).bind(id, trigger, originPostalCode, startedAt, id),
  });
}
export async function finishDiscoveryRun(
  id: string,
  status: "completed" | "partial" | "failed",
  counters: RunCounters,
  error?: unknown,
  newListingSnapshot: NewListingSnapshotPolicy = "preserve",
) {
  const message = error instanceof Error ? error.message.slice(0, 2_000) : null;
  const statements = [
    env.DB.prepare(`
      UPDATE discovery_runs SET
        status = ?, completed_at = ?, listings_discovered = ?, listings_new = ?,
        listings_accepted = ?, listings_excluded = ?, error_code = ?, error_message = ?
      WHERE id = ?
    `).bind(
      status,
      utcNow(),
      counters.discovered,
      counters.newListings,
      counters.accepted,
      counters.excluded,
      error instanceof Error ? error.name : null,
      message,
      id,
    ),
  ];
  if (newListingSnapshot === "replace") {
    statements.push(env.DB.prepare(`DELETE FROM dashboard_new_listings`));
  }
  if (newListingSnapshot !== "preserve") {
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO dashboard_new_listings (
        listing_id, first_seen_run_id, added_at
      )
      ${CURRENT_NEW_LISTINGS_FOR_RUN_SELECT_SQL}
    `).bind(id, id));
  }
  statements.push(env.DB.prepare(`
    DELETE FROM source_inventory_observations
    WHERE run_id = ?
  `).bind(id));
  statements.push(releasePipelineRunStatement("discovery", id));
  await env.DB.batch(statements);
}
export async function beginEnrichmentRun(
  input: BeginEnrichmentRunInput,
): Promise<string> {
  const leaseMs = input.leaseMs ?? DEFAULT_DISCOVERY_RUN_LEASE_MS;
  return acquirePipelineRun({
    kind: "enrichment",
    leaseMs,
    createRunStatement: (id, startedAt) => env.DB.prepare(`
      INSERT INTO enrichment_runs (
        id, status, origin_postal_code, started_at,
        requested_limit, effective_limit,
        text_provider_name, text_model_name, extraction_prompt_version,
        semantic_document_version, embedding_provider_name, embedding_model_name
      )
      SELECT ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM pipeline_run_lease
        WHERE singleton = 1 AND run_kind = 'enrichment' AND run_id = ?
      )
        AND NOT EXISTS (SELECT 1 FROM discovery_runs WHERE status = 'running')
        AND NOT EXISTS (SELECT 1 FROM enrichment_runs WHERE status = 'running')
    `).bind(
      id,
      input.originPostalCode,
      startedAt,
      input.requestedLimit,
      input.effectiveLimit,
      input.target.textProviderName,
      input.target.textModelName,
      input.target.extractionPromptVersion,
      input.target.semanticDocumentVersion,
      input.target.embeddingProviderName,
      input.target.embeddingModelName,
      id,
    ),
  });
}
export async function finishEnrichmentRun(
  id: string,
  status: "completed" | "partial" | "failed" | "stopped",
  telemetry: EnrichmentRunTelemetry,
  error?: unknown,
  requiredAbsentClaims: readonly PipelineWorkClaimIdentity[] = [],
): Promise<void> {
  const completedAt = utcNow();
  const stoppedClaimGuard = status === "stopped"
    ? `AND NOT EXISTS (
        SELECT 1 FROM pipeline_work_items
        WHERE stage IN ('enrichment_text', 'enrichment_embedding')
          AND subject_type = 'listing' AND lease_owner = ?
      ) ${requiredAbsentClaims.map(() => `AND NOT EXISTS (
        SELECT 1 FROM pipeline_work_items
        WHERE stage = ? AND subject_type = ? AND subject_id = ?
          AND lease_owner = ? AND claimed_input_hash = ? AND claimed_revision = ?
      )`).join(" ")}`
    : "";
  const stoppedClaimBindings = status === "stopped"
    ? [
        id,
        ...requiredAbsentClaims.flatMap((claim) => [
          claim.stage,
          claim.subjectType,
          claim.subjectId,
          claim.owner,
          claim.inputHash,
          claim.revision,
        ]),
      ]
    : [];
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE enrichment_runs SET
        status = ?, completed_at = ?, pending_at_start = ?, attempted = ?,
        completed_count = ?, failures = ?, remaining = ?, profile_votes_used = ?,
        error_code = ?, error_message = ?
      WHERE id = ? AND status = 'running'
        ${stoppedClaimGuard}
        AND EXISTS (
          SELECT 1 FROM pipeline_run_lease lease
          WHERE lease.singleton = 1 AND lease.run_kind = 'enrichment'
            AND lease.run_id = ?
        )
    `).bind(
      status,
      completedAt,
      telemetry.pendingAtStart,
      telemetry.attempted,
      telemetry.completed,
      telemetry.failures,
      telemetry.remaining,
      telemetry.profileVotesUsed,
      error instanceof Error ? error.name : null,
      error instanceof Error ? error.message.slice(0, 2_000) : null,
      id,
      ...stoppedClaimBindings,
      id,
    ),
    env.DB.prepare(`
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM enrichment_runs
        WHERE id = ? AND status = ? AND completed_at = ?
      ) THEN json('null') ELSE json('enrichment_run_finish_stale') END AS exact_guard
    `).bind(id, status, completedAt),
    releasePipelineRunStatement("enrichment", id),
  ]);
}
export function renewPipelineRunLease(
  kind: RenewablePipelineRunKind,
  id: string,
  leaseMs: number,
): Promise<string> {
  return renewOwnedPipelineRunLease({
    database: env.DB,
    runKind: kind,
    runId: id,
    leaseMs,
  });
}
export async function suspendEnrichmentRunMutationLease(id: string): Promise<void> {
  if (!id.trim()) throw new RangeError("enrichment run id is required");
  const result = await env.DB.prepare(`
    DELETE FROM pipeline_run_lease
    WHERE singleton = 1 AND run_kind = 'enrichment' AND run_id = ?
      AND EXISTS (
        SELECT 1 FROM enrichment_runs
        WHERE id = ? AND status = 'running'
      )
  `).bind(id, id).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new PipelineRunLeaseLostError("enrichment", id);
  }
}
export async function acquireEnrichmentRunMutationLease(
  id: string,
  leaseMs: number,
  now = new Date(),
  options: {
    readonly waitMs?: number;
    readonly retryMs?: number;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  if (!id.trim()) throw new RangeError("enrichment run id is required");
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new RangeError("pipeline run lease must be a positive integer number of milliseconds");
  }
  const initialNowMs = now.getTime();
  if (!Number.isFinite(initialNowMs)) {
    throw new RangeError("pipeline lease acquisition time is invalid");
  }
  const waitMs = options.waitMs ?? 5_000;
  const retryMs = options.retryMs ?? 25;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 ||
      !Number.isSafeInteger(retryMs) || retryMs < 1 || retryMs > 1_000) {
    throw new RangeError("enrichment mutation lease wait policy is invalid");
  }
  const deadline = Date.now() + waitMs;
  let attemptAt = now;
  while (true) {
    throwIfMutationLeaseWaitCancelled(options.signal);
    const acquiredAt = attemptAt.toISOString();
    const expiresAt = new Date(attemptAt.getTime() + leaseMs).toISOString();
    const result = await env.DB.prepare(`
      INSERT INTO pipeline_run_lease (
        singleton, run_kind, run_id, acquired_at, expires_at
      )
      SELECT 1, 'enrichment', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM enrichment_runs
        WHERE id = ? AND status = 'running'
      )
      ON CONFLICT(singleton) DO UPDATE SET
        run_kind = excluded.run_kind,
        run_id = excluded.run_id,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at
      WHERE pipeline_run_lease.expires_at <= ?
    `).bind(id, acquiredAt, expiresAt, id, acquiredAt).run();
    if ((result.meta.changes ?? 0) === 1) return expiresAt;

    const activeRun = await env.DB.prepare(`
      SELECT status FROM enrichment_runs WHERE id = ?
    `).bind(id).first<{ status: string }>();
    if (activeRun?.status !== "running") {
      throw new PipelineRunLeaseLostError("enrichment", id);
    }
    const liveLease = await env.DB.prepare(`
      SELECT run_kind, run_id, expires_at
      FROM pipeline_run_lease
      WHERE singleton = 1 AND expires_at > ?
    `).bind(acquiredAt).first<{
      run_kind: PipelineRunKind;
      run_id: string;
      expires_at: string;
    }>();
    if (Date.now() >= deadline) {
      throw new EnrichmentMutationLeaseBusyError(
        id,
        liveLease?.run_id ?? null,
        liveLease?.run_kind ?? null,
      );
    }
    await waitForMutationLease(Math.min(retryMs, Math.max(1, deadline - Date.now())), options.signal);
    attemptAt = new Date();
  }
}
export class EnrichmentMutationLeaseBusyError extends Error {
  constructor(
    readonly runId: string,
    readonly activeRunId: string | null,
    readonly activeRunKind: PipelineRunKind | null,
  ) {
    super(`Enrichment run ${runId} could not reacquire the serialized mutation lane`);
    this.name = "EnrichmentMutationLeaseBusyError";
  }
}
function throwIfMutationLeaseWaitCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("enrichment_cancelled");
  error.name = "AbortError";
  throw error;
}
async function waitForMutationLease(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      const error = new Error("enrichment_cancelled");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
async function acquirePipelineRun(input: {
  kind: PipelineRunKind;
  leaseMs: number;
  createRunStatement: (id: string, startedAt: string) => D1PreparedStatement;
}): Promise<string> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new RangeError("pipeline run lease must be a positive integer number of milliseconds");
  }

  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const startedAt = utcNow();
    const expiresAt = new Date(Date.parse(startedAt) + input.leaseMs).toISOString();
    const staleBefore = new Date(Date.parse(startedAt) - input.leaseMs).toISOString();
    const enrichmentAbandonedBefore = new Date(
      Date.parse(startedAt) - ENRICHMENT_GENERATION_ABANDONMENT_HORIZON_MS,
    ).toISOString();
    const results = await env.DB.batch([
      staleDiscoveryRunStatement(startedAt, staleBefore),
      staleSourceRunStatement(startedAt),
      discardStaleInventoryObservationsStatement(startedAt),
      staleEnrichmentRunStatement(startedAt, enrichmentAbandonedBefore),
      env.DB.prepare(`
        INSERT INTO pipeline_run_lease (
          singleton, run_kind, run_id, acquired_at, expires_at
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          run_kind = excluded.run_kind,
          run_id = excluded.run_id,
          acquired_at = excluded.acquired_at,
          expires_at = excluded.expires_at
        WHERE pipeline_run_lease.expires_at <= ?
      `).bind(input.kind, id, startedAt, expiresAt, startedAt),
      input.createRunStatement(id, startedAt),
    ]);
    const leaseAcquired = (results[4]?.meta.changes ?? 0) > 0;
    const runCreated = (results[5]?.meta.changes ?? 0) > 0;
    if (leaseAcquired && runCreated) return id;

    if (leaseAcquired) {
      await releasePipelineRunStatement(input.kind, id).run();
    }

    const active = await readActivePipelineRun(startedAt);
    if (active) {
      if (input.kind === "discovery") {
        throw new DiscoveryRunBusyError(active.runId, active.runKind);
      }
      throw new EnrichmentRunBusyError(active.runId, active.runKind);
    }
  }

  throw new Error(`${pipelineRunLabel(input.kind)} run lease acquisition failed without an active run`);
}
function staleDiscoveryRunStatement(now: string, staleBefore: string): D1PreparedStatement {
  return env.DB.prepare(`
    UPDATE discovery_runs SET
      status = 'failed', completed_at = ?, error_code = 'DiscoveryRunLeaseExpired',
      error_message = 'The discovery process ended without releasing its run lease.'
    WHERE status = 'running' AND (
      EXISTS (
        SELECT 1 FROM pipeline_run_lease lease
        WHERE lease.run_kind = 'discovery' AND lease.run_id = discovery_runs.id
          AND lease.expires_at <= ?
      )
      OR (
        NOT EXISTS (
          SELECT 1 FROM pipeline_run_lease lease
          WHERE lease.run_kind = 'discovery' AND lease.run_id = discovery_runs.id
        )
        AND started_at < ?
      )
    )
  `).bind(now, now, staleBefore);
}
function staleEnrichmentRunStatement(
  now: string,
  abandonedBefore: string,
): D1PreparedStatement {
  return env.DB.prepare(`
    UPDATE enrichment_runs SET
      status = 'failed', completed_at = ?, error_code = 'EnrichmentRunLeaseExpired',
      error_message = 'The enrichment process ended without releasing its run lease.'
    WHERE status = 'running' AND (
      EXISTS (
        SELECT 1 FROM pipeline_run_lease lease
        WHERE lease.run_kind = 'enrichment' AND lease.run_id = enrichment_runs.id
          AND lease.expires_at <= ?
      )
      OR (
        NOT EXISTS (
          SELECT 1 FROM pipeline_run_lease lease
          WHERE lease.run_kind = 'enrichment' AND lease.run_id = enrichment_runs.id
        )
        AND started_at < ?
      )
    )
  `).bind(now, now, abandonedBefore);
}
function staleSourceRunStatement(now: string): D1PreparedStatement {
  return env.DB.prepare(`
    UPDATE source_runs SET
      status = 'failed', completed_at = ?, error_code = 'DiscoveryRunLeaseExpired',
      error_message = 'The discovery process ended before this source run completed.'
    WHERE status = 'running' AND discovery_run_id IN (
      SELECT id FROM discovery_runs
      WHERE status = 'failed'
        AND error_code = 'DiscoveryRunLeaseExpired'
        AND completed_at = ?
    )
  `).bind(now, now);
}
function discardStaleInventoryObservationsStatement(now: string): D1PreparedStatement {
  return env.DB.prepare(`
    DELETE FROM source_inventory_observations
    WHERE run_id IN (
      SELECT id FROM discovery_runs
      WHERE status = 'failed'
        AND error_code = 'DiscoveryRunLeaseExpired'
        AND completed_at = ?
    )
  `).bind(now);
}
function releasePipelineRunStatement(
  kind: PipelineRunKind,
  id: string,
): D1PreparedStatement {
  return env.DB.prepare(`
    DELETE FROM pipeline_run_lease
    WHERE singleton = 1 AND run_kind = ? AND run_id = ?
  `).bind(kind, id);
}
async function readActivePipelineRun(now: string): Promise<{
  runId: string;
  runKind: PipelineRunKind;
} | null> {
  const lease = await env.DB.prepare(`
    SELECT run_id, run_kind
    FROM pipeline_run_lease
    WHERE singleton = 1 AND expires_at > ?
    LIMIT 1
  `).bind(now).first<{ run_id: string; run_kind: PipelineRunKind }>();
  if (lease) return { runId: lease.run_id, runKind: lease.run_kind };

  const row = await env.DB.prepare(`
    SELECT id AS run_id, 'discovery' AS run_kind, started_at
    FROM discovery_runs WHERE status = 'running'
    UNION ALL
    SELECT id AS run_id, 'enrichment' AS run_kind, started_at
    FROM enrichment_runs WHERE status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `).first<{ run_id: string; run_kind: PipelineRunKind }>();
  return row ? { runId: row.run_id, runKind: row.run_kind } : null;
}
function pipelineRunLabel(kind: PipelineRunKind): string {
  return kind === "discovery" ? "Discovery" : "Enrichment";
}
export async function beginSourceRun(
  discoveryRunId: string,
  sourceId: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO source_runs (
      id, discovery_run_id, source_id, status, started_at,
      stubs_discovered, skipped_already_seen, details_fetched,
      listings_accepted, listings_excluded
    ) VALUES (?, ?, ?, 'running', ?, 0, 0, 0, 0, 0)
  `).bind(id, discoveryRunId, sourceId, utcNow()).run();
  return id;
}
export async function finishSourceRun(
  id: string,
  status: "completed" | "partial" | "failed",
  counters: SourceRunCounters,
  error?: unknown,
) {
  await env.DB.prepare(`
    UPDATE source_runs SET
      status = ?, completed_at = ?, stubs_discovered = ?, skipped_already_seen = ?,
      details_fetched = ?, listings_accepted = ?, listings_excluded = ?,
      error_code = ?, error_message = ?
    WHERE id = ?
  `).bind(
    status,
    utcNow(),
    counters.stubsDiscovered,
    counters.skippedAlreadySeen,
    counters.detailsFetched,
    counters.accepted,
    counters.excluded,
    error instanceof Error ? error.name : null,
    error instanceof Error ? error.message.slice(0, 2_000) : null,
    id,
  ).run();
}
interface SourceInventoryAcquisitionAttemptRow {
  readonly attempt_id: string;
  readonly source_id: string;
  readonly traversal_id: string | null;
  readonly reserved_request_units: number;
  readonly max_request_units: number;
  readonly active_plan_fingerprint: string | null;
  readonly started_at: string;
  readonly updated_at: string;
}
function decodedSourceInventoryAcquisitionAttempt(
  row: SourceInventoryAcquisitionAttemptRow,
): SourceInventoryAcquisitionAttempt {
  return {
    attemptId: row.attempt_id,
    sourceId: row.source_id,
    traversalId: row.traversal_id,
    reservedRequestUnits: Number(row.reserved_request_units),
    maxRequestUnits: Number(row.max_request_units),
    activePlanFingerprint: row.active_plan_fingerprint,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}
function validatedSourceInventoryRequestUnits(
  value: number,
  label: string,
  allowZero = false,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new RangeError(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`,
    );
  }
  return value;
}
function validatedSourceInventoryPlanFingerprint(value: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{64}$/.test(value)
  ) {
    throw new TypeError(
      "source inventory acquisition plan fingerprint must be a lowercase SHA-256",
    );
  }
  return value;
}
export async function readSourceInventoryAcquisitionAttemptForSource(
  sourceIdInput: string,
): Promise<SourceInventoryAcquisitionAttempt | null> {
  const sourceId = validatedTraversalKey(
    sourceIdInput,
    "source inventory acquisition sourceId",
  );
  const row = await env.DB.prepare(`
    SELECT
      attempt_id, source_id, traversal_id, reserved_request_units,
      max_request_units, active_plan_fingerprint, started_at, updated_at
    FROM source_inventory_acquisition_attempts
    WHERE source_id = ?
    LIMIT 1
  `).bind(sourceId).first<SourceInventoryAcquisitionAttemptRow>();
  return row ? decodedSourceInventoryAcquisitionAttempt(row) : null;
}
export async function readSourceInventoryAcquisitionAttempt(
  attemptIdInput: string,
): Promise<SourceInventoryAcquisitionAttempt | null> {
  const attemptId = validatedTraversalKey(
    attemptIdInput,
    "source inventory acquisition attemptId",
  );
  const row = await env.DB.prepare(`
    SELECT
      attempt_id, source_id, traversal_id, reserved_request_units,
      max_request_units, active_plan_fingerprint, started_at, updated_at
    FROM source_inventory_acquisition_attempts
    WHERE attempt_id = ?
    LIMIT 1
  `).bind(attemptId).first<SourceInventoryAcquisitionAttemptRow>();
  return row ? decodedSourceInventoryAcquisitionAttempt(row) : null;
}
export async function beginSourceInventoryAcquisitionAttempt(input: {
  readonly sourceId: string;
  readonly maxRequestUnits: number;
  readonly rootRequestUnits: number;
}): Promise<SourceInventoryAcquisitionAttempt> {
  const sourceId = validatedTraversalKey(
    input.sourceId,
    "source inventory acquisition sourceId",
  );
  const maxRequestUnits = validatedSourceInventoryRequestUnits(
    input.maxRequestUnits,
    "source inventory acquisition maximum request units",
  );
  const rootRequestUnits = validatedSourceInventoryRequestUnits(
    input.rootRequestUnits,
    "source inventory acquisition root request units",
  );
  if (rootRequestUnits > maxRequestUnits) {
    throw new RangeError(
      "source inventory acquisition root request units exceed the maximum",
    );
  }
  const existing =
    await readSourceInventoryAcquisitionAttemptForSource(sourceId);
  if (existing && existing.maxRequestUnits !== maxRequestUnits) {
    await abandonSourceInventoryAcquisitionAttemptForSource(sourceId);
    throw new SourceInventoryAcquisitionAttemptError(
      "source_inventory_acquisition_drift",
      `${sourceId} staged inventory request ceiling changed; acquisition abandoned.`,
    );
  }

  const now = utcNow();
  const row = await env.DB.prepare(`
    INSERT INTO source_inventory_acquisition_attempts (
      attempt_id, source_id, traversal_id, reserved_request_units,
      max_request_units, active_plan_fingerprint, started_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      reserved_request_units =
        source_inventory_acquisition_attempts.reserved_request_units +
        excluded.reserved_request_units,
      active_plan_fingerprint = NULL,
      updated_at = excluded.updated_at
    WHERE
      source_inventory_acquisition_attempts.max_request_units =
        excluded.max_request_units
      AND source_inventory_acquisition_attempts.reserved_request_units +
        excluded.reserved_request_units <=
          source_inventory_acquisition_attempts.max_request_units
    RETURNING
      attempt_id, source_id, traversal_id, reserved_request_units,
      max_request_units, active_plan_fingerprint, started_at, updated_at
  `).bind(
    existing?.attemptId ?? crypto.randomUUID(),
    sourceId,
    rootRequestUnits,
    maxRequestUnits,
    now,
    now,
  ).first<SourceInventoryAcquisitionAttemptRow>();
  if (!row) {
    await abandonSourceInventoryAcquisitionAttemptForSource(sourceId);
    throw new SourceInventoryAcquisitionAttemptError(
      "source_inventory_acquisition_budget_exhausted",
      `${sourceId} staged inventory exhausted its request ceiling; acquisition abandoned.`,
    );
  }
  return decodedSourceInventoryAcquisitionAttempt(row);
}
export async function bindSourceInventoryAcquisitionAttempt(input: {
  readonly attemptId: string;
  readonly sourceId: string;
  readonly traversalId: string;
}): Promise<SourceInventoryAcquisitionAttempt> {
  const attemptId = validatedTraversalKey(
    input.attemptId,
    "source inventory acquisition attemptId",
  );
  const sourceId = validatedTraversalKey(
    input.sourceId,
    "source inventory acquisition sourceId",
  );
  const traversalId = validatedTraversalKey(
    input.traversalId,
    "source inventory acquisition traversalId",
  );
  const row = await env.DB.prepare(`
    UPDATE source_inventory_acquisition_attempts
    SET traversal_id = ?, updated_at = ?
    WHERE attempt_id = ? AND source_id = ?
      AND (traversal_id IS NULL OR traversal_id = ?)
      AND EXISTS (
        SELECT 1
        FROM source_inventory_traversals traversal
        WHERE traversal.traversal_id = ?
          AND traversal.source_id = ?
      )
    RETURNING
      attempt_id, source_id, traversal_id, reserved_request_units,
      max_request_units, active_plan_fingerprint, started_at, updated_at
  `).bind(
    traversalId,
    utcNow(),
    attemptId,
    sourceId,
    traversalId,
    traversalId,
    sourceId,
  ).first<SourceInventoryAcquisitionAttemptRow>();
  if (!row) {
    await abandonSourceInventoryAcquisitionAttemptForSource(sourceId);
    throw new SourceInventoryAcquisitionAttemptError(
      "source_inventory_acquisition_drift",
      `${sourceId} staged inventory attempt no longer matches its traversal; acquisition abandoned.`,
    );
  }
  return decodedSourceInventoryAcquisitionAttempt(row);
}
export async function reserveSourceInventoryAcquisitionPlan(input: {
  readonly attemptId: string;
  readonly sourceId: string;
  readonly traversalId: string;
  readonly planFingerprint: string;
  readonly requestUnits: number;
}): Promise<SourceInventoryAcquisitionAttempt> {
  const attemptId = validatedTraversalKey(
    input.attemptId,
    "source inventory acquisition attemptId",
  );
  const sourceId = validatedTraversalKey(
    input.sourceId,
    "source inventory acquisition sourceId",
  );
  const traversalId = validatedTraversalKey(
    input.traversalId,
    "source inventory acquisition traversalId",
  );
  const planFingerprint = validatedSourceInventoryPlanFingerprint(
    input.planFingerprint,
  );
  const requestUnits = validatedSourceInventoryRequestUnits(
    input.requestUnits,
    "source inventory acquisition plan request units",
    true,
  );
  const row = await env.DB.prepare(`
    UPDATE source_inventory_acquisition_attempts
    SET
      reserved_request_units = reserved_request_units +
        CASE WHEN active_plan_fingerprint = ? THEN 0 ELSE ? END,
      active_plan_fingerprint = ?,
      updated_at = ?
    WHERE attempt_id = ? AND source_id = ? AND traversal_id = ?
      AND (
        active_plan_fingerprint = ?
        OR reserved_request_units + ? <= max_request_units
      )
    RETURNING
      attempt_id, source_id, traversal_id, reserved_request_units,
      max_request_units, active_plan_fingerprint, started_at, updated_at
  `).bind(
    planFingerprint,
    requestUnits,
    planFingerprint,
    utcNow(),
    attemptId,
    sourceId,
    traversalId,
    planFingerprint,
    requestUnits,
  ).first<SourceInventoryAcquisitionAttemptRow>();
  if (!row) {
    const existing =
      await readSourceInventoryAcquisitionAttemptForSource(sourceId);
    await abandonSourceInventoryAcquisitionAttemptForSource(sourceId);
    const boundAttempt =
      existing?.attemptId === attemptId &&
      existing.traversalId === traversalId;
    throw new SourceInventoryAcquisitionAttemptError(
      boundAttempt
        ? "source_inventory_acquisition_budget_exhausted"
        : "source_inventory_acquisition_attempt_stale",
      boundAttempt
        ? `${sourceId} staged inventory exhausted its request ceiling; acquisition abandoned.`
        : `${sourceId} staged inventory attempt is stale; acquisition abandoned.`,
    );
  }
  return decodedSourceInventoryAcquisitionAttempt(row);
}
export async function supersedeSourceInventoryAcquisitionPlan(input: {
  readonly attemptId: string;
  readonly sourceId: string;
  readonly traversalId: string;
  readonly planFingerprint: string;
}): Promise<SourceInventoryAcquisitionAttempt> {
  const attemptId = validatedTraversalKey(
    input.attemptId,
    "source inventory acquisition attemptId",
  );
  const sourceId = validatedTraversalKey(
    input.sourceId,
    "source inventory acquisition sourceId",
  );
  const traversalId = validatedTraversalKey(
    input.traversalId,
    "source inventory acquisition traversalId",
  );
  const planFingerprint = validatedSourceInventoryPlanFingerprint(
    input.planFingerprint,
  );
  const row = await env.DB.prepare(`
    UPDATE source_inventory_acquisition_attempts
    SET active_plan_fingerprint = NULL, updated_at = ?
    WHERE attempt_id = ? AND source_id = ? AND traversal_id = ?
      AND active_plan_fingerprint = ?
    RETURNING
      attempt_id, source_id, traversal_id, reserved_request_units,
      max_request_units, active_plan_fingerprint, started_at, updated_at
  `).bind(
    utcNow(),
    attemptId,
    sourceId,
    traversalId,
    planFingerprint,
  ).first<SourceInventoryAcquisitionAttemptRow>();
  if (!row) {
    throw new SourceInventoryAcquisitionAttemptError(
      "source_inventory_acquisition_drift",
      `${sourceId} staged inventory replay is no longer active.`,
    );
  }
  return decodedSourceInventoryAcquisitionAttempt(row);
}
export async function assertSourceInventoryAcquisitionPlanReservation(input: {
  readonly attemptId: string;
  readonly sourceId: string;
  readonly traversalId: string;
  readonly planFingerprint: string;
}): Promise<SourceInventoryAcquisitionAttempt> {
  const attemptId = validatedTraversalKey(
    input.attemptId,
    "source inventory acquisition attemptId",
  );
  const sourceId = validatedTraversalKey(
    input.sourceId,
    "source inventory acquisition sourceId",
  );
  const traversalId = validatedTraversalKey(
    input.traversalId,
    "source inventory acquisition traversalId",
  );
  const planFingerprint = validatedSourceInventoryPlanFingerprint(
    input.planFingerprint,
  );
  const attempt =
    await readSourceInventoryAcquisitionAttemptForSource(sourceId);
  if (
    !attempt ||
    attempt.attemptId !== attemptId ||
    attempt.traversalId !== traversalId ||
    attempt.activePlanFingerprint !== planFingerprint
  ) {
    await abandonSourceInventoryAcquisitionAttemptForSource(sourceId);
    throw new SourceInventoryAcquisitionAttemptError(
      "source_inventory_acquisition_attempt_stale",
      `${sourceId} staged inventory plan reservation is stale; acquisition abandoned.`,
    );
  }
  return attempt;
}
export async function abandonSourceInventoryAcquisitionAttemptForSource(
  sourceIdInput: string,
): Promise<void> {
  const sourceId = validatedTraversalKey(
    sourceIdInput,
    "source inventory acquisition sourceId",
  );
  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM source_inventory_traversals WHERE source_id = ?
    `).bind(sourceId),
    env.DB.prepare(`
      DELETE FROM source_inventory_acquisition_attempts WHERE source_id = ?
    `).bind(sourceId),
  ]);
}
export async function prepareSourceInventoryTraversal(input: {
  sourceId: string;
  fingerprint: string;
  inventoryCardinality?: SourceInventoryCardinality;
  listingFactCompatibility?: SourceListingFactCompatibility;
  expectedListings: number;
  pages: readonly SourceInventoryTraversalPagePlan[];
}): Promise<PreparedSourceInventoryTraversal> {
  const sourceId = validatedTraversalKey(input.sourceId, "traversal sourceId");
  const fingerprint = validatedTraversalKey(
    input.fingerprint,
    "traversal fingerprint",
  );
  const inventoryCardinality = validatedInventoryCardinality(
    input.inventoryCardinality,
  );
  const listingFactCompatibility = validatedListingFactCompatibility(
    input.listingFactCompatibility,
  );
  const persistedFingerprint = storedTraversalFingerprint(
    fingerprint,
    inventoryCardinality,
    listingFactCompatibility,
  );
  const expectedListings = validatedTraversalCount(
    input.expectedListings,
    "traversal expectedListings",
  );
  if (!Array.isArray(input.pages) || input.pages.length === 0) {
    throw new RangeError("source inventory traversal must plan at least one page");
  }
  if (input.pages.length > MAX_TRAVERSAL_PAGE_COUNT) {
    throw new RangeError(
      `source inventory traversal cannot exceed ${MAX_TRAVERSAL_PAGE_COUNT} pages`,
    );
  }

  const pageKeys = new Set<string>();
  const pages = input.pages.map((page, index) => {
    const key = validatedTraversalKey(page.key, `traversal page ${index + 1} key`);
    if (pageKeys.has(key)) {
      throw new TypeError(`source inventory traversal page key ${key} is duplicated`);
    }
    if (
      typeof page.inventoryMember !== "boolean" ||
      typeof page.reviewCandidate !== "boolean"
    ) {
      throw new TypeError("source inventory traversal page roles must be booleans");
    }
    // A page with neither role is an audit/recount gate. Its response may
    // contain visible evidence, but checkpointing below prevents it from
    // contributing any listing to the traversal union.
    pageKeys.add(key);
    return {
      key,
      inventoryMember: page.inventoryMember,
      reviewCandidate: page.reviewCandidate,
    };
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  if (
    !pages.some((page) => page.inventoryMember) &&
    !(inventoryCardinality === "exact" && expectedListings === 0)
  ) {
    throw new TypeError("source inventory traversal must include an inventory page");
  }
  const existing = await env.DB.prepare(`
    SELECT
      traversal.traversal_id,
      traversal.fingerprint,
      traversal.expected_listings
    FROM source_inventory_traversals traversal
    WHERE traversal.source_id = ?
    LIMIT 1
  `).bind(sourceId).first<{
    traversal_id: string;
    fingerprint: string;
    expected_listings: number;
  }>();
  if (existing) {
    const storedPages = await env.DB.prepare(`
      SELECT
        page_key, completed_at, observed_count,
        inventory_member, review_candidate
      FROM source_inventory_traversal_pages
      WHERE traversal_id = ?
      ORDER BY page_key
    `).bind(existing.traversal_id).all<{
      page_key: string;
      completed_at: string | null;
      inventory_member: number;
      review_candidate: number;
      observed_count: number;
    }>();
    const rows = storedPages.results ?? [];
    const samePlan = existing.fingerprint === persistedFingerprint &&
      Number(existing.expected_listings) === expectedListings &&
      rows.length === pages.length &&
      rows.every((row, index) =>
        row.page_key === pages[index]!.key &&
        row.inventory_member === Number(pages[index]!.inventoryMember) &&
        row.review_candidate === Number(pages[index]!.reviewCandidate)
      );
    if (samePlan) {
      return {
        traversalId: existing.traversal_id,
        inventoryCardinality,
        listingFactCompatibility,
        completedPageKeys: rows.filter(row => row.completed_at !== null)
          .map(row => row.page_key),
        pendingPageKeys: rows.filter(row => row.completed_at === null)
          .map(row => row.page_key),
      };
    }
  }

  const traversalId = crypto.randomUUID();
  const startedAt = utcNow();
  const seedStatements = chunkValues(pages, TRAVERSAL_PAGE_INSERT_SIZE).map(
    (chunk) => env.DB.prepare(`
      INSERT INTO source_inventory_traversal_pages (
        traversal_id, page_key, completed_at, observed_count,
        inventory_member, review_candidate
      ) VALUES ${chunk.map(() => "(?, ?, NULL, 0, ?, ?)").join(", ")}
    `).bind(...chunk.flatMap((page) => [
      traversalId,
      page.key,
      Number(page.inventoryMember),
      Number(page.reviewCandidate),
    ])),
  );
  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM source_inventory_traversals WHERE source_id = ?
    `).bind(sourceId),
    env.DB.prepare(`
      INSERT INTO source_inventory_traversals (
        traversal_id, source_id, fingerprint, expected_pages,
        expected_listings, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      traversalId,
      sourceId,
      persistedFingerprint,
      pages.length,
      expectedListings,
      startedAt,
      startedAt,
    ),
    ...seedStatements,
  ]);
  return {
    traversalId,
    inventoryCardinality,
    listingFactCompatibility,
    completedPageKeys: [],
    pendingPageKeys: pages.map((page) => page.key),
  };
}
export async function readSourceInventoryTraversalState(
  traversalIdInput: string,
): Promise<SourceInventoryTraversalState | null> {
  const traversalId = validatedTraversalKey(
    traversalIdInput,
    "inventory traversalId",
  );
  const row = await env.DB.prepare(`
    SELECT
      traversal.traversal_id,
      traversal.source_id,
      traversal.fingerprint,
      traversal.expected_pages,
      traversal.expected_listings,
      traversal.updated_at,
      (
        SELECT count(*)
        FROM source_inventory_traversal_pages page
        WHERE page.traversal_id = traversal.traversal_id
          AND page.completed_at IS NOT NULL
      ) AS completed_pages,
      (
        SELECT count(*)
        FROM source_inventory_traversal_pages page
        WHERE page.traversal_id = traversal.traversal_id
      ) AS planned_pages,
      (
        SELECT count(*)
        FROM source_inventory_traversal_listings listing
        WHERE listing.traversal_id = traversal.traversal_id
      ) AS observed_listings,
      (
        SELECT count(*)
        FROM source_inventory_traversal_listings listing
        WHERE listing.traversal_id = traversal.traversal_id
          AND listing.inventory_member = 1
      ) AS inventory_listings,
      (
        SELECT count(*)
        FROM source_inventory_traversal_listings listing
        WHERE listing.traversal_id = traversal.traversal_id
          AND listing.inventory_member = 1
          AND listing.review_candidate = 1
      ) AS candidate_listings
    FROM source_inventory_traversals traversal
    WHERE traversal.traversal_id = ?
    LIMIT 1
  `).bind(traversalId).first<{
    traversal_id: string;
    source_id: string;
    fingerprint: string;
    expected_listings: number;
    completed_pages: number;
    expected_pages: number;
    updated_at: string;
    planned_pages: number;
    observed_listings: number;
    inventory_listings: number;
    candidate_listings: number;
  }>();
  if (!row) return null;
  const completedPages = Number(row.completed_pages);
  const expectedPages = Number(row.expected_pages);
  const plannedPages = Number(row.planned_pages);
  const completed = plannedPages === expectedPages && completedPages === expectedPages;
  const decodedFingerprint = decodedTraversalFingerprint(row.fingerprint);
  return {
    traversalId: row.traversal_id,
    sourceId: row.source_id,
    fingerprint: decodedFingerprint.fingerprint,
    inventoryCardinality: decodedFingerprint.inventoryCardinality,
    listingFactCompatibility: decodedFingerprint.listingFactCompatibility,
    expectedPages,
    expectedListings: Number(row.expected_listings),
    completedPages,
    incompletePages: completed ? 0 : Math.max(1, expectedPages - completedPages),
    observedListings: Number(row.observed_listings),
    inventoryListings: Number(row.inventory_listings),
    candidateListings: Number(row.candidate_listings),
    completed,
    updatedAt: normalizedTraversalObservedAt(row.updated_at),
  };
}
export async function readRetainedSourceInventoryTraversalStates(): Promise<
  readonly SourceInventoryTraversalState[]
> {
  const rows = await env.DB.prepare(`
    SELECT
      traversal.traversal_id,
      traversal.source_id,
      traversal.fingerprint,
      traversal.expected_pages,
      traversal.expected_listings,
      traversal.updated_at,
      (
        SELECT count(*)
        FROM source_inventory_traversal_pages page
        WHERE page.traversal_id = traversal.traversal_id
          AND page.completed_at IS NOT NULL
      ) AS completed_pages,
      (
        SELECT count(*)
        FROM source_inventory_traversal_pages page
        WHERE page.traversal_id = traversal.traversal_id
      ) AS planned_pages,
      (
        SELECT count(*)
        FROM source_inventory_traversal_listings listing
        WHERE listing.traversal_id = traversal.traversal_id
      ) AS observed_listings,
      (
        SELECT count(*)
        FROM source_inventory_traversal_listings listing
        WHERE listing.traversal_id = traversal.traversal_id
          AND listing.inventory_member = 1
      ) AS inventory_listings,
      (
        SELECT count(*)
        FROM source_inventory_traversal_listings listing
        WHERE listing.traversal_id = traversal.traversal_id
          AND listing.inventory_member = 1
          AND listing.review_candidate = 1
      ) AS candidate_listings
    FROM source_inventory_traversals traversal
    ORDER BY traversal.source_id
  `).all<{
    traversal_id: string;
    source_id: string;
    fingerprint: string;
    expected_listings: number;
    completed_pages: number;
    expected_pages: number;
    updated_at: string;
    planned_pages: number;
    observed_listings: number;
    inventory_listings: number;
    candidate_listings: number;
  }>();
  return Object.freeze((rows.results ?? []).map((row) => {
    const completedPages = Number(row.completed_pages);
    const expectedPages = Number(row.expected_pages);
    const plannedPages = Number(row.planned_pages);
    const completed = plannedPages === expectedPages && completedPages === expectedPages;
    const decodedFingerprint = decodedTraversalFingerprint(row.fingerprint);
    return Object.freeze({
      traversalId: row.traversal_id,
      sourceId: row.source_id,
      fingerprint: decodedFingerprint.fingerprint,
      inventoryCardinality: decodedFingerprint.inventoryCardinality,
      listingFactCompatibility: decodedFingerprint.listingFactCompatibility,
      expectedPages,
      expectedListings: Number(row.expected_listings),
      completedPages,
      incompletePages: completed ? 0 : Math.max(1, expectedPages - completedPages),
      observedListings: Number(row.observed_listings),
      inventoryListings: Number(row.inventory_listings),
      candidateListings: Number(row.candidate_listings),
      completed,
      updatedAt: normalizedTraversalObservedAt(row.updated_at),
    });
  }));
}
export async function readPendingSourceInventoryTraversalPageKeys(
  traversalIdInput: string,
): Promise<string[]> {
  const traversalId = validatedTraversalKey(
    traversalIdInput,
    "inventory traversalId",
  );
  const rows = await env.DB.prepare(`
    SELECT page_key
    FROM source_inventory_traversal_pages
    WHERE traversal_id = ? AND completed_at IS NULL
    ORDER BY page_key
  `).bind(traversalId).all<{ page_key: string }>();
  return (rows.results ?? []).map((row) => row.page_key);
}
export interface SourceInventoryTraversalPageState {
  readonly key: string;
  readonly inventoryMember: boolean;
  readonly reviewCandidate: boolean;
  readonly completed: boolean;
  readonly observedCount: number;
}
export async function readSourceInventoryTraversalPages(
  traversalIdInput: string,
): Promise<SourceInventoryTraversalPageState[]> {
  const traversalId = validatedTraversalKey(
    traversalIdInput,
    "inventory traversalId",
  );
  const rows = await env.DB.prepare(`
    SELECT
      page_key, inventory_member, review_candidate, completed_at, observed_count
    FROM source_inventory_traversal_pages
    WHERE traversal_id = ?
    ORDER BY page_key
  `).bind(traversalId).all<{
    page_key: string;
    inventory_member: number;
    review_candidate: number;
    completed_at: string | null;
    observed_count: number;
  }>();
  return (rows.results ?? []).map((row) => ({
    key: row.page_key,
    inventoryMember: row.inventory_member === 1,
    reviewCandidate: row.review_candidate === 1,
    completed: row.completed_at !== null,
    observedCount: Number(row.observed_count),
  }));
}
export async function readSourceInventoryTraversalCompletionAt(
  traversalIdInput: string,
): Promise<string | null> {
  const traversalId = validatedTraversalKey(
    traversalIdInput,
    "inventory traversalId",
  );
  const row = await env.DB.prepare(`
    SELECT
      count(*) AS planned_pages,
      coalesce(sum(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END), 0)
        AS completed_pages,
      max(completed_at) AS completed_at
    FROM source_inventory_traversal_pages
    WHERE traversal_id = ?
  `).bind(traversalId).first<{
    planned_pages: number;
    completed_pages: number;
    expected_pages: number;
    updated_at: string;
    completed_at: string | null;
  }>();
  if (
    !row ||
    Number(row.planned_pages) < 1 ||
    Number(row.completed_pages) !== Number(row.planned_pages) ||
    row.completed_at === null
  ) {
    return null;
  }
  return normalizedTraversalObservedAt(row.completed_at);
}
export async function checkpointSourceInventoryTraversalPage(input: {
  traversalId: string;
  pageKey: string;
  sourceId: string;
  listingIds: readonly string[];
  /** Incoming normalized fact hashes keyed to this page's persisted listings. */
  listingFactHashes?: readonly {
    readonly listingId: string;
    readonly factHash: string;
  }[];
  /**
   * Observed-union identities that this page proves ended. Partitioned
   * traversals retain a tombstone; unpartitioned traversals remove membership.
   */
  endedListingIds?: readonly string[];
  /** Persisted observations that must remain catalog-only on this page. */
  catalogOnlyListingIds?: readonly string[];
  observedAt: string;
}): Promise<SourceInventoryTraversalState> {
  const traversalId = validatedTraversalKey(input.traversalId, "inventory traversalId");
  const pageKey = validatedTraversalKey(input.pageKey, "inventory traversal pageKey");
  const sourceId = validatedTraversalKey(input.sourceId, "inventory traversal sourceId");
  const observedAt = normalizedTraversalObservedAt(input.observedAt);
  if (!Array.isArray(input.listingIds)) {
    throw new TypeError("inventory traversal listingIds must be an array");
  }
  const listingIds = [...new Set(input.listingIds.map((listingId, index) =>
    validatedTraversalKey(listingId, `inventory traversal listing ${index + 1}`)
  ))];
  if (
    input.endedListingIds !== undefined &&
    !Array.isArray(input.endedListingIds)
  ) {
    throw new TypeError("inventory traversal endedListingIds must be an array");
  }
  const endedListingIds = [...new Set(
    (input.endedListingIds ?? []).map((listingId, index) =>
      validatedTraversalKey(
        listingId,
        `inventory traversal ended listing ${index + 1}`,
      )
    ),
  )];
  const listingIdSet = new Set(listingIds);
  for (const listingId of endedListingIds) {
    if (listingIdSet.has(listingId)) {
      throw new TypeError(
        `inventory traversal listing ${listingId} cannot be both current and ended`,
      );
    }
  }
  const observedListingIds = [...listingIds, ...endedListingIds];
  if (
    input.listingFactHashes !== undefined &&
    !Array.isArray(input.listingFactHashes)
  ) {
    throw new TypeError("inventory traversal listingFactHashes must be an array");
  }
  const listingFactHashes = new Map<string, string>();
  for (const [index, entry] of (input.listingFactHashes ?? []).entries()) {
    if (!entry || typeof entry !== "object") {
      throw new TypeError(
        `inventory traversal listing fact ${index + 1} must be an object`,
      );
    }
    const listingId = validatedTraversalKey(
      entry.listingId,
      `inventory traversal listing fact ${index + 1} listingId`,
    );
    const factHash = validatedTraversalFactHash(
      entry.factHash,
      `inventory traversal listing fact ${index + 1} factHash`,
    );
    const existing = listingFactHashes.get(listingId);
    if (existing !== undefined && existing !== factHash) {
      throw new TypeError(
        `inventory traversal listing ${listingId} has conflicting page fact hashes`,
      );
    }
    listingFactHashes.set(listingId, factHash);
  }
  if (
    input.catalogOnlyListingIds !== undefined &&
    !Array.isArray(input.catalogOnlyListingIds)
  ) {
    throw new TypeError("inventory traversal catalogOnlyListingIds must be an array");
  }
  const catalogOnlyListingIds = new Set(
    (input.catalogOnlyListingIds ?? []).map((listingId, index) =>
      validatedTraversalKey(
        listingId,
        `inventory traversal catalog-only listing ${index + 1}`,
      )
    ),
  );
  for (const listingId of catalogOnlyListingIds) {
    if (!listingIds.includes(listingId)) {
      throw new TypeError(
        `inventory traversal catalog-only listing ${listingId} is not on page ${pageKey}`,
      );
    }
  }
  if (observedListingIds.length > MAX_TRAVERSAL_LISTINGS_PER_PAGE) {
    throw new RangeError(
      `an inventory traversal page cannot exceed ${MAX_TRAVERSAL_LISTINGS_PER_PAGE} unique listings`,
    );
  }

  const page = await env.DB.prepare(`
    SELECT
      page.completed_at,
      page.inventory_member,
      page.review_candidate,
      traversal.fingerprint
    FROM source_inventory_traversal_pages page
    JOIN source_inventory_traversals traversal
      ON traversal.traversal_id = page.traversal_id
    WHERE page.traversal_id = ? AND page.page_key = ?
      AND traversal.source_id = ?
    LIMIT 1
  `).bind(traversalId, pageKey, sourceId).first<{
    completed_at: string | null;
    inventory_member: number;
    review_candidate: number;
    fingerprint: string;
  }>();
  if (!page) {
    throw new Error(
      `source inventory traversal ${traversalId} has no ${sourceId} page ${pageKey}`,
    );
  }
  if (
    page.inventory_member === 0 &&
    page.review_candidate === 0 &&
    observedListingIds.length !== 0
  ) {
    await env.DB.prepare(`
      DELETE FROM source_inventory_traversals
      WHERE traversal_id = ? AND source_id = ?
    `).bind(traversalId, sourceId).run();
    throw new Error(
      `source inventory traversal audit page ${sanitizedTraversalPageKeyForError(pageKey)} returned listings; traversal reset`,
    );
  }
  const decodedFingerprint = decodedTraversalFingerprint(page.fingerprint);
  const inventoryCardinality = decodedFingerprint.inventoryCardinality;
  const listingFactCompatibility =
    decodedFingerprint.listingFactCompatibility;
  const observedListingIdSet = new Set(observedListingIds);
  if (listingFactCompatibility === "exact") {
    if (
      listingFactHashes.size !== observedListingIds.length ||
      observedListingIds.some((listingId) =>
        !listingFactHashes.has(listingId)
      )
    ) {
      throw new TypeError(
        `source inventory traversal page ${sanitizedTraversalPageKeyForError(pageKey)} requires one exact fact hash per observed listing`,
      );
    }
  } else if (listingFactHashes.size > 0) {
    throw new TypeError(
      `source inventory traversal page ${sanitizedTraversalPageKeyForError(pageKey)} does not enable listing fact compatibility`,
    );
  }
  for (const listingId of listingFactHashes.keys()) {
    if (!observedListingIdSet.has(listingId)) {
      throw new TypeError(
        `inventory traversal listing fact ${listingId} is not on page ${pageKey}`,
      );
    }
  }
  if (
    endedListingIds.length > 0 &&
    (
      inventoryCardinality !== "observed_union" ||
      page.inventory_member !== 1
    )
  ) {
    await env.DB.prepare(`
      DELETE FROM source_inventory_traversals
      WHERE traversal_id = ? AND source_id = ?
    `).bind(traversalId, sourceId).run();
    throw new Error(
      `source inventory traversal page ${sanitizedTraversalPageKeyForError(pageKey)} cannot persist ended observed-union evidence; traversal reset`,
    );
  }

  const persistedIds = new Set<string>();
  for (
    const chunk of chunkValues(
      observedListingIds,
      TRAVERSAL_LISTING_WRITE_SIZE,
    )
  ) {
    const result = await env.DB.prepare(`
      SELECT id
      FROM listing_stubs
      WHERE source_id = ? AND id IN (${chunk.map(() => "?").join(", ")})
    `).bind(sourceId, ...chunk).all<{ id: string }>();
    for (const row of result.results ?? []) persistedIds.add(row.id);
  }
  if (persistedIds.size !== observedListingIds.length) {
    const missing = observedListingIds.find(
      (listingId) => !persistedIds.has(listingId),
    );
    throw new Error(
      `source inventory traversal page ${pageKey} references an unknown ${sourceId} listing${missing ? ` ${missing}` : ""}`,
    );
  }

  if (
    listingFactCompatibility === "exact" &&
    observedListingIds.length > 0
  ) {
    let factHashConflict = false;
    for (
      const chunk of chunkValues(
        observedListingIds,
        TRAVERSAL_LISTING_WRITE_SIZE,
      )
    ) {
      const result = await env.DB.prepare(`
        SELECT listing_id, fact_hash
        FROM source_inventory_traversal_listings
        WHERE traversal_id = ?
          AND listing_id IN (${chunk.map(() => "?").join(", ")})
      `).bind(traversalId, ...chunk).all<{
        listing_id: string;
        fact_hash: string | null;
      }>();
      for (const row of result.results ?? []) {
        if (
          row.fact_hash !== null &&
          row.fact_hash !== listingFactHashes.get(row.listing_id)
        ) {
          factHashConflict = true;
          break;
        }
      }
      if (factHashConflict) break;
    }
    if (factHashConflict) {
      await env.DB.prepare(`
        DELETE FROM source_inventory_traversals
        WHERE traversal_id = ? AND source_id = ?
      `).bind(traversalId, sourceId).run();
      throw new Error(
        `source inventory traversal page ${sanitizedTraversalPageKeyForError(pageKey)} repeated an identity with incompatible listing facts; traversal reset`,
      );
    }
  }

  const completedAt = utcNow();
  const endedRemovalStatements = inventoryCardinality === "observed_union"
    ? chunkValues(endedListingIds, TRAVERSAL_LISTING_WRITE_SIZE).map((chunk) =>
        env.DB.prepare(`
          DELETE FROM source_inventory_traversal_listings
          WHERE traversal_id = ?
            AND source_id = ?
            AND listing_id IN (${chunk.map(() => "?").join(", ")})
        `).bind(traversalId, sourceId, ...chunk)
      )
    : [];
  const listingStatements = [
    {
      listings: listingIds
        .filter((listingId) => !catalogOnlyListingIds.has(listingId))
        .map((listingId) => ({
          listingId,
          factHash: listingFactHashes.get(listingId) ?? null,
        })),
      catalogOnly: false,
    },
    {
      listings: listingIds
        .filter((listingId) => catalogOnlyListingIds.has(listingId))
        .map((listingId) => ({
          listingId,
          factHash: listingFactHashes.get(listingId) ?? null,
        })),
      catalogOnly: true,
    },
  ].flatMap((group) => chunkValues(
    group.listings,
    TRAVERSAL_LISTING_FACT_WRITE_SIZE,
  ).map((chunk) => env.DB.prepare(`
    WITH checkpoint_listing(listing_id, fact_hash) AS (
      VALUES ${chunk.map(() => "(?, ?)").join(", ")}
    )
    INSERT INTO source_inventory_traversal_listings (
      traversal_id, listing_id, source_id, partition_key, observed_at,
      fact_hash, inventory_member, review_candidate
    )
    SELECT
      page.traversal_id,
      checkpoint_listing.listing_id,
      traversal.source_id,
      ?,
      ?,
      checkpoint_listing.fact_hash,
      page.inventory_member,
      ${group.catalogOnly ? "0" : "page.review_candidate"}
    FROM checkpoint_listing
    JOIN listing_stubs stub
      ON stub.id = checkpoint_listing.listing_id AND stub.source_id = ?
    JOIN source_inventory_traversal_pages page
      ON page.traversal_id = ? AND page.page_key = ?
    JOIN source_inventory_traversals traversal
      ON traversal.traversal_id = page.traversal_id AND traversal.source_id = ?
    WHERE 1 = 1
    ON CONFLICT(traversal_id, listing_id) DO UPDATE SET
      source_id = excluded.source_id,
      partition_key = excluded.partition_key,
      observed_at = max(
        source_inventory_traversal_listings.observed_at,
        excluded.observed_at
      ),
      fact_hash = COALESCE(
        excluded.fact_hash,
        source_inventory_traversal_listings.fact_hash
      ),
      inventory_member = max(
        source_inventory_traversal_listings.inventory_member,
        excluded.inventory_member
      ),
      review_candidate = ${group.catalogOnly
        ? "0"
        : `max(
        source_inventory_traversal_listings.review_candidate,
        excluded.review_candidate
      )`}
  `).bind(
    ...chunk.flatMap((listing) => [
      listing.listingId,
      listing.factHash,
    ]),
    UNPARTITIONED_TRAVERSAL_KEY,
    observedAt,
    sourceId,
    traversalId,
    pageKey,
    sourceId,
  )));
  try {
    await env.DB.batch([
      ...endedRemovalStatements,
      ...listingStatements,
      env.DB.prepare(`
        UPDATE source_inventory_traversal_pages SET
          completed_at = COALESCE(completed_at, ?),
          observed_count = max(observed_count, ?)
        WHERE traversal_id = ? AND page_key = ?
          AND EXISTS (
            SELECT 1 FROM source_inventory_traversals traversal
            WHERE traversal.traversal_id = source_inventory_traversal_pages.traversal_id
              AND traversal.source_id = ?
          )
      `).bind(
        completedAt,
        observedListingIds.length,
        traversalId,
        pageKey,
        sourceId,
      ),
      env.DB.prepare(`
        UPDATE source_inventory_traversals SET updated_at = ?
        WHERE traversal_id = ? AND source_id = ?
      `).bind(completedAt, traversalId, sourceId),
    ]);
  } catch (error) {
    if (
      String(error).includes(
        "source inventory traversal listing fact hash conflicts",
      )
    ) {
      await env.DB.prepare(`
        DELETE FROM source_inventory_traversals
        WHERE traversal_id = ? AND source_id = ?
      `).bind(traversalId, sourceId).run();
      throw new Error(
        `source inventory traversal page ${sanitizedTraversalPageKeyForError(pageKey)} repeated an identity with incompatible listing facts; traversal reset`,
      );
    }
    throw error;
  }
  const state = await readSourceInventoryTraversalState(traversalId);
  if (!state || state.sourceId !== sourceId) {
    throw new Error(`source inventory traversal ${traversalId} disappeared during checkpoint`);
  }
  return state;
}
const TRAVERSAL_PUBLISHED_ELIGIBILITY_SQL = `
  candidate.terminal_ended = 0
  AND (
    candidate.auction_ends_at IS NULL
    OR candidate.auction_ends_at NOT GLOB '????-??-??T*'
    OR julianday(candidate.auction_ends_at) >
      julianday(candidate.eligibility_observed_at)
  )
`;
async function prepareSourceInventoryTraversalPublication(
  input: SourceInventoryTraversalPublicationInput,
): Promise<{
  result: PublishedSourceInventoryTraversal;
  statements: D1PreparedStatement[];
}> {
  const traversalId = validatedTraversalKey(input.traversalId, "inventory traversalId");
  const runId = validatedTraversalKey(input.runId, "inventory traversal runId");
  const sourceId = validatedTraversalKey(input.sourceId, "inventory traversal sourceId");
  const preserveUnobservedCurrentListings =
    getConfig().preserveUnobservedCurrentListings;
  const inventoryCardinality = validatedInventoryCardinality(
    input.inventoryCardinality,
  );
  const listingFactCompatibility = validatedListingFactCompatibility(
    input.listingFactCompatibility,
  );
  const expectedReviewCandidates = input.expectedReviewCandidates === undefined
    ? null
    : validatedTraversalCount(
        input.expectedReviewCandidates,
        "traversal expectedReviewCandidates",
      );
  if (
    input.currentInventorySupersedesPriorDetailEnd !== undefined &&
    typeof input.currentInventorySupersedesPriorDetailEnd !== "boolean"
  ) {
    throw new TypeError(
      "currentInventorySupersedesPriorDetailEnd must be a boolean when supplied",
    );
  }
  if (
    input.currentInventorySupersedesPriorDetailEnd === true &&
    inventoryCardinality !== "exact"
  ) {
    throw new TypeError(
      "currentInventorySupersedesPriorDetailEnd requires exact inventory cardinality",
    );
  }
  const publishedEligibilitySql =
    input.currentInventorySupersedesPriorDetailEnd === true
      ? "candidate.terminal_ended = 0"
      : TRAVERSAL_PUBLISHED_ELIGIBILITY_SQL;
  const eligibilityAt = input.eligibilityAt === undefined
    ? null
    : normalizedTraversalObservedAt(input.eligibilityAt);
  validatedTraversalKey(
    input.originCacheKey,
    "inventory traversal originCacheKey",
  );
  const state = await readSourceInventoryTraversalState(traversalId);
  if (!state || state.sourceId !== sourceId) {
    throw new SourceInventoryTraversalNotReadyError(
      `source inventory traversal ${traversalId} is unavailable for ${sourceId}`,
    );
  }
  if (state.inventoryCardinality !== inventoryCardinality) {
    await abandonSourceInventoryTraversal(traversalId);
    throw new SourceInventoryTraversalNotReadyError(
      `source inventory traversal ${traversalId} cardinality changed; traversal reset`,
    );
  }
  if (state.listingFactCompatibility !== listingFactCompatibility) {
    await abandonSourceInventoryTraversal(traversalId);
    throw new SourceInventoryTraversalNotReadyError(
      `source inventory traversal ${traversalId} listing fact compatibility changed; traversal reset`,
    );
  }
  if (!state.completed) {
    throw new SourceInventoryTraversalNotReadyError(
      `source inventory traversal ${traversalId} still has ${state.incompletePages} incomplete pages`,
    );
  }
  const evidence = await env.DB.prepare(`
    SELECT
      count(*) AS catalog_count,
      coalesce(sum(CASE WHEN ${publishedEligibilitySql}
        THEN 1 ELSE 0 END), 0) AS published_count,
      coalesce(sum(CASE WHEN candidate.review_candidate = 1
        AND (
          candidate.actionable_owner_listing_id IS NULL
          OR candidate.actionable_owner_listing_id = candidate.listing_id
        )
        AND (${publishedEligibilitySql})
        THEN 1 ELSE 0 END), 0) AS candidate_count,
      coalesce(sum(CASE WHEN candidate.fact_hash IS NULL
        THEN 1 ELSE 0 END), 0) AS missing_fact_hash_count
    FROM (
      SELECT
        inventory.listing_id,
        inventory.fact_hash,
        inventory.review_candidate,
        inventory.listing_id AS actionable_owner_listing_id,
        
        CASE
          WHEN EXISTS (
              SELECT 1
              FROM listing_recovery_status ended_recovery
              WHERE ended_recovery.listing_id = inventory.listing_id
                AND ended_recovery.state = 'terminal'
                AND ended_recovery.stage = 'scope'
                AND ended_recovery.last_error_code = 'listing_ended'
            )
          THEN 1 ELSE 0
        END AS terminal_ended,
        ${EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL} AS auction_ends_at,
        max(
          inventory.observed_at,
          COALESCE(observation.observed_at, d.scraped_at, inventory.observed_at),
          COALESCE(?, inventory.observed_at)
        ) AS eligibility_observed_at
      FROM source_inventory_traversal_listings inventory
      LEFT JOIN listing_details d ON d.listing_id = inventory.listing_id
      LEFT JOIN listing_detail_observations observation
        ON observation.listing_id = inventory.listing_id
      WHERE inventory.traversal_id = ? AND inventory.source_id = ?
        AND inventory.inventory_member = 1
    ) candidate
  `).bind(eligibilityAt, traversalId, sourceId).first<{
    catalog_count: number;
    published_count: number;
    candidate_count: number;
    missing_fact_hash_count: number;
  }>();
  const catalogCount = Number(evidence?.catalog_count ?? 0);
  const missingFactHashCount = Number(
    evidence?.missing_fact_hash_count ?? 0,
  );
  if (
    listingFactCompatibility === "exact" &&
    missingFactHashCount > 0
  ) {
    await abandonSourceInventoryTraversal(traversalId);
    throw new SourceInventoryTraversalNotReadyError(
      `source inventory traversal ${traversalId} has ${missingFactHashCount} inventory listings without exact fact evidence; traversal reset`,
    );
  }
  if (
    inventoryCardinality === "exact"
      ? catalogCount !== state.expectedListings
      : catalogCount < 1
  ) {
    await abandonSourceInventoryTraversal(traversalId);
    throw new SourceInventoryTraversalNotReadyError(
      `source inventory traversal ${traversalId} staged ${catalogCount} unique inventory-member listings; expected ${state.expectedListings}; traversal reset`,
    );
  }
  const publishedCount = Number(evidence?.published_count ?? 0);
  const candidateCount = Number(evidence?.candidate_count ?? 0);
  if (
    expectedReviewCandidates !== null &&
    candidateCount !== expectedReviewCandidates
  ) {
    await abandonSourceInventoryTraversal(traversalId);
    throw new SourceInventoryTraversalNotReadyError(
      `source inventory traversal ${traversalId} staged ${candidateCount} unique eligible review-candidate listings; expected ${expectedReviewCandidates}; traversal reset`,
    );
  }

  const stagedMembershipEvidence = await env.DB.prepare(`
    SELECT inventory.listing_id, inventory.fact_hash,
      inventory.inventory_member, inventory.review_candidate
    FROM source_inventory_traversal_listings inventory
    WHERE inventory.traversal_id = ? AND inventory.source_id = ?
    ORDER BY inventory.listing_id
  `).bind(traversalId, sourceId).all<{
    listing_id: string;
    fact_hash: string | null;
    inventory_member: number;
    review_candidate: number;
  }>();
  const priorMembershipEvidence = preserveUnobservedCurrentListings
    ? await env.DB.prepare(`
        SELECT current.listing_id, current.inventory_run_id,
          current.review_candidate
        FROM source_current_listings current
        WHERE current.source_id = ?
        ORDER BY current.listing_id
      `).bind(sourceId).all<{
        listing_id: string;
        inventory_run_id: string;
        review_candidate: number;
      }>()
    : { results: [] as never[] };
  const publicationInvalidation = await prepareSourcePublicationMutationInvalidation({
    sourceId,
    runId,
    publicationInput: {
      sourceId,
      runId,
      coverageMode: "complete_current",
      traversalFingerprint: state.fingerprint,
      inventoryCardinality,
      listingFactCompatibility,
      listingCount: publishedCount,
      catalogCount,
      candidateCount,
      collectionCountsJson: "[]",
    },
    membershipInput: {
      sourceId,
      runId,
      preserveUnobservedCurrentListings,
      eligibilityAt,
      currentInventorySupersedesPriorDetailEnd:
        input.currentInventorySupersedesPriorDetailEnd === true,
      staged: stagedMembershipEvidence.results ?? [],
      prior: priorMembershipEvidence.results ?? [],
    },
  });

  const statements: D1PreparedStatement[] = [
    preserveUnobservedCurrentListings
      ? env.DB.prepare(`
          UPDATE source_current_listings
          SET inventory_run_id = ?
          WHERE source_id = ?
        `).bind(runId, sourceId)
      : env.DB.prepare(`
          DELETE FROM source_current_listings WHERE source_id = ?
        `).bind(sourceId),
    env.DB.prepare(`
      INSERT INTO source_current_listings (
        listing_id, source_id, inventory_run_id, observed_at, review_candidate
      )
      SELECT
        candidate.listing_id,
        candidate.source_id,
        ?,
        candidate.observed_at,
        CASE
          WHEN candidate.review_candidate = 1
            AND (
              candidate.actionable_owner_listing_id IS NULL
              OR candidate.actionable_owner_listing_id = candidate.listing_id
            )
          THEN 1 ELSE 0
        END
      FROM (
        SELECT
          inventory.listing_id,
          inventory.source_id,
          inventory.observed_at,
          inventory.review_candidate,
          inventory.listing_id AS actionable_owner_listing_id,
          
          CASE
            WHEN EXISTS (
                SELECT 1
                FROM listing_recovery_status ended_recovery
                WHERE ended_recovery.listing_id = inventory.listing_id
                  AND ended_recovery.state = 'terminal'
                  AND ended_recovery.stage = 'scope'
                  AND ended_recovery.last_error_code = 'listing_ended'
              )
            THEN 1 ELSE 0
          END AS terminal_ended,
          ${EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL} AS auction_ends_at,
          max(
            inventory.observed_at,
            COALESCE(observation.observed_at, d.scraped_at, inventory.observed_at),
            COALESCE(?, inventory.observed_at)
          ) AS eligibility_observed_at
        FROM source_inventory_traversal_listings inventory
        LEFT JOIN listing_details d ON d.listing_id = inventory.listing_id
        LEFT JOIN listing_detail_observations observation
          ON observation.listing_id = inventory.listing_id
        WHERE inventory.traversal_id = ? AND inventory.source_id = ?
          AND inventory.inventory_member = 1
      ) candidate
      WHERE ${publishedEligibilitySql}
      ORDER BY candidate.listing_id
      ${preserveUnobservedCurrentListings ? `
        ON CONFLICT(listing_id) DO UPDATE SET
          source_id = excluded.source_id,
          inventory_run_id = excluded.inventory_run_id,
          observed_at = excluded.observed_at,
          review_candidate = excluded.review_candidate
      ` : ""}
    `).bind(runId, eligibilityAt, traversalId, sourceId),
    env.DB.prepare(`
      INSERT INTO source_inventory_publications (
        source_id, inventory_run_id, listing_count,
        collection_counts_json, published_at
      )
      SELECT ?, ?, count(*), ?,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM source_current_listings
      WHERE source_id = ? AND inventory_run_id = ?
      ON CONFLICT(source_id, inventory_run_id) DO NOTHING
    `).bind(
      sourceId,
      runId,
      "[]",
      sourceId,
      runId,
    ),
    env.DB.prepare(`
      INSERT INTO source_inventory_publication_heads (
        source_id, inventory_run_id, updated_at
      ) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(source_id) DO UPDATE SET
        inventory_run_id = excluded.inventory_run_id,
        updated_at = excluded.updated_at
    `).bind(sourceId, runId),
    env.DB.prepare(`
      DELETE FROM source_inventory_observations WHERE source_id = ?
    `).bind(sourceId),
    env.DB.prepare(`
      DELETE FROM listing_recovery_status
      WHERE state = 'terminal'
        AND stage = 'scope'
        AND last_error_code = 'source_scope_excluded'
        AND listing_id IN (
          SELECT id FROM listing_stubs WHERE source_id = ?
        )
    `).bind(sourceId),
    env.DB.prepare(`
      DELETE FROM source_inventory_traversals
      WHERE traversal_id = ? AND source_id = ?
    `).bind(traversalId, sourceId),
    ...publicationInvalidation,
  ];
  return {
    result: { publishedCount, catalogCount, candidateCount },
    statements,
  };
}
export async function publishSourceInventoryTraversal(
  input: SourceInventoryTraversalPublicationInput,
): Promise<PublishedSourceInventoryTraversal> {
  const [result] = await publishSourceInventoryTraversalBundle([input]);
  if (!result) {
    throw new Error("Source inventory publication returned no result");
  }
  return result;
}
export async function publishSourceInventoryTraversalBundle(
  inputs: readonly SourceInventoryTraversalPublicationInput[],
): Promise<readonly PublishedSourceInventoryTraversal[]> {
  if (!Array.isArray(inputs) || inputs.length < 1) {
    throw new TypeError(
      "Source inventory publication bundle must contain at least one source",
    );
  }
  const sourceIds = new Set<string>();
  const traversalIds = new Set<string>();
  const runIds = new Set<string>();
  const prepared: Array<{
    result: PublishedSourceInventoryTraversal;
    statements: D1PreparedStatement[];
  }> = [];
  const validatedInputs: Array<{
    input: SourceInventoryTraversalPublicationInput;
    sourceId: string;
  }> = [];
  for (const input of inputs) {
    const sourceId = validatedTraversalKey(
      input.sourceId,
      "inventory traversal sourceId",
    );
    const traversalId = validatedTraversalKey(
      input.traversalId,
      "inventory traversalId",
    );
    const runId = validatedTraversalKey(
      input.runId,
      "inventory traversal runId",
    );
    if (sourceIds.has(sourceId) || traversalIds.has(traversalId)) {
      throw new TypeError(
        "Source inventory publication bundle repeats a source or traversal",
      );
    }
    sourceIds.add(sourceId);
    traversalIds.add(traversalId);
    runIds.add(runId);
    validatedInputs.push({ input, sourceId });
  }
  if (runIds.size !== 1) {
    throw new TypeError(
      "Source inventory publication bundle must share one discovery run",
    );
  }
  for (const { input } of validatedInputs) {
    prepared.push(await prepareSourceInventoryTraversalPublication(input));
  }
  const publicationBatchStatements: D1PreparedStatement[] = [];
  const publicationHeadResultIndexes: Array<{
    readonly prior: number;
    readonly resulting: number;
  }> = [];
  for (let index = 0; index < prepared.length; index += 1) {
    const sourceId = validatedInputs[index]!.sourceId as SourceId;
    const prior = publicationBatchStatements.length;
    publicationBatchStatements.push(
      sourceInventoryPublicationHeadReadStatement(sourceId),
    );
    publicationBatchStatements.push(...prepared[index]!.statements);
    const resulting = publicationBatchStatements.length;
    publicationBatchStatements.push(
      sourceInventoryPublicationHeadReadStatement(sourceId),
    );
    publicationHeadResultIndexes.push({ prior, resulting });
  }
  const publicationBatchResults = await env.DB.batch(
    publicationBatchStatements,
  );
  const publicationTransitions = publicationHeadResultIndexes.map(
    (resultIndexes, index) => committedPublicationTransition({
      sourceId: validatedInputs[index]!.sourceId as SourceId,
      runId: validatedInputs[index]!.input.runId,
      priorResult: publicationBatchResults[resultIndexes.prior],
      resultingResult: publicationBatchResults[resultIndexes.resulting],
    }),
  );
  if (getConfig().preserveUnobservedCurrentListings) {
    for (let index = 0; index < validatedInputs.length; index += 1) {
      const { input, sourceId } = validatedInputs[index]!;
      const publication = await env.DB.prepare(`
        SELECT listing_count
        FROM source_inventory_publications
        WHERE source_id = ? AND inventory_run_id = ?
        LIMIT 1
      `).bind(sourceId, input.runId).first<{ listing_count: number }>();
      if (!publication) {
        throw new Error(
          `${sourceId} additive publication count was not persisted`,
        );
      }
      prepared[index] = {
        ...prepared[index]!,
        result: {
          ...prepared[index]!.result,
          publishedCount: Number(publication.listing_count),
        },
      };
    }
  }
  const published = prepared.map((entry, index) => attachPublicationTransition(
    entry.result,
    publicationTransitions[index]!,
  ));
  return published;
}
export async function abandonSourceInventoryTraversal(
  traversalIdInput: string,
): Promise<boolean> {
  const traversalId = validatedTraversalKey(
    traversalIdInput,
    "inventory traversalId",
  );
  const result = await env.DB.prepare(`
    DELETE FROM source_inventory_traversals WHERE traversal_id = ?
  `).bind(traversalId).run();
  return (result.meta.changes ?? 0) > 0;
}
export async function replaceSourceCurrentInventory(input: {
  runId: string;
  sourceId: string;
}): Promise<CommittedSourcePublicationTransition> {
  const sourceId = validatedTraversalKey(
    input.sourceId,
    "current inventory sourceId",
  ) as SourceId;
  const runId = validatedTraversalKey(
    input.runId,
    "current inventory runId",
  );
  const preserveUnobservedCurrentListings =
    getConfig().preserveUnobservedCurrentListings;
  const observedMembershipEvidence = await env.DB.prepare(`
    SELECT observation.listing_id, observation.observed_at
    FROM source_inventory_observations observation
    WHERE observation.run_id = ? AND observation.source_id = ?
    ORDER BY observation.listing_id
  `).bind(input.runId, input.sourceId).all<{
    listing_id: string;
    observed_at: string;
  }>();
  const priorMembershipEvidence = preserveUnobservedCurrentListings
    ? await env.DB.prepare(`
        SELECT current.listing_id, current.inventory_run_id,
          current.review_candidate
        FROM source_current_listings current
        WHERE current.source_id = ?
        ORDER BY current.listing_id
      `).bind(input.sourceId).all<{
        listing_id: string;
        inventory_run_id: string;
        review_candidate: number;
      }>()
    : { results: [] as never[] };
  const publicationInvalidation = await prepareSourcePublicationMutationInvalidation({
    sourceId,
    runId,
    publicationInput: {
      sourceId,
      runId,
      coverageMode: "complete_current",
      collectionCountsJson: "[]",
      preserveUnobservedCurrentListings,
      observedCount: observedMembershipEvidence.results?.length ?? 0,
    },
    membershipInput: {
      sourceId,
      runId,
      preserveUnobservedCurrentListings,
      observed: observedMembershipEvidence.results ?? [],
      prior: priorMembershipEvidence.results ?? [],
    },
  });

  const publicationStatements: D1PreparedStatement[] = [
    sourceInventoryPublicationHeadReadStatement(sourceId),
    preserveUnobservedCurrentListings
      ? env.DB.prepare(`
          UPDATE source_current_listings
          SET inventory_run_id = ?
          WHERE source_id = ?
        `).bind(input.runId, input.sourceId)
      : env.DB.prepare(`
          DELETE FROM source_current_listings WHERE source_id = ?
        `).bind(input.sourceId),
    env.DB.prepare(`
      INSERT INTO source_current_listings (
        listing_id, source_id, inventory_run_id, observed_at, review_candidate
      )
      SELECT candidate.listing_id, candidate.source_id,
        candidate.run_id, candidate.observed_at, 1
      FROM (
        SELECT
          inventory.listing_id,
          inventory.source_id,
          inventory.run_id,
          inventory.observed_at,
          ${EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL} AS auction_ends_at,
          max(
            inventory.observed_at,
            COALESCE(observation.observed_at, d.scraped_at, inventory.observed_at)
          ) AS evidence_observed_at
        FROM source_inventory_observations inventory
        LEFT JOIN listing_details d ON d.listing_id = inventory.listing_id
        LEFT JOIN listing_detail_observations observation
          ON observation.listing_id = inventory.listing_id
        WHERE inventory.run_id = ? AND inventory.source_id = ?
      ) candidate
      WHERE candidate.auction_ends_at IS NULL
        OR candidate.auction_ends_at NOT GLOB '????-??-??T*'
        OR julianday(candidate.auction_ends_at) > julianday(candidate.evidence_observed_at)
      ORDER BY candidate.listing_id
      ${preserveUnobservedCurrentListings ? `
        ON CONFLICT(listing_id) DO UPDATE SET
          source_id = excluded.source_id,
          inventory_run_id = excluded.inventory_run_id,
          observed_at = excluded.observed_at,
          review_candidate = excluded.review_candidate
      ` : ""}
    `).bind(input.runId, input.sourceId),
    env.DB.prepare(`
      INSERT INTO source_inventory_publications (
        source_id, inventory_run_id, listing_count, published_at
      )
      SELECT ?, ?, count(*),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM source_current_listings
      WHERE source_id = ? AND inventory_run_id = ?
      ON CONFLICT(source_id, inventory_run_id) DO NOTHING
    `).bind(input.sourceId, input.runId, input.sourceId, input.runId),
    env.DB.prepare(`
      INSERT INTO source_inventory_publication_heads (
        source_id, inventory_run_id, updated_at
      ) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(source_id) DO UPDATE SET
        inventory_run_id = excluded.inventory_run_id,
        updated_at = excluded.updated_at
    `).bind(input.sourceId, input.runId),
    env.DB.prepare(`
      DELETE FROM source_inventory_observations
      WHERE run_id = ? AND source_id = ?
    `).bind(input.runId, input.sourceId),
    ...publicationInvalidation,
    sourceInventoryPublicationHeadReadStatement(sourceId),
  ];
  const publicationResults = await env.DB.batch(publicationStatements);
  const transition = committedPublicationTransition({
    sourceId,
    runId,
    priorResult: publicationResults[0],
    resultingResult: publicationResults.at(-1),
  });
  return transition;
}
export async function discardEndedListingObservation(input: {
  runId: string;
  listingId: string;
}): Promise<{ removedNewListing: boolean }> {
  if (getConfig().preserveUnobservedCurrentListings) {
    return { removedNewListing: false };
  }
  const newListing = await env.DB.prepare(`
    SELECT 1 AS present
    FROM dashboard_new_listings
    WHERE listing_id = ? AND first_seen_run_id = ?
    LIMIT 1
  `).bind(input.listingId, input.runId).first<{ present: number }>();
  const current = await env.DB.prepare(`
    SELECT source_id FROM source_current_listings
    WHERE listing_id = ? LIMIT 1
  `).bind(input.listingId).first<{ source_id: string }>();
  const invalidation = current
    ? await prepareSourceMembershipMutationInvalidation({
        sourceId: current.source_id,
        listingId: input.listingId,
        reasonCode: "ended_observation_discarded",
        evidence: { runId: input.runId, terminal: "listing_ended" },
      })
    : [];
  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM source_inventory_observations
      WHERE run_id = ? AND listing_id = ?
    `).bind(input.runId, input.listingId),
    env.DB.prepare(`
      DELETE FROM dashboard_new_listings
      WHERE listing_id = ? AND first_seen_run_id = ?
    `).bind(input.listingId, input.runId),
    env.DB.prepare(`
      DELETE FROM source_current_listings
      WHERE listing_id = ?
    `).bind(input.listingId),
    ...invalidation,
  ]);
  return { removedNewListing: newListing?.present === 1 };
}
export async function discardEndedTraversalObservation(input: {
  runId: string;
  listingId: string;
}): Promise<{ removedNewListing: boolean }> {
  const newListing = await env.DB.prepare(`
    SELECT 1 AS present
    FROM dashboard_new_listings
    WHERE listing_id = ? AND first_seen_run_id = ?
    LIMIT 1
  `).bind(input.listingId, input.runId).first<{ present: number }>();
  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM source_inventory_observations
      WHERE run_id = ? AND listing_id = ?
    `).bind(input.runId, input.listingId),
    env.DB.prepare(`
      DELETE FROM dashboard_new_listings
      WHERE listing_id = ? AND first_seen_run_id = ?
    `).bind(input.listingId, input.runId),
  ]);
  return { removedNewListing: newListing?.present === 1 };
}
export async function pruneTerminalEndedCurrentListings(
  sourceId: string,
): Promise<number> {
  if (getConfig().preserveUnobservedCurrentListings) return 0;
  const terminalEndedSql = `
    SELECT current_inventory.listing_id
    FROM source_current_listings current_inventory
    WHERE current_inventory.source_id = ?
      AND EXISTS (
        SELECT 1
        FROM listing_recovery_status recovery
        WHERE recovery.listing_id = current_inventory.listing_id
          AND recovery.state = 'terminal'
          AND recovery.stage = 'scope'
          AND recovery.last_error_code = 'listing_ended'
      )
  `;
  const terminalRows = await env.DB.prepare(`
    ${terminalEndedSql}
    ORDER BY current_inventory.listing_id
  `).bind(sourceId).all<{ listing_id: string }>();
  const listingIds = (terminalRows.results ?? []).map((row) => row.listing_id);
  if (listingIds.length === 0) return 0;
  const invalidation = await prepareCanonicalMutationPayloadInvalidationStatements({
    database: env.DB,
    generations: [{
      domain: "source_current_membership",
      scopeType: "source",
      scopeId: sourceId,
      input: { sourceId, terminalRemovedListingIds: listingIds },
      derivationVersion: SOURCE_MEMBERSHIP_MUTATION_DERIVATION_VERSION,
    }],
    refresh: {
      target: { type: "source", sourceId },
      reasonCode: "terminal_current_listings_pruned",
      priority: 800,
    },
  });
  const [, currentResult] = await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM dashboard_new_listings
      WHERE listing_id IN (${terminalEndedSql})
    `).bind(sourceId),
    env.DB.prepare(`
      DELETE FROM source_current_listings
      WHERE listing_id IN (${terminalEndedSql})
    `).bind(sourceId),
    ...invalidation,
  ]);
  return currentResult.meta.changes ?? 0;
}
export async function pruneRecoveredDetailRetryStatuses(
  sourceId: string,
): Promise<number> {
  const affected = await env.DB.prepare(`
    SELECT recovery.listing_id, recovery.origin_cache_key
    FROM listing_recovery_status recovery
    WHERE recovery.state = 'retryable'
      AND recovery.stage = 'detail'
      AND recovery.listing_id IN (
        SELECT current_inventory.listing_id
        FROM source_current_listings current_inventory
        WHERE current_inventory.source_id = ?
      )
      AND (
        (
          EXISTS (
            SELECT 1 FROM listing_details detail
            WHERE detail.listing_id = recovery.listing_id
          )
          AND EXISTS (
            SELECT 1 FROM listing_detail_observations observation
            WHERE observation.listing_id = recovery.listing_id
          )
        )
        OR EXISTS (
          SELECT 1 FROM listing_detail_terminal_status terminal_detail
          WHERE terminal_detail.listing_id = recovery.listing_id
        )
      )
    ORDER BY recovery.listing_id, recovery.origin_cache_key
  `).bind(sourceId).all<{
    listing_id: string;
    origin_cache_key: string;
  }>();
  const originsByListing = new Map<string, string[]>();
  for (const row of affected.results ?? []) {
    const origins = originsByListing.get(row.listing_id) ?? [];
    origins.push(row.origin_cache_key);
    originsByListing.set(row.listing_id, origins);
  }
  return pruneRecoveredListingStatuses({
    sourceId,
    entries: [...originsByListing].map(([listingId, originCacheKeys]) => ({
      listingId,
      canonicalInput: {
        recovery: "pruned",
        stage: "detail",
        originCacheKeys,
      },
    })),
    deleteStatement: (listingId) => env.DB.prepare(`
    DELETE FROM listing_recovery_status
    WHERE state = 'retryable'
      AND stage = 'detail'
      AND listing_id = ?
  `).bind(listingId),
    generations: [{
      domain: "accepted_detail_location",
      derivationVersion: ACCEPTED_DETAIL_LOCATION_MUTATION_DERIVATION_VERSION,
    }],
    reasonCode: "detail_recovery_pruned",
  });
}
async function pruneRecoveredListingStatuses(input: {
  readonly sourceId: string;
  readonly entries: readonly {
    listingId: string;
    canonicalInput: unknown;
  }[];
  readonly deleteStatement: (listingId: string) => D1PreparedStatement;
  readonly generations: readonly {
    domain: PipelineGenerationDomainName;
    derivationVersion: string;
  }[];
  readonly reasonCode: string;
}): Promise<number> {
  let removed = 0;
  for (const chunk of chunkValues(input.entries, 8)) {
    const statementGroups = await Promise.all(chunk.map(async (entry) => {
      const invalidation =
        await prepareListingCanonicalDomainsMutationInvalidation({
          listingId: entry.listingId,
          sourceId: input.sourceId,
          generations: input.generations.map((generation) => ({
            ...generation,
            canonicalInput: entry.canonicalInput,
          })),
          reasonCode: input.reasonCode,
          priority: 500,
        });
      return [input.deleteStatement(entry.listingId), ...invalidation] as const;
    }));
    const statements: D1PreparedStatement[] = [];
    const deletionIndexes: number[] = [];
    for (const group of statementGroups) {
      deletionIndexes.push(statements.length);
      statements.push(...group);
    }
    const results = await env.DB.batch(statements);
    removed += deletionIndexes.reduce(
      (sum, index) => sum + (results[index]?.meta.changes ?? 0),
      0,
    );
  }
  return removed;
}
export async function pruneRecoveredPipelineRetryStatuses(input: {
  sourceId: string;
  originCacheKey: string;
  routeProviderName: string;
  requiresActionDeadline?: boolean;
}): Promise<number> {
  const recoveredListingSql = `
    WITH current_progress AS (
          SELECT
            current_inventory.listing_id,
            (
              SELECT cached_route.drive_bucket
              FROM listing_routes route
              JOIN route_cache cached_route
                ON cached_route.id = route.route_cache_id
              WHERE route.listing_id = current_inventory.listing_id
                AND cached_route.origin_cache_key = ?
                AND cached_route.provider_name = ?
              ORDER BY
                route.assigned_at DESC,
                cached_route.calculated_at DESC,
                route.route_cache_id DESC
              LIMIT 1
            ) AS drive_bucket,
            (
              SELECT cached_route.error_code
              FROM listing_routes route
              JOIN route_cache cached_route
                ON cached_route.id = route.route_cache_id
              WHERE route.listing_id = current_inventory.listing_id
                AND cached_route.origin_cache_key = ?
                AND cached_route.provider_name = ?
              ORDER BY
                route.assigned_at DESC,
                cached_route.calculated_at DESC,
                route.route_cache_id DESC
              LIMIT 1
            ) AS route_error_code
          FROM source_current_listings current_inventory
          WHERE current_inventory.source_id = ?
            AND EXISTS (
              SELECT 1 FROM listing_details detail
              WHERE detail.listing_id = current_inventory.listing_id
            )
            AND EXISTS (
              SELECT 1 FROM listing_detail_observations observation
              WHERE observation.listing_id = current_inventory.listing_id
            )
            ${input.requiresActionDeadline === true
              ? `AND EXISTS (
                  SELECT 1 FROM listing_action_deadlines action_deadline
                  WHERE action_deadline.listing_id =
                    current_inventory.listing_id
                )`
              : ""}
    )
    SELECT current_progress.listing_id
    FROM current_progress
    WHERE (
        (
          current_progress.route_error_code IS NULL
          AND current_progress.drive_bucket = 'exclude'
        )
        OR (
          (
            current_progress.route_error_code IS NULL
            AND current_progress.drive_bucket IN (
              'under_2h', 'under_4h', 'under_8h'
            )
          )
          OR current_progress.route_error_code = 'unknown_location'
        ) AND (
          NOT EXISTS (
            SELECT 1
            FROM listing_images primary_image
            WHERE primary_image.listing_id = current_progress.listing_id
              AND primary_image.is_primary = 1
              AND primary_image.download_status <> 'downloaded'
          )
        )
      )
  `;
  const affected = await env.DB.prepare(`
    SELECT recovery.listing_id
    FROM listing_recovery_status recovery
    WHERE recovery.origin_cache_key = ?
      AND recovery.state = 'retryable'
      AND recovery.stage = 'pipeline'
      AND recovery.last_error_code = 'error'
      AND recovery.listing_id IN (${recoveredListingSql})
    ORDER BY recovery.listing_id
  `).bind(
    input.originCacheKey,
    input.originCacheKey,
    input.routeProviderName,
    input.originCacheKey,
    input.routeProviderName,
    input.sourceId,
  ).all<{ listing_id: string }>();
  return pruneRecoveredListingStatuses({
    sourceId: input.sourceId,
    entries: (affected.results ?? []).map((row) => ({
      listingId: row.listing_id,
      canonicalInput: {
        recovery: "pruned",
        stage: "pipeline",
        originCacheKey: input.originCacheKey,
        routeProviderName: input.routeProviderName,
      },
    })),
    deleteStatement: (listingId) => env.DB.prepare(`
      DELETE FROM listing_recovery_status
      WHERE listing_id = ? AND origin_cache_key = ?
        AND state = 'retryable' AND stage = 'pipeline'
        AND last_error_code = 'error'
    `).bind(listingId, input.originCacheKey),
    generations: [
      {
        domain: "accepted_detail_location",
        derivationVersion: ACCEPTED_DETAIL_LOCATION_MUTATION_DERIVATION_VERSION,
      },
      {
        domain: "route_contract",
        derivationVersion: ROUTE_CONTRACT_MUTATION_DERIVATION_VERSION,
      },
      {
        domain: "factual_supplement",
        derivationVersion: FACTUAL_SUPPLEMENT_MUTATION_DERIVATION_VERSION,
      },
      {
        domain: "image_local_primary",
        derivationVersion: IMAGE_LOCAL_PRIMARY_MUTATION_DERIVATION_VERSION,
      },
    ],
    reasonCode: "pipeline_recovery_pruned",
  });
}
export async function pruneRecoveredRouteRetryStatuses(input: {
  sourceId: string;
  originCacheKey: string;
  routeProviderName: string;
}): Promise<number> {
  const affected = await env.DB.prepare(`
    SELECT DISTINCT current_inventory.listing_id
        FROM source_current_listings current_inventory
        JOIN listing_routes route
          ON route.listing_id = current_inventory.listing_id
        JOIN route_cache cached_route
          ON cached_route.id = route.route_cache_id
        WHERE current_inventory.source_id = ?
          AND cached_route.origin_cache_key = ?
          AND cached_route.provider_name = ?
          AND (
            cached_route.error_code IS NULL
            OR cached_route.error_code = 'unknown_location'
          )
          AND EXISTS (
            SELECT 1 FROM listing_recovery_status recovery
            WHERE recovery.listing_id = current_inventory.listing_id
              AND recovery.origin_cache_key = ?
              AND recovery.state = 'retryable'
              AND recovery.stage = 'route'
          )
  `).bind(
    input.sourceId,
    input.originCacheKey,
    input.routeProviderName,
    input.originCacheKey,
  ).all<{ listing_id: string }>();
  return pruneRecoveredListingStatuses({
    sourceId: input.sourceId,
    entries: (affected.results ?? []).map((row) => ({
      listingId: row.listing_id,
      canonicalInput: {
        recovery: "pruned",
        stage: "route",
        originCacheKey: input.originCacheKey,
        routeProviderName: input.routeProviderName,
      },
    })),
    deleteStatement: (listingId) => env.DB.prepare(`
      DELETE FROM listing_recovery_status
      WHERE listing_id = ? AND origin_cache_key = ?
        AND state = 'retryable' AND stage = 'route'
    `).bind(listingId, input.originCacheKey),
    generations: [{
      domain: "route_contract",
      derivationVersion: ROUTE_CONTRACT_MUTATION_DERIVATION_VERSION,
    }],
    reasonCode: "route_recovery_pruned",
  });
}
export async function findSeenListing(
  sourceId: string,
  sourceListingId: string,
): Promise<string | null> {
  const row = await env.DB.prepare(`
    SELECT id FROM listing_stubs WHERE source_id = ? AND source_listing_id = ? LIMIT 1
  `).bind(sourceId, sourceListingId).first<{ id: string }>();
  return row?.id ?? null;
}
export async function loadSourceListingProgress(
  sourceId: string,
  routeScope: { originCacheKey: string; providerName: string },
): Promise<Map<string, SourceListingProgress>> {
  const adhocCohortId = configuredAdhocReviewCohortId() ?? "";
  interface ProgressRow {
    id: string;
    source_listing_id: string;
    has_detail: number;
    has_detail_observation: number;
    drive_bucket: string | null;
    route_error_code: string | null;
    distance_exempt: number;
    primary_image_status: string | null;
    primary_image_error_code: string | null;
    recovery_state: string | null;
    recovery_stage: string | null;
    recovery_last_attempted_at: string | null;
    recovery_last_error_code: string | null;
  }

  const result = await env.DB.prepare(`
    SELECT
      s.id,
      s.source_listing_id,
      EXISTS (
        SELECT 1 FROM listing_details d WHERE d.listing_id = s.id
      ) AS has_detail,
      EXISTS (
        SELECT 1 FROM listing_detail_observations observation
        WHERE observation.listing_id = s.id
      ) AS has_detail_observation,
      rc.drive_bucket,
      rc.error_code AS route_error_code,
      CASE WHEN ${adhocReviewListingMemberExistsSql({
        listingIdSql: "s.id",
        sourceIdSql: "s.source_id",
      })} THEN 1 ELSE 0 END AS distance_exempt,
      (
        SELECT i.download_status
        FROM listing_images i
        WHERE i.listing_id = s.id AND i.is_primary = 1
        LIMIT 1
      ) AS primary_image_status
      , (
        SELECT i.download_error_code
        FROM listing_images i
        WHERE i.listing_id = s.id AND i.is_primary = 1
        LIMIT 1
      ) AS primary_image_error_code
      , CASE
          WHEN terminal_detail.listing_id IS NOT NULL THEN 'terminal'
          ELSE recovery.state
        END AS recovery_state
      , CASE
          WHEN terminal_detail.listing_id IS NOT NULL THEN 'detail'
          ELSE recovery.stage
        END AS recovery_stage
      , COALESCE(
          terminal_detail.last_attempted_at,
          recovery.last_attempted_at
        ) AS recovery_last_attempted_at
      , COALESCE(
          terminal_detail.error_code,
          recovery.last_error_code
        ) AS recovery_last_error_code
    FROM listing_stubs s
    LEFT JOIN route_cache rc ON rc.id = (
      SELECT lr.route_cache_id
       FROM listing_routes lr
       JOIN route_cache candidate ON candidate.id = lr.route_cache_id
       WHERE lr.listing_id = s.id
         AND candidate.origin_cache_key = ?
         AND candidate.provider_name = ?
       ORDER BY lr.assigned_at DESC, candidate.calculated_at DESC, lr.route_cache_id DESC
       LIMIT 1
     )
     LEFT JOIN listing_recovery_status recovery
       ON recovery.listing_id = s.id AND recovery.origin_cache_key = ?
     LEFT JOIN listing_detail_terminal_status terminal_detail
       ON terminal_detail.listing_id = s.id
     WHERE s.source_id = ?
  `).bind(
    adhocCohortId,
    routeScope.originCacheKey,
    routeScope.providerName,
    routeScope.originCacheKey,
    sourceId,
  ).all<ProgressRow>();

  const rows = result.results ?? [];
  const routeDispositions = await readExactRouteDispositionsForScope({
    listingIds: rows.map((row) => row.id),
    originCacheKey: routeScope.originCacheKey,
    routeProviderName: routeScope.providerName,
  });
  const progress = new Map<string, SourceListingProgress>();
  for (const row of rows) {
    const routeDisposition = routeDispositions.get(row.id) ?? "stale";
    const routeIsCurrent = routeDisposition !== "stale";
    progress.set(row.source_listing_id, {
      id: row.id,
      hasDetail: row.has_detail === 1,
      hasDetailObservation: row.has_detail_observation === 1,
      driveBucket: routeIsCurrent ? parseStoredDriveBucket(row.drive_bucket) : null,
      distanceExempt: row.distance_exempt === 1,
      ...(routeDisposition === "excluded" ? { distanceExcluded: true } : {}),
      routeErrorCode: routeIsCurrent ? row.route_error_code : null,
      primaryImageStatus: parseStoredPrimaryImageStatus(row.primary_image_status),
      primaryImageErrorCode: row.primary_image_error_code,
      recoveryState:
        row.recovery_state === "retryable" || row.recovery_state === "terminal"
        ? row.recovery_state
        : null,
      recoveryLastAttemptedAt: row.recovery_last_attempted_at,
      recoveryErrorCode: row.recovery_last_error_code,
    });
  }
  return progress;
}
export async function ensureSourceOriginPriorityObservations(input: {
  runId: string;
  sourceId: string;
  originCacheKey: string;
  entries: readonly {
    listingId: string;
    originPostalCode: string;
    radiusMiles: number;
    observedAt: string;
    contentHash: string;
  }[];
}): Promise<number> {
  const runId = validatedTraversalKey(input.runId, "origin-priority runId");
  const sourceId = validatedTraversalKey(
    input.sourceId,
    "origin-priority sourceId",
  );
  const originCacheKey = input.originCacheKey.trim();
  if (originCacheKey.length < 1 || originCacheKey.length > 512) {
    throw new Error("Origin-priority cache key must contain 1-512 characters");
  }

  const entries = new Map<string, {
    listingId: string;
    originPostalCode: string;
    radiusMiles: number;
    observedAt: string;
    contentHash: string;
  }>();
  for (const raw of input.entries) {
    const listingId = validatedTraversalKey(
      raw.listingId,
      "origin-priority listingId",
    );
    const originPostalCode = raw.originPostalCode.trim();
    if (!/^\d{5}$/.test(originPostalCode)) {
      throw new Error("Origin-priority postal code must be exactly five digits");
    }
    if (
      !Number.isSafeInteger(raw.radiusMiles) || raw.radiusMiles < 1 ||
      raw.radiusMiles > 1_000
    ) {
      throw new Error("Origin-priority radius must be an integer from 1-1000 miles");
    }
    const observedAt = normalizedTraversalObservedAt(raw.observedAt);
    const contentHash = raw.contentHash.trim();
    if (contentHash.length < 1 || contentHash.length > 256) {
      throw new Error("Origin-priority content hash must contain 1-256 characters");
    }
    const normalized = {
      listingId,
      originPostalCode,
      radiusMiles: raw.radiusMiles,
      observedAt,
      contentHash,
    };
    const existing = entries.get(listingId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw new Error("Origin-priority batch contains conflicting listing evidence");
    }
    entries.set(listingId, normalized);
  }

  let inserted = 0;
  const normalizedEntries = [...entries.values()];
  for (let offset = 0; offset < normalizedEntries.length; offset += 40) {
    const chunk = normalizedEntries.slice(offset, offset + 40);
    const writes = await env.DB.batch(chunk.map((entry) => env.DB.prepare(`
      INSERT INTO source_origin_priority_observations (
        run_id, source_id, listing_id, origin_cache_key,
        origin_postal_code, radius_miles, observed_at, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, listing_id, origin_cache_key) DO NOTHING
    `).bind(
      runId,
      sourceId,
      entry.listingId,
      originCacheKey,
      entry.originPostalCode,
      entry.radiusMiles,
      entry.observedAt,
      entry.contentHash,
    )));
    inserted += writes.reduce(
      (count, write) => count + Math.max(0, write.meta.changes ?? 0),
      0,
    );

    const stored = await env.DB.prepare(`
      SELECT listing_id, origin_postal_code, radius_miles, observed_at, content_hash
      FROM source_origin_priority_observations
      WHERE run_id = ? AND source_id = ? AND origin_cache_key = ?
        AND listing_id IN (${chunk.map(() => "?").join(", ")})
    `).bind(
      runId,
      sourceId,
      originCacheKey,
      ...chunk.map((entry) => entry.listingId),
    ).all<{
      listing_id: string;
      origin_postal_code: string;
      radius_miles: number;
      observed_at: string;
      content_hash: string;
    }>();
    const storedByListing = new Map(
      (stored.results ?? []).map((row) => [row.listing_id, row]),
    );
    for (const entry of chunk) {
      const row = storedByListing.get(entry.listingId);
      if (
        !row || row.origin_postal_code !== entry.originPostalCode ||
        row.radius_miles !== entry.radiusMiles ||
        row.observed_at !== entry.observedAt ||
        row.content_hash !== entry.contentHash
      ) {
        throw new Error("Origin-priority observation conflicts with immutable evidence");
      }
    }
  }
  return inserted;
}
export async function ensurePublishedSourceOriginPriorityObservations(input: {
  runId: string;
  sourceId: string;
  originCacheKey: string;
  entries: readonly {
    listingId: string;
    originPostalCode: string;
    radiusMiles: number;
    observedAt: string;
    contentHash: string;
  }[];
}): Promise<number> {
  const runId = validatedTraversalKey(
    input.runId,
    "published origin-priority runId",
  );
  const sourceId = validatedTraversalKey(
    input.sourceId,
    "published origin-priority sourceId",
  );
  const entriesByListingId = new Map(
    input.entries.map((entry) => [
      validatedTraversalKey(
        entry.listingId,
        "published origin-priority listingId",
      ),
      entry,
    ]),
  );
  const currentListingIds = new Set<string>();
  const candidateIds = [...entriesByListingId.keys()];
  for (let offset = 0; offset < candidateIds.length; offset += 75) {
    const chunk = candidateIds.slice(offset, offset + 75);
    const result = await env.DB.prepare(`
      SELECT listing_id
      FROM source_current_listings
      WHERE source_id = ? AND inventory_run_id = ?
        AND listing_id IN (${chunk.map(() => "?").join(", ")})
    `).bind(sourceId, runId, ...chunk).all<{ listing_id: string }>();
    for (const row of result.results ?? []) currentListingIds.add(row.listing_id);
  }
  return ensureSourceOriginPriorityObservations({
    ...input,
    runId,
    sourceId,
    entries: candidateIds.flatMap((listingId) => {
      if (!currentListingIds.has(listingId)) return [];
      return [entriesByListingId.get(listingId)!];
    }),
  });
}
export async function readPendingNonInlineGeographicPrefilterListings(input: {
  sourceId?: string | null;
  originCacheKey: string;
  routeProviderName: string;
  afterListingId?: string | null;
  limit?: number;
  /** Global proximity reads completed rows so unchanged assignments can skip writes. */
  includeAssigned?: boolean;
  /** A deterministic route-unknown terminal remains eligible if its input changes. */
  includeTerminalRoute?: boolean;
  /** Global finalization also selects rows with no locally resolvable evidence. */
  includeUnresolvedLocationEvidence?: boolean;
  /** The global pass covers configured current review cohorts as well. */
  includeAdhocReviewCohort?: boolean;
}): Promise<PendingNonInlineGeographicPrefilterListing[]> {
  const adhocCohortId = configuredAdhocReviewCohortId() ?? "";
  const limit = input.limit ?? 25_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
    throw new RangeError(
      "geographic prefilter scan limit must be between 1 and 100000",
    );
  }
  if (
    input.afterListingId !== undefined &&
    input.afterListingId !== null &&
    (
      typeof input.afterListingId !== "string" ||
      input.afterListingId.length < 1 ||
      input.afterListingId.length > 500
    )
  ) {
    throw new RangeError("geographic prefilter cursor must be a listing id");
  }
  const result = await env.DB.prepare(`
    SELECT
      s.id,
      s.source_id,
      s.source_listing_id,
      s.source_url,
      s.title,
      s.category,
      s.lot_number,
      s.visible_city,
      s.visible_state,
      s.visible_postal_code,
      s.visible_country_code,
      s.location_evidence_source,
      detail.pickup_city,
      detail.pickup_state,
      detail.pickup_postal_code,
      detail.pickup_country_code,
      detail.pickup_evidence_source,
      EXISTS (
        SELECT 1
        FROM listing_detail_observations current_observation
        WHERE current_observation.listing_id = s.id
          AND detail.listing_id IS NOT NULL
          AND current_observation.detail_content_hash = detail.content_hash
      ) AS has_complete_detail,
      COALESCE(current_recovery.attempt_count, 0) AS route_attempt_count,
      current_route.origin_cache_key AS assigned_origin_cache_key,
      current_route.provider_name AS assigned_provider_name,
      current_route.input_hash AS assigned_input_hash,
      current_destination.cache_key AS assigned_destination_cache_key,
      current_route.error_code AS assigned_route_error_code,
      current_recovery.state AS recovery_state,
      current_recovery.stage AS recovery_stage,
      current_recovery.last_error_code AS recovery_error_code,
      s.thumbnail_url,
      s.discovered_at,
      s.content_hash
    FROM listing_stubs s
    JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = s.id
      AND current_inventory.source_id = s.source_id
      AND current_inventory.review_candidate = 1
    JOIN source_inventory_publication_heads current_head
      ON current_head.source_id = current_inventory.source_id
      AND current_head.inventory_run_id = current_inventory.inventory_run_id
    LEFT JOIN listing_details detail ON detail.listing_id = s.id
    LEFT JOIN listing_routes current_assignment
      ON current_assignment.listing_id = s.id
    LEFT JOIN route_cache current_route
      ON current_route.id = current_assignment.route_cache_id
    LEFT JOIN locations current_destination
      ON current_destination.id = current_route.destination_location_id
    LEFT JOIN listing_recovery_status current_recovery
      ON current_recovery.listing_id = s.id
      AND current_recovery.origin_cache_key = ?
    WHERE (? IS NULL OR s.source_id = ?)
      AND NOT ${listingReviewCompletedSql("s.id")}
      
      
      AND (? IS NULL OR s.id > ?)
      AND (
        ? = 1
        OR s.visible_country_code IS NOT NULL
        OR (
          detail.pickup_country_code IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM listing_detail_observations proximity_observation
            WHERE proximity_observation.listing_id = s.id
              AND proximity_observation.detail_content_hash = detail.content_hash
          )
        )
      )
      AND (
        ? = 1
        OR NOT (${adhocReviewMemberExistsSql({
          listingIdSql: "s.id",
          sourceIdSql: "current_inventory.source_id",
          inventoryRunIdSql: "current_inventory.inventory_run_id",
        })})
      )
      
      
      AND NOT EXISTS (
        SELECT 1
        FROM listing_detail_terminal_status terminal_detail
        WHERE terminal_detail.listing_id = s.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM listing_recovery_status terminal_recovery
        WHERE terminal_recovery.listing_id = s.id
          AND terminal_recovery.origin_cache_key = ?
          AND terminal_recovery.state = 'terminal'
          AND (
            ? = 0
            OR terminal_recovery.stage <> 'route'
          )
      )
      AND (? = 1 OR NOT EXISTS (
        SELECT 1
        FROM listing_routes completed_assignment
        JOIN route_cache completed_route
          ON completed_route.id = completed_assignment.route_cache_id
        WHERE completed_assignment.listing_id = s.id
          AND completed_route.origin_cache_key = ?
          AND completed_route.provider_name = ?
          AND (
            (
              completed_route.error_code IS NULL
              AND completed_route.drive_bucket IN (
                'under_2h', 'under_4h', 'under_8h', 'exclude'
              )
            )
            OR completed_route.error_code = 'unknown_location'
          )
      ))
    ORDER BY s.id
    LIMIT ?
  `).bind(
    input.originCacheKey,
    input.sourceId ?? null,
    input.sourceId ?? null,
    input.afterListingId ?? null,
    input.afterListingId ?? null,
    input.includeUnresolvedLocationEvidence === true ? 1 : 0,
    input.includeAdhocReviewCohort === true ? 1 : 0,
    adhocCohortId,
    input.originCacheKey,
    input.includeTerminalRoute === true ? 1 : 0,
    input.includeAssigned === true ? 1 : 0,
    input.originCacheKey,
    input.routeProviderName,
    limit,
  ).all<{
    id: string;
    source_id: string;
    source_listing_id: string;
    source_url: string;
    title: string;
    category: string | null;
    lot_number: string | null;
    visible_city: string | null;
    visible_state: string | null;
    visible_postal_code: string | null;
    visible_country_code: string | null;
    location_evidence_source: string | null;
    pickup_city: string | null;
    pickup_state: string | null;
    pickup_postal_code: string | null;
    pickup_country_code: string | null;
    pickup_evidence_source: string | null;
    has_complete_detail: number;
    route_attempt_count: number;
    assigned_origin_cache_key: string | null;
    assigned_provider_name: string | null;
    assigned_input_hash: string | null;
    assigned_destination_cache_key: string | null;
    assigned_route_error_code: string | null;
    recovery_state: string | null;
    recovery_stage: string | null;
    recovery_error_code: string | null;
    thumbnail_url: string | null;
    discovered_at: string;
    content_hash: string;
  }>();

  return (result.results ?? []).map((row) => {
    const cardLocation: LocationCandidate | null =
      row.visible_city || row.visible_state || row.visible_postal_code ||
          row.visible_country_code
        ? {
            city: row.visible_city,
            state: row.visible_state,
            postalCode: row.visible_postal_code,
            countryCode: row.visible_country_code || "ZZ",
            evidenceSource: storedLocationEvidenceSource(
              row.location_evidence_source,
            ),
          }
        : null;
    // A detail location is authoritative only when the immutable observation
    // matches the stored detail content. Otherwise the active-head catalog
    // location remains the current proximity input.
    const detailLocation = row.has_complete_detail === 1
      ? storedPickupLocation(row)
      : null;
    return {
      listingId: row.id,
      prefilterLocation: detailLocation ?? cardLocation,
      hasCompleteDetail: row.has_complete_detail === 1,
      routeAttemptCount: row.route_attempt_count,
      assignedOriginCacheKey: row.assigned_origin_cache_key,
      assignedProviderName: row.assigned_provider_name,
      assignedInputHash: row.assigned_input_hash,
      assignedDestinationCacheKey: row.assigned_destination_cache_key,
      assignedRouteErrorCode: row.assigned_route_error_code,
      recoveryState:
        row.recovery_state === "retryable" || row.recovery_state === "terminal"
          ? row.recovery_state
          : null,
      recoveryStage: parseNonInlineRecoveryStage(row.recovery_stage),
      recoveryErrorCode: row.recovery_error_code,
      stub: {
        sourceId: row.source_id,
        sourceListingId: row.source_listing_id,
        sourceUrl: row.source_url,
        title: row.title,
        category: row.category,
        lotNumber: row.lot_number,
        visibleLocation: cardLocation,
        thumbnailUrl: row.thumbnail_url,
        discoveredAt: row.discovered_at,
        contentHash: row.content_hash,
      },
    };
  });
}
export async function readRetryableUnknownRouteRepairListings(input: {
  originCacheKey: string;
  routeProviderName: string;
  limit?: number;
}): Promise<RetryableUnknownRouteRepairListing[]> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError(
      "retryable unknown route repair limit must be between 1 and 50",
    );
  }
  const result = await env.DB.prepare(`
    WITH repair_candidates AS (
      SELECT
        s.id,
        s.source_id,
        s.visible_city,
        s.visible_state,
        s.visible_postal_code,
        s.visible_country_code,
        s.location_evidence_source,
        detail.pickup_city,
        detail.pickup_state,
        detail.pickup_postal_code,
        detail.pickup_country_code,
        detail.pickup_evidence_source,
        recovery.attempt_count,
        recovery.last_attempted_at,
        s.id AS actionable_listing_id
      FROM listing_stubs s
      JOIN source_current_listings current_inventory
        ON current_inventory.listing_id = s.id
        AND current_inventory.source_id = s.source_id
        AND current_inventory.review_candidate = 1
      JOIN source_inventory_publication_heads current_head
        ON current_head.source_id = current_inventory.source_id
        AND current_head.inventory_run_id = current_inventory.inventory_run_id
      JOIN listing_details detail ON detail.listing_id = s.id
      JOIN listing_detail_observations detail_observation
        ON detail_observation.listing_id = s.id
        AND detail_observation.detail_content_hash = detail.content_hash
      JOIN listing_recovery_status recovery
        ON recovery.listing_id = s.id
        AND recovery.origin_cache_key = ?
        AND recovery.state = 'retryable'
        AND recovery.stage = 'route'
        AND recovery.last_error_code = 'unknown_location'
      JOIN listing_routes route_assignment
        ON route_assignment.listing_id = s.id
      JOIN route_cache cached_route
        ON cached_route.id = route_assignment.route_cache_id
        AND cached_route.origin_cache_key = ?
        AND cached_route.provider_name = ?
        AND cached_route.error_code = 'unknown_location'
      WHERE route_assignment.route_cache_id = (
        SELECT latest_assignment.route_cache_id
        FROM listing_routes latest_assignment
        JOIN route_cache latest_route
          ON latest_route.id = latest_assignment.route_cache_id
        WHERE latest_assignment.listing_id = s.id
          AND latest_route.origin_cache_key = ?
          AND latest_route.provider_name = ?
        ORDER BY
          latest_assignment.assigned_at DESC,
          latest_route.calculated_at DESC,
          latest_assignment.route_cache_id DESC
        LIMIT 1
      )
    )
    SELECT *
    FROM repair_candidates
    WHERE actionable_listing_id = id
    ORDER BY last_attempted_at, id
    LIMIT ?
  `).bind(
    input.originCacheKey,
    input.originCacheKey,
    input.routeProviderName,
    input.originCacheKey,
    input.routeProviderName,
    limit,
  ).all<{
    id: string;
    source_id: string;
    visible_city: string | null;
    visible_state: string | null;
    visible_postal_code: string | null;
    visible_country_code: string | null;
    location_evidence_source: string | null;
    pickup_city: string | null;
    pickup_state: string | null;
    pickup_postal_code: string | null;
    pickup_country_code: string | null;
    pickup_evidence_source: string | null;
    attempt_count: number;
    last_attempted_at: string;
  }>();

  return (result.results ?? []).map((row) => {
    const cardLocation: LocationCandidate | null =
      row.visible_city || row.visible_state || row.visible_postal_code ||
          row.visible_country_code
        ? {
            city: row.visible_city,
            state: row.visible_state,
            postalCode: row.visible_postal_code,
            countryCode: row.visible_country_code || "ZZ",
            evidenceSource: storedLocationEvidenceSource(
              row.location_evidence_source,
            ),
          }
        : null;
    const detailLocation = storedPickupLocation(row);
    return {
      listingId: row.id,
      sourceId: row.source_id,
      routeLocation: detailLocation ?? cardLocation,
      recoveryAttemptCount: row.attempt_count,
      recoveryLastAttemptedAt: row.last_attempted_at,
    };
  });
}
export async function readMissingSourceImageEvidenceRepairListings(input: {
  sourceId: string;
  originCacheKey: string;
  routeProviderName: string;
  limit?: number;
}): Promise<PendingNonInlineRecoveryListing[]> {
  const adhocCohortId = configuredAdhocReviewCohortId() ?? "";
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError(
      "missing source-image evidence repair limit must be between 1 and 100",
    );
  }
  const result = await env.DB.prepare(`
    WITH repair_candidates AS (
      SELECT
        s.id,
        s.source_id,
        s.source_listing_id,
        s.source_url,
        s.title,
        s.category,
        s.lot_number,
        s.visible_city,
        s.visible_state,
        s.visible_postal_code,
        s.visible_country_code,
        s.location_evidence_source,
        s.thumbnail_url,
        s.discovered_at,
        s.content_hash,
        s.id AS actionable_listing_id
      FROM listing_stubs s
      JOIN source_current_listings current_inventory
        ON current_inventory.listing_id = s.id
        AND current_inventory.source_id = s.source_id
      JOIN source_inventory_publication_heads current_head
        ON current_head.source_id = current_inventory.source_id
        AND current_head.inventory_run_id = current_inventory.inventory_run_id
      JOIN listing_details detail ON detail.listing_id = s.id
      JOIN listing_detail_observations detail_observation
        ON detail_observation.listing_id = s.id
      WHERE s.source_id = ?
        AND NOT ${listingReviewCompletedSql("s.id")}
        AND NOT EXISTS (
          SELECT 1 FROM listing_images image
          WHERE image.listing_id = s.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM listing_recovery_status proved_image_absence
          WHERE proved_image_absence.listing_id = s.id
            AND proved_image_absence.state = 'terminal'
            AND proved_image_absence.stage = 'image'
            AND proved_image_absence.last_error_code IN (
              'source_image_absent', 'source_image_unavailable'
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM listing_detail_terminal_status terminal_detail
          WHERE terminal_detail.listing_id = s.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM listing_recovery_status terminal_recovery
          WHERE terminal_recovery.listing_id = s.id
            AND terminal_recovery.origin_cache_key = ?
            AND terminal_recovery.state = 'terminal'
        )
    ), routed_candidates AS (
      SELECT
        repair_candidates.*,
        CASE WHEN ${adhocReviewListingMemberExistsSql({
          listingIdSql: "repair_candidates.actionable_listing_id",
          sourceIdSql: "(SELECT source_id FROM listing_stubs WHERE id = repair_candidates.actionable_listing_id)",
        })} THEN 1 ELSE 0 END AS distance_exempt,
        (
          SELECT route_cache.drive_bucket
          FROM listing_routes route_assignment
          JOIN route_cache
            ON route_cache.id = route_assignment.route_cache_id
          WHERE route_assignment.listing_id =
              repair_candidates.actionable_listing_id
            AND route_cache.origin_cache_key = ?
            AND route_cache.provider_name = ?
          ORDER BY
            route_assignment.assigned_at DESC,
            route_cache.calculated_at DESC,
            route_assignment.route_cache_id DESC
          LIMIT 1
        ) AS drive_bucket,
        (
          SELECT route_cache.error_code
          FROM listing_routes route_assignment
          JOIN route_cache
            ON route_cache.id = route_assignment.route_cache_id
          WHERE route_assignment.listing_id =
              repair_candidates.actionable_listing_id
            AND route_cache.origin_cache_key = ?
            AND route_cache.provider_name = ?
          ORDER BY
            route_assignment.assigned_at DESC,
            route_cache.calculated_at DESC,
            route_assignment.route_cache_id DESC
          LIMIT 1
        ) AS route_error_code
      FROM repair_candidates
      WHERE repair_candidates.actionable_listing_id IS NOT NULL
        AND NOT ${listingReviewCompletedSql("repair_candidates.actionable_listing_id")}
        AND EXISTS (
          SELECT 1
          FROM source_current_listings actionable_current
          JOIN source_inventory_publication_heads actionable_head
            ON actionable_head.source_id = actionable_current.source_id
            AND actionable_head.inventory_run_id =
              actionable_current.inventory_run_id
          WHERE actionable_current.listing_id =
              repair_candidates.actionable_listing_id
            AND actionable_current.review_candidate = 1
        )
    )
    SELECT *
    FROM routed_candidates
    WHERE route_error_code IS NULL
      AND drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
      AND EXISTS (
        SELECT 1
        FROM listing_current_pipeline_state pipeline_state
        JOIN listing_routes exact_assignment
          ON exact_assignment.listing_id = routed_candidates.actionable_listing_id
          AND exact_assignment.route_cache_id = pipeline_state.route_cache_identity
        JOIN route_cache exact_route
          ON exact_route.id = exact_assignment.route_cache_id
          AND exact_route.input_hash = pipeline_state.route_input_hash
        WHERE pipeline_state.listing_id = routed_candidates.actionable_listing_id
          AND exact_route.origin_cache_key = ?
          AND exact_route.provider_name = ?
          AND exact_route.error_code IS NULL
          AND exact_route.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
      )
    ORDER BY
      CASE WHEN actionable_listing_id = id THEN 0 ELSE 1 END,
      discovered_at,
      id
    LIMIT ?
  `).bind(
    input.sourceId,
    input.originCacheKey,
    adhocCohortId,
    input.originCacheKey,
    input.routeProviderName,
    input.originCacheKey,
    input.routeProviderName,
    input.originCacheKey,
    input.routeProviderName,
    limit,
  ).all<{
    id: string;
    source_id: string;
    source_listing_id: string;
    source_url: string;
    title: string;
    category: string | null;
    lot_number: string | null;
    visible_city: string | null;
    visible_state: string | null;
    visible_postal_code: string | null;
    visible_country_code: string | null;
    location_evidence_source: string | null;
    thumbnail_url: string | null;
    discovered_at: string;
    content_hash: string;
    actionable_listing_id: string;
    drive_bucket: string | null;
    route_error_code: string | null;
    distance_exempt: number;
  }>();

  const rows = result.results ?? [];
  const exactAccepted = await readExactAcceptedListingIdsForScope({
    listingIds: rows.map((row) => row.actionable_listing_id),
    originCacheKey: input.originCacheKey,
    routeProviderName: input.routeProviderName,
  });
  return rows.filter((row) => exactAccepted.has(row.actionable_listing_id)).map((row) => ({
    listingId: row.id,
    progress: {
      id: row.id,
      hasDetail: true,
      hasDetailObservation: true,
      needsImageIdentityRefresh: true,
      driveBucket: parseStoredDriveBucket(row.drive_bucket),
      distanceExempt: row.distance_exempt === 1,
      routeErrorCode: row.route_error_code,
      primaryImageStatus: null,
      primaryImageErrorCode: null,
      recoveryState: null,
      recoveryLastAttemptedAt: null,
      recoveryErrorCode: null,
    },
    stub: {
      sourceId: row.source_id,
      sourceListingId: row.source_listing_id,
      sourceUrl: row.source_url,
      title: row.title,
      category: row.category,
      lotNumber: row.lot_number,
      visibleLocation: row.visible_city || row.visible_state ||
          row.visible_postal_code || row.visible_country_code
        ? {
            city: row.visible_city,
            state: row.visible_state,
            postalCode: row.visible_postal_code,
            countryCode: row.visible_country_code || "ZZ",
            evidenceSource: storedLocationEvidenceSource(
              row.location_evidence_source,
            ),
          }
        : null,
      thumbnailUrl: row.thumbnail_url,
      discoveredAt: row.discovered_at,
      contentHash: row.content_hash,
    },
  }));
}
export async function readPendingNonInlineRecoveryListings(input: {
  sourceId: string;
  originCacheKey: string;
  routeProviderName: string;
  candidateLimit: number;
  imageLimit: number;
  includeFailedImages: boolean;
  requiresActionDeadline?: boolean;
  excludedListingIds?: readonly string[];
  prioritizeMissingDetailBeforeLimit?: boolean;
  /**
   * Explicit opt-in for listing-detail requests. Browser-captured
   * detail remains immutable; local preparation does not require this opt-in.
   */
  allowListingDetailRequests?: boolean;
  /**
   * Optional request ceiling for callers with a separate detail-request budget.
   * Only a missing detail consumes this budget.
   */
  acquiredBrowserRequestLimit?: number;
  /**
   * A source continuation may retry a failed route once after each fresh
   * inventory observation without selecting a cached negative result again
   * in the same publication drain. Detail transport retries remain eligible
   * for the continuation pressure circuit.
   */
  deferRetryableUntilInventoryRefresh?: boolean;
}): Promise<PendingNonInlineRecoveryListing[]> {
  const adhocCohortId = configuredAdhocReviewCohortId() ?? "";
  const { candidateLimit, imageLimit } = input;
  if (
    !Number.isSafeInteger(candidateLimit) || candidateLimit < 0 ||
    !Number.isSafeInteger(imageLimit) || imageLimit < 0 ||
    candidateLimit + imageLimit <= 0 || candidateLimit + imageLimit > 100
  ) {
    throw new RangeError(
      "non-inline recovery queue limits must total between 1 and 100",
    );
  }
  const acquiredBrowserRequestLimit = input.acquiredBrowserRequestLimit;
  if (
    acquiredBrowserRequestLimit !== undefined &&
    (
      !Number.isSafeInteger(acquiredBrowserRequestLimit) ||
      acquiredBrowserRequestLimit < 0 ||
      acquiredBrowserRequestLimit > 40 ||
      imageLimit !== 0
    )
  ) {
    throw new RangeError(
      "acquired-browser recovery requires a 0-40 browser limit and no image lane",
    );
  }
  // Classify exact route identity before applying quotas. A completed prefix
  // must not hide later pending work, even when the projection is stale.
  const excluded = [...new Set(input.excludedListingIds ?? [])];
  type Row = {
    id: string; source_id: string; source_listing_id: string; source_url: string;
    title: string; category: string | null; lot_number: string | null;
    visible_city: string | null; visible_state: string | null;
    visible_postal_code: string | null; visible_country_code: string | null;
    location_evidence_source: string | null; thumbnail_url: string | null;
    discovered_at: string; content_hash: string; recovery_state: string | null;
    recovery_stage: string | null; recovery_last_attempted_at: string | null;
    recovery_error_code: string | null; inventory_observed_at: string;
    distance_exempt: number; has_detail: number; has_observation: number;
    needs_action_deadline: number; drive_bucket: string | null;
    route_error_code: string | null; primary_image_status: string | null;
    primary_image_error_code: string | null; image_absence_recorded: number;
  };
  const catalogSql = `
    WITH catalog_progress AS (
      SELECT s.*,
        recovery.state AS recovery_state,
        recovery.stage AS recovery_stage,
        recovery.last_attempted_at AS recovery_last_attempted_at,
        recovery.last_error_code AS recovery_error_code,
        current_inventory.observed_at AS inventory_observed_at,
        CASE WHEN s.first_seen_run_id = current_inventory.inventory_run_id
          THEN 1 ELSE 0 END AS current_inventory_new,
        CASE WHEN ${adhocReviewMemberExistsSql({
          listingIdSql: "s.id",
          sourceIdSql: "current_inventory.source_id",
          inventoryRunIdSql: "current_inventory.inventory_run_id",
        })} THEN 1 ELSE 0 END AS distance_exempt,
        EXISTS (
          SELECT 1 FROM source_origin_priority_observations priority
          WHERE priority.listing_id = s.id AND priority.source_id = s.source_id
            AND priority.origin_cache_key = ?
        ) AS origin_priority,
        EXISTS (SELECT 1 FROM listing_details d WHERE d.listing_id = s.id) AS has_detail,
        EXISTS (
          SELECT 1 FROM listing_detail_observations observation
          JOIN listing_details detail ON detail.listing_id = observation.listing_id
            AND detail.content_hash = observation.detail_content_hash
          WHERE observation.listing_id = s.id
        ) AS has_observation,
        ${input.requiresActionDeadline === true ? `CASE WHEN NOT EXISTS (
          SELECT 1 FROM listing_action_deadlines deadline WHERE deadline.listing_id = s.id
        ) THEN 1 ELSE 0 END` : "0"} AS needs_action_deadline,
        route.drive_bucket,
        route.error_code AS route_error_code,
        (SELECT image.download_status FROM listing_images image
          WHERE image.listing_id = s.id AND image.is_primary = 1 LIMIT 1) AS primary_image_status,
        (SELECT image.download_error_code FROM listing_images image
          WHERE image.listing_id = s.id AND image.is_primary = 1 LIMIT 1) AS primary_image_error_code,
        EXISTS (
          SELECT 1 FROM listing_recovery_status absence
          WHERE absence.listing_id = s.id AND absence.state = 'terminal'
            AND absence.stage = 'image'
            AND absence.last_error_code IN ('source_image_absent', 'source_image_unavailable')
        ) AS image_absence_recorded
      FROM listing_stubs s
      JOIN source_current_listings current_inventory
        ON current_inventory.listing_id = s.id AND current_inventory.source_id = s.source_id
      JOIN source_inventory_publication_heads current_head
        ON current_head.source_id = current_inventory.source_id
          AND current_head.inventory_run_id = current_inventory.inventory_run_id
      LEFT JOIN listing_recovery_status recovery
        ON recovery.listing_id = s.id AND recovery.origin_cache_key = ?
      LEFT JOIN listing_routes assignment ON assignment.listing_id = s.id
      LEFT JOIN route_cache route ON route.id = assignment.route_cache_id
      WHERE s.source_id = ? AND current_inventory.review_candidate = 1
        AND NOT ${listingReviewCompletedSql("s.id")}
        AND NOT EXISTS (SELECT 1 FROM listing_detail_terminal_status terminal
          WHERE terminal.listing_id = s.id)
        AND (recovery.state IS NULL OR recovery.state <> 'terminal')
        AND s.id NOT IN (SELECT value FROM json_each(?))
        AND (? = '' OR ${adhocReviewMemberExistsSql({
          listingIdSql: "s.id",
          sourceIdSql: "current_inventory.source_id",
          inventoryRunIdSql: "current_inventory.inventory_run_id",
        })})
    ) SELECT * FROM catalog_progress
  `;
  const bindings = [adhocCohortId, input.originCacheKey, input.originCacheKey,
    input.sourceId, JSON.stringify(excluded), adhocCohortId, adhocCohortId];
  const routeDispositions = new Map<string, ExactCurrentRouteDisposition>();
  const selected = new Set<string>();
  let browserRequests = 0;
  function workKind(row: Row): "candidate" | "image" | null {
    const disposition = routeDispositions.get(row.id) ?? "stale";
    if (disposition === "excluded") return null;
    if (row.has_detail === 0) {
      return input.allowListingDetailRequests === true ? "candidate" : null;
    }
    if (row.has_observation === 0) return "candidate";
    const deferredRoute = input.deferRetryableUntilInventoryRefresh &&
      row.recovery_state === "retryable" && row.recovery_stage === "route" &&
      row.recovery_last_attempted_at !== null &&
      row.recovery_last_attempted_at >= row.inventory_observed_at;
    if (disposition === "stale" || disposition === "other") {
      return deferredRoute ? null : "candidate";
    }
    if (disposition !== "accepted") return null;
    if (row.needs_action_deadline === 1) return "candidate";
    if (row.primary_image_status === "failed") {
      return input.includeFailedImages ? "image" : null;
    }
    if (row.image_absence_recorded === 1 || row.primary_image_status === "downloaded") return null;
    return row.primary_image_status === "pending" || row.primary_image_status === "deferred" ||
      row.primary_image_status === null ? "image" : null;
  }
  const scanSize = EXACT_ROUTE_DISPOSITION_READ_BATCH_SIZE;
  const missingDetailOrder = input.prioritizeMissingDetailBeforeLimit
    ? "CASE WHEN has_detail = 0 OR has_observation = 0 THEN 0 ELSE 1 END,"
    : "";
  async function selectPending(limit: number, order: string, imagesOnly = false): Promise<Row[]> {
    const accepted: Row[] = [];
    for (let offset = 0; accepted.length < limit; offset += scanSize) {
      const result = await env.DB.prepare(`${catalogSql} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .bind(...bindings, scanSize, offset).all<Row>();
      const rows = result.results ?? [];
      const missingRoutes = rows.filter(row => !routeDispositions.has(row.id));
      for (const [id, disposition] of await readExactRouteDispositionsForScope({
        listingIds: missingRoutes.map(row => row.id),
        originCacheKey: input.originCacheKey,
        routeProviderName: input.routeProviderName,
      })) routeDispositions.set(id, disposition);
      for (const row of rows) {
        if (selected.has(row.id)) continue;
        const kind = workKind(row);
        if (kind === null || (imagesOnly && kind !== "image")) continue;
        if (row.has_detail === 0 && acquiredBrowserRequestLimit !== undefined &&
          browserRequests >= acquiredBrowserRequestLimit) continue;
        selected.add(row.id);
        if (row.has_detail === 0) browserRequests += 1;
        accepted.push(row);
        if (accepted.length === limit) break;
      }
      if (rows.length < scanSize) break;
    }
    return accepted;
  }
  const fairnessLimit = candidateLimit >= 5 ? Math.max(1, Math.floor(candidateLimit / 5)) : 0;
  const fair = await selectPending(fairnessLimit, missingDetailOrder + NON_INLINE_RECOVERY_FAIRNESS_ORDER_SQL);
  const priority = await selectPending(candidateLimit - fair.length, missingDetailOrder + NON_INLINE_RECOVERY_ORDER_SQL);
  const images = await selectPending(imageLimit,
    (input.includeFailedImages ? "CASE WHEN primary_image_status = 'failed' THEN 0 ELSE 1 END," : "") + NON_INLINE_RECOVERY_ORDER_SQL, true);
  const eligibleRows = [...priority, ...fair, ...images];
  return eligibleRows.map((row) => {
    const routeDisposition = routeDispositions.get(row.id) ?? "stale";
    const routeIsCurrent = routeDisposition !== "stale";
    return {
      listingId: row.id,
      progress: {
        id: row.id,
        hasDetail: row.has_detail === 1,
        hasDetailObservation: row.has_observation === 1,
        ...(row.needs_action_deadline === 1
          ? { needsActionDeadline: true }
          : {}),
        driveBucket: routeIsCurrent
          ? parseStoredDriveBucket(row.drive_bucket)
          : null,
        distanceExempt: row.distance_exempt === 1,
        ...(routeDisposition === "excluded" ? { distanceExcluded: true } : {}),
        routeErrorCode: routeIsCurrent ? row.route_error_code : null,
        primaryImageStatus: parseStoredPrimaryImageStatus(row.primary_image_status),
        primaryImageErrorCode: row.primary_image_error_code,
        recoveryState:
          row.recovery_state === "retryable" || row.recovery_state === "terminal"
            ? row.recovery_state
            : null,
        recoveryLastAttemptedAt: row.recovery_last_attempted_at,
        recoveryErrorCode: row.recovery_error_code,
      },
      stub: {
        sourceId: row.source_id,
        sourceListingId: row.source_listing_id,
        sourceUrl: row.source_url,
        title: row.title,
        category: row.category,
        lotNumber: row.lot_number,
        visibleLocation: row.visible_city || row.visible_state || row.visible_postal_code
          ? {
              city: row.visible_city,
              state: row.visible_state,
              postalCode: row.visible_postal_code,
              // Legacy/null card country evidence must not turn a numeric foreign
              // postcode into a US ZCTA. `ZZ` is the explicit fail-open marker;
              // current parsers persist a real alpha-2 code when the source does.
              countryCode: row.visible_country_code || "ZZ",
              evidenceSource: storedLocationEvidenceSource(
                row.location_evidence_source,
              ),
            }
          : null,
        thumbnailUrl: row.thumbnail_url,
        discoveredAt: row.discovered_at,
        contentHash: row.content_hash,
      },
    };
  });
}
export async function isListingExactlyDistanceExcluded(input: {
  readonly listingId: string;
  readonly originPostalCode: string;
  readonly originCountryCode: "US";
  readonly originCacheKey: string;
  readonly routeProviderName: string;
}): Promise<boolean> {
  if (
    input.routeProviderName !== LOCAL_PROXIMITY_PROVIDER_NAME ||
    input.originCacheKey !== locationCacheKey({
      postalCode: input.originPostalCode,
      countryCode: input.originCountryCode,
    })
  ) return false;
  const excluded = await readExactCurrentDistanceExclusionListingIds({
    database: env.DB,
    listingIds: [input.listingId],
    originPostalCode: input.originPostalCode,
    originCountryCode: input.originCountryCode,
  });
  return excluded.has(input.listingId);
}
interface ValidatedExtractionAttemptRow {
  id: string;
  subject_id: string;
  input_hash: string;
  output_json: string | null;
  output_hash: string | null;
  generated_at: string;
}
interface ValidatedSemanticAttemptRow {
  id: string;
  subject_id: string;
  input_hash: string;
  output_text: string | null;
  output_json: string | null;
  output_hash: string | null;
  generated_at: string;
}
interface ValidatedEmbeddingAttemptRow {
  id: string;
  subject_id: string;
  input_hash: string;
  dimensions: number;
  generated_at: string;
  vector_valid: number;
}
interface ValidatedEnrichmentHeadRow {
  listing_id: string;
  embedding_vector_hash: string;
  extraction_id: string;
  extraction_input_hash: string;
  extraction_output_json: string;
  extraction_output_hash: string;
  extraction_generated_at: string;
  semantic_id: string;
  semantic_input_hash: string;
  semantic_output_text: string;
  semantic_output_json: string;
  semantic_output_hash: string;
  semantic_generated_at: string;
  embedding_id: string;
  embedding_input_hash: string;
  embedding_dimensions: number;
  embedding_generated_at: string;
}
export interface EnrichmentHeadReadTarget extends EnrichmentProvenanceTarget {
  readonly identity: string;
  readonly embeddingDimensions: number;
}
export async function readValidatedEnrichmentHeadStates(input: {
  listings: readonly EnrichmentChainListingInput[];
  target: EnrichmentHeadReadTarget;
}): Promise<Map<string, ValidatedEnrichmentState>> {
  const expectedDimensions = expectedEmbeddingDimensions(input.target);
  const listingsById = new Map<string, EnrichmentChainListingInput>();
  for (const listing of input.listings) {
    if (!listing.listingId) {
      throw new TypeError("validated enrichment listing id must be non-empty");
    }
    listingsById.set(listing.listingId, listing);
  }
  if (listingsById.size > MAX_VALIDATED_CHAIN_LISTINGS) {
    throw new Error(
      `Validated enrichment inventory exceeds the bounded ${MAX_VALIDATED_CHAIN_LISTINGS}-listing scan`,
    );
  }

  const result = new Map<string, ValidatedEnrichmentState>();
  const readContexts = chunkValues(
    [...listingsById.values()],
    VALIDATED_ENRICHMENT_HEAD_READ_BATCH_SIZE,
  ).map((listingBatch) => {
    const listingById = new Map(
      listingBatch.map((listing) => [listing.listingId, listing] as const),
    );
    const statement = env.DB.prepare(`
      WITH expected_targets AS (
        SELECT
          json_extract(value, '$.listingId') AS listing_id
        FROM json_each(?)
      )
      SELECT
        head.listing_id,
        head.embedding_vector_hash,
        extraction.id AS extraction_id,
        extraction.input_hash AS extraction_input_hash,
        extraction.output_json AS extraction_output_json,
        extraction.output_hash AS extraction_output_hash,
        extraction.generated_at AS extraction_generated_at,
        semantic.id AS semantic_id,
        semantic.input_hash AS semantic_input_hash,
        semantic.output_text AS semantic_output_text,
        semantic.output_json AS semantic_output_json,
        semantic.output_hash AS semantic_output_hash,
        semantic.generated_at AS semantic_generated_at,
        embedding.id AS embedding_id,
        embedding.input_hash AS embedding_input_hash,
        embedding.dimensions AS embedding_dimensions,
        embedding.generated_at AS embedding_generated_at
      FROM expected_targets target
      JOIN listing_current_pipeline_state pipeline
        ON pipeline.listing_id = target.listing_id
        AND pipeline.enrichment_input_hash IS NOT NULL
        AND pipeline.enrichment_head_identity IS NOT NULL
      JOIN listing_enrichment_heads head
        ON head.listing_id = pipeline.listing_id
        AND head.enrichment_input_hash = pipeline.enrichment_input_hash
        AND head.head_identity = pipeline.enrichment_head_identity
      JOIN ai_artifacts extraction
        ON extraction.id = head.extraction_artifact_id
      JOIN ai_artifacts semantic
        ON semantic.id = head.semantic_artifact_id
      JOIN embeddings embedding
        ON embedding.id = head.embedding_id
      WHERE head.state = 'complete'
        AND head.provenance_target_identity = ?
        AND head.derivation_version = ?
        AND extraction.subject_type = 'listing'
        AND extraction.subject_id = head.listing_id
        AND extraction.task = 'listing_extraction'
        AND extraction.provider_name = ?
        AND extraction.model_name = ?
        AND extraction.prompt_version = ?
        AND extraction.output_json IS NOT NULL
        AND extraction.output_hash = head.extraction_output_hash
        AND semantic.subject_type = 'listing'
        AND semantic.subject_id = head.listing_id
        AND semantic.task = 'semantic_document'
        AND semantic.provider_name = ?
        AND semantic.model_name = ?
        AND semantic.prompt_version = ?
        AND semantic.input_hash = extraction.input_hash
        AND semantic.output_text IS NOT NULL
        AND semantic.output_json = json_object(
          'extractionOutputHash', extraction.output_hash
        )
        AND semantic.output_hash = head.semantic_output_hash
        AND embedding.subject_type = 'listing'
        AND embedding.subject_id = head.listing_id
        AND embedding.kind = 'listing_semantic_document'
        AND embedding.provider_name = ?
        AND embedding.model_name = ?
        AND embedding.input_hash = semantic.output_hash
        AND embedding.input_hash = head.embedding_input_hash
        AND embedding.dimensions = ?
        AND head.embedding_vector_hash IS NOT NULL
      ORDER BY head.listing_id
    `).bind(
      JSON.stringify(listingBatch.map((listing) => ({
        listingId: listing.listingId,
      }))),
      input.target.identity,
      ENRICHMENT_HEAD_DERIVATION_VERSION,
      input.target.textProviderName,
      input.target.textModelName,
      input.target.extractionPromptVersion,
      input.target.textProviderName,
      input.target.textModelName,
      input.target.semanticDocumentVersion,
      input.target.embeddingProviderName,
      input.target.embeddingModelName,
      expectedDimensions,
    );
    return { listingById, statement };
  });
  const readResults = readContexts.length === 0
    ? []
    : await env.DB.batch<ValidatedEnrichmentHeadRow>(
      readContexts.map((context) => context.statement),
    );
  if (readResults.length !== readContexts.length) {
    throw new Error("Validated enrichment head batch returned incomplete result groups");
  }

  for (let index = 0; index < readContexts.length; index += 1) {
    const listingById = readContexts[index]!.listingById;
    for (const row of readResults[index]!.results ?? []) {
      const listing = listingById.get(row.listing_id);
      const expectedInputHash = row.extraction_input_hash;
      if (
        !listing ||
        !/^[0-9a-f]{64}$/u.test(expectedInputHash) ||
        !/^[0-9a-f]{64}$/u.test(row.embedding_vector_hash)
      ) continue;
      const extraction = await validateExtractionAttempt({
        id: row.extraction_id,
        subject_id: row.listing_id,
        input_hash: row.extraction_input_hash,
        output_json: row.extraction_output_json,
        output_hash: row.extraction_output_hash,
        generated_at: row.extraction_generated_at,
      }, expectedInputHash, listing.detail);
      if (!extraction) continue;
      const semantic = await validateSemanticAttempt({
        id: row.semantic_id,
        subject_id: row.listing_id,
        input_hash: row.semantic_input_hash,
        output_text: row.semantic_output_text,
        output_json: row.semantic_output_json,
        output_hash: row.semantic_output_hash,
        generated_at: row.semantic_generated_at,
      }, expectedInputHash, extraction.outputHash);
      if (!semantic) continue;
      result.set(row.listing_id, {
        listingId: row.listing_id,
        expectedExtractionInputHash: expectedInputHash,
        validExtraction: extraction,
        completeChain: {
          listingId: row.listing_id,
          extractionArtifactId: extraction.artifactId,
          extractionInputHash: extraction.inputHash,
          extractionOutputJson: extraction.outputJson,
          extractionOutputHash: extraction.outputHash,
          extractionGeneratedAt: extraction.generatedAt,
          semanticArtifactId: semantic.artifactId,
          semanticOutputHash: semantic.outputHash,
          semanticGeneratedAt: semantic.generatedAt,
          embeddingId: row.embedding_id,
          embeddingDimensions: row.embedding_dimensions,
          embeddingGeneratedAt: row.embedding_generated_at,
          chainGeneratedAt: latestIsoTimestamp(
            extraction.generatedAt,
            semantic.generatedAt,
            row.embedding_generated_at,
          ),
          vector: null,
        },
      });
    }
  }
  return result;
}
export async function readValidatedEnrichmentStates(input: {
  listings: readonly EnrichmentChainListingInput[];
  target: EnrichmentProvenanceTarget;
  includeVectors?: boolean;
}): Promise<Map<string, ValidatedEnrichmentState>> {
  const expectedDimensions = expectedEmbeddingDimensions(input.target);
  const listingsById = new Map<string, EnrichmentChainListingInput>();
  for (const listing of input.listings) {
    if (!listing.listingId) throw new TypeError("validated enrichment listing id must be non-empty");
    listingsById.set(listing.listingId, listing);
  }
  if (listingsById.size > MAX_VALIDATED_CHAIN_LISTINGS) {
    throw new Error(
      `Validated enrichment inventory exceeds the bounded ${MAX_VALIDATED_CHAIN_LISTINGS}-listing scan`,
    );
  }

  const result = new Map<string, ValidatedEnrichmentState>();
  for (const listingBatch of chunkValues(
    [...listingsById.values()],
    VALIDATED_CHAIN_READ_BATCH_SIZE,
  )) {
    const expectedInputHashes = new Map<string, string>();
    await Promise.all(listingBatch.map(async (listing) => {
      expectedInputHashes.set(
        listing.listingId,
        (await listingExtractionInput(listing.detail)).inputHash,
      );
    }));

    const extractionResult = await env.DB.prepare(`
      WITH expected_targets AS (
        SELECT
          json_extract(value, '$.listingId') AS subject_id,
          json_extract(value, '$.inputHash') AS input_hash
        FROM json_each(?)
      ), ranked AS (
        SELECT
          artifact.id,
          artifact.subject_id,
          artifact.input_hash,
          artifact.output_json,
          artifact.output_hash,
          artifact.generated_at,
          ROW_NUMBER() OVER (
            PARTITION BY artifact.subject_id, artifact.input_hash
            ORDER BY artifact.generated_at DESC, artifact.id DESC
          ) AS attempt_ordinal
        FROM ai_artifacts artifact
        JOIN expected_targets target
          ON target.subject_id = artifact.subject_id
          AND target.input_hash = artifact.input_hash
        WHERE artifact.subject_type = 'listing'
          AND artifact.task = 'listing_extraction'
          AND artifact.provider_name = ?
          AND artifact.model_name = ?
          AND artifact.prompt_version = ?
      )
      SELECT id, subject_id, input_hash, output_json, output_hash, generated_at
      FROM ranked
      WHERE attempt_ordinal <= ${MAX_AI_PROVENANCE_RETRY_READ}
      ORDER BY subject_id, attempt_ordinal
    `).bind(
      JSON.stringify(listingBatch.map((listing) => ({
        listingId: listing.listingId,
        inputHash: expectedInputHashes.get(listing.listingId),
      }))),
      input.target.textProviderName,
      input.target.textModelName,
      input.target.extractionPromptVersion,
    ).all<ValidatedExtractionAttemptRow>();

    const extractionRows = rowsByListing(extractionResult.results ?? []);
    const validExtractionsByListing = new Map<string, Array<{
      artifactId: string;
      inputHash: string;
      outputJson: string;
      outputHash: string;
      generatedAt: string;
    }>>();
    for (const listing of listingBatch) {
      const expectedInputHash = expectedInputHashes.get(listing.listingId)!;
      const validExtractions = [];
      for (const row of extractionRows.get(listing.listingId) ?? []) {
        const valid = await validateExtractionAttempt(row, expectedInputHash, listing.detail);
        if (valid) validExtractions.push(valid);
      }
      validExtractionsByListing.set(listing.listingId, validExtractions);
    }

    const semanticTargets = uniqueObjectsByKey(
      listingBatch.flatMap((listing) =>
        (validExtractionsByListing.get(listing.listingId) ?? []).map((extraction) => ({
          listingId: listing.listingId,
          inputHash: extraction.inputHash,
          extractionOutputHash: extraction.outputHash,
          metadataJson: JSON.stringify({ extractionOutputHash: extraction.outputHash }),
        }))
      ),
      (target) => `${target.listingId}\u0000${target.extractionOutputHash}`,
    );
    const semanticResult = semanticTargets.length === 0 ? null : await env.DB.prepare(`
      WITH expected_targets AS (
        SELECT
          json_extract(value, '$.listingId') AS subject_id,
          json_extract(value, '$.inputHash') AS input_hash,
          json_extract(value, '$.metadataJson') AS metadata_json
        FROM json_each(?)
      ), ranked AS (
        SELECT
          artifact.id,
          artifact.subject_id,
          artifact.input_hash,
          artifact.output_text,
          artifact.output_json,
          artifact.output_hash,
          artifact.generated_at,
          ROW_NUMBER() OVER (
            PARTITION BY artifact.subject_id, artifact.input_hash, artifact.output_json
            ORDER BY artifact.generated_at DESC, artifact.id DESC
          ) AS attempt_ordinal
        FROM ai_artifacts artifact
        JOIN expected_targets target
          ON target.subject_id = artifact.subject_id
          AND target.input_hash = artifact.input_hash
          AND target.metadata_json = artifact.output_json
        WHERE artifact.subject_type = 'listing'
          AND artifact.task = 'semantic_document'
          AND artifact.provider_name = ?
          AND artifact.model_name = ?
          AND artifact.prompt_version = ?
      )
      SELECT
        id, subject_id, input_hash, output_text, output_json, output_hash,
        generated_at
      FROM ranked
      WHERE attempt_ordinal <= ${MAX_AI_PROVENANCE_RETRY_READ}
      ORDER BY subject_id, output_json, attempt_ordinal
    `).bind(
      JSON.stringify(semanticTargets),
      input.target.textProviderName,
      input.target.textModelName,
      input.target.semanticDocumentVersion,
    ).all<ValidatedSemanticAttemptRow>();
    const semanticRows = rowsByListing(semanticResult?.results ?? []);
    const validSemanticsByListing = new Map<string, Array<{
      extractionOutputHash: string;
      artifactId: string;
      outputHash: string;
      generatedAt: string;
    }>>();
    for (const listing of listingBatch) {
      const expectedInputHash = expectedInputHashes.get(listing.listingId)!;
      const validSemantics: Array<{
        extractionOutputHash: string;
        artifactId: string;
        outputHash: string;
        generatedAt: string;
      }> = [];
      for (const extraction of validExtractionsByListing.get(listing.listingId) ?? []) {
        for (const row of semanticRows.get(listing.listingId) ?? []) {
          const valid = await validateSemanticAttempt(
            row,
            expectedInputHash,
            extraction.outputHash,
          );
          if (valid) validSemantics.push({
            extractionOutputHash: extraction.outputHash,
            ...valid,
          });
        }
      }
      validSemanticsByListing.set(listing.listingId, validSemantics);
    }

    const embeddingTargets = uniqueObjectsByKey(
      listingBatch.flatMap((listing) =>
        (validSemanticsByListing.get(listing.listingId) ?? []).map((semantic) => ({
          listingId: listing.listingId,
          semanticOutputHash: semantic.outputHash,
        }))
      ),
      (target) => `${target.listingId}\u0000${target.semanticOutputHash}`,
    );
    const embeddingResult = embeddingTargets.length === 0 ? null : await env.DB.prepare(`
      WITH expected_targets AS (
        SELECT
          json_extract(value, '$.listingId') AS subject_id,
          json_extract(value, '$.semanticOutputHash') AS input_hash
        FROM json_each(?)
      ), ranked AS (
        SELECT
          embedding.id,
          embedding.subject_id,
          embedding.input_hash,
          embedding.dimensions,
          embedding.vector_json,
          embedding.generated_at,
          ROW_NUMBER() OVER (
            PARTITION BY embedding.subject_id, embedding.input_hash
            ORDER BY embedding.generated_at DESC, embedding.id DESC
          ) AS attempt_ordinal
        FROM embeddings embedding
        JOIN expected_targets target
          ON target.subject_id = embedding.subject_id
          AND target.input_hash = embedding.input_hash
        WHERE embedding.subject_type = 'listing'
          AND embedding.kind = 'listing_semantic_document'
          AND embedding.provider_name = ?
          AND embedding.model_name = ?
          AND embedding.dimensions = ?
      )
      SELECT
        id, subject_id, input_hash, dimensions, generated_at,
        CASE WHEN json_valid(vector_json) THEN
          CASE WHEN json_type(vector_json) = 'array'
            AND json_array_length(vector_json) = dimensions
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(vector_json) vector_value
              WHERE vector_value.type NOT IN ('integer', 'real')
                OR NOT (
                  ABS(CAST(vector_value.value AS REAL)) <= 1.7976931348623157e308
                )
            )
          THEN 1 ELSE 0 END
        ELSE 0 END AS vector_valid
      FROM ranked
      WHERE attempt_ordinal <= ${MAX_AI_PROVENANCE_RETRY_READ}
      ORDER BY subject_id, input_hash, attempt_ordinal
    `).bind(
      JSON.stringify(embeddingTargets),
      input.target.embeddingProviderName,
      input.target.embeddingModelName,
      expectedDimensions,
    ).all<ValidatedEmbeddingAttemptRow>();
    const embeddingRows = rowsByListing(embeddingResult?.results ?? []);
    const selectedEmbeddingIds: string[] = [];

    for (const listing of listingBatch) {
      const expectedInputHash = expectedInputHashes.get(listing.listingId)!;
      const validExtractions = validExtractionsByListing.get(listing.listingId) ?? [];

      let completeChain: ValidEnrichmentChain | null = null;
      for (const extraction of validExtractions) {
        for (const semantic of validSemanticsByListing.get(listing.listingId) ?? []) {
          if (semantic.extractionOutputHash !== extraction.outputHash) continue;
          const embedding = (embeddingRows.get(listing.listingId) ?? []).find((candidate) =>
            candidate.input_hash === semantic.outputHash && candidate.vector_valid === 1
          );
          if (!embedding) continue;
          completeChain = {
            listingId: listing.listingId,
            extractionArtifactId: extraction.artifactId,
            extractionInputHash: extraction.inputHash,
            extractionOutputJson: extraction.outputJson,
            extractionOutputHash: extraction.outputHash,
            extractionGeneratedAt: extraction.generatedAt,
            semanticArtifactId: semantic.artifactId,
            semanticOutputHash: semantic.outputHash,
            semanticGeneratedAt: semantic.generatedAt,
            embeddingId: embedding.id,
            embeddingDimensions: embedding.dimensions,
            embeddingGeneratedAt: embedding.generated_at,
            chainGeneratedAt: latestIsoTimestamp(
              extraction.generatedAt,
              semantic.generatedAt,
              embedding.generated_at,
            ),
            vector: null,
          };
          selectedEmbeddingIds.push(embedding.id);
          break;
        }
        if (completeChain) break;
      }
      result.set(listing.listingId, {
        listingId: listing.listingId,
        expectedExtractionInputHash: expectedInputHash,
        validExtraction: validExtractions[0] ?? null,
        completeChain,
      });
    }

    if (input.includeVectors && selectedEmbeddingIds.length > 0) {
      const vectorRows: Array<{
        id: string;
        dimensions: number;
        vector_json: string;
      }> = [];
      for (
        const vectorBatch of chunkValues(
          selectedEmbeddingIds,
          VALIDATED_VECTOR_READ_BATCH_SIZE,
        )
      ) {
        const vectorResult = await env.DB.prepare(`
          SELECT id, dimensions, vector_json
          FROM embeddings
          WHERE id IN (${vectorBatch.map(() => "?").join(", ")})
        `).bind(...vectorBatch).all<{
          id: string;
          dimensions: number;
          vector_json: string;
        }>();
        vectorRows.push(...(vectorResult.results ?? []));
      }
      const vectors = new Map<string, number[]>();
      for (const row of vectorRows) {
        const vector = parseFiniteVector(row.vector_json, expectedDimensions);
        if (vector) vectors.set(row.id, vector);
      }
      for (const listing of listingBatch) {
        const state = result.get(listing.listingId);
        if (!state?.completeChain) continue;
        const vector = vectors.get(state.completeChain.embeddingId);
        if (vector) state.completeChain.vector = vector;
        else state.completeChain = null;
      }
    }
  }
  return result;
}
export async function readValidatedListingRatings(input: {
  listingIds: readonly string[];
  profileVersionId: string;
  embeddingDimensions: number;
  minimumScoredAtByListing?: ReadonlyMap<string, string>;
  semanticOutputHashByListing: ReadonlyMap<string, string>;
}): Promise<Map<string, ValidListingRating>> {
  if (!Number.isSafeInteger(input.embeddingDimensions) || input.embeddingDimensions <= 0) {
    throw new TypeError("rating embedding dimensions must be a positive safe integer");
  }
  const listingIds = [...new Set(input.listingIds.filter(Boolean))];
  if (listingIds.length > MAX_VALIDATED_CHAIN_LISTINGS) {
    throw new Error(
      `Validated rating inventory exceeds the bounded ${MAX_VALIDATED_CHAIN_LISTINGS}-listing scan`,
    );
  }
  const ratings = new Map<string, ValidListingRating>();
  const profileVersion = await env.DB.prepare(`
    SELECT
      algorithm_version,
      interested_support_count,
      not_interested_support_count
    FROM profile_versions
    WHERE id = ?
  `).bind(input.profileVersionId).first<{
    algorithm_version: string;
    interested_support_count: number;
    not_interested_support_count: number;
  }>();
  if (!profileVersion?.algorithm_version) return ratings;
  const profileInputResult = await env.DB.prepare(`
    SELECT kind, input_hash, dimensions, vector_json
    FROM embeddings
    WHERE subject_type = 'profile_version'
      AND subject_id = ?
      AND kind IN ('profile_positive_centroid', 'profile_negative_centroid')
      AND provider_name = 'profile'
      AND model_name = ?
  `).bind(
    input.profileVersionId,
    profileVersion.algorithm_version,
  ).all<{
    kind: "profile_positive_centroid" | "profile_negative_centroid";
    input_hash: string;
    dimensions: number;
    vector_json: string;
  }>();
  const profileInputRows = profileInputResult.results ?? [];
  const profileInputHashes = new Set(profileInputRows.map((row) => row.input_hash));
  const expectedProfileKinds = new Set<
    "profile_positive_centroid" | "profile_negative_centroid"
  >();
  if (
    profileVersion.interested_support_count > 0 ||
    profileVersion.not_interested_support_count < 3
  ) expectedProfileKinds.add("profile_positive_centroid");
  if (profileVersion.not_interested_support_count >= 3) {
    expectedProfileKinds.add("profile_negative_centroid");
  }
  const profileKinds = new Set(profileInputRows.map((row) => row.kind));
  if (
    profileInputRows.length !== expectedProfileKinds.size ||
    profileKinds.size !== expectedProfileKinds.size ||
    [...expectedProfileKinds].some((kind) => !profileKinds.has(kind)) ||
    profileInputHashes.size !== 1 ||
    profileInputRows.some((row) =>
      row.dimensions !== input.embeddingDimensions ||
      !parseFiniteVector(row.vector_json, input.embeddingDimensions)
    )
  ) return ratings;
  const profileInputHash = profileInputRows[0]!.input_hash;
  const manifestResult = await env.DB.prepare(`
    SELECT input_hash, output_json, output_hash
    FROM ai_artifacts
    WHERE subject_type = 'profile_version'
      AND subject_id = ?
      AND task = 'profile_summary'
      AND provider_name = 'profile'
      AND model_name = ?
      AND prompt_version = ?
  `).bind(
    input.profileVersionId,
    profileVersion.algorithm_version,
    PROFILE_CONSTRAINT_MANIFEST_PROMPT_VERSION,
  ).all<{
    input_hash: string;
    output_json: string | null;
    output_hash: string | null;
  }>();
  const manifestRows = manifestResult.results ?? [];
  if (manifestRows.length !== 1) return ratings;
  const manifest = manifestRows[0]!;
  if (
    manifest.input_hash !== profileInputHash ||
    !manifest.output_json ||
    !manifest.output_hash ||
    await sha256Text(manifest.output_json) !== manifest.output_hash ||
    !isProfileConstraintManifest(manifest.output_json)
  ) return ratings;
  for (const batch of chunkValues(listingIds, VALIDATED_RATING_READ_BATCH_SIZE)) {
    const rows = await env.DB.prepare(`
      SELECT
        score.listing_id,
        score.profile_version_id,
        score.score,
        score.exploration_weight,
        score.explanation_artifact_id,
        score.scored_at,
        explanation.subject_type AS explanation_subject_type,
        explanation.subject_id AS explanation_subject_id,
        explanation.task AS explanation_task,
        explanation.provider_name AS explanation_provider_name,
        explanation.model_name AS explanation_model_name,
        explanation.prompt_version AS explanation_prompt_version,
        explanation.input_hash AS explanation_input_hash,
        explanation.output_text AS explanation_output_text,
        explanation.output_hash AS explanation_output_hash
      FROM listing_scores score
      LEFT JOIN ai_artifacts explanation
        ON explanation.id = score.explanation_artifact_id
      WHERE score.profile_version_id = ?
        AND score.listing_id IN (${batch.map(() => "?").join(", ")})
    `).bind(input.profileVersionId, ...batch).all<{
      listing_id: string;
      profile_version_id: string;
      score: number;
      exploration_weight: number;
      explanation_artifact_id: string | null;
      scored_at: string;
      explanation_subject_type: string | null;
      explanation_subject_id: string | null;
      explanation_task: string | null;
      explanation_provider_name: string | null;
      explanation_model_name: string | null;
      explanation_prompt_version: string | null;
      explanation_input_hash: string | null;
      explanation_output_text: string | null;
      explanation_output_hash: string | null;
    }>();
    for (const row of rows.results ?? []) {
      const semanticOutputHash = input.semanticOutputHashByListing.get(row.listing_id);
      const expectedExplanationInputHash = semanticOutputHash
        ? await sha256Text(`${profileInputHash}:${row.listing_id}:${semanticOutputHash}`)
        : null;
      if (
        typeof row.score !== "number" || !Number.isFinite(row.score) ||
        row.score < 0 || row.score > 100 ||
        typeof row.exploration_weight !== "number" ||
        !Number.isFinite(row.exploration_weight) ||
        row.exploration_weight < 0 || row.exploration_weight > 1 ||
        !row.explanation_artifact_id ||
        row.explanation_subject_type !== "listing" ||
        row.explanation_subject_id !== row.listing_id ||
        row.explanation_task !== "recommendation_explanation" ||
        row.explanation_provider_name !== "profile" ||
        row.explanation_model_name !== profileVersion.algorithm_version ||
        row.explanation_prompt_version !== "recommendation-explanation-v6" ||
        !expectedExplanationInputHash ||
        row.explanation_input_hash !== expectedExplanationInputHash ||
        typeof row.explanation_output_text !== "string" ||
        row.explanation_output_text.length === 0 ||
        row.explanation_output_text.trim() !== row.explanation_output_text ||
        typeof row.explanation_output_hash !== "string" ||
        row.scored_at < (input.minimumScoredAtByListing?.get(row.listing_id) ?? "") ||
        await sha256Text(row.explanation_output_text) !== row.explanation_output_hash
      ) continue;
      ratings.set(row.listing_id, {
        listingId: row.listing_id,
        profileVersionId: row.profile_version_id,
        score: row.score,
        explorationWeight: row.exploration_weight,
        explanationArtifactId: row.explanation_artifact_id,
        explanation: row.explanation_output_text,
        scoredAt: row.scored_at,
      });
    }
  }
  return ratings;
}
function isProfileConstraintManifest(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const validSide = (side: unknown) => {
      if (!side || typeof side !== "object" || Array.isArray(side)) return false;
      const record = side as Record<string, unknown>;
      const lists = ["requested", "applied", "skipped"].map((key) => record[key]);
      if (!lists.every((list) =>
        Array.isArray(list) &&
        (list as unknown[]).every((entry) =>
          typeof entry === "string" && entry.length > 0 && entry.trim() === entry
        ) &&
        (list as string[]).every((entry, index, entries) =>
          index === 0 || entries[index - 1]! < entry
        )
      )) return false;
      const [requested, applied, skipped] = lists as string[][];
      const classified = [...applied, ...skipped].sort();
      return requested.length === classified.length &&
        requested.every((entry, index) => entry === classified[index]) &&
        typeof record.basisHash === "string" &&
        /^[a-f0-9]{64}$/u.test(record.basisHash);
    };
    return JSON.stringify(parsed) === value &&
      parsed.version === PROFILE_SIGNAL_RESIDUAL_VERSION &&
      validSide(parsed.positive) && validSide(parsed.negative);
  } catch {
    return false;
  }
}
export async function readPendingEnrichmentQueue(input: {
  originCacheKey: string;
  routeProviderName: string;
  target: EnrichmentProvenanceTarget;
  limit: number;
}): Promise<PendingEnrichmentQueue> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
    throw new RangeError("enrichment queue limit must be a positive integer");
  }

  const oversizedCohort = oversizedAcceptedReviewCohorts(
    await readCurrentAcceptedReviewCohortCounts(input),
  )[0];
  if (oversizedCohort) {
    throw new Error(acceptedReviewCohortLimitMessage(oversizedCohort));
  }

  interface PendingRow {
    id: string;
    source_id: string;
    source_listing_id: string;
    source_url: string;
    discovered_at: string;
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
    vote_value: string | null;
  }

  const result = await env.DB.prepare(`
    WITH target (origin_cache_key, route_provider)
      AS (VALUES (?, ?))
    SELECT
      s.id,
      s.source_id,
      s.source_listing_id,
      s.source_url,
      s.discovered_at,
      COALESCE(observation.title, d.title_at_scrape) AS title_at_scrape,
      d.category_at_scrape,
      d.lot_number_at_scrape,
      d.raw_description,
      d.clean_description,
      d.price_amount_minor,
      d.price_currency,
      d.price_display_text,
      ${EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL} AS auction_ends_at,
      d.seller,
      d.pickup_city,
      d.pickup_state,
      d.pickup_postal_code,
      d.pickup_country_code,
      d.pickup_evidence_source,
      d.scraped_at,
      d.content_hash,
      v.value AS vote_value
    FROM listing_stubs s
    LEFT JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = s.id
      AND current_inventory.source_id = s.source_id
    JOIN listing_details d ON d.listing_id = s.id
    LEFT JOIN listing_detail_observations observation
      ON observation.listing_id = s.id
    LEFT JOIN listing_votes v ON v.listing_id = s.id
    CROSS JOIN target
    WHERE NOT ${listingReviewCompletedSql("s.id")}
    AND current_inventory.listing_id IS NOT NULL
    AND current_inventory.review_candidate = 1
    AND EXISTS (
      SELECT 1
      FROM listing_current_pipeline_state pipeline_state
      JOIN listing_routes lr
        ON lr.listing_id = s.id
        AND lr.route_cache_id = pipeline_state.route_cache_identity
      JOIN route_cache rc
        ON rc.id = lr.route_cache_id
        AND rc.input_hash = pipeline_state.route_input_hash
      WHERE pipeline_state.listing_id = s.id
        AND rc.origin_cache_key = target.origin_cache_key
        AND rc.provider_name = target.route_provider
        AND rc.error_code IS NULL
        AND rc.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
    )
    LIMIT ?
  `).bind(
    input.originCacheKey,
    input.routeProviderName,
    MAX_ENRICHMENT_QUEUE_SCAN + 1,
  ).all<PendingRow>();

  const rows = result.results ?? [];
  if (rows.length > MAX_ENRICHMENT_QUEUE_SCAN) {
    throw new Error(
      `Enrichment inventory exceeds the bounded ${MAX_ENRICHMENT_QUEUE_SCAN}-listing scan`,
    );
  }

  const exactAccepted = await readExactAcceptedListingIdsForScope({
    listingIds: rows.map((row) => row.id),
    originCacheKey: input.originCacheKey,
    routeProviderName: input.routeProviderName,
  });
  const preparedRows = rows.filter((row) => exactAccepted.has(row.id)).map((row) => ({
    row,
    detail: {
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
      pickupLocation: storedPickupLocation(row),
      images: [],
      scrapedAt: row.scraped_at,
      contentHash: row.content_hash,
    } satisfies NormalizedListingDetail,
  }));
  const states = await readValidatedEnrichmentStates({
    listings: preparedRows.map(({ row, detail }) => ({
      listingId: row.id,
      detail,
    })),
    target: input.target,
  });
  const pending: Array<{
    listingId: string;
    detail: NormalizedListingDetail;
    needsTextGeneration: boolean;
    voteValue: string | null;
    discoveredAt: string;
  }> = [];
  for (const { row, detail } of preparedRows) {
    const state = states.get(row.id);
    if (state?.completeChain) continue;
    pending.push({
      listingId: row.id,
      detail,
      needsTextGeneration: !state?.validExtraction,
      voteValue: row.vote_value,
      discoveredAt: row.discovered_at,
    });
  }

  pending.sort((left, right) =>
    Number(left.needsTextGeneration) - Number(right.needsTextGeneration) ||
    enrichmentVotePriority(left.voteValue) - enrichmentVotePriority(right.voteValue) ||
    left.discoveredAt.localeCompare(right.discoveredAt) ||
    left.listingId.localeCompare(right.listingId)
  );
  return {
    pendingAtStart: pending.length,
    candidates: pending.slice(0, input.limit).map((entry) => ({
      listingId: entry.listingId,
      detail: entry.detail,
      needsTextGeneration: entry.needsTextGeneration,
    })),
  };
}
async function validateExtractionAttempt(
  artifact: ValidatedExtractionAttemptRow,
  expectedInputHash: string,
  detail: NormalizedListingDetail,
): Promise<{
  artifactId: string;
  inputHash: string;
  outputJson: string;
  outputHash: string;
  generatedAt: string;
} | null> {
  if (
    artifact.input_hash !== expectedInputHash ||
    typeof artifact.output_json !== "string" ||
    typeof artifact.output_hash !== "string"
  ) return null;
  try {
    if (await sha256Text(artifact.output_json) !== artifact.output_hash) return null;
    const extraction = validateTextExtraction(JSON.parse(artifact.output_json), {
      title: detail.title,
      sourceText: detail.cleanDescription,
      marketplacePolicyCleanupApplied: marketplacePolicyCleanupApplied(detail),
    });
    if (await sha256Text(JSON.stringify(extraction)) !== artifact.output_hash) return null;
    return {
      artifactId: artifact.id,
      inputHash: artifact.input_hash,
      outputJson: artifact.output_json,
      outputHash: artifact.output_hash,
      generatedAt: artifact.generated_at,
    };
  } catch {
    // Invalid immutable attempts remain auditable; continue to an older row.
    return null;
  }
}
async function validateSemanticAttempt(
  artifact: ValidatedSemanticAttemptRow,
  expectedInputHash: string,
  extractionOutputHash: string,
): Promise<{
  artifactId: string;
  outputHash: string;
  generatedAt: string;
} | null> {
  if (
    artifact.input_hash !== expectedInputHash ||
    typeof artifact.output_text !== "string" ||
    typeof artifact.output_json !== "string" ||
    typeof artifact.output_hash !== "string" ||
    artifact.output_text.trim() !== artifact.output_text ||
    artifact.output_text.length === 0
  ) return null;
  try {
    const metadata = JSON.parse(artifact.output_json) as Record<string, unknown>;
    if (metadata.extractionOutputHash !== extractionOutputHash) return null;
    if (JSON.stringify({ extractionOutputHash }) !== artifact.output_json) return null;
    if (await sha256Text(artifact.output_text) !== artifact.output_hash) return null;
    return {
      artifactId: artifact.id,
      outputHash: artifact.output_hash,
      generatedAt: artifact.generated_at,
    };
  } catch {
    // Invalid immutable attempts remain auditable; continue to an older row.
    return null;
  }
}
function rowsByListing<T extends { subject_id: string }>(
  rows: readonly T[],
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const listingRows = result.get(row.subject_id) ?? [];
    listingRows.push(row);
    result.set(row.subject_id, listingRows);
  }
  return result;
}
function uniqueObjectsByKey<T>(
  values: readonly T[],
  keyFor: (value: T) => string,
): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyFor(value);
    if (!result.has(key)) result.set(key, value);
  }
  return [...result.values()];
}
function parseFiniteVector(value: string, dimensions: number): number[] | null {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.length === dimensions &&
        parsed.every((entry) => typeof entry === "number" && Number.isFinite(entry))
      ? parsed as number[]
      : null;
  } catch {
    return null;
  }
}
function latestIsoTimestamp(...timestamps: string[]): string {
  return timestamps.reduce((latest, current) => current > latest ? current : latest);
}
function enrichmentVotePriority(value: string | null): number {
  if (value === "interested") return 0;
  if (value === "not_interested") return 1;
  return 2;
}
function storedPickupLocation(row: {
  source_id: string;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_postal_code: string | null;
  pickup_country_code: string | null;
  pickup_evidence_source: string | null;
}): NormalizedListingDetail["pickupLocation"] {
  if (!row.pickup_city && !row.pickup_state && !row.pickup_postal_code) return null;
  const storedCountryCode = row.pickup_country_code || "US";
  const countryCode = storedCountryCode;
  return {
    city: row.pickup_city,
    state: row.pickup_state,
    postalCode: row.pickup_postal_code,
    countryCode,
    evidenceSource: storedLocationEvidenceSource(row.pickup_evidence_source),
  };
}
function storedStringArray(value: string | null): readonly string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}
function storedPublisherEvent(
  value: string,
): VerifiedPublisherEventProvenanceInput {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("publisher event is not an object");
    }
    return parsed as VerifiedPublisherEventProvenanceInput;
  } catch (cause) {
    throw new Error("Stored publisher-event provenance is invalid", { cause });
  }
}
function storedLocationEvidenceSource(value: string | null): LocationEvidenceSource {
  return value && (locationEvidenceSources as readonly string[]).includes(value)
    ? value as LocationEvidenceSource
    : "unknown";
}
export async function ensureListingStub(
  runId: string,
  stub: NormalizedListingStub,
): Promise<{ id: string; inserted: boolean }> {
  const id = listingKey(stub.sourceId, stub.sourceListingId);
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO listing_stubs (
        id, source_id, source_listing_id, source_url, title, category, lot_number,
        visible_city, visible_state, visible_postal_code, visible_country_code,
        location_evidence_source, thumbnail_url, first_seen_run_id, discovered_at,
        content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).bind(
      id,
      stub.sourceId,
      stub.sourceListingId,
      stub.sourceUrl,
      stub.title,
      stub.category,
      stub.lotNumber,
      stub.visibleLocation?.city ?? null,
      stub.visibleLocation?.state ?? null,
      stub.visibleLocation?.postalCode ?? null,
      stub.visibleLocation?.countryCode ?? null,
      stub.visibleLocation?.evidenceSource ?? null,
      stub.thumbnailUrl,
      runId,
      stub.discoveredAt,
      stub.contentHash,
    ),
    env.DB.prepare(`
      INSERT OR IGNORE INTO dashboard_new_listings (
        listing_id, first_seen_run_id, added_at
      )
      SELECT id, first_seen_run_id, discovered_at
      FROM listing_stubs
      WHERE id = ? AND first_seen_run_id = ?
    `).bind(id, runId),
    env.DB.prepare(`
      INSERT OR IGNORE INTO source_inventory_observations (
        run_id, source_id, listing_id, observed_at
      )
      SELECT ?, source_id, id, ?
      FROM listing_stubs
      WHERE id = ? AND source_id = ?
    `).bind(runId, stub.discoveredAt, id, stub.sourceId),
  ]);

  const existing = await env.DB.prepare(`
    SELECT id, first_seen_run_id FROM listing_stubs
    WHERE source_id = ? AND source_listing_id = ?
    LIMIT 1
  `).bind(stub.sourceId, stub.sourceListingId).first<{
    id: string;
    first_seen_run_id: string;
  }>();
  if (!existing) {
    throw new Error(
      `Listing stub ${stub.sourceId}/${stub.sourceListingId} conflicted with another immutable listing identity`,
    );
  }
  return { id: existing.id, inserted: existing.first_seen_run_id === runId };
}
export async function ensureListingStubs(
  runId: string,
  stubs: readonly NormalizedListingStub[],
): Promise<Map<string, { id: string; inserted: boolean }>> {
  const results = new Map<string, { id: string; inserted: boolean }>();
  const batchSize = 25;
  for (let offset = 0; offset < stubs.length; offset += batchSize) {
    const chunk = stubs.slice(offset, offset + batchSize);
    const statements = chunk.flatMap((stub) => {
      const id = listingKey(stub.sourceId, stub.sourceListingId);
      return [
        env.DB.prepare(`
          INSERT INTO listing_stubs (
            id, source_id, source_listing_id, source_url, title, category, lot_number,
            visible_city, visible_state, visible_postal_code, visible_country_code,
            location_evidence_source, thumbnail_url, first_seen_run_id, discovered_at,
            content_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING
        `).bind(
          id,
          stub.sourceId,
          stub.sourceListingId,
          stub.sourceUrl,
          stub.title,
          stub.category,
          stub.lotNumber,
          stub.visibleLocation?.city ?? null,
          stub.visibleLocation?.state ?? null,
          stub.visibleLocation?.postalCode ?? null,
          stub.visibleLocation?.countryCode ?? null,
          stub.visibleLocation?.evidenceSource ?? null,
          stub.thumbnailUrl,
          runId,
          stub.discoveredAt,
          stub.contentHash,
        ),
        env.DB.prepare(`
          INSERT OR IGNORE INTO dashboard_new_listings (
            listing_id, first_seen_run_id, added_at
          )
          SELECT id, first_seen_run_id, discovered_at
          FROM listing_stubs
          WHERE id = ? AND first_seen_run_id = ?
        `).bind(id, runId),
        env.DB.prepare(`
          INSERT OR IGNORE INTO source_inventory_observations (
            run_id, source_id, listing_id, observed_at
          )
          SELECT ?, source_id, id, ?
          FROM listing_stubs
          WHERE id = ? AND source_id = ?
        `).bind(runId, stub.discoveredAt, id, stub.sourceId),
      ];
    });
    await env.DB.batch(statements);
    const expectedIds = chunk.map((stub) =>
      listingKey(stub.sourceId, stub.sourceListingId)
    );
    const persisted = await env.DB.prepare(`
      SELECT id, source_id, source_listing_id, source_url, first_seen_run_id
      FROM listing_stubs
      WHERE id IN (${expectedIds.map(() => "?").join(", ")})
    `).bind(...expectedIds).all<{
      id: string;
      source_id: string;
      source_listing_id: string;
      source_url: string;
      first_seen_run_id: string;
    }>();
    const persistedById = new Map(
      (persisted.results ?? []).map((row) => [row.id, row]),
    );
    for (let index = 0; index < chunk.length; index += 1) {
      const stub = chunk[index]!;
      const id = expectedIds[index]!;
      const row = persistedById.get(id);
      if (!storedStubMatchesIdentity(row
        ? {
            id: row.id,
            sourceId: row.source_id,
            sourceListingId: row.source_listing_id,
            sourceUrl: row.source_url,
          }
        : null, {
        id,
        sourceId: stub.sourceId,
        sourceListingId: stub.sourceListingId,
        sourceUrl: stub.sourceUrl,
      })) {
        throw new Error(
          `Listing stub ${stub.sourceId}/${stub.sourceListingId} conflicted with another immutable listing identity`,
        );
      }
      results.set(stub.sourceListingId, {
        id,
        inserted: row!.first_seen_run_id === runId,
      });
    }
  }
  return results;
}
export async function insertListingStub(
  runId: string,
  stub: NormalizedListingStub,
): Promise<string> {
  return (await ensureListingStub(runId, stub)).id;
}
export async function ensureListingDetail(
  listingId: string,
  detail: NormalizedListingDetail,
): Promise<ListingDetailWriteResult> {
  return (await ensureListingDetails([{ listingId, detail }])).get(listingId) ?? {
    inserted: false,
    listingId,
    actionableListingId: listingId,
    isActionableOwner: true,
    basis: "source_listing",
  };
}
export async function ensureListingDetailObservation(
  listingId: string,
  detail: NormalizedListingDetail,
): Promise<{ inserted: boolean }> {
  const observation = listingDetailObservationInsertStatement(
    listingId,
    detail,
  );
  const actionDeadline = listingActionDeadlineInsertStatement(
    listingId,
    detail,
  );
  const now = new Date();
  const invalidation = await prepareListingDetailMutationInvalidation({
    listingId,
    detail,
    domains: actionDeadline ? ["detail", "supplement"] : ["detail"],
    now,
  });
  const writes = await env.DB.batch([
    observation,
    ...(actionDeadline ? [actionDeadline] : []),
    ...invalidation,
  ]);
  await assertListingActionDeadlineStored(listingId, detail);
  return { inserted: (writes[0]?.meta.changes ?? 0) > 0 };
}
function listingDetailObservationInsertStatement(
  listingId: string,
  detail: NormalizedListingDetail,
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO listing_detail_observations (
      listing_id, title, auction_ends_at, source_url, detail_content_hash,
      observed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(listing_id) DO NOTHING
  `).bind(
    listingId,
    detail.title,
    detail.auctionEndsAt,
    detail.sourceUrl,
    detail.contentHash,
    detail.scrapedAt,
  );
}
interface StoredListingDetailRow {
  source_id: string;
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
  action_deadline_at: string | null;
  action_deadline_basis: "live_auction_start" | null;
  action_deadline_source_text: string | null;
  seller: string | null;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_postal_code: string | null;
  pickup_country_code: string | null;
  pickup_evidence_source: string | null;
  scraped_at: string;
  content_hash: string;
  upstream_platform: string | null;
  upstream_host: string | null;
  upstream_event_or_catalog_id: string | null;
  upstream_lot_id: string | null;
  upstream_event_name: string | null;
  upstream_event_url: string | null;
  upstream_observed_aliases_json: string | null;
  upstream_publisher_event_json: string | null;
}
interface StoredListingImageRow {
  position: number;
  is_primary: number;
  source_url: string;
  thumbnail_url: string | null;
}
export async function readStoredListingDetail(
  listingId: string,
): Promise<NormalizedListingDetail | null> {
  const row = await env.DB.prepare(`
    SELECT
      s.source_id,
      s.source_listing_id,
      s.source_url,
      COALESCE(observation.title, d.title_at_scrape) AS title_at_scrape,
      d.category_at_scrape,
      d.lot_number_at_scrape,
      d.raw_description,
      d.clean_description,
      d.price_amount_minor,
      d.price_currency,
      d.price_display_text,
      ${EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL} AS auction_ends_at,
      action_deadline.deadline_at AS action_deadline_at,
      action_deadline.basis AS action_deadline_basis,
      action_deadline.source_text AS action_deadline_source_text,
      d.seller,
      d.pickup_city,
      d.pickup_state,
      d.pickup_postal_code,
      d.pickup_country_code,
      d.pickup_evidence_source,
      d.scraped_at,
      d.content_hash,
      upstream.platform AS upstream_platform,
      upstream.host AS upstream_host,
      upstream.event_or_catalog_id AS upstream_event_or_catalog_id,
      upstream.lot_id AS upstream_lot_id,
      upstream.event_name AS upstream_event_name,
      upstream.event_url AS upstream_event_url,
      upstream.observed_aliases_json AS upstream_observed_aliases_json,
      upstream.publisher_event_json AS upstream_publisher_event_json
    FROM listing_stubs s
    JOIN listing_details d ON d.listing_id = s.id
    LEFT JOIN listing_detail_observations observation
      ON observation.listing_id = s.id
    LEFT JOIN listing_action_deadlines action_deadline
      ON action_deadline.listing_id = s.id
    LEFT JOIN listing_upstream_provenance upstream
      ON upstream.listing_id = s.id
    WHERE s.id = ?
    LIMIT 1
  `).bind(listingId).first<StoredListingDetailRow>();
  if (!row) return null;

  const imageResult = await env.DB.prepare(`
    SELECT position, is_primary, source_url, thumbnail_url
    FROM listing_images
    WHERE listing_id = ?
    ORDER BY position, id
  `).bind(listingId).all<StoredListingImageRow>();

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
    actionDeadline:
      row.action_deadline_at &&
        row.action_deadline_basis === "live_auction_start" &&
        row.action_deadline_source_text
        ? {
            at: row.action_deadline_at,
            basis: row.action_deadline_basis,
            sourceText: row.action_deadline_source_text,
          }
        : null,
    seller: row.seller,
    pickupLocation: storedPickupLocation(row),
    images: (imageResult.results ?? []).map((image) => ({
      sourceUrl: image.source_url,
      thumbnailUrl: image.thumbnail_url,
      position: image.position,
      isPrimary: image.is_primary === 1,
    })),
    upstreamProvenance:
      row.upstream_platform && row.upstream_host &&
        row.upstream_event_or_catalog_id && row.upstream_lot_id
        ? normalizeVerifiedUpstreamProvenance({
            platform: row.upstream_platform,
            host: row.upstream_host,
            eventOrCatalogId: row.upstream_event_or_catalog_id,
            lotId: row.upstream_lot_id,
            eventName: row.upstream_event_name,
            eventUrl: row.upstream_event_url,
            observedAliases: storedStringArray(
              row.upstream_observed_aliases_json,
            ),
            ...(row.upstream_publisher_event_json
              ? {
                  publisherEvent: storedPublisherEvent(
                    row.upstream_publisher_event_json,
                  ),
                }
              : {}),
          })
        : null,
    sharedAliasProvenance: null,
    scrapedAt: row.scraped_at,
    contentHash: row.content_hash,
  };
}
export async function readCurrentHeadBoundStoredInlineImageAbsenceDetail(input: {
  listingId: string;
  sourceId: string;
}): Promise<NormalizedListingDetail | null> {
  const proof = await env.DB.prepare(`
    SELECT
      stub.source_url AS stub_source_url,
      stub.thumbnail_url AS stub_thumbnail_url,
      detail.title_at_scrape AS detail_title,
      detail.scraped_at AS detail_scraped_at,
      detail.content_hash AS detail_content_hash,
      observation.title AS observation_title,
      observation.source_url AS observation_source_url,
      observation.detail_content_hash AS observation_detail_content_hash,
      observation.observed_at AS observation_observed_at,
      current_inventory.observed_at AS current_observed_at,
      (
        SELECT count(*)
        FROM listing_images image
        WHERE image.listing_id = stub.id
      ) AS image_count
    FROM listing_stubs stub
    JOIN listing_details detail ON detail.listing_id = stub.id
    JOIN listing_detail_observations observation
      ON observation.listing_id = stub.id
    JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = stub.id
      AND current_inventory.source_id = stub.source_id
    JOIN source_inventory_publication_heads current_head
      ON current_head.source_id = current_inventory.source_id
      AND current_head.inventory_run_id = current_inventory.inventory_run_id
    WHERE stub.id = ? AND stub.source_id = ?
    LIMIT 1
  `).bind(input.listingId, input.sourceId).first<{
    stub_source_url: string;
    stub_thumbnail_url: string | null;
    detail_title: string;
    detail_scraped_at: string;
    detail_content_hash: string;
    observation_title: string;
    observation_source_url: string;
    observation_detail_content_hash: string;
    observation_observed_at: string;
    current_observed_at: string;
    image_count: number;
  }>();
  if (!proof) return null;

  if (
    proof.stub_thumbnail_url !== null ||
    Number(proof.image_count) !== 0 ||
    proof.stub_source_url !== proof.observation_source_url ||
    proof.detail_title !== proof.observation_title ||
    proof.detail_content_hash !== proof.observation_detail_content_hash ||
    proof.detail_scraped_at !== proof.observation_observed_at ||
    proof.observation_observed_at > proof.current_observed_at
  ) {
    throw new Error(
      `Current-head inline image absence evidence conflicts for ${input.listingId}`,
    );
  }

  const detail = await readStoredListingDetail(input.listingId);
  if (!detail || detail.sourceId !== input.sourceId || detail.images.length !== 0) {
    throw new Error(
      `Current-head inline image absence detail conflicts for ${input.listingId}`,
    );
  }
  return detail;
}
export async function ensureListingDetails(
  entries: readonly {
    listingId: string;
    detail: NormalizedListingDetail;
  }[],
  options: { readonly catalogFallback?: boolean } = {},
): Promise<Map<string, ListingDetailWriteResult>> {
  const results = new Map<string, ListingDetailWriteResult>();
  const batchSize = 50;

  // Provenance ownership must be assigned in the same atomic evidence write as
  // its detail. Keep those uncommon HTML records one-at-a-time; ordinary API
  // details retain the existing bounded bulk path.
  if (
    entries.length > 1 &&
    entries.some(({ detail }) =>
      Boolean(
        detail.upstreamProvenance ||
          detail.actionDeadline,
      )
    )
  ) {
    for (const entry of entries) {
      const one = await ensureListingDetails([entry]);
      const result = one.get(entry.listingId);
      if (result) results.set(entry.listingId, result);
    }
    return results;
  }

  // A fetched HTML detail and its complete ordered image identity catalog are
  // one evidence unit. Keep a single-listing write in one transactional D1
  // batch so interruption cannot turn a real gallery into apparent absence.
  if (entries.length === 1 && options.catalogFallback !== true) {
    const entry = entries[0]!;
    const now = new Date();
    const actionDeadlineWrite = listingActionDeadlineInsertStatement(
      entry.listingId,
      entry.detail,
    );
    const invalidation = await prepareListingDetailMutationInvalidation({
      listingId: entry.listingId,
      detail: entry.detail,
      domains: actionDeadlineWrite
        ? ["detail", "supplement", "image"]
        : ["detail", "image"],
      now,
    });
    const writes = await env.DB.batch([
      listingDetailInsertStatement(entry.listingId, entry.detail),
      ...listingProvenanceInsertStatements(entry.listingId, entry.detail),
      ...(actionDeadlineWrite ? [actionDeadlineWrite] : []),
      ...entry.detail.images.map((image) =>
        listingImageInsertStatement(entry.listingId, image)
      ),
      ...invalidation,
    ]);
    await assertListingActionDeadlineStored(entry.listingId, entry.detail);
    const ownership = await readActionableListingOwnership(entry.listingId);
    if (!ownership) {
      throw new Error(
        `Listing detail ownership could not be resolved for ${entry.listingId}`,
      );
    }
    results.set(entry.listingId, {
      inserted: (writes[0]?.meta.changes ?? 0) > 0,
      ...ownership,
    });
    return results;
  }

  // The coalesced projection queue statement binds 16 fixed values plus six
  // values per listing generation. Fourteen listings use exactly 100 bound
  // variables; fifteen would exceed D1's conservative statement ceiling.
  const projectionBatchSize = Math.min(batchSize, 14);
  for (let offset = 0; offset < entries.length; offset += projectionBatchSize) {
    const chunk = entries.slice(offset, offset + projectionBatchSize);
    const now = new Date();
    const listingInvalidations = (await Promise.all(chunk.map((entry) =>
      prepareListingDetailMutationInvalidation({
        ...entry,
        domains: ["detail"],
        aggregateGlobalDomains: false,
        now,
      })
    ))).flat();
    const aggregateInvalidation =
      await prepareCanonicalMutationPayloadInvalidationStatements({
        database: env.DB,
        generations: chunk.map(({ listingId, detail }) =>
          listingDetailPayloadGeneration(listingId, detail, "detail")
        ),
        refresh: {
          target: { type: "global", scopeId: "accepted-detail-location" },
          reasonCode: "accepted_detail_batch_changed",
          priority: 500,
        },
        now,
      });
    const writes = await env.DB.batch([
      ...chunk.map(({ listingId, detail }) =>
        listingDetailInsertStatement(listingId, detail)
      ),
      ...listingInvalidations,
      ...aggregateInvalidation,
    ]);
    for (let index = 0; index < chunk.length; index += 1) {
      results.set(chunk[index]!.listingId, {
        inserted: (writes[index]?.meta.changes ?? 0) > 0,
        listingId: chunk[index]!.listingId,
        actionableListingId: chunk[index]!.listingId,
        isActionableOwner: true,
        basis: "source_listing",
      });
    }
  }

  const imageEntries = entries.filter(({ detail }) => detail.images.length > 0);
  for (let offset = 0; offset < imageEntries.length; offset += projectionBatchSize) {
    const chunk = imageEntries.slice(offset, offset + projectionBatchSize);
    const now = new Date();
    const listingInvalidations = (await Promise.all(chunk.map((entry) =>
      prepareListingDetailMutationInvalidation({
        ...entry,
        domains: ["image"],
        aggregateGlobalDomains: false,
        now,
      })
    ))).flat();
    const aggregateInvalidation =
      await prepareCanonicalMutationPayloadInvalidationStatements({
        database: env.DB,
        generations: chunk.map(({ listingId, detail }) =>
          listingDetailPayloadGeneration(listingId, detail, "image")
        ),
        refresh: {
          target: { type: "global", scopeId: "image-local-primary" },
          reasonCode: "image_catalog_batch_changed",
          priority: 500,
        },
        now,
      });
    await env.DB.batch([
      ...chunk.flatMap(({ listingId, detail }) =>
        detail.images.map((image) => listingImageInsertStatement(listingId, image))
      ),
      ...listingInvalidations,
      ...aggregateInvalidation,
    ]);
  }

  const actionDeadlines = entries.flatMap(({ listingId, detail }) => {
    const statement = listingActionDeadlineInsertStatement(listingId, detail);
    return statement ? [{ listingId, detail, statement }] : [];
  });
  for (let offset = 0; offset < actionDeadlines.length; offset += batchSize) {
    const chunk = actionDeadlines.slice(offset, offset + batchSize);
    await env.DB.batch(chunk.map(({ statement }) => statement));
    for (const { listingId, detail } of chunk) {
      await assertListingActionDeadlineStored(listingId, detail);
    }
  }

  return results;
}
export async function readActionableListingOwnership(listingId: string): Promise<ActionableListingOwnership | null> {
    const row = await env.DB.prepare("SELECT id FROM listing_stubs WHERE id = ?").bind(listingId).first<{id: string}>();
    return row ? { listingId: row.id, actionableListingId: row.id, isActionableOwner: true, basis: "source_listing" } : null;
  }
function listingProvenanceInsertStatements(
  listingId: string,
  detail: NormalizedListingDetail,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  const upstream = detail.upstreamProvenance;
  if (upstream) {
    statements.push(
      env.DB.prepare(`
        INSERT INTO listing_upstream_provenance (
          listing_id, platform, host, event_or_catalog_id, lot_id,
          event_name, event_url, observed_aliases_json, publisher_event_json,
          observed_at, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(listing_id) DO NOTHING
      `).bind(
        listingId,
        upstream.platform,
        upstream.host,
        upstream.eventOrCatalogId,
        upstream.lotId,
        upstream.eventName,
        upstream.eventUrl,
        JSON.stringify(upstream.observedAliases),
        upstream.publisherEvent
          ? JSON.stringify(upstream.publisherEvent)
          : null,
        detail.scrapedAt,
        stableContentHash(upstream),
      ),
    );
  }

  return statements;
}
function listingDetailInsertStatement(
  listingId: string,
  detail: NormalizedListingDetail,
) {
  return env.DB.prepare(`
    INSERT INTO listing_details (
      listing_id, title_at_scrape, category_at_scrape, lot_number_at_scrape,
      raw_description, clean_description,
      price_amount_minor, price_currency, price_display_text, auction_ends_at,
      seller, pickup_city, pickup_state, pickup_postal_code,
      pickup_country_code, pickup_evidence_source, scraped_at, content_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(listing_id) DO NOTHING
  `).bind(
    listingId,
    detail.title,
    detail.category,
    detail.lotNumber,
    detail.rawDescription,
    detail.cleanDescription,
    detail.priceAtScrape.amountMinor,
    detail.priceAtScrape.currency,
    detail.priceAtScrape.displayText,
    detail.auctionEndsAt,
    detail.seller,
    detail.pickupLocation?.city ?? null,
    detail.pickupLocation?.state ?? null,
    detail.pickupLocation?.postalCode ?? null,
    detail.pickupLocation?.countryCode ?? null,
    detail.pickupLocation?.evidenceSource ?? null,
    detail.scrapedAt,
    detail.contentHash,
  );
}
function listingActionDeadlineInsertStatement(
  listingId: string,
  detail: NormalizedListingDetail,
): D1PreparedStatement | null {
  const deadline = detail.actionDeadline;
  if (!deadline) return null;
  return env.DB.prepare(`
    INSERT INTO listing_action_deadlines (
      listing_id, deadline_at, basis, source_text, source_url,
      detail_content_hash, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(listing_id) DO NOTHING
  `).bind(
    listingId,
    deadline.at,
    deadline.basis,
    deadline.sourceText,
    detail.sourceUrl,
    detail.contentHash,
    detail.scrapedAt,
  );
}
async function assertListingActionDeadlineStored(
  listingId: string,
  detail: NormalizedListingDetail,
): Promise<void> {
  const deadline = detail.actionDeadline;
  if (!deadline) return;
  const stored = await env.DB.prepare(`
    SELECT
      deadline_at, basis, source_text, source_url
    FROM listing_action_deadlines
    WHERE listing_id = ?
    LIMIT 1
  `).bind(listingId).first<{
    deadline_at: string;
    basis: string;
    source_text: string;
    source_url: string;
  }>();
  if (
    !stored ||
    stored.deadline_at !== deadline.at ||
    stored.basis !== deadline.basis ||
    stored.source_text !== deadline.sourceText ||
    stored.source_url !== detail.sourceUrl
  ) {
    throw new Error(
      `Listing action deadline conflicts with immutable source state for ${listingId}`,
    );
  }
}
function listingImageInsertStatement(
  listingId: string,
  image: NormalizedListingDetail["images"][number],
) {
  return env.DB.prepare(`
    INSERT INTO listing_images (
      id, listing_id, position, is_primary, source_url, thumbnail_url,
      download_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).bind(
    `${listingId}:image:${image.position}`,
    listingId,
    image.position,
    image.isPrimary ? 1 : 0,
    image.sourceUrl,
    image.thumbnailUrl,
    image.isPrimary ? "pending" : "deferred",
  );
}
async function prepareListingDetailMutationInvalidation(input: {
  listingId: string;
  detail: NormalizedListingDetail;
  domains: readonly ("detail" | "supplement" | "image")[];
  aggregateGlobalDomains?: boolean;
  now: Date;
}): Promise<readonly D1PreparedStatement[]> {
  const generations = input.domains.map((domain) =>
    listingDetailPayloadGeneration(input.listingId, input.detail, domain)
  );
  return prepareCanonicalMutationPayloadInvalidationStatements({
    database: env.DB,
    generations,
    refresh: {
      target: {
        type: "listing",
        listingId: input.listingId,
        sourceId: input.detail.sourceId,
      },
      reasonCode: input.domains.length === 1
        ? `listing_${input.domains[0]}_changed`
        : "listing_detail_bundle_changed",
      priority: 600,
    },
    aggregateGlobalDomains: input.aggregateGlobalDomains,
    now: input.now,
  });
}
function listingDetailPayloadGeneration(
  listingId: string,
  detail: NormalizedListingDetail,
  domain: "detail" | "supplement" | "image",
) {
  if (domain === "detail") {
    return {
      domain: "accepted_detail_location" as const,
      scopeType: "listing" as const,
      scopeId: listingId,
      input: {
        listingId,
        sourceId: detail.sourceId,
        contentHash: detail.contentHash,
        pickupLocation: detail.pickupLocation ?? null,
      },
      derivationVersion: ACCEPTED_DETAIL_LOCATION_MUTATION_DERIVATION_VERSION,
    };
  }
  if (domain === "supplement") {
    return {
      domain: "factual_supplement" as const,
      scopeType: "listing" as const,
      scopeId: listingId,
      input: {
        listingId,
        actionDeadline: detail.actionDeadline ?? null,
        detailContentHash: detail.contentHash,
      },
      derivationVersion: FACTUAL_SUPPLEMENT_MUTATION_DERIVATION_VERSION,
    };
  }
  return {
    domain: "image_local_primary" as const,
    scopeType: "listing" as const,
    scopeId: listingId,
    input: {
      listingId,
      images: detail.images.map((image) => ({
        position: image.position,
        isPrimary: image.isPrimary,
        sourceUrl: image.sourceUrl,
        thumbnailUrl: image.thumbnailUrl,
      })),
    },
    derivationVersion: IMAGE_LOCAL_PRIMARY_MUTATION_DERIVATION_VERSION,
  };
}
export async function insertListingDetail(
  listingId: string,
  detail: NormalizedListingDetail,
) {
  await ensureListingDetail(listingId, detail);
}
interface AcceptedPrimaryImageRow {
  id: string;
  listing_id: string;
  source_id: string;
  source_listing_id: string;
  listing_title: string;
  listing_url: string;
  source_url: string;
  thumbnail_url: string | null;
  download_status: string;
  local_path: string | null;
  acquisition_method: string | null;
  attempt_count: number;
  last_attempted_at: string | null;
  download_error_code: string | null;
}
function parseImageAcquisitionMethod(
  value: string | null,
): ImageAcquisitionMethod | null {
  return value === "browser" ||
      value === "direct" ||
      value === "resolved_endpoint"
    ? value
    : null;
}
function mapAcceptedPrimaryImage(
  row: AcceptedPrimaryImageRow,
): AcceptedPrimaryImage {
  return {
    id: row.id,
    listingId: row.listing_id,
    source: row.source_id,
    sourceListingId: row.source_listing_id,
    listingTitle: row.listing_title,
    listingUrl: row.listing_url,
    sourceUrl: row.source_url,
    thumbnailUrl: row.thumbnail_url,
    downloadStatus: parseStoredPrimaryImageStatus(row.download_status) ?? "pending",
    localPath: row.local_path,
    acquisitionMethod: parseImageAcquisitionMethod(row.acquisition_method),
    attemptCount: Math.max(0, row.attempt_count ?? 0),
    lastAttemptedAt: row.last_attempted_at,
    downloadErrorCode: row.download_error_code,
  };
}
const acceptedPrimaryImageSelect = `
  SELECT
    i.id,
    i.listing_id,
    s.source_id,
    s.source_listing_id,
    s.title AS listing_title,
    s.source_url AS listing_url,
    i.source_url,
    i.thumbnail_url,
    i.download_status,
    i.local_path,
    i.acquisition_method,
    i.attempt_count,
    i.last_attempted_at,
    i.download_error_code
  FROM listing_images i
  JOIN listing_stubs s ON s.id = i.listing_id
  JOIN source_current_listings current_inventory
    ON current_inventory.listing_id = s.id
    AND current_inventory.source_id = s.source_id
    AND current_inventory.review_candidate = 1
  JOIN source_inventory_publication_heads current_head
    ON current_head.source_id = current_inventory.source_id
    AND current_head.inventory_run_id = current_inventory.inventory_run_id
  WHERE i.is_primary = 1
    AND NOT ${listingReviewCompletedSql("s.id")}
    AND NOT EXISTS (
      SELECT 1
      FROM listing_recovery_status terminal_image
      WHERE terminal_image.listing_id = s.id
        AND terminal_image.state = 'terminal'
        AND terminal_image.stage = 'image'
        AND (
          terminal_image.last_error_code = 'source_image_unavailable'
          OR (
            terminal_image.last_error_code = 'source_image_absent'
            AND NOT EXISTS (
              SELECT 1 FROM listing_images current_image
              WHERE current_image.listing_id = terminal_image.listing_id
            )
          )
        )
    )
    AND EXISTS (
      SELECT 1
      FROM listing_current_pipeline_state pipeline_state
      JOIN listing_routes lr
        ON lr.listing_id = s.id
        AND lr.route_cache_id = pipeline_state.route_cache_identity
      JOIN route_cache rc
        ON rc.id = lr.route_cache_id
        AND rc.input_hash = pipeline_state.route_input_hash
      WHERE pipeline_state.listing_id = s.id
        AND pipeline_state.source_id = current_inventory.source_id
        AND pipeline_state.source_current = 1
        AND pipeline_state.review_candidate = 1
        AND pipeline_state.active_inventory_run_id =
          current_inventory.inventory_run_id
        AND rc.error_code IS NULL
        AND rc.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
        AND rc.origin_cache_key = ?
        AND rc.provider_name = ?
    )
`;
export async function findAcceptedPrimaryImageById(
  imageId: string,
): Promise<AcceptedPrimaryImage | null> {
  const routeScope = await readActiveRouteScope();
  const row = await env.DB.prepare(`
    ${acceptedPrimaryImageSelect}
    AND i.id = ?
    LIMIT 1
  `).bind(
    routeScope.originCacheKey,
    routeScope.providerName,
    imageId,
  ).first<AcceptedPrimaryImageRow>();
  if (!row) return null;
  const exactAccepted = await readExactAcceptedListingIdsForScope({
    listingIds: [row.listing_id],
    originCacheKey: routeScope.originCacheKey,
    routeProviderName: routeScope.providerName,
  });
  if (!exactAccepted.has(row.listing_id)) return null;
  return mapAcceptedPrimaryImage(row);
}
export async function loadAcceptedPrimaryImageQueue(input: {
  sourceId?: string;
  imageId?: string | null;
  includeFailed?: boolean;
  requireExactWork?: boolean;
  limit?: number;
} = {}): Promise<AcceptedPrimaryImage[]> {
  const routeScope = await readActiveRouteScope();
  const sourceId = input.sourceId;
  const limit = Math.max(1, Math.min(input.limit ?? 10, 25));
  const exactFilter = input.imageId ? "AND i.id = ?" : "";
  const exactWorkFilter = input.requireExactWork
    ? `AND EXISTS (
        SELECT 1
        FROM listing_current_pipeline_state image_state
        JOIN pipeline_work_items image_work
          ON image_work.stage = 'primary_image'
          AND image_work.subject_type = 'listing'
          AND image_work.subject_id = i.listing_id
          AND image_work.listing_id = i.listing_id
          AND image_work.source_id = s.source_id
          AND image_work.input_hash = image_state.image_work_input_hash
        WHERE image_state.listing_id = i.listing_id
          AND image_state.source_id = s.source_id
          AND image_state.source_image_identity_hash IS NOT NULL
          AND image_work.lease_owner IS NULL
          AND image_work.lease_expires_at IS NULL
          AND image_work.claimed_input_hash IS NULL
          AND image_work.claimed_revision IS NULL
      )`
    : "";
  const statusFilter = input.includeFailed
    ? "AND i.download_status IN ('pending', 'failed')"
    : "AND i.download_status = 'pending'";
  const statusOrder = input.includeFailed
    ? "CASE i.download_status WHEN 'failed' THEN 0 ELSE 1 END"
    : "CASE i.download_status WHEN 'pending' THEN 0 ELSE 1 END";
  const bindings: Array<string | number> = [
    routeScope.originCacheKey,
    routeScope.providerName,
    ...(sourceId ? [sourceId] : []),
    ...(input.imageId ? [input.imageId, 1] : [limit]),
  ];
  const result = await env.DB.prepare(`
    ${acceptedPrimaryImageSelect}
    ${sourceId ? "AND s.source_id = ?" : ""}
    ${statusFilter}
    AND i.local_path IS NULL
    ${exactFilter}
    ${exactWorkFilter}
    ORDER BY
      ${statusOrder},
      i.attempt_count ASC,
      COALESCE(i.last_attempted_at, ''),
      s.discovered_at,
      i.id
    LIMIT ?
  `).bind(...bindings).all<AcceptedPrimaryImageRow>();
  const currentRows = result.results ?? [];
  const exactAccepted = await readExactAcceptedListingIdsForScope({
    listingIds: currentRows.map((row) => row.listing_id),
    originCacheKey: routeScope.originCacheKey,
    routeProviderName: routeScope.providerName,
  });
  return currentRows.filter((row) => exactAccepted.has(row.listing_id))
    .map(mapAcceptedPrimaryImage);
}
export function inferImageDownloadErrorCode(error?: string): string {
  const message = error?.toLowerCase() ?? "";
  const httpStatus = message.match(/http\s+(\d{3})/i)?.[1];
  if (httpStatus) return `image_http_${httpStatus}`;
  if (message.includes("exceed") && message.includes("byte")) return "image_too_large";
  if (message.includes("unsupported") && message.includes("type")) {
    return "image_unsupported_type";
  }
  if (message.includes("did not match") || message.includes("signature")) {
    return "image_signature_mismatch";
  }
  if (message.includes("redirect")) return "image_redirect_rejected";
  if (message.includes("abort") || message.includes("timeout")) return "image_timeout";
  return "image_archive_failed";
}
export async function markImageById(
  imageId: string,
  update: {
    status: "downloaded" | "failed";
    acquisitionMethod: ImageAcquisitionMethod;
    localPath?: string;
    contentHash?: string;
    width?: number | null;
    height?: number | null;
    error?: string;
    errorCode?: string;
  },
): Promise<boolean> {
  const routeScope = await readActiveRouteScope();
  const attemptedAt = utcNow();
  const target = await env.DB.prepare(`
    SELECT listing_id, attempt_count
    FROM listing_images
    WHERE id = ?
      AND is_primary = 1
      AND NOT ${listingReviewCompletedSql("listing_images.listing_id")}
      AND (? != 'failed' OR download_status != 'downloaded' OR local_path IS NULL)
      AND EXISTS (
        SELECT 1
        FROM listing_current_pipeline_state pipeline_state
        JOIN listing_routes lr
          ON lr.listing_id = listing_images.listing_id
          AND lr.route_cache_id = pipeline_state.route_cache_identity
        JOIN route_cache rc
          ON rc.id = lr.route_cache_id
          AND rc.input_hash = pipeline_state.route_input_hash
        JOIN source_current_listings current_inventory
          ON current_inventory.listing_id = listing_images.listing_id
          AND current_inventory.source_id = pipeline_state.source_id
          AND current_inventory.inventory_run_id =
            pipeline_state.active_inventory_run_id
          AND current_inventory.review_candidate = 1
        JOIN source_inventory_publication_heads current_head
          ON current_head.source_id = current_inventory.source_id
          AND current_head.inventory_run_id = current_inventory.inventory_run_id
        WHERE pipeline_state.listing_id = listing_images.listing_id
          AND pipeline_state.source_current = 1
          AND pipeline_state.review_candidate = 1
          AND rc.error_code IS NULL
          AND rc.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
          AND rc.origin_cache_key = ?
          AND rc.provider_name = ?
      )
    LIMIT 1
  `).bind(
    imageId,
    update.status,
    routeScope.originCacheKey,
    routeScope.providerName,
  ).first<{ listing_id: string; attempt_count: number }>();
  if (!target) return false;
  const exactAccepted = await readExactAcceptedListingIdsForScope({
    listingIds: [target.listing_id],
    originCacheKey: routeScope.originCacheKey,
    routeProviderName: routeScope.providerName,
  });
  if (!exactAccepted.has(target.listing_id)) return false;
  const updateStatement = env.DB.prepare(`
    UPDATE listing_images SET
      download_status = ?, local_path = ?, content_hash = ?, width = ?, height = ?,
      downloaded_at = ?, download_error = ?, download_error_code = ?,
      acquisition_method = ?, attempt_count = attempt_count + 1,
      last_attempted_at = ?
    WHERE id = ?
      AND is_primary = 1
      AND NOT ${listingReviewCompletedSql("listing_images.listing_id")}
      AND (? != 'failed' OR download_status != 'downloaded' OR local_path IS NULL)
      AND EXISTS (
        SELECT 1
        FROM listing_current_pipeline_state pipeline_state
        JOIN listing_routes lr
          ON lr.listing_id = listing_images.listing_id
          AND lr.route_cache_id = pipeline_state.route_cache_identity
        JOIN route_cache rc
          ON rc.id = lr.route_cache_id
          AND rc.input_hash = pipeline_state.route_input_hash
        JOIN source_current_listings current_inventory
          ON current_inventory.listing_id = listing_images.listing_id
          AND current_inventory.source_id = pipeline_state.source_id
          AND current_inventory.inventory_run_id =
            pipeline_state.active_inventory_run_id
          AND current_inventory.review_candidate = 1
        JOIN source_inventory_publication_heads current_head
          ON current_head.source_id = current_inventory.source_id
          AND current_head.inventory_run_id = current_inventory.inventory_run_id
        WHERE pipeline_state.listing_id = listing_images.listing_id
          AND pipeline_state.source_current = 1
          AND pipeline_state.review_candidate = 1
          AND rc.error_code IS NULL
          AND rc.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
          AND rc.origin_cache_key = ?
          AND rc.provider_name = ?
      )
  `).bind(
    update.status,
    update.localPath ?? null,
    update.contentHash ?? null,
    update.width ?? null,
    update.height ?? null,
    update.status === "downloaded" ? attemptedAt : null,
    update.error?.slice(0, 2_000) ?? null,
    update.status === "failed"
      ? update.errorCode ?? inferImageDownloadErrorCode(update.error)
      : null,
    update.acquisitionMethod,
    attemptedAt,
    imageId,
    update.status,
    routeScope.originCacheKey,
    routeScope.providerName,
  );
  const invalidationStatements = update.status === "downloaded"
    ? await prepareListingCanonicalMutationInvalidation({
        listingId: target.listing_id,
        domain: "image_local_primary",
        canonicalInput: {
          imageId,
          status: update.status,
          localPath: update.localPath ?? null,
          contentHash: update.contentHash ?? null,
          width: update.width ?? null,
          height: update.height ?? null,
          errorCode: null,
          acquisitionMethod: update.acquisitionMethod,
        },
        derivationVersion: IMAGE_LOCAL_PRIMARY_MUTATION_DERIVATION_VERSION,
        reasonCode: "primary_image_state_changed",
        priority: 700,
      })
    : [];
  const results = await env.DB.batch([
    updateStatement,
    ...invalidationStatements,
  ]);
  return (results[0]?.meta.changes ?? 0) > 0;
}
export async function markPrimaryImage(
  listingId: string,
  update: {
    status: "downloaded" | "failed";
    localPath?: string;
    contentHash?: string;
    width?: number | null;
    height?: number | null;
    error?: string;
    errorCode?: string;
    acquisitionMethod?: ImageAcquisitionMethod;
  },
) {
  const routeScope = await readActiveRouteScope();
  const exactAccepted = await readExactAcceptedListingIdsForScope({
    listingIds: [listingId],
    originCacheKey: routeScope.originCacheKey,
    routeProviderName: routeScope.providerName,
  });
  if (!exactAccepted.has(listingId)) return;
  const attemptedAt = utcNow();
  const target = await env.DB.prepare(`
    SELECT id, attempt_count
    FROM listing_images
    WHERE listing_id = ?
      AND is_primary = 1
      AND NOT ${listingReviewCompletedSql("listing_images.listing_id")}
      AND EXISTS (
        SELECT 1
        FROM listing_current_pipeline_state pipeline_state
        JOIN listing_routes lr
          ON lr.listing_id = listing_images.listing_id
          AND lr.route_cache_id = pipeline_state.route_cache_identity
        JOIN route_cache rc
          ON rc.id = lr.route_cache_id
          AND rc.input_hash = pipeline_state.route_input_hash
        JOIN source_current_listings current_inventory
          ON current_inventory.listing_id = listing_images.listing_id
          AND current_inventory.source_id = pipeline_state.source_id
          AND current_inventory.inventory_run_id =
            pipeline_state.active_inventory_run_id
          AND current_inventory.review_candidate = 1
        JOIN source_inventory_publication_heads current_head
          ON current_head.source_id = current_inventory.source_id
          AND current_head.inventory_run_id = current_inventory.inventory_run_id
        WHERE pipeline_state.listing_id = listing_images.listing_id
          AND pipeline_state.source_current = 1
          AND pipeline_state.review_candidate = 1
          AND rc.error_code IS NULL
          AND rc.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
          AND rc.origin_cache_key = ?
          AND rc.provider_name = ?
      )
    LIMIT 1
  `).bind(
    listingId,
    routeScope.originCacheKey,
    routeScope.providerName,
  ).first<{ id: string; attempt_count: number }>();
  if (!target) return;
  const updateStatement = env.DB.prepare(`
    UPDATE listing_images SET
      download_status = ?, local_path = ?, content_hash = ?, width = ?, height = ?,
      downloaded_at = ?, download_error = ?, download_error_code = ?,
      acquisition_method = ?, attempt_count = attempt_count + 1,
      last_attempted_at = ?
    WHERE listing_id = ?
      AND is_primary = 1
      AND NOT ${listingReviewCompletedSql("listing_images.listing_id")}
      AND EXISTS (
        SELECT 1
        FROM listing_current_pipeline_state pipeline_state
        JOIN listing_routes lr
          ON lr.listing_id = listing_images.listing_id
          AND lr.route_cache_id = pipeline_state.route_cache_identity
        JOIN route_cache rc
          ON rc.id = lr.route_cache_id
          AND rc.input_hash = pipeline_state.route_input_hash
        JOIN source_current_listings current_inventory
          ON current_inventory.listing_id = listing_images.listing_id
          AND current_inventory.source_id = pipeline_state.source_id
          AND current_inventory.inventory_run_id =
            pipeline_state.active_inventory_run_id
          AND current_inventory.review_candidate = 1
        JOIN source_inventory_publication_heads current_head
          ON current_head.source_id = current_inventory.source_id
          AND current_head.inventory_run_id = current_inventory.inventory_run_id
        WHERE pipeline_state.listing_id = listing_images.listing_id
          AND pipeline_state.source_current = 1
          AND pipeline_state.review_candidate = 1
          AND rc.error_code IS NULL
          AND rc.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
          AND rc.origin_cache_key = ?
          AND rc.provider_name = ?
      )
  `).bind(
    update.status,
    update.localPath ?? null,
    update.contentHash ?? null,
    update.width ?? null,
    update.height ?? null,
    update.status === "downloaded" ? attemptedAt : null,
    update.error?.slice(0, 2_000) ?? null,
    update.status === "failed"
      ? update.errorCode ?? inferImageDownloadErrorCode(update.error)
      : null,
    update.acquisitionMethod ?? "direct",
    attemptedAt,
    listingId,
    routeScope.originCacheKey,
    routeScope.providerName,
  );
  const acquisitionMethod = update.acquisitionMethod ?? "direct";
  const invalidationStatements = update.status === "downloaded"
    ? await prepareListingCanonicalMutationInvalidation({
        listingId,
        domain: "image_local_primary",
        canonicalInput: {
          imageId: target.id,
          status: update.status,
          localPath: update.localPath ?? null,
          contentHash: update.contentHash ?? null,
          width: update.width ?? null,
          height: update.height ?? null,
          errorCode: null,
          acquisitionMethod,
        },
        derivationVersion: IMAGE_LOCAL_PRIMARY_MUTATION_DERIVATION_VERSION,
        reasonCode: "primary_image_state_changed",
        priority: 700,
      })
    : [];
  await env.DB.batch([updateStatement, ...invalidationStatements]);
}
export async function storeLocation(input: {
  cacheKey: string;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  countryCode: string;
  latitude: number | null;
  longitude: number | null;
  provider: string | null;
  displayName?: string | null;
  status?: "pending" | "resolved" | "unknown" | "failed";
  error?: string | null;
}): Promise<string> {
  const existing = await env.DB.prepare(`SELECT id FROM locations WHERE cache_key = ?`).bind(input.cacheKey).first<{ id: string }>();
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO locations (
      id, cache_key, city, state, postal_code, country_code, display_name,
      latitude, longitude, resolution_status, geocode_provider, geocoded_at,
      geocode_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.cacheKey,
    input.city,
    input.state,
    input.postalCode,
    input.countryCode,
    input.displayName ?? null,
    input.latitude,
    input.longitude,
    input.status ?? (input.latitude === null ? "unknown" : "resolved"),
    input.provider,
    input.latitude === null ? null : utcNow(),
    input.error ?? null,
    utcNow(),
    utcNow(),
  ).run();
  return id;
}
export async function findLocation(cacheKey: string) {
  return env.DB.prepare(`SELECT * FROM locations WHERE cache_key = ? LIMIT 1`).bind(cacheKey).first<Record<string, unknown>>();
}
export async function storeListingRoute(input: {
  listingId: string;
  destinationLocationId: string;
  originCacheKey: string;
  providerName: string;
  inputHash: string;
  driveSeconds: number | null;
  distanceMeters: number | null;
  driveBucket: "under_2h" | "under_4h" | "under_8h" | "exclude";
  isApproximate: boolean;
  errorCode?: string | null;
}) {
  const routeId = crypto.randomUUID();
  const assignedAt = utcNow();
  const invalidationStatements = await prepareListingCanonicalMutationInvalidation({
    listingId: input.listingId,
    domain: "route_contract",
    canonicalInput: {
      routeId,
      destinationLocationId: input.destinationLocationId,
      originCacheKey: input.originCacheKey,
      providerName: input.providerName,
      inputHash: input.inputHash,
      driveSeconds: input.driveSeconds,
      distanceMeters: input.distanceMeters,
      driveBucket: input.driveBucket,
      isApproximate: input.isApproximate,
      errorCode: input.errorCode ?? null,
      assignedAt,
    },
    derivationVersion: ROUTE_CONTRACT_MUTATION_DERIVATION_VERSION,
    reasonCode: "listing_route_changed",
    priority: 850,
  });
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO route_cache (
        id, origin_cache_key, destination_location_id, provider_name, input_hash,
        drive_seconds, distance_meters, drive_bucket, is_approximate,
        calculated_at, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      routeId,
      input.originCacheKey,
      input.destinationLocationId,
      input.providerName,
      input.inputHash,
      input.driveSeconds,
      input.distanceMeters,
      input.driveBucket,
      input.isApproximate ? 1 : 0,
      assignedAt,
      input.errorCode ?? null,
    ),
    env.DB.prepare(`
      INSERT INTO listing_routes (listing_id, route_cache_id, assigned_at)
      VALUES (?, ?, ?)
    `).bind(input.listingId, routeId, assignedAt),
    ...invalidationStatements,
  ]);
}
export async function storeAiArtifact(input: {
  listingId: string;
  task: "listing_extraction" | "semantic_document" | "recommendation_explanation";
  providerName: string;
  modelName: string;
  promptVersion: string;
  inputHash: string;
  outputText?: string | null;
  outputJson?: string | null;
  outputHash?: string | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO ai_artifacts (
      id, subject_type, subject_id, task, provider_name, model_name,
      prompt_version, input_hash, output_text, output_json, output_hash, generated_at
    ) VALUES (?, 'listing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.listingId,
    input.task,
    input.providerName,
    input.modelName,
    input.promptVersion,
    input.inputHash,
    input.outputText ?? null,
    input.outputJson ?? null,
    input.outputHash ?? null,
    utcNow(),
  ).run();
  return id;
}
export async function storeEmbedding(input: {
  listingId: string;
  providerName: string;
  modelName: string;
  inputHash: string;
  vector: number[];
}) {
  await storeEmbeddings([input]);
}
export async function storeEmbeddings(inputs: readonly {
  listingId: string;
  providerName: string;
  modelName: string;
  inputHash: string;
  vector: number[];
}[]): Promise<void> {
  if (inputs.length === 0) return;
  const generatedAt = utcNow();
  await env.DB.batch(inputs.map((input) => env.DB.prepare(`
      INSERT INTO embeddings (
        id, subject_type, subject_id, kind, provider_name, model_name,
        input_hash, dimensions, vector_json, generated_at
      ) VALUES (?, 'listing', ?, 'listing_semantic_document', ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      input.listingId,
      input.providerName,
      input.modelName,
      input.inputHash,
      input.vector.length,
      JSON.stringify(input.vector),
      generatedAt,
    )));
}











