import assert from "node:assert/strict";
import test from "node:test";
import * as readiness from "../../lib/dashboard-route-health.ts";
import type { DashboardReviewInventoryRow } from "../../lib/dashboard-route-health.ts";

test("public readiness exposes no privileged source registry", () => {
  assert.equal("NON_OWNING_PUBLISHER_REVIEW_SOURCE_IDS" in readiness, false);
});

test("reviewed and unreviewed rows both require canonical source readiness", () => {
  for (const vote of [null, "interested", "not_interested"]) {
    const row: DashboardReviewInventoryRow = {
      sourceId: "example_owner", sourceMemberships: ["example_owner", "example_secondary"],
      pickupPostalCode: "90210", pickupCountryCode: "US", driveBucket: "under_2h",
      errorCode: null, coreReady: true, enrichmentReady: false, reviewReady: true, vote,
    };
    assert.equal(readiness.dashboardRowHasReadyPresentationSource(row, new Set(["example_secondary"])), false);
    assert.equal(readiness.dashboardRowHasReadyPresentationSource(row, new Set(["example_owner"])), true);
    assert.equal(readiness.countDashboardReviewListings([row], new Set(["example_owner"])), 0);
    assert.equal(readiness.countDashboardReviewListings([row]), 1);
    assert.equal(readiness.countUnvotedDashboardReviewListings([row]), vote === null ? 1 : 0);
  }
});
