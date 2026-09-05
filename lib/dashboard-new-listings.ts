export type NewListingSnapshotPolicy = "replace" | "append" | "preserve";

/**
 * Selects first-seen rows that still have current-inventory evidence. A fully
 * published source is represented by source_current_listings; an interrupted
 * source keeps its per-run observation until discovery finalization. Rows
 * whose observation was discarded after exact ended proof match neither arm.
 */
export const CURRENT_NEW_LISTINGS_FOR_RUN_SELECT_SQL = `
  SELECT stub.id, stub.first_seen_run_id, stub.discovered_at
  FROM listing_stubs stub
  WHERE stub.first_seen_run_id = ?
    AND (
      EXISTS (
        SELECT 1
        FROM source_current_listings current_inventory
        WHERE current_inventory.listing_id = stub.id
      )
      OR EXISTS (
        SELECT 1
        FROM source_inventory_observations inventory
        WHERE inventory.run_id = ?
          AND inventory.listing_id = stub.id
      )
    )
`;

/**
 * Full discovery is the operator's explicit snapshot boundary. Bounded
 * source-onboarding and interrupted runs may contribute rows they actually
 * persisted, but no run other than a completed full discovery may erase the
 * cohort awaiting review.
 */
export function newListingSnapshotPolicy(input: {
  sourceSpecific: boolean;
  inventoryComplete: boolean;
}): NewListingSnapshotPolicy {
  if (!input.inventoryComplete) return "append";
  return input.sourceSpecific ? "append" : "replace";
}
