/**
 * Exact durable evidence that a listing has already reached operator review.
 *
 * A binary vote is the ordinary completion marker. Preference V2 viewport
 * impressions are append-only, candidate-bound proof that an unvoted listing
 * was actually displayed. Dashboard eligibility, source release, scoring, and
 * D-108 policy decisions are deliberately not presentation evidence.
 */
export const REVIEW_COMPLETION_DERIVATION_VERSION =
  "listing-review-completion-v1" as const;

/** SQL EXISTS expression for the exact vote-or-display completion contract. */
export function listingReviewCompletedSql(listingIdSql: string): string {
  if (listingIdSql.length === 0 || /[;\u0000]/u.test(listingIdSql)) {
    throw new TypeError("listing completion SQL identity is invalid");
  }
  return `(
    EXISTS (
      SELECT 1
      FROM listing_votes completed_vote
      WHERE completed_vote.listing_id = ${listingIdSql}
    )
    OR EXISTS (
      SELECT 1
      FROM listing_impressions completed_impression
      WHERE completed_impression.listing_id = ${listingIdSql}
    )
  )`;
}
