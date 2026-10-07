import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { adapter as example } from "../../examples/source-repair/adapter.ts";
import { captureSourceParserEvidence } from "../../lib/source-repair/evidence.ts";
import { replayFailureMatches, replaySourceParserEvidence } from "../../lib/source-repair/replay.ts";
import type { SourceAdapter, SourceDiscoveredListing } from "../../lib/sources/types.ts";

const ID = "11111111-1111-4111-8111-111111111111";
async function packet(operation: "plan_inventory" | "validate_page" | "parse_page" = "parse_page", bounded = false, body?: string) {
  const capture = await captureSourceParserEvidence({ sourceId: "example_json", sourceRunId: ID, observedAt: "2026-01-01T00:00:00.000Z", operation,
    diagnostic: { errorCode: "SourceAdapterError", message: "Example listing description must be a string." },
    page: { url: "https://example.invalid/inventory.json", body: body ?? await readFile(new URL("../../examples/source-repair/failing-page.json", import.meta.url), "utf8"), fetchedAt: "2026-01-01T00:00:00.000Z", contentType: "application/json" },
    ...(bounded ? { expectedListings: 2, plannedPage: { key: "captured-independent-page", request: { kind: "discovery", url: "https://example.invalid/inventory.json" }, minimumListings: 2, maximumListings: 2, expectedCollectionListings: 2, inventoryMember: true, reviewCandidate: true } } : {}) });
  if (!capture.available) throw Error(capture.reason); assert.equal(capture.available, true); return capture.packet;
}
const rows = (): SourceDiscoveredListing[] => ["item-1", "item-2"].map((id) => ({ stub: { sourceId: "example_json", sourceListingId: id, sourceUrl: `https://example.invalid/items/${id}`, title: "Synthetic listing", category: null, lotNumber: null, visibleLocation: null, thumbnailUrl: null, discoveredAt: "2026-01-01T00:00:00.000Z", contentHash: id } }));
const fake = (changes: Partial<SourceAdapter> = {}): SourceAdapter => ({ ...example, parseDiscoveryBatch: rows, ...changes });

test("generic plan-only error replays the exact wrapped operation without inferring counts", async () => {
  const evidence = await packet("plan_inventory"); const result = await replaySourceParserEvidence(example, evidence);
  assert.equal(result.failedOperation, "plan_inventory"); assert.equal(result.countContext, "limited"); assert.equal(replayFailureMatches(result, evidence), true);
});

test("absence of operation means legacy parse_page and matches its exact error", async () => {
  const evidence = await packet(); delete evidence.replay.operation;
  const result = await replaySourceParserEvidence(example, evidence); assert.equal(result.operation, "parse_page"); assert.equal(replayFailureMatches(result, evidence), true);
});

for (const empty of [undefined, null]) {
  test(`nullish batch result ${String(empty)} falls back inside the exact parser wrapper`, async () => {
    const evidence = await packet(); const order: string[] = [];
    const parseDiscoveryBatch = (() => { order.push("batch"); return empty; }) as unknown as SourceAdapter["parseDiscoveryBatch"];
    const result = await replaySourceParserEvidence(fake({ parseDiscoveryBatch,
      parseDiscoveryPage: () => { order.push("fallback"); throw new TypeError(evidence.diagnostic.message); } }), evidence);
    assert.deepEqual(order, ["batch", "fallback"]); assert.equal(result.failedOperation, "parse_page");
    assert.equal(replayFailureMatches(result, evidence), true);
  });
}

test("a later parser error cannot masquerade as the captured planning error", async () => {
  const evidence = await packet("plan_inventory"); const result = await replaySourceParserEvidence(fake({ planInventoryTraversal: () => null, parseDiscoveryBatch: () => { throw new TypeError(evidence.diagnostic.message); } }), evidence);
  assert.equal(result.failedOperation, "parse_page"); assert.equal(replayFailureMatches(result, evidence), false);
});

test("validation replay invokes only the captured validator before parsing", async () => {
  const evidence = await packet("validate_page", true); const order: string[] = [];
  const result = await replaySourceParserEvidence(fake({ validateInventoryTraversalPage: () => { order.push("validate"); throw new TypeError(evidence.diagnostic.message); }, parseDiscoveryBatch: () => { order.push("parse"); return rows(); } }), evidence);
  assert.deepEqual(order, ["validate"]); assert.equal(result.failedOperation, "validate_page"); assert.equal(replayFailureMatches(result, evidence), true);
});

test("captured independent bounds admit a nonempty exact page without future-page claims", async () => {
  const evidence = await packet("parse_page", true); const result = await replaySourceParserEvidence(fake(), evidence);
  assert.equal(result.outcome, "parsed"); assert.equal(result.listingCount, 2); assert.equal(result.countContext, "bounded");
});

test("candidate-derived planning cannot strengthen an unbounded captured case", async () => {
  const evidence = await packet("plan_inventory"); let planned = 0;
  const result = await replaySourceParserEvidence(fake({ planInventoryTraversal: () => { planned++; return { fingerprint: "synthetic", expectedListings: 2, pages: [] }; } }), evidence);
  assert.equal(planned, 1); assert.equal(result.outcome, "parsed"); assert.equal(result.countContext, "limited");
});

for (const [name, output, reason] of [["dropped listing", () => rows().slice(0, 1), "replay_page_cardinality_mismatch"], ["duplicate identity", () => [rows()[0]!, rows()[0]!], "replay_duplicate_listing_identity"], ["foreign source", () => rows().map((row) => ({ stub: { ...row.stub, sourceId: "foreign" } })), "replay_source_identity_mismatch"]] as const) {
  test(`replay rejects ${name}`, async () => { const evidence = await packet("parse_page", true); const result = await replaySourceParserEvidence(fake({ parseDiscoveryBatch: output }), evidence); assert.equal(result.error?.message, reason); assert.equal(replayFailureMatches(result, evidence), false); });
}

test("an unproved empty page is never treated as a successful repair", async () => {
  const evidence = await packet(); const result = await replaySourceParserEvidence(fake({ parseDiscoveryBatch: () => [] }), evidence);
  assert.equal(result.error?.message, "replay_empty_output_unproved");
});

test("missing operation implementation and malformed packet fail closed", async () => {
  const evidence = await packet("validate_page", true); const result = await replaySourceParserEvidence(fake({ validateInventoryTraversalPage: undefined }), evidence);
  assert.equal(result.reason, "replay_operation_unavailable");
  const invalid = structuredClone(evidence); invalid.sanitizedBodyHash = "0".repeat(64);
  assert.equal((await replaySourceParserEvidence(fake(), invalid)).reason, "replay_packet_invalid");
});
