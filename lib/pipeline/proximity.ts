import { env } from "cloudflare:workers";

import { getConfig } from "../config";
import type { LocationCandidate } from "../domain/listings";
import {
  ACTIVE_PREFERENCE_V2_FEATURE_VERSION,
  ACTIVE_PREFERENCE_V2_MODEL_VERSION,
} from "../preference-v2/review-runtime";
import { locationCacheKey } from "../routing/helpers";
import {
  LOCAL_PROXIMITY_INPUT_VERSION,
  LOCAL_PROXIMITY_PROVIDER_NAME,
  estimateLocalProximity,
  resolveLocalProximityDestination,
  resolveLocalProximityOrigin,
  storedLocalProximityQuery,
  type LocalProximityEstimate,
  type ResolvedLocalProximityLocation,
} from "../routing/local-proximity";
import {
  readActiveOrigin,
  readInitializedActiveOrigin,
  type ActiveOrigin,
} from "../settings/active-origin";
import { throwIfDiscoveryRunCancelled } from "./discovery-cancellation";
import {
  prepareProjectionRefreshWorkStatement,
} from "./projection-refresh";
import {
  beginDiscoveryRun,
  finishDiscoveryRun,
  readPendingNonInlineGeographicPrefilterListings,
  renewPipelineRunLease,
  type PendingNonInlineGeographicPrefilterListing,
} from "./storage";
import {
  claimPipelineWorkItems,
  completePipelineWorkClaim,
  pipelineWorkClaimIdentity,
  type PipelineWorkClaimIdentity,
} from "./work-queue";
import { listingReviewCompletedSql } from "../review-completion";

const MAX_GLOBAL_PROXIMITY_LISTINGS = 100_000;
const DATABASE_LOOKUP_CHUNK = 75;
const DATABASE_MUTATION_BATCH = 75;
const PROXIMITY_CLAIM_LIMIT = 75;
const PROXIMITY_CLAIM_LEASE_MS = 120_000;

export type SuppliedProximityClaimOutcome =
  | "completed"
  | "stale"
  | "claim_missed";

export interface SuppliedProximityClaimResult {
  readonly claim: PipelineWorkClaimIdentity;
  readonly outcome: SuppliedProximityClaimOutcome;
}

export interface LocalProximityWorkSummary {
  readonly queuedAtStart: number;
  readonly queuedAtEnd: number;
  readonly claimed: number;
  readonly completed: number;
  readonly stale: number;
  readonly projectionRefreshPending: number;
  readonly generationWatermark: number;
  readonly suppliedClaim: SuppliedProximityClaimResult | null;
}

export interface LocalProximityPassSummary {
  readonly runId: string | null;
  readonly status: "completed" | "unchanged";
  readonly originPostalCode: string;
  readonly originCacheKey: string;
  readonly providerName: typeof LOCAL_PROXIMITY_PROVIDER_NAME;
  readonly inputVersion: typeof LOCAL_PROXIMITY_INPUT_VERSION;
  readonly selectedListings: number;
  readonly currentListings: number;
  readonly historicalListings: number;
  readonly uniqueLocations: number;
  readonly evidence: Readonly<{
    sourceCoordinates: number;
    censusZcta: number;
    censusPlace: number;
    unknown: number;
  }>;
  /** Existing version-exact estimate rows reused without another write. */
  readonly cacheHits: number;
  /** New version-exact estimate rows inserted. */
  readonly calculated: number;
  readonly acceptedListings: number;
  readonly excludedListings: number;
  readonly unknownLocations: number;
  readonly locationsInserted: number;
  readonly locationsUpdated: number;
  readonly assignmentsWritten: number;
  readonly recoveriesCleared: number;
  readonly unknownTerminalsWritten: number;
  readonly mutationStatements: number;
  readonly mutationBatches: number;
  readonly externalRequests: 0;
  readonly work: Readonly<LocalProximityWorkSummary>;
  readonly timingsMs: Readonly<{
    selection: number;
    normalizeAndCalculate: number;
    cacheLookup: number;
    persistence: number;
    total: number;
  }>;
}

interface ExistingLocationRow {
  readonly id: string;
  readonly cache_key: string;
  readonly city: string | null;
  readonly state: string | null;
  readonly postal_code: string | null;
  readonly country_code: string;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly resolution_status: string;
  readonly geocode_provider: string | null;
  readonly geocode_error: string | null;
}

interface ExistingRouteRow {
  readonly id: string;
  readonly destination_cache_key: string;
  readonly input_hash: string;
}

interface DestinationWork {
  readonly destination: ResolvedLocalProximityLocation;
  readonly estimate: LocalProximityEstimate;
  readonly listings: ProximityPassListing[];
  locationId: string;
  routeId: string;
}

interface ProximityPassListing
  extends PendingNonInlineGeographicPrefilterListing {
  readonly historyOnly: boolean;
  readonly projectionGeneration: number | null;
  readonly claim: PipelineWorkClaimIdentity | null;
}

interface ProximityQueuePreflight {
  readonly queued: number;
  readonly projection_refresh_pending: number;
  readonly generation_watermark: number;
}

interface ClaimedProximityRow {
  readonly listing_id: string;
  readonly source_id: string;
  readonly source_listing_id: string;
  readonly source_url: string;
  readonly title: string;
  readonly category: string | null;
  readonly lot_number: string | null;
  readonly visible_city: string | null;
  readonly visible_state: string | null;
  readonly visible_postal_code: string | null;
  readonly visible_country_code: string | null;
  readonly location_evidence_source: string | null;
  readonly thumbnail_url: string | null;
  readonly discovered_at: string;
  readonly content_hash: string;
  readonly pickup_city: string | null;
  readonly pickup_state: string | null;
  readonly pickup_postal_code: string | null;
  readonly pickup_country_code: string | null;
  readonly pickup_evidence_source: string | null;
  readonly has_complete_detail: number;
  readonly assigned_origin_cache_key: string | null;
  readonly assigned_provider_name: string | null;
  readonly assigned_input_hash: string | null;
  readonly assigned_destination_cache_key: string | null;
  readonly assigned_route_error_code: string | null;
  readonly recovery_state: "retryable" | "terminal" | null;
  readonly recovery_stage: string | null;
  readonly recovery_error_code: string | null;
  readonly history_only: number;
  readonly projection_generation: number | null;
  readonly lease_owner: string;
  readonly claimed_input_hash: string;
  readonly claimed_revision: number;
}

/**
 * Routine mutation-driven proximity path. The first query is an indexed
 * generation/queue snapshot; a clean database returns before creating a run
 * or touching any mutable route/dashboard state.
 */
export async function runLocalProximityPass(input: {
  readonly signal?: AbortSignal;
  readonly queueClaim?: PipelineWorkClaimIdentity;
} = {}): Promise<LocalProximityPassSummary> {
  const startedAt = performance.now();
  throwIfDiscoveryRunCancelled(input.signal);
  const preflight = await readProximityQueuePreflight();
  const activeOrigin = preflight.queued === 0
    ? await readInitializedActiveOrigin()
    : await readActiveOrigin();
  const originCacheKey = locationCacheKey({
    postalCode: activeOrigin.postalCode,
    countryCode: activeOrigin.countryCode,
  });
  if (preflight.queued === 0) {
    if (preflight.projection_refresh_pending > 0) {
      throw new Error(
        "Approximate proximity is waiting for pending operational projection refresh work",
      );
    }
    return unchangedSummary({
      activeOrigin,
      originCacheKey,
      preflight,
      suppliedClaim: input.queueClaim === undefined
        ? null
        : { claim: input.queueClaim, outcome: "claim_missed" },
      totalMs: performance.now() - startedAt,
    });
  }
  if (preflight.projection_refresh_pending > 0) {
    throw new Error(
      "Approximate proximity cannot claim work while operational projections are pending",
    );
  }

  const config = getConfig();
  const origin = resolveLocalProximityOrigin(
    activeOrigin.postalCode,
    activeOrigin.countryCode,
  );
  if (!origin.coordinates) {
    throw new Error(
      `The active origin ZIP ${activeOrigin.postalCode} is not present in the bundled Census ZCTA dataset`,
    );
  }
  const runId = await beginDiscoveryRun(
    "scheduled",
    activeOrigin.postalCode,
    config.limits.discoveryRunLeaseMs,
  );
  const counters = { discovered: 0, newListings: 0, accepted: 0, excluded: 0 };
  const evidence = {
    sourceCoordinates: 0,
    censusZcta: 0,
    censusPlace: 0,
    unknown: 0,
  };
  const seenDestinations = new Set<string>();
  let selectedListings = 0;
  let currentListings = 0;
  let historicalListings = 0;
  let cacheHits = 0;
  let calculated = 0;
  let acceptedListings = 0;
  let excludedListings = 0;
  let unknownLocations = 0;
  let locationsInserted = 0;
  let locationsUpdated = 0;
  let assignmentsWritten = 0;
  let recoveriesCleared = 0;
  let unknownTerminalsWritten = 0;
  let mutationStatements = 0;
  let mutationBatches = 0;
  let claimed = 0;
  let completed = 0;
  let stale = 0;
  let selectionMs = 0;
  let calculationMs = 0;
  let cacheMs = 0;
  let persistenceMs = 0;
  let stopForStaleInput = false;
  let suppliedClaim: SuppliedProximityClaimResult | null = null;

  const accumulate = (input: {
    readonly listings: readonly ProximityPassListing[];
    readonly result: ClaimedProximityProcessResult;
  }) => {
    selectedListings += input.listings.length;
    currentListings += input.listings.filter((listing) => !listing.historyOnly).length;
    historicalListings += input.listings.filter((listing) => listing.historyOnly).length;
    cacheHits += input.result.cacheHits;
    calculated += input.result.calculated;
    acceptedListings += input.result.acceptedListings;
    excludedListings += input.result.excludedListings;
    unknownLocations += input.result.unknownLocations;
    locationsInserted += input.result.locationsInserted;
    locationsUpdated += input.result.locationsUpdated;
    assignmentsWritten += input.result.assignmentsWritten;
    recoveriesCleared += input.result.recoveriesCleared;
    unknownTerminalsWritten += input.result.unknownTerminalsWritten;
    mutationStatements += input.result.mutationStatements;
    mutationBatches += input.result.mutationBatches;
    completed += input.result.completed;
    stale += input.result.stale;
    if (input.result.stale > 0) stopForStaleInput = true;
    calculationMs += input.result.calculationMs;
    cacheMs += input.result.cacheMs;
    persistenceMs += input.result.persistenceMs;
    for (const destination of input.result.destinations) {
      if (seenDestinations.has(destination.groupingKey)) continue;
      seenDestinations.add(destination.groupingKey);
      switch (destination.evidenceKind) {
        case "source_coordinates": evidence.sourceCoordinates += 1; break;
        case "census_zcta": evidence.censusZcta += 1; break;
        case "census_place": evidence.censusPlace += 1; break;
        case "unknown": evidence.unknown += 1; break;
      }
    }
  };

  try {
    if (input.queueClaim !== undefined) {
      const selectionStartedAt = performance.now();
      const listings = await readClaimedProximityListings({
        claims: [input.queueClaim],
        originCacheKey,
      });
      selectionMs += performance.now() - selectionStartedAt;
      if (listings.length === 0) {
        const outcome = await completePipelineWorkClaim({
          database: env.DB,
          claim: input.queueClaim,
        });
        suppliedClaim = {
          claim: input.queueClaim,
          outcome: outcome.outcome === "completed"
            ? "completed"
            : outcome.outcome === "stale_released"
            ? "stale"
            : "claim_missed",
        };
        if (outcome.outcome === "completed") {
          claimed += 1;
          completed += 1;
        } else if (outcome.outcome === "stale_released") {
          claimed += 1;
          stale += 1;
          stopForStaleInput = true;
        }
      } else {
        claimed += 1;
        const result = await processClaimedProximityListings({
          listings,
          origin,
          originCacheKey,
          runId,
          runLeaseMs: config.limits.discoveryRunLeaseMs,
          signal: input.signal,
        });
        accumulate({ listings, result });
        suppliedClaim = {
          claim: input.queueClaim,
          outcome: result.completed === 1 ? "completed" : "stale",
        };
      }
    }

    while (!stopForStaleInput && claimed < MAX_GLOBAL_PROXIMITY_LISTINGS) {
      throwIfDiscoveryRunCancelled(input.signal);
      const selectionStartedAt = performance.now();
      const claim = await claimPipelineWorkItems({
        database: env.DB,
        stage: "proximity",
        owner: runId,
        limit: Math.min(
          PROXIMITY_CLAIM_LIMIT,
          MAX_GLOBAL_PROXIMITY_LISTINGS - claimed,
        ),
        leaseMs: PROXIMITY_CLAIM_LEASE_MS,
      });
      claimed += claim.items.length;
      if (claim.items.length === 0) {
        selectionMs += performance.now() - selectionStartedAt;
        break;
      }
      const listings = await readClaimedProximityListings({
        claims: claim.items.map(pipelineWorkClaimIdentity),
        originCacheKey,
      });
      selectionMs += performance.now() - selectionStartedAt;
      const byIdentity = new Map(listings.map((listing) => [listing.listingId, listing]));
      for (const item of claim.items) {
        if (byIdentity.has(item.subjectId)) continue;
        const outcome = await completePipelineWorkClaim({
          database: env.DB,
          claim: pipelineWorkClaimIdentity(item),
        });
        if (outcome.outcome === "completed") completed += 1;
        else {
          stale += 1;
          stopForStaleInput = true;
        }
      }
      if (stopForStaleInput) break;
      if (listings.length === 0) continue;

      const result = await processClaimedProximityListings({
        listings,
        origin,
        originCacheKey,
        runId,
        runLeaseMs: config.limits.discoveryRunLeaseMs,
        signal: input.signal,
      });
      accumulate({ listings, result });
      if (stopForStaleInput) break;
    }
    if (claimed >= MAX_GLOBAL_PROXIMITY_LISTINGS) {
      const remaining = await readProximityQueuePreflight();
      if (remaining.queued > 0) {
        throw new Error(
          `Approximate proximity exceeds ${MAX_GLOBAL_PROXIMITY_LISTINGS} queued listings`,
        );
      }
    }
    counters.accepted = acceptedListings;
    counters.excluded = excludedListings;
    const finalPreflight = await readProximityQueuePreflight();
    await finishDiscoveryRun(runId, "completed", counters, undefined, "preserve");
    return {
      runId,
      status: "completed",
      originPostalCode: activeOrigin.postalCode,
      originCacheKey,
      providerName: LOCAL_PROXIMITY_PROVIDER_NAME,
      inputVersion: LOCAL_PROXIMITY_INPUT_VERSION,
      selectedListings,
      currentListings,
      historicalListings,
      uniqueLocations: seenDestinations.size,
      evidence,
      cacheHits,
      calculated,
      acceptedListings,
      excludedListings,
      unknownLocations,
      locationsInserted,
      locationsUpdated,
      assignmentsWritten,
      recoveriesCleared,
      unknownTerminalsWritten,
      mutationStatements,
      mutationBatches,
      externalRequests: 0,
      work: {
        queuedAtStart: preflight.queued,
        queuedAtEnd: finalPreflight.queued,
        claimed,
        completed,
        stale,
        projectionRefreshPending: preflight.projection_refresh_pending,
        generationWatermark: preflight.generation_watermark,
        suppliedClaim,
      },
      timingsMs: {
        selection: roundedMilliseconds(selectionMs),
        normalizeAndCalculate: roundedMilliseconds(calculationMs),
        cacheLookup: roundedMilliseconds(cacheMs),
        persistence: roundedMilliseconds(persistenceMs),
        total: roundedMilliseconds(performance.now() - startedAt),
      },
    };
  } catch (error) {
    await finishDiscoveryRun(runId, "failed", counters, error, "preserve");
    throw error;
  }
}

/**
 * Canonical broad selector retained only for explicit rebuild, parity audit,
 * and shadow comparison. Routine/nightly callers use `runLocalProximityPass`.
 */
export async function runCanonicalLocalProximityPassForAudit(input: {
  readonly signal?: AbortSignal;
} = {}): Promise<LocalProximityPassSummary> {
  const startedAt = performance.now();
  throwIfDiscoveryRunCancelled(input.signal);
  const config = getConfig();
  const activeOrigin = await readActiveOrigin();
  const origin = resolveLocalProximityOrigin(
    activeOrigin.postalCode,
    activeOrigin.countryCode,
  );
  if (!origin.coordinates) {
    throw new Error(
      `The active origin ZIP ${activeOrigin.postalCode} is not present in the bundled Census ZCTA dataset`,
    );
  }
  // Retain the established origin scope identity used by dashboard, recovery,
  // ad-hoc cohort, and immutable historical consumers. Estimator/dataset
  // versions live in each route input hash and do not churn unrelated scopes.
  const originCacheKey = locationCacheKey({
    postalCode: activeOrigin.postalCode,
    countryCode: activeOrigin.countryCode,
  });
  const runId = await beginDiscoveryRun(
    "scheduled",
    activeOrigin.postalCode,
    config.limits.discoveryRunLeaseMs,
  );
  const counters = { discovered: 0, newListings: 0, accepted: 0, excluded: 0 };

  try {
    const selectionStartedAt = performance.now();
    const currentListings = await readPendingNonInlineGeographicPrefilterListings({
      sourceId: null,
      originCacheKey,
      routeProviderName: LOCAL_PROXIMITY_PROVIDER_NAME,
      limit: MAX_GLOBAL_PROXIMITY_LISTINGS,
      includeAssigned: true,
      includeTerminalRoute: true,
      includeUnresolvedLocationEvidence: true,
      includeAdhocReviewCohort: true,
    });
    const historicalListings = await readPreferenceHistoryProximityListings();
    const listings: ProximityPassListing[] = [
      ...currentListings.map((listing) => ({
        ...listing,
        historyOnly: false,
        projectionGeneration: null,
        claim: null,
      })),
      ...historicalListings,
    ];
    const selectionMs = performance.now() - selectionStartedAt;
    throwIfDiscoveryRunCancelled(input.signal);

    const calculationStartedAt = performance.now();
    const workByKey = new Map<string, DestinationWork>();
    const evidence = {
      sourceCoordinates: 0,
      censusZcta: 0,
      censusPlace: 0,
      unknown: 0,
    };
    for (const listing of listings) {
      const destination = resolveLocalProximityDestination(
        listing.prefilterLocation,
      );
      let work = workByKey.get(destination.groupingKey);
      if (!work) {
        const estimate = await estimateLocalProximity(origin, destination);
        work = {
          destination,
          estimate,
          listings: [],
          locationId: "",
          routeId: "",
        };
        workByKey.set(destination.groupingKey, work);
        switch (destination.evidenceKind) {
          case "source_coordinates":
            evidence.sourceCoordinates += 1;
            break;
          case "census_zcta":
            evidence.censusZcta += 1;
            break;
          case "census_place":
            evidence.censusPlace += 1;
            break;
          case "unknown":
            evidence.unknown += 1;
            break;
        }
      }
      work.listings.push(listing);
    }
    const calculationMs = performance.now() - calculationStartedAt;

    const cacheStartedAt = performance.now();
    const work = [...workByKey.values()];
    const existingLocations = await readExistingLocations(
      work.map((item) => item.destination.cacheKey),
    );
    const existingRoutes = await readExistingRoutes(originCacheKey);
    const cacheMs = performance.now() - cacheStartedAt;

    const persistenceStartedAt = performance.now();
    let locationsInserted = 0;
    let locationsUpdated = 0;
    let mutationStatements = 0;
    let mutationBatches = 0;
    const now = new Date().toISOString();
    const locationStatements: D1PreparedStatement[] = [];
    for (const item of work) {
      const existing = existingLocations.get(item.destination.cacheKey);
      const desired = persistedLocation(item.destination);
      if (existing) {
        item.locationId = existing.id;
        if (!locationMatches(existing, desired)) {
          locationsUpdated += 1;
          locationStatements.push(env.DB.prepare(`
            UPDATE locations
            SET city = ?, state = ?, postal_code = ?, country_code = ?,
                display_name = ?, latitude = ?, longitude = ?,
                resolution_status = ?, geocode_provider = ?, geocoded_at = ?,
                geocode_error = ?, updated_at = ?
            WHERE id = ?
          `).bind(
            desired.city,
            desired.state,
            desired.postalCode,
            desired.countryCode,
            desired.displayName,
            desired.latitude,
            desired.longitude,
            desired.status,
            desired.provider,
            desired.status === "resolved" ? now : null,
            desired.error,
            now,
            existing.id,
          ));
        }
      } else {
        item.locationId = `loc_${crypto.randomUUID()}`;
        locationsInserted += 1;
        locationStatements.push(env.DB.prepare(`
          INSERT INTO locations (
            id, cache_key, city, state, postal_code, country_code, display_name,
            latitude, longitude, resolution_status, geocode_provider,
            geocoded_at, geocode_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          item.locationId,
          item.destination.cacheKey,
          desired.city,
          desired.state,
          desired.postalCode,
          desired.countryCode,
          desired.displayName,
          desired.latitude,
          desired.longitude,
          desired.status,
          desired.provider,
          desired.status === "resolved" ? now : null,
          desired.error,
          now,
          now,
        ));
      }
    }
    ({ statements: mutationStatements, batches: mutationBatches } =
      await runMutationBatches(locationStatements, {
        runId,
        leaseMs: config.limits.discoveryRunLeaseMs,
        signal: input.signal,
        statements: mutationStatements,
        batches: mutationBatches,
      }));

    let cacheHits = 0;
    let calculated = 0;
    const routeStatements: D1PreparedStatement[] = [];
    for (const item of work) {
      const key = routeLookupKey(
        item.destination.cacheKey,
        item.estimate.inputHash,
      );
      const existing = existingRoutes.get(key);
      if (existing) {
        item.routeId = existing.id;
        cacheHits += 1;
        continue;
      }
      item.routeId = `rte_${crypto.randomUUID()}`;
      calculated += 1;
      routeStatements.push(env.DB.prepare(`
        INSERT INTO route_cache (
          id, origin_cache_key, destination_location_id, provider_name,
          input_hash, drive_seconds, distance_meters, drive_bucket,
          is_approximate, calculated_at, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).bind(
        item.routeId,
        originCacheKey,
        item.locationId,
        LOCAL_PROXIMITY_PROVIDER_NAME,
        item.estimate.inputHash,
        item.estimate.estimatedDriveSeconds,
        item.estimate.directMeters === null
          ? null
          : Math.round(item.estimate.directMeters),
        item.estimate.bucket,
        now,
        item.estimate.errorCode,
      ));
    }
    ({ statements: mutationStatements, batches: mutationBatches } =
      await runMutationBatches(routeStatements, {
        runId,
        leaseMs: config.limits.discoveryRunLeaseMs,
        signal: input.signal,
        statements: mutationStatements,
        batches: mutationBatches,
      }));

    let assignmentsWritten = 0;
    let recoveriesCleared = 0;
    let unknownTerminalsWritten = 0;
    let acceptedListings = 0;
    let excludedListings = 0;
    let unknownLocations = 0;
    const assignmentStatements: D1PreparedStatement[] = [];
    const recoveryStatements: D1PreparedStatement[] = [];
    for (const item of work) {
      const unknown = item.estimate.errorCode === "unknown_location";
      const accepted = unknown || (
        item.estimate.errorCode === null && item.estimate.bucket !== "exclude"
      );
      for (const listing of item.listings) {
        if (accepted) acceptedListings += 1;
        else excludedListings += 1;
        if (unknown) unknownLocations += 1;

        const assignmentMatches =
          listing.assignedOriginCacheKey === originCacheKey &&
          listing.assignedProviderName === LOCAL_PROXIMITY_PROVIDER_NAME &&
          listing.assignedInputHash === item.estimate.inputHash &&
          listing.assignedDestinationCacheKey === item.destination.cacheKey;
        if (!assignmentMatches) {
          assignmentsWritten += 1;
          assignmentStatements.push(env.DB.prepare(`
            INSERT INTO listing_routes (listing_id, route_cache_id, assigned_at)
            VALUES (?, ?, ?)
            ON CONFLICT(listing_id) DO UPDATE SET
              route_cache_id = excluded.route_cache_id,
              assigned_at = excluded.assigned_at
          `).bind(listing.listingId, item.routeId, now));
        }

        if (listing.historyOnly) {
          continue;
        }
        if (item.estimate.errorCode === null) {
          if (listing.recoveryStage === "route") {
            recoveriesCleared += 1;
            recoveryStatements.push(env.DB.prepare(`
              DELETE FROM listing_recovery_status
              WHERE listing_id = ? AND origin_cache_key = ? AND stage = 'route'
            `).bind(listing.listingId, originCacheKey));
          }
        } else if (
          listing.recoveryStage === null || listing.recoveryStage === "route"
        ) {
          const terminalMatches =
            listing.recoveryState === "terminal" &&
            listing.recoveryStage === "route" &&
            listing.recoveryErrorCode === "unknown_location";
          if (!terminalMatches) {
            unknownTerminalsWritten += 1;
            recoveryStatements.push(env.DB.prepare(`
              INSERT INTO listing_recovery_status (
                listing_id, origin_cache_key, state, stage, attempt_count,
                last_attempted_at, last_error_code
              ) VALUES (?, ?, 'terminal', 'route', 1, ?, 'unknown_location')
              ON CONFLICT(listing_id, origin_cache_key) DO UPDATE SET
                state = 'terminal',
                stage = 'route',
                last_attempted_at = excluded.last_attempted_at,
                last_error_code = 'unknown_location'
            `).bind(listing.listingId, originCacheKey, now));
          }
        }
      }
    }
    ({ statements: mutationStatements, batches: mutationBatches } =
      await runMutationBatches(assignmentStatements, {
        runId,
        leaseMs: config.limits.discoveryRunLeaseMs,
        signal: input.signal,
        statements: mutationStatements,
        batches: mutationBatches,
      }));
    ({ statements: mutationStatements, batches: mutationBatches } =
      await runMutationBatches(recoveryStatements, {
        runId,
        leaseMs: config.limits.discoveryRunLeaseMs,
        signal: input.signal,
        statements: mutationStatements,
        batches: mutationBatches,
      }));

    counters.accepted = acceptedListings;
    counters.excluded = excludedListings;
    const persistenceMs = performance.now() - persistenceStartedAt;
    await finishDiscoveryRun(runId, "completed", counters, undefined, "preserve");
    return {
      runId,
      status: "completed",
      originPostalCode: activeOrigin.postalCode,
      originCacheKey,
      providerName: LOCAL_PROXIMITY_PROVIDER_NAME,
      inputVersion: LOCAL_PROXIMITY_INPUT_VERSION,
      selectedListings: listings.length,
      currentListings: currentListings.length,
      historicalListings: historicalListings.length,
      uniqueLocations: work.length,
      evidence,
      cacheHits,
      calculated,
      acceptedListings,
      excludedListings,
      unknownLocations,
      locationsInserted,
      locationsUpdated,
      assignmentsWritten,
      recoveriesCleared,
      unknownTerminalsWritten,
      mutationStatements,
      mutationBatches,
      externalRequests: 0,
      work: {
        queuedAtStart: 0,
        queuedAtEnd: 0,
        claimed: 0,
        completed: 0,
        stale: 0,
        projectionRefreshPending: 0,
        generationWatermark: 0,
        suppliedClaim: null,
      },
      timingsMs: {
        selection: roundedMilliseconds(selectionMs),
        normalizeAndCalculate: roundedMilliseconds(calculationMs),
        cacheLookup: roundedMilliseconds(cacheMs),
        persistence: roundedMilliseconds(persistenceMs),
        total: roundedMilliseconds(performance.now() - startedAt),
      },
    };
  } catch (error) {
    await finishDiscoveryRun(runId, "failed", counters, error, "preserve");
    throw error;
  }
}

async function readProximityQueuePreflight(): Promise<ProximityQueuePreflight> {
  const row = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM pipeline_work_items
        WHERE stage = 'proximity') AS queued,
      (SELECT COUNT(*) FROM pipeline_work_items
        WHERE stage IN (
          'projection_listing_refresh', 'projection_source_refresh',
          'projection_group_refresh', 'projection_global_refresh'
        )) AS projection_refresh_pending,
      (SELECT COALESCE(MAX(generation), 0)
        FROM pipeline_generation_state) AS generation_watermark
  `).first<ProximityQueuePreflight>();
  return {
    queued: nonnegativeInteger(row?.queued, "proximity queue count"),
    projection_refresh_pending: nonnegativeInteger(
      row?.projection_refresh_pending,
      "projection refresh queue count",
    ),
    generation_watermark: nonnegativeInteger(
      row?.generation_watermark,
      "pipeline generation watermark",
    ),
  };
}

function unchangedSummary(input: {
  readonly activeOrigin: ActiveOrigin;
  readonly originCacheKey: string;
  readonly preflight: ProximityQueuePreflight;
  readonly suppliedClaim: SuppliedProximityClaimResult | null;
  readonly totalMs: number;
}): LocalProximityPassSummary {
  return {
    runId: null,
    status: "unchanged",
    originPostalCode: input.activeOrigin.postalCode,
    originCacheKey: input.originCacheKey,
    providerName: LOCAL_PROXIMITY_PROVIDER_NAME,
    inputVersion: LOCAL_PROXIMITY_INPUT_VERSION,
    selectedListings: 0,
    currentListings: 0,
    historicalListings: 0,
    uniqueLocations: 0,
    evidence: { sourceCoordinates: 0, censusZcta: 0, censusPlace: 0, unknown: 0 },
    cacheHits: 0,
    calculated: 0,
    acceptedListings: 0,
    excludedListings: 0,
    unknownLocations: 0,
    locationsInserted: 0,
    locationsUpdated: 0,
    assignmentsWritten: 0,
    recoveriesCleared: 0,
    unknownTerminalsWritten: 0,
    mutationStatements: 0,
    mutationBatches: 0,
    externalRequests: 0,
    work: {
      queuedAtStart: input.preflight.queued,
      queuedAtEnd: input.preflight.queued,
      claimed: 0,
      completed: 0,
      stale: 0,
      projectionRefreshPending: input.preflight.projection_refresh_pending,
      generationWatermark: input.preflight.generation_watermark,
      suppliedClaim: input.suppliedClaim,
    },
    timingsMs: {
      selection: roundedMilliseconds(input.totalMs),
      normalizeAndCalculate: 0,
      cacheLookup: 0,
      persistence: 0,
      total: roundedMilliseconds(input.totalMs),
    },
  };
}

async function readClaimedProximityListings(input: {
  readonly claims: readonly PipelineWorkClaimIdentity[];
  readonly originCacheKey: string;
}): Promise<readonly ProximityPassListing[]> {
  const claims = input.claims.flatMap((claim) =>
    claim.stage === "proximity" && claim.subjectType === "listing"
      ? [claim]
      : []
  );
  if (claims.length === 0) return Object.freeze([]);
  const rows = await env.DB.prepare(`
    SELECT
      s.id AS listing_id,
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
      detail.pickup_city,
      detail.pickup_state,
      detail.pickup_postal_code,
      detail.pickup_country_code,
      detail.pickup_evidence_source,
      CASE WHEN detail_observation.listing_id IS NULL THEN 0 ELSE 1 END
        AS has_complete_detail,
      assigned_route.origin_cache_key AS assigned_origin_cache_key,
      assigned_route.provider_name AS assigned_provider_name,
      assigned_route.input_hash AS assigned_input_hash,
      assigned_destination.cache_key AS assigned_destination_cache_key,
      assigned_route.error_code AS assigned_route_error_code,
      recovery.state AS recovery_state,
      recovery.stage AS recovery_stage,
      recovery.last_error_code AS recovery_error_code,
      CASE WHEN projected.listing_id IS NULL THEN 1 ELSE 0 END AS history_only,
      projected.update_generation AS projection_generation,
      work.lease_owner,
      work.claimed_input_hash,
      work.claimed_revision
    FROM pipeline_work_items work
    JOIN json_each(?) exact_claim
      ON work.stage = json_extract(exact_claim.value, '$.stage')
      AND work.subject_type = json_extract(exact_claim.value, '$.subjectType')
      AND work.subject_id = json_extract(exact_claim.value, '$.subjectId')
      AND work.lease_owner = json_extract(exact_claim.value, '$.owner')
      AND work.claimed_input_hash = json_extract(exact_claim.value, '$.inputHash')
      AND work.claimed_revision = json_extract(exact_claim.value, '$.revision')
    JOIN listing_stubs s ON s.id = work.listing_id
    LEFT JOIN listing_current_pipeline_state projected
      ON projected.listing_id = s.id
      AND projected.source_current = 1
      AND projected.review_candidate = 1
      AND projected.proximity_work_input_hash = work.claimed_input_hash
    LEFT JOIN listing_operational_ownership ownership
      ON ownership.listing_id = projected.listing_id
      AND ownership.actionable_owner_listing_id = projected.listing_id
    LEFT JOIN listing_details detail ON detail.listing_id = s.id
    LEFT JOIN listing_detail_observations detail_observation
      ON detail_observation.listing_id = detail.listing_id
      AND detail_observation.detail_content_hash = detail.content_hash
    LEFT JOIN listing_routes assignment ON assignment.listing_id = s.id
    LEFT JOIN route_cache assigned_route
      ON assigned_route.id = assignment.route_cache_id
    LEFT JOIN locations assigned_destination
      ON assigned_destination.id = assigned_route.destination_location_id
    LEFT JOIN listing_recovery_status recovery
      ON recovery.listing_id = s.id AND recovery.origin_cache_key = ?
    WHERE work.stage = 'proximity'
      AND work.subject_type = 'listing'
      AND work.claimed_input_hash IS NOT NULL
      AND work.claimed_revision IS NOT NULL
      AND NOT ${listingReviewCompletedSql("s.id")}
      AND (
        ownership.listing_id IS NOT NULL
        OR (
          EXISTS (
            SELECT 1 FROM preference_shadow_scores_v2 active_score
            WHERE active_score.listing_id = s.id
              AND active_score.promotion_state =
                'shadow_only_pending_prospective'
              AND active_score.model_version = ?
              AND active_score.feature_version = ?
          )
          AND NOT EXISTS (
            SELECT 1
            FROM source_current_listings active_current
            JOIN source_inventory_publication_heads active_head
              ON active_head.source_id = active_current.source_id
              AND active_head.inventory_run_id = active_current.inventory_run_id
            WHERE active_current.listing_id = s.id
              AND active_current.review_candidate = 1
          )
        )
      )
    ORDER BY s.id
  `).bind(
    JSON.stringify(claims),
    input.originCacheKey,
    ACTIVE_PREFERENCE_V2_MODEL_VERSION ?? "inactive",
    ACTIVE_PREFERENCE_V2_FEATURE_VERSION,
  ).all<ClaimedProximityRow>();

  return Object.freeze((rows.results ?? []).map((row): ProximityPassListing => {
    const cardLocation = storedProximityLocation({
      city: row.visible_city,
      state: row.visible_state,
      postalCode: row.visible_postal_code,
      countryCode: row.visible_country_code,
      evidenceSource: row.location_evidence_source,
      fallbackEvidenceSource: "visible_listing",
    });
    const detailLocation = row.has_complete_detail === 1
      ? storedProximityLocation({
          city: row.pickup_city,
          state: row.pickup_state,
          postalCode: row.pickup_postal_code,
          countryCode: row.pickup_country_code,
          evidenceSource: row.pickup_evidence_source,
          fallbackEvidenceSource: "detail_page",
        })
      : null;
    return {
      historyOnly: row.history_only === 1,
      projectionGeneration: row.projection_generation === null
        ? null
        : Number(row.projection_generation),
      claim: Object.freeze({
        stage: "proximity",
        subjectType: "listing",
        subjectId: row.listing_id,
        owner: row.lease_owner,
        inputHash: row.claimed_input_hash,
        revision: Number(row.claimed_revision),
      } satisfies PipelineWorkClaimIdentity),
      listingId: row.listing_id,
      prefilterLocation: detailLocation ?? cardLocation,
      hasCompleteDetail: row.has_complete_detail === 1,
      routeAttemptCount: 0,
      assignedOriginCacheKey: row.assigned_origin_cache_key,
      assignedProviderName: row.assigned_provider_name,
      assignedInputHash: row.assigned_input_hash,
      assignedDestinationCacheKey: row.assigned_destination_cache_key,
      assignedRouteErrorCode: row.assigned_route_error_code,
      recoveryState: row.recovery_state,
      recoveryStage: storedRecoveryStage(row.recovery_stage),
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
  }));
}

interface ClaimedProximityProcessResult {
  readonly destinations: readonly ResolvedLocalProximityLocation[];
  readonly cacheHits: number;
  readonly calculated: number;
  readonly acceptedListings: number;
  readonly excludedListings: number;
  readonly unknownLocations: number;
  readonly locationsInserted: number;
  readonly locationsUpdated: number;
  readonly assignmentsWritten: number;
  readonly recoveriesCleared: number;
  readonly unknownTerminalsWritten: number;
  readonly mutationStatements: number;
  readonly mutationBatches: number;
  readonly completed: number;
  readonly stale: number;
  readonly calculationMs: number;
  readonly cacheMs: number;
  readonly persistenceMs: number;
}

async function processClaimedProximityListings(input: {
  readonly listings: readonly ProximityPassListing[];
  readonly origin: ReturnType<typeof resolveLocalProximityOrigin>;
  readonly originCacheKey: string;
  readonly runId: string;
  readonly runLeaseMs: number;
  readonly signal?: AbortSignal;
}): Promise<ClaimedProximityProcessResult> {
  const calculationStartedAt = performance.now();
  const workByKey = new Map<string, DestinationWork>();
  for (const listing of input.listings) {
    const destination = resolveLocalProximityDestination(listing.prefilterLocation);
    let work = workByKey.get(destination.groupingKey);
    if (!work) {
      work = {
        destination,
        estimate: await estimateLocalProximity(input.origin, destination),
        listings: [],
        locationId: "",
        routeId: "",
      };
      workByKey.set(destination.groupingKey, work);
    }
    if (listing.claim?.inputHash !== work.estimate.inputHash) {
      throw new Error(
        `Claimed proximity input changed before calculation for ${listing.listingId}`,
      );
    }
    work.listings.push(listing);
  }
  const calculationMs = performance.now() - calculationStartedAt;
  const work = [...workByKey.values()];

  const cacheStartedAt = performance.now();
  const existingLocations = await readExistingLocations(
    work.map((item) => item.destination.cacheKey),
  );
  const existingRoutes = await readExistingRoutes(
    input.originCacheKey,
    work.map((item) => item.destination.cacheKey),
  );
  const cacheMs = performance.now() - cacheStartedAt;

  const persistenceStartedAt = performance.now();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  let mutationStatements = 0;
  let mutationBatches = 0;
  let locationsInserted = 0;
  let locationsUpdated = 0;
  const locationStatements: D1PreparedStatement[] = [];
  for (const item of work) {
    const existing = existingLocations.get(item.destination.cacheKey);
    const desired = persistedLocation(item.destination);
    if (existing) {
      item.locationId = existing.id;
      if (!locationMatches(existing, desired)) {
        locationsUpdated += 1;
        locationStatements.push(env.DB.prepare(`
          UPDATE locations SET city = ?, state = ?, postal_code = ?,
            country_code = ?, display_name = ?, latitude = ?, longitude = ?,
            resolution_status = ?, geocode_provider = ?, geocoded_at = ?,
            geocode_error = ?, updated_at = ? WHERE id = ?
        `).bind(
          desired.city, desired.state, desired.postalCode, desired.countryCode,
          desired.displayName, desired.latitude, desired.longitude,
          desired.status, desired.provider,
          desired.status === "resolved" ? now : null, desired.error, now,
          existing.id,
        ));
      }
    } else {
      item.locationId = `loc_${crypto.randomUUID()}`;
      locationsInserted += 1;
      locationStatements.push(env.DB.prepare(`
        INSERT INTO locations (
          id, cache_key, city, state, postal_code, country_code, display_name,
          latitude, longitude, resolution_status, geocode_provider,
          geocoded_at, geocode_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        item.locationId, item.destination.cacheKey,
        desired.city, desired.state, desired.postalCode, desired.countryCode,
        desired.displayName, desired.latitude, desired.longitude,
        desired.status, desired.provider,
        desired.status === "resolved" ? now : null, desired.error, now, now,
      ));
    }
  }
  ({ statements: mutationStatements, batches: mutationBatches } =
    await runMutationBatches(locationStatements, {
      runId: input.runId,
      leaseMs: input.runLeaseMs,
      signal: input.signal,
      statements: mutationStatements,
      batches: mutationBatches,
    }));

  let cacheHits = 0;
  let calculated = 0;
  const routeStatements: D1PreparedStatement[] = [];
  for (const item of work) {
    const existing = existingRoutes.get(routeLookupKey(
      item.destination.cacheKey,
      item.estimate.inputHash,
    ));
    if (existing) {
      item.routeId = existing.id;
      cacheHits += 1;
      continue;
    }
    item.routeId = `rte_${crypto.randomUUID()}`;
    calculated += 1;
    routeStatements.push(env.DB.prepare(`
      INSERT INTO route_cache (
        id, origin_cache_key, destination_location_id, provider_name,
        input_hash, drive_seconds, distance_meters, drive_bucket,
        is_approximate, calculated_at, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      item.routeId, input.originCacheKey, item.locationId,
      LOCAL_PROXIMITY_PROVIDER_NAME, item.estimate.inputHash,
      item.estimate.estimatedDriveSeconds,
      item.estimate.directMeters === null
        ? null
        : Math.round(item.estimate.directMeters),
      item.estimate.bucket, now, item.estimate.errorCode,
    ));
  }
  ({ statements: mutationStatements, batches: mutationBatches } =
    await runMutationBatches(routeStatements, {
      runId: input.runId,
      leaseMs: input.runLeaseMs,
      signal: input.signal,
      statements: mutationStatements,
      batches: mutationBatches,
    }));

  const commits: ProximityListingCommit[] = [];
  let acceptedListings = 0;
  let excludedListings = 0;
  let unknownLocations = 0;
  for (const item of work) {
    const unknown = item.estimate.errorCode === "unknown_location";
    const accepted = unknown || (
      item.estimate.errorCode === null && item.estimate.bucket !== "exclude"
    );
    for (const listing of item.listings) {
      if (accepted) acceptedListings += 1;
      else excludedListings += 1;
      if (unknown) unknownLocations += 1;
      commits.push(await proximityListingCommit({
        listing,
        item,
        originCacheKey: input.originCacheKey,
        now: nowDate,
      }));
    }
  }
  const committed = await runProximityListingCommitBatches({
    commits,
    runId: input.runId,
    leaseMs: input.runLeaseMs,
    signal: input.signal,
  });
  mutationStatements += committed.statements;
  mutationBatches += committed.batches;

  return {
    destinations: Object.freeze(work.map((item) => item.destination)),
    cacheHits,
    calculated,
    acceptedListings,
    excludedListings,
    unknownLocations,
    locationsInserted,
    locationsUpdated,
    assignmentsWritten: committed.assignmentsWritten,
    recoveriesCleared: committed.recoveriesCleared,
    unknownTerminalsWritten: committed.unknownTerminalsWritten,
    mutationStatements,
    mutationBatches,
    completed: committed.completed,
    stale: committed.stale,
    calculationMs,
    cacheMs,
    persistenceMs: performance.now() - persistenceStartedAt,
  };
}

interface ProximityListingCommit {
  readonly claim: PipelineWorkClaimIdentity;
  readonly statements: readonly D1PreparedStatement[];
  readonly assignmentIndex: number | null;
  readonly recoveryIndex: number | null;
  readonly recoveryKind: "clear" | "terminal" | null;
  readonly completionIndex: number;
}

async function proximityListingCommit(input: {
  readonly listing: ProximityPassListing;
  readonly item: DestinationWork;
  readonly originCacheKey: string;
  readonly now: Date;
}): Promise<ProximityListingCommit> {
  if (!input.listing.claim) throw new Error("Proximity queue listing has no claim");
  const claim = input.listing.claim;
  const statements: D1PreparedStatement[] = [];
  const claimPredicate = `
    EXISTS (
      SELECT 1 FROM pipeline_work_items exact_work
      WHERE exact_work.stage = 'proximity'
        AND exact_work.subject_type = 'listing'
        AND exact_work.subject_id = ?
        AND exact_work.lease_owner = ?
        AND exact_work.claimed_input_hash = ?
        AND exact_work.claimed_revision = ?
        AND exact_work.input_hash = ?
        AND exact_work.revision = ?
        AND NOT ${listingReviewCompletedSql("exact_work.subject_id")}
    )
  `;
  const claimBindings = [
    claim.subjectId, claim.owner, claim.inputHash, claim.revision,
    claim.inputHash, claim.revision,
  ] as const;
  const assignmentMatches =
    input.listing.assignedOriginCacheKey === input.originCacheKey &&
    input.listing.assignedProviderName === LOCAL_PROXIMITY_PROVIDER_NAME &&
    input.listing.assignedInputHash === input.item.estimate.inputHash &&
    input.listing.assignedDestinationCacheKey === input.item.destination.cacheKey;
  let assignmentIndex: number | null = null;
  if (!assignmentMatches) {
    assignmentIndex = statements.length;
    statements.push(env.DB.prepare(`
      INSERT INTO listing_routes (listing_id, route_cache_id, assigned_at)
      SELECT ?, ?, ? WHERE ${claimPredicate}
      ON CONFLICT(listing_id) DO UPDATE SET
        route_cache_id = excluded.route_cache_id,
        assigned_at = excluded.assigned_at
    `).bind(
      input.listing.listingId,
      input.item.routeId,
      input.now.toISOString(),
      ...claimBindings,
    ));
  }

  let recoveryIndex: number | null = null;
  let recoveryKind: ProximityListingCommit["recoveryKind"] = null;
  if (!input.listing.historyOnly) {
    if (
      input.item.estimate.errorCode === null &&
      input.listing.recoveryStage === "route"
    ) {
      recoveryIndex = statements.length;
      recoveryKind = "clear";
      statements.push(env.DB.prepare(`
        DELETE FROM listing_recovery_status
        WHERE listing_id = ? AND origin_cache_key = ? AND stage = 'route'
          AND ${claimPredicate}
      `).bind(
        input.listing.listingId,
        input.originCacheKey,
        ...claimBindings,
      ));
    } else if (
      input.item.estimate.errorCode === "unknown_location" &&
      (input.listing.recoveryStage === null ||
        input.listing.recoveryStage === "route") &&
      !(
        input.listing.recoveryState === "terminal" &&
        input.listing.recoveryStage === "route" &&
        input.listing.recoveryErrorCode === "unknown_location"
      )
    ) {
      recoveryIndex = statements.length;
      recoveryKind = "terminal";
      statements.push(env.DB.prepare(`
        INSERT INTO listing_recovery_status (
          listing_id, origin_cache_key, state, stage, attempt_count,
          last_attempted_at, last_error_code
        )
        SELECT ?, ?, 'terminal', 'route', 1, ?, 'unknown_location'
        WHERE ${claimPredicate}
        ON CONFLICT(listing_id, origin_cache_key) DO UPDATE SET
          state = 'terminal', stage = 'route',
          last_attempted_at = excluded.last_attempted_at,
          last_error_code = 'unknown_location'
      `).bind(
        input.listing.listingId,
        input.originCacheKey,
        input.now.toISOString(),
        ...claimBindings,
      ));
    }
    statements.push(prepareProjectionRefreshWorkStatement({
      database: env.DB,
      desired: {
        target: {
          type: "listing",
          listingId: input.listing.listingId,
          sourceId: input.listing.stub.sourceId,
        },
        inputHash: input.item.estimate.inputHash,
        targetGeneration: input.listing.projectionGeneration ?? 1,
        reasonCode: "proximity_assignment_changed",
        priority: 600,
        now: input.now,
      },
    }));
  }
  const completionIndex = statements.length;
  statements.push(env.DB.prepare(`
    DELETE FROM pipeline_work_items
    WHERE stage = 'proximity' AND subject_type = 'listing' AND subject_id = ?
      AND lease_owner = ? AND claimed_input_hash = ? AND claimed_revision = ?
      AND input_hash = ? AND revision = ?
  `).bind(
    claim.subjectId, claim.owner, claim.inputHash, claim.revision,
    claim.inputHash, claim.revision,
  ));
  return { claim, statements, assignmentIndex, recoveryIndex, recoveryKind, completionIndex };
}

async function runProximityListingCommitBatches(input: {
  readonly commits: readonly ProximityListingCommit[];
  readonly runId: string;
  readonly leaseMs: number;
  readonly signal?: AbortSignal;
}): Promise<{
  statements: number;
  batches: number;
  assignmentsWritten: number;
  recoveriesCleared: number;
  unknownTerminalsWritten: number;
  completed: number;
  stale: number;
}> {
  let statements = 0;
  let batches = 0;
  let assignmentsWritten = 0;
  let recoveriesCleared = 0;
  let unknownTerminalsWritten = 0;
  let completed = 0;
  let stale = 0;
  for (let offset = 0; offset < input.commits.length;) {
    const selected: ProximityListingCommit[] = [];
    let size = 0;
    while (offset < input.commits.length) {
      const next = input.commits[offset]!;
      if (selected.length > 0 && size + next.statements.length > DATABASE_MUTATION_BATCH) {
        break;
      }
      selected.push(next);
      size += next.statements.length;
      offset += 1;
    }
    throwIfDiscoveryRunCancelled(input.signal);
    await renewPipelineRunLease("discovery", input.runId, input.leaseMs);
    const results = await env.DB.batch(selected.flatMap((entry) => entry.statements));
    statements += size;
    batches += 1;
    let base = 0;
    for (const commit of selected) {
      if (
        commit.assignmentIndex !== null &&
        resultChanges(results[base + commit.assignmentIndex]) === 1
      ) assignmentsWritten += 1;
      if (
        commit.recoveryIndex !== null &&
        resultChanges(results[base + commit.recoveryIndex]) === 1
      ) {
        if (commit.recoveryKind === "clear") recoveriesCleared += 1;
        else if (commit.recoveryKind === "terminal") unknownTerminalsWritten += 1;
      }
      if (resultChanges(results[base + commit.completionIndex]) === 1) {
        completed += 1;
      } else {
        const outcome = await completePipelineWorkClaim({
          database: env.DB,
          claim: commit.claim,
        });
        if (outcome.outcome === "completed") completed += 1;
        else stale += 1;
      }
      base += commit.statements.length;
    }
  }
  return {
    statements,
    batches,
    assignmentsWritten,
    recoveriesCleared,
    unknownTerminalsWritten,
    completed,
    stale,
  };
}

async function readPreferenceHistoryProximityListings(): Promise<
  ProximityPassListing[]
> {
  if (ACTIVE_PREFERENCE_V2_MODEL_VERSION === null) return [];

  const rows = await env.DB.prepare(`
    WITH active_history AS (
      SELECT DISTINCT listing_id
      FROM preference_shadow_scores_v2
      WHERE promotion_state = 'shadow_only_pending_prospective'
        AND model_version = ?
        AND feature_version = ?
    ), active_current AS (
      SELECT current_listing.listing_id
      FROM source_current_listings current_listing
      JOIN source_inventory_publication_heads current_head
        ON current_head.source_id = current_listing.source_id
        AND current_head.inventory_run_id = current_listing.inventory_run_id
      WHERE current_listing.review_candidate = 1
    )
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
      detail.pickup_city,
      detail.pickup_state,
      detail.pickup_postal_code,
      detail.pickup_country_code,
      detail.pickup_evidence_source,
      EXISTS (
        SELECT 1
        FROM listing_detail_observations observation
        WHERE observation.listing_id = s.id
          AND detail.listing_id IS NOT NULL
          AND observation.detail_content_hash = detail.content_hash
      ) AS has_complete_detail,
      assigned_route.origin_cache_key AS assigned_origin_cache_key,
      assigned_route.provider_name AS assigned_provider_name,
      assigned_route.input_hash AS assigned_input_hash,
      assigned_destination.cache_key AS assigned_destination_cache_key,
      assigned_route.error_code AS assigned_route_error_code
    FROM active_history history
    JOIN listing_stubs s ON s.id = history.listing_id
    LEFT JOIN listing_details detail ON detail.listing_id = s.id
    LEFT JOIN listing_routes assignment ON assignment.listing_id = s.id
    LEFT JOIN route_cache assigned_route
      ON assigned_route.id = assignment.route_cache_id
    LEFT JOIN locations assigned_destination
      ON assigned_destination.id = assigned_route.destination_location_id
    WHERE NOT EXISTS (
      SELECT 1 FROM active_current WHERE active_current.listing_id = s.id
    )
    ORDER BY s.id
  `).bind(
    ACTIVE_PREFERENCE_V2_MODEL_VERSION,
    ACTIVE_PREFERENCE_V2_FEATURE_VERSION,
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
    pickup_city: string | null;
    pickup_state: string | null;
    pickup_postal_code: string | null;
    pickup_country_code: string | null;
    pickup_evidence_source: string | null;
    has_complete_detail: number;
    assigned_origin_cache_key: string | null;
    assigned_provider_name: string | null;
    assigned_input_hash: string | null;
    assigned_destination_cache_key: string | null;
    assigned_route_error_code: string | null;
  }>();

  return (rows.results ?? []).map((row) => {
    const cardLocation = storedProximityLocation({
      city: row.visible_city,
      state: row.visible_state,
      postalCode: row.visible_postal_code,
      countryCode: row.visible_country_code,
      evidenceSource: row.location_evidence_source,
      fallbackEvidenceSource: "visible_listing",
    });
    const detailLocation = row.has_complete_detail === 1
      ? storedProximityLocation({
          city: row.pickup_city,
          state: row.pickup_state,
          postalCode: row.pickup_postal_code,
          countryCode: row.pickup_country_code,
          evidenceSource: row.pickup_evidence_source,
          fallbackEvidenceSource: "detail_page",
        })
      : null;
    return {
      historyOnly: true,
      projectionGeneration: null,
      claim: null,
      listingId: row.id,
      prefilterLocation: detailLocation ?? cardLocation,
      hasCompleteDetail: row.has_complete_detail === 1,
      routeAttemptCount: 0,
      assignedOriginCacheKey: row.assigned_origin_cache_key,
      assignedProviderName: row.assigned_provider_name,
      assignedInputHash: row.assigned_input_hash,
      assignedDestinationCacheKey: row.assigned_destination_cache_key,
      assignedRouteErrorCode: row.assigned_route_error_code,
      recoveryState: null,
      recoveryStage: null,
      recoveryErrorCode: null,
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

function storedProximityLocation(input: {
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly evidenceSource: string | null;
  readonly fallbackEvidenceSource: "visible_listing" | "detail_page";
}): LocationCandidate | null {
  const query = storedLocalProximityQuery(input);
  if (query === null) return null;
  const supportedEvidence = new Set([
    "visible_listing",
    "detail_page",
    "description",
    "removal",
    "inspection",
    "other",
    "unknown",
  ]);
  return {
    city: query.city ?? null,
    state: query.state ?? null,
    postalCode: query.postalCode ?? null,
    countryCode: query.countryCode ?? "ZZ",
    evidenceSource: supportedEvidence.has(input.evidenceSource ?? "")
      ? input.evidenceSource as
        | "visible_listing"
        | "detail_page"
        | "description"
        | "removal"
        | "inspection"
        | "other"
        | "unknown"
      : input.fallbackEvidenceSource,
  };
}

async function readExistingLocations(
  cacheKeys: readonly string[],
): Promise<Map<string, ExistingLocationRow>> {
  const result = new Map<string, ExistingLocationRow>();
  for (let offset = 0; offset < cacheKeys.length; offset += DATABASE_LOOKUP_CHUNK) {
    const chunk = cacheKeys.slice(offset, offset + DATABASE_LOOKUP_CHUNK);
    if (chunk.length === 0) continue;
    const rows = await env.DB.prepare(`
      SELECT id, cache_key, city, state, postal_code, country_code,
        latitude, longitude, resolution_status, geocode_provider, geocode_error
      FROM locations
      WHERE cache_key IN (${chunk.map(() => "?").join(", ")})
    `).bind(...chunk).all<ExistingLocationRow>();
    for (const row of rows.results ?? []) result.set(row.cache_key, row);
  }
  return result;
}

async function readExistingRoutes(
  originCacheKey: string,
  destinationCacheKeys?: readonly string[],
): Promise<Map<string, ExistingRouteRow>> {
  const result = new Map<string, ExistingRouteRow>();
  const chunks = destinationCacheKeys === undefined
    ? [undefined]
    : Array.from(
        { length: Math.ceil(destinationCacheKeys.length / DATABASE_LOOKUP_CHUNK) },
        (_, index) => destinationCacheKeys.slice(
          index * DATABASE_LOOKUP_CHUNK,
          (index + 1) * DATABASE_LOOKUP_CHUNK,
        ),
      );
  for (const chunk of chunks) {
    if (chunk?.length === 0) continue;
    const filter = chunk === undefined
      ? ""
      : ` AND destination.cache_key IN (${chunk.map(() => "?").join(", ")})`;
    const rows = await env.DB.prepare(`
      SELECT route.id, destination.cache_key AS destination_cache_key,
        route.input_hash
      FROM route_cache route
      JOIN locations destination ON destination.id = route.destination_location_id
      WHERE route.origin_cache_key = ? AND route.provider_name = ?${filter}
    `).bind(
      originCacheKey,
      LOCAL_PROXIMITY_PROVIDER_NAME,
      ...(chunk ?? []),
    ).all<ExistingRouteRow>();
    for (const row of rows.results ?? []) {
      result.set(routeLookupKey(row.destination_cache_key, row.input_hash), row);
    }
  }
  return result;
}

function persistedLocation(destination: ResolvedLocalProximityLocation) {
  const query = destination.normalizedQuery;
  // Persist only fields that participate in this normalized geographic
  // identity. Incidental listing text must not rewrite a shared ZIP/place row
  // when the actual coordinate and estimator input are unchanged.
  const canonical = destination.evidenceKind === "census_zcta"
    ? {
        city: null,
        state: null,
        postalCode: query.postalCode,
        countryCode: "US",
      }
    : destination.evidenceKind === "census_place"
    ? {
        city: query.city,
        state: query.state,
        postalCode: null,
        countryCode: "US",
      }
    : destination.evidenceKind === "source_coordinates"
    ? {
        city: null,
        state: null,
        postalCode: null,
        countryCode: "ZZ",
      }
    : {
        city: query.city,
        state: query.state,
        postalCode: query.postalCode,
        countryCode: query.countryCode ?? "ZZ",
      };
  return {
    ...canonical,
    displayName: destination.evidenceKind === "census_zcta"
      ? `ZIP ${canonical.postalCode} Census ZCTA internal point`
      : destination.evidenceKind === "census_place"
      ? `${canonical.city}, ${canonical.state} Census PLACE envelope center`
      : destination.evidenceKind === "source_coordinates"
      ? "Source-provided pickup coordinates"
      : "Unknown pickup location",
    latitude: destination.coordinates?.latitude ?? null,
    longitude: destination.coordinates?.longitude ?? null,
    status: destination.coordinates ? "resolved" as const : "unknown" as const,
    provider: `local_proximity:${destination.evidenceKind}`,
    error: destination.coordinates ? null : "unknown_location",
  };
}

function locationMatches(
  existing: ExistingLocationRow,
  desired: ReturnType<typeof persistedLocation>,
): boolean {
  return existing.city === desired.city &&
    existing.state === desired.state &&
    existing.postal_code === desired.postalCode &&
    existing.country_code === desired.countryCode &&
    existing.latitude === desired.latitude &&
    existing.longitude === desired.longitude &&
    existing.resolution_status === desired.status &&
    existing.geocode_provider === desired.provider &&
    existing.geocode_error === desired.error;
}

async function runMutationBatches(
  prepared: readonly D1PreparedStatement[],
  state: {
    readonly runId: string;
    readonly leaseMs: number;
    readonly signal?: AbortSignal;
    readonly statements: number;
    readonly batches: number;
  },
): Promise<{ statements: number; batches: number }> {
  let statements = state.statements;
  let batches = state.batches;
  for (let offset = 0; offset < prepared.length; offset += DATABASE_MUTATION_BATCH) {
    throwIfDiscoveryRunCancelled(state.signal);
    await renewPipelineRunLease("discovery", state.runId, state.leaseMs);
    const batch = prepared.slice(offset, offset + DATABASE_MUTATION_BATCH);
    await env.DB.batch(batch);
    statements += batch.length;
    batches += 1;
  }
  return { statements, batches };
}

function routeLookupKey(destinationCacheKey: string, inputHash: string): string {
  return `${destinationCacheKey}\u0000${inputHash}`;
}

function roundedMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function nonnegativeInteger(value: unknown, label: string): number {
  const numeric = Number(value ?? 0);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`${label} is invalid`);
  }
  return numeric;
}

function resultChanges(result: D1Result | undefined): number {
  return Math.max(0, Number(result?.meta.changes ?? 0));
}

function storedRecoveryStage(value: string | null):
  ProximityPassListing["recoveryStage"] {
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
