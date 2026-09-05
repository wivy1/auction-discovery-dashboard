import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

export interface ScheduleState {
  readonly outcome: "read" | "saved" | "removed" | "failed";
  readonly available: boolean;
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly scheduleKind: "weekly" | "legacy_daily" | null;
  readonly weekdays: readonly ScheduleWeekday[] | null;
  readonly localTime: string | null;
  readonly state: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly lastResult: number | null;
  readonly error?: string;
}

export interface ScheduleUpdate {
  readonly weekdays: readonly ScheduleWeekday[];
  readonly localTime: string;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
export type ScheduleWeekday = typeof WEEKDAYS[number];

const LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_OUTPUT_BYTES = 16 * 1_024;
const DEFAULT_TIMEOUT_MS = 15_000;

export function parseScheduleLocalTime(value: unknown): string | null {
  return typeof value === "string" && LOCAL_TIME.test(value) ? value : null;
}

function isScheduleWeekday(value: unknown): value is ScheduleWeekday {
  return typeof value === "string" && WEEKDAYS.includes(value as ScheduleWeekday);
}

function normalizedWeekdays(value: unknown): ScheduleWeekday[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  if (!value.every(isScheduleWeekday) || new Set(value).size !== value.length) return null;
  return WEEKDAYS.filter((weekday) => value.includes(weekday));
}

function isNormalizedWeekdays(value: unknown): value is ScheduleWeekday[] {
  const normalized = normalizedWeekdays(value);
  return Array.isArray(value) &&
    normalized !== null &&
    normalized.every((weekday, index) => weekday === value[index]);
}

export function parseScheduleUpdateBody(body: string): ScheduleUpdate | null {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 2 ||
      !("weekdays" in parsed) ||
      !("localTime" in parsed)
    ) {
      return null;
    }
    const weekdays = normalizedWeekdays(parsed.weekdays);
    const localTime = parseScheduleLocalTime(parsed.localTime);
    return weekdays && localTime ? { weekdays, localTime } : null;
  } catch {
    return null;
  }
}

export function parseScheduleOutput(stdout: string): ScheduleState {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const candidate = lines.at(-1);
  if (!candidate) throw new Error("Schedule control returned no state");
  const value = JSON.parse(candidate) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Schedule control returned an invalid state");
  }
  let parsed = value as Record<string, unknown>;
  const hasNewRecurrence = ["scheduleKind", "weekdays", "localTime"]
    .some((key) => key in parsed);
  if (!hasNewRecurrence && "dailyAt" in parsed) {
    const dailyAt = parsed.dailyAt;
    if (dailyAt !== null && parseScheduleLocalTime(dailyAt) === null) {
      throw new Error("Schedule control returned an invalid state");
    }
    const legacyState = { ...parsed };
    delete legacyState.dailyAt;
    parsed = {
      ...legacyState,
      scheduleKind: dailyAt === null ? null : "legacy_daily",
      weekdays: null,
      localTime: dailyAt,
    };
  } else if ("dailyAt" in parsed) {
    throw new Error("Schedule control returned an invalid state");
  }

  const recurrenceValid =
    (parsed.scheduleKind === null &&
      parsed.weekdays === null &&
      parsed.localTime === null &&
      parsed.configured === false &&
      parsed.enabled === false) ||
    (parsed.scheduleKind === "weekly" &&
      parsed.configured === true &&
      isNormalizedWeekdays(parsed.weekdays) &&
      parseScheduleLocalTime(parsed.localTime) !== null) ||
    (parsed.scheduleKind === "legacy_daily" &&
      parsed.configured === true &&
      parsed.weekdays === null &&
      parseScheduleLocalTime(parsed.localTime) !== null);
  if (
    typeof parsed.available !== "boolean" ||
    typeof parsed.configured !== "boolean" ||
    typeof parsed.enabled !== "boolean" ||
    typeof parsed.state !== "string" ||
    !["read", "saved", "removed", "failed"].includes(String(parsed.outcome ?? "")) ||
    (parsed.nextRunAt !== null && typeof parsed.nextRunAt !== "string") ||
    (parsed.lastRunAt !== null && typeof parsed.lastRunAt !== "string") ||
    (parsed.lastResult !== null && typeof parsed.lastResult !== "number") ||
    (parsed.error !== undefined && typeof parsed.error !== "string") ||
    !recurrenceValid
  ) {
    throw new Error("Schedule control returned an invalid state");
  }
  return parsed as unknown as ScheduleState;
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot?.trim() || "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

function scriptPath(): string {
  return fileURLToPath(new URL("./schedule-task.ps1", import.meta.url));
}

export async function runScheduleControl(
  action: "Get" | "Set" | "Remove",
  schedule?: ScheduleUpdate,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ScheduleState> {
  if (
    action === "Set" &&
    (!schedule ||
      !isNormalizedWeekdays(schedule.weekdays) ||
      parseScheduleLocalTime(schedule.localTime) === null)
  ) {
    throw new Error("One or two canonical weekdays and a valid 24-hour HH:mm time are required");
  }
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath(),
    "-Action",
    action,
  ];
  if (action === "Set" && schedule) {
    args.push("-Weekdays", schedule.weekdays.join(","), "-LocalTime", schedule.localTime);
  }

  return await new Promise<ScheduleState>((resolve, reject) => {
    execFile(
      powershellPath(),
      args,
      {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout) => {
        try {
          const state = parseScheduleOutput(stdout);
          if (error && state.outcome !== "failed") {
            reject(error);
            return;
          }
          resolve(state);
        } catch (parseError) {
          reject(error ?? parseError);
        }
      },
    );
  });
}
