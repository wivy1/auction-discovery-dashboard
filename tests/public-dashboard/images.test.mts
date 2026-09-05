import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { archiveImageBytes, primaryImageFailureExhaustsArchiveTargets, selectPrimaryImageArchiveTarget } from "../../lib/images/archive.ts";
import { parseImageAcquisitionFailurePayload } from "../../lib/images/browser-failure.ts";

const fixture = new URL("./image-adapter.fixture.mts", import.meta.url).href;
register(`data:text/javascript,${encodeURIComponent(`export async function resolve(s,c,n) { if(/source-adapters\\.local(?:\\.ts)?$/.test(s)) return {shortCircuit:true,url:${JSON.stringify(fixture)}}; return n(s,c); }`)}`, import.meta.url);
const images = await import("../../scripts/cache-source-images.ts");
const gif = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
const identity = `sha256:${"a".repeat(64)}`;
const queued = {
  id: "fixture-image", listingId: "fixture-listing", source: "example_inventory", sourceListingId: "one",
  listingTitle: "Bench instrument", listingUrl: "https://inventory.example.test/one",
  sourceUrl: "https://images.example.test/one.gif", fetchUrl: "https://images.example.test/one.gif",
  representation: "canonical", downloadStatus: "pending", acquisitionMethod: null, attemptCount: 0,
  lastAttemptedAt: null, downloadErrorCode: null, workInputHash: identity, workRevision: 1,
  sourceImageIdentityHash: identity,
};

test("registered direct images use normal queue, approved request, and exact content callback", async () => {
  let archived = false;
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
    if (url.pathname === "/api/images/cache-queue") return Response.json({
      images: archived ? [] : [queued], count: archived ? 0 : 1, limit: 25,
      sourceId: "example_inventory", workMode: "canonical", exactImageId: null, includeFailed: true,
    });
    if (url.hostname === "images.example.test") return new Response(gif, { headers: { "content-type": "image/gif" } });
    if (url.pathname === "/api/images/fixture-image/content") {
      assert.equal(init?.method, "PUT");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("x-image-work-input-hash"), identity);
      assert.equal(headers.get("x-image-work-revision"), "1");
      assert.deepEqual(new Uint8Array(init?.body as ArrayBuffer), gif);
      archived = true;
      return Response.json({ imageId: queued.id, listingId: queued.listingId, acquisitionMethod: "direct" });
    }
    throw new Error(`Unexpected test request ${url}`);
  };
  const result = await images.runDirectSourceImageDrain({ baseUrl: "http://localhost:3000", maxAttempts: 2 }, { fetchImpl });
  assert.equal(result.status, "completed");
  assert.equal(result.archived, 1);
  assert.equal(result.failed, 0);
  assert.equal(calls.filter(call => call.includes("images.example.test")).length, 1);
  assert.equal(images.directSourceImageDrainExitCode(result), 0);
});

test("an empty selected source registry makes no image or localhost requests", async () => {
  const result = await images.runDirectSourceImageDrain({ baseUrl: "http://localhost:3000", maxAttempts: 1 }, {
    fetchImpl: async () => { throw new Error("Empty registry must not fetch"); },
  }, []);
  assert.equal(result.status, "completed");
  assert.equal(result.attempted, 0);
  assert.deepEqual(result.sources, []);
});

test("an image denial records one failure and stops the source lane", async () => {
  let requests = 0;
  const failures: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/api/images/cache-queue") return Response.json({
      images: [queued], count: 1, limit: 25, sourceId: "example_inventory",
      workMode: "canonical", exactImageId: null, includeFailed: true,
    });
    if (url.hostname === "images.example.test") { requests += 1; return new Response("Access denied", { status: 403 }); }
    if (url.pathname === "/api/images/fixture-image/failure") {
      const payload = JSON.parse(String(init?.body));
      failures.push(payload.errorCode);
      return Response.json({ imageId: queued.id, listingId: queued.listingId, status: "failed", errorCode: payload.errorCode });
    }
    throw new Error(`Unexpected test request ${url}`);
  };
  const result = await images.runDirectSourceImageDrain({ baseUrl: "http://localhost:3000", maxAttempts: 2 }, { fetchImpl });
  assert.equal(result.status, "partial");
  assert.equal(requests, 1);
  assert.equal(result.archived, 0);
  assert.deepEqual(failures, ["direct_http_403"]);
  assert.equal(images.directSourceImageDrainExitCode(result), 2);
});

test("byte archive retains source provenance and fallback never invents image URLs", async () => {
  const writes: Array<{ key: string; options: R2PutOptions | undefined }> = [];
  const result = await archiveImageBytes({
    storage: { async put(key: string, _body: unknown, options?: R2PutOptions) { writes.push({ key, options }); } } as unknown as R2Bucket,
    source: "example_inventory", sourceListingId: "one", sourceUrl: queued.sourceUrl,
    body: gif, declaredContentType: "image/gif", acquisitionMethod: "direct",
  });
  assert.equal(result.sourceUrl, queued.sourceUrl);
  assert.equal(result.width, 1);
  assert.equal(writes[0]!.options?.customMetadata?.sourceUrl, queued.sourceUrl);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(selectPrimaryImageArchiveTarget({ sourceUrl: queued.sourceUrl, thumbnailUrl: null, previousDownloadErrorCode: "direct_http_404" }), { imageUrl: queued.sourceUrl });
  assert.equal(primaryImageFailureExhaustsArchiveTargets({ sourceUrl: queued.sourceUrl, thumbnailUrl: null, attemptedRepresentation: "canonical", errorCode: "direct_http_404" }), true);
  assert.equal(primaryImageFailureExhaustsArchiveTargets({ sourceUrl: queued.sourceUrl, thumbnailUrl: null, attemptedRepresentation: "canonical", errorCode: "direct_http_403" }), false);
  assert.throws(() => parseImageAcquisitionFailurePayload({ acquisitionMethod: "resolved_endpoint", errorCode: "resolved_listing_ended", message: "Ended" }), /browser or direct/);
  await assert.rejects(images.readBoundedSourceImage(new Response(gif, { headers: { "content-type": "image/jpeg" } })), /direct_signature_mismatch/);
});
