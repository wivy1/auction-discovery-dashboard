export type RoutingErrorCode =
  | "configuration"
  | "unavailable"
  | "timeout"
  | "rate_limited"
  | "request_failed"
  | "invalid_response";

export class RoutingProviderError extends Error {
  readonly code: RoutingErrorCode;
  readonly providerName: string;
  readonly retriable: boolean;
  readonly status?: number;

  constructor(options: {
    message: string;
    code: RoutingErrorCode;
    providerName: string;
    retriable?: boolean;
    status?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "RoutingProviderError";
    this.code = options.code;
    this.providerName = options.providerName;
    this.retriable = options.retriable ?? false;
    this.status = options.status;
  }
}

export function routingFailureCode(error: unknown): string {
  if (error instanceof RoutingProviderError) {
    return error.status === 400 ? "no_route" : error.code;
  }
  return "request_failed";
}
