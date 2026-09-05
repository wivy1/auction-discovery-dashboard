export const runStatusValues = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof runStatusValues)[number];
export type RunTrigger = "manual" | "scheduled";

export interface SourceRunStatus {
  readonly sourceId: string;
  readonly status: RunStatus;
  readonly stubsDiscovered: number;
  readonly skippedAlreadySeen: number;
  readonly detailsFetched: number;
  readonly listingsAccepted: number;
  readonly listingsExcluded: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

