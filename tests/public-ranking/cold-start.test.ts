import assert from "node:assert/strict";
import test from "node:test";
import { createAiProviders, readAiConfig } from "../../lib/ai/factory.ts";
import { optionalAiCapabilities } from "../../lib/ai/capabilities.ts";
import { enrichmentSessionProvenanceTarget } from "../../lib/enrichment/target.ts";
import { ACTIVE_PREFERENCE_V2_MODEL_VERSION } from "../../lib/preference-v2/review-runtime.ts";
import { readCurrentPreferenceContractIdentity } from "../../lib/pipeline/projection-contracts.ts";

test("a fresh installation has no trained preference model or implicit AI model", () => {
  assert.equal(ACTIVE_PREFERENCE_V2_MODEL_VERSION, null);
  const config = readAiConfig({});
  assert.equal(config.textModel, "");
  assert.equal(config.embeddingModel, "");
});

test("an empty profile table has a stable contract without writing a profile", async () => {
  let reads = 0;
  const database = {
    prepare(sql: string) {
      assert.match(sql, /SELECT id, algorithm_version FROM profile_versions/);
      return { async first() { reads += 1; return null; } };
    },
  } as unknown as D1Database;
  const first = await readCurrentPreferenceContractIdentity(database);
  assert.equal(first, "preference-unrated-v1");
  assert.equal(await readCurrentPreferenceContractIdentity(database), first);
  assert.equal(reads, 2);
});

test("partial configuration never enables automatic enrichment", () => {
  assert.deepEqual(optionalAiCapabilities({}), { enrichment: false, preferenceScoring: false });
  const configured = {
    AI_TEXT_PROVIDER: "ollama", AI_TEXT_MODEL: "user-text-model",
    AI_EMBEDDING_PROVIDER: "ollama", AI_EMBEDDING_MODEL: "user-embedding-model",
  };
  for (const key of Object.keys(configured)) {
    assert.equal(optionalAiCapabilities({ ...configured, [key]: " " }).enrichment, false);
  }
  assert.deepEqual(optionalAiCapabilities(configured), { enrichment: true, preferenceScoring: false });
});

test("inactive provenance is stable and cannot dispatch inference", async () => {
  const providers = createAiProviders(readAiConfig({}));
  const target = await enrichmentSessionProvenanceTarget(providers);
  assert.equal(target.identity, "enrichment-unconfigured-v1");
  assert.equal(target.embeddingDimensions, 0);
  assert.deepEqual(await enrichmentSessionProvenanceTarget(providers), target);
  assert.equal((await providers.text.healthCheck()).modelAvailable, false);
  await assert.rejects(providers.text.generateText({ prompt: "fixture" }), /not configured/);
  await assert.rejects(providers.embeddings.embed({ inputs: ["fixture"] }), /not configured/);
});

test("malformed stored profile contracts remain errors", async () => {
  const database = { prepare() { return { async first() { return { id: "", algorithm_version: "" }; } }; } } as unknown as D1Database;
  await assert.rejects(readCurrentPreferenceContractIdentity(database), /malformed/);
});
