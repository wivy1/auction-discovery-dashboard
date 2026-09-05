/** Returns a completed run's non-negative wall duration, rounded to seconds. */
export function completedRunDurationSeconds(
  startedAt: unknown,
  completedAt: unknown,
): number | null {
  if (typeof startedAt !== "string" || typeof completedAt !== "string") return null;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) {
    return null;
  }
  const elapsedMs = completed - started;
  if (elapsedMs === 0) return 0;
  return Math.max(1, Math.round(elapsedMs / 1_000));
}

/** Compact duration copy for Settings run summaries. */
export function formatRunDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return "Duration unavailable";
  }
  const wholeSeconds = Math.round(seconds);
  if (wholeSeconds < 60) return `${wholeSeconds}s`;
  const minutes = Math.floor(wholeSeconds / 60);
  const remainingSeconds = wholeSeconds % 60;
  if (minutes < 60) return remainingSeconds > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}
