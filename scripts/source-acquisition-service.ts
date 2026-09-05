import type { LocalSourceRunSummary } from "../lib/sources/local-acquisition";
import type { GenericSourceAcquisitionPlan } from "../lib/pipeline/source-acquisition";
import { LOCAL_COMPANION_CAPABILITY_HEADER } from "../lib/local-companion";
import { RUNTIME_REVISION_HEADER } from "../lib/runtime-revision";
import { BrowserCleanupError, captureGenericSourcePages } from "./source-browser-acquisition";

export type LocalSourceAcquisitionMode = "canary" | "catalog" | "continuation" | "normal";
export type LocalSourceAcquisitionTrigger = "manual" | "scheduled";
export const LOCAL_SOURCE_ACQUISITION_MAX_TELEMETRY_EVENTS = 128;
export class LocalSourceAcquisitionError extends Error {
  readonly upstreamCode: string | null;
  readonly upstreamError = null;
  readonly upstreamDiagnostic = null;
  readonly accessReceipt = null;
  readonly retryAfterMs = null;
  constructor(message: string, readonly status: number, readonly code: string, readonly sourceId: string | null = null) {
    super(message);
    this.name = "LocalSourceAcquisitionError";
    this.upstreamCode = code;
  }
}
export interface LocalSourceAcquisitionResult {
  sourceId: string;
  mode: LocalSourceAcquisitionMode;
  status: "completed" | "partial" | "skipped";
  browserPages: number;
  catalog: LocalSourceRunSummary | null;
  continuation: LocalSourceRunSummary | null;
  skipReason: "not_runnable" | "no_pending_work" | null;
}
export interface LocalSourceAcquisitionBatchResult {
  mode: "normal";
  status: "completed" | "partial";
  results: Array<{ sourceId: string; result: LocalSourceAcquisitionResult | null; error: LocalSourceAcquisitionError | null }>;
}
interface Connection {
  dashboardUrl: string;
  capability: string;
  runtimeRevision: string;
  signal?: AbortSignal;
  trigger?: LocalSourceAcquisitionTrigger;
  telemetry?: unknown;
  telemetryContext?: unknown;
}
let callbackTail = Promise.resolve();
let callbackDepth = 0;
export function sourceAcquisitionCallbackQueueDepth(): number { return callbackDepth; }

async function callback<T>(input: Connection, payload: Record<string, unknown>): Promise<T> {
  const url = new URL(input.dashboardUrl);
  if (url.origin !== "http://localhost:3000" || url.username || url.password || input.capability.length < 32 || !/^sha256:[a-f0-9]{64}$/u.test(input.runtimeRevision)) throw new LocalSourceAcquisitionError("Invalid local callback authority", 403, "invalid_callback_authority");
  callbackDepth++;
  const preceding = callbackTail;
  let release!: () => void;
  callbackTail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await preceding;
    input.signal?.throwIfAborted();
    const response = await fetch(new URL("/api/internal/source-acquisition", url), {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/json", [LOCAL_COMPANION_CAPABILITY_HEADER]: input.capability, [RUNTIME_REVISION_HEADER]: input.runtimeRevision },
      body: JSON.stringify(payload),
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(10 * 60_000)]) : AbortSignal.timeout(10 * 60_000),
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty source callback response.");
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 256 * 1024) { await reader.cancel(); throw new Error("Source callback response exceeds its byte budget."); }
        text += decoder.decode(next.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    if (!response.ok) throw new LocalSourceAcquisitionError("Source callback rejected the acquisition", response.status, "source_callback_rejected", typeof payload.sourceId === "string" ? payload.sourceId : null);
    return JSON.parse(text) as T;
  } finally { callbackDepth--; release(); }
}

export async function runLocalSourceAcquisition(input: Connection & {
  sourceId: string;
  mode?: LocalSourceAcquisitionMode;
  retryFailedImages?: boolean;
  repairMissingImageEvidence?: boolean;
  deferPrimaryImages?: boolean;
}): Promise<LocalSourceAcquisitionResult> {
  const mode = input.mode ?? "normal";
  if ((mode !== "catalog" && mode !== "normal") || input.retryFailedImages || input.repairMissingImageEvidence || input.deferPrimaryImages) throw new LocalSourceAcquisitionError("Generic browser acquisition supports normal and catalog inventory only", 400, "unsupported_source_acquisition_mode", input.sourceId);
  try {
    // The protected callback checks the current enabled setting and permission.
    const { plan } = await callback<{ plan: GenericSourceAcquisitionPlan }>(input, { action: "plan", sourceId: input.sourceId });
    const pages = await captureGenericSourcePages(plan, { signal: input.signal });
    const { catalog } = await callback<{ catalog: LocalSourceRunSummary }>(input, { action: "commit", sourceId: input.sourceId, pages, trigger: input.trigger ?? "manual" });
    return { sourceId: input.sourceId, mode, status: catalog.status === "completed" ? "completed" : "partial", browserPages: pages.length, catalog, continuation: null, skipReason: null };
  } catch (error) {
    if (error instanceof LocalSourceAcquisitionError) throw error;
    if (error instanceof BrowserCleanupError) throw new LocalSourceAcquisitionError(error.message, 503, "cleanup_failed", input.sourceId);
    // Browser errors can contain request URLs. Keep source diagnostics local.
    throw new LocalSourceAcquisitionError("Headless source acquisition stopped; inspect its discovery receipt before retrying", 502, "source_acquisition_stopped", input.sourceId);
  }
}

export async function runLocalSourceAcquisitionBatch(input: Connection & { sourceIds: readonly string[] }): Promise<LocalSourceAcquisitionBatchResult> {
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length > 20 || new Set(input.sourceIds).size !== input.sourceIds.length) throw new LocalSourceAcquisitionError("Invalid source batch", 400, "invalid_source_batch");
  const results: LocalSourceAcquisitionBatchResult["results"] = [];
  for (const sourceId of input.sourceIds) {
    input.signal?.throwIfAborted();
    try { results.push({ sourceId, result: await runLocalSourceAcquisition({ ...input, sourceId, mode: "normal" }), error: null }); }
    catch (error) { results.push({ sourceId, result: null, error: error instanceof LocalSourceAcquisitionError ? error : new LocalSourceAcquisitionError("Source stopped", 502, "source_acquisition_stopped", sourceId) }); }
  }
  return { mode: "normal", status: results.every((entry) => entry.result?.status === "completed") ? "completed" : "partial", results };
}


