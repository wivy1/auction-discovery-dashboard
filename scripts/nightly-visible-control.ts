import { listSourceManifests } from "../lib/sources/registry.ts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { opendir, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRuntimeRevision, requireRuntimeRevision } from "../lib/runtime-revision.ts";
import {
  parsePreferenceV2ScorerErrorEnvelope,
  type PreferenceV2ScorerErrorEnvelope,
} from "../lib/preference-v2/scorer-error.ts";

export const NIGHTLY_VISIBLE_PROJECT = "auction-discovery";
export const NIGHTLY_VISIBLE_TASK = "dashboard";
export const NIGHTLY_VISIBLE_ACTIVITY = "nightly-discovery";
export const NIGHTLY_VISIBLE_LIST_ARGUMENTS = Object.freeze([
  "-AsJson",
] as const);

const ACTIVE_STATES = new Set(["starting", "running", "stop-requested"]);
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 64 * 1_024;
const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const SOURCE_OUTCOME_ORDER = Object.freeze(listSourceManifests().map(({ id }) => id));
const SOURCE_OUTCOME_NAMES = Object.freeze([
  "refreshed", "skipped_recent", "preserved", "paused", "stopped", "blocked",
] as const);
const NIGHTLY_STAGE_LEDGER_ORDER = Object.freeze([
  "source_acquisition",
  "projection_listing_refresh",
  "projection_source_refresh",
  "projection_group_refresh",
  "projection_global_refresh",
  "detail",
  "action_deadline",
  "owner_refresh",
  "factual_supplement",
  "image_evidence",
  "primary_image",
  "proximity",
  "enrichment_text",
  "enrichment_embedding",
  "preference_v2_score",
  "source_release",
  "source_acquisition_readiness",
] as const);
let lastNightlyManifestPath: string | null = null;

export interface NightlySourceOutcome {
  readonly sourceId: string;
  readonly outcome: typeof SOURCE_OUTCOME_NAMES[number];
  readonly dependencySatisfied: boolean;
  readonly reasonCode: string;
  readonly priorHead: { readonly inventoryRunId: string; readonly listingCount: number } | null;
  readonly resultingHead: { readonly inventoryRunId: string; readonly listingCount: number } | null;
  readonly nextEligibleAt: string | null;
  readonly proofIdentity: string | null;
  readonly receiptIdentity: string | null;
}

export type NightlySourceOutcomeCounts = Readonly<Record<
  typeof SOURCE_OUTCOME_NAMES[number],
  number
>>;

export type NightlyProgressPhase =
  | "snapshot"
  | "batch_started"
  | "batch_heartbeat"
  | "batch_completed"
  | "terminal";

export type NightlyWorkflowState =
  | "running"
  | "completed"
  | "failed"
  | "checkpoint_paused"
  | "core_complete_maintenance_deferred";

export interface NightlyScopeProgress {
  readonly ready: number | null;
  readonly deferred: number | null;
  readonly claimed: number | null;
  readonly remaining: number | null;
}

export interface NightlyProximityProgress {
  readonly queued: number | null;
  readonly claimed: number | null;
  readonly completed: number | null;
  readonly stale: number | null;
  readonly remaining: number | null;
}

export interface NightlyPrimaryImageProgress {
  readonly ready: number | null;
  readonly deferred: number | null;
  readonly claimed: number | null;
  readonly remaining: number | null;
}

export interface NightlyPrimaryImageSession {
  readonly sourceId: string;
  readonly attempted: number;
  readonly archived: number;
  readonly failed: number;
  readonly remainingWork: boolean;
  readonly stopReason: string | null;
}

export interface NightlyEnrichmentProgress {
  readonly scope: "enrichment_text+enrichment_embedding";
  readonly queued: number | null;
  readonly claimed: number | null;
  readonly completed: number | null;
  readonly stale: number | null;
  readonly remaining: number | null;
}

export interface NightlyPreferenceV2Progress {
  readonly queueBefore: number;
  readonly selected: number;
  readonly completed: number;
  readonly reused: number;
  readonly newlyScored: number;
  readonly stale: number;
  readonly queueAfter: number;
  readonly remaining: number;
  readonly lastProgressAt: string | null;
  readonly elapsedMs: number;
  readonly throughputRowsPerSecond: number | null;
  readonly estimatedRemainingMs: number | null;
  readonly stopReason: "queue_empty" | "quantum";
}

export interface NightlyStageLedgerEntry {
  readonly stage: typeof NIGHTLY_STAGE_LEDGER_ORDER[number];
  readonly timingState: "unknown" | "exact" | "mixed";
  readonly observedStartedAt: string | null;
  readonly observedEndedAt: string | null;
  readonly durationMs: number | null;
  readonly queueState: "unknown" | "exact" | "mixed";
  readonly queueBefore: number | null;
  readonly queueAfter: number | null;
  readonly completedDelta: number | null;
  readonly remaining: number | null;
  readonly throughputRowsPerSecond: number | null;
  readonly lastProgressAt: string | null;
  readonly etaSeconds: number | null;
}

export interface VisibleNightlyRun {
  readonly available: true;
  readonly active: boolean;
  readonly state: string;
  readonly workflowState: NightlyWorkflowState | null;
  readonly id: string | null;
  readonly reused: boolean;
  readonly runnerPid: number | null;
  readonly title: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly endedAt: string | null;
  readonly exitCode: number | null;
  readonly lastError: string | null;
  readonly logPath: string | null;
  readonly stage: string | null;
  readonly failedAtStage: string | null;
  readonly completedStages: number | null;
  readonly totalStages: number | null;
  readonly progressCompleted: number | null;
  readonly progressTotal: number | null;
  readonly progressPercent: number | null;
  readonly progressPhase: NightlyProgressPhase | null;
  readonly proximityProgress: NightlyProximityProgress;
  readonly primaryImageProgress: NightlyPrimaryImageProgress;
  readonly primaryImageSession: NightlyPrimaryImageSession | null;
  readonly enrichmentProgress: NightlyEnrichmentProgress | null;
  readonly preferenceV2Progress: NightlyPreferenceV2Progress | null;
  readonly preferenceV2ScorerError: PreferenceV2ScorerErrorEnvelope | null;
  readonly stageLedger: readonly NightlyStageLedgerEntry[];
  readonly coreProgress: NightlyScopeProgress;
  readonly maintenanceProgress: NightlyScopeProgress;
  readonly etaSeconds: number | null;
  readonly attemptCount: number | null;
  readonly message: string | null;
  readonly workflowStartedAt: string | null;
  readonly workflowUpdatedAt: string | null;
  readonly workflowEndedAt: string | null;
  readonly workflowError: string | null;
  readonly invocationSourcesAttempted: number | null;
  readonly invocationSourcesCompleted: number | null;
  readonly campaignId: string | null;
  readonly campaignCycle: number | null;
  readonly campaignSourcesCompleted: number | null;
  readonly campaignSourcesTotal: number | null;
  readonly terminalSourceCount: number | null;
  readonly currentSourceId: string | null;
  readonly sourceOutcomes: readonly NightlySourceOutcome[];
  readonly sourceOutcomeCounts: NightlySourceOutcomeCounts;
}

export interface NightlyWorkflowProgress {
  readonly workflowState: NightlyWorkflowState | null;
  readonly stage: string | null;
  readonly failedAtStage: string | null;
  readonly completedStages: number | null;
  readonly totalStages: number | null;
  readonly progressCompleted: number | null;
  readonly progressTotal: number | null;
  readonly progressPercent: number | null;
  readonly progressPhase: NightlyProgressPhase | null;
  readonly proximityProgress: NightlyProximityProgress;
  readonly primaryImageProgress: NightlyPrimaryImageProgress;
  readonly primaryImageSession: NightlyPrimaryImageSession | null;
  readonly enrichmentProgress: NightlyEnrichmentProgress | null;
  readonly preferenceV2Progress: NightlyPreferenceV2Progress | null;
  readonly preferenceV2ScorerError: PreferenceV2ScorerErrorEnvelope | null;
  readonly stageLedger: readonly NightlyStageLedgerEntry[];
  readonly coreProgress: NightlyScopeProgress;
  readonly maintenanceProgress: NightlyScopeProgress;
  readonly etaSeconds: number | null;
  readonly attemptCount: number | null;
  readonly message: string | null;
  readonly workflowStartedAt: string | null;
  readonly workflowUpdatedAt: string | null;
  readonly workflowEndedAt: string | null;
  readonly workflowError: string | null;
  readonly invocationSourcesAttempted: number | null;
  readonly invocationSourcesCompleted: number | null;
  readonly campaignId: string | null;
  readonly campaignCycle: number | null;
  readonly campaignSourcesCompleted: number | null;
  readonly campaignSourcesTotal: number | null;
  readonly terminalSourceCount: number | null;
  readonly currentSourceId: string | null;
  readonly sourceOutcomes: readonly NightlySourceOutcome[];
  readonly sourceOutcomeCounts: NightlySourceOutcomeCounts;
}

export type NightlyVisibleControlErrorCode =
  | "visible_runner_unavailable"
  | "visible_runner_launch_failed"
  | "visible_runner_contract_mismatch";

export class NightlyVisibleControlError extends Error {
  readonly code: NightlyVisibleControlErrorCode;

  constructor(code: NightlyVisibleControlErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NightlyVisibleControlError";
    this.code = code;
  }
}

interface VisibleNightlyControlConfig {
  readonly launcherPath: string;
  readonly projectRoot: string;
  readonly command: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedString(value: unknown, maximumLength = 4_096): string | null {
  return typeof value === "string" && value.length <= maximumLength ? value : null;
}

function nullableNonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function nullableProgressPercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function nullableNonnegativeFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function nullableCanonicalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : null;
}

function nullableProgressPhase(value: unknown): NightlyProgressPhase | null {
  return value === "snapshot" || value === "batch_started" ||
      value === "batch_heartbeat" || value === "batch_completed" || value === "terminal"
    ? value
    : null;
}

function nullableWorkflowState(value: unknown): NightlyWorkflowState | null {
  return value === "running" || value === "completed" || value === "failed" ||
      value === "checkpoint_paused" || value === "core_complete_maintenance_deferred"
    ? value
    : null;
}

function nullScopeProgress(): NightlyScopeProgress {
  return { ready: null, deferred: null, claimed: null, remaining: null };
}

function parseScopeProgress(value: unknown): NightlyScopeProgress {
  if (value === undefined || value === null) return nullScopeProgress();
  const record = asRecord(value);
  if (record === null || !exactKeys(record, [
    "ready", "deferred", "claimed", "remaining",
  ])) return nullScopeProgress();
  const ready = nullableNonnegativeInteger(record.ready);
  const deferred = nullableNonnegativeInteger(record.deferred);
  const claimed = nullableNonnegativeInteger(record.claimed);
  const remaining = nullableNonnegativeInteger(record.remaining);
  if (
    [ready, deferred, claimed, remaining].some((entry) => entry === null) ||
    remaining !== ready! + deferred! + claimed!
  ) {
    return nullScopeProgress();
  }
  return { ready, deferred, claimed, remaining };
}

function nullProximityProgress(): NightlyProximityProgress {
  return {
    queued: null,
    claimed: null,
    completed: null,
    stale: null,
    remaining: null,
  };
}

function parseProximityProgress(value: unknown): NightlyProximityProgress {
  if (value === undefined || value === null) return nullProximityProgress();
  const record = asRecord(value);
  if (record === null || !exactKeys(record, [
    "queued", "claimed", "completed", "stale", "remaining",
  ])) return nullProximityProgress();
  const queued = nullableNonnegativeInteger(record.queued);
  const claimed = nullableNonnegativeInteger(record.claimed);
  const completed = nullableNonnegativeInteger(record.completed);
  const stale = nullableNonnegativeInteger(record.stale);
  const remaining = nullableNonnegativeInteger(record.remaining);
  const values = [queued, claimed, completed, stale, remaining];
  if (values.every((entry) => entry === null)) return nullProximityProgress();
  if (
    values.some((entry) => entry === null) ||
    claimed! > queued! ||
    completed! + stale! > claimed! ||
    remaining! !== queued! - completed!
  ) return nullProximityProgress();
  return { queued, claimed, completed, stale, remaining };
}

function nullPrimaryImageProgress(): NightlyPrimaryImageProgress {
  return { ready: null, deferred: null, claimed: null, remaining: null };
}

function parsePrimaryImageProgress(value: unknown): NightlyPrimaryImageProgress {
  if (value === undefined || value === null) return nullPrimaryImageProgress();
  const record = asRecord(value);
  if (record === null || !exactKeys(record, [
    "ready", "deferred", "claimed", "remaining",
  ])) return nullPrimaryImageProgress();
  const ready = nullableNonnegativeInteger(record.ready);
  const deferred = nullableNonnegativeInteger(record.deferred);
  const claimed = nullableNonnegativeInteger(record.claimed);
  const remaining = nullableNonnegativeInteger(record.remaining);
  const values = [ready, deferred, claimed, remaining];
  if (values.every((entry) => entry === null)) return nullPrimaryImageProgress();
  if (
    values.some((entry) => entry === null) ||
    remaining !== ready! + deferred! + claimed!
  ) return nullPrimaryImageProgress();
  return { ready, deferred, claimed, remaining };
}

function parsePrimaryImageSession(value: unknown): NightlyPrimaryImageSession | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value);
  if (record === null || !exactKeys(record, [
    "sourceId", "attempted", "archived", "failed", "remainingWork", "stopReason",
  ])) return null;
  const sourceId = boundedString(record.sourceId, 128);
  const attempted = nullableNonnegativeInteger(record.attempted);
  const archived = nullableNonnegativeInteger(record.archived);
  const failed = nullableNonnegativeInteger(record.failed);
  const stopReason = boundedString(record.stopReason, 128);
  if (
    sourceId === null || attempted === null || archived === null || failed === null ||
    archived + failed !== attempted || typeof record.remainingWork !== "boolean" ||
    (record.stopReason !== null && stopReason === null)
  ) return null;
  return {
    sourceId,
    attempted,
    archived,
    failed,
    remainingWork: record.remainingWork,
    stopReason,
  };
}

function parseEnrichmentProgress(value: unknown): NightlyEnrichmentProgress | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value);
  if (record === null || !exactKeys(record, [
    "scope", "queued", "claimed", "completed", "stale", "remaining",
  ]) || record.scope !== "enrichment_text+enrichment_embedding") return null;
  for (const name of ["queued", "claimed", "completed", "stale", "remaining"] as const) {
    if (record[name] !== null && nullableNonnegativeInteger(record[name]) === null) return null;
  }
  return {
    scope: "enrichment_text+enrichment_embedding",
    queued: record.queued as number | null,
    claimed: record.claimed as number | null,
    completed: record.completed as number | null,
    stale: record.stale as number | null,
    remaining: record.remaining as number | null,
  };
}

function parsePreferenceV2Progress(value: unknown): NightlyPreferenceV2Progress | null {
  if (value === undefined || value === null) return null;
  const record = asRecord(value);
  if (record === null || !exactKeys(record, [
    "queueBefore", "selected", "completed", "reused", "newlyScored", "stale",
    "queueAfter", "remaining", "lastProgressAt", "elapsedMs",
    "throughputRowsPerSecond", "estimatedRemainingMs", "stopReason",
  ])) return null;
  const queueBefore = nullableNonnegativeInteger(record.queueBefore);
  const selected = nullableNonnegativeInteger(record.selected);
  const completed = nullableNonnegativeInteger(record.completed);
  const reused = nullableNonnegativeInteger(record.reused);
  const newlyScored = nullableNonnegativeInteger(record.newlyScored);
  const stale = nullableNonnegativeInteger(record.stale);
  const queueAfter = nullableNonnegativeInteger(record.queueAfter);
  const remaining = nullableNonnegativeInteger(record.remaining);
  if (
    [queueBefore, selected, completed, reused, newlyScored, stale, queueAfter, remaining]
      .some((entry) => entry === null) ||
    selected! > 10 || selected! > queueBefore! || queueAfter! > queueBefore! ||
    completed !== queueBefore! - queueAfter! || completed! > selected! ||
    reused! + newlyScored! > selected! || stale! > selected! || remaining !== queueAfter
  ) return null;
  const elapsedMs = nullableNonnegativeFinite(record.elapsedMs);
  const throughputRowsPerSecond = record.throughputRowsPerSecond === null
    ? null
    : nullableNonnegativeFinite(record.throughputRowsPerSecond);
  const estimatedRemainingMs = record.estimatedRemainingMs === null
    ? null
    : nullableNonnegativeFinite(record.estimatedRemainingMs);
  const lastProgressAt = nullableCanonicalTimestamp(record.lastProgressAt);
  if (
    elapsedMs === null ||
    (record.throughputRowsPerSecond !== null &&
      (throughputRowsPerSecond === null || throughputRowsPerSecond === 0)) ||
    (record.estimatedRemainingMs !== null && estimatedRemainingMs === null) ||
    (completed === 0 ? record.lastProgressAt !== null : lastProgressAt === null) ||
    ((completed! > 0 && elapsedMs > 0) !== (throughputRowsPerSecond !== null)) ||
    (remaining === 0 && estimatedRemainingMs !== 0) ||
    (remaining! > 0 && (throughputRowsPerSecond === null) !== (estimatedRemainingMs === null)) ||
    record.stopReason !== (remaining === 0 ? "queue_empty" : "quantum")
  ) return null;
  return {
    queueBefore: queueBefore!,
    selected: selected!,
    completed: completed!,
    reused: reused!,
    newlyScored: newlyScored!,
    stale: stale!,
    queueAfter: queueAfter!,
    remaining: remaining!,
    lastProgressAt,
    elapsedMs,
    throughputRowsPerSecond,
    estimatedRemainingMs,
    stopReason: record.stopReason,
  } as NightlyPreferenceV2Progress;
}

function nullStageLedger(): readonly NightlyStageLedgerEntry[] {
  return NIGHTLY_STAGE_LEDGER_ORDER.map((stage) => ({
    stage,
    timingState: "unknown",
    observedStartedAt: null,
    observedEndedAt: null,
    durationMs: null,
    queueState: "unknown",
    queueBefore: null,
    queueAfter: null,
    completedDelta: null,
    remaining: null,
    throughputRowsPerSecond: null,
    lastProgressAt: null,
    etaSeconds: null,
  }));
}

function parseStageLedger(value: unknown): readonly NightlyStageLedgerEntry[] {
  if (!Array.isArray(value) || value.length !== NIGHTLY_STAGE_LEDGER_ORDER.length) {
    return nullStageLedger();
  }
  const parsed: NightlyStageLedgerEntry[] = [];
  for (const [index, candidate] of value.entries()) {
    const record = asRecord(candidate);
    if (record === null || !exactKeys(record, [
      "stage", "timingState", "observedStartedAt", "observedEndedAt", "durationMs",
      "queueState", "queueBefore", "queueAfter", "completedDelta", "remaining",
      "throughputRowsPerSecond", "lastProgressAt", "etaSeconds",
    ]) || record.stage !== NIGHTLY_STAGE_LEDGER_ORDER[index]) return nullStageLedger();
    if (record.timingState !== "unknown" && record.timingState !== "exact" &&
        record.timingState !== "mixed") return nullStageLedger();
    const observedStartedAt = nullableCanonicalTimestamp(record.observedStartedAt);
    const observedEndedAt = nullableCanonicalTimestamp(record.observedEndedAt);
    const durationMs = nullableNonnegativeInteger(record.durationMs);
    if (record.timingState === "exact") {
      if (
        observedStartedAt === null || observedEndedAt === null || durationMs === null ||
        Date.parse(observedEndedAt) - Date.parse(observedStartedAt) !== durationMs
      ) return nullStageLedger();
    } else if (
      record.observedStartedAt !== null || record.observedEndedAt !== null ||
      record.durationMs !== null
    ) return nullStageLedger();
    if (record.queueState !== "unknown" && record.queueState !== "exact" &&
        record.queueState !== "mixed") return nullStageLedger();
    const queueBefore = nullableNonnegativeInteger(record.queueBefore);
    const queueAfter = nullableNonnegativeInteger(record.queueAfter);
    const completedDelta = nullableNonnegativeInteger(record.completedDelta);
    const remaining = nullableNonnegativeInteger(record.remaining);
    const throughputRowsPerSecond = record.throughputRowsPerSecond === null
      ? null
      : nullableNonnegativeFinite(record.throughputRowsPerSecond);
    const lastProgressAt = nullableCanonicalTimestamp(record.lastProgressAt);
    const etaSeconds = nullableNonnegativeInteger(record.etaSeconds);
    if (record.queueState === "exact") {
      if (
        queueBefore === null || queueAfter === null || completedDelta === null ||
        remaining === null || queueAfter > queueBefore ||
        completedDelta !== queueBefore - queueAfter || remaining !== queueAfter ||
        (record.throughputRowsPerSecond !== null &&
          (throughputRowsPerSecond === null || throughputRowsPerSecond === 0)) ||
        (record.lastProgressAt !== null && lastProgressAt === null) ||
        (record.etaSeconds !== null && etaSeconds === null)
      ) return nullStageLedger();
    } else if (
      record.queueBefore !== null || record.queueAfter !== null ||
      record.completedDelta !== null || record.remaining !== null ||
      record.throughputRowsPerSecond !== null || record.lastProgressAt !== null ||
      record.etaSeconds !== null
    ) return nullStageLedger();
    parsed.push({
      stage: record.stage as NightlyStageLedgerEntry["stage"],
      timingState: record.timingState,
      observedStartedAt,
      observedEndedAt,
      durationMs,
      queueState: record.queueState,
      queueBefore,
      queueAfter,
      completedDelta,
      remaining,
      throughputRowsPerSecond,
      lastProgressAt,
      etaSeconds,
    });
  }
  return parsed;
}

function nullWorkflowProgress(): NightlyWorkflowProgress {
  return {
    workflowState: null,
    stage: null,
    failedAtStage: null,
    completedStages: null,
    totalStages: null,
    progressCompleted: null,
    progressTotal: null,
    progressPercent: null,
    progressPhase: null,
    proximityProgress: nullProximityProgress(),
    primaryImageProgress: nullPrimaryImageProgress(),
    primaryImageSession: null,
    enrichmentProgress: null,
    preferenceV2Progress: null,
    preferenceV2ScorerError: null,
    stageLedger: nullStageLedger(),
    coreProgress: nullScopeProgress(),
    maintenanceProgress: nullScopeProgress(),
    etaSeconds: null,
    attemptCount: null,
    message: null,
    workflowStartedAt: null,
    workflowUpdatedAt: null,
    workflowEndedAt: null,
    workflowError: null,
    invocationSourcesAttempted: null,
    invocationSourcesCompleted: null,
    campaignId: null,
    campaignCycle: null,
    campaignSourcesCompleted: null,
    campaignSourcesTotal: null,
    terminalSourceCount: null,
    currentSourceId: null,
    sourceOutcomes: [],
    sourceOutcomeCounts: emptySourceOutcomeCounts(),
  };
}

function emptySourceOutcomeCounts(): NightlySourceOutcomeCounts {
  return {
    refreshed: 0,
    skipped_recent: 0,
    preserved: 0,
    paused: 0,
    stopped: 0,
    blocked: 0,
  };
}

function safeIdentity(value: unknown, maximumLength = 1_024): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximumLength &&
    value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function parsePublicationHead(
  value: unknown,
): NightlySourceOutcome["priorHead"] | undefined {
  if (value === null) return null;
  const record = asRecord(value);
  if (
    record === null ||
    !exactKeys(record, ["inventoryRunId", "listingCount"]) ||
    !safeIdentity(record.inventoryRunId) ||
    !Number.isSafeInteger(record.listingCount) ||
    Number(record.listingCount) < 0
  ) return undefined;
  return {
    inventoryRunId: record.inventoryRunId,
    listingCount: Number(record.listingCount),
  };
}

function parseSourceOutcomes(value: unknown): readonly NightlySourceOutcome[] | null {
  if (!Array.isArray(value) || value.length > SOURCE_OUTCOME_ORDER.length) return null;
  const outcomes: NightlySourceOutcome[] = [];
  for (const [index, candidate] of value.entries()) {
    const record = asRecord(candidate);
    if (
      record === null ||
      !exactKeys(record, [
        "sourceId", "outcome", "dependencySatisfied", "reasonCode", "priorHead",
        "resultingHead", "nextEligibleAt", "proofIdentity", "receiptIdentity",
      ]) ||
      record.sourceId !== SOURCE_OUTCOME_ORDER[index] ||
      !SOURCE_OUTCOME_NAMES.includes(record.outcome as typeof SOURCE_OUTCOME_NAMES[number]) ||
      typeof record.dependencySatisfied !== "boolean" ||
      !safeIdentity(record.reasonCode, 128)
    ) return null;
    const priorHead = parsePublicationHead(record.priorHead);
    const resultingHead = parsePublicationHead(record.resultingHead);
    if (priorHead === undefined || resultingHead === undefined) return null;
    const paused = record.outcome === "paused";
    if (
      (record.nextEligibleAt !== null) !== paused ||
      (paused && (
        typeof record.nextEligibleAt !== "string" ||
        !Number.isFinite(Date.parse(record.nextEligibleAt))
      ))
    ) return null;
    const refreshed = record.outcome === "refreshed";
    const skippedRecent = record.outcome === "skipped_recent";
    const verified = refreshed || skippedRecent;
    if (
      record.dependencySatisfied !== verified ||
      (resultingHead !== null) !== verified ||
      (verified ? !safeIdentity(record.proofIdentity) : record.proofIdentity !== null) ||
      (verified ? !safeIdentity(record.receiptIdentity) : record.receiptIdentity !== null) ||
      (skippedRecent && (
        record.reasonCode !== "recent_verified_publication" || priorHead === null ||
        resultingHead === null ||
        priorHead.inventoryRunId !== resultingHead.inventoryRunId ||
        priorHead.listingCount !== resultingHead.listingCount
      ))
    ) return null;
    outcomes.push({
      sourceId: record.sourceId as string,
      outcome: record.outcome as NightlySourceOutcome["outcome"],
      dependencySatisfied: record.dependencySatisfied,
      reasonCode: record.reasonCode,
      priorHead,
      resultingHead,
      nextEligibleAt: record.nextEligibleAt as string | null,
      proofIdentity: record.proofIdentity as string | null,
      receiptIdentity: record.receiptIdentity as string | null,
    });
  }
  return outcomes;
}

function sourceOutcomeCounts(
  outcomes: readonly NightlySourceOutcome[],
): NightlySourceOutcomeCounts {
  const counts = emptySourceOutcomeCounts() as Record<
    typeof SOURCE_OUTCOME_NAMES[number],
    number
  >;
  for (const outcome of outcomes) counts[outcome.outcome] += 1;
  return counts;
}

function parseSourceOutcomeCounts(
  value: unknown,
  outcomes: readonly NightlySourceOutcome[],
  requireVectorMatch: boolean,
): NightlySourceOutcomeCounts | null {
  if (value === undefined) return sourceOutcomeCounts(outcomes);
  const record = asRecord(value);
  if (record === null || !exactKeys(record, SOURCE_OUTCOME_NAMES)) return null;
  const parsed = emptySourceOutcomeCounts() as Record<
    typeof SOURCE_OUTCOME_NAMES[number],
    number
  >;
  for (const name of SOURCE_OUTCOME_NAMES) {
    const count = nullableNonnegativeInteger(record[name]);
    if (count === null || count > SOURCE_OUTCOME_ORDER.length) return null;
    parsed[name] = count;
  }
  const total = SOURCE_OUTCOME_NAMES.reduce((sum, name) => sum + parsed[name], 0);
  if (total > SOURCE_OUTCOME_ORDER.length) return null;
  if (requireVectorMatch) {
    const vectorCounts = sourceOutcomeCounts(outcomes);
    if (SOURCE_OUTCOME_NAMES.some((name) => parsed[name] !== vectorCounts[name])) return null;
  }
  return parsed;
}

export function parseNightlyWorkflowStatus(contents: string): NightlyWorkflowProgress {
  try {
    const status = asRecord(JSON.parse(contents) as unknown);
    if (status === null) return nullWorkflowProgress();

    const completedStages = nullableNonnegativeInteger(status.completedStages);
    const totalStages = nullableNonnegativeInteger(status.totalStages);
    const progressCompleted = nullableNonnegativeInteger(status.progressCompleted);
    const progressTotal = nullableNonnegativeInteger(status.progressTotal);
    const progressPercent = nullableProgressPercent(status.progressPercent);
    const progressPhase = nullableProgressPhase(status.progressPhase);
    const workflowState = nullableWorkflowState(status.workflowState);
    const proximityProgress = parseProximityProgress(status.proximityProgress);
    const primaryImageProgress = parsePrimaryImageProgress(
      status.primaryImageProgress,
    );
    const primaryImageSession = parsePrimaryImageSession(
      status.primaryImageSession,
    );
    const enrichmentProgress = parseEnrichmentProgress(status.enrichmentProgress);
    const preferenceV2Progress = parsePreferenceV2Progress(status.preferenceV2Progress);
    const preferenceV2ScorerError = parsePreferenceV2ScorerErrorEnvelope(
      status.preferenceV2ScorerError,
    );
    const stageLedger = parseStageLedger(status.stageLedger);
    const coreProgress = parseScopeProgress(status.coreProgress);
    const maintenanceProgress = parseScopeProgress(status.maintenanceProgress);
    const validProgress = progressCompleted !== null && progressTotal !== null &&
      progressCompleted <= progressTotal && progressPercent !== null;
    const invocationSourcesAttempted = nullableNonnegativeInteger(
      status.invocationSourcesAttempted,
    );
    const invocationSourcesCompleted = nullableNonnegativeInteger(
      status.invocationSourcesCompleted,
    );
    const campaignSourcesCompleted = nullableNonnegativeInteger(
      status.campaignSourcesCompleted,
    );
    const campaignSourcesTotal = nullableNonnegativeInteger(status.campaignSourcesTotal);
    const terminalSourceCount = nullableNonnegativeInteger(status.terminalSourceCount);
    const parsedSourceOutcomes = parseSourceOutcomes(status.sourceOutcomes ?? []);
    if (
      parsedSourceOutcomes === null ||
      (status.stage === "complete" &&
        parsedSourceOutcomes.length !== SOURCE_OUTCOME_ORDER.length)
    ) return nullWorkflowProgress();
    const sourceOutcomes = parsedSourceOutcomes ?? [];
    const parsedSourceOutcomeCounts = parseSourceOutcomeCounts(
      status.sourceOutcomeCounts,
      sourceOutcomes,
      status.sourceOutcomes !== undefined,
    );
    if (parsedSourceOutcomeCounts === null) return nullWorkflowProgress();
    return {
      workflowState,
      stage: boundedString(status.stage, 128),
      failedAtStage: boundedString(status.failedAtStage, 128),
      completedStages: completedStages !== null &&
          totalStages !== null && completedStages <= totalStages
        ? completedStages
        : null,
      totalStages: completedStages !== null &&
          totalStages !== null && completedStages <= totalStages
        ? totalStages
        : null,
      progressCompleted: validProgress ? progressCompleted : null,
      progressTotal: validProgress ? progressTotal : null,
      progressPercent: validProgress ? progressPercent : null,
      progressPhase,
      proximityProgress,
      primaryImageProgress,
      primaryImageSession,
      enrichmentProgress,
      preferenceV2Progress,
      preferenceV2ScorerError,
      stageLedger,
      coreProgress,
      maintenanceProgress,
      etaSeconds: nullableNonnegativeInteger(status.etaSeconds),
      attemptCount: nullableNonnegativeInteger(status.attemptCount),
      message: boundedString(status.message, 1_024),
      workflowStartedAt: boundedString(status.startedAt, 128),
      workflowUpdatedAt: boundedString(status.updatedAt, 128),
      workflowEndedAt: boundedString(status.endedAt, 128),
      workflowError: status.error === "" ? null : boundedString(status.error, 4_096),
      invocationSourcesAttempted,
      invocationSourcesCompleted: invocationSourcesCompleted !== null &&
          invocationSourcesAttempted !== null
        ? invocationSourcesCompleted
        : null,
      campaignId: boundedString(status.campaignId, 128),
      campaignCycle: nullableNonnegativeInteger(status.campaignCycle),
      campaignSourcesCompleted: campaignSourcesCompleted !== null &&
          campaignSourcesTotal !== null &&
          campaignSourcesCompleted <= campaignSourcesTotal
        ? campaignSourcesCompleted
        : null,
      campaignSourcesTotal: campaignSourcesCompleted !== null &&
          campaignSourcesTotal !== null &&
          campaignSourcesCompleted <= campaignSourcesTotal
        ? campaignSourcesTotal
        : null,
      terminalSourceCount: terminalSourceCount !== null &&
          terminalSourceCount <= SOURCE_OUTCOME_ORDER.length &&
          (campaignSourcesTotal === null || terminalSourceCount <= campaignSourcesTotal)
        ? terminalSourceCount
        : null,
      currentSourceId: boundedString(status.currentSourceId, 128),
      sourceOutcomes,
      sourceOutcomeCounts: parsedSourceOutcomeCounts,
    };
  } catch {
    return nullWorkflowProgress();
  }
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : Number.isSafeInteger(value)
      ? value as number
      : null;
}

function samePath(left: unknown, right: string): boolean {
  const candidate = boundedString(left);
  return candidate !== null && resolve(candidate).toLowerCase() === resolve(right).toLowerCase();
}

function rememberNightlyManifestPath(value: unknown, id: string): void {
  const candidate = boundedString(value, 1_024);
  if (
    candidate !== null && isAbsolute(candidate) &&
    basename(candidate).toLowerCase() === `${id}.json`.toLowerCase()
  ) {
    lastNightlyManifestPath = resolve(candidate);
  }
}

function powershellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildNightlyVisibleCommand(
  projectRoot: string,
  expectedRuntimeRevision: string,
): string {
  const nightlyScript = resolve(projectRoot, "scripts", "nightly.ps1");
  const revision = requireRuntimeRevision(expectedRuntimeRevision, "Visible nightly command");
  return `& ${powershellLiteral(nightlyScript)} -RequireExistingRuntime -ExpectedRuntimeRevision ${powershellLiteral(revision)}`;
}

function idleState(): VisibleNightlyRun {
  return {
    available: true,
    active: false,
    state: "idle",
    id: null,
    reused: false,
    runnerPid: null,
    title: null,
    createdAt: null,
    updatedAt: null,
    endedAt: null,
    exitCode: null,
    lastError: null,
    logPath: null,
    ...nullWorkflowProgress(),
  };
}

function normalizeManifest(
  value: unknown,
  projectRoot: string,
  command: string,
): VisibleNightlyRun {
  const manifest = asRecord(value);
  const id = boundedString(manifest?.id, 128);
  const state = boundedString(manifest?.state, 64);
  if (
    manifest === null ||
    !id ||
    !state ||
    manifest.project !== NIGHTLY_VISIBLE_PROJECT ||
    manifest.task !== NIGHTLY_VISIBLE_TASK ||
    manifest.activity !== NIGHTLY_VISIBLE_ACTIVITY ||
    manifest.command !== command ||
    !samePath(manifest.working_directory, projectRoot)
  ) {
    throw new NightlyVisibleControlError(
      "visible_runner_contract_mismatch",
      "The visible nightly runner returned an invalid manifest",
    );
  }
  rememberNightlyManifestPath(manifest.manifest_path, id);

  const runnerPid = nullableInteger(manifest.runner_pid);
  const exitCode = nullableInteger(manifest.exit_code);
  if (
    (manifest.runner_pid !== null && manifest.runner_pid !== undefined && runnerPid === null) ||
    (manifest.exit_code !== null && manifest.exit_code !== undefined && exitCode === null)
  ) {
    throw new NightlyVisibleControlError(
      "visible_runner_contract_mismatch",
      "The visible nightly runner returned invalid process state",
    );
  }

  return {
    available: true,
    active: ACTIVE_STATES.has(state),
    state,
    id,
    reused: manifest.reused === true,
    runnerPid,
    title: boundedString(manifest.title, 256),
    createdAt: boundedString(manifest.created_at, 128),
    updatedAt: boundedString(manifest.updated_at, 128),
    endedAt: boundedString(manifest.ended_at, 128),
    exitCode,
    lastError: boundedString(manifest.last_error),
    logPath: boundedString(manifest.log_path),
    ...nullWorkflowProgress(),
  };
}

async function readWorkflowStatus(
  projectRoot: string,
): Promise<string | null> {
  try {
    const statusPath = resolve(projectRoot, ".wrangler", "logs", "nightly-status.json");
    const contents = await readFile(statusPath, "utf8");
    return Buffer.byteLength(contents, "utf8") <= MAX_OUTPUT_BYTES ? contents : null;
  } catch {
    return null;
  }
}

export function mergeVisibleNightlyWorkflowProgress(
  manifestState: VisibleNightlyRun,
  progress: NightlyWorkflowProgress,
): VisibleNightlyRun {
  const manifestCreated = Date.parse(manifestState.createdAt ?? "");
  const workflowUpdated = Date.parse(progress.workflowUpdatedAt ?? "");
  const workflowMatchesManifest = manifestState.id === null || (
    Number.isFinite(workflowUpdated) &&
    (!Number.isFinite(manifestCreated) || workflowUpdated >= manifestCreated)
  );
  return {
    ...manifestState,
    ...(workflowMatchesManifest ? progress : nullWorkflowProgress()),
  };
}

async function readLastKnownNightlyManifest(
  projectRoot: string,
  expectedRuntimeRevision: string,
): Promise<VisibleNightlyRun | null> {
  const manifestPath = lastNightlyManifestPath;
  if (manifestPath === null) return null;
  try {
    const contents = await readFile(manifestPath, "utf8");
    if (Buffer.byteLength(contents, "utf8") > MAX_OUTPUT_BYTES) return null;
    const manifest = parsePersistedVisibleNightlyManifest(
      contents,
      projectRoot,
      expectedRuntimeRevision,
    );
    return manifest?.state === "exited-unrecorded" ? manifest : null;
  } catch {
    return null;
  }
}

export async function readTerminalNightlyManifest(
  projectRoot: string,
  workflowContents: string | null,
): Promise<VisibleNightlyRun | null> {
  try {
    const status = asRecord(JSON.parse(workflowContents ?? "null") as unknown);
    const processId = nullableInteger(status?.processId);
    const started = Date.parse(boundedString(status?.startedAt, 128) ?? "");
    const ended = Date.parse(boundedString(status?.endedAt, 128) ?? "");
    const updated = Date.parse(boundedString(status?.updatedAt, 128) ?? "");
    if (
      status?.schemaVersion !== "auction-discovery-nightly-status-v1" ||
      (status.state !== "completed" && status.state !== "failed") ||
      processId === null || processId <= 0 || !isRuntimeRevision(status.runtimeRevision) ||
      !Number.isFinite(started) || !Number.isFinite(ended) || !Number.isFinite(updated) ||
      started > ended || ended > updated
    ) return null;

    const command = buildNightlyVisibleCommand(projectRoot, status.runtimeRevision);
    const registry = resolve(projectRoot, ".wrangler", "logs", "discovery-runners");
    const readCandidate = async (path: string): Promise<Record<string, unknown> | null> => {
      try {
        const contents = await readFile(path, "utf8");
        if (Buffer.byteLength(contents, "utf8") > MAX_OUTPUT_BYTES) return null;
        const parsed = asRecord(JSON.parse(contents.replace(/^\uFEFF/u, "")) as unknown);
        const id = boundedString(parsed?.id, 128);
        const exitCode = nullableInteger(parsed?.exit_code);
        const created = Date.parse(boundedString(parsed?.created_at, 128) ?? "");
        const runnerStarted = Date.parse(boundedString(parsed?.runner_started_at, 128) ?? "");
        const manifestEnded = Date.parse(boundedString(parsed?.ended_at, 128) ?? "");
        const manifestUpdated = Date.parse(boundedString(parsed?.updated_at, 128) ?? "");
        if (
          parsed === null || id === null || !/^[0-9a-f]{32}$/u.test(id) ||
          !samePath(path, resolve(registry, `${id}.json`)) ||
          !samePath(parsed.manifest_path, path) ||
          parsed.project !== NIGHTLY_VISIBLE_PROJECT || parsed.task !== NIGHTLY_VISIBLE_TASK ||
          parsed.activity !== NIGHTLY_VISIBLE_ACTIVITY || parsed.command !== command ||
          !samePath(parsed.working_directory, projectRoot) || parsed.runner_pid !== processId ||
          exitCode === null ||
          !((parsed.state === "completed" && exitCode === 0) ||
            (parsed.state === "failed" && exitCode !== 0)) ||
          ![created, runnerStarted, manifestEnded, manifestUpdated].every(Number.isFinite) ||
          created > runnerStarted || runnerStarted > started || ended > manifestEnded ||
          manifestEnded > manifestUpdated || updated > manifestUpdated
        ) return null;
        return parsed;
      } catch {
        return null;
      }
    };

    // Keep the established run ID while its exact durable receipt still matches.
    // Only unresolved lookup needs to disambiguate historical registry records.
    if (lastNightlyManifestPath !== null && samePath(dirname(lastNightlyManifestPath), registry)) {
      const cached = await readCandidate(lastNightlyManifestPath);
      if (cached !== null) return normalizeManifest(cached, projectRoot, command);
    }
    let matched: Record<string, unknown> | null = null;
    for await (const entry of await opendir(registry)) {
      if (!entry.isFile() || !/^[0-9a-f]{32}\.json$/u.test(entry.name)) continue;
      const candidate = await readCandidate(resolve(registry, entry.name));
      if (candidate === null) continue;
      if (matched !== null) return null;
      matched = candidate;
    }
    return matched === null ? null : normalizeManifest(matched, projectRoot, command);
  } catch {
    return null;
  }
}

export function parsePersistedVisibleNightlyManifest(
  contents: string,
  projectRoot: string,
  expectedRuntimeRevision: string,
): VisibleNightlyRun | null {
  const json = contents.startsWith("\uFEFF") ? contents.slice(1) : contents;
  const parsed = asRecord(JSON.parse(json) as unknown);
  if (parsed === null) return null;
  const recordedState = boundedString(parsed.state, 64);
  const effective = recordedState !== null && ACTIVE_STATES.has(recordedState)
    ? { ...parsed, state: "exited-unrecorded" }
    : parsed;
  return normalizeManifest(
    effective,
    projectRoot,
    buildNightlyVisibleCommand(projectRoot, expectedRuntimeRevision),
  );
}

function parseJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new NightlyVisibleControlError(
      "visible_runner_contract_mismatch",
      "The visible nightly runner returned no state",
    );
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new NightlyVisibleControlError(
      "visible_runner_contract_mismatch",
      "The visible nightly runner returned invalid JSON",
      { cause: error },
    );
  }
}

export function parseVisibleNightlyLaunchOutput(
  stdout: string,
  projectRoot: string,
  expectedRuntimeRevision: string,
): VisibleNightlyRun {
  return normalizeManifest(
    parseJson(stdout),
    projectRoot,
    buildNightlyVisibleCommand(projectRoot, expectedRuntimeRevision),
  );
}

export function parseVisibleNightlyListOutput(
  stdout: string,
  projectRoot: string,
  expectedRuntimeRevision: string,
): VisibleNightlyRun {
  const parsed = parseJson(stdout);
  if (!Array.isArray(parsed)) {
    throw new NightlyVisibleControlError(
      "visible_runner_contract_mismatch",
      "The visible nightly registry returned an invalid list",
    );
  }

  const command = buildNightlyVisibleCommand(projectRoot, expectedRuntimeRevision);
  for (const candidate of parsed) {
    const manifest = asRecord(candidate);
    if (
      manifest?.project === NIGHTLY_VISIBLE_PROJECT &&
      manifest.task === NIGHTLY_VISIBLE_TASK &&
      manifest.activity === NIGHTLY_VISIBLE_ACTIVITY &&
      samePath(manifest.working_directory, projectRoot) &&
      manifest.command === command
    ) {
      return normalizeManifest(manifest, projectRoot, command);
    }
  }
  return idleState();
}

function resolveConfig(expectedRuntimeRevision: string): VisibleNightlyControlConfig {
  const configuredLauncher = resolve(PROJECT_ROOT, "scripts", "start-visible-process.ps1");
  if (
    !configuredLauncher ||
    !isAbsolute(configuredLauncher) ||
    !configuredLauncher.toLowerCase().endsWith("\\start-visible-process.ps1") ||
    !existsSync(configuredLauncher)
  ) {
    throw new NightlyVisibleControlError(
      "visible_runner_unavailable",
      "The visible nightly runner is not installed for this runtime",
    );
  }

  const nightlyScript = resolve(PROJECT_ROOT, "scripts", "nightly.ps1");
  if (!existsSync(nightlyScript)) {
    throw new NightlyVisibleControlError(
      "visible_runner_unavailable",
      "The nightly workflow is unavailable",
    );
  }

  return {
    launcherPath: resolve(configuredLauncher),
    projectRoot: PROJECT_ROOT,
    command: buildNightlyVisibleCommand(PROJECT_ROOT, expectedRuntimeRevision),
  };
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

async function runPowerShellScript(
  script: string,
  args: readonly string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  return await new Promise<string>((resolveOutput, reject) => {
    execFile(
      powershellPath(),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        ...args,
      ],
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

export async function readVisibleNightlyRun(
  expectedRuntimeRevision: string,
): Promise<VisibleNightlyRun> {
  const config = resolveConfig(expectedRuntimeRevision);
  const registryReader = resolve(dirname(config.launcherPath), "get-visible-processes.ps1");
  if (!existsSync(registryReader)) {
    throw new NightlyVisibleControlError(
      "visible_runner_unavailable",
      "The visible nightly runner registry is unavailable",
    );
  }

  try {
    const stdout = await runPowerShellScript(registryReader, NIGHTLY_VISIBLE_LIST_ARGUMENTS);
    const activeManifestState = parseVisibleNightlyListOutput(
      stdout,
      config.projectRoot,
      expectedRuntimeRevision,
    );
    const workflowContents = await readWorkflowStatus(config.projectRoot);
    const manifestState = activeManifestState.id === null
      ? await readTerminalNightlyManifest(config.projectRoot, workflowContents) ??
        await readLastKnownNightlyManifest(config.projectRoot, expectedRuntimeRevision) ??
        activeManifestState
      : activeManifestState;
    return mergeVisibleNightlyWorkflowProgress(
      manifestState,
      parseNightlyWorkflowStatus(workflowContents ?? "null"),
    );
  } catch (error) {
    if (error instanceof NightlyVisibleControlError) throw error;
    throw new NightlyVisibleControlError(
      "visible_runner_contract_mismatch",
      "The visible nightly runner state could not be read",
      { cause: error },
    );
  }
}

export async function launchVisibleNightlyRun(
  expectedRuntimeRevision: string,
): Promise<VisibleNightlyRun> {
  const config = resolveConfig(expectedRuntimeRevision);
  const encodedCommand = Buffer.from(config.command, "utf8").toString("base64");

  try {
    const stdout = await runPowerShellScript(config.launcherPath, [
      "-ProjectName",
      NIGHTLY_VISIBLE_PROJECT,
      "-TaskName",
      NIGHTLY_VISIBLE_TASK,
      "-Activity",
      NIGHTLY_VISIBLE_ACTIVITY,
      "-WorkingDirectory",
      config.projectRoot,
      "-CommandBase64",
      encodedCommand,
      "-UrlOrPort",
      "http://localhost:3000",
    ]);
    return parseVisibleNightlyLaunchOutput(
      stdout,
      config.projectRoot,
      expectedRuntimeRevision,
    );
  } catch (error) {
    if (
      error instanceof NightlyVisibleControlError &&
      error.code === "visible_runner_contract_mismatch"
    ) {
      throw error;
    }
    throw new NightlyVisibleControlError(
      "visible_runner_launch_failed",
      "The visible nightly workflow could not be launched",
      { cause: error },
    );
  }
}
