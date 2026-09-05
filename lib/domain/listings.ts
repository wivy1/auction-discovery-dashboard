import { DomainValidationError } from "./errors";

export const locationEvidenceSources = [
  "visible_listing",
  "detail_page",
  "description",
  "removal",
  "inspection",
  "other",
  "unknown",
] as const;

export type LocationEvidenceSource = (typeof locationEvidenceSources)[number];

export interface LocationCandidate {
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string;
  readonly evidenceSource: LocationEvidenceSource;
}

export interface PriceAtScrape {
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly displayText: string | null;
}

export interface VerifiedPublisherEventOutboundCatalog {
  readonly platform: string;
  readonly host: string;
  readonly eventOrCatalogId: string;
  /** Exact catalog route observed on the publisher event page. */
  readonly url: string;
}

/**
 * Structured first-party publisher evidence that led to one actionable
 * transaction-platform lot. It supplements, but never replaces, the outer
 * upstream tuple or the listing's actionable source URL.
 */
export interface VerifiedPublisherEventProvenance {
  readonly publisherHost: string;
  readonly eventId: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly summary: string;
  readonly startsText: string;
  readonly endsText: string;
  readonly locationText: string | null;
  readonly categoryKeys: readonly string[];
  /** Publisher artwork is provenance only, never a listing image candidate. */
  readonly eventImageUrl: string | null;
  readonly outboundCatalog: VerifiedPublisherEventOutboundCatalog;
}

export interface VerifiedPublisherEventProvenanceInput
  extends Omit<
    VerifiedPublisherEventProvenance,
    "locationText" | "eventImageUrl"
  > {
  readonly locationText?: string | null;
  readonly eventImageUrl?: string | null;
}

/**
 * Exact transaction-platform identity supplied by a source adapter.
 *
 * This is deliberately all-or-nothing: adapters omit the object unless every
 * component of the D-057 upstream key is verified from source evidence.
 */
export interface VerifiedUpstreamProvenance {
  readonly platform: string;
  readonly host: string;
  readonly eventOrCatalogId: string;
  readonly lotId: string;
  readonly eventName: string | null;
  readonly eventUrl: string | null;
  readonly observedAliases: readonly string[];
  readonly publisherEvent?: VerifiedPublisherEventProvenance;
}

export interface VerifiedUpstreamProvenanceInput
  extends Omit<
    VerifiedUpstreamProvenance,
    "eventName" | "eventUrl" | "observedAliases" | "publisherEvent"
  > {
  readonly eventName?: string | null;
  readonly eventUrl?: string | null;
  readonly observedAliases?: readonly string[];
  readonly publisherEvent?: VerifiedPublisherEventProvenanceInput;
}

/**
 * Unresolved cross-host equality candidate proven from source facts/media.
 * Storage keeps this evidence fail-closed until post-publication reconciliation
 * verifies a matching peer or a complete counterpart-catalog absence.
 */
export interface VerifiedSharedAliasProvenance {
  readonly family: string;
  readonly sharedCatalogKey: string;
  readonly verificationHash: string;
  readonly observedAliases: readonly string[];
}

export interface VerifiedSharedAliasProvenanceInput
  extends Omit<VerifiedSharedAliasProvenance, "observedAliases"> {
  readonly observedAliases?: readonly string[];
}

export interface ListingImageCandidate {
  /** Original/full-size URL whenever the source exposes one. */
  readonly sourceUrl: string;
  readonly thumbnailUrl: string | null;
  readonly position: number;
  readonly isPrimary: boolean;
}

/**
 * A source-supplied time by which the operator must be ready to act. This is
 * distinct from auctionEndsAt because a live auction can begin before its
 * individual lots finish.
 */
export interface ListingActionDeadline {
  readonly at: string;
  readonly basis: "live_auction_start";
  readonly sourceText: string;
}

export interface NormalizedListingStub {
  readonly sourceId: string;
  readonly sourceListingId: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly category: string | null;
  readonly lotNumber: string | null;
  readonly visibleLocation: LocationCandidate | null;
  readonly thumbnailUrl: string | null;
  readonly discoveredAt: string;
  readonly contentHash: string;
}

/**
 * The deterministic snapshot captured by the only permitted detail scrape.
 * AI-derived attributes live in separate artifacts and never overwrite this.
 */
export interface NormalizedListingDetail {
  readonly sourceId: string;
  readonly sourceListingId: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly category: string | null;
  readonly lotNumber: string | null;
  readonly rawDescription: string;
  /** Item-only text. Removal/logistics prose must be excluded. */
  readonly cleanDescription: string;
  readonly priceAtScrape: PriceAtScrape;
  readonly auctionEndsAt: string | null;
  readonly actionDeadline?: ListingActionDeadline | null;
  readonly seller: string | null;
  readonly pickupLocation: LocationCandidate | null;
  readonly images: readonly ListingImageCandidate[];
  readonly upstreamProvenance?: VerifiedUpstreamProvenance | null;
  readonly sharedAliasProvenance?: VerifiedSharedAliasProvenance | null;
  readonly scrapedAt: string;
  readonly contentHash: string;
}

export interface ListingStubInput extends Omit<NormalizedListingStub, "visibleLocation"> {
  readonly visibleLocation?: Partial<LocationCandidate> | null;
}

export interface ListingDetailInput
  extends Omit<
    NormalizedListingDetail,
    "pickupLocation" | "priceAtScrape" | "images" | "upstreamProvenance" |
      "sharedAliasProvenance"
  > {
  readonly pickupLocation?: Partial<LocationCandidate> | null;
  readonly priceAtScrape: Partial<PriceAtScrape>;
  readonly images?: readonly Partial<ListingImageCandidate>[];
  readonly upstreamProvenance?: VerifiedUpstreamProvenanceInput | null;
  readonly sharedAliasProvenance?: VerifiedSharedAliasProvenanceInput | null;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainValidationError(`${field} must be a non-empty string`, field);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new DomainValidationError(`${field} must be a string or null`, field);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new DomainValidationError(`${field} must be a string`, field);
  }
  return value;
}

function httpUrl(value: unknown, field: string): string {
  const raw = requireText(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (cause) {
    throw new DomainValidationError(`${field} must be a valid URL`, field, {
      cause,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DomainValidationError(`${field} must use http or https`, field);
  }
  return parsed.toString();
}

function optionalHttpUrl(value: unknown, field: string): string | null {
  return value === null || value === undefined || value === ""
    ? null
    : httpUrl(value, field);
}

function boundedSourceText(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  const normalized = requireText(value, field).replace(/\s+/gu, " ");
  if (
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new DomainValidationError(
      `${field} must be at most ${maximumLength} printable characters`,
      field,
    );
  }
  return normalized;
}

function exactLowercaseHost(value: unknown, field: string): string {
  const host = boundedSourceText(value, field, 253);
  let parsedHost: URL;
  try {
    parsedHost = new URL(`https://${host}`);
  } catch (cause) {
    throw new DomainValidationError(
      `${field} must be an exact lowercase hostname`,
      field,
      { cause },
    );
  }
  if (
    host !== host.toLowerCase() ||
    parsedHost.hostname !== host ||
    parsedHost.host !== host ||
    parsedHost.username ||
    parsedHost.password ||
    !/^[a-z0-9.-]+$/u.test(host)
  ) {
    throw new DomainValidationError(
      `${field} must be an exact lowercase hostname`,
      field,
    );
  }
  return host;
}

function lowercaseStableIdentifier(
  value: unknown,
  field: string,
): string {
  const identifier = boundedSourceText(value, field, 100);
  if (
    identifier !== identifier.toLowerCase() ||
    !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(identifier)
  ) {
    throw new DomainValidationError(
      `${field} must be a lowercase stable identifier`,
      field,
    );
  }
  return identifier;
}

function exactHttpsUrl(value: unknown, field: string): string {
  const normalized = httpUrl(value, field);
  if (new URL(normalized).protocol !== "https:") {
    throw new DomainValidationError(`${field} must use https`, field);
  }
  return normalized;
}

function normalizePublisherEventProvenance(
  input: VerifiedPublisherEventProvenanceInput | undefined,
  upstream: {
    readonly platform: string;
    readonly host: string;
    readonly eventOrCatalogId: string;
  },
): VerifiedPublisherEventProvenance | undefined {
  if (!input) return undefined;

  const publisherHost = exactLowercaseHost(
    input.publisherHost,
    "upstreamProvenance.publisherEvent.publisherHost",
  );
  const canonicalUrl = exactHttpsUrl(
    input.canonicalUrl,
    "upstreamProvenance.publisherEvent.canonicalUrl",
  );
  if (new URL(canonicalUrl).hostname !== publisherHost) {
    throw new DomainValidationError(
      "upstreamProvenance.publisherEvent.canonicalUrl must use publisherHost",
      "upstreamProvenance.publisherEvent.canonicalUrl",
    );
  }
  const categoryInputs = input.categoryKeys;
  if (
    !Array.isArray(categoryInputs) ||
    categoryInputs.length > 32
  ) {
    throw new DomainValidationError(
      "upstreamProvenance.publisherEvent.categoryKeys must contain 0 to 32 keys",
      "upstreamProvenance.publisherEvent.categoryKeys",
    );
  }
  const categoryKeys = categoryInputs.map((value, index) => {
    const key = boundedSourceText(
      value,
      `upstreamProvenance.publisherEvent.categoryKeys[${index}]`,
      200,
    );
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(key)) {
      throw new DomainValidationError(
        "upstreamProvenance.publisherEvent.categoryKeys must be stable lowercase keys",
        "upstreamProvenance.publisherEvent.categoryKeys",
      );
    }
    return key;
  });
  const sortedCategoryKeys = [...categoryKeys].sort();
  if (
    new Set(categoryKeys).size !== categoryKeys.length ||
    categoryKeys.some((value, index) => value !== sortedCategoryKeys[index])
  ) {
    throw new DomainValidationError(
      "upstreamProvenance.publisherEvent.categoryKeys must be unique and sorted",
      "upstreamProvenance.publisherEvent.categoryKeys",
    );
  }

  const outbound = input.outboundCatalog;
  if (!outbound || typeof outbound !== "object") {
    throw new DomainValidationError(
      "upstreamProvenance.publisherEvent.outboundCatalog is required",
      "upstreamProvenance.publisherEvent.outboundCatalog",
    );
  }
  const outboundPlatform = lowercaseStableIdentifier(
    outbound.platform,
    "upstreamProvenance.publisherEvent.outboundCatalog.platform",
  );
  const outboundHost = exactLowercaseHost(
    outbound.host,
    "upstreamProvenance.publisherEvent.outboundCatalog.host",
  );
  const outboundEventOrCatalogId = boundedSourceText(
    outbound.eventOrCatalogId,
    "upstreamProvenance.publisherEvent.outboundCatalog.eventOrCatalogId",
    512,
  );
  if (
    outboundPlatform !== upstream.platform ||
    outboundHost !== upstream.host ||
    outboundEventOrCatalogId !== upstream.eventOrCatalogId
  ) {
    throw new DomainValidationError(
      "upstreamProvenance.publisherEvent outbound tuple must match the upstream tuple",
      "upstreamProvenance.publisherEvent.outboundCatalog",
    );
  }

  const rawLocation = optionalText(
    input.locationText,
    "upstreamProvenance.publisherEvent.locationText",
  );
  const locationText = rawLocation
    ? boundedSourceText(
        rawLocation,
        "upstreamProvenance.publisherEvent.locationText",
        1_000,
      )
    : null;
  const eventImageUrl = input.eventImageUrl
    ? exactHttpsUrl(
        input.eventImageUrl,
        "upstreamProvenance.publisherEvent.eventImageUrl",
      )
    : null;

  return Object.freeze({
    publisherHost,
    eventId: boundedSourceText(
      input.eventId,
      "upstreamProvenance.publisherEvent.eventId",
      512,
    ),
    canonicalUrl,
    title: boundedSourceText(
      input.title,
      "upstreamProvenance.publisherEvent.title",
      1_000,
    ),
    summary: boundedSourceText(
      input.summary,
      "upstreamProvenance.publisherEvent.summary",
      4_000,
    ),
    startsText: boundedSourceText(
      input.startsText,
      "upstreamProvenance.publisherEvent.startsText",
      500,
    ),
    endsText: boundedSourceText(
      input.endsText,
      "upstreamProvenance.publisherEvent.endsText",
      500,
    ),
    locationText,
    categoryKeys: Object.freeze(categoryKeys),
    eventImageUrl,
    outboundCatalog: Object.freeze({
      platform: outboundPlatform,
      host: outboundHost,
      eventOrCatalogId: outboundEventOrCatalogId,
      url: exactHttpsUrl(
        outbound.url,
        "upstreamProvenance.publisherEvent.outboundCatalog.url",
      ),
    }),
  });
}

export function normalizeVerifiedUpstreamProvenance(
  input: VerifiedUpstreamProvenanceInput | null | undefined,
): VerifiedUpstreamProvenance | null {
  if (!input) return null;

  const platform = lowercaseStableIdentifier(
    input.platform,
    "upstreamProvenance.platform",
  );
  const host = exactLowercaseHost(
    input.host,
    "upstreamProvenance.host",
  );

  const eventOrCatalogId = boundedSourceText(
    input.eventOrCatalogId,
    "upstreamProvenance.eventOrCatalogId",
    512,
  );
  const lotId = boundedSourceText(
    input.lotId,
    "upstreamProvenance.lotId",
    512,
  );
  const rawEventName = optionalText(
    input.eventName,
    "upstreamProvenance.eventName",
  );
  const eventName = rawEventName
    ? boundedSourceText(
        rawEventName,
        "upstreamProvenance.eventName",
        1_000,
      )
    : null;
  const eventUrl = optionalHttpUrl(
    input.eventUrl,
    "upstreamProvenance.eventUrl",
  );
  if (eventUrl && new URL(eventUrl).protocol !== "https:") {
    throw new DomainValidationError(
      "upstreamProvenance.eventUrl must use https",
      "upstreamProvenance.eventUrl",
    );
  }

  const aliases = input.observedAliases ?? [];
  if (!Array.isArray(aliases) || aliases.length > 32) {
    throw new DomainValidationError(
      "upstreamProvenance.observedAliases must contain at most 32 aliases",
      "upstreamProvenance.observedAliases",
    );
  }
  const observedAliases: string[] = [];
  const aliasKeys = new Set<string>();
  for (const [index, value] of aliases.entries()) {
    const alias = boundedSourceText(
      value,
      `upstreamProvenance.observedAliases[${index}]`,
      200,
    );
    const key = alias.toLocaleLowerCase();
    if (aliasKeys.has(key)) {
      throw new DomainValidationError(
        "upstreamProvenance.observedAliases must be unique",
        "upstreamProvenance.observedAliases",
      );
    }
    aliasKeys.add(key);
    observedAliases.push(alias);
  }
  const publisherEvent = normalizePublisherEventProvenance(
    input.publisherEvent,
    { platform, host, eventOrCatalogId },
  );

  return Object.freeze({
    platform,
    host,
    eventOrCatalogId,
    lotId,
    eventName,
    eventUrl,
    observedAliases: Object.freeze(observedAliases),
    ...(publisherEvent ? { publisherEvent } : {}),
  });
}

function normalizedObservedAliases(
  aliases: readonly string[] | undefined,
  field: string,
): readonly string[] {
  const values = aliases ?? [];
  if (!Array.isArray(values) || values.length > 32) {
    throw new DomainValidationError(
      `${field} must contain at most 32 aliases`,
      field,
    );
  }
  const result: string[] = [];
  const keys = new Set<string>();
  for (const [index, value] of values.entries()) {
    const alias = boundedSourceText(value, `${field}[${index}]`, 200);
    const key = alias.toLocaleLowerCase();
    if (keys.has(key)) {
      throw new DomainValidationError(`${field} must be unique`, field);
    }
    keys.add(key);
    result.push(alias);
  }
  return Object.freeze(result);
}

function normalizeSharedAliasProvenance(
  input: VerifiedSharedAliasProvenanceInput | null | undefined,
): VerifiedSharedAliasProvenance | null {
  if (!input) return null;
  const family = boundedSourceText(
    input.family,
    "sharedAliasProvenance.family",
    100,
  );
  if (
    family !== family.toLowerCase() ||
    !/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/u.test(family)
  ) {
    throw new DomainValidationError(
      "sharedAliasProvenance.family must be a lowercase stable identifier",
      "sharedAliasProvenance.family",
    );
  }
  const sharedCatalogKey = boundedSourceText(
    input.sharedCatalogKey,
    "sharedAliasProvenance.sharedCatalogKey",
    512,
  );
  if (!/^fnv1a64:[0-9a-f]{16}$/u.test(input.verificationHash)) {
    throw new DomainValidationError(
      "sharedAliasProvenance.verificationHash must be an exact stable evidence hash",
      "sharedAliasProvenance.verificationHash",
    );
  }
  return Object.freeze({
    family,
    sharedCatalogKey,
    verificationHash: input.verificationHash,
    observedAliases: normalizedObservedAliases(
      input.observedAliases,
      "sharedAliasProvenance.observedAliases",
    ),
  });
}

function isoTimestamp(value: unknown, field: string): string {
  const raw = requireText(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    throw new DomainValidationError(`${field} must be an ISO-8601 timestamp`, field);
  }
  const milliseconds = Date.parse(raw);
  if (!Number.isFinite(milliseconds)) {
    throw new DomainValidationError(`${field} must be an ISO-8601 timestamp`, field);
  }
  return new Date(milliseconds).toISOString();
}

function optionalIsoTimestamp(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
    if (Number.isFinite(milliseconds)) return value;
  }
  return isoTimestamp(value, field);
}

function isEvidenceSource(value: unknown): value is LocationEvidenceSource {
  return (
    typeof value === "string" &&
    (locationEvidenceSources as readonly string[]).includes(value)
  );
}

export function normalizeLocationCandidate(
  input: Partial<LocationCandidate> | null | undefined,
): LocationCandidate | null {
  if (!input) return null;

  const city = optionalText(input.city, "location.city");
  const state = optionalText(input.state, "location.state")?.toUpperCase() ?? null;
  const postalCode = optionalText(input.postalCode, "location.postalCode");
  if (!city && !state && !postalCode) return null;

  const evidenceSource = input.evidenceSource ?? "unknown";
  if (!isEvidenceSource(evidenceSource)) {
    throw new DomainValidationError(
      "location.evidenceSource is not recognized",
      "location.evidenceSource",
    );
  }

  return Object.freeze({
    city,
    state,
    postalCode,
    countryCode: optionalText(input.countryCode, "location.countryCode")?.toUpperCase() ?? "US",
    evidenceSource,
  });
}

function normalizePrice(input: Partial<PriceAtScrape>): PriceAtScrape {
  const amountMinor = input.amountMinor ?? null;
  if (
    amountMinor !== null &&
    (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
  ) {
    throw new DomainValidationError(
      "priceAtScrape.amountMinor must be a non-negative safe integer or null",
      "priceAtScrape.amountMinor",
    );
  }

  const currency = optionalText(input.currency, "priceAtScrape.currency")?.toUpperCase() ?? null;
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) {
    throw new DomainValidationError(
      "priceAtScrape.currency must be a three-letter currency code",
      "priceAtScrape.currency",
    );
  }

  return Object.freeze({
    amountMinor,
    currency,
    displayText: optionalText(input.displayText, "priceAtScrape.displayText"),
  });
}

function normalizeImages(
  inputs: readonly Partial<ListingImageCandidate>[] = [],
): readonly ListingImageCandidate[] {
  const images = inputs.map((image, index) => {
    const position = image.position ?? index;
    if (!Number.isSafeInteger(position) || position < 0) {
      throw new DomainValidationError(
        "image.position must be a non-negative integer",
        `images[${index}].position`,
      );
    }
    return Object.freeze({
      sourceUrl: httpUrl(image.sourceUrl, `images[${index}].sourceUrl`),
      thumbnailUrl: optionalHttpUrl(
        image.thumbnailUrl,
        `images[${index}].thumbnailUrl`,
      ),
      position,
      isPrimary: image.isPrimary ?? index === 0,
    });
  });

  const positions = new Set(images.map((image) => image.position));
  const urls = new Set(images.map((image) => image.sourceUrl));
  if (positions.size !== images.length) {
    throw new DomainValidationError("image positions must be unique", "images");
  }
  if (urls.size !== images.length) {
    throw new DomainValidationError("image source URLs must be unique", "images");
  }
  if (images.length > 0 && images.filter((image) => image.isPrimary).length !== 1) {
    throw new DomainValidationError(
      "exactly one image must be marked primary",
      "images",
    );
  }

  return Object.freeze(images.slice().sort((a, b) => a.position - b.position));
}

function normalizeActionDeadline(
  input: ListingActionDeadline | null | undefined,
): ListingActionDeadline | null {
  if (input === null || input === undefined) return null;
  if (input.basis !== "live_auction_start") {
    throw new DomainValidationError(
      "actionDeadline.basis is unsupported",
      "actionDeadline.basis",
    );
  }
  return Object.freeze({
    at: isoTimestamp(input.at, "actionDeadline.at"),
    basis: input.basis,
    sourceText: requireText(input.sourceText, "actionDeadline.sourceText"),
  });
}

export function defineListingStub(input: ListingStubInput): NormalizedListingStub {
  return Object.freeze({
    sourceId: requireText(input.sourceId, "sourceId"),
    sourceListingId: requireText(input.sourceListingId, "sourceListingId"),
    sourceUrl: httpUrl(input.sourceUrl, "sourceUrl"),
    title: requireText(input.title, "title"),
    category: optionalText(input.category, "category"),
    lotNumber: optionalText(input.lotNumber, "lotNumber"),
    visibleLocation: normalizeLocationCandidate(input.visibleLocation),
    thumbnailUrl: optionalHttpUrl(input.thumbnailUrl, "thumbnailUrl"),
    discoveredAt: isoTimestamp(input.discoveredAt, "discoveredAt"),
    contentHash: requireText(input.contentHash, "contentHash"),
  });
}

export function defineListingDetail(
  input: ListingDetailInput,
): NormalizedListingDetail {
  return Object.freeze({
    sourceId: requireText(input.sourceId, "sourceId"),
    sourceListingId: requireText(input.sourceListingId, "sourceListingId"),
    sourceUrl: httpUrl(input.sourceUrl, "sourceUrl"),
    title: requireText(input.title, "title"),
    category: optionalText(input.category, "category"),
    lotNumber: optionalText(input.lotNumber, "lotNumber"),
    rawDescription: stringValue(input.rawDescription, "rawDescription"),
    cleanDescription: stringValue(input.cleanDescription, "cleanDescription").trim(),
    priceAtScrape: normalizePrice(input.priceAtScrape),
    auctionEndsAt: optionalIsoTimestamp(input.auctionEndsAt, "auctionEndsAt"),
    actionDeadline: normalizeActionDeadline(input.actionDeadline),
    seller: optionalText(input.seller, "seller"),
    pickupLocation: normalizeLocationCandidate(input.pickupLocation),
    images: normalizeImages(input.images),
    upstreamProvenance: normalizeVerifiedUpstreamProvenance(
      input.upstreamProvenance,
    ),
    sharedAliasProvenance: normalizeSharedAliasProvenance(
      input.sharedAliasProvenance,
    ),
    scrapedAt: isoTimestamp(input.scrapedAt, "scrapedAt"),
    contentHash: requireText(input.contentHash, "contentHash"),
  });
}
