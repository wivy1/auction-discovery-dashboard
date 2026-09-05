import { env } from "cloudflare:workers";
import { getConfig } from "../config";
import {
  setActiveOrigin,
  type ActiveOrigin,
  type ActiveOriginInput,
} from "./active-origin";
import type { PipelineRunKind } from "../pipeline/storage";

export class ActiveOriginBusyError extends Error {
  readonly activeRunId: string;
  readonly activeRunKind: PipelineRunKind;

  constructor(activeRunId: string, activeRunKind: PipelineRunKind = "discovery") {
    super(`${activeRunKind === "discovery" ? "Discovery" : "Enrichment"} run ${activeRunId} is already using the active origin`);
    this.name = "ActiveOriginBusyError";
    this.activeRunId = activeRunId;
    this.activeRunKind = activeRunKind;
  }
}

/** Prevents a live run and the dashboard from switching origins mid-flight. */
export async function setActiveOriginWhenIdle(
  input: ActiveOriginInput,
): Promise<ActiveOrigin> {
  const now = new Date().toISOString();
  const cutoff = new Date(
    Date.now() - getConfig().limits.discoveryRunLeaseMs,
  ).toISOString();
  const active = await env.DB.prepare(`
    SELECT run_id, run_kind, acquired_at AS started_at
    FROM pipeline_run_lease
    WHERE singleton = 1 AND expires_at > ?
    UNION ALL
    SELECT id AS run_id, 'discovery' AS run_kind, started_at
    FROM discovery_runs
    WHERE status = 'running' AND started_at >= ?
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_run_lease
        WHERE singleton = 1 AND expires_at > ?
      )
    UNION ALL
    SELECT id AS run_id, 'enrichment' AS run_kind, started_at
    FROM enrichment_runs
    WHERE status = 'running' AND started_at >= ?
      AND NOT EXISTS (
        SELECT 1 FROM pipeline_run_lease
        WHERE singleton = 1 AND expires_at > ?
      )
    ORDER BY started_at DESC
    LIMIT 1
  `).bind(
    now,
    cutoff,
    now,
    cutoff,
    now,
  ).first<{ run_id: string; run_kind: PipelineRunKind }>();
  if (active) throw new ActiveOriginBusyError(active.run_id, active.run_kind);
  return setActiveOrigin(input, env.DB);
}
