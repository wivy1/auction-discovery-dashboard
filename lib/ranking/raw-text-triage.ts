import { sha256CanonicalJson } from "../corpus-readiness/primitives";

export const RAW_TEXT_TRIAGE_VERSION = "raw-source-text-triage-v1" as const;

export const RAW_TEXT_TRIAGE_LIMITS = Object.freeze({
  maxIdentityLength: 256,
  maxSourceTextLength: 32_768,
  maxTaxonomyEntries: 64,
  maxTaxonomyEntryLength: 512,
  maxVocabularyVersionLength: 64,
  maxPositiveAnchors: 128,
  maxAnchorLength: 120,
  maxAnchorTokens: 8,
  maxTotalAnchorTokens: 512,
});

export interface RawTextTriageVocabularySnapshot {
  version: string;
  positiveAnchors: readonly string[];
}

export interface RawTextTriageInput {
  listingId: string;
  sourceId: string;
  title?: unknown;
  rawDescription?: unknown;
  cleanDescription?: unknown;
  taxonomy?: unknown;
  vocabulary: RawTextTriageVocabularySnapshot;
}

export type RawTextTriageTier =
  | "positive_title"
  | "positive_description"
  | "positive_taxonomy"
  | "neutral";

/**
 * Internal priority evidence only. It is deliberately not a recommendation or
 * a dashboard score. Larger numeric fields sort first; the hashes sort
 * lexically to make otherwise equal rows deterministic.
 */
export interface RawTextTriageOrdinal {
  channelRank: 0 | 1 | 2 | 3;
  exactPhraseBonus: number;
  positiveAnchorMatches: number;
  positiveTokenCoverage: number;
  listingTieBreak: string;
}

export interface RawTextTriageResult {
  derivationVersion: typeof RAW_TEXT_TRIAGE_VERSION;
  vocabularyVersion: string;
  inputHash: string;
  tier: RawTextTriageTier;
  ordinal: RawTextTriageOrdinal;
  /** Shadow triage is priority-only and never removes a row from processing. */
  admissible: true;
}

type NormalizedSourceText = {
  status: "text" | "blank" | "malformed";
  text: string;
  originalLength: number | null;
  truncated: boolean;
  tokens: string[];
};

type CanonicalVocabulary = {
  version: string;
  positiveAnchors: string[];
  anchors: string[][];
};

type ChannelEvidence = {
  exactPhraseBonus: number;
  positiveAnchorMatches: number;
  positiveTokenCoverage: number;
};

const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const VOCABULARY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeTokens(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").match(WORD_PATTERN) ?? [];
}

function canonicalText(tokens: readonly string[]): string {
  return tokens.join(" ");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeIdentity(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${label} must be nonempty`);
  }
  if (normalized.length > RAW_TEXT_TRIAGE_LIMITS.maxIdentityLength) {
    throw new TypeError(`${label} exceeds the bounded identity length`);
  }
  return normalized;
}

function normalizeSourceText(value: unknown, maxLength: number): NormalizedSourceText {
  if (typeof value !== "string") {
    return {
      status: "malformed",
      text: "",
      originalLength: null,
      truncated: false,
      tokens: [],
    };
  }

  const originalLength = value.length;
  const truncated = originalLength > maxLength;
  const bounded = truncated ? value.slice(0, maxLength) : value;
  const tokens = normalizeTokens(bounded);
  return {
    status: tokens.length === 0 ? "blank" : "text",
    text: canonicalText(tokens),
    originalLength,
    truncated,
    tokens,
  };
}

function normalizeTaxonomy(value: unknown): NormalizedSourceText[] {
  if (!Array.isArray(value)) {
    return [normalizeSourceText(undefined, RAW_TEXT_TRIAGE_LIMITS.maxTaxonomyEntryLength)];
  }
  return value
    .slice(0, RAW_TEXT_TRIAGE_LIMITS.maxTaxonomyEntries)
    .map((entry) =>
      normalizeSourceText(entry, RAW_TEXT_TRIAGE_LIMITS.maxTaxonomyEntryLength),
    );
}

function canonicalizeVocabulary(value: unknown): CanonicalVocabulary {
  if (!isPlainObject(value)) {
    throw new TypeError("Raw-text triage vocabulary must be a plain object");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "positiveAnchors" ||
    keys[1] !== "version"
  ) {
    throw new TypeError(
      "Raw-text triage vocabulary must contain only version and positiveAnchors",
    );
  }

  const version = value.version;
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    version.length > RAW_TEXT_TRIAGE_LIMITS.maxVocabularyVersionLength ||
    !VOCABULARY_VERSION_PATTERN.test(version)
  ) {
    throw new TypeError("Raw-text triage vocabulary version is invalid");
  }

  const positiveAnchors = value.positiveAnchors;
  if (
    !Array.isArray(positiveAnchors) ||
    positiveAnchors.length === 0 ||
    positiveAnchors.length > RAW_TEXT_TRIAGE_LIMITS.maxPositiveAnchors
  ) {
    throw new TypeError("Raw-text triage positive anchors are outside the bounded limit");
  }

  const anchors: string[][] = [];
  const canonicalAnchors = new Set<string>();
  let totalTokens = 0;
  for (const anchor of positiveAnchors) {
    if (
      typeof anchor !== "string" ||
      anchor.length === 0 ||
      anchor.length > RAW_TEXT_TRIAGE_LIMITS.maxAnchorLength
    ) {
      throw new TypeError("Every raw-text triage positive anchor must be a bounded string");
    }
    const tokens = normalizeTokens(anchor);
    if (tokens.length === 0 || tokens.length > RAW_TEXT_TRIAGE_LIMITS.maxAnchorTokens) {
      throw new TypeError("Every raw-text triage positive anchor must contain 1-8 tokens");
    }
    totalTokens += tokens.length;
    if (totalTokens > RAW_TEXT_TRIAGE_LIMITS.maxTotalAnchorTokens) {
      throw new TypeError("Raw-text triage positive anchor tokens exceed the bounded limit");
    }
    const canonical = canonicalText(tokens);
    if (canonicalAnchors.has(canonical)) {
      throw new TypeError(`Duplicate raw-text triage positive anchor: ${canonical}`);
    }
    canonicalAnchors.add(canonical);
    anchors.push(tokens);
  }

  anchors.sort((left, right) => compareText(canonicalText(left), canonicalText(right)));
  return {
    version,
    positiveAnchors: anchors.map(canonicalText),
    anchors,
  };
}

function containsTokenSequence(tokens: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > tokens.length) return false;
  const finalStart = tokens.length - needle.length;
  for (let start = 0; start <= finalStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (tokens[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function collectChannelEvidence(
  documents: readonly NormalizedSourceText[],
  anchors: readonly string[][],
): ChannelEvidence {
  const matchedAnchors = new Set<number>();
  for (let anchorIndex = 0; anchorIndex < anchors.length; anchorIndex += 1) {
    const anchor = anchors[anchorIndex]!;
    if (documents.some((document) => containsTokenSequence(document.tokens, anchor))) {
      matchedAnchors.add(anchorIndex);
    }
  }

  let exactPhraseBonus = 0;
  let positiveTokenCoverage = 0;
  for (const anchorIndex of matchedAnchors) {
    const anchor = anchors[anchorIndex]!;
    positiveTokenCoverage += anchor.length;
    if (anchor.length > 1) exactPhraseBonus += 1;
  }
  return {
    exactPhraseBonus,
    positiveAnchorMatches: matchedAnchors.size,
    positiveTokenCoverage,
  };
}

function hasPositiveEvidence(evidence: ChannelEvidence): boolean {
  return evidence.positiveAnchorMatches > 0;
}

/**
 * Derives a deterministic, non-gating priority hint from cheap source text.
 * It intentionally accepts no negative vocabulary, emits no 0-100 value, and
 * cannot make any listing inadmissible.
 */
export async function deriveRawTextTriage(
  input: RawTextTriageInput,
): Promise<RawTextTriageResult> {
  const listingId = normalizeIdentity(input.listingId, "Listing ID");
  const sourceId = normalizeIdentity(input.sourceId, "Source ID");
  const vocabulary = canonicalizeVocabulary(input.vocabulary);
  const title = normalizeSourceText(input.title, RAW_TEXT_TRIAGE_LIMITS.maxSourceTextLength);
  const rawDescription = normalizeSourceText(
    input.rawDescription,
    RAW_TEXT_TRIAGE_LIMITS.maxSourceTextLength,
  );
  const cleanDescription = normalizeSourceText(
    input.cleanDescription,
    RAW_TEXT_TRIAGE_LIMITS.maxSourceTextLength,
  );
  const taxonomy = normalizeTaxonomy(input.taxonomy);

  const withoutTokens = ({
    tokens: _tokens,
    originalLength,
    ...normalized
  }: NormalizedSourceText) => ({
    ...normalized,
    ...(normalized.truncated ? { originalLength } : {}),
  });

  const normalizedInput = {
    derivationVersion: RAW_TEXT_TRIAGE_VERSION,
    vocabulary: {
      version: vocabulary.version,
      positiveAnchors: vocabulary.positiveAnchors,
    },
    listingId,
    sourceId,
    title: withoutTokens(title),
    rawDescription: withoutTokens(rawDescription),
    cleanDescription: withoutTokens(cleanDescription),
    taxonomy: taxonomy.map(withoutTokens),
  };
  const inputHash = await sha256CanonicalJson(normalizedInput);
  const listingTieBreak = await sha256CanonicalJson({
    derivationVersion: RAW_TEXT_TRIAGE_VERSION,
    listingId,
  });

  const titleEvidence = collectChannelEvidence([title], vocabulary.anchors);
  const descriptionEvidence = collectChannelEvidence(
    [cleanDescription, rawDescription],
    vocabulary.anchors,
  );
  const taxonomyEvidence = collectChannelEvidence(taxonomy, vocabulary.anchors);

  let tier: RawTextTriageTier = "neutral";
  let channelRank: RawTextTriageOrdinal["channelRank"] = 0;
  let selectedEvidence: ChannelEvidence = {
    exactPhraseBonus: 0,
    positiveAnchorMatches: 0,
    positiveTokenCoverage: 0,
  };
  if (hasPositiveEvidence(titleEvidence)) {
    tier = "positive_title";
    channelRank = 3;
    selectedEvidence = titleEvidence;
  } else if (hasPositiveEvidence(descriptionEvidence)) {
    tier = "positive_description";
    channelRank = 2;
    selectedEvidence = descriptionEvidence;
  } else if (hasPositiveEvidence(taxonomyEvidence)) {
    tier = "positive_taxonomy";
    channelRank = 1;
    selectedEvidence = taxonomyEvidence;
  }

  return {
    derivationVersion: RAW_TEXT_TRIAGE_VERSION,
    vocabularyVersion: vocabulary.version,
    inputHash,
    tier,
    ordinal: {
      channelRank,
      ...selectedEvidence,
      listingTieBreak,
    },
    admissible: true,
  };
}

/** Returns a negative value when `left` should be processed before `right`. */
export function compareRawTextTriagePriority(
  left: RawTextTriageResult,
  right: RawTextTriageResult,
): number {
  const descendingFields: Array<keyof Pick<
    RawTextTriageOrdinal,
    "channelRank" | "exactPhraseBonus" | "positiveAnchorMatches" | "positiveTokenCoverage"
  >> = [
    "channelRank",
    "exactPhraseBonus",
    "positiveAnchorMatches",
    "positiveTokenCoverage",
  ];
  for (const field of descendingFields) {
    const difference = right.ordinal[field] - left.ordinal[field];
    if (difference !== 0) return difference;
  }
  return (
    compareText(left.ordinal.listingTieBreak, right.ordinal.listingTieBreak) ||
    compareText(left.inputHash, right.inputHash)
  );
}
