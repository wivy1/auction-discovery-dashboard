import assert from "node:assert/strict";
import test from "node:test";
import { materializeOperationalProjection } from "../../lib/pipeline/operational-projection.ts";
import { estimateLocalProximity, resolveLocalProximityOrigin, resolveLocalProximityDestination } from "../../lib/routing/local-proximity.ts";
import { locationCacheKey } from "../../lib/routing/helpers.ts";

const aiKeys = ["AI_TEXT_PROVIDER", "AI_TEXT_MODEL", "AI_EMBEDDING_PROVIDER", "AI_EMBEDDING_MODEL"] as const;
const contracts = {
  originPostalCode: "10001",
  generationVectorHash: `sha256:${"1".repeat(64)}`,
  enrichmentTargetIdentity: "enrichment-unconfigured-v1",
  preferenceContractIdentity: "preference-unrated-v1",
  now: new Date("2026-01-01T00:00:00.000Z"),
};

async function fixture(): Promise<Parameters<typeof materializeOperationalProjection>[0]> {
  const destination = resolveLocalProximityDestination({ postalCode: "10001", countryCode: "US" });
  const route = await estimateLocalProximity(resolveLocalProximityOrigin("10001", "US"), destination);
  return {
    listing_id: "sample:1", source_id: "sample", source_listing_id: "1", review_completed: 0,
    stub_content_hash: "fixture-stub", title: "Workbench", category: null,
    visible_city: null, visible_state: null, visible_postal_code: "10001", visible_country_code: "US",
    current_inventory_run_id: "fixture-run", current_review_candidate: 1, active_preference_v2_history: 0,
    source_publication_generation: 1, source_coverage_mode: "complete_current",
    detail_content_hash: "fixture-detail", detail_raw_description: "Workbench", detail_clean_description: "Workbench",
    accepted_detail_hash: "fixture-detail", detail_auction_ends_at: null,
    pickup_city: null, pickup_state: null, pickup_postal_code: "10001", pickup_country_code: "US",
    detail_terminal_identity: null, action_deadline_hash: null,
    route_cache_id: "fixture-route", route_destination_cache_key: route.destinationCacheKey,
    route_origin_cache_key: locationCacheKey({ postalCode: "10001", countryCode: "US" }),
    route_provider_name: "local_proximity", route_input_hash: route.inputHash,
    route_error_code: null, route_drive_bucket: "under_2h",
    recovery_state: null, recovery_stage: null, recovery_error_code: null,
    source_images_json: "[]", primary_image_id: null, primary_download_status: null,
    primary_local_path: null, primary_content_hash: null, image_terminal_absent: 1,
    enrichment_head_identity: null, enrichment_head_input_hash: null, enrichment_head_state: null,
    physical_asset_cluster_id: null, auction_event_block_id: null, semantic_family_id: null,
    score_head_identity: null, score_snapshot_identity: null, score_head_input_hash: null,
  };
}

test("factual cold-start projection settles without model work or fabricated failures", async () => {
  const previous = Object.fromEntries(aiKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of aiKeys) delete process.env[key];
    const row = await fixture();
    const projected = await materializeOperationalProjection(row, contracts);
    assert.deepEqual(projected.state.expectedWorkItems, []);
    assert.equal(projected.ownership.actionableOwnerListingId, row.listing_id);
    assert.equal(projected.ownership.ownerState, "native_primary");
    assert.equal(projected.state.enrichmentHeadIdentity, null);
    assert.equal(projected.state.scoreHeadIdentity, null);
    assert.equal(projected.state.factualSupplementState, "ready");
    const stale = await materializeOperationalProjection({ ...row, route_input_hash: "stale-route" }, contracts);
    assert.deepEqual(stale.state.expectedWorkItems.map(({ stage }) => stage), ["proximity"]);

    for (const key of aiKeys) process.env[key] = key.endsWith("PROVIDER") ? "ollama" : "user-model";
    const enabled = await materializeOperationalProjection(row, contracts);
    assert.deepEqual(enabled.state.expectedWorkItems.map(({ stage }) => stage), ["enrichment_text"]);
    assert.notEqual(enabled.state.relevantGenerationVectorHash, projected.state.relevantGenerationVectorHash);
    const enriched = await materializeOperationalProjection({
      ...row, enrichment_head_identity: "fixture-head",
      enrichment_head_input_hash: enabled.state.enrichmentInputHash, enrichment_head_state: "complete",
    }, contracts);
    assert.deepEqual(enriched.state.expectedWorkItems, []);
    assert.equal(enriched.state.scoreHeadIdentity, null);
  } finally {
    for (const key of aiKeys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
