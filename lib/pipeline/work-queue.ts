import { pipelineScopeTypes, pipelineWorkStages } from "../../db/schema";
import { serializeCanonicalJson } from "../performance/generations";
import type {
  PerformanceTelemetryContext,
  PerformanceTelemetrySink,
} from "../performance/telemetry";

export type PipelineWorkStage = (typeof pipelineWorkStages)[number];
export type PipelineWorkSubjectType = (typeof pipelineScopeTypes)[number];

export type PipelineWorkSubject =
  | {
      readonly type: "listing";
      readonly id: string;
      readonly sourceId?: string | null;
    }
  | { readonly type: "source"; readonly id: string }
  | {
      readonly type: "group";
      readonly id: string;
      readonly sourceId?: string | null;
    }
  | { readonly type: "global"; readonly id: string };

export interface PipelineWorkProgress {
  readonly cursor: string | null;
  readonly generation: number | null;
  readonly rows: number;
}

export interface PipelineWorkItem {
  readonly stage: PipelineWorkStage;
  readonly subjectType: PipelineWorkSubjectType;
  readonly subjectId: string;
  readonly listingId: string | null;
  readonly sourceId: string | null;
  readonly subjectPayload: Readonly<Record<string, unknown>> | readonly unknown[] | null;
  readonly laneKey: string;
  readonly inputHash: string;
  readonly revision: number;
  readonly priority: number;
  readonly reasonCode: string;
  readonly availableAt: string;
  readonly inputAttemptCount: number;
  readonly lifetimeAttemptCount: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly claimedInputHash: string | null;
  readonly claimedRevision: number | null;
  readonly progress: PipelineWorkProgress;
  readonly lastErrorCode: string | null;
  readonly lastErrorFingerprint: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastClaimedAt: string | null;
  readonly lastCompletedAt: string | null;
}

export interface PipelineWorkClaimIdentity {
  readonly stage: PipelineWorkStage;
  readonly subjectType: PipelineWorkSubjectType;
  readonly subjectId: string;
  readonly owner: string;
  readonly inputHash: string;
  readonly revision: number;
}

export interface PipelineWorkQueueFilter {
  readonly stage?: PipelineWorkStage;
  readonly laneKey?: string;
  readonly sourceId?: string;
  readonly subjectType?: PipelineWorkSubjectType;
}

export interface PipelineWorkQueueCounts {
  readonly total: number;
  readonly ready: number;
  readonly liveClaims: number;
  readonly unavailable: number;
}

export type PipelineWorkCoalesceOutcome =
  | { readonly outcome: "inserted"; readonly item: PipelineWorkItem }
  | { readonly outcome: "input_changed"; readonly item: PipelineWorkItem }
  | { readonly outcome: "unchanged"; readonly item: PipelineWorkItem };

export interface PipelineWorkClaimOutcome {
  readonly outcome: "claimed" | "partial" | "empty" | "conditional_miss";
  readonly requested: number;
  readonly selected: number;
  readonly items: readonly PipelineWorkItem[];
}

export type PipelineWorkRenewOutcome =
  | { readonly outcome: "renewed"; readonly leaseExpiresAt: string }
  | { readonly outcome: "claim_missed" };

export type PipelineWorkCompleteOutcome =
  | { readonly outcome: "completed" }
  | { readonly outcome: "stale_released"; readonly item: PipelineWorkItem }
  | { readonly outcome: "claim_missed"; readonly item: PipelineWorkItem | null };

export type PipelineWorkFailureOutcome =
  | { readonly outcome: "retry_scheduled"; readonly item: PipelineWorkItem }
  | { readonly outcome: "stale_released"; readonly item: PipelineWorkItem }
  | { readonly outcome: "claim_missed"; readonly item: PipelineWorkItem | null };

export type PipelineWorkDeferOutcome =
  | { readonly outcome: "deferred"; readonly item: PipelineWorkItem }
  | { readonly outcome: "stale_released"; readonly item: PipelineWorkItem }
  | { readonly outcome: "claim_missed"; readonly item: PipelineWorkItem | null };

export interface PipelineWorkReclaimOutcome {
  readonly selected: number;
  readonly reclaimed: number;
  readonly items: readonly PipelineWorkItem[];
}

export interface PipelineWorkCoalesceStatementInput {
  readonly database: D1Database;
  readonly stage: PipelineWorkStage;
  readonly subject: PipelineWorkSubject;
  readonly laneKey: string;
  readonly inputHash: string;
  readonly priority?: number;
  readonly reasonCode: string;
  readonly subjectPayload?: Readonly<Record<string, unknown>> | readonly unknown[] | null;
  readonly availableAt?: Date;
  readonly now?: Date;
}

export interface PipelineWorkTelemetryOptions {
  /** Explicit benchmark/debug capture only. */
  readonly telemetry?: PerformanceTelemetrySink;
  readonly telemetryContext?: PerformanceTelemetryContext;
}

interface PipelineWorkRow {
  stage: string;
  subject_type: string;
  subject_id: string;
  listing_id: string | null;
  source_id: string | null;
  subject_payload_json: string | null;
  lane_key: string;
  input_hash: string;
  revision: number;
  priority: number;
  reason_code: string;
  available_at: string;
  input_attempt_count: number;
  lifetime_attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  claimed_input_hash: string | null;
  claimed_revision: number | null;
  progress_cursor: string | null;
  progress_generation: number | null;
  progress_rows: number;
  last_error_code: string | null;
  last_error_fingerprint: string | null;
  created_at: string;
  updated_at: string;
  last_claimed_at: string | null;
  last_completed_at: string | null;
}

const stageSet = new Set<string>(pipelineWorkStages);
const subjectTypeSet = new Set<string>(pipelineScopeTypes);
const rowColumns = `
  stage, subject_type, subject_id, listing_id, source_id,
  subject_payload_json, lane_key, input_hash, revision, priority, reason_code,
  available_at, input_attempt_count, lifetime_attempt_count,
  lease_owner, lease_expires_at, claimed_input_hash, claimed_revision,
  progress_cursor, progress_generation, progress_rows,
  last_error_code, last_error_fingerprint,
  created_at, updated_at, last_claimed_at, last_completed_at
`;

const MAX_BATCH_SIZE = 100;
const MAX_LEASE_MS = 24 * 60 * 60 * 1_000;
const MAX_PAYLOAD_BYTES = 16_384;

/**
 * Coalesces desired work without disturbing a live claim. Only a new input
 * hash creates a revision and resets state that belongs to the prior input.
 */
export async function coalescePipelineWorkItem(input: {
  readonly database: D1Database;
  readonly stage: PipelineWorkStage;
  readonly subject: PipelineWorkSubject;
  readonly laneKey: string;
  readonly inputHash: string;
  readonly priority?: number;
  readonly reasonCode: string;
  readonly subjectPayload?: Readonly<Record<string, unknown>> | readonly unknown[] | null;
  readonly availableAt?: Date;
  readonly now?: Date;
} & PipelineWorkTelemetryOptions): Promise<PipelineWorkCoalesceOutcome> {
  const telemetryStartedAt = performance.now();
  const statements = [
    preparePipelineWorkCoalesceStatement(input),
    selectIdentityStatement(
      input.database,
      validateStage(input.stage),
      validateSubject(input.subject).type,
      validateSubject(input.subject).id,
    ),
  ];
  const [writeResult, readResult] = await input.database.batch(statements);
  const item = oneBatchItem(readResult, "coalesced pipeline work item");
  const changed = changes(writeResult);
  const outcome: PipelineWorkCoalesceOutcome = changed === 0
    ? { outcome: "unchanged", item }
    : item.revision === 1
    ? { outcome: "inserted", item }
    : { outcome: "input_changed", item };
  await recordQueueTelemetry(input, {
    operation: "upsert",
    stage: input.stage,
    created: outcome.outcome === "inserted" ? 1 : 0,
    upserted: outcome.outcome === "unchanged" ? 0 : 1,
    statements: 2,
    batches: 1,
    startedAt: telemetryStartedAt,
  });
  return outcome;
}

/**
 * Prepares the same desired-input coalescing mutation used by the repository.
 * Canonical writers use this helper to place their mutation and its durable
 * invalidation in one D1 batch without duplicating queue lease semantics.
 */
export function preparePipelineWorkCoalesceStatement(
  input: PipelineWorkCoalesceStatementInput,
): D1PreparedStatement {
  const stage = validateStage(input.stage);
  const subject = validateSubject(input.subject);
  const laneKey = boundedText(input.laneKey, "pipeline work lane key", 256);
  const inputHash = boundedText(input.inputHash, "pipeline work input hash", 512);
  const reasonCode = boundedCode(input.reasonCode, "pipeline work reason code", 128);
  const priority = safeInteger(
    input.priority ?? 0,
    "pipeline work priority",
    -1_000_000,
    1_000_000,
  );
  const now = validDate(input.now ?? new Date(), "pipeline work update time");
  const availableAt = validDate(
    input.availableAt ?? now,
    "pipeline work availability time",
  );
  const payloadJson = serializePayload(input.subjectPayload ?? null);
  const nowIso = now.toISOString();
  return input.database.prepare(`
    INSERT INTO pipeline_work_items (
      stage, subject_type, subject_id, listing_id, source_id,
      subject_payload_json, lane_key, input_hash, revision, priority,
      reason_code, available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT (stage, subject_type, subject_id) DO UPDATE SET
      listing_id = excluded.listing_id,
      source_id = excluded.source_id,
      subject_payload_json = excluded.subject_payload_json,
      lane_key = excluded.lane_key,
      input_hash = excluded.input_hash,
      revision = pipeline_work_items.revision + 1,
      priority = excluded.priority,
      reason_code = excluded.reason_code,
      available_at = excluded.available_at,
      input_attempt_count = 0,
      progress_cursor = NULL,
      progress_generation = NULL,
      progress_rows = 0,
      last_error_code = NULL,
      last_error_fingerprint = NULL,
      updated_at = excluded.updated_at
    WHERE pipeline_work_items.input_hash <> excluded.input_hash
  `).bind(
    stage,
    subject.type,
    subject.id,
    subject.listingId,
    subject.sourceId,
    payloadJson,
    laneKey,
    inputHash,
    priority,
    reasonCode,
    availableAt.toISOString(),
    nowIso,
    nowIso,
  );
}

/**
 * Removes no-longer-desired work when no live worker owns it. An expired claim
 * has already lost mutation authority and must not pin obsolete desired work.
 */
export function preparePipelineWorkDeleteIfUnclaimedStatement(input: {
  readonly database: D1Database;
  readonly stage: PipelineWorkStage;
  readonly subjectType: PipelineWorkSubjectType;
  readonly subjectId: string;
  readonly now?: Date;
}): D1PreparedStatement {
  const stage = validateStage(input.stage);
  if (!subjectTypeSet.has(input.subjectType)) {
    throw new TypeError("pipeline work subject type is invalid");
  }
  const subjectId = boundedText(
    input.subjectId,
    "pipeline work subject id",
    512,
  );
  const now = validDate(input.now ?? new Date(), "pipeline work delete time");
  return input.database.prepare(`
    DELETE FROM pipeline_work_items
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND (lease_owner IS NULL OR lease_expires_at <= ?)
  `).bind(stage, input.subjectType, subjectId, now.toISOString());
}

/**
 * Selects indexed ready candidates, then conditionally claims and re-reads
 * each successful claim in one atomic D1 batch. A contender that wins after
 * selection is reported as a conditional miss, never as a claimed row.
 */
export async function claimPipelineWorkItems(input: {
  readonly database: D1Database;
  readonly stage: PipelineWorkStage;
  readonly owner: string;
  readonly limit: number;
  readonly leaseMs: number;
  readonly laneKey?: string;
  readonly sourceId?: string;
  readonly now?: Date;
} & PipelineWorkTelemetryOptions): Promise<PipelineWorkClaimOutcome> {
  const telemetryStartedAt = performance.now();
  const stage = validateStage(input.stage);
  const owner = boundedText(input.owner, "pipeline work lease owner", 256);
  const limit = safeInteger(input.limit, "pipeline work claim limit", 1, MAX_BATCH_SIZE);
  const leaseMs = safeInteger(input.leaseMs, "pipeline work lease duration", 1, MAX_LEASE_MS);
  const laneKey = input.laneKey === undefined
    ? undefined
    : boundedText(input.laneKey, "pipeline work lane key", 256);
  const sourceId = input.sourceId === undefined
    ? undefined
    : boundedText(input.sourceId, "pipeline work source id", 512);
  const now = validDate(input.now ?? new Date(), "pipeline work claim time");
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const filter = buildFilter({ stage, laneKey, sourceId });
  const selectedResult = await input.database.prepare(`
    SELECT stage, subject_type, subject_id, input_hash, revision
    FROM pipeline_work_items
    WHERE ${filter.sql}
      AND available_at <= ?
      AND (lease_owner IS NULL OR lease_expires_at <= ?)
    ORDER BY available_at, priority DESC, updated_at, subject_id
    LIMIT ?
  `).bind(...filter.bindings, nowIso, nowIso, limit).all<{
    stage: string;
    subject_type: string;
    subject_id: string;
    input_hash: string;
    revision: number;
  }>();
  const selected = selectedResult.results ?? [];
  if (selected.length === 0) {
    const outcome = {
      outcome: "empty" as const,
      requested: limit,
      selected: 0,
      items: Object.freeze([]),
    };
    await recordQueueTelemetry(input, {
      operation: "claim",
      stage,
      created: 0,
      selected: 0,
      claimed: 0,
      statements: 1,
      batches: 0,
      startedAt: telemetryStartedAt,
    });
    return outcome;
  }

  const statements: D1PreparedStatement[] = [];
  for (const candidate of selected) {
    statements.push(
      input.database.prepare(`
        UPDATE pipeline_work_items
        SET lease_owner = ?,
            lease_expires_at = ?,
            claimed_input_hash = input_hash,
            claimed_revision = revision,
            last_claimed_at = ?,
            updated_at = ?
        WHERE stage = ? AND subject_type = ? AND subject_id = ?
          AND input_hash = ? AND revision = ?
          AND available_at <= ?
          AND (lease_owner IS NULL OR lease_expires_at <= ?)
      `).bind(
        owner,
        leaseExpiresAt,
        nowIso,
        nowIso,
        candidate.stage,
        candidate.subject_type,
        candidate.subject_id,
        candidate.input_hash,
        candidate.revision,
        nowIso,
        nowIso,
      ),
      input.database.prepare(`
        SELECT ${rowColumns}
        FROM pipeline_work_items
        WHERE stage = ? AND subject_type = ? AND subject_id = ?
          AND lease_owner = ? AND lease_expires_at = ?
          AND claimed_input_hash = ? AND claimed_revision = ?
      `).bind(
        candidate.stage,
        candidate.subject_type,
        candidate.subject_id,
        owner,
        leaseExpiresAt,
        candidate.input_hash,
        candidate.revision,
      ),
    );
  }
  const results = await input.database.batch(statements);
  const claimed: PipelineWorkItem[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    if (changes(results[index * 2]) === 0) continue;
    claimed.push(oneBatchItem(results[index * 2 + 1], "claimed pipeline work item"));
  }
  const outcome: PipelineWorkClaimOutcome = {
    outcome: claimed.length === 0
      ? "conditional_miss"
      : claimed.length < selected.length
      ? "partial"
      : "claimed",
    requested: limit,
    selected: selected.length,
    items: Object.freeze(claimed),
  };
  await recordQueueTelemetry(input, {
    operation: "claim",
    stage,
    created: 0,
    selected: selected.length,
    claimed: claimed.length,
    statements: 1 + statements.length,
    batches: 1,
    startedAt: telemetryStartedAt,
  });
  return outcome;
}

/** Extends only the exact, still-live claim; an expired lease is never revived. */
export async function renewPipelineWorkClaim(input: {
  readonly database: D1Database;
  readonly claim: PipelineWorkClaimIdentity;
  readonly leaseMs: number;
  readonly now?: Date;
} & PipelineWorkTelemetryOptions): Promise<PipelineWorkRenewOutcome> {
  const telemetryStartedAt = performance.now();
  const claim = validateClaim(input.claim);
  const leaseMs = safeInteger(input.leaseMs, "pipeline work lease duration", 1, MAX_LEASE_MS);
  const now = validDate(input.now ?? new Date(), "pipeline work renewal time");
  const nowIso = now.toISOString();
  const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
  const result = await input.database.prepare(`
    UPDATE pipeline_work_items
    SET lease_expires_at = ?, updated_at = ?
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND lease_owner = ?
      AND claimed_input_hash = ? AND claimed_revision = ?
      AND lease_expires_at > ?
  `).bind(
    leaseExpiresAt,
    nowIso,
    claim.stage,
    claim.subjectType,
    claim.subjectId,
    claim.owner,
    claim.inputHash,
    claim.revision,
    nowIso,
  ).run();
  const outcome: PipelineWorkRenewOutcome = changes(result) === 1
    ? { outcome: "renewed", leaseExpiresAt }
    : { outcome: "claim_missed" };
  await recordQueueTelemetry(input, {
    operation: "renew",
    stage: claim.stage,
    created: 0,
    statements: 1,
    batches: 0,
    startedAt: telemetryStartedAt,
  });
  return outcome;
}

/**
 * Exact success removes only the desired revision that was actually claimed.
 * Completion of an older claim merely releases that claim and makes the newer
 * desired revision ready now.
 */
export async function completePipelineWorkClaim(input: {
  readonly database: D1Database;
  readonly claim: PipelineWorkClaimIdentity;
  readonly now?: Date;
} & PipelineWorkTelemetryOptions): Promise<PipelineWorkCompleteOutcome> {
  const telemetryStartedAt = performance.now();
  const claim = validateClaim(input.claim);
  const nowIso = validDate(input.now ?? new Date(), "pipeline work completion time").toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      DELETE FROM pipeline_work_items
      WHERE stage = ? AND subject_type = ? AND subject_id = ?
        AND lease_owner = ?
        AND claimed_input_hash = ? AND claimed_revision = ?
        AND input_hash = ? AND revision = ?
    `).bind(
      claim.stage, claim.subjectType, claim.subjectId, claim.owner,
      claim.inputHash, claim.revision, claim.inputHash, claim.revision,
    ),
    staleClaimReleaseStatement(input.database, claim, nowIso, true),
    selectIdentityStatement(
      input.database,
      claim.stage,
      claim.subjectType,
      claim.subjectId,
    ),
  ]);
  let outcome: PipelineWorkCompleteOutcome;
  if (changes(results[0]) === 1) {
    outcome = { outcome: "completed" };
  } else {
    const item = optionalBatchItem(results[2]);
    outcome = changes(results[1]) === 1 && item !== null
      ? { outcome: "stale_released", item }
      : { outcome: "claim_missed", item };
  }
  await recordQueueTelemetry(input, {
    operation: "complete",
    stage: claim.stage,
    created: 0,
    completed: outcome.outcome === "completed" ? 1 : 0,
    statements: 3,
    batches: 1,
    startedAt: telemetryStartedAt,
  });
  return outcome;
}

/** Schedules a sanitized retry only if the claimed revision is still desired. */
export async function failPipelineWorkClaim(input: {
  readonly database: D1Database;
  readonly claim: PipelineWorkClaimIdentity;
  readonly errorCode: string;
  readonly errorFingerprint: string;
  readonly retryAt: Date;
  readonly progress?: PipelineWorkProgress;
  readonly now?: Date;
} & PipelineWorkTelemetryOptions): Promise<PipelineWorkFailureOutcome> {
  const telemetryStartedAt = performance.now();
  const claim = validateClaim(input.claim);
  const errorCode = boundedCode(input.errorCode, "pipeline work error code", 128);
  const errorFingerprint = boundedCode(
    input.errorFingerprint,
    "pipeline work error fingerprint",
    512,
  );
  const now = validDate(input.now ?? new Date(), "pipeline work failure time");
  const retryAt = validDate(input.retryAt, "pipeline work retry time");
  if (retryAt.getTime() <= now.getTime()) {
    throw new RangeError("pipeline work retry time must be after the failure time");
  }
  const progress = input.progress === undefined ? null : validateProgress(input.progress);
  const progressSql = progress === null
    ? ""
    : ", progress_cursor = ?, progress_generation = ?, progress_rows = ?";
  const progressBindings = progress === null
    ? []
    : [progress.cursor, progress.generation, progress.rows];
  const nowIso = now.toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      UPDATE pipeline_work_items
      SET available_at = ?,
          input_attempt_count = input_attempt_count + 1,
          lifetime_attempt_count = lifetime_attempt_count + 1,
          lease_owner = NULL, lease_expires_at = NULL,
          claimed_input_hash = NULL, claimed_revision = NULL,
          last_error_code = ?, last_error_fingerprint = ?,
          updated_at = ?${progressSql}
      WHERE stage = ? AND subject_type = ? AND subject_id = ?
        AND lease_owner = ?
        AND claimed_input_hash = ? AND claimed_revision = ?
        AND input_hash = ? AND revision = ?
    `).bind(
      retryAt.toISOString(), errorCode, errorFingerprint, nowIso,
      ...progressBindings,
      claim.stage, claim.subjectType, claim.subjectId, claim.owner,
      claim.inputHash, claim.revision, claim.inputHash, claim.revision,
    ),
    staleClaimReleaseStatement(input.database, claim, nowIso, false),
    selectIdentityStatement(
      input.database,
      claim.stage,
      claim.subjectType,
      claim.subjectId,
    ),
  ]);
  const item = optionalBatchItem(results[2]);
  let outcome: PipelineWorkFailureOutcome;
  if (changes(results[0]) === 1) {
    if (item === null) throw new Error("failed pipeline work item was not returned");
    outcome = { outcome: "retry_scheduled", item };
  } else if (changes(results[1]) === 1) {
    if (item === null) throw new Error("released stale pipeline work item was not returned");
    outcome = { outcome: "stale_released", item };
  } else {
    outcome = { outcome: "claim_missed", item };
  }
  await recordQueueTelemetry(input, {
    operation: "fail",
    stage: claim.stage,
    created: 0,
    failed: outcome.outcome === "retry_scheduled" ? 1 : 0,
    statements: 3,
    batches: 1,
    startedAt: telemetryStartedAt,
  });
  return outcome;
}

/** Releases current claimed work for later continuation without an error. */
export async function deferPipelineWorkClaim(input: {
  readonly database: D1Database;
  readonly claim: PipelineWorkClaimIdentity;
  readonly availableAt: Date;
  readonly progress?: PipelineWorkProgress;
  readonly now?: Date;
} & PipelineWorkTelemetryOptions): Promise<PipelineWorkDeferOutcome> {
  const telemetryStartedAt = performance.now();
  const claim = validateClaim(input.claim);
  const now = validDate(input.now ?? new Date(), "pipeline work defer time");
  const availableAt = validDate(input.availableAt, "pipeline work deferred availability time");
  if (availableAt.getTime() < now.getTime()) {
    throw new RangeError("pipeline work deferred availability cannot be before the defer time");
  }
  const progress = input.progress === undefined ? null : validateProgress(input.progress);
  const progressSql = progress === null
    ? ""
    : ", progress_cursor = ?, progress_generation = ?, progress_rows = ?";
  const progressBindings = progress === null
    ? []
    : [progress.cursor, progress.generation, progress.rows];
  const nowIso = now.toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      UPDATE pipeline_work_items
      SET available_at = ?,
          lease_owner = NULL, lease_expires_at = NULL,
          claimed_input_hash = NULL, claimed_revision = NULL,
          last_error_code = NULL, last_error_fingerprint = NULL,
          updated_at = ?${progressSql}
      WHERE stage = ? AND subject_type = ? AND subject_id = ?
        AND lease_owner = ?
        AND claimed_input_hash = ? AND claimed_revision = ?
        AND input_hash = ? AND revision = ?
    `).bind(
      availableAt.toISOString(), nowIso,
      ...progressBindings,
      claim.stage, claim.subjectType, claim.subjectId, claim.owner,
      claim.inputHash, claim.revision, claim.inputHash, claim.revision,
    ),
    staleClaimReleaseStatement(input.database, claim, nowIso, false),
    selectIdentityStatement(
      input.database,
      claim.stage,
      claim.subjectType,
      claim.subjectId,
    ),
  ]);
  const item = optionalBatchItem(results[2]);
  let outcome: PipelineWorkDeferOutcome;
  if (changes(results[0]) === 1) {
    if (item === null) throw new Error("deferred pipeline work item was not returned");
    outcome = { outcome: "deferred", item };
  } else if (changes(results[1]) === 1) {
    if (item === null) throw new Error("released stale pipeline work item was not returned");
    outcome = { outcome: "stale_released", item };
  } else {
    outcome = { outcome: "claim_missed", item };
  }
  await recordQueueTelemetry(input, {
    operation: "defer",
    stage: claim.stage,
    created: 0,
    deferred: outcome.outcome === "deferred" ? 1 : 0,
    statements: 3,
    batches: 1,
    startedAt: telemetryStartedAt,
  });
  return outcome;
}

/** Clears a bounded exact set of expired claims without altering desired work. */
export async function reclaimExpiredPipelineWorkClaims(input: {
  readonly database: D1Database;
  readonly limit: number;
  readonly filter?: PipelineWorkQueueFilter;
  readonly now?: Date;
} & PipelineWorkTelemetryOptions): Promise<PipelineWorkReclaimOutcome> {
  const telemetryStartedAt = performance.now();
  const limit = safeInteger(
    input.limit,
    "pipeline work reclaim limit",
    1,
    MAX_BATCH_SIZE,
  );
  const nowIso = validDate(
    input.now ?? new Date(),
    "pipeline work reclaim time",
  ).toISOString();
  const filter = buildFilter(validateFilter(input.filter));
  const selectedResult = await input.database.prepare(`
    SELECT
      stage, subject_type, subject_id, lease_owner, lease_expires_at,
      claimed_input_hash, claimed_revision
    FROM pipeline_work_items
    WHERE ${filter.sql}
      AND lease_owner IS NOT NULL
      AND lease_expires_at <= ?
    ORDER BY lease_expires_at, stage, subject_id
    LIMIT ?
  `).bind(...filter.bindings, nowIso, limit).all<{
    stage: PipelineWorkStage;
    subject_type: PipelineWorkSubjectType;
    subject_id: string;
    lease_owner: string;
    lease_expires_at: string;
    claimed_input_hash: string;
    claimed_revision: number;
  }>();
  const selected = selectedResult.results ?? [];
  if (selected.length === 0) {
    const outcome = Object.freeze({
      selected: 0,
      reclaimed: 0,
      items: Object.freeze([]),
    });
    await recordQueueTelemetry(input, {
      operation: "reclaim",
      stage: input.filter?.stage ?? "all",
      created: 0,
      selected: 0,
      reclaimed: 0,
      statements: 1,
      batches: 0,
      startedAt: telemetryStartedAt,
    });
    return outcome;
  }
  const statements: D1PreparedStatement[] = [];
  for (const candidate of selected) {
    statements.push(
      input.database.prepare(`
        UPDATE pipeline_work_items
        SET lease_owner = NULL, lease_expires_at = NULL,
            claimed_input_hash = NULL, claimed_revision = NULL,
            updated_at = ?
        WHERE stage = ? AND subject_type = ? AND subject_id = ?
          AND lease_owner = ? AND lease_expires_at = ?
          AND claimed_input_hash = ? AND claimed_revision = ?
          AND lease_expires_at <= ?
      `).bind(
        nowIso,
        candidate.stage,
        candidate.subject_type,
        candidate.subject_id,
        candidate.lease_owner,
        candidate.lease_expires_at,
        candidate.claimed_input_hash,
        candidate.claimed_revision,
        nowIso,
      ),
      selectIdentityStatement(
        input.database,
        candidate.stage,
        candidate.subject_type,
        candidate.subject_id,
      ),
    );
  }
  const results = await input.database.batch(statements);
  const items: PipelineWorkItem[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    if (changes(results[index * 2]) !== 1) continue;
    items.push(oneBatchItem(results[index * 2 + 1], "reclaimed pipeline work item"));
  }
  const outcome = Object.freeze({
    selected: selected.length,
    reclaimed: items.length,
    items: Object.freeze(items),
  });
  await recordQueueTelemetry(input, {
    operation: "reclaim",
    stage: input.filter?.stage ?? "all",
    created: 0,
    selected: selected.length,
    reclaimed: items.length,
    statements: 1 + statements.length,
    batches: 1,
    startedAt: telemetryStartedAt,
  });
  return outcome;
}

export async function readPipelineWorkQueueCounts(input: {
  readonly database: D1Database;
  readonly filter?: PipelineWorkQueueFilter;
  readonly now?: Date;
} & PipelineWorkTelemetryOptions): Promise<PipelineWorkQueueCounts> {
  const telemetryStartedAt = performance.now();
  const nowIso = validDate(input.now ?? new Date(), "pipeline work count time").toISOString();
  const filter = buildFilter(validateFilter(input.filter));
  const row = await input.database.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN available_at <= ?
        AND (lease_owner IS NULL OR lease_expires_at <= ?) THEN 1 ELSE 0 END), 0) AS ready,
      COALESCE(SUM(CASE WHEN lease_owner IS NOT NULL
        AND lease_expires_at > ? THEN 1 ELSE 0 END), 0) AS live_claims
    FROM pipeline_work_items
    WHERE ${filter.sql}
  `).bind(nowIso, nowIso, nowIso, ...filter.bindings).first<{
    total: number;
    ready: number;
    live_claims: number;
  }>();
  const total = numberField(row?.total ?? 0, "pipeline work total count");
  const ready = numberField(row?.ready ?? 0, "pipeline work ready count");
  const liveClaims = numberField(row?.live_claims ?? 0, "pipeline work live claim count");
  const counts = Object.freeze({
    total,
    ready,
    liveClaims,
    unavailable: total - ready,
  });
  input.telemetry?.record({
    context: input.telemetryContext,
    details: {
      kind: "queue",
      operation: "snapshot",
      stage: input.filter?.stage ?? "all",
      created: 0,
      upserted: 0,
      selected: total,
      claimed: 0,
      completed: 0,
      deferred: 0,
      failed: 0,
      reclaimed: 0,
      remaining: total,
      statements: 1,
      batches: 0,
      durationMs: performance.now() - telemetryStartedAt,
    },
  });
  return counts;
}

/** Reads the exact earliest effective availability, including live lease expiry. */
export async function readNextPipelineWorkAvailableAt(input: {
  readonly database: D1Database;
  readonly filter?: PipelineWorkQueueFilter;
} & PipelineWorkTelemetryOptions): Promise<string | null> {
  const telemetryStartedAt = performance.now();
  const filter = buildFilter(validateFilter(input.filter));
  const row = await input.database.prepare(`
    SELECT MIN(
      CASE
        WHEN lease_owner IS NOT NULL AND lease_expires_at > available_at
          THEN lease_expires_at
        ELSE available_at
      END
    ) AS next_available_at
    FROM pipeline_work_items
    WHERE ${filter.sql}
  `).bind(...filter.bindings).first<{ next_available_at: string | null }>();
  const nextAvailableAt = row?.next_available_at ?? null;
  await recordQueueTelemetry(input, {
    operation: "select",
    stage: input.filter?.stage ?? "all",
    created: 0,
    statements: 1,
    batches: 0,
    startedAt: telemetryStartedAt,
  });
  return nextAvailableAt;
}

export function pipelineWorkClaimIdentity(item: PipelineWorkItem): PipelineWorkClaimIdentity {
  if (
    item.leaseOwner === null ||
    item.claimedInputHash === null ||
    item.claimedRevision === null
  ) {
    throw new Error("pipeline work item is not claimed");
  }
  return Object.freeze({
    stage: item.stage,
    subjectType: item.subjectType,
    subjectId: item.subjectId,
    owner: item.leaseOwner,
    inputHash: item.claimedInputHash,
    revision: item.claimedRevision,
  });
}

async function recordQueueTelemetry(
  input: {
    readonly database: D1Database;
  } & PipelineWorkTelemetryOptions,
  metrics: {
    readonly operation:
      | "upsert"
      | "select"
      | "claim"
      | "renew"
      | "complete"
      | "defer"
      | "fail"
      | "reclaim";
    readonly stage: string;
    readonly created: number;
    readonly upserted?: number;
    readonly selected?: number;
    readonly claimed?: number;
    readonly completed?: number;
    readonly deferred?: number;
    readonly failed?: number;
    readonly reclaimed?: number;
    readonly statements: number;
    readonly batches: number;
    readonly startedAt: number;
  },
): Promise<void> {
  if (input.telemetry === undefined) return;
  const row = metrics.stage === "all"
    ? await input.database.prepare(`
        SELECT COUNT(*) AS count FROM pipeline_work_items
      `).first<{ count: number }>()
    : await input.database.prepare(`
        SELECT COUNT(*) AS count FROM pipeline_work_items WHERE stage = ?
      `).bind(metrics.stage).first<{ count: number }>();
  const remaining = numberField(
    row?.count ?? 0,
    "pipeline work telemetry remaining count",
  );
  input.telemetry.record({
    context: input.telemetryContext,
    details: {
      kind: "queue",
      operation: metrics.operation,
      stage: metrics.stage,
      created: metrics.created,
      upserted: metrics.upserted ?? 0,
      selected: metrics.selected ?? 0,
      claimed: metrics.claimed ?? 0,
      completed: metrics.completed ?? 0,
      deferred: metrics.deferred ?? 0,
      failed: metrics.failed ?? 0,
      reclaimed: metrics.reclaimed ?? 0,
      remaining,
      statements: metrics.statements + 1,
      batches: metrics.batches,
      durationMs: performance.now() - metrics.startedAt,
    },
  });
}

function staleClaimReleaseStatement(
  database: D1Database,
  claim: PipelineWorkClaimIdentity,
  nowIso: string,
  markCompleted: boolean,
): D1PreparedStatement {
  return database.prepare(`
    UPDATE pipeline_work_items
    SET lease_owner = NULL, lease_expires_at = NULL,
        claimed_input_hash = NULL, claimed_revision = NULL,
        available_at = ?, updated_at = ?
        ${markCompleted ? ", last_completed_at = ?" : ""}
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
      AND lease_owner = ?
      AND claimed_input_hash = ? AND claimed_revision = ?
      AND (input_hash <> ? OR revision <> ?)
  `).bind(
    nowIso,
    nowIso,
    ...(markCompleted ? [nowIso] : []),
    claim.stage,
    claim.subjectType,
    claim.subjectId,
    claim.owner,
    claim.inputHash,
    claim.revision,
    claim.inputHash,
    claim.revision,
  );
}

function selectIdentityStatement(
  database: D1Database,
  stage: PipelineWorkStage,
  subjectType: PipelineWorkSubjectType,
  subjectId: string,
): D1PreparedStatement {
  return database.prepare(`
    SELECT ${rowColumns}
    FROM pipeline_work_items
    WHERE stage = ? AND subject_type = ? AND subject_id = ?
  `).bind(stage, subjectType, subjectId);
}

function buildFilter(filter: PipelineWorkQueueFilter): {
  readonly sql: string;
  readonly bindings: readonly string[];
} {
  const predicates: string[] = [];
  const bindings: string[] = [];
  if (filter.stage !== undefined) {
    predicates.push("stage = ?");
    bindings.push(filter.stage);
  }
  if (filter.laneKey !== undefined) {
    predicates.push("lane_key = ?");
    bindings.push(filter.laneKey);
  }
  if (filter.sourceId !== undefined) {
    predicates.push("source_id = ?");
    bindings.push(filter.sourceId);
  }
  if (filter.subjectType !== undefined) {
    predicates.push("subject_type = ?");
    bindings.push(filter.subjectType);
  }
  return {
    sql: predicates.length === 0 ? "1 = 1" : predicates.join(" AND "),
    bindings,
  };
}

function validateFilter(filter?: PipelineWorkQueueFilter): PipelineWorkQueueFilter {
  if (filter === undefined) return {};
  return {
    stage: filter.stage === undefined ? undefined : validateStage(filter.stage),
    laneKey: filter.laneKey === undefined
      ? undefined
      : boundedText(filter.laneKey, "pipeline work lane key", 256),
    sourceId: filter.sourceId === undefined
      ? undefined
      : boundedText(filter.sourceId, "pipeline work source id", 512),
    subjectType: filter.subjectType === undefined
      ? undefined
      : validateSubjectType(filter.subjectType),
  };
}

function validateSubject(subject: PipelineWorkSubject): {
  readonly type: PipelineWorkSubjectType;
  readonly id: string;
  readonly listingId: string | null;
  readonly sourceId: string | null;
} {
  const type = validateSubjectType(subject.type);
  const id = boundedText(subject.id, "pipeline work subject id", 512);
  if (subject.type === "listing") {
    return {
      type: subject.type,
      id,
      listingId: id,
      sourceId: subject.sourceId == null
        ? null
        : boundedText(subject.sourceId, "pipeline work source id", 512),
    };
  }
  if (subject.type === "source") {
    return { type: subject.type, id, listingId: null, sourceId: id };
  }
  if (subject.type === "group") {
    return {
      type: subject.type,
      id,
      listingId: null,
      sourceId: subject.sourceId == null
        ? null
        : boundedText(subject.sourceId, "pipeline work source id", 512),
    };
  }
  return { type, id, listingId: null, sourceId: null };
}

function validateClaim(claim: PipelineWorkClaimIdentity): PipelineWorkClaimIdentity {
  return Object.freeze({
    stage: validateStage(claim.stage),
    subjectType: validateSubjectType(claim.subjectType),
    subjectId: boundedText(claim.subjectId, "pipeline work subject id", 512),
    owner: boundedText(claim.owner, "pipeline work lease owner", 256),
    inputHash: boundedText(claim.inputHash, "pipeline work claimed input hash", 512),
    revision: safeInteger(claim.revision, "pipeline work claimed revision", 1),
  });
}

function validateProgress(progress: PipelineWorkProgress): PipelineWorkProgress {
  return Object.freeze({
    cursor: progress.cursor === null
      ? null
      : boundedText(progress.cursor, "pipeline work progress cursor", 4_096),
    generation: progress.generation === null
      ? null
      : safeInteger(progress.generation, "pipeline work progress generation", 1),
    rows: safeInteger(progress.rows, "pipeline work progress rows", 0),
  });
}

function validateStage(value: PipelineWorkStage): PipelineWorkStage {
  if (!stageSet.has(value)) throw new RangeError("unsupported pipeline work stage");
  return value;
}

function validateSubjectType(value: PipelineWorkSubjectType): PipelineWorkSubjectType {
  if (!subjectTypeSet.has(value)) throw new RangeError("unsupported pipeline work subject type");
  return value;
}

function serializePayload(
  payload: Readonly<Record<string, unknown>> | readonly unknown[] | null,
): string | null {
  if (payload === null) return null;
  if (typeof payload !== "object") {
    throw new RangeError("pipeline work subject payload must be an object or array");
  }
  let serialized: string | undefined;
  try {
    serialized = serializeCanonicalJson(payload);
  } catch {
    throw new RangeError(
      "pipeline work subject payload must be strict canonical JSON",
    );
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError("pipeline work subject payload exceeds 16384 UTF-8 bytes");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (parsed === null || typeof parsed !== "object") {
    throw new RangeError("pipeline work subject payload must serialize to an object or array");
  }
  return serialized;
}

function boundedText(value: string, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RangeError(`${label} must contain 1-${maxLength} non-control characters`);
  }
  return value;
}

function boundedCode(value: string, label: string, maxLength: number): string {
  const checked = boundedText(value, label, maxLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(checked)) {
    throw new RangeError(`${label} contains unsupported characters`);
  }
  return checked;
}

function safeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function changes(result: D1Result | undefined): number {
  return Math.max(0, Number(result?.meta.changes ?? 0));
}

function numberField(value: number, label: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`${label} is invalid`);
  }
  return numeric;
}

function optionalBatchItem(result: D1Result | undefined): PipelineWorkItem | null {
  const rows = (result?.results ?? []) as unknown as PipelineWorkRow[];
  if (rows.length > 1) throw new Error("pipeline work identity returned multiple rows");
  return rows.length === 0 ? null : mapRow(rows[0]);
}

function oneBatchItem(result: D1Result | undefined, label: string): PipelineWorkItem {
  const item = optionalBatchItem(result);
  if (item === null) throw new Error(`${label} was not returned`);
  return item;
}

function mapRow(row: PipelineWorkRow): PipelineWorkItem {
  const stage = validateStage(row.stage as PipelineWorkStage);
  const subjectType = validateSubjectType(row.subject_type as PipelineWorkSubjectType);
  const payload = row.subject_payload_json === null
    ? null
    : JSON.parse(row.subject_payload_json) as Readonly<Record<string, unknown>> | readonly unknown[];
  return Object.freeze({
    stage,
    subjectType,
    subjectId: row.subject_id,
    listingId: row.listing_id,
    sourceId: row.source_id,
    subjectPayload: payload,
    laneKey: row.lane_key,
    inputHash: row.input_hash,
    revision: Number(row.revision),
    priority: Number(row.priority),
    reasonCode: row.reason_code,
    availableAt: row.available_at,
    inputAttemptCount: Number(row.input_attempt_count),
    lifetimeAttemptCount: Number(row.lifetime_attempt_count),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    claimedInputHash: row.claimed_input_hash,
    claimedRevision: row.claimed_revision === null ? null : Number(row.claimed_revision),
    progress: Object.freeze({
      cursor: row.progress_cursor,
      generation: row.progress_generation === null ? null : Number(row.progress_generation),
      rows: Number(row.progress_rows),
    }),
    lastErrorCode: row.last_error_code,
    lastErrorFingerprint: row.last_error_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastClaimedAt: row.last_claimed_at,
    lastCompletedAt: row.last_completed_at,
  });
}
