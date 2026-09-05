import { HttpError, jsonError, readJson } from "../../../../../lib/http";
import {
  setAuctionSourceEnabled,
  SourceToggleError,
} from "../../../../../lib/settings/source-toggle";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const payload = await readJson<{ enabled?: unknown }>(request);
    if (typeof payload.enabled !== "boolean") {
      throw new HttpError("enabled must be a boolean", 400, "invalid_source_enabled");
    }
    return Response.json(await setAuctionSourceEnabled(id, payload.enabled));
  } catch (error) {
    if (error instanceof SourceToggleError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.code === "source_not_found" ? 404 : 409 },
      );
    }
    return jsonError(error);
  }
}
