import type { PipelineWorkStage } from "../pipeline/work-queue";
import type { PerformanceFeatureName, PerformanceFeatureReadiness } from "./features";
import {
  hashCanonicalJson,
  readCompactPipelineGenerationVector,
  type PipelineGenerationVector,
} from "./generations";
import {
  appendPipelineAuditReceipt,
  PIPELINE_AUDIT_SCHEMA_VERSION,
  preparePipelineAuditReceiptInsert,
  readLatestPipelineAuditReceipt,
  readPerformanceFeatureReadiness,
  readPipelineAuditReceipt,
  type PipelineAuditReceipt,
  type PipelineAuditReceiptInput,
} from "./readiness";
import {
  readRuntimeExecutionEvidence,
  type RuntimeExecutionEvidenceKind,
  type RuntimeExecutionEvidenceRow,
} from "./runtime-execution-evidence";

export const PERFORMANCE_COMPONENT_AUDIT_SCHEMA_VERSION =
  "auction-discovery-performance-component-audit-v1" as const;

/**
 * One identity binds queue-backed proximity registration, audited evidence,
 * and runtime activation. A caller must never substitute an implementation
 * version for this readiness derivation.
 */
export const QUEUE_BACKED_PROXIMITY_READINESS_DERIVATION_VERSION =
  "queue-backed-local-proximity-readiness-v4" as const;

/**
 * One identity binds the queue-backed enrichment implementation, audited
 * evidence, and readiness-gated manual activation. Scheduler-owned claims use
 * their separate campaign authorization so generation changes made earlier in
 * the same campaign cannot redirect an exact queue claim to the canonical
 * selector.
 */
export const ENRICHMENT_SESSION_RESIDENCY_READINESS_DERIVATION_VERSION =
  "enrichment-queue-session-readiness-v3" as const;

export const PERFORMANCE_COMPONENT_NAMES = [
  "queueDrivenProximity",
  "preparationScheduler",
  "enrichmentResidency",
  "dirtyPreferenceV2Scoring",
  "unifiedSourceScheduler",
  "dashboardReleaseSkip",
  "contentAddressedImageReuse",
] as const;

export type PerformanceComponentName =
  (typeof PERFORMANCE_COMPONENT_NAMES)[number];

export interface PerformanceComponentAuditDefinition {
  readonly componentName: PerformanceComponentName;
  readonly featureName: Exclude<PerformanceFeatureName, "operationalProjection">;
  readonly derivationVersion: string;
  readonly invariantNames: readonly string[];
  readonly queueStages: readonly PipelineWorkStage[];
}

export interface ComponentInvariantObservation {
  readonly invariantName: string;
  readonly canonicalCount: number;
  readonly canonicalOrderedHash: string;
  readonly optimizedCount: number;
  readonly optimizedOrderedHash: string;
  /** Required for a mismatch and forbidden for exact parity. */
  readonly differingIdsHash?: string | null;
}

export interface ComponentQueueStageObservation {
  readonly stage: PipelineWorkStage;
  readonly count: number;
  readonly orderedIdentityHash: string;
}

export interface ComponentAuditObservation {
  /** Generation captured by the evaluator while it read the exact queue. */
  readonly queueGenerationVectorHash: string;
  readonly invariants: readonly ComponentInvariantObservation[];
  readonly queueStages: readonly ComponentQueueStageObservation[];
}

export interface ComponentShadowAuditInput {
  readonly database: D1Database;
  readonly componentName: PerformanceComponentName;
  /** Stable identity of one shadow invocation; retries reuse the same identity. */
  readonly auditIdentity: string;
  readonly copiedDatabaseIdentity?: string | null;
  readonly completedAt: string;
  /** Required only for components whose parity depends on one actual execution. */
  readonly executionReceiptId?: string | null;
  readonly evaluate: (context: Readonly<{
    definition: PerformanceComponentAuditDefinition;
    generationVector: PipelineGenerationVector;
  }>) => Promise<ComponentAuditObservation>;
}

export interface ComponentAuditResult {
  readonly definition: PerformanceComponentAuditDefinition;
  readonly receipt: PipelineAuditReceipt;
  readonly idempotent: boolean;
}

const allPreparationStages = Object.freeze([
  "projection_listing_refresh",
  "projection_source_refresh",
  "projection_group_refresh",
  "projection_global_refresh",
  "detail",
  "action_deadline",
  "owner_refresh",
  "factual_supplement",
  "image_evidence",
  "primary_image",
  "proximity",
  "enrichment_text",
  "enrichment_embedding",
  "preference_v2_score",
  "source_release",
  "source_acquisition_readiness",
] as const satisfies readonly PipelineWorkStage[]);

const definitions = Object.freeze([
  component(
    "queueDrivenProximity",
    "queueBackedProximity",
    QUEUE_BACKED_PROXIMITY_READINESS_DERIVATION_VERSION,
    [
      "desired-proximity-work-identity-parity",
      "desired-proximity-work-input-parity",
      "accepted-route-state-parity",
    ],
    ["proximity"],
  ),
  component(
    "preparationScheduler",
    "globalPreparationScheduler",
    "auction-discovery-preparation-scheduler-readiness-v5",
    [
      "ready-work-order-parity",
      "dependency-lane-eligibility-parity",
      "empty-zero-external-work-contract",
    ],
    allPreparationStages,
  ),
  component(
    "enrichmentResidency",
    "enrichmentSessionResidency",
    ENRICHMENT_SESSION_RESIDENCY_READINESS_DERIVATION_VERSION,
    [
      "selected-completed-lineage-parity",
      "residency-execution-contract-parity",
      "current-enrichment-boundary-parity",
    ],
    ["enrichment_text", "enrichment_embedding"],
  ),
  component(
    "dirtyPreferenceV2Scoring",
    "dirtyPreferenceV2Scoring",
    "preference-v2-dirty-score-readiness-v3",
    [
      "eligible-listing-coverage-receipt-parity",
      "active-shadow-head-coverage-receipt-parity",
      "score-queue-generation-emptiness-parity",
    ],
    ["preference_v2_score"],
  ),
  component(
    "unifiedSourceScheduler",
    "unifiedSourceScheduler",
    "auction-discovery-unified-source-scheduler-readiness-v5",
    [
      "ready-stage-schedule-order-parity",
      "dependency-access-reservation-eligibility-parity",
      "single-writer-lane-contract",
    ],
    allPreparationStages,
  ),
  component(
    "dashboardReleaseSkip",
    "dashboardReleaseGenerations",
    "dashboard-release-prime-readiness-v3",
    [
      "dashboard-payload-structural-parity",
      "release-vector-boundary-parity",
      "unchanged-hit-zero-reconstruction-parity",
    ],
    ["source_release"],
  ),
  component(
    "contentAddressedImageReuse",
    "contentAddressedImageReuse",
    "content-addressed-image-reuse-readiness-v3",
    [
      "legacy-current-content-head-parity",
      "immutable-link-active-head-binding-parity",
      "referenced-active-blob-parity",
    ],
    ["image_evidence", "primary_image"],
  ),
] as const satisfies readonly PerformanceComponentAuditDefinition[]);

export const performanceComponentAuditRegistry:
  readonly PerformanceComponentAuditDefinition[] = definitions;

const definitionByName = new Map(
  definitions.map((definition) => [definition.componentName, definition]),
);
const definitionByFeature = new Map(
  definitions.map((definition) => [definition.featureName, definition]),
);

const runtimeEvidenceKinds = Object.freeze({
  preparationScheduler: "preparation_scheduler",
  unifiedSourceScheduler: "unified_source_scheduler",
} as const satisfies Partial<Record<PerformanceComponentName, RuntimeExecutionEvidenceKind>>);

if (
  definitionByName.size !== PERFORMANCE_COMPONENT_NAMES.length ||
  definitionByFeature.size !== PERFORMANCE_COMPONENT_NAMES.length
) throw new Error("performance component audit registry must be one-to-one");

export function getPerformanceComponentAuditDefinition(
  componentName: PerformanceComponentName,
): PerformanceComponentAuditDefinition {
  const definition = definitionByName.get(componentName);
  if (!definition) throw new RangeError(`unknown performance component ${componentName}`);
  return definition;
}

export function getPerformanceComponentAuditDefinitionByFeature(
  featureName: PerformanceFeatureName,
): PerformanceComponentAuditDefinition | null {
  return definitionByFeature.get(
    featureName as Exclude<PerformanceFeatureName, "operationalProjection">,
  ) ?? null;
}

export async function recordComponentShadowAudit(
  input: ComponentShadowAuditInput,
): Promise<ComponentAuditResult> {
  boundedIdentity(input.auditIdentity, "auditIdentity");
  const completedAt = canonicalTimestamp(input.completedAt, "completedAt");
  const copiedDatabaseIdentity = input.copiedDatabaseIdentity === undefined ||
      input.copiedDatabaseIdentity === null
    ? null
    : boundedIdentity(input.copiedDatabaseIdentity, "copiedDatabaseIdentity");
  const definition = getPerformanceComponentAuditDefinition(input.componentName);
  const runtimeKind = runtimeEvidenceKinds[input.componentName as keyof typeof runtimeEvidenceKinds] ?? null;
  const executionReceiptId = input.executionReceiptId ?? null;
  if ((runtimeKind === null) !== (executionReceiptId === null)) {
    throw new Error(`${definition.componentName} shadow execution linkage is incompatible`);
  }
  const execution = executionReceiptId === null
    ? null
    : await requiredRuntimeExecution(input.database, executionReceiptId, runtimeKind!);
  const receiptId = `component-shadow:${(
    await hashCanonicalJson({
      schema: PERFORMANCE_COMPONENT_AUDIT_SCHEMA_VERSION,
      componentName: definition.componentName,
      auditIdentity: input.auditIdentity,
    })
  ).slice("sha256:".length)}`;
  const existing = await readPipelineAuditReceipt(input.database, receiptId);
  const before = await readCompactPipelineGenerationVector(input.database);
  const observation = await input.evaluate(Object.freeze({
    definition,
    generationVector: before,
  }));
  const evaluated = await evaluateObservation(definition, before.hash, observation);
  const after = await readCompactPipelineGenerationVector(input.database);
  const generationChanged = before.hash !== after.hash ||
    observation.queueGenerationVectorHash !== before.hash;
  const mismatchCount = evaluated.mismatchNames.length + (generationChanged ? 1 : 0);
  const receiptKind = mismatchCount === 0 ? "shadow_pass" as const : "mismatch" as const;
  const prior = existing?.priorReceiptId
    ? await readPipelineAuditReceipt(input.database, existing.priorReceiptId)
    : existing
    ? null
    : await readLatestPipelineAuditReceipt(input.database, definition.featureName);
  const shadowPassCount = receiptKind === "shadow_pass"
    ? compatiblePriorShadowCount(prior, {
        definition,
        generationVectorHash: before.hash,
        canonicalCount: evaluated.canonicalCount,
        canonicalOrderedHash: evaluated.canonicalOrderedHash,
        optimizedCount: evaluated.optimizedCount,
        optimizedOrderedHash: evaluated.optimizedOrderedHash,
        queueCount: evaluated.queueCount,
        queueOrderedHash: evaluated.queueOrderedHash,
        copiedDatabaseIdentity,
      }) + 1
    : 0;
  const differingIdsHash = mismatchCount === 0 ? null : await hashCanonicalJson({
    componentName: definition.componentName,
    mismatches: evaluated.mismatchNames,
    generationChanged,
    beforeGenerationVectorHash: before.hash,
    queueGenerationVectorHash: observation.queueGenerationVectorHash,
    afterGenerationVectorHash: after.hash,
  });
  const receiptInput: PipelineAuditReceiptInput = {
    receiptId,
    receiptKind,
    featureName: definition.featureName,
    schemaVersion: PIPELINE_AUDIT_SCHEMA_VERSION,
    derivationVersion: definition.derivationVersion,
    beforeGenerationVectorHash: before.hash,
    afterGenerationVectorHash: after.hash,
    canonicalCount: evaluated.canonicalCount,
    canonicalOrderedHash: evaluated.canonicalOrderedHash,
    projectionCount: evaluated.optimizedCount,
    projectionOrderedHash: evaluated.optimizedOrderedHash,
    queueCount: evaluated.queueCount,
    queueOrderedHash: evaluated.queueOrderedHash,
    mismatchCount,
    differingIdsHash,
    copiedDatabaseIdentity,
    shadowPassCount,
    priorReceiptId: prior?.receiptId ?? null,
    completedAt,
  };
  if (existing) {
    assertReceiptMatchesInput(existing, receiptInput);
    await assertStoredExecutionLink({
      database: input.database,
      definition,
      shadowReceiptId: existing.receiptId,
      generationVectorHash: before.hash,
      execution,
    });
    return Object.freeze({ definition, receipt: existing, idempotent: true });
  }
  if (execution === null) {
    await appendPipelineAuditReceipt(input.database, receiptInput);
  } else {
    const linkIdentity = await componentExecutionLinkIdentity(
      definition.componentName,
      receiptId,
      execution.executionReceiptId,
    );
    await input.database.batch([
      preparePipelineAuditReceiptInsert(input.database, receiptInput),
      input.database.prepare(`
        INSERT INTO pipeline_component_execution_links (
          link_identity, component_name, shadow_receipt_id,
          execution_receipt_id, derivation_version,
          generation_vector_hash, linked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        linkIdentity,
        definition.componentName,
        receiptId,
        execution.executionReceiptId,
        execution.derivationVersion,
        before.hash,
        completedAt,
      ),
    ]);
  }
  const receipt = await requiredReceipt(input.database, receiptId);
  return Object.freeze({ definition, receipt, idempotent: false });
}

export async function sealComponentReadiness(input: {
  readonly database: D1Database;
  readonly componentName: PerformanceComponentName;
  readonly completedAt: string;
}): Promise<ComponentAuditResult> {
  const completedAt = canonicalTimestamp(input.completedAt, "completedAt");
  const definition = getPerformanceComponentAuditDefinition(input.componentName);
  const vector = await readCompactPipelineGenerationVector(input.database);
  const latest = await readLatestPipelineAuditReceipt(input.database, definition.featureName);
  if (
    latest?.receiptKind === "readiness" && latest.readinessGranted &&
    latest.schemaVersion === PIPELINE_AUDIT_SCHEMA_VERSION &&
    latest.derivationVersion === definition.derivationVersion &&
    latest.beforeGenerationVectorHash === vector.hash &&
    latest.afterGenerationVectorHash === vector.hash &&
    await readinessHasThreeShadows(input.database, latest)
  ) return Object.freeze({ definition, receipt: latest, idempotent: true });

  const shadows = await threeStableShadows(input.database, definition, latest, vector.hash);
  await requireDistinctRuntimeExecutions(input.database, definition, shadows);
  const newest = shadows[0]!;
  const receiptId = `component-readiness:${(
    await hashCanonicalJson({
      schema: PERFORMANCE_COMPONENT_AUDIT_SCHEMA_VERSION,
      componentName: definition.componentName,
      generationVectorHash: vector.hash,
      shadowReceiptIds: shadows.map((receipt) => receipt.receiptId),
    })
  ).slice("sha256:".length)}`;
  const receiptInput: PipelineAuditReceiptInput = {
    receiptId,
    receiptKind: "readiness",
    featureName: definition.featureName,
    schemaVersion: PIPELINE_AUDIT_SCHEMA_VERSION,
    derivationVersion: definition.derivationVersion,
    beforeGenerationVectorHash: vector.hash,
    afterGenerationVectorHash: vector.hash,
    canonicalCount: newest.canonicalCount,
    canonicalOrderedHash: newest.canonicalOrderedHash,
    projectionCount: newest.projectionCount,
    projectionOrderedHash: newest.projectionOrderedHash,
    queueCount: newest.queueCount,
    queueOrderedHash: newest.queueOrderedHash,
    mismatchCount: 0,
    differingIdsHash: null,
    copiedDatabaseIdentity: newest.copiedDatabaseIdentity,
    shadowPassCount: 3,
    readinessGranted: true,
    priorReceiptId: newest.receiptId,
    completedAt,
  };
  const existing = await readPipelineAuditReceipt(input.database, receiptId);
  if (existing) {
    assertReceiptMatchesInput(existing, receiptInput);
    return Object.freeze({ definition, receipt: existing, idempotent: true });
  }
  await appendPipelineAuditReceipt(input.database, receiptInput);
  const receipt = await requiredReceipt(input.database, receiptId);
  return Object.freeze({ definition, receipt, idempotent: false });
}

export async function readComponentPerformanceReadiness(input: {
  readonly database: D1Database;
  readonly componentName: PerformanceComponentName;
  readonly implementationAvailable?: boolean;
}): Promise<PerformanceFeatureReadiness> {
  const definition = getPerformanceComponentAuditDefinition(input.componentName);
  const vector = await readCompactPipelineGenerationVector(input.database);
  return readPerformanceFeatureReadiness({
    database: input.database,
    featureName: definition.featureName,
    derivationVersion: definition.derivationVersion,
    generationVectorHash: vector.hash,
    implementationAvailable: input.implementationAvailable,
  });
}

export async function sealAllComponentReadiness(input: {
  readonly database: D1Database;
  readonly completedAt: string;
}): Promise<readonly ComponentAuditResult[]> {
  const results: ComponentAuditResult[] = [];
  for (const componentName of PERFORMANCE_COMPONENT_NAMES) {
    results.push(await sealComponentReadiness({ ...input, componentName }));
  }
  return Object.freeze(results);
}

async function evaluateObservation(
  definition: PerformanceComponentAuditDefinition,
  generationVectorHash: string,
  observation: ComponentAuditObservation,
) {
  sha256(observation.queueGenerationVectorHash, "queueGenerationVectorHash");
  const invariantByName = exactNamedMap(
    observation.invariants,
    definition.invariantNames,
    (entry) => entry.invariantName,
    "component invariant",
  );
  const queueByStage = exactNamedMap(
    observation.queueStages,
    definition.queueStages,
    (entry) => entry.stage,
    "component queue stage",
  );
  const canonical: unknown[] = [];
  const optimized: unknown[] = [];
  const mismatchNames: string[] = [];
  let canonicalCount = 0;
  let optimizedCount = 0;
  for (const invariantName of definition.invariantNames) {
    const entry = invariantByName.get(invariantName)!;
    const canonicalEntryCount = count(entry.canonicalCount, `${invariantName} canonicalCount`);
    const optimizedEntryCount = count(entry.optimizedCount, `${invariantName} optimizedCount`);
    const canonicalHash = sha256(
      entry.canonicalOrderedHash,
      `${invariantName} canonicalOrderedHash`,
    );
    const optimizedHash = sha256(
      entry.optimizedOrderedHash,
      `${invariantName} optimizedOrderedHash`,
    );
    const differs = canonicalEntryCount !== optimizedEntryCount ||
      canonicalHash !== optimizedHash;
    if (differs) {
      if (entry.differingIdsHash === undefined || entry.differingIdsHash === null) {
        throw new Error(`${invariantName} mismatch requires differingIdsHash`);
      }
      sha256(entry.differingIdsHash, `${invariantName} differingIdsHash`);
      mismatchNames.push(invariantName);
    } else if (entry.differingIdsHash !== undefined && entry.differingIdsHash !== null) {
      throw new Error(`${invariantName} exact parity forbids differingIdsHash`);
    }
    canonicalCount += canonicalEntryCount;
    optimizedCount += optimizedEntryCount;
    canonical.push({ invariantName, count: canonicalEntryCount, orderedHash: canonicalHash });
    optimized.push({ invariantName, count: optimizedEntryCount, orderedHash: optimizedHash });
  }
  const queue: unknown[] = [];
  let queueCount = 0;
  for (const stage of definition.queueStages) {
    const entry = queueByStage.get(stage)!;
    const stageCount = count(entry.count, `${stage} queue count`);
    queueCount += stageCount;
    queue.push({
      stage,
      count: stageCount,
      orderedIdentityHash: sha256(
        entry.orderedIdentityHash,
        `${stage} queue ordered identity hash`,
      ),
    });
  }
  return Object.freeze({
    canonicalCount,
    optimizedCount,
    canonicalOrderedHash: await hashCanonicalJson(canonical),
    optimizedOrderedHash: await hashCanonicalJson(optimized),
    queueCount,
    queueOrderedHash: await hashCanonicalJson({ generationVectorHash, queue }),
    mismatchNames: Object.freeze(mismatchNames),
  });
}

function compatiblePriorShadowCount(
  prior: PipelineAuditReceipt | null,
  expected: Readonly<{
    definition: PerformanceComponentAuditDefinition;
    generationVectorHash: string;
    canonicalCount: number;
    canonicalOrderedHash: string;
    optimizedCount: number;
    optimizedOrderedHash: string;
    queueCount: number;
    queueOrderedHash: string;
    copiedDatabaseIdentity: string | null;
  }>,
): number {
  return prior?.receiptKind === "shadow_pass" && prior.mismatchCount === 0 &&
      !prior.readinessGranted && prior.schemaVersion === PIPELINE_AUDIT_SCHEMA_VERSION &&
      prior.derivationVersion === expected.definition.derivationVersion &&
      prior.beforeGenerationVectorHash === expected.generationVectorHash &&
      prior.afterGenerationVectorHash === expected.generationVectorHash &&
      prior.canonicalCount === expected.canonicalCount &&
      prior.canonicalOrderedHash === expected.canonicalOrderedHash &&
      prior.projectionCount === expected.optimizedCount &&
      prior.projectionOrderedHash === expected.optimizedOrderedHash &&
      prior.queueCount === expected.queueCount &&
      prior.queueOrderedHash === expected.queueOrderedHash &&
      prior.copiedDatabaseIdentity === expected.copiedDatabaseIdentity
    ? prior.shadowPassCount
    : 0;
}

async function threeStableShadows(
  database: D1Database,
  definition: PerformanceComponentAuditDefinition,
  latest: PipelineAuditReceipt | null,
  generationVectorHash: string,
): Promise<readonly [PipelineAuditReceipt, PipelineAuditReceipt, PipelineAuditReceipt]> {
  const shadows: PipelineAuditReceipt[] = [];
  const seen = new Set<string>();
  let next = latest;
  while (shadows.length < 3) {
    if (
      next === null || next.featureName !== definition.featureName ||
      next.receiptKind !== "shadow_pass" || next.readinessGranted ||
      next.schemaVersion !== PIPELINE_AUDIT_SCHEMA_VERSION ||
      next.derivationVersion !== definition.derivationVersion ||
      next.beforeGenerationVectorHash !== generationVectorHash ||
      next.afterGenerationVectorHash !== generationVectorHash ||
      next.mismatchCount !== 0 ||
      next.shadowPassCount < 3 - shadows.length ||
      next.canonicalCount !== next.projectionCount ||
      next.canonicalOrderedHash !== next.projectionOrderedHash
    ) throw new Error(`${definition.componentName} readiness requires three consecutive stable zero-mismatch shadow receipts`);
    if (seen.has(next.receiptId)) {
      throw new Error(`${definition.componentName} readiness shadow chain contains a cycle`);
    }
    if (
      shadows.length > 0 &&
      next.shadowPassCount !== shadows[0]!.shadowPassCount - shadows.length
    ) {
      throw new Error(`${definition.componentName} readiness shadow pass sequence is invalid`);
    }
    if (shadows.length > 0 && !sameStableEvidence(shadows[0]!, next)) {
      throw new Error(`${definition.componentName} readiness shadows do not bind unchanged exact evidence`);
    }
    seen.add(next.receiptId);
    shadows.push(next);
    if (shadows.length < 3) {
      next = next.priorReceiptId === null
        ? null
        : await readPipelineAuditReceipt(database, next.priorReceiptId);
    }
  }
  return shadows as unknown as readonly [
    PipelineAuditReceipt,
    PipelineAuditReceipt,
    PipelineAuditReceipt,
  ];
}

async function readinessHasThreeShadows(
  database: D1Database,
  readiness: PipelineAuditReceipt,
): Promise<boolean> {
  try {
    const latestShadow = readiness.priorReceiptId === null
      ? null
      : await readPipelineAuditReceipt(database, readiness.priorReceiptId);
    const definition = getPerformanceComponentAuditDefinitionByFeature(
      readiness.featureName as PerformanceFeatureName,
    )!;
    const shadows = await threeStableShadows(
      database,
      definition,
      latestShadow,
      readiness.afterGenerationVectorHash,
    );
    await requireDistinctRuntimeExecutions(database, definition, shadows);
    return latestShadow !== null && sameStableEvidence(readiness, latestShadow);
  } catch {
    return false;
  }
}

interface ComponentExecutionLinkRow {
  component_name: PerformanceComponentName;
  shadow_receipt_id: string;
  execution_receipt_id: string;
  derivation_version: string;
  generation_vector_hash: string;
}

async function requiredRuntimeExecution(
  database: D1Database,
  executionReceiptId: string,
  expectedKind: RuntimeExecutionEvidenceKind,
): Promise<RuntimeExecutionEvidenceRow> {
  const execution = await readRuntimeExecutionEvidence(database, executionReceiptId);
  if (execution === null || execution.evidenceKind !== expectedKind) {
    throw new Error(`runtime execution receipt ${executionReceiptId} is missing or incompatible`);
  }
  return execution;
}

async function readComponentExecutionLink(
  database: D1Database,
  componentName: PerformanceComponentName,
  shadowReceiptId: string,
): Promise<ComponentExecutionLinkRow | null> {
  return database.prepare(`
    SELECT component_name, shadow_receipt_id, execution_receipt_id,
      derivation_version, generation_vector_hash
    FROM pipeline_component_execution_links
    WHERE component_name = ? AND shadow_receipt_id = ?
    LIMIT 1
  `).bind(componentName, shadowReceiptId).first<ComponentExecutionLinkRow>();
}

async function assertStoredExecutionLink(input: {
  readonly database: D1Database;
  readonly definition: PerformanceComponentAuditDefinition;
  readonly shadowReceiptId: string;
  readonly generationVectorHash: string;
  readonly execution: RuntimeExecutionEvidenceRow | null;
}): Promise<void> {
  if (input.execution === null) return;
  const link = await readComponentExecutionLink(
    input.database,
    input.definition.componentName,
    input.shadowReceiptId,
  );
  if (
    link === null || link.execution_receipt_id !== input.execution.executionReceiptId ||
    link.derivation_version !== input.execution.derivationVersion ||
    link.generation_vector_hash !== input.generationVectorHash
  ) throw new Error("component shadow identity already binds different execution evidence");
}

async function componentExecutionLinkIdentity(
  componentName: PerformanceComponentName,
  shadowReceiptId: string,
  executionReceiptId: string,
): Promise<string> {
  return `component-execution:${(await hashCanonicalJson({
    componentName,
    shadowReceiptId,
    executionReceiptId,
  })).slice("sha256:".length)}`;
}

async function requireDistinctRuntimeExecutions(
  database: D1Database,
  definition: PerformanceComponentAuditDefinition,
  shadows: readonly [PipelineAuditReceipt, PipelineAuditReceipt, PipelineAuditReceipt],
): Promise<void> {
  const expectedKind = runtimeEvidenceKinds[
    definition.componentName as keyof typeof runtimeEvidenceKinds
  ] ?? null;
  if (expectedKind === null) return;
  const executions: RuntimeExecutionEvidenceRow[] = [];
  for (const shadow of shadows) {
    const link = await readComponentExecutionLink(
      database,
      definition.componentName,
      shadow.receiptId,
    );
    if (
      link === null || link.generation_vector_hash !== shadow.afterGenerationVectorHash
    ) throw new Error(`${definition.componentName} readiness requires execution-linked shadows`);
    const execution = await requiredRuntimeExecution(
      database,
      link.execution_receipt_id,
      expectedKind,
    );
    if (link.derivation_version !== execution.derivationVersion) {
      throw new Error(`${definition.componentName} execution derivation link is inconsistent`);
    }
    executions.push(execution);
  }
  const distinct = (values: readonly string[]) => new Set(values).size === values.length;
  if (
    !distinct(executions.map((row) => row.executionReceiptId)) ||
    !distinct(executions.map((row) => row.executionIdentityHash)) ||
    !distinct(executions.map((row) => row.invocationIdentityHash)) ||
    new Set(executions.map((row) => row.derivationVersion)).size !== 1 ||
    new Set(shadows.map((row) => row.afterGenerationVectorHash)).size !== 1
  ) {
    throw new Error(
      `${definition.componentName} readiness requires three distinct execution receipts, identities, and invocations with stable derivation and generation`,
    );
  }
}

function sameStableEvidence(left: PipelineAuditReceipt, right: PipelineAuditReceipt): boolean {
  return left.schemaVersion === right.schemaVersion &&
    left.derivationVersion === right.derivationVersion &&
    left.beforeGenerationVectorHash === right.beforeGenerationVectorHash &&
    left.afterGenerationVectorHash === right.afterGenerationVectorHash &&
    left.canonicalCount === right.canonicalCount &&
    left.canonicalOrderedHash === right.canonicalOrderedHash &&
    left.projectionCount === right.projectionCount &&
    left.projectionOrderedHash === right.projectionOrderedHash &&
    left.queueCount === right.queueCount &&
    left.queueOrderedHash === right.queueOrderedHash &&
    left.copiedDatabaseIdentity === right.copiedDatabaseIdentity;
}

function component(
  componentName: PerformanceComponentName,
  featureName: Exclude<PerformanceFeatureName, "operationalProjection">,
  derivationVersion: string,
  invariantNames: readonly string[],
  queueStages: readonly PipelineWorkStage[],
): PerformanceComponentAuditDefinition {
  if (new Set(invariantNames).size !== invariantNames.length || invariantNames.length < 1) {
    throw new Error(`${componentName} invariant contracts must be unique`);
  }
  if (new Set(queueStages).size !== queueStages.length || queueStages.length < 1) {
    throw new Error(`${componentName} queue contracts must be unique`);
  }
  return Object.freeze({
    componentName,
    featureName,
    derivationVersion: boundedIdentity(derivationVersion, "derivationVersion"),
    invariantNames: Object.freeze([...invariantNames]),
    queueStages: Object.freeze([...queueStages]),
  });
}

function exactNamedMap<T, K extends string>(
  values: readonly T[],
  expected: readonly K[],
  identity: (value: T) => string,
  label: string,
): ReadonlyMap<K, T> {
  if (!Array.isArray(values) || values.length !== expected.length) {
    throw new Error(`${label} evidence does not cover the exact contract`);
  }
  const allowed = new Set<string>(expected);
  const result = new Map<K, T>();
  for (const value of values) {
    const key = identity(value);
    if (!allowed.has(key) || result.has(key as K)) {
      throw new Error(`${label} evidence has an unknown or duplicate identity`);
    }
    result.set(key as K, value);
  }
  return result;
}

async function requiredReceipt(
  database: D1Database,
  receiptId: string,
): Promise<PipelineAuditReceipt> {
  const receipt = await readPipelineAuditReceipt(database, receiptId);
  if (!receipt) throw new Error(`component audit receipt ${receiptId} was not stored`);
  return receipt;
}

function assertReceiptMatchesInput(
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
  };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key as keyof PipelineAuditReceipt] !== value) {
      throw new Error(`audit identity ${receipt.receiptId} already binds different ${key}`);
    }
  }
}

function count(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) {
    throw new RangeError(`${label} must be a bounded nonnegative integer`);
  }
  return value;
}

function sha256(value: string, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 identity`);
  }
  return value;
}

function boundedIdentity(value: string, label: string): string {
  if (
    typeof value !== "string" || value.length < 1 || value.length > 512 ||
    value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new TypeError(`${label} must be a bounded canonical identity`);
  return value;
}

function canonicalTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO timestamp`);
  }
  return value;
}
