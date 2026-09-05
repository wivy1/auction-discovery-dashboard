export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "request_failed",
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function jsonError(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  console.error(error);
  return Response.json({ error: message, code: "internal_error" }, { status: 500 });
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError("Expected an application/json request body", 415, "invalid_content_type");
  }

  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError("Request body is not valid JSON", 400, "invalid_json");
  }
}

export function parseLimit(value: string | null, fallback = 100, maximum = 500): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}
