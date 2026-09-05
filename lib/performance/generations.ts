import {
  canonicalJson,
  sha256CanonicalJson,
} from "../corpus-readiness/primitives.ts";

export const GENERATION_SCOPE_TYPES = [
  "listing",
  "source",
  "group",
  "global",
] as const;

/** Exact canonical domains required by the optimized nightly contract. */
export const PIPELINE_GENERATION_DOMAINS = [
  "source_publication",
  "source_current_membership",
  "shared_alias_group",
  "upstream_representative",
  "ownership_derivation",
  "active_origin",
  "route_contract",
  "accepted_detail_location",
  "factual_supplement",
  "image_local_primary",
  "enrichment_target",
  "preference_contract",
  "preference_score_head",
  "physical_asset",
  "auction_event",
  "semantic_family",
  "reviewed_history",
  "votes",
  "cohort",
  "presentation_policy",
  "source_release_cache",
] as const;

export type PipelineGenerationDomainName =
  (typeof PIPELINE_GENERATION_DOMAINS)[number];

export type GenerationScopeType = (typeof GENERATION_SCOPE_TYPES)[number];
export type Sha256Identity = `sha256:${string}`;

declare const generationDomainBrand: unique symbol;
declare const generationScopeIdBrand: unique symbol;

export type GenerationDomain = string & {
  readonly [generationDomainBrand]: true;
};

export type GenerationScopeId = string & {
  readonly [generationScopeIdBrand]: true;
};

export interface GenerationScope<
  TScopeType extends GenerationScopeType = GenerationScopeType,
> {
  scopeType: TScopeType;
  scopeId: GenerationScopeId;
}

export interface GenerationKey<
  TScopeType extends GenerationScopeType = GenerationScopeType,
> extends GenerationScope<TScopeType> {
  domain: GenerationDomain;
}

export interface GenerationFingerprintInput {
  domain: GenerationDomain;
  derivationVersion: string;
  input: unknown;
}

export interface AdvanceGenerationInput extends GenerationKey {
  fingerprint: Sha256Identity;
  derivationVersion: string;
}

export interface PipelineGenerationState extends GenerationKey {
  generation: number;
  fingerprint: Sha256Identity;
  derivationVersion: string;
  updatedAt: string;
}

export interface GenerationVectorEntry extends GenerationKey {
  generation: number;
  fingerprint: Sha256Identity;
  derivationVersion: string;
}

export interface PipelineGenerationVector {
  entries: GenerationVectorEntry[];
  canonicalJson: string;
  hash: Sha256Identity;
}

interface GenerationStateRow {
  domain: unknown;
  scope_type: unknown;
  scope_id: unknown;
  generation: unknown;
  fingerprint: unknown;
  derivation_version: unknown;
  updated_at: unknown;
}

const MAX_VECTOR_ENTRIES = 4_096;
const SHA256_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

function assertBoundedIdentity(
  value: unknown,
  label: string,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError(
      `${label} must be a trimmed, nonempty string of at most ${maximumLength} characters without control characters`,
    );
  }
}

function assertScopeType(value: unknown): asserts value is GenerationScopeType {
  if (
    typeof value !== "string" ||
    !(GENERATION_SCOPE_TYPES as readonly string[]).includes(value)
  ) {
    throw new TypeError("Generation scope type is invalid");
  }
}

function assertFingerprint(value: unknown): asserts value is Sha256Identity {
  if (typeof value !== "string" || !SHA256_IDENTITY_PATTERN.test(value)) {
    throw new TypeError("Generation fingerprint must be a SHA-256 identity");
  }
}

function assertKey(key: GenerationKey): void {
  assertBoundedIdentity(key.domain, "Generation domain", 128);
  assertScopeType(key.scopeType);
  assertBoundedIdentity(key.scopeId, "Generation scope ID", 512);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareKeys(left: GenerationKey, right: GenerationKey): number {
  return (
    compareText(left.domain, right.domain) ||
    compareText(left.scopeType, right.scopeType) ||
    compareText(left.scopeId, right.scopeId)
  );
}

function keyIdentity(key: GenerationKey): string {
  return canonicalJson([key.domain, key.scopeType, key.scopeId]);
}

function stateFromRow(row: GenerationStateRow): PipelineGenerationState {
  assertBoundedIdentity(row.domain, "Stored generation domain", 128);
  assertScopeType(row.scope_type);
  assertBoundedIdentity(row.scope_id, "Stored generation scope ID", 512);
  if (
    typeof row.generation !== "number" ||
    !Number.isSafeInteger(row.generation) ||
    row.generation < 1
  ) {
    throw new TypeError("Stored generation value is invalid");
  }
  assertFingerprint(row.fingerprint);
  assertBoundedIdentity(
    row.derivation_version,
    "Stored generation derivation version",
    256,
  );
  if (typeof row.updated_at !== "string" || row.updated_at.length === 0) {
    throw new TypeError("Stored generation timestamp is invalid");
  }
  return {
    domain: row.domain as GenerationDomain,
    scopeType: row.scope_type,
    scopeId: row.scope_id as GenerationScopeId,
    generation: row.generation,
    fingerprint: row.fingerprint,
    derivationVersion: row.derivation_version,
    updatedAt: row.updated_at,
  };
}

export function generationDomain(value: string): GenerationDomain {
  assertBoundedIdentity(value, "Generation domain", 128);
  return value as GenerationDomain;
}

export function generationScope<TScopeType extends GenerationScopeType>(
  scopeType: TScopeType,
  scopeId: string,
): GenerationScope<TScopeType> {
  assertScopeType(scopeType);
  assertBoundedIdentity(scopeId, "Generation scope ID", 512);
  return {
    scopeType,
    scopeId: scopeId as GenerationScopeId,
  };
}

export function generationKey<TScopeType extends GenerationScopeType>(
  domain: GenerationDomain,
  scope: GenerationScope<TScopeType>,
): GenerationKey<TScopeType> {
  const key = { domain, ...scope };
  assertKey(key);
  return key;
}

/** Strict canonical JSON with recursively sorted object keys. */
export function serializeCanonicalJson(value: unknown): string {
  return canonicalJson(value);
}

/** Returns a lowercase, prefixed SHA-256 identity for strict canonical JSON. */
export async function hashCanonicalJson(
  value: unknown,
): Promise<Sha256Identity> {
  return `sha256:${await sha256CanonicalJson(value)}`;
}

/**
 * Binds a generation fingerprint to its domain and derivation implementation,
 * so either a derivation or canonical input change produces a new identity.
 */
export async function fingerprintGenerationInput(
  value: GenerationFingerprintInput,
): Promise<Sha256Identity> {
  assertBoundedIdentity(value.domain, "Generation domain", 128);
  assertBoundedIdentity(
    value.derivationVersion,
    "Generation derivation version",
    256,
  );
  return hashCanonicalJson({
    domain: value.domain,
    derivationVersion: value.derivationVersion,
    input: value.input,
  });
}

export async function readPipelineGeneration(
  database: D1Database,
  key: GenerationKey,
): Promise<PipelineGenerationState | null> {
  assertKey(key);
  const row = await database.prepare(`
    SELECT
      domain, scope_type, scope_id, generation, fingerprint,
      derivation_version, updated_at
    FROM pipeline_generation_state
    WHERE domain = ? AND scope_type = ? AND scope_id = ?
  `).bind(key.domain, key.scopeType, key.scopeId).first<GenerationStateRow>();
  return row === null ? null : stateFromRow(row);
}

/**
 * Inserts generation 1 or increments the existing generation only when the
 * stable fingerprint changes. The conflict mutation is one SQLite statement.
 */
export async function advancePipelineGeneration(
  database: D1Database,
  input: AdvanceGenerationInput,
): Promise<PipelineGenerationState> {
  assertKey(input);
  assertFingerprint(input.fingerprint);
  assertBoundedIdentity(
    input.derivationVersion,
    "Generation derivation version",
    256,
  );

  const row = await database.prepare(`
    INSERT INTO pipeline_generation_state (
      domain, scope_type, scope_id, generation, fingerprint, derivation_version
    ) VALUES (?, ?, ?, 1, ?, ?)
    ON CONFLICT(domain, scope_type, scope_id) DO UPDATE SET
      generation = pipeline_generation_state.generation + 1,
      fingerprint = excluded.fingerprint,
      derivation_version = excluded.derivation_version,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE pipeline_generation_state.fingerprint <> excluded.fingerprint
    RETURNING
      domain, scope_type, scope_id, generation, fingerprint,
      derivation_version, updated_at
  `).bind(
    input.domain,
    input.scopeType,
    input.scopeId,
    input.fingerprint,
    input.derivationVersion,
  ).first<GenerationStateRow>();

  if (row !== null) return stateFromRow(row);

  const unchanged = await readPipelineGeneration(database, input);
  if (unchanged === null || unchanged.fingerprint !== input.fingerprint) {
    throw new Error("Generation upsert did not produce a consistent state");
  }
  return unchanged;
}

/** Reads every requested key exactly once and seals its stable sorted vector. */
export async function readPipelineGenerationVector(
  database: D1Database,
  requestedKeys: readonly GenerationKey[],
): Promise<PipelineGenerationVector> {
  if (requestedKeys.length > MAX_VECTOR_ENTRIES) {
    throw new RangeError(
      `Generation vectors support at most ${MAX_VECTOR_ENTRIES} entries`,
    );
  }

  const seen = new Set<string>();
  const keys = requestedKeys.map((key) => {
    assertKey(key);
    const identity = keyIdentity(key);
    if (seen.has(identity)) {
      throw new Error("Generation vector contains a duplicate key");
    }
    seen.add(identity);
    return key;
  }).sort(compareKeys);

  const requestedJson = canonicalJson(keys.map((key) => ({
    domain: key.domain,
    scopeType: key.scopeType,
    scopeId: key.scopeId,
  })));
  const result = await database.prepare(`
    WITH requested AS (
      SELECT
        json_extract(value, '$.domain') AS domain,
        json_extract(value, '$.scopeType') AS scope_type,
        json_extract(value, '$.scopeId') AS scope_id
      FROM json_each(?)
    )
    SELECT
      state.domain,
      state.scope_type,
      state.scope_id,
      state.generation,
      state.fingerprint,
      state.derivation_version,
      state.updated_at
    FROM requested
    INNER JOIN pipeline_generation_state AS state
      ON state.domain = requested.domain
      AND state.scope_type = requested.scope_type
      AND state.scope_id = requested.scope_id
    ORDER BY state.domain, state.scope_type, state.scope_id
  `).bind(requestedJson).all<GenerationStateRow>();

  if (result.results.length !== keys.length) {
    throw new Error(
      `Generation vector is incomplete (expected ${keys.length}, found ${result.results.length})`,
    );
  }

  const entries = result.results.map((row) => {
    const state = stateFromRow(row);
    return {
      domain: state.domain,
      scopeType: state.scopeType,
      scopeId: state.scopeId,
      generation: state.generation,
      fingerprint: state.fingerprint,
      derivationVersion: state.derivationVersion,
    } satisfies GenerationVectorEntry;
  });
  const vectorJson = canonicalJson(entries);
  return {
    entries,
    canonicalJson: vectorJson,
    hash: await hashCanonicalJson(entries),
  };
}

/**
 * Reads the compact readiness vector without reconstructing any canonical
 * population. Exact group/listing generations are deliberately represented by
 * their source/global aggregate generations: canonical mutation boundaries
 * advance both the exact scope and its aggregate in one batch. Including every
 * exact group here would turn an ordinary runtime readiness check into an
 * unbounded 75k+-row ledger scan and would not match the vector sealed by the
 * explicit reconciliation oracle.
 */
export async function readCompactPipelineGenerationVector(
  database: D1Database,
): Promise<PipelineGenerationVector> {
  const result = await database.prepare(`
    SELECT
      domain, scope_type, scope_id, generation, fingerprint,
      derivation_version, updated_at
    FROM pipeline_generation_state
    WHERE scope_type IN ('source', 'global')
    ORDER BY domain, scope_type, scope_id
    LIMIT ?
  `).bind(MAX_VECTOR_ENTRIES + 1).all<GenerationStateRow>();
  if (result.results.length > MAX_VECTOR_ENTRIES) {
    throw new RangeError(
      `Generation vectors support at most ${MAX_VECTOR_ENTRIES} entries`,
    );
  }
  const entries = result.results.map((row) => {
    const state = stateFromRow(row);
    return {
      domain: state.domain,
      scopeType: state.scopeType,
      scopeId: state.scopeId,
      generation: state.generation,
      fingerprint: state.fingerprint,
      derivationVersion: state.derivationVersion,
    } satisfies GenerationVectorEntry;
  });
  const vectorJson = canonicalJson(entries);
  return {
    entries,
    canonicalJson: vectorJson,
    hash: await hashCanonicalJson(entries),
  };
}

/** @deprecated Use the compact aggregate/source readiness vector. */
export const readCompletePipelineGenerationVector =
  readCompactPipelineGenerationVector;
