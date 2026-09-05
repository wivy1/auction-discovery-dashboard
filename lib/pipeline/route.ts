import { env } from "cloudflare:workers";

import { getConfig } from "../config";
import type { LocationCandidate } from "../domain/listings";
import { locationCacheKey } from "../routing/helpers";
import {
  LOCAL_PROXIMITY_PROVIDER_NAME,
  estimateLocalProximity,
  resolveLocalProximityDestination,
  resolveLocalProximityOrigin,
  type LocalProximityEstimate,
} from "../routing/local-proximity";
import type { GeocodedLocation, RouteResult } from "../routing/types";
import {
  prepareCanonicalMutationPayloadInvalidationStatements,
} from "./mutation-invalidation";
import { storeLocation } from "./storage";

export interface PickupRouteAssessor {
  readonly origin: GeocodedLocation;
  assess(
    location: LocationCandidate | null,
    listingId: string,
    options?: PickupRouteAssessmentOptions,
  ): Promise<{ destination: GeocodedLocation; route: RouteResult }>;
  persistForListing(
    listingId: string,
    destination: GeocodedLocation,
    route: RouteResult,
  ): Promise<void>;
}

export interface PickupRouteOrigin {
  readonly postalCode: string;
  readonly countryCode: string;
}

/** Retained only as a source-call compatibility shape; local outcomes do not retry. */
export interface PickupRouteAssessmentOptions {
  readonly retryCachedUnknownLocation?: boolean;
}

/**
 * Local compatibility assessor for source canaries and direct discovery paths.
 * Normal nightly execution uses the global pass in `proximity.ts`; this seam
 * keeps every remaining caller deterministic and network-free.
 */
export async function createPickupRouteAssessor(
  originOverride?: PickupRouteOrigin,
): Promise<PickupRouteAssessor> {
  const config = getConfig();
  const originPostalCode = originOverride?.postalCode ?? config.originPostalCode;
  const originCountryCode = originOverride?.countryCode ?? config.originCountry;
  const localOrigin = resolveLocalProximityOrigin(
    originPostalCode,
    originCountryCode,
  );
  if (!localOrigin.coordinates) {
    throw new Error(
      `Origin ZIP ${originPostalCode} is not present in the bundled Census ZCTA dataset`,
    );
  }
  const origin: GeocodedLocation = {
    cacheKey: localOrigin.cacheKey,
    query: localOrigin.normalizedQuery,
    coordinates: localOrigin.coordinates,
    displayName: `ZIP ${localOrigin.normalizedQuery.postalCode} Census ZCTA internal point`,
    status: "resolved",
    providerName: LOCAL_PROXIMITY_PROVIDER_NAME,
    resolvedAt: new Date().toISOString(),
    fromCache: true,
  };
  const estimates = new Map<string, LocalProximityEstimate>();

  return {
    origin,
    async assess(location) {
      const localDestination = resolveLocalProximityDestination(location);
      const estimate = await estimateLocalProximity(localOrigin, localDestination);
      estimates.set(localDestination.cacheKey, estimate);
      return {
        destination: {
          cacheKey: localDestination.cacheKey,
          query: localDestination.normalizedQuery,
          coordinates: localDestination.coordinates,
          displayName: localDestination.evidenceKind === "unknown"
            ? "Unknown pickup location"
            : localDestination.groupingKey,
          status: localDestination.coordinates ? "resolved" : "unknown",
          providerName: `local_proximity:${localDestination.evidenceKind}`,
          resolvedAt: new Date().toISOString(),
          fromCache: false,
        },
        route: routeResult(estimate),
      };
    },
    async persistForListing(listingId, destination) {
      const estimate = estimates.get(destination.cacheKey);
      if (!estimate) {
        throw new Error("Local proximity assessment is missing for persistence");
      }
      const destinationLocationId = await storeLocation({
        cacheKey: destination.cacheKey,
        city: destination.query.city?.trim() || null,
        state: destination.query.state?.trim().toUpperCase() || null,
        postalCode: destination.query.postalCode?.trim() || null,
        countryCode: destination.query.countryCode?.trim().toUpperCase() || "ZZ",
        latitude: destination.coordinates?.latitude ?? null,
        longitude: destination.coordinates?.longitude ?? null,
        provider: destination.providerName,
        displayName: destination.displayName,
        status: destination.coordinates ? "resolved" : "unknown",
        error: destination.coordinates ? null : "unknown_location",
      });
      await persistAndAssign({
        listingId,
        destinationLocationId,
        originCacheKey: locationCacheKey({
          postalCode: originPostalCode,
          countryCode: originCountryCode,
        }),
        estimate,
      });
    },
  };
}

function routeResult(estimate: LocalProximityEstimate): RouteResult {
  return {
    providerName: LOCAL_PROXIMITY_PROVIDER_NAME,
    status: estimate.status,
    driveSeconds: estimate.estimatedDriveSeconds,
    // `distance_meters` now intentionally stores raw great-circle distance.
    distanceMeters: estimate.directMeters,
    straightLineMeters: estimate.directMeters,
    bucket: estimate.bucket,
    approximate: true,
    calculatedAt: new Date().toISOString(),
    fromCache: false,
    errorCode: estimate.errorCode ?? undefined,
  };
}

async function persistAndAssign(input: {
  readonly listingId: string;
  readonly destinationLocationId: string;
  readonly originCacheKey: string;
  readonly estimate: LocalProximityEstimate;
}): Promise<void> {
  const routeId = `rte_${crypto.randomUUID()}`;
  const now = new Date();
  const nowIso = now.toISOString();
  const source = await env.DB.prepare(`
    SELECT source_id FROM listing_stubs WHERE id = ? LIMIT 1
  `).bind(input.listingId).first<{ source_id: string }>();
  if (!source?.source_id) {
    throw new Error("Local proximity listing source is missing");
  }
  const invalidation =
    await prepareCanonicalMutationPayloadInvalidationStatements({
      database: env.DB,
      generations: [{
        domain: "route_contract",
        scopeType: "listing",
        scopeId: input.listingId,
        input: {
          listingId: input.listingId,
          destinationLocationId: input.destinationLocationId,
          originCacheKey: input.originCacheKey,
          providerName: LOCAL_PROXIMITY_PROVIDER_NAME,
          inputHash: input.estimate.inputHash,
          driveSeconds: input.estimate.estimatedDriveSeconds,
          distanceMeters: input.estimate.directMeters === null
            ? null
            : Math.round(input.estimate.directMeters),
          driveBucket: input.estimate.bucket,
          approximate: true,
          errorCode: input.estimate.errorCode ?? null,
        },
        derivationVersion: "route-contract-mutation-v1",
      }],
      refresh: {
        target: {
          type: "listing",
          listingId: input.listingId,
          sourceId: source.source_id,
        },
        reasonCode: "listing_route_changed",
        priority: 600,
      },
      now,
    });
  await env.DB.batch([
    env.DB.prepare(`
    INSERT OR IGNORE INTO route_cache (
      id, origin_cache_key, destination_location_id, provider_name, input_hash,
      drive_seconds, distance_meters, drive_bucket, is_approximate,
      calculated_at, error_code
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(
    routeId,
    input.originCacheKey,
    input.destinationLocationId,
    LOCAL_PROXIMITY_PROVIDER_NAME,
    input.estimate.inputHash,
    input.estimate.estimatedDriveSeconds,
    input.estimate.directMeters === null
      ? null
      : Math.round(input.estimate.directMeters),
    input.estimate.bucket,
    nowIso,
    input.estimate.errorCode,
  ),
    env.DB.prepare(`
    INSERT INTO listing_routes (listing_id, route_cache_id, assigned_at)
    SELECT ?, id, ?
    FROM route_cache
    WHERE origin_cache_key = ? AND destination_location_id = ?
      AND provider_name = ? AND input_hash = ?
    ORDER BY id
    LIMIT 1
    ON CONFLICT(listing_id) DO UPDATE SET
      route_cache_id = excluded.route_cache_id,
      assigned_at = excluded.assigned_at
    WHERE listing_routes.route_cache_id <> excluded.route_cache_id
  `).bind(
    input.listingId,
    nowIso,
    input.originCacheKey,
    input.destinationLocationId,
    LOCAL_PROXIMITY_PROVIDER_NAME,
    input.estimate.inputHash,
  ),
    ...invalidation,
  ]);
}
