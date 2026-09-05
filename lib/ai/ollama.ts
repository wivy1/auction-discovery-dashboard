import {
  AiProviderError,
  captureAiInvalidAttemptEvidence,
  type AiInvalidAttemptEvidence,
} from "./errors";
import { defaultRetryPolicy, withRetry } from "./retry";
import type {
  EmbeddingBatch,
  EmbeddingProvider,
  EmbeddingRequest,
  GenerationRequest,
  ProviderHealth,
  ProviderResult,
  RetryPolicy,
  StructuredGenerationRequest,
  TextGenerationProvider,
} from "./types";

export interface OllamaProviderOptions {
  readonly modelName: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly keepAlive?: string | number;
  readonly retryPolicy?: RetryPolicy;
  readonly fetch?: typeof globalThis.fetch;
}

interface OllamaModelsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

interface OllamaChatResponse {
  message?: { content?: string };
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  total_duration?: number;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  load_duration?: number;
  prompt_eval_count?: number;
  total_duration?: number;
}

const QWEN36_STRUCTURED_ASSISTANT_PREFILL = "<think>\n\n</think>\n\n";

abstract class OllamaProviderBase {
  readonly providerName = "ollama";
  readonly modelName: string;
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  protected readonly keepAlive?: string | number;
  protected readonly retryPolicy: RetryPolicy;
  protected readonly fetchImpl: typeof globalThis.fetch;
  private readonly exactResponseText = new WeakMap<object, string>();

  constructor(options: OllamaProviderOptions) {
    if (!options.modelName.trim()) {
      throw new AiProviderError({
        message: "Ollama model name is required",
        code: "configuration",
        providerName: "ollama",
      });
    }
    this.modelName = options.modelName.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "http://localhost:11434");
    this.timeoutMs = positiveInteger(options.timeoutMs, 60_000);
    this.keepAlive = options.keepAlive;
    this.retryPolicy = options.retryPolicy ?? defaultRetryPolicy;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const payload = await this.requestJson<OllamaModelsResponse>(
        "/api/tags",
        { method: "GET" },
        this.timeoutMs,
        signal,
      );
      const available = (payload.models ?? []).some((model) =>
        modelNamesMatch(model.name ?? model.model ?? "", this.modelName),
      );
      return {
        ok: available,
        providerName: this.providerName,
        modelName: this.modelName,
        modelAvailable: available,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        message: available ? undefined : `Model ${this.modelName} is not installed in Ollama`,
      };
    } catch (error) {
      return {
        ok: false,
        providerName: this.providerName,
        modelName: this.modelName,
        modelAvailable: false,
        latencyMs: Date.now() - started,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : "Ollama health check failed",
      };
    }
  }

  /**
   * Ollama's empty generate request with keep_alive=0 releases this exact
   * model without starting another inference. Bounded enrichment calls this
   * between its text and embedding stages so the models never co-reside.
   */
  async unload(signal?: AbortSignal): Promise<void> {
    await this.requestJson<unknown>(
      "/api/generate",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.modelName,
          stream: false,
          keep_alive: 0,
        }),
      },
      this.timeoutMs,
      signal,
    );
  }

  protected async requestJson<T>(
    path: string,
    init: RequestInit,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return withRetry(
      async () => {
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, positiveInteger(timeoutMs, this.timeoutMs));
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
              message: `Ollama request failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`,
              code: response.status === 429 ? "rate_limited" : "request_failed",
              providerName: this.providerName,
              modelName: this.modelName,
              retriable,
              status: response.status,
            });
          }
          const responseText = await response.text();
          try {
            const value = JSON.parse(responseText) as T;
            if (typeof value === "object" && value !== null) {
              this.exactResponseText.set(value, responseText);
            }
            return value;
          } catch (cause) {
            throw new AiProviderError({
              message: "Ollama returned invalid JSON",
              code: "invalid_response",
              providerName: this.providerName,
              modelName: this.modelName,
              invalidAttemptEvidence: await captureAiInvalidAttemptEvidence(
                responseText,
              ),
              cause,
            });
          }
        } catch (error) {
          if (error instanceof AiProviderError) throw error;
          if (timedOut) {
            throw new AiProviderError({
              message: `Ollama request timed out after ${timeoutMs}ms`,
              code: "timeout",
              providerName: this.providerName,
              modelName: this.modelName,
              retriable: true,
              cause: error,
            });
          }
          if (signal?.aborted) throw signal.reason;
          throw new AiProviderError({
            message: "Ollama is unavailable",
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
      },
      this.retryPolicy,
      signal,
    );
  }

  protected async invalidAttemptEvidence(
    response: object,
  ): Promise<AiInvalidAttemptEvidence> {
    const responseText = this.exactResponseText.get(response) ??
      JSON.stringify(response);
    return captureAiInvalidAttemptEvidence(responseText);
  }
}

export class OllamaTextProvider
  extends OllamaProviderBase
  implements TextGenerationProvider
{
  async generateText(
    request: GenerationRequest,
  ): Promise<ProviderResult<string>> {
    const response = await this.chat(request);
    const content = response.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw this.invalidResponse(
        "Ollama response did not contain generated text",
        await this.invalidAttemptEvidence(response),
      );
    }
    return result(content, this, response);
  }

  async generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<ProviderResult<T>> {
    const response = await this.chat(request, request.jsonSchema);
    const content = response.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw this.invalidResponse(
        "Ollama response did not contain structured output",
        await this.invalidAttemptEvidence(response),
      );
    }

    const invalidAttemptEvidence = await this.invalidAttemptEvidence(response);

    let decoded: unknown;
    try {
      decoded = JSON.parse(stripJsonFence(content));
    } catch (cause) {
      throw new AiProviderError({
        message: "Ollama structured output was not valid JSON",
        code: "invalid_response",
        providerName: this.providerName,
        modelName: this.modelName,
        invalidAttemptEvidence,
        cause,
      });
    }

    let value: T;
    try {
      value = request.parse(decoded);
    } catch (cause) {
      throw new AiProviderError({
        message: "Ollama structured output failed runtime validation",
        code: "validation_failed",
        providerName: this.providerName,
        modelName: this.modelName,
        invalidAttemptEvidence,
        cause,
      });
    }
    return result(value, this, response);
  }

  private chat(
    request: GenerationRequest,
    format?: Readonly<Record<string, unknown>>,
  ): Promise<OllamaChatResponse> {
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
      ...(format && isQwen36Model(this.modelName)
        ? [{ role: "assistant", content: QWEN36_STRUCTURED_ASSISTANT_PREFILL }]
        : []),
    ];
    const keepAlive = request.keepAlive ?? this.keepAlive;
    return this.requestJson<OllamaChatResponse>(
      "/api/chat",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.modelName,
          messages,
          stream: false,
          ...(format ? { think: false } : {}),
          ...(format ? { format } : {}),
          ...(keepAlive === undefined ? {} : { keep_alive: keepAlive }),
          options: {
            ...(request.temperature === undefined
              ? {}
              : { temperature: request.temperature }),
            ...(request.maxOutputTokens === undefined
              ? {}
              : { num_predict: request.maxOutputTokens }),
          },
        }),
      },
      request.timeoutMs ?? this.timeoutMs,
      request.signal,
    );
  }

  private invalidResponse(
    message: string,
    invalidAttemptEvidence?: AiInvalidAttemptEvidence,
  ): AiProviderError {
    return new AiProviderError({
      message,
      code: "invalid_response",
      providerName: this.providerName,
      modelName: this.modelName,
      invalidAttemptEvidence,
    });
  }
}

export class OllamaEmbeddingProvider
  extends OllamaProviderBase
  implements EmbeddingProvider
{
  async embed(
    request: EmbeddingRequest,
  ): Promise<ProviderResult<EmbeddingBatch>> {
    if (request.inputs.length === 0) {
      return {
        value: { vectors: [], dimensions: 0 },
        providerName: this.providerName,
        modelName: this.modelName,
        generatedAt: new Date().toISOString(),
      };
    }
    if (request.inputs.some((input) => !input.trim())) {
      throw new AiProviderError({
        message: "embedding inputs must be non-empty strings",
        code: "configuration",
        providerName: this.providerName,
        modelName: this.modelName,
      });
    }
    const keepAlive = request.keepAlive ?? this.keepAlive;
    const response = await this.requestJson<OllamaEmbedResponse>(
      "/api/embed",
      {
        method: "POST",
        body: JSON.stringify({
          model: this.modelName,
          input: request.inputs,
          ...(keepAlive === undefined ? {} : { keep_alive: keepAlive }),
        }),
      },
      request.timeoutMs ?? this.timeoutMs,
      request.signal,
    );
    const vectors = response.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== request.inputs.length) {
      throw new AiProviderError({
        message: "Ollama returned the wrong number of embeddings",
        code: "invalid_response",
        providerName: this.providerName,
        modelName: this.modelName,
      });
    }
    const dimensions = vectors[0]?.length ?? 0;
    if (
      dimensions === 0 ||
      vectors.some(
        (vector) =>
          vector.length !== dimensions || vector.some((value) => !Number.isFinite(value)),
      )
    ) {
      throw new AiProviderError({
        message: "Ollama returned malformed embedding vectors",
        code: "invalid_response",
        providerName: this.providerName,
        modelName: this.modelName,
      });
    }
    return {
      value: { vectors, dimensions },
      providerName: this.providerName,
      modelName: this.modelName,
      generatedAt: new Date().toISOString(),
      usage: {
        loadDurationMs: nanosecondsToMilliseconds(response.load_duration),
        inputTokens: response.prompt_eval_count,
        outputTokens: 0,
        totalDurationMs: nanosecondsToMilliseconds(response.total_duration),
      },
    };
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new AiProviderError({
      message: "OLLAMA_BASE_URL must be a valid URL",
      code: "configuration",
      providerName: "ollama",
      cause,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AiProviderError({
      message: "OLLAMA_BASE_URL must use http or https",
      code: "configuration",
      providerName: "ollama",
    });
  }
  return url.toString().replace(/\/$/, "");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? value! : fallback;
}

function modelNamesMatch(installed: string, configured: string): boolean {
  if (installed === configured) return true;
  return !configured.includes(":") && installed === `${configured}:latest`;
}

function isQwen36Model(modelName: string): boolean {
  return /^qwen3\.6(?::|$)/iu.test(modelName);
}

function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function nanosecondsToMilliseconds(value: number | undefined): number | undefined {
  return typeof value === "number" ? value / 1_000_000 : undefined;
}

function result<T>(
  value: T,
  provider: OllamaProviderBase,
  response: OllamaChatResponse,
): ProviderResult<T> {
  return {
    value,
    providerName: provider.providerName,
    modelName: provider.modelName,
    generatedAt: new Date().toISOString(),
    usage: {
      loadDurationMs: nanosecondsToMilliseconds(response.load_duration),
      inputTokens: response.prompt_eval_count,
      outputTokens: response.eval_count,
      totalDurationMs: nanosecondsToMilliseconds(response.total_duration),
    },
  };
}
