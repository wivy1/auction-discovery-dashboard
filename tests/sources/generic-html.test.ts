import assert from "node:assert/strict";
import test from "node:test";
import { createHeadlessBrowserSource, createHtmlSource, type HtmlSourceOptions } from "../../lib/sources/html";
import { preflightAcquiredInventoryBundle, acquiredRequestBudgetCostForSource } from "../../lib/sources/acquired-pages";
import type { AcquiredSourcePage } from "../../lib/sources/acquired-pages";
import type { SourcePage } from "../../lib/sources/types";

const options: HtmlSourceOptions = {
  id: "fixture_html", displayName: "HTML fixture", baseUrl: "https://auctions.example.com/",
  inventoryUrl: "https://auctions.example.com/current", inlineDetails: true,
  inventorySelector: "main.inventory", listingSelector: "article[data-id]", emptySelector: "[data-empty]",
  mapListing: (row) => ({
    sourceListingId: row.getAttribute("data-id")!, sourceUrl: row.querySelector("a")!.getAttribute("href")!,
    title: row.querySelector("h2")!.textContent!, currentState: row.getAttribute("data-state") as "current" | "ended",
    detail: { rawDescription: row.querySelector("p")!.textContent!, cleanDescription: row.querySelector("p")!.textContent!,
      priceAtScrape: {}, auctionEndsAt: null, seller: null, images: [] },
  }),
};
const card = '<article data-id="one" data-state="current"><a href="/lots/one"><h2>Meter &amp; probe</h2></a><p>Manufacturer source text.</p></article>';
function page(body: string): SourcePage { return { url: options.inventoryUrl, body, fetchedAt: "2026-09-05T12:00:00.000Z", contentType: "text/html" }; }

test("HTML selectors map actual nested markup and entity-decoded source text", () => {
  const adapter = createHtmlSource(options);
  const listing = adapter.parseDiscoveryBatch!(page(`<main class="inventory">${card}</main>`))[0]!;
  assert.equal(listing.stub.title, "Meter & probe");
  assert.equal(listing.stub.sourceUrl, "https://auctions.example.com/lots/one");
  assert.equal(listing.detail!.cleanDescription, "Manufacturer source text.");
  assert.deepEqual(listing.detail!.images, []);
});

test("HTML accepts only a recognized explicit empty inventory", () => {
  const adapter = createHtmlSource(options);
  assert.deepEqual(adapter.parseDiscoveryBatch!(page('<main class="inventory"><p data-empty>No active listings</p></main>')), []);
  for (const body of ["<title>Access denied</title>", '<main class="inventory"></main>', '<main class="inventory"></main><main class="inventory"></main>', `<main class="inventory">${card}<p data-empty></p></main>`]) {
    assert.throws(() => adapter.parseDiscoveryBatch!(page(body)));
  }
});

test("the browser template parses rendered HTML through the same complete inventory contract", () => {
  const adapter = createHeadlessBrowserSource(options);
  assert.equal(adapter.manifest.acquisition, "isolated_browser");
  const captured = page(`<main class="inventory">${card}</main>`);
  const request = adapter.planDiscovery()[0]!;
  const acquired: AcquiredSourcePage = { request, page: captured, startedAt: captured.fetchedAt,
    requestStartedAt: [captured.fetchedAt], bodySha256: "0".repeat(64), requestBudgetCost: acquiredRequestBudgetCostForSource(options.id, request) };
  // This exercises normalized publication preflight. Hash/wire validation and
  // the actual headless browser executor are covered by the companion owner.
  assert.doesNotThrow(() => preflightAcquiredInventoryBundle(adapter, [acquired]));
  assert.throws(() => preflightAcquiredInventoryBundle(adapter, [{ ...acquired, page: page("<title>Login required</title>") }]));
});

test("browser registrations require inline facts and exact resource requests", () => {
  const rule = { host: "auctions.example.com", path: "/render.js", method: "GET" as const, resourceType: "script" as const };
  const adapter = createHeadlessBrowserSource({ ...options, requests: { allowedBrowserRequests: [rule] } });
  assert.deepEqual(adapter.browser, { readySelector: options.inventorySelector });
  assert.deepEqual(adapter.manifest.requests.allowedBrowserRequests, [rule]);
  assert.equal(Object.isFrozen(adapter.manifest.requests.allowedBrowserRequests![0]), true);
  assert.throws(() => createHeadlessBrowserSource({ ...options, inlineDetails: false }), /complete inline/);
  assert.throws(() => createHeadlessBrowserSource({ ...options, browser: { readySelector: " " } }), /readiness selector/);
  for (const path of ["/scripts/*", "/render.js#fragment", "/scripts/../render.js"]) {
    assert.throws(() => createHeadlessBrowserSource({ ...options, requests: { allowedBrowserRequests: [{ ...rule, path }] } }));
  }
});
