
export type Vote = "interested" | "not_interested" | null;

export type DashboardListingScope =
  | "unvoted"
  | "all"
  | "voted"
  | "interested"
  | "not_interested";









export type DriveBucket = "under_2h" | "under_4h" | "under_8h";

export type LotType =
  | "single_item"
  | "multi_item_lot"
  | "assorted_lot"
  | "unknown";

export type LotFeedbackDecision = "lot" | "not_lot" | "automatic";

export interface ListingLotOverride {
  feedbackId: string;
  decision: Exclude<LotFeedbackDecision, "automatic">;
  createdAt: string;
  source: "operator_dashboard";
}

export type SourceName = string;

export interface ListingAttributes {
  assetClasses: string[];
  industryDomain:
    | "medical"
    | "laboratory"
    | "industrial"
    | "electronics"
    | "av"
    | "tools"
    | "other"
    | "unknown";
  manufacturer: string | null;
  manufacturers: string[];
  modelNumbers: string[];
  lotType: LotType;
  includedItems: string[];
  missingItems: string[];
  condition: "new" | "used" | "untested" | "parts_only" | "damaged" | "unknown";
  testedStatus:
    | "tested_working"
    | "powers_on"
    | "untested"
    | "not_working"
    | "unknown";
  highValueSignals: string[];
  negativeSignals: string[];
  safetyFlags: string[];
}

export interface ListingImageRecord {
  position: number;
  isPrimary: boolean;
  sourceUrl: string;
  localUrl: string | null;
  displayUrl: string;
  downloadStatus: "deferred" | "pending" | "downloaded" | "failed";
  downloadError: string | null;
}

export interface ListingDetailPayload {
  listingId: string;
  cleanDescription: string;
  rawDescription: string;
  galleryImageUrls: string[];
  images: ListingImageRecord[];
}

export interface ListingRatingModelProvenance {
  activationEventIdentity: string;
  selectedFamily: string;
  selectedConfigurationId: string;
  candidateArtifactHash: string;
  evaluationResultIdentity: string;
  scoringInputHash: string;
  explanationHash: string;
}

export interface ListingRecommendation {
  profileVersionId: string;
  score: number;
  explanation: string;
  exploration: boolean;
  ratingModel?: ListingRatingModelProvenance;
}

export interface Listing {
  id: string;
  source: SourceName;
  /** Exact current alias memberships retained for provenance; `source` is the review source. */
  sourceFilters: SourceName[];
  /** Exact current outbound canonicals for the primary and verified aliases. */
  sourceLinks: Array<{
    source: SourceName;
    sourceListingId: string;
    url: string;
  }>;
  sourceListingId: string;
  sourceUrl: string;
  /** Verbatim source-owned category text; absent on older cached payloads. */
  sourceTaxonomy?: string[];
  title: string;
  aiSummary: string;
  cleanDescription: string;
  rawDescription: string;
  pickupLocation: {
    city: string;
    state: string;
    postalCode: string;
  };
  driveMinutes: number | null;
  driveBucket: DriveBucket | null;
  distanceWaived: boolean;
  /** Raw great-circle distance from the active origin under the local estimator. */
  directDistanceMiles?: number | null;
  proximityEvidence?: string | null;
  proximityEstimator?: string | null;
  priceAtScrape: string;
  closesAt: string;
  actionDeadline: {
    at: string;
    basis: "live_auction_start";
    sourceText: string;
    observedAt: string;
  } | null;
  
  
  firstSeenAt: string;
  isNewSinceLastRun: boolean;
  recommendation: ListingRecommendation | null;
  vote: Vote;
  /** Exact server decision; absent only on an older cached payload. */
  voteReady?: boolean;
  lotOverride: ListingLotOverride | null;
  primaryImageUrl: string;
  galleryImageUrls: string[];
  images: ListingImageRecord[];
  attributes: ListingAttributes;
  aiMeta: {
    provider: string;
    model: string;
    promptVersion: string;
    generatedAt: string;
  };
}

export type BulkNotInterestedOutcomeStatus =
  | "changed"
  | "unchanged_not_interested"
  | "skipped_existing_vote"
  | "skipped_not_actionable"
  | "skipped_not_ready";

export interface BulkNotInterestedOutcome {
  listingId: string;
  canonicalListingId: string | null;
  status: BulkNotInterestedOutcomeStatus;
  vote: Vote;
}

export interface BulkNotInterestedResponse {
  requestedCount: number;
  changedCanonicalListingIds: string[];
  outcomes: BulkNotInterestedOutcome[];
}

export function listingMatchesSourceFilter(
  listing: { source: SourceName; sourceFilters?: readonly SourceName[] },
  source: "all" | SourceName,
): boolean {
  if (source === "all") return true;
  const releasedSources = listing.sourceFilters ?? [listing.source];
  if (listing.source === source) return releasedSources.includes(source);
  return releasedSources.includes(source);
}

export function dashboardSourceFilterOptions(
  listings: readonly {
    source: SourceName;
    sourceFilters?: readonly SourceName[];
  }[],
): SourceName[] {
  const options = new Set<SourceName>();
  for (const listing of listings) {
    const releasedSources = listing.sourceFilters ?? [listing.source];
    if (releasedSources.includes(listing.source)) options.add(listing.source);
    for (const source of releasedSources) options.add(source);
  }
  return [...options];
}

export function listingIsPublisherHistoryOnly(
  listing: { source: SourceName; sourceFilters: readonly SourceName[] },
): boolean {
  return !listing.sourceFilters.includes(listing.source) &&
    listing.sourceFilters.length > 0;
}

/** Freezes exactly the actionable unvoted cards rendered at click time. */
export function visibleBulkNotInterestedListingIds(
  visibleListings: readonly Pick<
    Listing,
    "id" | "source" | "sourceFilters" | "vote" | "recommendation" | "voteReady"
  >[],
): string[] {
  const listingIds = new Set<string>();
  for (const listing of visibleListings) {
    if (
      listing.vote !== null ||
      listing.voteReady === false ||
      listingIsPublisherHistoryOnly(listing)
    ) continue;
    listingIds.add(listing.id);
  }
  return [...listingIds];
}

export function listingSourceLinkItems(
  listing: Pick<Listing, "source" | "sourceListingId" | "sourceUrl" | "sourceLinks">,
): Array<{ key: string; href: string; label: string }> {
  // Verified aliases remain available for deduplication and provenance, but
  // review filtering and this action both follow the operational primary shown
  // by the source badge. `sourceUrl` is that primary's canonical source truth.
  return [{
    key: `${listing.source}:${listing.sourceUrl}`,
    href: listing.sourceUrl,
    label: `View ${listing.source} listing`,
  }];
}

export interface ProfileConcept {
  name: string;
  confidence: number;
  support: number;
  note: string;
}

export interface InterestProfile {
  versionId: string | null;
  version: number;
  generatedAt: string;
  positiveVotes: number;
  negativeVotes: number;
  confidence: number;
  positiveConcepts: ProfileConcept[];
  negativeConcepts: ProfileConcept[];
  signalCorrections: ProfileSignalCorrection[];
  representativeListingIds: string[];
  summary: string;
}

export interface ProfileSignalCorrection {
  feedbackId: string;
  concept: string;
  normalizedConcept: string;
  polarity: "positive" | "negative";
  removedAt: string;
  sourceProfileVersionId: string;
}

export type SourceState =
  | "active"
  | "ready"
  | "review"
  | "planned"
  | "running"
  | "failed"
  | "degraded";

export interface SourceStatus {
  id: string;
  name: SourceName;
  state: SourceState;
  enabled: boolean;
  canEnable: boolean;
  implementationStatus: "ready" | "parser_ready_live_disabled" | "not_implemented";
  lastRun: string | null;
  durationSeconds: number | null;
  discovered: number;
  coverage: {
    catalog: number;
    proximityScope: number;
    distanceComplete: number;
    routeErrors: number;
    unknownLocations?: number;
    review: number;
    imageBearing: number;
    localPrimaryImages: number;
    imageFailures: number;
    enrichmentReady: number;
    voted: number;
  };
  detail: string;
  errorMessage: string | null;
}

export type PipelineStageState = "passed" | "failed" | "pending" | "not_run";

export interface PipelineStageStatus {
  id: "discovery" | "routing" | "images" | "close_times" | "bid_prices" | "enrichment";
  label: string;
  state: PipelineStageState;
  detail: string;
}

export interface RunStatus {
  state: "idle" | "running" | "completed" | "degraded";
  latestDiscoveryStatus?: "idle" | "running" | "completed" | "partial" | "failed";
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  durationSeconds: number | null;
  lastSuccessfulCompletedAt: string | null;
  nextScheduledAt: string | null;
  refreshRequired: boolean;
  discoveredListings: number;
  newListings: number;
  currentNewListings: number;
  currentUnvotedListings: number;
  acceptedListings: number;
  seenListings: number;
  excludedByDistance: number;
  errorMessage: string | null;
  stages: PipelineStageStatus[];
}

export interface OllamaHealth {
  reachable: boolean;
  textModelAvailable: boolean;
  embeddingModelAvailable: boolean;
  latencyMs: number | null;
  checkedAt: string;
  message: string | null;
}

export const SCHEDULE_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export type ScheduleWeekday = (typeof SCHEDULE_WEEKDAYS)[number];

export const DEFAULT_SCHEDULE_WEEKDAYS: readonly ScheduleWeekday[] = [
  "Tuesday",
  "Saturday",
];

export const DEFAULT_SCHEDULE_LOCAL_TIME = "02:00";

export interface LocalScheduleStatus {
  outcome: "read" | "saved" | "removed" | "failed";
  available: boolean;
  configured: boolean;
  enabled: boolean;
  scheduleKind: "weekly" | "legacy_daily" | null;
  weekdays: ScheduleWeekday[] | null;
  localTime: string | null;
  state: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastResult: number | null;
  error: string | null;
}

export interface LocalNightlyRunStatus {
  available: boolean;
  active: boolean;
  state: string;
  workflowState: LocalNightlyWorkflowState | null;
  id: string | null;
  reused: boolean;
  runnerPid: number | null;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  lastError: string | null;
  logPath: string | null;
  stage: string | null;
  failedAtStage: string | null;
  completedStages: number | null;
  totalStages: number | null;
  progressCompleted: number | null;
  progressTotal: number | null;
  progressPercent: number | null;
  progressPhase: LocalNightlyProgressPhase | null;
  proximityProgress: LocalNightlyProximityProgress;
  primaryImageProgress: LocalNightlyPrimaryImageProgress;
  primaryImageSession: LocalNightlyPrimaryImageSession | null;
  enrichmentProgress: LocalNightlyEnrichmentProgress | null;
  coreProgress: LocalNightlyScopeProgress;
  maintenanceProgress: LocalNightlyScopeProgress;
  etaSeconds: number | null;
  attemptCount: number | null;
  message: string | null;
  workflowStartedAt: string | null;
  workflowUpdatedAt: string | null;
  workflowEndedAt: string | null;
  workflowError: string | null;
  invocationSourcesAttempted: number | null;
  invocationSourcesCompleted: number | null;
  campaignId: string | null;
  campaignCycle: number | null;
  campaignSourcesCompleted: number | null;
  campaignSourcesTotal: number | null;
  terminalSourceCount: number | null;
  currentSourceId: string | null;
  sourceOutcomes: readonly LocalNightlySourceOutcome[];
  sourceOutcomeCounts: LocalNightlySourceOutcomeCounts;
}

export interface LocalNightlyProximityProgress {
  queued: number | null;
  claimed: number | null;
  completed: number | null;
  stale: number | null;
  remaining: number | null;
}

export interface LocalNightlyPrimaryImageProgress {
  ready: number | null;
  deferred: number | null;
  claimed: number | null;
  remaining: number | null;
}

export interface LocalNightlyScopeProgress {
  ready: number | null;
  deferred: number | null;
  claimed: number | null;
  remaining: number | null;
}

export interface LocalNightlyPrimaryImageSession {
  sourceId: string;
  attempted: number;
  archived: number;
  failed: number;
  remainingWork: boolean;
  stopReason: string | null;
}

export interface LocalNightlyEnrichmentProgress {
  scope: "enrichment_text+enrichment_embedding";
  queued: number | null;
  claimed: number | null;
  completed: number | null;
  stale: number | null;
  remaining: number | null;
}



export type LocalNightlyProgressPhase =
  | "snapshot"
  | "batch_started"
  | "batch_heartbeat"
  | "batch_completed"
  | "terminal";

export type LocalNightlyWorkflowState =
  | "running"
  | "completed"
  | "failed"
  | "checkpoint_paused"
  | "core_complete_maintenance_deferred";

export interface LocalNightlySourceOutcome {
  sourceId: string;
  outcome:
    | "refreshed"
    | "skipped_recent"
    | "preserved"
    | "paused"
    | "stopped"
    | "blocked";
  dependencySatisfied: boolean;
  reasonCode: string;
  priorHead: { inventoryRunId: string; listingCount: number } | null;
  resultingHead: { inventoryRunId: string; listingCount: number } | null;
  nextEligibleAt: string | null;
  proofIdentity: string | null;
  receiptIdentity: string | null;
}

export type LocalNightlySourceOutcomeCounts = Readonly<Record<
  LocalNightlySourceOutcome["outcome"],
  number
>>;

export interface NewerNightlyWorkflowFailure {
  endedAt: string;
  detail: string;
}

export interface NewerNightlyWorkflowCheckpointPause {
  endedAt: string;
  status: LocalNightlyRunStatus;
}

export interface NewerNightlyWorkflowMaintenanceDeferred {
  endedAt: string;
  status: LocalNightlyRunStatus;
}

export interface DashboardPayload {
  originPostalCode: string;
  listingScope: DashboardListingScope;
  hasReviewedListings: boolean;
  listings: Listing[];
  profile: InterestProfile;
  sources: SourceStatus[];
  run: RunStatus;
}

export interface DiscoveryRunSummary {
  runId: string;
  mode: "normal" | "canary" | "continuation";
  sourceId: string | null;
  originPostalCode: string;
  status: "completed" | "partial" | "failed";
  discovered: number;
  newListings: number;
  accepted: number;
  excluded: number;
  sourcesAttempted: number;
  sourceErrors: Array<{ sourceId: string; message: string }>;
  profileVotesUsed: number;
  imagesArchived: number;
  imageAttempts: number;
  imageFailures: number;
  zipPrefilterExcluded: number;
  uniqueRouteAssessments: number;
  sourceWorkSelected: number;
  imageCache?: {
    state: "completed" | "partial" | "busy" | "unavailable";
    attempted: number;
    archived: number;
    failedAttempts: number;
    repairAttempted: number;
    remainingPending: boolean;
    remainingFailed: boolean;
    stopReason: string | null;
    errorCode: string | null;
    
    
  } | null;
}

export const emptyDashboard: DashboardPayload = {
  originPostalCode: "",
  listingScope: "unvoted",
  hasReviewedListings: false,
  listings: [],
  profile: {
    versionId: null,
    version: 0,
    generatedAt: new Date(0).toISOString(),
    positiveVotes: 0,
    negativeVotes: 0,
    confidence: 0,
    positiveConcepts: [],
    negativeConcepts: [],
    signalCorrections: [],
    representativeListingIds: [],
    summary: "No interest profile has been generated yet.",
  },
  sources: [],
  run: {
    state: "idle",
    latestDiscoveryStatus: "idle",
    lastStartedAt: null,
    lastCompletedAt: null,
    durationSeconds: null,
    lastSuccessfulCompletedAt: null,
    nextScheduledAt: null,
    refreshRequired: true,
    discoveredListings: 0,
    newListings: 0,
    currentNewListings: 0,
    currentUnvotedListings: 0,
    acceptedListings: 0,
    seenListings: 0,
    excludedByDistance: 0,
    errorMessage: null,
    stages: [
      { id: "discovery", label: "Source discovery", state: "not_run", detail: "No run yet" },
      { id: "routing", label: "Approximate proximity", state: "not_run", detail: "No run yet" },
      { id: "images", label: "Primary images", state: "not_run", detail: "No run yet" },
      { id: "enrichment", label: "Text enrichment", state: "not_run", detail: "No enrichment run yet" },
    ],
  },
};

export type DataMode = "loading" | "api" | "error";

const DEFAULT_REQUEST_TIMEOUT_MS = 3_500;
const DASHBOARD_REQUEST_TIMEOUT_MS = 60_000;
const VOTE_REQUEST_TIMEOUT_MS = 60_000;
const BULK_VOTE_REQUEST_TIMEOUT_MS = 2 * 60_000;
const RUN_REQUEST_TIMEOUT_MS = 30 * 60 * 1_000;

interface ReadJsonOptions {
  timeoutMs?: number;
  acceptErrorResponse?: boolean;
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const DASHBOARD_REFRESH_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;

export interface DashboardRefreshRetryDecision {
  readonly failureCount: number;
  readonly retry: boolean;
  readonly delayMs: number | null;
  readonly exhausted: boolean;
}

export function dashboardRefreshRetryDecision(
  priorFailureCount: number,
  error: unknown,
): DashboardRefreshRetryDecision {
  const failureCount = Number.isSafeInteger(priorFailureCount) && priorFailureCount >= 0
    ? priorFailureCount + 1
    : 1;
  const status = error instanceof ApiRequestError ? error.status : null;
  const transient = status === null || status === 408 || status === 425 ||
    status === 429 || status >= 500;
  const delayMs = transient
    ? DASHBOARD_REFRESH_RETRY_DELAYS_MS[failureCount - 1] ?? null
    : null;
  return {
    failureCount,
    retry: delayMs !== null,
    delayMs,
    exhausted: delayMs === null,
  };
}

const RATING_MODEL_PROVENANCE_KEYS = [
  "activationEventIdentity",
  "selectedFamily",
  "selectedConfigurationId",
  "candidateArtifactHash",
  "evaluationResultIdentity",
  "scoringInputHash",
  "explanationHash",
] as const;

const SHA256_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function exactBoundedText(value: unknown): value is string {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 200 &&
    value.trim() === value;
}

export function parseListingRatingModelProvenance(
  value: unknown,
): ListingRatingModelProvenance | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== RATING_MODEL_PROVENANCE_KEYS.length ||
    RATING_MODEL_PROVENANCE_KEYS.some((key) =>
      !Object.prototype.hasOwnProperty.call(record, key)
    ) ||
    !exactBoundedText(record.selectedFamily) ||
    !exactBoundedText(record.selectedConfigurationId) ||
    [
      record.activationEventIdentity,
      record.candidateArtifactHash,
      record.evaluationResultIdentity,
      record.scoringInputHash,
      record.explanationHash,
    ].some((identity) =>
      typeof identity !== "string" || !SHA256_IDENTITY_PATTERN.test(identity)
    )
  ) {
    return null;
  }
  return record as unknown as ListingRatingModelProvenance;
}

function sanitizeListingRecommendation(
  recommendation: ListingRecommendation | null,
): ListingRecommendation | null {
  if (!recommendation) return recommendation;
  const { ratingModel: untrustedRatingModel, ...baseRecommendation } = recommendation;
  const ratingModel = parseListingRatingModelProvenance(untrustedRatingModel);
  return ratingModel ? { ...baseRecommendation, ratingModel } : baseRecommendation;
}

const readJson = async <T>(
  url: string,
  init?: RequestInit,
  options: ReadJsonOptions = {},
): Promise<T> => {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init?.headers,
      },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as
      | (T & { error?: string; code?: string })
      | null;
    if (!response.ok && !options.acceptErrorResponse) {
      throw new ApiRequestError(
        body?.error || `Request failed with ${response.status}`,
        response.status,
        body?.code ?? null,
      );
    }
    if (body === null) {
      throw new ApiRequestError("The local API returned an invalid response", response.status);
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiRequestError(
        `The local API did not respond within ${Math.round(timeoutMs / 1_000)} seconds`,
        null,
        "request_timeout",
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
};

const LOCAL_SCHEDULE_URL = "http://127.0.0.1:32110/v1/schedule";
const LOCAL_NIGHTLY_RUN_URL = "http://127.0.0.1:32110/v1/nightly-run";
const LOCAL_COMPANION_HEALTH_URL = "http://127.0.0.1:32110/v1/health";
const LOCAL_RUNTIME_REVISION_URL = "/api/internal/runtime-revision";
const RUNTIME_REVISION_SCHEMA_VERSION = "auction-discovery-runtime-revision-v1";
const RUNTIME_REVISION_HEADER = "X-Auction-Discovery-Runtime-Revision";
const RUNTIME_REVISION_MISMATCH_MESSAGE =
  "Loaded local runtime does not match the current checkout; discovery was not started. Restart the supervised local stack.";

const NIGHTLY_SOURCE_OUTCOME_NAMES = [
  "refreshed", "skipped_recent", "preserved", "paused", "stopped", "blocked",
] as const;
const NIGHTLY_PROGRESS_PHASES = [
  "snapshot", "batch_started", "batch_heartbeat", "batch_completed", "terminal",
] as const;
const NIGHTLY_WORKFLOW_STATES = [
  "running", "completed", "failed", "checkpoint_paused",
  "core_complete_maintenance_deferred",
] as const;

function nullableText(value: unknown, maximumLength = 500): string | null {
  return typeof value === "string" && value.length <= maximumLength
    ? value
    : value === null ? null : null;
}

function isNullableText(value: unknown, maximumLength = 500): boolean {
  return value === null || (typeof value === "string" && value.length <= maximumLength);
}

function isNullableSafeInteger(value: unknown): boolean {
  return value === null || Number.isSafeInteger(value);
}

function isNullableProgressPercent(value: unknown): boolean {
  return value === null || (
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
  );
}

function isNullableNightlyProgressPhase(value: unknown): boolean {
  return value === null || NIGHTLY_PROGRESS_PHASES.includes(
    value as LocalNightlyProgressPhase,
  );
}

function isNullableNightlyWorkflowState(value: unknown): boolean {
  return value === null || NIGHTLY_WORKFLOW_STATES.includes(
    value as LocalNightlyWorkflowState,
  );
}

function parseNightlyPublicationHead(
  value: unknown,
): LocalNightlySourceOutcome["priorHead"] | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    !exactObjectKeys(record, ["inventoryRunId", "listingCount"]) ||
    !safeNightlyIdentity(record.inventoryRunId) ||
    !Number.isSafeInteger(record.listingCount) ||
    Number(record.listingCount) < 0
  ) return undefined;
  return {
    inventoryRunId: record.inventoryRunId,
    listingCount: Number(record.listingCount),
  };
}

function safeNightlyIdentity(value: unknown, maximumLength = 1_024): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximumLength &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function parseNightlySourceOutcomes(value: unknown): readonly LocalNightlySourceOutcome[] | null {
  if (!Array.isArray(value)) return null;
  const outcomes: LocalNightlySourceOutcome[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return null;
    }
    const record = candidate as Record<string, unknown>;
    if (
      !exactObjectKeys(record, [
        "sourceId", "outcome", "dependencySatisfied", "reasonCode", "priorHead",
        "resultingHead", "nextEligibleAt", "proofIdentity", "receiptIdentity",
      ]) ||
      !safeNightlyIdentity(record.sourceId, 128) || outcomes.some(outcome => outcome.sourceId === record.sourceId) ||
      !NIGHTLY_SOURCE_OUTCOME_NAMES.includes(
        record.outcome as LocalNightlySourceOutcome["outcome"],
      ) ||
      typeof record.dependencySatisfied !== "boolean" ||
      !safeNightlyIdentity(record.reasonCode, 128)
    ) return null;
    const priorHead = parseNightlyPublicationHead(record.priorHead);
    const resultingHead = parseNightlyPublicationHead(record.resultingHead);
    if (priorHead === undefined || resultingHead === undefined) return null;
    const paused = record.outcome === "paused";
    if (
      (record.nextEligibleAt !== null) !== paused ||
      (paused && (
        typeof record.nextEligibleAt !== "string" ||
        !Number.isFinite(Date.parse(record.nextEligibleAt))
      ))
    ) return null;
    const refreshed = record.outcome === "refreshed";
    const skippedRecent = record.outcome === "skipped_recent";
    const verified = refreshed || skippedRecent;
    if (
      record.dependencySatisfied !== verified ||
      (resultingHead !== null) !== verified ||
      (verified ? !safeNightlyIdentity(record.proofIdentity) : record.proofIdentity !== null) ||
      (verified ? !safeNightlyIdentity(record.receiptIdentity) : record.receiptIdentity !== null) ||
      (skippedRecent && (
        record.reasonCode !== "recent_verified_publication" || priorHead === null ||
        resultingHead === null ||
        priorHead.inventoryRunId !== resultingHead.inventoryRunId ||
        priorHead.listingCount !== resultingHead.listingCount
      ))
    ) return null;
    outcomes.push({
      sourceId: record.sourceId as string,
      outcome: record.outcome as LocalNightlySourceOutcome["outcome"],
      dependencySatisfied: record.dependencySatisfied,
      reasonCode: record.reasonCode,
      priorHead,
      resultingHead,
      nextEligibleAt: record.nextEligibleAt as string | null,
      proofIdentity: record.proofIdentity as string | null,
      receiptIdentity: record.receiptIdentity as string | null,
    });
  }
  return outcomes;
}

function countNightlySourceOutcomes(
  outcomes: readonly LocalNightlySourceOutcome[],
): LocalNightlySourceOutcomeCounts {
  const counts: Record<LocalNightlySourceOutcome["outcome"], number> = {
    refreshed: 0,
    skipped_recent: 0,
    preserved: 0,
    paused: 0,
    stopped: 0,
    blocked: 0,
  };
  for (const outcome of outcomes) counts[outcome.outcome] += 1;
  return counts;
}

function isScheduleOutcome(value: unknown): value is LocalScheduleStatus["outcome"] {
  return value === "read" || value === "saved" || value === "removed" || value === "failed";
}

const LOCAL_SCHEDULE_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

function normalizeScheduleWeekdays(value: unknown): ScheduleWeekday[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  const indexes = value.map((weekday) =>
    typeof weekday === "string"
      ? SCHEDULE_WEEKDAYS.indexOf(weekday as ScheduleWeekday)
      : -1
  );
  if (indexes.some((index) => index < 0) || new Set(indexes).size !== indexes.length) {
    return null;
  }
  return indexes
    .sort((left, right) => left - right)
    .map((index) => SCHEDULE_WEEKDAYS[index]!);
}

export function parseLocalScheduleStatus(value: unknown): LocalScheduleStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !isScheduleOutcome(record.outcome) ||
    typeof record.available !== "boolean" ||
    typeof record.configured !== "boolean" ||
    typeof record.enabled !== "boolean" ||
    typeof record.state !== "string" ||
    record.state.length > 100 ||
    (record.nextRunAt !== null && typeof record.nextRunAt !== "string") ||
    (record.lastRunAt !== null && typeof record.lastRunAt !== "string") ||
    (record.lastResult !== null && !Number.isSafeInteger(record.lastResult)) ||
    (record.error !== undefined && record.error !== null && typeof record.error !== "string")
  ) {
    return null;
  }

  let scheduleKind: LocalScheduleStatus["scheduleKind"];
  let weekdays: ScheduleWeekday[] | null;
  let localTime: string | null;
  const hasScheduleKind = Object.hasOwn(record, "scheduleKind");
  const hasWeekdays = Object.hasOwn(record, "weekdays");
  const hasLocalTime = Object.hasOwn(record, "localTime");
  const hasDailyAt = Object.hasOwn(record, "dailyAt");
  if (record.configured) {
    if (
      record.scheduleKind === "weekly" &&
      !hasDailyAt &&
      typeof record.localTime === "string" &&
      LOCAL_SCHEDULE_TIME_PATTERN.test(record.localTime)
    ) {
      weekdays = normalizeScheduleWeekdays(record.weekdays);
      if (weekdays === null) return null;
      scheduleKind = "weekly";
      localTime = record.localTime;
    } else if (
      record.scheduleKind === "legacy_daily" &&
      record.weekdays === null &&
      !hasDailyAt &&
      typeof record.localTime === "string" &&
      LOCAL_SCHEDULE_TIME_PATTERN.test(record.localTime)
    ) {
      scheduleKind = "legacy_daily";
      weekdays = null;
      localTime = record.localTime;
    } else if (
      !hasScheduleKind &&
      !hasWeekdays &&
      !hasLocalTime &&
      hasDailyAt &&
      typeof record.dailyAt === "string" &&
      LOCAL_SCHEDULE_TIME_PATTERN.test(record.dailyAt)
    ) {
      scheduleKind = "legacy_daily";
      weekdays = null;
      localTime = record.dailyAt;
    } else {
      return null;
    }
  } else if (
    !record.enabled &&
    record.scheduleKind === null &&
    record.weekdays === null &&
    record.localTime === null &&
    !hasDailyAt
  ) {
    scheduleKind = null;
    weekdays = null;
    localTime = null;
  } else if (
    !record.enabled &&
    !hasScheduleKind &&
    !hasWeekdays &&
    !hasLocalTime &&
    hasDailyAt &&
    record.dailyAt === null
  ) {
    scheduleKind = null;
    weekdays = null;
    localTime = null;
  } else {
    return null;
  }

  return {
    outcome: record.outcome,
    available: record.available,
    configured: record.configured,
    enabled: record.enabled,
    scheduleKind,
    weekdays,
    localTime,
    state: record.state,
    nextRunAt: nullableText(record.nextRunAt),
    lastRunAt: nullableText(record.lastRunAt),
    lastResult: record.lastResult as number | null,
    error: nullableText(record.error),
  };
}

async function requestLocalSchedule(
  method: "GET" | "PUT" | "DELETE",
  recurrence?: { weekdays: ScheduleWeekday[]; localTime: string },
): Promise<LocalScheduleStatus> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(LOCAL_SCHEDULE_URL, {
      method,
      redirect: "error",
      headers: method === "PUT"
        ? { accept: "application/json", "content-type": "application/json" }
        : { accept: "application/json" },
      body: method === "PUT" ? JSON.stringify(recurrence) : undefined,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const error = payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Schedule request failed with ${response.status}`;
      throw new ApiRequestError(error, response.status);
    }
    const schedule = parseLocalScheduleStatus(payload);
    if (!schedule) throw new ApiRequestError("The local schedule service returned an invalid response");
    return schedule;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiRequestError("The local schedule service did not respond within 5 seconds");
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export function loadLocalSchedule(): Promise<LocalScheduleStatus> {
  return requestLocalSchedule("GET");
}

export function saveLocalSchedule(
  weekdays: readonly ScheduleWeekday[],
  localTime: string,
): Promise<LocalScheduleStatus> {
  const normalizedWeekdays = normalizeScheduleWeekdays(weekdays);
  if (normalizedWeekdays === null) {
    return Promise.reject(new ApiRequestError("Choose one or two valid schedule weekdays"));
  }
  if (!LOCAL_SCHEDULE_TIME_PATTERN.test(localTime)) {
    return Promise.reject(new ApiRequestError("Choose a valid local schedule time"));
  }
  return requestLocalSchedule("PUT", { weekdays: normalizedWeekdays, localTime });
}

export function removeLocalSchedule(): Promise<LocalScheduleStatus> {
  return requestLocalSchedule("DELETE");
}

export function parseLocalNightlyRunStatus(value: unknown): LocalNightlyRunStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const normalizedWorkflowState = record.workflowState ?? null;
  const normalizedProgressPhase = record.progressPhase ?? null;
  const normalizedAttemptCount = record.attemptCount ?? null;
  const normalizedTerminalSourceCount = record.terminalSourceCount ?? null;
  const proximityProgress = parseLocalNightlyProximityProgress(
    record.proximityProgress,
  );
  const primaryImageProgress = parseLocalNightlyPrimaryImageProgress(
    record.primaryImageProgress,
  );
  const primaryImageSession = parseLocalNightlyPrimaryImageSession(
    record.primaryImageSession,
  );
  const enrichmentProgress = parseLocalNightlyEnrichmentProgress(
    record.enrichmentProgress,
  );
  const coreProgress = parseLocalNightlyScopeProgress(record.coreProgress);
  const maintenanceProgress = parseLocalNightlyScopeProgress(
    record.maintenanceProgress,
  );
  if (
    typeof record.available !== "boolean" ||
    typeof record.active !== "boolean" ||
    typeof record.reused !== "boolean" ||
    typeof record.state !== "string" ||
    record.state.length > 100 ||
    !isNullableNightlyWorkflowState(normalizedWorkflowState) ||
    !isNullableText(record.id, 128) ||
    !isNullableSafeInteger(record.runnerPid) ||
    !isNullableText(record.title, 256) ||
    !isNullableText(record.createdAt, 128) ||
    !isNullableText(record.updatedAt, 128) ||
    !isNullableText(record.endedAt, 128) ||
    !isNullableSafeInteger(record.exitCode) ||
    !isNullableText(record.lastError, 4_096) ||
    !isNullableText(record.logPath, 1_024) ||
    !isNullableText(record.stage, 128) ||
    !isNullableText(record.failedAtStage, 128) ||
    !isNullableSafeInteger(record.completedStages) ||
    !isNullableSafeInteger(record.totalStages) ||
    !isNullableSafeInteger(record.progressCompleted) ||
    !isNullableSafeInteger(record.progressTotal) ||
    !isNullableProgressPercent(record.progressPercent) ||
    !isNullableNightlyProgressPhase(normalizedProgressPhase) ||
    !isNullableSafeInteger(record.etaSeconds) ||
    !isNullableSafeInteger(normalizedAttemptCount) ||
    !isNullableText(record.message, 1_024) ||
    !isNullableText(record.workflowStartedAt, 128) ||
    !isNullableText(record.workflowUpdatedAt, 128) ||
    !isNullableText(record.workflowEndedAt, 128) ||
    !isNullableText(record.workflowError, 4_096) ||
    !isNullableSafeInteger(record.invocationSourcesAttempted) ||
    !isNullableSafeInteger(record.invocationSourcesCompleted) ||
    !isNullableText(record.campaignId, 128) ||
    !isNullableSafeInteger(record.campaignCycle) ||
    !isNullableSafeInteger(record.campaignSourcesCompleted) ||
    !isNullableSafeInteger(record.campaignSourcesTotal) ||
    !isNullableSafeInteger(normalizedTerminalSourceCount) ||
    !isNullableText(record.currentSourceId, 128)
  ) {
    return null;
  }
  const completedStages = record.completedStages as number | null;
  const totalStages = record.totalStages as number | null;
  const progressCompleted = record.progressCompleted as number | null;
  const progressTotal = record.progressTotal as number | null;
  const progressPercent = record.progressPercent as number | null;
  const progressPhase = normalizedProgressPhase as LocalNightlyProgressPhase | null;
  const workflowState = normalizedWorkflowState as LocalNightlyWorkflowState | null;
  const etaSeconds = record.etaSeconds as number | null;
  const attemptCount = normalizedAttemptCount as number | null;
  const invocationSourcesAttempted = record.invocationSourcesAttempted as number | null;
  const invocationSourcesCompleted = record.invocationSourcesCompleted as number | null;
  const campaignSourcesCompleted = record.campaignSourcesCompleted as number | null;
  const campaignSourcesTotal = record.campaignSourcesTotal as number | null;
  const terminalSourceCount = normalizedTerminalSourceCount as number | null;
  const sourceOutcomes = parseNightlySourceOutcomes(record.sourceOutcomes ?? []);
  if (sourceOutcomes === null) return null;
  if (record.stage === "complete" && campaignSourcesTotal !== null && sourceOutcomes.length !== campaignSourcesTotal) {
    return null;
  }
  let sourceOutcomeCounts = countNightlySourceOutcomes(sourceOutcomes);
  if (record.sourceOutcomeCounts !== undefined) {
    const candidateCounts = record.sourceOutcomeCounts as Record<string, unknown>;
    if (
      typeof record.sourceOutcomeCounts !== "object" ||
      record.sourceOutcomeCounts === null ||
      Array.isArray(record.sourceOutcomeCounts) ||
      !exactObjectKeys(
        candidateCounts,
        NIGHTLY_SOURCE_OUTCOME_NAMES,
      ) ||
      NIGHTLY_SOURCE_OUTCOME_NAMES.some((name) =>
        !Number.isSafeInteger(candidateCounts[name]) ||
        Number(candidateCounts[name]) < 0 ||
        Number(candidateCounts[name]) > (campaignSourcesTotal ?? sourceOutcomes.length) ||
        (sourceOutcomes.length > 0 && candidateCounts[name] !== sourceOutcomeCounts[name])
      ) ||
      NIGHTLY_SOURCE_OUTCOME_NAMES.reduce(
        (total, name) => total + Number(candidateCounts[name]),
        0,
      ) > (campaignSourcesTotal ?? sourceOutcomes.length)
    ) return null;
    sourceOutcomeCounts = Object.fromEntries(
      NIGHTLY_SOURCE_OUTCOME_NAMES.map((name) => [name, Number(candidateCounts[name])]),
    ) as LocalNightlySourceOutcomeCounts;
  }
  if (
    (completedStages === null) !== (totalStages === null) ||
    (completedStages !== null && (completedStages < 0 || totalStages! < completedStages)) ||
    (progressCompleted === null) !== (progressTotal === null) ||
    (progressCompleted === null) !== (progressPercent === null) ||
    (progressCompleted !== null &&
      (progressCompleted < 0 || progressTotal! < progressCompleted)) ||
    (etaSeconds !== null && etaSeconds < 0) ||
    (attemptCount !== null && attemptCount < 0) ||
    (invocationSourcesAttempted === null) !== (invocationSourcesCompleted === null) ||
    (invocationSourcesAttempted !== null &&
      invocationSourcesCompleted! < 0) ||
    (campaignSourcesCompleted === null) !== (campaignSourcesTotal === null) ||
    (campaignSourcesCompleted !== null &&
      (campaignSourcesCompleted < 0 || campaignSourcesCompleted > campaignSourcesTotal!)) ||
    (terminalSourceCount !== null && (
      terminalSourceCount < 0 ||
      terminalSourceCount > (campaignSourcesTotal ?? sourceOutcomes.length) ||
      (campaignSourcesTotal !== null && terminalSourceCount > campaignSourcesTotal)
    ))
  ) {
    return null;
  }
  return {
    available: record.available,
    active: record.active,
    state: record.state,
    workflowState,
    id: nullableText(record.id, 128),
    reused: record.reused,
    runnerPid: record.runnerPid as number | null,
    title: nullableText(record.title, 256),
    createdAt: nullableText(record.createdAt, 128),
    updatedAt: nullableText(record.updatedAt, 128),
    endedAt: nullableText(record.endedAt, 128),
    exitCode: record.exitCode as number | null,
    lastError: nullableText(record.lastError, 4_096),
    logPath: nullableText(record.logPath, 1_024),
    stage: nullableText(record.stage, 128),
    failedAtStage: nullableText(record.failedAtStage, 128),
    completedStages,
    totalStages,
    progressCompleted,
    progressTotal,
    progressPercent,
    progressPhase,
    proximityProgress,
    primaryImageProgress,
    primaryImageSession,
    enrichmentProgress,
    coreProgress,
    maintenanceProgress,
    etaSeconds,
    attemptCount,
    message: nullableText(record.message, 1_024),
    workflowStartedAt: nullableText(record.workflowStartedAt, 128),
    workflowUpdatedAt: nullableText(record.workflowUpdatedAt, 128),
    workflowEndedAt: nullableText(record.workflowEndedAt, 128),
    workflowError: nullableText(record.workflowError, 4_096),
    invocationSourcesAttempted,
    invocationSourcesCompleted,
    campaignId: nullableText(record.campaignId, 128),
    campaignCycle: record.campaignCycle as number | null,
    campaignSourcesCompleted,
    campaignSourcesTotal,
    terminalSourceCount,
    currentSourceId: nullableText(record.currentSourceId, 128),
    sourceOutcomes,
    sourceOutcomeCounts,
  };
}

function nullLocalNightlyProximityProgress(): LocalNightlyProximityProgress {
  return {
    queued: null,
    claimed: null,
    completed: null,
    stale: null,
    remaining: null,
  };
}

function parseLocalNightlyProximityProgress(
  value: unknown,
): LocalNightlyProximityProgress {
  if (value === undefined || value === null) return nullLocalNightlyProximityProgress();
  if (typeof value !== "object" || Array.isArray(value)) {
    return nullLocalNightlyProximityProgress();
  }
  const record = value as Record<string, unknown>;
  if (!exactObjectKeys(record, [
    "queued", "claimed", "completed", "stale", "remaining",
  ])) return nullLocalNightlyProximityProgress();
  const queued = isNullableSafeInteger(record.queued) ? record.queued as number | null : null;
  const claimed = isNullableSafeInteger(record.claimed) ? record.claimed as number | null : null;
  const completed = isNullableSafeInteger(record.completed)
    ? record.completed as number | null
    : null;
  const stale = isNullableSafeInteger(record.stale) ? record.stale as number | null : null;
  const remaining = isNullableSafeInteger(record.remaining)
    ? record.remaining as number | null
    : null;
  const values = [queued, claimed, completed, stale, remaining];
  if (values.every((entry) => entry === null)) return nullLocalNightlyProximityProgress();
  if (
    values.some((entry) => entry === null) ||
    values.some((entry) => entry! < 0) ||
    claimed! > queued! ||
    completed! + stale! > claimed! ||
    remaining! !== queued! - completed!
  ) return nullLocalNightlyProximityProgress();
  return { queued, claimed, completed, stale, remaining };
}

function nullLocalNightlyPrimaryImageProgress(): LocalNightlyPrimaryImageProgress {
  return { ready: null, deferred: null, claimed: null, remaining: null };
}

function nullLocalNightlyScopeProgress(): LocalNightlyScopeProgress {
  return { ready: null, deferred: null, claimed: null, remaining: null };
}

function parseLocalNightlyScopeProgress(value: unknown): LocalNightlyScopeProgress {
  if (value === undefined || value === null || typeof value !== "object" ||
      Array.isArray(value)) return nullLocalNightlyScopeProgress();
  const record = value as Record<string, unknown>;
  if (!exactObjectKeys(record, ["ready", "deferred", "claimed", "remaining"])) {
    return nullLocalNightlyScopeProgress();
  }
  for (const name of ["ready", "deferred", "claimed", "remaining"] as const) {
    if (!Number.isSafeInteger(record[name]) || Number(record[name]) < 0) {
      return nullLocalNightlyScopeProgress();
    }
  }
  if (Number(record.remaining) !== Number(record.ready) + Number(record.deferred) +
      Number(record.claimed)) return nullLocalNightlyScopeProgress();
  return {
    ready: Number(record.ready),
    deferred: Number(record.deferred),
    claimed: Number(record.claimed),
    remaining: Number(record.remaining),
  };
}

function parseLocalNightlyPrimaryImageProgress(
  value: unknown,
): LocalNightlyPrimaryImageProgress {
  if (value === undefined || value === null) return nullLocalNightlyPrimaryImageProgress();
  if (typeof value !== "object" || Array.isArray(value)) {
    return nullLocalNightlyPrimaryImageProgress();
  }
  const record = value as Record<string, unknown>;
  if (!exactObjectKeys(record, ["ready", "deferred", "claimed", "remaining"])) {
    return nullLocalNightlyPrimaryImageProgress();
  }
  const ready = isNullableSafeInteger(record.ready) ? record.ready as number | null : null;
  const deferred = isNullableSafeInteger(record.deferred)
    ? record.deferred as number | null
    : null;
  const claimed = isNullableSafeInteger(record.claimed)
    ? record.claimed as number | null
    : null;
  const remaining = isNullableSafeInteger(record.remaining)
    ? record.remaining as number | null
    : null;
  const values = [ready, deferred, claimed, remaining];
  if (values.every((entry) => entry === null)) return nullLocalNightlyPrimaryImageProgress();
  if (
    values.some((entry) => entry === null) ||
    values.some((entry) => entry! < 0) ||
    remaining !== ready! + deferred! + claimed!
  ) return nullLocalNightlyPrimaryImageProgress();
  return { ready, deferred, claimed, remaining };
}

function parseLocalNightlyPrimaryImageSession(
  value: unknown,
): LocalNightlyPrimaryImageSession | null {
  if (value === undefined || value === null || typeof value !== "object" ||
      Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactObjectKeys(record, [
    "sourceId", "attempted", "archived", "failed", "remainingWork", "stopReason",
  ])) return null;
  const sourceId = nullableText(record.sourceId, 128);
  const attempted = record.attempted;
  const archived = record.archived;
  const failed = record.failed;
  const stopReason = nullableText(record.stopReason, 128);
  if (
    sourceId === null || !Number.isSafeInteger(attempted) || Number(attempted) < 0 ||
    !Number.isSafeInteger(archived) || Number(archived) < 0 ||
    !Number.isSafeInteger(failed) || Number(failed) < 0 ||
    Number(archived) + Number(failed) !== Number(attempted) ||
    typeof record.remainingWork !== "boolean" ||
    (record.stopReason !== null && stopReason === null)
  ) return null;
  return {
    sourceId,
    attempted: Number(attempted),
    archived: Number(archived),
    failed: Number(failed),
    remainingWork: record.remainingWork,
    stopReason,
  };
}

function parseLocalNightlyEnrichmentProgress(
  value: unknown,
): LocalNightlyEnrichmentProgress | null {
  if (value === undefined || value === null || typeof value !== "object" ||
      Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!exactObjectKeys(record, [
    "scope", "queued", "claimed", "completed", "stale", "remaining",
  ]) || record.scope !== "enrichment_text+enrichment_embedding") return null;
  for (const name of ["queued", "claimed", "completed", "stale", "remaining"] as const) {
    if (!isNullableSafeInteger(record[name]) || Number(record[name]) < 0) return null;
  }
  return {
    scope: "enrichment_text+enrichment_embedding",
    queued: record.queued as number | null,
    claimed: record.claimed as number | null,
    completed: record.completed as number | null,
    stale: record.stale as number | null,
    remaining: record.remaining as number | null,
  };
}



function parsedTimestamp(value: string | null): number | null {
  const timestamp = Date.parse(value ?? "");
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function localNightlyRunIdentity(status: LocalNightlyRunStatus): string | null {
  return status.id ?? (parsedTimestamp(status.workflowStartedAt) === null
    ? null
    : status.workflowStartedAt);
}

export function newerNightlyWorkflowFailure(
  run: RunStatus,
  status: LocalNightlyRunStatus | null,
): NewerNightlyWorkflowFailure | null {
  if (status === null || status.active || !status.workflowEndedAt) {
    return null;
  }
  const failureDetail = status.workflowError;
  if (!failureDetail) return null;
  const workflowEndedAt = parsedTimestamp(status.workflowEndedAt);
  if (workflowEndedAt === null) return null;
  const sourceResultTimes = [run.lastCompletedAt, run.lastSuccessfulCompletedAt]
    .map(parsedTimestamp)
    .filter((timestamp): timestamp is number => timestamp !== null);
  const newestSourceResultAt = sourceResultTimes.length > 0
    ? Math.max(...sourceResultTimes)
    : null;
  if (newestSourceResultAt !== null && workflowEndedAt <= newestSourceResultAt) return null;
  return {
    endedAt: status.workflowEndedAt,
    detail: failureDetail,
  };
}

export function newerNightlyWorkflowCheckpointPause(
  run: RunStatus,
  status: LocalNightlyRunStatus | null,
): NewerNightlyWorkflowCheckpointPause | null {
  if (
    status === null ||
    status.active ||
    status.state !== "completed" ||
    status.workflowState !== "checkpoint_paused" ||
    status.exitCode !== 0 ||
    status.workflowError !== null ||
    status.workflowEndedAt === null ||
    (status.campaignSourcesTotal !== null && status.sourceOutcomes.length !== status.campaignSourcesTotal)
  ) return null;
  const workflowEndedAt = parsedTimestamp(status.workflowEndedAt);
  if (workflowEndedAt === null) return null;
  const sourceResultTimes = [run.lastCompletedAt, run.lastSuccessfulCompletedAt]
    .map(parsedTimestamp)
    .filter((timestamp): timestamp is number => timestamp !== null);
  const newestSourceResultAt = sourceResultTimes.length > 0
    ? Math.max(...sourceResultTimes)
    : null;
  if (newestSourceResultAt !== null && workflowEndedAt <= newestSourceResultAt) return null;
  return { endedAt: status.workflowEndedAt, status };
}

export function newerNightlyWorkflowMaintenanceDeferred(
  run: RunStatus,
  status: LocalNightlyRunStatus | null,
): NewerNightlyWorkflowMaintenanceDeferred | null {
  if (
    status === null ||
    status.active ||
    status.state !== "completed" ||
    status.workflowState !== "core_complete_maintenance_deferred" ||
    status.stage !== "complete" ||
    status.exitCode !== 0 ||
    status.workflowError !== null ||
    status.workflowEndedAt === null
  ) return null;
  const workflowEndedAt = parsedTimestamp(status.workflowEndedAt);
  if (workflowEndedAt === null) return null;
  const sourceResultTimes = [run.lastCompletedAt, run.lastSuccessfulCompletedAt]
    .map(parsedTimestamp)
    .filter((timestamp): timestamp is number => timestamp !== null);
  const newestSourceResultAt = sourceResultTimes.length > 0
    ? Math.max(...sourceResultTimes)
    : null;
  if (newestSourceResultAt !== null && workflowEndedAt <= newestSourceResultAt) return null;
  return { endedAt: status.workflowEndedAt, status };
}

async function requestLocalNightlyRun(method: "GET" | "POST"): Promise<LocalNightlyRunStatus> {
  const controller = new AbortController();
  const timeoutSeconds = method === "POST" ? 25 : 5;
  const timer = window.setTimeout(() => controller.abort(), timeoutSeconds * 1_000);
  try {
    const runtimeRevision = method === "POST"
      ? await preflightLocalRuntimeRevision(controller.signal)
      : null;
    const response = await fetch(LOCAL_NIGHTLY_RUN_URL, {
      method,
      redirect: "error",
      headers: {
        accept: "application/json",
        ...(runtimeRevision === null
          ? {}
          : { [RUNTIME_REVISION_HEADER]: runtimeRevision }),
      },
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const error = payload && typeof payload === "object" && "error" in payload
        ? String((payload as { error: unknown }).error)
        : `Nightly workflow request failed with ${response.status}`;
      const code = payload && typeof payload === "object" && "code" in payload
        ? String((payload as { code: unknown }).code)
        : null;
      throw new ApiRequestError(error, response.status, code);
    }
    const status = parseLocalNightlyRunStatus(payload);
    if (!status) {
      throw new ApiRequestError("The local nightly workflow returned an invalid response");
    }
    return status;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ApiRequestError(
        `The local nightly workflow did not respond within ${timeoutSeconds} seconds`,
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

async function preflightLocalRuntimeRevision(signal: AbortSignal): Promise<string> {
  const [appResponse, companionResponse] = await Promise.all([
    fetch(LOCAL_RUNTIME_REVISION_URL, {
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal,
    }),
    fetch(LOCAL_COMPANION_HEALTH_URL, {
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal,
    }),
  ]);
  const [appValue, companionValue] = await Promise.all([
    appResponse.json().catch(() => null) as Promise<unknown>,
    companionResponse.json().catch(() => null) as Promise<unknown>,
  ]);
  if (!appResponse.ok || !companionResponse.ok) {
    throw new ApiRequestError(
      "The local runtime revision is unavailable; discovery was not started. Restart the supervised local stack.",
      appResponse.ok ? companionResponse.status : appResponse.status,
      "runtime_revision_unavailable",
    );
  }
  const appRevision = parseRuntimeRevisionValue(
    appValue,
    "schemaVersion",
    "revision",
  );
  const companionRevision = parseRuntimeRevisionValue(
    companionValue,
    "runtimeRevisionSchema",
    "runtimeRevision",
  );
  if (appRevision === null || companionRevision === null) {
    throw new ApiRequestError(
      "The local runtime revision is unavailable; discovery was not started. Restart the supervised local stack.",
      null,
      "runtime_revision_unavailable",
    );
  }
  if (appRevision !== companionRevision) {
    throw new ApiRequestError(
      RUNTIME_REVISION_MISMATCH_MESSAGE,
      409,
      "runtime_revision_mismatch",
    );
  }
  return appRevision;
}

function parseRuntimeRevisionValue(
  value: unknown,
  schemaKey: string,
  revisionKey: string,
): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return record[schemaKey] === RUNTIME_REVISION_SCHEMA_VERSION &&
      typeof record[revisionKey] === "string" &&
      SHA256_IDENTITY_PATTERN.test(record[revisionKey])
    ? record[revisionKey]
    : null;
}

export function loadLocalNightlyRun(): Promise<LocalNightlyRunStatus> {
  return requestLocalNightlyRun("GET");
}

export function startLocalNightlyRun(): Promise<LocalNightlyRunStatus> {
  return requestLocalNightlyRun("POST");
}

export async function loadDashboard(
  scope: DashboardListingScope = "unvoted",
): Promise<DashboardPayload> {
  const payload = await readJson<DashboardPayload>(
    scope === "unvoted"
      ? "/api/dashboard"
      : `/api/dashboard?listingScope=${scope}`,
    undefined,
    { timeoutMs: DASHBOARD_REQUEST_TIMEOUT_MS },
  );
  if (
    typeof payload.originPostalCode !== "string" ||
    payload.listingScope !== scope ||
    typeof payload.hasReviewedListings !== "boolean" ||
    !Array.isArray(payload.listings) ||
    !Array.isArray(payload.sources) ||
    !payload.profile ||
    !payload.run
  ) {
    throw new ApiRequestError("Dashboard response is incomplete");
  }
  const toPercent = (value: number) => Math.round(value <= 1 ? value * 100 : value);
  const profile = {
    ...payload.profile,
    confidence: toPercent(payload.profile.confidence),
    positiveConcepts: payload.profile.positiveConcepts.map((concept) => ({
      ...concept,
      confidence: toPercent(concept.confidence),
    })),
    negativeConcepts: payload.profile.negativeConcepts.map((concept) => ({
      ...concept,
      confidence: toPercent(concept.confidence),
    })),
  };
  return {
    ...payload,
    listings: payload.listings.map((listing) => ({
      ...listing,
      recommendation: sanitizeListingRecommendation(listing.recommendation),
    })),
    profile,
  };
}













export async function loadListingDetail(
  listingId: string,
): Promise<ListingDetailPayload> {
  const payload = await readJson<ListingDetailPayload>(
    `/api/listings/${encodeURIComponent(listingId)}/detail`,
    undefined,
    { timeoutMs: 10_000 },
  );
  if (
    payload.listingId !== listingId ||
    typeof payload.cleanDescription !== "string" ||
    typeof payload.rawDescription !== "string" ||
    !Array.isArray(payload.galleryImageUrls) ||
    !Array.isArray(payload.images)
  ) {
    throw new ApiRequestError("Listing detail response is incomplete");
  }
  return payload;
}

export async function saveVote(
  listingId: string,
  vote: Vote,
): Promise<{
  persisted: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  status: number | null;
}> {
  try {
    const url = `/api/listings/${encodeURIComponent(listingId)}/vote`;
    await readJson(url, vote === null
      ? { method: "DELETE" }
      : {
        method: "PUT",
        body: JSON.stringify({ vote }),
      }, {
        timeoutMs: VOTE_REQUEST_TIMEOUT_MS,
      });
    return {
      persisted: true,
      errorCode: null,
      errorMessage: null,
      status: null,
    };
  } catch (error) {
    return {
      persisted: false,
      errorCode: error instanceof ApiRequestError ? error.code : null,
      errorMessage: error instanceof Error
        ? error.message
        : "Vote could not be saved",
      status: error instanceof ApiRequestError ? error.status : null,
    };
  }
}

const BULK_NOT_INTERESTED_OUTCOME_STATUSES = new Set<BulkNotInterestedOutcomeStatus>([
  "changed",
  "unchanged_not_interested",
  "skipped_existing_vote",
  "skipped_not_actionable",
  "skipped_not_ready",
]);

function exactObjectKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function boundedListingIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function parseBulkNotInterestedResponse(
  value: unknown,
): BulkNotInterestedResponse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !exactObjectKeys(record, [
      "requestedCount",
      "changedCanonicalListingIds",
      "outcomes",
    ]) ||
    !Number.isSafeInteger(record.requestedCount) ||
    (record.requestedCount as number) < 1 ||
    !Array.isArray(record.changedCanonicalListingIds) ||
    !Array.isArray(record.outcomes) ||
    record.outcomes.length !== record.requestedCount
  ) return null;

  const changedCanonicalListingIds = record.changedCanonicalListingIds;
  if (
    changedCanonicalListingIds.some((listingId) => !boundedListingIdentity(listingId)) ||
    new Set(changedCanonicalListingIds).size !== changedCanonicalListingIds.length
  ) return null;

  const outcomes: BulkNotInterestedOutcome[] = [];
  const requestedIds = new Set<string>();
  for (const value of record.outcomes) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const outcome = value as Record<string, unknown>;
    if (
      !exactObjectKeys(outcome, [
        "listingId",
        "canonicalListingId",
        "status",
        "vote",
      ]) ||
      !boundedListingIdentity(outcome.listingId) ||
      requestedIds.has(outcome.listingId) ||
      !(outcome.canonicalListingId === null ||
        boundedListingIdentity(outcome.canonicalListingId)) ||
      typeof outcome.status !== "string" ||
      !BULK_NOT_INTERESTED_OUTCOME_STATUSES.has(
        outcome.status as BulkNotInterestedOutcomeStatus,
      ) ||
      !(outcome.vote === null || outcome.vote === "interested" ||
        outcome.vote === "not_interested")
    ) return null;
    requestedIds.add(outcome.listingId);
    outcomes.push(outcome as unknown as BulkNotInterestedOutcome);
  }

  const changed = new Set(changedCanonicalListingIds);
  if (outcomes.some((outcome) =>
    (outcome.status === "changed" && (
      outcome.canonicalListingId === null || outcome.vote !== "not_interested" ||
      !changed.has(outcome.canonicalListingId)
    )) ||
    (outcome.status === "unchanged_not_interested" && (
      outcome.canonicalListingId === null || outcome.vote !== "not_interested" ||
      changed.has(outcome.canonicalListingId)
    )) ||
    (outcome.status === "skipped_existing_vote" && outcome.vote !== "interested") ||
    (outcome.status === "skipped_not_actionable" && (
      outcome.canonicalListingId !== null || outcome.vote !== null
    )) ||
    (outcome.status === "skipped_not_ready" && outcome.vote !== null)
  )) return null;
  if ([...changed].some((canonicalListingId) => !outcomes.some((outcome) =>
    outcome.status === "changed" &&
    outcome.canonicalListingId === canonicalListingId
  ))) return null;

  return {
    requestedCount: record.requestedCount as number,
    changedCanonicalListingIds: [...changedCanonicalListingIds],
    outcomes,
  };
}

export async function saveBulkNotInterestedVotes(
  listingIds: readonly string[],
): Promise<{
  persisted: boolean;
  response: BulkNotInterestedResponse | null;
  errorCode: string | null;
  errorMessage: string | null;
  status: number | null;
}> {
  const frozenListingIds = [...new Set(listingIds)];
  try {
    const untrusted = await readJson<unknown>("/api/listings/vote-batch", {
      method: "PUT",
      body: JSON.stringify({ listingIds: frozenListingIds }),
    }, {
      timeoutMs: BULK_VOTE_REQUEST_TIMEOUT_MS,
    });
    const response = parseBulkNotInterestedResponse(untrusted);
    if (!response) {
      throw new ApiRequestError("Bulk vote response is incomplete");
    }
    const responseListingIds = new Set(
      response.outcomes.map((outcome) => outcome.listingId),
    );
    if (
      response.requestedCount !== frozenListingIds.length ||
      responseListingIds.size !== frozenListingIds.length ||
      frozenListingIds.some((listingId) => !responseListingIds.has(listingId))
    ) {
      throw new ApiRequestError(
        "Bulk vote response does not match the requested listings",
      );
    }
    return {
      persisted: true,
      response,
      errorCode: null,
      errorMessage: null,
      status: null,
    };
  } catch (error) {
    return {
      persisted: false,
      response: null,
      errorCode: error instanceof ApiRequestError ? error.code : null,
      errorMessage: error instanceof Error
        ? error.message
        : "Visible votes could not be saved",
      status: error instanceof ApiRequestError ? error.status : null,
    };
  }
}

export function saveLotFeedback(
  listingId: string,
  decision: LotFeedbackDecision,
): Promise<{ listingId: string; lotOverride: ListingLotOverride | null }> {
  return readJson(`/api/listings/${encodeURIComponent(listingId)}/lot`, {
    method: "PUT",
    body: JSON.stringify({ decision }),
  });
}

export interface ProfileSignalFeedbackInput {
  concept: string;
  polarity: "positive" | "negative";
  action: "removed" | "restored";
  profileVersionId: string;
}

export function applyOptimisticProfileSignalFeedback(
  profile: InterestProfile,
  input: ProfileSignalFeedbackInput & { feedbackId: string; createdAt: string },
): InterestProfile {
  const normalizedConcept = normalizeProfileConcept(input.concept);
  const selectedKey = input.polarity === "positive"
    ? "positiveConcepts"
    : "negativeConcepts";
  const matchingConcept = profile[selectedKey].find((entry) =>
    normalizeProfileConcept(entry.name) === normalizedConcept
  );
  const corrections = profile.signalCorrections.filter((entry) =>
    entry.polarity !== input.polarity || entry.normalizedConcept !== normalizedConcept
  );

  return {
    ...profile,
    [selectedKey]: input.action === "removed"
      ? profile[selectedKey].filter((entry) =>
          normalizeProfileConcept(entry.name) !== normalizedConcept
        )
      : profile[selectedKey],
    signalCorrections: input.action === "removed"
      ? [
          ...corrections,
          {
            feedbackId: input.feedbackId,
            concept: matchingConcept?.name ?? input.concept.trim().replace(/\s+/gu, " "),
            normalizedConcept,
            polarity: input.polarity,
            removedAt: input.createdAt,
            sourceProfileVersionId: input.profileVersionId,
          },
        ]
      : corrections,
  };
}

/**
 * Reverts only one failed optimistic signal write. Other signal clicks may be
 * in flight at the same time, so restoring the entire prior profile would
 * incorrectly erase their optimistic state.
 */
export function revertOptimisticProfileSignalFeedback(
  profile: InterestProfile,
  priorProfile: InterestProfile,
  input: ProfileSignalFeedbackInput,
): InterestProfile {
  const normalizedConcept = normalizeProfileConcept(input.concept);
  const selectedKey = input.polarity === "positive"
    ? "positiveConcepts"
    : "negativeConcepts";
  if (input.action === "removed") {
    const priorConcept = priorProfile[selectedKey].find((entry) =>
      normalizeProfileConcept(entry.name) === normalizedConcept
    );
    const activeByName = new Map(
      profile[selectedKey].map((entry) => [normalizeProfileConcept(entry.name), entry]),
    );
    if (priorConcept) activeByName.set(normalizedConcept, priorConcept);
    const ordered = priorProfile[selectedKey].flatMap((entry) => {
      const key = normalizeProfileConcept(entry.name);
      const current = activeByName.get(key);
      if (!current) return [];
      activeByName.delete(key);
      return [current];
    });
    ordered.push(...activeByName.values());
    return {
      ...profile,
      [selectedKey]: ordered,
      signalCorrections: profile.signalCorrections.filter((entry) =>
        entry.polarity !== input.polarity || entry.normalizedConcept !== normalizedConcept
      ),
    };
  }

  const priorCorrection = priorProfile.signalCorrections.find((entry) =>
    entry.polarity === input.polarity && entry.normalizedConcept === normalizedConcept
  );
  if (!priorCorrection) return profile;
  const correctionsByKey = new Map(
    profile.signalCorrections.map((entry) => [
      `${entry.polarity}:${entry.normalizedConcept}`,
      entry,
    ]),
  );
  const targetKey = `${input.polarity}:${normalizedConcept}`;
  correctionsByKey.set(targetKey, priorCorrection);
  const orderedCorrections = priorProfile.signalCorrections.flatMap((entry) => {
    const key = `${entry.polarity}:${entry.normalizedConcept}`;
    const current = correctionsByKey.get(key);
    if (!current) return [];
    correctionsByKey.delete(key);
    return [current];
  });
  orderedCorrections.push(...correctionsByKey.values());
  return { ...profile, signalCorrections: orderedCorrections };
}

function normalizeProfileConcept(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

export function saveProfileSignalFeedback(input: ProfileSignalFeedbackInput): Promise<{
  outcome: "queued";
  feedbackId: string;
  concept: string;
  normalizedConcept: string;
  polarity: "positive" | "negative";
  action: "removed" | "restored";
  sourceProfileVersionId: string;
  createdAt: string;
  reconciliationPending: true;
  warning: string;
}> {
  return readJson("/api/profile/signals", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function saveOriginPostalCode(
  originPostalCode: string,
): Promise<{ postalCode: string; countryCode: "US"; updatedAt: string }> {
  return readJson("/api/settings/origin", {
    method: "PUT",
    body: JSON.stringify({ originPostalCode }),
  });
}

export async function setSourceEnabled(
  sourceId: string,
  enabled: boolean,
): Promise<{ sourceId: string; enabled: boolean }> {
  return readJson(`/api/settings/sources/${encodeURIComponent(sourceId)}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export async function loadOllamaHealth(): Promise<OllamaHealth> {
  return readJson<OllamaHealth>("/api/system/ollama", undefined, { timeoutMs: 5_000 });
}

export async function startDiscoveryRun(
  originPostalCode: string,
): Promise<DiscoveryRunSummary> {
  const result = await readJson<DiscoveryRunSummary & { error?: string; code?: string }>(
    "/api/runs",
    {
      method: "POST",
      body: JSON.stringify({ kind: "discovery", originPostalCode }),
    },
    {
      timeoutMs: RUN_REQUEST_TIMEOUT_MS,
      acceptErrorResponse: true,
    },
  );
  if (!result.runId || !["completed", "partial", "failed"].includes(result.status)) {
    throw new ApiRequestError(
      result.error || "Discovery response is incomplete",
      null,
      result.code ?? null,
    );
  }
  return result;
}

export {
  triggerLocalBrowserSourceAcquisition as startBrowserSourceAcquisition,
  type LocalSourceAcquisitionSummary,
} from "../../lib/sources/local-acquisition";
