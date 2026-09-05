/**
 * A present detail observation is authoritative even when it intentionally
 * records no close time. COALESCE would incorrectly revive the immutable
 * first-scrape value in that case.
 */
export const EFFECTIVE_DETAIL_AUCTION_ENDS_AT_SQL = `
  CASE
    WHEN observation.listing_id IS NOT NULL THEN observation.auction_ends_at
    ELSE d.auction_ends_at
  END
`;
