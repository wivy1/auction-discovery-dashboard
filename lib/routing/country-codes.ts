/**
 * Dependency-free ISO 3166-1 country normalization for source and routing data.
 *
 * The compact table keeps every assigned alpha-2/alpha-3 pair local. English
 * display names come from the platform's built-in Intl data, with explicit
 * aliases for common marketplace spellings and historic/common short names.
 */
const ISO_3166_1_PAIRS = `
AD AND AE ARE AF AFG AG ATG AI AIA AL ALB AM ARM AO AGO AQ ATA AR ARG AS ASM AT AUT AU AUS AW ABW AX ALA AZ AZE
BA BIH BB BRB BD BGD BE BEL BF BFA BG BGR BH BHR BI BDI BJ BEN BL BLM BM BMU BN BRN BO BOL BQ BES BR BRA BS BHS BT BTN BV BVT BW BWA BY BLR BZ BLZ
CA CAN CC CCK CD COD CF CAF CG COG CH CHE CI CIV CK COK CL CHL CM CMR CN CHN CO COL CR CRI CU CUB CV CPV CW CUW CX CXR CY CYP CZ CZE
DE DEU DJ DJI DK DNK DM DMA DO DOM DZ DZA EC ECU EE EST EG EGY EH ESH ER ERI ES ESP ET ETH FI FIN FJ FJI FK FLK FM FSM FO FRO FR FRA
GA GAB GB GBR GD GRD GE GEO GF GUF GG GGY GH GHA GI GIB GL GRL GM GMB GN GIN GP GLP GQ GNQ GR GRC GS SGS GT GTM GU GUM GW GNB GY GUY
HK HKG HM HMD HN HND HR HRV HT HTI HU HUN ID IDN IE IRL IL ISR IM IMN IN IND IO IOT IQ IRQ IR IRN IS ISL IT ITA JE JEY JM JAM JO JOR JP JPN
KE KEN KG KGZ KH KHM KI KIR KM COM KN KNA KP PRK KR KOR KW KWT KY CYM KZ KAZ LA LAO LB LBN LC LCA LI LIE LK LKA LR LBR LS LSO LT LTU LU LUX LV LVA LY LBY
MA MAR MC MCO MD MDA ME MNE MF MAF MG MDG MH MHL MK MKD ML MLI MM MMR MN MNG MO MAC MP MNP MQ MTQ MR MRT MS MSR MT MLT MU MUS MV MDV MW MWI MX MEX MY MYS MZ MOZ
NA NAM NC NCL NE NER NF NFK NG NGA NI NIC NL NLD NO NOR NP NPL NR NRU NU NIU NZ NZL OM OMN PA PAN PE PER PF PYF PG PNG PH PHL PK PAK PL POL PM SPM PN PCN PR PRI PS PSE PT PRT PW PLW PY PRY
QA QAT RE REU RO ROU RS SRB RU RUS RW RWA SA SAU SB SLB SC SYC SD SDN SE SWE SG SGP SH SHN SI SVN SJ SJM SK SVK SL SLE SM SMR SN SEN SO SOM SR SUR SS SSD ST STP SV SLV SX SXM SY SYR SZ SWZ
TC TCA TD TCD TF ATF TG TGO TH THA TJ TJK TK TKL TL TLS TM TKM TN TUN TO TON TR TUR TT TTO TV TUV TW TWN TZ TZA UA UKR UG UGA UM UMI US USA UY URY UZ UZB
VA VAT VC VCT VE VEN VG VGB VI VIR VN VNM VU VUT WF WLF WS WSM YE YEM YT MYT ZA ZAF ZM ZMB ZW ZWE
`;

const codeTokens = ISO_3166_1_PAIRS.trim().split(/\s+/);
if (codeTokens.length % 2 !== 0) {
  throw new Error("ISO 3166-1 country-code table is malformed");
}

const alpha2Codes = new Set<string>();
const alpha2ByAlpha3 = new Map<string, string>();
for (let index = 0; index < codeTokens.length; index += 2) {
  const alpha2 = codeTokens[index];
  const alpha3 = codeTokens[index + 1];
  alpha2Codes.add(alpha2);
  alpha2ByAlpha3.set(alpha3, alpha2);
}

const alpha2ByName = new Map<string, string>();
const displayNames = new Intl.DisplayNames(["en"], { type: "region" });
for (const alpha2 of alpha2Codes) {
  const displayName = displayNames.of(alpha2);
  if (displayName && displayName !== alpha2) {
    alpha2ByName.set(normalizeCountryName(displayName), alpha2);
  }
}

const COMMON_COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  america: "US",
  bolivia: "BO",
  brunei: "BN",
  burma: "MM",
  "cape verde": "CV",
  "cote d ivoire": "CI",
  "czech republic": "CZ",
  "democratic republic of congo": "CD",
  "democratic republic of the congo": "CD",
  "east timor": "TL",
  england: "GB",
  "great britain": "GB",
  "holy see": "VA",
  iran: "IR",
  ivorycoast: "CI",
  "ivory coast": "CI",
  laos: "LA",
  macao: "MO",
  macau: "MO",
  micronesia: "FM",
  moldova: "MD",
  "north korea": "KP",
  palestine: "PS",
  "republic of congo": "CG",
  "republic of the congo": "CG",
  russia: "RU",
  scotland: "GB",
  "south korea": "KR",
  swaziland: "SZ",
  syria: "SY",
  taiwan: "TW",
  tanzania: "TZ",
  "the netherlands": "NL",
  uk: "GB",
  "u k": "GB",
  "united kingdom": "GB",
  "united kingdom of great britain and northern ireland": "GB",
  "united states": "US",
  "united states of america": "US",
  us: "US",
  "u s": "US",
  usa: "US",
  "u s a": "US",
  vatican: "VA",
  "vatican city": "VA",
  venezuela: "VE",
  vietnam: "VN",
  wales: "GB",
};

for (const [name, alpha2] of Object.entries(COMMON_COUNTRY_ALIASES)) {
  alpha2ByName.set(normalizeCountryName(name), alpha2);
}

/** Returns an assigned ISO 3166-1 alpha-2 code, or null for unknown input. */
export function canonicalIsoAlpha2CountryCode(
  value: string | null | undefined,
): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const compactCode = trimmed.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (compactCode.length === 2 && alpha2Codes.has(compactCode)) {
    return compactCode;
  }
  if (compactCode.length === 3) {
    const alpha2 = alpha2ByAlpha3.get(compactCode);
    if (alpha2) return alpha2;
  }

  return alpha2ByName.get(normalizeCountryName(trimmed)) ?? null;
}

function normalizeCountryName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
