export type BinaryVote = "interested" | "not_interested";

export const PROFILE_SIGNAL_RESIDUAL_VERSION = "concept-residual-v1-min2";

export interface VotedEmbedding {
  vote: BinaryVote;
  vector: number[];
  concepts: string[];
  listingId: number;
  title: string;
}

export interface ProfileSignalConstraints {
  neutralPositiveConcepts?: readonly string[];
  neutralNegativeConcepts?: readonly string[];
}

export interface ConceptSummary {
  concept: string;
  support: number;
  confidence: number;
  examples: Array<{ listingId: number; title: string }>;
}

export interface LearnedProfile {
  positiveCentroid: number[] | null;
  negativeCentroid: number[] | null;
  positiveResidualBasis: number[][];
  negativeResidualBasis: number[][];
  appliedPositiveNeutralConcepts: string[];
  appliedNegativeNeutralConcepts: string[];
  skippedPositiveNeutralConcepts: string[];
  skippedNegativeNeutralConcepts: string[];
  positiveConcepts: ConceptSummary[];
  negativeConcepts: ConceptSummary[];
  positiveExamples: number;
  negativeExamples: number;
}

export interface RankingResult {
  score: number;
  positiveSimilarity: number | null;
  negativeSimilarity: number | null;
  exploration: boolean;
  explanation: string;
}

export function interestProfileSummary(profile: LearnedProfile): string {
  const positives = profile.positiveConcepts.slice(0, 4).map((entry) => entry.concept);
  const negatives = profile.negativeConcepts.slice(0, 4).map((entry) => entry.concept);
  const sentences: string[] = [];

  if (positives.length > 0) {
    sentences.push(`Your reviews currently point toward ${naturalList(positives)}.`);
  } else {
    sentences.push("Your reviews do not yet show a clear positive interest pattern.");
  }
  if (negatives.length > 0) {
    sentences.push(`You tend to pass on listings involving ${naturalList(negatives)}.`);
  }
  if (profile.positiveExamples < 3) {
    sentences.push("The positive side is still narrow, so marking a few more listings Interested will make recommendations more specific.");
  }
  return sentences.join(" ");
}

export function cosineSimilarity(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  if (normA === 0 || normB === 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function centroid(vectors: number[][]): number[] | null {
  const dimension = vectors[0]?.length ?? 0;
  const valid = vectors.filter((vector) => vector.length === dimension && dimension > 0);
  if (valid.length === 0) return null;
  return Array.from({ length: dimension }, (_, index) =>
    valid.reduce((sum, vector) => sum + vector[index], 0) / valid.length,
  );
}

function normalizeConcept(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const minimumNeutralConceptGroupSize = 2;
const projectionEpsilon = 1e-10;

interface ConceptDirectionInventory {
  directions: ReadonlyMap<string, number[]>;
  skipped: ReadonlySet<string>;
}

interface ResidualBasis {
  basis: number[][];
  applied: string[];
  skipped: string[];
}

function normalizedUniqueConcepts(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizeConcept).filter(Boolean))).sort();
}

function vectorNorm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value ** 2, 0));
}

function normalizedVector(vector: readonly number[]): number[] | null {
  const norm = vectorNorm(vector);
  if (!Number.isFinite(norm) || norm <= projectionEpsilon) return null;
  return vector.map((value) => value / norm);
}

function dotProduct(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let index = 0; index < a.length; index += 1) dot += a[index]! * b[index]!;
  return dot;
}

function projectOutBasis(vector: readonly number[], basis: readonly number[][]): number[] {
  if (
    basis.length === 0 ||
    basis.some((direction) => direction.length !== vector.length)
  ) return [...vector];
  const projected = [...vector];
  for (const direction of basis) {
    const component = dotProduct(projected, direction);
    for (let index = 0; index < projected.length; index += 1) {
      projected[index] = projected[index]! - component * direction[index]!;
    }
  }
  if (vectorNorm(projected) <= projectionEpsilon) return projected.map(() => 0);
  return projected;
}

/**
 * Learns factual concept directions from all valid voted embeddings, independent
 * of vote polarity. Each direction is the contrast between unit-normalized
 * rows that do and do not contain the exact extracted concept. A minimum of two
 * rows on each side avoids treating one listing as an entire semantic axis.
 */
function learnConceptDirections(
  rows: readonly VotedEmbedding[],
  requestedConcepts: readonly string[],
): ConceptDirectionInventory {
  const requested = normalizedUniqueConcepts(requestedConcepts);
  const requestedSet = new Set(requested);
  const dimension = rows.find((row) => row.vector.length > 0)?.vector.length ?? 0;
  const valid = rows.flatMap((row) => {
    if (dimension === 0 || row.vector.length !== dimension) return [];
    const vector = normalizedVector(row.vector);
    return vector ? [{ row, vector }] : [];
  });
  const total = Array(dimension).fill(0) as number[];
  const matches = new Map<string, { count: number; sum: number[] }>();
  for (const concept of requested) {
    matches.set(concept, { count: 0, sum: Array(dimension).fill(0) as number[] });
  }
  for (const entry of valid) {
    for (let index = 0; index < dimension; index += 1) {
      total[index] = total[index]! + entry.vector[index]!;
    }
    const rowMatches = new Set(entry.row.concepts
      .map(normalizeConcept)
      .filter((concept) => requestedSet.has(concept)));
    for (const concept of rowMatches) {
      const accumulator = matches.get(concept)!;
      accumulator.count += 1;
      for (let index = 0; index < dimension; index += 1) {
        accumulator.sum[index] = accumulator.sum[index]! + entry.vector[index]!;
      }
    }
  }

  const directions = new Map<string, number[]>();
  const skipped = new Set<string>();
  for (const concept of requested) {
    const match = matches.get(concept)!;
    const absentCount = valid.length - match.count;
    if (
      match.count < minimumNeutralConceptGroupSize ||
      absentCount < minimumNeutralConceptGroupSize
    ) {
      skipped.add(concept);
      continue;
    }
    const direction = match.sum.map((sum, index) =>
      sum / match.count - (total[index]! - sum) / absentCount
    );
    const normalized = normalizedVector(direction);
    if (!normalized) {
      skipped.add(concept);
      continue;
    }
    directions.set(concept, normalized);
  }
  return { directions, skipped };
}

function buildResidualBasis(
  requestedConcepts: readonly string[],
  inventory: ConceptDirectionInventory,
): ResidualBasis {
  const requested = normalizedUniqueConcepts(requestedConcepts);
  const basis: number[][] = [];
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const concept of requested) {
    const direction = inventory.directions.get(concept);
    if (!direction || inventory.skipped.has(concept)) {
      skipped.push(concept);
      continue;
    }
    const residual = projectOutBasis(direction, basis);
    const normalizedResidual = normalizedVector(residual);
    if (normalizedResidual) basis.push(normalizedResidual);
    // A collinear direction is already removed by the existing joint span.
    applied.push(concept);
  }
  return { basis, applied, skipped };
}

function maskedEvidenceConcepts(
  rows: readonly VotedEmbedding[],
  removedConcepts: readonly string[],
): VotedEmbedding[] {
  const removed = new Set(normalizedUniqueConcepts(removedConcepts));
  if (removed.size === 0) return [...rows];
  return rows.map((row) => ({
    ...row,
    concepts: row.concepts.filter((concept) => !removed.has(normalizeConcept(concept))),
  }));
}

function summarizeConcepts(
  rows: VotedEmbedding[],
  minimumSupport: number,
): ConceptSummary[] {
  const counts = new Map<string, { support: number; examples: Map<number, string> }>();
  for (const row of rows) {
    const unique = new Set(row.concepts.map(normalizeConcept).filter(Boolean));
    for (const concept of unique) {
      const entry = counts.get(concept) ?? { support: 0, examples: new Map<number, string>() };
      entry.support += 1;
      entry.examples.set(row.listingId, row.title);
      counts.set(concept, entry);
    }
  }

  const denominator = Math.max(rows.length, 1);
  return Array.from(counts, ([concept, value]) => ({
    concept,
    support: value.support,
    confidence: Math.min(0.98, value.support / denominator),
    examples: Array.from(value.examples, ([listingId, title]) => ({ listingId, title })).slice(0, 3),
  }))
    .filter((entry) => entry.support >= minimumSupport)
    .sort((a, b) => b.support - a.support || a.concept.localeCompare(b.concept));
}

export function learnProfile(
  rows: VotedEmbedding[],
  constraints: ProfileSignalConstraints = {},
): LearnedProfile {
  const positive = rows.filter((row) => row.vote === "interested");
  const negative = rows.filter((row) => row.vote === "not_interested");
  const neutralPositiveConcepts = normalizedUniqueConcepts(
    constraints.neutralPositiveConcepts ?? [],
  );
  const neutralNegativeConcepts = normalizedUniqueConcepts(
    constraints.neutralNegativeConcepts ?? [],
  );
  const conceptDirections = learnConceptDirections(rows, [
    ...neutralPositiveConcepts,
    ...neutralNegativeConcepts,
  ]);
  const positiveResidual = buildResidualBasis(
    neutralPositiveConcepts,
    conceptDirections,
  );
  const negativeResidual = buildResidualBasis(
    neutralNegativeConcepts,
    conceptDirections,
  );
  const rawPositiveCentroid = centroid(positive.map((row) => row.vector));
  const rawNegativeCentroid = negative.length >= 3
    ? centroid(negative.map((row) => row.vector))
    : null;
  const positiveConceptEvidence = maskedEvidenceConcepts(
    positive,
    neutralPositiveConcepts,
  );
  const negativeConceptEvidence = maskedEvidenceConcepts(
    negative,
    neutralNegativeConcepts,
  );
  return {
    positiveCentroid: rawPositiveCentroid
      ? projectOutBasis(rawPositiveCentroid, positiveResidual.basis)
      : null,
    // Binary negative labels are intentionally noisy. Do not construct a
    // negative direction until there are at least three examples.
    negativeCentroid: rawNegativeCentroid
      ? projectOutBasis(rawNegativeCentroid, negativeResidual.basis)
      : null,
    positiveResidualBasis: positiveResidual.basis,
    negativeResidualBasis: negativeResidual.basis,
    appliedPositiveNeutralConcepts: positiveResidual.applied,
    appliedNegativeNeutralConcepts: negativeResidual.applied,
    skippedPositiveNeutralConcepts: positiveResidual.skipped,
    skippedNegativeNeutralConcepts: negativeResidual.skipped,
    positiveConcepts: summarizeConcepts(positiveConceptEvidence, 1),
    negativeConcepts: summarizeConcepts(negativeConceptEvidence, 1),
    positiveExamples: positive.length,
    negativeExamples: negative.length,
  };
}

export function rankEmbedding(
  vector: number[],
  profile: LearnedProfile,
  options: {
    listingId?: number;
    explorationRate?: number;
    matchingConcepts?: string[];
    matchingNegativeConcepts?: string[];
  } = {},
): RankingResult {
  const positive = profile.positiveCentroid
    ? cosineSimilarity(
        projectOutBasis(vector, profile.positiveResidualBasis),
        profile.positiveCentroid,
      )
    : null;
  const negative = profile.negativeCentroid
    ? cosineSimilarity(
        projectOutBasis(vector, profile.negativeResidualBasis),
        profile.negativeCentroid,
      )
    : null;
  const explorationRate = Math.max(0, Math.min(options.explorationRate ?? 0.12, 0.5));
  const listingSeed = Math.abs(options.listingId ?? 0) % 100;
  const exploration = listingSeed < Math.round(explorationRate * 100);

  // Similarities range from -1 to 1. A weak negative penalty prevents noisy
  // binary dislikes from overwhelming positive evidence.
  const semantic = positive === null ? 0 : positive;
  const penalty = negative === null ? 0 : Math.max(0, negative) * 0.28;
  const matches = uniqueConcepts(options.matchingConcepts ?? []);
  const negativeMatches = uniqueConcepts(options.matchingNegativeConcepts ?? []);
  const conceptAdjustment = (matches.length > 0 ? 3 : 0) - (negativeMatches.length > 0 ? 3 : 0);
  let score = 50 + semantic * 42 - penalty * 42 + conceptAdjustment;
  if (exploration) score = Math.max(score, 58);
  score = Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;

  const mixedMatches = matches.filter((concept) => negativeMatches.includes(concept));
  const positiveOnlyMatches = matches.filter((concept) => !mixedMatches.includes(concept));
  const negativeOnlyMatches = negativeMatches.filter((concept) => !mixedMatches.includes(concept));
  const explanation = conciseRankingExplanation({
    positive,
    exploration,
    positiveOnlyMatches,
    negativeOnlyMatches,
    mixedMatches,
  });

  return {
    score,
    positiveSimilarity: positive,
    negativeSimilarity: negative,
    exploration,
    explanation,
  };
}

function conciseRankingExplanation(input: {
  positive: number | null;
  exploration: boolean;
  positiveOnlyMatches: readonly string[];
  negativeOnlyMatches: readonly string[];
  mixedMatches: readonly string[];
}): string {
  const positiveCues = humanConcepts(input.positiveOnlyMatches)
    .filter((concept) => !isNegativeConditionConcept(concept));
  if (positiveCues.length > 0 && input.positive !== null && input.positive >= 0.65) {
    return `${sentenceCase(positiveCues[0]!)} matches your interests.`;
  }

  const negativeCues = humanConcepts([
    ...input.negativeOnlyMatches,
    ...input.positiveOnlyMatches.filter(isNegativeConditionConcept),
  ]);
  const missing = negativeCues.some((concept) => /\b(?:missing|incomplete)\b/iu.test(concept));
  const repair = negativeCues.some((concept) =>
    /\b(?:repairs?|broken|damaged|not working|non-working|nonworking|inoperable|parts only)\b/iu.test(concept)
  );
  if (missing && repair) return "Incomplete and likely to need repairs.";
  if (repair) return "Damaged or likely to need repairs.";
  if (missing) return "Incomplete or missing parts.";
  if (negativeCues.length > 0) {
    return `Your reviews often reject ${negativeCues[0]!}.`;
  }

  if (positiveCues.length > 0) return `${sentenceCase(positiveCues[0]!)} may match your interests.`;

  const mixedCues = humanConcepts(input.mixedMatches).slice(0, 2);
  if (mixedCues.length > 0) {
    return `${sentenceCase(naturalList(mixedCues))} ${mixedCues.length === 1 ? "has" : "have"} mixed review history.`;
  }
  if (input.positive !== null) return "Similar to equipment you marked Interested.";
  if (input.exploration) return "Shown to explore a new equipment type.";
  return "Not enough interest evidence for a clear ranking.";
}

function naturalList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function uniqueConcepts(values: readonly string[]): string[] {
  return Array.from(new Set(values.map(normalizeConcept).filter(Boolean)));
}

function humanConcepts(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => {
    const concept = normalizeConcept(value).replaceAll("_", " ");
    return ({
      medical: "medical equipment",
      laboratory: "laboratory equipment",
      industrial: "industrial equipment",
    } as Record<string, string>)[concept] ?? concept;
  }).filter(Boolean)));
}

function sentenceCase(value: string): string {
  return value ? `${value[0]!.toLocaleUpperCase()}${value.slice(1)}` : value;
}

function isNegativeConditionConcept(value: string): boolean {
  return /\b(?:missing|incomplete|repairs?|broken|damaged|not working|non-working|nonworking|inoperable|parts only)\b/iu.test(
    normalizeConcept(value).replaceAll("_", " "),
  );
}
