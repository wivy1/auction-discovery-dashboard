import { findSourceAdapter } from "../sources/registry";
import { assertSourceAccess, type SourceAccessGrant } from "../sources/access";
import type { AcquiredSourcePage } from "../sources/acquired-pages";
import type { SourceAdapter, SourceRequest } from "../sources/types";

export interface GenericSourceAcquisitionPlan {
  readonly sourceId: string;
  readonly requests: readonly SourceRequest[];
  readonly maxPages: number;
  readonly maxRequests: number;
  readonly maxResponseBytes: number;
  readonly minDelayMs: number;
  readonly timeoutMs: number;
  readonly maxRunMs: number;
}

export function planGenericSourceAcquisition(
  sourceId: string,
  grant: SourceAccessGrant,
  adapter: SourceAdapter | undefined = findSourceAdapter(sourceId),
): GenericSourceAcquisitionPlan {
  if (!adapter || adapter.manifest.id !== sourceId || adapter.manifest.acquisition !== "isolated_browser" || adapter.manifest.transport !== "html") {
    throw new Error("A registered headless HTML source is required.");
  }
  assertSourceAccess(adapter.manifest, grant);
  const policy = adapter.manifest.requests;
  const requests = adapter.planDiscovery({ canary: false });
  if (requests.length < 1 || requests.length > 20 || new Set(requests.map((request) => request.url)).size !== requests.length || requests.some((request) => request.method || request.body || request.kind !== "discovery")) {
    throw new Error("Browser inventory requires 1-20 distinct planned GET documents.");
  }
  for (const request of requests) {
    const url = new URL(request.url);
    if (!policy.allowedHosts.includes(url.hostname) || url.username || url.password || url.hash || !["https:", "http:"].includes(url.protocol)) throw new Error("Browser document host or URL is not permitted.");
    const allowed = new Set((policy.allowedRequestHeaders ?? []).map((name) => name.toLowerCase()));
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (!allowed.has(name.toLowerCase()) || /^(cookie|host|origin|referer|content-length|connection|transfer-encoding)$/iu.test(name) || !/^[a-z0-9-]+$/iu.test(name) || typeof value !== "string" || /[\r\n\0]/u.test(value)) throw new Error("Browser request contains an unapproved header.");
    }
  }
  for (const [name, value, max] of [
    ["maxRequestsPerRun", policy.maxRequestsPerRun, 100],
    ["maxResponseBytes", policy.maxResponseBytes, 4 * 1024 * 1024],
    ["timeoutMs", policy.timeoutMs, 120_000],
    ["minDelayMs", policy.minDelayMs, 60_000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Browser ${name} is outside its supported bound.`);
  }
  if (requests.length * 2 > policy.maxRequestsPerRun) throw new Error("Browser document plan exceeds its request budget.");
  return {
    sourceId, requests, maxPages: requests.length,
    maxRequests: policy.maxRequestsPerRun,
    maxResponseBytes: policy.maxResponseBytes,
    minDelayMs: policy.minDelayMs,
    timeoutMs: policy.timeoutMs,
    maxRunMs: Math.min(10 * 60_000, requests.length * policy.timeoutMs + policy.maxRequestsPerRun * policy.minDelayMs),
  };
}

export function assertGenericCapturedHtml(body: string): void {
  if (/captcha|verify\s+(?:that\s+)?you\s+are\s+human|access\s+denied|checking\s+your\s+browser|unusual\s+traffic|cf-chl-|challenge-platform/iu.test(body)) {
    throw new Error("Source returned a denial or browser challenge.");
  }
}

export async function validateGenericAcquiredPages(
  plan: GenericSourceAcquisitionPlan,
  value: unknown,
  adapter: SourceAdapter | undefined = findSourceAdapter(plan.sourceId),
): Promise<readonly AcquiredSourcePage[]> {
  if (!adapter || !Array.isArray(value) || value.length !== plan.requests.length) throw new Error("Captured inventory does not match its registered plan.");
  let previousStart = -Infinity;
  let totalBytes = 0;
  const now = Date.now();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as AcquiredSourcePage;
    const expected = plan.requests[index]!;
    if (!entry || JSON.stringify(entry.request) !== JSON.stringify(expected) || !entry.page || entry.page.url !== expected.url || typeof entry.page.body !== "string" || entry.page.contentType !== "text/html" || entry.requestBudgetCost !== 2 || !Array.isArray(entry.requestStartedAt) || entry.requestStartedAt.length !== 1 || entry.startedAt !== entry.requestStartedAt[0]) {
      throw new Error("Captured document identity or accounting is invalid.");
    }
    const started = Date.parse(entry.startedAt);
    const fetched = Date.parse(entry.page.fetchedAt);
    if (!Number.isFinite(started) || !Number.isFinite(fetched) || started < previousStart + plan.minDelayMs || fetched < started || fetched > now + 5_000 || now - started > plan.maxRunMs + 60_000 || fetched - started > plan.timeoutMs) throw new Error("Captured document timing is invalid or stale.");
    previousStart = started;
    const bytes = new TextEncoder().encode(entry.page.body);
    totalBytes += bytes.byteLength;
    if (!bytes.byteLength || bytes.byteLength > plan.maxResponseBytes || totalBytes > 4 * 1024 * 1024) throw new Error("Captured HTML exceeds its byte budget.");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== entry.bodySha256) throw new Error("Captured HTML digest is invalid.");
    assertGenericCapturedHtml(entry.page.body);
    if (!adapter.parseDiscoveryBatch) throw new Error("Headless inventory requires a batch parser with inline details.");
    const rows = adapter.parseDiscoveryBatch(entry.page);
    if (rows.some((row) => !row.detail)) throw new Error("Headless inventory must supply inline source details.");
  }
  return value as AcquiredSourcePage[];
}


