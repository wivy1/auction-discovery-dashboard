import centroidData from "./data/us-zcta-centroids-2025.json" with { type: "json" };
import { OPERATIONAL_DIRECT_RADIUS_CEILING_MILES } from "./buckets";
import type { Coordinates } from "./types";

interface CompactZipCentroidData {
  readonly v: string;
  readonly n: number;
  readonly s: number;
  readonly z: string;
  readonly c: readonly number[];
}

const data = centroidData as CompactZipCentroidData;
const ZIP_WIDTH = 5;
const EARTH_RADIUS_MILES = 3_958.7613;

validateDataset(data);

export const ZIP_PREFILTER_DATASET = Object.freeze({
  id: "us-census-zcta-gazetteer-2025",
  version: data.v,
  recordCount: data.n,
  coordinateScale: data.s,
  coordinateKind: "ZCTA internal point",
  geographicCoverage: "50 states, District of Columbia, and Puerto Rico",
  sourceAgency: "U.S. Census Bureau",
  sourceUrl:
    "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2025_Gazetteer/2025_Gaz_zcta_national.zip",
  sourceArchiveSha256:
    "51516a4283bab5cd2376eec75609ddc4b363a18297e8adeeaac7b03cf7c84dbe",
  retrievedOn: "2026-07-14",
} as const);

export type ZipPrefilterDecision = "candidate" | "terminal_impossible";

export type ZipPrefilterReason =
  | "within_terminal_cutoff"
  | "unknown_origin_zip"
  | "unknown_destination_zip"
  | "beyond_terminal_cutoff";

export interface ZipCoordinate extends Coordinates {
  readonly postalCode: string;
}

export interface ZipPrefilterOptions {
  readonly terminalImpossibleMiles?: number;
}

export interface ZipPrefilterAssessment {
  readonly normalizedOriginZip: string | null;
  readonly normalizedDestinationZip: string | null;
  readonly origin: ZipCoordinate | null;
  readonly destination: ZipCoordinate | null;
  readonly directMiles: number | null;
  readonly terminalImpossibleMiles: number;
  readonly decision: ZipPrefilterDecision;
  readonly reason: ZipPrefilterReason;
}

/**
 * Applies the US-only ZCTA prefilter only when the source explicitly identifies
 * the postal code as United States evidence. Numeric foreign postcodes can
 * overlap real US ZCTAs, so unknown and non-US country evidence must fail open.
 */
export function assessExplicitUsZipPrefilter(
  originPostalCode: string | null | undefined,
  destinationPostalCode: string | null | undefined,
  destinationCountryCode: string | null | undefined,
  options: ZipPrefilterOptions = {},
): ZipPrefilterAssessment {
  return assessZipPrefilter(
    originPostalCode,
    destinationCountryCode?.trim().toUpperCase() === "US"
      ? destinationPostalCode
      : null,
    options,
  );
}

/** Normalize a five-digit ZIP or ZIP+4 to its five-digit delivery-area code. */
export function normalizeUsZipCode(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim() ?? "";
  const match = /^(\d{5})(?:-?\d{4})?$/.exec(normalized);
  return match?.[1] ?? null;
}

/** Return the Census ZCTA internal point, or null when Census has no ZCTA. */
export function lookupUsZipCoordinate(
  value: string | null | undefined,
): ZipCoordinate | null {
  const postalCode = normalizeUsZipCode(value);
  if (!postalCode) return null;

  let low = 0;
  let high = data.n - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = data.z.slice(middle * ZIP_WIDTH, (middle + 1) * ZIP_WIDTH);
    if (candidate === postalCode) {
      return {
        postalCode,
        latitude: data.c[middle * 2] / data.s,
        longitude: data.c[middle * 2 + 1] / data.s,
      };
    }
    if (candidate < postalCode) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

/** Great-circle distance between two WGS84 coordinates. */
export function haversineMiles(
  origin: Coordinates,
  destination: Coordinates,
): number {
  validateCoordinates(origin, "origin");
  validateCoordinates(destination, "destination");
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const originLatitude = radians(origin.latitude);
  const destinationLatitude = radians(destination.latitude);
  const latitudeDelta = radians(destination.latitude - origin.latitude);
  const longitudeDelta = radians(destination.longitude - origin.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitude) *
      Math.cos(destinationLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  const clampedHaversine = Math.min(1, Math.max(0, haversine));
  return (
    EARTH_RADIUS_MILES *
    2 *
    Math.atan2(
      Math.sqrt(clampedHaversine),
      Math.sqrt(1 - clampedHaversine),
    )
  );
}

/**
 * Coarsely assess a ZIP pair. Missing/unsupported ZIPs deliberately pass
 * through as candidates so the offline lookup can never become a coverage
 * exclusion.
 */
export function assessZipPrefilter(
  originPostalCode: string | null | undefined,
  destinationPostalCode: string | null | undefined,
  options: ZipPrefilterOptions = {},
): ZipPrefilterAssessment {
  const terminalImpossibleMiles =
    options.terminalImpossibleMiles ?? OPERATIONAL_DIRECT_RADIUS_CEILING_MILES;
  if (!Number.isFinite(terminalImpossibleMiles) || terminalImpossibleMiles <= 0) {
    throw new RangeError("terminalImpossibleMiles must be a positive finite number");
  }

  const normalizedOriginZip = normalizeUsZipCode(originPostalCode);
  const normalizedDestinationZip = normalizeUsZipCode(destinationPostalCode);
  const origin = lookupUsZipCoordinate(normalizedOriginZip);
  const destination = lookupUsZipCoordinate(normalizedDestinationZip);

  if (!origin) {
    return {
      normalizedOriginZip,
      normalizedDestinationZip,
      origin,
      destination,
      directMiles: null,
      terminalImpossibleMiles,
      decision: "candidate",
      reason: "unknown_origin_zip",
    };
  }
  if (!destination) {
    return {
      normalizedOriginZip,
      normalizedDestinationZip,
      origin,
      destination,
      directMiles: null,
      terminalImpossibleMiles,
      decision: "candidate",
      reason: "unknown_destination_zip",
    };
  }

  const directMiles = haversineMiles(origin, destination);
  return {
    normalizedOriginZip,
    normalizedDestinationZip,
    origin,
    destination,
    directMiles,
    terminalImpossibleMiles,
    decision:
      directMiles > terminalImpossibleMiles ? "terminal_impossible" : "candidate",
    reason:
      directMiles > terminalImpossibleMiles
        ? "beyond_terminal_cutoff"
        : "within_terminal_cutoff",
  };
}

/** Numeric nearest-first priority; unknown ZIPs sort after known distances. */
export function zipPrefilterPriority(
  assessment: ZipPrefilterAssessment,
): number {
  return assessment.directMiles ?? Number.POSITIVE_INFINITY;
}

/** Stable-ready comparator for assessments computed once per listing. */
export function compareZipPrefilterPriority(
  left: ZipPrefilterAssessment,
  right: ZipPrefilterAssessment,
): number {
  const leftPriority = zipPrefilterPriority(left);
  const rightPriority = zipPrefilterPriority(right);
  if (leftPriority < rightPriority) return -1;
  if (leftPriority > rightPriority) return 1;
  return (left.normalizedDestinationZip ?? "").localeCompare(
    right.normalizedDestinationZip ?? "",
  );
}

function validateCoordinates(coordinates: Coordinates, name: string): void {
  if (
    !Number.isFinite(coordinates.latitude) ||
    coordinates.latitude < -90 ||
    coordinates.latitude > 90 ||
    !Number.isFinite(coordinates.longitude) ||
    coordinates.longitude < -180 ||
    coordinates.longitude > 180
  ) {
    throw new RangeError(`${name} coordinates are invalid`);
  }
}

function validateDataset(value: CompactZipCentroidData): void {
  if (
    value.v !== "2025" ||
    value.n !== 33_791 ||
    value.s !== 1_000_000 ||
    value.z.length !== value.n * ZIP_WIDTH ||
    value.c.length !== value.n * 2
  ) {
    throw new Error("The bundled Census ZIP centroid dataset is invalid");
  }
}
