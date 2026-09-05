import { assessExplicitUsZipPrefilter } from "./routing/zip-prefilter";

export interface DashboardRouteInventoryRow {
  sourceId: string;
  pickupPostalCode: string | null;
  /** Missing country evidence deliberately fails the US-only prefilter open. */
  pickupCountryCode?: string | null;
  driveBucket: string | null;
  errorCode: string | null;
  /** Historical cohort metadata only; never a route-acceptance signal. */
  distanceExempt?: boolean;
  /** Persisted active-origin scope/prefilter decision needing no point estimate. */
  terminalPrefilterExclusion?: boolean;
}

export interface DashboardReviewInventoryRow extends DashboardRouteInventoryRow {
  vote: string | null;
  /** Exact current source filters that expose this one physical review row. */
  sourceMemberships?: readonly string[];
  /**
   * True once the row has accepted active-origin proximity and a ready or
   * terminal presentation image. This is deliberately independent of the
   * enrichment and Preference V2 review gates below.
   */
  coreReady?: boolean;
  /** True after the current extraction, semantic, embedding, and score chain. */
  enrichmentReady: boolean;
  /** True only after current enrichment and current-profile ranking are ready. */
  reviewReady: boolean;
}

export interface DashboardPresentationImageState {
  /** Source-card presentation only; a null/blank value is never absence proof. */
  thumbnailUrl?: string | null;
  /** Exact zero-image terminal proof recorded by the preparation pipeline. */
  provedSourceImageAbsent: boolean;
  /** Exact terminal proof that preserved source-image bytes are unavailable. */
  provedSourceImageUnavailable?: boolean;
  primaryImageStatus: string | null;
  primaryImageLocalPath: string | null;
}

/** The one presentation-readiness rule shared by dashboard and source release. */
export function dashboardPresentationImageReady(
  row: DashboardPresentationImageState,
): boolean {
  return row.provedSourceImageAbsent || row.provedSourceImageUnavailable === true || (
    row.primaryImageStatus === "downloaded" &&
    typeof row.primaryImageLocalPath === "string" &&
    row.primaryImageLocalPath.trim().length > 0
  );
}

export interface DashboardRouteHealth {
  /** Current operational-owner/review-candidate rows evaluated for proximity. */
  scope: number;
  completed: number;
  review: number;
  excluded: number;
  unknown: number;
  errors: number;
  pending: number;
}

export interface DashboardSourceAcceptanceInventoryRow {
  sourceId: string;
  unresolvedActionableCurrentListings: number;
}

const reviewBuckets = new Set(["under_2h", "under_4h", "under_8h"]);

/** Local safety ceiling; the client renders the complete payload in 100-card batches. */
export const DASHBOARD_LISTING_QUERY_LIMIT = 25_000;

/**
 * Converts authoritative current-inventory gaps into atomic source blockers.
 * Callers supply the adapters governed by the new cohort contract so an
 * already-accepted source is not retroactively reclassified by a newer
 * adapter's preparation rule.
 */
export function sourceIdsWithUnresolvedAcceptanceCandidates(
  rows: readonly DashboardSourceAcceptanceInventoryRow[],
  governedSourceIds: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    rows.flatMap((row) =>
      governedSourceIds.has(row.sourceId) &&
        row.unresolvedActionableCurrentListings > 0
        ? [row.sourceId]
        : []
    ),
  );
}

export function reviewReadySourceIds(
  rows: readonly DashboardReviewInventoryRow[],
  blockedSourceIds: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const readyBySource = new Map<string, boolean>();
  for (const row of rows) {
    if (!dashboardRowHasAcceptedReviewEligibility(row)) continue;
    const memberships = row.sourceMemberships?.length
      ? row.sourceMemberships
      : [row.sourceId];
    for (const sourceId of memberships) {
      readyBySource.set(
        sourceId,
        (readyBySource.get(sourceId) ?? true) && row.reviewReady,
      );
    }
  }
  return new Set(
    [...readyBySource.entries()]
      .filter(([sourceId, ready]) => ready && !blockedSourceIds.has(sourceId))
      .map(([sourceId]) => sourceId),
  );
}

export function countUnvotedDashboardReviewListings(
  rows: readonly DashboardReviewInventoryRow[],
  blockedSourceIds: ReadonlySet<string> = new Set(),
): number {
  const readySources = reviewReadySourceIds(rows, blockedSourceIds);
  return rows.filter((row) =>
    dashboardRowIsReviewable(row, readySources) &&
    row.vote !== "interested" &&
    row.vote !== "not_interested"
  ).length;
}

export function countDashboardReviewListings(
  rows: readonly DashboardReviewInventoryRow[],
  blockedSourceIds: ReadonlySet<string> = new Set(),
): number {
  const readySources = reviewReadySourceIds(rows, blockedSourceIds);
  return rows.filter((row) => dashboardRowIsReviewable(row, readySources)).length;
}

export function countEnrichmentReadyDashboardListings(
  rows: readonly DashboardReviewInventoryRow[],
): number {
  return rows.filter((row) =>
    dashboardRowHasAcceptedReviewEligibility(row) && row.enrichmentReady
  ).length;
}

export function assertCompleteDashboardListingCoverage(
  expected: number,
  returned: number,
  limit = DASHBOARD_LISTING_QUERY_LIMIT,
): void {
  if (expected > limit) {
    throw new Error(
      `Dashboard review inventory has ${expected} rows, above the bounded ${limit}-row surface; add pagination before operator review.`,
    );
  }
  if (returned !== expected) {
    throw new Error(
      `Dashboard review inventory mismatch: expected ${expected} ready rows but loaded ${returned}; refusing to silently omit listings.`,
    );
  }
}

function dashboardRowIsReviewable(
  row: DashboardReviewInventoryRow,
  readySources: ReadonlySet<string>,
): boolean {
  return dashboardRowHasReadyPresentationSource(row, readySources) &&
    row.reviewReady &&
    dashboardRowHasAcceptedReviewEligibility(row);
}

export function dashboardRowHasReadyPresentationSource(
  row: Pick<DashboardReviewInventoryRow, "sourceId" | "sourceMemberships" | "vote">,
  readySources: ReadonlySet<string>,
): boolean {
  return readySources.has(row.sourceId);
}

export function dashboardRowHasAcceptedReviewEligibility(
  row: DashboardRouteInventoryRow,
): boolean {
  if (row.terminalPrefilterExclusion) return false;
  return !row.errorCode && row.driveBucket !== null && reviewBuckets.has(row.driveBucket);
}

/**
 * Core dashboard visibility is intentionally weaker than review readiness:
 * an accepted approximate route and one settled image are enough to show a
 * published card while maintenance work catches up.
 */
export function dashboardRowIsCoreReady(
  row: DashboardRouteInventoryRow & Partial<Pick<
    DashboardReviewInventoryRow,
    "coreReady" | "enrichmentReady" | "reviewReady" | "vote"
  >>,
): boolean {
  return row.coreReady === true && dashboardRowHasAcceptedReviewEligibility(row);
}

/**
 * Classifies current rows against the active-origin approximate-proximity
 * contract. A deterministic unknown location is complete diagnostic work, but
 * remains unresolved and cannot enter the accepted review count.
 */
export function summarizeDashboardRouteHealth(
  rows: readonly DashboardRouteInventoryRow[],
  originPostalCode: string,
): DashboardRouteHealth {
  const summary: DashboardRouteHealth = {
    scope: rows.length,
    completed: 0,
    review: 0,
    excluded: 0,
    unknown: 0,
    errors: 0,
    pending: 0,
  };

  for (const row of rows) {
    if (
      row.terminalPrefilterExclusion ||
      assessExplicitUsZipPrefilter(
        originPostalCode,
        row.pickupPostalCode,
        row.pickupCountryCode,
      ).decision ===
        "terminal_impossible"
    ) {
      summary.completed += 1;
      summary.excluded += 1;
      continue;
    }
    if (row.errorCode) {
      if (row.errorCode === "unknown_location") {
        summary.completed += 1;
        summary.unknown += 1;
        continue;
      }
      summary.errors += 1;
      continue;
    }
    if (row.driveBucket && reviewBuckets.has(row.driveBucket)) {
      summary.completed += 1;
      summary.review += 1;
      continue;
    }
    if (row.driveBucket === "exclude") {
      summary.completed += 1;
      summary.excluded += 1;
      continue;
    }
    summary.pending += 1;
  }

  return summary;
}
