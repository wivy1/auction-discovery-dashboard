export interface ListingTextForEnrichment {
  source: string;
  sourceListingId: string;
  title: string;
  category: string | null;
  cleanDescription: string;
  rawDescription?: string | null;
  seller?: string | null;
  pickupLocationText?: string | null;
  removalText?: string | null;
}

export const EXTRACTION_PROMPT_VERSION = "text-extraction-v26";
export const COMPATIBLE_EXTRACTION_PROMPT_VERSIONS = [
  "text-extraction-v25",
  "text-extraction-v24",
  "text-extraction-v23",
  "text-extraction-v22",
  "text-extraction-v21",
  "text-extraction-v20",
  "text-extraction-v19",
  "text-extraction-v18",
  "text-extraction-v12",
] as const;
export const LEGACY_EXTRACTION_PROMPT_VERSION = "text-extraction-v11";
export const SEMANTIC_DOCUMENT_VERSION = "semantic-document-v16";

const V19_PRESENTATION_EXAMPLE =
  "More examples: 1 interactive whiteboard plus 1 multimedia projector = assorted_lot; a separately itemized dozer blade plus a separately itemized grapple scrap handler = assorted_lot; 1 tractor with an attached mower = single_item; 1 truck with a winch, toolbox, tires, or other onboard equipment = single_item.";
const CURRENT_PRESENTATION_EXAMPLE =
  "More examples: 1 interactive whiteboard with its included multimedia projector for a complete presentation setup = single_item; an interactive whiteboard plus a separately offered projector = assorted_lot; a separately itemized dozer blade plus a separately itemized grapple scrap handler = assorted_lot; 1 tractor with an attached mower = single_item; 1 truck with a winch, toolbox, tires, or other onboard equipment = single_item.";

export function buildExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short strings each for manufacturers and model_numbers, and at most eight short strings per other array.",
    [
      "Treat a box, case, pack, carton, crate, bag, bin, pallet, or bundle clearly containing multiple units as a lot even when the exact inner count is missing or approximate. Packaging alone does not establish a lot; one item in its original, carrying, shipping, or storage packaging remains single_item.",
      "A standalone BUNDLE marker in the source title establishes that the source is selling a grouped lot even when no exact inner count is stated. Preserve that grouping in lot_type, but do not emit synthetic metadata such as 'Source grouping: bundle' as an included sale item.",
    ],
    CURRENT_PRESENTATION_EXAMPLE,
    [
      "For model_numbers, return the longest independently expressed source value for each model, catalog, part, or reference identifier. Do not also return word or number fragments that occur only inside a longer returned value, generic product classes, packaging/quantity strings, or a combined slash form when its separately supported component codes are retained. Preserve a shorter overlapping value only when the source independently states it in another title token, labeled field, or delimited code.",
      "Retain an exact short alphanumeric value when it is explicitly labeled as a model, such as Model: 3V. Exclude generic product-class suffixes such as PC Monitor, Delivery System, Temperature Management System, Information Management System, Fluid Management System, or Laser Control System from the model value.",
      "Use the most specific source-supported equipment type in asset_classes, such as defibrillator, centrifuge, slide stainer, microscope, television, treadmill, MRI coil, or adapter cable. Do not stop at a generic class such as medical equipment when the title names the equipment type.",
      "Do not treat a product family such as Dash in Dash 4000 as a manufacturer unless the source explicitly identifies it as a make, brand, or manufacturer. Collapse obvious spelling variants of the same manufacturer instead of returning duplicates.",
      "Never add a leading quantity of 1 to included_items unless that exact count is present in the source text or title.",
      "short_summary must agree with lot_type and industry_domain. Do not call a grouped sale one or a single item, and do not claim a domain that the source does not support. included_items must contain only source-listed sale contents, never synthetic metadata such as a Source grouping entry.",
      "short_summary is a concise restatement, not independent evidence. Base lot_type, industry_domain, asset_classes, and every other fact on the source title and item text so validating the structured result again cannot change it.",
      "When the title states an aggregate Lot of N or Qty N but does not allocate that total among named types, preserve the source total as an included_items entry instead of silently dropping it or inventing per-type quantities.",
      "Words such as assorted, mixed, and miscellaneous establish that a sale is a lot but do not determine its subtype. Multiple units of one general primary type remain multi_item_lot across brand or model variations; use assorted_lot only when the primary item types differ. An explicit plural primary-equipment noun such as laptops, monitors, switches, printers, projectors, carts, or washers establishes multiple sale items even when the exact count is unstated.",
    ],
  );
}

/** Exact v25 prompt used only to verify and deterministically repair a source-identical artifact. */
export function buildCompatibleV25ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short strings each for manufacturers and model_numbers, and at most eight short strings per other array.",
    [
      "Treat a box, case, pack, carton, crate, bag, bin, pallet, or bundle clearly containing multiple units as a lot even when the exact inner count is missing or approximate. Packaging alone does not establish a lot; one item in its original, carrying, shipping, or storage packaging remains single_item.",
      "A standalone BUNDLE marker in the source title establishes that the source is selling a grouped lot even when no exact inner count is stated. Preserve that grouping in lot_type, but do not emit synthetic metadata such as 'Source grouping: bundle' as an included sale item.",
    ],
    CURRENT_PRESENTATION_EXAMPLE,
    [
      "For model_numbers, return the longest independently expressed source value for each model, catalog, part, or reference identifier. Do not also return word or number fragments that occur only inside a longer returned value, generic product classes, packaging/quantity strings, or a combined slash form when its separately supported component codes are retained. Preserve a shorter overlapping value only when the source independently states it in another title token, labeled field, or delimited code.",
      "Retain an exact short alphanumeric value when it is explicitly labeled as a model, such as Model: 3V. Exclude generic product-class suffixes such as PC Monitor, Delivery System, Temperature Management System, Information Management System, Fluid Management System, or Laser Control System from the model value.",
      "Use the most specific source-supported equipment type in asset_classes, such as defibrillator, centrifuge, slide stainer, microscope, television, treadmill, MRI coil, or adapter cable. Do not stop at a generic class such as medical equipment when the title names the equipment type.",
      "Do not treat a product family such as Dash in Dash 4000 as a manufacturer unless the source explicitly identifies it as a make, brand, or manufacturer. Collapse obvious spelling variants of the same manufacturer instead of returning duplicates.",
      "Never add a leading quantity of 1 to included_items unless that exact count is present in the source text or title.",
      "short_summary must agree with lot_type and industry_domain. Do not call a grouped sale one or a single item, and do not claim a domain that the source does not support. included_items must contain only source-listed sale contents, never synthetic metadata such as a Source grouping entry.",
      "short_summary is a concise restatement, not independent evidence. Base lot_type, industry_domain, asset_classes, and every other fact on the source title and item text so validating the structured result again cannot change it.",
      "When the title states an aggregate Lot of N or Qty N but does not allocate that total among named types, preserve the source total as an included_items entry instead of silently dropping it or inventing per-type quantities.",
      "Words such as assorted, mixed, and miscellaneous establish that a sale is a lot but do not determine its subtype. Multiple units of one general primary type remain multi_item_lot across brand or model variations; use assorted_lot only when the primary item types differ. An explicit plural primary-equipment noun such as laptops, monitors, switches, printers, projectors, carts, or washers establishes multiple sale items even when the exact count is unstated.",
    ],
  );
}

/** Exact v24 prompt used only to verify and deterministically repair a source-identical artifact. */
export function buildCompatibleV24ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short strings each for manufacturers and model_numbers, and at most eight short strings per other array.",
    [
      "Treat a box, case, pack, carton, crate, bag, bin, pallet, or bundle clearly containing multiple units as a lot even when the exact inner count is missing or approximate. Packaging alone does not establish a lot; one item in its original, carrying, shipping, or storage packaging remains single_item.",
      "A standalone BUNDLE marker in the source title establishes that the source is selling a grouped lot even when no exact inner count is stated. Preserve that grouping in lot_type, but do not emit synthetic metadata such as 'Source grouping: bundle' as an included sale item.",
    ],
    CURRENT_PRESENTATION_EXAMPLE,
    [
      "For model_numbers, return the longest independently expressed source value for each model, catalog, part, or reference identifier. Do not also return word or number fragments that occur only inside a longer returned value, generic product classes, packaging/quantity strings, or a combined slash form when its separately supported component codes are retained. Preserve a shorter overlapping value only when the source independently states it in another title token, labeled field, or delimited code.",
      "Retain an exact short alphanumeric value when it is explicitly labeled as a model, such as Model: 3V. Exclude generic product-class suffixes such as PC Monitor, Delivery System, Temperature Management System, Information Management System, Fluid Management System, or Laser Control System from the model value.",
      "Use the most specific source-supported equipment type in asset_classes, such as defibrillator, centrifuge, slide stainer, microscope, television, treadmill, MRI coil, or adapter cable. Do not stop at a generic class such as medical equipment when the title names the equipment type.",
      "Do not treat a product family such as Dash in Dash 4000 as a manufacturer unless the source explicitly identifies it as a make, brand, or manufacturer. Collapse obvious spelling variants of the same manufacturer instead of returning duplicates.",
      "Never add a leading quantity of 1 to included_items unless that exact count is present in the source text or title.",
      "short_summary must agree with lot_type and industry_domain. Do not call a grouped sale one or a single item, and do not claim a domain that the source does not support. included_items must contain only source-listed sale contents, never synthetic metadata such as a Source grouping entry.",
      "short_summary is a concise restatement, not independent evidence. Base lot_type, industry_domain, asset_classes, and every other fact on the source title and item text so validating the structured result again cannot change it.",
      "When the title states an aggregate Lot of N or Qty N but does not allocate that total among named types, preserve the source total as an included_items entry instead of silently dropping it or inventing per-type quantities.",
      "Words such as assorted, mixed, and miscellaneous establish that a sale is a lot but do not determine its subtype. Multiple units of one general primary type remain multi_item_lot across brand or model variations; use assorted_lot only when the primary item types differ. An explicit plural primary-equipment noun such as laptops, monitors, switches, printers, projectors, carts, or washers establishes multiple sale items even when the exact count is unstated.",
    ],
  );
}

/** Exact v23 prompt used only to verify and deterministically repair a source-identical artifact. */
export function buildCompatibleV23ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short strings each for manufacturers and model_numbers, and at most eight short strings per other array.",
    [
      "Treat a box, case, pack, carton, crate, bag, bin, pallet, or bundle clearly containing multiple units as a lot even when the exact inner count is missing or approximate. Packaging alone does not establish a lot; one item in its original, carrying, shipping, or storage packaging remains single_item.",
      "A standalone BUNDLE marker in the source title establishes that the source is selling a grouped lot even when no exact inner count is stated. Preserve that grouping in lot_type, but do not emit synthetic metadata such as 'Source grouping: bundle' as an included sale item.",
    ],
    CURRENT_PRESENTATION_EXAMPLE,
    [
      "For model_numbers, return the longest independently expressed source value for each model, catalog, part, or reference identifier. Do not also return word or number fragments that occur only inside a longer returned value, generic product classes, packaging/quantity strings, or a combined slash form when its separately supported component codes are retained. Preserve a shorter overlapping value only when the source independently states it in another title token, labeled field, or delimited code.",
      "Retain an exact short alphanumeric value when it is explicitly labeled as a model, such as Model: 3V. Exclude generic product-class suffixes such as PC Monitor, Delivery System, Temperature Management System, Information Management System, Fluid Management System, or Laser Control System from the model value.",
      "Use the most specific source-supported equipment type in asset_classes, such as defibrillator, centrifuge, slide stainer, microscope, television, treadmill, MRI coil, or adapter cable. Do not stop at a generic class such as medical equipment when the title names the equipment type.",
      "Do not treat a product family such as Dash in Dash 4000 as a manufacturer unless the source explicitly identifies it as a make, brand, or manufacturer. Collapse obvious spelling variants of the same manufacturer instead of returning duplicates.",
      "Never add a leading quantity of 1 to included_items unless that exact count is present in the source text or title.",
      "short_summary must agree with lot_type and industry_domain. Do not call a grouped sale one or a single item, and do not claim a domain that the source does not support. included_items must contain only source-listed sale contents, never synthetic metadata such as a Source grouping entry.",
      "When the title states an aggregate Lot of N or Qty N but does not allocate that total among named types, preserve the source total as an included_items entry instead of silently dropping it or inventing per-type quantities.",
      "Words such as assorted, mixed, and miscellaneous establish that a sale is a lot but do not determine its subtype. Multiple units of one general primary type remain multi_item_lot across brand or model variations; use assorted_lot only when the primary item types differ. An explicit plural primary-equipment noun such as laptops, monitors, switches, printers, projectors, carts, or washers establishes multiple sale items even when the exact count is unstated.",
    ],
  );
}

/** Exact v22 prompt used only to verify and deterministically repair a source-identical artifact. */
export function buildCompatibleV22ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short strings each for manufacturers and model_numbers, and at most eight short strings per other array.",
    [
      "Treat a box, case, pack, carton, crate, bag, bin, pallet, or bundle clearly containing multiple units as a lot even when the exact inner count is missing or approximate. Packaging alone does not establish a lot; one item in its original, carrying, shipping, or storage packaging remains single_item.",
      "A standalone BUNDLE marker in the source title establishes that the source is selling a grouped lot even when no exact inner count is stated. Preserve that grouping in lot_type, but do not emit synthetic metadata such as 'Source grouping: bundle' as an included sale item.",
    ],
    CURRENT_PRESENTATION_EXAMPLE,
    [
      "For model_numbers, return the longest independently expressed source value for each model, catalog, part, or reference identifier. Do not also return word or number fragments that occur only inside a longer returned value, generic product classes, packaging/quantity strings, or a combined slash form when its separately supported component codes are retained. Preserve a shorter overlapping value only when the source independently states it in another title token, labeled field, or delimited code.",
      "Retain an exact short alphanumeric value when it is explicitly labeled as a model, such as Model: 3V. Exclude generic product-class suffixes such as PC Monitor, Delivery System, Temperature Management System, Information Management System, Fluid Management System, or Laser Control System from the model value.",
      "Use the most specific source-supported equipment type in asset_classes, such as defibrillator, centrifuge, slide stainer, microscope, television, treadmill, MRI coil, or adapter cable. Do not stop at a generic class such as medical equipment when the title names the equipment type.",
      "Do not treat a product family such as Dash in Dash 4000 as a manufacturer unless the source explicitly identifies it as a make, brand, or manufacturer. Collapse obvious spelling variants of the same manufacturer instead of returning duplicates.",
      "Never add a leading quantity of 1 to included_items unless that exact count is present in the source text or title.",
      "When the title states an aggregate Lot of N or Qty N but does not allocate that total among named types, preserve the source total as an included_items entry instead of silently dropping it or inventing per-type quantities.",
      "Words such as assorted, mixed, and miscellaneous establish that a sale is a lot but do not determine its subtype. Multiple units of one general primary type remain multi_item_lot across brand or model variations; use assorted_lot only when the primary item types differ. An explicit plural primary-equipment noun such as laptops, monitors, switches, printers, projectors, carts, or washers establishes multiple sale items even when the exact count is unstated.",
    ],
  );
}

/** Exact v21 prompt used only to verify and deterministically repair a source-identical artifact. */
export function buildCompatibleV21ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short strings each for manufacturers and model_numbers, and at most eight short strings per other array.",
    [
      "Treat a box, case, pack, carton, crate, bag, bin, pallet, or bundle clearly containing multiple units as a lot even when the exact inner count is missing or approximate. Packaging alone does not establish a lot; one item in its original, carrying, shipping, or storage packaging remains single_item.",
    ],
    CURRENT_PRESENTATION_EXAMPLE,
    [
      "For model_numbers, return the longest independently expressed source value for each model, catalog, part, or reference identifier. Do not also return word or number fragments that occur only inside a longer returned value, generic product classes, packaging/quantity strings, or a combined slash form when its separately supported component codes are retained. Preserve a shorter overlapping value only when the source independently states it in another title token, labeled field, or delimited code.",
      "When the title states an aggregate Lot of N or Qty N but does not allocate that total among named types, preserve the source total as an included_items entry instead of silently dropping it or inventing per-type quantities.",
      "Words such as assorted, mixed, and miscellaneous establish that a sale is a lot but do not determine its subtype. Multiple units of one general primary type remain multi_item_lot across brand or model variations; use assorted_lot only when the primary item types differ. An explicit plural primary-equipment noun such as laptops, monitors, switches, printers, projectors, carts, or washers establishes multiple sale items even when the exact count is unstated.",
    ],
  );
}

/** Exact v20 prompt used only to verify a source-identical repair input. */
export function buildCompatibleV20ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short strings each for manufacturers and model_numbers, and at most eight short strings per other array.",
    [
      "Treat a box, case, pack, carton, crate, bag, bin, pallet, or bundle clearly containing multiple units as a lot even when the exact inner count is missing or approximate. Packaging alone does not establish a lot; one item in its original, carrying, shipping, or storage packaging remains single_item.",
    ],
    CURRENT_PRESENTATION_EXAMPLE,
  );
}

/** Exact v19 prompt used only to verify a source-identical repair input. */
export function buildCompatibleV19ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short strings each for manufacturers and model_numbers, and at most eight short strings per other array.",
    [
      "Treat a box, case, pack, carton, crate, bag, bin, pallet, or bundle clearly containing multiple units as a lot even when the exact inner count is missing or approximate. Packaging alone does not establish a lot; one item in its original, carrying, shipping, or storage packaging remains single_item.",
    ],
  );
}

/** Exact v18 prompt used only to verify a source-identical repair input. */
export function buildCompatibleV18ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short strings each for manufacturers and model_numbers, and at most eight short strings per other array.",
  );
}

/** Exact v12 prompt used only to verify a source-identical repair input. */
export function buildCompatibleV12ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences, at most 24 short model_numbers strings, and at most eight short strings per other array.",
  );
}

/** Exact legacy prompt used only to verify a source-identical v11 repair input. */
export function buildLegacyV11ExtractionPrompt(listing: ListingTextForEnrichment): string {
  return buildVersionedExtractionPrompt(
    listing,
    "Be concise: use at most two short summary sentences and at most eight short strings per array.",
  );
}

function buildVersionedExtractionPrompt(
  listing: ListingTextForEnrichment,
  brevityInstruction: string,
  additionalLotInstructions: readonly string[] = [],
  presentationExample = V19_PRESENTATION_EXAMPLE,
  additionalFactInstructions: readonly string[] = [],
): string {
  return [
    "You extract structured facts from public surplus-auction listing text.",
    "Use only the text and metadata below. Images are unavailable and must never be inferred from.",
    "Do not invent exact values. Return unknown or null when the text is insufficient.",
    "Extract every source-supported manufacturer/brand and every model, catalog, part, or reference identifier. model_numbers must retain each explicit code (for example Ref 950004 or 0570-0394) even when a product model name is also present. Use manufacturer only when exactly one manufacturer applies; otherwise use null. Put every explicit manufacturer/brand in manufacturers in source order. Do not mistake seller names, inventory IDs, serial numbers, dates, quantities, or source listing IDs for manufacturers or models.",
    ...additionalFactInstructions,
    "Choose industry_domain from the item facts and asset classes. Do not return unknown when a supported domain such as medical, laboratory, industrial, electronics, AV, tools, or other is clear.",
    "Condition and functional status require direct source evidence. Expiration dates, packaging, sterile labeling, 'condition unknown', or 'not for clinical use' do not by themselves mean new, used, damaged, nonfunctional, or untested. Use new only for explicit new/unused/unopened evidence and used only for explicit used/pre-owned/service/wear evidence; ordinary prose such as 'used to' or 'used for' is not condition evidence.",
    "Use tested_working only when the source explicitly reports a successful functional test or unqualified working/operational result. 'Working condition unknown', 'UKNOWN if items are in working condition', 'appears to be working', and a bare 'Tested.' are unknown. 'TESTED - GOOD' is tested_working. A power-on-only check is powers_on, not tested_working. A missing power cord, cable, adapter, or supply does not mean not_working. Use not_working only for an explicit failure/nonfunctional/no-power result. Otherwise use unknown unless the source explicitly says untested.",
    "Pickup evidence from removal or inspection text is only location evidence, not item-description evidence.",
    "Price, closing time, seller, URLs, and source identifiers are deterministic fields outside this task.",
    "Classify lot_type by the complete sale grouping. A lot is a sale containing multiple distinct pieces/items, including collections made only of parts, accessories, supplies, or consumables.",
    "Use multi_item_lot for multiple items of the same general type. Use assorted_lot for mixed or miscellaneous items spanning types.",
    "Explicit grouping language in the title or item text is meaningful evidence: lot in the source title, pallet of, mixed, miscellaneous/misc, collection of, assortment/assorted, group of, and set of indicate a lot unless the text clearly describes one indivisible item. Do not treat the ordinary word lot in a sentence such as 'this lot consists of one forklift' as grouping evidence.",
    "Plural parts, accessories, supplies, or components presented as the sale itself are a lot. Examples include a pallet of vehicle parts, misc vehicle parts, mixed medical supply lot, military vehicle accessories, and a collection of tools or supplies.",
    ...additionalLotInstructions,
    "Use single_item for one main machine, instrument, vehicle, or other item merely bundled with its supporting parts, accessories, or functional subsystems. Attached, installed, onboard, or included support content for one main item does not create a lot.",
    "Use unknown only when the text does not establish whether the sale is one item or a grouping.",
    "Examples: 3 centrifuges = multi_item_lot; 2 centrifuges plus a vital signs monitor = assorted_lot; 1 centrifuge plus rotors, spare parts, or accessories = single_item.",
    presentationExample,
    "Complete-system examples: 1 bladder scanner with its battery charger = single_item; 1 tripod dolly with its handle and carrying case = single_item; 1 SpeedVac with its refrigerated vapor trap = single_item. Multiple chargers, cases, or vapor traps sold as the contents remain a lot.",
    "For consumables or medical supplies, an explicit plural 'Exp Dates' field containing two or more distinct dates is evidence that multiple physical units or batches are being sold and should be a lot; one expiration date alone is not.",
    "An attachment counts only when the listing presents it as an independently itemized main sale asset, as in the dozer-blade and grapple example. Attached, installed, onboard, or supporting content for one main item remains subordinate.",
    "For included_items, preserve explicit quantities and grouping words such as pallet, collection, mixed, misc, and assorted. Use separate entries per type/model when the text supplies them; do not collapse known multiples into an unquantified singular. If the source names more than eight distinct types, retain up to seven specific entries and use the eighth entry to aggregate every remaining named type rather than silently dropping them.",
    "The lot_type must agree with the title, summary, and included_items in both directions: explicit collection language or multiple sold pieces must be a lot, while one main item with only its supporting content must be single_item.",
    brevityInstruction,
    "Return only JSON matching the supplied schema.",
    "",
    `Source: ${listing.source}`,
    `Source listing ID: ${listing.sourceListingId}`,
    `Title: ${listing.title}`,
    `Category: ${listing.category ?? "unknown"}`,
    `Seller: ${listing.seller ?? "unknown"}`,
    `Pickup location text: ${listing.pickupLocationText ?? "unknown"}`,
    "",
    "ITEM DESCRIPTION:",
    listing.cleanDescription,
    "",
    "LOCATION-ONLY REMOVAL / INSPECTION TEXT:",
    listing.removalText ?? "none",
  ].join("\n");
}

export function buildSemanticDocument(
  listing: ListingTextForEnrichment,
  extraction: {
    short_summary: string;
    asset_classes: string[];
    industry_domain: string;
    manufacturer: string | null;
    manufacturers: string[];
    model_numbers: string[];
    lot_type: string;
    included_items: string[];
    condition: string;
    tested_status: string;
    high_value_signals: string[];
    negative_signals: string[];
  },
): string {
  // Price and logistics intentionally stay out of the semantic document so
  // they cannot dominate preference learning.
  return [
    `Title: ${listing.title}`,
    `Summary: ${extraction.short_summary}`,
    `Description: ${listing.cleanDescription}`,
    `Domain: ${extraction.industry_domain}`,
    `Asset classes: ${extraction.asset_classes.join(", ") || "unknown"}`,
    `Manufacturers: ${extraction.manufacturers.join(", ") || extraction.manufacturer || "unknown"}`,
    `Models: ${extraction.model_numbers.join(", ") || "unknown"}`,
    `Lot type: ${extraction.lot_type}`,
    `Included items: ${extraction.included_items.join(", ") || "unknown"}`,
    `Condition: ${extraction.condition}`,
    `Tested status: ${extraction.tested_status}`,
    `Value signals: ${extraction.high_value_signals.join(", ") || "none"}`,
    `Negative signals: ${extraction.negative_signals.join(", ") || "none"}`,
  ].join("\n");
}
