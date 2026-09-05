import { HttpError } from "../../../../lib/http";
import { assertLoopbackRequest } from "../../../../lib/local-request";
import {
  loadedRuntimeRevision,
  RuntimeRevisionError,
  runtimeRevisionPayload,
} from "../../../../lib/runtime-revision";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "cache-control": "no-store" } as const;

export function GET(request: Request): Response {
  try {
    assertLoopbackRequest(request, "Runtime revision");
    return Response.json(runtimeRevisionPayload(loadedRuntimeRevision()), {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    const failure = error instanceof RuntimeRevisionError
      ? new HttpError(
          "The loaded local runtime revision is unavailable",
          503,
          "runtime_revision_unavailable",
        )
      : error;
    if (failure instanceof HttpError) {
      return Response.json({ error: failure.message, code: failure.code }, {
        status: failure.status,
        headers: NO_STORE_HEADERS,
      });
    }
    return Response.json({
      error: "The loaded local runtime revision is unavailable",
      code: "runtime_revision_unavailable",
    }, { status: 503, headers: NO_STORE_HEADERS });
  }
}
