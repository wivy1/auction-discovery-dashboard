import { createJsonApiSource } from "../../lib/sources/json-api";
import type { GenericListingFacts } from "../../lib/sources/generic";

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`Example listing ${field} must be a string.`);
  return value;
}

function requiredIdentity(value: unknown): string {
  const id = requiredText(value, "id");
  if (!/^item-[1-9][0-9]*$/u.test(id)) throw new TypeError("Example listing id is invalid.");
  return id;
}

function normalizeListing(listing: Readonly<Record<string, unknown>>): GenericListingFacts {
  const id = requiredIdentity(listing.id);
  const title = requiredText(listing.title, "title");
  const state = requiredText(listing.state, "state");
  if (state !== "current") throw new TypeError("Example listing state must be current.");
  const description = requiredText(listing.description, "description");
  return { sourceListingId: id, sourceUrl: `https://example.invalid/items/${id}`, title, currentState: "current",
    detail: { rawDescription: description, cleanDescription: description, priceAtScrape: {}, auctionEndsAt: null, seller: null, images: [] } };
}

// Inert example: copy explicitly into source-adapters.local; never registered here.
export const adapter = createJsonApiSource({
  id: "example_json", displayName: "Synthetic JSON parser example", baseUrl: "https://example.invalid/",
  inventoryUrl: "https://example.invalid/inventory.json", itemsPath: ["items"], totalPath: ["total"],
  maximumListings: 4, inlineDetails: true, mapListing: normalizeListing,
  requests: { allowedHosts: ["example.invalid"], minDelayMs: 1_000, maxRequestsPerRun: 1, timeoutMs: 1_000, maxRetries: 0, maxResponseBytes: 8_192 },
});
