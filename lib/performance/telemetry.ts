import { stableContentHash } from "../sources/parsing";

export const PERFORMANCE_TELEMETRY_SCHEMA_VERSION =
  "auction-discovery-performance-v1" as const;
export const PERFORMANCE_TELEMETRY_MAX_EVENTS = 100_000;
export const PERFORMANCE_TELEMETRY_MAX_JSONL_BYTES = 16 * 1024 * 1024;

export type PerformanceCoverageMode =
  | "complete_current"
  | "discovery_frontier";

export interface PerformanceTelemetryContext {
  readonly campaignId?: string | null;
  readonly runId?: string | null;
  readonly sourceId?: string | null;
  readonly traversalId?: string | null;
  readonly publicationId?: string | null;
  readonly coverageMode?: PerformanceCoverageMode | null;
}

interface StageTelemetry {
  readonly kind: "stage";
  readonly stage: string;
  readonly outcome: "started" | "completed" | "failed" | "skipped";
  readonly durationMs?: number | null;
  readonly releaseOrPrimeMs?: number | null;
  readonly reasonCode?: string | null;
}

interface SchedulerTelemetry {
  readonly kind: "scheduler";
  readonly dependencyDecision: string;
  readonly laneKey?: string | null;
  readonly queueWaitMs?: number | null;
  readonly estimatedRemainingMs?: number | null;
  readonly fairnessQuantum?: number | null;
}

interface RequestTelemetry {
  readonly kind: "request";
  /** Query-free, fragment-free classified identity from requestIdentityForTelemetry. */
  readonly requestIdentity: string;
  readonly requestRole: string;
  readonly laneKey: string;
  readonly page?: number | null;
  readonly partition?: string | null;
  readonly sentinel?: boolean | null;
  readonly reservedAt?: string | null;
  readonly pacingWaitMs?: number | null;
  readonly acquisitionQueueWaitMs?: number | null;
  readonly startedAt?: string | null;
  readonly endedAt?: string | null;
  readonly statusCode?: number | null;
  readonly retry?: number | null;
  readonly retryAfterMs?: number | null;
  readonly responseBytes?: number | null;
  readonly decompressionMs?: number | null;
  readonly hashingMs?: number | null;
  readonly parsingMs?: number | null;
  readonly validationMs?: number | null;
}

interface DatabaseTelemetry {
  readonly kind: "database";
  readonly operation: string;
  readonly statementCount: number;
  readonly batchCount: number;
  readonly mutationMs: number;
  readonly callbackQueueWaitMs?: number | null;
  readonly checkpointMs?: number | null;
}

interface PublicationTelemetry {
  readonly kind: "publication";
  readonly outcome: "published" | "preserved_prior" | "failed" | "paused";
  readonly priorHeadIdentity?: string | null;
  readonly resultingHeadIdentity?: string | null;
  readonly preservationReasonCode?: string | null;
  readonly firstSeenCount?: number | null;
  readonly materiallyChangedCount?: number | null;
  readonly terminalCount?: number | null;
  readonly priorUnionCount?: number | null;
  readonly resultingUnionCount?: number | null;
  readonly publicationMs?: number | null;
}

interface QueueTelemetry {
  readonly kind: "queue";
  readonly operation:
    | "upsert"
    | "select"
    | "claim"
    | "renew"
    | "complete"
    | "defer"
    | "fail"
    | "reclaim"
    | "snapshot";
  readonly stage: string;
  /** Newly inserted work identities; unlike upserted, excludes existing rows. */
  readonly created?: number | null;
  readonly upserted: number;
  readonly selected: number;
  readonly claimed: number;
  readonly completed: number;
  readonly deferred: number;
  readonly failed: number;
  readonly reclaimed: number;
  readonly remaining: number;
  readonly statements: number;
  readonly batches: number;
  readonly durationMs: number;
}

interface ProjectionTelemetry {
  readonly kind: "projection";
  readonly operation:
    | "canonical_select"
    | "rebuild"
    | "projection_read"
    | "fanout"
    | "shadow_compare"
    | "canonical_fallback";
  readonly scopeType?: "listing" | "source" | "group" | "global" | null;
  readonly scopeIdentity?: string | null;
  readonly resultCount: number;
  readonly resultHash?: string | null;
  readonly rows: number;
  readonly batches: number;
  readonly statements: number;
  readonly durationMs: number;
  readonly generationVectorHash?: string | null;
  readonly targetGeneration?: number | null;
  readonly cursorRows?: number | null;
  readonly mismatchCount: number;
  readonly fallbackActivated: boolean;
  readonly reasonCode?: string | null;
}

interface ProximityTelemetry {
  readonly kind: "proximity";
  readonly selected: number;
  readonly selectorMs: number;
  readonly projectionMs: number;
  readonly calculationMs: number;
  readonly persistenceMs: number;
  readonly cacheHits: number;
  readonly statements: number;
  readonly batches: number;
}

interface ImageTelemetry {
  readonly kind: "image";
  readonly downloadedBytes: number;
  readonly contentHashBytesReused?: number | null;
  readonly contentHashHits: number;
  readonly archiveWrites: number;
  readonly attempted: number;
  readonly failed: number;
}

interface ModelTelemetry {
  readonly kind: "model";
  readonly role: "text" | "embedding";
  readonly loadCount?: number | null;
  readonly unloadCount?: number | null;
  readonly healthMs: number;
  readonly loadMs: number;
  readonly generationMs: number;
  readonly embeddingMs: number;
  readonly unloadMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface ScoringTelemetry {
  readonly kind: "scoring";
  readonly materializationMs: number;
  readonly pythonMs: number;
  readonly importMs: number;
  readonly selected: number;
  readonly scored: number;
  readonly skippedNoChange: boolean;
}

interface ResourceTelemetry {
  readonly kind: "resources";
  readonly aggregateCpuPercent: number;
  readonly workingSetBytes: number;
  readonly availableMemoryBytes: number;
  readonly handleCount: number;
  readonly gpuResidentBytes?: number | null;
}

interface CriticalPathTelemetry {
  readonly kind: "critical_path";
  readonly sourceOrLane: string;
  readonly estimatedRemainingMs: number;
  readonly observedAt: string;
}

interface EquivalenceTelemetry {
  readonly kind: "equivalence";
  readonly surface: "publication" | "release";
  readonly equivalent: boolean;
  readonly reasonCode: string;
}

interface CoverageTelemetry {
  readonly kind: "coverage";
  readonly reasonCode: string;
}

export type PerformanceTelemetryDetails =
  | StageTelemetry
  | SchedulerTelemetry
  | RequestTelemetry
  | DatabaseTelemetry
  | PublicationTelemetry
  | QueueTelemetry
  | ProjectionTelemetry
  | ProximityTelemetry
  | ImageTelemetry
  | ModelTelemetry
  | ScoringTelemetry
  | ResourceTelemetry
  | CriticalPathTelemetry
  | EquivalenceTelemetry
  | CoverageTelemetry;

export interface PerformanceTelemetryInput {
  readonly context?: PerformanceTelemetryContext;
  readonly details: PerformanceTelemetryDetails;
}

/** Small integration boundary shared by routine summaries and strict sessions. */
export interface PerformanceTelemetrySink {
  record(input: PerformanceTelemetryInput): PerformanceTelemetryRecord;
}

export interface PerformanceTelemetryRecord {
  readonly schemaVersion: typeof PERFORMANCE_TELEMETRY_SCHEMA_VERSION;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly context: Readonly<PerformanceTelemetryContext>;
  readonly details: PerformanceTelemetryDetails;
}

export interface PerformanceTelemetryFlush {
  readonly schemaVersion: typeof PERFORMANCE_TELEMETRY_SCHEMA_VERSION;
  readonly flushedAt: string;
  readonly events: readonly PerformanceTelemetryRecord[];
  readonly summary: Readonly<{
    eventCount: number;
    droppedEvents: number;
    eventCounts: Readonly<Record<PerformanceTelemetryDetails["kind"], number>>;
  }>;
}

export interface PerformanceTelemetryCompactSummary {
  readonly schemaVersion: typeof PERFORMANCE_TELEMETRY_SCHEMA_VERSION;
  readonly flushedAt: string;
  readonly eventCount: number;
  readonly droppedEvents: number;
  readonly eventCounts: Readonly<Record<PerformanceTelemetryDetails["kind"], number>>;
  readonly stages: readonly Readonly<{
    stage: string;
    outcome: StageTelemetry["outcome"];
    count: number;
    totalDurationMs: number;
  }>[];
  readonly publicationOutcomes: Readonly<
    Record<PublicationTelemetry["outcome"], number>
  >;
  readonly queueTotals: Readonly<{
    upserted: number;
    selected: number;
    claimed: number;
    completed: number;
    deferred: number;
    failed: number;
    reclaimed: number;
    remaining: number;
    statements: number;
    batches: number;
    durationMs: number;
  }>;
  readonly projectionTotals: Readonly<{
    operations: number;
    rows: number;
    batches: number;
    statements: number;
    mismatchCount: number;
    fallbacks: number;
    durationMs: number;
  }>;
}

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

export class PerformanceTelemetryBuffer {
  readonly capacity: number;
  readonly now: () => Date;
  readonly overflow: "drop_oldest" | "throw";
  #events: PerformanceTelemetryRecord[] = [];
  #sequence = 0;
  #droppedEvents = 0;

  constructor(input: {
    readonly capacity?: number;
    readonly now?: () => Date;
    readonly overflow?: "drop_oldest" | "throw";
  } = {}) {
    const capacity = input.capacity ?? 1_024;
    if (!Number.isSafeInteger(capacity) || capacity < 1 ||
      capacity > PERFORMANCE_TELEMETRY_MAX_EVENTS) {
      throw new RangeError("performance telemetry capacity must be 1..100000");
    }
    if (input.overflow !== undefined && input.overflow !== "drop_oldest" &&
      input.overflow !== "throw") {
      throw new TypeError("unsupported performance telemetry overflow policy");
    }
    this.capacity = capacity;
    this.now = input.now ?? (() => new Date());
    this.overflow = input.overflow ?? "drop_oldest";
  }

  record(input: PerformanceTelemetryInput): PerformanceTelemetryRecord {
    if (this.#events.length === this.capacity && this.overflow === "throw") {
      throw new RangeError("performance telemetry capacity exhausted before event drop");
    }
    const record = createPerformanceTelemetryRecord(
      input,
      this.#sequence + 1,
      this.now(),
    );
    this.#sequence += 1;
    if (this.#events.length === this.capacity) {
      this.#events.shift();
      this.#droppedEvents += 1;
    }
    this.#events.push(record);
    return record;
  }

  snapshot(): PerformanceTelemetryFlush {
    return this.#flush(false);
  }

  drain(): PerformanceTelemetryFlush {
    return this.#flush(true);
  }

  /** Routine APIs use this aggregate and never serialize the event buffer. */
  drainSummary(): PerformanceTelemetryCompactSummary {
    return summarizePerformanceTelemetry(this.#flush(true));
  }

  #flush(clear: boolean): PerformanceTelemetryFlush {
    const events = Object.freeze([...this.#events]);
    const eventCounts = Object.fromEntries(
      EVENT_KINDS.map((kind) => [kind, 0]),
    ) as Record<PerformanceTelemetryDetails["kind"], number>;
    for (const event of events) eventCounts[event.details.kind] += 1;
    const result: PerformanceTelemetryFlush = Object.freeze({
      schemaVersion: PERFORMANCE_TELEMETRY_SCHEMA_VERSION,
      flushedAt: canonicalTimestamp(this.now()),
      events,
      summary: Object.freeze({
        eventCount: events.length,
        droppedEvents: this.#droppedEvents,
        eventCounts: Object.freeze(eventCounts),
      }),
    });
    if (clear) {
      this.#events = [];
      this.#droppedEvents = 0;
    }
    return result;
  }
}

/** Builds the exact sanitized record that a sink will accept. */
export function createPerformanceTelemetryRecord(
  input: PerformanceTelemetryInput,
  sequence: number,
  recordedAt: Date,
): PerformanceTelemetryRecord {
  if (!Number.isSafeInteger(sequence) || sequence < 1 ||
    sequence > PERFORMANCE_TELEMETRY_MAX_EVENTS) {
    throw new RangeError("performance telemetry sequence is out of bounds");
  }
  return Object.freeze({
    schemaVersion: PERFORMANCE_TELEMETRY_SCHEMA_VERSION,
    sequence,
    recordedAt: canonicalTimestamp(recordedAt),
    context: Object.freeze(sanitizedContext(input.context)),
    details: Object.freeze(sanitizedDetails(input.details)),
  });
}

export function summarizePerformanceTelemetry(
  flush: PerformanceTelemetryFlush,
): PerformanceTelemetryCompactSummary {
  const stages = new Map<string, {
    stage: string;
    outcome: StageTelemetry["outcome"];
    count: number;
    totalDurationMs: number;
  }>();
  const publicationOutcomes: Record<PublicationTelemetry["outcome"], number> = {
    published: 0,
    preserved_prior: 0,
    failed: 0,
    paused: 0,
  };
  const queueTotals = {
    upserted: 0,
    selected: 0,
    claimed: 0,
    completed: 0,
    deferred: 0,
    failed: 0,
    reclaimed: 0,
    remaining: 0,
    statements: 0,
    batches: 0,
    durationMs: 0,
  };
  const projectionTotals = {
    operations: 0,
    rows: 0,
    batches: 0,
    statements: 0,
    mismatchCount: 0,
    fallbacks: 0,
    durationMs: 0,
  };
  for (const event of flush.events) {
    if (event.details.kind === "stage") {
      const key = `${event.details.stage}\u0000${event.details.outcome}`;
      const current = stages.get(key) ?? {
        stage: event.details.stage,
        outcome: event.details.outcome,
        count: 0,
        totalDurationMs: 0,
      };
      current.count += 1;
      current.totalDurationMs += event.details.durationMs ?? 0;
      stages.set(key, current);
    } else if (event.details.kind === "publication") {
      publicationOutcomes[event.details.outcome] += 1;
    } else if (event.details.kind === "queue") {
      queueTotals.upserted += event.details.upserted;
      queueTotals.selected += event.details.selected;
      queueTotals.claimed += event.details.claimed;
      queueTotals.completed += event.details.completed;
      queueTotals.deferred += event.details.deferred;
      queueTotals.failed += event.details.failed;
      queueTotals.reclaimed += event.details.reclaimed;
      queueTotals.remaining += event.details.remaining;
      queueTotals.statements += event.details.statements;
      queueTotals.batches += event.details.batches;
      queueTotals.durationMs += event.details.durationMs;
    } else if (event.details.kind === "projection") {
      projectionTotals.operations += 1;
      projectionTotals.rows += event.details.rows;
      projectionTotals.batches += event.details.batches;
      projectionTotals.statements += event.details.statements;
      projectionTotals.mismatchCount += event.details.mismatchCount;
      projectionTotals.fallbacks += event.details.fallbackActivated ? 1 : 0;
      projectionTotals.durationMs += event.details.durationMs;
    }
  }
  const stageSummaries = [...stages.values()]
    .sort((left, right) =>
      left.stage.localeCompare(right.stage) ||
      left.outcome.localeCompare(right.outcome)
    )
    .slice(0, 64)
    .map((entry) => Object.freeze({
      ...entry,
      totalDurationMs: Math.round(entry.totalDurationMs * 1_000) / 1_000,
    }));
  return Object.freeze({
    schemaVersion: flush.schemaVersion,
    flushedAt: flush.flushedAt,
    eventCount: flush.summary.eventCount,
    droppedEvents: flush.summary.droppedEvents,
    eventCounts: flush.summary.eventCounts,
    stages: Object.freeze(stageSummaries),
    publicationOutcomes: Object.freeze(publicationOutcomes),
    queueTotals: Object.freeze({
      ...queueTotals,
      durationMs: Math.round(queueTotals.durationMs * 1_000) / 1_000,
    }),
    projectionTotals: Object.freeze({
      ...projectionTotals,
      durationMs: Math.round(projectionTotals.durationMs * 1_000) / 1_000,
    }),
  });
}

export const PERFORMANCE_TELEMETRY_REPORT_SCHEMA_VERSION =
  "auction-discovery-performance-report-v1" as const;

export type PerformanceTelemetryScenario =
  | "unchanged"
  | "one_delta"
  | "tail_heavy"
  | "frontier";

export interface PerformanceTelemetryReportMetadata {
  readonly scenario: PerformanceTelemetryScenario;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly processLaunchCount: number;
  /** Exact source set this complete report must cover. */
  readonly expectedSourceIds: readonly string[];
}

export interface PerformanceTelemetryReport {
  readonly schemaVersion: typeof PERFORMANCE_TELEMETRY_REPORT_SCHEMA_VERSION;
  readonly telemetrySchemaVersion: typeof PERFORMANCE_TELEMETRY_SCHEMA_VERSION;
  readonly scenario: PerformanceTelemetryScenario;
  readonly period: Readonly<{
    startedAt: string;
    endedAt: string;
    wallTimeMs: number;
  }>;
  readonly criticalPath: Readonly<{
    sourceOrLane: string;
    estimatedRemainingMs: number;
    observedAt: string;
  }>;
  readonly requests: Readonly<{
    total: number;
    bySourceRole: readonly Readonly<{
      sourceId: string;
      requestRole: string;
      count: number;
    }>[];
  }>;
  readonly timingMs: Readonly<{
    pacingWait: number;
    networkWait: number;
    decompression: number;
    hashing: number;
    parseValidation: number;
    callbackQueue: number;
    commit: number;
  }>;
  readonly d1: Readonly<{
    statements: number;
    batches: number;
    writerOccupancyMs: number;
    writerOccupancyRatio: number;
    byEventKind: Readonly<{
      database: Readonly<{ statements: number; batches: number }>;
      queue: Readonly<{ statements: number; batches: number }>;
      projection: Readonly<{ statements: number; batches: number }>;
      proximity: Readonly<{ statements: number; batches: number }>;
    }>;
  }>;
  readonly processLaunchCount: number;
  readonly models: Readonly<{
    loadCount: number;
    unloadCount: number;
    byRole: Readonly<Record<"text" | "embedding", Readonly<{
      loadCount: number;
      unloadCount: number;
    }>>>;
  }>;
  readonly bytes: Readonly<{
    /** Sum of responseBytes across the complete request event stream. */
    downloaded: number;
    /** Image-subsystem bytes, reported separately to avoid double counting. */
    imageDownloaded: number;
    contentHashReused: number;
  }>;
  readonly workItems: Readonly<{
    created: number;
    claimed: number;
    completed: number;
    deferred: number;
    failed: number;
    reclaimed: number;
    remaining: number;
  }>;
  readonly equivalence: Readonly<{
    publication: Readonly<{
      equivalent: boolean;
      evidenceCount: number;
      reasonCodes: readonly string[];
    }>;
    release: Readonly<{
      equivalent: boolean;
      evidenceCount: number;
      reasonCodes: readonly string[];
    }>;
    publicationOutcomes: Readonly<
      Record<PublicationTelemetry["outcome"], number>
    >;
  }>;
  readonly sourceCoverage: readonly Readonly<{
    sourceId: string;
    coverageMode: PerformanceCoverageMode;
    reasonCode: string;
  }>[];
  readonly bounds: Readonly<{
    inputEvents: number;
    maximumInputEvents: number;
    numericSaturations: number;
    truncatedRequestGroups: number;
    truncatedCoverageSources: number;
    truncatedEquivalenceReasons: number;
  }>;
}

const MAX_REPORT_EVENTS = PERFORMANCE_TELEMETRY_MAX_EVENTS;
const MAX_REQUEST_GROUPS = 128;
const MAX_COVERAGE_SOURCES = 64;
const MAX_EQUIVALENCE_REASONS = 32;
const MAX_EXPECTED_SOURCE_IDS = 1_000;

export function buildPerformanceTelemetryReport(
  records: readonly PerformanceTelemetryRecord[],
  metadata: PerformanceTelemetryReportMetadata,
): PerformanceTelemetryReport {
  const checkedMetadata = validatedReportMetadata(metadata);
  if (records.length > MAX_REPORT_EVENTS) {
    throw new RangeError(`performance report accepts at most ${MAX_REPORT_EVENTS} events`);
  }
  const checkedRecords = records.map((record, index) => {
    const checked = parsePerformanceTelemetryRecord(record);
    if (checked.sequence !== index + 1) {
      throw new Error("telemetry sequence must be complete, ordered, and start at one");
    }
    return checked;
  });
  const reportStartedMs = timestampMs(checkedMetadata.startedAt);
  const reportEndedMs = timestampMs(checkedMetadata.endedAt);
  const wallTimeMs = reportEndedMs - reportStartedMs;
  if (wallTimeMs < 0) throw new Error("report end timestamp precedes start timestamp");
  for (const event of checkedRecords) {
    const recordedMs = timestampMs(event.recordedAt);
    if (recordedMs < reportStartedMs || recordedMs > reportEndedMs) {
      throw new Error("telemetry event falls outside the declared report period");
    }
  }

  let numericSaturations = 0;
  const add = (left: number, right: number): number => {
    const total = left + right;
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) {
      numericSaturations += 1;
      return Number.MAX_SAFE_INTEGER;
    }
    return roundMilliseconds(total);
  };
  const requestGroups = new Map<string, {
    sourceId: string;
    requestRole: string;
    count: number;
  }>();
  const requestTiming = {
    pacingWait: 0,
    networkWait: 0,
    decompression: 0,
    hashing: 0,
    parseValidation: 0,
  };
  const callbackAndCommit = { callbackQueue: 0, commit: 0 };
  const d1ByEventKind = {
    database: { statements: 0, batches: 0 },
    queue: { statements: 0, batches: 0 },
    projection: { statements: 0, batches: 0 },
    proximity: { statements: 0, batches: 0 },
  };
  const models = {
    text: { loadCount: 0, unloadCount: 0, evidenceCount: 0 },
    embedding: { loadCount: 0, unloadCount: 0, evidenceCount: 0 },
  };
  const bytes = { downloaded: 0, imageDownloaded: 0, contentHashReused: 0 };
  const workItems = {
    created: 0,
    claimed: 0,
    completed: 0,
    deferred: 0,
    failed: 0,
    reclaimed: 0,
  };
  const remainingByStage = new Map<string, number>();
  const equivalence = {
    publication: { values: [] as boolean[], reasonCodes: new Set<string>() },
    release: { values: [] as boolean[], reasonCodes: new Set<string>() },
  };
  const publicationOutcomes: Record<PublicationTelemetry["outcome"], number> = {
    published: 0,
    preserved_prior: 0,
    failed: 0,
    paused: 0,
  };
  const coverageBySource = new Map<string, {
    sourceId: string;
    coverageMode: PerformanceCoverageMode;
    reasonCode: string;
  }>();
  let criticalPath: CriticalPathTelemetry | null = null;
  let databaseEvidenceCount = 0;
  let queueEvidenceCount = 0;
  let imageEvidenceCount = 0;
  let requestEvidenceCount = 0;

  for (const event of checkedRecords) {
    const details = event.details;
    switch (details.kind) {
      case "request": {
        requestEvidenceCount += 1;
        const sourceId = event.context.sourceId;
        if (!sourceId) throw new Error("request telemetry requires a source context");
        const requiredTiming = [
          details.pacingWaitMs,
          details.startedAt,
          details.endedAt,
          details.decompressionMs,
          details.hashingMs,
          details.parsingMs,
          details.validationMs,
          details.responseBytes,
        ];
        if (requiredTiming.some((value) => value === null)) {
          throw new Error("request telemetry is missing required timing evidence");
        }
        const startedMs = timestampMs(details.startedAt!);
        const endedMs = timestampMs(details.endedAt!);
        if (endedMs < startedMs) throw new Error("request end precedes request start");
        if (startedMs < reportStartedMs || endedMs > reportEndedMs) {
          throw new Error("request timing falls outside the declared report period");
        }
        const key = `${sourceId}\u0000${details.requestRole}`;
        const group = requestGroups.get(key) ?? {
          sourceId,
          requestRole: details.requestRole,
          count: 0,
        };
        group.count = add(group.count, 1);
        requestGroups.set(key, group);
        requestTiming.pacingWait = add(
          requestTiming.pacingWait,
          details.pacingWaitMs!,
        );
        requestTiming.networkWait = add(
          requestTiming.networkWait,
          endedMs - startedMs,
        );
        requestTiming.decompression = add(
          requestTiming.decompression,
          details.decompressionMs!,
        );
        requestTiming.hashing = add(requestTiming.hashing, details.hashingMs!);
        requestTiming.parseValidation = add(
          requestTiming.parseValidation,
          details.parsingMs! + details.validationMs!,
        );
        bytes.downloaded = add(bytes.downloaded, details.responseBytes!);
        break;
      }
      case "database":
        databaseEvidenceCount += 1;
        d1ByEventKind.database.statements = add(
          d1ByEventKind.database.statements,
          details.statementCount,
        );
        d1ByEventKind.database.batches = add(
          d1ByEventKind.database.batches,
          details.batchCount,
        );
        if (details.callbackQueueWaitMs == null) {
          throw new Error("database telemetry is missing callback queue evidence");
        }
        callbackAndCommit.callbackQueue = add(
          callbackAndCommit.callbackQueue,
          details.callbackQueueWaitMs,
        );
        callbackAndCommit.commit = add(callbackAndCommit.commit, details.mutationMs);
        break;
      case "queue":
        queueEvidenceCount += 1;
        if (details.created == null) {
          throw new Error("queue telemetry is missing exact created-work evidence");
        }
        workItems.created = add(workItems.created, details.created);
        workItems.claimed = add(workItems.claimed, details.claimed);
        workItems.completed = add(workItems.completed, details.completed);
        workItems.deferred = add(workItems.deferred, details.deferred);
        workItems.failed = add(workItems.failed, details.failed);
        workItems.reclaimed = add(workItems.reclaimed, details.reclaimed);
        remainingByStage.set(details.stage, details.remaining);
        d1ByEventKind.queue.statements = add(
          d1ByEventKind.queue.statements,
          details.statements,
        );
        d1ByEventKind.queue.batches = add(
          d1ByEventKind.queue.batches,
          details.batches,
        );
        break;
      case "projection":
        d1ByEventKind.projection.statements = add(
          d1ByEventKind.projection.statements,
          details.statements,
        );
        d1ByEventKind.projection.batches = add(
          d1ByEventKind.projection.batches,
          details.batches,
        );
        break;
      case "proximity":
        d1ByEventKind.proximity.statements = add(
          d1ByEventKind.proximity.statements,
          details.statements,
        );
        d1ByEventKind.proximity.batches = add(
          d1ByEventKind.proximity.batches,
          details.batches,
        );
        break;
      case "image":
        imageEvidenceCount += 1;
        if (details.contentHashBytesReused == null) {
          throw new Error("image telemetry is missing exact reused-byte evidence");
        }
        bytes.imageDownloaded = add(
          bytes.imageDownloaded,
          details.downloadedBytes,
        );
        bytes.contentHashReused = add(
          bytes.contentHashReused,
          details.contentHashBytesReused,
        );
        break;
      case "model": {
        if (details.loadCount == null || details.unloadCount == null) {
          throw new Error("model telemetry is missing lifecycle-count evidence");
        }
        const role = models[details.role];
        role.evidenceCount += 1;
        role.loadCount = add(role.loadCount, details.loadCount);
        role.unloadCount = add(role.unloadCount, details.unloadCount);
        break;
      }
      case "publication":
        publicationOutcomes[details.outcome] = add(
          publicationOutcomes[details.outcome],
          1,
        );
        break;
      case "equivalence":
        equivalence[details.surface].values.push(details.equivalent);
        equivalence[details.surface].reasonCodes.add(details.reasonCode);
        break;
      case "coverage": {
        const sourceId = event.context.sourceId;
        const coverageMode = event.context.coverageMode;
        if (!sourceId || !coverageMode) {
          throw new Error("coverage telemetry requires source and coverage mode context");
        }
        const entry = { sourceId, coverageMode, reasonCode: details.reasonCode };
        const prior = coverageBySource.get(sourceId);
        if (prior && (prior.coverageMode !== entry.coverageMode ||
          prior.reasonCode !== entry.reasonCode)) {
          throw new Error("coverage telemetry conflicts for one source");
        }
        coverageBySource.set(sourceId, entry);
        break;
      }
      case "critical_path":
        if (!criticalPath || details.observedAt > criticalPath.observedAt) {
          criticalPath = details;
        }
        break;
      default:
        break;
    }
  }

  if (!criticalPath) throw new Error("missing critical-path evidence");
  if (requestEvidenceCount === 0) throw new Error("missing request timing evidence");
  if (databaseEvidenceCount === 0) throw new Error("missing D1/writer evidence");
  if (queueEvidenceCount === 0) throw new Error("missing work-item evidence");
  if (imageEvidenceCount === 0) throw new Error("missing byte-transfer evidence");
  if (models.text.evidenceCount === 0 || models.embedding.evidenceCount === 0) {
    throw new Error("missing text or embedding model lifecycle evidence");
  }
  if (equivalence.publication.values.length === 0 ||
    equivalence.release.values.length === 0) {
    throw new Error("missing publication or release equivalence evidence");
  }
  if (coverageBySource.size === 0) throw new Error("missing source coverage evidence");
  const actualCoverageSourceIds = [...coverageBySource.keys()].sort();
  const expectedCoverageSourceIds = [...checkedMetadata.expectedSourceIds].sort();
  if (actualCoverageSourceIds.length !== expectedCoverageSourceIds.length ||
    actualCoverageSourceIds.some((sourceId, index) =>
      sourceId !== expectedCoverageSourceIds[index]
    )) {
    throw new Error("source coverage does not match the complete expected source set");
  }
  if (callbackAndCommit.commit > wallTimeMs) {
    throw new Error("writer occupancy exceeds total wall time");
  }

  const allRequestGroups = [...requestGroups.values()].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId) ||
    left.requestRole.localeCompare(right.requestRole)
  );
  const allCoverage = [...coverageBySource.values()].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
  );
  let truncatedEquivalenceReasons = 0;
  const equivalenceSummary = (surface: "publication" | "release") => {
    const evidence = equivalence[surface];
    const allReasons = [...evidence.reasonCodes].sort();
    truncatedEquivalenceReasons += Math.max(
      0,
      allReasons.length - MAX_EQUIVALENCE_REASONS,
    );
    return Object.freeze({
      equivalent: evidence.values.every(Boolean),
      evidenceCount: evidence.values.length,
      reasonCodes: Object.freeze(allReasons.slice(0, MAX_EQUIVALENCE_REASONS)),
    });
  };
  let remaining = 0;
  for (const value of remainingByStage.values()) remaining = add(remaining, value);
  let d1Statements = 0;
  let d1Batches = 0;
  for (const totals of Object.values(d1ByEventKind)) {
    d1Statements = add(d1Statements, totals.statements);
    d1Batches = add(d1Batches, totals.batches);
  }
  const requestTotal = allRequestGroups.reduce(
    (total, group) => add(total, group.count),
    0,
  );

  return Object.freeze({
    schemaVersion: PERFORMANCE_TELEMETRY_REPORT_SCHEMA_VERSION,
    telemetrySchemaVersion: PERFORMANCE_TELEMETRY_SCHEMA_VERSION,
    scenario: checkedMetadata.scenario,
    period: Object.freeze({
      startedAt: checkedMetadata.startedAt,
      endedAt: checkedMetadata.endedAt,
      wallTimeMs,
    }),
    criticalPath: Object.freeze({ ...criticalPath }),
    requests: Object.freeze({
      total: requestTotal,
      bySourceRole: Object.freeze(
        allRequestGroups.slice(0, MAX_REQUEST_GROUPS).map((entry) =>
          Object.freeze({ ...entry })
        ),
      ),
    }),
    timingMs: Object.freeze({ ...requestTiming, ...callbackAndCommit }),
    d1: Object.freeze({
      statements: d1Statements,
      batches: d1Batches,
      writerOccupancyMs: callbackAndCommit.commit,
      writerOccupancyRatio: wallTimeMs === 0
        ? callbackAndCommit.commit === 0 ? 0 : 1
        : roundRatio(callbackAndCommit.commit / wallTimeMs),
      byEventKind: Object.freeze({
        database: Object.freeze({ ...d1ByEventKind.database }),
        queue: Object.freeze({ ...d1ByEventKind.queue }),
        projection: Object.freeze({ ...d1ByEventKind.projection }),
        proximity: Object.freeze({ ...d1ByEventKind.proximity }),
      }),
    }),
    processLaunchCount: checkedMetadata.processLaunchCount,
    models: Object.freeze({
      loadCount: add(models.text.loadCount, models.embedding.loadCount),
      unloadCount: add(models.text.unloadCount, models.embedding.unloadCount),
      byRole: Object.freeze({
        text: Object.freeze({
          loadCount: models.text.loadCount,
          unloadCount: models.text.unloadCount,
        }),
        embedding: Object.freeze({
          loadCount: models.embedding.loadCount,
          unloadCount: models.embedding.unloadCount,
        }),
      }),
    }),
    bytes: Object.freeze(bytes),
    workItems: Object.freeze({ ...workItems, remaining }),
    equivalence: Object.freeze({
      publication: equivalenceSummary("publication"),
      release: equivalenceSummary("release"),
      publicationOutcomes: Object.freeze(publicationOutcomes),
    }),
    sourceCoverage: Object.freeze(
      allCoverage.slice(0, MAX_COVERAGE_SOURCES).map((entry) =>
        Object.freeze({ ...entry })
      ),
    ),
    bounds: Object.freeze({
      inputEvents: checkedRecords.length,
      maximumInputEvents: MAX_REPORT_EVENTS,
      numericSaturations,
      truncatedRequestGroups: Math.max(0, allRequestGroups.length - MAX_REQUEST_GROUPS),
      truncatedCoverageSources: Math.max(0, allCoverage.length - MAX_COVERAGE_SOURCES),
      truncatedEquivalenceReasons,
    }),
  });
}

const DETAIL_KEYS: Readonly<Record<PerformanceTelemetryDetails["kind"], readonly string[]>> = {
  stage: ["kind", "stage", "outcome", "durationMs", "releaseOrPrimeMs", "reasonCode"],
  scheduler: [
    "kind",
    "dependencyDecision",
    "laneKey",
    "queueWaitMs",
    "estimatedRemainingMs",
    "fairnessQuantum",
  ],
  request: [
    "kind",
    "requestIdentity",
    "requestRole",
    "laneKey",
    "page",
    "partition",
    "sentinel",
    "reservedAt",
    "pacingWaitMs",
    "acquisitionQueueWaitMs",
    "startedAt",
    "endedAt",
    "statusCode",
    "retry",
    "retryAfterMs",
    "responseBytes",
    "decompressionMs",
    "hashingMs",
    "parsingMs",
    "validationMs",
  ],
  database: [
    "kind",
    "operation",
    "statementCount",
    "batchCount",
    "mutationMs",
    "callbackQueueWaitMs",
    "checkpointMs",
  ],
  publication: [
    "kind",
    "outcome",
    "priorHeadIdentity",
    "resultingHeadIdentity",
    "preservationReasonCode",
    "firstSeenCount",
    "materiallyChangedCount",
    "terminalCount",
    "priorUnionCount",
    "resultingUnionCount",
    "publicationMs",
  ],
  queue: [
    "kind",
    "operation",
    "stage",
    "created",
    "upserted",
    "selected",
    "claimed",
    "completed",
    "deferred",
    "failed",
    "reclaimed",
    "remaining",
    "statements",
    "batches",
    "durationMs",
  ],
  projection: [
    "kind",
    "operation",
    "scopeType",
    "scopeIdentity",
    "resultCount",
    "resultHash",
    "rows",
    "batches",
    "statements",
    "durationMs",
    "generationVectorHash",
    "targetGeneration",
    "cursorRows",
    "mismatchCount",
    "fallbackActivated",
    "reasonCode",
  ],
  proximity: [
    "kind",
    "selected",
    "selectorMs",
    "projectionMs",
    "calculationMs",
    "persistenceMs",
    "cacheHits",
    "statements",
    "batches",
  ],
  image: [
    "kind",
    "downloadedBytes",
    "contentHashBytesReused",
    "contentHashHits",
    "archiveWrites",
    "attempted",
    "failed",
  ],
  model: [
    "kind",
    "role",
    "loadCount",
    "unloadCount",
    "healthMs",
    "loadMs",
    "generationMs",
    "embeddingMs",
    "unloadMs",
    "inputTokens",
    "outputTokens",
  ],
  scoring: [
    "kind",
    "materializationMs",
    "pythonMs",
    "importMs",
    "selected",
    "scored",
    "skippedNoChange",
  ],
  resources: [
    "kind",
    "aggregateCpuPercent",
    "workingSetBytes",
    "availableMemoryBytes",
    "handleCount",
    "gpuResidentBytes",
  ],
  critical_path: ["kind", "sourceOrLane", "estimatedRemainingMs", "observedAt"],
  equivalence: ["kind", "surface", "equivalent", "reasonCode"],
  coverage: ["kind", "reasonCode"],
};

/** Strict public-schema parser for report/CLI boundaries; it never sanitizes input. */
export function parsePerformanceTelemetryRecord(
  value: unknown,
): PerformanceTelemetryRecord {
  assertPlainRecord(value, "telemetry event");
  assertExactKeys(
    value,
    ["schemaVersion", "sequence", "recordedAt", "context", "details"],
    "telemetry event",
  );
  if (value.schemaVersion !== PERFORMANCE_TELEMETRY_SCHEMA_VERSION) {
    throw new Error("unsupported telemetry schema version");
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) {
    throw new Error("telemetry sequence must be a positive safe integer");
  }
  if (canonicalTimestampOrNull(value.recordedAt as string) !== value.recordedAt) {
    throw new Error("telemetry recordedAt must be a canonical timestamp");
  }
  assertPlainRecord(value.context, "telemetry context");
  assertExactKeys(
    value.context,
    [
      "campaignId",
      "runId",
      "sourceId",
      "traversalId",
      "publicationId",
      "coverageMode",
    ],
    "telemetry context",
  );
  assertNoSensitiveStrings(value);
  const rawContext = value.context as unknown as PerformanceTelemetryContext;
  const safeContext = sanitizedContext(rawContext);
  assertScalarShapeEqual(value.context, safeContext, "telemetry context");

  assertPlainRecord(value.details, "telemetry details");
  const kind = value.details.kind;
  if (typeof kind !== "string" || !EVENT_KINDS.includes(
    kind as PerformanceTelemetryDetails["kind"],
  )) {
    throw new Error("unsupported telemetry event kind");
  }
  const typedKind = kind as PerformanceTelemetryDetails["kind"];
  assertExactKeys(value.details, DETAIL_KEYS[typedKind], `${typedKind} telemetry`);
  assertDetailEnums(value.details, typedKind);
  assertFiniteSafeNumbers(value.details);
  const rawDetails = value.details as unknown as PerformanceTelemetryDetails;
  const safeDetails = sanitizedDetails(rawDetails);
  assertScalarShapeEqual(value.details, safeDetails, `${typedKind} telemetry`);
  return value as unknown as PerformanceTelemetryRecord;
}

function validatedReportMetadata(
  metadata: PerformanceTelemetryReportMetadata,
): PerformanceTelemetryReportMetadata {
  assertPlainRecord(metadata, "report metadata");
  assertExactKeys(
    metadata,
    [
      "scenario",
      "startedAt",
      "endedAt",
      "processLaunchCount",
      "expectedSourceIds",
    ],
    "report metadata",
  );
  if (!["unchanged", "one_delta", "tail_heavy", "frontier"].includes(
    metadata.scenario,
  )) {
    throw new Error("unsupported report scenario");
  }
  if (canonicalTimestampOrNull(metadata.startedAt) !== metadata.startedAt ||
    canonicalTimestampOrNull(metadata.endedAt) !== metadata.endedAt) {
    throw new Error("report timestamps must be canonical ISO timestamps");
  }
  if (!Number.isSafeInteger(metadata.processLaunchCount) ||
    metadata.processLaunchCount < 0) {
    throw new Error("process launch count must be a nonnegative safe integer");
  }
  if (!Array.isArray(metadata.expectedSourceIds) ||
    metadata.expectedSourceIds.length < 1 ||
    metadata.expectedSourceIds.length > MAX_EXPECTED_SOURCE_IDS) {
    throw new Error("expected source IDs must be a nonempty bounded array");
  }
  const expectedSourceIds = metadata.expectedSourceIds.map((sourceId) => {
    if (typeof sourceId !== "string" || requiredLabel(sourceId) !== sourceId) {
      throw new Error("expected source ID is invalid or noncanonical");
    }
    return sourceId;
  });
  if (new Set(expectedSourceIds).size !== expectedSourceIds.length) {
    throw new Error("expected source IDs must be unique");
  }
  return Object.freeze({ ...metadata, expectedSourceIds: Object.freeze(expectedSourceIds) });
}

function assertDetailEnums(
  value: Record<string, unknown>,
  kind: PerformanceTelemetryDetails["kind"],
): void {
  const oneOf = (field: string, allowed: readonly unknown[]) => {
    if (!allowed.includes(value[field])) {
      throw new Error(`${kind} telemetry has invalid ${field}`);
    }
  };
  switch (kind) {
    case "stage":
      oneOf("outcome", ["started", "completed", "failed", "skipped"]);
      break;
    case "publication":
      oneOf("outcome", ["published", "preserved_prior", "failed", "paused"]);
      break;
    case "queue":
      oneOf("operation", [
        "upsert",
        "select",
        "claim",
        "renew",
        "complete",
        "defer",
        "fail",
        "reclaim",
        "snapshot",
      ]);
      break;
    case "projection":
      oneOf("operation", [
        "canonical_select",
        "rebuild",
        "projection_read",
        "fanout",
        "shadow_compare",
        "canonical_fallback",
      ]);
      oneOf("scopeType", ["listing", "source", "group", "global", null]);
      break;
    case "model":
      oneOf("role", ["text", "embedding"]);
      break;
    case "equivalence":
      oneOf("surface", ["publication", "release"]);
      break;
    default:
      break;
  }
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

function assertScalarShapeEqual(
  raw: Record<string, unknown>,
  safe: object,
  label: string,
): void {
  const normalized = safe as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!Object.is(raw[key], normalized[key])) {
      throw new Error(`${label} contains a noncanonical or invalid value`);
    }
  }
}

function assertFiniteSafeNumbers(value: Record<string, unknown>): void {
  for (const field of Object.values(value)) {
    if (typeof field === "number" && (!Number.isFinite(field) || field < 0 ||
      field > Number.MAX_SAFE_INTEGER)) {
      throw new Error("telemetry measurements must be finite nonnegative safe numbers");
    }
  }
}

function assertNoSensitiveStrings(value: unknown): void {
  if (typeof value === "string") {
    if (/\b(?:bearer|basic)\s+[a-z0-9._~+/-]+=*/iu.test(value) ||
      /\b(?:api[_-]?key|authorization|cookie|password|secret|signature|token)\s*[:=]/iu.test(
        value,
      ) || /^(?:[a-z]:[\\/]|\\\\|\/(?:users|home|tmp|var|etc)\/)/iu.test(value) ||
      /:\/\//u.test(value)) {
      throw new Error("telemetry contains forbidden secret-bearing or raw-location text");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSensitiveStrings(entry);
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) assertNoSensitiveStrings(entry);
  }
}

function timestampMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid telemetry timestamp");
  return parsed;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundRatio(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Produces a stable classified identity without retaining URL queries,
 * fragments, credentials, or acquired content.
 */
export function requestIdentityForTelemetry(value: string): string {
  try {
    const parsed = new URL(value);
    return `request:${stableContentHash({
      host: parsed.hostname.toLowerCase(),
      port: parsed.port || null,
      protocol: parsed.protocol.toLowerCase(),
      pathname: parsed.pathname,
    })}`;
  } catch {
    return `request:${stableContentHash({ invalid: true })}`;
  }
}

export function serializePerformanceTelemetryJsonl(
  flush: PerformanceTelemetryFlush,
): string {
  const lines = flush.events.map((event) => JSON.stringify(event));
  lines.push(JSON.stringify({
    schemaVersion: flush.schemaVersion,
    kind: "flush_summary",
    flushedAt: flush.flushedAt,
    ...flush.summary,
  }));
  return `${lines.join("\n")}\n`;
}

function sanitizedContext(
  context: PerformanceTelemetryContext | undefined,
): PerformanceTelemetryContext {
  return {
    campaignId: classifiedLabel(context?.campaignId),
    runId: classifiedLabel(context?.runId),
    sourceId: classifiedLabel(context?.sourceId),
    traversalId: classifiedLabel(context?.traversalId),
    publicationId: classifiedLabel(context?.publicationId),
    coverageMode:
      context?.coverageMode === "complete_current" ||
        context?.coverageMode === "discovery_frontier"
        ? context.coverageMode
        : null,
  };
}

function sanitizedDetails(
  details: PerformanceTelemetryDetails,
): PerformanceTelemetryDetails {
  switch (details.kind) {
    case "stage":
      return {
        kind: details.kind,
        stage: requiredLabel(details.stage),
        outcome: details.outcome,
        durationMs: nonnegative(details.durationMs),
        releaseOrPrimeMs: nonnegative(details.releaseOrPrimeMs),
        reasonCode: classifiedLabel(details.reasonCode),
      };
    case "scheduler":
      return {
        kind: details.kind,
        dependencyDecision: requiredLabel(details.dependencyDecision),
        laneKey: classifiedLabel(details.laneKey),
        queueWaitMs: nonnegative(details.queueWaitMs),
        estimatedRemainingMs: nonnegative(details.estimatedRemainingMs),
        fairnessQuantum: nonnegativeInteger(details.fairnessQuantum),
      };
    case "request":
      return {
        kind: details.kind,
        requestIdentity: requiredRequestIdentity(details.requestIdentity),
        requestRole: requiredLabel(details.requestRole),
        laneKey: requiredLabel(details.laneKey),
        page: nonnegativeInteger(details.page),
        partition: classifiedLabel(details.partition),
        sentinel: details.sentinel === true || details.sentinel === false
          ? details.sentinel
          : null,
        reservedAt: canonicalTimestampOrNull(details.reservedAt),
        pacingWaitMs: nonnegative(details.pacingWaitMs),
        acquisitionQueueWaitMs: nonnegative(details.acquisitionQueueWaitMs),
        startedAt: canonicalTimestampOrNull(details.startedAt),
        endedAt: canonicalTimestampOrNull(details.endedAt),
        statusCode: httpStatus(details.statusCode),
        retry: nonnegativeInteger(details.retry),
        retryAfterMs: nonnegative(details.retryAfterMs),
        responseBytes: nonnegativeInteger(details.responseBytes),
        decompressionMs: nonnegative(details.decompressionMs),
        hashingMs: nonnegative(details.hashingMs),
        parsingMs: nonnegative(details.parsingMs),
        validationMs: nonnegative(details.validationMs),
      };
    case "database":
      return {
        kind: details.kind,
        operation: requiredLabel(details.operation),
        statementCount: requiredNonnegativeInteger(details.statementCount),
        batchCount: requiredNonnegativeInteger(details.batchCount),
        mutationMs: requiredNonnegative(details.mutationMs),
        callbackQueueWaitMs: nonnegative(details.callbackQueueWaitMs),
        checkpointMs: nonnegative(details.checkpointMs),
      };
    case "publication":
      return {
        kind: details.kind,
        outcome: details.outcome,
        priorHeadIdentity: classifiedLabel(details.priorHeadIdentity),
        resultingHeadIdentity: classifiedLabel(details.resultingHeadIdentity),
        preservationReasonCode: classifiedLabel(details.preservationReasonCode),
        firstSeenCount: nonnegativeInteger(details.firstSeenCount),
        materiallyChangedCount: nonnegativeInteger(details.materiallyChangedCount),
        terminalCount: nonnegativeInteger(details.terminalCount),
        priorUnionCount: nonnegativeInteger(details.priorUnionCount),
        resultingUnionCount: nonnegativeInteger(details.resultingUnionCount),
        publicationMs: nonnegative(details.publicationMs),
      };
    case "queue":
      return {
        kind: details.kind,
        operation: details.operation,
        stage: requiredLabel(details.stage),
        created: nonnegativeInteger(details.created),
        upserted: requiredNonnegativeInteger(details.upserted),
        selected: requiredNonnegativeInteger(details.selected),
        claimed: requiredNonnegativeInteger(details.claimed),
        completed: requiredNonnegativeInteger(details.completed),
        deferred: requiredNonnegativeInteger(details.deferred),
        failed: requiredNonnegativeInteger(details.failed),
        reclaimed: requiredNonnegativeInteger(details.reclaimed),
        remaining: requiredNonnegativeInteger(details.remaining),
        statements: requiredNonnegativeInteger(details.statements),
        batches: requiredNonnegativeInteger(details.batches),
        durationMs: requiredNonnegative(details.durationMs),
      };
    case "projection":
      return {
        kind: details.kind,
        operation: details.operation,
        scopeType: details.scopeType ?? null,
        scopeIdentity: classifiedLabel(details.scopeIdentity),
        resultCount: requiredNonnegativeInteger(details.resultCount),
        resultHash: classifiedLabel(details.resultHash),
        rows: requiredNonnegativeInteger(details.rows),
        batches: requiredNonnegativeInteger(details.batches),
        statements: requiredNonnegativeInteger(details.statements),
        durationMs: requiredNonnegative(details.durationMs),
        generationVectorHash: classifiedLabel(details.generationVectorHash),
        targetGeneration: nonnegativeInteger(details.targetGeneration),
        cursorRows: nonnegativeInteger(details.cursorRows),
        mismatchCount: requiredNonnegativeInteger(details.mismatchCount),
        fallbackActivated: details.fallbackActivated === true,
        reasonCode: classifiedLabel(details.reasonCode),
      };
    case "proximity":
      return {
        kind: details.kind,
        selected: requiredNonnegativeInteger(details.selected),
        selectorMs: requiredNonnegative(details.selectorMs),
        projectionMs: requiredNonnegative(details.projectionMs),
        calculationMs: requiredNonnegative(details.calculationMs),
        persistenceMs: requiredNonnegative(details.persistenceMs),
        cacheHits: requiredNonnegativeInteger(details.cacheHits),
        statements: requiredNonnegativeInteger(details.statements),
        batches: requiredNonnegativeInteger(details.batches),
      };
    case "image":
      return {
        kind: details.kind,
        downloadedBytes: requiredNonnegativeInteger(details.downloadedBytes),
        contentHashBytesReused: nonnegativeInteger(
          details.contentHashBytesReused,
        ),
        contentHashHits: requiredNonnegativeInteger(details.contentHashHits),
        archiveWrites: requiredNonnegativeInteger(details.archiveWrites),
        attempted: requiredNonnegativeInteger(details.attempted),
        failed: requiredNonnegativeInteger(details.failed),
      };
    case "model":
      return {
        kind: details.kind,
        role: details.role,
        loadCount: nonnegativeInteger(details.loadCount),
        unloadCount: nonnegativeInteger(details.unloadCount),
        healthMs: requiredNonnegative(details.healthMs),
        loadMs: requiredNonnegative(details.loadMs),
        generationMs: requiredNonnegative(details.generationMs),
        embeddingMs: requiredNonnegative(details.embeddingMs),
        unloadMs: requiredNonnegative(details.unloadMs),
        inputTokens: requiredNonnegativeInteger(details.inputTokens),
        outputTokens: requiredNonnegativeInteger(details.outputTokens),
      };
    case "scoring":
      return {
        kind: details.kind,
        materializationMs: requiredNonnegative(details.materializationMs),
        pythonMs: requiredNonnegative(details.pythonMs),
        importMs: requiredNonnegative(details.importMs),
        selected: requiredNonnegativeInteger(details.selected),
        scored: requiredNonnegativeInteger(details.scored),
        skippedNoChange: details.skippedNoChange === true,
      };
    case "resources":
      return {
        kind: details.kind,
        aggregateCpuPercent: boundedPercent(details.aggregateCpuPercent),
        workingSetBytes: requiredNonnegativeInteger(details.workingSetBytes),
        availableMemoryBytes: requiredNonnegativeInteger(details.availableMemoryBytes),
        handleCount: requiredNonnegativeInteger(details.handleCount),
        gpuResidentBytes: nonnegativeInteger(details.gpuResidentBytes),
      };
    case "critical_path":
      return {
        kind: details.kind,
        sourceOrLane: requiredLabel(details.sourceOrLane),
        estimatedRemainingMs: requiredNonnegative(details.estimatedRemainingMs),
        observedAt: canonicalTimestampString(details.observedAt),
      };
    case "equivalence":
      return {
        kind: details.kind,
        surface: details.surface,
        equivalent: details.equivalent === true,
        reasonCode: requiredLabel(details.reasonCode),
      };
    case "coverage":
      return {
        kind: details.kind,
        reasonCode: requiredLabel(details.reasonCode),
      };
  }
}

function requiredRequestIdentity(value: string): string {
  return /^request:fnv1a64:[0-9a-f]{16}$/u.test(value)
    ? value
    : requestIdentityForTelemetry("invalid:");
}

function requiredLabel(value: string): string {
  return classifiedLabel(value) ?? "missing";
}

function classifiedLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z0-9][a-z0-9_.:/-]{0,255}$/iu.test(trimmed)) return trimmed;
  return `classified:${stableContentHash(trimmed)}`;
}

function nonnegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function requiredNonnegative(value: number): number {
  return nonnegative(value) ?? 0;
}

function nonnegativeInteger(
  value: number | null | undefined,
): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function requiredNonnegativeInteger(value: number): number {
  return nonnegativeInteger(value) ?? 0;
}

function boundedPercent(value: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : 0;
}

function httpStatus(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value >= 100 && value <= 599
    ? value
    : null;
}

function canonicalTimestamp(value: Date): string {
  return Number.isFinite(value.getTime())
    ? value.toISOString()
    : new Date(0).toISOString();
}

function canonicalTimestampOrNull(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
    ? value
    : null;
}

function canonicalTimestampString(value: string): string {
  return canonicalTimestampOrNull(value) ?? new Date(0).toISOString();
}
