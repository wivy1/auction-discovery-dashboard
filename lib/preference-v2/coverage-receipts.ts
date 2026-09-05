import { PERFORMANCE_DERIVED_V40_SCHEMA } from "../../db/performance-derived-v40-sql";
import { PREFERENCE_V2_ACTIVE_HEADS_V43_SCHEMA } from "../../db/preference-v2-active-heads-v43-sql";
import {
  hashCanonicalJson,
  serializeCanonicalJson,
  type GenerationVectorEntry,
  type PipelineGenerationVector,
  type Sha256Identity,
} from "../performance/generations";
import { PREFERENCE_V2_RUNTIME_IDENTITY_VERSIONS } from "./runtime-identity";

export const PREFERENCE_V2_COVERAGE_DERIVATION_VERSION =
  "preference-v2-score-coverage-receipt-v1" as const;

const SCORE_STAGE = "preference_v2_score" as const;
const SHA256_IDENTITY_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

const SINGLE_GENERATION_DOMAINS = {
  ownershipGeneration: "ownership_derivation",
  detailLocationGeneration: "accepted_detail_location",
  enrichmentHeadGeneration: "enrichment_target",
  physicalAssetGeneration: "physical_asset",
  auctionEventGeneration: "auction_event",
  semanticFamilyGeneration: "semantic_family",
  voteGeneration: "votes",
  cohortGeneration: "cohort",
  activeHistoryGeneration: "reviewed_history",
  presentationPolicyGeneration: "presentation_policy",
  scoreQueueGeneration: "preference_contract",
} as const;

const REQUIRED_VECTOR_DOMAINS = [
  ...Object.values(SINGLE_GENERATION_DOMAINS),
  "source_publication",
  "source_current_membership",
  "active_origin",
  "route_contract",
] as const;

export interface PreferenceV2InferenceContract {
  readonly schemaIdentity:
    | typeof PERFORMANCE_DERIVED_V40_SCHEMA
    | typeof PREFERENCE_V2_ACTIVE_HEADS_V43_SCHEMA;
  /** Null indicates no legacy activation. */
  readonly activationEventIdentity: string | null;
  readonly modelArtifactIdentity: string;
  readonly modelConfigurationIdentity: string;
  readonly modelVersion: string;
  readonly featureVersion: string;
  readonly implementationIdentity: string;
  readonly runtimeIdentity: string;
  readonly requiredRuntimeIdentities: Readonly<Record<string, string>>;
  readonly profileVersionId: string;
  readonly profilePriorHash: Sha256Identity;
  readonly activeOriginCacheKey: string;
  readonly routeProviderName: string;
  readonly routeEstimatorVersion: string;
  readonly routeNormalizationVersion: string;
  readonly routeDatasetIdentity: string;
  readonly enrichmentTargetIdentity: string;
}

export interface PreferenceV2CoverageAudit {
  readonly eligibleListingCount: number;
  readonly eligibleListingIdsHash: Sha256Identity;
  readonly scoreCoverageCount: number;
  readonly scoreCoverageHash: Sha256Identity;
  readonly scoreHeadCount: number;
  readonly scoreHeadHash: Sha256Identity;
}

export interface PreferenceV2CoverageDatabaseBoundary {
  readonly before: string;
  readonly after: string;
  readonly dataVersionBefore?: number | null;
  readonly dataVersionAfter?: number | null;
}

export interface AppendPreferenceV2CoverageReceiptInput {
  readonly database: D1Database;
  readonly contract: PreferenceV2InferenceContract;
  readonly generationVector: PipelineGenerationVector;
  readonly audit: PreferenceV2CoverageAudit;
  readonly databaseBoundary: PreferenceV2CoverageDatabaseBoundary;
  readonly priorReceiptId?: string | null;
  readonly completedAt?: Date;
  readonly derivationVersion?: string;
}

export interface PreferenceV2CoverageReceipt
  extends PreferenceV2InferenceContract,
    PreferenceV2CoverageAudit {
  readonly receiptId: Sha256Identity;
  readonly generationVector: PipelineGenerationVector;
  readonly ownershipGeneration: number;
  readonly sourceCurrentVectorHash: Sha256Identity;
  readonly detailLocationGeneration: number;
  readonly enrichmentHeadGeneration: number;
  readonly physicalAssetGeneration: number;
  readonly auctionEventGeneration: number;
  readonly semanticFamilyGeneration: number;
  readonly voteGeneration: number;
  readonly cohortGeneration: number;
  readonly activeHistoryGeneration: number;
  readonly presentationPolicyGeneration: number;
  readonly scoreQueueGeneration: number;
  readonly scoreQueueHash: Sha256Identity;
  readonly scoreQueueEmpty: true;
  readonly databaseBoundaryBefore: string;
  readonly databaseBoundaryAfter: string;
  readonly dataVersionBefore: number | null;
  readonly dataVersionAfter: number | null;
  readonly priorReceiptId: string | null;
  readonly completedAt: string;
  readonly derivationVersion: string;
}

export type AppendPreferenceV2CoverageReceiptOutcome =
  | { readonly outcome: "appended"; readonly receipt: PreferenceV2CoverageReceipt }
  | { readonly outcome: "existing"; readonly receipt: PreferenceV2CoverageReceipt };

export interface PreferenceV2CoverageHead {
  readonly receiptId: Sha256Identity;
  readonly generationVectorHash: Sha256Identity;
  readonly updatedAt: string;
  readonly receipt: PreferenceV2CoverageReceipt;
}

export type BindPreferenceV2CoverageHeadOutcome =
  | { readonly outcome: "bound"; readonly head: PreferenceV2CoverageHead }
  | { readonly outcome: "already_active"; readonly head: PreferenceV2CoverageHead }
  | {
      readonly outcome: "conditional_miss";
      readonly activeHead: PreferenceV2CoverageHead | null;
    };

export type PreferenceV2CoverageDirtyReason =
  | "missing_coverage_head"
  | "contract_identity_mismatch"
  | "generation_vector_mismatch"
  | "generation_vector_stale"
  | "score_queue_not_empty"
  | "database_boundary_mismatch"
  | "malformed_active_receipt";

export type PreferenceV2CoverageNoChangeResult =
  | { readonly outcome: "unchanged"; readonly head: PreferenceV2CoverageHead }
  | {
      readonly outcome: "dirty";
      readonly reason: PreferenceV2CoverageDirtyReason;
      readonly activeReceiptId: Sha256Identity | null;
    };

export class PreferenceV2CoverageValidationError extends TypeError {
  constructor(
    readonly code:
      | "invalid_contract"
      | "invalid_generation_vector"
      | "invalid_audit"
      | "database_boundary_mismatch"
      | "score_queue_not_empty"
      | "receipt_collision",
    message: string,
  ) {
    super(message);
    this.name = "PreferenceV2CoverageValidationError";
  }
}

interface CoverageReceiptRow {
  receipt_id: unknown;
  schema_identity: unknown;
  activation_event_identity: unknown;
  model_artifact_identity: unknown;
  model_configuration_identity: unknown;
  model_version: unknown;
  feature_version: unknown;
  implementation_identity: unknown;
  runtime_identity: unknown;
  required_runtime_identities_json: unknown;
  profile_version_id: unknown;
  profile_prior_hash: unknown;
  active_origin_cache_key: unknown;
  route_provider_name: unknown;
  route_estimator_version: unknown;
  route_normalization_version: unknown;
  route_dataset_identity: unknown;
  ownership_generation: unknown;
  source_current_vector_hash: unknown;
  detail_location_generation: unknown;
  enrichment_target_identity: unknown;
  enrichment_head_generation: unknown;
  physical_asset_generation: unknown;
  auction_event_generation: unknown;
  semantic_family_generation: unknown;
  vote_generation: unknown;
  cohort_generation: unknown;
  active_history_generation: unknown;
  presentation_policy_generation: unknown;
  generation_vector_json: unknown;
  generation_vector_hash: unknown;
  eligible_listing_count: unknown;
  eligible_listing_ids_hash: unknown;
  score_coverage_count: unknown;
  score_coverage_hash: unknown;
  score_head_count: unknown;
  score_head_hash: unknown;
  score_queue_generation: unknown;
  score_queue_hash: unknown;
  score_queue_empty: unknown;
  database_boundary_before: unknown;
  database_boundary_after: unknown;
  data_version_before: unknown;
  data_version_after: unknown;
  prior_receipt_id: unknown;
  completed_at: unknown;
  derivation_version: unknown;
  head_generation_vector_hash?: unknown;
  head_updated_at?: unknown;
  score_queue_nonempty?: unknown;
  generation_vector_stale?: unknown;
}

interface DerivedVectorFields {
  readonly ownershipGeneration: number;
  readonly sourceCurrentVectorHash: Sha256Identity;
  readonly detailLocationGeneration: number;
  readonly enrichmentHeadGeneration: number;
  readonly physicalAssetGeneration: number;
  readonly auctionEventGeneration: number;
  readonly semanticFamilyGeneration: number;
  readonly voteGeneration: number;
  readonly cohortGeneration: number;
  readonly activeHistoryGeneration: number;
  readonly presentationPolicyGeneration: number;
  readonly scoreQueueGeneration: number;
  readonly scoreQueueHash: Sha256Identity;
}

const receiptColumns = `
  receipt_id, schema_identity, activation_event_identity,
  model_artifact_identity, model_configuration_identity, model_version,
  feature_version, implementation_identity, runtime_identity,
  required_runtime_identities_json, profile_version_id, profile_prior_hash,
  active_origin_cache_key, route_provider_name, route_estimator_version,
  route_normalization_version, route_dataset_identity, ownership_generation,
  source_current_vector_hash, detail_location_generation,
  enrichment_target_identity, enrichment_head_generation,
  physical_asset_generation, auction_event_generation,
  semantic_family_generation, vote_generation, cohort_generation,
  active_history_generation, presentation_policy_generation,
  generation_vector_json, generation_vector_hash, eligible_listing_count,
  eligible_listing_ids_hash, score_coverage_count, score_coverage_hash,
  score_head_count, score_head_hash, score_queue_generation,
  score_queue_hash, score_queue_empty, database_boundary_before,
  database_boundary_after, data_version_before, data_version_after,
  prior_receipt_id, completed_at, derivation_version
`;

const qualifiedReceiptColumns = receiptColumns
  .split(",")
  .map((column) => `receipt.${column.trim()}`)
  .join(", ");

function boundedText(value: unknown, label: string, maximumLength = 512): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_contract",
      `${label} must be a trimmed nonempty string of at most ${maximumLength} characters`,
    );
  }
  return value;
}

function sha256Identity(value: unknown, label: string): Sha256Identity {
  if (typeof value !== "string" || !SHA256_IDENTITY_PATTERN.test(value)) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_contract",
      `${label} must be a lowercase prefixed SHA-256 identity`,
    );
  }
  return value as Sha256Identity;
}

function positiveGeneration(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_generation_vector",
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function nonnegativeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_audit",
      `${label} must be a nonnegative safe integer`,
    );
  }
  return value;
}

function nullableDataVersion(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new PreferenceV2CoverageValidationError(
      "database_boundary_mismatch",
      `${label} must be a nonnegative safe integer or null`,
    );
  }
  return value;
}

function validateContract(
  contract: PreferenceV2InferenceContract,
): PreferenceV2InferenceContract {
  if (
    contract.schemaIdentity !== PERFORMANCE_DERIVED_V40_SCHEMA &&
    contract.schemaIdentity !== PREFERENCE_V2_ACTIVE_HEADS_V43_SCHEMA
  ) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_contract",
      "Preference V2 coverage requires a recognized V40 or V43 schema identity",
    );
  }
  if (
    (contract.schemaIdentity === PREFERENCE_V2_ACTIVE_HEADS_V43_SCHEMA &&
      contract.activationEventIdentity !== null) ||
    (contract.schemaIdentity === PERFORMANCE_DERIVED_V40_SCHEMA &&
      contract.activationEventIdentity === null)
  ) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_contract",
      "Only the accepted non-legacy V43 contract may omit an activation event identity",
    );
  }
  if (
    contract.requiredRuntimeIdentities === null ||
    typeof contract.requiredRuntimeIdentities !== "object" ||
    Array.isArray(contract.requiredRuntimeIdentities)
  ) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_contract",
      "Required runtime identities must be an object",
    );
  }
  const runtimeEntries = Object.entries(contract.requiredRuntimeIdentities);
  if (runtimeEntries.length < 3) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_contract",
      "Required runtime identities are incomplete",
    );
  }
  const requiredRuntimeIdentities = Object.fromEntries(
    runtimeEntries.map(([key, value]) => [
      boundedText(key, "Runtime identity name", 128),
      boundedText(value, `Runtime identity ${key}`, 512),
    ]),
  );
  for (const [key, expected] of Object.entries(PREFERENCE_V2_RUNTIME_IDENTITY_VERSIONS)) {
    if (requiredRuntimeIdentities[key] !== expected) {
      throw new PreferenceV2CoverageValidationError(
        "invalid_contract",
        `Required runtime identity ${key} is missing or incompatible`,
      );
    }
  }
  return Object.freeze({
    schemaIdentity: contract.schemaIdentity,
    activationEventIdentity: contract.activationEventIdentity === null
      ? null
      : boundedText(contract.activationEventIdentity, "Activation event identity"),
    modelArtifactIdentity: boundedText(
      contract.modelArtifactIdentity,
      "Model artifact identity",
    ),
    modelConfigurationIdentity: boundedText(
      contract.modelConfigurationIdentity,
      "Model configuration identity",
    ),
    modelVersion: boundedText(contract.modelVersion, "Model version", 256),
    featureVersion: boundedText(contract.featureVersion, "Feature version", 256),
    implementationIdentity: boundedText(
      contract.implementationIdentity,
      "Implementation identity",
    ),
    runtimeIdentity: boundedText(contract.runtimeIdentity, "Runtime identity"),
    requiredRuntimeIdentities: Object.freeze(requiredRuntimeIdentities),
    profileVersionId: boundedText(contract.profileVersionId, "Profile version ID"),
    profilePriorHash: sha256Identity(contract.profilePriorHash, "Profile prior hash"),
    activeOriginCacheKey: boundedText(
      contract.activeOriginCacheKey,
      "Active origin cache key",
    ),
    routeProviderName: boundedText(
      contract.routeProviderName,
      "Route provider name",
      128,
    ),
    routeEstimatorVersion: boundedText(
      contract.routeEstimatorVersion,
      "Route estimator version",
      256,
    ),
    routeNormalizationVersion: boundedText(
      contract.routeNormalizationVersion,
      "Route normalization version",
      256,
    ),
    routeDatasetIdentity: boundedText(
      contract.routeDatasetIdentity,
      "Route dataset identity",
    ),
    enrichmentTargetIdentity: boundedText(
      contract.enrichmentTargetIdentity,
      "Enrichment target identity",
    ),
  });
}

function validateAudit(audit: PreferenceV2CoverageAudit): PreferenceV2CoverageAudit {
  const eligibleListingCount = nonnegativeCount(
    audit.eligibleListingCount,
    "Eligible listing count",
  );
  const scoreCoverageCount = nonnegativeCount(
    audit.scoreCoverageCount,
    "Score coverage count",
  );
  const scoreHeadCount = nonnegativeCount(audit.scoreHeadCount, "Score head count");
  if (
    scoreCoverageCount !== eligibleListingCount ||
    scoreHeadCount !== eligibleListingCount
  ) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_audit",
      "Eligible, score-coverage, and score-head counts must agree exactly",
    );
  }
  return Object.freeze({
    eligibleListingCount,
    eligibleListingIdsHash: sha256Identity(
      audit.eligibleListingIdsHash,
      "Eligible listing IDs hash",
    ),
    scoreCoverageCount,
    scoreCoverageHash: sha256Identity(
      audit.scoreCoverageHash,
      "Score coverage hash",
    ),
    scoreHeadCount,
    scoreHeadHash: sha256Identity(audit.scoreHeadHash, "Score head hash"),
  });
}

function compareEntry(left: GenerationVectorEntry, right: GenerationVectorEntry): number {
  return left.domain.localeCompare(right.domain) ||
    left.scopeType.localeCompare(right.scopeType) ||
    left.scopeId.localeCompare(right.scopeId);
}

async function validateGenerationVector(
  vector: PipelineGenerationVector,
): Promise<{ vector: PipelineGenerationVector; derived: DerivedVectorFields }> {
  if (!Array.isArray(vector.entries) || vector.entries.length < REQUIRED_VECTOR_DOMAINS.length) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_generation_vector",
      "Preference V2 coverage generation vector is incomplete",
    );
  }
  const seen = new Set<string>();
  const entries = vector.entries.map((entry) => {
    const domain = boundedText(entry.domain, "Generation domain", 128);
    if (!["listing", "source", "group", "global"].includes(entry.scopeType)) {
      throw new PreferenceV2CoverageValidationError(
        "invalid_generation_vector",
        "Generation scope type is invalid",
      );
    }
    const scopeId = boundedText(entry.scopeId, "Generation scope ID", 512);
    const identity = serializeCanonicalJson([domain, entry.scopeType, scopeId]);
    if (seen.has(identity)) {
      throw new PreferenceV2CoverageValidationError(
        "invalid_generation_vector",
        "Generation vector contains a duplicate key",
      );
    }
    seen.add(identity);
    return {
      domain: entry.domain,
      scopeType: entry.scopeType,
      scopeId: entry.scopeId,
      generation: positiveGeneration(entry.generation, `Generation ${domain}`),
      fingerprint: sha256Identity(entry.fingerprint, `Generation ${domain} fingerprint`),
      derivationVersion: boundedText(
        entry.derivationVersion,
        `Generation ${domain} derivation version`,
        256,
      ),
    } satisfies GenerationVectorEntry;
  }).sort(compareEntry);
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index] !== vector.entries[index] &&
      serializeCanonicalJson(entries[index]) !== serializeCanonicalJson(vector.entries[index])) {
      throw new PreferenceV2CoverageValidationError(
        "invalid_generation_vector",
        "Generation vector entries must be in canonical key order",
      );
    }
  }
  const canonicalJson = serializeCanonicalJson(entries);
  const hash = await hashCanonicalJson(entries);
  if (vector.canonicalJson !== canonicalJson || vector.hash !== hash) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_generation_vector",
      "Generation vector JSON or hash does not match its exact entries",
    );
  }
  const byDomain = new Map<string, GenerationVectorEntry[]>();
  for (const entry of entries) {
    const domainEntries = byDomain.get(entry.domain) ?? [];
    domainEntries.push(entry);
    byDomain.set(entry.domain, domainEntries);
  }
  for (const domain of REQUIRED_VECTOR_DOMAINS) {
    if ((byDomain.get(domain)?.length ?? 0) < 1) {
      throw new PreferenceV2CoverageValidationError(
        "invalid_generation_vector",
        `Generation vector is missing required domain ${domain}`,
      );
    }
  }
  const generationFor = (domain: string): number => {
    const domainEntries = byDomain.get(domain)!;
    if (domainEntries.length !== 1) {
      throw new PreferenceV2CoverageValidationError(
        "invalid_generation_vector",
        `Generation vector requires exactly one compact ${domain} entry`,
      );
    }
    return domainEntries[0]!.generation;
  };
  const sourceEntries = entries.filter((entry) =>
    entry.domain === "source_publication" ||
    entry.domain === "source_current_membership"
  );
  const scoreQueueGeneration = generationFor(
    SINGLE_GENERATION_DOMAINS.scoreQueueGeneration,
  );
  return {
    vector: Object.freeze({
      entries,
      canonicalJson,
      hash,
    }),
    derived: Object.freeze({
      ownershipGeneration: generationFor(SINGLE_GENERATION_DOMAINS.ownershipGeneration),
      sourceCurrentVectorHash: await hashCanonicalJson(sourceEntries),
      detailLocationGeneration: generationFor(
        SINGLE_GENERATION_DOMAINS.detailLocationGeneration,
      ),
      enrichmentHeadGeneration: generationFor(
        SINGLE_GENERATION_DOMAINS.enrichmentHeadGeneration,
      ),
      physicalAssetGeneration: generationFor(
        SINGLE_GENERATION_DOMAINS.physicalAssetGeneration,
      ),
      auctionEventGeneration: generationFor(
        SINGLE_GENERATION_DOMAINS.auctionEventGeneration,
      ),
      semanticFamilyGeneration: generationFor(
        SINGLE_GENERATION_DOMAINS.semanticFamilyGeneration,
      ),
      voteGeneration: generationFor(SINGLE_GENERATION_DOMAINS.voteGeneration),
      cohortGeneration: generationFor(SINGLE_GENERATION_DOMAINS.cohortGeneration),
      activeHistoryGeneration: generationFor(
        SINGLE_GENERATION_DOMAINS.activeHistoryGeneration,
      ),
      presentationPolicyGeneration: generationFor(
        SINGLE_GENERATION_DOMAINS.presentationPolicyGeneration,
      ),
      scoreQueueGeneration,
      scoreQueueHash: await hashCanonicalJson({
        stage: SCORE_STAGE,
        generation: scoreQueueGeneration,
        items: [],
      }),
    }),
  };
}

function validateDatabaseBoundary(
  boundary: PreferenceV2CoverageDatabaseBoundary,
): Required<PreferenceV2CoverageDatabaseBoundary> {
  const before = boundedText(boundary.before, "Database boundary before");
  const after = boundedText(boundary.after, "Database boundary after");
  const dataVersionBefore = nullableDataVersion(
    boundary.dataVersionBefore,
    "Data version before",
  );
  const dataVersionAfter = nullableDataVersion(
    boundary.dataVersionAfter,
    "Data version after",
  );
  if (
    before !== after ||
    (dataVersionBefore === null) !== (dataVersionAfter === null) ||
    dataVersionBefore !== dataVersionAfter
  ) {
    throw new PreferenceV2CoverageValidationError(
      "database_boundary_mismatch",
      "Preference V2 coverage requires one stable database boundary",
    );
  }
  return { before, after, dataVersionBefore, dataVersionAfter };
}

function isoTimestamp(value: Date | undefined): string {
  const date = value ?? new Date();
  if (!Number.isFinite(date.getTime())) {
    throw new PreferenceV2CoverageValidationError(
      "invalid_contract",
      "Coverage completion timestamp is invalid",
    );
  }
  return date.toISOString();
}

function changes(result: D1Result): number {
  const meta = result.meta as Record<string, unknown> | undefined;
  const value = meta?.changes ?? meta?.changes_count;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function scoreQueueIsEmpty(database: D1Database): Promise<boolean> {
  const row = await database.prepare(`
    SELECT EXISTS(
      SELECT 1 FROM pipeline_work_items
      WHERE stage = ?
      LIMIT 1
    ) AS score_queue_nonempty
  `).bind(SCORE_STAGE).first<{ score_queue_nonempty: unknown }>();
  return row !== null && Number(row.score_queue_nonempty) === 0;
}

function contractIdentity(contract: PreferenceV2InferenceContract): string {
  return serializeCanonicalJson({
    schemaIdentity: contract.schemaIdentity,
    activationEventIdentity: contract.activationEventIdentity,
    modelArtifactIdentity: contract.modelArtifactIdentity,
    modelConfigurationIdentity: contract.modelConfigurationIdentity,
    modelVersion: contract.modelVersion,
    featureVersion: contract.featureVersion,
    implementationIdentity: contract.implementationIdentity,
    runtimeIdentity: contract.runtimeIdentity,
    requiredRuntimeIdentities: contract.requiredRuntimeIdentities,
    profileVersionId: contract.profileVersionId,
    profilePriorHash: contract.profilePriorHash,
    activeOriginCacheKey: contract.activeOriginCacheKey,
    routeProviderName: contract.routeProviderName,
    routeEstimatorVersion: contract.routeEstimatorVersion,
    routeNormalizationVersion: contract.routeNormalizationVersion,
    routeDatasetIdentity: contract.routeDatasetIdentity,
    enrichmentTargetIdentity: contract.enrichmentTargetIdentity,
  });
}

function receiptIdentityPayload(
  contract: PreferenceV2InferenceContract,
  vector: PipelineGenerationVector,
  audit: PreferenceV2CoverageAudit,
  derived: DerivedVectorFields,
  boundary: Required<PreferenceV2CoverageDatabaseBoundary>,
  priorReceiptId: string | null,
  derivationVersion: string,
): unknown {
  return {
    contract,
    generationVector: vector.entries,
    audit,
    derived,
    databaseBoundary: boundary,
    priorReceiptId,
    derivationVersion,
  };
}

async function receiptFromRow(row: CoverageReceiptRow): Promise<PreferenceV2CoverageReceipt> {
  const requiredRuntimeIdentities = JSON.parse(
    boundedText(row.required_runtime_identities_json, "Stored runtime identities JSON", 16_384),
  ) as Record<string, string>;
  const contract = validateContract({
    schemaIdentity: row.schema_identity as PreferenceV2InferenceContract["schemaIdentity"],
    activationEventIdentity: row.activation_event_identity as string | null,
    modelArtifactIdentity: row.model_artifact_identity as string,
    modelConfigurationIdentity: row.model_configuration_identity as string,
    modelVersion: row.model_version as string,
    featureVersion: row.feature_version as string,
    implementationIdentity: row.implementation_identity as string,
    runtimeIdentity: row.runtime_identity as string,
    requiredRuntimeIdentities,
    profileVersionId: row.profile_version_id as string,
    profilePriorHash: row.profile_prior_hash as Sha256Identity,
    activeOriginCacheKey: row.active_origin_cache_key as string,
    routeProviderName: row.route_provider_name as string,
    routeEstimatorVersion: row.route_estimator_version as string,
    routeNormalizationVersion: row.route_normalization_version as string,
    routeDatasetIdentity: row.route_dataset_identity as string,
    enrichmentTargetIdentity: row.enrichment_target_identity as string,
  });
  const rawEntries = JSON.parse(
    boundedText(row.generation_vector_json, "Stored generation vector JSON", 1_000_000),
  ) as GenerationVectorEntry[];
  const vector = await validateGenerationVector({
    entries: rawEntries,
    canonicalJson: row.generation_vector_json as string,
    hash: row.generation_vector_hash as Sha256Identity,
  });
  const audit = validateAudit({
    eligibleListingCount: row.eligible_listing_count as number,
    eligibleListingIdsHash: row.eligible_listing_ids_hash as Sha256Identity,
    scoreCoverageCount: row.score_coverage_count as number,
    scoreCoverageHash: row.score_coverage_hash as Sha256Identity,
    scoreHeadCount: row.score_head_count as number,
    scoreHeadHash: row.score_head_hash as Sha256Identity,
  });
  const boundary = validateDatabaseBoundary({
    before: row.database_boundary_before as string,
    after: row.database_boundary_after as string,
    dataVersionBefore: row.data_version_before as number | null,
    dataVersionAfter: row.data_version_after as number | null,
  });
  for (const [field, expected] of Object.entries(vector.derived)) {
    const rowField = {
      ownershipGeneration: row.ownership_generation,
      sourceCurrentVectorHash: row.source_current_vector_hash,
      detailLocationGeneration: row.detail_location_generation,
      enrichmentHeadGeneration: row.enrichment_head_generation,
      physicalAssetGeneration: row.physical_asset_generation,
      auctionEventGeneration: row.auction_event_generation,
      semanticFamilyGeneration: row.semantic_family_generation,
      voteGeneration: row.vote_generation,
      cohortGeneration: row.cohort_generation,
      activeHistoryGeneration: row.active_history_generation,
      presentationPolicyGeneration: row.presentation_policy_generation,
      scoreQueueGeneration: row.score_queue_generation,
      scoreQueueHash: row.score_queue_hash,
    }[field as keyof DerivedVectorFields];
    if (rowField !== expected) {
      throw new PreferenceV2CoverageValidationError(
        "receipt_collision",
        `Stored coverage receipt has inconsistent ${field}`,
      );
    }
  }
  if (Number(row.score_queue_empty) !== 1) {
    throw new PreferenceV2CoverageValidationError(
      "receipt_collision",
      "Stored coverage receipt does not assert an empty score queue",
    );
  }
  const priorReceiptId = row.prior_receipt_id === null
    ? null
    : boundedText(row.prior_receipt_id, "Stored prior receipt ID");
  const derivationVersion = boundedText(
    row.derivation_version,
    "Stored coverage derivation version",
    256,
  );
  const completedAt = boundedText(row.completed_at, "Stored completion timestamp", 64);
  const receiptId = sha256Identity(row.receipt_id, "Stored receipt ID");
  const expectedReceiptId = await hashCanonicalJson(receiptIdentityPayload(
    contract,
    vector.vector,
    audit,
    vector.derived,
    boundary,
    priorReceiptId,
    derivationVersion,
  ));
  if (receiptId !== expectedReceiptId) {
    throw new PreferenceV2CoverageValidationError(
      "receipt_collision",
      "Stored coverage receipt ID does not match its immutable evidence",
    );
  }
  return Object.freeze({
    receiptId,
    ...contract,
    ...audit,
    generationVector: vector.vector,
    ...vector.derived,
    scoreQueueEmpty: true,
    databaseBoundaryBefore: boundary.before,
    databaseBoundaryAfter: boundary.after,
    dataVersionBefore: boundary.dataVersionBefore,
    dataVersionAfter: boundary.dataVersionAfter,
    priorReceiptId,
    completedAt,
    derivationVersion,
  });
}

async function readReceipt(
  database: D1Database,
  receiptId: string,
): Promise<PreferenceV2CoverageReceipt | null> {
  const row = await database.prepare(`
    SELECT ${receiptColumns}
    FROM preference_v2_score_coverage_receipts
    WHERE receipt_id = ?
  `).bind(receiptId).first<CoverageReceiptRow>();
  return row === null ? null : receiptFromRow(row);
}

export async function appendPreferenceV2CoverageReceipt(
  input: AppendPreferenceV2CoverageReceiptInput,
): Promise<AppendPreferenceV2CoverageReceiptOutcome> {
  const contract = validateContract(input.contract);
  const { vector, derived } = await validateGenerationVector(input.generationVector);
  const audit = validateAudit(input.audit);
  const boundary = validateDatabaseBoundary(input.databaseBoundary);
  const priorReceiptId = input.priorReceiptId === null || input.priorReceiptId === undefined
    ? null
    : boundedText(input.priorReceiptId, "Prior receipt ID");
  const derivationVersion = boundedText(
    input.derivationVersion ?? PREFERENCE_V2_COVERAGE_DERIVATION_VERSION,
    "Coverage derivation version",
    256,
  );
  if (!await scoreQueueIsEmpty(input.database)) {
    throw new PreferenceV2CoverageValidationError(
      "score_queue_not_empty",
      "Cannot append a complete Preference V2 coverage receipt while score work remains",
    );
  }
  const receiptId = await hashCanonicalJson(receiptIdentityPayload(
    contract,
    vector,
    audit,
    derived,
    boundary,
    priorReceiptId,
    derivationVersion,
  ));
  const result = await input.database.prepare(`
    INSERT OR IGNORE INTO preference_v2_score_coverage_receipts (
      receipt_id, schema_identity, activation_event_identity,
      model_artifact_identity, model_configuration_identity, model_version,
      feature_version, implementation_identity, runtime_identity,
      required_runtime_identities_json, profile_version_id, profile_prior_hash,
      active_origin_cache_key, route_provider_name, route_estimator_version,
      route_normalization_version, route_dataset_identity, ownership_generation,
      source_current_vector_hash, detail_location_generation,
      enrichment_target_identity, enrichment_head_generation,
      physical_asset_generation, auction_event_generation,
      semantic_family_generation, vote_generation, cohort_generation,
      active_history_generation, presentation_policy_generation,
      generation_vector_json, generation_vector_hash, eligible_listing_count,
      eligible_listing_ids_hash, score_coverage_count, score_coverage_hash,
      score_head_count, score_head_hash, score_queue_generation,
      score_queue_hash, score_queue_empty, database_boundary_before,
      database_boundary_after, data_version_before, data_version_after,
      prior_receipt_id, completed_at, derivation_version
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    receiptId,
    contract.schemaIdentity,
    contract.activationEventIdentity,
    contract.modelArtifactIdentity,
    contract.modelConfigurationIdentity,
    contract.modelVersion,
    contract.featureVersion,
    contract.implementationIdentity,
    contract.runtimeIdentity,
    serializeCanonicalJson(contract.requiredRuntimeIdentities),
    contract.profileVersionId,
    contract.profilePriorHash,
    contract.activeOriginCacheKey,
    contract.routeProviderName,
    contract.routeEstimatorVersion,
    contract.routeNormalizationVersion,
    contract.routeDatasetIdentity,
    derived.ownershipGeneration,
    derived.sourceCurrentVectorHash,
    derived.detailLocationGeneration,
    contract.enrichmentTargetIdentity,
    derived.enrichmentHeadGeneration,
    derived.physicalAssetGeneration,
    derived.auctionEventGeneration,
    derived.semanticFamilyGeneration,
    derived.voteGeneration,
    derived.cohortGeneration,
    derived.activeHistoryGeneration,
    derived.presentationPolicyGeneration,
    vector.canonicalJson,
    vector.hash,
    audit.eligibleListingCount,
    audit.eligibleListingIdsHash,
    audit.scoreCoverageCount,
    audit.scoreCoverageHash,
    audit.scoreHeadCount,
    audit.scoreHeadHash,
    derived.scoreQueueGeneration,
    derived.scoreQueueHash,
    boundary.before,
    boundary.after,
    boundary.dataVersionBefore,
    boundary.dataVersionAfter,
    priorReceiptId,
    isoTimestamp(input.completedAt),
    derivationVersion,
  ).run();
  const receipt = await readReceipt(input.database, receiptId);
  if (receipt === null) {
    throw new Error("Preference V2 coverage receipt insert was not observable");
  }
  return changes(result) > 0
    ? { outcome: "appended", receipt }
    : { outcome: "existing", receipt };
}

export async function readActivePreferenceV2CoverageReceipt(
  database: D1Database,
): Promise<PreferenceV2CoverageHead | null> {
  const row = await database.prepare(`
    SELECT
      ${qualifiedReceiptColumns},
      head.generation_vector_hash AS head_generation_vector_hash,
      head.updated_at AS head_updated_at
    FROM preference_v2_score_coverage_head AS head
    INNER JOIN preference_v2_score_coverage_receipts AS receipt
      ON receipt.receipt_id = head.receipt_id
    WHERE head.singleton = 1
  `).first<CoverageReceiptRow>();
  if (row === null) return null;
  const receipt = await receiptFromRow(row);
  const headHash = sha256Identity(
    row.head_generation_vector_hash,
    "Coverage head generation vector hash",
  );
  if (headHash !== receipt.generationVector.hash) {
    throw new PreferenceV2CoverageValidationError(
      "receipt_collision",
      "Coverage head generation vector does not match its receipt",
    );
  }
  return Object.freeze({
    receiptId: receipt.receiptId,
    generationVectorHash: headHash,
    updatedAt: boundedText(row.head_updated_at, "Coverage head update timestamp", 64),
    receipt,
  });
}

function vectorCurrentSql(): string {
  return `NOT EXISTS (
    SELECT 1
    FROM json_each(?) AS expected
    LEFT JOIN pipeline_generation_state AS state
      ON state.domain = json_extract(expected.value, '$.domain')
      AND state.scope_type = json_extract(expected.value, '$.scopeType')
      AND state.scope_id = json_extract(expected.value, '$.scopeId')
    WHERE state.domain IS NULL
      OR state.generation <> json_extract(expected.value, '$.generation')
      OR state.fingerprint <> json_extract(expected.value, '$.fingerprint')
      OR state.derivation_version <> json_extract(expected.value, '$.derivationVersion')
  )`;
}

export async function conditionallyBindPreferenceV2CoverageHead(input: {
  readonly database: D1Database;
  readonly receiptId: string;
  readonly expectedPriorReceiptId: string | null;
  readonly currentGenerationVector: PipelineGenerationVector;
  readonly databaseBoundary: string;
  readonly now?: Date;
}): Promise<BindPreferenceV2CoverageHeadOutcome> {
  const receiptId = sha256Identity(input.receiptId, "Receipt ID");
  const expectedPriorReceiptId = input.expectedPriorReceiptId === null
    ? null
    : sha256Identity(input.expectedPriorReceiptId, "Expected prior receipt ID");
  const { vector } = await validateGenerationVector(input.currentGenerationVector);
  const databaseBoundary = boundedText(input.databaseBoundary, "Database boundary");
  const now = isoTimestamp(input.now);
  const row = await input.database.prepare(`
    INSERT INTO preference_v2_score_coverage_head (
      singleton, receipt_id, generation_vector_hash, updated_at
    )
    SELECT 1, receipt.receipt_id, receipt.generation_vector_hash, ?
    FROM preference_v2_score_coverage_receipts AS receipt
    WHERE receipt.receipt_id = ?
      AND receipt.generation_vector_hash = ?
      AND receipt.database_boundary_before = ?
      AND receipt.database_boundary_after = ?
      AND ${vectorCurrentSql()}
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_work_items
        WHERE stage = ?
        LIMIT 1
      )
      AND (
        (? IS NULL AND NOT EXISTS (
          SELECT 1 FROM preference_v2_score_coverage_head WHERE singleton = 1
        ))
        OR EXISTS (
          SELECT 1 FROM preference_v2_score_coverage_head
          WHERE singleton = 1 AND receipt_id = ?
        )
      )
    ON CONFLICT(singleton) DO UPDATE SET
      receipt_id = excluded.receipt_id,
      generation_vector_hash = excluded.generation_vector_hash,
      updated_at = excluded.updated_at
    WHERE preference_v2_score_coverage_head.receipt_id <> excluded.receipt_id
    RETURNING receipt_id
  `).bind(
    now,
    receiptId,
    vector.hash,
    databaseBoundary,
    databaseBoundary,
    vector.canonicalJson,
    SCORE_STAGE,
    expectedPriorReceiptId,
    expectedPriorReceiptId,
  ).first<{ receipt_id: unknown }>();
  const activeHead = await readActivePreferenceV2CoverageReceipt(input.database);
  if (row !== null && activeHead?.receiptId === receiptId) {
    return { outcome: "bound", head: activeHead };
  }
  if (activeHead?.receiptId === receiptId) {
    const stillValid = await input.database.prepare(`
      SELECT receipt.receipt_id
      FROM preference_v2_score_coverage_receipts AS receipt
      WHERE receipt.receipt_id = ?
        AND receipt.generation_vector_hash = ?
        AND receipt.database_boundary_before = ?
        AND receipt.database_boundary_after = ?
        AND ${vectorCurrentSql()}
        AND NOT EXISTS (
          SELECT 1 FROM pipeline_work_items
          WHERE stage = ?
          LIMIT 1
        )
    `).bind(
      receiptId,
      vector.hash,
      databaseBoundary,
      databaseBoundary,
      vector.canonicalJson,
      SCORE_STAGE,
    ).first<{ receipt_id: unknown }>();
    if (stillValid !== null) {
      return { outcome: "already_active", head: activeHead };
    }
  }
  return { outcome: "conditional_miss", activeHead };
}

export async function checkPreferenceV2CoverageNoChange(input: {
  readonly database: D1Database;
  readonly contract: PreferenceV2InferenceContract;
  readonly generationVector: PipelineGenerationVector;
  readonly databaseBoundary: string;
}): Promise<PreferenceV2CoverageNoChangeResult> {
  const contract = validateContract(input.contract);
  const { vector } = await validateGenerationVector(input.generationVector);
  const databaseBoundary = boundedText(input.databaseBoundary, "Database boundary");
  const row = await input.database.prepare(`
    SELECT
      ${qualifiedReceiptColumns},
      head.generation_vector_hash AS head_generation_vector_hash,
      head.updated_at AS head_updated_at,
      EXISTS(
        SELECT 1 FROM pipeline_work_items
        WHERE stage = ?
        LIMIT 1
      ) AS score_queue_nonempty,
      NOT (${vectorCurrentSql()}) AS generation_vector_stale
    FROM preference_v2_score_coverage_head AS head
    INNER JOIN preference_v2_score_coverage_receipts AS receipt
      ON receipt.receipt_id = head.receipt_id
    WHERE head.singleton = 1
  `).bind(SCORE_STAGE, vector.canonicalJson).first<CoverageReceiptRow>();
  if (row === null) {
    return { outcome: "dirty", reason: "missing_coverage_head", activeReceiptId: null };
  }
  let receipt: PreferenceV2CoverageReceipt;
  try {
    receipt = await receiptFromRow(row);
  } catch {
    const activeReceiptId = typeof row.receipt_id === "string" &&
        SHA256_IDENTITY_PATTERN.test(row.receipt_id)
      ? row.receipt_id as Sha256Identity
      : null;
    return { outcome: "dirty", reason: "malformed_active_receipt", activeReceiptId };
  }
  if (contractIdentity(receipt) !== contractIdentity(contract)) {
    return {
      outcome: "dirty",
      reason: "contract_identity_mismatch",
      activeReceiptId: receipt.receiptId,
    };
  }
  if (
    receipt.databaseBoundaryBefore !== databaseBoundary ||
    receipt.databaseBoundaryAfter !== databaseBoundary
  ) {
    return {
      outcome: "dirty",
      reason: "database_boundary_mismatch",
      activeReceiptId: receipt.receiptId,
    };
  }
  if (
    receipt.generationVector.hash !== vector.hash ||
    row.head_generation_vector_hash !== vector.hash
  ) {
    return {
      outcome: "dirty",
      reason: "generation_vector_mismatch",
      activeReceiptId: receipt.receiptId,
    };
  }
  if (Number(row.generation_vector_stale) !== 0) {
    return {
      outcome: "dirty",
      reason: "generation_vector_stale",
      activeReceiptId: receipt.receiptId,
    };
  }
  if (Number(row.score_queue_nonempty) !== 0) {
    return {
      outcome: "dirty",
      reason: "score_queue_not_empty",
      activeReceiptId: receipt.receiptId,
    };
  }
  return {
    outcome: "unchanged",
    head: Object.freeze({
      receiptId: receipt.receiptId,
      generationVectorHash: vector.hash,
      updatedAt: boundedText(row.head_updated_at, "Coverage head update timestamp", 64),
      receipt,
    }),
  };
}
