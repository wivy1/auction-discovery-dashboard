import {
  link,
  mkdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import {
  createPerformanceTelemetryRecord,
  PERFORMANCE_TELEMETRY_MAX_EVENTS,
  PERFORMANCE_TELEMETRY_MAX_JSONL_BYTES,
  PERFORMANCE_TELEMETRY_SCHEMA_VERSION,
  serializePerformanceTelemetryJsonl,
  type PerformanceTelemetryDetails,
  type PerformanceTelemetryFlush,
  type PerformanceTelemetryInput,
  type PerformanceTelemetryRecord,
  type PerformanceTelemetrySink,
} from "./telemetry";
import { stableContentHash } from "../sources/parsing";

export interface PerformanceTelemetrySessionReceipt {
  readonly schemaVersion: typeof PERFORMANCE_TELEMETRY_SCHEMA_VERSION;
  readonly eventCount: number;
  readonly byteCount: number;
  readonly contentIdentity: string;
}

/**
 * Strict benchmark/debug capture. Records stay sanitized and bounded in memory;
 * flush publishes one complete JSONL file atomically and never overwrites an
 * existing destination. Routine paths should continue to use compact summaries.
 */
export class PerformanceTelemetrySession implements PerformanceTelemetrySink {
  readonly destinationPath: string;
  readonly maximumEvents: number;
  readonly maximumBytes: number;
  readonly now: () => Date;
  #records: PerformanceTelemetryRecord[] = [];
  #eventBytes = 0;
  #closed = false;

  constructor(input: {
    readonly destinationPath: string;
    readonly maximumEvents?: number;
    readonly maximumBytes?: number;
    readonly now?: () => Date;
  }) {
    if (typeof input.destinationPath !== "string" ||
      input.destinationPath.trim() === "" || input.destinationPath.includes("\0") ||
      /^[a-z][a-z\d+.-]*:\/\//iu.test(input.destinationPath)) {
      throw new TypeError("performance telemetry requires an explicit local destination");
    }
    const maximumEvents = input.maximumEvents ?? PERFORMANCE_TELEMETRY_MAX_EVENTS;
    const maximumBytes = input.maximumBytes ?? PERFORMANCE_TELEMETRY_MAX_JSONL_BYTES;
    if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1 ||
      maximumEvents > PERFORMANCE_TELEMETRY_MAX_EVENTS) {
      throw new RangeError("performance telemetry session event bound is invalid");
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
      maximumBytes > PERFORMANCE_TELEMETRY_MAX_JSONL_BYTES) {
      throw new RangeError("performance telemetry session byte bound is invalid");
    }
    this.destinationPath = resolve(input.destinationPath);
    this.maximumEvents = maximumEvents;
    this.maximumBytes = maximumBytes;
    this.now = input.now ?? (() => new Date());
  }

  record(input: PerformanceTelemetryInput): PerformanceTelemetryRecord {
    if (this.#closed) throw new Error("performance telemetry session is closed");
    if (this.#records.length === this.maximumEvents) {
      throw new RangeError("performance telemetry session exhausted its event bound before drop");
    }
    const record = createPerformanceTelemetryRecord(
      input,
      this.#records.length + 1,
      this.now(),
    );
    const recordBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`, "utf8");
    if (this.#eventBytes + recordBytes > this.maximumBytes) {
      throw new RangeError("performance telemetry session exhausted its byte bound before drop");
    }
    this.#records.push(record);
    this.#eventBytes += recordBytes;
    return record;
  }

  async flush(): Promise<PerformanceTelemetrySessionReceipt> {
    if (this.#closed) throw new Error("performance telemetry session is closed");
    const flush = this.#buildFlush();
    const payload = serializePerformanceTelemetryJsonl(flush);
    const byteCount = Buffer.byteLength(payload, "utf8");
    if (byteCount > this.maximumBytes) {
      throw new RangeError("performance telemetry JSONL exceeds its byte bound");
    }
    this.#closed = true;
    await mkdir(dirname(this.destinationPath), { recursive: true });
    const temporaryPath = `${this.destinationPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, payload, { encoding: "utf8", flag: "wx", flush: true });
      await link(temporaryPath, this.destinationPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return Object.freeze({
      schemaVersion: PERFORMANCE_TELEMETRY_SCHEMA_VERSION,
      eventCount: flush.summary.eventCount,
      byteCount,
      contentIdentity: stableContentHash(payload),
    });
  }

  #buildFlush(): PerformanceTelemetryFlush {
    const eventCounts: Record<PerformanceTelemetryDetails["kind"], number> = {
      stage: 0,
      scheduler: 0,
      request: 0,
      database: 0,
      publication: 0,
      queue: 0,
      projection: 0,
      proximity: 0,
      image: 0,
      model: 0,
      scoring: 0,
      resources: 0,
      critical_path: 0,
      equivalence: 0,
      coverage: 0,
    };
    for (const record of this.#records) eventCounts[record.details.kind] += 1;
    return Object.freeze({
      schemaVersion: PERFORMANCE_TELEMETRY_SCHEMA_VERSION,
      flushedAt: this.now().toISOString(),
      events: Object.freeze([...this.#records]),
      summary: Object.freeze({
        eventCount: this.#records.length,
        droppedEvents: 0,
        eventCounts: Object.freeze(eventCounts),
      }),
    });
  }
}
