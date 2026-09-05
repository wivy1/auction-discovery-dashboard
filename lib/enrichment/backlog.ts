import { isAiProviderError } from "../ai/errors";

export const MAX_ENRICHMENT_BATCH_SIZE = 10;
export const MAX_ENRICHMENT_CHUNKS_PER_REQUEST = 10;

/**
 * A provider contract failure describes the shared generation boundary, not
 * the listing that happened to be processed when the provider rejected its
 * output. It must therefore never enter the listing-specific terminal
 * fallback path.
 */
export type EnrichmentFailureClassification =
  | "listing_specific"
  | "systemic_provider_contract";

export function classifyEnrichmentFailure(
  error: unknown,
): EnrichmentFailureClassification {
  return isAiProviderError(error) &&
      (error.code === "invalid_response" || error.code === "validation_failed")
    ? "systemic_provider_contract"
    : "listing_specific";
}

export interface EnrichmentBatchSummary {
  requestedLimit: number;
  effectiveLimit: number;
  pendingAtStart: number;
  attempted: number;
  completed: number;
  failures: number;
  remaining: number;
  circuitOpen: boolean;
  failedItemId: string | null;
  errorMessage: string | null;
  /** Present when the session stopped on a classified provider/listing error. */
  failureClassification?: EnrichmentFailureClassification;
}

export interface EnrichmentSessionSummary extends EnrichmentBatchSummary {
  requestedChunks: number;
  effectiveChunks: number;
  chunksAttempted: number;
  chunksCompleted: number;
  terminalReadPerformed: boolean;
}

export class EnrichmentCancelledError extends Error {
  readonly code = "enrichment_cancelled" as const;

  constructor() {
    super("enrichment_cancelled");
    this.name = "EnrichmentCancelledError";
  }
}

export function throwIfEnrichmentCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new EnrichmentCancelledError();
}

export function isEnrichmentCancelled(error: unknown): boolean {
  return error instanceof EnrichmentCancelledError ||
    (error instanceof Error && error.name === "AbortError");
}

export interface EnrichmentSessionChunk<T> {
  readonly chunkNumber: number;
  readonly candidates: readonly T[];
  readonly pendingAtStart: number;
}

export interface EnrichmentResidencyChunk<T, P>
  extends EnrichmentSessionChunk<T> {
  readonly prepared: readonly { candidate: T; value: P }[];
}

export function boundedEnrichmentLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, MAX_ENRICHMENT_BATCH_SIZE);
}

export function boundedEnrichmentChunks(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) return 0;
  return Math.min(value, MAX_ENRICHMENT_CHUNKS_PER_REQUEST);
}

/**
 * Runs several immutable model batches from one already validated queue
 * snapshot. Each callback receives at most MAX_ENRICHMENT_BATCH_SIZE rows.
 * A fresh exact queue read is mandatory before this helper can report zero.
 */
export async function drainEnrichmentSession<T>(input: {
  candidates: readonly T[];
  pendingAtStart: number;
  requestedLimit: number;
  requestedChunks: number;
  beforeChunk?: (chunk: EnrichmentSessionChunk<T>) => Promise<void>;
  runChunk: (
    chunk: EnrichmentSessionChunk<T>,
  ) => Promise<EnrichmentBatchSummary>;
  betweenChunks?: (input: {
    readonly completedChunkNumber: number;
    readonly remaining: number;
  }) => Promise<void>;
  beforeTerminalRead?: () => Promise<void>;
  readTerminalPending: () => Promise<number>;
}): Promise<EnrichmentSessionSummary> {
  const effectiveLimit = boundedEnrichmentLimit(input.requestedLimit);
  const effectiveChunks = boundedEnrichmentChunks(input.requestedChunks);
  const capacity = effectiveLimit * effectiveChunks;
  const selected = Object.freeze(input.candidates.slice(0, capacity));
  const pendingAtStart = Math.max(
    selected.length,
    Number.isSafeInteger(input.pendingAtStart) && input.pendingAtStart > 0
      ? input.pendingAtStart
      : 0,
  );
  let attempted = 0;
  let completed = 0;
  let failures = 0;
  let remaining = pendingAtStart;
  let circuitOpen = false;
  let failedItemId: string | null = null;
  let errorMessage: string | null = null;
  let failureClassification: EnrichmentFailureClassification | undefined;
  let chunksAttempted = 0;
  let chunksCompleted = 0;
  let terminalReadPerformed = false;

  const fail = (error: unknown, listingId: string | null = null) => {
    failureClassification = classifyEnrichmentFailure(error);
    failures = 1;
    circuitOpen = true;
    failedItemId = failureClassification === "systemic_provider_contract"
      ? null
      : listingId;
    errorMessage = safeErrorMessage(error);
  };

  for (
    let offset = 0;
    offset < selected.length && chunksAttempted < effectiveChunks;
    offset += effectiveLimit
  ) {
    const candidates = Object.freeze(
      selected.slice(offset, offset + effectiveLimit),
    );
    const chunk: EnrichmentSessionChunk<T> = Object.freeze({
      chunkNumber: chunksAttempted + 1,
      candidates,
      pendingAtStart: remaining,
    });
    try {
      await input.beforeChunk?.(chunk);
    } catch (error) {
      fail(error);
      break;
    }

    chunksAttempted += 1;
    let summary: EnrichmentBatchSummary;
    try {
      summary = await input.runChunk(chunk);
    } catch (error) {
      fail(error);
      break;
    }
    attempted += summary.attempted;
    completed += summary.completed;
    remaining = Math.max(0, pendingAtStart - completed);
    if (summary.circuitOpen || summary.failures > 0) {
      failures = 1;
      circuitOpen = true;
      failedItemId = summary.failedItemId;
      errorMessage = summary.errorMessage;
      failureClassification = summary.failureClassification;
      break;
    }
    if (summary.completed !== candidates.length) {
      fail(new Error(
        `Enrichment chunk ${chunk.chunkNumber} completed ${summary.completed} of ${candidates.length} rows without opening its circuit`,
      ));
      break;
    }

    chunksCompleted += 1;
    const hasAnotherSelectedChunk = offset + effectiveLimit < selected.length;
    if (hasAnotherSelectedChunk && input.betweenChunks) {
      try {
        await input.betweenChunks({
          completedChunkNumber: chunk.chunkNumber,
          remaining,
        });
      } catch (error) {
        fail(error);
        break;
      }
    }
  }

  if (!circuitOpen && remaining === 0) {
    try {
      await input.beforeTerminalRead?.();
      const terminalPending = await input.readTerminalPending();
      if (!Number.isSafeInteger(terminalPending) || terminalPending < 0) {
        throw new Error("The terminal enrichment queue read returned an invalid count");
      }
      terminalReadPerformed = true;
      remaining = terminalPending;
    } catch (error) {
      fail(error);
    }
  }

  return {
    requestedLimit: input.requestedLimit,
    effectiveLimit,
    requestedChunks: input.requestedChunks,
    effectiveChunks,
    chunksAttempted,
    chunksCompleted,
    terminalReadPerformed,
    pendingAtStart,
    attempted,
    completed,
    failures,
    remaining,
    circuitOpen,
    failedItemId,
    errorMessage,
    failureClassification,
  };
}

/**
 * Runs one bounded session as two ordered model stages. Text preparation spans
 * every selected logical chunk, then embedding commits those chunks one at a
 * time. The callbacks own provider residency and must unload each model before
 * the next model stage is entered. Preparation writes remain durable when a
 * later preparation or embedding chunk fails, so the next session can resume
 * from the exact incomplete chain.
 */
export async function drainEnrichmentSessionResidency<T, P>(input: {
  candidates: readonly T[];
  pendingAtStart: number;
  requestedLimit: number;
  requestedChunks: number;
  /**
   * Maximum simultaneous text preparations within one logical chunk. Defaults
   * to one and is capped by the ten-row enrichment batch limit.
   */
  preparationConcurrency?: number | (() => number);
  /** Cancels admission and commit without converting the claim into a failure. */
  signal?: AbortSignal;
  identify: (candidate: T) => string;
  preflight?: (candidates: readonly T[]) => Promise<void>;
  beforeChunk?: (chunk: EnrichmentSessionChunk<T>) => Promise<void>;
  beforeEach?: (candidate: T) => Promise<void>;
  prepare: (candidate: T) => Promise<P>;
  afterEach?: (candidate: T) => Promise<void>;
  afterPreparationChunk?: (input: {
    readonly completedChunkNumber: number;
    readonly prepared: readonly { candidate: T; value: P }[];
  }) => Promise<void>;
  finishPreparation?: () => Promise<void>;
  beforeBatch?: (input: {
    readonly chunk: EnrichmentResidencyChunk<T, P>;
  }) => Promise<void>;
  completeBatch: (
    prepared: readonly { candidate: T; value: P }[],
    input: { readonly chunk: EnrichmentResidencyChunk<T, P> },
  ) => Promise<void>;
  afterBatch?: (input: {
    readonly chunk: EnrichmentResidencyChunk<T, P>;
  }) => Promise<void>;
  finishEmbedding?: () => Promise<void>;
  betweenChunks?: (input: {
    readonly completedChunkNumber: number;
    readonly remaining: number;
  }) => Promise<void>;
  beforeTerminalRead?: () => Promise<void>;
  readTerminalPending: () => Promise<number>;
}): Promise<EnrichmentSessionSummary> {
  const effectiveLimit = boundedEnrichmentLimit(input.requestedLimit);
  const effectiveChunks = boundedEnrichmentChunks(input.requestedChunks);
  let preparationConcurrency = 1;
  const capacity = effectiveLimit * effectiveChunks;
  const selected = Object.freeze(input.candidates.slice(0, capacity));
  const pendingAtStart = Math.max(
    selected.length,
    Number.isSafeInteger(input.pendingAtStart) && input.pendingAtStart > 0
      ? input.pendingAtStart
      : 0,
  );
  let attempted = 0;
  let completed = 0;
  let failures = 0;
  let remaining = pendingAtStart;
  let circuitOpen = false;
  let failedItemId: string | null = null;
  let errorMessage: string | null = null;
  let failureClassification: EnrichmentFailureClassification | undefined;
  let chunksAttempted = 0;
  let chunksCompleted = 0;
  let terminalReadPerformed = false;
  let preparationStarted = false;

  const fail = (error: unknown, candidate?: T) => {
    failureClassification = classifyEnrichmentFailure(error);
    failures = 1;
    circuitOpen = true;
    failedItemId = failureClassification === "systemic_provider_contract"
      ? null
      : candidate === undefined ? null : input.identify(candidate);
    errorMessage = safeErrorMessage(error);
  };

  const appendCleanupFailure = (error: unknown, label: string) => {
    const cleanupMessage = safeErrorMessage(error);
    errorMessage = `${errorMessage ?? label}; cleanup failed: ${cleanupMessage}`
      .slice(0, 500);
    failures = 1;
    circuitOpen = true;
  };

  const preparedChunks: Array<EnrichmentResidencyChunk<T, P>> = [];

  if (selected.length > 0 && input.preflight) {
    try {
      throwIfEnrichmentCancelled(input.signal);
      await input.preflight(selected);
      throwIfEnrichmentCancelled(input.signal);
    } catch (error) {
      fail(error);
    }
  }

  const requestedPreparationConcurrency = typeof input.preparationConcurrency ===
      "function"
    ? input.preparationConcurrency()
    : input.preparationConcurrency;
  preparationConcurrency = Number.isSafeInteger(requestedPreparationConcurrency) &&
      (requestedPreparationConcurrency ?? 0) > 0
    ? Math.min(requestedPreparationConcurrency!, MAX_ENRICHMENT_BATCH_SIZE)
    : 1;

  if (!circuitOpen) {
    try {
      for (
        let offset = 0;
        offset < selected.length && chunksAttempted < effectiveChunks;
        offset += effectiveLimit
      ) {
        const candidates = Object.freeze(
          selected.slice(offset, offset + effectiveLimit),
        );
        const chunk: EnrichmentSessionChunk<T> = Object.freeze({
          chunkNumber: chunksAttempted + 1,
          candidates,
          pendingAtStart: Math.max(0, pendingAtStart - completed),
        });
        try {
          throwIfEnrichmentCancelled(input.signal);
          await input.beforeChunk?.(chunk);
          throwIfEnrichmentCancelled(input.signal);
        } catch (error) {
          fail(error);
          break;
        }

        chunksAttempted += 1;
        preparationStarted = true;
        const preparedByIndex: Array<
          { candidate: T; value: P } | undefined
        > = new Array(candidates.length);
        let nextCandidateIndex = 0;
        let preparationFailure:
          | { readonly error: unknown; readonly candidate: T }
          | null = null;
        const prepareNext = async () => {
          while (preparationFailure === null) {
            try {
              throwIfEnrichmentCancelled(input.signal);
            } catch (error) {
              if (preparationFailure === null) {
                preparationFailure = {
                  error,
                  candidate: candidates[Math.min(
                    nextCandidateIndex,
                    candidates.length - 1,
                  )]!,
                };
              }
              return;
            }
            const candidateIndex = nextCandidateIndex;
            if (candidateIndex >= candidates.length) return;
            nextCandidateIndex += 1;
            const candidate = candidates[candidateIndex]!;
            attempted += 1;
            try {
              await input.beforeEach?.(candidate);
              throwIfEnrichmentCancelled(input.signal);
              const value = await input.prepare(candidate);
              throwIfEnrichmentCancelled(input.signal);
              await input.afterEach?.(candidate);
              throwIfEnrichmentCancelled(input.signal);
              preparedByIndex[candidateIndex] = { candidate, value };
            } catch (error) {
              if (preparationFailure === null) {
                preparationFailure = { error, candidate };
              }
              return;
            }
          }
        };
        await Promise.all(
          Array.from(
            {
              length: Math.min(preparationConcurrency, candidates.length),
            },
            () => prepareNext(),
          ),
        );
        const settledPreparationFailure = preparationFailure as {
          readonly error: unknown;
          readonly candidate: T;
        } | null;
        if (settledPreparationFailure !== null) {
          fail(
            settledPreparationFailure.error,
            settledPreparationFailure.candidate,
          );
        }
        if (circuitOpen) break;

        const prepared = preparedByIndex as Array<{
          candidate: T;
          value: P;
        }>;

        const preparedChunk: EnrichmentResidencyChunk<T, P> = Object.freeze({
          chunkNumber: chunk.chunkNumber,
          candidates,
          pendingAtStart: chunk.pendingAtStart,
          prepared: Object.freeze(prepared),
        });
        preparedChunks.push(preparedChunk);
        try {
          throwIfEnrichmentCancelled(input.signal);
          await input.afterPreparationChunk?.({
            completedChunkNumber: chunk.chunkNumber,
            prepared: preparedChunk.prepared,
          });
        } catch (error) {
          fail(error);
          break;
        }
      }
    } finally {
      if (preparationStarted) {
        try {
          await input.finishPreparation?.();
        } catch (error) {
          if (!circuitOpen) {
            fail(error);
          } else {
            appendCleanupFailure(error, "Enrichment preparation failed");
          }
        }
      }
    }
  }

  if (!circuitOpen && preparedChunks.length > 0) {
    let embeddingStageStarted = false;
    try {
          for (const preparedChunk of preparedChunks) {
        embeddingStageStarted = true;
        try {
          throwIfEnrichmentCancelled(input.signal);
          await input.beforeBatch?.({ chunk: preparedChunk });
          throwIfEnrichmentCancelled(input.signal);
          await input.completeBatch(preparedChunk.prepared, {
            chunk: preparedChunk,
          });
          throwIfEnrichmentCancelled(input.signal);
          completed += preparedChunk.prepared.length;
          chunksCompleted += 1;
          remaining = Math.max(0, pendingAtStart - completed);
          await input.afterBatch?.({ chunk: preparedChunk });
        } catch (error) {
          fail(error);
          break;
        }

        if (preparedChunk.chunkNumber < preparedChunks.length) {
          try {
            await input.betweenChunks?.({
              completedChunkNumber: preparedChunk.chunkNumber,
              remaining,
            });
          } catch (error) {
            fail(error);
            break;
          }
        }
      }
    } finally {
      if (embeddingStageStarted) {
        try {
          await input.finishEmbedding?.();
        } catch (error) {
          if (!circuitOpen) {
            fail(error);
          } else {
            appendCleanupFailure(error, "Enrichment embedding failed");
          }
        }
      }
    }
  }

  if (!circuitOpen && remaining === 0) {
    try {
      throwIfEnrichmentCancelled(input.signal);
      await input.beforeTerminalRead?.();
      throwIfEnrichmentCancelled(input.signal);
      const terminalPending = await input.readTerminalPending();
      if (!Number.isSafeInteger(terminalPending) || terminalPending < 0) {
        throw new Error("The terminal enrichment queue read returned an invalid count");
      }
      terminalReadPerformed = true;
      remaining = terminalPending;
    } catch (error) {
      fail(error);
    }
  }

  return {
    requestedLimit: input.requestedLimit,
    effectiveLimit,
    requestedChunks: input.requestedChunks,
    effectiveChunks,
    chunksAttempted,
    chunksCompleted,
    terminalReadPerformed,
    pendingAtStart,
    attempted,
    completed,
    failures,
    remaining,
    circuitOpen,
    failedItemId,
    errorMessage,
    failureClassification,
  };
}

/**
 * Re-score the corpus only after a bounded enrichment drain reaches a clean
 * boundary. Rebuilding after every intermediate batch amplifies profile,
 * score, and explanation history quadratically as the backlog grows.
 */
export function shouldFinalizeEnrichmentProfile(
  remaining: number | null,
): boolean {
  return remaining !== null && remaining <= 0;
}

/**
 * A saved operator correction should not wait behind unrelated listing text.
 * Its reconciliation is still confined to an explicit enrichment run, but it
 * may rebuild the profile from already stored artifacts before the backlog is
 * otherwise empty.
 */
export function shouldReconcileEnrichmentProfile(
  remaining: number | null,
  feedbackMismatch: boolean,
): boolean {
  return feedbackMismatch || shouldFinalizeEnrichmentProfile(remaining);
}

/**
 * Runs a deterministic batch with at most one active operation. The first
 * provider or validation failure opens the batch circuit and leaves every
 * remaining item deferred for the next invocation.
 */
export async function drainSequentialEnrichment<T>(input: {
  candidates: readonly T[];
  pendingAtStart: number;
  requestedLimit: number;
  identify: (candidate: T) => string;
  preflight?: (candidates: readonly T[]) => Promise<void>;
  beforeEach?: (candidate: T) => Promise<void>;
  afterEach?: (candidate: T) => Promise<void>;
  enrich: (candidate: T) => Promise<void>;
}): Promise<EnrichmentBatchSummary> {
  const effectiveLimit = boundedEnrichmentLimit(input.requestedLimit);
  const selected = input.candidates.slice(0, effectiveLimit);
  const pendingAtStart = Math.max(
    selected.length,
    Number.isSafeInteger(input.pendingAtStart) && input.pendingAtStart > 0
      ? input.pendingAtStart
      : 0,
  );
  let attempted = 0;
  let completed = 0;
  let failures = 0;
  let circuitOpen = false;
  let failedItemId: string | null = null;
  let errorMessage: string | null = null;
  let failureClassification: EnrichmentFailureClassification | undefined;

  if (selected.length > 0 && input.preflight) {
    try {
      await input.preflight(selected);
    } catch (error) {
      failureClassification = classifyEnrichmentFailure(error);
      failures = 1;
      circuitOpen = true;
      errorMessage = safeErrorMessage(error);
    }
  }

  if (!circuitOpen) {
    for (const candidate of selected) {
      attempted += 1;
      try {
        await input.beforeEach?.(candidate);
        await input.enrich(candidate);
        completed += 1;
        await input.afterEach?.(candidate);
      } catch (error) {
        failureClassification = classifyEnrichmentFailure(error);
        failures = 1;
        circuitOpen = true;
        failedItemId = failureClassification === "systemic_provider_contract"
          ? null
          : input.identify(candidate);
        errorMessage = safeErrorMessage(error);
        break;
      }
    }
  }

  return {
    requestedLimit: input.requestedLimit,
    effectiveLimit,
    pendingAtStart,
    attempted,
    completed,
    failures,
    remaining: Math.max(0, pendingAtStart - completed),
    circuitOpen,
    failedItemId,
    errorMessage,
    failureClassification,
  };
}

/**
 * Runs a bounded two-stage batch. Preparation stays sequential; only after the
 * preparation stage has ended cleanly does one batch completion operation run.
 * This lets local AI group text work under one model residency and then switch
 * once to a multi-input embedding request.
 */
export async function drainStageBatchedEnrichment<T, P>(input: {
  candidates: readonly T[];
  pendingAtStart: number;
  requestedLimit: number;
  identify: (candidate: T) => string;
  preflight?: (candidates: readonly T[]) => Promise<void>;
  beforeEach?: (candidate: T) => Promise<void>;
  prepare: (candidate: T) => Promise<P>;
  afterEach?: (candidate: T) => Promise<void>;
  finishPreparation?: () => Promise<void>;
  beforeBatch?: () => Promise<void>;
  completeBatch: (
    prepared: readonly { candidate: T; value: P }[],
  ) => Promise<void>;
  afterBatch?: () => Promise<void>;
}): Promise<EnrichmentBatchSummary> {
  const effectiveLimit = boundedEnrichmentLimit(input.requestedLimit);
  const selected = input.candidates.slice(0, effectiveLimit);
  const pendingAtStart = Math.max(
    selected.length,
    Number.isSafeInteger(input.pendingAtStart) && input.pendingAtStart > 0
      ? input.pendingAtStart
      : 0,
  );
  const prepared: Array<{ candidate: T; value: P }> = [];
  let attempted = 0;
  let completed = 0;
  let failures = 0;
  let circuitOpen = false;
  let failedItemId: string | null = null;
  let errorMessage: string | null = null;
  let failureClassification: EnrichmentFailureClassification | undefined;

  const fail = (error: unknown, candidate?: T) => {
    failureClassification = classifyEnrichmentFailure(error);
    failures = 1;
    circuitOpen = true;
    failedItemId = failureClassification === "systemic_provider_contract"
      ? null
      : candidate === undefined ? null : input.identify(candidate);
    errorMessage = safeErrorMessage(error);
  };

  if (selected.length > 0 && input.preflight) {
    try {
      await input.preflight(selected);
    } catch (error) {
      fail(error);
    }
  }

  if (!circuitOpen) {
    try {
      for (const candidate of selected) {
        attempted += 1;
        try {
          await input.beforeEach?.(candidate);
          prepared.push({ candidate, value: await input.prepare(candidate) });
          await input.afterEach?.(candidate);
        } catch (error) {
          fail(error, candidate);
          break;
        }
      }
    } finally {
      try {
        await input.finishPreparation?.();
      } catch (error) {
        if (!circuitOpen) {
          fail(error);
        } else {
          errorMessage = `${errorMessage ?? "Enrichment preparation failed"}; cleanup failed: ${safeErrorMessage(error)}`
            .slice(0, 500);
        }
      }
    }
  }

  if (!circuitOpen && prepared.length > 0) {
    try {
      await input.beforeBatch?.();
      await input.completeBatch(prepared);
      completed = prepared.length;
      await input.afterBatch?.();
    } catch (error) {
      fail(error);
    }
  }

  return {
    requestedLimit: input.requestedLimit,
    effectiveLimit,
    pendingAtStart,
    attempted,
    completed,
    failures,
    remaining: Math.max(0, pendingAtStart - completed),
    circuitOpen,
    failedItemId,
    errorMessage,
    failureClassification,
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown enrichment error";
  return message.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) ||
    "Unknown enrichment error";
}
