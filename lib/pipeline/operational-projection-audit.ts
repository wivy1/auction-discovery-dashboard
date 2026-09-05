import { auditProjectionParity, type ProjectionParityAudit } from "./projection-audit";
import {
  LISTING_DOWNSTREAM_WORK_STAGES,
  materializeOperationalProjection,
  operationalProjectionAuditValue,
  readCanonicalOperationalProjectionRows,
  readOperationalProjectionCandidateIds,
  type OperationalProjectionContracts,
} from "./operational-projection";
import { locationCacheKey } from "../routing/helpers";

type Row = Record<string, unknown>;

export interface OperationalProjectionAuditResult extends ProjectionParityAudit {
  readonly batches: number;
  readonly durationMs: number;
}

/** Complete exact canonical/projection/desired-queue comparison. */
export async function auditOperationalProjection(input: {
  readonly database: D1Database;
  readonly contracts: OperationalProjectionContracts;
  readonly batchSize?: number;
}): Promise<OperationalProjectionAuditResult> {
  const started = performance.now();
  const batchSize = input.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 250) {
    throw new RangeError("operational projection audit batch size is invalid");
  }
  // Recovery rows use the established active-origin scope identity. The
  // estimator-versioned normalization key belongs in route input hashes and
  // must not be used to join canonical recovery state during parity audits.
  const originCacheKey = locationCacheKey({
    postalCode: input.contracts.originPostalCode,
    countryCode: input.contracts.originCountryCode ?? "US",
  });
  const canonicalRows: { id: string; value: unknown }[] = [];
  const expectedQueueRows: { id: string; value: unknown }[] = [];
  let cursor: string | null = null;
  let batches = 0;
  for (;;) {
    const listingIds = await readOperationalProjectionCandidateIds({
      database: input.database,
      scope: { type: "global", id: "all-operational-listings" },
      afterListingId: cursor,
      limit: batchSize,
    });
    if (listingIds.length === 0) break;
    const sourceRows = await readCanonicalOperationalProjectionRows({
      database: input.database,
      listingIds,
      originCacheKey,
    });
    const projections = await Promise.all(sourceRows.map((row) =>
      materializeOperationalProjection(row, input.contracts)
    ));
    for (const projection of projections) {
      canonicalRows.push({
        id: projection.state.listingId,
        value: operationalProjectionAuditValue(projection),
      });
      for (const item of projection.state.expectedWorkItems) {
        expectedQueueRows.push({
          id: `${item.stage}:listing:${projection.state.listingId}`,
          value: {
            inputHash: item.inputHash,
            laneKey: item.laneKey,
            sourceId: projection.state.sourceId,
          },
        });
      }
    }
    batches += 1;
    cursor = listingIds.at(-1) ?? null;
    if (listingIds.length < batchSize) break;
  }
  const projected = await input.database.prepare(`
    SELECT
      state.listing_id, state.source_id, state.source_current,
      state.active_inventory_run_id, state.source_publication_generation,
      state.source_coverage_mode, state.review_candidate, state.category_scope,
      ownership.actionable_owner_listing_id,
      ownership.actionable_owner_source_id, ownership.owner_state,
      ownership.owner_basis, ownership.owner_proof_hash,
      ownership.shared_group_identity, ownership.upstream_tuple_identity,
      ownership.counterpart_state,
      ownership.counterpart_owner_listing_id,
      ownership.counterpart_owner_source_id,
      ownership.counterpart_absence_proof_hash,
      state.ownership_input_hash, state.accepted_detail_identity,
      state.accepted_detail_hash, state.effective_location_input_hash,
      state.route_cache_identity, state.route_assignment_identity,
      state.route_input_hash, state.route_terminal_identity,
      state.factual_supplement_state, state.factual_supplement_input_hash,
      state.source_image_identity_hash, state.local_primary_state,
      state.image_input_hash, state.enrichment_head_identity,
      state.enrichment_input_hash, state.score_head_identity,
      state.score_snapshot_identity, state.score_input_hash,
      state.source_release_input_hash, state.projection_work_input_hash,
      state.relevant_generation_vector_hash,
      state.projection_derivation_version,
      ownership.derivation_version AS ownership_derivation_version
    FROM listing_current_pipeline_state state
    JOIN listing_operational_ownership ownership
      ON ownership.listing_id = state.listing_id
    ORDER BY state.listing_id
  `).all<Row>();
  const projectionRows = (projected.results ?? []).map((row) => ({
    id: String(row.listing_id),
    value: {
      listingId: row.listing_id,
      sourceId: row.source_id,
      sourceCurrent: Number(row.source_current) === 1,
      activeInventoryRunId: row.active_inventory_run_id,
      sourcePublicationGeneration: row.source_publication_generation,
      sourceCoverageMode: row.source_coverage_mode,
      reviewCandidate: Number(row.review_candidate) === 1,
      categoryScope: row.category_scope,
      actionableOwnerListingId: row.actionable_owner_listing_id,
      actionableOwnerSourceId: row.actionable_owner_source_id,
      ownerState: row.owner_state,
      ownerBasis: row.owner_basis,
      ownerProofHash: row.owner_proof_hash,
      sharedGroupIdentity: row.shared_group_identity,
      upstreamTupleIdentity: row.upstream_tuple_identity,
      counterpartState: row.counterpart_state,
      counterpartOwnerListingId: row.counterpart_owner_listing_id,
      counterpartOwnerSourceId: row.counterpart_owner_source_id,
      counterpartAbsenceProofHash: row.counterpart_absence_proof_hash,
      ownershipInputHash: row.ownership_input_hash,
      acceptedDetailIdentity: row.accepted_detail_identity,
      acceptedDetailHash: row.accepted_detail_hash,
      effectiveLocationInputHash: row.effective_location_input_hash,
      routeCacheIdentity: row.route_cache_identity,
      routeAssignmentIdentity: row.route_assignment_identity,
      routeInputHash: row.route_input_hash,
      routeTerminalIdentity: row.route_terminal_identity,
      factualSupplementState: row.factual_supplement_state,
      factualSupplementInputHash: row.factual_supplement_input_hash,
      sourceImageIdentityHash: row.source_image_identity_hash,
      localPrimaryState: row.local_primary_state,
      imageInputHash: row.image_input_hash,
      enrichmentHeadIdentity: row.enrichment_head_identity,
      enrichmentInputHash: row.enrichment_input_hash,
      scoreHeadIdentity: row.score_head_identity,
      scoreSnapshotIdentity: row.score_snapshot_identity,
      scoreInputHash: row.score_input_hash,
      sourceReleaseInputHash: row.source_release_input_hash,
      projectionWorkInputHash: row.projection_work_input_hash,
      relevantGenerationVectorHash: row.relevant_generation_vector_hash,
      projectionDerivationVersion: row.projection_derivation_version,
      ownershipDerivationVersion: row.ownership_derivation_version,
    },
  }));
  const stagePlaceholders = LISTING_DOWNSTREAM_WORK_STAGES.map(() => "?").join(",");
  const queue = await input.database.prepare(`
    SELECT stage, subject_type, subject_id, input_hash, lane_key, source_id
    FROM pipeline_work_items
    WHERE subject_type = 'listing' AND stage IN (${stagePlaceholders})
    ORDER BY stage, subject_id
  `).bind(...LISTING_DOWNSTREAM_WORK_STAGES).all<Row>();
  const actualQueueRows = (queue.results ?? []).map((row) => ({
    id: `${row.stage}:${row.subject_type}:${row.subject_id}`,
    value: {
      inputHash: row.input_hash,
      laneKey: row.lane_key,
      sourceId: row.source_id,
    },
  }));
  const parity = await auditProjectionParity({
    canonicalRows,
    projectionRows,
    expectedQueueRows,
    actualQueueRows,
  });
  return Object.freeze({
    ...parity,
    batches,
    durationMs: performance.now() - started,
  });
}
