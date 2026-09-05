import { ensureDatabase } from "../../../db/bootstrap";
import {
  readDashboardPayload,
  type DashboardListingScope,
} from "../../../db/dashboard";
import { HttpError, jsonError } from "../../../lib/http";
import { withRouteTiming } from "../../../lib/performance/http-route-timing";
import { syncConfiguredSourceManifests } from "../../../lib/settings/source-manifests";

export const dynamic = "force-dynamic";

let dashboardInitialization: Promise<void> | null = null;

async function ensureDashboardReadReady(): Promise<void> {
  dashboardInitialization ??= (async () => {
    await ensureDatabase();
    await syncConfiguredSourceManifests();
  })();
  try {
    await dashboardInitialization;
  } catch (error) {
    dashboardInitialization = null;
    throw error;
  }
}

const DASHBOARD_LISTING_SCOPES = new Set<DashboardListingScope>([
  "unvoted",
  "all",
  "voted",
  "interested",
  "not_interested",
]);

function listingScopeFromRequest(request: Request): DashboardListingScope {
  const values = new URL(request.url).searchParams.getAll("listingScope");
  if (values.length === 0) return "unvoted";
  if (
    values.length !== 1 ||
    !DASHBOARD_LISTING_SCOPES.has(values[0] as DashboardListingScope)
  ) {
    throw new HttpError(
      "listingScope must be supplied at most once with a supported value",
      400,
      "invalid_listing_scope",
    );
  }
  return values[0] as DashboardListingScope;
}

async function readDashboard(request: Request): Promise<Response> {
  try {
    const listingScope = listingScopeFromRequest(request);
    await ensureDashboardReadReady();
    const payload = await readDashboardPayload(listingScope);
    return Response.json(payload, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  return withRouteTiming("dashboard", () => readDashboard(request));
}
