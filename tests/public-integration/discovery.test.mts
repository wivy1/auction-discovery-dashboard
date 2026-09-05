import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { register } from "node:module";
import test from "node:test";
import { chromium } from "playwright";
import { ensureDatabase } from "../../db/bootstrap.ts";

process.env.ORIGIN_POSTAL_CODE = "90210";
process.env.ORIGIN_COUNTRY = "US";
process.env.PIPELINE_MAX_IMAGE_DOWNLOADS_OVERRIDE = "2";
delete process.env.PIPELINE_PRESERVE_UNOBSERVED_CURRENT_LISTINGS;
const bindings: { DB?: D1Database; STORAGE?: R2Bucket } = {};
Object.assign(globalThis, { __publicDiscoveryTestEnv: bindings });
const fixture = new URL("./discovery-adapters.fixture.mts", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) {
  if(s === 'cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env = globalThis.__publicDiscoveryTestEnv;'};
  if(/source-adapters\\.local(?:\\.ts)?$/.test(s)) return {shortCircuit:true,url:${JSON.stringify(fixture)}};
  return n(s,c);
}`)}`, import.meta.url);
const { runAuctionDiscovery } = await import("../../lib/pipeline/discovery.ts");
const { captureGenericSourcePages } = await import("../../scripts/source-browser-acquisition.ts");
const { planGenericSourceAcquisition, validateGenericAcquiredPages } = await import("../../lib/pipeline/source-acquisition.ts");
const storage = await import("../../lib/pipeline/storage.ts");
const { sourceRegistry } = await import("../../lib/sources/registry.ts");

class Statement {
  values: SQLInputValue[] = [];
  constructor(readonly db: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  execute() {
    const query = this.db.prepare(this.sql);
    return query.columns().length > 0
      ? { success: true, results: query.all(...this.values), meta: {} }
      : { success: true, results: [], meta: { changes: Number(query.run(...this.values).changes) } };
  }
  async run() { return this.execute(); }
  async first(column?: string) { const row = this.db.prepare(this.sql).get(...this.values); return row ? column ? row[column] : row : null; }
  async all() { return this.execute(); }
}
async function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const binding = {
    prepare(sql: string) { return new Statement(db, sql); },
    async batch(statements: Statement[]) {
      db.exec("BEGIN IMMEDIATE");
      try { const result = statements.map((statement) => statement.execute()); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  const objects = new Map<string, { bytes: Uint8Array; options?: R2PutOptions }>();
  bindings.DB = binding;
  bindings.STORAGE = { async put(key: string, body: ArrayBuffer | Uint8Array, options?: R2PutOptions) {
    objects.set(key, { bytes: new Uint8Array(body instanceof Uint8Array ? body : new Uint8Array(body)), options });
    return { key };
  } } as unknown as R2Bucket;
  await ensureDatabase(binding);
  return { db, objects };
}
const originalFetch = globalThis.fetch;
const gif = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
function current(db: DatabaseSync, source: string) { return db.prepare("SELECT listing_id FROM source_current_listings WHERE source_id=? ORDER BY listing_id").all(source).map((row) => row.listing_id); }
function summaryMessage(value: unknown) { return JSON.stringify(value); }
function clean(db: DatabaseSync) { assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []); globalThis.fetch = originalFetch; db.close(); }

test("direct JSON discovery persists canonical facts and R2 image, then reuses immutable detail without refetch", async () => {
  const { db, objects } = await database();
  const calls: string[] = [];
  let title = "Original instrument";
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://json.fixture.test/inventory") return Response.json({ total: 1, items: [{ id: "one", title }] });
    if (url === "https://json.fixture.test/items/one") return Response.json({ id: "one", title, description: "Immutable observed description", image: "https://images.fixture.test/one.gif" });
    if (url === "https://images.fixture.test/one.gif") return new Response(gif, { headers: { "content-type": "image/gif" } });
    throw new Error(`Unexpected fixture network request ${url}`);
  };
  try {
    const first = await runAuctionDiscovery("manual", { sourceId: "fixture_json" });
    assert.equal(first.status, "completed", summaryMessage(first));
    assert.equal(first.discovered, 1);
    assert.equal(first.detailsFetched, 1, summaryMessage(first));
    assert.equal(first.accepted, 1);
    assert.equal(first.imagesArchived, 1);
    assert.equal(objects.size, 1);
    assert.deepEqual([...objects.values()][0]!.bytes, gif);
    assert.equal([...objects.values()][0]!.options?.customMetadata?.sourceUrl, "https://images.fixture.test/one.gif");
    const ids = current(db, "fixture_json");
    assert.equal(ids.length, 1);
    const immutable = db.prepare("SELECT * FROM listing_details WHERE listing_id=?").get(ids[0] as string);
    assert.equal(immutable?.clean_description, "Immutable observed description");
    assert.equal(db.prepare("SELECT download_status FROM listing_images WHERE listing_id=?").get(ids[0] as string)?.download_status, "downloaded");
    title = "Changed later title";
    const second = await runAuctionDiscovery("manual", { sourceId: "fixture_json" });
    assert.equal(second.status, "completed", summaryMessage(second));
    assert.equal(second.newListings, 0);
    assert.equal(second.detailsFetched, 0);
    assert.equal(second.imageAttempts, 0);
    assert.equal(calls.filter((url) => url.endsWith("/items/one")).length, 1);
    assert.equal(calls.filter((url) => url.endsWith(".gif")).length, 1);
    assert.deepEqual(db.prepare("SELECT * FROM listing_details WHERE listing_id=?").get(ids[0] as string), immutable);
    assert.equal(db.prepare("SELECT title FROM listing_stubs WHERE id=?").get(ids[0] as string)?.title, "Original instrument");
    assert.deepEqual(current(db, "fixture_json"), ids);
    assert.deepEqual(db.prepare("SELECT status FROM discovery_runs ORDER BY started_at").all().map((row) => row.status), ["completed", "completed"]);
  } finally { clean(db); }
});

test("HTML malformed and ambiguous empty inventory preserve publication; explicit empty replaces current membership only", async () => {
  const { db } = await database();
  let body = '<main><article data-id="one">Original HTML item</article></main>';
  globalThis.fetch = async (input) => {
    assert.equal(String(input instanceof Request ? input.url : input), "https://html.fixture.test/inventory");
    return new Response(body, { headers: { "content-type": "text/html" } });
  };
  try {
    const first = await runAuctionDiscovery("manual", { sourceId: "fixture_html", catalogOnly: true });
    assert.equal(first.status, "completed", summaryMessage(first));
    const ids = current(db, "fixture_html");
    assert.equal(ids.length, 1);
    const head = await storage.readSourceInventoryPublicationHead("fixture_html");
    for (const invalid of ["<p>Unrecognized page</p>", "<main></main>"]) {
      body = invalid;
      const failed = await runAuctionDiscovery("manual", { sourceId: "fixture_html", catalogOnly: true });
      assert.equal(failed.status, "partial", summaryMessage(failed));
      assert.equal(failed.sourceErrors.length, 1);
      assert.deepEqual(failed.publishedSourceIds, []);
      assert.deepEqual(current(db, "fixture_html"), ids);
      assert.deepEqual(await storage.readSourceInventoryPublicationHead("fixture_html"), head);
    }
    body = '<main><span data-empty>No current items</span></main>';
    const empty = await runAuctionDiscovery("manual", { sourceId: "fixture_html", catalogOnly: true });
    assert.equal(empty.status, "completed", summaryMessage(empty));
    assert.deepEqual(current(db, "fixture_html"), []);
    assert.equal((await storage.readSourceInventoryPublicationHead("fixture_html"))?.listingCount, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM listing_stubs").get()?.n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM listing_details").get()?.n, 1);
  } finally { clean(db); }
});

test("real rendered browser capture imports inline evidence and continuation reaches local proximity plus terminal image absence without network", async () => {
  const { db, objects } = await database();
  globalThis.fetch = async () => { throw new Error("Browser import and inline continuation must not make source requests"); };
  let launched: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const adapter = sourceRegistry.get("fixture_browser")!;
    const plan = planGenericSourceAcquisition("fixture_browser", { enabled: true });
    const pages = await captureGenericSourcePages(plan, { launch: async () => {
      launched = await chromium.launch({ headless: true, ...(process.env.PUBLIC_BROWSER_TEST_EXECUTABLE ? { executablePath: process.env.PUBLIC_BROWSER_TEST_EXECUTABLE } : {}) });
      const newContext = launched.newContext.bind(launched);
      launched.newContext = async (options) => {
        const context = await newContext(options);
        await context.route("https://browser.fixture.test/inventory", (route) => route.fulfill({ contentType: "text/html", body: '<main></main><script>document.querySelector("main").innerHTML="<article data-id=one>Rendered fixture instrument</article>";</script>' }));
        return context;
      };
      return launched;
    } });
    assert.equal(launched?.isConnected(), false);
    assert.equal(adapter.parseDiscoveryPage(pages[0]!.page)[0]!.title, "Rendered fixture instrument");
    const validated = await validateGenericAcquiredPages(plan, pages);
    const imported = await runAuctionDiscovery("manual", { sourceId: "fixture_browser", catalogOnly: true, acquiredPages: validated });
    assert.equal(imported.status, "completed", summaryMessage(imported));
    assert.equal(imported.detailsFetched, 1);
    assert.equal(imported.imageAttempts, 0);
    const ids = current(db, "fixture_browser");
    assert.equal(ids.length, 1);
    const continued = await runAuctionDiscovery("manual", { sourceId: "fixture_browser", mode: "continuation" });
    assert.equal(continued.status, "completed", summaryMessage(continued));
    assert.equal(continued.sourceWorkSelected, 1, summaryMessage(continued));
    assert.equal(continued.accepted, 1);
    assert.equal(continued.detailsFetched, 0);
    assert.equal(continued.imageAttempts, 0);
    assert.equal(objects.size, 0);
    const route = db.prepare("SELECT r.drive_bucket,r.provider_name FROM listing_routes l JOIN route_cache r ON r.id=l.route_cache_id WHERE l.listing_id=?").get(ids[0] as string);
    assert.equal(route?.drive_bucket, "under_2h");
    assert.equal(route?.provider_name, "local_proximity");
    assert.ok(db.prepare("SELECT state,stage,last_error_code FROM listing_recovery_status WHERE listing_id=? AND state='terminal' AND stage='image' AND last_error_code='source_image_absent'").get(ids[0] as string));
    const again = await runAuctionDiscovery("manual", { sourceId: "fixture_browser", mode: "continuation" });
    assert.equal(again.status, "completed", summaryMessage(again));
    assert.equal(again.sourceWorkSelected, 0, "terminal unchanged evidence must not become a retry loop");
    assert.deepEqual(current(db, "fixture_browser"), ids);
  } finally { await launched?.close(); clean(db); }
});

test("unsupported origin fails before creating a discovery receipt or mutation lease", async () => {
  const { db } = await database();
  process.env.ORIGIN_POSTAL_CODE = "99999";
  try {
    await assert.rejects(runAuctionDiscovery("manual", { sourceId: "fixture_html", catalogOnly: true }), /Origin ZIP.*bundled Census ZCTA/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM discovery_runs WHERE status='running'").get()?.n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM pipeline_run_lease").get()?.n, 0);
  } finally { process.env.ORIGIN_POSTAL_CODE = "90210"; clean(db); }
});

test("bounded repeated preparation progresses past already complete catalog prefixes", async (t) => {
  process.env.PIPELINE_MAX_CANDIDATES_PER_SOURCE = "1";
  try {
    for (const mode of ["normal", "catalog_then_continuation"] as const) {
      await t.test(mode, async () => {
        const { db } = await database();
        let requests = 0;
        globalThis.fetch = async (input) => {
          assert.equal(String(input instanceof Request ? input.url : input), "https://html.fixture.test/inventory");
          requests++;
          return new Response('<main><article data-id="one">First item</article><article data-id="two">Second item</article></main>', { headers: { "content-type": "text/html" } });
        };
        try {
          if (mode === "catalog_then_continuation") {
            const catalog = await runAuctionDiscovery("manual", { sourceId: "fixture_html", catalogOnly: true });
            assert.equal(catalog.status, "completed", summaryMessage(catalog));
          }
          for (let pass = 0; pass < 2; pass++) {
            const prepared = await runAuctionDiscovery("manual", { sourceId: "fixture_html", ...(mode === "catalog_then_continuation" ? { mode: "continuation" as const } : {}) });
            assert.equal(prepared.status, "completed", summaryMessage(prepared));
          }
          const preparedIds = db.prepare("SELECT DISTINCT listing_id FROM listing_routes ORDER BY listing_id").all().map((row) => row.listing_id);
          assert.deepEqual(preparedIds, current(db, "fixture_html"), "each bounded pass must advance to the next unfinished listing");
          assert.equal(preparedIds.length, 2);
          assert.equal(requests, mode === "catalog_then_continuation" ? 1 : 2);
          const terminalIds = db.prepare("SELECT DISTINCT listing_id FROM listing_recovery_status WHERE state='terminal' AND stage='image' AND last_error_code='source_image_absent' ORDER BY listing_id").all().map((row) => row.listing_id);
          assert.deepEqual(terminalIds, preparedIds);
        } finally { clean(db); }
      });
    }
  } finally { delete process.env.PIPELINE_MAX_CANDIDATES_PER_SOURCE; }
});

