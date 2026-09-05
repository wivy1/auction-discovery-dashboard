import { env } from "cloudflare:workers";
import {
  bindAiInvalidAttemptContext,
  createAiProviders,
  provenanceFor,
  sha256Text,
  type AiProviders,
  type GenerationUsage,
} from "../ai";
import type { NormalizedListingDetail } from "../domain/listings";
import {
  isExplicitSingularAnalyzerSystem,
  isExplicitSingularOpticalSystem,
} from "../domain/lot-classification";
import {
  buildExtractionPrompt,
  buildCompatibleV23ExtractionPrompt,
  buildCompatibleV24ExtractionPrompt,
  buildCompatibleV25ExtractionPrompt,
  buildCompatibleV22ExtractionPrompt,
  buildCompatibleV21ExtractionPrompt,
  buildCompatibleV20ExtractionPrompt,
  buildCompatibleV19ExtractionPrompt,
  buildCompatibleV18ExtractionPrompt,
  buildCompatibleV12ExtractionPrompt,
  buildLegacyV11ExtractionPrompt,
  buildSemanticDocument,
  COMPATIBLE_EXTRACTION_PROMPT_VERSIONS,
  EXTRACTION_PROMPT_VERSION,
  LEGACY_EXTRACTION_PROMPT_VERSION,
  SEMANTIC_DOCUMENT_VERSION,
} from "../enrichment/prompt";
import {
  enrichmentInputLimit,
  legacyUnfilteredListingTextForEnrichment,
  listingExtractionInput,
  marketplacePolicyCleanupApplied,
} from "../enrichment/input";
import {
  extractionJsonSchema,
  validateTextExtraction,
  type TextExtraction,
} from "../enrichment/schema";
import { EXTRACTION_NORMALIZER_VERSION } from "../enrichment/target";
import {
  expectedEmbeddingDimensions,
  MAX_AI_PROVENANCE_RETRY_READ,
  storeAiArtifact,
  storeEmbeddings,
} from "./storage";
import type { ListingEnrichmentHead } from "./enrichment-heads";

export { EXTRACTION_NORMALIZER_VERSION } from "../enrichment/target";
const COMPATIBLE_EXTRACTION_PROMPT_BUILDERS = {
  "text-extraction-v25": buildCompatibleV25ExtractionPrompt,
  "text-extraction-v24": buildCompatibleV24ExtractionPrompt,
  "text-extraction-v23": buildCompatibleV23ExtractionPrompt,
  "text-extraction-v22": buildCompatibleV22ExtractionPrompt,
  "text-extraction-v21": buildCompatibleV21ExtractionPrompt,
  "text-extraction-v20": buildCompatibleV20ExtractionPrompt,
  "text-extraction-v19": buildCompatibleV19ExtractionPrompt,
  "text-extraction-v18": buildCompatibleV18ExtractionPrompt,
  "text-extraction-v12": buildCompatibleV12ExtractionPrompt,
} satisfies Record<
  (typeof COMPATIBLE_EXTRACTION_PROMPT_VERSIONS)[number],
  typeof buildCompatibleV23ExtractionPrompt
>;

export interface EnrichmentResult {
  extraction: TextExtraction;
  semanticDocument: string;
  embedding: number[];
  embeddingId: string;
  pendingEmbedding?: PendingEnrichmentEmbedding;
}

export interface PendingEnrichmentArtifact {
  readonly id: string;
  readonly listingId: string;
  readonly task: "listing_extraction" | "semantic_document";
  readonly providerName: string;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly inputHash: string;
  readonly outputText: string | null;
  readonly outputJson: string | null;
  readonly outputHash: string | null;
  readonly generatedAt: string;
}

export interface PendingEnrichmentEmbedding {
  readonly id: string;
  readonly listingId: string;
  readonly providerName: string;
  readonly modelName: string;
  readonly inputHash: string;
  readonly vector: readonly number[];
  readonly generatedAt: string;
}

type PendingEnrichmentArtifactInput = Omit<
  PendingEnrichmentArtifact,
  "id" | "generatedAt" | "outputText" | "outputJson" | "outputHash"
> & Readonly<{
  generatedAt?: string;
  outputText?: string | null;
  outputJson?: string | null;
  outputHash?: string | null;
}>;

export interface PreparedListingEnrichment {
  listingId: string;
  artifactInputHash: string;
  extractionArtifactId: string;
  semanticArtifactId: string;
  extraction: TextExtraction;
  semanticDocument: string;
  semanticHash: string;
  embedding: number[] | null;
  embeddingId: string | null;
  textGenerated: boolean;
  pendingArtifacts?: readonly PendingEnrichmentArtifact[];
}

export interface EnrichmentExecutionOptions {
  /** Cancels provider work and prevents any post-cancel durable write. */
  signal?: AbortSignal;
  /** A batch runner already verified both configured models immediately prior. */
  providersPreflighted?: boolean;
  /** Finite residency used only while a bounded text stage is active. */
  textKeepAlive?: string | number;
  /** Called immediately before a text request so batch cleanup is fail-safe. */
  beforeTextGeneration?: () => void;
  /** Called after the started text request settles, including rejection. */
  afterTextGeneration?: () => void;
  /** Called immediately before an embedding request reaches the provider. */
  beforeEmbeddingGeneration?: () => void;
  /** Called after the started embedding request settles, including rejection. */
  afterEmbeddingGeneration?: () => void;
  /** Bounds deterministic validation performed after a provider response. */
  beforeValidation?: (kind: "text" | "embedding") => void;
  /** Closes the matching deterministic validation interval. */
  afterValidation?: (kind: "text" | "embedding") => void;
  /** Exact provider-reported usage for a completed text request. */
  onTextGenerationUsage?: (usage: GenerationUsage | undefined) => void;
  /** The final embedding stage normally supplies zero for immediate unload. */
  embeddingKeepAlive?: string | number;
  /** Exact provider-reported usage for a completed embedding request. */
  onEmbeddingUsage?: (usage: GenerationUsage | undefined) => void;
  /** Explicit contract for test/custom targets not covered by the model map. */
  embeddingDimensions?: number;
  /** Queue sessions stage immutable outputs locally before their commit lane. */
  deferPersistence?: boolean;
  /** Stable time seam for staged, restartable immutable outputs. */
  generatedAt?: () => Date;
}

/**
 * Produces or reuses extraction and semantic artifacts without switching to
 * the embedding model. Dedicated backlog work calls this for every selected
 * row before it starts one shared embedding stage.
 */
export async function prepareListingEnrichment(
  listingId: string,
  detail: NormalizedListingDetail,
  providers: AiProviders = createAiProviders(),
  options: EnrichmentExecutionOptions = {},
): Promise<PreparedListingEnrichment> {
  const inputLimit = enrichmentInputLimit();
  const maxOutputTokens = positiveInteger(
    process.env.AI_MAX_OUTPUT_TOKENS,
    900,
  );
  const { listingText, prompt, inputHash } = await listingExtractionInput(
    detail,
    inputLimit,
  );
  const policyCleanupApplied = marketplacePolicyCleanupApplied(detail);
  const existingExtraction = await readExistingExtraction(
    listingId,
    providers.text.providerName,
    providers.text.modelName,
    inputHash,
    listingText.title,
    listingText.cleanDescription,
    policyCleanupApplied,
  );
  let extraction: TextExtraction;
  let textProviderName = providers.text.providerName;
  let textModelName = providers.text.modelName;
  let textGenerated = false;
  let extractionArtifactId: string;
  const pendingArtifacts: PendingEnrichmentArtifact[] = [];
  const persistArtifact = (input: PendingEnrichmentArtifactInput) =>
    storeOrStageAiArtifact(input, pendingArtifacts, options);

  if (existingExtraction) {
    extraction = existingExtraction.extraction;
    extractionArtifactId = existingExtraction.artifactId;
    if (existingExtraction.requiresCanonicalRepair) {
      const extractionJson = JSON.stringify(extraction);
      extractionArtifactId = await persistArtifact({
        listingId,
        task: "listing_extraction",
        providerName: textProviderName,
        modelName: textModelName,
        promptVersion: EXTRACTION_PROMPT_VERSION,
        inputHash,
        outputText: JSON.stringify({
          derivation: "current-input-deterministic-validator-repair",
          normalizerVersion: EXTRACTION_NORMALIZER_VERSION,
          sourceArtifactId: existingExtraction.artifactId,
          sourcePromptVersion: EXTRACTION_PROMPT_VERSION,
          sourceInputHash: inputHash,
          sourceOutputHash: existingExtraction.outputHash,
        }),
        outputJson: extractionJson,
        outputHash: await sha256Text(extractionJson),
      });
    }
  } else {
    let compatibleCurrentExtraction: Awaited<ReturnType<typeof readCompatibleExtraction>> = null;
    let repairDerivation =
      "source-text-identical-deterministic-validator-repair";
    const legacyUnfilteredListingText =
      legacyUnfilteredListingTextForEnrichment(detail, inputLimit);
    const legacyUnfilteredInputHash = await sha256Text(
      buildExtractionPrompt(legacyUnfilteredListingText),
    );
    if (legacyUnfilteredInputHash !== inputHash) {
      compatibleCurrentExtraction = await readCompatibleExtraction(
        listingId,
        providers.text.providerName,
        providers.text.modelName,
        EXTRACTION_PROMPT_VERSION,
        legacyUnfilteredInputHash,
        listingText.title,
        listingText.cleanDescription,
        policyCleanupApplied,
      );
      if (compatibleCurrentExtraction) {
        repairDerivation =
          "transaction-policy-cleanup-deterministic-validator-repair";
      }
    }
    if (!compatibleCurrentExtraction) {
      for (const compatibleVersion of COMPATIBLE_EXTRACTION_PROMPT_VERSIONS) {
        const compatibleInputHash = await sha256Text(
          COMPATIBLE_EXTRACTION_PROMPT_BUILDERS[compatibleVersion](listingText),
        );
        compatibleCurrentExtraction = await readCompatibleExtraction(
          listingId,
          providers.text.providerName,
          providers.text.modelName,
          compatibleVersion,
          compatibleInputHash,
          listingText.title,
          listingText.cleanDescription,
          policyCleanupApplied,
        );
        if (compatibleCurrentExtraction) break;
      }
    }
    const legacyInputHash = compatibleCurrentExtraction
      ? null
      : await sha256Text(buildLegacyV11ExtractionPrompt(listingText));
    const compatibleExtraction = compatibleCurrentExtraction ??
      await readCompatibleExtraction(
        listingId,
        providers.text.providerName,
        providers.text.modelName,
        LEGACY_EXTRACTION_PROMPT_VERSION,
        legacyInputHash!,
        listingText.title,
        listingText.cleanDescription,
        policyCleanupApplied,
      );
    if (compatibleExtraction) {
      extraction = compatibleExtraction.extraction;
      const extractionJson = JSON.stringify(extraction);
      extractionArtifactId = await persistArtifact({
        listingId,
        task: "listing_extraction",
        providerName: textProviderName,
        modelName: textModelName,
        promptVersion: EXTRACTION_PROMPT_VERSION,
        inputHash,
        outputText: JSON.stringify({
          derivation: repairDerivation,
          normalizerVersion: EXTRACTION_NORMALIZER_VERSION,
          sourceArtifactId: compatibleExtraction.artifactId,
          sourcePromptVersion: compatibleExtraction.promptVersion,
          sourceInputHash: compatibleExtraction.inputHash,
          sourceOutputHash: compatibleExtraction.outputHash,
        }),
        outputJson: extractionJson,
        outputHash: await sha256Text(extractionJson),
      });
    } else {
      if (!options.providersPreflighted) {
        const health = await providers.text.healthCheck(options.signal);
        if (!health.ok || !health.modelAvailable) {
          throw new Error(health.message || `${health.modelName} is not available in Ollama`);
        }
      }
      options.beforeTextGeneration?.();
      let generated: Awaited<ReturnType<typeof providers.text.generateStructured<TextExtraction>>>;
      try {
        try {
          generated = await providers.text.generateStructured({
            system: "You are a text-only surplus-equipment analyst. Never infer from images.",
            prompt,
            jsonSchema: extractionJsonSchema,
            parse: (value) => validateTextExtraction(value, {
              title: listingText.title,
              sourceText: listingText.cleanDescription,
              marketplacePolicyCleanupApplied: policyCleanupApplied,
            }),
            temperature: 0.1,
            maxOutputTokens,
            keepAlive: options.textKeepAlive,
            signal: options.signal,
          });
        } catch (error) {
          throw bindAiInvalidAttemptContext(error, {
            listingId,
            task: "listing_extraction",
            promptVersion: EXTRACTION_PROMPT_VERSION,
            inputHash,
          });
        }
      } finally {
        options.afterTextGeneration?.();
      }
      throwIfAborted(options.signal);
      options.onTextGenerationUsage?.(generated.usage);
      // Keep the persisted value canonical even when a provider implementation
      // returns a structurally valid object without applying the domain parser's
      // deterministic source-grounded normalizations. The storage validator
      // performs this same pass before accepting a chain, so persisting this
      // normalized value prevents a valid provider response from looping in the
      // enrichment queue forever.
      const extractionContext = {
        title: listingText.title,
        sourceText: listingText.cleanDescription,
        marketplacePolicyCleanupApplied: policyCleanupApplied,
      };
      options.beforeValidation?.("text");
      let normalizedExtraction: TextExtraction;
      try {
        normalizedExtraction = validateTextExtraction(
          validateTextExtraction(generated.value, extractionContext),
          extractionContext,
        );
      } finally {
        options.afterValidation?.("text");
      }
      const provenance = provenanceFor(generated, EXTRACTION_PROMPT_VERSION, inputHash);
      const extractionJson = JSON.stringify(normalizedExtraction);
      extractionArtifactId = await persistArtifact({
        listingId,
        task: "listing_extraction",
        ...provenance,
        outputJson: extractionJson,
        outputHash: await sha256Text(extractionJson),
      });
      extraction = normalizedExtraction;
      textProviderName = generated.providerName;
      textModelName = generated.modelName;
      textGenerated = true;
    }
  }

  const extractionOutputHash = await sha256Text(JSON.stringify(extraction));
  const existingSemanticDocument = await readExistingSemanticDocument(
    listingId,
    textProviderName,
    textModelName,
    inputHash,
    extractionOutputHash,
  );
  const semanticDocument = existingSemanticDocument?.semanticDocument ??
    buildSemanticDocument(listingText, extraction);
  const semanticHash = await sha256Text(semanticDocument);
  const semanticArtifactId = existingSemanticDocument?.artifactId ??
    await persistArtifact({
      listingId,
      task: "semantic_document",
      providerName: textProviderName,
      modelName: textModelName,
      promptVersion: SEMANTIC_DOCUMENT_VERSION,
      inputHash,
      outputText: semanticDocument,
      outputJson: JSON.stringify({ extractionOutputHash }),
      outputHash: semanticHash,
    });

  const existingEmbedding = await readExistingEmbedding(
    listingId,
    providers.embeddings.providerName,
    providers.embeddings.modelName,
    semanticHash,
    expectedEmbeddingDimensions({
      embeddingProviderName: providers.embeddings.providerName,
      embeddingModelName: providers.embeddings.modelName,
      embeddingDimensions: options.embeddingDimensions,
    }),
  );
  return {
    listingId,
    artifactInputHash: inputHash,
    extractionArtifactId,
    semanticArtifactId,
    extraction,
    semanticDocument,
    semanticHash,
    embedding: existingEmbedding?.vector ?? null,
    embeddingId: existingEmbedding?.embeddingId ?? null,
    textGenerated,
    ...(pendingArtifacts.length === 0
      ? {}
      : { pendingArtifacts: Object.freeze([...pendingArtifacts]) }),
  };
}

/**
 * Rehydrates only the immutable lineage named by an exact durable head. This
 * path never calls the text provider, so an embedding-only restart cannot
 * accidentally make the text and embedding models co-resident.
 */
export async function readPreparedListingEnrichmentFromHead(
  listingId: string,
  detail: NormalizedListingDetail,
  head: ListingEnrichmentHead,
  providers: AiProviders,
  options: Pick<EnrichmentExecutionOptions, "embeddingDimensions"> = {},
): Promise<PreparedListingEnrichment> {
  if (
    head.listingId !== listingId ||
    !["text_ready", "pending_embedding", "complete"].includes(head.state) ||
    head.extractionArtifactId === null || head.extractionOutputHash === null ||
    head.semanticArtifactId === null || head.semanticOutputHash === null
  ) {
    throw new Error("The enrichment head does not name a prepared text lineage");
  }
  const { listingText, inputHash } = await listingExtractionInput(
    detail,
    enrichmentInputLimit(),
  );
  const policyCleanupApplied = marketplacePolicyCleanupApplied(detail);
  const extractionRow = await readArtifactById(head.extractionArtifactId);
  if (
    extractionRow.subject_type !== "listing" || extractionRow.subject_id !== listingId ||
    extractionRow.task !== "listing_extraction" ||
    extractionRow.provider_name !== providers.text.providerName ||
    extractionRow.model_name !== providers.text.modelName ||
    extractionRow.prompt_version !== EXTRACTION_PROMPT_VERSION ||
    extractionRow.input_hash !== inputHash || extractionRow.output_json === null ||
    extractionRow.output_hash !== head.extractionOutputHash ||
    await sha256Text(extractionRow.output_json) !== head.extractionOutputHash
  ) throw new Error("The extraction artifact no longer matches the exact enrichment head");
  const extraction = validateTextExtraction(JSON.parse(extractionRow.output_json), {
    title: listingText.title,
    sourceText: listingText.cleanDescription,
    marketplacePolicyCleanupApplied: policyCleanupApplied,
  });
  if (await sha256Text(JSON.stringify(extraction)) !== head.extractionOutputHash) {
    throw new Error("The extraction artifact is not in canonical validated form");
  }

  const semanticRow = await readArtifactById(head.semanticArtifactId);
  if (
    semanticRow.subject_type !== "listing" || semanticRow.subject_id !== listingId ||
    semanticRow.task !== "semantic_document" ||
    semanticRow.provider_name !== providers.text.providerName ||
    semanticRow.model_name !== providers.text.modelName ||
    semanticRow.prompt_version !== SEMANTIC_DOCUMENT_VERSION ||
    semanticRow.input_hash !== inputHash || semanticRow.output_text === null ||
    semanticRow.output_text.trim() !== semanticRow.output_text ||
    semanticRow.output_json !== JSON.stringify({
      extractionOutputHash: head.extractionOutputHash,
    }) || semanticRow.output_hash !== head.semanticOutputHash ||
    await sha256Text(semanticRow.output_text) !== head.semanticOutputHash
  ) throw new Error("The semantic artifact no longer matches the exact enrichment head");

  let embedding: number[] | null = null;
  let embeddingId: string | null = null;
  if (head.embeddingId !== null) {
    const exactEmbedding = await readEmbeddingById({
      embeddingId: head.embeddingId,
      listingId,
      providerName: providers.embeddings.providerName,
      modelName: providers.embeddings.modelName,
      inputHash: head.semanticOutputHash,
      expectedDimensions: expectedEmbeddingDimensions({
        embeddingProviderName: providers.embeddings.providerName,
        embeddingModelName: providers.embeddings.modelName,
        embeddingDimensions: options.embeddingDimensions,
      }),
    });
    embedding = exactEmbedding.vector;
    embeddingId = exactEmbedding.embeddingId;
  }
  return {
    listingId,
    artifactInputHash: inputHash,
    extractionArtifactId: head.extractionArtifactId,
    semanticArtifactId: head.semanticArtifactId,
    extraction,
    semanticDocument: semanticRow.output_text,
    semanticHash: head.semanticOutputHash,
    embedding,
    embeddingId,
    textGenerated: false,
  };
}

/**
 * Embeds every missing semantic document in one provider request and stores
 * the vectors in the same stable order. Existing exact-provenance vectors are
 * reused without a provider call.
 */
export async function embedPreparedListingEnrichments(
  prepared: readonly PreparedListingEnrichment[],
  providers: AiProviders,
  options: EnrichmentExecutionOptions = {},
): Promise<readonly EnrichmentResult[]> {
  const missing = prepared.filter((item) => item.embedding === null);
  let generatedVectors: readonly (readonly number[])[] = [];
  let embeddingProviderName = providers.embeddings.providerName;
  let embeddingModelName = providers.embeddings.modelName;

  if (missing.length > 0) {
    if (!options.providersPreflighted) {
      const health = await providers.embeddings.healthCheck(options.signal);
      if (!health.ok || !health.modelAvailable) {
        throw new Error(health.message || `${health.modelName} is not available in Ollama`);
      }
    }
    options.beforeEmbeddingGeneration?.();
    let embedded: Awaited<ReturnType<typeof providers.embeddings.embed>>;
    try {
      embedded = await providers.embeddings.embed({
        inputs: missing.map((item) => item.semanticDocument),
        keepAlive: options.embeddingKeepAlive,
        signal: options.signal,
      });
    } finally {
      options.afterEmbeddingGeneration?.();
    }
    throwIfAborted(options.signal);
    options.onEmbeddingUsage?.(embedded.usage);
    generatedVectors = embedded.value.vectors;
    embeddingProviderName = embedded.providerName;
    embeddingModelName = embedded.modelName;
    const expectedDimensions = expectedEmbeddingDimensions({
      embeddingProviderName,
      embeddingModelName,
      embeddingDimensions: options.embeddingDimensions,
    });
    options.beforeValidation?.("embedding");
    try {
      if (
        embedded.value.dimensions !== expectedDimensions ||
        generatedVectors.length !== missing.length ||
        generatedVectors.some((vector) =>
          vector.length !== expectedDimensions ||
          vector.some((value) => !Number.isFinite(value))
        )
      ) {
        throw new Error(
          `Embedding response did not match the configured ${expectedDimensions}-dimension contract`,
        );
      }
    } finally {
      options.afterValidation?.("embedding");
    }
    if (!options.deferPersistence) {
      await storeEmbeddings(missing.map((item, index) => ({
        listingId: item.listingId,
        providerName: embeddingProviderName,
        modelName: embeddingModelName,
        inputHash: item.semanticHash,
        vector: [...(generatedVectors[index] ?? [])],
      })));
    }
  }

  const completed = await Promise.all(prepared.map(async (item) => {
    const generatedIndex = missing.indexOf(item);
    if (options.deferPersistence && generatedIndex >= 0) {
      const vector = [...(generatedVectors[generatedIndex] ?? [])];
      const pendingEmbedding: PendingEnrichmentEmbedding = Object.freeze({
        id: crypto.randomUUID(),
        listingId: item.listingId,
        providerName: embeddingProviderName,
        modelName: embeddingModelName,
        inputHash: item.semanticHash,
        vector: Object.freeze(vector),
        generatedAt: (options.generatedAt?.() ?? new Date()).toISOString(),
      });
      return {
        extraction: item.extraction,
        semanticDocument: item.semanticDocument,
        embedding: vector,
        embeddingId: pendingEmbedding.id,
        pendingEmbedding,
      };
    }
    const stored = await readExistingEmbedding(
      item.listingId,
      embeddingProviderName,
      embeddingModelName,
      item.semanticHash,
      expectedEmbeddingDimensions({
        embeddingProviderName,
        embeddingModelName,
        embeddingDimensions: options.embeddingDimensions,
      }),
    );
    if (stored === null) {
      throw new Error(`The stored embedding for ${item.listingId} could not be re-read`);
    }
    return {
      extraction: item.extraction,
      semanticDocument: item.semanticDocument,
      embedding: stored.vector,
      embeddingId: stored.embeddingId,
    };
  }));
  return Object.freeze(completed);
}

/** One-row compatibility path; production backlog work uses the staged batch. */
export async function enrichListingText(
  listingId: string,
  detail: NormalizedListingDetail,
  providers: AiProviders = createAiProviders(),
  options: EnrichmentExecutionOptions = {},
): Promise<EnrichmentResult> {
  const prepared = await prepareListingEnrichment(
    listingId,
    detail,
    providers,
    options,
  );
  const [result] = await embedPreparedListingEnrichments(
    [prepared],
    providers,
    options,
  );
  if (!result) throw new Error("Listing enrichment did not return a result");
  return result;
}

async function readExistingExtraction(
  listingId: string,
  providerName: string,
  modelName: string,
  inputHash: string,
  title: string,
  sourceText: string,
  policyCleanupApplied: boolean,
): Promise<{
  artifactId: string;
  outputHash: string;
  extraction: TextExtraction;
  requiresCanonicalRepair: boolean;
} | null> {
  const result = await env.DB.prepare(`
    SELECT id, output_json, output_hash FROM ai_artifacts
    WHERE subject_type = 'listing' AND subject_id = ?
      AND task = 'listing_extraction' AND provider_name = ?
      AND model_name = ? AND prompt_version = ? AND input_hash = ?
    ORDER BY generated_at DESC, id DESC
    LIMIT ${MAX_AI_PROVENANCE_RETRY_READ}
  `).bind(
    listingId,
    providerName,
    modelName,
    EXTRACTION_PROMPT_VERSION,
    inputHash,
  ).all<{ id: string; output_json: string | null; output_hash: string | null }>();
  let repairable: {
    artifactId: string;
    outputHash: string;
    extraction: TextExtraction;
    requiresCanonicalRepair: true;
  } | null = null;
  for (const row of result.results ?? []) {
    if (!row.output_json || !row.output_hash) continue;
    try {
      if (await sha256Text(row.output_json) !== row.output_hash) continue;
      const sourceValue = JSON.parse(row.output_json) as unknown;
      const extraction = validateTextExtraction(sourceValue, {
        title,
        sourceText,
        marketplacePolicyCleanupApplied: policyCleanupApplied,
      });
      const canonicalHash = await sha256Text(JSON.stringify(extraction));
      if (canonicalHash === row.output_hash) {
        return {
          artifactId: row.id,
          outputHash: row.output_hash,
          extraction,
          requiresCanonicalRepair: false,
        };
      }
      if (
        repairable === null &&
        isBoundedCurrentExtractionRepair(
          sourceValue,
          extraction,
          title,
          sourceText,
        )
      ) {
        repairable = {
          artifactId: row.id,
          outputHash: row.output_hash,
          extraction,
          requiresCanonicalRepair: true,
        };
      }
    } catch {
      // Immutable failed attempts remain auditable; continue to an older valid
      // row with the same exact provenance, if one exists.
    }
  }
  return repairable;
}

function isBoundedCurrentExtractionRepair(
  sourceValue: unknown,
  extraction: TextExtraction,
  title: string,
  sourceText: string,
): boolean {
  if (
    !sourceValue ||
    typeof sourceValue !== "object" ||
    Array.isArray(sourceValue)
  ) return false;
  const source = sourceValue as Record<string, unknown>;
  const analyzerRepair = isExplicitSingularAnalyzerSystem(
    { title, shortSummary: extraction.short_summary, sourceText },
    extraction.included_items,
  );
  const opticalRepair = isExplicitSingularOpticalSystem(
    { title, shortSummary: extraction.short_summary, sourceText },
    extraction.included_items,
  );
  const lotRepair =
    (
      source.lot_type === "multi_item_lot" ||
      source.lot_type === "assorted_lot"
    ) &&
    extraction.lot_type === "single_item" &&
    (analyzerRepair || opticalRepair);
  const analyzerDomainRepair =
    analyzerRepair &&
    source.lot_type === extraction.lot_type &&
    source.industry_domain === "electronics" &&
    extraction.industry_domain === "laboratory";
  if (!lotRepair && !analyzerDomainRepair) return false;

  const canonical = extraction as unknown as Record<string, unknown>;
  const sourceKeys = Object.keys(source).sort();
  const canonicalKeys = Object.keys(canonical).sort();
  if (JSON.stringify(sourceKeys) !== JSON.stringify(canonicalKeys)) return false;
  const allowedChanges = analyzerDomainRepair
    ? new Set(["industry_domain", "short_summary"])
    : analyzerRepair
    ? new Set(["included_items", "lot_type", "short_summary"])
    : new Set(["lot_type", "short_summary"]);
  const changedKeys = canonicalKeys.filter((key) =>
    JSON.stringify(source[key]) !== JSON.stringify(canonical[key])
  );
  if (
    (
      lotRepair &&
      !changedKeys.includes("lot_type")
    ) ||
    (
      lotRepair &&
      analyzerRepair &&
      !changedKeys.includes("included_items")
    ) ||
    (
      analyzerDomainRepair &&
      !changedKeys.includes("industry_domain")
    )
  ) return false;
  return canonicalKeys.every((key) =>
    allowedChanges.has(key) ||
    JSON.stringify(source[key]) === JSON.stringify(canonical[key])
  );
}

async function readCompatibleExtraction(
  listingId: string,
  providerName: string,
  modelName: string,
  promptVersion: string,
  inputHash: string,
  title: string,
  sourceText: string,
  policyCleanupApplied: boolean,
): Promise<{
  artifactId: string;
  promptVersion: string;
  inputHash: string;
  outputHash: string;
  extraction: TextExtraction;
} | null> {
  const result = await env.DB.prepare(`
    SELECT id, output_json, output_hash FROM ai_artifacts
    WHERE subject_type = 'listing' AND subject_id = ?
      AND task = 'listing_extraction' AND provider_name = ?
      AND model_name = ? AND prompt_version = ? AND input_hash = ?
    ORDER BY generated_at DESC, id DESC
    LIMIT ${MAX_AI_PROVENANCE_RETRY_READ}
  `).bind(
    listingId,
    providerName,
    modelName,
    promptVersion,
    inputHash,
  ).all<{ id: string; output_json: string | null; output_hash: string | null }>();
  for (const row of result.results ?? []) {
    if (!row.output_json || !row.output_hash) continue;
    try {
      if (await sha256Text(row.output_json) !== row.output_hash) continue;
      return {
        artifactId: row.id,
        promptVersion,
        inputHash,
        outputHash: row.output_hash,
        extraction: validateTextExtraction(JSON.parse(row.output_json), {
          title,
          sourceText,
          marketplacePolicyCleanupApplied: policyCleanupApplied,
        }),
      };
    } catch {
      // Compatible rows are deliberately validator-repaired before being
      // persisted as a canonical current-version artifact.
    }
  }
  return null;
}

async function readExistingSemanticDocument(
  listingId: string,
  providerName: string,
  modelName: string,
  inputHash: string,
  extractionOutputHash: string,
): Promise<{ artifactId: string; semanticDocument: string } | null> {
  const result = await env.DB.prepare(`
    SELECT id, output_text, output_json, output_hash FROM ai_artifacts
    WHERE subject_type = 'listing' AND subject_id = ?
      AND task = 'semantic_document' AND provider_name = ?
      AND model_name = ? AND prompt_version = ?
      AND input_hash = ?
    ORDER BY generated_at DESC, id DESC
    LIMIT ${MAX_AI_PROVENANCE_RETRY_READ}
  `).bind(
    listingId,
    providerName,
    modelName,
    SEMANTIC_DOCUMENT_VERSION,
    inputHash,
  ).all<{
    id: string;
    output_text: string | null;
    output_json: string | null;
    output_hash: string | null;
  }>();
  for (const row of result.results ?? []) {
    if (!row.output_text || !row.output_json || !row.output_hash) continue;
    try {
      const metadata = JSON.parse(row.output_json) as { extractionOutputHash?: unknown };
      if (metadata.extractionOutputHash !== extractionOutputHash) continue;
      if (JSON.stringify({ extractionOutputHash }) !== row.output_json) continue;
      if (row.output_text.trim() !== row.output_text) continue;
      if (await sha256Text(row.output_text) !== row.output_hash) continue;
      return { artifactId: row.id, semanticDocument: row.output_text };
    } catch {
      // Continue past malformed immutable attempts.
    }
  }
  return null;
}

async function readExistingEmbedding(
  listingId: string,
  providerName: string,
  modelName: string,
  inputHash: string,
  expectedDimensions: number,
): Promise<{ embeddingId: string; vector: number[] } | null> {
  const result = await env.DB.prepare(`
    SELECT id, dimensions, vector_json FROM embeddings
    WHERE subject_type = 'listing' AND subject_id = ?
      AND kind = 'listing_semantic_document' AND provider_name = ?
      AND model_name = ? AND input_hash = ?
    ORDER BY generated_at DESC, id DESC
    LIMIT ${MAX_AI_PROVENANCE_RETRY_READ}
  `).bind(listingId, providerName, modelName, inputHash)
    .all<{ id: string; dimensions: number; vector_json: string }>();
  for (const row of result.results ?? []) {
    try {
      const vector = JSON.parse(row.vector_json) as unknown;
      if (
        Array.isArray(vector) && vector.length === expectedDimensions &&
        row.dimensions === expectedDimensions &&
        vector.every((value) => typeof value === "number" && Number.isFinite(value))
      ) return { embeddingId: row.id, vector: vector as number[] };
    } catch {
      // Continue past malformed immutable attempts.
    }
  }
  return null;
}

interface ExactArtifactRow {
  id: string;
  subject_type: string;
  subject_id: string;
  task: string;
  provider_name: string;
  model_name: string;
  prompt_version: string;
  input_hash: string;
  output_text: string | null;
  output_json: string | null;
  output_hash: string | null;
}

async function readArtifactById(artifactId: string): Promise<ExactArtifactRow> {
  const row = await env.DB.prepare(`
    SELECT id, subject_type, subject_id, task, provider_name, model_name,
      prompt_version, input_hash, output_text, output_json, output_hash
    FROM ai_artifacts WHERE id = ?
  `).bind(artifactId).first<ExactArtifactRow>();
  if (row === null) throw new Error(`AI artifact ${artifactId} does not exist`);
  return row;
}

async function readEmbeddingById(input: {
  embeddingId: string;
  listingId: string;
  providerName: string;
  modelName: string;
  inputHash: string;
  expectedDimensions: number;
}): Promise<{ embeddingId: string; vector: number[] }> {
  const row = await env.DB.prepare(`
    SELECT id, subject_type, subject_id, kind, provider_name, model_name,
      input_hash, dimensions, vector_json
    FROM embeddings WHERE id = ?
  `).bind(input.embeddingId).first<{
    id: string;
    subject_type: string;
    subject_id: string;
    kind: string;
    provider_name: string;
    model_name: string;
    input_hash: string;
    dimensions: number;
    vector_json: string;
  }>();
  if (
    row === null || row.subject_type !== "listing" ||
    row.subject_id !== input.listingId ||
    row.kind !== "listing_semantic_document" ||
    row.provider_name !== input.providerName || row.model_name !== input.modelName ||
    row.input_hash !== input.inputHash || row.dimensions !== input.expectedDimensions
  ) throw new Error("The embedding no longer matches the exact enrichment head");
  let vector: unknown;
  try {
    vector = JSON.parse(row.vector_json) as unknown;
  } catch {
    throw new Error("The exact enrichment embedding vector is invalid JSON");
  }
  if (
    !Array.isArray(vector) || vector.length !== input.expectedDimensions ||
    vector.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) throw new Error("The exact enrichment embedding vector is invalid");
  return { embeddingId: row.id, vector: vector as number[] };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("enrichment_cancelled");
  error.name = "AbortError";
  throw error;
}

async function storeOrStageAiArtifact(
  input: PendingEnrichmentArtifactInput,
  pending: PendingEnrichmentArtifact[],
  options: EnrichmentExecutionOptions,
): Promise<string> {
  if (!options.deferPersistence) return storeAiArtifact(input);
  throwIfAborted(options.signal);
  const artifact = Object.freeze({
    ...input,
    outputText: input.outputText ?? null,
    outputJson: input.outputJson ?? null,
    outputHash: input.outputHash ?? null,
    id: crypto.randomUUID(),
    generatedAt: input.generatedAt ??
      (options.generatedAt?.() ?? new Date()).toISOString(),
  });
  pending.push(artifact);
  return artifact.id;
}
