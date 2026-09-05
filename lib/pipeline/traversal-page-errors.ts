import type { SourceId } from "../sources";

export type SourceInventoryTraversalPauseReason =
  | "consecutive_transport_failures"
  | "transport_attempts_exhausted"
  | "metadata_transport_failures"
  | "source_metadata_changed"
  | "checkpoint_batch_complete";

const SOURCE_INVENTORY_TRAVERSAL_PAUSE_CAUSES: Readonly<
  Record<SourceInventoryTraversalPauseReason, string>
> = Object.freeze({
  consecutive_transport_failures:
    "three consecutive retryable transport failures",
  transport_attempts_exhausted:
    "three bounded transport attempts were exhausted",
  metadata_transport_failures:
    "bounded metadata transport attempts were exhausted",
  source_metadata_changed:
    "mutable source metadata required one bounded reconciliation replan",
  checkpoint_batch_complete:
    "one bounded checkpoint batch completed",
});

export function sourceInventoryTraversalPauseMessage(
  sourceId: string,
  reason: SourceInventoryTraversalPauseReason,
): string {
  return `${sourceId} inventory traversal paused after ${SOURCE_INVENTORY_TRAVERSAL_PAUSE_CAUSES[reason]}; durable checkpoints retained`;
}

export function isSourceInventoryTraversalPauseMessage(
  sourceId: string,
  message: string,
): boolean {
  return Object.values(SOURCE_INVENTORY_TRAVERSAL_PAUSE_CAUSES).some((cause) =>
    message ===
      `${sourceId} inventory traversal paused after ${cause}; durable checkpoints retained`
  );
}

/** A retryable, checkpoint-preserving pause with no request or error detail. */
export class SourceInventoryTraversalPausedError extends Error {
  readonly sourceId: SourceId;
  readonly reason: SourceInventoryTraversalPauseReason;

  constructor(
    sourceId: SourceId,
    reason: SourceInventoryTraversalPauseReason,
  ) {
    super(sourceInventoryTraversalPauseMessage(sourceId, reason));
    this.name = "SourceInventoryTraversalPausedError";
    this.sourceId = sourceId;
    this.reason = reason;
  }
}

/**
 * Adds durable traversal context without retaining request URLs, headers, or
 * transport error text that may contain signed values.
 */
export function traversalPageFetchError(
  sourceId: SourceId,
  pageKey: string,
  error: unknown,
): Error {
  const contextualError = new Error(
    `${sourceId} traversal page ${pageKey} fetch failed`,
  );
  if (error instanceof Error && error.name.trim().length > 0) {
    contextualError.name = error.name;
  }
  return contextualError;
}
