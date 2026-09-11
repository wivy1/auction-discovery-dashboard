export const MAX_BULK_END_LISTINGS = 1_000;

export interface ListingEndOutcome {
  listingId: string;
  canonicalListingId: string | null;
  status: "changed" | "already_ended" | "skipped_has_time" | "skipped_not_found";
  markedEndedAt: string | null;
}

export interface BulkListingEndResult {
  requestedCount: number;
  outcomes: ListingEndOutcome[];
}

export function listingTimeUnavailable(listing: {
  closesAt: string;
  closeSupplement?: unknown;
  actionDeadline?: unknown;
}): boolean {
  // A live-auction start is not a closing time or proof that a lot ended.
  return !listing.closesAt.trim() && !listing.closeSupplement;
}

export function validListingIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function parseBulkListingEndResult(value: unknown): BulkListingEndResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (Object.keys(result).sort().join(",") !== "outcomes,requestedCount" ||
      !Number.isSafeInteger(result.requestedCount) ||
      Number(result.requestedCount) < 1 || Number(result.requestedCount) > MAX_BULK_END_LISTINGS ||
      !Array.isArray(result.outcomes) || result.outcomes.length !== result.requestedCount) return null;
  const seen = new Set<string>();
  for (const entry of result.outcomes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "canonicalListingId,listingId,markedEndedAt,status" ||
        !validListingIdentity(entry.listingId) || seen.has(entry.listingId)) return null;
    seen.add(entry.listingId);
    if (entry.status === "skipped_not_found") {
      if (entry.canonicalListingId !== null || entry.markedEndedAt !== null) return null;
    } else {
      if (!validListingIdentity(entry.canonicalListingId)) return null;
      if (entry.status === "skipped_has_time") {
        if (entry.markedEndedAt !== null) return null;
      } else if (entry.status === "changed" || entry.status === "already_ended") {
        if (typeof entry.markedEndedAt !== "string" ||
            !Number.isFinite(Date.parse(entry.markedEndedAt)) ||
            new Date(entry.markedEndedAt).toISOString() !== entry.markedEndedAt) return null;
      } else return null;
    }
  }
  return result as unknown as BulkListingEndResult;
}
