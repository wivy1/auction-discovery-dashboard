const DEFAULT_COMPANION_PORT = 32_110;
const SOURCE_ACQUISITION_TIMEOUT_MS = 30 * 60 * 1_000;
const NORMAL_SOURCE_ACQUISITION_TIMEOUT_MS = 3 * 60 * 60 * 1_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_COMPOSITE_BROWSER_PAGES = 10_000;

export type LocalBrowserSourceId = string;

export type LocalSourceAcquisitionMode =
  | "canary"
  | "catalog"
  | "continuation"
  | "normal";


export interface LocalSourceRunSummary {
  runId: string;
  status: "completed" | "partial" | "failed";
  publishedSourceIds?: string[];
  publicationTransitions?: LocalSourcePublicationTransition[];
  discovered: number;
  newListings: number;
  accepted: number;
  excluded: number;
  detailsFetched: number;
  imageAttempts: number;
  imagesArchived: number;
  imageFailures: number;
  sourceWorkSelected: number;
  deferredCandidates: number;
  sourceErrors: Array<{ sourceId: string; message: string }>;
}

export interface LocalSourcePublicationTransition {
  readonly sourceId: string;
  readonly priorHead: LocalSourcePublicationHead | null;
  readonly resultingHead: LocalSourcePublicationHead | null;
  readonly outcome: "published" | "preserved_prior" | "no_publication" | "inconsistent";
  readonly reasonCode: string;
}

export interface LocalSourcePublicationHead {
  readonly sourceId: string;
  readonly inventoryRunId: string;
  readonly publishedAt: string;
  readonly listingCount: number;
}

export interface LocalSourceAcquisitionSummary {
  state:
    | "completed"
    | "partial"
    | "skipped"
    | "busy"
    | "unavailable";
  mode: LocalSourceAcquisitionMode;
  browserPages: number;
  catalog: LocalSourceRunSummary | null;
  continuation: LocalSourceRunSummary | null;
  continuations?: Array<{
    sourceId: LocalBrowserSourceId;
    result: LocalSourceRunSummary;
  }>;
  skipReason: "not_runnable" | "no_pending_work" | null;
  errorCode: string | null;
}

export interface LocalSourceAcquisitionOptions {
  readonly retryFailedImages?: boolean;
  readonly repairMissingImageEvidence?: boolean;
  readonly deferPrimaryImages?: boolean;
}


export async function triggerLocalSourceAcquisition(
  sourceId: LocalBrowserSourceId,
  mode: LocalSourceAcquisitionMode,
  options: LocalSourceAcquisitionOptions = {},
): Promise<LocalSourceAcquisitionSummary> {
  if (
    (
      options.retryFailedImages !== undefined &&
      typeof options.retryFailedImages !== "boolean"
    ) ||
    (
      options.repairMissingImageEvidence !== undefined &&
      typeof options.repairMissingImageEvidence !== "boolean"
    ) ||
    (
      options.deferPrimaryImages !== undefined &&
      typeof options.deferPrimaryImages !== "boolean"
    )
  ) {
    return unavailable(mode, "invalid_source_image_repair_mode");
  }
  const retryFailedImages = options.retryFailedImages === true;
  const repairMissingImageEvidence =
    options.repairMissingImageEvidence === true;
  const deferPrimaryImages = options.deferPrimaryImages === true;
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(sourceId)) {
    return unavailable(mode, "invalid_source_id");
  }
  if (
    (retryFailedImages && repairMissingImageEvidence) ||
    (
      deferPrimaryImages &&
      (retryFailedImages || repairMissingImageEvidence)
    ) ||
    (
      mode !== "continuation" &&
      (
        retryFailedImages ||
        repairMissingImageEvidence ||
        deferPrimaryImages
      )
    )
  ) {
    return unavailable(mode, "invalid_source_image_repair_mode");
  }
  const abort = new AbortController();
  const timeoutMs = mode === "normal" || mode === "catalog"
    ? NORMAL_SOURCE_ACQUISITION_TIMEOUT_MS
    : SOURCE_ACQUISITION_TIMEOUT_MS;
  const timer = setTimeout(
    () => abort.abort(),
    timeoutMs,
  );
  let response: Response;
  try {
    response = await fetch(
      `http://127.0.0.1:${DEFAULT_COMPANION_PORT}/v1/source-acquisition`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceId,
          mode,
          trigger: "manual",
          ...(retryFailedImages ? { retryFailedImages: true } : {}),
          ...(repairMissingImageEvidence
            ? { repairMissingImageEvidence: true }
            : {}),
          ...(deferPrimaryImages ? { deferPrimaryImages: true } : {}),
        }),
        signal: abort.signal,
      },
    );
    const payload = await readBoundedJson(response);
    if (response.status === 409) {
      return unavailable(mode, "source_acquisition_busy", "busy");
    }
    if (!response.ok) {
      const code = isRecord(payload) && typeof payload.code === "string"
        ? payload.code.slice(0, 100)
        : `source_acquisition_http_${response.status}`;
      return unavailable(mode, code);
    }
    return parseResponse(payload, sourceId, mode) ??
      unavailable(mode, "source_acquisition_contract_mismatch");
  } catch {
    return unavailable(
      mode,
      abort.signal.aborted
        ? "source_acquisition_timeout"
        : "source_acquisition_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}

export const triggerLocalBrowserSourceAcquisition = triggerLocalSourceAcquisition;

function parseResponse(
  value: unknown,
  requestedSourceId: LocalBrowserSourceId,
  requestedMode: LocalSourceAcquisitionMode,
): LocalSourceAcquisitionSummary | null {
  if (
    !isRecord(value) ||
    value.sourceId !== requestedSourceId ||
    value.mode !== requestedMode ||
    (
      value.status !== "completed" &&
      value.status !== "partial" &&
      value.status !== "skipped"
    ) ||
    !boundedInteger(value.browserPages, MAX_COMPOSITE_BROWSER_PAGES)
  ) return null;
  const catalog = parseRun(value.catalog);
  const continuation = parseRun(value.continuation);
  const continuations = value.continuations === undefined
    ? undefined
    : parseContinuations(value.continuations);
  if (
    (value.catalog !== null && !catalog) ||
    (value.continuation !== null && !continuation) ||
    (value.continuations !== undefined && !continuations) ||
    (
      value.skipReason !== null &&
      value.skipReason !== "not_runnable" &&
      value.skipReason !== "no_pending_work"
    )
  ) return null;
  return {
    state: value.status,
    mode: requestedMode,
    browserPages: value.browserPages as number,
    catalog,
    continuation,
    ...(continuations ? { continuations } : {}),
    skipReason: value.skipReason as
      | "not_runnable"
      | "no_pending_work"
      | null,
    errorCode: null,
  };
}

function parseContinuations(
  value: unknown,
): Array<{
  sourceId: LocalBrowserSourceId;
  result: LocalSourceRunSummary;
}> | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<LocalBrowserSourceId>();
  const parsed = value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      (typeof entry.sourceId !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(entry.sourceId)) ||
      seen.has(entry.sourceId)
    ) return [];
    const sourceId: LocalBrowserSourceId = entry.sourceId;
    const result = parseRun(entry.result);
    if (!result) return [];
    seen.add(sourceId);
    return [{ sourceId, result }];
  });
  return parsed.length === value.length ? parsed : null;
}

function parseRun(value: unknown): LocalSourceRunSummary | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    (
      value.status !== "completed" &&
      value.status !== "partial" &&
      value.status !== "failed"
    ) ||
    !Array.isArray(value.sourceErrors)
  ) return null;
  const names = [
    "discovered",
    "newListings",
    "accepted",
    "excluded",
    "detailsFetched",
    "imageAttempts",
    "imagesArchived",
    "imageFailures",
    "sourceWorkSelected",
    "deferredCandidates",
  ] as const;
  if (names.some((name) => !boundedInteger(value[name], 1_000_000))) {
    return null;
  }
  const sourceErrors = value.sourceErrors.flatMap((entry) =>
    isRecord(entry) &&
      typeof entry.sourceId === "string" &&
      entry.sourceId.length <= 64 &&
      typeof entry.message === "string" &&
      entry.message.length <= 2_000
      ? [{ sourceId: entry.sourceId, message: entry.message }]
      : []
  );
  if (sourceErrors.length !== value.sourceErrors.length) return null;
  let publishedSourceIds: string[] | undefined;
  if (value.publishedSourceIds !== undefined) {
    if (
      !Array.isArray(value.publishedSourceIds) ||
      value.publishedSourceIds.some((sourceId) =>
        typeof sourceId !== "string" ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(sourceId)
      ) ||
      new Set(value.publishedSourceIds).size !==
        value.publishedSourceIds.length
    ) return null;
    publishedSourceIds = [...value.publishedSourceIds] as string[];
  }
  let publicationTransitions: LocalSourcePublicationTransition[] | undefined;
  if (value.publicationTransitions !== undefined) {
    const parsed = parsePublicationTransitions(value.publicationTransitions);
    if (!parsed) return null;
    publicationTransitions = parsed;
  }
  return {
    runId: value.runId,
    status: value.status,
    ...(publishedSourceIds === undefined ? {} : { publishedSourceIds }),
    ...(publicationTransitions === undefined ? {} : { publicationTransitions }),
    discovered: value.discovered as number,
    newListings: value.newListings as number,
    accepted: value.accepted as number,
    excluded: value.excluded as number,
    detailsFetched: value.detailsFetched as number,
    imageAttempts: value.imageAttempts as number,
    imagesArchived: value.imagesArchived as number,
    imageFailures: value.imageFailures as number,
    sourceWorkSelected: value.sourceWorkSelected as number,
    deferredCandidates: value.deferredCandidates as number,
    sourceErrors,
  };
}

function parsePublicationTransitions(
  value: unknown,
): LocalSourcePublicationTransition[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 18) return null;
  const seen = new Set<string>();
  const parsed = value.flatMap((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.sourceId !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(entry.sourceId) ||
      seen.has(entry.sourceId) ||
      ![
        "published",
        "preserved_prior",
        "no_publication",
        "inconsistent",
      ].includes(String(entry.outcome)) ||
      typeof entry.reasonCode !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(entry.reasonCode)
    ) return [];
    const priorHead = parsePublicationHead(entry.priorHead, entry.sourceId);
    const resultingHead = parsePublicationHead(entry.resultingHead, entry.sourceId);
    if (
      (entry.priorHead !== null && priorHead === null) ||
      (entry.resultingHead !== null && resultingHead === null)
    ) return [];
    seen.add(entry.sourceId);
    return [{
      sourceId: entry.sourceId,
      priorHead,
      resultingHead,
      outcome: entry.outcome as LocalSourcePublicationTransition["outcome"],
      reasonCode: entry.reasonCode,
    }];
  });
  return parsed.length === value.length ? parsed : null;
}

function parsePublicationHead(
  value: unknown,
  sourceId: string,
): LocalSourcePublicationHead | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    value.sourceId !== sourceId ||
    typeof value.inventoryRunId !== "string" ||
    value.inventoryRunId.length < 1 ||
    value.inventoryRunId.length > 256 ||
    typeof value.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    !boundedInteger(value.listingCount, 1_000_000)
  ) return null;
  return {
    sourceId,
    inventoryRunId: value.inventoryRunId,
    publishedAt: value.publishedAt,
    listingCount: value.listingCount as number,
  };
}

function unavailable(
  mode: LocalSourceAcquisitionMode,
  errorCode: string,
  state: "busy" | "unavailable" = "unavailable",
): LocalSourceAcquisitionSummary {
  return {
    state,
    mode,
    browserPages: 0,
    catalog: null,
    continuation: null,
    skipReason: null,
    errorCode,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  } finally {
    reader.releaseLock();
  }
}

function boundedInteger(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
