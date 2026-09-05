import type {
  SchedulerCandidate,
  SchedulerTimingEstimate,
} from "./types";

export type ScheduleStrategy = "critical_path" | "fixed_order";

export interface ScheduleSelection {
  readonly selected: readonly SchedulerCandidate[];
  readonly dependencyBlocked: readonly SchedulerCandidate[];
  readonly laneBlocked: readonly SchedulerCandidate[];
  readonly accessBlocked: readonly SchedulerCandidate[];
  readonly futureDeferred: readonly SchedulerCandidate[];
}

export interface ScheduleComparison {
  readonly strategy: ScheduleStrategy;
  readonly campaignWallTimeMs: number;
  readonly writerOccupancyMs: number;
  readonly completionOrder: readonly string[];
}

export function updateSchedulerEwma(input: {
  readonly previous: SchedulerTimingEstimate;
  readonly observed: Pick<
    SchedulerTimingEstimate,
    "requestEwmaMs" | "parseEwmaMs" | "callbackEwmaMs" | "commitEwmaMs"
  >;
  readonly alpha?: number;
}): SchedulerTimingEstimate {
  const alpha = input.alpha ?? 0.25;
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new RangeError("scheduler EWMA alpha must be greater than zero and at most one");
  }
  const blend = (previous: number, observed: number): number => {
    if (!Number.isFinite(observed) || observed < 0) {
      throw new RangeError("scheduler observed timing must be finite and nonnegative");
    }
    // A zero is the pre-observation sentinel, not a measured zero-duration
    // phase. Seed from the first real sample, then use the bounded EWMA.
    return previous === 0 ? observed : previous * (1 - alpha) + observed * alpha;
  };
  return Object.freeze({
    ...input.previous,
    requestEwmaMs: blend(input.previous.requestEwmaMs, input.observed.requestEwmaMs),
    parseEwmaMs: blend(input.previous.parseEwmaMs, input.observed.parseEwmaMs),
    callbackEwmaMs: blend(input.previous.callbackEwmaMs, input.observed.callbackEwmaMs),
    commitEwmaMs: blend(input.previous.commitEwmaMs, input.observed.commitEwmaMs),
  });
}

export function estimatedRemainingMs(timing: SchedulerTimingEstimate): number {
  const units = Math.max(timing.remainingRequests, timing.remainingPages, 1);
  return Math.max(0,
    units * (
      Math.max(timing.pacingFloorMs, timing.requestEwmaMs) +
      timing.parseEwmaMs
    ) + timing.callbackEwmaMs + timing.commitEwmaMs,
  );
}

export function criticalPathScore(candidate: SchedulerCandidate): number {
  const remaining = estimatedRemainingMs(candidate.timing);
  const dependencyMultiplier = 1 + Math.max(0, candidate.dependencyDepth) * 0.35;
  const retryPenalty = Math.min(candidate.inputAttemptCount, 8) * 0.03;
  return remaining * dependencyMultiplier * (1 - retryPenalty) +
    Math.max(0, candidate.priority) * 10;
}

export function selectScheduleBatch(input: {
  readonly candidates: readonly SchedulerCandidate[];
  readonly completedSourceIds: ReadonlySet<string>;
  readonly terminalSourceIds?: ReadonlySet<string>;
  readonly maxConcurrentNetworkJobs: number;
  readonly now: Date;
  readonly strategy?: ScheduleStrategy;
}): ScheduleSelection {
  const maximum = safeConcurrency(input.maxConcurrentNetworkJobs);
  const dependencyBlocked: SchedulerCandidate[] = [];
  const accessBlocked: SchedulerCandidate[] = [];
  const futureDeferred: SchedulerCandidate[] = [];
  const eligible: SchedulerCandidate[] = [];
  const nowMs = input.now.getTime();
  const terminalSourceIds = input.terminalSourceIds ?? input.completedSourceIds;
  for (const candidate of input.candidates) {
    if (
      !candidate.dependencies.every((sourceId) => input.completedSourceIds.has(sourceId)) ||
      !(candidate.terminalDependencies ?? []).every((sourceId) =>
        terminalSourceIds.has(sourceId)
      )
    ) {
      dependencyBlocked.push(candidate);
      continue;
    }
    if (candidate.accessState !== "ready") {
      accessBlocked.push(candidate);
      continue;
    }
    const effectiveAvailable = Math.max(
      Date.parse(candidate.availableAt),
      candidate.leaseExpiresAt === null ? 0 : Date.parse(candidate.leaseExpiresAt),
    );
    if (!Number.isFinite(effectiveAvailable) || effectiveAvailable > nowMs) {
      futureDeferred.push(candidate);
      continue;
    }
    eligible.push(candidate);
  }

  const ordered = [...eligible].sort((left, right) => {
    const leftFair = left.skippedRounds >= left.fairnessQuantum ? 1 : 0;
    const rightFair = right.skippedRounds >= right.fairnessQuantum ? 1 : 0;
    if (leftFair !== rightFair) return rightFair - leftFair;
    if ((input.strategy ?? "critical_path") === "critical_path") {
      const critical = criticalPathScore(right) - criticalPathScore(left);
      if (critical !== 0) return critical;
    }
    return left.enqueueOrder - right.enqueueOrder || left.id.localeCompare(right.id);
  });
  const selected: SchedulerCandidate[] = [];
  const laneBlocked: SchedulerCandidate[] = [];
  const usedLanes = new Set<string>();
  const usedSources = new Set<string>();
  for (const candidate of ordered) {
    if (selected.length >= maximum) break;
    if (
      usedSources.has(candidate.sourceId) ||
      candidate.networkLanes.some((lane) => usedLanes.has(lane))
    ) {
      laneBlocked.push(candidate);
      continue;
    }
    selected.push(candidate);
    usedSources.add(candidate.sourceId);
    for (const lane of candidate.networkLanes) usedLanes.add(lane);
  }
  for (const candidate of ordered) {
    if (!selected.includes(candidate) && !laneBlocked.includes(candidate)) {
      laneBlocked.push(candidate);
    }
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    dependencyBlocked: Object.freeze(dependencyBlocked),
    laneBlocked: Object.freeze(laneBlocked),
    accessBlocked: Object.freeze(accessBlocked),
    futureDeferred: Object.freeze(futureDeferred),
  });
}

/** Deterministic fixture simulator; it performs no I/O and skips no work. */
export function simulateSchedule(input: {
  readonly candidates: readonly SchedulerCandidate[];
  readonly strategy: ScheduleStrategy;
  readonly maxConcurrentNetworkJobs?: number;
}): ScheduleComparison {
  const maximum = safeConcurrency(input.maxConcurrentNetworkJobs ?? 3);
  const pending = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const completedSources = new Set<string>();
  const running: Array<{
    candidate: SchedulerCandidate;
    networkDoneAt: number;
  }> = [];
  const completionOrder: string[] = [];
  let clock = 0;
  let writerAvailableAt = 0;
  let writerOccupancyMs = 0;

  while (pending.size > 0 || running.length > 0) {
    const openCandidates = [...pending.values()];
    const usedLanes = new Set(running.flatMap((entry) => entry.candidate.networkLanes));
    const usedSources = new Set(running.map((entry) => entry.candidate.sourceId));
    const capacity = maximum - running.length;
    if (capacity > 0) {
      const selection = selectScheduleBatch({
        candidates: openCandidates.filter((candidate) =>
          !usedSources.has(candidate.sourceId) &&
          candidate.networkLanes.every((lane) => !usedLanes.has(lane))
        ),
        completedSourceIds: completedSources,
        terminalSourceIds: completedSources,
        maxConcurrentNetworkJobs: capacity,
        now: new Date(8_000_000_000_000_000),
        strategy: input.strategy,
      });
      for (const candidate of selection.selected) {
        pending.delete(candidate.id);
        const total = estimatedRemainingMs(candidate.timing);
        const networkMs = Math.max(0, total - candidate.timing.commitEwmaMs);
        running.push({ candidate, networkDoneAt: clock + networkMs });
        usedSources.add(candidate.sourceId);
        for (const lane of candidate.networkLanes) usedLanes.add(lane);
      }
    }
    if (running.length === 0) {
      if (pending.size > 0) {
        throw new Error("scheduler fixture contains an unsatisfied dependency cycle");
      }
      break;
    }
    running.sort((left, right) =>
      left.networkDoneAt - right.networkDoneAt ||
      left.candidate.enqueueOrder - right.candidate.enqueueOrder
    );
    const next = running.shift()!;
    clock = next.networkDoneAt;
    const commitStart = Math.max(clock, writerAvailableAt);
    writerAvailableAt = commitStart + next.candidate.timing.commitEwmaMs;
    writerOccupancyMs += next.candidate.timing.commitEwmaMs;
    clock = commitStart;
    completedSources.add(next.candidate.sourceId);
    completionOrder.push(next.candidate.id);
  }
  return Object.freeze({
    strategy: input.strategy,
    campaignWallTimeMs: Math.max(clock, writerAvailableAt),
    writerOccupancyMs,
    completionOrder: Object.freeze(completionOrder),
  });
}

function safeConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3) {
    throw new RangeError("scheduler concurrency must be an integer from 1 through 3");
  }
  return value;
}
