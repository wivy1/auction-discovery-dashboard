import { createHeadlessBrowserSource } from "../../lib/sources/html.ts";
import { SourceAdapterError } from "../../lib/sources/types.ts";
import type { SourceRegistration } from "../../lib/sources/registration.ts";

const adapter = createHeadlessBrowserSource({
  id: "callback_fixture", displayName: "Callback fixture", baseUrl: "https://callback.fixture.invalid",
  inventoryUrl: "https://callback.fixture.invalid/inventory", inlineDetails: true,
  access: {
    permissionBasis: "recorded_permission", permissionReference: "synthetic-callback-fixture-only",
    permissionRecordedAt: "2026-01-01T00:00:00Z", reviewedAt: "2026-01-01T00:00:00Z",
    termsUrl: null, robotsUrl: null, documentationUrls: [], note: "Offline fixture; no source request is made.",
  },
  requests: { minDelayMs: 1, maxRequestsPerRun: 4, maxResponseBytes: 50_000, timeoutMs: 1_000, maxRetries: 0 },
  inventorySelector: "main", listingSelector: "article", emptySelector: "[data-empty]",
  mapListing: (element) => ({
    sourceListingId: element.getAttribute("data-id")!, sourceUrl: `https://callback.fixture.invalid/items/${element.getAttribute("data-id")}`,
    title: element.textContent ?? "", currentState: "current",
    visibleLocation: { postalCode: "90210", countryCode: "US" },
    detail: {
      rawDescription: "Observed fixture description", cleanDescription: "Observed fixture description",
      priceAtScrape: {}, auctionEndsAt: "2099-01-01T00:00:00Z", seller: "Fixture seller",
      pickupLocation: { postalCode: "90210", countryCode: "US" }, images: [],
    },
  }),
});

export default [{ enabled: true, adapter: {
  ...adapter,
  planDiscovery(options) {
    const mode = (globalThis as unknown as { __publicSourceCallbackFixture: { planFailure: string | null } })
      .__publicSourceCallbackFixture.planFailure;
    if (mode === "structural") throw new SourceAdapterError("callback_fixture", "Private fixture source text must not cross the callback");
    if (mode === "mismatched") throw new SourceAdapterError("another_fixture", "Private fixture source text");
    if (mode === "runtime") throw new Error("Fixture runtime failure");
    return adapter.planDiscovery(options);
  },
} }] satisfies readonly SourceRegistration[];
