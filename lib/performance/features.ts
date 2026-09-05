import { sourceRegistry } from "../sources/registry";
import type { SourceId } from "../sources/types";

export const PERFORMANCE_FEATURE_NAMES = [
  "operationalProjection",
  "queueBackedProximity",
  "globalPreparationScheduler",
  "enrichmentSessionResidency",
  "dirtyPreferenceV2Scoring",
  "unifiedSourceScheduler",
  "dashboardReleaseGenerations",
  "contentAddressedImageReuse",
] as const;

export type PerformanceFeatureName = typeof PERFORMANCE_FEATURE_NAMES[number];
export type PerformanceFeatureMode = "off" | "shadow" | "auto" | "on";
export type PerformanceFeatureDecision = "canonical" | "shadow" | "optimized";

export interface PerformanceFeatureReadiness {
  readonly ready: boolean;
  readonly implementationAvailable: boolean;
  readonly receiptIdentity?: string | null;
}

export interface NightlyPerformanceFeatures {
  readonly forceCanonical: boolean;
  readonly modes: Readonly<Record<PerformanceFeatureName, PerformanceFeatureMode>>;
  readonly frontierSourceModes: ReadonlyMap<SourceId, PerformanceFeatureMode>;
}

const FEATURE_ENV: Readonly<Record<PerformanceFeatureName, string>> = {
  operationalProjection: "PERF_OPERATIONAL_PROJECTION_MODE",
  queueBackedProximity: "PERF_QUEUE_BACKED_PROXIMITY_MODE",
  globalPreparationScheduler: "PERF_GLOBAL_PREPARATION_SCHEDULER_MODE",
  enrichmentSessionResidency: "PERF_ENRICHMENT_SESSION_RESIDENCY_MODE",
  dirtyPreferenceV2Scoring: "PERF_DIRTY_PREFERENCE_V2_SCORING_MODE",
  unifiedSourceScheduler: "PERF_UNIFIED_SOURCE_SCHEDULER_MODE",
  dashboardReleaseGenerations: "PERF_DASHBOARD_RELEASE_GENERATIONS_MODE",
  contentAddressedImageReuse: "PERF_CONTENT_ADDRESSED_IMAGE_REUSE_MODE",
};

export function readNightlyPerformanceFeatures(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): NightlyPerformanceFeatures {
  const modes: Record<PerformanceFeatureName, PerformanceFeatureMode> = {
    operationalProjection: parseOperationalProjectionMode(environment),
    queueBackedProximity: readMode(
      environment,
      FEATURE_ENV.queueBackedProximity,
      "PERF_QUEUE_BACKED_PROXIMITY",
    ),
    globalPreparationScheduler: readMode(
      environment,
      FEATURE_ENV.globalPreparationScheduler,
      "PERF_GLOBAL_PREPARATION_SCHEDULER",
    ),
    enrichmentSessionResidency: readMode(
      environment,
      FEATURE_ENV.enrichmentSessionResidency,
      "PERF_ENRICHMENT_SESSION_RESIDENCY",
    ),
    dirtyPreferenceV2Scoring: readMode(
      environment,
      FEATURE_ENV.dirtyPreferenceV2Scoring,
      "PERF_DIRTY_PREFERENCE_V2_SCORING",
    ),
    unifiedSourceScheduler: readMode(
      environment,
      FEATURE_ENV.unifiedSourceScheduler,
      "PERF_UNIFIED_SOURCE_SCHEDULER",
    ),
    dashboardReleaseGenerations: readMode(
      environment,
      FEATURE_ENV.dashboardReleaseGenerations,
      "PERF_DASHBOARD_RELEASE_GENERATIONS",
    ),
    contentAddressedImageReuse: readMode(
      environment,
      FEATURE_ENV.contentAddressedImageReuse,
      "PERF_CONTENT_ADDRESSED_IMAGE_REUSE",
    ),
  };
  if (
    modes.queueBackedProximity !== "off" &&
    modes.operationalProjection === "off"
  ) {
    throw new Error(
      "queue-backed proximity requires an operational projection mode",
    );
  }
  for (const [feature, message] of [
    [
      "dirtyPreferenceV2Scoring",
      "dirty Preference V2 scoring requires an operational projection mode",
    ],
    [
      "dashboardReleaseGenerations",
      "dashboard release generations require an operational projection mode",
    ],
    [
      "globalPreparationScheduler",
      "the global preparation scheduler requires an operational projection mode",
    ],
  ] as const) {
    if (modes[feature] !== "off" && modes.operationalProjection === "off") {
      throw new Error(message);
    }
  }
  if (
    modes.unifiedSourceScheduler !== "off" &&
    modes.globalPreparationScheduler === "off"
  ) {
    throw new Error(
      "the unified source scheduler requires the global preparation scheduler",
    );
  }
  return Object.freeze({
    forceCanonical: strictBoolean(environment.PERF_FORCE_CANONICAL),
    modes: Object.freeze(modes),
    frontierSourceModes: parseFrontierSourceModes(environment),
  });
}

export function resolvePerformanceFeature(input: {
  readonly features: NightlyPerformanceFeatures;
  readonly feature: PerformanceFeatureName;
  readonly readiness: PerformanceFeatureReadiness;
}): PerformanceFeatureDecision {
  if (input.features.forceCanonical) return "canonical";
  const mode = input.features.modes[input.feature];
  if (mode === "off") return "canonical";
  if (!input.readiness.implementationAvailable) {
    if (mode === "shadow") return "canonical";
    throw new Error(`${input.feature} implementation is unavailable`);
  }
  if (mode === "shadow") return "shadow";
  if (mode === "auto") {
    return input.readiness.ready && input.readiness.receiptIdentity?.trim()
      ? "optimized"
      : "canonical";
  }
  if (!input.readiness.ready || !input.readiness.receiptIdentity?.trim()) {
    throw new Error(`${input.feature} mode on requires a readiness receipt`);
  }
  return "optimized";
}

export function resolveSourceFrontierMode(input: {
  readonly sourceId: SourceId;
  readonly features: NightlyPerformanceFeatures;
  readonly readiness: PerformanceFeatureReadiness;
}): PerformanceFeatureDecision {
  if (input.features.forceCanonical) return "canonical";
  const mode = input.features.frontierSourceModes.get(input.sourceId) ?? "off";
  if (mode === "off") return "canonical";
  if (!input.readiness.implementationAvailable) {
    if (mode === "shadow") return "canonical";
    throw new Error(`${input.sourceId} frontier implementation is unavailable`);
  }
  if (mode === "shadow") return "shadow";
  if (mode === "auto") {
    return input.readiness.ready && input.readiness.receiptIdentity?.trim()
      ? "optimized"
      : "canonical";
  }
  if (!input.readiness.ready || !input.readiness.receiptIdentity?.trim()) {
    throw new Error(`${input.sourceId} frontier mode on requires a readiness receipt`);
  }
  return "optimized";
}

/** Compatibility predicate; production callers should use resolveSourceFrontierMode. */
export function isSourceFrontierEnabled(
  sourceId: SourceId,
  features = readNightlyPerformanceFeatures(),
): boolean {
  return features.frontierSourceModes.get(sourceId) === "on";
}

function parseOperationalProjectionMode(
  environment: Readonly<Record<string, string | undefined>>,
): PerformanceFeatureMode {
  const explicit = environment[FEATURE_ENV.operationalProjection];
  if (explicit?.trim()) {
    return parsedMode(explicit, FEATURE_ENV.operationalProjection);
  }
  const reads = strictBoolean(environment.PERF_OPERATIONAL_PROJECTION_READS);
  const shadows = strictBoolean(
    environment.PERF_OPERATIONAL_PROJECTION_SHADOW_READS,
  );
  const dualWrites = strictBoolean(
    environment.PERF_OPERATIONAL_PROJECTION_DUAL_WRITES,
  );
  if ((reads || shadows) && !dualWrites) {
    throw new Error(
      "operational projection reads require projection dual writes",
    );
  }
  return reads ? "on" : shadows || dualWrites ? "shadow" : "auto";
}

function readMode(
  environment: Readonly<Record<string, string | undefined>>,
  modeName: string,
  legacyBooleanName: string,
): PerformanceFeatureMode {
  const explicit = environment[modeName];
  if (explicit?.trim()) return parsedMode(explicit, modeName);
  return strictBoolean(environment[legacyBooleanName]) ? "on" : "auto";
}

function parseFrontierSourceModes(
  environment: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<SourceId, PerformanceFeatureMode> {
  const result = new Map<SourceId, PerformanceFeatureMode>();
  for (const entry of commaSeparated(environment.PERF_FRONTIER_SOURCE_MODES)) {
    const separator = entry.indexOf("=");
    if (separator < 1 || separator === entry.length - 1) {
      throw new Error(
        "PERF_FRONTIER_SOURCE_MODES entries must be source_id=mode",
      );
    }
    const sourceId = entry.slice(0, separator).trim();
    if (!sourceRegistry.has(sourceId as SourceId)) {
      throw new Error(`PERF_FRONTIER_SOURCE_MODES contains unknown source ${sourceId}`);
    }
    if (result.has(sourceId as SourceId)) {
      throw new Error(`PERF_FRONTIER_SOURCE_MODES repeats source ${sourceId}`);
    }
    result.set(
      sourceId as SourceId,
      parsedMode(entry.slice(separator + 1), "PERF_FRONTIER_SOURCE_MODES"),
    );
  }
  for (const sourceId of commaSeparated(environment.PERF_FRONTIER_SOURCE_IDS)) {
    if (!sourceRegistry.has(sourceId as SourceId)) {
      throw new Error(`PERF_FRONTIER_SOURCE_IDS contains unknown source ${sourceId}`);
    }
    if (!result.has(sourceId as SourceId)) {
      result.set(sourceId as SourceId, "on");
    }
  }
  return result;
}

function parsedMode(value: string, name: string): PerformanceFeatureMode {
  const normalized = value.trim().toLowerCase();
  if (
    normalized !== "off" &&
    normalized !== "shadow" &&
    normalized !== "auto" &&
    normalized !== "on"
  ) {
    throw new Error(`${name} must be off, shadow, auto, or on`);
  }
  return normalized;
}

function strictBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

function commaSeparated(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}
