/** File contracts for the optional user-supplied preference starter. No inference or storage. */
export interface PreferenceConfig {
  readonly schemaVersion: 1;
  readonly adapterModule: string;
  readonly trainingDataPath: string;
  readonly modelManifestPath: string;
  readonly profileOutputPath: string;
}

export interface TrainingExample {
  readonly listingId: string;
  readonly title: string;
  readonly description: string;
  readonly vote: "interested" | "not_interested";
}

export interface SignalCorrection {
  readonly concept: string;
  readonly polarity: "positive" | "negative";
  readonly action: "removed" | "restored";
}

export interface TrainingSnapshot {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  /** One current vote per listing, including historical listings the user reviewed. */
  readonly examples: readonly TrainingExample[];
  /** Chronological order; the last correction for a concept and polarity wins. */
  readonly signalCorrections: readonly SignalCorrection[];
}

export interface ModelManifest {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly featureVersion: string;
  /** Local artifact path, resolved by the workflow relative to its project root. */
  readonly artifactPath: string;
  readonly artifactSha256: string;
  /** Null for a downloaded model without a known local training snapshot. */
  readonly trainingSnapshotSha256: string | null;
  readonly createdAt: string;
}

export interface ProfileSignal {
  readonly label: string;
  readonly supportingListingIds: readonly string[];
}

export interface ProfileArtifact {
  readonly schemaVersion: 1;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly trainingSnapshotSha256: string;
  readonly generatedAt: string;
  readonly summary: string;
  readonly positiveSignals: readonly ProfileSignal[];
  readonly negativeSignals: readonly ProfileSignal[];
}

export interface ActivePreferenceModel {
  readonly modelId: string;
  readonly modelVersion: string;
  readonly featureVersion: string;
  readonly artifactSha256: string;
}

export interface PreferenceListing {
  readonly listingId: string;
  readonly title: string;
  readonly description: string;
}

export interface PreferenceScore {
  readonly listingId: string;
  /** Finite 0–100 preference score; missing or failed results must remain Unrated. */
  readonly score: number;
  readonly explanation: string;
}

export interface PreferenceAdapter {
  readonly schemaVersion: 1;
  train(context: {
    readonly snapshot: TrainingSnapshot;
    readonly snapshotSha256: string;
    readonly projectRoot: string;
  }): Promise<ModelManifest>;
  generateProfile(context: {
    readonly snapshot: TrainingSnapshot;
    readonly snapshotSha256: string;
    readonly model: ModelManifest;
    readonly projectRoot: string;
  }): Promise<ProfileArtifact>;
  /** Must connect a real compatible scorer before reporting successful activation. */
  activate(context: {
    readonly model: ModelManifest;
    readonly projectRoot: string;
  }): Promise<void>;
  /** Return what the runtime actually loaded, not a requested manifest selection. */
  readActiveModel(context: {
    readonly projectRoot: string;
  }): Promise<ActivePreferenceModel | null>;
  /** Extension hook for a future runtime bridge; the starter CLI never dispatches scoring. */
  score(context: {
    readonly model: ModelManifest;
    readonly listings: readonly PreferenceListing[];
    readonly projectRoot: string;
  }): Promise<readonly PreferenceScore[]>;
}

export function parsePreferenceConfig(value: unknown): PreferenceConfig {
  const row = record(value, "preference config", [
    "schemaVersion", "adapterModule", "trainingDataPath", "modelManifestPath", "profileOutputPath",
  ]);
  schemaVersion(row, "preference config");
  return {
    schemaVersion: 1,
    adapterModule: localPath(row.adapterModule, "adapterModule"),
    trainingDataPath: localPath(row.trainingDataPath, "trainingDataPath"),
    modelManifestPath: localPath(row.modelManifestPath, "modelManifestPath"),
    profileOutputPath: localPath(row.profileOutputPath, "profileOutputPath"),
  };
}

export function parseTrainingSnapshot(value: unknown): TrainingSnapshot {
  const row = record(value, "training snapshot", [
    "schemaVersion", "createdAt", "examples", "signalCorrections",
  ]);
  schemaVersion(row, "training snapshot");
  const listingIds = new Set<string>();
  const examples = array(row.examples, "examples").map((value, index): TrainingExample => {
    const name = `examples[${index}]`;
    const example = record(value, name, ["listingId", "title", "description", "vote"]);
    const listingId = identity(example.listingId, `${name}.listingId`);
    if (listingIds.has(listingId)) fail(`${name}.listingId duplicates a current vote`);
    listingIds.add(listingId);
    return {
      listingId,
      title: text(example.title, `${name}.title`),
      description: text(example.description, `${name}.description`, true),
      vote: choice(example.vote, ["interested", "not_interested"], `${name}.vote`),
    };
  });
  const signalCorrections = array(row.signalCorrections, "signalCorrections")
    .map((value, index): SignalCorrection => {
      const name = `signalCorrections[${index}]`;
      const correction = record(value, name, ["concept", "polarity", "action"]);
      return {
        concept: text(correction.concept, `${name}.concept`),
        polarity: choice(correction.polarity, ["positive", "negative"], `${name}.polarity`),
        action: choice(correction.action, ["removed", "restored"], `${name}.action`),
      };
    });
  return {
    schemaVersion: 1,
    createdAt: timestamp(row.createdAt, "createdAt"),
    examples,
    signalCorrections,
  };
}

export function parseModelManifest(value: unknown): ModelManifest {
  const row = record(value, "model manifest", [
    "schemaVersion", "modelId", "modelVersion", "featureVersion", "artifactPath",
    "artifactSha256", "trainingSnapshotSha256", "createdAt",
  ]);
  schemaVersion(row, "model manifest");
  return {
    schemaVersion: 1,
    modelId: identity(row.modelId, "modelId"),
    modelVersion: identity(row.modelVersion, "modelVersion"),
    featureVersion: identity(row.featureVersion, "featureVersion"),
    artifactPath: localPath(row.artifactPath, "artifactPath"),
    artifactSha256: sha256(row.artifactSha256, "artifactSha256"),
    trainingSnapshotSha256: row.trainingSnapshotSha256 === null
      ? null : sha256(row.trainingSnapshotSha256, "trainingSnapshotSha256"),
    createdAt: timestamp(row.createdAt, "createdAt"),
  };
}

/** The file workflow must also compare trainingSnapshotSha256 with the actual snapshot bytes. */
export function parseProfileArtifact(
  value: unknown,
  snapshot: TrainingSnapshot,
  manifest: ModelManifest,
): ProfileArtifact {
  const row = record(value, "profile artifact", [
    "schemaVersion", "modelId", "modelVersion", "trainingSnapshotSha256", "generatedAt",
    "summary", "positiveSignals", "negativeSignals",
  ]);
  schemaVersion(row, "profile artifact");
  const modelId = identity(row.modelId, "modelId");
  const modelVersion = identity(row.modelVersion, "modelVersion");
  if (modelId !== manifest.modelId || modelVersion !== manifest.modelVersion) {
    fail("profile artifact model identity does not match the model manifest");
  }
  const trainingSnapshotSha256 = sha256(row.trainingSnapshotSha256, "trainingSnapshotSha256");
  if (manifest.trainingSnapshotSha256 !== null &&
    manifest.trainingSnapshotSha256 !== trainingSnapshotSha256) {
    fail("profile artifact training snapshot does not match the model manifest");
  }
  const votes = new Map(snapshot.examples.map((example) => [example.listingId, example.vote]));
  const removed = new Map<string, boolean>();
  for (const correction of snapshot.signalCorrections) {
    removed.set(`${correction.polarity}:${normalizeConcept(correction.concept)}`,
      correction.action === "removed");
  }
  const signals = (value: unknown, polarity: SignalCorrection["polarity"]): ProfileSignal[] => {
    const name = `${polarity}Signals`;
    const labels = new Set<string>();
    return array(value, name).map((value, index) => {
      const signalName = `${name}[${index}]`;
      const signal = record(value, signalName, ["label", "supportingListingIds"]);
      const label = text(signal.label, `${signalName}.label`);
      const concept = normalizeConcept(label);
      if (labels.has(concept)) fail(`${signalName}.label duplicates a signal`);
      if (removed.get(`${polarity}:${concept}`)) fail(`${signalName}.label is a removed signal`);
      labels.add(concept);
      const supportingListingIds = array(signal.supportingListingIds, `${signalName}.supportingListingIds`)
        .map((id) => identity(id, `${signalName}.supportingListingIds entry`));
      if (supportingListingIds.length === 0) fail(`${signalName} requires supporting listing IDs`);
      if (new Set(supportingListingIds).size !== supportingListingIds.length) {
        fail(`${signalName} repeats a supporting listing ID`);
      }
      const vote = polarity === "positive" ? "interested" : "not_interested";
      if (supportingListingIds.some((id) => votes.get(id) !== vote)) {
        fail(`${signalName} must reference snapshot listings with ${vote} votes`);
      }
      return { label, supportingListingIds };
    });
  };
  return {
    schemaVersion: 1,
    modelId,
    modelVersion,
    trainingSnapshotSha256,
    generatedAt: timestamp(row.generatedAt, "generatedAt"),
    summary: text(row.summary, "summary"),
    positiveSignals: signals(row.positiveSignals, "positive"),
    negativeSignals: signals(row.negativeSignals, "negative"),
  };
}

function fail(message: string): never {
  throw new TypeError(`Preference starter: ${message}`);
}

function record(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => !keys.includes(key))) fail(`${name} has an unknown field`);
  if (keys.some((key) => !Object.prototype.hasOwnProperty.call(row, key))) fail(`${name} has a missing field`);
  return row;
}

function schemaVersion(row: Record<string, unknown>, name: string): void {
  if (row.schemaVersion !== 1) fail(`${name}.schemaVersion must be 1`);
}

function text(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.includes("\0")) {
    fail(`${name} must be ${allowEmpty ? "a" : "a nonempty"} string without NUL characters`);
  }
  return value;
}

function identity(value: unknown, name: string): string {
  const result = text(value, name);
  if (result !== result.trim() || /[\u0000-\u001f\u007f]/u.test(result)) {
    fail(`${name} must be trimmed and contain no control characters`);
  }
  return result;
}

function localPath(value: unknown, name: string): string {
  const result = identity(value, name);
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(result)) fail(`${name} must be a local file path`);
  return result;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  return value;
}

function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    fail(`${name} must be one of ${choices.join(", ")}`);
  }
  return value as T;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail(`${name} must be a lowercase SHA-256 digest of 64 hex characters`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value) ||
    !Number.isFinite(Date.parse(value))) {
    fail(`${name} must be an ISO timestamp with an explicit timezone`);
  }
  const date = value.slice(0, 10);
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    fail(`${name} must contain a valid calendar date`);
  }
  return value;
}

function normalizeConcept(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}
