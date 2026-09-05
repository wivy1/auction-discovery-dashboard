"use client";

import {
  type DashboardListingScope,
  type DashboardPayload,
  type DataMode,
  type DriveBucket,
  type Listing,
  type LotFeedbackDecision,
  type LocalNightlyRunStatus,
  type LocalScheduleStatus,
  type OllamaHealth,
  type RunStatus,
  type ScheduleWeekday,
  type SourceName,
  type Vote,
  DEFAULT_SCHEDULE_LOCAL_TIME,
  DEFAULT_SCHEDULE_WEEKDAYS,
  SCHEDULE_WEEKDAYS,
  applyOptimisticProfileSignalFeedback,
  dashboardRefreshRetryDecision,
  dashboardSourceFilterOptions,
  emptyDashboard,
  listingMatchesSourceFilter,
  listingIsPublisherHistoryOnly,
  listingSourceLinkItems,
  localNightlyRunIdentity,
  loadDashboard,
  loadListingDetail,
  loadLocalNightlyRun,
  loadLocalSchedule,
  revertOptimisticProfileSignalFeedback,
  loadOllamaHealth,
  removeLocalSchedule,
  saveLocalSchedule,
  saveLotFeedback,
  saveOriginPostalCode,
  saveProfileSignalFeedback,
  saveBulkNotInterestedVotes,
  saveVote,
  setSourceEnabled,
  startLocalNightlyRun,
  visibleBulkNotInterestedListingIds,
  newerNightlyWorkflowCheckpointPause,
  newerNightlyWorkflowFailure,
  newerNightlyWorkflowMaintenanceDeferred,
} from "./auction-data";
import {
  compareLearnedRecommendation,
  effectiveLotFeedbackDecision,
  explicitLotType,
  isListingEnded,
  isLot,
  listingCloseValue,
  listingEndTimestamp,
  listingRecommendationDisplayScore,
  listingSummary,
  matchesRecommendationScoreRange,
} from "./auction-display";
import {
  completeVoteUndo,
  prepareVoteUndo,
  recordVoteTransition,
  type VoteTransition,
} from "./auction-vote-history";
import {
  ACCENT_COOKIE_NAME,
  BACKGROUND_COOKIE_NAME,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_BACKGROUND_COLOR,
  createInterfacePalette,
  normalizeHexColor,
} from "./accent-theme";
import {
  AuctionLogo,
  createAuctionFaviconHref,
} from "./auction-logo";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRunDuration } from "../../lib/run-duration";

type AppView = "discover" | "profile" | "settings";
type VoteFilter = "all" | "unvoted" | "voted" | "interested" | "not_interested";
type ReviewedListingLoadState = "idle" | "loading" | "error";
type StatusTone = "good" | "warning" | "error" | "neutral";
type ManualLotFeedbackDecision = Exclude<LotFeedbackDecision, "automatic">;

const CLOSING_CLOCK_INTERVAL_MS = 60_000;
const DISCOVERY_DASHBOARD_REFRESH_INTERVAL_MS = 15_000;
const DISCOVER_RENDER_BATCH_SIZE = 100;
type LotFilter = "all" | "lots_only" | "exclude_lots";
type ListingLayout = "grid" | "list";
type ListingSort = "closing" | "newest" | "drive" | "score";

function waitForDashboardRefreshRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

type RunStageStatus = "passed" | "failed" | "running" | "pending" | "skipped" | "unknown";

interface RunStagePresentation {
  id: string;
  label: string;
  status: RunStageStatus;
  detail: string | null;
}

type RunWithPresentation = RunStatus;

interface FilterState {
  search: string;
  source: "all" | SourceName;
  driveBucket: "all" | DriveBucket;
  closingSoon: boolean;
  includeEnded: boolean;
  newOnly: boolean;
  scoreMin: string;
  scoreMax: string;
  vote: VoteFilter;
  lot: LotFilter;
}

const DEFAULT_FILTERS: FilterState = {
  search: "",
  source: "all",
  driveBucket: "all",
  closingSoon: false,
  includeEnded: true,
  newOnly: false,
  scoreMin: "0",
  scoreMax: "100",
  vote: "unvoted",
  lot: "all",
};

function listingScopeForVoteFilter(vote: VoteFilter): DashboardListingScope {
  return vote;
}

function isNewUnvotedListing(listing: Listing): boolean {
  return listing.isNewSinceLastRun && listing.vote === null;
}

function adjustCurrentUnvotedCount(
  run: RunStatus,
  previousVote: Vote,
  nextVote: Vote,
): RunStatus {
  const wasUnvoted = previousVote === null;
  const isUnvoted = nextVote === null;
  if (wasUnvoted === isUnvoted) return run;
  return {
    ...run,
    currentUnvotedListings: Math.max(
      0,
      run.currentUnvotedListings + (isUnvoted ? 1 : -1),
    ),
  };
}

function discoveryRunTone(run: RunStatus): StatusTone {
  if (run.latestDiscoveryStatus === "failed") return "error";
  if (run.latestDiscoveryStatus === "partial") return "warning";
  if (run.latestDiscoveryStatus === "completed") return "good";
  if (run.latestDiscoveryStatus === "running" || run.latestDiscoveryStatus === "idle") {
    return "neutral";
  }
  if (run.state === "degraded") return run.errorMessage ? "error" : "warning";
  if (run.state === "completed") return "good";
  return "neutral";
}

function activeListingFilters(filters: FilterState): string[] {
  return [
    [Boolean(filters.search.trim()), "Search"],
    [filters.source !== DEFAULT_FILTERS.source, "Source"],
    [filters.driveBucket !== DEFAULT_FILTERS.driveBucket, "Approx. proximity"],
    [filters.vote !== DEFAULT_FILTERS.vote, "Review Type"],
    [filters.lot !== DEFAULT_FILTERS.lot, "Lot type"],
    [filters.closingSoon !== DEFAULT_FILTERS.closingSoon, "Closing soon"],
    [filters.includeEnded !== DEFAULT_FILTERS.includeEnded, "Include ended"],
    [filters.newOnly !== DEFAULT_FILTERS.newOnly, "New only"],
    [hasCustomScoreRange(filters), "Score"],
  ].flatMap(([active, label]) => active ? [String(label)] : []);
}

const LOCAL_ORIGIN_KEY = "auction-discovery:origin-postal-code";
const LOCAL_ACCENT_KEY = "auction-discovery:accent-theme";
const LOCAL_BACKGROUND_KEY = "auction-discovery:background-color";
const LOCAL_SCORE_RANGE_KEY = "auction-discovery:recommendation-score-range";
const BROWSER_DASHBOARD_CACHE_NAME = "auction-discovery-dashboard-v2";
const BROWSER_DASHBOARD_CACHE_URL = "/__auction-discovery-cache/dashboard-unvoted-v2";

function normalizeScoreBound(value: string): string {
  if (!value.trim()) return "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "";
  return String(Math.min(100, Math.max(0, Math.round(parsed))));
}

function scoreRangeBound(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function hasCustomScoreRange(
  filters: Pick<FilterState, "scoreMin" | "scoreMax">,
): boolean {
  const minimum = scoreRangeBound(filters.scoreMin);
  const maximum = scoreRangeBound(filters.scoreMax);
  return (minimum !== null && minimum > 0) ||
    (maximum !== null && maximum < 100);
}

function isCachedDashboardPayload(value: unknown): value is DashboardPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<DashboardPayload>;
  return candidate.listingScope === "unvoted" &&
    Array.isArray(candidate.listings) &&
    typeof candidate.originPostalCode === "string" &&
    typeof candidate.run === "object" && candidate.run !== null;
}

async function readCachedDashboardPayload(): Promise<DashboardPayload | null> {
  if (!("caches" in window)) return null;
  try {
    const cache = await window.caches.open(BROWSER_DASHBOARD_CACHE_NAME);
    const response = await cache.match(BROWSER_DASHBOARD_CACHE_URL);
    if (!response) return null;
    const payload: unknown = await response.json();
    return isCachedDashboardPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

async function writeCachedDashboardPayload(payload: DashboardPayload): Promise<void> {
  if (!("caches" in window) || payload.listingScope !== "unvoted") return;
  try {
    const cache = await window.caches.open(BROWSER_DASHBOARD_CACHE_NAME);
    await cache.put(
      BROWSER_DASHBOARD_CACHE_URL,
      new Response(JSON.stringify(payload), {
        headers: { "content-type": "application/json" },
      }),
    );
  } catch {
    // A fresh network read remains available when browser caching is unavailable.
  }
}

const navItems: Array<{ id: AppView; label: string; glyph: string }> = [
  { id: "discover", label: "Discover", glyph: "⌁" },
  { id: "profile", label: "Interest profile", glyph: "◎" },
  { id: "settings", label: "Settings", glyph: "⚙" },
];

const driveLabels: Record<DriveBucket, string> = {
  under_2h: "Under 2h",
  under_4h: "2–4h",
  under_8h: "4–8h",
};

function dateValue(value: string): number {
  if (!value) return Number.POSITIVE_INFINITY;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year!, month! - 1, day!, 23, 59, 59, 999).getTime();
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function useViewerReferenceTime(
  listings: readonly Listing[],
  fallbackReferenceTime: number,
): number {
  const [currentTime, setCurrentTime] = useState<number | null>(null);
  const exactEndTimes = useMemo(
    () => listings.flatMap((listing) => {
      const timestamp = listingEndTimestamp(listing);
      return timestamp === null ? [] : [timestamp];
    }),
    [listings],
  );

  useEffect(() => {
    let timeout: number | undefined;
    const refreshCurrentTime = () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      const now = Date.now();
      setCurrentTime(now);
      const nextEndTime = exactEndTimes.reduce(
        (soonest, timestamp) => timestamp > now && timestamp < soonest ? timestamp : soonest,
        Number.POSITIVE_INFINITY,
      );
      const nextRefreshDelay = Number.isFinite(nextEndTime)
        ? Math.min(CLOSING_CLOCK_INTERVAL_MS, Math.max(1, nextEndTime - now + 1))
        : CLOSING_CLOCK_INTERVAL_MS;
      timeout = window.setTimeout(refreshCurrentTime, nextRefreshDelay);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshCurrentTime();
    };

    refreshCurrentTime();
    window.addEventListener("focus", refreshCurrentTime);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      if (timeout !== undefined) window.clearTimeout(timeout);
      window.removeEventListener("focus", refreshCurrentTime);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [exactEndTimes]);

  return currentTime ?? fallbackReferenceTime;
}

function formatRelative(value: string): string {
  const deltaMinutes = Math.round((dateValue(value) - Date.now()) / 60_000);
  const absolute = Math.abs(deltaMinutes);
  if (absolute < 2) return "just now";
  if (absolute < 60) return deltaMinutes > 0 ? `in ${absolute}m` : `${absolute}m ago`;
  const hours = Math.round(absolute / 60);
  if (hours < 24) return deltaMinutes > 0 ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return deltaMinutes > 0 ? `in ${days}d` : `${days}d ago`;
}

function formatDate(value: string): string {
  if (!value) return "Close time unavailable";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(year!, month! - 1, day!));
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatClosing(value: string): string {
  if (!value) return "Time unavailable";
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${formatDate(value)} · time not imported`
    : formatRelative(value);
}

function formatListingClosing(listing: Listing): string {
  if (listing.actionDeadline?.basis === "live_auction_start") {
    return formatClosing(listing.actionDeadline.at);
  }
  
  return formatClosing(listing.closesAt);
}

function actionDeadlineLabel(listing: Listing): string {
  if (listing.actionDeadline?.basis !== "live_auction_start") return "Closes";
  return "Live auction";
}

function isListingClosingSoon(listing: Listing, referenceTime: number): boolean {
  const delta = listingCloseValue(listing) - referenceTime;
  return Number.isFinite(delta) && delta >= 0 && delta <= 24 * 60 * 60 * 1_000;
}

function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) return `${remainder} min`;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function listingDistancePresentation(listing: Listing): {
  value: string;
  detail: string | null;
} {
  if (listing.distanceWaived) {
    return {
      value: "Distance waived for this review run",
      detail: null,
    };
  }
  if (listing.driveMinutes === null || listing.driveBucket === null) {
    return {
      value: "Location unavailable",
      detail: null,
    };
  }
  const directDistance = typeof listing.directDistanceMiles === "number"
    ? `${listing.directDistanceMiles.toLocaleString(undefined, {
      maximumFractionDigits: 1,
    })} mi straight line`
    : null;
  const evidence = listing.proximityEvidence?.endsWith("census_zcta")
    ? "ZIP internal point"
    : listing.proximityEvidence?.endsWith("census_place")
    ? "city envelope center"
    : listing.proximityEvidence?.endsWith("source_coordinates")
    ? "source coordinates"
    : null;
  return {
    value: `Est. ${formatMinutes(listing.driveMinutes)}`,
    detail: [directDistance, driveLabels[listing.driveBucket], evidence]
      .filter(Boolean).join(" · ") || null,
  };
}

function listingCardPrice(listing: Listing): { label: string; value: string } {
  const sourcePrice = listing.priceAtScrape.trim();
  const numericSourcePrice = Number(sourcePrice.replace(/[$,\s]/gu, ""));
  const sourcePriceIsPresent = sourcePrice.toLocaleLowerCase() !== "not listed"
    && (!Number.isFinite(numericSourcePrice) || numericSourcePrice > 0);
  if (sourcePriceIsPresent) {
    return { label: "Price at scrape", value: listing.priceAtScrape };
  }
  
  return { label: "Price at scrape", value: listing.priceAtScrape };
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().trim();
}

function hasTextEnrichment(listing: Listing): boolean {
  return listing.aiMeta.provider !== "pending";
}

function formatDateTime(value: string | null): string {
  if (!value) return "Not yet completed";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Completion time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function stageStatus(value: string | boolean | undefined): RunStageStatus {
  if (value === true) return "passed";
  if (value === false) return "failed";
  switch (value?.toLowerCase()) {
    case "passed":
    case "complete":
    case "completed":
    case "success":
      return "passed";
    case "failed":
    case "error":
    case "degraded":
    case "partial":
      return "failed";
    case "running":
      return "running";
    case "pending":
    case "queued":
      return "pending";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

function runStages(run: RunWithPresentation): RunStagePresentation[] {
  return run.stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    status: stageStatus(stage.state),
    detail: formatStageDetail(stage.detail),
  }));
}

function formatStageDetail(detail: string): string | null {
  const normalized = detail.replace(/\s+/gu, " ").trim();
  if (!normalized) return null;
  return normalized.length > 180
    ? `${normalized.slice(0, 177).trimEnd()}…`
    : normalized;
}

function Photo({
  src,
  alt,
  className = "",
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = Boolean(src) && failedSrc === src;
  const unavailableMessage = failed ? "Stored photo unavailable" : "No archived photo";
  return (
    <span className={`photo-shell ${className} ${failed ? "is-failed" : ""}`}>
      {src && !failed ? (
        // Only the locally archived source image is rendered; there is no remote fallback.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <span
          className="photo-placeholder"
          role="img"
          aria-label={alt ? `${unavailableMessage}: ${alt}` : unavailableMessage}
        >
          {unavailableMessage}
        </span>
      )}
    </span>
  );
}

function Logo() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <AuctionLogo className="brand-mark-glyph" />
    </span>
  );
}

function StatusDot({ state }: { state: StatusTone }) {
  return <span className={`status-dot status-${state}`} aria-hidden="true" />;
}

function NavButton({
  item,
  active,
  count,
  onClick,
}: {
  item: (typeof navItems)[number];
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`nav-button ${active ? "is-active" : ""}`}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
    >
      <span className="nav-glyph" aria-hidden="true">
        {item.glyph}
      </span>
      <span>{item.label}</span>
      {count !== undefined ? <span className="nav-count">{count}</span> : null}
    </button>
  );
}

function Sidebar({
  view,
  setView,
  unvotedCount,
  appName,
  originPostalCode,
}: {
  view: AppView;
  setView: (view: AppView) => void;
  unvotedCount: number;
  appName: string;
  originPostalCode: string;
}) {
  return (
    <aside className="sidebar">
      <button className="brand" type="button" onClick={() => setView("discover")}>
        <Logo />
        <span className="brand-copy">
          <strong>{appName}</strong>
          <small>local equipment scout</small>
        </span>
      </button>

      <nav className="primary-nav" aria-label="Primary navigation">
        <p className="nav-label">Workspace</p>
        {navItems.map((item) => (
          <NavButton
            key={item.id}
            item={item}
            active={view === item.id}
            count={item.id === "discover" ? unvotedCount : undefined}
            onClick={() => setView(item.id)}
          />
        ))}
      </nav>

      <div className="sidebar-spacer" />

      <button className="sidebar-footer" type="button" onClick={() => setView("settings")}>
        <div className="origin-icon" aria-hidden="true">
          ◉
        </div>
        <div>
          <small>Pickup origin</small>
          <strong>{originPostalCode}</strong>
        </div>
        <span className="origin-link-arrow" aria-hidden="true">→</span>
      </button>
    </aside>
  );
}

function MobileHeader({ view, setView, appName }: { view: AppView; setView: (view: AppView) => void; appName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <header className="mobile-header">
      <button className="brand mobile-brand" type="button" onClick={() => setView("discover")}>
        <Logo />
        <span className="brand-copy">
          <strong>{appName}</strong>
          <small>{navItems.find((item) => item.id === view)?.label}</small>
        </span>
      </button>
      <button
        className="mobile-menu-button"
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label="Open navigation"
      >
        <span />
        <span />
      </button>
      {open ? (
        <nav className="mobile-menu" aria-label="Mobile navigation">
          {navItems.map((item) => (
            <NavButton
              key={item.id}
              item={item}
              active={view === item.id}
              onClick={() => {
                setView(item.id);
                setOpen(false);
              }}
            />
          ))}
        </nav>
      ) : null}
    </header>
  );
}

function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className="page-description">{description}</p> : null}
      </div>
      {action ? <div className="page-header-action">{action}</div> : null}
    </header>
  );
}

function DiscoverMetrics({
  newCount,
  endingSoonCount,
  unvotedCount,
}: {
  newCount: number;
  endingSoonCount: number;
  unvotedCount: number;
}) {
  return (
    <div className="discover-metrics" aria-label="Discovery summary">
      <span>
        <b>{newCount}</b>
        <small>New this run</small>
      </span>
      <span>
        <b>{endingSoonCount}</b>
        <small>Ending soon</small>
      </span>
      <span>
        <b>{unvotedCount}</b>
        <small>To review</small>
      </span>
    </div>
  );
}

function DiscoveryStatus({
  run,
  nightlyStatus,
  running,
  refreshRequired,
  runningLabel,
}: {
  run: RunStatus;
  nightlyStatus: LocalNightlyRunStatus | null;
  running: boolean;
  refreshRequired: boolean;
  runningLabel?: string | null;
}) {
  const nightlyFailure = newerNightlyWorkflowFailure(run, nightlyStatus);
  const mixedTerminal = newerMixedNightlyTerminalResult(run, nightlyStatus);
  const checkpointPause = newerNightlyWorkflowCheckpointPause(run, nightlyStatus);
  const maintenanceDeferred = newerNightlyWorkflowMaintenanceDeferred(
    run,
    nightlyStatus,
  );
  const failed = run.latestDiscoveryStatus === "failed" || (
    run.latestDiscoveryStatus === undefined &&
    run.state === "degraded" &&
    Boolean(run.errorMessage)
  );
  const tone: StatusTone = running
    ? "neutral"
    : nightlyFailure || failed
      ? "error"
    : maintenanceDeferred || mixedTerminal || checkpointPause || refreshRequired ||
        run.state === "degraded"
      ? "warning"
      : run.lastCompletedAt ? "good" : "neutral";
  const label = running
    ? runningLabel || "Discovery running"
    : maintenanceDeferred
      ? `Discovery incomplete ${formatDateTime(maintenanceDeferred.endedAt)}`
    : nightlyFailure
      ? `Discovery failed ${formatDateTime(nightlyFailure.endedAt)}`
    : checkpointPause
      ? `Discovery paused ${formatDateTime(checkpointPause.endedAt)}`
    : mixedTerminal
      ? `Discovery finished ${formatDateTime(mixedTerminal.endedAt)}`
    : refreshRequired
      ? "Refresh needed"
      : failed
        ? "Last run failed"
        : run.state === "degraded"
          ? "Last run needs attention"
          : run.lastCompletedAt
            ? `Completed ${formatDateTime(run.lastCompletedAt)}`
            : "No completed run yet";
  return (
    <div className={`discovery-status discovery-status-${tone}`} role="status">
      <StatusDot state={tone} />
      <span>{label}</span>
    </div>
  );
}

function nightlyProgressLabel(status: LocalNightlyRunStatus | null): string | null {
  if (!status?.active) return null;
  const attempt = status.attemptCount === null || status.attemptCount === 0
    ? null
    : `Quantum ${status.attemptCount}`;
  const maintenanceStage = nightlyMaintenanceStage(status.stage);
  const scope = maintenanceStage ? status.maintenanceProgress : status.coreProgress;
  if (scope.remaining !== null) {
    return [
      maintenanceStage ? "Ranking maintenance" : "Core discovery",
      nightlyStageCopy(status.stage).label,
      `${scope.remaining.toLocaleString()} remaining`,
    ].join(" · ");
  }
  if (status.stage === "source_acquisition") {
    const sourceBoundaries = status.terminalSourceCount !== null &&
        status.campaignSourcesTotal !== null
      ? `Sources ${status.terminalSourceCount}/${status.campaignSourcesTotal}`
      : "Sources";
    return [sourceBoundaries, attempt].filter(Boolean).join(" · ");
  }
  if (nightlyPreparationStage(status.stage)) {
    const stage = nightlyStageCopy(status.stage).label;
    if (status.stage === "proximity") {
      const proximity = status.proximityProgress;
      const queue = proximity.completed !== null && proximity.queued !== null
        ? `${proximity.completed.toLocaleString()}/${proximity.queued.toLocaleString()} complete`
        : null;
      const remaining = proximity.remaining === null
        ? null
        : `${proximity.remaining.toLocaleString()} remaining`;
      return [stage, queue, remaining].filter(Boolean).join(" · ");
    }
    if (status.stage === "primary_image") {
      const images = status.primaryImageProgress;
      const session = status.primaryImageSession;
      const remaining = images.remaining === null
        ? null
        : `${images.remaining.toLocaleString()} images remaining`;
      const claimed = images.claimed === null || images.claimed === 0
        ? null
        : `${images.claimed.toLocaleString()} claimed`;
      const archived = session === null
        ? null
        : `${session.archived.toLocaleString()} archived last session`;
      return [stage, remaining, claimed, archived].filter(Boolean).join(" · ");
    }
    if (nightlyEnrichmentStage(status.stage)) {
      const enrichment = status.enrichmentProgress;
      const facts = enrichment === null ? [] : [
        enrichment.queued === null ? null : `${enrichment.queued.toLocaleString()} queued`,
        enrichment.claimed === null ? null : `${enrichment.claimed.toLocaleString()} claimed`,
        enrichment.remaining === null ? null : `${enrichment.remaining.toLocaleString()} remaining`,
        enrichment.completed === null
          ? null
          : `${enrichment.completed.toLocaleString()} completed last bounded session`,
        enrichment.stale === null
          ? null
          : `${enrichment.stale.toLocaleString()} stale last bounded session`,
      ];
      return [stage, ...facts].filter(Boolean).join(" · ");
    }
    const queue = status.progressCompleted !== null && status.progressTotal !== null
      ? `${status.progressCompleted.toLocaleString()}/${status.progressTotal.toLocaleString()}`
      : null;
    const percent = status.progressPercent === null
      ? null
      : `${Math.round(status.progressPercent)}%`;
    return [stage, queue, percent].filter(Boolean).join(" · ");
  }
  const stage = nightlyStageCopy(status.stage).label;
  return [stage, attempt].filter(Boolean).join(" · ") || "Discovery running";
}

function formatEtaSeconds(seconds: number): string {
  if (seconds < 60) return "under 1 min";
  return formatMinutes(Math.ceil(seconds / 60));
}

function humanizeIdentifier(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

interface MixedNightlyTerminalResult {
  endedAt: string;
  status: LocalNightlyRunStatus;
}

function newerMixedNightlyTerminalResult(
  run: RunStatus,
  status: LocalNightlyRunStatus | null,
): MixedNightlyTerminalResult | null {
  if (
    status === null ||
    status.active ||
    status.state !== "completed" ||
    status.stage !== "complete" ||
    status.exitCode !== 0 ||
    status.workflowError !== null ||
    status.workflowEndedAt === null ||
    status.sourceOutcomeCounts.refreshed + status.sourceOutcomeCounts.skipped_recent ===
      status.sourceOutcomes.length
  ) return null;
  const workflowEndedAt = Date.parse(status.workflowEndedAt);
  if (!Number.isFinite(workflowEndedAt)) return null;
  const sourceResultTimes = [run.lastCompletedAt, run.lastSuccessfulCompletedAt]
    .map((value) => Date.parse(value ?? ""))
    .filter(Number.isFinite);
  const newestSourceResultAt = sourceResultTimes.length > 0
    ? Math.max(...sourceResultTimes)
    : null;
  if (newestSourceResultAt !== null && workflowEndedAt <= newestSourceResultAt) return null;
  return { endedAt: status.workflowEndedAt, status };
}

function terminalSourceNames(
  status: LocalNightlyRunStatus,
  outcomeName: "skipped_recent" | "preserved" | "paused" | "stopped" | "blocked",
): string {
  return status.sourceOutcomes
    .filter(({ outcome }) => outcome === outcomeName)
    .map((outcome) => {
      const sourceName = humanizeIdentifier(outcome.sourceId);
      return outcomeName === "paused" && outcome.nextEligibleAt
        ? `${sourceName} (eligible ${formatDateTime(outcome.nextEligibleAt)})`
        : sourceName;
    })
    .join(", ");
}

function nightlyPreparationStage(stage: string | null): boolean {
  return stage === "projection_listing_refresh" ||
    stage === "projection_source_refresh" ||
    stage === "projection_group_refresh" ||
    stage === "projection_global_refresh" ||
    stage === "source_acquisition_readiness" ||
    stage === "proximity" ||
    stage === "detail" ||
    stage === "action_deadline" ||
    stage === "owner_refresh" ||
    stage === "factual_supplement" ||
    stage === "image_evidence" ||
    stage === "primary_image" ||
    stage === "enrichment_text" ||
    stage === "enrichment_embedding" ||
    stage === "source_release";
}

function nightlyEnrichmentStage(stage: string | null): boolean {
  return stage === "enrichment_text" || stage === "enrichment_embedding";
}

function nightlyMaintenanceStage(stage: string | null): boolean {
  return nightlyEnrichmentStage(stage) || stage === "source_release";
}

function nightlySourceContext(
  status: LocalNightlyRunStatus,
  recordedStage = status.stage,
): { label: string; value: string } | null {
  if (!status.currentSourceId) return null;
  const value = humanizeIdentifier(status.currentSourceId);
  if (recordedStage === "source_acquisition") {
    if (status.progressPhase === "batch_started" ||
        status.progressPhase === "batch_heartbeat") {
      return { label: "Current source callback", value };
    }
    if (status.progressPhase === "snapshot") {
      return { label: "Next scheduled source", value };
    }
    if (status.progressPhase === "batch_completed") {
      return { label: "Last source callback", value };
    }
    return { label: "Source context", value };
  }
  return {
    label: nightlyPreparationStage(recordedStage)
      ? "Preparation queue/source context"
      : "Scheduled item context",
    value,
  };
}

function nightlySourceOutcomeSummary(status: LocalNightlyRunStatus): string | null {
  if (Object.values(status.sourceOutcomeCounts).every((count) => count === 0)) return null;
  return ([
    "refreshed", "skipped_recent", "preserved", "paused", "stopped", "blocked",
  ] as const)
    .flatMap((outcome) => status.sourceOutcomeCounts[outcome] > 0
      ? [`${status.sourceOutcomeCounts[outcome]} ${humanizeIdentifier(outcome).toLocaleLowerCase()}`]
      : [])
    .join(" · ");
}

function nightlyStageCopy(stage: string | null): { label: string; activity: string } {
  switch (stage) {
    case "runtime_check":
      return {
        label: "Checking the local runtime",
        activity: "Confirming the dashboard and companion are ready; no scraping has started.",
      };
    case "typescript_scheduler":
    case "scheduler_snapshot":
    case "scheduler_batch_started":
    case "scheduler_batch_heartbeat":
    case "scheduler_batch_completed":
      return {
        label: "Planning nightly work",
        activity: "Reading durable checkpoints and selecting the next bounded work unit.",
      };
    case "source_acquisition":
      return {
        label: "Refreshing source catalogs",
        activity: "Scraping current listing indexes and original listing records.",
      };
    case "projection_listing_refresh":
      return {
        label: "Refreshing listing projections",
        activity: "Rebuilding stored listing-level work projections; local database work only.",
      };
    case "projection_source_refresh":
      return {
        label: "Refreshing source projections",
        activity: "Rebuilding stored source-level work projections; no source callback or download.",
      };
    case "projection_group_refresh":
      return {
        label: "Refreshing group projections",
        activity: "Rebuilding stored source-group work projections from durable local state.",
      };
    case "projection_global_refresh":
      return {
        label: "Refreshing global projections",
        activity: "Rebuilding the shared all-source work projection from durable local state.",
      };
    case "source_acquisition_readiness":
      return {
        label: "Checking source readiness",
        activity: "Projecting which stored source work is ready; no source callback or download.",
      };
    case "proximity":
      return {
        label: "Calculating approximate distance",
        activity: "Using stored location evidence and local Census math; no router or geocoder call.",
      };
    case "detail":
      return {
        label: "Finalizing original listing text",
        activity: "Using the already-scraped title and description; no second listing scrape.",
      };
    case "action_deadline":
    case "owner_refresh":
    case "factual_supplement":
      return {
        label: "Finalizing source facts",
        activity: "Normalizing source-supported listing facts without LLM inference.",
      };
    case "image_evidence":
      return {
        label: "Checking image evidence",
        activity: "Checking stored source image references; no image bytes are downloaded in this stage.",
      };
    case "primary_image":
      return {
        label: "Archiving source primary images",
        activity: "Downloading only source-listed primary image bytes; no generated images.",
      };
    case "enrichment_text":
    case "enrichment_embedding":
      return {
        label: "Text + embedding enrichment",
        activity: stage === "enrichment_text"
          ? "Tagging and summarizing stored title and description text with the configured 27B model."
          : "Creating local semantic vectors after the 27B text model is unloaded.",
      };
    
    case "source_release":
      return {
        label: "Publishing the review queue",
        activity: "Releasing eligible listings to the dashboard and preserving terminal fallbacks.",
      };
    case "complete":
      return {
        label: "Finishing nightly discovery",
        activity: "The durable scheduler is at its terminal boundary.",
      };
    case "paused":
      return {
        label: "Discovery paused at a durable checkpoint",
        activity: "Remaining preparation is preserved and will resume on the next discovery run.",
      };
    default:
      return {
        label: stage ? humanizeIdentifier(stage) : "Starting nightly discovery",
        activity: "Working through the shared scheduled discovery pipeline.",
      };
  }
}

function nightlyFailureStage(status: LocalNightlyRunStatus): string | null {
  return status.failedAtStage?.trim() ? status.failedAtStage : null;
}

function NightlyProgressPanel({
  run,
  status,
}: {
  run: RunStatus;
  status: LocalNightlyRunStatus | null;
}) {
  const failure = newerNightlyWorkflowFailure(run, status);
  const mixedTerminal = newerMixedNightlyTerminalResult(run, status);
  const checkpointPause = newerNightlyWorkflowCheckpointPause(run, status);
  const maintenanceDeferred = newerNightlyWorkflowMaintenanceDeferred(run, status);
  if (!status || (
    !status.active && !failure && !mixedTerminal && !checkpointPause && !maintenanceDeferred
  )) return null;
  if (maintenanceDeferred) {
    const maintenance = maintenanceDeferred.status.maintenanceProgress;
    return (
      <details
        className="nightly-progress-panel nightly-progress-panel-summary"
        aria-label="Discovery ended with ranking maintenance remaining"
      >
        <summary className="nightly-progress-heading">
          <span className="nightly-progress-heading-copy">
            <span>Stopped {formatDateTime(maintenanceDeferred.endedAt)}</span>
            <strong>Discovery incomplete</strong>
          </span>
        </summary>
        <div className="nightly-progress-facts">
          <span><b>Core discovery</b>Complete</span>
          <span>
            <b>Ranking maintenance remaining</b>
            {maintenance.remaining === null
              ? "Count unavailable"
              : maintenance.remaining.toLocaleString()}
          </span>
          {maintenance.ready === null ? null : (
            <span><b>Maintenance ready</b>{maintenance.ready.toLocaleString()}</span>
          )}
          {maintenance.deferred === null ? null : (
            <span><b>Maintenance deferred</b>{maintenance.deferred.toLocaleString()}</span>
          )}
          {maintenance.claimed === null ? null : (
            <span><b>Maintenance claimed</b>{maintenance.claimed.toLocaleString()}</span>
          )}
        </div>
        <p>Ranking maintenance is preserved and will resume with Run discovery.</p>
      </details>
    );
  }
  if (mixedTerminal) {
    const terminalStatus = mixedTerminal.status;
    const outcomeGroups = ["preserved", "paused", "stopped", "blocked"] as const;
    return (
      <details
        className="nightly-progress-panel nightly-progress-panel-summary"
        aria-label="Nightly discovery source outcomes"
      >
        <summary className="nightly-progress-heading">
          <span className="nightly-progress-heading-copy">
            <span>Finished {formatDateTime(mixedTerminal.endedAt)}</span>
            <strong>Discovery reached safe source boundaries</strong>
          </span>
        </summary>
        <div className="nightly-progress-facts">
          <span>
            <b>Terminal sources</b>
            {terminalStatus.terminalSourceCount ?? terminalStatus.sourceOutcomes.length} of {terminalStatus.campaignSourcesTotal ?? terminalStatus.sourceOutcomes.length} sources reached a terminal boundary
          </span>
          {terminalStatus.attemptCount === null || terminalStatus.attemptCount === 0 ? null : (
            <span><b>Actual attempt</b>Scheduler quantum {terminalStatus.attemptCount}</span>
          )}
          <span>
            <b>Refreshed</b>
            {terminalStatus.sourceOutcomeCounts.refreshed} sources published verified fresh catalogs
          </span>
          <span>
            <b>Recent catalogs reused</b>
            {terminalStatus.sourceOutcomeCounts.skipped_recent} sources needed no new scrape
            {terminalStatus.sourceOutcomeCounts.skipped_recent > 0
              ? `: ${terminalSourceNames(terminalStatus, "skipped_recent")}`
              : ""}
          </span>
          {outcomeGroups.map((outcome) => (
            <span key={outcome}>
              <b>{humanizeIdentifier(outcome)} ({terminalStatus.sourceOutcomeCounts[outcome]})</b>
              {terminalSourceNames(terminalStatus, outcome) || "None"}
            </span>
          ))}
        </div>
      </details>
    );
  }
  const failed = failure !== null;
  const paused = checkpointPause !== null;
  const recordedStage = failed
    ? nightlyFailureStage(status) ?? (status.stage === "failed" ? null : status.stage)
    : status.stage;
  const stage = recordedStage ? nightlyStageCopy(recordedStage) : null;
  const proximityStage = recordedStage === "proximity";
  const primaryImageStage = recordedStage === "primary_image";
  const enrichmentStage = nightlyEnrichmentStage(recordedStage);
  const proximity = status.proximityProgress;
  const proximityAvailable = proximityStage && proximity.queued !== null &&
    proximity.claimed !== null && proximity.completed !== null &&
    proximity.stale !== null && proximity.remaining !== null;
  const primaryImages = status.primaryImageProgress;
  const primaryImagesAvailable = primaryImageStage &&
    primaryImages.ready !== null && primaryImages.deferred !== null &&
    primaryImages.claimed !== null && primaryImages.remaining !== null;
  const primaryImageSession = primaryImageStage ? status.primaryImageSession : null;
  const maintenanceStage = nightlyMaintenanceStage(recordedStage);
  const enrichment = maintenanceStage ? status.enrichmentProgress : null;
  const coreProgress = status.coreProgress;
  const maintenanceProgress = status.maintenanceProgress;
  const coreProgressAvailable = coreProgress.ready !== null &&
    coreProgress.deferred !== null && coreProgress.claimed !== null &&
    coreProgress.remaining !== null;
  const maintenanceProgressAvailable = maintenanceProgress.ready !== null &&
    maintenanceProgress.deferred !== null && maintenanceProgress.claimed !== null &&
    maintenanceProgress.remaining !== null;
  const scopeProgressAvailable = coreProgressAvailable || maintenanceProgressAvailable;
  const percent = scopeProgressAvailable || primaryImageStage || enrichmentStage
    ? null
    : proximityStage
    ? proximityAvailable
      ? proximity.queued === 0 ? 100 : (proximity.completed! / proximity.queued!) * 100
      : null
    : status.progressPercent;
  const completed = scopeProgressAvailable || primaryImageStage || enrichmentStage
    ? null
    : proximityStage
    ? proximityAvailable ? proximity.completed : null
    : status.progressCompleted;
  const total = scopeProgressAvailable || primaryImageStage || enrichmentStage
    ? null
    : proximityStage
    ? proximityAvailable ? proximity.queued : null
    : status.progressTotal;
  const preparationStage = nightlyPreparationStage(recordedStage);
  const workRemaining = completed !== null && total !== null
    ? Math.max(0, total - completed)
    : null;
  const sourceContext = nightlySourceContext(status, recordedStage);
  const sourceBoundaries = status.terminalSourceCount !== null &&
      status.campaignSourcesTotal !== null
    ? `${status.terminalSourceCount} of ${status.campaignSourcesTotal} sources reached a terminal boundary`
    : null;
  const sourceOutcomeSummary = nightlySourceOutcomeSummary(status);
  const completion = completed !== null && total !== null
    ? proximityStage
      ? null
      : preparationStage
      ? `${completed.toLocaleString()} processed from a current preparation queue of ${total.toLocaleString()}`
      : `${completed.toLocaleString()} of ${total.toLocaleString()} scheduler work units completed`
    : null;
  const remaining = workRemaining !== null
    ? proximityStage
      ? null
      : preparationStage
      ? `${workRemaining.toLocaleString()} currently remain; the queue total can change at the next snapshot`
      : `${workRemaining.toLocaleString()} scheduler work units`
    : null;
  const currentActivity = stage?.activity ?? status.message ??
    (failed
      ? "No durable work stage was recorded."
      : paused
      ? "Remaining work is preserved at a durable checkpoint."
      : "Waiting for the first scheduler checkpoint.");
  const detail = [
    stage && status.message ? status.message : null,
  ].filter(Boolean).join(" · ");

  return (
    <details
      className={`nightly-progress-panel${failed ? " nightly-progress-panel-failed" : ""}`}
      aria-label={failed
        ? "Failed nightly discovery progress"
        : paused
        ? "Paused nightly discovery progress"
        : "Nightly discovery progress"}
    >
      <summary className="nightly-progress-heading">
        <span className="nightly-progress-heading-copy">
          <span>{failed
            ? `Failed ${formatDateTime(failure.endedAt)}`
            : paused
            ? `Paused ${formatDateTime(checkpointPause!.endedAt)}`
            : "In progress"}</span>
          <strong>{stage?.label ?? (failed
            ? "Discovery stopped"
            : paused
            ? "Discovery paused"
            : "Starting nightly discovery")}</strong>
        </span>
        {percent === null ? null : <b>{Math.round(percent)}%</b>}
      </summary>
      {percent === null ? null : (
        <div
          className="nightly-progress-track"
          role="progressbar"
          aria-label={proximityStage
            ? "Current proximity queue progress"
            : preparationStage
            ? "Current preparation queue progress"
            : "Scheduler work progress"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={`${Math.round(percent)} percent complete`}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
      <div className="nightly-progress-facts">
        <span><b>{failed ? "Stopped during" : paused ? "Checkpoint" : "Current"}</b>{currentActivity}</span>
        {status.active && scopeProgressAvailable ? (
          <span>
            <b>Active scope</b>
            {maintenanceStage ? "Ranking maintenance" : "Core discovery"}
          </span>
        ) : null}
        {coreProgressAvailable ? (
          <>
            <span><b>Core ready</b>{coreProgress.ready!.toLocaleString()}</span>
            <span><b>Core deferred</b>{coreProgress.deferred!.toLocaleString()}</span>
            <span><b>Core claimed</b>{coreProgress.claimed!.toLocaleString()}</span>
            <span><b>Core remaining</b>{coreProgress.remaining!.toLocaleString()}</span>
          </>
        ) : null}
        {maintenanceProgressAvailable ? (
          <>
            <span><b>Maintenance ready</b>{maintenanceProgress.ready!.toLocaleString()}</span>
            <span><b>Maintenance deferred</b>{maintenanceProgress.deferred!.toLocaleString()}</span>
            <span><b>Maintenance claimed</b>{maintenanceProgress.claimed!.toLocaleString()}</span>
            <span><b>Maintenance remaining</b>{maintenanceProgress.remaining!.toLocaleString()}</span>
          </>
        ) : null}
        {status.attemptCount === null || status.attemptCount === 0 ? null : (
          <span>
            <b>Scheduler quantum</b>
            {status.attemptCount}; diagnostic orchestration count, not completed {enrichmentStage
              ? "enrichment work"
              : primaryImageStage
              ? "image attempts"
              : "pipeline work"}
          </span>
        )}
        {sourceBoundaries ? <span><b>Source terminal boundaries</b>{sourceBoundaries}</span> : null}
        {sourceOutcomeSummary ? (
          <span><b>Recorded source outcomes</b>{sourceOutcomeSummary}</span>
        ) : null}
        {sourceContext ? <span><b>{sourceContext.label}</b>{sourceContext.value}</span> : null}
        {status.progressPhase === null ? null : (
          <span><b>Scheduler phase</b>{humanizeIdentifier(status.progressPhase)}</span>
        )}
        {proximityAvailable ? (
          <>
            <span><b>Proximity queued</b>{proximity.queued!.toLocaleString()} at pass start</span>
            <span><b>Proximity claimed</b>{proximity.claimed!.toLocaleString()}</span>
            <span><b>Proximity completed</b>{proximity.completed!.toLocaleString()}</span>
            <span><b>Proximity stale</b>{proximity.stale!.toLocaleString()}</span>
            <span>
              <b>{failed ? "Proximity unfinished when stopped" : "Proximity remaining"}</b>
              {proximity.remaining!.toLocaleString()} from this pass&apos;s dynamic queue baseline; the next pass may have a different total
            </span>
          </>
        ) : null}
        {primaryImagesAvailable ? (
          <>
            <span>
              <b>{failed ? "Primary images unfinished when stopped" : "Primary images remaining"}</b>
              {primaryImages.remaining!.toLocaleString()} current exact-input image rows
            </span>
            <span><b>Ready to archive</b>{primaryImages.ready!.toLocaleString()}</span>
            <span><b>Waiting for retry boundary</b>{primaryImages.deferred!.toLocaleString()}</span>
            <span><b>Durably claimed</b>{primaryImages.claimed!.toLocaleString()}</span>
          </>
        ) : null}
        {primaryImageSession ? (
          <span>
            <b>Last image session</b>
            {humanizeIdentifier(primaryImageSession.sourceId)}: {primaryImageSession.attempted.toLocaleString()} attempted · {primaryImageSession.archived.toLocaleString()} archived · {primaryImageSession.failed.toLocaleString()} failed acquisition{primaryImageSession.failed === 1 ? "" : "s"} · {primaryImageSession.remainingWork ? "more source image work remains" : "that source queue emptied"}{primaryImageSession.stopReason ? ` · ${humanizeIdentifier(primaryImageSession.stopReason)}` : ""}
          </span>
        ) : null}
        {enrichment ? (
          <>
            {enrichment.queued === null ? null : (
              <span><b>Enrichment queued</b>{enrichment.queued.toLocaleString()} in the latest bounded observation</span>
            )}
            {enrichment.claimed === null ? null : (
              <span><b>Enrichment claimed</b>{enrichment.claimed.toLocaleString()} in the latest bounded observation</span>
            )}
            {enrichment.remaining === null ? null : (
              <span><b>Enrichment remaining</b>{enrichment.remaining.toLocaleString()} in the latest bounded observation</span>
            )}
            {enrichment.completed === null ? null : (
              <span><b>Last bounded completed</b>{enrichment.completed.toLocaleString()}</span>
            )}
            {enrichment.stale === null ? null : (
              <span><b>Last bounded stale</b>{enrichment.stale.toLocaleString()}</span>
            )}
          </>
        ) : null}
        
        
        {completion ? <span><b>{preparationStage ? "Current preparation queue" : "Completed"}</b>{completion}</span> : null}
        {remaining ? <span><b>{failed
          ? "Unfinished when stopped"
          : paused
          ? "Unfinished at checkpoint"
          : preparationStage
          ? "Current queue remainder"
          : "Still to come"}</b>{remaining}</span> : null}
        {status.etaSeconds === null ? null : (
          <span>
            <b>{failed || paused ? "Last ETA" : "ETA"}</b>
            {status.etaSeconds < 60
              ? "Under 1 min"
              : `About ${formatEtaSeconds(status.etaSeconds)}`}
          </span>
        )}
      </div>
      {detail ? <p>{detail}</p> : null}
    </details>
  );
}

function ToggleFilter({
  checked,
  children,
  onChange,
}: {
  checked: boolean;
  children: React.ReactNode;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`filter-toggle ${checked ? "is-selected" : ""}`}
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
    >
      <span className="filter-checkbox" aria-hidden="true">
        {checked ? "✓" : ""}
      </span>
      {children}
    </button>
  );
}

function ListingSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="header-search-field">
      <span className="search-icon" aria-hidden="true">
        ⌕
      </span>
      <span className="sr-only">Search listings</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search equipment, model, or city…"
      />
      {value ? (
        <button type="button" onClick={() => onChange("")} aria-label="Clear search">
          ×
        </button>
      ) : null}
    </label>
  );
}

function Filters({
  filters,
  onChange,
  sources,
  expanded,
  setExpanded,
}: {
  filters: FilterState;
  onChange: (filters: FilterState) => void;
  sources: SourceName[];
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
}) {
  const activeFilters = activeListingFilters(filters);
  const activeCount = activeFilters.length;
  const activeFilterDescription = activeCount
    ? `${activeCount} active: ${activeFilters.join(", ")}`
    : "No active filters";

  const patch = <K extends keyof FilterState>(key: K, value: FilterState[K]) =>
    onChange({ ...filters, [key]: value });

  return (
    <section className="filter-panel" aria-label="Listing filters">
      <div className="filter-primary-row">
        <button
          className={`filter-drawer-button ${expanded ? "is-open" : ""}`}
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-label={`Filters. ${activeFilterDescription}`}
          title={activeFilterDescription}
        >
          <span aria-hidden="true">≡</span>
          Filters
          {activeCount ? <b>{activeCount}</b> : null}
        </button>
      </div>

      <div className={`filter-controls ${expanded ? "is-expanded" : ""}`}>
        <label className="select-field">
          <span>Source</span>
          <select
            value={filters.source}
            onChange={(event) => patch("source", event.target.value as FilterState["source"])}
          >
            <option value="all">All sources</option>
            {sources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </label>

        <label className="select-field compact-select">
          <span>Approx. drive</span>
          <select
            value={filters.driveBucket}
            onChange={(event) =>
              patch("driveBucket", event.target.value as FilterState["driveBucket"])
            }
          >
            <option value="all">Any estimate</option>
            <option value="under_2h">Est. under 2 hours</option>
            <option value="under_4h">Est. 2–4 hours</option>
            <option value="under_8h">Est. 4–8 hours</option>
          </select>
        </label>

        <div
          className="v2-score-range-filter"
          role="group"
          aria-labelledby="v2-score-range-label"
        >
          <span id="v2-score-range-label" className="v2-score-range-label">
            Score <small>0 low · 100 high</small>
          </span>
          <div className="v2-score-range-inputs">
            <label>
              <span className="sr-only">Minimum score</span>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                inputMode="numeric"
                value={filters.scoreMin}
                onChange={(event) => patch("scoreMin", normalizeScoreBound(event.target.value))}
                placeholder="Min"
                aria-label="Minimum score"
              />
            </label>
            <span aria-hidden="true">–</span>
            <label>
              <span className="sr-only">Maximum score</span>
              <input
                type="number"
                min="0"
                max="100"
                step="1"
                inputMode="numeric"
                value={filters.scoreMax}
                onChange={(event) => patch("scoreMax", normalizeScoreBound(event.target.value))}
                placeholder="Max"
                aria-label="Maximum score"
              />
            </label>
          </div>
        </div>

        <label className="select-field compact-select review-type-select">
          <span>Review Type</span>
          <select
            value={filters.vote}
            onChange={(event) => patch("vote", event.target.value as VoteFilter)}
          >
            <option value="all">All</option>
            <option value="unvoted">Unvoted</option>
            <option value="voted">Voted</option>
            <option value="interested">Interested</option>
            <option value="not_interested">Not interested</option>
          </select>
        </label>

        <label className="select-field compact-select">
          <span>Lot type</span>
          <select
            value={filters.lot}
            onChange={(event) => patch("lot", event.target.value as LotFilter)}
          >
            <option value="all">All listings</option>
            <option value="lots_only">Lots only</option>
            <option value="exclude_lots">Exclude lots</option>
          </select>
        </label>

        <div className="quick-filters">
          <ToggleFilter
            checked={filters.closingSoon}
            onChange={(value) => patch("closingSoon", value)}
          >
            Closing soon
          </ToggleFilter>
          <ToggleFilter
            checked={filters.includeEnded}
            onChange={(value) => patch("includeEnded", value)}
          >
            Include ended
          </ToggleFilter>
          <ToggleFilter checked={filters.newOnly} onChange={(value) => patch("newOnly", value)}>
            New only
          </ToggleFilter>
        </div>

        {activeCount ? (
          <button className="clear-filters" type="button" onClick={() => onChange(DEFAULT_FILTERS)}>
            Reset filters
          </button>
        ) : null}
      </div>
    </section>
  );
}

function SourceBadge({ source, compact = false }: { source: SourceName; compact?: boolean }) {
  const short = source.split(/\s+/).filter(Boolean).map(word => word[0]).join("").slice(0, 3).toUpperCase();
  return (
    <span className={`source-badge ${compact ? "is-compact" : ""}`} aria-label={compact ? source : undefined}>
      <b>{short}</b>
      {compact ? null : <span>{source}</span>}
    </span>
  );
}

function VoteControl({
  vote,
  onVote,
  disabled,
  compact = false,
  iconOnly = false,
  disabledReason,
}: {
  vote: Vote;
  onVote: (vote: Exclude<Vote, null>) => void;
  disabled?: boolean;
  compact?: boolean;
  iconOnly?: boolean;
  disabledReason?: string;
}) {
  return (
    <div
      className={`vote-control ${compact ? "is-compact" : ""} ${iconOnly ? "is-icon-only" : ""}`}
      aria-label={disabledReason
        ? `Interest feedback for future score training. ${disabledReason}`
        : "Interest feedback for future score training"}
      title={disabledReason}
    >
      <button
        type="button"
        className={`vote-positive ${vote === "interested" ? "is-selected" : ""}`}
        aria-pressed={vote === "interested"}
        aria-label="Interested"
        onClick={() => onVote("interested")}
        disabled={disabled}
      >
        <span className="vote-icon" aria-hidden="true" />
        <span className={iconOnly ? "sr-only" : "vote-label"}>Interested</span>
      </button>
      <button
        type="button"
        className={`vote-negative ${vote === "not_interested" ? "is-selected" : ""}`}
        aria-pressed={vote === "not_interested"}
        aria-label="Not interested"
        onClick={() => onVote("not_interested")}
        disabled={disabled}
      >
        <span className="vote-icon" aria-hidden="true" />
        <span className={iconOnly ? "sr-only" : "vote-label"}>Not interested</span>
      </button>
    </div>
  );
}

function ListingCard({
  listing,
  onOpen,
  onVote,
  saving,
  referenceTime,
}: {
  listing: Listing;
  onOpen: () => void;
  onVote: (vote: Exclude<Vote, null>) => void;
  saving: boolean;
  referenceTime: number;
}) {
  const ended = isListingEnded(listing, referenceTime);
  const publisherHistoryOnly = listingIsPublisherHistoryOnly(listing);
  const distance = listingDistancePresentation(listing);
  const closingSoon = isListingClosingSoon(listing, referenceTime);
  const lotType = explicitLotType(listing);
  const cardPrice = listingCardPrice(listing);
  const profileScore = listingRecommendationDisplayScore(listing);
  const recommendationUnrated = profileScore === null;
  return (
    <article className="listing-card">
      <button
        className="listing-photo-button"
        type="button"
        onClick={onOpen}
        aria-label={recommendationUnrated
          ? `Review ${listing.title}. Unrated`
          : profileScore !== null
            ? `Review ${listing.title}. Score ${profileScore} out of 100; higher means a stronger predicted Interest`
            : `Review ${listing.title}`}
      >
        <Photo src={listing.primaryImageUrl} alt={listing.title} className="listing-photo" />
        {profileScore !== null ? (
          <span className="score-badge" aria-hidden="true">
            <b>{profileScore}</b>
          </span>
        ) : recommendationUnrated ? (
          <span className="score-badge is-unrated" aria-hidden="true">
            <b>Unrated</b>
          </span>
        ) : null}
      </button>

      <div className="listing-content">
        <div className="listing-top-row">
          <div className="listing-flags">
            <SourceBadge source={listing.source} compact />
            {publisherHistoryOnly ? <span className="flag">Source history</span> : null}
            {isNewUnvotedListing(listing) ? <span className="flag flag-new">New</span> : null}
            {ended ? <span className="flag flag-ended">Ended</span> : null}
            {!ended && closingSoon ? <span className="flag flag-closing">Closing soon</span> : null}
            {lotType && isLot(lotType) ? <span className="flag flag-lot">Lot</span> : null}
          </div>
          <div className="listing-card-votes">
            <VoteControl
              vote={listing.vote}
              onVote={onVote}
              disabled={saving || publisherHistoryOnly || listing.voteReady === false}
              disabledReason={publisherHistoryOnly
                ? "This canonical owner vote is shown in reviewed source history."
                : listing.voteReady === false
                  ? "Voting unlocks when this listing is ready for review."
                  : undefined}
              compact
              iconOnly
            />
          </div>
        </div>

        <button className="listing-title-button" type="button" onClick={onOpen}>
          <h3>{listing.title}</h3>
        </button>
        <p className="listing-summary">{listingSummary(listing)}</p>

        <div className="listing-meta-grid">
          <span>
            <small>Pickup</small>
            <strong>
              {listing.pickupLocation.city}, {listing.pickupLocation.state}
            </strong>
          </span>
          <span>
            <small>Approx. proximity</small>
            <strong>{distance.value}{distance.detail ? ` · ${distance.detail}` : ""}</strong>
          </span>
          <span>
            <small>{cardPrice.label}</small>
            <strong>{cardPrice.value}</strong>
          </span>
          <span className={closingSoon ? "meta-closing" : ""}>
            <small>{actionDeadlineLabel(listing)}</small>
            <strong>{formatListingClosing(listing)}</strong>
          </span>
        </div>

      </div>
    </article>
  );
}

function EmptyState({
  kind,
  errorMessage,
  running,
  clear,
  retry,
  retryReviewed,
  runDiscovery,
  showEnded,
  showReviewed,
}: {
  kind:
    | "loading"
    | "error"
    | "reviewed_loading"
    | "reviewed_error"
    | "ended"
    | "no_sources"
    | "empty"
    | "filtered"
    | "reviewed";
  errorMessage: string | null;
  running: boolean;
  clear: () => void;
  retry: () => void;
  retryReviewed: () => void;
  runDiscovery: () => void;
  showEnded: () => void;
  showReviewed: () => void;
}) {
  const title = kind === "loading"
    ? "Connecting to the local dashboard"
    : kind === "error"
      ? "The local dashboard is unavailable"
      : kind === "reviewed_loading"
        ? "Loading reviewed listings"
        : kind === "reviewed_error"
          ? "Reviewed listings could not be loaded"
      : kind === "ended"
        ? "Only ended listings remain"
      : kind === "no_sources"
        ? "No auction sources configured"
      : kind === "empty"
        ? "No live auction listings yet"
        : kind === "reviewed"
          ? "Review queue complete"
          : "No equipment matches these filters";
  const description = kind === "loading"
    ? "Reading live listings and the latest ingestion status."
    : kind === "error"
      ? errorMessage || "The browser could not read the local auction API."
      : kind === "reviewed_loading"
        ? "Reading the complete reviewed history. Your unvoted queue stays available in memory."
        : kind === "reviewed_error"
          ? errorMessage || "The browser could not read the reviewed listing history."
      : kind === "ended"
        ? "These listings are still available to vote on. Include ended listings to continue reviewing them."
      : kind === "no_sources"
        ? "Configure a local adapter in source-adapters.local.ts, then enable the source in Settings to begin discovery."
      : kind === "empty"
        ? "Run discovery to ingest the first live listings."
        : kind === "reviewed"
          ? "Every listing in your review queue has a vote. Choose Voted in Review Type to see completed reviews."
          : "Try widening the approximate-proximity bucket or bringing reviewed listings back into view.";

  return (
    <div className="empty-state">
      <div className="empty-state-mark" aria-hidden="true">
        ⌁
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {kind === "error" ? (
        <button type="button" className="secondary-button" onClick={retry}>
          Retry connection
        </button>
      ) : kind === "reviewed_error" ? (
        <button type="button" className="secondary-button" onClick={retryReviewed}>
          Retry reviewed listings
        </button>
      ) : kind === "ended" ? (
        <button type="button" className="secondary-button" onClick={showEnded}>
          Include ended listings
        </button>
      ) : kind === "empty" ? (
        <button type="button" className="secondary-button" onClick={runDiscovery} disabled={running}>
          {running ? "Discovery running" : "Run discovery"}
        </button>
      ) : kind === "reviewed" ? (
        <button
          type="button"
          className="secondary-button"
          onClick={showReviewed}
        >
          Show reviewed listings
        </button>
      ) : kind === "filtered" ? (
        <button type="button" className="secondary-button" onClick={clear}>
          Clear filters
        </button>
      ) : null}
    </div>
  );
}

function DiscoverView({
  data,
  dataMode,
  referenceTime,
  filters,
  setFilters,
  openListing,
  vote,
  savingVote,
  bulkVoting,
  bulkNotInterested,
  undoVote,
  canUndoVote,
  undoingVote,
  runDiscovery,
  retryDashboard,
  retryReviewedListings,
  dashboardError,
  dashboardDegraded,
  dashboardRetryExhausted,
  reviewedListingsState,
  reviewedListingsError,
  running,
  refreshRequired,
  nightlyStatus,
}: {
  data: DashboardPayload;
  dataMode: DataMode;
  referenceTime: number;
  filters: FilterState;
  setFilters: (filters: FilterState) => void;
  openListing: (listing: Listing) => void;
  vote: (listing: Listing, vote: Exclude<Vote, null>) => void;
  savingVote: string | null;
  bulkVoting: boolean;
  bulkNotInterested: (listingIds: readonly string[]) => void;
  undoVote: () => void;
  canUndoVote: boolean;
  undoingVote: boolean;
  runDiscovery: () => void;
  retryDashboard: () => void;
  retryReviewedListings: () => void;
  dashboardError: string | null;
  dashboardDegraded: boolean;
  dashboardRetryExhausted: boolean;
  reviewedListingsState: ReviewedListingLoadState;
  reviewedListingsError: string | null;
  running: boolean;
  refreshRequired: boolean;
  nightlyStatus: LocalNightlyRunStatus | null;
}) {
  const [expandedFilters, setExpandedFilters] = useState(false);
  const [sort, setSort] = useState<ListingSort>("score");
  const [layout, setLayout] = useState<ListingLayout>("grid");
  const [visibleCount, setVisibleCount] = useState(DISCOVER_RENDER_BATCH_SIZE);
  const discoverListings = useMemo(
    () => data.listings.filter((listing) =>
      filters.includeEnded || !isListingEnded(listing, referenceTime)
    ),
    [data.listings, filters.includeEnded, referenceTime],
  );
  const sources = useMemo(
    () => dashboardSourceFilterOptions(discoverListings),
    [discoverListings],
  );
  const sourceScopedListingCount = discoverListings.filter((listing) =>
    listingMatchesSourceFilter(listing, filters.source)
  ).length;
  const normalizedSearch = useMemo(() => normalizeText(filters.search), [filters.search]);
  const listingMatchesFilters = useCallback((listing: Listing): boolean => {
    if (normalizedSearch) {
      const haystack = normalizeText(
        [
          listing.title,
          listing.aiSummary,
          listing.cleanDescription,
          listing.source,
          listing.pickupLocation.city,
          listing.attributes.manufacturer,
          ...listing.attributes.manufacturers,
          ...listing.attributes.modelNumbers,
          ...listing.attributes.assetClasses,
        ]
          .filter(Boolean)
          .join(" "),
      );
      if (!haystack.includes(normalizedSearch)) return false;
    }
    if (!listingMatchesSourceFilter(listing, filters.source)) return false;
    if (
      filters.driveBucket !== "all"
      && (listing.distanceWaived || listing.driveBucket !== filters.driveBucket)
    ) return false;
    if (filters.closingSoon && !isListingClosingSoon(listing, referenceTime))
      return false;
    if (filters.newOnly && !isNewUnvotedListing(listing)) return false;
    const minimumScore = scoreRangeBound(filters.scoreMin);
    const maximumScore = scoreRangeBound(filters.scoreMax);
    if (hasCustomScoreRange(filters)) {
      const score = listingRecommendationDisplayScore(listing);
      if (!matchesRecommendationScoreRange(score, minimumScore, maximumScore)) return false;
    }
    if (filters.vote === "unvoted" && listing.vote !== null) return false;
    if (filters.vote === "voted" && listing.vote === null) return false;
    if (filters.vote === "interested" && listing.vote !== "interested") return false;
    if (filters.vote === "not_interested" && listing.vote !== "not_interested") return false;
    const lotType = explicitLotType(listing);
    if (filters.lot === "lots_only" && (!lotType || !isLot(lotType))) return false;
    if (filters.lot === "exclude_lots" && lotType && isLot(lotType)) return false;
    return true;
  }, [filters, normalizedSearch, referenceTime]);

  const filteredListings = useMemo(() => {
    const matches = discoverListings.filter(listingMatchesFilters);
    return matches.sort((a, b) => {
      if (sort === "score") return compareLearnedRecommendation(a, b);
      if (sort === "closing") return listingCloseValue(a) - listingCloseValue(b);
      if (sort === "newest") return dateValue(b.firstSeenAt) - dateValue(a.firstSeenAt);
      const aDriveMinutes = a.distanceWaived
        ? Number.POSITIVE_INFINITY
        : (a.driveMinutes ?? Number.POSITIVE_INFINITY);
      const bDriveMinutes = b.distanceWaived
        ? Number.POSITIVE_INFINITY
        : (b.driveMinutes ?? Number.POSITIVE_INFINITY);
      return aDriveMinutes - bDriveMinutes;
    });
  }, [discoverListings, listingMatchesFilters, sort]);
  const requestedListingScope = listingScopeForVoteFilter(filters.vote);
  const waitingForListingScope = data.listingScope !== requestedListingScope;
  const queueModeLabel = filters.vote === "unvoted"
    ? "Unvoted queue"
    : filters.vote === "all" ? "All listings" : "Review history";
  const displayedListings = waitingForListingScope ? [] : filteredListings;
  const visibleListings = displayedListings.slice(0, visibleCount);
  const visibleBulkNotInterestedIds = useMemo(
    () => visibleBulkNotInterestedListingIds(visibleListings),
    [visibleListings],
  );
  const endedListingsAvailableForCurrentFilters = displayedListings.length === 0
    && !filters.includeEnded
    && data.listings.some((listing) =>
      isListingEnded(listing, referenceTime)
      && listingMatchesFilters(listing)
    );

  const closingCount = discoverListings.filter((listing) =>
    isListingClosingSoon(listing, referenceTime)
  ).length;
  const newCount = data.run.newListings;
  const unvotedCount = data.run.currentUnvotedListings;
  const scopedQueueComplete = data.listingScope === "unvoted"
    && data.listings.length === 0
    && data.hasReviewedListings;
  const allListingsReviewed = scopedQueueComplete
    || (data.listings.length > 0 && data.listings.every((listing) => listing.vote !== null));
  const hasActiveFilters = activeListingFilters(filters).length > 0;
  const emptyKind = dataMode === "loading"
    ? "loading"
    : dataMode === "error"
      ? "error"
      : waitingForListingScope
        ? reviewedListingsState === "error" ? "reviewed_error" : "reviewed_loading"
      : data.sources.length === 0 && data.listings.length === 0
        ? "no_sources"
      : scopedQueueComplete
        ? "reviewed"
      : endedListingsAvailableForCurrentFilters
        ? "ended"
      : discoverListings.length === 0
        ? "empty"
        : filters.vote === "unvoted" && allListingsReviewed
          ? "reviewed"
          : hasActiveFilters ? "filtered" : "empty";

  return (
    <div className="view-shell discover-view">
      <PageHeader
        title="Discover"
        action={
          <div className="discover-header-actions">
            <DiscoveryStatus
              run={data.run}
              nightlyStatus={nightlyStatus}
              running={running}
              refreshRequired={refreshRequired}
              runningLabel={nightlyProgressLabel(nightlyStatus)}
            />
            <button
              className="primary-button run-button"
              type="button"
              onClick={runDiscovery}
              disabled={running}
              title="Run the same complete workflow used by the nightly schedule"
            >
              <span className={running ? "is-spinning" : ""} aria-hidden="true">
                ↻
              </span>
              {running ? "Discovery running" : "Run discovery"}
            </button>
          </div>
        }
      />

      <div className="header-actions">
        <ListingSearch
          value={filters.search}
          onChange={(search) => {
            setVisibleCount(DISCOVER_RENDER_BATCH_SIZE);
            setFilters({ ...filters, search });
          }}
        />
        <DiscoverMetrics
          newCount={newCount}
          endingSoonCount={closingCount}
          unvotedCount={unvotedCount}
        />
      </div>

      <NightlyProgressPanel run={data.run} status={nightlyStatus} />

      {dashboardDegraded && dataMode === "api" ? (
        <p className="refresh-notice" role="status">
          <b>Dashboard refresh degraded.</b>{" "}
          Showing the last loaded results; {dashboardRetryExhausted
            ? "automatic retries are exhausted. Retry when the local runtime is available."
            : "the dashboard is retrying the local runtime."}
          {dashboardError ? ` ${dashboardError}` : ""}
        </p>
      ) : null}

      <Filters
        filters={filters}
        onChange={(nextFilters) => {
          setVisibleCount(DISCOVER_RENDER_BATCH_SIZE);
          setFilters(nextFilters);
        }}
        sources={sources}
        expanded={expandedFilters}
        setExpanded={setExpandedFilters}
      />

      <section className="results-section" aria-live="polite">
        <div className="results-toolbar">
          <div className="queue-context">
            <span className="queue-mode-label">{queueModeLabel}</span>
            <h2>Discovered equipment</h2>
            <p>
              <strong>{displayedListings.length}</strong> of{" "}
              {waitingForListingScope ? 0 : sourceScopedListingCount} listings
            </p>
          </div>
          <div className="results-controls">
            <button
              type="button"
              className="secondary-button"
              onClick={() => bulkNotInterested([...visibleBulkNotInterestedIds])}
              disabled={
                visibleBulkNotInterestedIds.length === 0 || bulkVoting ||
                savingVote !== null || undoingVote
              }
              title="Mark only the currently rendered unvoted cards Not interested"
            >
              {bulkVoting
                ? "Marking visible cards"
                : "Mark Not Interested"}
            </button>
            <button
              type="button"
              className="undo-vote-button"
              onClick={undoVote}
              disabled={!canUndoVote || undoingVote || savingVote !== null || bulkVoting}
              aria-label="Undo last vote"
              title="Restore the previous vote state"
            >
              <span aria-hidden="true">↶</span>
              {undoingVote ? "Undoing" : "Undo vote"}
            </button>
            <label className="sort-control">
              <span>Sort by</span>
              <select
                value={sort}
                onChange={(event) => {
                  setVisibleCount(DISCOVER_RENDER_BATCH_SIZE);
                  setSort(event.target.value as ListingSort);
                }}
              >
                <option value="score">Score</option>
                <option value="closing">Ending soonest</option>
                <option value="newest">Newest first</option>
                <option value="drive">Closest estimate</option>
              </select>
            </label>
            <div className="layout-control" role="group" aria-label="Listing layout">
              <button
                type="button"
                className={layout === "grid" ? "is-active" : ""}
                aria-pressed={layout === "grid"}
                onClick={() => {
                  setVisibleCount(DISCOVER_RENDER_BATCH_SIZE);
                  setLayout("grid");
                }}
              >
                Grid
              </button>
              <button
                type="button"
                className={layout === "list" ? "is-active" : ""}
                aria-pressed={layout === "list"}
                onClick={() => {
                  setVisibleCount(DISCOVER_RENDER_BATCH_SIZE);
                  setLayout("list");
                }}
              >
                List
              </button>
            </div>
          </div>
        </div>

        <div className={`listing-stack listing-collection is-${layout}`}>
          {displayedListings.length ? (
            visibleListings.map((listing) => (
              <ListingCard
                key={listing.id}
                listing={listing}
                onOpen={() => openListing(listing)}
                onVote={(nextVote) => vote(listing, nextVote)}
                saving={savingVote !== null || bulkVoting}
                referenceTime={referenceTime}
              />
            ))
          ) : (
            <EmptyState
              kind={emptyKind}
              errorMessage={waitingForListingScope
                ? reviewedListingsError
                : dashboardError}
              running={running}
              clear={() => setFilters(DEFAULT_FILTERS)}
              retry={retryDashboard}
              retryReviewed={retryReviewedListings}
              runDiscovery={runDiscovery}
              showEnded={() => setFilters({ ...filters, includeEnded: true })}
              showReviewed={() => setFilters({ ...DEFAULT_FILTERS, vote: "all" })}
            />
          )}
        </div>
        {displayedListings.length ? (
          visibleListings.length < displayedListings.length ? (
            <footer className="results-pagination" aria-label="More listings are available">
              <span>
                Showing {visibleListings.length.toLocaleString()} of{" "}
                {displayedListings.length.toLocaleString()}
              </span>
              <button
                type="button"
                className="secondary-button"
                onClick={() =>
                  setVisibleCount((count) =>
                    Math.min(
                      count + DISCOVER_RENDER_BATCH_SIZE,
                      displayedListings.length,
                    )
                  )}
              >
                Show {Math.min(
                  DISCOVER_RENDER_BATCH_SIZE,
                  displayedListings.length - visibleListings.length,
                ).toLocaleString()} more
              </button>
            </footer>
          ) : (
            <footer className="results-finished" aria-label="End of visible listings">
              <span>Finished</span>
            </footer>
          )
        ) : null}
      </section>
    </div>
  );
}

function ConceptCard({
  name,
  support,
  tone,
  onRemove,
  disabled,
}: {
  name: string;
  support: number;
  tone: "positive" | "negative";
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <article className={`concept-card concept-${tone}`}>
      <div className="concept-heading">
        <span className="concept-symbol" aria-hidden="true">
          {tone === "positive" ? "+" : "−"}
        </span>
        <div>
          <h3>{name}</h3>
          <p>{support} supporting {support === 1 ? "vote" : "votes"}</p>
        </div>
      </div>
      <button
        className="concept-remove"
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${name} from ${tone} signals`}
        title="This signal does not describe my preference"
      >
        <span aria-hidden="true">×</span>
      </button>
    </article>
  );
}

function ProfileView({
  data,
  onSignalFeedback,
  savingSignals,
}: {
  data: DashboardPayload;
  onSignalFeedback: (
    concept: string,
    polarity: "positive" | "negative",
    action: "removed" | "restored",
  ) => void;
  savingSignals: ReadonlySet<string>;
}) {
  return (
    <div className="view-shell profile-view">
      <PageHeader
        title="Interest profile"
        description="A text-only summary of the patterns supported by your interested and not-interested votes."
        action={
          <div className="profile-version">
            <small>Votes</small>
            <strong>
              {data.profile.positiveVotes} interested · {data.profile.negativeVotes} not interested
            </strong>
            <small>Last regenerated</small>
            <strong>{data.profile.version > 0 ? formatRelative(data.profile.generatedAt) : "Not generated yet"}</strong>
          </div>
        }
      />

      <section className="profile-overview">
        <article className="profile-summary-card">
          <blockquote>{data.profile.summary || "Keep rating listings, including some as Interested, so a useful interest profile can develop."}</blockquote>
        </article>
      </section>

      <section className="concept-section">
        <div className="section-heading">
          <div>
            <h2>Positive signals</h2>
          </div>
        </div>
        <div className="concept-grid">
          {data.profile.positiveConcepts.map((concept) => (
            <ConceptCard
              key={concept.name}
              {...concept}
              tone="positive"
              onRemove={() => onSignalFeedback(concept.name, "positive", "removed")}
              disabled={
                !data.profile.versionId ||
                savingSignals.has(`positive:${concept.name.toLocaleLowerCase()}`)
              }
            />
          ))}
          {!data.profile.positiveConcepts.length ? <p className="concept-empty">No supported positive signals yet.</p> : null}
        </div>
      </section>

      <section className="concept-section negative-section">
        <div className="section-heading">
          <div>
            <h2>Negative signals</h2>
          </div>
        </div>
        <div className="concept-grid negative-grid">
          {data.profile.negativeConcepts.map((concept) => (
            <ConceptCard
              key={concept.name}
              {...concept}
              tone="negative"
              onRemove={() => onSignalFeedback(concept.name, "negative", "removed")}
              disabled={
                !data.profile.versionId ||
                savingSignals.has(`negative:${concept.name.toLocaleLowerCase()}`)
              }
            />
          ))}
          {!data.profile.negativeConcepts.length ? <p className="concept-empty">No supported negative signals yet.</p> : null}
        </div>
      </section>

      {data.profile.signalCorrections.length ? (
        <section className="concept-section removed-signals-section">
          <div className="section-heading">
            <div>
              <h2>Removed signals</h2>
            </div>
          </div>
          <div className="removed-signals-list">
            {data.profile.signalCorrections.map((correction) => (
              <div key={correction.feedbackId}>
                <span>{correction.concept}</span>
                <small>{correction.polarity}</small>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => onSignalFeedback(correction.concept, correction.polarity, "restored")}
                  disabled={
                    !data.profile.versionId ||
                    savingSignals.has(`${correction.polarity}:${correction.concept.toLocaleLowerCase()}`)
                  }
                >
                  Restore
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

    </div>
  );
}

function formatDailyScheduleTime(value: string): string {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return value;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(2000, 0, 1, Number(match[1]), Number(match[2])));
}

function formatScheduleWeekdays(weekdays: readonly ScheduleWeekday[]): string {
  if (weekdays.length === 2) return `${weekdays[0]} and ${weekdays[1]}`;
  return weekdays[0] ?? "";
}

function SettingsView({
  data,
  ollamaHealth,
  origin,
  setOrigin,
  textProvider,
  textModel,
  embeddingModel,
  saveOrigin,
  running,
  refreshRequired,
  accentColor,
  backgroundColor,
  setAccentColor,
  setBackgroundColor,
  toggleSource,
  togglingSourceId,
}: {
  data: DashboardPayload;
  ollamaHealth: OllamaHealth | null;
  origin: string;
  setOrigin: (origin: string) => void;
  textProvider: string;
  textModel: string;
  embeddingModel: string;
  saveOrigin: (postalCode: string) => Promise<boolean>;
  running: boolean;
  refreshRequired: boolean;
  accentColor: string;
  backgroundColor: string;
  setAccentColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  toggleSource: (sourceId: string, enabled: boolean) => Promise<void>;
  togglingSourceId: string | null;
}) {
  const [saved, setSaved] = useState(false);
  const [schedule, setSchedule] = useState<LocalScheduleStatus | null>(null);
  const [scheduleDraftWeekdays, setScheduleDraftWeekdays] = useState<ScheduleWeekday[]>(
    () => [...DEFAULT_SCHEDULE_WEEKDAYS],
  );
  const [scheduleDraftTime, setScheduleDraftTime] = useState(DEFAULT_SCHEDULE_LOCAL_TIME);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const run = data.run as RunWithPresentation;
  const stages = runStages(run);
  const latestRunTone = discoveryRunTone(data.run);
  const latestRunStateLabel = data.run.latestDiscoveryStatus ?? data.run.state;
  const ollamaLabel = ollamaHealth
    ? !ollamaHealth.reachable
      ? "Unavailable"
      : "Reachable"
    : "Checking";
  const latestRunDescription = run.state === "running"
    ? run.lastStartedAt ? `Started ${formatDateTime(run.lastStartedAt)}` : "Running now"
    : run.state === "degraded"
      ? run.lastCompletedAt
        ? `Needs attention ${formatDateTime(run.lastCompletedAt)}`
        : "Source discovery needs attention"
    : run.lastCompletedAt
      ? `Completed ${formatDateTime(run.lastCompletedAt)}`
      : "No source discovery run yet";
  const latestRunError = data.run.errorMessage
    ? formatStageDetail(data.run.errorMessage)
    : null;
  const scheduleLabel = scheduleLoading
    ? "Loading schedule"
    : scheduleError || !schedule?.available
      ? "Schedule unavailable"
      : !schedule.configured
        ? "Not scheduled"
        : !schedule.enabled
          ? "Schedule disabled"
          : schedule.scheduleKind === "legacy_daily" && schedule.localTime
            ? `Legacy daily schedule at ${formatDailyScheduleTime(schedule.localTime)} — save to replace it.`
            : schedule.scheduleKind === "weekly" && schedule.weekdays && schedule.localTime
              ? `Every ${formatScheduleWeekdays(schedule.weekdays)} at ${formatDailyScheduleTime(schedule.localTime)}`
              : "Schedule unavailable";

  useEffect(() => {
    let active = true;
    void loadLocalSchedule()
      .then((status) => {
        if (!active) return;
        setSchedule(status);
        setScheduleError(status.error);
        if (status.scheduleKind === "weekly" && status.weekdays) {
          setScheduleDraftWeekdays(status.weekdays);
        } else {
          setScheduleDraftWeekdays([...DEFAULT_SCHEDULE_WEEKDAYS]);
        }
        setScheduleDraftTime(status.localTime ?? DEFAULT_SCHEDULE_LOCAL_TIME);
      })
      .catch((error) => {
        if (active) setScheduleError(error instanceof Error ? error.message : "Schedule unavailable");
      })
      .finally(() => {
        if (active) setScheduleLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const saveSettings = async () => {
    const normalized = origin.replace(/\D/g, "").slice(0, 5);
    if (!/^\d{5}$/.test(normalized)) return;
    const persisted = await saveOrigin(normalized);
    if (!persisted) return;
    setOrigin(normalized);
    try {
      window.localStorage.setItem(LOCAL_ORIGIN_KEY, normalized);
    } catch {
      // The settings remain usable for this session when storage is unavailable.
    }
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  const updateSchedule = async () => {
    if (
      scheduleDraftWeekdays.length < 1 ||
      scheduleDraftWeekdays.length > 2 ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(scheduleDraftTime)
    ) return;
    setScheduleBusy(true);
    setScheduleError(null);
    try {
      const status = await saveLocalSchedule(scheduleDraftWeekdays, scheduleDraftTime);
      setSchedule(status);
      if (status.scheduleKind === "weekly" && status.weekdays && status.localTime) {
        setScheduleDraftWeekdays(status.weekdays);
        setScheduleDraftTime(status.localTime);
      }
      setScheduleError(status.error);
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : "Schedule could not be saved");
    } finally {
      setScheduleBusy(false);
    }
  };

  const deleteSchedule = async () => {
    setScheduleBusy(true);
    setScheduleError(null);
    try {
      const status = await removeLocalSchedule();
      setSchedule(status);
      setScheduleDraftWeekdays([...DEFAULT_SCHEDULE_WEEKDAYS]);
      setScheduleDraftTime(DEFAULT_SCHEDULE_LOCAL_TIME);
      setScheduleError(status.error);
    } catch (error) {
      setScheduleError(error instanceof Error ? error.message : "Schedule could not be removed");
    } finally {
      setScheduleBusy(false);
    }
  };

  const toggleScheduleWeekday = (weekday: ScheduleWeekday) => {
    setScheduleDraftWeekdays((current) => {
      if (current.includes(weekday)) {
        return current.filter((candidate) => candidate !== weekday);
      }
      if (current.length >= 2) return current;
      return SCHEDULE_WEEKDAYS.filter(
        (candidate) => candidate === weekday || current.includes(candidate),
      );
    });
  };

  return (
    <div className="view-shell settings-view">
      <PageHeader title="Settings" />

      <div className="settings-grid">
        <section className="settings-card logistics-card">
          <div className="settings-card-header">
            <span className="settings-icon" aria-hidden="true">
              ◉
            </span>
            <div>
              <h2>Origin</h2>
            </div>
          </div>
          <label className="form-field">
            <span>Origin postal code</span>
            <div className="input-with-suffix">
              <input
                inputMode="numeric"
                pattern="[0-9]{5}"
                maxLength={5}
                value={origin}
                onChange={(event) => setOrigin(event.target.value.replace(/\D/g, "").slice(0, 5))}
              />
              <span>5 digits</span>
            </div>
          </label>
          {refreshRequired ? <p className="refresh-notice">Origin changed. Run discovery to refresh approximate proximity for this ZIP.</p> : null}
          <button
            className="secondary-button save-settings"
            type="button"
            onClick={() => void saveSettings()}
            disabled={running || !/^\d{5}$/.test(origin)}
          >
            {saved ? "Saved" : "Save active origin"}
          </button>
        </section>

        <section className="settings-card ai-card">
          <div className="settings-card-header">
            <span className="settings-icon" aria-hidden="true">
              ✦
            </span>
            <div>
              <h2>Local text models</h2>
            </div>
          </div>
          <dl className="provider-details">
            <div>
              <dt>Provider</dt>
              <dd>
                <StatusDot state={ollamaHealth?.reachable === true ? "good" : ollamaHealth?.reachable === false ? "warning" : "neutral"} /> {textProvider || "Not configured"}{textProvider && textModel && embeddingModel ? ` · ${ollamaLabel}` : ""}
              </dd>
            </div>
            <div>
              <dt>Text model</dt>
              <dd>{textModel || "Not configured"}</dd>
            </div>
            <div>
              <dt>Embedding model</dt>
              <dd>{embeddingModel || "Not configured"}</dd>
            </div>
          </dl>
        </section>

        <section className="settings-card schedule-card">
          <div className="settings-card-header">
            <span className="settings-icon" aria-hidden="true">
              ◷
            </span>
            <div>
              <h2>Scheduled discovery</h2>
            </div>
          </div>
          <div className="schedule-status" role="status">
            <StatusDot
              state={scheduleLoading ? "neutral" : schedule?.available && schedule.configured && schedule.enabled ? "good" : scheduleError ? "warning" : "neutral"}
            />
            <strong>{scheduleLabel}</strong>
          </div>
          <p className="settings-copy">
            Runs the same complete workflow as Run discovery: refresh enabled sources,
            prepare images and details, and refresh the dashboard. Text enrichment
            is optional when configured. Listings remain Unrated and can be reviewed
            without a preference scorer.
          </p>
          <form
            className="schedule-form"
            onSubmit={(event) => {
              event.preventDefault();
              void updateSchedule();
            }}
          >
            <fieldset
              className="schedule-weekday-field"
              disabled={scheduleLoading || scheduleBusy || schedule?.available === false}
            >
              <legend>Weekdays</legend>
              <div className="schedule-weekday-options">
                {SCHEDULE_WEEKDAYS.map((weekday) => {
                  const checked = scheduleDraftWeekdays.includes(weekday);
                  return (
                    <label key={weekday}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleScheduleWeekday(weekday)}
                        disabled={!checked && scheduleDraftWeekdays.length >= 2}
                      />
                      <span>{weekday}</span>
                    </label>
                  );
                })}
              </div>
              <small>Choose one or two days. New schedules default to Tuesday and Saturday at 2:00 AM.</small>
            </fieldset>
            <label className="schedule-time-field">
              <span>Local time on this computer</span>
              <input
                type="time"
                value={scheduleDraftTime}
                onChange={(event) => setScheduleDraftTime(event.target.value)}
                aria-label="Local time on this computer"
                disabled={scheduleLoading || scheduleBusy || schedule?.available === false}
              />
            </label>
            <div className="schedule-actions">
              <button
                className="secondary-button"
                type="submit"
                disabled={
                  scheduleLoading ||
                  scheduleBusy ||
                  schedule?.available === false ||
                  scheduleDraftWeekdays.length < 1 ||
                  scheduleDraftWeekdays.length > 2 ||
                  !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(scheduleDraftTime)
                }
              >
                {scheduleBusy ? "Saving" : "Save schedule"}
              </button>
              {schedule?.configured ? (
                <button className="text-button" type="button" onClick={() => void deleteSchedule()} disabled={scheduleBusy}>
                  Remove
                </button>
              ) : null}
            </div>
          </form>
          {schedule?.configured && (schedule.nextRunAt || schedule.lastRunAt) ? (
            <dl className="schedule-meta">
              {schedule.nextRunAt ? <div><dt>Next run</dt><dd>{formatDateTime(schedule.nextRunAt)}</dd></div> : null}
              {schedule.lastRunAt ? <div><dt>Last run</dt><dd>{formatDateTime(schedule.lastRunAt)}</dd></div> : null}
              {schedule.lastResult !== null ? <div><dt>Last result</dt><dd>Exit code {schedule.lastResult}</dd></div> : null}
            </dl>
          ) : null}
          {scheduleError ? <p className="schedule-error" role="alert">{scheduleError}</p> : null}
        </section>

        <section className="settings-card accent-card">
          <div className="settings-card-header">
            <span className="settings-icon" aria-hidden="true">A</span>
            <div>
              <h2>Appearance</h2>
            </div>
          </div>
          <div className="color-picker-grid">
            <label className="color-picker-field">
              <span>Accent color</span>
              <span className="color-picker-control">
                <input type="color" value={accentColor} onChange={(event) => setAccentColor(event.target.value)} />
                <output>{accentColor}</output>
              </span>
            </label>
            <label className="color-picker-field">
              <span>App background</span>
              <span className="color-picker-control">
                <input type="color" value={backgroundColor} onChange={(event) => setBackgroundColor(event.target.value)} />
                <output>{backgroundColor}</output>
              </span>
            </label>
          </div>
        </section>

        <section className="settings-card run-card">
          <div className="settings-card-header">
            <span className="settings-icon" aria-hidden="true">
              ↻
            </span>
            <div>
              <h2>Latest source discovery</h2>
              <p>
                {latestRunDescription}
                {latestRunError ? ` · ${latestRunError}` : ""}
              </p>
            </div>
            <span className={`run-state run-state-${latestRunTone}`}>
              <StatusDot state={latestRunTone} />
              {latestRunStateLabel}
            </span>
          </div>
          <div className="run-metrics">
            <span>
              <b>{data.run.state === "running"
                ? "In progress"
                : formatRunDuration(data.run.durationSeconds)}</b>
              total duration
            </span>
            <span>
              <b>{run.discoveredListings?.toLocaleString() ?? "—"}</b>
              listings scraped
            </span>
            <span>
              <b>{data.run.newListings}</b>
              new this run
            </span>
            <span>
              <b>{data.run.currentNewListings}</b>
              current New
            </span>
            <span>
              <b>{data.run.seenListings.toLocaleString()}</b>
              already seen
            </span>
            <span>
              <b>{data.run.excludedByDistance}</b>
              distance excluded
            </span>
          </div>
          {stages.length ? (
            <ol className="pipeline-list">
              {stages.map((stage) => (
                <li key={stage.id} className={`stage-${stage.status}`}>
                  <span aria-hidden="true">{stage.status === "passed" ? "✓" : stage.status === "failed" ? "×" : "·"}</span>
                  <p>
                    <strong>{stage.label}</strong>
                    {stage.detail ? <small>{stage.detail}</small> : null}
                  </p>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      </div>

      <section className="source-status-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Adapters</p>
            <h2>Source status</h2>
          </div>
        </div>
        <div className="source-table" role="table" aria-label="Auction source status">
          <div className="source-table-row source-table-head" role="row">
            <span role="columnheader">Source</span>
            <span role="columnheader">Enabled</span>
            <span role="columnheader">Latest run</span>
            <span role="columnheader">Coverage</span>
          </div>
          {data.sources.map((source) => (
            <div className="source-table-row" role="row" key={source.name}>
              <span role="cell" className="source-name-status">
                <SourceBadge source={source.name} />
                <small title={source.detail}>{source.detail}</small>
                {source.errorMessage ? (
                  <small className="source-error-detail" title={source.errorMessage}>
                    {source.errorMessage}
                  </small>
                ) : null}
              </span>
              <span role="cell">
                <button
                  type="button"
                  className={`source-switch ${source.enabled ? "is-on" : ""}`}
                  role="switch"
                  aria-checked={source.enabled}
                  aria-label={`${source.name} source`}
                  disabled={!source.canEnable || running || togglingSourceId === source.id}
                  title={source.canEnable
                    ? source.enabled ? `Disable ${source.name}` : `Enable ${source.name}`
                    : `${source.name} is unavailable`}
                  onClick={() => void toggleSource(source.id, !source.enabled)}
                >
                  <span />
                </button>
              </span>
              <span role="cell" className="source-run-timing">
                {source.lastRun ? (
                  <>
                    <span>{formatRelative(source.lastRun)}</span>
                    <small>{source.state === "running"
                      ? "In progress"
                      : formatRunDuration(source.durationSeconds)}</small>
                  </>
                ) : "Not run"}
              </span>
              <span role="cell" className="source-coverage">
                <strong>
                  {source.coverage.catalog.toLocaleString()} catalog
                  <small>latest {source.discovered.toLocaleString()}</small>
                </strong>
                <small>
                  Proximity scope {source.coverage.proximityScope.toLocaleString()}/{source.coverage.catalog.toLocaleString()}
                  {" \u00b7 "}
                  complete {source.coverage.distanceComplete.toLocaleString()}/{source.coverage.proximityScope.toLocaleString()}
                  {(source.coverage.unknownLocations ?? 0) > 0
                    ? ` \u00b7 ${(source.coverage.unknownLocations ?? 0).toLocaleString()} location unknown`
                    : ""}
                  {source.coverage.routeErrors > 0
                    ? ` \u00b7 ${source.coverage.routeErrors.toLocaleString()} proximity error`
                    : ""}
                </small>
                <small>
                  Review {source.coverage.review.toLocaleString()}
                  {" \u00b7 "}
                  images {source.coverage.localPrimaryImages.toLocaleString()}/{source.coverage.imageBearing.toLocaleString()}
                  {source.coverage.imageFailures > 0
                    ? ` (${source.coverage.imageFailures.toLocaleString()} failed)`
                    : ""}
                  {" \u00b7 "}
                  prepared {source.coverage.enrichmentReady.toLocaleString()}/{source.coverage.review.toLocaleString()}
                  {" \u00b7 "}
                  voted {source.coverage.voted.toLocaleString()}/{source.coverage.review.toLocaleString()}
                </small>
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AttributeList({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="attribute-list">
      <dt>{label}</dt>
      <dd>
        {values.map((value) => (
          <span key={value}>{value}</span>
        ))}
      </dd>
    </div>
  );
}

function DetailPanel({
  listing,
  close,
  vote,
  saving,
  saveLotDecision,
  savingLot,
}: {
  listing: Listing;
  close: () => void;
  vote: (vote: Exclude<Vote, null>) => void;
  saving: boolean;
  saveLotDecision: (decision: ManualLotFeedbackDecision) => void;
  savingLot: boolean;
}) {
  const [activeImage, setActiveImage] = useState(listing.primaryImageUrl);
  const panelRef = useRef<HTMLElement>(null);
  const enriched = hasTextEnrichment(listing);
  const distance = listingDistancePresentation(listing);
  const lotType = explicitLotType(listing);
  const selectedLotDecision = effectiveLotFeedbackDecision(listing);
  const detailPrice = listingCardPrice(listing);
  const profileScore = listingRecommendationDisplayScore(listing);
  const publisherHistoryOnly = listingIsPublisherHistoryOnly(listing);

  const trapFocus = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="detail-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <aside
        ref={panelRef}
        className="detail-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="detail-title"
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <div className="detail-toolbar">
          <div className="detail-toolbar-tags">
            <SourceBadge source={listing.source} />
            {publisherHistoryOnly ? <span className="flag">Source history</span> : null}
            {isNewUnvotedListing(listing) ? <span className="flag flag-new">New</span> : null}
            {lotType && isLot(lotType) ? <span className="flag flag-lot">Lot</span> : null}
          </div>
          <div>
            <button type="button" onClick={close} aria-label="Close listing detail" autoFocus>
              ×
            </button>
          </div>
        </div>

        <div className="detail-scroll">
          <div className="detail-image-area">
            <Photo src={activeImage} alt={listing.title} className="detail-main-photo" />
            {listing.galleryImageUrls.length > 1 ? (
              <div className="detail-thumbnails" aria-label="Listing images">
                {listing.galleryImageUrls.map((url, index) => (
                  <button
                    key={url}
                    type="button"
                    className={activeImage === url ? "is-active" : ""}
                    onClick={() => setActiveImage(url)}
                    aria-label={`Show listing image ${index + 1}`}
                  >
                    <Photo src={url} alt="" />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="detail-source-row">
            {listingSourceLinkItems(listing).map((link) => (
              <a
                key={link.key}
                href={link.href}
                target="_blank"
                rel="noreferrer"
              >
                {link.label} <span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>

          <div className="detail-body">
            <h2 id="detail-title">{listing.title}</h2>
            <p className="detail-summary">{listingSummary(listing)}</p>

            <VoteControl
              vote={listing.vote}
              onVote={vote}
              disabled={saving || savingLot || publisherHistoryOnly || listing.voteReady === false}
              disabledReason={publisherHistoryOnly
                ? "This canonical owner vote is shown in reviewed source history."
                : listing.voteReady === false
                  ? "Voting unlocks when this listing is ready for review."
                  : undefined}
            />

            <dl className="detail-facts">
              <div>
                <dt>{detailPrice.label}</dt>
                <dd>{detailPrice.value}</dd>
              </div>
              <div>
                <dt>{actionDeadlineLabel(listing)}</dt>
                <dd>{formatListingClosing(listing)}</dd>
                {listing.actionDeadline?.basis === "live_auction_start" ? (
                  <small>
                    {`${formatDate(listing.actionDeadline.at)} local · be ready to bid at this time`}
                  </small>
                ) : (
                  <small>
                    {listing.closesAt
                    ? /^\d{4}-\d{2}-\d{2}$/.test(listing.closesAt)
                      ? "The source supplied a closing date without a time"
                      : `${formatDate(listing.closesAt)} local`
                    : "The source did not supply a closing time"}
                  </small>
                )}
              </div>
              <div>
                <dt>Pickup</dt>
                <dd>
                  {listing.pickupLocation.city}, {listing.pickupLocation.state} {listing.pickupLocation.postalCode}
                </dd>
                <small>Pickup location, not seller address</small>
              </div>
              <div>
                <dt>Estimated one-way drive</dt>
                <dd>{distance.value}</dd>
                {distance.detail ? <small>{distance.detail}</small> : null}
              </div>
            </dl>

            {enriched ? <section className="detail-section">
              <div className="detail-section-heading">
                <div>
                  <h3>Important item details</h3>
                </div>
              </div>
              <dl className="attribute-grid">
                <AttributeList
                  label={listing.attributes.manufacturers.length === 1 ? "Manufacturer" : "Manufacturers"}
                  values={listing.attributes.manufacturers.length > 0
                    ? listing.attributes.manufacturers
                    : ["Unknown"]}
                />
                <AttributeList label="Models" values={listing.attributes.modelNumbers} />
                <AttributeList label="Asset classes" values={listing.attributes.assetClasses} />
                <div className="attribute-list">
                  <dt>Condition</dt>
                  <dd>
                    <span>{listing.attributes.condition.replaceAll("_", " ")}</span>
                    <span>{listing.attributes.testedStatus.replaceAll("_", " ")}</span>
                  </dd>
                </div>
                <AttributeList label="Included" values={listing.attributes.includedItems} />
                <AttributeList label="Missing" values={listing.attributes.missingItems} />
                <AttributeList label="Value signals" values={listing.attributes.highValueSignals} />
                <AttributeList label="Negative signals" values={listing.attributes.negativeSignals} />
                <AttributeList label="Safety flags" values={listing.attributes.safetyFlags} />
              </dl>
              <p className="ai-provenance">
                {listing.aiMeta.provider} · {listing.aiMeta.model} · {listing.aiMeta.promptVersion} · generated {formatRelative(listing.aiMeta.generatedAt)}
              </p>
            </section> : null}

            <section className="detail-section lot-feedback-section">
              <div className="detail-section-heading">
                <div>
                  <h3>Lot classification</h3>
                </div>
              </div>
              <div className="lot-feedback-options" role="group" aria-label="Correct lot classification">
                {([
                  ["lot", "Lot"],
                  ["not_lot", "Not a lot"],
                ] as const).map(([decision, label]) => (
                  <button
                    key={decision}
                    type="button"
                    className={selectedLotDecision === decision ? "is-selected" : ""}
                    aria-pressed={selectedLotDecision === decision}
                    disabled={savingLot || saving}
                    onClick={() => saveLotDecision(decision)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </section>

            <section
              className="recommendation-box"
              aria-labelledby="recommendation-explanation-heading"
            >
              <span className="recommendation-icon" aria-hidden="true">
                {profileScore ?? "—"}
              </span>
              <div>
                <h3 id="recommendation-explanation-heading" className="eyebrow">
                  Score
                </h3>
                {profileScore === null ? (
                  <p>
                    Unrated. No preference scorer is installed.
                  </p>
                ) : (
                  <p>
                    <strong>{profileScore} out of 100.</strong> Higher scores mean a stronger predicted Interest.
                  </p>
                )}
              </div>
            </section>

            

            <section className="detail-section description-section">
              <div className="detail-section-heading">
                <div>
                  <h3>Source text</h3>
                </div>
              </div>
              <p>{listing.cleanDescription}</p>
            </section>

            <footer className="detail-record-footer">
              <span>
                First seen <b>{formatRelative(listing.firstSeenAt)}</b>
              </span>
              <span>
                Source ID <b>{listing.sourceListingId}</b>
              </span>
            </footer>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Toast({ message }: { message: string }) {
  return (
    <div className="toast" role="status">
      <span aria-hidden="true">•</span>
      {message}
    </div>
  );
}

export function AuctionDashboard({
  appName = "Auction Discovery",
  originPostalCode = "90210",
  textProvider = "",
  textModel = "",
  embeddingModel = "",
  initialAccent = DEFAULT_ACCENT_COLOR,
  initialBackground = DEFAULT_BACKGROUND_COLOR,
}: {
  appName?: string;
  originPostalCode?: string;
  textProvider?: string;
  textModel?: string;
  embeddingModel?: string;
  initialAccent?: string;
  initialBackground?: string;
}) {
  const [view, setView] = useState<AppView>("discover");
  const [data, setData] = useState<DashboardPayload>(emptyDashboard);
  const [ollamaHealth, setOllamaHealth] = useState<OllamaHealth | null>(null);
  const [dataMode, setDataMode] = useState<DataMode>("loading");
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardDegraded, setDashboardDegraded] = useState(false);
  const [dashboardRetryExhausted, setDashboardRetryExhausted] = useState(false);
  const [dashboardRefreshInProgress, setDashboardRefreshInProgress] = useState(false);
  const [reviewedListingsState, setReviewedListingsState] =
    useState<ReviewedListingLoadState>("idle");
  const [reviewedListingsError, setReviewedListingsError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [scoreRangeStorageReady, setScoreRangeStorageReady] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedListingSnapshot, setSelectedListingSnapshot] =
    useState<Listing | null>(null);
  const [savingVote, setSavingVote] = useState<string | null>(null);
  const [bulkVoting, setBulkVoting] = useState(false);
  const [voteHistory, setVoteHistory] = useState<readonly VoteTransition[]>([]);
  const [undoingVote, setUndoingVote] = useState(false);
  const [savingLot, setSavingLot] = useState<string | null>(null);
  const [savingSignals, setSavingSignals] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [running, setRunning] = useState(false);
  const [nightlyStatus, setNightlyStatus] = useState<LocalNightlyRunStatus | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [togglingSourceId, setTogglingSourceId] = useState<string | null>(null);
  const detailTriggerRef = useRef<HTMLElement | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const detailSessionRef = useRef(0);
  const hydratedListingDetailsRef = useRef(new Set<string>());
  const dashboardRequestGenerationRef = useRef(0);
  const scopedDashboardCacheRef = useRef(new Map<
    DashboardListingScope,
    { generation: number; payload: DashboardPayload }
  >());
  const scopedDashboardRequestRef = useRef<{
    generation: number;
    scope: DashboardListingScope;
    promise: Promise<boolean>;
  } | null>(null);
  const voteMutationRef = useRef(false);
  const lotMutationRef = useRef(false);
  const observedNightlyRunRef = useRef<string | null>(null);
  const observedNightlyStartedAtRef = useRef<string | null>(null);
  const handledNightlyTerminalRef = useRef<string | null>(null);
  const dashboardRefreshRequestRef = useRef<{
    generation: number;
    scope: DashboardListingScope;
    promise: Promise<boolean>;
  } | null>(null);
  const dashboardMutationEpochRef = useRef(0);
  const runStartMutationRef = useRef(false);
  const [accentColor, setAccentColor] = useState(() =>
    normalizeHexColor(initialAccent, DEFAULT_ACCENT_COLOR)
  );
  const [backgroundColor, setBackgroundColor] = useState(() =>
    normalizeHexColor(initialBackground, DEFAULT_BACKGROUND_COLOR)
  );
  const [origin, setOrigin] = useState(() => {
    if (typeof window === "undefined") return originPostalCode;
    try {
      return window.localStorage.getItem(LOCAL_ORIGIN_KEY) || originPostalCode;
    } catch {
      return originPostalCode;
    }
  });
  const updateDiscoverFilters = useCallback((nextFilters: FilterState) => {
    if (nextFilters.vote !== filters.vote) {
      setReviewedListingsState("idle");
      setReviewedListingsError(null);
    }
    setFilters(nextFilters);
  }, [filters.vote]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const stored = window.localStorage.getItem(LOCAL_SCORE_RANGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored) as { min?: unknown; max?: unknown };
          const storedMinimum = normalizeScoreBound(
            typeof parsed.min === "string" ? parsed.min : "",
          );
          const storedMaximum = normalizeScoreBound(
            typeof parsed.max === "string" ? parsed.max : "",
          );
          setFilters((current) => ({
            ...current,
            scoreMin: storedMinimum || DEFAULT_FILTERS.scoreMin,
            scoreMax: storedMaximum || DEFAULT_FILTERS.scoreMax,
          }));
        }
      } catch {
        // Invalid or unavailable browser storage leaves the filter disabled.
      } finally {
        setScoreRangeStorageReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!scoreRangeStorageReady) return;
    try {
      if (!hasCustomScoreRange({
        scoreMin: filters.scoreMin,
        scoreMax: filters.scoreMax,
      })) {
        window.localStorage.removeItem(LOCAL_SCORE_RANGE_KEY);
      } else {
        window.localStorage.setItem(LOCAL_SCORE_RANGE_KEY, JSON.stringify({
          min: filters.scoreMin,
          max: filters.scoreMax,
        }));
      }
    } catch {
      // The active in-memory filter remains usable when browser storage is unavailable.
    }
  }, [filters.scoreMax, filters.scoreMin, scoreRangeStorageReady]);

  const selectedListing =
    (selectedListingSnapshot?.id === selectedId ? selectedListingSnapshot : null) ??
    data.listings.find((listing) => listing.id === selectedId) ??
    null;
  const fallbackReferenceTime = data.run.lastCompletedAt
    ? dateValue(data.run.lastCompletedAt)
    : 0;
  const referenceTime = useViewerReferenceTime(data.listings, fallbackReferenceTime);
  const unvotedListingCount = data.run.currentUnvotedListings;
  const discoveryActive = running || nightlyStatus?.active === true || data.run.state === "running";

  const applyDashboardPayload = useCallback((
    payload: DashboardPayload,
    options: { preserveUiState?: boolean } = {},
  ) => {
    const preserveUiState = options.preserveUiState === true;
    const hydratedListingIds = preserveUiState
      ? new Set(hydratedListingDetailsRef.current)
      : new Set<string>();
    if (!preserveUiState) hydratedListingDetailsRef.current.clear();
    setSelectedListingSnapshot((current) => {
      if (!current) return current;
      const refreshed = payload.listings.find((listing) => listing.id === current.id);
      if (!refreshed) return preserveUiState ? current : null;
      if (!hydratedListingIds.has(current.id)) return refreshed;
      return {
        ...refreshed,
        cleanDescription: current.cleanDescription,
        rawDescription: current.rawDescription,
        galleryImageUrls: current.galleryImageUrls,
        images: current.images,
      };
    });
    setData((current) => {
      if (!preserveUiState) return payload;
      const currentById = new Map(
        current.listings.map((listing) => [listing.id, listing] as const),
      );
      return {
        ...payload,
        run: payload.listingScope === "unvoted"
          ? payload.run
          : {
              ...payload.run,
              currentNewListings: current.run.currentNewListings,
              currentUnvotedListings: current.run.currentUnvotedListings,
            },
        listings: payload.listings.map((listing) => {
          if (!hydratedListingIds.has(listing.id)) return listing;
          const currentListing = currentById.get(listing.id);
          if (!currentListing) return listing;
          return {
            ...listing,
            cleanDescription: currentListing.cleanDescription,
            rawDescription: currentListing.rawDescription,
            galleryImageUrls: currentListing.galleryImageUrls,
            images: currentListing.images,
          };
        }),
      };
    });
    const payloadRefreshRequired = (payload.run as RunWithPresentation).refreshRequired;
    if (!preserveUiState) {
      if (typeof payloadRefreshRequired === "boolean") {
        setRefreshRequired(payloadRefreshRequired);
      }
      setOrigin(payload.originPostalCode);
      try {
        window.localStorage.setItem(LOCAL_ORIGIN_KEY, payload.originPostalCode);
      } catch {
        // The server remains authoritative when browser storage is unavailable.
      }
    }
    setDataMode("api");
    setDashboardError(null);
    setDashboardDegraded(false);
    setDashboardRetryExhausted(false);
  }, []);

  const invalidateDashboardRequests = useCallback(() => {
    dashboardRequestGenerationRef.current += 1;
    scopedDashboardCacheRef.current.clear();
    scopedDashboardRequestRef.current = null;
  }, []);

  const markDashboardMutation = useCallback(() => {
    dashboardMutationEpochRef.current += 1;
    scopedDashboardCacheRef.current.clear();
  }, []);

  const refreshDashboard = useCallback(async (
    options: {
      preserveUiState?: boolean;
      requireFreshAfterCurrent?: boolean;
      requireMutationIdle?: boolean;
    } = {},
  ): Promise<boolean> => {
    const requiredGeneration = options.requireFreshAfterCurrent === true
      ? dashboardRequestGenerationRef.current + 1
      : null;
    while (dashboardRefreshRequestRef.current !== null) {
      const activeRequest = dashboardRefreshRequestRef.current;
      if (
        activeRequest.scope === "unvoted" && (
          requiredGeneration === null ||
          activeRequest.generation >= requiredGeneration
        )
      ) return activeRequest.promise;
      await activeRequest.promise;
    }
    if (
      options.requireMutationIdle === true &&
      (voteMutationRef.current || lotMutationRef.current || runStartMutationRef.current)
    ) return false;

    const preserveUiState = options.preserveUiState === true;
    const generation = dashboardRequestGenerationRef.current + 1;
    const mutationEpoch = dashboardMutationEpochRef.current;
    dashboardRequestGenerationRef.current = generation;
    scopedDashboardCacheRef.current.clear();
    scopedDashboardRequestRef.current = null;
    if (!preserveUiState) {
      setReviewedListingsState("idle");
      setReviewedListingsError(null);
    }
    setDashboardRefreshInProgress(true);

    const request = (async (): Promise<boolean> => {
      let failureCount = 0;
      for (;;) {
        try {
          const payload = await loadDashboard();
          if (
            generation !== dashboardRequestGenerationRef.current ||
            mutationEpoch !== dashboardMutationEpochRef.current
          ) return false;
          applyDashboardPayload(payload, { preserveUiState });
          return true;
        } catch (error) {
          if (
            generation !== dashboardRequestGenerationRef.current ||
            mutationEpoch !== dashboardMutationEpochRef.current
          ) return false;
          const decision = dashboardRefreshRetryDecision(failureCount, error);
          failureCount = decision.failureCount;
          setDashboardDegraded(true);
          setDashboardRetryExhausted(decision.exhausted);
          setDashboardError(
            error instanceof Error
              ? error.message
              : "The local dashboard request failed",
          );
          if (!decision.retry || decision.delayMs === null) {
            setDataMode((current) => current === "api" ? current : "error");
            return false;
          }
          await waitForDashboardRefreshRetry(decision.delayMs);
          if (
            generation !== dashboardRequestGenerationRef.current ||
            mutationEpoch !== dashboardMutationEpochRef.current
          ) return false;
        }
      }
    })();
    dashboardRefreshRequestRef.current = { generation, scope: "unvoted", promise: request };
    try {
      return await request;
    } finally {
      if (dashboardRefreshRequestRef.current?.promise === request) {
        dashboardRefreshRequestRef.current = null;
        setDashboardRefreshInProgress(false);
      }
    }
  }, [applyDashboardPayload]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | null = null;

    const pollNightly = async (): Promise<void> => {
      let nextDelayMs = 10_000;
      try {
        const status = await loadLocalNightlyRun();
        if (cancelled) return;
        setNightlyStatus(status);
        if (status.active) {
          nextDelayMs = 3_000;
          const identity = localNightlyRunIdentity(status);
          if (identity) {
            observedNightlyRunRef.current = identity;
            observedNightlyStartedAtRef.current ??=
              status.workflowStartedAt ?? status.createdAt;
          }
          setRunning(true);
        } else {
          const observedRunId = observedNightlyRunRef.current;
          const observedStartedAt = Date.parse(observedNightlyStartedAtRef.current ?? "");
          const workflowTerminalAt = Date.parse(
            status.workflowEndedAt ?? status.workflowUpdatedAt ?? "",
          );
          const terminalIdentity = localNightlyRunIdentity(status);
          const durableTerminalMatches = status.id === null &&
            status.workflowEndedAt !== null &&
            Number.isFinite(workflowTerminalAt) &&
            (!Number.isFinite(observedStartedAt) || workflowTerminalAt >= observedStartedAt);
          if (
            observedRunId &&
            (terminalIdentity === observedRunId || durableTerminalMatches) &&
            handledNightlyTerminalRef.current !== observedRunId
          ) {
            setRunning(false);
            if (voteMutationRef.current || lotMutationRef.current || runStartMutationRef.current) {
              nextDelayMs = 1_000;
              return;
            }
            invalidateDashboardRequests();
            const refreshed = await refreshDashboard({
              requireFreshAfterCurrent: true,
              requireMutationIdle: true,
            });
            if (cancelled) return;
            if (!refreshed) {
              nextDelayMs = 3_000;
              return;
            }
            handledNightlyTerminalRef.current = observedRunId;
            observedNightlyRunRef.current = null;
            observedNightlyStartedAtRef.current = null;
            const unrecordedExit = status.state === "exited-unrecorded"
              ? "The visible nightly runner exited before recording completion"
              : null;
            const failure = status.workflowError || status.lastError || unrecordedExit;
            const failed = (status.state !== "completed" && status.state !== "idle") ||
              (status.exitCode !== null && status.exitCode !== 0) ||
              Boolean(failure);
            const failureEndedAt = status.workflowEndedAt ?? status.endedAt ??
              status.workflowUpdatedAt ?? status.updatedAt;
            const progress = !nightlyEnrichmentStage(status.stage) &&
                status.progressCompleted !== null && status.progressTotal !== null
              ? ` after ${status.progressCompleted}/${status.progressTotal} scheduled work units`
              : "";
            const checkpointPaused = !failed &&
              status.workflowState === "checkpoint_paused";
            const maintenanceDeferred = !failed &&
              status.workflowState === "core_complete_maintenance_deferred";
            setToast(failed
              ? `Discovery failed${failureEndedAt ? ` ${formatDateTime(failureEndedAt)}` : ""}`
              : checkpointPaused
              ? `Discovery paused at a durable checkpoint${progress}`
              : maintenanceDeferred
              ? `Discovery stopped; ${status.maintenanceProgress.remaining?.toLocaleString() ?? "unknown"} ranking maintenance items remain`
              : `Discovery completed${progress}`);
          }
        }
      } catch {
        // The ordinary dashboard remains usable if the optional local companion is offline.
      } finally {
        if (!cancelled) {
          pollTimer = window.setTimeout(() => void pollNightly(), nextDelayMs);
        }
      }
    };

    void pollNightly();
    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [invalidateDashboardRequests, refreshDashboard]);

  useEffect(() => {
    if (!discoveryActive) return;
    let cancelled = false;
    let refreshTimer: number | null = null;

    const scheduleRefresh = () => {
      if (cancelled) return;
      refreshTimer = window.setTimeout(() => {
        void refreshWhileRunning();
      }, DISCOVERY_DASHBOARD_REFRESH_INTERVAL_MS);
    };
    const refreshWhileRunning = async (): Promise<void> => {
      if (cancelled) return;
      if (
        document.visibilityState === "visible" &&
        data.listingScope === "unvoted" &&
        dashboardRefreshRequestRef.current === null &&
        !voteMutationRef.current &&
        !lotMutationRef.current &&
        !runStartMutationRef.current
      ) {
        await refreshDashboard({ preserveUiState: true });
      }
      scheduleRefresh();
    };

    scheduleRefresh();
    return () => {
      cancelled = true;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [data.listingScope, discoveryActive, refreshDashboard]);

  const loadReviewedListings = useCallback(async (
    scope: Exclude<DashboardListingScope, "unvoted">,
  ): Promise<boolean> => {
    while (dashboardRefreshRequestRef.current !== null) {
      const activeDashboardRequest = dashboardRefreshRequestRef.current;
      if (
        activeDashboardRequest.scope === scope &&
        activeDashboardRequest.generation === dashboardRequestGenerationRef.current
      ) return activeDashboardRequest.promise;
      await activeDashboardRequest.promise;
    }
    if (
      voteMutationRef.current || lotMutationRef.current ||
      runStartMutationRef.current
    ) {
      setReviewedListingsState("idle");
      return false;
    }

    const generation = dashboardRequestGenerationRef.current;
    const mutationEpoch = dashboardMutationEpochRef.current;
    const cached = scopedDashboardCacheRef.current.get(scope);
    if (cached?.generation === generation) {
      applyDashboardPayload(cached.payload, { preserveUiState: true });
      setReviewedListingsState("idle");
      setReviewedListingsError(null);
      return Promise.resolve(true);
    }
    const activeRequest = scopedDashboardRequestRef.current;
    if (
      activeRequest?.scope === scope &&
      activeRequest.generation === generation
    ) return activeRequest.promise;

    setReviewedListingsState("loading");
    setReviewedListingsError(null);
    const request = (async (): Promise<boolean> => {
      try {
        const payload = await loadDashboard(scope);
        if (
          generation !== dashboardRequestGenerationRef.current ||
          mutationEpoch !== dashboardMutationEpochRef.current
        ) {
          setReviewedListingsState("idle");
          setReviewedListingsError(null);
          return false;
        }
        scopedDashboardCacheRef.current.set(scope, { generation, payload });
        applyDashboardPayload(payload, { preserveUiState: true });
        setReviewedListingsState("idle");
        setReviewedListingsError(null);
        return true;
      } catch (error) {
        if (
          generation !== dashboardRequestGenerationRef.current ||
          mutationEpoch !== dashboardMutationEpochRef.current
        ) {
          setReviewedListingsState("idle");
          setReviewedListingsError(null);
          return false;
        }
        setReviewedListingsState("error");
        setReviewedListingsError(
          error instanceof Error
            ? error.message
            : "The reviewed listing history could not be loaded",
        );
        return false;
      }
    })();
    scopedDashboardRequestRef.current = { generation, scope, promise: request };
    dashboardRefreshRequestRef.current = { generation, scope, promise: request };
    try {
      return await request;
    } finally {
      if (scopedDashboardRequestRef.current?.promise === request) {
        scopedDashboardRequestRef.current = null;
      }
      if (dashboardRefreshRequestRef.current?.promise === request) {
        dashboardRefreshRequestRef.current = null;
      }
    }
  }, [applyDashboardPayload]);

  const closeListing = useCallback((expectedListingId?: string) => {
    if (expectedListingId && selectedIdRef.current !== expectedListingId) return;
    const closingSession = detailSessionRef.current;
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedListingSnapshot(null);
    window.setTimeout(() => {
      if (
        detailSessionRef.current === closingSession
        && selectedIdRef.current === null
      ) {
        detailTriggerRef.current?.focus();
      }
    }, 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const cached = await readCachedDashboardPayload();
        if (cancelled) return;
        if (cached) {
          applyDashboardPayload(cached);
        }
        if (!cancelled) await refreshDashboard();
      })();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [applyDashboardPayload, refreshDashboard]);

  useEffect(() => {
    if (dataMode !== "api" || data.listingScope !== "unvoted") return;
    void writeCachedDashboardPayload(data);
  }, [data, dataMode]);

  useEffect(() => {
    const requestedListingScope = listingScopeForVoteFilter(filters.vote);
    if (
      data.listingScope === requestedListingScope ||
      dataMode !== "api" ||
      dashboardRefreshInProgress ||
      savingVote !== null || bulkVoting || undoingVote || savingLot !== null ||
      reviewedListingsState !== "idle"
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (requestedListingScope === "unvoted") {
        void refreshDashboard({ preserveUiState: true });
      } else {
        void loadReviewedListings(requestedListingScope);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    dashboardRefreshInProgress,
    data.listingScope,
    dataMode,
    filters.vote,
    loadReviewedListings,
    refreshDashboard,
    reviewedListingsState,
    bulkVoting,
    savingLot,
    savingVote,
    undoingVote,
  ]);

  useEffect(() => {
    if (view !== "settings" || !textProvider || !textModel || !embeddingModel) return;
    let active = true;
    void loadOllamaHealth()
      .then((health) => {
        if (active) setOllamaHealth(health);
      })
      .catch((error) => {
        if (!active) return;
        setOllamaHealth({
          reachable: false,
          textModelAvailable: false,
          embeddingModelAvailable: false,
          latencyMs: null,
          checkedAt: new Date().toISOString(),
          message: error instanceof Error ? error.message : "Ollama health check failed",
        });
      });
    return () => {
      active = false;
    };
  }, [view, textProvider, textModel, embeddingModel]);

  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeListing(selectedId);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [closeListing, selectedId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const openListing = (listing: Listing) => {
    detailTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    detailSessionRef.current += 1;
    selectedIdRef.current = listing.id;
    setSelectedId(listing.id);
    setSelectedListingSnapshot(listing);
    if (hydratedListingDetailsRef.current.has(listing.id)) return;
    hydratedListingDetailsRef.current.add(listing.id);
    void loadListingDetail(listing.id)
      .then((detail) => {
        const hydrated = {
          cleanDescription: detail.cleanDescription,
          rawDescription: detail.rawDescription,
          galleryImageUrls: detail.galleryImageUrls,
          images: detail.images,
        };
        setSelectedListingSnapshot((current) =>
          current?.id === listing.id ? { ...current, ...hydrated } : current
        );
        setData((current) => ({
          ...current,
          listings: current.listings.map((item) =>
            item.id === listing.id
              ? {
                  ...item,
                  ...hydrated,
                }
              : item,
          ),
        }));
      })
      .catch(() => {
        // The already-rendered card detail remains useful; a later open retries
        // the bounded local detail request.
        hydratedListingDetailsRef.current.delete(listing.id);
      });
  };

  const handleAccentChange = (value: string) => {
    const nextAccent = normalizeHexColor(value, DEFAULT_ACCENT_COLOR);
    setAccentColor(nextAccent);
    document.cookie = `${ACCENT_COOKIE_NAME}=${nextAccent.slice(1)}; Max-Age=31536000; Path=/; SameSite=Lax`;
    try {
      window.localStorage.setItem(LOCAL_ACCENT_KEY, nextAccent);
    } catch {
      // The selection remains active for this session when storage is unavailable.
    }
  };

  const handleBackgroundChange = (value: string) => {
    const nextBackground = normalizeHexColor(value, DEFAULT_BACKGROUND_COLOR);
    setBackgroundColor(nextBackground);
    document.cookie = `${BACKGROUND_COOKIE_NAME}=${nextBackground.slice(1)}; Max-Age=31536000; Path=/; SameSite=Lax`;
    try {
      window.localStorage.setItem(LOCAL_BACKGROUND_KEY, nextBackground);
    } catch {
      // The selection remains active for this session when storage is unavailable.
    }
  };

  const handleVote = async (
    listing: Listing,
    nextVote: Exclude<Vote, null>,
  ): Promise<boolean> => {
    if (voteMutationRef.current || lotMutationRef.current) return false;
    const currentListing = data.listings.find((item) => item.id === listing.id);
    const previousVote = currentListing ? currentListing.vote : listing.vote;
    const transition: VoteTransition = {
      listingId: listing.id,
      previousVote,
      nextVote,
    };
    voteMutationRef.current = true;
    markDashboardMutation();
    setSavingVote(listing.id);
    setData((current) => ({
      ...current,
      run: adjustCurrentUnvotedCount(current.run, previousVote, nextVote),
      listings: current.listings.map((item) =>
        item.id === listing.id ? { ...item, vote: nextVote } : item,
      ),
    }));

    try {
      const result = await saveVote(listing.id, nextVote);
      if (!result.persisted) {
        setData((current) => ({
          ...current,
          run: adjustCurrentUnvotedCount(current.run, nextVote, previousVote),
          listings: current.listings.map((item) =>
            item.id === listing.id ? { ...item, vote: previousVote } : item,
          ),
        }));
        setToast(
          `Vote could not be saved${
            result.errorMessage ? `: ${result.errorMessage}` : ""
          }; the previous state was restored`,
        );
        return false;
      }
      setVoteHistory((current) => recordVoteTransition(current, transition));
      setToast("Vote saved to the local system");
      return true;
    } finally {
      voteMutationRef.current = false;
      setSavingVote(null);
    }
  };

  const handleDetailVote = async (
    listing: Listing,
    nextVote: Exclude<Vote, null>,
  ) => {
    if (await handleVote(listing, nextVote)) closeListing(listing.id);
  };

  const handleBulkNotInterested = async (listingIds: readonly string[]) => {
    if (
      listingIds.length === 0 || voteMutationRef.current ||
      lotMutationRef.current
    ) return;
    const frozenListingIds = [...new Set(listingIds)];
    voteMutationRef.current = true;
    markDashboardMutation();
    setBulkVoting(true);
    try {
      const result = await saveBulkNotInterestedVotes(frozenListingIds);
      if (!result.persisted || !result.response) {
        setToast(
          `Visible votes could not be saved${
            result.errorMessage ? `: ${result.errorMessage}` : ""
          }`,
        );
        return;
      }

      const changedCanonicalIds = new Set(
        result.response.changedCanonicalListingIds,
      );
      const savedListingIds = new Set<string>(changedCanonicalIds);
      let alreadySaved = 0;
      let skipped = 0;
      for (const outcome of result.response.outcomes) {
        if (
          outcome.vote === "not_interested" &&
          (outcome.status === "changed" ||
            outcome.status === "unchanged_not_interested")
        ) {
          savedListingIds.add(outcome.listingId);
          if (outcome.canonicalListingId) {
            savedListingIds.add(outcome.canonicalListingId);
          }
          if (outcome.status === "unchanged_not_interested") alreadySaved += 1;
        } else {
          skipped += 1;
        }
      }
      setData((current) => ({
        ...current,
        run: {
          ...current.run,
          currentUnvotedListings: Math.max(
            0,
            current.run.currentUnvotedListings - changedCanonicalIds.size,
          ),
        },
        listings: current.listings.map((listing) =>
          savedListingIds.has(listing.id)
            ? { ...listing, vote: "not_interested" }
            : listing
        ),
      }));

      const messages = [
        `Marked ${changedCanonicalIds.size.toLocaleString()} visible ${
          changedCanonicalIds.size === 1 ? "listing" : "listings"
        } Not interested`,
      ];
      if (alreadySaved > 0) {
        messages.push(`${alreadySaved.toLocaleString()} already saved`);
      }
      if (skipped > 0) messages.push(`${skipped.toLocaleString()} skipped`);
      setToast(messages.join("; "));
    } finally {
      voteMutationRef.current = false;
      setBulkVoting(false);
    }
  };

  const handleUndoVote = async () => {
    if (voteMutationRef.current || lotMutationRef.current) return;
    const preparedUndo = prepareVoteUndo(
      voteHistory,
      new Map(data.listings.map((item) => [item.id, item.vote] as const)),
    );
    if (preparedUndo.staleCount > 0) setVoteHistory(preparedUndo.history);
    const transition = preparedUndo.transition;
    if (!transition) {
      if (preparedUndo.staleCount > 0) {
        setToast("No recorded vote remains available to undo");
      }
      return;
    }
    const listing = data.listings.find((item) => item.id === transition.listingId);
    if (!listing) return;

    const currentVote = listing.vote;
    voteMutationRef.current = true;
    markDashboardMutation();
    setUndoingVote(true);
    setSavingVote(listing.id);
    setData((current) => ({
      ...current,
      run: adjustCurrentUnvotedCount(
        current.run,
        currentVote,
        transition.previousVote,
      ),
      listings: current.listings.map((item) =>
        item.id === listing.id ? { ...item, vote: transition.previousVote } : item,
      ),
    }));

    try {
      const result = await saveVote(listing.id, transition.previousVote);
      if (!result.persisted) {
        setData((current) => ({
          ...current,
          run: adjustCurrentUnvotedCount(
            current.run,
            transition.previousVote,
            currentVote,
          ),
          listings: current.listings.map((item) =>
            item.id === listing.id ? { ...item, vote: currentVote } : item,
          ),
        }));
        setToast(
          `Vote could not be undone${
            result.errorMessage ? `: ${result.errorMessage}` : ""
          }; the current vote was restored`,
        );
        return;
      }
      setVoteHistory((current) => completeVoteUndo(current, transition));
      setToast(
        transition.previousVote === null
          ? "Vote undone; listing returned to Unvoted"
          : "Vote undone; previous vote restored",
      );
    } finally {
      voteMutationRef.current = false;
      setUndoingVote(false);
      setSavingVote(null);
    }
  };

  const handleLotFeedback = async (listing: Listing, decision: ManualLotFeedbackDecision) => {
    if (lotMutationRef.current || voteMutationRef.current) return;
    lotMutationRef.current = true;
    markDashboardMutation();
    setSavingLot(listing.id);
    try {
      await saveLotFeedback(listing.id, decision);
      await refreshDashboard({
        requireFreshAfterCurrent: true,
        preserveUiState: true,
      });
      setToast(
        decision === "lot"
          ? "Listing marked as a lot"
          : "Listing marked as not a lot",
      );
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Lot classification could not be saved");
    } finally {
      lotMutationRef.current = false;
      setSavingLot(null);
    }
  };

  const handleSignalFeedback = async (
    concept: string,
    polarity: "positive" | "negative",
    action: "removed" | "restored",
  ) => {
    const profileVersionId = data.profile.versionId;
    const signalKey = `${polarity}:${concept.toLocaleLowerCase()}`;
    if (!profileVersionId || savingSignals.has(signalKey)) return;
    const previousProfile = data.profile;
    const optimisticInput = {
      concept,
      polarity,
      action,
      profileVersionId,
      feedbackId: `optimistic:${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    markDashboardMutation();
    setSavingSignals((current) => new Set(current).add(signalKey));
    setData((current) => ({
      ...current,
      profile: applyOptimisticProfileSignalFeedback(current.profile, optimisticInput),
    }));
    try {
      const result = await saveProfileSignalFeedback({
        concept,
        polarity,
        action,
        profileVersionId,
      });
      setData((current) => ({
        ...current,
        profile: applyOptimisticProfileSignalFeedback(current.profile, {
          concept: result.concept,
          polarity: result.polarity,
          action: result.action,
          profileVersionId: result.sourceProfileVersionId,
          feedbackId: result.feedbackId,
          createdAt: result.createdAt,
        }),
      }));
      setToast(result.warning ?? (
        action === "removed"
          ? "Signal removed from the profile"
          : "Signal restored to the profile"
      ));
    } catch (error) {
      setData((current) => ({
        ...current,
        profile: revertOptimisticProfileSignalFeedback(
          current.profile,
          previousProfile,
          optimisticInput,
        ),
      }));
      setToast(error instanceof Error ? error.message : "Profile feedback could not be saved");
    } finally {
      setSavingSignals((current) => {
        const next = new Set(current);
        next.delete(signalKey);
        return next;
      });
    }
  };

  const handleRunDiscovery = async () => {
    if (discoveryActive) return;
    if (!/^\d{5}$/.test(origin)) {
      setToast("Enter and save a five-digit US origin ZIP code first");
      return;
    }
    runStartMutationRef.current = true;
    markDashboardMutation();
    invalidateDashboardRequests();
    setRunning(true);
    try {
      if (origin !== data.originPostalCode) {
        const savedOrigin = await saveOriginPostalCode(origin);
        if (savedOrigin.postalCode !== origin) {
          throw new Error("The active origin did not match the requested ZIP code");
        }
        markDashboardMutation();
        setData((current) => ({
          ...current,
          originPostalCode: savedOrigin.postalCode,
          listings: [],
        }));
        setRefreshRequired(true);
      }
      runStartMutationRef.current = false;
      const status = await startLocalNightlyRun();
      setNightlyStatus(status);
      const identity = localNightlyRunIdentity(status);
      if (identity) {
        observedNightlyRunRef.current = identity;
        observedNightlyStartedAtRef.current =
          status.workflowStartedAt ?? status.createdAt ?? new Date().toISOString();
      }
      setRunning(status.active);
      setToast(status.reused
        ? "Discovery is already running in its visible terminal"
        : "Discovery started in a visible terminal");
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Unknown request failure";
      setRunning(false);
      setToast(`Discovery could not start: ${detail}`);
    } finally {
      runStartMutationRef.current = false;
    }
  };

  const handleSaveOrigin = async (postalCode: string): Promise<boolean> => {
    try {
      markDashboardMutation();
      const previousPostalCode = data.originPostalCode;
      const savedOrigin = await saveOriginPostalCode(postalCode);
      const changed = previousPostalCode !== savedOrigin.postalCode;
      if (changed) setRefreshRequired(true);
      setOrigin(savedOrigin.postalCode);
      setData((current) => ({
        ...current,
        originPostalCode: savedOrigin.postalCode,
        listings: current.originPostalCode === savedOrigin.postalCode
          ? current.listings
          : [],
      }));
      try {
        window.localStorage.setItem(LOCAL_ORIGIN_KEY, savedOrigin.postalCode);
      } catch {
        // The D1 setting is authoritative even if localStorage is unavailable.
      }
      setToast(changed
        ? `Active pickup origin changed to ${savedOrigin.postalCode}`
        : `Active pickup origin remains ${savedOrigin.postalCode}`);
      await refreshDashboard({ requireFreshAfterCurrent: true });
      return true;
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Origin could not be saved");
      return false;
    }
  };

  const handleSourceToggle = async (sourceId: string, enabled: boolean): Promise<void> => {
    if (discoveryActive || togglingSourceId) return;
    const source = data.sources.find((item) => item.id === sourceId);
    if (!source?.canEnable) return;
    setTogglingSourceId(sourceId);
    markDashboardMutation();
    try {
      await setSourceEnabled(sourceId, enabled);
      await refreshDashboard({ requireFreshAfterCurrent: true });
      setToast(`${source.name} ${enabled ? "enabled" : "disabled"} for future discovery runs`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : `${source.name} could not be updated`);
    } finally {
      setTogglingSourceId(null);
    }
  };

  const handleViewChange = (nextView: AppView) => {
    setView(nextView);
    detailSessionRef.current += 1;
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedListingSnapshot(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const palette = createInterfacePalette(accentColor, backgroundColor);

  useEffect(() => {
    const faviconHref = createAuctionFaviconHref(palette.accent, palette.accentText);
    const existingLinks = Array.from(
      document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'),
    );
    const priorHrefs = existingLinks.map((link) => link.getAttribute("href"));
    let createdLink: HTMLLinkElement | null = null;

    if (existingLinks.length === 0) {
      createdLink = document.createElement("link");
      createdLink.rel = "icon";
      createdLink.type = "image/svg+xml";
      document.head.insertAdjacentElement("beforeend", createdLink);
      existingLinks.push(createdLink);
    }
    existingLinks.forEach((link) => link.setAttribute("href", faviconHref));

    return () => {
      createdLink?.remove();
      existingLinks.forEach((link, index) => {
        if (link === createdLink) return;
        const priorHref = priorHrefs[index];
        if (priorHref === null || priorHref === undefined) link.removeAttribute("href");
        else link.setAttribute("href", priorHref);
      });
    };
  }, [palette.accent, palette.accentText]);

  const interfaceStyle = {
    "--accent": palette.accent,
    "--accent-text": palette.accentText,
    "--accent-dark": palette.accentDark,
    "--accent-soft": palette.accentSoft,
    "--accent-border": palette.accentBorder,
    "--accent-rgb": palette.accentRgb,
    "--sidebar": palette.chrome,
    "--sidebar-deep": palette.chromeDeep,
    "--sidebar-text": palette.chromeText,
    "--sidebar-muted": palette.chromeMuted,
  } as CSSProperties;

  return (
    <div className="app-shell" style={interfaceStyle}>
      <div
        className="app-background"
        inert={selectedListing ? true : undefined}
        aria-hidden={selectedListing ? true : undefined}
      >
        <Sidebar
          view={view}
          setView={handleViewChange}
          unvotedCount={unvotedListingCount}
          appName={appName}
          originPostalCode={data.originPostalCode || originPostalCode}
        />
        <MobileHeader view={view} setView={handleViewChange} appName={appName} />
        <main className="main-content">
          {view === "discover" ? (
            <DiscoverView
              data={data}
              dataMode={dataMode}
              referenceTime={referenceTime}
              filters={filters}
              setFilters={updateDiscoverFilters}
              openListing={openListing}
              vote={handleVote}
              savingVote={savingVote}
              bulkVoting={bulkVoting}
              bulkNotInterested={(listingIds) => {
                void handleBulkNotInterested(listingIds);
              }}
              undoVote={() => void handleUndoVote()}
              canUndoVote={voteHistory.length > 0}
              undoingVote={undoingVote}
              runDiscovery={handleRunDiscovery}
              retryDashboard={() => {
                setDataMode((current) => current === "api" ? current : "loading");
                setDashboardRetryExhausted(false);
                void refreshDashboard();
              }}
              retryReviewedListings={() => {
                const scope = listingScopeForVoteFilter(filters.vote);
                if (scope === "unvoted") {
                  void refreshDashboard({ preserveUiState: true });
                } else {
                  void loadReviewedListings(scope);
                }
              }}
              dashboardError={dashboardError}
              dashboardDegraded={dashboardDegraded}
              dashboardRetryExhausted={dashboardRetryExhausted}
              reviewedListingsState={reviewedListingsState}
              reviewedListingsError={reviewedListingsError}
              running={discoveryActive}
              refreshRequired={refreshRequired}
              nightlyStatus={nightlyStatus}
            />
          ) : null}
          {view === "profile" ? (
            <ProfileView
              data={data}
              onSignalFeedback={(concept, polarity, action) =>
                void handleSignalFeedback(concept, polarity, action)
              }
              savingSignals={savingSignals}
            />
          ) : null}
          {view === "settings" ? (
            <SettingsView
              data={data}
              ollamaHealth={ollamaHealth}
              origin={origin}
              setOrigin={setOrigin}
              textProvider={textProvider}
              textModel={textModel}
              embeddingModel={embeddingModel}
              saveOrigin={handleSaveOrigin}
              running={discoveryActive}
              refreshRequired={refreshRequired}
              accentColor={accentColor}
              backgroundColor={backgroundColor}
              setAccentColor={handleAccentChange}
              setBackgroundColor={handleBackgroundChange}
              toggleSource={handleSourceToggle}
              togglingSourceId={togglingSourceId}
            />
          ) : null}
        </main>
      </div>

      {selectedListing ? (
        <DetailPanel
          key={selectedListing.id}
          listing={selectedListing}
          close={() => closeListing(selectedListing.id)}
          vote={(nextVote) => void handleDetailVote(selectedListing, nextVote)}
          saving={savingVote === selectedListing.id}
          saveLotDecision={(decision) => void handleLotFeedback(selectedListing, decision)}
          savingLot={savingLot === selectedListing.id}
        />
      ) : null}

      {toast ? <Toast message={toast} /> : null}
    </div>
  );
}
