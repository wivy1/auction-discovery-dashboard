import { assertSourceAccess, type SourceAccessGrant } from "./access";
import {
  ConservativeRequestController,
  StagedConservativeRequestController,
  type ConservativeRequestControllerOptions,
  type SourceRequestController,
  validateRequestUrl,
} from "./request-control";
import { exactListingEndHasPassed } from "./current-listings";
import type {
  SourceAdapter,
  SourceDiscoveredListing,
  SourceId,
  SourceInventoryPageRequest,
  SourceInventoryTraversalPlan,
  SourceManifest,
  SourcePage,
  SourceRequest,
} from "./types";

export interface AcquiredSourcePage {
  readonly request: SourceRequest;
  readonly page: SourcePage;
  /** First permitted top-level document request start. */
  readonly startedAt: string;
  /** Every permitted top-level document request start, including redirects. */
  readonly requestStartedAt: readonly string[];
  readonly bodySha256: string;
  /**
   * Browser GET acquisition conservatively reserves two units for one
   * navigation plus its contract-bounded second start. A native form POST
   * reserves three for its initial GET, exact POST, and optional source-owned
   * PRG GET, including when the POST response itself is final.
   */
  readonly requestBudgetCost: 1 | 2 | 3;
}

export function acquiredRequestBudgetCost(
  request: Pick<SourceRequest, "method">,
): 2 | 3 {
  return request.method === "POST" ? 3 : 2;
}

export function acquiredRequestBudgetCostForSource(
  sourceId: SourceId,
  request: Pick<SourceRequest, "method">,
): 1 | 2 | 3 {
  return acquiredRequestBudgetCost(request);
}

export interface AcquiredPageRequestControllerOptions {
  readonly direct?: ConservativeRequestControllerOptions;
}

export interface BootstrapSupplementRequestControllerOptions {
  readonly direct?: ConservativeRequestControllerOptions;
}

export interface AcquiredCallbackWindowSegment {
  readonly manifest: SourceManifest;
  readonly pageCount: number;
}

export interface ExactEmptyBootstrapInventoryPlan {
  readonly traversal: SourceInventoryTraversalPlan;
  readonly pages: readonly {
    readonly request: SourceRequest;
    readonly page: SourcePage;
    readonly plannedPage: SourceInventoryPageRequest;
  }[];
}

/**
 * Accepts a rootless metadata bootstrap only when the adapter proves an exact
 * empty inventory from already-acquired bootstrap evidence. The audit pages
 * keep the durable traversal nonempty without authorizing another request.
 */
export function planExactEmptyBootstrapInventory(
  adapter: SourceAdapter,
  bootstrap: readonly Pick<AcquiredSourcePage, "request" | "page">[],
): ExactEmptyBootstrapInventoryPlan {
  if (
    !adapter.planInventoryTraversalBootstrap ||
    !adapter.planInventoryTraversalBundle
  ) {
    throw new Error(
      `${adapter.manifest.id} does not support exact-empty inventory bootstrap.`,
    );
  }
  const discovery = adapter.planDiscovery({ canary: false });
  if (
    discovery.length < 1 ||
    bootstrap.length !== discovery.length ||
    bootstrap.some((entry, index) =>
      acquiredRequestKey(adapter.manifest, entry.request) !==
        acquiredRequestKey(adapter.manifest, discovery[index]!)
    )
  ) {
    throw new Error(
      `${adapter.manifest.id} exact-empty bootstrap metadata is incomplete.`,
    );
  }
  const bootstrapPages = bootstrap.map((entry) => entry.page);
  if (adapter.planInventoryTraversalBootstrap(bootstrapPages).length !== 0) {
    throw new Error(
      `${adapter.manifest.id} exact-empty bootstrap returned inventory roots.`,
    );
  }
  if (
    (adapter.planInventoryTraversalBootstrapFollowup?.([], bootstrapPages) ?? [])
      .length !== 0
  ) {
    throw new Error(
      `${adapter.manifest.id} exact-empty bootstrap returned follow-up roots.`,
    );
  }
  const traversal = adapter.planInventoryTraversalBundle([], bootstrapPages);
  if (
    !traversal ||
    (traversal.inventoryCardinality ?? "exact") !== "exact" ||
    traversal.expectedListings !== 0 ||
    (traversal.expectedReviewCandidates ?? 0) !== 0 ||
    traversal.pages.length < 1
  ) {
    throw new Error(
      `${adapter.manifest.id} rootless bootstrap is not an exact empty inventory.`,
    );
  }

  const bootstrapByRequest = new Map(
    bootstrap.map((entry) => [
      acquiredRequestKey(adapter.manifest, entry.request),
      entry,
    ] as const),
  );
  if (bootstrapByRequest.size !== bootstrap.length) {
    throw new Error(
      `${adapter.manifest.id} exact-empty bootstrap repeats metadata.`,
    );
  }
  const plannedKeys = new Set<string>();
  const plannedRequests = new Set<string>();
  const pages = traversal.pages.map((plannedPage) => {
    const requestKey = acquiredRequestKey(
      adapter.manifest,
      plannedPage.request,
    );
    const acquired = bootstrapByRequest.get(requestKey);
    if (
      plannedKeys.has(plannedPage.key) ||
      plannedRequests.has(requestKey) ||
      !acquired ||
      plannedPage.minimumListings !== 0 ||
      plannedPage.maximumListings !== 0 ||
      plannedPage.inventoryMember ||
      plannedPage.reviewCandidate
    ) {
      throw new Error(
        `${adapter.manifest.id} exact-empty bootstrap audit plan is invalid.`,
      );
    }
    plannedKeys.add(plannedPage.key);
    plannedRequests.add(requestKey);
    adapter.validateInventoryTraversalPage?.(
      acquired.page,
      traversal.expectedListings,
      plannedPage,
    );
    const parsed = adapter.parseDiscoveryBatch
      ? adapter.parseDiscoveryBatch(acquired.page, plannedPage)
      : adapter.parseDiscoveryPage(acquired.page);
    if (parsed.length !== 0) {
      throw new Error(
        `${adapter.manifest.id} exact-empty bootstrap audit returned listings.`,
      );
    }
    return {
      request: acquired.request,
      page: acquired.page,
      plannedPage,
    };
  });
  adapter.validateInventoryTraversalBundle?.(
    pages.map((entry) => entry.page),
    traversal,
  );
  return { traversal, pages };
}

export function isAllowedAcquiredPageContentType(
  sourceId: SourceId,
  request: SourceRequest,
  contentType: string,
): boolean {
  const mediaType = contentType
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  let url: URL | null = null;
  try {
    url = new URL(request.url);
  } catch {
    // Request URL validation reports the authoritative error later.
  }
  if (
    request.method === undefined &&
    url?.pathname === "/robots.txt" &&
    !url.search &&
    !url.hash
  ) {
    return mediaType === "text/plain";
  }
  return mediaType === "text/html";
}

/**
 * Bounds one callback by every browser document acquired before it. Composite
 * callbacks therefore retain the same finite allowance without making an
 * early source stale while later registered sources are still being captured.
 */
export function acquiredCallbackWindowMs(
  segments: readonly AcquiredCallbackWindowSegment[],
  processingAllowanceMs: number,
): number {
  if (
    !Number.isSafeInteger(processingAllowanceMs) ||
    processingAllowanceMs < 0
  ) {
    throw new RangeError(
      "Acquired callback processing allowance must be a non-negative integer.",
    );
  }
  let windowMs = processingAllowanceMs;
  for (const { manifest, pageCount } of segments) {
    if (!Number.isSafeInteger(pageCount) || pageCount < 0) {
      throw new RangeError(
        `${manifest.id} acquired callback page count is invalid.`,
      );
    }
    const perPageMs =
      manifest.requests.timeoutMs + manifest.requests.minDelayMs;
    const segmentMs = pageCount * perPageMs;
    if (
      !Number.isSafeInteger(perPageMs) ||
      perPageMs < 0 ||
      !Number.isSafeInteger(segmentMs) ||
      !Number.isSafeInteger(windowMs + segmentMs)
    ) {
      throw new RangeError(
        `${manifest.id} acquired callback window is invalid.`,
      );
    }
    windowMs += segmentMs;
  }
  return windowMs;
}

/**
 * Parses and validates a complete acquired inventory snapshot without writes.
 * Composite callers run this for every bundle before entering the ordinary
 * persistence pipeline, so a later source's malformed page cannot follow an
 * earlier source publication.
 */
export function preflightAcquiredInventoryBundle(
  adapter: SourceAdapter,
  pages: readonly AcquiredSourcePage[],
  eligibilityAt?: string,
): void {
  if (adapter.manifest.acquisition !== "isolated_browser") {
    throw new Error(
      `${adapter.manifest.id} does not permit acquired inventory preflight.`,
    );
  }
  const root = pages[0];
  let traversal: ReturnType<
    NonNullable<SourceAdapter["planInventoryTraversal"]>
  > = null;
  let inventoryPages = pages;
  if (
    adapter.planInventoryTraversalBootstrap &&
    adapter.planInventoryTraversalBundle
  ) {
    const discovery = adapter.planDiscovery({ canary: false });
    if (
      discovery.length < 1 ||
      pages.length <= discovery.length
    ) {
      throw new Error(
        `${adapter.manifest.id} acquired inventory bootstrap is incomplete.`,
      );
    }
    const initial = pages.slice(0, discovery.length);
    for (const [index, acquired] of initial.entries()) {
      if (
        acquiredRequestKey(adapter.manifest, acquired.request) !==
          acquiredRequestKey(adapter.manifest, discovery[index]!)
      ) {
        throw new Error(
          `${adapter.manifest.id} acquired inventory bootstrap metadata drifted.`,
        );
      }
    }
    const rootRequests = adapter.planInventoryTraversalBootstrap(
      initial.map((entry) => entry.page),
    );
    const rootPages = pages.slice(
      discovery.length,
      discovery.length + rootRequests.length,
    );
    if (
      rootRequests.length < 1 ||
      rootPages.length !== rootRequests.length ||
      rootPages.some((entry, index) =>
        acquiredRequestKey(adapter.manifest, entry.request) !==
          acquiredRequestKey(adapter.manifest, rootRequests[index]!)
      )
    ) {
      throw new Error(
        `${adapter.manifest.id} acquired inventory bootstrap roots drifted.`,
      );
    }
    traversal = adapter.planInventoryTraversalBundle(
      rootPages.map((entry) => entry.page),
      initial.map((entry) => entry.page),
    );
    inventoryPages = pages.slice(discovery.length);
  } else {
    traversal = root
      ? adapter.planInventoryTraversal?.(root.page) ?? null
      : null;
  }
  if (!root || !traversal) {
    throw new Error(
      `${adapter.manifest.id} acquired inventory preflight has no root plan.`,
    );
  }
  const normalizedEligibilityAt = eligibilityAt === undefined
    ? null
    : normalizedAcquiredCompletionAt(eligibilityAt);
  if (
    normalizedEligibilityAt &&
    pages.some((acquired) =>
      Date.parse(acquired.page.fetchedAt) > Date.parse(normalizedEligibilityAt)
    )
  ) {
    throw new Error(
      `${adapter.manifest.id} acquired inventory eligibility precedes bundle completion.`,
    );
  }

  const plannedByRequest = new Map<
    string,
    (typeof traversal.pages)[number]
  >();
  const plannedPageKeys = new Set<string>();
  for (const planned of traversal.pages) {
    if (plannedPageKeys.has(planned.key)) {
      throw new Error(
        `${adapter.manifest.id} acquired inventory plan repeats page key ${planned.key}.`,
      );
    }
    plannedPageKeys.add(planned.key);
    const requestKey = acquiredRequestKey(adapter.manifest, planned.request);
    if (plannedByRequest.has(requestKey)) {
      throw new Error(
        `${adapter.manifest.id} acquired inventory plan repeats a request.`,
      );
    }
    plannedByRequest.set(requestKey, planned);
  }

  const acquiredByRequest = new Map<string, AcquiredSourcePage>();
  for (const acquired of inventoryPages) {
    const requestKey = acquiredRequestKey(
      adapter.manifest,
      acquired.request,
    );
    if (acquiredByRequest.has(requestKey)) {
      throw new Error(
        `${adapter.manifest.id} acquired inventory preflight repeats a page.`,
      );
    }
    acquiredByRequest.set(requestKey, acquired);
  }
  if (
    acquiredByRequest.size !== plannedByRequest.size ||
    [...acquiredByRequest.keys()].some((key) => !plannedByRequest.has(key))
  ) {
    throw new Error(
      `${adapter.manifest.id} acquired inventory pages do not match the root plan.`,
    );
  }

  const inventoryListingIds = new Set<string>();
  const reviewRoles = new Map<
    string,
    { eligible: boolean; explicitlyCatalogOnly: boolean }
  >();
  const orderedPages: SourcePage[] = [];
  for (const planned of traversal.pages) {
    const requestKey = acquiredRequestKey(adapter.manifest, planned.request);
    const acquired = acquiredByRequest.get(requestKey);
    if (!acquired) {
      throw new Error(
        `${adapter.manifest.id} acquired inventory omits page ${planned.key}.`,
      );
    }
    orderedPages.push(acquired.page);
    adapter.validateInventoryTraversalPage?.(
      acquired.page,
      traversal.expectedListings,
      planned,
    );
    const parsed: readonly SourceDiscoveredListing[] =
      adapter.parseDiscoveryBatch
      ? adapter.parseDiscoveryBatch(acquired.page)
      : adapter.parseDiscoveryPage(acquired.page).map((stub) => ({ stub }));
    if (
      parsed.length < planned.minimumListings ||
      parsed.length > planned.maximumListings
    ) {
      throw new Error(
        `${adapter.manifest.id} traversal page ${planned.key} returned ` +
          `${parsed.length} listings; expected ${planned.minimumListings}-` +
          `${planned.maximumListings}.`,
      );
    }

    for (const listing of parsed) {
      if (listing.stub.sourceId !== adapter.manifest.id) {
        throw new Error(
          `${adapter.manifest.id} acquired inventory returned a different source identity.`,
        );
      }
      const listingEligibilityAt =
        normalizedEligibilityAt ?? acquired.page.fetchedAt;
      const ended =
        listing.currentState === "ended" ||
        (
          listing.detail &&
          exactListingEndHasPassed(
            listing.detail.auctionEndsAt,
            listingEligibilityAt,
          )
        );
      if (
        ended &&
        planned.inventoryMember &&
        (traversal.inventoryCardinality ?? "exact") === "exact" &&
        (
          !listing.detail ||
          !exactListingEndHasPassed(
            listing.detail.auctionEndsAt,
            listingEligibilityAt,
          )
        )
      ) {
        throw new Error(
          `${adapter.manifest.id} exact acquired traversal ended listing ` +
            `${listing.stub.sourceListingId} has no durable inline close evidence.`,
        );
      }
      if (
        planned.inventoryMember &&
        (
          (traversal.inventoryCardinality ?? "exact") === "exact" ||
          !ended
        )
      ) {
        inventoryListingIds.add(listing.stub.sourceListingId);
      }
      if (ended) continue;
      const listingId = listing.stub.sourceListingId;
      const role = reviewRoles.get(listingId) ?? {
        eligible: false,
        explicitlyCatalogOnly: false,
      };
      role.eligible ||=
        planned.reviewCandidate && listing.reviewCandidate !== false;
      role.explicitlyCatalogOnly ||= listing.reviewCandidate === false;
      reviewRoles.set(listingId, role);
    }
  }

  adapter.validateInventoryTraversalBundle?.(orderedPages, traversal);

  const inventoryCardinality = traversal.inventoryCardinality ?? "exact";
  if (
    inventoryCardinality === "exact"
      ? inventoryListingIds.size !== traversal.expectedListings
      : inventoryListingIds.size < 1
  ) {
    throw new Error(
      `${adapter.manifest.id} acquired inventory preflight found ` +
        `${inventoryListingIds.size} unique inventory listings; expected ` +
        `${traversal.expectedListings}.`,
    );
  }
  if (traversal.expectedReviewCandidates !== undefined) {
    const reviewCandidateCount = [...inventoryListingIds].filter((listingId) => {
      const role = reviewRoles.get(listingId);
      return role?.eligible === true && !role.explicitlyCatalogOnly;
    }).length;
    if (reviewCandidateCount !== traversal.expectedReviewCandidates) {
      throw new Error(
        `${adapter.manifest.id} acquired inventory preflight found ` +
          `${reviewCandidateCount} review candidates; expected ` +
          `${traversal.expectedReviewCandidates}.`,
      );
    }
  }
}

/**
 * Returns one deterministic completion boundary for a whole acquired callback.
 * Every exact-current source in the callback is evaluated at this same latest
 * fetched timestamp, including sources captured before later bundles.
 */
export function acquiredPagesCompletionAt(
  pages: readonly AcquiredSourcePage[],
): string {
  if (pages.length < 1) {
    throw new Error("Acquired completion requires at least one page.");
  }
  let latest = Number.NEGATIVE_INFINITY;
  for (const acquired of pages) {
    const fetchedAt = Date.parse(acquired.page.fetchedAt);
    if (!Number.isFinite(fetchedAt)) {
      throw new Error("Acquired page completion timestamp is invalid.");
    }
    latest = Math.max(latest, fetchedAt);
  }
  return new Date(latest).toISOString();
}

function normalizedAcquiredCompletionAt(value: string): string {
  const parsed = Date.parse(value);
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 64 ||
    !Number.isFinite(parsed)
  ) {
    throw new Error("Acquired bundle completion timestamp is invalid.");
  }
  return new Date(parsed).toISOString();
}

/**
 * Serves exact companion-acquired HTML to the ordinary shared pipeline while
 * retaining the direct controller only for approved image bytes.
 */
export class AcquiredPageRequestController implements SourceRequestController {
  readonly #manifest: SourceManifest;
  readonly #grant: SourceAccessGrant;
  readonly #pages = new Map<string, AcquiredSourcePage>();
  readonly #direct: ConservativeRequestController;
  readonly #acquiredRequestCount: number;

  constructor(
    manifest: SourceManifest,
    grant: SourceAccessGrant,
    pages: readonly AcquiredSourcePage[],
    options: AcquiredPageRequestControllerOptions = {},
  ) {
    if (manifest.acquisition !== "isolated_browser") {
      throw new Error(
        `${manifest.id} does not permit isolated-browser acquired pages.`,
      );
    }
    this.#manifest = manifest;
    this.#grant = grant;

    let latestStartedAt = Number.NEGATIVE_INFINITY;
    let requestCount = 0;
    for (const acquired of pages) {
      const key = acquiredRequestKey(manifest, acquired.request);
      if (this.#pages.has(key)) {
        throw new Error(`${manifest.id} acquired the same planned page twice.`);
      }
      const pageUrl = validateRequestUrl(manifest, acquired.page.url).toString();
      const requestUrl = validateRequestUrl(manifest, acquired.request.url).toString();
      if (pageUrl !== requestUrl) {
        throw new Error(`${manifest.id} acquired page URL does not match its request.`);
      }
      const requestStartedAt = acquired.requestStartedAt.map((value) =>
        Date.parse(value)
      );
      const startedAt = requestStartedAt[0] ?? Number.NaN;
      const lastStartedAt = requestStartedAt.at(-1) ?? Number.NaN;
      const fetchedAt = Date.parse(acquired.page.fetchedAt);
      const expectedRequestBudgetCost = acquiredRequestBudgetCostForSource(
        manifest.id,
        acquired.request,
      );
      if (
        acquired.requestStartedAt.length < 1 ||
        acquired.requestStartedAt.length > expectedRequestBudgetCost ||
        (
          acquired.request.method === "POST" &&
          acquired.requestStartedAt.length !== 2 &&
          acquired.requestStartedAt.length !== 3
        ) ||
        acquired.startedAt !== acquired.requestStartedAt[0] ||
        requestStartedAt.some((value) => !Number.isFinite(value)) ||
        requestStartedAt.some((value, index) =>
          index > 0 &&
          (acquired.request.method !== "POST" || index === 1) &&
          value - requestStartedAt[index - 1]! <
            manifest.requests.minDelayMs
        ) ||
        !Number.isFinite(startedAt) ||
        !Number.isFinite(lastStartedAt) ||
        !Number.isFinite(fetchedAt) ||
        fetchedAt < lastStartedAt
      ) {
        throw new Error(`${manifest.id} acquired page timestamps are invalid.`);
      }
      if (
        acquired.requestBudgetCost !== expectedRequestBudgetCost ||
        !/^[a-f0-9]{64}$/.test(acquired.bodySha256)
      ) {
        throw new Error(`${manifest.id} acquired page accounting is invalid.`);
      }
      latestStartedAt = Math.max(latestStartedAt, lastStartedAt);
      requestCount += acquired.requestBudgetCost;
      this.#pages.set(key, acquired);
    }
    if (requestCount > manifest.requests.maxRequestsPerRun) {
      throw new Error(
        `${manifest.id} acquired pages use ${requestCount} request units, ` +
          `exceeding the ${manifest.requests.maxRequestsPerRun}-unit budget.`,
      );
    }
    this.#acquiredRequestCount = requestCount;
    this.#direct = new ConservativeRequestController(
      manifest,
      grant,
      Number.isFinite(latestStartedAt)
        ? {
            ...options.direct,
            initialRequestStartedAt: latestStartedAt,
          }
        : options.direct,
    );
  }

  get requestCount(): number {
    return this.#acquiredRequestCount + this.#direct.requestCount;
  }

  hasRequestCapacity(attempts: number): boolean {
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      throw new Error("Request capacity checks require a non-negative integer.");
    }
    return this.requestCount + attempts <=
      this.#manifest.requests.maxRequestsPerRun;
  }

  hasPage(request: SourceRequest): boolean {
    return this.#pages.has(acquiredRequestKey(this.#manifest, request));
  }

  async fetchPage(
    request: SourceRequest,
  ): Promise<SourcePage> {
    assertSourceAccess(this.#manifest, this.#grant);
    const key = acquiredRequestKey(this.#manifest, request);
    const acquired = this.#pages.get(key);
    if (!acquired) {
      throw new Error(
        `${this.#manifest.id} requested a page absent from its acquired bundle.`,
      );
    }
    this.#pages.delete(key);
    return acquired.page;
  }

  async fetchApprovedImage<T>(
    input: string | URL,
    handle: (response: Response) => Promise<T>,
  ): Promise<T> {
    if (!this.hasRequestCapacity(1)) {
      throw new Error(
        `Request budget exhausted for ${this.#manifest.id} (${this.requestCount} requests).`,
      );
    }
    return this.#direct.fetchApprovedImage(input, handle);
  }

  assertComplete(): void {
    if (this.#pages.size > 0) {
      throw new Error(
        `${this.#manifest.id} left ${this.#pages.size} acquired page(s) unused.`,
      );
    }
  }
}

/**
 * Replays a callback-validated metadata prefix and isolated-browser document
 * supplements into an otherwise ordinary direct bootstrap traversal.
 *
 * Cached direct GETs consume exactly one physical start in the already-used
 * first stage. Browser documents retain the conservative acquired-page
 * accounting but do not consume a direct-controller stage. Every absent
 * request is delegated to a staged direct controller whose stage count is
 * reduced by the already-consumed direct bootstrap stages.
 */
export class BootstrapSupplementRequestController
  implements SourceRequestController {
  readonly #manifest: SourceManifest;
  readonly #grant: SourceAccessGrant;
  readonly #pages = new Map<string, AcquiredSourcePage>();
  readonly #allPageKeys = new Set<string>();
  readonly #browserDocumentHosts: ReadonlySet<string>;
  readonly #browserDocumentUrls: ReadonlySet<string> | null;
  readonly #direct: SourceRequestController;
  readonly #acquiredDirectRequestCount: number;
  readonly #remainingDirectRequestCapacity: number;

  constructor(
    manifest: SourceManifest,
    grant: SourceAccessGrant,
    pages: readonly AcquiredSourcePage[],
    options: BootstrapSupplementRequestControllerOptions = {},
  ) {
    const browserHosts = validatedBrowserDocumentHosts(manifest);
    const maxStages = manifest.requests.maxDirectControllerStages;
    if (
      manifest.acquisition === "isolated_browser" ||
      !Number.isSafeInteger(maxStages) ||
      maxStages === undefined ||
      maxStages < 2 ||
      manifest.requests.maxRetries !== 0 ||
      manifest.requests.maxRedirects !== 0
    ) {
      throw new Error(
        `${manifest.id} bootstrap supplements require staged zero-retry, ` +
          "zero-redirect direct acquisition.",
      );
    }
    if (pages.length < 1) {
      throw new Error(
        `${manifest.id} bootstrap supplements require at least one page.`,
      );
    }
    this.#manifest = manifest;
    this.#grant = grant;
    this.#browserDocumentHosts = browserHosts;
    this.#browserDocumentUrls = validatedBrowserDocumentUrls(
      manifest,
      browserHosts,
    );

    let directRequestCount = 0;
    let latestStartedAt = Number.NEGATIVE_INFINITY;
    let priorLastStartedAt = Number.NEGATIVE_INFINITY;
    let priorFetchedAt = Number.NEGATIVE_INFINITY;
    for (const acquired of pages) {
      if (
        acquired.request.method !== undefined ||
        acquired.request.body !== undefined ||
        acquired.request.headers !== undefined ||
        acquired.request.optionalEvidence !== undefined ||
        acquired.request.originPriority !== undefined
      ) {
        throw new Error(
          `${manifest.id} bootstrap supplements must be credential-free GETs.`,
        );
      }
      const key = acquiredRequestKey(manifest, acquired.request);
      if (this.#allPageKeys.has(key)) {
        throw new Error(
          `${manifest.id} acquired the same bootstrap supplement twice.`,
        );
      }
      const pageUrl = validateRequestUrl(manifest, acquired.page.url).toString();
      const requestUrl = validateRequestUrl(
        manifest,
        acquired.request.url,
      ).toString();
      if (pageUrl !== requestUrl) {
        throw new Error(
          `${manifest.id} bootstrap supplement URL does not match its request.`,
        );
      }
      const hostname = new URL(requestUrl).hostname.toLowerCase();
      const browserAcquired = this.#browserDocumentUrls
        ? this.#browserDocumentUrls.has(requestUrl)
        : browserHosts.has(hostname);
      const expectedRequestBudgetCost = browserAcquired ? 2 : 1;
      const requestStartedAt = acquired.requestStartedAt.map((value) =>
        Date.parse(value)
      );
      const startedAt = requestStartedAt[0] ?? Number.NaN;
      const lastStartedAt = requestStartedAt.at(-1) ?? Number.NaN;
      const fetchedAt = Date.parse(acquired.page.fetchedAt);
      if (
        acquired.requestStartedAt.length !== 1 ||
        acquired.startedAt !== acquired.requestStartedAt[0] ||
        requestStartedAt.some((value) => !Number.isFinite(value)) ||
        !Number.isFinite(startedAt) ||
        !Number.isFinite(lastStartedAt) ||
        !Number.isFinite(fetchedAt) ||
        fetchedAt < lastStartedAt ||
        (
          priorLastStartedAt !== Number.NEGATIVE_INFINITY &&
          startedAt - priorLastStartedAt < manifest.requests.minDelayMs
        ) ||
        (
          priorFetchedAt !== Number.NEGATIVE_INFINITY &&
          startedAt < priorFetchedAt
        )
      ) {
        throw new Error(
          `${manifest.id} bootstrap supplement timestamps are invalid.`,
        );
      }
      if (
        acquired.requestBudgetCost !== expectedRequestBudgetCost ||
        !/^[a-f0-9]{64}$/.test(acquired.bodySha256)
      ) {
        throw new Error(
          `${manifest.id} bootstrap supplement accounting is invalid.`,
        );
      }
      if (!browserAcquired) directRequestCount += 1;
      latestStartedAt = Math.max(latestStartedAt, lastStartedAt);
      priorLastStartedAt = lastStartedAt;
      priorFetchedAt = fetchedAt;
      this.#allPageKeys.add(key);
      this.#pages.set(key, acquired);
    }
    const totalDirectRequestCapacity =
      manifest.requests.maxRequestsPerRun * maxStages;
    const remainingDirectRequestCapacity =
      totalDirectRequestCapacity - directRequestCount;
    if (
      directRequestCount > totalDirectRequestCapacity ||
      remainingDirectRequestCapacity < 1
    ) {
      throw new Error(
        `${manifest.id} bootstrap direct pages use ${directRequestCount} ` +
          `starts, leaving no bounded direct traversal capacity.`,
      );
    }
    const remainingStages = Math.ceil(
      remainingDirectRequestCapacity /
        manifest.requests.maxRequestsPerRun,
    );
    if (remainingStages < 2) {
      throw new Error(
        `${manifest.id} bootstrap supplements leave no valid staged direct tail.`,
      );
    }
    const remainingManifest: SourceManifest = {
      ...manifest,
      requests: {
        ...manifest.requests,
        maxDirectControllerStages: remainingStages,
      },
    };
    this.#acquiredDirectRequestCount = directRequestCount;
    this.#remainingDirectRequestCapacity = remainingDirectRequestCapacity;
    this.#direct = new StagedConservativeRequestController(
      remainingManifest,
      grant,
      {
        ...options.direct,
        initialRequestStartedAt: Math.max(
          options.direct?.initialRequestStartedAt ??
            Number.NEGATIVE_INFINITY,
          latestStartedAt,
        ),
      },
    );
  }

  get requestCount(): number {
    return this.#acquiredDirectRequestCount + this.#direct.requestCount;
  }

  hasRequestCapacity(attempts: number): boolean {
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      throw new Error("Request capacity checks require a non-negative integer.");
    }
    return this.#direct.requestCount + attempts <=
        this.#remainingDirectRequestCapacity &&
      this.#direct.hasRequestCapacity(attempts);
  }

  async fetchPage(
    request: SourceRequest,
  ): Promise<SourcePage> {
    assertSourceAccess(this.#manifest, this.#grant);
    const key = acquiredRequestKey(this.#manifest, request);
    const acquired = this.#pages.get(key);
    if (acquired) {
      this.#pages.delete(key);
      return acquired.page;
    }
    if (this.#allPageKeys.has(key)) {
      throw new Error(
        `${this.#manifest.id} requested a consumed bootstrap supplement twice.`,
      );
    }
    const requestUrl = validateRequestUrl(
      this.#manifest,
      request.url,
    );
    const browserDocument = this.#browserDocumentUrls
      ? this.#browserDocumentUrls.has(requestUrl.toString())
      : this.#browserDocumentHosts.has(requestUrl.hostname.toLowerCase());
    if (browserDocument) {
      throw new Error(
        `${this.#manifest.id} requested an uncached browser document.`,
      );
    }
    if (!this.hasRequestCapacity(1)) {
      throw new Error(
        `Request budget exhausted for ${this.#manifest.id} ` +
          `(${this.requestCount} total direct starts).`,
      );
    }
    return this.#direct.fetchPage(request, { maxRetries: 0 });
  }

  fetchApprovedImage<T>(
    input: string | URL,
    handle: (response: Response) => Promise<T>,
  ): Promise<T> {
    return this.#direct.fetchApprovedImage(input, handle);
  }

  assertComplete(): void {
    if (this.#pages.size > 0) {
      throw new Error(
        `${this.#manifest.id} left ${this.#pages.size} bootstrap ` +
          "supplement page(s) unused.",
      );
    }
    this.#direct.assertComplete?.();
  }
}

export function isBootstrapSupplementSource(
  adapter: Pick<SourceAdapter, "manifest" | "planInventoryTraversalBootstrap" |
    "planInventoryTraversalBootstrapFollowup" |
    "planInventoryTraversalBundle">,
): boolean {
  return adapter.manifest.acquisition !== "isolated_browser" &&
    adapter.manifest.requests.allowedBrowserDocumentHosts !== undefined &&
    adapter.manifest.requests.allowedBrowserDocumentHosts.length > 0 &&
    adapter.planInventoryTraversalBootstrap !== undefined &&
    adapter.planInventoryTraversalBootstrapFollowup !== undefined &&
    adapter.planInventoryTraversalBundle !== undefined;
}

export function isBootstrapSupplementBrowserRequest(
  manifest: SourceManifest,
  request: Pick<SourceRequest, "url">,
): boolean {
  const browserHosts = validatedBrowserDocumentHosts(manifest);
  const browserUrls = validatedBrowserDocumentUrls(manifest, browserHosts);
  const requestUrl = validateRequestUrl(manifest, request.url);
  return browserUrls
    ? browserUrls.has(requestUrl.toString())
    : browserHosts.has(requestUrl.hostname.toLowerCase());
}

function validatedBrowserDocumentHosts(
  manifest: SourceManifest,
): ReadonlySet<string> {
  const hosts = manifest.requests.allowedBrowserDocumentHosts;
  if (!hosts || hosts.length < 1) {
    throw new Error(
      `${manifest.id} has no approved bootstrap browser document hosts.`,
    );
  }
  const allowedHosts = new Set(
    manifest.requests.allowedHosts.map((host) => host.toLowerCase()),
  );
  const normalized = new Set<string>();
  for (const host of hosts) {
    const canonical = host.trim().toLowerCase();
    if (
      canonical !== host ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(
        canonical,
      ) ||
      !allowedHosts.has(canonical) ||
      normalized.has(canonical)
    ) {
      throw new Error(
        `${manifest.id} bootstrap browser document hosts are invalid.`,
      );
    }
    normalized.add(canonical);
  }
  return normalized;
}

function validatedBrowserDocumentUrls(
  manifest: SourceManifest,
  browserHosts: ReadonlySet<string>,
): ReadonlySet<string> | null {
  const configured = manifest.requests.allowedBrowserDocumentUrls;
  if (configured === undefined) return null;
  if (configured.length < 1) {
    throw new Error(
      `${manifest.id} bootstrap browser document URLs are empty.`,
    );
  }
  const normalized = new Set<string>();
  for (const candidate of configured) {
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(
        `${manifest.id} bootstrap browser document URLs are invalid.`,
      );
    }
    const canonical = validateRequestUrl(manifest, candidate).toString();
    if (
      candidate !== canonical ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash ||
      !browserHosts.has(parsed.hostname.toLowerCase()) ||
      normalized.has(canonical)
    ) {
      throw new Error(
        `${manifest.id} bootstrap browser document URLs are invalid.`,
      );
    }
    normalized.add(canonical);
  }
  return normalized;
}

export function acquiredRequestKey(
  manifest: SourceManifest,
  request: SourceRequest,
): string {
  const url = validateRequestUrl(manifest, request.url).toString();
  const headers = Object.entries(request.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify({
    kind: request.kind,
    url,
    method: request.method ?? "GET",
    body: request.body ?? null,
    headers,
    optionalEvidence: request.optionalEvidence ?? null,
    originPriority: request.originPriority ?? null,
  });
}
