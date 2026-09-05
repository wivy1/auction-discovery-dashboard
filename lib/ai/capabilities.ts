export interface OptionalAiCapabilities {
  readonly enrichment: boolean;
  /** A preference scorer is not installed in this distribution. */
  readonly preferenceScoring: false;
}

/** Reads configuration only; never probes, downloads, or invokes a model. */
export function optionalAiCapabilities(
  environment: Readonly<Record<string, string | undefined>> =
    typeof process === "undefined" ? {} : process.env,
): OptionalAiCapabilities {
  return Object.freeze({
    enrichment: ["AI_TEXT_PROVIDER", "AI_TEXT_MODEL", "AI_EMBEDDING_PROVIDER", "AI_EMBEDDING_MODEL"]
      .every((key) => Boolean(environment[key]?.trim()) && environment[key]?.trim() !== "disabled"),
    preferenceScoring: false,
  });
}
