export const PREFERENCE_V2_SCORER_ERROR_SCHEMA =
  "preference-v2-scorer-error-v1" as const;

const MAX_MESSAGE_LENGTH = 240;
const MAX_PROCESS_OUTPUT_LENGTH = 64 * 1024;
const ERROR_CODES = new Set([
  "preference_v2_input_invalid",
  "preference_v2_artifact_invalid",
  "preference_v2_inference_failed",
  "preference_v2_output_invalid",
  "preference_v2_io_failed",
  "preference_v2_timeout",
  "preference_v2_cancelled",
  "preference_v2_scorer_failed",
]);
const ERROR_STAGES = new Set([
  "scorer_input",
  "scorer_materialization",
  "scorer_inference",
  "scorer_validation",
  "scorer_io",
  "scorer_process",
]);
const ERROR_TYPES = new Set([
  "input",
  "artifact",
  "inference",
  "validation",
  "io",
  "timeout",
  "cancelled",
  "unknown",
]);

export interface PreferenceV2ScorerErrorEnvelope {
  readonly schemaVersion: typeof PREFERENCE_V2_SCORER_ERROR_SCHEMA;
  readonly code: string;
  readonly stage: string;
  readonly retryable: boolean;
  readonly message: string;
  readonly affectedCount?: number;
  readonly context?: {
    readonly errorType: string;
    readonly exitCode?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && new Set(keys).size === keys.length;
}

function boundedMessage(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= MAX_MESSAGE_LENGTH && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function parsePreferenceV2ScorerErrorEnvelope(
  value: unknown,
): PreferenceV2ScorerErrorEnvelope | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "code",
    "stage",
    "retryable",
    "message",
    "affectedCount",
    "context",
  ]) || value.schemaVersion !== PREFERENCE_V2_SCORER_ERROR_SCHEMA ||
    typeof value.code !== "string" || !ERROR_CODES.has(value.code) ||
    typeof value.stage !== "string" || !ERROR_STAGES.has(value.stage) ||
    typeof value.retryable !== "boolean" || !boundedMessage(value.message)) {
    return null;
  }
  if (value.affectedCount !== undefined &&
    (!Number.isSafeInteger(value.affectedCount) || Number(value.affectedCount) < 0 ||
      Number(value.affectedCount) > 25_000)) return null;
  let context: PreferenceV2ScorerErrorEnvelope["context"];
  if (value.context !== undefined) {
    if (!isRecord(value.context) || !hasExactKeys(value.context, ["errorType", "exitCode"]) ||
      typeof value.context.errorType !== "string" ||
      !ERROR_TYPES.has(value.context.errorType) ||
      (value.context.exitCode !== undefined &&
        (!Number.isSafeInteger(value.context.exitCode) ||
          Number(value.context.exitCode) < -1 || Number(value.context.exitCode) > 255))) {
      return null;
    }
    context = Object.freeze({
      errorType: value.context.errorType,
      ...(value.context.exitCode === undefined
        ? {}
        : { exitCode: Number(value.context.exitCode) }),
    });
  }
  return Object.freeze({
    schemaVersion: PREFERENCE_V2_SCORER_ERROR_SCHEMA,
    code: value.code,
    stage: value.stage,
    retryable: value.retryable,
    message: value.message,
    ...(value.affectedCount === undefined
      ? {}
      : { affectedCount: Number(value.affectedCount) }),
    ...(context === undefined ? {} : { context }),
  });
}

export function parsePreferenceV2ScorerErrorPayload(
  value: string,
): PreferenceV2ScorerErrorEnvelope | null {
  if (value.length < 1 || value.length > MAX_PROCESS_OUTPUT_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["status", "scorerError"]) ||
    parsed.status !== "error") return null;
  return parsePreferenceV2ScorerErrorEnvelope(parsed.scorerError);
}

export function genericPreferenceV2ScorerError(
  exitCode: number | null,
): PreferenceV2ScorerErrorEnvelope {
  return Object.freeze({
    schemaVersion: PREFERENCE_V2_SCORER_ERROR_SCHEMA,
    code: "preference_v2_scorer_failed",
    stage: "scorer_process",
    retryable: false,
    message: "Preference V2 scorer failed.",
    context: Object.freeze({
      errorType: "unknown",
      ...(exitCode === null ? {} : { exitCode }),
    }),
  });
}

export function timeoutPreferenceV2ScorerError(): PreferenceV2ScorerErrorEnvelope {
  return Object.freeze({
    schemaVersion: PREFERENCE_V2_SCORER_ERROR_SCHEMA,
    code: "preference_v2_timeout",
    stage: "scorer_process",
    retryable: true,
    message: "Preference V2 scorer exceeded its bounded session deadline.",
    context: Object.freeze({ errorType: "timeout" }),
  });
}

export class PreferenceV2ScorerProcessError extends Error {
  readonly scorerError: PreferenceV2ScorerErrorEnvelope;

  constructor(scorerError: PreferenceV2ScorerErrorEnvelope) {
    super(scorerError.message);
    this.name = "PreferenceV2ScorerProcessError";
    this.scorerError = scorerError;
  }
}

export function preferenceV2ScorerProcessFailure(input: {
  readonly stdout: string;
  readonly exitCode: number | null;
}): PreferenceV2ScorerProcessError {
  const lines = input.stdout.length <= MAX_PROCESS_OUTPUT_LENGTH
    ? input.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    : [];
  const parsed = lines.length === 1
    ? parsePreferenceV2ScorerErrorPayload(lines[0]!)
    : null;
  if (parsed === null) return new PreferenceV2ScorerProcessError(
    genericPreferenceV2ScorerError(input.exitCode),
  );
  const context = Object.freeze({
    errorType: parsed.context?.errorType ?? "unknown",
    ...(input.exitCode === null ? {} : { exitCode: input.exitCode }),
  });
  return new PreferenceV2ScorerProcessError(Object.freeze({
    ...parsed,
    context,
  }));
}

export function preferenceV2ScorerErrorFromUnknown(
  error: unknown,
): PreferenceV2ScorerErrorEnvelope {
  return error instanceof PreferenceV2ScorerProcessError
    ? error.scorerError
    : genericPreferenceV2ScorerError(null);
}
