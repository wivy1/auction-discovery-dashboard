import { mutateBinaryVote } from "../../../../../db/dashboard";
import { HttpError, jsonError, readJson } from "../../../../../lib/http";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const payload = await readJson<{ vote?: string }>(request);
    if (payload.vote !== "interested" && payload.vote !== "not_interested") {
      throw new HttpError(
        "vote must be interested or not_interested",
        400,
        "invalid_vote",
      );
    }
    const result = await mutateBinaryVote(id, payload.vote);
    if (result.status === "not_found") {
      throw new HttpError("Listing not found", 404, "listing_not_found");
    }
    if (result.status === "not_ready") {
      throw new HttpError(
        "Listing is not ready for review",
        409,
        "listing_not_ready",
      );
    }
    return Response.json({ listingId: id, vote: payload.vote });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const result = await mutateBinaryVote(id, null);
    if (result.status === "not_found") {
      throw new HttpError("Listing not found", 404, "listing_not_found");
    }
    if (result.status === "not_ready") {
      throw new HttpError(
        "Listing is not ready for review",
        409,
        "listing_not_ready",
      );
    }
    return Response.json({ listingId: id, vote: null });
  } catch (error) {
    return jsonError(error);
  }
}
