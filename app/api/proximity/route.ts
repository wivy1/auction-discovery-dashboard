import { ensureDatabase } from "../../../db/bootstrap";
import { invalidateDashboardReleaseCache } from "../../../db/dashboard";
import { HttpError, jsonError, readJson } from "../../../lib/http";
import { assertLoopbackRequest } from "../../../lib/local-request";
import { readNightlyPerformanceFeatures } from
  "../../../lib/performance/features";
import { resolveDatabasePerformanceFeature } from "../../../lib/performance/runtime-policy";
import {
  QUEUE_BACKED_PROXIMITY_READINESS_DERIVATION_VERSION,
} from "../../../lib/performance/component-readiness";
import {
  runCanonicalLocalProximityPassForAudit,
  runLocalProximityPass,
} from "../../../lib/pipeline/proximity";
import type { PipelineWorkClaimIdentity } from
  "../../../lib/pipeline/work-queue";
import {
  NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER,
  schedulerRuntimeAuthorizationRegistry,
} from "../../../lib/scheduler/runtime-authorization";
import { DiscoveryRunBusyError } from "../../../lib/pipeline/storage";
import {
  createTransportPerformanceTelemetryBuffer,
  drainTransportPerformanceTelemetry,
} from "../../../lib/performance/telemetry-transport";
import { env } from "cloudflare:workers";
import { assertMatchingLoadedRuntimeRevision } from
  "../../../lib/runtime-revision-request";

export const dynamic = "force-dynamic";

interface ProximityRequestPayload {
  readonly queueClaim: PipelineWorkClaimIdentity | null;
}

const PROXIMITY_CLAIM_KEYS = Object.freeze([
  "inputHash",
  "owner",
  "revision",
  "stage",
  "subjectId",
  "subjectType",
] as const);

export function parseProximityRequestPayload(
  payload: unknown,
): ProximityRequestPayload {
  if (!isRecord(payload)) return invalidProximityRequest();
  if (Object.keys(payload).length === 0) {
    return Object.freeze({ queueClaim: null });
  }
  if (
    Object.keys(payload).length !== 1 ||
    !("queueClaim" in payload) ||
    !isRecord(payload.queueClaim)
  ) return invalidProximityRequest();
  const claim = payload.queueClaim;
  if (
    Object.keys(claim).sort().join("\0") !== PROXIMITY_CLAIM_KEYS.join("\0") ||
    claim.stage !== "proximity" ||
    claim.subjectType !== "listing"
  ) return invalidProximityRequest();
  return Object.freeze({
    queueClaim: Object.freeze({
      stage: "proximity",
      subjectType: "listing",
      subjectId: boundedClaimText(claim.subjectId, 512),
      owner: boundedClaimText(claim.owner, 256),
      inputHash: boundedClaimText(claim.inputHash, 512),
      revision: positiveSafeInteger(claim.revision),
    }),
  });
}

export async function POST(request: Request) {
  try {
    assertLoopbackRequest(request, "Approximate proximity");
    assertMatchingLoadedRuntimeRevision(request);
    const payload = parseProximityRequestPayload(await readJson<unknown>(request));
    await ensureDatabase();
    let feature: Awaited<ReturnType<typeof resolveDatabasePerformanceFeature>> |
      null = null;
    if (payload.queueClaim !== null) {
      if (!claimedQueueAuthorizationAllowsExecution(request)) {
        return claimedQueueReadinessResponse(null);
      }
    } else {
      feature = await resolveDatabasePerformanceFeature({
        database: env.DB,
        feature: "queueBackedProximity",
        derivationVersion: QUEUE_BACKED_PROXIMITY_READINESS_DERIVATION_VERSION,
      });
    }
    const summary = payload.queueClaim !== null || feature?.decision === "optimized"
      ? await runLocalProximityPass({
          signal: request.signal,
          queueClaim: payload.queueClaim ?? undefined,
        })
      : await runCanonicalLocalProximityPassForAudit({ signal: request.signal });
    if (summary.status === "completed" && summary.mutationStatements > 0) {
      invalidateDashboardReleaseCache();
    }
    const telemetry = createTransportPerformanceTelemetryBuffer(request);
    telemetry.record({
      context: { runId: summary.runId, coverageMode: "complete_current" },
      details: {
        kind: "proximity",
        selected: summary.selectedListings,
        selectorMs: summary.timingsMs.selection,
        projectionMs: 0,
        calculationMs:
          summary.timingsMs.normalizeAndCalculate + summary.timingsMs.cacheLookup,
        persistenceMs: summary.timingsMs.persistence,
        cacheHits: summary.cacheHits,
        statements: summary.mutationStatements,
        batches: summary.mutationBatches,
      },
    });
    telemetry.record({
      context: { runId: summary.runId, coverageMode: "complete_current" },
      details: {
        kind: "stage",
        stage: "proximity",
        outcome: "completed",
        durationMs: summary.timingsMs.total,
      },
    });
    return Response.json({
      ...summary,
      performanceTelemetry: drainTransportPerformanceTelemetry(
        request,
        telemetry,
      ),
    }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof DiscoveryRunBusyError) {
      return Response.json(
        {
          error: error.message,
          code: "pipeline_run_in_progress",
          activeRunId: error.activeRunId,
          activeRunKind: error.activeRunKind,
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    return jsonError(error);
  }
}

function invalidProximityRequest(): never {
  throw new HttpError(
    "Approximate proximity accepts only {} or one exact queueClaim",
    400,
    "invalid_proximity_request",
  );
}

function claimedQueueReadinessResponse(
  feature: Awaited<ReturnType<typeof resolveDatabasePerformanceFeature>> | null,
): Response {
  return Response.json({
    status: "failed",
    code: "proximity_optimized_readiness_required",
    error: "Claimed proximity work requires current optimized queue readiness",
    readiness: {
      derivationVersion:
        QUEUE_BACKED_PROXIMITY_READINESS_DERIVATION_VERSION,
      ready: feature?.readiness.ready ?? false,
      implementationAvailable:
        feature?.readiness.implementationAvailable ?? true,
      receiptIdentity: feature?.readiness.receiptIdentity ?? null,
      generationVectorHash: feature?.generationVector?.hash ?? null,
    },
  }, {
    status: 409,
    headers: { "cache-control": "no-store" },
  });
}

function claimedQueueAuthorizationAllowsExecution(request: Request): boolean {
  const token = request.headers.get(NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER);
  if (token === null) return false;
  const binding = schedulerRuntimeAuthorizationRegistry.readOptimizedFeature(
    token,
    "queueBackedProximity",
  );
  if (binding === null || binding.includeSourceAcquisitions) return false;
  const features = readNightlyPerformanceFeatures();
  const mode = features.modes.queueBackedProximity;
  return !features.forceCanonical && mode !== "off" && mode !== "shadow";
}

function boundedClaimText(
  value: unknown,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) return invalidProximityRequest();
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalidProximityRequest();
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
