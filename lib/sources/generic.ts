import {
  defineListingDetail,
  defineListingStub,
  type ListingActionDeadline,
  type ListingImageCandidate,
  type LocationCandidate,
  type NormalizedListingDetail,
  type NormalizedListingStub,
  type PriceAtScrape,
} from "../domain/listings";
import { exactListingEndHasPassed } from "./current-listings";
import { stableContentHash } from "./parsing";
import { validateRequestUrl } from "./request-control";
import {
  SourceAdapterError,
  type SourceAccessPolicy,
  type SourceAdapter,
  type SourceDiscoveredListing,
  type SourceManifest,
  type SourcePage,
  type SourceRequest,
  type SourceRequestPolicy,
} from "./types";

export interface GenericDetailFacts {
  readonly rawDescription: string;
  readonly cleanDescription: string;
  readonly priceAtScrape: Partial<PriceAtScrape>;
  readonly auctionEndsAt: string | null;
  readonly actionDeadline?: ListingActionDeadline | null;
  readonly seller: string | null;
  readonly pickupLocation?: Partial<LocationCandidate> | null;
  /** An explicit empty array means the source proves that no images exist. */
  readonly images: readonly Partial<ListingImageCandidate>[];
}

/** Mapping functions return source facts, never inferred or generated values. */
export interface GenericListingFacts {
  readonly sourceListingId: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly category?: string | null;
  readonly lotNumber?: string | null;
  readonly visibleLocation?: Partial<LocationCandidate> | null;
  readonly thumbnailUrl?: string | null;
  readonly currentState: "current" | "ended";
  readonly reviewCandidate?: boolean;
  readonly detail?: GenericDetailFacts;
}

export interface GenericMappingContext {
  readonly sourceId: string;
  readonly pageUrl: string;
  readonly fetchedAt: string;
}

export interface GenericSourceOptions {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  /** One complete inventory document. Pagination requires a local adapter. */
  readonly inventoryUrl: string;
  readonly access?: SourceAccessPolicy;
  readonly requests?: Partial<SourceRequestPolicy>;
  /** Values stay in the local integration and are never put in the manifest. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly maximumListings?: number;
  readonly inlineDetails?: boolean;
}

export interface GenericParser {
  readonly parseInventory: (page: SourcePage, context: GenericMappingContext) => readonly GenericListingFacts[];
  readonly detail?: {
    readonly url?: (stub: NormalizedListingStub) => string;
    readonly parse: (page: SourcePage, context: GenericMappingContext) => GenericListingFacts;
  };
}

const DEFAULT_ACCESS: SourceAccessPolicy = Object.freeze({
  permissionBasis: "manual_review_required",
  termsUrl: null,
  robotsUrl: null,
  documentationUrls: Object.freeze([]),
  reviewedAt: "",
  note: "No source access review has been configured.",
});

export function createGenericSource(
  options: GenericSourceOptions,
  transport: "json_api" | "html",
  acquisition: "direct" | "isolated_browser",
  parser: GenericParser,
): SourceAdapter {
  if (!options.inlineDetails && !parser.detail) {
    throw new TypeError("A source must provide inline details or a detail parser.");
  }
  if (options.inlineDetails && parser.detail) {
    throw new TypeError("Inline detail sources must not also plan detail requests.");
  }
  const maximumListings = options.maximumListings ?? 1_000;
  boundedInteger(maximumListings, 1, 25_000, "maximumListings");
  const manifest = createGenericManifest(options, transport, acquisition);
  const inventoryUrl = validateRequestUrl(manifest, options.inventoryUrl).href;
  const headers = options.headers ? Object.freeze({ ...options.headers }) : undefined;
  const inventoryRequest: SourceRequest = Object.freeze({
    kind: "discovery",
    url: inventoryUrl,
    ...(headers ? { headers } : {}),
  });
  const context = (page: SourcePage): GenericMappingContext => ({
    sourceId: manifest.id,
    pageUrl: page.url,
    fetchedAt: page.fetchedAt,
  });
  const parseInventory = (page: SourcePage): readonly SourceDiscoveredListing[] => {
    validatePage(manifest, page, inventoryUrl);
    const facts = parser.parseInventory(page, context(page));
    if (!Array.isArray(facts) || facts.length > maximumListings) {
      throw new SourceAdapterError(manifest.id, "Inventory exceeds its configured listing ceiling or is not an array.");
    }
    const ids = new Set<string>();
    const urls = new Set<string>();
    const listings: SourceDiscoveredListing[] = [];
    for (const fact of facts) {
      const listing = normalizeFacts(manifest, fact, page, options.inlineDetails === true);
      if (ids.has(listing.stub.sourceListingId) || urls.has(listing.stub.sourceUrl)) {
        throw new SourceAdapterError(manifest.id, "Inventory repeats a listing identity or canonical URL.");
      }
      ids.add(listing.stub.sourceListingId);
      urls.add(listing.stub.sourceUrl);
      if (listing.currentState !== "ended") listings.push(listing);
    }
    return Object.freeze(listings);
  };
  const planDetail = (stub: NormalizedListingStub): SourceRequest | null => {
    if (stub.sourceId !== manifest.id) {
      throw new SourceAdapterError(manifest.id, "Detail request belongs to another source.");
    }
    if (!parser.detail) return null;
    return {
      kind: "detail",
      url: validateRequestUrl(manifest, new URL(parser.detail.url?.(stub) ?? stub.sourceUrl, manifest.baseUrl).href).href,
      ...(headers ? { headers } : {}),
    };
  };
  const parseBoundDetail = (page: SourcePage, stub: NormalizedListingStub, requireDetail: boolean) => {
    if (!parser.detail) throw new SourceAdapterError(manifest.id, "This source has no detail request path.");
    validatePage(manifest, page, planDetail(stub)!.url);
    const listing = normalizeFacts(manifest, parser.detail.parse(page, context(page)), page, requireDetail);
    if (listing.stub.sourceListingId !== stub.sourceListingId || listing.stub.sourceUrl !== stub.sourceUrl) {
      throw new SourceAdapterError(manifest.id, "Detail response does not match its catalog identity.");
    }
    return listing;
  };
  return Object.freeze({
    manifest,
    drainPublishedInventoryPreparation: true,
    ...(options.inlineDetails ? { publishedInlineInventoryProvesCompleteImageIdentitySet: true as const } : {}),
    planDiscovery: () => [inventoryRequest],
    parseDiscoveryBatch: parseInventory,
    parseDiscoveryPage: (page: SourcePage) => parseInventory(page).map(({ stub }) => stub),
    planInventoryTraversal: (page: SourcePage) => {
      if (page.url !== inventoryUrl) return null;
      const listings = parseInventory(page);
      return {
        fingerprint: stableContentHash({
          contract: "generic-complete-document-v1",
          sourceId: manifest.id,
          url: inventoryUrl,
          listings: listings.map(({ stub, detail }) => [stub.sourceListingId, stub.contentHash, detail?.contentHash ?? null]),
        }),
        inventoryCardinality: "exact" as const,
        expectedListings: listings.length,
        pages: [{
          key: "inventory:document",
          request: inventoryRequest,
          minimumListings: listings.length,
          maximumListings: listings.length,
          inventoryMember: true,
          reviewCandidate: true,
        }],
      };
    },
    validateInventoryTraversalPage: (page: SourcePage, expectedListings: number) => {
      if (parseInventory(page).length !== expectedListings) {
        throw new SourceAdapterError(manifest.id, "Inventory changed between planning and validation.");
      }
    },
    planDetail,
    parseDetailPage: (page: SourcePage, stub?: NormalizedListingStub): NormalizedListingDetail => {
      if (!stub || !parser.detail) {
        throw new SourceAdapterError(manifest.id, "A planned detail request and listing identity are required.");
      }
      const listing = parseBoundDetail(page, stub, true);
      if (!listing.detail || (listing.currentState === "ended" && !exactListingEndHasPassed(listing.detail.auctionEndsAt, page.fetchedAt))) {
        throw new SourceAdapterError(manifest.id, "Detail source reports that the listing has ended.");
      }
      return listing.detail;
    },
    ...(parser.detail ? { isDetailPageProvablyEnded: (page: SourcePage, stub: NormalizedListingStub) =>
      parseBoundDetail(page, stub, false).currentState === "ended" } : {}),
    isDetailProvablyEnded: (page: SourcePage, detail: NormalizedListingDetail) =>
      exactListingEndHasPassed(detail.auctionEndsAt, page.fetchedAt),
  });
}

export function createGenericManifest(
  options: GenericSourceOptions,
  transport: SourceManifest["transport"],
  acquisition: SourceManifest["acquisition"],
): SourceManifest {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(options.id)) throw new TypeError("Source ID is invalid.");
  if (typeof options.displayName !== "string" || !options.displayName.trim()) throw new TypeError("Source display name is required.");
  const baseUrl = new URL(options.baseUrl);
  if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.port || baseUrl.hash) {
    throw new TypeError("Source base URL must use HTTPS without credentials, a port or a fragment.");
  }
  const requests: SourceRequestPolicy = {
    allowedHosts: [baseUrl.hostname],
    allowedRedirectHosts: [],
    allowedBrowserResourceHosts: [],
    allowedBrowserRequests: [],
    allowedImageHosts: [],
    allowedRequestHeaders: [],
    minDelayMs: 1_000,
    maxRequestsPerRun: 25,
    maxRedirects: 0,
    timeoutMs: 15_000,
    maxRetries: 0,
    maxResponseBytes: 2 * 1024 * 1024,
    ...options.requests,
  };
  boundedInteger(requests.minDelayMs, 1, 3_600_000, "minDelayMs");
  boundedInteger(requests.maxRequestsPerRun, 1, 10_000, "maxRequestsPerRun");
  boundedInteger(requests.timeoutMs, 1, 120_000, "timeoutMs");
  boundedInteger(requests.maxRetries, 0, 2, "maxRetries");
  boundedInteger(requests.maxRedirects ?? 0, 0, 3, "maxRedirects");
  boundedInteger(requests.maxResponseBytes, 1, 16 * 1024 * 1024, "maxResponseBytes");
  if (requests.maxImageResponseBytes !== undefined) boundedInteger(requests.maxImageResponseBytes, 1, 32 * 1024 * 1024, "maxImageResponseBytes");
  if (requests.distinctImageMinDelayMs !== undefined) boundedInteger(requests.distinctImageMinDelayMs, 1, 3_600_000, "distinctImageMinDelayMs");
  for (const hosts of [requests.allowedHosts, requests.allowedRedirectHosts, requests.allowedBrowserResourceHosts,
    requests.allowedImageHosts, requests.allowedBrowserDocumentHosts]) {
    if (hosts === undefined) continue;
    if (!Array.isArray(hosts) || new Set(hosts).size !== hosts.length || hosts.some((host) =>
      typeof host !== "string" || !host || host !== host.toLowerCase() ||
      new URL(`https://${host}`).hostname !== host || /[^a-z0-9.-]/u.test(host))) {
      throw new TypeError("Source hosts must be distinct exact lowercase hostnames.");
    }
  }
  if (requests.allowedHosts.length === 0) throw new TypeError("A source needs an allowed document host.");
  for (const rule of requests.allowedBrowserRequests ?? []) {
    const target = new URL(`https://${rule.host}${rule.path}`);
    if (rule.host !== target.hostname || rule.host !== rule.host.toLowerCase() || /[^a-z0-9.-]/u.test(rule.host) ||
      !rule.path.startsWith("/") || rule.path.includes("*") || target.pathname + target.search !== rule.path || target.hash ||
      rule.method !== "GET" || !["script", "xhr", "fetch", "stylesheet"].includes(rule.resourceType)) {
      throw new TypeError("Browser resource rules require an exact HTTPS host, path, GET method and supported resource type.");
    }
  }
  const frozenRequests = Object.freeze(Object.fromEntries(Object.entries(requests).map(([key, value]) =>
    [key, Array.isArray(value) ? Object.freeze(value.map((entry: unknown) => typeof entry === "object" && entry !== null ? Object.freeze({ ...entry }) : entry)) : value],
  ))) as unknown as SourceRequestPolicy;
  const access = options.access ?? DEFAULT_ACCESS;
  return Object.freeze({
    id: options.id,
    displayName: options.displayName.trim(),
    baseUrl: baseUrl.href,
    inventoryScope: "current",
    transport,
    acquisition,
    implementationStatus: "ready",
    enabledByDefault: false,
    access: Object.freeze({ ...access, documentationUrls: Object.freeze([...access.documentationUrls]) }),
    requests: frozenRequests,
  });
}

function normalizeFacts(
  manifest: SourceManifest,
  facts: GenericListingFacts,
  page: SourcePage,
  requireDetail: boolean,
): SourceDiscoveredListing {
  if (!facts || (facts.currentState !== "current" && facts.currentState !== "ended")) {
    throw new SourceAdapterError(manifest.id, "Listing current state must be explicit source evidence.");
  }
  if (facts.reviewCandidate !== undefined && typeof facts.reviewCandidate !== "boolean") {
    throw new SourceAdapterError(manifest.id, "Listing review-candidate flag is invalid.");
  }
  const sourceUrl = validateRequestUrl(manifest, new URL(facts.sourceUrl, page.url).href).href;
  const thumbnailUrl = facts.thumbnailUrl ? imageUrl(manifest, facts.thumbnailUrl, page.url) : null;
  const stubFacts = {
    sourceId: manifest.id,
    sourceListingId: facts.sourceListingId,
    sourceUrl,
    title: facts.title,
    category: facts.category ?? null,
    lotNumber: facts.lotNumber ?? null,
    visibleLocation: explicitLocation(facts.visibleLocation),
    thumbnailUrl,
  };
  const stub = defineListingStub({ ...stubFacts, discoveredAt: page.fetchedAt, contentHash: stableContentHash(stubFacts) });
  let detail: NormalizedListingDetail | undefined;
  if (requireDetail && !facts.detail && facts.currentState !== "ended") throw new SourceAdapterError(manifest.id, "Inline inventory omitted required detail facts.");
  if (facts.detail) {
    if (!Array.isArray(facts.detail.images)) {
      throw new SourceAdapterError(manifest.id, "Detail must explicitly provide its complete image array.");
    }
    const detailFacts = {
      sourceId: manifest.id,
      sourceListingId: stub.sourceListingId,
      sourceUrl,
      title: stub.title,
      category: stub.category,
      lotNumber: stub.lotNumber,
      rawDescription: facts.detail.rawDescription,
      cleanDescription: facts.detail.cleanDescription,
      priceAtScrape: facts.detail.priceAtScrape,
      auctionEndsAt: facts.detail.auctionEndsAt,
      actionDeadline: facts.detail.actionDeadline ?? null,
      seller: facts.detail.seller,
      pickupLocation: explicitLocation(facts.detail.pickupLocation),
      images: facts.detail.images.map((image, index) => ({
        sourceUrl: imageUrl(manifest, image.sourceUrl, page.url),
        thumbnailUrl: image.thumbnailUrl ? imageUrl(manifest, image.thumbnailUrl, page.url) : null,
        position: index,
        isPrimary: index === 0,
      })),
    };
    detail = defineListingDetail({ ...detailFacts, scrapedAt: page.fetchedAt, contentHash: stableContentHash(detailFacts) });
  }
  const ended = facts.currentState === "ended" || Boolean(detail && exactListingEndHasPassed(detail.auctionEndsAt, page.fetchedAt));
  return Object.freeze({ stub, ...(detail ? { detail } : {}), currentState: ended ? "ended" : "current", reviewCandidate: facts.reviewCandidate ?? true });
}

function explicitLocation(value: Partial<LocationCandidate> | null | undefined): Partial<LocationCandidate> | null {
  if (value == null) return null;
  if (typeof value.countryCode !== "string" || !/^[A-Z]{2}$/u.test(value.countryCode)) {
    throw new TypeError("A mapped location must contain an explicit two-letter country code.");
  }
  return value;
}

function imageUrl(manifest: SourceManifest, value: unknown, base: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SourceAdapterError(manifest.id, "Image URL is missing.");
  const url = new URL(value, base);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
    !manifest.requests.allowedImageHosts?.includes(url.hostname)) {
    throw new SourceAdapterError(manifest.id, "Image URL is outside configured image hosts.");
  }
  return url.href;
}

function validatePage(manifest: SourceManifest, page: SourcePage, expectedUrl: string): void {
  if (page.url !== expectedUrl || !Number.isFinite(Date.parse(page.fetchedAt)) ||
    typeof page.body !== "string" || new TextEncoder().encode(page.body).byteLength > manifest.requests.maxResponseBytes) {
    throw new SourceAdapterError(manifest.id, "Source page identity, timestamp or byte length is invalid.");
  }
  if (page.contentType !== undefined) {
    const mime = page.contentType.split(";", 1)[0]!.trim().toLowerCase();
    const allowed = manifest.transport === "json_api"
      ? mime === "application/json" || /^application\/[a-z0-9.+-]+\+json$/u.test(mime)
      : mime === "text/html" || mime === "application/xhtml+xml";
    if (!allowed) throw new SourceAdapterError(manifest.id, "Source page has an unexpected content type.");
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}
