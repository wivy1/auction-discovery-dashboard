import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../../../db/bootstrap";
import { markListingsEnded } from "../../../../db/listing-end-state";
import { HttpError, jsonError, readJson } from "../../../../lib/http";
import { MAX_BULK_END_LISTINGS, validListingIdentity } from "../../../../lib/listing-end-state";

export const dynamic = "force-dynamic";

export function parseBulkEndRequest(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).join(",") !== "listingIds") {
    throw new HttpError("Request body must contain exactly listingIds", 400, "invalid_bulk_end_payload");
  }
  const listingIds = (payload as { listingIds: unknown }).listingIds;
  if (!Array.isArray(listingIds) || listingIds.length < 1 ||
      listingIds.some((id) => !validListingIdentity(id))) {
    throw new HttpError("listingIds must contain exact bounded listing IDs", 400, "invalid_bulk_end_payload");
  }
  if (listingIds.length > MAX_BULK_END_LISTINGS) {
    throw new HttpError("A batch may contain at most 1000 listings", 413, "bulk_end_too_large");
  }
  return [...new Set(listingIds)];
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const listingIds = parseBulkEndRequest(await readJson<unknown>(request));
    await ensureDatabase();
    return Response.json(await markListingsEnded(env.DB, listingIds), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
