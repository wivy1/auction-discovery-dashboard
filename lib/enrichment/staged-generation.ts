import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { hashCanonicalJson } from "../performance/generations";
import type {
  PendingEnrichmentEmbedding,
  PreparedListingEnrichment,
} from "../pipeline/enrich";

export const ENRICHMENT_STAGED_GENERATION_SCHEMA =
  "auction-discovery-enrichment-staged-generation-v1" as const;
const MAX_STAGE_BYTES = 2 * 1024 * 1024;

export interface EnrichmentStageTargetIdentity {
  readonly identity: string;
  readonly textProviderName: string;
  readonly textModelName: string;
  readonly extractionPromptVersion: string;
  readonly semanticDocumentVersion: string;
  readonly embeddingProviderName: string;
  readonly embeddingModelName: string;
  readonly embeddingDimensions: number;
}

export interface EnrichmentStageBinding {
  readonly listingId: string;
  readonly stage: "enrichment_text";
  readonly claimInputHash: string;
  readonly claimRevision: number;
  readonly headIdentity: string;
  readonly headGeneration: number;
  readonly sourceEvidenceHash: string;
  readonly upstreamInputHash: string;
  readonly target: EnrichmentStageTargetIdentity;
  readonly generationVectorHash: string;
}

export interface EnrichmentEmbeddingStageEntryBinding {
  readonly listingId: string;
  readonly claimInputHash: string;
  readonly claimRevision: number;
  readonly headIdentity: string;
  readonly headGeneration: number;
  readonly sourceEvidenceHash: string;
  readonly upstreamInputHash: string;
  readonly semanticHash: string;
  readonly generationVectorHash: string;
}

export interface EnrichmentEmbeddingStageBinding {
  readonly stage: "enrichment_embedding";
  readonly entries: readonly EnrichmentEmbeddingStageEntryBinding[];
  readonly target: EnrichmentStageTargetIdentity;
}

export interface StagedEnrichmentEmbeddingResult {
  readonly listingId: string;
  readonly embeddingId: string;
  readonly pendingEmbedding?: PendingEnrichmentEmbedding;
}

export interface EnrichmentStagedGenerationStore {
  readonly readListingEnrichment: (input: {
    readonly binding: EnrichmentStageBinding;
  }) => Promise<PreparedListingEnrichment | null>;
  readonly writeListingEnrichment: (input: {
    readonly binding: EnrichmentStageBinding;
    readonly prepared: PreparedListingEnrichment;
  }) => Promise<void>;
  readonly readListingEmbeddings: (input: {
    readonly binding: EnrichmentEmbeddingStageBinding;
  }) => Promise<readonly StagedEnrichmentEmbeddingResult[] | null>;
  readonly writeListingEmbeddings: (input: {
    readonly binding: EnrichmentEmbeddingStageBinding;
    readonly results: readonly StagedEnrichmentEmbeddingResult[];
  }) => Promise<void>;
}

interface TextStageManifest {
  readonly schemaVersion: typeof ENRICHMENT_STAGED_GENERATION_SCHEMA;
  readonly binding: EnrichmentStageBinding;
  readonly bindingHash: string;
  readonly payloadHash: string;
  readonly manifestHash: string;
  readonly prepared: PreparedListingEnrichment;
}

interface EmbeddingStageManifest {
  readonly schemaVersion: typeof ENRICHMENT_STAGED_GENERATION_SCHEMA;
  readonly binding: EnrichmentEmbeddingStageBinding;
  readonly bindingHash: string;
  readonly payloadHash: string;
  readonly manifestHash: string;
  readonly results: readonly StagedEnrichmentEmbeddingResult[];
}

export const DEFAULT_ENRICHMENT_STAGING_ROOT = resolve(
  process.cwd(),
  "work",
  "enrichment-staging",
);

export async function writeStagedListingEnrichment(input: {
  readonly root?: string;
  readonly binding: EnrichmentStageBinding;
  readonly prepared: PreparedListingEnrichment;
}): Promise<string> {
  validateTextBinding(input.binding);
  validatePrepared(input.prepared, input.binding);
  rejectSecretBearingData(input.binding);
  rejectSecretBearingData(input.prepared);
  const bindingHash = await runStagedGenerationOperation(
    "text_binding_hash",
    () => hashCanonicalJson(textReuseIdentity(input.binding)),
  );
  const payloadHash = await runStagedGenerationOperation(
    "text_payload_hash",
    () => hashCanonicalJson(input.prepared),
  );
  const manifestCore = Object.freeze({
    schemaVersion: ENRICHMENT_STAGED_GENERATION_SCHEMA,
    binding: input.binding,
    bindingHash,
    payloadHash,
  });
  const manifestHash = await runStagedGenerationOperation(
    "text_manifest_hash",
    () => hashCanonicalJson(manifestCore),
  );
  const manifest: TextStageManifest = Object.freeze({
    ...manifestCore,
    manifestHash,
    prepared: input.prepared,
  });
  assertManifestFits(JSON.stringify(manifest));
  return writeManifest(input.root, bindingHash, manifestHash, manifest);
}

export async function readStagedListingEnrichment(input: {
  readonly root?: string;
  readonly binding: EnrichmentStageBinding;
}): Promise<PreparedListingEnrichment | null> {
  validateTextBinding(input.binding);
  const bindingHash = await hashCanonicalJson(textReuseIdentity(input.binding));
  const loaded = await readManifest(input.root, bindingHash);
  if (loaded === null) return null;
  const { name, manifest } = loaded;
  if (!exactKeys(manifest, [
    "schemaVersion", "binding", "bindingHash", "payloadHash", "manifestHash", "prepared",
  ])) throw tampered();
  const candidate = manifest as unknown as TextStageManifest;
  const manifestCore = {
    schemaVersion: candidate.schemaVersion,
    binding: candidate.binding,
    bindingHash: candidate.bindingHash,
    payloadHash: candidate.payloadHash,
  };
  const expectedManifestHash = await hashCanonicalJson(manifestCore);
  if (
    candidate.schemaVersion !== ENRICHMENT_STAGED_GENERATION_SCHEMA ||
    candidate.bindingHash !== bindingHash ||
    await hashCanonicalJson(textReuseIdentity(candidate.binding)) !== bindingHash ||
    candidate.manifestHash !== expectedManifestHash ||
    name !== `${plainHash(expectedManifestHash)}.json` ||
    await hashCanonicalJson(candidate.prepared) !== candidate.payloadHash
  ) throw tampered();
  validateTextBinding(candidate.binding);
  validatePrepared(candidate.prepared, input.binding);
  rejectSecretBearingData(candidate.binding);
  rejectSecretBearingData(candidate.prepared);
  return Object.freeze(candidate.prepared);
}

export async function writeStagedListingEmbeddings(input: {
  readonly root?: string;
  readonly binding: EnrichmentEmbeddingStageBinding;
  readonly results: readonly StagedEnrichmentEmbeddingResult[];
}): Promise<string> {
  validateEmbeddingBinding(input.binding);
  validateEmbeddingResults(input.results, input.binding);
  rejectSecretBearingData(input.binding);
  rejectSecretBearingData(input.results);
  const bindingHash = await runStagedGenerationOperation(
    "embedding_binding_hash",
    () => hashCanonicalJson(embeddingReuseIdentity(input.binding)),
  );
  const payloadHash = await runStagedGenerationOperation(
    "embedding_payload_hash",
    () => hashCanonicalJson(input.results),
  );
  const manifestCore = Object.freeze({
    schemaVersion: ENRICHMENT_STAGED_GENERATION_SCHEMA,
    binding: input.binding,
    bindingHash,
    payloadHash,
  });
  const manifestHash = await runStagedGenerationOperation(
    "embedding_manifest_hash",
    () => hashCanonicalJson(manifestCore),
  );
  const manifest: EmbeddingStageManifest = Object.freeze({
    ...manifestCore,
    manifestHash,
    results: input.results,
  });
  assertManifestFits(JSON.stringify(manifest));
  return writeManifest(input.root, bindingHash, manifestHash, manifest);
}

export async function readStagedListingEmbeddings(input: {
  readonly root?: string;
  readonly binding: EnrichmentEmbeddingStageBinding;
}): Promise<readonly StagedEnrichmentEmbeddingResult[] | null> {
  validateEmbeddingBinding(input.binding);
  const bindingHash = await hashCanonicalJson(embeddingReuseIdentity(input.binding));
  const loaded = await readManifest(input.root, bindingHash);
  if (loaded === null) return null;
  const { name, manifest } = loaded;
  if (!exactKeys(manifest, [
    "schemaVersion", "binding", "bindingHash", "payloadHash", "manifestHash", "results",
  ])) throw tampered();
  const candidate = manifest as unknown as EmbeddingStageManifest;
  const manifestCore = {
    schemaVersion: candidate.schemaVersion,
    binding: candidate.binding,
    bindingHash: candidate.bindingHash,
    payloadHash: candidate.payloadHash,
  };
  const expectedManifestHash = await hashCanonicalJson(manifestCore);
  if (
    candidate.schemaVersion !== ENRICHMENT_STAGED_GENERATION_SCHEMA ||
    candidate.bindingHash !== bindingHash ||
    await hashCanonicalJson(embeddingReuseIdentity(candidate.binding)) !== bindingHash ||
    candidate.manifestHash !== expectedManifestHash ||
    name !== `${plainHash(expectedManifestHash)}.json` ||
    await hashCanonicalJson(candidate.results) !== candidate.payloadHash
  ) throw tampered();
  validateEmbeddingBinding(candidate.binding);
  validateEmbeddingResults(candidate.results, input.binding);
  rejectSecretBearingData(candidate.binding);
  rejectSecretBearingData(candidate.results);
  return Object.freeze(candidate.results);
}

export function fileEnrichmentStagedGenerationStore(
  root?: string,
): EnrichmentStagedGenerationStore {
  const store: EnrichmentStagedGenerationStore = {
    readListingEnrichment: (input) =>
      readStagedListingEnrichment({ root, binding: input.binding }),
    writeListingEnrichment: async (input) => {
      await writeStagedListingEnrichment({
        root,
        binding: input.binding,
        prepared: input.prepared,
      });
    },
    readListingEmbeddings: (input) =>
      readStagedListingEmbeddings({ root, binding: input.binding }),
    writeListingEmbeddings: async (input) => {
      await writeStagedListingEmbeddings({
        root,
        binding: input.binding,
        results: input.results,
      });
    },
  };
  return Object.freeze(store);
}

async function writeManifest(
  root: string | undefined,
  bindingHash: string,
  manifestHash: string,
  manifest: TextStageManifest | EmbeddingStageManifest,
): Promise<string> {
  const stagingRoot = resolve(root ?? DEFAULT_ENRICHMENT_STAGING_ROOT);
  const bindingName = plainHash(bindingHash);
  const directory = resolve(stagingRoot, bindingName);
  const manifestName = `${plainHash(manifestHash)}.json`;
  const destination = resolve(directory, manifestName);
  const serialized = `${JSON.stringify(manifest)}\n`;
  assertManifestFits(serialized);
  await runStagedGenerationOperation(
    "publish_root",
    () => mkdir(stagingRoot, { recursive: true }),
  );
  try {
    // Reserving the binding directory is the immutable publication boundary.
    // A crash during the exclusive write leaves a conflict that no retry replaces.
    await mkdir(directory);
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw attributeStagedGenerationOperationError(error, "publish_reserve");
    }
    const existing = await runStagedGenerationOperation(
      "publish_inspect",
      () => inspectExistingManifest(directory, manifestName, serialized),
    );
    if (existing === "exact") return destination;
    throw tampered();
  }
  await runStagedGenerationOperation(
    "publish_write",
    () => writeFile(destination, serialized, {
      encoding: "utf8",
      flag: "wx",
    }),
  );
  return destination;
}

async function inspectExistingManifest(
  directory: string,
  manifestName: string,
  serialized: string,
): Promise<"absent" | "exact" | "conflict"> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return "absent";
    throw error;
  }
  if (names.length !== 1 || names[0] !== manifestName) return "conflict";
  try {
    return await readBoundedManifest(resolve(directory, manifestName)) === serialized
      ? "exact"
      : "conflict";
  } catch (error) {
    if (isAttributableOperationError(error)) throw error;
    return "conflict";
  }
}

export function attributeStagedGenerationOperationError(
  error: unknown,
  phase: string,
): unknown {
  if (
    error instanceof Error &&
    error.message.startsWith("enrichment_staged_generation_")
  ) return error;
  const code = errorToken(error, "code");
  const syscall = errorToken(error, "syscall");
  const attributed = new Error(
    `enrichment_staged_generation_failed:phase=${diagnosticToken(phase)}:code=${code}:syscall=${syscall}`,
    { cause: error },
  );
  attributed.name = "EnrichmentStagedGenerationError";
  return attributed;
}

async function runStagedGenerationOperation<T>(
  phase: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw attributeStagedGenerationOperationError(error, phase);
  }
}

function errorToken(error: unknown, key: "code" | "syscall"): string {
  if (!isRecord(error)) return "unknown";
  try {
    return diagnosticToken(error[key]);
  } catch {
    return "unknown";
  }
}

function diagnosticToken(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/u.test(value)
    ? value
    : "unknown";
}

function isAttributableOperationError(error: unknown): boolean {
  if (isRecord(error)) {
    try {
      if (typeof error.code === "string" || typeof error.syscall === "string") return true;
    } catch {
      return true;
    }
  }
  return error instanceof Error && /operation not permitted/iu.test(error.message);
}

async function readManifest(
  root: string | undefined,
  bindingHash: string,
): Promise<{ readonly name: string; readonly manifest: Record<string, unknown> } | null> {
  const directory = resolve(root ?? DEFAULT_ENRICHMENT_STAGING_ROOT, plainHash(bindingHash));
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => /^[0-9a-f]{64}\.json$/u.test(name))
      .sort();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (names.length === 0) return null;
  if (names.length !== 1) throw new Error("enrichment_staged_generation_ambiguous");
  const name = names[0]!;
  const raw = await readBoundedManifest(resolve(directory, name));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw tampered();
  }
  if (!isRecord(parsed)) throw tampered();
  return { name, manifest: parsed };
}

function validateTextBinding(binding: EnrichmentStageBinding): void {
  if (
    !exactKeys(binding, [
      "listingId", "stage", "claimInputHash", "claimRevision",
      "headIdentity", "headGeneration", "sourceEvidenceHash", "target",
      "upstreamInputHash", "generationVectorHash",
    ]) || binding.stage !== "enrichment_text" ||
    !boundedText(binding.listingId, 512) || !exactHash(binding.claimInputHash) ||
    !Number.isSafeInteger(binding.claimRevision) || binding.claimRevision < 1 ||
    !boundedText(binding.headIdentity, 512) ||
    !Number.isSafeInteger(binding.headGeneration) || binding.headGeneration < 1 ||
    !exactHash(binding.sourceEvidenceHash) || !exactHash(binding.upstreamInputHash) ||
    !validTarget(binding.target) ||
    !exactHash(binding.generationVectorHash)
  ) throw new Error("enrichment_staged_generation_binding_invalid");
}

function validateEmbeddingBinding(binding: EnrichmentEmbeddingStageBinding): void {
  if (
    !exactKeys(binding, ["stage", "entries", "target"]) ||
    binding.stage !== "enrichment_embedding" || !Array.isArray(binding.entries) ||
    binding.entries.length < 1 || binding.entries.length > 10 ||
    binding.entries.some((entry) =>
      !exactKeys(entry, [
        "listingId", "claimInputHash", "claimRevision",
        "headIdentity", "headGeneration", "sourceEvidenceHash", "semanticHash",
        "upstreamInputHash", "generationVectorHash",
      ]) || !boundedText(entry.listingId, 512) ||
      !exactHash(entry.claimInputHash) ||
      typeof entry.claimRevision !== "number" ||
      !Number.isSafeInteger(entry.claimRevision) || entry.claimRevision < 1 ||
      !boundedText(entry.headIdentity, 512) ||
      typeof entry.headGeneration !== "number" ||
      !Number.isSafeInteger(entry.headGeneration) || entry.headGeneration < 1 ||
      !exactHash(entry.sourceEvidenceHash) || !exactHash(entry.upstreamInputHash) ||
      !exactDigest(entry.semanticHash) ||
      !exactHash(entry.generationVectorHash)
    ) || !validTarget(binding.target)
  ) throw new Error("enrichment_staged_generation_binding_invalid");
}

function validTarget(target: EnrichmentStageTargetIdentity): boolean {
  return exactKeys(target, [
    "identity", "textProviderName", "textModelName", "extractionPromptVersion",
    "semanticDocumentVersion", "embeddingProviderName", "embeddingModelName",
    "embeddingDimensions",
  ]) && exactHash(target.identity) && boundedText(target.textProviderName, 256) &&
    boundedText(target.textModelName, 512) &&
    boundedText(target.extractionPromptVersion, 256) &&
    boundedText(target.semanticDocumentVersion, 256) &&
    boundedText(target.embeddingProviderName, 256) &&
    boundedText(target.embeddingModelName, 512) &&
    Number.isSafeInteger(target.embeddingDimensions) && target.embeddingDimensions > 0;
}

function validatePrepared(
  prepared: PreparedListingEnrichment,
  binding: EnrichmentStageBinding,
): void {
  if (
    !exactKeys(prepared, [
      "listingId", "artifactInputHash", "extractionArtifactId", "semanticArtifactId",
      "extraction", "semanticDocument", "semanticHash", "embedding", "embeddingId",
      "textGenerated", "pendingArtifacts",
    ], ["pendingArtifacts"]) || prepared.listingId !== binding.listingId ||
    !exactDigest(prepared.artifactInputHash) || !boundedText(prepared.extractionArtifactId, 512) ||
    !boundedText(prepared.semanticArtifactId, 512) || !isRecord(prepared.extraction) ||
    !boundedContent(prepared.semanticDocument, 500_000) || !exactDigest(prepared.semanticHash) ||
    prepared.embedding !== null || prepared.embeddingId !== null ||
    typeof prepared.textGenerated !== "boolean" || !Array.isArray(prepared.pendingArtifacts) ||
    prepared.pendingArtifacts.length < 1 || prepared.pendingArtifacts.length > 3 ||
    prepared.pendingArtifacts.some((artifact) =>
      !exactKeys(artifact, [
        "id", "listingId", "task", "providerName", "modelName", "promptVersion",
        "inputHash", "outputText", "outputJson", "outputHash", "generatedAt",
      ]) || artifact.listingId !== binding.listingId || !boundedText(artifact.id, 512) ||
      !boundedText(artifact.providerName, 256) || !boundedText(artifact.modelName, 512) ||
      !boundedText(artifact.promptVersion, 256) || !exactDigest(artifact.inputHash) ||
      (artifact.outputText !== null && !boundedContent(artifact.outputText, 500_000)) ||
      (artifact.outputJson !== null && !boundedContent(artifact.outputJson, 500_000)) ||
      (artifact.outputHash !== null && !exactDigest(artifact.outputHash)) ||
      !boundedText(artifact.generatedAt, 64) ||
      (artifact.task !== "listing_extraction" && artifact.task !== "semantic_document")
    )
  ) throw new Error("enrichment_staged_generation_payload_invalid");
}

function validateEmbeddingResults(
  results: readonly StagedEnrichmentEmbeddingResult[],
  binding: EnrichmentEmbeddingStageBinding,
): void {
  if (!Array.isArray(results) || results.length !== binding.entries.length) {
    throw new Error("enrichment_staged_generation_payload_invalid");
  }
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]!;
    const expected = binding.entries[index]!;
    if (
      !exactKeys(result, ["listingId", "embeddingId", "pendingEmbedding"], ["pendingEmbedding"]) ||
      result.listingId !== expected.listingId || !boundedText(result.embeddingId, 512)
    ) throw new Error("enrichment_staged_generation_payload_invalid");
    const pending = result.pendingEmbedding;
    if (pending === undefined) continue;
    if (
      !exactKeys(pending, [
        "id", "listingId", "providerName", "modelName", "inputHash", "vector", "generatedAt",
      ]) || pending.id !== result.embeddingId || pending.listingId !== expected.listingId ||
      pending.providerName !== binding.target.embeddingProviderName ||
      pending.modelName !== binding.target.embeddingModelName ||
      pending.inputHash !== expected.semanticHash || !Array.isArray(pending.vector) ||
      pending.vector.length !== binding.target.embeddingDimensions ||
      pending.vector.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
      !boundedText(pending.generatedAt, 64)
    ) throw new Error("enrichment_staged_generation_payload_invalid");
  }
}

function textReuseIdentity(binding: EnrichmentStageBinding): unknown {
  return binding;
}

function embeddingReuseIdentity(binding: EnrichmentEmbeddingStageBinding): unknown {
  return {
    ...binding,
    entries: binding.entries,
  };
}

function exactKeys(
  value: unknown,
  allowed: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const required = allowed.filter((key) => !optional.includes(key));
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.includes(key));
}

function rejectSecretBearingData(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectSecretBearingData(item);
    return;
  }
  if (typeof value === "string" && credentialBearingValue(value)) {
    throw new Error("enrichment_staged_generation_secret_field");
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:api[_-]?key|authorization|capability|cookie|providerRaw|rawResponse|secret|signedUrl|token)$/iu.test(key)) {
      throw new Error("enrichment_staged_generation_secret_field");
    }
    rejectSecretBearingData(child);
  }
}

function credentialBearingValue(value: string): boolean {
  return /(?:^|[?&])(?:x-amz-(?:credential|signature|security-token)|signature|sig|access[_-]?token|auth[_-]?token|capability|signed[_-]?url)=[^&\s]+/iu.test(value) ||
    /^(?:authorization\s*:\s*)?(?:bearer|basic)\s+[A-Za-z0-9+/_=-]{8,}$/iu.test(value) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value);
}

function assertManifestFits(serialized: string): void {
  if (Buffer.byteLength(serialized, "utf8") > MAX_STAGE_BYTES) {
    throw new Error("enrichment_staged_generation_oversized");
  }
}

async function readBoundedManifest(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(MAX_STAGE_BYTES + 1);
    let offset = 0;
    while (offset <= MAX_STAGE_BYTES) {
      const read = await handle.read(
        buffer,
        offset,
        MAX_STAGE_BYTES + 1 - offset,
        offset,
      );
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_STAGE_BYTES) {
      throw new Error("enrichment_staged_generation_oversized");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function tampered(): Error {
  return new Error("enrichment_staged_generation_tampered");
}

function exactHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function exactDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function plainHash(hash: string): string {
  if (!exactHash(hash)) throw new Error("enrichment_staged_generation_hash_invalid");
  return hash.slice("sha256:".length);
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

function isNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
