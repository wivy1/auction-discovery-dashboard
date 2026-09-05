import type { PipelineWorkItem } from "../pipeline/work-queue";
import type { SourceAccessStateRow } from "../sources/access-state";
import type { SourceOrchestrationPolicy } from "../sources/orchestration";
import {
  PREPARATION_WORK_STAGES,
  type SchedulerCandidate,
  type SchedulerTimingEstimate,
  type SourceScheduleInput,
} from "./types";

const preparationStages = new Set<string>(PREPARATION_WORK_STAGES);
export const PRIMARY_IMAGE_SCHEDULER_LANE = "scheduler-primary-image-worker";
export const PREFERENCE_V2_SCHEDULER_LANE = "scheduler-preference-v2-worker";

export function preparationCandidateFromWorkItem(input: {
  readonly item: PipelineWorkItem;
  readonly policy: SourceOrchestrationPolicy;
  readonly timing: SchedulerTimingEstimate;
  readonly accessRows?: readonly SourceAccessStateRow[];
  readonly dependencyDepth?: number;
  readonly skippedRounds?: number;
  readonly enqueueOrder?: number;
}): SchedulerCandidate {
  if (!preparationStages.has(input.item.stage)) {
    throw new RangeError(`unsupported preparation stage ${input.item.stage}`);
  }
  if (input.item.sourceId !== input.policy.sourceId) {
    throw new RangeError("preparation work source does not match orchestration policy");
  }
  const isLocalSourceRelease = input.item.stage === "source_release";
  const isLocalPreferenceV2 = input.item.stage === "preference_v2_score";
  const access = isLocalSourceRelease || isLocalPreferenceV2
    ? { state: "ready" as const, reasonCode: null, nextEligibleAt: null }
    : effectiveAccess(
        input.policy.sourceId,
        [input.item.laneKey, ...input.policy.networkLanes],
        input.accessRows ?? [],
      );
  return Object.freeze({
    id: `work:${input.item.stage}:${input.item.subjectType}:${input.item.subjectId}`,
    kind: "preparation",
    sourceId: input.policy.sourceId,
    stage: input.item.stage,
    // Primary-image and Preference V2 callbacks each mutate through one local
    // singleton. Reserving overlapping batches before either serialized
    // callback completes can strand sibling claims, so every source shares the
    // stage's one scheduler lane.
    networkLanes: Object.freeze([
      input.item.stage === "primary_image"
        ? PRIMARY_IMAGE_SCHEDULER_LANE
        : isLocalPreferenceV2
        ? PREFERENCE_V2_SCHEDULER_LANE
        : input.item.laneKey,
    ]),
    dependencies: isLocalSourceRelease ? Object.freeze([]) : input.policy.dependencies,
    // Terminal ordering belongs to acquisition. Preparation is exposed only
    // after the runtime has accepted the exact terminal source vector.
    terminalDependencies: Object.freeze([]),
    dependencyDepth: input.dependencyDepth ??
      input.policy.dependencies.length + input.policy.terminalDependencies.length,
    priority: input.item.priority,
    fairnessQuantum: input.policy.fairnessQuantum,
    skippedRounds: input.skippedRounds ?? 0,
    enqueueOrder: input.enqueueOrder ?? 0,
    availableAt: input.item.availableAt,
    accessState: access.state,
    accessReasonCode: access.reasonCode,
    nextEligibleAt: access.nextEligibleAt,
    leaseExpiresAt: input.item.leaseExpiresAt,
    inputAttemptCount: input.item.inputAttemptCount,
    timing: input.timing,
    workItem: input.item,
    sourcePolicy: input.policy,
  });
}

export function sourceCandidateFromPolicy(input: SourceScheduleInput): SchedulerCandidate {
  const access = effectiveAccess(
    input.policy.sourceId,
    input.policy.networkLanes,
    input.accessRows,
  );
  return Object.freeze({
    id: `source:${input.policy.sourceId}`,
    kind: "source_acquisition",
    sourceId: input.policy.sourceId,
    stage: "source_acquisition",
    networkLanes: input.policy.networkLanes,
    dependencies: input.policy.dependencies.filter(
      (sourceId) => !input.completedSourceIds.has(sourceId),
    ),
    terminalDependencies: input.policy.terminalDependencies,
    dependencyDepth:
      input.policy.dependencies.length + input.policy.terminalDependencies.length,
    priority: input.policy.priority,
    fairnessQuantum: input.policy.fairnessQuantum,
    skippedRounds: input.skippedRounds ?? 0,
    enqueueOrder: input.enqueueOrder ?? input.policy.order,
    availableAt: input.availableAt,
    accessState: access.state,
    accessReasonCode: access.reasonCode,
    nextEligibleAt: access.nextEligibleAt,
    leaseExpiresAt: input.leaseExpiresAt ?? null,
    inputAttemptCount: input.inputAttemptCount ?? 0,
    timing: input.timing,
    sourcePolicy: input.policy,
  });
}

function effectiveAccess(
  sourceId: string,
  lanes: readonly string[],
  rows: readonly SourceAccessStateRow[],
): {
  readonly state: SchedulerCandidate["accessState"];
  readonly reasonCode: string | null;
  readonly nextEligibleAt: string | null;
} {
  const relevant = rows.filter((row) =>
    row.sourceId === sourceId && (lanes.includes(row.laneKey) || row.laneKey === "document")
  );
  const manual = relevant.find((row) => row.state === "manual_reset_required");
  const cooldowns = relevant.filter((row) =>
    row.state === "cooldown" &&
    (!("effectiveEligible" in row) || row.effectiveEligible !== true)
  );
  const row = manual ?? cooldowns.sort((left, right) =>
    (right.nextEligibleAt ?? "").localeCompare(left.nextEligibleAt ?? "")
  )[0];
  return {
    state: row?.state ?? "ready",
    reasonCode: row?.reasonCode ?? null,
    nextEligibleAt: row?.nextEligibleAt ?? null,
  };
}

export function sourceDependencyDepths(
  policies: readonly SourceOrchestrationPolicy[],
): ReadonlyMap<string, number> {
  const bySource = new Map<string, SourceOrchestrationPolicy>(
    policies.map((policy) => [policy.sourceId, policy]),
  );
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (sourceId: string): number => {
    const existing = depths.get(sourceId);
    if (existing !== undefined) return existing;
    if (visiting.has(sourceId)) throw new Error("source orchestration dependencies contain a cycle");
    visiting.add(sourceId);
    const policy = bySource.get(sourceId);
    if (!policy) throw new Error(`missing source orchestration policy for ${sourceId}`);
    const dependencies = [...policy.dependencies, ...policy.terminalDependencies];
    const depth = dependencies.length === 0
      ? 0
      : 1 + Math.max(...dependencies.map(visit));
    visiting.delete(sourceId);
    depths.set(sourceId, depth);
    return depth;
  };
  for (const policy of policies) visit(policy.sourceId);
  return depths;
}
