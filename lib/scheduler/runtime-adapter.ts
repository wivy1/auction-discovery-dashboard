import { sourceOrchestrationRegistry } from "../sources/orchestration";
import { createSchedulerHandlerRegistry } from "./handler-registry";
import {
  PREPARATION_WORK_STAGES,
  type SchedulerAcquiredBundle,
  type SchedulerCandidate,
  type SchedulerHandler,
  type SchedulerHandlerRegistry,
  type SchedulerReservation,
  type SchedulerSnapshot,
  type SchedulerExecutionEvidence,
  type SchedulerSourceCampaignOutcome,
  type SchedulerSourceHeadEvidence,
  type SchedulerWorkOutcome,
  type SchedulerWorkSource,
} from "./types";

export const NIGHTLY_SCHEDULER_ADAPTER_SCHEMA_VERSION =
  "auction-discovery-nightly-scheduler-adapter-v1" as const;
export const LOCAL_SCHEDULER_SOURCE_ID = "scheduler_local" as const;

export type SchedulerAdapterAction =
  | "reserve"
  | "acquire"
  | "validate"
  | "commit"
  | "abort_reserve_before_callback"
  | "abort_before_callback"
  | "reconcile_callback"
  | "transition_to_preparation"
  | "record_execution_evidence";

/**
 * Typed boundary for the Worker-owned queue/reservation implementation. The
 * scheduler owns ordering and lane selection; the adapter owns exact durable
 * claims, source I/O, validation, and commits.
 */
export interface NightlySchedulerRuntimeAdapter {
  readSnapshot(): Promise<SchedulerSnapshot>;
  reserve(candidate: SchedulerCandidate): Promise<SchedulerReservation>;
  acquire(
    candidate: SchedulerCandidate,
    reservation: SchedulerReservation,
  ): Promise<unknown>;
  validate(
    candidate: SchedulerCandidate,
    reservation: SchedulerReservation,
    acquired: unknown,
  ): Promise<SchedulerAcquiredBundle>;
  commit(
    candidate: SchedulerCandidate,
    reservation: SchedulerReservation,
    bundle: SchedulerAcquiredBundle,
  ): Promise<SchedulerWorkOutcome>;
  recordExecutionEvidence(
    evidence: SchedulerExecutionEvidence,
    completedAt: string,
  ): Promise<void>;
  transitionToPreparation?(
    sourceOutcomes: readonly SchedulerSourceCampaignOutcome[],
  ): Promise<void>;
}

/**
 * Registers every source and supported preparation stage from the canonical
 * orchestration registry. No source ordering or dependency list is repeated
 * here; candidates carry the registry-derived policy used by selection.
 */
export function createRuntimeAdapterHandlerRegistry(
  adapter: NightlySchedulerRuntimeAdapter,
): SchedulerHandlerRegistry {
  const handlers: SchedulerHandler[] = [];
  for (const policy of sourceOrchestrationRegistry) {
    handlers.push(adapterHandler(`source:${policy.sourceId}`, adapter));
    for (const stage of PREPARATION_WORK_STAGES) {
      handlers.push(adapterHandler(
        `preparation:${policy.sourceId}:${stage}`,
        adapter,
      ));
    }
  }
  for (const stage of PREPARATION_WORK_STAGES) {
    handlers.push(adapterHandler(
      `preparation:${LOCAL_SCHEDULER_SOURCE_ID}:${stage}`,
      adapter,
    ));
  }
  return createSchedulerHandlerRegistry(handlers);
}

function adapterHandler(
  id: string,
  adapter: NightlySchedulerRuntimeAdapter,
): SchedulerHandler {
  const handler: SchedulerHandler = {
    id,
    ready: true,
    readinessReasonCode: null,
    reserve: (candidate) => adapter.reserve(candidate),
    acquire: (candidate, reservation) => adapter.acquire(candidate, reservation),
    validate: (candidate, reservation, acquired) =>
      adapter.validate(candidate, reservation, acquired),
    commit: (candidate, reservation, bundle) =>
      adapter.commit(candidate, reservation, bundle),
  };
  return Object.freeze(handler);
}

export interface CanonicalCompatibilityRuntime {
  readonly workSource: SchedulerWorkSource;
  readonly handlerRegistry: SchedulerHandlerRegistry;
}

const TERMINAL_SOURCE_OUTCOMES = new Set([
  "refreshed",
  "skipped_recent",
  "preserved",
  "paused",
  "stopped",
  "blocked",
] as const);
const SOURCE_OUTCOME_KEYS = Object.freeze([
  "sourceId",
  "outcome",
  "dependencySatisfied",
  "reasonCode",
  "priorHead",
  "resultingHead",
  "nextEligibleAt",
  "proofIdentity",
  "receiptIdentity",
]);

/**
 * Strictly validates the invocation-local terminal vector before the Worker
 * narrows an authorized source campaign into preparation-only work.
 */
export function parseExactTerminalSourceOutcomes(
  value: unknown,
  expectedSourceIds: readonly string[] = sourceOrchestrationRegistry.map((policy) => policy.sourceId),
): readonly SchedulerSourceCampaignOutcome[] {
  if (!Array.isArray(value) || value.length !== expectedSourceIds.length) {
    throw new TypeError("the complete terminal source outcome vector is required");
  }
  const outcomes = value.map((candidate, index) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, SOURCE_OUTCOME_KEYS)) {
      throw new TypeError("the terminal source outcome vector is invalid");
    }
    const sourceId = expectedSourceIds[index]!;
    const outcome = candidate.outcome;
    const refreshed = outcome === "refreshed";
    const skippedRecent = outcome === "skipped_recent";
    const verified = refreshed || skippedRecent;
    const paused = outcome === "paused";
    const priorHead = parseSourceHeadEvidence(candidate.priorHead);
    const resultingHead = parseSourceHeadEvidence(candidate.resultingHead);
    if (
      candidate.sourceId !== sourceId ||
      typeof outcome !== "string" ||
      !TERMINAL_SOURCE_OUTCOMES.has(
        outcome as SchedulerSourceCampaignOutcome["outcome"],
      ) ||
      candidate.dependencySatisfied !== verified ||
      !isSafeReasonCode(candidate.reasonCode) ||
      (skippedRecent && candidate.reasonCode !== "recent_verified_publication") ||
      priorHead === undefined || resultingHead === undefined ||
      (outcome === "preserved" && priorHead === null) ||
      (resultingHead !== null) !== verified ||
      (skippedRecent && (
        priorHead === null || resultingHead === null ||
        priorHead.inventoryRunId !== resultingHead.inventoryRunId ||
        priorHead.listingCount !== resultingHead.listingCount
      )) ||
      (candidate.nextEligibleAt !== null) !== paused ||
      (paused && !isCanonicalTimestamp(candidate.nextEligibleAt)) ||
      (verified
        ? !isSafeIdentity(candidate.proofIdentity) ||
          !isSafeIdentity(candidate.receiptIdentity)
        : candidate.proofIdentity !== null || candidate.receiptIdentity !== null)
    ) {
      throw new TypeError("the terminal source outcome vector is invalid");
    }
    return Object.freeze({
      sourceId,
      outcome: outcome as SchedulerSourceCampaignOutcome["outcome"],
      dependencySatisfied: verified,
      reasonCode: candidate.reasonCode as string,
      priorHead,
      resultingHead,
      nextEligibleAt: candidate.nextEligibleAt as string | null,
      proofIdentity: candidate.proofIdentity as string | null,
      receiptIdentity: candidate.receiptIdentity as string | null,
    });
  });
  return Object.freeze(outcomes);
}

/**
 * Rollback path for a runtime that has not yet exposed queue claims. One
 * existing composite complete-current callback owns its whole D1 mutation
 * interval, so the scheduler never overlaps it with another writer.
 */
export function createCanonicalCompatibilityRuntime(input: {
  readonly executeCampaign: () => Promise<SchedulerWorkOutcome>;
  readonly now?: () => Date;
}): CanonicalCompatibilityRuntime {
  const now = input.now ?? (() => new Date());
  let pending = true;
  let reads = 0;
  let candidate = canonicalCampaignCandidate(now());
  const workSource: SchedulerWorkSource = Object.freeze({
    async readSnapshot(): Promise<SchedulerSnapshot> {
      reads += 1;
      return Object.freeze({
        generation: `canonical-compatibility:${reads}:${pending ? "pending" : "complete"}`,
        candidates: pending ? Object.freeze([candidate]) : Object.freeze([]),
        boundedReadCount: 1,
      });
    },
  });
  const handler: SchedulerHandler = {
    id: `source:${candidate.sourceId}`,
    ready: true,
    readinessReasonCode: null,
    async reserve(selected) {
      if (!pending || selected.id !== candidate.id) {
        throw new Error("canonical compatibility candidate is no longer pending");
      }
      return Object.freeze({
        reservationId: `canonical:${selected.id}`,
        candidateId: selected.id,
        sourceId: selected.sourceId,
        laneKey: selected.networkLanes[0]!,
        inputRevision: 1,
        expiresAt: new Date(now().getTime() + 3 * 60 * 60 * 1_000).toISOString(),
        queueClaim: null,
        acquisitionClaim: null,
      });
    },
    async acquire(selected, reservation) {
      return Object.freeze({
        candidateId: selected.id,
        reservationId: reservation.reservationId,
      });
    },
    async validate(selected, reservation, acquired) {
      if (
        !isRecord(acquired) ||
        acquired.candidateId !== selected.id ||
        acquired.reservationId !== reservation.reservationId
      ) {
        throw new Error("canonical compatibility acquisition identity changed");
      }
      return Object.freeze({
        reservationId: reservation.reservationId,
        bundleIdentity: `canonical-bundle:${selected.id}`,
        responseHash: "canonical-callback-owned",
        contentHash: "canonical-callback-owned",
        validated: true,
        acquiredBundle: null,
        callback: Object.freeze({ kind: "local_commit" as const }),
      });
    },
    async commit() {
      const outcome = await input.executeCampaign();
      if (!outcome.remaining) pending = false;
      else if (outcome.classification === "retryable_pressure") {
        candidate = Object.freeze({
          ...candidate,
          availableAt: outcome.availableAt,
        });
      } else if (outcome.classification === "access_stop") {
        candidate = Object.freeze({
          ...candidate,
          accessState: outcome.availableAt === null
            ? "manual_reset_required" as const
            : "cooldown" as const,
          accessReasonCode: outcome.reasonCode,
          nextEligibleAt: outcome.availableAt,
        });
      }
      return outcome;
    },
  };
  return Object.freeze({
    workSource,
    handlerRegistry: createSchedulerHandlerRegistry([handler]),
  });
}

function canonicalCampaignCandidate(now: Date): SchedulerCandidate {
  return Object.freeze({
    id: "canonical:complete-current-campaign",
    kind: "source_acquisition",
    sourceId: "canonical_complete_current_campaign",
    stage: "source_acquisition",
    networkLanes: Object.freeze(["canonical-composite-writer"]),
    dependencies: Object.freeze([]),
    dependencyDepth: 0,
    priority: 0,
    fairnessQuantum: 1,
    skippedRounds: 0,
    enqueueOrder: 0,
    availableAt: now.toISOString(),
    accessState: "ready",
    accessReasonCode: null,
    nextEligibleAt: null,
    leaseExpiresAt: null,
    inputAttemptCount: 0,
    timing: Object.freeze({
      remainingRequests: 1,
      remainingPages: 1,
      pacingFloorMs: 0,
      requestEwmaMs: 0,
      parseEwmaMs: 0,
      callbackEwmaMs: 0,
      commitEwmaMs: 0,
    }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function parseSourceHeadEvidence(
  value: unknown,
): SchedulerSourceHeadEvidence | null | undefined {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["inventoryRunId", "listingCount"]) ||
    !isSafeIdentity(value.inventoryRunId, 512) ||
    !Number.isSafeInteger(value.listingCount) ||
    Number(value.listingCount) < 0 || Number(value.listingCount) > 1_000_000
  ) return undefined;
  return Object.freeze({
    inventoryRunId: value.inventoryRunId,
    listingCount: Number(value.listingCount),
  });
}

function isSafeReasonCode(value: unknown): value is string {
  return typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(value);
}

function isSafeIdentity(value: unknown, maximumLength = 512): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= maximumLength && value.trim().length > 0 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}
