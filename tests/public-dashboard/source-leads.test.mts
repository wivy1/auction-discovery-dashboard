import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { resolve, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { ensureDatabase } from "../../db/bootstrap.ts";
import type { DashboardPayload } from "../../app/components/auction-data.ts";

process.env.ORIGIN_POSTAL_CODE = "90210";
for (const key of ["AI_TEXT_PROVIDER", "AI_TEXT_MODEL", "AI_EMBEDDING_PROVIDER", "AI_EMBEDDING_MODEL"]) delete process.env[key];
const bindings: { DB?: D1Database } = {};
Object.assign(globalThis, { __sourceLeadsDashboardBindings: bindings });
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) { if(s === 'cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env = globalThis.__sourceLeadsDashboardBindings;'}; return n(s,c); }`)}`, import.meta.url);
const { GET } = await import("../../app/api/dashboard/route.ts");
const root = fileURLToPath(new URL("../../", import.meta.url));

class Statement {
  values: SQLInputValue[] = [];
  constructor(readonly db: DatabaseSync, readonly sql: string) {}
  bind(...values: SQLInputValue[]) { this.values = values; return this; }
  execute() {
    const statement = this.db.prepare(this.sql);
    return statement.columns().length ? { success: true, results: statement.all(...this.values), meta: {} }
      : { success: true, results: [], meta: { changes: Number(statement.run(...this.values).changes) } };
  }
  async run() { return this.execute(); }
  async all() { return this.execute(); }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
}

const observedAt = "2026-01-01T00:00:00.000Z";
const privateText = "PRIVATE_EVENT_ADDRESS_SENTINEL";
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const rootFact = { url: "https://events.example.test/current", bodyHash: "fnv1a64:0123456789abcdef", fetchedAt: observedAt };
function addressLead(eventId: string) {
  return { pageKey: `event:${eventId}`, evidence: {
    kind: "unresolved_address_v1", publisherHost: "events.example.test", eventId,
    canonicalUrl: `https://events.example.test/events/${eventId}`, addressStatus: "unresolved",
    root: { ...rootFact, inlineAddress: null, renderedAddressText: privateText },
    event: { bodyHash: "fnv1a64:0123456789abcdef", fetchedAt: observedAt, inlineAddress: null, renderedAddressText: null },
  } };
}
function currentLeads() {
  const pair = ["shared-left", "shared-right"].map((eventId, index, ids) => ({ pageKey: `event:${eventId}`, evidence: {
    kind: "shared_outbound_v1", publisherHost: "events.example.test", eventId,
    canonicalUrl: `https://events.example.test/events/${eventId}`, outboundStatus: "unresolved", root: rootFact,
    event: { bodyHash: "fnv1a64:0123456789abcdef", fetchedAt: observedAt, outboundTargetHash: hash("opaque synthetic target") },
    peer: { eventId: ids[1 - index], canonicalUrlHash: hash(`https://events.example.test/events/${ids[1 - index]}`) },
  } }));
  return [addressLead("address"), { pageKey: "event:opaque", evidence: {
    kind: "unresolved_outbound_v1", publisherHost: "events.example.test", eventId: "opaque",
    canonicalUrl: "https://events.example.test/events/opaque", outboundStatus: "unresolved", root: rootFact,
    event: { bodyHash: "fnv1a64:0123456789abcdef", fetchedAt: observedAt, outbound: {
      hrefHash: hash("opaque synthetic href"), https: true, externalToPublisher: true, queryPresent: true,
      fragmentPresent: true, credentialsPresent: false, portPresent: false, signedQueryKeyPresent: false,
    } },
  } }, ...pair];
}

test("Settings counts current event-lead evidence after a failed attempt without claiming an unresolved-event total", { timeout: 60_000 }, async () => {
  const db = new DatabaseSync(":memory:");
  const cacheParent = resolve(root, ".wrangler/public-dashboard-tests");
  await mkdir(cacheParent, { recursive: true });
  const cacheDir = await mkdtemp(resolve(cacheParent, "source-leads-"));
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const unexpected: string[] = [];
  const browserErrors: string[] = [];
  try {
    db.exec("PRAGMA foreign_keys=ON");
    bindings.DB = {
      prepare(sql: string) { return new Statement(db, sql); },
      async batch(statements: Statement[]) {
        db.exec("BEGIN IMMEDIATE");
        try { const result = statements.map(statement => statement.execute()); db.exec("COMMIT"); return result; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    } as unknown as D1Database;
    await ensureDatabase(bindings.DB);
    for (const [id, name] of [["event_fixture", "Fixture event directory"], ["lot_fixture", "Fixture lot source"]]) {
      db.prepare("INSERT INTO auction_sources(id,display_name,base_url,enabled,permission_status) VALUES (?,?,?,1,'allowed')")
        .run(id!, name!, "https://events.example.test");
    }
    for (const [id, day, status] of [["old-head", "01", "completed"], ["current-head", "02", "completed"], ["failed-attempt", "03", "failed"], ["lot-head", "01", "completed"]]) {
      db.prepare("INSERT INTO discovery_runs(id,trigger,status,origin_postal_code,started_at,completed_at) VALUES (?,'manual',?,'90210',?,?)")
        .run(id!, status!, `2026-01-${day}T00:00:00.000Z`, `2026-01-${day}T00:00:01.000Z`);
    }
    db.prepare("INSERT INTO source_runs(id,discovery_run_id,source_id,status,started_at,completed_at,error_message) VALUES ('failed-source','failed-attempt','event_fixture','failed','2026-01-03T00:00:00.000Z','2026-01-03T00:00:01.000Z','Synthetic failed attempt')").run();
    const insertPublication = db.prepare("INSERT INTO source_inventory_publications(source_id,inventory_run_id,listing_count,publisher_lead_evidence_json) VALUES ('event_fixture',?,0,?)");
    insertPublication.run("old-head", JSON.stringify([addressLead("old")]));
    insertPublication.run("current-head", JSON.stringify(currentLeads()));
    db.prepare("INSERT INTO source_inventory_publication_heads(source_id,inventory_run_id) VALUES ('event_fixture','current-head')").run();
    db.prepare("INSERT INTO listing_stubs(id,source_id,source_listing_id,source_url,title,discovered_at,content_hash) VALUES ('lot:one','lot_fixture','one','https://lots.example.test/one','Fixture instrument',?,'fixture')").run(observedAt);
    db.prepare("INSERT INTO source_current_listings(listing_id,source_id,inventory_run_id,observed_at) VALUES ('lot:one','lot_fixture','lot-head',?)").run(observedAt);
    db.prepare("INSERT INTO source_inventory_publications(source_id,inventory_run_id,listing_count) VALUES ('lot_fixture','lot-head',1)").run();
    db.prepare("INSERT INTO source_inventory_publication_heads(source_id,inventory_run_id) VALUES ('lot_fixture','lot-head')").run();
    const readPayload = async () => {
      const response = await GET(new Request("http://localhost/api/dashboard"));
      assert.equal(response.status, 200);
      return await response.json() as DashboardPayload;
    };
    const payload = await readPayload();
    const eventSource = payload.sources.find(source => source.id === "event_fixture")!;
    assert.equal(eventSource.state, "failed");
    assert.equal(eventSource.coverage.catalog, 0);
    assert.equal(eventSource.coverage.eventLeadEvidenceCount, 4, "only special evidence records from the retained current head count");
    assert.equal(payload.sources.find(source => source.id === "lot_fixture")!.coverage.catalog, 1);
    assert.equal(payload.sources.find(source => source.id === "lot_fixture")!.coverage.eventLeadEvidenceCount, 0);
    assert.equal("unresolvedEventLeads" in eventSource.coverage, false);
    assert.equal(JSON.stringify(payload).includes(privateText), false);
    assert.equal(JSON.stringify(payload.sources).includes("events.example.test"), false);
    assert.equal(JSON.stringify(payload.sources).includes("publisherLeadEvidence"), false);
    server = await createServer({ root, configFile: false, cacheDir, logLevel: "error", esbuild: { jsx: "automatic" },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
      plugins: [{ name: "source-leads-fixture", configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== "/") return next();
          response.setHeader("content-type", "text/html");
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/public-dashboard/selection-browser.fixture.tsx"></script></body></html>');
        });
      } }],
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.PUBLIC_BROWSER_TEST_EXECUTABLE ? { executablePath: process.env.PUBLIC_BROWSER_TEST_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname === "/api/dashboard") {
        const response = await GET(new Request(request.url()));
        return route.fulfill({ status: response.status, body: await response.text(), headers: { "content-type": "application/json" } });
      }
      if ((url.origin === origin && url.pathname === "/api/system/ollama") || (url.hostname === "127.0.0.1" && url.port === "32110")) {
        return route.fulfill({ status: 503, json: { error: "Fixture has no companion or model service" } });
      }
      if (url.origin === origin && !url.pathname.startsWith("/api/")) return route.continue();
      unexpected.push(request.url());
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => browserErrors.push(error.message));
    await page.goto(origin);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const eventRow = page.getByRole("row").filter({ hasText: "Fixture event directory" });
    await eventRow.getByText("4 event lead evidence records", { exact: true }).waitFor();
    assert.match(await eventRow.locator(".source-coverage").innerText(), /^0 catalog/u);
    assert.doesNotMatch(await eventRow.locator(".source-coverage").innerText(), /unresolved event leads|event total|of 20|20 events/iu);
    const lotRow = page.getByRole("row").filter({ hasText: "Fixture lot source" });
    assert.match(await lotRow.locator(".source-coverage").innerText(), /^1 catalog/u);
    assert.doesNotMatch(await lotRow.innerText(), /event lead evidence records/u);
    db.prepare("DELETE FROM source_inventory_publication_heads WHERE source_id='event_fixture'").run();
    assert.equal((await readPayload()).sources.find(source => source.id === "event_fixture")!.coverage.eventLeadEvidenceCount, 0, "unheaded historical publications cannot supply the count");
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("table", { name: "Auction source status" }).waitFor();
    assert.equal(await page.getByText("4 event lead evidence records", { exact: true }).count(), 0);
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    await browser?.close();
    await server?.close();
    delete bindings.DB;
    db.close();
    assert.ok(resolve(cacheDir).startsWith(`${cacheParent}${sep}`));
    await rm(cacheDir, { recursive: true, force: true });
  }
});
