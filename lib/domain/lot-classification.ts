export type ExtractedLotType =
  | "single_item"
  | "multi_item_lot"
  | "assorted_lot"
  | "unknown";

const SUBORDINATE_CONTENT_PATTERNS = [
  /\b(?:parts?|accessor(?:y|ies)|attachments?|consumables?|suppl(?:y|ies)|spares?)\b/u,
  /\bcomponents\b/u,
  /\b(?:rotors?|cannulas?|tubes?|forceps|vials?)\b/u,
  /\b(?:microscope )?(?:eyepieces?|objective lenses?|objectives?)\b/u,
  /\b(?:test strips?|alcohol prep pads?|hand wipes?)\b/u,
  /\b(?:power )?(?:cords?|cables?)\b/u,
  /\b(?:battery )?chargers?\b/u,
  /\b(?:batter(?:y|ies)|docks?|docking stations?|handles?|stands?)\b/u,
  /\b(?:carrying |protective |storage )?cases?\b/u,
  /\b(?:camera |camcorder |carrying |protective |storage )?bags?\b/u,
  /\b(?:refrigerated )?vapor traps?\b/u,
  /\b(?:manuals?|original (?:packaging|box(?:es)?)|mounts?|brackets?|adapters?|remotes?)\b/u,
  /\b(?:attached|keys?|onboard equipment)\b/u,
  /\b(?:winch(?:es)?|toolbox(?:es)?|tool boxes?|tires?|canop(?:y|ies)|controls?|software|bolts?)\b/u,
  /\b(?:window support frames?|front bumpers?|seat kits?|deflectors?)\b/u,
  /\b(?:cargo bed covers?|shower stall bases?)\b/u,
] as const;

const PRIMARY_ITEM_TYPE_PATTERNS = [
  { type: "docking-station", pattern: /\bdocking stations?\b/u, requiresIndependentQuantity: true },
  { type: "charger", pattern: /\bchargers?\b/u, requiresIndependentQuantity: true },
  { type: "shower-system", pattern: /\bshower systems?\b/u },
  { type: "shower-stall-base", pattern: /\bshower stall bases?\b/u },
  { type: "maintenance-platform", pattern: /\b(?:maintenance platforms?|(?:portable\s+)?maintenance stands?)\b/u },
  { type: "reload", pattern: /\b(?:linear cutter |stapler )?reloads?\b/u },
  { type: "sealer-divider", pattern: /\bsealers?\s*\/\s*dividers?\b/u },
  { type: "fixation-device", pattern: /\bfixation devices?\b/u },
  { type: "clip-applier", pattern: /\bclip appliers?\b/u },
  { type: "monitor", pattern: /\b(?:computer )?monitors?\b/u },
  { type: "thin-client", pattern: /\bthin clients?\b/u },
  { type: "barcode-scanner", pattern: /\bbarcode scanners?\b/u },
  { type: "network-switch", pattern: /\b(?:network )?(?:switches?|omniswitches?)\b/u },
  { type: "printer", pattern: /\bprinters?\b/u },
  { type: "projector", pattern: /\bprojectors?\b/u },
  { type: "stand", pattern: /\bstands?\b/u },
  { type: "ups", pattern: /\bups(?:\s+units?)?\b/u },
  { type: "sterilization-tray", pattern: /\b(?:sterilization )?trays?\b/u },
  { type: "iv-pole", pattern: /\biv\s+poles?\b/u },
  { type: "cart", pattern: /\b(?:medical )?carts?\b/u },
  { type: "computer", pattern: /\b(?:all[ -]in[ -]one|aio|desktops?|mini desktops?|optiplex)\b|\bcomputers?\b/u },
  { type: "laptop", pattern: /\b(?:laptops?|thinkpads?)\b/u },
  { type: "camcorder", pattern: /\bcamcorders?\b/u },
  { type: "walkie-talkie", pattern: /\bwalkie[ -]talk(?:ie|ies)(?:\s+devices?)?\b/u },
  { type: "belt-pouch", pattern: /\bbelt\s+pouches?\b/u },
  { type: "scrap-metal", pattern: /\bscrap\s+metal\b/u },
  { type: "washer-disinfector", pattern: /\b(?:medical )?washers?(?:\s*[-/]\s*d[ei]sinfectors?)?\b/u },
] as const;

const EXPLICIT_PRIMARY_PLURAL_PATTERN = /\b(?:belt\s+pouches|camcorders|carts|centrifuges|clip\s+appliers|computers|desktops|fixation\s+devices|forklifts|generators|iv\s+poles|laptop\s+computers|laptops|linear\s+cutter\s+reloads|maintenance\s+platforms|maintenance\s+stands|medical\s+mobile\s+stands|medical\s+washers|microscopes|monitors|network\s+switches|office\s+chairs|omniswitches|printers|projectors|refrigerators|reloads|scanners|sealers\s*\/\s*dividers|servers|shower\s+stall\s+bases|shower\s+systems|sterilization\s+trays|switches|televisions|thinkpads|tvs|ups\s+units|vehicles|walkie[ -]talkies|water\s+baths)\b/u;

const NUMBER_WORD_PATTERN = "one|two|three|four|five|six|seven|eight|nine|ten";
const SPECIFICATION_NOUN_PATTERN =
  "channel|channels|door|doors|gallon|gallons|hp|inch|inches|lead|leads|liter|liters|phase|phases|ton|tons|volt|volts|watt|watts";

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

export interface LotClassificationContext {
  title?: string | null;
  shortSummary?: string | null;
  sourceText?: string | null;
}

export interface DisplayLotClassificationContext extends LotClassificationContext {
  /** Clean source item text; acquisition/removal boilerplate should already be absent. */
  sourceText?: string | null;
}

/**
 * Applies source-neutral, high-confidence sale-grouping evidence shared by
 * extraction validation and dashboard mapping. Persisted artifacts only gain
 * new behavior under an explicitly versioned extraction contract.
 */
export function deriveDisplayLotType(
  automaticType: ExtractedLotType,
  includedItems: readonly string[],
  context: DisplayLotClassificationContext = {},
): ExtractedLotType {
  if (isExplicitSingularAnalyzerSystem(context, includedItems)) {
    return "single_item";
  }
  if (isExplicitSingularOpticalSystem(context, includedItems)) {
    return "single_item";
  }
  const normalizedAutomatic = enforceWholePrimaryEquipmentLotThreshold(
    automaticType,
    includedItems,
    context,
  );
  const explicitPrimaryPlural = explicitPrimaryPluralEvidence(context, includedItems);
  const deterministicSubtype = deterministicPrimaryItemSubtype(includedItems, context);
  if (
    deterministicSubtype && (
      normalizedAutomatic === "multi_item_lot" ||
      normalizedAutomatic === "assorted_lot" ||
      explicitPrimaryPlural
    )
  ) return deterministicSubtype;
  if (
    normalizedAutomatic === "assorted_lot" &&
    repeatedSamePrimaryItemIdentity(includedItems)
  ) return "multi_item_lot";
  if (
    normalizedAutomatic === "assorted_lot" &&
    vagueAssortmentWithoutDistinctTypes(includedItems, context)
  ) return "multi_item_lot";
  if (normalizedAutomatic === "multi_item_lot" || normalizedAutomatic === "assorted_lot") {
    return normalizedAutomatic;
  }

  const title = normalizeLotEvidence(context.title);
  const sourceText = normalizeLotEvidence(context.sourceText);
  const itemsText = normalizeLotEvidence(includedItems.join("\n"));
  // Normalized summaries are display output, not independent source evidence.
  // Excluding them keeps validation a fixed point when a contradictory summary
  // is repaired after lot classification.
  const allEvidence = `${title}\n${sourceText}\n${itemsText}`;

  if (explicitAssortedSale(title, allEvidence)) {
    return vagueAssortmentWithoutDistinctTypes(includedItems, context)
      ? "multi_item_lot"
      : "assorted_lot";
  }
  if (
    explicitTitleGrouping(title)
    || explicitBundleGrouping(allEvidence)
    || explicitContainerGrouping(allEvidence)
    || approximateCollectionCount(allEvidence)
    || explicitParentheticalCount(context, includedItems)
    || explicitPrimaryPlural
    || minimumSaleItemQuantity(title) >= 2
    || repeatedCountedSourceLines(sourceText) >= 2
  ) {
    return "multi_item_lot";
  }
  return normalizedAutomatic;
}

function explicitPrimaryPluralEvidence(
  context: LotClassificationContext,
  includedItems: readonly string[],
): boolean {
  if (explicitSinglePrimarySale(context, includedItems)) return false;
  const entries = [
    context.title ?? "",
    ...includedItems,
  ];
  for (const entry of entries) {
    const normalized = normalizeLotEvidence(entry);
    if (
      !normalized
      || isSyntheticGroupingEvidence(normalized)
      || /^(?:brand|category|condition|make|manufacturer|model|serial|vin)\s*[:#-]/u.test(normalized)
    ) continue;
    const clause = primaryItemClause(normalized);
    if (
      !clause ||
      (!EXPLICIT_PRIMARY_PLURAL_PATTERN.test(clause) && !hasGeneralPrimaryPlural(clause))
    ) continue;
    if (
      isClearlySubordinateContent(clause) &&
      !/\b(?:maintenance|medical mobile)\s+stands\b/u.test(clause)
    ) continue;
    return true;
  }
  return false;
}

function explicitSinglePrimarySale(
  context: LotClassificationContext,
  includedItems: readonly string[],
): boolean {
  const primaryItems = includedItems.filter((item) => {
    const clause = primaryItemClause(normalizeLotEvidence(item));
    return clause && !isSyntheticGroupingEvidence(clause) && !isClearlySubordinateContent(clause);
  });
  if (primaryItems.length !== 1) return false;
  const item = normalizeLotEvidence(primaryItems[0]);
  const explicitItemOne = /^\s*(?:qty|quantity)\s*[:#-]?\s*1\b|^\s*~?\(?\s*1\s*\)?\s*(?:x|ea\.?|each|unit)\b/u.test(item);
  const source = normalizeLotEvidence(context.sourceText);
  const explicitSourceOne = /\(\s*1\s*(?:ea\.?|each|x|unit)?\s*\)/u.test(source) ||
    /\b(?:qty|quantity)\s*[:#-]?\s*1\b/u.test(source);
  return explicitItemOne || explicitSourceOne;
}

function hasGeneralPrimaryPlural(value: string): boolean {
  const nounPhrase = value
    .replace(/\([^)]*\)/gu, " ")
    .replace(/\b(?:asset|inventory|lot|serial|vin)\s*[:#=-].*$/u, " ")
    .replace(/\bmodel(?:\s*(?:no\.?|number))?\s*[:#=-]?\s+[a-z0-9][a-z0-9._/-]*.*$/u, " ");
  const words = nounPhrase.match(/[\p{L}][\p{L}-]*/gu) ?? [];
  const candidate = words.at(-1);
  if (!candidate) return false;
  if (
    candidate.length < 3 ||
    /^(?:assorted|auction|equipment|lot|miscellaneous|mounted|sale|trailer|various)$/u.test(candidate)
  ) return false;
  if (/^(?:analysis|apparatus|basis|business|chassis|class|conditions?|days?|doors?|gallons?|gas|glass|hours?|inches?|leads?|lens|liters?|miles?|months?|news|phases?|results?|series|sizes?|status|tons?|volts?|watts?|weeks?|years?)$/u.test(candidate)) {
    return false;
  }
  return /(?:ies|ses|xes|zes|ches|shes|s)$/u.test(candidate) && !/(?:ss|us)$/u.test(candidate);
}

function deterministicPrimaryItemSubtype(
  includedItems: readonly string[],
  context: DisplayLotClassificationContext,
): "multi_item_lot" | "assorted_lot" | null {
  const types: string[] = [];
  const explicitAssortedContext = /\b(?:assorted|assortment|mixed|misc(?:ellaneous)?)\b/u.test(
    normalizeLotEvidence(`${context.title ?? ""}\n${includedItems.join("\n")}`),
  );
  for (const item of includedItems) {
    const normalized = normalizeLotEvidence(item);
    if (
      !normalized ||
      /^source grouping\b/u.test(normalized) ||
      /^(?:lot of|quantity)\s+\d+\s+total items\b/u.test(normalized)
    ) continue;
    let matches = PRIMARY_ITEM_TYPE_PATTERNS.filter(({ pattern }) => pattern.test(normalized));
    if (
      /\blaptop computers?\b/u.test(normalized) &&
      !/\b(?:all[ -]in[ -]one|aio|desktops?|mini desktops?|optiplex)\b/u.test(normalized)
    ) {
      matches = matches.filter(({ type }) => type !== "computer");
    }
    // "Computer monitor" is one equipment type. Incidental punctuation in a
    // condition note must not make the overlapping words computer + monitor
    // look like two independently listed primary types.
    if (/\bcomputer monitors?\b/u.test(normalized)) {
      matches = matches.filter(({ type }) => type !== "computer");
    }
    const parallelPrimaryTypes = (
      explicitAssortedContext || /\bindependently sold\b/u.test(normalized)
    ) && /(?:\band\b|&|,|\+)/u.test(normalized) && matches.length >= 2;
    const acceptedMatches = parallelPrimaryTypes ? matches : matches.slice(0, 1);
    const acceptedTypes = acceptedMatches.filter((match) =>
      !("requiresIndependentQuantity" in match) || minimumSaleItemQuantity(normalized) >= 2
    );
    if (acceptedTypes.length > 0) {
      types.push(...acceptedTypes.map((match) => match.type));
      continue;
    }
    if (!isClearlySubordinateContent(primaryItemClause(normalized))) return null;
  }
  if (types.length === 0) return null;
  return new Set(types).size === 1 ? "multi_item_lot" : "assorted_lot";
}

function vagueAssortmentWithoutDistinctTypes(
  includedItems: readonly string[],
  context: DisplayLotClassificationContext,
): boolean {
  const evidence = normalizeLotEvidence(
    `${context.title ?? ""}\n${includedItems.join("\n")}`,
  );
  if (!/\b(?:assorted|assortment|mixed|misc(?:ellaneous)?)\b/u.test(evidence)) {
    return false;
  }
  const primaryItems = includedItems.filter((item) => {
    const clause = primaryItemClause(normalizeLotEvidence(item));
    return clause &&
      !isSyntheticGroupingEvidence(clause) &&
      !isClearlySubordinateContent(clause);
  });
  return primaryItems.length <= 1;
}

function repeatedSamePrimaryItemIdentity(includedItems: readonly string[]): boolean {
  const identities = includedItems
    .map((item) => item
      .toLocaleLowerCase()
      .replace(/^\s*~?\(?\s*\d+\s*\)?\s*(?:x\b|ea\b|each\b|units?\b)?\s*/u, "")
      .replace(/\(\s*lot(?:\s*#|\s*no\.?)?[^)]*\)\s*$/u, "")
      .replace(/\b(?:lot(?:\s*#|\s*no\.?)?|id)\s*[:#-]?\s*[a-z0-9-]+\b/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim())
    .filter((identity) => identity && !/^source grouping\b/u.test(identity));
  return identities.length >= 2 && new Set(identities).size === 1;
}

/**
 * Returns a conservative lower bound, capped at two because lot eligibility
 * needs only the threshold. Entries that clearly name subordinate contents do
 * not count. A primary item followed by a `with`/`including` accessory clause
 * keeps the primary prefix so two whole units are not discarded.
 */
export function minimumWholePrimaryEquipmentCount(
  includedItems: readonly string[],
): 0 | 1 | 2 {
  let count = 0;
  for (const item of includedItems) {
    const primaryClause = primaryItemClause(item);
    if (
      !primaryClause ||
      isSyntheticGroupingEvidence(primaryClause) ||
      isClearlySubordinateContent(primaryClause)
    ) continue;
    count += minimumSaleItemQuantity(primaryClause);
    if (count >= 2) return 2;
  }
  return count === 1 ? 1 : 0;
}

/**
 * The normalized lot label follows the included-item evidence in both
 * directions. Multiple whole primary items remain lots. A sale made up only of
 * multiple parts, accessories, supplies, or other pieces is also a lot, as are
 * titles/summaries that explicitly describe a lot, pallet, mixed/misc group, or
 * collection. One main item merely bundled with its supporting content remains
 * a single item.
 */
export function enforceWholePrimaryEquipmentLotThreshold(
  lotType: ExtractedLotType,
  includedItems: readonly string[],
  context: LotClassificationContext = {},
): ExtractedLotType {
  if (isExplicitSingularAnalyzerSystem(context, includedItems)) {
    return "single_item";
  }
  if (isExplicitSingularOpticalSystem(context, includedItems)) {
    return "single_item";
  }
  if (explicitInteractivePresentationSystem(context, includedItems)) {
    return "single_item";
  }
  if (explicitCoordinatedMonitorStandSale(context.title, includedItems)) {
    return "multi_item_lot";
  }
  if (pluralExpirationLotEvidence(context, includedItems)) {
    return "multi_item_lot";
  }
  const minimumCount = minimumWholePrimaryEquipmentCount(includedItems);
  if (
    minimumCount === 0 &&
    explicitSubordinatePluralSale(context, includedItems)
  ) {
    return lotType === "assorted_lot" ? "assorted_lot" : "multi_item_lot";
  }
  const explicitCollection = explicitCollectionKind(
    context,
    includedItems,
    minimumCount > 0,
  );
  if (explicitCollection) {
    if (lotType === "multi_item_lot" || lotType === "assorted_lot") return lotType;
    return explicitCollection === "assorted" ? "assorted_lot" : "multi_item_lot";
  }
  if (minimumCount >= 2) {
    return lotType === "multi_item_lot" || lotType === "assorted_lot"
      ? lotType
      : "multi_item_lot";
  }
  if (minimumCount === 0 && minimumSubordinateCollectionCount(includedItems) >= 2) {
    if (lotType === "multi_item_lot" || lotType === "assorted_lot") return lotType;
    return includedItems.length > 1 ? "assorted_lot" : "multi_item_lot";
  }
  if (lotType !== "multi_item_lot" && lotType !== "assorted_lot") {
    return lotType;
  }
  return includedItems.length === 0 ? "unknown" : "single_item";
}

export function isExplicitSingularAnalyzerSystem(
  context: LotClassificationContext,
  includedItems: readonly string[],
): boolean {
  const title = normalizeLotEvidence(context.title);
  if (
    !/\banaly[sz]er\b/u.test(title) ||
    /\banaly[sz]ers\b/u.test(title) ||
    explicitTitleGrouping(title) ||
    minimumSaleItemQuantity(title) >= 2
  ) {
    return false;
  }
  const sourceLines = (context.sourceText ?? "").split(/\r?\n/gu);
  if (!sourceLines.some((line) => /^\s*includes?\s*:?\s*$/iu.test(line))) {
    return false;
  }
  const sourceText = normalizeLotEvidence(context.sourceText);
  if (
    /\banaly[sz]ers\b/u.test(sourceText) ||
    new RegExp(
      `\\b(?:\\d+|${NUMBER_WORD_PATTERN}|multiple|several)\\s+analy[sz]ers\\b`,
      "u",
    ).test(sourceText)
  ) {
    return false;
  }
  const includedAnalyzers = includedItems.filter((item) =>
    /\banaly[sz]er\b/u.test(primaryItemClause(normalizeLotEvidence(item)))
  );
  return includedAnalyzers.length <= 1 &&
    includedAnalyzers.every((item) =>
      minimumSaleItemQuantity(item) < 2 &&
      !/\banaly[sz]ers\b/u.test(normalizeLotEvidence(item))
    );
}

export function isExplicitSingularOpticalSystem(
  context: LotClassificationContext,
  includedItems: readonly string[],
): boolean {
  const title = normalizeLotEvidence(context.title);
  if (
    !/\b(?:microscope|microprojector)\b/u.test(title) ||
    /\b(?:microscopes|microprojectors)\b/u.test(title) ||
    /\b(?:assorted|assortment|bundle|collection|components?|eyepieces?|lenses?|mixed|misc(?:ellaneous)?|objectives?|pallet|parts?|set)\b/u.test(
      title,
    ) ||
    /\blot\b(?!\s*(?:#|no\.?)?\s*\d)/u.test(stripNonGroupingLotPhrases(title)) ||
    minimumSaleItemQuantity(title) >= 2
  ) {
    return false;
  }
  const sourceText = normalizeLotEvidence(context.sourceText);
  if (
    /\b(?:microscopes|microprojectors)\b/u.test(sourceText) ||
    /\b(?:lot|pallet|bundle|collection|assortment|assorted|mixed|misc(?:ellaneous)?)\b[^\n.;]{0,80}\b(?:microscope|microprojector)\b/u.test(
      sourceText,
    ) ||
    new RegExp(
      `\\b(?:\\d+|${NUMBER_WORD_PATTERN}|multiple|several)\\s+(?:microscopes|microprojectors)\\b`,
      "u",
    ).test(sourceText)
  ) {
    return false;
  }

  let primarySystems = 0;
  for (const item of includedItems) {
    const normalized = normalizeLotEvidence(item);
    if (!normalized || isSyntheticGroupingEvidence(normalized)) continue;
    const clause = primaryItemClause(normalized);
    if (/\b(?:microscope|microprojector)\b/u.test(clause)) {
      if (
        /\b(?:microscopes|microprojectors)\b/u.test(clause) ||
        minimumSaleItemQuantity(clause) >= 2
      ) return false;
      primarySystems += 1;
      if (primarySystems > 1) return false;
      continue;
    }
    if (
      isClearlySubordinateContent(clause) ||
      isOpticalSystemSupportItem(clause)
    ) continue;
    return false;
  }
  return primarySystems === 1;
}

function isOpticalSystemSupportItem(value: string): boolean {
  const withoutCount = value
    .replace(/^\s*~?\(?\s*\d+\s*\)?\s*(?:x|ea\.?|each|units?)?\s*/u, "")
    .trim();
  return /^(?:(?:external|power)\s+)?light source(?:\s*\([^)]*\))?$/u.test(
    withoutCount,
  ) ||
    /^(?:external\s+)?transformer(?:\s*\([^)]*\))?$/u.test(withoutCount);
}

function explicitSubordinatePluralSale(
  context: LotClassificationContext,
  includedItems: readonly string[],
): boolean {
  return [context.title ?? "", ...includedItems].some((entry) => {
    const clause = primaryItemClause(normalizeLotEvidence(entry));
    return clause !== "" &&
      isClearlySubordinateContent(clause) &&
      hasGeneralPrimaryPlural(clause);
  });
}

function explicitInteractivePresentationSystem(
  context: LotClassificationContext,
  includedItems: readonly string[],
): boolean {
  const title = normalizeLotEvidence(context.title);
  if (
    !/\binteractive whiteboard\b/u.test(title) ||
    /\b(?:lot|mixed|misc(?:ellaneous)?|assorted|assortment)\b/u.test(title)
  ) {
    return false;
  }
  const evidence = normalizeLotEvidence(
    `${context.sourceText ?? ""}\n${includedItems.join("\n")}`,
  );
  if (
    !/\b(?:lcd|multimedia|video)?\s*projector\b/u.test(evidence) ||
    !(
      /\bcomplete presentation setup\b/u.test(evidence) ||
      /\b(?:includes?|included|with)\b[^\n.;]{0,100}\bprojector\b/u.test(evidence) ||
      /\bprojector\b[^\n.;]{0,60}\bincluded\b/u.test(evidence)
    )
  ) {
    return false;
  }
  if (minimumSaleItemQuantity(title) >= 2) return false;
  return includedItems.every((item) => {
    const clause = primaryItemClause(item);
    if (!clause) return true;
    if (/\b(?:interactive whiteboard|projector)\b/u.test(clause)) {
      return minimumSaleItemQuantity(clause) < 2;
    }
    return isClearlySubordinateContent(clause);
  });
}

function explicitCoordinatedMonitorStandSale(
  title: string | null | undefined,
  includedItems: readonly string[],
): boolean {
  const normalizedTitle = normalizeLotEvidence(title);
  if (
    !/\b(?:monitor|display|television|tv)\b[^\n]{0,80}\band\b[^\n]{0,40}\b(?:monitor\s+)?stand\b/u.test(normalizedTitle)
  ) return false;
  const items = normalizeLotEvidence(includedItems.join("\n"));
  return /\b(?:monitor|display|television|tv)\b/u.test(items) &&
    /\bstand\b/u.test(items);
}

function explicitCollectionKind(
  context: LotClassificationContext,
  includedItems: readonly string[],
  hasPrimaryMainItem: boolean,
): "multi" | "assorted" | null {
  const title = context.title?.trim().toLocaleLowerCase() ?? "";
  const itemsText = includedItems.join("\n").toLocaleLowerCase();
  const subordinateText = itemsText;
  const groupingEvidence = stripNonGroupingLotPhrases(`${title}\n${itemsText}`);
  if (/\b(?:mixed|misc(?:ellaneous)?|assorted|assortment)\b/u.test(title)) {
    return "assorted";
  }
  if (
    /\blot\b(?!\s*(?:#|no\.?)?\s*\d)/u.test(stripNonGroupingLotPhrases(title))
    || /\b(?:pallets?|collections?|assortments?|groups?|sets?)\s+(?:of|containing)\b/u.test(groupingEvidence)
  ) {
    return "multi";
  }
  if (
    !hasPrimaryMainItem
    && title
    && !/\bwith\b/u.test(title)
    && !/\b(?:for parts|parts only)\b/u.test(title)
    && !/\bparts? washers?\b/u.test(title)
    && !/\bparts? units?\b/u.test(title)
    && /\b(?:parts|accessories|supplies|components)\b/u.test(title)
  ) {
    return "multi";
  }
  if (!hasPrimaryMainItem) {
    if (/\b(?:mixed|misc(?:ellaneous)?|assorted|assortment)\b/u.test(subordinateText)) {
      return "assorted";
    }
    if (
      /\blot\s+of\b/u.test(itemsText)
    ) {
      return "multi";
    }
  }
  return null;
}

function minimumSubordinateCollectionCount(
  includedItems: readonly string[],
): 0 | 1 | 2 {
  let count = 0;
  for (const item of includedItems) {
    const clause = primaryItemClause(item);
    if (!clause || !isClearlySubordinateContent(clause)) continue;
    count += minimumItemQuantity(clause);
    if (count >= 2) return 2;
  }
  return count === 1 ? 1 : 0;
}

function primaryItemClause(value: string): string {
  return value
    .toLocaleLowerCase()
    .split(/\b(?:with|including|includes|plus|and\s+(?:attached|onboard))\b/u, 1)[0]
    ?.trim() ?? "";
}

function isClearlySubordinateContent(value: string): boolean {
  const normalized = value.replace(
    /\s*\([^)]*\b(?:accessor(?:y|ies)|attachments?|supporting (?:item|equipment))\b[^)]*\)\s*$/u,
    "",
  ).trim();
  // "parts washer" is a whole machine despite the otherwise subordinate word.
  if (
    /\bparts? washers?\b/u.test(normalized) ||
    /\bparts? units?\b/u.test(normalized) ||
    /\b(?:maintenance platforms?|(?:portable\s+)?maintenance stands?)\b/u.test(normalized) ||
    (
      /\bshower stall bases?\b/u.test(normalized) &&
      (
        minimumSaleItemQuantity(normalized) >= 2 ||
        /^(?:qty|quantity)\b|^\s*~?\(?\s*1\s*\)?\s*(?:x|ea\.?|each|units?)\b/u.test(normalized)
      )
    )
  ) return false;
  return SUBORDINATE_CONTENT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function minimumItemQuantity(value: string): number {
  if (/^\s*(?:multiple|several)\b/u.test(value)) return 2;
  if (/^\s*(?:a\s+)?pair\s+of\b/u.test(value)) return 2;
  if (/^\s*(?:a\s+)?(?:dozen|hundred|few)\b/u.test(value)) return 2;

  const explicitQuantity = /^\s*(?:qty|quantity)\s*[:#-]?\s*(\d+)\b/u.exec(value)
    ?? /\b(?:set|group|lot)\s+of\s+(\d+)\b/u.exec(value);
  if (explicitQuantity) {
    return Number(explicitQuantity[1]) >= 2 ? 2 : 1;
  }

  const leadingNumber = /^\s*~?\(?\s*(\d+)\s*\)?\s*(x|ea\.?|each|units?)?\b\s*(.*)$/u.exec(value);
  if (leadingNumber) {
    const amount = Number(leadingNumber[1]);
    if (amount < 2) return 1;
    if (/^\s*~?\(\s*\d+\s*\)/u.test(value)) return 2;
    if (leadingNumber[2]) return 2;
    // A bare numeric prefix is commonly a year, model, or rating. Treat it as
    // quantity only when the following phrase has count grammar (normally a
    // plural item noun). This keeps "308 centrifuge" and "800 water bath"
    // single while retaining "2 LG TVs" and "12 tan reloads" as lots.
    if (amount >= 1_000 || !hasCredibleBareCountGrammar(leadingNumber[3] ?? "")) return 1;
    return 2;
  }

  const wordMatch = /^\s*(one|two|three|four|five|six|seven|eight|nine|ten)\b/u.exec(value);
  if (wordMatch) return (NUMBER_WORDS[wordMatch[1]!] ?? 1) >= 2 ? 2 : 1;
  return 1;
}

function hasCredibleBareCountGrammar(value: string): boolean {
  const firstItemPhrase = value.split(/\s*(?:,|;|&|\+|\b(?:and|plus|with)\b)\s*/u, 1)[0]
    ?.trim() ?? "";
  if (!firstItemPhrase) return false;
  if (/^(?:items?|listings?|pieces?|pcs?\.?|units?)\b/u.test(firstItemPhrase)) return true;
  if (EXPLICIT_PRIMARY_PLURAL_PATTERN.test(firstItemPhrase)) return true;
  const words = firstItemPhrase.match(/[\p{L}][\p{L}-]*/gu) ?? [];
  const noun = words.at(-1) ?? "";
  if (!noun || /^(?:analysis|apparatus|basis|chassis|class|gas|glass|news|series|status)$/u.test(noun)) {
    return false;
  }
  return /(?:ies|ses|xes|zes|ches|shes|s)$/u.test(noun) && !/(?:ss|us)$/u.test(noun);
}

/**
 * A leading number in a sale title or item name is not necessarily a count.
 * Common equipment specifications such as lead count, door count, and rated
 * tonnage describe one machine. Explicit Qty lines are handled separately.
 */
function minimumSaleItemQuantity(value: string): number {
  const normalized = normalizeLotEvidence(value);
  if (
    new RegExp(
      `^\\s*~?\\(?\\s*(?:\\d+|${NUMBER_WORD_PATTERN})\\s*\\)?\\s*(?:-\\s*)?(?:${SPECIFICATION_NOUN_PATTERN})\\b`,
      "u",
    ).test(normalized)
  ) {
    return 1;
  }
  return minimumItemQuantity(normalized);
}

function isSyntheticGroupingEvidence(value: string): boolean {
  return /^source grouping\b/u.test(value) ||
    /^(?:lot of|quantity)\s+\d+\s+total items\b/u.test(value);
}

function normalizeLotEvidence(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function explicitAssortedSale(title: string, allEvidence: string): boolean {
  if (/\b(?:mixed|misc(?:ellaneous)?|assorted|assortment)\b/u.test(title)) {
    return true;
  }
  return /\b(?:mixed|misc(?:ellaneous)?|assorted|assortment)\b[^\n]{0,80}\b(?:lot|pallet|bundle|collection)\b/u.test(allEvidence)
    || /\b(?:lot|pallet|bundle|collection)\b[^\n]{0,80}\b(?:mixed|misc(?:ellaneous)?|assorted|assortment)\b/u.test(allEvidence);
}

function explicitTitleGrouping(title: string): boolean {
  const groupingTitle = stripNonGroupingLotPhrases(title);
  const containerCount = /^\s*\(\s*(\d{1,3})\s*(?:box(?:es)?|bags?|cases?|cartons?|packs?|packages?|trays?|pallets?|crates?|totes?|bins?|buckets?)\s*\)/u.exec(groupingTitle);
  const labelledQuantity = /\bqty\s*[:#-]?\s*(\d{1,3})\b/u.exec(groupingTitle);
  const packCount = /\b(\d{1,3})[ -]packs?\b/u.exec(groupingTitle);
  return (containerCount !== null && Number(containerCount[1]) >= 2)
    || (labelledQuantity !== null && Number(labelledQuantity[1]) >= 2)
    || (packCount !== null && Number(packCount[1]) >= 2)
    || /^\s*\(\s*\d+\s+pallets?\s*\)/u.test(groupingTitle)
    || /\blot\b(?!\s*(?:#|no\.?)?\s*\d)/u.test(groupingTitle)
    || /\b(?:pallets?|collections?|assortments?|groups?|sets?)\s+(?:of|containing)\b/u.test(title);
}

function stripNonGroupingLotPhrases(value: string): string {
  return value.replace(/\b(?:parking|vacant)\s+lots?\b/gu, "");
}

function explicitBundleGrouping(value: string): boolean {
  const standaloneMarker = value.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!/\bbundle\s*$/u.test(trimmed)) return false;
    return !/\b(?:with|including|includes)\b[^\n]*\bbundle\s*$/u.test(trimmed)
      && !/\bsoftware\s+bundle\s*$/u.test(trimmed);
  });
  return /(?:^|\n)\s*\(\s*bu(?:ndle|nlde)\s*\)/u.test(value)
    || standaloneMarker
    || /\bbundled?\s+listings?\b/u.test(value)
    || /\bbundles?\s+of\s+(?!(?:a|an|one|1)\b)[^\n.;]+/u.test(value)
    || /\bbundles?\s+of\s+(?:\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|multiple|several)\b/u.test(value)
    || /\b(?:\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|multiple|several)\s+(?:items?|listings?|units?)\s+(?:sold\s+)?(?:as|in)\s+(?:a\s+)?bundle\b/u.test(value);
}

function explicitContainerGrouping(value: string): boolean {
  const matches = value.matchAll(
    /\b(?:box(?:es)?|bags?|cases?|cartons?|packs?|packages?|trays?|pallets?|crates?|totes?|bins?|buckets?)\s+((?:(?:full|filled)\s+)?)(of|containing)\s+([^\n.;]+)/gu,
  );
  for (const match of matches) {
    const prefix = value.slice(Math.max(0, match.index - 48), match.index);
    const fullness = match[1]?.trim() ?? "";
    const relation = match[2] ?? "";
    const contents = match[3]?.trim() ?? "";
    const explicitlyMultipleContents = /^(?:a\s+)?(?:dozen|hundred|few|multiple|several)\b/u.test(contents)
      || minimumItemQuantity(contents) >= 2
      || hasCredibleBareCountGrammar(contents);
    if (
      /\b(?:original|carrying|protective|shipping|storage)\s+$/u.test(prefix)
      || /\b(?:with|in|inside|plus|and)\s+(?:(?:a|an|the)\s+)?$/u.test(prefix)
      || (
        !explicitlyMultipleContents &&
        /^(?:only\s+)?(?:a|an|one|1)\b/u.test(contents)
      )
      || (relation === "containing" && !fullness && !explicitlyMultipleContents)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function explicitParentheticalCount(
  context: LotClassificationContext,
  includedItems: readonly string[],
): boolean {
  // Parenthesized phone area codes, dimensions, model fragments, and inventory
  // references are common in free-form descriptions. Only the sale title and
  // normalized included-item phrases are safe generic count surfaces; explicit
  // source quantity lines are handled by repeatedCountedSourceLines instead.
  const entries = [
    context.title ?? "",
    ...includedItems,
  ];
  for (const entry of entries) {
    const normalized = normalizeLotEvidence(entry);
    for (const match of normalized.matchAll(/\(\s*(\d{1,3})\s*\)/gu)) {
      if (Number(match[1]) < 2 || match.index === undefined) continue;
      const before = normalized.slice(Math.max(0, match.index - 80), match.index)
        .split(/[.;]/u).at(-1)?.trim() ?? "";
      const after = normalized.slice(match.index + match[0].length, match.index + match[0].length + 80)
        .split(/[.;]/u, 1)[0]?.trim() ?? "";
      if (
        hasCredibleBareCountGrammar(before.replace(/\b(?:approx(?:imately)?\.?|about|around)\s*$/u, ""))
        || hasCredibleBareCountGrammar(after)
      ) return true;
    }
  }
  return false;
}

function approximateCollectionCount(value: string): boolean {
  const matches = value.matchAll(
    /\b(?:approximately|approx\.?|about|around)\s*~?\s*(\d{1,3})\s+(?:box(?:es)?|bags?|cases?|cartons?|packs?|packages?|trays?|pallets?|crates?|totes?|bins?|buckets?|units?|pieces?|pcs?|items?)\b/gu,
  );
  for (const match of matches) {
    if (Number(match[1]) >= 2) return true;
  }
  return false;
}

function repeatedCountedSourceLines(value: string): number {
  if (!value) return 0;
  let count = 0;
  for (const line of value.split(/\r?\n/u)) {
    const isExplicitQuantity = /^\s*(?:[-*•]\s*)?(?:qty|quantity)\.?\s*[:#-]?\s*\d{1,3}\b/u.test(line);
    const match = /^\s*(?:[-*•]\s*)?(?:qty\.?\s*[:#-]?\s*)?(\d{1,3})\s+(?:x\s+|ea\.?\s+|each\s+|units?\s+|pieces?\s+|pcs?\.?\s+)?([a-z][a-z0-9-]*)\b/u.exec(line);
    if (!match || Number(match[1]) < 2) continue;
    if (/^(?:channel|channels|day|days|door|doors|gallon|gallons|hour|hours|inch|inches|lead|leads|liter|liters|mile|miles|month|months|percent|phase|phases|ton|tons|volt|volts|watt|watts|week|weeks|year|years)$/u.test(match[2] ?? "")) {
      continue;
    }
    // A single explicitly labelled Qty line is stronger evidence than a bare
    // leading number. Return the threshold sentinel immediately.
    if (isExplicitQuantity) return 2;
    if (minimumSaleItemQuantity(line) < 2) continue;
    count += 1;
    if (count >= 2) return count;
  }
  return count;
}

function pluralExpirationLotEvidence(
  context: LotClassificationContext,
  includedItems: readonly string[],
): boolean {
  const sourceText = normalizeLotEvidence(context.sourceText);
  if (!/\bexp(?:iration|iry)?\.?\s+dates\b/u.test(sourceText)) return false;
  const dateCount = sourceText.match(
    /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}[/-]\d{4})\b/gu,
  )?.length ?? 0;
  if (dateCount < 2) return false;
  const itemEvidence = normalizeLotEvidence(
    `${context.title ?? ""}\n${includedItems.join("\n")}`,
  );
  return /\b(?:catheters?|consumables?|devices?|disposables?|guidewires?|implants?|instruments?|medical supplies?|reloads?|staplers?|sutures?)\b/u.test(itemEvidence);
}
