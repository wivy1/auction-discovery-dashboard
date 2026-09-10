import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseModelManifest, parsePreferenceConfig, parseProfileArtifact, parseTrainingSnapshot,
  type ModelManifest, type PreferenceAdapter,
} from "../lib/preferences/starter.ts";

const TEMPLATE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const COMMANDS = ["init", "check", "train", "profile", "activate"] as const;
const PROGRESS_REFRESH_INTERVAL = 1_000;
const NON_TTY_HEARTBEAT_INTERVAL = 30_000;
type Command = typeof COMMANDS[number];

/** One progress line; model-specific work and timing remain the adapter's responsibility. */
class Progress {
  private started = performance.now();
  private stageStarted = this.started;
  private lastHeartbeat = this.started;
  private label = "starting";
  private stage = 0;
  private timer: ReturnType<typeof setInterval>;
  constructor(private total: number) {
    this.timer = setInterval(() => {
      if (process.stderr.isTTY || performance.now() - this.lastHeartbeat >= NON_TTY_HEARTBEAT_INTERVAL) {
        this.render();
      }
    }, PROGRESS_REFRESH_INTERVAL);
    this.timer.unref();
  }
  next(label: string) {
    this.stage += 1;
    this.label = label;
    this.stageStarted = performance.now();
    this.render();
  }
  private render(final?: string) {
    const elapsed = Math.floor((performance.now() - this.stageStarted) / 1_000);
    const line = `${this.stage}/${this.total}: ${final ?? `${this.label} | ${elapsed}s elapsed`}`;
    this.lastHeartbeat = performance.now();
    if (process.stderr.isTTY) {
      const width = Math.max(10, (process.stderr.columns || 80) - 1);
      process.stderr.write(`\r${line.slice(0, width)}\x1b[K${final ? "\n" : ""}`);
    } else process.stderr.write(`${line}\n`);
  }
  finish(error?: unknown) {
    clearInterval(this.timer);
    this.render(error
      ? "failed"
      : `done in ${Math.floor((performance.now() - this.started) / 1_000)}s`);
  }
}

function localPath(root: string, path: string, directory?: string): string {
  const target = resolve(root, path);
  const base = directory ? resolve(root, directory) : root;
  const relation = relative(base, target);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Path must name a file inside ${directory ?? "the project"}: ${path}`);
  }
  return target;
}

async function readJson(path: string): Promise<{ value: unknown; sha256: string }> {
  const bytes = await readFile(path);
  return { value: JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/u, "")), sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function artifactHash(root: string, model: ModelManifest): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(localPath(root, model.artifactPath, "models.local"))) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== model.artifactSha256) throw new Error("Model artifact SHA-256 does not match the manifest.");
  return actual;
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx");
    try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); } finally { await file.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

async function copyIfMissing(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
}

async function loadAdapter(path: string): Promise<PreferenceAdapter> {
  const adapter = (await import(pathToFileURL(path).href)).default;
  if (!adapter || adapter.schemaVersion !== 1 ||
      ["train", "generateProfile", "activate", "readActiveModel", "score"].some(method => typeof adapter[method] !== "function")) {
    throw new Error("Local adapter must export a schemaVersion 1 PreferenceAdapter with train, generateProfile, activate, readActiveModel, and score hooks.");
  }
  return adapter;
}

export async function runPreferenceCommand(command: Command, projectRoot = TEMPLATE_ROOT): Promise<Record<string, unknown>> {
  const root = resolve(projectRoot);
  await mkdir(resolve(root, "preferences.local"), { recursive: true });
  const lockPath = resolve(root, "preferences.local/workflow.lock");
  const lock = await open(lockPath, "wx").catch(error => {
    if (error.code === "EEXIST") throw new Error("Another preference command owns preferences.local/workflow.lock. After an interrupted command, confirm it has stopped before removing that file.");
    throw error;
  });
  const progress = new Progress(command === "init" ? 2 : command === "check" ? 2 : command === "train" ? 3 : 4);
  let failure: unknown;
  try {
    if (command === "init") {
      progress.next("preparing local configuration");
      await copyIfMissing(resolve(TEMPLATE_ROOT, "preference.config.example.json"), resolve(root, "preference.config.local.json"));
      await copyIfMissing(resolve(TEMPLATE_ROOT, "preference-adapter.example.ts"), resolve(root, "preference-adapter.local.ts"));
      progress.next("preparing empty local data and model placeholders");
      await mkdir(resolve(root, "models.local"), { recursive: true });
      const snapshotPath = resolve(root, "preferences.local/training-data.json");
      const snapshot = await open(snapshotPath, "wx").catch(error => {
        if (error.code === "EEXIST") return null;
        throw error;
      });
      if (snapshot) {
        try { await snapshot.writeFile(`${JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), examples: [], signalCorrections: [] }, null, 2)}\n`); }
        finally { await snapshot.close(); }
      }
      await copyIfMissing(resolve(TEMPLATE_ROOT, "examples/preferences/model-manifest.example.json"), resolve(root, "preferences.local/model-manifest.json"));
      return { status: "initialized", message: "Existing files preserved. Add your own data, model, and hook implementations; see docs/preference-training.md." };
    }

    progress.next("validating configuration and training snapshot");
    const config = parsePreferenceConfig((await readJson(resolve(root, "preference.config.local.json"))).value);
    const snapshotPath = localPath(root, config.trainingDataPath, "preferences.local");
    const manifestPath = localPath(root, config.modelManifestPath, "preferences.local");
    const profilePath = localPath(root, config.profileOutputPath, "preferences.local");
    const adapterPath = localPath(root, config.adapterModule);
    if (new Set([snapshotPath, manifestPath, profilePath, adapterPath, lockPath].map(path => path.toLowerCase())).size !== 5) {
      throw new Error("Adapter, training data, model manifest, profile output, and workflow lock must use distinct paths.");
    }
    const input = await readJson(snapshotPath);
    const snapshot = parseTrainingSnapshot(input.value);
    const adapter = await loadAdapter(adapterPath);
    const assertSnapshotUnchanged = async () => {
      if ((await readJson(snapshotPath)).sha256 !== input.sha256) throw new Error("Training snapshot changed during the command; output was not saved.");
    };

    if (command === "train") {
      if (!snapshot.examples.some(row => row.vote === "interested") || !snapshot.examples.some(row => row.vote === "not_interested")) {
        throw new Error("Training requires your own Interested and Not interested examples. This is a format gate, not evidence that the dataset is sufficient for a useful model.");
      }
      progress.next("running user training hook");
      const model = parseModelManifest(await adapter.train({ snapshot, snapshotSha256: input.sha256, projectRoot: root }));
      progress.next("checking artifact and saving candidate manifest");
      if (model.trainingSnapshotSha256 !== input.sha256) throw new Error("Trained manifest must identify the exact input snapshot SHA-256.");
      await artifactHash(root, model);
      await assertSnapshotUnchanged();
      await saveJson(manifestPath, model);
      return { status: "candidate_saved", modelId: model.modelId, modelVersion: model.modelVersion, activated: false };
    }

    progress.next("validating model manifest and artifact");
    const model = parseModelManifest((await readJson(manifestPath)).value);
    await artifactHash(root, model);
    if (command === "check") {
      return { status: "inputs_valid", examples: snapshot.examples.length, modelId: model.modelId, modelVersion: model.modelVersion,
        message: "File contracts and hook signatures passed. Hook implementation, model quality, feature compatibility, and dashboard integration are not verified." };
    }
    if (command === "profile") {
      if (snapshot.examples.length === 0) throw new Error("Profile generation requires your own reviewed examples.");
      if (model.trainingSnapshotSha256 !== null && model.trainingSnapshotSha256 !== input.sha256) throw new Error("Model and training snapshot differ. Train a matching candidate before generating its profile.");
      progress.next("running user profile hook");
      const profile = parseProfileArtifact(await adapter.generateProfile({ snapshot, snapshotSha256: input.sha256, model, projectRoot: root }), snapshot, model);
      if (profile.trainingSnapshotSha256 !== input.sha256) throw new Error("Profile must identify the exact input snapshot SHA-256.");
      progress.next("checking provenance and saving local profile");
      await artifactHash(root, model);
      await assertSnapshotUnchanged();
      await saveJson(profilePath, profile);
      return { status: "profile_saved", path: config.profileOutputPath, publishedToDashboard: false };
    }

    progress.next("running user activation hook");
    await adapter.activate({ model, projectRoot: root });
    progress.next("checking adapter activation readback");
    const active = await adapter.readActiveModel({ projectRoot: root });
    if (!active || ["modelId", "modelVersion", "featureVersion", "artifactSha256"].some(key =>
      active[key as keyof typeof active] !== model[key as keyof ModelManifest])) {
      throw new Error("Activation hook did not report the requested model identity. The hook may have side effects; inspect your runtime before retrying.");
    }
    await artifactHash(root, model);
    return { status: "adapter_activation_confirmed", active,
      message: "The adapter reported this identity. Verify scores, profile display, restart, and disable behavior in your actual application integration." };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    progress.finish(failure);
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, rootFlag, root, ...rest] = process.argv.slice(2);
  if (!COMMANDS.includes(command as Command) || rest.length > 0 ||
      (rootFlag !== undefined && (rootFlag !== "--root" || !root))) {
    process.stderr.write("Usage: pnpm preference <init|check|train|profile|activate> [--root <project-folder>]\n");
    process.exitCode = 1;
  } else {
    try { process.stdout.write(`${JSON.stringify(await runPreferenceCommand(command as Command, root))}\n`); }
    catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
