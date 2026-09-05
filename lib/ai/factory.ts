import { AiProviderError } from "./errors";
import { disabledAiProviders } from "./disabled";
import { LlamaCppOllamaTextProvider } from "./llama-cpp";
import { OllamaEmbeddingProvider, OllamaTextProvider } from "./ollama";
import type { AiProviders, RetryPolicy } from "./types";

export type AiProviderName = "ollama" | "openai" | "disabled";
export type OllamaTextTransport = "ollama" | "llama_cpp";

export interface AiConfig {
  readonly textProvider: AiProviderName;
  readonly textModel: string;
  readonly embeddingProvider: AiProviderName;
  readonly embeddingModel: string;
  readonly ollamaBaseUrl: string;
  readonly ollamaTextTransport: OllamaTextTransport;
  readonly ollamaTextBaseUrl?: string;
  readonly ollamaEmbeddingBaseUrl?: string;
  readonly ollamaKeepAlive?: string | number;
  readonly timeoutMs: number;
  readonly retryPolicy?: RetryPolicy;
}

type Environment = Readonly<Record<string, string | undefined>>;

function defaultEnvironment(): Environment {
  return typeof process === "undefined" ? {} : process.env;
}

export function readAiConfig(env: Environment = defaultEnvironment()): AiConfig {
  const ollamaBaseUrl = env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";
  return {
    textProvider: providerName(env.AI_TEXT_PROVIDER?.trim() || "disabled", "AI_TEXT_PROVIDER"),
    textModel: env.AI_TEXT_MODEL?.trim() || "",
    embeddingProvider: providerName(
      env.AI_EMBEDDING_PROVIDER?.trim() || "disabled",
      "AI_EMBEDDING_PROVIDER",
    ),
    embeddingModel: env.AI_EMBEDDING_MODEL?.trim() || "",
    ollamaBaseUrl,
    ollamaTextTransport: textTransport(
      env.OLLAMA_TEXT_TRANSPORT ?? "ollama",
    ),
    ollamaTextBaseUrl: env.OLLAMA_TEXT_BASE_URL?.trim() || ollamaBaseUrl,
    ollamaEmbeddingBaseUrl:
      env.OLLAMA_EMBEDDING_BASE_URL?.trim() || ollamaBaseUrl,
    ollamaKeepAlive: parseKeepAlive(env.OLLAMA_KEEP_ALIVE),
    timeoutMs: parsePositiveInteger(env.AI_TIMEOUT_MS, 60_000, "AI_TIMEOUT_MS"),
    retryPolicy: {
      maxAttempts:
        parseNonNegativeInteger(env.AI_MAX_RETRIES, 2, "AI_MAX_RETRIES") + 1,
      initialDelayMs: 250,
      maxDelayMs: 2_000,
    },
  };
}

export function createAiProviders(config: AiConfig = readAiConfig()): AiProviders {
  if (config.textProvider === "disabled" || config.embeddingProvider === "disabled" ||
    !config.textModel.trim() || !config.embeddingModel.trim()) return disabledAiProviders();
  const shared = {
    timeoutMs: config.timeoutMs,
    keepAlive: config.ollamaKeepAlive,
    retryPolicy: config.retryPolicy,
  };

  const text = (() => {
    switch (config.textProvider) {
      case "ollama":
        return config.ollamaTextTransport === "llama_cpp"
          ? new LlamaCppOllamaTextProvider({
              timeoutMs: config.timeoutMs,
              retryPolicy: config.retryPolicy,
              baseUrl: config.ollamaTextBaseUrl ?? config.ollamaBaseUrl,
              modelName: config.textModel,
            })
          : new OllamaTextProvider({
              ...shared,
              baseUrl: config.ollamaTextBaseUrl ?? config.ollamaBaseUrl,
              modelName: config.textModel,
            });
      case "openai":
        return unsupportedOpenAi("text", config.textModel);
    }
  })();

  const embeddings = (() => {
    switch (config.embeddingProvider) {
      case "ollama":
        return new OllamaEmbeddingProvider({
          ...shared,
          baseUrl: config.ollamaEmbeddingBaseUrl ?? config.ollamaBaseUrl,
          modelName: config.embeddingModel,
        });
      case "openai":
        return unsupportedOpenAi("embedding", config.embeddingModel);
    }
  })();

  return { text, embeddings };
}

/**
 * Builds the provider pair used by bounded backlog work. Zero remains the
 * fail-safe residency default even if an operator supplies a longer global
 * value. The dedicated backlog may use a finite per-request override while a
 * single text stage is active, then explicitly unload before embedding.
 */
export function createSequentialEnrichmentProviders(
  config: AiConfig = readAiConfig(),
): AiProviders {
  return createAiProviders(sequentialEnrichmentConfig(config));
}

export function sequentialEnrichmentConfig(config: AiConfig): AiConfig {
  return { ...config, ollamaKeepAlive: 0 };
}

function providerName(value: string, field: string): AiProviderName {
  const normalized = value.trim().toLowerCase();
  if (normalized === "ollama" || normalized === "openai" || normalized === "disabled") return normalized;
  throw new AiProviderError({
    message: `${field} must be 'ollama' or 'openai'`,
    code: "configuration",
    providerName: normalized || "unknown",
  });
}

function textTransport(value: string): OllamaTextTransport {
  const normalized = value.trim().toLowerCase();
  if (normalized === "ollama" || normalized === "llama_cpp") return normalized;
  throw new AiProviderError({
    message: "OLLAMA_TEXT_TRANSPORT must be 'ollama' or 'llama_cpp'",
    code: "configuration",
    providerName: "ollama",
  });
}

function unsupportedOpenAi(capability: string, modelName: string): never {
  throw new AiProviderError({
    message: `OpenAI ${capability} provider is a reserved adapter seam but is not installed; add an adapter implementing the provider interface before selecting it`,
    code: "unsupported_provider",
    providerName: "openai",
    modelName,
  });
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  field: string,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AiProviderError({
      message: `${field} must be a positive integer`,
      code: "configuration",
      providerName: "configuration",
    });
  }
  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  field: string,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AiProviderError({
      message: `${field} must be a non-negative integer`,
      code: "configuration",
      providerName: "configuration",
    });
  }
  return parsed;
}

function parseKeepAlive(value: string | undefined): string | number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return normalized;
}
