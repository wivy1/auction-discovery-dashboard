import { sha256Text } from "../ai/provenance";
import { hashCanonicalJson } from "../performance/generations";
import { preparePipelineWorkCoalesceStatement } from "./work-queue";

export const ENRICHMENT_HEAD_DERIVATION_VERSION =
  "listing-enrichment-head-v1" as const;

export type ListingEnrichmentHeadState =
  | "pending_text"
  | "text_ready"
  | "pending_embedding"
  | "complete"
  | "terminal";

export interface EnrichmentProvenanceTarget {
  readonly identity: string;
  readonly textProviderName: string;
  readonly textModelName: string;
  readonly extractionPromptVersion: string;
  readonly semanticDocumentVersion: string;
  readonly embeddingProviderName: string;
  readonly embeddingModelName: string;
  readonly embeddingDimensions: number;
}

export interface ListingEnrichmentHead {
  readonly listingId: string;
  readonly provenanceTargetIdentity: string;
  readonly enrichmentInputHash: string;
  readonly state: ListingEnrichmentHeadState;
  readonly extractionArtifactId: string | null;
  readonly extractionOutputHash: string | null;
  readonly semanticArtifactId: string | null;
  readonly semanticOutputHash: string | null;
  readonly embeddingId: string | null;
  readonly embeddingInputHash: string | null;
  readonly embeddingVectorHash: string | null;
  readonly headIdentity: string;
  readonly generation: number;
  readonly derivationVersion: string;
  readonly updatedAt: string;
}

export type ListingEnrichmentHeadInitializationOutcome =
  | { readonly outcome: "inserted"; readonly head: ListingEnrichmentHead }
  | { readonly outcome: "reset"; readonly head: ListingEnrichmentHead }
  | { readonly outcome: "unchanged"; readonly head: ListingEnrichmentHead };

export type ListingEnrichmentHeadTransitionOutcome =
  | { readonly outcome: "advanced"; readonly head: ListingEnrichmentHead }
  | { readonly outcome: "unchanged"; readonly head: ListingEnrichmentHead };

export interface ListingEnrichmentReadiness {
  readonly listingId: string;
  readonly provenanceTargetIdentity: string;
  readonly enrichmentInputHash: string;
  readonly state: ListingEnrichmentHeadState;
  readonly headIdentity: string;
  readonly generation: number;
}

export interface PreparedListingEnrichmentHeadTransition {
  readonly statement: D1PreparedStatement;
  readonly priorHead: ListingEnrichmentHead;
  readonly resultingHead: ListingEnrichmentHead;
}

export interface PreparedListingEnrichmentHeadInitialization {
  readonly statement: D1PreparedStatement | null;
  readonly priorHead: ListingEnrichmentHead | null;
  readonly resultingHead: ListingEnrichmentHead;
  readonly outcome: "inserted" | "reset" | "unchanged";
}

interface ListingEnrichmentHeadRow {
  listing_id: unknown;
  provenance_target_identity: unknown;
  enrichment_input_hash: unknown;
  state: unknown;
  extraction_artifact_id: unknown;
  extraction_output_hash: unknown;
  semantic_artifact_id: unknown;
  semantic_output_hash: unknown;
  embedding_id: unknown;
  embedding_input_hash: unknown;
  embedding_vector_hash: unknown;
  head_identity: unknown;
  generation: unknown;
  derivation_version: unknown;
  updated_at: unknown;
}

interface ArtifactRow {
  id: string;
  subject_type: string;
  subject_id: string;
  task: string;
  provider_name: string;
  model_name: string;
  prompt_version: string;
  input_hash: string;
  output_text: string | null;
  output_json: string | null;
  output_hash: string | null;
}

interface EmbeddingRow {
  id: string;
  subject_type: string;
  subject_id: string;
  kind: string;
  provider_name: string;
  model_name: string;
  input_hash: string;
  dimensions: number;
  vector_json: string;
}

const HEAD_STATES = new Set<ListingEnrichmentHeadState>([
  "pending_text",
  "text_ready",
  "pending_embedding",
  "complete",
  "terminal",
]);
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_READINESS_IDS = 250;
const headColumns = `
  listing_id, provenance_target_identity, enrichment_input_hash, state,
  extraction_artifact_id, extraction_output_hash,
  semantic_artifact_id, semantic_output_hash,
  embedding_id, embedding_input_hash, embedding_vector_hash,
  head_identity, generation, derivation_version, updated_at
`;

/** Returns the exact current enrichment head, without loading artifact bodies. */
export async function readListingEnrichmentHead(
  database: D1Database,
  listingId: string,
): Promise<ListingEnrichmentHead | null> {
  const id = boundedText(listingId, "listing ID", 512);
  const row = await database.prepare(`
    SELECT ${headColumns}
    FROM listing_enrichment_heads
    WHERE listing_id = ?
  `).bind(id).first<ListingEnrichmentHeadRow>();
  return row === null ? null : headFromRow(row);
}

/** One compact indexed read for scheduler/readiness decisions. */
export async function readListingEnrichmentReadiness(
  database: D1Database,
  listingIds: readonly string[],
): Promise<readonly ListingEnrichmentReadiness[]> {
  if (listingIds.length > MAX_READINESS_IDS) {
    throw new RangeError(`enrichment readiness supports at most ${MAX_READINESS_IDS} listings`);
  }
  const ids = listingIds.map((id) => boundedText(id, "listing ID", 512));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError("enrichment readiness listing IDs must be unique");
  }
  if (ids.length === 0) return Object.freeze([]);
  const result = await database.prepare(`
    SELECT
      listing_id, provenance_target_identity, enrichment_input_hash,
      state, head_identity, generation
    FROM listing_enrichment_heads
    WHERE listing_id IN (${ids.map(() => "?").join(", ")})
    ORDER BY listing_id
  `).bind(...ids).all<{
    listing_id: unknown;
    provenance_target_identity: unknown;
    enrichment_input_hash: unknown;
    state: unknown;
    head_identity: unknown;
    generation: unknown;
  }>();
  return Object.freeze((result.results ?? []).map((row) => {
    const listingId = boundedStoredText(row.listing_id, "stored listing ID", 512);
    const provenanceTargetIdentity = boundedStoredText(
      row.provenance_target_identity,
      "stored provenance target identity",
      512,
    );
    const enrichmentInputHash = boundedStoredText(
      row.enrichment_input_hash,
      "stored enrichment input hash",
      512,
    );
    const state = storedState(row.state);
    const headIdentity = boundedStoredText(row.head_identity, "stored head identity", 512);
    const generation = storedGeneration(row.generation);
    return Object.freeze({
      listingId,
      provenanceTargetIdentity,
      enrichmentInputHash,
      state,
      headIdentity,
      generation,
    });
  }));
}

/**
 * Creates generation one, or resets a changed target/input to pending text.
 * Repeating the exact desired input never regresses progress or churns time,
 * identity, or generation.
 */
export async function prepareListingEnrichmentHeadInitialization(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly target: EnrichmentProvenanceTarget;
  readonly enrichmentInputHash: string;
  readonly derivationVersion?: string;
  readonly now?: Date;
}): Promise<PreparedListingEnrichmentHeadInitialization> {
  const listingId = boundedText(input.listingId, "listing ID", 512);
  const target = validateTarget(input.target);
  const enrichmentInputHash = boundedText(
    input.enrichmentInputHash,
    "enrichment input hash",
    512,
  );
  const derivationVersion = boundedText(
    input.derivationVersion ?? ENRICHMENT_HEAD_DERIVATION_VERSION,
    "enrichment head derivation version",
    256,
  );
  const nowIso = validDate(input.now ?? new Date(), "enrichment head update time")
    .toISOString();
  const current = await readListingEnrichmentHead(input.database, listingId);
  if (
    current !== null &&
    current.provenanceTargetIdentity === target.identity &&
    current.enrichmentInputHash === enrichmentInputHash &&
    current.derivationVersion === derivationVersion
  ) {
    return Object.freeze({
      statement: null,
      priorHead: current,
      resultingHead: current,
      outcome: "unchanged" as const,
    });
  }

  const generation = current === null ? 1 : current.generation + 1;
  const next = await makeHead({
    listingId,
    provenanceTargetIdentity: target.identity,
    enrichmentInputHash,
    state: "pending_text",
    extractionArtifactId: null,
    extractionOutputHash: null,
    semanticArtifactId: null,
    semanticOutputHash: null,
    embeddingId: null,
    embeddingInputHash: null,
    embeddingVectorHash: null,
    generation,
    derivationVersion,
    updatedAt: nowIso,
  });

  const statement = current === null
    ? input.database.prepare(`
        INSERT INTO listing_enrichment_heads (
          listing_id, provenance_target_identity, enrichment_input_hash, state,
          extraction_artifact_id, extraction_output_hash,
          semantic_artifact_id, semantic_output_hash,
          embedding_id, embedding_input_hash, embedding_vector_hash,
          head_identity, generation, derivation_version, updated_at
        ) VALUES (?, ?, ?, 'pending_text', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, 1, ?, ?)
        ON CONFLICT(listing_id) DO NOTHING
      `).bind(
        listingId,
        target.identity,
        enrichmentInputHash,
        next.headIdentity,
        derivationVersion,
        nowIso,
      )
    : input.database.prepare(`
        UPDATE listing_enrichment_heads
        SET provenance_target_identity = ?, enrichment_input_hash = ?,
            state = 'pending_text',
            extraction_artifact_id = NULL, extraction_output_hash = NULL,
            semantic_artifact_id = NULL, semantic_output_hash = NULL,
            embedding_id = NULL, embedding_input_hash = NULL,
            embedding_vector_hash = NULL, head_identity = ?,
            generation = ?, derivation_version = ?, updated_at = ?
        WHERE listing_id = ? AND head_identity = ? AND generation = ?
      `).bind(
        target.identity,
        enrichmentInputHash,
        next.headIdentity,
        generation,
        derivationVersion,
        nowIso,
        listingId,
        current.headIdentity,
        current.generation,
      );
  return Object.freeze({
    statement,
    priorHead: current,
    resultingHead: next,
    outcome: current === null ? "inserted" as const : "reset" as const,
  });
}

export async function initializeListingEnrichmentHead(input: Parameters<
  typeof prepareListingEnrichmentHeadInitialization
>[0]): Promise<ListingEnrichmentHeadInitializationOutcome> {
  const prepared = await prepareListingEnrichmentHeadInitialization(input);
  if (prepared.statement === null) {
    return { outcome: "unchanged", head: prepared.resultingHead };
  }
  const result = await prepared.statement.run();
  if (changes(result) !== 1) {
    const raced = await readListingEnrichmentHead(input.database, input.listingId);
    if (
      raced !== null &&
      raced.provenanceTargetIdentity === input.target.identity &&
      raced.enrichmentInputHash === input.enrichmentInputHash &&
      raced.derivationVersion ===
        (input.derivationVersion ?? ENRICHMENT_HEAD_DERIVATION_VERSION)
    ) return { outcome: "unchanged", head: raced };
    throw new Error("enrichment head initialization lost its exact compare-and-set");
  }
  return { outcome: prepared.outcome, head: prepared.resultingHead };
}

/**
 * Validates the immutable extraction/semantic chain and prepares its exact
 * compare-and-set transition. The returned statement can share a D1 batch
 * with canonical queue mutations.
 */
export async function prepareListingEnrichmentTextTransition(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly expectedHeadIdentity: string;
  readonly expectedEnrichmentInputHash: string;
  /**
   * A prepared pending-text head whose exact initialization statement will
   * precede this transition in the same atomic batch.
   */
  readonly pendingInitializationHead?: ListingEnrichmentHead;
  readonly target: EnrichmentProvenanceTarget;
  readonly artifactInputHash: string;
  readonly extractionArtifactId: string;
  readonly semanticArtifactId: string;
  readonly nextState: "text_ready" | "pending_embedding";
  readonly now?: Date;
}): Promise<PreparedListingEnrichmentHeadTransition | null> {
  const listingId = boundedText(input.listingId, "listing ID", 512);
  const expectedHeadIdentity = boundedText(input.expectedHeadIdentity, "expected head identity", 512);
  const expectedInputHash = boundedText(
    input.expectedEnrichmentInputHash,
    "expected enrichment input hash",
    512,
  );
  const artifactInputHash = boundedText(input.artifactInputHash, "artifact input hash", 512);
  const extractionArtifactId = boundedText(input.extractionArtifactId, "extraction artifact ID", 512);
  const semanticArtifactId = boundedText(input.semanticArtifactId, "semantic artifact ID", 512);
  const target = validateTarget(input.target);
  const current = input.pendingInitializationHead ?? await requireExactHead(
    input.database,
    listingId,
    expectedHeadIdentity,
    expectedInputHash,
    target.identity,
  );
  if (
    current.listingId !== listingId ||
    current.headIdentity !== expectedHeadIdentity ||
    current.enrichmentInputHash !== expectedInputHash ||
    current.provenanceTargetIdentity !== target.identity ||
    (input.pendingInitializationHead !== undefined &&
      current.state !== "pending_text")
  ) throw new Error("enrichment pending initialization head is not exact");
  const lineage = await validateTextLineage({
    database: input.database,
    listingId,
    target,
    artifactInputHash,
    extractionArtifactId,
    semanticArtifactId,
  });

  if (sameTextLineage(
    current,
    extractionArtifactId,
    semanticArtifactId,
    lineage,
  )) {
    if (current.state === input.nextState || current.state === "complete") return null;
    if (current.state === "pending_embedding" && input.nextState === "text_ready") {
      throw new Error("enrichment text transition cannot regress pending embedding");
    }
  }
  if (current.state !== "pending_text" && !(
    current.state === "text_ready" && input.nextState === "pending_embedding"
  )) {
    throw new Error(`enrichment text transition is invalid from ${current.state}`);
  }

  const nowIso = validDate(input.now ?? new Date(), "enrichment head update time").toISOString();
  const resultingHead = await makeHead({
    ...current,
    state: input.nextState,
    extractionArtifactId,
    extractionOutputHash: lineage.extractionOutputHash,
    semanticArtifactId,
    semanticOutputHash: lineage.semanticOutputHash,
    embeddingId: null,
    embeddingInputHash: null,
    embeddingVectorHash: null,
    generation: current.generation + 1,
    updatedAt: nowIso,
  });
  const statement = input.database.prepare(`
    UPDATE listing_enrichment_heads
    SET state = ?, extraction_artifact_id = ?, extraction_output_hash = ?,
        semantic_artifact_id = ?, semantic_output_hash = ?,
        embedding_id = NULL, embedding_input_hash = NULL,
        embedding_vector_hash = NULL, head_identity = ?,
        generation = ?, updated_at = ?
    WHERE listing_id = ? AND head_identity = ? AND generation = ?
      AND enrichment_input_hash = ? AND provenance_target_identity = ?
      AND state = ?
  `).bind(
    input.nextState,
    extractionArtifactId,
    lineage.extractionOutputHash,
    semanticArtifactId,
    lineage.semanticOutputHash,
    resultingHead.headIdentity,
    resultingHead.generation,
    nowIso,
    listingId,
    current.headIdentity,
    current.generation,
    current.enrichmentInputHash,
    current.provenanceTargetIdentity,
    current.state,
  );
  return Object.freeze({ statement, priorHead: current, resultingHead });
}

export async function advanceListingEnrichmentText(input: Parameters<
  typeof prepareListingEnrichmentTextTransition
>[0]): Promise<ListingEnrichmentHeadTransitionOutcome> {
  const prepared = await prepareListingEnrichmentTextTransition(input);
  if (prepared === null) {
    const head = await requireExactHead(
      input.database,
      input.listingId,
      input.expectedHeadIdentity,
      input.expectedEnrichmentInputHash,
      input.target.identity,
    );
    return { outcome: "unchanged", head };
  }
  const result = await prepared.statement.run();
  if (changes(result) !== 1) throw new Error("stale enrichment text head transition refused");
  return { outcome: "advanced", head: prepared.resultingHead };
}

/** Validates vector content and prepares the exact complete-head mutation. */
export async function prepareListingEnrichmentCompletion(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly expectedHeadIdentity: string;
  readonly expectedEnrichmentInputHash: string;
  readonly target: EnrichmentProvenanceTarget;
  readonly embeddingId: string;
  readonly now?: Date;
}): Promise<PreparedListingEnrichmentHeadTransition | null> {
  const listingId = boundedText(input.listingId, "listing ID", 512);
  const expectedHeadIdentity = boundedText(input.expectedHeadIdentity, "expected head identity", 512);
  const expectedInputHash = boundedText(
    input.expectedEnrichmentInputHash,
    "expected enrichment input hash",
    512,
  );
  const embeddingId = boundedText(input.embeddingId, "embedding ID", 512);
  const target = validateTarget(input.target);
  const current = await requireExactHead(
    input.database,
    listingId,
    expectedHeadIdentity,
    expectedInputHash,
    target.identity,
  );
  if (current.state === "complete" && current.embeddingId === embeddingId) return null;
  if (
    current.state !== "text_ready" &&
    current.state !== "pending_embedding"
  ) throw new Error(`enrichment completion is invalid from ${current.state}`);
  if (
    current.extractionArtifactId === null || current.extractionOutputHash === null ||
    current.semanticArtifactId === null || current.semanticOutputHash === null
  ) throw new Error("enrichment completion requires a durable text lineage");

  // Re-read the text chain so a current head never blesses mutated/corrupt
  // provenance rows merely because it once pointed at their IDs.
  await validateTextLineage({
    database: input.database,
    listingId,
    target,
    artifactInputHash: await artifactInputHash(
      input.database,
      current.extractionArtifactId,
    ),
    extractionArtifactId: current.extractionArtifactId,
    semanticArtifactId: current.semanticArtifactId,
    expectedExtractionOutputHash: current.extractionOutputHash,
    expectedSemanticOutputHash: current.semanticOutputHash,
  });
  const embedding = await validateEmbeddingLineage({
    database: input.database,
    listingId,
    target,
    embeddingId,
    semanticOutputHash: current.semanticOutputHash,
  });
  const nowIso = validDate(input.now ?? new Date(), "enrichment head update time").toISOString();
  const resultingHead = await makeHead({
    ...current,
    state: "complete",
    embeddingId,
    embeddingInputHash: current.semanticOutputHash,
    embeddingVectorHash: embedding.vectorHash,
    generation: current.generation + 1,
    updatedAt: nowIso,
  });
  const statement = input.database.prepare(`
    UPDATE listing_enrichment_heads
    SET state = 'complete', embedding_id = ?, embedding_input_hash = ?,
        embedding_vector_hash = ?, head_identity = ?, generation = ?,
        updated_at = ?
    WHERE listing_id = ? AND head_identity = ? AND generation = ?
      AND enrichment_input_hash = ? AND provenance_target_identity = ?
      AND state = ?
  `).bind(
    embeddingId,
    current.semanticOutputHash,
    embedding.vectorHash,
    resultingHead.headIdentity,
    resultingHead.generation,
    nowIso,
    listingId,
    current.headIdentity,
    current.generation,
    current.enrichmentInputHash,
    current.provenanceTargetIdentity,
    current.state,
  );
  return Object.freeze({ statement, priorHead: current, resultingHead });
}

export async function completeListingEnrichmentHead(input: Parameters<
  typeof prepareListingEnrichmentCompletion
>[0]): Promise<ListingEnrichmentHeadTransitionOutcome> {
  const prepared = await prepareListingEnrichmentCompletion(input);
  if (prepared === null) {
    const head = await requireExactHead(
      input.database,
      input.listingId,
      input.expectedHeadIdentity,
      input.expectedEnrichmentInputHash,
      input.target.identity,
    );
    return { outcome: "unchanged", head };
  }
  const result = await prepared.statement.run();
  if (changes(result) !== 1) throw new Error("stale enrichment completion refused");
  return { outcome: "advanced", head: prepared.resultingHead };
}

/** Records a deterministic terminal for only the exact current input/head. */
export async function prepareListingEnrichmentTerminal(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly expectedHeadIdentity: string;
  readonly expectedEnrichmentInputHash: string;
  readonly targetIdentity: string;
  readonly now?: Date;
}): Promise<PreparedListingEnrichmentHeadTransition | null> {
  const listingId = boundedText(input.listingId, "listing ID", 512);
  const expectedHeadIdentity = boundedText(input.expectedHeadIdentity, "expected head identity", 512);
  const expectedInputHash = boundedText(
    input.expectedEnrichmentInputHash,
    "expected enrichment input hash",
    512,
  );
  const targetIdentity = boundedText(input.targetIdentity, "provenance target identity", 512);
  const current = await requireExactHead(
    input.database,
    listingId,
    expectedHeadIdentity,
    expectedInputHash,
    targetIdentity,
  );
  if (current.state === "terminal") return null;
  if (current.state === "complete") {
    throw new Error("a complete enrichment head cannot be replaced by a terminal");
  }
  const nowIso = validDate(input.now ?? new Date(), "enrichment head update time").toISOString();
  const resultingHead = await makeHead({
    ...current,
    state: "terminal",
    extractionArtifactId: null,
    extractionOutputHash: null,
    semanticArtifactId: null,
    semanticOutputHash: null,
    embeddingId: null,
    embeddingInputHash: null,
    embeddingVectorHash: null,
    generation: current.generation + 1,
    updatedAt: nowIso,
  });
  const statement = input.database.prepare(`
    UPDATE listing_enrichment_heads
    SET state = 'terminal', extraction_artifact_id = NULL,
        extraction_output_hash = NULL, semantic_artifact_id = NULL,
        semantic_output_hash = NULL, embedding_id = NULL,
        embedding_input_hash = NULL, embedding_vector_hash = NULL,
        head_identity = ?, generation = ?, updated_at = ?
    WHERE listing_id = ? AND head_identity = ? AND generation = ?
      AND enrichment_input_hash = ? AND provenance_target_identity = ?
      AND state <> 'complete'
  `).bind(
    resultingHead.headIdentity,
    resultingHead.generation,
    nowIso,
    listingId,
    current.headIdentity,
    current.generation,
    current.enrichmentInputHash,
    current.provenanceTargetIdentity,
  );
  return Object.freeze({ statement, priorHead: current, resultingHead });
}

export async function markListingEnrichmentTerminal(input: Parameters<
  typeof prepareListingEnrichmentTerminal
>[0]): Promise<ListingEnrichmentHeadTransitionOutcome> {
  const prepared = await prepareListingEnrichmentTerminal(input);
  if (prepared === null) {
    const head = await requireExactHead(
      input.database,
      input.listingId,
      input.expectedHeadIdentity,
      input.expectedEnrichmentInputHash,
      input.targetIdentity,
    );
    return { outcome: "unchanged", head };
  }
  const result = await prepared.statement.run();
  if (changes(result) !== 1) {
    throw new Error("stale enrichment terminal transition refused");
  }
  return { outcome: "advanced", head: prepared.resultingHead };
}

/**
 * Score-failure fallback for one exact, already-complete enrichment head.
 * This deliberately does not loosen the ordinary terminal transition, which
 * must continue to reject replacing a complete validated lineage.
 */
export async function prepareListingEnrichmentScoreFailureTerminal(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly expectedHeadIdentity: string;
  readonly expectedEnrichmentInputHash: string;
  readonly targetIdentity: string;
  readonly now?: Date;
}): Promise<PreparedListingEnrichmentHeadTransition> {
  const listingId = boundedText(input.listingId, "listing ID", 512);
  const expectedHeadIdentity = boundedText(
    input.expectedHeadIdentity,
    "expected head identity",
    512,
  );
  const expectedInputHash = boundedText(
    input.expectedEnrichmentInputHash,
    "expected enrichment input hash",
    512,
  );
  const targetIdentity = boundedText(
    input.targetIdentity,
    "provenance target identity",
    512,
  );
  const current = await requireExactHead(
    input.database,
    listingId,
    expectedHeadIdentity,
    expectedInputHash,
    targetIdentity,
  );
  if (current.state !== "complete") {
    throw new Error(
      `score-failure enrichment terminal is invalid from ${current.state}`,
    );
  }
  const nowIso = validDate(
    input.now ?? new Date(),
    "enrichment head update time",
  ).toISOString();
  const resultingHead = await makeHead({
    ...current,
    state: "terminal",
    extractionArtifactId: null,
    extractionOutputHash: null,
    semanticArtifactId: null,
    semanticOutputHash: null,
    embeddingId: null,
    embeddingInputHash: null,
    embeddingVectorHash: null,
    generation: current.generation + 1,
    updatedAt: nowIso,
  });
  const statement = input.database.prepare(`
    UPDATE listing_enrichment_heads
    SET state = 'terminal', extraction_artifact_id = NULL,
        extraction_output_hash = NULL, semantic_artifact_id = NULL,
        semantic_output_hash = NULL, embedding_id = NULL,
        embedding_input_hash = NULL, embedding_vector_hash = NULL,
        head_identity = ?, generation = ?, updated_at = ?
    WHERE listing_id = ? AND head_identity = ? AND generation = ?
      AND enrichment_input_hash = ? AND provenance_target_identity = ?
      AND state = 'complete'
  `).bind(
    resultingHead.headIdentity,
    resultingHead.generation,
    nowIso,
    listingId,
    current.headIdentity,
    current.generation,
    current.enrichmentInputHash,
    current.provenanceTargetIdentity,
  );
  return Object.freeze({ statement, priorHead: current, resultingHead });
}

/** Exact desired text work: the enrichment input itself is its revision key. */
export function prepareEnrichmentTextQueueCoalesceStatement(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly sourceId?: string | null;
  readonly enrichmentInputHash: string;
  readonly laneKey?: string;
  readonly priority?: number;
  readonly reasonCode?: string;
  readonly now?: Date;
}): D1PreparedStatement {
  return preparePipelineWorkCoalesceStatement({
    database: input.database,
    stage: "enrichment_text",
    subject: {
      type: "listing",
      id: boundedText(input.listingId, "listing ID", 512),
      sourceId: input.sourceId,
    },
    laneKey: input.laneKey ?? "local-ai-text",
    inputHash: boundedText(input.enrichmentInputHash, "enrichment input hash", 512),
    priority: input.priority ?? 0,
    reasonCode: input.reasonCode ?? "enrichment_text_dirty",
    now: input.now,
  });
}

/** Exact desired embedding work is bound to the durable text head identity. */
export async function prepareEnrichmentEmbeddingQueueCoalesceStatement(input: {
  readonly database: D1Database;
  readonly listingId: string;
  readonly sourceId?: string | null;
  readonly enrichmentInputHash: string;
  readonly textHeadIdentity: string;
  readonly laneKey?: string;
  readonly priority?: number;
  readonly reasonCode?: string;
  readonly now?: Date;
}): Promise<D1PreparedStatement> {
  const enrichmentInputHash = boundedText(
    input.enrichmentInputHash,
    "enrichment input hash",
    512,
  );
  const textHeadIdentity = boundedText(input.textHeadIdentity, "text head identity", 512);
  return preparePipelineWorkCoalesceStatement({
    database: input.database,
    stage: "enrichment_embedding",
    subject: {
      type: "listing",
      id: boundedText(input.listingId, "listing ID", 512),
      sourceId: input.sourceId,
    },
    laneKey: input.laneKey ?? "local-ai-embedding",
    inputHash: await hashCanonicalJson({
      enrichmentInputHash,
      headIdentity: textHeadIdentity,
      headState: "pending_embedding",
    }),
    priority: input.priority ?? 0,
    reasonCode: input.reasonCode ?? "enrichment_embedding_dirty",
    now: input.now,
  });
}

async function validateTextLineage(input: {
  database: D1Database;
  listingId: string;
  target: EnrichmentProvenanceTarget;
  artifactInputHash: string;
  extractionArtifactId: string;
  semanticArtifactId: string;
  expectedExtractionOutputHash?: string;
  expectedSemanticOutputHash?: string;
}): Promise<{ extractionOutputHash: string; semanticOutputHash: string }> {
  const [extraction, semantic] = await Promise.all([
    readArtifact(input.database, input.extractionArtifactId),
    readArtifact(input.database, input.semanticArtifactId),
  ]);
  if (
    extraction.subject_type !== "listing" || extraction.subject_id !== input.listingId ||
    extraction.task !== "listing_extraction" ||
    extraction.provider_name !== input.target.textProviderName ||
    extraction.model_name !== input.target.textModelName ||
    extraction.prompt_version !== input.target.extractionPromptVersion ||
    extraction.input_hash !== input.artifactInputHash ||
    extraction.output_json === null || extraction.output_hash === null
  ) throw new Error("extraction artifact does not match the exact enrichment provenance target/input");
  const extractionOutputHash = await sha256Text(extraction.output_json);
  if (
    extraction.output_hash !== extractionOutputHash ||
    (input.expectedExtractionOutputHash !== undefined &&
      input.expectedExtractionOutputHash !== extractionOutputHash)
  ) throw new Error("extraction artifact output hash is invalid");

  if (
    semantic.subject_type !== "listing" || semantic.subject_id !== input.listingId ||
    semantic.task !== "semantic_document" ||
    semantic.provider_name !== input.target.textProviderName ||
    semantic.model_name !== input.target.textModelName ||
    semantic.prompt_version !== input.target.semanticDocumentVersion ||
    semantic.input_hash !== input.artifactInputHash ||
    semantic.output_text === null || semantic.output_json === null ||
    semantic.output_hash === null || semantic.output_text.trim() !== semantic.output_text
  ) throw new Error("semantic artifact does not match the exact enrichment provenance target/input");
  const expectedMetadata = JSON.stringify({ extractionOutputHash });
  const semanticOutputHash = await sha256Text(semantic.output_text);
  if (
    semantic.output_json !== expectedMetadata ||
    semantic.output_hash !== semanticOutputHash ||
    (input.expectedSemanticOutputHash !== undefined &&
      input.expectedSemanticOutputHash !== semanticOutputHash)
  ) throw new Error("semantic artifact hash lineage is invalid");
  return { extractionOutputHash, semanticOutputHash };
}

async function validateEmbeddingLineage(input: {
  database: D1Database;
  listingId: string;
  target: EnrichmentProvenanceTarget;
  embeddingId: string;
  semanticOutputHash: string;
}): Promise<{ vectorHash: string }> {
  const embedding = await input.database.prepare(`
    SELECT
      id, subject_type, subject_id, kind, provider_name, model_name,
      input_hash, dimensions, vector_json
    FROM embeddings WHERE id = ?
  `).bind(input.embeddingId).first<EmbeddingRow>();
  if (embedding === null) throw new Error("embedding does not exist");
  if (
    embedding.subject_type !== "listing" || embedding.subject_id !== input.listingId ||
    embedding.kind !== "listing_semantic_document" ||
    embedding.provider_name !== input.target.embeddingProviderName ||
    embedding.model_name !== input.target.embeddingModelName ||
    embedding.input_hash !== input.semanticOutputHash ||
    embedding.dimensions !== input.target.embeddingDimensions
  ) throw new Error("embedding does not match the exact semantic provenance target/input");
  let vector: unknown;
  try {
    vector = JSON.parse(embedding.vector_json) as unknown;
  } catch {
    throw new Error("embedding vector JSON is invalid");
  }
  if (
    !Array.isArray(vector) || vector.length !== input.target.embeddingDimensions ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) throw new Error("embedding vector does not match its dimension/finite-value contract");
  return { vectorHash: await sha256Text(embedding.vector_json) };
}

async function readArtifact(database: D1Database, artifactId: string): Promise<ArtifactRow> {
  const row = await database.prepare(`
    SELECT
      id, subject_type, subject_id, task, provider_name, model_name,
      prompt_version, input_hash, output_text, output_json, output_hash
    FROM ai_artifacts WHERE id = ?
  `).bind(artifactId).first<ArtifactRow>();
  if (row === null) throw new Error(`AI artifact ${artifactId} does not exist`);
  return row;
}

async function artifactInputHash(database: D1Database, artifactId: string): Promise<string> {
  const row = await database.prepare(`
    SELECT input_hash FROM ai_artifacts WHERE id = ?
  `).bind(artifactId).first<{ input_hash: string }>();
  if (row === null) throw new Error(`AI artifact ${artifactId} does not exist`);
  return boundedText(row.input_hash, "artifact input hash", 512);
}

async function requireExactHead(
  database: D1Database,
  listingId: string,
  expectedHeadIdentity: string,
  expectedInputHash: string,
  targetIdentity: string,
): Promise<ListingEnrichmentHead> {
  const current = await requireCurrentHead(database, listingId);
  if (
    current.headIdentity !== expectedHeadIdentity ||
    current.enrichmentInputHash !== expectedInputHash ||
    current.provenanceTargetIdentity !== targetIdentity
  ) throw new Error("stale enrichment input/head transition refused");
  return current;
}

async function requireCurrentHead(
  database: D1Database,
  listingId: string,
): Promise<ListingEnrichmentHead> {
  const current = await readListingEnrichmentHead(database, listingId);
  if (current === null) throw new Error("listing enrichment head does not exist");
  return current;
}

function sameTextLineage(
  head: ListingEnrichmentHead,
  extractionArtifactId: string,
  semanticArtifactId: string,
  lineage: { extractionOutputHash: string; semanticOutputHash: string },
): boolean {
  return head.extractionArtifactId === extractionArtifactId &&
    head.semanticArtifactId === semanticArtifactId &&
    head.extractionOutputHash === lineage.extractionOutputHash &&
    head.semanticOutputHash === lineage.semanticOutputHash;
}

async function makeHead(input: Omit<ListingEnrichmentHead, "headIdentity">): Promise<ListingEnrichmentHead> {
  const headIdentity = await hashCanonicalJson({
    listingId: input.listingId,
    provenanceTargetIdentity: input.provenanceTargetIdentity,
    enrichmentInputHash: input.enrichmentInputHash,
    state: input.state,
    extractionArtifactId: input.extractionArtifactId,
    extractionOutputHash: input.extractionOutputHash,
    semanticArtifactId: input.semanticArtifactId,
    semanticOutputHash: input.semanticOutputHash,
    embeddingId: input.embeddingId,
    embeddingInputHash: input.embeddingInputHash,
    embeddingVectorHash: input.embeddingVectorHash,
    generation: input.generation,
    derivationVersion: input.derivationVersion,
  });
  return Object.freeze({ ...input, headIdentity });
}

function headFromRow(row: ListingEnrichmentHeadRow): ListingEnrichmentHead {
  const state = storedState(row.state);
  const head: ListingEnrichmentHead = {
    listingId: boundedStoredText(row.listing_id, "stored listing ID", 512),
    provenanceTargetIdentity: boundedStoredText(
      row.provenance_target_identity,
      "stored provenance target identity",
      512,
    ),
    enrichmentInputHash: boundedStoredText(
      row.enrichment_input_hash,
      "stored enrichment input hash",
      512,
    ),
    state,
    extractionArtifactId: nullableStoredText(row.extraction_artifact_id, "stored extraction artifact ID"),
    extractionOutputHash: nullableStoredHash(row.extraction_output_hash, "stored extraction output hash"),
    semanticArtifactId: nullableStoredText(row.semantic_artifact_id, "stored semantic artifact ID"),
    semanticOutputHash: nullableStoredHash(row.semantic_output_hash, "stored semantic output hash"),
    embeddingId: nullableStoredText(row.embedding_id, "stored embedding ID"),
    embeddingInputHash: nullableStoredHash(row.embedding_input_hash, "stored embedding input hash"),
    embeddingVectorHash: nullableStoredHash(row.embedding_vector_hash, "stored embedding vector hash"),
    headIdentity: boundedStoredText(row.head_identity, "stored head identity", 512),
    generation: storedGeneration(row.generation),
    derivationVersion: boundedStoredText(row.derivation_version, "stored derivation version", 256),
    updatedAt: boundedStoredText(row.updated_at, "stored update time", 64),
  };
  validateHeadShape(head);
  return Object.freeze(head);
}

function validateHeadShape(head: ListingEnrichmentHead): void {
  if (head.state === "pending_text" && (
    head.extractionArtifactId !== null || head.semanticArtifactId !== null ||
    head.embeddingId !== null
  )) throw new TypeError("stored pending-text enrichment head shape is invalid");
  if ((head.state === "text_ready" || head.state === "pending_embedding") && (
    head.extractionArtifactId === null || head.extractionOutputHash === null ||
    head.semanticArtifactId === null || head.semanticOutputHash === null ||
    head.embeddingId !== null
  )) throw new TypeError("stored text-ready enrichment head shape is invalid");
  if (head.state === "complete" && (
    head.extractionArtifactId === null || head.extractionOutputHash === null ||
    head.semanticArtifactId === null || head.semanticOutputHash === null ||
    head.embeddingId === null || head.embeddingInputHash === null ||
    head.embeddingVectorHash === null
  )) throw new TypeError("stored complete enrichment head shape is invalid");
}

function validateTarget(target: EnrichmentProvenanceTarget): EnrichmentProvenanceTarget {
  const value = Object.freeze({
    identity: boundedText(target.identity, "provenance target identity", 512),
    textProviderName: boundedText(target.textProviderName, "text provider name", 256),
    textModelName: boundedText(target.textModelName, "text model name", 256),
    extractionPromptVersion: boundedText(target.extractionPromptVersion, "extraction prompt version", 256),
    semanticDocumentVersion: boundedText(target.semanticDocumentVersion, "semantic document version", 256),
    embeddingProviderName: boundedText(target.embeddingProviderName, "embedding provider name", 256),
    embeddingModelName: boundedText(target.embeddingModelName, "embedding model name", 256),
    embeddingDimensions: safeInteger(target.embeddingDimensions, "embedding dimensions", 1, 1_000_000),
  });
  return value;
}

function storedState(value: unknown): ListingEnrichmentHeadState {
  if (typeof value !== "string" || !HEAD_STATES.has(value as ListingEnrichmentHeadState)) {
    throw new TypeError("stored enrichment head state is invalid");
  }
  return value as ListingEnrichmentHeadState;
}

function storedGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("stored enrichment generation is invalid");
  }
  return value;
}

function boundedStoredText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  return boundedText(value, label, maximumLength);
}

function nullableStoredText(value: unknown, label: string): string | null {
  return value === null ? null : boundedStoredText(value, label, 512);
}

function nullableStoredHash(value: unknown, label: string): string | null {
  if (value === null) return null;
  const hash = boundedStoredText(value, label, 512);
  if (!SHA256_HEX_PATTERN.test(hash) && !/^sha256:[0-9a-f]{64}$/u.test(hash)) {
    throw new TypeError(`${label} is not a SHA-256 hash`);
  }
  return hash;
}

function boundedText(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > maximumLength ||
    value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)
  ) throw new TypeError(`${label} must be a trimmed bounded string without control characters`);
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum
  ) throw new TypeError(`${label} is invalid`);
  return value;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function changes(result: D1Result | undefined): number {
  const value = result?.meta?.changes;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
