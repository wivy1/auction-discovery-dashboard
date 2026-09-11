import type {
  Listing,
  LotType,
} from "./auction-data";

export function isLot(type: LotType): boolean {
  return type === "multi_item_lot" || type === "assorted_lot";
}

/** Keeps the server-derived classification exact; unknown stays unassessed. */
export function explicitLotType(listing: Listing): Exclude<LotType, "unknown"> | null {
  if (listing.attributes.lotType !== "unknown") return listing.attributes.lotType;
  return null;
}

/**
 * Selects the two-state detail control from an override or effective AI
 * classification. An unassessed/unknown listing presents as Not a lot; that
 * default does not create operator feedback or rewrite the AI extraction.
 */
export function effectiveLotFeedbackDecision(listing: Listing): "lot" | "not_lot" {
  if (listing.lotOverride) return listing.lotOverride.decision;
  const lotType = explicitLotType(listing);
  return lotType && isLot(lotType) ? "lot" : "not_lot";
}

export function listingSummary(listing: Listing): string {
  const generated = listing.aiMeta.provider !== "pending"
    && listing.aiSummary.trim()
    && !/^text enrichment pending\.?$/iu.test(listing.aiSummary.trim());
  if (generated) return listing.aiSummary.trim();
  return listing.cleanDescription.trim()
    || listing.rawDescription.trim()
    || "The source did not provide a descriptive item summary.";
}

function reviewClosingValue(value: string): number {
  if (!value) return Number.POSITIVE_INFINITY;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(year!, month! - 1, day!, 23, 59, 59, 999).getTime();
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function listingCloseValue(listing: Listing): number {
  return reviewClosingValue(listing.closesAt);
}

/** Returns only an exact timestamp that can authoritatively prove the lot ended. */
export function listingEndTimestamp(listing: Listing): number | null {

  if (!listing.closesAt || /^\d{4}-\d{2}-\d{2}$/.test(listing.closesAt)) return null;
  const timestamp = reviewClosingValue(listing.closesAt);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * Orders only scored listings ahead of Unrated listings. Equal scores keep
 * the factual close-time order and a stable listing-id tie break.
 */
export function compareLearnedRecommendation(a: Listing, b: Listing): number {
  if (Boolean(a.recommendation) !== Boolean(b.recommendation)) {
    return a.recommendation ? -1 : 1;
  }
  if (a.recommendation && b.recommendation && a.recommendation.score !== b.recommendation.score) {
    return b.recommendation.score - a.recommendation.score;
  }
  return listingCloseValue(a) - listingCloseValue(b) || a.id.localeCompare(b.id);
}

/**
 * Reads the dashboard's recommendation score, which is already expressed
 * on the 0-100 scale. Missing or invalid scores remain explicitly unrated.
 */
export function listingRecommendationDisplayScore(
  listing: Pick<Listing, "recommendation">,
): number | null {
  const score = listing.recommendation?.score;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    score < 0 ||
    score > 100
  ) return null;
  return Math.round(score);
}

export function matchesRecommendationScoreRange(
  score: number | null,
  minimum: number | null,
  maximum: number | null,
): boolean {
  if (minimum === null && maximum === null) return true;
  if (score === null) return false;
  return (minimum === null || score >= minimum) &&
    (maximum === null || score <= maximum);
}

/**
 * A past date-only catalog value and a live-auction start are not proof that
 * an individual lot has ended.
 */
export function isListingEnded(listing: Listing, referenceTime: number): boolean {
  if (listing.markedEndedAt) return true;
  if (!Number.isFinite(referenceTime)) return false;
  const timestamp = listingEndTimestamp(listing);
  return timestamp !== null && timestamp <= referenceTime;
}

/** Truthful operator copy for the bounded post-discovery close-time sweep. */

