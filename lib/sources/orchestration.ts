import { effectiveSourceAcquisition } from "./acquisition-access";
import { sourceRegistrations } from "./registry";
import type { SourceId } from "./types";

export const SOURCE_ORCHESTRATION_SCHEMA_VERSION = "auction-discovery-source-orchestration-v4" as const;

export interface SourceOrchestrationPolicy {
  readonly sourceId: SourceId;
  readonly order: number;
  readonly dependencies: readonly SourceId[];
  readonly terminalDependencies: readonly SourceId[];
  readonly campaignAcquisition: "direct" | "local_companion";
  readonly networkLanes: readonly string[];
  readonly completeCurrent: true;
  readonly priority: number;
  readonly fairnessQuantum: number;
  readonly documentPacingFloorMs: number;
  readonly requestBudgetCeiling: number;
}

export const sourceOrchestrationRegistry: readonly SourceOrchestrationPolicy[] = Object.freeze(
  sourceRegistrations.map(({ adapter, scheduling }, order) => Object.freeze({
    sourceId: adapter.manifest.id,
    order,
    dependencies: Object.freeze([...(scheduling?.dependencies ?? [])]),
    terminalDependencies: Object.freeze([...(scheduling?.terminalDependencies ?? [])]),
    campaignAcquisition: effectiveSourceAcquisition(adapter.manifest) === "isolated_browser" ? "local_companion" as const : "direct" as const,
    networkLanes: Object.freeze([...(scheduling?.networkLanes ?? [adapter.manifest.id])]),
    completeCurrent: true as const,
    priority: scheduling?.priority ?? order,
    fairnessQuantum: 1,
    documentPacingFloorMs: adapter.manifest.requests.minDelayMs,
    requestBudgetCeiling: adapter.manifest.requests.maxRequestsPerRun,
  })),
);

export function sourceOrchestrationPayload() {
  return Object.freeze({ schemaVersion: SOURCE_ORCHESTRATION_SCHEMA_VERSION, sources: sourceOrchestrationRegistry });
}
