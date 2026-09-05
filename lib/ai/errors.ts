import { sha256Text } from "./provenance";

export const aiProviderErrorCodes = [
  "configuration",
  "unsupported_provider",
  "unavailable",
  "timeout",
  "rate_limited",
  "request_failed",
  "invalid_response",
  "validation_failed",
] as const;

export type AiProviderErrorCode = (typeof aiProviderErrorCodes)[number];

const MAX_RETAINED_INVALID_RESPONSE_BYTES = 500_000;

/** Exact, bounded provider-response evidence kept off public error messages. */
export interface AiInvalidAttemptEvidence {
  readonly responseText: string | null;
  readonly responseHash: string;
  readonly generatedAt: string;
}

/** Listing provenance attached only after the provider call reaches enrichment. */
export interface AiInvalidAttemptContext {
  readonly listingId: string;
  readonly task: "listing_extraction";
  readonly promptVersion: string;
  readonly inputHash: string;
}

export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode;
  readonly providerName: string;
  readonly modelName?: string;
  readonly retriable: boolean;
  readonly status?: number;
  readonly invalidAttemptEvidence?: AiInvalidAttemptEvidence;
  readonly invalidAttemptContext?: AiInvalidAttemptContext;

  constructor(options: {
    message: string;
    code: AiProviderErrorCode;
    providerName: string;
    modelName?: string;
    retriable?: boolean;
    status?: number;
    invalidAttemptEvidence?: AiInvalidAttemptEvidence;
    invalidAttemptContext?: AiInvalidAttemptContext;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "AiProviderError";
    this.code = options.code;
    this.providerName = options.providerName;
    this.modelName = options.modelName;
    this.retriable = options.retriable ?? false;
    this.status = options.status;
    this.invalidAttemptEvidence = options.invalidAttemptEvidence;
    this.invalidAttemptContext = options.invalidAttemptContext;
  }
}

export function isAiProviderError(error: unknown): error is AiProviderError {
  return error instanceof AiProviderError;
}

export async function captureAiInvalidAttemptEvidence(
  responseText: string,
  generatedAt = new Date().toISOString(),
): Promise<AiInvalidAttemptEvidence> {
  return Object.freeze({
    responseText: isRetainableAiInvalidResponseText(responseText)
      ? responseText
      : null,
    responseHash: await sha256Text(responseText),
    generatedAt,
  });
}

export function bindAiInvalidAttemptContext(
  error: unknown,
  context: AiInvalidAttemptContext,
): unknown {
  if (!isAiProviderError(error) || error.invalidAttemptEvidence === undefined) {
    return error;
  }
  return new AiProviderError({
    message: error.message,
    code: error.code,
    providerName: error.providerName,
    modelName: error.modelName,
    retriable: error.retriable,
    status: error.status,
    invalidAttemptEvidence: error.invalidAttemptEvidence,
    invalidAttemptContext: Object.freeze({ ...context }),
    cause: error,
  });
}

export function isRetainableAiInvalidResponseText(value: string): boolean {
  return value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_RETAINED_INVALID_RESPONSE_BYTES &&
    !credentialBearingValue(value) &&
    !/["'](?:api[_-]?key|authorization|capability|cookie|secret|signedUrl|token)["']\s*:/iu
      .test(value);
}

function credentialBearingValue(value: string): boolean {
  return /(?:^|[?&])(?:x-amz-(?:credential|signature|security-token)|signature|sig|access[_-]?token|auth[_-]?token|capability|signed[_-]?url)=[^&\s]+/iu.test(value) ||
    /(?:^|[\r\n])(?:authorization\s*:\s*)?(?:bearer|basic)\s+[A-Za-z0-9+/_=-]{8,}/iu.test(value) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value);
}
