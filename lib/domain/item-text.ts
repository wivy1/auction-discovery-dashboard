function normalizedPolicyText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[“”]/gu, "\"")
    .replace(/[‘’]/gu, "'")
    .replace(/[*_]+/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase();
}

/** Preserve source-provided item text without source-specific removal rules. */
export function canonicalItemDescription(value: string): string {
  return value;
}

export type GenericMarketplacePolicySignal =
  | "as_is"
  | "no_functionality_claim"
  | "no_warranty"
  | "preview_only"
  | "sale_final";

export function genericMarketplacePolicySignal(
  value: string,
): GenericMarketplacePolicySignal | null {
  const normalized = normalizedPolicyText(value);
  if (
    /^(?:(?:all )?items? (?:are )?)?sold as is(?: where is)?$/u.test(normalized) ||
    /^as is(?: where is)?$/u.test(normalized)
  ) return "as_is";
  if (
    /^(?:makes? )?no claim of physical(?: or)? mechanical(?: and)? functionality$/u.test(
      normalized,
    )
  ) return "no_functionality_claim";
  if (/^(?:no|without any) warrant(?:y|ies)$/u.test(normalized)) {
    return "no_warranty";
  }
  if (/^photos? and descriptions? are for preview only$/u.test(normalized)) {
    return "preview_only";
  }
  if (
    /^all sales? are final$/u.test(normalized) ||
    /^no refunds?(?: will be issued)?$/u.test(normalized)
  ) return "sale_final";
  return null;
}

/**
 * Generic policy text is not an item-level negative signal. Retain it only
 * when the canonical item description itself still contains the same policy
 * fact. Source adapters own any explicitly configured policy-text extraction.
 */
export function policySignalIsGrounded(
  signal: GenericMarketplacePolicySignal,
  canonicalSourceText: string,
): boolean {
  const source = normalizedPolicyText(canonicalSourceText);
  switch (signal) {
    case "as_is":
      return /\bas is\b/u.test(source);
    case "no_functionality_claim":
      return /\bno claim of\b/u.test(source) && /\bfunctionality\b/u.test(source);
    case "no_warranty":
      return /\b(?:no|without any) warrant(?:y|ies)\b/u.test(source);
    case "preview_only":
      return /\bphotos? and descriptions? are for preview only\b/u.test(source);
    case "sale_final":
      return /\ball sales? are final\b/u.test(source) || /\bno refunds?\b/u.test(source);
  }
}
