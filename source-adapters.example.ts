import { createJsonApiSource } from "./lib/sources/json-api";
import { createHeadlessBrowserSource, createHtmlSource, type SourceHtmlElement } from "./lib/sources/html";
import type { GenericListingFacts } from "./lib/sources/generic";
import type { SourceRegistration } from "./lib/sources/registration";

// Setup copies this file to ignored source-adapters.local.ts only if absent.
// The default array is empty: no source requests or sample runtime listings.
// Configure your own authorized endpoint, mapping and access policy before
// adding a registration. Keep credentials in the local file/environment.
const sources: readonly SourceRegistration[] = [];
export default sources;

// These examples describe a single complete document. An API that paginates
// needs a complete bounded traversal in a locally supplied SourceAdapter.
export const jsonApiExample = createJsonApiSource({
  id: "example_json",
  displayName: "Example JSON source",
  baseUrl: "https://api.example.com/",
  inventoryUrl: "https://api.example.com/current",
  itemsPath: ["items"],
  totalPath: ["total"],
  inlineDetails: true,
  requests: { allowedImageHosts: ["images.example.com"] },
  mapListing: (item) => ({
    sourceListingId: sourceText(item.id),
    sourceUrl: sourceText(item.url),
    title: sourceText(item.title),
    currentState: sourceState(item.state),
    detail: {
      rawDescription: sourceText(item.description),
      cleanDescription: sourceText(item.description),
      priceAtScrape: { amountMinor: null, currency: null, displayText: null },
      auctionEndsAt: item.endsAt === null ? null : sourceText(item.endsAt),
      seller: null,
      images: sourceImageUrls(item.images).map((sourceUrl) => ({ sourceUrl })),
    },
  }),
});

const htmlOptions = {
  baseUrl: "https://auctions.example.com/",
  inventoryUrl: "https://auctions.example.com/current",
  inventorySelector: "main[data-current-inventory]",
  listingSelector: "article[data-listing-id]",
  emptySelector: "[data-inventory-empty]",
  inlineDetails: true,
  requests: { allowedImageHosts: ["auctions.example.com"] },
  mapListing: mapHtmlListing,
} as const;

export const htmlExample = createHtmlSource({
  ...htmlOptions,
  id: "example_html",
  displayName: "Example HTML source",
});

export const headlessBrowserExample = createHeadlessBrowserSource({
  ...htmlOptions,
  id: "example_browser",
  displayName: "Example headless browser source",
});

function mapHtmlListing(element: SourceHtmlElement): GenericListingFacts {
  const description = sourceText(element.querySelector("[data-description]")?.textContent);
  const images = [...element.querySelectorAll("img[data-source-image]")].map((image) => ({
    sourceUrl: sourceText(image.getAttribute("src")),
  }));
  if (images.length === 0 && !element.hasAttribute("data-no-images")) {
    throw new TypeError("The source has not established image identities or explicit image absence.");
  }
  return {
    sourceListingId: sourceText(element.getAttribute("data-listing-id")),
    sourceUrl: sourceText(element.querySelector("a[data-canonical]")?.getAttribute("href")),
    title: sourceText(element.querySelector("h2")?.textContent),
    currentState: sourceState(element.getAttribute("data-state")),
    detail: {
      rawDescription: description,
      cleanDescription: description,
      priceAtScrape: { amountMinor: null, currency: null, displayText: null },
      auctionEndsAt: element.getAttribute("data-ends-at"),
      seller: null,
      images,
    },
  };
}

function sourceText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Required source text is missing.");
  return value.trim();
}

function sourceState(value: unknown): "current" | "ended" {
  if (value !== "current" && value !== "ended") throw new TypeError("Unrecognized source listing state.");
  return value;
}

function sourceImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError("The source must provide an explicit image array.");
  return value.map(sourceText);
}
