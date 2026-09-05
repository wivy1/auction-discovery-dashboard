import {
  isAiProviderError,
  type TextGenerationProvider,
} from "../ai";
import type { TextExtraction } from "../enrichment/schema";
import type { BinaryVote } from "./profile";

export const INTEREST_PROFILE_NARRATIVE_PROMPT_VERSION =
  "interest-profile-narrative-v2";
export const INTEREST_PROFILE_NARRATIVE_FALLBACK_PROMPT_VERSION =
  "interest-profile-narrative-fallback-v1";

const maximumSignalLabelLength = 120;
const maximumExampleTitleLength = 180;
const maximumEvidenceIdsPerPolarity = 8;

const signalKinds = [
  "industry_domain",
  "asset_class",
  "high_value_signal",
  "negative_signal",
  "sale_scale",
  "condition",
  "tested_status",
] as const;

type ProfileNarrativeSignalKind = (typeof signalKinds)[number];

const signalLimits: Record<ProfileNarrativeSignalKind, number> = {
  industry_domain: 4,
  asset_class: 10,
  high_value_signal: 5,
  negative_signal: 5,
  sale_scale: 2,
  condition: 2,
  tested_status: 2,
};

export interface ProfileNarrativeVoteInput {
  vote: BinaryVote;
  title: string;
  extractionJson: string;
  priceAmountMinor: number | null;
  priceCurrency: string | null;
  priceDisplayText: string | null;
}

export interface ProfileNarrativeSignalExample {
  title: string;
  observedAuctionPrice: string | null;
}

export interface ProfileNarrativeSignalEvidence {
  id: string;
  kind: ProfileNarrativeSignalKind;
  label: string;
  interestedSupport: number;
  interestedRate: number;
  notInterestedSupport: number;
  notInterestedRate: number;
  interestedExample: ProfileNarrativeSignalExample | null;
  notInterestedExample: ProfileNarrativeSignalExample | null;
}

export interface InterestProfileNarrativeEvidence {
  interestedVotes: number;
  notInterestedVotes: number;
  signals: ProfileNarrativeSignalEvidence[];
}

export interface InterestProfileNarrative {
  summary: string;
  positiveEvidenceIds: string[];
  negativeEvidenceIds: string[];
}

export interface InterestProfileNarrativeGeneration {
  narrative: InterestProfileNarrative;
  mode: "generated" | "fallback";
  providerName: string | null;
  modelName: string | null;
  promptVersion:
    | typeof INTEREST_PROFILE_NARRATIVE_PROMPT_VERSION
    | typeof INTEREST_PROFILE_NARRATIVE_FALLBACK_PROMPT_VERSION;
  generatedAt: string;
  failureCode: string | null;
}

interface MutableSignal {
  id: string;
  kind: ProfileNarrativeSignalKind;
  label: string;
  interestedSupport: number;
  notInterestedSupport: number;
  interestedExample: ProfileNarrativeSignalExample | null;
  notInterestedExample: ProfileNarrativeSignalExample | null;
}

interface ProfileNarrativeGenerationInput {
  provider?: TextGenerationProvider;
  evidence: InterestProfileNarrativeEvidence;
  deterministicSeed: string;
}

export function buildInterestProfileNarrativeEvidence(
  votes: readonly ProfileNarrativeVoteInput[],
  constraints: {
    neutralPositiveConcepts?: readonly string[];
    neutralNegativeConcepts?: readonly string[];
  } = {},
): InterestProfileNarrativeEvidence {
  const interestedVotes = votes.filter((vote) => vote.vote === "interested").length;
  const notInterestedVotes = votes.length - interestedVotes;
  const neutralPositive = normalizedConceptSet(
    constraints.neutralPositiveConcepts ?? [],
  );
  const neutralNegative = normalizedConceptSet(
    constraints.neutralNegativeConcepts ?? [],
  );
  const signals = new Map<string, MutableSignal>();

  for (const vote of votes) {
    const extraction = parseExtraction(vote.extractionJson);
    if (!extraction) continue;
    const neutral = vote.vote === "interested" ? neutralPositive : neutralNegative;
    const example = {
      title: redactNeutralConcepts(vote.title, neutral),
      observedAuctionPrice: observedAuctionPrice(vote),
    };
    const rowSignals = uniqueSignals(signalsFromExtraction(extraction))
      .filter((signal) => !neutral.has(normalizeConcept(signal.label)));

    for (const signal of rowSignals) {
      const current = signals.get(signal.id) ?? {
        ...signal,
        interestedSupport: 0,
        notInterestedSupport: 0,
        interestedExample: null,
        notInterestedExample: null,
      };
      if (vote.vote === "interested") {
        current.interestedSupport += 1;
        current.interestedExample ??= example;
      } else {
        current.notInterestedSupport += 1;
        current.notInterestedExample ??= example;
      }
      signals.set(signal.id, current);
    }
  }

  const selected = signalKinds.flatMap((kind) =>
    [...signals.values()]
      .filter((signal) => signal.kind === kind)
      .sort(compareSignals(interestedVotes, notInterestedVotes))
      .slice(0, signalLimits[kind])
  );
  return {
    interestedVotes,
    notInterestedVotes,
    signals: selected.map((signal) => ({
      ...signal,
      interestedRate: supportRate(signal.interestedSupport, interestedVotes),
      notInterestedRate: supportRate(
        signal.notInterestedSupport,
        notInterestedVotes,
      ),
    })),
  };
}

export async function generateInterestProfileNarrative(
  input: ProfileNarrativeGenerationInput,
): Promise<InterestProfileNarrativeGeneration> {
  const fallback = (failureCode: string) =>
    fallbackNarrative(input.evidence, input.deterministicSeed, failureCode);
  if (input.evidence.interestedVotes + input.evidence.notInterestedVotes === 0) {
    return fallback("insufficient_vote_evidence");
  }
  if (!input.provider) return fallback("provider_not_configured");

  let health;
  try {
    health = await input.provider.healthCheck();
  } catch {
    return fallback("health_check_failed");
  }
  if (!health.ok || !health.modelAvailable) {
    return fallback("provider_unavailable");
  }
  if (input.provider.providerName === "ollama" && !input.provider.unload) {
    return fallback("unload_unavailable");
  }

  let generated;
  try {
    generated = await input.provider.generateStructured({
      system: interestProfileNarrativeSystemPrompt,
      prompt: interestProfileNarrativePrompt(input.evidence),
      jsonSchema: interestProfileNarrativeJsonSchema,
      parse: (value) => validateInterestProfileNarrative(value, input.evidence),
      temperature: 0.1,
      maxOutputTokens: 320,
      keepAlive: 0,
    });
  } catch (error) {
    const unloadFailed = !await unloadProvider(input.provider);
    return fallback(
      unloadFailed
        ? "unload_failed"
        : isAiProviderError(error) ? error.code : "generation_failed",
    );
  }
  if (!await unloadProvider(input.provider)) return fallback("unload_failed");

  return {
    narrative: generated.value,
    mode: "generated",
    providerName: generated.providerName,
    modelName: generated.modelName,
    promptVersion: INTEREST_PROFILE_NARRATIVE_PROMPT_VERSION,
    generatedAt: generated.generatedAt,
    failureCode: null,
  };
}

export function validateInterestProfileNarrative(
  value: unknown,
  evidence: InterestProfileNarrativeEvidence,
): InterestProfileNarrative {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("interest profile narrative must be an object");
  }
  const root = value as Record<string, unknown>;
  const expectedKeys = [
    "negative_evidence_ids",
    "positive_evidence_ids",
    "summary",
  ];
  const actualKeys = Object.keys(root).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("interest profile narrative has unexpected fields");
  }

  const summary = boundedSummary(root.summary);
  if (
    !/\byou(?:r|rs|self)?\b/iu.test(summary) ||
    /\b(?:this|the) operator\b/iu.test(summary)
  ) {
    throw new Error(
      "interest profile narrative must address the operator in second person",
    );
  }
  const positiveEvidenceIds = evidenceIds(
    root.positive_evidence_ids,
    "positive_evidence_ids",
  );
  const negativeEvidenceIds = evidenceIds(
    root.negative_evidence_ids,
    "negative_evidence_ids",
  );
  const byId = new Map(evidence.signals.map((signal) => [signal.id, signal]));
  assertEvidenceIds(
    positiveEvidenceIds,
    byId,
    "positive",
    (signal) => signal.interestedSupport > 0,
  );
  assertEvidenceIds(
    negativeEvidenceIds,
    byId,
    "negative",
    (signal) => signal.notInterestedSupport > 0,
  );
  if (
    evidence.interestedVotes > 0 &&
    evidence.signals.some((signal) => signal.interestedSupport > 0) &&
    positiveEvidenceIds.length === 0
  ) {
    throw new Error("generated narrative omitted positive evidence citations");
  }
  if (
    evidence.notInterestedVotes > 0 &&
    evidence.signals.some((signal) => signal.notInterestedSupport > 0) &&
    negativeEvidenceIds.length === 0
  ) {
    throw new Error("generated narrative omitted negative evidence citations");
  }
  return { summary, positiveEvidenceIds, negativeEvidenceIds };
}

export function interestProfileNarrativePrompt(
  evidence: InterestProfileNarrativeEvidence,
): string {
  return [
    "Write one evidence-grounded description of this operator's auction interests.",
    "Return only the requested JSON object.",
    "Use 2 to 4 sentences and 50 to 120 words in one paragraph.",
    "Address the reader directly in second person using 'you' and 'your'; never call them 'the operator' or 'this operator'.",
    "Synthesize higher-level tendencies rather than reciting tags or counts.",
    "Name specific equipment families when supported. Discuss value, rarity, condition, sale scale, or logistics only when the supplied evidence directly supports it.",
    "Within-polarity rates show prevalence despite class imbalance; support counts show repetition. Repeated, contrasting evidence outweighs single examples.",
    "A signal present in both polarities is mixed, not a preference. Describe tendencies, never permanent blacklists or whitelists.",
    "Observed auction prices are source facts at scrape time, not intrinsic values. Do not infer a preference for expensive equipment from one price.",
    "Representative titles may contain '[neutral signal omitted]'; do not reconstruct or speculate about omitted concepts.",
    "Cite exact supplied signal IDs in positive_evidence_ids and negative_evidence_ids. Do not invent IDs.",
    `Evidence:\n${JSON.stringify(evidence)}`,
  ].join("\n");
}

const interestProfileNarrativeSystemPrompt = [
  "You summarize one person's auction-review preferences from bounded structured evidence.",
  "Do not invent equipment, motives, price preferences, or demographic traits.",
  "Keep claims proportional to support and express uncertainty when evidence is mixed or sparse.",
].join(" ");

const interestProfileNarrativeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "positive_evidence_ids", "negative_evidence_ids"],
  properties: {
    summary: {
      type: "string",
      minLength: 1,
      maxLength: 900,
    },
    positive_evidence_ids: {
      type: "array",
      maxItems: maximumEvidenceIdsPerPolarity,
      items: { type: "string", maxLength: 180 },
    },
    negative_evidence_ids: {
      type: "array",
      maxItems: maximumEvidenceIdsPerPolarity,
      items: { type: "string", maxLength: 180 },
    },
  },
} as const;

function signalsFromExtraction(
  extraction: Partial<TextExtraction>,
): Array<{
  id: string;
  kind: ProfileNarrativeSignalKind;
  label: string;
}> {
  const signal = (kind: ProfileNarrativeSignalKind, label: unknown) => {
    if (typeof label !== "string") return null;
    const normalized = normalizeConcept(label).slice(0, maximumSignalLabelLength);
    if (!normalized || normalized === "unknown") return null;
    return { id: `${kind}:${normalized}`, kind, label: normalized };
  };
  const list = (
    kind: ProfileNarrativeSignalKind,
    values: unknown,
  ) => Array.isArray(values)
    ? values.map((value) => signal(kind, value)).filter(nonNullable)
    : [];
  const scaleLabels: Partial<Record<TextExtraction["lot_type"], string>> = {
    single_item: "single item",
    multi_item_lot: "multiple similar items",
    assorted_lot: "mixed or assorted lot",
  };
  const conditionLabels: Partial<Record<TextExtraction["condition"], string>> = {
    new: "new condition",
    used: "used condition",
    untested: "untested condition",
    parts_only: "parts-only condition",
    damaged: "damaged condition",
  };
  const testedLabels: Partial<Record<TextExtraction["tested_status"], string>> = {
    tested_working: "tested working",
    powers_on: "powers on",
    untested: "untested",
    not_working: "not working",
  };
  return [
    signal("industry_domain", extraction.industry_domain),
    ...list("asset_class", extraction.asset_classes),
    ...list("high_value_signal", extraction.high_value_signals),
    ...list("negative_signal", extraction.negative_signals),
    signal(
      "sale_scale",
      extraction.lot_type ? scaleLabels[extraction.lot_type] : null,
    ),
    signal(
      "condition",
      extraction.condition ? conditionLabels[extraction.condition] : null,
    ),
    signal(
      "tested_status",
      extraction.tested_status ? testedLabels[extraction.tested_status] : null,
    ),
  ].filter(nonNullable);
}

function parseExtraction(value: string): Partial<TextExtraction> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Partial<TextExtraction>
      : null;
  } catch {
    return null;
  }
}

function uniqueSignals<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function compareSignals(
  interestedVotes: number,
  notInterestedVotes: number,
): (left: MutableSignal, right: MutableSignal) => number {
  return (left, right) => {
    const leftRepeated = Math.max(
      left.interestedSupport,
      left.notInterestedSupport,
    );
    const rightRepeated = Math.max(
      right.interestedSupport,
      right.notInterestedSupport,
    );
    const leftContrast = Math.abs(
      supportRate(left.interestedSupport, interestedVotes) -
        supportRate(left.notInterestedSupport, notInterestedVotes),
    );
    const rightContrast = Math.abs(
      supportRate(right.interestedSupport, interestedVotes) -
        supportRate(right.notInterestedSupport, notInterestedVotes),
    );
    return rightRepeated - leftRepeated ||
      rightContrast - leftContrast ||
      right.interestedSupport + right.notInterestedSupport -
        (left.interestedSupport + left.notInterestedSupport) ||
      left.label.localeCompare(right.label);
  };
}

function fallbackNarrative(
  evidence: InterestProfileNarrativeEvidence,
  deterministicSeed: string,
  failureCode: string,
): InterestProfileNarrativeGeneration {
  const positive = directionalSignals(evidence, "positive").slice(0, 2);
  const negative = directionalSignals(evidence, "negative").slice(0, 2);
  const positiveTheme = positive.length > 0
    ? naturalList(positive.map((signal) => fallbackLabel(signal.label)))
    : "no stable positive equipment theme yet";
  const negativeTheme = negative.length > 0
    ? naturalList(negative.map((signal) => fallbackLabel(signal.label)))
    : "no stable rejection theme yet";
  const summary = [
    `Your completed reviews currently lean toward ${positiveTheme}, with repeated Interested votes carrying more weight than isolated labels.`,
    `You more often pass on ${negativeTheme}, while signals that appear on both sides remain mixed rather than becoming permanent rules.`,
    `This cautious summary draws on ${evidence.interestedVotes} Interested and ${evidence.notInterestedVotes} Not interested votes and preserves uncertainty where the evidence is sparse.`,
  ].join(" ");
  return {
    narrative: {
      summary: boundedFallbackSummary(summary, deterministicSeed),
      positiveEvidenceIds: positive
        .map((signal) => signal.id)
        .slice(0, maximumEvidenceIdsPerPolarity),
      negativeEvidenceIds: negative
        .map((signal) => signal.id)
        .slice(0, maximumEvidenceIdsPerPolarity),
    },
    mode: "fallback",
    providerName: null,
    modelName: null,
    promptVersion: INTEREST_PROFILE_NARRATIVE_FALLBACK_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    failureCode,
  };
}

function directionalSignals(
  evidence: InterestProfileNarrativeEvidence,
  polarity: "positive" | "negative",
): ProfileNarrativeSignalEvidence[] {
  const support = polarity === "positive"
    ? (signal: ProfileNarrativeSignalEvidence) => signal.interestedSupport
    : (signal: ProfileNarrativeSignalEvidence) => signal.notInterestedSupport;
  const rate = polarity === "positive"
    ? (signal: ProfileNarrativeSignalEvidence) => signal.interestedRate
    : (signal: ProfileNarrativeSignalEvidence) => signal.notInterestedRate;
  const oppositeRate = polarity === "positive"
    ? (signal: ProfileNarrativeSignalEvidence) => signal.notInterestedRate
    : (signal: ProfileNarrativeSignalEvidence) => signal.interestedRate;
  return evidence.signals
    .filter((signal) => support(signal) > 0 && rate(signal) >= oppositeRate(signal))
    .sort((left, right) =>
      support(right) - support(left) ||
      rate(right) - oppositeRate(right) - (rate(left) - oppositeRate(left)) ||
      left.label.localeCompare(right.label)
    );
}

function boundedSummary(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("interest profile summary must be a string");
  }
  const summary = value.trim();
  if (!summary || /[\r\n]/u.test(summary)) {
    throw new Error("interest profile summary must be one non-empty paragraph");
  }
  const words = wordCount(summary);
  if (words < 50 || words > 120) {
    throw new Error("interest profile summary must contain 50 to 120 words");
  }
  const sentences = summary.match(/[.!?](?=\s|$)/gu)?.length ?? 0;
  if (sentences < 2 || sentences > 4) {
    throw new Error("interest profile summary must contain 2 to 4 sentences");
  }
  return summary;
}

function boundedFallbackSummary(summary: string, deterministicSeed: string): string {
  if (wordCount(summary) >= 50 && wordCount(summary) <= 120) return summary;
  const seed = deterministicSeed.trim().replace(/\s+/gu, " ");
  const supplemented = `${summary} ${seed}`;
  return wordCount(supplemented) <= 120
    ? supplemented
    : summary;
}

function fallbackLabel(value: string): string {
  return value.slice(0, 48).trim();
}

function evidenceIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${field} entries must be non-empty strings`);
    }
    return entry.trim();
  });
  if (ids.length > maximumEvidenceIdsPerPolarity) {
    throw new Error(`${field} exceeds its bounded citation count`);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${field} contains duplicate citations`);
  }
  return ids;
}

function assertEvidenceIds(
  ids: readonly string[],
  byId: ReadonlyMap<string, ProfileNarrativeSignalEvidence>,
  polarity: string,
  supportsPolarity: (signal: ProfileNarrativeSignalEvidence) => boolean,
): void {
  for (const id of ids) {
    const signal = byId.get(id);
    if (!signal || !supportsPolarity(signal)) {
      throw new Error(`generated narrative cited invalid ${polarity} evidence`);
    }
  }
}

function observedAuctionPrice(
  vote: ProfileNarrativeVoteInput,
): string | null {
  const display = vote.priceDisplayText?.trim();
  if (display) return display.slice(0, 80);
  if (
    vote.priceAmountMinor === null ||
    !Number.isSafeInteger(vote.priceAmountMinor) ||
    !vote.priceCurrency?.trim()
  ) return null;
  return `${vote.priceCurrency.trim().toUpperCase()} ${(vote.priceAmountMinor / 100).toFixed(2)}`;
}

function redactNeutralConcepts(
  value: string,
  concepts: ReadonlySet<string>,
): string {
  let redacted = value.trim().slice(0, maximumExampleTitleLength);
  for (const concept of [...concepts].sort((left, right) => right.length - left.length)) {
    const pattern = concept
      .split(/\s+/gu)
      .map(escapeRegularExpression)
      .join("\\s+");
    redacted = redacted.replace(
      new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`, "giu"),
      "$1[neutral signal omitted]",
    );
  }
  return redacted.trim() || "Representative listing";
}

function normalizedConceptSet(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeConcept).filter(Boolean));
}

function normalizeConcept(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll("_", " ").replace(/\s+/gu, " ");
}

function supportRate(support: number, total: number): number {
  return total > 0 ? Math.round(support / total * 10_000) / 10_000 : 0;
}

function naturalList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function wordCount(value: string): number {
  return value.match(/\S+/gu)?.length ?? 0;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function nonNullable<T>(value: T | null): value is T {
  return value !== null;
}

async function unloadProvider(provider: TextGenerationProvider): Promise<boolean> {
  if (!provider.unload) return provider.providerName !== "ollama";
  try {
    await provider.unload();
    return true;
  } catch {
    return false;
  }
}
