import type { Coordinates, LocationQuery } from "./types";

export const METERS_PER_MILE = 1_609.344;

export function isValidCoordinates(
  value: Coordinates | null | undefined,
): value is Coordinates {
  return Boolean(
    value &&
      Number.isFinite(value.latitude) &&
      Number.isFinite(value.longitude) &&
      value.latitude >= -90 &&
      value.latitude <= 90 &&
      value.longitude >= -180 &&
      value.longitude <= 180,
  );
}

/** Stable active-origin and legacy evidence identity. */
export function locationCacheKey(query: LocationQuery): string {
  const city = query.city?.trim().toLocaleUpperCase("en-US") ?? "";
  const state = query.state?.trim().toLocaleUpperCase("en-US") ?? "";
  const postal = query.postalCode?.trim().toLocaleUpperCase("en-US") ?? "";
  const country = query.countryCode?.trim().toLocaleUpperCase("en-US") ?? "";
  if (!city && !state && !postal) {
    throw new Error("location requires a city, state, or postal code");
  }
  return [country, state, city, postal].join("|");
}

/** Deterministic Haversine distance on the IUGG mean-Earth radius. */
export function straightLineDistanceMeters(
  origin: Coordinates,
  destination: Coordinates,
): number {
  if (!isValidCoordinates(origin) || !isValidCoordinates(destination)) {
    throw new RangeError("straight-line distance requires valid coordinates");
  }
  const radiusMeters = 6_371_008.8;
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const lat1 = radians(origin.latitude);
  const lat2 = radians(destination.latitude);
  const deltaLat = radians(destination.latitude - origin.latitude);
  const deltaLon = radians(destination.longitude - origin.longitude);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return radiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Exact unit conversion used before the dashboard's one-decimal presentation. */
export function distanceMetersToMiles(distanceMeters: number): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new RangeError("distance meters must be a non-negative finite number");
  }
  return distanceMeters / METERS_PER_MILE;
}

export function roundedDistanceMiles(distanceMeters: number): number {
  return Math.round(distanceMetersToMiles(distanceMeters) * 10) / 10;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
