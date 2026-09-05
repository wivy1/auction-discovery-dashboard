import {
  driveBucketForSeconds,
  LOCAL_PROXIMITY_AVERAGE_SPEED_MPH,
  LOCAL_PROXIMITY_ROAD_FACTOR,
} from "./buckets";
export {
  LOCAL_PROXIMITY_AVERAGE_SPEED_MPH,
  LOCAL_PROXIMITY_ROAD_FACTOR,
} from "./buckets";
import { canonicalIsoAlpha2CountryCode } from "./country-codes";
import {
  PLACE_ENVELOPE_DATASET,
  lookupExactUsPlaceCoordinate,
  normalizeUsPlaceName,
} from "./geographic-prefilter";
import {
  isValidCoordinates,
  sha256,
  straightLineDistanceMeters,
} from "./helpers";
import type { Coordinates, DriveBucket, LocationQuery } from "./types";
import {
  ZIP_PREFILTER_DATASET,
  lookupUsZipCoordinate,
  normalizeUsZipCode,
} from "./zip-prefilter";

export const LOCAL_PROXIMITY_PROVIDER_NAME = "local_proximity";
export const LOCAL_PROXIMITY_ESTIMATOR_VERSION =
  "haversine-road-factor-1.2-at-50mph-v1";
export const LOCAL_PROXIMITY_NORMALIZATION_VERSION =
  "local-proximity-normalization-v1";
export const LOCAL_PROXIMITY_DATASET_IDENTITY = [
  `${ZIP_PREFILTER_DATASET.id}@${ZIP_PREFILTER_DATASET.version}`,
  ZIP_PREFILTER_DATASET.sourceArchiveSha256,
  `${PLACE_ENVELOPE_DATASET.id}@${PLACE_ENVELOPE_DATASET.version}`,
  PLACE_ENVELOPE_DATASET.derivedJsonSha256,
].join(":");

export const LOCAL_PROXIMITY_INPUT_VERSION = [
  LOCAL_PROXIMITY_PROVIDER_NAME,
  LOCAL_PROXIMITY_ESTIMATOR_VERSION,
  LOCAL_PROXIMITY_NORMALIZATION_VERSION,
  LOCAL_PROXIMITY_DATASET_IDENTITY,
].join(":");

export type LocalProximityEvidenceKind =
  | "source_coordinates"
  | "census_zcta"
  | "census_place"
  | "unknown";

export type LocalProximityEvidenceProvider =
  | "source"
  | typeof ZIP_PREFILTER_DATASET.id
  | typeof PLACE_ENVELOPE_DATASET.id
  | null;

export interface NormalizedLocalProximityQuery {
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
}

export interface ResolvedLocalProximityLocation {
  /** Stable normalization and grouping identity for equivalent evidence. */
  readonly cacheKey: string;
  readonly groupingKey: string;
  readonly normalizedQuery: NormalizedLocalProximityQuery;
  readonly evidenceKind: LocalProximityEvidenceKind;
  readonly evidenceProvider: LocalProximityEvidenceProvider;
  readonly coordinates: Coordinates | null;
}

export interface LocalProximityEstimate {
  readonly providerName: typeof LOCAL_PROXIMITY_PROVIDER_NAME;
  readonly estimatorVersion: typeof LOCAL_PROXIMITY_ESTIMATOR_VERSION;
  readonly datasetIdentity: typeof LOCAL_PROXIMITY_DATASET_IDENTITY;
  readonly inputVersion: typeof LOCAL_PROXIMITY_INPUT_VERSION;
  readonly inputHash: string;
  readonly cacheSignature: string;
  readonly originCacheKey: string;
  readonly destinationCacheKey: string;
  readonly destinationGroupingKey: string;
  readonly destinationNormalizedQuery: NormalizedLocalProximityQuery;
  readonly destinationEvidenceKind: LocalProximityEvidenceKind;
  readonly destinationEvidenceProvider: LocalProximityEvidenceProvider;
  readonly destinationCoordinates: Coordinates | null;
  readonly status: "resolved" | "unknown";
  readonly directMeters: number | null;
  readonly estimatedDriveSeconds: number | null;
  readonly bucket: DriveBucket;
  readonly approximate: true;
  readonly errorCode: "unknown_location" | null;
}

/**
 * Reconstructs the exact persisted listing-location query used by both the
 * operational projector and the proximity worker. A complete detail with no
 * location fields falls back to the catalog query; partial but unsupported
 * evidence remains an explicit `ZZ` query and therefore becomes a stable
 * unknown-location terminal rather than silently falling through.
 */
export function storedLocalProximityQuery(input: {
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
}): LocationQuery | null {
  if (!input.city && !input.state && !input.postalCode && !input.countryCode) {
    return null;
  }
  return Object.freeze({
    city: input.city,
    state: input.state,
    postalCode: input.postalCode,
    countryCode: input.countryCode || "ZZ",
  });
}

/** Resolve the active US origin from the bundled Census 2025 ZCTA data. */
export function resolveLocalProximityOrigin(
  postalCode: string | null | undefined,
  countryCode: string | null | undefined,
): ResolvedLocalProximityLocation {
  const query = normalizeQuery({ postalCode, countryCode });
  if (query.countryCode === "US") {
    const coordinate = lookupUsZipCoordinate(query.postalCode);
    if (coordinate) {
      return resolvedLocation(
        query,
        `us-zip:${coordinate.postalCode}`,
        "census_zcta",
        ZIP_PREFILTER_DATASET.id,
        coordinate,
      );
    }
  }
  return unknownLocation(query);
}

/**
 * Resolve precise source coordinates first, then an explicit US ZCTA, then one
 * exact unique Census place. Incomplete or unsupported evidence stays unknown.
 */
export function resolveLocalProximityDestination(
  location: LocationQuery | null | undefined,
  sourceCoordinates?: Coordinates | null,
): ResolvedLocalProximityLocation {
  const query = normalizeQuery(location);
  if (isValidCoordinates(sourceCoordinates)) {
    const coordinates = copyCoordinates(sourceCoordinates);
    return resolvedLocation(
      query,
      `coordinates:${coordinateKey(coordinates)}`,
      "source_coordinates",
      "source",
      coordinates,
    );
  }

  if (query.countryCode === "US") {
    const zipCoordinate = lookupUsZipCoordinate(query.postalCode);
    if (zipCoordinate) {
      return resolvedLocation(
        query,
        `us-zip:${zipCoordinate.postalCode}`,
        "census_zcta",
        ZIP_PREFILTER_DATASET.id,
        zipCoordinate,
      );
    }

    const placeCoordinate = lookupExactUsPlaceCoordinate(
      query.city,
      query.state,
    );
    if (placeCoordinate) {
      return resolvedLocation(
        query,
        `us-place:${placeCoordinate.state}:${placeCoordinate.city}`,
        "census_place",
        PLACE_ENVELOPE_DATASET.id,
        placeCoordinate,
      );
    }
  }

  return unknownLocation(query);
}

/** Produce one deterministic, network-free approximate drive-time estimate. */
export async function estimateLocalProximity(
  origin: ResolvedLocalProximityLocation,
  destination: ResolvedLocalProximityLocation,
): Promise<LocalProximityEstimate> {
  const inputHash = await localProximityInputHash(origin, destination);
  const base = {
    providerName: LOCAL_PROXIMITY_PROVIDER_NAME,
    estimatorVersion: LOCAL_PROXIMITY_ESTIMATOR_VERSION,
    datasetIdentity: LOCAL_PROXIMITY_DATASET_IDENTITY,
    inputVersion: LOCAL_PROXIMITY_INPUT_VERSION,
    inputHash,
    cacheSignature: `${LOCAL_PROXIMITY_INPUT_VERSION}:${inputHash}`,
    originCacheKey: origin.cacheKey,
    destinationCacheKey: destination.cacheKey,
    destinationGroupingKey: destination.groupingKey,
    destinationNormalizedQuery: destination.normalizedQuery,
    destinationEvidenceKind: destination.evidenceKind,
    destinationEvidenceProvider: destination.evidenceProvider,
    destinationCoordinates: destination.coordinates,
    approximate: true,
  } as const;

  if (
    !isValidCoordinates(origin.coordinates) ||
    !isValidCoordinates(destination.coordinates)
  ) {
    return {
      ...base,
      status: "unknown",
      directMeters: null,
      estimatedDriveSeconds: null,
      bucket: "exclude",
      errorCode: "unknown_location",
    };
  }

  const directMeters = straightLineDistanceMeters(
    origin.coordinates,
    destination.coordinates,
  );
  const estimatedSeconds =
    directMeters * LOCAL_PROXIMITY_ROAD_FACTOR /
    (LOCAL_PROXIMITY_AVERAGE_SPEED_MPH * 0.44704);
  return {
    ...base,
    status: "resolved",
    directMeters,
    estimatedDriveSeconds: Math.round(estimatedSeconds),
    bucket: driveBucketForSeconds(estimatedSeconds),
    errorCode: null,
  };
}

function normalizeQuery(
  location: LocationQuery | null | undefined,
): NormalizedLocalProximityQuery {
  const rawPostalCode = location?.postalCode?.trim() ?? "";
  const normalizedPostalCode = normalizeUsZipCode(rawPostalCode);
  const state = location?.state?.normalize("NFC").trim().toUpperCase() ?? "";
  return {
    city: normalizeUsPlaceName(location?.city),
    state: state || null,
    postalCode: normalizedPostalCode || rawPostalCode || null,
    countryCode: canonicalIsoAlpha2CountryCode(location?.countryCode),
  };
}

function resolvedLocation(
  normalizedQuery: NormalizedLocalProximityQuery,
  groupingKey: string,
  evidenceKind: Exclude<LocalProximityEvidenceKind, "unknown">,
  evidenceProvider: Exclude<LocalProximityEvidenceProvider, null>,
  coordinates: Coordinates,
): ResolvedLocalProximityLocation {
  return {
    cacheKey: `${LOCAL_PROXIMITY_NORMALIZATION_VERSION}:${groupingKey}`,
    groupingKey,
    normalizedQuery,
    evidenceKind,
    evidenceProvider,
    coordinates: copyCoordinates(coordinates),
  };
}

function unknownLocation(
  normalizedQuery: NormalizedLocalProximityQuery,
): ResolvedLocalProximityLocation {
  const groupingKey = `unknown:${JSON.stringify(normalizedQuery)}`;
  return {
    cacheKey: `${LOCAL_PROXIMITY_NORMALIZATION_VERSION}:${groupingKey}`,
    groupingKey,
    normalizedQuery,
    evidenceKind: "unknown",
    evidenceProvider: null,
    coordinates: null,
  };
}

function copyCoordinates(coordinates: Coordinates): Coordinates {
  return {
    latitude: coordinates.latitude === 0 ? 0 : coordinates.latitude,
    longitude: coordinates.longitude === 0 ? 0 : coordinates.longitude,
  };
}

function coordinateKey(coordinates: Coordinates): string {
  return `${coordinates.latitude === 0 ? 0 : coordinates.latitude},${
    coordinates.longitude === 0 ? 0 : coordinates.longitude
  }`;
}

async function localProximityInputHash(
  origin: ResolvedLocalProximityLocation,
  destination: ResolvedLocalProximityLocation,
): Promise<string> {
  return sha256(JSON.stringify({
    inputVersion: LOCAL_PROXIMITY_INPUT_VERSION,
    origin: {
      cacheKey: origin.cacheKey,
      coordinates: origin.coordinates,
    },
    destination: {
      cacheKey: destination.cacheKey,
      coordinates: destination.coordinates,
      evidenceKind: destination.evidenceKind,
      evidenceProvider: destination.evidenceProvider,
    },
  }));
}
