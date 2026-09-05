import { env } from "cloudflare:workers";

import { HttpError } from "../../../../lib/http";
import { assertLoopbackRequest } from "../../../../lib/local-request";
import { withRouteTiming } from "../../../../lib/performance/http-route-timing";
import {
  createRuntimeDatabaseReadiness,
  RuntimeDatabaseReadinessError,
  type RuntimeReadinessDatabase,
} from "../../../../lib/performance/runtime-readiness";
import {
  loadedRuntimeRevision,
  loadedSupervisorInstanceId,
  RUNTIME_REVISION_SCHEMA_VERSION,
  runtimeRevisionPayload,
} from "../../../../lib/runtime-revision";

export const dynamic = "force-dynamic";

export const RUNTIME_HEALTH_SCHEMA_VERSION =
  "auction-discovery-runtime-health-v1" as const;

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;
const inspectDatabaseReadiness = createRuntimeDatabaseReadiness();

/**
 * A deliberately narrow liveness/readiness probe for the supervised local
 * Worker. The first check proves the write path; routine checks are read-only.
 */
async function readRuntimeHealth(request: Request): Promise<Response> {
  let failureStage = "request";
  try {
    assertLoopbackRequest(request, "Runtime health");
    failureStage = "binding";
    const database = (env as unknown as { readonly DB?: D1Database }).DB;
    if (!database) throw new Error("D1 binding unavailable");

    failureStage = "database";
    const readiness = await inspectDatabaseReadiness(
      database as unknown as RuntimeReadinessDatabase,
    );

    failureStage = "runtime_revision";
    const revision = runtimeRevisionPayload(loadedRuntimeRevision());
    failureStage = "supervisor_identity";
    const supervisorInstanceId = loadedSupervisorInstanceId();
    return Response.json({
      schemaVersion: RUNTIME_HEALTH_SCHEMA_VERSION,
      status: "ready",
      databaseReadable: readiness.readable,
      databaseWritable: readiness.writable,
      runtimeRevisionSchema: RUNTIME_REVISION_SCHEMA_VERSION,
      runtimeRevision: revision.revision,
      supervisorInstanceId,
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof HttpError) {
      return Response.json({ error: error.message, code: error.code }, {
        status: error.status,
        headers: NO_STORE_HEADERS,
      });
    }
    return Response.json({
      error: "The local runtime health check is unavailable",
      code: "runtime_health_unavailable",
      failureStage: error instanceof RuntimeDatabaseReadinessError
        ? `database_${error.stage}`
        : failureStage,
    }, { status: 503, headers: NO_STORE_HEADERS });
  }
}

export async function GET(request: Request): Promise<Response> {
  return withRouteTiming("runtime_health", () => readRuntimeHealth(request));
}
