import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const databaseDirectory = join(
  fileURLToPath(new URL("../", import.meta.url)),
  ".wrangler",
  "state",
  "v3",
  "d1",
  "miniflare-D1DatabaseObject",
);
const databaseFiles = readdirSync(databaseDirectory)
  .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite");

if (databaseFiles.length !== 1) {
  throw new Error(
    `Expected exactly one project D1 database, found ${databaseFiles.length}.`,
  );
}

const database = new DatabaseSync(
  join(databaseDirectory, databaseFiles[0]),
  { readOnly: true },
);
try {
  const checkedAt = new Date().toISOString();
  const active = database.prepare(`
    SELECT
      'lease' AS evidence,
      run_kind AS runKind,
      run_id AS runId,
      acquired_at AS startedAt,
      expires_at AS expiresAt,
      'leased' AS status
    FROM pipeline_run_lease
    WHERE singleton = 1 AND expires_at > ?
  `).all(checkedAt);
  const activeReservations = database.prepare(`
    SELECT reservation_id AS reservationId, source_id AS sourceId,
      request_role AS requestRole, lane_key AS laneKey,
      lease_owner AS leaseOwner, state, created_at AS createdAt,
      expires_at AS expiresAt
    FROM source_acquisition_reservations
    WHERE state IN ('reserved', 'acquired') AND expires_at > ?
    ORDER BY expires_at, reservation_id
  `).all(checkedAt);
  const activeWorkClaims = database.prepare(`
    SELECT stage, subject_type AS subjectType, subject_id AS subjectId,
      lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt
    FROM pipeline_work_items
    WHERE lease_owner IS NOT NULL AND lease_expires_at > ?
    ORDER BY lease_expires_at, stage, subject_type, subject_id
  `).all(checkedAt);
  const orphanedRuns = database.prepare(`
    SELECT
      'discovery' AS runKind,
      run.id AS runId,
      run.started_at AS startedAt,
      lease.expires_at AS expiresAt,
      run.status
    FROM discovery_runs run
    LEFT JOIN pipeline_run_lease lease
      ON lease.run_kind = 'discovery'
      AND lease.run_id = run.id
    WHERE run.status = 'running'
      AND (lease.run_id IS NULL OR lease.expires_at <= ?)
    UNION ALL
    SELECT
      'enrichment',
      run.id,
      run.started_at,
      lease.expires_at,
      run.status
    FROM enrichment_runs run
    LEFT JOIN pipeline_run_lease lease
      ON lease.run_kind = 'enrichment'
      AND lease.run_id = run.id
    WHERE run.status = 'running'
      AND (lease.run_id IS NULL OR lease.expires_at <= ?)
  `).all(checkedAt, checkedAt);
  console.log(JSON.stringify({
    checkedAt,
    idle: active.length === 0 && activeReservations.length === 0 &&
      activeWorkClaims.length === 0,
    active,
    activeReservations,
    activeWorkClaims,
    orphanedRuns,
  }));
  if (
    active.length > 0 || activeReservations.length > 0 ||
    activeWorkClaims.length > 0
  ) process.exitCode = 2;
} finally {
  database.close();
}
