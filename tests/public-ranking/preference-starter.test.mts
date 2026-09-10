import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  parseModelManifest, parsePreferenceConfig, parseProfileArtifact, parseTrainingSnapshot,
} from "../../lib/preferences/starter.ts";

const execute = promisify(execFile);
const project = fileURLToPath(new URL("../../", import.meta.url));
const timestamp = "2026-09-10T12:00:00.000Z";
const digest = "a".repeat(64);
const snapshot = {
  schemaVersion: 1, createdAt: timestamp,
  examples: [
    { listingId: "fixture-positive", title: "Synthetic fixture A", description: "", vote: "interested" },
    { listingId: "fixture-negative", title: "Synthetic fixture B", description: "", vote: "not_interested" },
  ],
  signalCorrections: [],
};
const manifest = {
  schemaVersion: 1, modelId: "inert-fixture", modelVersion: "1", featureVersion: "fixture-text-v1",
  artifactPath: "models.local/inert.txt", artifactSha256: digest,
  trainingSnapshotSha256: digest, createdAt: timestamp,
};
const profile = {
  schemaVersion: 1, modelId: manifest.modelId, modelVersion: manifest.modelVersion,
  trainingSnapshotSha256: digest, generatedAt: timestamp, summary: "Synthetic test profile only.",
  positiveSignals: [{ label: "Fixture A", supportingListingIds: ["fixture-positive"] }],
  negativeSignals: [{ label: "Fixture B", supportingListingIds: ["fixture-negative"] }],
};

// This adapter exercises the file protocol. Its inert artifact and readback are
// test doubles; they do not implement training, inference, or dashboard activation.
const fixtureAdapter = `
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
let loaded = null;
async function options(root) { return JSON.parse(await readFile(join(root, "fixture-options.json"), "utf8")); }
export default {
  schemaVersion: 1,
  async score() { throw new Error("Synthetic scoring is not exercised."); },
  async train({ projectRoot, snapshotSha256 }) {
    const flags = await options(projectRoot);
    const bytes = "inert synthetic test artifact\\n";
    await writeFile(join(projectRoot, "models.local/inert.txt"), bytes);
    if (flags.changeSnapshot) await writeFile(join(projectRoot, "preferences.local/training-data.json"), ${JSON.stringify(JSON.stringify(snapshot))} + "\\n");
    return { ...${JSON.stringify(manifest)}, trainingSnapshotSha256: flags.staleHash ? "b".repeat(64) : snapshotSha256,
      artifactSha256: flags.badHash ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex") };
  },
  async generateProfile({ projectRoot, snapshotSha256, model }) {
    const flags = await options(projectRoot);
    const result = { ...${JSON.stringify(profile)}, modelId: model.modelId, modelVersion: model.modelVersion, trainingSnapshotSha256: snapshotSha256 };
    if (flags.wrongProfileModel) result.modelVersion = "different-model";
    if (flags.unknownSupport) result.positiveSignals[0].supportingListingIds = ["unreviewed"];
    return result;
  },
  async activate({ projectRoot, model }) {
    const flags = await options(projectRoot);
    loaded = { modelId: model.modelId, modelVersion: model.modelVersion, featureVersion: flags.wrongFeature ? "incompatible" : model.featureVersion, artifactSha256: model.artifactSha256 };
    if (flags.noReadback) loaded = null;
  },
  async readActiveModel() { return loaded; },
};
`;

async function cli(root: string, command: string) {
  try {
    const result = await execute(process.execPath, [
      "--import", pathToFileURL(join(project, "scripts/node-runtime-preload.mjs")).href, "--import", "tsx",
      join(project, "scripts/preference.mts"), command, "--root", root,
    ], { cwd: project, timeout: 20_000, windowsHide: true });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    if (typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function temporaryProject(t: { after(callback: () => Promise<void>): void }, withAdapter = true) {
  const root = await mkdtemp(join(tmpdir(), "auction-preference-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialized = await cli(root, "init");
  assert.equal(initialized.code, 0, initialized.stderr);
  if (withAdapter) {
    await writeFile(join(root, "preference-adapter.local.ts"), fixtureAdapter);
    await writeFile(join(root, "preferences.local/training-data.json"), JSON.stringify(snapshot));
    await setOptions(root, {});
  }
  return root;
}

async function setOptions(root: string, value: Record<string, boolean>) {
  await writeFile(join(root, "fixture-options.json"), JSON.stringify(value));
}

test("contracts reject unsupported versions, duplicate votes, and malformed artifact hashes", () => {
  assert.deepEqual(parseTrainingSnapshot(snapshot), snapshot);
  assert.throws(() => parseTrainingSnapshot({ ...snapshot, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => parseTrainingSnapshot({ ...snapshot, examples: [snapshot.examples[0], snapshot.examples[0]] }), /duplicates a current vote/);
  assert.throws(() => parseModelManifest({ ...manifest, artifactSha256: "not-a-digest" }), /SHA-256/);
  assert.throws(() => parseModelManifest({ ...manifest, unexpected: true }), /unknown field/);
  assert.throws(() => parsePreferenceConfig({
    schemaVersion: 1, adapterModule: "https://example.invalid/adapter.ts",
    trainingDataPath: "preferences.local/data.json", modelManifestPath: "preferences.local/model.json",
    profileOutputPath: "preferences.local/profile.json",
  }), /local file path/);
});

test("profiles require matching identity and vote evidence, and respect the latest signal correction", () => {
  const data = parseTrainingSnapshot(snapshot);
  const model = parseModelManifest(manifest);
  assert.deepEqual(parseProfileArtifact(profile, data, model), profile);
  assert.throws(() => parseProfileArtifact({ ...profile, modelVersion: "other" }, data, model), /model identity/);
  assert.throws(() => parseProfileArtifact({ ...profile, trainingSnapshotSha256: "b".repeat(64) }, data, model), /training snapshot/);
  for (const supportingListingIds of [[], ["unreviewed"], ["fixture-negative"]]) {
    assert.throws(() => parseProfileArtifact({ ...profile,
      positiveSignals: [{ label: "Fixture A", supportingListingIds }],
    }, data, model), /supporting listing IDs|must reference snapshot listings/);
  }
  const removed = parseTrainingSnapshot({ ...snapshot, signalCorrections: [
    { concept: "  FIXTURE   A ", polarity: "positive", action: "removed" },
  ] });
  assert.throws(() => parseProfileArtifact(profile, removed, model), /removed signal/);
  const restored = parseTrainingSnapshot({ ...removed, signalCorrections: [
    ...removed.signalCorrections, { concept: "fixture a", polarity: "positive", action: "restored" },
  ] });
  assert.deepEqual(parseProfileArtifact(profile, restored, model), profile);
});

test("init seeds empty data, preserves existing files, and default training fails without success artifacts", async (t) => {
  const root = await temporaryProject(t, false);
  const dataPath = join(root, "preferences.local/training-data.json");
  assert.deepEqual(JSON.parse(await readFile(dataPath, "utf8")).examples, []);
  const empty = await cli(root, "train");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /Interested and Not interested examples/);
  const preserved = ["preference.config.local.json", "preference-adapter.local.ts", "preferences.local/model-manifest.json", "preferences.local/training-data.json"];
  for (const path of preserved.slice(0, 3)) {
    const absolute = join(root, path);
    await writeFile(absolute, `${await readFile(absolute, "utf8")}\n\n`);
  }
  await writeFile(dataPath, JSON.stringify(snapshot));
  const before = await Promise.all(preserved.map(path => readFile(join(root, path), "utf8")));
  assert.equal((await cli(root, "init")).code, 0);
  assert.deepEqual(await Promise.all(preserved.map(path => readFile(join(root, path), "utf8"))), before);
  const placeholder = await cli(root, "train");
  assert.equal(placeholder.code, 1);
  assert.match(placeholder.stderr, /training is not implemented/);
  assert.equal(await readFile(join(root, preserved[2]), "utf8"), before[2]);
  assert.deepEqual(await readdir(join(root, "models.local")), []);
  assert.equal((await readdir(join(root, "preferences.local"))).includes("profile.json"), false);
});

test("real CLI saves a candidate and supported profile, then verifies the fixture activation identity", async (t) => {
  const root = await temporaryProject(t);
  const trained = await cli(root, "train");
  assert.equal(trained.code, 0, trained.stderr);
  assert.equal(JSON.parse(trained.stdout).activated, false);
  const saved = JSON.parse(await readFile(join(root, "preferences.local/model-manifest.json"), "utf8"));
  const inputBytes = await readFile(join(root, "preferences.local/training-data.json"));
  assert.equal(saved.trainingSnapshotSha256, createHash("sha256").update(inputBytes).digest("hex"));
  const checked = await cli(root, "check");
  assert.equal(checked.code, 0, checked.stderr);
  const generated = await cli(root, "profile");
  assert.equal(generated.code, 0, generated.stderr);
  assert.equal(JSON.parse(generated.stdout).publishedToDashboard, false);
  const savedProfile = JSON.parse(await readFile(join(root, "preferences.local/profile.json"), "utf8"));
  assert.deepEqual(savedProfile.positiveSignals, profile.positiveSignals);
  const activated = await cli(root, "activate");
  assert.equal(activated.code, 0, activated.stderr);
  assert.deepEqual(JSON.parse(activated.stdout).active, {
    modelId: saved.modelId, modelVersion: saved.modelVersion,
    featureVersion: saved.featureVersion, artifactSha256: saved.artifactSha256,
  });
  assert.equal((await readdir(join(root, "preferences.local"))).includes("workflow.lock"), false);
});

test("CLI rejects corrupt, stale, and ungrounded outputs without replacing saved artifacts", async (t) => {
  const root = await temporaryProject(t);
  const manifestPath = join(root, "preferences.local/model-manifest.json");
  const original = await readFile(manifestPath, "utf8");
  for (const [flags, message] of [
    [{ badHash: true }, /SHA-256 does not match/],
    [{ staleHash: true }, /exact input snapshot SHA-256/],
    [{ changeSnapshot: true }, /snapshot changed during the command/],
  ] as const) {
    await setOptions(root, flags);
    const result = await cli(root, "train");
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    assert.equal(await readFile(manifestPath, "utf8"), original);
  }
  await setOptions(root, {});
  assert.equal((await cli(root, "train")).code, 0);
  for (const [flags, message] of [
    [{ wrongProfileModel: true }, /model identity/],
    [{ unknownSupport: true }, /must reference snapshot listings/],
  ] as const) {
    await setOptions(root, flags);
    const result = await cli(root, "profile");
    assert.equal(result.code, 1);
    assert.match(result.stderr, message);
    assert.equal((await readdir(join(root, "preferences.local"))).includes("profile.json"), false);
  }
  await writeFile(join(root, "preferences.local/training-data.json"), JSON.stringify({ ...snapshot, createdAt: "2026-09-11T12:00:00.000Z" }));
  const stale = await cli(root, "profile");
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /Model and training snapshot differ/);
  await writeFile(join(root, "models.local/inert.txt"), "corrupted test artifact");
  const corrupt = await cli(root, "check");
  assert.equal(corrupt.code, 1);
  assert.match(corrupt.stderr, /SHA-256 does not match/);
});

test("activation requires exact feature identity and nonnull readback; an existing lock is preserved", async (t) => {
  const root = await temporaryProject(t);
  assert.equal((await cli(root, "train")).code, 0);
  const failureOptions: ReadonlyArray<Record<string, boolean>> = [{ wrongFeature: true }, { noReadback: true }];
  for (const flags of failureOptions) {
    await setOptions(root, flags);
    const result = await cli(root, "activate");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /did not report the requested model identity/);
  }
  const lockPath = join(root, "preferences.local/workflow.lock");
  await writeFile(lockPath, "another command");
  const locked = await cli(root, "init");
  assert.equal(locked.code, 1);
  assert.match(locked.stderr, /Another preference command owns/);
  assert.equal(await readFile(lockPath, "utf8"), "another command");
});

test("output paths cannot alias the adapter or execute and overwrite user code", async (t) => {
  for (const outputField of ["modelManifestPath", "profileOutputPath"] as const) {
    const root = await temporaryProject(t);
    const configPath = join(root, "preference.config.local.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.adapterModule = "./preferences.local/user-adapter.ts";
    config[outputField] = config.adapterModule;
    await writeFile(configPath, JSON.stringify(config));
    const adapterPath = join(root, config.adapterModule);
    const adapterBytes = `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(root, "adapter-imported.txt"))}, "import executed");
${fixtureAdapter.replace("const flags = await options(projectRoot);", `
    await writeFile(join(projectRoot, "adapter-hook-ran.txt"), "hook executed");
    const flags = await options(projectRoot);`)}
`;
    await writeFile(adapterPath, adapterBytes);
    const result = await cli(root, "train");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must use distinct paths/);
    assert.equal(await readFile(adapterPath, "utf8"), adapterBytes);
    const files = await readdir(root);
    assert.equal(files.includes("adapter-imported.txt"), false);
    assert.equal(files.includes("adapter-hook-ran.txt"), false);
    assert.deepEqual(await readdir(join(root, "models.local")), []);
  }
});
