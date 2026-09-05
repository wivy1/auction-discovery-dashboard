import { serializeCanonicalJson } from "../performance/generations";

export const PROJECTION_REBUILD_SCHEMA_VERSION = 42 as const;

export type ProjectionRebuildState =
  | "pending"
  | "running"
  | "completed"
  | "superseded"
  | "failed";

export interface ProjectionRebuildRecord {
  readonly rebuildId: string;
  readonly domain: string;
  readonly scopeType: "listing" | "source" | "group" | "global";
  readonly scopeId: string;
  readonly state: ProjectionRebuildState;
  readonly schemaVersion: number;
  readonly derivationVersion: string;
  readonly targetGenerationVectorJson: string;
  readonly targetGenerationVectorHash: string;
  readonly endingGenerationVectorJson: string | null;
  readonly endingGenerationVectorHash: string | null;
  readonly cursorListingId: string | null;
  readonly rowsProcessed: number;
  readonly batchesProcessed: number;
  readonly copiedDatabaseIdentity: string | null;
  readonly errorCode: string | null;
  readonly errorFingerprint: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

interface ProjectionRebuildRow {
  rebuild_id: unknown;
  domain: unknown;
  scope_type: unknown;
  scope_id: unknown;
  state: unknown;
  schema_version: unknown;
  derivation_version: unknown;
  target_generation_vector_json: unknown;
  target_generation_vector_hash: unknown;
  ending_generation_vector_json: unknown;
  ending_generation_vector_hash: unknown;
  cursor_listing_id: unknown;
  rows_processed: unknown;
  batches_processed: unknown;
  copied_database_identity: unknown;
  error_code: unknown;
  error_fingerprint: unknown;
  started_at: unknown;
  updated_at: unknown;
  completed_at: unknown;
}

const SELECT_REBUILD = `
  SELECT
    rebuild_id, domain, scope_type, scope_id, state, schema_version,
    derivation_version, target_generation_vector_json,
    target_generation_vector_hash, ending_generation_vector_json,
    ending_generation_vector_hash, cursor_listing_id, rows_processed,
    batches_processed, copied_database_identity, error_code,
    error_fingerprint, started_at, updated_at, completed_at
  FROM pipeline_rebuild_state
`;

export async function beginProjectionRebuild(
  database: D1Database,
  input: {
    readonly rebuildId: string;
    readonly domain: string;
    readonly scopeType: ProjectionRebuildRecord["scopeType"];
    readonly scopeId: string;
    readonly derivationVersion: string;
    readonly targetGenerationVectorJson: string;
    readonly targetGenerationVectorHash: string;
    readonly copiedDatabaseIdentity?: string | null;
    readonly schemaVersion?: number;
  },
): Promise<ProjectionRebuildRecord> {
  const validated = validatedBeginInput(input);
  await database.prepare(`
    INSERT INTO pipeline_rebuild_state (
      rebuild_id, domain, scope_type, scope_id, state, schema_version,
      derivation_version, target_generation_vector_json,
      target_generation_vector_hash, copied_database_identity
    ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
    ON CONFLICT(rebuild_id) DO NOTHING
  `).bind(
    validated.rebuildId,
    validated.domain,
    validated.scopeType,
    validated.scopeId,
    validated.schemaVersion,
    validated.derivationVersion,
    validated.targetGenerationVectorJson,
    validated.targetGenerationVectorHash,
    validated.copiedDatabaseIdentity,
  ).run();
  const record = await readProjectionRebuild(database, validated.rebuildId);
  if (!record) throw new Error("projection rebuild insert returned no state");
  if (
    record.domain !== validated.domain ||
    record.scopeType !== validated.scopeType ||
    record.scopeId !== validated.scopeId ||
    record.schemaVersion !== validated.schemaVersion ||
    record.derivationVersion !== validated.derivationVersion ||
    record.targetGenerationVectorJson !== validated.targetGenerationVectorJson ||
    record.targetGenerationVectorHash !== validated.targetGenerationVectorHash ||
    record.copiedDatabaseIdentity !== validated.copiedDatabaseIdentity
  ) {
    throw new Error("projection rebuild identity conflicts with durable state");
  }
  return record;
}

export async function readProjectionRebuild(
  database: D1Database,
  rebuildId: string,
): Promise<ProjectionRebuildRecord | null> {
  requiredIdentity(rebuildId, "rebuildId", 512);
  const row = await database.prepare(`${SELECT_REBUILD}
    WHERE rebuild_id = ?
    LIMIT 1
  `).bind(rebuildId).first<ProjectionRebuildRow>();
  return row ? recordFromRow(row) : null;
}

export async function checkpointProjectionRebuild(
  database: D1Database,
  input: {
    readonly rebuildId: string;
    readonly targetGenerationVectorHash: string;
    readonly expectedCursorListingId: string | null;
    readonly nextCursorListingId: string;
    readonly rowsProcessed: number;
  },
): Promise<ProjectionRebuildRecord> {
  requiredIdentity(input.rebuildId, "rebuildId", 512);
  requiredIdentity(input.targetGenerationVectorHash, "targetGenerationVectorHash", 512);
  if (input.expectedCursorListingId !== null) {
    requiredIdentity(input.expectedCursorListingId, "expectedCursorListingId", 512);
  }
  requiredIdentity(input.nextCursorListingId, "nextCursorListingId", 512);
  if (
    input.expectedCursorListingId !== null &&
    input.nextCursorListingId <= input.expectedCursorListingId
  ) {
    throw new Error("projection rebuild cursor must advance lexically");
  }
  if (!Number.isSafeInteger(input.rowsProcessed) || input.rowsProcessed < 1) {
    throw new RangeError("rowsProcessed must be a positive safe integer");
  }
  const row = await database.prepare(`
    UPDATE pipeline_rebuild_state
    SET cursor_listing_id = ?,
        rows_processed = rows_processed + ?,
        batches_processed = batches_processed + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE rebuild_id = ?
      AND state = 'running'
      AND target_generation_vector_hash = ?
      AND cursor_listing_id IS ?
    RETURNING
      rebuild_id, domain, scope_type, scope_id, state, schema_version,
      derivation_version, target_generation_vector_json,
      target_generation_vector_hash, ending_generation_vector_json,
      ending_generation_vector_hash, cursor_listing_id, rows_processed,
      batches_processed, copied_database_identity, error_code,
      error_fingerprint, started_at, updated_at, completed_at
  `).bind(
    input.nextCursorListingId,
    input.rowsProcessed,
    input.rebuildId,
    input.targetGenerationVectorHash,
    input.expectedCursorListingId,
  ).first<ProjectionRebuildRow>();
  if (!row) {
    throw new Error("projection rebuild checkpoint lost its exact cursor or target");
  }
  return recordFromRow(row);
}

export async function finishProjectionRebuild(
  database: D1Database,
  input: {
    readonly rebuildId: string;
    readonly targetGenerationVectorHash: string;
    readonly endingGenerationVectorJson: string;
    readonly endingGenerationVectorHash: string;
  },
): Promise<ProjectionRebuildRecord> {
  requiredIdentity(input.rebuildId, "rebuildId", 512);
  requiredIdentity(input.targetGenerationVectorHash, "targetGenerationVectorHash", 512);
  requiredCanonicalJson(input.endingGenerationVectorJson, "endingGenerationVectorJson");
  requiredIdentity(input.endingGenerationVectorHash, "endingGenerationVectorHash", 512);
  const outcome = input.endingGenerationVectorHash ===
      input.targetGenerationVectorHash
    ? "completed"
    : "superseded";
  const row = await database.prepare(`
    UPDATE pipeline_rebuild_state
    SET state = ?,
        ending_generation_vector_json = ?,
        ending_generation_vector_hash = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE rebuild_id = ?
      AND state = 'running'
      AND target_generation_vector_hash = ?
    RETURNING
      rebuild_id, domain, scope_type, scope_id, state, schema_version,
      derivation_version, target_generation_vector_json,
      target_generation_vector_hash, ending_generation_vector_json,
      ending_generation_vector_hash, cursor_listing_id, rows_processed,
      batches_processed, copied_database_identity, error_code,
      error_fingerprint, started_at, updated_at, completed_at
  `).bind(
    outcome,
    input.endingGenerationVectorJson,
    input.endingGenerationVectorHash,
    input.rebuildId,
    input.targetGenerationVectorHash,
  ).first<ProjectionRebuildRow>();
  if (!row) throw new Error("projection rebuild completion lost its exact target");
  return recordFromRow(row);
}

export async function failProjectionRebuild(
  database: D1Database,
  input: {
    readonly rebuildId: string;
    readonly targetGenerationVectorHash: string;
    readonly errorCode: string;
    readonly errorFingerprint: string;
  },
): Promise<ProjectionRebuildRecord> {
  requiredIdentity(input.rebuildId, "rebuildId", 512);
  requiredIdentity(input.targetGenerationVectorHash, "targetGenerationVectorHash", 512);
  requiredIdentity(input.errorCode, "errorCode", 128);
  requiredIdentity(input.errorFingerprint, "errorFingerprint", 512);
  const row = await database.prepare(`
    UPDATE pipeline_rebuild_state
    SET state = 'failed', error_code = ?, error_fingerprint = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE rebuild_id = ?
      AND state = 'running'
      AND target_generation_vector_hash = ?
    RETURNING
      rebuild_id, domain, scope_type, scope_id, state, schema_version,
      derivation_version, target_generation_vector_json,
      target_generation_vector_hash, ending_generation_vector_json,
      ending_generation_vector_hash, cursor_listing_id, rows_processed,
      batches_processed, copied_database_identity, error_code,
      error_fingerprint, started_at, updated_at, completed_at
  `).bind(
    input.errorCode,
    input.errorFingerprint,
    input.rebuildId,
    input.targetGenerationVectorHash,
  ).first<ProjectionRebuildRow>();
  if (!row) throw new Error("projection rebuild failure lost its exact target");
  return recordFromRow(row);
}

function validatedBeginInput(input: Parameters<typeof beginProjectionRebuild>[1]) {
  requiredIdentity(input.rebuildId, "rebuildId", 512);
  requiredIdentity(input.domain, "domain", 128);
  if (!(["listing", "source", "group", "global"] as const).includes(input.scopeType)) {
    throw new TypeError("scopeType is invalid");
  }
  requiredIdentity(input.scopeId, "scopeId", 512);
  requiredIdentity(input.derivationVersion, "derivationVersion", 256);
  requiredCanonicalJson(input.targetGenerationVectorJson, "targetGenerationVectorJson");
  requiredIdentity(input.targetGenerationVectorHash, "targetGenerationVectorHash", 512);
  if (input.copiedDatabaseIdentity !== null && input.copiedDatabaseIdentity !== undefined) {
    requiredIdentity(input.copiedDatabaseIdentity, "copiedDatabaseIdentity", 512);
  }
  const schemaVersion = input.schemaVersion ?? PROJECTION_REBUILD_SCHEMA_VERSION;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 39) {
    throw new RangeError("schemaVersion must be at least 39");
  }
  return {
    ...input,
    schemaVersion,
    copiedDatabaseIdentity: input.copiedDatabaseIdentity ?? null,
  };
}

function requiredCanonicalJson(value: string, name: string): string {
  if (typeof value !== "string" || value.length < 2 || value.length > 1_000_000) {
    throw new TypeError(`${name} is not bounded JSON`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`${name} is not valid JSON`);
  }
  if (serializeCanonicalJson(parsed) !== value) {
    throw new TypeError(`${name} is not canonical JSON`);
  }
  return value;
}

function requiredIdentity(value: string, name: string, maximum: number): string {
  if (
    typeof value !== "string" || value.trim() !== value ||
    value.length < 1 || value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} is not a bounded canonical identity`);
  }
  return value;
}

function recordFromRow(row: ProjectionRebuildRow): ProjectionRebuildRecord {
  const requiredString = (value: unknown, name: string) => {
    if (typeof value !== "string" || value.length < 1) {
      throw new TypeError(`stored projection rebuild ${name} is invalid`);
    }
    return value;
  };
  const optionalString = (value: unknown, name: string) => {
    if (value === null) return null;
    return requiredString(value, name);
  };
  const integer = (value: unknown, name: string) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`stored projection rebuild ${name} is invalid`);
    }
    return value;
  };
  const scopeType = requiredString(row.scope_type, "scope type");
  if (!(["listing", "source", "group", "global"] as const).includes(
    scopeType as ProjectionRebuildRecord["scopeType"],
  )) throw new TypeError("stored projection rebuild scope type is invalid");
  const state = requiredString(row.state, "state");
  if (!(["pending", "running", "completed", "superseded", "failed"] as const)
    .includes(state as ProjectionRebuildState)) {
    throw new TypeError("stored projection rebuild state is invalid");
  }
  return Object.freeze({
    rebuildId: requiredString(row.rebuild_id, "id"),
    domain: requiredString(row.domain, "domain"),
    scopeType: scopeType as ProjectionRebuildRecord["scopeType"],
    scopeId: requiredString(row.scope_id, "scope id"),
    state: state as ProjectionRebuildState,
    schemaVersion: integer(row.schema_version, "schema version"),
    derivationVersion: requiredString(row.derivation_version, "derivation"),
    targetGenerationVectorJson: requiredString(row.target_generation_vector_json, "target vector"),
    targetGenerationVectorHash: requiredString(row.target_generation_vector_hash, "target hash"),
    endingGenerationVectorJson: optionalString(row.ending_generation_vector_json, "ending vector"),
    endingGenerationVectorHash: optionalString(row.ending_generation_vector_hash, "ending hash"),
    cursorListingId: optionalString(row.cursor_listing_id, "cursor"),
    rowsProcessed: integer(row.rows_processed, "rows"),
    batchesProcessed: integer(row.batches_processed, "batches"),
    copiedDatabaseIdentity: optionalString(row.copied_database_identity, "database identity"),
    errorCode: optionalString(row.error_code, "error code"),
    errorFingerprint: optionalString(row.error_fingerprint, "error fingerprint"),
    startedAt: requiredString(row.started_at, "start timestamp"),
    updatedAt: requiredString(row.updated_at, "update timestamp"),
    completedAt: optionalString(row.completed_at, "completion timestamp"),
  });
}
