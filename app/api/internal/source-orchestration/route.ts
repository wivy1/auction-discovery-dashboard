import { assertLoopbackRequest } from "../../../../lib/local-request";
import { jsonError } from "../../../../lib/http";
import { sourceOrchestrationPayload } from "../../../../lib/sources/orchestration";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertLoopbackRequest(request, "Source orchestration");
    return Response.json(sourceOrchestrationPayload(), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
