import assert from "node:assert/strict";
import test from "node:test";
import { createJsonApiSource } from "../../lib/sources/json-api";
import { ConservativeRequestController } from "../../lib/sources/request-control";
import { SourceAccessChallengeError, type SourceAccessPolicy } from "../../lib/sources/types";
import { evaluateSourcePermission } from "../../lib/sources/access";
import { sourceRegistrationAccessGrant, validateSourceRegistrations } from "../../lib/sources/registration";

const reviewed: SourceAccessPolicy = { permissionBasis: "recorded_permission", permissionReference: "synthetic-test-permission", permissionRecordedAt: "2026-01-01T00:00:00.000Z",
  termsUrl: null, robotsUrl: null, documentationUrls: [], reviewedAt: "2026-01-01T00:00:00.000Z", note: "Synthetic fixture only" };
function adapter(id: string, requests = {}) {
  return createJsonApiSource({ id, displayName: id, baseUrl: "https://api.example.com/", inventoryUrl: "https://api.example.com/current", inlineDetails: true,
    access: reviewed, requests: { minDelayMs: 1, ...requests }, mapListing: () => { throw new Error("No rows expected"); } });
}

test("disabled and unapproved hosts are rejected before network access", async () => {
  const source = adapter("access_disabled"); let fetches = 0;
  const fetch = async () => { fetches++; return new Response("[]"); };
  await assert.rejects(new ConservativeRequestController(source.manifest, { enabled: false }, { fetch }).fetchPage(source.planDiscovery()[0]!), /source_disabled/);
  await assert.rejects(new ConservativeRequestController(source.manifest, { enabled: true }, { fetch }).fetchPage({ kind: "discovery", url: "https://unlisted.example.net/" }), /allowed host/);
  await assert.rejects(new ConservativeRequestController(source.manifest, { enabled: true }, { fetch }).fetchPage({ kind: "discovery", url: "https://name:secret@api.example.com/current" }), /without credentials/);
  assert.equal(fetches, 0);
});

test("denials and rate limits stop after one request even when retries are configured", async () => {
  for (const status of [401, 403, 429]) {
    const source = adapter(`access_status_${status}`, { maxRetries: 2 }); let fetches = 0;
    const controller = new ConservativeRequestController(source.manifest, { enabled: true }, { fetch: async () => { fetches++; return new Response("denied", { status, headers: { "retry-after": "7" } }); } });
    await assert.rejects(controller.fetchPage(source.planDiscovery()[0]!), (error: unknown) => error instanceof SourceAccessChallengeError && error.status === status && error.retryAfterMs === 7000);
    assert.equal(fetches, 1);
  }
});

test("request-start pacing and the manifest budget are enforced across queued requests", async () => {
  const source = adapter("access_pacing", { minDelayMs: 100, maxRequestsPerRun: 2 });
  let time = Date.parse("2026-09-05T12:00:00.000Z"); const starts: number[] = [];
  const controller = new ConservativeRequestController(source.manifest, { enabled: true }, { now: () => time, sleep: async (delay) => { time += delay; }, fetch: async () => { starts.push(time); return new Response("[]"); } });
  await Promise.all([controller.fetchPage(source.planDiscovery()[0]!), controller.fetchPage(source.planDiscovery()[0]!)]);
  assert.equal(starts[1]! - starts[0]!, 100);
  await assert.rejects(controller.fetchPage(source.planDiscovery()[0]!), /budget|limit/i);
  assert.equal(starts.length, 2);
});

test("headers require explicit permission and secrets are stripped on cross-origin redirects", async () => {
  const source = adapter("access_headers", { allowedRequestHeaders: ["authorization"], allowedRedirectHosts: ["redirect.example.com"], maxRedirects: 1 });
  const seen: Headers[] = [];
  const controller = new ConservativeRequestController(source.manifest, { enabled: true }, { fetch: async (_url, init) => {
    seen.push(new Headers(init?.headers));
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: "https://redirect.example.com/current" } }) : new Response("[]");
  } });
  await controller.fetchPage({ ...source.planDiscovery()[0]!, headers: { authorization: "synthetic-token" } });
  assert.equal(seen[0]!.get("authorization"), "synthetic-token");
  assert.equal(seen[1]!.get("authorization"), null);
  await assert.rejects(controller.fetchPage({ ...source.planDiscovery()[0]!, headers: { cookie: "synthetic-cookie" } }), /unapproved header/);
});

test("streamed response bytes and request timeouts remain bounded", async () => {
  const bounded = adapter("access_bytes", { maxResponseBytes: 4 });
  await assert.rejects(new ConservativeRequestController(bounded.manifest, { enabled: true }, { fetch: async () => new Response("12345") }).fetchPage(bounded.planDiscovery()[0]!), /byte limit/);
  const timed = adapter("access_timeout", { timeoutMs: 10 });
  await assert.rejects(new ConservativeRequestController(timed.manifest, { enabled: true }, { fetch: async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true })) }).fetchPage(timed.planDiscovery()[0]!), /Timed out|abort|timeout/i);
});

test("approved redirect hosts do not permit credentials, non-default ports or fragments", async () => {
  for (const location of ["https://name:secret@redirect.example.com/current", "https://redirect.example.com:444/current", "https://redirect.example.com/current#fragment"]) {
    const source = adapter("access_redirect", { allowedRedirectHosts: ["redirect.example.com"], maxRedirects: 1 });
    let fetches = 0;
    const controller = new ConservativeRequestController(source.manifest, { enabled: true }, { fetch: async () => {
      fetches++;
      return fetches === 1 ? new Response(null, { status: 302, headers: { location } }) : new Response("[]");
    } });
    await assert.rejects(controller.fetchPage(source.planDiscovery()[0]!), /without credentials/);
    assert.equal(fetches, 1);
  }
});

test("manual source permission needs current operator evidence and registration IDs/dependencies are validated", () => {
  const source = adapter("access_review");
  const manual = { ...source.manifest, access: { ...source.manifest.access, permissionBasis: "manual_review_required" as const,
    permissionReference: undefined, permissionRecordedAt: undefined } };
  const registration = { adapter: source, manualReview: { decision: "approved" as const, termsReviewedAt: "2026-01-02T00:00:00.000Z", robotsReviewedAt: "2026-01-02T00:00:00.000Z", evidence: "Synthetic review evidence" } };
  assert.equal(evaluateSourcePermission(manual, sourceRegistrationAccessGrant(registration, true)).allowed, true);
  assert.equal(evaluateSourcePermission(manual, sourceRegistrationAccessGrant({ ...registration,
    manualReview: { ...registration.manualReview, termsReviewedAt: "2026-99-99T00:00:00.000Z" } }, true)).allowed, false);
  assert.equal(evaluateSourcePermission({ ...manual, access: { ...manual.access, reviewedAt: "" } }, sourceRegistrationAccessGrant(registration, true)).allowed, false);
  assert.equal(sourceRegistrationAccessGrant(undefined, true).enabled, false);
  assert.throws(() => validateSourceRegistrations([registration, registration]), /Duplicate/);
  assert.throws(() => validateSourceRegistrations([{ ...registration, scheduling: { dependencies: ["missing"] } }]), /earlier/);
  assert.equal(validateSourceRegistrations([registration]).length, 1);
});
