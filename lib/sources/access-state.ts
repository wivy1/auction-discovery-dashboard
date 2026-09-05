export const SOURCE_ACCESS_STATES = [
  "ready",
  "cooldown",
  "manual_reset_required",
] as const;

export type SourceAccessState = (typeof SOURCE_ACCESS_STATES)[number];
export type SourceAccessStopState = Exclude<SourceAccessState, "ready">;

export interface SourceAccessStateRow {
  readonly sourceId: string;
  readonly laneKey: string;
  readonly state: SourceAccessState;
  readonly reasonCode: string | null;
  readonly failureFingerprint: string | null;
  readonly nextEligibleAt: string | null;
  readonly lastObservedAt: string | null;
  readonly currentInputHash: string;
  readonly currentInputRevision: number;
  readonly currentInputAttemptCount: number;
  readonly manualResetAt: string | null;
  readonly manualResetReason: string | null;
  readonly manualResetActor: string | null;
  readonly updatedAt: string;
}

export interface SourceAccessEligibility {
  readonly eligible: boolean;
  readonly row: SourceAccessStateRow;
}

export interface SourceAccessInspection {
  readonly asOf: string;
  readonly sourceId: string | null;
  readonly laneKey: string | null;
  readonly counts: {
    readonly total: number;
    readonly ready: number;
    readonly cooldown: number;
    readonly manualResetRequired: number;
    readonly eligible: number;
    readonly blocked: number;
    readonly returned: number;
    readonly truncated: number;
  };
  readonly rows: readonly (SourceAccessStateRow & {
    readonly effectiveEligible: boolean;
  })[];
}

interface SourceAccessRow {
  source_id: string;
  lane_key: string;
  state: string;
  reason_code: string | null;
  failure_fingerprint: string | null;
  next_eligible_at: string | null;
  last_observed_at: string | null;
  current_input_hash: string;
  current_input_revision: number;
  current_input_attempt_count: number;
  manual_reset_at: string | null;
  manual_reset_reason: string | null;
  manual_reset_actor: string | null;
  updated_at: string;
}

const ROW_COLUMNS = `
  source_id, lane_key, state, reason_code, failure_fingerprint,
  next_eligible_at, last_observed_at, current_input_hash,
  current_input_revision, current_input_attempt_count,
  manual_reset_at, manual_reset_reason, manual_reset_actor, updated_at
`;
const MAX_INSPECTION_ROWS = 500;

/**
 * Establishes the current canonical input and returns whether a request may be
 * issued. A changed input releases an ordinary cooldown, but never releases a
 * manual stop. An elapsed cooldown becomes ready in the same atomic batch.
 */
export async function checkSourceAccessEligibility(input: {
  readonly database: D1Database;
  readonly sourceId: string;
  readonly laneKey: string;
  readonly currentInputHash: string;
  readonly now?: Date;
}): Promise<SourceAccessEligibility> {
  const sourceId = boundedCode(input.sourceId, "source access source ID", 128);
  const laneKey = boundedCode(input.laneKey, "source access lane key", 128);
  const currentInputHash = boundedCode(
    input.currentInputHash,
    "source access current-input fingerprint",
    512,
  );
  const nowIso = validDate(input.now ?? new Date(), "source access check time")
    .toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      INSERT INTO source_access_state (
        source_id, lane_key, state, current_input_hash,
        current_input_revision, current_input_attempt_count, updated_at
      ) VALUES (?, ?, 'ready', ?, 1, 0, ?)
      ON CONFLICT (source_id, lane_key) DO UPDATE SET
        state = CASE
          WHEN source_access_state.state = 'manual_reset_required'
            THEN 'manual_reset_required'
          ELSE 'ready'
        END,
        reason_code = CASE
          WHEN source_access_state.state = 'manual_reset_required'
            THEN source_access_state.reason_code
          ELSE NULL
        END,
        failure_fingerprint = CASE
          WHEN source_access_state.state = 'manual_reset_required'
            THEN source_access_state.failure_fingerprint
          ELSE NULL
        END,
        next_eligible_at = NULL,
        current_input_hash = excluded.current_input_hash,
        current_input_revision = source_access_state.current_input_revision
          + CASE WHEN source_access_state.current_input_hash <> excluded.current_input_hash
            THEN 1 ELSE 0 END,
        current_input_attempt_count = CASE
          WHEN source_access_state.current_input_hash <> excluded.current_input_hash
            THEN 0
          ELSE source_access_state.current_input_attempt_count
        END,
        updated_at = excluded.updated_at
      WHERE source_access_state.current_input_hash <> excluded.current_input_hash
        OR (source_access_state.state = 'cooldown'
          AND source_access_state.next_eligible_at <= excluded.updated_at)
    `).bind(sourceId, laneKey, currentInputHash, nowIso),
    selectExactState(input.database, sourceId, laneKey),
  ]);
  const row = oneRow(results[1], "source access eligibility");
  return Object.freeze({ eligible: row.state === "ready", row });
}

/** Records a sanitized access stop after an actually issued source request. */
export async function recordSourceAccessStop(input: {
  readonly database: D1Database;
  readonly sourceId: string;
  readonly laneKey: string;
  readonly currentInputHash: string;
  readonly state: SourceAccessStopState;
  readonly reasonCode: string;
  readonly failureFingerprint: string;
  readonly nextEligibleAt?: Date | null;
  readonly now?: Date;
}): Promise<SourceAccessStateRow> {
  const state = validateStopState(input.state);
  const reasonCode = boundedCode(input.reasonCode, "source access reason", 128);
  const failureFingerprint = boundedCode(
    input.failureFingerprint,
    "source access failure fingerprint",
    512,
  );
  const now = validDate(input.now ?? new Date(), "source access observation time");
  const nextEligibleAt = input.nextEligibleAt == null
    ? null
    : validDate(input.nextEligibleAt, "source access next eligibility time");
  if (state === "cooldown") {
    if (nextEligibleAt === null || nextEligibleAt.getTime() <= now.getTime()) {
      throw new RangeError("a source access cooldown requires a future next eligibility time");
    }
  } else if (nextEligibleAt !== null) {
    throw new RangeError("manual-reset-required source access cannot auto expire");
  }

  const eligibility = await checkSourceAccessEligibility({
    database: input.database,
    sourceId: input.sourceId,
    laneKey: input.laneKey,
    currentInputHash: input.currentInputHash,
    now,
  });
  const prior = eligibility.row;
  if (
    (prior.state === "manual_reset_required" && state === "cooldown") ||
    (
      prior.state === state &&
      prior.reasonCode === reasonCode &&
      prior.failureFingerprint === failureFingerprint
    )
  ) {
    return prior;
  }

  const nowIso = now.toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      UPDATE source_access_state
      SET state = ?, reason_code = ?, failure_fingerprint = ?,
          next_eligible_at = ?, last_observed_at = ?,
          current_input_attempt_count = current_input_attempt_count + 1,
          updated_at = ?
      WHERE source_id = ? AND lane_key = ?
        AND current_input_hash = ? AND current_input_revision = ?
        AND (? = 'manual_reset_required'
          OR state <> 'manual_reset_required')
    `).bind(
      state,
      reasonCode,
      failureFingerprint,
      nextEligibleAt?.toISOString() ?? null,
      nowIso,
      nowIso,
      prior.sourceId,
      prior.laneKey,
      prior.currentInputHash,
      prior.currentInputRevision,
      state,
    ),
    selectExactState(input.database, prior.sourceId, prior.laneKey),
  ]);
  return oneRow(results[1], "recorded source access stop");
}

/** Clears only a previously attempted, now-ready exact input after success. */
export async function recordSourceAccessSuccess(input: {
  readonly database: D1Database;
  readonly sourceId: string;
  readonly laneKey: string;
  readonly currentInputHash: string;
  readonly now?: Date;
}): Promise<SourceAccessStateRow> {
  const sourceId = boundedCode(input.sourceId, "source access source ID", 128);
  const laneKey = boundedCode(input.laneKey, "source access lane key", 128);
  const currentInputHash = boundedCode(
    input.currentInputHash,
    "source access current-input fingerprint",
    512,
  );
  const nowIso = validDate(input.now ?? new Date(), "source access success time")
    .toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      UPDATE source_access_state
      SET current_input_attempt_count = 0, last_observed_at = ?, updated_at = ?
      WHERE source_id = ? AND lane_key = ? AND current_input_hash = ?
        AND state = 'ready' AND current_input_attempt_count <> 0
    `).bind(nowIso, nowIso, sourceId, laneKey, currentInputHash),
    selectExactState(input.database, sourceId, laneKey),
  ]);
  return oneRow(results[1], "recorded source access success");
}

/** Reads bounded exact rows plus exact unbounded counts for the same filters. */
export async function inspectSourceAccessStates(input: {
  readonly database: D1Database;
  readonly sourceId?: string;
  readonly laneKey?: string;
  readonly limit?: number;
  readonly now?: Date;
}): Promise<SourceAccessInspection> {
  const sourceId = input.sourceId === undefined
    ? null
    : boundedCode(input.sourceId, "source access source ID", 128);
  const laneKey = input.laneKey === undefined
    ? null
    : boundedCode(input.laneKey, "source access lane key", 128);
  const limit = safeInteger(
    input.limit ?? 100,
    "source access inspection limit",
    1,
    MAX_INSPECTION_ROWS,
  );
  const nowIso = validDate(input.now ?? new Date(), "source access inspection time")
    .toISOString();
  const filter = buildFilter(sourceId, laneKey);
  const [countResult, rowResult] = await input.database.batch([
    input.database.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN state = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
        COALESCE(SUM(CASE WHEN state = 'cooldown' THEN 1 ELSE 0 END), 0) AS cooldown,
        COALESCE(SUM(CASE WHEN state = 'manual_reset_required' THEN 1 ELSE 0 END), 0)
          AS manual_reset_required,
        COALESCE(SUM(CASE
          WHEN state = 'ready' OR (state = 'cooldown' AND next_eligible_at <= ?)
            THEN 1 ELSE 0 END), 0) AS eligible
      FROM source_access_state
      WHERE ${filter.sql}
    `).bind(nowIso, ...filter.bindings),
    input.database.prepare(`
      SELECT ${ROW_COLUMNS}
      FROM source_access_state
      WHERE ${filter.sql}
      ORDER BY source_id, lane_key
      LIMIT ?
    `).bind(...filter.bindings, limit),
  ]);
  const countRows = (countResult?.results ?? []) as unknown as Array<{
    total: number;
    ready: number;
    cooldown: number;
    manual_reset_required: number;
    eligible: number;
  }>;
  if (countRows.length !== 1) throw new Error("source access counts were not returned");
  const counts = countRows[0]!;
  const total = nonnegativeInteger(counts.total, "source access total count");
  const eligible = nonnegativeInteger(counts.eligible, "source access eligible count");
  const rows = ((rowResult?.results ?? []) as unknown as SourceAccessRow[])
    .map((raw) => {
      const row = mapRow(raw);
      return Object.freeze({
        ...row,
        effectiveEligible: row.state === "ready" ||
          (row.state === "cooldown" && row.nextEligibleAt !== null &&
            row.nextEligibleAt <= nowIso),
      });
    });
  return Object.freeze({
    asOf: nowIso,
    sourceId,
    laneKey,
    counts: Object.freeze({
      total,
      ready: nonnegativeInteger(counts.ready, "source access ready count"),
      cooldown: nonnegativeInteger(counts.cooldown, "source access cooldown count"),
      manualResetRequired: nonnegativeInteger(
        counts.manual_reset_required,
        "source access manual-reset count",
      ),
      eligible,
      blocked: total - eligible,
      returned: rows.length,
      truncated: total - rows.length,
    }),
    rows: Object.freeze(rows),
  });
}

/** Explicitly releases one exact state and records bounded operator metadata. */
export async function resetSourceAccessState(input: {
  readonly database: D1Database;
  readonly sourceId: string;
  readonly laneKey: string;
  readonly operatorReason: string;
  readonly operatorActor?: string;
  readonly now?: Date;
}): Promise<SourceAccessStateRow | null> {
  const sourceId = boundedCode(input.sourceId, "source access source ID", 128);
  const laneKey = boundedCode(input.laneKey, "source access lane key", 128);
  const operatorReason = boundedText(
    input.operatorReason,
    "source access reset reason",
    512,
    true,
  );
  const operatorActor = boundedText(
    input.operatorActor ?? "local-operator",
    "source access reset actor",
    128,
    true,
  );
  const nowIso = validDate(input.now ?? new Date(), "source access reset time")
    .toISOString();
  const results = await input.database.batch([
    input.database.prepare(`
      UPDATE source_access_state
      SET state = 'ready', reason_code = NULL, failure_fingerprint = NULL,
          next_eligible_at = NULL, current_input_attempt_count = 0,
          manual_reset_at = ?, manual_reset_reason = ?, manual_reset_actor = ?,
          updated_at = ?
      WHERE source_id = ? AND lane_key = ?
    `).bind(nowIso, operatorReason, operatorActor, nowIso, sourceId, laneKey),
    selectExactState(input.database, sourceId, laneKey),
  ]);
  return optionalRow(results[1]);
}

function selectExactState(
  database: D1Database,
  sourceId: string,
  laneKey: string,
): D1PreparedStatement {
  return database.prepare(`
    SELECT ${ROW_COLUMNS}
    FROM source_access_state
    WHERE source_id = ? AND lane_key = ?
  `).bind(sourceId, laneKey);
}

function buildFilter(sourceId: string | null, laneKey: string | null): {
  readonly sql: string;
  readonly bindings: readonly string[];
} {
  const predicates: string[] = [];
  const bindings: string[] = [];
  if (sourceId !== null) {
    predicates.push("source_id = ?");
    bindings.push(sourceId);
  }
  if (laneKey !== null) {
    predicates.push("lane_key = ?");
    bindings.push(laneKey);
  }
  return {
    sql: predicates.length === 0 ? "1 = 1" : predicates.join(" AND "),
    bindings,
  };
}

function validateStopState(value: SourceAccessStopState): SourceAccessStopState {
  if (value !== "cooldown" && value !== "manual_reset_required") {
    throw new RangeError("source access stop state is invalid");
  }
  return value;
}

function boundedCode(value: string, label: string, maxLength: number): string {
  const checked = boundedText(value, label, maxLength, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(checked)) {
    throw new RangeError(`${label} contains unsupported characters`);
  }
  return checked;
}

function boundedText(
  value: string,
  label: string,
  maxLength: number,
  trim: boolean,
): string {
  const checked = trim && typeof value === "string" ? value.trim() : value;
  if (
    typeof checked !== "string" || checked.length < 1 ||
    checked.length > maxLength || /[\u0000-\u001f\u007f]/u.test(checked)
  ) {
    throw new RangeError(`${label} must contain 1-${maxLength} non-control characters`);
  }
  return checked;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${label} is invalid`);
  }
  return value;
}

function safeInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function nonnegativeInteger(value: number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function optionalRow(result: D1Result | undefined): SourceAccessStateRow | null {
  const rows = (result?.results ?? []) as unknown as SourceAccessRow[];
  if (rows.length > 1) throw new Error("source access identity returned multiple rows");
  return rows.length === 0 ? null : mapRow(rows[0]!);
}

function oneRow(result: D1Result | undefined, label: string): SourceAccessStateRow {
  const row = optionalRow(result);
  if (row === null) throw new Error(`${label} row was not returned`);
  return row;
}

function mapRow(row: SourceAccessRow): SourceAccessStateRow {
  if (!(SOURCE_ACCESS_STATES as readonly string[]).includes(row.state)) {
    throw new Error("stored source access state is invalid");
  }
  return Object.freeze({
    sourceId: row.source_id,
    laneKey: row.lane_key,
    state: row.state as SourceAccessState,
    reasonCode: row.reason_code,
    failureFingerprint: row.failure_fingerprint,
    nextEligibleAt: row.next_eligible_at,
    lastObservedAt: row.last_observed_at,
    currentInputHash: row.current_input_hash,
    currentInputRevision: Number(row.current_input_revision),
    currentInputAttemptCount: Number(row.current_input_attempt_count),
    manualResetAt: row.manual_reset_at,
    manualResetReason: row.manual_reset_reason,
    manualResetActor: row.manual_reset_actor,
    updatedAt: row.updated_at,
  });
}
