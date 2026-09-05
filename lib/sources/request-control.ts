import {
  assertSourceAccess,
  type SourceAccessGrant,
} from "./access";
import { parseSourceRetryAfterMs } from "./acquisition-access";
import {
  SourceAccessChallengeError,
  type SourceManifest,
  type SourcePage,
  type SourceRequest,
} from "./types";
import {
  requestIdentityForTelemetry,
  type PerformanceTelemetryContext,
  type PerformanceTelemetrySink,
} from "../performance/telemetry";
import {
  SourceRequestQuantumExhaustedError,
  type SourceRequestQuantumLedger,
} from "../scheduler/source-quantum";

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const DEFAULT_IMAGE_ACCEPT =
  "image/avif,image/webp,image/png,image/jpeg,image/gif";

interface TimedResponse {
  readonly response: Response;
  readonly signal: AbortSignal;
  readonly finish: (input?: {
    readonly parsingMs?: number;
    readonly validationMs?: number;
  }) => void;
}

interface RequestStartGate {
  readonly lastStartedAtByLane: Map<RequestStartLane, number>;
  tail: Promise<void>;
}

type RequestStartLane = "document" | "distinct_image";

interface RequestStartPolicy {
  readonly lane: RequestStartLane;
  readonly minDelayMs: number;
}

const sourceStartGatesByClock = new WeakMap<
  () => number,
  Map<SourceManifest["id"], RequestStartGate>
>();

type RetryableServerStatus = 500 | 502 | 503 | 504;

export class SourceRetryableHttpError extends Error {
  readonly sourceId: SourceManifest["id"];
  readonly status: RetryableServerStatus;

  constructor(
    sourceId: SourceManifest["id"],
    status: RetryableServerStatus,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`${sourceId} returned HTTP ${status}.`);
    this.name = "SourceRetryableHttpError";
    this.sourceId = sourceId;
    this.status = status;
  }
}

export interface ConservativeRequestControllerOptions {
  readonly fetch?: FetchImplementation;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  /** Persists source pressure before an in-controller retry is permitted. */
  readonly recordAccessPressure?: (input: {
    readonly status: number;
    readonly retryAfterMs: number | null;
  }) => Promise<{ readonly nextEligibleAt: string | null }>;
  /** Seeds source-wide pacing after an externally acquired approved request. */
  readonly initialRequestStartedAt?: number;
  /** Explicit benchmark/debug capture only. */
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
  /** One immutable invocation ledger shared by every physical child. */
  readonly sourceQuantumLedger?: SourceRequestQuantumLedger;
}

export interface FetchPageOptions {
  /** May reduce retries without exceeding the manifest ceiling. */
  readonly maxRetries?: number;
  /** May shorten, but never extend, the manifest's ordinary request timeout. */
  readonly timeoutMs?: number;
}

export interface SourceRequestController {
  readonly requestCount: number;
  hasRequestCapacity(attempts: number): boolean;
  fetchPage(
    request: SourceRequest,
    options?: FetchPageOptions,
  ): Promise<SourcePage>;
  fetchApprovedImage<T>(
    input: string | URL,
    handle: (response: Response) => Promise<T>,
  ): Promise<T>;
  /** True only when an exact externally acquired page remains available. */
  hasPage?(request: SourceRequest): boolean;
  /** Acquired-page controllers use this to reject silent unused overfetch. */
  assertComplete?(): void;
}

/**
 * Single-flight, bounded GET client for source adapters.
 *
 * It deliberately has no cookie jar, proxy hooks, CAPTCHA handling, or browser
 * fingerprinting. Redirects are manual, host-allowlisted, and bounded; those
 * constraints are part of the permission boundary, not missing features.
 */
export class ConservativeRequestController implements SourceRequestController {
  readonly #manifest: SourceManifest;
  readonly #grant: SourceAccessGrant;
  readonly #fetch: FetchImplementation;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;
  readonly #recordAccessPressure:
    ConservativeRequestControllerOptions["recordAccessPressure"];
  readonly #startGate: RequestStartGate;
  readonly #telemetry: PerformanceTelemetrySink | undefined;
  readonly #telemetryContext: PerformanceTelemetryContext | undefined;
  readonly #sourceQuantumLedger: SourceRequestQuantumLedger | undefined;

  #requestCount = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    manifest: SourceManifest,
    grant: SourceAccessGrant,
    options: ConservativeRequestControllerOptions = {},
  ) {
    this.#manifest = manifest;
    this.#grant = grant;
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
    this.#now = options.now ?? Date.now;
    this.#recordAccessPressure = options.recordAccessPressure;
    this.#telemetry = options.telemetry;
    this.#telemetryContext = options.telemetryContext;
    this.#sourceQuantumLedger = options.sourceQuantumLedger;
    if (
      this.#sourceQuantumLedger !== undefined &&
      this.#sourceQuantumLedger.sourceId !== manifest.id
    ) {
      throw new Error(
        "A scheduled source quantum ledger cannot be shared with another source",
      );
    }
    this.#startGate = requestStartGate(manifest, this.#now);
    if (options.initialRequestStartedAt !== undefined) {
      if (!Number.isFinite(options.initialRequestStartedAt)) {
        throw new RangeError("Initial source request time must be finite.");
      }
      this.#startGate.lastStartedAtByLane.set(
        "document",
        Math.max(
          this.#startGate.lastStartedAtByLane.get("document") ??
            Number.NEGATIVE_INFINITY,
          options.initialRequestStartedAt,
        ),
      );
    }
  }

  get requestCount(): number {
    return this.#requestCount;
  }

  hasRequestCapacity(attempts: number): boolean {
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      throw new Error("Request capacity checks require a non-negative integer.");
    }
    return this.#requestCount + attempts <=
      this.#manifest.requests.maxRequestsPerRun;
  }

  async fetchPage(
    request: SourceRequest,
    options: FetchPageOptions = {},
  ): Promise<SourcePage> {
    if (request.method !== undefined || request.body !== undefined) {
      throw new Error(
        `${this.#manifest.id} direct source documents are GET-only.`,
      );
    }
    const maxRetries = options.maxRetries ?? this.#manifest.requests.maxRetries;
    if (
      !Number.isSafeInteger(maxRetries) ||
      maxRetries < 0 ||
      maxRetries > this.#manifest.requests.maxRetries
    ) {
      throw new RangeError(
        "A source page cannot exceed its manifest retry ceiling.",
      );
    }
    const timeoutMs = options.timeoutMs ?? this.#manifest.requests.timeoutMs;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > this.#manifest.requests.timeoutMs
    ) {
      throw new RangeError(
        "A source page timeout must be a positive integer no greater than its manifest ceiling.",
      );
    }
    return this.#runSerial(() =>
      this.#fetchPageSerial(request, maxRetries, timeoutMs)
    );
  }

  /**
   * Runs one approved image GET through the same source-run request ledger as
   * discovery and detail pages. The response handler remains inside the
   * single-flight lease so redirects and streamed bodies cannot overlap a
   * later source request.
   */
  async fetchApprovedImage<T>(
    input: string | URL,
    handle: (response: Response) => Promise<T>,
  ): Promise<T> {
    assertSourceAccess(this.#manifest, this.#grant);
    const url = validateImageRequestUrl(this.#manifest, input);
    return this.#runSerial(async () => {
      const timedResponse = await this.#fetchOnce(url, {
        Accept: this.#manifest.requests.imageAccept ?? DEFAULT_IMAGE_ACCEPT,
        ...(this.#manifest.requests.userAgent
          ? { "User-Agent": this.#manifest.requests.userAgent }
          : {}),
      }, this.#manifest.requests.timeoutMs, imageStartPolicy(
        this.#manifest,
        url,
      ), "image", 0);
      try {
        throwControlledSourceAccessChallenge(
          this.#manifest,
          timedResponse.response.status,
          parseSourceRetryAfterMs(
            timedResponse.response.headers.get("retry-after"),
            new Date(this.#now()),
          ),
        );
        await throwControlledSourceImageAccessChallenge(
          this.#manifest,
          timedResponse.response,
        );
        return await handle(timedResponse.response);
      } finally {
        cancelBody(timedResponse.response);
        timedResponse.finish();
      }
    });
  }

  async #runSerial<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const predecessor = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async #fetchPageSerial(
    request: SourceRequest,
    maxRetries: number,
    timeoutMs: number,
  ): Promise<SourcePage> {
    assertSourceAccess(this.#manifest, this.#grant);
    const initialUrl = validateRequestUrl(this.#manifest, request.url);
    const initialHeaders = {
      Accept: this.#manifest.transport === "json_api"
        ? "application/json"
        : "text/html,application/xhtml+xml,application/xml,text/xml;q=0.9",
      ...(this.#manifest.requests.userAgent
        ? { "User-Agent": this.#manifest.requests.userAgent }
        : {}),
      ...sanitizeHeaders(this.#manifest, request.headers),
    };
    const maxRedirects = redirectLimit(this.#manifest);

    let lastError: unknown;
    const attempts = maxRetries + 1;

    attemptsLoop:
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let currentUrl = initialUrl;
      let headers: Record<string, string> = initialHeaders;
      let redirects = 0;
      try {
        while (true) {
          const timedResponse = await this.#fetchOnce(
            currentUrl,
            headers,
            timeoutMs,
            documentStartPolicy(this.#manifest),
            request.kind,
            attempt,
          );
          const response = timedResponse.response;
          try {

            if (isRedirect(response.status)) {
              if (redirects >= maxRedirects) {
                throw new Error(`${this.#manifest.id} exceeded its redirect limit.`);
              }
              const location = response.headers.get("location");
              if (!location) {
                throw new Error(`${this.#manifest.id} returned a redirect without a location.`);
              }
              const redirectedUrl = validateRedirectUrl(
                this.#manifest,
                location,
                currentUrl,
              );
              if (redirectedUrl.origin !== currentUrl.origin) {
                headers = stripSourceHeaders(headers);
              }
              currentUrl = redirectedUrl;
              redirects += 1;
              continue;
            }

            if (
              isRetryable(this.#manifest, response.status) &&
              attempt + 1 < attempts
            ) {
              const retryAfterMs = parseSourceRetryAfterMs(
                response.headers.get("retry-after"),
                new Date(this.#now()),
              );
              const persisted = await this.#recordAccessPressure?.({
                status: response.status,
                retryAfterMs,
              });
              const durableDelayMs = persisted?.nextEligibleAt === null ||
                  persisted?.nextEligibleAt === undefined
                ? 0
                : Math.max(
                    0,
                    Date.parse(persisted.nextEligibleAt) - this.#now(),
                  );
              const delayMs = Math.max(retryAfterMs ?? 0, durableDelayMs);
              this.#sourceQuantumLedger?.assertRequestAdmission({
                nowMs: this.#now(),
                requiredWaitMs: delayMs,
                timeoutMs,
              });
              if (delayMs > 0) await this.#sleep(delayMs);
              continue attemptsLoop;
            }

            const retryAfterMs = parseSourceRetryAfterMs(
              response.headers.get("retry-after"),
              new Date(this.#now()),
            );
            throwControlledSourceAccessChallenge(
              this.#manifest,
              response.status,
              retryAfterMs,
            );

            if (isRetryableServerStatus(response.status)) {
              throw new SourceRetryableHttpError(
                this.#manifest.id,
                response.status,
                retryAfterMs,
              );
            }

            if (!response.ok) {
              throw new Error(
                `${this.#manifest.id} returned HTTP ${response.status}.`,
              );
            }

            const declaredLength = Number(response.headers.get("content-length"));
            if (
              Number.isFinite(declaredLength) &&
              declaredLength > this.#manifest.requests.maxResponseBytes
            ) {
              throw new Error(`${this.#manifest.id} response exceeded its byte limit.`);
            }

            const body = await readBoundedText(
              response,
              this.#manifest.requests.maxResponseBytes,
              this.#manifest.id,
              timedResponse.signal,
            );

            return {
              // Never expose a signed redirect target to callers or logs.
              url: initialUrl.toString(),
              body: body.text,
              fetchedAt: new Date(this.#now()).toISOString(),
              contentType: response.headers.get("content-type") ?? undefined,
            };
          } finally {
            cancelBody(response);
            timedResponse.finish();
          }
        }
      } catch (error) {
        const safeError = currentUrl.toString() === initialUrl.toString()
          ? error
          : sanitizeRedirectError(this.#manifest, error);
        lastError = safeError;
        if (
          attempt + 1 >= attempts ||
          !isRetryableSourceTransportError(safeError)
        ) throw safeError;
      }
    }

    throw lastError;
  }

  async #fetchOnce(
    url: URL,
    headers: Readonly<Record<string, string>>,
    timeoutMs = this.#manifest.requests.timeoutMs,
    startPolicy: RequestStartPolicy = documentStartPolicy(this.#manifest),
    requestRole = "document",
    retry = 0,
  ): Promise<TimedResponse> {
    if (!this.hasRequestCapacity(1)) {
      throw new Error(
        `Request budget exhausted for ${this.#manifest.id} (${this.#requestCount} requests).`,
      );
    }

    const gate = await this.#acquireStartGate(startPolicy, timeoutMs);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );

    const startedAtMs = this.#now();
    let recorded = false;
    let physicalStartReserved = false;
    const record = (
      statusCode: number | null,
      responseBytes: number,
      parsingMs = 0,
      validationMs = 0,
    ): void => {
      if (recorded) return;
      recorded = true;
      this.#telemetry?.record({
        context: {
          ...this.#telemetryContext,
          sourceId: this.#manifest.id,
        },
        details: {
          kind: "request",
          requestIdentity: requestIdentityForTelemetry(url.toString()),
          requestRole,
          laneKey: `${this.#manifest.id}:${startPolicy.lane}`,
          pacingWaitMs: gate.pacingWaitMs,
          acquisitionQueueWaitMs: gate.queueWaitMs,
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date(this.#now()).toISOString(),
          statusCode,
          retry,
          responseBytes,
          decompressionMs: 0,
          hashingMs: 0,
          parsingMs,
          validationMs,
        },
      });
    };
    try {
      this.#sourceQuantumLedger?.reservePhysicalRequestStart({
        nowMs: startedAtMs,
        timeoutMs,
      });
      this.#requestCount += 1;
      physicalStartReserved = true;
      this.#startGate.lastStartedAtByLane.set(
        startPolicy.lane,
        startedAtMs,
      );
      const fetched = await this.#fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers,
      });
      let observedBytes = 0;
      const response = this.#telemetry === undefined || fetched.body === null
        ? fetched
        : new Response(fetched.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              observedBytes += chunk.byteLength;
              controller.enqueue(chunk);
            },
          })), {
            status: fetched.status,
            statusText: fetched.statusText,
            headers: fetched.headers,
          });
      let finished = false;
      return {
        response,
        signal: controller.signal,
        finish: (measurement = {}) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          gate.release();
          record(
            response.status,
            observedBytes,
            measurement.parsingMs ?? 0,
            measurement.validationMs ?? 0,
          );
        },
      };
    } catch (error) {
      clearTimeout(timeout);
      gate.release();
      if (physicalStartReserved) record(null, 0);
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      if (error instanceof SourceRequestQuantumExhaustedError) throw error;
      // Fetch implementations can include the complete URL in network errors.
      // Replace it so signed redirect query parameters never leave this method.
      throw new TypeError(`${this.#manifest.id} request failed`);
    }
  }

  async #acquireStartGate(
    startPolicy: RequestStartPolicy,
    timeoutMs: number,
  ): Promise<{
    readonly release: () => void;
    readonly pacingWaitMs: number;
    readonly queueWaitMs: number;
  }> {
    const queuedAt = this.#now();
    let release: (() => void) | undefined;
    const predecessor = this.#startGate.tail;
    this.#startGate.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await predecessor;
      const acquiredAt = this.#now();
      const waitMs = Math.max(
        0,
        startPolicy.minDelayMs -
          (
            this.#now() -
            (
              this.#startGate.lastStartedAtByLane.get(startPolicy.lane) ??
                Number.NEGATIVE_INFINITY
            )
          ),
      );
      this.#sourceQuantumLedger?.assertRequestAdmission({
        nowMs: this.#now(),
        requiredWaitMs: waitMs,
        timeoutMs,
      });
      if (waitMs > 0) await this.#sleep(waitMs);
      this.#sourceQuantumLedger?.assertRequestAdmission({
        nowMs: this.#now(),
        requiredWaitMs: 0,
        timeoutMs,
      });
      return {
        release: () => release?.(),
        pacingWaitMs: waitMs,
        queueWaitMs: Math.max(0, acquiredAt - queuedAt),
      };
    } catch (error) {
      release?.();
      throw error;
    }
  }
}

const MAX_DIRECT_CONTROLLER_STAGES = 4;

/**
 * Runs one explicitly opted-in direct inventory acquisition across a bounded
 * sequence of ordinary controller ledgers.
 *
 * Every physical controller retains the manifest's request ceiling and shares
 * the existing source-wide request-start gate. Requiring zero retries and zero
 * redirects keeps one fetch operation equal to one reserved request start, so
 * aggregate capacity checks remain exact for pipeline planning.
 */
export class StagedConservativeRequestController
  implements SourceRequestController {
  readonly #manifest: SourceManifest;
  readonly #grant: SourceAccessGrant;
  readonly #options: ConservativeRequestControllerOptions;
  readonly #maxStages: number;
  readonly #controllers: ConservativeRequestController[];

  #tail: Promise<void> = Promise.resolve();

  constructor(
    manifest: SourceManifest,
    grant: SourceAccessGrant,
    options: ConservativeRequestControllerOptions = {},
  ) {
    const maxStages = manifest.requests.maxDirectControllerStages;
    if (
      !Number.isSafeInteger(maxStages) ||
      maxStages === undefined ||
      maxStages < 2 ||
      maxStages > MAX_DIRECT_CONTROLLER_STAGES
    ) {
      throw new Error(
        `${manifest.id} staged direct acquisition requires between two and ` +
          `${MAX_DIRECT_CONTROLLER_STAGES} controller stages.`,
      );
    }
    if (manifest.acquisition === "isolated_browser") {
      throw new Error(
        `${manifest.id} staged direct acquisition requires direct transport.`,
      );
    }
    if (manifest.requests.maxRetries !== 0) {
      throw new Error(
        `${manifest.id} staged direct acquisition requires maxRetries 0.`,
      );
    }
    if (manifest.requests.maxRedirects !== 0) {
      throw new Error(
        `${manifest.id} staged direct acquisition requires maxRedirects 0.`,
      );
    }
    if (
      !Number.isSafeInteger(manifest.requests.maxRequestsPerRun) ||
      manifest.requests.maxRequestsPerRun < 1 ||
      !Number.isSafeInteger(
        manifest.requests.maxRequestsPerRun * maxStages,
      )
    ) {
      throw new Error(
        `${manifest.id} staged direct acquisition request capacity is invalid.`,
      );
    }

    this.#manifest = manifest;
    this.#grant = grant;
    this.#options = options;
    this.#maxStages = maxStages;
    this.#controllers = [
      new ConservativeRequestController(manifest, grant, options),
    ];
  }

  get requestCount(): number {
    return this.#controllers.reduce(
      (total, controller) => total + controller.requestCount,
      0,
    );
  }

  hasRequestCapacity(attempts: number): boolean {
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      throw new Error("Request capacity checks require a non-negative integer.");
    }
    return this.requestCount + attempts <=
      this.#manifest.requests.maxRequestsPerRun * this.#maxStages;
  }

  async fetchPage(
    request: SourceRequest,
    options: FetchPageOptions = {},
  ): Promise<SourcePage> {
    if (options.maxRetries !== undefined && options.maxRetries !== 0) {
      throw new RangeError(
        `${this.#manifest.id} staged direct acquisition cannot enable retries.`,
      );
    }
    return this.#runSerial(async () => {
      const controller = this.#controllerForNextStart();
      return controller.fetchPage(request, {
        ...options,
        maxRetries: 0,
      });
    });
  }

  async fetchApprovedImage<T>(
    input: string | URL,
    handle: (response: Response) => Promise<T>,
  ): Promise<T> {
    return this.#runSerial(() =>
      this.#controllerForNextStart().fetchApprovedImage(input, handle)
    );
  }

  #controllerForNextStart(): ConservativeRequestController {
    if (!this.hasRequestCapacity(1)) {
      throw new Error(
        `Request budget exhausted for ${this.#manifest.id} ` +
          `(${this.requestCount} requests across ${this.#maxStages} stages).`,
      );
    }
    const current = this.#controllers.at(-1)!;
    if (current.hasRequestCapacity(1)) return current;

    const next = new ConservativeRequestController(
      this.#manifest,
      this.#grant,
      this.#options,
    );
    this.#controllers.push(next);
    return next;
  }

  async #runSerial<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const predecessor = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

function requestStartGate(
  manifest: SourceManifest,
  now: () => number,
): RequestStartGate {
  let gatesBySource = sourceStartGatesByClock.get(now);
  if (!gatesBySource) {
    gatesBySource = new Map();
    sourceStartGatesByClock.set(now, gatesBySource);
  }
  const shared = gatesBySource.get(manifest.id);
  if (shared) return shared;
  const created = {
    lastStartedAtByLane: new Map<RequestStartLane, number>(),
    tail: Promise.resolve(),
  };
  gatesBySource.set(manifest.id, created);
  return created;
}

function documentStartPolicy(manifest: SourceManifest): RequestStartPolicy {
  return {
    lane: "document",
    minDelayMs: manifest.requests.minDelayMs,
  };
}

function imageStartPolicy(
  manifest: SourceManifest,
  url: URL,
): RequestStartPolicy {
  const isDocumentHost = manifest.requests.allowedHosts.some(
    (host) => host.trim().toLowerCase() === url.hostname.toLowerCase(),
  );
  const minDelayMs = manifest.requests.distinctImageMinDelayMs;
  if (isDocumentHost || minDelayMs === undefined) {
    return documentStartPolicy(manifest);
  }
  if (!Number.isSafeInteger(minDelayMs) || minDelayMs < 1_000) {
    throw new RangeError(
      `${manifest.id} distinct image delay must be an integer of at least 1000 milliseconds.`,
    );
  }
  return {
    lane: "distinct_image",
    minDelayMs,
  };
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
  sourceId: string,
  signal: AbortSignal,
): Promise<{ readonly text: string; readonly byteLength: number }> {
  if (!response.body) return { text: "", byteLength: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error(`${sourceId} response exceeded its byte limit.`);
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return { text: chunks.join(""), byteLength: bytesRead };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // An abort can leave a custom stream read pending; cancellation above is
      // already responsible for releasing it.
    }
  }
}

function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("Request timed out", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(signal.reason ?? new DOMException("Request timed out", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // A consumed or locked stream needs no further work.
  }
}

export function validateRequestUrl(
  manifest: SourceManifest,
  input: string,
): URL {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error(`${manifest.id} requests must use HTTPS without credentials, a port or a fragment.`);
  }

  const allowed = manifest.requests.allowedHosts.some(
    (host) => host.toLowerCase() === url.hostname.toLowerCase(),
  );
  if (!allowed) {
    throw new Error(`${url.hostname} is not an allowed host for ${manifest.id}.`);
  }

  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

function validateImageRequestUrl(
  manifest: SourceManifest,
  input: string | URL,
): URL {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw new Error(
      `${manifest.id} image requests must use HTTPS with the default authority and no fragment.`,
    );
  }

  const hostname = url.hostname.toLowerCase();
  const initialHostApproved = manifest.requests.allowedImageHosts?.some(
    (host) => host.trim().toLowerCase() === hostname,
  ) ?? false;
  const redirectApproved = manifest.requests.allowedImageRedirects?.some(
    (rule) =>
      rule.host.trim().toLowerCase() === hostname &&
      rule.pathPrefix.startsWith("/") &&
      url.pathname.startsWith(rule.pathPrefix),
  ) ?? false;
  if (!initialHostApproved && !redirectApproved) {
    throw new Error(`${manifest.id} image request target is not approved.`);
  }

  return url;
}

function redirectLimit(manifest: SourceManifest): number {
  const value = manifest.requests.maxRedirects ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${manifest.id} maxRedirects must be a non-negative integer.`);
  }
  return value;
}

function validateRedirectUrl(
  manifest: SourceManifest,
  location: string,
  currentUrl: URL,
): URL {
  let url: URL;
  try {
    url = new URL(location, currentUrl);
  } catch {
    throw new Error(`${manifest.id} returned an invalid redirect target.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new Error(`${manifest.id} redirect targets must use HTTPS without credentials, a port or a fragment.`);
  }

  const allowed = (manifest.requests.allowedRedirectHosts ?? []).some(
    (host) => host.toLowerCase() === url.hostname.toLowerCase(),
  );
  if (!allowed) {
    throw new Error(`${manifest.id} redirect target is not approved.`);
  }

  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

function sanitizeHeaders(
  manifest: SourceManifest,
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  if (!headers) return {};
  const allowed = new Set((manifest.requests.allowedRequestHeaders ?? []).map((name) => name.toLowerCase()));
  const forbidden = new Set(["cookie", "host", "origin", "referer", "content-length", "connection", "transfer-encoding"]);
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!allowed.has(normalized) || forbidden.has(normalized) || !/^[a-z0-9-]+$/u.test(normalized) || typeof value !== "string" || /[\r\n\0]/u.test(value)) {
      throw new Error("Source request contains an unapproved header.");
    }
    safe[normalized] = value;
  }
  return safe;
}

function stripSourceHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => ["accept", "user-agent"].includes(name.toLowerCase())));
}

function sanitizeRedirectError(manifest: SourceManifest, error: unknown): unknown {
  if (isRetryableSourceTransportError(error)) {
    return new TypeError(`${manifest.id} redirected request failed`);
  }
  return error;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 ||
    status === 307 || status === 308;
}

function isRetryable(manifest: SourceManifest, status: number): boolean {
  return status === 500 || status === 502 ||
    status === 503 || status === 504;
}

function throwControlledSourceAccessChallenge(
  manifest: SourceManifest,
  status: number,
  retryAfterMs: number | null = null,
): void {
  if (status === 401 || status === 403 || status === 429) {
    throw new SourceAccessChallengeError(manifest.id, `Source returned access-status HTTP ${status}.`, status, retryAfterMs);
  }
}

async function throwControlledSourceImageAccessChallenge(
  manifest: SourceManifest,
  response: Response,
): Promise<void> {
  if (response.status !== 200) return;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") {
    throw new SourceAccessChallengeError(manifest.id, "Image request returned a non-image response.");
  }
}

export function isRetryableSourceTransportError(error: unknown): boolean {
  return error instanceof TypeError ||
    error instanceof DOMException ||
    error instanceof SourceRetryableHttpError;
}

function isRetryableServerStatus(
  status: number,
): status is RetryableServerStatus {
  return status === 500 || status === 502 || status === 503 || status === 504;
}
