import type { LocationEvidenceSource } from "./listings";
import { DomainValidationError } from "./errors";
import {
  deriveDisplayLotType,
  type LotClassificationContext,
} from "./lot-classification";

export const industryDomains = [
  "medical",
  "laboratory",
  "industrial",
  "electronics",
  "av",
  "tools",
  "other",
  "unknown",
] as const;
export const lotTypes = [
  "single_item",
  "multi_item_lot",
  "assorted_lot",
  "unknown",
] as const;
export const conditionValues = [
  "new",
  "used",
  "untested",
  "parts_only",
  "damaged",
  "unknown",
] as const;
export const testedStatuses = [
  "tested_working",
  "powers_on",
  "untested",
  "not_working",
  "unknown",
] as const;

export interface ListingTextExtraction {
  shortSummary: string;
  assetClasses: string[];
  industryDomain: (typeof industryDomains)[number];
  manufacturer: string | null;
  manufacturers: string[];
  modelNumbers: string[];
  /**
   * A lot contains multiple sold items or pieces, including repeated supplies
   * and explicit container groupings. Supporting content for one complete
   * primary system does not make that listing a lot.
   */
  lotType: (typeof lotTypes)[number];
  includedItems: string[];
  missingItems: string[];
  condition: (typeof conditionValues)[number];
  testedStatus: (typeof testedStatuses)[number];
  highValueSignals: string[];
  negativeSignals: string[];
  regulatoryOrSafetyFlags: string[];
  /** Candidate evidence only; deterministic fields retain authority. */
  pickupLocationEvidence: {
    city: string | null;
    state: string | null;
    postalCode: string | null;
    sourceSection: Exclude<
      LocationEvidenceSource,
      "visible_listing" | "detail_page"
    >;
  };
}

/** JSON Schema sent to providers that support constrained generation. */
export const listingTextExtractionJsonSchema = {
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
    short_summary: { type: "string", minLength: 1 },
    asset_classes: { type: "array", items: { type: "string" } },
    industry_domain: { type: "string", enum: industryDomains },
    manufacturer: { type: ["string", "null"] },
    manufacturers: { type: "array", items: { type: "string" } },
    model_numbers: {
      type: "array",
      description:
        "Independently expressed source model/catalog/part/reference identifiers, without redundant fragments, generic product classes, packaging quantities, or duplicate slash aggregates.",
      items: { type: "string" },
    },
    lot_type: {
      type: "string",
      enum: lotTypes,
      description:
        "Classify the complete sale grouping and make the answer agree with included_items in both directions. Multiple copies or pieces are a lot, including a box, case, pack, carton, crate, bag, bin, pallet, or bundle clearly containing multiple units even when the exact inner count is missing or approximate. A parts/supply-only collection is still a lot. Packaging alone does not establish a lot, and one complete primary system with subordinate parts, accessories, supplies, attached equipment, or an integral subsystem remains single_item.",
    },
    included_items: {
      type: "array",
      description:
        "Explicitly named contents with quantities preserved; distinguish whole primary equipment and independently itemized main sale assets from subordinate parts, accessories, attached/onboard items, supplies, and consumables. Use separate entries per whole-primary type/model or an explicit numeric minimum so the normalized lot label has auditable evidence.",
      items: { type: "string" },
    },
    missing_items: { type: "array", items: { type: "string" } },
    condition: { type: "string", enum: conditionValues },
    tested_status: { type: "string", enum: testedStatuses },
    high_value_signals: { type: "array", items: { type: "string" } },
    negative_signals: { type: "array", items: { type: "string" } },
    regulatory_or_safety_flags: { type: "array", items: { type: "string" } },
    pickup_location_evidence: {
      type: "object",
      additionalProperties: false,
      required: ["city", "state", "postal_code", "source_section"],
      properties: {
        city: { type: ["string", "null"] },
        state: { type: ["string", "null"] },
        postal_code: { type: ["string", "null"] },
        source_section: {
          type: "string",
          enum: ["description", "removal", "inspection", "other", "unknown"],
        },
      },
    },
  },
} as const;

/** Validates the provider's snake_case wire JSON and maps it to domain casing. */
export function parseListingTextExtraction(
  value: unknown,
  context: LotClassificationContext = {},
): ListingTextExtraction {
  const input = objectValue(value, "extraction");
  const pickup = objectValue(
    input.pickup_location_evidence,
    "pickup_location_evidence",
  );
  const shortSummary = stringValue(input.short_summary, "short_summary");
  const includedItems = stringArray(input.included_items, "included_items");
  const lotType = deriveDisplayLotType(
    enumValue(input.lot_type, lotTypes, "lot_type"),
    includedItems,
    { ...context, shortSummary },
  );
  const suppliedManufacturer = nullableString(input.manufacturer, "manufacturer");
  const manufacturers = uniqueText([
    ...(suppliedManufacturer ? [suppliedManufacturer] : []),
    ...stringArray(input.manufacturers, "manufacturers"),
  ]);
  return {
    shortSummary,
    assetClasses: stringArray(input.asset_classes, "asset_classes"),
    industryDomain: enumValue(
      input.industry_domain,
      industryDomains,
      "industry_domain",
    ),
    manufacturer: manufacturers.length === 1 ? manufacturers[0]! : null,
    manufacturers,
    modelNumbers: stringArray(input.model_numbers, "model_numbers"),
    lotType,
    includedItems,
    missingItems: stringArray(input.missing_items, "missing_items"),
    condition: enumValue(input.condition, conditionValues, "condition"),
    testedStatus: enumValue(input.tested_status, testedStatuses, "tested_status"),
    highValueSignals: stringArray(input.high_value_signals, "high_value_signals"),
    negativeSignals: stringArray(input.negative_signals, "negative_signals"),
    regulatoryOrSafetyFlags: stringArray(
      input.regulatory_or_safety_flags,
      "regulatory_or_safety_flags",
    ),
    pickupLocationEvidence: {
      city: nullableString(pickup.city, "pickup_location_evidence.city"),
      state: nullableString(pickup.state, "pickup_location_evidence.state"),
      postalCode: nullableString(
        pickup.postal_code,
        "pickup_location_evidence.postal_code",
      ),
      sourceSection: enumValue(
        pickup.source_section,
        ["description", "removal", "inspection", "other", "unknown"] as const,
        "pickup_location_evidence.source_section",
      ),
    },
  };
}

function uniqueText(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!result.some((entry) => entry.toLocaleLowerCase() === value.toLocaleLowerCase())) {
      result.push(value);
    }
  }
  return result;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainValidationError(`${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainValidationError(`${field} must be a non-empty string`, field);
  }
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return stringValue(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new DomainValidationError(`${field} must be an array`, field);
  }
  return value.map((item, index) => stringValue(item, `${field}[${index}]`));
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new DomainValidationError(`${field} has an unsupported value`, field);
  }
  return value;
}
