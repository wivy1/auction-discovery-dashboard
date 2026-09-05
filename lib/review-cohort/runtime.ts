import { getConfig, type AppConfig } from "../config";

export const ADHOC_REVIEW_COHORT_SCHEMA_VERSION =
  "adhoc-review-cohort-v1";

export function validateAdhocReviewCohortId(value: string): string {
  const id = value.trim();
  if (
    id.length < 1 || id.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)
  ) {
    throw new TypeError("ad hoc review cohort ID is invalid");
  }
  return id;
}

export function configuredAdhocReviewCohortId(
  config: AppConfig = getConfig(),
): string | null {
  const value = config.adhocReviewCohortId;
  if (value === null) return null;
  try {
    return validateAdhocReviewCohortId(value);
  } catch {
    throw new Error(
      "ADHOC_REVIEW_COHORT_ID must be a 1-200 character durable cohort ID",
    );
  }
}

/** Exact-member SQL for a query that already joins current inventory. */
export function adhocReviewMemberExistsSql(input: {
  readonly listingIdSql: string;
  readonly sourceIdSql: string;
  readonly inventoryRunIdSql: string;
  readonly cohortIdSql?: string;
}): string {
  return `EXISTS (
    SELECT 1
    FROM adhoc_review_cohort_memberships adhoc_member
    JOIN adhoc_review_cohorts adhoc_cohort
      ON adhoc_cohort.id = adhoc_member.cohort_id
      AND adhoc_cohort.state = 'ready'
    JOIN source_inventory_publication_heads adhoc_member_head
      ON adhoc_member_head.source_id = adhoc_member.source_id
      AND adhoc_member_head.inventory_run_id = adhoc_member.inventory_run_id
    WHERE adhoc_member.cohort_id = ${input.cohortIdSql ?? "?"}
      AND adhoc_member.listing_id = ${input.listingIdSql}
      AND adhoc_member.source_id = ${input.sourceIdSql}
      AND adhoc_member.inventory_run_id = ${input.inventoryRunIdSql}
  )`;
}

/** Exact-member SQL for a listing query that does not already join current. */
export function adhocReviewListingMemberExistsSql(input: {
  readonly listingIdSql: string;
  readonly sourceIdSql: string;
  readonly cohortIdSql?: string;
}): string {
  return `EXISTS (
    SELECT 1
    FROM adhoc_review_cohort_memberships adhoc_member
    JOIN adhoc_review_cohorts adhoc_cohort
      ON adhoc_cohort.id = adhoc_member.cohort_id
      AND adhoc_cohort.state = 'ready'
    JOIN source_current_listings adhoc_member_current
      ON adhoc_member_current.listing_id = adhoc_member.listing_id
      AND adhoc_member_current.source_id = adhoc_member.source_id
      AND adhoc_member_current.inventory_run_id = adhoc_member.inventory_run_id
      AND adhoc_member_current.review_candidate = 1
    JOIN source_inventory_publication_heads adhoc_member_head
      ON adhoc_member_head.source_id = adhoc_member.source_id
      AND adhoc_member_head.inventory_run_id = adhoc_member.inventory_run_id
    WHERE adhoc_member.cohort_id = ${input.cohortIdSql ?? "?"}
      AND adhoc_member.listing_id = ${input.listingIdSql}
      AND adhoc_member.source_id = ${input.sourceIdSql}
  )`;
}
