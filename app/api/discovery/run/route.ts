import { env } from "cloudflare:workers";
import { jsonError, readJson } from "../../../../lib/http";
import { ensureDatabase } from "../../../../db/bootstrap";
import { runAuctionDiscovery } from "../../../../lib/pipeline/discovery";
import {
  DiscoveryRunBusyError,
  readSourceInventoryPublicationHead,
  readSourceInventorySemanticPublicationHeads,
  readRetainedSourceInventoryTraversalStates,
  readSourceInventoryTraversalPages,
} from "../../../../lib/pipeline/storage";
import { recordSourcePublicationTransitionTelemetry } from "../../../../lib/pipeline/publication-transition";
import type { PerformanceTelemetryBuffer } from "../../../../lib/performance/telemetry";
import { hashCanonicalJson } from "../../../../lib/performance/generations";
import {
  createTransportPerformanceTelemetryBuffer,
  drainTransportPerformanceTelemetry,
} from "../../../../lib/performance/telemetry-transport";
import { findSourceAdapter } from "../../../../lib/sources";
import { inspectSourceAccessStates } from "../../../../lib/sources/access-state";
import { SOURCE_DOCUMENT_ACCESS_LANE } from "../../../../lib/sources/acquisition-access";
import { sourceOrchestrationRegistry } from "../../../../lib/sources/orchestration";
import { assertMatchingLoadedRuntimeRevision } from
  "../../../../lib/runtime-revision-request";

export const dynamic = "force-dynamic";

function requestedSourceId(value: unknown) {
  if (typeof value !== "string") return null;
  return findSourceAdapter(value)?.manifest.id ?? null;
}

async function readCanonicalContinuationProgressVector() {
  const [publicationHeads, retainedTraversals, access] = await Promise.all([
    readSourceInventorySemanticPublicationHeads(),
    readRetainedSourceInventoryTraversalStates(),
    inspectSourceAccessStates({
      database: env.DB,
      laneKey: SOURCE_DOCUMENT_ACCESS_LANE,
      limit: 500,
    }),
  ]);
  if (access.counts.truncated !== 0) {
    throw new Error("Canonical continuation document-access evidence was truncated.");
  }
  const publicationHeadsBySource = new Map(
    publicationHeads.map((head) => [head.sourceId, head]),
  );
  const registeredSourceIds: ReadonlySet<string> = new Set(
    sourceOrchestrationRegistry.map(({ sourceId }) => sourceId),
  );
  const traversalsBySource = new Map<string, (typeof retainedTraversals)[number]>();
  for (const state of retainedTraversals) {
    if (
      !registeredSourceIds.has(state.sourceId) ||
      traversalsBySource.has(state.sourceId)
    ) {
      throw new Error(
        `${state.sourceId} continuation progress traversal selection is inconsistent.`,
      );
    }
    traversalsBySource.set(state.sourceId, state);
  }
  const documentAccessStops = access.rows
    .filter((row) =>
      registeredSourceIds.has(row.sourceId) &&
      !row.effectiveEligible &&
      (row.state === "cooldown" || row.state === "manual_reset_required")
    )
    .map((row) => ({
      sourceId: row.sourceId,
      state: row.state,
      reasonCode: row.reasonCode,
      nextEligibleAt: row.nextEligibleAt,
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  const sources = await Promise.all(sourceOrchestrationRegistry.map(async ({ sourceId }) => {
    const state = traversalsBySource.get(sourceId) ?? null;
    if (state === null) {
      return {
        sourceId,
        publicationHead: publicationHeadsBySource.get(sourceId) ?? null,
        traversal: null,
      };
    }
    const pages = await readSourceInventoryTraversalPages(state.traversalId);
    const completedPages = pages.filter(({ completed }) => completed);
    if (
      pages.length !== state.expectedPages ||
      completedPages.length !== state.completedPages ||
      state.completed !== (completedPages.length === state.expectedPages)
    ) {
      throw new Error(
        `${sourceId} continuation progress traversal checkpoints are inconsistent.`,
      );
    }
    const completedCheckpointHashes = await Promise.all(
      completedPages.map(({ key }) =>
        hashCanonicalJson({ sourceId, traversalId: state.traversalId, pageKey: key })
      ),
    );
    completedCheckpointHashes.sort();
    return {
      sourceId,
      publicationHead: publicationHeadsBySource.get(sourceId) ?? null,
      traversal: {
        traversalId: state.traversalId,
        contractHash: await hashCanonicalJson({
          sourceId,
          fingerprint: state.fingerprint,
          inventoryCardinality: state.inventoryCardinality,
          listingFactCompatibility: state.listingFactCompatibility,
          expectedPages: state.expectedPages,
          expectedListings: state.expectedListings,
        }),
        expectedPages: state.expectedPages,
        completed: state.completed,
        completedCheckpointHashes,
      },
    };
  }));
  return {
    schemaVersion: "auction-discovery-canonical-continuation-progress-v2",
    earliestDocumentAccessNextEligibleAt: documentAccessStops
      .filter((row) => row.state === "cooldown" && row.nextEligibleAt !== null)
      .map((row) => row.nextEligibleAt!)
      .sort()[0] ?? null,
    documentAccessStops,
    sources,
  } as const;
}

export async function GET(request: Request) {
  try {
    assertMatchingLoadedRuntimeRevision(request);
    const requested = new URL(request.url).searchParams.get("sourceId");
    const sourceId = requestedSourceId(requested);
    if (requested !== null && !sourceId) {
      return Response.json({ error: "A known sourceId is required" }, { status: 400 });
    }
    await ensureDatabase();
    if (sourceId === null) {
      const continuationProgress = await readCanonicalContinuationProgressVector();
      return Response.json({
        heads: continuationProgress.sources.flatMap(({ publicationHead }) =>
          publicationHead === null
            ? []
            : [{
                sourceId: publicationHead.sourceId,
                inventoryRunId: publicationHead.inventoryRunId,
                publishedAt: publicationHead.publishedAt,
                listingCount: publicationHead.listingCount,
              }]
        ),
        continuationProgress,
      });
    }
    return Response.json({
      sourceId,
      head: await readSourceInventoryPublicationHead(sourceId),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertMatchingLoadedRuntimeRevision(request);
    const payload = await readJson<{ mode?: string; sourceId?: unknown }>(request);
    const trigger = payload.mode === "nightly" ? "scheduled" : "manual";
    const sourceId = payload.sourceId === undefined
      ? null
      : requestedSourceId(payload.sourceId);
    if (payload.sourceId !== undefined && !sourceId) {
      return Response.json({ error: "A known sourceId is required" }, { status: 400 });
    }
    const telemetry: PerformanceTelemetryBuffer | null = sourceId
      ? createTransportPerformanceTelemetryBuffer(request)
      : null;
    const startedAt = performance.now();
    const result = sourceId
      ? await runAuctionDiscovery(
          trigger,
          { sourceId, catalogOnly: true },
        )
      : await runAuctionDiscovery(trigger);
    if (telemetry !== null) {
      recordSourcePublicationTransitionTelemetry({
        telemetry,
        runId: result.runId,
        status: result.status,
        transitions: result.publicationTransitions ?? [],
        durationMs: performance.now() - startedAt,
      });
    }
    return Response.json(
      telemetry === null
        ? result
        : {
            ...result,
            performanceTelemetry: drainTransportPerformanceTelemetry(
              request,
              telemetry,
            ),
          }, {
      status: result.status === "failed" ? 500 : result.status === "partial" ? 207 : 200,
      },
    );
  } catch (error) {
    if (error instanceof DiscoveryRunBusyError) {
      return Response.json(
        {
          error: error.message,
          code: "pipeline_run_in_progress",
          activeRunId: error.activeRunId,
          activeRunKind: error.activeRunKind,
        },
        { status: 409 },
      );
    }
    return jsonError(error);
  }
}
