import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_PRIMARY_IMAGE_SESSION_BODY_BYTES,
  parsePrimaryImageSessionBody,
  runDirectSourceImageDrain,
  type DirectSourceImageDrainSummary,
} from "./cache-source-images.ts";
import { PerformanceTelemetryBuffer } from "../lib/performance/telemetry.ts";
import {
  parseScheduleUpdateBody,
  runScheduleControl as runWindowsScheduleControl,
} from "./schedule-control.ts";
import {
  launchVisibleNightlyRun,
  NightlyVisibleControlError,
  readVisibleNightlyRun,
} from "./nightly-visible-control.ts";
import {
  computeRuntimeRevision,
  isRuntimeRevision,
  loadedRuntimeRevision,
  loadedSupervisorInstanceId,
  RUNTIME_REVISION_HEADER,
  RUNTIME_REVISION_MISMATCH_MESSAGE,
  RUNTIME_REVISION_SCHEMA_VERSION,
} from "../lib/runtime-revision.ts";
import {
  LOCAL_SOURCE_ACQUISITION_MAX_TELEMETRY_EVENTS,
  LocalSourceAcquisitionError,
  runLocalSourceAcquisition,
  runLocalSourceAcquisitionBatch,
  sourceAcquisitionCallbackQueueDepth,
  type LocalSourceAcquisitionBatchResult,
  type LocalSourceAcquisitionMode,
  type LocalSourceAcquisitionResult,
  type LocalSourceAcquisitionTrigger,
} from "./source-acquisition-service.ts";
import { findSourceAdapter } from "../lib/sources/registry.ts";
import type { SourceId } from "../lib/sources/types.ts";
import { optionalAiCapabilities } from "../lib/ai/capabilities.ts";
import { executeEnrichmentStagingCompanionRequest } from
  "../lib/enrichment/staged-generation-companion-service.ts";
import {
  ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES,
  ENRICHMENT_STAGING_COMPANION_PATH,
  ENRICHMENT_STAGING_COMPANION_SCHEMA,
  enrichmentStagingCompanionErrorCode,
} from "../lib/enrichment/staged-generation-companion-wire.ts";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 32_110;
const DEFAULT_DASHBOARD_URL = "http://localhost:3000";
const MAX_JOB_MS = 30 * 60 * 1_000;
// Acquisition has a bounded lifetime independent of any dashboard browser tab.
const NORMAL_SOURCE_JOB_MS = 3 * 60 * 60 * 1_000;
const MAX_SCHEDULE_BODY_BYTES = 128;
const MAX_SOURCE_ACQUISITION_BODY_BYTES = 1_024;
const PRIMARY_IMAGE_SESSION_MAX_ATTEMPTS = 25;
const PERFORMANCE_TELEMETRY_HEADER = "x-performance-telemetry";
const PERFORMANCE_TELEMETRY_EVENTS_V1 = "events-v1";
const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENRICHMENT_STAGING_ROOT = process.env.NODE_ENV === "test" &&
    process.env.AUCTION_DISCOVERY_TEST_ENRICHMENT_STAGING_ROOT?.trim()
  ? resolve(process.env.AUCTION_DISCOVERY_TEST_ENRICHMENT_STAGING_ROOT)
  : resolve(PROJECT_ROOT, "work", "enrichment-staging");

function positivePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1_024 && parsed <= 65_535
    ? parsed
    : DEFAULT_PORT;
}

function isLoopbackAddress(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::ffff:127.0.0.1" || value === "::1";
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function hasLoadedRuntimeRevision(request: IncomingMessage): boolean {
  return request.headers[RUNTIME_REVISION_HEADER] === runtimeRevision;
}

function rejectRuntimeRevisionMismatch(
  response: ServerResponse,
  origin: string | undefined,
): void {
  json(response, 409, {
    error: RUNTIME_REVISION_MISMATCH_MESSAGE,
    code: "runtime_revision_mismatch",
  }, origin);
}

function json(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  origin?: string,
): void {
  const body = JSON.stringify(payload);
  const headers: Record<string, string | number> = {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(body);
}

function sourceAcquisitionRetryAfterMs(error: LocalSourceAcquisitionError): number | null {
  const retryAfterMs = error.retryAfterMs;
  const maximumRetryAfterMs = 10 * 365 * 24 * 60 * 60_000;
  return retryAfterMs !== null && Number.isSafeInteger(retryAfterMs) &&
      retryAfterMs > 0 && retryAfterMs <= maximumRetryAfterMs
    ? retryAfterMs
    : null;
}

const port = positivePort(process.env.AUCTION_DISCOVERY_IMAGE_PORT);
const capability = process.env.AUCTION_DISCOVERY_IMAGE_TOKEN?.trim() ?? "";
const dashboardUrl = process.env.AUCTION_DISCOVERY_URL?.trim() || DEFAULT_DASHBOARD_URL;
const allowedDashboardOrigin = DEFAULT_DASHBOARD_URL;
const runtimeRevision = loadedRuntimeRevision();
const supervisorInstanceId = loadedSupervisorInstanceId();

if (capability.length < 32) {
  throw new Error("AUCTION_DISCOVERY_IMAGE_TOKEN must contain at least 32 characters");
}

let activePrimaryImageSession: Promise<DirectSourceImageDrainSummary> | null = null;
let activeSourceAcquisition:
  Promise<LocalSourceAcquisitionResult | LocalSourceAcquisitionBatchResult> |
    null = null;
const activeEnrichmentStaging = new Set<Promise<void>>();
let activeSourceAcquisitionAbort: AbortController | null = null;
let sourceAcquisitionCleanupBlocked = false;
let scheduleMutationActive = false;
let shutdownRequested = false;

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function handleEnrichmentStagingRequest(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
): Promise<void> {
  const contentType = request.headers["content-type"]?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    enrichmentStagingJson(response, 415, {
      schemaVersion: ENRICHMENT_STAGING_COMPANION_SCHEMA,
      status: "error",
      code: "invalid_enrichment_staging_request",
    }, origin);
    return;
  }
  const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (
    Number.isFinite(declared) &&
    declared > ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES
  ) {
    enrichmentStagingJson(response, 413, {
      schemaVersion: ENRICHMENT_STAGING_COMPANION_SCHEMA,
      status: "error",
      code: "enrichment_staged_generation_oversized",
    }, origin);
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(await readRequestBody(
      request,
      ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES,
    )) as unknown;
  } catch (error) {
    const oversized = error instanceof Error && error.message === "request_too_large";
    enrichmentStagingJson(response, oversized ? 413 : 400, {
      schemaVersion: ENRICHMENT_STAGING_COMPANION_SCHEMA,
      status: "error",
      code: oversized
        ? "enrichment_staged_generation_oversized"
        : "invalid_enrichment_staging_request",
    }, origin);
    return;
  }
  if (stagingRequestDisconnected(request, response)) return;
  // Once this host operation begins, immutable publication may finish after
  // disconnect. The Worker ignores it unless the exact binding remains eligible.
  try {
    const result = await executeEnrichmentStagingCompanionRequest(
      value,
      ENRICHMENT_STAGING_ROOT,
    );
    enrichmentStagingJson(response, 200, {
      schemaVersion: ENRICHMENT_STAGING_COMPANION_SCHEMA,
      status: "ok",
      result,
    }, origin);
  } catch (error) {
    const code = enrichmentStagingCompanionErrorCode(error);
    const status = code === "enrichment_staged_generation_oversized"
      ? 413
      : code === "enrichment_staged_generation_tampered" ||
          code === "enrichment_staged_generation_ambiguous"
      ? 409
      : code === "enrichment_staged_generation_failed"
      ? 500
      : 400;
    enrichmentStagingJson(response, status, {
      schemaVersion: ENRICHMENT_STAGING_COMPANION_SCHEMA,
      status: "error",
      code,
    }, origin);
  }
}

function stagingRequestDisconnected(
  request: IncomingMessage,
  response: ServerResponse,
): boolean {
  return request.aborted || request.socket.destroyed || response.destroyed;
}

function enrichmentStagingJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  origin?: string,
): void {
  if (
    Buffer.byteLength(JSON.stringify(payload), "utf8") >
      ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES
  ) {
    json(response, 500, {
      schemaVersion: ENRICHMENT_STAGING_COMPANION_SCHEMA,
      status: "error",
      code: "enrichment_staged_generation_failed",
    }, origin);
    return;
  }
  json(response, status, payload, origin);
}

export async function handleScheduleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  runScheduleControl = runWindowsScheduleControl,
): Promise<void> {
  if (request.method === "GET") {
    try {
      const state = await runScheduleControl("Get");
      json(response, state.available ? 200 : 503, { ...state }, origin);
    } catch {
      json(response, 503, {
        error: "Windows schedule state is unavailable",
        code: "schedule_unavailable",
      }, origin);
    }
    return;
  }

  if (scheduleMutationActive) {
    json(response, 409, {
      error: "A schedule change is already running",
      code: "schedule_busy",
    }, origin);
    return;
  }

  if (request.method === "DELETE") {
    if (
      Number.parseInt(request.headers["content-length"] ?? "0", 10) !== 0 ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      json(response, 400, {
        error: "Schedule removal requests must have an empty body",
        code: "invalid_body",
      }, origin);
      return;
    }
    scheduleMutationActive = true;
    try {
      const state = await runScheduleControl("Remove");
      json(response, state.available ? 200 : 503, { ...state }, origin);
    } catch {
      json(response, 503, {
        error: "Windows schedule removal failed",
        code: "schedule_update_failed",
      }, origin);
    } finally {
      scheduleMutationActive = false;
    }
    return;
  }

  if (request.method !== "PUT") {
    json(response, 405, { error: "Method not allowed", code: "method_not_allowed" }, origin);
    return;
  }
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    json(response, 415, {
      error: "Schedule updates require JSON",
      code: "unsupported_media_type",
    }, origin);
    return;
  }

  scheduleMutationActive = true;
  try {
    let scheduleUpdate: ReturnType<typeof parseScheduleUpdateBody> = null;
    try {
      scheduleUpdate = parseScheduleUpdateBody(
        await readRequestBody(request, MAX_SCHEDULE_BODY_BYTES),
      );
    } catch {
      json(response, 413, {
        error: "Schedule update body is too large",
        code: "request_too_large",
      }, origin);
      return;
    }
    if (!scheduleUpdate) {
      json(response, 400, {
        error: "weekdays must contain one or two canonical names and localTime must use 24-hour HH:mm format",
        code: "invalid_schedule_time",
      }, origin);
      return;
    }

    try {
      const state = await runScheduleControl("Set", scheduleUpdate);
      json(response, state.available ? 200 : 503, { ...state }, origin);
    } catch {
      json(response, 503, {
        error: "Windows schedule update failed",
        code: "schedule_update_failed",
      }, origin);
    }
  } finally {
    scheduleMutationActive = false;
  }
}

async function handleNightlyRunRequest(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
): Promise<void> {
  if (request.method === "GET") {
    try {
      json(response, 200, { ...await readVisibleNightlyRun(runtimeRevision) }, origin);
    } catch (error) {
      const code = error instanceof NightlyVisibleControlError
        ? error.code
        : "visible_runner_contract_mismatch";
      json(response, code === "visible_runner_unavailable" ? 503 : 502, {
        error: error instanceof NightlyVisibleControlError
          ? error.message
          : "The visible nightly runner state could not be read",
        code,
      }, origin);
    }
    return;
  }

  if (request.method !== "POST") {
    json(response, 405, { error: "Method not allowed", code: "method_not_allowed" }, origin);
    return;
  }
  if (
    Number.parseInt(request.headers["content-length"] ?? "0", 10) !== 0 ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    json(response, 400, {
      error: "Nightly run requests must have an empty body",
      code: "invalid_body",
    }, origin);
    return;
  }

  const requestedRevision = request.headers[RUNTIME_REVISION_HEADER];
  if (typeof requestedRevision !== "string" || !isRuntimeRevision(requestedRevision)) {
    json(response, 409, {
      error: "The local runtime revision is unavailable; discovery was not started. Restart the supervised local stack.",
      code: "runtime_revision_unavailable",
    }, origin);
    return;
  }

  let checkoutRevision: string;
  let appRevision: string;
  try {
    [checkoutRevision, appRevision] = await Promise.all([
      computeRuntimeRevision(PROJECT_ROOT),
      readDashboardRuntimeRevision(),
    ]);
  } catch {
    json(response, 409, {
      error: "The local runtime revision is unavailable; discovery was not started. Restart the supervised local stack.",
      code: "runtime_revision_unavailable",
    }, origin);
    return;
  }
  if (
    requestedRevision !== runtimeRevision ||
    requestedRevision !== checkoutRevision ||
    requestedRevision !== appRevision
  ) {
    json(response, 409, {
      error: RUNTIME_REVISION_MISMATCH_MESSAGE,
      code: "runtime_revision_mismatch",
    }, origin);
    return;
  }

  try {
    const state = await launchVisibleNightlyRun(runtimeRevision);
    json(response, state.reused ? 200 : 202, { ...state }, origin);
  } catch (error) {
    const code = error instanceof NightlyVisibleControlError
      ? error.code
      : "visible_runner_launch_failed";
    json(response, code === "visible_runner_unavailable" ? 503 : 502, {
      error: error instanceof NightlyVisibleControlError
        ? error.message
        : "The visible nightly workflow could not be launched",
      code,
    }, origin);
  }
}

async function readDashboardRuntimeRevision(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`${dashboardUrl}/api/internal/runtime-revision`, {
      cache: "no-store",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("dashboard_runtime_revision_unavailable");
    const value = await response.json() as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("dashboard_runtime_revision_invalid");
    }
    const payload = value as Record<string, unknown>;
    if (
      payload.schemaVersion !== RUNTIME_REVISION_SCHEMA_VERSION ||
      !isRuntimeRevision(payload.revision)
    ) {
      throw new Error("dashboard_runtime_revision_invalid");
    }
    return payload.revision;
  } finally {
    clearTimeout(timer);
  }
}

type CompanionSourceId = SourceId;

type SourceAcquisitionInput =
  | {
      readonly sourceId: CompanionSourceId;
      readonly mode: LocalSourceAcquisitionMode;
      readonly trigger: LocalSourceAcquisitionTrigger;
      readonly retryFailedImages: boolean;
      readonly repairMissingImageEvidence: boolean;
      readonly deferPrimaryImages: boolean;
    }
  | {
      readonly sourceIds: readonly CompanionSourceId[];
      readonly mode: "catalog";
      readonly trigger: LocalSourceAcquisitionTrigger;
    };

function isCompanionSourceId(value: unknown): value is CompanionSourceId {
  return typeof value === "string" && findSourceAdapter(value) !== undefined;
}

export function parseSourceAcquisitionBody(
  body: string,
): SourceAcquisitionInput | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) return null;
  const record = value as Record<string, unknown>;
  if (record.sourceIds !== undefined) {
    if (
      Object.keys(record).some((key) =>
        key !== "sourceIds" && key !== "mode" && key !== "trigger"
      ) ||
      !Array.isArray(record.sourceIds) ||
      record.sourceIds.length < 2 ||
      record.sourceIds.length > 3 ||
      record.sourceIds.some((sourceId) => !isCompanionSourceId(sourceId)) ||
      new Set(record.sourceIds).size !== record.sourceIds.length ||
      record.mode !== "catalog" ||
      (record.trigger !== "manual" && record.trigger !== "scheduled")
    ) return null;
    return {
      sourceIds: record.sourceIds as CompanionSourceId[],
      mode: "catalog",
      trigger: record.trigger,
    };
  }
  if (
    Object.keys(record).some((key) =>
      key !== "sourceId" &&
      key !== "mode" &&
      key !== "trigger" &&
      key !== "retryFailedImages" &&
      key !== "repairMissingImageEvidence" &&
      key !== "deferPrimaryImages"
    ) ||
    (
      !isCompanionSourceId(record.sourceId)
    ) ||
    (
      record.mode !== "canary" &&
      record.mode !== "catalog" &&
      record.mode !== "continuation" &&
      record.mode !== "normal"
    ) ||
    (
      record.trigger !== "manual" &&
      record.trigger !== "scheduled"
    ) ||
    (
      record.retryFailedImages !== undefined &&
      typeof record.retryFailedImages !== "boolean"
    ) ||
    (
      record.repairMissingImageEvidence !== undefined &&
      typeof record.repairMissingImageEvidence !== "boolean"
    ) ||
    (
      record.deferPrimaryImages !== undefined &&
      typeof record.deferPrimaryImages !== "boolean"
    ) ||
    (
      record.retryFailedImages === true &&
      record.mode !== "continuation"
    ) ||
    (
      record.repairMissingImageEvidence === true &&
      record.mode !== "continuation"
    ) ||
    (
      record.deferPrimaryImages === true &&
      record.mode !== "continuation"
    ) ||
    (
      record.retryFailedImages === true &&
      record.repairMissingImageEvidence === true
    ) ||
    (
      record.deferPrimaryImages === true &&
      (
        record.retryFailedImages === true ||
        record.repairMissingImageEvidence === true
      )
    )
  ) return null;
  return {
    sourceId: record.sourceId,
    mode: record.mode,
    trigger: record.trigger,
    retryFailedImages: record.retryFailedImages === true,
    repairMissingImageEvidence:
      record.repairMissingImageEvidence === true,
    deferPrimaryImages: record.deferPrimaryImages === true,
  };
}

async function handleSourceAcquisitionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
): Promise<void> {
  if (
    !(request.headers["content-type"] ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    json(response, 415, {
      error: "Source acquisition requests require JSON",
      code: "unsupported_media_type",
    }, origin);
    return;
  }
  let body: string;
  try {
    body = await readRequestBody(
      request,
      MAX_SOURCE_ACQUISITION_BODY_BYTES,
    );
  } catch {
    json(response, 413, {
      error: "Source acquisition request is too large",
      code: "request_too_large",
    }, origin);
    return;
  }
  const input = parseSourceAcquisitionBody(body);
  if (!input) {
    json(response, 400, {
      error: "Source acquisition request is invalid",
      code: "invalid_source_acquisition_request",
    }, origin);
    return;
  }
  if (activeSourceAcquisition) {
    json(response, 409, {
      error: "A source acquisition is already running",
      code: "source_acquisition_busy",
    }, origin);
    return;
  }
  if (
    activePrimaryImageSession !== null
  ) {
    json(response, 409, {
      error: "Another canonical companion mutation is already running",
      code: "companion_mutation_busy",
    }, origin);
    return;
  }
  if (sourceAcquisitionCleanupBlocked) {
    json(response, 503, {
      error:
        "Source acquisition is blocked after owned browser cleanup failed; restart the supervised local stack",
      code: "source_acquisition_cleanup_blocked",
    }, origin);
    return;
  }

  activeSourceAcquisitionAbort = new AbortController();
  const jobAbort = activeSourceAcquisitionAbort;
  const abortOnClientDisconnect = () => {
    if (!response.writableEnded) jobAbort.abort();
  };
  request.once("aborted", abortOnClientDisconnect);
  response.once("close", abortOnClientDisconnect);
  const telemetry = request.headers[PERFORMANCE_TELEMETRY_HEADER] ===
      PERFORMANCE_TELEMETRY_EVENTS_V1
    ? new PerformanceTelemetryBuffer({
        capacity: LOCAL_SOURCE_ACQUISITION_MAX_TELEMETRY_EVENTS,
        overflow: "throw",
      })
    : null;
  const telemetryOptions = telemetry === null
    ? {}
    : {
        telemetry,
        telemetryContext: "sourceId" in input
          ? { sourceId: input.sourceId }
          : {},
      };
  activeSourceAcquisition = "sourceIds" in input
    ? runLocalSourceAcquisitionBatch({
        sourceIds: input.sourceIds,
        trigger: input.trigger,
        dashboardUrl,
        capability,
        runtimeRevision,
        signal: jobAbort.signal,
        ...telemetryOptions,
      })
    : runLocalSourceAcquisition({
        sourceId: input.sourceId,
        mode: input.mode,
        trigger: input.trigger,
        dashboardUrl,
        capability,
        runtimeRevision,
        retryFailedImages: input.retryFailedImages,
        repairMissingImageEvidence: input.repairMissingImageEvidence,
        deferPrimaryImages: input.deferPrimaryImages,
        signal: jobAbort.signal,
        ...telemetryOptions,
      });
  const job = activeSourceAcquisition;
  const sourceJobTimeoutMs =
    input.mode === "normal" || input.mode === "catalog"
    ? NORMAL_SOURCE_JOB_MS
    : MAX_JOB_MS;
  const timer = setTimeout(() => {
    jobAbort.abort();
    if (!response.writableEnded) {
      json(response, 504, {
        error: "Source acquisition exceeded its wall-time guard",
        code: "source_acquisition_timeout",
      }, origin);
    }
  }, sourceJobTimeoutMs);
  void job.then(
    (result) => {
      if (
        "results" in result &&
        result.results.some(({ error }) =>
          error?.upstreamCode === "cleanup_failed"
        )
      ) {
        sourceAcquisitionCleanupBlocked = true;
      }
      if (!response.writableEnded) {
        json(response, 200, telemetry === null
          ? { ...result }
          : {
              ...result,
              performanceTelemetry: telemetry.drain(),
            }, origin);
      }
    },
    (error: unknown) => {
      if (
        error instanceof LocalSourceAcquisitionError &&
        error.upstreamCode === "cleanup_failed"
      ) {
        sourceAcquisitionCleanupBlocked = true;
      }
      if (response.writableEnded) return;
      if (error instanceof LocalSourceAcquisitionError) {
        json(response, error.status, {
          error: error.message,
          code: error.code,
          sourceId: error.sourceId,
          upstreamCode: error.upstreamCode,
          upstreamError: error.upstreamError,
          upstreamDiagnostic: error.upstreamDiagnostic,
          ...(error.accessReceipt === null ? {} : { accessReceipt: error.accessReceipt }),
          retryAfterMs: sourceAcquisitionRetryAfterMs(error),
        }, origin);
        return;
      }
      json(response, 502, {
        error: "The local source acquisition failed",
        code: "source_acquisition_failed",
      }, origin);
    },
  ).finally(() => {
    clearTimeout(timer);
    request.off("aborted", abortOnClientDisconnect);
    response.off("close", abortOnClientDisconnect);
    if (activeSourceAcquisition === job) {
      activeSourceAcquisition = null;
      activeSourceAcquisitionAbort = null;
    }
  });
}

async function handlePrimaryImageSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
): Promise<void> {
  if (
    !(request.headers["content-type"] ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    json(response, 415, {
      error: "Primary image session requests require JSON",
      code: "unsupported_media_type",
    }, origin);
    return;
  }
  let body: string;
  try {
    body = await readRequestBody(request, MAX_PRIMARY_IMAGE_SESSION_BODY_BYTES);
  } catch {
    json(response, 413, {
      error: "Primary image session request is too large",
      code: "request_too_large",
    }, origin);
    return;
  }
  let input: ReturnType<typeof parsePrimaryImageSessionBody>;
  try {
    input = parsePrimaryImageSessionBody(body);
  } catch {
    json(response, 400, {
      error: "Primary image session request is invalid",
      code: "invalid_primary_image_session_request",
    }, origin);
    return;
  }
  if (
    activePrimaryImageSession !== null ||
    activeSourceAcquisition !== null
  ) {
    json(response, 409, {
      error: "Another canonical companion mutation is already running",
      code: "companion_mutation_busy",
    }, origin);
    return;
  }

  // The scheduler has handed its exact claim back before this bounded drain.
  // It separately proves the selected source's durable queue decreased, so a
  // successful HTTP response can never masquerade as image progress.
  activePrimaryImageSession = runDirectSourceImageDrain({
    baseUrl: dashboardUrl,
    maxAttempts: PRIMARY_IMAGE_SESSION_MAX_ATTEMPTS,
    maxConcurrency: 1,
  }, {}, [input.sourceId]);
  const job = activePrimaryImageSession;
  const timer = setTimeout(() => {
    if (!response.writableEnded) {
      json(response, 504, {
        error: "Primary image session exceeded its wall-time guard",
        code: "primary_image_session_timeout",
      }, origin);
    }
  }, MAX_JOB_MS);
  void job.then(
    (result) => {
      if (!response.writableEnded) {
        json(response, 200, {
          schemaVersion: "auction-discovery-primary-image-session-v1",
          status: "completed",
          sourceId: input.sourceId,
          attempted: result.attempted,
          archived: result.archived,
          failed: result.failed,
          remainingWork: result.remainingQueue,
          stopReason: result.stopReason,
        }, origin);
      }
    },
    () => {
      if (!response.writableEnded) {
        json(response, 502, {
          error: "The primary image session failed",
          code: "primary_image_session_failed",
        }, origin);
      }
    },
  ).finally(() => {
    clearTimeout(timer);
    if (activePrimaryImageSession === job) activePrimaryImageSession = null;
  });
}

export const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const expectedHost = `${HOST}:${port}`;
  const origin = typeof request.headers.origin === "string" &&
    request.headers.origin === allowedDashboardOrigin
    ? request.headers.origin
    : undefined;
  if (!isLoopbackAddress(request.socket.remoteAddress) || request.headers.host !== expectedHost) {
    json(response, 403, { error: "Local companion rejected the request", code: "local_only" });
    return;
  }

  if (request.method === "GET" && request.url === "/v1/health") {
    json(response, 200, {
      status: "ready",
      active: activePrimaryImageSession !== null || activeEnrichmentStaging.size > 0,
      primaryImageActive: activePrimaryImageSession !== null,
      sourceAcquisitionActive: activeSourceAcquisition !== null,
      sourceFrontierAcquisitionActive: false,
      sourceFrontierAcquisitionCount: 0,
      preferenceV2ScoringActive: false,
      sourcePublicationQueueDepth: sourceAcquisitionCallbackQueueDepth(),
      sourceAcquisitionCleanupBlocked,
      scheduleMutationActive,
      runtimeRevisionSchema: RUNTIME_REVISION_SCHEMA_VERSION,
      runtimeRevision,
      supervisorInstanceId,
    }, origin);
    return;
  }

  const capabilityAuthorized = tokenMatches(
    request.headers["x-auction-discovery-capability"] as string | undefined,
    capability,
  );
  const companionAuthorized = origin !== undefined || capabilityAuthorized;
  if (shutdownRequested && request.url !== "/v1/shutdown") {
    json(response, 503, { error: "Local companion is shutting down", code: "companion_shutting_down" }, origin);
    return;
  }

  if (request.method === "POST" && request.url === "/v1/shutdown") {
    if (!capabilityAuthorized) {
      json(response, 403, {
        error: "Shutdown requires the process-lifetime capability",
        code: "invalid_capability",
      });
      return;
    }
    shutdownRequested = true;
    json(response, 202, {
      status: "shutting_down",
    });
    setImmediate(close);
    return;
  }

  if (request.method === "OPTIONS" && request.url === "/v1/schedule" && origin) {
    response.writeHead(204, {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, PUT, DELETE",
      "access-control-allow-origin": origin,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin",
    });
    response.end();
    return;
  }

  if (request.url === "/v1/schedule") {
    if (!companionAuthorized) {
      json(response, 403, {
        error: "Schedule request origin is invalid",
        code: "invalid_origin",
      });
      return;
    }
    void handleScheduleRequest(request, response, origin);
    return;
  }

  if (request.method === "OPTIONS" && request.url === "/v1/nightly-run" && origin) {
    response.writeHead(204, {
      "access-control-allow-headers": `content-type, ${RUNTIME_REVISION_HEADER}`,
      "access-control-allow-methods": "GET, POST",
      "access-control-allow-origin": origin,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin",
    });
    response.end();
    return;
  }

  if (request.url === "/v1/nightly-run") {
    if (!companionAuthorized) {
      json(response, 403, {
        error: "Nightly run request origin is invalid",
        code: "invalid_origin",
      });
      return;
    }
    void handleNightlyRunRequest(request, response, origin);
    return;
  }

  if (
    request.method === "OPTIONS" &&
    request.url === "/v1/source-acquisition" &&
    origin
  ) {
    response.writeHead(204, {
      "access-control-allow-headers":
        `content-type, ${PERFORMANCE_TELEMETRY_HEADER}, ${RUNTIME_REVISION_HEADER}`,
      "access-control-allow-methods": "POST",
      "access-control-allow-origin": origin,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin",
    });
    response.end();
    return;
  }

  if (request.url === "/v1/source-acquisition") {
    if (request.method !== "POST") {
      json(response, 405, {
        error: "Method not allowed",
        code: "method_not_allowed",
      }, origin);
      return;
    }
    if (!companionAuthorized) {
      json(response, 403, {
        error: "Source acquisition request origin is invalid",
        code: "invalid_origin",
      });
      return;
    }
    if (!hasLoadedRuntimeRevision(request)) {
      rejectRuntimeRevisionMismatch(response, origin);
      return;
    }
    void handleSourceAcquisitionRequest(request, response, origin);
    return;
  }

  if (
    request.method === "OPTIONS" &&
    request.url === "/v1/primary-image-session" &&
    origin
  ) {
    response.writeHead(204, {
      "access-control-allow-headers": `content-type, ${RUNTIME_REVISION_HEADER}`,
      "access-control-allow-methods": "POST",
      "access-control-allow-origin": origin,
      "access-control-max-age": "600",
      "cache-control": "no-store",
      vary: "Origin",
    });
    response.end();
    return;
  }

  if (request.url === "/v1/primary-image-session") {
    if (request.method !== "POST") {
      json(response, 405, {
        error: "Method not allowed",
        code: "method_not_allowed",
      }, origin);
      return;
    }
    if (!companionAuthorized) {
      json(response, 403, {
        error: "Primary image request origin is invalid",
        code: "invalid_origin",
      }, origin);
      return;
    }
    if (!hasLoadedRuntimeRevision(request)) {
      rejectRuntimeRevisionMismatch(response, origin);
      return;
    }
    void handlePrimaryImageSessionRequest(request, response, origin);
    return;
  }

  if (request.url === ENRICHMENT_STAGING_COMPANION_PATH) {
    if (request.method !== "POST") {
      json(response, 405, {
        error: "Method not allowed",
        code: "method_not_allowed",
      }, origin);
      return;
    }
    if (!capabilityAuthorized) {
      json(response, 403, {
        error: "Enrichment staging requires the process-lifetime capability",
        code: "invalid_capability",
      }, origin);
      return;
    }
    if (!hasLoadedRuntimeRevision(request)) {
      rejectRuntimeRevisionMismatch(response, origin);
      return;
    }
    if (!optionalAiCapabilities().enrichment) {
      json(response, 503, {
        error: "Optional enrichment providers and models are not configured",
        code: "enrichment_not_configured",
      }, origin);
      return;
    }
    if (shutdownRequested || stagingRequestDisconnected(request, response)) {
      if (!response.destroyed) {
        json(response, 503, {
          error: "Enrichment staging is unavailable during shutdown",
          code: "companion_shutting_down",
        }, origin);
      }
      return;
    }
    const job = handleEnrichmentStagingRequest(request, response, origin);
    activeEnrichmentStaging.add(job);
    void job.then(
      () => activeEnrichmentStaging.delete(job),
      () => activeEnrichmentStaging.delete(job),
    );
    return;
  }

  json(response, 404, { error: "Not found", code: "not_found" });
});

server.requestTimeout = NORMAL_SOURCE_JOB_MS + 5_000;
server.headersTimeout = 10_000;
let shutdown: Promise<void> | null = null;

function close(): void {
  if (shutdown) return;
  shutdownRequested = true;
  activeSourceAcquisitionAbort?.abort();

  const sourceAcquisition = activeSourceAcquisition;
  const primaryImageSession = activePrimaryImageSession;
  const enrichmentStaging = [...activeEnrichmentStaging]
    .map((job) => job.catch(() => undefined));
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeIdleConnections?.();
  });
  shutdown = Promise.all([
    serverClosed,
    sourceAcquisition?.catch(() => undefined) ?? Promise.resolve(),
    primaryImageSession?.catch(() => undefined) ?? Promise.resolve(),
    ...enrichmentStaging,
  ]).then(() => undefined);
  void shutdown.then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(
        error instanceof Error
          ? `Local companion shutdown failed: ${error.message}`
          : "Local companion shutdown failed.",
      );
      process.exitCode = 1;
    },
  );
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()
) {
  server.listen(port, HOST, () => {
    console.log(`Local acquisition companion listening on http://${HOST}:${port}`);
  });
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
