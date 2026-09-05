import type { SourceAdapter, SourceDiscoveredListing, SourceDiscoveryContext, SourcePage, SourceRequestController } from "../sources";
import { SourceAdapterError } from "../sources/types";

/** Parse and validate the complete bounded inventory before publishing any membership. */
export async function collectGenericInventory(
  adapter: SourceAdapter,
  controller: SourceRequestController,
  context: SourceDiscoveryContext,
  checkpoint: () => Promise<void>,
): Promise<readonly SourceDiscoveredListing[]> {
  const requests = adapter.planDiscovery(context);
  if (requests.length === 0) throw new SourceAdapterError(adapter.manifest.id, "The inventory plan has no authoritative document");
  const roots: SourcePage[] = [];
  for (const request of requests) {
    await checkpoint();
    roots.push(await controller.fetchPage(request));
  }
  const traversal = adapter.planInventoryTraversalBundle?.(roots) ??
    (roots.length === 1 ? adapter.planInventoryTraversal?.(roots[0]!) : null);
  const pages: SourcePage[] = [];
  const listings: SourceDiscoveredListing[] = [];
  const append = (page: SourcePage, planned?: NonNullable<typeof traversal>["pages"][number]) => {
    const rows = adapter.parseDiscoveryBatch?.(page, planned) ??
      adapter.parseDiscoveryPage(page).map((stub) => ({ stub }));
    if (planned && (rows.length < planned.minimumListings || rows.length > planned.maximumListings)) {
      throw new SourceAdapterError(adapter.manifest.id, "Inventory page count differs from its declared bounds");
    }
    if (!planned || planned.inventoryMember) listings.push(...rows);
    pages.push(page);
  };
  if (traversal) {
    if (traversal.pages.length === 0) throw new SourceAdapterError(adapter.manifest.id, "A traversal needs an explicit inventory document, including for zero rows");
    for (const planned of traversal.pages) {
      await checkpoint();
      const rootIndex = requests.findIndex((request) => JSON.stringify(request) === JSON.stringify(planned.request));
      const page = rootIndex >= 0 && !planned.revalidateAfterTraversal
        ? roots[rootIndex]!
        : await controller.fetchPage(planned.request);
      if (adapter.validateInventoryTraversalPage?.(page, traversal.expectedListings, planned) === "replan_required") {
        throw new SourceAdapterError(adapter.manifest.id, "Inventory changed during acquisition; the prior publication is retained");
      }
      append(page, planned);
    }
    adapter.validateInventoryTraversalBundle?.(pages, traversal);
  } else {
    for (const page of roots) append(page);
  }
  const unique = new Map<string, SourceDiscoveredListing>();
  for (const listing of listings) {
    if (listing.stub.sourceId !== adapter.manifest.id ||
      (listing.detail && (listing.detail.sourceId !== listing.stub.sourceId ||
        listing.detail.sourceListingId !== listing.stub.sourceListingId ||
        listing.detail.sourceUrl !== listing.stub.sourceUrl))) {
      throw new SourceAdapterError(adapter.manifest.id, "Inventory contains a mismatched source identity");
    }
    const prior = unique.get(listing.stub.sourceListingId);
    if (prior && (prior.stub.contentHash !== listing.stub.contentHash ||
      prior.detail?.contentHash !== listing.detail?.contentHash || prior.currentState !== listing.currentState)) {
      throw new SourceAdapterError(adapter.manifest.id, "Inventory repeats an identity with conflicting source facts");
    }
    unique.set(listing.stub.sourceListingId, listing);
  }
  if (traversal && (traversal.inventoryCardinality ?? "exact") === "exact" && unique.size !== traversal.expectedListings) {
    throw new SourceAdapterError(adapter.manifest.id, "The complete inventory count differs from its declared total");
  }
  controller.assertComplete?.();
  return [...unique.values()];
}
