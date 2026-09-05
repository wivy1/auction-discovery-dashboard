const MAXIMUM_REPORTED_ROUTE_MILLISECONDS = 600_000;

export type TimedRouteName = "dashboard" | "runs" | "runtime_health";

/** Adds one bounded, payload-free timing metric to a completed API response. */
export async function withRouteTiming(
  route: TimedRouteName,
  operation: () => Promise<Response>,
  clock: () => number = () => performance.now(),
): Promise<Response> {
  const startedAt = clock();
  const response = await operation();
  const duration = boundedMilliseconds(clock() - startedAt);
  const headers = new Headers(response.headers);
  headers.set(
    "server-timing",
    `${route};dur=${duration};desc="status_${response.status}"`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function boundedMilliseconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(
    Math.min(MAXIMUM_REPORTED_ROUTE_MILLISECONDS, Math.max(0, value)) * 1_000,
  ) / 1_000;
}
