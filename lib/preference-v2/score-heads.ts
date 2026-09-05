import {
  fingerprintGenerationInput,
  generationDomain,
  hashCanonicalJson,
  serializeCanonicalJson,
  type PipelineGenerationVector,
  type Sha256Identity,
} from "../performance/generations";
import type {
  PreferenceV2ScoreClaim,
  PreferenceV2ScoreCommitOutcome,
} from "./incremental-scoring";

export const PREFERENCE_V2_ACTIVE_SCORE_HEAD_DERIVATION_VERSION =
  "preference-v2-active-shadow-score-head-v1" as const;

/** Stable identity for the bounded Node/Python production scoring contract. */
export const ACTIVE_PREFERENCE_V2_SCORE_RUNTIME_IDENTITY =
  "preference-v2-incremental-current-runtime-v2" as const;

export type PreferenceV2ShadowScoreIdentity = `shadow-score-v2:${string}`;

export function preferenceV2ShadowScoreIdentity(
  value: string,
): PreferenceV2ShadowScoreIdentity {
  if (!/^shadow-score-v2:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("Preference V2 shadow score identity is invalid");
  }
  return value as PreferenceV2ShadowScoreIdentity;
}

const PREFERENCE_V2_HEAD_MUTATION_DERIVATION_VERSION =
  "preference-v2-active-score-head-mutation-v1" as const;

export interface PreferenceV2ImportedShadowScore {
  readonly listingId: string;
  readonly shadowScoreId: PreferenceV2ShadowScoreIdentity;
  readonly modelVersion: string;
  readonly featureVersion: string;
  readonly runtimeIdentity: string;
  readonly snapshotId: string;
  readonly snapshotHash: Sha256Identity;
  readonly scoringInputHash: Sha256Identity;
  readonly baselineScore: number;
  readonly intrinsicScore: number;
  readonly observedPreferenceScore: number;
  readonly actionabilityScore: number;
  readonly investigationScore: number;
  readonly finalScore: number;
  readonly uncertainty: number;
}

function changes(result: D1Result | undefined): number {
  const meta = result?.meta as Record<string, unknown> | undefined;
  const value = meta?.changes ?? meta?.changes_count;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function probability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be finite and between zero and one`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function vectorCurrentSql(): string {
  return `
    NOT EXISTS (
      SELECT 1
      FROM json_each(?) expected
      LEFT JOIN pipeline_generation_state current
        ON current.domain = json_extract(expected.value, '$.domain')
        AND current.scope_type = json_extract(expected.value, '$.scopeType')
        AND current.scope_id = json_extract(expected.value, '$.scopeId')
      WHERE current.domain IS NULL
        OR current.generation <> json_extract(expected.value, '$.generation')
        OR current.fingerprint <> json_extract(expected.value, '$.fingerprint')
        OR current.derivation_version <>
          json_extract(expected.value, '$.derivationVersion')
    )
  `;
}

function batchClaimsCurrentSql(): string {
  return `
    NOT EXISTS (
      SELECT 1
      FROM json_each(?) expected
      LEFT JOIN pipeline_work_items batch_work
        ON batch_work.stage = 'preference_v2_score'
        AND batch_work.subject_type = 'listing'
        AND batch_work.subject_id = json_extract(expected.value, '$.listingId')
      WHERE batch_work.subject_id IS NULL
        OR batch_work.lease_owner <> json_extract(expected.value, '$.owner')
        OR batch_work.claimed_input_hash <>
          json_extract(expected.value, '$.inputHash')
        OR batch_work.claimed_revision <>
          json_extract(expected.value, '$.revision')
        OR batch_work.input_hash <> json_extract(expected.value, '$.inputHash')
        OR batch_work.revision <> json_extract(expected.value, '$.revision')
    )
  `;
}

function batchScoresCurrentSql(): string {
  return `
    NOT EXISTS (
      SELECT 1
      FROM json_each(?) expected
      LEFT JOIN preference_shadow_scores_v2 shadow
        ON shadow.shadow_score_id = json_extract(expected.value, '$.shadowScoreId')
        AND shadow.listing_id = json_extract(expected.value, '$.listingId')
      WHERE shadow.shadow_score_id IS NULL
        OR shadow.model_version <> json_extract(expected.value, '$.modelVersion')
        OR shadow.feature_version <> json_extract(expected.value, '$.featureVersion')
        OR shadow.snapshot_id <> json_extract(expected.value, '$.snapshotId')
        OR shadow.snapshot_hash <> json_extract(expected.value, '$.snapshotHash')
        OR shadow.baseline_score <> json_extract(expected.value, '$.baselineScore')
        OR shadow.intrinsic_score <> json_extract(expected.value, '$.intrinsicScore')
        OR shadow.observed_preference_score <>
          json_extract(expected.value, '$.observedPreferenceScore')
        OR shadow.actionability_score <>
          json_extract(expected.value, '$.actionabilityScore')
        OR shadow.investigation_score <>
          json_extract(expected.value, '$.investigationScore')
        OR shadow.final_score <> json_extract(expected.value, '$.finalScore')
        OR shadow.uncertainty <> json_extract(expected.value, '$.uncertainty')
        OR shadow.promotion_state <> 'shadow_only_pending_prospective'
    )
  `;
}

function batchHeadsCurrentSql(): string {
  return `
    NOT EXISTS (
      SELECT 1
      FROM json_each(?) expected
      LEFT JOIN preference_v2_active_score_heads head
        ON head.listing_id = json_extract(expected.value, '$.listingId')
      WHERE head.listing_id IS NULL
        OR head.head_identity <> json_extract(expected.value, '$.headIdentity')
    )
  `;
}

function scoreHeadGenerationStatement(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly headIdentity: Sha256Identity;
  readonly fingerprint: Sha256Identity;
  readonly nowIso: string;
  readonly batchClaimsJson: string;
  readonly expectedHeadsJson: string;
  readonly generationVectorJson: string;
}): D1PreparedStatement {
  return input.database.prepare(`
    INSERT INTO pipeline_generation_state (
      domain, scope_type, scope_id, generation, fingerprint,
      derivation_version, updated_at
    )
    SELECT 'preference_score_head', 'listing', ?, 1, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM preference_v2_active_score_heads head
      WHERE head.listing_id = ? AND head.head_identity = ?
    )
      AND ${batchClaimsCurrentSql()}
      AND ${batchHeadsCurrentSql()}
      AND ${vectorCurrentSql()}
    ON CONFLICT(domain, scope_type, scope_id) DO UPDATE SET
      generation = pipeline_generation_state.generation + 1,
      fingerprint = excluded.fingerprint,
      derivation_version = excluded.derivation_version,
      updated_at = excluded.updated_at
    WHERE pipeline_generation_state.fingerprint <> excluded.fingerprint
      OR pipeline_generation_state.derivation_version <>
        excluded.derivation_version
  `).bind(
    input.listingId,
    input.fingerprint,
    PREFERENCE_V2_HEAD_MUTATION_DERIVATION_VERSION,
    input.nowIso,
    input.listingId,
    input.headIdentity,
    input.batchClaimsJson,
    input.expectedHeadsJson,
    input.generationVectorJson,
  );
}

async function scoreHeadRefreshStatement(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly sourceId: string;
  readonly headIdentity: Sha256Identity;
  readonly fingerprint: Sha256Identity;
  readonly nowIso: string;
  readonly batchClaimsJson: string;
  readonly expectedHeadsJson: string;
  readonly generationVectorJson: string;
}): Promise<D1PreparedStatement> {
  const workInputHash = await hashCanonicalJson({
    stage: "projection_listing_refresh",
    listingId: input.listingId,
    domain: "preference_score_head",
    fingerprint: input.fingerprint,
    headIdentity: input.headIdentity,
    derivationVersion: PREFERENCE_V2_HEAD_MUTATION_DERIVATION_VERSION,
  });
  const payload = serializeCanonicalJson({
    scopeType: "listing",
    generationKeys: [{
      domain: "preference_score_head",
      scopeType: "listing",
      scopeId: input.listingId,
      fingerprint: input.fingerprint,
      derivationVersion: PREFERENCE_V2_HEAD_MUTATION_DERIVATION_VERSION,
    }],
  });
  return input.database.prepare(`
    INSERT INTO pipeline_work_items (
      stage, subject_type, subject_id, listing_id, source_id,
      subject_payload_json, lane_key, input_hash, revision, priority,
      reason_code, available_at, created_at, updated_at
    )
    SELECT 'projection_listing_refresh', 'listing', ?, ?, ?,
      json_set(json(?), '$.targetGeneration', generation.generation),
      ?, ?, 1, 700, 'preference_score_head_changed', ?, ?, ?
    FROM pipeline_generation_state generation
    WHERE generation.domain = 'preference_score_head'
      AND generation.scope_type = 'listing' AND generation.scope_id = ?
      AND generation.fingerprint = ?
      AND generation.derivation_version = ?
      AND generation.updated_at = ?
      AND EXISTS (
        SELECT 1 FROM preference_v2_active_score_heads head
        WHERE head.listing_id = ? AND head.head_identity = ?
      )
      AND ${batchClaimsCurrentSql()}
      AND ${batchHeadsCurrentSql()}
      AND ${vectorCurrentSql()}
    ON CONFLICT(stage, subject_type, subject_id) DO UPDATE SET
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
    input.listingId,
    input.listingId,
    input.sourceId,
    payload,
    input.sourceId,
    workInputHash,
    input.nowIso,
    input.nowIso,
    input.nowIso,
    input.listingId,
    input.fingerprint,
    PREFERENCE_V2_HEAD_MUTATION_DERIVATION_VERSION,
    input.nowIso,
    input.listingId,
    input.headIdentity,
    input.batchClaimsJson,
    input.expectedHeadsJson,
    input.generationVectorJson,
  );
}

async function scoreHeadIdentity(input: {
  readonly row: PreferenceV2ImportedShadowScore;
  readonly generationVectorHash: Sha256Identity;
}): Promise<Sha256Identity> {
  return hashCanonicalJson({
    version: PREFERENCE_V2_ACTIVE_SCORE_HEAD_DERIVATION_VERSION,
    listingId: input.row.listingId,
    shadowScoreId: input.row.shadowScoreId,
    modelVersion: input.row.modelVersion,
    featureVersion: input.row.featureVersion,
    runtimeIdentity: input.row.runtimeIdentity,
    snapshotId: input.row.snapshotId,
    snapshotHash: input.row.snapshotHash,
    scoringInputHash: input.row.scoringInputHash,
    baselineScore: input.row.baselineScore,
    intrinsicScore: input.row.intrinsicScore,
    observedPreferenceScore: input.row.observedPreferenceScore,
    actionabilityScore: input.row.actionabilityScore,
    investigationScore: input.row.investigationScore,
    finalScore: input.row.finalScore,
    uncertainty: input.row.uncertainty,
    generationVectorHash: input.generationVectorHash,
  });
}

/**
 * Atomically binds immutable accepted shadow rows and exact-deletes only their
 * still-current desired/claimed revisions. Generation, data-version, or queue
 * revision races retain the shadow row as history and do not advance a head.
 */
export async function bindPreferenceV2ActiveScoreHeadsAndCompleteClaims(input: {
  readonly database: D1Database;
  readonly generationVector: PipelineGenerationVector;
  readonly databaseBoundary: string;
  readonly dataVersion: number;
  readonly dataVersionStable: boolean;
  readonly claims: readonly PreferenceV2ScoreClaim[];
  readonly scores: readonly PreferenceV2ImportedShadowScore[];
  readonly now?: Date;
}): Promise<readonly PreferenceV2ScoreCommitOutcome[]> {
  if (!input.dataVersionStable) {
    throw new Error("Preference V2 data_version changed before active score-head commit");
  }
  if (!input.databaseBoundary.trim() || input.databaseBoundary !== input.databaseBoundary.trim()) {
    throw new TypeError("Preference V2 database boundary is invalid");
  }
  if (!Number.isSafeInteger(input.dataVersion) || input.dataVersion < 0) {
    throw new TypeError("Preference V2 data_version boundary is invalid");
  }
  if (
    input.claims.length < 1 || input.claims.length > 10 ||
    input.claims.length !== input.scores.length
  ) {
    throw new RangeError("Preference V2 active score-head commit requires 1-10 paired rows");
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("score-head commit time is invalid");
  const nowIso = now.toISOString();
  const claimIds = new Set(input.claims.map((claim) => claim.listingId));
  if (claimIds.size !== input.claims.length) {
    throw new TypeError("Preference V2 active score-head batch repeats a listing");
  }
  const batchClaimsJson = serializeCanonicalJson(input.claims.map((claim) => ({
    listingId: claim.listingId,
    owner: claim.owner,
    inputHash: claim.inputHash,
    revision: claim.revision,
  })));
  const plans: {
    readonly claim: PreferenceV2ScoreClaim;
    readonly score: PreferenceV2ImportedShadowScore;
    readonly sourceId: string;
    readonly headIdentity: Sha256Identity;
    readonly generationFingerprint: Sha256Identity;
    readonly headChanged: boolean;
  }[] = [];
  for (let index = 0; index < input.claims.length; index += 1) {
    const claim = input.claims[index]!;
    const score = input.scores[index]!;
    if (claim.listingId !== score.listingId || claim.inputHash !== score.scoringInputHash) {
      throw new Error(`Preference V2 active score-head input disagrees for ${claim.listingId}`);
    }
    if (score.runtimeIdentity !== ACTIVE_PREFERENCE_V2_SCORE_RUNTIME_IDENTITY) {
      throw new Error(`Preference V2 score runtime is not accepted for ${claim.listingId}`);
    }
    preferenceV2ShadowScoreIdentity(score.shadowScoreId);
    for (const [field, value] of Object.entries({
      baselineScore: score.baselineScore,
      intrinsicScore: score.intrinsicScore,
      observedPreferenceScore: score.observedPreferenceScore,
      actionabilityScore: score.actionabilityScore,
      investigationScore: score.investigationScore,
      finalScore: score.finalScore,
      uncertainty: score.uncertainty,
    })) probability(value, `${field} for ${score.listingId}`);
    const headIdentity = await scoreHeadIdentity({
      row: score,
      generationVectorHash: input.generationVector.hash,
    });
    const context = await input.database.prepare(`
      SELECT stub.source_id, head.head_identity
      FROM listing_stubs stub
      LEFT JOIN preference_v2_active_score_heads head
        ON head.listing_id = stub.id
      WHERE stub.id = ?
    `).bind(score.listingId).first<{
      source_id: string;
      head_identity: string | null;
    }>();
    if (!context?.source_id) {
      throw new Error(`Preference V2 listing ${score.listingId} is missing`);
    }
    const generationFingerprint = await fingerprintGenerationInput({
      domain: generationDomain("preference_score_head"),
      derivationVersion: PREFERENCE_V2_HEAD_MUTATION_DERIVATION_VERSION,
      input: { listingId: score.listingId, headIdentity },
    });
    plans.push(Object.freeze({
      claim,
      score,
      sourceId: context.source_id,
      headIdentity,
      generationFingerprint,
      headChanged: context.head_identity !== headIdentity,
    }));
  }
  const batchScoresJson = serializeCanonicalJson(plans.map(({ score }) => ({
    listingId: score.listingId,
    shadowScoreId: score.shadowScoreId,
    modelVersion: score.modelVersion,
    featureVersion: score.featureVersion,
    snapshotId: score.snapshotId,
    snapshotHash: score.snapshotHash,
    baselineScore: score.baselineScore,
    intrinsicScore: score.intrinsicScore,
    observedPreferenceScore: score.observedPreferenceScore,
    actionabilityScore: score.actionabilityScore,
    investigationScore: score.investigationScore,
    finalScore: score.finalScore,
    uncertainty: score.uncertainty,
  })));
  const expectedHeadsJson = serializeCanonicalJson(plans.map((plan) => ({
    listingId: plan.claim.listingId,
    headIdentity: plan.headIdentity,
  })));
  const statements: D1PreparedStatement[] = [];

  // Every head insert is guarded by the complete batch's claims, immutable
  // imported rows, and generation vector. A partial valid batch therefore
  // cannot advance even one active head.
  for (const plan of plans) {
    const { claim, score, headIdentity } = plan;
    statements.push(
      input.database.prepare(`
        INSERT INTO preference_v2_active_score_heads (
          listing_id, shadow_score_id, model_version, feature_version,
          runtime_identity, snapshot_id, snapshot_hash, scoring_input_hash,
          baseline_score, intrinsic_score, observed_preference_score,
          actionability_score, investigation_score, final_score, uncertainty,
          generation_vector_hash, database_boundary, data_version,
          head_identity, generation, derivation_version, updated_at
        )
        SELECT shadow.listing_id, shadow.shadow_score_id,
          shadow.model_version, shadow.feature_version,
          ?, shadow.snapshot_id, shadow.snapshot_hash, ?,
          shadow.baseline_score, shadow.intrinsic_score,
          shadow.observed_preference_score, shadow.actionability_score,
          shadow.investigation_score, shadow.final_score, shadow.uncertainty,
          ?, ?, ?, ?, 1, ?, ?
        FROM preference_shadow_scores_v2 shadow
        WHERE shadow.shadow_score_id = ? AND shadow.listing_id = ?
          AND shadow.model_version = ? AND shadow.feature_version = ?
          AND shadow.snapshot_id = ? AND shadow.snapshot_hash = ?
          AND shadow.baseline_score = ? AND shadow.intrinsic_score = ?
          AND shadow.observed_preference_score = ?
          AND shadow.actionability_score = ?
          AND shadow.investigation_score = ? AND shadow.final_score = ?
          AND shadow.uncertainty = ?
          AND shadow.promotion_state = 'shadow_only_pending_prospective'
          AND EXISTS (
            SELECT 1 FROM pipeline_work_items work
            WHERE work.stage = 'preference_v2_score'
              AND work.subject_type = 'listing' AND work.subject_id = ?
              AND work.lease_owner = ?
              AND work.claimed_input_hash = ? AND work.claimed_revision = ?
              AND work.input_hash = ? AND work.revision = ?
          )
          AND ${batchClaimsCurrentSql()}
          AND ${batchScoresCurrentSql()}
          AND ${vectorCurrentSql()}
        ON CONFLICT(listing_id) DO UPDATE SET
          shadow_score_id = excluded.shadow_score_id,
          model_version = excluded.model_version,
          feature_version = excluded.feature_version,
          runtime_identity = excluded.runtime_identity,
          snapshot_id = excluded.snapshot_id,
          snapshot_hash = excluded.snapshot_hash,
          scoring_input_hash = excluded.scoring_input_hash,
          baseline_score = excluded.baseline_score,
          intrinsic_score = excluded.intrinsic_score,
          observed_preference_score = excluded.observed_preference_score,
          actionability_score = excluded.actionability_score,
          investigation_score = excluded.investigation_score,
          final_score = excluded.final_score,
          uncertainty = excluded.uncertainty,
          generation_vector_hash = excluded.generation_vector_hash,
          database_boundary = excluded.database_boundary,
          data_version = excluded.data_version,
          head_identity = excluded.head_identity,
          generation = preference_v2_active_score_heads.generation + 1,
          derivation_version = excluded.derivation_version,
          updated_at = excluded.updated_at
        WHERE preference_v2_active_score_heads.head_identity <> excluded.head_identity
      `).bind(
        score.runtimeIdentity,
        score.scoringInputHash,
        input.generationVector.hash,
        input.databaseBoundary,
        input.dataVersion,
        headIdentity,
        PREFERENCE_V2_ACTIVE_SCORE_HEAD_DERIVATION_VERSION,
        nowIso,
        score.shadowScoreId,
        score.listingId,
        score.modelVersion,
        score.featureVersion,
        score.snapshotId,
        score.snapshotHash,
        score.baselineScore,
        score.intrinsicScore,
        score.observedPreferenceScore,
        score.actionabilityScore,
        score.investigationScore,
        score.finalScore,
        score.uncertainty,
        claim.listingId,
        claim.owner,
        claim.inputHash,
        claim.revision,
        claim.inputHash,
        claim.revision,
        batchClaimsJson,
        batchScoresJson,
        input.generationVector.canonicalJson,
      ),
    );
  }

  // Derived generation and refresh writes follow only after every desired
  // head is observable. They still share the same transactional D1 batch.
  for (const plan of plans) {
    if (!plan.headChanged) continue;
    statements.push(scoreHeadGenerationStatement({
      database: input.database,
      listingId: plan.claim.listingId,
      headIdentity: plan.headIdentity,
      fingerprint: plan.generationFingerprint,
      nowIso,
      batchClaimsJson,
      expectedHeadsJson,
      generationVectorJson: input.generationVector.canonicalJson,
    }));
    statements.push(await scoreHeadRefreshStatement({
      database: input.database,
      listingId: plan.claim.listingId,
      sourceId: plan.sourceId,
      headIdentity: plan.headIdentity,
      fingerprint: plan.generationFingerprint,
      nowIso,
      batchClaimsJson,
      expectedHeadsJson,
      generationVectorJson: input.generationVector.canonicalJson,
    }));
  }

  const completionResultIndex = statements.length;
  statements.push(input.database.prepare(`
    DELETE FROM pipeline_work_items
    WHERE stage = 'preference_v2_score' AND subject_type = 'listing'
      AND EXISTS (
        SELECT 1 FROM json_each(?) expected
        WHERE subject_id = json_extract(expected.value, '$.listingId')
          AND lease_owner = json_extract(expected.value, '$.owner')
          AND claimed_input_hash = json_extract(expected.value, '$.inputHash')
          AND claimed_revision = json_extract(expected.value, '$.revision')
          AND input_hash = json_extract(expected.value, '$.inputHash')
          AND revision = json_extract(expected.value, '$.revision')
      )
      AND ${batchClaimsCurrentSql()}
      AND ${batchHeadsCurrentSql()}
      AND ${vectorCurrentSql()}
  `).bind(
    batchClaimsJson,
    batchClaimsJson,
    expectedHeadsJson,
    input.generationVector.canonicalJson,
  ));

  // Claims that lost a desired-input or generation race are released without
  // deleting their newer desired work.
  statements.push(input.database.prepare(`
    UPDATE pipeline_work_items
    SET lease_owner = NULL, lease_expires_at = NULL,
      claimed_input_hash = NULL, claimed_revision = NULL,
      available_at = ?, updated_at = ?
    WHERE stage = 'preference_v2_score' AND subject_type = 'listing'
      AND EXISTS (
        SELECT 1 FROM json_each(?) expected
        WHERE subject_id = json_extract(expected.value, '$.listingId')
          AND lease_owner = json_extract(expected.value, '$.owner')
          AND claimed_input_hash = json_extract(expected.value, '$.inputHash')
          AND claimed_revision = json_extract(expected.value, '$.revision')
      )
  `).bind(nowIso, nowIso, batchClaimsJson));

  const results = await input.database.batch(statements);
  const committed = changes(results[completionResultIndex]) === input.claims.length;
  return Object.freeze(input.claims.map((claim) => ({
    listingId: claim.listingId,
    outcome: committed ? "bound_current" as const : "historical_stale" as const,
  })));
}
