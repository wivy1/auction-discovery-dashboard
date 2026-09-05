export const REVIEW_PREFERENCE_FILTER_VERSION =
  "profile-negative-concepts-v3";

export const MINIMUM_EXACT_NEGATIVE_SUPPORT = 10;
const GENERIC_ASSET_CLASS_TOKENS = new Set([
  "assorted",
  "device",
  "equipment",
  "industrial",
  "lab",
  "laboratory",
  "machine",
  "medical",
  "miscellaneous",
  "other",
  "supply",
  "system",
  "unit",
]);

export interface ReviewPreferenceConceptEvidence {
  readonly name: string;
  readonly support: number;
}

export interface ReviewPreferenceFilterDecision {
  readonly version: typeof REVIEW_PREFERENCE_FILTER_VERSION;
  readonly profileVersionId: string;
  readonly reason: string;
  readonly support: number;
  readonly matchedConcepts: readonly string[];
}

export interface CompiledReviewPreferenceFilter {
  decide(input: {
    readonly assetClasses: readonly string[];
    readonly exploration: boolean;
  }): ReviewPreferenceFilterDecision | null;
}

export interface ReviewPreferenceVisibilityCandidate {
  readonly vote: string | null;
  readonly recommendationProfileVersionId: string | null;
  readonly recommendationExplanation: string;
  readonly recommendationScore: number | null;
  readonly exploration: boolean;
  readonly assetClasses: () => readonly string[];
}

/**
 * Applies the dashboard's fail-open prerequisites before consulting compiled
 * preference evidence. The asset-class callback stays lazy so voted, unrated, and
 * stale-score rows do not pay for extraction solely to prove visibility.
 */
export function reviewPreferenceVisibilityDecision(
  filter: CompiledReviewPreferenceFilter,
  activeRecommendationProfileVersionId: string | null,
  candidate: ReviewPreferenceVisibilityCandidate,
): ReviewPreferenceFilterDecision | null {
  if (
    candidate.vote === "interested" ||
    candidate.vote === "not_interested" ||
    !activeRecommendationProfileVersionId ||
    candidate.recommendationProfileVersionId !==
      activeRecommendationProfileVersionId ||
    !candidate.recommendationExplanation ||
    candidate.recommendationScore === null ||
    !Number.isFinite(candidate.recommendationScore)
  ) {
    return null;
  }
  return filter.decide({
    assetClasses: candidate.assetClasses(),
    exploration: candidate.exploration,
  });
}

interface SupportedConcept {
  readonly concept: string;
  readonly support: number;
}

interface ReviewPreferenceFilterEvidence {
  readonly exactNegativeConcepts: ReadonlyMap<string, SupportedConcept>;
}

/**
 * Returns a reversible post-preparation omission decision for a fully
 * prepared, unvoted listing. It never decides source membership, currentness,
 * routing, image eligibility, or factual state and never creates a vote.
 *
 * Every extracted primary asset class must have negative-only evidence. Mixed
 * listings, empty extraction, positive overlap, and learned-only exploration
 * rows therefore fail open and remain visible. No asset family is implicitly
 * declared unwanted.
 */
export function reviewPreferenceFilterDecision(input: {
  readonly profileVersionId: string | null;
  readonly positiveConcepts: readonly ReviewPreferenceConceptEvidence[];
  readonly negativeConcepts: readonly ReviewPreferenceConceptEvidence[];
  readonly assetClasses: readonly string[];
  readonly exploration: boolean;
}): ReviewPreferenceFilterDecision | null {
  return compileReviewPreferenceFilter(input).decide(input);
}

/**
 * Compiles immutable profile evidence once for a dashboard read. Callers may
 * then evaluate every candidate without repeatedly normalizing and scanning
 * the same positive/negative concept corpus.
 */
export function compileReviewPreferenceFilter(input: {
  readonly profileVersionId: string | null;
  readonly positiveConcepts: readonly ReviewPreferenceConceptEvidence[];
  readonly negativeConcepts: readonly ReviewPreferenceConceptEvidence[];
}): CompiledReviewPreferenceFilter {
  if (!input.profileVersionId) {
    return { decide: () => null };
  }
  const profileVersionId = input.profileVersionId;
  const evidence = buildReviewPreferenceFilterEvidence(
    input.positiveConcepts,
    input.negativeConcepts,
  );
  return {
    decide(candidate) {
      return decideReviewPreferenceFilter(
        profileVersionId,
        evidence,
        candidate,
      );
    },
  };
}

function decideReviewPreferenceFilter(
  profileVersionId: string,
  evidence: ReviewPreferenceFilterEvidence,
  input: {
    readonly assetClasses: readonly string[];
    readonly exploration: boolean;
  },
): ReviewPreferenceFilterDecision | null {
  const assetClasses = normalizedUniqueConcepts(input.assetClasses);
  if (assetClasses.length === 0) return null;

  const matches = assetClasses.map((assetClass) =>
    matchNegativeAssetClass(assetClass, evidence)
  );
  if (matches.some((match) => match === null)) return null;

  const supported = matches.filter(
    (match): match is SupportedConcept => match !== null,
  );
  if (supported.length === 0) return null;
  if (input.exploration) return null;
  const matchedConcepts = Array.from(
    new Set(supported.map((match) => match.concept)),
  ).sort();
  const support = Math.min(...supported.map((match) => match.support));
  return {
    version: REVIEW_PREFERENCE_FILTER_VERSION,
    profileVersionId,
    reason:
      `Repeated Not interested votes for ${naturalList(matchedConcepts)}`,
    support,
    matchedConcepts,
  };
}

function buildReviewPreferenceFilterEvidence(
  positiveConcepts: readonly ReviewPreferenceConceptEvidence[],
  negativeConcepts: readonly ReviewPreferenceConceptEvidence[],
): ReviewPreferenceFilterEvidence {
  const positiveByConcept = conceptSupport(positiveConcepts);
  const negativeByConcept = conceptSupport(negativeConcepts);
  const exactNegativeConcepts = new Map<string, SupportedConcept>();

  for (const [concept, support] of negativeByConcept) {
    if (
      support >= MINIMUM_EXACT_NEGATIVE_SUPPORT &&
      (positiveByConcept.get(concept) ?? 0) === 0 &&
      !hasMeaningfulPositiveTokenOverlap(concept, positiveByConcept)
    ) {
      exactNegativeConcepts.set(concept, { concept, support });
    }
  }

  return { exactNegativeConcepts };
}

function hasMeaningfulPositiveTokenOverlap(
  negativeConcept: string,
  positiveConcepts: ReadonlyMap<string, number>,
): boolean {
  const meaningfulNegativeTokens = negativeConcept
    .split(" ")
    .filter((token) => token && !GENERIC_ASSET_CLASS_TOKENS.has(token));
  // A class such as "medical supplies" is too heterogeneous to act on even
  // when it has accumulated many negative votes.
  if (meaningfulNegativeTokens.length === 0) return true;

  for (const positiveConcept of positiveConcepts.keys()) {
    const positiveTokens = new Set(positiveConcept.split(" ").filter(Boolean));
    if (meaningfulNegativeTokens.some((token) => positiveTokens.has(token))) {
      return true;
    }
  }
  return false;
}

function matchNegativeAssetClass(
  assetClass: string,
  evidence: ReviewPreferenceFilterEvidence,
): SupportedConcept | null {
  return evidence.exactNegativeConcepts.get(assetClass) ?? null;
}

function conceptSupport(
  concepts: readonly ReviewPreferenceConceptEvidence[],
): ReadonlyMap<string, number> {
  const result = new Map<string, number>();
  for (const entry of concepts) {
    if (!Number.isSafeInteger(entry.support) || entry.support < 0) continue;
    const concept = normalizeConcept(entry.name);
    if (!concept) continue;
    result.set(concept, Math.max(result.get(concept) ?? 0, entry.support));
  }
  return result;
}

function normalizedUniqueConcepts(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map(normalizeConcept).filter(Boolean)),
  ).sort();
}

function normalizeConcept(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/['\u2019]s\b/gu, "")
    .replaceAll("_", " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/gu)
    .map(normalizeToken)
    .filter(Boolean)
    .join(" ");
}

function normalizeToken(value: string): string {
  if (
    value.length > 4 &&
    value.endsWith("ies") &&
    !value.endsWith("eies")
  ) {
    return `${value.slice(0, -3)}y`;
  }
  if (
    value.length > 4 &&
    /(?:ches|shes|sses|xes|zes)$/u.test(value)
  ) {
    return value.slice(0, -2);
  }
  if (
    value.length > 4 &&
    value.endsWith("s") &&
    !value.endsWith("ss") &&
    !value.endsWith("is") &&
    !value.endsWith("us")
  ) {
    return value.slice(0, -1);
  }
  return value;
}

function naturalList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "similar items";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}
