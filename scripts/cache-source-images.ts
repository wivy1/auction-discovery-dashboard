import { pathToFileURL } from "node:url";
import {
  detectImageContentType,
} from "../lib/images/archive.ts";
import {
  isDirectImageSourceId,
  SUPPORTED_DIRECT_IMAGE_SOURCE_IDS,
  type DirectImageSourceId,
} from "../lib/images/direct-source-registry.ts";
import type {
  DirectImageFailureCode,
} from "../lib/images/browser-failure.ts";
import type { PipelineWorkClaimIdentity } from "../lib/pipeline/work-queue.ts";
import { findSourceAdapter, findSourceRegistration } from "../lib/sources/registry.ts";
import {
  ConservativeRequestController,
  type SourceRequestController,
} from "../lib/sources/request-control.ts";
import { sourceRegistrationAccessGrant } from "../lib/sources/registration.ts";
import { SourceAccessChallengeError } from "../lib/sources/types.ts";

export {
  SUPPORTED_DIRECT_IMAGE_SOURCE_IDS,
  type DirectImageSourceId,
} from "../lib/images/direct-source-registry.ts";

const DEFAULT_BASE_URL = "http://localhost:3000";
const QUEUE_LIMIT = 25;
const DEFAULT_MAX_ATTEMPTS = 100;
const MAX_ATTEMPTS = 100_000;
const DEFAULT_MAX_CONCURRENCY = 3;
const MAX_CONCURRENCY = 3;
const MAX_BUFFERED_IMAGE_COMMITS = 8;
const PROGRESS_INTERVAL_MS = 30_000;
const SOURCE_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_LOCAL_JSON_BYTES = 1024 * 1024;
export const MAX_PRIMARY_IMAGE_SESSION_BODY_BYTES = 2 * 1024;
const IMAGE_CLIENT_HEADER = "x-auction-discovery-image-client";
const IMAGE_CLIENT_ID = "browser-sidecar-v1";

const SUPPORTED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export interface SourceImageSweepOptions {
  readonly baseUrl: string;
  readonly maxAttempts: number;
  readonly maxConcurrency?: number;
  readonly expectedTotal?: number | null;
}

export interface PrimaryImageSessionRequest {
  readonly sourceId: DirectImageSourceId;
  readonly claim: PipelineWorkClaimIdentity & {
    readonly stage: "primary_image";
    readonly subjectType: "listing";
  };
}

/** Strict capability body for one bounded source-stage image drain. */
export function parsePrimaryImageSessionBody(body: string): PrimaryImageSessionRequest {
  if (Buffer.byteLength(body) > MAX_PRIMARY_IMAGE_SESSION_BODY_BYTES) {
    throw new RangeError("primary image session body is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new TypeError("primary image session body must be valid JSON");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["sourceId", "claim"]) ||
      typeof value.sourceId !== "string" || !isDirectImageSourceId(value.sourceId) ||
      !isRecord(value.claim) || !hasExactKeys(value.claim, [
        "stage",
        "subjectType",
        "subjectId",
        "owner",
        "inputHash",
        "revision",
      ]) || value.claim.stage !== "primary_image" || value.claim.subjectType !== "listing" ||
      !isBoundedText(value.claim.subjectId, 512) ||
      !isBoundedText(value.claim.owner, 256) || !isSha256(value.claim.inputHash) ||
      !Number.isSafeInteger(value.claim.revision) || Number(value.claim.revision) < 1) {
    throw new TypeError("primary image session body does not match its exact claim contract");
  }
  return Object.freeze({
    sourceId: value.sourceId,
    claim: Object.freeze({
      stage: "primary_image" as const,
      subjectType: "listing" as const,
      subjectId: value.claim.subjectId,
      owner: value.claim.owner,
      inputHash: value.claim.inputHash,
      revision: Number(value.claim.revision),
    }),
  });
}

export interface QueuedSourceImage {
  readonly id: string;
  readonly listingId: string;
  readonly source: DirectImageSourceId;
  readonly sourceListingId: string;
  readonly listingTitle: string;
  readonly listingUrl: string;
  readonly sourceUrl: string;
  readonly fetchUrl: string;
  readonly representation: "canonical" | "observed_thumbnail";
  readonly downloadStatus: "pending" | "failed";
  readonly acquisitionMethod: "browser" | "direct" | null;
  readonly attemptCount: number;
  readonly lastAttemptedAt: string | null;
  readonly downloadErrorCode: string | null;
  readonly workInputHash: string;
  readonly workRevision: number;
  readonly sourceImageIdentityHash: string;
}

export interface SourceImageTrackerEvent {
  readonly event: string;
  readonly sourceId: DirectImageSourceId | "all_supported_direct";
  readonly [key: string]: unknown;
}

export interface DirectSourceImageResult {
  readonly sourceId: DirectImageSourceId;
  readonly attempted: number;
  readonly archived: number;
  readonly failed: number;
  readonly stopReason:
    | null
    | "canary_failed"
    | "bulk_circuit_open"
    | "queue_window_exhausted";
}

export interface DirectSourceImageDrainSummary {
  readonly event: "source_image_drain_summary";
  readonly sourceId: "all_supported_direct";
  readonly sourceIds: readonly DirectImageSourceId[];
  readonly status: "completed" | "partial";
  readonly attempted: number;
  readonly archived: number;
  readonly failed: number;
  readonly remainingQueue: boolean;
  readonly stopReason: null | "max_attempts_reached" | "source_blocked";
  readonly sources: readonly DirectSourceImageResult[];
}

export interface SourceImageSweepDependencies {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly track?: (event: SourceImageTrackerEvent) => void;
}

interface DirectSourceState {
  readonly sourceId: DirectImageSourceId;
  controller: SourceRequestController;
  readonly createController: () => SourceRequestController;
  controllerEpoch: number;
  readonly attemptedImageRepresentations: Set<string>;
  queue: QueuedSourceImage[];
  attempted: number;
  archived: number;
  failed: number;
  complete: boolean;
  stopReason: DirectSourceImageResult["stopReason"];
}

interface AcquiredSourceImage {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

type AcquisitionResult =
  | {
      readonly ok: true;
      readonly state: DirectSourceState;
      readonly image: QueuedSourceImage;
      readonly acquired: AcquiredSourceImage;
    }
  | {
      readonly ok: false;
      readonly state: DirectSourceState;
      readonly image: QueuedSourceImage;
      readonly failure: DirectImageAcquisitionError;
    };

const queuedImageKeys = new Set([
  "id",
  "listingId",
  "source",
  "sourceListingId",
  "listingTitle",
  "listingUrl",
  "sourceUrl",
  "fetchUrl",
  "representation",
  "downloadStatus",
  "acquisitionMethod",
  "attemptCount",
  "lastAttemptedAt",
  "downloadErrorCode",
  "workInputHash",
  "workRevision",
  "sourceImageIdentityHash",
]);

export class DirectImageAcquisitionError extends Error {
  constructor(
    readonly code: DirectImageFailureCode,
    readonly circuitOpen: boolean,
    readonly sourceId: DirectImageSourceId = "image",
  ) {
    super(`${sourceId} direct image acquisition failed (${code}).`);
    this.name = "DirectImageAcquisitionError";
  }
}

class LocalImageApiError extends Error {
  constructor(readonly code: string) {
    super(`Local image API failed (${code}).`);
    this.name = "LocalImageApiError";
  }
}

export function parseSourceImageSweepArgs(
  argv: readonly string[],
): SourceImageSweepOptions | null {
  let baseUrl = DEFAULT_BASE_URL;
  let maxAttempts = DEFAULT_MAX_ATTEMPTS;
  let maxConcurrency = DEFAULT_MAX_CONCURRENCY;
  let expectedTotal: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--base-url") {
      baseUrl = argv[++index] ?? "";
    } else if (value === "--max-attempts") {
      maxAttempts = Number.parseInt(argv[++index] ?? "", 10);
    } else if (value === "--max-concurrency") {
      maxConcurrency = Number.parseInt(argv[++index] ?? "", 10);
    } else if (value === "--expected-total") {
      expectedTotal = Number.parseInt(argv[++index] ?? "", 10);
    } else if (value === "--help" || value === "-h") {
      console.log([
        "Usage: scripts\\cache-source-images.cmd [options]",
        "",
        "  --base-url URL       Loopback dashboard origin (default http://localhost:3000)",
        "  --max-attempts N     Session ceiling from 1 to 100000 (default 100)",
        "  --max-concurrency N  Independent source lanes from 1 to 3 (default 3)",
        "  --expected-total N   Optional starting queue total for remaining/ETA output",
        "",
        "Sources and image URLs come only from registered adapters and stored primary-image queues.",
      ].join("\n"));
      return null;
    } else {
      throw new Error(`Unknown argument ${value}`);
    }
  }

  baseUrl = normalizeLoopbackBaseUrl(baseUrl);
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > MAX_ATTEMPTS
  ) {
    throw new Error("--max-attempts must be between 1 and 100000");
  }
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > MAX_CONCURRENCY
  ) {
    throw new Error("--max-concurrency must be between 1 and 3");
  }
  if (
    expectedTotal !== null &&
    (!Number.isSafeInteger(expectedTotal) || expectedTotal < 1 || expectedTotal > MAX_ATTEMPTS)
  ) {
    throw new Error("--expected-total must be between 1 and 100000");
  }
  return { baseUrl, maxAttempts, maxConcurrency, expectedTotal };
}

export async function readBoundedSourceImage(
  response: Response,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<AcquiredSourceImage> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_IMAGE_BYTES
  ) {
    throw new RangeError("Image byte limit is invalid");
  }
  const rawLength = response.headers.get("content-length");
  if (rawLength !== null && !/^\d+$/u.test(rawLength.trim())) {
    await response.body?.cancel().catch(() => undefined);
    throw new DirectImageAcquisitionError("direct_contract_mismatch", true);
  }
  const advertisedLength = rawLength === null ? null : Number(rawLength.trim());
  if (advertisedLength === 0) {
    await response.body?.cancel().catch(() => undefined);
    throw new DirectImageAcquisitionError("direct_http_404", false);
  }
  const rawContentType = response.headers.get("content-type");
  const declaredContentType =
    rawContentType?.split(";", 1)[0]!.trim().toLowerCase() ?? "";
  const contentType = declaredContentType === "image/jpg"
    ? "image/jpeg"
    : declaredContentType;
  if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
    await response.body?.cancel().catch(() => undefined);
    throw new DirectImageAcquisitionError("direct_unsupported_type", true);
  }
  if (
    advertisedLength !== null &&
    (!Number.isSafeInteger(advertisedLength) || advertisedLength > maxBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new DirectImageAcquisitionError("direct_too_large", false);
  }
  if (!response.body) {
    throw new DirectImageAcquisitionError("direct_contract_mismatch", true);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("direct image exceeded byte limit");
        throw new DirectImageAcquisitionError("direct_too_large", false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (byteLength === 0) {
    throw new DirectImageAcquisitionError("direct_signature_mismatch", true);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const detected = detectImageContentType(bytes);
  if (
    detected === null ||
    (
      contentType !== "application/octet-stream" &&
      contentType !== detected
    )
  ) {
    throw new DirectImageAcquisitionError("direct_signature_mismatch", true);
  }
  return { bytes, contentType: detected };
}

/**
 * Drains already-stored direct primary-image identities. Network acquisition
 * may overlap across independent sources, but every R2/D1 content or failure
 * callback passes through one process-local FIFO. This process must therefore
 * be the exclusive primary-image worker while it runs.
 */
export async function runDirectSourceImageDrain(
  options: SourceImageSweepOptions,
  dependencies: SourceImageSweepDependencies = {},
  sourceIds: readonly DirectImageSourceId[] = SUPPORTED_DIRECT_IMAGE_SOURCE_IDS,
): Promise<DirectSourceImageDrainSummary> {
  const baseUrl = normalizeLoopbackBaseUrl(options.baseUrl);
  if (
    !Number.isSafeInteger(options.maxAttempts) ||
    options.maxAttempts < 1 ||
    options.maxAttempts > MAX_ATTEMPTS
  ) {
    throw new RangeError("Source image maxAttempts must be between 1 and 100000");
  }
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  if (
    !Number.isSafeInteger(maxConcurrency) ||
    maxConcurrency < 1 ||
    maxConcurrency > MAX_CONCURRENCY
  ) {
    throw new RangeError("Source image maxConcurrency must be between 1 and 3");
  }
  const selectedSourceIds = validateDirectSourceIds(sourceIds);
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const track = dependencies.track ?? (() => undefined);
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = now();
  const states: DirectSourceState[] = [];
  for (const sourceId of selectedSourceIds) {
    const adapter = findSourceAdapter(sourceId);
    if (!adapter || !adapter.manifest.requests.allowedImageHosts?.length) {
      throw new Error(`Direct primary-image lane is unavailable for ${sourceId}`);
    }
    const queue = await loadQueue(baseUrl, sourceId, fetchImpl);
    const createController = (): SourceRequestController =>
      new ConservativeRequestController(
        adapter.manifest,
        sourceRegistrationAccessGrant(findSourceRegistration(sourceId), true),
        { fetch: fetchImpl, now, sleep },
      );
    states.push({
      sourceId,
      controller: createController(),
      createController,
      controllerEpoch: 1,
      attemptedImageRepresentations: new Set(),
      queue,
      attempted: 0,
      archived: 0,
      failed: 0,
      complete: queue.length === 0,
      stopReason: null,
    });
  }
  track({
    event: "source_image_drain_started",
    sourceId: "all_supported_direct",
    sourceIds: selectedSourceIds,
    maxAttempts: options.maxAttempts,
    maxConcurrency,
    expectedTotal: options.expectedTotal ?? null,
    attempted: 0,
    archived: 0,
    failed: 0,
    elapsedMs: 0,
    ratePerMinute: 0,
  });

  const emitProgress = (phase: "interval" | "completed"): void => {
    const attempted = states.reduce((sum, state) => sum + state.attempted, 0);
    const archived = states.reduce((sum, state) => sum + state.archived, 0);
    const failed = states.reduce((sum, state) => sum + state.failed, 0);
    const elapsedMs = Math.max(0, now() - startedAt);
    const ratePerMinute = elapsedMs === 0 ? 0 : archived * 60_000 / elapsedMs;
    const expectedTotal = options.expectedTotal ?? null;
    const remaining = expectedTotal === null
      ? null
      : Math.max(0, expectedTotal - archived - failed);
    const etaSeconds = remaining === null || ratePerMinute <= 0
      ? null
      : Math.ceil(remaining / ratePerMinute * 60);
    track({
      event: "source_image_drain_progress",
      sourceId: "all_supported_direct",
      phase,
      attempted,
      archived,
      failed,
      elapsedMs,
      ratePerMinute: Number(ratePerMinute.toFixed(2)),
      expectedTotal,
      remaining,
      etaSeconds,
    });
  };
  const progressTimer = setInterval(() => emitProgress("interval"), PROGRESS_INTERVAL_MS);
  progressTimer.unref?.();

  try {
    const commitFifo = new SerialCommitFifo();
    const commitBuffer = new BoundedPermitPool(MAX_BUFFERED_IMAGE_COMMITS);
    const pendingCommits = new Set<Promise<void>>();
    const pendingCommitsBySource = new Map<DirectImageSourceId, Set<Promise<void>>>(
      states.map((state) => [state.sourceId, new Set<Promise<void>>()]),
    );
    let commitFailure: unknown = null;
    let attempted = 0;
    let nextStateIndex = 0;

    const awaitSourceCommits = async (sourceId: DirectImageSourceId): Promise<void> => {
      const sourceCommits = pendingCommitsBySource.get(sourceId)!;
      if (sourceCommits.size > 0) await Promise.all(sourceCommits);
      if (commitFailure !== null) throw commitFailure;
    };

    const drainSource = async (state: DirectSourceState): Promise<void> => {
      while (
        attempted < options.maxAttempts &&
        !state.complete &&
        state.stopReason === null
      ) {
        if (commitFailure !== null) throw commitFailure;
        let image = state.queue.find((entry) =>
          !state.attemptedImageRepresentations.has(imageAttemptIdentity(entry))
        );
        if (!image) {
          // A queue page can still contain rows whose exact local commits have
          // not landed. Settle this source's commits before deciding that an
          // attempted-only window is genuinely exhausted.
          await awaitSourceCommits(state.sourceId);
          state.queue = await loadQueue(baseUrl, state.sourceId, fetchImpl);
          image = state.queue.find((entry) =>
            !state.attemptedImageRepresentations.has(imageAttemptIdentity(entry))
          );
          if (!image) {
            if (state.queue.length === 0) state.complete = true;
            else state.stopReason = "queue_window_exhausted";
            continue;
          }
        }

        const releaseCommitBuffer = await commitBuffer.acquire();
        if (commitFailure !== null) {
          releaseCommitBuffer();
          throw commitFailure;
        }
        if (attempted >= options.maxAttempts) {
          releaseCommitBuffer();
          return;
        }
        if (!state.controller.hasRequestCapacity(imageRequestCost(state.sourceId))) {
          state.controller = state.createController();
          state.controllerEpoch += 1;
          if (!state.controller.hasRequestCapacity(imageRequestCost(state.sourceId))) {
            releaseCommitBuffer();
            throw new Error(`Direct image request cost exceeds ${state.sourceId} controller capacity`);
          }
          track({
            event: "source_image_controller_epoch_started",
            sourceId: state.sourceId,
            controllerEpoch: state.controllerEpoch,
            attempted: state.attempted,
            archived: state.archived,
            failed: state.failed,
          });
        }

        attempted += 1;
        state.attempted += 1;
        state.attemptedImageRepresentations.add(imageAttemptIdentity(image));
        track({
          event: "source_image_acquisition_started",
          sourceId: state.sourceId,
          imageId: image.id,
          sourceListingId: image.sourceListingId,
        });

        let result: AcquisitionResult;
        try {
          result = {
            ok: true,
            state,
            image,
            acquired: await fetchDirectSourceImage({ state, image }),
          } as const;
        } catch (error) {
          result = {
            ok: false,
            state,
            image,
            failure: normalizeDirectImageFailure(error, state.sourceId),
          } as const;
          if (result.failure.circuitOpen) {
            state.stopReason = state.attempted === 1
              ? "canary_failed"
              : "bulk_circuit_open";
          }
        }

        const sourceCommits = pendingCommitsBySource.get(state.sourceId)!;
        const commit = commitFifo.run(async () => {
          if (result.ok) {
            await uploadImage(baseUrl, result.image, result.acquired, fetchImpl);
            result.state.archived += 1;
            track({
              event: "source_image_archived",
              sourceId: result.state.sourceId,
              imageId: result.image.id,
              sourceListingId: result.image.sourceListingId,
              byteSize: result.acquired.bytes.byteLength,
              contentType: result.acquired.contentType,
            });
            return;
          }
          await reportFailure(baseUrl, result.image, result.failure, fetchImpl);
          result.state.failed += 1;
          track({
            event: "source_image_failed",
            sourceId: result.state.sourceId,
            imageId: result.image.id,
            sourceListingId: result.image.sourceListingId,
            errorCode: result.failure.code,
            circuitOpen: result.failure.circuitOpen,
          });
        });
        const settledCommit = commit.then(
          () => undefined,
          (error: unknown) => {
            commitFailure ??= error;
          },
        ).finally(() => {
          pendingCommits.delete(settledCommit);
          sourceCommits.delete(settledCommit);
          releaseCommitBuffer();
        });
        pendingCommits.add(settledCommit);
        sourceCommits.add(settledCommit);
      }
    };

    const workers = Array.from(
      { length: Math.min(maxConcurrency, states.length) },
      async () => {
        while (nextStateIndex < states.length && attempted < options.maxAttempts) {
          const state = states[nextStateIndex++]!;
          await drainSource(state);
        }
      },
    );
    const workerResults = await Promise.allSettled(workers);
    if (pendingCommits.size > 0) await Promise.all(pendingCommits);
    await commitFifo.idle();
    if (commitFailure !== null) throw commitFailure;
    const workerFailure = workerResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (workerFailure) throw workerFailure.reason;

    const sourceResults = Object.freeze(states.map((state) => Object.freeze({
      sourceId: state.sourceId,
      attempted: state.attempted,
      archived: state.archived,
      failed: state.failed,
      stopReason: state.stopReason,
    })));
    const archived = sourceResults.reduce((sum, source) => sum + source.archived, 0);
    const failed = sourceResults.reduce((sum, source) => sum + source.failed, 0);
    const sourceBlocked = sourceResults.some((source) => source.stopReason !== null);
    const maxReached = attempted >= options.maxAttempts && states.some((state) => !state.complete);
    const remainingQueue = sourceBlocked || maxReached || states.some((state) => !state.complete);
    emitProgress("completed");
    return Object.freeze({
      event: "source_image_drain_summary" as const,
      sourceId: "all_supported_direct" as const,
      sourceIds: selectedSourceIds,
      status: remainingQueue ? "partial" as const : "completed" as const,
      attempted,
      archived,
      failed,
      remainingQueue,
      stopReason: maxReached
        ? "max_attempts_reached" as const
        : sourceBlocked ? "source_blocked" as const : null,
      sources: sourceResults,
    });
  } finally {
    clearInterval(progressTimer);
  }
}

async function fetchDirectSourceImage(input: {
  readonly state: DirectSourceState;
  readonly image: QueuedSourceImage;
}): Promise<AcquiredSourceImage> {
  if (input.image.source !== input.state.sourceId) {
    throw new DirectImageAcquisitionError(
      "direct_contract_mismatch",
      true,
      input.state.sourceId,
    );
  }
  const manifest = findSourceAdapter(input.state.sourceId)?.manifest;
  if (!manifest) {
    throw new DirectImageAcquisitionError(
      "direct_contract_mismatch",
      true,
      input.state.sourceId,
    );
  }
  const maxBytes = manifest.requests.maxImageResponseBytes ??
    manifest.requests.maxResponseBytes;
  const maxRedirects = manifest.requests.maxRedirects ?? 0;
  let url = new URL(input.image.fetchUrl);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const result = await input.state.controller.fetchApprovedImage(
      url,
      async (response) => {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          return {
            kind: "redirect" as const,
            location: response.headers.get("location"),
          };
        }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw directHttpError(response.status, input.state.sourceId);
      }
        return {
          kind: "image" as const,
          acquired: await readBoundedSourceImage(
            response,
            maxBytes,
          ),
        };
      },
    );
    if (result.kind === "image") return result.acquired;
    if (redirectCount >= maxRedirects || result.location === null) {
      throw new DirectImageAcquisitionError(
        "direct_contract_mismatch",
        true,
        input.state.sourceId,
      );
    }
    let target: URL;
    try {
      target = new URL(result.location, url);
    } catch {
      throw new DirectImageAcquisitionError(
        "direct_contract_mismatch",
        true,
        input.state.sourceId,
      );
    }
    const redirectApproved = manifest.requests.allowedImageRedirects?.some((rule) =>
      rule.host.trim().toLowerCase() === target.hostname.toLowerCase() &&
      rule.pathPrefix.startsWith("/") && target.pathname.startsWith(rule.pathPrefix)
    ) ?? false;
    if (
      target.protocol !== "https:" || target.username || target.password ||
      target.port || target.hash || !redirectApproved
    ) {
      throw new DirectImageAcquisitionError(
        "direct_contract_mismatch",
        true,
        input.state.sourceId,
      );
    }
    url = target;
  }
  throw new DirectImageAcquisitionError(
    "direct_contract_mismatch",
    true,
    input.state.sourceId,
  );
}

function normalizeDirectImageFailure(
  error: unknown,
  sourceId: DirectImageSourceId,
): DirectImageAcquisitionError {
  if (error instanceof DirectImageAcquisitionError) {
    return error.sourceId === sourceId
      ? error
      : new DirectImageAcquisitionError(error.code, error.circuitOpen, sourceId);
  }
  if (error instanceof SourceAccessChallengeError) {
    return error.status === null
      ? new DirectImageAcquisitionError("direct_contract_mismatch", true, sourceId)
      : directHttpError(error.status, sourceId);
  }
  return new DirectImageAcquisitionError("direct_network_failed", true, sourceId);
}

class SerialCommitFifo {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const predecessor = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  idle(): Promise<void> {
    return this.#tail;
  }
}

class BoundedPermitPool {
  readonly #waiters: Array<(release: () => void) => void> = [];
  #available: number;

  constructor(capacity: number) {
    this.#available = capacity;
  }

  acquire(): Promise<() => void> {
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve(this.#releaseOnce());
    }
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(this.#releaseOnce());
      else this.#available += 1;
    };
  }
}

function validateDirectSourceIds(
  sourceIds: readonly DirectImageSourceId[],
): readonly DirectImageSourceId[] {
  const supported = new Set<string>(SUPPORTED_DIRECT_IMAGE_SOURCE_IDS);
  const unique = [...new Set(sourceIds)];
  if (
    unique.length !== sourceIds.length ||
    unique.some((sourceId) => !supported.has(sourceId))
  ) {
    throw new RangeError("Direct source image IDs must be a unique registered set");
  }
  return Object.freeze(unique);
}

function imageRequestCost(sourceId: DirectImageSourceId): number {
  const requests = findSourceAdapter(sourceId)?.manifest.requests;
  if (!requests) throw new Error(`Direct primary-image manifest is missing for ${sourceId}`);
  return 1 + (requests.maxRedirects ?? 0);
}

export function directSourceImageDrainExitCode(
  summary: DirectSourceImageDrainSummary,
): 0 | 2 {
  return summary.status === "completed" && !summary.remainingQueue ? 0 : 2;
}

async function loadQueue(
  baseUrl: string,
  sourceId: DirectImageSourceId,
  fetchImpl: typeof fetch,
): Promise<QueuedSourceImage[]> {
  const url = new URL("/api/images/cache-queue", baseUrl);
  url.searchParams.set("source", sourceId);
  url.searchParams.set("includeFailed", "true");
  url.searchParams.set("limit", String(QUEUE_LIMIT));
  const response = await localFetch(fetchImpl, url, {
    method: "GET",
    headers: { [IMAGE_CLIENT_HEADER]: IMAGE_CLIENT_ID },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalImageApiError(`queue_http_${response.status}`);
  }
  const payload = await readLocalJson(response);
  if (
    !isRecord(payload) ||
    !hasExactKeys(payload, [
      "images",
      "count",
      "limit",
      "sourceId",
      "workMode",
      "exactImageId",
      "includeFailed",
    ]) ||
    payload.sourceId !== sourceId ||
    (payload.workMode !== "optimized" && payload.workMode !== "canonical") ||
    payload.limit !== QUEUE_LIMIT ||
    payload.exactImageId !== null ||
    payload.includeFailed !== true ||
    !Array.isArray(payload.images) ||
    payload.images.length > QUEUE_LIMIT ||
    payload.count !== payload.images.length
  ) {
    throw new LocalImageApiError("queue_contract_mismatch");
  }
  const images = payload.images.map((image) => validateQueuedImage(image, sourceId));
  if (new Set(images.map((image) => image.id)).size !== images.length) {
    throw new LocalImageApiError("queue_duplicate_image_id");
  }
  return images;
}

function validateQueuedImage(
  value: unknown,
  sourceId: DirectImageSourceId,
): QueuedSourceImage {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== queuedImageKeys.size ||
    Object.keys(value).some((key) => !queuedImageKeys.has(key)) ||
    !isBoundedText(value.id, 512) ||
    !isBoundedText(value.listingId, 512) ||
    value.source !== sourceId ||
    !isBoundedText(value.sourceListingId, 512) ||
    !isBoundedText(value.listingTitle, 2_000) ||
    !isBoundedText(value.listingUrl, 4_096) ||
    !isBoundedText(value.sourceUrl, 4_096) ||
    !isBoundedText(value.fetchUrl, 4_096) ||
    (value.representation !== "canonical" &&
      value.representation !== "observed_thumbnail") ||
    (value.representation === "canonical" && value.fetchUrl !== value.sourceUrl) ||
    (value.representation === "observed_thumbnail" && value.fetchUrl === value.sourceUrl) ||
    (value.downloadStatus !== "pending" && value.downloadStatus !== "failed") ||
    (
      value.acquisitionMethod !== null &&
      value.acquisitionMethod !== "browser" &&
      value.acquisitionMethod !== "direct"
    ) ||
    !Number.isSafeInteger(value.attemptCount) ||
    (value.attemptCount as number) < 0 ||
    !isNullableBoundedText(value.lastAttemptedAt, 64) ||
    !isNullableBoundedText(value.downloadErrorCode, 128)
    || !isSha256(value.workInputHash)
    || !isSha256(value.sourceImageIdentityHash)
    || !Number.isSafeInteger(value.workRevision)
    || (value.workRevision as number) < 1
  ) {
    throw new LocalImageApiError("queue_image_contract_mismatch");
  }
  return value as unknown as QueuedSourceImage;
}

async function uploadImage(
  baseUrl: string,
  image: QueuedSourceImage,
  acquired: AcquiredSourceImage,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await localFetch(
    fetchImpl,
    new URL(`/api/images/${encodeURIComponent(image.id)}/content`, baseUrl),
    {
      method: "PUT",
      headers: {
        [IMAGE_CLIENT_HEADER]: IMAGE_CLIENT_ID,
        "content-type": acquired.contentType,
        "x-image-acquisition-method": "direct",
        "x-image-representation": image.representation,
        "x-image-work-input-hash": image.workInputHash,
        "x-image-work-revision": String(image.workRevision),
        "x-image-source-identity-hash": image.sourceImageIdentityHash,
      },
      body: exactArrayBuffer(acquired.bytes),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalImageApiError(`content_http_${response.status}`);
  }
  const payload = await readLocalJson(response);
  if (
    !isRecord(payload) ||
    payload.imageId !== image.id ||
    payload.listingId !== image.listingId ||
    (
      payload.alreadyCached !== true &&
      payload.acquisitionMethod !== "direct"
    )
  ) {
    throw new LocalImageApiError("content_contract_mismatch");
  }
}

async function reportFailure(
  baseUrl: string,
  image: QueuedSourceImage,
  failure: DirectImageAcquisitionError,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await localFetch(
    fetchImpl,
    new URL(`/api/images/${encodeURIComponent(image.id)}/failure`, baseUrl),
    {
      method: "POST",
      headers: {
        [IMAGE_CLIENT_HEADER]: IMAGE_CLIENT_ID,
        "content-type": "application/json",
        "x-image-representation": image.representation,
        "x-image-work-input-hash": image.workInputHash,
        "x-image-work-revision": String(image.workRevision),
        "x-image-source-identity-hash": image.sourceImageIdentityHash,
      },
      body: JSON.stringify({
        acquisitionMethod: "direct",
        errorCode: failure.code,
        message: failure.message,
      }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalImageApiError(`failure_http_${response.status}`);
  }
  const payload = await readLocalJson(response);
  if (
    !isRecord(payload) ||
    payload.imageId !== image.id ||
    payload.listingId !== image.listingId ||
    payload.status !== "failed" ||
    payload.errorCode !== failure.code
  ) {
    throw new LocalImageApiError("failure_contract_mismatch");
  }
}

function imageAttemptIdentity(image: QueuedSourceImage): string {
  return `${image.id}\u0000${image.representation}\u0000${image.workInputHash}\u0000${image.workRevision}`;
}

async function localFetch(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), SOURCE_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: abort.signal,
    });
  } catch {
    throw new LocalImageApiError("transport_failed");
  } finally {
    clearTimeout(timer);
  }
}

async function readLocalJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase();
  if (contentType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalImageApiError("json_content_type_mismatch");
  }
  if (!response.body) throw new LocalImageApiError("json_body_missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_LOCAL_JSON_BYTES) {
        await reader.cancel("local JSON exceeded byte limit");
        throw new LocalImageApiError("json_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalImageApiError("json_invalid");
  }
}

function directHttpError(
  status: number,
  sourceId: DirectImageSourceId = "image",
): DirectImageAcquisitionError {
  if (status === 401) {
    return new DirectImageAcquisitionError("direct_http_401", true, sourceId);
  }
  if (status === 403) {
    return new DirectImageAcquisitionError("direct_http_403", true, sourceId);
  }
  if (status === 404) {
    return new DirectImageAcquisitionError("direct_http_404", false, sourceId);
  }
  if (status === 429) {
    return new DirectImageAcquisitionError("direct_http_429", true, sourceId);
  }
  if (status >= 300 && status < 400) {
    return new DirectImageAcquisitionError("direct_contract_mismatch", true, sourceId);
  }
  return new DirectImageAcquisitionError("direct_http_error", status >= 500, sourceId);
}

function normalizeLoopbackBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--base-url must be a loopback HTTP(S) origin");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !["localhost", "127.0.0.1", "::1"].includes(hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("--base-url must be a loopback HTTP(S) origin");
  }
  return url.toString().replace(/\/$/u, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maxLength;
}

function isNullableBoundedText(
  value: unknown,
  maxLength: number,
): value is string | null {
  return value === null || isBoundedText(value, maxLength);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function main(): Promise<void> {
  const options = parseSourceImageSweepArgs(process.argv.slice(2));
  if (!options) return;
  const summary = await runDirectSourceImageDrain(options, {
    track: (event) => {
      if (
        event.event === "source_image_drain_started" ||
        event.event === "source_image_drain_progress" ||
        event.event === "source_image_controller_epoch_started" ||
        event.event === "source_image_failed"
      ) console.error(JSON.stringify(event));
    },
  });
  console.log(JSON.stringify(summary));
  process.exitCode = directSourceImageDrainExitCode(summary);
}

const isCliEntry = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isCliEntry) {
  main().catch((error) => {
    console.error(JSON.stringify({
      event: "source_image_drain_fatal",
      sourceId: "all_supported_direct",
      errorCode: error instanceof LocalImageApiError
        ? error.code
        : "unexpected_failure",
    }));
    process.exitCode = 1;
  });
}
