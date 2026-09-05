import type { SourceRegistration } from "../../lib/sources/registration.ts";
import type { SourceAdapter } from "../../lib/sources/types.ts";

const adapter: SourceAdapter = {
  manifest: {
    id: "example_inventory", displayName: "Example inventory", baseUrl: "https://inventory.example.test",
    inventoryScope: "current", transport: "json_api", implementationStatus: "ready", enabledByDefault: false,
    access: {
      permissionBasis: "official_public_api", termsUrl: null, robotsUrl: null,
      documentationUrls: ["https://inventory.example.test/docs"], reviewedAt: "2026-01-01",
      note: "Synthetic test adapter; all requests are mocked.",
    },
    requests: {
      allowedHosts: ["inventory.example.test"], allowedImageHosts: ["images.example.test"],
      minDelayMs: 0, maxRequestsPerRun: 10, timeoutMs: 1_000, maxRetries: 0,
      maxResponseBytes: 1_024, maxImageResponseBytes: 1_024, maxRedirects: 0,
    },
  },
  planDiscovery: () => [], parseDiscoveryPage: () => [], planDetail: () => null,
  parseDetailPage: () => { throw new Error("No detail page is requested by image tests."); },
};

export default [{ adapter }] satisfies readonly SourceRegistration[];
