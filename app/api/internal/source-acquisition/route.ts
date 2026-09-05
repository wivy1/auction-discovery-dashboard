import { env } from "cloudflare:workers";
import { ensureDatabase } from "../../../../db/bootstrap";
import { HttpError, jsonError } from "../../../../lib/http";
import { assertLocalCompanionRequest, readBoundedJson } from "../../../../lib/local-companion";
import { assertMatchingLoadedRuntimeRevision } from "../../../../lib/runtime-revision-request";
import { configuredSourceAccessGrant } from "../../../../lib/settings/source-manifests";
import { readEnabledSourceIds } from "../../../../lib/pipeline/storage";
import { runAuctionDiscovery } from "../../../../lib/pipeline/discovery";
import { planGenericSourceAcquisition, validateGenericAcquiredPages } from "../../../../lib/pipeline/source-acquisition";

export const dynamic = "force-dynamic";

/** Only the authenticated loopback companion can submit captured source pages. */
export async function POST(request: Request) {
  try {
    const runtimeEnv = env as unknown as Record<string, unknown>;
    assertLocalCompanionRequest(request, typeof runtimeEnv.AUCTION_DISCOVERY_IMAGE_TOKEN === "string" ? runtimeEnv.AUCTION_DISCOVERY_IMAGE_TOKEN : undefined);
    assertMatchingLoadedRuntimeRevision(request);
    const payload = await readBoundedJson<Record<string, unknown>>(request, 24 * 1024 * 1024);
    if (!payload || typeof payload !== "object" || typeof payload.sourceId !== "string" || !["plan", "commit"].includes(String(payload.action)) || Object.keys(payload).some((key) => !["sourceId", "action", "pages", "trigger"].includes(key))) {
      throw new HttpError("Invalid generic source acquisition request", 400, "invalid_source_acquisition");
    }
    if (payload.trigger !== undefined && payload.trigger !== "manual" && payload.trigger !== "scheduled") throw new HttpError("Invalid discovery trigger", 400);
    await ensureDatabase();
    const enabled = await readEnabledSourceIds();
    const plan = planGenericSourceAcquisition(payload.sourceId, configuredSourceAccessGrant(payload.sourceId, enabled.has(payload.sourceId)));
    if (payload.action === "plan") {
      if (payload.pages !== undefined) throw new HttpError("Planning cannot submit pages", 400);
      return Response.json({ plan });
    }
    const pages = await validateGenericAcquiredPages(plan, payload.pages);
    // runAuctionDiscovery owns the existing singleton D1/R2 mutation lease.
    const catalog = await runAuctionDiscovery(payload.trigger === "scheduled" ? "scheduled" : "manual", {
      sourceId: plan.sourceId, acquiredPages: pages, catalogOnly: true,
    });
    return Response.json({ catalog });
  } catch (error) {
    return jsonError(error);
  }
}

