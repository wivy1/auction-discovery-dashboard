import { createJsonApiSource } from "../../lib/sources/json-api.ts";
import { createHeadlessBrowserSource, createHtmlSource, type SourceHtmlElement } from "../../lib/sources/html.ts";
import type { GenericListingFacts } from "../../lib/sources/generic.ts";
import type { SourceRegistration } from "../../lib/sources/registration.ts";

const access = {
  permissionBasis: "recorded_permission" as const,
  permissionReference: "synthetic-integration-fixtures-only",
  permissionRecordedAt: "2026-01-01T00:00:00Z",
  reviewedAt: "2026-01-01T00:00:00Z",
  termsUrl: null, robotsUrl: null, documentationUrls: [],
  note: "Synthetic test fixtures only; network is intercepted by the test.",
};
const requests = { minDelayMs: 1, maxRequestsPerRun: 10, maxResponseBytes: 100_000, timeoutMs: 5_000, maxRetries: 0, allowedImageHosts: ["images.fixture.test"] };
export function facts(item: Readonly<Record<string, unknown>>, host: string, inline: boolean): GenericListingFacts {
  const id = String(item.id);
  return {
    sourceListingId: id, sourceUrl: `https://${host}/items/${id}`,
    title: String(item.title), currentState: "current",
    visibleLocation: { postalCode: "90210", countryCode: "US" },
    ...(inline ? { detail: {
      rawDescription: String(item.description ?? "Observed fixture description"),
      cleanDescription: String(item.description ?? "Observed fixture description"),
      priceAtScrape: { amountMinor: 1234, currency: "USD", displayText: "$12.34" },
      auctionEndsAt: "2099-01-01T00:00:00Z", seller: "Fixture seller",
      pickupLocation: { postalCode: "90210", countryCode: "US" },
      images: item.image ? [{ sourceUrl: String(item.image) }] : [],
    } } : {}),
  };
}
const json = createJsonApiSource({
  id: "fixture_json", displayName: "Fixture JSON", baseUrl: "https://json.fixture.test", inventoryUrl: "https://json.fixture.test/inventory",
  access, requests, itemsPath: ["items"], totalPath: ["total"],
  mapListing: (item) => facts(item, "json.fixture.test", false),
  detail: { mapListing: (item) => facts(item, "json.fixture.test", true) },
});
function mapHtml(element: SourceHtmlElement, host: string) {
  return facts({ id: element.getAttribute("data-id"), title: element.textContent, description: element.getAttribute("data-description") ?? "Observed HTML fixture" }, host, true);
}
const html = createHtmlSource({
  id: "fixture_html", displayName: "Fixture HTML", baseUrl: "https://html.fixture.test", inventoryUrl: "https://html.fixture.test/inventory",
  access, requests, inlineDetails: true, inventorySelector: "main", listingSelector: "article", emptySelector: "[data-empty]",
  mapListing: (element) => mapHtml(element, "html.fixture.test"),
});
const browser = createHeadlessBrowserSource({
  id: "fixture_browser", displayName: "Fixture browser", baseUrl: "https://browser.fixture.test", inventoryUrl: "https://browser.fixture.test/inventory",
  access, requests, inlineDetails: true, inventorySelector: "main", listingSelector: "article", emptySelector: "[data-empty]",
  browser: { readySelector: "article, [data-empty]" },
  mapListing: (element) => mapHtml(element, "browser.fixture.test"),
});
export default [json, html, browser].map((adapter) => ({ adapter, enabled: true })) satisfies readonly SourceRegistration[];
