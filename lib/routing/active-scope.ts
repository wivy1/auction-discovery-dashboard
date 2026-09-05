import { getConfig } from "../config";
import { readActiveOrigin } from "../settings/active-origin";
import { locationCacheKey } from "./helpers";

export interface ActiveRouteScope {
  readonly postalCode: string;
  readonly countryCode: "US";
  readonly updatedAt: string;
  readonly originCacheKey: string;
  readonly providerName: string;
}

/** One authoritative scope shared by discovery, dashboard, and image work. */
export async function readActiveRouteScope(): Promise<ActiveRouteScope> {
  const origin = await readActiveOrigin();
  return {
    postalCode: origin.postalCode,
    countryCode: origin.countryCode,
    updatedAt: origin.updatedAt,
    originCacheKey: locationCacheKey({
      postalCode: origin.postalCode,
      countryCode: origin.countryCode,
    }),
    providerName: getConfig().routing.routeProvider,
  };
}
