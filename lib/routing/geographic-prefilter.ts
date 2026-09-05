import stateEnvelopeData from "./data/us-state-envelopes-2025.json" with { type: "json" };
import placeEnvelopeData from "./data/us-place-envelopes-2025.json" with { type: "json" };
import type { LocationCandidate } from "../domain/listings";
import { canonicalIsoAlpha2CountryCode } from "./country-codes";
import type { Coordinates } from "./types";
import {
  assessExplicitUsZipPrefilter,
  haversineMiles,
  lookupUsZipCoordinate,
  type ZipPrefilterOptions,
} from "./zip-prefilter";
import { OPERATIONAL_DIRECT_RADIUS_CEILING_MILES } from "./buckets";

type CompactStateEnvelope = readonly [
  stateCode: string,
  minimumLongitude: number,
  minimumLatitude: number,
  maximumLongitude: number,
  maximumLatitude: number,
];

interface CompactStateEnvelopeData {
  readonly v: string;
  readonly n: number;
  readonly b: readonly CompactStateEnvelope[];
}

type CompactPlaceEnvelope = readonly [
  normalizedName: string,
  minimumLongitude: number,
  minimumLatitude: number,
  maximumLongitude: number,
  maximumLatitude: number,
];

interface CompactPlaceEnvelopeData {
  readonly v: string;
  readonly n: number;
  readonly b: Readonly<Record<string, readonly CompactPlaceEnvelope[]>>;
}

const data = stateEnvelopeData as unknown as CompactStateEnvelopeData;
const stateEnvelopes = validateStateEnvelopeData(data);
const places = placeEnvelopeData as unknown as CompactPlaceEnvelopeData;
const placeEnvelopes = validatePlaceEnvelopeData(places);
const separateUsRoadComponents = new Map<string, string>([
  ["AS", "us-american-samoa"],
  ["GU", "us-guam"],
  ["HI", "us-hawaii"],
  ["MP", "us-northern-mariana-islands"],
  ["PR", "us-puerto-rico"],
  ["VI", "us-virgin-islands"],
]);
const northCentralAmericanMainlandCountries = new Set([
  "BZ",
  "CA",
  "CR",
  "GT",
  "HN",
  "MX",
  "NI",
  "PA",
  "SV",
  "US",
]);

export const STATE_ENVELOPE_DATASET = Object.freeze({
  id: "us-census-tiger-state-envelopes-2025",
  version: data.v,
  recordCount: data.n,
  coordinateKind: "TIGER/Line state polygon bounding envelope",
  geographicCoverage: "50 states, District of Columbia, and five US territories",
  sourceAgency: "U.S. Census Bureau",
  sourceUrl:
    "https://www2.census.gov/geo/tiger/TIGER2025/STATE/tl_2025_us_state.zip",
  sourceArchiveSha256:
    "59a220888a8d9be8117c4fcd38f542bd02d81abf0d198c78113595ad540dd957",
  retrievedOn: "2026-07-22",
} as const);

export const PLACE_ENVELOPE_DATASET = Object.freeze({
  id: "us-census-tiger-active-place-envelopes-2025",
  version: places.v,
  recordCount: places.n,
  coordinateKind: "TIGER/Line PLACE polygon bounding envelope",
  geographicCoverage:
    "unique active-government PLACE names in the 56 state and territory archives",
  sourceAgency: "U.S. Census Bureau",
  sourceDirectoryUrl:
    "https://www2.census.gov/geo/tiger/TIGER2025/PLACE/",
  sourceArchivePattern: "tl_2025_{STATEFP}_place.zip",
  sourceArchiveCount: 56,
  sourceArchiveBytes: 145_663_387,
  sourceArchiveManifestSha256:
    "582483fcd6967566f3af2ed477240d44147b68284334b0b069cc9838fad5e219",
  sourceArchiveManifestFormat:
    "sorted filename\\tsize\\tarchive-sha256\\n",
  stateLookupSourceUrl:
    "https://www2.census.gov/geo/tiger/TIGER2025/STATE/tl_2025_us_state.zip",
  derivedJsonSha256:
    "68d933e72486ff52c44fdad93f4f17ce5ecade4f530402147bbfdca52c38a9dc",
  retrievedOn: "2026-07-22",
} as const);

export interface UsPlaceCoordinate {
  readonly city: string;
  readonly state: string;
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * Returns the deterministic center of one exact, unique Census PLACE envelope.
 * The bundled map contains only active-government names that are unique within
 * a state. Unsupported states, qualified names, and partial matches fail
 * closed so callers never manufacture a locality coordinate.
 */
export function lookupExactUsPlaceCoordinate(
  city: string | null | undefined,
  state: string | null | undefined,
): UsPlaceCoordinate | null {
  const normalizedCity = normalizeUsPlaceName(city);
  const normalizedState = normalizedUsStateCode(state);
  if (!normalizedCity || !normalizedState) return null;
  const envelope = placeEnvelopes.get(normalizedState)?.get(normalizedCity);
  if (!envelope) return null;
  return {
    city: normalizedCity,
    state: normalizedState,
    latitude: (envelope[2] + envelope[4]) / 2,
    longitude: (envelope[1] + envelope[3]) / 2,
  };
}

export type GeographicPrefilterErrorCode =
  | "road_component_disconnected"
  | "place_envelope_terminal_impossible"
  | "state_envelope_terminal_impossible"
  | "zcta_terminal_impossible";

export type GeographicPrefilterReason =
  | "unknown_origin_country"
  | "unknown_origin_zip"
  | "unknown_destination_country"
  | "unknown_destination_state"
  | "same_road_component"
  | "road_component_disconnected"
  | "unknown_destination_place"
  | "place_envelope_within_terminal_cutoff"
  | "place_envelope_beyond_terminal_cutoff"
  | "state_envelope_within_terminal_cutoff"
  | "state_envelope_beyond_terminal_cutoff"
  | "zcta_within_terminal_cutoff"
  | "zcta_beyond_terminal_cutoff";

export interface GeographicPrefilterAssessment {
  readonly decision: "candidate" | "terminal_impossible";
  readonly reason: GeographicPrefilterReason;
  readonly errorCode: GeographicPrefilterErrorCode | null;
  readonly normalizedOriginZip: string | null;
  readonly normalizedDestinationCountryCode: string | null;
  readonly normalizedDestinationStateCode: string | null;
  readonly normalizedDestinationPlaceName: string | null;
  readonly directMiles: number | null;
  readonly terminalImpossibleMiles: number;
}

/**
 * Applies exact source geography before network detail work. Every terminal
 * result is based on an explicit country/state/ZIP or exact active place and
 * the active origin; incomplete or unsupported evidence always remains a
 * candidate.
 */
export function assessExplicitGeographicPrefilter(
  originPostalCode: string | null | undefined,
  originCountryCode: string | null | undefined,
  destination: (
    Pick<LocationCandidate, "countryCode" | "postalCode" | "state"> &
      Partial<Pick<LocationCandidate, "city">>
  ) | null | undefined,
  options: ZipPrefilterOptions = {},
): GeographicPrefilterAssessment {
  const terminalImpossibleMiles =
    options.terminalImpossibleMiles ?? OPERATIONAL_DIRECT_RADIUS_CEILING_MILES;
  if (!Number.isFinite(terminalImpossibleMiles) || terminalImpossibleMiles <= 0) {
    throw new RangeError("terminalImpossibleMiles must be a positive finite number");
  }

  const normalizedOriginCountryCode = canonicalIsoAlpha2CountryCode(originCountryCode);
  const origin = lookupUsZipCoordinate(originPostalCode);
  const normalizedDestinationCountryCode = canonicalIsoAlpha2CountryCode(
    destination?.countryCode,
  );
  const normalizedDestinationStateCode = normalizedUsStateCode(
    destination?.state,
  );
  const normalizedDestinationPlaceName = normalizeUsPlaceName(
    destination?.city,
  );
  const base = {
    normalizedOriginZip: origin?.postalCode ?? null,
    normalizedDestinationCountryCode,
    normalizedDestinationStateCode,
    normalizedDestinationPlaceName,
    terminalImpossibleMiles,
  } as const;

  if (normalizedOriginCountryCode !== "US") {
    return candidate(base, "unknown_origin_country");
  }
  if (!origin) return candidate(base, "unknown_origin_zip");
  if (!normalizedDestinationCountryCode) {
    return candidate(base, "unknown_destination_country");
  }

  const zipAssessment = assessExplicitUsZipPrefilter(
    origin.postalCode,
    destination?.postalCode,
    normalizedDestinationCountryCode,
    options,
  );
  if (zipAssessment.decision === "terminal_impossible") {
    return {
      ...base,
      decision: "terminal_impossible",
      reason: "zcta_beyond_terminal_cutoff",
      errorCode: "zcta_terminal_impossible",
      directMiles: zipAssessment.directMiles,
    };
  }

  const originRoadComponent = originRoadComponentForUsZip(origin);
  const destinationComponent = destinationRoadComponent(
    normalizedDestinationCountryCode,
    normalizedDestinationStateCode,
  );
  if (
    originRoadComponent && destinationComponent &&
    originRoadComponent !== destinationComponent
  ) {
    return {
      ...base,
      decision: "terminal_impossible",
      reason: "road_component_disconnected",
      errorCode: "road_component_disconnected",
      directMiles: null,
    };
  }

  if (normalizedDestinationCountryCode === "US") {
    if (zipAssessment.directMiles !== null) {
      return candidate(
        base,
        "zcta_within_terminal_cutoff",
        zipAssessment.directMiles,
      );
    }
    if (!normalizedDestinationStateCode) {
      return candidate(base, "unknown_destination_state");
    }
    const envelope = stateEnvelopes.get(normalizedDestinationStateCode);
    if (!envelope) return candidate(base, "unknown_destination_state");
    const minimumEnvelopeMiles = minimumMilesToEnvelope(origin, envelope);
    if (minimumEnvelopeMiles > terminalImpossibleMiles) {
      return {
        ...base,
        decision: "terminal_impossible",
        reason: "state_envelope_beyond_terminal_cutoff",
        errorCode: "state_envelope_terminal_impossible",
        directMiles: minimumEnvelopeMiles,
      };
    }
    if (!normalizedDestinationPlaceName) {
      return candidate(
        base,
        "state_envelope_within_terminal_cutoff",
        minimumEnvelopeMiles,
      );
    }
    const placeEnvelope = placeEnvelopes.get(normalizedDestinationStateCode)
      ?.get(normalizedDestinationPlaceName);
    if (!placeEnvelope) {
      return candidate(base, "unknown_destination_place", minimumEnvelopeMiles);
    }
    const minimumPlaceMiles = minimumMilesToEnvelope(origin, placeEnvelope);
    if (minimumPlaceMiles > terminalImpossibleMiles) {
      return {
        ...base,
        decision: "terminal_impossible",
        reason: "place_envelope_beyond_terminal_cutoff",
        errorCode: "place_envelope_terminal_impossible",
        directMiles: minimumPlaceMiles,
      };
    }
    return candidate(
      base,
      "place_envelope_within_terminal_cutoff",
      minimumPlaceMiles,
    );
  }

  return candidate(base, "same_road_component", zipAssessment.directMiles);
}

function candidate(
  base: Pick<
    GeographicPrefilterAssessment,
    | "normalizedOriginZip"
    | "normalizedDestinationCountryCode"
    | "normalizedDestinationStateCode"
    | "normalizedDestinationPlaceName"
    | "terminalImpossibleMiles"
  >,
  reason: GeographicPrefilterReason,
  directMiles: number | null = null,
): GeographicPrefilterAssessment {
  return {
    ...base,
    decision: "candidate",
    reason,
    errorCode: null,
    directMiles,
  };
}

/** Case and spacing are presentation-only; punctuation and qualifiers remain exact. */
export function normalizeUsPlaceName(
  value: string | null | undefined,
): string | null {
  const normalized = value?.normalize("NFC").trim().replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US") ?? "";
  return normalized || null;
}

function normalizedUsStateCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(normalized) && stateEnvelopes.has(normalized)
    ? normalized
    : null;
}

function originRoadComponentForUsZip(origin: Coordinates): string {
  for (const [stateCode, component] of separateUsRoadComponents) {
    const envelope = stateEnvelopes.get(stateCode);
    if (envelope && coordinateInsideEnvelope(origin, envelope)) return component;
  }
  return "north-central-american-mainland";
}

function destinationRoadComponent(
  countryCode: string,
  stateCode: string | null,
): string | null {
  if (countryCode === "US") {
    if (!stateCode) return null;
    return separateUsRoadComponents.get(stateCode) ??
      "north-central-american-mainland";
  }
  return northCentralAmericanMainlandCountries.has(countryCode)
    ? "north-central-american-mainland"
    : `country:${countryCode}`;
}

function coordinateInsideEnvelope(
  point: Coordinates,
  envelope: CompactStateEnvelope,
): boolean {
  return point.longitude >= envelope[1] && point.longitude <= envelope[3] &&
    point.latitude >= envelope[2] && point.latitude <= envelope[4];
}

/** Exact spherical minimum to the complete rectangle, a lower bound to its geometry. */
function minimumMilesToEnvelope(
  origin: Coordinates,
  envelope: CompactStateEnvelope | CompactPlaceEnvelope,
): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const degrees = (value: number) => (value * 180) / Math.PI;
  const minimumLatitude = radians(envelope[2]);
  const maximumLatitude = radians(envelope[4]);
  const minimumLongitude = radians(envelope[1]);
  const maximumLongitude = radians(envelope[3]);
  const originLatitude = radians(origin.latitude);
  const originLongitude = radians(origin.longitude);
  const longitudeCandidates = [minimumLongitude, maximumLongitude];
  if (
    originLongitude >= minimumLongitude && originLongitude <= maximumLongitude
  ) {
    longitudeCandidates.push(originLongitude);
  }

  let minimumMiles = Number.POSITIVE_INFINITY;
  for (const longitude of longitudeCandidates) {
    const longitudeDelta = normalizedRadians(longitude - originLongitude);
    const unconstrainedLatitude = Math.atan2(
      Math.sin(originLatitude),
      Math.cos(originLatitude) * Math.cos(longitudeDelta),
    );
    const latitudeCandidates = [
      minimumLatitude,
      maximumLatitude,
      Math.max(
        minimumLatitude,
        Math.min(maximumLatitude, unconstrainedLatitude),
      ),
    ];
    for (const latitude of latitudeCandidates) {
      minimumMiles = Math.min(
        minimumMiles,
        haversineMiles(origin, {
          latitude: degrees(latitude),
          longitude: degrees(longitude),
        }),
      );
    }
  }
  return minimumMiles;
}

function normalizedRadians(value: number): number {
  let normalized = value;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function validateStateEnvelopeData(
  value: CompactStateEnvelopeData,
): ReadonlyMap<string, CompactStateEnvelope> {
  if (value.v !== "2025" || value.n !== 56 || value.b.length !== value.n) {
    throw new Error("The bundled Census state-envelope dataset is invalid");
  }
  const result = new Map<string, CompactStateEnvelope>();
  let previous = "";
  for (const envelope of value.b) {
    const [stateCode, minLon, minLat, maxLon, maxLat] = envelope;
    if (
      !/^[A-Z]{2}$/.test(stateCode) || stateCode <= previous ||
      !Number.isFinite(minLon) || !Number.isFinite(minLat) ||
      !Number.isFinite(maxLon) || !Number.isFinite(maxLat) ||
      minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 ||
      minLon > maxLon || minLat > maxLat
    ) {
      throw new Error("The bundled Census state-envelope dataset is invalid");
    }
    result.set(stateCode, envelope);
    previous = stateCode;
  }
  return result;
}

function validatePlaceEnvelopeData(
  value: CompactPlaceEnvelopeData,
): ReadonlyMap<string, ReadonlyMap<string, CompactPlaceEnvelope>> {
  if (value.v !== "2025" || value.n !== 19_396) {
    throw new Error("The bundled Census place-envelope dataset is invalid");
  }
  const states = new Map<string, ReadonlyMap<string, CompactPlaceEnvelope>>();
  let previousState = "";
  let recordCount = 0;
  for (const [stateCode, entries] of Object.entries(value.b)) {
    if (
      !/^[A-Z]{2}$/.test(stateCode) || stateCode <= previousState ||
      !stateEnvelopes.has(stateCode) || entries.length === 0
    ) {
      throw new Error("The bundled Census place-envelope dataset is invalid");
    }
    const statePlaces = new Map<string, CompactPlaceEnvelope>();
    let previousName = "";
    for (const envelope of entries) {
      const [name, minLon, minLat, maxLon, maxLat] = envelope;
      if (
        !name || name <= previousName || normalizeUsPlaceName(name) !== name ||
        !Number.isFinite(minLon) || !Number.isFinite(minLat) ||
        !Number.isFinite(maxLon) || !Number.isFinite(maxLat) ||
        minLon < -180 || maxLon > 180 || minLat < -90 || maxLat > 90 ||
        minLon > maxLon || minLat > maxLat
      ) {
        throw new Error("The bundled Census place-envelope dataset is invalid");
      }
      statePlaces.set(name, envelope);
      previousName = name;
      recordCount += 1;
    }
    states.set(stateCode, statePlaces);
    previousState = stateCode;
  }
  if (recordCount !== value.n) {
    throw new Error("The bundled Census place-envelope dataset is invalid");
  }
  return states;
}
