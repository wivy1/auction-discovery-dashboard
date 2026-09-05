import { env } from "cloudflare:workers";
import { sha256Text } from "../ai/provenance";
import { getConfig } from "../config";
import { readCurrentAdhocReviewCandidates } from "../pipeline/storage";
import { readActiveRouteScope } from "../routing/active-scope";
import { sourceRegistry } from "../sources";
import {
  adhocReviewSelectionPolicy,
  normalizeAdhocReviewExcludedSourceIds,
  selectAdhocReviewCohort,
  type AdhocReviewSelection,
} from "./planner";
import {
  ADHOC_REVIEW_COHORT_SCHEMA_VERSION,
  configuredAdhocReviewCohortId,
  validateAdhocReviewCohortId,
} from "./runtime";
import {
  prepareCanonicalMutationPayloadInvalidationStatements,
} from "../pipeline/mutation-invalidation";

interface HeadSnapshot {
  sourceId: string;
  inventoryRunId: string;
  listingCount: number;
  publishedAt: string;
}

interface CohortHeaderRow {
  id: string;
  state: string;
  refresh_boundary: string;
  origin_cache_key: string;
  route_provider_name: string;
  selection_seed: string;
  selection_version: string;
  requested_target: number;
  selected_count: number;
  ordinary_accepted_count: number;
  distance_exempt_count: number;
  source_count: number;
  head_vector_hash: string;
  base_cohort_id: string | null;
  created_at: string;
  ready_at: string | null;
}

export interface AdhocReviewCohortStatus {
  id: string;
  state: "ready";
  refreshBoundary: string;
  originCacheKey: string;
  routeProviderName: string;
  selectionSeed: string;
  selectionVersion: string;
  requestedTarget: number;
  selectedCount: number;
  currentSelectedCount: number;
  ordinaryAcceptedCount: number;
  distanceExemptCount: number;
  sourceCount: number;
  headVectorHash: string;
  baseCohortId: string | null;
  createdAt: string;
  readyAt: string;
  bySource: Array<{
    sourceId: string;
    selected: number;
    current: number;
    ordinaryAccepted: number;
    distanceExempt: number;
    voted: number;
    firstSeenSinceBoundary: number;
    detailed: number;
    presentationReady: number;
  }>;
}

export class AdhocReviewCohortDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdhocReviewCohortDriftError";
  }
}

async function readCurrentHeadVector(): Promise<HeadSnapshot[]> {
  const result = await env.DB.prepare(`
    SELECT
      publication_head.source_id,
      publication_head.inventory_run_id,
      publication.listing_count,
      publication.published_at
    FROM source_inventory_publication_heads publication_head
    JOIN source_inventory_publications publication
      ON publication.source_id = publication_head.source_id
      AND publication.inventory_run_id = publication_head.inventory_run_id
    ORDER BY publication_head.source_id
  `).all<{
    source_id: string;
    inventory_run_id: string;
    listing_count: number;
    published_at: string;
  }>();
  return (result.results ?? []).map((row) => ({
    sourceId: row.source_id,
    inventoryRunId: row.inventory_run_id,
    listingCount: Number(row.listing_count),
    publishedAt: row.published_at,
  }));
}

async function headVectorHash(heads: readonly HeadSnapshot[]): Promise<string> {
  return sha256Text(JSON.stringify(heads.map((head) => ({
    sourceId: head.sourceId,
    inventoryRunId: head.inventoryRunId,
    listingCount: head.listingCount,
    publishedAt: head.publishedAt,
  }))));
}

async function assertNoActivePipelineLease(): Promise<void> {
  const lease = await env.DB.prepare(`
    SELECT run_kind, run_id
    FROM pipeline_run_lease
    WHERE singleton = 1
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    LIMIT 1
  `).first<{ run_kind: string; run_id: string }>();
  if (lease) {
    throw new Error(
      `Cannot plan an ad hoc review cohort while ${lease.run_kind} run ${lease.run_id} owns the pipeline lease`,
    );
  }
}

async function readCohortHeader(id: string): Promise<CohortHeaderRow> {
  const header = await env.DB.prepare(`
    SELECT * FROM adhoc_review_cohorts WHERE id = ? LIMIT 1
  `).bind(id).first<CohortHeaderRow>();
  if (!header || header.state !== "ready" || !header.ready_at) {
    throw new AdhocReviewCohortDriftError(
      `Configured ad hoc review cohort ${id} is missing or not ready`,
    );
  }
  return header;
}

export async function readAdhocReviewCohortStatus(
  rawId: string,
  expectedRouteScope?: {
    originCacheKey: string;
    providerName: string;
  },
): Promise<AdhocReviewCohortStatus> {
  const id = validateAdhocReviewCohortId(rawId);
  const header = await readCohortHeader(id);
  if (
    expectedRouteScope &&
    (
      header.origin_cache_key !== expectedRouteScope.originCacheKey ||
      header.route_provider_name !== expectedRouteScope.providerName
    )
  ) {
    throw new AdhocReviewCohortDriftError(
      `Ad hoc review cohort ${id} does not match the active origin/provider`,
    );
  }

  const [snapshotsResult, aggregate, bySourceResult, currentHeads] =
    await Promise.all([
      env.DB.prepare(`
        SELECT source_id, inventory_run_id, listing_count, published_at
        FROM adhoc_review_cohort_sources
        WHERE cohort_id = ?
        ORDER BY source_id
      `).bind(id).all<{
        source_id: string;
        inventory_run_id: string;
        listing_count: number;
        published_at: string;
      }>(),
      env.DB.prepare(`
        SELECT
          count(*) AS selected_count,
          sum(CASE WHEN basis = 'ordinary_accepted' THEN 1 ELSE 0 END)
            AS ordinary_accepted_count,
          sum(CASE WHEN basis = 'distance_exempt' THEN 1 ELSE 0 END)
            AS distance_exempt_count
        FROM adhoc_review_cohort_memberships
        WHERE cohort_id = ?
      `).bind(id).first<{
        selected_count: number;
        ordinary_accepted_count: number;
        distance_exempt_count: number;
      }>(),
      env.DB.prepare(`
        SELECT
          membership.source_id,
          count(*) AS selected_count,
          sum(CASE WHEN current_inventory.listing_id IS NOT NULL THEN 1 ELSE 0 END)
            AS current_count,
          sum(CASE WHEN membership.basis = 'ordinary_accepted' THEN 1 ELSE 0 END)
            AS ordinary_accepted_count,
          sum(CASE WHEN membership.basis = 'distance_exempt' THEN 1 ELSE 0 END)
            AS distance_exempt_count,
          sum(CASE WHEN current_inventory.listing_id IS NOT NULL
            AND vote.listing_id IS NOT NULL THEN 1 ELSE 0 END)
            AS voted_count,
          sum(CASE WHEN stub.discovered_at >= cohort.refresh_boundary THEN 1 ELSE 0 END)
            AS first_seen_count,
          sum(CASE WHEN current_inventory.listing_id IS NOT NULL
            AND detail.listing_id IS NOT NULL
            AND detail_observation.listing_id IS NOT NULL THEN 1 ELSE 0 END)
            AS detailed_count,
          sum(CASE WHEN current_inventory.listing_id IS NOT NULL AND (
            (
              NOT EXISTS (
                SELECT 1 FROM listing_images any_image
                WHERE any_image.listing_id = membership.listing_id
              )
              AND EXISTS (
                SELECT 1
                FROM listing_recovery_status proved_image_absence
                WHERE proved_image_absence.listing_id = membership.listing_id
                  AND proved_image_absence.state = 'terminal'
                  AND proved_image_absence.stage = 'image'
                  AND proved_image_absence.last_error_code =
                    'source_image_absent'
              )
            ) OR EXISTS (
              SELECT 1 FROM listing_images ready_primary
              WHERE ready_primary.listing_id = membership.listing_id
                AND ready_primary.is_primary = 1
                AND ready_primary.download_status = 'downloaded'
                AND NULLIF(TRIM(ready_primary.local_path), '') IS NOT NULL
            ) OR EXISTS (
              SELECT 1 FROM listing_recovery_status unavailable_image
              WHERE unavailable_image.listing_id = membership.listing_id
                AND unavailable_image.state = 'terminal'
                AND unavailable_image.stage = 'image'
                AND unavailable_image.last_error_code =
                  'source_image_unavailable'
            )
          ) THEN 1 ELSE 0 END) AS presentation_ready_count
        FROM adhoc_review_cohort_memberships membership
        JOIN adhoc_review_cohorts cohort ON cohort.id = membership.cohort_id
        JOIN listing_stubs stub ON stub.id = membership.listing_id
        LEFT JOIN source_current_listings current_inventory
          ON current_inventory.listing_id = membership.listing_id
          AND current_inventory.source_id = membership.source_id
          AND current_inventory.inventory_run_id = membership.inventory_run_id
          AND current_inventory.review_candidate = 1
        LEFT JOIN listing_votes vote ON vote.listing_id = membership.listing_id
        LEFT JOIN listing_details detail ON detail.listing_id = membership.listing_id
        LEFT JOIN listing_detail_observations detail_observation
          ON detail_observation.listing_id = membership.listing_id
        WHERE membership.cohort_id = ?
        GROUP BY membership.source_id
        ORDER BY membership.source_id
      `).bind(id).all<{
        source_id: string;
        selected_count: number;
        current_count: number;
        ordinary_accepted_count: number;
        distance_exempt_count: number;
        voted_count: number;
        first_seen_count: number;
        detailed_count: number;
        presentation_ready_count: number;
      }>(),
      readCurrentHeadVector(),
    ]);

  const snapshots = (snapshotsResult.results ?? []).map((row) => ({
    sourceId: row.source_id,
    inventoryRunId: row.inventory_run_id,
    listingCount: Number(row.listing_count),
    publishedAt: row.published_at,
  }));
  if (
    snapshots.length !== header.source_count ||
    snapshots.length !== sourceRegistry.size ||
    currentHeads.length !== snapshots.length ||
    snapshots.some((snapshot, index) =>
      JSON.stringify(snapshot) !== JSON.stringify(currentHeads[index])
    ) ||
    await headVectorHash(snapshots) !== header.head_vector_hash
  ) {
    throw new AdhocReviewCohortDriftError(
      `Ad hoc review cohort ${id} publication vector drifted`,
    );
  }
  const selectedCount = Number(aggregate?.selected_count ?? 0);
  const ordinaryAcceptedCount = Number(
    aggregate?.ordinary_accepted_count ?? 0,
  );
  const distanceExemptCount = Number(aggregate?.distance_exempt_count ?? 0);
  if (
    selectedCount !== header.selected_count ||
    ordinaryAcceptedCount !== header.ordinary_accepted_count ||
    distanceExemptCount !== header.distance_exempt_count
  ) {
    throw new AdhocReviewCohortDriftError(
      `Ad hoc review cohort ${id} membership counts drifted`,
    );
  }
  const bySource = (bySourceResult.results ?? []).map((row) => ({
    sourceId: row.source_id,
    selected: Number(row.selected_count),
    current: Number(row.current_count),
    ordinaryAccepted: Number(row.ordinary_accepted_count),
    distanceExempt: Number(row.distance_exempt_count),
    voted: Number(row.voted_count),
    firstSeenSinceBoundary: Number(row.first_seen_count),
    detailed: Number(row.detailed_count),
    presentationReady: Number(row.presentation_ready_count),
  }));
  return {
    id,
    state: "ready",
    refreshBoundary: header.refresh_boundary,
    originCacheKey: header.origin_cache_key,
    routeProviderName: header.route_provider_name,
    selectionSeed: header.selection_seed,
    selectionVersion: header.selection_version,
    requestedTarget: header.requested_target,
    selectedCount,
    currentSelectedCount: bySource.reduce((sum, row) => sum + row.current, 0),
    ordinaryAcceptedCount,
    distanceExemptCount,
    sourceCount: header.source_count,
    headVectorHash: header.head_vector_hash,
    baseCohortId: header.base_cohort_id,
    createdAt: header.created_at,
    readyAt: header.ready_at!,
    bySource,
  };
}

export async function readConfiguredAdhocReviewCohort(): Promise<
  AdhocReviewCohortStatus | null
> {
  const id = configuredAdhocReviewCohortId(getConfig());
  if (!id) return null;
  const routeScope = await readActiveRouteScope();
  return readAdhocReviewCohortStatus(id, routeScope);
}

function membershipInsertStatement(
  cohortId: string,
  selectedAt: string,
  selection: AdhocReviewSelection,
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO adhoc_review_cohort_memberships (
      cohort_id, listing_id, source_id, inventory_run_id, basis,
      category_stratum, state_stratum, stable_selection_key, ordinal,
      selected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    cohortId,
    selection.listingId,
    selection.sourceId,
    selection.inventoryRunId,
    selection.basis,
    selection.categoryStratum,
    selection.stateStratum,
    selection.stableSelectionKey,
    selection.ordinal,
    selectedAt,
  );
}

export async function planAdhocReviewCohort(input: {
  target: number;
  refreshBoundary: string;
  seed: string;
  baseCohortId?: string | null;
  excludeSourceIds?: readonly string[];
}): Promise<AdhocReviewCohortStatus> {
  await assertNoActivePipelineLease();
  const routeScope = await readActiveRouteScope();
  const refreshMs = Date.parse(input.refreshBoundary);
  if (!Number.isFinite(refreshMs)) {
    throw new TypeError("ad hoc review refresh boundary is invalid");
  }
  const refreshBoundary = new Date(refreshMs).toISOString();
  const seed = input.seed.trim();
  if (!seed || seed.length > 200) {
    throw new TypeError("ad hoc review seed must contain 1-200 characters");
  }
  const excludeSourceIds = normalizeAdhocReviewExcludedSourceIds(
    input.excludeSourceIds,
    sourceRegistry.keys(),
  );
  const selectionPolicy = adhocReviewSelectionPolicy(seed, excludeSourceIds);
  const baseCohortId = input.baseCohortId
    ? validateAdhocReviewCohortId(input.baseCohortId)
    : null;
  if (baseCohortId) {
    const baseHeader = await readCohortHeader(baseCohortId);
    if (
      baseHeader.origin_cache_key !== routeScope.originCacheKey ||
      baseHeader.route_provider_name !== routeScope.providerName
    ) {
      throw new AdhocReviewCohortDriftError(
        `Ad hoc review cohort ${baseCohortId} does not match the active origin/provider`,
      );
    }
  }

  const heads = await readCurrentHeadVector();
  if (heads.length !== sourceRegistry.size) {
    throw new Error(
      `Ad hoc review planning requires ${sourceRegistry.size} fresh source heads; found ${heads.length}`,
    );
  }
  const vectorHash = await headVectorHash(heads);
  const [candidates, baseMembershipResult] = await Promise.all([
    readCurrentAdhocReviewCandidates({
      originCacheKey: routeScope.originCacheKey,
      routeProviderName: routeScope.providerName,
      baseCohortId,
    }),
    baseCohortId
      ? env.DB.prepare(`
          SELECT listing_id
          FROM adhoc_review_cohort_memberships
          WHERE cohort_id = ?
        `).bind(baseCohortId).all<{ listing_id: string }>()
      : Promise.resolve({ results: [] } as {
          results: Array<{ listing_id: string }>;
        }),
  ]);
  const baseListingIds = new Set(
    (baseMembershipResult.results ?? []).map((row) => row.listing_id),
  );
  const selected = selectAdhocReviewCohort({
    candidates: candidates.map((candidate) => ({
      ...candidate,
      baseSelected: baseListingIds.has(candidate.listingId),
    })),
    target: input.target,
    seed,
    refreshBoundary,
    excludedSourceIds: excludeSourceIds,
  });
  const ordinaryAcceptedCount = selected.filter((row) =>
    row.basis === "ordinary_accepted"
  ).length;
  const selectedAt = new Date().toISOString();
  const cohortId = validateAdhocReviewCohortId(
    `adhoc-${selectedAt.slice(0, 10).replace(/-/gu, "")}-${input.target}-${crypto.randomUUID()}`,
  );
  await env.DB.prepare(`
    INSERT INTO adhoc_review_cohorts (
      id, schema_version, state, refresh_boundary, origin_cache_key,
      route_provider_name, selection_seed, selection_version,
      requested_target, selected_count, ordinary_accepted_count,
      distance_exempt_count, source_count, head_vector_hash, base_cohort_id,
      created_at, ready_at
    ) VALUES (?, ?, 'building', ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, NULL)
  `).bind(
    cohortId,
    ADHOC_REVIEW_COHORT_SCHEMA_VERSION,
    refreshBoundary,
    routeScope.originCacheKey,
    routeScope.providerName,
    selectionPolicy.selectionSeed,
    selectionPolicy.selectionVersion,
    input.target,
    heads.length,
    vectorHash,
    baseCohortId,
    selectedAt,
  ).run();
  await env.DB.batch(heads.map((head) => env.DB.prepare(`
    INSERT INTO adhoc_review_cohort_sources (
      cohort_id, source_id, inventory_run_id, listing_count, published_at
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    cohortId,
    head.sourceId,
    head.inventoryRunId,
    head.listingCount,
    head.publishedAt,
  )));
  for (let offset = 0; offset < selected.length; offset += 100) {
    await env.DB.batch(
      selected.slice(offset, offset + 100).map((selection) =>
        membershipInsertStatement(cohortId, selectedAt, selection)
      ),
    );
  }
  await assertNoActivePipelineLease();
  if (await headVectorHash(await readCurrentHeadVector()) !== vectorHash) {
    throw new AdhocReviewCohortDriftError(
      "Source heads changed while the ad hoc review cohort was being planned",
    );
  }
  const readyAt = new Date();
  const invalidation =
    await prepareCanonicalMutationPayloadInvalidationStatements({
      database: env.DB,
      generations: [{
        domain: "cohort",
        scopeType: "global",
        scopeId: "all",
        input: {
          cohortId,
          refreshBoundary,
          originCacheKey: routeScope.originCacheKey,
          routeProviderName: routeScope.providerName,
          selectionVersion: selectionPolicy.selectionVersion,
          requestedTarget: input.target,
          selectedCount: selected.length,
          ordinaryAcceptedCount,
          distanceExemptCount: selected.length - ordinaryAcceptedCount,
          sourceCount: heads.length,
          headVectorHash: vectorHash,
          baseCohortId,
        },
        derivationVersion: "cohort-ready-mutation-v1",
      }],
      refresh: {
        target: { type: "global", scopeId: "all" },
        reasonCode: "cohort_ready_changed",
        priority: 900,
      },
      aggregateGlobalDomains: false,
      now: readyAt,
    });
  await env.DB.batch([env.DB.prepare(`
    UPDATE adhoc_review_cohorts
    SET state = 'ready',
        selected_count = ?,
        ordinary_accepted_count = ?,
        distance_exempt_count = ?,
        ready_at = ?
    WHERE id = ? AND state = 'building'
  `).bind(
    selected.length,
    ordinaryAcceptedCount,
    selected.length - ordinaryAcceptedCount,
    readyAt.toISOString(),
    cohortId,
  ), ...invalidation]);
  return readAdhocReviewCohortStatus(cohortId, routeScope);
}
