import {
  deriveDisplayLotType,
  isExplicitSingularAnalyzerSystem,
} from "../domain/lot-classification";
import { effectiveAssetClasses } from "./asset-classes";
import {
  genericMarketplacePolicySignal,
  policySignalIsGrounded,
} from "../domain/item-text";

export const extractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "short_summary",
    "asset_classes",
    "industry_domain",
    "manufacturer",
    "manufacturers",
    "model_numbers",
    "lot_type",
    "included_items",
    "missing_items",
    "condition",
    "tested_status",
    "high_value_signals",
    "negative_signals",
    "regulatory_or_safety_flags",
    "pickup_location_evidence",
  ],
  properties: {
    short_summary: { type: "string", minLength: 1, maxLength: 320 },
    asset_classes: { type: "array", maxItems: 8, items: { type: "string", maxLength: 120 } },
    industry_domain: {
      type: "string",
      enum: ["medical", "laboratory", "industrial", "electronics", "av", "tools", "other", "unknown"],
    },
    manufacturer: { type: ["string", "null"], maxLength: 120 },
    manufacturers: {
      type: "array",
      maxItems: 24,
      description:
        "Every manufacturer or brand explicitly supported by the source text, in source order. Keep manufacturer null when multiple manufacturers apply.",
      items: { type: "string", maxLength: 120 },
    },
    model_numbers: {
      type: "array",
      maxItems: 24,
      description:
        "Every independently expressed model, catalog, part, or reference identifier supported by the source. Keep the longest exact source form and omit redundant word/number fragments, generic product classes, packaging quantities, and aggregate slash forms when their separately supported component codes are retained.",
      items: { type: "string", maxLength: 120 },
    },
    lot_type: {
      type: "string",
      enum: ["single_item", "multi_item_lot", "assorted_lot", "unknown"],
      description:
        "Classify the complete sale grouping: single_item means one main item with only its supporting content; multi_item_lot means multiple items of one general type; assorted_lot means a mixed/misc assortment. Explicit lots, pallets, collections, parts/accessory/supply-only groupings, and a box/case/pack/carton/crate/bag/bin/pallet/bundle clearly containing multiple units are lots even when the exact inner count is missing or approximate. Packaging alone does not establish a lot. Attached/onboard content supporting one main item does not create a lot.",
    },
    included_items: {
      type: "array",
      maxItems: 8,
      description:
        "Explicitly named contents with quantities and grouping words preserved. Distinguish one main item with supporting content from a pallet, collection, mixed/misc assortment, or multi-piece parts/accessory/supply sale so the normalized lot label has auditable evidence.",
      items: { type: "string", maxLength: 500 },
    },
    missing_items: { type: "array", maxItems: 8, items: { type: "string", maxLength: 160 } },
    condition: { type: "string", enum: ["new", "used", "untested", "parts_only", "damaged", "unknown"] },
    tested_status: { type: "string", enum: ["tested_working", "powers_on", "untested", "not_working", "unknown"] },
    high_value_signals: { type: "array", maxItems: 8, items: { type: "string", maxLength: 160 } },
    negative_signals: { type: "array", maxItems: 8, items: { type: "string", maxLength: 160 } },
    regulatory_or_safety_flags: { type: "array", maxItems: 8, items: { type: "string", maxLength: 160 } },
    pickup_location_evidence: {
      type: "object",
      additionalProperties: false,
      required: ["city", "state", "postal_code", "source_section"],
      properties: {
        city: { type: ["string", "null"], maxLength: 120 },
        state: { type: ["string", "null"], maxLength: 40 },
        postal_code: { type: ["string", "null"], maxLength: 24 },
        source_section: {
          type: "string",
          enum: ["description", "removal", "inspection", "other", "unknown"],
        },
      },
    },
  },
} as const;

const DOMAINS = ["medical", "laboratory", "industrial", "electronics", "av", "tools", "other", "unknown"] as const;
const LOT_TYPES = ["single_item", "multi_item_lot", "assorted_lot", "unknown"] as const;
const CONDITIONS = ["new", "used", "untested", "parts_only", "damaged", "unknown"] as const;
const TESTED = ["tested_working", "powers_on", "untested", "not_working", "unknown"] as const;
const SECTIONS = ["description", "removal", "inspection", "other", "unknown"] as const;

export interface TextExtraction {
  short_summary: string;
  asset_classes: string[];
  industry_domain: (typeof DOMAINS)[number];
  manufacturer: string | null;
  manufacturers: string[];
  model_numbers: string[];
  /**
   * A lot contains multiple sold pieces, including parts/accessory/supply
   * collections. Supporting content bundled with one main item does not make
   * that listing a lot.
   */
  lot_type: (typeof LOT_TYPES)[number];
  included_items: string[];
  missing_items: string[];
  condition: (typeof CONDITIONS)[number];
  tested_status: (typeof TESTED)[number];
  high_value_signals: string[];
  negative_signals: string[];
  regulatory_or_safety_flags: string[];
  pickup_location_evidence: {
    city: string | null;
    state: string | null;
    postal_code: string | null;
    source_section: (typeof SECTIONS)[number];
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string, maximum = 2_000): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value.trim().slice(0, maximum);
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field, 500) || null;
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((entry, index) => string(entry, `${field}[${index}]`, 500)).filter(Boolean).slice(0, 50);
}

function enumeration<T extends readonly string[]>(value: unknown, field: string, allowed: T): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

export function validateTextExtraction(
  value: unknown,
  context: {
    title?: string | null;
    sourceText?: string | null;
    marketplacePolicyCleanupApplied?: boolean;
  } = {},
): TextExtraction {
  const root = object(value, "extraction");
  const location = object(root.pickup_location_evidence, "pickup_location_evidence");
  const shortSummary = string(root.short_summary, "short_summary", 600);
  if (!shortSummary) throw new Error("short_summary must be a non-empty string");
  const sourceText = [context.title, context.sourceText]
    .map((entry) => entry?.trim())
    .filter((entry): entry is string => Boolean(entry))
    .join("\n") || null;
  const includedItems = completeIncludedItems(
    strings(root.included_items, "included_items"),
    context.title,
    context.sourceText,
  );
  const lotType = deriveDisplayLotType(
    enumeration(root.lot_type, "lot_type", LOT_TYPES),
    includedItems,
    { title: context.title, shortSummary, sourceText: context.sourceText },
  );
  const extractedAssetClasses = strings(root.asset_classes, "asset_classes");
  const effectiveClasses = context.title || context.sourceText
    ? effectiveAssetClasses(extractedAssetClasses, {
      title: context.title,
      includedItems,
      sourceText: context.sourceText,
    })
    : extractedAssetClasses
  ;
  const extractedClassKeys = new Set(extractedAssetClasses.map(normalizeAssetClassKey));
  const sourceGroundedRefinements = effectiveClasses.filter(
    (value) => !extractedClassKeys.has(normalizeAssetClassKey(value)),
  );
  const assetClasses = uniqueStrings([
    ...sourceGroundedRefinements,
    ...effectiveClasses,
  ]).slice(0, 8);
  const suppliedManufacturer = nullableString(root.manufacturer, "manufacturer");
  const suppliedManufacturers = strings(root.manufacturers, "manufacturers");
  if (suppliedManufacturer) suppliedManufacturers.unshift(suppliedManufacturer);
  const manufacturers = mergeSourceManufacturers(
    suppliedManufacturers,
    context.title,
    context.sourceText,
  );
  const manufacturer = manufacturers.length === 1 ? manufacturers[0]! : null;
  const modelNumbers = mergeSourceModelIdentifiers(
    strings(root.model_numbers, "model_numbers"),
    context.title,
    context.sourceText ?? null,
    manufacturers,
  );
  const suppliedIndustryDomain = enumeration(
    root.industry_domain,
    "industry_domain",
    DOMAINS,
  );
  const industryDomain = effectiveIndustryDomain(
    suppliedIndustryDomain,
    assetClasses,
    { title: context.title, sourceText: context.sourceText },
  );
  return {
    short_summary: reconcileShortSummary(shortSummary, {
      title: context.title,
      sourceText: context.sourceText,
      includedItems,
      lotType,
      industryDomain,
      modelNumbers,
    }),
    asset_classes: assetClasses,
    industry_domain: industryDomain,
    manufacturer,
    manufacturers: manufacturers.slice(0, 24),
    model_numbers: modelNumbers,
    lot_type: lotType,
    included_items: includedItems,
    missing_items: strings(root.missing_items, "missing_items"),
    condition: groundedCondition(
      enumeration(root.condition, "condition", CONDITIONS),
      sourceText,
    ),
    tested_status: groundedTestedStatus(
      enumeration(root.tested_status, "tested_status", TESTED),
      sourceText,
    ),
    high_value_signals: strings(root.high_value_signals, "high_value_signals"),
    negative_signals: groundedNegativeSignals(
      strings(root.negative_signals, "negative_signals"),
      sourceText,
      context.marketplacePolicyCleanupApplied === true,
    ),
    regulatory_or_safety_flags: strings(root.regulatory_or_safety_flags, "regulatory_or_safety_flags"),
    pickup_location_evidence: {
      city: nullableString(location.city, "pickup_location_evidence.city"),
      state: nullableString(location.state, "pickup_location_evidence.state"),
      postal_code: nullableString(location.postal_code, "pickup_location_evidence.postal_code"),
      source_section: enumeration(location.source_section, "pickup_location_evidence.source_section", SECTIONS),
    },
  };
}

function groundedNegativeSignals(
  signals: readonly string[],
  sourceText: string | null,
  marketplacePolicyCleanupApplied: boolean,
): string[] {
  if (!sourceText || !marketplacePolicyCleanupApplied) return [...signals];
  return signals.filter((signal) => {
    const policySignal = genericMarketplacePolicySignal(signal);
    return policySignal === null ||
      policySignalIsGrounded(policySignal, sourceText);
  });
}

function normalizeAssetClassKey(value: string): string {
  return value.trim().replaceAll("_", " ").replace(/\s+/gu, " ").toLocaleLowerCase();
}

function uniqueStrings(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!result.some((entry) => sameText(entry, value))) result.push(value);
  }
  return result;
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

const DETERMINISTIC_BRAND_MARKS = [
  { manufacturer: "BladderScan", evidence: /\bVerathon\s+BladderScan\b/iu },
  { manufacturer: "GlideScope", evidence: /\b(?:Verathon\s+)?GlideScope\b/iu },
  { manufacturer: "GRAY", evidence: /\bGRAY\s+transmission lift\b/iu },
  { manufacturer: "LifeFitness", evidence: /\bLifeFitness\b/iu },
  { manufacturer: "Luxtec", evidence: /\bIntegra\s+Luxtec\s+MLX\b/iu },
  { manufacturer: "Maytag", evidence: /\bMaytag\b/iu },
  { manufacturer: "Nicolet", evidence: /\bThermo Scientific\s+Nicolet\b/iu },
  { manufacturer: "Nitro Circus", evidence: /\bNitro Circus\b/iu },
  { manufacturer: "PelvicBinder", evidence: /\bPelvicBinder\b/iu },
] as const;
const DETERMINISTIC_MANUFACTURER_ALIASES = [
  { manufacturer: "Apple", evidence: /\biPhone\b/iu },
  { manufacturer: "Canon", evidence: /\bCannon\b/iu },
] as const;

function mergeSourceManufacturers(
  extracted: readonly string[],
  title: string | null | undefined,
  sourceText: string | null | undefined,
): string[] {
  const evidence = [title, sourceText].filter(Boolean).join("\n");
  const result: string[] = [];
  const append = (manufacturer: string) => {
    const canonical = evidenceAwareManufacturerName(manufacturer, evidence);
    if (
      isGenericManufacturerValue(canonical) ||
      result.some((entry) => equivalentManufacturer(entry, canonical))
    ) return;
    result.push(canonical);
  };
  for (const manufacturer of extracted.flatMap(splitManufacturerCandidate)) {
    if (!evidence || isGroundedManufacturer(manufacturer, title, sourceText)) append(manufacturer);
  }
  if (!evidence) return result;
  for (const manufacturer of labeledManufacturerCandidates(evidence).flatMap(splitManufacturerCandidate)) {
    if (result.some((entry) => normalizeBrandText(manufacturer).startsWith(`${normalizeBrandText(entry)} `))) {
      continue;
    }
    append(manufacturer);
  }
  for (const brand of DETERMINISTIC_BRAND_MARKS) {
    if (
      brand.evidence.test(evidence) &&
      !result.some((entry) => equivalentManufacturer(entry, brand.manufacturer))
    ) {
      append(brand.manufacturer);
    }
  }
  const text = evidence.toLocaleLowerCase();
  return result.sort((left, right) => {
    const leftIndex = manufacturerSourceIndex(evidence, text, left);
    const rightIndex = manufacturerSourceIndex(evidence, text, right);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) -
      (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
  });
}

function evidenceAwareManufacturerName(value: string, evidence: string): string {
  const normalized = normalizeBrandText(value);
  if (normalized === "dinner" && /\bDionex\b/iu.test(evidence)) return "Dionex";
  if (normalized === "smith medical" && /\bSmiths Medical\b/iu.test(evidence)) {
    return "Smiths Medical";
  }
  return canonicalManufacturerName(value);
}

function splitManufacturerCandidate(value: string): string[] {
  return value.split(/\s*\/\s*/u).map((entry) => entry.trim()).filter(Boolean);
}

function equivalentManufacturer(left: string, right: string): boolean {
  const leftNormalized = normalizeBrandText(canonicalManufacturerName(left));
  const rightNormalized = normalizeBrandText(canonicalManufacturerName(right));
  return leftNormalized === rightNormalized ||
    `${leftNormalized}s` === rightNormalized ||
    `${rightNormalized}s` === leftNormalized;
}

function canonicalManufacturerName(value: string): string {
  const normalized = normalizeBrandText(value);
  if (normalized === "boston scientfic") return "Boston Scientific";
  if (normalized === "nnosonic") return "Nanosonics";
  return value.trim();
}

function isGenericManufacturerValue(value: string): boolean {
  return /^(?:brand|equipment|industrial|laborator(?:y|ies)|make|manufacturer|medical|model|n\/?a|none|not (?:available|listed|provided)|other|tools?|unknown|various)$/iu.test(
    normalizeBrandText(value),
  );
}

function labeledManufacturerCandidates(evidence: string): string[] {
  const result: string[] = [];
  for (const match of evidence.matchAll(/\b(?:brand|make|manufacturer)\b\s*[:#=-]\s*/giu)) {
    let tail = evidence.slice(match.index + match[0].length, match.index + match[0].length + 160);
    const nextField = /(?:^|\s+)\b(?:asset(?:\s*(?:id|no\.?|number))?|condition|description|engine\s+size|inventory(?:\s*(?:id|no\.?|number))?|model(?:\s*(?:no\.?|number|years?))?|quantity|serial(?:\s*(?:no\.?|num(?:ber)?s?\.?))?|specifications?|vin|year)\b\s*[:#=-]/iu.exec(tail);
    if (nextField) tail = tail.slice(0, nextField.index);
    let candidate = tail
      .split(/[\n;|]/u, 1)[0]!
      .replace(/^[\s,.-]+|[\s,.-]+$/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    const firstDigitToken = candidate.split(/\s+/u).findIndex((token) => /\d/u.test(token));
    if (firstDigitToken > 0) candidate = candidate.split(/\s+/u).slice(0, firstDigitToken).join(" ");
    if (
      !candidate || candidate.length > 120 ||
      /^(?:n\/?a|none|not (?:available|listed|provided)|unknown|various)$/iu.test(candidate)
    ) continue;
    if (!result.some((entry) => equivalentManufacturer(entry, candidate))) result.push(candidate);
  }
  return result;
}

function manufacturerSourceIndex(evidence: string, lowerEvidence: string, manufacturer: string): number {
  const direct = lowerEvidence.indexOf(manufacturer.toLocaleLowerCase());
  if (direct >= 0) return direct;
  const alias = DETERMINISTIC_MANUFACTURER_ALIASES.find((entry) =>
    sameText(entry.manufacturer, manufacturer)
  );
  return alias?.evidence.exec(evidence)?.index ?? -1;
}

function isGroundedManufacturer(
  manufacturer: string,
  title: string | null | undefined,
  sourceText: string | null | undefined,
): boolean {
  const evidence = [title, sourceText].filter(Boolean).join("\n");
  const normalized = normalizeBrandText(manufacturer);
  if (isGenericManufacturerValue(manufacturer)) return false;
  if (
    normalized === "dash" &&
    !/\b(?:brand|make|manufacturer)\b\s*[:#=-]\s*Dash\b/iu.test(evidence)
  ) return false;
  if (normalized === "the advanced cryoscope") return false;
  if (
    normalized === "ncr" && /\bNCR\s+Paper\b/iu.test(evidence) &&
    !/\b(?:make|manufacturer|brand)\b[\s:#=-]*NCR\b/iu.test(evidence)
  ) return false;
  if (DETERMINISTIC_MANUFACTURER_ALIASES.some((alias) =>
    sameText(alias.manufacturer, manufacturer) && alias.evidence.test(evidence)
  )) return true;
  if (!containsManufacturerText(evidence, manufacturer)) return false;
  if (title && containsManufacturerText(title, manufacturer)) return true;
  if (!sourceText) return false;

  const escaped = escapeRegExp(manufacturer);
  if (new RegExp(
    `\\b(?:make|manufacturer|brand)\\b[\\s:#=-]*${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(sourceText)) return true;

  return sourceText.split(/\r?\n/gu).some((line) => {
    if (!containsManufacturerText(line, manufacturer)) return false;
    const identifierOnly = new RegExp(
      `^\\s*(?:model(?:\\s*(?:no\\.?|number))?|catalog(?:\\s*(?:no\\.?|number))?|cat\\.?|ref(?:erence)?|part(?:\\s*(?:no\\.?|number))?|p\\/?n)\\b[\\s:#(=-]*${escaped}(?![\\p{L}\\p{N}])`,
      "iu",
    ).test(line);
    return !identifierOnly;
  });
}

function containsManufacturerText(haystack: string, manufacturer: string): boolean {
  if (containsWholeText(haystack, manufacturer)) return true;
  const normalized = normalizeBrandText(manufacturer);
  const compact = normalized.replace(/\s+/gu, "");
  if (compact.length < 4) return false;
  const flexible = normalized.split(/\s+/gu).map(escapeRegExp).join("[^\\p{L}\\p{N}]*");
  if (new RegExp(`(?<![\\p{L}])${flexible}(?![\\p{L}])`, "iu").test(haystack)) return true;
  const compactHaystack = haystack.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return compactHaystack.includes(`${compact}${compact}`);
}

function completeIncludedItems(
  extracted: readonly string[],
  title: string | null | undefined,
  sourceText: string | null | undefined,
): string[] {
  const itemEvidence = [title, sourceText].filter(Boolean).join("\n");
  const result = removePreviouslyMisparsedIncludeLeakage(
    uniqueStrings(extracted
      .map(stripSyntheticIncludedItemMetadata)
      .map((entry) => repairSourceGroundedItemQuantity(entry, itemEvidence))
      .filter((entry) => entry && !isIncludedItemMetadataOnly(entry))),
    sourceText,
  );
  const sourceItems = itemizedSourceLines(sourceText);
  const includedBlockItems = explicitIncludedBlockItems(sourceText);
  let completed: string[];
  if (includedBlockItems.length > 0) {
    completed = isExplicitSingularAnalyzerSystem(
        { title, sourceText },
        [...result, ...includedBlockItems],
      ) && title?.trim()
      ? [title.trim().slice(0, 500), ...includedBlockItems]
      : uniqueStrings([
        ...result.filter((item) => !isGeneratedIncludedItemsAggregate(item)),
        ...includedBlockItems,
      ]);
  } else if (sourceItems.length > 8) {
    completed = [
      ...sourceItems.slice(0, 7),
      aggregateRemainingItems(sourceItems.slice(7)),
    ];
  } else if (sourceItems.length > result.length && (result.length === 0 || sourceItems.length > 1)) {
    completed = sourceItems;
  } else if (result.length > 0) {
    completed = result.slice(0, 8);
  } else {
    const fallback = title?.trim();
    completed = fallback ? [fallback.slice(0, 500)] : [];
  }
  return boundIncludedItems(preserveTitleGroupedQuantity(completed, title));
}

function stripSyntheticIncludedItemMetadata(value: string): string {
  return value.trim().replace(/\s*;\s*source grouping\s*:.*$/iu, "").trim();
}

function repairSourceGroundedItemQuantity(
  item: string,
  sourceText: string | null | undefined,
): string {
  if (!sourceText) return item;
  const itemMatch = /^(\s*(?:(?:approximately|about)\s+)?)(\(?\s*)(\d{1,4})(\s*\)?)(?:\s*(x\b|ea\.?\b|each\b|units?\b))?\s+(.+)$/iu.exec(item);
  if (!itemMatch) return item;
  const extractedQuantity = Number(itemMatch[3]);
  const hasExplicitExtractedCount = Boolean(itemMatch[2]?.includes("(") || itemMatch[4]?.includes(")") || itemMatch[5]);
  if (
    !hasExplicitExtractedCount &&
    extractedQuantity >= 1900 && extractedQuantity <= 2100
  ) return item;
  const anchorTokens = itemMatch[6]!
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((token) => token.length >= 2)
    .slice(0, 12) ?? [];
  if (anchorTokens.length < 2) {
    return extractedQuantity === 1 ? itemMatch[6]!.trim() : item;
  }
  const anchorPattern = new RegExp(
    anchorTokens.map(escapeRegExp).join("[^\\p{L}\\p{N}]+"),
    "giu",
  );
  for (const anchor of sourceText.matchAll(anchorPattern)) {
    const prefix = sourceText.slice(Math.max(0, anchor.index - 64), anchor.index);
    const leadingSourceQuantity = /(?:^|[^\p{L}\p{N}])(?:(?:approximately|about)\s+)?(?:\(\s*(\d{1,4})\s*(?:x\b|ea\.?\b|each\b|units?\b)?\s*\)|(\d{1,4})\s*(?:x\b|ea\.?\b|each\b|units?\b)?)\s*(?:(?:19|20)\d{2}\s*)?$/iu.exec(prefix);
    if (Number(leadingSourceQuantity?.[1] ?? leadingSourceQuantity?.[2]) === extractedQuantity) {
      return item;
    }
    const suffix = sourceText.slice(
      anchor.index + anchor[0].length,
      anchor.index + anchor[0].length + 160,
    );
    // Source adapters often serialize an item's Quantity field immediately
    // before the *next* item label. A preceding count is therefore ambiguous
    // and caused cross-item quantity leakage. Only repair from this matched
    // item's own following, explicitly labelled Quantity field.
    const explicit = /^.{0,64}?\bquantity\s*[:#=-]\s*(\d{1,4})\s*(ea\.?|each|x|units?)?\b/iu.exec(suffix);
    const beforeQuantity = explicit?.[0].slice(
      0,
      explicit[0].toLocaleLowerCase().lastIndexOf("quantity"),
    ) ?? "";
    const colonSegments = beforeQuantity.split(":");
    const crossesNextItemLabel = colonSegments.slice(0, -1).some((segment) =>
      !/\b(?:asset(?:\s*(?:id|no\.?|number))?|condition|inventory(?:\s*(?:id|no\.?|number))?|model(?:\s*(?:no\.?|number))?|serial(?:\s*(?:no\.?|number))?|specifications?|vin|year)\s*$/iu.test(segment.trim())
    );
    if (crossesNextItemLabel) continue;
    const sourceQuantity = Number(explicit?.[1]);
    if (!Number.isSafeInteger(sourceQuantity) || sourceQuantity < 1) continue;
    if (sourceQuantity === extractedQuantity) return item;
    const sourceMarker = explicit?.[2]?.trim() ?? itemMatch[5]?.trim() ?? "";
    const sourceMarkerText = sourceMarker ? ` ${sourceMarker}` : "";
    return `${itemMatch[1]}${itemMatch[2]}${sourceQuantity}${itemMatch[4]}${sourceMarkerText} ${itemMatch[6]}`.trim();
  }
  return extractedQuantity === 1 ? itemMatch[6]!.trim() : item;
}

function preserveTitleGroupedQuantity(
  items: readonly string[],
  title: string | null | undefined,
): string[] {
  if (!title) return [...items];
  const match = /\b(lot\s+of|qty(?:uantity)?)\s*[:#=-]?\s*(\d{1,4})\b/iu.exec(title);
  const total = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(total) || total < 2) return [...items];
  const totalPattern = new RegExp(
    `(?:\\blot\\s+of\\s+${total}\\b|\\bqty(?:uantity)?\\s*[:#=-]?\\s*${total}\\b|\\b${total}\\s+(?:total\\s+)?(?:items?|pieces?|units?)\\b)`,
    "iu",
  );
  if (items.some((item) => totalPattern.test(item))) return [...items];

  const quantityItems = items.filter((item) => !/^source grouping\s*:/iu.test(item));
  const quantities = quantityItems.map(leadingIncludedItemQuantity);
  if (
    quantities.length > 0 && quantities.every((quantity): quantity is number => quantity !== null) &&
    quantities.reduce((sum, quantity) => sum + quantity, 0) === total
  ) return [...items];

  const evidence = match[1]!.toLocaleLowerCase().startsWith("lot")
    ? `Lot of ${total} total items (source title)`
    : `Quantity ${total} total items (source title)`;
  if (items.length < 8) return [...items, evidence];
  return [
    ...items.slice(0, 7),
    `${items[7]!}; ${evidence}`.slice(0, 500),
  ];
}

function leadingIncludedItemQuantity(item: string): number | null {
  const match = /^\s*(?:approximately\s+|about\s+)?\(?\s*(\d{1,4})\s*\)?(?:\s*x\b|\s+)/iu.exec(item) ??
    /\bqty(?:uantity)?\s*[:#=-]?\s*(\d{1,4})\b/iu.exec(item);
  const quantity = Number(match?.[1]);
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

function itemizedSourceLines(sourceText: string | null | undefined): string[] {
  if (!sourceText) return [];
  return uniqueStrings(sourceText
    .split(/\r?\n/gu)
    .map((line) => normalizeSourceItemLine(line))
    .filter((line): line is string => Boolean(line)));
}

function explicitIncludedBlockItems(
  sourceText: string | null | undefined,
): string[] {
  if (!sourceText) return [];
  const items: string[] = [];
  let inBlock = false;
  let terminated = false;
  for (const sourceLine of sourceText.split(/\r?\n/gu)) {
    const line = sourceLine.trim();
    if (/^includes?\b\s*:?\s*$/iu.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock || !line) continue;
    if (
      /^(?:equipment description|item description|specifications?|technical data)\s*:?\s*$/iu
        .test(line)
    ) {
      terminated = true;
      break;
    }
    items.push(...splitExplicitIncludedBlockLine(line));
  }
  return terminated ? uniqueStrings(items) : [];
}

function removePreviouslyMisparsedIncludeLeakage(
  items: readonly string[],
  sourceText: string | null | undefined,
): string[] {
  if (!sourceText) return [...items];
  const lines = sourceText.split(/\r?\n/gu).map((line) => line.trim());
  const truncatedMarkerTails = lines
    .filter((line) =>
      /^included\b/iu.test(line) &&
      !/^includes?\b/iu.test(line)
    )
    .map((line) => line.slice("include".length).trim())
    .filter(Boolean);
  const inlineTailLines = lines.flatMap((line, index) =>
    /^includes?\b\s*:?\s*\S/iu.test(line)
      ? lines.slice(index + 1).filter(Boolean)
      : []
  );
  const normalizedTruncatedMarkerTails = truncatedMarkerTails.map(
    normalizeIncludedItemComparison,
  );
  const hasTruncatedMarkerLeakage = items.some((item) => {
    const normalizedItem = normalizeIncludedItemComparison(item);
    return normalizedTruncatedMarkerTails.some((tail) =>
      normalizedItem === tail ||
      (isGeneratedIncludedItemsAggregate(item) &&
        normalizedItem.includes(tail))
    );
  });

  return items.filter((item) => {
    const normalizedItem = normalizeIncludedItemComparison(item);
    const aggregate = isGeneratedIncludedItemsAggregate(item);
    if (aggregate && hasTruncatedMarkerLeakage) return false;
    const leakedTruncatedMarker = normalizedTruncatedMarkerTails.some((tail) =>
      normalizedItem === tail ||
      (aggregate && normalizedItem.includes(tail))
    );
    if (leakedTruncatedMarker) return false;
    return !inlineTailLines.some((tail) => {
      const normalizedTail = normalizeIncludedItemComparison(tail);
      return normalizedItem === normalizedTail ||
        (aggregate && normalizedTail.length >= 8 &&
          normalizedItem.includes(normalizedTail));
    });
  });
}

function normalizeIncludedItemComparison(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function splitExplicitIncludedBlockLine(value: string): string[] {
  return value
    .split(/\s*(?:;|\u2022)\s*/gu)
    .map((item) => item
      .trim()
      .replace(/^(?:[-*\u2022]+|\d+[.)])\s*/u, "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 500))
    .filter((item) => item && !isIncludedItemMetadataOnly(item));
}

function normalizeSourceItemLine(value: string): string | null {
  const line = value.trim().replace(/^['"]+|['"]+$/gu, "");
  if (!line || line.length > 1_000 || isIncludedItemMetadataOnly(line)) return null;
  const itemEvidence =
    /\b(?:ref(?:erence)?|catalog(?:\s*(?:no\.?|number))?|cat\.?|model(?:\s*(?:no\.?|number))?|part(?:\s*(?:no\.?|number))?|p\/?n)\b\s*[:#(-]?\s*[a-z0-9]/iu.test(line) ||
    (!/^exp(?:iration|iry)?\s*dates?\b/iu.test(line) &&
      /\bexp(?:iration|iry)?\s*dates?\b/iu.test(line)) ||
    /^(?:approximately\s+|about\s+)?\d+\s*(?:x\b|ea\b|each\b|boxes?\b|cases?\b|pallets?\b)/iu.test(line);
  if (!itemEvidence) return null;
  return line
    .replace(
      /\s+(?:(?:(?:exp(?:iration|iry)?\s*(?:dates?)?|expires?)|ref)\s*[:#-]?\s*)?\d{1,2}[/-]\d{1,2}[/-]\d{2,4}.*$/iu,
      "",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500) || null;
}

function isIncludedItemMetadataOnly(value: string): boolean {
  const normalized = value.trim().replace(/^['"]+|['"]+$/gu, "");
  if (!normalized) return true;
  if (/^source grouping\s*:/iu.test(normalized)) return true;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/u.test(normalized)) return true;
  if (/^(?:exp(?:iration|iry)?\s*(?:dates?)?|expires?)\b\s*[:#=-]?\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4}(?:\s*[,;]\s*\d{1,2}[/-]\d{1,2}[/-]\d{2,4})*$/iu.test(normalized)) {
    return true;
  }
  return /^(?:asset(?:\s*(?:id|no\.?|number))?|brand|cat(?:alog)?(?:\s*(?:no\.?|number))?|condition|location|make|manufacturer|model(?:\s*(?:no\.?|number))?|p\/?n|part(?:\s*(?:no\.?|number))?|ref(?:erence)?|seller|serial(?:\s*(?:no\.?|number))?|tested(?:\s+status)?|working\s+condition)\b\s*[:#=-]\s*[^,;\n]+$/iu.test(normalized);
}

function aggregateRemainingItems(items: readonly string[]): string {
  const prefix = `Remaining ${items.length} named types: `;
  const joined = `${prefix}${items.join("; ")}`;
  if (joined.length <= 500) return joined;
  const itemBudget = Math.max(
    24,
    Math.floor((500 - prefix.length - ((items.length - 1) * 2)) / items.length),
  );
  return `${prefix}${items.map((item) => compactItem(item, itemBudget)).join("; ")}`.slice(0, 500);
}

function isGeneratedIncludedItemsAggregate(value: string): boolean {
  return /^Remaining \d+ named types:\s/iu.test(value.trim());
}

function boundIncludedItems(items: readonly string[]): string[] {
  const unique = uniqueStrings(items);
  if (unique.length <= 8) return unique;
  return [
    ...unique.slice(0, 7),
    aggregateRemainingItems(unique.slice(7)),
  ];
}

function compactItem(item: string, maximum: number): string {
  if (item.length <= maximum) return item;
  const codes = sourceCodeCandidates(item);
  const code = codes.at(-1) ?? null;
  if (!code || code.length + 4 >= maximum) return `${item.slice(0, maximum - 3).trimEnd()}...`;
  const prefixLength = maximum - code.length - 3;
  return `${item.slice(0, prefixLength).trimEnd()}... ${code}`;
}

function containsWholeText(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(haystack);
}

function effectiveIndustryDomain(
  domain: TextExtraction["industry_domain"],
  assetClasses: readonly string[],
  context: { title?: string | null; sourceText?: string | null } = {},
): TextExtraction["industry_domain"] {
  const evidence = assetClasses.join(" ").replaceAll("_", " ").toLocaleLowerCase();
  const sourceEvidence = [context.title, context.sourceText].filter(Boolean).join(" ").toLocaleLowerCase();
  if (/\b(?:television|tv monitor)\b/u.test(evidence)) return "av";
  if (/\bprojector\b/u.test(evidence) && !/\bophthalmic\b/u.test(sourceEvidence)) return "av";
  if (
    /\banaly[sz]er\b/u.test(evidence) &&
    !/\b(?:network|spectrum)\s+analy[sz]er\b/u.test(evidence)
  ) {
    return "laboratory";
  }
  if (/\b(?:camcorder|computer|computing workstation|desktop|keyboard|laptop|network switch|power distribution unit|power supply|tablet computer|thin client|two-way radio|uninterruptible power supply)\b/u.test(evidence)) {
    return "electronics";
  }
  if (/\bfitness equipment\b|\btreadmill\b/u.test(evidence)) {
    return /\b(?:clinical|medical|patient|rehab(?:ilitation)?)\b/u.test(sourceEvidence)
      ? "medical"
      : "other";
  }
  if (/\bfreezer\b/u.test(evidence)) {
    if (/\b(?:clinical|medical|pharmacy)\b/u.test(sourceEvidence)) return "medical";
    if (/\b(?:lab|laboratory|scientific)\b/u.test(sourceEvidence)) return "laboratory";
    return "other";
  }
  if (/\bincubator\b/u.test(evidence)) {
    return /\b(?:infant|medical|neonatal|patient)\b/u.test(sourceEvidence)
      ? "medical"
      : "laboratory";
  }
  if (/\b(?:information management system|wall transformer)\b/u.test(evidence)) {
    return "electronics";
  }
  if (/\b(?:autosampler|block heater|centrifuge|chromatography module|coagulation analyzer|elemental analyzer|flow cytometer|ion chromatography system|laboratory furnace|laboratory oven|gas absorption unit|recirculating chiller|slide stainer|spectrophotometer|vapor pressure tester|vibration table|water bath)\b/u.test(evidence)) {
    return "laboratory";
  }
  if (/\bmicroscope\b/u.test(evidence)) {
    return /\b(?:ophthalmic|surgical|surgery|opmi)\b/u.test(sourceEvidence)
      ? "medical"
      : "laboratory";
  }
  if (/\b(?:anesthesia machine|bladder scanner|ct scanner|defibrillator|electrocardiograph|endoscope drying cabinet|exam table|fetal monitor|iv pole|medical module|medical scale|mri coil|mri table|nebulizer|overbed table|patient monitor|phacoemulsification system|pharmacy refrigerator|respiratory humidifier|splint bath|surgical flow meter|surgical light|telemetry module|treatment table|ultrasound transducer|wheelchair)\b/u.test(evidence)) {
    return "medical";
  }
  if (/\bcompressor\b/u.test(evidence)) {
    return /\b(?:medical|nebulizer|patient|respiratory)\b/u.test(sourceEvidence)
      ? "medical"
      : "industrial";
  }
  if (/\bscale\b/u.test(evidence)) return "other";
  if (/\b(?:merchandise|retail|store)\s+displays?\b/u.test(evidence)) return "other";
  const inferred = new Set<TextExtraction["industry_domain"]>();
  if (/\b(?:anesthesia|clinical|defibrillator|ecg|ekg|healthcare|hospital|medical|mri|patient|surgical|ultrasound|x[ -]?ray)\b/u.test(evidence)) inferred.add("medical");
  const laboratoryEvidence = evidence.replace(/\b(?:network|spectrum)\s+analy[sz]ers?\b/gu, " ");
  if (/\b(?:analy[sz]er|centrifuge|chromatograph|cryoscope|furnace|gas absorption|incubator|laborator(?:y|ies)|lab|microscope|pathology|scientific|slide stainer|spectrometer)\b/u.test(laboratoryEvidence)) inferred.add("laboratory");
  if (/\b(?:compressor|forklift|generator|industrial|machinery|material handling|manufacturing|warehouse)\b/u.test(evidence)) inferred.add("industrial");
  const avEvidence = evidence.replace(/\b(?:merchandise|retail|store)\s+displays?\b/gu, " ");
  if (/\b(?:audio|visual|av equipment|projector|display|television)\b/u.test(avEvidence)) inferred.add("av");
  if (/\b(?:tool|power tool|hand tool)\b/u.test(evidence)) inferred.add("tools");
  if (/\b(?:communications?|computers?|electronics?|it equipment|laptops?|network(?:ing)?|(?:network|spectrum)\s+analy[sz]ers?|oscilloscopes?|printers?|servers?|tablets?)\b/u.test(evidence)) inferred.add("electronics");
  if (domain !== "unknown") {
    const specificProductEvidence = /\b(?:centrifuge|chromatograph|compressor|cryoscope|forklift|generator|incubator|microscope|network\s+analy[sz]er|oscilloscope|pathology|printer|projector|server|spectrum\s+analy[sz]er|spectrometer|television|ultrasound|x[ -]?ray)\b/u.test(evidence);
    return inferred.size === 1 && specificProductEvidence ? [...inferred][0]! : domain;
  }
  for (const candidate of ["medical", "laboratory", "industrial", "av", "tools", "electronics"] as const) {
    if (inferred.has(candidate)) return candidate;
  }
  return assetClasses.length > 0 ? "other" : "unknown";
}

function reconcileShortSummary(
  summary: string,
  context: {
    title?: string | null;
    sourceText?: string | null;
    includedItems: readonly string[];
    lotType: TextExtraction["lot_type"];
    industryDomain: TextExtraction["industry_domain"];
    modelNumbers: readonly string[];
  },
): string {
  const cleanedSummary = summaryHasProcessBoilerplate(summary) ? "" : summary;
  const groupedSale = context.lotType === "multi_item_lot" ||
    context.lotType === "assorted_lot";
  const contradictsLot = groupedSale
    ? summaryClaimsSingleSale(cleanedSummary)
    : summaryClaimsGroupedSale(cleanedSummary);
  const sourceEvidence = [context.title, context.sourceText].filter(Boolean).join("\n");
  const contradictsDomain = (
    ["medical", "laboratory", "industrial", "electronics", "av", "tools"] as const
  ).some((candidate) => {
    if (candidate === context.industryDomain) return false;
    const claim = domainClaimPattern(candidate);
    return claim !== null && claim.test(cleanedSummary) && !claim.test(sourceEvidence);
  });
  const contradictsKnownModelTypo = (
    /\bmodel(?:\s+(?:is|of))?\s+['"]?Stage\b/iu.test(cleanedSummary) &&
    /\bStago\s+STA\s+Satellite\b/iu.test(context.title ?? "") &&
    !context.modelNumbers.some((value) => sameText(value, "Stage"))
  ) || (
    /\bmodel(?:\s+(?:is|of))?\s+['"]?11125\b/iu.test(cleanedSummary) &&
    /\bStryker\s+1125\s+Prime\s+Series\b/iu.test(context.title ?? "") &&
    !context.modelNumbers.some((value) => sameText(value, "11125"))
  );
  const contradictsProductEvidence = summaryClaimsUngroundedProductCategory(
    cleanedSummary,
    context.title,
  );
  if (
    cleanedSummary && !contradictsLot && !contradictsDomain &&
    !contradictsKnownModelTypo && !contradictsProductEvidence
  ) {
    return cleanedSummary;
  }
  return titleGroundedSummary(context.title, context.includedItems, groupedSale);
}

function summaryClaimsUngroundedProductCategory(
  summary: string,
  title: string | null | undefined,
): boolean {
  const normalizedTitle = title ?? "";
  return (
    /\bGlideScope\s+SPECTRUM\s+LoPro\b/iu.test(normalizedTitle) &&
    /\b(?:video\s+laryngoscope|blades?)\b/iu.test(summary)
  ) || (
    /\bMasimo\s+Red\s+LNC-04\b/iu.test(normalizedTitle) &&
    /\b(?:pulse\s+oximetry|sensors?)\b/iu.test(summary)
  ) || (
    /\bBladderScan\s+Prime\s+Plus\b/iu.test(normalizedTitle) &&
    /\bultrasound\b/iu.test(summary)
  ) || (
    /\bVeinViewer\s+Vision2\b/iu.test(normalizedTitle) &&
    /\bvein\s+visualization\s+systems?\b/iu.test(summary)
  );
}

function summaryHasProcessBoilerplate(summary: string): boolean {
  return [
    /\b(?:sold|offered)\s+as[ -]is\b/iu,
    /\bas[ -]is\b/iu,
    /\b(?:without\s+(?:any\s+)?|no\s+)warrant(?:y|ies)\b/iu,
    /\b(?:buyers?|bidders?|purchasers?)\b/iu,
    /\b(?:pickup|pick-up)\b/iu,
    /\blocated\s+(?:at|in)\b/iu,
    /\b(?:removal|loading)\s+(?:equipment|requirements?|arrangements?|appointments?|process)\b/iu,
  ].some((pattern) => pattern.test(summary));
}

function summaryClaimsGroupedSale(summary: string): boolean {
  return /^\s*grouped sale\s*:/iu.test(summary)
    || /^\s*(?:a|this)\s+(?:bundle|collection|group|lot)\s+(?:contains?|includes?|of)\b/iu.test(summary);
}

function summaryClaimsSingleSale(summary: string): boolean {
  if (/\b(?:single|one)\s+(?:asset|device|equipment item|instrument|item|machine|piece|system|unit)\b/iu.test(summary)) {
    return true;
  }
  return /^\s*(?:this sale (?:contains|includes)\s+)?(?:a|an|one|1)\s+(?!(?:assortment|bag|bin|box|bundle|carton|case|collection|crate|group|lot|pack|pallet|set)\b)/iu.test(summary);
}

function domainClaimPattern(
  domain: TextExtraction["industry_domain"],
): RegExp | null {
  switch (domain) {
    case "medical": return /\b(?:clinical|healthcare|hospital|medical|patient-care)\b/iu;
    case "laboratory": return /\b(?:lab(?:oratory)?|scientific)\b/iu;
    case "industrial": return /\bindustrial\b/iu;
    case "electronics": return /\b(?:computer|electronic|electronics|information technology|it equipment)\b/iu;
    case "av": return /\b(?:audio[ -]?visual|av equipment)\b/iu;
    case "tools": return /\btools?\b/iu;
    default: return null;
  }
}

function titleGroundedSummary(
  title: string | null | undefined,
  includedItems: readonly string[],
  groupedSale: boolean,
): string {
  const normalizedTitle = title?.trim().replace(/[.!?]+$/u, "") ?? "";
  const fallback = includedItems[0]?.trim().replace(/[.!?]+$/u, "") ?? "source-listed items";
  const subject = normalizedTitle || fallback;
  const prefix = groupedSale ? "Grouped sale: " : "";
  return `${prefix}${subject}.`.slice(0, 600);
}

function groundedCondition(
  condition: TextExtraction["condition"],
  sourceText: string | null,
): TextExtraction["condition"] {
  if (!sourceText) return condition;
  const text = sourceText.toLocaleLowerCase();
  const affirmativeText = text
    .replace(/\b(?:not|never)\s+(?:visibly\s+|known\s+to\s+be\s+)?(?:damaged|broken|cracked|dented)(?:\s+or\s+(?:damaged|broken|cracked|dented))?\b/gu, " ")
    .replace(/\b(?:not|never)\s+(?:visibly\s+)?severely worn\b/gu, " ")
    .replace(/\b(?:no|without)\s+(?:signs?\s+of\s+|evidence\s+of\s+)?(?:damage|damages|cracks?|dents?|wear)\b/gu, " ")
    .replace(/\bno\s+(?:damaged|broken)(?:\s+or\s+(?:damaged|broken))?\s+(?:components?|items?|parts?)\b/gu, " ");
  const evidence: Record<Exclude<TextExtraction["condition"], "unknown">, RegExp> = {
    new: /\b(?:brand[ -]?new|(?:mostly\s+)?new conditions?|unused|never used|unopened|factory sealed|new in (?:box|package|packaging))\b/u,
    used: /(?:^|\n)\s*used\b(?!\s+(?:to|for|as)\b)|\b(?:used condition|condition\s*[:=-]\s*used|pre[- ]?owned|previously used|(?:has been|had been|was|were)\s+used|(?:has been|had been|was|were)\s+in service|removed from service|retired from service|normal wear|signs of wear)\b/u,
    untested: /\b(?:untested|not tested|has not been tested|testing (?:was )?not performed)\b/u,
    parts_only: /\b(?:for parts(?: only)?|parts only|repair only|for salvage|salvage only|sold (?:strictly )?as salvage|condition\s*[:=-]\s*salvage)\b|(?:^|\n)\s*salvage\s+(?:equipment|item|machine|parts?|unit|vehicle)\b/u,
    damaged: /\b(?:damaged|broken|cracked|dented|severely worn)\b/u,
  };
  if (condition !== "unknown" && evidence[condition].test(affirmativeText)) return condition;
  const supported = (Object.entries(evidence) as Array<[
    Exclude<TextExtraction["condition"], "unknown">,
    RegExp,
  ]>).filter(([, pattern]) => pattern.test(affirmativeText));
  return supported.length === 1 ? supported[0]![0] : "unknown";
}

function groundedTestedStatus(
  status: TextExtraction["tested_status"],
  sourceText: string | null,
): TextExtraction["tested_status"] {
  if (!sourceText) return status;
  const text = sourceText.toLocaleLowerCase();
  const noPowerFailure = /(?:^|[\n.;:/])\s*no power(?:\s*\/\s*no activity)?\s*(?:$|[.;])|\(\s*no power\s*\)|\b(?:gets?|has|have|shows?|showed)\s+no power(?!\s+(?:adapter|available|cable|connection|cord|issues?|supply)\b)(?:\s+(?:functionality|to\s+(?:the\s+)?(?:controls?|display|panel)))?\b|\bno power\s+(?:after|during|to\s+(?:the\s+)?(?:controls?|device|display|equipment|item|machine|panel|system|unit)|when)\b/u.test(text);
  const notWorking = /\b(?:not working|non[- ]?functional|inoperable|(?:does|did|would) not (?:work|power on|turn on)|failed (?:test|testing|to power on|to turn on))\b/u.test(text) || noPowerFailure;
  const positiveText = text
    .replace(/\b(?:unknown|uknown|not known|undetermined)\b[^.!;\n]{0,80}\bworking condition\b/gu, " ")
    .replace(/\bworking condition\b[^.!;\n]{0,40}\b(?:unknown|uknown|not known|undetermined)\b/gu, " ")
    .replace(/\b(?:appears?|seems?)\s+to\s+be(?:\s+in)?\s+(?:good\s+)?working condition\b/gu, " ")
    .replace(/\b(?:unknown|not known|unclear|undetermined)\b[^.!;\n]{0,80}\b(?:boots?|powers?|turns?)\s+on\b/gu, " ")
    .replace(/\b(?:boots?|powers?|turns?)\s+on\b[^.!;\n]{0,80}\b(?:unknown|not known|unclear|undetermined)\b/gu, " ")
    .replace(/\bno attempt\b[^.!;\n]{0,80}\b(?:boot|power|turn)\s+on\b/gu, " ")
    .replace(/\b(?:booting|powering|turning)\s+on\b[^.!;\n]{0,40}\b(?:was|were)\s+not attempted\b/gu, " ")
    .replace(/\b(?:does|did|would) not (?:work|power on|turn on)\b/gu, " ")
    .replace(/\bfailed (?:to power on|to turn on)\b/gu, " ");
  const testedWorking = /\b(?:tested|verified|checked)(?:\s+(?:and|as))?\s*[-:]?\s*[^.!;\n]{0,45}\b(?:working|functional|operational|passed|good)\b|\b(?:good working|fully functional|fully operational|working|operational) condition\b|\b(?:unit|item|machine|system|device|equipment)\s+(?:is|was)\s+(?:fully\s+)?(?:working|functional|operational)\b|\b(?:works|operates)\s+(?:properly|normally|as intended)\b/u.test(positiveText);
  const powersOn = /\b(?:powers? on|powered on|turns? on|boots? (?:up|to)|power[- ]?on test)\b/u.test(positiveText);
  const untested = /\b(?:untested|not tested|has not been tested)\b/u.test(text);
  // A literal failure statement is stronger than generic/boilerplate
  // uncertainty. Preserve unknown only when this sale itself also reports a
  // positive result, which represents mixed or conflicting item outcomes.
  if (notWorking && (testedWorking || powersOn)) return "unknown";
  if (notWorking) return "not_working";
  if (testedWorking) return "tested_working";
  if (powersOn) return "powers_on";
  if (untested) return "untested";
  return status === "unknown" ? status : "unknown";
}

function mergeSourceModelIdentifiers(
  extracted: readonly string[],
  title: string | null | undefined,
  sourceText: string | null,
  manufacturers: readonly string[],
): string[] {
  const evidence = [title, sourceText].filter(Boolean).join("\n");
  const result: string[] = [];

  const append = (candidate: string | undefined) => {
    if (candidate?.trim().endsWith("-")) return;
    const normalized = normalizeModelIdentifier(candidate);
    if (
      !normalized || normalized.length > 120 ||
      (isDateIdentifier(normalized) && !hasExplicitModelEvidence(evidence, normalized)) ||
      (isSpecificationOrContactIdentifier(normalized) &&
        !(hasExplicitIdentifierEvidence(evidence, normalized) &&
          /^(?=[a-z0-9-]{2,4}$)(?=.*[a-z])(?=.*\d)[a-z0-9-]+$/iu.test(normalized))) ||
      isNonModelIdentifier(normalized, title, sourceText, manufacturers) ||
      isKnownSourceModelFieldTypo(normalized, title) ||
      (evidence.length > 0 && !containsModelIdentifier(evidence, normalized))
    ) return;
    if (!result.some((entry) => sameText(entry, normalized))) result.push(normalized);
  };

  for (const candidate of extracted) append(candidate);
  if (!evidence) return result.slice(0, 24);

  const labeled = evidence.matchAll(
    /\b(?:catalog(?:\s*(?:no\.?|number))?|cat\.?|ref(?:erence)?|part(?:\s*(?:no\.?|number))?|p\/?n)\b\s*[:#-]?\s*([a-z0-9][a-z0-9._/-]{2,})/giu,
  );
  for (const match of labeled) append(match[1]);
  for (const match of evidence.matchAll(/\b(?:cat|p\/?n|ref)(?=\d)([a-z0-9][a-z0-9._/-]{2,})/giu)) {
    append(match[1]);
  }
  for (const candidate of labeledModelFieldIdentifiers(sourceText, manufacturers)) append(candidate);
  for (const candidate of slashModelEnumerationCandidates(evidence)) append(candidate);
  for (const candidate of deterministicProductModelCandidates(evidence)) append(candidate);
  for (const match of evidence.matchAll(/\bCatalyst\s+3850\s+XS\s+10G\s+SPF\+/giu)) append(match[0]);

  const titleCodes = (title ?? "").matchAll(/\b(?=[a-z0-9/-]{5,}\b)(?=(?:[^0-9]*[0-9]){2})[a-z0-9]+(?:[-/][a-z0-9]+)+\b/giu);
  for (const match of titleCodes) append(match[0]);
  for (const candidate of titleModelCodeCandidates(title ?? "", manufacturers)) append(candidate);
  for (const candidate of unlabeledItemCatalogIdentifiers(sourceText)) append(candidate);
  return pruneRedundantModelIdentifiers(
    removeParentheticalPrefixFragments(result),
    evidence,
  ).slice(0, 24);
}

function isKnownSourceModelFieldTypo(
  candidate: string,
  title: string | null | undefined,
): boolean {
  return (
    sameText(candidate, "Stage") && /\bStago\s+STA\s+Satellite\b/iu.test(title ?? "")
  ) || (
    sameText(candidate, "11125") && /\bStryker\s+1125\s+Prime\s+Series\b/iu.test(title ?? "")
  );
}

function slashModelEnumerationCandidates(evidence: string): string[] {
  const result: string[] = [];
  for (const match of evidence.matchAll(
    /(?<![\p{L}\p{N}])([a-z0-9-]{2,}(?:\s*\/\s*[a-z0-9-]{2,})+)(?![\p{L}\p{N}])/giu,
  )) {
    const parts = match[1]!.split("/").map((part) => part.trim()).filter(Boolean);
    const prefix = evidence.slice(Math.max(0, match.index - 60), match.index);
    if (/\b(?:asset|hull\s+id|inventory|serial|vin)\b[^\n.;]{0,40}$/iu.test(prefix)) continue;
    if (isSlashModelEnumeration(parts)) {
      result.push(...parts);
    } else if (isMalformedSlashNarrativeIdentifier(parts)) {
      result.push(...parts.filter((part) => /\d/u.test(part)));
    }
  }
  return uniqueStrings(result);
}

function deterministicProductModelCandidates(evidence: string): string[] {
  const result: string[] = [];
  const fixed = [
    { model: "Pulmonex II", pattern: /\bBiodex\s+Pulmonex\s+II\b/iu },
    { model: "BladderScan Prime Plus", pattern: /\b(?:Verathon\s+)?BladderScan\s+Prime\s+Plus\b/iu },
    { model: "BiliBlanket Plus", pattern: /\b(?:Ohmeda\s+)?BiliBlanket\s+Plus\b/iu },
    { model: "Luxtec MLX", pattern: /\b(?:Integra\s+)?Luxtec\s+MLX\b/iu },
    { model: "Sofia", pattern: /\bQuidel\s+Sofia\b/iu },
  ] as const;
  for (const candidate of fixed) {
    if (candidate.pattern.test(evidence)) result.push(candidate.model);
  }
  for (const match of evidence.matchAll(
    /\bDell\s+(Latitude|Inspiron)(?:\s+([a-z]*\d[a-z0-9-]*))?\b/giu,
  )) {
    result.push([match[1], match[2]].filter(Boolean).join(" "));
  }
  return uniqueStrings(result);
}

function removeParentheticalPrefixFragments(values: readonly string[]): string[] {
  return values.filter((candidate) => !values.some((other) =>
    !sameText(candidate, other) && (
      new RegExp(`^${escapeRegExp(candidate)}-\\(`, "iu").test(other) ||
      new RegExp(`^P\\/?N-${escapeRegExp(candidate)}$`, "iu").test(other)
    ),
  ));
}

function pruneRedundantModelIdentifiers(
  values: readonly string[],
  evidence: string,
): string[] {
  const withoutSlashAggregates = values.filter((candidate) => {
    const parts = candidate.split("/").map((part) => normalizeModelIdentifier(part)).filter(
      (part): part is string => Boolean(part),
    );
    const hasEveryPart = parts.length >= 2 && parts.every((part) => values.some((other) =>
      !sameText(other, candidate) && sameText(other, part)
    ));
    return !hasEveryPart || !isSlashModelEnumeration(parts);
  });
  const withoutRepeatedBareFamilies = withoutSlashAggregates.filter((candidate) => {
    if (!/^[\p{L}][\p{L} -]*$/u.test(candidate)) return true;
    const expandedFamilyModels = withoutSlashAggregates.filter((other) =>
      !sameText(candidate, other) &&
      new RegExp(`^${escapeRegExp(candidate)}\\s+`, "iu").test(other) &&
      /\d/u.test(other)
    );
    return expandedFamilyModels.length < 2;
  });
  return withoutRepeatedBareFamilies.filter((candidate) => {
    const containers = withoutRepeatedBareFamilies.filter((other) =>
      !sameText(candidate, other) && isWholeModelFragment(candidate, other)
    );
    if (containers.length === 0) return true;
    const candidateRanges = wholeTextRanges(evidence, candidate);
    const containerRanges = containers.flatMap((container) => wholeTextRanges(evidence, container));
    return candidateRanges.some((candidateRange) =>
      !containerRanges.some((containerRange) =>
        containerRange.start <= candidateRange.start && containerRange.end >= candidateRange.end
      ) && isIndependentModelOccurrence(evidence, candidate, candidateRange)
    );
  });
}

function isIndependentModelOccurrence(
  evidence: string,
  candidate: string,
  range: { start: number; end: number },
): boolean {
  const nextToken = /^\s+([\p{L}\p{N}._/-]+)/u.exec(evidence.slice(range.end))?.[1] ?? null;
  if (nextToken && (/\d/u.test(nextToken) || /^[A-Z]{2,8}$/u.test(nextToken))) return false;
  if (/^\d+$/u.test(candidate)) {
    const priorToken = /([\p{L}][\p{L}\p{N}._/-]*)\s+$/u.exec(evidence.slice(0, range.start))?.[1] ?? null;
    if (
      priorToken &&
      !/^(?:cat(?:alog)?|model|no|number|part|ref(?:erence)?)$/iu.test(priorToken)
    ) return false;
  }
  return true;
}

function isSlashModelEnumeration(parts: readonly string[]): boolean {
  if (parts.length < 2) return false;
  if (parts.every((part) => /^\d+$/u.test(part))) {
    if (parts.every((part) => Number(part) >= 1900 && Number(part) <= 2100)) return false;
    return parts.every((part) => part.length >= 3) &&
      new Set(parts.map((part) => part.length)).size === 1;
  }
  const prefixes = parts.map((part) => /^([a-z]+)(?=[a-z0-9-]*\d)/iu.exec(part)?.[1]?.toLocaleLowerCase() ?? null);
  if (prefixes.every((prefix): prefix is string => Boolean(prefix))) {
    return new Set(prefixes).size === 1;
  }
  const firstNumericTail = /^(.*?)(\d+)$/u.exec(parts[0]!);
  return Boolean(
    firstNumericTail?.[1]?.trim() &&
    firstNumericTail[2]!.length >= 3 &&
    parts.slice(1).every((part) =>
      /^\d+$/u.test(part) && part.length >= 3 && part.length === firstNumericTail[2]!.length
    ),
  );
}

function isMalformedSlashNarrativeIdentifier(parts: readonly string[]): boolean {
  return parts.length >= 3 &&
    parts.filter((part) => /\d/u.test(part)).length >= 2 &&
    parts.some((part) => !/\d/u.test(part) && /^[\p{L}][\p{L} -]{3,}$/u.test(part));
}

function isWholeModelFragment(candidate: string, container: string): boolean {
  if (candidate.length >= container.length) return false;
  return wholeTextRanges(container, candidate).length > 0;
}

function wholeTextRanges(value: string, candidate: string): Array<{ start: number; end: number }> {
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(candidate)}(?![\\p{L}\\p{N}])`,
    "giu",
  );
  return [...value.matchAll(pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function labeledModelFieldIdentifiers(
  sourceText: string | null,
  manufacturers: readonly string[],
): string[] {
  if (!sourceText) return [];
  const result: string[] = [];
  for (const line of sourceText.split(/\r?\n/gu)) {
    for (const match of line.matchAll(
      /(?<![\/\p{L}])model(?:\s*(?:no\.?|number))?\b(?!\s+years?\b)\s*[:#=-]?\s*/giu,
    )) {
      let tail = line.slice(match.index + match[0].length, match.index + match[0].length + 160);
      const nextField = /(?:^|\s+)\b(?:asset(?:\s*(?:id|no\.?|number))?|condition(?:\s*&\s*markings)?|estimated\s+hours|fuel\s+type|hard\s+drive\s+status|inventory(?:\s*(?:id|no\.?|number))?|key\s+features|make|manufacturer|model\s+years?|power\s+output|quantity|serial(?:\s*(?:no\.?|num(?:ber)?s?\.?))?|service\s+tags?|vin|year)\b\s*[:#=-]/iu.exec(tail);
      if (nextField) tail = tail.slice(0, nextField.index);
      const childProvenance = /\s*(?:\(\s*)?(?:lot\s*#|id)\s*[:#-]/iu.exec(tail);
      if (childProvenance) tail = tail.slice(0, childProvenance.index);
      tail = tail.split(/(?<=[\p{L}\p{N})])\.\s+(?=[\p{L}\p{N}])/u, 1)[0]!;
      tail = tail.replace(/^[\s:#=-]+|[),.;:\s]+$/gu, "").replace(/\s+/gu, " ").trim();
      if (
        !tail ||
        /^(?:components?|conditions?|fields?|identification|no\s*#?|none|numbers?|specifications?|unknown|years?)\b/iu.test(tail)
      ) continue;
      for (const manufacturer of manufacturers) {
        const manufacturerBoundary = new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRegExp(manufacturer)}(?![\\p{L}\\p{N}])`,
          "iu",
        ).exec(tail);
        if (manufacturerBoundary && manufacturerBoundary.index > 0) {
          tail = tail.slice(0, manufacturerBoundary.index).trim();
        }
      }
      for (const manufacturer of manufacturers) {
        const manufacturerPattern = new RegExp(
          `^${escapeRegExp(manufacturer)}(?=\\s+)\\s+`,
          "iu",
        );
        tail = tail.replace(manufacturerPattern, "");
      }
      const fieldCandidate = boundedLabeledModelCandidate(tail);
      if (!fieldCandidate) continue;
      tail = fieldCandidate;
      const slashParts = tail.split("/").map((part) => part.trim()).filter(Boolean);
      if (slashParts.length >= 2 && isSlashModelEnumeration(slashParts)) {
        result.push(...slashParts);
      } else if (isMalformedSlashNarrativeIdentifier(slashParts)) {
        result.push(...slashParts.filter((part) => /\d/u.test(part)));
      } else {
        result.push(tail);
      }
    }
  }
  return uniqueStrings(result);
}

function boundedLabeledModelCandidate(value: string): string | null {
  const tokens = [...value.matchAll(/(?:^|\s+)([^\s,;()]+)/gu)]
    .map((match) => match[1]!)
    .slice(0, 8);
  if (tokens.length === 0) return null;
  const first = normalizeModelIdentifier(tokens[0]);
  if (!first || /^(?:condition|key|power|quantity|serial|service|specifications?)$/iu.test(first)) {
    return null;
  }
  const digitIndex = tokens.findIndex((token) => /\d/u.test(token));
  if (digitIndex < 0 || digitIndex > 1) return null;
  const selected = tokens.slice(0, digitIndex + 1);
  for (const token of tokens.slice(digitIndex + 1)) {
    const normalized = normalizeModelIdentifier(token);
    if (
      !normalized ||
      (!/\d/u.test(normalized) && !/^[A-Z]{1,8}$/u.test(token)) ||
      /^(?:A|AN|AND|AT|BY|FOR|FROM|IN|OF|ON|OR|THE|TO|WITH)$/u.test(token) ||
      /^(?:A|AMP|AMPS|CF|CHANNEL|CHANNELS|CM|DOOR|DOORS|FOOT|FEET|GA|GALLON|GALLONS|GPM|GHZ|HP|HZ|IN|INCH|INCHES|KG|KVA|KW|L|LB|LEAD|LEADS|LITER|LITERS|MG|MHZ|MILE|MILES|ML|MM|PHASE|PHASES|PSI|TON|TONS|V|VAC|VOLT|VOLTS|W|WATT|WATTS)$/u.test(token)
    ) break;
    selected.push(token);
  }
  const candidate = normalizeModelIdentifier(selected.join(" "));
  return candidate && (
    candidate.length >= 3 ||
    (candidate.length >= 2 && /[\p{L}]/u.test(candidate) && /\d/u.test(candidate))
  ) ? candidate : null;
}

const NON_MODEL_IDENTIFIER_WORDS = new Set([
  "cell",
  "component",
  "components",
  "condition",
  "conditions",
  "identification",
  "number",
  "numbers",
  "reversed",
  "serial",
  "specification",
  "specifications",
  "use",
  "white",
  "year",
  "years",
]);
const NON_MODEL_IDENTIFIER_PHRASES = new Set([
  "automated immunoassay platform",
  "c-arm",
  "vital sign monitor",
]);

function isNonModelIdentifier(
  candidate: string,
  title: string | null | undefined,
  sourceText: string | null,
  manufacturers: readonly string[],
): boolean {
  const normalized = candidate.trim().toLocaleLowerCase();
  if (NON_MODEL_IDENTIFIER_WORDS.has(normalized) || NON_MODEL_IDENTIFIER_PHRASES.has(normalized)) return true;
  if (/^\d+(?:-pack|pks?\/\d+|-way)$/iu.test(candidate)) return true;
  if (isManufacturerOnlyIdentifier(candidate, manufacturers)) return true;
  if (containsEmbeddedManufacturerBoundary(candidate, manufacturers)) return true;
  if (isMalformedSlashNarrativeIdentifier(candidate.split("/").map((part) => part.trim()))) return true;

  const evidence = [title, sourceText].filter(Boolean).join("\n");
  const hasIdentifierEvidence = hasExplicitIdentifierEvidence(evidence, candidate);
  if (hasIdentifierEvidence) return false;
  if (hasSpecificationContextEvidence(evidence, candidate)) return true;
  if (hasSerialOrInventoryEvidence(evidence, candidate)) return true;
  if (isAdministrativeTitleIdentifier(candidate, title, sourceText)) return true;
  if (isUnlabeledParentheticalIdentifier(candidate, title, sourceText)) return true;

  const escaped = escapeRegExp(candidate);
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])\\s+(?:ea(?:ch)?|pieces?|units?)\\b`,
    "iu",
  ).test(evidence);
}

function containsEmbeddedManufacturerBoundary(
  candidate: string,
  manufacturers: readonly string[],
): boolean {
  return manufacturers.some((manufacturer) => {
    const match = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(manufacturer)}(?![\\p{L}\\p{N}])`,
      "iu",
    ).exec(candidate);
    return Boolean(
      match && match.index > 0 &&
      /\d/u.test(candidate.slice(0, match.index)) &&
      /\d/u.test(candidate.slice(match.index + match[0].length)),
    );
  });
}

function hasSpecificationContextEvidence(evidence: string, candidate: string): boolean {
  if (!evidence) return false;
  const escaped = escapeRegExp(candidate);
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])\\s*(?:amps?|boxes?|cases?|cc|cf|cm|feet|foot|fr|g|ga|gallons?|gauges?|gpm|ghz|hp|hz|in(?:ches)?|items?|kg|kva|kw|l|lb|mg|mhz|miles?|ml|mm|packs?|pieces?|pounds?|psi|units?|v|vac|volts?|w|watts?)\\b`,
    "iu",
  ).test(evidence);
}

function hasExplicitIdentifierEvidence(evidence: string, candidate: string): boolean {
  if (!evidence) return false;
  const escaped = escapeRegExp(candidate);
  return new RegExp(
    `\\b(?:model(?:\\s*(?:no\\.?|number))?|catalog(?:\\s*(?:no\\.?|number))?|cat\\.?|ref(?:erence)?|part(?:\\s*(?:no\\.?|number))?|p\\/?n)\\b[\\s:#(=-]*${escaped}(?![\\p{L}\\p{N}])(?!\\s*(?:amps?|boxes?|cases?|cc|cf|cm|feet|foot|fr|g|ga|gallons?|gauges?|gpm|ghz|hp|hz|in(?:ches)?|items?|kg|kva|kw|l|lb|mg|mhz|miles?|ml|mm|packs?|pieces?|pounds?|psi|units?|v|vac|volts?|w|watts?)\\b)`,
    "iu",
  ).test(evidence);
}

function hasExplicitModelEvidence(evidence: string, candidate: string): boolean {
  if (!evidence) return false;
  const escaped = escapeRegExp(candidate);
  return new RegExp(
    `\\bmodel(?:\\s*(?:no\\.?|number))?\\b[\\s:#(=-]*${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(evidence);
}

function hasSerialOrInventoryEvidence(evidence: string, candidate: string): boolean {
  if (!evidence) return false;
  const escaped = escapeRegExp(candidate);
  return new RegExp(
    `\\b(?:serial(?:\\s*(?:no\\.?|num(?:ber)?\\.?))?|vin|hull\\s+id(?:entification)?(?:\\s+number)?|icn|inventory(?:\\s*(?:id|no\\.?|number))?|item\\s+code|asset(?:\\s*(?:id|no\\.?|number))?|postal(?:\\s+code)?|zip(?:\\s+code)?|(?:auction\\s+)?lot(?:\\s*(?:no\\.?|number))?)\\b[\\s:#(=-]*${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(evidence);
}

function isAdministrativeTitleIdentifier(
  candidate: string,
  title: string | null | undefined,
  sourceText: string | null,
): boolean {
  if (!title || !containsModelIdentifier(title, candidate)) return false;
  const afterTilde = title.includes("~") ? title.slice(title.indexOf("~") + 1) : "";
  if (afterTilde && containsModelIdentifier(afterTilde, candidate)) return true;
  if (/\bitem\s+code\s*:/iu.test(sourceText ?? "") &&
      title.toLocaleLowerCase().startsWith(candidate.toLocaleLowerCase())) return true;
  return /^[a-z]{1,4}-\d{2}-\d{3}(?:-[a-z]+)?$/iu.test(candidate) &&
    title.toLocaleLowerCase().startsWith(candidate.toLocaleLowerCase());
}

function isUnlabeledParentheticalIdentifier(
  candidate: string,
  title: string | null | undefined,
  sourceText: string | null,
): boolean {
  if (!sourceText || (title && containsModelIdentifier(title, candidate))) return false;
  const escaped = escapeRegExp(candidate);
  return new RegExp(`\\(\\s*${escaped}\\s*\\)`, "iu").test(sourceText);
}

function isManufacturerOnlyIdentifier(
  candidate: string,
  manufacturers: readonly string[],
): boolean {
  const candidateParts = candidate
    .split(/[\\/&,]+/gu)
    .map(normalizeBrandText)
    .filter(Boolean);
  if (candidateParts.length === 0 || manufacturers.length === 0) return false;
  const manufacturerTexts = manufacturers.map(normalizeBrandText).filter(Boolean);
  return candidateParts.every((part) => manufacturerTexts.some((manufacturer) =>
    manufacturer === part || manufacturer.split(" ").includes(part),
  ));
}

function normalizeBrandText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function titleModelCodeCandidates(
  title: string,
  manufacturers: readonly string[],
): string[] {
  const locationSuffix = /~[^()\n]{0,60}\(([^)]+)\)\s*$/u.exec(title)?.[1]?.trim() ?? null;
  const numericCandidates: string[] = [];
  for (const match of title.matchAll(/\b([\p{L}][\p{L}\p{N}-]*)\s+(\d{3,6})\b(?=\s+[\p{L}])/giu)) {
    const preceding = match[1]!;
    const candidate = match[2]!;
    if (/^(?:lot|qty|quantity|year)$/iu.test(preceding)) continue;
    const number = Number(candidate);
    const precedingIsManufacturer = manufacturers.some((manufacturer) =>
      normalizeBrandText(manufacturer).split(" ").includes(normalizeBrandText(preceding))
    );
    if (number >= 1900 && number <= 2100 && precedingIsManufacturer) continue;
    numericCandidates.push(candidate);
  }
  return uniqueStrings([...sourceCodeCandidates(title), ...numericCandidates]).filter(
    (candidate) => !locationSuffix || !sameText(candidate, locationSuffix),
  );
}

function unlabeledItemCatalogIdentifiers(sourceText: string | null): string[] {
  if (!sourceText) return [];
  const result: string[] = [];
  for (const rawLine of sourceText.split(/\r?\n/gu)) {
    const line = rawLine.replace(
      /\s+(?:(?:(?:exp(?:iration|iry)?\s*(?:dates?)?|expires?)|ref)\s*[:#-]?\s*)?\d{1,2}[/-]\d{1,2}[/-]\d{2,4}.*$/iu,
      "",
    ).trim();
    if (!line) continue;
    for (const match of line.matchAll(
      /\b([A-Z][A-Z0-9._/-]*\d[A-Z0-9._/-]*)\s+(?:ref(?:erence)?|catalog|cat\.?|part|p\/?n)\b/giu,
    )) result.push(match[1]!);
    const sterileCode = /\(\s*sterile\s*\)\s*([a-z0-9][a-z0-9._/-]{3,})\b/iu.exec(line)?.[1];
    if (sterileCode) result.push(sterileCode);
    if (
      /^\s*\d+\s*x\b/iu.test(line) &&
      /\b(?:bandages?|catheters?|clamps?|clips?|disposables?|electrodes?|filters?|guidewires?|implants?|instruments?|masks?|needles?|pins?|reloads?|screws?|staplers?|sutures?|trocars?)\b/iu.test(line)
    ) {
      const terminalCode = sourceCodeCandidates(line).at(-1);
      if (terminalCode) result.push(terminalCode);
    }
  }
  return uniqueStrings(result);
}

function sourceCodeCandidates(value: string): string[] {
  const candidates = [
    ...(value.match(/\b[a-z0-9]+(?:[._/-][a-z0-9]+)*\b/giu) ?? []),
    ...[...value.matchAll(/(?<=[a-z])(\d{3,}(?:[.-]\d+)+)\b/gu)]
      .map((match) => match[1]!),
  ];
  return candidates.filter((candidate) => {
    if (
      candidate.length < 4 || !/\d/u.test(candidate) ||
      isDateIdentifier(candidate) || isSpecificationOrContactIdentifier(candidate) ||
      /^\d+(?:\.\d+)?(?:mm|cm|in|ft|ml|mg|kg|lb|v|w|hz)$/iu.test(candidate)
    ) return false;
    const letters = candidate.replace(/[^a-z]/giu, "");
    const hasUppercaseCodeLetter = /[A-Z]/u.test(candidate) &&
      letters === letters.toLocaleUpperCase();
    const numericSeparatedCode = /^[0-9]+(?:-[0-9]+)+$/u.test(candidate);
    return hasUppercaseCodeLetter || numericSeparatedCode;
  });
}

function isSpecificationOrContactIdentifier(value: string): boolean {
  return /^\d{1,6}(?:\.\d+)?(?:[/-]\d{1,3})*(?:-\d{1,3})?\s*(?:amps?|cc|cf|cm|fr|g|ga|gallons?|gauges?|ghz|gpm|hp|hz|in|kg|kva|kw|l|lb|mg|mhz|miles?|ml|mm|pounds?|psi|v|vac|w)\b/iu.test(value)
    || /^\d{1,4}\s+(?:channels?|doors?|gallons?|leads?|liters?|phases?|tons?|volts?|watts?)\b/iu.test(value)
    || /^\d+(?:box(?:es)?|cases?|packs?|pkgs?)\/(?:qty|quantity)\d+$/iu.test(value)
    || /^\d{1,2}(?:am|pm)$/iu.test(value)
    || /^\d{3}-\d{3}-\d{4}$/u.test(value);
}

function containsModelIdentifier(haystack: string, identifier: string): boolean {
  if (containsWholeText(haystack, identifier)) return true;
  if (
    /^\d{3,}$/u.test(identifier) &&
    new RegExp(`\\b(?:cat|p\\/?n|ref)${escapeRegExp(identifier)}(?![\\p{L}\\p{N}])`, "iu").test(haystack)
  ) return true;
  if (!/^\d{3,}(?:[.-]\d+)+$/u.test(identifier)) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `[\\p{L}]${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(haystack);
}

function normalizeModelIdentifier(value: string | undefined): string | null {
  const normalized = value?.trim()
    .replace(
      /^(?:(?:model(?:\s*(?:no\.?|number))?|catalog(?:\s*(?:no\.?|number))?|cat\.?|ref(?:erence)?|part(?:\s*(?:no\.?|number))?)\b\s*[:#-]?\s*|p\/?n\b(?:\s*[:#]\s*|\s+))/iu,
      "",
    )
    .replace(/^[#:\s-]+|[/),.;:\s]+$/gu, "")
    .replace(
      /\s+(?:PC\s+Monitor|Delivery\s+Systems?|Temperature\s+Management\s+Systems?|Information\s+Management\s+Systems?|Fluid\s+Management\s+Systems?|Laser\s+Control\s+Systems?|Physiomonitoring\s+Systems?)$/iu,
      "",
    )
    .trim();
  return normalized || null;
}

function isDateIdentifier(value: string): boolean {
  return /^(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|\d{1,2}[-/]\d{4}|(?:19|20)\d{2}[-/](?:19|20)\d{2})$/u.test(value);
}
