import { ensureDatabase } from "../../../../db/bootstrap";
import { HttpError, jsonError, readJson } from "../../../../lib/http";
import {
  readActiveOrigin,
  normalizeUsPostalCode,
} from "../../../../lib/settings/active-origin";
import {
  ActiveOriginBusyError,
  setActiveOriginWhenIdle,
} from "../../../../lib/settings/origin-update";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureDatabase();
    return Response.json(await readActiveOrigin());
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const payload = await readJson<{ originPostalCode?: unknown }>(request);
    if (typeof payload.originPostalCode !== "string") {
      throw new HttpError(
        "originPostalCode must be a five-digit US ZIP code",
        400,
        "invalid_origin_postal_code",
      );
    }
    let postalCode: string;
    try {
      postalCode = normalizeUsPostalCode(payload.originPostalCode);
    } catch {
      throw new HttpError(
        "originPostalCode must be a five-digit US ZIP code",
        400,
        "invalid_origin_postal_code",
      );
    }
    await ensureDatabase();
    return Response.json(await setActiveOriginWhenIdle({ postalCode }));
  } catch (error) {
    if (error instanceof ActiveOriginBusyError) {
      return Response.json(
        {
          error: error.message,
          code: "origin_change_during_pipeline_run",
          activeRunId: error.activeRunId,
          activeRunKind: error.activeRunKind,
        },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}
