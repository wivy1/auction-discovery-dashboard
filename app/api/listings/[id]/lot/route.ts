import { ensureDatabase } from "../../../../../db/bootstrap";
import { HttpError, jsonError, readJson } from "../../../../../lib/http";
import {
  appendListingLotFeedback,
} from "../../../../../lib/pipeline/operator-feedback";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const payload = await readJson<{ decision?: unknown }>(request);
    if (
      payload.decision !== "lot" &&
      payload.decision !== "not_lot" &&
      payload.decision !== "automatic"
    ) {
      throw new HttpError(
        "decision must be lot, not_lot, or automatic",
        400,
        "invalid_lot_decision",
      );
    }

    await ensureDatabase();
    const feedback = await appendListingLotFeedback(id, payload.decision);
    if (!feedback) {
      throw new HttpError("Listing not found", 404, "listing_not_found");
    }
    return Response.json({
      listingId: feedback.listingId,
      lotOverride: feedback.decision === "automatic"
        ? null
        : {
            feedbackId: feedback.id,
            decision: feedback.decision,
            createdAt: feedback.createdAt,
            source: feedback.source,
          },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
