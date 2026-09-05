import { ensureDatabase } from "../../../../../db/bootstrap";
import { readDashboardListingDetail } from "../../../../../db/dashboard";
import { HttpError, jsonError } from "../../../../../lib/http";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id: listingId } = await context.params;
    if (!listingId || listingId.length > 512) {
      throw new HttpError(
        "Listing identity is invalid",
        400,
        "invalid_listing_id",
      );
    }
    await ensureDatabase();
    const detail = await readDashboardListingDetail(listingId);
    if (!detail) {
      throw new HttpError(
        "Listing detail was not found",
        404,
        "listing_not_found",
      );
    }
    return Response.json(detail, {
      headers: {
        "cache-control": "private, max-age=300",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
