import {
  hashCanonicalJson,
  type Sha256Identity,
} from "../performance/generations";
import { listingReviewCompletedSql } from "../review-completion";
import { optionalAiCapabilities } from "../ai/capabilities";
import {
  prepareCanonicalMutationPayloadGenerationStatements,
} from "./mutation-invalidation";

export const SOURCE_RELEASE_DERIVATION_VERSION = "source-review-release-v7";
const SOURCE_RELEASE_CACHE_MUTATION_DERIVATION_VERSION =
  "source-release-cache-mutation-v2" as const;

export const SOURCE_RELEASE_GENERATION_COMPONENTS = [
  "source_publication",
  "owner_alias_projection",
  "origin_route_contract",
  "detail_supplement_readiness",
  "image_local_primary_readiness",
  "enrichment_target_head",
  "vote_watermark",
  "cohort_policy",
  "active_history",
  "preference_visibility",
] as const;

export type SourceReleaseGenerationComponent =
  (typeof SOURCE_RELEASE_GENERATION_COMPONENTS)[number];
const OPTIONAL_RELEASE_GENERATION_COMPONENTS = new Set<SourceReleaseGenerationComponent>([
  "enrichment_target_head",
  "vote_watermark",
  "cohort_policy",
  "active_history",
  "preference_visibility",
]);
export type SourceReleaseCoverageMode =
  | "complete_current"
  | "discovery_frontier";
export type SourceReleaseStateName = "dirty" | "withheld" | "released";
export type SourceReleaseProofOutcome =
  | "invalidated"
  | "withheld"
  | "released";

export interface SourceReleaseGenerationEntry {
  readonly component: SourceReleaseGenerationComponent;
  readonly generation: number;
  readonly identityHash: Sha256Identity;
}

/**
 * Exact aggregate evidence is supplied by the canonical projector. This
 * repository intentionally does not reproduce or reinterpret its SQL.
 */
export interface SourceReleaseAggregateEvidence {
  readonly sourceId: string;
  readonly coverageMode: SourceReleaseCoverageMode;
  readonly generationVector: readonly SourceReleaseGenerationEntry[];
  readonly acceptedCount: number;
  readonly preparedCount: number;
  readonly incompleteCount: number;
  readonly acceptedSetHash: Sha256Identity;
  readonly preparedSetHash: Sha256Identity;
  readonly incompleteSetHash: Sha256Identity;
  readonly aggregateProofHash: Sha256Identity;
}

export interface StableSourceReleaseInput {
  readonly sourceId: string;
  readonly coverageMode: SourceReleaseCoverageMode;
  readonly generationVector: readonly SourceReleaseGenerationEntry[];
  readonly generationVectorHash: Sha256Identity;
  readonly releaseInputHash: Sha256Identity;
  readonly cacheVectorHash: Sha256Identity;
  readonly acceptedCount: number;
  readonly preparedCount: number;
  readonly incompleteCount: number;
  readonly acceptedSetHash: Sha256Identity;
  readonly preparedSetHash: Sha256Identity;
  readonly incompleteSetHash: Sha256Identity;
  readonly aggregateProofHash: Sha256Identity;
  readonly derivationVersion: typeof SOURCE_RELEASE_DERIVATION_VERSION;
}

export interface SourceReleaseStateRecord {
  readonly sourceId: string;
  readonly coverageMode: SourceReleaseCoverageMode;
  readonly generationVectorHash: Sha256Identity;
  readonly releaseInputHash: Sha256Identity;
  readonly releaseGeneration: number;
  readonly acceptedCount: number;
  readonly preparedCount: number;
  readonly incompleteCount: number;
  readonly releasedCount: number;
  readonly state: SourceReleaseStateName;
  readonly releaseProofId: string | null;
  readonly cacheVectorHash: Sha256Identity;
  readonly invalidationReasonCode: string | null;
  readonly updatedAt: string;
}

export interface SourceReleaseProofRecord {
  readonly proofId: string;
  readonly sourceId: string;
  readonly coverageMode: SourceReleaseCoverageMode;
  readonly generationVectorHash: Sha256Identity;
  readonly releaseInputHash: Sha256Identity;
  readonly releaseGeneration: number;
  readonly acceptedCount: number;
  readonly preparedCount: number;
  readonly incompleteCount: number;
  readonly releasedCount: number;
  readonly outcome: SourceReleaseProofOutcome;
  readonly invalidationReasonCode: string | null;
  readonly priorProofId: string | null;
  readonly completedAt: string;
  readonly derivationVersion: string;
}

export interface RegisterSourceReleaseInputResult {
  readonly outcome: "registered" | "unchanged" | "conditional_miss";
  readonly state: SourceReleaseStateRecord;
}

export interface FinalizeSourceReleaseResult {
  readonly outcome: "released" | "withheld" | "unchanged" | "stale_refused";
  readonly state: SourceReleaseStateRecord;
}

export interface SourceReleaseReadiness {
  readonly sourceId: string;
  readonly releaseGeneration: number | null;
  readonly releaseInputCurrent: boolean;
  readonly releaseReady: boolean;
  readonly settled: boolean;
  readonly skipDashboardPrime: boolean;
  readonly state: SourceReleaseStateName | "missing";
  readonly reason:
    | "missing_state"
    | "release_input_changed"
    | "release_dirty"
    | "source_withheld"
    | "source_released";
  readonly cacheVectorHash: Sha256Identity | null;
}

export interface DashboardSourceReleaseVectorEntry {
  readonly sourceId: string;
  readonly releaseGeneration: number;
  readonly releaseInputHash: Sha256Identity;
  readonly cacheVectorHash: Sha256Identity;
  readonly state: SourceReleaseStateName;
  readonly releasedCount: number;
}

export interface DashboardReleaseVector {
  readonly vectorHash: Sha256Identity;
  readonly generationVectorHash: Sha256Identity;
  readonly sourceVectorHash: Sha256Identity;
  readonly runtimeVectorHash: Sha256Identity;
  readonly sources: readonly DashboardSourceReleaseVectorEntry[];
  readonly registeredSourceCount: number;
  readonly releaseStateCount: number;
  readonly complete: boolean;
  readonly settled: boolean;
  readonly hasActivePipelineLease: boolean;
}

export interface ReconcileSourceReleaseResult {
  readonly sourceId: string;
  readonly outcome: FinalizeSourceReleaseResult["outcome"];
  readonly state: SourceReleaseStateRecord;
  readonly attempts: number;
}

interface SourceReleaseStateRow {
  source_id: unknown;
  coverage_mode: unknown;
  generation_vector_hash: unknown;
  release_input_hash: unknown;
  release_generation: unknown;
  accepted_count: unknown;
  prepared_count: unknown;
  incomplete_count: unknown;
  released_count: unknown;
  state: unknown;
  release_proof_id: unknown;
  cache_vector_hash: unknown;
  invalidation_reason_code: unknown;
  updated_at: unknown;
}

interface SourceReleaseProofRow {
  proof_id: unknown;
  source_id: unknown;
  coverage_mode: unknown;
  generation_vector_hash: unknown;
  release_input_hash: unknown;
  release_generation: unknown;
  accepted_count: unknown;
  prepared_count: unknown;
  incomplete_count: unknown;
  released_count: unknown;
  outcome: unknown;
  invalidation_reason_code: unknown;
  prior_proof_id: unknown;
  completed_at: unknown;
  derivation_version: unknown;
}

interface ProjectionReleaseRow {
  listing_id: unknown;
  review_completed: unknown;
  source_release_input_hash: unknown;
  relevant_generation_vector_hash: unknown;
  accepted: unknown;
  prepared: unknown;
  pending_stages: unknown;
  ownership_input_hash: unknown;
  accepted_detail_hash: unknown;
  route_input_hash: unknown;
  factual_supplement_input_hash: unknown;
  image_input_hash: unknown;
  enrichment_head_identity: unknown;
  score_head_identity: unknown;
}

interface GenerationReleaseRow {
  domain: unknown;
  scope_type: unknown;
  scope_id: unknown;
  generation: unknown;
  fingerprint: unknown;
  derivation_version: unknown;
}

const SHA256_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const SOURCE_RELEASE_PROJECTION_BATCH_SIZE = 1_000;
const MAX_SOURCE_RELEASE_PROJECTION_ROWS = 250_000;

const USABLE_SOURCE_TEXT_SQL = `(
  length(trim(stub.title)) > 0
  OR length(trim(coalesce(detail.raw_description, ''))) > 0
  OR length(trim(coalesce(detail.clean_description, ''))) > 0
)`;

const EXACT_TERMINAL_ENRICHMENT_SQL = `(
  enrichment.state = 'terminal'
  AND enrichment.head_identity = state.enrichment_head_identity
  AND enrichment.enrichment_input_hash = state.enrichment_input_hash
)`;

const EXACT_CURRENT_ACCEPTED_ROUTE_SQL = `(
  assignment.listing_id = state.listing_id
  AND assignment.route_cache_id = state.route_cache_identity
  AND route.provider_name = 'local_proximity'
  AND route.input_hash = state.route_input_hash
  AND route.error_code IS NULL
  AND route.drive_bucket IN ('under_2h', 'under_4h', 'under_8h')
)`;

function blockingListingWorkSql(): string {
  return `NOT (
    (work.lease_owner IS NULL
      OR work.lease_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    AND (
      (work.stage = 'detail' AND (
        state.accepted_detail_identity IS NOT NULL
        OR detail_terminal.listing_id IS NOT NULL
      ))
      OR (work.stage IN ('image_evidence', 'primary_image')
        AND state.local_primary_state = 'terminal')
      OR (work.stage = 'factual_supplement'
        AND state.factual_supplement_state IN ('failed', 'terminal'))
      OR (work.stage = 'proximity' AND ${EXACT_CURRENT_ACCEPTED_ROUTE_SQL})
      OR (work.stage IN (
          'enrichment_text', 'enrichment_embedding', 'preference_v2_score'
        ) AND ${EXACT_TERMINAL_ENRICHMENT_SQL})
    )
  )`;
}

const STATE_COLUMNS = `
  source_id, coverage_mode, generation_vector_hash, release_input_hash,
  release_generation, accepted_count, prepared_count, incomplete_count,
  released_count, state, release_proof_id, cache_vector_hash,
  invalidation_reason_code, updated_at
`;

const PROOF_COLUMNS = `
  proof_id, source_id, coverage_mode, generation_vector_hash,
  release_input_hash, release_generation, accepted_count, prepared_count,
  incomplete_count, released_count, outcome, invalidation_reason_code,
  prior_proof_id, completed_at, derivation_version
`;

const RELEASE_COMPONENT_DOMAINS: Readonly<
  Record<SourceReleaseGenerationComponent, readonly string[]>
> = Object.freeze({
  source_publication: ["source_publication", "source_current_membership"],
  owner_alias_projection: [
    "shared_alias_group",
    "upstream_representative",
    "ownership_derivation",
  ],
  origin_route_contract: ["active_origin", "route_contract"],
  detail_supplement_readiness: [
    "accepted_detail_location",
    "factual_supplement",
  ],
  image_local_primary_readiness: ["image_local_primary"],
  enrichment_target_head: ["enrichment_target"],
  vote_watermark: ["votes"],
  cohort_policy: ["cohort", "presentation_policy"],
  active_history: ["reviewed_history"],
  preference_visibility: ["presentation_policy"],
});

const DASHBOARD_VECTOR_GENERATION_DOMAINS = Object.freeze(
  Array.from(new Set([
    ...Object.values(RELEASE_COMPONENT_DOMAINS).flat(),
    "source_release_cache",
  ])).sort(),
);

async function prepareSourceReleaseCacheInvalidation(input: {
  readonly database: D1Database;
  readonly canonicalInput: unknown;
  readonly now?: Date;
}): Promise<readonly D1PreparedStatement[]> {
  return prepareCanonicalMutationPayloadGenerationStatements({
    database: input.database,
    generations: [{
      domain: "source_release_cache",
      scopeType: "global",
      scopeId: "all",
      input: input.canonicalInput,
      derivationVersion: SOURCE_RELEASE_CACHE_MUTATION_DERIVATION_VERSION,
    }],
    aggregateGlobalDomains: false,
    now: input.now,
  });
}

export async function computeSourceReleaseInput(
  evidence: SourceReleaseAggregateEvidence,
): Promise<StableSourceReleaseInput> {
  const sourceId = boundedText(evidence.sourceId, "Source ID", 256);
  const coverageMode = validateCoverageMode(evidence.coverageMode);
  const acceptedCount = count(evidence.acceptedCount, "Accepted count");
  const preparedCount = count(evidence.preparedCount, "Prepared count");
  const incompleteCount = count(evidence.incompleteCount, "Incomplete count");
  if (preparedCount + incompleteCount !== acceptedCount) {
    throw new TypeError(
      "Prepared and incomplete counts must exactly partition accepted rows",
    );
  }

  const generationVector = validateGenerationVector(evidence.generationVector);
  const acceptedSetHash = sha256(evidence.acceptedSetHash, "Accepted set hash");
  const preparedSetHash = sha256(evidence.preparedSetHash, "Prepared set hash");
  const incompleteSetHash = sha256(
    evidence.incompleteSetHash,
    "Incomplete set hash",
  );
  const aggregateProofHash = sha256(
    evidence.aggregateProofHash,
    "Aggregate proof hash",
  );
  const generationVectorHash = await hashCanonicalJson({
    coverageMode,
    entries: generationVector,
  });
  const releaseInputHash = await hashCanonicalJson({
    derivationVersion: SOURCE_RELEASE_DERIVATION_VERSION,
    sourceId,
    coverageMode,
    generationVectorHash,
    counts: { acceptedCount, preparedCount, incompleteCount },
    sets: { acceptedSetHash, preparedSetHash, incompleteSetHash },
    aggregateProofHash,
  });
  const cacheVectorHash = await hashCanonicalJson({
    derivationVersion: SOURCE_RELEASE_DERIVATION_VERSION,
    sourceId,
    coverageMode,
    generationVectorHash,
    releaseInputHash,
    outcome: incompleteCount === 0 ? "released" : "withheld",
    releasedCount: incompleteCount === 0 ? acceptedCount : 0,
  });

  return Object.freeze({
    sourceId,
    coverageMode,
    generationVector: Object.freeze(generationVector),
    generationVectorHash,
    releaseInputHash,
    cacheVectorHash,
    acceptedCount,
    preparedCount,
    incompleteCount,
    acceptedSetHash,
    preparedSetHash,
    incompleteSetHash,
    aggregateProofHash,
    derivationVersion: SOURCE_RELEASE_DERIVATION_VERSION,
  });
}

/**
 * Advances the desired release generation only for a new exact input. The
 * invalidation proof and state replacement share one D1 batch.
 */
export async function registerSourceReleaseInput(input: {
  readonly database: D1Database;
  readonly releaseInput: StableSourceReleaseInput;
  readonly invalidationReasonCode?: string;
  readonly now?: Date;
}): Promise<RegisterSourceReleaseInputResult> {
  const releaseInput = await validateStableInput(input.releaseInput);
  const current = await readSourceReleaseState(
    input.database,
    releaseInput.sourceId,
  );
  if (current?.releaseInputHash === releaseInput.releaseInputHash) {
    assertStateMatchesInput(current, releaseInput);
    return { outcome: "unchanged", state: current };
  }

  const nextGeneration = current === null ? 1 : current.releaseGeneration + 1;
  if (!Number.isSafeInteger(nextGeneration)) {
    throw new RangeError("Release generation exceeds the safe integer range");
  }
  const reasonCode = safeCode(
    input.invalidationReasonCode ??
      (current === null ? "initial_release_input" : "release_input_changed"),
    "Invalidation reason code",
  );
  const completedAt = timestamp(input.now);
  const priorProofId = current?.releaseProofId ?? null;
  const proofId = await sourceReleaseProofId({
    releaseInput,
    releaseGeneration: nextGeneration,
    outcome: "invalidated",
    invalidationReasonCode: reasonCode,
    priorProofId,
  });
  const priorPredicate = current === null
    ? "NOT EXISTS (SELECT 1 FROM source_review_release_state WHERE source_id = ?)"
    : `EXISTS (
        SELECT 1 FROM source_review_release_state
        WHERE source_id = ? AND release_generation = ? AND release_input_hash = ?
      )`;
  const priorBindings = current === null
    ? [releaseInput.sourceId]
    : [
        releaseInput.sourceId,
        current.releaseGeneration,
        current.releaseInputHash,
      ];
  const invalidation = await prepareSourceReleaseCacheInvalidation({
    database: input.database,
    canonicalInput: {
      sourceId: releaseInput.sourceId,
      coverageMode: releaseInput.coverageMode,
      generationVectorHash: releaseInput.generationVectorHash,
      releaseInputHash: releaseInput.releaseInputHash,
      releaseGeneration: nextGeneration,
      acceptedCount: releaseInput.acceptedCount,
      preparedCount: releaseInput.preparedCount,
      incompleteCount: releaseInput.incompleteCount,
      releasedCount: 0,
      state: "dirty",
      releaseProofId: proofId,
      cacheVectorHash: releaseInput.cacheVectorHash,
      invalidationReasonCode: reasonCode,
    },
    now: input.now,
  });

  await input.database.batch([
    input.database.prepare(`
      INSERT INTO source_review_release_proofs (${PROOF_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'invalidated', ?, ?, ?, ?
      WHERE ${priorPredicate}
      ON CONFLICT(proof_id) DO NOTHING
    `).bind(
      proofId,
      releaseInput.sourceId,
      releaseInput.coverageMode,
      releaseInput.generationVectorHash,
      releaseInput.releaseInputHash,
      nextGeneration,
      releaseInput.acceptedCount,
      releaseInput.preparedCount,
      releaseInput.incompleteCount,
      reasonCode,
      priorProofId,
      completedAt,
      SOURCE_RELEASE_DERIVATION_VERSION,
      ...priorBindings,
    ),
    input.database.prepare(`
      INSERT INTO source_review_release_state (${STATE_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0, 'dirty', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM source_review_release_proofs
        WHERE proof_id = ? AND source_id = ? AND release_generation = ?
          AND release_input_hash = ? AND outcome = 'invalidated'
      )
      ON CONFLICT(source_id) DO UPDATE SET
        coverage_mode = excluded.coverage_mode,
        generation_vector_hash = excluded.generation_vector_hash,
        release_input_hash = excluded.release_input_hash,
        release_generation = excluded.release_generation,
        accepted_count = excluded.accepted_count,
        prepared_count = excluded.prepared_count,
        incomplete_count = excluded.incomplete_count,
        released_count = 0,
        state = 'dirty',
        release_proof_id = excluded.release_proof_id,
        cache_vector_hash = excluded.cache_vector_hash,
        invalidation_reason_code = excluded.invalidation_reason_code,
        updated_at = excluded.updated_at
      WHERE source_review_release_state.release_generation = ?
        AND source_review_release_state.release_input_hash = ?
    `).bind(
      releaseInput.sourceId,
      releaseInput.coverageMode,
      releaseInput.generationVectorHash,
      releaseInput.releaseInputHash,
      nextGeneration,
      releaseInput.acceptedCount,
      releaseInput.preparedCount,
      releaseInput.incompleteCount,
      proofId,
      releaseInput.cacheVectorHash,
      reasonCode,
      completedAt,
      proofId,
      releaseInput.sourceId,
      nextGeneration,
      releaseInput.releaseInputHash,
      current?.releaseGeneration ?? 0,
      current?.releaseInputHash ?? "",
    ),
    ...invalidation,
  ]);

  const state = await requiredSourceReleaseState(
    input.database,
    releaseInput.sourceId,
  );
  if (
    state.releaseGeneration !== nextGeneration ||
    state.releaseInputHash !== releaseInput.releaseInputHash ||
    state.releaseProofId !== proofId
  ) {
    return { outcome: "conditional_miss", state };
  }
  assertStateMatchesInput(state, releaseInput);
  return { outcome: "registered", state };
}

/**
 * Appends a complete exact proof and binds it as current only while both the
 * desired generation and input hash still match. An incomplete accepted row
 * deterministically withholds the entire source.
 */
export async function finalizeSourceRelease(input: {
  readonly database: D1Database;
  readonly releaseInput: StableSourceReleaseInput;
  readonly expectedReleaseGeneration: number;
  readonly now?: Date;
}): Promise<FinalizeSourceReleaseResult> {
  const releaseInput = await validateStableInput(input.releaseInput);
  const expectedGeneration = positiveInteger(
    input.expectedReleaseGeneration,
    "Expected release generation",
  );
  const current = await requiredSourceReleaseState(
    input.database,
    releaseInput.sourceId,
  );
  if (
    current.releaseGeneration !== expectedGeneration ||
    current.releaseInputHash !== releaseInput.releaseInputHash
  ) {
    return { outcome: "stale_refused", state: current };
  }
  assertStateMatchesInput(current, releaseInput);
  const outcome = releaseInput.incompleteCount === 0 ? "released" : "withheld";
  if (current.state === outcome) {
    return { outcome: "unchanged", state: current };
  }
  if (current.state !== "dirty") {
    throw new Error("Release state is settled with an inconsistent outcome");
  }

  const releasedCount = outcome === "released" ? releaseInput.acceptedCount : 0;
  const completedAt = timestamp(input.now);
  const proofId = await sourceReleaseProofId({
    releaseInput,
    releaseGeneration: expectedGeneration,
    outcome,
    invalidationReasonCode: null,
    priorProofId: current.releaseProofId,
  });
  const invalidation = await prepareSourceReleaseCacheInvalidation({
    database: input.database,
    canonicalInput: {
      sourceId: releaseInput.sourceId,
      coverageMode: releaseInput.coverageMode,
      generationVectorHash: releaseInput.generationVectorHash,
      releaseInputHash: releaseInput.releaseInputHash,
      releaseGeneration: expectedGeneration,
      acceptedCount: releaseInput.acceptedCount,
      preparedCount: releaseInput.preparedCount,
      incompleteCount: releaseInput.incompleteCount,
      releasedCount,
      state: outcome,
      releaseProofId: proofId,
      cacheVectorHash: releaseInput.cacheVectorHash,
      invalidationReasonCode: null,
    },
    now: input.now,
  });

  await input.database.batch([
    input.database.prepare(`
      INSERT INTO source_review_release_proofs (${PROOF_COLUMNS})
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
      FROM source_review_release_state
      WHERE source_id = ? AND release_generation = ? AND release_input_hash = ?
        AND generation_vector_hash = ? AND state = 'dirty'
      ON CONFLICT(proof_id) DO NOTHING
    `).bind(
      proofId,
      releaseInput.sourceId,
      releaseInput.coverageMode,
      releaseInput.generationVectorHash,
      releaseInput.releaseInputHash,
      expectedGeneration,
      releaseInput.acceptedCount,
      releaseInput.preparedCount,
      releaseInput.incompleteCount,
      releasedCount,
      outcome,
      current.releaseProofId,
      completedAt,
      SOURCE_RELEASE_DERIVATION_VERSION,
      releaseInput.sourceId,
      expectedGeneration,
      releaseInput.releaseInputHash,
      releaseInput.generationVectorHash,
    ),
    input.database.prepare(`
      UPDATE source_review_release_state
      SET state = ?, released_count = ?, release_proof_id = ?,
          invalidation_reason_code = NULL, updated_at = ?
      WHERE source_id = ? AND release_generation = ? AND release_input_hash = ?
        AND generation_vector_hash = ? AND state = 'dirty'
        AND EXISTS (
          SELECT 1 FROM source_review_release_proofs
          WHERE proof_id = ? AND source_id = ? AND release_generation = ?
            AND release_input_hash = ? AND outcome = ?
        )
    `).bind(
      outcome,
      releasedCount,
      proofId,
      completedAt,
      releaseInput.sourceId,
      expectedGeneration,
      releaseInput.releaseInputHash,
      releaseInput.generationVectorHash,
      proofId,
      releaseInput.sourceId,
      expectedGeneration,
      releaseInput.releaseInputHash,
      outcome,
    ),
    ...invalidation,
  ]);

  const state = await requiredSourceReleaseState(
    input.database,
    releaseInput.sourceId,
  );
  if (
    state.releaseGeneration !== expectedGeneration ||
    state.releaseInputHash !== releaseInput.releaseInputHash ||
    state.releaseProofId !== proofId ||
    state.state !== outcome
  ) {
    return { outcome: "stale_refused", state };
  }
  return { outcome, state };
}

export async function readSourceReleaseState(
  database: D1Database,
  sourceId: string,
): Promise<SourceReleaseStateRecord | null> {
  const validatedSourceId = boundedText(sourceId, "Source ID", 256);
  const row = await database.prepare(`
    SELECT ${STATE_COLUMNS}
    FROM source_review_release_state
    WHERE source_id = ?
  `).bind(validatedSourceId).first<SourceReleaseStateRow>();
  return row === null ? null : stateFromRow(row);
}

export async function readSourceReleaseProofs(
  database: D1Database,
  sourceId: string,
): Promise<readonly SourceReleaseProofRecord[]> {
  const validatedSourceId = boundedText(sourceId, "Source ID", 256);
  const rows = await database.prepare(`
    SELECT ${PROOF_COLUMNS}
    FROM source_review_release_proofs
    WHERE source_id = ?
    ORDER BY release_generation,
      CASE outcome WHEN 'invalidated' THEN 0 ELSE 1 END,
      completed_at, proof_id
  `).bind(validatedSourceId).all<SourceReleaseProofRow>();
  return Object.freeze(rows.results.map(proofFromRow));
}

/**
 * Reads the bounded exact dashboard cache vector. Generation rows are retained
 * alongside settled release heads so a canonical mutation invalidates a read
 * before a delayed release worker can settle the affected source.
 */
export async function readDashboardReleaseVector(
  database: D1Database,
): Promise<DashboardReleaseVector> {
  const domainsJson = JSON.stringify(DASHBOARD_VECTOR_GENERATION_DOMAINS);
  const results = await database.batch([
    database.prepare(`SELECT COUNT(*) AS count FROM auction_sources`),
    database.prepare(`
      SELECT ${STATE_COLUMNS}
      FROM source_review_release_state
      ORDER BY source_id
      LIMIT 257
    `),
    database.prepare(`
      SELECT domain, scope_type, scope_id, generation, fingerprint,
        derivation_version
      FROM pipeline_generation_state
      WHERE domain IN (SELECT value FROM json_each(?))
        AND scope_type IN ('source', 'global')
      ORDER BY domain, scope_type, scope_id
      LIMIT 4097
    `).bind(domainsJson),
    database.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM pipeline_run_lease
        WHERE singleton = 1
          AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ) AS active
    `),
    database.prepare(`
      SELECT source.id AS source_id, source.display_name, source.enabled,
        source.permission_status, run.id AS run_id, run.status,
        run.started_at, run.completed_at, run.stubs_discovered,
        run.details_fetched, run.listings_accepted, run.listings_excluded,
        run.error_code, run.error_message
      FROM auction_sources source
      LEFT JOIN source_runs run ON run.id = (
        SELECT candidate.id FROM source_runs candidate
        WHERE candidate.source_id = source.id
        ORDER BY candidate.started_at DESC, candidate.id DESC LIMIT 1
      )
      ORDER BY source.id
      LIMIT 257
    `),
    database.prepare(`
      SELECT id, status, origin_postal_code, started_at, completed_at,
        listings_discovered, listings_new, listings_accepted,
        listings_excluded, error_code, error_message
      FROM discovery_runs
      ORDER BY started_at DESC, id DESC LIMIT 1
    `),
    database.prepare(`
      SELECT id, status, origin_postal_code, started_at, completed_at,
        requested_limit, effective_limit, pending_at_start, attempted,
        completed_count, failures, remaining, text_provider_name,
        text_model_name, extraction_prompt_version,
        semantic_document_version, embedding_provider_name,
        embedding_model_name, profile_votes_used, error_code, error_message
      FROM enrichment_runs
      ORDER BY started_at DESC, id DESC LIMIT 1
    `),
    database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM listing_votes) AS vote_count,
        (SELECT COALESCE(json_group_array(json_object(
          'listingId', listing_id, 'value', value,
          'createdAt', created_at, 'updatedAt', updated_at
        )), '[]') FROM (
          SELECT listing_id, value, created_at, updated_at
          FROM listing_votes ORDER BY listing_id LIMIT 10001
        )) AS votes_json,
        (SELECT COUNT(*) FROM listing_impressions) AS impression_count,
        (SELECT COALESCE(json_group_array(json_object(
          'impressionId', impression_id, 'listingId', listing_id
        )), '[]') FROM (
          SELECT impression_id, listing_id
          FROM listing_impressions ORDER BY impression_id LIMIT 10001
        )) AS impressions_json,
        (SELECT COUNT(*) FROM listing_lot_feedback) AS lot_feedback_count,
        (SELECT COALESCE(json_group_array(json_object(
          'id', id, 'listingId', listing_id, 'decision', decision,
          'createdAt', created_at
        )), '[]') FROM (
          SELECT id, listing_id, decision, created_at
          FROM listing_lot_feedback ORDER BY listing_id, created_at, id
          LIMIT 10001
        )) AS lot_feedback_json,
        (SELECT COUNT(*) FROM profile_signal_feedback) AS signal_feedback_count,
        (SELECT COALESCE(json_group_array(json_object(
          'id', id, 'profileId', profile_id, 'concept', concept,
          'normalizedConcept', normalized_concept, 'polarity', polarity,
          'action', action, 'sourceProfileVersionId', source_profile_version_id,
          'createdAt', created_at
        )), '[]') FROM (
          SELECT id, profile_id, concept, normalized_concept, polarity, action,
            source_profile_version_id, created_at
          FROM profile_signal_feedback
          ORDER BY profile_id, polarity, normalized_concept, created_at, id
          LIMIT 10001
        )) AS signal_feedback_json,
        profile.id AS profile_id,
        profile.current_version,
        profile.updated_at AS profile_updated_at,
        version.id AS profile_version_id,
        version.algorithm_version,
        version.human_summary,
        version.interested_concepts_json,
        version.not_interested_concepts_json,
        version.interested_support_count,
        version.not_interested_support_count,
        version.based_on_votes_through,
        version.created_at AS profile_version_created_at
      FROM (SELECT 1 AS singleton) singleton
      LEFT JOIN interest_profiles profile ON profile.id = 'default'
      LEFT JOIN profile_versions version
        ON version.profile_id = profile.id
        AND version.version = profile.current_version
    `),
  ]);
  if (results.length !== 8) {
    throw new Error(
      `Dashboard release vector read returned ${results.length} results; expected 8`,
    );
  }
  const sourceCountRow = (results[0]?.results?.[0] ?? null) as {
    count: unknown;
  } | null;
  const releaseRows = (results[1]?.results ?? []) as SourceReleaseStateRow[];
  const generationRows = (results[2]?.results ?? []) as GenerationReleaseRow[];
  const leaseRow = (results[3]?.results?.[0] ?? null) as {
    active: unknown;
  } | null;
  const sourceRuntimeRows = (results[4]?.results ?? []) as Array<
    Record<string, unknown>
  >;
  const discoveryRuntimeRow = (results[5]?.results?.[0] ?? null) as
    | Record<string, unknown>
    | null;
  const enrichmentRuntimeRow = (results[6]?.results?.[0] ?? null) as
    | Record<string, unknown>
    | null;
  const operatorRuntimeRow = (results[7]?.results?.[0] ?? null) as
    | Record<string, unknown>
    | null;
  const registeredSourceCount = count(
    Number(sourceCountRow?.count ?? 0),
    "Registered source count",
  );
  const rawReleaseRows = releaseRows;
  const rawGenerationRows = generationRows;
  if (rawReleaseRows.length > 256) {
    throw new RangeError("Dashboard release vectors support at most 256 sources");
  }
  if (rawGenerationRows.length > 4_096) {
    throw new RangeError("Dashboard release vectors support at most 4096 generations");
  }
  if (sourceRuntimeRows.length > 256) {
    throw new RangeError("Dashboard runtime vectors support at most 256 sources");
  }
  for (const [label, value] of [
    ["votes", operatorRuntimeRow?.vote_count],
    ["impressions", operatorRuntimeRow?.impression_count],
    ["lot feedback", operatorRuntimeRow?.lot_feedback_count],
    ["profile signal feedback", operatorRuntimeRow?.signal_feedback_count],
  ] as const) {
    if (Number(value ?? 0) > 10_000) {
      throw new RangeError(`Dashboard runtime vector exceeded 10000 ${label} rows`);
    }
  }
  const states = rawReleaseRows.map(stateFromRow);
  const sources = Object.freeze(states.map((state) => Object.freeze({
    sourceId: state.sourceId,
    releaseGeneration: state.releaseGeneration,
    releaseInputHash: state.releaseInputHash,
    cacheVectorHash: state.cacheVectorHash,
    state: state.state,
    releasedCount: state.releasedCount,
  })));
  const generations = rawGenerationRows.map((row) => ({
    domain: boundedText(row.domain, "Stored generation domain", 128),
    scopeType: boundedText(row.scope_type, "Stored generation scope type", 32),
    scopeId: boundedText(row.scope_id, "Stored generation scope ID", 512),
    generation: positiveInteger(Number(row.generation), "Stored generation"),
    fingerprint: sha256(row.fingerprint, "Stored generation fingerprint"),
    derivationVersion: boundedText(
      row.derivation_version,
      "Stored generation derivation version",
      256,
    ),
  }));
  const sourceVectorHash = await hashCanonicalJson(sources);
  const generationVectorHash = await hashCanonicalJson(generations);
  const runtimeVectorHash = await hashCanonicalJson({
    sources: sourceRuntimeRows,
    discovery: discoveryRuntimeRow,
    enrichment: enrichmentRuntimeRow,
    operator: operatorRuntimeRow,
  });
  const hasActivePipelineLease = Number(leaseRow?.active ?? 0) === 1;
  const complete = registeredSourceCount === sources.length;
  const settled = complete && !hasActivePipelineLease &&
    states.every((state) => state.state !== "dirty");
  const vectorHash = await hashCanonicalJson({
    derivationVersion: SOURCE_RELEASE_DERIVATION_VERSION,
    registeredSourceCount,
    sourceVectorHash,
    generationVectorHash,
    runtimeVectorHash,
  });
  return Object.freeze({
    vectorHash,
    generationVectorHash,
    sourceVectorHash,
    runtimeVectorHash,
    sources,
    registeredSourceCount,
    releaseStateCount: sources.length,
    complete,
    settled,
    hasActivePipelineLease,
  });
}

/** Exact source IDs whose release/cache entries changed between two vectors. */
export function changedDashboardReleaseSourceIds(
  prior: DashboardReleaseVector | null,
  current: DashboardReleaseVector,
): ReadonlySet<string> {
  if (prior === null) return new Set(current.sources.map((entry) => entry.sourceId));
  const priorBySource = new Map(prior.sources.map((entry) => [
    entry.sourceId,
    `${entry.releaseGeneration}\u0000${entry.releaseInputHash}\u0000${entry.cacheVectorHash}\u0000${entry.state}`,
  ]));
  const changed = new Set<string>();
  for (const entry of current.sources) {
    const identity = `${entry.releaseGeneration}\u0000${entry.releaseInputHash}\u0000${entry.cacheVectorHash}\u0000${entry.state}`;
    if (priorBySource.get(entry.sourceId) !== identity) changed.add(entry.sourceId);
    priorBySource.delete(entry.sourceId);
  }
  for (const sourceId of priorBySource.keys()) changed.add(sourceId);
  if (
    changed.size === 0 &&
    (
      prior.generationVectorHash !== current.generationVectorHash ||
      prior.runtimeVectorHash !== current.runtimeVectorHash
    )
  ) {
    for (const entry of current.sources) changed.add(entry.sourceId);
  }
  return changed;
}

/**
 * Projects one source's exact release evidence from the current
 * operational rows. It does not reinterpret source truth or modify it.
 */
export async function readProjectedSourceReleaseEvidence(input: {
  readonly database: D1Database;
  readonly sourceId: string;
}): Promise<SourceReleaseAggregateEvidence> {
  const sourceId = boundedText(input.sourceId, "Source ID", 256);
  const [rows, generationResult, coverageRow] = await Promise.all([
    readProjectedSourceReleaseRows(input.database, sourceId),
    input.database.prepare(`
      SELECT domain, scope_type, scope_id, generation, fingerprint,
        derivation_version
      FROM pipeline_generation_state
      WHERE domain IN (SELECT value FROM json_each(?))
        AND (
          scope_type = 'global'
          OR (scope_type = 'source' AND scope_id = ?)
        )
      ORDER BY domain, scope_type, scope_id
      LIMIT 4097
    `).bind(
      JSON.stringify(DASHBOARD_VECTOR_GENERATION_DOMAINS),
      sourceId,
    ).all<GenerationReleaseRow>(),
    input.database.prepare(`
      SELECT 'complete_current' AS coverage_mode
      FROM auction_sources source
      WHERE source.id = ?
    `).bind(sourceId).first<{ coverage_mode: unknown }>(),
  ]);
  const generations = generationResult.results ?? [];
  if (generations.length > 4_096) {
    throw new RangeError("Source release generation vector exceeded 4096 entries");
  }
  if (!coverageRow) throw new Error(`Unknown source release source: ${sourceId}`);
  const coverageMode = validateCoverageMode(coverageRow.coverage_mode);
  const normalizedGenerations = generations.map((row) => ({
    domain: boundedText(row.domain, "Stored generation domain", 128),
    scopeType: boundedText(row.scope_type, "Stored generation scope type", 32),
    scopeId: boundedText(row.scope_id, "Stored generation scope ID", 512),
    generation: positiveInteger(Number(row.generation), "Stored generation"),
    fingerprint: sha256(row.fingerprint, "Stored generation fingerprint"),
    derivationVersion: boundedText(
      row.derivation_version,
      "Stored generation derivation version",
      256,
    ),
  }));
  const generationVector: SourceReleaseGenerationEntry[] = [];
  for (const component of SOURCE_RELEASE_GENERATION_COMPONENTS) {
    const domains = RELEASE_COMPONENT_DOMAINS[component];
    const entries = normalizedGenerations.filter((entry) =>
      domains.includes(entry.domain)
    );
    if (entries.length === 0) {
      if (await optionalReleaseComponentIsAbsent(input.database, component)) continue;
      throw new Error(`Source release generation evidence is missing ${component}`);
    }
    generationVector.push(Object.freeze({
      component,
      generation: Math.max(...entries.map((entry) => entry.generation)),
      identityHash: await hashCanonicalJson(entries),
    }));
  }
  const normalizedRows = rows.map((row) => {
    const listingId = boundedText(row.listing_id, "Projected listing ID", 512);
    const releaseInputHash = sha256(
      row.source_release_input_hash,
      "Projected source release input hash",
    );
    return Object.freeze({
      listingId,
      reviewCompleted: Number(row.review_completed) === 1,
      releaseInputHash,
      relevantGenerationVectorHash: sha256(
        row.relevant_generation_vector_hash,
        "Projected relevant generation vector hash",
      ),
      accepted: Number(row.accepted) === 1,
      prepared: Number(row.prepared) === 1,
      pendingStages: boundedJsonArray(row.pending_stages, "Projected pending stages"),
      ownershipInputHash: sha256(
        row.ownership_input_hash,
        "Projected ownership input hash",
      ),
      acceptedDetailHash: optionalBoundedText(row.accepted_detail_hash),
      routeInputHash: optionalBoundedText(row.route_input_hash),
      factualSupplementInputHash: optionalBoundedText(
        row.factual_supplement_input_hash,
      ),
      imageInputHash: optionalBoundedText(row.image_input_hash),
      enrichmentHeadIdentity: optionalBoundedText(row.enrichment_head_identity),
      scoreHeadIdentity: optionalBoundedText(row.score_head_identity),
    });
  });
  const acceptedRows = normalizedRows.filter((row) => row.accepted);
  const preparedRows = acceptedRows.filter((row) => row.prepared);
  const incompleteRows = acceptedRows.filter((row) => !row.prepared);
  return Object.freeze({
    sourceId,
    coverageMode,
    generationVector: Object.freeze(generationVector),
    acceptedCount: acceptedRows.length,
    preparedCount: preparedRows.length,
    incompleteCount: incompleteRows.length,
    acceptedSetHash: await hashCanonicalJson(
      acceptedRows.map((row) => row.listingId),
    ),
    preparedSetHash: await hashCanonicalJson(
      preparedRows.map((row) => row.listingId),
    ),
    incompleteSetHash: await hashCanonicalJson(
      incompleteRows.map((row) => row.listingId),
    ),
    aggregateProofHash: await hashCanonicalJson(normalizedRows),
  });
}

async function readProjectedSourceReleaseRows(
  database: D1Database,
  sourceId: string,
): Promise<readonly ProjectionReleaseRow[]> {
  const capabilities = optionalAiCapabilities();
  const optionalReadySql = capabilities.enrichment
    ? `(${EXACT_TERMINAL_ENRICHMENT_SQL} OR (
        enrichment.state = 'complete'
        AND enrichment.head_identity = state.enrichment_head_identity
        AND enrichment.enrichment_input_hash = state.enrichment_input_hash
      ))`
    : "1";
  // Only enabled capabilities can contribute blocking work. No failed model
  // receipt is fabricated when a user has not configured an optional service.
  const blockingStagesSql = [
    "detail", "action_deadline", "owner_refresh", "factual_supplement",
    "image_evidence", "primary_image", "proximity",
    ...(capabilities.enrichment ? ["enrichment_text", "enrichment_embedding"] : []),
  ].map((stage) => `'${stage}'`).join(", ");
  const rows: ProjectionReleaseRow[] = [];
  let afterListingId: string | null = null;
  for (;;) {
    const result: D1Result<ProjectionReleaseRow> = await database.prepare(`
      SELECT
        state.listing_id,
        CASE WHEN ${listingReviewCompletedSql("state.listing_id")}
          THEN 1 ELSE 0 END AS review_completed,
        state.source_release_input_hash,
        state.relevant_generation_vector_hash,
        CASE WHEN
          ownership.actionable_owner_listing_id = state.listing_id
          AND ${EXACT_CURRENT_ACCEPTED_ROUTE_SQL}
        THEN 1 ELSE 0 END AS accepted,
        CASE WHEN
          ownership.actionable_owner_listing_id = state.listing_id
          AND ${EXACT_CURRENT_ACCEPTED_ROUTE_SQL}
          AND (
            ${listingReviewCompletedSql("state.listing_id")}
            OR (
              ${USABLE_SOURCE_TEXT_SQL}
              AND (state.accepted_detail_identity IS NOT NULL
                OR detail_terminal.listing_id IS NOT NULL)
              AND state.factual_supplement_state IN ('ready', 'failed', 'terminal')
              AND state.local_primary_state IN ('ready', 'terminal')
              AND (${optionalReadySql})
              AND NOT EXISTS (
                SELECT 1 FROM pipeline_work_items work
                WHERE work.subject_type = 'listing'
                  AND work.subject_id = state.listing_id
                  AND work.stage IN (${blockingStagesSql})
                  AND ${blockingListingWorkSql()}
                )
            )
          )
        THEN 1 ELSE 0 END AS prepared,
        CASE WHEN ${listingReviewCompletedSql("state.listing_id")}
          THEN '[]'
          ELSE COALESCE((
            SELECT json_group_array(stage)
            FROM (
              SELECT work.stage
              FROM pipeline_work_items work
              WHERE work.subject_type = 'listing'
                AND work.subject_id = state.listing_id
                AND work.stage IN (${blockingStagesSql})
                AND ${blockingListingWorkSql()}
              ORDER BY work.stage
              )
          ), '[]')
        END AS pending_stages,
        state.ownership_input_hash,
        state.accepted_detail_hash,
        state.route_input_hash,
        state.factual_supplement_input_hash,
        state.image_input_hash,
        state.enrichment_head_identity,
        state.score_head_identity
      FROM listing_current_pipeline_state state
      JOIN listing_operational_ownership ownership
        ON ownership.listing_id = state.listing_id
        AND ownership.ownership_input_hash = state.ownership_input_hash
      JOIN listing_stubs stub ON stub.id = state.listing_id
      LEFT JOIN listing_details detail ON detail.listing_id = state.listing_id
      LEFT JOIN listing_detail_terminal_status detail_terminal
        ON detail_terminal.listing_id = state.listing_id
      LEFT JOIN listing_routes assignment
        ON assignment.listing_id = state.listing_id
      LEFT JOIN route_cache route ON route.id = state.route_cache_identity
      LEFT JOIN listing_enrichment_heads enrichment
        ON enrichment.listing_id = state.listing_id
      WHERE state.source_id = ?
        AND state.source_current = 1
        AND state.review_candidate = 1
        AND (? IS NULL OR state.listing_id > ?)
      ORDER BY state.listing_id
      LIMIT ?
    `).bind(
      sourceId,
      afterListingId,
      afterListingId,
      SOURCE_RELEASE_PROJECTION_BATCH_SIZE,
    ).all<ProjectionReleaseRow>();
    const page: ProjectionReleaseRow[] = result.results ?? [];
    rows.push(...page);
    if (rows.length > MAX_SOURCE_RELEASE_PROJECTION_ROWS) {
      throw new RangeError(
        `Source release projection exceeded ${MAX_SOURCE_RELEASE_PROJECTION_ROWS} listings`,
      );
    }
    if (page.length < SOURCE_RELEASE_PROJECTION_BATCH_SIZE) break;
    const next = boundedText(
      page.at(-1)!.listing_id,
      "Projected listing ID",
      512,
    );
    if (afterListingId !== null && next <= afterListingId) {
      throw new Error("Source release projection keyset did not advance");
    }
    afterListingId = next;
  }
  return Object.freeze(rows);
}

/**
 * Incrementally settles exactly one source and rechecks its projection before
 * returning. A concurrent input change is registered and retried once; stale
 * proof output is never reported as current.
 */
export async function reconcileProjectedSourceRelease(input: {
  readonly database: D1Database;
  readonly sourceId: string;
  readonly now?: Date;
}): Promise<ReconcileSourceReleaseResult> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const evidence = await readProjectedSourceReleaseEvidence(input);
    const releaseInput = await computeSourceReleaseInput(evidence);
    const registration = await registerSourceReleaseInput({
      database: input.database,
      releaseInput,
      invalidationReasonCode: "projected_release_input_changed",
      now: input.now,
    });
    if (registration.outcome === "conditional_miss") continue;
    const finalized = await finalizeSourceRelease({
      database: input.database,
      releaseInput,
      expectedReleaseGeneration: registration.state.releaseGeneration,
      now: input.now,
    });
    const confirmed = await computeSourceReleaseInput(
      await readProjectedSourceReleaseEvidence(input),
    );
    if (
      finalized.outcome !== "stale_refused" &&
      confirmed.releaseInputHash === releaseInput.releaseInputHash
    ) {
      return Object.freeze({
        sourceId: releaseInput.sourceId,
        outcome: finalized.outcome,
        state: finalized.state,
        attempts: attempt,
      });
    }
    await registerSourceReleaseInput({
      database: input.database,
      releaseInput: confirmed,
      invalidationReasonCode: "projected_release_race",
      now: input.now,
    });
  }
  const state = await requiredSourceReleaseState(input.database, input.sourceId);
  return Object.freeze({
    sourceId: state.sourceId,
    outcome: "stale_refused",
    state,
    attempts: 2,
  });
}

/** Bounded source-local drain; callers pass only sources dirtied by the queue. */
export async function reconcileProjectedSourceReleases(input: {
  readonly database: D1Database;
  readonly sourceIds: readonly string[];
  readonly now?: Date;
}): Promise<readonly ReconcileSourceReleaseResult[]> {
  const sourceIds = [...new Set(input.sourceIds.map((sourceId) =>
    boundedText(sourceId, "Source ID", 256)
  ))].sort();
  if (sourceIds.length !== input.sourceIds.length) {
    throw new TypeError("Source release refresh IDs must be unique");
  }
  if (sourceIds.length > 32) {
    throw new RangeError("Source release refresh supports at most 32 sources");
  }
  const results: ReconcileSourceReleaseResult[] = [];
  for (const sourceId of sourceIds) {
    results.push(await reconcileProjectedSourceRelease({
      database: input.database,
      sourceId,
      now: input.now,
    }));
  }
  return Object.freeze(results);
}

/** One primary-key read; the caller supplies its currently materialized cache vector. */
export async function checkSourceReleaseReadiness(input: {
  readonly database: D1Database;
  readonly sourceId: string;
  readonly expectedReleaseInputHash: Sha256Identity;
  readonly materializedCacheVectorHash: Sha256Identity | null;
}): Promise<SourceReleaseReadiness> {
  const sourceId = boundedText(input.sourceId, "Source ID", 256);
  const expectedReleaseInputHash = sha256(
    input.expectedReleaseInputHash,
    "Expected release input hash",
  );
  const materializedCacheVectorHash = input.materializedCacheVectorHash === null
    ? null
    : sha256(input.materializedCacheVectorHash, "Materialized cache vector hash");
  const state = await readSourceReleaseState(input.database, sourceId);
  if (state === null) {
    return {
      sourceId,
      releaseGeneration: null,
      releaseInputCurrent: false,
      releaseReady: false,
      settled: false,
      skipDashboardPrime: false,
      state: "missing",
      reason: "missing_state",
      cacheVectorHash: null,
    };
  }
  if (state.releaseInputHash !== expectedReleaseInputHash) {
    return readiness(state, {
      releaseInputCurrent: false,
      releaseReady: false,
      settled: false,
      skipDashboardPrime: false,
      reason: "release_input_changed",
    });
  }
  if (state.state === "dirty") {
    return readiness(state, {
      releaseInputCurrent: true,
      releaseReady: false,
      settled: false,
      skipDashboardPrime: false,
      reason: "release_dirty",
    });
  }
  const skipDashboardPrime = materializedCacheVectorHash === state.cacheVectorHash;
  return readiness(state, {
    releaseInputCurrent: true,
    releaseReady: state.state === "released",
    settled: true,
    skipDashboardPrime,
    reason: state.state === "released" ? "source_released" : "source_withheld",
  });
}

async function sourceReleaseProofId(input: {
  releaseInput: StableSourceReleaseInput;
  releaseGeneration: number;
  outcome: SourceReleaseProofOutcome;
  invalidationReasonCode: string | null;
  priorProofId: string | null;
}): Promise<string> {
  const identity = await hashCanonicalJson({
    derivationVersion: SOURCE_RELEASE_DERIVATION_VERSION,
    sourceId: input.releaseInput.sourceId,
    releaseGeneration: input.releaseGeneration,
    releaseInputHash: input.releaseInput.releaseInputHash,
    outcome: input.outcome,
    invalidationReasonCode: input.invalidationReasonCode,
    priorProofId: input.priorProofId,
  });
  return `source-release-proof:${identity.slice("sha256:".length)}`;
}

/** Missing optional generations are valid only while their canonical state is absent. */
async function optionalReleaseComponentIsAbsent(
  database: D1Database,
  component: SourceReleaseGenerationComponent,
): Promise<boolean> {
  let sql: string;
  switch (component) {
    case "enrichment_target_head":
      if (optionalAiCapabilities().enrichment) return false;
      sql = "SELECT EXISTS (SELECT 1 FROM listing_enrichment_heads) AS present";
      break;
    case "vote_watermark":
      sql = "SELECT EXISTS (SELECT 1 FROM listing_votes) AS present";
      break;
    case "cohort_policy":
      sql = "SELECT EXISTS (SELECT 1 FROM adhoc_review_cohorts) AS present";
      break;
    case "active_history":
      sql = "SELECT EXISTS (SELECT 1 FROM listing_impressions) AS present";
      break;
    case "preference_visibility":
      sql = "SELECT EXISTS (SELECT 1 FROM profile_versions) AS present";
      break;
    default:
      return false;
  }
  const state = await database.prepare(sql).first<{ present: number }>();
  return Number(state?.present) === 0;
}

function validateGenerationVector(
  input: readonly SourceReleaseGenerationEntry[],
): SourceReleaseGenerationEntry[] {
  if (!Array.isArray(input)) {
    throw new TypeError("Release generation vector must be an array");
  }
  const entries = input.map((entry) => {
    if (entry === null || typeof entry !== "object") {
      throw new TypeError("Release generation vector entry is invalid");
    }
    if (!(SOURCE_RELEASE_GENERATION_COMPONENTS as readonly string[]).includes(entry.component)) {
      throw new TypeError(`Unknown release generation component: ${String(entry.component)}`);
    }
    return {
      component: entry.component,
      generation: positiveInteger(entry.generation, "Release component generation"),
      identityHash: sha256(entry.identityHash, "Release component identity hash"),
    };
  });
  const byComponent = new Map(entries.map((entry) => [entry.component, entry]));
  if (byComponent.size !== entries.length) {
    throw new TypeError(
      "Release generation vector cannot contain duplicate components",
    );
  }
  return SOURCE_RELEASE_GENERATION_COMPONENTS.flatMap((component) => {
    const entry = byComponent.get(component);
    if (!entry) {
      if (OPTIONAL_RELEASE_GENERATION_COMPONENTS.has(component)) return [];
      throw new TypeError(`Release generation vector is missing ${component}`);
    }
    return [Object.freeze(entry)];
  });
}

async function validateStableInput(
  input: StableSourceReleaseInput,
): Promise<StableSourceReleaseInput> {
  if (input.derivationVersion !== SOURCE_RELEASE_DERIVATION_VERSION) {
    throw new TypeError("Source release derivation version is unsupported");
  }
  const recomputed = await computeSourceReleaseInput({
    sourceId: input.sourceId,
    coverageMode: input.coverageMode,
    generationVector: input.generationVector,
    acceptedCount: input.acceptedCount,
    preparedCount: input.preparedCount,
    incompleteCount: input.incompleteCount,
    acceptedSetHash: input.acceptedSetHash,
    preparedSetHash: input.preparedSetHash,
    incompleteSetHash: input.incompleteSetHash,
    aggregateProofHash: input.aggregateProofHash,
  });
  if (
    input.generationVectorHash !== recomputed.generationVectorHash ||
    input.releaseInputHash !== recomputed.releaseInputHash ||
    input.cacheVectorHash !== recomputed.cacheVectorHash
  ) {
    throw new TypeError("Source release input hashes do not match its exact evidence");
  }
  return recomputed;
}

function assertStateMatchesInput(
  state: SourceReleaseStateRecord,
  input: StableSourceReleaseInput,
): void {
  if (
    state.sourceId !== input.sourceId ||
    state.coverageMode !== input.coverageMode ||
    state.generationVectorHash !== input.generationVectorHash ||
    state.releaseInputHash !== input.releaseInputHash ||
    state.acceptedCount !== input.acceptedCount ||
    state.preparedCount !== input.preparedCount ||
    state.incompleteCount !== input.incompleteCount ||
    state.cacheVectorHash !== input.cacheVectorHash
  ) {
    throw new Error("Stored source release state contradicts the exact release input");
  }
}

function stateFromRow(row: SourceReleaseStateRow): SourceReleaseStateRecord {
  const sourceId = boundedText(row.source_id, "Stored source ID", 256);
  const coverageMode = validateCoverageMode(row.coverage_mode);
  const generationVectorHash = sha256(
    row.generation_vector_hash,
    "Stored generation vector hash",
  );
  const releaseInputHash = sha256(row.release_input_hash, "Stored release input hash");
  const releaseGeneration = positiveInteger(
    row.release_generation,
    "Stored release generation",
  );
  const acceptedCount = count(row.accepted_count, "Stored accepted count");
  const preparedCount = count(row.prepared_count, "Stored prepared count");
  const incompleteCount = count(row.incomplete_count, "Stored incomplete count");
  const releasedCount = count(row.released_count, "Stored released count");
  const state = validateState(row.state);
  const releaseProofId = optionalText(row.release_proof_id, "Stored release proof ID", 256);
  const cacheVectorHash = sha256(row.cache_vector_hash, "Stored cache vector hash");
  const invalidationReasonCode = optionalCode(
    row.invalidation_reason_code,
    "Stored invalidation reason code",
  );
  const updatedAt = boundedText(row.updated_at, "Stored release update time", 64);
  if (preparedCount + incompleteCount !== acceptedCount) {
    throw new Error("Stored source release counts do not partition accepted rows");
  }
  if (
    state === "released"
      ? incompleteCount !== 0 || releasedCount !== acceptedCount || releaseProofId === null
      : releasedCount !== 0
  ) {
    throw new Error("Stored source release state has inconsistent release counts");
  }
  return {
    sourceId,
    coverageMode,
    generationVectorHash,
    releaseInputHash,
    releaseGeneration,
    acceptedCount,
    preparedCount,
    incompleteCount,
    releasedCount,
    state,
    releaseProofId,
    cacheVectorHash,
    invalidationReasonCode,
    updatedAt,
  };
}

function proofFromRow(row: SourceReleaseProofRow): SourceReleaseProofRecord {
  const outcome = validateProofOutcome(row.outcome);
  const acceptedCount = count(row.accepted_count, "Stored proof accepted count");
  const preparedCount = count(row.prepared_count, "Stored proof prepared count");
  const incompleteCount = count(row.incomplete_count, "Stored proof incomplete count");
  const releasedCount = count(row.released_count, "Stored proof released count");
  if (preparedCount + incompleteCount !== acceptedCount) {
    throw new Error("Stored release proof counts do not partition accepted rows");
  }
  if (
    outcome === "released"
      ? incompleteCount !== 0 || releasedCount !== acceptedCount
      : releasedCount !== 0
  ) {
    throw new Error("Stored release proof has inconsistent release counts");
  }
  return {
    proofId: boundedText(row.proof_id, "Stored proof ID", 256),
    sourceId: boundedText(row.source_id, "Stored proof source ID", 256),
    coverageMode: validateCoverageMode(row.coverage_mode),
    generationVectorHash: sha256(
      row.generation_vector_hash,
      "Stored proof generation vector hash",
    ),
    releaseInputHash: sha256(row.release_input_hash, "Stored proof release input hash"),
    releaseGeneration: positiveInteger(
      row.release_generation,
      "Stored proof release generation",
    ),
    acceptedCount,
    preparedCount,
    incompleteCount,
    releasedCount,
    outcome,
    invalidationReasonCode: optionalCode(
      row.invalidation_reason_code,
      "Stored proof invalidation reason code",
    ),
    priorProofId: optionalText(row.prior_proof_id, "Stored prior proof ID", 256),
    completedAt: boundedText(row.completed_at, "Stored proof completion time", 64),
    derivationVersion: boundedText(
      row.derivation_version,
      "Stored proof derivation version",
      256,
    ),
  };
}

async function requiredSourceReleaseState(
  database: D1Database,
  sourceId: string,
): Promise<SourceReleaseStateRecord> {
  const state = await readSourceReleaseState(database, sourceId);
  if (state === null) throw new Error("Source release state does not exist");
  return state;
}

function readiness(
  state: SourceReleaseStateRecord,
  values: Omit<
    SourceReleaseReadiness,
    "sourceId" | "releaseGeneration" | "state" | "cacheVectorHash"
  >,
): SourceReleaseReadiness {
  return {
    sourceId: state.sourceId,
    releaseGeneration: state.releaseGeneration,
    state: state.state,
    cacheVectorHash: state.cacheVectorHash,
    ...values,
  };
}

function validateCoverageMode(value: unknown): SourceReleaseCoverageMode {
  if (value !== "complete_current" && value !== "discovery_frontier") {
    throw new TypeError("Source release coverage mode is invalid");
  }
  return value;
}

function validateState(value: unknown): SourceReleaseStateName {
  if (value !== "dirty" && value !== "withheld" && value !== "released") {
    throw new TypeError("Stored source release state is invalid");
  }
  return value;
}

function validateProofOutcome(value: unknown): SourceReleaseProofOutcome {
  if (value !== "invalidated" && value !== "withheld" && value !== "released") {
    throw new TypeError("Stored source release proof outcome is invalid");
  }
  return value;
}

function sha256(value: unknown, label: string): Sha256Identity {
  if (typeof value !== "string" || !SHA256_IDENTITY_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 identity`);
  }
  return value as Sha256Identity;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError(
      `${label} must be a trimmed nonempty string of at most ${maximumLength} characters`,
    );
  }
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  maximumLength: number,
): string | null {
  return value === null ? null : boundedText(value, label, maximumLength);
}

function safeCode(value: unknown, label: string): string {
  const code = boundedText(value, label, 128);
  if (!SAFE_CODE_PATTERN.test(code)) {
    throw new TypeError(`${label} contains unsupported characters`);
  }
  return code;
}

function optionalCode(value: unknown, label: string): string | null {
  return value === null ? null : safeCode(value, label);
}

function optionalBoundedText(value: unknown): string | null {
  return value === null ? null : boundedText(value, "Projected identity", 512);
}

function boundedJsonArray(value: unknown, label: string): readonly unknown[] {
  const serialized = boundedText(value, label, 8_192);
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError(`${label} must be valid JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length > 32) {
    throw new TypeError(`${label} must be a bounded JSON array`);
  }
  return Object.freeze(parsed);
}

function timestamp(value: Date | undefined): string {
  const date = value ?? new Date();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Release timestamp must be a valid Date");
  }
  return date.toISOString();
}
