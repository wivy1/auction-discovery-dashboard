import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { assertCurrentRepairTarget, loadRepairConfig, loadRepairSettings, SOURCE_REPAIR_CONFIG_SCHEMA, validateModelTag, validateRepairTarget } from "../../lib/source-repair/config.ts";

const target = { sourceId: "fixture-json", adapterPath: "source-adapters.local/example/adapter.ts", testFiles: ["source-adapters.local/example/adapter.test.ts"], files: ["source-adapters.local/example/page.json"] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repair-config-"));
  for (const [path, text] of [[target.adapterPath, "export const adapter = {};"], [target.testFiles[0]!, "export {};"], [target.files[0]!, '{"items":[]}']]) {
    await mkdir(dirname(join(root, path!)), { recursive: true }); await writeFile(join(root, path!), text!);
  }
  return root;
}
test("settings default off and never select a cloud provider fallback", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await loadRepairSettings(root, {}), { noAi: true, origin: "http://127.0.0.1:11434", model: undefined });
  assert.equal((await loadRepairSettings(root, { SOURCE_REPAIR_ENABLED: "1", AI_TEXT_PROVIDER: "cloud", AI_TEXT_MODEL: "local-text:small" })).reason, "repair_model_required");
});
test("dotenv selection, explicit environment precedence and local model fallback", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".env.local"), 'SOURCE_REPAIR_ENABLED=1\nAI_TEXT_PROVIDER=ollama\nAI_TEXT_MODEL="local-text:small"\nOLLAMA_BASE_URL=http://localhost:12000\nUNRELATED_SECRET="not-for-output"\n');
  assert.deepEqual(await loadRepairSettings(root, {}), { noAi: false, origin: "http://localhost:12000", model: "local-text:small" });
  const disabled = await loadRepairSettings(root, { SOURCE_REPAIR_ENABLED: "0", SOURCE_REPAIR_MODEL: "another-local:small", SOURCE_REPAIR_OLLAMA_URL: "http://127.0.0.1:13000" });
  assert.deepEqual(disabled, { noAi: true, origin: "http://127.0.0.1:13000", model: "another-local:small" });
  assert.doesNotMatch(JSON.stringify(disabled), /UNRELATED_SECRET|not-for-output/u);
});
test("invalid selected settings fail closed without leaking file data", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [env, reason] of [
    [{ SOURCE_REPAIR_ENABLED: "yes" }, "repair_enabled_value_invalid"],
    [{ SOURCE_REPAIR_ENABLED: "1", SOURCE_REPAIR_MODEL: "local-text:small", SOURCE_REPAIR_OLLAMA_URL: "https://example.com" }, "repair_provider_configuration_invalid"],
    [{ SOURCE_REPAIR_ENABLED: "" }, "repair_enabled_value_invalid"],
    [{ SOURCE_REPAIR_ENABLED: " " }, "repair_enabled_value_invalid"],
    [{ SOURCE_REPAIR_MODEL: "text:cloud" }, "repair_model_must_be_local"],
    [{ SOURCE_REPAIR_MODEL: "x; process" }, "repair_model_tag_invalid"],
  ] as const) { const result = await loadRepairSettings(root, env); assert.equal(result.noAi, true); assert.equal(result.reason, reason); }
  await mkdir(join(root, ".env.local")); assert.equal((await loadRepairSettings(root, {})).reason, "repair_settings_unavailable");
  assert.throws(() => validateModelTag("text:cloud"), /repair_model_must_be_local/u);
});
test("copied env example blank selections use existing Ollama settings", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const example = await readFile(new URL("../../.env.example", import.meta.url), "utf8");
  assert.match(example, /^SOURCE_REPAIR_MODEL=\r?$/mu); assert.match(example, /^SOURCE_REPAIR_OLLAMA_URL=\r?$/mu);
  await writeFile(join(root, ".env.local"), example + '\nSOURCE_REPAIR_ENABLED=1\nAI_TEXT_PROVIDER=ollama\nAI_TEXT_MODEL=local-text:small\nOLLAMA_BASE_URL=http://localhost:12000\n');
  assert.deepEqual(await loadRepairSettings(root, {}), { noAi: false, origin: "http://localhost:12000", model: "local-text:small" });
  assert.deepEqual(await loadRepairSettings(root, { SOURCE_REPAIR_MODEL: " another-local:small ", SOURCE_REPAIR_OLLAMA_URL: " http://127.0.0.1:13000 " }), { noAi: false, origin: "http://127.0.0.1:13000", model: "another-local:small" });
});
test("optional whitespace is absent after process precedence, with strict provider and enable rules", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".env.local"), 'SOURCE_REPAIR_ENABLED=1\nSOURCE_REPAIR_MODEL=file-local:small\nSOURCE_REPAIR_OLLAMA_URL=http://localhost:12000\nAI_TEXT_PROVIDER=ollama\nAI_TEXT_MODEL=" local-text:small "\nOLLAMA_BASE_URL=" http://127.0.0.1:14000 "\n');
  const blanks = { SOURCE_REPAIR_MODEL: " \t ", SOURCE_REPAIR_OLLAMA_URL: " \t " };
  assert.deepEqual(await loadRepairSettings(root, blanks), { noAi: false, origin: "http://127.0.0.1:14000", model: "local-text:small" });
  assert.deepEqual(await loadRepairSettings(root, { ...blanks, OLLAMA_BASE_URL: " \t ", AI_TEXT_MODEL: " \t " }), { noAi: true, origin: "http://127.0.0.1:11434", reason: "repair_model_required" });
  assert.deepEqual(await loadRepairSettings(root, { ...blanks, AI_TEXT_PROVIDER: "cloud" }), { noAi: true, origin: "http://127.0.0.1:14000", reason: "repair_model_required" });
  assert.equal((await loadRepairSettings(root, { ...blanks, SOURCE_REPAIR_ENABLED: "0" })).noAi, true);
});
test("config binds the approved adapter, tests and support file bytes", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "source-repair.config.local.json"), JSON.stringify({ schemaVersion: SOURCE_REPAIR_CONFIG_SCHEMA, targets: [target] }));
  const config = await loadRepairConfig(root); assert.equal(config.available, true);
  if (!config.available) return;
  assert.equal(Object.keys(config.targets[0]!.fileHashes).length, 3); await assertCurrentRepairTarget(root, config.targets[0]!);
  await writeFile(join(root, target.files[0]!), '{"items":[{"title":null}]}');
  await assert.rejects(assertCurrentRepairTarget(root, config.targets[0]!), /repair_target_changed_since_preparation/u);
});
test("target rejects registry, traversal, external paths, secret names and extra fields", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  for (const adapterPath of ["source-adapters.local.ts", "lib/sources/adapter.ts", "source-adapters.local/example/../adapter.ts", "source-adapters.local/credentials/adapter.ts", "C:/adapter.ts"]) {
    await assert.rejects(validateRepairTarget(root, { ...target, adapterPath }), /repair_target_(?:path|extension)_invalid/u);
  }
  await assert.rejects(validateRepairTarget(root, { ...target, command: "node anything" }), /repair_target_contract_invalid/u);
  await assert.rejects(validateRepairTarget(root, { ...target, files: ["source-adapters.local/example/model.mts"] }), /repair_target_extension_invalid/u);
});
test("missing export, credential literal and duplicate target are rejected", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, target.adapterPath), "export default {};");
  await assert.rejects(validateRepairTarget(root, target), /repair_target_adapter_export_missing/u);
  await writeFile(join(root, target.adapterPath), 'export const adapter = {}; const password="fixture-secret";');
  await assert.rejects(validateRepairTarget(root, target), /repair_target_possible_secret/u);
  await writeFile(join(root, target.adapterPath), "export const adapter = {};");
  await writeFile(join(root, "source-repair.config.local.json"), JSON.stringify({ schemaVersion: SOURCE_REPAIR_CONFIG_SCHEMA, targets: [target, target] }));
  assert.deepEqual(await loadRepairConfig(root), { available: false, reason: "repair_config_duplicate_target" });
});
test("target support symlink cannot admit an outside file", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "page.json"), "{}");
  await symlink(outside, join(root, "source-adapters.local", "example", "linked"), "junction");
  await assert.rejects(validateRepairTarget(root, { ...target, files: ["source-adapters.local/example/linked/page.json"] }), /symlink_not_allowed/u);
});
test("dotenv must be a bounded regular file and common token assignments are rejected", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, ".env.local"), "X=" + "a".repeat(65_536));
  assert.deepEqual(await loadRepairSettings(root, {}), { noAi: true, origin: "http://127.0.0.1:11434", reason: "repair_settings_unavailable" });
  for (const key of ["API_TOKEN", "ACCESS_TOKEN", "api_token", "accessToken"]) for (const path of [target.adapterPath, target.testFiles[0]!, target.files[0]!]) {
    const previous = path === target.adapterPath ? "export const adapter = {};" : path.endsWith(".json") ? "{}" : "export {};";
    await writeFile(join(root, path), path.endsWith(".json") ? JSON.stringify({ [key]: "fixture-value" }) : `${previous}\nconst ${key}="fixture-value";`);
    await assert.rejects(validateRepairTarget(root, target), /repair_target_possible_secret/u);
    await writeFile(join(root, path), previous);
  }
});
test("ordinary planned checkpoint keys are admitted without weakening explicit credentials", async (t) => {
  const root = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [target.adapterPath, target.testFiles[0]!, target.files[0]!]) {
    const previous = path === target.adapterPath ? "export const adapter = {};" : path.endsWith(".json") ? "{}" : "export {};";
    await writeFile(join(root, path), path.endsWith(".json") ? '{"plannedPage":{"key":"inventory"}}' : `${previous}\nconst plannedPage = { key: "inventory" };`);
    await validateRepairTarget(root, target);
    await writeFile(join(root, path), previous);
  }
  for (const key of ["apiKey", "api_key", "API_KEY", "API_TOKEN", "accessToken"]) {
    await writeFile(join(root, target.files[0]!), JSON.stringify({ [key]: "fixture-value" }));
    await assert.rejects(validateRepairTarget(root, target), /repair_target_possible_secret/u);
  }
});
