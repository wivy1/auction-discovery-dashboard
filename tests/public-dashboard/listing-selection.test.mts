import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { saveBulkListingEnds, saveBulkNotInterestedVotes, visibleBulkNotInterestedListingIds, type Listing } from "../../app/components/auction-data.ts";
import { isListingEnded } from "../../app/components/auction-display.ts";
import { listingTimeUnavailable, parseBulkListingEndResult } from "../../lib/listing-end-state.ts";

const endedAt = "2026-09-11T12:00:00.000Z";
const endResponse = (ids: string[]) => ({ requestedCount: ids.length, outcomes: ids.map((listingId) => ({ listingId, canonicalListingId: listingId, status: "changed", markedEndedAt: endedAt })) });
const voteResponse = (ids: string[]) => ({ requestedCount: ids.length, changedCanonicalListingIds: ids, outcomes: ids.map((listingId) => ({ listingId, canonicalListingId: listingId, status: "changed", vote: "not_interested" })) });
const clients = [
  { name: "mark ended", save: saveBulkListingEnds, response: endResponse, url: "/api/listings/end-batch" },
  { name: "not interested", save: saveBulkNotInterestedVotes, response: voteResponse, url: "/api/listings/vote-batch" },
];

type BulkSaveResult = Awaited<ReturnType<(typeof clients)[number]["save"]>>;

async function withFetch<T>(handler: typeof fetch, action: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  globalThis.fetch = handler;
  try { return await action(); }
  finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

for (const client of clients) {
  test(`${client.name} freezes and deduplicates 1001 click IDs into sequential bounded requests`, async () => {
    const clicked = Array.from({ length: 1001 }, (_, index) => `fixture:${index}`);
    const expected = [...clicked];
    clicked.push(clicked[0]!);
    const requests: string[][] = [];
    let inFlight = 0;
    const result = await withFetch<BulkSaveResult>(async (url, init) => {
      assert.equal(++inFlight, 1, "batches must never overlap");
      assert.equal(url, client.url);
      assert.equal(init?.method, "PUT");
      const ids = JSON.parse(String(init?.body)).listingIds as string[];
      requests.push(ids);
      if (requests.length === 1) clicked.splice(0, clicked.length, "fixture:changed-after-click");
      await Promise.resolve();
      inFlight--;
      return Response.json(client.response(ids));
    }, () => client.save(clicked));
    assert.equal(result.persisted, true);
    assert.deepEqual(requests.map((ids) => ids.length), [1000, 1]);
    assert.deepEqual(requests.flat(), expected);
    assert.deepEqual(result.response?.outcomes.map((row) => row.listingId), expected);
  });

  test(`${client.name} retains the first completed batch and stops after a later HTTP failure`, async () => {
    const ids = Array.from({ length: 2001 }, (_, index) => `fixture:${index}`);
    let calls = 0;
    const result = await withFetch<BulkSaveResult>(async (_url, init) => {
      const batch = JSON.parse(String(init?.body)).listingIds as string[];
      return ++calls === 1 ? Response.json(client.response(batch)) : Response.json({ error: "fixture write failed" }, { status: 503 });
    }, () => client.save(ids));
    assert.equal(calls, 2, "no third batch may run after failure");
    assert.equal(result.persisted, false);
    assert.match(result.errorMessage ?? "", /fixture write failed/);
    assert.deepEqual(result.response?.outcomes.map((row) => row.listingId), ids.slice(0, 1000));
    assert.equal(result.response?.requestedCount, 1000);
  });

  test(`${client.name} rejects malformed, missing and foreign outcomes without accepting unrelated writes`, async () => {
    for (const payload of [null, { requestedCount: 1, outcomes: [] }, client.response(["fixture:other"]), client.response(["fixture:a", "fixture:a"])]) {
      const result = await withFetch<BulkSaveResult>(async () => Response.json(payload), () => client.save(["fixture:a"]));
      assert.equal(result.persisted, false);
      assert.equal(result.response, null);
    }
    const ids = Array.from({ length: 1001 }, (_, index) => `fixture:${index}`);
    let calls = 0;
    const result = await withFetch<BulkSaveResult>(async (_url, init) => {
      const batch = JSON.parse(String(init?.body)).listingIds as string[];
      return Response.json(client.response(++calls === 1 ? batch : [ids[0]!]));
    }, () => client.save(ids));
    assert.equal(result.persisted, false, "a previous batch's valid outcome cannot satisfy the next request");
    assert.equal(result.response?.outcomes.length, 1000);
    assert.deepEqual(result.response?.outcomes.map((row) => row.listingId), ids.slice(0, 1000));
  });
}

test("end-result parsing enforces exact identities, status fields and canonical timestamps", () => {
  const valid = endResponse(["fixture:a"]);
  assert.deepEqual(parseBulkListingEndResult(valid), valid);
  for (const patch of [
    { listingId: " fixture:a" }, { listingId: "fixture:a\n" }, { canonicalListingId: null },
    { status: "unexpected" }, { markedEndedAt: "2026-09-11" }, { markedEndedAt: null },
    { status: "skipped_has_time" }, { status: "skipped_not_found" }, { extra: true },
  ]) assert.equal(parseBulkListingEndResult({ ...valid, outcomes: [{ ...valid.outcomes[0], ...patch }] }), null);
  for (const status of ["skipped_has_time", "skipped_not_found"]) {
    const outcome = { ...valid.outcomes[0]!, status, canonicalListingId: status === "skipped_not_found" ? null : "fixture:a", markedEndedAt: null };
    assert.ok(parseBulkListingEndResult({ requestedCount: 1, outcomes: [outcome] }));
  }
  assert.equal(parseBulkListingEndResult({ ...valid, extra: true }), null);
  assert.equal(parseBulkListingEndResult({ requestedCount: 1001, outcomes: Array(1001).fill(valid.outcomes[0]) }), null);
});

function listing(id: string, overrides: Record<string, unknown> = {}): Listing {
  return { id, source: "Fixture", sourceFilters: ["Fixture"], vote: null, voteReady: true, closesAt: "", markedEndedAt: null, ...overrides } as unknown as Listing;
}

test("manual ending requires absent closing time and does not treat an auction start as a close", () => {
  assert.equal(listingTimeUnavailable(listing("fixture:a")), true);
  assert.equal(listingTimeUnavailable(listing("fixture:a", { closesAt: "   " })), true);
  for (const fields of [{ closesAt: "2026-09-10" }, { closesAt: "2026-09-10T12:00:00.000Z" }, { closesAt: "invalid source time" }, { closeSupplement: { localDateTime: "2026-09-10T12:00:00" } }]) {
    assert.equal(listingTimeUnavailable(listing("fixture:a", fields)), false);
  }
  const startOnly = listing("fixture:start", { actionDeadline: { at: "2026-09-10T12:00:00.000Z", basis: "live_auction_start", sourceText: "Auction starts", observedAt: endedAt }, voteReady: false, recommendation: null, primaryImageUrl: "" });
  assert.equal(listingTimeUnavailable(startOnly), true, "an auction start must not block explicit manual ending when the closing time is absent");
  assert.equal(isListingEnded(startOnly, Date.parse(endedAt)), false, "an elapsed start does not automatically end a listing");
  assert.equal(isListingEnded({ ...startOnly, markedEndedAt: endedAt }, Date.parse(endedAt)), true);
  const now = Date.parse(endedAt);
  for (const fields of [{}, { closesAt: "2026-09-10" }, { closesAt: "invalid" }, { actionDeadline: { kind: "live_start", value: "2026-09-10" } }, { closesAt: "2026-09-12T00:00:00Z" }]) {
    assert.equal(isListingEnded(listing("fixture:a", fields), now), false);
  }
  assert.equal(isListingEnded(listing("fixture:a", { closesAt: endedAt }), now), true);
  assert.equal(isListingEnded(listing("fixture:a", { closesAt: "2026-09-10T00:00:00Z" }), now), true);
  const manuallyEnded = listing("fixture:a", { markedEndedAt: endedAt });
  assert.equal(isListingEnded(manuallyEnded, now), true);
  assert.equal(manuallyEnded.closesAt, "", "operator state does not invent a source close time");
  assert.equal(manuallyEnded.vote, null, "operator state does not imply a vote");
});

function selectionScript(): string {
  const text = readFileSync(new URL("../../app/components/auction-dashboard.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("auction-dashboard.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["selectionScope", "selectedListings", "selectedIds", "allFilteredSelected", "selectedNotInterestedIds", "selectedEndedIds", "selectListing"]);
  const declarations: string[] = [];
  const handlers = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (ts.isVariableStatement(node)) {
      const declaration = node.declarationList.declarations[0];
      if (declaration && ts.isIdentifier(declaration.name) && names.has(declaration.name.text)) declarations.push(node.getText(source));
    }
    if (ts.isJsxAttribute(node) && node.name.getText(source) === "onClick" && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      const callback = node.initializer.expression.getText(source);
      if (callback.includes("setSelection(") && callback.includes("allFilteredSelected")) handlers.set("selectAll", callback);
      if (callback.includes("bulkNotInterested([...selectedNotInterestedIds])")) handlers.set("voteSelected", callback);
      if (callback.includes("bulkEnded([...selectedEndedIds])")) handlers.set("endSelected", callback);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(declarations.length, names.size, "extract the unique production selection declarations");
  assert.equal(handlers.size, 3, "extract all production selection action handlers");
  return ts.transpileModule(`${declarations.join("\n")}\n({ selectedIds, selectedNotInterestedIds, selectedEndedIds, allFilteredSelected, selectListing, ${[...handlers].map(([name, callback]) => `${name}: ${callback}`).join(",")} })`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}

test("production selection selects all filtered rows beyond 100 cards and actions use checked eligible rows", () => {
  const script = selectionScript();
  let selection = { scope: JSON.stringify({ vote: "all" }), ids: new Set<string>() };
  let filters = { vote: "all" };
  let rows = Array.from({ length: 105 }, (_, index) => listing(`fixture:${index}`));
  rows[1] = listing("fixture:1", { vote: "interested" });
  rows[2] = listing("fixture:2", { voteReady: false });
  rows[3] = listing("fixture:3", { closesAt: "2026-09-12" });
  rows[4] = listing("fixture:4", { markedEndedAt: endedAt });
  const voted: string[][] = [];
  const ended: string[][] = [];
  const render = () => runInNewContext(script, {
    filters, selection, displayedListings: rows, visibleListings: rows.slice(0, 100),
    visibleBulkNotInterestedListingIds, listingTimeUnavailable,
    setSelection(update: typeof selection | ((current: typeof selection) => typeof selection)) { selection = typeof update === "function" ? update(selection) : update; },
    bulkNotInterested(ids: string[]) { voted.push(Array.from(ids)); },
    bulkEnded(ids: string[]) { ended.push(Array.from(ids)); },
  }, { timeout: 1000 });
  let view = render();
  assert.equal(view.selectedIds.size, 0);
  view.selectAll();
  view = render();
  assert.equal(view.selectedIds.size, 105);
  assert.equal(view.allFilteredSelected, true);
  view.voteSelected();
  view.endSelected();
  assert.deepEqual(voted[0], rows.filter((row) => row.vote === null && row.voteReady).map((row) => row.id));
  assert.deepEqual(ended[0], rows.filter((row) => !row.markedEndedAt && !row.closesAt).map((row) => row.id));
  view.selectAll();
  view = render();
  assert.equal(view.selectedIds.size, 0, "second select-all click deselects everything");
  view.selectListing("fixture:104", true);
  view = render();
  view.voteSelected();
  view.endSelected();
  assert.deepEqual(voted[1], ["fixture:104"]);
  assert.deepEqual(ended[1], ["fixture:104"]);
  view.selectListing("fixture:104", false);
  assert.equal(render().selectedIds.size, 0);
  render().selectListing("fixture:0", true);
  rows = rows.slice(1);
  assert.equal(render().selectedIds.size, 0, "removed or hidden rows cannot remain actionable");
  render().selectListing("fixture:104", true);
  assert.equal(render().selectedIds.size, 1);
  filters = { vote: "unvoted" };
  assert.equal(render().selectedIds.size, 0, "filter changes invalidate old selection scope");
  render().selectListing("fixture:104", true);
  view = render();
  assert.deepEqual(Array.from(view.selectedIds), ["fixture:104"], "new scope does not resurrect prior checks");
});
