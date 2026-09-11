import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { emptyDashboard, type DashboardListingScope, type Listing, type Vote } from "../../app/components/auction-data.ts";
import { ensureDatabase } from "../../db/bootstrap.ts";
import { readListingEndOverrides } from "../../db/listing-end-state.ts";

const bindings: { DB?: D1Database } = {};
Object.assign(globalThis, { __selectionBrowserBindings: bindings });
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) { if(s === 'cloudflare:workers') return {shortCircuit:true,url:'data:text/javascript,export const env = globalThis.__selectionBrowserBindings;'}; return n(s,c); }`)}`, import.meta.url);
const { PUT } = await import("../../app/api/listings/end-batch/route.ts");
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

function fixtureListing(index: number): Listing {
  const id = `fixture:${index}`;
  const title = index === 105 ? "Excluded instrument" : `Bench instrument ${String(index).padStart(3, "0")}`;
  return {
    id, title, source: "Fixture", sourceFilters: ["Fixture"], sourceLinks: [], sourceListingId: String(index), sourceUrl: `https://example.invalid/${index}`,
    aiSummary: "", cleanDescription: "Observed fixture equipment", rawDescription: "Observed fixture equipment",
    pickupLocation: { city: "Fixture City", state: "CA", postalCode: "90210" }, driveMinutes: 10, driveBucket: "under_2h", distanceWaived: false,
    priceAtScrape: "$10", closesAt: index === 2 ? "2099-09-11T12:00:00.000Z" : index === 3 ? "2099-09-11" : "",
    actionDeadline: index === 0 ? { at: "2000-09-11T12:00:00.000Z", basis: "live_auction_start", sourceText: "Auction starts", observedAt: "2026-09-11T12:00:00.000Z" } : null, markedEndedAt: null, firstSeenAt: "2026-09-11T12:00:00.000Z", isNewSinceLastRun: false,
    recommendation: null, vote: index === 4 ? "interested" : null, voteReady: index !== 0, lotOverride: null, primaryImageUrl: "", galleryImageUrls: [], images: [],
    attributes: { assetClasses: [], industryDomain: "laboratory", manufacturer: null, manufacturers: [], modelNumbers: [], lotType: "single_item", includedItems: [], missingItems: [], condition: "used", testedStatus: "unknown", highValueSignals: [], negativeSignals: [], safetyFlags: [] },
    aiMeta: { provider: "pending", model: "", promptVersion: "", generatedAt: "" },
  };
}

test("real dashboard selection and operator-ended state survive reload through the real API and SQLite", { timeout: 90_000 }, async () => {
  const db = new DatabaseSync(":memory:");
  const cacheDir = await mkdtemp(resolve(tmpdir(), "auction-selection-browser-"));
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const unexpected: string[] = [];
  const browserErrors: string[] = [];
  const endRequests: string[][] = [];
  const voteRequests: string[][] = [];
  const listings = Array.from({ length: 106 }, (_, index) => fixtureListing(index));
  const votes = new Map(listings.map(listing => [listing.id, listing.vote]));
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
    db.prepare("INSERT INTO auction_sources(id,display_name,base_url) VALUES ('fixture','Fixture','https://example.invalid')").run();
    for (const listing of listings) {
      db.prepare("INSERT INTO listing_stubs(id,source_id,source_listing_id,source_url,title,discovered_at,content_hash) VALUES (?,'fixture',?,?,?,?,?)")
        .run(listing.id, listing.sourceListingId, listing.sourceUrl, listing.title, listing.firstSeenAt, listing.id);
      db.prepare("INSERT INTO listing_details(listing_id,title_at_scrape,raw_description,clean_description,auction_ends_at,scraped_at,content_hash) VALUES (?,?,?,?,?,?,?)")
        .run(listing.id, listing.title, listing.rawDescription, listing.cleanDescription, listing.closesAt || null, listing.firstSeenAt, listing.id);
      if (listing.actionDeadline) db.prepare("INSERT INTO listing_action_deadlines(listing_id,deadline_at,basis,source_text,source_url,detail_content_hash,observed_at) VALUES (?,?,?,?,?,?,?)")
        .run(listing.id, listing.actionDeadline.at, listing.actionDeadline.basis, listing.actionDeadline.sourceText, listing.sourceUrl, "fnv1a64:0000000000000000", listing.actionDeadline.observedAt);
      if (listing.vote) db.prepare("INSERT INTO listing_votes(listing_id,value) VALUES (?,?)").run(listing.id, listing.vote);
    }
    const originalSource = JSON.stringify(db.prepare("SELECT * FROM listing_details ORDER BY listing_id").all());
    const originalDeadlines = JSON.stringify(db.prepare("SELECT * FROM listing_action_deadlines ORDER BY listing_id").all());
    const originalVotes = JSON.stringify(db.prepare("SELECT * FROM listing_votes ORDER BY listing_id").all());
    server = await createServer({
      root, configFile: false, cacheDir, logLevel: "error", esbuild: { jsx: "automatic" },
      server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
      plugins: [{ name: "selection-fixture-entry", configureServer(vite) {
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
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === origin && url.pathname === "/api/dashboard") {
        const scope = (url.searchParams.get("listingScope") ?? "unvoted") as DashboardListingScope;
        const overrides = await readListingEndOverrides(bindings.DB!, listings.map(listing => listing.id));
        const scoped = listings.map(listing => ({ ...listing, markedEndedAt: overrides.get(listing.id) ?? null, vote: votes.get(listing.id) ?? null })).filter(listing => scope === "all" || (scope === "unvoted" ? listing.vote === null : scope === "voted" ? listing.vote !== null : listing.vote === scope));
        return route.fulfill({ json: { ...emptyDashboard, originPostalCode: "90210", listingScope: scope, hasReviewedListings: true, listings: scoped, run: { ...emptyDashboard.run, refreshRequired: false, discoveredListings: listings.length, currentUnvotedListings: scoped.length } } });
      }
      if (url.origin === origin && request.method() === "GET" && decodeURIComponent(url.pathname) === "/api/listings/fixture:0/detail") {
        const listing = listings[0]!;
        return route.fulfill({ json: { listingId: listing.id, cleanDescription: listing.cleanDescription, rawDescription: listing.rawDescription, galleryImageUrls: listing.galleryImageUrls, images: listing.images } });
      }
      if (url.origin === origin && url.pathname === "/api/listings/end-batch") {
        endRequests.push(request.postDataJSON().listingIds);
        const response = await PUT(new Request(request.url(), { method: request.method(), headers: { "content-type": "application/json" }, body: request.postData() }));
        return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
      }
      if (url.origin === origin && url.pathname === "/api/listings/vote-batch") {
        const ids = request.postDataJSON().listingIds as string[];
        voteRequests.push(ids);
        ids.forEach(id => votes.set(id, "not_interested"));
        return route.fulfill({ json: { requestedCount: ids.length, changedCanonicalListingIds: ids, outcomes: ids.map(listingId => ({ listingId, canonicalListingId: listingId, status: "changed", vote: "not_interested" as Vote })) } });
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
    const check = (index: number) => page.getByRole("checkbox", { name: `Select Bench instrument ${String(index).padStart(3, "0")}`, exact: true });
    await check(0).waitFor();
    if (await page.getByRole("button", { name: /^Filters\./ }).isVisible()) await page.getByRole("button", { name: /^Filters\./ }).click();
    await page.locator(".review-type-select select").selectOption("all");
    await page.getByPlaceholder("Search equipment, model, or city…").fill("Bench");
    await page.waitForFunction(() => document.querySelector(".results-toolbar strong")?.textContent === "105");
    assert.equal(await page.locator(".listing-card").count(), 100);
    assert.equal(await page.getByRole("checkbox", { name: "Select Excluded instrument", exact: true }).count(), 0);
    const cardBounds = await check(0).locator("xpath=ancestor::article").boundingBox();
    const checkBounds = await check(0).boundingBox();
    assert.ok(cardBounds && checkBounds);
    assert.ok(checkBounds.x - cardBounds.x < 50 && checkBounds.y - cardBounds.y < 50, "checkbox is at the card's top-left");
    await page.getByRole("button", { name: "Select all", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".selection-count")?.textContent === "105 selected");
    assert.equal(await page.locator('.listing-card input[type="checkbox"]:checked').count(), 100);
    await page.getByRole("button", { name: "Deselect all", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".selection-count")?.textContent === "0 selected");
    await check(0).check();
    await page.getByPlaceholder("Search equipment, model, or city…").fill("Bench instrument 001");
    await page.waitForFunction(() => document.querySelector(".selection-count")?.textContent === "0 selected");
    await page.getByPlaceholder("Search equipment, model, or city…").fill("Bench");
    const restoredSelection = await check(0).isChecked();
    if (restoredSelection) await check(0).uncheck();
    await check(0).check();
    const startOnlyText = await check(0).locator("xpath=ancestor::article").innerText();
    assert.match(startOnlyText, /Live auction/i);
    assert.match(startOnlyText, /Unrated/);
    assert.match(startOnlyText, /No archived photo/);
    assert.doesNotMatch(startOnlyText, /Marked ended/);
    assert.equal(await page.getByRole("button", { name: "Mark Not Interested", exact: true }).isDisabled(), true, "fixture is not ready for voting");
    assert.equal(await page.getByRole("button", { name: "Mark ended", exact: true }).isEnabled(), true, "start-only unready listing remains eligible for manual ending");
    await check(2).check();
    await page.getByRole("button", { name: "Mark ended", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some(element => element.textContent?.includes("Marked 1 selected listing ended")));
    assert.deepEqual(endRequests, [["fixture:0"]]);
    assert.deepEqual(db.prepare("SELECT listing_id FROM listing_end_overrides").all().map(row => row.listing_id), ["fixture:0"]);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM listing_details ORDER BY listing_id").all()), originalSource);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM listing_votes ORDER BY listing_id").all()), originalVotes);
    assert.equal(JSON.stringify(db.prepare("SELECT * FROM listing_action_deadlines ORDER BY listing_id").all()), originalDeadlines);
    await page.getByRole("button", { name: "Review Bench instrument 000. Unrated", exact: true }).click();
    const detail = page.getByRole("dialog");
    await detail.getByText(/^Source auction start: .* local$/).waitFor();
    assert.doesNotMatch(await detail.innerText(), /be ready to bid/i);
    await detail.getByRole("button", { name: "Close listing detail", exact: true }).click();
    await check(0).uncheck();
    await check(2).uncheck();
    await check(1).check();
    await check(4).check();
    await page.getByRole("button", { name: "Mark Not Interested", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".toast")].some(element => element.textContent?.includes("Marked 1 selected listing Not interested")));
    assert.deepEqual(voteRequests, [["fixture:1"]]);
    assert.equal(votes.get("fixture:4"), "interested");
    assert.equal(votes.get("fixture:6"), null);
    await page.reload();
    await check(0).waitFor();
    await check(0).locator("xpath=ancestor::article").getByText("Marked ended", { exact: true }).waitFor();
    if (await page.getByRole("button", { name: /^Filters\./ }).isVisible()) await page.getByRole("button", { name: /^Filters\./ }).click();
    await page.getByRole("button", { name: "Include ended", exact: true }).click();
    await check(0).waitFor({ state: "detached" });
    await check(2).waitFor();
    await page.getByRole("button", { name: "Include ended", exact: true }).click();
    await check(0).waitFor();
    assert.equal(restoredSelection, false, "returning to a filter must not revive obsolete checked rows");
    assert.deepEqual(browserErrors, []);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } catch (error) {
    if (browser) for (const context of browser.contexts()) for (const page of context.pages()) console.error((await page.locator("body").innerText().catch(() => "")).slice(0, 2000));
    console.error({ browserErrors, unexpected });
    throw error;
  } finally {
    await browser?.close();
    await server?.close();
    delete bindings.DB;
    db.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
