import { ensureDatabase } from "../../../db/bootstrap";
import { HttpError, jsonError, readJson } from "../../../lib/http";
import { runAuctionDiscovery } from "../../../lib/pipeline/discovery";
import { DiscoveryRunBusyError } from "../../../lib/pipeline/storage";
import { withRouteTiming } from "../../../lib/performance/http-route-timing";
import {
  effectiveSourceAcquisition,
  findSourceAdapter,
  type SourceId,
} from "../../../lib/sources";
import { normalizeUsPostalCode } from "../../../lib/settings/active-origin";
import {
  ActiveOriginBusyError,
  setActiveOriginWhenIdle,
} from "../../../lib/settings/origin-update";
import { assertMatchingLoadedRuntimeRevision } from
  "../../../lib/runtime-revision-request";
import {
  InvalidScheduledSourceQuantumError,
  parseScheduledSourceQuantum,
  ScheduledSourceQuantumAuthorizationError,
  type ScheduledSourceQuantum,
} from "../../../lib/scheduler/source-quantum";
import {
  NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER,
  schedulerRuntimeAuthorizationRegistry,
} from "../../../lib/scheduler/runtime-authorization";

export const dynamic = "force-dynamic";

async function runDiscovery(request: Request): Promise<Response> {
  try {
    assertMatchingLoadedRuntimeRevision(request);
    const payload = await readJson<{
      kind?: string;
      originPostalCode?: unknown;
      sourceId?: unknown;
      retryFailedImages?: unknown;
      deferPrimaryImages?: unknown;
      schedulerQuantum?: unknown;
    }>(request);
    if (
      payload.kind !== undefined &&
      payload.kind !== "discovery" &&
      payload.kind !== "source_discovery" &&
      payload.kind !== "source_continuation" &&
      payload.kind !== "source_canary"
    ) {
      throw new HttpError(
        "kind must be discovery, source_discovery, source_continuation, or source_canary",
        400,
        "invalid_run_kind",
      );
    }
    let postalCode: string | undefined;
    if (payload.originPostalCode !== undefined) {
      if (typeof payload.originPostalCode !== "string") {
        throw new HttpError(
          "originPostalCode must be a five-digit US ZIP code",
          400,
          "invalid_origin_postal_code",
        );
      }
      try {
        postalCode = normalizeUsPostalCode(payload.originPostalCode);
      } catch {
        throw new HttpError(
          "originPostalCode must be a five-digit US ZIP code",
          400,
          "invalid_origin_postal_code",
        );
      }
    }
    let sourceId: SourceId | undefined;
    if (
      payload.kind === "source_canary" ||
      payload.kind === "source_discovery" ||
      payload.kind === "source_continuation"
    ) {
      if (typeof payload.sourceId !== "string" || !findSourceAdapter(payload.sourceId)) {
        throw new HttpError(
          "sourceId must identify a registered source",
          400,
          "invalid_source_id",
        );
      }
      sourceId = payload.sourceId as SourceId;
    } else if (payload.sourceId !== undefined) {
      throw new HttpError(
        "sourceId is only accepted for source_canary, source_discovery, or source_continuation runs",
        400,
        "invalid_source_id",
      );
    }
    let schedulerQuantum: ScheduledSourceQuantum | undefined;
    if (payload.schedulerQuantum !== undefined) {
      if (
        payload.kind !== "source_discovery" ||
        sourceId === undefined ||
        effectiveSourceAcquisition(findSourceAdapter(sourceId)!.manifest) !== "direct"
      ) {
        throw new HttpError(
          "schedulerQuantum is accepted only for one direct source_discovery run",
          400,
          "invalid_scheduler_quantum",
        );
      }
      const authorizationToken = request.headers.get(
        NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER,
      );
      const authorizationBinding = authorizationToken === null
        ? null
        : schedulerRuntimeAuthorizationRegistry.read(authorizationToken);
      if (authorizationBinding === null) {
        throw new HttpError(
          "The scheduler source quantum authorization is missing or invalid",
          401,
          "nightly_scheduler_authorization_required",
        );
      }
      try {
        schedulerQuantum = parseScheduledSourceQuantum(
          payload.schedulerQuantum,
          {
            expectedSourceId: sourceId,
            authorizationBinding,
          },
        );
      } catch (error) {
        if (error instanceof ScheduledSourceQuantumAuthorizationError) {
          throw new HttpError(
            error.message,
            401,
            "nightly_scheduler_authorization_required",
          );
        }
        if (error instanceof InvalidScheduledSourceQuantumError) {
          throw new HttpError(error.message, 400, "invalid_scheduler_quantum");
        }
        throw error;
      }
    }
    if (
      payload.retryFailedImages !== undefined &&
      typeof payload.retryFailedImages !== "boolean"
    ) {
      throw new HttpError(
        "retryFailedImages must be a boolean",
        400,
        "invalid_retry_failed_images",
      );
    }
    if (
      payload.deferPrimaryImages !== undefined &&
      typeof payload.deferPrimaryImages !== "boolean"
    ) {
      throw new HttpError(
        "deferPrimaryImages must be a boolean",
        400,
        "invalid_defer_primary_images",
      );
    }
    if (
      payload.deferPrimaryImages !== undefined &&
      payload.kind !== "source_continuation"
    ) {
      throw new HttpError(
        "deferPrimaryImages is only accepted for source continuation runs",
        400,
        "invalid_defer_primary_images",
      );
    }
    if (
      payload.deferPrimaryImages === true &&
      payload.retryFailedImages === true
    ) {
      throw new HttpError(
        "Deferred primary images require a separate continuation pass from image repair",
        400,
        "conflicting_image_repair_modes",
      );
    }
    if (
      payload.retryFailedImages !== undefined &&
      payload.kind !== "source_continuation"
    ) {
      throw new HttpError(
        "retryFailedImages is only accepted for continuation runs",
        400,
        "invalid_retry_failed_images",
      );
    }
    await ensureDatabase();
    if (postalCode) {
      await setActiveOriginWhenIdle({ postalCode });
    }
    const result = await runAuctionDiscovery(
      schedulerQuantum === undefined ? "manual" : "scheduled",
      payload.kind === "source_canary"
        ? { mode: "canary", sourceId }
        : payload.kind === "source_continuation"
          ? {
              mode: "continuation",
              sourceId,
              retryFailedImages: payload.retryFailedImages === true,
              deferPrimaryImages: payload.deferPrimaryImages === true,
            }
        : payload.kind === "source_discovery"
          ? schedulerQuantum === undefined
            ? { sourceId, catalogOnly: true }
            : { sourceId, catalogOnly: true, schedulerQuantum }
          : undefined,
    );
    return Response.json(result, {
      status: result.status === "failed" ? 500 : result.status === "partial" ? 207 : 200,
    });
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
    if (error instanceof DiscoveryRunBusyError) {
      return Response.json(
        {
          error: error.message,
          code: "pipeline_run_in_progress",
          activeRunId: error.activeRunId,
          activeRunKind: error.activeRunKind,
        },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  return withRouteTiming("runs", () => runDiscovery(request));
}
