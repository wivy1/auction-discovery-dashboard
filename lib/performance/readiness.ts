import type {
  PerformanceFeatureName,
  PerformanceFeatureReadiness,
} from "./features";

export const PIPELINE_AUDIT_SCHEMA_VERSION = 44 as const;

export const ENRICHMENT_SESSION_EXECUTION_EVIDENCE_FEATURE =
  "enrichmentSessionResidencyExecutionEvidence" as const;
export const ENRICHMENT_SESSION_CONTRACT_EVIDENCE_FEATURE =
  "enrichmentSessionResidencyContractEvidence" as const;
export const DASHBOARD_RELEASE_PRIME_EVIDENCE_FEATURE =
  "dashboardReleasePrimeExecutionEvidence" as const;
export const UNIFIED_SOURCE_SCHEDULER_EXECUTION_EVIDENCE_FEATURE =
  "unifiedSourceSchedulerExecutionEvidence" as const;
export const PREPARATION_SCHEDULER_EXECUTION_EVIDENCE_FEATURE =
  "preparationSchedulerExecutionEvidence" as const;
export const ENRICHMENT_SESSION_EXECUTION_EVIDENCE_DERIVATION_VERSION =
  "enrichment-session-execution-evidence-v1" as const;
export const ENRICHMENT_SESSION_CONTRACT_EVIDENCE_DERIVATION_VERSION =
  "enrichment-session-contract-evidence-v1" as const;
export const DASHBOARD_RELEASE_PRIME_EVIDENCE_DERIVATION_VERSION =
  "dashboard-release-prime-execution-evidence-v1" as const;

export const PERFORMANCE_IMPLEMENTATION_EVIDENCE_FEATURE_NAMES = [
  ENRICHMENT_SESSION_EXECUTION_EVIDENCE_FEATURE,
  ENRICHMENT_SESSION_CONTRACT_EVIDENCE_FEATURE,
  DASHBOARD_RELEASE_PRIME_EVIDENCE_FEATURE,
  UNIFIED_SOURCE_SCHEDULER_EXECUTION_EVIDENCE_FEATURE,
  PREPARATION_SCHEDULER_EXECUTION_EVIDENCE_FEATURE,
] as const;

export type PerformanceImplementationEvidenceFeatureName =
  (typeof PERFORMANCE_IMPLEMENTATION_EVIDENCE_FEATURE_NAMES)[number];

export type PipelineAuditFeatureName =
  | PerformanceFeatureName
  | PerformanceImplementationEvidenceFeatureName;

export type PipelineAuditReceiptKind =
  | "rebuild"
  | "full_audit"
  | "shadow_pass"
  | "readiness"
  | "mismatch";

export interface PipelineAuditReceiptInput {
  readonly receiptId: string;
  readonly receiptKind: PipelineAuditReceiptKind;
  readonly featureName: PipelineAuditFeatureName;
  readonly schemaVersion?: number;
  readonly derivationVersion: string;
  readonly beforeGenerationVectorHash: string;
  readonly afterGenerationVectorHash: string;
  readonly canonicalCount: number;
  readonly canonicalOrderedHash: string;
  readonly projectionCount: number;
  readonly projectionOrderedHash: string;
  readonly queueCount: number;
  readonly queueOrderedHash: string;
  readonly mismatchCount: number;
  readonly differingIdsHash?: string | null;
  readonly copiedDatabaseIdentity?: string | null;
  readonly shadowPassCount?: number;
  readonly readinessGranted?: boolean;
  readonly priorReceiptId?: string | null;
  readonly completedAt: string;
}

export interface PipelineAuditReceipt {
  readonly receiptId: string;
  readonly receiptKind: PipelineAuditReceiptKind;
  readonly featureName: string;
  readonly schemaVersion: number;
  readonly derivationVersion: string;
  readonly beforeGenerationVectorHash: string;
  readonly afterGenerationVectorHash: string;
  readonly canonicalCount: number;
  readonly canonicalOrderedHash: string;
  readonly projectionCount: number;
  readonly projectionOrderedHash: string;
  readonly queueCount: number;
  readonly queueOrderedHash: string;
  readonly mismatchCount: number;
  readonly differingIdsHash: string | null;
  readonly copiedDatabaseIdentity: string | null;
  readonly shadowPassCount: number;
  readonly readinessGranted: boolean;
  readonly priorReceiptId: string | null;
  readonly completedAt: string;
}

interface PipelineAuditReceiptRow {
  receipt_id: string;
  receipt_kind: PipelineAuditReceiptKind;
  feature_name: string;
  schema_version: number;
  derivation_version: string;
  before_generation_vector_hash: string;
  after_generation_vector_hash: string;
  canonical_count: number;
  canonical_ordered_hash: string;
  projection_count: number;
  projection_ordered_hash: string;
  queue_count: number;
  queue_ordered_hash: string;
  mismatch_count: number;
  differing_ids_hash: string | null;
  copied_database_identity: string | null;
  shadow_pass_count: number;
  readiness_granted: number;
  prior_receipt_id: string | null;
  completed_at: string;
}

export async function appendPipelineAuditReceipt(
  database: D1Database,
  input: PipelineAuditReceiptInput,
): Promise<void> {
  validateAuditReceipt(input);
  await preparePipelineAuditReceiptInsert(database, input).run();
}

/** Prepares the validated insert so a caller can batch it with an exact link. */
export function preparePipelineAuditReceiptInsert(
  database: D1Database,
  input: PipelineAuditReceiptInput,
): D1PreparedStatement {
  validateAuditReceipt(input);
  return database.prepare(`
    INSERT INTO pipeline_audit_receipts (
      receipt_id, receipt_kind, feature_name, schema_version,
      derivation_version, before_generation_vector_hash,
      after_generation_vector_hash, canonical_count,
      canonical_ordered_hash, projection_count, projection_ordered_hash,
      queue_count, queue_ordered_hash, mismatch_count, differing_ids_hash,
      copied_database_identity, shadow_pass_count, readiness_granted,
      prior_receipt_id, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    input.receiptId,
    input.receiptKind,
    input.featureName,
    input.schemaVersion ?? PIPELINE_AUDIT_SCHEMA_VERSION,
    input.derivationVersion,
    input.beforeGenerationVectorHash,
    input.afterGenerationVectorHash,
    input.canonicalCount,
    input.canonicalOrderedHash,
    input.projectionCount,
    input.projectionOrderedHash,
    input.queueCount,
    input.queueOrderedHash,
    input.mismatchCount,
    input.differingIdsHash ?? null,
    input.copiedDatabaseIdentity ?? null,
    input.shadowPassCount ?? 0,
    input.readinessGranted ? 1 : 0,
    input.priorReceiptId ?? null,
    canonicalIsoTimestamp(input.completedAt, "completedAt"),
  );
}

export async function readLatestPipelineAuditReceipt(
  database: D1Database,
  featureName: PipelineAuditFeatureName,
): Promise<PipelineAuditReceipt | null> {
  const row = await database.prepare(`
    SELECT
      receipt_id, receipt_kind, feature_name, schema_version,
      derivation_version, before_generation_vector_hash,
      after_generation_vector_hash, canonical_count,
      canonical_ordered_hash, projection_count, projection_ordered_hash,
      queue_count, queue_ordered_hash, mismatch_count, differing_ids_hash,
      copied_database_identity, shadow_pass_count, readiness_granted,
      prior_receipt_id, completed_at
    FROM pipeline_audit_receipts
    WHERE feature_name = ?
    ORDER BY rowid DESC
    LIMIT 1
  `).bind(featureName).first<PipelineAuditReceiptRow>();
  return row ? auditReceiptFromRow(row) : null;
}

/**
 * Appends one deterministic implementation-evidence receipt, or returns the
 * immutable row already bound to the same receipt identity. Completion time is
 * intentionally first-writer provenance and is not part of retry equality.
 */
export async function appendIdempotentPipelineAuditReceipt(
  database: D1Database,
  input: PipelineAuditReceiptInput,
): Promise<{ readonly receipt: PipelineAuditReceipt; readonly idempotent: boolean }> {
  validateAuditReceipt(input);
  const existing = await readPipelineAuditReceipt(database, input.receiptId);
  if (existing !== null) {
    assertReceiptSemantics(existing, input);
    return Object.freeze({ receipt: existing, idempotent: true });
  }
  await appendPipelineAuditReceipt(database, input);
  const receipt = await readPipelineAuditReceipt(database, input.receiptId);
  if (receipt === null) throw new Error("pipeline audit receipt append was not observable");
  assertReceiptSemantics(receipt, input);
  return Object.freeze({ receipt, idempotent: false });
}

export async function readPipelineAuditReceipt(
  database: D1Database,
  receiptId: string,
): Promise<PipelineAuditReceipt | null> {
  requiredIdentity(receiptId, "receiptId");
  const row = await database.prepare(`
    SELECT
      receipt_id, receipt_kind, feature_name, schema_version,
      derivation_version, before_generation_vector_hash,
      after_generation_vector_hash, canonical_count,
      canonical_ordered_hash, projection_count, projection_ordered_hash,
      queue_count, queue_ordered_hash, mismatch_count, differing_ids_hash,
      copied_database_identity, shadow_pass_count, readiness_granted,
      prior_receipt_id, completed_at
    FROM pipeline_audit_receipts
    WHERE receipt_id = ?
    LIMIT 1
  `).bind(receiptId).first<PipelineAuditReceiptRow>();
  return row ? auditReceiptFromRow(row) : null;
}

/**
 * A later mismatch or ordinary audit supersedes an older readiness receipt.
 * `auto` therefore activates only when the latest receipt is the exact current
 * readiness proof, not merely when some historical success exists.
 */
export async function readPerformanceFeatureReadiness(input: {
  readonly database: D1Database;
  readonly featureName: PerformanceFeatureName;
  readonly derivationVersion: string;
  readonly generationVectorHash: string;
  readonly schemaVersion?: number;
  readonly implementationAvailable?: boolean;
}): Promise<PerformanceFeatureReadiness> {
  const implementationAvailable = input.implementationAvailable ?? true;
  if (!implementationAvailable) {
    return Object.freeze({
      ready: false,
      implementationAvailable: false,
      receiptIdentity: null,
    });
  }
  const receipt = await readLatestPipelineAuditReceipt(
    input.database,
    input.featureName,
  );
  const receiptContractMatches = Boolean(
    receipt &&
      receipt.receiptKind === "readiness" &&
      receipt.readinessGranted &&
      receipt.schemaVersion ===
        (input.schemaVersion ?? PIPELINE_AUDIT_SCHEMA_VERSION) &&
      receipt.derivationVersion === input.derivationVersion &&
      receipt.beforeGenerationVectorHash === input.generationVectorHash &&
      receipt.afterGenerationVectorHash === input.generationVectorHash &&
      receipt.mismatchCount === 0 &&
      receipt.canonicalCount === receipt.projectionCount &&
      receipt.canonicalOrderedHash === receipt.projectionOrderedHash &&
      receipt.shadowPassCount >= 3,
  );
  const ready = receiptContractMatches && receipt !== null &&
    await hasThreeConsecutiveStableShadowPasses(input.database, receipt);
  return Object.freeze({
    ready,
    implementationAvailable: true,
    receiptIdentity: ready ? receipt!.receiptId : null,
  });
}

async function hasThreeConsecutiveStableShadowPasses(
  database: D1Database,
  readiness: PipelineAuditReceipt,
): Promise<boolean> {
  let next: PipelineAuditReceipt = readiness;
  const seen = new Set([readiness.receiptId]);
  let newestShadowPassCount: number | null = null;
  for (let pass = 0; pass < 3; pass += 1) {
    if (next.priorReceiptId === null) return false;
    if (seen.has(next.priorReceiptId)) return false;
    const shadow = await readPipelineAuditReceipt(database, next.priorReceiptId);
    if (
      shadow === null || shadow.featureName !== readiness.featureName ||
      shadow.receiptKind !== "shadow_pass" || shadow.readinessGranted ||
      shadow.schemaVersion !== readiness.schemaVersion ||
      shadow.derivationVersion !== readiness.derivationVersion ||
      shadow.beforeGenerationVectorHash !== readiness.beforeGenerationVectorHash ||
      shadow.afterGenerationVectorHash !== readiness.afterGenerationVectorHash ||
      shadow.mismatchCount !== 0 ||
      shadow.canonicalCount !== readiness.canonicalCount ||
      shadow.projectionCount !== readiness.projectionCount ||
      shadow.canonicalOrderedHash !== readiness.canonicalOrderedHash ||
      shadow.projectionOrderedHash !== readiness.projectionOrderedHash ||
      shadow.queueCount !== readiness.queueCount ||
      shadow.queueOrderedHash !== readiness.queueOrderedHash ||
      shadow.copiedDatabaseIdentity !== readiness.copiedDatabaseIdentity
    ) return false;
    if (pass === 0) {
      if (shadow.shadowPassCount < 3) return false;
      newestShadowPassCount = shadow.shadowPassCount;
    } else if (shadow.shadowPassCount !== newestShadowPassCount! - pass) {
      return false;
    }
    seen.add(shadow.receiptId);
    next = shadow;
  }
  return true;
}

function auditReceiptFromRow(row: PipelineAuditReceiptRow): PipelineAuditReceipt {
  return Object.freeze({
    receiptId: row.receipt_id,
    receiptKind: row.receipt_kind,
    featureName: row.feature_name,
    schemaVersion: Number(row.schema_version),
    derivationVersion: row.derivation_version,
    beforeGenerationVectorHash: row.before_generation_vector_hash,
    afterGenerationVectorHash: row.after_generation_vector_hash,
    canonicalCount: Number(row.canonical_count),
    canonicalOrderedHash: row.canonical_ordered_hash,
    projectionCount: Number(row.projection_count),
    projectionOrderedHash: row.projection_ordered_hash,
    queueCount: Number(row.queue_count),
    queueOrderedHash: row.queue_ordered_hash,
    mismatchCount: Number(row.mismatch_count),
    differingIdsHash: row.differing_ids_hash,
    copiedDatabaseIdentity: row.copied_database_identity,
    shadowPassCount: Number(row.shadow_pass_count),
    readinessGranted: Number(row.readiness_granted) === 1,
    priorReceiptId: row.prior_receipt_id,
    completedAt: row.completed_at,
  });
}

function validateAuditReceipt(input: PipelineAuditReceiptInput): void {
  requiredIdentity(input.receiptId, "receiptId");
  requiredIdentity(input.featureName, "featureName");
  requiredIdentity(input.derivationVersion, "derivationVersion");
  requiredIdentity(input.beforeGenerationVectorHash, "beforeGenerationVectorHash");
  requiredIdentity(input.afterGenerationVectorHash, "afterGenerationVectorHash");
  requiredIdentity(input.canonicalOrderedHash, "canonicalOrderedHash");
  requiredIdentity(input.projectionOrderedHash, "projectionOrderedHash");
  requiredIdentity(input.queueOrderedHash, "queueOrderedHash");
  for (const [name, value] of [
    ["canonicalCount", input.canonicalCount],
    ["projectionCount", input.projectionCount],
    ["queueCount", input.queueCount],
    ["mismatchCount", input.mismatchCount],
    ["shadowPassCount", input.shadowPassCount ?? 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${name} must be a nonnegative safe integer`);
    }
  }
  const schemaVersion = input.schemaVersion ?? PIPELINE_AUDIT_SCHEMA_VERSION;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 39) {
    throw new RangeError("schemaVersion must be at least 39");
  }
  if (input.readinessGranted && !(
    input.receiptKind === "readiness" &&
    input.mismatchCount === 0 &&
    input.beforeGenerationVectorHash === input.afterGenerationVectorHash &&
    input.canonicalCount === input.projectionCount &&
    input.canonicalOrderedHash === input.projectionOrderedHash &&
    (input.shadowPassCount ?? 0) >= 3
  )) {
    throw new Error("readiness receipt does not prove exact stable parity");
  }
}

function assertReceiptSemantics(
  receipt: PipelineAuditReceipt,
  input: PipelineAuditReceiptInput,
): void {
  const expected = {
    receiptKind: input.receiptKind,
    featureName: input.featureName,
    schemaVersion: input.schemaVersion ?? PIPELINE_AUDIT_SCHEMA_VERSION,
    derivationVersion: input.derivationVersion,
    beforeGenerationVectorHash: input.beforeGenerationVectorHash,
    afterGenerationVectorHash: input.afterGenerationVectorHash,
    canonicalCount: input.canonicalCount,
    canonicalOrderedHash: input.canonicalOrderedHash,
    projectionCount: input.projectionCount,
    projectionOrderedHash: input.projectionOrderedHash,
    queueCount: input.queueCount,
    queueOrderedHash: input.queueOrderedHash,
    mismatchCount: input.mismatchCount,
    differingIdsHash: input.differingIdsHash ?? null,
    copiedDatabaseIdentity: input.copiedDatabaseIdentity ?? null,
    shadowPassCount: input.shadowPassCount ?? 0,
    readinessGranted: input.readinessGranted ?? false,
    priorReceiptId: input.priorReceiptId ?? null,
  } as const;
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key as keyof PipelineAuditReceipt] !== value) {
      throw new Error(
        `pipeline audit identity ${receipt.receiptId} already binds different ${key}`,
      );
    }
  }
}

function requiredIdentity(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} is not a bounded canonical identity`);
  }
  return value;
}

function canonicalIsoTimestamp(value: string, name: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${name} must be a canonical UTC ISO timestamp`);
  }
  return value;
}
