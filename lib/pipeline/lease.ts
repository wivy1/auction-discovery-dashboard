export type RenewablePipelineRunKind = "discovery" | "enrichment";

export class PipelineRunLeaseLostError extends Error {
  readonly runKind: RenewablePipelineRunKind;
  readonly runId: string;

  constructor(runKind: RenewablePipelineRunKind, runId: string) {
    super(`${runKind === "discovery" ? "Discovery" : "Enrichment"} run ${runId} no longer owns the pipeline lease`);
    this.name = "PipelineRunLeaseLostError";
    this.runKind = runKind;
    this.runId = runId;
  }
}

/**
 * Extends only a live lease still owned by the exact run. An expired lease is
 * deliberately not resurrected: another request may already be taking over.
 */
export async function renewOwnedPipelineRunLease(input: {
  database: D1Database;
  runKind: RenewablePipelineRunKind;
  runId: string;
  leaseMs: number;
  now?: Date;
}): Promise<string> {
  if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0) {
    throw new RangeError("pipeline run lease must be a positive integer number of milliseconds");
  }
  if (!input.runId.trim()) {
    throw new RangeError("pipeline run id is required to renew its lease");
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new RangeError("pipeline lease renewal time is invalid");
  const nowIso = now.toISOString();
  const expiresAt = new Date(nowMs + input.leaseMs).toISOString();
  const result = await input.database.prepare(`
    UPDATE pipeline_run_lease
    SET expires_at = ?
    WHERE singleton = 1
      AND run_kind = ?
      AND run_id = ?
      AND expires_at > ?
  `).bind(
    expiresAt,
    input.runKind,
    input.runId,
    nowIso,
  ).run();

  if ((result.meta.changes ?? 0) !== 1) {
    throw new PipelineRunLeaseLostError(input.runKind, input.runId);
  }
  return expiresAt;
}
