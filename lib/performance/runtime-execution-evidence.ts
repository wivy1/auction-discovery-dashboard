import type {
  SchedulerComponentExecutionEvidence,
  SchedulerExecutionEvidence,
} from "../scheduler/types";
import {
  hashCanonicalJson,
  readCompactPipelineGenerationVector,
  serializeCanonicalJson,
} from "./generations";

export const RUNTIME_EXECUTION_EVIDENCE_SCHEMA_VERSION =
  "auction-discovery-runtime-execution-evidence-v2" as const;
export const DERIVED_COPY_EXECUTION_PROVENANCE_SCHEMA_VERSION =
  "auction-discovery-derived-copy-execution-provenance-v1" as const;
export const DERIVED_COPY_EXECUTION_SCENARIO_DERIVATION_VERSION =
  "derived-generation-bound-empty-runtime-receipts-v1" as const;
export const DERIVED_COPY_EXECUTION_WRITE_AUTHORIZER_CONTRACT =
  "sqlite-authorizer:pipeline-execution-evidence-only-v1" as const;
export const DERIVED_COPY_EXECUTION_QUEUE_REMOVAL_CONTRACT =
  "derived-queue-removal-after-active-origin-generation-v1" as const;

export const RUNTIME_EXECUTION_EVIDENCE_KINDS = Object.freeze([
  "unified_source_scheduler",
  "preparation_scheduler",
] as const);
export type RuntimeExecutionEvidenceKind =
  (typeof RUNTIME_EXECUTION_EVIDENCE_KINDS)[number];

export interface DerivedCopyExecutionProvenance {
  readonly schemaVersion:
    typeof DERIVED_COPY_EXECUTION_PROVENANCE_SCHEMA_VERSION;
  readonly sourceDatabaseFileSetIdentity: string;
  readonly sourceGenerationVectorHash: string;
  readonly derivedDatabaseFileSetIdentity: string;
  readonly derivedGenerationVectorHash: string;
  readonly scenarioDerivationVersion:
    typeof DERIVED_COPY_EXECUTION_SCENARIO_DERIVATION_VERSION;
  readonly scenarioIdentityHash: string;
  readonly writeAuthorizerContractIdentity:
    typeof DERIVED_COPY_EXECUTION_WRITE_AUTHORIZER_CONTRACT;
  readonly queueRemovalContractIdentity:
    typeof DERIVED_COPY_EXECUTION_QUEUE_REMOVAL_CONTRACT;
  readonly derivedInvocationGroupIdentityHash: string;
  readonly derivedExecutionReceiptId: string;
  readonly derivedEvidenceIdentityHash: string;
  readonly derivedExecutionIdentityHash: string;
}

export interface DerivedCopyExecutionTransportBinding {
  readonly sourceDatabaseFileSetIdentity: string;
  readonly sourceGenerationVectorHash: string;
  readonly derivedDatabaseFileSetIdentity: string;
  readonly derivedGenerationVectorHash: string;
  readonly scenarioDerivationVersion:
    typeof DERIVED_COPY_EXECUTION_SCENARIO_DERIVATION_VERSION;
  readonly scenarioIdentityHash: string;
  readonly writeAuthorizerContractIdentity:
    typeof DERIVED_COPY_EXECUTION_WRITE_AUTHORIZER_CONTRACT;
  readonly queueRemovalContractIdentity:
    typeof DERIVED_COPY_EXECUTION_QUEUE_REMOVAL_CONTRACT;
  readonly derivedInvocationGroupIdentityHash: string;
}

export interface RuntimeExecutionEvidenceEnvelope<Payload = unknown> {
  readonly schemaVersion: typeof RUNTIME_EXECUTION_EVIDENCE_SCHEMA_VERSION;
  readonly evidenceKind: RuntimeExecutionEvidenceKind;
  readonly derivationVersion: string;
  readonly evidenceIdentityHash: string;
  readonly executionIdentityHash: string;
  readonly invocationIdentityHash: string;
  readonly inputGenerationVectorHash: string;
  readonly inputBoundaryHash: string;
  readonly outputBoundaryHash: string;
  readonly payload: Payload;
  readonly derivedCopyProvenance?: DerivedCopyExecutionProvenance;
}

export interface RuntimeExecutionEvidenceRow<Payload = unknown>
  extends RuntimeExecutionEvidenceEnvelope<Payload> {
  readonly executionReceiptId: string;
  readonly completedAt: string;
}

export interface RuntimeExecutionEvidenceReceiptResult {
  readonly receiptId: string;
  readonly evidenceIdentityHash: string;
  readonly executionIdentityHash: string;
  readonly idempotent: boolean;
}

export interface DerivedCopyExecutionImportResult {
  readonly idempotent: boolean;
  readonly unifiedSourceScheduler: RuntimeExecutionEvidenceReceiptResult;
  readonly preparationScheduler: RuntimeExecutionEvidenceReceiptResult;
}

interface ExecutionEvidenceDatabaseRow {
  execution_receipt_id: string;
  evidence_kind: RuntimeExecutionEvidenceKind;
  evidence_schema_version: string;
  derivation_version: string;
  evidence_identity_hash: string;
  execution_identity_hash: string;
  invocation_identity_hash: string;
  input_generation_vector_hash: string;
  input_boundary_hash: string;
  output_boundary_hash: string;
  evidence_json: string;
  completed_at: string;
}

const LOCAL_ENVELOPE_KEYS = Object.freeze([
  "schemaVersion", "evidenceKind", "derivationVersion", "evidenceIdentityHash",
  "executionIdentityHash", "invocationIdentityHash", "inputGenerationVectorHash",
  "inputBoundaryHash", "outputBoundaryHash", "payload",
] as const);
const DERIVED_ENVELOPE_KEYS = Object.freeze([
  ...LOCAL_ENVELOPE_KEYS,
  "derivedCopyProvenance",
] as const);
const DERIVED_PROVENANCE_KEYS = Object.freeze([
  "schemaVersion", "sourceDatabaseFileSetIdentity",
  "sourceGenerationVectorHash", "derivedDatabaseFileSetIdentity",
  "derivedGenerationVectorHash", "scenarioDerivationVersion",
  "scenarioIdentityHash", "writeAuthorizerContractIdentity",
  "queueRemovalContractIdentity", "derivedInvocationGroupIdentityHash",
  "derivedExecutionReceiptId", "derivedEvidenceIdentityHash",
  "derivedExecutionIdentityHash",
] as const);
const DERIVED_TRANSPORT_BINDING_KEYS = Object.freeze([
  "sourceDatabaseFileSetIdentity", "sourceGenerationVectorHash",
  "derivedDatabaseFileSetIdentity", "derivedGenerationVectorHash",
  "scenarioDerivationVersion", "scenarioIdentityHash",
  "writeAuthorizerContractIdentity", "queueRemovalContractIdentity",
  "derivedInvocationGroupIdentityHash",
] as const);
const MAX_EVIDENCE_BYTES = 65_536;

export async function appendSchedulerExecutionEvidence(input: {
  readonly database: D1Database;
  readonly evidence: SchedulerExecutionEvidence;
  readonly invocationIdentityHash: string;
  readonly completedAt: string;
}): Promise<Readonly<{
  unifiedSourceScheduler: RuntimeExecutionEvidenceReceiptResult;
  preparationScheduler: RuntimeExecutionEvidenceReceiptResult;
}>> {
  validateSchedulerEvidence(input.evidence);
  sha256(input.invocationIdentityHash, "scheduler invocationIdentityHash");
  const completedAt = canonicalTimestamp(input.completedAt, "completedAt");
  const unified = await schedulerEnvelope(
    "unified_source_scheduler",
    input.evidence.unifiedSourceScheduler,
    input.invocationIdentityHash,
  );
  const preparation = await schedulerEnvelope(
    "preparation_scheduler",
    input.evidence.preparationScheduler,
    input.invocationIdentityHash,
  );
  const [unifiedSourceScheduler, preparationScheduler] =
    await appendEnvelopesAtomically(input.database, [
      { envelope: unified, completedAt },
      { envelope: preparation, completedAt },
    ]);
  return Object.freeze({
    unifiedSourceScheduler: unifiedSourceScheduler!,
    preparationScheduler: preparationScheduler!,
  });
}

export async function createRuntimeExecutionEvidenceEnvelope<Payload>(input: {
  readonly evidenceKind: RuntimeExecutionEvidenceKind;
  readonly derivationVersion: string;
  readonly invocationIdentityHash: string;
  readonly inputGenerationVectorHash: string;
  readonly inputBoundaryHash: string;
  readonly outputBoundaryHash: string;
  readonly payload: Payload;
  readonly derivedCopyProvenance?: never;
}): Promise<RuntimeExecutionEvidenceEnvelope<Payload>> {
  if ("derivedCopyProvenance" in input) {
    throw new Error("derived copy provenance may be created only by validated transport");
  }
  return createRuntimeExecutionEvidenceEnvelopeInternal(input);
}

async function createRuntimeExecutionEvidenceEnvelopeInternal<Payload>(input: {
  readonly evidenceKind: RuntimeExecutionEvidenceKind;
  readonly derivationVersion: string;
  readonly invocationIdentityHash: string;
  readonly inputGenerationVectorHash: string;
  readonly inputBoundaryHash: string;
  readonly outputBoundaryHash: string;
  readonly payload: Payload;
  readonly derivedCopyProvenance?: DerivedCopyExecutionProvenance;
}): Promise<RuntimeExecutionEvidenceEnvelope<Payload>> {
  evidenceKind(input.evidenceKind);
  boundedIdentity(input.derivationVersion, "derivationVersion", 256);
  sha256(input.invocationIdentityHash, "invocationIdentityHash");
  sha256(input.inputGenerationVectorHash, "inputGenerationVectorHash");
  sha256(input.inputBoundaryHash, "inputBoundaryHash");
  sha256(input.outputBoundaryHash, "outputBoundaryHash");
  if (input.derivedCopyProvenance !== undefined) {
    validateDerivedCopyProvenance(input.derivedCopyProvenance);
  }
  const core = Object.freeze({
    schemaVersion: RUNTIME_EXECUTION_EVIDENCE_SCHEMA_VERSION,
    evidenceKind: input.evidenceKind,
    derivationVersion: input.derivationVersion,
    inputGenerationVectorHash: input.inputGenerationVectorHash,
    inputBoundaryHash: input.inputBoundaryHash,
    outputBoundaryHash: input.outputBoundaryHash,
    payload: input.payload,
    ...(input.derivedCopyProvenance === undefined
      ? {}
      : { derivedCopyProvenance: input.derivedCopyProvenance }),
  });
  const evidenceIdentityHash = await hashCanonicalJson(core);
  const executionIdentityHash = await hashCanonicalJson({
    schemaVersion: RUNTIME_EXECUTION_EVIDENCE_SCHEMA_VERSION,
    evidenceIdentityHash,
    invocationIdentityHash: input.invocationIdentityHash,
  });
  const envelope = Object.freeze({
    ...core,
    evidenceIdentityHash,
    executionIdentityHash,
    invocationIdentityHash: input.invocationIdentityHash,
  });
  validateEnvelope(envelope);
  if (new TextEncoder().encode(serializeCanonicalJson(envelope)).byteLength >
      MAX_EVIDENCE_BYTES) {
    throw new RangeError("runtime execution evidence exceeds 64 KiB");
  }
  return envelope;
}

export async function readLatestRuntimeExecutionEvidence(
  database: D1Database,
  kind: RuntimeExecutionEvidenceKind,
): Promise<RuntimeExecutionEvidenceRow | null> {
  evidenceKind(kind);
  const row = await database.prepare(`${SELECT_EXECUTION_EVIDENCE_SQL}
    WHERE evidence_kind = ? ORDER BY rowid DESC LIMIT 1`)
    .bind(kind).first<ExecutionEvidenceDatabaseRow>();
  return row === null ? null : decodeRow(row);
}

/**
 * Selects the newest execution that has not already been consumed by one
 * component shadow. Readiness requires three distinct executions, so a bulk
 * import must advance through its receipts instead of repeatedly selecting
 * the newest linked row.
 */
export async function readLatestUnlinkedRuntimeExecutionEvidence(
  database: D1Database,
  kind: RuntimeExecutionEvidenceKind,
  componentName: string,
): Promise<RuntimeExecutionEvidenceRow | null> {
  evidenceKind(kind);
  boundedIdentity(componentName, "componentName", 64);
  const row = await database.prepare(`${SELECT_EXECUTION_EVIDENCE_SQL}
    WHERE evidence_kind = ?
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_component_execution_links
        WHERE component_name = ?
          AND execution_receipt_id =
            pipeline_execution_evidence.execution_receipt_id
      )
    ORDER BY rowid DESC LIMIT 1`)
    .bind(kind, componentName).first<ExecutionEvidenceDatabaseRow>();
  return row === null ? null : decodeRow(row);
}

export async function readRuntimeExecutionEvidence(
  database: D1Database,
  executionReceiptId: string,
): Promise<RuntimeExecutionEvidenceRow | null> {
  boundedIdentity(executionReceiptId, "executionReceiptId", 128);
  const row = await database.prepare(`${SELECT_EXECUTION_EVIDENCE_SQL}
    WHERE execution_receipt_id = ? LIMIT 1`)
    .bind(executionReceiptId).first<ExecutionEvidenceDatabaseRow>();
  return row === null ? null : decodeRow(row);
}

export async function importDerivedCopyExecutionEvidence(input: {
  readonly sourceDatabase: D1Database;
  readonly derivedDatabase: D1Database;
  readonly derivedReceiptIds: Readonly<{
    unifiedSourceScheduler: string;
    preparationScheduler: string;
  }>;
  readonly binding: DerivedCopyExecutionTransportBinding;
}): Promise<DerivedCopyExecutionImportResult> {
  validateTransportBinding(input.binding);
  const sourceGeneration = await readCompactPipelineGenerationVector(input.sourceDatabase);
  if (sourceGeneration.hash !== input.binding.sourceGenerationVectorHash) {
    throw new Error("derived execution import source generation changed");
  }
  if (input.binding.derivedGenerationVectorHash === sourceGeneration.hash) {
    throw new Error("derived execution import requires a distinct derived generation");
  }
  await assertSourceImportIdle(input.sourceDatabase);
  const derivedGeneration = await readCompactPipelineGenerationVector(
    input.derivedDatabase,
  );
  if (derivedGeneration.hash !== input.binding.derivedGenerationVectorHash) {
    throw new Error("derived execution import generation binding is stale");
  }
  const originals = await Promise.all([
    requiredDerivedExecution(
      input.derivedDatabase,
      input.derivedReceiptIds.unifiedSourceScheduler,
      "unified_source_scheduler",
    ),
    requiredDerivedExecution(
      input.derivedDatabase,
      input.derivedReceiptIds.preparationScheduler,
      "preparation_scheduler",
    ),
  ] as const);
  if (
    originals[0].invocationIdentityHash !== originals[1].invocationIdentityHash ||
    originals.some((row) => row.derivedCopyProvenance !== undefined)
  ) {
    throw new Error("derived execution import receipt set is incompatible");
  }
  for (const original of originals) assertCleanEmptyExecution(original);
  const values = await Promise.all(originals.map(async (original) => ({
    envelope: await createRuntimeExecutionEvidenceEnvelopeInternal({
      evidenceKind: original.evidenceKind,
      derivationVersion: original.derivationVersion,
      invocationIdentityHash: original.invocationIdentityHash,
      inputGenerationVectorHash: original.inputGenerationVectorHash,
      inputBoundaryHash: original.inputBoundaryHash,
      outputBoundaryHash: original.outputBoundaryHash,
      payload: original.payload,
      derivedCopyProvenance: Object.freeze({
        ...input.binding,
        schemaVersion: DERIVED_COPY_EXECUTION_PROVENANCE_SCHEMA_VERSION,
        derivedExecutionReceiptId: original.executionReceiptId,
        derivedEvidenceIdentityHash: original.evidenceIdentityHash,
        derivedExecutionIdentityHash: original.executionIdentityHash,
      }),
    }),
    completedAt: original.completedAt,
  })));
  const imported = await appendEnvelopesAtomically(
    input.sourceDatabase,
    values,
    { requireAllOrNone: true },
  );
  const idempotent = imported.every((row) => row.idempotent);
  if (!idempotent && imported.some((row) => row.idempotent)) {
    throw new Error("derived execution import was not atomic");
  }
  return Object.freeze({
    idempotent,
    unifiedSourceScheduler: imported[0]!,
    preparationScheduler: imported[1]!,
  });
}

const SELECT_EXECUTION_EVIDENCE_SQL = `
  SELECT execution_receipt_id, evidence_kind, evidence_schema_version,
    derivation_version, evidence_identity_hash, execution_identity_hash,
    invocation_identity_hash, input_generation_vector_hash,
    input_boundary_hash, output_boundary_hash, evidence_json, completed_at
  FROM pipeline_execution_evidence
`;

async function schedulerEnvelope(
  kind: "unified_source_scheduler" | "preparation_scheduler",
  payload: SchedulerComponentExecutionEvidence,
  invocationIdentityHash: string,
): Promise<RuntimeExecutionEvidenceEnvelope<SchedulerComponentExecutionEvidence>> {
  return createRuntimeExecutionEvidenceEnvelope({
    evidenceKind: kind,
    derivationVersion: payload.derivationVersion,
    invocationIdentityHash,
    inputGenerationVectorHash: payload.inputBoundaryHash,
    inputBoundaryHash: payload.inputBoundaryHash,
    outputBoundaryHash: payload.outputBoundaryHash,
    payload,
  });
}

async function appendEnvelopesAtomically(
  database: D1Database,
  values: readonly Readonly<{
    envelope: RuntimeExecutionEvidenceEnvelope;
    completedAt: string;
  }>[],
  options: Readonly<{ requireAllOrNone?: boolean }> = {},
): Promise<readonly RuntimeExecutionEvidenceReceiptResult[]> {
  const prepared = values.map(({ envelope, completedAt }) => {
    validateEnvelope(envelope);
    const evidenceJson = serializeCanonicalJson(envelope);
    if (new TextEncoder().encode(evidenceJson).byteLength > MAX_EVIDENCE_BYTES) {
      throw new RangeError("runtime execution evidence exceeds 64 KiB");
    }
    return {
      envelope,
      completedAt,
      evidenceJson,
      receiptId: executionReceiptIdentity(envelope.executionIdentityHash),
    };
  });
  const existing = await Promise.all(prepared.map(({ receiptId }) =>
    readRuntimeExecutionEvidence(database, receiptId)
  ));
  for (let index = 0; index < existing.length; index += 1) {
    if (existing[index] !== null) {
      assertSameEnvelope(existing[index]!, prepared[index]!.envelope);
    }
  }
  if (
    options.requireAllOrNone === true &&
    existing.some((row) => row === null) && existing.some((row) => row !== null)
  ) {
    throw new Error("derived execution import found a partial receipt collision");
  }
  const inserts = prepared.flatMap((entry, index) => existing[index] === null
    ? [database.prepare(`
        INSERT INTO pipeline_execution_evidence (
          execution_receipt_id, evidence_kind, evidence_schema_version,
          derivation_version, evidence_identity_hash, execution_identity_hash,
          invocation_identity_hash, input_generation_vector_hash,
          input_boundary_hash, output_boundary_hash, evidence_json, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        entry.receiptId, entry.envelope.evidenceKind, entry.envelope.schemaVersion,
        entry.envelope.derivationVersion, entry.envelope.evidenceIdentityHash,
        entry.envelope.executionIdentityHash, entry.envelope.invocationIdentityHash,
        entry.envelope.inputGenerationVectorHash, entry.envelope.inputBoundaryHash,
        entry.envelope.outputBoundaryHash, entry.evidenceJson, entry.completedAt,
      )]
    : []);
  if (inserts.length > 0) await database.batch(inserts);
  return Object.freeze(prepared.map((entry, index) => Object.freeze({
    receiptId: entry.receiptId,
    evidenceIdentityHash: entry.envelope.evidenceIdentityHash,
    executionIdentityHash: entry.envelope.executionIdentityHash,
    idempotent: existing[index] !== null,
  })));
}

async function decodeRow(
  row: ExecutionEvidenceDatabaseRow,
): Promise<RuntimeExecutionEvidenceRow> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.evidence_json);
  } catch {
    throw new Error("stored runtime execution evidence is invalid JSON");
  }
  validateEnvelope(parsed);
  const envelope = parsed as RuntimeExecutionEvidenceEnvelope;
  validateStoredPayload(envelope);
  if (
    row.evidence_schema_version !== envelope.schemaVersion ||
    row.evidence_kind !== envelope.evidenceKind ||
    row.derivation_version !== envelope.derivationVersion ||
    row.evidence_identity_hash !== envelope.evidenceIdentityHash ||
    row.execution_identity_hash !== envelope.executionIdentityHash ||
    row.invocation_identity_hash !== envelope.invocationIdentityHash ||
    row.input_generation_vector_hash !== envelope.inputGenerationVectorHash ||
    row.input_boundary_hash !== envelope.inputBoundaryHash ||
    row.output_boundary_hash !== envelope.outputBoundaryHash ||
    serializeCanonicalJson(envelope) !== row.evidence_json
  ) throw new Error("stored runtime execution evidence columns are inconsistent");
  const recomputed = await createRuntimeExecutionEvidenceEnvelopeInternal({
    evidenceKind: envelope.evidenceKind,
    derivationVersion: envelope.derivationVersion,
    invocationIdentityHash: envelope.invocationIdentityHash,
    inputGenerationVectorHash: envelope.inputGenerationVectorHash,
    inputBoundaryHash: envelope.inputBoundaryHash,
    outputBoundaryHash: envelope.outputBoundaryHash,
    payload: envelope.payload,
    ...(envelope.derivedCopyProvenance === undefined
      ? {}
      : { derivedCopyProvenance: envelope.derivedCopyProvenance }),
  });
  assertSameEnvelope(envelope, recomputed);
  return Object.freeze({
    ...envelope,
    executionReceiptId: row.execution_receipt_id,
    completedAt: canonicalTimestamp(row.completed_at, "stored completedAt"),
  });
}

function validateStoredPayload(envelope: RuntimeExecutionEvidenceEnvelope): void {
  if (envelope.evidenceKind === "unified_source_scheduler") {
    validateSchedulerPayload(
      envelope.payload as SchedulerComponentExecutionEvidence,
      "unified-source-scheduler-execution-v2",
    );
    return;
  }
  if (envelope.evidenceKind === "preparation_scheduler") {
    const payload = envelope.payload as SchedulerComponentExecutionEvidence;
    validateSchedulerPayload(payload, "preparation-scheduler-execution-v2");
    if (payload.requestCount !== 0) {
      throw new Error("stored preparation scheduler evidence reports source requests");
    }
    return;
  }
  throw new Error("runtime execution evidence kind is invalid");
}

function validateSchedulerEvidence(evidence: SchedulerExecutionEvidence): void {
  exactKeys(evidence, ["schemaVersion", "unifiedSourceScheduler", "preparationScheduler"],
    "scheduler execution evidence");
  if (evidence.schemaVersion !== "auction-discovery-scheduler-execution-evidence-v2") {
    throw new Error("scheduler execution evidence derivation is incompatible");
  }
  validateSchedulerPayload(evidence.unifiedSourceScheduler,
    "unified-source-scheduler-execution-v2");
  validateSchedulerPayload(evidence.preparationScheduler,
    "preparation-scheduler-execution-v2");
  if (evidence.preparationScheduler.requestCount !== 0) {
    throw new Error("preparation scheduler evidence must report zero source requests");
  }
}

function validateSchedulerPayload(
  payload: SchedulerComponentExecutionEvidence,
  derivationVersion: SchedulerComponentExecutionEvidence["derivationVersion"],
): void {
  exactKeys(payload, [
    "derivationVersion", "inputBoundaryHash", "outputBoundaryHash",
    "candidateOrderHash", "decisionHash", "mutationOrderHash",
    "timingObservationHash", "snapshotCount", "candidateObservationCount",
    "decisionObservationCount", "mutationObservationCount", "selectedCount",
    "requestCount", "childProcessCount", "singleWriterObserved",
    "commitObservationCount", "maxConcurrentCommits", "maxConcurrentValidations",
  ], `${derivationVersion} payload`);
  if (payload.derivationVersion !== derivationVersion) {
    throw new Error("scheduler component evidence derivation is incompatible");
  }
  for (const [name, value] of Object.entries(payload)) {
    if (name.endsWith("Hash")) sha256(value, name);
    if (name.endsWith("Count")) count(value, name);
  }
  count(payload.maxConcurrentCommits, "maxConcurrentCommits");
  count(payload.maxConcurrentValidations, "maxConcurrentValidations");
  if (payload.childProcessCount !== 0 || payload.singleWriterObserved !== true) {
    throw new Error("scheduler execution evidence violates the in-process single-writer contract");
  }
  if (payload.maxConcurrentCommits > 1 ||
      payload.commitObservationCount > payload.selectedCount) {
    throw new Error("scheduler execution counters violate the single-writer contract");
  }
}

function validateEnvelope(value: unknown): asserts value is RuntimeExecutionEvidenceEnvelope {
  const hasDerivedProvenance = value !== null && typeof value === "object" &&
    !Array.isArray(value) && "derivedCopyProvenance" in value;
  exactKeys(
    value,
    hasDerivedProvenance ? DERIVED_ENVELOPE_KEYS : LOCAL_ENVELOPE_KEYS,
    "runtime execution evidence envelope",
  );
  const envelope = value as RuntimeExecutionEvidenceEnvelope;
  if (envelope.schemaVersion !== RUNTIME_EXECUTION_EVIDENCE_SCHEMA_VERSION) {
    throw new Error("runtime execution evidence schema is incompatible");
  }
  evidenceKind(envelope.evidenceKind);
  boundedIdentity(envelope.derivationVersion, "derivationVersion", 256);
  for (const [name, hash] of [
    ["evidenceIdentityHash", envelope.evidenceIdentityHash],
    ["executionIdentityHash", envelope.executionIdentityHash],
    ["invocationIdentityHash", envelope.invocationIdentityHash],
    ["inputGenerationVectorHash", envelope.inputGenerationVectorHash],
    ["inputBoundaryHash", envelope.inputBoundaryHash],
    ["outputBoundaryHash", envelope.outputBoundaryHash],
  ] as const) sha256(hash, name);
  if (envelope.payload === null || typeof envelope.payload !== "object" ||
      Array.isArray(envelope.payload)) {
    throw new TypeError("runtime execution payload must be an object");
  }
  if (hasDerivedProvenance) {
    validateDerivedCopyProvenance(envelope.derivedCopyProvenance);
  }
}

function assertSameEnvelope(
  left: RuntimeExecutionEvidenceEnvelope,
  right: RuntimeExecutionEvidenceEnvelope,
): void {
  const exact = (value: RuntimeExecutionEvidenceEnvelope) => {
    const keys = value.derivedCopyProvenance === undefined
      ? LOCAL_ENVELOPE_KEYS
      : DERIVED_ENVELOPE_KEYS;
    return Object.fromEntries(keys.map((key) => [key, value[key]]));
  };
  if (serializeCanonicalJson(exact(left)) !== serializeCanonicalJson(exact(right))) {
    throw new Error("runtime execution identity already binds different evidence");
  }
}

function validateTransportBinding(
  value: DerivedCopyExecutionTransportBinding,
): void {
  exactKeys(value, DERIVED_TRANSPORT_BINDING_KEYS, "derived execution transport binding");
  validateDerivedBindingCore(value);
}

function validateDerivedCopyProvenance(
  value: unknown,
): asserts value is DerivedCopyExecutionProvenance {
  exactKeys(value, DERIVED_PROVENANCE_KEYS, "derived copy execution provenance");
  const provenance = value as DerivedCopyExecutionProvenance;
  if (provenance.schemaVersion !== DERIVED_COPY_EXECUTION_PROVENANCE_SCHEMA_VERSION) {
    throw new Error("derived copy execution provenance schema is incompatible");
  }
  validateDerivedBindingCore(provenance);
  boundedIdentity(
    provenance.derivedExecutionReceiptId,
    "derivedExecutionReceiptId",
    128,
  );
  sha256(provenance.derivedEvidenceIdentityHash, "derivedEvidenceIdentityHash");
  sha256(provenance.derivedExecutionIdentityHash, "derivedExecutionIdentityHash");
}

function validateDerivedBindingCore(value: DerivedCopyExecutionTransportBinding): void {
  for (const [name, identity] of [
    ["sourceDatabaseFileSetIdentity", value.sourceDatabaseFileSetIdentity],
    ["sourceGenerationVectorHash", value.sourceGenerationVectorHash],
    ["derivedDatabaseFileSetIdentity", value.derivedDatabaseFileSetIdentity],
    ["derivedGenerationVectorHash", value.derivedGenerationVectorHash],
    ["scenarioIdentityHash", value.scenarioIdentityHash],
    ["derivedInvocationGroupIdentityHash", value.derivedInvocationGroupIdentityHash],
  ] as const) sha256(identity, name);
  if (value.sourceGenerationVectorHash === value.derivedGenerationVectorHash) {
    throw new Error("derived copy provenance requires a distinct derived generation");
  }
  if (
    value.scenarioDerivationVersion !==
      DERIVED_COPY_EXECUTION_SCENARIO_DERIVATION_VERSION ||
    value.writeAuthorizerContractIdentity !==
      DERIVED_COPY_EXECUTION_WRITE_AUTHORIZER_CONTRACT ||
    value.queueRemovalContractIdentity !==
      DERIVED_COPY_EXECUTION_QUEUE_REMOVAL_CONTRACT
  ) throw new Error("derived copy execution provenance contract is incompatible");
}

async function requiredDerivedExecution(
  database: D1Database,
  receiptId: string,
  expectedKind: RuntimeExecutionEvidenceKind,
): Promise<RuntimeExecutionEvidenceRow> {
  const row = await readRuntimeExecutionEvidence(database, receiptId);
  if (row === null || row.evidenceKind !== expectedKind) {
    throw new Error(`derived execution receipt ${receiptId} is missing or incompatible`);
  }
  return row;
}

async function assertSourceImportIdle(database: D1Database): Promise<void> {
  const now = new Date().toISOString();
  const [pipelineLease, claimedWork, reservation, bundle] = await database.batch([
    database.prepare("SELECT COUNT(*) AS count FROM pipeline_run_lease"),
    database.prepare(`
      SELECT COUNT(*) AS count FROM pipeline_work_items
      WHERE lease_owner IS NOT NULL AND lease_expires_at > ?
    `).bind(now),
    database.prepare(`
      SELECT COUNT(*) AS count FROM source_acquisition_reservations
      WHERE state IN ('reserved', 'acquired')
    `),
    database.prepare(`
      SELECT COUNT(*) AS count FROM source_acquired_bundles
      WHERE state IN ('acquired', 'validated')
    `),
  ]);
  const results = [pipelineLease, claimedWork, reservation, bundle];
  const countAt = (index: number) => Number(
    (results[index]?.results?.[0] as { count?: unknown } | undefined)?.count ?? 0,
  );
  if ([0, 1, 2, 3].some((index) => countAt(index) !== 0)) {
    throw new Error("derived execution import source has an active lease");
  }
}

function assertCleanEmptyExecution(row: RuntimeExecutionEvidenceRow): void {
  if (row.evidenceKind === "unified_source_scheduler" ||
      row.evidenceKind === "preparation_scheduler") {
    const payload = row.payload as SchedulerComponentExecutionEvidence;
    if (
      payload.candidateObservationCount !== 0 || payload.decisionObservationCount !== 0 ||
      payload.mutationObservationCount !== 0 || payload.selectedCount !== 0 ||
      payload.requestCount !== 0 || payload.childProcessCount !== 0 ||
      payload.commitObservationCount !== 0 || payload.maxConcurrentCommits !== 0 ||
      payload.maxConcurrentValidations !== 0 || payload.singleWriterObserved !== true
    ) throw new Error("derived scheduler execution is not clean-empty/zero-request");
    return;
  }
  throw new Error("runtime execution evidence kind is invalid");
}

function exactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length ||
      actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`${label} has an incompatible shape`);
  }
}

function executionReceiptIdentity(hash: string): string {
  return `runtime-execution:${sha256(hash, "executionIdentityHash").slice(7)}`;
}

function evidenceKind(value: string): RuntimeExecutionEvidenceKind {
  if (!RUNTIME_EXECUTION_EVIDENCE_KINDS.includes(value as RuntimeExecutionEvidenceKind)) {
    throw new RangeError("runtime execution evidence kind is invalid");
  }
  return value as RuntimeExecutionEvidenceKind;
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 100_000_000) {
    throw new RangeError(`${label} must be a bounded nonnegative integer`);
  }
  return Number(value);
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 identity`);
  }
  return value;
}

function boundedIdentity(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} must be a bounded canonical identity`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}
