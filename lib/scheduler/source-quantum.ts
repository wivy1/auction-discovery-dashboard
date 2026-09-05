import type { SchedulerRuntimeAuthorizationBinding } from
  "./runtime-authorization";
import type { SourceId } from "../sources/types";

export const SCHEDULED_SOURCE_QUANTUM_MAX_CHECKPOINT_PAGES = 32;
export const SCHEDULED_SOURCE_QUANTUM_MAX_PHYSICAL_REQUEST_STARTS = 48;
export const SCHEDULED_SOURCE_QUANTUM_ACQUISITION_WINDOW_MS = 8 * 60 * 1_000;
export const SCHEDULED_SOURCE_QUANTUM_DISCOVERY_LEASE_MS = 15 * 60 * 1_000;
export const SCHEDULED_SOURCE_QUANTUM_RESERVATION_LEASE_MS = 45 * 60 * 1_000;

const SCHEDULER_QUANTUM_KEYS = Object.freeze([
  "acquisitionDeadlineAt",
  "campaignId",
  "coverageMode",
  "sourceId",
] as const);
const MAX_CAMPAIGN_ID_LENGTH = 200;

export interface ScheduledSourceQuantum {
  readonly campaignId: string;
  readonly sourceId: SourceId;
  readonly coverageMode: "complete_current";
  readonly acquisitionDeadlineAt: string;
}

export class InvalidScheduledSourceQuantumError extends TypeError {
  constructor(message = "The scheduled source quantum is invalid") {
    super(message);
    this.name = "InvalidScheduledSourceQuantumError";
  }
}

export class ScheduledSourceQuantumAuthorizationError extends Error {
  constructor() {
    super("The scheduler source quantum authorization is missing or invalid");
    this.name = "ScheduledSourceQuantumAuthorizationError";
  }
}

export type SourceRequestQuantumExhaustionReason =
  | "acquisition_deadline"
  | "physical_request_start_limit";

export class SourceRequestQuantumExhaustedError extends Error {
  constructor(
    readonly reason: SourceRequestQuantumExhaustionReason,
    readonly physicalRequestStarts: number,
  ) {
    super(
      reason === "physical_request_start_limit"
        ? "The scheduled source quantum exhausted its physical request-start budget"
        : "The scheduled source quantum cannot admit another request before its acquisition deadline",
    );
    this.name = "SourceRequestQuantumExhaustedError";
  }
}

/**
 * Validates the only scheduler-owned direct-source quantum accepted by the
 * Worker. Numeric budgets are deliberately absent from the wire contract.
 */
export function parseScheduledSourceQuantum(
  value: unknown,
  input: {
    readonly expectedSourceId: SourceId;
    readonly authorizationBinding: SchedulerRuntimeAuthorizationBinding;
    readonly now?: () => number;
  },
): ScheduledSourceQuantum {
  if (!isRecord(value)) throw new InvalidScheduledSourceQuantumError();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== SCHEDULER_QUANTUM_KEYS.length ||
    keys.some((key, index) => key !== SCHEDULER_QUANTUM_KEYS[index])
  ) {
    throw new InvalidScheduledSourceQuantumError(
      "The scheduled source quantum must contain exactly campaignId, sourceId, coverageMode, and acquisitionDeadlineAt",
    );
  }
  const campaignId = boundedIdentifier(
    value.campaignId,
    "scheduled source quantum campaignId",
    MAX_CAMPAIGN_ID_LENGTH,
  );
  if (
    value.sourceId !== input.expectedSourceId ||
    value.coverageMode !== "complete_current"
  ) {
    throw new InvalidScheduledSourceQuantumError(
      "The scheduled source quantum must match its complete-current source request",
    );
  }
  if (
    input.authorizationBinding.campaignId !== campaignId ||
    input.authorizationBinding.coverageMode !== "complete_current" ||
    input.authorizationBinding.includeSourceAcquisitions !== true
  ) {
    throw new ScheduledSourceQuantumAuthorizationError();
  }
  const now = input.now ?? Date.now;
  const nowMs = now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new InvalidScheduledSourceQuantumError(
      "The scheduled source quantum clock is invalid",
    );
  }
  const acquisitionDeadlineAt = canonicalTimestamp(
    value.acquisitionDeadlineAt,
    "scheduled source quantum acquisitionDeadlineAt",
  );
  const deadlineAtMs = Date.parse(acquisitionDeadlineAt);
  if (
    deadlineAtMs <= nowMs ||
    deadlineAtMs > nowMs + SCHEDULED_SOURCE_QUANTUM_ACQUISITION_WINDOW_MS
  ) {
    throw new InvalidScheduledSourceQuantumError(
      "The scheduled source quantum acquisition deadline must be within the server-owned eight-minute window",
    );
  }
  return Object.freeze({
    campaignId,
    sourceId: input.expectedSourceId,
    coverageMode: "complete_current",
    acquisitionDeadlineAt,
  });
}

export function assertScheduledSourceQuantumForDiscovery(
  value: ScheduledSourceQuantum,
  input: {
    readonly trigger: "manual" | "scheduled";
    readonly sourceId: SourceId | undefined;
    readonly catalogOnly: boolean | undefined;
    readonly now?: () => number;
  },
): void {
  const now = input.now ?? Date.now;
  const nowMs = now();
  const deadlineAtMs = canonicalTimestampMs(
    value?.acquisitionDeadlineAt,
    "scheduled source quantum acquisitionDeadlineAt",
  );
  if (
    input.trigger !== "scheduled" ||
    input.catalogOnly !== true ||
    input.sourceId === undefined ||
    value?.sourceId !== input.sourceId ||
    value?.coverageMode !== "complete_current" ||
    boundedIdentifier(
        value?.campaignId,
        "scheduled source quantum campaignId",
        MAX_CAMPAIGN_ID_LENGTH,
      ) !== value.campaignId ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    deadlineAtMs > nowMs + SCHEDULED_SOURCE_QUANTUM_ACQUISITION_WINDOW_MS
  ) {
    throw new InvalidScheduledSourceQuantumError(
      "A scheduled source quantum requires one matching scheduled catalog-only complete-current source run",
    );
  }
}

export interface SourceRequestQuantumLedger {
  readonly sourceId: SourceId;
  readonly acquisitionDeadlineAt: string;
  readonly maximumPhysicalRequestStarts: number;
  readonly physicalRequestStarts: number;
  assertRequestAdmission(input: {
    readonly nowMs: number;
    readonly requiredWaitMs: number;
    readonly timeoutMs: number;
  }): void;
  reservePhysicalRequestStart(input: {
    readonly nowMs: number;
    readonly timeoutMs: number;
  }): number;
}

/** One invocation-local ledger shared by every physical child controller. */
export function createSourceRequestQuantumLedger(
  quantum: ScheduledSourceQuantum,
): SourceRequestQuantumLedger {
  const deadlineAtMs = canonicalTimestampMs(
    quantum.acquisitionDeadlineAt,
    "scheduled source quantum acquisitionDeadlineAt",
  );
  let physicalRequestStarts = 0;
  const assertRequestAdmission = (input: {
    readonly nowMs: number;
    readonly requiredWaitMs: number;
    readonly timeoutMs: number;
  }): void => {
    assertAdmissionNumbers(input);
    if (
      physicalRequestStarts >=
        SCHEDULED_SOURCE_QUANTUM_MAX_PHYSICAL_REQUEST_STARTS
    ) {
      throw new SourceRequestQuantumExhaustedError(
        "physical_request_start_limit",
        physicalRequestStarts,
      );
    }
    if (
      input.nowMs + input.requiredWaitMs + input.timeoutMs > deadlineAtMs
    ) {
      throw new SourceRequestQuantumExhaustedError(
        "acquisition_deadline",
        physicalRequestStarts,
      );
    }
  };
  const ledger: SourceRequestQuantumLedger = {
    sourceId: quantum.sourceId,
    acquisitionDeadlineAt: quantum.acquisitionDeadlineAt,
    maximumPhysicalRequestStarts:
      SCHEDULED_SOURCE_QUANTUM_MAX_PHYSICAL_REQUEST_STARTS,
    get physicalRequestStarts() {
      return physicalRequestStarts;
    },
    assertRequestAdmission,
    reservePhysicalRequestStart(input) {
      assertRequestAdmission({ ...input, requiredWaitMs: 0 });
      physicalRequestStarts += 1;
      return physicalRequestStarts;
    },
  };
  return Object.freeze(ledger);
}

export function scheduledSourceQuantumCheckpointPageLimit(
  adapterLimit: number | undefined,
): number {
  if (
    adapterLimit !== undefined &&
    (!Number.isSafeInteger(adapterLimit) || adapterLimit < 1)
  ) {
    throw new InvalidScheduledSourceQuantumError(
      "The source traversal checkpoint page limit is invalid",
    );
  }
  return Math.min(
    adapterLimit ?? SCHEDULED_SOURCE_QUANTUM_MAX_CHECKPOINT_PAGES,
    SCHEDULED_SOURCE_QUANTUM_MAX_CHECKPOINT_PAGES,
  );
}

function assertAdmissionNumbers(input: {
  readonly nowMs: number;
  readonly requiredWaitMs: number;
  readonly timeoutMs: number;
}): void {
  if (
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    !Number.isSafeInteger(input.requiredWaitMs) ||
    input.requiredWaitMs < 0 ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1
  ) {
    throw new InvalidScheduledSourceQuantumError(
      "Scheduled source request admission requires bounded integer timing",
    );
  }
}

function boundedIdentifier(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new InvalidScheduledSourceQuantumError(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new InvalidScheduledSourceQuantumError(`${label} is invalid`);
  }
  const timestampMs = Date.parse(value);
  if (
    !Number.isSafeInteger(timestampMs) ||
    timestampMs < 0 ||
    new Date(timestampMs).toISOString() !== value
  ) {
    throw new InvalidScheduledSourceQuantumError(`${label} is invalid`);
  }
  return value;
}

function canonicalTimestampMs(value: unknown, label: string): number {
  return Date.parse(canonicalTimestamp(value, label));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
