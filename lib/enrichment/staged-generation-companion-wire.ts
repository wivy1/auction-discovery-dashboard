import type {
  EnrichmentEmbeddingStageBinding,
  EnrichmentStageBinding,
  StagedEnrichmentEmbeddingResult,
} from "./staged-generation";
import type { PreparedListingEnrichment } from "../pipeline/enrich";

export const ENRICHMENT_STAGING_COMPANION_SCHEMA =
  "auction-discovery-enrichment-staging-companion-v1" as const;
export const ENRICHMENT_STAGING_COMPANION_PATH =
  "/v1/enrichment-staged-generation" as const;
export const ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES =
  3 * 1024 * 1024;

export type EnrichmentStagingCompanionOperation =
  | "read_listing_enrichment"
  | "write_listing_enrichment"
  | "read_listing_embeddings"
  | "write_listing_embeddings";

export type EnrichmentStagingCompanionRequest =
  | {
      readonly schemaVersion: typeof ENRICHMENT_STAGING_COMPANION_SCHEMA;
      readonly operation: "read_listing_enrichment";
      readonly binding: EnrichmentStageBinding;
    }
  | {
      readonly schemaVersion: typeof ENRICHMENT_STAGING_COMPANION_SCHEMA;
      readonly operation: "write_listing_enrichment";
      readonly binding: EnrichmentStageBinding;
      readonly prepared: PreparedListingEnrichment;
    }
  | {
      readonly schemaVersion: typeof ENRICHMENT_STAGING_COMPANION_SCHEMA;
      readonly operation: "read_listing_embeddings";
      readonly binding: EnrichmentEmbeddingStageBinding;
    }
  | {
      readonly schemaVersion: typeof ENRICHMENT_STAGING_COMPANION_SCHEMA;
      readonly operation: "write_listing_embeddings";
      readonly binding: EnrichmentEmbeddingStageBinding;
      readonly results: readonly StagedEnrichmentEmbeddingResult[];
    };

export type EnrichmentStagingCompanionResult =
  | PreparedListingEnrichment
  | readonly StagedEnrichmentEmbeddingResult[]
  | null;

export interface EnrichmentStagingCompanionSuccess {
  readonly schemaVersion: typeof ENRICHMENT_STAGING_COMPANION_SCHEMA;
  readonly status: "ok";
  readonly result: EnrichmentStagingCompanionResult;
}

export interface EnrichmentStagingCompanionFailure {
  readonly schemaVersion: typeof ENRICHMENT_STAGING_COMPANION_SCHEMA;
  readonly status: "error";
  readonly code: EnrichmentStagingCompanionErrorCode;
}

export type EnrichmentStagingCompanionErrorCode =
  | "invalid_enrichment_staging_request"
  | "enrichment_staged_generation_tampered"
  | "enrichment_staged_generation_ambiguous"
  | "enrichment_staged_generation_binding_invalid"
  | "enrichment_staged_generation_payload_invalid"
  | "enrichment_staged_generation_secret_field"
  | "enrichment_staged_generation_oversized"
  | "enrichment_staged_generation_hash_invalid"
  | "enrichment_staged_generation_failed";

const STORAGE_ERROR_CODES = new Set<EnrichmentStagingCompanionErrorCode>([
  "enrichment_staged_generation_tampered",
  "enrichment_staged_generation_ambiguous",
  "enrichment_staged_generation_binding_invalid",
  "enrichment_staged_generation_payload_invalid",
  "enrichment_staged_generation_secret_field",
  "enrichment_staged_generation_oversized",
  "enrichment_staged_generation_hash_invalid",
]);

export function parseEnrichmentStagingCompanionRequest(
  value: unknown,
): EnrichmentStagingCompanionRequest {
  if (
    !isRecord(value) ||
    value.schemaVersion !== ENRICHMENT_STAGING_COMPANION_SCHEMA ||
    typeof value.operation !== "string"
  ) throw invalidRequest();
  switch (value.operation) {
    case "read_listing_enrichment":
    case "read_listing_embeddings":
      if (!exactKeys(value, ["schemaVersion", "operation", "binding"])) {
        throw invalidRequest();
      }
      return value as unknown as EnrichmentStagingCompanionRequest;
    case "write_listing_enrichment":
      if (!exactKeys(value, ["schemaVersion", "operation", "binding", "prepared"])) {
        throw invalidRequest();
      }
      return value as unknown as EnrichmentStagingCompanionRequest;
    case "write_listing_embeddings":
      if (!exactKeys(value, ["schemaVersion", "operation", "binding", "results"])) {
        throw invalidRequest();
      }
      return value as unknown as EnrichmentStagingCompanionRequest;
    default:
      throw invalidRequest();
  }
}

export function enrichmentStagingCompanionErrorCode(
  error: unknown,
): EnrichmentStagingCompanionErrorCode {
  const message = error instanceof Error ? error.message : "";
  if (STORAGE_ERROR_CODES.has(message as EnrichmentStagingCompanionErrorCode)) {
    return message as EnrichmentStagingCompanionErrorCode;
  }
  return message === "invalid_enrichment_staging_request"
    ? "invalid_enrichment_staging_request"
    : "enrichment_staged_generation_failed";
}

export function isEnrichmentStagingCompanionFailure(
  value: unknown,
): value is EnrichmentStagingCompanionFailure {
  return isRecord(value) &&
    exactKeys(value, ["schemaVersion", "status", "code"]) &&
    value.schemaVersion === ENRICHMENT_STAGING_COMPANION_SCHEMA &&
    value.status === "error" &&
    typeof value.code === "string" &&
    (
      value.code === "invalid_enrichment_staging_request" ||
      value.code === "enrichment_staged_generation_failed" ||
      STORAGE_ERROR_CODES.has(value.code as EnrichmentStagingCompanionErrorCode)
    );
}

export function invalidEnrichmentStagingCompanionRequest(): Error {
  return invalidRequest();
}

function invalidRequest(): Error {
  return new Error("invalid_enrichment_staging_request");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
