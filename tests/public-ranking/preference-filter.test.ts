import assert from "node:assert/strict";
import test from "node:test";
import { compileReviewPreferenceFilter, reviewPreferenceVisibilityDecision } from "../../lib/ranking/review-prefilter.ts";

test("negative filtering uses exact current-user concepts without parent or family propagation", () => {
  const filter = compileReviewPreferenceFilter({ profileVersionId: "user-profile", positiveConcepts: [], negativeConcepts: [{ name: "bench vise", support: 10 }] });
  assert.equal(filter.decide({ assetClasses: ["vise", "bench vise"], exploration: false }), null);
  assert.equal(filter.decide({ assetClasses: ["bench vise accessory"], exploration: false }), null);
  assert.deepEqual(filter.decide({ assetClasses: ["bench vise"], exploration: false })?.matchedConcepts, ["bench vise"]);
  assert.equal(filter.decide({ assetClasses: ["bench vise"], exploration: true }), null);
  const positive = compileReviewPreferenceFilter({ profileVersionId: "user-profile", positiveConcepts: [{ name: "bench vise", support: 1 }], negativeConcepts: [{ name: "bench vise", support: 20 }] });
  assert.equal(positive.decide({ assetClasses: ["bench vise"], exploration: false }), null);
});

test("unrated, cold-start, and voted listings remain visible without evaluating classes", () => {
  const filter = compileReviewPreferenceFilter({ profileVersionId: "user-profile", positiveConcepts: [], negativeConcepts: [{ name: "bench vise", support: 10 }] });
  const candidate = { vote: null, recommendationProfileVersionId: "user-profile", recommendationExplanation: "fixture", recommendationScore: null, exploration: false, assetClasses() { throw new Error("unexpected extraction"); } };
  assert.equal(reviewPreferenceVisibilityDecision(filter, "user-profile", candidate), null);
  assert.equal(reviewPreferenceVisibilityDecision(filter, null, { ...candidate, recommendationScore: 5 }), null);
  assert.equal(reviewPreferenceVisibilityDecision(filter, "user-profile", { ...candidate, recommendationScore: 5, vote: "interested" }), null);
  assert.equal(compileReviewPreferenceFilter({ profileVersionId: null, positiveConcepts: [], negativeConcepts: [] }).decide({ assetClasses: ["bench vise"], exploration: false }), null);
});
