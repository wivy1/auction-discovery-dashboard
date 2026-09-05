import {
  advancePipelineGeneration,
  fingerprintGenerationInput,
  generationDomain,
  generationKey,
  generationScope,
  hashCanonicalJson,
  readPipelineGenerationVector,
  serializeCanonicalJson,
  type GenerationKey,
  type PipelineGenerationState,
  type PipelineGenerationVector,
} from "../performance/generations";
import { createSequentialEnrichmentProviders } from "../ai";
import { enrichmentSessionProvenanceTarget } from "../enrichment/target";
import { listingReviewCompletedSql } from "../review-completion";
import {
  LOCAL_PROXIMITY_DATASET_IDENTITY,
  LOCAL_PROXIMITY_ESTIMATOR_VERSION,
  LOCAL_PROXIMITY_NORMALIZATION_VERSION,
  LOCAL_PROXIMITY_PROVIDER_NAME,
} from "../routing/local-proximity";
import {
  CURRENT_PIPELINE_PROJECTION_DERIVATION_VERSION,
  OPERATIONAL_OWNERSHIP_DERIVATION_VERSION,
} from "./operational-projection";
import {
  prepareCanonicalMutationPayloadGenerationStatements,
  prepareCanonicalMutationPayloadInvalidationStatements,
} from "./mutation-invalidation";

export const GENERATION_RECONCILIATION_DERIVATION_VERSION =
  "pipeline-generation-reconciliation-v2" as const;

const DEPLOYED_ENRICHMENT_TARGET_SCOPE = "deployed";
const DEPLOYED_ENRICHMENT_TARGET_DERIVATION_VERSION =
  `${GENERATION_RECONCILIATION_DERIVATION_VERSION}:deployed_enrichment_target`;
const MAX_ENRICHMENT_TARGET_TRANSITION_LISTINGS = 4_096;

export interface GenerationReconciliationContracts {
  readonly enrichmentTargetIdentity: string;
  readonly preferenceContractIdentity: string;
  readonly presentationPolicyIdentity: string;
}

export interface GenerationReconciliationResult {
  readonly states: readonly PipelineGenerationState[];
  readonly vector: PipelineGenerationVector;
  readonly changedCount: number;
}

type Row = Record<string, unknown>;

function ownershipDerivationInput() {
  return Object.freeze({
    ownership: OPERATIONAL_OWNERSHIP_DERIVATION_VERSION,
    current: CURRENT_PIPELINE_PROJECTION_DERIVATION_VERSION,
  });
}

/**
 * Registers durable projection refreshes when a deployed projection contract
 * changes. Enrichment target transitions fan out only exact-current terminal
 * review candidates; the durable target generation makes same-target repeats
 * no-ops. Ordinary source-to-preparation transition invokes this before it can
 * expose maintenance work.
 */
export async function reconcileCurrentOperationalProjectionContract(input: {
  readonly database: D1Database;
  readonly now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const ownershipStatements = await prepareCanonicalMutationPayloadInvalidationStatements({
    database: input.database,
    generations: [{
      domain: "ownership_derivation",
      scopeType: "global",
      scopeId: "all",
      input: ownershipDerivationInput(),
      derivationVersion:
        `${GENERATION_RECONCILIATION_DERIVATION_VERSION}:ownership_derivation`,
    }],
    refresh: {
      target: { type: "global", scopeId: "all" },
      reasonCode: "projection_contract_changed",
      priority: 1_000,
    },
    aggregateGlobalDomains: false,
    now,
  });
  const enrichmentTarget = await enrichmentSessionProvenanceTarget(
    createSequentialEnrichmentProviders(),
  );
  const targetGenerationInput = Object.freeze({
    targetIdentity: enrichmentTarget.identity,
  });
  const targetFingerprint = await fingerprintGenerationInput({
    domain: generationDomain("enrichment_target"),
    derivationVersion: DEPLOYED_ENRICHMENT_TARGET_DERIVATION_VERSION,
    input: targetGenerationInput,
  });
  const targetGenerationStatements =
    await prepareCanonicalMutationPayloadGenerationStatements({
      database: input.database,
      generations: [{
        domain: "enrichment_target",
        scopeType: "global",
        scopeId: DEPLOYED_ENRICHMENT_TARGET_SCOPE,
        input: targetGenerationInput,
        derivationVersion: DEPLOYED_ENRICHMENT_TARGET_DERIVATION_VERSION,
      }],
      aggregateGlobalDomains: false,
      now,
    });
  if (targetGenerationStatements.length === 0) {
    if (ownershipStatements.length > 0) {
      await input.database.batch([...ownershipStatements]);
    }
    return;
  }
  const priorTarget = await input.database.prepare(`
    SELECT fingerprint, derivation_version
    FROM pipeline_generation_state
    WHERE domain = 'enrichment_target' AND scope_type = 'global'
      AND scope_id = ?
  `).bind(DEPLOYED_ENRICHMENT_TARGET_SCOPE).first<{
    fingerprint: string;
    derivation_version: string;
  }>();
  const targetChanged = priorTarget?.fingerprint !== targetFingerprint ||
    priorTarget.derivation_version !== DEPLOYED_ENRICHMENT_TARGET_DERIVATION_VERSION;
  if (!targetChanged) {
    if (ownershipStatements.length > 0) {
      await input.database.batch([...ownershipStatements]);
    }
    return;
  }
  const affected = await input.database.prepare(`
    SELECT count(*) AS count
    FROM listing_current_pipeline_state pipeline
    JOIN listing_enrichment_heads head ON head.listing_id = pipeline.listing_id
      AND head.head_identity = pipeline.enrichment_head_identity
      AND head.enrichment_input_hash = pipeline.enrichment_input_hash
    WHERE pipeline.source_current = 1 AND pipeline.review_candidate = 1
      AND head.state = 'terminal'
      AND head.provenance_target_identity <> ?
      AND NOT ${listingReviewCompletedSql("pipeline.listing_id")}
  `).bind(enrichmentTarget.identity).first<{ count: number }>();
  const affectedCount = Number(affected?.count ?? 0);
  if (
    !Number.isSafeInteger(affectedCount) || affectedCount < 0 ||
    affectedCount > MAX_ENRICHMENT_TARGET_TRANSITION_LISTINGS
  ) {
    throw new RangeError(
      "deployed enrichment target transition exceeds its bounded listing fan-out",
    );
  }
  const targetGenerationPayload = serializeCanonicalJson({
    scopeType: "listing",
    generationKeys: [{
      domain: "enrichment_target",
      scopeType: "global",
      scopeId: DEPLOYED_ENRICHMENT_TARGET_SCOPE,
      fingerprint: targetFingerprint,
      derivationVersion: DEPLOYED_ENRICHMENT_TARGET_DERIVATION_VERSION,
    }],
  });
  const refreshInputHash = await hashCanonicalJson({
    reason: "enrichment_target_changed",
    targetFingerprint,
    derivationVersion: DEPLOYED_ENRICHMENT_TARGET_DERIVATION_VERSION,
  });
  const nowIso = now.toISOString();
  const targetRefreshStatement = input.database.prepare(`
    INSERT INTO pipeline_work_items (
      stage, subject_type, subject_id, listing_id, source_id,
      subject_payload_json, lane_key, input_hash, revision, priority,
      reason_code, available_at, created_at, updated_at
    )
    SELECT 'projection_listing_refresh', 'listing', pipeline.listing_id,
      pipeline.listing_id, pipeline.source_id,
      json_set(json(?), '$.targetGeneration', target_generation.generation),
      pipeline.source_id, ?, 1, 650, 'enrichment_target_changed', ?, ?, ?
    FROM listing_current_pipeline_state pipeline
    JOIN listing_enrichment_heads head ON head.listing_id = pipeline.listing_id
      AND head.head_identity = pipeline.enrichment_head_identity
      AND head.enrichment_input_hash = pipeline.enrichment_input_hash
    JOIN pipeline_generation_state target_generation
      ON target_generation.domain = 'enrichment_target'
      AND target_generation.scope_type = 'global'
      AND target_generation.scope_id = ?
      AND target_generation.fingerprint = ?
      AND target_generation.derivation_version = ?
      AND target_generation.updated_at = ?
    WHERE pipeline.source_current = 1 AND pipeline.review_candidate = 1
      AND head.state = 'terminal'
      AND head.provenance_target_identity <> ?
      AND NOT ${listingReviewCompletedSql("pipeline.listing_id")}
    ORDER BY pipeline.listing_id
    LIMIT ?
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
    targetGenerationPayload,
    refreshInputHash,
    nowIso,
    nowIso,
    nowIso,
    DEPLOYED_ENRICHMENT_TARGET_SCOPE,
    targetFingerprint,
    DEPLOYED_ENRICHMENT_TARGET_DERIVATION_VERSION,
    nowIso,
    enrichmentTarget.identity,
    MAX_ENRICHMENT_TARGET_TRANSITION_LISTINGS,
  );
  await input.database.batch([
    ...ownershipStatements,
    ...targetGenerationStatements,
    ...(affectedCount === 0 ? [] : [targetRefreshStatement]),
  ]);
}

async function orderedRows(
  database: D1Database,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<readonly Row[]> {
  const result = await database.prepare(sql).bind(...bindings).all<Row>();
  return Object.freeze((result.results ?? []).map((row) => Object.freeze({ ...row })));
}

async function advance(input: {
  readonly database: D1Database;
  readonly domain: string;
  readonly scopeType: "source" | "group" | "global";
  readonly scopeId: string;
  readonly canonicalInput: unknown;
}): Promise<PipelineGenerationState> {
  const domain = generationDomain(input.domain);
  const scope = generationScope(input.scopeType, input.scopeId);
  const derivationVersion = `${GENERATION_RECONCILIATION_DERIVATION_VERSION}:${input.domain}`;
  const fingerprint = await fingerprintGenerationInput({
    domain,
    derivationVersion,
    input: input.canonicalInput,
  });
  return advancePipelineGeneration(input.database, {
    ...generationKey(domain, scope),
    fingerprint,
    derivationVersion,
  });
}

function globalKey(domain: string): GenerationKey<"global"> {
  return generationKey(generationDomain(domain), generationScope("global", "all"));
}

/**
 * Explicit rebuild/audit oracle. It reads complete ordered canonical inputs;
 * routine mutation paths advance the same scopes without running these scans.
 */
export async function reconcileCanonicalPipelineGenerations(input: {
  readonly database: D1Database;
  readonly contracts: GenerationReconciliationContracts;
}): Promise<GenerationReconciliationResult> {
  const before = await input.database.prepare(`
    SELECT domain, scope_type, scope_id, generation, fingerprint
    FROM pipeline_generation_state
  `).all<Row>();
  const prior = new Map((before.results ?? []).map((row) => [
    `${row.domain}\u0000${row.scope_type}\u0000${row.scope_id}`,
    `${row.generation}\u0000${row.fingerprint}`,
  ]));
  const states: PipelineGenerationState[] = [];
  const vectorKeys: GenerationKey[] = [];
  const sources = await orderedRows(input.database, `
    SELECT source.id AS source_id, head.inventory_run_id,
      publication.listing_count, publication.collection_counts_json
    FROM auction_sources source
    LEFT JOIN source_inventory_publication_heads head ON head.source_id = source.id
    LEFT JOIN source_inventory_publications publication
      ON publication.source_id = head.source_id
      AND publication.inventory_run_id = head.inventory_run_id
    ORDER BY source.id
  `);
  const sourceAggregate: unknown[] = [];
  for (const source of sources) {
    const sourceId = String(source.source_id);
    const publication = await advance({
      database: input.database,
      domain: "source_publication",
      scopeType: "source",
      scopeId: sourceId,
      canonicalInput: source,
    });
    const members = await orderedRows(input.database, `
      SELECT current.listing_id, current.inventory_run_id,
        current.review_candidate, stub.content_hash
      FROM source_current_listings current
      JOIN listing_stubs stub ON stub.id = current.listing_id
      JOIN source_inventory_publication_heads head
        ON head.source_id = current.source_id
        AND head.inventory_run_id = current.inventory_run_id
      WHERE current.source_id = ?
      ORDER BY current.listing_id
    `, [sourceId]);
    const membership = await advance({
      database: input.database,
      domain: "source_current_membership",
      scopeType: "source",
      scopeId: sourceId,
      canonicalInput: members,
    });
    states.push(publication, membership);
    vectorKeys.push(
      generationKey(generationDomain("source_publication"), generationScope("source", sourceId)),
      generationKey(generationDomain("source_current_membership"), generationScope("source", sourceId)),
    );
    sourceAggregate.push({
      sourceId,
      publication: publication.fingerprint,
      membership: membership.fingerprint,
    });
  }

  const representatives = await orderedRows(input.database, `
    SELECT platform, host, event_or_catalog_id, lot_id, owner_listing_id
    FROM upstream_lot_representatives
    ORDER BY platform, host, event_or_catalog_id, lot_id
  `);
  const upstreamAliasObservations = await orderedRows(input.database, `
    SELECT platform, host, event_or_catalog_id, lot_id, listing_id,
      observed_canonical_url, content_hash
    FROM listing_upstream_alias_observations
    ORDER BY platform, host, event_or_catalog_id, lot_id,
      listing_id, observed_canonical_url
  `);
  const upstreamProvenance = await orderedRows(input.database, `
    SELECT platform, host, event_or_catalog_id, lot_id, listing_id,
      content_hash
    FROM listing_upstream_provenance
    ORDER BY platform, host, event_or_catalog_id, lot_id, listing_id
  `);
  const upstreamByScope = new Map<string, {
    readonly tuple: {
      readonly platform: string;
      readonly host: string;
      readonly eventOrCatalogId: string;
      readonly lotId: string;
    };
    representative: Row | null;
    aliasObservations: Row[];
    provenance: Row[];
  }>();
  const upstreamGroup = (row: Row) => {
    const tuple = {
      platform: String(row.platform),
      host: String(row.host),
      eventOrCatalogId: String(row.event_or_catalog_id),
      lotId: String(row.lot_id),
    };
    const scopeId = JSON.stringify([
      "upstream_tuple",
      tuple.platform,
      tuple.host,
      tuple.eventOrCatalogId,
      tuple.lotId,
    ]);
    const group = upstreamByScope.get(scopeId) ?? {
      tuple,
      representative: null,
      aliasObservations: [],
      provenance: [],
    };
    upstreamByScope.set(scopeId, group);
    return { scopeId, group };
  };
  for (const representative of representatives) {
    upstreamGroup(representative).group.representative = representative;
  }
  for (const observation of upstreamAliasObservations) {
    upstreamGroup(observation).group.aliasObservations.push(observation);
  }
  for (const provenance of upstreamProvenance) {
    upstreamGroup(provenance).group.provenance.push(provenance);
  }
  const upstreamGroups = [...upstreamByScope.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([scopeId, group]) => ({
      scopeId,
      canonicalInput: {
        tuple: group.tuple,
        representative: group.representative,
        aliasObservations: group.aliasObservations,
        provenance: group.provenance,
      },
    }));
  for (const group of upstreamGroups) {
    states.push(await advance({
      database: input.database,
      domain: "upstream_representative",
      scopeType: "group",
      scopeId: group.scopeId,
      canonicalInput: group.canonicalInput,
    }));
  }
  states.push(await advance({
    database: input.database,
    domain: "upstream_representative",
    scopeType: "global",
    scopeId: "all",
    canonicalInput: upstreamGroups,
  }));
  vectorKeys.push(globalKey("upstream_representative"));

  const globalInputs: readonly {
    readonly domain: string;
    readonly input: unknown | (() => Promise<unknown>);
  }[] = [
    {
      domain: "ownership_derivation",
      input: ownershipDerivationInput(),
    },
    {
      domain: "active_origin",
      input: () => orderedRows(input.database, `
        SELECT origin_postal_code, origin_country FROM app_settings
        WHERE singleton = 1
      `),
    },
    {
      domain: "route_contract",
      input: {
        provider: LOCAL_PROXIMITY_PROVIDER_NAME,
        estimator: LOCAL_PROXIMITY_ESTIMATOR_VERSION,
        normalization: LOCAL_PROXIMITY_NORMALIZATION_VERSION,
        dataset: LOCAL_PROXIMITY_DATASET_IDENTITY,
      },
    },
    {
      domain: "accepted_detail_location",
      input: () => orderedRows(input.database, `
        SELECT detail.listing_id, detail.content_hash,
          detail.pickup_city, detail.pickup_state, detail.pickup_postal_code,
          detail.pickup_country_code, detail.pickup_evidence_source
        FROM listing_details detail
        JOIN listing_detail_observations observation
          ON observation.listing_id = detail.listing_id
          AND observation.detail_content_hash = detail.content_hash
        ORDER BY detail.listing_id
      `),
    },
    {
      domain: "factual_supplement",
      input: async () => ({
        deadlines: await orderedRows(input.database, `
          SELECT listing_id, detail_content_hash, deadline_at, basis
          FROM listing_action_deadlines ORDER BY listing_id
        `),
      }),
    },
    {
      domain: "image_local_primary",
      input: async () => ({
        images: await orderedRows(input.database, `
          SELECT listing_id, id, position, is_primary, source_url,
            download_status, local_path, content_hash
          FROM listing_images ORDER BY listing_id, position, id
        `),
        terminals: await orderedRows(input.database, `
          SELECT listing_id, origin_cache_key, state, stage, last_error_code
          FROM listing_recovery_status
          WHERE stage = 'image' ORDER BY listing_id, origin_cache_key
        `),
      }),
    },
    {
      domain: "enrichment_target",
      input: async () => ({
        target: input.contracts.enrichmentTargetIdentity,
        heads: await orderedRows(input.database, `
          SELECT listing_id, provenance_target_identity,
            enrichment_input_hash, state, head_identity
          FROM listing_enrichment_heads ORDER BY listing_id
        `),
      }),
    },
    {
      domain: "preference_contract",
      input: async () => ({
        contract: input.contracts.preferenceContractIdentity,
        activations: await orderedRows(input.database, `
          SELECT event_identity, sequence, event_type, candidate_artifact_hash,
            runtime_identity, deterministic_profile_version_id,
            profile_prior_hash
          FROM preference_model_activation_events ORDER BY sequence
        `),
        legacyHeads: await orderedRows(input.database, `
          SELECT listing_id, score_kind, snapshot_identity,
            scoring_input_hash, score_head_identity
          FROM listing_preference_score_heads ORDER BY listing_id
        `),
      }),
    },
    {
      domain: "physical_asset",
      input: () => orderedRows(input.database, `
        SELECT physical_asset_cluster_id, listing_id, edge_reason,
          edge_confidence, algorithm_version
        FROM physical_asset_cluster_members
        ORDER BY listing_id, physical_asset_cluster_id
      `),
    },
    {
      domain: "auction_event",
      input: () => orderedRows(input.database, `
        SELECT auction_event_block_id, listing_id, algorithm_version
        FROM auction_event_block_members
        ORDER BY listing_id, auction_event_block_id
      `),
    },
    {
      domain: "semantic_family",
      input: () => orderedRows(input.database, `
        SELECT semantic_family_id, listing_id, assignment_method,
          assignment_confidence, algorithm_version
        FROM semantic_family_members ORDER BY listing_id, semantic_family_id
      `),
    },
    {
      domain: "reviewed_history",
      input: async () => ({
        impressions: await orderedRows(input.database, `
          SELECT impression_id, schema_version, slate_candidate_id, slate_id,
            listing_id, physical_asset_cluster_id, auction_event_block_id,
            semantic_family_id, candidate_set_hash, model_version,
            feature_version, displayed_snapshot_id, displayed_snapshot_hash,
            displayed_at, visible_ms, recorded_at
          FROM listing_impressions
          ORDER BY impression_id
        `),
        activeScores: await orderedRows(input.database, `
          SELECT listing_id, model_version, feature_version, snapshot_id,
            snapshot_hash, promotion_state
          FROM preference_shadow_scores_v2
          WHERE promotion_state = 'shadow_only_pending_prospective'
          ORDER BY listing_id, model_version, feature_version, snapshot_id
        `),
      }),
    },
    {
      domain: "votes",
      input: () => orderedRows(input.database, `
        SELECT listing_id, value FROM listing_votes ORDER BY listing_id
      `),
    },
    {
      domain: "cohort",
      input: async () => ({
        cohorts: await orderedRows(input.database, `
          SELECT id, state, refresh_boundary, origin_cache_key,
            route_provider_name, selection_seed, selection_version,
            head_vector_hash
          FROM adhoc_review_cohorts ORDER BY id
        `),
        members: await orderedRows(input.database, `
          SELECT cohort_id, listing_id, source_id, inventory_run_id,
            basis, stable_selection_key, ordinal
          FROM adhoc_review_cohort_memberships
          ORDER BY cohort_id, ordinal
        `),
      }),
    },
    {
      domain: "presentation_policy",
      input: input.contracts.presentationPolicyIdentity,
    },
    {
      domain: "source_release_cache",
      input: () => orderedRows(input.database, `
        SELECT source_id, coverage_mode, generation_vector_hash,
          release_input_hash, release_generation, state, cache_vector_hash,
          release_proof_id
        FROM source_review_release_state ORDER BY source_id
      `),
    },
  ];
  for (const entry of globalInputs) {
    const canonicalInput = typeof entry.input === "function"
      ? await entry.input()
      : entry.input;
    states.push(await advance({
      database: input.database,
      domain: entry.domain,
      scopeType: "global",
      scopeId: "all",
      canonicalInput,
    }));
    vectorKeys.push(globalKey(entry.domain));
  }
  // A compact global source vector invalidates consumers that do not need the
  // individual source identities in their own input hash.
  const sourceAggregateState = await advance({
    database: input.database,
    domain: "source_current_membership",
    scopeType: "global",
    scopeId: "all",
    canonicalInput: sourceAggregate,
  });
  states.push(sourceAggregateState);
  vectorKeys.push(globalKey("source_current_membership"));

  const vector = await readPipelineGenerationVector(input.database, vectorKeys);
  let changedCount = 0;
  for (const state of states) {
    const identity = `${state.domain}\u0000${state.scopeType}\u0000${state.scopeId}`;
    if (prior.get(identity) !== `${state.generation}\u0000${state.fingerprint}`) {
      changedCount += 1;
    }
  }
  return Object.freeze({
    states: Object.freeze(states),
    vector,
    changedCount,
  });
}

export async function generationVectorIdentity(
  vector: PipelineGenerationVector,
): Promise<string> {
  return hashCanonicalJson({ entries: vector.entries, hash: vector.hash });
}



