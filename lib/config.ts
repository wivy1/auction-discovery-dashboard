import { sourceRegistrations } from "./sources/registry";

export type SourceKey = string;

function text(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function integer(name: string, fallback: number, minimum = 0): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function boundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function integerOverride(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name]?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

function bool(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

export interface AppConfig {
  appName: string;
  /**
   * Server-only switch for an immutable ad hoc review cohort. It is
   * intentionally omitted from publicConfig and has no effect when unset.
   */
  adhocReviewCohortId: string | null;
  /**
   * Server-only, run-scoped additive publication mode. When enabled, a
   * refreshed source head carries forward rows absent from the new traversal.
   */
  preserveUnobservedCurrentListings: boolean;
  originPostalCode: string;
  originCountry: string;
  timeZone: string;
  ai: {
    textProvider: string;
    textModel: string;
    textPreparationConcurrency: number;
    embeddingProvider: string;
    embeddingModel: string;
    ollamaBaseUrl: string;
    timeoutMs: number;
    maxRetries: number;
  };
  routing: {
    readonly routeProvider: "local_proximity";
  };
  sources: Record<SourceKey, boolean>;
  sourceTimeoutMs: number;
  limits: {
    maxCandidatesPerSourceRun: number;
    maxPrimaryImageDownloadsPerRun: number;
    retryFailedPrimaryImages: boolean;
    discoveryRunLeaseMs: number;
  };
}

export function getConfig(): AppConfig {
  return {
    appName: text("APP_NAME", "Auction Discovery"),
    adhocReviewCohortId:
      process.env.ADHOC_REVIEW_COHORT_ID?.trim() || null,
    preserveUnobservedCurrentListings: bool(
      "PIPELINE_PRESERVE_UNOBSERVED_CURRENT_LISTINGS",
    ),
    originPostalCode: text("ORIGIN_POSTAL_CODE", "90210"),
    originCountry: text("ORIGIN_COUNTRY", "US"),
    timeZone: text("DEFAULT_TIME_ZONE", "UTC"),
    ai: {
      textProvider: text("AI_TEXT_PROVIDER", "ollama"),
      textModel: text("AI_TEXT_MODEL", ""),
      textPreparationConcurrency: boundedInteger(
        "AI_TEXT_CONCURRENCY",
        1,
        1,
        2,
      ),
      embeddingProvider: text("AI_EMBEDDING_PROVIDER", "ollama"),
      embeddingModel: text("AI_EMBEDDING_MODEL", ""),
      ollamaBaseUrl: text("OLLAMA_BASE_URL", "http://localhost:11434").replace(/\/$/, ""),
      timeoutMs: integer("AI_TIMEOUT_MS", 90_000, 1_000),
      maxRetries: integer("AI_MAX_RETRIES", 2),
    },
    routing: {
      routeProvider: "local_proximity",
    },
    sources: Object.fromEntries(sourceRegistrations.map((registration) => [
      registration.adapter.manifest.id,
      registration.enabled ?? false,
    ])),
    sourceTimeoutMs: integer("SOURCE_TIMEOUT_MS", 30_000, 1_000),
    limits: {
      maxCandidatesPerSourceRun: integer("PIPELINE_MAX_CANDIDATES_PER_SOURCE", 30, 1),
      maxPrimaryImageDownloadsPerRun: integerOverride(
        "PIPELINE_MAX_IMAGE_DOWNLOADS_OVERRIDE",
        integer("PIPELINE_MAX_IMAGE_DOWNLOADS", 6),
      ),
      retryFailedPrimaryImages: bool("PIPELINE_RETRY_FAILED_IMAGES"),
      discoveryRunLeaseMs: integer("DISCOVERY_RUN_LEASE_MS", 30 * 60_000, 60_000),
    },
  };
}

export function publicConfig(config = getConfig()) {
  return {
    appName: config.appName,
    originPostalCode: config.originPostalCode,
    originCountry: config.originCountry,
    timeZone: config.timeZone,
    textProvider: config.ai.textProvider,
    textModel: config.ai.textModel,
    embeddingProvider: config.ai.embeddingProvider,
    embeddingModel: config.ai.embeddingModel,
    routeProvider: config.routing.routeProvider,
    sources: config.sources,
    limits: {
      ...config.limits,
      maxPrimaryImageDownloadsPerRun: integer(
        "PIPELINE_MAX_IMAGE_DOWNLOADS",
        6,
      ),
    },
  };
}
