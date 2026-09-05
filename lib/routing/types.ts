export const driveBucketValues = [
  "under_2h",
  "under_4h",
  "under_8h",
  "exclude",
] as const;
export type DriveBucket = (typeof driveBucketValues)[number];

export interface Coordinates {
  readonly latitude: number;
  readonly longitude: number;
}

export interface LocationQuery {
  readonly city?: string | null;
  readonly state?: string | null;
  readonly postalCode?: string | null;
  readonly countryCode?: string | null;
}

/** Compatibility value used by the remaining local-only source assessor. */
export interface GeocodedLocation {
  readonly cacheKey: string;
  readonly query: LocationQuery;
  readonly coordinates: Coordinates | null;
  readonly displayName: string | null;
  readonly status: "resolved" | "unknown";
  readonly providerName: string;
  readonly resolvedAt: string;
  readonly fromCache: boolean;
}

/** Persisted local estimate shape retained by existing source consumers. */
export interface RouteResult {
  readonly providerName: string;
  readonly status: "resolved" | "unknown";
  readonly driveSeconds: number | null;
  /** Raw direct (great-circle) distance under the local proximity provider. */
  readonly distanceMeters: number | null;
  readonly straightLineMeters: number | null;
  readonly bucket: DriveBucket;
  readonly approximate: boolean;
  readonly calculatedAt: string;
  readonly fromCache: boolean;
  readonly errorCode?: string;
}
