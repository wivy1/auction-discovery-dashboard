import type {
  NormalizedListingDetail,
  NormalizedListingStub,
} from "../domain/listings";

export type SourceId = string;
export type SourceCoverageMode = "complete_current";

export interface SourceBrowserRequestRule {
  readonly host: string;
  /** Exact pathname plus query; no wildcard or fragment. */
  readonly path: string;
  readonly method: "GET";
  readonly resourceType: "script" | "xhr" | "fetch" | "stylesheet";
}

export type SourceTransport = "html" | "json_api";
export type SourceAcquisition = "direct" | "isolated_browser";

export type SourceImplementationStatus =
  | "ready"
  | "parser_ready_live_disabled"
  | "not_implemented";

export type PermissionBasis =
  | "official_public_api"
  | "recorded_permission"
  | "manual_review_required"
  | "prohibited";

export interface SourceImageRedirectRule {
  readonly host: string;
  readonly pathPrefix: string;
}

interface SourceAccessPolicyBase {
  readonly termsUrl: string | null;
  readonly robotsUrl: string | null;
  readonly documentationUrls: readonly string[];
  readonly reviewedAt: string;
  readonly note: string;
}

export type SourceAccessPolicy = SourceAccessPolicyBase & (
  | {
      readonly permissionBasis: "recorded_permission";
      readonly permissionReference: string;
      readonly permissionRecordedAt: string;
    }
  | {
      readonly permissionBasis: Exclude<PermissionBasis, "recorded_permission">;
      readonly permissionReference?: never;
      readonly permissionRecordedAt?: never;
    }
);

export interface SourceRequestPolicy {
  readonly allowedBrowserRequests?: readonly SourceBrowserRequestRule[];
  /** Exact header names allowed for this integration; values remain local. */
  readonly allowedRequestHeaders?: readonly string[];
  readonly allowedHosts: readonly string[];
  readonly allowedRedirectHosts?: readonly string[];
  /**
   * Exact non-document hosts that an isolated browser may contact only as
   * source-selected subresources. These hosts are not direct request targets.
   */
  readonly allowedBrowserResourceHosts?: readonly string[];
  /**
   * Exact document hosts that a local isolated browser may acquire only as
   * trusted bootstrap supplements for an otherwise direct source. The
   * ordinary direct adapter remains authoritative for the complete traversal.
   */
  readonly allowedBrowserDocumentHosts?: readonly string[];
  /**
   * Optional exact-URL subset of allowedBrowserDocumentHosts. When present,
   * same-host documents outside this set remain direct; this keeps robots and
   * other metadata on the conservative direct path when only selected HTML
   * documents require a disposable browser.
   */
  readonly allowedBrowserDocumentUrls?: readonly string[];
  readonly allowedImageHosts?: readonly string[];
  readonly allowedImageRedirects?: readonly SourceImageRedirectRule[];
  /** Exact Accept value for source-specific image representation negotiation. */
  readonly imageAccept?: string;
  readonly maxRedirects?: number;
  readonly userAgent?: string;
  readonly minDelayMs: number;
  /**
   * Optional request-start floor for approved image targets whose hostname is
   * not also an approved document host. Same-host images retain minDelayMs.
   */
  readonly distinctImageMinDelayMs?: number;
  readonly maxRequestsPerRun: number;
  /**
   * Optional bounded sequence of direct-controller ledgers for one normal
   * inventory run. Each physical controller still enforces
   * `maxRequestsPerRun`; only zero-retry, zero-redirect direct sources may opt
   * in. Values are runtime-validated and capped at four stages.
   */
  readonly maxDirectControllerStages?: number;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /** Optional direct-image ceiling; documents retain maxResponseBytes. */
  readonly maxImageResponseBytes?: number;
  readonly maxResponseBytes: number;
}

export interface SourceManifest {
  readonly id: SourceId;
  readonly displayName: string;
  readonly baseUrl: string;
  /** Discovery is restricted to the source's current, non-ended inventory. */
  readonly inventoryScope: "current";
  readonly transport: SourceTransport;
  /** Omitted manifests use the ordinary direct request controller. */
  readonly acquisition?: SourceAcquisition;
  readonly implementationStatus: SourceImplementationStatus;
  readonly enabledByDefault: false;
  /**
   * Current review candidates remain recoverable until one source-supplied
   * action deadline has been preserved separately from a true lot close.
   */
  readonly requiresActionDeadline?: true;
  readonly access: SourceAccessPolicy;
  readonly requests: SourceRequestPolicy;
}

export type SourceRequestKind = "discovery" | "detail" | "api";

/** Positive, origin-scoped source evidence that may prioritize later work. */
export interface SourceOriginPriority {
  readonly originPostalCode: string;
  readonly radiusMiles: number;
}

export interface SourceRequest {
  readonly kind: SourceRequestKind;
  readonly url: string;
  /**
   * Isolated-browser document requests may submit one exact source-owned
   * form. Ordinary/direct requests remain GET-only.
   */
  readonly method?: "POST";
  /** Exact application/x-www-form-urlencoded body for a POST request. */
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional evidence may fail without withholding authoritative inventory. */
  readonly optionalEvidence?: "origin_priority";
  readonly originPriority?: SourceOriginPriority;
}

export interface SourcePage {
  readonly url: string;
  readonly body: string;
  readonly fetchedAt: string;
  readonly contentType?: string;
}

export interface SourceDiscoveredListing {
  readonly stub: NormalizedListingStub;
  readonly detail?: NormalizedListingDetail;
  readonly originPriority?: SourceOriginPriority;
  /** Source-specific current-state evidence carried before stub persistence. */
  readonly currentState?: "current" | "ended" | "unknown";
  /** False catalogs the observation but excludes it from detail/derived work. */
  readonly reviewCandidate?: boolean;
}

export interface SourceDiscoveryContext {
  readonly categories?: readonly string[];
  readonly apiKey?: string;
  readonly canary?: boolean;
  readonly originPostalCode?: string;
}

export interface SourceInventoryPageRequest {
  /** Stable, non-secret checkpoint identity for one traversal page. */
  readonly key: string;
  readonly request: SourceRequest;
  /**
   * Force a planned request that exactly matches the discovery root to run in
   * traversal order instead of checkpointing the already-fetched root. Use
   * only for a terminal audit that must revalidate mutable root metadata.
   */
  readonly revalidateAfterTraversal?: boolean;
  /** Inclusive raw-card bounds; checked before a page can be checkpointed. */
  readonly minimumListings: number;
  readonly maximumListings: number;
  /** True only when rows from this page define complete current membership. */
  readonly inventoryMember: boolean;
  /**
   * True when rows from this page are eligible for bounded derived work.
   * Both roles may be false only for an audit/recount gate whose validated
   * response contributes no rows but must complete before publication.
   */
  readonly reviewCandidate: boolean;
}

export type SourceInventoryCardinality = "exact" | "observed_union";
export type SourceListingFactCompatibility = "none" | "exact";

export interface SourceInventoryTraversalPlan {
  /** Hash of the observed root/page plan used to resume only the same snapshot. */
  readonly fingerprint: string;
  /**
   * `exact` requires the published union to equal `expectedListings`.
   * `observed_union` retains that root-reported count for audit only.
   */
  readonly inventoryCardinality?: SourceInventoryCardinality;
  /**
   * `exact` permits one identity on multiple pages only when every occurrence
   * has the same normalized listing-stub fact hash.
   */
  readonly listingFactCompatibility?: SourceListingFactCompatibility;
  /**
   * Optional durable checkpoint batch ceiling. It limits pages scheduled in
   * one source run without reducing the traversal's bounded total page plan.
   */
  readonly checkpointPageBatchLimit?: number;
  readonly expectedListings: number;
  /** Optional exact unique review-candidate cardinality for disjoint partitions. */
  readonly expectedReviewCandidates?: number;
  readonly pages: readonly SourceInventoryPageRequest[];
}

export interface SourceAdapter {
  readonly manifest: SourceManifest;
  readonly browser?: { readonly readySelector: string };

  /**
   * The complete inventory parser proves each emitted member is current from
   * a source-supplied future deadline. This narrowly permits a fresh exact
   * inventory observation to supersede an older immutable detail close when
   * the source reuses the same canonical listing identity.
   */
  readonly currentInventorySupersedesPriorDetailEnd?: true;

  planDiscovery(context?: SourceDiscoveryContext): readonly SourceRequest[];

  parseDiscoveryPage(page: SourcePage): readonly NormalizedListingStub[];

  /**
   * Optional paginated-current-inventory plan derived from one bounded root.
   * The pipeline checkpoints these pages durably and publishes only after all
   * page keys complete. The method must return null for non-root pages.
   */
  planInventoryTraversal?(
    page: SourcePage,
  ): SourceInventoryTraversalPlan | null;

  /**
   * Optional ordered metadata-bootstrap stage for direct sources whose
   * inventory roots depend on more than one prerequisite document. The
   * pipeline supplies every initial discovery page in request order exactly
   * once, then fetches the returned roots before asking the adapter for its
   * multi-root traversal plan.
   */
  planInventoryTraversalBootstrap?(
    pages: readonly SourcePage[],
  ): readonly SourceRequest[];

  /**
   * Optional second metadata layer for direct sources whose first bootstrap
   * roots reveal exact downstream collection roots. The pipeline fetches
   * these requests once, appends them to the ordered root bundle, and only
   * then asks the adapter for its traversal plan.
   */
  planInventoryTraversalBootstrapFollowup?(
    pages: readonly SourcePage[],
    bootstrapPages: readonly SourcePage[],
  ): readonly SourceRequest[];

  /**
   * Optional exact multi-root metadata plan for sources where no single root
   * supplies every approved partition's current count.
   */
  planInventoryTraversalBundle?(
    pages: readonly SourcePage[],
    /** Ordered initial metadata pages when roots came from a bootstrap stage. */
    bootstrapPages?: readonly SourcePage[],
  ): SourceInventoryTraversalPlan | null;

  /** Revalidates every planned page against root-derived traversal evidence. */
  validateInventoryTraversalPage?(
    page: SourcePage,
    expectedListings: number,
    plannedPage?: SourceInventoryPageRequest,
  ): void | "replan_required";

  /**
   * Optional cross-page validation after every planned page has individually
   * parsed and validated, but before the inventory cardinality gate accepts
   * the snapshot. Pages are supplied in traversal-plan order.
   */
  validateInventoryTraversalBundle?(
    pages: readonly SourcePage[],
    traversal: SourceInventoryTraversalPlan,
  ): void;

  /**
   * Optional fast path for APIs whose discovery response already contains the
   * immutable detail fields. Implementations must parse the response once and
   * return the matching stub/detail pair.
   */
  parseDiscoveryBatch?(
    page: SourcePage,
    plannedPage?: SourceInventoryPageRequest,
  ): readonly SourceDiscoveredListing[];

  /**
   * Opts a direct inline-detail source into the durable current-inventory
   * preparation lane after atomic catalog publication. Use this only when one
   * bounded discovery traversal can publish more rows than the same run may
   * route or archive.
   */
  readonly drainPublishedInventoryPreparation?: boolean;
  readonly publishedInlineInventoryProvesCompleteImageIdentitySet?: true;

  planDetail(stub: NormalizedListingStub): SourceRequest | null;

  /** Optional identity-bound pages needed to complete one detail snapshot. */
  planAdditionalDetailPages?(
    page: SourcePage,
    stub: NormalizedListingStub,
  ): readonly SourceRequest[];

  parseDetailPage(
    page: SourcePage,
    stub?: NormalizedListingStub,
  ): NormalizedListingDetail;

  /** Optional parser for a primary detail page plus its planned companions. */
  parseDetailPages?(
    pages: readonly SourcePage[],
    stub?: NormalizedListingStub,
  ): NormalizedListingDetail;

  /**
   * Optional exact ended-page proof available before a complete detail can be
   * parsed. This is reserved for identity-bound unavailable/withdrawn shells.
   */
  isDetailPageProvablyEnded?(
    page: SourcePage,
    stub: NormalizedListingStub,
  ): boolean;

  /**
   * Optional source-specific proof that a fetched detail page ended during the
   * current-inventory run. The pipeline also enforces exact close instants.
   */
  isDetailProvablyEnded?(
    page: SourcePage,
    detail: NormalizedListingDetail,
  ): boolean;
}

export class SourceAdapterError extends Error {
  readonly sourceId: SourceId;

  constructor(sourceId: SourceId, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SourceAdapterError";
    this.sourceId = sourceId;
  }
}

/**
 * One listing exposes mutually incompatible visible and structured pickup
 * facts. The catalog identity remains source truth, but derived route/review
 * work cannot choose between those facts without inventing a location.
 */
export class SourceListingLocationConflictError extends SourceAdapterError {
  constructor(sourceId: SourceId, message: string, options?: ErrorOptions) {
    super(sourceId, message, options);
    this.name = "SourceListingLocationConflictError";
  }
}

/**
 * A successful discovery response that is neither a recognized inventory page
 * nor a recognized empty page may be a transient source shell. The pipeline
 * may reacquire the exact traversal page once, but it must never accept this
 * response as source truth.
 */
export class SourceRetryableDiscoveryPageError extends SourceAdapterError {
  constructor(sourceId: SourceId, message: string, options?: ErrorOptions) {
    super(sourceId, message, options);
    this.name = "SourceRetryableDiscoveryPageError";
  }
}

/**
 * An exact detail response retained its requested listing identity but omitted
 * one fact required to normalize the record. The durable detail queue may
 * reacquire that listing later; contradictory or unsupported facts must remain
 * ordinary fatal adapter errors.
 */
export class SourceRetryableIncompleteDetailError extends SourceAdapterError {
  constructor(sourceId: SourceId, message: string, options?: ErrorOptions) {
    super(sourceId, message, options);
    this.name = "SourceRetryableIncompleteDetailError";
  }
}

export class SourceNotImplementedError extends SourceAdapterError {
  constructor(sourceId: SourceId, operation: string) {
    super(
      sourceId,
      `${sourceId} cannot ${operation}: its adapter is intentionally disabled and not implemented.`,
    );
    this.name = "SourceNotImplementedError";
  }
}

/** A login/challenge/WAF response must stop the whole bounded source run. */
export class SourceAccessChallengeError extends SourceAdapterError {
  constructor(
    sourceId: SourceId,
    message: string,
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(sourceId, message);
    this.name = "SourceAccessChallengeError";
  }
}
