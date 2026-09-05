import assert from "node:assert/strict";
import test from "node:test";
import { createJsonApiSource } from "../../lib/sources/json-api";
import type { GenericListingFacts } from "../../lib/sources/generic";
import { evaluateSourceAccess } from "../../lib/sources/access";
import type { SourcePage } from "../../lib/sources/types";

const now = "2026-09-05T12:00:00.000Z";
const base = {
  id: "fixture_json",
  displayName: "JSON fixture",
  baseUrl: "https://api.example.com/",
  inventoryUrl: "https://api.example.com/current",
  itemsPath: ["items"],
  totalPath: ["total"],
  inlineDetails: true,
  requests: { allowedImageHosts: ["images.example.com"] },
  mapListing: (row: Readonly<Record<string, unknown>>) => row as unknown as GenericListingFacts,
} as const;
function facts(overrides: Partial<GenericListingFacts> = {}): GenericListingFacts {
  return {
    sourceListingId: "lot-1", sourceUrl: "/lots/lot-1", title: "Oscilloscope",
    currentState: "current", visibleLocation: { city: "Example", countryCode: "US", evidenceSource: "visible_listing" },
    detail: { rawDescription: "Source description", cleanDescription: "Source description", priceAtScrape: { amountMinor: 1250, currency: "USD" },
      auctionEndsAt: "2026-09-06T12:00:00.000Z", seller: null, images: [{ sourceUrl: "https://images.example.com/lot-1.jpg" }] },
    ...overrides,
  };
}
function page(items: readonly GenericListingFacts[], total = items.length): SourcePage {
  return { url: base.inventoryUrl, body: JSON.stringify({ items, total }), fetchedAt: now, contentType: "application/json; charset=utf-8" };
}

test("JSON maps immutable source facts, hashes content independently of observation time, and plans no inline detail request", () => {
  const adapter = createJsonApiSource(base);
  const first = adapter.parseDiscoveryBatch!(page([facts()]))[0]!;
  const second = adapter.parseDiscoveryBatch!({ ...page([facts()]), fetchedAt: "2026-09-05T13:00:00.000Z" })[0]!;
  assert.equal(first.stub.sourceUrl, "https://api.example.com/lots/lot-1");
  assert.equal(first.detail!.priceAtScrape.amountMinor, 1250);
  assert.equal(first.detail!.images[0]!.sourceUrl, "https://images.example.com/lot-1.jpg");
  assert.equal(first.stub.contentHash, second.stub.contentHash);
  assert.equal(first.detail!.contentHash, second.detail!.contentHash);
  assert.notEqual(first.detail!.scrapedAt, second.detail!.scrapedAt);
  assert.equal(adapter.planDetail(first.stub), null);
  assert.equal(evaluateSourceAccess(adapter.manifest, { enabled: true }).allowed, false);
});

test("JSON explicit zero inventory publishes a zero-row plan; missing, malformed and incomplete arrays fail", () => {
  const adapter = createJsonApiSource(base);
  assert.deepEqual(adapter.parseDiscoveryBatch!(page([])), []);
  assert.equal(adapter.planInventoryTraversal!(page([]))!.expectedListings, 0);
  for (const body of ["{", "{}", '{"items":null,"total":0}', '{"items":[],"total":1}', '{"error":"denied"}']) {
    assert.throws(() => adapter.parseDiscoveryBatch!({ ...page([]), body }));
  }
});

test("ended source states and elapsed exact closes stay outside current inventory", () => {
  const adapter = createJsonApiSource(base);
  const ended = facts({ sourceListingId: "ended", sourceUrl: "/lots/ended", currentState: "ended", detail: undefined });
  const elapsed = facts({ sourceListingId: "elapsed", sourceUrl: "/lots/elapsed", detail: { ...facts().detail!, auctionEndsAt: now } });
  const result = adapter.parseDiscoveryBatch!(page([facts(), ended, elapsed]));
  assert.deepEqual(result.map(({ stub }) => stub.sourceListingId), ["lot-1"]);
  assert.throws(() => adapter.parseDiscoveryBatch!(page([facts({ currentState: "unknown" as "current" })])), /current state/);
});

test("duplicate identities, unknown hosts, missing image evidence and invalid locations fail the whole document", () => {
  const adapter = createJsonApiSource(base);
  assert.throws(() => adapter.parseDiscoveryBatch!(page([facts(), facts()])), /repeats/);
  assert.throws(() => adapter.parseDiscoveryBatch!(page([facts({ sourceUrl: "https://unlisted.example.net/lot" })])), /allowed host/);
  assert.throws(() => adapter.parseDiscoveryBatch!(page([facts({ detail: { ...facts().detail!, images: undefined as never } })])), /image array/);
  assert.throws(() => adapter.parseDiscoveryBatch!(page([facts({ visibleLocation: { postalCode: "10001" } })])), /country code/);
  assert.throws(() => adapter.parseDiscoveryBatch!(page([facts({ detail: { ...facts().detail!, images: [{ sourceUrl: "https://unlisted.example.net/image.jpg" }] } })])), /image hosts/);
});

test("JSON enforces the document byte ceiling and record bound before normalization", () => {
  const adapter = createJsonApiSource({ ...base, maximumListings: 1 });
  assert.throws(() => adapter.parseDiscoveryBatch!(page([facts(), facts({ sourceListingId: "second" })])), /ceiling/);
  const bytes = createJsonApiSource({ ...base, requests: { maxResponseBytes: 32 } });
  assert.throws(() => bytes.parseDiscoveryBatch!(page([facts()])), /byte length/);
});

test("separate details are planned and bound to both request URL and catalog identity", () => {
  const adapter = createJsonApiSource({ ...base, inlineDetails: false, detail: { mapListing: base.mapListing } });
  const stub = adapter.parseDiscoveryPage(page([facts({ detail: undefined })]))[0]!;
  const request = adapter.planDetail(stub)!;
  assert.equal(request.url, stub.sourceUrl);
  const detailPage = { ...page([]), url: request.url, body: JSON.stringify(facts()) };
  assert.equal(adapter.parseDetailPage(detailPage, stub).sourceListingId, "lot-1");
  assert.throws(() => adapter.parseDetailPage({ ...detailPage, url: base.inventoryUrl }, stub), /page identity/);
  assert.throws(() => adapter.parseDetailPage({ ...detailPage, body: JSON.stringify(facts({ sourceListingId: "other" })) }, stub), /catalog identity/);
  assert.throws(() => adapter.planDetail({ ...stub, sourceId: "other" }), /another source/);
  assert.equal(adapter.isDetailPageProvablyEnded!({ ...detailPage, body: JSON.stringify(facts({ currentState: "ended", detail: undefined })) }, stub), true);
});

test("runtime extra fields in mapped detail cannot replace normalized identity", () => {
  const adapter = createJsonApiSource(base);
  const detail = { ...facts().detail!, sourceId: "other", sourceUrl: "https://unlisted.example.net/" };
  assert.equal(adapter.parseDiscoveryBatch!(page([facts({ detail })]))[0]!.detail!.sourceId, base.id);
});
