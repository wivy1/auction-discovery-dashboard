import {
  createSequentialEnrichmentProviders,
  type AiProviders,
  type EmbeddingProvider,
  type TextGenerationProvider,
} from "../ai";
import {
  boundedEnrichmentChunks,
  boundedEnrichmentLimit,
  drainEnrichmentSession,
  drainEnrichmentSessionResidency,
  drainStageBatchedEnrichment,
  type EnrichmentBatchSummary,
  type EnrichmentSessionSummary,
} from "../enrichment/backlog";
import {
  EXTRACTION_PROMPT_VERSION,
  SEMANTIC_DOCUMENT_VERSION,
} from "../enrichment/prompt";
import {
  embedPreparedListingEnrichments,
  prepareListingEnrichment,
} from "./enrich";
import {
  readPendingEnrichmentQueue,
  type EnrichmentProvenanceTarget,
} from "./storage";

export interface EnrichmentBacklogOptions {
  originCacheKey: string;
  routeProviderName: string;
  requestedLimit: number;
  providers?: AiProviders;
  /** Explicit contract for custom/test embedding models outside the known map. */
  embeddingDimensions?: number;
  renewLease?: () => Promise<unknown>;
  /** Internal opt-in; the ordinary per-chunk path remains the rollback default. */
  sessionResidency?: boolean;
}

export interface EnrichmentBacklogSessionOptions extends EnrichmentBacklogOptions {
  requestedChunks: number;
  betweenChunks?: (input: {
    readonly completedChunkNumber: number;
    readonly remaining: number;
  }) => Promise<void>;
  beforeTerminalRead?: () => Promise<void>;
}

type PendingEnrichmentQueue = Awaited<
  ReturnType<typeof readPendingEnrichmentQueue>
>;
type PendingEnrichmentCandidate = PendingEnrichmentQueue["candidates"][number];

const TEXT_STAGE_KEEP_ALIVE_SECONDS = 60;

export class EnrichmentBacklogError extends Error {
  readonly listingId: string | null;

  constructor(summary: EnrichmentBatchSummary) {
    const subject = summary.failedItemId
      ? ` for ${summary.failedItemId}`
      : " during a provider batch stage";
    super(`Enrichment backlog circuit opened${subject}: ${summary.errorMessage ?? "unknown error"}`);
    this.name = "EnrichmentBacklogError";
    this.listingId = summary.failedItemId;
  }
}

export function enrichmentProvenanceTarget(
  providers: AiProviders,
  embeddingDimensions?: number,
): EnrichmentProvenanceTarget {
  return {
    textProviderName: providers.text.providerName,
    textModelName: providers.text.modelName,
    extractionPromptVersion: EXTRACTION_PROMPT_VERSION,
    semanticDocumentVersion: SEMANTIC_DOCUMENT_VERSION,
    embeddingProviderName: providers.embeddings.providerName,
    embeddingModelName: providers.embeddings.modelName,
    embeddingDimensions,
  };
}

/** Drains one active-origin batch using exact current model/prompt provenance. */
export async function runEnrichmentBacklog(
  options: EnrichmentBacklogOptions,
): Promise<EnrichmentBatchSummary> {
  return runEnrichmentBacklogSession({
    ...options,
    requestedChunks: 1,
  });
}

/**
 * Reads one exact queue snapshot, then drains immutable slices of at most ten
 * rows while one caller-owned pipeline lease remains live.
 */
export async function runEnrichmentBacklogSession(
  options: EnrichmentBacklogSessionOptions,
): Promise<EnrichmentSessionSummary> {
  const providers = options.providers ?? createSequentialEnrichmentProviders();
  const effectiveLimit = boundedEnrichmentLimit(options.requestedLimit);
  const effectiveChunks = boundedEnrichmentChunks(options.requestedChunks);
  const target = enrichmentProvenanceTarget(
    providers,
    options.embeddingDimensions,
  );
  const readQueue = (limit: number) => readPendingEnrichmentQueue({
    originCacheKey: options.originCacheKey,
    routeProviderName: options.routeProviderName,
    target,
    limit,
  });
  const queue = await readQueue(Math.max(1, effectiveLimit * effectiveChunks));

  if (options.sessionResidency) {
    return runEnrichmentSessionWithResidency({
      options,
      providers,
      candidates: queue.candidates,
      pendingAtStart: queue.pendingAtStart,
      readQueue,
    });
  }

  return drainEnrichmentSession({
    candidates: queue.candidates,
    pendingAtStart: queue.pendingAtStart,
    requestedLimit: options.requestedLimit,
    requestedChunks: options.requestedChunks,
    beforeChunk: async () => {
      await options.renewLease?.();
    },
    runChunk: (chunk) => runEnrichmentCandidateBatch({
      options,
      providers,
      candidates: chunk.candidates,
      pendingAtStart: chunk.pendingAtStart,
    }),
    betweenChunks: async (input) => {
      await options.renewLease?.();
      await options.betweenChunks?.(input);
      await options.renewLease?.();
    },
    beforeTerminalRead: async () => {
      await options.renewLease?.();
      await options.beforeTerminalRead?.();
      await options.renewLease?.();
    },
    readTerminalPending: async () => (await readQueue(1)).pendingAtStart,
  });
}

async function runEnrichmentSessionWithResidency(input: {
  options: EnrichmentBacklogSessionOptions;
  providers: AiProviders;
  candidates: readonly PendingEnrichmentCandidate[];
  pendingAtStart: number;
  readQueue: (limit: number) => ReturnType<typeof readPendingEnrichmentQueue>;
}): Promise<EnrichmentSessionSummary> {
  const { options, providers } = input;
  let textModelUsed = false;
  let embeddingModelUsed = false;

  return drainEnrichmentSessionResidency({
    candidates: input.candidates,
    pendingAtStart: input.pendingAtStart,
    requestedLimit: options.requestedLimit,
    requestedChunks: options.requestedChunks,
    identify: (candidate) => candidate.listingId,
    preflight: async (candidates) => {
      await options.renewLease?.();
      if (candidates.some((candidate) => candidate.needsTextGeneration)) {
        await assertProviderReady(providers.text, "text");
      }
      await assertProviderReady(providers.embeddings, "embedding");
      await options.renewLease?.();
    },
    beforeChunk: async () => {
      await options.renewLease?.();
    },
    beforeEach: async () => {
      await options.renewLease?.();
    },
    afterEach: async () => {
      await options.renewLease?.();
    },
    prepare: async (candidate) => {
      const prepared = await prepareListingEnrichment(
        candidate.listingId,
        candidate.detail,
        providers,
        {
          providersPreflighted: true,
          textKeepAlive: TEXT_STAGE_KEEP_ALIVE_SECONDS,
          beforeTextGeneration: () => {
            textModelUsed = true;
          },
          embeddingDimensions: options.embeddingDimensions,
        },
      );
      textModelUsed ||= prepared.textGenerated;
      return prepared;
    },
    afterPreparationChunk: async () => {
      // Every logical preparation chunk has already persisted its immutable
      // extraction/semantic artifacts before the next chunk may start.
      await options.renewLease?.();
    },
    finishPreparation: async () => {
      if (!textModelUsed) return;
      if (providers.text.providerName === "ollama" && !providers.text.unload) {
        throw new Error("The Ollama text provider cannot explicitly unload its model");
      }
      await providers.text.unload?.();
      await options.renewLease?.();
    },
    beforeBatch: async () => {
      await options.renewLease?.();
    },
    completeBatch: async (prepared) => {
      if (prepared.some((item) => item.value.embedding === null)) {
        // Keep embedding residency across logical chunks. The explicit final
        // cleanup below owns the one unload for the entire session.
        embeddingModelUsed = true;
      }
      await embedPreparedListingEnrichments(
        prepared.map((item) => item.value),
        providers,
        {
          providersPreflighted: true,
          embeddingKeepAlive: TEXT_STAGE_KEEP_ALIVE_SECONDS,
          embeddingDimensions: options.embeddingDimensions,
        },
      );
    },
    afterBatch: async () => {
      await options.renewLease?.();
    },
    finishEmbedding: async () => {
      if (!embeddingModelUsed) return;
      if (providers.embeddings.providerName === "ollama" && !providers.embeddings.unload) {
        throw new Error("The Ollama embedding provider cannot explicitly unload its model");
      }
      await providers.embeddings.unload?.();
      await options.renewLease?.();
    },
    betweenChunks: options.betweenChunks,
    beforeTerminalRead: async () => {
      await options.renewLease?.();
      await options.beforeTerminalRead?.();
      await options.renewLease?.();
    },
    readTerminalPending: async () => (await input.readQueue(1)).pendingAtStart,
  });
}

async function runEnrichmentCandidateBatch(input: {
  options: EnrichmentBacklogOptions;
  providers: AiProviders;
  candidates: readonly PendingEnrichmentCandidate[];
  pendingAtStart: number;
}): Promise<EnrichmentBatchSummary> {
  const { options, providers } = input;
  let textModelUsed = false;

  return drainStageBatchedEnrichment({
    candidates: input.candidates,
    pendingAtStart: input.pendingAtStart,
    requestedLimit: options.requestedLimit,
    identify: (candidate) => candidate.listingId,
    preflight: async (candidates) => {
      await options.renewLease?.();
      if (candidates.some((candidate) => candidate.needsTextGeneration)) {
        await assertProviderReady(providers.text, "text");
      }
      // Every queued row is missing a complete current embedding chain.
      await assertProviderReady(providers.embeddings, "embedding");
      await options.renewLease?.();
    },
    beforeEach: async () => {
      await options.renewLease?.();
    },
    afterEach: async () => {
      await options.renewLease?.();
    },
    prepare: async (candidate) => {
      const prepared = await prepareListingEnrichment(
        candidate.listingId,
        candidate.detail,
        providers,
        {
          providersPreflighted: true,
          textKeepAlive: TEXT_STAGE_KEEP_ALIVE_SECONDS,
          beforeTextGeneration: () => {
            textModelUsed = true;
          },
          embeddingDimensions: options.embeddingDimensions,
        },
      );
      textModelUsed ||= prepared.textGenerated;
      return prepared;
    },
    finishPreparation: async () => {
      if (!textModelUsed) return;
      if (providers.text.providerName === "ollama" && !providers.text.unload) {
        throw new Error("The Ollama text provider cannot explicitly unload its model");
      }
      await providers.text.unload?.();
      await options.renewLease?.();
    },
    beforeBatch: async () => {
      await options.renewLease?.();
    },
    completeBatch: async (prepared) => {
      await embedPreparedListingEnrichments(
        prepared.map((item) => item.value),
        providers,
        {
          providersPreflighted: true,
          embeddingKeepAlive: 0,
          embeddingDimensions: options.embeddingDimensions,
        },
      );
    },
    afterBatch: async () => {
      await options.renewLease?.();
    },
  });
}

async function assertProviderReady(
  provider: TextGenerationProvider | EmbeddingProvider,
  capability: string,
): Promise<void> {
  const health = await provider.healthCheck();
  if (!health.ok || !health.modelAvailable) {
    throw new Error(
      health.message ||
        `Configured ${capability} model ${health.modelName} is unavailable`,
    );
  }
}
