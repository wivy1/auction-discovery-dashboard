import { extname, isAbsolute, relative, resolve, sep } from "node:path";

type RuntimeFileSystem = typeof import("node:fs/promises");

export const RUNTIME_REVISION_SCHEMA_VERSION =
  "auction-discovery-runtime-revision-v1" as const;
export const RUNTIME_REVISION_ENVIRONMENT_VARIABLE =
  "AUCTION_DISCOVERY_RUNTIME_REVISION" as const;
export const SUPERVISOR_INSTANCE_ID_ENVIRONMENT_VARIABLE =
  "AUCTION_DISCOVERY_SUPERVISOR_INSTANCE_ID" as const;
export const RUNTIME_REVISION_HEADER =
  "x-auction-discovery-runtime-revision" as const;
export const RUNTIME_REVISION_MISMATCH_MESSAGE =
  "Loaded local runtime does not match the current checkout; discovery was not started. Restart the supervised local stack." as const;

const RUNTIME_REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SUPERVISOR_INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const INCLUDED_DIRECTORIES = Object.freeze([
  "app",
  "db",
  "lib",
  "worker",
  "build",
] as const);
const INCLUDED_ROOT_FILES = Object.freeze([
  "source-adapters.local.ts",
  "source-adapters.example.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "vite.config.ts",
  "next.config.ts",
  "postcss.config.mjs",
  "eslint.config.mjs",
  "drizzle.config.ts",
  "cloudflare-env.d.ts",
] as const);
const INCLUDED_NESTED_CONFIG_FILES: readonly string[] = Object.freeze([]);
const EXECUTABLE_SCRIPT_EXTENSIONS = new Set([
  ".cjs",
  ".cmd",
  ".cts",
  ".js",
  ".mjs",
  ".mts",
  ".ps1",
  ".py",
  ".sh",
  ".ts",
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".wrangler",
  "data",
  "docs",
  "logs",
  "node_modules",
  "output",
  "outputs",
  "runtime",
  "tests",
]);
// Stable lock-owning launchers must survive revision-driven child replacement.
const EXCLUDED_STABLE_BOOTSTRAP_FILES = new Set([
  "scripts/dev-host.ps1",
  "scripts/dev.cmd",
]);

export interface RuntimeRevisionPayload {
  readonly schemaVersion: typeof RUNTIME_REVISION_SCHEMA_VERSION;
  readonly revision: string;
}

export class RuntimeRevisionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeRevisionError";
  }
}

export function isRuntimeRevision(value: unknown): value is string {
  return typeof value === "string" && RUNTIME_REVISION_PATTERN.test(value);
}

export function requireRuntimeRevision(value: unknown, source: string): string {
  if (!isRuntimeRevision(value)) {
    throw new RuntimeRevisionError(`${source} did not provide a valid runtime revision`);
  }
  return value;
}

export function isSupervisorInstanceId(value: unknown): value is string {
  return typeof value === "string" && SUPERVISOR_INSTANCE_ID_PATTERN.test(value);
}

export function requireSupervisorInstanceId(value: unknown, source: string): string {
  if (!isSupervisorInstanceId(value)) {
    throw new RuntimeRevisionError(
      `${source} did not provide a valid supervisor instance identity`,
    );
  }
  return value;
}

export function runtimeRevisionPayload(revision: string): RuntimeRevisionPayload {
  return {
    schemaVersion: RUNTIME_REVISION_SCHEMA_VERSION,
    revision: requireRuntimeRevision(revision, "Runtime"),
  };
}

export function loadedRuntimeRevision(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return requireRuntimeRevision(
    environment[RUNTIME_REVISION_ENVIRONMENT_VARIABLE]?.trim(),
    RUNTIME_REVISION_ENVIRONMENT_VARIABLE,
  );
}

export function loadedSupervisorInstanceId(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return requireSupervisorInstanceId(
    environment[SUPERVISOR_INSTANCE_ID_ENVIRONMENT_VARIABLE]?.trim(),
    SUPERVISOR_INSTANCE_ID_ENVIRONMENT_VARIABLE,
  );
}

export async function computeRuntimeRevision(projectRoot: string): Promise<string> {
  const [fileSystem, { createHash }] = await Promise.all([
    import("node:fs/promises"),
    import("node:crypto"),
  ]);
  const root = resolve(projectRoot);
  let rootRealPath: string;
  try {
    const rootInfo = await fileSystem.lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new RuntimeRevisionError("Runtime revision root must be a real directory");
    }
    rootRealPath = await fileSystem.realpath(root);
  } catch (error) {
    if (error instanceof RuntimeRevisionError) throw error;
    throw new RuntimeRevisionError("Runtime revision root is unreadable", { cause: error });
  }

  const inputs = new Map<string, string>();
  for (const directory of INCLUDED_DIRECTORIES) {
    await collectTree(
      fileSystem,
      resolve(rootRealPath, directory),
      rootRealPath,
      inputs,
      false,
      new Set(),
    );
  }
  await collectTree(
    fileSystem,
    resolve(rootRealPath, "scripts"),
    rootRealPath,
    inputs,
    true,
    new Set(),
  );
  for (const path of [...INCLUDED_ROOT_FILES, ...INCLUDED_NESTED_CONFIG_FILES]) {
    await collectFileIfPresent(fileSystem, resolve(rootRealPath, path), rootRealPath, inputs);
  }
  if (inputs.size === 0) {
    throw new RuntimeRevisionError("Runtime revision input set is empty");
  }

  const hash = createHash("sha256");
  hash.update(`${RUNTIME_REVISION_SCHEMA_VERSION}\0`, "utf8");
  for (const [repoRelativePath, physicalPath] of [...inputs.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    let contents: Buffer;
    try {
      contents = await fileSystem.readFile(physicalPath);
    } catch (error) {
      throw new RuntimeRevisionError(
        `Runtime revision input is unreadable: ${repoRelativePath}`,
        { cause: error },
      );
    }
    hash.update(`${Buffer.byteLength(repoRelativePath, "utf8")}:`, "utf8");
    hash.update(repoRelativePath, "utf8");
    hash.update(`:${contents.byteLength}:`, "utf8");
    hash.update(contents);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function collectTree(
  fileSystem: RuntimeFileSystem,
  candidate: string,
  rootRealPath: string,
  inputs: Map<string, string>,
  scriptsOnly: boolean,
  ancestors: Set<string>,
): Promise<void> {
  let info;
  try {
    info = await fileSystem.lstat(candidate);
  } catch (error) {
    if (isMissing(error)) return;
    throw new RuntimeRevisionError(
      `Runtime revision path is unreadable: ${normalizedRelative(rootRealPath, candidate)}`,
      { cause: error },
    );
  }

  const logicalRelative = normalizedRelative(rootRealPath, candidate);
  if (excludedPath(logicalRelative)) return;
  let physicalPath = candidate;
  if (info.isSymbolicLink()) {
    try {
      physicalPath = await fileSystem.realpath(candidate);
    } catch (error) {
      throw new RuntimeRevisionError(`Runtime revision symlink is unreadable: ${logicalRelative}`, {
        cause: error,
      });
    }
    assertWithinRoot(rootRealPath, physicalPath, `Runtime revision symlink escapes root: ${logicalRelative}`);
    try {
      info = await fileSystem.stat(physicalPath);
    } catch (error) {
      throw new RuntimeRevisionError(`Runtime revision symlink target is unreadable: ${logicalRelative}`, {
        cause: error,
      });
    }
  } else {
    assertWithinRoot(rootRealPath, physicalPath, `Runtime revision input escapes root: ${logicalRelative}`);
  }

  if (info.isFile()) {
    if (!scriptsOnly || EXECUTABLE_SCRIPT_EXTENSIONS.has(extname(logicalRelative).toLowerCase())) {
      addInput(inputs, logicalRelative, physicalPath);
    }
    return;
  }
  if (!info.isDirectory()) return;

  const physicalDirectory = await fileSystem.realpath(physicalPath);
  assertWithinRoot(
    rootRealPath,
    physicalDirectory,
    `Runtime revision directory escapes root: ${logicalRelative}`,
  );
  if (ancestors.has(physicalDirectory.toLowerCase())) {
    throw new RuntimeRevisionError(`Runtime revision symlink cycle: ${logicalRelative}`);
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(physicalDirectory.toLowerCase());
  let entries;
  try {
    entries = await fileSystem.readdir(physicalDirectory, { withFileTypes: true });
  } catch (error) {
    throw new RuntimeRevisionError(`Runtime revision directory is unreadable: ${logicalRelative}`, {
      cause: error,
    });
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    await collectTree(
      fileSystem,
      resolve(candidate, entry.name),
      rootRealPath,
      inputs,
      scriptsOnly,
      nextAncestors,
    );
  }
}

async function collectFileIfPresent(
  fileSystem: RuntimeFileSystem,
  candidate: string,
  rootRealPath: string,
  inputs: Map<string, string>,
): Promise<void> {
  let info;
  try {
    info = await fileSystem.lstat(candidate);
  } catch (error) {
    if (isMissing(error)) return;
    throw new RuntimeRevisionError(
      `Runtime revision config is unreadable: ${normalizedRelative(rootRealPath, candidate)}`,
      { cause: error },
    );
  }
  const logicalRelative = normalizedRelative(rootRealPath, candidate);
  let physicalPath = candidate;
  if (info.isSymbolicLink()) {
    physicalPath = await fileSystem.realpath(candidate);
    assertWithinRoot(rootRealPath, physicalPath, `Runtime revision symlink escapes root: ${logicalRelative}`);
    info = await fileSystem.stat(physicalPath);
  }
  if (!info.isFile()) {
    throw new RuntimeRevisionError(`Runtime revision config is not a file: ${logicalRelative}`);
  }
  addInput(inputs, logicalRelative, physicalPath);
}

function normalizedRelative(rootRealPath: string, candidate: string): string {
  const value = relative(rootRealPath, candidate).split(sep).join("/").normalize("NFC");
  if (!value || value === "." || value.startsWith("../") || value === "..") {
    throw new RuntimeRevisionError("Runtime revision input is outside the project root");
  }
  return value;
}

function excludedPath(repoRelativePath: string): boolean {
  if (EXCLUDED_STABLE_BOOTSTRAP_FILES.has(repoRelativePath.toLowerCase())) return true;
  const segments = repoRelativePath.split("/");
  return segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase())) ||
    segments.at(-1)?.toLowerCase().startsWith(".env") === true;
}

function assertWithinRoot(rootRealPath: string, candidate: string, message: string): void {
  const relation = relative(rootRealPath, resolve(candidate));
  if (
    relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`))
  ) {
    return;
  }
  throw new RuntimeRevisionError(message);
}

function addInput(inputs: Map<string, string>, logicalRelative: string, physicalPath: string): void {
  if (inputs.has(logicalRelative)) {
    throw new RuntimeRevisionError(`Duplicate runtime revision input: ${logicalRelative}`);
  }
  inputs.set(logicalRelative, physicalPath);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { readonly code?: unknown }).code === "ENOENT";
}
