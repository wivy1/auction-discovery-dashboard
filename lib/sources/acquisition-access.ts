import {
  checkSourceAccessEligibility,
  recordSourceAccessStop,
  recordSourceAccessSuccess,
  type SourceAccessEligibility,
  type SourceAccessStateRow,
} from "./access-state";
import { stableContentHash } from "./parsing";
import type { SourceAcquisition, SourceManifest } from "./types";

export const SOURCE_DOCUMENT_ACCESS_LANE = "document" as const;

/**
 * Normalize the manifest's optional representation once for every acquisition
 * boundary. Omitting `acquisition` is the documented ordinary direct mode; a
 * caller must never interpret the raw `undefined` as a third acquisition kind.
 */
export function effectiveSourceAcquisition(
  manifest: Pick<SourceManifest, "acquisition">,
): SourceAcquisition {
  return manifest.acquisition ?? "direct";
}

export type SourceDocumentAccessFailureKind =
  | "challenge"
  | "access_denied"
  | "rate_limited"
  | "source_pressure";

export interface SourceDocumentAccessFailure {
  readonly kind: SourceDocumentAccessFailureKind;
  /** Sanitized typed code only; never a URL, body, header, or exception text. */
  readonly failureCode: string;
  /** Parsed Retry-After duration measured from the recording boundary. */
  readonly retryAfterMs?: number;
}

const DEFAULT_CHALLENGE_COOLDOWN_MS = 60 * 60_000;
const DEFAULT_PRESSURE_COOLDOWN_MS = 60_000;
const MAX_RETRY_AFTER_MS = 10 * 365 * 24 * 60 * 60_000;

export class SourceDocumentAccessDeferredError extends Error {
  constructor(readonly access: SourceAccessEligibility) {
    super(
      `Source document access is deferred: ${
        access.row.reasonCode ?? access.row.state
      }`,
    );
    this.name = "SourceDocumentAccessDeferredError";
  }
}

/**
 * One lane-wide input identity shared by direct, browser, companion, canary,
 * catalog, and continuation entrypoints. A mode change must not release a
 * durable stop; an actual manifest/access/request-contract change may.
 */
export function sourceDocumentAccessInputHash(
  manifest: SourceManifest,
): string {
  return stableContentHash({
    contract: "source-document-access-input-v1",
    sourceId: manifest.id,
    baseUrl: manifest.baseUrl,
    acquisition: effectiveSourceAcquisition(manifest),
    implementationStatus: manifest.implementationStatus,
    inventoryScope: manifest.inventoryScope,
    transport: manifest.transport,
    access: {
      permissionBasis: manifest.access.permissionBasis,
      reviewedAt: manifest.access.reviewedAt,
      ...(manifest.access.permissionBasis === "recorded_permission"
        ? {
            permissionReference: manifest.access.permissionReference,
            permissionRecordedAt: manifest.access.permissionRecordedAt,
          }
        : {}),
    },
    requests: manifest.requests,
  });
}

export async function checkSourceDocumentAccess(input: {
  readonly database: D1Database;
  readonly manifest: SourceManifest;
  readonly now?: Date;
}): Promise<SourceAccessEligibility> {
  return checkSourceAccessEligibility({
    database: input.database,
    sourceId: input.manifest.id,
    laneKey: SOURCE_DOCUMENT_ACCESS_LANE,
    currentInputHash: sourceDocumentAccessInputHash(input.manifest),
    now: input.now,
  });
}

export async function assertSourceDocumentAccess(input: {
  readonly database: D1Database;
  readonly manifest: SourceManifest;
  readonly now?: Date;
}): Promise<SourceAccessEligibility> {
  const access = await checkSourceDocumentAccess(input);
  if (!access.eligible) throw new SourceDocumentAccessDeferredError(access);
  return access;
}

export async function recordSourceDocumentAccessFailure(input: {
  readonly database: D1Database;
  readonly manifest: SourceManifest;
  readonly failure: SourceDocumentAccessFailure;
  readonly now?: Date;
}): Promise<SourceAccessStateRow> {
  const now = validDate(input.now ?? new Date());
  const failureCode = boundedFailureCode(input.failure.failureCode);
  const currentInputHash = sourceDocumentAccessInputHash(input.manifest);
  if (input.failure.kind === "access_denied") {
    return recordSourceAccessStop({
      database: input.database,
      sourceId: input.manifest.id,
      laneKey: SOURCE_DOCUMENT_ACCESS_LANE,
      currentInputHash,
      state: "manual_reset_required",
      reasonCode: "access_denied",
      failureFingerprint: stableFailureFingerprint(
        input.manifest.id,
        input.failure.kind,
        failureCode,
      ),
      now,
    });
  }

  const retryAfterMs = input.failure.retryAfterMs === undefined
    ? input.failure.kind === "challenge"
      ? DEFAULT_CHALLENGE_COOLDOWN_MS
      : DEFAULT_PRESSURE_COOLDOWN_MS
    : boundedRetryAfterMs(input.failure.retryAfterMs);
  const cooldownMs = Math.max(
    retryAfterMs,
    input.manifest.requests.minDelayMs,
    1,
  );
  return recordSourceAccessStop({
    database: input.database,
    sourceId: input.manifest.id,
    laneKey: SOURCE_DOCUMENT_ACCESS_LANE,
    currentInputHash,
    state: "cooldown",
    reasonCode: input.failure.kind,
    failureFingerprint: stableFailureFingerprint(
      input.manifest.id,
      input.failure.kind,
      failureCode,
    ),
    nextEligibleAt: new Date(now.getTime() + cooldownMs),
    now,
  });
}

export async function recordSourceDocumentAccessRecovery(input: {
  readonly database: D1Database;
  readonly manifest: SourceManifest;
  readonly now?: Date;
}): Promise<SourceAccessStateRow> {
  const eligibility = await checkSourceDocumentAccess(input);
  if (!eligibility.eligible) return eligibility.row;
  return recordSourceAccessSuccess({
    database: input.database,
    sourceId: input.manifest.id,
    laneKey: SOURCE_DOCUMENT_ACCESS_LANE,
    currentInputHash: sourceDocumentAccessInputHash(input.manifest),
    now: input.now,
  });
}

/** Parses only the standard bounded delay-seconds or HTTP-date forms. */
export function parseSourceRetryAfterMs(
  value: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 64) return null;
  if (/^(?:0|[1-9]\d*)$/u.test(normalized)) {
    const milliseconds = Number(normalized) * 1_000;
    return Number.isSafeInteger(milliseconds) &&
        milliseconds > 0 && milliseconds <= MAX_RETRY_AFTER_MS
      ? milliseconds
      : null;
  }
  const nowMs = validDate(now).getTime();
  const targetMs = Date.parse(normalized);
  if (!Number.isFinite(targetMs)) return null;
  const milliseconds = Math.ceil(targetMs - nowMs);
  return Number.isSafeInteger(milliseconds) &&
      milliseconds > 0 && milliseconds <= MAX_RETRY_AFTER_MS
    ? milliseconds
    : null;
}

function stableFailureFingerprint(
  sourceId: string,
  kind: SourceDocumentAccessFailureKind,
  failureCode: string,
): string {
  return stableContentHash({
    contract: "source-document-access-failure-v1",
    sourceId,
    laneKey: SOURCE_DOCUMENT_ACCESS_LANE,
    kind,
    failureCode,
  });
}

function boundedFailureCode(value: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 128 ||
    !/^[a-z0-9][a-z0-9._:-]*$/u.test(value)
  ) {
    throw new RangeError("source access failure code is invalid");
  }
  return value;
}

function boundedRetryAfterMs(value: number): number {
  if (
    !Number.isSafeInteger(value) || value < 1 || value > MAX_RETRY_AFTER_MS
  ) {
    throw new RangeError("source access Retry-After duration is invalid");
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError("source access outcome time is invalid");
  }
  return value;
}
