import {
  PERFORMANCE_TELEMETRY_SCHEMA_VERSION,
  PerformanceTelemetryBuffer,
  parsePerformanceTelemetryRecord,
  type PerformanceTelemetryCompactSummary,
  type PerformanceTelemetryDetails,
  type PerformanceTelemetryFlush,
  type PerformanceTelemetrySink,
} from "./telemetry";

export const PERFORMANCE_TELEMETRY_REQUEST_HEADER =
  "x-performance-telemetry" as const;
export const PERFORMANCE_TELEMETRY_REQUEST_VALUE = "events-v1" as const;
export const PERFORMANCE_TELEMETRY_TRANSPORT_MAX_EVENTS = 128;
export const PERFORMANCE_TELEMETRY_TRANSPORT_MAX_BYTES = 256 * 1024;

const EVENT_KINDS: readonly PerformanceTelemetryDetails["kind"][] = [
  "stage",
  "scheduler",
  "request",
  "database",
  "publication",
  "queue",
  "projection",
  "proximity",
  "image",
  "model",
  "scoring",
  "resources",
  "critical_path",
  "equivalence",
  "coverage",
];

/** Raw events are an explicit benchmark/debug-only loopback contract. */
export function performanceTelemetryEventsRequested(
  request: Pick<Request, "headers">,
): boolean {
  return request.headers.get(PERFORMANCE_TELEMETRY_REQUEST_HEADER) ===
    PERFORMANCE_TELEMETRY_REQUEST_VALUE;
}

/**
 * A strict per-action buffer prevents a benchmark response from silently
 * dropping events or expanding an existing local-response ceiling.
 */
export function createTransportPerformanceTelemetryBuffer(
  request: Pick<Request, "headers">,
): PerformanceTelemetryBuffer {
  return performanceTelemetryEventsRequested(request)
    ? new PerformanceTelemetryBuffer({
        capacity: PERFORMANCE_TELEMETRY_TRANSPORT_MAX_EVENTS,
        overflow: "throw",
      })
    : new PerformanceTelemetryBuffer();
}

/** Routine responses stay aggregate-only; signaled responses return drain() exactly. */
export function drainTransportPerformanceTelemetry(
  request: Pick<Request, "headers">,
  telemetry: PerformanceTelemetryBuffer,
): PerformanceTelemetryFlush | PerformanceTelemetryCompactSummary {
  if (!performanceTelemetryEventsRequested(request)) {
    return telemetry.drainSummary();
  }
  const flush = telemetry.drain();
  assertTransportByteBound(flush);
  return flush;
}

/**
 * Records the exact D1 counts already exposed by one instrumented telemetry
 * family. Queue telemetry takes precedence because projection refresh emits a
 * duplicate projection/queue view of the same statements; this must never sum
 * those two views and invent occupancy. Uninstrumented route statements are
 * intentionally excluded instead of estimated.
 */
export function recordObservedTransportDatabaseTelemetry(
  telemetry: PerformanceTelemetryBuffer,
  action: string,
): void {
  const events = telemetry.snapshot().events;
  const queues = events.filter((event) => event.details.kind === "queue");
  const projections = events.filter((event) => event.details.kind === "projection");
  const proximities = events.filter((event) => event.details.kind === "proximity");
  let statementCount = 0;
  let batchCount = 0;
  let mutationMs = 0;
  let basis = "none";
  if (queues.length > 0) {
    basis = "queue";
    for (const event of queues) {
      if (event.details.kind !== "queue") continue;
      statementCount = safeAdd(statementCount, event.details.statements);
      batchCount = safeAdd(batchCount, event.details.batches);
      mutationMs = safeAdd(mutationMs, event.details.durationMs);
    }
  } else if (projections.length > 0) {
    basis = "projection";
    for (const event of projections) {
      if (event.details.kind !== "projection") continue;
      statementCount = safeAdd(statementCount, event.details.statements);
      batchCount = safeAdd(batchCount, event.details.batches);
      mutationMs = safeAdd(mutationMs, event.details.durationMs);
    }
  } else if (proximities.length > 0) {
    basis = "proximity";
    for (const event of proximities) {
      if (event.details.kind !== "proximity") continue;
      statementCount = safeAdd(statementCount, event.details.statements);
      batchCount = safeAdd(batchCount, event.details.batches);
      mutationMs = safeAdd(mutationMs, event.details.persistenceMs);
    }
  }
  telemetry.record({
    details: {
      kind: "database",
      operation: `${action}_observed_${basis}`,
      statementCount,
      batchCount,
      mutationMs,
      callbackQueueWaitMs: 0,
      checkpointMs: 0,
    },
  });
}

/**
 * Strictly validates a complete cross-process envelope before re-recording
 * sanitized inputs. The receiving session owns its own sequence and time.
 */
export function ingestPerformanceTelemetryEnvelope(
  value: unknown,
  telemetry: PerformanceTelemetrySink,
): number {
  assertTransportByteBound(value);
  assertPlainRecord(value, "performance telemetry envelope");
  assertExactKeys(
    value,
    ["schemaVersion", "flushedAt", "events", "summary"],
    "performance telemetry envelope",
  );
  if (value.schemaVersion !== PERFORMANCE_TELEMETRY_SCHEMA_VERSION) {
    throw new Error("unsupported performance telemetry envelope schema version");
  }
  if (canonicalTimestamp(value.flushedAt) !== value.flushedAt) {
    throw new Error("performance telemetry envelope timestamp is not canonical");
  }
  if (!Array.isArray(value.events) ||
    value.events.length > PERFORMANCE_TELEMETRY_TRANSPORT_MAX_EVENTS) {
    throw new RangeError("performance telemetry envelope event count is out of bounds");
  }
  assertPlainRecord(value.summary, "performance telemetry envelope summary");
  assertExactKeys(
    value.summary,
    ["eventCount", "droppedEvents", "eventCounts"],
    "performance telemetry envelope summary",
  );
  if (value.summary.eventCount !== value.events.length ||
    value.summary.droppedEvents !== 0) {
    throw new Error("performance telemetry envelope must be complete with zero dropped events");
  }
  assertPlainRecord(
    value.summary.eventCounts,
    "performance telemetry envelope event counts",
  );
  assertExactKeys(
    value.summary.eventCounts,
    EVENT_KINDS,
    "performance telemetry envelope event counts",
  );

  const expectedCounts = Object.fromEntries(
    EVENT_KINDS.map((kind) => [kind, 0]),
  ) as Record<PerformanceTelemetryDetails["kind"], number>;
  const checkedEvents = value.events.map((event, index) => {
    const checked = parsePerformanceTelemetryRecord(event);
    if (checked.sequence !== index + 1) {
      throw new Error(
        "performance telemetry envelope sequence must be complete and start at one",
      );
    }
    if (Date.parse(checked.recordedAt) > Date.parse(value.flushedAt as string)) {
      throw new Error("performance telemetry event follows its envelope flush time");
    }
    expectedCounts[checked.details.kind] += 1;
    return checked;
  });
  for (const kind of EVENT_KINDS) {
    const count = value.summary.eventCounts[kind];
    if (!Number.isSafeInteger(count) || (count as number) < 0 ||
      count !== expectedCounts[kind]) {
      throw new Error("performance telemetry envelope event counts are inconsistent");
    }
  }

  for (const event of checkedEvents) {
    telemetry.record({ context: event.context, details: event.details });
  }
  return checkedEvents.length;
}

function assertTransportByteBound(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("performance telemetry envelope is not JSON serializable");
  }
  if (typeof serialized !== "string") {
    throw new Error("performance telemetry envelope is not JSON serializable");
  }
  if (new TextEncoder().encode(serialized).byteLength >
    PERFORMANCE_TELEMETRY_TRANSPORT_MAX_BYTES) {
    throw new RangeError("performance telemetry envelope exceeds its byte bound");
  }
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) && Number.isInteger(left) && Number.isInteger(right)) {
    throw new RangeError("performance telemetry aggregate exceeds safe integer bounds");
  }
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("performance telemetry aggregate exceeds numeric bounds");
  }
  return value;
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function assertPlainRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} contains missing or unsupported fields`);
  }
}
