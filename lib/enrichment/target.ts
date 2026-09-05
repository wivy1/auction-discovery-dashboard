import type { AiProviders } from "../ai/types";
import {
  EXTRACTION_PROMPT_VERSION,
  SEMANTIC_DOCUMENT_VERSION,
} from "./prompt";
import { hashCanonicalJson } from "../performance/generations";
import type { EnrichmentProvenanceTarget } from "../pipeline/enrichment-heads";

export const ENRICHMENT_SESSION_TARGET_VERSION =
  // Bump when provider-failure semantics change so prior terminal fallbacks
  // are eligible for a fresh provider attempt without rewriting history.
  "enrichment-session-target-v3" as const;
export const EXTRACTION_NORMALIZER_VERSION =
  "text-extraction-normalizer-v28" as const;

/** Exact vector-width contract shared by storage, sessions, and rebuild tools. */
export function expectedEmbeddingDimensions(target: {
  readonly embeddingProviderName: string;
  readonly embeddingModelName: string;
  readonly embeddingDimensions?: number;
}): number {
  if (target.embeddingProviderName === "disabled" && !target.embeddingModelName) return 0;
  if (target.embeddingDimensions !== undefined) {
    if (!Number.isSafeInteger(target.embeddingDimensions) || target.embeddingDimensions <= 0) {
      throw new TypeError("embedding dimensions must be a positive safe integer");
    }
    return target.embeddingDimensions;
  }
  if (target.embeddingProviderName.trim().toLowerCase() === "ollama") {
    const model = target.embeddingModelName.trim().toLowerCase().split("/").at(-1) ?? "";
    if (/^qwen3-embedding:8b(?:[-_].*)?$/u.test(model)) return 4_096;
    if (/^qwen3-embedding:4b(?:[-_].*)?$/u.test(model)) return 2_560;
    if (/^qwen3-embedding:0\.6b(?:[-_].*)?$/u.test(model)) return 1_024;
  }
  throw new TypeError(
    `No embedding dimension contract for ${target.embeddingProviderName}/${target.embeddingModelName}`,
  );
}

/** One environment-free identity shared by head state and projection rebuilds. */
export async function enrichmentSessionProvenanceTarget(
  providers: AiProviders,
  embeddingDimensions?: number,
): Promise<EnrichmentProvenanceTarget> {
  if (providers.text.providerName === "disabled" || providers.embeddings.providerName === "disabled") {
    return Object.freeze({
      identity: "enrichment-unconfigured-v1",
      textProviderName: "disabled",
      textModelName: "",
      extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
      extractionNormalizerVersion: EXTRACTION_NORMALIZER_VERSION,
      semanticDocumentVersion: SEMANTIC_DOCUMENT_VERSION,
      embeddingProviderName: "disabled",
      embeddingModelName: "",
      embeddingDimensions: 0,
    });
  }
  const dimensions = expectedEmbeddingDimensions({
    embeddingProviderName: providers.embeddings.providerName,
    embeddingModelName: providers.embeddings.modelName,
    embeddingDimensions,
  });
  const fields = {
    textProviderName: providers.text.providerName,
    textModelName: providers.text.modelName,
    extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
    extractionNormalizerVersion: EXTRACTION_NORMALIZER_VERSION,
    semanticDocumentVersion: SEMANTIC_DOCUMENT_VERSION,
    embeddingProviderName: providers.embeddings.providerName,
    embeddingModelName: providers.embeddings.modelName,
    embeddingDimensions: dimensions,
  };
  return Object.freeze({
    identity: await hashCanonicalJson({
      derivationVersion: ENRICHMENT_SESSION_TARGET_VERSION,
      ...fields,
    }),
    ...fields,
  });
}
