import { createJsonApiSource } from "../../lib/sources/json-api.ts";
import { createHeadlessBrowserSource, createHtmlSource, type SourceHtmlElement } from "../../lib/sources/html.ts";
import type { GenericListingFacts } from "../../lib/sources/generic.ts";
import type { SourceRegistration } from "../../lib/sources/registration.ts";
import type { SourceAdapter, SourceInventoryTraversalPlan, SourcePage } from "../../lib/sources/types.ts";
import { stableContentHash } from "../../lib/sources/parsing.ts";
import { createHash } from "node:crypto";

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
const leadBase = createHtmlSource({
  id: "fixture_event_lead", displayName: "Fixture event lead", baseUrl: "https://events.fixture.test", inventoryUrl: "https://events.fixture.test/current",
  access, requests, inlineDetails: true, inventorySelector: "main", listingSelector: "article", emptySelector: "[data-empty]",
  mapListing: (element) => mapHtml(element, "events.fixture.test"),
});
const leadRoots = new WeakMap<SourceInventoryTraversalPlan, SourcePage>();
const lead: SourceAdapter = {
  ...leadBase,
  planInventoryTraversal(root) {
    const data = JSON.parse(root.body) as { eventId: string; eventIds?: string[]; address?: unknown; renderedAddress?: string; evidenceKind?: string };
    const shared = data.evidenceKind === "shared" && JSON.stringify(data.eventIds) === JSON.stringify(["event-left", "event-right"]);
    if (!(data.eventId === "event-a" && data.address === null && data.renderedAddress) &&
      !(data.eventId === "event-opaque" && data.evidenceKind === "outbound") && !shared) throw new Error("Unrecognized event lead root");
    const eventIds = shared ? data.eventIds! : [data.eventId];
    const plan: SourceInventoryTraversalPlan = {
      fingerprint: stableContentHash(root.body), expectedListings: 0,
      pages: eventIds.map(eventId => ({ key: `event:${eventId}`, request: { kind: "discovery", url: `https://events.fixture.test/events/${eventId}` },
        minimumListings: 0, maximumListings: 0, inventoryMember: false, reviewCandidate: false })),
    };
    leadRoots.set(plan, root);
    return plan;
  },
  parseDiscoveryBatch(page) {
    const data = JSON.parse(page.body) as { eventId: string; address?: unknown; actionHref?: string };
    if (!(data.eventId === "event-a" && data.address === null) &&
      !(["event-opaque", "event-left", "event-right"].includes(data.eventId) && typeof data.actionHref === "string")) throw new Error("Event lead facts disagree");
    return [];
  },
  validateInventoryTraversalPage(page, expectedListings, planned) {
    if (expectedListings !== 0 || planned?.request.url !== page.url) throw new Error("Event lead page identity disagrees");
  },
  collectPublisherEventLeadEvidence(pages, plan) {
    const root = leadRoots.get(plan)!;
    const event = pages[0]!;
    const data = JSON.parse(root.body) as { eventId: string; eventIds?: string[]; renderedAddress: string; evidenceKind?: string };
    if (data.evidenceKind === "shared") {
      const facts = pages.map((page, index) => {
        const eventData = JSON.parse(page.body) as { eventId: string; actionHref: string };
        const target = new URL(eventData.actionHref);
        if (eventData.eventId !== data.eventIds?.[index] || target.protocol !== "https:" || target.hostname === "events.fixture.test" ||
          target.search !== "" || target.hash !== "" || target.username !== "" || target.password !== "" || target.port !== "") throw new Error("Shared event action shape disagrees");
        return { page, eventId: eventData.eventId, targetHash: `sha256:${createHash("sha256").update(target.href).digest("hex")}` };
      });
      if (facts.length !== 2 || facts[0]!.targetHash !== facts[1]!.targetHash) throw new Error("Shared event target differs");
      return facts.map((fact, index) => {
        const peer = facts[1 - index]!;
        return { pageKey: `event:${fact.eventId}`, evidence: {
          kind: "shared_outbound_v1", publisherHost: "events.fixture.test", eventId: fact.eventId,
          canonicalUrl: fact.page.url, outboundStatus: "unresolved",
          root: { url: root.url, bodyHash: stableContentHash(root.body), fetchedAt: root.fetchedAt },
          event: { bodyHash: stableContentHash(fact.page.body), fetchedAt: fact.page.fetchedAt, outboundTargetHash: fact.targetHash },
          peer: { eventId: peer.eventId, canonicalUrlHash: `sha256:${createHash("sha256").update(peer.page.url).digest("hex")}` },
        } };
      });
    }
    if (data.evidenceKind === "outbound") {
      const eventData = JSON.parse(event.body) as { eventId: string; actionHref: string };
      const href = eventData.actionHref;
      const target = new URL(href);
      if (eventData.eventId !== data.eventId || target.protocol !== "https:" || target.hostname === "events.fixture.test" ||
        target.search === "" || target.hash === "" || target.username !== "" || target.password !== "" || target.port !== "" ||
        [...target.searchParams.keys()].some(key => /token|signature|credential|password|key/iu.test(key))) throw new Error("Opaque event action shape disagrees");
      return [{ pageKey: `event:${data.eventId}`, evidence: {
        kind: "unresolved_outbound_v1", publisherHost: "events.fixture.test", eventId: data.eventId,
        canonicalUrl: event.url, outboundStatus: "unresolved",
        root: { url: root.url, bodyHash: stableContentHash(root.body), fetchedAt: root.fetchedAt },
        event: { bodyHash: stableContentHash(event.body), fetchedAt: event.fetchedAt, outbound: {
          hrefHash: `sha256:${createHash("sha256").update(href).digest("hex")}`,
          https: true, externalToPublisher: true, queryPresent: true, fragmentPresent: true,
          credentialsPresent: false, portPresent: false, signedQueryKeyPresent: false,
        } },
      } }];
    }
    return [{ pageKey: "event:event-a", evidence: {
      kind: "unresolved_address_v1", publisherHost: "events.fixture.test", eventId: "event-a",
      canonicalUrl: event.url, addressStatus: "unresolved",
      root: { url: root.url, bodyHash: stableContentHash(root.body), fetchedAt: root.fetchedAt,
        inlineAddress: null, renderedAddressText: data.renderedAddress },
      event: { bodyHash: stableContentHash(event.body), fetchedAt: event.fetchedAt,
        inlineAddress: null, renderedAddressText: null },
    } }];
  },
};
export default [json, html, browser, lead].map((adapter) => ({ adapter, enabled: true })) satisfies readonly SourceRegistration[];
