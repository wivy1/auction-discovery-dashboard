import { stableContentHash } from "../sources/parsing";

export const ADHOC_REVIEW_SELECTION_VERSION =
  "adhoc-review-selection-v1";
export const ADHOC_REVIEW_SOURCE_EXCLUSION_POLICY_VERSION =
  "distance-exempt-source-exclusion-v1";
export const ADHOC_REVIEW_GLOBAL_LIMIT = 5_000;
export const ADHOC_REVIEW_PER_SOURCE_LIMIT = 1_000;

export interface AdhocReviewSelectionPolicy {
  readonly excludedSourceIds: readonly string[];
  readonly selectionSeed: string;
  readonly selectionVersion: string;
}

export interface AdhocReviewCandidate {
  readonly listingId: string;
  readonly sourceId: string;
  readonly inventoryRunId: string;
  readonly category: string | null;
  readonly state: string | null;
  readonly discoveredAt: string;
  readonly ordinaryAccepted: boolean;
  readonly voted: boolean;
  readonly hasDetail: boolean;
  readonly hasDetailObservation: boolean;
  readonly presentationReady: boolean;
  readonly baseSelected: boolean;
}

export interface AdhocReviewSelection extends AdhocReviewCandidate {
  readonly basis: "ordinary_accepted" | "distance_exempt";
  readonly categoryStratum: string;
  readonly stateStratum: string;
  readonly stableSelectionKey: string;
  readonly ordinal: number;
}

function normalizeSourceIdValues(values: readonly string[]): string[] {
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError("excluded ad hoc review source IDs must be nonempty strings");
    }
    return value.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("excluded ad hoc review source IDs must be unique");
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

/**
 * Normalizes the opt-in one-run policy at the request boundary. The caller
 * supplies the live registry so retired, misspelled, or invented source IDs
 * cannot silently reduce the cohort.
 */
export function normalizeAdhocReviewExcludedSourceIds(
  value: unknown,
  registeredSourceIds: Iterable<string>,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("excludeSourceIds must be an array");
  }
  const registered = new Set(registeredSourceIds);
  if (value.length > registered.size) {
    throw new RangeError(
      `excludeSourceIds may contain at most ${registered.size} registered sources`,
    );
  }
  const normalized = normalizeSourceIdValues(value as string[]);
  const unknown = normalized.find((sourceId) => !registered.has(sourceId));
  if (unknown) {
    throw new TypeError(`Unknown excluded ad hoc review source: ${unknown}`);
  }
  return normalized;
}

/**
 * Encodes the exact normalized exclusions into existing durable provenance.
 * The empty-policy branch deliberately returns the historical seed/version
 * byte-for-byte.
 */
export function adhocReviewSelectionPolicy(
  seed: string,
  excludedSourceIds: readonly string[] = [],
): AdhocReviewSelectionPolicy {
  const normalized = normalizeSourceIdValues(excludedSourceIds);
  if (normalized.length === 0) {
    return {
      excludedSourceIds: normalized,
      selectionSeed: seed,
      selectionVersion: ADHOC_REVIEW_SELECTION_VERSION,
    };
  }
  const selectionSeed =
    `${seed}|${ADHOC_REVIEW_SOURCE_EXCLUSION_POLICY_VERSION}:${normalized.join(",")}`;
  if (selectionSeed.length > 200) {
    throw new TypeError(
      "ad hoc review seed plus exact source exclusions must contain at most 200 characters",
    );
  }
  return {
    excludedSourceIds: normalized,
    selectionSeed,
    selectionVersion:
      `${ADHOC_REVIEW_SELECTION_VERSION}+${ADHOC_REVIEW_SOURCE_EXCLUSION_POLICY_VERSION}`,
  };
}

function stratum(value: string | null, fallback: string): string {
  const normalized = value?.trim().toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .slice(0, 160);
  return normalized || fallback;
}

function preparationRank(
  candidate: AdhocReviewCandidate,
  refreshBoundary: string,
): number {
  const fresh = candidate.discoveredAt >= refreshBoundary;
  const completeDetail = candidate.hasDetail && candidate.hasDetailObservation;
  if (fresh && completeDetail && candidate.presentationReady) return 0;
  if (!fresh && completeDetail && candidate.presentationReady) return 1;
  if (fresh && completeDetail) return 2;
  if (!fresh && completeDetail) return 3;
  return fresh ? 4 : 5;
}

function selectionKey(seed: string, listingId: string): string {
  return stableContentHash([
    ADHOC_REVIEW_SELECTION_VERSION,
    seed,
    listingId,
  ]);
}

function sourceQueue(
  candidates: readonly AdhocReviewCandidate[],
  seed: string,
  refreshBoundary: string,
): Array<AdhocReviewCandidate & {
  categoryStratum: string;
  stateStratum: string;
  stableSelectionKey: string;
}> {
  const prepared = candidates.map((candidate) => ({
    ...candidate,
    categoryStratum: stratum(candidate.category, "uncategorized"),
    stateStratum: stratum(candidate.state, "unknown-state"),
    stableSelectionKey: selectionKey(seed, candidate.listingId),
    rank: preparationRank(candidate, refreshBoundary),
  }));
  const output: typeof prepared = [];
  for (let rank = 0; rank <= 5; rank += 1) {
    const strata = new Map<string, typeof prepared>();
    for (const candidate of prepared) {
      if (candidate.rank !== rank) continue;
      const key = `${candidate.categoryStratum}\u0000${candidate.stateStratum}`;
      const values = strata.get(key) ?? [];
      values.push(candidate);
      strata.set(key, values);
    }
    const orderedStrata = [...strata.entries()]
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [, values] of orderedStrata) {
      values.sort((left, right) =>
        left.stableSelectionKey.localeCompare(right.stableSelectionKey) ||
        left.listingId.localeCompare(right.listingId)
      );
    }
    let emitted = true;
    while (emitted) {
      emitted = false;
      for (const [, values] of orderedStrata) {
        const candidate = values.shift();
        if (!candidate) continue;
        output.push(candidate);
        emitted = true;
      }
    }
  }
  return output;
}

/**
 * Selects one deterministic, source-balanced and category/state-diverse
 * physical cohort. Ordinary accepted rows and an optional earlier immutable
 * cohort are retained first; additions maximize unvoted review capacity.
 */
export function selectAdhocReviewCohort(input: {
  readonly candidates: readonly AdhocReviewCandidate[];
  readonly target: number;
  readonly seed: string;
  readonly refreshBoundary: string;
  readonly sourceLimits?: Readonly<Record<string, number>>;
  readonly excludedSourceIds?: readonly string[];
}): AdhocReviewSelection[] {
  if (
    !Number.isSafeInteger(input.target) || input.target < 1 ||
    input.target > ADHOC_REVIEW_GLOBAL_LIMIT
  ) {
    throw new RangeError("ad hoc review target must be an integer from 1 through 5000");
  }
  if (!input.seed.trim() || input.seed.length > 200) {
    throw new TypeError("ad hoc review seed must contain 1-200 characters");
  }
  if (!Number.isFinite(Date.parse(input.refreshBoundary))) {
    throw new TypeError("ad hoc review refresh boundary must be an ISO timestamp");
  }
  const policy = adhocReviewSelectionPolicy(
    input.seed,
    input.excludedSourceIds,
  );
  const excludedSourceIds = new Set(policy.excludedSourceIds);

  const candidatesById = new Map<string, AdhocReviewCandidate>();
  for (const candidate of input.candidates) {
    if (!candidate.listingId || !candidate.sourceId || !candidate.inventoryRunId) {
      throw new TypeError("ad hoc review candidates require exact listing, source, and publication IDs");
    }
    if (candidatesById.has(candidate.listingId)) {
      throw new Error(`ad hoc review candidate ${candidate.listingId} is duplicated`);
    }
    candidatesById.set(candidate.listingId, candidate);
  }

  const sourceLimit = (sourceId: string): number => {
    const configured = input.sourceLimits?.[sourceId] ??
      ADHOC_REVIEW_PER_SOURCE_LIMIT;
    if (
      !Number.isSafeInteger(configured) || configured < 0 ||
      configured > ADHOC_REVIEW_PER_SOURCE_LIMIT
    ) {
      throw new RangeError(
        `${sourceId} ad hoc review limit must be an integer from 0 through 1000`,
      );
    }
    return configured;
  };

  const excludedDistanceExempt = (candidate: AdhocReviewCandidate): boolean =>
    excludedSourceIds.has(candidate.sourceId) &&
    !candidate.ordinaryAccepted &&
    !candidate.voted;

  const forced = [...candidatesById.values()]
    .filter((candidate) =>
      (candidate.baseSelected || candidate.ordinaryAccepted) &&
      !excludedDistanceExempt(candidate)
    )
    .sort((left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      Number(right.ordinaryAccepted) - Number(left.ordinaryAccepted) ||
      left.listingId.localeCompare(right.listingId)
    );
  if (forced.length > input.target) {
    throw new Error(
      `The ${forced.length}-row retained base exceeds the requested ${input.target}-row target`,
    );
  }

  const selected: Array<AdhocReviewCandidate & {
    categoryStratum: string;
    stateStratum: string;
    stableSelectionKey: string;
  }> = [];
  const selectedIds = new Set<string>();
  const sourceCounts = new Map<string, number>();
  for (const candidate of forced) {
    const count = (sourceCounts.get(candidate.sourceId) ?? 0) + 1;
    if (count > sourceLimit(candidate.sourceId)) {
      throw new Error(
        `${candidate.sourceId} retained base exceeds its per-source limit`,
      );
    }
    sourceCounts.set(candidate.sourceId, count);
    selectedIds.add(candidate.listingId);
    selected.push({
      ...candidate,
      categoryStratum: stratum(candidate.category, "uncategorized"),
      stateStratum: stratum(candidate.state, "unknown-state"),
      stableSelectionKey: selectionKey(policy.selectionSeed, candidate.listingId),
    });
  }

  const queues = new Map<string, ReturnType<typeof sourceQueue>>();
  for (const candidate of candidatesById.values()) {
    if (
      selectedIds.has(candidate.listingId) || candidate.voted ||
      excludedDistanceExempt(candidate)
    ) continue;
    const values = queues.get(candidate.sourceId) ?? [];
    values.push(candidate as ReturnType<typeof sourceQueue>[number]);
    queues.set(candidate.sourceId, values);
  }
  for (const [sourceId, candidates] of queues) {
    queues.set(
      sourceId,
      sourceQueue(candidates, policy.selectionSeed, input.refreshBoundary),
    );
  }

  while (selected.length < input.target) {
    const eligibleSources = [...queues.entries()]
      .filter(([sourceId, queue]) =>
        queue.length > 0 &&
        (sourceCounts.get(sourceId) ?? 0) < sourceLimit(sourceId)
      )
      .sort(([left], [right]) =>
        (sourceCounts.get(left) ?? 0) - (sourceCounts.get(right) ?? 0) ||
        left.localeCompare(right)
      );
    if (eligibleSources.length === 0) break;
    for (const [sourceId, queue] of eligibleSources) {
      if (selected.length >= input.target) break;
      const candidate = queue.shift();
      if (!candidate) continue;
      selected.push(candidate);
      selectedIds.add(candidate.listingId);
      sourceCounts.set(sourceId, (sourceCounts.get(sourceId) ?? 0) + 1);
    }
  }
  if (selected.length < input.target) {
    throw new Error(
      `Only ${selected.length} eligible unvoted review rows fit the requested ${input.target}-row target`,
    );
  }

  return selected.map((candidate, index) => ({
    ...candidate,
    basis: candidate.ordinaryAccepted
      ? "ordinary_accepted"
      : "distance_exempt",
    ordinal: index + 1,
  }));
}
