import { env } from "cloudflare:workers";
import { HttpError, jsonError, readJson } from "../../../../lib/http";
import { companionEnrichmentStagedGenerationStore } from
  "../../../../lib/enrichment/staged-generation-companion-client";
import { assertLoopbackRequest } from "../../../../lib/local-request";
import { runEnrichmentBatch } from "../../../../lib/pipeline/enrichment-run";
import { EnrichmentRunBusyError } from "../../../../lib/pipeline/storage";
import { PerformanceTelemetryBuffer } from "../../../../lib/performance/telemetry";
import { readNightlyPerformanceFeatures } from
  "../../../../lib/performance/features";
import {
  ENRICHMENT_SESSION_RESIDENCY_READINESS_DERIVATION_VERSION,
} from "../../../../lib/performance/component-readiness";
import { assertMatchingLoadedRuntimeRevision } from
  "../../../../lib/runtime-revision-request";
import { loadedRuntimeRevision } from "../../../../lib/runtime-revision";
import type { PipelineWorkClaimIdentity } from
  "../../../../lib/pipeline/work-queue";
import {
  NIGHTLY_SCHEDULER_AUTHORIZATION_HEADER,
  schedulerRuntimeAuthorizationRegistry,
} from "../../../../lib/scheduler/runtime-authorization";

export const dynamic = "force-dynamic";

export interface EnrichmentRunRequestPayload {
  readonly limit: number;
  readonly chunks: number;
  readonly queueClaim: PipelineWorkClaimIdentity | null;
}

const ENRICHMENT_CLAIM_KEYS = Object.freeze([
  "inputHash",
  "owner",
  "revision",
  "stage",
  "subjectId",
  "subjectType",
] as const);

const ENRICHMENT_REQUEST_KEYS = new Set(["limit", "chunks", "queueClaim"]);

export function parseEnrichmentRunRequestPayload(
  payload: unknown,
): EnrichmentRunRequestPayload {
  if (
    !isRecord(payload) ||
    Object.keys(payload).some((key) => !ENRICHMENT_REQUEST_KEYS.has(key))
  ) return invalidEnrichmentRequest();
  const limit = payload.limit ?? 1;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 10) {
    throw new HttpError(
      "limit must be an integer from 1 through 10",
      400,
      "invalid_enrichment_limit",
    );
  }
  const chunks = payload.chunks ?? 1;
  if (!Number.isSafeInteger(chunks) || Number(chunks) < 1 || Number(chunks) > 10) {
    throw new HttpError(
      "chunks must be an integer from 1 through 10",
      400,
      "invalid_enrichment_chunks",
    );
  }
  if (!("queueClaim" in payload)) {
    return Object.freeze({
      limit: Number(limit),
      chunks: Number(chunks),
      queueClaim: null,
    });
  }
  const value = payload.queueClaim;
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join("\0") !== ENRICHMENT_CLAIM_KEYS.join("\0") ||
    (value.stage !== "enrichment_text" &&
      value.stage !== "enrichment_embedding") ||
    value.subjectType !== "listing"
  ) return invalidEnrichmentRequest();
  return Object.freeze({
    limit: Number(limit),
    chunks: Number(chunks),
    queueClaim: Object.freeze({
      stage: value.stage,
      subjectType: "listing",
      subjectId: boundedClaimText(value.subjectId, 512),
      owner: boundedClaimText(value.owner, 256),
      inputHash: boundedClaimText(value.inputHash, 512),
      revision: positiveSafeInteger(value.revision),
    }),
  });
}

export async function POST(request: Request) {
  try {
    assertLoopbackRequest(request, "Text enrichment");
    assertMatchingLoadedRuntimeRevision(request);
    const payload = parseEnrichmentRunRequestPayload(
      await readJson<unknown>(request),
    );
    const limit = payload.limit;
    const chunks = payload.chunks ?? 1;
    if (
      payload.queueClaim !== null &&
      !claimedQueueAuthorizationAllowsExecution(request)
    ) {
      return claimedQueueAuthorizationResponse();
    }

    const strictTelemetry = request.headers.get("x-performance-telemetry") ===
      "events-v1";
    const telemetry = strictTelemetry
      ? new PerformanceTelemetryBuffer({ capacity: 1_024, overflow: "throw" })
      : undefined;
    const runtimeEnv = env as unknown as Record<string, unknown>;
    const capability = typeof runtimeEnv.AUCTION_DISCOVERY_IMAGE_TOKEN === "string"
      ? runtimeEnv.AUCTION_DISCOVERY_IMAGE_TOKEN
      : "";
    const result = await runEnrichmentBatch(Number(limit), Number(chunks), {
      telemetry,
      queueClaim: payload.queueClaim ?? undefined,
      signal: request.signal,
      stagedGenerationStore: companionEnrichmentStagedGenerationStore({
        capability,
        runtimeRevision: loadedRuntimeRevision(),
        signal: request.signal,
      }),
    });
    const performanceTelemetry = telemetry?.drain();
    if (
      performanceTelemetry !== undefined &&
      performanceTelemetry.summary.droppedEvents !== 0
    ) {
      throw new Error("strict enrichment telemetry dropped events");
    }
    const response = performanceTelemetry === undefined
      ? result
      : { ...result, performanceTelemetry };
    return Response.json(response, {
      status: result.status === "failed" ? 500 : result.status === "partial" ? 207 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof EnrichmentRunBusyError) {
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

function invalidEnrichmentRequest(): never {
  throw new HttpError(
    "Text enrichment accepts only limit, chunks, and one exact queueClaim",
    400,
    "invalid_enrichment_request",
  );
}

function claimedQueueAuthorizationResponse(): Response {
  return Response.json({
    status: "failed",
    code: "enrichment_optimized_readiness_required",
    error: "Claimed enrichment work requires current authorized optimized queue readiness",
    readiness: {
      derivationVersion:
        ENRICHMENT_SESSION_RESIDENCY_READINESS_DERIVATION_VERSION,
      ready: false,
      implementationAvailable: true,
      receiptIdentity: null,
      generationVectorHash: null,
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
    "enrichmentSessionResidency",
  );
  if (binding === null || binding.includeSourceAcquisitions) return false;
  const features = readNightlyPerformanceFeatures();
  const mode = features.modes.enrichmentSessionResidency;
  return !features.forceCanonical && mode !== "off" && mode !== "shadow";
}

function boundedClaimText(value: unknown, maximumLength: number): string {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value)
  ) return invalidEnrichmentRequest();
  return value;
}

function positiveSafeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalidEnrichmentRequest();
  }
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
