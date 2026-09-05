import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium, type Browser } from "playwright";
import { captureGenericSourcePages } from "../../scripts/source-browser-acquisition";
import { planGenericSourceAcquisition, validateGenericAcquiredPages } from "../../lib/pipeline/source-acquisition";
import { defineListingStub, defineListingDetail } from "../../lib/domain/listings";
import type { SourceAdapter, SourcePage } from "../../lib/sources/types";

// All source traffic stays on this ephemeral loopback fixture server.
const server = createServer((request, response) => {
  if (request.url === "/redirect") { response.writeHead(302, { location: "http://not-permitted.invalid/" }); response.end(); return; }
  if (request.url === "/slow") { return; }
  response.setHeader("content-type", "text/html");
  if (request.url === "/denied") { response.statusCode = 403; response.end("Access denied"); return; }
  if (request.url === "/challenge") { response.end("<p>Verify you are human</p>"); return; }
  if (request.url === "/stream-large") { response.write("a".repeat(100_000)); response.end(); return; }
  if (request.url === "/budget") { response.end('<main></main><script src="https://fixture.invalid/script.js"></script><script src="https://fixture.invalid/script.js?extra"></script>'); return; }
  if (request.url === "/large") { response.end("a".repeat(100_000)); return; }
  if (request.url === "/empty") { response.end('<main data-empty="true"></main>'); return; }
  if (request.url === "/malformed") { response.end("<main>Unknown inventory</main>"); return; }
  if (request.url === "/unlisted") { response.end('<script src="http://not-permitted.invalid/script.js"></script>'); return; }
  if (request.url === "/script") { response.end('<main></main><script src="https://fixture.invalid/script.js"></script>'); return; }
  if (request.url === "/js") { response.end('<main></main><script>document.querySelector("main").innerHTML="<article data-fixture-listing>Fixture listing</article>";</script>'); return; }
  response.end('<main><article data-fixture-listing>Fixture listing</article></main>');
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let liveBrowser: Browser | undefined;
const launch = async () => {
  liveBrowser = await chromium.launch({ headless: true, ...(process.env.PUBLIC_BROWSER_TEST_EXECUTABLE ? { executablePath: process.env.PUBLIC_BROWSER_TEST_EXECUTABLE } : {}) });
  const newContext = liveBrowser.newContext.bind(liveBrowser);
  liveBrowser.newContext = async (options) => {
    const context = await newContext(options);
    // This one HTTPS subresource is synthetic route fulfillment; document
    // loads and denial/timeout behavior use the actual local HTTP server.
    await context.route("https://fixture.invalid/script.js", (route) => route.fulfill({ contentType: "application/javascript", body: 'setTimeout(() => document.querySelector("main").innerHTML="<article data-fixture-listing>Fixture listing</article>", 600);' }));
    return context;
  };
  return liveBrowser;
};
function adapter(path: string, timeoutMs = 4_000): SourceAdapter {
  const url = origin + path;
  const parse = (page: SourcePage) => {
    if (page.body.includes('data-empty="true"')) return [];
    if (!page.body.includes("data-fixture-listing")) throw new Error("Malformed fixture inventory: explicit empty marker missing");
    // This test adapter checks the transport/parser boundary. Normalization and
    // real source facts are covered by the separate generic adapter fixtures.
    const identity = { sourceId: "fixture", sourceListingId: "1", sourceUrl: url, title: "Fixture listing", category: null, lotNumber: null, contentHash: "fixture" };
    return [{ stub: defineListingStub({ ...identity, discoveredAt: page.fetchedAt, thumbnailUrl: null }), detail: defineListingDetail({ ...identity, rawDescription: "Fixture description", cleanDescription: "Fixture description", priceAtScrape: {}, auctionEndsAt: null, seller: null, images: [], scrapedAt: page.fetchedAt }) }];
  };
  return {
    manifest: { id: "fixture", displayName: "Local fixture", baseUrl: origin, inventoryScope: "current", transport: "html", acquisition: "isolated_browser", implementationStatus: "ready", enabledByDefault: false,
      access: { permissionBasis: "recorded_permission", permissionReference: "local-test-fixture", permissionRecordedAt: "2026-01-01T00:00:00Z", reviewedAt: "2026-01-01T00:00:00Z", termsUrl: null, robotsUrl: null, documentationUrls: [], note: "Synthetic local fixture only" },
      requests: { allowedBrowserRequests: [{ host: "fixture.invalid", path: "/script.js", method: "GET", resourceType: "script" }, { host: "fixture.invalid", path: "/script.js?extra", method: "GET", resourceType: "script" }], allowedHosts: ["127.0.0.1"], minDelayMs: 1, maxRequestsPerRun: path === "/budget" ? 2 : 4, timeoutMs, maxRetries: 0, maxResponseBytes: 16_384 } },
    ...(path === "/script" ? { browser: { readySelector: "[data-fixture-listing]" } } : {}),
    planDiscovery: () => [{ kind: "discovery", url }],
    parseDiscoveryBatch: parse, parseDiscoveryPage: (page) => parse(page).map((row) => row.stub),
    planDetail: () => null, parseDetailPage: () => { throw new Error("No fixture detail requests"); },
  };
}

test("generic browser captures ordinary and JavaScript-rendered pages, closes on every success and stop", async (t) => {
  try {
    for (const path of ["/ok", "/js", "/script", "/empty"]) {
      await t.test(path, async () => {
        const source = adapter(path);
        const plan = planGenericSourceAcquisition("fixture", { enabled: true }, source);
        const pages = await captureGenericSourcePages(plan, { adapter: source, launch });
        assert.equal(pages.length, 1);
        assert.equal(source.parseDiscoveryPage(pages[0]!.page).length, path === "/empty" ? 0 : 1);
        assert.equal(liveBrowser?.isConnected(), false);
        await assert.rejects(validateGenericAcquiredPages(plan, [{ ...pages[0], bodySha256: "0".repeat(64) }], source), /digest/);
      });
    }
    for (const [path, expected] of [["/malformed", /Malformed/], ["/denied", /HTTP 403/], ["/challenge", /challenge/], ["/redirect", /HTTP 302|redirect/], ["/unlisted", /unlisted/], ["/large", /byte budget/], ["/stream-large", /byte budget/], ["/budget", /request count budget/], ["/slow", /time budget|Timeout/]] as const) {
      await t.test(path, async () => {
        const source = adapter(path, path === "/slow" ? 300 : 4_000);
        const plan = planGenericSourceAcquisition("fixture", { enabled: true }, source);
        await assert.rejects(captureGenericSourcePages(plan, { adapter: source, launch }), expected);
        assert.equal(liveBrowser?.isConnected(), false);
      });
    }
    await t.test("cancellation closes a pending navigation", async () => {
      const source = adapter("/slow");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 800);
      try {
        await assert.rejects(captureGenericSourcePages(planGenericSourceAcquisition("fixture", { enabled: true }, source), { adapter: source, launch, signal: controller.signal }), /cancelled/);
        assert.equal(liveBrowser?.isConnected(), false);
      } finally { clearTimeout(timer); }
    });
    await t.test("unregistered and disabled sources fail before browser launch", async () => {
      assert.throws(() => planGenericSourceAcquisition("unregistered", { enabled: true }), /registered/);
      assert.throws(() => planGenericSourceAcquisition("fixture", { enabled: false }, adapter("/ok")), /disabled/);
    });
  } finally {
    await liveBrowser?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});



