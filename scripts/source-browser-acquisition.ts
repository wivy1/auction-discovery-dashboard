import { chromium, type Browser } from "playwright";
import { setTimeout as pause } from "node:timers/promises";
import { findSourceAdapter } from "../lib/sources/registry";
import type { SourceAdapter } from "../lib/sources/types";
import type { AcquiredSourcePage } from "../lib/sources/acquired-pages";
import { assertGenericCapturedHtml, validateGenericAcquiredPages, type GenericSourceAcquisitionPlan } from "../lib/pipeline/source-acquisition";

export interface BrowserCaptureOptions {
  readonly signal?: AbortSignal;
  /** Dependency injection is restricted to local fixture tests, never HTTP input. */
  readonly adapter?: SourceAdapter;
  readonly launch?: () => Promise<Browser>;
}

export class BrowserCleanupError extends Error {
  constructor() { super("Browser cleanup failed; restart the companion before another capture."); this.name = "BrowserCleanupError"; }
}

/** Disposable ordinary Chromium. No profiles, stealth, retries or remote controls. */
export async function captureGenericSourcePages(plan: GenericSourceAcquisitionPlan, options: BrowserCaptureOptions = {}): Promise<readonly AcquiredSourcePage[]> {
  const adapter = options.adapter ?? findSourceAdapter(plan.sourceId);
  if (!adapter || adapter.manifest.id !== plan.sourceId || adapter.manifest.acquisition !== "isolated_browser") throw new Error("Unknown registered browser source.");
  if (JSON.stringify(adapter.planDiscovery({ canary: false })) !== JSON.stringify(plan.requests)) throw new Error("Browser plan differs from registered inventory requests.");
  const policy = adapter.manifest.requests;
  if (plan.maxRequests !== policy.maxRequestsPerRun || plan.maxResponseBytes !== policy.maxResponseBytes || plan.minDelayMs !== policy.minDelayMs || plan.timeoutMs !== policy.timeoutMs || plan.maxPages !== plan.requests.length || plan.maxRunMs !== Math.min(10 * 60_000, plan.requests.length * policy.timeoutMs + policy.maxRequestsPerRun * policy.minDelayMs)) throw new Error("Browser budget differs from the registered plan.");
  options.signal?.throwIfAborted();
  const browser = await (options.launch?.() ?? chromium.launch({ headless: true, timeout: Math.min(plan.maxRunMs, 30_000) }));
  const shutdown = new AbortController();
  let failure: Error | null = null;
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
  // The race below observes cancellation while browser operations are pending.
  const stop = (error: Error) => {
    if (failure) return;
    failure = error;
    shutdown.abort();
    rejectStop(error);
    void browser.close().catch(() => undefined);
  };
  const abort = () => stop(new Error("Browser acquisition cancelled."));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => stop(new Error("Browser acquisition exceeded its run time budget.")), plan.maxRunMs);
  const work = async () => {
  options.signal?.throwIfAborted();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    await session.send("Network.enable");
    let networkBytes = 0;
    const responseBytes = new Map<string, number>();
    session.on("Network.dataReceived", (event) => {
      networkBytes += event.dataLength;
      const size = (responseBytes.get(event.requestId) ?? 0) + event.dataLength;
      responseBytes.set(event.requestId, size);
      if (size > plan.maxResponseBytes || networkBytes > 16 * 1024 * 1024) stop(new Error("Browser response exceeded its byte budget."));
    });
    let starts = 0;
    let lastStart = -Infinity;
    let startQueue = Promise.resolve();
    let expectedUrl = "";
    let documentStarted = "";
    let documentRequested = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      try {
        if (failure) return await route.abort();
        if (request.redirectedFrom()) throw new Error("Browser redirects are not permitted.");
        const frame = request.frame();
        if (frame !== page.mainFrame()) throw new Error("Browser frame requests are not permitted.");
        const document = request.isNavigationRequest();
        if (document) {
          if (documentRequested || request.url() !== expectedUrl || request.method() !== "GET") throw new Error("Browser attempted an unplanned document.");
          documentRequested = true;
        } else {
          assertBrowserResourceAllowed(adapter, request.url(), request.method(), request.resourceType());
        }
        const previous = startQueue;
        let release!: () => void;
        startQueue = new Promise<void>((resolve) => { release = resolve; });
        await previous;
        try {
          if (failure) return await route.abort();
          if (++starts > plan.maxRequests) throw new Error("Browser exceeded its request count budget.");
          const delay = Math.max(0, lastStart + plan.minDelayMs - Date.now());
          if (delay) await pause(delay, undefined, { signal: shutdown.signal });
          if (failure) return await route.abort();
          lastStart = Date.now();
          if (document) documentStarted = new Date(lastStart).toISOString();
          const planned = plan.requests.find((entry) => entry.url === expectedUrl)!;
          await route.fallback(document && planned.headers ? { headers: { ...request.headers(), ...planned.headers } } : undefined);
        } finally { release(); }
      } catch (error) {
        stop(error instanceof Error ? error : new Error("Browser access policy failed."));
        await route.abort().catch(() => undefined);
      }
    });
    page.on("response", (response) => {
      const status = response.status();
      if (status < 200 || status >= 300) stop(new Error(`Browser source returned HTTP ${status}.`));
      const declared = Number(response.headers()["content-length"]);
      if (declared > plan.maxResponseBytes) stop(new Error("Browser response exceeds its declared byte budget."));
    });
    await context.routeWebSocket("**/*", (socket) => {
      stop(new Error("Browser WebSocket access is not permitted."));
      socket.close();
    });
    page.on("worker", () => stop(new Error("Browser worker execution is not permitted.")));
    page.on("download", () => stop(new Error("Browser downloads are not permitted.")));
    context.on("page", (opened) => { if (opened !== page) stop(new Error("Browser popups are not permitted.")); });
    const captured: AcquiredSourcePage[] = [];
    let capturedBytes = 0;
    for (const request of plan.requests) {
      expectedUrl = request.url;
      documentRequested = false;
      documentStarted = "";
      const pageTimer = setTimeout(() => stop(new Error("Browser document exceeded its time budget.")), plan.timeoutMs);
      try {
        const response = await page.goto(request.url, { waitUntil: "networkidle", timeout: plan.timeoutMs });
        if (!response || page.url() !== request.url || !/^(text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(response.headers()["content-type"] ?? "")) throw new Error("Browser document is not the planned HTML page.");
        if (adapter.browser?.readySelector) await page.locator(adapter.browser.readySelector).waitFor({ state: "attached", timeout: plan.timeoutMs });
        const body = await page.content();
        assertGenericCapturedHtml(body);
        const bytes = new TextEncoder().encode(body);
        capturedBytes += bytes.byteLength;
        if (bytes.byteLength > plan.maxResponseBytes || capturedBytes > 4 * 1024 * 1024) throw new Error("Captured HTML exceeds its byte budget.");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        captured.push({ request, page: { url: request.url, body, fetchedAt: new Date().toISOString(), contentType: "text/html" }, startedAt: documentStarted, requestStartedAt: [documentStarted], requestBudgetCost: 2, bodySha256: Buffer.from(digest).toString("hex") });
      } finally { clearTimeout(pageTimer); }
    }
    return validateGenericAcquiredPages(plan, captured, adapter);
  };
  try {
    return await Promise.race([work(), stopped]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    shutdown.abort();
    try { await browser.close(); } catch { throw new BrowserCleanupError(); }
  }
}

function assertBrowserResourceAllowed(adapter: SourceAdapter, url: string, method: string, resourceType: string): void {
  const policy = adapter.manifest.requests;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash || !(policy.allowedBrowserRequests ?? []).some((rule) => rule.host === parsed.hostname && rule.path === parsed.pathname + parsed.search && rule.method === method && rule.resourceType === resourceType)) {
    throw new Error("Browser attempted an unlisted resource host, path, method or type.");
  }
}





