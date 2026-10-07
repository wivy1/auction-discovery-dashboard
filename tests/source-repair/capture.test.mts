import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { collectGenericInventory } from "../../lib/pipeline/generic-inventory.ts";
import { createSourceParserEvidenceCapture, SOURCE_PARSER_EVIDENCE_PREFIX } from "../../lib/pipeline/source-repair-evidence.ts";
import { invokeSourceParser } from "../../lib/sources/parser-errors.ts";
import {
  SourceAccessChallengeError, SourceAdapterError, SourceRetryableDiscoveryPageError,
  type SourceAdapter, type SourcePage, type SourceInventoryPageRequest,
} from "../../lib/sources/types.ts";
import { SourceRetryableHttpError, type SourceRequestController } from "../../lib/sources/request-control.ts";
import { validateSourceParserEvidencePacket } from "../../lib/source-repair/evidence.ts";

const timestamp = "2026-01-02T03:04:05.000Z";
const page: SourcePage = { url: "https://inventory.fixture.test/current", body: '{"total":1,"items":[{"id":"one","title":"Observed fixture"}]}', fetchedAt: timestamp, contentType: "application/json" };
const planned: SourceInventoryPageRequest = {
  key: "inventory:document", request: { kind: "discovery", url: page.url, headers: { Authorization: "fixture-secret" }, body: "fixture-secret" },
  minimumListings: 1, maximumListings: 1, inventoryMember: true, reviewCandidate: true,
};

function evidenceStorage() {
  const objects = new Map<string, string>();
  const puts: Array<{ key: string; options?: R2PutOptions }> = [];
  const bucket = {
    async head(key: string) { return objects.has(key) ? { key } : null; },
    async list(options: R2ListOptions) {
      const matching = [...objects.keys()].filter((key) => key.startsWith(options.prefix ?? ""));
      return { objects: matching.slice(0, options.limit ?? 1_000).map((key) => ({ key })), truncated: matching.length > (options.limit ?? 1_000) };
    },
    async put(key: string, body: string, options?: R2PutOptions) {
      if (options?.onlyIf && objects.has(key)) return null;
      puts.push({ key, options }); objects.set(key, body); return { key };
    },
  } as unknown as R2Bucket;
  return { objects, puts, bucket };
}
function caught(callback: () => unknown): unknown {
  try { callback(); } catch (error) { return error; }
  assert.fail("Expected a failure");
}
const retention = (bucket: R2Bucket, sourceRunId = "fixture-run") => ({ storage: bucket, sourceRunId, observedAt: timestamp });

test("the pure parser boundary preserves adapter errors and wraps only real Type/Syntax/Range errors", () => {
  const typed = new SourceAdapterError("fixture-json", "existing parser error");
  assert.equal(caught(() => invokeSourceParser("fixture-json", () => { throw typed; })), typed);
  for (const error of [new TypeError("title must be a string"), new SyntaxError("invalid field"), new RangeError("field out of range")]) {
    const wrapped = caught(() => invokeSourceParser("fixture-json", () => { throw error; }));
    assert.ok(wrapped instanceof SourceAdapterError);
    assert.equal(wrapped.message, error.message); assert.equal(wrapped.cause, error);
    assert.equal(error.name, error.constructor.name, "original exception is unchanged");
  }
  const ordinary = new Error("transport failed"); ordinary.name = "TypeError";
  assert.equal(caught(() => invokeSourceParser("fixture-json", () => { throw ordinary; })), ordinary);
});

test("capture binds the exact error and strips transport fields from planned context", async () => {
  const store = evidenceStorage();
  const capture = createSourceParserEvidenceCapture("fixture-json");
  const error = caught(() => capture.run({ page, operation: "validate_page", expectedListings: 1, plannedPage: planned }, () => { throw new SourceAdapterError("fixture-json", "invalid fixture field"); }));
  assert.deepEqual(await capture.retain(error, retention(store.bucket)), { retained: true, key: `${SOURCE_PARSER_EVIDENCE_PREFIX}fixture-run.json` });
  const packet = await validateSourceParserEvidencePacket(JSON.parse([...store.objects.values()][0]!), { sourceId: "fixture-json", sourceRunId: "fixture-run" });
  assert.equal(packet.replay.operation, "validate_page");
  assert.equal(packet.replay.expectedListings, 1);
  assert.deepEqual(packet.replay.plannedPage?.request, { kind: "discovery", url: page.url });
  const metadata = store.puts[0]?.options?.httpMetadata;
  assert.ok(metadata && !(metadata instanceof Headers));
  assert.equal(metadata.contentType, "application/json");
  assert.deepEqual(store.puts[0]?.options?.onlyIf, { etagDoesNotMatch: "*" });
});

test("different errors and later successful callbacks cannot inherit stale pages", async () => {
  const store = evidenceStorage();
  const capture = createSourceParserEvidenceCapture("fixture-json");
  const first = caught(() => capture.run({ page, operation: "parse_page" }, () => { throw new SourceAdapterError("fixture-json", "first"); }));
  assert.deepEqual(await capture.retain(new SourceAdapterError("fixture-json", "first"), retention(store.bucket)), { retained: false, reason: "unsupported_parser_invocation" });
  assert.deepEqual(await capture.retain(first, retention(store.bucket)), { retained: false, reason: "unsupported_parser_invocation" });
  const second = caught(() => capture.run({ page, operation: "parse_page" }, () => { throw new SourceAdapterError("fixture-json", "second"); }));
  capture.run({ page, operation: "parse_page" }, () => []);
  assert.deepEqual(await capture.retain(second, retention(store.bucket)), { retained: false, reason: "unsupported_parser_invocation" });
  assert.equal(store.objects.size, 0);
});

test("challenge, pressure, retryable shell, cancellation and unrelated-source errors are excluded", async () => {
  const store = evidenceStorage();
  for (const error of [new SourceAccessChallengeError("fixture-json", "challenge", 403), new SourceRetryableHttpError("fixture-json", 503, 10_000),
    new SourceRetryableDiscoveryPageError("fixture-json", "temporary shell"), new DOMException("cancelled", "AbortError"), new SourceAdapterError("a", "other source")]) {
    const capture = createSourceParserEvidenceCapture("fixture-json");
    assert.equal(caught(() => capture.run({ page, operation: "parse_page" }, () => { throw error; })), error);
    assert.deepEqual(await capture.retain(error, retention(store.bucket)), { retained: false, reason: "unsupported_parser_invocation" });
  }
  assert.equal(store.objects.size, 0);
});

test("evidence is optional, bounded to 64 packets, and never overwrites an existing packet", async () => {
  for (const kind of ["full", "exists", "throws", "missing"] as const) {
    const store = evidenceStorage();
    if (kind === "full") for (let index = 0; index < 64; index++) store.objects.set(`${SOURCE_PARSER_EVIDENCE_PREFIX}old-${index}.json`, "existing");
    if (kind === "exists") store.objects.set(`${SOURCE_PARSER_EVIDENCE_PREFIX}fixture-run.json`, "existing");
    if (kind === "throws") store.bucket.head = async () => { throw new Error("fixture storage unavailable"); };
    const capture = createSourceParserEvidenceCapture("fixture-json");
    const error = caught(() => capture.run({ page, operation: "parse_page" }, () => { throw new SourceAdapterError("fixture-json", "invalid field"); }));
    const retained = await capture.retain(error, { ...retention(store.bucket), storage: kind === "missing" ? undefined : store.bucket });
    assert.equal(retained.retained, false);
    assert.equal(store.puts.length, 0);
    if (kind === "exists") assert.equal(store.objects.values().next().value, "existing");
  }
  for (const invalid of [{ ...page, contentType: "text/html", body: "<main>invalid</main>" }, { ...page, url: `${page.url}?secret=private` }, { ...page, body: "x".repeat(8 * 1_024 * 1_024 + 1) }]) {
    const store = evidenceStorage(); const capture = createSourceParserEvidenceCapture("fixture-json");
    const error = caught(() => capture.run({ page: invalid, operation: "parse_page" }, () => { throw new SourceAdapterError("fixture-json", "invalid field"); }));
    assert.equal((await capture.retain(error, retention(store.bucket))).retained, false);
    assert.equal(store.puts.length, 0);
  }
});

process.env.ORIGIN_POSTAL_CODE = "90210";
process.env.ORIGIN_COUNTRY = "US";
delete process.env.PIPELINE_PRESERVE_UNOBSERVED_CURRENT_LISTINGS;
const bindings: { DB?: D1Database; STORAGE?: R2Bucket } = {};
Object.assign(globalThis, { __publicParserCaptureTestEnv: bindings });
const jsonModule = new URL("../../lib/sources/json-api.ts", import.meta.url).href;
const fixture = `data:text/javascript,${encodeURIComponent(`
  import { createJsonApiSource } from ${JSON.stringify(jsonModule)};
  const access = { permissionBasis:'recorded_permission', permissionReference:'synthetic-fixture-only', permissionRecordedAt:'2026-01-01T00:00:00Z', reviewedAt:'2026-01-01T00:00:00Z', termsUrl:null, robotsUrl:null, documentationUrls:[], note:'Mocked tests only' };
  function adapter(id, host) { return createJsonApiSource({ id, displayName:id, baseUrl:'https://'+host, inventoryUrl:'https://'+host+'/current', access,
    requests:{minDelayMs:1,maxRequestsPerRun:5,maxResponseBytes:100000,timeoutMs:5000,maxRetries:0}, itemsPath:['items'],totalPath:['total'],inlineDetails:true,
    mapListing(item) { if(typeof item.title !== 'string') throw new TypeError('title must be a string'); return {
      sourceListingId:item.id,sourceUrl:'https://'+host+'/items/'+item.id,title:item.title,currentState:'current',visibleLocation:{postalCode:'90210',countryCode:'US'},
      detail:{rawDescription:'Observed fixture detail',cleanDescription:'Observed fixture detail',priceAtScrape:{amountMinor:100,currency:'USD',displayText:'$1'},auctionEndsAt:'2099-01-01T00:00:00Z',seller:null,pickupLocation:{postalCode:'90210',countryCode:'US'},images:[]}
    }; }
  }); }
  export default [adapter('fixture-json','inventory.fixture.test'),adapter('a','healthy.fixture.test')].map(adapter=>({adapter,enabled:true}));
`)}`;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) {
  if(s === 'cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env = globalThis.__publicParserCaptureTestEnv;'};
  if(/source-adapters\\.local(?:\\.ts)?$/.test(s)) return {shortCircuit:true,url:${JSON.stringify(fixture)}};
  return n(s,c);
}`)}`, import.meta.url);
const { runAuctionDiscovery } = await import("../../lib/pipeline/discovery.ts");
const { ensureDatabase } = await import("../../db/bootstrap.ts");
const { readSourceInventoryPublicationHead } = await import("../../lib/pipeline/storage.ts");
const { sourceRegistry } = await import("../../lib/sources/registry.ts");

class Statement {
  values: SQLInputValue[] = [];
  constructor(readonly db: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  execute() {
    const query = this.db.prepare(this.sql);
    return query.columns().length > 0 ? { success: true, results: query.all(...this.values), meta: {} }
      : { success: true, results: [], meta: { changes: Number(query.run(...this.values).changes) } };
  }
  async run() { return this.execute(); }
  async first(column?: string) { const row = this.db.prepare(this.sql).get(...this.values); return row ? column ? row[column] : row : null; }
  async all() { return this.execute(); }
}
async function database() {
  const db = new DatabaseSync(":memory:"); db.exec("PRAGMA foreign_keys=ON");
  const binding = { prepare(sql: string) { return new Statement(db, sql); }, async batch(statements: Statement[]) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = statements.map((statement) => statement.execute()); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } } as unknown as D1Database;
  const store = evidenceStorage(); bindings.DB = binding; bindings.STORAGE = store.bucket;
  await ensureDatabase(binding);
  return { db, ...store };
}
const originalFetch = globalThis.fetch;
function clean(db: DatabaseSync) { globalThis.fetch = originalFetch; assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []); db.close(); }
function current(db: DatabaseSync, sourceId: string) { return db.prepare("SELECT listing_id FROM source_current_listings WHERE source_id=? ORDER BY listing_id").all(sourceId); }
function controller(): SourceRequestController {
  let requests = 0;
  return { get requestCount() { return requests; }, hasRequestCapacity: () => true, async fetchPage() { requests++; return page; },
    async fetchApprovedImage() { throw new Error("No image requests in fixture"); } };
}

test("generic inventory records the exact planning, validation and parser entrypoint", async () => {
  const base = sourceRegistry.get("fixture-json")!;
  for (const operation of ["plan_inventory", "validate_page", "parse_page"] as const) {
    const failure = new TypeError(`${operation} fixture failure`);
    const adapter: SourceAdapter = { ...base,
      ...(operation === "plan_inventory" ? { planInventoryTraversal: () => { throw failure; } } : {}),
      ...(operation === "validate_page" ? { validateInventoryTraversalPage: () => { throw failure; } } : {}),
      ...(operation === "parse_page" ? { parseDiscoveryBatch: () => { throw failure; } } : {}),
    };
    const capture = createSourceParserEvidenceCapture("fixture-json"); const store = evidenceStorage(); const requests = controller();
    let caughtError: unknown;
    try { await collectGenericInventory(adapter, requests, {}, async () => {}, capture); } catch (error) { caughtError = error; }
    assert.ok(caughtError instanceof SourceAdapterError); assert.equal(caughtError.message, failure.message);
    assert.equal(requests.requestCount, 1);
    assert.equal((await capture.retain(caughtError, retention(store.bucket))).retained, true);
    const packet = JSON.parse([...store.objects.values()][0]!);
    assert.equal(packet.replay.operation, operation);
    assert.equal(packet.replay.expectedListings, operation === "plan_inventory" ? undefined : 1);
  }
});

test("bundle failures and complete-inventory checks have no fabricated page association", async () => {
  const base = sourceRegistry.get("fixture-json")!;
  for (const adapter of [
    { ...base, planInventoryTraversalBundle: () => { throw new TypeError("bundle fixture failure"); } },
    { ...base, validateInventoryTraversalBundle: () => { throw new SourceAdapterError("fixture-json", "bundle mismatch"); } },
    { ...base, planInventoryTraversal: (value: SourcePage) => { const plan = base.planInventoryTraversal!(value)!; return { ...plan, expectedListings: 2 }; }, validateInventoryTraversalPage: () => {} },
  ] satisfies SourceAdapter[]) {
    const capture = createSourceParserEvidenceCapture("fixture-json"); const store = evidenceStorage();
    let error: unknown;
    try { await collectGenericInventory(adapter, controller(), {}, async () => {}, capture); } catch (failure) { error = failure; }
    assert.ok(error instanceof SourceAdapterError);
    assert.deepEqual(await capture.retain(error, retention(store.bucket)), { retained: false, reason: "unsupported_parser_invocation" });
  }
});

test("actual registered JSON failure retains the prior head and immutable details with one request and no pressure misclassification", async () => {
  const { db, objects } = await database(); let malformed = false; let calls = 0;
  globalThis.fetch = async (input) => { calls++; assert.equal(String(input), page.url); return Response.json({ total: 1, items: [{ id: "one", title: malformed ? null : "Original fixture" }] }); };
  try {
    const first = await runAuctionDiscovery("manual", { sourceId: "fixture-json", catalogOnly: true });
    assert.equal(first.status, "completed", JSON.stringify(first)); assert.equal(objects.size, 0);
    const head = await readSourceInventoryPublicationHead("fixture-json"); const membership = current(db, "fixture-json");
    const details = db.prepare("SELECT * FROM listing_details").all(); malformed = true;
    const failed = await runAuctionDiscovery("manual", { sourceId: "fixture-json", catalogOnly: true });
    assert.equal(failed.status, "partial"); assert.deepEqual(failed.publishedSourceIds, []); assert.equal(failed.discovered, 0);
    assert.deepEqual(failed.sourceErrors, [{ sourceId: "fixture-json", message: "title must be a string" }]);
    assert.equal(calls, 2, "one inventory request per run, no evidence refetch");
    assert.deepEqual(current(db, "fixture-json"), membership); assert.deepEqual(await readSourceInventoryPublicationHead("fixture-json"), head);
    assert.deepEqual(db.prepare("SELECT * FROM listing_details").all(), details);
    const sourceRun = db.prepare("SELECT id,status,error_code,error_message FROM source_runs WHERE discovery_run_id=? AND source_id=?").get(failed.runId, "fixture-json")!;
    assert.equal(sourceRun.status, "failed"); assert.equal(sourceRun.error_code, "SourceAdapterError");
    assert.equal(db.prepare("SELECT state,reason_code FROM source_access_state WHERE source_id=?").get("fixture-json")?.state, "ready");
    assert.equal(objects.size, 1); const key = `${SOURCE_PARSER_EVIDENCE_PREFIX}${sourceRun.id}.json`;
    const packet = await validateSourceParserEvidencePacket(JSON.parse(objects.get(key)!), { sourceId: "fixture-json", sourceRunId: sourceRun.id as string });
    assert.equal(packet.replay.operation, "plan_inventory"); assert.equal(packet.replay.expectedListings, undefined);
    malformed = false; const recovered = await runAuctionDiscovery("manual", { sourceId: "fixture-json", catalogOnly: true });
    assert.equal(recovered.status, "completed"); assert.equal(recovered.detailsFetched, 0); assert.equal(calls, 3);
    assert.equal(objects.size, 1, "successful discovery creates no repair evidence");
  } finally { clean(db); }
});

test("actual campaign continues an independent source after a pure-parser failure", async () => {
  const { db, objects } = await database(); const calls: string[] = [];
  globalThis.fetch = async (input) => { const url = String(input); calls.push(url); assert.ok([page.url, "https://healthy.fixture.test/current"].includes(url));
    return Response.json({ total: 1, items: [{ id: "one", title: url === page.url ? null : "Healthy fixture" }] }); };
  try {
    const result = await runAuctionDiscovery("manual");
    assert.equal(result.status, "partial", JSON.stringify(result)); assert.equal(result.sourceErrors.length, 1);
    assert.deepEqual(result.publishedSourceIds, ["a"]); assert.equal(calls.length, 2);
    assert.equal(current(db, "fixture-json").length, 0); assert.equal(current(db, "a").length, 1); assert.equal(objects.size, 1);
    assert.deepEqual(db.prepare("SELECT source_id,status FROM source_runs WHERE discovery_run_id=? ORDER BY source_id").all(result.runId).map((row) => ({ ...row })), [
      { source_id: "a", status: "completed" }, { source_id: "fixture-json", status: "failed" },
    ]);
  } finally { clean(db); }
});

test("actual challenge, Retry-After pressure and transport failures keep access stops without evidence", async () => {
  for (const kind of ["challenge", "pressure", "transport"] as const) {
    const { db, objects } = await database(); let calls = 0;
    globalThis.fetch = async () => { calls++; if (kind === "transport") throw new TypeError("fixture network failure");
      return new Response("", { status: kind === "challenge" ? 403 : 503, headers: kind === "pressure" ? { "retry-after": "120" } : {} }); };
    try {
      const before = Date.now(); const result = await runAuctionDiscovery("manual", { sourceId: "fixture-json", catalogOnly: true });
      assert.equal(result.status, "partial"); assert.equal(calls, 1); assert.equal(objects.size, 0); assert.deepEqual(result.publishedSourceIds, []);
      const access = db.prepare("SELECT state,reason_code,next_eligible_at FROM source_access_state WHERE source_id=?").get("fixture-json")!;
      assert.equal(access.state, "cooldown"); assert.equal(access.reason_code, kind === "challenge" ? "challenge" : "source_pressure");
      if (kind === "pressure") assert.ok(Date.parse(access.next_eligible_at as string) >= before + 120_000);
    } finally { clean(db); }
  }
});

test("actual storage failure during optional capture leaves the same source failure and prior head", async () => {
  const { db, bucket } = await database(); let malformed = false; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ total: 1, items: [{ id: "one", title: malformed ? null : "Original fixture" }] }); };
  try {
    await runAuctionDiscovery("manual", { sourceId: "fixture-json", catalogOnly: true });
    const head = await readSourceInventoryPublicationHead("fixture-json"); const membership = current(db, "fixture-json"); malformed = true;
    bucket.put = async () => { throw new Error("fixture evidence storage unavailable"); };
    const result = await runAuctionDiscovery("manual", { sourceId: "fixture-json", catalogOnly: true });
    assert.equal(result.status, "partial"); assert.deepEqual(result.sourceErrors, [{ sourceId: "fixture-json", message: "title must be a string" }]);
    assert.deepEqual(await readSourceInventoryPublicationHead("fixture-json"), head); assert.deepEqual(current(db, "fixture-json"), membership); assert.equal(calls, 2);
  } finally { clean(db); }
});
