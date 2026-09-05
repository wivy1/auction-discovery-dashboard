export type JsonSchema = Readonly<Record<string, unknown>>;

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export interface ProviderHealth {
  readonly ok: boolean;
  readonly providerName: string;
  readonly modelName: string;
  readonly modelAvailable: boolean;
  readonly latencyMs: number;
  readonly checkedAt: string;
  readonly message?: string;
}

export interface GenerationCapacity {
  readonly maximumConcurrentGenerations: 1 | 2;
  readonly providerSlots: number;
  readonly evidence: "provider_reported_slots";
}

export interface GenerationUsage {
  readonly loadDurationMs?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalDurationMs?: number;
}

export interface ProviderResult<T> {
  readonly value: T;
  readonly providerName: string;
  readonly modelName: string;
  readonly generatedAt: string;
  readonly usage?: GenerationUsage;
}

export interface GenerationRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  /** Per-request residency override used by bounded stage-grouped local batches. */
  readonly keepAlive?: string | number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface StructuredGenerationRequest<T> extends GenerationRequest {
  readonly jsonSchema: JsonSchema;
  /** Runtime validation/transformation owned by domain code, not the provider. */
  readonly parse: (value: unknown) => T;
}

export interface EmbeddingRequest {
  readonly inputs: readonly string[];
  /** Per-request residency override used by bounded stage-grouped local batches. */
  readonly keepAlive?: string | number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface EmbeddingBatch {
  readonly vectors: readonly (readonly number[])[];
  readonly dimensions: number;
}

export interface TextGenerationProvider {
  readonly providerName: string;
  readonly modelName: string;
  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;
  /** Optional bounded provider capability proof; absence must fall back to one. */
  generationCapacity?(signal?: AbortSignal): Promise<GenerationCapacity>;
  /** Releases local model residency when the provider supports it. */
  unload?(signal?: AbortSignal): Promise<void>;
  generateText(request: GenerationRequest): Promise<ProviderResult<string>>;
  generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<ProviderResult<T>>;
}

export interface EmbeddingProvider {
  readonly providerName: string;
  readonly modelName: string;
  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;
  /** Releases local model residency when the provider supports it. */
  unload?(signal?: AbortSignal): Promise<void>;
  embed(request: EmbeddingRequest): Promise<ProviderResult<EmbeddingBatch>>;
}

export interface AiProviders {
  readonly text: TextGenerationProvider;
  readonly embeddings: EmbeddingProvider;
}

export interface AiOutputProvenance {
  readonly providerName: string;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly inputHash: string;
  readonly generatedAt: string;
}
