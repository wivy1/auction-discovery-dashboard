import vinext from "vinext";
import { defineConfig } from "vite";
import { vinextFontUrls } from "./build/vinext-font-urls";
import {
  isRuntimeRevision,
  isSupervisorInstanceId,
} from "./lib/runtime-revision";

const LOCAL_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const localCompanionCapability =
  process.env.AUCTION_DISCOVERY_IMAGE_TOKEN?.trim() ?? "";
const localRuntimeRevision =
  process.env.AUCTION_DISCOVERY_RUNTIME_REVISION?.trim() ?? "";
if (localRuntimeRevision && !isRuntimeRevision(localRuntimeRevision)) {
  throw new Error("AUCTION_DISCOVERY_RUNTIME_REVISION is malformed");
}
const localSupervisorInstanceId =
  process.env.AUCTION_DISCOVERY_SUPERVISOR_INSTANCE_ID?.trim() ?? "";
if (
  localSupervisorInstanceId &&
  !isSupervisorInstanceId(localSupervisorInstanceId)
) {
  throw new Error("AUCTION_DISCOVERY_SUPERVISOR_INSTANCE_ID is malformed");
}
const adhocReviewCohortId =
  process.env.ADHOC_REVIEW_COHORT_ID?.trim() ?? "";
const pipelineMaxImageDownloads =
  process.env.PIPELINE_MAX_IMAGE_DOWNLOADS?.trim() ?? "";
const pipelineMaxImageDownloadsOverride =
  process.env.PIPELINE_MAX_IMAGE_DOWNLOADS_OVERRIDE?.trim() ?? "";
const pipelinePreserveUnobservedCurrentListings =
  process.env.PIPELINE_PRESERVE_UNOBSERVED_CURRENT_LISTINGS?.trim() ?? "";
const performanceWorkerVariableNames = [
  "PERF_FORCE_CANONICAL",
  "PERF_OPERATIONAL_PROJECTION_MODE",
  "PERF_QUEUE_BACKED_PROXIMITY_MODE",
  "PERF_GLOBAL_PREPARATION_SCHEDULER_MODE",
  "PERF_ENRICHMENT_SESSION_RESIDENCY_MODE",
  "PERF_DIRTY_PREFERENCE_V2_SCORING_MODE",
  "PERF_UNIFIED_SOURCE_SCHEDULER_MODE",
  "PERF_DASHBOARD_RELEASE_GENERATIONS_MODE",
  "PERF_CONTENT_ADDRESSED_IMAGE_REUSE_MODE",
] as const;
const performanceWorkerVars = Object.fromEntries(
  performanceWorkerVariableNames.flatMap((name) => {
    const value = process.env[name]?.trim();
    return value ? [[name, value]] : [];
  }),
);

const localWorkerVars = {
  ...(localCompanionCapability.length >= 32
    ? { AUCTION_DISCOVERY_IMAGE_TOKEN: localCompanionCapability }
    : {}),
  ...(adhocReviewCohortId
    ? { ADHOC_REVIEW_COHORT_ID: adhocReviewCohortId }
    : {}),
  ...(pipelineMaxImageDownloads
    ? { PIPELINE_MAX_IMAGE_DOWNLOADS: pipelineMaxImageDownloads }
    : {}),
  ...(pipelineMaxImageDownloadsOverride
    ? {
        PIPELINE_MAX_IMAGE_DOWNLOADS_OVERRIDE:
          pipelineMaxImageDownloadsOverride,
      }
    : {}),
  ...(pipelinePreserveUnobservedCurrentListings
    ? {
        PIPELINE_PRESERVE_UNOBSERVED_CURRENT_LISTINGS:
          pipelinePreserveUnobservedCurrentListings,
      }
    : {}),
  ...(localRuntimeRevision
    ? { AUCTION_DISCOVERY_RUNTIME_REVISION: localRuntimeRevision }
    : {}),
  ...(localSupervisorInstanceId
    ? {
        AUCTION_DISCOVERY_SUPERVISOR_INSTANCE_ID:
          localSupervisorInstanceId,
      }
    : {}),
  ...performanceWorkerVars,
};

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  ...(Object.keys(localWorkerVars).length > 0
    ? { vars: localWorkerVars }
    : {}),
  d1_databases: [
        {
          binding: "DB",
          database_name: "auction-discovery-d1",
          database_id: LOCAL_DATABASE_ID,
        },
      ],
  r2_buckets: [
        {
          binding: "STORAGE",
          bucket_name: "auction-discovery-r2",
        },
      ],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      port: 3000,
      strictPort: true,
      watch: {
        ignored: [
          "**/.wrangler/**",
          "**/.pnpm-store/**",
          "**/dist/**",
          "**/output/**",
          "**/outputs/**",
          "**/work/**",
        ],
      },
    },
    plugins: [
      vinext(),
      vinextFontUrls(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
