import type { SourceInventoryPublicationHead } from "./storage";
import type { SourceId } from "../sources/types";
import type { PerformanceTelemetryBuffer } from "../performance/telemetry";
import { stableContentHash } from "../sources/parsing";

export interface SourcePublicationTransition {
  readonly sourceId: SourceId;
  readonly priorHead: SourceInventoryPublicationHead | null;
  readonly resultingHead: SourceInventoryPublicationHead | null;
  readonly outcome:
    | "published"
    | "preserved_prior"
    | "no_publication"
    | "inconsistent";
  readonly reasonCode:
    | "run_reported_publication"
    | "durable_head_changed"
    | "reported_publication_missing_head"
    | "durable_head_disappeared"
    | "transaction_committed_publication"
    | "completed_without_publication"
    | "partial_without_publication"
    | "failed_without_publication";
}

interface PublicationBearingRun {
  readonly runId: string;
  readonly status: "completed" | "partial" | "failed";
  readonly publishedSourceIds: readonly SourceId[];
  readonly publicationTransitions?: readonly SourcePublicationTransition[];
}

export interface SourcePublicationCampaignVerification {
  readonly transitions: readonly SourcePublicationTransition[];
  readonly commitCarriedSourceIds: readonly SourceId[];
  readonly fallbackSourceIds: readonly SourceId[];
}

/**
 * Executes one source commit between two vector reads so the response carries
 * exact durable publication evidence. The vectors are one query each even for
 * a multi-source browser callback.
 */
export async function runWithSourcePublicationTransitions<
  T extends PublicationBearingRun,
>(input: {
  readonly sourceIds: readonly SourceId[];
  readonly readHeads: () => Promise<readonly SourceInventoryPublicationHead[]>;
  readonly run: () => Promise<T>;
  readonly telemetry?: PerformanceTelemetryBuffer;
}): Promise<T & { readonly publicationTransitions: readonly SourcePublicationTransition[] }> {
  const startedAt = performance.now();
  const sourceIds = uniqueSourceIds(input.sourceIds);
  const priorHeads = await input.readHeads();
  const result = await input.run();
  const resultingHeads = await input.readHeads();
  const publicationTransitions = classifySourcePublicationTransitions({
    sourceIds,
    priorHeads,
    resultingHeads,
    result,
  });
  recordSourcePublicationTransitionTelemetry({
    telemetry: input.telemetry,
    runId: result.runId,
    status: result.status,
    transitions: publicationTransitions,
    durationMs: performance.now() - startedAt,
  });
  return Object.freeze({
    ...result,
    publicationTransitions,
  });
}

export function recordSourcePublicationTransitionTelemetry(input: {
  readonly telemetry?: PerformanceTelemetryBuffer;
  readonly runId: string;
  readonly status: PublicationBearingRun["status"];
  readonly transitions: readonly SourcePublicationTransition[];
  readonly durationMs: number;
}): void {
  for (const transition of input.transitions) {
    input.telemetry?.record({
      context: {
        runId: input.runId,
        sourceId: transition.sourceId,
        publicationId: telemetryHeadIdentity(transition.resultingHead),
        coverageMode: "complete_current",
      },
      details: {
        kind: "publication",
        outcome: transition.outcome === "published"
          ? "published"
          : transition.outcome === "preserved_prior"
          ? "preserved_prior"
          : "failed",
        priorHeadIdentity: telemetryHeadIdentity(transition.priorHead),
        resultingHeadIdentity: telemetryHeadIdentity(transition.resultingHead),
        preservationReasonCode: transition.reasonCode,
      },
    });
  }
  input.telemetry?.record({
    context: { runId: input.runId, coverageMode: "complete_current" },
    details: {
      kind: "stage",
      stage: "source_commit",
      outcome: input.status === "failed" ? "failed" : "completed",
      durationMs: input.durationMs,
      reasonCode: input.status,
    },
  });
}

function telemetryHeadIdentity(
  head: SourceInventoryPublicationHead | null,
): string | null {
  return head === null
    ? null
    : `head:${stableContentHash({
        sourceId: head.sourceId,
        inventoryRunId: head.inventoryRunId,
        publishedAt: head.publishedAt,
        listingCount: head.listingCount,
      })}`;
}

export function classifySourcePublicationTransitions(input: {
  readonly sourceIds: readonly SourceId[];
  readonly priorHeads: readonly SourceInventoryPublicationHead[];
  readonly resultingHeads: readonly SourceInventoryPublicationHead[];
  readonly result: PublicationBearingRun;
}): readonly SourcePublicationTransition[] {
  const sourceIds = uniqueSourceIds(input.sourceIds);
  const prior = headMap(input.priorHeads);
  const resulting = headMap(input.resultingHeads);
  const reported = new Set(input.result.publishedSourceIds);
  return Object.freeze(sourceIds.map((sourceId) => {
    const priorHead = prior.get(sourceId) ?? null;
    const resultingHead = resulting.get(sourceId) ?? null;
    const changed = !samePublicationHead(priorHead, resultingHead);
    if (reported.has(sourceId) && resultingHead === null) {
      return Object.freeze({
        sourceId,
        priorHead,
        resultingHead,
        outcome: "inconsistent" as const,
        reasonCode: "reported_publication_missing_head" as const,
      });
    }
    if (priorHead !== null && resultingHead === null) {
      return Object.freeze({
        sourceId,
        priorHead,
        resultingHead,
        outcome: "inconsistent" as const,
        reasonCode: "durable_head_disappeared" as const,
      });
    }
    if (reported.has(sourceId) || changed) {
      return Object.freeze({
        sourceId,
        priorHead,
        resultingHead,
        outcome: "published" as const,
        reasonCode: reported.has(sourceId)
          ? "run_reported_publication" as const
          : "durable_head_changed" as const,
      });
    }
    const reasonCode = input.result.status === "completed"
      ? "completed_without_publication" as const
      : input.result.status === "partial"
      ? "partial_without_publication" as const
      : "failed_without_publication" as const;
    return Object.freeze({
      sourceId,
      priorHead,
      resultingHead,
      outcome: priorHead === null
        ? "no_publication" as const
        : "preserved_prior" as const,
      reasonCode,
    });
  }));
}

/**
 * Verifies one complete scheduler campaign from its two vector reads. Exact
 * commit-carried transitions are accepted only when they chain from the
 * campaign-start head to the terminal durable head. A missing or contradictory
 * transition falls back to the two campaign vectors without trusting a
 * callback's publication claim.
 */
export function verifySourcePublicationCampaign(input: {
  readonly sourceIds: readonly SourceId[];
  readonly priorHeads: readonly SourceInventoryPublicationHead[];
  readonly resultingHeads: readonly SourceInventoryPublicationHead[];
  readonly result: PublicationBearingRun;
}): SourcePublicationCampaignVerification {
  const sourceIds = uniqueSourceIds(input.sourceIds);
  const prior = headMap(input.priorHeads);
  const resulting = headMap(input.resultingHeads);
  const carriedBySource = new Map<SourceId, SourcePublicationTransition[]>();
  const ambiguousSources = new Set<SourceId>();
  for (const transition of input.result.publicationTransitions ?? []) {
    if (!sourceIds.includes(transition.sourceId)) {
      ambiguousSources.add(transition.sourceId);
      continue;
    }
    const carried = carriedBySource.get(transition.sourceId) ?? [];
    carried.push(transition);
    carriedBySource.set(transition.sourceId, carried);
  }

  const commitCarriedSourceIds: SourceId[] = [];
  const fallbackSourceIds: SourceId[] = [];
  const transitions = sourceIds.map((sourceId) => {
    const priorHead = prior.get(sourceId) ?? null;
    const resultingHead = resulting.get(sourceId) ?? null;
    const carried = carriedBySource.get(sourceId) ?? [];
    const terminalChanged = !samePublicationHead(priorHead, resultingHead);
    const reported = input.result.publishedSourceIds.includes(sourceId);
    let chainedHead = priorHead;
    const carriedIsExact = !ambiguousSources.has(sourceId) &&
      carried.length > 0 &&
      carried.every((transition) => {
        if (
          transition.outcome !== "published" ||
          transition.reasonCode !== "transaction_committed_publication" ||
          transition.resultingHead === null ||
          !samePublicationHead(transition.priorHead, chainedHead)
        ) return false;
        chainedHead = transition.resultingHead;
        return true;
      }) &&
      samePublicationHead(chainedHead, resultingHead);
    if (carriedIsExact) {
      commitCarriedSourceIds.push(sourceId);
      const last = carried[carried.length - 1]!;
      return carried.length === 1
        ? last
        : Object.freeze({ ...last, priorHead });
    }

    if (carried.length > 0 || reported || terminalChanged) {
      fallbackSourceIds.push(sourceId);
    }
    return classifySourcePublicationTransitions({
      sourceIds: [sourceId],
      priorHeads: priorHead === null ? [] : [priorHead],
      resultingHeads: resultingHead === null ? [] : [resultingHead],
      result: {
        runId: input.result.runId,
        status: input.result.status,
        // Ambiguous callback claims must not override the terminal vector.
        publishedSourceIds: [],
      },
    })[0]!;
  });

  return Object.freeze({
    transitions: Object.freeze(transitions),
    commitCarriedSourceIds: Object.freeze(commitCarriedSourceIds),
    fallbackSourceIds: Object.freeze(fallbackSourceIds),
  });
}

export function samePublicationHead(
  left: SourceInventoryPublicationHead | null,
  right: SourceInventoryPublicationHead | null,
): boolean {
  return left === null
    ? right === null
    : right !== null &&
      left.sourceId === right.sourceId &&
      left.inventoryRunId === right.inventoryRunId &&
      left.publishedAt === right.publishedAt &&
      left.listingCount === right.listingCount;
}

function headMap(
  heads: readonly SourceInventoryPublicationHead[],
): ReadonlyMap<SourceId, SourceInventoryPublicationHead> {
  const result = new Map<SourceId, SourceInventoryPublicationHead>();
  for (const head of heads) {
    if (result.has(head.sourceId)) {
      throw new Error(`duplicate publication head for ${head.sourceId}`);
    }
    result.set(head.sourceId, head);
  }
  return result;
}

function uniqueSourceIds(sourceIds: readonly SourceId[]): readonly SourceId[] {
  const result = [...new Set(sourceIds)];
  if (result.length !== sourceIds.length || result.length < 1) {
    throw new Error("publication transition sources must be nonempty and unique");
  }
  return Object.freeze(result);
}
