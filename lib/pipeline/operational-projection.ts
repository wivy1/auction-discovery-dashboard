import { optionalAiCapabilities } from "../ai/capabilities";
import {
  hashCanonicalJson,
  serializeCanonicalJson,
  type Sha256Identity,
} from "../performance/generations";
import {
  ACTIVE_PREFERENCE_V2_FEATURE_VERSION,
  ACTIVE_PREFERENCE_V2_MODEL_VERSION,
} from "../preference-v2/review-runtime";
import {
  PREFERENCE_V2_RUNTIME_IDENTITY_VERSIONS,
  resolvePreferenceV2ScoreInputRuntimeIdentity,
} from "../preference-v2/runtime-identity";
import { ACTIVE_PREFERENCE_V2_SCORE_RUNTIME_IDENTITY } from "../preference-v2/score-heads";
import {
  estimateLocalProximity,
  LOCAL_PROXIMITY_INPUT_VERSION,
  LOCAL_PROXIMITY_PROVIDER_NAME,
  resolveLocalProximityDestination,
  resolveLocalProximityOrigin,
  storedLocalProximityQuery,
} from "../routing/local-proximity";
import { locationCacheKey } from "../routing/helpers";
import { listingReviewCompletedSql } from "../review-completion";
import { findSourceAdapter } from "../sources/registry";
import type { PipelineWorkStage } from "./work-queue";
import {
  preparePipelineWorkCoalesceStatement,
  preparePipelineWorkDeleteIfUnclaimedStatement,
} from "./work-queue";

export const OPERATIONAL_OWNERSHIP_DERIVATION_VERSION =
  "operational-ownership-v3" as const;
export const CURRENT_PIPELINE_PROJECTION_DERIVATION_VERSION =
  "current-pipeline-projection-v13" as const;

export const LISTING_DOWNSTREAM_WORK_STAGES = [
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
] as const satisfies readonly PipelineWorkStage[];

export type OperationalOwnerState =
  | "native_primary"
  | "publisher_primary"
  | "shared_alias"
  | "upstream_representative"
  | "unresolved"
  | "other";

export type OperationalCounterpartState =
  | "present"
  | "absent_with_complete_proof"
  | "unknown";

export interface OperationalProjectionContracts {
  readonly originPostalCode: string;
  readonly originCountryCode?: "US";
  readonly generationVectorHash: string;
  readonly enrichmentTargetIdentity: string;
  readonly preferenceContractIdentity: string;
  readonly now?: Date;
}

export interface ProjectionScope {
  readonly type: "global" | "source" | "group";
  readonly id: string;
  readonly groupKind?: "shared_alias" | "upstream_tuple";
}

export interface OperationalProjectionOwnership {
  readonly listingId: string;
  readonly sourceId: string;
  readonly actionableOwnerListingId: string | null;
  readonly actionableOwnerSourceId: string | null;
  readonly ownerState: OperationalOwnerState;
  readonly ownerBasis: string;
  readonly ownerProofHash: Sha256Identity | null;
  readonly sharedGroupIdentity: string | null;
  readonly upstreamTupleIdentity: string | null;
  readonly counterpartState: OperationalCounterpartState;
  readonly counterpartOwnerListingId: string | null;
  readonly counterpartOwnerSourceId: string | null;
  readonly counterpartAbsenceProofHash: Sha256Identity | null;
  readonly ownershipInputHash: Sha256Identity;
}

export interface ExpectedListingWorkItem {
  readonly stage: (typeof LISTING_DOWNSTREAM_WORK_STAGES)[number];
  readonly inputHash: string;
  readonly laneKey: string;
  readonly reasonCode: string;
  readonly priority: number;
}

export interface OperationalProjectionState {
  readonly listingId: string;
  readonly sourceId: string;
  readonly reviewCompleted: boolean;
  readonly sourceCurrent: boolean;
  readonly activeInventoryRunId: string | null;
  readonly sourcePublicationGeneration: number | null;
  readonly sourceCoverageMode: "complete_current" | "discovery_frontier" | null;
  readonly reviewCandidate: boolean;
  readonly categoryScope: string | null;
  readonly ownershipInputHash: string;
  readonly acceptedDetailIdentity: string | null;
  readonly acceptedDetailHash: string | null;
  readonly effectiveLocationInputHash: string;
  readonly routeCacheIdentity: string | null;
  readonly routeAssignmentIdentity: string | null;
  readonly routeInputHash: string | null;
  readonly routeTerminalIdentity: string | null;
  readonly factualSupplementState: "unknown" | "pending" | "ready" | "terminal" | "failed";
  readonly factualSupplementInputHash: string;
  readonly sourceImageIdentityHash: string;
  readonly localPrimaryState: "unknown" | "deferred" | "pending" | "ready" | "terminal" | "failed";
  readonly imageInputHash: string;
  readonly enrichmentHeadIdentity: string | null;
  readonly enrichmentInputHash: string;
  readonly scoreHeadIdentity: string | null;
  readonly scoreSnapshotIdentity: string | null;
  readonly scoreInputHash: string;
  readonly sourceReleaseInputHash: string;
  readonly projectionWorkInputHash: string;
  readonly workInputHashes: Readonly<Partial<Record<ExpectedListingWorkItem["stage"], string>>>;
  readonly relevantGenerationVectorHash: string;
  readonly expectedWorkItems: readonly ExpectedListingWorkItem[];
}

export interface MaterializedOperationalProjection {
  readonly ownership: OperationalProjectionOwnership;
  readonly state: OperationalProjectionState;
}

export interface ProjectionBatchResult {
  readonly listingIds: readonly string[];
  readonly rowsRead: number;
  readonly statements: number;
  readonly expectedWorkItems: number;
  readonly nextCursor: string | null;
}

interface CanonicalProjectionRow {
  listing_id: string;
  source_id: string;
  review_completed: number;
  source_listing_id: string;
  stub_content_hash: string;
  title: string;
  category: string | null;
  visible_city: string | null;
  visible_state: string | null;
  visible_postal_code: string | null;
  visible_country_code: string | null;
  current_inventory_run_id: string | null;
  current_review_candidate: number | null;
  active_preference_v2_history: number;
  source_publication_generation: number | null;
  source_coverage_mode: string | null;
  detail_content_hash: string | null;
  detail_raw_description: string | null;
  detail_clean_description: string | null;
  accepted_detail_hash: string | null;
  detail_auction_ends_at: string | null;
  pickup_city: string | null;
  pickup_state: string | null;
  pickup_postal_code: string | null;
  pickup_country_code: string | null;
  detail_terminal_identity: string | null;
  action_deadline_hash: string | null;
  route_cache_id: string | null;
  route_destination_cache_key: string | null;
  route_origin_cache_key: string | null;
  route_provider_name: string | null;
  route_input_hash: string | null;
  route_error_code: string | null;
  route_drive_bucket: string | null;
  recovery_state: string | null;
  recovery_stage: string | null;
  recovery_error_code: string | null;
  source_images_json: string;
  primary_image_id: string | null;
  primary_download_status: string | null;
  primary_local_path: string | null;
  primary_content_hash: string | null;
  image_terminal_absent: number;
  enrichment_head_identity: string | null;
  enrichment_head_input_hash: string | null;
  enrichment_head_state: string | null;
  physical_asset_cluster_id: string | null;
  auction_event_block_id: string | null;
  semantic_family_id: string | null;
  score_head_identity: string | null;
  score_snapshot_identity: string | null;
  score_head_input_hash: string | null;
}

const MAX_BATCH = 250;
const SHA_IDENTITY = /^sha256:[0-9a-f]{64}$/u;

function boundedIdentity(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validateContracts(
  contracts: OperationalProjectionContracts,
): OperationalProjectionContracts & { readonly now: Date } {
  if (!/^\d{5}$/u.test(contracts.originPostalCode)) {
    throw new TypeError("projection origin postal code must be five digits");
  }
  boundedIdentity(contracts.generationVectorHash, "generation vector hash");
  boundedIdentity(contracts.enrichmentTargetIdentity, "enrichment target identity");
  boundedIdentity(contracts.preferenceContractIdentity, "preference contract identity");
  const now = contracts.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("projection time is invalid");
  return { ...contracts, now };
}

function stableGroupIdentity(input: {
  readonly kind: "shared_alias" | "upstream_tuple";
  readonly values: readonly string[];
}): string {
  return serializeCanonicalJson([input.kind, ...input.values]);
}

/** Reads a bounded keyset union for exact source/group/global fan-out. */
export async function readOperationalProjectionCandidateIds(input: {
  readonly database: D1Database;
  readonly scope: ProjectionScope;
  readonly afterListingId?: string | null;
  readonly limit?: number;
}): Promise<readonly string[]> {
  const after = input.afterListingId ?? "";
  boundedIdentity(input.scope.id, "projection scope id");
  if (after !== "") boundedIdentity(after, "projection cursor");
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new RangeError(`projection batch limit must be between 1 and ${MAX_BATCH}`);
  }
  let sql: string;
  let bindings: readonly unknown[];
  if (input.scope.type === "global") {
    sql = `
      SELECT id AS listing_id
      FROM listing_stubs
      WHERE id > ?
      ORDER BY id
      LIMIT ?
    `;
    bindings = [after, limit];
  } else if (input.scope.type === "source") {
    sql = `
      WITH members AS (
        SELECT id AS listing_id FROM listing_stubs WHERE source_id = ?
        UNION
        SELECT listing_id FROM listing_current_pipeline_state WHERE source_id = ?
        UNION
        SELECT ownership.listing_id
        FROM listing_operational_ownership ownership
        WHERE ownership.actionable_owner_source_id = ?
      )
      SELECT listing_id FROM members
      WHERE listing_id > ?
      ORDER BY listing_id
      LIMIT ?
    `;
    bindings = [input.scope.id, input.scope.id, input.scope.id, after, limit];
  } else if (input.scope.type === "group" &&
    (input.scope.groupKind === "shared_alias" || input.scope.groupKind === "upstream_tuple")) {
    const column = input.scope.groupKind === "shared_alias"
      ? "shared_group_identity" : "upstream_tuple_identity";
    sql = `SELECT listing_id FROM listing_operational_ownership
      WHERE ${column} = ? AND listing_id > ? ORDER BY listing_id LIMIT ?`;
    bindings = [input.scope.id, after, limit];
  } else {
    throw new TypeError("projection scope is invalid");
  }
  const result = await input.database.prepare(sql).bind(...bindings).all<{
    listing_id: string;
  }>();
  return Object.freeze((result.results ?? []).map((row) => row.listing_id));
}

/** Reads complete canonical inputs for an exact bounded listing set. */
export async function readCanonicalOperationalProjectionRows(input: {
  readonly database: D1Database;
  readonly listingIds: readonly string[];
  readonly originCacheKey: string;
}): Promise<readonly CanonicalProjectionRow[]> {
  const listingIds = [...new Set(input.listingIds.map((id) =>
    boundedIdentity(id, "projection listing id")
  ))].sort();
  if (listingIds.length > MAX_BATCH) {
    throw new RangeError(`projection reads support at most ${MAX_BATCH} listings`);
  }
  if (listingIds.length === 0) return Object.freeze([]);
  boundedIdentity(input.originCacheKey, "projection origin cache key", 1024);
  const result = await input.database.prepare(`
    WITH requested AS (
      SELECT CAST(value AS TEXT) AS listing_id FROM json_each(?)
    )
    SELECT
      s.id AS listing_id,
      s.source_id,
      CASE WHEN ${listingReviewCompletedSql("s.id")}
        THEN 1 ELSE 0 END AS review_completed,
      s.source_listing_id,
      s.content_hash AS stub_content_hash,
      s.title,
      s.category,
      s.visible_city,
      s.visible_state,
      s.visible_postal_code,
      s.visible_country_code,
      current_inventory.inventory_run_id AS current_inventory_run_id,
      current_inventory.review_candidate AS current_review_candidate,
      0 AS active_preference_v2_history,
      source_generation.generation AS source_publication_generation,
      CASE
        WHEN current_inventory.listing_id IS NULL THEN NULL
        ELSE 'complete_current'
      END AS source_coverage_mode,
      detail.content_hash AS detail_content_hash,
      detail.raw_description AS detail_raw_description,
      detail.clean_description AS detail_clean_description,
      CASE WHEN detail_observation.detail_content_hash = detail.content_hash
        THEN detail.content_hash ELSE NULL END AS accepted_detail_hash,
      CASE WHEN detail_observation.detail_content_hash = detail.content_hash
        THEN detail.auction_ends_at ELSE NULL END AS detail_auction_ends_at,
      CASE WHEN detail_observation.detail_content_hash = detail.content_hash
        THEN detail.pickup_city ELSE NULL END AS pickup_city,
      CASE WHEN detail_observation.detail_content_hash = detail.content_hash
        THEN detail.pickup_state ELSE NULL END AS pickup_state,
      CASE WHEN detail_observation.detail_content_hash = detail.content_hash
        THEN detail.pickup_postal_code ELSE NULL END AS pickup_postal_code,
      CASE WHEN detail_observation.detail_content_hash = detail.content_hash
        THEN detail.pickup_country_code ELSE NULL END AS pickup_country_code,
      detail_terminal.error_code || ':' ||
        detail_terminal.attempt_count || ':' ||
        detail_terminal.last_attempted_at AS detail_terminal_identity,
      action_deadline.detail_content_hash || ':' ||
        action_deadline.deadline_at || ':' || action_deadline.basis
        AS action_deadline_hash,
      cached_route.id AS route_cache_id,
      destination.cache_key AS route_destination_cache_key,
      cached_route.origin_cache_key AS route_origin_cache_key,
      cached_route.provider_name AS route_provider_name,
      cached_route.input_hash AS route_input_hash,
      cached_route.error_code AS route_error_code,
      cached_route.drive_bucket AS route_drive_bucket,
      recovery.state AS recovery_state,
      recovery.stage AS recovery_stage,
      recovery.last_error_code AS recovery_error_code,
      coalesce((
        SELECT json_group_array(json_object(
          'id', ordered_image.id,
          'position', ordered_image.position,
          'primary', ordered_image.is_primary,
          'source', ordered_image.source_url,
          'status', ordered_image.download_status,
          'content', ordered_image.content_hash
        ))
        FROM (
          SELECT * FROM listing_images image
          WHERE image.listing_id = s.id
          ORDER BY image.position, image.id
        ) ordered_image
      ), '[]') AS source_images_json,
      primary_image.id AS primary_image_id,
      primary_image.download_status AS primary_download_status,
      primary_image.local_path AS primary_local_path,
      primary_image.content_hash AS primary_content_hash,
      CASE WHEN EXISTS (
          SELECT 1 FROM listing_recovery_status image_terminal
          WHERE image_terminal.listing_id = s.id
            AND image_terminal.state = 'terminal'
            AND image_terminal.stage = 'image'
            AND (
              image_terminal.last_error_code = 'source_image_unavailable'
              OR (
                image_terminal.last_error_code = 'source_image_absent'
                AND NOT EXISTS (
                  SELECT 1 FROM listing_images any_image
                  WHERE any_image.listing_id = s.id
                )
              )
            )
        ) THEN 1 ELSE 0 END AS image_terminal_absent,
      enrichment.head_identity AS enrichment_head_identity,
      enrichment.enrichment_input_hash AS enrichment_head_input_hash,
      enrichment.state AS enrichment_head_state,
      NULL AS physical_asset_cluster_id,
      NULL AS auction_event_block_id,
      NULL AS semantic_family_id,
      NULL AS score_head_identity,
      NULL AS score_snapshot_identity,
      NULL AS score_head_input_hash
    FROM requested
    JOIN listing_stubs s ON s.id = requested.listing_id
    LEFT JOIN source_current_listings current_inventory
      ON current_inventory.listing_id = s.id
      AND current_inventory.source_id = s.source_id
      AND EXISTS (
        SELECT 1 FROM source_inventory_publication_heads current_head
        WHERE current_head.source_id = current_inventory.source_id
          AND current_head.inventory_run_id = current_inventory.inventory_run_id
      )
    LEFT JOIN pipeline_generation_state source_generation
      ON source_generation.domain = 'source_publication'
      AND source_generation.scope_type = 'source'
      AND source_generation.scope_id = s.source_id
    LEFT JOIN listing_details detail ON detail.listing_id = s.id
    LEFT JOIN listing_detail_observations detail_observation
      ON detail_observation.listing_id = s.id
    LEFT JOIN listing_detail_terminal_status detail_terminal
      ON detail_terminal.listing_id = s.id
    LEFT JOIN listing_action_deadlines action_deadline
      ON action_deadline.listing_id = s.id
    LEFT JOIN listing_routes route_assignment
      ON route_assignment.listing_id = s.id
    LEFT JOIN route_cache cached_route
      ON cached_route.id = route_assignment.route_cache_id
    LEFT JOIN locations destination
      ON destination.id = cached_route.destination_location_id
    LEFT JOIN listing_recovery_status recovery
      ON recovery.listing_id = s.id AND recovery.origin_cache_key = ?
    LEFT JOIN listing_images primary_image
      ON primary_image.listing_id = s.id AND primary_image.is_primary = 1
    LEFT JOIN listing_enrichment_heads enrichment
      ON enrichment.listing_id = s.id
    ORDER BY s.id
  `).bind(
    JSON.stringify(listingIds),
    input.originCacheKey,
  )
    .all<CanonicalProjectionRow>();
  return Object.freeze([...(result.results ?? [])]);
}

function localPrimaryState(row: CanonicalProjectionRow):
  OperationalProjectionState["localPrimaryState"] {
  if (row.image_terminal_absent === 1) return "terminal";
  if (
    row.primary_download_status === "downloaded" &&
    typeof row.primary_local_path === "string" &&
    row.primary_local_path.trim() !== ""
  ) return "ready";
  if (row.primary_download_status === "failed") return "failed";
  if (row.primary_download_status === "pending") return "pending";
  if (row.primary_download_status === "deferred") return "deferred";
  return "unknown";
}

interface CurrentLocalRouteIdentity {
  readonly originCacheKey: string | null;
  readonly providerName: string | null;
  readonly inputHash: string | null;
  readonly destinationCacheKey: string | null;
  readonly errorCode: string | null;
  readonly driveBucket: string | null;
}

function currentRouteMatches(input: {
  readonly route: CurrentLocalRouteIdentity;
  readonly desiredInputHash: string;
  readonly desiredDestinationCacheKey: string;
  readonly originCacheKey: string;
}): boolean {
  return input.route.originCacheKey === input.originCacheKey &&
    input.route.providerName === LOCAL_PROXIMITY_PROVIDER_NAME &&
    input.route.inputHash === input.desiredInputHash &&
    input.route.destinationCacheKey === input.desiredDestinationCacheKey;
}

export interface ExactCurrentDistanceExclusionInput {
  readonly originPostalCode: string;
  readonly originCountryCode?: "US";
  readonly catalogLocation: {
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
    readonly countryCode: string | null;
  };
  readonly completeDetailLocation: {
    readonly city: string | null;
    readonly state: string | null;
    readonly postalCode: string | null;
    readonly countryCode: string | null;
  } | null;
  readonly route: CurrentLocalRouteIdentity;
}

export type ExactCurrentRouteDisposition =
  | "accepted"
  | "excluded"
  | "unknown"
  | "stale"
  | "other";

/**
 * The source-neutral review/preparation boundary. Only an exact-current route
 * in an accepted bucket can admit ordinary review or downstream preparation.
 */
export function isExactCurrentReviewEligibleRouteDisposition(
  disposition: ExactCurrentRouteDisposition,
): boolean {
  return disposition === "accepted";
}

const EXACT_CURRENT_ACCEPTED_ROUTE_BUCKETS = new Set([
  "under_2h",
  "under_4h",
  "under_8h",
]);

/**
 * Classifies one assigned route only after recomputing the listing's current
 * effective local-proximity identity. Callers must never interpret a cached
 * bucket by itself as current acceptance or exclusion.
 */
export async function classifyExactCurrentRouteDisposition(
  input: ExactCurrentDistanceExclusionInput,
): Promise<ExactCurrentRouteDisposition> {
  const effectiveLocation = input.completeDetailLocation === null
    ? storedLocalProximityQuery(input.catalogLocation)
    : storedLocalProximityQuery(input.completeDetailLocation) ??
      storedLocalProximityQuery(input.catalogLocation);
  const origin = resolveLocalProximityOrigin(
    input.originPostalCode,
    input.originCountryCode ?? "US",
  );
  const originCacheKey = locationCacheKey({
    postalCode: input.originPostalCode,
    countryCode: input.originCountryCode ?? "US",
  });
  const desiredRoute = await estimateLocalProximity(
    origin,
    resolveLocalProximityDestination(effectiveLocation),
  );
  if (!currentRouteMatches({
    route: input.route,
    desiredInputHash: desiredRoute.inputHash,
    desiredDestinationCacheKey: desiredRoute.destinationCacheKey,
    originCacheKey,
  })) return "stale";
  if (input.route.errorCode === "unknown_location") return "unknown";
  if (input.route.errorCode !== null) return "other";
  if (input.route.driveBucket === "exclude") return "excluded";
  if (EXACT_CURRENT_ACCEPTED_ROUTE_BUCKETS.has(input.route.driveBucket ?? "")) {
    return "accepted";
  }
  return "other";
}

/**
 * Reuses the canonical route identity calculation for the terminal distance
 * boundary. A bucket alone is never sufficient: origin, provider, input, and
 * effective destination must all match the active local-proximity contract.
 */
export async function isExactCurrentDistanceExclusion(
  input: ExactCurrentDistanceExclusionInput,
): Promise<boolean> {
  return await classifyExactCurrentRouteDisposition(input) === "excluded";
}

/** Exact source-truth route dispositions used at bounded selection boundaries. */
export async function readExactCurrentRouteDispositions(input: {
  readonly database: D1Database;
  readonly listingIds: readonly string[];
  readonly originPostalCode: string;
  readonly originCountryCode?: "US";
}): Promise<ReadonlyMap<string, ExactCurrentRouteDisposition>> {
  const listingIds = [...new Set(input.listingIds.map((listingId) =>
    boundedIdentity(listingId, "route disposition listing id")
  ))].sort();
  if (listingIds.length > MAX_BATCH) {
    throw new RangeError(`route disposition reads support at most ${MAX_BATCH} listings`);
  }
  if (listingIds.length === 0) return new Map<string, ExactCurrentRouteDisposition>();
  const result = await input.database.prepare(`
    WITH requested AS (
      SELECT CAST(value AS TEXT) AS listing_id FROM json_each(?)
    )
    SELECT
      s.id,
      s.visible_city,
      s.visible_state,
      s.visible_postal_code,
      s.visible_country_code,
      CASE WHEN observation.detail_content_hash = detail.content_hash
        THEN detail.pickup_city ELSE NULL END AS pickup_city,
      CASE WHEN observation.detail_content_hash = detail.content_hash
        THEN detail.pickup_state ELSE NULL END AS pickup_state,
      CASE WHEN observation.detail_content_hash = detail.content_hash
        THEN detail.pickup_postal_code ELSE NULL END AS pickup_postal_code,
      CASE WHEN observation.detail_content_hash = detail.content_hash
        THEN detail.pickup_country_code ELSE NULL END AS pickup_country_code,
      CASE WHEN observation.detail_content_hash = detail.content_hash
        THEN 1 ELSE 0 END AS has_complete_detail,
      route.origin_cache_key,
      route.provider_name,
      route.input_hash,
      destination.cache_key AS destination_cache_key,
      route.error_code,
      route.drive_bucket
    FROM requested
    JOIN listing_stubs s ON s.id = requested.listing_id
    LEFT JOIN listing_details detail ON detail.listing_id = s.id
    LEFT JOIN listing_detail_observations observation
      ON observation.listing_id = s.id
      AND observation.detail_content_hash = detail.content_hash
    LEFT JOIN listing_routes assignment ON assignment.listing_id = s.id
    LEFT JOIN route_cache route ON route.id = assignment.route_cache_id
    LEFT JOIN locations destination ON destination.id = route.destination_location_id
    ORDER BY s.id
  `).bind(JSON.stringify(listingIds)).all<{
    id: string;
    visible_city: string | null;
    visible_state: string | null;
    visible_postal_code: string | null;
    visible_country_code: string | null;
    pickup_city: string | null;
    pickup_state: string | null;
    pickup_postal_code: string | null;
    pickup_country_code: string | null;
    has_complete_detail: number;
    origin_cache_key: string | null;
    provider_name: string | null;
    input_hash: string | null;
    destination_cache_key: string | null;
    error_code: string | null;
    drive_bucket: string | null;
  }>();
  const dispositions = new Map<string, ExactCurrentRouteDisposition>();
  for (const row of result.results ?? []) {
    dispositions.set(row.id, await classifyExactCurrentRouteDisposition({
      originPostalCode: input.originPostalCode,
      originCountryCode: input.originCountryCode,
      catalogLocation: {
        city: row.visible_city,
        state: row.visible_state,
        postalCode: row.visible_postal_code,
        countryCode: row.visible_country_code,
      },
      completeDetailLocation: row.has_complete_detail === 1
        ? {
            city: row.pickup_city,
            state: row.pickup_state,
            postalCode: row.pickup_postal_code,
            countryCode: row.pickup_country_code,
          }
        : null,
      route: {
        originCacheKey: row.origin_cache_key,
        providerName: row.provider_name,
        inputHash: row.input_hash,
        destinationCacheKey: row.destination_cache_key,
        errorCode: row.error_code,
        driveBucket: row.drive_bucket,
      },
    }));
  }
  return dispositions;
}

/** Exact source-truth exclusion recheck used at claim/dispatch boundaries. */
export async function readExactCurrentDistanceExclusionListingIds(input: {
  readonly database: D1Database;
  readonly listingIds: readonly string[];
  readonly originPostalCode: string;
  readonly originCountryCode?: "US";
}): Promise<ReadonlySet<string>> {
  const dispositions = await readExactCurrentRouteDispositions(input);
  const excluded = new Set<string>();
  for (const [listingId, disposition] of dispositions) {
    if (disposition === "excluded") excluded.add(listingId);
  }
  return excluded;
}

/** Deterministically derives the repairable projection and exact desired work. */
export async function materializeOperationalProjection(
  row: CanonicalProjectionRow,
  contractsInput: OperationalProjectionContracts,
): Promise<MaterializedOperationalProjection> {
  const contracts = validateContracts(contractsInput);
  const owner = { listingId: row.listing_id, sourceId: row.source_id, state: "native_primary" as const, basis: "source_listing" };
  const sharedGroupIdentity = null;
  const upstreamTupleIdentity = null;
  const counterpartState = "unknown" as const;
  const counterpartOwnerListingId = null;
  const counterpartOwnerSourceId = null;
  const counterpartAbsenceProofHash = null;
  const ownerProofInput = {
    listingId: row.listing_id,
    sourceId: row.source_id,
    actionableOwnerListingId: row.listing_id,
    actionableOwnerSourceId: row.source_id,
    derivationVersion: OPERATIONAL_OWNERSHIP_DERIVATION_VERSION,
  };
  const ownershipInputHash = await hashCanonicalJson(ownerProofInput);
  const ownerProofHash = await hashCanonicalJson({ ownerProofInput, positive: true });
  const ownership: OperationalProjectionOwnership = Object.freeze({
    listingId: row.listing_id,
    sourceId: row.source_id,
    actionableOwnerListingId: owner.listingId,
    actionableOwnerSourceId: owner.sourceId,
    ownerState: owner.state,
    ownerBasis: owner.basis,
    ownerProofHash,
    sharedGroupIdentity,
    upstreamTupleIdentity,
    counterpartState,
    counterpartOwnerListingId,
    counterpartOwnerSourceId,
    counterpartAbsenceProofHash,
    ownershipInputHash,
  });
  const capabilities = optionalAiCapabilities();
  const sourceCurrent = row.current_inventory_run_id !== null;
  const reviewCompleted = row.review_completed === 1;
  const reviewCandidate = sourceCurrent && row.current_review_candidate === 1;
  const activePreferenceV2History =
    !sourceCurrent && row.active_preference_v2_history === 1;
  const acceptedDetailIdentity = row.accepted_detail_hash === null
    ? null
    : `${row.listing_id}:${row.accepted_detail_hash}`;
  const catalogLocation = storedLocalProximityQuery({
    city: row.visible_city,
    state: row.visible_state,
    postalCode: row.visible_postal_code,
    countryCode: row.visible_country_code,
  });
  const detailLocation = row.accepted_detail_hash === null
    ? null
    : storedLocalProximityQuery({
        city: row.pickup_city,
        state: row.pickup_state,
        postalCode: row.pickup_postal_code,
        countryCode: row.pickup_country_code,
      });
  const effectiveLocation = detailLocation ?? catalogLocation;
  const effectiveLocationInputHash = await hashCanonicalJson(effectiveLocation);
  const origin = resolveLocalProximityOrigin(
    contracts.originPostalCode,
    contracts.originCountryCode ?? "US",
  );
  const originCacheKey = locationCacheKey({
    postalCode: contracts.originPostalCode,
    countryCode: contracts.originCountryCode ?? "US",
  });
  const destination = resolveLocalProximityDestination(effectiveLocation);
  const desiredRoute = await estimateLocalProximity(origin, destination);
  const routeMatches = currentRouteMatches({
    route: {
      originCacheKey: row.route_origin_cache_key,
      providerName: row.route_provider_name,
      inputHash: row.route_input_hash,
      destinationCacheKey: row.route_destination_cache_key,
      errorCode: row.route_error_code,
      driveBucket: row.route_drive_bucket,
    },
    desiredInputHash: desiredRoute.inputHash,
    desiredDestinationCacheKey: desiredRoute.destinationCacheKey,
    originCacheKey,
  });
  const factualState = "ready" as const;
  const hasUsableSourceText = row.title.trim() !== "" ||
    (row.detail_raw_description?.trim() ?? "") !== "" ||
    (row.detail_clean_description?.trim() ?? "") !== "";
  const factualReady = factualState === "ready" ||
    (hasUsableSourceText && ["failed", "terminal"].includes(factualState));
  const factualSupplementInputHash = await hashCanonicalJson({
    sourceId: row.source_id,
    stubContentHash: row.stub_content_hash,
    acceptedDetailHash: row.accepted_detail_hash,
    derivation: "factual-supplement-projection-v1",
  });
  const sourceImageIdentityHash = await hashCanonicalJson(
    JSON.parse(row.source_images_json) as unknown,
  );
  const primaryState = localPrimaryState(row);
  const imageInputHash = await hashCanonicalJson({
    sourceImageIdentityHash,
    primaryImageId: row.primary_image_id,
    primaryStatus: row.primary_download_status,
    primaryContentHash: row.primary_content_hash,
    terminalAbsent: row.image_terminal_absent === 1,
    derivation: "local-primary-projection-v1",
  });
  const enrichmentInputHash = await hashCanonicalJson({
    target: contracts.enrichmentTargetIdentity,
    listingId: row.listing_id,
    stubContentHash: row.stub_content_hash,
    acceptedDetailHash: row.accepted_detail_hash,
    factualSupplementInputHash,
  });
  const runtimeIdentity = await resolvePreferenceV2ScoreInputRuntimeIdentity({
    listingId: row.listing_id,
    sourceId: row.source_id,
    physicalAssetClusterId: row.physical_asset_cluster_id,
    auctionEventBlockId: row.auction_event_block_id,
    semanticFamilyId: row.semantic_family_id,
  });
  const scoreInputHash = await hashCanonicalJson({
    contract: contracts.preferenceContractIdentity,
    modelVersion: ACTIVE_PREFERENCE_V2_MODEL_VERSION,
    featureVersion: ACTIVE_PREFERENCE_V2_FEATURE_VERSION,
    scoreRuntimeIdentity: ACTIVE_PREFERENCE_V2_SCORE_RUNTIME_IDENTITY,
    requiredRuntimeIdentityVersions: PREFERENCE_V2_RUNTIME_IDENTITY_VERSIONS,
    listingId: row.listing_id,
    enrichmentInputHash,
    enrichmentHeadIdentity: row.enrichment_head_identity,
    ownershipInputHash,
    routeInputHash: desiredRoute.inputHash,
    activeOriginCacheKey: originCacheKey,
    runtimeIdentity,
  });
  const relevantGenerationVectorHash = await hashCanonicalJson({
    source: {
      sourceId: row.source_id,
      activeInventoryRunId: row.current_inventory_run_id,
      publicationGeneration: row.source_publication_generation,
      coverageMode: row.source_coverage_mode,
    },
    ownership: {
      inputHash: ownershipInputHash,
      sharedGroupIdentity,
      upstreamTupleIdentity,
    },
    origin: {
      cacheKey: originCacheKey,
      provider: LOCAL_PROXIMITY_PROVIDER_NAME,
      inputVersion: LOCAL_PROXIMITY_INPUT_VERSION,
    },
    enrichmentTargetIdentity: contracts.enrichmentTargetIdentity,
    preferenceContractIdentity: contracts.preferenceContractIdentity,
    optionalCapabilities: capabilities,
    projectionDerivationVersion: CURRENT_PIPELINE_PROJECTION_DERIVATION_VERSION,
  });
  const sourceReleaseInputHash = await hashCanonicalJson({
    sourceId: row.source_id,
    reviewCompleted,
    sourceCurrent,
    reviewCandidate,
    ownerListingId: owner.listingId,
    acceptedDetailHash: row.accepted_detail_hash,
    routeInputHash: desiredRoute.inputHash,
    routeMatches,
    factualState,
    primaryState,
    enrichmentHeadIdentity: row.enrichment_head_identity,
    scoreHeadIdentity: row.score_head_identity,
    relevantGenerationVectorHash,
  });

  const workInputHashes = Object.freeze({
    detail: await hashCanonicalJson({
      listingId: row.listing_id,
      sourceCurrent,
      stubContentHash: row.stub_content_hash,
      acceptedDetailHash: row.accepted_detail_hash,
      terminal: row.detail_terminal_identity,
    }),
    action_deadline: await hashCanonicalJson({
      listingId: row.listing_id,
      acceptedDetailHash: row.accepted_detail_hash,
      actionDeadlineHash: row.action_deadline_hash,
    }),
    owner_refresh: ownershipInputHash,
    factual_supplement: factualSupplementInputHash,
    image_evidence: await hashCanonicalJson({
      listingId: row.listing_id,
      sourceCurrent,
      acceptedDetailHash: row.accepted_detail_hash,
      sourceImageIdentityHash,
      terminalAbsent: row.image_terminal_absent === 1,
    }),
    primary_image: imageInputHash,
    proximity: desiredRoute.inputHash,
    enrichment_text: enrichmentInputHash,
    enrichment_embedding: await hashCanonicalJson({
      enrichmentInputHash,
      headIdentity: row.enrichment_head_identity,
      headState: row.enrichment_head_state,
    }),
    preference_v2_score: scoreInputHash,
  } satisfies Record<ExpectedListingWorkItem["stage"], string>);

  const actionable = owner.listingId === row.listing_id;
  // A legacy detail-terminal marker only blocks rows that still lack any
  // accepted immutable detail. Once a local catalog fallback is observed,
  // the marker must not prevent
  // local proximity or downstream preparation.
  const detailTerminal = row.detail_terminal_identity !== null &&
    row.accepted_detail_hash === null;
  const nonRouteTerminal = row.recovery_state === "terminal" &&
    row.recovery_stage !== "route";
  const routeAccepted = routeMatches && row.route_error_code === null &&
    ["under_2h", "under_4h", "under_8h"].includes(row.route_drive_bucket ?? "");
  const distanceExcluded = routeMatches && row.route_error_code === null &&
    row.route_drive_bucket === "exclude";
  const manifest = findSourceAdapter(row.source_id)?.manifest;
  const requiresActionDeadline = manifest?.requiresActionDeadline === true;
  const presentationReady = primaryState === "ready" || primaryState === "terminal";
  const prepared = sourceCurrent && reviewCandidate && actionable &&
    row.accepted_detail_hash !== null && !detailTerminal && routeAccepted &&
    factualReady && presentationReady &&
    (!requiresActionDeadline || row.action_deadline_hash !== null);
  const expected: ExpectedListingWorkItem[] = [];
  const add = (
    stage: ExpectedListingWorkItem["stage"],
    reasonCode: string,
    priority: number,
  ) => expected.push(Object.freeze({
    stage,
    inputHash: workInputHashes[stage],
    laneKey: stage === "proximity" ? "local-proximity" : row.source_id,
    reasonCode,
    priority,
  }));
  if (!reviewCompleted && !distanceExcluded) {
    if (
      sourceCurrent && reviewCandidate && actionable &&
      routeAccepted && row.accepted_detail_hash === null && !detailTerminal
    ) add("detail", "detail_missing_or_stale", 80);
    if (
      sourceCurrent && reviewCandidate && actionable && routeAccepted &&
      row.source_images_json !== "[]" &&
      primaryState !== "ready" && primaryState !== "terminal" && !nonRouteTerminal
    ) add("primary_image", "local_primary_incomplete", 60);
    if (
      !routeMatches && (
        (sourceCurrent && reviewCandidate && actionable && !detailTerminal &&
          !nonRouteTerminal) || activePreferenceV2History
      )
    ) add("proximity", "proximity_input_changed", 85);
    if (
      capabilities.enrichment && prepared && (
        row.enrichment_head_identity === null ||
        row.enrichment_head_input_hash !== enrichmentInputHash ||
        row.enrichment_head_state === "pending_text"
      )
    ) add("enrichment_text", "enrichment_text_dirty", 50);
    if (
      capabilities.enrichment && prepared && row.enrichment_head_input_hash === enrichmentInputHash &&
      ["text_ready", "pending_embedding"].includes(row.enrichment_head_state ?? "")
    ) add("enrichment_embedding", "enrichment_embedding_dirty", 45);
    if (
      prepared && row.enrichment_head_input_hash === enrichmentInputHash &&
      capabilities.preferenceScoring && row.enrichment_head_state === "complete" &&
      row.score_head_input_hash !== scoreInputHash
    ) add("preference_v2_score", "preference_score_dirty", 40);
  }

  const projectionWorkInputHash = await hashCanonicalJson({
    schema: 46,
    derivation: CURRENT_PIPELINE_PROJECTION_DERIVATION_VERSION,
    listingId: row.listing_id,
    sourceId: row.source_id,
    reviewCompleted,
    sourceCurrent,
    activeInventoryRunId: row.current_inventory_run_id,
    sourcePublicationGeneration: row.source_publication_generation,
    sourceCoverageMode: row.source_coverage_mode,
    reviewCandidate,
    activePreferenceV2History,
    ownershipInputHash,
    acceptedDetailIdentity,
    effectiveLocationInputHash,
    desiredRouteInputHash: desiredRoute.inputHash,
    factualSupplementInputHash,
    imageInputHash,
    enrichmentInputHash,
    scoreInputHash,
    sourceReleaseInputHash,
    expectedWork: expected.map(({ stage, inputHash }) => [stage, inputHash]),
    relevantGenerationVectorHash,
  });
  const state: OperationalProjectionState = Object.freeze({
    listingId: row.listing_id,
    sourceId: row.source_id,
    reviewCompleted,
    sourceCurrent,
    activeInventoryRunId: row.current_inventory_run_id,
    sourcePublicationGeneration: row.source_publication_generation,
    sourceCoverageMode: sourceCurrent
      ? row.source_coverage_mode === "discovery_frontier"
        ? "discovery_frontier"
        : "complete_current"
      : null,
    reviewCandidate,
    categoryScope: sourceCurrent
      ? reviewCandidate ? "review_candidate" : "outside_review_candidate"
      : null,
    ownershipInputHash,
    acceptedDetailIdentity,
    acceptedDetailHash: row.accepted_detail_hash,
    effectiveLocationInputHash,
    routeCacheIdentity: routeMatches ? row.route_cache_id : null,
    routeAssignmentIdentity: routeMatches && row.route_cache_id
      ? `${row.listing_id}:${row.route_cache_id}`
      : null,
    routeInputHash: routeMatches ? row.route_input_hash : null,
    routeTerminalIdentity: routeMatches && row.route_error_code !== null
      ? `${row.route_cache_id}:${row.route_error_code}`
      : row.recovery_state === "terminal" && row.recovery_stage === "route"
      ? `${origin.cacheKey}:${row.recovery_error_code ?? "terminal"}`
      : null,
    factualSupplementState: factualState,
    factualSupplementInputHash,
    sourceImageIdentityHash,
    localPrimaryState: primaryState,
    imageInputHash,
    enrichmentHeadIdentity: row.enrichment_head_input_hash === enrichmentInputHash
      ? row.enrichment_head_identity
      : null,
    enrichmentInputHash,
    scoreHeadIdentity: row.score_head_input_hash === scoreInputHash
      ? row.score_head_identity
      : null,
    scoreSnapshotIdentity: row.score_head_input_hash === scoreInputHash
      ? row.score_snapshot_identity
      : null,
    scoreInputHash,
    sourceReleaseInputHash,
    projectionWorkInputHash,
    workInputHashes,
    relevantGenerationVectorHash,
    expectedWorkItems: Object.freeze(expected),
  });
  return Object.freeze({ ownership, state });
}

function ownershipUpsertStatement(
  database: D1Database,
  ownership: OperationalProjectionOwnership,
  nowIso: string,
): D1PreparedStatement {
  return database.prepare(`
    INSERT INTO listing_operational_ownership (
      listing_id, source_id,
      actionable_owner_listing_id, actionable_owner_source_id,
      owner_state, owner_basis, owner_proof_hash,
      shared_group_identity, upstream_tuple_identity,
      counterpart_state, counterpart_owner_listing_id,
      counterpart_owner_source_id, counterpart_absence_proof_hash,
      ownership_input_hash, derivation_version, update_generation, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(listing_id) DO UPDATE SET
      source_id = excluded.source_id,
      actionable_owner_listing_id = excluded.actionable_owner_listing_id,
      actionable_owner_source_id = excluded.actionable_owner_source_id,
      owner_state = excluded.owner_state,
      owner_basis = excluded.owner_basis,
      owner_proof_hash = excluded.owner_proof_hash,
      shared_group_identity = excluded.shared_group_identity,
      upstream_tuple_identity = excluded.upstream_tuple_identity,
      counterpart_state = excluded.counterpart_state,
      counterpart_owner_listing_id = excluded.counterpart_owner_listing_id,
      counterpart_owner_source_id = excluded.counterpart_owner_source_id,
      counterpart_absence_proof_hash = excluded.counterpart_absence_proof_hash,
      ownership_input_hash = excluded.ownership_input_hash,
      derivation_version = excluded.derivation_version,
      update_generation = listing_operational_ownership.update_generation + 1,
      updated_at = excluded.updated_at
    WHERE listing_operational_ownership.ownership_input_hash <>
        excluded.ownership_input_hash
      OR listing_operational_ownership.derivation_version <>
        excluded.derivation_version
  `).bind(
    ownership.listingId,
    ownership.sourceId,
    ownership.actionableOwnerListingId,
    ownership.actionableOwnerSourceId,
    ownership.ownerState,
    ownership.ownerBasis,
    ownership.ownerProofHash,
    ownership.sharedGroupIdentity,
    ownership.upstreamTupleIdentity,
    ownership.counterpartState,
    ownership.counterpartOwnerListingId,
    ownership.counterpartOwnerSourceId,
    ownership.counterpartAbsenceProofHash,
    ownership.ownershipInputHash,
    OPERATIONAL_OWNERSHIP_DERIVATION_VERSION,
    nowIso,
  );
}

function currentStateUpsertStatement(
  database: D1Database,
  state: OperationalProjectionState,
  nowIso: string,
): D1PreparedStatement {
  const work = state.workInputHashes;
  return database.prepare(`
    INSERT INTO listing_current_pipeline_state (
      listing_id, source_id, source_current, active_inventory_run_id,
      source_publication_generation, source_coverage_mode, review_candidate,
      category_scope, ownership_input_hash, accepted_detail_identity,
      accepted_detail_hash, effective_location_input_hash,
      route_cache_identity, route_assignment_identity, route_input_hash,
      route_terminal_identity, factual_supplement_state,
      factual_supplement_input_hash, source_image_identity_hash,
      local_primary_state, image_input_hash, enrichment_head_identity,
      enrichment_input_hash, score_head_identity, score_snapshot_identity,
      score_input_hash, source_release_input_hash, projection_work_input_hash,
      detail_work_input_hash, action_deadline_work_input_hash,
      owner_work_input_hash, factual_work_input_hash, image_work_input_hash,
      proximity_work_input_hash, enrichment_text_work_input_hash,
      enrichment_embedding_work_input_hash, preference_score_work_input_hash,
      source_release_work_input_hash, relevant_generation_vector_hash,
      projection_derivation_version, update_generation, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?
    )
    ON CONFLICT(listing_id) DO UPDATE SET
      source_id = excluded.source_id,
      source_current = excluded.source_current,
      active_inventory_run_id = excluded.active_inventory_run_id,
      source_publication_generation = excluded.source_publication_generation,
      source_coverage_mode = excluded.source_coverage_mode,
      review_candidate = excluded.review_candidate,
      category_scope = excluded.category_scope,
      ownership_input_hash = excluded.ownership_input_hash,
      accepted_detail_identity = excluded.accepted_detail_identity,
      accepted_detail_hash = excluded.accepted_detail_hash,
      effective_location_input_hash = excluded.effective_location_input_hash,
      route_cache_identity = excluded.route_cache_identity,
      route_assignment_identity = excluded.route_assignment_identity,
      route_input_hash = excluded.route_input_hash,
      route_terminal_identity = excluded.route_terminal_identity,
      factual_supplement_state = excluded.factual_supplement_state,
      factual_supplement_input_hash = excluded.factual_supplement_input_hash,
      source_image_identity_hash = excluded.source_image_identity_hash,
      local_primary_state = excluded.local_primary_state,
      image_input_hash = excluded.image_input_hash,
      enrichment_head_identity = excluded.enrichment_head_identity,
      enrichment_input_hash = excluded.enrichment_input_hash,
      score_head_identity = excluded.score_head_identity,
      score_snapshot_identity = excluded.score_snapshot_identity,
      score_input_hash = excluded.score_input_hash,
      source_release_input_hash = excluded.source_release_input_hash,
      projection_work_input_hash = excluded.projection_work_input_hash,
      detail_work_input_hash = excluded.detail_work_input_hash,
      action_deadline_work_input_hash = excluded.action_deadline_work_input_hash,
      owner_work_input_hash = excluded.owner_work_input_hash,
      factual_work_input_hash = excluded.factual_work_input_hash,
      image_work_input_hash = excluded.image_work_input_hash,
      proximity_work_input_hash = excluded.proximity_work_input_hash,
      enrichment_text_work_input_hash = excluded.enrichment_text_work_input_hash,
      enrichment_embedding_work_input_hash = excluded.enrichment_embedding_work_input_hash,
      preference_score_work_input_hash = excluded.preference_score_work_input_hash,
      source_release_work_input_hash = excluded.source_release_work_input_hash,
      relevant_generation_vector_hash = excluded.relevant_generation_vector_hash,
      projection_derivation_version = excluded.projection_derivation_version,
      update_generation = listing_current_pipeline_state.update_generation + 1,
      updated_at = excluded.updated_at
    WHERE listing_current_pipeline_state.projection_work_input_hash <>
        excluded.projection_work_input_hash
      OR listing_current_pipeline_state.projection_derivation_version <>
        excluded.projection_derivation_version
  `).bind(
    state.listingId,
    state.sourceId,
    state.sourceCurrent ? 1 : 0,
    state.activeInventoryRunId,
    state.sourcePublicationGeneration,
    state.sourceCoverageMode,
    state.reviewCandidate ? 1 : 0,
    state.categoryScope,
    state.ownershipInputHash,
    state.acceptedDetailIdentity,
    state.acceptedDetailHash,
    state.effectiveLocationInputHash,
    state.routeCacheIdentity,
    state.routeAssignmentIdentity,
    state.routeInputHash,
    state.routeTerminalIdentity,
    state.factualSupplementState,
    state.factualSupplementInputHash,
    state.sourceImageIdentityHash,
    state.localPrimaryState,
    state.imageInputHash,
    state.enrichmentHeadIdentity,
    state.enrichmentInputHash,
    state.scoreHeadIdentity,
    state.scoreSnapshotIdentity,
    state.scoreInputHash,
    state.sourceReleaseInputHash,
    state.projectionWorkInputHash,
    work.detail ?? null,
    work.action_deadline ?? null,
    work.owner_refresh ?? null,
    work.factual_supplement ?? null,
    work.primary_image ?? null,
    work.proximity ?? null,
    work.enrichment_text ?? null,
    work.enrichment_embedding ?? null,
    work.preference_v2_score ?? null,
    state.sourceReleaseInputHash,
    state.relevantGenerationVectorHash,
    CURRENT_PIPELINE_PROJECTION_DERIVATION_VERSION,
    nowIso,
  );
}

/**
 * Writes each small listing group atomically with all exact queue coalesces.
 * Hash-identical rows and queue items remain true no-ops.
 */
export async function writeOperationalProjectionBatch(input: {
  readonly database: D1Database;
  readonly projections: readonly MaterializedOperationalProjection[];
  readonly now?: Date;
}): Promise<{ readonly statements: number; readonly expectedWorkItems: number }> {
  if (input.projections.length > MAX_BATCH) {
    throw new RangeError(`projection writes support at most ${MAX_BATCH} listings`);
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("projection write time is invalid");
  const nowIso = now.toISOString();
  let statementCount = 0;
  let expectedWorkItems = 0;
  // At most 96 statements keeps one D1 batch comfortably bounded while each
  // listing's projection and desired queue set share one transaction.
  for (let offset = 0; offset < input.projections.length; offset += 8) {
    const statements: D1PreparedStatement[] = [];
    for (const projection of input.projections.slice(offset, offset + 8)) {
      statements.push(
        ownershipUpsertStatement(input.database, projection.ownership, nowIso),
        currentStateUpsertStatement(input.database, projection.state, nowIso),
      );
      const expectedByStage = new Map(
        projection.state.expectedWorkItems.map((item) => [item.stage, item]),
      );
      for (const stage of LISTING_DOWNSTREAM_WORK_STAGES) {
        const expected = expectedByStage.get(stage);
        if (expected) {
          expectedWorkItems += 1;
          statements.push(preparePipelineWorkCoalesceStatement({
            database: input.database,
            stage,
            subject: {
              type: "listing",
              id: projection.state.listingId,
              sourceId: projection.state.sourceId,
            },
            laneKey: expected.laneKey,
            inputHash: expected.inputHash,
            priority: expected.priority,
            reasonCode: expected.reasonCode,
            now,
          }));
        } else {
          statements.push(preparePipelineWorkDeleteIfUnclaimedStatement({
            database: input.database,
            stage,
            subjectType: "listing",
            subjectId: projection.state.listingId,
            now,
          }));
        }
      }
    }
    if (statements.length > 0) await input.database.batch(statements);
    statementCount += statements.length;
  }
  return Object.freeze({ statements: statementCount, expectedWorkItems });
}

/** Performs one bounded canonical read/derive/write keyset batch. */
export async function refreshOperationalProjectionBatch(input: {
  readonly database: D1Database;
  readonly scope: ProjectionScope;
  readonly contracts: OperationalProjectionContracts;
  readonly afterListingId?: string | null;
  readonly limit?: number;
}): Promise<ProjectionBatchResult> {
  const contracts = validateContracts(input.contracts);
  const originCacheKey = locationCacheKey({
    postalCode: contracts.originPostalCode,
    countryCode: contracts.originCountryCode ?? "US",
  });
  const listingIds = await readOperationalProjectionCandidateIds({
    database: input.database,
    scope: input.scope,
    afterListingId: input.afterListingId,
    limit: input.limit,
  });
  if (listingIds.length === 0) {
    return Object.freeze({
      listingIds,
      rowsRead: 0,
      statements: 0,
      expectedWorkItems: 0,
      nextCursor: null,
    });
  }
  const rows = await readCanonicalOperationalProjectionRows({
    database: input.database,
    listingIds,
    originCacheKey,
  });
  if (rows.length !== listingIds.length) {
    const returned = new Set(rows.map((row) => row.listing_id));
    const missing = listingIds.filter((id) => !returned.has(id));
    throw new Error(`projection canonical rows disappeared: ${missing.join(",")}`);
  }
  const projections = await Promise.all(rows.map((row) =>
    materializeOperationalProjection(row, contracts)
  ));
  const write = await writeOperationalProjectionBatch({
    database: input.database,
    projections,
    now: contracts.now,
  });
  return Object.freeze({
    listingIds,
    rowsRead: rows.length,
    statements: write.statements,
    expectedWorkItems: write.expectedWorkItems,
    nextCursor: listingIds.length === (input.limit ?? 100)
      ? listingIds.at(-1) ?? null
      : null,
  });
}

/** Refreshes one exact listing without a scope scan. */
export async function refreshOperationalProjectionListing(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly contracts: OperationalProjectionContracts;
}): Promise<ProjectionBatchResult> {
  const contracts = validateContracts(input.contracts);
  const listingId = boundedIdentity(input.listingId, "projection listing id");
  const originCacheKey = locationCacheKey({
    postalCode: contracts.originPostalCode,
    countryCode: contracts.originCountryCode ?? "US",
  });
  const rows = await readCanonicalOperationalProjectionRows({
    database: input.database,
    listingIds: [listingId],
    originCacheKey,
  });
  if (rows.length !== 1) {
    throw new Error(`projection listing ${listingId} does not exist`);
  }
  const projection = await materializeOperationalProjection(rows[0]!, contracts);
  const write = await writeOperationalProjectionBatch({
    database: input.database,
    projections: [projection],
    now: contracts.now,
  });
  return Object.freeze({
    listingIds: Object.freeze([listingId]),
    rowsRead: 1,
    statements: write.statements,
    expectedWorkItems: write.expectedWorkItems,
    nextCursor: null,
  });
}

/** Stable subject identities used by canonical group-mutation fan-out. */
export const operationalProjectionGroupIdentity = Object.freeze({
  sharedAlias(family: string, sharedCatalogKey: string): string {
    return stableGroupIdentity({
      kind: "shared_alias",
      values: [
        boundedIdentity(family, "shared alias family"),
        boundedIdentity(sharedCatalogKey, "shared catalog key"),
      ],
    });
  },
  upstreamTuple(
    platform: string,
    host: string,
    eventOrCatalogId: string,
    lotId: string,
  ): string {
    return stableGroupIdentity({
      kind: "upstream_tuple",
      values: [
        boundedIdentity(platform, "upstream platform"),
        boundedIdentity(host, "upstream host"),
        boundedIdentity(eventOrCatalogId, "upstream event identity"),
        boundedIdentity(lotId, "upstream lot identity"),
      ],
    });
  },
});

export function isProjectionHash(value: string): boolean {
  return SHA_IDENTITY.test(value);
}

/** Sanitized exact parity value; every material field is present or hash-bound. */
export function operationalProjectionAuditValue(
  projection: MaterializedOperationalProjection,
): Readonly<Record<string, unknown>> {
  const { ownership, state } = projection;
  return Object.freeze({
    listingId: state.listingId,
    sourceId: state.sourceId,
    sourceCurrent: state.sourceCurrent,
    activeInventoryRunId: state.activeInventoryRunId,
    sourcePublicationGeneration: state.sourcePublicationGeneration,
    sourceCoverageMode: state.sourceCoverageMode,
    reviewCandidate: state.reviewCandidate,
    categoryScope: state.categoryScope,
    actionableOwnerListingId: ownership.actionableOwnerListingId,
    actionableOwnerSourceId: ownership.actionableOwnerSourceId,
    ownerState: ownership.ownerState,
    ownerBasis: ownership.ownerBasis,
    ownerProofHash: ownership.ownerProofHash,
    sharedGroupIdentity: ownership.sharedGroupIdentity,
    upstreamTupleIdentity: ownership.upstreamTupleIdentity,
    counterpartState: ownership.counterpartState,
    counterpartOwnerListingId: ownership.counterpartOwnerListingId,
    counterpartOwnerSourceId: ownership.counterpartOwnerSourceId,
    counterpartAbsenceProofHash: ownership.counterpartAbsenceProofHash,
    ownershipInputHash: ownership.ownershipInputHash,
    acceptedDetailIdentity: state.acceptedDetailIdentity,
    acceptedDetailHash: state.acceptedDetailHash,
    effectiveLocationInputHash: state.effectiveLocationInputHash,
    routeCacheIdentity: state.routeCacheIdentity,
    routeAssignmentIdentity: state.routeAssignmentIdentity,
    routeInputHash: state.routeInputHash,
    routeTerminalIdentity: state.routeTerminalIdentity,
    factualSupplementState: state.factualSupplementState,
    factualSupplementInputHash: state.factualSupplementInputHash,
    sourceImageIdentityHash: state.sourceImageIdentityHash,
    localPrimaryState: state.localPrimaryState,
    imageInputHash: state.imageInputHash,
    enrichmentHeadIdentity: state.enrichmentHeadIdentity,
    enrichmentInputHash: state.enrichmentInputHash,
    scoreHeadIdentity: state.scoreHeadIdentity,
    scoreSnapshotIdentity: state.scoreSnapshotIdentity,
    scoreInputHash: state.scoreInputHash,
    sourceReleaseInputHash: state.sourceReleaseInputHash,
    projectionWorkInputHash: state.projectionWorkInputHash,
    relevantGenerationVectorHash: state.relevantGenerationVectorHash,
    projectionDerivationVersion: CURRENT_PIPELINE_PROJECTION_DERIVATION_VERSION,
    ownershipDerivationVersion: OPERATIONAL_OWNERSHIP_DERIVATION_VERSION,
  });
}

export const operationalProjectionContractIdentity = Object.freeze({
  ownership: OPERATIONAL_OWNERSHIP_DERIVATION_VERSION,
  current: CURRENT_PIPELINE_PROJECTION_DERIVATION_VERSION,
  route: LOCAL_PROXIMITY_INPUT_VERSION,
});
