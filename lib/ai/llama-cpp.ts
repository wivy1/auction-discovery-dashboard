import { AiProviderError } from "./errors";
import { defaultRetryPolicy, withRetry } from "./retry";
import type {
  GenerationCapacity,
  GenerationRequest,
  ProviderHealth,
  ProviderResult,
  RetryPolicy,
  StructuredGenerationRequest,
  TextGenerationProvider,
} from "./types";

export interface LlamaCppOllamaTextProviderOptions {
  readonly modelName: string;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly fetch?: typeof globalThis.fetch;
  readonly unloadPollIntervalMs?: number;
}

interface LlamaCppPropsResponse {
  is_sleeping?: boolean;
  model_path?: string;
  total_slots?: number;
}

interface LlamaCppChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  requestDurationMs?: number;
}

export class LlamaCppOllamaTextProvider implements TextGenerationProvider {
  readonly providerName = "ollama";
  readonly modelName: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly unloadPollIntervalMs: number;

  constructor(options: LlamaCppOllamaTextProviderOptions) {
    if (!options.modelName.trim()) {
      throw new AiProviderError({
        message: "llama.cpp model name is required",
        code: "configuration",
        providerName: "ollama",
      });
    }
    this.modelName = options.modelName;
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = positiveInteger(options.timeoutMs, 60_000);
    this.retryPolicy = options.retryPolicy ?? defaultRetryPolicy;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.unloadPollIntervalMs = positiveInteger(
      options.unloadPollIntervalMs,
      100,
    );
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const props = await this.requestJson<LlamaCppPropsResponse>(
        "/props",
        { method: "GET" },
        this.timeoutMs,
        signal,
      );
      validateProps(props, this.modelName);
      return {
        ok: true,
        providerName: this.providerName,
        modelName: this.modelName,
        modelAvailable: true,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        ok: false,
        providerName: this.providerName,
        modelName: this.modelName,
        modelAvailable: false,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        message:
          error instanceof Error
            ? error.message
            : "llama.cpp health check failed",
      };
    }
  }

  async generationCapacity(signal?: AbortSignal): Promise<GenerationCapacity> {
    const props = await this.requestJson<LlamaCppPropsResponse>(
      "/props",
      { method: "GET" },
      this.timeoutMs,
      signal,
    );
    validateProps(props, this.modelName);
    const providerSlots = props.total_slots!;
    return Object.freeze({
      maximumConcurrentGenerations: providerSlots >= 2 ? 2 : 1,
      providerSlots,
      evidence: "provider_reported_slots" as const,
    });
  }

  async unload(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      if (signal?.aborted) throw signal.reason;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw this.unloadTimeout();

      const props = await this.requestJsonOnce<LlamaCppPropsResponse>(
        "/props",
        { method: "GET" },
        remainingMs,
        signal,
      );
      validateProps(props, this.modelName);
      if (props.is_sleeping === true) return;

      const delayMs = Math.min(
        this.unloadPollIntervalMs,
        deadline - Date.now(),
      );
      if (delayMs <= 0) throw this.unloadTimeout();
      await abortableDelay(delayMs, signal);
    }
  }

  async generateText(
    request: GenerationRequest,
  ): Promise<ProviderResult<string>> {
    const response = await this.chat(request);
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw this.invalidResponse(
        "llama.cpp response did not contain generated text",
      );
    }
    return result(content, this, response);
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<ProviderResult<T>> {
    const response = await this.chat(request, request.jsonSchema);
    const content = response.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw this.invalidResponse(
        "llama.cpp response did not contain structured output",
      );
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(stripJsonFence(content));
    } catch (cause) {
      throw new AiProviderError({
        message: "llama.cpp structured output was not valid JSON",
        code: "invalid_response",
        providerName: this.providerName,
        modelName: this.modelName,
        cause,
      });
    }

    let value: T;
    try {
      value = request.parse(decoded);
    } catch (cause) {
      throw new AiProviderError({
        message: "llama.cpp structured output failed runtime validation",
        code: "validation_failed",
        providerName: this.providerName,
        modelName: this.modelName,
        cause,
      });
    }
    return result(value, this, response);
  }

  private async chat(
    request: GenerationRequest,
    jsonSchema?: Readonly<Record<string, unknown>>,
  ): Promise<LlamaCppChatResponse> {
    if (!request.prompt.trim()) {
      return Promise.reject(
        new AiProviderError({
          message: "generation prompt is required",
          code: "configuration",
          providerName: this.providerName,
          modelName: this.modelName,
        }),
      );
    }
    const messages = [
      ...(request.system?.trim()
        ? [{ role: "system", content: request.system.trim() }]
        : []),
      { role: "user", content: request.prompt },
    ];
    const started = Date.now();
    const response = await this.requestJson<LlamaCppChatResponse>(
      "/v1/chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.modelName,
          messages,
          ...(request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
          ...(request.maxOutputTokens === undefined
            ? {}
            : { max_tokens: request.maxOutputTokens }),
          ...(jsonSchema
            ? {
                response_format: {
                  type: "json_schema",
                  json_schema: {
                    name: "structured_response",
                    strict: true,
                    schema: jsonSchema,
                  },
                },
              }
            : {}),
        }),
      },
      request.timeoutMs ?? this.timeoutMs,
      request.signal,
    );
    return { ...response, requestDurationMs: Date.now() - started };
  }

  private requestJson<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return withRetry(
      () => this.requestJsonOnce<T>(path, init, timeoutMs, signal),
      this.retryPolicy,
      signal,
    );
  }

  private async requestJsonOnce<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const effectiveTimeoutMs = positiveInteger(timeoutMs, this.timeoutMs);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs);
    const abortFromCaller = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const retriable = response.status === 429 || response.status >= 500;
        throw new AiProviderError({
          message: `llama.cpp request failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
          code: response.status === 429 ? "rate_limited" : "request_failed",
          providerName: this.providerName,
          modelName: this.modelName,
          retriable,
          status: response.status,
        });
      }
      try {
        return (await response.json()) as T;
      } catch (cause) {
        throw new AiProviderError({
          message: "llama.cpp returned invalid JSON",
          code: "invalid_response",
          providerName: this.providerName,
          modelName: this.modelName,
          cause,
        });
      }
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (timedOut) {
        throw new AiProviderError({
          message: `llama.cpp request timed out after ${effectiveTimeoutMs}ms`,
          code: "timeout",
          providerName: this.providerName,
          modelName: this.modelName,
          retriable: true,
          cause: error,
        });
      }
      if (signal?.aborted) throw signal.reason;
      throw new AiProviderError({
        message: "llama.cpp is unavailable",
        code: "unavailable",
        providerName: this.providerName,
        modelName: this.modelName,
        retriable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private invalidResponse(message: string): AiProviderError {
    return new AiProviderError({
      message,
      code: "invalid_response",
      providerName: this.providerName,
      modelName: this.modelName,
    });
  }

  private unloadTimeout(): AiProviderError {
    return new AiProviderError({
      message: `llama.cpp did not enter sleep within ${this.timeoutMs}ms`,
      code: "timeout",
      providerName: this.providerName,
      modelName: this.modelName,
    });
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new AiProviderError({
      message: "llama.cpp base URL must be a valid URL",
      code: "configuration",
      providerName: "ollama",
      cause,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AiProviderError({
      message: "llama.cpp base URL must use http or https",
      code: "configuration",
      providerName: "ollama",
    });
  }
  return url.toString().replace(/\/$/, "");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function validateProps(
  props: LlamaCppPropsResponse,
  modelName: string,
): void {
  if (
    typeof props.is_sleeping !== "boolean" ||
    typeof props.model_path !== "string" ||
    !Number.isSafeInteger(props.total_slots) || (props.total_slots ?? 0) < 1
  ) {
    throw new AiProviderError({
      message: "llama.cpp returned malformed server properties",
      code: "invalid_response",
      providerName: "ollama",
      modelName,
    });
  }
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function result<T>(
  value: T,
  provider: LlamaCppOllamaTextProvider,
  response: LlamaCppChatResponse,
): ProviderResult<T> {
  return {
    value,
    providerName: provider.providerName,
    modelName: provider.modelName,
    generatedAt: new Date().toISOString(),
    usage: {
      loadDurationMs: 0,
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
      totalDurationMs: response.requestDurationMs,
    },
  };
}
