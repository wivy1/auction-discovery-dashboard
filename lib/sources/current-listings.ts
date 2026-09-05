import type { SourceDiscoveredListing, SourceId } from "./types";

export function sourceReviewCandidates<Listing extends Pick<SourceDiscoveredListing, "reviewCandidate">>(
  listings: readonly Listing[],
  pageReviewCandidate: boolean | undefined,
): readonly Listing[] {
  return pageReviewCandidate === false ? [] : listings.filter((listing) => listing.reviewCandidate !== false);
}

/** Preparation follows atomic publication for every source. */
export function sourceReviewCandidatesForDiscovery<Listing extends Pick<SourceDiscoveredListing, "reviewCandidate">>(
  listings: readonly Listing[],
  pageReviewCandidate: boolean | undefined,
  _sourceId: SourceId,
  hasUnpublishedInventoryTraversal: boolean,
): readonly Listing[] {
  return hasUnpublishedInventoryTraversal ? [] : sourceReviewCandidates(listings, pageReviewCandidate);
}

/** Date-only values cannot prove that a listing has ended at an exact instant. */
export function exactListingEndHasPassed(auctionEndsAt: string | null, observedAt: string): boolean {
  if (!auctionEndsAt || !/^\d{4}-\d{2}-\d{2}T/u.test(auctionEndsAt)) return false;
  const end = Date.parse(auctionEndsAt);
  const observed = Date.parse(observedAt);
  return Number.isFinite(end) && Number.isFinite(observed) && end <= observed;
}

export function isExplicitlyNonCurrentStatus(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /(?:^|[\s_/-])(?:closed|ended|inactive|sold|withdrawn|cancell?ed)(?:$|[\s_/-])/u.test(value.trim().toLowerCase());
}
