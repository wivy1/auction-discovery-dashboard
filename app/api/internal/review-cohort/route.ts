import { ensureDatabase } from "../../../../db/bootstrap";
import { HttpError, jsonError, readJson } from "../../../../lib/http";
import { assertLoopbackRequest } from "../../../../lib/local-request";
import {
  planAdhocReviewCohort,
  readAdhocReviewCohortStatus,
  readConfiguredAdhocReviewCohort,
} from "../../../../lib/review-cohort/storage";
import {
  adhocReviewSelectionPolicy,
  normalizeAdhocReviewExcludedSourceIds,
} from "../../../../lib/review-cohort/planner";
import {
  configuredAdhocReviewCohortId,
} from "../../../../lib/review-cohort/runtime";
import { sourceRegistry } from "../../../../lib/sources";

export const dynamic = "force-dynamic";

interface ReviewCohortPayload {
  action?: unknown;
  target?: unknown;
  refreshBoundary?: unknown;
  seed?: unknown;
  cohortId?: unknown;
  baseCohortId?: unknown;
  /** One-run policy: only unvoted, non-ordinary distance-exempt rows move. */
  excludeSourceIds?: unknown;
}

export async function GET(request: Request) {
  try {
    assertLoopbackRequest(request, "Ad hoc review cohorts");
    await ensureDatabase();
    const configuredId = configuredAdhocReviewCohortId();
    return Response.json({
      configuredCohortId: configuredId,
      cohort: await readConfiguredAdhocReviewCohort(),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLoopbackRequest(request, "Ad hoc review cohorts");
    await ensureDatabase();
    const payload = await readJson<ReviewCohortPayload>(request);
    if (payload.action === "status") {
      if (typeof payload.cohortId !== "string") {
        throw new HttpError(
          "cohortId is required for status",
          400,
          "invalid_review_cohort_request",
        );
      }
      return Response.json(
        await readAdhocReviewCohortStatus(payload.cohortId),
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (payload.action !== "plan") {
      throw new HttpError(
        "action must be plan or status",
        400,
        "invalid_review_cohort_request",
      );
    }
    if (payload.cohortId !== undefined) {
      throw new HttpError(
        "cohortId is status-only; planning always generates a new durable ID",
        400,
        "invalid_review_cohort_request",
      );
    }
    if (
      !Number.isSafeInteger(payload.target) ||
      Number(payload.target) < 1 || Number(payload.target) > 5_000 ||
      typeof payload.refreshBoundary !== "string" ||
      typeof payload.seed !== "string" ||
      (
        payload.baseCohortId !== undefined &&
        payload.baseCohortId !== null &&
        typeof payload.baseCohortId !== "string"
      )
    ) {
      throw new HttpError(
        "plan requires target 1-5000, refreshBoundary, seed, and optional baseCohortId",
        400,
        "invalid_review_cohort_request",
      );
    }
    let excludeSourceIds: string[];
    try {
      excludeSourceIds = normalizeAdhocReviewExcludedSourceIds(
        payload.excludeSourceIds,
        sourceRegistry.keys(),
      );
      adhocReviewSelectionPolicy(payload.seed, excludeSourceIds);
    } catch (error) {
      throw new HttpError(
        error instanceof Error
          ? `Distance-exempt-only excludeSourceIds is invalid: ${error.message}`
          : "Distance-exempt-only excludeSourceIds is invalid",
        400,
        "invalid_review_cohort_request",
      );
    }
    const result = await planAdhocReviewCohort({
      target: Number(payload.target),
      refreshBoundary: payload.refreshBoundary,
      seed: payload.seed,
      baseCohortId: payload.baseCohortId as string | null | undefined,
      excludeSourceIds,
    });
    return Response.json(result, {
      status: 201,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
