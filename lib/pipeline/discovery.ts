import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../db/bootstrap";
import { getConfig } from "../config";
import { archivePrimaryImage, selectPrimaryImageArchiveTarget } from "../images/archive";
import { locationCacheKey } from "../routing/helpers";
import { assessExplicitGeographicPrefilter } from "../routing/geographic-prefilter";
import { readActiveOrigin } from "../settings/active-origin";
import { configuredSourceAccessGrant, syncConfiguredSourceManifests } from "../settings/source-manifests";
import { sourceCanRunInMode } from "../settings/source-policy";
import {
  AcquiredPageRequestController, ConservativeRequestController, SourceAccessDeniedError,
  SourceAccessChallengeError, SourceAdapterError, SourceRetryableHttpError,
  evaluateSourceAccess, exactListingEndHasPassed, sourceRegistry,
  type AcquiredSourcePage, type SourceDiscoveredListing, type SourceId,
  type SourceAdapter, type SourceRequestController,
} from "../sources";
import {
  assertSourceDocumentAccess, recordSourceDocumentAccessFailure,
  recordSourceDocumentAccessRecovery, SourceDocumentAccessDeferredError,
  type SourceDocumentAccessFailure,
} from "../sources/acquisition-access";
import {
  beginDiscoveryRun, beginSourceRun, ensureListingDetail, ensureListingDetailObservation,
  ensureListingStubs, finishDiscoveryRun, finishSourceRun, loadSourceListingProgress,
  markPrimaryImage, recordMissingSourceImageEvidenceAbsence, recordNonInlineRecoveryOutcome,
  recordUnavailableSourceImageEvidence, readPendingNonInlineRecoveryListings,
  readStoredListingDetail, readEnabledSourceIds, renewPipelineRunLease,
  replaceSourceCurrentInventory, discardEndedListingObservation,
  clearNonInlineDetailRecoveryOutcome, clearNonInlineRouteRecoveryOutcome,
  type RunCounters, type SourceRunCounters,
  type CommittedSourcePublicationTransition,
} from "./storage";
import { newListingSnapshotPolicy } from "../dashboard-new-listings";
import { createPickupRouteAssessor } from "./route";
import { collectGenericInventory } from "./generic-inventory";
import { readCurrentProjectionContracts } from "./projection-contracts";
import { refreshOperationalProjectionListing } from "./operational-projection";
import { throwIfDiscoveryRunCancelled, isDiscoveryRunCancelled, discoveryFailureSnapshotPolicy } from "./discovery-cancellation";
import {
  assertScheduledSourceQuantumForDiscovery, createSourceRequestQuantumLedger,
  SCHEDULED_SOURCE_QUANTUM_DISCOVERY_LEASE_MS, type ScheduledSourceQuantum,
} from "../scheduler/source-quantum";

export interface DiscoverySummary extends RunCounters {
  runId: string;
  mode: "normal" | "canary" | "continuation";
  sourceId: SourceId | null;
  originPostalCode: string;
  status: "completed" | "partial" | "failed";
  sourcesAttempted: number;
  sourceErrors: Array<{ sourceId: string; message: string }>;
  profileVotesUsed: number;
  imagesArchived: number;
  imageAttempts: number;
  imageFailures: number;
  aiAttempted: number;
  aiEnriched: number;
  aiFailures: number;
  aiBacklogAtStart: number | null;
  aiBacklogRemaining: number | null;
  aiCircuitOpen: boolean;
  deferredCandidates: number;
  zipPrefilterExcluded: number;
  detailsFetched: number;
  uniqueRouteAssessments: number;
  sourceWorkSelected: number;
  originPriorityFailures: number;
  publishedSourceIds: readonly SourceId[];
  readonly publicationTransitions?: readonly CommittedSourcePublicationTransition[];
}

export interface DiscoveryRunOptions {
  readonly mode?: "normal" | "canary" | "continuation";
  readonly sourceId?: SourceId;
  readonly catalogOnly?: boolean;
  readonly schedulerQuantum?: ScheduledSourceQuantum;
  readonly signal?: AbortSignal;
  readonly retryFailedImages?: boolean;
  readonly deferPrimaryImages?: boolean;
  readonly acquiredPages?: readonly AcquiredSourcePage[];
}

const acceptedBuckets = new Set(["under_2h", "under_4h", "under_8h"]);

/** One ordinary registered-source pipeline; source acquisition never invokes AI. */
export async function runAuctionDiscovery(
  trigger: "manual" | "scheduled" = "manual",
  options: DiscoveryRunOptions = {},
): Promise<DiscoverySummary> {
  throwIfDiscoveryRunCancelled(options.signal);
  await ensureDatabase();
  const mode = options.mode ?? "normal";
  if ((mode !== "normal" || options.catalogOnly || options.acquiredPages) && !options.sourceId) {
    throw new Error("This source operation requires one registered sourceId");
  }
  if (options.acquiredPages && (!options.catalogOnly || mode !== "normal")) {
    throw new Error("Captured browser pages require a catalog-only import");
  }
  if (options.schedulerQuantum) assertScheduledSourceQuantumForDiscovery(options.schedulerQuantum, { trigger, sourceId: options.sourceId, catalogOnly: options.catalogOnly });
  const config = getConfig();
  const origin = await readActiveOrigin();
  const originCacheKey = locationCacheKey({ postalCode: origin.postalCode, countryCode: origin.countryCode });
  const manifests = await syncConfiguredSourceManifests(config);
  const enabled = await readEnabledSourceIds();
  const runnable = manifests.filter((manifest) =>
    (!options.sourceId || manifest.id === options.sourceId) &&
    sourceCanRunInMode(manifest.implementationStatus, enabled.has(manifest.id), mode));
  if (options.sourceId && runnable.length !== 1) throw new Error("Source is not configured and enabled for this operation");
  const leaseMs = options.schedulerQuantum ? SCHEDULED_SOURCE_QUANTUM_DISCOVERY_LEASE_MS : config.limits.discoveryRunLeaseMs;
  const ledger = options.schedulerQuantum ? createSourceRequestQuantumLedger(options.schedulerQuantum) : undefined;
  const assessor = await createPickupRouteAssessor(origin);
  const runId = await beginDiscoveryRun(trigger, origin.postalCode, leaseMs);
  const summary: DiscoverySummary = {
    runId, mode, sourceId: options.sourceId ?? null, originPostalCode: origin.postalCode,
    status: "completed", discovered: 0, newListings: 0, accepted: 0, excluded: 0,
    sourcesAttempted: runnable.length, sourceErrors: [], profileVotesUsed: 0,
    imagesArchived: 0, imageAttempts: 0, imageFailures: 0, aiAttempted: 0, aiEnriched: 0,
    aiFailures: 0, aiBacklogAtStart: null, aiBacklogRemaining: null, aiCircuitOpen: false,
    deferredCandidates: 0, zipPrefilterExcluded: 0, detailsFetched: 0,
    uniqueRouteAssessments: 0, sourceWorkSelected: 0, originPriorityFailures: 0,
    publishedSourceIds: [], publicationTransitions: [],
  };
  const published: SourceId[] = [];
  const transitions: CommittedSourcePublicationTransition[] = [];
  const checkpoint = async () => {
    throwIfDiscoveryRunCancelled(options.signal);
    await renewPipelineRunLease("discovery", runId, leaseMs);
  };
  const imageLimit = options.deferPrimaryImages || options.catalogOnly ? 0 : config.limits.maxPrimaryImageDownloadsPerRun;
  try {
    for (const manifest of runnable) {
      await checkpoint();
      const adapter = sourceRegistry.get(manifest.id)!;
      const sourceRunId = await beginSourceRun(runId, manifest.id);
      const counters: SourceRunCounters = { stubsDiscovered: 0, skippedAlreadySeen: 0, detailsFetched: 0, accepted: 0, excluded: 0 };
      try {
        const grant = configuredSourceAccessGrant(manifest.id, enabled.has(manifest.id), mode === "canary");
        const access = evaluateSourceAccess(manifest, grant);
        if (!access.allowed) throw new SourceAccessDeniedError(manifest.id, access.reason);
        await assertSourceDocumentAccess({ database: env.DB, manifest });
        const controller: SourceRequestController = options.acquiredPages
          ? new AcquiredPageRequestController(manifest, grant, options.acquiredPages)
          : new ConservativeRequestController(manifest, grant, {
              sourceQuantumLedger: ledger,
              recordAccessPressure: async ({ status, retryAfterMs }) => recordSourceDocumentAccessFailure({
                database: env.DB, manifest,
                failure: { kind: status === 429 ? "rate_limited" : "source_pressure", failureCode: `http_${status}`, ...(retryAfterMs === null ? {} : { retryAfterMs }) },
              }),
            });
        if (manifest.acquisition === "isolated_browser" && mode !== "continuation" && !options.acquiredPages) {
          throw new SourceAdapterError(manifest.id, "This source requires a headless browser capture through Run discovery");
        }
        let work: readonly SourceDiscoveredListing[] = [];
        if (mode !== "continuation") {
          work = await collectGenericInventory(adapter, controller, { canary: mode === "canary", originPostalCode: origin.postalCode }, checkpoint);
          const ensured = await ensureListingStubs(runId, work.map(({ stub }) => stub));
          counters.stubsDiscovered = work.length;
          summary.discovered += work.length;
          for (const listing of work) {
            await checkpoint();
            const write = ensured.get(listing.stub.sourceListingId)!;
            if (write.inserted) summary.newListings += 1;
            else counters.skippedAlreadySeen += 1;
            if (listing.detail) {
              const result = await ensureListingDetail(write.id, listing.detail);
              if (result.inserted) { counters.detailsFetched += 1; summary.detailsFetched += 1; }
              // Missing observations are rebuilt from the immutable stored record.
              const detail = await readStoredListingDetail(write.id);
              if (detail) {
                await ensureListingDetailObservation(write.id, detail);
                if (detail.images.length === 0) {
                  await recordMissingSourceImageEvidenceAbsence({ listingId: write.id, originCacheKey });
                }
              }
            }
            if (listing.currentState === "ended" || (listing.detail && exactListingEndHasPassed(listing.detail.auctionEndsAt, listing.stub.discoveredAt))) {
              await discardEndedListingObservation({ runId, listingId: write.id });
            }
          }
          if (mode === "normal") {
            transitions.push(await replaceSourceCurrentInventory({ runId, sourceId: manifest.id }));
            published.push(manifest.id);
          }
          await recordSourceDocumentAccessRecovery({ database: env.DB, manifest });
        }
        if (!options.catalogOnly) {
          const candidateLimit = mode === "canary" ? 1 : Math.min(100, config.limits.maxCandidatesPerSourceRun);
          if (mode !== "canary") {
            const pending = await readPendingNonInlineRecoveryListings({
              sourceId: manifest.id, originCacheKey, routeProviderName: config.routing.routeProvider,
              candidateLimit, imageLimit: 0, includeFailedImages: options.retryFailedImages ?? config.limits.retryFailedPrimaryImages,
              allowListingDetailRequests: manifest.acquisition !== "isolated_browser",
            });
            work = pending.map(({ stub }) => ({ stub }));
          }
          const progress = await loadSourceListingProgress(manifest.id, { originCacheKey, providerName: config.routing.routeProvider });
          const selected = work.filter((row) => {
            const state = progress.get(row.stub.sourceListingId);
            return row.currentState !== "ended" && row.reviewCandidate !== false &&
              state && !state.distanceExcluded && state.recoveryState !== "terminal";
          }).slice(0, candidateLimit);
          summary.deferredCandidates += Math.max(0, work.length - selected.length);
          for (const listing of selected) {
            await checkpoint();
            const state = progress.get(listing.stub.sourceListingId);
            if (!state || state.distanceExcluded || state.recoveryState === "terminal") continue;
            summary.sourceWorkSelected += 1;
            let stage: "detail" | "route" | "image" = "detail";
            try {
              let detail = await readStoredListingDetail(state.id);
              if (!detail) {
                const prefilter = assessExplicitGeographicPrefilter(origin.postalCode, origin.countryCode, listing.stub.visibleLocation);
                if (prefilter.decision === "terminal_impossible") {
                  await recordNonInlineRecoveryOutcome({ listingId: state.id, originCacheKey, state: "terminal", stage: "prefilter", errorCode: prefilter.errorCode! });
                  counters.excluded += 1; summary.excluded += 1; summary.zipPrefilterExcluded += 1;
                  continue;
                }
                detail = await acquireMissingDetail(adapter, controller, listing);
                if (!detail) { summary.deferredCandidates += 1; continue; }
                const stored = await ensureListingDetail(state.id, detail);
                if (stored.inserted) { counters.detailsFetched += 1; summary.detailsFetched += 1; }
                detail = await readStoredListingDetail(state.id);
              }
              if (!detail) throw new Error("The immutable detail could not be read");
              if (!state.hasDetailObservation) await ensureListingDetailObservation(state.id, detail);
              await clearNonInlineDetailRecoveryOutcome({ listingId: state.id, originCacheKey });
              if (exactListingEndHasPassed(detail.auctionEndsAt, new Date().toISOString())) {
                await discardEndedListingObservation({ runId, listingId: state.id });
                await recordNonInlineRecoveryOutcome({ listingId: state.id, originCacheKey, state: "terminal", stage: "detail", errorCode: "listing_ended" });
                continue;
              }
              stage = "route";
              const location = detail.pickupLocation ?? listing.stub.visibleLocation;
              const { destination, route } = await assessor.assess(location, state.id);
              await assessor.persistForListing(state.id, destination, route);
              await clearNonInlineRouteRecoveryOutcome({ listingId: state.id, originCacheKey });
              summary.uniqueRouteAssessments += 1;
              if (!acceptedBuckets.has(route.bucket)) { counters.excluded += 1; summary.excluded += 1; continue; }
              counters.accepted += 1; summary.accepted += 1;
              const primary = detail.images.find((item) => item.isPrimary);
              if (!primary) {
                await recordMissingSourceImageEvidenceAbsence({ listingId: state.id, originCacheKey });
                continue;
              }
              if (summary.imageAttempts >= imageLimit || state.primaryImageStatus === "downloaded" ||
                (state.primaryImageStatus === "failed" && !(options.retryFailedImages ?? config.limits.retryFailedPrimaryImages))) continue;
              stage = "image";
              await refreshOperationalProjectionListing({
                database: env.DB, listingId: state.id,
                contracts: await readCurrentProjectionContracts(env.DB),
              });
              summary.imageAttempts += 1;
              const target = selectPrimaryImageArchiveTarget({ sourceUrl: primary.sourceUrl, thumbnailUrl: primary.thumbnailUrl, previousDownloadErrorCode: state.primaryImageErrorCode });
              const archived = await archivePrimaryImage({
                storage: env.STORAGE, source: manifest.id, sourceListingId: detail.sourceListingId,
                imageUrl: target.imageUrl, canonicalSourceUrl: target.canonicalSourceUrl, representation: target.representation,
                timeoutMs: config.sourceTimeoutMs, maxBytes: manifest.requests.maxImageResponseBytes ?? manifest.requests.maxResponseBytes,
                allowedHosts: manifest.requests.allowedImageHosts, allowedRedirectRules: manifest.requests.allowedImageRedirects,
                maxRedirects: manifest.requests.maxRedirects ?? 0,
                requestExecutor: (url, handle) => controller.fetchApprovedImage(url, handle),
              });
              await markPrimaryImage(state.id, { status: "downloaded", localPath: archived.objectKey, contentHash: archived.sha256, width: archived.width, height: archived.height, acquisitionMethod: "direct" });
              summary.imagesArchived += 1;
            } catch (error) {
              if (isDiscoveryRunCancelled(error) || directSourceAccessFailure(error)) throw error;
              if (stage === "image") {
                summary.imageFailures += 1;
                await recordUnavailableSourceImageEvidence({ listingId: state.id });
                await markPrimaryImage(state.id, { status: "failed", error: "Image acquisition failed", acquisitionMethod: "direct" });
              } else {
                await recordNonInlineRecoveryOutcome({ listingId: state.id, originCacheKey, state: "retryable", stage, errorCode: "preparation_failed" });
              }
              throw error;
            }
          }
        }
        await finishSourceRun(sourceRunId, "completed", counters);
      } catch (error) {
        const failure = directSourceAccessFailure(error);
        if (failure) await recordSourceDocumentAccessFailure({ database: env.DB, manifest, failure });
        await finishSourceRun(sourceRunId, "failed", counters, error);
        if (isDiscoveryRunCancelled(error)) throw error;
        summary.sourceErrors.push({ sourceId: manifest.id, message: error instanceof Error ? error.message : "Source operation failed" });
      }
    }
    summary.status = summary.sourceErrors.length ? "partial" : "completed";
    await finishDiscoveryRun(runId, summary.status, summary, summary.sourceErrors[0] ? new Error(summary.sourceErrors[0].message) : undefined,
      newListingSnapshotPolicy({ sourceSpecific: Boolean(options.sourceId), inventoryComplete: mode === "normal" && published.length === runnable.length }));
  } catch (error) {
    summary.status = "failed";
    summary.sourceErrors.push({ sourceId: "pipeline", message: error instanceof Error ? error.message : "Pipeline failed" });
    await finishDiscoveryRun(runId, "failed", summary, error, discoveryFailureSnapshotPolicy(error, { sourceSpecific: Boolean(options.sourceId), inventoryComplete: false }));
  }
  return { ...summary, publishedSourceIds: published, publicationTransitions: transitions };
}

async function acquireMissingDetail(adapter: SourceAdapter, controller: SourceRequestController, listing: SourceDiscoveredListing) {
  if (listing.detail) return listing.detail;
  if (adapter.manifest.acquisition === "isolated_browser") return null;
  const request = adapter.planDetail(listing.stub);
  if (!request) return null;
  const page = await controller.fetchPage(request);
  if (adapter.isDetailPageProvablyEnded?.(page, listing.stub)) throw new SourceAdapterError(adapter.manifest.id, "Listing detail is no longer available");
  const pages = [page];
  for (const extra of adapter.planAdditionalDetailPages?.(page, listing.stub) ?? []) pages.push(await controller.fetchPage(extra));
  const detail = adapter.parseDetailPages?.(pages, listing.stub) ?? adapter.parseDetailPage(page, listing.stub);
  if (detail.sourceId !== listing.stub.sourceId || detail.sourceListingId !== listing.stub.sourceListingId || detail.sourceUrl !== listing.stub.sourceUrl) {
    throw new SourceAdapterError(adapter.manifest.id, "Detail identity differs from its immutable listing");
  }
  return detail;
}

export function directSourceAccessFailure(error: unknown): SourceDocumentAccessFailure | null {
  if (error instanceof SourceDocumentAccessDeferredError) return null;
  if (error instanceof SourceAccessChallengeError) return { kind: error.status === 429 ? "rate_limited" : "challenge", failureCode: error.status === null ? "source_challenge" : `http_${error.status}`, ...(error.retryAfterMs === null ? {} : { retryAfterMs: error.retryAfterMs }) };
  if (error instanceof SourceAccessDeniedError) return { kind: "access_denied", failureCode: error.reason };
  if (error instanceof SourceRetryableHttpError) return { kind: "source_pressure", failureCode: `http_${error.status}`, ...(error.retryAfterMs === null ? {} : { retryAfterMs: error.retryAfterMs }) };
  if (error instanceof Error && ["TypeError", "AbortError", "TimeoutError"].includes(error.name)) return { kind: "source_pressure", failureCode: "transport_failure" };
  return null;
}
