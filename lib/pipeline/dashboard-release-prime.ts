import type { PerformanceFeatureDecision } from "../performance/features";
import { hashCanonicalJson } from "../performance/generations";
import {
  appendIdempotentPipelineAuditReceipt,
  DASHBOARD_RELEASE_PRIME_EVIDENCE_DERIVATION_VERSION,
  DASHBOARD_RELEASE_PRIME_EVIDENCE_FEATURE,
  readLatestPipelineAuditReceipt,
  readPipelineAuditReceipt,
  type PipelineAuditReceipt,
} from "../performance/readiness";
export {
  DASHBOARD_RELEASE_PRIME_EVIDENCE_DERIVATION_VERSION,
  DASHBOARD_RELEASE_PRIME_EVIDENCE_FEATURE,
} from "../performance/readiness";
import {
  readDashboardReleaseVector,
  type DashboardReleaseVector,
} from "./source-release-state";

export const DASHBOARD_RELEASE_PRIME_DERIVATION_VERSION =
  "dashboard-release-prime-v2" as const;

export type DashboardReleasePrimePath =
  | "canonical"
  | "canonical_unsettled"
  | "canonical_raced"
  | "shadow"
  | "optimized_hit"
  | "optimized_fill";

export interface DashboardReleasePrimeRead<T> {
  readonly payload: T;
  readonly path: DashboardReleasePrimePath;
  readonly vector: DashboardReleaseVector | null;
  readonly evidenceReceiptId: string | null;
}

interface DashboardPayloadCacheEntry<T = unknown> {
  readonly vectorHash: string;
  readonly payload: T;
  readonly payloadHash: string;
  readonly fillReceiptId: string;
}

const dashboardPayloadCache = new WeakMap<
  object,
  Map<string, DashboardPayloadCacheEntry>
>();

/** Test/operational kill-switch support without invalidating canonical data. */
export function clearDashboardReleasePrimeCache(database?: D1Database): void {
  if (database) dashboardPayloadCache.delete(database);
}

/**
 * Reuses a byte/structure-identical payload only for the exact settled vector.
 * The second vector read is the bind fence: a canonical read that raced an
 * invalidation is returned to its caller but never installed as current.
 */
export async function readWithDashboardReleasePrime<T>(input: {
  readonly database: D1Database;
  readonly cacheKey: string;
  readonly decision: PerformanceFeatureDecision;
  readonly canonicalRead: (
    vector: DashboardReleaseVector | null,
  ) => Promise<T>;
  readonly initialVector?: DashboardReleaseVector;
  readonly readVector?: (
    database: D1Database,
  ) => Promise<DashboardReleaseVector>;
  readonly now?: () => Date;
}): Promise<DashboardReleasePrimeRead<T>> {
  const readVector = input.readVector ?? readDashboardReleaseVector;
  const now = input.now ?? (() => new Date());
  if (input.decision === "canonical") {
    return Object.freeze({
      payload: await input.canonicalRead(null),
      path: "canonical" as const,
      vector: null,
      evidenceReceiptId: null,
    });
  }

  const before = input.initialVector ?? await readVector(input.database);
  if (input.decision === "shadow") {
    return Object.freeze({
      payload: await input.canonicalRead(before),
      path: "shadow" as const,
      vector: before,
      evidenceReceiptId: null,
    });
  }
  if (!before.complete || !before.settled || before.hasActivePipelineLease) {
    const payload = await input.canonicalRead(before);
    const evidence = await appendDashboardReleasePrimeEvidence({
      database: input.database,
      path: "canonical_unsettled",
      cacheKey: input.cacheKey,
      before,
      after: before,
      canonicalPayloadHash: await hashCanonicalJson(payload),
      cachedPayloadHash: null,
      reconstructionCount: 1,
      fillReceiptId: null,
      completedAt: now(),
    });
    return Object.freeze({
      payload,
      path: "canonical_unsettled" as const,
      vector: before,
      evidenceReceiptId: evidence.receiptId,
    });
  }

  const cached = dashboardPayloadCache.get(input.database)?.get(input.cacheKey);
  if (cached?.vectorHash === before.vectorHash) {
    const evidence = await appendDashboardReleasePrimeEvidence({
      database: input.database,
      path: "optimized_hit",
      cacheKey: input.cacheKey,
      before,
      after: before,
      canonicalPayloadHash: cached.payloadHash,
      cachedPayloadHash: cached.payloadHash,
      reconstructionCount: 0,
      fillReceiptId: cached.fillReceiptId,
      completedAt: now(),
    });
    return Object.freeze({
      payload: cached.payload as T,
      path: "optimized_hit" as const,
      vector: before,
      evidenceReceiptId: evidence.receiptId,
    });
  }

  const payload = await input.canonicalRead(before);
  const payloadHash = await hashCanonicalJson(payload);
  const after = await readVector(input.database);
  if (
    after.vectorHash !== before.vectorHash ||
    !after.complete ||
      !after.settled ||
      after.hasActivePipelineLease
  ) {
    const evidence = await appendDashboardReleasePrimeEvidence({
      database: input.database,
      path: "canonical_raced",
      cacheKey: input.cacheKey,
      before,
      after,
      canonicalPayloadHash: payloadHash,
      cachedPayloadHash: null,
      reconstructionCount: 1,
      fillReceiptId: null,
      completedAt: now(),
    });
    return Object.freeze({
      payload,
      path: "canonical_raced" as const,
      vector: after,
      evidenceReceiptId: evidence.receiptId,
    });
  }
  const fillEvidence = await appendDashboardReleasePrimeEvidence({
    database: input.database,
    path: "optimized_fill",
    cacheKey: input.cacheKey,
    before,
    after,
    canonicalPayloadHash: payloadHash,
    cachedPayloadHash: payloadHash,
    reconstructionCount: 1,
    fillReceiptId: null,
    completedAt: now(),
  });
  const next = new Map(dashboardPayloadCache.get(input.database) ?? []);
  next.set(input.cacheKey, Object.freeze({
    vectorHash: after.vectorHash,
    payload,
    payloadHash,
    fillReceiptId: fillEvidence.receiptId,
  }));
  dashboardPayloadCache.set(input.database, next);
  return Object.freeze({
    payload,
    path: "optimized_fill" as const,
    vector: after,
    evidenceReceiptId: fillEvidence.receiptId,
  });
}

async function appendDashboardReleasePrimeEvidence(input: {
  readonly database: D1Database;
  readonly path: Extract<
    DashboardReleasePrimePath,
    "canonical_unsettled" | "canonical_raced" | "optimized_hit" | "optimized_fill"
  >;
  readonly cacheKey: string;
  readonly before: DashboardReleaseVector;
  readonly after: DashboardReleaseVector;
  readonly canonicalPayloadHash: string;
  readonly cachedPayloadHash: string | null;
  readonly reconstructionCount: number;
  readonly fillReceiptId: string | null;
  readonly completedAt: Date;
}): Promise<PipelineAuditReceipt> {
  const cacheKeyHash = await hashCanonicalJson(input.cacheKey);
  const emptyPayloadHash = await hashCanonicalJson(null);
  const optimizedPayloadHash = input.cachedPayloadHash ?? emptyPayloadHash;
  const execution = Object.freeze({
    path: input.path,
    cacheKeyHash,
    beforeReleaseVectorHash: input.before.vectorHash,
    afterReleaseVectorHash: input.after.vectorHash,
    canonicalPayloadHash: input.canonicalPayloadHash,
    cachedPayloadHash: optimizedPayloadHash,
    reconstructionCount: input.reconstructionCount,
    fillReceiptId: input.fillReceiptId,
  });
  const prior = input.path === "optimized_hit" && input.fillReceiptId !== null
    ? await readLatestCompatibleFill(input.database, input.fillReceiptId)
    : await readLatestPipelineAuditReceipt(
        input.database,
        DASHBOARD_RELEASE_PRIME_EVIDENCE_FEATURE,
      );
  const successful = (input.path === "optimized_fill" || input.path === "optimized_hit") &&
    input.before.vectorHash === input.after.vectorHash &&
    input.canonicalPayloadHash === optimizedPayloadHash &&
    input.before.complete && input.before.settled && !input.before.hasActivePipelineLease &&
    input.after.complete && input.after.settled && !input.after.hasActivePipelineLease &&
    input.reconstructionCount === (input.path === "optimized_hit" ? 0 : 1) &&
    (input.path !== "optimized_hit" || prior !== null);
  const receiptId = `dashboard-prime-evidence:${(
    await hashCanonicalJson({
      derivationVersion: DASHBOARD_RELEASE_PRIME_EVIDENCE_DERIVATION_VERSION,
      execution,
    })
  ).slice("sha256:".length)}`;
  const appended = await appendIdempotentPipelineAuditReceipt(input.database, {
    receiptId,
    receiptKind: successful ? "full_audit" : "mismatch",
    featureName: DASHBOARD_RELEASE_PRIME_EVIDENCE_FEATURE,
    derivationVersion:
      `${DASHBOARD_RELEASE_PRIME_EVIDENCE_DERIVATION_VERSION}:${input.path}`,
    beforeGenerationVectorHash: input.before.vectorHash,
    afterGenerationVectorHash: input.after.vectorHash,
    canonicalCount: input.reconstructionCount,
    canonicalOrderedHash: input.canonicalPayloadHash,
    projectionCount: input.reconstructionCount,
    projectionOrderedHash: optimizedPayloadHash,
    // Bind one sanitized cache identity so a hit is independently comparable
    // with its fill without persisting the raw dashboard key.
    queueCount: 1,
    queueOrderedHash: cacheKeyHash,
    mismatchCount: successful ? 0 : 1,
    differingIdsHash: successful ? null : await hashCanonicalJson({
      path: input.path,
      beforeReleaseVectorHash: input.before.vectorHash,
      afterReleaseVectorHash: input.after.vectorHash,
    }),
    priorReceiptId: prior?.receiptId ?? null,
    completedAt: canonicalTimestamp(input.completedAt),
  });
  return appended.receipt;
}

async function readLatestCompatibleFill(
  database: D1Database,
  fillReceiptId: string,
): Promise<PipelineAuditReceipt | null> {
  const receipt = await readPipelineAuditReceipt(database, fillReceiptId);
  if (
    receipt === null ||
    receipt.featureName !== DASHBOARD_RELEASE_PRIME_EVIDENCE_FEATURE ||
    receipt.derivationVersion !==
      `${DASHBOARD_RELEASE_PRIME_EVIDENCE_DERIVATION_VERSION}:optimized_fill` ||
    receipt.receiptKind !== "full_audit" || receipt.mismatchCount !== 0
  ) return null;
  return receipt;
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError("dashboard release evidence completion time is invalid");
  }
  return value.toISOString();
}
