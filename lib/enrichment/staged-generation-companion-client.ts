import type {
  EnrichmentEmbeddingStageBinding,
  EnrichmentStageBinding,
  EnrichmentStagedGenerationStore,
  StagedEnrichmentEmbeddingResult,
} from "./staged-generation";
import type { PreparedListingEnrichment } from "../pipeline/enrich";
import { isRuntimeRevision, RUNTIME_REVISION_HEADER } from "../runtime-revision";
import {
  ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES,
  ENRICHMENT_STAGING_COMPANION_PATH,
  ENRICHMENT_STAGING_COMPANION_SCHEMA,
  isEnrichmentStagingCompanionFailure,
  type EnrichmentStagingCompanionOperation,
} from "./staged-generation-companion-wire";

export {
  ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES,
  ENRICHMENT_STAGING_COMPANION_SCHEMA,
} from "./staged-generation-companion-wire";

const DEFAULT_COMPANION_BASE_URL = "http://127.0.0.1:32110";
const CAPABILITY_HEADER = "x-auction-discovery-capability";

export interface CompanionEnrichmentStagedGenerationStoreOptions {
  readonly capability: string;
  readonly runtimeRevision: string;
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
  readonly fetchImplementation?: typeof fetch;
}

/** Worker-safe staging adapter; only the revision-bound loopback companion touches files. */
export function companionEnrichmentStagedGenerationStore(
  options: CompanionEnrichmentStagedGenerationStoreOptions,
): EnrichmentStagedGenerationStore {
  const endpoint = companionEndpoint(options.baseUrl ?? DEFAULT_COMPANION_BASE_URL);
  const capability = options.capability.trim();
  if (capability.length < 32 || /[\u0000-\u001f\u007f]/u.test(capability)) {
    throw new Error("enrichment_staged_generation_remote_configuration_invalid");
  }
  if (!isRuntimeRevision(options.runtimeRevision)) {
    throw new Error("enrichment_staged_generation_remote_configuration_invalid");
  }
  const send = options.fetchImplementation ?? fetch;
  const execute = (
    operation: EnrichmentStagingCompanionOperation,
    payload: Record<string, unknown>,
  ) => executeRemoteOperation({
    endpoint,
    capability,
    runtimeRevision: options.runtimeRevision,
    signal: options.signal,
    send,
    operation,
    payload,
  });

  const store: EnrichmentStagedGenerationStore = {
    readListingEnrichment: async ({ binding }) => {
      const result = await execute("read_listing_enrichment", { binding });
      if (result === null) return null;
      if (!validPreparedListingEnrichment(result, binding)) throw invalidResponse();
      return Object.freeze(result as unknown as PreparedListingEnrichment);
    },
    writeListingEnrichment: async ({ binding, prepared }) => {
      const result = await execute("write_listing_enrichment", { binding, prepared });
      if (result !== null) throw invalidResponse();
    },
    readListingEmbeddings: async ({ binding }) => {
      const result = await execute("read_listing_embeddings", { binding });
      if (result === null) return null;
      if (!validEmbeddingResults(result, binding)) throw invalidResponse();
      return Object.freeze(result as unknown as readonly StagedEnrichmentEmbeddingResult[]);
    },
    writeListingEmbeddings: async ({ binding, results }) => {
      const result = await execute("write_listing_embeddings", { binding, results });
      if (result !== null) throw invalidResponse();
    },
  };
  return Object.freeze(store);
}

async function executeRemoteOperation(input: {
  readonly endpoint: string;
  readonly capability: string;
  readonly runtimeRevision: string;
  readonly signal?: AbortSignal;
  readonly send: typeof fetch;
  readonly operation: EnrichmentStagingCompanionOperation;
  readonly payload: Record<string, unknown>;
}): Promise<unknown> {
  const body = JSON.stringify({
    schemaVersion: ENRICHMENT_STAGING_COMPANION_SCHEMA,
    operation: input.operation,
    ...input.payload,
  });
  if (new TextEncoder().encode(body).byteLength > ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES) {
    throw new Error("enrichment_staged_generation_oversized");
  }
  let response: Response;
  try {
    response = await input.send(input.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CAPABILITY_HEADER]: input.capability,
        [RUNTIME_REVISION_HEADER]: input.runtimeRevision,
      },
      body,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted === true) throw error;
    throw remoteFailure();
  }
  const value = await readBoundedResponse(response);
  if (!response.ok) {
    if (isEnrichmentStagingCompanionFailure(value)) {
      throw new Error(value.code);
    }
    throw remoteFailure();
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "status", "result"]) ||
    value.schemaVersion !== ENRICHMENT_STAGING_COMPANION_SCHEMA ||
    value.status !== "ok"
  ) throw invalidResponse();
  return value.result;
}

async function readBoundedResponse(response: Response): Promise<unknown> {
  if (response.body === null) throw invalidResponse();
  const declared = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw invalidResponse();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > ENRICHMENT_STAGING_COMPANION_MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw invalidResponse();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof Error && error.message === "enrichment_staged_generation_remote_invalid_response") {
      throw error;
    }
    throw invalidResponse();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse();
  }
}

function companionEndpoint(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("enrichment_staged_generation_remote_configuration_invalid");
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]") ||
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) throw new Error("enrichment_staged_generation_remote_configuration_invalid");
  return new URL(ENRICHMENT_STAGING_COMPANION_PATH, url).toString();
}

function validPreparedListingEnrichment(
  value: unknown,
  binding: EnrichmentStageBinding,
): value is PreparedListingEnrichment {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "listingId", "artifactInputHash", "extractionArtifactId", "semanticArtifactId",
      "extraction", "semanticDocument", "semanticHash", "embedding", "embeddingId",
      "textGenerated", "pendingArtifacts",
    ]) ||
    value.listingId !== binding.listingId ||
    !digest(value.artifactInputHash) || !boundedText(value.extractionArtifactId, 512) ||
    !boundedText(value.semanticArtifactId, 512) || !isRecord(value.extraction) ||
    !boundedContent(value.semanticDocument, 500_000) || !digest(value.semanticHash) ||
    value.embedding !== null || value.embeddingId !== null ||
    typeof value.textGenerated !== "boolean" || !Array.isArray(value.pendingArtifacts) ||
    value.pendingArtifacts.length < 1 || value.pendingArtifacts.length > 3
  ) return false;
  return value.pendingArtifacts.every((artifact) =>
    isRecord(artifact) && exactKeys(artifact, [
      "id", "listingId", "task", "providerName", "modelName", "promptVersion",
      "inputHash", "outputText", "outputJson", "outputHash", "generatedAt",
    ]) && artifact.listingId === binding.listingId && boundedText(artifact.id, 512) &&
    (artifact.task === "listing_extraction" || artifact.task === "semantic_document") &&
    boundedText(artifact.providerName, 256) && boundedText(artifact.modelName, 512) &&
    boundedText(artifact.promptVersion, 256) && digest(artifact.inputHash) &&
    (artifact.outputText === null || boundedContent(artifact.outputText, 500_000)) &&
    (artifact.outputJson === null || boundedContent(artifact.outputJson, 500_000)) &&
    (artifact.outputHash === null || digest(artifact.outputHash)) &&
    boundedText(artifact.generatedAt, 64)
  );
}

function validEmbeddingResults(
  value: unknown,
  binding: EnrichmentEmbeddingStageBinding,
): value is readonly StagedEnrichmentEmbeddingResult[] {
  if (!Array.isArray(value) || value.length !== binding.entries.length) return false;
  return value.every((candidate, index) => {
    const entry = binding.entries[index]!;
    if (
      !isRecord(candidate) ||
      !exactOptionalKeys(candidate, ["listingId", "embeddingId", "pendingEmbedding"], ["pendingEmbedding"]) ||
      candidate.listingId !== entry.listingId || !boundedText(candidate.embeddingId, 512)
    ) return false;
    if (candidate.pendingEmbedding === undefined) return true;
    const pending = candidate.pendingEmbedding;
    return isRecord(pending) && exactKeys(pending, [
      "id", "listingId", "providerName", "modelName", "inputHash", "vector", "generatedAt",
    ]) && pending.id === candidate.embeddingId && pending.listingId === entry.listingId &&
      pending.providerName === binding.target.embeddingProviderName &&
      pending.modelName === binding.target.embeddingModelName &&
      pending.inputHash === entry.semanticHash && Array.isArray(pending.vector) &&
      pending.vector.length === binding.target.embeddingDimensions &&
      pending.vector.every((item) => typeof item === "number" && Number.isFinite(item)) &&
      boundedText(pending.generatedAt, 64);
  });
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return exactOptionalKeys(value, expected, []);
}

function exactOptionalKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return allowed.filter((key) => !optional.includes(key)).every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.includes(key));
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function boundedContent(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse(): Error {
  return new Error("enrichment_staged_generation_remote_invalid_response");
}

function remoteFailure(): Error {
  return new Error("enrichment_staged_generation_remote_failed");
}
