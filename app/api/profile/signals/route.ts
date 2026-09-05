import { ensureDatabase } from "../../../../db/bootstrap";
import { HttpError, jsonError, readJson } from "../../../../lib/http";
import { normalizeProfileSignalConcept } from "../../../../lib/operator-feedback";
import {
  appendProfileSignalCorrection,
  OperatorFeedbackError,
} from "../../../../lib/pipeline/operator-feedback";

export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    const payload = await readJson<{
      concept?: unknown;
      polarity?: unknown;
      action?: unknown;
      profileVersionId?: unknown;
    }>(request);
    if (typeof payload.concept !== "string") {
      throw invalidSignalRequest("concept must be a non-empty string of at most 200 characters");
    }
    try {
      normalizeProfileSignalConcept(payload.concept);
    } catch {
      throw invalidSignalRequest("concept must be a non-empty string of at most 200 characters");
    }
    if (payload.polarity !== "positive" && payload.polarity !== "negative") {
      throw invalidSignalRequest("polarity must be positive or negative");
    }
    if (payload.action !== "removed" && payload.action !== "restored") {
      throw invalidSignalRequest("action must be removed or restored");
    }
    if (
      typeof payload.profileVersionId !== "string" ||
      payload.profileVersionId.trim().length === 0 ||
      payload.profileVersionId.length > 200
    ) {
      throw invalidSignalRequest("profileVersionId must identify the displayed profile version");
    }

    await ensureDatabase();
    const result = await appendProfileSignalCorrection({
      concept: payload.concept,
      polarity: payload.polarity,
      action: payload.action,
      sourceProfileVersionId: payload.profileVersionId,
    });
    return Response.json(result, {
      status: 202,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof OperatorFeedbackError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    return jsonError(error);
  }
}

function invalidSignalRequest(message: string): HttpError {
  return new HttpError(message, 400, "invalid_profile_signal_feedback");
}
