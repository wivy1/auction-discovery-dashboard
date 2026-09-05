import {
  readNightlyPerformanceFeatures,
  resolvePerformanceFeature,
  type NightlyPerformanceFeatures,
  type PerformanceFeatureDecision,
  type PerformanceFeatureName,
  type PerformanceFeatureReadiness,
} from "./features";
import {
  readCompactPipelineGenerationVector,
  type PipelineGenerationVector,
} from "./generations";
import { readPerformanceFeatureReadiness } from "./readiness";
import { getPerformanceComponentAuditDefinitionByFeature } from "./component-readiness";

export interface DatabasePerformanceFeatureDecision {
  readonly decision: PerformanceFeatureDecision;
  readonly readiness: PerformanceFeatureReadiness;
  readonly generationVector: PipelineGenerationVector | null;
}

/**
 * Central runtime decision for database-backed optimized paths. `off` and the
 * global kill switch return without a generation query. Other modes bind the
 * latest exact feature receipt to the compact current generation vector.
 */
export async function resolveDatabasePerformanceFeature(input: {
  readonly database: D1Database;
  readonly feature: PerformanceFeatureName;
  readonly derivationVersion: string;
  readonly implementationAvailable?: boolean;
  readonly features?: NightlyPerformanceFeatures;
}): Promise<DatabasePerformanceFeatureDecision> {
  const component = getPerformanceComponentAuditDefinitionByFeature(input.feature);
  const features = input.features ?? readNightlyPerformanceFeatures();
  if (features.forceCanonical || features.modes[input.feature] === "off") {
    return Object.freeze({
      decision: "canonical" as const,
      readiness: Object.freeze({
        ready: false,
        implementationAvailable: input.implementationAvailable ?? true,
        receiptIdentity: null,
      }),
      generationVector: null,
    });
  }
  if (component && input.derivationVersion !== component.derivationVersion) {
    if (features.modes[input.feature] === "on") {
      throw new Error(
        `${input.feature} mode on requires derivation ${component.derivationVersion}`,
      );
    }
    return Object.freeze({
      decision: "canonical" as const,
      readiness: Object.freeze({
        ready: false,
        implementationAvailable: input.implementationAvailable ?? true,
        receiptIdentity: null,
      }),
      generationVector: null,
    });
  }
  const generationVector = await readCompactPipelineGenerationVector(
    input.database,
  );
  const readiness = await readPerformanceFeatureReadiness({
    database: input.database,
    featureName: input.feature,
    derivationVersion: input.derivationVersion,
    generationVectorHash: generationVector.hash,
    implementationAvailable: input.implementationAvailable ?? true,
  });
  return Object.freeze({
    decision: resolvePerformanceFeature({
      features,
      feature: input.feature,
      readiness,
    }),
    readiness,
    generationVector,
  });
}
