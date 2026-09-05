import { AiProviderError, isAiProviderError } from "./errors";
import type { RetryPolicy } from "./types";

export const defaultRetryPolicy: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
});

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  policy: RetryPolicy = defaultRetryPolicy,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= Math.max(1, policy.maxAttempts); attempt += 1) {
    if (signal?.aborted) throw signal.reason;
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      const retryable = isAiProviderError(error) && error.retriable;
      if (!retryable || attempt >= policy.maxAttempts) throw error;
      const exponential = policy.initialDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * Math.max(1, exponential * 0.2));
      await delay(Math.min(policy.maxDelayMs, exponential + jitter), signal);
    }
  }
  throw lastError ?? new AiProviderError({
    message: "AI request failed",
    code: "request_failed",
    providerName: "unknown",
  });
}

