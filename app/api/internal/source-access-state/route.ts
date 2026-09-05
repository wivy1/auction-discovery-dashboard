import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../../../db/bootstrap";
import { HttpError, jsonError } from "../../../../lib/http";
import { readBoundedJson } from "../../../../lib/local-companion";
import { assertLoopbackRequest } from "../../../../lib/local-request";
import {
  inspectSourceAccessStates,
  resetSourceAccessState,
} from "../../../../lib/sources/access-state";

export const dynamic = "force-dynamic";

const MAX_RESET_BODY_BYTES = 2_048;
const allowedResetKeys = new Set([
  "action",
  "sourceId",
  "laneKey",
  "operatorReason",
  "operatorActor",
]);

interface ResetPayload {
  readonly action?: unknown;
  readonly sourceId?: unknown;
  readonly laneKey?: unknown;
  readonly operatorReason?: unknown;
  readonly operatorActor?: unknown;
}

export async function GET(request: Request) {
  try {
    assertLoopbackRequest(request, "Source access state");
    const url = new URL(request.url);
    for (const key of url.searchParams.keys()) {
      if (key !== "sourceId" && key !== "laneKey" && key !== "limit") {
        throw invalidRequest(`unsupported inspection parameter ${key}`);
      }
    }
    const sourceId = optionalUniqueParameter(url, "sourceId");
    const laneKey = optionalUniqueParameter(url, "laneKey");
    const limitText = optionalUniqueParameter(url, "limit");
    const limit = limitText === undefined ? undefined : Number(limitText);
    const database = runtimeDatabase();
    await ensureDatabase(database);
    let result;
    try {
      result = await inspectSourceAccessStates({
        database,
        sourceId,
        laneKey,
        limit,
      });
    } catch (error) {
      throw validationError(error);
    }
    return Response.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    assertLoopbackRequest(request, "Source access state");
    const payload = await readBoundedJson<ResetPayload>(request, MAX_RESET_BODY_BYTES);
    if (
      typeof payload !== "object" || payload === null || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !allowedResetKeys.has(key)) ||
      payload.action !== "reset" ||
      typeof payload.sourceId !== "string" ||
      typeof payload.laneKey !== "string" ||
      typeof payload.operatorReason !== "string" ||
      (payload.operatorActor !== undefined && typeof payload.operatorActor !== "string")
    ) {
      throw invalidRequest(
        "reset requires exact sourceId, laneKey, and a bounded nonempty operatorReason",
      );
    }
    const database = runtimeDatabase();
    await ensureDatabase(database);
    let row;
    try {
      row = await resetSourceAccessState({
        database,
        sourceId: payload.sourceId,
        laneKey: payload.laneKey,
        operatorReason: payload.operatorReason,
        operatorActor: payload.operatorActor,
      });
    } catch (error) {
      throw validationError(error);
    }
    if (row === null) {
      throw new HttpError(
        "The exact source access state does not exist",
        404,
        "source_access_state_not_found",
      );
    }
    return Response.json({ reset: true, row }, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}

function runtimeDatabase(): D1Database {
  const database = (env as unknown as { readonly DB?: D1Database }).DB;
  if (!database) throw new Error("Cloudflare D1 binding `DB` is unavailable");
  return database;
}

function optionalUniqueParameter(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) throw invalidRequest(`${key} may be specified only once`);
  return values.length === 0 ? undefined : values[0];
}

function invalidRequest(message: string): HttpError {
  return new HttpError(message, 400, "invalid_source_access_state_request");
}

function validationError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof RangeError) return invalidRequest(error.message);
  throw error;
}
