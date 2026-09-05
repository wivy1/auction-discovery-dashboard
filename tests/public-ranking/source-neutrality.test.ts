import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  canonicalItemDescription,
  genericMarketplacePolicySignal,
  policySignalIsGrounded,
} from "../../lib/domain/item-text.ts";
import {
  RUNTIME_EXECUTION_EVIDENCE_KINDS,
  createRuntimeExecutionEvidenceEnvelope,
  appendSchedulerExecutionEvidence,
  readRuntimeExecutionEvidence,
} from "../../lib/performance/runtime-execution-evidence.ts";
import { PERFORMANCE_FEATURE_NAMES, readNightlyPerformanceFeatures } from "../../lib/performance/features.ts";
import { performanceComponentAuditRegistry } from "../../lib/performance/component-readiness.ts";

test("runtime evidence and component registries contain only source-neutral capabilities", () => {
  assert.deepEqual(RUNTIME_EXECUTION_EVIDENCE_KINDS, ["unified_source_scheduler", "preparation_scheduler"]);
  assert.deepEqual(PERFORMANCE_FEATURE_NAMES, [
    "operationalProjection", "queueBackedProximity", "globalPreparationScheduler",
    "enrichmentSessionResidency", "dirtyPreferenceV2Scoring", "unifiedSourceScheduler",
    "dashboardReleaseGenerations", "contentAddressedImageReuse",
  ]);
  assert.equal(performanceComponentAuditRegistry.length, PERFORMANCE_FEATURE_NAMES.length - 1);
  const features = readNightlyPerformanceFeatures({});
  assert.deepEqual(Object.keys(features.modes).sort(), [...PERFORMANCE_FEATURE_NAMES].sort());
});

test("canonical descriptions preserve source text and generic policy grounding remains available", () => {
  for (const text of ["", "Workbench\r\nSold as is\r\n", "No warranty\nAll sales are final.", "Inspection required\rPickup by appointment"]) {
    assert.equal(canonicalItemDescription(text), text);
  }
  assert.equal(genericMarketplacePolicySignal("Sold as is"), "as_is");
  assert.equal(genericMarketplacePolicySignal("Workbench includes a vise"), null);
  assert.equal(policySignalIsGrounded("no_warranty", "Sold without any warranty."), true);
  assert.equal(policySignalIsGrounded("no_warranty", "Tested and working."), false);
});

test("generic execution envelopes preserve deterministic identities and reject unknown evidence kinds", async () => {
  const hash = `sha256:${"2".repeat(64)}`;
  const input = {
    evidenceKind: "preparation_scheduler" as const,
    derivationVersion: "fixture-runtime-v1",
    invocationIdentityHash: hash, inputGenerationVectorHash: hash,
    inputBoundaryHash: hash, outputBoundaryHash: hash,
    payload: { fixture: true },
  };
  const first = await createRuntimeExecutionEvidenceEnvelope(input);
  assert.deepEqual(await createRuntimeExecutionEvidenceEnvelope(input), first);
  const changed = await createRuntimeExecutionEvidenceEnvelope({ ...input, payload: { fixture: false } });
  assert.notEqual(changed.executionIdentityHash, first.executionIdentityHash);
  await assert.rejects(createRuntimeExecutionEvidenceEnvelope({ ...input, evidenceKind: "unsupported_source_protocol" as never }), /kind is invalid/);
});

test("generic scheduler evidence still appends and validates an idempotent pair of SQLite receipts", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`CREATE TABLE pipeline_execution_evidence (
      execution_receipt_id TEXT PRIMARY KEY, evidence_kind TEXT, evidence_schema_version TEXT,
      derivation_version TEXT, evidence_identity_hash TEXT, execution_identity_hash TEXT,
      invocation_identity_hash TEXT, input_generation_vector_hash TEXT,
      input_boundary_hash TEXT, output_boundary_hash TEXT, evidence_json TEXT, completed_at TEXT
    )`);
    const database = {
      prepare(sql: string) {
        let values: SQLInputValue[] = [];
        return {
          bind(...bindings: SQLInputValue[]) { values = bindings; return this; },
          async first() { return sqlite.prepare(sql).get(...values) ?? null; },
          async run() { sqlite.prepare(sql).run(...values); return { success: true, results: [], meta: {} }; },
        };
      },
      async batch(statements: D1PreparedStatement[]) {
        sqlite.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      },
    } as unknown as D1Database;
    const hash = `sha256:${"3".repeat(64)}`;
    const counters = {
      inputBoundaryHash: hash, outputBoundaryHash: hash, candidateOrderHash: hash,
      decisionHash: hash, mutationOrderHash: hash, timingObservationHash: hash,
      snapshotCount: 1, candidateObservationCount: 0, decisionObservationCount: 0,
      mutationObservationCount: 0, selectedCount: 0, requestCount: 0,
      childProcessCount: 0 as const, singleWriterObserved: true as const, commitObservationCount: 0,
      maxConcurrentCommits: 0, maxConcurrentValidations: 0,
    };
    const evidence = {
      schemaVersion: "auction-discovery-scheduler-execution-evidence-v2" as const,
      unifiedSourceScheduler: { ...counters, derivationVersion: "unified-source-scheduler-execution-v2" as const },
      preparationScheduler: { ...counters, derivationVersion: "preparation-scheduler-execution-v2" as const },
    };
    const input = { database, evidence, invocationIdentityHash: hash, completedAt: "2026-01-01T00:00:00.000Z" };
    const first = await appendSchedulerExecutionEvidence(input);
    assert.equal(first.unifiedSourceScheduler.idempotent, false);
    assert.equal(first.preparationScheduler.idempotent, false);
    const stored = await readRuntimeExecutionEvidence(database, first.preparationScheduler.receiptId);
    assert.deepEqual(stored?.payload, evidence.preparationScheduler);
    const repeated = await appendSchedulerExecutionEvidence(input);
    assert.equal(repeated.unifiedSourceScheduler.idempotent, true);
    assert.equal(repeated.preparationScheduler.idempotent, true);
    assert.equal(sqlite.prepare("SELECT count(*) AS count FROM pipeline_execution_evidence").get()?.count, 2);
  } finally { sqlite.close(); }
});
