import {
  fingerprintGenerationInput,
  generationDomain,
  hashCanonicalJson,
  serializeCanonicalJson,
  type GenerationScopeType,
  type PipelineGenerationDomainName,
  type Sha256Identity,
} from "../performance/generations";
import { DATABASE_SCHEMA_VERSION, READ_SCHEMA_VERSION_SQL } from "../../db/bootstrap-sql";
import type {
  ProjectionRefreshStage,
  ProjectionRefreshTarget,
} from "./projection-refresh";

export const CANONICAL_MUTATION_INVALIDATION_VERSION =
  "canonical-mutation-invalidation-v1" as const;
export const CANONICAL_MUTATION_GLOBAL_AGGREGATE_VERSION =
  "canonical-mutation-global-aggregate-v1" as const;

export interface CanonicalGenerationMutation {
  readonly domain: PipelineGenerationDomainName;
  readonly scopeType: GenerationScopeType;
  readonly scopeId: string;
  readonly fingerprint: Sha256Identity;
  readonly derivationVersion: string;
}

export interface CanonicalMutationInvalidationInput {
  readonly database: D1Database;
  readonly generations: readonly CanonicalGenerationMutation[];
  readonly refresh: {
    readonly target: ProjectionRefreshTarget;
    readonly inputHash: Sha256Identity;
    readonly reasonCode: string;
    readonly priority?: number;
  };
  readonly now?: Date;
}

export interface CanonicalMutationPayloadGeneration {
  readonly domain: PipelineGenerationDomainName;
  readonly scopeType: GenerationScopeType;
  readonly scopeId: string;
  readonly input: unknown;
  readonly derivationVersion: string;
}

export interface CanonicalMutationPayloadInvalidationInput {
  readonly database: D1Database;
  readonly generations: readonly CanonicalMutationPayloadGeneration[];
  readonly refresh: {
    readonly target: ProjectionRefreshTarget;
    readonly reasonCode: string;
    readonly priority?: number;
  };
  readonly aggregateGlobalDomains?: boolean;
  readonly now?: Date;
}

export interface CanonicalMutationPayloadGenerationInput {
  readonly database: D1Database;
  readonly generations: readonly CanonicalMutationPayloadGeneration[];
  readonly aggregateGlobalDomains?: boolean;
  readonly now?: Date;
}

interface PreparedPayloadGenerations {
  readonly scoped: readonly CanonicalGenerationMutation[];
  readonly aggregate: readonly CanonicalGenerationMutation[];
  readonly now: Date;
}

interface MappedRefreshTarget {
  readonly stage: ProjectionRefreshStage;
  readonly subjectType: GenerationScopeType;
  readonly subjectId: string;
  readonly listingId: string | null;
  readonly sourceId: string | null;
  readonly laneKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function bounded(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximum ||
    value !== value.trim() || CONTROL.test(value)
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): Sha256Identity {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 identity`);
  }
  return value as Sha256Identity;
}

function timestamp(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new TypeError("mutation time is invalid");
  return value.toISOString();
}

function mappedTarget(target: ProjectionRefreshTarget): MappedRefreshTarget {
  if (target.type === "listing") {
    const listingId = bounded(target.listingId, "listing refresh identity", 512);
    const sourceId = bounded(target.sourceId, "listing refresh source", 512);
    return {
      stage: "projection_listing_refresh",
      subjectType: "listing",
      subjectId: listingId,
      listingId,
      sourceId,
      laneKey: sourceId,
      payload: { scopeType: "listing" },
    };
  }
  if (target.type === "source") {
    const sourceId = bounded(target.sourceId, "source refresh identity", 512);
    return {
      stage: "projection_source_refresh",
      subjectType: "source",
      subjectId: sourceId,
      listingId: null,
      sourceId,
      laneKey: sourceId,
      payload: { scopeType: "source" },
    };
  }
  if (target.type === "group") {
    const groupId = bounded(target.groupId, "group refresh identity", 512);
    const sourceId = target.sourceId === null || target.sourceId === undefined
      ? null
      : bounded(target.sourceId, "group refresh source", 512);
    return {
      stage: "projection_group_refresh",
      subjectType: "group",
      subjectId: groupId,
      listingId: null,
      sourceId,
      laneKey: sourceId ?? `group:${target.groupKind}`,
      payload: { scopeType: "group", groupKind: target.groupKind },
    };
  }
  const scopeId = bounded(target.scopeId, "global refresh identity", 512);
  return {
    stage: "projection_global_refresh",
    subjectType: "global",
    subjectId: scopeId,
    listingId: null,
    sourceId: null,
    laneKey: "global",
    payload: { scopeType: "global" },
  };
}

function validatedGeneration(
  generation: CanonicalGenerationMutation,
): CanonicalGenerationMutation {
  const scopeType = generation.scopeType;
  if (!(scopeType === "listing" || scopeType === "source" ||
      scopeType === "group" || scopeType === "global")) {
    throw new TypeError("canonical generation scope type is invalid");
  }
  return Object.freeze({
    domain: bounded(generation.domain, "canonical generation domain", 128) as
      PipelineGenerationDomainName,
    scopeType,
    scopeId: bounded(generation.scopeId, "canonical generation scope", 512),
    fingerprint: sha(generation.fingerprint, "canonical generation fingerprint"),
    derivationVersion: bounded(
      generation.derivationVersion,
      "canonical generation derivation version",
      256,
    ),
  });
}

function generationUpsertStatements(input: {
  readonly database: D1Database;
  readonly generations: readonly CanonicalGenerationMutation[];
  readonly now: string;
}): D1PreparedStatement[] {
  return input.generations.map((generation) => input.database.prepare(`
      INSERT INTO pipeline_generation_state (
        domain, scope_type, scope_id, generation, fingerprint,
        derivation_version, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(domain, scope_type, scope_id) DO UPDATE SET
        generation = pipeline_generation_state.generation + 1,
        fingerprint = excluded.fingerprint,
        derivation_version = excluded.derivation_version,
        updated_at = excluded.updated_at
      WHERE pipeline_generation_state.fingerprint <> excluded.fingerprint
        OR pipeline_generation_state.derivation_version <>
          excluded.derivation_version
    `).bind(
    generation.domain,
    generation.scopeType,
    generation.scopeId,
    generation.fingerprint,
    generation.derivationVersion,
    input.now,
  ));
}

/**
 * Returns generation upserts plus one coalesced projection refresh registration.
 * Callers append these statements to the same D1 batch as their canonical
 * mutation. The queue SELECT runs only when at least one supplied exact
 * generation changed in this transaction, so idempotent writes do not recreate
 * completed work. Any queue failure rolls the canonical mutation and generation
 * changes back with the containing D1 batch.
 */
export function prepareCanonicalMutationInvalidationStatements(
  input: CanonicalMutationInvalidationInput,
): D1PreparedStatement[] {
  if (!Array.isArray(input.generations) || input.generations.length < 1 ||
      input.generations.length > 32) {
    throw new RangeError("canonical invalidation requires 1..32 generations");
  }
  const generations = input.generations.map(validatedGeneration);
  const identities = new Set<string>();
  for (const generation of generations) {
    const identity = `${generation.domain}\u0000${generation.scopeType}\u0000${generation.scopeId}`;
    if (identities.has(identity)) {
      throw new TypeError("canonical invalidation repeats a generation key");
    }
    identities.add(identity);
  }
  const refresh = mappedTarget(input.refresh.target);
  const inputHash = sha(input.refresh.inputHash, "projection refresh input hash");
  const reasonCode = bounded(input.refresh.reasonCode, "projection refresh reason", 128);
  const priority = input.refresh.priority ?? 100;
  if (!Number.isSafeInteger(priority) || priority < -1_000_000 || priority > 1_000_000) {
    throw new RangeError("projection refresh priority is invalid");
  }
  const now = timestamp(input.now ?? new Date());
  const generationStatements = generationUpsertStatements({
    database: input.database,
    generations,
    now,
  });
  const primary = generations[0]!;
  const changedPredicates = generations.map(() => `EXISTS (
    SELECT 1 FROM pipeline_generation_state changed_generation
    WHERE changed_generation.domain = ?
      AND changed_generation.scope_type = ?
      AND changed_generation.scope_id = ?
      AND changed_generation.fingerprint = ?
      AND changed_generation.derivation_version = ?
      AND changed_generation.updated_at = ?
  )`).join(" OR ");
  const changedBindings = generations.flatMap((generation) => [
    generation.domain,
    generation.scopeType,
    generation.scopeId,
    generation.fingerprint,
    generation.derivationVersion,
    now,
  ]);
  const payloadJson = serializeCanonicalJson({
    ...refresh.payload,
    generationKeys: generations.map((generation) => ({
      domain: generation.domain,
      scopeType: generation.scopeType,
      scopeId: generation.scopeId,
      fingerprint: generation.fingerprint,
      derivationVersion: generation.derivationVersion,
    })),
  });
  const queueStatement = input.database.prepare(`
    INSERT INTO pipeline_work_items (
      stage, subject_type, subject_id, listing_id, source_id,
      subject_payload_json, lane_key, input_hash, revision, priority,
      reason_code, available_at, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?,
      json_set(json(?), '$.targetGeneration', primary_generation.generation),
      ?, ?, 1, ?, ?, ?, ?, ?
    FROM pipeline_generation_state primary_generation
    WHERE primary_generation.domain = ?
      AND primary_generation.scope_type = ?
      AND primary_generation.scope_id = ?
      AND (${changedPredicates})
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
    refresh.stage,
    refresh.subjectType,
    refresh.subjectId,
    refresh.listingId,
    refresh.sourceId,
    payloadJson,
    refresh.laneKey,
    inputHash,
    priority,
    reasonCode,
    now,
    now,
    now,
    primary.domain,
    primary.scopeType,
    primary.scopeId,
    ...changedBindings,
  );
  return [...generationStatements, queueStatement];
}

/**
 * Hashes exact canonical payloads and prepares their atomic invalidation.
 * Every public-schema mutation registers its generation and preparation work
 * in the same canonical D1 batch.
 */
export async function prepareCanonicalMutationPayloadInvalidationStatements(
  input: CanonicalMutationPayloadInvalidationInput,
): Promise<readonly D1PreparedStatement[]> {
  const prepared = await preparePayloadGenerations(input);
  if (prepared === null) return Object.freeze([]);
  const { scoped: scopedGenerations, aggregate: aggregateGenerations } = prepared;
  const refreshInputHash = await hashCanonicalJson({
    target: input.refresh.target,
    generations: scopedGenerations.map((entry) => ({
      domain: entry.domain,
      scopeType: entry.scopeType,
      scopeId: entry.scopeId,
      fingerprint: entry.fingerprint,
      derivationVersion: entry.derivationVersion,
    })),
  });
  const scopedInvalidation = prepareCanonicalMutationInvalidationStatements({
    database: input.database,
    generations: scopedGenerations,
    refresh: {
      ...input.refresh,
      inputHash: refreshInputHash,
    },
    now: prepared.now,
  });
  if (aggregateGenerations.length === 0) return scopedInvalidation;
  const aggregateStatements = generationUpsertStatements({
    database: input.database,
    generations: aggregateGenerations.map(validatedGeneration),
    now: timestamp(prepared.now),
  });
  return [...scopedInvalidation, ...aggregateStatements];
}

/**
 * Hashes exact canonical payloads and prepares only their monotonic generation
 * writes. This is for downstream cache/vector domains whose consumers read the
 * generation directly and which must not feed operational projection refreshes
 * back into their own upstream inputs.
 */
export async function prepareCanonicalMutationPayloadGenerationStatements(
  input: CanonicalMutationPayloadGenerationInput,
): Promise<readonly D1PreparedStatement[]> {
  const prepared = await preparePayloadGenerations(input);
  if (prepared === null) return Object.freeze([]);
  return generationUpsertStatements({
    database: input.database,
    generations: [...prepared.scoped, ...prepared.aggregate].map(validatedGeneration),
    now: timestamp(prepared.now),
  });
}

async function preparePayloadGenerations(
  input: CanonicalMutationPayloadGenerationInput,
): Promise<PreparedPayloadGenerations | null> {
  const schema = await input.database.prepare(READ_SCHEMA_VERSION_SQL).first<{ version: number }>();
  if (schema?.version !== DATABASE_SCHEMA_VERSION) {
    throw new Error("Canonical mutations require the initialized public database schema");
  }
  if (!Array.isArray(input.generations) || input.generations.length < 1 ||
      input.generations.length > 32) {
    throw new RangeError("canonical payload invalidation requires 1..32 generations");
  }
  const scopedGenerations = await Promise.all(input.generations.map(async (entry) => ({
    domain: entry.domain,
    scopeType: entry.scopeType,
    scopeId: entry.scopeId,
    fingerprint: await fingerprintGenerationInput({
      domain: generationDomain(entry.domain),
      derivationVersion: entry.derivationVersion,
      input: entry.input,
    }),
    derivationVersion: entry.derivationVersion,
  } satisfies CanonicalGenerationMutation)));
  const aggregateGenerations: CanonicalGenerationMutation[] = [];
  if (input.aggregateGlobalDomains !== false) {
    const byDomain = new Map<PipelineGenerationDomainName, CanonicalGenerationMutation[]>();
    for (const generation of scopedGenerations) {
      if (generation.scopeType === "global") continue;
      const entries = byDomain.get(generation.domain) ?? [];
      entries.push(generation);
      byDomain.set(generation.domain, entries);
    }
    for (const [domain, entries] of byDomain) {
      const changedEntries: CanonicalGenerationMutation[] = [];
      for (const entry of entries) {
        const current = await readStoredGenerationIdentity(
          input.database,
          entry.domain,
          entry.scopeType,
          entry.scopeId,
        );
        if (
          current?.fingerprint !== entry.fingerprint ||
          current?.derivationVersion !== entry.derivationVersion
        ) changedEntries.push(entry);
      }
      if (changedEntries.length === 0) continue;
      const currentGlobal = await readStoredGenerationIdentity(
        input.database,
        domain,
        "global",
        "all",
      );
      const derivationVersion =
        `${CANONICAL_MUTATION_GLOBAL_AGGREGATE_VERSION}:${domain}`;
      aggregateGenerations.push({
        domain,
        scopeType: "global",
        scopeId: "all",
        fingerprint: await fingerprintGenerationInput({
          domain: generationDomain(domain),
          derivationVersion,
          input: {
            prior: currentGlobal === null
              ? null
              : {
                  generation: currentGlobal.generation,
                  fingerprint: currentGlobal.fingerprint,
                  derivationVersion: currentGlobal.derivationVersion,
                },
            changes: changedEntries.map((entry) => ({
              scopeType: entry.scopeType,
              scopeId: entry.scopeId,
              fingerprint: entry.fingerprint,
              derivationVersion: entry.derivationVersion,
            })).sort((left, right) =>
              left.scopeType.localeCompare(right.scopeType) ||
              left.scopeId.localeCompare(right.scopeId)
            ),
          },
        }),
        derivationVersion,
      });
    }
  }
  if (scopedGenerations.length + aggregateGenerations.length > 32) {
    throw new RangeError("canonical payload invalidation expands beyond 32 generations");
  }
  return Object.freeze({
    scoped: Object.freeze(scopedGenerations),
    aggregate: Object.freeze(aggregateGenerations),
    now: input.now ?? new Date(),
  });
}

async function readStoredGenerationIdentity(
  database: D1Database,
  domain: PipelineGenerationDomainName,
  scopeType: GenerationScopeType,
  scopeId: string,
): Promise<{
  generation: number;
  fingerprint: string;
  derivationVersion: string;
} | null> {
  const row = await database.prepare(`
    SELECT generation, fingerprint, derivation_version
    FROM pipeline_generation_state
    WHERE domain = ? AND scope_type = ? AND scope_id = ?
  `).bind(domain, scopeType, scopeId).first<{
    generation: number;
    fingerprint: string;
    derivation_version: string;
  }>();
  return row === null
    ? null
    : {
        generation: Number(row.generation),
        fingerprint: String(row.fingerprint),
        derivationVersion: String(row.derivation_version),
      };
}
