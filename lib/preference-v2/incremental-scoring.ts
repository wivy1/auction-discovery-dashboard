import { hashCanonicalJson, type Sha256Identity } from "../performance/generations";

export const PREFERENCE_V2_INCREMENTAL_SCORING_VERSION =
  "preference-v2-incremental-delta-v1" as const;

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const MAX_DIRTY_LISTINGS = 10;

export interface PreferenceV2ScoreContractIdentity {
  readonly modelVersion: string;
  readonly featureVersion: string;
  readonly runtimeIdentity: string;
}

export interface PreferenceV2ScoringInput {
  readonly listingId: string;
  readonly identityInputHash: string;
  readonly ownershipInputHash: string;
  readonly routeInputHash: string;
  readonly enrichmentInputHash: string;
  readonly modelArtifactIdentity: string;
  readonly featureVersion: string;
  readonly activeOriginCacheKey: string;
  readonly presentationPolicyIdentity: string;
}

export interface PreferenceV2ScoreClaim {
  readonly listingId: string;
  readonly owner: string;
  readonly inputHash: Sha256Identity;
  readonly revision: number;
}

export interface PreferenceV2DeltaSnapshot {
  readonly listingId: string;
  readonly snapshotId: string;
  readonly snapshotHash: Sha256Identity;
  readonly scoringInputHash: Sha256Identity;
}

export interface PreferenceV2DeltaScore extends PreferenceV2DeltaSnapshot {
  readonly modelVersion: string;
  readonly featureVersion: string;
  readonly runtimeIdentity: string;
  readonly score: number;
  readonly baselineScore: number;
  readonly uncertainty: number;
}

export interface PreferenceV2CompactScoringState {
  readonly generationVectorHash: Sha256Identity;
  readonly dataVersion: number;
  readonly databaseBoundary: string;
}

export interface PreferenceV2DeltaMaterialization {
  readonly listingIds: readonly string[];
  readonly snapshots: readonly PreferenceV2DeltaSnapshot[];
  /** Opaque path-like value owned by the caller; never interpreted here. */
  readonly scorerInput: unknown;
}

export type PreferenceV2ScoreCommitOutcome =
  | { readonly listingId: string; readonly outcome: "bound_current" }
  | { readonly listingId: string; readonly outcome: "historical_stale" };

export interface PreferenceV2IncrementalScoringDependencies {
  readonly contract: PreferenceV2ScoreContractIdentity;
  readonly readCompactState: () => Promise<PreferenceV2CompactScoringState>;
  readonly checkNoChange: (
    state: PreferenceV2CompactScoringState,
  ) => Promise<boolean>;
  readonly claimDirtyScores: (
    limit: number,
  ) => Promise<readonly PreferenceV2ScoreClaim[]>;
  readonly materializeDelta: (
    claims: readonly PreferenceV2ScoreClaim[],
  ) => Promise<PreferenceV2DeltaMaterialization>;
  readonly invokePythonOnce: (
    materialization: PreferenceV2DeltaMaterialization,
  ) => Promise<readonly PreferenceV2DeltaScore[]>;
  readonly commitScores: (input: {
    readonly startingState: PreferenceV2CompactScoringState;
    readonly claims: readonly PreferenceV2ScoreClaim[];
    readonly snapshots: readonly PreferenceV2DeltaSnapshot[];
    readonly scores: readonly PreferenceV2DeltaScore[];
  }) => Promise<readonly PreferenceV2ScoreCommitOutcome[]>;
}

export type PreferenceV2IncrementalScoringResult =
  | {
      readonly status: "up_to_date";
      readonly claimedRows: 0;
      readonly scoredRows: 0;
      readonly currentRowsBound: 0;
      readonly historicalStaleRows: 0;
    }
  | {
      readonly status: "scored" | "stale";
      readonly claimedRows: number;
      readonly scoredRows: number;
      readonly currentRowsBound: number;
      readonly historicalStaleRows: number;
    };

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 1_024 ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function sha(value: unknown, label: string): Sha256Identity {
  const valid = text(value, label);
  if (!SHA256.test(valid)) throw new TypeError(`${label} is not a SHA-256 identity`);
  return valid as Sha256Identity;
}

function probability(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be finite and between zero and one`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function exactIds(values: readonly string[], label: string): readonly string[] {
  const normalized = values.map((value, index) => text(value, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate listing IDs`);
  }
  return Object.freeze(normalized);
}

function assertSameIds(
  expected: readonly string[],
  actual: readonly string[],
  label: string,
): void {
  if (
    expected.length !== actual.length ||
    expected.some((listingId, index) => listingId !== actual[index])
  ) {
    throw new Error(`${label} must contain exactly the claimed listing IDs in order`);
  }
}

/**
 * Hashes only real score-affecting identities. Callers deliberately cannot add
 * timestamps, run IDs, source fetch noise, or unrelated immutable evidence.
 */
export async function preferenceV2ScoringInputHash(
  input: PreferenceV2ScoringInput,
): Promise<Sha256Identity> {
  return hashCanonicalJson({
    version: PREFERENCE_V2_INCREMENTAL_SCORING_VERSION,
    listingId: text(input.listingId, "score input listing ID"),
    identityInputHash: sha(input.identityInputHash, "identity input hash"),
    ownershipInputHash: sha(input.ownershipInputHash, "ownership input hash"),
    routeInputHash: sha(input.routeInputHash, "route input hash"),
    enrichmentInputHash: sha(input.enrichmentInputHash, "enrichment input hash"),
    modelArtifactIdentity: text(input.modelArtifactIdentity, "model artifact identity"),
    featureVersion: text(input.featureVersion, "feature version"),
    activeOriginCacheKey: text(input.activeOriginCacheKey, "active origin cache key"),
    presentationPolicyIdentity: text(
      input.presentationPolicyIdentity,
      "presentation policy identity",
    ),
  });
}

export function validatePreferenceV2DeltaScores(input: {
  readonly contract: PreferenceV2ScoreContractIdentity;
  readonly claims: readonly PreferenceV2ScoreClaim[];
  readonly snapshots: readonly PreferenceV2DeltaSnapshot[];
  readonly scores: readonly PreferenceV2DeltaScore[];
}): readonly PreferenceV2DeltaScore[] {
  const claimIds = exactIds(input.claims.map((claim) => claim.listingId), "score claims");
  const snapshotIds = exactIds(
    input.snapshots.map((snapshot) => snapshot.listingId),
    "delta snapshots",
  );
  const scoreIds = exactIds(input.scores.map((score) => score.listingId), "score output");
  assertSameIds(claimIds, snapshotIds, "delta materialization");
  assertSameIds(claimIds, scoreIds, "Python score output");
  const contract = {
    modelVersion: text(input.contract.modelVersion, "model version"),
    featureVersion: text(input.contract.featureVersion, "feature version"),
    runtimeIdentity: text(input.contract.runtimeIdentity, "runtime identity"),
  };
  return Object.freeze(input.scores.map((score, index) => {
    const snapshot = input.snapshots[index]!;
    const claim = input.claims[index]!;
    if (
      score.snapshotId !== snapshot.snapshotId ||
      score.snapshotHash !== snapshot.snapshotHash ||
      score.scoringInputHash !== snapshot.scoringInputHash ||
      snapshot.scoringInputHash !== claim.inputHash
    ) {
      throw new Error(`score identity disagrees for ${claim.listingId}`);
    }
    if (
      score.modelVersion !== contract.modelVersion ||
      score.featureVersion !== contract.featureVersion ||
      score.runtimeIdentity !== contract.runtimeIdentity
    ) {
      throw new Error(`score contract disagrees for ${claim.listingId}`);
    }
    sha(score.snapshotHash, `snapshot hash for ${claim.listingId}`);
    sha(score.scoringInputHash, `scoring input hash for ${claim.listingId}`);
    probability(score.score, `score for ${claim.listingId}`);
    probability(score.baselineScore, `baseline score for ${claim.listingId}`);
    probability(score.uncertainty, `uncertainty for ${claim.listingId}`);
    return Object.freeze({ ...score });
  }));
}

/**
 * Routine path. The compact receipt/generation/queue proof is necessarily read
 * before claiming work and before any delta materializer, Python, or file seam.
 */
export async function runPreferenceV2IncrementalScoring(
  dependencies: PreferenceV2IncrementalScoringDependencies,
): Promise<PreferenceV2IncrementalScoringResult> {
  const startingState = await dependencies.readCompactState();
  if (await dependencies.checkNoChange(startingState)) {
    return Object.freeze({
      status: "up_to_date",
      claimedRows: 0,
      scoredRows: 0,
      currentRowsBound: 0,
      historicalStaleRows: 0,
    });
  }
  const claims = await dependencies.claimDirtyScores(MAX_DIRTY_LISTINGS);
  if (claims.length === 0) {
    throw new Error("Preference V2 coverage is dirty but no exact score work was claimable");
  }
  if (claims.length > MAX_DIRTY_LISTINGS) {
    throw new RangeError(`Preference V2 score batch exceeds ${MAX_DIRTY_LISTINGS} listings`);
  }
  const claimIds = exactIds(claims.map((claim) => claim.listingId), "score claims");
  for (const [index, claim] of claims.entries()) {
    sha(claim.inputHash, `score claim input hash ${index}`);
    if (!Number.isSafeInteger(claim.revision) || claim.revision < 1) {
      throw new TypeError(`score claim revision ${index} is invalid`);
    }
  }
  const materialized = await dependencies.materializeDelta(claims);
  assertSameIds(
    claimIds,
    exactIds(materialized.listingIds, "materialized listing IDs"),
    "delta materialization",
  );
  const scores = validatePreferenceV2DeltaScores({
    contract: dependencies.contract,
    claims,
    snapshots: materialized.snapshots,
    scores: await dependencies.invokePythonOnce(materialized),
  });
  const outcomes = await dependencies.commitScores({
    startingState,
    claims,
    snapshots: materialized.snapshots,
    scores,
  });
  assertSameIds(
    claimIds,
    exactIds(outcomes.map((outcome) => outcome.listingId), "score commit outcomes"),
    "score commit outcomes",
  );
  const currentRowsBound = outcomes.filter(({ outcome }) => outcome === "bound_current").length;
  const historicalStaleRows = outcomes.length - currentRowsBound;
  return Object.freeze({
    status: historicalStaleRows === 0 ? "scored" : "stale",
    claimedRows: claims.length,
    scoredRows: scores.length,
    currentRowsBound,
    historicalStaleRows,
  });
}

export interface PreferenceV2FullScoreAuditDependencies {
  readonly materializeFullAudit: () => Promise<unknown>;
  readonly scoreFullAudit: (materialization: unknown) => Promise<unknown>;
}

/** Explicit rebuild/audit oracle; routine incremental execution never calls it. */
export async function runPreferenceV2FullScoreAudit(
  dependencies: PreferenceV2FullScoreAuditDependencies,
): Promise<unknown> {
  return dependencies.scoreFullAudit(await dependencies.materializeFullAudit());
}
