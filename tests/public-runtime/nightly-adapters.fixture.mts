import { createJsonApiSource } from "../../lib/sources/json-api.ts";
import type { SourceRegistration } from "../../lib/sources/registration.ts";

const adapter = createJsonApiSource({
  id: "nightly_fixture",
  displayName: "Nightly fixture inventory",
  baseUrl: "https://nightly.fixture.test",
  inventoryUrl: "https://nightly.fixture.test/inventory",
  access: {
    permissionBasis: "recorded_permission",
    permissionReference: "synthetic-nightly-fixture-only",
    permissionRecordedAt: "2026-01-01T00:00:00Z",
    reviewedAt: "2026-01-01T00:00:00Z",
    termsUrl: null, robotsUrl: null, documentationUrls: [],
    note: "Fixture only; every source request is intercepted by the test.",
  },
  requests: { minDelayMs: 1, maxRequestsPerRun: 5, maxResponseBytes: 50_000, timeoutMs: 5_000, maxRetries: 0 },
  itemsPath: ["items"], totalPath: ["total"], inlineDetails: true,
  mapListing: (item) => ({
    sourceListingId: String(item.id), sourceUrl: `https://nightly.fixture.test/items/${String(item.id)}`,
    title: String(item.title), currentState: "current",
    visibleLocation: { postalCode: "90210", countryCode: "US" },
    detail: {
      rawDescription: String(item.description), cleanDescription: String(item.description),
      priceAtScrape: { amountMinor: 1250, currency: "USD", displayText: "$12.50" },
      auctionEndsAt: "2099-01-01T00:00:00Z", seller: "Fixture seller",
      pickupLocation: { postalCode: "90210", countryCode: "US" }, images: [],
    },
  }),
});

export default [{ adapter, enabled: true }] satisfies readonly SourceRegistration[];
