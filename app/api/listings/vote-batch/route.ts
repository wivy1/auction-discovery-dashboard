import {
  markListingsNotInterestedIfUnvoted,
} from "../../../../db/dashboard";
import { HttpError, jsonError, readJson } from "../../../../lib/http";

export const MAX_BULK_VOTE_LISTINGS = 1_000;

function exactPayloadKeys(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return keys.length === 1 && keys[0] === "listingIds";
}

function validListingIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function parseBulkVoteRequest(payload: unknown): string[] {
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload) ||
    !exactPayloadKeys(payload as Record<string, unknown>)
  ) {
    throw new HttpError(
      "Request body must contain exactly listingIds",
      400,
      "invalid_bulk_vote_payload",
    );
  }
  const listingIds = (payload as { listingIds?: unknown }).listingIds;
  if (!Array.isArray(listingIds) || listingIds.length < 1) {
    throw new HttpError(
      "listingIds must be a nonempty array",
      400,
      "invalid_bulk_vote_payload",
    );
  }
  if (listingIds.length > MAX_BULK_VOTE_LISTINGS) {
    throw new HttpError(
      `A bulk vote may contain at most ${MAX_BULK_VOTE_LISTINGS} listing IDs`,
      413,
      "bulk_vote_too_large",
    );
  }
  if (listingIds.some((listingId) => !validListingIdentity(listingId))) {
    throw new HttpError(
      "Every listing ID must be an exact bounded string",
      400,
      "invalid_bulk_vote_payload",
    );
  }
  return [...new Set(listingIds)];
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const listingIds = parseBulkVoteRequest(await readJson<unknown>(request));
    const result = await markListingsNotInterestedIfUnvoted(listingIds);
    return Response.json(result);
  } catch (error) {
    return jsonError(error);
  }
}
